// Phone and browser alerts through Web Push (the standard behind notifications on Android, iPhone
// home-screen apps and desktop browsers). Free and built in: no outside service or library. The app
// makes its own signing keys (VAPID) the first time it runs and keeps them in the database.
const crypto = require('node:crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(String(text), 'base64url');

// Encrypts a message for one browser (RFC 8291, aes128gcm). Returns the request body.
function encrypt(payload, p256dh, authSecret, { salt = crypto.randomBytes(16), ecdh } = {}) {
  const uaPublic = fromB64url(p256dh);
  const auth = fromB64url(authSecret);
  const server = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the message, then 0x02 to mark it as the last.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function createPush(db, { subject = 'mailto:alerts@example.com', fetchImpl = (...a) => fetch(...a) } = {}) {
  const stmt = (sql) => db.prepare(sql);
  const norm = (name) => String(name ?? '').trim().toLowerCase();

  function keys() {
    const row = stmt("SELECT value FROM settings WHERE key = 'vapid'").get();
    if (row) return JSON.parse(row.value);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const made = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey().length === 32 ? ecdh.getPrivateKey() : Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()])) };
    stmt("INSERT INTO settings (key, value) VALUES ('vapid', ?) ON CONFLICT (key) DO NOTHING").run(JSON.stringify(made));
    return JSON.parse(stmt("SELECT value FROM settings WHERE key = 'vapid'").get().value);
  }

  // The "this alert really comes from our app" header (RFC 8292).
  function vapidAuth(endpoint) {
    const { publicKey, privateKey } = keys();
    const pub = fromB64url(publicKey);
    const key = crypto.createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
      format: 'jwk',
    });
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
  }

  function subscribe(name, subscription = {}, userAgent = '') {
    const { endpoint, keys: k = {} } = subscription;
    if (!/^https:\/\//.test(endpoint || '') || !k.p256dh || !k.auth) throw Object.assign(new Error('That browser sent an incomplete subscription.'), { status: 400 });
    stmt(`INSERT INTO push_subs (name_norm, name, endpoint, p256dh, auth, user_agent, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (endpoint) DO UPDATE SET name_norm = excluded.name_norm, name = excluded.name, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(norm(name), name, endpoint, k.p256dh, k.auth, String(userAgent).slice(0, 200), new Date().toISOString());
    return { ok: true, devices: devicesFor(name) };
  }
  const unsubscribe = (endpoint) => stmt('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || ''));
  const devicesFor = (name) => stmt('SELECT COUNT(*) AS n FROM push_subs WHERE name_norm = ?').get(norm(name)).n;

  // Sends `message` ({ title, body, url, tag }) to every device of each named person.
  // Returns the names that had at least one device take it.
  async function sendTo(names, message) {
    const reached = new Set();
    const payload = JSON.stringify(message);
    for (const name of names) {
      for (const sub of stmt('SELECT * FROM push_subs WHERE name_norm = ?').all(norm(name))) {
        try {
          const res = await fetchImpl(sub.endpoint, {
            method: 'POST',
            headers: { TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuth(sub.endpoint) },
            body: encrypt(payload, sub.p256dh, sub.auth),
          });
          // Gone means the phone turned alerts off or the app was removed.
          if (res.status === 404 || res.status === 410) unsubscribe(sub.endpoint);
          else if (res.ok) {
            reached.add(name);
            stmt('UPDATE push_subs SET last_ok_at = ? WHERE id = ?').run(new Date().toISOString(), sub.id);
          }
        } catch (err) {
          console.error(`Push to ${name} failed:`, err.message);
        }
      }
    }
    return [...reached];
  }

  return { publicKey: () => keys().publicKey, subscribe, unsubscribe, devicesFor, sendTo, vapidAuth };
}

module.exports = { createPush, encrypt };
