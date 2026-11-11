// Social posts made from scratch, uploads, AI writing, scheduling with approval ahead of time, Reels and
// AI intro clips.
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
process.env.ANTHROPIC_API_KEY = '';
process.env.BRAND_PHONE = '702-555-0100';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createVideoAi } = require('../src/aivideo');
const { basicPost } = require('../src/socialwriter');
const { makeReel } = require('../src/reel');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-plan-'));
const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const calls = [];
async function fakeFetch(url, options = {}) {
  const u = String(url);
  calls.push({ url: u, body: typeof options.body === 'string' ? options.body : '', raw: options.body });
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('graph.facebook.com')) {
    if (u.includes('fields=status_code')) return ok({ status_code: 'FINISHED' });
    if (u.endsWith('/feed')) return ok({ id: '1111_999' });
    return ok({ id: `m${calls.length}` });
  }
  if (u.includes('creator_info')) return ok({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } });
  if (u.includes('open.tiktokapis.com')) return ok({ data: { publish_id: 'p_9' }, error: { code: 'ok' } });
  if (u.includes('oauth2.googleapis.com')) return ok({ access_token: 'ya29', expires_in: 3600 });
  if (u.includes('googleapis.com/upload/youtube')) return ok({ id: 'yt9', status: { uploadStatus: 'uploaded' } });
  return ok({});
}
// The video maker, pretend (the real one is tested at the bottom).
const reels = [];
const fakeMedia = {
  async preparePhoto(src, out) { fs.copyFileSync(src, out); },
  async makeVideo(photos, out) { fs.writeFileSync(out, 'slideshow'); },
  async makeReel(segments, opts) { reels.push({ segments, opts }); fs.writeFileSync(opts.out, 'reel-video-bytes'); return { seconds: 12 }; },
};
// AI video, pretend: ready on the first check.
const fakeVideoAi = {
  configured: true,
  started: [],
  async start(prompt) { this.started.push(prompt); return { op: 'models/veo/operations/op1' }; },
  async check() { return { done: true, uri: 'https://generativelanguage.googleapis.com/v1beta/files/x:download' }; },
  async download(uri, out) { fs.writeFileSync(out, 'ai-clip'); },
};

let server;
let base;
let db;
let social;
before(async () => {
  db = openDatabase(':memory:');
  const app = createApp({ db, fetchImpl: fakeFetch, photosDir: path.join(dir, 'photos'), socialMedia: fakeMedia, videoAi: fakeVideoAi });
  social = app.services.social;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SALES = auth('Sam', 'sales-pass');
const SHOP = auth('Mike', 'shop-pass');
async function call(method, url, body, a = ADMIN, raw = null, type = 'image/jpeg') {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': raw ? type : 'application/json' }, body: raw || (body && JSON.stringify(body)) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
let n = 0;
async function jobWithPhotos({ ok = true } = {}) {
  n += 1;
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Ana Cruz', phone: `702-555-02${String(n).padStart(2, '0')}`, vehicle_type: 'Car', vehicle_year: '2022', vehicle_make: 'Porsche', vehicle_model: '911', vehicle_color: 'Guards Red' })).data;
  const day = new Date(); day.setDate(day.getDate() + 3); day.setHours(8, 0, 0, 0);
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: day.toISOString(), job_hours: 4, send_confirmation: false });
  const job = (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
  const b = (await call('POST', `/api/jobs/${job.id}/photos?phase=before`, null, SHOP, TINY_JPEG)).data;
  const a = (await call('POST', `/api/jobs/${job.id}/photos?phase=after`, null, SHOP, TINY_JPEG)).data;
  if (ok) await call('PATCH', `/api/jobs/${job.id}/social-ok`, { ok: true }, SHOP);
  const photos = (await call('GET', `/api/jobs/${job.id}`)).data.photos;
  return { job, photos: photos.length ? photos : [b, a] };
}
const DAY = 86400000;
const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();

test('a post from scratch: uploads, photos from any OK\'d job, a written caption, and only admins', async () => {
  const ok = await jobWithPhotos();
  const notOk = await jobWithPhotos({ ok: false });
  assert.equal((await call('POST', '/api/social', { post_type: 'offer' }, SALES)).status, 403, 'admins only');
  const p = (await call('POST', '/api/social', { post_type: 'offer', title: 'December special' })).data;
  assert.deepEqual([p.status, p.kind, p.post_type, p.title, p.items.length, p.job], ['draft', 'custom', 'offer', 'December special', 0, null]);
  assert.equal((await call('POST', '/api/social', { post_type: 'nope' })).status, 400);

  // The library: only jobs whose customer said OK, and the uploads.
  const up = (await call('POST', '/api/social/media?name=shop.jpg', null, ADMIN, TINY_JPEG)).data;
  assert.deepEqual([up.kind, up.name], ['photo', 'shop.jpg']);
  const clip = (await call('POST', '/api/social/media?name=polish.mp4', null, ADMIN, Buffer.from('fake-mp4-bytes-here'), 'video/mp4')).data;
  assert.equal(clip.kind, 'clip');
  assert.equal((await call('POST', '/api/social/media', null, ADMIN, Buffer.from('%PDF'), 'application/pdf')).status, 400);
  const lib = (await call('GET', '/api/social/library')).data;
  assert.ok(lib.jobs.some((j) => j.id === ok.job.id));
  assert.ok(!lib.jobs.some((j) => j.id === notOk.job.id), 'no OK, not offered');
  assert.equal(lib.uploads.length, 2);

  // A photo from a job without the OK is refused.
  const bad = await call('PATCH', `/api/social/${p.id}`, { items: [{ src: 'job', job_id: notOk.job.id, photo_id: notOk.photos[0].id }] });
  assert.match(bad.data.error, /hasn't OK'd/);

  const items = [{ src: 'job', job_id: ok.job.id, photo_id: ok.photos[0].id }, { src: 'upload', id: up.id }, { src: 'upload', id: clip.id }];
  const saved = (await call('PATCH', `/api/social/${p.id}`, { items, notes: '15% off ceramic coatings booked in December', overlay: { hook: 'December only', end_text: 'Call to book' } })).data;
  assert.deepEqual(saved.items.map((i) => i.kind), ['photo', 'photo', 'clip']);
  assert.equal(saved.items[0].phase, 'before');
  assert.deepEqual(saved.overlay, { hook: 'December only', end_text: 'Call to book' });

  // Write it for me (no Claude key here: the template), with the notes and the shop's phone.
  const w = (await call('POST', `/api/social/${p.id}/write`)).data;
  assert.equal(w.source, 'basic');
  assert.match(w.suggestion.caption, /15% off ceramic coatings booked in December/);
  assert.match(w.suggestion.caption, /#ceramiccoating/);
  assert.ok(w.suggestion.hook && w.suggestion.clip_prompt);
  assert.doesNotMatch(JSON.stringify(w), /Ana|Cruz/);

  // A clip can't go out as photos.
  await call('PATCH', `/api/social/${p.id}`, { caption: w.suggestion.caption, video_style: 'photos' });
  assert.match((await call('POST', `/api/social/${p.id}/schedule`, { at: inDays(5) })).data.error, /Clips only go in a Reel/);
  await call('PATCH', `/api/social/${p.id}`, { video_style: 'reel' });

  // The upload plays back to admins, in pieces too (phones ask for byte ranges).
  const res = await fetch(`${base}/api/social/media/${clip.id}`, { headers: { Authorization: ADMIN, Range: 'bytes=0-3' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'fake');
  assert.equal((await fetch(`${base}/api/social/media/${clip.id}`, { headers: { Authorization: SHOP } })).status, 403);
  // In a post that hasn't gone out: can't be deleted.
  assert.match((await call('DELETE', `/api/social/media/${clip.id}`)).data.error, /hasn't gone out/);
});

test('scheduling needs the approval lead time; approved posts go out at their time; late ones go back to Drafts', async () => {
  const { drafts } = (await call('GET', '/api/social')).data;
  const p = drafts.find((x) => x.title === 'December special');
  // At least 2 days out (the default), so there's time to approve it.
  assert.match((await call('POST', `/api/social/${p.id}/schedule`, { at: inDays(1) })).data.error, /at least 2 days out/);
  assert.match((await call('POST', `/api/social/${p.id}/schedule`, { at: 'whenever' })).data.error, /Pick a day and time/);
  const at = inDays(4);
  const s = (await call('POST', `/api/social/${p.id}/schedule`, { at })).data;
  assert.equal(s.status, 'scheduled');
  assert.equal(s.submitted_by, 'Dylan');
  assert.equal(new Date(s.approve_by).getTime(), new Date(at).getTime() - 2 * DAY, 'approve 2 days before');
  assert.ok((await call('GET', '/api/social/waiting')).data.count >= 1, 'it counts on the Social badge until approved');
  assert.match((await call('PATCH', `/api/social/${p.id}`, { caption: 'changed' })).data.error, /Move it back to Drafts/);
  assert.match((await call('POST', `/api/social/${p.id}/post`)).data.error, /needs approving first/);

  // The schedule doesn't touch it before its time; approved, it goes out at its time.
  const ap = (await call('POST', `/api/social/${p.id}/approve`)).data;
  assert.deepEqual([ap.status, ap.approved_by], ['approved', 'Dylan']);
  assert.equal((await call('POST', `/api/social/${p.id}/approve`)).status, 400);
  assert.deepEqual(await social.runSchedule(new Date(Date.now() + DAY)), { missed: 0, posted: 0 });
  calls.length = 0;
  reels.length = 0;
  assert.deepEqual(await social.runSchedule(new Date(new Date(at).getTime() + 60000)), { missed: 0, posted: 1 });
  const done = (await call('GET', '/api/social')).data.done.find((x) => x.id === p.id);
  assert.equal(done.status, 'posted', JSON.stringify(done.results));
  assert.equal(done.decided_by, 'Dylan');
  // One Reel everywhere: the photos and the clip, with the words on screen.
  assert.equal(reels.length, 1);
  assert.deepEqual(reels[0].segments.map((x) => [x.kind, x.label]), [['photo', 'BEFORE'], ['photo', null], ['clip', null]]);
  assert.deepEqual([reels[0].opts.hook, reels[0].opts.endText, reels[0].opts.phone], ['December only', 'Call to book', '702-555-0100']);
  const fb = calls.find((c) => c.url.includes('/1111/videos'));
  assert.match(JSON.parse(fb.body).file_url, /^https:\/\/leads\.example\.com\/social\/media\/[\w-]{20,}\/reel\.mp4$/);
  const ig = calls.filter((c) => c.url.includes('/2222/media'));
  assert.equal(JSON.parse(ig[0].body).media_type, 'REELS');
  assert.ok(calls.some((c) => c.url.includes('fields=status_code')), 'waits for Instagram to process it');
  const tt = JSON.parse(calls.find((c) => c.url.includes('video/init')).body);
  assert.deepEqual([tt.source_info.source, tt.post_info.is_aigc], ['PULL_FROM_URL', false]);
  // The platforms can fetch the Reel from the public address.
  const local = JSON.parse(fb.body).file_url.replace('https://leads.example.com', base);
  assert.equal(await (await fetch(local)).text(), 'reel-video-bytes');

  // Not approved in time: back to Drafts, marked missed; approving late is refused.
  const late = (await call('POST', '/api/social', { post_type: 'tip' })).data;
  const up = (await call('GET', '/api/social/library')).data.uploads.find((u) => u.kind === 'photo');
  await call('PATCH', `/api/social/${late.id}`, { items: [{ src: 'upload', id: up.id }], caption: 'Skip the automatic car wash.' });
  const ls = (await call('POST', `/api/social/${late.id}/schedule`, { at: inDays(3) })).data;
  db.prepare('UPDATE social_posts SET approve_by = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), late.id);
  assert.match((await call('POST', `/api/social/${late.id}/approve`)).data.error, /past the time to approve/);
  assert.equal((await social.runSchedule()).missed, 1);
  const back = (await call('GET', '/api/social')).data.drafts.find((x) => x.id === late.id);
  assert.equal(back.status, 'draft');
  assert.ok(back.missed_at);
  assert.equal(back.scheduled_for, ls.scheduled_for, 'keeps the time it was meant for, to show');
  // Move a scheduled post back to Drafts.
  const again = (await call('POST', `/api/social/${late.id}/schedule`, { at: inDays(6) })).data;
  assert.equal((await call('POST', `/api/social/${again.id}/unschedule`)).data.status, 'draft');
});

test('the approval lead time is a setting (0 to 14 days); music is uploaded under settings', async () => {
  assert.equal((await call('PUT', '/api/social/settings', { approve_days: 15 })).status, 400);
  assert.equal((await call('PUT', '/api/social/settings', { approve_days: 1 })).data.approve_days, 1);
  const p = (await call('POST', '/api/social', { post_type: 'behind' })).data;
  const up = (await call('GET', '/api/social/library')).data.uploads.find((u) => u.kind === 'photo');
  await call('PATCH', `/api/social/${p.id}`, { items: [{ src: 'upload', id: up.id }], caption: 'Inside the shop.' });
  assert.equal((await call('POST', `/api/social/${p.id}/schedule`, { at: inDays(1.5) })).data.status, 'scheduled');
  await call('PUT', '/api/social/settings', { approve_days: 2 });

  assert.equal((await call('POST', '/api/social/media?kind=music', null, ADMIN, TINY_JPEG)).status, 400, 'music is audio');
  const s = (await call('POST', '/api/social/media?kind=music&name=track.mp3', null, ADMIN, Buffer.from('ID3fake'), 'audio/mpeg')).data;
  assert.equal(s.music.name, 'track.mp3');
  assert.equal((await call('GET', '/api/social')).data.settings.music.name, 'track.mp3');
});

test('an AI intro clip: made in the background, labeled on every platform, only in a Reel', async () => {
  const { job, photos } = await jobWithPhotos();
  const p = (await call('POST', '/api/social', { post_type: 'before_after' })).data;
  await call('PATCH', `/api/social/${p.id}`, { items: photos.map((x) => ({ src: 'job', job_id: job.id, photo_id: x.id })), caption: 'Guards Red, glassed.', video_style: 'photos' });
  assert.match((await call('POST', `/api/social/${p.id}/ai-clip`, { prompt: 'hi' })).data.error, /Describe the clip/);
  const started = (await call('POST', `/api/social/${p.id}/ai-clip`, { prompt: 'Water beading on red paint, slow motion' })).data;
  assert.deepEqual([started.ai_clip.status, started.video_style], ['making', 'reel'], 'an AI clip makes it a Reel');
  assert.equal(started.ai_clip.op, undefined, 'the job id stays on the server');
  assert.match((await call('POST', `/api/social/${p.id}/post`)).data.error, /still being made/);
  await social.checkClips({ force: true });
  const ready = (await call('GET', '/api/social')).data.drafts.find((x) => x.id === p.id);
  assert.deepEqual([ready.ai_clip.status, ready.ai_used], ['ready', true]);
  const clipRes = await fetch(`${base}/api/social/${p.id}/ai-clip.mp4`, { headers: { Authorization: ADMIN } });
  assert.equal(await clipRes.text(), 'ai-clip');

  calls.length = 0;
  reels.length = 0;
  const done = (await call('POST', `/api/social/${p.id}/post`)).data;
  assert.equal(done.status, 'posted', JSON.stringify(done.results));
  assert.ok(reels[0].opts.intro.endsWith('ai-intro.mp4'), 'the clip opens the Reel');
  const tt = JSON.parse(calls.find((c) => c.url.includes('video/init')).body);
  assert.equal(tt.post_info.is_aigc, true, 'TikTok\'s AI label');
  assert.match(tt.post_info.title, /Intro clip made with AI\./, 'and said in the caption');
  const yt = Buffer.from(calls.find((c) => c.url.includes('upload/youtube')).raw).toString('latin1');
  assert.match(yt, /"containsSyntheticMedia":true/, 'YouTube\'s AI label');
  assert.match(JSON.parse(calls.find((c) => c.url.includes('/1111/videos')).body).description, /made with AI/);
});

test('the customer takes back their OK: other posts lose those photos and go back to Drafts', async () => {
  const { job, photos } = await jobWithPhotos();
  const up = (await call('GET', '/api/social/library')).data.uploads.find((u) => u.kind === 'photo');
  const p = (await call('POST', '/api/social', { post_type: 'showcase' })).data;
  await call('PATCH', `/api/social/${p.id}`, { items: [{ src: 'job', job_id: job.id, photo_id: photos[1].id }, { src: 'upload', id: up.id }], caption: 'Showroom ready.' });
  await call('POST', `/api/social/${p.id}/schedule`, { at: inDays(3) });
  await call('POST', `/api/social/${p.id}/approve`);
  await call('PATCH', `/api/jobs/${job.id}/social-ok`, { ok: false }, SHOP);
  const back = (await call('GET', '/api/social')).data.drafts.find((x) => x.id === p.id);
  assert.equal(back.status, 'draft');
  assert.deepEqual(back.items.map((i) => i.src), ['upload']);
});

test('AI video through the Gemini API: start, check, download (the key never follows a redirect)', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), opts });
    const j = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith(':predictLongRunning')) return j({ name: 'models/veo-3.1-generate-preview/operations/abc123' });
    if (String(url).includes('/operations/abc123')) return j({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media' } }] } } });
    if (String(url).includes('files/f1')) return new Response(null, { status: 302, headers: { location: 'https://storage.example.com/clip.mp4' } });
    if (String(url).includes('storage.example.com')) return new Response('MP4DATA', { status: 200 });
    return j({ error: { message: 'unexpected' } }, 400);
  };
  const ai = createVideoAi({ apiKey: 'g-key', fetchImpl });
  const { op } = await ai.start('Glossy hood under a light bar');
  const body = JSON.parse(seen[0].opts.body);
  assert.equal(body.parameters.aspectRatio, '9:16');
  assert.match(body.instances[0].prompt, /^Glossy hood under a light bar .*No people.*no license plates/);
  assert.equal(seen[0].opts.headers['x-goog-api-key'], 'g-key');
  const r = await ai.check(op);
  assert.equal(r.done, true);
  const out = path.join(dir, 'clip.mp4');
  await ai.download(r.uri, out);
  assert.equal(fs.readFileSync(out, 'utf8'), 'MP4DATA');
  assert.equal(seen.at(-1).opts?.headers, undefined, 'no key sent to the storage address');
  assert.equal(createVideoAi({ apiKey: '' }).configured, false);
});

test('the template writer, for each kind of post', () => {
  const brand = { name: 'Bob Moses', city: 'Las Vegas', phone: '702-555-0100' };
  const offer = basicPost({ type: 'offer', notes: 'Free wheel coating with any full coat this month', brand });
  assert.match(offer.caption, /Free wheel coating/);
  assert.match(offer.caption, /702-555-0100/);
  assert.match(offer.hashtags, /#lasvegas/);
  assert.match(basicPost({ type: 'before_after', vehicles: ['2022 Porsche 911'], brand }).caption, /^2022 Porsche 911: before and after/);
});

test('the real Reel maker: a 1080x1920 video with sound', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const a = path.join(dir, 'a.jpg');
  const b = path.join(dir, 'b.jpg');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=800x600', '-frames:v', '1', a]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=600x800', '-frames:v', '1', b]);
  const out = path.join(dir, 'reel.mp4');
  const r = await makeReel([{ kind: 'photo', path: a, label: 'BEFORE' }, { kind: 'photo', path: b, label: 'AFTER' }],
    { out, workDir: path.join(dir, 'rw'), hook: 'Watch the gloss come back', endText: 'Book yours', phone: '702-555-0100', brandName: 'Bob Moses' });
  assert.ok(r.seconds > 6 && r.seconds < 10, String(r.seconds));
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'csv=p=0', out]).toString();
  assert.match(info, /video,1080,1920/);
  assert.match(info, /audio/);
});

test('an older database upgrades: posts kept, a post no longer needs a job', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE social_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    caption TEXT NOT NULL, photo_ids TEXT NOT NULL, platforms TEXT NOT NULL, results TEXT, media_token TEXT, created_by TEXT, created_at TEXT NOT NULL,
    decided_by TEXT, decided_at TEXT, posted_at TEXT);
    INSERT INTO social_posts (job_id, status, caption, photo_ids, platforms, created_at) VALUES (7, 'posted', 'Old post', '[1]', '["facebook"]', '2026-10-01');`);
  old.close();
  const db2 = openDatabase(file);
  assert.equal(db2.prepare('PRAGMA table_info(social_posts)').all().find((c) => c.name === 'job_id').notnull, 0);
  assert.equal(db2.prepare('SELECT caption FROM social_posts WHERE id = 1').get().caption, 'Old post');
  db2.prepare("INSERT INTO social_posts (job_id, status, caption, photo_ids, platforms, created_at) VALUES (NULL, 'draft', '', '[]', '[]', 'x')").run();
  db2.close();
  assert.equal(openDatabase(file).prepare('SELECT COUNT(*) AS n FROM social_posts').get().n, 2, 'opening again changes nothing');
});
