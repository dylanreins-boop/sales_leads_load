// The shop's work timer. A tech taps Start work on a job, Pause when they step away (lunch, end of the
// day, another job), and Finished when the work is done. Every stretch is kept per person, so the app
// knows the real hours each job took next to the hours it was booked for.
const { HttpError } = require('./leads');
const { transaction } = require('./db');
const ShopTime = require('../public/shop-time');

const HOUR = 3600000;

function createWorkTimeService(db, { jobs, leads }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const hours = (ms) => Math.round((ms / HOUR) * 100) / 100;
  const label = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1).replace(/\.0$/, '')} hours`);
  const runningFor = (jobId, user) => stmt('SELECT * FROM job_work WHERE job_id = ? AND user_name = ? AND stopped_at IS NULL').get(jobId, user);
  const lengthOf = (s, at = new Date()) => Math.max(0, new Date(s.stopped_at || at) - new Date(s.started_at));

  // Everything about the job's work time, for the job panel.
  function summary(jobId, { at = new Date() } = {}) {
    const job = stmt('SELECT id, work_hours, work_started_at, work_finished_at, work_finished_by FROM jobs WHERE id = ?').get(jobId);
    if (!job) throw new HttpError(404, 'Job not found');
    const sessions = stmt('SELECT * FROM job_work WHERE job_id = ? ORDER BY started_at').all(jobId)
      .map((s) => ({ ...s, auto_stopped: Boolean(s.auto_stopped), hours: hours(lengthOf(s, at)) }));
    const people = new Map();
    for (const s of sessions) people.set(s.user_name, (people.get(s.user_name) || 0) + lengthOf(s, at));
    return {
      job_id: jobId,
      sessions,
      running: sessions.filter((s) => !s.stopped_at).map((s) => ({ id: s.id, user_name: s.user_name, started_at: s.started_at })),
      hours: hours(sum(sessions.map((s) => lengthOf(s, at)))),
      by_person: [...people.entries()].map(([name, ms]) => ({ name, hours: hours(ms) })),
      booked_hours: job.work_hours,
      started_at: job.work_started_at,
      finished_at: job.work_finished_at,
      finished_by: job.work_finished_by,
    };
  }

  function check(jobId) {
    const job = jobs.getJob(jobId);
    if (job.status === 'cancelled') throw new HttpError(400, 'This job is cancelled.');
    return job;
  }

  // Starts the clock for this person. Their clock on any other job pauses first.
  function start(jobId, { user } = {}) {
    if (!user) throw new HttpError(400, 'Sign in to track work time.');
    const job = check(jobId);
    if (runningFor(jobId, user)) return summary(jobId);
    const at = now();
    transaction(db, () => {
      for (const other of stmt('SELECT w.*, l.full_name FROM job_work w JOIN jobs j ON j.id = w.job_id JOIN leads l ON l.id = j.lead_id WHERE w.user_name = ? AND w.stopped_at IS NULL').all(user)) {
        stmt('UPDATE job_work SET stopped_at = ? WHERE id = ?').run(at, other.id);
        const j = jobs.getJob(other.job_id);
        leads.logActivity(j.lead_id, 'work', { note: `${user} paused work (started another job)`, user });
      }
      stmt('INSERT INTO job_work (job_id, user_name, started_at, created_at) VALUES (?, ?, ?, ?)').run(jobId, user, at, at);
      stmt('UPDATE jobs SET work_started_at = COALESCE(work_started_at, ?), work_finished_at = NULL, work_finished_by = NULL WHERE id = ?').run(at, jobId);
    });
    leads.logActivity(job.lead_id, 'work', { note: job.work_finished_at ? `${user} started work again` : `${user} started work`, user });
    // Working on it means the vehicle is in the building.
    if (job.status === 'scheduled') jobs.updateJob(jobId, { status: 'in_shop' }, { user });
    return summary(jobId);
  }

  function pause(jobId, { user } = {}) {
    const job = check(jobId);
    const s = runningFor(jobId, user);
    if (!s) return summary(jobId);
    stmt('UPDATE job_work SET stopped_at = ? WHERE id = ?').run(now(), s.id);
    leads.logActivity(job.lead_id, 'work', { note: `${user} paused work (${label(hours(lengthOf({ ...s, stopped_at: now() })))})`, user });
    return summary(jobId);
  }

  // The work is done: every running clock on the job stops.
  function finish(jobId, { user } = {}) {
    const job = check(jobId);
    const at = now();
    const logged = stmt('SELECT COUNT(*) AS n FROM job_work WHERE job_id = ?').get(jobId).n;
    if (!logged) throw new HttpError(400, 'Start work first, or have an admin add the time.');
    stmt('UPDATE job_work SET stopped_at = ? WHERE job_id = ? AND stopped_at IS NULL').run(at, jobId);
    stmt('UPDATE jobs SET work_finished_at = ?, work_finished_by = ? WHERE id = ?').run(at, user ?? null, jobId);
    const s = summary(jobId);
    const booked = job.work_hours ? ` (${label(job.work_hours)} booked)` : '';
    leads.logActivity(job.lead_id, 'work', { note: `Work finished: ${label(s.hours)} of work${booked}`, user });
    return s;
  }

  // ---- admins fix the record: forgot to start, forgot to stop ----
  const parse = (v, what) => {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) throw new HttpError(400, `Pick the ${what} time.`);
    return d.toISOString();
  };
  function addSession(jobId, { user_name, started_at, stopped_at } = {}, { user } = {}) {
    const job = check(jobId);
    const who = String(user_name || '').trim();
    if (!who) throw new HttpError(400, 'Pick who did the work.');
    const a = parse(started_at, 'start');
    const b = parse(stopped_at, 'stop');
    if (b <= a) throw new HttpError(400, 'The stop time has to be after the start.');
    if (new Date(b) - new Date(a) > 24 * HOUR) throw new HttpError(400, 'Add one day at a time.');
    stmt('INSERT INTO job_work (job_id, user_name, started_at, stopped_at, edited_by, edited_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, who, a, b, user ?? null, now(), now());
    stmt('UPDATE jobs SET work_started_at = CASE WHEN work_started_at IS NULL OR work_started_at > ? THEN ? ELSE work_started_at END WHERE id = ?').run(a, a, jobId);
    leads.logActivity(job.lead_id, 'work', { note: `Work time added for ${who}: ${label(hours(new Date(b) - new Date(a)))}`, user });
    return summary(jobId);
  }

  function editSession(id, { started_at, stopped_at } = {}, { user } = {}) {
    const s = stmt('SELECT * FROM job_work WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'That work time is gone.');
    const job = jobs.getJob(s.job_id);
    const a = started_at ? parse(started_at, 'start') : s.started_at;
    const b = stopped_at ? parse(stopped_at, 'stop') : s.stopped_at;
    if (b && b <= a) throw new HttpError(400, 'The stop time has to be after the start.');
    stmt('UPDATE job_work SET started_at = ?, stopped_at = ?, auto_stopped = 0, edited_by = ?, edited_at = ? WHERE id = ?').run(a, b, user ?? null, now(), id);
    leads.logActivity(job.lead_id, 'work', { note: `Work time for ${s.user_name} corrected${b ? `: ${label(hours(new Date(b) - new Date(a)))}` : ''}`, user });
    return summary(s.job_id);
  }

  function removeSession(id, { user } = {}) {
    const s = stmt('SELECT * FROM job_work WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'That work time is gone.');
    const job = jobs.getJob(s.job_id);
    stmt('DELETE FROM job_work WHERE id = ?').run(id);
    leads.logActivity(job.lead_id, 'work', { note: `Work time for ${s.user_name} removed (${label(hours(lengthOf(s)))})`, user });
    return summary(s.job_id);
  }

  // A clock left running past midnight is stopped at that day's closing time and flagged, so a
  // forgotten Pause doesn't count the night. Admins can correct it.
  function stopForgotten(at = new Date()) {
    const set = jobs.getShopHours();
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    let n = 0;
    for (const s of stmt('SELECT * FROM job_work WHERE stopped_at IS NULL AND started_at < ?').all(today.toISOString())) {
      const closing = ShopTime.windowOn(new Date(s.started_at), set).to;
      const stopAt = new Date(Math.max(closing.getTime(), new Date(s.started_at).getTime() + 60000)).toISOString();
      stmt('UPDATE job_work SET stopped_at = ?, auto_stopped = 1 WHERE id = ?').run(stopAt, s.id);
      const job = jobs.getJob(s.job_id);
      leads.logActivity(job.lead_id, 'work', { note: `${s.user_name}'s work clock was left running overnight; stopped at closing time` });
      n++;
    }
    return n;
  }

  return { summary, start, pause, finish, addSession, editSession, removeSession, stopForgotten };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

module.exports = { createWorkTimeService };
