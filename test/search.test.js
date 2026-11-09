const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';

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

test('search finds working, past-customer, old and dead leads, best matches first', async () => {
  const add = async (lead) => (await call('POST', '/api/leads', lead)).data.lead;
  const working = await add({ full_name: 'Sara Lopez', phone: '702-555-0101', vehicle_type: 'Car', vehicle_make: 'Tesla' });
  const old = await add({ full_name: 'Sarah Kim', phone: '702-555-0102', vehicle_type: 'Truck' });
  const customer = await add({ full_name: 'Tom Sarandon', phone: '702-555-0103', vehicle_type: 'Boat' });
  const dead = await add({ full_name: 'Sara Dunn', email: 'sdunn@example.com', vehicle_type: 'Car' });
  await add({ full_name: 'Mark Allen', phone: '702-555-0199' });
  const archive = db.prepare('UPDATE leads SET archived_at = ?, stage = ? WHERE id = ?');
  archive.run(new Date().toISOString(), 'contacted', old.id);
  archive.run(new Date().toISOString(), 'booked', customer.id);
  archive.run(new Date().toISOString(), 'waste', dead.id);

  // The board only has working leads; search has them all.
  assert.deepEqual((await call('GET', '/api/leads?q=sar')).data.map((l) => l.full_name), ['Sara Lopez']);
  const r = (await call('GET', '/api/leads/search?q=sar')).data;
  assert.equal(r.total, 4);
  assert.deepEqual(r.results.map((l) => [l.full_name, l.status]).slice(0, 3).map((x) => x[0]).sort(), ['Sara Dunn', 'Sara Lopez', 'Sarah Kim']);
  assert.equal(r.results.at(-1).full_name, 'Tom Sarandon', 'a last name match comes after first names');
  assert.deepEqual(Object.fromEntries(r.results.map((l) => [l.full_name, l.status])), { 'Sara Lopez': 'active', 'Sarah Kim': 'old', 'Tom Sarandon': 'customer', 'Sara Dunn': 'dead' });
  assert.equal(r.results.find((l) => l.id === working.id).vehicle_make, 'Tesla');

  assert.deepEqual((await call('GET', '/api/leads/search?q=555-0103')).data.results.map((l) => l.full_name), ['Tom Sarandon'], 'by phone');
  assert.deepEqual((await call('GET', '/api/leads/search?q=sdunn')).data.results.map((l) => l.full_name), ['Sara Dunn'], 'by email');
  assert.deepEqual((await call('GET', '/api/leads/search?q=s')).data, { results: [], total: 0 }, 'one letter is too little');
  assert.equal((await call('GET', '/api/leads/search?q=sara', undefined, auth('Mike', 'shop-pass'))).status, 403, 'not for shop logins');
});
