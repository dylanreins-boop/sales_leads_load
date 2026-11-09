const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin';
process.env.APP_PASSWORD = '';
delete process.env.CALLS_ENABLED;

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

test('without CALLS_ENABLED there is no dialer at all (the build without it)', async () => {
  const server = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const A = { Authorization: `Basic ${Buffer.from('Dylan:admin-pass').toString('base64')}` };
  try {
    const meta = await (await fetch(`${base}/api/meta`, { headers: A })).json();
    assert.deepEqual([meta.callsEnabled, meta.callsReady], [false, null]);
    for (const path of ['/api/calls', '/api/calls/queue', '/api/calls/me', '/api/leads/1/calls']) assert.equal((await fetch(base + path, { headers: A })).status, 404, path);
    assert.equal((await fetch(`${base}/webhooks/twilio/calls/1/answer`, { method: 'POST' })).status, 404);
    const a = await (await fetch(`${base}/api/analytics?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`, { headers: A })).json();
    assert.equal('calls' in a, false);
  } finally { server.close(); }
});
