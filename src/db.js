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
  service_interest  TEXT,
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

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
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
  for (const column of ['vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color', 'service_interest']) {
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
