'use strict';
// Shop time: how many hours of work a job needs, and how those hours fill the shop's working days
// (by default 8 hours a day, 8 AM to 4 PM, Monday to Friday). Works out each day's booked hours and
// the warnings when a day goes over. Shared by the server (src/jobs.js) and the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShopTime = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const DEFAULTS = { open: '08:00', hours_per_day: 8, work_days: [1, 2, 3, 4, 5], car_hours: 4, rv_days: 2 };
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MIN = 60000;

  const settingsOf = (s) => ({ ...DEFAULTS, ...(s || {}) });
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const nextDay = (d) => { const x = new Date(d); x.setDate(x.getDate() + 1); return x; };
  const pad = (n) => String(n).padStart(2, '0');
  // Local calendar day, e.g. "2026-11-10".
  const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
  const fromKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
  const isWorkDay = (d, s) => settingsOf(s).work_days.includes(new Date(d).getDay());
  const round = (h) => Math.round(h * 100) / 100;
  const hrs = (h) => `${round(h)} hr${round(h) === 1 ? '' : 's'}`;

  // The shop's open hours on a given day.
  function windowOn(day, s) {
    const { open, hours_per_day: perDay } = settingsOf(s);
    const [hh, mm] = open.split(':').map(Number);
    const from = startOfDay(day);
    from.setHours(hh, mm, 0, 0);
    return { from, to: new Date(from.getTime() + perDay * 60 * MIN) };
  }

  // Default work time for a new booking: about 4 hours for cars, a couple of days for RVs and trailers.
  function defaultHours(pipeline, s) {
    const set = settingsOf(s);
    return pipeline === 'rv' ? set.rv_days * set.hours_per_day : set.car_hours;
  }
  const jobHours = (job, s) => (job.work_hours > 0 ? job.work_hours : defaultHours(job.pipeline, s));

  // "4 hours", "1 day", "3 days", "12 hours".
  function label(hours, s) {
    const perDay = settingsOf(s).hours_per_day;
    if (hours >= perDay && hours % perDay === 0) {
      const days = hours / perDay;
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${round(hours)} hour${hours === 1 ? '' : 's'}`;
  }

  // Choices for the "Work time" picker: a few hour options, then 1 to 5 days.
  function options(s, current) {
    const perDay = settingsOf(s).hours_per_day;
    const hours = [1, 2, 3, 4, 5, 6, 7].filter((n) => n < perDay);
    const list = [...hours, ...[1, 2, 3, 4, 5].map((d) => d * perDay)];
    if (current > 0 && !list.includes(current)) list.push(current);
    return list.sort((a, b) => a - b).map((n) => ({ hours: n, label: label(n, s) }));
  }

  // Spreads a job's work hours over the shop's open hours between drop-off and pick-up, earliest
  // first. Returns the hours on each day and any hours that don't fit before pick-up.
  function allocate(start, end, hours, s) {
    const set = settingsOf(s);
    const from = new Date(start);
    const until = end ? new Date(end) : null;
    let left = Math.round(hours * 60);
    const days = [];
    for (let day = startOfDay(from), n = 0; left > 0 && n < 400 && (!until || day < until); day = nextDay(day), n++) {
      if (!isWorkDay(day, set)) continue;
      const open = windowOn(day, set);
      const a = Math.max(open.from, from);
      const b = until ? Math.min(open.to, until) : open.to;
      const take = Math.min(left, Math.max(0, Math.round((b - a) / MIN)));
      if (take <= 0) continue;
      days.push({ date: dayKey(day), hours: take / 60, until: new Date(a + take * MIN) });
      left -= take;
    }
    return { days, short: left / 60 };
  }

  // When the work is done if the vehicle is dropped off at `start`: the earliest sensible pick-up.
  function finishAt(start, hours, s) {
    const { days } = allocate(start, null, hours, s);
    return days.length ? days[days.length - 1].until : new Date(start);
  }

  // Booked hours per day from a list of jobs (cancelled jobs don't count).
  function loadByDay(jobs, s) {
    const byDay = new Map();
    for (const job of jobs) {
      if (job.status === 'cancelled') continue;
      for (const d of allocate(job.start_at, job.end_at, jobHours(job, s), s).days) {
        const entry = byDay.get(d.date) || { date: d.date, hours: 0, jobs: [] };
        entry.hours = round(entry.hours + d.hours);
        entry.jobs.push({ id: job.id, name: job.full_name || [job.first_name, job.last_name].filter(Boolean).join(' ') || job.phone || 'Job', hours: d.hours });
        byDay.set(d.date, entry);
      }
    }
    return byDay;
  }

  const shortDate = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const shortTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  // Everything worth warning about for a job: days over the shop's hours, drop-off or pick-up on a
  // closed day, and a pick-up before the work can be finished. `others` are the jobs around it.
  function check({ id, start_at: start, end_at: end, work_hours: hours, pipeline, status }, others, s) {
    const set = settingsOf(s);
    const job = { id: id ?? 'new', start_at: start, end_at: end, work_hours: hours, pipeline, status, full_name: 'This job' };
    const need = jobHours(job, set);
    const mine = allocate(start, end, need, set);
    const load = loadByDay([job, ...others.filter((o) => o.id !== job.id)], set);
    const days = mine.days.map((d) => {
      const entry = load.get(d.date);
      return { date: d.date, hours: d.hours, booked: entry.hours, over: entry.hours > set.hours_per_day, jobs: entry.jobs };
    });
    const warnings = [];
    if (status === 'cancelled') return { hours: need, days, warnings, finish_at: finishAt(start, need, set).toISOString() };
    for (const [when, what] of [[start, 'Drop-off'], [end, 'Pick-up']]) {
      if (when && !isWorkDay(when, set)) {
        warnings.push({ type: 'closed', date: dayKey(when), text: `${what} is on a ${DAY_NAMES[new Date(when).getDay()]}. The shop is closed that day.` });
      }
    }
    for (const d of days.filter((x) => x.over)) {
      const others2 = d.jobs.filter((j) => j.id !== job.id).map((j) => `${j.name} (${hrs(j.hours)})`).join(', ');
      warnings.push({
        type: 'over', date: d.date, booked: d.booked,
        text: `${shortDate(fromKey(d.date))} would have ${hrs(d.booked)} of work booked; the shop works ${hrs(set.hours_per_day)} a day.${others2 ? ` Already booked: ${others2}.` : ''}`,
      });
    }
    const finish = finishAt(start, need, set);
    if (mine.short > 0) {
      warnings.push({
        type: 'short', short: mine.short,
        text: `Pick-up is before the work can be done: ${label(need, set)} of work only gets ${hrs(need - mine.short)} of shop time by then. Earliest pick-up: ${shortDate(finish)}, ${shortTime(finish)}.`,
      });
    }
    return { hours: need, days, warnings, finish_at: finish.toISOString() };
  }

  return { DEFAULTS, settingsOf, hrs, dayKey, fromKey, isWorkDay, windowOn, defaultHours, jobHours, label, options, allocate, finishAt, loadByDay, check };
}));
