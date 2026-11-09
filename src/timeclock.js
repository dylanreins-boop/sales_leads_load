// The time clock, time off and pay. Sales and shop (and admins, if they like) clock in and out in the
// app and ask for time off; admins approve time off, set hourly pay rates, fix punches, and see each
// person's hours for a pay period: regular and overtime (over 40 hours in a week, Sunday to Saturday),
// paid time off, and gross pay.
const { HttpError } = require('./leads');
const { parseAmount } = require('./jobs');
const ShopTime = require('../public/shop-time');

const KINDS = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', unpaid: 'Unpaid' };
// Overtime after 40 hours a week by default. Daily overtime (Nevada has it for some workers) is off
// until an admin sets the hours.
const DEFAULTS = { ot_weekly_hours: 40, ot_daily_hours: null, ot_multiplier: 1.5, paid_kinds: ['vacation', 'sick'] };
const HOUR = 3600000;
const DAY = 86400000;
const norm = (s) => String(s || '').trim().toLowerCase();
const now = () => new Date().toISOString();
const round2 = (x) => Math.round(x * 100) / 100;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dateOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createTimeService(db, { users, getShopHours }) {
  const stmt = (sql) => db.prepare(sql);

  // ---- settings ----
  function getSettings() {
    try { return { ...DEFAULTS, ...JSON.parse(stmt("SELECT value FROM settings WHERE key = 'payroll'").get()?.value || '{}') }; } catch { return { ...DEFAULTS }; }
  }
  function saveSettings(input = {}) {
    const next = getSettings();
    if ('ot_weekly_hours' in input) {
      const h = Number(input.ot_weekly_hours);
      if (!(h >= 1 && h <= 80)) throw new HttpError(400, 'Overtime starts after 1 to 80 hours a week.');
      next.ot_weekly_hours = h;
    }
    if ('ot_daily_hours' in input) {
      const raw = input.ot_daily_hours;
      const h = raw == null || raw === '' || raw === false ? null : Number(raw);
      if (h != null && !(h >= 1 && h <= 24)) throw new HttpError(400, 'Daily overtime starts after 1 to 24 hours, or leave it off.');
      next.ot_daily_hours = h;
    }
    if ('ot_multiplier' in input) {
      const m = Number(input.ot_multiplier);
      if (!(m >= 1 && m <= 3)) throw new HttpError(400, 'Overtime pay is 1 to 3 times the rate.');
      next.ot_multiplier = m;
    }
    if ('paid_kinds' in input) next.paid_kinds = (input.paid_kinds || []).filter((k) => KINDS[k] && k !== 'unpaid');
    stmt("INSERT INTO settings (key, value) VALUES ('payroll', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  // ---- the clock ----
  const openPunch = (name) => stmt('SELECT * FROM time_punches WHERE name_norm = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(norm(name));
  const hoursOf = (p, at = new Date()) => Math.max(0, (new Date(p.clock_out || at) - new Date(p.clock_in)) / HOUR);

  function status(name, at = new Date()) {
    if (!name) throw new HttpError(400, 'Sign in to use the time clock.');
    closeForgotten(at);
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(week.getDate() - week.getDay());
    const since = (from) => stmt('SELECT * FROM time_punches WHERE name_norm = ? AND (clock_out IS NULL OR clock_out > ?)').all(norm(name), from.toISOString())
      .reduce((n, p) => n + Math.max(0, (Math.min(new Date(p.clock_out || at), at) - Math.max(new Date(p.clock_in), from)) / HOUR), 0);
    const on = openPunch(name);
    return {
      on_clock: Boolean(on),
      clock_in: on?.clock_in || null,
      today_hours: round2(since(today)),
      week_hours: round2(since(week)),
      time_off: mine(name),
    };
  }

  function clockIn(name, { at = new Date() } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to use the time clock.');
    closeForgotten(at); // yesterday's forgotten punch doesn't count as on the clock today
    if (openPunch(name)) return status(name, at);
    stmt('INSERT INTO time_punches (name_norm, user_name, clock_in, created_at) VALUES (?, ?, ?, ?)').run(norm(name), name, at.toISOString(), now());
    return status(name, at);
  }

  function clockOut(name, { at = new Date() } = {}) {
    closeForgotten(at);
    const p = openPunch(name);
    if (!p) throw new HttpError(400, 'You\'re not on the clock.');
    stmt('UPDATE time_punches SET clock_out = ? WHERE id = ?').run(new Date(Math.max(at, new Date(p.clock_in))).toISOString(), p.id);
    return status(name, at);
  }

  // Someone who forgot to clock out: closed at the end of the shop's day (or a normal day's hours
  // after they clocked in, if that was after closing), never past midnight, and flagged for an admin.
  function closeForgotten(at = new Date()) {
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    const set = getShopHours();
    for (const p of stmt('SELECT * FROM time_punches WHERE clock_out IS NULL AND clock_in < ?').all(today.toISOString())) {
      const start = new Date(p.clock_in);
      const close = ShopTime.windowOn(start, set).to;
      const midnight = new Date(start); midnight.setHours(24, 0, 0, 0);
      const end = start < close ? close : new Date(start.getTime() + set.hours_per_day * HOUR);
      stmt('UPDATE time_punches SET clock_out = ?, auto_closed = 1 WHERE id = ?').run(new Date(Math.min(end, midnight)).toISOString(), p.id);
    }
  }

  // ---- admins fix punches ----
  const parse = (v, what) => {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) throw new HttpError(400, `Pick the ${what} time.`);
    return d.toISOString();
  };
  function addPunch({ user_name: who, clock_in: a, clock_out: b, note } = {}, { user } = {}) {
    const name = String(who || '').trim();
    if (!name) throw new HttpError(400, 'Pick who the time is for.');
    const start = parse(a, 'clock-in');
    const end = parse(b, 'clock-out');
    if (end <= start) throw new HttpError(400, 'Clock-out has to be after clock-in.');
    if (new Date(end) - new Date(start) > 24 * HOUR) throw new HttpError(400, 'Add one day at a time.');
    const { lastInsertRowid } = stmt('INSERT INTO time_punches (name_norm, user_name, clock_in, clock_out, note, edited_by, edited_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(norm(name), name, start, end, String(note || '').trim().slice(0, 200) || null, user ?? null, now(), now());
    return stmt('SELECT * FROM time_punches WHERE id = ?').get(Number(lastInsertRowid));
  }
  function editPunch(id, { clock_in: a, clock_out: b, note } = {}, { user } = {}) {
    const p = stmt('SELECT * FROM time_punches WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'That time is gone.');
    const start = a ? parse(a, 'clock-in') : p.clock_in;
    const end = b ? parse(b, 'clock-out') : p.clock_out;
    if (end && end <= start) throw new HttpError(400, 'Clock-out has to be after clock-in.');
    stmt('UPDATE time_punches SET clock_in = ?, clock_out = ?, auto_closed = 0, note = COALESCE(?, note), edited_by = ?, edited_at = ? WHERE id = ?')
      .run(start, end, note == null ? null : String(note).trim().slice(0, 200) || null, user ?? null, now(), id);
    return stmt('SELECT * FROM time_punches WHERE id = ?').get(id);
  }
  function removePunch(id) {
    if (!stmt('SELECT 1 FROM time_punches WHERE id = ?').get(id)) throw new HttpError(404, 'That time is gone.');
    stmt('DELETE FROM time_punches WHERE id = ?').run(id);
    return { ok: true };
  }

  // ---- time off ----
  const shapeOff = (r) => {
    const days = Math.round((dateOf(r.end_date) - dateOf(r.start_date)) / DAY) + 1;
    return { ...r, kind_label: KINDS[r.kind] || r.kind, days, hours: round2(workDays(r).length * r.hours_per_day) };
  };
  // The days in a request the shop is open (time off on a closed day isn't counted).
  function workDays(r) {
    const set = getShopHours();
    const out = [];
    for (let d = dateOf(r.start_date); d <= dateOf(r.end_date); d.setDate(d.getDate() + 1)) if (ShopTime.isWorkDay(d, set)) out.push(keyOf(d));
    return out;
  }
  const mine = (name) => stmt("SELECT * FROM time_off WHERE name_norm = ? AND (status IN ('pending', 'approved') AND end_date >= ? OR created_at > ?) ORDER BY start_date")
    .all(norm(name), keyOf(new Date(Date.now() - 30 * DAY)), new Date(Date.now() - 30 * DAY).toISOString()).map(shapeOff);

  function requestOff(name, { start_date: a, end_date: b, kind = 'vacation', hours_per_day: hpd, note } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to ask for time off.');
    if (!isDate(a) || !isDate(b || a)) throw new HttpError(400, 'Pick the first and last day off.');
    const end = b || a;
    if (end < a) throw new HttpError(400, 'The last day off is before the first.');
    if (dateOf(end) - dateOf(a) > 60 * DAY) throw new HttpError(400, 'Ask for 60 days or fewer at a time.');
    if (!KINDS[kind]) throw new HttpError(400, 'Pick the kind of time off.');
    const perDay = getShopHours().hours_per_day;
    const hours = hpd == null || hpd === '' ? perDay : Number(hpd);
    if (!(hours > 0 && hours <= 24)) throw new HttpError(400, 'Hours a day should be between 1 and 24.');
    const overlap = stmt("SELECT 1 FROM time_off WHERE name_norm = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?").get(norm(name), end, a);
    if (overlap) throw new HttpError(400, 'You already have time off asked for on some of those days.');
    const { lastInsertRowid } = stmt('INSERT INTO time_off (name_norm, user_name, start_date, end_date, hours_per_day, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(norm(name), name, a, end, hours, kind, String(note || '').trim().slice(0, 300) || null, now());
    return shapeOff(stmt('SELECT * FROM time_off WHERE id = ?').get(Number(lastInsertRowid)));
  }

  function cancelOff(id, { user, role } = {}) {
    const r = stmt('SELECT * FROM time_off WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'That request is gone.');
    if (role !== 'admin' && norm(r.user_name) !== norm(user)) throw new HttpError(403, 'That isn\'t your request.');
    if (role !== 'admin' && r.status !== 'pending') throw new HttpError(400, 'It\'s already been decided. Ask an admin to change it.');
    stmt("UPDATE time_off SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?").run(user ?? null, now(), id);
    return shapeOff(stmt('SELECT * FROM time_off WHERE id = ?').get(id));
  }

  function decideOff(id, { status: s, note } = {}, { user } = {}) {
    if (!['approved', 'denied'].includes(s)) throw new HttpError(400, 'Approve or deny it.');
    const r = stmt('SELECT * FROM time_off WHERE id = ?').get(id);
    if (!r || r.status === 'cancelled') throw new HttpError(404, 'That request is gone.');
    stmt('UPDATE time_off SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(s, user ?? null, now(), String(note || '').trim().slice(0, 300) || null, id);
    return shapeOff(stmt('SELECT * FROM time_off WHERE id = ?').get(id));
  }

  const listOff = ({ status: s } = {}) => (s === 'pending'
    ? stmt("SELECT * FROM time_off WHERE status = 'pending' ORDER BY start_date").all()
    : stmt("SELECT * FROM time_off WHERE status != 'cancelled' ORDER BY start_date DESC LIMIT 300").all()).map(shapeOff);

  // Approved time off between two dates, for the shop calendar.
  // `from` and `to` are days ("2026-11-01") or times; `to` is the day after the last one shown.
  const dayArg = (v) => {
    if (isDate(v)) return v;
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) throw new HttpError(400, 'Pick the days to show.');
    return keyOf(d);
  };
  // Admins also get the note, who approved it and when (they click the bar to see it).
  const calendarOff = ({ from, to, full = false }) => stmt("SELECT * FROM time_off WHERE status = 'approved' AND start_date < ? AND end_date >= ?")
    .all(dayArg(to), dayArg(from)).map((r) => (full ? shapeOff(r) : { id: r.id, user_name: r.user_name, start_date: r.start_date, end_date: r.end_date, kind: r.kind, kind_label: KINDS[r.kind], hours_per_day: r.hours_per_day }));

  // ---- pay rates ----
  const rateOf = (name) => stmt('SELECT cents FROM pay_rates WHERE name_norm = ?').get(norm(name))?.cents ?? null;
  function setRate(name, amount, { user } = {}) {
    const who = String(name || '').trim();
    if (!who) throw new HttpError(400, 'Pick who the rate is for.');
    if (amount == null || String(amount).trim() === '') {
      stmt('DELETE FROM pay_rates WHERE name_norm = ?').run(norm(who));
      return { user_name: who, rate_cents: null };
    }
    let cents;
    try { cents = parseAmount(amount); } catch { cents = null; }
    if (!cents || cents < 0 || cents > 100000) throw new HttpError(400, 'Enter an hourly rate like 22.50.');
    stmt(`INSERT INTO pay_rates (name_norm, user_name, cents, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (name_norm) DO UPDATE SET cents = excluded.cents, user_name = excluded.user_name, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(norm(who), who, cents, user ?? null, now());
    return { user_name: who, rate_cents: cents };
  }

  // ---- the admins' Time & Pay numbers for a pay period ----
  function payroll({ from, to, at = new Date() } = {}) {
    if (!isDate(from) || !isDate(to) || to < from) throw new HttpError(400, 'Pick the pay period.');
    closeForgotten(at);
    const start = dateOf(from);
    const end = dateOf(to); end.setDate(end.getDate() + 1); // through the last day
    const settings = getSettings();
    const people = new Map();
    const person = (name) => {
      const k = norm(name);
      if (!people.has(k)) {
        const u = users.list().find((x) => norm(x.name) === k);
        people.set(k, { name: u?.name || name, role: u?.role || null, active: u ? u.active !== false : false, rate_cents: rateOf(name), punches: [], days: new Map(), time_off: [], pto_hours: 0, unpaid_off_hours: 0 });
      }
      return people.get(k);
    };
    for (const u of users.list()) if (u.active !== false && u.role !== 'admin') person(u.name);
    for (const k of stmt('SELECT name_norm, user_name FROM pay_rates').all()) person(k.user_name);

    // Worked hours, clipped to the period, added up by day and by week (Sunday to Saturday) for overtime.
    const punches = stmt('SELECT * FROM time_punches WHERE clock_in < ? AND (clock_out IS NULL OR clock_out > ?) ORDER BY clock_in').all(end.toISOString(), start.toISOString());
    for (const p of punches) {
      const who = person(p.user_name);
      const a = new Date(Math.max(new Date(p.clock_in), start));
      const b = new Date(Math.min(new Date(p.clock_out || at), end));
      const hours = Math.max(0, (b - a) / HOUR);
      who.punches.push({ ...p, auto_closed: Boolean(p.auto_closed), hours: round2(hoursOf(p, at)), open: !p.clock_out });
      const day = keyOf(a);
      who.days.set(day, (who.days.get(day) || 0) + hours);
    }
    // Approved time off on open days inside the period.
    for (const r of stmt("SELECT * FROM time_off WHERE status = 'approved' AND start_date <= ? AND end_date >= ?").all(to, from)) {
      const who = person(r.user_name);
      const days = workDays(r).filter((d) => d >= from && d <= to);
      if (!days.length) continue;
      const hours = days.length * r.hours_per_day;
      who.time_off.push({ ...shapeOff(r), hours_in_period: round2(hours) });
      if (settings.paid_kinds.includes(r.kind)) who.pto_hours += hours; else who.unpaid_off_hours += hours;
    }

    const rows = [...people.values()].map((p) => {
      // Daily overtime first (when it's on), then hours over the weekly limit.
      const weeks = new Map();
      for (const [day, h] of p.days) {
        const d = dateOf(day);
        const wk = keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
        const w = weeks.get(wk) || { regular: 0, overtime: 0 };
        const reg = settings.ot_daily_hours ? Math.min(h, settings.ot_daily_hours) : h;
        w.regular += reg;
        w.overtime += h - reg;
        weeks.set(wk, w);
      }
      let regular = 0;
      let overtime = 0;
      for (const w of weeks.values()) {
        regular += Math.min(w.regular, settings.ot_weekly_hours);
        overtime += w.overtime + Math.max(0, w.regular - settings.ot_weekly_hours);
      }
      const rate = p.rate_cents;
      const pay = rate == null ? null : Math.round(rate * regular + rate * settings.ot_multiplier * overtime + rate * p.pto_hours);
      return {
        name: p.name, role: p.role, active: p.active, rate_cents: rate,
        regular_hours: round2(regular), overtime_hours: round2(overtime), pto_hours: round2(p.pto_hours), unpaid_off_hours: round2(p.unpaid_off_hours),
        total_hours: round2(regular + overtime + p.pto_hours), gross_cents: pay,
        on_clock: p.punches.some((x) => x.open), flagged: p.punches.filter((x) => x.auto_closed).length,
        punches: p.punches, time_off: p.time_off,
      };
    }).filter((r) => r.active || r.punches.length || r.time_off.length)
      .sort((a, b) => (b.total_hours - a.total_hours) || a.name.localeCompare(b.name));
    const sum = (k) => round2(rows.reduce((n, r) => n + (r[k] || 0), 0));
    return {
      from, to, settings,
      rows,
      totals: { regular_hours: sum('regular_hours'), overtime_hours: sum('overtime_hours'), pto_hours: sum('pto_hours'), total_hours: sum('total_hours'), gross_cents: rows.reduce((n, r) => n + (r.gross_cents || 0), 0), missing_rates: rows.filter((r) => r.rate_cents == null && r.total_hours > 0).length },
      pending_time_off: listOff({ status: 'pending' }),
    };
  }

  return { status, clockIn, clockOut, closeForgotten, addPunch, editPunch, removePunch, requestOff, cancelOff, decideOff, listOff, calendarOff, setRate, rateOf, getSettings, saveSettings, payroll, KINDS };
}

module.exports = { createTimeService, TIME_OFF_KINDS: KINDS };
