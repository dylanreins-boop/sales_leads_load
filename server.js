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
const { createCommissionService, DEPOSIT_METHODS, OWED_WHEN } = require('./src/commissions');
const { createTexter } = require('./src/sms');
const { createMessageService } = require('./src/messages');
const { createPush } = require('./src/push');
const { createAlertService } = require('./src/alerts');
const { createStripe } = require('./src/stripe');
const { createBookingService } = require('./src/bookings');
const { createDaySheetMailer } = require('./src/daysheet');
const { createImportService } = require('./src/import');

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
  const forwarded = config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = String(req.headers['fly-client-ip'] || forwarded || req.socket?.remoteAddress || '');
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

// The address this request came in on, e.g. https://leads.bobmosescc.com (PUBLIC_URL wins when set).
function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`;
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
  const commissions = createCommissionService(db, { leads, jobs });
  leads.setJobDecorator((job) => commissions.figures(job));
  const texter = createTexter(config.sms, fetchImpl);
  const push = createPush(db, {
    subject: config.publicUrl || `mailto:${config.email.from || 'alerts@example.com'}`,
    fetchImpl,
  });
  const alerts = createAlertService(db, { leads, users, push, texter, minutes: config.speedToLeadMinutes, hours: config.alertHours });
  const runAlerts = () => alerts.process({ baseUrl: config.publicUrl }).catch((err) => console.error('Lead alerts failed:', err.message));
  leads.setCreatedHook((lead) => {
    alerts.leadArrived(lead);
    runAlerts();
  });
  const messages = createMessageService(db, {
    leads, jobs, texter, mailer, brand: config.brand,
    onReply: (lead, text) => alerts.replied(lead, text, { baseUrl: config.publicUrl }).catch((err) => console.error('Reply alert failed:', err.message)),
  });
  const stripe = createStripe(config.stripe, fetchImpl);
  const bookings = createBookingService(db, { leads, jobs, commissions, messages, stripe, alerts, brand: config.brand });
  const daySheets = createDaySheetMailer(db, { jobs, mailer, brand: config.brand });
  const importer = createImportService(db, { leads, archiveDays: config.archiveDays });
  // Booking confirmations never hold up or undo a booking; problems are logged on the lead.
  const confirmBooking = (jobId, actor) => messages.sendConfirmation(jobId, actor)
    .catch((err) => ({ sent: [], problems: [err.message] }));
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
    shopHours: jobs.getShopHours(),
    textingConfigured: texter.configured,
    paymentsConfigured: stripe.configured,
    depositMethods: DEPOSIT_METHODS,
    commissionOwedWhen: OWED_WHEN,
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
  // Booked shop hours on the days a proposed job would be worked, and what's worth a warning.
  route('GET', '/api/jobs/capacity', ({ query }) => jobs.capacity({
    id: query.get('job') ? Number(query.get('job')) : undefined,
    start: query.get('start'),
    end: query.get('end'),
    hours: query.get('hours') ? Number(query.get('hours')) : null,
    pipeline: query.get('pipeline') || 'other',
  }), { roles: ANY_LOGIN });
  route('GET', '/api/settings/shop-hours', () => jobs.getShopHours(), { roles: ANY_LOGIN });
  // The day sheet: drop-offs, pick-ups and jobs in the shop for one day (and its morning email).
  route('GET', '/api/jobs/day-sheet', ({ query }) => jobs.daySheet(query.get('date')), { roles: ANY_LOGIN });
  route('GET', '/api/settings/day-sheet', () => ({ ...daySheets.getSettings(), emailConfigured: mailer.configured }), { roles: ADMIN });
  route('PUT', '/api/settings/day-sheet', ({ body }) => daySheets.saveSettings(body), { roles: ADMIN });
  route('PUT', '/api/settings/shop-hours', ({ body }) => jobs.saveShopHours(body), { roles: ADMIN });
  route('POST', '/api/leads/:id/job', async ({ params, body, actor }) => {
    const lead = leads.getLead(Number(params.id));
    if (lead.stage !== 'booked') throw new HttpError(400, 'Only booked leads go on the calendar. Log "Appointment Booked" first.');
    const job = jobs.scheduleLead(lead.id, jobs.parseSchedule(body), actor);
    const confirmation = body.send_confirmation === false ? null : await confirmBooking(job.id, actor);
    return { ...job, shop_time: jobs.capacityFor(job), confirmation };
  });
  route('GET', '/api/jobs/:id', ({ params }) => {
    const job = jobs.getJob(Number(params.id));
    return { ...job, shop_time: jobs.capacityFor(job) };
  }, { roles: ANY_LOGIN });
  // The job's price: sales and admins set it; shop logins never see it.
  route('PATCH', '/api/jobs/:id/amount', ({ params, body, actor }) => jobs.setAmount(Number(params.id), body.amount, actor));
  route('GET', '/api/revenue', ({ query }) => jobs.revenueJobs({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  route('PATCH', '/api/jobs/:id', ({ params, body, actor }) => {
    const before = jobs.getJob(Number(params.id));
    const job = commissions.watchOwed(Number(params.id), () => jobs.updateJob(Number(params.id), body, actor), actor);
    if (job.start_at !== before.start_at) messages.jobMoved(job.id);
    return { ...job, shop_time: jobs.capacityFor(job) };
  }, { roles: CALENDAR });
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
  // Customer sign-off at drop-off (signature drawn on the tablet or phone).
  route('POST', '/api/jobs/:id/signoff', ({ params, body, actor }) =>
    jobs.signOff(Number(params.id), body, { ...actor, company: config.brand.name }), { roles: CALENDAR, bodyLimit: 1_000_000 });
  route('DELETE', '/api/jobs/:id/signoff', ({ params, actor }) => jobs.clearSignOff(Number(params.id), actor), { roles: ADMIN });
  route('GET', '/api/jobs/:id/signoff.png', ({ params, res }) => {
    const data = fs.readFileSync(jobs.signOffImage(Number(params.id)));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
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
  // When the last off-server backup ran, and whether it worked (admins, shown under Team).
  route('GET', '/api/backup-status', () => {
    try {
      return { configured: true, ...JSON.parse(fs.readFileSync(config.backupStatusFile, 'utf8')) };
    } catch {
      return { configured: false };
    }
  }, { roles: ADMIN });
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
    if (schedule && body.deposit_taken && amount == null && !String(body.deposit_amount ?? '').trim()) {
      throw new HttpError(400, 'Enter the job amount (or the deposit amount) to record the deposit.');
    }
    if (schedule && body.deposit_taken) parseAmount(body.deposit_amount);
    const result = leads.dispositionLead(id, body, actor);
    if (schedule) {
      result.job = jobs.scheduleLead(id, schedule, actor);
      if (amount != null) result.job = jobs.setAmount(result.job.id, body.job_amount, actor);
      if (body.deposit_taken) {
        commissions.setDeposit(result.job.id, { taken: true, amount: body.deposit_amount, method: body.deposit_method }, actor);
      }
      result.job = commissions.forJob(result.job.id);
      result.shop_time = jobs.capacityFor(result.job);
      if (body.send_confirmation !== false) result.confirmation = await confirmBooking(result.job.id, actor);
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

  // ---- Deposits and commissions ----
  route('GET', '/api/settings/commission', () => commissions.getSettings());
  route('PUT', '/api/settings/commission', ({ body }) => commissions.saveSettings(body), { roles: ADMIN });
  route('PATCH', '/api/jobs/:id/deposit', ({ params, body, actor }) =>
    commissions.watchOwed(Number(params.id), () => commissions.setDeposit(Number(params.id), body, actor), actor));
  route('GET', '/api/commissions/owed', () => commissions.owedSummary(), { roles: ADMIN });
  route('PATCH', '/api/jobs/:id/commission', ({ params, body, actor }) => commissions.setCommission(Number(params.id), body, actor), { roles: ADMIN });
  route('POST', '/api/jobs/:id/commission/unpay', ({ params, actor }) => commissions.unpay(Number(params.id), actor), { roles: ADMIN });
  route('POST', '/api/commissions/pay', ({ body, actor }) => commissions.pay(body.job_ids, { user: actor.user, note: body.note }), { roles: ADMIN });
  // Sales reps see their own commissions; admins see everyone's.
  route('GET', '/api/commissions', ({ query, actor }) => {
    const all = actor.role === 'admin';
    const result = commissions.list({ rep: all ? query.get('rep') || null : actor.user || '' });
    return { ...result, reps: all ? [...new Set([...users.list().map((u) => u.name), ...result.jobs.map((j) => j.commission_rep).filter(Boolean)])] : [actor.user] };
  });

  // ---- Texts and automatic customer messages ----
  route('GET', '/api/texts/templates', () => messages.getTemplates());
  route('PUT', '/api/texts/templates', ({ body }) => messages.saveTemplates(body.templates), { roles: ADMIN });
  // A saved text filled in for this lead (the rep can still edit it before sending).
  route('POST', '/api/leads/:id/texts/fill', ({ params, body, actor }) => {
    const template = messages.getTemplates().find((t) => t.id === body.template_id);
    if (!template) throw new HttpError(404, 'That saved text was removed. Pick another.');
    return { body: messages.render(template.body, leads.getLead(Number(params.id)), { rep: actor.user }) };
  });
  route('POST', '/api/leads/:id/texts', async ({ params, body, actor }) => {
    const text = await messages.sendText(Number(params.id), body.body, actor);
    return { text, lead: leads.getLead(Number(params.id)) };
  });
  route('GET', '/api/settings/notices', () => ({ ...messages.getNotices(), textingConfigured: texter.configured, emailConfigured: mailer.configured }));
  route('PUT', '/api/settings/notices', ({ body }) => messages.saveNotices(body), { roles: ADMIN });

  // Customer replies (Twilio "A message comes in" webhook). Answers with empty TwiML.
  route('POST', '/webhooks/twilio', ({ req, res, body }) => {
    const url = `${baseUrl(req)}${req.url}`;
    if (!texter.verify(url, body, req.headers['x-twilio-signature'])) throw new HttpError(401, 'Bad signature');
    messages.receiveText({ from: body.From, body: body.Body, id: body.MessageSid });
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }, { isPublic: true });

  // ---- Online booking links ----
  // The rep makes a link (price, work time, services) and sends it by text or email, or copies it.
  route('POST', '/api/leads/:id/booking-links', async ({ req, params, body, actor }) => {
    const id = Number(params.id);
    const link = bookings.create(id, body, actor);
    const url = `${baseUrl(req)}/book/${link.token}`;
    const lead = leads.getLead(id);
    const money = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let sent = null;
    if (body.send === 'text') {
      await messages.sendText(id, messages.render(
        'Hi {{first_name}}, {{rep}} from {{company}}. Your {{vehicle}} comes to {{price}}. Pick your drop-off day here: {{booking_link}}',
        lead, { rep: actor.user, extra: { booking_link: url, price: money(link.amount_cents) } },
      ), { ...actor, trigger: 'booking_link' });
      sent = 'text';
    } else if (body.send === 'email') {
      if (!lead.email) throw new HttpError(400, 'This lead has no email address. Copy the link or text it instead.');
      if (!mailer.configured) throw new HttpError(400, 'Email sending isn\'t set up yet. Copy the link or text it instead.');
      const message = {
        to: lead.email,
        subject: `Book your appointment with ${config.brand.name}`,
        text: messages.render(`Hi {{first_name}},\n\nThanks for your interest in ceramic coating for your {{vehicle}}. The price is {{price}}{{deposit_line}}.\n\nPick the day that works for you here:\n{{booking_link}}\n\nQuestions? Reply to this email or call {{company_phone}}.\n\n{{rep}}\n{{company}}`,
          lead, { rep: actor.user, extra: { booking_link: url, price: money(link.amount_cents), deposit_line: link.deposit_cents ? `, with a ${money(link.deposit_cents)} deposit to hold your spot` : '' } }),
      };
      try {
        await mailer.send(message);
        leads.recordEmail(id, message, { status: 'sent', trigger: 'booking_link', user: actor.user, label: 'Booking link' });
      } catch (err) {
        leads.recordEmail(id, message, { status: 'failed', error: err.message, trigger: 'booking_link', user: actor.user, label: 'Booking link' });
        throw new HttpError(502, `The email didn't go out: ${err.message}`);
      }
      sent = 'email';
    }
    return { link: { ...link, url }, sent, lead: leads.getLead(id) };
  });
  route('POST', '/api/booking-links/:id/cancel', ({ params, actor }) => bookings.cancel(Number(params.id), actor));
  // What the customer's booking page shows; ?paid= is Stripe sending them back after paying.
  route('GET', '/api/public/booking/:token', async ({ params, query }) => {
    if (query.get('paid')) await bookings.confirmPayment(params.token, query.get('paid')).catch((err) => console.error('Payment check failed:', err.message));
    return bookings.view(params.token);
  }, { isPublic: true });
  route('POST', '/api/public/booking/:token', ({ req, params, body }) => bookings.book(params.token, body, { baseUrl: baseUrl(req) }), { isPublic: true });
  route('POST', '/api/public/booking/:token/pay', async ({ req, params }) => ({ redirect: await bookings.startPayment(params.token, { baseUrl: baseUrl(req) }) }), { isPublic: true });
  // Stripe: "checkout.session.completed" marks the deposit paid (signature checked).
  route('POST', '/webhooks/stripe', ({ raw, req }) => {
    if (!stripe.verify(raw.toString('utf8'), req.headers['stripe-signature'])) throw new HttpError(400, 'Bad signature');
    return { received: true, recorded: bookings.paymentWebhook(JSON.parse(raw.toString('utf8'))) };
  }, { isPublic: true, rawBody: true });

  // ---- Phone alerts (new leads, customer replies) ----
  route('GET', '/api/alerts/me', ({ actor }) => ({
    ...alerts.prefs(actor.user || 'admin'),
    publicKey: push.publicKey(),
    minutes: config.speedToLeadMinutes,
    hours: config.alertHours,
  }));
  route('PUT', '/api/alerts/me', ({ body, actor }) => alerts.savePrefs(actor.user || 'admin', body));
  route('POST', '/api/alerts/subscribe', ({ req, body, actor }) => push.subscribe(actor.user || 'admin', body.subscription, req.headers['user-agent']));
  route('POST', '/api/alerts/unsubscribe', ({ body }) => {
    push.unsubscribe(body.endpoint);
    return { ok: true };
  });
  route('POST', '/api/alerts/test', async ({ actor }) => {
    const name = actor.user || 'admin';
    const reached = await push.sendTo([name], { title: 'Alerts are on', body: 'New leads will show up here like this.', url: '/', tag: 'test' });
    return { delivered: reached.length > 0 };
  });

  // ---- Importing leads from a spreadsheet (admins) ----
  route('POST', '/api/import/upload', ({ raw, query }) => importer.load(raw, query.get('name')), { roles: ADMIN, rawBody: true, bodyLimit: 10_000_000 });
  route('POST', '/api/import/check', ({ body }) => importer.check(body.token, body.mapping), { roles: ADMIN });
  route('POST', '/api/import/commit', ({ body, actor }) => importer.commit(body.token, body.mapping, body, actor), { roles: ADMIN });
  route('GET', '/api/import/batches', () => importer.batches(), { roles: ADMIN });
  route('POST', '/api/import/batches/:id/undo', ({ params, actor }) => importer.undo(params.id, actor), { roles: ADMIN });
  route('GET', '/api/import/template.csv', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lead-import-template.csv"' });
    res.end(importer.template());
  }, { roles: ADMIN });

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
  // New-lead alerts and the "nobody called yet" alert to admins, checked every minute.
  const alertTimer = setInterval(runAlerts, 60000);
  alertTimer.unref();
  // Day-before reminders to customers and the shop's morning day sheet, checked every 5 minutes.
  const sendReminders = () => {
    messages.sendDueReminders().catch((err) => console.error('Customer reminders failed:', err.message));
    daySheets.sendDue().catch((err) => console.error('Day sheet email failed:', err.message));
  };
  const noticeTimer = setInterval(sendReminders, 5 * 60000);
  noticeTimer.unref();

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
          // Customers' booking pages are public; the link itself is the key.
          if (/^\/book\/[\w-]+\/?$/.test(url.pathname)) return serveStatic(req, res, '/book.html');
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
  http.createServer(createApp()).listen(config.port, config.host, () => {
    console.log(`Lead Pipeline running at http://localhost:${config.port}`);
  });
}

module.exports = { createApp };
