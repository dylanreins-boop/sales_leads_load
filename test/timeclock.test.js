const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createTimeService } = require('../src/timeclock');
const { createUserService } = require('../src/users');
const ShopTime = require('../public/shop-time');

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
const ADMIN = auth('Dylan', 'admin-pass');
const SAM = auth('Sam', 'sales-pass');
const MIKE = auth('Mike', 'shop-pass');
async function call(method, url, body, a = ADMIN) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('sales and shop clock in and out; clocking in twice keeps the first punch', async () => {
  assert.equal((await call('GET', '/api/clock', undefined, SAM)).data.on_clock, false);
  const on = (await call('POST', '/api/clock/in', undefined, SAM)).data;
  assert.equal(on.on_clock, true);
  assert.ok(on.clock_in);
  assert.equal((await call('POST', '/api/clock/in', undefined, SAM)).data.clock_in, on.clock_in);
  assert.equal((await call('POST', '/api/clock/in', undefined, MIKE)).data.on_clock, true, 'shop logins use the clock too');
  const off = (await call('POST', '/api/clock/out', undefined, SAM)).data;
  assert.equal(off.on_clock, false);
  assert.match((await call('POST', '/api/clock/out', undefined, SAM)).data.error, /not on the clock/);
  await call('POST', '/api/clock/out', undefined, MIKE);
});

test('time off: people ask, admins approve or deny, and approved days show on the calendar', async () => {
  const ask = await call('POST', '/api/time-off', { start_date: '2026-11-09', end_date: '2026-11-09', kind: 'vacation', note: 'Family' }, MIKE);
  assert.equal(ask.status, 201);
  assert.equal(ask.data.status, 'pending');
  assert.equal(ask.data.hours, 8, 'one open day at the shop\'s 8 hours');
  assert.match((await call('POST', '/api/time-off', { start_date: '2026-11-08', end_date: '2026-11-10' }, MIKE)).data.error, /already have time off/);
  assert.match((await call('POST', '/api/time-off', { start_date: '2026-11-12', end_date: '2026-11-10' }, MIKE)).data.error, /before the first/);

  const weekend = (await call('POST', '/api/time-off', { start_date: '2026-11-14', end_date: '2026-11-15', kind: 'sick' }, SAM)).data;
  assert.equal(weekend.hours, 0, 'closed days don\'t count');
  assert.equal((await call('DELETE', `/api/time-off/${weekend.id}`, undefined, MIKE)).status, 403, 'not Mike\'s request');
  assert.equal((await call('DELETE', `/api/time-off/${weekend.id}`, undefined, SAM)).data.status, 'cancelled');

  assert.equal((await call('PATCH', `/api/time-off/${ask.data.id}`, { status: 'approved' }, SAM)).status, 403, 'only admins approve');
  assert.equal((await call('GET', '/api/time-off?status=pending', undefined, MIKE)).status, 403);
  assert.deepEqual((await call('GET', '/api/time-off?status=pending')).data.map((r) => r.user_name), ['Mike']);
  assert.deepEqual((await call('GET', '/api/time-off/calendar?from=2026-11-01&to=2026-12-01', undefined, SAM)).data, [], 'not on the calendar until approved');

  const ok = (await call('PATCH', `/api/time-off/${ask.data.id}`, { status: 'approved' })).data;
  assert.equal(ok.status, 'approved');
  assert.equal(ok.decided_by, 'Dylan');
  const cal = (await call('GET', '/api/time-off/calendar?from=2026-11-01&to=2026-12-01', undefined, SAM)).data;
  assert.deepEqual(cal.map((r) => [r.user_name, r.start_date, r.kind_label]), [['Mike', '2026-11-09', 'Vacation']]);
  assert.equal(cal[0].note, undefined, 'sales see who is off, not the request notes');
  const adminCal = (await call('GET', '/api/time-off/calendar?from=2026-11-01&to=2026-12-01')).data;
  assert.equal(adminCal[0].note, 'Family');
  assert.equal(adminCal[0].decided_by, 'Dylan');
  assert.match((await call('DELETE', `/api/time-off/${ask.data.id}`, undefined, MIKE)).data.error, /already been decided/);

  const denied = (await call('POST', '/api/time-off', { start_date: '2026-11-20', kind: 'personal' }, SAM)).data;
  assert.equal((await call('PATCH', `/api/time-off/${denied.id}`, { status: 'denied', note: 'Short-staffed' })).data.decision_note, 'Short-staffed');
  assert.ok((await call('GET', '/api/clock', undefined, SAM)).data.time_off.some((r) => r.status === 'denied'), 'they see the answer');
});

test('Time & Pay adds up regular, overtime and paid time off at each hourly rate', async () => {
  assert.equal((await call('PUT', '/api/pay-rates', { user_name: 'Mike', rate: '20' }, SAM)).status, 403);
  assert.equal((await call('GET', '/api/payroll?from=2026-11-01&to=2026-11-14', undefined, MIKE)).status, 403, 'shop never sees pay');
  assert.match((await call('PUT', '/api/pay-rates', { user_name: 'Mike', rate: 'lots' })).data.error, /hourly rate/);
  assert.equal((await call('PUT', '/api/pay-rates', { user_name: 'Mike', rate: '$20.00' })).data.rate_cents, 2000);

  // Mike works 9 hours Monday to Friday (45 hours: 5 over 40) the week of Nov 1.
  for (const day of [2, 3, 4, 5, 6]) {
    const r = await call('POST', '/api/time/punches', { user_name: 'Mike', clock_in: `2026-11-0${day}T07:30`, clock_out: `2026-11-0${day}T16:30` });
    assert.equal(r.status, 201);
  }
  // And 6 hours on Tuesday the 10th, which we fix to 7 after the fact.
  const tue = (await call('POST', '/api/time/punches', { user_name: 'Mike', clock_in: '2026-11-10T08:00', clock_out: '2026-11-10T14:00' })).data;
  assert.equal((await call('PATCH', `/api/time/punches/${tue.id}`, { clock_out: '2026-11-10T15:00', note: 'Forgot to clock out' })).data.edited_by, 'Dylan');
  assert.match((await call('POST', '/api/time/punches', { user_name: 'Mike', clock_in: '2026-11-11T15:00', clock_out: '2026-11-11T09:00' })).data.error, /after clock-in/);

  await call('POST', '/api/time/punches', { user_name: 'Sam', clock_in: '2026-11-03T09:00', clock_out: '2026-11-03T13:00' });
  const report = (await call('GET', '/api/payroll?from=2026-11-01&to=2026-11-14')).data;
  const mike = report.rows.find((r) => r.name === 'Mike');
  assert.equal(mike.regular_hours, 47);
  assert.equal(mike.overtime_hours, 5);
  assert.equal(mike.pto_hours, 8, 'the approved vacation day');
  assert.equal(mike.rate_cents, 2000);
  assert.equal(mike.gross_cents, 47 * 2000 + 5 * 3000 + 8 * 2000);
  assert.equal(mike.punches.length, 7, 'the clock-in test punch plus the six added');
  const sam = report.rows.find((r) => r.name === 'Sam');
  assert.equal(sam.rate_cents, null);
  assert.ok(sam.regular_hours >= 4);
  assert.equal(sam.gross_cents, null);
  assert.ok(!report.rows.some((r) => r.name === 'Dylan'), 'admins aren\'t listed unless they clock in');
  assert.equal(report.totals.gross_cents, mike.gross_cents);
  assert.equal(report.totals.missing_rates, 1, 'Sam worked without a rate');

  // Overtime after 45 hours instead, at double time; sick days unpaid.
  await call('PUT', '/api/payroll/settings', { ot_weekly_hours: 45, ot_multiplier: 2, paid_kinds: ['sick'] });
  const after = (await call('GET', '/api/payroll?from=2026-11-01&to=2026-11-14')).data.rows.find((r) => r.name === 'Mike');
  assert.equal(after.overtime_hours, 0);
  assert.equal(after.pto_hours, 0);
  assert.equal(after.unpaid_off_hours, 8);
  assert.equal(after.gross_cents, 52 * 2000);

  // Daily overtime after 8 hours: Mike's 9-hour days are 1 hour over each.
  await call('PUT', '/api/payroll/settings', { ot_weekly_hours: 40, ot_daily_hours: 8, ot_multiplier: 1.5 });
  const daily = (await call('GET', '/api/payroll?from=2026-11-01&to=2026-11-07')).data.rows.find((r) => r.name === 'Mike');
  assert.deepEqual([daily.regular_hours, daily.overtime_hours], [40, 5]);
  await call('POST', '/api/time/punches', { user_name: 'Mike', clock_in: '2026-11-07T08:00', clock_out: '2026-11-07T12:00' });
  const sat = (await call('GET', '/api/payroll?from=2026-11-01&to=2026-11-07')).data.rows.find((r) => r.name === 'Mike');
  assert.deepEqual([sat.regular_hours, sat.overtime_hours], [40, 9], 'Saturday\'s 4 hours go over the 40 regular');
  assert.match((await call('PUT', '/api/payroll/settings', { ot_daily_hours: 30 })).data.error, /Daily overtime/);

  assert.equal((await call('DELETE', `/api/time/punches/${tue.id}`)).data.ok, true);
});

test('a punch left open overnight closes at the end of that shop day and is flagged', () => {
  const mem = openDatabase(':memory:');
  const users = createUserService(mem, { serverUsers: [{ name: 'Mike', role: 'shop' }] });
  const shop = ShopTime.settingsOf({});
  const time = createTimeService(mem, { users, getShopHours: () => shop });
  time.clockIn('Mike', { at: new Date(2026, 10, 9, 8, 5) });
  const next = time.status('Mike', new Date(2026, 10, 10, 7, 0));
  assert.equal(next.on_clock, false);
  const p = mem.prepare('SELECT * FROM time_punches').get();
  assert.equal(new Date(p.clock_out).getTime(), new Date(2026, 10, 9, 16, 0).getTime());
  assert.equal(p.auto_closed, 1);
  time.clockIn('Mike', { at: new Date(2026, 10, 11, 8, 0) });
  time.clockIn('Mike', { at: new Date(2026, 10, 12, 8, 0) });
  assert.equal(mem.prepare('SELECT COUNT(*) AS n FROM time_punches').get().n, 3, 'a new day starts a new punch');
  const pay = time.payroll({ from: '2026-11-09', to: '2026-11-09', at: new Date(2026, 10, 10) });
  assert.equal(pay.rows[0].flagged, 1);
  assert.equal(pay.rows[0].regular_hours, 7.92);
});
