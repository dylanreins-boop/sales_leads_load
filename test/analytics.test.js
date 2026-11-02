const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let server;
let base;
let db;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db }));
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

test('the analytics report adds up leads, bookings, speed, reps, sources, money and lost reasons', async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const add = async (name, phone, type, source) => {
    const { lead } = (await call('POST', '/api/leads', { full_name: name, phone, vehicle_type: type })).data;
    if (source) db.prepare('UPDATE leads SET source = ? WHERE id = ?').run(source, lead.id);
    return lead;
  };
  const ana = await add('Ana Cruz', '702-555-0801', 'Car', 'facebook');
  const bo = await add('Bo Diaz', '702-555-0802', 'Car', 'facebook');
  const cy = await add('Cy Long', '702-555-0803', 'Coach / RV', 'website');
  const di = await add('Di Park', '702-555-0804', 'Car', 'website');
  // Ana was reached 30 minutes after she came in, quoted and booked; she paid the rest at pickup.
  db.prepare('UPDATE leads SET received_at = ? WHERE id IN (?, ?, ?, ?)').run(iso(now - 3600000), ana.id, bo.id, cy.id, di.id);
  await call('POST', `/api/leads/${ana.id}/quotes`, { base: 'pkg1300' });
  await call('POST', `/api/leads/${ana.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: iso(now + 86400000), job_hours: 4, job_amount: '1300', deposit_taken: true, deposit_method: 'Card', send_confirmation: false });
  db.prepare("UPDATE activities SET created_at = ? WHERE lead_id = ? AND user_name IS NOT NULL").run(iso(now - 1800000), ana.id);
  const job = (await call('GET', `/api/leads/${ana.id}`)).data.jobs[0];
  await call('POST', `/api/jobs/${job.id}/payments`, { method: 'Zelle' });
  // Bo said no; Cy (an RV) was a wrong number; Di hasn't been touched.
  await call('POST', `/api/leads/${bo.id}/disposition`, { disposition: 'not_interested', note: 'Went elsewhere' });
  await call('POST', `/api/leads/${cy.id}/disposition`, { disposition: 'wrong_number', note: 'Bad number' }, ADMIN);
  const month = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}`;
  await call('PUT', '/api/ad-spend', { month, source: 'facebook', amount: '400' }, ADMIN);

  const q = `from=${iso(now - 2 * 86400000)}&to=${iso(now + 3 * 86400000)}`;
  assert.equal((await call('GET', `/api/analytics?${q}`)).status, 403, 'admins only');
  assert.equal((await call('GET', '/api/analytics?from=x&to=y', undefined, ADMIN)).status, 400);
  const r = (await call('GET', `/api/analytics?${q}`, undefined, ADMIN)).data;

  assert.deepEqual([r.kpis.leads, r.kpis.booked, r.kpis.booking_rate, r.kpis.revenue_cents, r.kpis.collected_cents], [4, 1, 0.25, 130000, 130000]);
  assert.equal(r.kpis.cost_per_booking_cents, 40000);
  assert.deepEqual(r.funnel.map((f) => f.n), [4, 1, 1, 1, 0]);
  assert.equal(r.speed.buckets.find((b) => b.id === '1h').n, 1, 'Ana: 30 minutes');
  assert.equal(r.speed.buckets.find((b) => b.id === 'never').n, 1, 'Di');
  const sam = r.reps.find((x) => x.name === 'Sam');
  assert.deepEqual([sam.booked, sam.revenue_cents, sam.quotes, sam.calls, sam.leads_worked, sam.commission_cents], [1, 130000, 1, 2, 2, 13000]);
  const fb = r.sources.find((s) => s.key === 'facebook');
  assert.deepEqual([fb.leads, fb.booked, fb.spend_cents, fb.cost_per_lead_cents, fb.return_x], [2, 1, 40000, 20000, 3.25]);
  assert.deepEqual(r.lost.reasons.map((x) => [x.reason, x.n]).sort(), [['Not Interested', 1], ['Wrong / Bad Number', 1]]);
  assert.equal(r.lost.still_open, 1);
  assert.deepEqual([r.money.deposits_cents, r.money.payments_cents, r.money.owed_cents], [13000, 117000, 0]);
  assert.deepEqual([r.quotes.made, r.quotes.booked, r.quotes.booking_rate], [1, 1, 1]);
  assert.equal(r.arrivals.flat().reduce((a, b) => a + b, 0), 4);
  assert.equal(r.trend.unit, 'day');
  assert.equal(r.trend.rows.reduce((n, x) => n + x.leads, 0), 4);
  assert.equal(r.shop.hours_booked, 4);
  assert.equal(r.prev.leads, 0);

  // Just the RV board: Cy only, and no ad spend (it isn't split by board).
  const rv = (await call('GET', `/api/analytics?${q}&pipeline=rv`, undefined, ADMIN)).data;
  assert.deepEqual([rv.kpis.leads, rv.kpis.booked, rv.kpis.ad_spend_cents], [1, 0, null]);
  assert.equal(rv.sources.some((s) => s.spend_cents), false);
});
