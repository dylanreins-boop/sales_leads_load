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
  await loadSources();
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
const SOURCE_NAMES = { facebook: 'Facebook', website: 'Website', manual: 'Phone / walk-in' };

function sourceRange() {
  const now = new Date();
  const period = $('#srcPeriod').value;
  if (period === 'month') return [monthStart(now), addDays(startOfDay(now), 1)];
  if (period === '90') return [addDays(startOfDay(now), -89), addDays(startOfDay(now), 1)];
  return [new Date(now.getFullYear(), 0, 1), addDays(startOfDay(now), 1)];
}

async function loadSources() {
  const [from, to] = sourceRange();
  const rows = await api(`/api/reports/sources?from=${from.toISOString()}&to=${to.toISOString()}`);
  const pick = rows.filter((r) => !rev.pipeline || r.pipeline === rev.pipeline);
  renderSourceTable($('#srcBySource'), 'Lead source', pick, (r) => SOURCE_NAMES[r.source] || r.source);
  renderSourceTable($('#srcByHeard'), 'How they heard about us', pick, (r) => r.heard_about || 'Not asked');
}

function renderSourceTable(table, title, rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k) || { leads: 0, booked: 0, revenue: 0 };
    g.leads += 1;
    if (r.booked) g.booked += 1;
    g.revenue += r.revenue_cents || 0;
    groups.set(k, g);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].revenue - a[1].revenue || b[1].leads - a[1].leads);
  const pct = (g) => (g.leads ? `${Math.round((g.booked / g.leads) * 100)}%` : '–');
  const all = sorted.reduce((t, [, g]) => ({ leads: t.leads + g.leads, booked: t.booked + g.booked, revenue: t.revenue + g.revenue }), { leads: 0, booked: 0, revenue: 0 });
  table.replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, title), h('th', { class: 'num' }, 'Leads'), h('th', { class: 'num' }, 'Booked'),
      h('th', { class: 'num' }, 'Booking rate'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Per lead'))),
    h('tbody', {}, ...(sorted.length ? sorted.map(([k, g]) => h('tr', {},
      h('td', {}, k), h('td', { class: 'num' }, g.leads), h('td', { class: 'num' }, g.booked), h('td', { class: 'num' }, pct(g)),
      h('td', { class: 'num' }, money(g.revenue, { cents: false })), h('td', { class: 'num' }, money(Math.round(g.revenue / g.leads), { cents: false }))))
      : [h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No leads came in during this period.'))])),
    h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'num' }, all.leads), h('th', { class: 'num' }, all.booked),
      h('th', { class: 'num' }, pct(all)), h('th', { class: 'num' }, money(all.revenue, { cents: false })),
      h('th', { class: 'num' }, all.leads ? money(Math.round(all.revenue / all.leads), { cents: false }) : '–'))));
}

function initRevenue() {
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
