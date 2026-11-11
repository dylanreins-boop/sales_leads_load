const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.TWILIO_ACCOUNT_SID = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let db;
let server;
let base;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const SAM = auth('Sam', 'sales-pass');
const ADMIN = auth('Dylan', 'admin-pass');
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

test('each lead gets a 0-100 score with its reasons, a value and an age', async () => {
  const year = new Date().getFullYear();
  const hot = (await call('POST', '/api/leads', { full_name: 'Hana Hot', phone: '702-555-0401', email: 'hana@example.com', vehicle_type: 'Car', vehicle_year: String(year) })).data.lead;
  const cold = (await call('POST', '/api/leads', { full_name: 'Cole Cold', email: 'cole@example.com', vehicle_type: 'Car', vehicle_year: '2009' })).data.lead;
  db.prepare('UPDATE leads SET received_at = ? WHERE id = ?').run(ago(100), cold.id);
  const quote = await call('POST', `/api/leads/${hot.id}/quotes`, { base: 'pkg1700', custom: [{ label: 'Wheels', price: '250' }] });
  assert.equal(quote.status, 201, JSON.stringify(quote.data));
  db.prepare("INSERT INTO texts (lead_id, direction, phone, body, status, created_at) VALUES (?, 'in', '7025550401', 'Sounds good', 'received', ?)").run(hot.id, ago(1));

  const board = (await call('GET', '/api/leads')).data;
  const h = board.find((l) => l.id === hot.id);
  const c = board.find((l) => l.id === cold.id);
  // quote 20 + newer 15 + 2 services 15 + phone 10 + replied 10 + fresh 10 + email 5
  assert.equal(h.score, 85);
  assert.equal(h.heat, 'hot');
  assert.deepEqual(h.score_reasons.map((r) => r.label).slice(0, 2), ['Has a quote', 'Vehicle is 3 years old or newer']);
  assert.deepEqual([h.value_cents, h.value_kind, h.age], [195000, 'quote', 'fresh']);
  assert.deepEqual([c.score, c.heat, c.age], [5, 'cold', 'stale'], 'only an email; 100 hours with no contact');
  assert.equal(c.value_kind, 'typical', 'no quote: what a car usually comes to (the price list until there are jobs)');

  // Admins change the points and the lines.
  assert.equal((await call('PUT', '/api/settings/lead-score', { points: { email: 30 } })).status, 403, 'admins only');
  assert.match((await call('PUT', '/api/settings/lead-score', { points: { email: 99 } }, ADMIN)).data.error, /between -50 and 50/);
  assert.match((await call('PUT', '/api/settings/lead-score', { hot: 30, warm: 50 }, ADMIN)).data.error, /Hot has to be above Warm/);
  const saved = (await call('PUT', '/api/settings/lead-score', { points: { email: 30 }, hot: 80, warm: 30 }, ADMIN)).data;
  assert.deepEqual([saved.points.email, saved.hot, saved.warm], [30, 80, 30]);
  assert.deepEqual([(await call('GET', `/api/leads/${cold.id}`)).data.score, (await call('GET', `/api/leads/${cold.id}`)).data.heat], [30, 'warm']);
  await call('PUT', '/api/settings/lead-score', {}, ADMIN); // back to the defaults
});

test('Overview: today\'s numbers, the 4-column snapshot, suggestions from the data, the team and the call queue', async () => {
  // Sam called one lead 6 minutes after it came in and booked another.
  const quick = (await call('POST', '/api/leads', { full_name: 'Quinn Quick', phone: '702-555-0402', vehicle_type: 'SUV', source: 'website' })).data.lead;
  db.prepare("UPDATE leads SET source = 'website', received_at = ? WHERE id = ?").run(ago(2), quick.id);
  await call('POST', `/api/leads/${quick.id}/disposition`, { disposition: 'contacted_follow_up', note: 'Talked, wants a quote' });
  db.prepare('UPDATE leads SET first_contacted_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600000 + 6 * 60000).toISOString(), quick.id);
  const book = (await call('POST', '/api/leads', { full_name: 'Bea Booked', phone: '702-555-0403', vehicle_type: 'Car' })).data.lead;
  const day = new Date(); day.setDate(day.getDate() + 3); day.setHours(8, 0, 0, 0);
  const booked = await call('POST', `/api/leads/${book.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: day.toISOString(), job_hours: 4, job_amount: '1500', send_confirmation: false });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));

  const o = (await call('GET', '/api/overview')).data;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  assert.equal(o.kpis.new_today.value, db.prepare("SELECT COUNT(*) AS n FROM leads WHERE received_at >= ? AND source != 'import'").get(midnight.toISOString()).n, 'leads that came in since midnight (any time of day)');
  assert.equal(o.kpis.speed.seconds, 360, '6 minutes to first contact');
  assert.equal(o.kpis.booked_today.value, 1);
  assert.deepEqual([o.kpis.quoted.count, o.kpis.quoted.value_cents], [1, 195000]);
  assert.deepEqual(o.snapshot.map((c) => c.id), ['new', 'contacted', 'quoted', 'booked']);
  assert.equal(o.snapshot.find((c) => c.id === 'booked').leads[0].name, 'Bea Booked');
  assert.equal(o.snapshot.find((c) => c.id === 'booked').leads[0].value_cents, 150000, 'the job price');
  assert.equal(o.snapshot.find((c) => c.id === 'quoted').leads[0].name, 'Hana Hot');
  assert.ok(o.suggestions.some((s) => s.kind === 'reply' && /texted back/.test(s.title)));
  assert.ok(o.suggestions.some((s) => s.kind === 'call' && s.lead_id));
  const sam = o.team.find((r) => r.name === 'Sam');
  assert.ok(o.team.every((r) => r.name === 'Sam'), 'sales see only their own row, not the team');
  assert.deepEqual([sam.calls, sam.conversations, sam.appointments, sam.booked_cents, sam.quotes], [2, 2, 1, 150000, 1]);
  assert.equal(o.queue.next.why, 'Texted back');
  assert.equal((await call('GET', '/api/overview', undefined, auth('Mike', 'shop-pass'))).status, 403, 'not for the shop');
});

test('Leaderboard: a week or a month per rep, monthly goals (admins set them), and each rep\'s page', async () => {
  assert.equal((await call('GET', '/api/leaderboard?period=week')).status, 403, 'sales don\'t see the leaderboard');
  const board = (await call('GET', '/api/leaderboard?period=week', undefined, ADMIN)).data;
  assert.equal(board.period, 'week');
  const sam = board.reps.find((r) => r.name === 'Sam');
  assert.deepEqual([sam.appointments, sam.booked_cents, sam.quotes], [1, 150000, 1]);
  assert.ok(!board.reps.some((r) => r.name === 'Mike'), 'shop logins aren\'t ranked');

  assert.equal((await call('PUT', '/api/goals', { name: 'Sam', monthly: '20000' })).status, 403, 'admins set goals');
  assert.match((await call('PUT', '/api/goals', { name: 'Sam', monthly: 'lots' }, ADMIN)).data.error, /in dollars/);
  assert.deepEqual((await call('PUT', '/api/goals', { name: 'Sam', monthly: '$20,000' }, ADMIN)).data, { Sam: 2000000 });
  const month = (await call('GET', '/api/leaderboard?period=month', undefined, ADMIN)).data.reps.find((r) => r.name === 'Sam');
  assert.deepEqual([month.goal_cents, month.month_booked_cents], [2000000, 150000]);

  const page = (await call('GET', '/api/reps/Sam')).data;
  assert.equal(page.goal_progress, 7.5);
  assert.equal(page.months.length, 6);
  assert.equal(page.months[5].booked_cents, 150000);
  assert.ok(page.commission, 'Sam sees his own commission');
  assert.equal((await call('GET', '/api/reps/Dylan')).status, 403, 'and only his own page');
  assert.ok((await call('GET', '/api/reps/Sam', undefined, ADMIN)).data.commission, 'admins see everyone\'s');
});

test('Analytics: each month\'s new leads followed on their own, and a lead-source filter', async () => {
  const from = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const all = (await call('GET', `/api/analytics?from=${from}&to=${to}`, undefined, ADMIN)).data;
  assert.equal(all.months.length, 2);
  const now = all.months[1];
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  assert.equal(now.came_in, db.prepare('SELECT COUNT(*) AS n FROM leads WHERE received_at >= ?').get(monthStart).n, 'this month\'s leads (any day of the month)');
  assert.equal(now.booked, 1);
  const web = (await call('GET', `/api/analytics?from=${from}&to=${to}&source=website`, undefined, ADMIN)).data;
  assert.equal(web.range.source, 'website');
  assert.equal(web.funnel[0].n, 1, 'only the website lead');
});
