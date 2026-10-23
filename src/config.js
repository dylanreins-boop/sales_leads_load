const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the app runs with zero dependencies.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db'),

  // Dashboard logins (HTTP Basic auth). APP_USERS="Dylan:pass1,Sam:pass2" gives
  // each person their own login so the activity log shows who did what.
  // APP_USER/APP_PASSWORD still work for a single shared login.
  // With neither set, the dashboard has no login.
  users: [
    ...list(process.env.APP_USERS).map((entry) => {
      const sep = entry.indexOf(':');
      return { name: entry.slice(0, sep).trim(), password: entry.slice(sep + 1) };
    }).filter((u) => u.name && u.password),
    ...(process.env.APP_PASSWORD ? [{ name: process.env.APP_USER || 'admin', password: process.env.APP_PASSWORD }] : []),
  ],

  // Hour of the day (server local time) for "call tomorrow" reminders when
  // the browser doesn't send its own time.
  reminderHour: Number(process.env.REMINDER_HOUR ?? 9),

  website: {
    apiKey: process.env.WEBSITE_API_KEY || '',
    corsOrigins: list(process.env.CORS_ORIGINS || '*'),
  },

  email: {
    provider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
    apiKey: process.env.EMAIL_API_KEY || '',
    from: process.env.EMAIL_FROM || '',
    replyTo: process.env.EMAIL_REPLY_TO || '',
  },

  facebook: {
    verifyToken: process.env.FB_VERIFY_TOKEN || '',
    appSecret: process.env.FB_APP_SECRET || '',
    pageAccessToken: process.env.FB_PAGE_ACCESS_TOKEN || '',
    formIds: list(process.env.FB_FORM_IDS),
    graphVersion: process.env.FB_GRAPH_VERSION || 'v23.0',
  },
};
