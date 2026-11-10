'use strict';
// Social posts (admins): finished jobs' before and after photos wait here as drafts. An admin picks the
// photos, edits the caption, picks where it goes and taps Post it (or Skip). Nothing is posted on its
// own. Uses the helpers from app.js ($, h, fill, api, toast, fail, showPanel, fmtDateTime, askConfirm).

const soc = { data: null, open: false };
const SOC_STATUS = { posting: 'Posting…', posted: 'Posted', partly: 'Partly posted', failed: 'Didn\'t post', skipped: 'Skipped' };

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
  } catch (err) { fail(err); }
}

const socPhotoUrl = (jobId, id) => `/api/jobs/${jobId}/photos/${id}`;

function draftCard(p) {
  const { platforms, connections } = soc.data;
  const chosen = new Set(p.photo_ids);
  const caption = h('textarea', { rows: '5', maxlength: '2200', 'aria-label': 'Caption' }, p.caption);
  const pick = Object.keys(platforms).map((k) => h('label', { class: `check soc-platform ${connections[k] ? '' : 'off'}`, title: connections[k] ? '' : 'Not connected yet' },
    h('input', { type: 'checkbox', value: k, checked: p.platforms.includes(k) && connections[k], disabled: !connections[k] }),
    ` ${platforms[k]}`, !connections[k] && h('small', { class: 'muted' }, ' (not connected)')));
  // Saves the photos, caption and places picked, then posts.
  const save = () => api(`/api/social/${p.id}`, { method: 'PATCH', body: {
    caption: caption.value,
    photo_ids: [...chosen],
    platforms: pick.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value),
  } });
  const photos = p.job.photos.filter((x) => x.phase !== 'during' || chosen.has(x.id));
  return h('section', { class: 'soc-card' },
    h('div', { class: 'soc-head' },
      h('div', {},
        h('strong', {}, p.job.vehicle),
        h('div', { class: 'muted' }, `${p.job.customer || 'Customer'} (not posted) · ${p.job.status === 'picked_up' ? 'Picked up' : 'Ready for pickup'}`)),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { showPanel(null); showSection('calendar'); openJob(p.job.id); } }, 'Open job')),
    h('div', { class: 'soc-label' }, 'Photos (tap to add or leave out; before photos first)'),
    h('div', { class: 'soc-photos' }, ...photos.map((x) => {
      const b = h('button', { type: 'button', class: `soc-photo ${chosen.has(x.id) ? 'on' : ''}`, 'aria-pressed': String(chosen.has(x.id)), title: x.caption || x.phase,
        onclick: () => { if (chosen.has(x.id)) chosen.delete(x.id); else chosen.add(x.id); b.classList.toggle('on', chosen.has(x.id)); b.setAttribute('aria-pressed', String(chosen.has(x.id))); } },
      h('img', { src: socPhotoUrl(p.job.id, x.id), alt: `${x.phase} photo`, loading: 'lazy' }),
      h('span', { class: `soc-phase ${x.phase}` }, x.phase));
      return b;
    })),
    h('label', { class: 'soc-label' }, 'Caption (no customer names)', caption),
    h('div', { class: 'soc-label' }, 'Post to'),
    h('div', { class: 'soc-platforms' }, ...pick),
    h('div', { class: 'soc-actions' },
      h('button', { type: 'button', class: 'primary', onclick: async (e) => {
        const btn = e.currentTarget;
        if (!chosen.size) return toast('Pick at least one photo', 'error');
        if (!pick.some((l) => l.querySelector('input').checked)) return toast('Pick at least one place to post it', 'error');
        btn.disabled = true;
        btn.textContent = 'Posting… (the video takes a few seconds)';
        try {
          await save();
          const done = await api(`/api/social/${p.id}/post`, { method: 'POST' });
          toast(done.status === 'posted' ? 'Posted!' : done.status === 'partly' ? 'Posted to some places. See what didn\'t go below.' : 'It didn\'t post. See why below.', done.status === 'failed' ? 'error' : '');
          loadSocialBadge();
          await openSocial();
        } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Post it'; }
      } }, 'Post it'),
      h('button', { type: 'button', onclick: async () => {
        try { await save(); toast('Saved'); } catch (err) { fail(err); }
      } }, 'Save for later'),
      h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        if (!await askConfirm('Skip this post?', 'It won\'t be posted. You can make a new one from the job later.', { ok: 'Skip it' })) return;
        try { await api(`/api/social/${p.id}/skip`, { method: 'POST' }); loadSocialBadge(); await openSocial(); } catch (err) { fail(err); }
      } }, 'Skip')));
}

function doneRow(p) {
  const entries = Object.entries(p.results || {});
  const failed = entries.some(([, r]) => r.status === 'failed');
  return h('li', { class: `soc-done ${p.status}` },
    h('div', { class: 'soc-done-top' },
      h('strong', {}, p.job.vehicle),
      h('span', { class: `tc-badge ${p.status === 'posted' ? 'approved' : p.status === 'skipped' ? '' : p.status === 'partly' ? 'pending' : 'denied'}` }, SOC_STATUS[p.status] || p.status),
      h('span', { class: 'muted' }, `${p.decided_by ? `${p.decided_by} · ` : ''}${fmtDateTime(p.decided_at || p.created_at)}`)),
    entries.length ? h('ul', { class: 'soc-results' }, ...entries.map(([k, r]) => h('li', { class: r.status },
      h('span', { class: 'soc-r-name' }, soc.data.platforms[k] || k),
      r.status === 'posted'
        ? [r.url && h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'View'), r.note && h('span', { class: 'muted' }, ` ${r.note}`)]
        : h('span', { class: 'soc-r-error' }, r.error || 'Didn\'t post')))) : null,
    failed && h('button', { type: 'button', class: 'link-btn', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api(`/api/social/${p.id}/retry`, { method: 'POST' }); await openSocial(); } catch (err) { fail(err); }
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

// The job panel: the customer's OK, and (admins) making a post from this job.
function socialJobSection(job, edit) {
  if (job.status === 'cancelled') return null;
  const ok = job.social_ok === 1;
  return h('section', { class: 'card-section soc-job' },
    h('h3', {}, 'Social media'),
    h('p', { class: ok ? 'soc-ok' : 'muted' }, ok ? '✓ The customer OK\'d posting photos of the vehicle (no names or plates).' : 'The customer hasn\'t OK\'d posting photos of the vehicle.'),
    h('div', { class: 'soc-job-actions' },
      edit && h('button', { type: 'button', class: ok ? 'link-btn' : '', onclick: async () => {
        try {
          cal.job = await api(`/api/jobs/${job.id}/social-ok`, { method: 'PATCH', body: { ok: !ok } });
          renderJob();
        } catch (err) { fail(err); }
      } }, ok ? 'They changed their mind' : 'Customer said OK'),
      isAdmin() && ok && h('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          await api(`/api/social/jobs/${job.id}`, { method: 'POST' });
          loadSocialBadge();
          showPanel(null);
          openSocial();
        } catch (err) { fail(err); }
      } }, 'Make a social post')));
}

function initSocial() {
  if (!isAdmin()) return;
  $('#socialBtn').addEventListener('click', openSocial);
  loadSocialBadge();
  setInterval(loadSocialBadge, 60_000);
}
