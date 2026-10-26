const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Runs in its own process, so these logins don't affect the other test files.
process.env.APP_USERS = 'Owner:owner-pass:admin';
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

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const OWNER = login('Owner', 'owner-pass');
async function call(method, url, body, auth = OWNER) {
  const res = await fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

let samId;
let annaId;

test('an admin adds logins with a name, password and level', async () => {
  const sam = await call('POST', '/api/users', { name: '  Sam   Ortega ', password: 'sam-password', role: 'sales' });
  assert.equal(sam.status, 201);
  assert.equal(sam.data.name, 'Sam Ortega');
  assert.equal(sam.data.created_by, 'Owner');
  assert.equal(sam.data.password_hash, undefined, 'password hashes never leave the server');
  samId = sam.data.id;
  annaId = (await call('POST', '/api/users', { name: 'Anna', password: 'anna-password', role: 'admin' })).data.id;
  await call('POST', '/api/users', { name: 'Mike', password: 'mike-password', role: 'shop' });

  for (const [body, pattern] of [
    [{ name: 'sam ortega', password: 'whatever-123', role: 'sales' }, /already a login named/],
    [{ name: 'owner', password: 'whatever-123', role: 'sales' }, /already a login named/],
    [{ name: 'Short', password: 'short', role: 'sales' }, /at least 8/],
    [{ name: 'A:B', password: 'whatever-123', role: 'sales' }, /colon/],
    [{ name: 'Boss', password: 'whatever-123', role: 'owner' }, /Pick a level/],
    [{ name: '', password: 'whatever-123', role: 'sales' }, /name/],
  ]) {
    const res = await call('POST', '/api/users', body);
    assert.ok(res.status >= 400, JSON.stringify(body));
    assert.match(res.data.error, pattern);
  }

  const { users } = (await call('GET', '/api/users')).data;
  assert.deepEqual(users.map((u) => [u.name, u.role, u.source]),
    [['Owner', 'admin', 'server'], ['Anna', 'admin', 'app'], ['Mike', 'shop', 'app'], ['Sam Ortega', 'sales', 'app']]);
});

test('new logins can sign in with their level, and their work carries their name', async () => {
  const SAM = login('Sam Ortega', 'sam-password');
  assert.equal((await call('GET', '/api/meta', undefined, SAM)).data.currentRole, 'sales');
  assert.equal((await call('GET', '/api/meta', undefined, login('sam ortega', 'sam-password'))).data.currentUser, 'Sam Ortega', 'names are not case sensitive');
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'wrong-password'))).status, 401);
  assert.equal((await call('GET', '/api/users', undefined, SAM)).status, 403, 'only admins manage the team');
  assert.equal((await call('GET', '/api/jobs?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z', undefined, login('Mike', 'mike-password'))).status, 200);

  const { lead } = (await call('POST', '/api/leads', { full_name: 'Tracked Lead', phone: '702-555-0101' }, SAM)).data;
  const note = (await call('POST', `/api/leads/${lead.id}/notes`, { note: 'Called, left VM' }, SAM)).data;
  assert.ok(note.activities.every((a) => a.user_name === 'Sam Ortega'));
  const seen = (await call('GET', '/api/users')).data.users.find((u) => u.name === 'Sam Ortega');
  assert.ok(seen.last_seen_at, 'last time in the app is shown to admins');
});

test('admins change levels, reset passwords and deactivate, and every change is logged', async () => {
  const ANNA = login('Anna', 'anna-password');
  assert.equal((await call('PATCH', `/api/users/${samId}`, { role: 'admin' }, ANNA)).data.role, 'admin');
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'sam-password'))).data.currentRole, 'admin');

  await call('PATCH', `/api/users/${samId}`, { password: 'new-sam-password' }, ANNA);
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'sam-password'))).status, 401, 'old password stops working');
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'new-sam-password'))).status, 200);

  await call('PATCH', `/api/users/${samId}`, { active: false }, ANNA);
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'new-sam-password'))).status, 401, 'deactivated logins are locked out');
  await call('PATCH', `/api/users/${samId}`, { active: true });
  assert.equal((await call('GET', '/api/meta', undefined, login('Sam Ortega', 'new-sam-password'))).status, 200);

  const { history } = (await call('GET', '/api/users')).data;
  assert.deepEqual(history.slice(0, 5).map((h) => [h.user_name, h.action, h.by_user]), [
    ['Sam Ortega', 'reactivated', 'Owner'],
    ['Sam Ortega', 'deactivated', 'Anna'],
    ['Sam Ortega', 'password', 'Anna'],
    ['Sam Ortega', 'level', 'Anna'],
    ['Mike', 'created', 'Owner'],
  ]);
  assert.equal(history[3].detail, 'Sales → Admin');
});

test('admins can\'t lock themselves out or remove the last admin', async () => {
  const ANNA = login('Anna', 'anna-password');
  assert.match((await call('PATCH', `/api/users/${annaId}`, { active: false }, ANNA)).data.error, /your own login/);
  assert.match((await call('PATCH', `/api/users/${annaId}`, { role: 'sales' }, ANNA)).data.error, /your own level/);
  assert.equal((await call('PATCH', `/api/users/999`, { active: false })).status, 404);
});
