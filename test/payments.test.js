const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SAM = auth('Sam', 'sales-pass');
const SHOP = auth('Mike', 'shop-pass');
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

async function book(amount, extra = {}) {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Pay Test', phone: `702-555-${Math.floor(1000 + Math.random() * 8999)}`, vehicle_type: 'Car' })).data;
  const r = await call('POST', `/api/leads/${lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: '2026-12-01T16:00:00Z', job_hours: 4, job_amount: amount, send_confirmation: false, ...extra,
  });
  return r.data;
}

test('the balance is the job amount less the deposit and payments; refunds add back', async () => {
  const { job, lead } = await book('1300', { deposit_taken: true, deposit_method: 'Card' });
  const j = lead.jobs[0];
  assert.deepEqual([j.amount_paid_cents, j.amount_due_cents], [13000, 117000], 'the 10% deposit counts as paid');

  const part = (await call('POST', `/api/jobs/${job.id}/payments`, { amount: '1000', method: 'Cash', note: 'at drop-off' })).data;
  assert.deepEqual([part.amount_paid_cents, part.amount_due_cents], [113000, 17000]);
  const rest = (await call('POST', `/api/jobs/${job.id}/payments`, { method: 'Card' })).data;
  assert.equal(rest.amount_due_cents, 0, 'blank amount = the balance');
  assert.equal(rest.amount_payments.length, 2);
  const refund = (await call('POST', `/api/jobs/${job.id}/payments`, { amount: '50', method: 'Card', kind: 'refund' })).data;
  assert.equal(refund.amount_due_cents, 5000);

  const fresh = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.ok(fresh.activities.some((a) => a.type === 'payment' && a.note === 'Payment: $1,000.00 (Cash) at drop-off · balance $170.00' && a.user_name === 'Sam'));
  assert.equal((await call('POST', `/api/jobs/${job.id}/payments`, { amount: '10', method: 'Bitcoin' })).status, 400);
  assert.equal((await call('POST', `/api/jobs/${job.id}/payments`, { amount: '10', method: 'Cash' }, SHOP)).status, 403);
  const shopView = (await call('GET', `/api/jobs/${job.id}`, undefined, SHOP)).data;
  assert.ok(!Object.keys(shopView).some((k) => /^(amount|deposit|commission)_/.test(k)), 'the shop never sees money');

  // Admins remove a payment entered by mistake.
  assert.equal((await call('DELETE', `/api/payments/${refund.amount_payments[2].id}`)).status, 403);
  assert.equal((await call('DELETE', `/api/payments/${refund.amount_payments[2].id}`, undefined, ADMIN)).data.amount_due_cents, 0);
});

test('admins see ready and picked-up jobs that still owe money', async () => {
  const { job } = await book('1700');
  assert.ok(!(await call('GET', '/api/payments/owed', undefined, ADMIN)).data.some((j) => j.id === job.id), 'scheduled jobs are not listed yet');
  await call('PATCH', `/api/jobs/${job.id}`, { status: 'ready' }, SHOP);
  const owed = (await call('GET', '/api/payments/owed', undefined, ADMIN)).data.find((j) => j.id === job.id);
  assert.equal(owed.amount_due_cents, 170000);
  assert.equal((await call('GET', '/api/payments/owed')).status, 403);
  await call('POST', `/api/jobs/${job.id}/payments`, { method: 'Zelle' });
  assert.ok(!(await call('GET', '/api/payments/owed', undefined, ADMIN)).data.some((j) => j.id === job.id), 'paid in full drops off');
});
