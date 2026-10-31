const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const { signS3, runBackup } = require('../scripts/backup-offsite');

test('requests are signed exactly like AWS\'s own published example', () => {
  const headers = signS3({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    headers: { Range: 'bytes=0-9' }, now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('a backup run copies the database and new photos to the bucket and prunes old copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  const dbPath = path.join(dir, 'leads.db');
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE leads (name TEXT); INSERT INTO leads VALUES ('Ana Cruz')");
  fs.mkdirSync(path.join(dir, 'photos'));
  fs.writeFileSync(path.join(dir, 'photos', 'job-1-a.jpg'), 'jpeg-bytes');
  fs.writeFileSync(path.join(dir, 'photos', 'signoff-1-b.png'), 'png-bytes');

  // A pretend bucket that holds objects in memory.
  const store = new Map([['db/leads-2026-09-01.db.gz', Buffer.from('old')], ['db/leads-2026-10-20.db.gz', Buffer.from('recent')]]);
  const calls = [];
  async function fakeFetch(url, options) {
    const u = new URL(url);
    calls.push([options.method, u.host, u.pathname]);
    assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=KEY\/\d{8}\/us-west-2\/s3\/aws4_request/);
    const key = decodeURIComponent(u.pathname.slice(1));
    if (options.method === 'PUT') { store.set(key, Buffer.from(options.body)); return new Response('', { status: 200 }); }
    if (options.method === 'DELETE') { store.delete(key); return new Response(null, { status: 204 }); }
    const prefix = u.searchParams.get('prefix');
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
    return new Response(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`, { status: 200 });
  }
  const env = { DB_PATH: dbPath, PHOTOS_DIR: path.join(dir, 'photos'), BACKUP_DIR: dir, BACKUP_S3_BUCKET: 'shop-backups', BACKUP_S3_REGION: 'us-west-2', BACKUP_S3_KEY_ID: 'KEY', BACKUP_S3_SECRET: 'SECRET' };

  const first = await runBackup({ env, fetchImpl: fakeFetch, now: new Date('2026-10-31T10:00:00Z') });
  assert.deepEqual([first.db_key, first.photos_uploaded, first.pruned], ['db/leads-2026-10-31.db.gz', 2, 1]);
  assert.equal(calls[0][1], 'shop-backups.s3.us-west-2.amazonaws.com');
  assert.ok(!store.has('db/leads-2026-09-01.db.gz'), 'older than 30 days: removed');
  assert.ok(store.has('db/leads-2026-10-20.db.gz'));
  assert.equal(store.get('photos/job-1-a.jpg').toString(), 'jpeg-bytes');

  // The uploaded copy is a real, readable database.
  const restored = path.join(dir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(store.get('db/leads-2026-10-31.db.gz')));
  assert.deepEqual(new DatabaseSync(restored).prepare('SELECT name FROM leads').all().map((r) => r.name), ['Ana Cruz']);

  // Next night: only the new photo goes up.
  fs.writeFileSync(path.join(dir, 'photos', 'job-2-c.jpg'), 'more');
  const second = await runBackup({ env, fetchImpl: fakeFetch, now: new Date('2026-11-01T10:00:00Z') });
  assert.deepEqual([second.photos_uploaded, second.photos_total], [1, 3]);

  await assert.rejects(runBackup({ env: { ...env, BACKUP_S3_SECRET: '' }, fetchImpl: fakeFetch }), /Set BACKUP_S3_BUCKET/);
  db.close();
});
