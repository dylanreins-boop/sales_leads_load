'use strict';
// Shop calendar: jobs booked from the lead pipeline, worked by the shop.
// Uses the helpers from app.js ($, h, api, toast, fail, state, showPanel, ...).

const cal = {
  view: null, // month | week | list
  anchor: new Date(),
  jobs: [],
  unscheduled: [],
  job: null, // job open in the panel
  photoIndex: 0,
  phase: 'before', // phase for the next photo upload
  scheduleLeadId: null,
};

const DAY_MS = 86400000;
const jobStatusLabel = (id) => state.meta.jobStatuses.find((s) => s.id === id)?.label ?? id;
const PHASE_LABEL = { before: 'Before', during: 'During', after: 'After' };

// ---------- dates ----------
// startOfDay() comes from app.js.
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => addDays(startOfDay(d), -startOfDay(d).getDay()); // Sunday
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
const clock = (d) => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const shortClock = (d) => clock(d).replace(':00', '').replace(' AM', 'a').replace(' PM', 'p');
const dayName = (d, style = 'short') => d.toLocaleDateString([], { weekday: style });
const longDate = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function range() {
  if (cal.view === 'week') {
    const from = startOfWeek(cal.anchor);
    return { from, to: addDays(from, 7) };
  }
  const first = new Date(cal.anchor.getFullYear(), cal.anchor.getMonth(), 1);
  if (cal.view === 'list') return { from: first, to: new Date(first.getFullYear(), first.getMonth() + 1, 1) };
  const from = startOfWeek(first);
  return { from, to: addDays(from, 42) };
}

function title() {
  if (cal.view === 'week') {
    const { from } = range();
    const to = addDays(from, 6);
    const month = (d) => d.toLocaleDateString([], { month: 'short' });
    // "Oct 25 – 31, 2026" or "Oct 25 – Nov 1, 2026"
    const end = from.getMonth() === to.getMonth() ? to.getDate() : `${month(to)} ${to.getDate()}`;
    return `${month(from)} ${from.getDate()} – ${end}, ${to.getFullYear()}`;
  }
  return cal.anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

// Jobs on a given day, and where that day falls in each job (drop-off, middle, pick-up).
function jobsOn(day) {
  const start = startOfDay(day);
  const end = addDays(start, 1);
  return cal.jobs
    .filter((j) => new Date(j.start_at) < end && new Date(j.end_at) > start)
    .map((j) => {
      const first = startOfDay(j.start_at);
      const days = Math.round((startOfDay(j.end_at) - first) / DAY_MS) + 1;
      const n = Math.round((start - first) / DAY_MS) + 1;
      return { job: j, n, days, isFirst: n === 1, isLast: n === days };
    });
}

const vehicleText = (j) => [j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || j.vehicle_type || '';
const customer = (j) => j.full_name || [j.first_name, j.last_name].filter(Boolean).join(' ') || j.phone || 'Customer';

// ---------- loading ----------
async function loadCalendar() {
  const { from, to } = range();
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const [jobs, unscheduled] = await Promise.all([
    api(`/api/jobs?${params}`),
    isAdmin() ? api('/api/jobs/unscheduled') : Promise.resolve([]),
  ]);
  cal.jobs = jobs;
  cal.unscheduled = unscheduled;
  renderCalendar();
}

function setView(view) {
  cal.view = view;
  try { localStorage.setItem('calView', view); } catch { /* storage unavailable */ }
  loadCalendar().catch(fail);
}

function move(step) {
  const a = new Date(cal.anchor);
  if (cal.view === 'week') a.setDate(a.getDate() + step * 7);
  else a.setMonth(a.getMonth() + step, 1);
  cal.anchor = a;
  loadCalendar().catch(fail);
}

// ---------- rendering ----------
function chip(entry) {
  const { job, n, days, isFirst, isLast } = entry;
  let when = isFirst ? shortClock(job.start_at) : isLast ? `out ${shortClock(job.end_at)}` : `day ${n}`;
  if (isFirst && isLast) when = `${shortClock(job.start_at)}–${shortClock(job.end_at)}`;
  return h('button', {
    type: 'button',
    class: `job-chip status-${job.status} ${isFirst ? '' : 'cont'}`,
    title: `${customer(job)} · ${vehicleText(job)} · ${jobStatusLabel(job.status)}${days > 1 ? ` · day ${n} of ${days}` : ''}`,
    onclick: (e) => { e.stopPropagation(); openJob(job.id); },
  },
  h('span', { class: 'chip-time' }, when),
  h('span', { class: 'chip-name' }, customer(job)),
  job.pipeline === 'rv' && h('span', { class: 'chip-rv' }, 'RV'));
}

function renderMonth(body) {
  const { from } = range();
  const month = cal.anchor.getMonth();
  const today = new Date();
  const head = Array.from({ length: 7 }, (_, i) => h('div', { class: 'cal-dow' }, dayName(addDays(from, i))));
  const cells = Array.from({ length: 42 }, (_, i) => {
    const day = addDays(from, i);
    const entries = jobsOn(day);
    const shown = entries.slice(0, 4);
    return h('div', {
      class: `cal-cell ${day.getMonth() !== month ? 'other-month' : ''} ${isWeekend(day) ? 'weekend' : ''} ${sameDay(day, today) ? 'today' : ''}`,
      role: 'gridcell',
      'aria-label': `${longDate(day)}, ${entries.length} job${entries.length === 1 ? '' : 's'}`,
    },
    h('button', { type: 'button', class: 'cal-date', title: 'Show this week', onclick: () => { cal.anchor = day; setView('week'); } }, day.getDate()),
    h('div', { class: 'cal-chips' }, ...shown.map(chip),
      entries.length > shown.length && h('button', {
        type: 'button', class: 'cal-more', onclick: () => { cal.anchor = day; setView('week'); },
      }, `+${entries.length - shown.length} more`)));
  });
  body.replaceChildren(h('div', { class: 'cal-month', role: 'grid' }, ...head, ...cells));
}

function progress(job) {
  const total = job.checklist_total ?? job.checklist?.length ?? 0;
  const done = job.checklist_done ?? job.checklist?.filter((c) => c.done_at).length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return h('div', { class: 'progress', title: `Checklist ${done} of ${total}` },
    h('div', { class: 'progress-bar' }, h('span', { style: `width:${pct}%` })),
    h('span', { class: 'progress-text' }, `${done}/${total}`));
}

function jobCard(entry, { showDay = false } = {}) {
  const { job, n, days, isFirst, isLast } = entry;
  // Days in the middle of a multi-day job get a short card; drop-off and pick-up days show everything.
  if (!isFirst && !isLast) {
    return h('button', { type: 'button', class: `job-card compact status-${job.status}`, onclick: () => openJob(job.id) },
      h('div', { class: 'job-card-top' }, h('span', { class: 'job-card-name' }, customer(job)), job.pipeline === 'rv' && h('span', { class: 'chip-rv' }, 'RV')),
      h('div', { class: 'job-card-when' }, `${jobStatusLabel(job.status)} · day ${n} of ${days}`));
  }
  let when;
  if (isFirst && isLast) when = `${clock(job.start_at)} – ${clock(job.end_at)}`;
  else if (isFirst) when = `Drop-off ${clock(job.start_at)}`;
  else if (isLast) when = `Pick-up ${clock(job.end_at)}`;
  else when = `In the shop · day ${n} of ${days}`;
  const services = serviceLabels(job.services || []);
  return h('button', { type: 'button', class: `job-card status-${job.status}`, onclick: () => openJob(job.id) },
    h('div', { class: 'job-card-top' },
      h('span', { class: `job-status status-${job.status}` }, jobStatusLabel(job.status)),
      job.pipeline === 'rv' && h('span', { class: 'chip-rv' }, 'RV')),
    h('div', { class: 'job-card-name' }, customer(job)),
    h('div', { class: 'job-card-vehicle' }, [job.vehicle_type, vehicleText(job) !== job.vehicle_type && vehicleText(job), job.vehicle_color].filter(Boolean).join(' · ')),
    h('div', { class: 'job-card-when' }, showDay ? `${longDate(isLast && !isFirst ? job.end_at : job.start_at)} · ${when}` : when),
    services && h('div', { class: 'job-card-services' }, services),
    h('div', { class: 'job-card-foot' }, progress(job),
      h('span', { class: 'photo-count' }, `${job.photo_count || 0} photo${job.photo_count === 1 ? '' : 's'}`)));
}

function renderWeek(body) {
  const { from } = range();
  const today = new Date();
  body.replaceChildren(h('div', { class: 'cal-week' }, ...Array.from({ length: 7 }, (_, i) => {
    const day = addDays(from, i);
    const entries = jobsOn(day);
    return h('section', { class: `week-col ${isWeekend(day) ? 'weekend' : ''} ${sameDay(day, today) ? 'today' : ''}` },
      h('header', { class: 'week-head' }, h('span', { class: 'week-dow' }, dayName(day)), h('span', { class: 'week-date' }, day.getDate())),
      h('div', { class: 'week-jobs' }, entries.length ? entries.map((e) => jobCard(e))
        : h('div', { class: 'week-empty' }, isWeekend(day) ? 'Closed' : 'No jobs')));
  })));
}

function renderList(body) {
  const { from, to } = range();
  const today = startOfDay(new Date());
  const days = [];
  for (let d = new Date(from); d < to; d = addDays(d, 1)) {
    const entries = jobsOn(d);
    if (entries.length || sameDay(d, today)) days.push({ day: new Date(d), entries });
  }
  if (!days.length) {
    body.replaceChildren(h('p', { class: 'cal-empty' }, 'No jobs this month. Jobs show up here when a lead is booked.'));
    return;
  }
  body.replaceChildren(h('div', { class: 'cal-list' }, ...days.map(({ day, entries }) => h('section', { class: `list-day ${sameDay(day, today) ? 'today' : ''}`, id: sameDay(day, today) ? 'calToday' : null },
    h('h3', { class: 'list-day-head' }, longDate(day), sameDay(day, today) && h('span', { class: 'today-tag' }, 'Today')),
    entries.length ? h('div', { class: 'list-jobs' }, ...entries.map((e) => jobCard(e))) : h('p', { class: 'muted' }, 'No jobs today.')))));
  if (cal.anchor.getMonth() === today.getMonth()) $('#calToday')?.scrollIntoView({ block: 'start' });
}

function renderCalendar() {
  $('#calTitle').textContent = title();
  document.querySelectorAll('#calViews button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === cal.view)));
  $('#calLegend').replaceChildren(...state.meta.jobStatuses.map((s) => h('span', { class: `legend-item status-${s.id}` }, h('i', {}), s.label)));

  const waiting = $('#calUnscheduled');
  waiting.hidden = !cal.unscheduled.length;
  if (cal.unscheduled.length) {
    waiting.replaceChildren(
      h('span', { class: 'waiting-text' }, `${cal.unscheduled.length} booked lead${cal.unscheduled.length === 1 ? ' needs' : 's need'} a drop-off time:`),
      ...cal.unscheduled.map((l) => h('button', { type: 'button', class: 'waiting-chip', onclick: () => openScheduleDialog(l) },
        `${leadName(l)}${l.vehicle_type ? ` · ${l.vehicle_type}` : ''}`)));
  }

  const body = $('#calBody');
  body.dataset.view = cal.view;
  if (cal.view === 'month') renderMonth(body);
  else if (cal.view === 'week') renderWeek(body);
  else renderList(body);
}

// ---------- job panel ----------
async function openJob(id) {
  try {
    cal.job = await api(`/api/jobs/${id}`);
    renderJob();
    showPanel($('#jobPanel'));
  } catch (err) { fail(err); }
}

// Keeps the calendar's copy of a job in step after an edit in the panel.
function syncJobOnCalendar(job) {
  const i = cal.jobs.findIndex((j) => j.id === job.id);
  const summary = {
    ...job,
    checklist_total: job.checklist.length,
    checklist_done: job.checklist.filter((c) => c.done_at).length,
    photo_count: job.photos.length,
  };
  if (i >= 0) cal.jobs[i] = { ...cal.jobs[i], ...summary };
  renderCalendar();
}

async function patchJob(patch, message) {
  try {
    cal.job = await api(`/api/jobs/${cal.job.id}`, { method: 'PATCH', body: patch });
    renderJob();
    syncJobOnCalendar(cal.job);
    if (message) toast(message);
  } catch (err) { fail(err); }
}

// Sales logins can look at jobs but not change them.
const canEditJobs = () => state.meta?.currentRole !== 'sales';
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function renderJob() {
  const job = cal.job;
  const edit = canEditJobs();
  const status = state.meta.jobStatuses.find((s) => s.id === job.status);
  $('#jobTitle').textContent = customer(job);
  $('#jobMeta').replaceChildren(
    [job.vehicle_type, vehicleText(job) !== job.vehicle_type && vehicleText(job), job.vehicle_color].filter(Boolean).join(' · '),
    ...(job.pipeline === 'rv' ? [' ', h('span', { class: 'chip-rv' }, 'RV')] : []));

  const done = job.checklist.filter((c) => c.done_at).length;
  const sections = [...new Set(job.checklist.map((c) => c.section))];
  const byPhase = Object.fromEntries(state.meta.photoPhases.map((p) => [p, job.photos.filter((ph) => ph.phase === p)]));

  $('#jobBody').replaceChildren(...[
    !edit && h('p', { class: 'notice view-only' }, 'View only. The shop or an admin can change this job.'),

    // Status
    h('section', { class: 'card-section' },
      h('h3', {}, 'Status'),
      !edit && h('span', { class: `job-status status-${job.status}` }, status?.label || job.status),
      edit && h('div', { class: 'status-picker', role: 'radiogroup', 'aria-label': 'Job status' },
        ...state.meta.jobStatuses.map((s) => h('button', {
          type: 'button',
          role: 'radio',
          class: `status-option status-${s.id}`,
          'aria-checked': String(job.status === s.id),
          onclick: () => job.status !== s.id && patchJob({ status: s.id }, `Marked ${s.label.toLowerCase()}`),
        }, s.label)))),

    // Schedule
    h('section', { class: 'card-section' },
      h('h3', {}, 'Drop-off and pick-up'),
      !edit && h('dl', { class: 'job-times' },
        h('dt', {}, 'Drop-off'), h('dd', {}, fmtWhen(job.start_at)),
        h('dt', {}, 'Pick-up'), h('dd', {}, fmtWhen(job.end_at))),
      edit && h('form', { class: 'schedule-form', onsubmit: (e) => {
        e.preventDefault();
        const f = e.target;
        patchJob({ start_at: new Date(f.start.value).toISOString(), end_at: new Date(f.end.value).toISOString() }, 'Job times saved');
      } },
      h('label', {}, 'Drop-off', h('input', { type: 'datetime-local', name: 'start', required: true, value: toLocalInput(new Date(job.start_at)) })),
      h('label', {}, 'Pick-up', h('input', { type: 'datetime-local', name: 'end', required: true, value: toLocalInput(new Date(job.end_at)) })),
      h('button', { type: 'submit' }, 'Save times'))),

    // Customer
    h('section', { class: 'card-section job-customer' },
      h('h3', {}, 'Customer'),
      job.phone && h('a', { class: 'call-btn', href: `tel:${job.phone.replace(/[^\d+]/g, '')}` }, `Call ${job.phone}`),
      job.email && h('a', { href: `mailto:${job.email}` }, job.email),
      job.sms_opt_in === 1 && h('span', {}, h('span', { class: 'tag text-ok' }, 'OK to text')),
      job.message && h('div', { class: 'message' }, job.message),
      job.services.length > 0 && h('div', { class: 'service-chips' }, ...job.services.map((id) => h('span', { class: 'service-chip' }, serviceLabels([id])))),
      state.meta.currentRole !== 'shop' && h('button', { type: 'button', onclick: () => { showSection('leads'); openLead(job.lead_id); } }, 'Open lead')),

    // Notes
    h('section', { class: 'card-section' },
      h('h3', {}, 'Job notes'),
      !edit && h('p', { class: job.notes ? 'job-notes-text' : 'muted' }, job.notes || 'No job notes.'),
      edit && h('form', { class: 'notes-form', onsubmit: (e) => { e.preventDefault(); patchJob({ notes: e.target.notes.value }, 'Notes saved'); } },
        h('textarea', { name: 'notes', rows: '3', placeholder: 'Keys, gate codes, anything the shop should know' }, job.notes || ''),
        h('button', { type: 'submit' }, 'Save notes'))),

    // Checklist
    h('section', { class: 'card-section' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Vehicle checklist'), h('span', { class: 'muted' }, `${done} of ${job.checklist.length} done`)),
      h('div', { class: 'progress big' }, h('div', { class: 'progress-bar' }, h('span', { style: `width:${job.checklist.length ? Math.round((done / job.checklist.length) * 100) : 0}%` }))),
      ...sections.map((section) => h('div', { class: 'check-group' },
        h('div', { class: 'check-group-title' }, section),
        h('ul', { class: 'checklist' }, ...job.checklist.filter((c) => c.section === section).map(checkItem)))),
      edit && h('form', { class: 'add-check', onsubmit: addCheckItem },
        h('select', { name: 'section', 'aria-label': 'Section' }, ...['Check-in', 'Work', 'Finish'].map((s) => h('option', { value: s, selected: s === 'Check-in' }, s))),
        h('input', { name: 'label', placeholder: 'Add something to check', 'aria-label': 'New checklist item', maxlength: '200' }),
        h('button', { type: 'submit' }, 'Add'))),

    // Photos
    h('section', { class: 'card-section' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Photos'), h('span', { class: 'muted' }, `${job.photos.length} total`)),
      edit && h('div', { class: 'photo-upload' },
        h('div', { class: 'phase-picker', role: 'radiogroup', 'aria-label': 'Photo stage' },
          ...state.meta.photoPhases.map((p) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(cal.phase === p),
            onclick: () => { cal.phase = p; renderJob(); },
          }, PHASE_LABEL[p]))),
        h('label', { class: 'upload-btn' }, `Add ${PHASE_LABEL[cal.phase].toLowerCase()} photos`,
          h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: uploadPhotos }))),
      h('p', { id: 'uploadStatus', class: 'muted', hidden: true }),
      ...state.meta.photoPhases.filter((p) => byPhase[p].length).map((p) => h('div', { class: 'photo-group' },
        h('div', { class: 'check-group-title' }, `${PHASE_LABEL[p]} · ${byPhase[p].length}`),
        h('div', { class: 'photo-grid' }, ...byPhase[p].map((ph) => h('button', {
          type: 'button', class: 'photo-thumb', title: ph.caption || `${PHASE_LABEL[p]} photo`,
          onclick: () => openPhoto(job.photos.indexOf(ph)),
        }, h('img', { src: photoUrl(ph), alt: ph.caption || `${PHASE_LABEL[p]} photo`, loading: 'lazy' })))))),
      !job.photos.length && h('p', { class: 'muted' }, edit ? 'No photos yet. Take before photos at check-in.' : 'No photos yet.')),
  ].filter(Boolean));
}

function checkItem(item) {
  const meta = item.done_at ? `${item.done_by ? `${item.done_by} · ` : ''}${new Date(item.done_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  return h('li', { class: item.done_at ? 'done' : '' },
    h('label', { class: 'check-item' },
      h('input', { type: 'checkbox', checked: Boolean(item.done_at), disabled: !canEditJobs(), onchange: (e) => toggleItem(item, e.target.checked) }),
      h('span', { class: 'check-text' }, item.label, meta && h('span', { class: 'check-meta' }, meta))),
    canEditJobs() && h('button', { type: 'button', class: 'icon-btn remove', title: 'Remove from this job', 'aria-label': `Remove ${item.label}`, onclick: () => removeItem(item) }, '×'));
}

async function toggleItem(item, done) {
  try {
    const updated = await api(`/api/jobs/${cal.job.id}/checklist/${item.id}`, { method: 'PATCH', body: { done } });
    cal.job.checklist = cal.job.checklist.map((c) => (c.id === item.id ? updated : c));
    renderJob();
    syncJobOnCalendar(cal.job);
  } catch (err) { fail(err); renderJob(); }
}

async function removeItem(item) {
  try {
    await api(`/api/jobs/${cal.job.id}/checklist/${item.id}`, { method: 'DELETE' });
    cal.job.checklist = cal.job.checklist.filter((c) => c.id !== item.id);
    renderJob();
    syncJobOnCalendar(cal.job);
  } catch (err) { fail(err); }
}

async function addCheckItem(e) {
  e.preventDefault();
  const f = e.target;
  if (!f.label.value.trim()) { f.label.classList.add('invalid'); f.label.focus(); return; }
  try {
    cal.job.checklist = await api(`/api/jobs/${cal.job.id}/checklist`, { method: 'POST', body: { label: f.label.value, section: f.section.value } });
    renderJob();
    syncJobOnCalendar(cal.job);
  } catch (err) { fail(err); }
}

// ---------- photos ----------
const photoUrl = (ph) => `/api/jobs/${cal.job.id}/photos/${ph.id}`;

// Phones take big photos; shrink to at most 1600px as JPEG before uploading.
async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('resize failed'))), 'image/jpeg', 0.85));
  } catch {
    // The browser couldn't read it (e.g. some HEIC files); send it as-is if it's a web image.
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
    throw new Error(`${file.name} isn't a photo format the app can use. Take the photo with the camera option, or save it as JPEG.`);
  }
}

async function uploadPhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const status = $('#uploadStatus');
  status.hidden = false;
  let added = 0;
  for (const [i, file] of files.entries()) {
    status.textContent = `Uploading ${i + 1} of ${files.length}…`;
    try {
      const blob = await shrinkImage(file);
      const res = await fetch(`/api/jobs/${cal.job.id}/photos?phase=${cal.phase}`, {
        method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      cal.job.photos.push(data);
      added++;
    } catch (err) { fail(err); }
  }
  status.hidden = true;
  renderJob();
  syncJobOnCalendar(cal.job);
  if (added) toast(`${added} photo${added === 1 ? '' : 's'} added`);
}

function openPhoto(index) {
  cal.photoIndex = index;
  renderPhoto();
  const dialog = $('#photoDialog');
  if (!dialog.open) dialog.showModal();
}

function renderPhoto() {
  const ph = cal.job.photos[cal.photoIndex];
  if (!ph) { $('#photoDialog').close(); return; }
  $('#photoImg').src = photoUrl(ph);
  $('#photoDelete').hidden = !canEditJobs();
  $('#photoImg').alt = ph.caption || `${PHASE_LABEL[ph.phase]} photo`;
  $('#photoMeta').textContent = [PHASE_LABEL[ph.phase], ph.uploaded_by, new Date(ph.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ');
  $('#photoCount').textContent = `${cal.photoIndex + 1} of ${cal.job.photos.length}`;
  const del = $('#photoDelete');
  del.textContent = 'Delete photo';
  del.dataset.armed = '';
}

async function deletePhoto() {
  const del = $('#photoDelete');
  // Two taps, so a stray tap doesn't lose a photo.
  if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
  const ph = cal.job.photos[cal.photoIndex];
  try {
    await api(photoUrl(ph), { method: 'DELETE' });
    cal.job.photos.splice(cal.photoIndex, 1);
    cal.photoIndex = Math.min(cal.photoIndex, cal.job.photos.length - 1);
    renderJob();
    syncJobOnCalendar(cal.job);
    toast('Photo deleted');
    renderPhoto();
  } catch (err) { fail(err); }
}

function stepPhoto(step) {
  const count = cal.job.photos.length;
  cal.photoIndex = (cal.photoIndex + step + count) % count;
  renderPhoto();
}

// ---------- scheduling a booked lead ----------
function nextBusinessDay(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!(state.meta.reminderSkipWeekends && isWeekend(d))) left--;
  }
  return d;
}

// Default slot: drop-off next business day at 8 AM, pick-up a day later (two for RVs) at 2 PM.
function defaultSlot(vehicleType) {
  const start = nextBusinessDay(new Date(), 1);
  start.setHours(8, 0, 0, 0);
  const end = nextBusinessDay(start, ['Coach / RV', 'Trailer / Toy Hauler'].includes(vehicleType) ? 2 : 1);
  end.setHours(14, 0, 0, 0);
  return { start, end };
}

function openScheduleDialog(lead) {
  cal.scheduleLeadId = lead.id;
  const f = $('#scheduleForm');
  const { start, end } = defaultSlot(lead.vehicle_type);
  f.job_start.value = toLocalInput(start);
  f.job_end.value = toLocalInput(end);
  $('#scheduleFor').textContent = `${leadName(lead)}${lead.vehicle_type ? ` · ${lead.vehicle_type}` : ''}`;
  $('#scheduleDialog').showModal();
}

async function saveSchedule(e) {
  e.preventDefault();
  const f = e.target;
  const body = { job_start: new Date(f.job_start.value).toISOString(), job_end: new Date(f.job_end.value).toISOString() };
  if (body.job_end <= body.job_start) return toast('Pick-up has to be after drop-off', 'error');
  try {
    const job = await api(`/api/leads/${cal.scheduleLeadId}/job`, { method: 'POST', body });
    $('#scheduleDialog').close();
    toast(`On the calendar for ${longDate(job.start_at)}, ${clock(job.start_at)}`);
    if (state.section === 'calendar') {
      cal.anchor = new Date(job.start_at);
      await loadCalendar();
    } else if (state.openLeadId) {
      await openLead(state.openLeadId);
    }
  } catch (err) { fail(err); }
}

// Opens the calendar on a job's week and shows the job.
function showJobOnCalendar(jobId, startAt) {
  cal.anchor = new Date(startAt);
  showSection('calendar');
  openJob(jobId);
}

function initCalendar() {
  let saved = null;
  try { saved = localStorage.getItem('calView'); } catch { /* storage unavailable */ }
  cal.view = ['month', 'week', 'list'].includes(saved) ? saved : (window.innerWidth < 700 ? 'list' : 'month');
  $('#calPrev').addEventListener('click', () => move(-1));
  $('#calNext').addEventListener('click', () => move(1));
  $('#calTodayBtn').addEventListener('click', () => { cal.anchor = new Date(); loadCalendar().catch(fail); });
  document.querySelectorAll('#calViews button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#photoPrev').addEventListener('click', () => stepPhoto(-1));
  $('#photoNext').addEventListener('click', () => stepPhoto(1));
  $('#photoClose').addEventListener('click', () => $('#photoDialog').close());
  $('#photoDelete').addEventListener('click', deletePhoto);
  $('#photoDialog').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepPhoto(-1);
    if (e.key === 'ArrowRight') stepPhoto(1);
  });
  $('#scheduleForm').addEventListener('submit', saveSchedule);
  $('#scheduleCancel').addEventListener('click', () => $('#scheduleDialog').close());
  // Keep the calendar fresh while it's on screen.
  setInterval(() => { if (state.section === 'calendar' && document.visibilityState === 'visible') loadCalendar().catch(() => {}); }, 60_000);
}
