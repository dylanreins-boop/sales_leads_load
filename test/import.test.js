const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { readCsv } = require('../src/sheets');
const { guessMapping, splitVehicle, stageFrom } = require('../src/import');

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SAM = login('Sam', 'sales-pass');
async function call(method, url, body, auth = ADMIN) {
  const res = await fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function upload(buf, name, auth = ADMIN) {
  const res = await fetch(`${base}/api/import/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' }, body: buf });
  return { status: res.status, data: await res.json() };
}

test('columns are matched from their headers; vehicles and statuses are understood', () => {
  assert.deepEqual(guessMapping(['Customer Name', 'Phone #', 'E-mail', 'Vehicle', 'Color', 'Lead Source', 'Date', 'Status', 'Notes']),
    { full_name: 0, phone: 1, email: 2, vehicle: 3, vehicle_color: 4, source: 5, received_at: 6, status: 7, message: 8 });
  assert.deepEqual(guessMapping(['First Name', 'Last Name', 'Cell', 'Year', 'Make', 'Model', 'Comments']),
    { first_name: 0, last_name: 1, phone: 2, vehicle_year: 3, vehicle_make: 4, vehicle_model: 5, message: 6 });
  assert.deepEqual(splitVehicle('2022 Tesla Model Y'), { vehicle_year: '2022', vehicle_make: 'Tesla', vehicle_model: 'Model Y' });
  assert.deepEqual(splitVehicle('2020 Entegra Anthem 44F motorhome'), { vehicle_type: 'Coach / RV', vehicle_year: '2020', vehicle_make: 'Entegra', vehicle_model: 'Anthem 44F motorhome' });
  assert.deepEqual(splitVehicle('Boat'), { vehicle_type: 'Boat' });
  assert.deepEqual(['Booked', 'SOLD', 'Not interested', 'left VM', 'Quoted', ''].map(stageFrom), ['booked', 'booked', 'waste', 'voicemail', 'contacted', 'new']);
  assert.deepEqual(readCsv('Name,Notes\r\n"Lopez, Maria","said ""call me""\nlater"\r\n'), [['Name', 'Notes'], ['Lopez, Maria', 'said "call me"\nlater']]);
});

test('an Excel file is previewed, imported (duplicates skipped, old leads off the board) and can be undone', async () => {
  // Already in the app: Jen Park. Her row in the file is skipped.
  await call('POST', '/api/leads', { full_name: 'Jen Park', phone: '702-555-0111' }, SAM);

  const xlsx = fs.readFileSync(path.join(__dirname, 'fixtures', 'prior-leads.xlsx'));
  assert.equal((await upload(xlsx, 'prior-leads.xlsx', SAM)).status, 403, 'admins import');
  const { status, data: up } = await upload(xlsx, 'prior-leads.xlsx');
  assert.equal(status, 201, JSON.stringify(up));
  assert.equal(up.total, 6, 'blank rows are ignored');
  assert.equal(up.mapping.vehicle, 3);

  const check = (await call('POST', '/api/import/check', { token: up.token, mapping: up.mapping })).data;
  assert.equal(check.ready, 4);
  assert.deepEqual(check.skips.map((s) => [s.name, s.reason]), [
    ['maria lopez', 'Same phone or email as a row above'], ['Jen Park', 'Already in the app (Jen Park)'],
  ]);
  const maria = check.sample[0];
  assert.deepEqual([maria.first_name, maria.last_name, maria.phone, maria.vehicle_year, maria.vehicle_make, maria.vehicle_model, maria.source, maria.stage],
    ['Maria', 'Lopez', '702-555-0142', '2022', 'Tesla', 'Model Y', 'facebook', 'booked']);
  assert.equal(maria.received_at, new Date(2026, 2, 14, 10, 30).toISOString());
  const derek = check.sample[1];
  assert.equal(derek.phone, '702-555-0188', 'a phone stored as a number is tidied');
  const gary = check.sample[2];
  assert.deepEqual([gary.vehicle_type, gary.heard_about, gary.stage], ['Coach / RV', 'Word of mouth referral', 'waste']);
  assert.match(gary.message, /^Price shopping "too high"\nStatus before the app: Not interested$/);

  const done = (await call('POST', '/api/import/commit', { token: up.token, mapping: up.mapping, placement: 'auto' })).data;
  assert.equal(done.created, 4);
  // Maria (booked in March) -> Past Customers; Derek (September) and Gary (dead) -> Old & Dead; the undated row stays on the board.
  assert.deepEqual([done.board, done.customers, done.old], [1, 1, 2]);

  const customers = (await call('GET', '/api/leads?view=customers')).data;
  assert.deepEqual(customers.map((l) => l.full_name), ['Maria Lopez']);
  const old = (await call('GET', '/api/leads?view=old')).data.map((l) => l.full_name).sort();
  assert.ok(old.includes('Derek Chan') && old.includes('Gary & Sue Lindstrom'));
  const fresh = (await call('GET', `/api/leads/${customers[0].id}`)).data;
  assert.ok(fresh.activities.some((a) => a.type === 'import' && a.note === 'Imported from prior-leads.xlsx (row 2), stage booked' && a.user_name === 'Dylan'));
  assert.equal((await call('POST', '/api/import/commit', { token: up.token, mapping: up.mapping })).status, 400, 'an upload imports once');

  const batches = (await call('GET', '/api/import/batches')).data;
  assert.deepEqual([batches[0].file, batches[0].created_count, batches[0].still_there], ['prior-leads.xlsx', 4, 4]);
  const undone = (await call('POST', `/api/import/batches/${done.batch}/undo`)).data;
  assert.equal(undone.removed, 4);
  assert.equal((await call('GET', '/api/leads?view=customers')).data.length, 0);
  assert.equal((await call('GET', '/api/leads?q=Jen')).data.length, 1, 'leads that were already there stay');
});

test('a CSV goes on the board as fresh leads when asked, without new-lead alerts', async () => {
  const csv = Buffer.from('First Name;Last Name;Cell;Year;Make;Model;Comments\nBo;Diaz;7025559001;2021;Porsche;Taycan;Call after 5\nCy;Long;7025559002;2018;Ford;Raptor;\n');
  const up = (await upload(csv, 'old.csv')).data;
  const done = (await call('POST', '/api/import/commit', { token: up.token, mapping: up.mapping, placement: 'board' })).data;
  assert.deepEqual([done.created, done.board], [2, 2]);
  const bo = (await call('GET', '/api/leads?q=Diaz')).data[0];
  assert.equal(bo.archived_at, null);
  assert.equal(bo.source, 'import');
  assert.equal(bo.message, 'Call after 5');
  const lead = (await call('GET', `/api/leads/${bo.id}`)).data;
  assert.ok(!lead.activities.some((a) => a.type === 'alert'));
  assert.equal((await upload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), 'old.xls')).data.error.includes('Save As'), true);
  const template = await fetch(`${base}/api/import/template.csv`, { headers: { Authorization: ADMIN } });
  assert.match(await template.text(), /^First name,Last name,Phone,Email,Vehicle/);
});
