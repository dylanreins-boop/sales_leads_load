// Phone reminders for people on the clock (checked every minute):
//  - shop logins: every hour on the clock, "update the vehicle sheet" (status, checklist, photos);
//  - anyone on the clock: once a day at about 7.5 hours worked, "time to clock out".
// Push only (no texts: hourly texts would cost the shop money). Each reminder is sent once, kept in
// work_reminders by person, kind and key, so a restart never sends one twice.
const HOUR = 3600000;
const norm = (s) => String(s || '').trim().toLowerCase();
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createWorkReminders(db, { users, push, sheetMinutes = 60, clockOutHours = 7.5 }) {
  const stmt = (sql) => db.prepare(sql);
  db.exec(`CREATE TABLE IF NOT EXISTS work_reminders (
    name_norm TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, sent_at TEXT NOT NULL,
    PRIMARY KEY (name_norm, kind, key))`);
  const sentBefore = (name, kind, key) => Boolean(stmt('SELECT 1 FROM work_reminders WHERE name_norm = ? AND kind = ? AND key = ?').get(norm(name), kind, key));
  const markSent = (name, kind, key, at) => stmt('INSERT OR IGNORE INTO work_reminders (name_norm, kind, key, sent_at) VALUES (?, ?, ?, ?)').run(norm(name), kind, key, at.toISOString());

  // Hours worked today (lunch and other breaks don't count), up to `at`.
  function workedToday(name, at) {
    const start = new Date(at); start.setHours(0, 0, 0, 0);
    return stmt('SELECT clock_in, clock_out FROM time_punches WHERE name_norm = ? AND (clock_out IS NULL OR clock_out > ?) AND clock_in < ?')
      .all(norm(name), start.toISOString(), at.toISOString())
      .reduce((n, p) => n + Math.max(0, Math.min(new Date(p.clock_out || at), at) - Math.max(new Date(p.clock_in), start)), 0) / HOUR;
  }

  async function run(at = new Date()) {
    const roleOf = new Map(users.list().filter((u) => u.active !== false).map((u) => [norm(u.name), u.role]));
    const today = new Date(at); today.setHours(0, 0, 0, 0);
    // Only today's open punches: one left on from yesterday is closed by the time clock, not reminded.
    const open = stmt('SELECT * FROM time_punches WHERE clock_out IS NULL AND clock_in >= ? AND clock_in <= ?').all(today.toISOString(), at.toISOString());
    const sent = { sheet: 0, clock_out: 0 };
    for (const p of open) {
      const role = roleOf.get(p.name_norm);
      if (!role) continue;
      const name = p.user_name;
      // Vehicle sheet: one an hour after each clock-in (or back from lunch), then every hour.
      if (role === 'shop' && sheetMinutes > 0) {
        const n = Math.floor((at - new Date(p.clock_in)) / (sheetMinutes * 60000));
        const key = `${p.id}:${n}`;
        if (n >= 1 && !sentBefore(name, 'sheet', key)) {
          markSent(name, 'sheet', key, at);
          await push.sendTo([name], {
            title: 'Update the vehicle sheet',
            body: 'Quick check: status, checklist and photos for the cars you\'re working on.',
            url: '/', tag: 'vehicle-sheet',
          });
          sent.sheet++;
        }
      }
      // Clock out: once a day, at about 7.5 hours worked.
      if (clockOutHours > 0) {
        const day = keyOf(at);
        const worked = workedToday(name, at);
        if (worked >= clockOutHours && !sentBefore(name, 'clock_out', day)) {
          markSent(name, 'clock_out', day, at);
          const h = Math.floor(worked);
          const m = Math.round((worked - h) * 60);
          await push.sendTo([name], {
            title: 'Time to clock out',
            body: `You've worked ${h} h ${String(m).padStart(2, '0')} m today. Wrap up and clock out in the app.`,
            url: '/?mytime=1', tag: 'clock-out',
          });
          sent.clock_out++;
        }
      }
    }
    return sent;
  }

  return { run, workedToday };
}

module.exports = { createWorkReminders };
