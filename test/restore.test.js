const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
const script = path.join(__dirname, '..', 'scripts', 'restore-check.js');
const run = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { encoding: 'utf8' });

test('the restore test passes a good backup (plain or gzipped) and fails a damaged or short one', () => {
  const livePath = path.join(dir, 'live.db');
  const db = openDatabase(livePath);
  const leads = createLeadService(db);
  for (let i = 0; i < 12; i += 1) leads.ingest({ source: 'manual', full_name: `Person ${i}`, phone: `702555${String(1000 + i)}` });
  const backup = path.join(dir, 'leads-2026-11-10.db');
  db.exec(`VACUUM INTO '${backup}'`);
  fs.writeFileSync(`${backup}.gz`, zlib.gzipSync(fs.readFileSync(backup)));

  let out = run(backup);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Integrity check: ok\./);
  assert.match(out.stdout, /The app read it back: 12 leads\./);
  assert.match(out.stdout, /RESTORE TEST PASSED/);
  out = run(`${backup}.gz`, '--compare', livePath);
  assert.equal(out.status, 0, out.stdout);

  // The live database grew a lot since: the backup is stale.
  for (let i = 12; i < 40; i += 1) leads.ingest({ source: 'manual', full_name: `Person ${i}`, phone: `702555${String(1000 + i)}` });
  out = run(`${backup}.gz`, '--compare', livePath);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /RESTORE TEST FAILED: the backup is missing a lot compared with the live database \(leads: 12 vs 40/);

  // A damaged file.
  const bad = path.join(dir, 'broken.db');
  const bytes = fs.readFileSync(backup);
  bytes.fill(0x41, 100, Math.min(bytes.length, 8192));
  fs.writeFileSync(bad, bytes);
  out = run(bad);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /RESTORE TEST FAILED/);
  assert.equal(run(path.join(dir, 'nope.db')).status, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
