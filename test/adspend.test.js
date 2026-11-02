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
const SAM = auth('Sam', 'sales-pass');
async function call(method, url, body, a = ADMIN) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('admins enter monthly ad spend per source; blank or zero clears it; sales can\'t see it', async () => {
  assert.equal((await call('GET', '/api/ad-spend?from=2026-10&to=2026-11', undefined, SAM)).status, 403);
  assert.equal((await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'facebook', amount: '500' }, SAM)).status, 403);
  assert.equal((await call('PUT', '/api/ad-spend', { month: '2026-13', source: 'facebook', amount: '500' })).status, 400);
  assert.equal((await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'tv', amount: '500' })).status, 400);

  await call('PUT', '/api/ad-spend', { month: '2026-10', source: 'facebook', amount: '$1,200' });
  await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'facebook', amount: '800' });
  await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'google', amount: '300.50' });
  await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'google', amount: '350' });
  let got = (await call('GET', '/api/ad-spend?from=2026-10&to=2026-11')).data;
  assert.ok(got.sources.includes('google'));
  assert.deepEqual(got.rows.map((r) => [r.month, r.source, r.cents, r.updated_by]),
    [['2026-10', 'facebook', 120000, 'Dylan'], ['2026-11', 'facebook', 80000, 'Dylan'], ['2026-11', 'google', 35000, 'Dylan']]);

  await call('PUT', '/api/ad-spend', { month: '2026-11', source: 'google', amount: '' });
  got = (await call('GET', '/api/ad-spend?from=2026-11&to=2026-11')).data;
  assert.deepEqual(got.rows.map((r) => r.source), ['facebook']);
});
