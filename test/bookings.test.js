const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.PUBLIC_URL = 'https://leads.example.com';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.EMAIL_PROVIDER = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: async () => new Response('{}', { status: 200 }) }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const SAM = login('Sam', 'sales-pass');
const SHOP = login('Mike', 'shop-pass');
async function call(method, url, body, auth = SAM) {
  const headers = { 'Content-Type': 'application/json', ...(auth && { Authorization: auth }) };
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let n = 0;
async function leadWithQuote(type = 'Car') {
  n += 1;
  const { lead } = (await call('POST', '/api/leads', { first_name: 'Ana', last_name: `Cruz ${n}`, phone: `702-555-${String(5000 + n)}`, vehicle_type: type, vehicle_year: '2023', vehicle_make: 'Tesla', vehicle_model: 'Model 3' })).data;
  await call('POST', `/api/leads/${lead.id}/quotes`, { base: 'pkg1300' });
  return lead;
}

test('a rep makes a booking link from the quote; the customer sees the price and open days', async () => {
  const lead = await leadWithQuote();
  const made = await call('POST', `/api/leads/${lead.id}/booking-links`, { services: ['full_decon_coat'] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const { link } = made.data;
  assert.equal(link.amount_cents, 130000, 'from the latest quote');
  assert.equal(link.deposit_cents, 13000, '10% deposit');
  assert.equal(link.work_hours, 4);
  assert.match(link.url, /^https:\/\/leads\.example\.com\/book\/[\w-]{24}$/);
  assert.equal(made.data.lead.booking_links.length, 1);

  const page = await fetch(`${base}/book/${link.token}`);
  assert.equal(page.status, 200, 'the page is public');
  assert.match(await page.text(), /Pick your drop-off day|Book your appointment/);

  const view = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.equal(view.first_name, 'Ana');
  assert.equal(view.vehicle, '2023 Tesla Model 3');
  assert.equal(view.services, 'Full decon & coat');
  assert.equal(view.deposit_cents, 13000, 'shown; paid at the shop');
  assert.equal('pay_online' in view, false, 'no online payment');
  assert.ok(view.days.length > 15, 'weeks of open days');
  assert.ok(view.days.every((d) => ![0, 6].includes(new Date(d.drop_off).getDay())), 'weekdays only');
  assert.ok(view.days.every((d) => new Date(d.drop_off).getHours() === 8), 'drop-off at opening time');
  assert.equal((await call('GET', '/api/public/booking/not-a-real-token', undefined, null)).status, 404);
  assert.equal((await call('POST', `/api/leads/${lead.id}/booking-links`, {}, SHOP)).status, 403);
});

test('full days are not offered; booking puts the job on the calendar for the rep', async () => {
  const lead = await leadWithQuote();
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, {})).data;
  const first = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data.days[0];

  // Fill that day with an 8-hour job: it drops off the list.
  const other = await leadWithQuote();
  await call('POST', `/api/leads/${other.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['wheels'], job_start: first.drop_off, job_hours: 8, send_confirmation: false });
  const after = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.ok(!after.days.some((d) => d.date === first.date), 'a full day is not offered');
  assert.equal((await call('POST', `/api/public/booking/${link.token}`, { date: first.date }, null)).status, 409);

  const day = after.days[0];
  const booked = await call('POST', `/api/public/booking/${link.token}`, { date: day.date }, null);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.deepEqual(booked.data, { booked: true }, 'no card payment page: the deposit is paid at the shop');

  const fresh = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.equal(fresh.stage, 'booked');
  const job = fresh.jobs[0];
  assert.equal(job.start_at, day.drop_off);
  assert.equal(job.created_by, 'Sam', 'the rep who sent the link booked it');
  assert.equal(job.commission_rep, 'Sam');
  assert.equal(job.amount_cents, 130000);
  assert.equal(job.deposit_cents, null);
  assert.equal((await call('POST', `/api/public/booking/${link.token}`, { date: day.date }, null)).status, 400, 'one booking per link');

  // The deposit is taken at the shop and entered on the job by hand; the page then shows it paid.
  await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: true, amount: '130', method: 'Card' }, login('Dylan', 'admin-pass'));
  const paidView = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.equal(paidView.status, 'booked');
  assert.equal(paidView.deposit_paid, true);
});

test('reps can turn a link off', async () => {
  const lead = await leadWithQuote();
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, {})).data;
  assert.equal((await call('POST', `/api/booking-links/${link.id}/cancel`)).data.status, 'cancelled');
  const view = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.deepEqual([view.status, view.days], ['cancelled', []]);
  assert.equal((await call('POST', `/api/public/booking/${link.token}/pay`, {}, null)).status, 404, 'no online payment route');
});

test('a booking sent twice at once (a double tap) makes one job', async () => {
  const lead = await leadWithQuote();
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, {})).data;
  const day = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data.days[0];
  const tries = await Promise.all([1, 2, 3].map(() => call('POST', `/api/public/booking/${link.token}`, { date: day.date }, null)));
  assert.deepEqual(tries.map((t) => t.status).sort(), [201, 400, 400]);
  assert.equal((await call('GET', `/api/leads/${lead.id}`)).data.jobs.length, 1);
});
