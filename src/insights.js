'use strict';
// Lead scores (0-100, from simple rules, with the reasons), each lead's estimated job value and how
// long it's waited, and the numbers behind Overview and the Leaderboard. Everything here is counted from
// the database: nothing is guessed by AI.
const { HttpError } = require('./leads');
const { pipelineFor } = require('./vehicle');

const OPEN_STAGES = ['new', 'voicemail', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'contacted'];
const TALKED = ['contacted_follow_up', 'callback_requested', 'booked', 'not_interested'];
const BIG_TYPES = ['Coach / RV', 'Trailer / Toy Hauler', 'Boat', 'Plane', 'Semi'];
const DAY = 86400000;

// The scoring rules. Admins change the points (and the Hot / Warm lines) under Setup → Lead scoring.
const SCORE_RULES = [
  { id: 'appointment', label: 'Appointment on the calendar', points: 25 },
  { id: 'quote', label: 'Has a quote', points: 20 },
  { id: 'newer_vehicle', label: 'Vehicle is 3 years old or newer', points: 15 },
  { id: 'multi_service', label: 'Interested in 2 or more services', points: 15 },
  { id: 'phone', label: 'Has a phone number', points: 10 },
  { id: 'replied', label: 'Texted back', points: 10 },
  { id: 'talked', label: 'We\'ve talked to them', points: 10 },
  { id: 'fresh', label: 'Came in within the last 24 hours', points: 10 },
  { id: 'referral', label: 'Referred by someone', points: 10 },
  { id: 'big_vehicle', label: 'RV, trailer, boat, plane or semi (bigger job)', points: 10 },
  { id: 'email', label: 'Has an email', points: 5 },
  { id: 'no_answer_3', label: 'No answer 3 or more times', points: -10 },
  { id: 'opted_out', label: 'Opted out of texts', points: -5 },
];
const DEFAULT_SCORING = { points: Object.fromEntries(SCORE_RULES.map((r) => [r.id, r.points])), hot: 70, warm: 40 };

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

function createInsightService(db, { quotes, leads, roleOf = () => null, extraSuggestions = () => [] } = {}) {
  const stmt = (sql) => db.prepare(sql);

  // ---- scoring settings ----
  function getScoring() {
    const row = stmt("SELECT value FROM settings WHERE key = 'lead_score'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* defaults */ }
    return { points: { ...DEFAULT_SCORING.points, ...(saved.points || {}) }, hot: saved.hot ?? DEFAULT_SCORING.hot, warm: saved.warm ?? DEFAULT_SCORING.warm, rules: SCORE_RULES };
  }
  function saveScoring(input = {}) {
    const points = {};
    for (const r of SCORE_RULES) {
      const v = Number(input.points?.[r.id] ?? DEFAULT_SCORING.points[r.id]);
      if (!Number.isFinite(v) || v < -50 || v > 50) throw new HttpError(400, `Points for "${r.label}" have to be between -50 and 50.`);
      points[r.id] = Math.round(v);
    }
    const hot = Math.round(Number(input.hot ?? DEFAULT_SCORING.hot));
    const warm = Math.round(Number(input.warm ?? DEFAULT_SCORING.warm));
    if (!(hot > warm && warm > 0 && hot <= 100)) throw new HttpError(400, 'Hot has to be above Warm, and both between 1 and 100.');
    stmt("INSERT INTO settings (key, value) VALUES ('lead_score', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ points, hot, warm }));
    return getScoring();
  }

  // ---- what each lead's score and value need, for many leads at once ----
  function facts(ids) {
    if (!ids.length) return new Map();
    const list = ids.join(',');
    const by = (sql) => new Map(stmt(sql).all().map((r) => [r.lead_id, r]));
    const quotesBy = by(`SELECT q.lead_id, q.total_cents, q.lines, q.created_at, q.emailed_at FROM quotes q
                         WHERE q.lead_id IN (${list}) AND q.id = (SELECT MAX(id) FROM quotes WHERE lead_id = q.lead_id)`);
    const repliesBy = by(`SELECT lead_id, COUNT(*) AS n FROM texts WHERE direction = 'in' AND lead_id IN (${list}) GROUP BY lead_id`);
    const noAnswerBy = by(`SELECT lead_id, COUNT(*) AS n FROM activities WHERE type = 'disposition' AND disposition IN ('no_answer', 'no_answer_vm')
                           AND lead_id IN (${list}) GROUP BY lead_id`);
    const talkedBy = by(`SELECT lead_id, COUNT(*) AS n FROM activities WHERE type = 'disposition' AND disposition IN (${TALKED.map((t) => `'${t}'`).join(',')})
                         AND lead_id IN (${list}) GROUP BY lead_id`);
    const jobBy = by(`SELECT lead_id, MIN(start_at) AS start_at, amount_cents FROM jobs WHERE status IN ('scheduled', 'in_shop', 'ready')
                      AND lead_id IN (${list}) GROUP BY lead_id`);
    const referredBy = by(`SELECT id AS lead_id, referrer_id FROM leads WHERE referrer_id IS NOT NULL AND id IN (${list})`);
    const out = new Map();
    for (const id of ids) {
      out.set(id, {
        quote: quotesBy.get(id) || null, replies: repliesBy.get(id)?.n || 0, noAnswers: noAnswerBy.get(id)?.n || 0,
        talked: talkedBy.get(id)?.n || 0, job: jobBy.get(id) || null, referred: referredBy.has(id),
      });
    }
    return out;
  }

  // Typical job price by vehicle type (and by pipeline as a fallback), from the last year's jobs.
  function typicalPrices() {
    const since = new Date(Date.now() - 365 * DAY).toISOString();
    const rows = stmt(`SELECT l.vehicle_type, j.amount_cents FROM jobs j JOIN leads l ON l.id = j.lead_id
                       WHERE j.amount_cents > 0 AND j.status != 'cancelled' AND j.start_at >= ?`).all(since);
    const byType = new Map();
    const byPipe = new Map();
    for (const r of rows) {
      const add = (m, k) => m.set(k, [...(m.get(k) || []), r.amount_cents]);
      add(byType, r.vehicle_type || 'Other');
      add(byPipe, pipelineFor(r.vehicle_type));
    }
    const prices = quotes?.getPrices?.();
    const listMid = prices ? median(prices.vehicle.map((p) => p.price_cents).filter(Boolean)) : null;
    return (lead) => {
      const t = byType.get(lead.vehicle_type || 'Other');
      if (t && t.length >= 3) return median(t);
      const p = byPipe.get(pipelineFor(lead.vehicle_type));
      if (p && p.length >= 3) return median(p);
      return pipelineFor(lead.vehicle_type) === 'rv' ? null : listMid;
    };
  }

  // Adds score (with reasons), heat, estimated value and age to each lead row.
  function decorate(rows) {
    if (!rows.length) return rows;
    const s = getScoring();
    const f = facts(rows.map((r) => r.id));
    const typical = typicalPrices();
    const now = Date.now();
    const year = new Date().getFullYear();
    return rows.map((lead) => {
      const x = f.get(lead.id);
      const services = Array.isArray(lead.booked_services) ? lead.booked_services.length : 0;
      const quoteLines = x.quote ? (() => { try { return JSON.parse(x.quote.lines).filter((l) => l.cents > 0).length; } catch { return 0; } })() : 0;
      const hits = {
        appointment: Boolean(x.job),
        quote: Boolean(x.quote),
        newer_vehicle: Number(lead.vehicle_year) >= year - 3,
        multi_service: Math.max(services, quoteLines) >= 2,
        phone: Boolean(lead.phone),
        replied: x.replies > 0,
        talked: x.talked > 0,
        fresh: now - new Date(lead.received_at) < DAY,
        referral: x.referred || lead.source === 'referral',
        big_vehicle: BIG_TYPES.includes(lead.vehicle_type),
        email: Boolean(lead.email),
        no_answer_3: x.noAnswers >= 3,
        opted_out: lead.sms_opt_in === 0,
      };
      const reasons = SCORE_RULES.filter((r) => hits[r.id] && s.points[r.id]).map((r) => ({ label: r.label, points: s.points[r.id] }));
      const score = Math.max(0, Math.min(100, reasons.reduce((n, r) => n + r.points, 0)));
      const heat = score >= s.hot ? 'hot' : score >= s.warm ? 'warm' : 'cold';
      // Value: the job's price, else the latest quote, else what this kind of vehicle usually comes to.
      let value = null;
      let valueKind = null;
      if (x.job?.amount_cents) { value = x.job.amount_cents; valueKind = 'job'; }
      else if (x.quote) { value = x.quote.total_cents; valueKind = 'quote'; }
      else { value = typical(lead); valueKind = value ? 'typical' : null; }
      // Age: since the last real contact, or since it came in if nobody has reached them yet.
      const since = lead.last_contacted_at || lead.received_at;
      const hours = (now - new Date(since)) / 3600000;
      const age = !OPEN_STAGES.includes(lead.stage) || lead.archived_at ? null : hours < 24 ? 'fresh' : hours < 48 ? 'day' : hours < 72 ? 'two' : 'stale';
      return {
        ...lead, score, heat, score_reasons: reasons, value_cents: value, value_kind: valueKind,
        age, age_hours: Math.round(hours), quote_sent_at: x.quote ? (x.quote.emailed_at || x.quote.created_at) : null, next_job_at: x.job?.start_at || null,
      };
    });
  }

  // ---- per-person numbers for a period (Overview's "team today" and the Leaderboard) ----
  function repStats({ from, to }) {
    const a = new Date(from).toISOString();
    const b = new Date(to).toISOString();
    const people = new Map();
    const get = (name) => {
      if (!people.has(name)) people.set(name, { name, calls: 0, leads_called: new Set(), conversations: 0, appointments: 0, booked_cents: 0, quotes: 0, talk_seconds: 0, dialer_calls: 0, dialer_appointments: 0 });
      return people.get(name);
    };
    for (const r of stmt(`SELECT user_name, lead_id, disposition FROM activities WHERE type = 'disposition' AND disposition != 'updated_notes'
                          AND user_name IS NOT NULL AND created_at >= ? AND created_at < ?`).all(a, b)) {
      const p = get(r.user_name);
      p.calls += 1;
      p.leads_called.add(r.lead_id);
      if (TALKED.includes(r.disposition)) p.conversations += 1;
    }
    for (const r of stmt(`SELECT created_by, amount_cents FROM jobs WHERE status != 'cancelled' AND created_by IS NOT NULL AND created_at >= ? AND created_at < ?`).all(a, b)) {
      const p = get(r.created_by);
      p.appointments += 1;
      p.booked_cents += r.amount_cents || 0;
    }
    for (const r of stmt('SELECT created_by FROM quotes WHERE created_by IS NOT NULL AND created_at >= ? AND created_at < ?').all(a, b)) get(r.created_by).quotes += 1;
    // The dialer's calls (the dialer build): talk time, and how many led to a booking.
    for (const r of stmt(`SELECT c.user_name, c.talk_seconds, c.lead_id, c.started_at,
                            (SELECT COUNT(*) FROM activities x WHERE x.lead_id = c.lead_id AND x.type = 'disposition' AND x.disposition = 'booked'
                               AND x.created_at >= c.started_at AND x.created_at < datetime(c.started_at, '+1 hour')) AS booked
                          FROM calls c WHERE c.started_at >= ? AND c.started_at < ?`).all(a, b)) {
      const p = get(r.user_name);
      p.dialer_calls += 1;
      p.talk_seconds += r.talk_seconds || 0;
      if (r.booked) p.dialer_appointments += 1;
    }
    return [...people.values()]
      .filter((p) => roleOf(p.name) !== 'shop')
      .map((p) => ({
        name: p.name, calls: p.calls, leads_called: p.leads_called.size, conversations: p.conversations,
        contact_rate: pct(p.conversations, p.calls), appointments: p.appointments, booked_cents: p.booked_cents, quotes: p.quotes,
        conversion: pct(p.appointments, p.leads_called.size),
        avg_talk_seconds: p.dialer_calls ? Math.round(p.talk_seconds / p.dialer_calls) : null, dialer_calls: p.dialer_calls,
        dialer_appointment_rate: p.dialer_calls ? pct(p.dialer_appointments, p.dialer_calls) : null,
      }))
      .sort((x, y) => y.booked_cents - x.booked_cents || y.appointments - x.appointments || y.calls - x.calls);
  }

  // ---- Overview: the home screen ----
  function overview() {
    const now = new Date();
    const today = startOfDay(now);
    const weekAgo = new Date(today.getTime() - 7 * DAY);
    const twoWeeksAgo = new Date(today.getTime() - 14 * DAY);
    const iso = (d) => d.toISOString();
    const count = (sql, ...p) => stmt(sql).get(...p).n;
    const trend = (todayN, prevTotal) => {
      const avg = prevTotal / 7;
      return { avg: Math.round(avg * 10) / 10, change: avg ? Math.round(((todayN - avg) / avg) * 100) : null };
    };

    const newToday = count("SELECT COUNT(*) AS n FROM leads WHERE received_at >= ? AND source != 'import'", iso(today));
    const newPrev = count("SELECT COUNT(*) AS n FROM leads WHERE received_at >= ? AND received_at < ? AND source != 'import'", iso(weekAgo), iso(today));

    // Speed to first contact: the middle time from a lead coming in to the first call or text, this week vs last.
    const speed = (from, to) => median(stmt(`SELECT received_at, first_contacted_at FROM leads WHERE received_at >= ? AND received_at < ?
        AND first_contacted_at IS NOT NULL AND source NOT IN ('import', 'manual')`).all(iso(from), iso(to))
      .map((r) => Math.max(0, Math.round((new Date(r.first_contacted_at) - new Date(r.received_at)) / 1000))));
    const speedNow = speed(new Date(now.getTime() - 7 * DAY), now);
    const speedBefore = speed(new Date(now.getTime() - 14 * DAY), new Date(now.getTime() - 7 * DAY));
    const waiting = count(`SELECT COUNT(*) AS n FROM leads WHERE stage = 'new' AND first_contacted_at IS NULL AND archived_at IS NULL
                           AND received_at >= ?`, iso(new Date(now.getTime() - 7 * DAY)));

    const bookedToday = count("SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ? AND status != 'cancelled'", iso(today));
    const bookedPrev = count("SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'", iso(weekAgo), iso(today));
    const dropOffsWeek = count("SELECT COUNT(*) AS n FROM jobs WHERE start_at >= ? AND start_at < ? AND status != 'cancelled'", iso(today), iso(new Date(today.getTime() + 7 * DAY)));

    // The board, scored.
    const active = decorate(leads.listLeads({ view: 'active' }));
    const open = active.filter((l) => OPEN_STAGES.includes(l.stage));
    const quoted = open.filter((l) => l.value_kind === 'quote');
    const quotedValue = quoted.reduce((n, l) => n + (l.value_cents || 0), 0);
    const quoteSum = (from, to) => stmt('SELECT COALESCE(SUM(total_cents), 0) AS n FROM quotes WHERE created_at >= ? AND created_at < ?').get(iso(from), iso(to)).n;

    const card = (l) => ({
      id: l.id, name: l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || l.email || `Lead #${l.id}`,
      vehicle: [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ') || l.vehicle_type || '', vehicle_type: l.vehicle_type,
      source: l.source, received_at: l.received_at, stage: l.stage, score: l.score, heat: l.heat, value_cents: l.value_cents, value_kind: l.value_kind,
      age: l.age, age_hours: l.age_hours, next_reminder_at: l.next_reminder_at, needs_reply: l.needs_reply, no_next_step: l.no_next_step,
      last_contacted_at: l.last_contacted_at, quote_sent_at: l.quote_sent_at, next_job_at: l.next_job_at, pipeline: l.pipeline,
    });
    const column = (id, label, list, sort) => ({
      id, label, count: list.length, value_cents: list.reduce((n, l) => n + (l.value_cents || 0), 0), leads: [...list].sort(sort).slice(0, 4).map(card),
    });
    const byScore = (a, b) => b.score - a.score || a.received_at.localeCompare(b.received_at);
    const upcoming = active.filter((l) => l.stage === 'booked' && l.next_job_at && !l.archived_at);
    const snapshot = [
      column('new', 'New', open.filter((l) => l.stage === 'new' && l.value_kind !== 'quote'), byScore),
      column('contacted', 'Contacted', open.filter((l) => l.stage !== 'new' && l.value_kind !== 'quote'), byScore),
      column('quoted', 'Quoted', quoted, byScore),
      column('booked', 'Booked', upcoming, (a, b) => a.next_job_at.localeCompare(b.next_job_at)),
    ];

    // Suggestions: each one counted from the data, pointing at the leads behind it.
    const q = leads.workQueue();
    const name = (l) => l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || `Lead #${l.id}`;
    const scored = new Map(active.map((l) => [l.id, l]));
    const suggestions = [];
    const firstCall = q.fresh.map((l) => scored.get(l.id)).filter(Boolean).sort(byScore)[0];
    if (firstCall) {
      const hrs = Math.round((Date.now() - new Date(firstCall.received_at)) / 3600000);
      suggestions.push({ kind: 'call', title: `Call ${name(firstCall)} first`, detail: `New ${firstCall.source} lead · ${hrs < 1 ? 'under an hour' : `${hrs}h`} old · score ${firstCall.score} (${firstCall.heat}). No call yet.`, lead_id: firstCall.id });
    }
    if (q.replies.length) suggestions.push({ kind: 'reply', title: `${q.replies.length} customer${q.replies.length === 1 ? '' : 's'} texted back`, detail: `Oldest: ${name(q.replies[0])}: "${(q.replies[0].reply || '').slice(0, 70)}"`, open: 'todo' });
    if (q.quotes.length) {
      const total = q.quotes.reduce((n, l) => n + (l.quote.total_cents || 0), 0);
      suggestions.push({ kind: 'quote', title: `${q.quotes.length} quote${q.quotes.length === 1 ? ' needs' : 's need'} a follow-up`, detail: `No call or text since the quote went out. Together about $${Math.round(total / 100).toLocaleString('en-US')}.`, open: 'todo' });
    }
    if (q.stuck.length) suggestions.push({ kind: 'stuck', title: `${q.stuck.length} lead${q.stuck.length === 1 ? ' has' : 's have'} no next step`, detail: 'Talked to, not booked, and no call planned.', open: 'todo' });
    const noDeposit = count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'scheduled' AND deposit_cents IS NULL AND start_at >= ? AND start_at < ?",
      iso(now), iso(new Date(now.getTime() + 3 * DAY)));
    if (noDeposit) suggestions.push({ kind: 'deposit', title: `${noDeposit} drop-off${noDeposit === 1 ? '' : 's'} in the next 3 days without a deposit`, detail: 'Collect it at drop-off, or mark it waived.', open: 'commissions' });
    suggestions.push(...extraSuggestions());

    // The call queue: what's due, and who to call next.
    const reminders = leads.listReminders();
    const endToday = new Date(today.getTime() + DAY);
    const due = reminders.filter((r) => new Date(r.due_at) < endToday);
    const overdue = reminders.filter((r) => new Date(r.due_at) <= now);
    const nextUp = q.replies[0] ? { id: q.replies[0].id, name: name(q.replies[0]), why: 'Texted back' }
      : overdue[0] ? { id: overdue[0].lead_id, name: name(overdue[0]), why: 'Call due now' }
        : firstCall ? { id: firstCall.id, name: name(firstCall), why: `New ${firstCall.source} lead` }
          : null;

    return {
      at: now.toISOString(),
      kpis: {
        new_today: { value: newToday, ...trend(newToday, newPrev) },
        speed: { seconds: speedNow, before_seconds: speedBefore, waiting },
        booked_today: { value: bookedToday, ...trend(bookedToday, bookedPrev), drop_offs_week: dropOffsWeek },
        quoted: { value_cents: quotedValue, count: quoted.length, this_week_cents: quoteSum(weekAgo, endToday), last_week_cents: quoteSum(twoWeeksAgo, weekAgo) },
      },
      snapshot,
      suggestions,
      team: repStats({ from: today, to: endToday }),
      queue: { due: due.length, overdue: overdue.length, replies: q.replies.length, fresh: q.fresh.length, next: nextUp },
    };
  }

  return { getScoring, saveScoring, decorate, repStats, overview, SCORE_RULES };
}

module.exports = { createInsightService, SCORE_RULES, OPEN_STAGES, median, startOfDay, pct, DAY };
