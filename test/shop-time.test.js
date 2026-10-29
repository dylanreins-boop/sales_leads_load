const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// The shop is in Las Vegas; its days are counted in that time zone.
process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const ShopTime = require('../public/shop-time');

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
const SHOP = login('Mike', 'shop-pass');
async function call(method, url, body, auth = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

// Local Las Vegas time -> ISO, e.g. at('2026-11-10', 8) is Tue Nov 10, 8 AM.
const at = (day, hour, minute = 0) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour, minute).toISOString(); };

let n = 0;
async function book(vehicleType, { start, end, hours } = {}) {
  n += 1;
  const { lead } = (await call('POST', '/api/leads', { full_name: `Customer ${n}`, phone: `702-555-${String(7000 + n)}`, vehicle_type: vehicleType })).data;
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: start, job_end: end, job_hours: hours,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('work time fills the shop day: 8 to 4, Monday to Friday', () => {
  assert.equal(ShopTime.finishAt(at('2026-11-10', 8), 4).toISOString(), at('2026-11-10', 12), 'a car takes about 4 hours');
  assert.equal(ShopTime.finishAt(at('2026-11-10', 13), 4).toISOString(), at('2026-11-11', 9), 'runs into the next morning');
  assert.equal(ShopTime.finishAt(at('2026-11-13', 8), 16).toISOString(), at('2026-11-16', 16), 'a 2-day trailer on Friday finishes Monday; weekends are off');
  const { days } = ShopTime.allocate(at('2026-11-13', 8), at('2026-11-16', 16), 16);
  assert.deepEqual(days.map((d) => [d.date, d.hours]), [['2026-11-13', 8], ['2026-11-16', 8]]);
  assert.equal(ShopTime.label(24), '3 days');
  assert.equal(ShopTime.defaultHours('rv'), 16);
  assert.equal(ShopTime.defaultHours('other'), 4);
});

test('bookings get a work time: cars 4 hours by default, trailers by the day, and pick-up can be worked out', async () => {
  const car = await book('Car', { start: at('2026-11-02', 8), end: at('2026-11-02', 12) });
  assert.equal(car.job.work_hours, 4);
  assert.deepEqual(car.shop_time.warnings, []);
  assert.ok(car.lead.activities.some((a) => /4 hours of work/.test(a.note)));

  const trailer = await book('Trailer / Toy Hauler', { start: at('2026-11-03', 8), hours: 24 });
  assert.equal(trailer.job.work_hours, 24);
  assert.equal(trailer.job.end_at, at('2026-11-05', 16), 'three shop days: Tue, Wed, Thu');

  const rv = await book('Coach / RV', { start: at('2026-11-23', 8), end: at('2026-11-24', 16) });
  assert.equal(rv.job.work_hours, 16, 'RVs default to 2 days');
  assert.equal((await call('POST', `/api/leads/${rv.lead.id}/disposition`, { disposition: 'booked', note: 'x', services: ['wheels'], job_start: at('2026-11-23', 8), job_hours: 'lots' })).status, 400);
});

test('warns when a day goes over 8 hours, a job lands on a weekend, or pick-up is too soon', async () => {
  const first = await book('Car', { start: at('2026-11-10', 8), end: at('2026-11-10', 12) });
  assert.deepEqual(first.shop_time.warnings, []);
  const second = await book('SUV', { start: at('2026-11-10', 12), end: at('2026-11-10', 16) });
  assert.deepEqual(second.shop_time.warnings, [], '4 + 4 = 8 hours is a full day, not over');
  assert.equal(second.shop_time.days[0].booked, 8);

  // A third car the same day: 12 hours booked.
  const check = (await call('GET', `/api/jobs/capacity?start=${at('2026-11-10', 8)}&end=${at('2026-11-10', 12)}&hours=4`)).data;
  assert.equal(check.days[0].booked, 12);
  const over = check.warnings.find((w) => w.type === 'over');
  assert.ok(over, JSON.stringify(check));
  assert.match(over.text, /^Tue, Nov 10 would have 12 hrs of work booked; the shop works 8 hrs a day\. Already booked: Customer \d+ \(4 hrs\), Customer \d+ \(4 hrs\)\.$/);
  const third = await book('Truck', { start: at('2026-11-10', 8), end: at('2026-11-10', 12) });
  assert.equal(third.shop_time.warnings[0].type, 'over', 'it still books; it just warns');

  const weekend = (await call('GET', `/api/jobs/capacity?start=${at('2026-11-14', 9)}&end=${at('2026-11-14', 13)}&hours=4`)).data;
  assert.match(weekend.warnings[0].text, /Drop-off is on a Saturday\. The shop is closed that day\./);

  const tooSoon = (await call('GET', `/api/jobs/capacity?start=${at('2026-11-17', 8)}&end=${at('2026-11-17', 16)}&hours=24&pipeline=rv`)).data;
  const short = tooSoon.warnings.find((w) => w.type === 'short');
  assert.match(short.text, /3 days of work only gets 8 hrs of shop time by then\. Earliest pick-up: Thu, Nov 19, 4:00 PM\./);
});

test('moving a job or changing its work time is checked too; cancelled jobs free the day', async () => {
  const a = await book('Car', { start: at('2026-12-01', 8), end: at('2026-12-01', 12) });
  const b = await book('Car', { start: at('2026-12-02', 8), end: at('2026-12-02', 12) });
  const longer = await call('PATCH', `/api/jobs/${a.job.id}`, { work_hours: 10, end_at: at('2026-12-02', 10) }, SHOP);
  assert.equal(longer.status, 200, JSON.stringify(longer.data));
  assert.equal(longer.data.work_hours, 10);
  assert.deepEqual(longer.data.shop_time.warnings, [], '8 on Tuesday, then 2 more next to a 4-hour car on Wednesday');
  assert.deepEqual(longer.data.shop_time.days.map((d) => [d.date, d.hours, d.booked]), [['2026-12-01', 8, 8], ['2026-12-02', 2, 6]]);
  assert.equal((await call('PATCH', `/api/jobs/${a.job.id}`, { work_hours: 10 }, SAM)).status, 403, 'sales can only look');

  await call('PATCH', `/api/jobs/${a.job.id}`, { work_hours: 8, end_at: at('2026-12-01', 16) }, SHOP);
  const moved = (await call('PATCH', `/api/jobs/${b.job.id}`, { start_at: at('2026-12-01', 12), end_at: at('2026-12-01', 16) }, SHOP)).data;
  assert.equal(moved.shop_time.warnings[0].type, 'over');
  const cancelled = (await call('PATCH', `/api/jobs/${a.job.id}`, { status: 'cancelled' }, SHOP)).data;
  assert.deepEqual(cancelled.shop_time.warnings, []);
  const freed = (await call('GET', `/api/jobs/capacity?start=${at('2026-12-01', 12)}&end=${at('2026-12-01', 16)}&hours=4&job=${b.job.id}`)).data;
  assert.equal(freed.days[0].booked, 4, 'cancelled jobs don\'t count');
});

test('admins set the shop hours', async () => {
  assert.deepEqual((await call('GET', '/api/settings/shop-hours', undefined, SHOP)).data, ShopTime.DEFAULTS);
  assert.equal((await call('PUT', '/api/settings/shop-hours', { hours_per_day: 10 })).status, 403);
  assert.equal((await call('PUT', '/api/settings/shop-hours', { work_days: [] }, ADMIN)).status, 400);
  assert.equal((await call('PUT', '/api/settings/shop-hours', { open: '20:00', hours_per_day: 10 }, ADMIN)).status, 400);
  const saved = (await call('PUT', '/api/settings/shop-hours', { open: '07:00', hours_per_day: 10, work_days: [1, 2, 3, 4, 5, 6] }, ADMIN)).data;
  assert.deepEqual([saved.open, saved.hours_per_day, saved.work_days], ['07:00', 10, [1, 2, 3, 4, 5, 6]]);
  const sat = (await call('GET', `/api/jobs/capacity?start=${at('2027-01-09', 7)}&end=${at('2027-01-09', 17)}&hours=10`)).data;
  assert.deepEqual(sat.warnings, [], 'Saturdays are open now, 10 hours a day');
  assert.equal((await call('GET', '/api/meta')).data.shopHours.hours_per_day, 10);
  await call('PUT', '/api/settings/shop-hours', ShopTime.DEFAULTS, ADMIN);
});
