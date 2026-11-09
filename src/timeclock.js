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
// Attendance: late or early by more than `grace_minutes` counts; lunch over `lunch_minutes` (plus grace) is long.
// Paid weekly, Sunday to Saturday: everyone approves their week when they clock out on `review_day`
// (Friday), and the week's summary is emailed to `payroll_emails`.
const DEFAULTS = { ot_weekly_hours: 40, ot_daily_hours: null, ot_multiplier: 1.5, paid_kinds: ['vacation', 'sick'], grace_minutes: 5, lunch_minutes: 30, review_day: 5, payroll_emails: [] };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const ISSUES = ['late', 'early', 'long_lunch', 'no_show', 'missed_out'];
const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
const minutesOf = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const HOUR = 3600000;
const DAY = 86400000;
const norm = (s) => String(s || '').trim().toLowerCase();
const now = () => new Date().toISOString();
const round2 = (x) => Math.round(x * 100) / 100;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dateOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createTimeService(db, { users, getShopHours, mailer = null, brand = {}, publicUrl = '' }) {
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
    for (const [key, max, what] of [['grace_minutes', 60, 'Late counts after 0 to 60 minutes.'], ['lunch_minutes', 180, 'Lunch can be 0 to 180 minutes.']]) {
      if (!(key in input)) continue;
      const v = Number(input[key]);
      if (!(v >= 0 && v <= max)) throw new HttpError(400, what);
      next[key] = v;
    }
    if ('review_day' in input) {
      const d = Number(input.review_day);
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new HttpError(400, 'Pick the day people approve their week.');
      next.review_day = d;
    }
    if ('payroll_emails' in input) {
      const list = (Array.isArray(input.payroll_emails) ? input.payroll_emails : String(input.payroll_emails || '').split(/[,;\s]+/)).map((e) => e.trim()).filter(Boolean);
      const bad = list.find((e) => !isEmail(e));
      if (bad) throw new HttpError(400, `${bad} isn't an email address.`);
      next.payroll_emails = [...new Set(list)].slice(0, 10);
    }
    if ('paid_kinds' in input) next.paid_kinds = (input.paid_kinds || []).filter((k) => KINDS[k] && k !== 'unpaid');
    stmt("INSERT INTO settings (key, value) VALUES ('payroll', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  // ---- the clock ----
  const openPunch = (name) => stmt('SELECT * FROM time_punches WHERE name_norm = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(norm(name));
  const hoursOf = (p, at = new Date()) => Math.max(0, (new Date(p.clock_out || at) - new Date(p.clock_in)) / HOUR);

  // Today's punches for someone, in order.
  const todayPunches = (name, at) => {
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    return stmt('SELECT * FROM time_punches WHERE name_norm = ? AND clock_in >= ? ORDER BY clock_in').all(norm(name), today.toISOString());
  };
  // On lunch: their last punch today ended for lunch and they haven't come back yet.
  const lunchPunch = (name, at) => {
    if (openPunch(name)) return null;
    const last = todayPunches(name, at).at(-1);
    return last?.out_reason === 'lunch' ? last : null;
  };

  function status(name, at = new Date()) {
    if (!name) throw new HttpError(400, 'Sign in to use the time clock.');
    closeForgotten(at);
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(week.getDate() - week.getDay());
    const punches = stmt('SELECT * FROM time_punches WHERE name_norm = ? AND (clock_out IS NULL OR clock_out > ?)').all(norm(name), week.toISOString());
    const between = (from, to) => punches.reduce((n, p) => n + Math.max(0, (Math.min(new Date(p.clock_out || at), at, to) - Math.max(new Date(p.clock_in), from)) / HOUR), 0);
    const on = openPunch(name);
    const lunch = lunchPunch(name, at);
    const shift = todayPunches(name, at);
    return {
      on_clock: Boolean(on),
      on_lunch: Boolean(lunch),
      clock_in: on?.clock_in || null,
      lunch_started_at: lunch?.clock_out || null,
      shift_started_at: shift[0]?.clock_in || null,
      today: shift.map((p) => ({ clock_in: p.clock_in, clock_out: p.clock_out, out_reason: p.out_reason, auto_closed: Boolean(p.auto_closed) })),
      today_hours: round2(between(today, new Date(today.getTime() + DAY))),
      week_hours: round2(between(week, new Date(week.getTime() + 7 * DAY))),
      // Sunday to Saturday, for the little week chart.
      week_days: Array.from({ length: 7 }, (_, i) => {
        const from = new Date(week); from.setDate(week.getDate() + i);
        const to = new Date(from); to.setDate(from.getDate() + 1);
        return { date: keyOf(from), hours: round2(between(from, to)) };
      }),
      time_off: mine(name),
      ...weekReview(name, at, Boolean(on || lunch)),
    };
  }

  // ---- approving your own week ----
  const weekStartOf = (at) => { const d = new Date(at); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return keyOf(d); };
  const signoffOf = (name, week) => stmt('SELECT * FROM week_signoffs WHERE name_norm = ? AND week_start = ?').get(norm(name), week);
  // The day someone approves their week: Friday (the setting), or their last scheduled day if they
  // don't work that day.
  function reviewDayFor(name) {
    const day = getSettings().review_day;
    const sched = scheduleOf(name);
    if (!sched || sched[day] || !sched.some(Boolean)) return day;
    const before = [0, 1, 2, 3, 4, 5, 6].filter((i) => i <= day && sched[i]);
    return before.length ? before.at(-1) : sched.findLastIndex(Boolean);
  }
  function weekReview(name, at, working) {
    const week = weekStartOf(at);
    const signed = signoffOf(name, week);
    const day = reviewDayFor(name);
    return {
      week_start: week,
      week_signed_off_at: signed?.approved_at || null,
      review_day: DAY_NAMES[day],
      review_required: working && !signed && new Date(at).getDay() === day,
    };
  }
  function approveWeek(name, { at = new Date() } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to approve your time.');
    const s = status(name, at);
    stmt(`INSERT INTO week_signoffs (name_norm, user_name, week_start, hours, approved_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (name_norm, week_start) DO UPDATE SET hours = excluded.hours, approved_at = excluded.approved_at`)
      .run(norm(name), name, s.week_start, s.week_hours, new Date(at).toISOString());
    return status(name, at);
  }

  // Clocking in again after lunch is coming back from lunch.
  function clockIn(name, { at = new Date() } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to use the time clock.');
    closeForgotten(at); // yesterday's forgotten punch doesn't count as on the clock today
    if (openPunch(name)) return status(name, at);
    stmt('INSERT INTO time_punches (name_norm, user_name, clock_in, created_at) VALUES (?, ?, ?, ?)').run(norm(name), name, at.toISOString(), now());
    return status(name, at);
  }

  // Clocking out on lunch ends the day where lunch started (lunch isn't paid).
  // Going home on review day (Friday) takes approving the week first, or with it (approveWeek).
  function clockOut(name, { at = new Date(), reason = null, approveWeek: approving = false } = {}) {
    closeForgotten(at);
    if (!reason && !approving) {
      const r = weekReview(name, at, Boolean(openPunch(name) || lunchPunch(name, at)));
      if (r.review_required) {
        const err = new HttpError(409, `Review and approve your week before you clock out on ${r.review_day}.`);
        err.code = 'week_review';
        throw err;
      }
    }
    finishClockOut(name, { at, reason });
    return approving ? approveWeek(name, { at }) : status(name, at);
  }
  function finishClockOut(name, { at, reason }) {
    const p = openPunch(name);
    if (!p) {
      const lunch = lunchPunch(name, at);
      if (lunch && !reason) {
        stmt('UPDATE time_punches SET out_reason = NULL WHERE id = ?').run(lunch.id);
        return status(name, at);
      }
      throw new HttpError(400, lunch ? 'You\'re already on lunch.' : 'You\'re not on the clock.');
    }
    stmt('UPDATE time_punches SET clock_out = ?, out_reason = ? WHERE id = ?').run(new Date(Math.max(at, new Date(p.clock_in))).toISOString(), reason, p.id);
    return status(name, at);
  }

  // Lunch: off the clock (unpaid) until they come back with Clock in / End lunch.
  const startLunch = (name, opts = {}) => clockOut(name, { ...opts, reason: 'lunch' });

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

  // ---- timecards and corrections ----
  // Someone's own punches for a period (days "2026-11-01" to "2026-11-14"), with the corrections they asked for.
  function timecard(name, { from, to } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to see your timecard.');
    if (!isDate(from) || !isDate(to) || to < from) throw new HttpError(400, 'Pick the days to show.');
    closeForgotten();
    const start = dateOf(from);
    const end = dateOf(to); end.setDate(end.getDate() + 1);
    const pending = new Set(stmt("SELECT punch_id FROM time_corrections WHERE name_norm = ? AND status = 'pending' AND punch_id IS NOT NULL").all(norm(name)).map((r) => r.punch_id));
    const punches = stmt('SELECT * FROM time_punches WHERE name_norm = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in').all(norm(name), start.toISOString(), end.toISOString())
      .map((p) => ({ id: p.id, clock_in: p.clock_in, clock_out: p.clock_out, out_reason: p.out_reason, auto_closed: Boolean(p.auto_closed), edited_by: p.edited_by, note: p.note, hours: round2(hoursOf(p)), correction_pending: pending.has(p.id) }));
    const corrections = stmt('SELECT * FROM time_corrections WHERE name_norm = ? AND (status = \'pending\' OR created_at > ?) ORDER BY created_at DESC LIMIT 50')
      .all(norm(name), new Date(Date.now() - 60 * DAY).toISOString());
    return { from, to, punches, total_hours: round2(punches.reduce((n, p) => n + p.hours, 0)), corrections };
  }

  // Ask for a correction: change a punch's times, add time that was never clocked, or remove a punch.
  function requestCorrection(name, { punch_id: punchId, action = 'change', clock_in: a, clock_out: b, reason } = {}) {
    if (!name) throw new HttpError(400, 'Sign in to ask for a correction.');
    if (!['change', 'add', 'remove'].includes(action)) throw new HttpError(400, 'Change, add or remove time.');
    const why = String(reason || '').trim().slice(0, 300);
    if (!why) throw new HttpError(400, 'Say what happened so the admin knows why.');
    let punch = null;
    if (action !== 'add') {
      punch = stmt('SELECT * FROM time_punches WHERE id = ?').get(Number(punchId));
      if (!punch || punch.name_norm !== norm(name)) throw new HttpError(404, 'That time isn\'t on your timecard.');
      if (stmt("SELECT 1 FROM time_corrections WHERE punch_id = ? AND status = 'pending'").get(punch.id)) throw new HttpError(400, 'You already asked to fix that time. Wait for an admin, or cancel that request first.');
    }
    let start = null;
    let end = null;
    if (action !== 'remove') {
      start = parse(a, 'clock-in');
      end = b ? parse(b, 'clock-out') : null;
      if (!end && action === 'add') throw new HttpError(400, 'Pick the clock-out time.');
      if (end && end <= start) throw new HttpError(400, 'Clock-out has to be after clock-in.');
      if (end && new Date(end) - new Date(start) > 24 * HOUR) throw new HttpError(400, 'Ask for one day at a time.');
      if (new Date(start) > new Date(Date.now() + 5 * 60000)) throw new HttpError(400, 'That time hasn\'t happened yet.');
      if (punch && start === punch.clock_in && end === punch.clock_out) throw new HttpError(400, 'Those are the times already on your timecard.');
    }
    const { lastInsertRowid } = stmt(`INSERT INTO time_corrections (name_norm, user_name, punch_id, action, clock_in, clock_out, old_clock_in, old_clock_out, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(norm(name), name, punch?.id ?? null, action, start, end, punch?.clock_in ?? null, punch?.clock_out ?? null, why, now());
    return stmt('SELECT * FROM time_corrections WHERE id = ?').get(Number(lastInsertRowid));
  }

  function cancelCorrection(id, { user, role } = {}) {
    const c = stmt('SELECT * FROM time_corrections WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'That request is gone.');
    if (role !== 'admin' && c.name_norm !== norm(user)) throw new HttpError(403, 'That isn\'t your request.');
    if (c.status !== 'pending') throw new HttpError(400, 'It\'s already been decided.');
    stmt("UPDATE time_corrections SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?").run(user ?? null, now(), id);
    return stmt('SELECT * FROM time_corrections WHERE id = ?').get(id);
  }

  // Approving makes the change on the timecard (and so in Time & Pay); denying leaves it as it was.
  function decideCorrection(id, { status: s, note } = {}, { user } = {}) {
    if (!['approved', 'denied'].includes(s)) throw new HttpError(400, 'Approve or deny it.');
    const c = stmt('SELECT * FROM time_corrections WHERE id = ?').get(id);
    if (!c || c.status === 'cancelled') throw new HttpError(404, 'That request is gone.');
    if (c.status !== 'pending') throw new HttpError(400, 'It\'s already been decided.');
    if (s === 'approved') {
      const why = `Correction they asked for: ${c.reason}`.slice(0, 200);
      if (c.action === 'add') addPunch({ user_name: c.user_name, clock_in: c.clock_in, clock_out: c.clock_out, note: why }, { user });
      else if (!stmt('SELECT 1 FROM time_punches WHERE id = ?').get(c.punch_id)) throw new HttpError(400, 'That time was already removed. Deny this one.');
      else if (c.action === 'remove') removePunch(c.punch_id);
      else editPunch(c.punch_id, { clock_in: c.clock_in, clock_out: c.clock_out || undefined, note: why }, { user });
    }
    stmt('UPDATE time_corrections SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?')
      .run(s, user ?? null, now(), String(note || '').trim().slice(0, 300) || null, id);
    return stmt('SELECT * FROM time_corrections WHERE id = ?').get(id);
  }

  const listCorrections = ({ status: s } = {}) => (s === 'pending'
    ? stmt("SELECT * FROM time_corrections WHERE status = 'pending' ORDER BY created_at").all()
    : stmt("SELECT * FROM time_corrections WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT 300").all());

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

  // ---- work schedules (admins) ----
  const scheduleOf = (name) => {
    const row = stmt('SELECT days FROM work_schedules WHERE name_norm = ?').get(norm(name));
    try { return row ? JSON.parse(row.days) : null; } catch { return null; }
  };
  // Everyone who clocks in (not admins), with their schedule: days[0..6] (Sunday first), each null or { start, end }.
  function listSchedules() {
    const people = users.list().filter((u) => u.active !== false && u.role !== 'admin');
    const seen = new Set();
    return people.filter((u) => !seen.has(norm(u.name)) && seen.add(norm(u.name)))
      .map((u) => ({ user_name: u.name, role: u.role, days: scheduleOf(u.name) || Array(7).fill(null) }));
  }
  function saveSchedules(list, { user } = {}) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Send the schedules.');
    const clean = list.map((s) => {
      const name = String(s.user_name || '').trim();
      if (!name) throw new HttpError(400, 'Each schedule needs a person.');
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = s.days?.[i];
        if (!d) return null;
        if (!isTime(d.start) || !isTime(d.end)) throw new HttpError(400, `Pick start and end times for ${name}.`);
        if (minutesOf(d.end) <= minutesOf(d.start)) throw new HttpError(400, `${name}'s shift has to end after it starts.`);
        return { start: d.start, end: d.end };
      });
      return { name, days };
    });
    for (const { name, days } of clean) {
      if (days.every((d) => !d)) stmt('DELETE FROM work_schedules WHERE name_norm = ?').run(norm(name));
      else stmt(`INSERT INTO work_schedules (name_norm, user_name, days, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (name_norm) DO UPDATE SET user_name = excluded.user_name, days = excluded.days, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(norm(name), name, JSON.stringify(days), user ?? null, now());
    }
    return listSchedules();
  }

  // One person's days in the period: schedule, punches, lunch, hours and what went wrong.
  function attendance(p, { from, to, at, settings }) {
    const sched = scheduleOf(p.name);
    const grace = settings.grace_minutes;
    const todayKey = keyOf(at);
    const days = [];
    for (let d = dateOf(from); keyOf(d) <= to && keyOf(d) <= todayKey; d.setDate(d.getDate() + 1)) {
      const key = keyOf(d);
      const plan = sched?.[d.getDay()] || null;
      const punches = p.punches.filter((x) => keyOf(new Date(x.clock_in)) === key);
      const off = p.time_off.find((r) => r.start_date <= key && r.end_date >= key) || null;
      if (!plan && !punches.length && !off) continue;
      const at0 = (t) => { const x = new Date(d); x.setHours(0, minutesOf(t), 0, 0); return x; };
      const lunches = [];
      for (let i = 1; i < punches.length; i++) {
        const gapFrom = punches[i - 1].clock_out;
        if (gapFrom) lunches.push({ from: gapFrom, to: punches[i].clock_in, minutes: Math.round((new Date(punches[i].clock_in) - new Date(gapFrom)) / 60000) });
      }
      const last = punches.at(-1);
      const onLunch = last && last.out_reason === 'lunch' && key === todayKey;
      if (onLunch) lunches.push({ from: last.clock_out, to: null, minutes: Math.round((at - new Date(last.clock_out)) / 60000) });
      const lunchMinutes = lunches.reduce((n, l) => n + l.minutes, 0);
      const issues = [];
      const dayOver = key < todayKey || (plan && at > at0(plan.end));
      if (plan && !off) {
        if (!punches.length) {
          if (dayOver) issues.push({ type: 'no_show' });
        } else {
          const late = Math.round((new Date(punches[0].clock_in) - at0(plan.start)) / 60000);
          if (late > grace) issues.push({ type: 'late', minutes: late });
          if (last.clock_out && !last.open && !onLunch && !last.auto_closed) {
            const early = Math.round((at0(plan.end) - new Date(last.clock_out)) / 60000);
            if (early > grace) issues.push({ type: 'early', minutes: early });
          }
        }
      }
      if (settings.lunch_minutes && lunchMinutes > settings.lunch_minutes + grace) issues.push({ type: 'long_lunch', minutes: lunchMinutes - settings.lunch_minutes });
      if (punches.some((x) => x.auto_closed)) issues.push({ type: 'missed_out' });
      days.push({
        date: key, schedule: plan, off: off ? { kind: off.kind, kind_label: off.kind_label } : null,
        punches, first_in: punches[0]?.clock_in || null, last_out: last && !last.open && !onLunch ? last.clock_out : null,
        open: Boolean(last?.open), on_lunch: Boolean(onLunch), lunches, lunch_minutes: lunchMinutes,
        hours: round2(punches.reduce((n, x) => n + x.hours, 0)), issues,
      });
    }
    return { days, has_schedule: Boolean(sched?.some(Boolean)) };
  }

  // ---- pay weeks: everyone's sign-off, the admins' email, the admins' approval ----
  const payWeek = (start) => stmt('SELECT * FROM payroll_weeks WHERE week_start = ?').get(start) || { week_start: start };
  const savePayWeek = (start, fields) => {
    const cur = payWeek(start);
    const next = { ...cur, ...fields };
    stmt(`INSERT INTO payroll_weeks (week_start, emailed_at, emailed_to, approved_by, approved_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (week_start) DO UPDATE SET emailed_at = excluded.emailed_at, emailed_to = excluded.emailed_to, approved_by = excluded.approved_by, approved_at = excluded.approved_at`)
      .run(start, next.emailed_at ?? null, next.emailed_to ?? null, next.approved_by ?? null, next.approved_at ?? null);
  };
  const weekEnd = (start) => { const d = dateOf(start); d.setDate(d.getDate() + 6); return keyOf(d); };
  // Only for a period that's exactly one Sunday-to-Saturday week. Who needs to sign off: anyone who
  // worked that week or was scheduled to.
  function weekInfo(from, to, rows) {
    if (dateOf(from).getDay() !== 0 || weekEnd(from) !== to) return null;
    const signoffs = rows.map((r) => {
      const s = signoffOf(r.name, from);
      const worked = r.regular_hours + r.overtime_hours;
      const expected = worked > 0 || r.days.some((d) => d.schedule && !d.off);
      return { user_name: r.name, expected, approved_at: s?.approved_at || null, hours: s?.hours ?? null, changed: Boolean(s && Math.abs(s.hours - worked) > 0.02), worked: round2(worked) };
    }).filter((x) => x.expected || x.approved_at);
    const w = payWeek(from);
    return { start: from, end: to, signoffs, all_signed: signoffs.every((x) => x.approved_at), email_ready: Boolean(mailer?.configured), emailed_at: w.emailed_at || null, emailed_to: w.emailed_to ? JSON.parse(w.emailed_to) : [], approved_by: w.approved_by || null, approved_at: w.approved_at || null };
  }

  function approvePayrollWeek(start, { user } = {}) {
    if (!isDate(start) || dateOf(start).getDay() !== 0) throw new HttpError(400, 'Pick a week starting on Sunday.');
    savePayWeek(start, { approved_by: user ?? 'Admin', approved_at: now() });
    return payroll({ from: start, to: weekEnd(start) });
  }

  // The week's summary for payroll, as plain text and a CSV.
  const usd = (c) => (c == null ? 'no rate' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const hrs = (h) => (h ? `${round2(h)} h` : '-');
  const fmtDay = (key) => dateOf(key).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtAt = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function weekEmail(start) {
    const r = payroll({ from: start, to: weekEnd(start) });
    const w = r.week;
    const waiting = w.signoffs.filter((x) => !x.approved_at).map((x) => x.user_name);
    const cols = [['Name', 14], ['Rate', 10], ['Regular', 9], ['Overtime', 9], ['Paid off', 9], ['Total', 9], ['Gross pay', 12], ['Approved their time', 0]];
    const line = (vals) => vals.map((v, i) => (cols[i][1] ? String(v).padEnd(cols[i][1]) : String(v))).join(' ');
    const signed = (name) => {
      const x = w.signoffs.find((s) => s.user_name === name);
      if (!x) return '-';
      if (!x.approved_at) return 'NOT YET';
      return `${fmtAt(x.approved_at)}${x.changed ? ' (hours changed since)' : ''}`;
    };
    const t = r.totals;
    const issues = Object.entries(r.issues).filter(([, n]) => n).map(([k, n]) => `${n} ${{ late: 'late arrival', early: 'left early', long_lunch: 'long lunch', no_show: 'no-show', missed_out: 'forgot to clock out' }[k]}${n === 1 || k === 'early' ? '' : 's'}`);
    const text = [
      `Payroll for ${fmtDay(start)} - ${fmtDay(w.end)}`,
      waiting.length ? `Still waiting on: ${waiting.join(', ')} (hasn't approved their time).` : 'Everyone approved their time.',
      '',
      line(cols.map((c) => c[0])),
      ...r.rows.map((x) => line([x.name, x.rate_cents == null ? '-' : `${usd(x.rate_cents)}/h`, hrs(x.regular_hours), hrs(x.overtime_hours), hrs(x.pto_hours), hrs(x.total_hours), usd(x.gross_cents), signed(x.name)])),
      line(['Everyone', '', hrs(t.regular_hours), hrs(t.overtime_hours), hrs(t.pto_hours), hrs(t.total_hours), usd(t.gross_cents), '']),
      '',
      `Overtime after ${r.settings.ot_weekly_hours} hours a week${r.settings.ot_daily_hours ? ` or ${r.settings.ot_daily_hours} a day` : ''}, at ${r.settings.ot_multiplier}x. Gross pay is before taxes and deductions.`,
      t.missing_rates ? `${t.missing_rates} ${t.missing_rates === 1 ? 'person has' : 'people have'} no hourly rate, so their pay isn't added in.` : null,
      issues.length ? `Attendance: ${issues.join(', ')}.` : null,
      r.pending_corrections.length ? `Timecard corrections still waiting for approval: ${r.pending_corrections.length} (${[...new Set(r.pending_corrections.map((c) => c.user_name))].join(', ')}).` : null,
      '',
      'The attached CSV has every clock-in and clock-out. Forward this to payroll once it looks right.',
      publicUrl ? `Review or approve the week: ${publicUrl}/#time` : null,
    ].filter((x) => x != null).join('\n');
    const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
    const csv = [
      ['Name', 'Role', 'Hourly rate', 'Regular hours', 'Overtime hours', 'Paid time off hours', 'Total paid hours', 'Gross pay', 'Approved their time'],
      ...r.rows.map((x) => [x.name, x.role, dollars(x.rate_cents), x.regular_hours, x.overtime_hours, x.pto_hours, x.total_hours, dollars(x.gross_cents), signed(x.name)]),
      ['Everyone', '', '', t.regular_hours, t.overtime_hours, t.pto_hours, t.total_hours, dollars(t.gross_cents), ''],
      [],
      ['Name', 'Clock in', 'Clock out', 'Hours', 'Note'],
      ...r.rows.flatMap((x) => x.punches.map((p) => [x.name, fmtAt(p.clock_in), p.clock_out ? fmtAt(p.clock_out) : 'still on', p.hours, [p.out_reason === 'lunch' && 'then lunch', p.auto_closed && 'forgot to clock out', p.note].filter(Boolean).join('; ')])),
    ].map((l) => l.map(q).join(',')).join('\n');
    const subject = `Payroll ${fmtDay(start)} - ${fmtDay(w.end)}: ${hrs(t.total_hours)}, ${usd(t.gross_cents)}${waiting.length ? ` (waiting on ${waiting.length})` : ''}`;
    return { subject, text, csv, week: w };
  }

  async function emailWeek(start, { at = new Date() } = {}) {
    if (!isDate(start) || dateOf(start).getDay() !== 0) throw new HttpError(400, 'Pick a week starting on Sunday.');
    const to = getSettings().payroll_emails;
    if (!to.length) throw new HttpError(400, 'Add the admins\' email addresses in Overtime & payroll rules first.');
    if (!mailer?.configured) throw new HttpError(400, 'Email sending isn\'t set up yet. Download the CSV and send it yourself.');
    const m = weekEmail(start);
    const attachments = [{ filename: `payroll-${start}-to-${m.week.end}.csv`, content: Buffer.from(m.csv), type: 'text/csv' }];
    for (const addr of to) await mailer.send({ to: addr, subject: `${brand.name ? `${brand.name}: ` : ''}${m.subject}`, text: m.text, attachments });
    savePayWeek(start, { emailed_at: new Date(at).toISOString(), emailed_to: JSON.stringify(to) });
    return { ok: true, sent_to: to };
  }

  // Each minute: once everyone has approved this week's time, email the summary. If someone never
  // does, it goes the morning after review day (8 AM) anyway, saying who it's waiting on.
  async function sendWeeklyDue(at = new Date()) {
    const settings = getSettings();
    if (!settings.payroll_emails.length || !mailer?.configured) return false;
    for (const back of [7, 0]) {
      const d = new Date(at); d.setDate(d.getDate() - back);
      const start = weekStartOf(d);
      if (payWeek(start).emailed_at) continue;
      const info = payroll({ from: start, to: weekEnd(start), at }).week;
      if (!info?.signoffs.length) continue;
      const late = dateOf(start); late.setDate(late.getDate() + settings.review_day + 1); late.setHours(8, 0, 0, 0);
      if (info.all_signed || at >= late) {
        await emailWeek(start, { at });
        return true;
      }
    }
    return false;
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
        people.set(k, { name: u?.name || name, role: u?.role || null, active: u ? u.active !== false : false, rate_cents: rateOf(name), punches: [], days: new Map(), time_off: [], pto_hours: 0, unpaid_off_hours: 0, lunch_minutes: 0 });
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
      const prev = who.punches.at(-1);
      if (prev?.out_reason === 'lunch' && prev.clock_out && keyOf(new Date(prev.clock_out)) === keyOf(new Date(p.clock_in))) {
        prev.lunch_minutes = Math.round((new Date(p.clock_in) - new Date(prev.clock_out)) / 60000);
        who.lunch_minutes += prev.lunch_minutes;
      }
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
      const att = attendance(p, { from, to, at, settings });
      const issues = Object.fromEntries(ISSUES.map((t) => [t, att.days.reduce((n, d) => n + d.issues.filter((i) => i.type === t).length, 0)]));
      return {
        days: att.days, has_schedule: att.has_schedule, issues, issue_count: Object.values(issues).reduce((n, v) => n + v, 0),
        name: p.name, role: p.role, active: p.active, rate_cents: rate,
        regular_hours: round2(regular), overtime_hours: round2(overtime), pto_hours: round2(p.pto_hours), unpaid_off_hours: round2(p.unpaid_off_hours),
        total_hours: round2(regular + overtime + p.pto_hours), gross_cents: pay,
        on_clock: p.punches.some((x) => x.open), lunch_minutes: p.lunch_minutes, flagged: p.punches.filter((x) => x.auto_closed).length,
        punches: p.punches, time_off: p.time_off,
      };
    }).filter((r) => r.active || r.punches.length || r.time_off.length)
      .sort((a, b) => (b.total_hours - a.total_hours) || a.name.localeCompare(b.name));
    const sum = (k) => round2(rows.reduce((n, r) => n + (r[k] || 0), 0));
    return {
      from, to, settings,
      rows,
      totals: { regular_hours: sum('regular_hours'), overtime_hours: sum('overtime_hours'), pto_hours: sum('pto_hours'), total_hours: sum('total_hours'), gross_cents: rows.reduce((n, r) => n + (r.gross_cents || 0), 0), missing_rates: rows.filter((r) => r.rate_cents == null && r.total_hours > 0).length },
      issues: Object.fromEntries(ISSUES.map((t) => [t, rows.reduce((n, r) => n + r.issues[t], 0)])),
      // Every late arrival, early leave, long lunch, no-show and forgotten clock-out, newest first.
      occurrences: rows.flatMap((r) => r.days.flatMap((d) => d.issues.map((i) => ({ user_name: r.name, date: d.date, ...i, schedule: d.schedule, first_in: d.first_in, last_out: d.last_out, lunch_minutes: d.lunch_minutes }))))
        .sort((a, b) => b.date.localeCompare(a.date) || a.user_name.localeCompare(b.user_name)),
      week: weekInfo(from, to, rows),
      pending_time_off: listOff({ status: 'pending' }),
      pending_corrections: listCorrections({ status: 'pending' }),
    };
  }

  return { approveWeek, approvePayrollWeek, emailWeek, weekEmail, sendWeeklyDue, listSchedules, saveSchedules, status, clockIn, clockOut, startLunch, timecard, requestCorrection, cancelCorrection, decideCorrection, listCorrections, closeForgotten, addPunch, editPunch, removePunch, requestOff, cancelOff, decideOff, listOff, calendarOff, setRate, rateOf, getSettings, saveSettings, payroll, KINDS };
}

module.exports = { createTimeService, TIME_OFF_KINDS: KINDS };
