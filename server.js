const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./src/config');
const { openDatabase } = require('./src/db');
const { createLeadService, HttpError } = require('./src/leads');
const { STAGES, DISPOSITIONS } = require('./src/pipeline');
const facebook = require('./src/facebook');
const { mapWebsiteLead, isSpam } = require('./src/website');
const { createMailer, PLACEHOLDERS } = require('./src/email');
const { VEHICLE_FIELDS, VEHICLE_TYPES, PIPELINES } = require('./src/vehicle');
const { BOOKING_SERVICES } = require('./src/services');
const { HEARD_ABOUT_OPTIONS } = require('./src/answers');
const { leadsWorkbook } = require('./src/export');
const { createJobService, JOB_STATUSES, PHOTO_PHASES, parseAmount, hideAmount } = require('./src/jobs');
const { DISPOSITIONS_BY_ID } = require('./src/pipeline');
const { createUserService, ROLES, MIN_PASSWORD } = require('./src/users');
const { createQuoteService } = require('./src/quotes');
const { createReviewService } = require('./src/reviews');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType = '') {
  if (!raw.length) return {};
  const text = raw.toString('utf8');
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};


const SESSION_COOKIE = 'bm_session';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Secure on HTTPS (Fly sends x-forwarded-proto), so it also works on http://localhost.
function sessionCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Slows down password guessing: a few wrong tries per name and address, then a 15-minute wait.
const loginFailures = new Map();
const LOGIN_WINDOW = 15 * 60000;
const LOGIN_MAX_TRIES = 8;
function loginKey(req, name) {
  const ip = String(req.headers['fly-client-ip'] || req.socket?.remoteAddress || '');
  return `${ip}|${String(name || '').trim().toLowerCase()}`;
}
function tooManyTries(key) {
  const recent = (loginFailures.get(key) || []).filter((t) => Date.now() - t < LOGIN_WINDOW);
  loginFailures.set(key, recent);
  return recent.length >= LOGIN_MAX_TRIES;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = config.website.corsOrigins;
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : null;
  return allowOrigin
    ? {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        Vary: 'Origin',
      }
    : {};
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
    if (pathname === '/sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function createApp({ db = openDatabase(config.dbPath), fetchImpl, photosDir } = {}) {
  const leads = createLeadService(db, {
    reminderHour: config.reminderHour,
    skipWeekends: config.reminderSkipWeekends,
    archiveDays: config.archiveDays,
    brand: config.brand,
  });
  const fb = facebook.createFacebookClient(config.facebook, fetchImpl);
  const mailer = createMailer(config.email, fetchImpl);
  const jobs = createJobService(db, {
    leads,
    photosDir: photosDir || config.photosDir || path.join(path.dirname(config.dbPath), 'photos'),
  });
  const users = createUserService(db, { serverUsers: config.users });
  const quotes = createQuoteService(db, { leads, brand: config.brand });
  const reviews = createReviewService(db, { leads, mailer, brand: config.brand });
  const routes = [];

  // Returns the signed-in user ({ name, role }), or null if the login is wrong.
  // The sign-in page sets a session cookie; scripts can still use HTTP Basic auth.
  // With no logins at all, everyone is let in as an admin without a name.
  function authenticate(req) {
    if (!users.anyLogins()) return { name: null, role: 'admin' };
    const session = users.sessionUser(readCookie(req, SESSION_COOKIE));
    if (session) return session;
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Basic' || !encoded) return null;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    return users.authenticate(decoded.slice(0, sep), decoded.slice(sep + 1));
  }

  // `pattern` supports ":param" segments; public routes skip dashboard login.
  // `roles` lists which login levels may call it (default: the lead pipeline, for admin and sales).
  // `rawBody` routes get the request bytes as-is (photo uploads) up to `bodyLimit`.
  const ANY_LOGIN = ['admin', 'sales', 'shop'];
  const LEADS = ['admin', 'sales'];
  // Sales can look at the calendar (ANY_LOGIN reads) but only admin and shop change jobs.
  const CALENDAR = ['admin', 'shop'];
  const ADMIN = ['admin'];
  function route(method, pattern, handler, { isPublic = false, roles = LEADS, rawBody = false, bodyLimit } = {}) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    const re = new RegExp(`^${source}/?$`);
    routes.push({ method, re, keys, handler, isPublic, roles, rawBody, bodyLimit });
  }

  async function ingestFacebookLead(leadgenId) {
    const fbLead = await fb.fetchLead(leadgenId);
    return leads.ingest(facebook.mapFacebookLead(fbLead));
  }

  // ---- Dashboard API ----
  route('GET', '/api/meta', ({ actor }) => ({
    currentUser: actor.user,
    currentRole: actor.role,
    jobStatuses: JOB_STATUSES,
    photoPhases: PHOTO_PHASES,
    brand: config.brand,
    stages: STAGES,
    dispositions: DISPOSITIONS,
    reminderHour: config.reminderHour,
    reminderSkipWeekends: config.reminderSkipWeekends,
    archiveDays: config.archiveDays,
    recoatMonths: config.recoatMonths,
    facebookConfigured: Boolean(config.facebook.pageAccessToken),
    facebookFormIds: config.facebook.formIds,
    emailConfigured: mailer.configured,
    emailPlaceholders: PLACEHOLDERS,
    vehicleFields: VEHICLE_FIELDS,
    vehicleTypes: VEHICLE_TYPES,
    pipelines: PIPELINES,
    bookingServices: BOOKING_SERVICES,
    heardAboutOptions: HEARD_ABOUT_OPTIONS,
  }), { roles: ANY_LOGIN });
  const leadFilters = (query) => ({
    q: query.get('q'),
    source: query.get('source'),
    pipeline: query.get('pipeline'),
    view: query.get('view') || undefined,
    vehicleType: query.get('vehicle_type'),
    status: query.get('status'),
  });
  route('GET', '/api/leads', ({ query }) => {
    leads.archiveOldLeads();
    return leads.listLeads(leadFilters(query));
  });
  // ---- Shop calendar ----
  route('GET', '/api/jobs', ({ query }) => jobs.listJobs({ from: query.get('from'), to: query.get('to') }), { roles: ANY_LOGIN });
  route('GET', '/api/jobs/unscheduled', () => jobs.listUnscheduled(), { roles: ADMIN });
  route('POST', '/api/leads/:id/job', ({ params, body, actor }) => {
    const lead = leads.getLead(Number(params.id));
    if (lead.stage !== 'booked') throw new HttpError(400, 'Only booked leads go on the calendar. Log "Appointment Booked" first.');
    return jobs.scheduleLead(lead.id, jobs.parseSchedule(body), actor);
  });
  route('GET', '/api/jobs/:id', ({ params }) => jobs.getJob(Number(params.id)), { roles: ANY_LOGIN });
  // The job's price: sales and admins set it; shop logins never see it.
  route('PATCH', '/api/jobs/:id/amount', ({ params, body, actor }) => jobs.setAmount(Number(params.id), body.amount, actor));
  route('GET', '/api/revenue', ({ query }) => jobs.revenueJobs({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  route('PATCH', '/api/jobs/:id', ({ params, body, actor }) => jobs.updateJob(Number(params.id), body, actor), { roles: CALENDAR });
  route('POST', '/api/jobs/:id/checklist', ({ params, body, actor }) => jobs.addItem(Number(params.id), body, actor), { roles: CALENDAR });
  route('PATCH', '/api/jobs/:id/checklist/:item', ({ params, body, actor }) =>
    jobs.updateItem(Number(params.id), Number(params.item), body, actor), { roles: CALENDAR });
  route('DELETE', '/api/jobs/:id/checklist/:item', ({ params, actor }) => jobs.deleteItem(Number(params.id), Number(params.item), actor), { roles: CALENDAR });
  // Photos arrive as the raw image bytes (the browser shrinks them first).
  route('POST', '/api/jobs/:id/photos', ({ params, raw, query, actor }) =>
    jobs.addPhoto(Number(params.id), raw, { phase: query.get('phase'), caption: query.get('caption') }, actor),
  { roles: CALENDAR, rawBody: true, bodyLimit: 15_000_000 });
  route('GET', '/api/jobs/:id/photos/:photo', ({ params, res }) => {
    const photo = jobs.getPhoto(Number(params.id), Number(params.photo));
    const data = fs.readFileSync(photo.path);
    res.writeHead(200, {
      'Content-Type': photo.mime,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }, { roles: ANY_LOGIN });
  route('DELETE', '/api/jobs/:id/photos/:photo', ({ params, actor }) => jobs.deletePhoto(Number(params.id), Number(params.photo), actor), { roles: CALENDAR });

  // ---- Updates feed (admin) ----
  route('GET', '/api/updates', ({ query, actor }) => {
    const feed = leads.listUpdates({ before: Number(query.get('before')) || null, limit: Number(query.get('limit')) || 100, user: actor.user });
    // Tag each change with the login level of whoever made it (sales vs shop).
    const roleOf = new Map(users.list().map((u) => [u.name, u.role]));
    for (const u of feed.updates) u.user_role = roleOf.get(u.user_name) ?? null;
    return feed;
  }, { roles: ADMIN });
  // ---- Team (admin): add logins, change levels, reset passwords, deactivate ----
  route('GET', '/api/users', () => ({ users: users.list(), history: users.history(), roles: ROLES, minPassword: MIN_PASSWORD }), { roles: ADMIN });
  route('POST', '/api/users', ({ body, actor }) => users.create(body, actor), { roles: ADMIN });
  route('PATCH', '/api/users/:id', ({ params, body, actor }) => users.update(Number(params.id), body, actor), { roles: ADMIN });

  route('GET', '/api/updates/count', ({ actor }) => ({ unseen: leads.countUnseenUpdates(actor.user) }), { roles: ADMIN });
  route('POST', '/api/updates/seen', ({ actor }) => leads.markUpdatesSeen(actor.user), { roles: ADMIN });

  route('POST', '/api/leads/:id/restore', ({ params, actor }) => leads.restoreLead(Number(params.id), actor));

  // Excel download of the leads matching the same filters as the board (view=all by default).
  route('GET', '/api/export.xlsx', ({ query, res }) => {
    leads.archiveOldLeads();
    const filters = leadFilters(query);
    const rows = leads.exportLeads(filters);
    const label = { active: 'Active Leads', old: 'Old & Dead Leads', customers: 'Past Customers' }[filters.view] || 'All Leads';
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${label.replace(/\W+/g, '-')}-${stamp}.xlsx"`,
    });
    res.end(leadsWorkbook(rows, { title: label }));
  }, { roles: ADMIN });
  route('POST', '/api/leads', ({ body, actor }) => leads.ingest({ ...body, source: 'manual' }, actor));
  route('GET', '/api/leads/:id', ({ params }) => leads.getLead(Number(params.id)));
  route('PATCH', '/api/leads/:id', ({ params, body, actor }) => leads.updateLead(Number(params.id), body, actor));
  route('POST', '/api/leads/:id/disposition', async ({ params, body, actor }) => {
    const id = Number(params.id);
    const schedule = DISPOSITIONS_BY_ID[body.disposition]?.schedules ? jobs.parseSchedule(body) : null;
    const amount = schedule ? parseAmount(body.job_amount) : null;
    const result = leads.dispositionLead(id, body, actor);
    if (schedule) {
      result.job = jobs.scheduleLead(id, schedule, actor);
      if (amount != null) result.job = jobs.setAmount(result.job.id, body.job_amount, actor);
      result.lead = leads.getLead(id);
    }
    // The rep can untick "send follow-up email" for a single call.
    const message = body.send_email === false ? null : leads.followUpEmailFor(id, body.disposition);
    let email = null;
    if (message) {
      try {
        await mailer.send(message);
        email = leads.recordEmail(id, message, { status: 'sent', trigger: body.disposition, ...actor });
      } catch (err) {
        // The disposition is already saved; a failed email shows on the lead instead.
        const status = mailer.configured ? 'failed' : 'not_configured';
        email = leads.recordEmail(id, message, { status, error: err.message, trigger: body.disposition, ...actor });
      }
      result.lead = leads.getLead(id);
    }
    return { ...result, email };
  });
  route('POST', '/api/leads/:id/notes', ({ params, body, actor }) => leads.addNote(Number(params.id), body.note, actor));
  route('GET', '/api/settings/email', () => leads.getEmailSettings());
  route('GET', '/api/settings/reviews', () => ({ ...reviews.getSettings(), emailConfigured: mailer.configured }), { roles: ADMIN });
  route('PUT', '/api/settings/reviews', ({ body }) => reviews.saveSettings(body), { roles: ADMIN });

  // ---- Sign in / sign out ----
  route('POST', '/api/login', ({ req, res, body }) => {
    const key = loginKey(req, body.name);
    if (tooManyTries(key)) throw new HttpError(429, 'Too many wrong tries. Wait 15 minutes, or ask an admin to reset your password.');
    const user = users.authenticate(String(body.name || '').trim(), String(body.password || ''));
    if (!user) {
      loginFailures.get(key).push(Date.now());
      throw new HttpError(401, 'That name and password don\'t match. Check them and try again.');
    }
    loginFailures.delete(key);
    const { token, maxAge } = users.createSession(user.name);
    send(res, 200, { name: user.name, role: user.role }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }, { isPublic: true });
  route('POST', '/api/logout', ({ req, res }) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) users.endSession(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }, { isPublic: true });

  // ---- Quotes (sales and admins) ----
  route('GET', '/api/settings/prices', () => quotes.getPrices());
  route('PUT', '/api/settings/prices', ({ body }) => quotes.savePrices(body), { roles: ADMIN });
  route('POST', '/api/quotes/preview', ({ body }) => quotes.priceQuote(body));
  route('POST', '/api/leads/:id/quotes', ({ params, body, actor }) => quotes.saveQuote(Number(params.id), body, actor));
  route('POST', '/api/quotes/:id/email', async ({ params, actor }) => {
    const { quote, message } = quotes.quoteEmail(Number(params.id));
    try {
      await mailer.send(message);
    } catch (err) {
      leads.recordEmail(quote.lead_id, message, { status: 'failed', error: err.message, trigger: 'quote', user: actor.user, label: 'Quote email' });
      throw new HttpError(502, `The quote email didn't send: ${err.message}`);
    }
    leads.recordEmail(quote.lead_id, message, { status: 'sent', trigger: 'quote', user: actor.user, label: 'Quote email' });
    return { quote: quotes.markEmailed(quote.id, message.to), lead: leads.getLead(quote.lead_id) };
  });

  // ---- Lead source report (admin) ----
  route('GET', '/api/reports/sources', ({ query }) => leads.sourceReport({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  route('PUT', '/api/settings/email', ({ body }) => leads.saveEmailSettings(body), { roles: ADMIN });
  route('GET', '/api/reminders', ({ query }) => leads.listReminders({ status: query.get('status') || 'open' }));
  route('POST', '/api/reminders/:id/complete', ({ params, actor }) => leads.completeReminder(Number(params.id), actor));
  route('POST', '/api/reminders/:id/snooze', ({ params, body }) => leads.snoozeReminder(Number(params.id), body.due_at));

  route('POST', '/api/facebook/sync', async () => {
    if (!config.facebook.pageAccessToken) throw new HttpError(400, 'Set FB_PAGE_ACCESS_TOKEN to sync Facebook leads.');
    if (!config.facebook.formIds.length) throw new HttpError(400, 'Set FB_FORM_IDS to the lead form IDs to sync.');
    let created = 0;
    let fetched = 0;
    for (const formId of config.facebook.formIds) {
      for (const fbLead of await fb.fetchFormLeads(formId)) {
        fetched++;
        if (leads.ingest(facebook.mapFacebookLead(fbLead)).created) created++;
      }
    }
    return { fetched, created };
  }, { roles: ADMIN });

  // Phone install details, named after the company.
  route('GET', '/manifest.webmanifest', ({ res }) => {
    send(res, 200, JSON.stringify({
      name: config.brand.name,
      short_name: config.brand.shortName,
      description: `Leads, calls and call-backs for ${config.brand.name}.`,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#00142b',
      theme_color: '#00142b',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }), { 'Content-Type': 'application/manifest+json' });
  }, { isPublic: true });

  // ---- Facebook Lead Ads webhook ----
  // Meta calls GET once to verify the endpoint, then POSTs each new lead.
  route('GET', '/webhooks/facebook', ({ query, res }) => {
    const ok = query.get('hub.mode') === 'subscribe'
      && config.facebook.verifyToken
      && query.get('hub.verify_token') === config.facebook.verifyToken;
    if (!ok) throw new HttpError(403, 'Verification failed');
    send(res, 200, query.get('hub.challenge') || '');
  }, { isPublic: true });

  route('POST', '/webhooks/facebook', async ({ raw, req, body }) => {
    if (config.facebook.appSecret
      && !facebook.verifySignature(raw, req.headers['x-hub-signature-256'], config.facebook.appSecret)) {
      throw new HttpError(401, 'Bad signature');
    }
    const events = facebook.extractLeadgenEvents(body);
    const results = [];
    for (const event of events) {
      try {
        const { lead, created } = await ingestFacebookLead(event.leadgen_id);
        results.push({ leadgen_id: event.leadgen_id, lead_id: lead.id, created });
      } catch (err) {
        // Still answer 200 so Meta doesn't disable the webhook; "Sync Facebook" will catch it later.
        console.error(`Facebook lead ${event.leadgen_id} failed:`, err.message);
        results.push({ leadgen_id: event.leadgen_id, error: err.message });
      }
    }
    return { received: events.length, results };
  }, { isPublic: true });

  // ---- Website form intake ----
  route('OPTIONS', '/api/intake/website', ({ req, res }) => {
    res.writeHead(204, corsHeaders(req));
    res.end();
  }, { isPublic: true });

  route('POST', '/api/intake/website', ({ req, res, body }) => {
    const cors = corsHeaders(req);
    const key = req.headers['x-api-key'] || body.api_key;
    if (config.website.apiKey && !safeEqual(key || '', config.website.apiKey)) {
      return send(res, 401, { error: 'Invalid API key' }, cors);
    }
    const redirect = /^https?:\/\//.test(body._redirect || '') ? body._redirect : null;
    if (!isSpam(body)) leads.ingest(mapWebsiteLead(body));
    // Plain HTML forms can post here directly and land on a thank-you page.
    if (redirect) return send(res, 303, '', { ...cors, Location: redirect });
    send(res, 201, { ok: true }, cors);
  }, { isPublic: true });

  // Move two-week-old leads off the boards now and every hour.
  leads.archiveOldLeads();
  const sweep = setInterval(() => leads.archiveOldLeads(), 3600000);
  sweep.unref();
  // Review-request emails go out every 15 minutes once they're due.
  const sendReviews = () => reviews.sendDue().catch((err) => console.error('Review requests failed:', err.message));
  sendReviews();
  const reviewTimer = setInterval(sendReviews, 15 * 60000);
  reviewTimer.unref();

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          // The sign-in page and what it needs load without signing in.
          if (url.pathname === '/login') {
            if (users.anyLogins() && authenticate(req)) return send(res, 302, '', { Location: '/' });
            return serveStatic(req, res, '/login.html');
          }
          const openAsset = url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/')
            || ['/styles.css', '/login.html', '/manifest.webmanifest'].includes(url.pathname);
          if (!openAsset && !authenticate(req)) return send(res, 302, '', { Location: '/login' });
          return serveStatic(req, res, url.pathname);
        }
        return send(res, 404, { error: 'Not found' });
      }
      const user = match.isPublic ? null : authenticate(req);
      if (!match.isPublic && !user) {
        return send(res, 401, { error: 'Sign in to continue.' });
      }
      if (!match.isPublic && !match.roles.includes(user.role)) {
        return send(res, 403, { error: `A ${user.role} login can't do that.` });
      }
      const actor = { user: user?.name ?? null, role: user?.role ?? null };
      const values = url.pathname.match(match.re).slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req, match.bodyLimit) : Buffer.alloc(0);
      const body = match.rawBody ? {} : parseBody(raw, req.headers['content-type']);
      let result = await match.handler({ req, res, params, query: url.searchParams, body, raw, actor });
      if (actor.role === 'shop') result = hideAmount(result);
      if (!res.headersSent) send(res, req.method === 'POST' ? 201 : 200, result ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      const cors = url.pathname.startsWith('/api/intake/') ? corsHeaders(req) : {};
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message }, cors);
    }
  };
}

if (require.main === module) {
  if (!config.users.length) console.warn('Note: no APP_USERS or APP_PASSWORD set. Until an admin adds a login on the Team panel, the dashboard has no login.');
  if (!config.facebook.appSecret) console.warn('Warning: FB_APP_SECRET is not set, so Facebook webhook signatures are not checked.');
  http.createServer(createApp()).listen(config.port, () => {
    console.log(`Lead Pipeline running at http://localhost:${config.port}`);
  });
}

module.exports = { createApp };
