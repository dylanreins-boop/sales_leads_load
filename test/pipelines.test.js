const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Jo:sales-pass2:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let db;
let server;
let base;
const start = async () => {
  server = http.createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
};
before(async () => { db = openDatabase(':memory:'); await start(); });
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SAM = auth('Sam', 'sales-pass');
const JO = auth('Jo', 'sales-pass2');
async function call(method, url, body, a = ADMIN) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ids = (list) => list.map((p) => p.id);

test('admins add a Boats pipeline: boat leads move there, and only the people picked see it', async () => {
  assert.deepEqual(ids((await call('GET', '/api/meta', undefined, SAM)).data.pipelines), ['rv', 'other']);
  const { lead: boat } = (await call('POST', '/api/leads', { full_name: 'Kevin Strand', phone: '702-555-6170', vehicle_type: 'Boat' }, SAM)).data;
  const { lead: car } = (await call('POST', '/api/leads', { full_name: 'Tony Reyes', phone: '702-555-1200', vehicle_type: 'Car' }, SAM)).data;
  assert.equal(boat.pipeline, 'other');

  const setup = (await call('GET', '/api/pipelines')).data;
  assert.deepEqual(setup.people.map((p) => p.name).sort(), ['Dylan', 'Jo', 'Sam']);
  assert.equal((await call('PUT', '/api/pipelines', { pipelines: [] }, SAM)).status, 403, 'admins only');
  const both = [...setup.pipelines.slice(0, 1), { label: 'Boats', types: ['Boat', 'Coach / RV'] }, setup.pipelines[1]];
  assert.match((await call('PUT', '/api/pipelines', { pipelines: both })).data.error, /Coach \/ RV is in both RV Pipeline and Boats/);

  const saved = (await call('PUT', '/api/pipelines', { pipelines: [
    { label: 'Boats & Jet Skis', types: ['Boat', 'Jet Ski'], visible_to: ['Sam'] },
    ...setup.pipelines,
  ] })).data;
  assert.deepEqual(ids(saved), ['boats-jet-skis', 'rv', 'other'], 'the order the admin set; Other always last');
  assert.equal((await call('GET', `/api/leads/${boat.id}`, undefined, SAM)).data.pipeline, 'boats-jet-skis', 'boat leads go there now');
  assert.deepEqual((await call('GET', '/api/leads?pipeline=boats-jet-skis')).data.map((l) => l.full_name), ['Kevin Strand']);
  assert.deepEqual((await call('GET', '/api/leads?pipeline=other')).data.map((l) => l.full_name), ['Tony Reyes']);
  assert.equal(car.pipeline, 'other');

  assert.deepEqual(ids((await call('GET', '/api/meta', undefined, SAM)).data.pipelines), ['boats-jet-skis', 'rv', 'other'], 'Sam was picked');
  assert.deepEqual(ids((await call('GET', '/api/meta', undefined, JO)).data.pipelines), ['rv', 'other'], 'Jo was not');
  assert.deepEqual(ids((await call('GET', '/api/meta')).data.pipelines), ['boats-jet-skis', 'rv', 'other'], 'admins see every pipeline');
  assert.ok((await call('GET', '/api/meta', undefined, JO)).data.allPipelines.some((p) => p.id === 'boats-jet-skis'));

  // Saved: still there after a restart.
  server.close();
  await start();
  assert.equal((await call('GET', `/api/leads/${boat.id}`)).data.pipeline, 'boats-jet-skis');

  // Renamed (same id), then removed: boats go back to All Other Vehicles. RV can't be removed.
  const now = (await call('GET', '/api/pipelines')).data.pipelines;
  const renamed = (await call('PUT', '/api/pipelines', { pipelines: now.map((p) => (p.id === 'boats-jet-skis' ? { ...p, label: 'Marine' } : p)) })).data;
  assert.equal(renamed.find((p) => p.id === 'boats-jet-skis').label, 'Marine');
  const removed = (await call('PUT', '/api/pipelines', { pipelines: [{ id: 'other', label: 'Everything else' }] })).data;
  assert.deepEqual(removed.map((p) => [p.id, p.label]), [['rv', 'RV Pipeline'], ['other', 'Everything else']]);
  assert.equal((await call('GET', `/api/leads/${boat.id}`)).data.pipeline, 'other');
});
