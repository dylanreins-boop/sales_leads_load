const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.STRIPE_SECRET_KEY = 'sk_test_123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.PUBLIC_URL = 'https://leads.example.com';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.EMAIL_PROVIDER = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { formEncode, verifyStripeSignature } = require('../src/stripe');

// Pretend Stripe: Checkout sessions that can be marked paid.
const sessions = new Map();
async function fakeFetch(url, options = {}) {
  if (url === 'https://api.stripe.com/v1/checkout/sessions') {
    const form = new URLSearchParams(options.body);
    const id = `cs_${sessions.size + 1}`;
    sessions.set(id, {
      id, url: `https://checkout.stripe.com/pay/${id}`, payment_status: 'unpaid',
      amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
      metadata: { booking_link: form.get('metadata[booking_link]'), job_id: form.get('metadata[job_id]') },
      success_url: form.get('success_url'),
    });
    return new Response(JSON.stringify(sessions.get(id)), { status: 200 });
  }
  const m = url.match(/checkout\/sessions\/(cs_\d+)$/);
  if (m) return new Response(JSON.stringify(sessions.get(m[1])), { status: 200 });
  return new Response('{}', { status: 200 });
}

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: fakeFetch }));
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
  assert.equal(view.pay_online, true);
  assert.ok(view.days.length > 15, 'weeks of open days');
  assert.ok(view.days.every((d) => ![0, 6].includes(new Date(d.drop_off).getDay())), 'weekdays only');
  assert.ok(view.days.every((d) => new Date(d.drop_off).getHours() === 8), 'drop-off at opening time');
  assert.equal((await call('GET', '/api/public/booking/not-a-real-token', undefined, null)).status, 404);
  assert.equal((await call('POST', `/api/leads/${lead.id}/booking-links`, {}, SHOP)).status, 403);
});

test('full days are not offered; booking puts the job on the calendar for the rep, then the deposit is paid by card', async () => {
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
  assert.match(booked.data.redirect, /^https:\/\/checkout\.stripe\.com\/pay\/cs_\d+$/);
  const sessionId = booked.data.redirect.split('/').pop();
  assert.equal(sessions.get(sessionId).amount_total, 13000);
  assert.equal(sessions.get(sessionId).success_url, `https://leads.example.com/book/${link.token}?paid={CHECKOUT_SESSION_ID}`);

  const fresh = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.equal(fresh.stage, 'booked');
  const job = fresh.jobs[0];
  assert.equal(job.start_at, day.drop_off);
  assert.equal(job.created_by, 'Sam', 'the rep who sent the link booked it');
  assert.equal(job.commission_rep, 'Sam');
  assert.equal(job.amount_cents, 130000);
  assert.equal(job.deposit_cents, null);
  assert.equal((await call('POST', `/api/public/booking/${link.token}`, { date: day.date }, null)).status, 400, 'one booking per link');

  // Back from Stripe before paying: nothing recorded. After paying: the deposit shows.
  await call('GET', `/api/public/booking/${link.token}?paid=${sessionId}`, undefined, null);
  assert.equal((await call('GET', `/api/leads/${lead.id}`)).data.jobs[0].deposit_cents, null);
  sessions.get(sessionId).payment_status = 'paid';
  const paidView = (await call('GET', `/api/public/booking/${link.token}?paid=${sessionId}`, undefined, null)).data;
  assert.equal(paidView.status, 'booked');
  assert.equal(paidView.deposit_paid, true);
  assert.equal(paidView.pay_online, false);
  const paidJob = (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
  assert.deepEqual([paidJob.deposit_cents, paidJob.deposit_method, paidJob.deposit_by], [13000, 'Card', 'Online payment']);
});

test('the Stripe webhook records the deposit when its signature checks out', async () => {
  const lead = await leadWithQuote();
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, { amount: '1700' })).data;
  const day = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data.days[3];
  await call('POST', `/api/public/booking/${link.token}`, { date: day.date }, null);
  const event = JSON.stringify({ type: 'checkout.session.completed', data: { object: { payment_status: 'paid', amount_total: 17000, metadata: { booking_link: String(link.id) } } } });
  const t = Math.floor(Date.now() / 1000);
  const sign = (body, secret = 'whsec_test') => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const post = (body, signature) => fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body });
  assert.equal((await post(event, sign(event, 'wrong'))).status, 400);
  const ok = await post(event, sign(event));
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).recorded, true);
  assert.equal((await call('GET', `/api/leads/${lead.id}`)).data.jobs[0].deposit_cents, 17000);
  assert.equal((await (await post(event, sign(event))).json()).recorded, false, 'only once');
});

test('reps can turn a link off; Stripe helpers encode and verify', async () => {
  const lead = await leadWithQuote();
  const { link } = (await call('POST', `/api/leads/${lead.id}/booking-links`, {})).data;
  assert.equal((await call('POST', `/api/booking-links/${link.id}/cancel`)).data.status, 'cancelled');
  const view = (await call('GET', `/api/public/booking/${link.token}`, undefined, null)).data;
  assert.deepEqual([view.status, view.days], ['cancelled', []]);
  assert.equal(formEncode({ a: { b: [{ c: 1 }] }, d: 'x y' }).toString(), 'a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x+y');
  assert.equal(verifyStripeSignature('{}', 't=1,v1=00', 'whsec'), false, 'too old');
});
