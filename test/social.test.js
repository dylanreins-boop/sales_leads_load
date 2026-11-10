const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.PUBLIC_URL = 'https://leads.example.com';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token';
process.env.FB_PAGE_ID = '1111';
process.env.IG_USER_ID = '2222';
process.env.TIKTOK_ACCESS_TOKEN = 'tt-token';
process.env.YOUTUBE_CLIENT_ID = 'yt-id';
process.env.YOUTUBE_CLIENT_SECRET = 'yt-secret';
process.env.YOUTUBE_REFRESH_TOKEN = 'yt-refresh';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.EMAIL_PROVIDER = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
// A real little photo (a solid colour), made with ffmpeg; without ffmpeg, a tiny JPEG.
function photo(color) {
  const file = path.join(dir, `${color}.jpg`);
  if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x480`, '-frames:v', '1', file]);
  else fs.writeFileSync(file, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'));
  return fs.readFileSync(file);
}

// Pretend Facebook, Instagram, TikTok and Google.
const calls = [];
let failInstagram = true;
async function fakeFetch(url, options = {}) {
  const u = String(url);
  const body = typeof options.body === 'string' ? options.body : options.body ? `<${options.body.length} bytes>` : '';
  calls.push({ url: u, body, raw: options.body });
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('graph.facebook.com')) {
    if (u.includes('/2222/') && failInstagram) return new Response(JSON.stringify({ error: { message: 'Instagram is busy, try again' } }), { status: 400 });
    if (u.endsWith('/feed')) return ok({ id: '1111_999' });
    return ok({ id: `m${calls.length}` });
  }
  if (u.includes('creator_info')) return ok({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } });
  if (u.includes('open.tiktokapis.com')) return ok({ data: { publish_id: 'p_123' }, error: { code: 'ok' } });
  if (u.includes('oauth2.googleapis.com')) return ok({ access_token: 'ya29', expires_in: 3600 });
  if (u.includes('googleapis.com/upload/youtube')) return ok({ id: 'yt777', status: { uploadStatus: 'uploaded' } });
  return ok({});
}

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: fakeFetch, photosDir: path.join(dir, 'photos') }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SHOP = auth('Mike', 'shop-pass');
async function call(method, url, body, a = ADMIN, raw = null) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': raw ? 'image/jpeg' : 'application/json' }, body: raw || (body && JSON.stringify(body)) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let n = 0;
async function finishedJob({ ok = true } = {}) {
  n += 1;
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Ana Cruz', phone: `702-555-01${String(n).padStart(2, '0')}`, vehicle_type: 'Car', vehicle_year: '2023', vehicle_make: 'Tesla', vehicle_model: 'Model 3', vehicle_color: 'Pearl White' })).data;
  const day = new Date(); day.setDate(day.getDate() + ((8 - day.getDay()) % 7 || 7)); day.setHours(8, 0, 0, 0);
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: day.toISOString(), job_hours: 4, send_confirmation: false });
  const job = (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
  await call('POST', `/api/jobs/${job.id}/photos?phase=before`, null, SHOP, photo('gray'));
  await call('POST', `/api/jobs/${job.id}/photos?phase=after`, null, SHOP, photo('navy'));
  await call('POST', `/api/jobs/${job.id}/photos?phase=after`, null, SHOP, photo('white'));
  if (ok) assert.equal((await call('PATCH', `/api/jobs/${job.id}/social-ok`, { ok: true }, SHOP)).data.social_ok, 1);
  return job;
}

test('a finished job with the customer\'s OK waits for an admin as a draft post, with no names in it', async () => {
  const noOk = await finishedJob({ ok: false });
  await call('PATCH', `/api/jobs/${noOk.id}`, { status: 'ready' }, SHOP);
  assert.equal((await call('GET', '/api/social/waiting')).data.count, 0, 'no OK, no draft');
  assert.match((await call('POST', `/api/social/jobs/${noOk.id}`)).data.error, /hasn't OK'd/);

  const job = await finishedJob();
  const r = await call('PATCH', `/api/jobs/${job.id}`, { status: 'ready' }, SHOP);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call('GET', '/api/social/waiting')).data.count, 1);
  assert.equal((await call('GET', '/api/social', undefined, SHOP)).status, 403, 'admins only');
  const { waiting, connections } = (await call('GET', '/api/social')).data;
  assert.deepEqual(connections, { facebook: true, instagram: true, tiktok: true, youtube: true });
  const d = waiting[0];
  assert.equal(d.job.id, job.id);
  assert.equal(d.photo_ids.length, 3, 'the before photo, then the two after photos');
  assert.match(d.caption, /^2023 Tesla Model 3 in Pearl White: Full decon & coat\. Coated and protected by Bob Moses Ceramic Coating in Las Vegas/);
  assert.match(d.caption, /#tesla/);
  assert.doesNotMatch(d.caption, /Ana|Cruz/, 'never the customer\'s name');
  assert.deepEqual(d.platforms, ['facebook', 'instagram', 'tiktok', 'youtube']);

  // Picked up later: still one draft.
  await call('PATCH', `/api/jobs/${job.id}`, { status: 'picked_up' }, SHOP);
  assert.equal((await call('GET', '/api/social/waiting')).data.count, 1);
});

test('Post it: Facebook, TikTok and YouTube go; a failed Instagram is kept and retried', async () => {
  const { waiting } = (await call('GET', '/api/social')).data;
  const d = waiting[0];
  const edited = (await call('PATCH', `/api/social/${d.id}`, { caption: 'Fresh coat on a Model 3. #ceramiccoating', photo_ids: d.photo_ids.slice(1) })).data;
  assert.equal(edited.photo_ids.length, 2);
  calls.length = 0;
  const done = (await call('POST', `/api/social/${d.id}/post`)).data;
  assert.equal(done.status, 'partly', JSON.stringify(done.results));
  assert.deepEqual(Object.fromEntries(Object.entries(done.results).map(([k, v]) => [k, v.status])), { facebook: 'posted', instagram: 'failed', tiktok: 'posted', youtube: 'posted' });
  assert.equal(done.results.facebook.url, 'https://www.facebook.com/1111_999');
  assert.match(done.results.instagram.error, /Instagram is busy/);
  assert.match(done.results.tiktok.note, /private/, 'TikTok hasn\'t approved the app yet');
  assert.equal(done.results.youtube.url, 'https://youtube.com/shorts/yt777');

  // Facebook got the photos by public address, unpublished, then one post with them.
  const fb = calls.filter((c) => c.url.includes('/1111/photos'));
  assert.equal(fb.length, 2);
  const mediaUrl = JSON.parse(fb[0].body).url;
  assert.match(mediaUrl, /^https:\/\/leads\.example\.com\/social\/media\/[\w-]{20,}\/1\.jpg$/);
  assert.equal(JSON.parse(calls.find((c) => c.url.endsWith('/feed')).body).attached_media.length, 2);
  // TikTok: a photo post pulled from those addresses, private.
  const tt = JSON.parse(calls.find((c) => c.url.includes('content/init')).body);
  assert.deepEqual([tt.media_type, tt.post_info.privacy_level, tt.source_info.photo_images.length], ['PHOTO', 'SELF_ONLY', 2]);
  // YouTube: an mp4 in the upload, titled for Shorts.
  const yt = calls.find((c) => c.url.includes('upload/youtube'));
  const uploaded = Buffer.from(yt.raw);
  assert.match(uploaded.toString('latin1'), /#Shorts/);
  if (hasFfmpeg) assert.ok(uploaded.includes(Buffer.from('ftyp')), 'a real mp4 video');

  // The platforms can fetch the photos without signing in; a wrong token gets nothing.
  const local = mediaUrl.replace('https://leads.example.com', base);
  const got = await fetch(local);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  if (hasFfmpeg) assert.equal(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-'], { input: Buffer.from(await got.arrayBuffer()) }).toString().trim(), '1080,1350');
  assert.equal((await fetch(local.replace(/media\/[\w-]+/, 'media/not-the-right-token-at-all'))).status, 404);

  // Try again: only Instagram goes again, now as a carousel.
  failInstagram = false;
  calls.length = 0;
  const again = (await call('POST', `/api/social/${d.id}/retry`)).data;
  assert.equal(again.status, 'posted');
  assert.equal(again.results.instagram.status, 'posted');
  assert.ok(!calls.some((c) => c.url.includes('/1111/') || c.url.includes('tiktok') || c.url.includes('youtube')), 'the others aren\'t posted twice');
  assert.ok(calls.some((c) => c.url.includes('/2222/media') && JSON.parse(c.body).media_type === 'CAROUSEL'));
  assert.equal((await call('POST', `/api/social/${d.id}/post`)).status, 400, 'posted once');
  assert.equal((await call('GET', '/api/social/waiting')).data.count, 0);
});

test('admins can skip a draft, make one by hand, and change the defaults', async () => {
  const job = await finishedJob();
  const d = (await call('POST', `/api/social/jobs/${job.id}`)).data;
  assert.equal(d.status, 'draft');
  assert.equal((await call('POST', `/api/social/${d.id}/skip`)).data.status, 'skipped');
  const saved = (await call('PUT', '/api/social/settings', { auto_draft: false, platforms: ['facebook', 'instagram', 'myspace'], hashtags: '#bobmoses' })).data;
  assert.deepEqual([saved.auto_draft, saved.platforms, saved.hashtags], [false, ['facebook', 'instagram'], '#bobmoses']);
  const next = await finishedJob();
  await call('PATCH', `/api/jobs/${next.id}`, { status: 'ready' }, SHOP);
  assert.equal((await call('GET', '/api/social/waiting')).data.count, 0, 'auto drafts turned off');
  const byHand = (await call('POST', `/api/social/jobs/${next.id}`)).data;
  assert.deepEqual(byHand.platforms, ['facebook', 'instagram']);
  assert.match(byHand.caption, /#bobmoses$/);
});
