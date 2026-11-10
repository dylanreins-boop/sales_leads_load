// Social posts from finished jobs. When a job is marked Ready for pickup (or Picked up), the customer
// OK'd posting at drop-off and there are after photos, a draft post waits for an admin: the before and
// after photos, a caption, and the platforms. On "Post it" the app posts it to Facebook (photos),
// Instagram (a carousel), TikTok (a photo post) and YouTube Shorts (a short before/after video made
// from the photos). Nothing is posted without an admin's OK, and captions never carry customer names.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HttpError } = require('./leads');
const { serviceLabels } = require('./services');

const PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube Shorts' };
const DEFAULTS = {
  auto_draft: true,
  platforms: ['facebook', 'instagram', 'tiktok', 'youtube'],
  caption: '{vehicle}{color}: {services}. Coated and protected by {company} in {city}. Book yours: {phone}',
  hashtags: '#ceramiccoating #{make} #lasvegas #detailing #paintprotection',
};
const MAX_PHOTOS = 8;
const now = () => new Date().toISOString();

// Runs ffmpeg (if it's installed) with an argument list, no shell.
function ffmpeg(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let err = '';
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Making the video took too long.')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'The server has no video maker (ffmpeg) installed.' : e.message)); });
    p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new Error(`ffmpeg failed: ${err.trim().split('\n').pop() || code}`)); });
  });
}

// Each photo as a 1080x1350 JPEG (Instagram's tallest shape), padded rather than cropped, so the
// whole vehicle shows.
const PAD = 'scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=0x0b1626,setsar=1';
async function preparePhoto(src, out) {
  await ffmpeg(['-i', src, '-vf', PAD, '-frames:v', '1', '-q:v', '3', out]);
}
// A vertical 1080x1920 video: each photo for 2.5 seconds, before photos first. No sound.
async function makeVideo(photos, out) {
  const inputs = photos.flatMap((p) => ['-loop', '1', '-t', '2.5', '-i', p]);
  const scale = photos.map((_, i) => `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0b1626,setsar=1,fps=30[v${i}]`).join(';');
  const concat = `${photos.map((_, i) => `[v${i}]`).join('')}concat=n=${photos.length}:v=1:a=0,format=yuv420p[out]`;
  await ffmpeg([...inputs, '-filter_complex', `${scale};${concat}`, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', out]);
}

function createSocialService(db, { jobs, keys = {}, brand = {}, publicUrl = '', mediaDir, fetchImpl = (...a) => fetch(...a), media = { preparePhoto, makeVideo } }) {
  const stmt = (sql) => db.prepare(sql);

  // ---- settings and connections ----
  function getSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(stmt("SELECT value FROM settings WHERE key = 'social'").get()?.value || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings(input = {}) {
    const next = getSettings();
    if ('auto_draft' in input) next.auto_draft = Boolean(input.auto_draft);
    if ('platforms' in input) next.platforms = (input.platforms || []).filter((p) => PLATFORMS[p]);
    if ('caption' in input) {
      const c = String(input.caption || '').trim();
      if (!c) throw new HttpError(400, 'Write a caption template.');
      next.caption = c.slice(0, 1000);
    }
    if ('hashtags' in input) next.hashtags = String(input.hashtags || '').trim().slice(0, 300);
    stmt("INSERT INTO settings (key, value) VALUES ('social', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }
  // What each platform needs to post. Instagram, Facebook and TikTok fetch the photos from the app's
  // public address, so PUBLIC_URL is needed too.
  function connections() {
    const yt = keys.youtube || {};
    const tt = keys.tiktok || {};
    return {
      facebook: Boolean(keys.facebookPageId && keys.facebookToken && publicUrl),
      instagram: Boolean(keys.instagramUserId && keys.facebookToken && publicUrl),
      tiktok: Boolean((tt.accessToken || (tt.clientKey && tt.clientSecret && tt.refreshToken)) && publicUrl),
      youtube: Boolean(yt.clientId && yt.clientSecret && yt.refreshToken),
    };
  }

  // ---- drafts ----
  const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
  const vehicle = (j) => [j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || j.vehicle_type || 'Vehicle';
  function captionFor(job, settings = getSettings()) {
    const fill = (t) => t
      .replace(/\{vehicle\}/g, vehicle(job))
      .replace(/\{color\}/g, job.vehicle_color ? ` in ${job.vehicle_color}` : '')
      .replace(/\{services\}/g, serviceLabels(job.services || []) || 'ceramic coating')
      .replace(/\{company\}/g, brand.name || 'us')
      .replace(/\{city\}/g, brand.city || 'town')
      .replace(/\{phone\}/g, brand.phone || '')
      .replace(/\{make\}/g, String(job.vehicle_make || 'cars').toLowerCase().replace(/[^a-z0-9]/g, ''));
    return [fill(settings.caption), fill(settings.hashtags)].filter(Boolean).join('\n\n').trim();
  }
  // Before photos first (up to 2), then the after photos.
  const pickPhotos = (job) => [
    ...job.photos.filter((p) => p.phase === 'before').slice(0, 2),
    ...job.photos.filter((p) => p.phase === 'after'),
  ].slice(0, MAX_PHOTOS).map((p) => p.id);

  function shape(row) {
    if (!row) return null;
    const job = jobs.getJob(row.job_id);
    return {
      ...row,
      photo_ids: parse(row.photo_ids, []),
      platforms: parse(row.platforms, []),
      results: parse(row.results, {}),
      job: {
        id: job.id, lead_id: job.lead_id, status: job.status, customer: job.full_name || [job.first_name, job.last_name].filter(Boolean).join(' '),
        vehicle: [vehicle(job), job.vehicle_color].filter(Boolean).join(' · '), social_ok: job.social_ok === 1,
        photos: job.photos.map((p) => ({ id: p.id, phase: p.phase, caption: p.caption })),
      },
    };
  }
  const byId = (id) => shape(stmt('SELECT * FROM social_posts WHERE id = ?').get(id));

  function draftFor(jobId, { user = null } = {}) {
    const job = jobs.getJob(jobId);
    const existing = stmt("SELECT * FROM social_posts WHERE job_id = ? AND status != 'skipped' ORDER BY id DESC LIMIT 1").get(jobId);
    if (existing) return shape(existing);
    if (job.social_ok !== 1) throw new HttpError(400, 'The customer hasn\'t OK\'d posting photos of their vehicle. Tick it on the job first.');
    if (!job.photos.some((p) => p.phase === 'after')) throw new HttpError(400, 'Add after photos first.');
    const settings = getSettings();
    const { lastInsertRowid } = stmt('INSERT INTO social_posts (job_id, status, caption, photo_ids, platforms, created_by, created_at) VALUES (?, \'draft\', ?, ?, ?, ?, ?)')
      .run(jobId, captionFor(job, settings), JSON.stringify(pickPhotos(job)), JSON.stringify(settings.platforms), user, now());
    return byId(Number(lastInsertRowid));
  }
  // A job just finished: make the draft if everything's there (quietly skip if not).
  function autoDraft(jobId) {
    if (!getSettings().auto_draft) return null;
    try { return draftFor(jobId); } catch { return null; }
  }

  function list() {
    return {
      waiting: stmt("SELECT * FROM social_posts WHERE status = 'draft' ORDER BY id DESC").all().map(shape),
      done: stmt("SELECT * FROM social_posts WHERE status != 'draft' ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 40").all().map(shape),
    };
  }
  const waitingCount = () => stmt("SELECT COUNT(*) AS n FROM social_posts WHERE status = 'draft'").get().n;

  function update(id, { caption, photo_ids: photoIds, platforms } = {}) {
    const post = byId(id);
    if (!post) throw new HttpError(404, 'That post is gone.');
    if (post.status !== 'draft') throw new HttpError(400, 'It\'s already been posted or skipped.');
    if (caption != null) {
      const c = String(caption).trim();
      if (!c) throw new HttpError(400, 'Write a caption.');
      if (c.length > 2200) throw new HttpError(400, 'Keep the caption under 2,200 characters (Instagram\'s limit).');
      stmt('UPDATE social_posts SET caption = ? WHERE id = ?').run(c, id);
    }
    if (photoIds) {
      const own = new Set(post.job.photos.map((p) => p.id));
      const ids = photoIds.map(Number).filter((x) => own.has(x)).slice(0, MAX_PHOTOS);
      if (!ids.length) throw new HttpError(400, 'Pick at least one photo.');
      stmt('UPDATE social_posts SET photo_ids = ? WHERE id = ?').run(JSON.stringify(ids), id);
    }
    if (platforms) stmt('UPDATE social_posts SET platforms = ? WHERE id = ?').run(JSON.stringify(platforms.filter((p) => PLATFORMS[p])), id);
    return byId(id);
  }

  function skip(id, { user } = {}) {
    const post = byId(id);
    if (!post) throw new HttpError(404, 'That post is gone.');
    if (post.status !== 'draft') throw new HttpError(400, 'It\'s already been posted or skipped.');
    stmt("UPDATE social_posts SET status = 'skipped', decided_by = ?, decided_at = ? WHERE id = ?").run(user ?? null, now(), id);
    return byId(id);
  }

  // ---- posting ----
  const dirFor = (post) => path.join(mediaDir, `post-${post.id}`);
  const mediaUrl = (post, name) => `${publicUrl}/social/media/${post.media_token}/${name}`;
  // The photos, ready to post (JPEG, 4:5), and the video when YouTube needs it.
  async function prepare(post, { video }) {
    const dir = dirFor(post);
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    for (const [i, id] of post.photo_ids.entries()) {
      const src = jobs.getPhoto(post.job_id, id).path;
      const name = `${i + 1}.jpg`;
      const out = path.join(dir, name);
      if (!fs.existsSync(out)) {
        try { await media.preparePhoto(src, out); } catch { fs.copyFileSync(src, out); } // no ffmpeg: the original
      }
      names.push(name);
    }
    let videoName = null;
    if (video) {
      videoName = 'video.mp4';
      const out = path.join(dir, videoName);
      if (!fs.existsSync(out)) await media.makeVideo(names.map((n) => path.join(dir, n)), out);
    }
    return { names, videoName };
  }

  async function json(url, options = {}) {
    const res = await fetchImpl(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error?.message || (body.error?.code && body.error.code !== 'ok')) {
      throw new Error(body.error?.message || body.error_description || body.error?.code || `${res.status} from ${new URL(url).hostname}`);
    }
    return body;
  }
  const graph = (p, params) => json(`https://graph.facebook.com/${keys.graphVersion || 'v23.0'}/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, access_token: keys.facebookToken }),
  });

  const post = {
    // Photos uploaded unpublished, then one post with all of them.
    async facebook(p, { names }) {
      const ids = [];
      for (const n of names) ids.push((await graph(`${keys.facebookPageId}/photos`, { url: mediaUrl(p, n), published: false })).id);
      const made = await graph(`${keys.facebookPageId}/feed`, { message: p.caption, attached_media: ids.map((id) => ({ media_fbid: id })) });
      return { id: made.id, url: `https://www.facebook.com/${made.id}` };
    },
    // One photo, or a carousel of up to 10; then published.
    async instagram(p, { names }) {
      const ig = keys.instagramUserId;
      let creation;
      if (names.length === 1) creation = (await graph(`${ig}/media`, { image_url: mediaUrl(p, names[0]), caption: p.caption })).id;
      else {
        const children = [];
        for (const n of names.slice(0, 10)) children.push((await graph(`${ig}/media`, { image_url: mediaUrl(p, n), is_carousel_item: true })).id);
        creation = (await graph(`${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: p.caption })).id;
      }
      const made = await graph(`${ig}/media_publish`, { creation_id: creation });
      return { id: made.id, url: 'https://www.instagram.com/' };
    },
    // A TikTok photo post. Until TikTok approves the app, posts can only be private.
    async tiktok(p, { names }) {
      const token = await tiktokToken();
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };
      const info = await json('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', { method: 'POST', headers: auth, body: '{}' });
      const options = info.data?.privacy_level_options || [];
      const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (options[0] || 'SELF_ONLY');
      const made = await json('https://open.tiktokapis.com/v2/post/publish/content/init/', {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          post_info: { title: p.caption.split('\n')[0].slice(0, 90), description: p.caption.slice(0, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
          source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: names.slice(0, 35).map((n) => mediaUrl(p, n)) },
          post_mode: 'DIRECT_POST', media_type: 'PHOTO',
        }),
      });
      return { id: made.data?.publish_id, url: 'https://www.tiktok.com/', note: privacy === 'PUBLIC_TO_EVERYONE' ? null : 'Posted as private: TikTok hasn\'t approved the app for public posts yet.' };
    },
    // A YouTube Short: the before/after video, uploaded with the caption.
    async youtube(p, { videoName }) {
      const yt = keys.youtube;
      const tok = await json('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: yt.clientId, client_secret: yt.clientSecret, refresh_token: yt.refreshToken, grant_type: 'refresh_token' }).toString(),
      });
      const first = p.caption.split('\n')[0];
      const meta = {
        snippet: { title: `${first.slice(0, 88)} #Shorts`.slice(0, 100), description: p.caption.slice(0, 4900), categoryId: '2' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      };
      const video = fs.readFileSync(path.join(dirFor(p), videoName));
      const boundary = `bm${crypto.randomUUID()}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
        video,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const made = await json('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', {
        method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      return { id: made.id, url: `https://youtube.com/shorts/${made.id}`, note: made.status?.uploadStatus === 'rejected' ? 'YouTube rejected the video.' : null };
    },
  };

  // TikTok access tokens last a day; the refresh token (a year) gets a new one.
  let tiktokCache = null;
  async function tiktokToken() {
    const tt = keys.tiktok || {};
    if (tt.accessToken && !tt.refreshToken) return tt.accessToken;
    if (tiktokCache && tiktokCache.until > Date.now()) return tiktokCache.token;
    const tok = await json('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: tt.clientKey, client_secret: tt.clientSecret, grant_type: 'refresh_token', refresh_token: tt.refreshToken }).toString(),
    });
    tiktokCache = { token: tok.access_token, until: Date.now() + Math.max(60, (tok.expires_in || 3600) - 300) * 1000 };
    return tiktokCache.token;
  }

  // Posts to each platform picked (or only the ones that failed, on a retry), and keeps each result.
  async function publish(id, { user, retry = false } = {}) {
    let p = byId(id);
    if (!p) throw new HttpError(404, 'That post is gone.');
    if (!retry && p.status !== 'draft') throw new HttpError(400, 'It\'s already been posted or skipped.');
    if (!p.platforms.length) throw new HttpError(400, 'Pick at least one place to post it.');
    if (!p.photo_ids.length) throw new HttpError(400, 'Pick at least one photo.');
    const conn = connections();
    if (!retry) {
      stmt("UPDATE social_posts SET status = 'posting', media_token = COALESCE(media_token, ?), decided_by = ?, decided_at = ? WHERE id = ?")
        .run(crypto.randomBytes(18).toString('base64url'), user ?? null, now(), id);
      p = byId(id);
    }
    const results = { ...p.results };
    const todo = p.platforms.filter((k) => !retry || results[k]?.status !== 'posted');
    let ready;
    try {
      ready = await prepare(p, { video: todo.includes('youtube') && conn.youtube });
    } catch (err) {
      ready = await prepare(p, { video: false });
      if (todo.includes('youtube')) results.youtube = { status: 'failed', error: `Couldn't make the video: ${err.message}`, at: now() };
    }
    for (const k of todo) {
      if (k === 'youtube' && results.youtube?.status === 'failed' && !ready.videoName) continue;
      if (!conn[k]) { results[k] = { status: 'failed', error: `${PLATFORMS[k]} isn't connected yet.`, at: now() }; continue; }
      try {
        results[k] = { status: 'posted', ...(await post[k](p, ready)), at: now() };
      } catch (err) {
        results[k] = { status: 'failed', error: err.message, at: now() };
      }
    }
    const states = p.platforms.map((k) => results[k]?.status);
    const status = states.every((s) => s === 'posted') ? 'posted' : states.some((s) => s === 'posted') ? 'partly' : 'failed';
    stmt('UPDATE social_posts SET status = ?, results = ?, posted_at = COALESCE(posted_at, ?) WHERE id = ?')
      .run(status, JSON.stringify(results), status === 'failed' ? null : now(), id);
    return byId(id);
  }

  // The prepared photos and video, for the platforms to fetch (the token in the address is the key).
  function mediaFile(token, name) {
    if (!/^[\w-]{20,}$/.test(token) || !/^(\d+\.jpg|video\.mp4)$/.test(name)) return null;
    const row = stmt("SELECT id FROM social_posts WHERE media_token = ? AND status != 'draft'").get(token);
    if (!row) return null;
    const file = path.join(mediaDir, `post-${row.id}`, name);
    return fs.existsSync(file) ? { file, type: name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' } : null;
  }

  return { PLATFORMS, getSettings, saveSettings, connections, captionFor, draftFor, autoDraft, list, waitingCount, update, skip, publish, mediaFile };
}

module.exports = { createSocialService, SOCIAL_PLATFORMS: PLATFORMS, makeVideo, preparePhoto };
