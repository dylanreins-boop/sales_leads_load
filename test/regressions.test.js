// Bugs found by clicking through the whole app, kept fixed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Mike:shop-pass:shop';
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
async function call(method, url, body, a = auth('Dylan', 'admin-pass')) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function bookedJob() {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Tyler Grant', phone: '702-555-0144', vehicle_type: 'Truck' })).data;
  const day = new Date(); day.setDate(day.getDate() + ((8 - day.getDay()) % 7 || 7)); // next Monday
  const start = new Date(day); start.setHours(9, 0, 0, 0);
  const end = new Date(day); end.setHours(13, 0, 0, 0);
  const r = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: start.toISOString(), job_end: end.toISOString(), send_confirmation: false });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  const jobs = (await call('GET', `/api/jobs?from=${new Date(day.getTime() - 86400000).toISOString()}&to=${new Date(day.getTime() + 2 * 86400000).toISOString()}`)).data;
  return jobs.find((j) => j.lead_id === lead.id);
}

test('a cancelled job can still be changed (it used to fail with "Server error")', async () => {
  const job = await bookedJob();
  const cancelled = await call('PATCH', `/api/jobs/${job.id}`, { status: 'cancelled' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  const again = await call('PATCH', `/api/jobs/${job.id}`, { notes: 'Customer will call back' }, auth('Mike', 'shop-pass'));
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal((await call('GET', `/api/jobs/${job.id}`)).status, 200);
  assert.equal((await call('PATCH', `/api/jobs/${job.id}`, { status: 'scheduled' })).status, 200);
});

test('clearing a sign-off answers with the whole job, so the job panel can redraw', async () => {
  const job = await bookedJob();
  const r = await call('DELETE', `/api/jobs/${job.id}/signoff`);
  assert.equal(r.status, 200);
  assert.ok(r.data.work, 'work time is there');
  assert.ok(r.data.shop_time, 'shop time is there');
  assert.equal(r.data.signoff_at, null);
});
