const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = '';
process.env.APP_PASSWORD = '';
process.env.WEBSITE_API_KEY = '';
process.env.LEAD_ARCHIVE_DAYS = '14';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let server;
let base;
const db = openDatabase(':memory:');

before(async () => {
  server = http.createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const backdate = (name, days) => db.prepare('UPDATE leads SET received_at = ? WHERE full_name = ?').run(daysAgo(days), name);
const names = (rows) => rows.map((l) => l.full_name).sort();

test('leads move to Old & Dead Leads after two weeks, booked leads stay', async () => {
  for (const [name, type, source, phone] of [
    ['Old Car', 'Car', 'website', '702-555-0001'], ['Old RV', 'Coach / RV', 'facebook', '702-555-0002'],
    ['Dead Boat', 'Boat', 'website', '702-555-0003'], ['Booked Truck', 'Truck', 'manual', '702-555-0004'],
    ['Fresh SUV', 'SUV', 'website', '702-555-0005'],
  ]) {
    const path = source === 'manual' ? '/api/leads' : '/api/intake/website';
    await call('POST', path, { full_name: name, phone, vehicle_type: type });
  }
  db.prepare("UPDATE leads SET source = 'facebook' WHERE full_name = 'Old RV'").run();
  const all = (await call('GET', '/api/leads')).data;
  const id = (n) => all.find((l) => l.full_name === n).id;
  await call('POST', `/api/leads/${id('Dead Boat')}/disposition`, { disposition: 'not_interested', note: 'Sold the boat' });
  await call('POST', `/api/leads/${id('Booked Truck')}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'] });
  await call('POST', `/api/leads/${id('Old Car')}/disposition`, { disposition: 'no_answer_vm', note: 'VM' });
  for (const n of ['Old Car', 'Old RV', 'Dead Boat', 'Booked Truck']) backdate(n, 15);
  backdate('Fresh SUV', 13);

  const active = (await call('GET', '/api/leads')).data;
  assert.deepEqual(names(active), ['Booked Truck', 'Fresh SUV']);

  const old = (await call('GET', '/api/leads?view=old')).data;
  assert.deepEqual(names(old), ['Dead Boat', 'Old Car', 'Old RV']);
  assert.equal(old.find((l) => l.full_name === 'Dead Boat').status, 'dead');
  assert.equal(old.find((l) => l.full_name === 'Old Car').status, 'old');

  // Separated by vehicle and lead type.
  assert.deepEqual(names((await call('GET', '/api/leads?view=old&vehicle_type=Coach%20%2F%20RV')).data), ['Old RV']);
  assert.deepEqual(names((await call('GET', '/api/leads?view=old&source=website')).data), ['Dead Boat', 'Old Car']);
  assert.deepEqual(names((await call('GET', '/api/leads?view=old&status=dead')).data), ['Dead Boat']);

  // Their reminders are closed and the move is logged.
  const reminders = (await call('GET', '/api/reminders')).data;
  assert.ok(!reminders.some((r) => r.full_name === 'Old Car'));
  const detail = (await call('GET', `/api/leads/${id('Old Car')}`)).data;
  assert.match(detail.activities[0].note, /Moved to Old Leads after 14 days/);
});

test('an old lead can be restored and gets another two weeks', async () => {
  const old = (await call('GET', '/api/leads?view=old')).data;
  const car = old.find((l) => l.full_name === 'Old Car');
  const res = await call('POST', `/api/leads/${car.id}/restore`);
  assert.equal(res.data.status, 'active');
  assert.equal(res.data.stage, 'voicemail', 'keeps its stage');
  assert.ok(names((await call('GET', '/api/leads')).data).includes('Old Car'), 'not swept straight back out');
  assert.equal((await call('POST', `/api/leads/${car.id}/restore`)).status, 400);

  const boat = old.find((l) => l.full_name === 'Dead Boat');
  assert.equal((await call('POST', `/api/leads/${boat.id}/restore`)).data.stage, 'new', 'a dead lead comes back as new');
});

test('an old lead that inquires again comes back as new', async () => {
  const rv = (await call('GET', '/api/leads?view=old')).data.find((l) => l.full_name === 'Old RV');
  await call('POST', '/api/intake/website', { name: 'Old RV again', phone: rv.phone, message: 'Ready to book now' });
  const back = (await call('GET', '/api/leads')).data.find((l) => l.id === rv.id);
  assert.ok(back, 'back on the board');
  assert.equal(back.stage, 'new');
});

test('logging a call on an old lead puts it back on the board', async () => {
  backdate('Fresh SUV', 20);
  const suv = (await call('GET', '/api/leads?view=old')).data.find((l) => l.full_name === 'Fresh SUV');
  const res = await call('POST', `/api/leads/${suv.id}/disposition`, { disposition: 'contacted_follow_up', note: 'Called back' });
  assert.equal(res.data.lead.status, 'active');
  assert.equal(res.data.lead.stage, 'contacted');
});

test('leads export to a real Excel file', async () => {
  const res = await call('GET', '/api/export.xlsx');
  assert.equal(res.status, 200);
  assert.match(res.type, /spreadsheetml/);
  assert.equal(res.data.subarray(0, 2).toString(), 'PK');
  const text = res.data.toString('utf8');
  for (const part of ['xl/workbook.xml', 'name="Summary"', 'name="All Leads"', 'name="Coach - RV"', 'name="Boat"', 'Booked Truck', 'Notes &amp; history']) {
    assert.ok(text.includes(part), `workbook contains ${part}`);
  }
  const oldOnly = (await call('GET', '/api/export.xlsx?view=old')).data.toString('utf8');
  assert.ok(!oldOnly.includes('Booked Truck'));
});
