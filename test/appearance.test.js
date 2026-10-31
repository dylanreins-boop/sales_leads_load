const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { textOn } = require('../src/appearance');

let server;
let base;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-'));
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), photosDir: dir }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const ADMIN = `Basic ${Buffer.from('Dylan:admin-pass').toString('base64')}`;
const SAM = `Basic ${Buffer.from('Sam:sales-pass').toString('base64')}`;
async function call(method, url, body, auth = ADMIN, type = 'application/json') {
  const res = await fetch(base + url, { method, headers: { ...(auth && { Authorization: auth }), 'Content-Type': type }, body: body && (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* css or image */ }
  return { status: res.status, data, type: res.headers.get('content-type') };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);

test('admins set the colors for everyone; the CSS reaches every page without signing in', async () => {
  const empty = await call('GET', '/appearance.css', undefined, null);
  assert.equal(empty.status, 200);
  assert.match(empty.type, /text\/css/);
  assert.doesNotMatch(empty.data, /--accent/, 'nothing set: the standard look');

  assert.equal((await call('PUT', '/api/appearance', { accent: '#c8102e' }, SAM)).status, 403);
  assert.equal((await call('PUT', '/api/appearance', { accent: 'red' })).status, 400);
  const saved = (await call('PUT', '/api/appearance', { accent: '#C8102E', bar: '#16181D', background: '#ececee', highlight: '' })).data;
  assert.deepEqual([saved.accent, saved.bar, saved.highlight], ['#c8102e', '#16181d', null]);

  const css = (await call('GET', '/appearance.css', undefined, null)).data;
  assert.match(css, /--accent: #c8102e; --accent-text: #ffffff/);
  assert.match(css, /:root\[data-theme="light"\] \{ --link: #c8102e; --bar: #16181d; --bar-text: #ffffff;/);
  assert.match(css, /@media \(prefers-color-scheme: light\) \{ :root:not\(\[data-theme="dark"\]\) \{ --link: #c8102e;/);
  assert.match(css, /--bg: #ececee/);
  assert.equal(textOn('#ffffff'), '#0e1a2b');
  assert.equal(textOn('#00142b'), '#ffffff');

  // Preview doesn't save.
  const preview = (await call('POST', '/api/appearance/preview', { accent: '#1f6f4a' })).data.css;
  assert.match(preview, /#1f6f4a/);
  assert.match((await call('GET', '/appearance.css', undefined, null)).data, /#c8102e/);
});

test('background picture and logos are uploaded, served publicly, replaced and removed', async () => {
  assert.equal((await call('POST', '/api/appearance/logo', Buffer.from('not an image'), ADMIN, 'application/octet-stream')).status, 415);
  const withLogo = (await call('POST', '/api/appearance/logo', PNG, ADMIN, 'image/png')).data;
  assert.match(withLogo.logo, /^\/api\/appearance\/files\/brand-logo-[\w-]+\.png$/);
  const img = await fetch(base + withLogo.logo);
  assert.equal(img.status, 200, 'public: the sign-in page shows it');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/api/appearance/files/brand-logo-guess.png`)).status, 404, 'only current files');

  const replaced = (await call('POST', '/api/appearance/logo', PNG, ADMIN, 'image/png')).data;
  assert.notEqual(replaced.logo, withLogo.logo);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('brand-logo-')).length, 1, 'the old file is removed');

  const bg = (await call('POST', '/api/appearance/background', PNG, ADMIN, 'image/png')).data;
  assert.ok(bg.background_image);
  assert.equal((await call('PUT', '/api/appearance', { background_dim: 40 })).data.background_dim, 40);
  assert.match((await call('GET', '/appearance.css', undefined, null)).data, /--bg-dim: 40%/);
  assert.equal((await call('DELETE', '/api/appearance/background')).data.background_image, null);

  const reset = (await call('POST', '/api/appearance/reset')).data;
  assert.deepEqual([reset.accent, reset.logo, reset.background_image], [null, null, null]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('brand-')), []);
});

test('the sign-in page loads the appearance without signing in', async () => {
  const page = await fetch(`${base}/login`);
  assert.match(await page.text(), /href="\/appearance\.css"/);
  assert.equal((await call('GET', '/api/appearance', undefined, null)).status, 200);
});
