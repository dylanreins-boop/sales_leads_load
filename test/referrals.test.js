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
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { ...(a && { Authorization: a }), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('a past customer\'s link brings in a lead credited to them; admins see it and mark the thank-you', async () => {
  const { lead: ana } = (await call('POST', '/api/leads', { full_name: 'Ana Cruz', phone: '702-555-0301', vehicle_type: 'Car' })).data;
  await call('POST', `/api/leads/${ana.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: '2026-12-01T16:00:00Z', job_hours: 4, job_amount: '1300', send_confirmation: false });
  const link = (await call('POST', `/api/leads/${ana.id}/referral-link`, {})).data;
  assert.match(link.url, /\/r\/[a-z2-9]{7}$/);
  assert.equal(link.lead.referral_code, link.code);
  assert.equal((await call('POST', `/api/leads/${ana.id}/referral-link`, {})).data.code, link.code, 'one link per customer');

  const page = await fetch(`${base}/r/${link.code}`);
  assert.equal(page.status, 200, 'the page is public');
  const view = (await call('GET', `/api/public/referral/${link.code}`, undefined, null)).data;
  assert.deepEqual([view.kind, view.from], ['customer', 'Ana']);
  assert.ok(view.vehicleTypes.includes('Car'));

  assert.equal((await call('POST', `/api/public/referral/${link.code}`, { first_name: 'Bo' }, null)).status, 400, 'needs a way to reach them');
  const sent = await call('POST', `/api/public/referral/${link.code}`, { first_name: 'Bo', last_name: 'Diaz', phone: '702-555-0302', vehicle: '2022 Tesla Model Y', sms_opt_in: true }, null);
  assert.equal(sent.status, 201);
  const bo = (await call('GET', '/api/leads?q=Diaz')).data[0];
  assert.deepEqual([bo.source, bo.vehicle_year, bo.vehicle_make, bo.vehicle_model, bo.sms_opt_in], ['referral', '2022', 'Tesla', 'Model Y', 1]);
  const boFull = (await call('GET', `/api/leads/${bo.id}`)).data;
  assert.deepEqual(boFull.referred_by, { name: 'Ana Cruz', kind: 'customer' });
  assert.ok((await call('GET', `/api/leads/${ana.id}`)).data.activities.some((a) => a.note === 'Referred Bo Diaz'));
  assert.equal((await call('POST', `/api/public/referral/${link.code}`, { first_name: 'Spam', phone: '702-555-0399', _gotcha: 'x' }, null)).status, 201);
  assert.equal((await call('GET', '/api/leads?q=0399')).data.length, 0, 'bots are ignored');

  // Bo books: Ana is due a thank-you.
  await call('POST', `/api/leads/${bo.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: '2026-12-02T16:00:00Z', job_hours: 4, job_amount: '1700', send_confirmation: false });
  assert.equal((await call('GET', '/api/referrals')).status, 403);
  let report = (await call('GET', '/api/referrals', undefined, ADMIN)).data;
  const anaRow = report.customers.find((c) => c.name === 'Ana Cruz');
  assert.deepEqual([anaRow.leads, anaRow.booked, anaRow.revenue_cents, anaRow.to_thank], [1, 1, 170000, 1]);
  await call('POST', `/api/leads/${bo.id}/referral-reward`, { rewarded: true }, ADMIN);
  report = (await call('GET', '/api/referrals', undefined, ADMIN)).data;
  assert.equal(report.customers.find((c) => c.name === 'Ana Cruz').to_thank, 0);
  assert.equal(report.referred[0].referral_rewarded_by, 'Dylan');
});

test('partners get their own link; turning one off stops it', async () => {
  assert.equal((await call('POST', '/api/partners', { name: 'Desert RV Storage' })).status, 403);
  const p = (await call('POST', '/api/partners', { name: 'Desert RV Storage', contact: 'Gina 702-555-0400' }, ADMIN)).data;
  assert.equal((await call('GET', `/api/public/referral/${p.code}`, undefined, null)).data.from, 'Desert RV Storage');
  await call('POST', `/api/public/referral/${p.code}`, { first_name: 'Cy', phone: '702-555-0303', vehicle_type: 'Coach / RV' }, null);
  const cy = (await call('GET', '/api/leads?q=0303')).data[0];
  assert.equal(cy.campaign, 'Partner: Desert RV Storage');
  assert.equal(cy.pipeline, 'rv');
  const report = (await call('GET', '/api/referrals', undefined, ADMIN)).data;
  assert.equal(report.partners[0].leads_this_year, 1);
  await call('PATCH', `/api/partners/${p.id}`, { active: false }, ADMIN);
  assert.equal((await call('GET', `/api/public/referral/${p.code}`, undefined, null)).status, 404);
});
