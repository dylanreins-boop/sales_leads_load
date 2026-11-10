const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

process.env.APP_USERS = 'Dylan:admin-pass:admin';
process.env.APP_PASSWORD = '';
process.env.WEBSITE_API_KEY = 'site-key';

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

const post = (body) => fetch(`${base}/api/intake/website`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'site-key' }, body: JSON.stringify(body) });

test('the website form keeps where the lead came from: ad tags, page and referring site', async () => {
  const res = await post({
    name: 'Una Utm', phone: '702-555-0300', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall-coating', utm_content: 'ad-b', utm_term: 'ceramic coating las vegas',
    page_url: 'https://bobmosescc.com/ceramic-coating?utm_source=google', referrer: 'https://www.google.com/',
  });
  assert.equal(res.status, 201);
  const row = db.prepare('SELECT campaign, utm_source, utm_medium, utm_content, utm_term, landing_page, referrer_url FROM leads WHERE full_name = ?').get('Una Utm');
  assert.deepEqual({ ...row }, {
    campaign: 'fall-coating', utm_source: 'google', utm_medium: 'cpc', utm_content: 'ad-b', utm_term: 'ceramic coating las vegas',
    landing_page: 'https://bobmosescc.com/ceramic-coating?utm_source=google', referrer_url: 'https://www.google.com/',
  });
});

test('more than 20 submissions from one address in 10 minutes are turned away', async () => {
  const statuses = [];
  for (let i = 0; i < 21; i += 1) statuses.push((await post({ name: `Bot ${i}`, phone: `702-555-1${String(i).padStart(3, '0')}` })).status);
  assert.equal(statuses.filter((s) => s === 201).length, 19, 'one went in the test before');
  assert.equal(statuses.at(-1), 429);
});

test('on the live server: no WEBSITE_API_KEY means the form is off, and only the company site may post from a browser', () => {
  const script = `
    process.env.NODE_ENV = 'production'; process.env.APP_USERS = 'Dylan:admin-pass:admin';
    process.env.BRAND_WEBSITE = 'https://bobmosescc.com';
    const config = require('./src/config');
    console.log(JSON.stringify({ origins: config.website.corsOrigins, requireKey: config.website.requireKey, open: config.openWithoutLogins }));
  `;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: `${__dirname}/..`, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  const got = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.deepEqual(got, { origins: ['https://bobmosescc.com', 'https://www.bobmosescc.com'], requireKey: true, open: false });

  // And the sign-in rule: open only off the live server, or with OPEN_ACCESS=1 on purpose.
  const open = (env) => JSON.parse(spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./src/config').openWithoutLogins))"],
    { cwd: `${__dirname}/..`, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout.trim());
  assert.equal(open({ NODE_ENV: 'production' }), false, 'live server: locked');
  assert.equal(open({ NODE_ENV: 'production', OPEN_ACCESS: '' }), false);
  assert.equal(open({ NODE_ENV: 'production', OPEN_ACCESS: 'yes' }), false);
  assert.equal(open({ NODE_ENV: 'production', OPEN_ACCESS: '1' }), true, 'only on purpose');
  assert.equal(open({}), true, 'trying it out on a laptop');
  assert.equal(open({ OPEN_ACCESS: '0' }), false);
});
