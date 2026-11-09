'use strict';
// The time clock for everyone (the Clock in button in the top bar and the "My time" panel: clock in and
// out, hours this week, ask for time off) and the admins' Time & Pay page (approve time off, hourly
// rates, regular / overtime / paid time off hours and gross pay for a pay period, fix punches, CSV).
// Uses the helpers from app.js ($, h, fill, api, toast, fail, money, toLocalInput, showPanel...).

const tc = { status: null, tick: null, pay: null, open: new Set(), editing: null, adding: false, settings: false };
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
function renderClockPill() {
  const s = tc.status;
  const btn = $('#clockBtn');
  btn.hidden = !s;
  if (!s) return;
  btn.classList.toggle('on', s.on_clock);
  $('#clockLabel').textContent = s.on_clock ? `On the clock · ${tcElapsed(s.clock_in)}` : 'Clock in';
  btn.title = s.on_clock ? `Clocked in at ${tcClock(s.clock_in)}. Open My time to clock out.` : 'Open My time to clock in or ask for time off.';
}

async function loadClock() {
  if (!state.meta.currentUser) return;
  tc.status = await api('/api/clock');
  renderClockPill();
  if (!$('#timePanel').hidden) renderMyTime();
}

async function punch(dir) {
  try {
    tc.status = await api(`/api/clock/${dir}`, { method: 'POST' });
    renderClockPill();
    renderMyTime();
    toast(dir === 'in' ? `Clocked in at ${tcClock(tc.status.clock_in)}.` : `Clocked out. ${tcHrs(tc.status.today_hours)} today.`);
    if (state.section === 'time') loadTimePay().catch(() => {});
  } catch (err) { fail(err); }
}

// ---------- My time (everyone) ----------
function renderMyTime() {
  const s = tc.status;
  if (!s) return;
  $('#timeWho').textContent = state.meta.currentUser;
  const kinds = TC_KINDS();
  const today = ShopTime.dayKey(new Date());
  const form = h('form', { class: 'tc-off-form', onsubmit: askOff },
    h('div', { class: 'tc-off-grid' },
      h('label', {}, 'First day off', h('input', { type: 'date', name: 'start_date', required: true, min: today, value: today })),
      h('label', {}, 'Last day off', h('input', { type: 'date', name: 'end_date', min: today })),
      h('label', {}, 'Kind', h('select', { name: 'kind' }, ...Object.entries(kinds).map(([k, v]) => h('option', { value: k }, v)))),
      h('label', {}, 'Hours a day', h('input', { type: 'number', name: 'hours_per_day', min: '1', max: '24', step: '0.5', value: state.meta.shopHours?.hours_per_day || 8 }))),
    h('label', {}, 'Note for the admin (optional)', h('input', { name: 'note', maxlength: '300', placeholder: 'e.g. Family trip' })),
    h('button', { type: 'submit', class: 'primary' }, 'Ask for time off'));
  const reqs = s.time_off || [];
  fill($('#timeBody'),
    h('section', { class: `card-section tc-status ${s.on_clock ? 'on' : ''}` },
      h('div', { class: 'tc-state' },
        h('span', { class: 'clock-dot', 'aria-hidden': 'true' }),
        s.on_clock ? `On the clock since ${tcClock(s.clock_in)}` : 'Off the clock'),
      s.on_clock && h('div', { class: 'tc-running' }, tcElapsed(s.clock_in)),
      h('button', { type: 'button', class: `tc-punch ${s.on_clock ? 'danger-btn' : 'primary'}`, onclick: () => punch(s.on_clock ? 'out' : 'in') }, s.on_clock ? 'Clock out' : 'Clock in'),
      h('div', { class: 'tc-totals' },
        h('div', {}, h('span', { class: 'muted' }, 'Today'), h('strong', {}, tcHrs(s.today_hours))),
        h('div', {}, h('span', { class: 'muted' }, 'This week'), h('strong', {}, tcHrs(s.week_hours))))),
    h('section', { class: 'card-section' },
      h('h3', {}, 'Ask for time off'),
      h('p', { class: 'hint' }, 'An admin approves it, then it shows on the shop calendar.'),
      form),
    h('section', { class: 'card-section' },
      h('h3', {}, 'My time off'),
      reqs.length ? h('ul', { class: 'tc-reqs' }, ...reqs.map((r) => h('li', { class: `tc-req status-${r.status}` },
        h('div', { class: 'tc-req-top' },
          h('strong', {}, tcDays(r)),
          h('span', { class: `tc-badge ${r.status}` }, STATUS_LABEL[r.status] || r.status)),
        h('div', { class: 'muted' }, `${r.kind_label} · ${tcHrs(r.hours)}${r.note ? ` · ${r.note}` : ''}`),
        r.decision_note && h('div', { class: 'tc-decision' }, `${r.decided_by || 'Admin'}: ${r.decision_note}`),
        r.status === 'pending' && h('button', { type: 'button', class: 'link-btn', onclick: () => cancelOff(r.id) }, 'Cancel request'))))
        : h('p', { class: 'muted' }, 'No time off asked for yet.')));
}

async function askOff(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f);
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
  renderMyTime();
  loadClock().catch(fail);
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
  if (v === 'week') return [key(sunday), key(plus(sunday, 6))];
  if (v === 'lastweek') return [key(plus(sunday, -7)), key(plus(sunday, -1))];
  if (v === 'two') return [key(plus(sunday, -7)), key(plus(sunday, 6))];
  if (v === 'lasttwo') return [key(plus(sunday, -14)), key(plus(sunday, -1))];
  if (v === 'month') return [key(new Date(today.getFullYear(), today.getMonth(), 1)), key(new Date(today.getFullYear(), today.getMonth() + 1, 0))];
  return [key(new Date(today.getFullYear(), today.getMonth() - 1, 1)), key(new Date(today.getFullYear(), today.getMonth(), 0))];
}

async function loadTimePay() {
  const r = tpRange();
  if (!r) return;
  tc.range = r;
  tc.pay = await api(`/api/payroll?from=${r[0]}&to=${r[1]}`);
  $('#tpRange').textContent = `${tcDay(tcKeyDate(r[0]))} to ${tcDay(tcKeyDate(r[1]))}. Overtime after ${tc.pay.settings.ot_weekly_hours} hours a week${tc.pay.settings.ot_daily_hours ? ` or ${tc.pay.settings.ot_daily_hours} a day` : ''} (Sunday to Saturday), at ${tc.pay.settings.ot_multiplier}× the rate.`;
  renderTimePay();
  setTimeOffBadge(tc.pay.pending_time_off.length);
}

function tpTile(label, value, sub) {
  return h('div', { class: 'an-tile' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), sub && h('div', { class: 'sub' }, sub));
}

function renderTimePay() {
  const d = tc.pay;
  const t = d.totals;
  fill($('#tpBody'),
    tc.settings && tpSettings(d.settings),
    tc.adding && tpAddForm(d.rows),
    d.pending_time_off.length ? h('section', { class: 'rev-block tp-pending' },
      h('h3', {}, `Time off waiting for you (${d.pending_time_off.length})`),
      h('ul', { class: 'tp-off-list' }, ...d.pending_time_off.map(pendingRow))) : null,
    h('div', { class: 'an-kpis tp-kpis' },
      tpTile('Total hours', tcHrs(t.total_hours), 'worked + paid time off'),
      tpTile('Regular', tcHrs(t.regular_hours)),
      tpTile('Overtime', tcHrs(t.overtime_hours), `at ${d.settings.ot_multiplier}×`),
      tpTile('Paid time off', tcHrs(t.pto_hours)),
      tpTile('Gross pay', money(t.gross_cents), t.missing_rates ? `${t.missing_rates} without a rate` : 'before taxes')),
    t.missing_rates ? h('p', { class: 'tp-warn' }, `${t.missing_rates === 1 ? 'Someone' : `${t.missing_rates} people`} worked without an hourly rate, so their pay isn't added in. Add a rate below.`) : null,
    h('div', { class: 'tp-table-wrap' },
      h('table', { class: 'tp-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Person'), h('th', {}, 'Hourly rate'), h('th', { class: 'num' }, 'Regular'), h('th', { class: 'num' }, 'Overtime'),
          h('th', { class: 'num' }, 'Paid off'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Gross pay'), h('th', {}, ''))),
        h('tbody', {}, ...d.rows.flatMap(personRows)),
        h('tfoot', {}, h('tr', {},
          h('th', {}, 'Everyone'), h('td', {}), h('td', { class: 'num' }, tcHrs(t.regular_hours)), h('td', { class: 'num' }, tcHrs(t.overtime_hours)),
          h('td', { class: 'num' }, tcHrs(t.pto_hours)), h('td', { class: 'num' }, tcHrs(t.total_hours)), h('td', { class: 'num' }, h('strong', {}, money(t.gross_cents))), h('td', {}))))),
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

async function decide(r, status) {
  let note = '';
  if (status === 'denied') {
    note = prompt(`Deny ${r.user_name}'s time off? Add a note for them (optional):`, '');
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
  const row = h('tr', { class: `tp-person ${open ? 'open' : ''}` },
    h('th', { scope: 'row' },
      h('button', { type: 'button', class: 'tp-name', 'aria-expanded': String(open), onclick: () => { if (open) tc.open.delete(key); else tc.open.add(key); renderTimePay(); } },
        h('span', { class: 'tp-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'), p.name),
      p.role && h('span', { class: 'muted tp-role' }, ` ${p.role}`),
      p.on_clock && h('span', { class: 'tp-flag on' }, 'On the clock'),
      p.flagged ? h('span', { class: 'tp-flag', title: 'Forgot to clock out: closed at the end of the day. Check the time.' }, `${p.flagged} to check`) : null),
    h('td', {}, h('span', { class: 'tp-rate-box' }, '$', rate, h('span', { class: 'muted' }, '/hr'))),
    h('td', { class: 'num' }, tcHrs(p.regular_hours)),
    h('td', { class: 'num' }, p.overtime_hours ? tcHrs(p.overtime_hours) : '–'),
    h('td', { class: 'num' }, p.pto_hours ? tcHrs(p.pto_hours) : '–'),
    h('td', { class: 'num' }, tcHrs(p.total_hours)),
    h('td', { class: 'num' }, p.gross_cents == null ? h('span', { class: 'muted' }, p.total_hours ? 'No rate' : '–') : money(p.gross_cents)),
    h('td', {}));
  if (!open) return [row];
  return [row, h('tr', { class: 'tp-detail' }, h('td', { colspan: '8' }, personDetail(p)))];
}

function personDetail(p) {
  const punchRow = (x) => {
    if (tc.editing === x.id) {
      const inp = h('input', { type: 'datetime-local', value: toLocalInput(new Date(x.clock_in)), 'aria-label': 'Clock in' });
      const out = h('input', { type: 'datetime-local', value: x.clock_out ? toLocalInput(new Date(x.clock_out)) : '', 'aria-label': 'Clock out' });
      const note = h('input', { value: x.note || '', placeholder: 'Why it changed (optional)', maxlength: '200', 'aria-label': 'Note' });
      return h('tr', { class: 'editing' },
        h('td', { colspan: '2' }, inp), h('td', {}, out), h('td', { colspan: '2' }, note),
        h('td', {},
          h('button', { type: 'button', class: 'primary', onclick: () => savePunch(x.id, { clock_in: new Date(inp.value).toISOString(), clock_out: out.value ? new Date(out.value).toISOString() : undefined, note: note.value }) }, 'Save'),
          h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.editing = null; renderTimePay(); } }, 'Cancel')));
    }
    return h('tr', { class: x.auto_closed ? 'flagged' : '' },
      h('td', {}, tcDay(x.clock_in)),
      h('td', {}, tcClock(x.clock_in)),
      h('td', {}, x.clock_out ? tcClock(x.clock_out) : h('span', { class: 'tp-flag on' }, 'Still on')),
      h('td', { class: 'num' }, tcHrs(x.hours)),
      h('td', { class: 'muted' }, [x.auto_closed && 'Forgot to clock out: closed at end of day', x.note, x.edited_by && `edited by ${x.edited_by}`].filter(Boolean).join(' · ')),
      h('td', { class: 'tp-punch-actions' },
        h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.editing = x.id; renderTimePay(); } }, 'Edit'),
        h('button', { type: 'button', class: 'link-btn danger', onclick: () => removePunch(x) }, 'Delete')));
  };
  return h('div', { class: 'tp-detail-body' },
    p.punches.length ? h('table', { class: 'tp-punches' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'In'), h('th', {}, 'Out'), h('th', { class: 'num' }, 'Hours'), h('th', {}, ''), h('th', {}, ''))),
      h('tbody', {}, ...p.punches.map(punchRow))) : h('p', { class: 'muted' }, 'No time clocked in this period.'),
    p.time_off.length ? h('div', { class: 'tp-person-off' },
      h('strong', {}, 'Time off: '),
      p.time_off.map((r) => `${tcDays(r)} ${r.kind_label} (${tcHrs(r.hours_in_period)})`).join(' · ')) : null,
    h('button', { type: 'button', class: 'link-btn', onclick: () => { tc.adding = p.name; renderTimePay(); window.scrollTo?.(0, 0); $('#tpBody').scrollIntoView?.({ block: 'start' }); } }, `+ Add time for ${p.name}`));
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
  if (!confirm(`Delete ${tcDay(x.clock_in)}, ${tcClock(x.clock_in)} to ${x.clock_out ? tcClock(x.clock_out) : 'now'}?`)) return;
  try {
    await api(`/api/time/punches/${x.id}`, { method: 'DELETE' });
    await loadTimePay();
  } catch (err) { fail(err); }
}

function tpAddForm(rows) {
  const names = rows.map((r) => r.name);
  const day = new Date(); day.setHours(8, 0, 0, 0);
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
      } });
      toast('Saved. The numbers are updated.');
      tc.settings = false;
      await loadTimePay();
    } catch (err) { fail(err); }
  } },
  h('h3', {}, 'Overtime & time off rules'),
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

function exportTimePay() {
  const d = tc.pay;
  if (!d) return;
  const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
  const lines = [
    ['Name', 'Role', 'Hourly rate', 'Regular hours', 'Overtime hours', 'Paid time off hours', 'Unpaid time off hours', 'Total paid hours', 'Gross pay'],
    ...d.rows.map((r) => [r.name, r.role, dollars(r.rate_cents), r.regular_hours, r.overtime_hours, r.pto_hours, r.unpaid_off_hours, r.total_hours, dollars(r.gross_cents)]),
    ['Everyone', '', '', d.totals.regular_hours, d.totals.overtime_hours, d.totals.pto_hours, '', d.totals.total_hours, dollars(d.totals.gross_cents)],
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
  const btn = document.querySelector('.main-nav [data-section="time"]');
  if (!btn) return;
  btn.textContent = 'Time & Pay';
  if (n) btn.append(' ', h('span', { class: 'badge' }, n));
}
async function loadTimeOffBadge() {
  if (!isAdmin()) return;
  try { setTimeOffBadge((await api('/api/time-off?status=pending')).length); } catch { /* try again later */ }
}

function initTimeClock() {
  $('#clockBtn').addEventListener('click', openMyTime);
  $('#tpPeriod').addEventListener('change', () => {
    $('#tpCustom').hidden = $('#tpPeriod').value !== 'custom';
    if ($('#tpPeriod').value === 'custom' && !$('#tpFrom').value && tc.range) [$('#tpFrom').value, $('#tpTo').value] = tc.range;
    loadTimePay().catch(fail);
  });
  for (const id of ['#tpFrom', '#tpTo']) $(id).addEventListener('change', () => loadTimePay().catch(fail));
  $('#tpAdd').addEventListener('click', () => { tc.adding = tc.adding ? false : true; renderTimePay(); });
  $('#tpSettingsBtn').addEventListener('click', () => { tc.settings = !tc.settings; renderTimePay(); });
  $('#tpExport').addEventListener('click', exportTimePay);
  loadClock().catch(() => {});
  loadTimeOffBadge();
  // Keep the running clock on the button current, and pick up a clock-out from another device.
  tc.tick = setInterval(renderClockPill, 30_000);
  setInterval(() => { loadClock().catch(() => {}); loadTimeOffBadge(); }, 5 * 60_000);
}
