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
  // New-lead alerts: when it's due (alert hours), when it went out, and when admins were told nobody called.
  for (const column of ['alert_due_at', 'alerted_at', 'escalated_at']) {
    if (!has('leads', column)) db.exec(`ALTER TABLE leads ADD COLUMN ${column} TEXT`);
  }
  for (const column of ['confirm_sent_at', 'reminder_sent_at']) {
    if (!has('jobs', column)) db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
  if (!has('jobs', 'work_hours')) db.exec('ALTER TABLE jobs ADD COLUMN work_hours REAL');
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
