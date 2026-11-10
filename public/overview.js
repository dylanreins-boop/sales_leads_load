'use strict';
// Overview: the home screen for admins and sales. Today's numbers, the pipeline at a glance (scored),
// suggestions worked out from the data, the team's day, and who to call next. Every number links to
// the leads behind it. Uses the helpers from app.js ($, h, fill, api, money, timeAgo, exactTime, …).

const ov = { data: null, timer: null };

async function loadOverview() {
  const body = $('#overviewBody');
  if (!ov.data) fill(body, h('div', { class: 'ov-skeleton' }, ...Array.from({ length: 4 }, () => h('div', { class: 'ov-card sk' }))));
  ov.data = await api('/api/overview');
  renderOverview();
  // Keep it fresh while it's open.
  clearInterval(ov.timer);
  ov.timer = setInterval(() => { if (state.section === 'overview' && !document.hidden) api('/api/overview').then((d) => { ov.data = d; renderOverview(); }).catch(() => {}); }, 60_000);
}

const dur = (s) => {
  if (s == null) return '–';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const hrs = Math.floor(m / 60);
  return hrs < 48 ? `${hrs}h ${m % 60}m` : `${Math.round(hrs / 24)} days`;
};
const shortMoney = (cents) => (cents == null ? '' : `$${Math.round(cents / 100).toLocaleString('en-US')}`);
const greeting = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };

function trendLine(change, { goodUp = true, unit = 'vs. 7-day average' } = {}) {
  if (change == null) return h('div', { class: 'ov-trend flat' }, h('span', {}, 'No earlier days to compare yet'));
  const up = change >= 0;
  return h('div', { class: `ov-trend ${up === goodUp ? 'good' : 'bad'}` }, `${up ? '↑' : '↓'} ${Math.abs(change)}% `, h('span', {}, unit));
}

function kpiCard({ label, icon: ic, value, line, sub, onclick, title }) {
  return h('button', { type: 'button', class: 'ov-card ov-kpi', onclick, title },
    h('div', { class: 'ov-klabel' }, label, icon(ic)),
    h('div', { class: 'ov-kvalue' }, value), line, sub && h('div', { class: 'ov-ksub' }, sub));
}

// "Call now", "Quote sent 2d ago", "Drop-off Thu 9:00 AM"…
function nextText(l) {
  if (l.needs_reply) return { text: 'Texted back · answer', cls: 'urgent' };
  if (l.stage === 'booked' && l.next_job_at) return { text: `Drop-off ${new Date(l.next_job_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, cls: 'ok' };
  if (l.next_reminder_at) {
    const due = new Date(l.next_reminder_at) <= new Date();
    return { text: due ? 'Call now' : `Call ${new Date(l.next_reminder_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, cls: due ? 'urgent' : '' };
  }
  if (l.stage === 'new' && !l.last_contacted_at) return { text: l.age === 'fresh' ? 'Call now' : 'Not called yet', cls: 'urgent' };
  if (l.quote_sent_at) return { text: `Quote sent ${timeAgo(l.quote_sent_at)}`, cls: '' };
  if (l.no_next_step) return { text: 'No next step', cls: 'warn' };
  return { text: '', cls: '' };
}
// Short amounts so they fit the small cards: $950, $2.1k, $12k (a ~ means an estimate).
const kMoney = (cents) => { const d = cents / 100; return d < 1000 ? `$${Math.round(d)}` : d < 10000 ? `$${(d / 1000).toFixed(1)}k` : `$${Math.round(d / 1000)}k`; };
const valueText = (l) => (l.value_cents ? `${l.value_kind === 'typical' ? '~' : ''}${kMoney(l.value_cents)}` : '');
const heatTag = (l) => h('span', { class: `heat ${l.heat}`, title: 'Lead score: open the lead to see why' }, `${l.heat.toUpperCase()} · ${l.score}`);

function miniLead(l) {
  const next = nextText(l);
  return h('button', { type: 'button', class: `ov-lead age-${l.age || 'none'}`, onclick: () => openLead(l.id) },
    h('div', { class: 'ov-lead-top' }, h('b', {}, l.name), l.stage === 'booked' ? h('span', { class: 'heat booked' }, 'BOOKED') : heatTag(l)),
    l.vehicle && h('small', {}, l.vehicle),
    h('small', {}, `${sourceLabel[l.source] || l.source} · ${timeAgo(l.received_at)}`),
    h('div', { class: 'ov-lead-foot' }, h('span', { class: next.cls }, next.text), h('b', {}, valueText(l))));
}

const SUGGEST_ICON = { call: 'i-phone', reply: 'i-chat', quote: 'i-tag', stuck: 'i-todo', deposit: 'i-dollar', objection: 'i-users', coach: 'i-trophy' };

function renderOverview() {
  const d = ov.data;
  const k = d.kpis;
  const me = state.meta.currentUser;
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const speedChange = k.speed.seconds != null && k.speed.before_seconds ? k.speed.seconds - k.speed.before_seconds : null;

  fill($('#overviewBody'),
    h('div', { class: 'ov-head' },
      h('div', {}, h('h1', {}, `${greeting()}${me ? `, ${me.split(' ')[0]}` : ''}`), h('p', {}, `${today}. Here's what's happening with the pipeline.`)),
      h('div', { class: 'ov-actions' },
        state.meta.callsEnabled && h('button', { type: 'button', onclick: () => $('#dialerBtn').click() }, icon('i-phone'), ' Start calling'),
        h('button', { type: 'button', class: 'ov-refresh', title: 'Refresh the numbers', onclick: () => loadOverview().catch(fail) }, icon('i-sync'), ' Refresh'))),

    h('section', { class: 'ov-kpis' },
      kpiCard({ label: 'New leads today', icon: 'i-leads', value: String(k.new_today.value), line: trendLine(k.new_today.change),
        sub: `${k.new_today.avg} a day over the last week`, onclick: () => showSection('leads'), title: 'Leads that came in today (not counting imports)' }),
      kpiCard({ label: 'Speed to first contact', icon: 'i-clock', value: dur(k.speed.seconds),
        line: speedChange == null ? h('div', { class: 'ov-trend flat' }, h('span', {}, 'Middle time this week, from the lead coming in to the first call or text'))
          : h('div', { class: `ov-trend ${speedChange <= 0 ? 'good' : 'bad'}` }, `${speedChange <= 0 ? '↓' : '↑'} ${dur(Math.abs(speedChange))} `, h('span', {}, speedChange <= 0 ? 'faster than last week' : 'slower than last week')),
        sub: k.speed.waiting ? `${k.speed.waiting} new lead${k.speed.waiting === 1 ? '' : 's'} not called yet` : 'Every new lead has been called', onclick: () => $('#remindersBtn').click(),
        title: 'The middle (median) time this week from a lead coming in to the first call or text' }),
      kpiCard({ label: 'Appointments booked today', icon: 'i-calendar', value: String(k.booked_today.value), line: trendLine(k.booked_today.change),
        sub: `${k.booked_today.drop_offs_week} drop-off${k.booked_today.drop_offs_week === 1 ? '' : 's'} in the next 7 days`, onclick: () => showSection('calendar') }),
      kpiCard({ label: 'Open quotes', icon: 'i-tag', value: shortMoney(k.quoted.value_cents),
        line: h('div', { class: 'ov-trend flat' }, h('span', {}, `${k.quoted.count} lead${k.quoted.count === 1 ? '' : 's'} with a quote, not booked yet`)),
        sub: `${shortMoney(k.quoted.this_week_cents)} quoted this week (${shortMoney(k.quoted.last_week_cents)} the week before)`, onclick: () => showSection('leads'),
        title: 'The latest quote for each lead still being worked' })),

    h('div', { class: 'ov-grid' },
      h('section', { class: 'ov-card ov-pipe' },
        h('div', { class: 'ov-sechead' }, h('h2', {}, 'Live pipeline'), h('button', { type: 'button', class: 'link-btn', onclick: () => showSection('leads') }, 'Open full pipeline →')),
        h('div', { class: 'ov-cols' }, ...d.snapshot.map((c) => h('div', { class: 'ov-col' },
          h('div', { class: 'ov-colhead' }, h('span', {}, c.label), h('span', { class: 'count' }, c.count)),
          c.value_cents ? h('div', { class: 'ov-colvalue' }, shortMoney(c.value_cents)) : null,
          ...(c.leads.length ? c.leads.map(miniLead) : [h('p', { class: 'muted ov-empty' }, 'None right now')]),
          c.count > c.leads.length && h('button', { type: 'button', class: 'link-btn ov-more', onclick: () => showSection('leads') }, `+ ${c.count - c.leads.length} more`))))),
      h('section', { class: 'ov-card ov-suggest' },
        h('div', { class: 'ov-sechead' }, h('h2', {}, 'Suggestions'), h('span', { class: 'ov-live' }, 'FROM TODAY\'S DATA')),
        h('p', { class: 'ov-suggest-intro' }, 'Worked out from the leads, calls and texts in the app. Tap one to go to it.'),
        ...(d.suggestions.length ? d.suggestions.map((s) => h('button', { type: 'button', class: 'ov-insight', onclick: () => {
          if (s.lead_id) openLead(s.lead_id);
          else if (s.open === 'todo') $('#remindersBtn').click();
          else if (s.open === 'commissions') showSection('commissions');
          else if (s.open === 'calls') $('#callsBtn').click();
        } },
        h('span', { class: 'ov-spark' }, icon(SUGGEST_ICON[s.kind] || 'i-zap')),
        h('span', {}, h('b', {}, s.title), h('small', {}, s.detail))))
          : [h('p', { class: 'ov-suggest-intro' }, 'All caught up. Nothing needs you right now.')]))),

    h('div', { class: 'ov-lower' },
      h('section', { class: 'ov-card' },
        h('div', { class: 'ov-sechead' }, h('h2', {}, 'Team today'), h('button', { type: 'button', class: 'link-btn', onclick: () => showSection('leaderboard') }, 'Full leaderboard →')),
        d.team.length ? h('table', { class: 'ov-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Rep'), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Talked'), h('th', { class: 'num' }, 'Booked'), h('th', { class: 'num' }, 'Sales'), h('th', {}, 'Booked ÷ leads called'))),
          h('tbody', {}, ...d.team.map((r) => h('tr', {},
            h('td', {}, h('span', { class: 'ov-person' }, h('span', { class: 'mini-avatar' }, r.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()), r.name)),
            h('td', { class: 'num' }, r.calls), h('td', { class: 'num' }, r.conversations), h('td', { class: 'num' }, r.appointments), h('td', { class: 'num' }, shortMoney(r.booked_cents)),
            h('td', {}, h('span', { class: 'ov-conv' }, r.conversion == null ? '–' : `${r.conversion}%`, h('span', { class: 'ov-bar' }, h('i', { style: `width:${Math.min(100, r.conversion || 0)}%` }))))))))
          : h('p', { class: 'muted' }, 'No calls logged yet today.'),
        h('p', { class: 'ov-note' }, 'Calls are logged call outcomes; Talked = they answered (follow up, call back, booked, not interested). Booked counts jobs put on the calendar today.')),
      h('section', { class: 'ov-card ov-queue' },
        h('div', { class: 'ov-sechead' }, h('h2', {}, 'Call queue'), h('button', { type: 'button', class: 'link-btn', onclick: () => $('#remindersBtn').click() }, 'Open To do →')),
        h('div', { class: 'ov-dial' },
          h('div', { class: 'ov-dialnum' }, String(d.queue.due), h('span', {}, ` call${d.queue.due === 1 ? '' : 's'} due today`)),
          h('div', { class: 'ov-dialcopy' }, d.queue.next ? ['Next up', h('br'), h('b', {}, d.queue.next.name), ` · ${d.queue.next.why}`] : 'Nobody waiting right now.')),
        h('div', { class: 'ov-queue-stats' },
          h('span', {}, h('b', {}, d.queue.overdue), ' overdue'), h('span', {}, h('b', {}, d.queue.replies), ' texted back'), h('span', {}, h('b', {}, d.queue.fresh), ' new, not called')),
        h('div', { class: 'ov-dialbtns' },
          state.meta.callsEnabled
            ? h('button', { type: 'button', class: 'ov-callbtn', onclick: () => $('#dialerBtn').click() }, icon('i-phone'), ' Start calling')
            : d.queue.next && h('button', { type: 'button', class: 'ov-callbtn', onclick: () => openLead(d.queue.next.id) }, icon('i-phone'), ` Open ${d.queue.next.name.split(' ')[0]}`),
          h('button', { type: 'button', onclick: () => $('#remindersBtn').click() }, 'View the queue')))));
}
