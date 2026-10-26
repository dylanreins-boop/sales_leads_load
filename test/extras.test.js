const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Runs in its own process, so these settings don't affect the other test files.
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.EMAIL_PROVIDER = 'resend';
process.env.EMAIL_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'shop@example.com';
process.env.BRAND_PHONE = '702-555-0100';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createReviewService } = require('../src/reviews');

const sentEmails = [];
const fakeFetch = async (url, init) => {
  sentEmails.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => '' };
};

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: fakeFetch }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SALES = login('Sam', 'sales-pass');
const SHOP = login('Mike', 'shop-pass');
async function call(method, url, body, auth = SALES, headers = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}

test('quotes price vehicles by package and RVs by the foot, from the saved price list', async () => {
  const prices = (await call('GET', '/api/settings/prices')).data;
  assert.deepEqual(prices.vehicle.map((p) => p.price_cents), [80000, 130000, 140000, 170000]);
  assert.deepEqual(prices.rv.map((r) => r.per_foot_cents), [13000, 15000]);
  assert.equal(prices.addons.find((a) => a.id === 'wheels_windows').price_cents, null, 'wheels & windows has no price yet');

  const car = (await call('POST', '/api/quotes/preview', { base: 'pkg1300' })).data;
  assert.equal(car.total_cents, 130000);
  const rv = (await call('POST', '/api/quotes/preview', { base: 'rv150', feet: 38 })).data;
  assert.equal(rv.total_cents, 570000);
  assert.equal(rv.lines[0].detail, '38 ft × $150.00/ft');

  const noPrice = await call('POST', '/api/quotes/preview', { base: 'pkg800', addons: ['wheels_windows'] });
  assert.equal(noPrice.status, 400);
  assert.match(noPrice.data.error, /Wheels & windows doesn't have a price yet/);
  assert.match((await call('POST', '/api/quotes/preview', { base: 'rv130' })).data.error, /length in feet/);
  assert.match((await call('POST', '/api/quotes/preview', {})).data.error, /Pick a package/);

  const custom = (await call('POST', '/api/quotes/preview', { base: 'pkg800', custom: [{ label: 'Headlight restore', price: '150' }], discount: '50' })).data;
  assert.equal(custom.total_cents, 90000);
  assert.deepEqual(custom.lines.map((l) => l.label), ['Coating package', 'Headlight restore', 'Discount']);
});

test('only admins change the price list; then add-ons can be quoted', async () => {
  const prices = (await call('GET', '/api/settings/prices')).data;
  const next = { ...prices, addons: [{ id: 'wheels_windows', label: 'Wheels & windows', price: '350' }] };
  assert.equal((await call('PUT', '/api/settings/prices', next, SALES)).status, 403);
  assert.equal((await call('GET', '/api/settings/prices', undefined, SHOP)).status, 403, 'shop never sees prices');
  assert.match((await call('PUT', '/api/settings/prices', { ...next, vehicle: [{ label: 'Gold', price: '' }] }, ADMIN)).data.error, /Add a price for Gold/);
  const saved = (await call('PUT', '/api/settings/prices', next, ADMIN)).data;
  assert.equal(saved.addons[0].price_cents, 35000);
  assert.equal((await call('POST', '/api/quotes/preview', { base: 'pkg1700', addons: ['wheels_windows'] })).data.total_cents, 205000);
});

test('a saved quote is logged on the lead and can be emailed to the customer', async () => {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Quote Me', phone: '702-555-8100', vehicle_type: 'Coach / RV', vehicle_make: 'Tiffin' })).data;
  const quote = await call('POST', `/api/leads/${lead.id}/quotes`, { base: 'rv130', feet: 40, addons: ['wheels_windows'], note: 'Price good for 30 days.' });
  assert.equal(quote.status, 201);
  assert.equal(quote.data.total_cents, 555000);
  assert.equal(quote.data.created_by, 'Sam');
  const full = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.equal(full.quotes.length, 1);
  assert.ok(full.activities.some((a) => a.type === 'quote' && /^Quote \$5,550\.00: RV \/ trailer, no wheels or windows \(40 ft × \$130\.00\/ft\) \$5,200\.00 \+ Wheels & windows \$350\.00$/.test(a.note)));

  assert.match((await call('POST', `/api/quotes/${quote.data.id}/email`)).data.error, /customer's email/);
  await call('PATCH', `/api/leads/${lead.id}`, { email: 'quote.me@example.com' });
  sentEmails.length = 0;
  const emailed = await call('POST', `/api/quotes/${quote.data.id}/email`);
  assert.equal(emailed.status, 201);
  assert.equal(emailed.data.quote.emailed_to, 'quote.me@example.com');
  const text = sentEmails[0].body.text;
  assert.match(text, /Hi Quote,/);
  assert.match(text, /Total\s+\$5,550\.00/);
  assert.match(text, /Price good for 30 days\./);
  assert.match(text, /call 702-555-0100/);
  assert.ok(emailed.data.lead.activities.some((a) => a.note === 'Quote email sent to quote.me@example.com'));
  assert.equal((await call('POST', `/api/leads/${lead.id}/quotes`, { base: 'pkg800' }, SHOP)).status, 403);
});

test('the sign-in page sets a session; wrong passwords are refused and slowed down', async () => {
  assert.equal((await call('GET', '/login', undefined, null)).status, 200);
  assert.equal((await call('GET', '/styles.css', undefined, null)).status, 200, 'the sign-in page can load its styles');
  assert.equal((await call('GET', '/api/leads', undefined, null)).headers.get('www-authenticate'), null, 'no browser pop-up');

  const bad = await call('POST', '/api/login', { name: 'Sam', password: 'nope' }, null);
  assert.equal(bad.status, 401);
  assert.match(bad.data.error, /don't match/);

  const ok = await call('POST', '/api/login', { name: 'sam', password: 'sales-pass' }, null);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { name: 'Sam', role: 'sales' });
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /^bm_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
  const session = cookie.split(';')[0];
  const me = await call('GET', '/api/meta', undefined, null, { Cookie: session });
  assert.equal(me.data.currentUser, 'Sam');
  assert.equal((await call('GET', '/login', undefined, null, { Cookie: session })).status, 302, 'signed in: /login goes to the app');

  const out = await call('POST', '/api/logout', {}, null, { Cookie: session });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/meta', undefined, null, { Cookie: session })).status, 401, 'signed out');

  for (let i = 0; i < 8; i++) await call('POST', '/api/login', { name: 'Mike', password: `guess-${i}` }, null);
  const locked = await call('POST', '/api/login', { name: 'Mike', password: 'shop-pass' }, null);
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Too many wrong tries/);
});

test('resetting a password or deactivating someone signs them out', async () => {
  const added = (await call('POST', '/api/users', { name: 'Lisa', password: 'lisa-pass-1', role: 'sales' }, ADMIN)).data;
  const session = (await call('POST', '/api/login', { name: 'Lisa', password: 'lisa-pass-1' }, null)).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/meta', undefined, null, { Cookie: session })).status, 200);
  await call('PATCH', `/api/users/${added.id}`, { password: 'lisa-pass-2' }, ADMIN);
  assert.equal((await call('GET', '/api/meta', undefined, null, { Cookie: session })).status, 401);
});

test('lead source report: leads, bookings and revenue for each lead in the range', async () => {
  const { lead } = (await call('POST', '/api/intake/website', { name: 'Report Lead', phone: '702-555-8200', heard_about: 'radio' }, null)).data
    ? { lead: (await call('GET', '/api/leads?q=Report', undefined, ADMIN)).data[0] } : {};
  await call('POST', `/api/leads/${lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: '2026-12-01T15:00:00Z', job_end: '2026-12-01T22:00:00Z', job_amount: '1300',
  });
  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await call('GET', `/api/reports/sources?from=${from}&to=${to}`)).status, 403, 'admin only');
  const rows = (await call('GET', `/api/reports/sources?from=${from}&to=${to}`, undefined, ADMIN)).data;
  const row = rows.find((r) => r.id === lead.id);
  assert.deepEqual([row.source, row.heard_about, row.booked, row.revenue_cents], ['website', 'Radio', true, 130000]);
  assert.ok(rows.some((r) => !r.booked), 'unbooked leads count too');
  assert.equal((await call('GET', '/api/reports/sources?from=nope&to=x', undefined, ADMIN)).status, 400);
});

test('review requests email recent pick-ups once, after the wait, when turned on', async () => {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db);
  const jobs = createJobService(db, { leads, photosDir: require('node:os').tmpdir() });
  const outbox = [];
  const mailer = { configured: true, send: async (m) => { outbox.push(m); } };
  const reviews = createReviewService(db, { leads, mailer, brand: { name: 'Bob Moses Ceramic Coating' } });
  const finish = (name, email, phone) => {
    const { lead } = leads.ingest({ source: 'manual', full_name: name, email, phone, vehicle_type: 'Car', vehicle_make: 'Tesla' });
    leads.dispositionLead(lead.id, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'] });
    const job = jobs.scheduleLead(lead.id, { start: '2026-09-01T15:00:00.000Z', end: '2026-09-01T22:00:00.000Z' });
    jobs.updateJob(job.id, { status: 'picked_up' });
    return { lead, job };
  };
  const happy = finish('Happy Customer', 'happy@example.com', '702-555-8301');
  finish('No Email', null, '702-555-8302');
  const DAY = 86400000;
  const later = (days) => new Date(Date.now() + days * DAY);

  assert.equal(await reviews.sendDue(later(3)), 0, 'off until turned on');
  assert.throws(() => reviews.saveSettings({ enabled: true }), /Add the review link/);
  assert.throws(() => reviews.saveSettings({ link: 'g.page/bob' }), /https/);
  reviews.saveSettings({ enabled: true, link: 'https://g.page/r/bob-moses/review', delay_days: 2 });

  assert.equal(await reviews.sendDue(later(1)), 0, 'not before the wait');
  assert.equal(await reviews.sendDue(later(2.1)), 1, 'only the customer with an email');
  assert.equal(outbox[0].to, 'happy@example.com');
  assert.match(outbox[0].subject, /How does your Tesla look, Happy\?/);
  assert.match(outbox[0].text, /https:\/\/g\.page\/r\/bob-moses\/review/);
  assert.ok(leads.getLead(happy.lead.id).activities.some((a) => a.note === 'Review request sent to happy@example.com'));
  assert.equal(await reviews.sendDue(later(3)), 0, 'never twice');

  // Jobs picked up long before the feature was turned on are left alone.
  const old = finish('Old Customer', 'old@example.com', '702-555-8303');
  db.prepare('UPDATE jobs SET picked_up_at = ? WHERE id = ?').run(new Date(Date.now() - 90 * DAY).toISOString(), old.job.id);
  assert.equal(await reviews.sendDue(later(3)), 0);
});

test('meta tells the app when past customers are due for maintenance', async () => {
  assert.equal((await call('GET', '/api/meta')).data.recoatMonths, 11);
});
