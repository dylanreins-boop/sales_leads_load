const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,              -- facebook | website | manual
  external_id       TEXT,                       -- Facebook leadgen id / form submission id
  first_name        TEXT,
  last_name         TEXT,
  full_name         TEXT,
  email             TEXT,
  phone             TEXT,
  email_norm        TEXT,
  phone_norm        TEXT,
  message           TEXT,
  campaign          TEXT,
  form_name         TEXT,
  vehicle_year      TEXT,
  vehicle_make      TEXT,
  vehicle_model     TEXT,
  vehicle_color     TEXT,
  vehicle_type      TEXT,
  booked_services   TEXT,                       -- JSON list of service ids
  heard_about       TEXT,                       -- "How did you hear about us?"
  sms_opt_in        INTEGER,                    -- 1 agreed to texts, 0 did not, null unknown
  archived_at       TEXT,                       -- moved to Old & Dead Leads
  restored_at       TEXT,                       -- brought back to the pipeline (restarts the 2-week clock)
  stage             TEXT NOT NULL DEFAULT 'new',
  last_disposition  TEXT,
  last_contacted_at TEXT,
  raw               TEXT,
  received_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS leads_stage ON leads (stage);
CREATE INDEX IF NOT EXISTS leads_email ON leads (email_norm);
CREATE INDEX IF NOT EXISTS leads_phone ON leads (phone_norm);

CREATE TABLE IF NOT EXISTS activities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                    -- created | reinquiry | stage_change | disposition | note | reminder_done
  disposition TEXT,
  from_stage  TEXT,
  to_stage    TEXT,
  note        TEXT,
  user_name   TEXT,                             -- who did it (null for automatic events)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_lead ON activities (lead_id);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  due_at     TEXT NOT NULL,
  note       TEXT,
  done_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_open ON reminders (done_at, due_at);

CREATE TABLE IF NOT EXISTS emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,                    -- sent | failed | not_configured
  error      TEXT,
  trigger    TEXT,                             -- disposition that sent it
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS emails_lead ON emails (lead_id);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  start_at   TEXT NOT NULL,                     -- drop-off
  end_at     TEXT NOT NULL,                     -- pick-up
  status     TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_shop | ready | picked_up | cancelled
  notes      TEXT,
  services   TEXT,                              -- JSON list of service ids
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  amount_cents INTEGER,                         -- job price; sales and admins only
  amount_by    TEXT,
  amount_at    TEXT,
  picked_up_at TEXT,                            -- when it was marked Picked up
  review_sent_at TEXT,                          -- when the review-request email went out (or was skipped)
  deposit_cents INTEGER,                        -- deposit taken (null = not taken yet)
  deposit_method TEXT,
  deposit_by TEXT,
  deposit_at TEXT,
  commission_rep TEXT,                          -- who earns the commission (defaults to who booked it)
  commission_override_cents INTEGER,            -- set by an admin instead of the standard rate
  commission_paid_cents INTEGER,
  commission_paid_by TEXT,
  commission_paid_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_time ON jobs (start_at, end_at);
CREATE INDEX IF NOT EXISTS jobs_lead ON jobs (lead_id);

CREATE TABLE IF NOT EXISTS job_checklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  section    TEXT NOT NULL,                     -- Check-in | Work | Finish
  label      TEXT NOT NULL,
  position   INTEGER NOT NULL,
  done_at    TEXT,
  done_by    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_checklist_job ON job_checklist (job_id);

CREATE TABLE IF NOT EXISTS job_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  file        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'during',   -- before | during | after
  caption     TEXT,
  size        INTEGER,
  uploaded_by TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_photos_job ON job_photos (job_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Logins the admins add from the Team panel. Names never change, so the activity
-- history stays tied to the right person; people leave by being deactivated.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  name_norm      TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  created_by     TEXT,
  updated_at     TEXT NOT NULL,
  last_seen_at   TEXT
);

-- Quotes built in the lead drawer from the price list.
CREATE TABLE IF NOT EXISTS quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  lines       TEXT NOT NULL,                    -- JSON [{ label, detail, cents }]
  total_cents INTEGER NOT NULL,
  note        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  emailed_at  TEXT,
  emailed_to  TEXT
);
CREATE INDEX IF NOT EXISTS quotes_lead ON quotes (lead_id);

-- Signed-in browsers (the sign-in page sets a cookie that points here).
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_norm   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_norm);

-- Text messages to and from customers.
CREATE TABLE IF NOT EXISTS texts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,                    -- out | in
  phone       TEXT NOT NULL,                    -- the customer's number
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,                    -- sent | failed | received
  error       TEXT,
  trigger     TEXT,                             -- manual | confirmation | reminder | ready | booking_link
  provider_id TEXT,
  user_name   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS texts_lead ON texts (lead_id);

-- Online booking links sent to customers.
CREATE TABLE IF NOT EXISTS booking_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token             TEXT NOT NULL UNIQUE,
  lead_id           INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  amount_cents      INTEGER NOT NULL,
  deposit_cents     INTEGER NOT NULL,
  work_hours        REAL NOT NULL,
  services          TEXT NOT NULL,                -- JSON list of service ids
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  cancelled_at      TEXT,
  job_id            INTEGER,                      -- set once the customer books
  booked_at         TEXT,
  stripe_session_id TEXT,
  deposit_paid_at   TEXT
);
CREATE INDEX IF NOT EXISTS booking_links_lead ON booking_links (lead_id);

-- Payments on a job after the deposit (final payment, partial payments, refunds).
CREATE TABLE IF NOT EXISTS job_payments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'payment',   -- payment | refund
  cents     INTEGER NOT NULL,
  method    TEXT NOT NULL,
  note      TEXT,
  paid_by   TEXT,                              -- who recorded it
  paid_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_payments_job ON job_payments (job_id);

-- Monthly ad spend by lead source (for cost per lead on the source report).
-- Google Local Services leads already brought in (so a repeat caller isn't logged twice).
-- Time the shop actually spends working on a job: one row per person per stretch of work
-- (Start work → Pause or Finished). A job can have many stretches over several days.
CREATE TABLE IF NOT EXISTS job_work (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  user_name    TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  stopped_at   TEXT,                             -- null while the clock is running
  auto_stopped INTEGER NOT NULL DEFAULT 0,       -- left running overnight; stopped at closing time
  edited_by    TEXT,
  edited_at    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_work_job ON job_work (job_id);
CREATE INDEX IF NOT EXISTS job_work_running ON job_work (stopped_at);

-- The dialer: one row per call a rep makes from the app. There is never a recording: only what was
-- said, written out as it happened, and the summary made from it.
CREATE TABLE IF NOT EXISTS calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  user_name       TEXT NOT NULL,                 -- the rep
  rep_phone       TEXT NOT NULL,
  customer_phone  TEXT NOT NULL,
  status          TEXT NOT NULL,                 -- calling_rep | calling_customer | connected | ended | rep_missed | failed
  customer_status TEXT,                          -- completed | no-answer | busy | failed | canceled
  provider_id     TEXT,
  started_at      TEXT NOT NULL,
  connected_at    TEXT,
  ended_at        TEXT,
  talk_seconds    INTEGER,
  summary         TEXT,                          -- JSON: summary, wants, price, objections, next step, flags...
  summary_source  TEXT,                          -- ai | basic
  summary_error   TEXT,
  flags           TEXT,                          -- JSON list, for filtering
  review_score    INTEGER,                       -- 1-5, from an admin
  review_comment  TEXT,
  reviewed_by     TEXT,
  reviewed_at     TEXT
);
CREATE INDEX IF NOT EXISTS calls_lead ON calls (lead_id);
CREATE INDEX IF NOT EXISTS calls_user ON calls (user_name, started_at);

CREATE TABLE IF NOT EXISTS call_lines (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id  INTEGER NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  speaker  TEXT NOT NULL,                        -- rep | customer
  text     TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS call_lines_call ON call_lines (call_id);

-- The time clock: one row per stretch on the clock (clock in -> clock out).
CREATE TABLE IF NOT EXISTS time_punches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name_norm   TEXT NOT NULL,
  user_name   TEXT NOT NULL,
  clock_in    TEXT NOT NULL,
  clock_out   TEXT,                              -- null while on the clock
  auto_closed INTEGER NOT NULL DEFAULT 0,        -- left on overnight; closed at the end of the shop's day
  note        TEXT,
  edited_by   TEXT,
  edited_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS time_punches_who ON time_punches (name_norm, clock_in);

-- Time off people ask for; admins approve or deny it.
CREATE TABLE IF NOT EXISTS time_off (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_norm     TEXT NOT NULL,
  user_name     TEXT NOT NULL,
  start_date    TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date      TEXT NOT NULL,                   -- YYYY-MM-DD, the last day off
  hours_per_day REAL NOT NULL,
  kind          TEXT NOT NULL,                   -- vacation | sick | personal | unpaid
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | cancelled
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS time_off_dates ON time_off (start_date, end_date);

-- Hourly pay rates, set by admins.
-- Timecard corrections someone asks for (change, add or remove a punch); an admin approves or denies.
CREATE TABLE IF NOT EXISTS time_corrections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_norm     TEXT NOT NULL,
  user_name     TEXT NOT NULL,
  punch_id      INTEGER,
  action        TEXT NOT NULL,
  clock_in      TEXT,
  clock_out     TEXT,
  old_clock_in  TEXT,
  old_clock_out TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS time_corrections_status ON time_corrections (status, created_at);
-- Each person's work schedule: the days they work and their hours ("08:00" to "16:30"), for attendance.
CREATE TABLE IF NOT EXISTS work_schedules (
  name_norm  TEXT PRIMARY KEY,
  user_name  TEXT NOT NULL,
  days       TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
-- Each person approving their own week's time (they're paid weekly, Sunday to Saturday).
CREATE TABLE IF NOT EXISTS week_signoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name_norm   TEXT NOT NULL,
  user_name   TEXT NOT NULL,
  week_start  TEXT NOT NULL,
  hours       REAL NOT NULL,
  approved_at TEXT NOT NULL,
  UNIQUE (name_norm, week_start)
);
-- A pay week: when the summary was emailed to the admins, and when an admin approved it for payroll.
CREATE TABLE IF NOT EXISTS payroll_weeks (
  week_start  TEXT PRIMARY KEY,
  emailed_at  TEXT,
  emailed_to  TEXT,
  approved_by TEXT,
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS pay_rates (
  name_norm  TEXT PRIMARY KEY,
  user_name  TEXT NOT NULL,
  cents      INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lsa_seen (
  lsa_id   TEXT PRIMARY KEY,
  lead_id  INTEGER,
  seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_spend (
  month      TEXT NOT NULL,                    -- YYYY-MM
  source     TEXT NOT NULL,
  cents      INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month, source)
);

-- Referral links: one per past customer who shares one, and one per partner (dealers, storage lots...).
CREATE TABLE IF NOT EXISTS referrers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,                   -- customer | partner
  lead_id     INTEGER REFERENCES leads (id) ON DELETE CASCADE,  -- the customer
  name        TEXT NOT NULL,
  contact     TEXT,
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

-- Win-back campaigns to old and dead leads, and each message in them.
CREATE TABLE IF NOT EXISTS campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  audience      TEXT NOT NULL,                 -- JSON: who it went to
  text_body     TEXT NOT NULL,
  email_subject TEXT,
  status        TEXT NOT NULL,                 -- sending | done | stopped
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  stopped_by    TEXT
);
CREATE TABLE IF NOT EXISTS campaign_sends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  lead_id     INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  channel     TEXT,                            -- text | email
  status      TEXT NOT NULL,                   -- pending | sending | sent | failed | stopped
  error       TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX IF NOT EXISTS campaign_sends_status ON campaign_sends (status, campaign_id);
CREATE INDEX IF NOT EXISTS campaign_sends_lead ON campaign_sends (lead_id);

-- Spreadsheet imports of leads from before the app (each can be undone).
CREATE TABLE IF NOT EXISTS import_batches (
  id            TEXT PRIMARY KEY,
  file          TEXT NOT NULL,
  created_count INTEGER NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  undone_at     TEXT,
  undone_by     TEXT
);

-- Phones and browsers that get alerts (Web Push), by person.
CREATE TABLE IF NOT EXISTS push_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name_norm   TEXT NOT NULL,
  name        TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT
);

-- Each person's own alert settings (works for every login, including ones set on the server).
CREATE TABLE IF NOT EXISTS user_prefs (
  name_norm   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  alert_phone TEXT,                             -- also text new-lead alerts here
  updated_at  TEXT NOT NULL
);

-- Who added, changed or deactivated each login.
CREATE TABLE IF NOT EXISTS user_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name   TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  by_user     TEXT,
  created_at  TEXT NOT NULL
);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Adds columns introduced after a database was first created.
function migrate(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has('activities', 'user_name')) db.exec('ALTER TABLE activities ADD COLUMN user_name TEXT');
  if (!has('leads', 'sms_opt_in')) db.exec('ALTER TABLE leads ADD COLUMN sms_opt_in INTEGER');
  if (!has('jobs', 'review_sent_at')) db.exec('ALTER TABLE jobs ADD COLUMN review_sent_at TEXT');
  for (const [column, type] of [['deposit_cents', 'INTEGER'], ['deposit_method', 'TEXT'], ['deposit_by', 'TEXT'], ['deposit_at', 'TEXT'],
    ['commission_rep', 'TEXT'], ['commission_override_cents', 'INTEGER'], ['commission_paid_cents', 'INTEGER'],
    ['commission_paid_by', 'TEXT'], ['commission_paid_at', 'TEXT']]) {
    if (!has('jobs', column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} ${type}`);
  }
  // Who referred the lead, and when the referrer was thanked.
  if (!has('leads', 'referrer_id')) db.exec('ALTER TABLE leads ADD COLUMN referrer_id INTEGER');
  for (const column of ['referral_rewarded_at', 'referral_rewarded_by']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
  for (const column of ['followup1_at', 'followup2_at']) {
    if (!has('quotes', column)) db.exec(`ALTER TABLE quotes ADD COLUMN ${column} TEXT`);
  }
  if (!has('user_prefs', 'appearance')) db.exec('ALTER TABLE user_prefs ADD COLUMN appearance TEXT');
  if (!has('user_prefs', 'call_phone')) db.exec('ALTER TABLE user_prefs ADD COLUMN call_phone TEXT');
  // Why a punch ended: 'lunch' for a lunch break (the next punch is them coming back).
  if (!has('time_punches', 'out_reason')) db.exec('ALTER TABLE time_punches ADD COLUMN out_reason TEXT');
  // Where they were when they clocked in (shop logins clock in at the shop), and how far that was from it.
  for (const [column, type] of [['clock_in_lat', 'REAL'], ['clock_in_lng', 'REAL'], ['clock_in_accuracy', 'REAL'], ['clock_in_distance', 'REAL']]) {
    if (!has('time_punches', column)) db.exec(`ALTER TABLE time_punches ADD COLUMN ${column} ${type}`);
  }
  if (!has('leads', 'import_batch')) db.exec('ALTER TABLE leads ADD COLUMN import_batch TEXT');
  // Who last opened the lead and when, and who last reached out (a call logged or a text) and how.
  // The welcome text ("what time of day is best to reach you?") and the customer's answer.
  for (const column of ['welcome_due_at', 'welcome_sent_at', 'best_time', 'best_time_note', 'best_time_by', 'best_time_at']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
  for (const column of ['last_opened_at', 'last_opened_by', 'last_contact_by', 'last_contact_kind']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
  // New-lead alerts: when it's due (alert hours), when it went out, and when admins were told nobody called.
  for (const column of ['alert_due_at', 'alerted_at', 'escalated_at']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
  // Customer sign-off at drop-off: who signed, when, the signature image and what they agreed to.
  for (const column of ['signoff_name', 'signoff_at', 'signoff_by', 'signoff_file', 'signoff_terms']) {
    if (!has('jobs', column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
  for (const column of ['confirm_sent_at', 'reminder_sent_at', 'ready_sent_at']) {
    if (!has('jobs', column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
  if (!has('jobs', 'work_hours')) db.exec('ALTER TABLE jobs ADD COLUMN work_hours REAL');
  // The card processor's transaction ID on a payment brought in from a Talech / Elavon export.
  if (!has('job_payments', 'ref')) db.exec('ALTER TABLE job_payments ADD COLUMN ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS job_payments_ref ON job_payments (ref) WHERE ref IS NOT NULL');
  // When the shop first started on the job, and when they said the work was done.
  for (const column of ['work_started_at', 'work_finished_at', 'work_finished_by']) {
    if (!has('jobs', column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
  if (!has('jobs', 'picked_up_at')) {
    db.exec("ALTER TABLE jobs ADD COLUMN picked_up_at TEXT; UPDATE jobs SET picked_up_at = updated_at WHERE status = 'picked_up'");
  }
  if (!has('jobs', 'amount_cents')) {
    db.exec('ALTER TABLE jobs ADD COLUMN amount_cents INTEGER; ALTER TABLE jobs ADD COLUMN amount_by TEXT; ALTER TABLE jobs ADD COLUMN amount_at TEXT');
  }
  for (const column of ['vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color', 'vehicle_type', 'booked_services', 'heard_about', 'archived_at', 'restored_at']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
