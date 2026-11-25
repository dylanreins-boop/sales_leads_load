const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';
process.env.EMAIL_PROVIDER = 'resend';
process.env.EMAIL_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'shop@example.com';
process.env.PUBLIC_URL = 'https://leads.example.com';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const ShopTime = require('../public/shop-time');

const sentEmails = [];
const fakeFetch = async (url, init) => {
  sentEmails.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
};

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: fakeFetch }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SAM = login('Sam', 'sales-pass');
async function call(method, url, body, auth = ADMIN) {
  const res = await fetch(base + url, { method, headers: { ...(auth && { Authorization: auth }), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// A weekday at least a week out, and the weekday before it.
function weekdayAhead(days) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + days);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d;
}
const at = (day, hour) => { const d = new Date(day); d.setHours(hour, 0, 0, 0); return d.toISOString(); };

test('admins add company holidays; nothing can be dropped off or picked up then, and the booking page skips them', async () => {
  const holiday = weekdayAhead(10);
  const key = ShopTime.dayKey(holiday);
  assert.equal((await call('POST', '/api/holidays', { name: 'Test Day', date: key }, SAM)).status, 403, 'admins only');
  assert.match((await call('POST', '/api/holidays', { name: 'Bad', date: 'soon' })).data.error, /date/);
  const added = await call('POST', '/api/holidays', { name: 'Test Day', date: key });
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.added, [key]);
  assert.deepEqual(added.data.shop_hours.holidays.map((x) => [x.date, x.name]), [[key, 'Test Day']]);
  assert.equal((await call('GET', '/api/holidays', undefined, SAM)).data.holidays.length, 1, 'everyone sees them');

  // Booking a drop-off on the holiday is refused.
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Holly Day', phone: '702-555-0606', email: 'holly@example.com', vehicle_type: 'Car' })).data;
  const refused = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: at(holiday, 9), job_hours: 4, send_confirmation: false });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /closed .* for Test Day\. Pick another drop-off day/);

  // The day before is fine; moving the pick-up onto the holiday isn't.
  const before = new Date(holiday); before.setDate(before.getDate() - 1);
  while ([0, 6].includes(before.getDay())) before.setDate(before.getDate() - 1);
  const ok = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: at(before, 9), job_end: at(before, 15), send_confirmation: false });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const job = (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
  const moved = await call('PATCH', `/api/jobs/${job.id}`, { end_at: at(holiday, 15) });
  assert.equal(moved.status, 409);
  assert.match(moved.data.error, /Pick another pick-up day/);

  // The online booking page doesn't offer the holiday.
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, { services: ['full_decon_coat'], amount: '1300' })).data;
  const view = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.ok(view.days.length > 5);
  assert.ok(!view.days.some((d) => ShopTime.dayKey(d.drop_off) === key), 'the holiday is not offered');

  // A holiday over a day that already has a job says so, and a range adds each day.
  const span = await call('POST', '/api/holidays', { name: 'Shop trip', date: ShopTime.dayKey(before), end_date: key });
  assert.equal(span.data.booked.length, 1, 'the job already booked that day');
  assert.equal(span.data.booked[0].name, 'Holly Day');
  assert.equal(span.data.holidays.find((x) => x.date === key).name, 'Shop trip', 'the newer name wins');
  assert.match((await call('POST', '/api/holidays', { name: 'Long', date: key, end_date: ShopTime.dayKey(weekdayAhead(60)) })).data.error, /31 days/);

  // Removing them opens the days again.
  for (const x of span.data.holidays) assert.equal((await call('DELETE', `/api/holidays/${x.date}`)).status, 200);
  assert.equal((await call('GET', '/api/holidays')).data.holidays.length, 0);
  assert.equal((await call('PATCH', `/api/jobs/${job.id}`, { end_at: at(holiday, 15) })).status, 200);
  const log = (await call('GET', '/api/audit?area=settings')).data;
  assert.ok(log.some((r) => r.action === `Added the company holiday Test Day: ${key}`));
});

test('admins email the booking confirmation from the job', async () => {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Rae Mail', phone: '702-555-0707', email: 'rae@example.com', vehicle_type: 'Car' })).data;
  const day = weekdayAhead(20);
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: at(day, 9), job_hours: 4, send_confirmation: false });
  const job = (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
  assert.equal((await call('POST', `/api/jobs/${job.id}/confirmation-email`, {}, SAM)).status, 403, 'admins only');
  assert.match((await call('POST', `/api/jobs/${job.id}/confirmation-email`, { to: 'not-an-email' })).data.error, /email address/);

  sentEmails.length = 0;
  const sent = await call('POST', `/api/jobs/${job.id}/confirmation-email`, {});
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.sent_to, 'rae@example.com');
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0].body.to, ['rae@example.com']);
  assert.match(sentEmails[0].body.text, /Rae/);
  const again = await call('POST', `/api/jobs/${job.id}/confirmation-email`, { to: 'other@example.com' });
  assert.equal(again.data.sent_to, 'other@example.com', 'or to another address');
  const emails = (await call('GET', `/api/leads/${lead.id}`)).data.emails;
  assert.equal(emails.filter((e) => e.label === 'Booking confirmation' || e.subject).length >= 2, true);
  assert.ok((await call('GET', `/api/jobs/${job.id}`)).data.confirm_sent_at, 'when it was last sent shows on the job');
});
