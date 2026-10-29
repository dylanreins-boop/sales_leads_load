const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Runs in its own process, so these logins don't affect the other test files.
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Lisa:lisa-pass:sales,Mike:shop-pass:shop';
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

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SAM = login('Sam', 'sales-pass');
const LISA = login('Lisa', 'lisa-pass');
const SHOP = login('Mike', 'shop-pass');
async function call(method, url, body, auth = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

let n = 0;
async function book(auth, amount, extra = {}) {
  n += 1;
  const { lead } = (await call('POST', '/api/leads', { full_name: `Customer ${n}`, phone: `702-555-${String(6000 + n)}`, vehicle_type: 'Car' }, auth)).data;
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['full_decon_coat'],
    job_start: '2026-11-10T15:00:00Z', job_end: '2026-11-10T22:00:00Z', job_amount: amount, ...extra,
  }, auth);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('booking can record the 10% deposit; every job shows the deposit due and the rep\'s 10% commission', async () => {
  const withDeposit = await book(SAM, '1300', { deposit_taken: true, deposit_method: 'Card' });
  assert.equal(withDeposit.job.deposit_cents, 13000, 'defaults to 10% of the job');
  assert.equal(withDeposit.job.deposit_method, 'Card');
  assert.equal(withDeposit.job.deposit_by, 'Sam');
  assert.equal(withDeposit.job.commission_cents, 13000);
  assert.equal(withDeposit.job.commission_rep, 'Sam');
  assert.equal(withDeposit.job.commission_status, 'pending', 'owed once the job is picked up');
  assert.equal(withDeposit.lead.jobs[0].deposit_due_cents, 13000, 'the lead shows it too');
  assert.ok(withDeposit.lead.activities.some((a) => a.type === 'deposit' && a.note === 'Deposit taken: $130.00 (Card)'));

  const noDeposit = await book(SAM, '800');
  assert.equal(noDeposit.job.deposit_cents, null);
  assert.equal(noDeposit.job.deposit_due_cents, 8000);

  const bad = await call('POST', '/api/leads', { full_name: 'Bad Deposit', phone: '702-555-6999' });
  const res = await call('POST', `/api/leads/${bad.data.lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['wheels'], job_start: '2026-11-10T15:00:00Z', job_end: '2026-11-10T22:00:00Z', deposit_taken: true,
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /job amount/);
});

test('deposits can be marked later, changed and undone; the shop never sees money', async () => {
  const { job } = await book(SAM, '1700');
  const taken = await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: true, amount: '200', method: 'Cash' });
  assert.equal(taken.data.deposit_cents, 20000);
  assert.equal((await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: true, method: 'Bitcoin' })).status, 400);
  assert.equal((await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: true }, SHOP)).status, 403);
  const shopView = (await call('GET', `/api/jobs/${job.id}`, undefined, SHOP)).data;
  assert.ok(!Object.keys(shopView).some((k) => /^(amount|deposit|commission)_/.test(k)), 'no money fields for the shop');
  assert.equal((await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: false })).data.deposit_cents, null);
});

test('commission is owed once the job is done, and admins mark it paid', async () => {
  const a = (await book(SAM, '1400')).job;
  const b = (await book(SAM, '5200')).job;
  const lisaJob = (await book(LISA, '800')).job;
  for (const job of [a, b, lisaJob]) await call('PATCH', `/api/jobs/${job.id}`, { status: 'picked_up' }, SHOP);

  const mine = (await call('GET', '/api/commissions')).data;
  assert.ok(mine.jobs.every((j) => j.commission_rep === 'Sam'), 'a rep only sees their own');
  assert.deepEqual(mine.reps, ['Sam']);
  const owed = mine.jobs.filter((j) => j.commission_status === 'owed');
  assert.deepEqual(owed.map((j) => j.commission_cents).sort((x, y) => x - y), [14000, 52000]);

  assert.equal((await call('POST', '/api/commissions/pay', { job_ids: [a.id] })).status, 403, 'only admins pay');
  const all = (await call('GET', '/api/commissions', undefined, ADMIN)).data;
  assert.ok(all.jobs.some((j) => j.commission_rep === 'Lisa'));
  assert.ok(all.reps.includes('Lisa') && all.reps.includes('Sam'));

  const paid = await call('POST', '/api/commissions/pay', { job_ids: [a.id, b.id, lisaJob.id], note: 'Check #1042' }, ADMIN);
  assert.equal(paid.status, 201);
  assert.equal(paid.data.total_cents, 14000 + 52000 + 8000);
  const after = (await call('GET', '/api/commissions')).data.jobs.find((j) => j.id === a.id);
  assert.equal(after.commission_status, 'paid');
  assert.equal(after.commission_paid_by, 'Dylan');
  const lead = (await call('GET', `/api/leads/${a.lead_id}`)).data;
  assert.ok(lead.activities.some((x) => x.note === 'Commission paid to Sam: $140.00 (Check #1042)'));

  assert.match((await call('POST', '/api/commissions/pay', { job_ids: [a.id] }, ADMIN)).data.error, /None of those are owed/);
  assert.match((await call('PATCH', `/api/jobs/${a.id}/commission`, { amount: '1' }, ADMIN)).data.error, /already paid/);
  assert.equal((await call('POST', `/api/jobs/${a.id}/commission/unpay`, {}, ADMIN)).data.commission_status, 'owed');
});

test('admins can hand a commission to another rep, change the amount, and change when it is owed', async () => {
  const { job } = await book(ADMIN, '2000');
  assert.equal(job.commission_rep, 'Dylan');
  assert.equal((await call('PATCH', `/api/jobs/${job.id}/commission`, { rep: 'Lisa' })).status, 403);
  const moved = (await call('PATCH', `/api/jobs/${job.id}/commission`, { rep: 'Lisa', amount: '150' }, ADMIN)).data;
  assert.deepEqual([moved.commission_rep, moved.commission_cents], ['Lisa', 15000]);
  assert.equal((await call('PATCH', `/api/jobs/${job.id}/commission`, { amount: '' }, ADMIN)).data.commission_cents, 20000, 'blank = back to 10%');

  assert.equal((await call('PUT', '/api/settings/commission', { owed_when: 'deposit' })).status, 403);
  assert.equal((await call('PUT', '/api/settings/commission', { owed_when: 'deposit', rate_pct: 12 }, ADMIN)).data.rate_pct, 12);
  let now = (await call('GET', '/api/commissions', undefined, LISA)).data.jobs.find((j) => j.id === job.id);
  assert.deepEqual([now.commission_status, now.commission_cents], ['pending', 24000]);
  await call('PATCH', `/api/jobs/${job.id}/deposit`, { taken: true }, ADMIN);
  now = (await call('GET', '/api/commissions', undefined, LISA)).data.jobs.find((j) => j.id === job.id);
  assert.equal(now.commission_status, 'owed', 'owed once the deposit is in');
  assert.equal(now.deposit_cents, 20000, 'deposit is still 10%');
  assert.equal((await call('PUT', '/api/settings/commission', { rate_pct: 150 }, ADMIN)).status, 400);
  await call('PUT', '/api/settings/commission', { owed_when: 'picked_up', rate_pct: 10 }, ADMIN);

  await call('PATCH', `/api/jobs/${job.id}`, { status: 'cancelled' }, SHOP);
  now = (await call('GET', '/api/commissions', undefined, LISA)).data.jobs.find((j) => j.id === job.id);
  assert.equal(now.commission_status, 'cancelled', 'cancelled jobs earn nothing');
});

test('commission becomes owed once the vehicle is in the shop, and admins are reminded to pay it', async () => {
  await call('PUT', '/api/settings/commission', { owed_when: 'in_shop' }, ADMIN);
  const { job } = await book(SAM, '3000');
  assert.equal(job.commission_status, 'pending', 'booked but not in the building yet');
  const before = (await call('GET', '/api/commissions/owed', undefined, ADMIN)).data;
  assert.equal((await call('GET', '/api/commissions/owed')).status, 403, 'reminders are for admins');

  await call('PATCH', `/api/jobs/${job.id}`, { status: 'in_shop' }, SHOP);
  const now = (await call('GET', '/api/commissions')).data.jobs.find((j) => j.id === job.id);
  assert.equal(now.commission_status, 'owed');
  const lead = (await call('GET', `/api/leads/${job.lead_id}`)).data;
  assert.ok(lead.activities.some((a) => a.type === 'commission' && a.note === 'Commission now owed to Sam: $300.00' && a.user_name === 'Mike'),
    'logged so admins see it in Updates');

  const after = (await call('GET', '/api/commissions/owed', undefined, ADMIN)).data;
  const sam = (r) => r.reps.find((x) => x.rep === 'Sam') || { owed_cents: 0, jobs: 0 };
  assert.equal(sam(after).owed_cents - sam(before).owed_cents, 30000);
  assert.equal(sam(after).jobs - sam(before).jobs, 1);
  await call('POST', '/api/commissions/pay', { job_ids: [job.id] }, ADMIN);
  assert.equal(sam((await call('GET', '/api/commissions/owed', undefined, ADMIN)).data).owed_cents, sam(before).owed_cents, 'paid drops off the reminder');

  // Back out of the shop (e.g. a mistake) before it's paid: pending again.
  const second = (await book(SAM, '1000')).job;
  await call('PATCH', `/api/jobs/${second.id}`, { status: 'in_shop' }, SHOP);
  await call('PATCH', `/api/jobs/${second.id}`, { status: 'scheduled' }, SHOP);
  assert.equal((await call('GET', '/api/commissions')).data.jobs.find((j) => j.id === second.id).commission_status, 'pending');
});

test('the default rule is: owed once the vehicle is in the shop', async () => {
  assert.ok(require('../src/commissions').OWED_WHEN.includes('in_shop'));
  const fresh = http.createServer(createApp({ db: openDatabase(':memory:') }));
  await new Promise((resolve) => fresh.listen(0, resolve));
  const res = await fetch(`http://localhost:${fresh.address().port}/api/settings/commission`, { headers: { Authorization: SAM } });
  assert.equal((await res.json()).owed_when, 'in_shop');
  fresh.close();
});
