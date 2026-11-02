'use strict';
// Analytics (admins): every number the app tracks, for one date range, compared with the period before.
// Uses $, h, fill, api, money, fail from app.js.

const an = { data: null, resizeTimer: null };
const AN_SOURCES = { facebook: 'Facebook', website: 'Website', manual: 'Phone / walk-in', text: 'Text message', import: 'Imported', call: 'Missed call', referral: 'Referrals & partners', google: 'Google Local Services', online: 'Online booking', other: 'Other ads' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- formatting ----------
const anMoney = (cents) => (cents == null ? '–' : money(cents, { cents: false }));
const anPct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);
const anNum = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
function anMinutes(m) {
  if (m == null) return '–';
  if (m < 1) return 'under a minute';
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} hr`;
  return `${Math.round(m / 1440)} days`;
}
// Axis ticks: in full under 10,000, compact above.
function anCompact(v, dollars) {
  const pre = dollars ? '$' : '';
  if (Math.abs(v) >= 1e6) return `${pre}${+(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${pre}${+(v / 1e3).toFixed(0)}K`;
  return `${pre}${Math.round(v).toLocaleString('en-US')}`;
}
const anDate = (d, opts) => new Date(d).toLocaleDateString([], opts);

// ---------- the period ----------
function anRange() {
  const v = $('#anPeriod').value;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  if (v === 'custom') {
    const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
    if (!$('#anFrom').value || !$('#anTo').value) return null;
    const to = parse($('#anTo').value); to.setDate(to.getDate() + 1);
    return [parse($('#anFrom').value), to];
  }
  if (v === 'month') return [new Date(today.getFullYear(), today.getMonth(), 1), tomorrow];
  if (v === 'lastmonth') return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 1)];
  if (v === 'ytd') return [new Date(today.getFullYear(), 0, 1), tomorrow];
  if (v === '12m') return [new Date(today.getFullYear(), today.getMonth() - 11, 1), tomorrow];
  return [back(Number(v) - 1), tomorrow];
}

async function loadAnalytics() {
  const range = anRange();
  if (!range) return;
  const [from, to] = range;
  const body = $('#anBody');
  body.classList.add('loading'); // keep the last picture on screen while the new one loads
  try {
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if ($('#anPipeline').value) q.set('pipeline', $('#anPipeline').value);
    an.data = await api(`/api/analytics?${q}`);
    const last = new Date(to - 1);
    const pf = new Date(an.data.range.prev_from);
    const pt = new Date(new Date(an.data.range.prev_to) - 1);
    $('#anRange').textContent = `${anDate(from, { month: 'short', day: 'numeric', year: 'numeric' })} to ${anDate(last, { month: 'short', day: 'numeric', year: 'numeric' })}. `
      + `Changes compare with ${anDate(pf, { month: 'short', day: 'numeric' })} to ${anDate(pt, { month: 'short', day: 'numeric', year: 'numeric' })}.`;
    renderAnalytics(an.data);
  } finally {
    body.classList.remove('loading');
  }
}

// ---------- pieces ----------
const group = (title, note, ...kids) => h('section', { class: 'an-group' }, h('h3', {}, title), note && h('p', { class: 'muted an-note' }, note), ...kids);
const card = (title, sub, ...kids) => h('div', { class: 'an-card' }, h('h4', {}, title), sub && h('p', { class: 'an-sub' }, sub), ...kids);

// A stat tile; `delta` compares with the period before (`better` says which way is good).
function tile(label, value, { sub, now, before, better = 'up', points = false } = {}) {
  let delta = null;
  if (points && now != null && before != null) {
    // A rate changes by percentage points, not by a percent of itself.
    const pts = Math.round((now - before) * 100);
    const good = pts === 0 ? '' : ((pts > 0) === (better === 'up') ? 'good' : 'bad');
    delta = h('span', { class: `delta ${good}` }, pts === 0 ? 'Same as before' : `${pts > 0 ? '▲' : '▼'} ${Math.abs(pts)} points vs before (${anPct(before)})`);
  } else if (now != null && before != null) {
    if (before === 0 && now === 0) delta = h('span', { class: 'delta' }, 'Same as before');
    else if (before === 0) delta = h('span', { class: 'delta' }, 'None in the period before');
    else {
      const change = (now - before) / Math.abs(before);
      const pct = Math.round(Math.abs(change) * 100);
      const up = change > 0;
      const good = pct === 0 ? '' : (up === (better === 'up') ? 'good' : 'bad');
      delta = h('span', { class: `delta ${good}` }, pct === 0 ? 'Same as before' : `${up ? '▲' : '▼'} ${pct}% vs before`);
    }
  }
  return h('div', { class: 'an-tile' }, h('span', { class: 'lbl' }, label), h('span', { class: 'val' }, value), sub && h('span', { class: 'sub' }, sub), delta);
}

function table(headers, rows, { foot } = {}) {
  const cell = (tag, v, i) => h(tag, { class: i > 0 && headers[i]?.num !== false ? 'num' : null }, v);
  return h('div', { class: 'table-scroll' }, h('table', { class: 'matrix' },
    h('thead', {}, h('tr', {}, ...headers.map((x, i) => cell('th', x.label ?? x, i)))),
    h('tbody', {}, ...(rows.length ? rows.map((r) => h('tr', {}, ...r.map((v, i) => cell('td', v, i))))
      : [h('tr', {}, h('td', { colspan: headers.length, class: 'muted' }, 'Nothing in this period.'))])),
    foot && h('tfoot', {}, h('tr', {}, ...foot.map((v, i) => cell('th', v, i))))));
}

// The numbers behind a chart, for anyone who'd rather read a table.
const asTable = (headers, rows) => h('details', {}, h('summary', {}, 'Show as a table'), table(headers, rows));

// Horizontal bars for one measure; the value sits at the bar's tip.
function hbars(rows, { fmt = anNum, of } = {}) {
  if (!rows.length) return h('p', { class: 'an-empty' }, 'Nothing in this period.');
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h('div', { class: 'an-bars' }, ...rows.map((r) => h('div', { class: 'an-bar' },
    h('span', { class: 'name', title: r.label }, r.label),
    h('span', { class: 'track' },
      h('span', { class: 'fill', style: `width: calc((100% - 96px) * ${(r.value / max).toFixed(4)})` }),
      h('span', { class: 'amt' }, fmt(r.value), of ? h('small', {}, ` · ${anPct(r.value / of)}`) : null)))));
}

// ---------- SVG charts ----------
const SVG = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
function niceMax(v) {
  if (v <= 0) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag * 4 >= v) * mag;
  return step * 4;
}
function bucketLabel(key, unit, short) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (unit === 'month') return anDate(date, { month: 'short', ...(short ? {} : { year: 'numeric' }) });
  if (unit === 'week') return short ? anDate(date, { month: 'short', day: 'numeric' }) : `Week of ${anDate(date, { month: 'short', day: 'numeric' })}`;
  return anDate(date, short ? { month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

// A chart over time. type 'line' (2px lines, crosshair) or 'columns' (grouped, 2px gaps).
function timeChart(host, { rows, unit, series, type, dollars }) {
  const W = Math.max(280, host.clientWidth || 600);
  const H = 220;
  const pad = { l: 46, r: 12, t: 10, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...rows.flatMap((r) => series.map((x) => x.value(r)))));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const n = rows.length;
  const slot = iw / Math.max(n, 1);
  const cx = (i) => pad.l + slot * i + slot / 2;
  const svg = s('svg', { class: 'an-chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': series.map((x) => x.name).join(' and ') });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.append(s('line', { class: k ? 'grid' : 'base', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    svg.append(s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, anCompact(dollars ? v / 100 : v, dollars)));
  }
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 64)));
  rows.forEach((r, i) => { if (i % every === 0) svg.append(s('text', { x: cx(i), y: H - 8, 'text-anchor': 'middle' }, bucketLabel(r.key, unit, true))); });

  if (type === 'line') {
    for (const x of series) {
      const pts = rows.map((r, i) => `${cx(i)},${y(x.value(r))}`).join(' ');
      svg.append(s('polyline', { points: pts, fill: 'none', stroke: x.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (slot >= 16) rows.forEach((r, i) => svg.append(s('circle', { cx: cx(i), cy: y(x.value(r)), r: 4, fill: x.color, style: 'stroke: var(--panel)', 'stroke-width': 2 })));
    }
  } else {
    const bw = Math.min(24, Math.max(2, (slot - 6) / series.length - 2));
    rows.forEach((r, i) => series.forEach((x, k) => {
      const v = Math.max(0, x.value(r));
      const top = y(v);
      const left = cx(i) - (series.length * (bw + 2) - 2) / 2 + k * (bw + 2);
      const hgt = pad.t + ih - top;
      if (hgt <= 0) return;
      const rr = Math.min(4, bw / 2, hgt);
      // Rounded at the data end, square at the baseline.
      svg.append(s('path', { d: `M${left},${pad.t + ih} V${top + rr} Q${left},${top} ${left + rr},${top} H${left + bw - rr} Q${left + bw},${top} ${left + bw},${top + rr} V${pad.t + ih} Z`, fill: x.color }));
    }));
  }

  // One tooltip for every series at the hovered date.
  const cross = s('line', { class: 'cross', y1: pad.t, y2: pad.t + ih, visibility: 'hidden' });
  svg.append(cross);
  const tip = h('div', { class: 'an-tip', hidden: true, role: 'status' });
  const hit = s('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', tabindex: 0, 'aria-label': 'Move across the chart for the numbers' });
  svg.append(hit);
  const show = (i) => {
    const r = rows[i];
    cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.setAttribute('visibility', 'visible');
    fill(tip, h('span', { class: 't' }, bucketLabel(r.key, unit, false)),
      ...series.map((x) => h('span', { class: 'row' }, h('i', { style: `background:${x.color}` }), h('b', {}, x.fmt(x.value(r))), h('span', {}, x.name))));
    tip.hidden = false;
    const left = (cx(i) / W) * host.clientWidth;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), host.clientWidth - 170)}px`;
    tip.style.top = '10px';
  };
  let focusAt = n - 1;
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    show(Math.min(n - 1, Math.max(0, Math.floor((px - pad.l) / slot))));
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('focus', () => show(focusAt));
  hit.addEventListener('blur', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') focusAt = Math.min(n - 1, focusAt + 1);
    else if (e.key === 'ArrowLeft') focusAt = Math.max(0, focusAt - 1);
    else return;
    e.preventDefault();
    show(focusAt);
  });
  fill(host, svg, tip);
}

function legend(items) {
  return h('div', { class: 'an-legend' }, ...items.map((x) => h('span', {}, h('i', { class: x.line ? 'line' : null, style: `background:${x.color}` }), x.name)));
}

// Charts are drawn to their card's width; redraw them when the window changes size.
function chartHost(draw) {
  const host = h('div', { class: 'an-chart-host', style: 'position:relative' });
  host.__draw = draw;
  return host;
}
function drawCharts() {
  document.querySelectorAll('#anBody .an-chart-host').forEach((host) => host.__draw(host));
}

// ---------- colors from the person's look ----------
// The look's colors come as CSS (some mixed); turn one into plain rgb so SVG and the contrast check can use it.
const vizCanvas = document.createElement('canvas');
function vizColor(name) {
  const probe = h('span', { style: `color: var(${name})`, hidden: true });
  $('#analyticsSection').append(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  const ctx = vizCanvas.getContext('2d', { willReadFrequently: true });
  vizCanvas.width = 1; vizCanvas.height = 1;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}
function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------- the page ----------
function renderAnalytics(d) {
  const k = d.kpis;
  const p = d.prev;
  const noSpend = k.ad_spend_cents == null;
  const totalBooked = d.trend.rows.reduce((n, r) => n + r.booked, 0);
  const c1 = vizColor('--viz-1');
  const c2 = vizColor('--viz-2');
  const ramp = ['--viz-r1', '--viz-r2', '--viz-r3', '--viz-r4'].map(vizColor);

  // Headline numbers.
  const kpis = h('div', { class: 'an-kpis' },
    tile('New leads', anNum(k.leads), { now: k.leads, before: p.leads }),
    tile('Booked', anNum(k.booked), { sub: `of the new leads (${anPct(k.booking_rate)})`, now: k.booked, before: p.booked }),
    tile('Revenue', anMoney(k.revenue_cents), { sub: `${anNum(k.jobs)} jobs dropped off`, now: k.revenue_cents, before: p.revenue_cents }),
    tile('Collected', anMoney(k.collected_cents), { sub: 'deposits and payments', now: k.collected_cents, before: p.collected_cents }),
    tile('Booking rate', anPct(k.booking_rate), { now: k.booking_rate, before: p.booking_rate, points: true }),
    tile('Average job', anMoney(k.avg_job_cents), { now: k.avg_job_cents, before: p.avg_job_cents }),
    tile('First response', anMinutes(k.first_touch_median_min), { sub: 'median, new lead to first call or text', now: k.first_touch_median_min, before: p.first_touch_median_min, better: 'down' }),
    noSpend ? tile('Ad spend', '–', { sub: 'not split by pipeline; pick All vehicles' })
      : tile('Cost per booking', anMoney(k.cost_per_booking_cents), { sub: `${anMoney(k.ad_spend_cents)} ad spend`, now: k.cost_per_booking_cents, before: p.cost_per_booking_cents, better: 'down' }));

  // Over time.
  const unitName = { day: 'day', week: 'week', month: 'month' }[d.trend.unit];
  const leadSeries = [
    { name: 'New leads', color: c1, value: (r) => r.leads, fmt: anNum },
    { name: 'Jobs booked', color: c2, value: (r) => r.booked, fmt: anNum },
  ];
  const moneySeries = [
    { name: 'Revenue (by drop-off)', color: c1, value: (r) => r.revenue_cents, fmt: anMoney },
    { name: 'Collected', color: c2, value: (r) => r.collected_cents, fmt: anMoney },
  ];
  const overTime = h('div', { class: 'an-grid' },
    card('Leads and bookings', `By ${unitName}. ${anNum(k.leads)} new leads, ${anNum(totalBooked)} jobs booked.`,
      legend(leadSeries.map((x) => ({ ...x, line: true }))),
      chartHost((host) => timeChart(host, { rows: d.trend.rows, unit: d.trend.unit, series: leadSeries, type: 'line' })),
      asTable([{ label: unitName[0].toUpperCase() + unitName.slice(1), num: false }, 'New leads', 'Jobs booked'], d.trend.rows.map((r) => [bucketLabel(r.key, d.trend.unit, false), r.leads, r.booked]))),
    card('Revenue and money collected', `By ${unitName}. Revenue counts each job on its drop-off day; collected is deposits and payments on the day they came in.`,
      legend(moneySeries),
      chartHost((host) => timeChart(host, { rows: d.trend.rows, unit: d.trend.unit, series: moneySeries, type: 'columns', dollars: true })),
      asTable([{ label: unitName[0].toUpperCase() + unitName.slice(1), num: false }, 'Revenue', 'Collected'], d.trend.rows.map((r) => [bucketLabel(r.key, d.trend.unit, false), anMoney(r.revenue_cents), anMoney(r.collected_cents)]))));

  // The new leads, followed through.
  const sp = d.speed;
  const spTotal = sp.buckets.reduce((n, b) => n + b.n, 0);
  const segColors = [...ramp, vizColor('--viz-none')];
  const isDark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  // Text inside a block: near-black on light colors, white on deep ones.
  const inkFor = (i) => (luminance(segColors[i]) > 0.38 ? 'dark-ink' : 'light-ink');
  const speedBar = spTotal ? h('div', { class: 'an-seg', role: 'img', 'aria-label': sp.buckets.map((b) => `${b.label}: ${b.n}`).join(', ') },
    ...sp.buckets.map((b, i) => (b.n ? h('div', { class: inkFor(i), style: `flex:${b.n} 1 0; background:${segColors[i]}`, title: `${b.label}: ${b.n} (${anPct(b.n / spTotal)})` }, (b.n / spTotal) >= 0.08 ? anPct(b.n / spTotal) : '') : null)))
    : h('p', { class: 'an-empty' }, 'No new leads in this period.');
  const leadsGroup = h('div', { class: 'an-grid' },
    card('From lead to pickup', 'How far the new leads got. Reached means a real conversation (a call outcome, a text back, or a booking).',
      hbars(d.funnel.map((f) => ({ label: f.step, value: f.n })), { of: d.funnel[0].n || null })),
    card('How fast new leads were worked', `Time from a lead coming in to the first call, text or note. Clock time, nights included. Median ${anMinutes(sp.median_min)}; ${anPct(sp.within_15_rate)} within 15 minutes.`,
      speedBar,
      legend(sp.buckets.map((b, i) => ({ name: `${b.label} (${b.n})`, color: segColors[i] }))),
      asTable([{ label: 'Wait', num: false }, 'Leads', 'Share'], sp.buckets.map((b) => [b.label, b.n, spTotal ? anPct(b.n / spTotal) : '–']))),
    card('Why leads didn\'t book', `The new leads marked Waste, by their last outcome, and the ones that went cold (two weeks with no booking). ${anNum(d.lost.still_open)} are still being worked.`,
      hbars(d.lost.reasons.map((x) => ({ label: x.reason, value: x.n })))),
    card('When leads come in', 'New leads by day of the week and hour. Darker means more.', heatmap(d.arrivals)));

  // Where they came from.
  const srcHead = [{ label: 'Source', num: false }, 'Leads', 'Booked', 'Rate', 'Revenue', ...(noSpend ? [] : ['Ad spend', 'Cost per lead', 'Cost per booking', 'Return'])];
  const srcRows = d.sources.map((r) => [AN_SOURCES[r.key] || r.key, r.leads, r.booked, anPct(r.booking_rate), anMoney(r.revenue_cents),
    ...(noSpend ? [] : [anMoney(r.spend_cents), anMoney(r.cost_per_lead_cents), anMoney(r.cost_per_booking_cents), r.return_x == null ? '–' : `${r.return_x.toFixed(1)}×`])]);
  const mix = (rows, label) => table([{ label, num: false }, 'Leads', 'Booked', 'Rate', 'Revenue', 'Average job'],
    rows.map((r) => [r.key, r.leads, r.booked, anPct(r.booking_rate), anMoney(r.revenue_cents), anMoney(r.avg_job_cents)]));
  const sourcesGroup = h('div', { class: 'an-grid' },
    h('div', { style: 'grid-column: 1 / -1' }, card('Lead sources', noSpend ? 'Ad spend isn\'t split by pipeline, so it shows under All vehicles.' : 'Ad spend is what was entered on Revenue → Ad spend for the months in this period.', table(srcHead, srcRows))),
    card('How they heard about us', null, mix(d.heard, 'Answer')),
    card('Vehicle types', null, mix(d.vehicles, 'Vehicle')));

  // The team.
  const repsCard = card('Team', 'Everything each person did in the period. Booked and revenue count jobs booked in the period; first responses count new leads they reached first.',
    table([{ label: 'Person', num: false }, 'Leads worked', 'Calls logged', 'Texts sent', 'Emails', 'Quotes', 'Booked', 'Close rate', 'Revenue', 'Commission', 'First responses', 'Their median response', { label: 'Last on', num: false }],
      d.reps.map((r) => [r.name, r.leads_worked, r.calls, r.texts, r.emails, `${r.quotes}${r.quotes ? ` (${anMoney(r.quote_cents)})` : ''}`, r.booked, anPct(r.close_rate), anMoney(r.revenue_cents), anMoney(r.commission_cents), r.first_responses, anMinutes(r.first_touch_median_min),
        r.last_seen_at ? anDate(r.last_seen_at, { month: 'short', day: 'numeric' }) : '–'])));

  // Follow-up, messages and marketing.
  const q = d.quotes;
  const m = d.messages;
  const e = d.emails;
  const b = d.booking_links;
  const ref = d.referrals;
  const followGroup = h('div', { class: 'an-grid' },
    card('Quotes', null, h('div', { class: 'an-stats' },
      tile('Quotes made', anNum(q.made), { sub: `${anNum(q.emailed)} emailed` }),
      tile('Average quote', anMoney(q.avg_cents)),
      tile('Quoted leads that booked', anPct(q.booking_rate), { sub: `${anNum(q.booked)} of ${anNum(q.leads_quoted)}` }),
      tile('Follow-up texts', anNum(q.followups_sent), { sub: `${anNum(q.followups_booked)} booked after` }))),
    card('Online booking links', null, h('div', { class: 'an-stats' },
      tile('Links sent', anNum(b.sent)),
      tile('Booked online', anNum(b.booked), { sub: `${anPct(b.booked_rate)} of links sent · ${anMoney(b.booked_cents)}` }),
      tile('Card deposits', anNum(b.deposits_paid), { sub: anMoney(b.deposits_cents) }))),
    card('Texts', `${anNum(m.received)} text${m.received === 1 ? '' : 's'} came in. Of the ${anNum(m.leads_texted)} leads texted by a rep, a follow-up, a campaign or a missed-call text, ${anNum(m.replied)} wrote back (${anPct(m.reply_rate)}).`,
      h('div', { class: 'an-stats' },
        tile('Sent', anNum(m.sent), { sub: m.failed ? `${anNum(m.failed)} failed` : 'none failed' }),
        tile('Reply rate', anPct(m.reply_rate)),
        tile('Missed calls', anNum(m.missed_calls), { sub: `new callers · ${anNum(m.missed_call_texts)} texted back` })),
      hbars(m.by_kind.map((x) => ({ label: x.kind, value: x.n })))),
    card('Emails', e.failed ? `${anNum(e.failed)} failed to send.` : null,
      h('div', { class: 'an-stats' }, tile('Sent', anNum(e.sent))),
      hbars(e.by_kind.map((x) => ({ label: x.kind, value: x.n })))),
    card('Win-back campaigns', 'Campaigns started in the period. Replied and booked count people who did so after their message.',
      table([{ label: 'Campaign', num: false }, 'Sent', 'Waiting', 'Replied', 'Booked', 'Revenue'],
        d.campaigns.map((c) => [c.name, c.sent, c.pending, c.replied, c.booked, anMoney(c.revenue_cents)]))),
    card('Referrals and partners', `${anNum(ref.leads)} new leads came from referral links; ${anNum(ref.booked)} booked for ${anMoney(ref.revenue_cents)}.`,
      table([{ label: 'Sent by', num: false }, 'Leads', 'Booked', 'Revenue'], ref.top.map((r) => [`${r.name}${r.kind === 'partner' ? ' (partner)' : ''}`, r.leads, r.booked, anMoney(r.revenue_cents)]))));

  // The shop and the money.
  const sh = d.shop;
  const mo = d.money;
  const shopGroup = h('div', { class: 'an-grid' },
    card('In the shop', null,
      h('div', { class: 'an-stats' },
        tile('Dropped off', anNum(sh.dropped_off)),
        tile('Picked up', anNum(sh.picked_up), { sub: sh.avg_days_in_shop == null ? null : `${sh.avg_days_in_shop.toFixed(1)} days in the shop on average` }),
        tile('Cancelled', anNum(sh.cancelled)),
        tile('Sign-offs', anNum(sh.signoffs)),
        tile('Photos', anNum(sh.photos)),
        tile('Checklist items done', anNum(sh.checklist_done))),
      h('div', {}, h('div', { class: 'an-legend' }, h('span', {}, `Shop time booked: ${anNum(sh.hours_booked)} of ${anNum(sh.hours_open)} open hours (${anPct(sh.utilization)})`)),
        h('div', { class: 'an-meter', role: 'img', 'aria-label': `Shop time booked ${anPct(sh.utilization)}` }, h('div', { style: `width:${Math.min(100, (sh.utilization || 0) * 100)}%` }))),
      h('div', { class: 'an-stats' },
        tile('Confirmations', anNum(sh.confirmations)),
        tile('Day-before reminders', anNum(sh.reminders)),
        tile('Ready notices', anNum(sh.ready_notices)),
        tile('Review requests', anNum(sh.review_requests)))),
    card('Money', 'Revenue counts jobs dropped off in the period. Still owed and commission owed are as of today.',
      h('div', { class: 'an-stats' },
        tile('Revenue', anMoney(mo.revenue_cents)),
        tile('Deposits', anMoney(mo.deposits_cents)),
        tile('Payments', anMoney(mo.payments_cents), { sub: mo.refunds_cents ? `${anMoney(mo.refunds_cents)} refunded` : null }),
        tile('Collected', anMoney(mo.collected_cents)),
        tile('Still owed', anMoney(mo.owed_cents), { sub: `${anNum(mo.owed_jobs)} jobs` }),
        tile('Commission paid', anMoney(mo.commission_paid_cents)),
        tile('Commission owed', anMoney(mo.commission_owed_cents)),
        mo.ad_spend_cents == null ? null : tile('Ad spend', anMoney(mo.ad_spend_cents))),
      hbars(Object.entries(mo.methods).map(([method, cents]) => ({ label: method, value: cents })).sort((x, y) => y.value - x.value), { fmt: anMoney })));

  fill($('#anBody'),
    kpis,
    group('Over time', null, overTime),
    group('The new leads', 'Leads that came in during the period, followed through to today.', leadsGroup),
    group('Where they came from', null, sourcesGroup),
    group('The team', null, repsCard),
    group('Follow-up and marketing', 'What was sent and made during the period.', followGroup),
    group('The shop and the money', null, shopGroup));
  drawCharts();
}

function heatmap(grid) {
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((a, b) => a + b, 0);
  if (!total) return h('p', { class: 'an-empty' }, 'No new leads in this period.');
  const hour = (i) => (i === 0 ? '12a' : i < 12 ? `${i}a` : i === 12 ? '12p' : `${i - 12}p`);
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const cells = [h('span', {}), ...Array.from({ length: 24 }, (_, i) => h('span', { class: 'hl' }, i % 3 === 0 ? hour(i) : ''))];
  for (const d of order) {
    cells.push(h('span', {}, DAYS[d]));
    grid[d].forEach((n, i) => cells.push(h('span', {
      class: n ? 'c' : 'c zero',
      style: n ? `opacity:${(0.18 + 0.82 * (n / max)).toFixed(2)}` : null,
      title: `${DAYS[d]} ${hour(i)}: ${n} lead${n === 1 ? '' : 's'}`,
      role: 'img',
      'aria-label': `${DAYS[d]} ${hour(i)}: ${n}`,
    })));
  }
  const busiest = [];
  order.forEach((d) => grid[d].forEach((n, i) => busiest.push({ d, i, n })));
  busiest.sort((a, b) => b.n - a.n);
  const top = busiest.filter((x) => x.n > 0).slice(0, 3).map((x) => `${DAYS[x.d]} ${hour(x.i)} (${x.n})`).join(', ');
  const byDay = order.map((d) => [DAYS[d], grid[d].reduce((a, b) => a + b, 0)]);
  return h('div', {}, h('div', { class: 'an-heat' }, ...cells),
    h('p', { class: 'an-sub', style: 'margin-top:8px' }, `Busiest: ${top}.`),
    asTable([{ label: 'Day', num: false }, 'Leads'], byDay));
}

// ---------- CSV: every table on the page, one after another ----------
function exportAnalytics() {
  if (!an.data) return;
  const lines = [];
  const add = (...cells) => lines.push(cells.map((c) => {
    const v = c == null ? '' : String(c);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','));
  const d = an.data;
  const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
  add('Analytics', $('#anRange').textContent);
  add('Pipeline', $('#anPipeline').selectedOptions[0].textContent);
  add();
  add('Headline', 'This period', 'Period before');
  for (const [k, label, isMoney] of [['leads', 'New leads'], ['booked', 'Booked'], ['booking_rate', 'Booking rate'], ['jobs', 'Jobs dropped off'], ['revenue_cents', 'Revenue', true], ['collected_cents', 'Collected', true], ['avg_job_cents', 'Average job', true], ['first_touch_median_min', 'First response (minutes, median)'], ['ad_spend_cents', 'Ad spend', true], ['cost_per_booking_cents', 'Cost per booking', true]]) {
    add(label, isMoney ? dollars(d.kpis[k]) : d.kpis[k] ?? '', isMoney ? dollars(d.prev[k]) : d.prev[k] ?? '');
  }
  add();
  add('Date', 'New leads', 'Jobs booked', 'Revenue', 'Collected');
  for (const r of d.trend.rows) add(r.key, r.leads, r.booked, dollars(r.revenue_cents), dollars(r.collected_cents));
  add();
  add('Step', 'Leads');
  for (const f of d.funnel) add(f.step, f.n);
  add();
  add('First response', 'Leads');
  for (const b of d.speed.buckets) add(b.label, b.n);
  add();
  add('Source', 'Leads', 'Booked', 'Revenue', 'Ad spend', 'Cost per lead', 'Cost per booking');
  for (const r of d.sources) add(AN_SOURCES[r.key] || r.key, r.leads, r.booked, dollars(r.revenue_cents), dollars(r.spend_cents), dollars(r.cost_per_lead_cents), dollars(r.cost_per_booking_cents));
  add();
  add('How they heard', 'Leads', 'Booked', 'Revenue');
  for (const r of d.heard) add(r.key, r.leads, r.booked, dollars(r.revenue_cents));
  add();
  add('Vehicle type', 'Leads', 'Booked', 'Revenue');
  for (const r of d.vehicles) add(r.key, r.leads, r.booked, dollars(r.revenue_cents));
  add();
  add('Why leads didn\'t book', 'Leads');
  for (const r of d.lost.reasons) add(r.reason, r.n);
  add();
  add('Person', 'Leads worked', 'Calls logged', 'Texts sent', 'Emails', 'Quotes', 'Booked', 'Revenue', 'Commission', 'First responses', 'Median response (minutes)');
  for (const r of d.reps) add(r.name, r.leads_worked, r.calls, r.texts, r.emails, r.quotes, r.booked, dollars(r.revenue_cents), dollars(r.commission_cents), r.first_responses, r.first_touch_median_min == null ? '' : Math.round(r.first_touch_median_min));
  add();
  add('Campaign', 'Sent', 'Replied', 'Booked', 'Revenue');
  for (const c of d.campaigns) add(c.name, c.sent, c.replied, c.booked, dollars(c.revenue_cents));
  add();
  add('Day', ...Array.from({ length: 24 }, (_, i) => `${i}:00`));
  d.arrivals.forEach((row, i) => add(DAYS[i], ...row));
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `analytics-${d.range.from.slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function initAnalytics() {
  const reload = () => loadAnalytics().catch(fail);
  $('#anPeriod').addEventListener('change', () => {
    const custom = $('#anPeriod').value === 'custom';
    $('#anCustom').hidden = !custom;
    if (custom && !$('#anFrom').value) {
      const [from, to] = [new Date(Date.now() - 29 * 86400000), new Date()];
      const key = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
      $('#anFrom').value = key(from);
      $('#anTo').value = key(to);
    }
    reload();
  });
  $('#anFrom').addEventListener('change', reload);
  $('#anTo').addEventListener('change', reload);
  $('#anPipeline').addEventListener('change', reload);
  $('#anExport').addEventListener('click', exportAnalytics);
  window.addEventListener('resize', () => {
    clearTimeout(an.resizeTimer);
    an.resizeTimer = setTimeout(() => { if (!$('#analyticsSection').hidden && an.data) drawCharts(); }, 150);
  });
  // Light/dark, the device's setting, or a new look repaints the charts in the new colors.
  let repaintTimer;
  const repaint = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => { if (!$('#analyticsSection').hidden && an.data) renderAnalytics(an.data); }, 50);
  };
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  new MutationObserver(repaint).observe(document.head, { childList: true, subtree: true, characterData: true });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', repaint);
}
