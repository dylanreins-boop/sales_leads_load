#!/usr/bin/env node
// Copies the database and photos off the server, into an S3-compatible bucket (an AWS Lightsail
// bucket, AWS S3, Backblaze B2, Cloudflare R2...). Runs nightly from cron after the local backup.
// Nothing to install: it signs its own requests (AWS Signature Version 4) with Node's built-ins.
//
//   BACKUP_S3_BUCKET=my-bucket BACKUP_S3_REGION=us-west-2 BACKUP_S3_KEY_ID=... BACKUP_S3_SECRET=... \
//     node scripts/backup-offsite.js
//
// Optional: BACKUP_S3_ENDPOINT (for non-AWS services, e.g. https://s3.us-west-004.backblazeb2.com),
// BACKUP_KEEP_DAYS (30), BACKUP_DIR (where the status file and photo list are kept), DB_PATH, PHOTOS_DIR.
// Each run writes BACKUP_STATUS_FILE (default BACKUP_DIR/offsite-status.json), which admins see in the app.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodePath = (p) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// Signs an S3 request (AWS Signature Version 4). Returns the headers to send.
function signS3({ method, url, region, keyId, secret, body = Buffer.alloc(0), headers = {}, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, encodePath(decodeURIComponent(u.pathname)), query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

function createBucket({ bucket, region, keyId, secret, endpoint }, fetchImpl = (...a) => fetch(...a)) {
  // AWS: https://bucket.s3.region.amazonaws.com/key; other services: https://endpoint/bucket/key.
  const objectUrl = (key = '') => (endpoint
    ? `${endpoint.replace(/\/+$/, '')}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`);
  async function request(method, url, body, headers = {}) {
    const res = await fetchImpl(url, { method, body: body?.length ? body : undefined, headers: signS3({ method, url, region, keyId, secret, body, headers }) });
    if (!res.ok) throw new Error(`${method} ${new URL(url).pathname} failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res;
  }
  return {
    put: (key, body, type = 'application/octet-stream') => request('PUT', objectUrl(encodePath(key)), body, { 'content-type': type }),
    del: (key) => request('DELETE', objectUrl(encodePath(key))),
    async list(prefix) {
      const keys = [];
      let token = null;
      do {
        const url = new URL(objectUrl());
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        if (token) url.searchParams.set('continuation-token', token);
        const xml = await (await request('GET', url.toString())).text();
        keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&')));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)</)?.[1] : null;
      } while (token);
      return keys;
    },
  };
}

// One backup run: a fresh copy of the database, any photos not uploaded yet, and old copies pruned.
async function runBackup({ env = process.env, fetchImpl, now = new Date() } = {}) {
  const dbPath = env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db');
  const photosDir = env.PHOTOS_DIR || path.join(path.dirname(dbPath), 'photos');
  const stateDir = env.BACKUP_DIR || path.dirname(dbPath);
  const keepDays = Number(env.BACKUP_KEEP_DAYS || 30);
  const bucket = createBucket({
    bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION || 'us-east-1', endpoint: env.BACKUP_S3_ENDPOINT,
    keyId: env.BACKUP_S3_KEY_ID, secret: env.BACKUP_S3_SECRET,
  }, fetchImpl);
  if (!env.BACKUP_S3_BUCKET || !env.BACKUP_S3_KEY_ID || !env.BACKUP_S3_SECRET) throw new Error('Set BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET.');

  // A consistent copy even while the app is writing (VACUUM INTO), then gzip.
  const { DatabaseSync } = require('node:sqlite');
  const stamp = now.toISOString().slice(0, 10);
  const copy = path.join(stateDir, `offsite-${process.pid}.db`);
  fs.rmSync(copy, { force: true });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  db.close();
  const gz = zlib.gzipSync(fs.readFileSync(copy));
  fs.rmSync(copy, { force: true });
  const dbKey = `db/leads-${stamp}.db.gz`;
  await bucket.put(dbKey, gz, 'application/gzip');

  // Photos never change once taken, so each is uploaded once (a list of uploaded files is kept).
  const listFile = path.join(stateDir, 'offsite-photos.json');
  let uploaded = new Set();
  try { uploaded = new Set(JSON.parse(fs.readFileSync(listFile, 'utf8'))); } catch { /* first run */ }
  let photos = 0;
  const files = fs.existsSync(photosDir) ? fs.readdirSync(photosDir).filter((f) => !f.startsWith('.')) : [];
  for (const file of files) {
    if (uploaded.has(file)) continue;
    await bucket.put(`photos/${file}`, fs.readFileSync(path.join(photosDir, file)), file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    uploaded.add(file);
    photos++;
    fs.writeFileSync(listFile, JSON.stringify([...uploaded]));
  }

  // Database copies older than BACKUP_KEEP_DAYS are deleted (photos are kept).
  const cutoff = new Date(now.getTime() - keepDays * 86400000).toISOString().slice(0, 10);
  let pruned = 0;
  for (const key of await bucket.list('db/')) {
    const day = key.match(/leads-(\d{4}-\d{2}-\d{2})\.db\.gz$/)?.[1];
    if (day && day < cutoff) { await bucket.del(key); pruned++; }
  }
  return { ok: true, at: now.toISOString(), db_key: dbKey, db_bytes: gz.length, photos_uploaded: photos, photos_total: uploaded.size, pruned };
}

if (require.main === module) {
  const stateDir = process.env.BACKUP_DIR || path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db'));
  const statusFile = process.env.BACKUP_STATUS_FILE || path.join(stateDir, 'offsite-status.json');
  const status = (result) => fs.writeFileSync(statusFile, JSON.stringify(result, null, 2));
  runBackup().then((result) => {
    status(result);
    console.log(`Off-server backup done: ${result.db_key} (${Math.round(result.db_bytes / 1024)} KB), ${result.photos_uploaded} new photo(s), ${result.pruned} old copy(ies) removed.`);
  }).catch((err) => {
    status({ ok: false, at: new Date().toISOString(), error: err.message });
    console.error(`Off-server backup FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { signS3, createBucket, runBackup };
