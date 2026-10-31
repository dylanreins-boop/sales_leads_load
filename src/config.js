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
  // Set HOST=127.0.0.1 when a web server (like Caddy) sits in front, so the app isn't reachable directly.
  host: process.env.HOST || undefined,
  // Behind your own web server, read the visitor's address from X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === 'true',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db'),
  // Written by the nightly off-server backup (deploy/oracle/backup.sh); admins see it under Team.
  backupStatusFile: process.env.BACKUP_STATUS_FILE || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'leads.db')), 'offsite-status.json'),

  // Dashboard logins (HTTP Basic auth): APP_USERS="Dylan:pass1:admin,Sam:pass2:sales,Mike:pass3:shop".
  // Each person gets their own login so the activity log shows who did what. Levels:
  //   admin - sees everything, plus the Updates feed of every change
  //   sales - the lead pipelines: work leads, log calls, book jobs (no calendar, export or settings)
  //   shop  - the job calendar only
  // A login without a level is "sales". APP_USER/APP_PASSWORD (a single shared login) is an admin.
  // With neither set, the dashboard has no login and everyone is treated as an admin.
  users: [
    ...list(process.env.APP_USERS).map((entry) => {
      const level = entry.match(/:(admin|sales|shop)$/i);
      const role = level ? level[1].toLowerCase() : 'sales';
      const rest = entry.replace(/:(admin|sales|shop)$/i, '');
      const sep = rest.indexOf(':');
      return { name: rest.slice(0, sep).trim(), password: rest.slice(sep + 1), role };
    }).filter((u) => u.name && u.password),
    ...(process.env.APP_PASSWORD ? [{ name: process.env.APP_USER || 'admin', password: process.env.APP_PASSWORD, role: 'admin' }] : []),
  ],
  // Job photos are saved here (next to the database by default, so they land on the same volume).
  photosDir: process.env.PHOTOS_DIR || '',

  // Company details shown in the app, the phone app name and the default follow-up email.
  brand: {
    name: process.env.BRAND_NAME || 'Bob Moses Ceramic Coating',
    shortName: process.env.BRAND_SHORT_NAME || 'Bob Moses Leads',
    city: process.env.BRAND_CITY || 'Las Vegas',
    phone: process.env.BRAND_PHONE || '',
    website: process.env.BRAND_WEBSITE || '',
    address: process.env.BRAND_ADDRESS || '',
  },

  // Hour of the day (server local time) for "call tomorrow" reminders when
  // the browser doesn't send its own time.
  reminderHour: Number(process.env.REMINDER_HOUR ?? 9),
  // The Las Vegas shop is closed weekends, so call-back reminders skip to Monday.
  reminderSkipWeekends: process.env.REMINDER_SKIP_WEEKENDS !== 'false',
  // Leads leave the board for "Old & Dead Leads" this many days after they came in (Booked leads stay).
  archiveDays: Number(process.env.LEAD_ARCHIVE_DAYS ?? 14),
  // Past customers show as "Due for maintenance" this many months after pick-up.
  recoatMonths: Number(process.env.RECOAT_MONTHS ?? 11),

  website: {
    apiKey: process.env.WEBSITE_API_KEY || '',
    corsOrigins: list(process.env.CORS_ORIGINS || '*'),
  },

  // The address people reach the app at, e.g. https://leads.bobmosescc.com. Used in booking links
  // sent to customers and to check Twilio's signatures. When blank, it's worked out from each request.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // Text messages (Twilio). Without these, texting is off; email still works.
  sms: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM || '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
  },

  // Card deposits on online bookings (Stripe Checkout). Without a key, customers book and pay the deposit later.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  // New Facebook and website leads ping the sales team; if nobody has called within this many
  // minutes, the admins get pinged too.
  speedToLeadMinutes: Number(process.env.SPEED_TO_LEAD_MINUTES ?? 15),
  // Alerts only go out between these hours (shop time); overnight leads are alerted at the start.
  alertHours: (() => {
    const [start, end] = String(process.env.ALERT_HOURS || '7-20').split('-').map(Number);
    return start >= 0 && end > start && end <= 24 ? { start, end } : { start: 7, end: 20 };
  })(),

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
