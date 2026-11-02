const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
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
async function call(method, url, body, a = ADMIN, raw) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': raw ? 'text/csv' : 'application/json' }, body: raw ?? (body && JSON.stringify(body)) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const day = (n, h = 12) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, 0, 0, 0); return d; };
const us = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;

async function job(name, phone, amount, start) {
  const { lead } = (await call('POST', '/api/leads', { full_name: name, phone, vehicle_type: 'Car' }, SAM)).data;
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: start.toISOString(), job_hours: 4, job_amount: amount, deposit_taken: true, deposit_method: 'Card', send_confirmation: false }, SAM);
  return (await call('GET', `/api/leads/${lead.id}`, undefined, SAM)).data.jobs[0];
}

test('a Talech / Elavon export is matched to jobs, checked, and recorded once', async () => {
  const ana = await job('Ana Cruz', '702-555-0811', '1300', day(-3, 8)); // $130 deposit, $1,170 due
  const bo = await job('Bo Diaz', '702-555-0812', '1700', day(-2, 8)); // $1,530 due
  await job('Cy Long', '702-555-0813', '1530', day(-2, 9)); // also $1,377 due; a different price
  const csv = [
    'Bob Moses Ceramic Coating - Transactions',
    `Date Range: ${us(day(-7))} - ${us(day(0))}`,
    '',
    'Transaction ID,Date,Type,Status,Tender,Cardholder,Card Number,Amount,Tip',
    `T-1001,${us(day(-1, 15))},Sale,Approved,Visa,ANA CRUZ,XXXXXXXXXXXX4242,"$1,170.00",0.00`,
    `T-1002,${us(day(-1, 16))},Sale,Approved,Mastercard,DIAZ/BO,************5555,1530.00,0.00`,
    `T-1003,${us(day(-1, 16))},Sale,Declined,Visa,DIAZ/BO,************5555,1530.00,0.00`,
    `T-1004,${us(day(-1, 17))},Sale,Approved,Cash,,,40.00,0.00`,
    `T-1005,${us(day(-1, 17))},Sale,Approved,Visa,PAT SMITH,************1111,65.00,0.00`,
    `T-1006,${us(day(0, 10))},Refund,Approved,Visa,ANA CRUZ,XXXXXXXXXXXX4242,-50.00,0.00`,
  ].join('\n');

  assert.equal((await call('POST', '/api/card-import/upload?name=talech.csv', null, SAM, csv)).status, 403, 'admins only');
  const up = (await call('POST', '/api/card-import/upload?name=talech.csv', null, ADMIN, csv)).data;
  assert.deepEqual(Object.keys(up.columns).sort(), ['amount', 'date', 'id', 'last4', 'name', 'status', 'tender', 'tip', 'type']);
  assert.deepEqual(up.skipped, { declined: 1, not_card: 1, unreadable: 0 });
  const row = (id) => up.rows.find((r) => r.id === id);
  assert.deepEqual([row('T-1001').status, row('T-1001').job_id, row('T-1001').cents, row('T-1001').last4], ['matched', ana.id, 117000, '4242']);
  assert.deepEqual([row('T-1002').status, row('T-1002').job_id], ['matched', bo.id], 'DIAZ/BO is Bo Diaz');
  assert.equal(row('T-1005').status, 'unmatched', 'not a customer of ours');
  assert.deepEqual([row('T-1006').kind, row('T-1006').cents, row('T-1006').job_id], ['refund', 5000, ana.id]);

  const picks = up.rows.filter((r) => r.job_id).map((r) => ({ ref: r.ref, job_id: r.job_id }));
  const done = (await call('POST', '/api/card-import/commit', { token: up.token, columns: up.columns, picks })).data;
  assert.deepEqual(done, { recorded: 3, cents: 117000 + 153000 - 5000 });
  const anaJob = (await call('GET', `/api/jobs/${ana.id}`)).data;
  assert.equal(anaJob.amount_due_cents, 5000, 'paid the balance, then $50 refunded');
  assert.match(anaJob.amount_payments[0].note, /Card …4242 processor #T-1001/);
  assert.equal(anaJob.amount_payments[0].paid_at, day(-1, 15).toISOString(), 'dated when the card was run');

  // The same export again: nothing new.
  const again = (await call('POST', '/api/card-import/upload?name=talech.csv', null, ADMIN, csv)).data;
  assert.equal(again.summary.recorded, 3);
  assert.equal(again.rows.find((r) => r.id === 'T-1001').status, 'recorded');
});
