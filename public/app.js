'use strict';

const state = {
  meta: null,
  leads: [],
  reminders: [],
  openLeadId: null,
  openLead: null,
  updates: [],
  updatesSeenId: 0,
  updatesFilter: '',
  emailSettings: null,
  pipeline: 'other',
  section: 'leads', // leads | calendar
  oldLeads: [],
  oldFilters: { vehicle: '', source: '', status: '' },
};

const $ = (sel, root = document) => root.querySelector(sel);

// Builds DOM nodes with textContent so lead data from forms can't inject HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

const fail = (err) => toast(err.message, 'error');

// ---------- formatting ----------
const stageLabel = (id) => state.meta.stages.find((s) => s.id === id)?.label ?? id;
const dispoLabel = (id) => state.meta.dispositions.find((d) => d.id === id)?.label ?? id;
const leadName = (l) => l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || `Lead #${l.lead_id ?? l.id}`;
const sourceLabel = { facebook: 'Facebook', website: 'Website', manual: 'Manual' };

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const isAdmin = () => state.meta?.currentRole === 'admin';

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// "overdue" | "today" | "later" for a reminder due time.
function dueStatus(iso) {
  const due = new Date(iso);
  if (due <= new Date()) return 'overdue';
  const tomorrow = startOfDay(new Date());
  tomorrow.setDate(tomorrow.getDate() + 1);
  return due < tomorrow ? 'today' : 'later';
}

// Value for <input type="datetime-local"> in the user's own time zone.
function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Default call-back time: tomorrow, or Monday when weekends are skipped.
function tomorrowAtReminderHour() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (state.meta.reminderSkipWeekends && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  d.setHours(state.meta.reminderHour, 0, 0, 0);
  return d;
}

// ---------- board ----------
async function loadLeads() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  const source = $('#sourceFilter').value;
  if (q) params.set('q', q);
  const oldParams = new URLSearchParams(params);
  oldParams.set('view', 'old');
  if (source) params.set('source', source);
  [state.leads, state.oldLeads] = await Promise.all([api(`/api/leads?${params}`), api(`/api/leads?${oldParams}`)]);
  renderBoard();
}

// ---------- pipelines (RVs / all other vehicles) ----------
function pickPipeline() {
  const ids = state.meta.pipelines.map((p) => p.id);
  const fromLink = location.hash.slice(1);
  let saved = null;
  try { saved = localStorage.getItem('pipeline'); } catch { /* storage unavailable */ }
  state.pipeline = [fromLink, saved].find((id) => ids.includes(id) || id === 'old') || 'other';
}

// ---------- sections: Leads / Calendar ----------
function showSection(name) {
  // Shop logins only have the calendar, sales logins only the leads.
  const section = { shop: 'calendar', sales: 'leads' }[state.meta.currentRole] || name;
  state.section = section;
  document.body.dataset.section = section;
  $('#leadsSection').hidden = section !== 'leads';
  $('#calendarSection').hidden = section !== 'calendar';
  $('#brandSection').textContent = section === 'calendar' ? 'Shop Calendar' : 'Lead Pipeline';
  document.querySelectorAll('.main-nav button').forEach((b) => {
    if (b.dataset.section === section) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  history.replaceState(null, '', `#${section === 'calendar' ? 'calendar' : state.pipeline}`);
  if (section === 'calendar') loadCalendar().catch(fail);
  else renderBoard();
}

function setPipeline(id) {
  state.pipeline = id;
  try { localStorage.setItem('pipeline', id); } catch { /* storage unavailable */ }
  history.replaceState(null, '', `#${id}`);
  renderBoard();
}

function renderTabs() {
  // Phones show the short names so all tabs and the export button fit.
  const SHORT = { rv: 'RVs', other: 'Other', old: 'Old & Dead' };
  const tab = (id, label, count, extra = '') => h('button', {
    type: 'button',
    role: 'tab',
    class: `pipeline-tab ${extra}`,
    'aria-selected': String(id === state.pipeline),
    'aria-label': label,
    onclick: () => setPipeline(id),
  }, h('span', { class: 'long-label' }, label), h('span', { class: 'short-label' }, SHORT[id] || label), h('span', { class: 'count' }, count));
  $('#pipelineTabs').replaceChildren(
    ...state.meta.pipelines.map((p) => tab(p.id, p.label, state.leads.filter((l) => l.pipeline === p.id).length)),
    tab('old', 'Old & Dead Leads', state.oldLeads.length, 'old-tab'),
    h('span', { class: 'spacer' }),
    isAdmin() && h('a', { class: 'export-link', href: exportUrl(), download: '', title: 'Download what this tab shows as an Excel file' },
      h('span', { class: 'long-label' }, 'Export to Excel'), h('span', { class: 'short-label' }, 'Excel')),
  );
}

// The Excel download matches the tab and filters on screen.
function exportUrl() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) params.set('q', q);
  if (state.pipeline === 'old') {
    params.set('view', 'old');
    const f = state.oldFilters;
    if (f.vehicle) params.set('vehicle_type', f.vehicle);
    if (f.source) params.set('source', f.source);
    if (f.status) params.set('status', f.status);
  } else {
    params.set('view', 'active');
    params.set('pipeline', state.pipeline);
    if ($('#sourceFilter').value) params.set('source', $('#sourceFilter').value);
  }
  return `/api/export.xlsx?${params}`;
}

const pipelineLabel = (id) => state.meta.pipelines.find((p) => p.id === id)?.label ?? id;

function renderBoard() {
  renderTabs();
  const showingOld = state.pipeline === 'old';
  $('#board').hidden = showingOld;
  $('#oldView').hidden = !showingOld;
  $('#sourceFilter').hidden = showingOld;
  if (showingOld) return renderOld();
  const board = $('#board');
  board.setAttribute('aria-label', pipelineLabel(state.pipeline));
  const inPipeline = state.leads.filter((l) => l.pipeline === state.pipeline);
  board.replaceChildren(...state.meta.stages.map((stage) => {
    const leads = inPipeline.filter((l) => l.stage === stage.id);
    const column = h('section', { class: 'column', dataset: { stage: stage.id } },
      h('div', { class: 'column-head' }, stage.label, h('span', { class: 'count' }, leads.length)),
      h('div', { class: 'cards' }, leads.length ? leads.map(leadCard) : h('div', { class: 'empty' }, 'No leads')),
    );
    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const lead = state.leads.find((l) => l.id === id);
      if (lead && lead.stage !== stage.id) moveStage(id, stage.id);
    });
    return column;
  }));
}

// "Car · 2023 Tesla Model Y · Pearl White"
function vehicleLine(l) {
  const vehicle = [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ');
  return [l.vehicle_type, vehicle, l.vehicle_color].filter(Boolean).join(' · ');
}

// The website promises "we'll call you back within 24 hours": count down until the first call.
function promisePill(lead) {
  if (lead.stage !== 'new' || lead.last_contacted_at) return null;
  const hoursLeft = 24 - (Date.now() - new Date(lead.received_at)) / 3600000;
  if (hoursLeft <= 0) return h('span', { class: 'pill due', title: 'Over 24 hours since this lead came in' }, '24h call-back missed');
  return h('span', { class: `pill ${hoursLeft < 4 ? 'today' : 'promise'}`, title: 'We promise to call back within 24 hours' },
    `Call back · ${hoursLeft < 1 ? 'under 1h' : `${Math.floor(hoursLeft)}h`} left`);
}

function leadCard(lead) {
  let reminderPill = null;
  if (lead.next_reminder_at) {
    const status = dueStatus(lead.next_reminder_at);
    const text = status === 'overdue' ? 'Call now' : status === 'today' ? 'Call today' : `Call ${fmtDateTime(lead.next_reminder_at)}`;
    reminderPill = h('span', { class: `pill ${status === 'overdue' ? 'due' : status === 'today' ? 'today' : ''}` }, text);
  }
  return h('article', {
    class: 'lead-card',
    draggable: 'true',
    tabindex: '0',
    ondragstart: (e) => e.dataTransfer.setData('text/plain', String(lead.id)),
    onclick: () => openLead(lead.id),
    onkeydown: (e) => { if (e.key === 'Enter') openLead(lead.id); },
  },
  h('div', { class: 'row' },
    h('span', { class: 'name' }, leadName(lead)),
    h('span', { class: `tag ${lead.source}` }, sourceLabel[lead.source] || lead.source)),
  h('div', { class: 'row' },
    h('span', { class: 'phone' }, lead.phone || lead.email || ''),
    h('span', { class: 'muted' }, timeAgo(lead.received_at))),
  vehicleLine(lead) && h('div', { class: 'vehicle' }, vehicleLine(lead)),
  lead.booked_services?.length > 0 && h('div', { class: 'services-line' }, serviceLabels(lead.booked_services)),
  (lead.last_disposition || reminderPill || promisePill(lead)) && h('div', { class: 'row' },
    h('span', { class: 'muted' }, lead.last_disposition ? dispoLabel(lead.last_disposition) : ''),
    reminderPill || promisePill(lead)));
}

async function moveStage(id, stage) {
  try {
    await api(`/api/leads/${id}`, { method: 'PATCH', body: { stage } });
    toast(`Moved to ${stageLabel(stage)}`);
    await loadLeads();
    if (state.openLeadId === id) await openLead(id);
  } catch (err) { fail(err); }
}

// The lead's job on the shop calendar, or a way to add one for booked leads.
function renderLeadJob(lead) {
  const open = (lead.jobs || []).find((j) => !['picked_up', 'cancelled'].includes(j.status)) || (lead.jobs || [])[0];
  const section = $('#leadJobSection');
  section.hidden = !open && lead.stage !== 'booked';
  if (section.hidden) return;
  $('#leadJob').replaceChildren(open
    ? h('div', { class: 'lead-job' },
      h('div', {},
        h('span', { class: `job-status status-${open.status}` }, state.meta.jobStatuses.find((s) => s.id === open.status)?.label || open.status),
        h('div', { class: 'lead-job-when' }, `Drop-off ${fmtDateTime(open.start_at)}`),
        h('div', { class: 'muted' }, `Pick-up ${fmtDateTime(open.end_at)}`)),
      isAdmin() && h('button', { type: 'button', onclick: () => showJobOnCalendar(open.id, open.start_at) }, 'Open on calendar'))
    : h('div', { class: 'lead-job' },
      h('span', { class: 'muted' }, 'Booked, but not on the shop calendar yet.'),
      h('button', { type: 'button', class: 'primary', onclick: () => openScheduleDialog(lead) }, 'Put on calendar')));
}

// ---------- old & dead leads ----------
const SOURCE_LABELS = { facebook: 'Facebook', website: 'Website', manual: 'Manual' };
const vehicleTypeOf = (l) => l.vehicle_type || 'No vehicle type';
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');

function renderOld() {
  const f = state.oldFilters;
  $('#oldIntro').textContent = `Leads leave the boards ${state.meta.archiveDays} days after they come in unless they're booked. `
    + '"Dead" leads were marked Waste. Restore a lead, log a call on it, or have them inquire again, and it goes back on its board.';

  // Vehicle type choices: every type that has old leads, plus the current pick.
  const types = [...new Set(state.oldLeads.map(vehicleTypeOf))].sort();
  const vehicleSelect = $('#oldVehicle');
  vehicleSelect.replaceChildren(h('option', { value: '' }, 'All vehicle types'),
    ...types.map((t) => h('option', { value: t === 'No vehicle type' ? 'none' : t }, t)));
  vehicleSelect.value = f.vehicle;
  if (vehicleSelect.value !== f.vehicle) f.vehicle = vehicleSelect.value = '';
  $('#oldSource').value = f.source;
  $('#oldStatus').value = f.status;

  const byStatus = state.oldLeads.filter((l) => !f.status || l.status === f.status);
  const matches = byStatus.filter((l) => (!f.source || l.source === f.source)
    && (!f.vehicle || (f.vehicle === 'none' ? !l.vehicle_type : l.vehicle_type === f.vehicle)));

  // Counts by vehicle type (rows) and lead type (columns); a number filters to that group.
  const sources = Object.keys(SOURCE_LABELS);
  const pick = (vehicle, source) => () => {
    Object.assign(state.oldFilters, { vehicle: vehicle === 'No vehicle type' ? 'none' : vehicle, source });
    renderBoard();
  };
  const countCell = (n, vehicle, source) => h('td', { class: 'num' },
    h('button', { type: 'button', class: `cell ${n ? '' : 'zero'}`, onclick: pick(vehicle, source) }, n));
  const count = (t, s) => byStatus.filter((l) => (!t || vehicleTypeOf(l) === t) && (!s || l.source === s)).length;
  $('#oldMatrix').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Vehicle type'), ...sources.map((s) => h('th', { class: 'num' }, SOURCE_LABELS[s])), h('th', { class: 'num' }, 'Total'))),
    h('tbody', {},
      ...types.map((t) => h('tr', {}, h('td', {}, t), ...sources.map((s) => countCell(count(t, s), t, s)), countCell(count(t), t, ''))),
      h('tr', { class: 'total' }, h('td', {}, 'Total'), ...sources.map((s) => countCell(count('', s), '', s)), countCell(byStatus.length, '', ''))),
  );

  const groups = new Map();
  for (const l of matches) {
    const t = vehicleTypeOf(l);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(l);
  }
  $('#oldGroups').replaceChildren(...(groups.size ? [...groups.keys()].sort().map((t) => h('section', { class: 'old-group' },
    h('h3', {}, t, h('span', { class: 'muted' }, `${groups.get(t).length} lead${groups.get(t).length === 1 ? '' : 's'}`)),
    h('div', { class: 'table-scroll' }, h('table', { class: 'old-table' },
      h('thead', {}, h('tr', {}, ...['Name', 'Lead type', 'Status', 'Phone', 'Vehicle', 'Last outcome', 'Came in', 'Moved here', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, ...groups.get(t).map((l) => h('tr', { onclick: () => openLead(l.id) },
        h('td', {}, h('strong', {}, leadName(l))),
        h('td', {}, SOURCE_LABELS[l.source] || l.source),
        h('td', {}, h('span', { class: `status-pill ${l.status}` }, l.status === 'dead' ? 'Dead' : 'Old')),
        h('td', {}, l.phone || ''),
        h('td', {}, [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ')),
        h('td', {}, l.last_disposition ? dispoLabel(l.last_disposition) : 'Never reached'),
        h('td', {}, shortDate(l.received_at)),
        h('td', {}, shortDate(l.archived_at)),
        h('td', {}, h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); restoreLead(l.id); } }, 'Restore')))))))))
    : [h('p', { class: 'muted' }, state.oldLeads.length ? 'No old leads match these filters.' : 'No old or dead leads yet. Leads show up here two weeks after they come in.')]));
}

async function restoreLead(id) {
  try {
    const lead = await api(`/api/leads/${id}/restore`, { method: 'POST' });
    toast(`${leadName(lead)} is back on ${pipelineLabel(lead.pipeline)}`);
    await loadLeads();
    if (state.openLeadId === id) renderLead(lead);
  } catch (err) { fail(err); }
}

// ---------- lead drawer ----------
function showPanel(panel) {
  for (const p of [$('#drawer'), $('#remindersPanel'), $('#emailPanel'), $('#jobPanel'), $('#updatesPanel')]) p.hidden = p !== panel;
  $('#scrim').hidden = !panel;
  if (panel !== $('#drawer')) {
    state.openLeadId = null;
    state.openLead = null;
  }
}

async function openLead(id) {
  try {
    const lead = await api(`/api/leads/${id}`);
    state.openLeadId = id;
    renderLead(lead);
    showPanel($('#drawer'));
  } catch (err) { fail(err); }
}

function renderLead(lead) {
  state.openLead = lead;
  $('#leadName').textContent = leadName(lead);
  $('#leadMeta').textContent = [
    sourceLabel[lead.source] || lead.source,
    lead.form_name,
    lead.campaign && `Campaign: ${lead.campaign}`,
    `Received ${fmtDateTime(lead.received_at)}`,
  ].filter(Boolean).join(' · ');

  $('#leadContact').replaceChildren(...[
    lead.status && lead.status !== 'active' && h('div', { class: 'notice archived-notice' },
      h('span', {}, `${lead.status === 'dead' ? 'Dead lead' : 'Old lead'} · moved off the board ${shortDate(lead.archived_at)}`),
      h('button', { type: 'button', onclick: () => restoreLead(lead.id) }, 'Restore to pipeline')),
    lead.phone && h('a', { href: `tel:${lead.phone.replace(/[^\d+]/g, '')}`, class: 'call-btn' }, `Call ${lead.phone}`),
    lead.email && h('a', { href: `mailto:${lead.email}` }, lead.email),
    lead.sms_opt_in === 1 && h('span', {}, h('span', { class: 'tag text-ok' }, 'OK to text')),
    lead.message && h('div', { class: 'message' }, lead.message),
  ].filter(Boolean));

  fillInfoForm(lead);
  renderLeadJob(lead);

  const stageSelect = $('#stageSelect');
  stageSelect.replaceChildren(...state.meta.stages.map((s) => h('option', { value: s.id, selected: s.id === lead.stage }, s.label)));

  const form = $('#dispoForm');
  form.reset();
  form.disposition.replaceChildren(
    h('option', { value: '' }, 'Choose an outcome…'),
    ...state.meta.dispositions.map((d) => h('option', { value: d.id }, d.label)),
  );
  form.reminder_at.value = toLocalInput(tomorrowAtReminderHour());
  setNoteError(false);
  setServicesError(false);
  $('#servicesField').hidden = true;
  setScheduleError(false);
  $('#scheduleField').hidden = true;
  syncDispoForm();

  $('#leadReminders').replaceChildren(...(lead.reminders.length
    ? lead.reminders.map((r) => h('li', { class: r.done_at ? 'done' : '' },
      h('span', {}, `${fmtDateTime(r.due_at)}${r.done_at ? ' (done)' : ''}`),
      !r.done_at && h('div', { class: 'small-btns' },
        h('button', { type: 'button', onclick: () => completeReminder(r.id) }, 'Done'))))
    : [h('li', { class: 'muted' }, 'No reminders yet')]));

  const emailStatus = { sent: 'Sent', failed: 'Failed', not_configured: 'Not sent' };
  $('#leadEmails').replaceChildren(...(lead.emails.length
    ? lead.emails.map((m) => h('li', { title: m.error || '' },
      h('div', { class: 'email-line' },
        h('span', {}, m.subject),
        h('span', { class: 'muted' }, `${fmtDateTime(m.created_at)} · to ${m.to_email}`),
        m.error && h('span', { class: 'muted' }, m.error)),
      h('span', { class: `status ${m.status}` }, emailStatus[m.status] || m.status)))
    : [h('li', { class: 'muted' }, lead.email ? 'No emails sent yet' : 'No email address on file')]));

  $('#timeline').replaceChildren(...lead.activities.map(activityItem));
}

// ---------- booked services ----------
const serviceLabels = (ids) => ids.map((id) => state.meta.bookingServices.find((s) => s.id === id)?.label ?? id).join(', ');

// Checkboxes for the services that fit this lead's vehicle type (all of them if the type isn't set).
// Services already picked always stay visible.
function renderServiceChecks(container, lead, selected = []) {
  const fits = (s) => !s.types || !lead.vehicle_type || s.types.includes(lead.vehicle_type) || selected.includes(s.id);
  container.replaceChildren(...state.meta.bookingServices.filter(fits).map((s) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', value: s.id, checked: selected.includes(s.id) }), ` ${s.label}`)));
}

const checkedServices = (container) => [...container.querySelectorAll('input:checked')].map((i) => i.value);

function setServicesError(show) {
  $('#servicesField').classList.toggle('invalid', show);
  $('#servicesError').hidden = !show;
}

// ---------- lead info ----------
const INFO_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color', 'vehicle_type', 'heard_about'];

// Fills a Vehicle type dropdown, keeping any non-standard value a lead already has.
function fillVehicleTypes(select, current = '') {
  const types = [...state.meta.vehicleTypes];
  if (current && !types.includes(current)) types.push(current);
  select.replaceChildren(h('option', { value: '' }, 'Not set'), ...types.map((t) => h('option', { value: t }, t)));
  select.value = current;
}

// Fills a "How they heard about us" dropdown, keeping any other answer the lead gave.
function fillHeardAbout(select, current = '') {
  const options = [...state.meta.heardAboutOptions];
  if (current && !options.includes(current)) options.push(current);
  select.replaceChildren(h('option', { value: '' }, 'Not asked yet'), ...options.map((o) => h('option', { value: o }, o)));
  select.value = current;
}

function fillInfoForm(lead) {
  const form = $('#infoForm');
  fillVehicleTypes(form.vehicle_type, lead.vehicle_type ?? '');
  fillHeardAbout(form.heard_about, lead.heard_about ?? '');
  form.sms_opt_in.checked = lead.sms_opt_in === 1;
  for (const f of INFO_FIELDS) form[f].value = lead[f] ?? '';
  // Older leads may only have a full name.
  if (!lead.first_name && !lead.last_name && lead.full_name) {
    const [first, ...rest] = lead.full_name.split(' ');
    form.first_name.value = first;
    form.last_name.value = rest.join(' ');
  }
  const showServices = lead.stage === 'booked' || lead.booked_services.length > 0;
  $('#infoServicesField').hidden = !showServices;
  renderServiceChecks($('#infoServices'), lead, lead.booked_services);
  form.dataset.saved = JSON.stringify(infoValues());
  form.vehicle_year.classList.remove('invalid');
  syncInfoForm();
}

function infoValues() {
  const form = $('#infoForm');
  const values = Object.fromEntries(INFO_FIELDS.map((f) => [f, form[f].value.trim()]));
  values.sms_opt_in = form.sms_opt_in.checked;
  if (!$('#infoServicesField').hidden) values.booked_services = checkedServices($('#infoServices'));
  return values;
}

function syncInfoForm() {
  const form = $('#infoForm');
  const changed = JSON.stringify(infoValues()) !== form.dataset.saved;
  form.querySelector('button[type=submit]').disabled = !changed;
  $('#infoStatus').textContent = changed ? 'Unsaved changes' : '';
}

async function saveInfo(e) {
  e.preventDefault();
  const form = e.target;
  const values = infoValues();
  if (values.vehicle_year && !/^\d{4}$/.test(values.vehicle_year)) {
    form.vehicle_year.classList.add('invalid');
    form.vehicle_year.focus();
    return toast('Vehicle year should be 4 digits, like 2022', 'error');
  }
  // Only send what changed, so the activity log lists real edits.
  const saved = JSON.parse(form.dataset.saved);
  const patch = Object.fromEntries(Object.entries(values).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(saved[k])));
  try {
    const before = state.openLead?.pipeline;
    const lead = await api(`/api/leads/${state.openLeadId}`, { method: 'PATCH', body: patch });
    renderLead(lead);
    toast(lead.pipeline !== before ? `Lead info saved. Moved to ${pipelineLabel(lead.pipeline)}` : 'Lead info saved');
    await loadLeads();
  } catch (err) { fail(err); }
}

// Notes are required on every disposition: highlight the field until filled in.
function setNoteError(show) {
  $('#noteField').classList.toggle('invalid', show);
  $('#noteError').hidden = !show;
  $('#dispoForm').note.setAttribute('aria-invalid', String(show));
}

function activityItem(a) {
  const what = {
    created: 'Lead created',
    reinquiry: 'Submitted again',
    stage_change: `Moved ${stageLabel(a.from_stage)} → ${stageLabel(a.to_stage)}`,
    disposition: `${dispoLabel(a.disposition)}${a.from_stage !== a.to_stage ? ` · ${stageLabel(a.from_stage)} → ${stageLabel(a.to_stage)}` : ''}`,
    note: 'Note',
    reminder_done: 'Reminder completed',
    email: 'Email',
    info_updated: 'Lead info updated',
    archived: 'Moved to Old & Dead Leads',
    restored: 'Back on the board',
    job: 'Shop job',
    checklist: 'Shop checklist',
    photo: 'Job photos',
  }[a.type] || a.type;
  return h('li', {},
    h('div', { class: 'what' }, what),
    a.note && h('div', { class: 'note' }, a.note),
    h('div', { class: 'muted' },
      a.user_name && h('span', { class: 'who' }, a.user_name),
      a.user_name && ' · ',
      fmtDateTime(a.created_at)));
}

// Defaults the reminder checkbox from the chosen disposition and explains
// where the lead will go.
function syncDispoForm(fromDispositionChange = false) {
  const form = $('#dispoForm');
  const def = state.meta.dispositions.find((d) => d.id === form.disposition.value);
  if (def && fromDispositionChange) form.reminder.checked = def.reminder;
  $('#reminderWhen').hidden = !form.reminder.checked;
  form.reminder_at.required = form.reminder.checked;
  let hint = '';
  if (def) {
    const lead = state.leads.find((l) => l.id === state.openLeadId);
    if (def.stage === 'keep_stage') hint = 'Lead stays in its current stage.';
    else {
      const target = def.stage === 'advance_attempt' ? 'the next follow-up stage' : stageLabel(def.stage);
      hint = `Moves ${lead ? 'this lead ' : ''}to ${target}.`;
    }
    hint += form.reminder.checked ? ' A call reminder will be set.' : ' No reminder will be set.';
  }
  $('#dispoHint').textContent = hint;
  syncEmailOption(def);
  const wasHidden = $('#servicesField').hidden;
  $('#servicesField').hidden = !def?.services;
  if (def?.services && wasHidden && state.openLead) {
    renderServiceChecks($('#serviceChecks'), state.openLead, state.openLead.booked_services);
  }
  if (!def?.services) setServicesError(false);
  const scheduleWasHidden = $('#scheduleField').hidden;
  $('#scheduleField').hidden = !def?.schedules;
  if (def?.schedules && scheduleWasHidden && state.openLead) {
    const { start, end } = defaultSlot(state.openLead.vehicle_type);
    form.job_start.value = toLocalInput(start);
    form.job_end.value = toLocalInput(end);
  }
  if (!def?.schedules) setScheduleError(false);
}

function setScheduleError(show) {
  $('#scheduleField').classList.toggle('invalid', show);
  $('#scheduleError').hidden = !show;
}

// Shows the "send follow-up email" choice for dispositions that send one.
function syncEmailOption(def) {
  const box = $('#emailOption');
  const form = $('#dispoForm');
  const lead = state.openLead;
  box.hidden = !def?.email;
  if (box.hidden || !lead) return;
  const settings = state.emailSettings;
  let reason = '';
  if (!lead.email) reason = 'No email address on file for this lead.';
  else if (!settings?.enabled) reason = 'The follow-up email is turned off. Set it up under Email template.';
  else if (!state.meta.emailConfigured) reason = 'Email sending is not connected yet, so this will be logged but not delivered.';
  form.send_email.disabled = !lead.email || !settings?.enabled;
  if (form.send_email.disabled) form.send_email.checked = false;
  $('#emailOptionText').textContent = lead.email ? `Send follow-up email to ${lead.email}` : 'Send follow-up email';
  $('#emailOptionHint').textContent = reason;
}

async function saveDisposition(e) {
  e.preventDefault();
  const form = e.target;
  if (!form.disposition.value) return toast('Pick a call outcome first', 'error');
  const needsServices = !$('#servicesField').hidden;
  const services = needsServices ? checkedServices($('#serviceChecks')) : [];
  const needsSchedule = !$('#scheduleField').hidden;
  const jobStart = new Date(form.job_start.value);
  const jobEnd = new Date(form.job_end.value);
  const badSchedule = needsSchedule && (Number.isNaN(jobStart.getTime()) || Number.isNaN(jobEnd.getTime()) || jobEnd <= jobStart);
  const missingNote = !form.note.value.trim();
  const missingServices = needsServices && !services.length;
  setNoteError(missingNote);
  setServicesError(missingServices);
  setScheduleError(badSchedule);
  if (missingNote || missingServices || badSchedule) {
    (missingNote ? form.note : missingServices ? $('#serviceChecks input') : form.job_start)?.focus();
    return;
  }
  const body = {
    disposition: form.disposition.value,
    note: form.note.value,
    reminder: form.reminder.checked,
  };
  if (form.reminder.checked) body.reminder_at = new Date(form.reminder_at.value).toISOString();
  if (!$('#emailOption').hidden) body.send_email = form.send_email.checked;
  if (needsServices) body.services = services;
  if (needsSchedule) Object.assign(body, { job_start: jobStart.toISOString(), job_end: jobEnd.toISOString() });
  try {
    const { lead, reminder, email, job } = await api(`/api/leads/${state.openLeadId}/disposition`, { method: 'POST', body });
    if (job) toast(`Booked. On the shop calendar for ${fmtDateTime(job.start_at)}`);
    else {
      toast(reminder
        ? `Saved. Reminder set for ${fmtDateTime(reminder.due_at)}`
        : `Saved. Lead moved to ${stageLabel(lead.stage)}`);
    }
    if (email?.status === 'sent') toast(`Follow-up email sent to ${email.to_email}`);
    else if (email) toast(`Follow-up email not sent: ${email.error}`, 'error');
    renderLead(lead);
    await Promise.all([loadLeads(), loadReminders()]);
  } catch (err) { fail(err); }
}

async function addNote(e) {
  e.preventDefault();
  const input = e.target.note;
  if (!input.value.trim()) {
    input.classList.add('invalid');
    input.focus();
    return;
  }
  try {
    const lead = await api(`/api/leads/${state.openLeadId}/notes`, { method: 'POST', body: { note: input.value } });
    input.value = '';
    renderLead(lead);
  } catch (err) { fail(err); }
}

// ---------- reminders ----------
async function loadReminders() {
  state.reminders = await api('/api/reminders');
  const due = state.reminders.filter((r) => dueStatus(r.due_at) === 'overdue');
  const badge = $('#reminderBadge');
  badge.hidden = !due.length;
  badge.textContent = due.length;

  const banner = $('#dueBanner');
  banner.hidden = !due.length;
  banner.textContent = due.length === 1
    ? `Time to call ${leadName(due[0])}. Click to see your reminders.`
    : `${due.length} leads are due for a call. Click to see your reminders.`;

  notifyDue(due);
  if (!$('#remindersPanel').hidden) renderReminders();
}

function renderReminders() {
  const groups = { overdue: [], today: [], later: [] };
  for (const r of state.reminders) groups[dueStatus(r.due_at)].push(r);
  const titles = { overdue: 'Due now', today: 'Later today', later: 'Upcoming' };
  const list = $('#remindersList');
  if (!state.reminders.length) {
    list.replaceChildren(h('p', { class: 'muted' }, 'No open reminders. Disposition a lead to schedule a call.'));
    return;
  }
  list.replaceChildren(...Object.entries(groups).filter(([, items]) => items.length).flatMap(([key, items]) => [
    h('div', { class: 'reminder-group' }, titles[key]),
    ...items.map((r) => h('div', { class: `reminder-item ${key}`, onclick: () => openLead(r.lead_id) },
      h('div', {},
        h('div', { class: 'name' }, leadName(r), r.pipeline === 'rv' && ' ', r.pipeline === 'rv' && h('span', { class: 'tag rv' }, 'RV')),
        h('div', { class: 'when' }, `${fmtDateTime(r.due_at)} · ${stageLabel(r.stage)}`),
        r.phone && h('div', { class: 'muted' }, r.phone)),
      h('div', { class: 'small-btns' },
        r.phone && h('a', { class: 'btn-link', href: `tel:${r.phone.replace(/[^\d+]/g, '')}`, onclick: (e) => e.stopPropagation() }, 'Call'),
        h('button', { type: 'button', title: 'Snooze 1 hour', onclick: (e) => { e.stopPropagation(); snooze(r.id); } }, '+1h'),
        h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); completeReminder(r.id); } }, 'Done')))),
  ]));
}

// ---------- updates feed (admins) ----------
// Changes by shop logins are shop work; everyone else's is lead work.
const SHOP_TYPES = ['job', 'checklist', 'photo'];
const byShop = (u) => (u.user_role ? u.user_role === 'shop' : ['checklist', 'photo'].includes(u.type));

async function loadUpdatesCount() {
  try {
    const { unseen } = await api('/api/updates/count');
    $('#updatesBadge').hidden = !unseen;
    $('#updatesBadge').textContent = unseen > 99 ? '99+' : unseen;
  } catch { /* try again on the next refresh */ }
}

async function loadUpdates(older = false) {
  const before = older && state.updates.length ? `&before=${state.updates.at(-1).id}` : '';
  const { updates, seenId } = await api(`/api/updates?limit=100${before}`);
  if (older) state.updates.push(...updates);
  else {
    state.updates = updates;
    state.updatesSeenId = seenId;
  }
  $('#olderUpdates').hidden = updates.length < 100;
  renderUpdates();
}

async function openUpdates() {
  try {
    await loadUpdates();
    showPanel($('#updatesPanel'));
    await api('/api/updates/seen', { method: 'POST' });
    $('#updatesBadge').hidden = true;
  } catch (err) { fail(err); }
}

function renderUpdates() {
  const filter = state.updatesFilter || '';
  const shown = state.updates.filter((u) => !filter || (filter === 'shop') === byShop(u));
  const list = $('#updatesList');
  if (!shown.length) {
    list.replaceChildren(h('p', { class: 'muted' }, 'No changes yet.'));
    return;
  }
  const items = [];
  let day = '';
  for (const u of shown) {
    const d = new Date(u.created_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (d !== day) items.push(h('li', { class: 'updates-day' }, (day = d)));
    const mine = u.user_name && u.user_name === state.meta.currentUser;
    const isNew = u.id > state.updatesSeenId && !mine;
    const shopWork = byShop(u);
    const what = activityItem(u).querySelector('.what').textContent;
    items.push(h('li', {
      class: `update-item${isNew ? ' unseen' : ''}`,
      onclick: () => (SHOP_TYPES.includes(u.type) && u.job_id ? showJobOnCalendar(u.job_id, u.job_start) : openLead(u.lead_id)),
    },
    h('span', { class: `who-badge${shopWork ? ' shop' : ''}`, title: `${u.user_name || 'Automatic'}${u.user_role ? ` (${u.user_role})` : ''}` }, (u.user_name || '•').slice(0, 1).toUpperCase()),
    h('div', { class: 'head' }, `${u.user_name || 'Automatic'} · ${what}`),
    h('div', {}, leadName(u), u.vehicle_type && h('span', { class: 'muted' }, ` · ${u.vehicle_type}`)),
    u.note && h('div', { class: 'note' }, u.note),
    h('div', { class: 'meta' }, `${new Date(u.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${timeAgo(u.created_at)}`)));
  }
  list.replaceChildren(...items);
}

async function completeReminder(id) {
  try {
    await api(`/api/reminders/${id}/complete`, { method: 'POST' });
    await Promise.all([loadReminders(), loadLeads()]);
    if (state.openLeadId && !$('#drawer').hidden) await openLead(state.openLeadId);
  } catch (err) { fail(err); }
}

async function snooze(id) {
  try {
    await api(`/api/reminders/${id}/snooze`, { method: 'POST', body: { due_at: new Date(Date.now() + 3600_000).toISOString() } });
    toast('Snoozed for 1 hour');
    await Promise.all([loadReminders(), loadLeads()]);
  } catch (err) { fail(err); }
}

// Browser notification once per reminder (remembered across reloads).
function notifiedIds() {
  try { return new Set(JSON.parse(localStorage.getItem('notifiedReminders') || '[]')); } catch { return new Set(); }
}

function notifyDue(due) {
  const seen = notifiedIds();
  const fresh = due.filter((r) => !seen.has(r.id));
  if (!fresh.length) return;
  for (const r of fresh) {
    seen.add(r.id);
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Time to call a lead', { body: `${leadName(r)}${r.phone ? ` · ${r.phone}` : ''}`, tag: `reminder-${r.id}` });
      n.onclick = () => { window.focus(); openLead(r.lead_id); };
    }
  }
  try { localStorage.setItem('notifiedReminders', JSON.stringify([...seen].slice(-500))); } catch { /* storage unavailable */ }
}

function updateNotifButton() {
  $('#enableNotifs').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

// ---------- follow-up email template ----------
const SAMPLE_LEAD = {
  first_name: 'Maria', last_name: 'Lopez', full_name: 'Maria Lopez', email: 'maria@example.com', phone: '555-201-3344',
  vehicle: '2024 Tesla Model Y',
};

function fillTemplate(text, lead) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    state.meta.emailPlaceholders.includes(key) ? (lead[key] ?? '') : match);
}

function renderEmailPreview() {
  const form = $('#emailForm');
  $('#previewSubject').textContent = fillTemplate(form.subject.value, SAMPLE_LEAD) || '(no subject)';
  $('#previewBody').textContent = fillTemplate(form.body.value, SAMPLE_LEAD) || '(no message)';
}

async function openEmailSettings() {
  try {
    state.emailSettings = await api('/api/settings/email');
  } catch (err) { return fail(err); }
  const form = $('#emailForm');
  form.enabled.checked = state.emailSettings.enabled;
  form.subject.value = state.emailSettings.subject;
  form.body.value = state.emailSettings.body;
  const status = $('#emailServiceStatus');
  status.hidden = state.meta.emailConfigured;
  status.textContent = 'Email sending is not connected yet. You can write and save your email now; '
    + 'it starts going out once EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM are set on the server.';
  $('#placeholderChips').replaceChildren(...state.meta.emailPlaceholders.map((p) => h('button', {
    type: 'button',
    class: 'chip',
    title: 'Insert into message',
    onclick: () => {
      const body = form.body;
      const at = body.selectionStart ?? body.value.length;
      body.setRangeText(`{{${p}}}`, at, body.selectionEnd ?? at, 'end');
      body.focus();
      renderEmailPreview();
    },
  }, `{{${p}}}`)));
  renderEmailPreview();
  showPanel($('#emailPanel'));
}

async function saveEmailSettings(e) {
  e.preventDefault();
  const form = e.target;
  try {
    state.emailSettings = await api('/api/settings/email', {
      method: 'PUT',
      body: { enabled: form.enabled.checked, subject: form.subject.value, body: form.body.value },
    });
    toast(state.emailSettings.enabled ? 'Saved. The follow-up email is on.' : 'Saved. The follow-up email is off.');
  } catch (err) { fail(err); }
}

// ---------- add lead / facebook sync ----------
async function addLead(e) {
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  try {
    const { lead, created } = await api('/api/leads', { method: 'POST', body });
    $('#addLeadDialog').close();
    form.reset();
    toast(created ? 'Lead added' : 'That lead already exists, so the inquiry was added to it');
    await loadLeads();
    if (lead.pipeline && lead.pipeline !== state.pipeline) setPipeline(lead.pipeline);
    openLead(lead.id);
  } catch (err) { fail(err); }
}

async function syncFacebook() {
  const btn = $('#syncFb');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const { fetched, created } = await api('/api/facebook/sync', { method: 'POST' });
    toast(`Facebook: ${created} new of ${fetched} leads checked`);
    await loadLeads();
  } catch (err) { fail(err); } finally {
    btn.disabled = false;
    btn.textContent = 'Sync Facebook';
  }
}

// ---------- company branding ----------
function applyBrand(brand) {
  if (!brand) return;
  $('#brandName').textContent = brand.name;
  document.querySelector('.brand-logo')?.setAttribute('alt', brand.name);
  $('#brandCity').textContent = brand.city;
  $('#brandCity').hidden = !brand.city;
  document.title = brand.shortName || brand.name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', brand.shortName || brand.name);
}

// ---------- wiring ----------
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function init() {
  state.meta = await api('/api/meta');
  const shop = state.meta.currentRole === 'shop';
  document.body.dataset.role = state.meta.currentRole;
  if (!shop) state.emailSettings = await api('/api/settings/email');
  $('#syncFb').hidden = !state.meta.facebookConfigured || !isAdmin();
  applyBrand(state.meta.brand);
  pickPipeline();
  initCalendar();
  document.querySelectorAll('.main-nav button').forEach((b) => b.addEventListener('click', () => showSection(b.dataset.section)));

  $('#search').addEventListener('input', debounce(() => loadLeads().catch(fail), 250));
  $('#sourceFilter').addEventListener('change', () => loadLeads().catch(fail));
  $('#syncFb').addEventListener('click', syncFacebook);
  fillVehicleTypes($('#addLeadForm').vehicle_type);
  fillHeardAbout($('#addLeadForm').heard_about);
  $('#addLeadBtn').addEventListener('click', () => {
    $('#addLeadForm').vehicle_type.value = state.pipeline === 'rv' ? 'Coach / RV' : '';
    $('#addLeadDialog').showModal();
  });
  $('#emailSettingsBtn').addEventListener('click', openEmailSettings);
  $('#emailForm').addEventListener('submit', saveEmailSettings);
  $('#emailForm').addEventListener('input', renderEmailPreview);
  $('#addLeadForm').addEventListener('submit', addLead);
  $('[data-cancel]').addEventListener('click', () => $('#addLeadDialog').close());
  $('#remindersBtn').addEventListener('click', () => { renderReminders(); showPanel($('#remindersPanel')); updateNotifButton(); });
  $('#updatesBtn').addEventListener('click', openUpdates);
  $('#olderUpdates').addEventListener('click', () => loadUpdates(true).catch(fail));
  document.querySelectorAll('.updates-filter button').forEach((b) => b.addEventListener('click', () => {
    state.updatesFilter = b.dataset.filter;
    document.querySelectorAll('.updates-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderUpdates();
  }));
  $('#dueBanner').addEventListener('click', () => $('#remindersBtn').click());
  $('#enableNotifs').addEventListener('click', () => Notification.requestPermission().then(updateNotifButton));
  $('#scrim').addEventListener('click', () => showPanel(null));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => showPanel(null)));
  // Escape closes the side panel, unless a dialog (like the photo viewer) is open on top of it.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) showPanel(null); });
  $('#dispoForm').addEventListener('submit', saveDisposition);
  $('#dispoForm').disposition.addEventListener('change', () => syncDispoForm(true));
  $('#dispoForm').reminder.addEventListener('change', () => syncDispoForm());
  $('#stageSelect').addEventListener('change', (e) => moveStage(state.openLeadId, e.target.value));
  $('#noteForm').addEventListener('submit', addNote);
  for (const [id, key] of [['#oldVehicle', 'vehicle'], ['#oldSource', 'source'], ['#oldStatus', 'status']]) {
    $(id).addEventListener('change', (e) => { state.oldFilters[key] = e.target.value; renderBoard(); });
  }
  $('#infoForm').addEventListener('input', (e) => {
    if (e.target.name === 'vehicle_year') e.target.classList.remove('invalid');
    syncInfoForm();
  });
  $('#infoForm').addEventListener('submit', saveInfo);
  $('#serviceChecks').addEventListener('change', () => { if (checkedServices($('#serviceChecks')).length) setServicesError(false); });
  $('#noteForm').note.addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('#dispoForm').note.addEventListener('input', (e) => { if (e.target.value.trim()) setNoteError(false); });
  if (state.meta.currentUser) {
    $('#currentUser').hidden = false;
    $('#currentUser').textContent = `Signed in as ${state.meta.currentUser}`;
  }

  if (shop) return showSection('calendar');
  if (isAdmin()) {
    loadUpdatesCount();
    setInterval(loadUpdatesCount, 60_000);
  }
  await Promise.all([loadLeads(), loadReminders()]);
  showSection(location.hash === '#calendar' ? 'calendar' : 'leads');
  // Refresh so new Facebook/website leads and due reminders show up on their own.
  setInterval(() => Promise.all([loadLeads(), loadReminders()]).catch(() => {}), 60_000);
}

init().catch(fail);

// Makes the app installable ("Add to Home Screen") and able to open offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
