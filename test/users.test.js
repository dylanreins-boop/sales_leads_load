const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Runs in its own process (node --test), so these logins don't affect app.test.js.
process.env.APP_USERS = 'Dylan:dylan-pass, Sam:sam-pass';
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

async function call(method, path, body, auth) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('wrong or missing login is refused', async () => {
  assert.equal((await call('GET', '/api/leads')).status, 401);
  assert.equal((await call('GET', '/api/leads', undefined, login('Dylan', 'sam-pass'))).status, 401);
  assert.equal((await call('GET', '/api/leads', undefined, login('Nobody', 'dylan-pass'))).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 401);
});

test('each action records who did it and when', async () => {
  const dylan = login('Dylan', 'dylan-pass');
  const sam = login('sam', 'sam-pass'); // names are not case-sensitive

  assert.equal((await call('GET', '/api/meta', undefined, sam)).data.currentUser, 'Sam');

  const { lead } = (await call('POST', '/api/leads', { full_name: 'Ana Ruiz', phone: '555-100-2000' }, dylan)).data;
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Left VM' }, dylan);
  await call('POST', `/api/leads/${lead.id}/notes`, { note: 'Spouse answered, call after 6' }, sam);
  await call('PATCH', `/api/leads/${lead.id}`, { stage: 'contacted' }, sam);

  const { activities } = (await call('GET', `/api/leads/${lead.id}`, undefined, dylan)).data;
  const by = Object.fromEntries(activities.map((a) => [a.type, a.user_name]));
  assert.deepEqual(by, { created: 'Dylan', disposition: 'Dylan', note: 'Sam', stage_change: 'Sam' });
  for (const a of activities) assert.ok(!Number.isNaN(Date.parse(a.created_at)), 'every entry has a timestamp');
});

test('leads from the website have no user attached', async () => {
  await call('POST', '/api/intake/website', { name: 'Web Person', phone: '555-300-4000' });
  const leads = (await call('GET', '/api/leads', undefined, login('Dylan', 'dylan-pass'))).data;
  const web = leads.find((l) => l.full_name === 'Web Person');
  const { activities } = (await call('GET', `/api/leads/${web.id}`, undefined, login('Dylan', 'dylan-pass'))).data;
  assert.equal(activities[0].user_name, null);
});
