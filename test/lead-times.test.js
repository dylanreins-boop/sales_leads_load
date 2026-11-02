const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createMessageService } = require('../src/messages');

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
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const card = async (id) => (await call('GET', '/api/leads')).data.find((l) => l.id === id);

test('the board shows when a lead was last opened and by whom, and the last call', async () => {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Hank Whitaker', phone: '702-555-6623', vehicle_type: 'Coach / RV' })).data;
  let c = await card(lead.id);
  assert.deepEqual([c.last_opened_at, c.last_contacted_at], [null, null], 'new: not opened, not contacted');

  await call('GET', `/api/leads/${lead.id}?open=1`, undefined, ADMIN);
  c = await card(lead.id);
  assert.equal(c.last_opened_by, 'Dylan');
  assert.ok(Date.now() - new Date(c.last_opened_at) < 5000);
  await call('GET', `/api/leads/${lead.id}`); // a quiet refresh doesn't count
  assert.equal((await card(lead.id)).last_opened_by, 'Dylan');
  await call('GET', `/api/leads/${lead.id}?open=1`);
  assert.equal((await card(lead.id)).last_opened_by, 'Sam');

  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Left VM' });
  c = await card(lead.id);
  assert.deepEqual([c.last_contact_by, c.last_contact_kind], ['Sam', 'call']);
  const at = c.last_contacted_at;
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'updated_notes', note: 'Has a 43 ft coach' }, ADMIN);
  c = await card(lead.id);
  assert.deepEqual([c.last_contacted_at, c.last_contact_by], [at, 'Sam'], 'a note isn\'t a contact');
});

test('a text the rep sends counts as contact; automatic texts don\'t', async () => {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const texter = { configured: true, send: async () => ({ id: 'SM1' }) };
  const messages = createMessageService(db, { leads, jobs, texter, mailer: { configured: false }, brand: {} });
  const { lead } = leads.ingest({ full_name: 'Walt Jensen', phone: '702-555-7790', vehicle_type: 'Car' });
  await messages.sendText(lead.id, 'Following up on your quote', { trigger: 'quote_followup' });
  assert.equal(leads.getLead(lead.id).last_contacted_at, null);
  await messages.sendText(lead.id, 'Hi Walt, it\'s Sam', { user: 'Sam' });
  const l = leads.getLead(lead.id);
  assert.deepEqual([l.last_contact_by, l.last_contact_kind], ['Sam', 'text']);
  assert.ok(l.last_contacted_at);
});
