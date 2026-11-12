'use strict';
// Sold (left menu): every lead that's already sold (Booked), on the board or in Past Customers, imported
// ones too. Cards for the period, then a table that sorts by any column, with filters. Tap a row to open
// the lead. Admins see everyone's sales; sales logins see the ones they sold.
// Uses the helpers from app.js ($, h, fill, api, fail, money, leadName, stageLabel, sourceLabel, cardClick,
// serviceLabels, shortDate).

const sold = {
  data: null,
  filters: { q: '', period: 'year', rep: '', job: '', source: '' },
  sort: { key: 'sold_at', dir: 'desc' },
  show: 200,
};
const SOLD_PERIODS = { month: 'This month', last_month: 'Last month', quarter: 'Last 3 months', year: 'This year', last_year: 'Last year', all: 'All time' };
const JOB_STATUS = { scheduled: 'Scheduled', in_shop: 'In the shop', ready: 'Ready for pickup', picked_up: 'Picked up', none: 'No job on file' };

function soldRange(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const r = {
    month: [new Date(y, m, 1), new Date(y, m + 1, 1)],
    last_month: [new Date(y, m - 1, 1), new Date(y, m, 1)],
    quarter: [new Date(y, m - 2, 1), new Date(y, m + 1, 1)],
    year: [new Date(y, 0, 1), new Date(y + 1, 0, 1)],
    last_year: [new Date(y - 1, 0, 1), new Date(y, 0, 1)],
  }[period];
  return r || [new Date(0), new Date(8640000000000000)];
}
const soldVehicle = (l) => [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ');
const soldJob = (l) => (l.job_status ? l.job_status : 'none');

const SOLD_COLUMNS = [
  { key: 'name', label: 'Customer', get: (l) => leadName(l).toLowerCase() },
  { key: 'vehicle', label: 'Vehicle', get: (l) => soldVehicle(l).toLowerCase() },
  { key: 'services', label: 'Services', get: (l) => serviceLabels(l.booked_services || []).toLowerCase() },
  { key: 'sold_at', label: 'Sold', get: (l) => l.sold_at || '' },
  { key: 'sold_by', label: 'Sold by', get: (l) => (l.sold_by || '').toLowerCase(), admin: true },
  { key: 'job_start', label: 'Job date', get: (l) => l.job_start || '' },
  { key: 'job_status', label: 'Job', get: (l) => ['scheduled', 'in_shop', 'ready', 'picked_up', 'none'].indexOf(soldJob(l)) },
  { key: 'amount_cents', label: 'Amount', get: (l) => (l.amount_cents == null ? '' : l.amount_cents), num: true },
  { key: 'source', label: 'Lead type', get: (l) => (sourceLabel[l.source] || l.source || '').toLowerCase() },
];

async function loadSold() {
  const body = $('#soldBody');
  if (!sold.data) fill(body, h('div', { class: 'ov-skeleton' }, ...[1, 2, 3, 4].map(() => h('div', { class: 'ov-card sk' }))));
  sold.data = await api('/api/sold');
  try { Object.assign(sold.sort, JSON.parse(localStorage.getItem('soldSort') || '{}')); } catch { /* storage unavailable */ }
  renderSold();
}

function soldRows() {
  const f = sold.filters;
  const [from, to] = soldRange(f.period);
  const q = f.q.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const col = SOLD_COLUMNS.find((c) => c.key === sold.sort.key) || SOLD_COLUMNS[3];
  const dir = sold.sort.dir === 'asc' ? 1 : -1;
  return sold.data.leads
    .filter((l) => { const t = new Date(l.sold_at); return t >= from && t < to; })
    .filter((l) => !f.rep || (f.rep === '-' ? !l.sold_by : l.sold_by === f.rep))
    .filter((l) => !f.job || soldJob(l) === f.job)
    .filter((l) => !f.source || l.source === f.source)
    .filter((l) => !q || [leadName(l), l.email, soldVehicle(l), serviceLabels(l.booked_services || [])].some((v) => String(v || '').toLowerCase().includes(q))
      || (digits.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(digits)))
    .sort((a, b) => {
      const x = col.get(a);
      const y = col.get(b);
      if ((x === '' || x == null) !== (y === '' || y == null)) return x === '' || x == null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || String(b.sold_at).localeCompare(String(a.sold_at));
    });
}

function renderSold() {
  const d = sold.data;
  const f = sold.filters;
  const admin = !d.mine_only;
  const rows = soldRows();
  const total = rows.reduce((n, l) => n + (l.amount_cents || 0), 0);
  const priced = rows.filter((l) => l.amount_cents);
  const upcoming = rows.filter((l) => ['scheduled', 'in_shop', 'ready'].includes(l.job_status));
  const done = rows.filter((l) => l.job_status === 'picked_up');

  const select = (key, label, options) => h('label', {}, label, h('select', { onchange: (e) => { sold.filters[key] = e.target.value; sold.show = 200; renderSold(); } },
    ...options.map(([v, t]) => h('option', { value: v, selected: f[key] === v }, t))));
  const reps = [...new Set(d.leads.map((l) => l.sold_by).filter(Boolean))].sort();
  const sources = [...new Set(d.leads.map((l) => l.source))];
  const search = h('input', { type: 'search', value: f.q, placeholder: 'Name, phone, vehicle or service', autocomplete: 'off' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sold.filters.q = search.value;
      sold.show = 200;
      renderSold();
      // The page was redrawn: keep typing in the new box.
      const box = $('#soldBody input[type=search]');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 250);
  });

  const cols = SOLD_COLUMNS.filter((c) => admin || !c.admin);
  const shown = rows.slice(0, sold.show);
  const card = (label, value, sub, st) => h('div', { class: `ov-card cal-stat ${st}` },
    h('span', { class: 'cal-stat-label' }, label), h('b', { class: 'cal-stat-value' }, value), h('span', { class: 'cal-stat-sub' }, sub));
  const period = SOLD_PERIODS[f.period].toLowerCase();

  fill($('#soldBody'),
    h('div', { class: 'ov-head' },
      h('div', {},
        h('h1', {}, admin ? 'Sold' : 'My sales'),
        h('p', {}, admin ? 'Every lead that\'s already sold: on the board, in Past Customers or brought in already sold. Tap a column to sort, tap a row to open it.'
          : 'The leads you sold. Tap a column to sort, tap a row to open it.')),
      h('div', { class: 'seg sold-periods', role: 'group', 'aria-label': 'Period' }, ...Object.entries(SOLD_PERIODS).map(([k, label]) => h('button', {
        type: 'button', 'aria-pressed': String(f.period === k), onclick: () => { sold.filters.period = k; sold.show = 200; renderSold(); },
      }, label)))),
    h('div', { class: 'lp-stats sold-stats' },
      card('Sold', String(rows.length), `${period}${rows.filter((l) => l.imported).length ? ` · ${rows.filter((l) => l.imported).length} imported` : ''}`, 'st-open'),
      card('Sales', money(total, { cents: false }), priced.length < rows.length ? `${rows.length - priced.length} without a price on file` : 'Job prices', 'st-value'),
      card('Average sale', priced.length ? money(Math.round(total / priced.length), { cents: false }) : '–', `${priced.length} priced job${priced.length === 1 ? '' : 's'}`, 'st-due'),
      card('Still to do', String(upcoming.length), `${done.length} picked up`, 'st-hot')),
    h('div', { class: 'old-filters imp-filters sold-filters' },
      h('label', { class: 'imp-search' }, 'Search', search),
      admin && select('rep', 'Sold by', [['', 'Everyone'], ...reps.map((r) => [r, r]), ['-', 'Not recorded']]),
      select('job', 'Job', [['', 'Any'], ...Object.entries(JOB_STATUS)]),
      select('source', 'Lead type', [['', 'All lead types'], ...sources.map((s) => [s, sourceLabel[s] || s])])),
    h('div', { class: 'table-scroll' }, h('table', { class: 'old-table sold-table' },
      h('thead', {}, h('tr', {}, ...cols.map((c) => {
        const on = sold.sort.key === c.key;
        return h('th', { class: c.num ? 'num' : '', 'aria-sort': on ? (sold.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
          h('button', { type: 'button', class: `imp-sort ${on ? 'on' : ''}`, onclick: () => sortSold(c.key) },
            c.label, h('span', { class: 'imp-arrow', 'aria-hidden': 'true' }, on ? (sold.sort.dir === 'asc' ? '▲' : '▼') : '↕')));
      }))),
      h('tbody', {}, ...(shown.length ? shown.map((l) => h('tr', { title: 'Click to open. Double-click to open full screen.', onclick: (e) => cardClick(l.id, e) },
        h('td', {}, h('strong', {}, leadName(l)), l.phone && h('div', { class: 'muted sold-sub' }, l.phone)),
        h('td', {}, soldVehicle(l) || l.vehicle_type || ''),
        h('td', { class: 'sold-services' }, serviceLabels(l.booked_services || []) || h('span', { class: 'muted' }, '–')),
        h('td', {}, shortDate(l.sold_at), l.imported && h('div', { class: 'muted sold-sub' }, 'Imported')),
        admin && h('td', {}, l.sold_by || h('span', { class: 'muted' }, '–')),
        h('td', {}, l.job_start ? shortDate(l.job_start) : h('span', { class: 'muted' }, '–')),
        h('td', {}, h('span', { class: `sold-job ${soldJob(l)}` }, JOB_STATUS[soldJob(l)])),
        h('td', { class: 'num' }, l.amount_cents != null ? money(l.amount_cents, { cents: false }) : h('span', { class: 'muted' }, '–')),
        h('td', {}, sourceLabel[l.source] || l.source || '')))
        : [h('tr', {}, h('td', { colspan: cols.length, class: 'muted' }, d.leads.length ? `Nothing sold ${period} matches these filters.` : 'Nothing sold yet. Leads show up here once they\'re booked.'))])))),
    rows.length > shown.length && h('div', { class: 'imp-more' }, h('button', { type: 'button', onclick: () => { sold.show += 200; renderSold(); } }, `Show more (${rows.length - shown.length} more)`)));
}

function sortSold(key) {
  if (sold.sort.key === key) sold.sort.dir = sold.sort.dir === 'asc' ? 'desc' : 'asc';
  else Object.assign(sold.sort, { key, dir: ['sold_at', 'job_start', 'amount_cents'].includes(key) ? 'desc' : 'asc' });
  try { localStorage.setItem('soldSort', JSON.stringify(sold.sort)); } catch { /* storage unavailable */ }
  renderSold();
}
