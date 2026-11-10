const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// No logins on the server: the app is open until an admin adds the first one.
process.env.APP_USERS = '';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

test('the first login added must be an admin, and then the app needs a login', async () => {
  const server = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const post = (body, auth) => fetch(`${base}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${base}/api/leads`)).status, 200, 'open with no logins');
    const first = await post({ name: 'Sam', password: 'sam-password', role: 'sales' });
    assert.match((await first.json()).error, /first login has to be an Admin/);
    assert.equal((await post({ name: 'Dylan', password: 'dylan-password', role: 'admin' })).status, 201);
    assert.equal((await fetch(`${base}/api/leads`)).status, 401, 'login required once a login exists');
    const ok = await fetch(`${base}/api/leads`, { headers: { Authorization: `Basic ${Buffer.from('Dylan:dylan-password').toString('base64')}` } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});

test('on the live server with no logins, nobody gets in until the first admin is set up', async () => {
  process.env.NODE_ENV = 'production';
  process.env.SETUP_CODE = 'bob-2026';
  delete require.cache[require.resolve('../server')];
  delete require.cache[require.resolve('../src/config')];
  const { createApp: fresh } = require('../server');
  const server = http.createServer(fresh({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const json = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    assert.equal((await json('/api/leads')).status, 401, 'closed, not open');
    assert.equal((await json('/')).status, 302, 'the app sends you to sign in');
    assert.deepEqual(await (await json('/api/setup')).json(), { needed: true, code_required: true });
    assert.match((await (await json('/api/setup', { name: 'Bob', password: 'strong-pass-1', confirm: 'strong-pass-1', code: 'nope' })).json()).error, /setup code/);
    assert.match((await (await json('/api/setup', { name: 'Bob', password: 'strong-pass-1', confirm: 'different', code: 'bob-2026' })).json()).error, /don't match/);
    const made = await json('/api/setup', { name: 'Bob', password: 'strong-pass-1', confirm: 'strong-pass-1', code: 'bob-2026' });
    assert.equal(made.status, 201);
    const cookie = made.headers.get('set-cookie').split(';')[0];
    const me = await fetch(`${base}/api/meta`, { headers: { cookie } });
    assert.equal((await me.json()).currentRole, 'admin', 'signed in as the new admin');
    assert.equal((await json('/api/setup', { name: 'Eve', password: 'strong-pass-2', code: 'bob-2026' })).status, 409, 'only once');
    assert.equal((await json('/api/setup')).status, 200);
    assert.equal((await (await json('/api/setup')).json()).needed, false);
  } finally {
    server.close();
    delete process.env.NODE_ENV;
    delete process.env.SETUP_CODE;
  }
});
