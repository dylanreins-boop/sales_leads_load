'use strict';
// The time clock for everyone (the Clock in button in the top bar and the "My time" panel: clock in and
// out, hours this week, ask for time off) and the admins' Time & Pay page (approve time off, hourly
// rates, regular / overtime / paid time off hours and gross pay for a pay period, fix punches, CSV).
// Uses the helpers from app.js ($, h, fill, api, toast, fail, money, toLocalInput, showPanel...).

const tc = { weekOffset: 0, cardPeriod: 'week', editDay: null, addDay: null, allOcc: false, schedules: null, status: null, tick: null, done: false, card: null, fixing: null, pay: null, open: new Set(), editing: null, adding: false, settings: false };
const TC_KINDS = () => state.meta.timeOffKinds || { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid' };

// ---------- formatting ----------
const tcClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const tcDay = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const tcKeyDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const tcDays = (r) => (r.start_date === r.end_date ? tcDay(tcKeyDate(r.start_date))
  : `${tcDay(tcKeyDate(r.start_date))} – ${tcDay(tcKeyDate(r.end_date))}`);
const tcHrs = (x) => (x == null ? '–' : `${(Math.round(x * 100) / 100).toLocaleString('en-US')} h`);
// 3 h 05 m: for a clock that's running.
function tcElapsed(fromIso) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(fromIso)) / 60000));
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
const STATUS_LABEL = { pending: 'Waiting for approval', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' };

// ---------- the Clock in button ----------
// Time worked today so far (lunch doesn't count), and since a time, as "3 h 05 m".
const tcWorkedMs = (s) => (s.today || []).reduce((n, p) => n + Math.max(0, new Date(p.clock_out || Date.now()) - new Date(p.clock_in)), 0);
const tcHM = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`; };
const tcSince = (iso) => Date.now() - new Date(iso);
const tcNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const tcState = (s) => (s.on_clock ? 'on' : s.on_lunch ? 'lunch' : 'off');

function renderClockPill() {
  const s = tc.status;
  const btn = $('#clockBtn');
  btn.hidden = !s;
  if (!s) return;
  const st = tcState(s);
  btn.classList.toggle('on', st === 'on');
  btn.classList.toggle('lunch', st === 'lunch');
  $('#clockLabel').textContent = { on: `On the clock · ${tcHM(tcWorkedMs(s))}`, lunch: `On lunch · ${tcHM(tcSince(s.lunch_started_at))}`, off: 'Clock in' }[st];
  btn.title = { on: `Clocked in at ${tcClock(s.clock_in)}. Open My time for lunch or to clock out.`, lunch: `On lunch since ${tcClock(s.lunch_started_at)}. Open My time to end lunch.`, off: 'Open My time to clock in or ask for time off.' }[st];
}

async function loadClock() {
  if (!state.meta.currentUser) return;
  tc.status = await api('/api/clock');
  renderClockPill();
  // Don't wipe a correction someone is typing.
  if (!$('#timePanel').hidden && !tc.fixing) renderMyTime();
}

// ---------- clocking in and out: confirm, then a confirmation that goes on to the calendar ----------
const TC_ACTIONS = {
  in: {
    label: 'Clock in', ask: 'Clock in now?', yes: 'Yes, clock me in', tone: 'go', path: '/api/clock/in', done: 'You\'re clocked in',
    askNote: (s) => (s.location_required ? 'Your shift starts when you tap Yes. Your phone checks that you\'re at the shop.' : 'Your shift starts when you tap Yes.'),
    doneNote: (s) => `Clocked in at ${tcClock(s.clock_in)}. Have a good shift!`,
  },
  lunch: {
    label: 'Start lunch', ask: 'Start your lunch break?', yes: 'Yes, start lunch', tone: 'lunch', path: '/api/clock/lunch', done: 'Enjoy your lunch',
    askNote: () => 'You\'re off the clock (unpaid) until you tap End lunch.',
    doneNote: (s) => `Lunch started at ${tcClock(s.lunch_started_at)}. Tap End lunch when you're back.`,
  },
  back: {
    label: 'End lunch', ask: 'End your lunch break?', yes: 'Yes, I\'m back', tone: 'go', path: '/api/clock/in', done: 'Welcome back',
    askNote: (s) => `You've been on lunch for ${tcHM(tcSince(s.lunch_started_at))}.`,
    doneNote: (s, before) => `Back on the clock at ${tcClock(s.clock_in)} after a ${tcHM(new Date(s.clock_in) - new Date(before.lunch_started_at))} lunch.`,
  },
  out: {
    label: 'Clock out', ask: 'Clock out now?', yes: 'Yes, clock me out', tone: 'stop', path: '/api/clock/out', done: 'You\'re clocked out',
    askNote: (s) => (s.on_lunch
      ? `Your day ends when your lunch started, at ${tcClock(s.lunch_started_at)}. You worked ${tcHM(tcWorkedMs(s))} today.`
      : `You've worked ${tcHM(tcWorkedMs(s))} today.`),
    doneNote: (s) => `You worked ${tcHM(tcWorkedMs(s))} today and ${tcHM(s.week_hours * 3600000)} this week. See you next time!`,
  },
};
// Which buttons show, by state: [action, style, label].
const TC_BUTTONS = {
  off: [['in', 'go']],
  on: [['lunch', 'lunch'], ['out', 'stop']],
  lunch: [['back', 'go'], ['out', 'ghost', 'Clock out for the day']],
};

function confirmAction(key) {
  if (key === 'out' && tc.status?.review_required) return openWeekReview();
  const a = TC_ACTIONS[key];
  tc.done = false;
  fill($('#clockDialogBody'),
    h('h2', {}, a.ask),
    h('div', { class: 'tc-dlg-time', 'data-now': '' }, tcNow()),
    h('p', { class: 'tc-dlg-note' }, a.askNote(tc.status)),
    h('div', { class: 'tc-dlg-actions' },
      h('button', { type: 'button', class: `tc-action ${a.tone}`, onclick: (e) => doAction(key, e.currentTarget) }, a.yes),
      h('button', { type: 'button', class: 'tc-action ghost', onclick: () => $('#clockDialog').close() }, 'Cancel')));
  $('#clockDialog').showModal();
  $('#clockDialogBody .tc-action').focus();
}

// ---------- geo-lock: shop logins clock in at the shop ----------
// The phone's location, or a plain-English reason it couldn't be had.
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can\'t share your location, so you can\'t clock in from it. Try your phone\'s browser.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1
        ? 'Location is turned off for this app. Turn it on (your phone\'s Settings, then your browser, then Location) and try again.'
        : 'Couldn\'t find where you are. Step near a door or window and try again.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

// Couldn't clock in (not at the shop, location off): say why, and let them try again.
function locationProblem(key, message) {
  tc.done = false;
  fill($('#clockDialogBody'),
    h('div', { class: 'tc-dlg-check stop', 'aria-hidden': 'true' }, '!'),
    h('h2', {}, 'Can\'t clock in here'),
    h('p', { class: 'tc-dlg-note' }, message),
    h('div', { class: 'tc-dlg-actions' },
      h('button', { type: 'button', class: 'tc-action go', onclick: (e) => doAction(key, e.currentTarget) }, 'Try again'),
      h('button', { type: 'button', class: 'tc-action ghost', onclick: () => $('#clockDialog').close() }, 'Close')));
  $('#clockDialogBody .tc-action').focus();
}

async function doAction(key, btn) {
  const a = TC_ACTIONS[key];
  const before = tc.status;
  btn.disabled = true;
  const geo = ['in', 'back'].includes(key) && tc.status?.location_required;
  let body;
  if (geo) {
    btn.textContent = 'Checking you\'re at the shop…';
    try { body = { location: await getLocation() }; } catch (err) { return locationProblem(key, err.message); }
  }
  try {
    tc.status = await api(a.path, { method: 'POST', body });
  } catch (err) {
    if (/approve your week/.test(err.message)) {
      await loadClock().catch(() => {});
      return openWeekReview();
    }
    if (geo) return locationProblem(key, err.message);
    $('#clockDialog').close();
    fail(err);
    return loadClock().catch(() => {});
  }
  renderClockPill();
  renderMyTime();
  loadTimecard().catch(() => {});
  if (state.section === 'time') loadTimePay().catch(() => {});
  tc.done = true;
  fill($('#clockDialogBody'),
    h('div', { class: `tc-dlg-check ${a.tone}`, 'aria-hidden': 'true' }, '✓'),
    h('h2', {}, a.done),
    h('p', { class: 'tc-dlg-note' }, a.doneNote(tc.status, before)),
    tc.status.off_site && h('p', { class: 'tc-dlg-warn' }, `⚠ ${tc.status.off_site_message}`),
    h('div', { class: 'tc-dlg-actions' },
      h('button', { type: 'button', class: 'tc-action go', onclick: () => $('#clockDialog').close() }, 'Done')),
    h('p', { class: 'muted tc-dlg-hint' }, 'Takes you to the calendar.'));
  $('#clockDialogBody .tc-action').focus();
}

// Clocking out on review day (Friday): look over the week, confirm it's right, then clock out.
async function openWeekReview() {
  const s = tc.status;
  const start = s.week_start;
  const end = ShopTime.dayKey(new Date(tcKeyDate(start).getTime() + 6 * 86400000 + 3600000));
  let card;
  try { card = await api(`/api/timecard?from=${start}&to=${end}`); } catch (err) { return fail(err); }
  tc.done = false;
  const days = new Map();
  for (const p of card.punches) {
    const k = ShopTime.dayKey(p.clock_in);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(p);
  }
  const pending = card.corrections.filter((c) => c.status === 'pending');
  const totalMs = card.punches.reduce((n, p) => n + Math.max(0, new Date(p.clock_out || Date.now()) - new Date(p.clock_in)), 0);
  const sure = h('input', { type: 'checkbox' });
  const go = h('button', { type: 'button', class: 'tc-action stop', disabled: true, onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      tc.status = await api('/api/clock/out', { method: 'POST', body: { approve_week: true } });
    } catch (err) { $('#clockDialog').close(); return fail(err); }
    renderClockPill();
    renderMyTime();
    loadTimecard().catch(() => {});
    tc.done = true;
    fill($('#clockDialogBody'),
      h('div', { class: 'tc-dlg-check stop', 'aria-hidden': 'true' }, '✓'),
      h('h2', {}, 'Week approved, you\'re clocked out'),
      h('p', { class: 'tc-dlg-note' }, `You worked ${tcHM(tc.status.week_hours * 3600000)} this week. Your hours go to the office for payroll.${new Date().getDay() >= 5 ? ' Have a good weekend!' : ''}`),
      h('div', { class: 'tc-dlg-actions' }, h('button', { type: 'button', class: 'tc-action go', onclick: () => $('#clockDialog').close() }, 'Done')),
      h('p', { class: 'muted tc-dlg-hint' }, 'Takes you to the calendar.'));
    $('#clockDialogBody .tc-action').focus();
  } }, 'Approve my week & clock out');
  sure.addEventListener('change', () => { go.disabled = !sure.checked; });
  fill($('#clockDialogBody'),
    h('h2', {}, 'Review your week'),
    h('p', { class: 'muted' }, `${tcDay(tcKeyDate(start))} – ${tcDay(tcKeyDate(end))}. Check your hours, then approve them to clock out.`),
    h('div', { class: 'tc-review' },
      ...[...days].map(([k, list]) => h('div', { class: 'tc-review-day' },
        h('span', { class: 'tc-review-date' }, tcDay(tcKeyDate(k))),
        h('span', { class: 'tc-review-spans' }, list.map((p) => `${tcClock(p.clock_in)} – ${p.clock_out ? tcClock(p.clock_out) : 'now'}`).join(', ')),
        h('span', { class: 'tc-review-hrs' }, tcHM(list.reduce((n, p) => n + Math.max(0, new Date(p.clock_out || Date.now()) - new Date(p.clock_in)), 0))))),
      !days.size && h('p', { class: 'muted' }, 'No time clocked this week.'),
      h('div', { class: 'tc-review-total' }, h('span', {}, 'This week'), h('strong', {}, tcHM(totalMs)))),
    pending.length ? h('p', { class: 'tc-review-note' }, `You have ${pending.length} correction${pending.length === 1 ? '' : 's'} waiting for an admin. Approving now is fine; the admin fixes it before payroll.`) : null,
    h('label', { class: 'check tc-review-check' }, sure, ' My hours are right'),
    h('div', { class: 'tc-dlg-actions' },
      go,
      h('button', { type: 'button', class: 'tc-action ghost', onclick: () => {
        $('#clockDialog').close();
        tc.cardPeriod = 'week';
        loadTimecard().then(() => $('#tcCard')?.scrollIntoView({ block: 'start', behavior: 'smooth' })).catch(fail);
        toast('Tap Fix next to the time that\'s wrong, then clock out again to approve.');
      } }, 'Something\'s wrong'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => $('#clockDialog').close() }, 'Cancel')));
  if (!$('#clockDialog').open) $('#clockDialog').showModal();
}

// Leaving the confirmation (Done, Escape or tapping outside) goes to the shop calendar.
function afterConfirmation() {
  if (!tc.done) return;
  tc.done = false;
  showPanel(null);
  showSection('calendar');
}

// ---------- My time (everyone): full screen ----------
function tcEvents(s) {
  const out = [];
  (s.today || []).forEach((p, i, all) => {
    const fromLunch = i > 0 && all[i - 1].out_reason === 'lunch';
    if (!fromLunch) out.push({ t: p.clock_in, kind: 'in', label: 'Clocked in' });
    if (!p.clock_out) return;
    if (p.out_reason === 'lunch') {
      const next = all[i + 1];
      out.push({ t: p.clock_out, kind: 'lunch', label: next ? `Lunch until ${tcClock(next.clock_in)} (${tcHM(new Date(next.clock_in) - new Date(p.clock_out))})` : 'On lunch' });
    } else out.push({ t: p.clock_out, kind: 'out', label: p.auto_closed ? 'Clocked out (forgot, closed at end of day)' : 'Clocked out' });
  });
  return out;
}

function renderMyTime() {
  const s = tc.status;
  if (!s) return;
  $('#timeWho').textContent = state.meta.currentUser;
  const st = tcState(s);
  const kinds = TC_KINDS();
  const todayKey = ShopTime.dayKey(new Date());
  const stateText = {
    on: `On the clock since ${tcClock(s.clock_in)}`,
    lunch: `On lunch since ${tcClock(s.lunch_started_at)}`,
    off: s.today?.length ? 'Clocked out for the day' : 'Off the clock',
  }[st];
  const events = tcEvents(s);
  const max = Math.max(8, ...s.week_days.map((d) => d.hours));
  const reqs = s.time_off || [];

  fill($('#timeBody'), h('div', { class: 'tc-page' },
    h('section', { class: `tc-hero ${st}` },
      h('div', { class: 'tc-now', 'data-now': '' }, tcNow()),
      h('div', { class: 'tc-date' }, new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })),
      h('div', { class: 'tc-state' }, h('span', { class: 'clock-dot', 'aria-hidden': 'true' }), stateText),
      h('div', { class: 'tc-big', 'data-big': '' }, st === 'lunch' ? tcHM(tcSince(s.lunch_started_at)) : tcHM(tcWorkedMs(s))),
      h('div', { class: 'tc-big-label' }, st === 'lunch' ? 'on lunch' : 'worked today'),
      s.location_required && st !== 'on' && h('div', { class: 'tc-geo-note' }, '📍 You clock in at the shop. Your phone checks your location when you tap the button.'),
      h('div', { class: 'tc-actions' }, ...TC_BUTTONS[st].map(([key, tone, label]) => h('button', {
        type: 'button', class: `tc-action ${tone}`, onclick: () => confirmAction(key),
      }, label || TC_ACTIONS[key].label)))),

    h('div', { class: 'tc-grid' },
      h('section', { class: 'tc-card' },
        h('h3', {}, 'Today'),
        events.length ? h('ol', { class: 'tc-timeline' }, ...events.map((e) => h('li', { class: `tc-ev ${e.kind}` },
          h('span', { class: 'tc-ev-time' }, tcClock(e.t)), h('span', { class: 'tc-ev-label' }, e.label))))
          : h('p', { class: 'muted' }, 'Nothing yet today. Tap Clock in to start your shift.')),
      h('section', { class: 'tc-card' },
        h('div', { class: 'tc-card-head' }, h('h3', {}, 'This week'), h('strong', {}, tcHM(s.week_hours * 3600000))),
        h('div', { class: 'tc-week' }, ...s.week_days.map((d) => h('div', { class: `tc-wd ${d.date === todayKey ? 'today' : ''}`, title: `${tcDay(tcKeyDate(d.date))}: ${tcHrs(d.hours)}` },
          h('div', { class: 'tc-wd-h' }, d.hours ? String(Math.round(d.hours * 10) / 10) : ''),
          h('div', { class: 'tc-wd-bar' }, h('span', { style: `height:${Math.round((d.hours / max) * 100)}%` })),
          h('div', { class: 'tc-wd-d' }, tcKeyDate(d.date).toLocaleDateString([], { weekday: 'short' }))))))),

    h('section', { class: 'tc-card tc-timecard', id: 'tcCard' }),

    h('div', { class: 'tc-grid' },
      h('section', { class: 'tc-card' },
        h('h3', {}, 'Ask for time off'),
        h('p', { class: 'hint' }, 'An admin approves it, then it shows on the shop calendar.'),
        h('form', { class: 'tc-off-form', onsubmit: askOff },
          h('div', { class: 'tc-off-grid' },
            h('label', {}, 'First day off', h('input', { type: 'date', name: 'start_date', required: true, min: todayKey, value: todayKey })),
            h('label', {}, 'Last day off', h('input', { type: 'date', name: 'end_date', min: todayKey })),
            h('label', {}, 'Kind', h('select', { name: 'kind' }, ...Object.entries(kinds).map(([k, v]) => h('option', { value: k }, v)))),
            h('label', {}, 'Hours a day', h('input', { type: 'number', name: 'hours_per_day', min: '1', max: '24', step: '0.5', value: state.meta.shopHours?.hours_per_day || 8 }))),
          h('label', {}, 'Note for the admin (optional)', h('input', { name: 'note', maxlength: '300', placeholder: 'e.g. Family trip' })),
          h('button', { type: 'submit', class: 'primary' }, 'Ask for time off'))),
      h('section', { class: 'tc-card' },
        h('h3', {}, 'My time off'),
        reqs.length ? h('ul', { class: 'tc-reqs' }, ...reqs.map((r) => h('li', { class: `tc-req status-${r.status}` },
          h('div', { class: 'tc-req-top' },
            h('strong', {}, tcDays(r)),
            h('span', { class: `tc-badge ${r.status}` }, STATUS_LABEL[r.status] || r.status)),
          h('div', { class: 'muted' }, `${r.kind_label} · ${tcHrs(r.hours)}${r.note ? ` · ${r.note}` : ''}`),
          r.decision_note && h('div', { class: 'tc-decision' }, `${r.decided_by || 'Admin'}: ${r.decision_note}`),
          r.status === 'pending' && h('button', { type: 'button', class: 'link-btn', onclick: () => cancelOff(r.id) }, 'Cancel request'))))
          : h('p', { class: 'muted' }, 'No time off asked for yet.')))));
  renderTimecard();
}

// The clock on the page and in the confirmation ticks every second while they're open.
function tickMyTime() {
  const s = tc.status;
  if (!s || ($('#timePanel').hidden && !$('#clockDialog').open)) return;
  document.querySelectorAll('[data-now]').forEach((el) => { el.textContent = tcNow(); });
  const big = document.querySelector('[data-big]');
  if (big) big.textContent = tcState(s) === 'lunch' ? tcHM(tcSince(s.lunch_started_at)) : tcHM(tcWorkedMs(s));
}

async function askOff(e) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  if (!body.end_date) body.end_date = body.start_date;
  try {
    await api('/api/time-off', { method: 'POST', body });
    toast('Sent. An admin will approve it.');
    await loadClock();
    if (isAdmin()) loadTimeOffBadge();
  } catch (err) { fail(err); }
}

async function cancelOff(id) {
  try {
    await api(`/api/time-off/${id}`, { method: 'DELETE' });
    await loadClock();
  } catch (err) { fail(err); }
}

function openMyTime() {
  showPanel($('#timePanel'));
  tc.fixing = null;
  renderMyTime();
  $('#timePanel').scrollTop = 0;
  loadClock().catch(fail);
  loadTimecard().catch(fail);
}

// ---------- Timecard (everyone): their punches, and corrections they ask an admin for ----------
// Sunday-to-Saturday periods, as [first day, last day].
function tcPeriod(v) {
  const key = ShopTime.dayKey;
  const sunday = startOfDay(new Date()); sunday.setDate(sunday.getDate() - sunday.getDay());
  const plus = (n) => { const d = new Date(sunday); d.setDate(d.getDate() + n); return d; };
  return { week: [plus(0), plus(6)], lastweek: [plus(-7), plus(-1)], two: [plus(-7), plus(6)], lasttwo: [plus(-14), plus(-1)] }[v].map(key);
}
const TC_PERIODS = { week: 'This week', lastweek: 'Last week', two: 'This 2 weeks', lasttwo: 'Last 2 weeks' };
const CORR_LABEL = { pending: 'Waiting for approval', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' };

// "Tue, Nov 10: 8:40 AM – 5:00 PM → 8:00 AM – 5:00 PM"
function corrText(c) {
  const span = (a, b) => `${tcClock(a)} – ${b ? tcClock(b) : 'still on'}`;
  if (c.action === 'add') return `Add ${tcDay(c.clock_in)}, ${span(c.clock_in, c.clock_out)}`;
  if (c.action === 'remove') return `Remove ${tcDay(c.old_clock_in)}, ${span(c.old_clock_in, c.old_clock_out)}`;
  const moved = ShopTime.dayKey(c.old_clock_in) !== ShopTime.dayKey(c.clock_in);
  return `${tcDay(c.old_clock_in)}: ${span(c.old_clock_in, c.old_clock_out)} → ${moved ? `${tcDay(c.clock_in)}, ` : ''}${span(c.clock_in, c.clock_out || c.old_clock_out)}`;
}

async function loadTimecard() {
  const [from, to] = tcPeriod(tc.cardPeriod);
  tc.card = await api(`/api/timecard?from=${from}&to=${to}`);
  renderTimecard();
}

function fixForm(p) {
  const adding = !p;
  const start = p ? new Date(p.clock_in) : (() => { const d = new Date(); d.setHours(8, 0, 0, 0); return d; })();
  const end = p ? (p.clock_out ? new Date(p.clock_out) : null) : (() => { const d = new Date(start); d.setHours(16, 0, 0, 0); return d; })();
  const inp = h('input', { type: 'datetime-local', name: 'clock_in', required: true, value: toLocalInput(start) });
  const out = h('input', { type: 'datetime-local', name: 'clock_out', required: adding, value: end ? toLocalInput(end) : '' });
  const remove = !adding && h('input', { type: 'checkbox', name: 'remove', onchange: (e) => { inp.disabled = e.target.checked; out.disabled = e.target.checked; } });
  return h('form', { class: 'tc-fix', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = remove?.checked
      ? { action: 'remove', punch_id: p.id, reason: f.get('reason') }
      : { action: adding ? 'add' : 'change', punch_id: p?.id, clock_in: new Date(inp.value).toISOString(), clock_out: out.value ? new Date(out.value).toISOString() : undefined, reason: f.get('reason') };
    try {
      await api('/api/timecard/corrections', { method: 'POST', body });
      tc.fixing = null;
      toast('Sent. An admin will approve it.');
      await loadTimecard();
      if (isAdmin()) loadTimeOffBadge();
    } catch (err) { fail(err); }
  } },
  h('div', { class: 'tc-fix-title' }, adding ? 'Add time you forgot to clock' : 'Ask to fix this time'),
  h('div', { class: 'tc-off-grid' },
    h('label', {}, 'Clock in', inp),
    h('label', {}, 'Clock out', out)),
  remove && h('label', { class: 'check' }, remove, ' This time shouldn\'t be on my timecard'),
  h('label', {}, 'What happened? (the admin sees this)', h('input', { name: 'reason', required: true, maxlength: '300', placeholder: adding ? 'e.g. Worked Saturday morning, forgot to clock in' : 'e.g. Got here at 8, my phone was dead' })),
  h('div', { class: 'tp-form-actions' },
    h('button', { type: 'submit', class: 'primary' }, 'Send to admin'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.fixing = null; renderTimecard(); } }, 'Cancel')));
}

function renderTimecard() {
  const box = $('#tcCard');
  if (!box) return;
  const d = tc.card;
  const days = new Map();
  for (const p of d?.punches || []) {
    const k = ShopTime.dayKey(p.clock_in);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(p);
  }
  const punchRow = (p) => [
    h('div', { class: `tc-tc-row ${p.correction_pending ? 'pending' : ''}` },
      h('span', { class: 'tc-tc-span' }, `${tcClock(p.clock_in)} – ${p.clock_out ? tcClock(p.clock_out) : 'now'}`),
      h('span', { class: 'tc-tc-hrs' }, tcHM(p.hours * 3600000)),
      h('span', { class: 'tc-tc-tags' },
        p.out_reason === 'lunch' && h('span', { class: 'tc-badge' }, 'Then lunch'),
        p.auto_closed && h('span', { class: 'tc-badge pending' }, 'Forgot to clock out'),
        p.edited_by && h('span', { class: 'tc-badge' }, `Fixed by ${p.edited_by}`),
        p.correction_pending && h('span', { class: 'tc-badge pending' }, 'Fix asked for')),
      !p.correction_pending && p.clock_out && h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.fixing = p.id; renderTimecard(); } }, 'Fix')),
    tc.fixing === p.id && fixForm(p),
  ];
  const reqs = d?.corrections || [];
  fill(box,
    h('div', { class: 'tc-card-head' },
      h('h3', {}, 'Timecard'),
      h('select', { 'aria-label': 'Timecard period', onchange: (e) => { tc.cardPeriod = e.target.value; tc.fixing = null; loadTimecard().catch(fail); } },
        ...Object.entries(TC_PERIODS).map(([k, v]) => h('option', { value: k, selected: k === tc.cardPeriod }, v))),
      d && h('strong', { class: 'tc-tc-total' }, `${tcHM(d.total_hours * 3600000)} total`)),
    tc.status && h('div', { class: `tc-week-ok ${tc.status.week_signed_off_at ? 'ok' : ''}` },
      tc.status.week_signed_off_at
        ? `✓ You approved this week's time ${fmtDateTime(tc.status.week_signed_off_at)}.`
        : `You approve this week's time when you clock out on ${tc.status.review_day}.`,
      !tc.status.week_signed_off_at && h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        try { tc.status = await api('/api/timecard/approve-week', { method: 'POST' }); toast('Thanks! This week\'s time is approved.'); renderTimecard(); } catch (err) { fail(err); }
      } }, 'Approve it now')),
    !d ? h('p', { class: 'muted' }, 'Loading…')
      : days.size ? h('div', { class: 'tc-tc-days' }, ...[...days].map(([k, list]) => h('div', { class: 'tc-tc-day' },
        h('div', { class: 'tc-tc-date' }, tcDay(tcKeyDate(k)), h('span', { class: 'muted' }, tcHM(list.reduce((n, p) => n + p.hours, 0) * 3600000))),
        h('div', { class: 'tc-tc-punches' }, ...list.flatMap(punchRow)))))
        : h('p', { class: 'muted' }, 'No time clocked in these days.'),
    tc.fixing === 'add' ? fixForm(null)
      : h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.fixing = 'add'; renderTimecard(); } }, '+ Add time you forgot to clock'),
    reqs.length ? h('div', { class: 'tc-corrs' },
      h('div', { class: 'tc-fix-title' }, 'My correction requests'),
      h('ul', { class: 'tc-reqs' }, ...reqs.map((c) => h('li', { class: `tc-req status-${c.status}` },
        h('div', { class: 'tc-req-top' }, h('strong', {}, corrText(c)), h('span', { class: `tc-badge ${c.status}` }, CORR_LABEL[c.status] || c.status)),
        h('div', { class: 'muted' }, `“${c.reason}”`),
        c.decision_note && h('div', { class: 'tc-decision' }, `${c.decided_by || 'Admin'}: ${c.decision_note}`),
        c.status === 'pending' && h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          try { await api(`/api/timecard/corrections/${c.id}`, { method: 'DELETE' }); await loadTimecard(); } catch (err) { fail(err); }
        } }, 'Cancel request'))))) : null);
}

// ---------- Time & Pay (admins) ----------
// The pay period, Sunday to Saturday weeks: [first day, last day] as "2026-11-01".
function tpRange() {
  const v = $('#tpPeriod').value;
  const key = ShopTime.dayKey;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sunday = new Date(today); sunday.setDate(today.getDate() - today.getDay());
  const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (v === 'custom') return $('#tpFrom').value && $('#tpTo').value ? [$('#tpFrom').value, $('#tpTo').value] : null;
  // Paid weekly: Sunday to Saturday, moved with the arrows.
  if (v === 'week') { const w = plus(sunday, 7 * tc.weekOffset); return [key(w), key(plus(w, 6))]; }
  if (v === 'month') return [key(new Date(today.getFullYear(), today.getMonth(), 1)), key(new Date(today.getFullYear(), today.getMonth() + 1, 0))];
  return [key(new Date(today.getFullYear(), today.getMonth() - 1, 1)), key(new Date(today.getFullYear(), today.getMonth(), 0))];
}

async function loadTimePay() {
  const r = tpRange();
  if (!r) return;
  tc.range = r;
  $('#tpWeekNav').hidden = $('#tpPeriod').value !== 'week';
  if ($('#tpPeriod').value === 'week') {
    const a = tcKeyDate(r[0]);
    const b = tcKeyDate(r[1]);
    const md = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    $('#tpWeekLabel').textContent = `${tc.weekOffset === 0 ? 'This week' : tc.weekOffset === -1 ? 'Last week' : 'Week of'} · ${md(a)} – ${a.getMonth() === b.getMonth() ? b.getDate() : md(b)}`;
  }
  tc.pay = await api(`/api/payroll?from=${r[0]}&to=${r[1]}`);
  $('#tpRange').textContent = `${tcDay(tcKeyDate(r[0]))} to ${tcDay(tcKeyDate(r[1]))}. Overtime after ${tc.pay.settings.ot_weekly_hours} hours a week${tc.pay.settings.ot_daily_hours ? ` or ${tc.pay.settings.ot_daily_hours} a day` : ''} (Sunday to Saturday), at ${tc.pay.settings.ot_multiplier}× the rate.`;
  renderTimePay();
  setTimeOffBadge(tc.pay.pending_time_off.length + tc.pay.pending_corrections.length);
}

function tpTile(label, value, sub) {
  return h('div', { class: 'an-tile' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), sub && h('div', { class: 'sub' }, sub));
}

// ---------- attendance against work schedules (admins) ----------
const tcMin = (m) => (m < 60 ? `${m} min` : tcHM(m * 60000));
const t12 = (t) => { const [hh, mm] = t.split(':').map(Number); return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const ISSUE_INFO = {
  off_site: { label: 'Away from the shop', chip: (i) => (i.how_far ? `Clocked in ${i.how_far} away` : 'Clocked in, location off'), detail: (o) => `Clocked in at ${tcClock(o.first_in)} ${o.how_far ? `about ${o.how_far} from the shop` : 'with location turned off'}` },
  late: { label: 'Late arrivals', chip: (i) => `Late ${tcMin(i.minutes)}`, detail: (o) => `In at ${tcClock(o.first_in)}, scheduled ${t12(o.schedule.start)}` },
  early: { label: 'Left early', chip: (i) => `Left ${tcMin(i.minutes)} early`, detail: (o) => `Out at ${tcClock(o.last_out)}, scheduled ${t12(o.schedule.end)}` },
  long_lunch: { label: 'Long lunches', chip: (i) => `Long lunch +${tcMin(i.minutes)}`, detail: (o) => `${tcMin(o.lunch_minutes)} lunch` },
  no_show: { label: 'No-shows', chip: () => 'No-show', detail: (o) => `Scheduled ${t12(o.schedule.start)} – ${t12(o.schedule.end)}, never clocked in` },
  missed_out: { label: 'Forgot to clock out', chip: () => 'Forgot to clock out', detail: () => 'Closed at the end of the day. Check the time.' },
};
const issueChip = (i) => h('span', { class: `tp-issue ${i.type}` }, ISSUE_INFO[i.type].chip(i));

function openPerson(name) {
  tc.open.add(name.toLowerCase());
  renderTimePay();
  document.querySelector(`[data-person-row="${CSS.escape(name.toLowerCase())}"]`)?.scrollIntoView({ block: 'center' });
}

function attendanceCard(d) {
  const any = d.rows.some((r) => r.has_schedule);
  const occ = d.occurrences;
  const shown = tc.allOcc ? occ : occ.slice(0, 6);
  return h('section', { class: 'tp-att' },
    h('div', { class: 'tp-att-head' },
      h('div', {},
        h('h3', {}, 'Attendance'),
        h('p', { class: 'muted' }, any
          ? `Against each person's work schedule. Late or early counts after ${d.settings.grace_minutes} min; lunch is ${d.settings.lunch_minutes} min.`
          : 'Set work schedules to track late arrivals, early leaves, long lunches and no-shows.')),
      h('button', { type: 'button', onclick: toggleSchedules }, tc.schedules ? 'Close schedules' : 'Work schedules')),
    h('div', { class: 'tp-att-tiles' }, ...Object.entries(ISSUE_INFO).map(([type, info]) => h('div', { class: `tp-att-tile ${d.issues[type] ? `has ${type}` : ''}` },
      h('div', { class: 'tp-att-n' }, d.issues[type]),
      h('div', { class: 'tp-att-l' }, info.label)))),
    occ.length ? h('ul', { class: 'tp-occ' }, ...shown.map((o) => h('li', {},
      h('span', { class: 'tp-occ-date' }, tcDay(tcKeyDate(o.date))),
      h('button', { type: 'button', class: 'tp-occ-name', onclick: () => openPerson(o.user_name) }, o.user_name),
      issueChip(o),
      h('span', { class: 'muted tp-occ-detail' }, ISSUE_INFO[o.type].detail(o)))))
      : any && h('p', { class: 'tp-ok-line' }, '✓ Everyone was on schedule this period.'),
    occ.length > 6 && h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.allOcc = !tc.allOcc; renderTimePay(); } }, tc.allOcc ? 'Show fewer' : `Show all ${occ.length}`),
    d.clock_alerts?.length ? h('div', { class: 'tp-away' },
      h('h4', {}, `⚠ Clock-ins away from the shop (${d.clock_alerts.length})`),
      h('ul', { class: 'tp-occ' }, ...d.clock_alerts.map((a) => h('li', {},
        h('span', { class: 'tp-occ-date' }, `${tcDay(a.created_at)} ${tcClock(a.created_at)}`),
        h('button', { type: 'button', class: 'tp-occ-name', onclick: () => openPerson(a.user_name) }, a.user_name),
        h('span', { class: 'tp-issue off_site' }, a.kind.startsWith('blocked') ? 'Refused' : 'Let through'),
        h('span', { class: 'muted tp-occ-detail' }, `${a.kind.endsWith('no_location') ? 'Location turned off' : `About ${a.how_far} from the shop`}${a.attempts > 1 ? ` · ${a.attempts} tries` : ''}${a.seen_by ? ` · seen by ${a.seen_by}` : ''}`))))) : null);
}

// ---------- the red bar: clock-ins away from the shop (admins, on every page) ----------
const alarm = { list: [], shop: null, more: false, seen: new Set(), title: null };
async function loadClockAlarm() {
  if (!isAdmin()) return;
  let r;
  try { r = await api('/api/clock/alerts'); } catch { return; }
  alarm.list = r.alerts;
  alarm.shop = r.shop;
  const keys = alarm.list.map((a) => `${a.id}:${a.attempts}`);
  const fresh = keys.some((k) => !alarm.seen.has(k));
  keys.forEach((k) => alarm.seen.add(k));
  renderClockAlarm(fresh);
}
const alarmMap = (a) => {
  if (a.lat == null) return null;
  return alarm.shop
    ? `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${alarm.shop.lat},${alarm.shop.lng}`
    : `https://www.google.com/maps?q=${a.lat},${a.lng}`;
};
function renderClockAlarm(fresh) {
  const bar = $('#clockAlarm');
  alarm.title ??= document.title;
  const n = alarm.list.length;
  document.title = n ? `⚠ (${n}) ${alarm.title}` : alarm.title;
  if (!n) { bar.hidden = true; return; }
  const row = (a) => h('div', { class: 'ca-row' },
    h('span', { class: 'ca-text' },
      h('strong', {}, a.user_name), a.kind.startsWith('blocked') ? ' tried to clock in ' : ' clocked in ',
      h('strong', {}, a.kind.endsWith('no_location') ? 'with location turned off' : `${a.how_far} from the shop`),
      ` · ${fmtDateTime(a.last_at)}${a.attempts > 1 ? ` · ${a.attempts} tries` : ''}${a.kind.startsWith('blocked') ? ' · refused' : ' · let through'}`),
    h('span', { class: 'ca-actions' },
      alarmMap(a) && h('a', { class: 'ca-btn', href: alarmMap(a), target: '_blank', rel: 'noopener' }, 'Where?'),
      h('button', { type: 'button', class: 'ca-btn solid', onclick: () => alarmSeen([a.id]) }, 'Got it')));
  fill(bar,
    h('div', { class: 'ca-head' },
      h('span', { class: 'ca-icon', 'aria-hidden': 'true' }, '⚠'),
      h('span', { class: 'ca-title' }, n === 1 ? 'Clock-in away from the shop' : `${n} clock-ins away from the shop`),
      h('span', { class: 'ca-actions' },
        n > 1 && h('button', { type: 'button', class: 'ca-btn solid', onclick: () => alarmSeen('all') }, 'Got them all'),
        h('button', { type: 'button', class: 'ca-btn', onclick: () => { showPanel(null); showSection('time'); } }, 'Time & Pay'))),
    ...alarm.list.slice(0, alarm.more ? 50 : 3).map(row),
    n > 3 && h('button', { type: 'button', class: 'ca-more', onclick: () => { alarm.more = !alarm.more; renderClockAlarm(); } }, alarm.more ? 'Show fewer' : `Show ${n - 3} more`));
  bar.hidden = false;
  if (fresh) { bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash'); }
}
async function alarmSeen(ids) {
  try {
    const r = await api('/api/clock/alerts/seen', { method: 'POST', body: { ids } });
    alarm.list = r.alerts;
    renderClockAlarm();
    if (state.section === 'time') loadTimePay().catch(() => {});
  } catch (err) { fail(err); }
}

// Work schedules: the days each person works and their hours (one shift time per person).
async function toggleSchedules() {
  if (tc.schedules) { tc.schedules = null; return renderTimePay(); }
  try {
    tc.schedules = (await api('/api/schedules')).map((s) => {
      const first = s.days.find(Boolean);
      return { user_name: s.user_name, role: s.role, on: s.days.map(Boolean), start: first?.start || '08:00', end: first?.end || '16:30' };
    });
    renderTimePay();
  } catch (err) { fail(err); }
}

function schedulesCard(d) {
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const grace = h('input', { type: 'number', min: '0', max: '60', value: d.settings.grace_minutes, 'aria-label': 'Grace minutes' });
  const lunch = h('input', { type: 'number', min: '0', max: '180', value: d.settings.lunch_minutes, 'aria-label': 'Lunch minutes' });
  return h('section', { class: 'rev-block tp-settings tp-sched' },
    h('h3', {}, 'Work schedules'),
    h('p', { class: 'hint' }, 'Pick the days each person works and their hours. Attendance compares their clock-ins to this. Approved time off is never a no-show.'),
    h('div', { class: 'tp-table-wrap' }, h('table', { class: 'tp-sched-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Works'), h('th', {}, 'Starts'), h('th', {}, 'Ends'))),
      h('tbody', {}, ...tc.schedules.map((s) => h('tr', {},
        h('th', { scope: 'row' }, s.user_name, h('span', { class: 'muted tp-role' }, ` ${s.role}`)),
        h('td', {}, h('div', { class: 'tp-dow' }, ...DOW.map((label, i) => h('button', {
          type: 'button', class: `tp-dow-btn ${s.on[i] ? 'on' : ''}`, 'aria-pressed': String(s.on[i]), 'aria-label': `${s.user_name} works ${label}`,
          onclick: (e) => { s.on[i] = !s.on[i]; e.currentTarget.classList.toggle('on', s.on[i]); e.currentTarget.setAttribute('aria-pressed', String(s.on[i])); },
        }, label[0])))),
        h('td', {}, h('input', { type: 'time', value: s.start, 'aria-label': `${s.user_name} starts`, onchange: (e) => { s.start = e.target.value; } })),
        h('td', {}, h('input', { type: 'time', value: s.end, 'aria-label': `${s.user_name} ends`, onchange: (e) => { s.end = e.target.value; } }))))))),
    h('div', { class: 'tp-add-grid' },
      h('label', {}, 'Late or early counts after (minutes)', grace),
      h('label', {}, 'Lunch break (minutes)', lunch)),
    h('div', { class: 'tp-form-actions' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        try {
          await api('/api/schedules', { method: 'PUT', body: { schedules: tc.schedules.map((s) => ({ user_name: s.user_name, days: s.on.map((on) => (on ? { start: s.start, end: s.end } : null)) })) } });
          await api('/api/payroll/settings', { method: 'PUT', body: { grace_minutes: grace.value, lunch_minutes: lunch.value } });
          tc.schedules = null;
          toast('Schedules saved. Attendance is updated.');
          await loadTimePay();
        } catch (err) { fail(err); }
      } }, 'Save schedules'),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.schedules = null; renderTimePay(); } }, 'Cancel')));
}

// The pay week: who has approved their time, the email to the admins, and approving it for payroll.
function weekCard(w) {
  const done = w.signoffs.filter((x) => x.approved_at).length;
  const emails = tc.pay.settings.payroll_emails || [];
  return h('section', { class: `tp-week ${w.all_signed ? 'all' : ''}` },
    h('div', { class: 'tp-week-head' },
      h('div', {},
        h('h3', {}, `Pay week ${tcDay(tcKeyDate(w.start))} – ${tcDay(tcKeyDate(w.end))}`),
        h('p', { class: 'muted' }, w.signoffs.length
          ? `${done} of ${w.signoffs.length} approved their time. They approve when they clock out on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tc.pay.settings.review_day]}.`
          : 'Nobody has worked this week yet.')),
      h('div', { class: 'tp-week-actions' },
        w.approved_at
          ? h('span', { class: 'tp-ok' }, `✓ Approved for payroll by ${w.approved_by}, ${fmtDateTime(w.approved_at)}`)
          : h('button', { type: 'button', class: 'primary', onclick: approvePayWeek }, 'Approve week for payroll'),
        h('button', { type: 'button', onclick: emailPayWeek }, w.emailed_at ? 'Email it again' : 'Email summary now'))),
    w.signoffs.length ? h('div', { class: 'tp-signoffs' }, ...w.signoffs.map((x) => h('span', {
      class: `tp-signoff ${x.approved_at ? (x.changed ? 'changed' : 'ok') : 'waiting'}`,
      title: x.approved_at ? `Approved ${tcHrs(x.hours)}${x.changed ? `; now ${tcHrs(x.worked)} after changes` : ''}` : 'Hasn\'t approved their time yet',
    }, x.approved_at ? (x.changed ? '⚠ ' : '✓ ') : '○ ', h('strong', {}, x.user_name), ' ',
    x.approved_at ? (x.changed ? 'hours changed since' : new Date(x.approved_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) : 'waiting'))) : null,
    h('p', { class: 'muted tp-week-mail' }, w.emailed_at
      ? `Emailed to ${w.emailed_to.join(', ')} · ${fmtDateTime(w.emailed_at)}`
      : !w.email_ready ? 'Email sending isn\'t set up on the server yet (see EMAIL_ in the setup guide). Until then, use Download CSV.'
      : emails.length
        ? `Emails ${emails.join(', ')} once everyone has approved, or the morning after ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tc.pay.settings.review_day]}.`
        : 'Add the admins\' email addresses in Payroll rules to get this summary by email each week.'));
}

async function approvePayWeek() {
  try {
    await api(`/api/payroll/weeks/${tc.pay.week.start}/approve`, { method: 'POST' });
    toast('Week approved for payroll.');
    await loadTimePay();
  } catch (err) { fail(err); }
}

async function emailPayWeek() {
  try {
    const r = await api(`/api/payroll/weeks/${tc.pay.week.start}/email`, { method: 'POST' });
    toast(`Sent to ${r.sent_to.join(', ')}.`);
    await loadTimePay();
  } catch (err) { fail(err); }
}

function renderTimePay() {
  const d = tc.pay;
  const t = d.totals;
  fill($('#tpBody'),
    d.week && weekCard(d.week),
    tc.settings && tpSettings(d.settings),
    tc.schedules && schedulesCard(d),
    tc.adding && tpAddForm(d.rows),
    d.pending_corrections.length ? h('section', { class: 'rev-block tp-pending' },
      h('h3', {}, `Timecard corrections waiting for you (${d.pending_corrections.length})`),
      h('ul', { class: 'tp-off-list' }, ...d.pending_corrections.map(correctionRow))) : null,
    d.pending_time_off.length ? h('section', { class: 'rev-block tp-pending' },
      h('h3', {}, `Time off waiting for you (${d.pending_time_off.length})`),
      h('ul', { class: 'tp-off-list' }, ...d.pending_time_off.map(pendingRow))) : null,
    h('div', { class: 'an-kpis tp-kpis' },
      tpTile('Total hours', tcHrs(t.total_hours), 'worked + paid time off'),
      tpTile('Regular', tcHrs(t.regular_hours)),
      tpTile('Overtime', tcHrs(t.overtime_hours), `at ${d.settings.ot_multiplier}×`),
      tpTile('Paid time off', tcHrs(t.pto_hours)),
      tpTile('Gross pay', money(t.gross_cents), t.missing_rates ? `${t.missing_rates} without a rate` : 'before taxes')),
    attendanceCard(d),
    t.missing_rates ? h('p', { class: 'tp-warn' }, `${t.missing_rates === 1 ? 'Someone' : `${t.missing_rates} people`} worked without an hourly rate, so their pay isn't added in. Add a rate below.`) : null,
    h('div', { class: 'tp-table-wrap' },
      h('table', { class: 'tp-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Person'), h('th', {}, 'Hourly rate'), h('th', { class: 'num' }, 'Regular'), h('th', { class: 'num' }, 'Overtime'),
          h('th', { class: 'num' }, 'Paid off'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Gross pay'), h('th', {}, 'Attendance'))),
        h('tbody', {}, ...d.rows.flatMap(personRows)),
        h('tfoot', {}, h('tr', {},
          h('th', {}, 'Everyone'), h('td', {}), h('td', { class: 'num' }, tcHrs(t.regular_hours)), h('td', { class: 'num' }, tcHrs(t.overtime_hours)),
          h('td', { class: 'num' }, tcHrs(t.pto_hours)), h('td', { class: 'num' }, tcHrs(t.total_hours)), h('td', { class: 'num' }, h('strong', {}, money(t.gross_cents))),
          h('td', {}, d.occurrences.length ? `${d.occurrences.length} issue${d.occurrences.length === 1 ? '' : 's'}` : ''))))),
    !d.rows.length && h('p', { class: 'muted' }, 'Nobody has clocked in yet. Sales and shop logins clock in with the Clock in button at the top.'),
    h('p', { class: 'hint' }, 'Gross pay is before taxes and deductions. Hand the CSV to whoever runs payroll.'));
}

function pendingRow(r) {
  return h('li', { class: 'tp-off' },
    h('div', {},
      h('strong', {}, r.user_name), ` · ${tcDays(r)}`,
      h('div', { class: 'muted' }, `${r.kind_label} · ${tcHrs(r.hours)} (${r.hours_per_day} h a day)${r.note ? ` · “${r.note}”` : ''}`)),
    h('div', { class: 'tp-off-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => decide(r, 'approved') }, 'Approve'),
      h('button', { type: 'button', onclick: () => decide(r, 'denied') }, 'Deny')));
}

function correctionRow(c) {
  return h('li', { class: 'tp-off' },
    h('div', {},
      h('strong', {}, c.user_name), ` · ${corrText(c)}`,
      h('div', { class: 'muted' }, `“${c.reason}” · asked ${fmtDateTime(c.created_at)}`)),
    h('div', { class: 'tp-off-actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => decideCorrection(c, 'approved') }, 'Approve'),
      h('button', { type: 'button', onclick: () => decideCorrection(c, 'denied') }, 'Deny')));
}

async function decideCorrection(c, status) {
  let note = '';
  if (status === 'denied') {
    note = await ask({ title: `Deny ${c.user_name}'s correction?`, text: 'Add a note for them (optional).', input: { placeholder: 'e.g. The camera shows you left at 4:00' }, ok: 'Deny', danger: true });
    if (note === null) return;
  }
  try {
    await api(`/api/timecard/corrections/${c.id}`, { method: 'PATCH', body: { status, note } });
    toast(status === 'approved' ? 'Approved. Their timecard is fixed.' : 'Denied.');
    tc.open.add(c.user_name.toLowerCase());
    await loadTimePay();
  } catch (err) { fail(err); }
}

async function decide(r, status) {
  let note = '';
  if (status === 'denied') {
    note = await ask({ title: `Deny ${r.user_name}'s time off?`, text: 'Add a note for them (optional).', input: { placeholder: 'e.g. We\'re short-staffed that week' }, ok: 'Deny', danger: true });
    if (note === null) return;
  }
  try {
    await api(`/api/time-off/${r.id}`, { method: 'PATCH', body: { status, note } });
    toast(status === 'approved' ? `Approved. It's on the calendar.` : 'Denied.');
    await loadTimePay();
  } catch (err) { fail(err); }
}

function personRows(p) {
  const key = p.name.toLowerCase();
  const open = tc.open.has(key);
  const rate = h('input', {
    class: 'tp-rate', inputmode: 'decimal', 'aria-label': `${p.name}'s hourly rate`, placeholder: 'Add rate',
    value: p.rate_cents == null ? '' : (p.rate_cents / 100).toFixed(2),
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    onchange: (e) => saveRate(p.name, e.target.value),
  });
  const row = h('tr', { class: `tp-person ${open ? 'open' : ''}`, 'data-person-row': key },
    h('th', { scope: 'row' },
      h('button', { type: 'button', class: 'tp-name', 'aria-expanded': String(open), onclick: () => { if (open) tc.open.delete(key); else tc.open.add(key); renderTimePay(); } },
        h('span', { class: 'tp-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'), p.name),
      p.role && h('span', { class: 'muted tp-role' }, ` ${p.role}`),
      p.on_clock && h('span', { class: 'tp-flag on' }, 'On the clock')),
    h('td', {}, h('span', { class: 'tp-rate-box' }, '$', rate, h('span', { class: 'muted' }, '/hr'))),
    h('td', { class: 'num' }, tcHrs(p.regular_hours)),
    h('td', { class: 'num' }, p.overtime_hours ? tcHrs(p.overtime_hours) : '–'),
    h('td', { class: 'num' }, p.pto_hours ? tcHrs(p.pto_hours) : '–'),
    h('td', { class: 'num' }, tcHrs(p.total_hours)),
    h('td', { class: 'num' }, p.gross_cents == null ? h('span', { class: 'muted' }, p.total_hours ? 'No rate' : '–') : money(p.gross_cents)),
    h('td', {}, p.issue_count
      ? h('button', { type: 'button', class: 'tp-issue-count', title: Object.entries(p.issues).filter(([, n]) => n).map(([t, n]) => `${n} ${ISSUE_INFO[t].label.toLowerCase()}`).join(', '), onclick: () => { tc.open.add(key); renderTimePay(); } }, `${p.issue_count} issue${p.issue_count === 1 ? '' : 's'}`)
      : p.has_schedule ? h('span', { class: 'tp-ok' }, '✓ On schedule') : h('span', { class: 'muted' }, 'No schedule')));
  if (!open) return [row];
  return [row, h('tr', { class: 'tp-detail' }, h('td', { colspan: '8' }, personDetail(p)))];
}

// One row per day: schedule, in, lunch, out, hours and anything that went wrong. Edit opens that day's punches.
function personDetail(p) {
  const lunchCell = (d) => (d.lunches.length
    ? d.lunches.map((l) => h('div', {}, `${tcClock(l.from)} – ${l.to ? tcClock(l.to) : 'now'}`, h('span', { class: 'muted' }, ` · ${tcMin(l.minutes)}`)))
    : h('span', { class: 'muted' }, '–'));
  const outCell = (d) => {
    if (d.open) return h('span', { class: 'tp-flag on' }, 'Still on');
    if (d.on_lunch) return h('span', { class: 'tp-flag' }, 'On lunch');
    return d.last_out ? tcClock(d.last_out) : h('span', { class: 'muted' }, '–');
  };
  const dayRows = (d) => {
    const key = `${p.name}|${d.date}`;
    const editing = tc.editDay === key;
    const offOnly = d.off && !d.punches.length;
    const row = h('tr', { class: `tp-day ${d.issues.length ? 'has-issues' : ''} ${offOnly ? 'off' : ''} ${editing ? 'editing' : ''}` },
      h('td', { class: 'tp-day-date' }, tcDay(tcKeyDate(d.date))),
      h('td', { class: 'muted' }, d.schedule ? `${t12(d.schedule.start)} – ${t12(d.schedule.end)}` : 'Not scheduled'),
      offOnly
        ? h('td', { colspan: '4', class: 'tp-day-off' }, `Off · ${d.off.kind_label}`)
        : [h('td', {}, d.first_in ? tcClock(d.first_in) : h('span', { class: 'muted' }, '–'),
          d.punches[0]?.clock_in_distance != null && h('span', { class: 'tp-geo-pin', title: `Clocked in ${d.punches[0].clock_in_distance} m from the shop` }, ' 📍')),
          h('td', { class: 'tp-lunch' }, lunchCell(d)),
          h('td', {}, outCell(d)),
          h('td', { class: 'num' }, d.punches.length ? tcHM(d.hours * 3600000) : '–')],
      h('td', {}, h('div', { class: 'tp-issues' }, ...d.issues.map(issueChip), d.off && d.punches.length ? h('span', { class: 'tp-issue info' }, `Off · ${d.off.kind_label}`) : null)),
      h('td', { class: 'tp-day-actions' }, d.punches.length
        ? h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.editDay = editing ? null : key; renderTimePay(); } }, editing ? 'Close' : 'Edit')
        : h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.adding = p.name; tc.addDay = d.date; renderTimePay(); $('#tpBody').scrollIntoView?.({ block: 'start' }); } }, 'Add time')));
    return editing ? [row, h('tr', { class: 'tp-day-edit-row' }, h('td', { colspan: '8' }, dayEditor(p, d)))] : [row];
  };
  return h('div', { class: 'tp-detail-body' },
    p.days.length ? h('table', { class: 'tp-days' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Scheduled'), h('th', {}, 'In'), h('th', {}, 'Lunch'), h('th', {}, 'Out'), h('th', { class: 'num' }, 'Hours'), h('th', {}, 'Attendance'), h('th', {}, ''))),
      h('tbody', {}, ...p.days.flatMap(dayRows))) : h('p', { class: 'muted' }, 'No time clocked in this period.'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.adding = p.name; tc.addDay = null; renderTimePay(); $('#tpBody').scrollIntoView?.({ block: 'start' }); } }, `+ Add time for ${p.name}`));
}

// A day's punches, to fix: clock-in, clock-out and a note for each; or delete one.
function dayEditor(p, d) {
  return h('div', { class: 'tp-day-edit' },
    ...d.punches.map((x, i) => {
      const inp = h('input', { type: 'datetime-local', value: toLocalInput(new Date(x.clock_in)) });
      const out = h('input', { type: 'datetime-local', value: x.clock_out ? toLocalInput(new Date(x.clock_out)) : '' });
      const note = h('input', { value: x.note || '', placeholder: 'Why it changed (optional)', maxlength: '200' });
      return h('div', { class: `tp-edit-row ${x.auto_closed ? 'flagged' : ''}` },
        h('span', { class: 'tp-edit-n' }, d.punches.length > 1 ? (i === 0 ? 'Before lunch' : i === d.punches.length - 1 ? 'After lunch' : `Part ${i + 1}`) : 'Shift'),
        h('label', {}, 'In', inp),
        h('label', {}, 'Out', out),
        h('label', { class: 'grow' }, 'Note', note),
        h('div', { class: 'tp-edit-actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => savePunch(x.id, { clock_in: new Date(inp.value).toISOString(), clock_out: out.value ? new Date(out.value).toISOString() : undefined, note: note.value }) }, 'Save'),
          h('button', { type: 'button', class: 'link-btn danger', onclick: () => removePunch(x) }, 'Delete')),
        (x.auto_closed || x.edited_by || x.clock_in_distance != null) && h('div', { class: 'tp-edit-meta muted' }, [
          x.clock_in_distance != null && `Clocked in ${x.clock_in_distance < 1000 ? `${x.clock_in_distance} m` : `${(x.clock_in_distance / 1609.34).toFixed(1)} miles`} from the shop`,
          x.auto_closed && 'Forgot to clock out: closed at the end of the day', x.edited_by && `Last fixed by ${x.edited_by}`].filter(Boolean).join(' · ')));
    }));
}

async function saveRate(name, value) {
  try {
    await api('/api/pay-rates', { method: 'PUT', body: { user_name: name, rate: value.replace(/[$\s]/g, '') } });
    toast(value ? `${name}'s rate saved.` : `${name}'s rate removed.`);
    await loadTimePay();
  } catch (err) { fail(err); loadTimePay().catch(() => {}); }
}

async function savePunch(id, body) {
  try {
    await api(`/api/time/punches/${id}`, { method: 'PATCH', body });
    tc.editing = null;
    await loadTimePay();
  } catch (err) { fail(err); }
}

async function removePunch(x) {
  if (!await askConfirm('Delete this time?', `${tcDay(x.clock_in)}, ${tcClock(x.clock_in)} to ${x.clock_out ? tcClock(x.clock_out) : 'now'}.`, { ok: 'Delete', danger: true })) return;
  try {
    await api(`/api/time/punches/${x.id}`, { method: 'DELETE' });
    await loadTimePay();
  } catch (err) { fail(err); }
}

function tpAddForm(rows) {
  const names = rows.map((r) => r.name);
  const day = tc.addDay ? tcKeyDate(tc.addDay) : new Date(); day.setHours(8, 0, 0, 0);
  const end = new Date(day); end.setHours(16, 0, 0, 0);
  return h('form', { class: 'rev-block tp-add', onsubmit: async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/time/punches', { method: 'POST', body: { ...f, clock_in: new Date(f.clock_in).toISOString(), clock_out: new Date(f.clock_out).toISOString() } });
      toast(`Added time for ${f.user_name}.`);
      tc.adding = false;
      tc.open.add(f.user_name.toLowerCase());
      await loadTimePay();
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Add time someone forgot to clock'),
  h('div', { class: 'tp-add-grid' },
    h('label', {}, 'Who', h('select', { name: 'user_name', required: true }, ...names.map((n) => h('option', { value: n, selected: n === tc.adding }, n)))),
    h('label', {}, 'Clock in', h('input', { type: 'datetime-local', name: 'clock_in', required: true, value: toLocalInput(day) })),
    h('label', {}, 'Clock out', h('input', { type: 'datetime-local', name: 'clock_out', required: true, value: toLocalInput(end) })),
    h('label', {}, 'Note', h('input', { name: 'note', maxlength: '200', placeholder: 'e.g. Phone died' }))),
  h('div', { class: 'tp-form-actions' },
    h('button', { type: 'submit', class: 'primary' }, 'Add time'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.adding = false; renderTimePay(); } }, 'Cancel')));
}

function tpSettings(s) {
  const kinds = TC_KINDS();
  return h('form', { class: 'rev-block tp-settings', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/payroll/settings', { method: 'PUT', body: {
        ot_weekly_hours: f.get('ot_weekly_hours'), ot_daily_hours: f.get('daily_on') ? f.get('ot_daily_hours') : null,
        ot_multiplier: f.get('ot_multiplier'), paid_kinds: f.getAll('paid_kinds'),
        review_day: f.get('review_day'), payroll_emails: f.get('payroll_emails'),
        geofence: { enabled: Boolean(f.get('geo_on')), lat: f.get('geo_lat'), lng: f.get('geo_lng'), radius_m: f.get('geo_radius'), roles: f.getAll('geo_roles'), mode: f.get('geo_mode') },
      } });
      toast('Saved. The numbers are updated.');
      tc.settings = false;
      await loadTimePay();
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Payroll rules'),
  h('div', { class: 'tp-add-grid' },
    h('label', {}, 'Everyone approves their week when they clock out on',
      h('select', { name: 'review_day' }, ...['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((n, i) => h('option', { value: i, selected: i === s.review_day }, n)))),
    h('label', { class: 'tp-wide' }, 'Email the weekly summary to (admins, separated by commas)',
      h('input', { name: 'payroll_emails', value: (s.payroll_emails || []).join(', '), placeholder: 'owner@example.com, office@example.com' }))),
  geoSettings(s.geofence || {}),
  h('p', { class: 'hint' }, 'The pay week is Sunday to Saturday. The summary (hours, overtime, gross pay and a CSV of every punch) is emailed once everyone has approved their time, or the morning after if someone hasn\'t. Anyone who isn\'t scheduled that day approves on their last scheduled day.'),
  h('div', { class: 'tp-add-grid' },
    h('label', {}, 'Overtime after (hours a week)', h('input', { type: 'number', name: 'ot_weekly_hours', min: '1', max: '80', step: '0.5', value: s.ot_weekly_hours })),
    h('label', {}, 'Overtime pay (times the rate)', h('input', { type: 'number', name: 'ot_multiplier', min: '1', max: '3', step: '0.05', value: s.ot_multiplier })),
    h('label', {}, h('span', {}, h('input', { type: 'checkbox', name: 'daily_on', checked: Boolean(s.ot_daily_hours) }), ' Also overtime after (hours a day)'),
      h('input', { type: 'number', name: 'ot_daily_hours', min: '1', max: '24', step: '0.5', value: s.ot_daily_hours || 8 }))),
  h('fieldset', { class: 'tp-kinds' }, h('legend', {}, 'Paid time off (added to pay at the regular rate)'),
    ...Object.entries(kinds).filter(([k]) => k !== 'unpaid').map(([k, v]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'paid_kinds', value: k, checked: s.paid_kinds.includes(k) }), ` ${v}`))),
  h('p', { class: 'hint' }, 'Nevada requires daily overtime for some hourly workers. Check with your accountant which rules apply to your team.'),
  h('div', { class: 'tp-form-actions' },
    h('button', { type: 'submit', class: 'primary' }, 'Save rules'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.settings = false; renderTimePay(); } }, 'Cancel')));
}

// Geo-lock settings: where the shop is, how close counts, and who it applies to.
function geoSettings(g) {
  const lat = h('input', { name: 'geo_lat', inputmode: 'decimal', value: g.lat ?? '', placeholder: 'e.g. 36.10690', 'aria-label': 'Shop latitude' });
  const lng = h('input', { name: 'geo_lng', inputmode: 'decimal', value: g.lng ?? '', placeholder: 'e.g. -115.19810', 'aria-label': 'Shop longitude' });
  const map = h('a', { class: 'link-btn', target: '_blank', rel: 'noopener', hidden: g.lat == null }, 'See it on a map');
  const syncMap = () => { map.hidden = !lat.value || !lng.value; map.href = `https://www.google.com/maps?q=${encodeURIComponent(lat.value)},${encodeURIComponent(lng.value)}`; };
  syncMap();
  lat.addEventListener('input', syncMap);
  lng.addEventListener('input', syncMap);
  const RADII = [[75, 'About 250 ft (75 m)'], [150, 'About 500 ft (150 m)'], [300, 'About 1,000 ft (300 m)'], [500, 'About a third of a mile (500 m)'], [1000, 'About half a mile (1 km)']];
  const radius = g.radius_m || 150;
  return h('fieldset', { class: 'tp-geo' },
    h('legend', {}, 'Clock in at the shop (geo-lock)'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'geo_on', checked: Boolean(g.enabled) }), ' Only let these people clock in (and come back from lunch) at the shop:'),
    h('div', { class: 'tp-geo-roles' }, ...[['shop', 'Shop'], ['sales', 'Sales']].map(([r, label]) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'geo_roles', value: r, checked: (g.roles || ['shop']).includes(r) }), ` ${label}`))),
    h('div', { class: 'tp-geo-mode' },
      h('div', { class: 'tp-geo-mode-label' }, 'When someone isn\'t at the shop:'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'geo_mode', value: 'block', checked: g.mode !== 'flag' }), ' Don\'t let them clock in, and alert the admins'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'geo_mode', value: 'flag', checked: g.mode === 'flag' }), ' Let them clock in, but alert the admins and flag it')),
    h('div', { class: 'tp-add-grid' },
      h('label', {}, 'Shop latitude', lat),
      h('label', {}, 'Shop longitude', lng),
      h('label', {}, 'How close counts', h('select', { name: 'geo_radius' }, ...(RADII.some(([m]) => m === radius) ? RADII : [[radius, `${radius} m`], ...RADII])
        .map(([m, label]) => h('option', { value: m, selected: m === radius }, label))))),
    h('div', { class: 'tp-form-actions' },
      h('button', { type: 'button', onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = 'Finding you…';
        try {
          const here = await getLocation();
          lat.value = here.lat.toFixed(6);
          lng.value = here.lng.toFixed(6);
          syncMap();
          toast(`Got it (accurate to about ${here.accuracy} m). Save the rules to use it.`);
        } catch (err) { fail(err); }
        b.disabled = false;
        b.textContent = 'Use my current location';
      } }, 'Use my current location'),
      map),
    h('p', { class: 'hint' }, 'Stand at the shop and tap Use my current location. Going to lunch and clocking out work anywhere. Phones are less exact indoors, so a little extra distance is allowed when the phone says its location is fuzzy. Each clock-in keeps how far from the shop it was.'));
}

function exportTimePay() {
  const d = tc.pay;
  if (!d) return;
  const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
  const lines = [
    ['Name', 'Role', 'Hourly rate', 'Regular hours', 'Overtime hours', 'Paid time off hours', 'Unpaid time off hours', 'Total paid hours', 'Gross pay', 'Late', 'Left early', 'Long lunches', 'No-shows', 'Forgot to clock out'],
    ...d.rows.map((r) => [r.name, r.role, dollars(r.rate_cents), r.regular_hours, r.overtime_hours, r.pto_hours, r.unpaid_off_hours, r.total_hours, dollars(r.gross_cents),
      r.issues.late, r.issues.early, r.issues.long_lunch, r.issues.no_show, r.issues.missed_out]),
    ['Everyone', '', '', d.totals.regular_hours, d.totals.overtime_hours, d.totals.pto_hours, '', d.totals.total_hours, dollars(d.totals.gross_cents)],
    [],
    ['Date', 'Name', 'Attendance', 'Details'],
    ...d.occurrences.map((o) => [o.date, o.user_name, ISSUE_INFO[o.type].chip(o), ISSUE_INFO[o.type].detail(o)]),
    [],
    ['Name', 'Clock in', 'Clock out', 'Hours', 'Note'],
    ...d.rows.flatMap((r) => r.punches.map((x) => [r.name, toLocalInput(new Date(x.clock_in)).replace('T', ' '), x.clock_out ? toLocalInput(new Date(x.clock_out)).replace('T', ' ') : 'still on', x.hours,
      [x.auto_closed && 'forgot to clock out', x.note].filter(Boolean).join('; ')])),
  ];
  const blob = new Blob([lines.map((l) => l.map(q).join(',')).join('\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `time-and-pay-${d.from}-to-${d.to}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
}

// Admins see how many time-off requests are waiting on the Time & Pay button.
function setTimeOffBadge(n) {
  const badge = $('#timeBadge');
  if (!badge) return;
  badge.textContent = n;
  badge.hidden = !n;
}
async function loadTimeOffBadge() {
  if (!isAdmin()) return;
  try {
    const [off, fixes] = await Promise.all([api('/api/time-off?status=pending'), api('/api/timecard/corrections?status=pending')]);
    setTimeOffBadge(off.length + fixes.length);
  } catch { /* try again later */ }
}

function initTimeClock() {
  $('#clockBtn').addEventListener('click', openMyTime);
  $('#clockDialog').addEventListener('close', afterConfirmation);
  // Tapping outside the confirmation closes it like Cancel (or Done).
  $('#clockDialog').addEventListener('click', (e) => { if (e.target === $('#clockDialog')) $('#clockDialog').close(); });
  setInterval(tickMyTime, 1000);
  $('#tpPeriod').addEventListener('change', () => {
    $('#tpCustom').hidden = $('#tpPeriod').value !== 'custom';
    if ($('#tpPeriod').value === 'custom' && !$('#tpFrom').value && tc.range) [$('#tpFrom').value, $('#tpTo').value] = tc.range;
    loadTimePay().catch(fail);
  });
  $('#tpPrevWeek').addEventListener('click', () => { tc.weekOffset -= 1; loadTimePay().catch(fail); });
  $('#tpNextWeek').addEventListener('click', () => { tc.weekOffset += 1; loadTimePay().catch(fail); });
  for (const id of ['#tpFrom', '#tpTo']) $(id).addEventListener('change', () => loadTimePay().catch(fail));
  $('#tpAdd').addEventListener('click', () => { tc.adding = tc.adding ? false : true; renderTimePay(); });
  $('#tpSettingsBtn').addEventListener('click', () => { tc.settings = !tc.settings; renderTimePay(); });
  $('#tpExport').addEventListener('click', exportTimePay);
  loadClock().catch(() => {});
  loadTimeOffBadge();
  // Admins: the red bar for clock-ins away from the shop, checked every 30 seconds.
  if (isAdmin()) { loadClockAlarm(); setInterval(loadClockAlarm, 30_000); }
  // Keep the running clock on the button current, and pick up a clock-out from another device.
  tc.tick = setInterval(renderClockPill, 30_000);
  setInterval(() => { loadClock().catch(() => {}); loadTimeOffBadge(); }, 5 * 60_000);
}
