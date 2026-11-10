const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
async function call(method, url, body, a = ADMIN) {
  const res = await fetch(base + url, { method, headers: { ...(a && { Authorization: a }), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('the admin log keeps sign-ins (and wrong passwords), login changes, pay, settings, exports and deletions; never passwords', async () => {
  // Sign-ins, right and wrong.
  assert.equal((await call('POST', '/api/login', { name: 'Sam', password: 'nope' }, null)).status, 401);
  assert.equal((await call('POST', '/api/login', { name: 'Sam', password: 'sales-pass' }, null)).status, 200);
  // Team: a new login, then a new password and role.
  const added = (await call('POST', '/api/users', { name: 'Lisa', password: 'Lisa-pass-123', role: 'sales' })).data;
  await call('PATCH', `/api/users/${added.id}`, { password: 'Lisa-pass-456', role: 'admin' });
  // Pay, settings, an export.
  await call('PUT', '/api/pay-rates', { user_name: 'Sam', rate: '22' });
  await call('PUT', '/api/settings/lead-score', { hot: 75, warm: 45 });
  await fetch(`${base}/api/export.xlsx`, { headers: { Authorization: ADMIN } });

  assert.equal((await call('GET', '/api/audit', undefined, auth('Sam', 'sales-pass'))).status, 403, 'admins only');
  const log = (await call('GET', '/api/audit')).data;
  const said = log.map((r) => `${r.area}: ${r.user_name} ${r.action}`);
  for (const line of [
    'signin: Sam Wrong password or name',
    'signin: Sam Signed in',
    'team: Dylan Added the login Lisa (sales)',
    'team: Dylan Changed the login Lisa: password (changed), role admin',
    'payroll: Dylan Set the hourly rate for Sam',
    'settings: Dylan Changed lead score: hot 75, warm 45',
    'export: Dylan Downloaded the leads spreadsheet',
  ]) assert.ok(said.includes(line), `missing: ${line}\n${said.join('\n')}`);
  assert.ok(!JSON.stringify(log).includes('Lisa-pass'), 'never a password');
  assert.ok(log[0].ip, 'with the address');
  const signins = (await call('GET', '/api/audit?area=signin')).data;
  assert.ok(signins.every((r) => r.area === 'signin') && signins.length === 2);
  // Reading things isn't logged.
  await call('GET', '/api/leads');
  assert.equal((await call('GET', '/api/audit')).data.length, log.length);
});
