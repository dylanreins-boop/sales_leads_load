#!/usr/bin/env node
// Proves a backup can actually be restored: unpacks it into a scratch folder (the live database is never
// touched), checks the file isn't damaged, opens it the way the app does, reads the leads back, and says
// how fresh it is. Optionally compares it with the live database.
//
//   node scripts/restore-check.js /var/backups/bob-moses-leads/leads-2026-11-10.db
//   node scripts/restore-check.js leads-2026-11-10.db.gz --compare /var/lib/bob-moses-leads/leads.db
//
// Ends with "RESTORE TEST PASSED" (exit 0) or "RESTORE TEST FAILED: why" (exit 1). Run it once a month,
// and after changing anything about backups.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const TABLES = ['leads', 'activities', 'reminders', 'jobs', 'job_photos', 'quotes', 'texts', 'users', 'settings', 'time_punches'];

function fail(why) {
  console.log(`RESTORE TEST FAILED: ${why}`);
  process.exit(1);
}

function counts(db) {
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  return Object.fromEntries(TABLES.filter((t) => have.has(t)).map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const compareAt = args.indexOf('--compare');
  const live = compareAt >= 0 ? args[compareAt + 1] : null;
  if (!file) fail('give the backup file, e.g. node scripts/restore-check.js leads-2026-11-10.db.gz');
  if (!fs.existsSync(file)) fail(`${file} doesn't exist`);

  // 1. Unpack into a scratch folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
  const copy = path.join(dir, 'leads.db');
  try {
    const raw = fs.readFileSync(file);
    fs.writeFileSync(copy, file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw);
  } catch (err) { fail(`couldn't unpack it (${err.message})`); }
  console.log(`Unpacked ${path.basename(file)} (${(fs.statSync(copy).size / 1024 / 1024).toFixed(1)} MB) into a scratch folder.`);

  try {
    // 2. Not damaged.
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try { db = new DatabaseSync(copy); } catch (err) { fail(`it isn't a database the app can open (${err.message})`); }
    let check;
    try { check = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]); } catch (err) { fail(`the file is damaged (${err.message})`); }
    if (check.join() !== 'ok') fail(`the file is damaged: ${check.slice(0, 3).join('; ')}`);
    console.log('Integrity check: ok.');
    if (!counts(db).leads && counts(db).leads !== 0) fail('there\'s no leads table in it');
    db.close();

    // 3. Open it the way the app does (bringing it up to date), and read the leads back.
    const { openDatabase } = require('../src/db');
    const { createLeadService } = require('../src/leads');
    const appDb = openDatabase(copy);
    const leads = createLeadService(appDb);
    const all = leads.listLeads({ view: 'all' });
    const n = counts(appDb);
    console.log(`The app read it back: ${all.length} leads.`);
    console.log(`Rows: ${Object.entries(n).map(([t, c]) => `${t} ${c}`).join(', ')}.`);
    const newest = appDb.prepare('SELECT MAX(at) AS at FROM (SELECT MAX(received_at) AS at FROM leads UNION ALL SELECT MAX(created_at) FROM activities)').get().at;
    if (newest) {
      const hours = Math.round((Date.now() - new Date(newest)) / 3600000);
      console.log(`Newest entry: ${new Date(newest).toLocaleString()} (${hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`} ago).`);
      if (hours > 72) console.log('Warning: nothing in the last 3 days. Is this the newest backup, and is the nightly backup running?');
    }
    appDb.close();

    // 4. Compared with the live database (optional): the backup should have about as much.
    if (live) {
      if (!fs.existsSync(live)) fail(`${live} doesn't exist`);
      const liveDb = new DatabaseSync(live, { readOnly: true });
      const now = counts(liveDb);
      liveDb.close();
      const short = Object.entries(now).filter(([t, c]) => (n[t] ?? 0) < c * 0.9 && c - (n[t] ?? 0) > 5);
      console.log(`Live database: ${Object.entries(now).map(([t, c]) => `${t} ${c}`).join(', ')}.`);
      if (short.length) fail(`the backup is missing a lot compared with the live database (${short.map(([t, c]) => `${t}: ${n[t] ?? 0} vs ${c}`).join('; ')})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('RESTORE TEST PASSED');
}

main();
