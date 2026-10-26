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
