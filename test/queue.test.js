const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.TWILIO_ACCOUNT_SID = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let db;
let server;
let base;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
async function call(method, url, body, a = auth('Sam', 'sales-pass')) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const text = (db_) => (leadId, direction, body, at, user = null) => db_.prepare(
  "INSERT INTO texts (lead_id, direction, phone, body, status, user_name, created_at) VALUES (?, ?, '7025550100', ?, 'sent', ?, ?)",
).run(leadId, direction, body, user, at);

test('the to-do list: replies waiting, new leads, quiet quotes and leads with no next step', async () => {
  const add = async (full_name, phone) => (await call('POST', '/api/leads', { full_name, phone, vehicle_type: 'Car' })).data.lead;
  const addText = text(db);
  const contacted = db.prepare('UPDATE leads SET stage = ?, last_contacted_at = ?, last_contact_by = ?, last_contact_kind = ? WHERE id = ?');

  const fresh = await add('Nina New', '702-555-0201');
  const replied = await add('Ray Reply', '702-555-0202');
  contacted.run('voicemail', ago(30), 'Sam', 'call', replied.id);
  addText(replied.id, 'in', 'Can you do Saturday?', ago(2));
  const stopped = await add('Stan Stop', '702-555-0203');
  contacted.run('contacted', ago(30), 'Sam', 'call', stopped.id);
  addText(stopped.id, 'in', 'STOP', ago(1));
  const remind = db.prepare('INSERT INTO reminders (lead_id, due_at, created_at) VALUES (?, ?, ?)');
  remind.run(stopped.id, new Date(Date.now() + 86400000).toISOString(), ago(1));
  const quoted = await add('Quinn Quote', '702-555-0204');
  contacted.run('contacted', ago(80), 'Sam', 'call', quoted.id);
  db.prepare("INSERT INTO quotes (lead_id, lines, total_cents, created_by, created_at) VALUES (?, '[]', 189900, 'Sam', ?)").run(quoted.id, ago(72));
  const stuck = await add('Stu Stuck', '702-555-0205');
  contacted.run('follow_up_1', ago(48), 'Sam', 'call', stuck.id);
  const planned = await add('Pat Planned', '702-555-0206');
  contacted.run('follow_up_1', ago(48), 'Sam', 'call', planned.id);
  remind.run(planned.id, new Date(Date.now() + 86400000).toISOString(), ago(48));

  const q = (await call('GET', '/api/queue')).data;
  const names = (list) => list.map((l) => l.full_name);
  assert.deepEqual(names(q.replies), ['Ray Reply'], 'STOP needs no answer');
  assert.equal(q.replies[0].reply, 'Can you do Saturday?');
  assert.deepEqual(names(q.fresh), ['Nina New']);
  assert.deepEqual(names(q.quotes), ['Quinn Quote']);
  assert.equal(q.quotes[0].quote.total_cents, 189900);
  assert.deepEqual(names(q.stuck), ['Stu Stuck'], 'a call is planned for Pat; Stan has one too');
  assert.equal((await call('GET', '/api/queue', undefined, auth('Mike', 'shop-pass'))).status, 403, 'not for the shop');

  // On the board and the lead: the same flags.
  const board = (await call('GET', '/api/leads')).data;
  assert.equal(board.find((l) => l.id === replied.id).needs_reply, true);
  assert.equal(board.find((l) => l.id === stuck.id).no_next_step, true);
  assert.equal(board.find((l) => l.id === planned.id).no_next_step, false);
  assert.equal((await call('GET', `/api/leads/${replied.id}`)).data.needs_reply, true);

  // Answering (a rep's own text counts as contact) clears it; so does a call logged after the text.
  contacted.run('voicemail', new Date().toISOString(), 'Sam', 'text', replied.id);
  const after = (await call('GET', '/api/queue')).data;
  assert.equal(after.replies.length, 0);
  assert.ok(names(after.stuck).includes('Ray Reply'), 'answered, but nothing planned next');
});
