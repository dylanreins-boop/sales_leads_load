'use strict';
// Leaderboard: each rep's calls, conversations, quotes, bookings and sales for a week or a month. Sort by
// any column (pick what matters most); click a rep for their page with the monthly goal and the last 6
// months. Admins set the goals. Uses the helpers from app.js ($, h, fill, api, money, icon, …).

const lb = { period: 'month', sort: 'booked_cents', data: null };
const LB_COLS = [
  { key: 'calls', label: 'Calls', tip: 'Call outcomes logged (each No answer, Contacted, Booked … counts once).' },
  { key: 'leads_called', label: 'Leads called', tip: 'Different leads they logged a call on.' },
  { key: 'conversations', label: 'Talked', tip: 'Calls where they reached the customer: Contacted, Call back requested, Booked or Not interested.' },
  { key: 'contact_rate', label: 'Contact rate', pct: true, tip: 'Talked ÷ calls.' },
  { key: 'quotes', label: 'Quotes', tip: 'Quotes they made.' },
  { key: 'appointments', label: 'Booked', tip: 'Jobs they put on the calendar (online bookings count for the rep who sent the link). Cancelled jobs don\'t count.' },
  { key: 'booked_cents', label: 'Sales', money: true, tip: 'The price of the jobs they booked in the period.' },
  { key: 'conversion', label: 'Conversion', pct: true, tip: 'Booked ÷ leads called, in the same period.' },
  { key: 'avg_talk_seconds', label: 'Avg talk', talk: true, dialer: true, tip: 'Average talk time on dialer calls.' },
];
const lbTalk = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

async function loadLeaderboard() {
  const body = $('#leaderboardBody');
  if (!lb.data) fill(body, h('div', { class: 'ov-skeleton' }, ...Array.from({ length: 3 }, () => h('div', { class: 'ov-card sk' }))));
  lb.data = await api(`/api/leaderboard?period=${lb.period}`);
  renderLeaderboard();
}

function lbCell(c, r) {
  const v = r[c.key];
  if (c.money) return money(v || 0, { cents: false });
  if (c.pct) return v == null ? '–' : `${v}%`;
  if (c.talk) return lbTalk(v);
  return String(v ?? 0);
}

function renderLeaderboard() {
  const d = lb.data;
  const cols = LB_COLS.filter((c) => !c.dialer || state.meta.callsEnabled);
  const col = cols.find((c) => c.key === lb.sort) || cols[0];
  const reps = [...d.reps].sort((a, b) => (b[col.key] ?? -1) - (a[col.key] ?? -1) || b.booked_cents - a.booked_cents);
  const top = reps.filter((r) => r.calls || r.appointments || r.booked_cents).slice(0, 3);
  const medal = ['gold', 'silver', 'bronze'];

  fill($('#leaderboardBody'),
    h('div', { class: 'ov-head' },
      h('div', {}, h('h1', {}, 'Leaderboard'), h('p', {}, `${d.label}: ${new Date(d.from).toLocaleDateString([], { month: 'short', day: 'numeric' })} to ${new Date(new Date(d.to) - 1).toLocaleDateString([], { month: 'short', day: 'numeric' })}. Ranked by ${col.label.toLowerCase()}; tap a column to rank by it.`)),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, ...Object.entries(d.periods).map(([k, label]) => h('button', {
        type: 'button', 'aria-pressed': String(k === d.period), onclick: () => { lb.period = k; loadLeaderboard().catch(fail); },
      }, label)))),
    top.length ? h('div', { class: 'lb-podium' }, ...top.map((r, i) => h('button', { type: 'button', class: `ov-card lb-top ${medal[i]}`, onclick: () => openRep(r.name) },
      h('span', { class: 'lb-rank' }, `#${i + 1}`),
      h('span', { class: 'avatar lb-avatar' }, initials(r.name)),
      h('b', {}, r.name),
      h('span', { class: 'lb-big' }, lbCell(col, r)),
      h('small', {}, `${col.label} · ${r.appointments} booked · ${money(r.booked_cents, { cents: false })}`)))) : null,
    h('section', { class: 'ov-card' },
      h('div', { class: 'table-scroll' }, h('table', { class: 'ov-table lb-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Rep'),
          ...cols.map((c) => h('th', { class: `num ${c.key === col.key ? 'sorted' : ''}`, title: c.tip },
            h('button', { type: 'button', class: 'lb-sort', onclick: () => { lb.sort = c.key; renderLeaderboard(); } }, c.label, c.key === col.key ? ' ↓' : ''))),
          h('th', {}, 'Goal this month'))),
        h('tbody', {}, ...(reps.length ? reps.map((r, i) => h('tr', { class: 'lb-row', onclick: () => openRep(r.name) },
          h('td', { class: 'lb-pos' }, i + 1),
          h('td', {}, h('span', { class: 'ov-person' }, h('span', { class: 'mini-avatar' }, initials(r.name)), r.name)),
          ...cols.map((c) => h('td', { class: `num ${c.key === col.key ? 'sorted' : ''}` }, lbCell(c, r))),
          h('td', {}, goalBar(r)))) : [h('tr', {}, h('td', { colspan: cols.length + 3, class: 'muted' }, 'No calls or bookings in this period yet.'))])))),
      h('details', { class: 'lb-defs' }, h('summary', {}, 'What each number means'),
        h('dl', {}, ...cols.flatMap((c) => [h('dt', {}, c.label), h('dd', {}, c.tip)]),
          h('dt', {}, 'Goal this month'), h('dd', {}, 'Sales booked this calendar month against the rep\'s monthly goal (admins set it on the rep\'s page).'))),
      h('p', { class: 'ov-note' }, 'Numbers count what happened in the period: a call, a quote or a booking is counted on the day it was logged. Shop logins aren\'t ranked.')));
}

function goalBar(r) {
  if (!r.goal_cents) return h('span', { class: 'muted' }, isAdmin() ? 'No goal set' : '–');
  const pct = Math.round((r.month_booked_cents / r.goal_cents) * 100);
  return h('span', { class: 'lb-goal', title: `${money(r.month_booked_cents, { cents: false })} of ${money(r.goal_cents, { cents: false })}` },
    h('span', { class: 'ov-bar' }, h('i', { style: `width:${Math.min(100, pct)}%` })), `${pct}%`);
}

// A rep's page: this month and week, goal and pace, the last 6 months, commission (their own, or admins).
async function openRep(name) {
  try {
    const p = await api(`/api/reps/${encodeURIComponent(name)}`);
    const m = p.month || { calls: 0, conversations: 0, appointments: 0, booked_cents: 0, conversion: null, quotes: 0, contact_rate: null };
    const max = Math.max(1, ...p.months.map((x) => x.booked_cents));
    const stat = (label, value, sub) => h('div', { class: 'rep-stat' }, h('span', {}, label), h('b', {}, value), sub && h('small', {}, sub));
    const goalBox = h('section', { class: 'card-section rep-goal' },
      h('h3', {}, 'Monthly goal'),
      p.goal_cents
        ? [h('div', { class: 'rep-goal-top' }, h('b', {}, `${money(m.booked_cents, { cents: false })} of ${money(p.goal_cents, { cents: false })}`), h('span', {}, `${p.goal_progress}%`)),
          h('div', { class: 'rep-goal-bar' }, h('i', { style: `width:${Math.min(100, p.goal_progress)}%` })),
          h('p', { class: 'hint' }, `On pace for ${money(p.pace_cents, { cents: false })} this month (${p.pace_cents >= p.goal_cents ? 'ahead of' : 'behind'} the goal).`)]
        : h('p', { class: 'muted' }, 'No goal set.'),
      isAdmin() && h('button', { type: 'button', class: 'link-btn', onclick: async () => {
        const v = await ask({ title: `${name}'s monthly goal`, text: 'Sales booked in a month, in dollars. Leave empty for no goal.', input: { value: p.goal_cents ? String(p.goal_cents / 100) : '', placeholder: '20000' }, ok: 'Save' });
        if (v === null) return;
        try { await api('/api/goals', { method: 'PUT', body: { name, monthly: v } }); toast('Goal saved'); openRep(name); if (state.section === 'leaderboard') loadLeaderboard().catch(() => {}); } catch (err) { fail(err); }
      } }, p.goal_cents ? 'Change the goal' : 'Set a goal'));
    openSettings(name, 'Their numbers this month, their goal, and the last 6 months.',
      h('div', { class: 'rep-stats' },
        stat('Calls', m.calls, p.week ? `${p.week.calls} this week` : '0 this week'),
        stat('Talked', m.conversations, m.contact_rate == null ? '' : `${m.contact_rate}% of calls`),
        stat('Booked', m.appointments, `${m.quotes} quote${m.quotes === 1 ? '' : 's'} made`),
        stat('Sales', money(m.booked_cents, { cents: false }), m.conversion == null ? '' : `${m.conversion}% of leads called`),
        m.avg_talk_seconds != null && stat('Avg talk', lbTalk(m.avg_talk_seconds), m.dialer_appointment_rate == null ? '' : `${m.dialer_appointment_rate}% of dialer calls booked`),
        stat('Open leads', p.open_leads, 'last reached by them')),
      goalBox,
      h('section', { class: 'card-section' }, h('h3', {}, 'Sales booked, last 6 months'),
        h('div', { class: 'rep-months' }, ...p.months.map((x) => h('div', { class: 'rep-month', title: `${x.appointments} booked · ${x.calls} calls` },
          h('span', { class: 'rep-month-val' }, x.booked_cents ? `$${Math.round(x.booked_cents / 100000 * 10) / 10}k` : '$0'),
          h('span', { class: 'rep-month-bar' }, h('i', { style: `height:${Math.max(2, Math.round((x.booked_cents / max) * 100))}%` })),
          h('span', { class: 'rep-month-label' }, new Date(`${x.month}-15T12:00:00`).toLocaleDateString([], { month: 'short' })))))),
      p.commission && h('section', { class: 'card-section' }, h('h3', {}, 'Commission'),
        h('div', { class: 'rep-stats' },
          stat('Owed now', money(p.commission.owed_cents, { cents: false })),
          stat('Pending', money(p.commission.pending_cents, { cents: false }), 'vehicle not in the shop yet'),
          stat('Paid this year', money(p.commission.paid_year_cents, { cents: false })))));
  } catch (err) { fail(err); }
}
