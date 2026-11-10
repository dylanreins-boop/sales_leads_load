// The admins' Analytics page: everything the app records, for one date range, in one report.
//
// Two kinds of numbers, and the page says which is which:
//  - "Leads that came in" (the cohort): leads received in the range, followed to today: did they get
//    reached, quoted, booked, picked up, and what did they spend.
//  - "What happened" (activity): things done during the range, whatever lead they belong to: texts,
//    calls logged, quotes, jobs in the shop, money collected.
// Times are bucketed in the server's local time, the same clock as the shop calendar.
const { HttpError, toIso } = require('./leads');
const { pipelineFor, PIPELINES } = require('./vehicle');
const { DISPOSITIONS } = require('./pipeline');
const ShopTime = require('../public/shop-time');
const { serviceLabels, parseServices } = require('./services');
const { colorFamily } = require('./estimates');

const DAY = 86400000;
const WORK_TYPES = ['disposition', 'stage_change', 'text', 'note', 'email'];
const REACHED = ['contacted_follow_up', 'callback_requested', 'booked'];
const DISPO_LABEL = Object.fromEntries(DISPOSITIONS.map((d) => [d.id, d.label]));
const TEXT_KINDS = {
  welcome: 'Welcome texts (best time?)',
  welcome_reply: 'Best-time thank-yous',
  manual: 'Sent by a rep',
  confirmation: 'Booking confirmations',
  reminder: 'Day-before reminders',
  ready: 'Ready for pickup',
  booking_link: 'Booking links',
  quote_followup: 'Quote follow-ups',
  campaign: 'Win-back campaigns',
  missed_call: 'Missed-call text-backs',
  referral: 'Referral links',
  review: 'Review requests',
};
const EMAIL_KINDS = { ...TEXT_KINDS, no_answer_vm: 'Voicemail follow-ups', confirm: 'Booking confirmations', quote: 'Quotes', invoice: 'Invoices and receipts', receipt: 'Invoices and receipts' };

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs, f = (x) => x) => xs.reduce((n, x) => n + (f(x) || 0), 0);
const rate = (part, whole) => (whole ? part / whole : null);

function createAnalyticsService(db, { commissions, payments, jobs, users, estimates }) {
  const stmt = (sql) => db.prepare(sql);

  // Period bounds from the query (ISO instants); the previous period is the same length just before.
  function bounds({ from, to }) {
    const start = toIso(from, null);
    const end = toIso(to, null);
    if (!start || !end || end <= start) throw new HttpError(400, 'Pick a date range.');
    const len = new Date(end) - new Date(start);
    if (len > 3 * 366 * DAY) throw new HttpError(400, 'Pick three years or less.');
    return { start, end, prevStart: new Date(new Date(start) - len).toISOString(), prevEnd: start };
  }

  // Each month's new leads and how far they got, so a month's leads are only compared with their own
  // bookings (not with jobs from leads that came in earlier). Up to the last 12 months of the range.
  function monthsOf(start, end, cohortOf) {
    const out = [];
    const first = new Date(start);
    let m = new Date(first.getFullYear(), first.getMonth(), 1);
    while (m.toISOString() < end) {
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      const a = m.toISOString() < start ? start : m.toISOString();
      const b = next.toISOString() > end ? end : next.toISOString();
      const c = cohortOf(a, b);
      out.push({
        month: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`, partial: a !== m.toISOString() || b !== next.toISOString(),
        came_in: c.length, reached: c.filter((l) => l.reached).length, quoted: c.filter((l) => l.quoted).length,
        booked: c.filter((l) => l.booked).length, picked_up: c.filter((l) => l.picked_up).length,
        revenue_cents: c.reduce((n, l) => n + (l.revenue_cents || 0), 0),
      });
      m = next;
    }
    return out.slice(-12);
  }

  function report(query = {}) {
    const { start, end, prevStart, prevEnd } = bounds(query);
    const pipeline = PIPELINES.some((p) => p.id === query.pipeline) ? query.pipeline : '';
    // Lead source: narrows the new-lead numbers (the funnel, speed, months) to leads from one source.
    const source = /^[a-z_]{2,20}$/.test(query.source || '') ? query.source : '';
    const inRange = (t, a = start, b = end) => t != null && t >= a && t < b;

    // ---- everything, loaded once (a shop's data is small) ----
    const allLeads = stmt(`SELECT id, source, heard_about, vehicle_type, stage, last_disposition, received_at, archived_at, referrer_id, import_batch,
                                  best_time, best_time_by, welcome_sent_at
                           FROM leads`).all().map((l) => ({ ...l, pipeline: pipelineFor(l.vehicle_type) }));
    const leadById = new Map(allLeads.map((l) => [l.id, l]));
    const inPipe = (leadId) => !pipeline || leadById.get(leadId)?.pipeline === pipeline;
    const allJobs = stmt('SELECT * FROM jobs').all().filter((j) => inPipe(j.lead_id))
      .map((j) => ({ ...j, pipeline: leadById.get(j.lead_id)?.pipeline }));
    const liveJobs = allJobs.filter((j) => j.status !== 'cancelled');
    const jobsByLead = groupBy(liveJobs, (j) => j.lead_id);
    const work = stmt(`SELECT lead_id, type, disposition, user_name, created_at FROM activities
                       WHERE user_name IS NOT NULL AND type IN (${WORK_TYPES.map(() => '?').join(',')}) ORDER BY created_at`).all(...WORK_TYPES)
      .filter((a) => inPipe(a.lead_id));
    const workByLead = groupBy(work, (a) => a.lead_id);
    const texts = stmt('SELECT lead_id, direction, status, trigger, user_name, created_at FROM texts ORDER BY created_at').all().filter((t) => inPipe(t.lead_id));
    const textsInByLead = groupBy(texts.filter((t) => t.direction === 'in'), (t) => t.lead_id);
    const quotes = stmt('SELECT id, lead_id, total_cents, created_by, created_at, emailed_at, followup1_at, followup2_at FROM quotes').all().filter((q) => inPipe(q.lead_id));
    const quotesByLead = groupBy(quotes, (q) => q.lead_id);
    const settings = jobs.getShopHours();

    // ---- the leads that came in ----
    const cohortOf = (a, b) => allLeads.filter((l) => inRange(l.received_at, a, b) && (!pipeline || l.pipeline === pipeline) && (!source || l.source === source)).map((l) => {
      const mine = jobsByLead.get(l.id) || [];
      const touches = workByLead.get(l.id) || [];
      const first = touches.find((a2) => a2.created_at >= l.received_at);
      return {
        ...l,
        booked: l.stage === 'booked' || mine.length > 0,
        revenue_cents: sum(mine, (j) => j.amount_cents),
        picked_up: mine.some((j) => j.status === 'picked_up'),
        quoted: (quotesByLead.get(l.id) || []).length > 0,
        reached: touches.some((a2) => REACHED.includes(a2.disposition)) || (textsInByLead.get(l.id) || []).length > 0 || mine.length > 0,
        first_touch_min: first && l.source !== 'import' ? (new Date(first.created_at) - new Date(l.received_at)) / 60000 : null,
        first_touch_by: first?.user_name || null,
      };
    });
    const cohort = cohortOf(start, end);
    const prevCohort = cohortOf(prevStart, prevEnd);

    // ---- money and shop activity in a range ----
    const paymentRows = stmt('SELECT job_id, kind, cents, method, paid_at FROM job_payments').all();
    const jobById = new Map(allJobs.map((j) => [j.id, j]));
    const moneyIn = (a, b) => {
      const deposits = allJobs.filter((j) => j.deposit_cents != null && inRange(j.deposit_at, a, b));
      const pays = paymentRows.filter((p) => jobById.has(p.job_id) && inRange(p.paid_at, a, b));
      const paid = sum(pays.filter((p) => p.kind !== 'refund'), (p) => p.cents);
      const refunds = sum(pays.filter((p) => p.kind === 'refund'), (p) => p.cents);
      return { deposits_cents: sum(deposits, (j) => j.deposit_cents), payments_cents: paid, refunds_cents: refunds, collected_cents: sum(deposits, (j) => j.deposit_cents) + paid - refunds, methods: countBy([...deposits.map((j) => ({ method: j.deposit_method, cents: j.deposit_cents })), ...pays.filter((p) => p.kind !== 'refund')], (x) => x.method || 'Other', (x) => x.cents) };
    };
    const jobsStarting = (a, b) => liveJobs.filter((j) => inRange(j.start_at, a, b));
    const spendRows = stmt('SELECT month, source, cents FROM ad_spend WHERE month >= ? AND month <= ?')
      .all(monthKey(new Date(start)), monthKey(new Date(new Date(end) - 1)));
    const prevSpend = stmt('SELECT SUM(cents) AS c FROM ad_spend WHERE month >= ? AND month <= ?')
      .get(monthKey(new Date(prevStart)), monthKey(new Date(new Date(prevEnd) - 1))).c || 0;

    const kpis = (c, a, b, spend) => {
      const booked = c.filter((l) => l.booked);
      const startedJobs = jobsStarting(a, b);
      const touch = c.map((l) => l.first_touch_min).filter((m) => m != null);
      return {
        leads: c.length,
        booked: booked.length,
        booking_rate: rate(booked.length, c.length),
        jobs: startedJobs.length,
        revenue_cents: sum(startedJobs, (j) => j.amount_cents),
        avg_job_cents: startedJobs.filter((j) => j.amount_cents != null).length ? Math.round(sum(startedJobs, (j) => j.amount_cents) / startedJobs.filter((j) => j.amount_cents != null).length) : null,
        collected_cents: moneyIn(a, b).collected_cents,
        first_touch_median_min: median(touch),
        ad_spend_cents: pipeline ? null : spend,
        cost_per_booking_cents: pipeline || !spend || !booked.length ? null : Math.round(spend / booked.length),
      };
    };
    const spendTotal = sum(spendRows, (r) => r.cents);

    return {
      range: { from: start, to: end, prev_from: prevStart, prev_to: prevEnd, pipeline, source },
      months: monthsOf(start, end, cohortOf),
      kpis: kpis(cohort, start, end, spendTotal),
      prev: kpis(prevCohort, prevStart, prevEnd, prevSpend),
      trend: trend({ start, end, cohort, liveJobs, paymentRows: paymentRows.filter((p) => jobById.has(p.job_id)), allJobs }),
      funnel: [
        { step: 'Came in', n: cohort.length },
        { step: 'Reached', n: cohort.filter((l) => l.reached).length },
        { step: 'Quoted', n: cohort.filter((l) => l.quoted).length },
        { step: 'Booked', n: cohort.filter((l) => l.booked).length },
        { step: 'Picked up', n: cohort.filter((l) => l.picked_up).length },
      ],
      speed: speed(cohort),
      reps: reps({ start, end, cohort, work, texts, quotes, liveJobs, inRange }),
      sources: bySource(cohort, pipeline ? [] : spendRows),
      heard: breakdown(cohort, (l) => l.heard_about || 'Not asked'),
      vehicles: breakdown(cohort, (l) => l.vehicle_type || 'Not given'),
      lost: lost(cohort),
      arrivals: arrivals(cohort),
      best_times: {
        asked: cohort.filter((l) => l.welcome_sent_at).length,
        answered: cohort.filter((l) => l.welcome_sent_at && l.best_time_by === 'customer').length,
        rows: breakdown(cohort.filter((l) => l.best_time), (l) => l.best_time.split(/,| or /)[0].trim()),
      },
      quotes: quoteStats({ quotes, jobsByLead, inRange }),
      messages: messageStats({ texts, inRange, cohort }),
      emails: emailStats({ inRange, inPipe, start, end }),
      booking_links: bookingLinkStats({ inRange, inPipe }),
      campaigns: campaignStats({ start, end }),
      referrals: referralStats(cohort),
      shop: shopStats({ start, end, allJobs, liveJobs, settings, inRange, inPipe }),
      labor: laborStats({ start, end, allJobs, settings, inRange, leadById }),
      money: { ...moneyIn(start, end), revenue_cents: sum(jobsStarting(start, end), (j) => j.amount_cents), ...owedNow(), ...commissionStats({ liveJobs, allJobs, inRange }), ad_spend_cents: pipeline ? null : spendTotal },
    };

    function owedNow() {
      const owed = payments.owed().filter((j) => inPipe(j.lead_id));
      return { owed_cents: sum(owed, (j) => j.amount_due_cents), owed_jobs: owed.length };
    }
  }

  // Leads, bookings and money over time: by day for a month or less, by week up to six months, then by month.
  function trend({ start, end, cohort, liveJobs, paymentRows, allJobs }) {
    const len = (new Date(end) - new Date(start)) / DAY;
    const unit = len <= 35 ? 'day' : len <= 190 ? 'week' : 'month';
    const keyOf = (iso) => {
      const d = new Date(iso);
      if (unit === 'day') return dayKey(d);
      if (unit === 'month') return `${monthKey(d)}-01`;
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      return dayKey(monday);
    };
    const keys = [];
    for (let t = new Date(start).getTime(); t < new Date(end).getTime(); t += 6 * 3600000) {
      const k = keyOf(new Date(t).toISOString());
      if (keys[keys.length - 1] !== k && !keys.includes(k)) keys.push(k);
    }
    const rows = new Map(keys.map((k) => [k, { key: k, leads: 0, booked: 0, revenue_cents: 0, collected_cents: 0 }]));
    const add = (iso, field, n = 1) => { const r = rows.get(keyOf(iso)); if (r && iso >= start && iso < end) r[field] += n || 0; };
    for (const l of cohort) add(l.received_at, 'leads');
    for (const j of liveJobs) add(j.created_at, 'booked');
    for (const j of liveJobs) add(j.start_at, 'revenue_cents', j.amount_cents);
    for (const j of allJobs) if (j.deposit_cents != null && j.deposit_at) add(j.deposit_at, 'collected_cents', j.deposit_cents);
    for (const p of paymentRows) add(p.paid_at, 'collected_cents', p.kind === 'refund' ? -p.cents : p.cents);
    return { unit, rows: [...rows.values()] };
  }

  // How long new leads waited for someone to work them (clock time, nights included).
  function speed(cohort) {
    const live = cohort.filter((l) => l.source !== 'import');
    const times = live.map((l) => l.first_touch_min).filter((m) => m != null);
    const buckets = [
      { id: '5m', label: 'Within 5 minutes', test: (m) => m <= 5 },
      { id: '1h', label: '5 to 60 minutes', test: (m) => m > 5 && m <= 60 },
      { id: '1d', label: '1 to 24 hours', test: (m) => m > 60 && m <= 1440 },
      { id: 'later', label: 'More than a day', test: (m) => m > 1440 },
    ].map((b) => ({ id: b.id, label: b.label, n: times.filter(b.test).length }));
    buckets.push({ id: 'never', label: 'Not worked yet', n: live.length - times.length });
    return {
      leads: live.length,
      median_min: median(times),
      within_15_rate: rate(times.filter((m) => m <= 15).length, live.length),
      buckets,
    };
  }

  // One row per person who worked leads, booked jobs or made quotes in the range.
  function reps({ start, end, cohort, work, texts, quotes, liveJobs, inRange }) {
    const people = new Map();
    const row = (name) => {
      if (!name) return null;
      if (!people.has(name)) people.set(name, { name, leads_worked: new Set(), calls: 0, texts: 0, emails: 0, notes: 0, quotes: 0, quote_cents: 0, booked: 0, revenue_cents: 0, commission_cents: 0, first_touches: [], reached_first: 0 });
      return people.get(name);
    };
    for (const a of work) {
      if (!inRange(a.created_at)) continue;
      const r = row(a.user_name);
      r.leads_worked.add(a.lead_id);
      if (a.type === 'disposition') r.calls++;
      else if (a.type === 'email') r.emails++;
      else if (a.type === 'note') r.notes++;
    }
    for (const t of texts) if (t.direction === 'out' && t.user_name && t.trigger === 'manual' && inRange(t.created_at)) row(t.user_name).texts++;
    for (const q of quotes) if (q.created_by && inRange(q.created_at)) { const r = row(q.created_by); r.quotes++; r.quote_cents += q.total_cents || 0; }
    for (const j of liveJobs) {
      if (!inRange(j.created_at)) continue;
      const f = commissions.figures(j);
      const r = row(f.commission_rep);
      if (!r) continue;
      r.booked++;
      r.revenue_cents += j.amount_cents || 0;
      r.commission_cents += f.commission_cents || 0;
    }
    for (const l of cohort) if (l.first_touch_by && l.first_touch_min != null) { const r = row(l.first_touch_by); r.first_touches.push(l.first_touch_min); r.reached_first++; }
    const lastSeen = new Map((users ? users.list() : stmt('SELECT name, role, last_seen_at FROM users').all()).map((u) => [u.name, u]));
    return [...people.values()].map((r) => ({
      name: r.name,
      role: lastSeen.get(r.name)?.role || null,
      last_seen_at: lastSeen.get(r.name)?.last_seen_at || null,
      leads_worked: r.leads_worked.size,
      calls: r.calls,
      texts: r.texts,
      emails: r.emails,
      notes: r.notes,
      quotes: r.quotes,
      quote_cents: r.quote_cents,
      booked: r.booked,
      close_rate: rate(r.booked, r.leads_worked.size),
      revenue_cents: r.revenue_cents,
      commission_cents: r.commission_cents,
      first_responses: r.reached_first,
      first_touch_median_min: median(r.first_touches),
    })).filter((r) => r.role !== 'shop')
      .sort((a, b) => b.revenue_cents - a.revenue_cents || b.booked - a.booked || b.leads_worked - a.leads_worked);
  }

  function breakdown(cohort, keyOf) {
    const groups = new Map();
    for (const l of cohort) {
      const k = keyOf(l);
      const g = groups.get(k) || { key: k, leads: 0, booked: 0, revenue_cents: 0 };
      g.leads++;
      if (l.booked) g.booked++;
      g.revenue_cents += l.revenue_cents;
      groups.set(k, g);
    }
    return [...groups.values()].map((g) => ({ ...g, booking_rate: rate(g.booked, g.leads), avg_job_cents: g.booked ? Math.round(g.revenue_cents / g.booked) : null }))
      .sort((a, b) => b.leads - a.leads || b.revenue_cents - a.revenue_cents);
  }

  function bySource(cohort, spendRows) {
    const rows = breakdown(cohort, (l) => l.source);
    for (const s of spendRows) {
      let r = rows.find((x) => x.key === s.source);
      if (!r) rows.push(r = { key: s.source, leads: 0, booked: 0, revenue_cents: 0, booking_rate: null, avg_job_cents: null });
      r.spend_cents = (r.spend_cents || 0) + s.cents;
    }
    return rows.map((r) => ({
      ...r,
      spend_cents: r.spend_cents ?? null,
      cost_per_lead_cents: r.spend_cents && r.leads ? Math.round(r.spend_cents / r.leads) : null,
      cost_per_booking_cents: r.spend_cents && r.booked ? Math.round(r.spend_cents / r.booked) : null,
      return_x: r.spend_cents ? r.revenue_cents / r.spend_cents : null,
    }));
  }

  // Why leads didn't book: the last outcome on the ones marked Waste, plus the ones that went cold.
  function lost(cohort) {
    const counts = new Map();
    for (const l of cohort) {
      if (l.booked) continue;
      let why = null;
      if (l.stage === 'waste') why = DISPO_LABEL[l.last_disposition] || 'Marked waste';
      else if (l.archived_at) why = 'Went cold';
      if (why) counts.set(why, (counts.get(why) || 0) + 1);
    }
    const open = cohort.filter((l) => !l.booked && l.stage !== 'waste' && !l.archived_at).length;
    return { reasons: [...counts.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n), still_open: open };
  }

  // When leads come in: day of the week by hour of the day.
  function arrivals(cohort) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const l of cohort) { const d = new Date(l.received_at); grid[d.getDay()][d.getHours()]++; }
    return grid;
  }

  function quoteStats({ quotes, jobsByLead, inRange }) {
    const made = quotes.filter((q) => inRange(q.created_at));
    const bookedAfter = (q) => (jobsByLead.get(q.lead_id) || []).some((j) => j.created_at >= q.created_at);
    const latestPerLead = new Map();
    for (const q of made) if (!latestPerLead.has(q.lead_id) || latestPerLead.get(q.lead_id).created_at < q.created_at) latestPerLead.set(q.lead_id, q);
    const followed = quotes.filter((q) => inRange(q.followup1_at) || inRange(q.followup2_at));
    const followBooked = followed.filter((q) => (jobsByLead.get(q.lead_id) || []).some((j) => j.created_at >= (q.followup1_at || q.followup2_at)));
    return {
      made: made.length,
      leads_quoted: latestPerLead.size,
      emailed: made.filter((q) => q.emailed_at).length,
      total_cents: sum(made, (q) => q.total_cents),
      avg_cents: made.length ? Math.round(sum(made, (q) => q.total_cents) / made.length) : null,
      booked: [...latestPerLead.values()].filter(bookedAfter).length,
      booking_rate: rate([...latestPerLead.values()].filter(bookedAfter).length, latestPerLead.size),
      followups_sent: quotes.filter((q) => inRange(q.followup1_at)).length + quotes.filter((q) => inRange(q.followup2_at)).length,
      followups_booked: followBooked.length,
    };
  }

  function messageStats({ texts, inRange, cohort }) {
    const during = texts.filter((t) => inRange(t.created_at));
    const out = during.filter((t) => t.direction === 'out');
    const kinds = countBy(out.filter((t) => t.status === 'sent'), (t) => TEXT_KINDS[t.trigger] || 'Other');
    // Of the leads a rep or a follow-up texted, how many wrote back afterwards.
    const reached = new Map();
    for (const t of out) if (t.status === 'sent' && ['manual', 'quote_followup', 'campaign', 'missed_call'].includes(t.trigger) && !reached.has(t.lead_id)) reached.set(t.lead_id, t.created_at);
    const replied = [...reached.entries()].filter(([id, at]) => texts.some((t) => t.lead_id === id && t.direction === 'in' && t.created_at > at)).length;
    return {
      sent: out.filter((t) => t.status === 'sent').length,
      failed: out.filter((t) => t.status === 'failed').length,
      received: during.filter((t) => t.direction === 'in').length,
      by_kind: Object.entries(kinds).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n),
      leads_texted: reached.size,
      replied,
      reply_rate: rate(replied, reached.size),
      missed_calls: cohort.filter((l) => l.source === 'call').length,
      missed_call_texts: out.filter((t) => t.trigger === 'missed_call' && t.status === 'sent').length,
    };
  }

  function emailStats({ inPipe, start, end }) {
    const rows = stmt('SELECT lead_id, status, trigger FROM emails WHERE created_at >= ? AND created_at < ?').all(start, end).filter((e) => inPipe(e.lead_id));
    const kinds = countBy(rows.filter((e) => e.status === 'sent'), (e) => EMAIL_KINDS[e.trigger] || 'Other');
    return {
      sent: rows.filter((e) => e.status === 'sent').length,
      failed: rows.filter((e) => e.status === 'failed').length,
      by_kind: Object.entries(kinds).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n),
    };
  }

  function bookingLinkStats({ inRange, inPipe }) {
    const links = stmt('SELECT lead_id, created_at, booked_at, amount_cents, cancelled_at FROM booking_links').all().filter((b) => inPipe(b.lead_id));
    const made = links.filter((b) => inRange(b.created_at));
    const booked = links.filter((b) => inRange(b.booked_at));
    return {
      sent: made.length,
      booked: booked.length,
      booked_rate: rate(made.filter((b) => b.booked_at).length, made.length),
      booked_cents: sum(booked, (b) => b.amount_cents),
    };
  }

  function campaignStats({ start, end }) {
    const rows = stmt('SELECT * FROM campaigns WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC').all(start, end);
    return rows.map((c) => {
      const counts = Object.fromEntries(stmt('SELECT status, COUNT(*) AS n FROM campaign_sends WHERE campaign_id = ? GROUP BY status').all(c.id).map((r) => [r.status, r.n]));
      const replied = stmt(`SELECT COUNT(DISTINCT s.lead_id) AS n FROM campaign_sends s WHERE s.campaign_id = ? AND s.status = 'sent'
                            AND EXISTS (SELECT 1 FROM texts t WHERE t.lead_id = s.lead_id AND t.direction = 'in' AND t.created_at > s.sent_at)`).get(c.id).n;
      const booked = stmt(`SELECT COUNT(DISTINCT s.lead_id) AS n FROM campaign_sends s WHERE s.campaign_id = ? AND s.status = 'sent'
                           AND EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = s.lead_id AND j.status != 'cancelled' AND j.created_at > s.sent_at)`).get(c.id).n;
      const revenue = stmt(`SELECT SUM(j.amount_cents) AS c FROM jobs j WHERE j.status != 'cancelled' AND j.lead_id IN
                             (SELECT s.lead_id FROM campaign_sends s WHERE s.campaign_id = ? AND s.status = 'sent' AND j.created_at > s.sent_at)`).get(c.id).c || 0;
      return { name: c.name, status: c.status, created_at: c.created_at, sent: counts.sent || 0, pending: counts.pending || 0, failed: counts.failed || 0, replied, booked, revenue_cents: revenue };
    });
  }

  function referralStats(cohort) {
    const referred = cohort.filter((l) => l.referrer_id);
    const names = new Map(stmt('SELECT id, name, kind FROM referrers').all().map((r) => [r.id, r]));
    const top = breakdown(referred, (l) => l.referrer_id).map((g) => ({ ...g, name: names.get(g.key)?.name || 'Unknown', kind: names.get(g.key)?.kind || '' }));
    return { leads: referred.length, booked: referred.filter((l) => l.booked).length, revenue_cents: sum(referred, (l) => l.revenue_cents), top: top.slice(0, 10) };
  }

  function shopStats({ start, end, allJobs, liveJobs, settings, inRange, inPipe }) {
    const pickedUp = allJobs.filter((j) => j.status === 'picked_up' && inRange(j.picked_up_at));
    const days = pickedUp.map((j) => (new Date(j.picked_up_at) - new Date(j.start_at)) / DAY).filter((d) => d >= 0);
    // Booked work hours that fall on days in the range, against the shop's open hours.
    const firstDay = new Date(new Date(start).setHours(0, 0, 0, 0));
    let booked = 0;
    for (const j of liveJobs) {
      if (j.end_at < start || j.start_at >= end) continue;
      const { days: spread } = ShopTime.allocate(j.start_at, j.end_at, ShopTime.jobHours(j, settings), settings);
      for (const d of spread) {
        const day = ShopTime.fromKey(d.date);
        if (day >= firstDay && day < new Date(end)) booked += d.hours;
      }
    }
    let capacity = 0;
    for (let d = new Date(firstDay); d < new Date(end); d.setDate(d.getDate() + 1)) {
      if (ShopTime.isWorkDay(d, settings)) capacity += settings.hours_per_day;
    }
    const photos = stmt('SELECT j.lead_id FROM job_photos p JOIN jobs j ON j.id = p.job_id WHERE p.created_at >= ? AND p.created_at < ?').all(start, end).filter((p) => inPipe(p.lead_id)).length;
    const checks = stmt('SELECT j.lead_id FROM job_checklist c JOIN jobs j ON j.id = c.job_id WHERE c.done_at >= ? AND c.done_at < ?').all(start, end).filter((c) => inPipe(c.lead_id)).length;
    const reviews = allJobs.filter((j) => j.review_sent_at && j.review_sent_at !== 'skipped' && inRange(j.review_sent_at)).length;
    return {
      dropped_off: liveJobs.filter((j) => inRange(j.start_at)).length,
      picked_up: pickedUp.length,
      cancelled: allJobs.filter((j) => j.status === 'cancelled' && inRange(j.updated_at)).length,
      avg_days_in_shop: days.length ? sum(days) / days.length : null,
      hours_booked: Math.round(booked * 10) / 10,
      hours_open: capacity,
      utilization: rate(booked, capacity),
      signoffs: allJobs.filter((j) => inRange(j.signoff_at)).length,
      photos,
      checklist_done: checks,
      review_requests: reviews,
      confirmations: allJobs.filter((j) => inRange(j.confirm_sent_at)).length,
      reminders: allJobs.filter((j) => inRange(j.reminder_sent_at)).length,
      ready_notices: allJobs.filter((j) => inRange(j.ready_sent_at)).length,
    };
  }

  // The shop's work timer: real hours against the hours each job was booked for.
  function laborStats({ start, end, allJobs, settings, inRange, leadById }) {
    const jobById = new Map(allJobs.map((j) => [j.id, j]));
    const at = new Date();
    const sessions = stmt('SELECT job_id, user_name, started_at, stopped_at FROM job_work').all().filter((s) => jobById.has(s.job_id));
    const msOf = (s) => Math.max(0, new Date(s.stopped_at || at) - new Date(s.started_at));
    const clipped = (s) => Math.max(0, Math.min(new Date(s.stopped_at || at), new Date(end)) - Math.max(new Date(s.started_at), new Date(start)));
    const H = 3600000;
    const round = (x) => (x == null ? null : Math.round(x * 100) / 100);

    // Hours worked during the period, by person.
    const people = new Map();
    for (const s of sessions) {
      const ms = clipped(s);
      if (!ms) continue;
      const p = people.get(s.user_name) || { name: s.user_name, ms: 0, jobs: new Set() };
      p.ms += ms;
      p.jobs.add(s.job_id);
      people.set(s.user_name, p);
    }
    const loggedMs = [...people.values()].reduce((n, p) => n + p.ms, 0);

    // Jobs whose work was finished during the period.
    const names = new Map(stmt('SELECT id, full_name, first_name, last_name, vehicle_year, vehicle_make, vehicle_model, vehicle_color FROM leads').all().map((l) => [l.id, l]));
    const byJob = new Map();
    for (const s of sessions) byJob.set(s.job_id, [...(byJob.get(s.job_id) || []), s]);
    const finished = allJobs.filter((j) => j.status !== 'cancelled' && inRange(j.work_finished_at) && byJob.has(j.id)).map((j) => {
      const l = names.get(j.lead_id) || {};
      const actual = byJob.get(j.id).reduce((n, s) => n + msOf(s), 0) / H;
      const booked = ShopTime.jobHours({ ...j, pipeline: leadById.get(j.lead_id)?.pipeline }, settings);
      return {
        job_id: j.id,
        lead_id: j.lead_id,
        name: l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Customer',
        vehicle: [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' '),
        vehicle_type: leadById.get(j.lead_id)?.vehicle_type || 'Not given',
        color: colorFamily(l.vehicle_color) || 'Not given',
        services: serviceLabels(parseServices(j.services)) || 'Not set',
        people: [...new Set(byJob.get(j.id).map((s) => s.user_name))],
        finished_at: j.work_finished_at,
        booked_hours: round(booked),
        actual_hours: round(actual),
        amount_cents: j.amount_cents,
        per_hour_cents: j.amount_cents != null && actual > 0 ? Math.round(j.amount_cents / actual) : null,
      };
    });
    const group = (keyOf) => {
      const m = new Map();
      for (const f of finished) {
        const k = keyOf(f);
        const g = m.get(k) || { key: k, jobs: 0, actual: 0, booked: 0, cents: 0, paidHours: 0 };
        g.jobs++;
        g.actual += f.actual_hours;
        g.booked += f.booked_hours;
        if (f.amount_cents != null) { g.cents += f.amount_cents; g.paidHours += f.actual_hours; }
        m.set(k, g);
      }
      return [...m.values()].map((g) => ({
        key: g.key,
        jobs: g.jobs,
        avg_actual_hours: round(g.actual / g.jobs),
        avg_booked_hours: round(g.booked / g.jobs),
        vs_booked: g.booked ? g.actual / g.booked : null,
        per_hour_cents: g.paidHours ? Math.round(g.cents / g.paidHours) : null,
      })).sort((a, b) => b.jobs - a.jobs);
    };
    const sumOf = (xs, f) => xs.reduce((n, x) => n + (f(x) || 0), 0);
    const actualAll = sumOf(finished, (f) => f.actual_hours);
    const bookedAll = sumOf(finished, (f) => f.booked_hours);
    const paid = finished.filter((f) => f.amount_cents != null && f.actual_hours > 0);
    const waits = allJobs.filter((j) => j.work_started_at && inRange(j.work_started_at)).map((j) => (new Date(j.work_started_at) - new Date(j.start_at)) / H).filter((x) => x >= 0);
    const pickups = allJobs.filter((j) => j.work_finished_at && j.picked_up_at && inRange(j.picked_up_at)).map((j) => (new Date(j.picked_up_at) - new Date(j.work_finished_at)) / H).filter((x) => x >= 0);
    const avg = (xs) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return {
      hours_logged: round(loggedMs / H),
      working_now: sessions.filter((s) => !s.stopped_at).length,
      jobs_finished: finished.length,
      avg_actual_hours: finished.length ? round(actualAll / finished.length) : null,
      avg_booked_hours: finished.length ? round(bookedAll / finished.length) : null,
      vs_booked: bookedAll ? actualAll / bookedAll : null,
      over_booked: finished.filter((f) => f.actual_hours > f.booked_hours * 1.15).length,
      under_booked: finished.filter((f) => f.actual_hours < f.booked_hours * 0.85).length,
      per_hour_cents: paid.length ? Math.round(sumOf(paid, (f) => f.amount_cents) / sumOf(paid, (f) => f.actual_hours)) : null,
      wait_to_start_hours: avg(waits),
      done_to_pickup_hours: avg(pickups),
      people: [...people.values()].map((p) => ({ name: p.name, hours: round(p.ms / H), jobs: p.jobs.size })).sort((a, b) => b.hours - a.hours),
      by_vehicle: group((f) => f.vehicle_type),
      by_service: group((f) => f.services),
      by_color: group((f) => f.color),
      learned: learnedNow(),
      jobs: finished.sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1)).slice(0, 50),
    };
  }

  // What the booking suggestions are using today (all finished jobs, not just this period).
  function learnedNow() {
    if (!estimates) return null;
    const m = estimates.model();
    return { samples: m.samples, types: m.types, colors: m.colors, services: m.services };
  }

  function commissionStats({ liveJobs, allJobs, inRange }) {
    const figures = liveJobs.map((j) => commissions.figures(j));
    return {
      commission_owed_cents: sum(figures.filter((f) => f.commission_status === 'owed'), (f) => f.commission_cents),
      commission_paid_cents: sum(allJobs.filter((j) => inRange(j.commission_paid_at)), (j) => j.commission_paid_cents),
    };
  }

  return { report };
}

function groupBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
function countBy(rows, keyOf, valueOf = () => 1) {
  const out = {};
  for (const r of rows) { const k = keyOf(r); out[k] = (out[k] || 0) + (valueOf(r) || 0); }
  return out;
}

module.exports = { createAnalyticsService };
