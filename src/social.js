// Social posts. Two ways a post starts:
//  - From a finished job: when a job is marked Ready for pickup (or Picked up), the customer OK'd posting
//    at drop-off and there are after photos, a draft waits for an admin.
//  - From scratch (New post): photos from any job whose customer OK'd it, photos and clips the shop
//    uploads, a kind of post (before & after, tip, offer...), and Claude can write the caption and the
//    words on the video.
// A post goes out as photos (Facebook photos, an Instagram carousel, a TikTok photo post and a YouTube
// Short slideshow), or as one Reel-style video everywhere, made from the photos and clips (src/reel.js),
// optionally opening with an AI-made clip (src/aivideo.js, always labeled as AI).
// The video side (Reels, uploaded clips, music, AI intro clips) is built but off unless SOCIAL_VIDEO=1
// (videoEnabled): with it off, posts go out as photos and those requests are refused.
// It goes out now (Post now) or on a schedule: an admin picks the time, and an admin has to approve it
// a set number of days before (2 by default). Approved posts go out by themselves at their time; a post
// not approved in time doesn't go out and goes back to Drafts. Captions never carry customer names.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HttpError } = require('./leads');
const { serviceLabels } = require('./services');
const { makeReel } = require('./reel');
const { POST_TYPES } = require('./socialwriter');

const PLATFORMS = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube Shorts' };
const DEFAULTS = {
  auto_draft: true,
  platforms: ['facebook', 'instagram', 'tiktok', 'youtube'],
  caption: '{vehicle}{color}: {services}. Coated and protected by {company} in {city}. Book yours: {phone}',
  hashtags: '#ceramiccoating #{make} #lasvegas #detailing #paintprotection',
  approve_days: 2,
  video_style: 'photos',
  music_id: null,
};
const MAX_ITEMS = 10;
const AI_NOTE = 'Intro clip made with AI.';
const CLIP_TIMEOUT_MS = 20 * 60 * 1000;
const OPEN = ['draft', 'scheduled', 'approved'];
const now = () => new Date().toISOString();
const DAY = 86400000;

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

// What an upload is, from its type.
const UPLOAD_TYPES = {
  'image/jpeg': ['photo', 'jpg'], 'image/png': ['photo', 'png'], 'image/webp': ['photo', 'webp'],
  'video/mp4': ['clip', 'mp4'], 'video/quicktime': ['clip', 'mov'], 'video/webm': ['clip', 'webm'],
  'audio/mpeg': ['music', 'mp3'], 'audio/mp4': ['music', 'm4a'], 'audio/x-m4a': ['music', 'm4a'], 'audio/aac': ['music', 'aac'], 'audio/wav': ['music', 'wav'], 'audio/x-wav': ['music', 'wav'],
};

function createSocialService(db, {
  jobs, keys = {}, brand = {}, publicUrl = '', mediaDir, logo = null, fetchImpl = (...a) => fetch(...a),
  media = {}, writer = null, videoAi = null, videoEnabled = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const stmt = (sql) => db.prepare(sql);
  const tools = { preparePhoto, makeVideo, makeReel, ...media };
  const libraryDir = path.join(mediaDir, 'library');

  // ---- settings and connections ----
  const NO_VIDEO = 'Reel videos aren\'t turned on. Posts go out as photos.';
  const needVideo = () => { if (!videoEnabled) throw new HttpError(400, NO_VIDEO); };
  function getSettings() {
    let s;
    try { s = { ...DEFAULTS, ...JSON.parse(stmt("SELECT value FROM settings WHERE key = 'social'").get()?.value || '{}') }; } catch { s = { ...DEFAULTS }; }
    if (!videoEnabled) s.video_style = 'photos';
    return s;
  }
  const putSettings = (next) => stmt("INSERT INTO settings (key, value) VALUES ('social', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
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
    if ('approve_days' in input) {
      const d = Number(input.approve_days);
      if (!Number.isInteger(d) || d < 0 || d > 14) throw new HttpError(400, 'Approval lead time is 0 to 14 days.');
      next.approve_days = d;
    }
    if ('video_style' in input) {
      if (!['photos', 'reel'].includes(input.video_style)) throw new HttpError(400, 'Pick Photos or Reel.');
      if (input.video_style === 'reel') needVideo();
      next.video_style = input.video_style;
    }
    putSettings(next);
    return settingsView(next);
  }
  function settingsView(s = getSettings()) {
    const music = videoEnabled && s.music_id ? stmt('SELECT id, name, bytes, created_at FROM social_media WHERE id = ? AND kind = \'music\'').get(s.music_id) : null;
    return { ...s, music: music || null };
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
  const aiInfo = () => ({ writer: Boolean(writer?.configured), video: Boolean(videoEnabled && videoAi?.configured), reels: Boolean(videoEnabled) });

  // ---- what's in a post ----
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
  ].slice(0, MAX_ITEMS).map((p) => p.id);

  // Items: { src: 'job', job_id, photo_id } or { src: 'upload', id }. Older posts only have photo_ids.
  const itemsOf = (row) => parse(row.items, null) || parse(row.photo_ids, []).map((id) => ({ src: 'job', job_id: row.job_id, photo_id: id }));
  const photoRow = (id) => stmt('SELECT id, job_id, phase, caption FROM job_photos WHERE id = ?').get(id);
  const uploadRow = (id) => stmt("SELECT * FROM social_media WHERE id = ? AND kind IN ('photo', 'clip')").get(id);
  const jobOk = (jobId) => stmt('SELECT social_ok FROM jobs WHERE id = ?').get(jobId)?.social_ok === 1;
  function describe(item) {
    if (item.src === 'upload') {
      const u = uploadRow(item.id);
      return u ? { src: 'upload', id: u.id, kind: u.kind, name: u.name, url: `/api/social/media/${u.id}` } : { ...item, kind: 'photo', missing: true };
    }
    const p = photoRow(item.photo_id);
    if (!p || p.job_id !== item.job_id) return { ...item, kind: 'photo', missing: true };
    return { src: 'job', job_id: p.job_id, photo_id: p.id, kind: 'photo', phase: p.phase, caption: p.caption, url: `/api/jobs/${p.job_id}/photos/${p.id}`, ok: jobOk(p.job_id) };
  }
  const publicClip = (c) => (c ? { status: c.status, prompt: c.prompt, error: c.error || null, by: c.by || null, started_at: c.started_at, ready_at: c.ready_at || null } : null);

  function shape(row) {
    if (!row) return null;
    const items = itemsOf(row).map(describe);
    const job = row.job_id ? jobs.getJob(row.job_id) : null;
    return {
      ...row,
      kind: row.kind || (row.job_id ? 'job' : 'custom'),
      post_type: row.post_type || 'before_after',
      items,
      photo_ids: items.filter((i) => i.src === 'job' && i.job_id === row.job_id).map((i) => i.photo_id),
      platforms: parse(row.platforms, []),
      results: parse(row.results, {}),
      overlay: parse(row.overlay, {}),
      video_style: row.video_style || 'photos',
      ai_clip: publicClip(parse(row.ai_clip, null)),
      ai_used: usesAi(row),
      job: job && {
        id: job.id, lead_id: job.lead_id, status: job.status, customer: job.full_name || [job.first_name, job.last_name].filter(Boolean).join(' '),
        vehicle: [vehicle(job), job.vehicle_color].filter(Boolean).join(' · '), social_ok: job.social_ok === 1,
        photos: job.photos.map((p) => ({ id: p.id, phase: p.phase, caption: p.caption })),
      },
    };
  }
  const rowById = (id) => stmt('SELECT * FROM social_posts WHERE id = ?').get(id);
  const byId = (id) => shape(rowById(id));
  const mustGet = (id) => { const p = byId(id); if (!p) throw new HttpError(404, 'That post is gone.'); return p; };
  const usesAi = (row) => (row.video_style === 'reel' && parse(row.ai_clip, null)?.status === 'ready');

  // ---- drafts ----
  function draftFor(jobId, { user = null } = {}) {
    const job = jobs.getJob(jobId);
    // One draft at a time per job (a job already posted can get another post).
    const existing = stmt("SELECT * FROM social_posts WHERE job_id = ? AND status IN ('draft', 'posting') ORDER BY id DESC LIMIT 1").get(jobId);
    if (existing) return shape(existing);
    if (job.social_ok !== 1) throw new HttpError(400, 'The customer hasn\'t OK\'d posting photos of their vehicle. Tick it on the job first.');
    if (!job.photos.some((p) => p.phase === 'after')) throw new HttpError(400, 'Add after photos first.');
    const settings = getSettings();
    const ids = pickPhotos(job);
    const { lastInsertRowid } = stmt(`INSERT INTO social_posts (job_id, kind, post_type, status, caption, photo_ids, items, overlay, video_style, platforms, created_by, created_at)
      VALUES (?, 'job', 'before_after', 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, captionFor(job, settings), JSON.stringify(ids), JSON.stringify(ids.map((id) => ({ src: 'job', job_id: jobId, photo_id: id }))),
        JSON.stringify({ hook: `${vehicle(job)}: before & after`.slice(0, 60), end_text: 'Book yours today' }), settings.video_style,
        JSON.stringify(settings.platforms), user, now());
    return byId(Number(lastInsertRowid));
  }
  // A job just finished: make the draft if everything's there (quietly skip if not).
  function autoDraft(jobId) {
    if (!getSettings().auto_draft) return null;
    // Only once per job: not again at Picked up, and not after an admin skipped it.
    if (stmt('SELECT 1 FROM social_posts WHERE job_id = ? LIMIT 1').get(jobId)) return null;
    try { return draftFor(jobId); } catch { return null; }
  }
  // A new post from scratch (New post).
  function create({ post_type: type = 'showcase', title = '' } = {}, { user = null } = {}) {
    if (!POST_TYPES[type]) throw new HttpError(400, 'Pick what kind of post it is.');
    const s = getSettings();
    const { lastInsertRowid } = stmt(`INSERT INTO social_posts (job_id, kind, post_type, title, status, caption, photo_ids, items, overlay, video_style, platforms, created_by, created_at)
      VALUES (NULL, 'custom', ?, ?, 'draft', '', '[]', '[]', '{}', ?, ?, ?, ?)`)
      .run(type, String(title || '').trim().slice(0, 80) || null, s.video_style, JSON.stringify(s.platforms), user, now());
    return byId(Number(lastInsertRowid));
  }

  // A post left on "Posting…" (the server restarted part way) after this long is marked as not finished,
  // so it can be checked and tried again.
  const STUCK_MS = 15 * 60 * 1000;
  function unstick() {
    const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
    for (const row of stmt("SELECT * FROM social_posts WHERE status = 'posting' AND decided_at < ?").all(cutoff)) {
      const results = parse(row.results, {});
      for (const k of parse(row.platforms, [])) {
        if (results[k]?.status !== 'posted') results[k] = { status: 'failed', error: 'It didn\'t finish (the app restarted part way). Check the page before trying again, in case it went up.', at: now() };
      }
      const posted = Object.values(results).some((r) => r.status === 'posted');
      stmt('UPDATE social_posts SET status = ?, results = ? WHERE id = ?').run(posted ? 'partly' : 'failed', JSON.stringify(results), row.id);
    }
  }

  // The customer took back their OK: their job's posts still waiting are skipped, and other posts that
  // used their photos lose them (and go back to Drafts if they were scheduled). Returns what already went
  // up, so staff can take it down by hand.
  function withdraw(jobId, { user } = {}) {
    stmt("UPDATE social_posts SET status = 'skipped', decided_by = ?, decided_at = ? WHERE job_id = ? AND status IN ('draft', 'scheduled', 'approved')").run(user ?? null, now(), jobId);
    for (const row of stmt("SELECT * FROM social_posts WHERE status IN ('draft', 'scheduled', 'approved') AND (job_id IS NULL OR job_id != ?)").all(jobId)) {
      const items = itemsOf(row);
      const kept = items.filter((i) => !(i.src === 'job' && i.job_id === jobId));
      if (kept.length === items.length) continue;
      stmt(`UPDATE social_posts SET items = ?, status = 'draft', scheduled_for = CASE WHEN status = 'draft' THEN scheduled_for ELSE NULL END,
        approve_by = NULL, approved_by = NULL, approved_at = NULL WHERE id = ?`).run(JSON.stringify(kept), row.id);
    }
    return forJob(jobId);
  }

  // A job's posts, for its Social media section: where each went and the links.
  function forJob(jobId) {
    return stmt("SELECT id, status, results, decided_by, decided_at, posted_at, scheduled_for FROM social_posts WHERE job_id = ? AND status != 'skipped' ORDER BY id DESC").all(jobId)
      .map((r) => ({ id: r.id, status: r.status, decided_by: r.decided_by, decided_at: r.decided_at, posted_at: r.posted_at, scheduled_for: r.scheduled_for,
        posted: Object.entries(parse(r.results, {})).filter(([, x]) => x.status === 'posted').map(([k, x]) => ({ platform: k, name: PLATFORMS[k] || k, url: x.url || null })) }));
  }

  function list() {
    unstick();
    checkClips().catch(() => {});
    const drafts = stmt("SELECT * FROM social_posts WHERE status = 'draft' ORDER BY id DESC").all().map(shape);
    return {
      waiting: drafts,
      drafts,
      planned: stmt("SELECT * FROM social_posts WHERE status IN ('scheduled', 'approved') ORDER BY scheduled_for").all().map(shape),
      done: stmt("SELECT * FROM social_posts WHERE status NOT IN ('draft', 'scheduled', 'approved') ORDER BY COALESCE(posted_at, decided_at, created_at) DESC LIMIT 60").all().map(shape),
    };
  }
  // The Social badge: drafts and scheduled posts that still need approving.
  const waitingCount = () => stmt("SELECT COUNT(*) AS n FROM social_posts WHERE status IN ('draft', 'scheduled')").get().n;

  function checkItems(raw, post) {
    if (!Array.isArray(raw)) throw new HttpError(400, 'Pick the photos and clips.');
    const out = [];
    for (const i of raw.slice(0, MAX_ITEMS)) {
      if (i?.src === 'upload') {
        if (!uploadRow(Number(i.id))) throw new HttpError(400, 'One of the uploads is gone. Pick it again.');
        out.push({ src: 'upload', id: Number(i.id) });
      } else {
        const p = photoRow(Number(i?.photo_id));
        if (!p || p.job_id !== Number(i.job_id)) throw new HttpError(400, 'One of the photos is gone. Pick it again.');
        if (!jobOk(p.job_id)) throw new HttpError(400, 'The customer hasn\'t OK\'d posting photos of that vehicle.');
        out.push({ src: 'job', job_id: p.job_id, photo_id: p.id });
      }
    }
    if (!out.length && post.kind === 'job') throw new HttpError(400, 'Pick at least one photo.');
    return out;
  }

  function update(id, input = {}) {
    const post = mustGet(id);
    if (post.status !== 'draft') throw new HttpError(400, post.status === 'scheduled' || post.status === 'approved' ? 'It\'s scheduled. Move it back to Drafts to change it.' : 'It\'s already been posted or skipped.');
    const { caption, photo_ids: photoIds, platforms } = input;
    if (caption != null) {
      const c = String(caption).trim();
      if (!c && post.kind === 'job') throw new HttpError(400, 'Write a caption.');
      if (c.length > 2200) throw new HttpError(400, 'Keep the caption under 2,200 characters (Instagram\'s limit).');
      stmt('UPDATE social_posts SET caption = ? WHERE id = ?').run(c, id);
    }
    let items = null;
    if (input.items) items = checkItems(input.items, post);
    else if (photoIds) {
      const own = new Set((post.job?.photos || []).map((p) => p.id));
      const ids = photoIds.map(Number).filter((x) => own.has(x)).slice(0, MAX_ITEMS);
      if (!ids.length) throw new HttpError(400, 'Pick at least one photo.');
      items = ids.map((pid) => ({ src: 'job', job_id: post.job_id, photo_id: pid }));
    }
    if (items) {
      const jobIds = items.filter((i) => i.src === 'job' && i.job_id === post.job_id).map((i) => i.photo_id);
      stmt('UPDATE social_posts SET items = ?, photo_ids = ? WHERE id = ?').run(JSON.stringify(items), JSON.stringify(jobIds), id);
    }
    if (platforms) stmt('UPDATE social_posts SET platforms = ? WHERE id = ?').run(JSON.stringify(platforms.filter((p) => PLATFORMS[p])), id);
    if ('title' in input) stmt('UPDATE social_posts SET title = ? WHERE id = ?').run(String(input.title || '').trim().slice(0, 80) || null, id);
    if ('notes' in input) stmt('UPDATE social_posts SET notes = ? WHERE id = ?').run(String(input.notes || '').trim().slice(0, 1000) || null, id);
    if ('post_type' in input) {
      if (!POST_TYPES[input.post_type]) throw new HttpError(400, 'Pick what kind of post it is.');
      stmt('UPDATE social_posts SET post_type = ? WHERE id = ?').run(input.post_type, id);
    }
    if ('video_style' in input) {
      if (!['photos', 'reel'].includes(input.video_style)) throw new HttpError(400, 'Pick Photos or Reel.');
      if (input.video_style === 'reel') needVideo();
      stmt('UPDATE social_posts SET video_style = ? WHERE id = ?').run(input.video_style, id);
    }
    if (input.overlay) {
      const o = { hook: String(input.overlay.hook || '').trim().slice(0, 60), end_text: String(input.overlay.end_text || '').trim().slice(0, 40) };
      stmt('UPDATE social_posts SET overlay = ? WHERE id = ?').run(JSON.stringify(o), id);
    }
    return byId(id);
  }

  function skip(id, { user } = {}) {
    const post = mustGet(id);
    if (!OPEN.includes(post.status)) throw new HttpError(400, 'It\'s already been posted or skipped.');
    stmt("UPDATE social_posts SET status = 'skipped', decided_by = ?, decided_at = ? WHERE id = ?").run(user ?? null, now(), id);
    return byId(id);
  }

  // Everything a post needs before it can be scheduled, approved or posted.
  function readyCheck(p) {
    if (!p.caption.trim()) throw new HttpError(400, 'Write a caption (or tap Write it for me).');
    if (!p.items.length) throw new HttpError(400, 'Pick at least one photo.');
    if (p.items.some((i) => i.missing)) throw new HttpError(400, 'One of the photos or clips is gone. Pick them again.');
    if (p.items.some((i) => i.src === 'job' && !i.ok)) throw new HttpError(400, 'The customer took back their OK to post photos of their vehicle, so it can\'t be posted.');
    if (p.job && !p.job.social_ok) throw new HttpError(400, 'The customer took back their OK to post photos of their vehicle, so it can\'t be posted.');
    if (p.video_style === 'reel' && !videoEnabled) throw new HttpError(400, 'Reel videos aren\'t turned on. Switch it to Photos.');
    if (p.video_style === 'photos' && p.items.some((i) => i.kind === 'clip')) throw new HttpError(400, videoEnabled ? 'Clips only go in a Reel. Switch it to Reel, or take the clips out.' : 'Video clips aren\'t turned on. Take the clips out.');
    if (!p.platforms.length) throw new HttpError(400, 'Pick at least one place to post it.');
    if (p.video_style === 'reel' && p.ai_clip?.status === 'making') throw new HttpError(400, 'The AI clip is still being made. Wait for it, or take it out.');
  }

  // ---- scheduling and approval ----
  function schedule(id, { at } = {}, { user = null } = {}) {
    const p = mustGet(id);
    if (p.status !== 'draft') throw new HttpError(400, 'Only a draft can be scheduled.');
    readyCheck(p);
    const when = new Date(at);
    if (!at || Number.isNaN(when.getTime())) throw new HttpError(400, 'Pick a day and time for it to go out.');
    const days = getSettings().approve_days;
    const earliest = Date.now() + Math.max(days * DAY, 5 * 60000);
    if (when.getTime() < earliest) {
      throw new HttpError(400, days
        ? `Pick a time at least ${days} day${days === 1 ? '' : 's'} out, so there's time to approve it. Or use Post now.`
        : 'Pick a time at least a few minutes from now. Or use Post now.');
    }
    const approveBy = new Date(when.getTime() - days * DAY).toISOString();
    stmt(`UPDATE social_posts SET status = 'scheduled', scheduled_for = ?, approve_by = ?, submitted_by = ?, submitted_at = ?, missed_at = NULL,
      approved_by = NULL, approved_at = NULL WHERE id = ?`).run(when.toISOString(), approveBy, user, now(), id);
    return byId(id);
  }
  function approve(id, { user = null } = {}) {
    const p = mustGet(id);
    if (p.status === 'approved') throw new HttpError(400, 'It\'s already approved.');
    if (p.status !== 'scheduled') throw new HttpError(400, 'Only a scheduled post can be approved.');
    if (Date.now() > new Date(p.approve_by).getTime()) throw new HttpError(400, 'It\'s past the time to approve it. Move it back to Drafts and pick a new time.');
    readyCheck(p);
    stmt("UPDATE social_posts SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(user, now(), id);
    return byId(id);
  }
  function unschedule(id) {
    const p = mustGet(id);
    if (!['scheduled', 'approved'].includes(p.status)) throw new HttpError(400, 'It isn\'t scheduled.');
    stmt("UPDATE social_posts SET status = 'draft', scheduled_for = NULL, approve_by = NULL, approved_by = NULL, approved_at = NULL, missed_at = NULL WHERE id = ?").run(id);
    return byId(id);
  }
  // Every minute: posts not approved in time go back to Drafts; approved posts whose time has come go out.
  async function runSchedule(at = new Date()) {
    const t = at.toISOString();
    const missed = stmt("SELECT id FROM social_posts WHERE status = 'scheduled' AND approve_by < ?").all(t);
    for (const { id } of missed) stmt("UPDATE social_posts SET status = 'draft', approve_by = NULL, missed_at = ? WHERE id = ?").run(t, id);
    let posted = 0;
    for (const row of stmt("SELECT id, approved_by FROM social_posts WHERE status = 'approved' AND scheduled_for <= ? ORDER BY scheduled_for").all(t)) {
      try { await publish(row.id, { user: row.approved_by, scheduled: true }); posted += 1; } catch (err) {
        // It can't go (the customer took back their OK, a photo was deleted): back to Drafts, with why.
        stmt("UPDATE social_posts SET status = 'draft', missed_at = ?, results = ? WHERE id = ? AND status = 'approved'")
          .run(t, JSON.stringify({ _error: { status: 'failed', error: err.message, at: t } }), row.id);
      }
    }
    await checkClips().catch(() => {});
    return { missed: missed.length, posted };
  }

  // ---- uploads (photos and clips for posts, and the background music) ----
  function addMedia(raw, { type = '', name = '', kind = null } = {}, { user = null } = {}) {
    const known = UPLOAD_TYPES[String(type).split(';')[0].trim().toLowerCase()];
    if (!raw?.length) throw new HttpError(400, 'The file was empty.');
    if (!known) throw new HttpError(400, 'Upload a photo (JPEG, PNG, WebP), a video clip (MP4, MOV, WebM) or, for music, an MP3 or M4A.');
    const [k, ext] = known;
    if (k !== 'photo' && !videoEnabled) throw new HttpError(400, 'Video clips and music aren\'t turned on. Upload photos (JPEG, PNG or WebP).');
    if (kind === 'music' ? k !== 'music' : k === 'music') throw new HttpError(400, kind === 'music' ? 'Upload the music as an MP3 or M4A.' : 'Upload music under Social → Settings.');
    fs.mkdirSync(libraryDir, { recursive: true });
    const file = `${k}-${crypto.randomBytes(9).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(libraryDir, file), raw);
    const { lastInsertRowid } = stmt('INSERT INTO social_media (kind, file, mime, name, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(k, file, type, String(name || '').slice(0, 120) || null, raw.length, user, now());
    const id = Number(lastInsertRowid);
    if (k === 'music') {
      const s = getSettings();
      if (s.music_id) removeFile(s.music_id);
      putSettings({ ...s, music_id: id });
      return settingsView();
    }
    return mediaView(stmt('SELECT * FROM social_media WHERE id = ?').get(id));
  }
  const mediaView = (m) => ({ id: m.id, kind: m.kind, name: m.name, bytes: m.bytes, created_by: m.created_by, created_at: m.created_at, url: `/api/social/media/${m.id}` });
  function removeFile(id) {
    const m = stmt('SELECT * FROM social_media WHERE id = ?').get(id);
    if (!m) return;
    try { fs.unlinkSync(path.join(libraryDir, m.file)); } catch { /* already gone */ }
    stmt('DELETE FROM social_media WHERE id = ?').run(id);
  }
  function deleteMedia(id) {
    const m = stmt('SELECT * FROM social_media WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, 'That file is gone.');
    const inUse = stmt("SELECT items FROM social_posts WHERE status IN ('draft', 'scheduled', 'approved', 'posting')").all()
      .some((r) => parse(r.items, []).some((i) => i.src === 'upload' && i.id === id));
    if (inUse) throw new HttpError(400, 'It\'s in a post that hasn\'t gone out yet. Take it out of that post first.');
    removeFile(id);
    if (m.kind === 'music') putSettings({ ...getSettings(), music_id: null });
    return { ok: true };
  }
  function mediaById(id) {
    const m = stmt('SELECT * FROM social_media WHERE id = ?').get(id);
    if (!m) throw new HttpError(404, 'That file is gone.');
    return { file: path.join(libraryDir, m.file), type: m.mime };
  }
  // What can go in a post: the photos of jobs whose customer OK'd posting, and the uploads.
  function library() {
    const jobRows = stmt(`SELECT j.id FROM jobs j WHERE j.social_ok = 1 AND EXISTS (SELECT 1 FROM job_photos p WHERE p.job_id = j.id)
      ORDER BY j.start_at DESC LIMIT 40`).all();
    return {
      jobs: jobRows.map(({ id }) => {
        const j = jobs.getJob(id);
        return { id: j.id, vehicle: [vehicle(j), j.vehicle_color].filter(Boolean).join(' · '), start_at: j.start_at, status: j.status,
          photos: j.photos.map((p) => ({ id: p.id, phase: p.phase, caption: p.caption, url: `/api/jobs/${j.id}/photos/${p.id}` })) };
      }),
      uploads: stmt(`SELECT * FROM social_media WHERE kind IN (${videoEnabled ? "'photo', 'clip'" : "'photo'"}) ORDER BY id DESC LIMIT 100`).all().map(mediaView),
    };
  }

  // ---- AI help ----
  // A suggested caption, hashtags, the words on the video and an AI clip idea (not saved; the editor fills them in).
  async function write(id) {
    const p = mustGet(id);
    const jobIds = [...new Set([p.job_id, ...p.items.filter((i) => i.src === 'job').map((i) => i.job_id)].filter(Boolean))];
    const js = jobIds.map((jid) => jobs.getJob(jid));
    const input = {
      type: p.post_type, notes: p.notes || '', brand,
      vehicles: js.map((j) => [vehicle(j), j.vehicle_color].filter(Boolean).join(' in ')),
      services: [...new Set(js.flatMap((j) => j.services || []))].length ? serviceLabels([...new Set(js.flatMap((j) => j.services || []))]) : '',
    };
    if (!writer) return { suggestion: null, source: 'basic', error: 'Writing isn\'t available.' };
    const { post, source, error } = await writer.write(input);
    return { suggestion: { ...post, caption: [post.caption, post.hashtags].filter(Boolean).join('\n\n') }, source, error };
  }

  const dirFor = (post) => path.join(mediaDir, `post-${post.id}`);
  const clipPath = (post) => path.join(dirFor(post), 'ai-intro.mp4');
  function saveClip(id, clip) { stmt('UPDATE social_posts SET ai_clip = ? WHERE id = ?').run(clip ? JSON.stringify(clip) : null, id); }
  async function startClip(id, { prompt } = {}, { user = null } = {}) {
    const p = mustGet(id);
    if (p.status !== 'draft') throw new HttpError(400, 'Move it back to Drafts to change it.');
    needVideo();
    if (!videoAi?.configured) throw new HttpError(400, 'AI video isn\'t set up. Add a GEMINI_API_KEY on the server (see the README).');
    const text = String(prompt || '').trim();
    if (text.length < 8) throw new HttpError(400, 'Describe the clip in a few words.');
    if (p.ai_clip?.status === 'making') throw new HttpError(400, 'A clip is already being made.');
    let op;
    try { ({ op } = await videoAi.start(text.slice(0, 600))); } catch (err) { throw new HttpError(502, `Couldn't start the AI clip: ${err.message}`); }
    saveClip(id, { status: 'making', prompt: text.slice(0, 600), op, by: user, started_at: now() });
    if (p.video_style !== 'reel') stmt("UPDATE social_posts SET video_style = 'reel' WHERE id = ?").run(id);
    return byId(id);
  }
  function removeClip(id) {
    const p = mustGet(id);
    if (p.status !== 'draft') throw new HttpError(400, 'Move it back to Drafts to change it.');
    try { fs.unlinkSync(clipPath(p)); } catch { /* none */ }
    saveClip(id, null);
    return byId(id);
  }
  let checking = null;
  let lastCheck = 0;
  // Looks in on AI clips still being made (every 15 seconds at most).
  function checkClips({ force = false } = {}) {
    if (!videoEnabled || !videoAi?.configured) return Promise.resolve();
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 15000) return Promise.resolve();
    lastCheck = Date.now();
    checking = (async () => {
      for (const row of stmt("SELECT id, ai_clip FROM social_posts WHERE ai_clip LIKE '%\"making\"%'").all()) {
        const clip = parse(row.ai_clip, null);
        if (clip?.status !== 'making') continue;
        try {
          const r = await videoAi.check(clip.op);
          if (!r.done) {
            if (Date.now() - new Date(clip.started_at).getTime() > CLIP_TIMEOUT_MS) saveClip(row.id, { ...clip, status: 'failed', error: 'It took too long. Try again.' });
            continue;
          }
          if (r.error) { saveClip(row.id, { ...clip, status: 'failed', error: r.error }); continue; }
          fs.mkdirSync(dirFor(row), { recursive: true });
          await videoAi.download(r.uri, clipPath(row));
          saveClip(row.id, { ...clip, status: 'ready', ready_at: now() });
        } catch (err) {
          saveClip(row.id, { ...clip, status: 'failed', error: err.message });
        }
      }
    })().finally(() => { checking = null; });
    return checking;
  }
  function clipFile(id) {
    const p = mustGet(id);
    const f = clipPath(p);
    if (p.ai_clip?.status !== 'ready' || !fs.existsSync(f)) throw new HttpError(404, 'No AI clip yet.');
    return { file: f, type: 'video/mp4' };
  }

  // ---- the Reel ----
  function itemPath(i) {
    if (i.src === 'upload') return mediaById(i.id).file;
    return jobs.getPhoto(i.job_id, i.photo_id).path;
  }
  async function buildReel(p, out) {
    const segments = p.items.filter((i) => !i.missing).map((i) => ({
      kind: i.kind, path: itemPath(i), label: i.phase === 'before' ? 'BEFORE' : i.phase === 'after' ? 'AFTER' : null,
    }));
    const s = getSettings();
    const music = s.music_id ? (() => { try { return mediaById(s.music_id).file; } catch { return null; } })() : null;
    const intro = p.video_style === 'reel' && p.ai_clip?.status === 'ready' && fs.existsSync(clipPath(p)) ? clipPath(p) : null;
    return tools.makeReel(segments, {
      out, workDir: path.join(dirFor(p), 'work'), intro, hook: p.overlay.hook || '', endText: p.overlay.end_text || 'Book yours today',
      phone: brand.phone || '', brandName: brand.name || '', logo, music,
    });
  }
  // A preview of the Reel, before it goes anywhere.
  async function render(id) {
    needVideo();
    const p = mustGet(id);
    readyCheckForVideo(p);
    fs.mkdirSync(dirFor(p), { recursive: true });
    const out = path.join(dirFor(p), 'preview.mp4');
    try { fs.unlinkSync(out); } catch { /* none yet */ }
    let made;
    try { made = await buildReel(p, out); } catch (err) { throw new HttpError(422, `Couldn't make the video: ${err.message}`); }
    stmt('UPDATE social_posts SET rendered_at = ? WHERE id = ?').run(now(), id);
    return { ...byId(id), video: { seconds: made?.seconds ?? null, note: made?.note || null, url: `/api/social/${id}/preview.mp4?v=${Date.now()}` } };
  }
  function readyCheckForVideo(p) {
    if (!p.items.length) throw new HttpError(400, 'Pick at least one photo or clip.');
    if (p.items.some((i) => i.missing)) throw new HttpError(400, 'One of the photos or clips is gone. Pick them again.');
  }
  function previewFile(id) {
    const p = mustGet(id);
    const f = path.join(dirFor(p), 'preview.mp4');
    if (!fs.existsSync(f)) throw new HttpError(404, 'Make the preview first.');
    return { file: f, type: 'video/mp4' };
  }

  // ---- posting ----
  const mediaUrl = (post, name) => `${publicUrl}/social/media/${post.media_token}/${name}`;
  // The photos, ready to post (JPEG, 4:5), and the video when it's needed (the Reel, or the YouTube slideshow).
  async function prepare(post, { video, reel }) {
    const dir = dirFor(post);
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    if (!reel) {
      for (const [i, item] of post.items.entries()) {
        if (item.kind !== 'photo') continue;
        const src = itemPath(item);
        const name = `${i + 1}.jpg`;
        const out = path.join(dir, name);
        if (!fs.existsSync(out)) {
          try { await tools.preparePhoto(src, out); } catch { fs.copyFileSync(src, out); } // no ffmpeg: the original
        }
        names.push(name);
      }
    }
    let videoName = null;
    if (reel) {
      videoName = 'reel.mp4';
      const out = path.join(dir, videoName);
      if (!fs.existsSync(out)) await buildReel(post, out);
    } else if (video) {
      videoName = 'video.mp4';
      const out = path.join(dir, videoName);
      if (!fs.existsSync(out)) await tools.makeVideo(names.map((n) => path.join(dir, n)), out);
    }
    return { names, videoName, reel };
  }

  async function json(url, options = {}) {
    const res = await fetchImpl(url, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error?.message || (body.error?.code && body.error.code !== 'ok')) {
      throw new Error(body.error?.message || body.error_description || body.error?.code || `${res.status} from ${new URL(url).hostname}`);
    }
    return body;
  }
  const graphBase = () => `https://graph.facebook.com/${keys.graphVersion || 'v23.0'}`;
  const graph = (p, params) => json(`${graphBase()}/${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, access_token: keys.facebookToken }),
  });
  const graphGet = (p, fields) => json(`${graphBase()}/${p}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(keys.facebookToken)}`);
  // The caption that goes out: an AI clip is always said in words too.
  const captionOut = (p) => (p.ai_used && !p.caption.includes(AI_NOTE) ? `${p.caption}\n\n${AI_NOTE}` : p.caption);

  const post = {
    // Photos uploaded unpublished, then one post with all of them. A Reel goes up as a Page video.
    async facebook(p, { names, videoName, reel }) {
      if (reel) {
        const made = await graph(`${keys.facebookPageId}/videos`, { file_url: mediaUrl(p, videoName), description: captionOut(p) });
        return { id: made.id, url: `https://www.facebook.com/${keys.facebookPageId}/videos/${made.id}` };
      }
      const ids = [];
      for (const n of names) ids.push((await graph(`${keys.facebookPageId}/photos`, { url: mediaUrl(p, n), published: false })).id);
      const made = await graph(`${keys.facebookPageId}/feed`, { message: captionOut(p), attached_media: ids.map((id) => ({ media_fbid: id })) });
      return { id: made.id, url: `https://www.facebook.com/${made.id}` };
    },
    // One photo, a carousel of up to 10, or a Reel (Instagram processes the video first); then published.
    async instagram(p, { names, videoName, reel }) {
      const ig = keys.instagramUserId;
      let creation;
      if (reel) {
        creation = (await graph(`${ig}/media`, { media_type: 'REELS', video_url: mediaUrl(p, videoName), caption: captionOut(p), share_to_feed: true })).id;
        for (let i = 0; i < 60; i += 1) {
          const { status_code: code } = await graphGet(creation, 'status_code');
          if (!code || code === 'FINISHED') break;
          if (code === 'ERROR' || code === 'EXPIRED') throw new Error('Instagram couldn\'t process the video.');
          if (i === 59) throw new Error('Instagram is still processing the video. Try again in a few minutes.');
          await sleep(5000);
        }
      } else if (names.length === 1) creation = (await graph(`${ig}/media`, { image_url: mediaUrl(p, names[0]), caption: captionOut(p) })).id;
      else {
        const children = [];
        for (const n of names.slice(0, 10)) children.push((await graph(`${ig}/media`, { image_url: mediaUrl(p, n), is_carousel_item: true })).id);
        creation = (await graph(`${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: captionOut(p) })).id;
      }
      const made = await graph(`${ig}/media_publish`, { creation_id: creation });
      return { id: made.id, url: 'https://www.instagram.com/' };
    },
    // A TikTok photo post, or a video post for a Reel. Until TikTok approves the app, posts can only be private.
    async tiktok(p, { names, videoName, reel }) {
      const token = await tiktokToken();
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };
      const info = await json('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', { method: 'POST', headers: auth, body: '{}' });
      const options = info.data?.privacy_level_options || [];
      const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (options[0] || 'SELF_ONLY');
      const caption = captionOut(p);
      const made = reel
        ? await json('https://open.tiktokapis.com/v2/post/publish/video/init/', {
          method: 'POST', headers: auth,
          body: JSON.stringify({
            post_info: { title: caption.slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false, is_aigc: p.ai_used },
            source_info: { source: 'PULL_FROM_URL', video_url: mediaUrl(p, videoName) },
          }),
        })
        : await json('https://open.tiktokapis.com/v2/post/publish/content/init/', {
          method: 'POST', headers: auth,
          body: JSON.stringify({
            post_info: { title: caption.split('\n')[0].slice(0, 90), description: caption.slice(0, 4000), privacy_level: privacy, disable_comment: false, auto_add_music: true },
            source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: names.slice(0, 35).map((n) => mediaUrl(p, n)) },
            post_mode: 'DIRECT_POST', media_type: 'PHOTO',
          }),
        });
      return { id: made.data?.publish_id, url: 'https://www.tiktok.com/', note: privacy === 'PUBLIC_TO_EVERYONE' ? null : 'Posted as private: TikTok hasn\'t approved the app for public posts yet.' };
    },
    // A YouTube Short: the Reel, or the before/after slideshow, uploaded with the caption.
    async youtube(p, { videoName }) {
      const yt = keys.youtube;
      const tok = await json('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: yt.clientId, client_secret: yt.clientSecret, refresh_token: yt.refreshToken, grant_type: 'refresh_token' }).toString(),
      });
      const caption = captionOut(p);
      const first = caption.split('\n')[0];
      const meta = {
        snippet: { title: `${first.slice(0, 88)} #Shorts`.slice(0, 100), description: caption.slice(0, 4900), categoryId: '2' },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, ...(p.ai_used && { containsSyntheticMedia: true }) },
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
  // From a draft (Post now) or an approved post whose time has come (the schedule).
  async function publish(id, { user, retry = false, scheduled = false } = {}) {
    let p = mustGet(id);
    unstick();
    if (!retry && p.status === 'scheduled') throw new HttpError(400, 'It needs approving first.');
    if (!retry && !(p.status === 'draft' || (scheduled && p.status === 'approved'))) {
      throw new HttpError(400, p.status === 'approved' ? 'It\'s approved and goes out at its time. Move it back to Drafts to post it now.' : 'It\'s already been posted or skipped.');
    }
    if (retry && !['failed', 'partly'].includes(p.status)) throw new HttpError(400, p.status === 'posting' ? 'It\'s still posting. Give it a minute.' : 'Nothing to try again.');
    readyCheck(p);
    const conn = connections();
    const reel = p.video_style === 'reel';
    if (!retry) {
      stmt("UPDATE social_posts SET status = 'posting', results = NULL, media_token = COALESCE(media_token, ?), decided_by = ?, decided_at = ? WHERE id = ?")
        .run(crypto.randomBytes(18).toString('base64url'), user ?? null, now(), id);
      for (const f of ['reel.mp4']) { try { fs.unlinkSync(path.join(dirFor(p), f)); } catch { /* none */ } }
      p = byId(id);
    }
    const results = { ...p.results };
    delete results._error;
    const todo = p.platforms.filter((k) => !retry || results[k]?.status !== 'posted');
    if (retry) stmt("UPDATE social_posts SET status = 'posting', decided_at = ? WHERE id = ?").run(now(), id);
    let ready;
    try {
      ready = await prepare(p, { video: todo.includes('youtube') && conn.youtube, reel });
    } catch (err) {
      if (reel) {
        for (const k of todo) results[k] = { status: 'failed', error: `Couldn't make the video: ${err.message}`, at: now() };
        stmt("UPDATE social_posts SET status = 'failed', results = ? WHERE id = ?").run(JSON.stringify(results), id);
        return byId(id);
      }
      ready = await prepare(p, { video: false, reel: false });
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
    if (!/^[\w-]{20,}$/.test(token) || !/^(\d+\.jpg|video\.mp4|reel\.mp4)$/.test(name)) return null;
    const row = stmt("SELECT id FROM social_posts WHERE media_token = ? AND status NOT IN ('draft', 'scheduled', 'approved')").get(token);
    if (!row) return null;
    const file = path.join(mediaDir, `post-${row.id}`, name);
    return fs.existsSync(file) ? { file, type: name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg' } : null;
  }

  return {
    PLATFORMS, POST_TYPES, getSettings: settingsView, saveSettings, connections, aiInfo, captionFor, draftFor, autoDraft, create, list, waitingCount,
    update, skip, publish, mediaFile, withdraw, forJob, schedule, approve, unschedule, runSchedule, addMedia, deleteMedia, mediaById, library,
    write, startClip, removeClip, checkClips, clipFile, render, previewFile,
  };
}

module.exports = { createSocialService, SOCIAL_PLATFORMS: PLATFORMS, makeVideo, preparePhoto };
