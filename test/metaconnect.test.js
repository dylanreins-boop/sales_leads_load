const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';
process.env.PUBLIC_URL = 'https://leads.example.com';
for (const k of ['FB_VERIFY_TOKEN', 'FB_APP_SECRET', 'FB_PAGE_ACCESS_TOKEN', 'FB_PAGE_ID', 'IG_USER_ID', 'FB_FORM_IDS', 'FB_APP_ID']) delete process.env[k];

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

const APP_ID = '1234567890123';
const APP_SECRET = 'abcdef0123456789abcdef0123456789';
const calls = [];
let pages = [{ id: '111', name: 'Bob Moses Las Vegas', access_token: 'PAGE-TOKEN-111', instagram_business_account: { id: '999', username: 'bobmoseslv' } }];

// Facebook's side, faked: login codes, the Page list, lead ads setup and one lead.
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
  calls.push({ method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body });
  const ok = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
  const p = u.pathname.replace(/^\/v[\d.]+/, '');
  if (p === '/oauth/access_token' && u.searchParams.get('code')) {
    return u.searchParams.get('code') === 'good' ? ok({ access_token: 'SHORT' }) : { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid verification code' } }) };
  }
  if (p === '/oauth/access_token') return ok({ access_token: 'LONG', expires_in: 5184000 });
  if (p === '/me') return ok({ id: '42', name: 'Dylan R' });
  if (p === '/me/accounts') return ok({ data: pages });
  if (/^\/\d+\/subscribed_apps$/.test(p)) return ok({ success: true });
  if (p === `/${APP_ID}/subscriptions`) return ok({ success: true });
  if (/^\/\d+\/leadgen_forms$/.test(p)) return ok({ data: [{ id: '555', name: 'Ceramic quote', status: 'ACTIVE' }] });
  if (p === '/777') {
    return ok({ id: '777', created_time: new Date().toISOString(), form_id: '555',
      field_data: [{ name: 'full_name', values: ['Lena Park'] }, { name: 'phone_number', values: ['+17025550808'] }, { name: 'email', values: ['lena@example.com'] }] });
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: `no fake for ${p}` } }) };
};

let server;
let base;
let db;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db, fetchImpl: fakeFetch }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SAM = login('Sam', 'sales-pass');
async function call(method, url, body, auth = ADMIN, headers = {}) {
  const res = await fetch(base + url, { method, redirect: 'manual', headers: { ...(auth && { Authorization: auth }), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, location: res.headers.get('location') };
}
// Logs in through the fake Facebook and comes back to the app.
async function loginWithFacebook(code = 'good') {
  const { url } = (await call('POST', '/api/meta-connect/start')).data;
  const state = new URL(url).searchParams.get('state');
  return call('GET', `/auth/facebook/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

test('an admin saves the Meta app once, then Connect Facebook does the rest', async () => {
  assert.equal((await call('GET', '/api/meta-connect', undefined, SAM)).status, 403, 'admins only');
  assert.equal((await call('GET', '/api/meta-connect')).data.app_saved, false);
  assert.match((await call('POST', '/api/meta-connect/start')).data.error, /App ID and App Secret first/);
  assert.match((await call('PUT', '/api/meta-connect/app', { app_id: 'abc', app_secret: APP_SECRET })).data.error, /App ID/);
  assert.match((await call('PUT', '/api/meta-connect/app', { app_id: APP_ID, app_secret: 'short' })).data.error, /32 letters/);
  const saved = (await call('PUT', '/api/meta-connect/app', { app_id: APP_ID, app_secret: APP_SECRET })).data;
  assert.equal(saved.app_saved, true);
  assert.equal(saved.redirect_uri, 'https://leads.example.com/auth/facebook/callback');
  assert.match(saved.verify_token, /^bmcc-[a-f0-9]{24}$/);

  const { url } = (await call('POST', '/api/meta-connect/start')).data;
  const u = new URL(url);
  assert.equal(u.hostname, 'www.facebook.com');
  assert.equal(u.searchParams.get('client_id'), APP_ID);
  assert.equal(u.searchParams.get('redirect_uri'), saved.redirect_uri);
  assert.match(u.searchParams.get('scope'), /leads_retrieval/);
  assert.match(u.searchParams.get('scope'), /instagram_content_publish/);

  // A bad code or an old link goes back with the reason.
  const bad = await loginWithFacebook('bad');
  assert.match(bad.location, /^\/\?fb=error&msg=Invalid/);
  assert.match((await call('GET', '/auth/facebook/callback?code=good&state=made-up')).location, /fb=error&msg=That\+login\+link\+expired/);

  // One Page: connected straight away, with Instagram, the lead forms and lead ads set up.
  calls.length = 0;
  const done = await loginWithFacebook();
  assert.equal(done.location, '/?fb=connected');
  const st = (await call('GET', '/api/meta-connect')).data;
  assert.equal(st.connected, true);
  assert.deepEqual([st.page.name, st.instagram.username, st.forms.map((f) => f.name)], ['Bob Moses Las Vegas', 'bobmoseslv', ['Ceramic quote']]);
  assert.ok(st.steps.length === 3 && st.steps.every((x) => x.ok), JSON.stringify(st.steps));
  assert.ok(!JSON.stringify(st).includes('PAGE-TOKEN'), 'keys never go to the browser');
  const sub = calls.find((c) => c.path.endsWith('/subscribed_apps'));
  assert.deepEqual([sub.method, sub.body.subscribed_fields, sub.body.access_token], ['POST', 'leadgen', 'PAGE-TOKEN-111']);
  const hook = calls.find((c) => c.path.endsWith(`/${APP_ID}/subscriptions`));
  assert.deepEqual([hook.body.callback_url, hook.body.fields, hook.body.verify_token, hook.body.access_token],
    ['https://leads.example.com/webhooks/facebook', 'leadgen', saved.verify_token, `${APP_ID}|${APP_SECRET}`]);
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'meta_connection'").get().value;
  assert.ok(!stored.includes('PAGE-TOKEN') && !stored.includes(APP_SECRET), 'stored encrypted');
  assert.equal((await call('GET', '/api/meta')).data.facebookConfigured, true);

  // Meta's webhook check uses the token the app made.
  const verify = await call('GET', `/webhooks/facebook?hub.mode=subscribe&hub.verify_token=${saved.verify_token}&hub.challenge=4242`, undefined, null);
  assert.deepEqual([verify.status, verify.data], [200, 4242]);
  assert.equal((await call('GET', '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1', undefined, null)).status, 403);
});

test('a lead ad comes in through the webhook, signed with the saved app secret, read with the saved Page key', async () => {
  const payload = JSON.stringify({ object: 'page', entry: [{ id: '111', changes: [{ field: 'leadgen', value: { leadgen_id: '777', page_id: '111', form_id: '555' } }] }] });
  assert.equal((await call('POST', '/webhooks/facebook', payload, null, { 'X-Hub-Signature-256': 'sha256=forged' })).status, 401, 'unsigned is refused');
  const sig = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
  calls.length = 0;
  const res = await call('POST', '/webhooks/facebook', payload, null, { 'X-Hub-Signature-256': sig });
  assert.ok(res.status < 300, JSON.stringify(res.data));
  assert.equal(calls.find((c) => c.path.endsWith('/777')).query.access_token, 'PAGE-TOKEN-111');
  const lena = (await call('GET', '/api/leads?q=Lena')).data[0];
  assert.deepEqual([lena.full_name, lena.source], ['Lena Park', 'facebook']);
});

test('more than one Page: the admin picks the shop\'s; disconnecting stops lead ads', async () => {
  pages = [
    { id: '111', name: 'Bob Moses Las Vegas', access_token: 'PAGE-TOKEN-111', instagram_business_account: { id: '999', username: 'bobmoseslv' } },
    { id: '222', name: 'Dylan\'s other Page', access_token: 'PAGE-TOKEN-222' },
  ];
  const back = await loginWithFacebook();
  const pick = new URLSearchParams(back.location.split('?')[1]).get('pick');
  assert.match(back.location, /^\/\?fb=pick&pick=/);
  const list = (await call('GET', `/api/meta-connect/pick/${pick}`)).data.pages;
  assert.deepEqual(list.map((p) => [p.name, p.instagram]), [['Bob Moses Las Vegas', 'bobmoseslv'], ['Dylan\'s other Page', null]]);
  assert.ok(!JSON.stringify(list).includes('PAGE-TOKEN'));
  assert.match((await call('POST', '/api/meta-connect/pick', { pick, page_id: '333' })).data.error, /Pick one/);
  const st = (await call('POST', '/api/meta-connect/pick', { pick, page_id: '222' })).data;
  assert.equal(st.page.name, 'Dylan\'s other Page');
  assert.equal(st.instagram, null);
  assert.match((await call('POST', '/api/meta-connect/pick', { pick, page_id: '222' })).data.error, /expired/, 'once');

  calls.length = 0;
  const off = (await call('POST', '/api/meta-connect/disconnect')).data;
  assert.deepEqual([off.connected, off.app_saved], [false, true], 'the Meta app stays saved for next time');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/222/subscribed_apps')));
  assert.equal((await call('GET', '/api/meta')).data.facebookConfigured, false);
  const log = (await call('GET', '/api/audit?area=settings')).data.map((r) => r.action);
  assert.ok(log.includes('Connected Facebook: Bob Moses Las Vegas') && log.includes('Disconnected Facebook'), log.join('\n'));
});
