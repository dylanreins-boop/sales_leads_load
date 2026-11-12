// Sold (left menu): every lead at Booked, with when and who sold it and its job; sales see their own.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Lee:sales2-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.EMAIL_PROVIDER = '';

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
const LEE = auth('Lee', 'sales2-pass');
const SHOP = auth('Mike', 'shop-pass');
async function call(method, url, body, a = ADMIN) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const nextWeek = () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0); return d.toISOString(); };

test('Sold: booked leads with when, who and the job; admins see all, sales their own, the shop none', async () => {
  const mk = async (name, phone, a) => (await call('POST', '/api/leads', { full_name: name, phone, vehicle_type: 'Car', vehicle_year: '2023', vehicle_make: 'Tesla', vehicle_model: 'Model 3' }, a)).data.lead;
  const ana = await mk('Ana Cruz', '702-555-0301', SAM);
  const bo = await mk('Bo Diaz', '702-555-0302', LEE);
  const cy = await mk('Cy Fox', '702-555-0303', SAM);
  // Sam books Ana with a job and a price; Lee books Bo; Cy is only contacted.
  await call('POST', `/api/leads/${ana.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: nextWeek(), job_hours: 4, job_amount: '1895', send_confirmation: false }, SAM);
  await call('POST', `/api/leads/${bo.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: nextWeek(), job_hours: 4, job_amount: '2400', send_confirmation: false }, LEE);
  await call('POST', `/api/leads/${cy.id}/disposition`, { disposition: 'callback_requested', note: 'Call back' }, SAM);

  const all = (await call('GET', '/api/sold')).data;
  assert.equal(all.mine_only, false);
  const byName = Object.fromEntries(all.leads.map((l) => [l.full_name, l]));
  assert.deepEqual(Object.keys(byName).sort(), ['Ana Cruz', 'Bo Diaz'], 'only booked leads');
  assert.deepEqual([byName['Ana Cruz'].sold_by, byName['Ana Cruz'].amount_cents, byName['Ana Cruz'].job_status], ['Sam', 189500, 'scheduled']);
  assert.equal(byName['Bo Diaz'].sold_by, 'Lee');
  assert.ok(byName['Ana Cruz'].sold_at && byName['Ana Cruz'].job_start);
  assert.deepEqual(byName['Ana Cruz'].booked_services, ['full_decon_coat']);

  const sam = (await call('GET', '/api/sold', undefined, SAM)).data;
  assert.equal(sam.mine_only, true);
  assert.deepEqual(sam.leads.map((l) => l.full_name), ['Ana Cruz'], 'sales see the ones they sold');
  assert.equal((await call('GET', '/api/sold', undefined, SHOP)).status, 403);

  // Moved to Booked by hand, no job: still sold, by whoever moved it, dated then.
  await call('PATCH', `/api/leads/${cy.id}`, { stage: 'booked' }, SAM);
  const cyRow = (await call('GET', '/api/sold')).data.leads.find((l) => l.id === cy.id);
  assert.deepEqual([cyRow.sold_by, cyRow.job_status, cyRow.amount_cents], ['Sam', null, null]);
  assert.ok(cyRow.sold_at);
});

test('Mark as sold (admins): imported leads move to Booked with when, who and the amount', async () => {
  const mk = async (name, phone, received) => (await call('POST', '/api/leads', { full_name: name, phone, received_at: received })).data.lead;
  const old = await mk('Dee Old', '702-555-0401', '2025-03-10T17:00:00.000Z');
  const two = await mk('Eve Two', '702-555-0402');
  const three = await mk('Fay Three', '702-555-0403');
  assert.equal((await call('POST', '/api/leads/bulk', { ids: [old.id], action: 'sold' }, SAM)).status, 403, 'admins only');
  assert.match((await call('POST', '/api/leads/bulk', { ids: [two.id, three.id], action: 'sold', amount: '900' })).data.error, /one lead at a time/);
  assert.match((await call('POST', '/api/leads/bulk', { ids: [two.id], action: 'sold', sold_on: '2099-01-01' })).data.error, /future/);

  assert.equal((await call('POST', '/api/leads/bulk', { ids: [old.id], action: 'sold', sold_by: 'Lee', amount: '$2,150' })).data.changed, 1);
  assert.equal((await call('POST', '/api/leads/bulk', { ids: [two.id, three.id], action: 'sold', sold_on: '2026-06-15', sold_by: 'Sam' })).data.changed, 2);

  const rows = Object.fromEntries((await call('GET', '/api/sold')).data.leads.map((l) => [l.full_name, l]));
  const oldReceived = (await call('GET', `/api/leads/${old.id}`)).data.lead?.received_at ?? (await call('GET', `/api/leads/${old.id}`)).data.received_at;
  assert.deepEqual([rows['Dee Old'].sold_by, rows['Dee Old'].amount_cents, rows['Dee Old'].sold_at], ['Lee', 215000, oldReceived], 'sold when it came in');
  assert.deepEqual([rows['Eve Two'].sold_by, rows['Eve Two'].sold_at.slice(0, 10), rows['Eve Two'].amount_cents], ['Sam', '2026-06-15', null]);
  assert.ok(rows['Fay Three'], 'both marked');
  // Sam sees the ones marked as his.
  const mine = (await call('GET', '/api/sold', undefined, SAM)).data.leads.map((l) => l.full_name);
  assert.ok(mine.includes('Eve Two') && mine.includes('Fay Three') && !mine.includes('Dee Old'));
  const notes = (await call('GET', `/api/leads/${old.id}`)).data.activities.map((a) => a.note || '').join(' | ');
  assert.match(notes, /Marked as sold by Lee \(sold \d{4}-\d\d-\d\d, \$2,150\)/);
});
