'use strict';
// Social posts (admins). Four tabs:
//  - Calendar: what's going out when, and the posts waiting to be approved (Approve, or Move back to Drafts).
//  - Drafts: posts being worked on. A finished job's post lands here by itself; New post starts one from
//    scratch. The editor: what kind of post, photos and clips (from any job whose customer said OK, or
//    uploaded), Photos or a Reel video, the words on the video, an optional AI intro clip, the caption
//    (Claude can write it), where it goes, a live phone preview, then Schedule for approval or Post now.
//  - Posted: what went out, with links, and Try again for the ones that didn't.
//  - Settings: defaults, the approval lead time, music for Reels, the caption template.
// Uses the helpers from app.js ($, h, fill, api, toast, fail, showPanel, fmtDateTime, ask, askConfirm).

const soc = { data: null, poll: null, tab: 'calendar', open: null, month: null, library: null, picker: false, pickerTab: 'jobs' };
const SOC_STATUS = {
  draft: 'Draft', scheduled: 'Needs approval', approved: 'Approved', posting: 'Posting…', posted: 'Posted', partly: 'Partly posted', failed: 'Didn\'t post', skipped: 'Skipped',
};
const SOC_SLIDE_MS = 2600;
const SOC_CHECKS = ['No license plates can be read', 'No faces, names or paperwork (key tags, invoices) show', 'The caption has no customer names'];

async function loadSocialBadge() {
  if (!isAdmin()) return;
  try {
    const { count } = await api('/api/social/waiting');
    const b = $('#socialBadge');
    b.textContent = count;
    b.hidden = !count;
  } catch { /* try again later */ }
}

async function openSocial(opts = {}) {
  if (opts.tab) soc.tab = opts.tab;
  if ('open' in opts) soc.open = opts.open;
  try {
    await socReload();
    showPanel($('#socialPanel'));
  } catch (err) { fail(err); }
}
async function socReload() {
  soc.data = await api('/api/social');
  renderSocial();
  watchSocial();
}
const allPosts = () => [...soc.data.drafts, ...soc.data.planned, ...soc.data.done];
const findPost = (id) => allPosts().find((p) => p.id === id);

// While a post is going up or an AI clip is being made, check every few seconds (the panel can be closed).
function watchSocial() {
  clearTimeout(soc.poll);
  const busy = soc.data?.done.some((p) => p.status === 'posting') || allPosts().some((p) => p.ai_clip?.status === 'making');
  if (!busy) return;
  soc.poll = setTimeout(async () => {
    if ($('#socialPanel').hidden) return;
    // Don't redraw an editor someone is typing in; just refresh what's around it.
    const editing = soc.open && findPost(soc.open)?.status === 'draft';
    try {
      const fresh = await api('/api/social');
      const before = editing && findPost(soc.open)?.ai_clip?.status;
      soc.data = fresh;
      const after = editing && findPost(soc.open)?.ai_clip?.status;
      if (!editing || before !== after) renderSocial();
      loadSocialBadge();
    } catch { /* next look */ }
    watchSocial();
  }, 5000);
}

const listNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const socTitle = (p) => p.title || p.job?.vehicle || soc.data.types[p.post_type] || 'Post';
const socWhen = (iso) => (iso ? fmtDateTime(iso) : '');
function timeLeft(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'time\'s up';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min left`;
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} left`;
  return `${Math.floor(h / 24)} days left`;
}
// A small picture for a post: its first photo (or a clip mark).
function socThumb(p) {
  const first = p.items.find((i) => !i.missing);
  if (!first) return h('span', { class: 'soc-thumb empty' }, '📝');
  if (first.kind === 'clip') return h('span', { class: 'soc-thumb clip' }, '▶');
  return h('img', { class: 'soc-thumb', src: first.url, alt: '', loading: 'lazy' });
}

// ---------- the panel ----------
function renderSocial() {
  const d = soc.data;
  const open = soc.open && findPost(soc.open);
  if (soc.open && !open) soc.open = null;
  const needs = d.planned.filter((p) => p.status === 'scheduled').length;
  const tabs = h('div', { class: 'seg soc-tabs', role: 'tablist' },
    ...[['calendar', `Calendar${needs ? ` · ${needs} to approve` : ''}`], ['drafts', `Drafts${d.drafts.length ? ` (${d.drafts.length})` : ''}`], ['posted', 'Posted'], ['settings', 'Settings']]
      .map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-pressed': String(!open && soc.tab === id), onclick: () => { soc.tab = id; soc.open = null; renderSocial(); } }, label)));
  const top = h('div', { class: 'soc-top' }, tabs,
    h('button', { type: 'button', class: 'primary', onclick: () => newPost() }, '+ New post'));
  let body;
  if (open) body = open.status === 'draft' ? socEditor(open) : socView(open);
  else if (soc.tab === 'drafts') body = draftsTab();
  else if (soc.tab === 'posted') body = postedTab();
  else if (soc.tab === 'settings') body = settingsCard();
  else body = calendarTab();
  fill($('#socialBody'), top, body);
}

async function newPost() {
  const type = await pickType();
  if (!type) return;
  try {
    const p = await api('/api/social', { method: 'POST', body: { post_type: type } });
    soc.open = p.id;
    soc.picker = true;
    soc.pickerTab = type === 'before_after' || type === 'showcase' ? 'jobs' : 'uploads';
    await socReload();
  } catch (err) { fail(err); }
}
// What kind of post: a small dialog of choices.
function pickType() {
  return new Promise((resolve) => {
    const icons = { before_after: '✨', showcase: '🚗', tip: '💡', offer: '🏷️', review: '⭐', behind: '🎬' };
    const dialog = h('dialog', { class: 'soc-type-dialog' },
      h('h3', {}, 'What kind of post?'),
      h('div', { class: 'soc-types' }, ...Object.entries(soc.data.types).map(([k, label]) => h('button', { type: 'button', class: 'soc-type', onclick: () => { dialog.close(); resolve(k); } },
        h('span', { class: 'soc-type-icon', 'aria-hidden': 'true' }, icons[k] || '📣'), label))),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', onclick: () => { dialog.close(); resolve(null); } }, 'Cancel')));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(null); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// ---------- Calendar ----------
function calendarTab() {
  const d = soc.data;
  const needs = d.planned.filter((p) => p.status === 'scheduled');
  const approved = d.planned.filter((p) => p.status === 'approved');
  const month = soc.month || (soc.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  return h('div', { class: 'soc-cal' },
    needs.length ? h('section', { class: 'card-section soc-needs' },
      h('h3', {}, `Waiting for approval (${needs.length})`),
      h('p', { class: 'hint' }, `Each has to be approved by its deadline (${d.settings.approve_days} day${d.settings.approve_days === 1 ? '' : 's'} before it goes out), or it won't go out and goes back to Drafts.`),
      h('div', { class: 'soc-plan-list' }, ...needs.map(planCard))) : null,
    approved.length ? h('section', { class: 'card-section' },
      h('h3', {}, 'Approved and scheduled'),
      h('div', { class: 'soc-plan-list' }, ...approved.map(planCard))) : null,
    !needs.length && !approved.length ? h('p', { class: 'muted soc-empty' }, 'Nothing scheduled yet. Make a post (or open a draft), pick a day and time, and it shows up here for approval.') : null,
    monthGrid(month));
}
function planCard(p) {
  const due = p.status === 'scheduled';
  const urgent = due && new Date(p.approve_by) - Date.now() < 86400000;
  return h('article', { class: `soc-plan ${p.status}` },
    h('button', { type: 'button', class: 'soc-plan-main', onclick: () => { soc.open = p.id; renderSocial(); } },
      socThumb(p),
      h('div', { class: 'soc-plan-text' },
        h('strong', {}, socTitle(p)),
        h('span', {}, `Goes out ${socWhen(p.scheduled_for)} · ${p.video_style === 'reel' ? 'Reel' : 'Photos'} · ${p.platforms.map((k) => soc.data.platforms[k]).join(', ')}`),
        due ? h('span', { class: urgent ? 'soc-urgent' : 'muted' }, `Approve by ${socWhen(p.approve_by)} · ${timeLeft(p.approve_by)}`)
          : h('span', { class: 'soc-ok' }, `✓ Approved by ${p.approved_by || 'an admin'} · ${socWhen(p.approved_at)}`))),
    h('div', { class: 'soc-plan-actions' },
      due && h('button', { type: 'button', class: 'primary', onclick: () => approvePost(p) }, 'Approve'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { soc.open = p.id; renderSocial(); } }, 'Look')));
}
function monthGrid(month) {
  const d = soc.data;
  const first = new Date(month);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const byDay = new Map();
  const add = (iso, p, kind) => {
    if (!iso) return;
    const t = new Date(iso);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ p, kind, t });
  };
  for (const p of d.planned) add(p.scheduled_for, p, p.status);
  for (const p of d.done) if (['posted', 'partly'].includes(p.status)) add(p.posted_at, p, 'posted');
  for (const p of d.drafts) if (p.missed_at && p.scheduled_for) add(p.scheduled_for, p, 'missed');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    if (i >= 35 && day.getMonth() !== month.getMonth()) break;
    const items = (byDay.get(`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`) || []).sort((a, b) => a.t - b.t);
    cells.push(h('div', { class: `soc-day ${day.getMonth() !== month.getMonth() ? 'other' : ''} ${day.getTime() === today.getTime() ? 'today' : ''}` },
      h('span', { class: 'soc-day-n' }, day.getDate()),
      ...items.map(({ p, kind, t }) => h('button', { type: 'button', class: `soc-chip ${kind}`, title: `${SOC_STATUS[p.status] || ''} · ${socTitle(p)}`, onclick: () => { soc.open = p.id; renderSocial(); } },
        h('b', {}, t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase()), ` ${socTitle(p)}`))));
  }
  const step = (n) => { soc.month = new Date(month.getFullYear(), month.getMonth() + n, 1); renderSocial(); };
  return h('section', { class: 'card-section soc-month' },
    h('div', { class: 'soc-month-head' },
      h('button', { type: 'button', class: 'nav-arrow', 'aria-label': 'Last month', onclick: () => step(-1) }, '‹'),
      h('h3', {}, month.toLocaleDateString([], { month: 'long', year: 'numeric' })),
      h('button', { type: 'button', class: 'nav-arrow', 'aria-label': 'Next month', onclick: () => step(1) }, '›')),
    h('div', { class: 'soc-grid' }, ...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((x) => h('span', { class: 'soc-dow' }, x)), ...cells),
    h('div', { class: 'soc-legend' },
      h('span', { class: 'soc-chip scheduled' }, 'Needs approval'), h('span', { class: 'soc-chip approved' }, 'Approved'),
      h('span', { class: 'soc-chip posted' }, 'Posted'), h('span', { class: 'soc-chip missed' }, 'Missed (not approved in time)')));
}

async function approvePost(p) {
  const names = p.platforms.map((k) => soc.data.platforms[k]);
  const go = await ask({
    title: `Approve "${socTitle(p)}"?`,
    text: `It goes out by itself ${socWhen(p.scheduled_for)} to ${listNames(names)}. Look at it once more:`,
    checks: SOC_CHECKS,
    ok: 'Approve',
  });
  if (!go) return;
  try {
    await api(`/api/social/${p.id}/approve`, { method: 'POST' });
    toast('Approved. It goes out at its time.');
    loadSocialBadge();
    await socReload();
  } catch (err) { fail(err); }
}

// ---------- Drafts ----------
function draftsTab() {
  const d = soc.data;
  if (!d.drafts.length) {
    return h('p', { class: 'muted soc-empty' }, 'No drafts. Tap New post, or mark a job Ready for pickup (with after photos and the customer\'s OK) and its post shows up here.');
  }
  return h('div', { class: 'soc-drafts' }, ...d.drafts.map((p) => h('button', { type: 'button', class: `soc-draft ${p.missed_at ? 'missed' : ''}`, onclick: () => { soc.open = p.id; renderSocial(); } },
    socThumb(p),
    h('span', { class: 'soc-draft-text' },
      h('strong', {}, socTitle(p)),
      h('span', { class: 'muted' }, `${d.types[p.post_type] || ''} · ${p.items.length} ${p.items.length === 1 ? 'item' : 'items'} · ${p.video_style === 'reel' ? 'Reel' : 'Photos'}`),
      p.missed_at ? h('span', { class: 'soc-urgent' }, p.results?._error ? `Didn't go out: ${p.results._error.error}` : `Not approved in time for ${socWhen(p.scheduled_for)}`)
        : h('span', { class: 'muted' }, p.kind === 'job' ? 'From a finished job' : `Started by ${p.created_by || 'an admin'}`)))));
}

// ---------- Posted ----------
function postedTab() {
  const d = soc.data;
  if (!d.done.length) return h('p', { class: 'muted soc-empty' }, 'Nothing posted yet.');
  return h('ul', { class: 'soc-done-list' }, ...d.done.map(doneRow));
}
function doneRow(p) {
  const entries = Object.entries(p.results || {}).filter(([k]) => k !== '_error');
  const failed = p.status !== 'posting' && entries.some(([, r]) => r.status === 'failed');
  return h('li', { class: `soc-done ${p.status}` },
    h('div', { class: 'soc-done-top' },
      socThumb(p),
      h('strong', {}, socTitle(p)),
      h('span', { class: `tc-badge ${p.status === 'posted' ? 'approved' : p.status === 'skipped' ? '' : ['partly', 'posting'].includes(p.status) ? 'pending' : 'denied'}` }, SOC_STATUS[p.status] || p.status),
      h('span', { class: 'muted' }, `${p.decided_by ? `${p.decided_by} · ` : ''}${fmtDateTime(p.posted_at || p.decided_at || p.created_at)}${p.scheduled_for && p.status !== 'skipped' ? ' · scheduled' : ''}`)),
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
      await socReload();
    } }, 'Try the failed ones again'));
}

// ---------- a scheduled or finished post (not editable) ----------
function socView(p) {
  const d = soc.data;
  const back = h('button', { type: 'button', class: 'link-btn soc-back', onclick: () => { soc.open = null; renderSocial(); } }, '← Back');
  const lines = [
    ['Kind', d.types[p.post_type] || ''],
    ['Format', p.video_style === 'reel' ? `Reel video${p.ai_used ? ' with an AI intro (labeled)' : ''}` : 'Photos'],
    ['Goes to', p.platforms.map((k) => d.platforms[k]).join(', ')],
    p.scheduled_for && ['Goes out', socWhen(p.scheduled_for)],
    p.status === 'scheduled' && ['Approve by', `${socWhen(p.approve_by)} (${timeLeft(p.approve_by)})`],
    p.approved_by && ['Approved', `${p.approved_by} · ${socWhen(p.approved_at)}`],
    p.submitted_by && ['Scheduled by', `${p.submitted_by} · ${socWhen(p.submitted_at)}`],
  ].filter(Boolean);
  return h('div', { class: 'soc-editor' },
    h('div', { class: 'soc-ed-left' },
      back,
      h('h3', { class: 'soc-ed-title' }, socTitle(p), ' ', h('span', { class: `soc-status ${p.status}` }, SOC_STATUS[p.status] || p.status)),
      h('dl', { class: 'soc-facts' }, ...lines.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('div', { class: 'soc-label' }, 'Caption'),
      h('p', { class: 'soc-caption-view' }, p.caption),
      ['scheduled', 'approved'].includes(p.status) && h('div', { class: 'soc-actions' },
        p.status === 'scheduled' && h('button', { type: 'button', class: 'primary', onclick: () => approvePost(p) }, 'Approve'),
        h('button', { type: 'button', onclick: async () => {
          if (!await askConfirm('Move it back to Drafts?', p.status === 'approved' ? 'It won\'t go out, and it needs scheduling and approving again.' : 'It won\'t go out until it\'s scheduled again.', { ok: 'Move to Drafts' })) return;
          try { await api(`/api/social/${p.id}/unschedule`, { method: 'POST' }); loadSocialBadge(); await socReload(); } catch (err) { fail(err); }
        } }, 'Move back to Drafts (to change it)'),
        h('button', { type: 'button', class: 'link-btn', onclick: () => skipPost(p) }, 'Cancel it')),
      !['scheduled', 'approved', 'draft'].includes(p.status) && h('ul', { class: 'soc-done-list' }, doneRow(p))),
    socPreview(() => viewState(p)).el);
}
const viewState = (p) => ({ items: p.items, video_style: p.video_style, overlay: p.overlay, caption: p.caption, ai: p.ai_used ? p.id : null });

async function skipPost(p) {
  if (!await askConfirm(p.status === 'draft' ? 'Skip this post?' : 'Cancel this post?', 'It won\'t be posted. It stays in Posted as skipped.', { ok: p.status === 'draft' ? 'Skip it' : 'Cancel it' })) return;
  try { await api(`/api/social/${p.id}/skip`, { method: 'POST' }); soc.open = null; loadSocialBadge(); await socReload(); } catch (err) { fail(err); }
}

// ---------- the editor (a draft) ----------
function socEditor(p) {
  const d = soc.data;
  const st = {
    items: p.items.filter((i) => !i.missing).map((i) => ({ ...i })),
    post_type: p.post_type, title: p.title || '', notes: p.notes || '', video_style: p.video_style,
    overlay: { hook: p.overlay.hook || '', end_text: p.overlay.end_text || '' }, platforms: [...p.platforms],
  };
  const caption = h('textarea', { rows: '6', maxlength: '2200', 'aria-label': 'Caption', placeholder: 'What the post says. No customer names.' }, p.caption);

  // Saves as you go: a moment after each change.
  const status = h('span', { class: 'soc-saved muted', 'aria-live': 'polite' }, 'Saved');
  let timer = null;
  let saving = Promise.resolve();
  const body = () => ({
    caption: caption.value, platforms: st.platforms, title: st.title, notes: st.notes, post_type: st.post_type, video_style: st.video_style, overlay: st.overlay,
    items: st.items.map((i) => (i.src === 'upload' ? { src: 'upload', id: i.id } : { src: 'job', job_id: i.job_id, photo_id: i.photo_id })),
  });
  const saveNow = () => {
    clearTimeout(timer);
    timer = null;
    status.textContent = 'Saving…';
    saving = api(`/api/social/${p.id}`, { method: 'PATCH', body: body() })
      .then((fresh) => { Object.assign(p, fresh); status.textContent = 'Saved'; status.classList.remove('soc-unsaved'); })
      .catch((err) => { status.textContent = `Not saved: ${err.message}`; status.classList.add('soc-unsaved'); throw err; });
    return saving;
  };
  const changed = () => {
    status.textContent = 'Unsaved changes';
    clearTimeout(timer);
    timer = setTimeout(() => saveNow().catch(() => {}), 800);
    preview.update();
  };
  const flush = () => (timer ? saveNow() : saving);
  caption.addEventListener('input', changed);
  caption.addEventListener('blur', () => { if (timer) saveNow().catch(() => {}); });

  const preview = socPreview(() => ({ items: st.items, video_style: st.video_style, overlay: st.overlay, caption: caption.value, ai: p.ai_clip?.status === 'ready' && st.video_style === 'reel' ? p.id : null }));

  // What kind, the name, and the notes (Claude uses the notes).
  const typeSel = h('select', { 'aria-label': 'Kind of post', onchange: (e) => { st.post_type = e.target.value; changed(); } },
    ...Object.entries(d.types).map(([k, v]) => h('option', { value: k, selected: k === st.post_type }, v)));
  const titleIn = h('input', { value: st.title, maxlength: '80', placeholder: p.job ? p.job.vehicle : 'e.g. December special', oninput: (e) => { st.title = e.target.value; changed(); } });
  const notesIn = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'e.g. 15% off full coatings booked in December. Or the tip, or what the customer said.', oninput: (e) => { st.notes = e.target.value; changed(); } }, st.notes);

  // Photos and clips, in order.
  const strip = h('div', { class: 'soc-strip' });
  const paintStrip = () => {
    fill(strip, ...st.items.map((it, i) => h('div', { class: 'soc-tile on' },
      it.kind === 'clip' ? h('video', { src: it.url, muted: true, preload: 'metadata', playsinline: true }) : h('img', { src: it.url, alt: '', loading: 'lazy' }),
      h('span', { class: 'soc-order' }, i + 1),
      it.phase && h('span', { class: `soc-phase ${it.phase}` }, it.phase),
      it.kind === 'clip' && h('span', { class: 'soc-phase clip' }, 'clip'),
      h('div', { class: 'soc-tile-tools' },
        i > 0 && h('button', { type: 'button', 'aria-label': 'Move earlier', onclick: () => { st.items.splice(i - 1, 0, st.items.splice(i, 1)[0]); paintStrip(); changed(); } }, '‹'),
        i < st.items.length - 1 && h('button', { type: 'button', 'aria-label': 'Move later', onclick: () => { st.items.splice(i + 1, 0, st.items.splice(i, 1)[0]); paintStrip(); changed(); } }, '›'),
        h('button', { type: 'button', 'aria-label': 'Take out', onclick: () => { st.items.splice(i, 1); paintStrip(); paintPicker(); changed(); } }, '×')))),
    st.items.length < 10 && h('button', { type: 'button', class: 'soc-tile add', onclick: () => { soc.picker = !soc.picker; paintPicker(); } }, soc.picker ? 'Done' : '+ Add'));
  };
  const picker = h('div', { class: 'soc-picker' });
  const keyOf = (i) => (i.src === 'upload' ? `u${i.id}` : `j${i.photo_id}`);
  const toggle = (it) => {
    const k = keyOf(it);
    const at = st.items.findIndex((x) => keyOf(x) === k);
    if (at >= 0) st.items.splice(at, 1);
    else if (st.items.length >= 10) return toast('Up to 10 photos and clips', 'error');
    else st.items.push(it);
    paintStrip(); paintPicker(); changed();
  };
  const pickTile = (it, label) => {
    const on = st.items.some((x) => keyOf(x) === keyOf(it));
    return h('button', { type: 'button', class: `soc-tile ${on ? 'on' : ''}`, 'aria-pressed': String(on), title: label, onclick: () => toggle(it) },
      it.kind === 'clip' ? h('video', { src: it.url, muted: true, preload: 'metadata', playsinline: true }) : h('img', { src: it.url, alt: label, loading: 'lazy' }),
      it.phase && h('span', { class: `soc-phase ${it.phase}` }, it.phase),
      it.kind === 'clip' && h('span', { class: 'soc-phase clip' }, 'clip'),
      on && h('span', { class: 'soc-check' }, '✓'));
  };
  const paintPicker = async () => {
    picker.hidden = !soc.picker;
    paintStrip();
    if (!soc.picker) return;
    if (!soc.library) {
      fill(picker, h('p', { class: 'muted' }, 'Loading photos…'));
      try { soc.library = await api('/api/social/library'); } catch (err) { fill(picker, h('p', { class: 'soc-urgent' }, err.message)); return; }
    }
    const lib = soc.library;
    const upload = h('label', { class: 'soc-upload' }, '⬆ Upload photos or clips',
      h('input', { type: 'file', accept: 'image/*,video/mp4,video/quicktime,video/webm', multiple: true, hidden: true, onchange: (e) => uploadMedia(e, (made) => { made.forEach((m) => { if (st.items.length < 10) st.items.push({ src: 'upload', id: m.id, kind: m.kind, url: m.url, name: m.name }); }); paintStrip(); paintPicker(); changed(); }) }));
    const tabsEl = h('div', { class: 'seg soc-picker-tabs' },
      ...[['jobs', 'From jobs'], ['uploads', `Uploads (${lib.uploads.length})`]].map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(soc.pickerTab === k), onclick: () => { soc.pickerTab = k; paintPicker(); } }, label)));
    const content = soc.pickerTab === 'uploads'
      ? [h('div', { class: 'soc-picker-row' }, upload, h('span', { class: 'hint' }, 'Your own photos and short clips (shop shots, polishing, water beading). Clips go in Reels.')),
        lib.uploads.length ? h('div', { class: 'soc-grid-tiles' }, ...lib.uploads.map((u) => pickTile({ src: 'upload', id: u.id, kind: u.kind, url: u.url, name: u.name }, u.name || u.kind))) : h('p', { class: 'muted' }, 'Nothing uploaded yet.')]
      : [h('p', { class: 'hint' }, 'Only jobs whose customer OK\'d posting photos of their vehicle.'),
        ...(lib.jobs.length ? lib.jobs.map((j) => h('div', { class: 'soc-job-group' },
          h('div', { class: 'soc-job-name' }, h('strong', {}, j.vehicle), h('span', { class: 'muted' }, ` · ${new Date(j.start_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`)),
          h('div', { class: 'soc-grid-tiles' }, ...j.photos.map((ph) => pickTile({ src: 'job', job_id: j.id, photo_id: ph.id, kind: 'photo', phase: ph.phase, url: ph.url }, `${ph.phase} photo`)))))
          : [h('p', { class: 'muted' }, 'No jobs with photos and the customer\'s OK yet.')])];
    fill(picker, tabsEl, ...content);
  };

  // Photos or a Reel.
  const styleSeg = h('div', { class: 'seg soc-style' },
    ...[['photos', '🖼 Photos'], ['reel', '🎬 Reel video']].map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(st.video_style === k), onclick: () => {
      st.video_style = k;
      styleSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['photos', 'reel'][i] === k)));
      reelBox.hidden = k !== 'reel';
      styleHint.textContent = styleText();
      changed();
    } }, label)));
  const styleText = () => (st.video_style === 'reel'
    ? 'One vertical video everywhere: the photos zoom in slowly, BEFORE / AFTER labels, a wipe from before to after, your words on screen, and an ending with the logo and phone number.'
    : 'Facebook and Instagram get the photos, TikTok a photo post, YouTube Shorts a simple slideshow. Clips need a Reel.');
  const styleHint = h('p', { class: 'hint' }, styleText());
  const hookIn = h('input', { value: st.overlay.hook, maxlength: '60', placeholder: 'e.g. Watch this finish come back', oninput: (e) => { st.overlay.hook = e.target.value; changed(); } });
  const endIn = h('input', { value: st.overlay.end_text, maxlength: '40', placeholder: 'Book yours today', oninput: (e) => { st.overlay.end_text = e.target.value; changed(); } });
  const reelBox = h('div', { class: 'soc-reel-box', hidden: st.video_style !== 'reel' },
    h('label', { class: 'soc-label' }, 'Opening words (on the first shot)', hookIn),
    h('label', { class: 'soc-label' }, 'Ending words (the phone number goes under them)', endIn),
    aiClipBox(p, () => flush()),
    h('div', { class: 'soc-render' },
      h('button', { type: 'button', onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Making the video… (about 15 seconds)';
        try {
          await flush();
          const r = await api(`/api/social/${p.id}/render`, { method: 'POST' });
          preview.showVideo(r.video.url, r.video.note);
        } catch (err) { fail(err); } finally { btn.disabled = false; btn.textContent = 'Make the real video to watch'; }
      } }, 'Make the real video to watch'),
      h('span', { class: 'hint' }, 'The preview on the right is quick; this makes the actual video.')));

  // Write it for me.
  const writeBtn = h('button', { type: 'button', class: 'soc-write', onclick: async () => {
    if (caption.value.trim() && !await askConfirm('Replace the caption?', 'It writes a new caption, hashtags and the words on the video.', { ok: 'Write it' })) return;
    writeBtn.disabled = true;
    writeBtn.textContent = 'Writing…';
    try {
      await flush();
      const r = await api(`/api/social/${p.id}/write`, { method: 'POST' });
      if (r.error) toast(r.error, 'error');
      const s = r.suggestion;
      caption.value = s.caption;
      st.overlay.hook = s.hook; hookIn.value = s.hook;
      st.overlay.end_text = s.end_text; endIn.value = s.end_text;
      const promptBox = $('#socClipPrompt');
      if (promptBox && !promptBox.value.trim()) promptBox.value = s.clip_prompt;
      changed();
    } catch (err) { fail(err); } finally { writeBtn.disabled = false; writeBtn.textContent = d.ai.writer ? '✨ Write it for me' : '✨ Fill in a starting point'; }
  } }, d.ai.writer ? '✨ Write it for me' : '✨ Fill in a starting point');

  const pick = Object.keys(d.platforms).map((k) => h('label', { class: `check soc-platform ${d.connections[k] ? '' : 'off'}`, title: d.connections[k] ? '' : 'Not connected yet' },
    h('input', { type: 'checkbox', value: k, checked: st.platforms.includes(k), onchange: (e) => {
      st.platforms = e.target.checked ? [...new Set([...st.platforms, k])] : st.platforms.filter((x) => x !== k);
      changed();
    } }), ` ${d.platforms[k]}`, !d.connections[k] && h('small', { class: 'muted' }, ' (not connected)')));

  // When: the earliest time it can be scheduled (the approval lead time), on the hour.
  const lead = d.settings.approve_days;
  const earliest = new Date(Date.now() + lead * 86400000 + 10 * 60000);
  const suggest = new Date(earliest); suggest.setMinutes(0, 0, 0); suggest.setHours(suggest.getHours() + 1);
  if (suggest.getHours() < 9) suggest.setHours(10); else if (suggest.getHours() > 19) { suggest.setDate(suggest.getDate() + 1); suggest.setHours(10); }
  const local = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const whenIn = h('input', { type: 'datetime-local', value: local(p.missed_at || !p.scheduled_for ? suggest : new Date(p.scheduled_for)), min: local(earliest), 'aria-label': 'When it goes out' });

  const scheduleBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    if (!whenIn.value) return toast('Pick a day and time', 'error');
    try {
      await flush();
      await api(`/api/social/${p.id}/schedule`, { method: 'POST', body: { at: new Date(whenIn.value).toISOString() } });
      toast(lead ? `Scheduled. It needs approving within ${lead === 1 ? 'a day' : `${lead} days`} of going out (by the deadline shown).` : 'Scheduled. Approve it before its time.');
      soc.open = null; soc.tab = 'calendar';
      loadSocialBadge();
      await socReload();
    } catch (err) { fail(err); }
  } }, 'Schedule for approval');
  const postBtn = h('button', { type: 'button', onclick: async () => {
    if (!st.items.length) return toast('Pick at least one photo', 'error');
    if (!st.platforms.length) return toast('Pick at least one place to post it', 'error');
    const names = st.platforms.map((k) => d.platforms[k]);
    const go = await ask({
      title: `Post to ${listNames(names)} now?`,
      text: `${st.video_style === 'reel' ? 'The Reel' : `${st.items.length} photo${st.items.length === 1 ? '' : 's'}`} go${st.video_style === 'reel' ? 'es' : ''} up on the company's pages right away. Look once more:`,
      checks: SOC_CHECKS,
      ok: 'Post it',
    });
    if (!go) return;
    postBtn.disabled = true;
    postBtn.textContent = 'Posting…';
    note.hidden = false;
    try {
      await flush();
      const done = await api(`/api/social/${p.id}/post`, { method: 'POST' });
      toast(done.status === 'posted' ? 'Posted!' : done.status === 'partly' ? 'Posted to some places. See what didn\'t go under Posted.' : 'It didn\'t post. See why under Posted.', done.status === 'failed' ? 'error' : '');
    } catch (err) {
      if (!err.status) toast('Checking whether it posted…'); else fail(err);
    }
    soc.open = null; soc.tab = 'posted';
    loadSocialBadge();
    await socReload();
  } }, 'Post now');
  const note = h('p', { class: 'hint soc-posting-note', hidden: true }, 'Getting it ready and posting. You can close this; it keeps going, and the result shows under Posted.');

  const missed = p.missed_at && h('div', { class: 'soc-missed' },
    h('strong', {}, p.results?._error ? 'It couldn\'t go out' : 'Not approved in time'),
    h('span', {}, p.results?._error ? `${p.results._error.error} Fix it and schedule it again.` : `It was set for ${socWhen(p.scheduled_for)}, but nobody approved it by the deadline, so it didn't go out. Pick a new time.`));

  paintStrip();
  paintPicker();
  return h('div', { class: 'soc-editor' },
    h('div', { class: 'soc-ed-left' },
      h('button', { type: 'button', class: 'link-btn soc-back', onclick: async () => { await flush().catch(() => {}); soc.open = null; soc.tab = 'drafts'; await socReload(); } }, '← Drafts'),
      missed,
      p.job && h('p', { class: 'muted' }, `From the ${p.job.vehicle} job (${p.job.customer || 'customer'}, not posted). `,
        h('button', { type: 'button', class: 'link-btn', onclick: async () => { await flush().catch(() => {}); showPanel(null); showSection('calendar'); openJob(p.job.id); } }, 'Open job')),
      h('div', { class: 'soc-row2' }, h('label', { class: 'soc-label' }, 'Kind of post', typeSel), h('label', { class: 'soc-label' }, 'Name (just for you)', titleIn)),
      h('label', { class: 'soc-label' }, 'What\'s it about? (helps the writing)', notesIn),
      h('div', { class: 'soc-label' }, 'Photos and clips, in order'),
      strip, picker,
      h('div', { class: 'soc-label' }, 'Format'), styleSeg, styleHint, reelBox,
      h('div', { class: 'soc-label soc-cap-head' }, h('span', {}, 'Caption (no customer names)'), writeBtn),
      caption,
      h('div', { class: 'soc-label' }, 'Post to'),
      h('div', { class: 'soc-platforms' }, ...pick),
      h('div', { class: 'soc-when' },
        h('label', { class: 'soc-label' }, 'When it goes out', whenIn),
        h('p', { class: 'hint' }, lead
          ? `An admin has to approve it at least ${lead} day${lead === 1 ? '' : 's'} before it goes out. If nobody does, it doesn't go out and comes back to Drafts.`
          : 'An admin has to approve it before it goes out.')),
      h('div', { class: 'soc-actions' }, scheduleBtn, postBtn,
        h('button', { type: 'button', class: 'link-btn', onclick: () => { clearTimeout(timer); timer = null; skipPost(p); } }, 'Skip'),
        status),
      note),
    preview.el);
}

// The AI intro clip: describe it, it's made in the background (a few minutes), then it opens the Reel.
function aiClipBox(p, flush) {
  const d = soc.data;
  const c = p.ai_clip;
  if (!d.ai.video) {
    return h('details', { class: 'soc-ai off' }, h('summary', {}, '🤖 AI intro clip (not set up)'),
      h('p', { class: 'hint' }, 'An AI-made opening shot (glossy paint, water beading, a polisher) before your real photos. It\'s paid per clip by Google, and every post that uses one is labeled as AI. To turn it on, add a GEMINI_API_KEY on the server (see the README).'));
  }
  const prompt = h('textarea', { id: 'socClipPrompt', rows: '2', maxlength: '600', placeholder: 'e.g. Slow-motion water beading on glossy black paint under studio lights' }, c?.prompt || '');
  const make = h('button', { type: 'button', onclick: async () => {
    make.disabled = true;
    make.textContent = 'Starting…';
    try {
      await flush();
      await api(`/api/social/${p.id}/ai-clip`, { method: 'POST', body: { prompt: prompt.value } });
      toast('Making the clip. It usually takes 1 to 3 minutes; you can keep working.');
      await socReload();
    } catch (err) { fail(err); make.disabled = false; make.textContent = c ? 'Make a new one' : 'Make the AI intro'; }
  } }, c?.status === 'ready' || c?.status === 'failed' ? 'Make a new one' : 'Make the AI intro');
  const remove = c && c.status !== 'making' && h('button', { type: 'button', class: 'link-btn', onclick: async () => {
    try { await api(`/api/social/${p.id}/ai-clip`, { method: 'DELETE' }); await socReload(); } catch (err) { fail(err); }
  } }, 'Take it out');
  return h('div', { class: `soc-ai ${c?.status || ''}` },
    h('div', { class: 'soc-label' }, '🤖 AI intro clip (optional)'),
    c?.status === 'making' ? h('p', { class: 'soc-ai-state' }, h('span', { class: 'soc-spin', 'aria-hidden': 'true' }), ' Being made… usually 1 to 3 minutes. This updates by itself.')
      : c?.status === 'ready' ? h('div', { class: 'soc-ai-ready' }, h('video', { src: `/api/social/${p.id}/ai-clip.mp4`, muted: true, loop: true, autoplay: true, playsinline: true }), h('span', {}, '✓ Ready. It opens the Reel, labeled "AI-generated".'))
        : c?.status === 'failed' ? h('p', { class: 'soc-urgent' }, `Didn't work: ${c.error}`) : null,
    c?.status !== 'making' && prompt,
    h('div', { class: 'soc-ai-actions' }, c?.status !== 'making' && make, remove),
    h('p', { class: 'hint' }, 'Only for an opening shot, never as a real job. Paid per clip by Google. Labeled as AI on the video, in the caption, and with TikTok\'s and YouTube\'s AI labels.'));
}

// A phone-shaped preview: the photos (as the slideshow) or the Reel (labels, the opening words, the ending),
// and the caption. `get` returns what to show, so it follows the editor as it changes.
function socPreview(get) {
  const stage = h('div', { class: 'soc-pv-stage' });
  const count = h('span', { class: 'soc-pv-count' });
  const text = h('p', { class: 'soc-pv-caption' });
  const real = h('div', { class: 'soc-pv-real', hidden: true });
  const el = h('figure', { class: 'soc-preview', 'aria-label': 'Preview' },
    h('div', { class: 'soc-pv-frame' }, stage, count),
    h('figcaption', {}, h('strong', {}, state.meta.brand?.name || 'Your page'), text),
    real);
  let i = 0;
  let timer = null;
  const slides = () => {
    const s = get();
    const items = s.items.filter((x) => !x.missing && (s.video_style === 'reel' || x.kind === 'photo'));
    const list = [];
    if (s.video_style === 'reel' && s.ai) list.push({ kind: 'ai', url: `/api/social/${s.ai}/ai-clip.mp4` });
    list.push(...items.map((x) => ({ ...x })));
    if (s.video_style === 'reel' && items.length) list.push({ kind: 'end' });
    return { s, list };
  };
  const show = () => {
    const { s, list } = slides();
    const reel = s.video_style === 'reel';
    el.classList.toggle('reel', reel);
    if (!list.length) { fill(stage, h('div', { class: 'soc-pv-empty' }, 'Pick photos to see it here')); count.textContent = ''; return; }
    i %= list.length;
    const cur = list[i];
    const label = cur.phase === 'before' ? 'BEFORE' : cur.phase === 'after' ? 'AFTER' : null;
    let slide;
    if (cur.kind === 'end') {
      slide = h('div', { class: 'soc-pv-end' },
        h('img', { src: '/brand/logo-white.png', alt: '' }),
        h('div', { class: 'soc-pv-end-text' }, s.overlay.end_text || 'Book yours today'),
        h('div', { class: 'soc-pv-phone' }, state.meta.brand?.phone || ''));
    } else {
      const media = (cls) => (cur.kind === 'clip' || cur.kind === 'ai'
        ? h('video', { class: cls, src: cur.url, muted: true, autoplay: true, loop: true, playsinline: true })
        : h('img', { class: cls, src: cur.url, alt: '' }));
      slide = h('div', { class: `soc-pv-slide ${reel ? 'zoom' : ''}` },
        reel && media('soc-pv-bg'), media('soc-pv-fg'),
        reel && label && h('span', { class: 'soc-pv-label' }, label),
        reel && cur.kind === 'ai' && h('span', { class: 'soc-pv-ai' }, 'AI-generated'),
        reel && i === 0 && s.overlay.hook && h('div', { class: 'soc-pv-hook' }, s.overlay.hook));
    }
    fill(stage, slide);
    count.textContent = `${i + 1} / ${list.length}`;
    const c = (s.caption || '').trim();
    text.textContent = c.length > 220 ? `${c.slice(0, 220)}… more` : c;
  };
  const next = () => {
    if (!el.isConnected) { if (timer !== null && started) { clearInterval(timer); timer = null; } return; }
    started = true;
    i += 1;
    show();
  };
  let started = false;
  timer = setInterval(next, SOC_SLIDE_MS);
  show();
  return {
    el,
    update: () => show(),
    showVideo(url, note) {
      real.hidden = false;
      fill(real, h('div', { class: 'soc-label' }, 'The real video'), h('video', { src: url, controls: true, playsinline: true, class: 'soc-pv-video' }),
        note && h('p', { class: 'hint' }, note));
    },
  };
}

// Uploads, one at a time (photos are shrunk first, like job photos; clips go as they are).
async function uploadMedia(e, done) {
  const files = [...e.target.files];
  e.target.value = '';
  const made = [];
  for (const [i, file] of files.entries()) {
    toast(`Uploading ${i + 1} of ${files.length}…`);
    try {
      const isVideo = file.type.startsWith('video/');
      if (isVideo && file.size > 140_000_000) throw new Error(`${file.name} is too big. Keep clips under about 2 minutes.`);
      const blob = isVideo ? file : await shrinkImage(file);
      const res = await fetch(`/api/social/media?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': blob.type || file.type }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      made.push(data);
    } catch (err) { fail(err); }
  }
  if (made.length) {
    soc.library = null;
    try { soc.library = await api('/api/social/library'); } catch { /* next time */ }
    done(made);
  }
}

// ---------- Settings ----------
function settingsCard() {
  const { settings: s, platforms, connections, ai } = soc.data;
  const form = h('form', { class: 'soc-settings', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      soc.data.settings = await api('/api/social/settings', { method: 'PUT', body: {
        auto_draft: Boolean(f.get('auto_draft')), platforms: f.getAll('platforms'), caption: f.get('caption'), hashtags: f.get('hashtags'),
        approve_days: Number(f.get('approve_days')), video_style: f.get('video_style'),
      } });
      toast('Saved');
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Scheduling'),
  h('label', { class: 'soc-label soc-inline' }, 'Posts have to be approved at least',
    h('input', { type: 'number', name: 'approve_days', min: '0', max: '14', value: s.approve_days, class: 'soc-days' }), 'days before they go out'),
  h('p', { class: 'hint' }, 'A scheduled post that isn\'t approved by then doesn\'t go out; it goes back to Drafts. 0 means any time before it goes out.'),
  h('h3', {}, 'New posts'),
  h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'auto_draft', checked: s.auto_draft }),
    ' Make a draft when a job is marked Ready for pickup (only when the customer OK\'d it and there are after photos)'),
  h('label', { class: 'soc-label' }, 'Format, to start with',
    h('select', { name: 'video_style' }, h('option', { value: 'photos', selected: s.video_style === 'photos' }, 'Photos'), h('option', { value: 'reel', selected: s.video_style === 'reel' }, 'Reel video'))),
  h('div', { class: 'soc-label' }, 'Post to, by default'),
  h('div', { class: 'soc-platforms' }, ...Object.keys(platforms).map((k) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'platforms', value: k, checked: s.platforms.includes(k) }), ` ${platforms[k]}`,
    h('small', { class: connections[k] ? 'soc-ok' : 'muted' }, connections[k] ? ' · connected' : ' · not connected yet')))),
  h('label', { class: 'soc-label' }, 'Caption for finished jobs', h('textarea', { name: 'caption', rows: '3' }, s.caption)),
  h('p', { class: 'hint' }, 'Fills in: {vehicle} {color} {services} {company} {city} {phone} {make}. Customer names are never used.'),
  h('label', { class: 'soc-label' }, 'Hashtags', h('input', { name: 'hashtags', value: s.hashtags })),
  h('button', { type: 'submit', class: 'primary' }, 'Save'));

  const music = h('section', { class: 'card-section' },
    h('h3', {}, 'Music for Reels'),
    s.music ? h('p', {}, `🎵 ${s.music.name || 'Track'} `, h('button', { type: 'button', class: 'link-btn', onclick: async () => {
      try { await api(`/api/social/media/${s.music.id}`, { method: 'DELETE' }); await socReload(); } catch (err) { fail(err); }
    } }, 'Remove')) : h('p', { class: 'muted' }, 'No music: Reels are silent (TikTok can add its own).'),
    h('label', { class: 'soc-upload' }, s.music ? 'Use a different track' : 'Upload a track (MP3 or M4A)',
      h('input', { type: 'file', accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,.mp3,.m4a', hidden: true, onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          const res = await fetch(`/api/social/media?kind=music&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'audio/mpeg' }, body: file });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Upload failed');
          toast('Music saved');
          await socReload();
        } catch (err) { fail(err); }
      } })),
    h('p', { class: 'hint' }, 'Only music the shop has the rights to (royalty-free or licensed). It plays under every Reel and fades out at the end.'));

  const aiCard = h('section', { class: 'card-section' },
    h('h3', {}, 'AI help'),
    h('p', {}, ai.writer ? '✓ Claude writes captions and the words on the video (Write it for me).' : 'Write it for me fills in a template. Add ANTHROPIC_API_KEY on the server for Claude to write them.'),
    h('p', {}, ai.video ? '✓ AI intro clips are on (Google Veo, paid per clip).' : 'AI intro clips are off. Add GEMINI_API_KEY on the server to turn them on (Google Veo, paid per clip).'),
    h('p', { class: 'hint' }, 'Facebook and Instagram post the photos or the Reel; TikTok a photo or video post; YouTube Shorts a video. Each platform is connected once on the server (see the README). TikTok keeps posts private until it approves the app.'));
  return h('div', { class: 'soc-settings-wrap' }, h('section', { class: 'card-section' }, form), music, aiCard);
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
  const waiting = posts.find((p) => ['draft', 'scheduled', 'approved'].includes(p.status));
  return h('section', { class: 'card-section soc-job' },
    h('h3', {}, 'Social media'),
    h('p', { class: ok ? 'soc-ok' : 'muted' }, record),
    ok && h('p', { class: 'hint' }, 'Photos only: no names or license plates.'),
    live.length > 0 && h('div', { class: `soc-live ${ok ? '' : 'warn'}` },
      h('div', {}, h('strong', {}, 'Posted: '), ...live.flatMap((x, i) => [i ? ' · ' : '', x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.name) : x.name]),
        live[0].at && h('span', { class: 'muted' }, ` · ${fmtDateTime(live[0].at)}`)),
      !ok && h('div', {}, 'These are still up. Take them down on each page by hand if the customer asks.')),
    waiting && isAdmin() && h('p', { class: 'hint' }, waiting.status === 'draft' ? 'A post from this job is waiting in Social.' : `A post from this job is scheduled for ${fmtDateTime(waiting.scheduled_for)}.`),
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
          const d = await api(`/api/social/jobs/${job.id}`, { method: 'POST' });
          loadSocialBadge();
          showPanel(null);
          openSocial({ tab: 'drafts', open: d.id });
        } catch (err) { fail(err); }
      } }, live.length ? 'Make another post' : 'Make a social post'),
      isAdmin() && waiting && h('button', { type: 'button', onclick: () => { showPanel(null); openSocial({ open: waiting.id }); } }, 'Open in Social')));
}

function initSocial() {
  if (!isAdmin()) return;
  $('#socialBtn').addEventListener('click', () => openSocial({ open: null }));
  loadSocialBadge();
  setInterval(loadSocialBadge, 60_000);
}
