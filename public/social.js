'use strict';
// Social posts (admins): finished jobs' before and after photos wait here as drafts. An admin picks the
// photos (in the order they'll show), edits the caption, picks where it goes, looks at the preview and
// taps Post it, then ticks a last privacy check. Nothing is posted on its own. Drafts save as you go.
// Uses the helpers from app.js ($, h, fill, api, toast, fail, showPanel, fmtDateTime, ask, askConfirm).

const soc = { data: null, poll: null };
const SOC_STATUS = { posting: 'Posting…', posted: 'Posted', partly: 'Partly posted', failed: 'Didn\'t post', skipped: 'Skipped' };
const SOC_SLIDE_MS = 2500; // how long each photo shows in the YouTube Shorts video

async function loadSocialBadge() {
  if (!isAdmin()) return;
  try {
    const { count } = await api('/api/social/waiting');
    const b = $('#socialBadge');
    b.textContent = count;
    b.hidden = !count;
  } catch { /* try again later */ }
}

async function openSocial() {
  try {
    soc.data = await api('/api/social');
    renderSocial();
    showPanel($('#socialPanel'));
    watchPosting();
  } catch (err) { fail(err); }
}

// While a post is still going up, check on it every few seconds (the panel can be closed meanwhile).
function watchPosting() {
  clearTimeout(soc.poll);
  if (!soc.data?.done.some((p) => p.status === 'posting')) return;
  soc.poll = setTimeout(async () => {
    if ($('#socialPanel').hidden) return;
    try {
      soc.data = await api('/api/social');
      renderSocial();
      loadSocialBadge();
    } catch { /* next look */ }
    watchPosting();
  }, 4000);
}

const socPhotoUrl = (jobId, id) => `/api/jobs/${jobId}/photos/${id}`;
const listNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function draftCard(p) {
  const { platforms, connections } = soc.data;
  const chosen = [...p.photo_ids]; // in posting order
  const caption = h('textarea', { rows: '5', maxlength: '2200', 'aria-label': 'Caption' }, p.caption);
  const pick = Object.keys(platforms).map((k) => h('label', { class: `check soc-platform ${connections[k] ? '' : 'off'}`, title: connections[k] ? '' : 'Not connected yet' },
    h('input', { type: 'checkbox', value: k, checked: p.platforms.includes(k) && connections[k], disabled: !connections[k] }),
    ` ${platforms[k]}`, !connections[k] && h('small', { class: 'muted' }, ' (not connected)')));
  const picked = () => pick.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);

  // Saves as you go: a moment after each change.
  const status = h('span', { class: 'soc-saved muted', 'aria-live': 'polite' }, 'Saved');
  let timer = null;
  let saving = Promise.resolve();
  const saveNow = () => {
    clearTimeout(timer);
    timer = null;
    status.textContent = 'Saving…';
    saving = api(`/api/social/${p.id}`, { method: 'PATCH', body: { caption: caption.value, photo_ids: chosen, platforms: picked() } })
      .then(() => { status.textContent = 'Saved'; status.classList.remove('soc-unsaved'); })
      .catch((err) => { status.textContent = `Not saved: ${err.message}`; status.classList.add('soc-unsaved'); throw err; });
    return saving;
  };
  const changed = () => {
    status.textContent = 'Unsaved changes';
    clearTimeout(timer);
    timer = setTimeout(() => saveNow().catch(() => {}), 800);
  };
  caption.addEventListener('input', () => { changed(); preview.update(); });
  caption.addEventListener('blur', () => { if (timer) saveNow().catch(() => {}); });
  pick.forEach((l) => l.querySelector('input').addEventListener('change', changed));
  p.flush = () => (timer ? saveNow() : saving); // before posting or leaving: save what's pending (leaving the box saves too)

  const photos = p.job.photos.filter((x) => x.phase !== 'during' || chosen.includes(x.id));
  const tiles = photos.map((x) => {
    const order = h('span', { class: 'soc-order' });
    const b = h('button', { type: 'button', class: 'soc-photo', title: x.caption || x.phase,
      onclick: () => {
        const i = chosen.indexOf(x.id);
        if (i >= 0) chosen.splice(i, 1); else chosen.push(x.id);
        paint();
        changed();
        preview.update();
      } },
    h('img', { src: socPhotoUrl(p.job.id, x.id), alt: `${x.phase} photo`, loading: 'lazy' }),
    h('span', { class: `soc-phase ${x.phase}` }, x.phase), order);
    b.dataset.id = x.id;
    return b;
  });
  const paint = () => tiles.forEach((b) => {
    const n = chosen.indexOf(Number(b.dataset.id));
    b.classList.toggle('on', n >= 0);
    b.setAttribute('aria-pressed', String(n >= 0));
    b.querySelector('.soc-order').textContent = n >= 0 ? n + 1 : '';
  });
  paint();
  const preview = socPreview(p, chosen, caption);

  const postBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    if (!chosen.length) return toast('Pick at least one photo', 'error');
    const where = picked();
    if (!where.length) return toast('Pick at least one place to post it', 'error');
    const names = where.map((k) => platforms[k]);
    const go = await ask({
      title: `Post to ${listNames(names)}?`,
      text: `${chosen.length} photo${chosen.length === 1 ? '' : 's'} go up on the company's pages right away. Look at them once more:`,
      checks: ['No license plates can be read', 'No faces, names or paperwork (key tags, invoices) show', 'The caption has no customer names'],
      ok: 'Post it',
    });
    if (!go) return;
    postBtn.disabled = true;
    postBtn.textContent = 'Posting…';
    note.hidden = false;
    try {
      await p.flush();
      const done = await api(`/api/social/${p.id}/post`, { method: 'POST' });
      toast(done.status === 'posted' ? 'Posted!' : done.status === 'partly' ? 'Posted to some places. See what didn\'t go below.' : 'It didn\'t post. See why below.', done.status === 'failed' ? 'error' : '');
    } catch (err) {
      // No answer (the connection dropped)? It may still be going: look before trying again.
      if (!err.status) toast('Checking whether it posted…');
      else fail(err);
    }
    loadSocialBadge();
    await openSocial();
  } }, 'Post it');
  const note = h('p', { class: 'hint soc-posting-note', hidden: true }, 'Getting the photos ready and posting. You can close this; it keeps going, and the result shows here under Posted.');

  return h('section', { class: 'soc-card' },
    h('div', { class: 'soc-head' },
      h('div', {},
        h('strong', {}, p.job.vehicle),
        h('div', { class: 'muted' }, `${p.job.customer || 'Customer'} (not posted) · ${p.job.status === 'picked_up' ? 'Picked up' : 'Ready for pickup'}`)),
      h('button', { type: 'button', class: 'link-btn', onclick: async () => { await p.flush().catch(() => {}); showPanel(null); showSection('calendar'); openJob(p.job.id); } }, 'Open job')),
    h('div', { class: 'soc-label' }, 'Photos: tap in the order you want them (tap again to leave one out)'),
    h('div', { class: 'soc-photos' }, ...tiles),
    h('div', { class: 'soc-two' },
      h('div', { class: 'soc-fields' },
        h('label', { class: 'soc-label' }, 'Caption (no customer names)', caption),
        h('div', { class: 'soc-label' }, 'Post to'),
        h('div', { class: 'soc-platforms' }, ...pick)),
      preview.el),
    h('div', { class: 'soc-actions' },
      postBtn,
      h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        if (!await askConfirm('Skip this post?', 'It won\'t be posted. You can make a new one from the job later.', { ok: 'Skip it' })) return;
        try { clearTimeout(timer); timer = null; await api(`/api/social/${p.id}/skip`, { method: 'POST' }); loadSocialBadge(); await openSocial(); } catch (err) { fail(err); }
      } }, 'Skip'),
      status),
    note);
}

// What the post will look like: the photos in order (as the YouTube Short plays them) and the caption.
function socPreview(p, chosen, caption) {
  const img = h('img', { alt: 'Preview' });
  const count = h('span', { class: 'soc-pv-count' });
  const text = h('p', { class: 'soc-pv-caption' });
  const el = h('figure', { class: 'soc-preview', 'aria-label': 'Preview' },
    h('div', { class: 'soc-pv-frame' }, img, count),
    h('figcaption', {}, h('strong', {}, state.meta.brand?.name || 'Your page'), text),
    h('p', { class: 'hint' }, `Plays in this order on YouTube Shorts, ${SOC_SLIDE_MS / 1000} seconds a photo.`));
  let i = 0;
  const show = () => {
    if (!chosen.length) { img.removeAttribute('src'); count.textContent = 'No photos picked'; return; }
    i %= chosen.length;
    img.src = socPhotoUrl(p.job.id, chosen[i]);
    count.textContent = `${i + 1} / ${chosen.length}`;
  };
  const update = () => {
    const c = caption.value.trim();
    text.textContent = c.length > 220 ? `${c.slice(0, 220)}… more` : c;
    show();
  };
  let shown = false; // stops once the card is gone from the page
  const tick = setInterval(() => {
    if (!el.isConnected) { if (shown) clearInterval(tick); return; }
    shown = true;
    i += 1;
    show();
  }, SOC_SLIDE_MS);
  update();
  return { el, update };
}

function doneRow(p) {
  const entries = Object.entries(p.results || {});
  const failed = p.status !== 'posting' && entries.some(([, r]) => r.status === 'failed');
  return h('li', { class: `soc-done ${p.status}` },
    h('div', { class: 'soc-done-top' },
      h('strong', {}, p.job.vehicle),
      h('span', { class: `tc-badge ${p.status === 'posted' ? 'approved' : p.status === 'skipped' ? '' : ['partly', 'posting'].includes(p.status) ? 'pending' : 'denied'}` }, SOC_STATUS[p.status] || p.status),
      h('span', { class: 'muted' }, `${p.decided_by ? `${p.decided_by} · ` : ''}${fmtDateTime(p.decided_at || p.created_at)}`)),
    p.status === 'posting' && h('p', { class: 'muted soc-posting-note' }, 'Going up now. This updates by itself.'),
    entries.length ? h('ul', { class: 'soc-results' }, ...entries.map(([k, r]) => h('li', { class: r.status },
      h('span', { class: 'soc-r-name' }, soc.data.platforms[k] || k),
      r.status === 'posted'
        ? [r.url && h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'View'), r.note && h('span', { class: 'muted' }, ` ${r.note}`)]
        : h('span', { class: 'soc-r-error' }, r.error || 'Didn\'t post')))) : null,
    failed && h('button', { type: 'button', class: 'link-btn', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Trying again…';
      try { await api(`/api/social/${p.id}/retry`, { method: 'POST' }); } catch (err) { if (err.status) fail(err); else toast('Checking whether it posted…'); }
      finally { btn.disabled = false; btn.textContent = 'Try the failed ones again'; }
      await openSocial();
    } }, 'Try the failed ones again'));
}

function settingsCard() {
  const { settings: s, platforms, connections } = soc.data;
  const form = h('form', { class: 'soc-settings', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      soc.data.settings = await api('/api/social/settings', { method: 'PUT', body: {
        auto_draft: Boolean(f.get('auto_draft')), platforms: f.getAll('platforms'), caption: f.get('caption'), hashtags: f.get('hashtags'),
      } });
      toast('Saved');
    } catch (err) { fail(err); }
  } },
  h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'auto_draft', checked: s.auto_draft }),
    ' Make a draft when a job is marked Ready for pickup (only when the customer OK\'d it and there are after photos)'),
  h('div', { class: 'soc-label' }, 'Post to, by default'),
  h('div', { class: 'soc-platforms' }, ...Object.keys(platforms).map((k) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'platforms', value: k, checked: s.platforms.includes(k) }), ` ${platforms[k]}`,
    h('small', { class: connections[k] ? 'soc-ok' : 'muted' }, connections[k] ? ' · connected' : ' · not connected yet')))),
  h('label', { class: 'soc-label' }, 'Caption', h('textarea', { name: 'caption', rows: '3' }, s.caption)),
  h('p', { class: 'hint' }, 'Fills in: {vehicle} {color} {services} {company} {city} {phone} {make}. Customer names are never used.'),
  h('label', { class: 'soc-label' }, 'Hashtags', h('input', { name: 'hashtags', value: s.hashtags })),
  h('p', { class: 'hint' }, 'Facebook and Instagram post the photos; TikTok gets a photo post; YouTube Shorts gets a short before-and-after video made from them. Each platform is connected once on the server (see the README). TikTok and YouTube keep posts private until they approve the app.'),
  h('button', { type: 'submit', class: 'primary' }, 'Save'));
  return h('details', { class: 'card-section soc-panel-settings' }, h('summary', {}, h('h3', {}, 'Settings')), form);
}

function renderSocial() {
  const d = soc.data;
  fill($('#socialBody'),
    h('section', { class: 'card-section' },
      h('h3', {}, d.waiting.length ? `Waiting for you (${d.waiting.length})` : 'Waiting for you'),
      d.waiting.length ? h('div', { class: 'soc-list' }, ...d.waiting.map(draftCard))
        : h('p', { class: 'muted' }, 'Nothing waiting. When a job with after photos is marked Ready for pickup, and the customer OK\'d posting at drop-off, its post shows up here.')),
    d.done.length ? h('section', { class: 'card-section' }, h('h3', {}, 'Posted and skipped'), h('ul', { class: 'soc-done-list' }, ...d.done.map(doneRow))) : null,
    settingsCard());
}

// The job panel: the customer's OK (who recorded it, when and how), what's already posted from this job,
// and (admins) making a post.
function socialJobSection(job, edit) {
  if (job.status === 'cancelled') return null;
  const ok = job.social_ok === 1;
  const when = job.social_ok_at ? fmtDateTime(job.social_ok_at) : '';
  const by = job.social_ok_by ? ` (${job.social_ok_by})` : '';
  const record = ok
    ? (job.social_ok_how === 'signoff'
      ? `✓ ${job.signoff_name || 'The customer'} OK'd it on the drop-off sign-off · ${when}${by}`
      : `✓ The customer OK'd it (told staff) · ${when}${by}`)
    : job.social_ok_at && job.social_ok_how === 'staff'
      ? `The customer took back their OK · ${when}${by}`
      : 'The customer hasn\'t OK\'d posting photos of the vehicle.';
  const posts = job.social_posts || [];
  const live = posts.flatMap((p) => p.posted.map((x) => ({ ...x, at: p.posted_at })));
  const waiting = posts.some((p) => p.status === 'draft');
  return h('section', { class: 'card-section soc-job' },
    h('h3', {}, 'Social media'),
    h('p', { class: ok ? 'soc-ok' : 'muted' }, record),
    ok && h('p', { class: 'hint' }, 'Photos only: no names or license plates.'),
    live.length > 0 && h('div', { class: `soc-live ${ok ? '' : 'warn'}` },
      h('div', {}, h('strong', {}, 'Posted: '), ...live.flatMap((x, i) => [i ? ' · ' : '', x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name) : x.name]),
        live[0].at && h('span', { class: 'muted' }, ` · ${fmtDateTime(live[0].at)}`)),
      !ok && h('div', {}, 'These are still up. Take them down on each page by hand if the customer asks.')),
    waiting && isAdmin() && h('p', { class: 'hint' }, 'A post from this job is waiting in Social.'),
    h('div', { class: 'soc-job-actions' },
      edit && h('button', { type: 'button', class: ok ? 'link-btn' : '', onclick: async () => {
        if (ok && !await askConfirm('Take back the OK?', `Posts still waiting won't go up.${live.length ? ` Already posted to ${listNames(live.map((x) => x.name))}: those have to be taken down by hand.` : ''}`, { ok: 'Take it back' })) return;
        try {
          cal.job = await api(`/api/jobs/${job.id}/social-ok`, { method: 'PATCH', body: { ok: !ok } });
          renderJob();
          loadSocialBadge();
        } catch (err) { fail(err); }
      } }, ok ? 'They changed their mind' : 'Customer said OK'),
      isAdmin() && ok && !waiting && h('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          await api(`/api/social/jobs/${job.id}`, { method: 'POST' });
          loadSocialBadge();
          showPanel(null);
          openSocial();
        } catch (err) { fail(err); }
      } }, live.length ? 'Make another post' : 'Make a social post'),
      isAdmin() && waiting && h('button', { type: 'button', onclick: () => { showPanel(null); openSocial(); } }, 'Open in Social')));
}

function initSocial() {
  if (!isAdmin()) return;
  $('#socialBtn').addEventListener('click', openSocial);
  loadSocialBadge();
  setInterval(loadSocialBadge, 60_000);
}
