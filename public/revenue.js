// Revenue page (admins): job amounts added up for today, this week, this month and year to date,
// with day / week / month breakdowns and totals per sales rep. Shares globals with app.js.

const rev = { basis: 'job', pipeline: '', breakdown: 'day', jobs: [], year: null };

// Weeks run Sunday to Saturday, like the shop calendar.
const weekStart = (d) => addDays(startOfDay(d), -new Date(d).getDay());
const monthStart = (d) => new Date(new Date(d).getFullYear(), new Date(d).getMonth(), 1);
const shortDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const monthName = (d) => d.toLocaleDateString([], { month: 'long' });

// The date a job counts on: its drop-off, or the day it was booked.
const countDate = (j) => new Date(rev.basis === 'booked' ? j.created_at : j.start_at);

async function loadRevenue() {
  const year = new Date().getFullYear();
  // A little before Jan 1 so the first week of the year is complete.
  const from = addDays(new Date(year, 0, 1), -7);
  const to = new Date(year + 1, 0, 8);
  rev.year = year;
  rev.jobs = await api(`/api/revenue?from=${from.toISOString()}&to=${to.toISOString()}`);
  renderRevenue();
  await Promise.all([loadSources(), loadOwed()]);
}

function countedJobs() {
  return rev.jobs.filter((j) => j.status !== 'cancelled' && (!rev.pipeline || j.pipeline === rev.pipeline));
}

function sum(jobs, from, to) {
  const inRange = jobs.filter((j) => { const t = countDate(j); return t >= from && t < to; });
  const priced = inRange.filter((j) => j.amount_cents != null);
  const total = priced.reduce((n, j) => n + j.amount_cents, 0);
  const now = new Date();
  return {
    jobs: inRange,
    count: inRange.length,
    total,
    avg: priced.length ? Math.round(total / priced.length) : null,
    missing: inRange.length - priced.length,
    ahead: priced.filter((j) => countDate(j) > now).reduce((n, j) => n + j.amount_cents, 0),
  };
}

function revTile(label, range, s, extra) {
  return h('section', { class: 'rev-tile' },
    h('h3', {}, label),
    h('div', { class: 'rev-range' }, range),
    h('div', { class: 'rev-total' }, money(s.total, { cents: false })),
    h('div', { class: 'rev-sub' }, `${s.count} job${s.count === 1 ? '' : 's'}`, s.avg != null && ` · avg ${money(s.avg, { cents: false })}`),
    s.ahead > 0 && h('div', { class: 'rev-sub' }, `${money(s.ahead, { cents: false })} still scheduled`),
    extra,
    s.missing > 0 && h('div', { class: 'rev-flag' }, `${s.missing} job${s.missing === 1 ? '' : 's'} without an amount`));
}

function renderRevenue() {
  const jobs = countedJobs();
  const now = new Date();
  const today = startOfDay(now);
  const week = weekStart(now);
  const month = monthStart(now);
  const yearStart = new Date(rev.year, 0, 1);

  $('#revBasisNote').textContent = rev.basis === 'booked'
    ? 'Counting each job on the day it was booked.'
    : 'Counting each job on its drop-off day.';

  const ytd = sum(jobs, yearStart, addDays(today, 1));
  const restOfYear = sum(jobs, addDays(today, 1), new Date(rev.year + 1, 0, 1));
  $('#revTiles').replaceChildren(
    revTile('Today', shortDay(today), sum(jobs, today, addDays(today, 1))),
    revTile('This week', `${shortDay(week)} – ${shortDay(addDays(week, 6))}`, sum(jobs, week, addDays(week, 7))),
    revTile('This month', `${monthName(month)} ${rev.year}`, sum(jobs, month, new Date(month.getFullYear(), month.getMonth() + 1, 1))),
    revTile('Year to date', `Jan 1 – ${shortDay(today)}`, ytd,
      restOfYear.total > 0 && h('div', { class: 'rev-sub' }, `+ ${money(restOfYear.total, { cents: false })} booked for later this year`)),
  );

  renderMissing(jobs);
  renderBreakdown(jobs);
  renderReps(ytd.jobs);
  document.querySelectorAll('#revBasis button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.basis === rev.basis)));
  document.querySelectorAll('#revBreak button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.break === rev.breakdown)));
}

// Jobs this year with no amount yet, so the totals are complete.
function renderMissing(jobs) {
  const yearStart = new Date(rev.year, 0, 1);
  const missing = jobs.filter((j) => j.amount_cents == null && countDate(j) >= yearStart && countDate(j) < new Date(rev.year + 1, 0, 1));
  if (!missing.length) { $('#revMissing').replaceChildren(); return; }
  $('#revMissing').replaceChildren(h('details', { class: 'rev-missing' },
    h('summary', {}, `${missing.length} job${missing.length === 1 ? ' has' : 's have'} no amount yet. Add ${missing.length === 1 ? 'it' : 'them'} so the totals are right.`),
    h('ul', {}, ...missing.map((j) => h('li', {},
      h('div', { class: 'rev-missing-who' },
        h('strong', {}, leadName(j)),
        h('span', { class: 'muted' }, ` · ${[j.vehicle_type, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ')} · ${shortDay(new Date(j.start_at))}`)),
      amountEditor(j, { editable: true, onSaved: () => renderRevenue() }))))));
}

function periods() {
  const now = new Date();
  if (rev.breakdown === 'day') {
    const first = monthStart(now);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return Array.from({ length: days }, (_, i) => {
      const d = addDays(first, i);
      return { label: shortDay(d), from: d, to: addDays(d, 1), current: sameDay(d, now) };
    });
  }
  if (rev.breakdown === 'week') {
    const out = [];
    for (let w = weekStart(new Date(rev.year, 0, 1)); w.getFullYear() <= rev.year; w = addDays(w, 7)) {
      if (w.getFullYear() === rev.year || addDays(w, 6).getFullYear() === rev.year) {
        out.push({ label: `${shortDay(w)} – ${shortDay(addDays(w, 6))}`, from: w, to: addDays(w, 7), current: now >= w && now < addDays(w, 7) });
      }
    }
    return out;
  }
  return Array.from({ length: 12 }, (_, m) => {
    const d = new Date(rev.year, m, 1);
    return { label: monthName(d), from: d, to: new Date(rev.year, m + 1, 1), current: m === now.getMonth() };
  });
}

function renderBreakdown(jobs) {
  const rows = periods().map((p) => ({ ...p, ...sum(jobs, p.from, p.to) }));
  const total = rows.reduce((n, r) => n + r.total, 0);
  const count = rows.reduce((n, r) => n + r.count, 0);
  const title = { day: `Each day in ${monthName(new Date())}`, week: `Each week of ${rev.year}`, month: `Each month of ${rev.year}` }[rev.breakdown];
  $('#revTable').replaceChildren(
    h('caption', {}, title),
    h('thead', {}, h('tr', {}, h('th', {}, rev.breakdown === 'day' ? 'Day' : rev.breakdown === 'week' ? 'Week' : 'Month'),
      h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Avg job'))),
    h('tbody', {}, ...rows.map((r) => h('tr', { class: [r.current && 'current', !r.count && 'empty'].filter(Boolean).join(' ') },
      h('td', {}, r.label, r.current && h('span', { class: 'rev-now' }, rev.breakdown === 'day' ? 'Today' : 'Now')),
      h('td', { class: 'num' }, r.count || '–'),
      h('td', { class: 'num' }, r.count ? money(r.total, { cents: false }) : '–', r.missing > 0 && h('span', { class: 'rev-flag-inline', title: `${r.missing} without an amount` }, ` +${r.missing}?`)),
      h('td', { class: 'num' }, r.avg != null ? money(r.avg, { cents: false }) : '–')))),
    h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'num' }, count), h('th', { class: 'num' }, money(total, { cents: false })), h('th', {}))));
}

function renderReps(jobs) {
  const byRep = new Map();
  for (const j of jobs) {
    const rep = j.created_by || 'Not recorded';
    const r = byRep.get(rep) || { count: 0, total: 0 };
    r.count += 1;
    r.total += j.amount_cents || 0;
    byRep.set(rep, r);
  }
  const rows = [...byRep.entries()].sort((a, b) => b[1].total - a[1].total);
  $('#revReps').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Booked by'), h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num' }, 'Revenue'))),
    h('tbody', {}, ...(rows.length
      ? rows.map(([rep, r]) => h('tr', {}, h('td', {}, rep), h('td', { class: 'num' }, r.count), h('td', { class: 'num' }, money(r.total, { cents: false }))))
      : [h('tr', {}, h('td', { colspan: 3, class: 'muted' }, 'No jobs booked yet this year.'))])));
}

// ---------- Where leads come from ----------
const SOURCE_NAMES = { facebook: 'Facebook', website: 'Website', manual: 'Phone / walk-in', text: 'Text message', import: 'Imported', call: 'Missed call', referral: 'Referrals & partners', google: 'Google Local Services', online: 'Online booking', other: 'Other ads' };
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function sourceRange() {
  const now = new Date();
  const period = $('#srcPeriod').value;
  if (period === 'month') return [monthStart(now), addDays(startOfDay(now), 1)];
  if (period === '90') return [addDays(startOfDay(now), -89), addDays(startOfDay(now), 1)];
  return [new Date(now.getFullYear(), 0, 1), addDays(startOfDay(now), 1)];
}

async function loadSources() {
  const [from, to] = sourceRange();
  const [rows, spend] = await Promise.all([
    api(`/api/reports/sources?from=${from.toISOString()}&to=${to.toISOString()}`),
    api(`/api/ad-spend?from=${monthKey(from)}&to=${monthKey(addDays(to, -1))}`),
  ]);
  const pick = rows.filter((r) => !rev.pipeline || r.pipeline === rev.pipeline);
  // Ad spend for the months the period touches, by source (not split by pipeline).
  const spent = new Map();
  for (const s of spend.rows) spent.set(SOURCE_NAMES[s.source] || s.source, (spent.get(SOURCE_NAMES[s.source] || s.source) || 0) + s.cents);
  renderSourceTable($('#srcBySource'), 'Lead source', pick, (r) => SOURCE_NAMES[r.source] || r.source, spent);
  renderSourceTable($('#srcByHeard'), 'How they heard about us', pick, (r) => r.heard_about || 'Not asked');
}

// Columns for spend: what was spent, cost per lead and per booking, and revenue per dollar.
function spendCells(g) {
  if (!g.spend) return [h('td', { class: 'num muted' }, ''), h('td', { class: 'num' }, ''), h('td', { class: 'num' }, ''), h('td', { class: 'num' }, '')];
  return [
    h('td', { class: 'num' }, money(g.spend, { cents: false })),
    h('td', { class: 'num' }, g.leads ? money(Math.round(g.spend / g.leads), { cents: false }) : '–'),
    h('td', { class: 'num' }, g.booked ? money(Math.round(g.spend / g.booked), { cents: false }) : '–'),
    h('td', { class: `num ${g.revenue >= g.spend ? 'good' : 'bad'}` }, `${(g.revenue / g.spend).toFixed(1)}×`),
  ];
}

function renderSourceTable(table, title, rows, keyOf, spent = null) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k) || { leads: 0, booked: 0, revenue: 0 };
    g.leads += 1;
    if (r.booked) g.booked += 1;
    g.revenue += r.revenue_cents || 0;
    groups.set(k, g);
  }
  if (spent) {
    for (const [k, cents] of spent) {
      const g = groups.get(k) || { leads: 0, booked: 0, revenue: 0 };
      g.spend = cents;
      groups.set(k, g);
    }
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].revenue - a[1].revenue || b[1].leads - a[1].leads);
  const pct = (g) => (g.leads ? `${Math.round((g.booked / g.leads) * 100)}%` : '–');
  const all = sorted.reduce((t, [, g]) => ({ leads: t.leads + g.leads, booked: t.booked + g.booked, revenue: t.revenue + g.revenue, spend: t.spend + (g.spend || 0) }), { leads: 0, booked: 0, revenue: 0, spend: 0 });
  const withSpend = spent && all.spend > 0;
  table.parentElement.classList.toggle('full', Boolean(withSpend)); // the wider table takes the whole row
  const spendHead = withSpend ? ['Ad spend', 'Cost per lead', 'Cost per booking', 'Return'].map((t) => h('th', { class: 'num' }, t)) : [];
  table.replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, title), h('th', { class: 'num' }, 'Leads'), h('th', { class: 'num' }, 'Booked'),
      h('th', { class: 'num' }, 'Booking rate'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Revenue per lead'), ...spendHead)),
    h('tbody', {}, ...(sorted.length ? sorted.map(([k, g]) => h('tr', {},
      h('td', {}, k), h('td', { class: 'num' }, g.leads), h('td', { class: 'num' }, g.booked), h('td', { class: 'num' }, pct(g)),
      h('td', { class: 'num' }, money(g.revenue, { cents: false })), h('td', { class: 'num' }, g.leads ? money(Math.round(g.revenue / g.leads), { cents: false }) : '–'),
      ...(withSpend ? spendCells(g) : [])))
      : [h('tr', {}, h('td', { colspan: withSpend ? 10 : 6, class: 'muted' }, 'No leads came in during this period.'))])),
    h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'num' }, all.leads), h('th', { class: 'num' }, all.booked),
      h('th', { class: 'num' }, pct(all)), h('th', { class: 'num' }, money(all.revenue, { cents: false })),
      h('th', { class: 'num' }, all.leads ? money(Math.round(all.revenue / all.leads), { cents: false }) : '–'),
      ...(withSpend ? spendCells(all).map((c) => h('th', { class: c.className }, c.textContent)) : []))));
}

// ---------- ad spend (admins) ----------
async function openSpend() {
  const f = $('#spendForm');
  f.hidden = !f.hidden;
  if (f.hidden) return;
  const now = new Date();
  const months = Array.from({ length: 12 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - i, 1));
  f.month.replaceChildren(...months.map((m) => h('option', { value: monthKey(m) }, m.toLocaleDateString([], { month: 'long', year: 'numeric' }))));
  await fillSpend();
}

async function fillSpend() {
  const f = $('#spendForm');
  try {
    const { sources, rows } = await api(`/api/ad-spend?from=${f.month.value}&to=${f.month.value}`);
    $('#spendInputs').replaceChildren(...sources.map((s) => {
      const row = rows.find((r) => r.source === s);
      return h('label', {}, SOURCE_NAMES[s] || s, h('input', { name: `spend_${s}`, 'data-source': s, inputmode: 'decimal', placeholder: '$0', value: row ? (row.cents / 100).toFixed(2) : '' }));
    }));
  } catch (err) { fail(err); }
}

async function saveSpend(e) {
  e.preventDefault();
  const f = e.target;
  try {
    for (const input of f.querySelectorAll('[data-source]')) {
      await api('/api/ad-spend', { method: 'PUT', body: { month: f.month.value, source: input.dataset.source, amount: input.value } });
    }
    toast('Ad spend saved');
    await loadSources();
  } catch (err) { fail(err); }
}

// Balances left on finished jobs: who still owes, with a way to record the payment.
async function loadOwed() {
  const jobs = await api('/api/payments/owed');
  $('#revOwed').hidden = !jobs.length;
  if (!jobs.length) return;
  $('#revOwedTotal').textContent = `${money(jobs.reduce((n, j) => n + j.amount_due_cents, 0))} across ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
  const name = (j) => j.full_name || [j.first_name, j.last_name].filter(Boolean).join(' ') || j.phone || 'Customer';
  $('#revOwedTable').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Customer', 'Vehicle', 'Status', 'Pick-up', 'Job', 'Paid', 'Still owed', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...jobs.map((j) => h('tr', {},
      h('td', {}, name(j)),
      h('td', {}, [j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || j.vehicle_type || ''),
      h('td', {}, h('span', { class: `job-status status-${j.status}` }, state.meta.jobStatuses.find((s) => s.id === j.status)?.label || j.status)),
      h('td', {}, shortDate(j.end_at)),
      h('td', { class: 'num' }, money(j.amount_cents)),
      h('td', { class: 'num' }, money(j.amount_paid_cents)),
      h('td', { class: 'num owed' }, money(j.amount_due_cents)),
      h('td', {}, h('button', { type: 'button', onclick: () => openLead(j.lead_id) }, 'Open'))))));
}

function initRevenue() {
  initCardImport();
  $('#spendBtn').addEventListener('click', () => openSpend().catch(fail));
  $('#spendForm').month.addEventListener('change', fillSpend);
  $('#spendForm').addEventListener('submit', saveSpend);
  $('#srcPeriod').addEventListener('change', () => loadSources().catch(fail));
  $('#revBasis').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { rev.basis = b.dataset.basis; renderRevenue(); }
  });
  $('#revBreak').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { rev.breakdown = b.dataset.break; renderRevenue(); }
  });
  $('#revPipeline').addEventListener('change', (e) => { rev.pipeline = e.target.value; renderRevenue(); loadSources().catch(fail); });
}

initRevenue();

// ---------- card payments from Talech / Elavon (admins) ----------
const cardIn = { data: null };
const CARD_STATUS = { matched: ['Matched', 'good'], suggested: ['Check this', 'check'], unmatched: ['No match', 'none'], recorded: ['Already recorded', 'done'] };

async function uploadCardExport(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const box = $('#cardImportResult');
  box.hidden = false;
  fill(box, h('p', { class: 'muted' }, `Reading ${file.name}…`));
  try {
    const res = await fetch(`/api/card-import/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Couldn\'t read that file.');
    cardIn.data = data;
    renderCardImport();
  } catch (err) { fill(box, h('p', { class: 'error-text' }, err.message)); }
}

async function recheckCardImport() {
  try {
    const d = cardIn.data;
    cardIn.data = { ...d, ...await api('/api/card-import/check', { method: 'POST', body: { token: d.token, columns: d.columns } }) };
    renderCardImport();
  } catch (err) { fail(err); }
}

function renderCardImport() {
  const d = cardIn.data;
  const s = d.summary;
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
  const picker = (r) => {
    if (r.status === 'recorded') return h('span', { class: 'muted' }, 'Already on a job');
    const listed = new Set(r.options.map((o) => o.job_id));
    const rest = r.kind === 'payment' ? d.open.filter((o) => !listed.has(o.job_id)) : [];
    return h('select', { 'data-ref': r.ref, 'aria-label': `Job for ${money(r.cents)} on ${when(r.at)}` },
      h('option', { value: '' }, 'Don\'t record'),
      r.options.length > 0 && h('optgroup', { label: 'Best matches' }, ...r.options.map((o) => h('option', { value: o.job_id, selected: o.job_id === r.job_id }, `${o.label}${o.why.length ? ` (matches ${o.why.join(', ')})` : ''}`))),
      rest.length > 0 && h('optgroup', { label: 'Other jobs with money due' }, ...rest.map((o) => h('option', { value: o.job_id }, o.label))));
  };
  const skipped = Object.entries({ declined: 'declined or voided', not_card: 'cash or other tenders', unreadable: 'rows without an amount' })
    .filter(([k]) => d.skipped[k]).map(([k, label]) => `${d.skipped[k]} ${label}`).join(', ');
  fill($('#cardImportResult'),
    h('div', { class: 'card-import-summary' },
      h('strong', {}, `${s.total} card payment${s.total === 1 ? '' : 's'} in ${d.file}`),
      h('span', { class: 'ci-chip good' }, `${s.matched} matched`),
      s.suggested > 0 && h('span', { class: 'ci-chip check' }, `${s.suggested} to check`),
      s.unmatched > 0 && h('span', { class: 'ci-chip none' }, `${s.unmatched} no match`),
      s.recorded > 0 && h('span', { class: 'ci-chip done' }, `${s.recorded} already recorded`)),
    skipped && h('p', { class: 'muted' }, `Left out: ${skipped}.`),
    h('details', { class: 'ci-columns' }, h('summary', {}, 'Columns read from the file'),
      h('div', { class: 'ci-col-grid' }, ...d.fields.map((f) => h('label', {}, f.label,
        h('select', { onchange: (e) => { if (e.target.value === '') delete d.columns[f.key]; else d.columns[f.key] = Number(e.target.value); recheckCardImport(); } },
          h('option', { value: '' }, '(none)'),
          ...d.headers.map((hd, i) => h('option', { value: i, selected: d.columns[f.key] === i }, hd || `Column ${i + 1}`))))))),
    h('div', { class: 'table-scroll' }, h('table', { class: 'matrix ci-table' },
      h('thead', {}, h('tr', {}, ...['When', 'Amount', 'Card', 'Cardholder', 'Match', 'Record on job'].map((t, i) => h('th', { class: i === 1 ? 'num' : null }, t)))),
      h('tbody', {}, ...d.rows.map((r) => h('tr', { class: `ci-${r.status}` },
        h('td', {}, when(r.at)),
        h('td', { class: 'num' }, `${r.kind === 'refund' ? '−' : ''}${money(r.cents)}`, r.kind === 'refund' && h('small', { class: 'muted' }, ' refund')),
        h('td', {}, r.last4 ? `…${r.last4}` : '–'),
        h('td', {}, r.name || '–'),
        h('td', {}, h('span', { class: `ci-chip ${CARD_STATUS[r.status][1]}` }, CARD_STATUS[r.status][0])),
        h('td', { class: 'ci-pick' }, picker(r))))))),
    h('div', { class: 'ci-actions' },
      h('button', { type: 'button', class: 'primary', onclick: recordCardImport }, 'Record the payments picked'),
      h('span', { class: 'muted' }, `Recorded as card payments on each job, dated when the card was run.${d.columns.tip != null && /total|grand/i.test(d.headers[d.columns.amount] || '') ? ' Tips are taken off the totals.' : ''}`)));
}

async function recordCardImport() {
  const d = cardIn.data;
  const picks = [...document.querySelectorAll('#cardImportResult select[data-ref]')].filter((s) => s.value).map((s) => ({ ref: s.dataset.ref, job_id: Number(s.value) }));
  if (!picks.length) return toast('Pick a job for at least one payment.', 'error');
  try {
    const r = await api('/api/card-import/commit', { method: 'POST', body: { token: d.token, columns: d.columns, picks } });
    toast(`${r.recorded} card payment${r.recorded === 1 ? '' : 's'} recorded (${money(r.cents)})`);
    cardIn.data = null;
    fill($('#cardImportResult'), h('p', {}, `Done: ${r.recorded} payment${r.recorded === 1 ? '' : 's'} recorded on their jobs. Balances, Still owed and Analytics are updated.`));
    loadRevenue().catch(() => {});
  } catch (err) { fail(err); }
}

function initCardImport() {
  $('#cardImportBtn').addEventListener('click', () => {
    if (!cardIn.data) $('#cardImportResult').hidden = true;
    showPanel($('#cardImportPanel'));
  });
  $('#cardImportFile').addEventListener('change', uploadCardExport);
}
