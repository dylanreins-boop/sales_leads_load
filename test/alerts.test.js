const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.TZ = 'America/Los_Angeles';

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createUserService } = require('../src/users');
const { createPush } = require('../src/push');
const { createAlertService } = require('../src/alerts');

// What a phone does with a push message (RFC 8291), so we can check the server's encryption.
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = body.subarray(21 + idLen);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record marker');
  return plain.subarray(0, -1).toString();
}

function phone() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint: `https://push.example.com/send/${crypto.randomUUID()}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

test('phone alerts are encrypted for that phone and signed with the app\'s own keys', async () => {
  const db = openDatabase(':memory:');
  const requests = [];
  const push = createPush(db, { subject: 'mailto:shop@example.com', fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response('', { status: 201 }); } });
  const samPhone = phone();
  push.subscribe('Sam', samPhone.sub, 'iPhone');
  assert.equal(push.devicesFor('sam'), 1);
  assert.equal(push.publicKey(), push.publicKey(), 'keys are made once and kept');

  const reached = await push.sendTo(['Sam', 'Lisa'], { title: 'New lead: Ana Cruz', body: 'Car · Call 702-555-0101', url: '/?lead=1' });
  assert.deepEqual(reached, ['Sam']);
  const { url, options } = requests[0];
  assert.equal(url, samPhone.sub.endpoint);
  assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(decrypt(options.body, samPhone.ecdh, samPhone.auth)), { title: 'New lead: Ana Cruz', body: 'Car · Call 702-555-0101', url: '/?lead=1' });

  // The VAPID token checks out against the app's public key.
  const [, jwt, k] = options.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, push.publicKey());
  const [header, claims, signature] = jwt.split('.');
  const pub = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(claims, 'base64url'))), ['aud', 'exp', 'sub']);
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, 'https://push.example.com');

  // A phone that turned alerts off is forgotten.
  const gone = createPush(db, { fetchImpl: async () => new Response('', { status: 410 }) });
  await gone.sendTo(['Sam'], { title: 'x' });
  assert.equal(push.devicesFor('Sam'), 0);
});

function setup() {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db);
  const users = createUserService(db, { serverUsers: [
    { name: 'Dylan', password: 'x', role: 'admin' }, { name: 'Sam', password: 'x', role: 'sales' }, { name: 'Mike', password: 'x', role: 'shop' },
  ] });
  const sent = [];
  const push = { sendTo: async (names, message) => { sent.push({ names, ...message }); return names.filter((n) => n !== 'Dylan'); }, devicesFor: () => 0 };
  const texts = [];
  const texter = { configured: true, send: async (m) => { texts.push(m); return {}; } };
  const alerts = createAlertService(db, { leads, users, push, texter, minutes: 15, hours: { start: 7, end: 20 } });
  return { db, leads, alerts, sent, texts };
}
const at = (day, hour, minute = 0) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour, minute); };

test('a new lead pings the sales team; 15 minutes with nobody calling pings the admins', async () => {
  const { db, leads, alerts, sent, texts } = setup();
  alerts.savePrefs('Sam', { alert_phone: '(702) 555-0199' });
  const { lead } = leads.ingest({ source: 'facebook', first_name: 'Ana', last_name: 'Cruz', phone: '702-555-0101', vehicle_type: 'Car', received_at: at('2026-11-10', 9).toISOString() });
  alerts.leadArrived(lead, at('2026-11-10', 9));
  await alerts.process({ at: at('2026-11-10', 9), baseUrl: 'https://leads.example.com' });
  assert.deepEqual(sent.map((s) => [s.names, s.title, s.body]), [[['Sam'], 'New lead: Ana Cruz', 'Car · from Facebook · Call 702-555-0101']]);
  assert.equal(texts[0].to, '(702) 555-0199');
  assert.match(texts[0].body, /^New lead: Ana Cruz: Car · from Facebook · Call 702-555-0101 https:\/\/leads\.example\.com\/\?lead=\d+$/);

  await alerts.process({ at: at('2026-11-10', 9, 10) });
  assert.equal(sent.length, 1, 'not yet');
  await alerts.process({ at: at('2026-11-10', 9, 15) });
  assert.deepEqual(sent[1].names, ['Dylan']);
  assert.equal(sent[1].title, 'Nobody has called Ana Cruz yet');
  assert.ok(leads.getLead(lead.id).activities.some((a) => a.note === 'Not worked within 15 minutes'));
  await alerts.process({ at: at('2026-11-10', 9, 30) });
  assert.equal(sent.length, 2, 'once');
  void db;
});

test('no admin alert when a rep worked the lead; overnight leads wait for alert hours; old and manual leads never ping', async () => {
  const { leads, alerts, sent } = setup();
  const { lead } = leads.ingest({ source: 'website', full_name: 'Bo Diaz', phone: '702-555-0102', received_at: at('2026-11-10', 13).toISOString() });
  alerts.leadArrived(lead, at('2026-11-10', 13));
  await alerts.process({ at: at('2026-11-10', 13) });
  leads.dispositionLead(lead.id, { disposition: 'no_answer_vm', note: 'Left VM', reminder: false }, { user: 'Sam' });
  await alerts.process({ at: at('2026-11-10', 13, 20) });
  assert.equal(sent.length, 1, 'only the new-lead alert');

  const { lead: night } = leads.ingest({ source: 'website', full_name: 'Night Owl', phone: '702-555-0103', received_at: at('2026-11-10', 23).toISOString() });
  alerts.leadArrived(night, at('2026-11-10', 23));
  await alerts.process({ at: at('2026-11-10', 23, 1) });
  await alerts.process({ at: at('2026-11-11', 6, 59) });
  assert.equal(sent.length, 1, 'quiet overnight');
  await alerts.process({ at: at('2026-11-11', 7) });
  assert.equal(sent.at(-1).title, 'New lead: Night Owl');

  const { lead: old } = leads.ingest({ source: 'facebook', full_name: 'Synced Later', phone: '702-555-0104', received_at: at('2026-11-01', 9).toISOString() });
  alerts.leadArrived(old, at('2026-11-11', 7, 5));
  const { lead: manual } = leads.ingest({ source: 'manual', full_name: 'Walk In', phone: '702-555-0105' });
  alerts.leadArrived(manual, at('2026-11-11', 7, 5));
  await alerts.process({ at: at('2026-11-11', 7, 5) });
  assert.equal(sent.length, 2);
});

test('a customer text reply pings the rep who last worked the lead', async () => {
  const { leads, alerts, sent } = setup();
  const { lead } = leads.ingest({ source: 'manual', full_name: 'Cy Long', phone: '702-555-0106' }, { user: 'Sam' });
  leads.addNote(lead.id, 'Called, will text', { user: 'Sam' });
  await alerts.replied(leads.getLead(lead.id), 'Tuesday works!');
  assert.deepEqual([sent[0].names, sent[0].title, sent[0].body], [['Sam'], 'Text from Cy Long', 'Tuesday works!']);
  assert.throws(() => alerts.savePrefs('Sam', { alert_phone: '12' }), /mobile number/);
});
