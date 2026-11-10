const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./src/config');
const { openDatabase } = require('./src/db');
const { createLeadService, HttpError } = require('./src/leads');
const { STAGES, DISPOSITIONS } = require('./src/pipeline');
const facebook = require('./src/facebook');
const { createGoogleLsaClient } = require('./src/google-lsa');
const { createAnalyticsService } = require('./src/analytics');
const { createWorkTimeService } = require('./src/worktime');
const { createEstimateService } = require('./src/estimates');
const { createCardImportService } = require('./src/cardimport');
const { createCallService } = require('./src/calls');
const { createCallSummarizer } = require('./src/callsummary');
const { mapWebsiteLead, isSpam } = require('./src/website');
const { createMailer, PLACEHOLDERS } = require('./src/email');
const { VEHICLE_FIELDS, VEHICLE_TYPES, PIPELINES } = require('./src/vehicle');
const { createPipelineService } = require('./src/pipelines');
const { createTimeService, TIME_OFF_KINDS } = require('./src/timeclock');
const { BOOKING_SERVICES } = require('./src/services');
const { HEARD_ABOUT_OPTIONS } = require('./src/answers');
const { leadsWorkbook } = require('./src/export');
const { createJobService, JOB_STATUSES, PHOTO_PHASES, parseAmount, hideAmount } = require('./src/jobs');
const { DISPOSITIONS_BY_ID } = require('./src/pipeline');
const { createUserService, ROLES, MIN_PASSWORD } = require('./src/users');
const { createQuoteService } = require('./src/quotes');
const { createReviewService } = require('./src/reviews');
const { createCommissionService, DEPOSIT_METHODS, OWED_WHEN } = require('./src/commissions');
const { createTexter, toE164 } = require('./src/sms');
const { createMessageService } = require('./src/messages');
const { createPush } = require('./src/push');
const { createAlertService } = require('./src/alerts');
const { createStripe } = require('./src/stripe');
const { createBookingService } = require('./src/bookings');
const { createDaySheetMailer } = require('./src/daysheet');
const { createImportService } = require('./src/import');
const { createAppearanceService } = require('./src/appearance');
const { createPaymentService } = require('./src/payments');
const { invoicePdf } = require('./src/invoices');
const { createCampaignService } = require('./src/campaigns');
const { createReferralService } = require('./src/referrals');
const { createAdSpendService, PAID_SOURCES } = require('./src/adspend');

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

function createApp({ db = openDatabase(config.dbPath), fetchImpl, photosDir, summarizer } = {}) {
  const leads = createLeadService(db, {
    reminderHour: config.reminderHour,
    skipWeekends: config.reminderSkipWeekends,
    archiveDays: config.archiveDays,
    brand: config.brand,
  });
  const fb = facebook.createFacebookClient(config.facebook, fetchImpl);
  const mailer = createMailer(config.email, fetchImpl);
  const filesDir = photosDir || config.photosDir || path.join(path.dirname(config.dbPath), 'photos');
  const jobs = createJobService(db, { leads, photosDir: filesDir });
  const appearance = createAppearanceService(db, { photosDir: filesDir });
  const users = createUserService(db, { serverUsers: config.users });
  // The admins' pipelines, loaded before anything sorts leads onto them.
  const pipelines = createPipelineService(db);
  pipelines.load();
  const quotes = createQuoteService(db, { leads, brand: config.brand });
  const reviews = createReviewService(db, { leads, mailer, brand: config.brand });
  const commissions = createCommissionService(db, { leads, jobs });
  const payments = createPaymentService(db, { leads, jobs });
  leads.setJobDecorator((job) => payments.decorate(commissions.figures(job)));
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
    // Every new lead gets a thank-you text asking the best time of day to reach them.
    if (messages.queueWelcome(lead)) messages.sendWelcomes().catch((err) => console.error('Welcome text failed:', err.message));
  });
  const messages = createMessageService(db, {
    leads, jobs, texter, mailer, brand: config.brand,
    onReply: (lead, text) => alerts.replied(lead, text, { baseUrl: config.publicUrl }).catch((err) => console.error('Reply alert failed:', err.message)),
  });
  const stripe = createStripe(config.stripe, fetchImpl);
  const bookings = createBookingService(db, { leads, jobs, commissions, messages, stripe, alerts, brand: config.brand });
  const daySheets = createDaySheetMailer(db, { jobs, mailer, brand: config.brand });
  const campaigns = createCampaignService(db, { leads, messages, bookings, mailer, texter, publicUrl: config.publicUrl });
  const referrals = createReferralService(db, { leads, brand: config.brand });
  const adSpend = createAdSpendService(db);
  const googleLsa = createGoogleLsaClient(config.googleAds, { db, leads, fetchImpl });
  const workTime = createWorkTimeService(db, { jobs, leads });
  const cardImport = createCardImportService(db, { payments, leads });
  // The dialer exists only in the build with CALLS_ENABLED; without it the app is exactly as before.
  const calls = config.calls.enabled ? createCallService(db, {
    leads, sms: config.sms, summarizer: summarizer || createCallSummarizer(), publicUrl: config.publicUrl,
    notice: config.calls.notice, hours: config.calls.hours, brand: config.brand, fetchImpl: fetchImpl || ((...a) => fetch(...a)),
  }) : null;
  const estimates = createEstimateService(db, { getShopHours: jobs.getShopHours });
  jobs.setEstimator((lead, services) => estimates.suggest({ ...lead, services }).hours);
  const analytics = createAnalyticsService(db, { commissions, payments, jobs, users, estimates });
  // Someone clocked in (or tried to) away from the shop: ping every admin's phone right away.
  const timeClock = createTimeService(db, {
    users, getShopHours: jobs.getShopHours, mailer, brand: config.brand, publicUrl: config.publicUrl,
    onAlert: (msg) => alerts.notify(users.list().filter((u) => u.active !== false && u.role === 'admin').map((u) => u.name), {
      title: `⚠ ${msg.title}`, body: msg.body, link: `${config.publicUrl || ''}/#time`, tag: 'clock-alert',
    }),
  });
  const importer = createImportService(db, { leads, archiveDays: config.archiveDays });
  // Booking confirmations never hold up or undo a booking; problems are logged on the lead.
  const confirmBooking = (jobId, actor) => messages.sendConfirmation(jobId, actor)
    .catch((err) => ({ sent: [], problems: [err.message] }));
  const routes = [];

  // Returns the signed-in user ({ name, role }), or null if the login is wrong.
  // The sign-in page sets a session cookie; scripts can still use HTTP Basic auth.
  // With no logins at all: open (everyone an admin) on a computer for trying it out; on the live server
  // nobody gets in until the first admin login is set up on the sign-in page.
  const needsSetup = () => !users.anyLogins() && !config.openWithoutLogins;
  function authenticate(req) {
    if (!users.anyLogins()) return config.openWithoutLogins ? { name: null, role: 'admin' } : null;
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
    googleLsaConfigured: googleLsa.configured,
    emailConfigured: mailer.configured,
    callsEnabled: Boolean(calls),
    callsReady: calls ? { phone: calls.configured, publicUrl: Boolean(config.publicUrl), ai: Boolean((summarizer || createCallSummarizer()).configured) } : null,
    emailPlaceholders: PLACEHOLDERS,
    vehicleFields: VEHICLE_FIELDS,
    vehicleTypes: VEHICLE_TYPES,
    pipelines: pipelines.visibleTo(actor),
    // Every pipeline's vehicle types, so a lead's pipeline reads the same for everyone.
    allPipelines: PIPELINES.map(({ id, label, types }) => ({ id, label, types })),
    bookingServices: BOOKING_SERVICES,
    heardAboutOptions: HEARD_ABOUT_OPTIONS,
    timeOffKinds: TIME_OFF_KINDS,
  }), { roles: ANY_LOGIN });
  const leadFilters = (query) => ({
    q: query.get('q'),
    source: query.get('source'),
    pipeline: query.get('pipeline'),
    view: query.get('view') || undefined,
    vehicleType: query.get('vehicle_type'),
    status: query.get('status'),
  });
  // The search box: every lead (working, past customers, old and dead), best matches first.
  route('GET', '/api/leads/search', ({ query }) => leads.searchLeads(query.get('q')));
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
  const jobView = (id) => {
    const job = payments.decorate(commissions.figures(jobs.getJob(id)));
    return { ...job, shop_time: jobs.capacityFor(job), work: workTime.summary(id) };
  };
  route('GET', '/api/jobs/:id', ({ params }) => jobView(Number(params.id)), { roles: ANY_LOGIN });
  // Suggested work time from the shop's history: for a lead being booked, or a job already on the calendar.
  route('GET', '/api/estimate', ({ query }) => {
    const services = (query.get('services') || '').split(',').filter(Boolean);
    if (query.get('job_id')) {
      const job = jobs.getJob(Number(query.get('job_id')));
      return estimates.suggest({ vehicle_type: job.vehicle_type, vehicle_color: job.vehicle_color, services: services.length ? services : job.services });
    }
    const lead = leads.getLead(Number(query.get('lead_id')));
    return estimates.suggest({ ...lead, services: services.length ? services : lead.booked_services });
  }, { roles: ANY_LOGIN });
  // The shop's work timer: Start work, Pause, Finished (shop and admins); admins correct the record.
  route('POST', '/api/jobs/:id/work/start', ({ params, actor }) => { workTime.start(Number(params.id), actor); return jobView(Number(params.id)); }, { roles: CALENDAR });
  route('POST', '/api/jobs/:id/work/pause', ({ params, actor }) => { workTime.pause(Number(params.id), actor); return jobView(Number(params.id)); }, { roles: CALENDAR });
  route('POST', '/api/jobs/:id/work/finish', ({ params, actor }) => { workTime.finish(Number(params.id), actor); return jobView(Number(params.id)); }, { roles: CALENDAR });
  route('POST', '/api/jobs/:id/work', ({ params, body, actor }) => { workTime.addSession(Number(params.id), body, actor); return jobView(Number(params.id)); }, { roles: ADMIN });
  route('PATCH', '/api/work/:id', ({ params, body, actor }) => jobView(workTime.editSession(Number(params.id), body, actor).job_id), { roles: ADMIN });
  route('DELETE', '/api/work/:id', ({ params, actor }) => jobView(workTime.removeSession(Number(params.id), actor).job_id), { roles: ADMIN });
  // Payments after the deposit (sales and admins; the shop never sees money).
  route('POST', '/api/jobs/:id/payments', ({ params, body, actor }) => payments.add(Number(params.id), body, actor));
  route('DELETE', '/api/payments/:id', ({ params, actor }) => payments.remove(Number(params.id), actor), { roles: ADMIN });
  route('GET', '/api/payments/owed', () => payments.owed(), { roles: ADMIN });
  // The job's invoice (or receipt, once it's paid in full) as a PDF, to open or email to the customer.
  const invoiceFor = (id) => {
    const job = payments.decorate(commissions.figures(jobs.getJob(id)));
    const lead = leads.getLead(job.lead_id);
    const a = appearance.company();
    return { job, lead, ...invoicePdf(job, lead, { brand: config.brand, colors: { bar: a.dark_bar, highlight: a.highlight } }) };
  };
  route('GET', '/api/jobs/:id/invoice.pdf', ({ params, res }) => {
    const { buffer, filename } = invoiceFor(Number(params.id));
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length, 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'private, no-store' });
    res.end(buffer);
  });
  route('POST', '/api/jobs/:id/invoice/email', async ({ params, body, actor }) => {
    const { filename, buffer, kind, number, lead } = invoiceFor(Number(params.id));
    const to = String(body.to || lead.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'Add the customer\'s email address first.');
    if (!mailer.configured) throw new HttpError(400, 'Email sending isn\'t set up yet. Download the PDF and send it yourself.');
    const first = lead.first_name || (lead.full_name || '').split(' ')[0] || 'there';
    const message = {
      to,
      subject: `Your ${kind} from ${config.brand.name} (${number})`,
      text: `Hi ${first},\n\nYour ${kind} is attached.${kind === 'invoice' ? '' : ' Thank you for your business!'}\n\n${config.brand.name}${config.brand.phone ? `\n${config.brand.phone}` : ''}`,
      attachments: [{ filename, content: buffer, type: 'application/pdf' }],
    };
    const label = kind === 'invoice' ? 'Invoice' : 'Receipt';
    try {
      await mailer.send(message);
      leads.recordEmail(lead.id, message, { status: 'sent', trigger: kind, user: actor.user, label });
    } catch (err) {
      leads.recordEmail(lead.id, message, { status: 'failed', error: err.message, trigger: kind, user: actor.user, label });
      throw new HttpError(502, `The email didn't go out: ${err.message}`);
    }
    return { sent: to, kind };
  });
  // The job's price: sales and admins set it; shop logins never see it.
  route('PATCH', '/api/jobs/:id/amount', ({ params, body, actor }) => jobs.setAmount(Number(params.id), body.amount, actor));
  route('GET', '/api/revenue', ({ query }) => jobs.revenueJobs({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  route('PATCH', '/api/jobs/:id', async ({ params, body, actor }) => {
    const before = jobs.getJob(Number(params.id));
    const job = commissions.watchOwed(Number(params.id), () => jobs.updateJob(Number(params.id), body, actor), actor);
    if (job.start_at !== before.start_at) messages.jobMoved(job.id);
    const figures = payments.decorate(commissions.figures(job));
    // Marked Ready for pickup: tell the customer, with what's still owed (never shown to the shop).
    if (job.status === 'ready' && before.status !== 'ready') {
      await messages.sendReady(job.id, { user: actor.user, balanceCents: figures.amount_due_cents })
        .catch((err) => console.error('Ready-for-pickup message failed:', err.message));
    }
    return { ...figures, shop_time: jobs.capacityFor(job), work: workTime.summary(job.id) };
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
  // Both answer with the whole job (work time and shop time too), as the job panel redraws from it.
  route('POST', '/api/jobs/:id/signoff', ({ params, body, actor }) => {
    jobs.signOff(Number(params.id), body, { ...actor, company: config.brand.name });
    return jobView(Number(params.id));
  }, { roles: CALENDAR, bodyLimit: 1_000_000 });
  route('DELETE', '/api/jobs/:id/signoff', ({ params, actor }) => { jobs.clearSignOff(Number(params.id), actor); return jobView(Number(params.id)); }, { roles: ADMIN });
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
  route('POST', '/api/leads', async ({ body, actor }) => {
    const result = leads.ingest({ ...body, source: 'manual' }, actor);
    // Added by hand: the welcome text only when the rep ticks it (they may be on the phone with them).
    if (result.created && body.send_welcome && messages.queueWelcome(result.lead, { force: true })) await messages.sendWelcomes().catch(() => {});
    return { ...result, lead: leads.getLead(result.lead.id) };
  });
  route('GET', '/api/leads/:id', ({ params, query, actor }) => {
    // Opening the lead (not a quiet refresh after a save) is recorded for the card's "Opened" line.
    if (query.get('open') === '1') leads.markOpened(Number(params.id), actor);
    return leads.getLead(Number(params.id));
  });
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
  // First run on the live server: the sign-in page sets up the first admin login.
  route('GET', '/api/setup', () => ({ needed: needsSetup(), code_required: Boolean(config.setupCode) }), { isPublic: true });
  route('POST', '/api/setup', ({ req, res, body }) => {
    if (!needsSetup()) throw new HttpError(409, 'The admin login is already set up. Sign in instead.');
    if (config.setupCode && String(body.code || '').trim() !== config.setupCode) throw new HttpError(403, 'That setup code isn\'t right.');
    const name = String(body.name || '').trim();
    if (String(body.password || '') !== String(body.confirm ?? body.password)) throw new HttpError(400, 'The two passwords don\'t match.');
    const user = users.create({ name, password: String(body.password || ''), role: 'admin' }, { user: name });
    const { token, maxAge } = users.createSession(user.name);
    send(res, 201, { name: user.name, role: 'admin' }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
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
  route('GET', '/api/public/booking/:token', async ({ req, params, query }) => {
    if (query.get('paid')) await bookings.confirmPayment(params.token, query.get('paid')).catch((err) => console.error('Payment check failed:', err.message));
    // Someone signed in to the app is previewing the page (a rep checking the link).
    return { ...bookings.view(params.token), staff_preview: Boolean(users.anyLogins() && authenticate(req)) };
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
    // null where this Node build can't make push keys (phone alerts then can't be turned on).
    publicKey: (() => { try { return push.publicKey(); } catch { return null; } })(),
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
  // Card payments from the processor's export (Talech / Elavon): upload, check the matches, record.
  route('POST', '/api/card-import/upload', ({ raw, query }) => cardImport.load(raw, query.get('name')), { roles: ADMIN, rawBody: true, bodyLimit: 10_000_000 });
  route('POST', '/api/card-import/check', ({ body }) => cardImport.check(body.token, body.columns), { roles: ADMIN });
  route('POST', '/api/card-import/commit', ({ body, actor }) => cardImport.commit(body.token, body.columns, body.picks, actor), { roles: ADMIN });
  route('POST', '/api/import/upload', ({ raw, query }) => importer.load(raw, query.get('name')), { roles: ADMIN, rawBody: true, bodyLimit: 10_000_000 });
  route('POST', '/api/import/check', ({ body }) => importer.check(body.token, body.mapping), { roles: ADMIN });
  route('POST', '/api/import/commit', ({ body, actor }) => importer.commit(body.token, body.mapping, body, actor), { roles: ADMIN });
  route('GET', '/api/import/batches', () => importer.batches(), { roles: ADMIN });
  route('POST', '/api/import/batches/:id/undo', ({ params, actor }) => importer.undo(params.id, actor), { roles: ADMIN });
  route('GET', '/api/import/template.csv', ({ res }) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="lead-import-template.csv"' });
    res.end(importer.template());
  }, { roles: ADMIN });

  // ---- Appearance: the company look (admins) and each person's own look on top of it ----
  // Public, so the sign-in and booking pages get the company look; signed-in people get their own.
  const viewer = (req) => (users.anyLogins() ? authenticate(req)?.name ?? null : null);
  const signedInName = (actor) => {
    if (!actor.user) throw new HttpError(400, 'Sign in with your own login to save your own look.');
    return actor.user;
  };
  route('GET', '/appearance.css', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'private, no-cache' });
    res.end(appearance.cssFor(viewer(req)));
  }, { isPublic: true });
  route('GET', '/api/appearance', ({ req }) => appearance.view(viewer(req)), { isPublic: true });
  route('GET', '/api/appearance/files/:file', ({ params, res }) => {
    const file = appearance.imagePath(params.file);
    const data = fs.readFileSync(file.path);
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }, { isPublic: true });
  // Everyone: their own colors, background picture and light/dark choice.
  route('PUT', '/api/appearance/mine', ({ body, actor }) => appearance.save(signedInName(actor), body), { roles: ANY_LOGIN });
  route('POST', '/api/appearance/mine/reset', ({ actor }) => appearance.reset(signedInName(actor)), { roles: ANY_LOGIN });
  route('POST', '/api/appearance/mine/background', ({ raw, actor }) => appearance.setImage(signedInName(actor), 'background', raw),
    { roles: ANY_LOGIN, rawBody: true, bodyLimit: 8_000_000 });
  route('DELETE', '/api/appearance/mine/background', ({ actor }) => appearance.removeImage(signedInName(actor), 'background'), { roles: ANY_LOGIN });
  route('POST', '/api/appearance/preview', ({ body, actor }) => {
    if (body.scope === 'company' && actor.role !== 'admin') throw new HttpError(403, 'Only admins change the company look.');
    return appearance.preview(actor.user, body.scope === 'company' ? 'company' : 'mine', body.values || {});
  }, { roles: ANY_LOGIN });
  // Admins: the company look everyone starts from, and the logos.
  route('PUT', '/api/appearance', ({ body, actor }) => {
    appearance.save(null, body);
    return appearance.view(actor.user);
  }, { roles: ADMIN });
  route('POST', '/api/appearance/reset', ({ actor }) => {
    appearance.reset(null);
    return appearance.view(actor.user);
  }, { roles: ADMIN });
  route('POST', '/api/appearance/:kind', ({ params, raw, actor }) => {
    appearance.setImage(null, params.kind, raw);
    return appearance.view(actor.user);
  }, { roles: ADMIN, rawBody: true, bodyLimit: 8_000_000 });
  route('DELETE', '/api/appearance/:kind', ({ params, actor }) => {
    appearance.removeImage(null, params.kind);
    return appearance.view(actor.user);
  }, { roles: ADMIN });

  // ---- Quote follow-ups and win-back campaigns ----
  route('GET', '/api/settings/followups', () => ({ ...campaigns.getFollowups(), publicUrl: Boolean(config.publicUrl) }));
  route('PUT', '/api/settings/followups', ({ body }) => campaigns.saveFollowups(body), { roles: ADMIN });
  route('GET', '/api/campaigns', () => campaigns.list(), { roles: ADMIN });
  route('POST', '/api/campaigns/check', ({ body }) => campaigns.check(body), { roles: ADMIN });
  route('POST', '/api/campaigns', ({ body, actor }) => campaigns.start(body, actor), { roles: ADMIN });
  route('POST', '/api/campaigns/:id/stop', ({ params, actor }) => campaigns.stop(Number(params.id), actor), { roles: ADMIN });

  // ---- Referral and partner links ----
  // A customer's own link to share; texting it to them is optional.
  route('POST', '/api/leads/:id/referral-link', async ({ req, params, body, actor }) => {
    const id = Number(params.id);
    const r = referrals.forCustomer(id, actor);
    const url = `${baseUrl(req)}/r/${r.code}`;
    if (body.send === 'text') {
      await messages.sendText(id, messages.render('Thanks again for choosing {{company}}, {{first_name}}! Know someone who would love their vehicle coated? Send them this link and we will take great care of them: {{referral_link}}',
        leads.getLead(id), { rep: actor.user, extra: { referral_link: url } }), { ...actor, trigger: 'referral' });
    }
    return { code: r.code, url, lead: leads.getLead(id) };
  });
  route('GET', '/api/referrals', ({ req }) => ({ ...referrals.report(), base: baseUrl(req) }), { roles: ADMIN });
  route('POST', '/api/partners', ({ body, actor }) => referrals.createPartner(body, actor), { roles: ADMIN });
  route('PATCH', '/api/partners/:id', ({ params, body }) => referrals.updatePartner(Number(params.id), body), { roles: ADMIN });
  route('POST', '/api/leads/:id/referral-reward', ({ params, body, actor }) => referrals.markRewarded(Number(params.id), body, actor), { roles: ADMIN });
  // The public form behind every referral link.
  route('GET', '/api/public/referral/:code', ({ params }) => ({ ...referrals.publicView(params.code), vehicleTypes: VEHICLE_TYPES }), { isPublic: true });
  route('POST', '/api/public/referral/:code', ({ params, body }) => (isSpam(body) ? { ok: true } : referrals.submit(params.code, body)), { isPublic: true });

  // ---- Calls to the Twilio number (missed-call text-back) ----
  // Twilio's "A call comes in" webhook: ring the shop; if nobody answers, text the caller.
  const twiml = (res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
  };
  const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sorry = () => `<Say>Thanks for calling ${xmlEscape(config.brand.name)}. Sorry we missed you. We just sent you a text, and we will get back to you shortly.</Say>`;
  route('POST', '/webhooks/twilio/voice', async ({ req, res, body }) => {
    if (!texter.verify(`${baseUrl(req)}${req.url}`, body, req.headers['x-twilio-signature'])) throw new HttpError(401, 'Bad signature');
    const forward = toE164(config.sms.forwardCallsTo);
    if (!forward) {
      await messages.missedCall({ from: body.From });
      return twiml(res, sorry());
    }
    // The shop sees the customer's number; the result comes back to /status.
    return twiml(res, `<Dial timeout="20" action="/webhooks/twilio/voice/status" method="POST" callerId="${xmlEscape(body.From || '')}">${xmlEscape(forward)}</Dial>`);
  }, { isPublic: true });
  route('POST', '/webhooks/twilio/voice/status', async ({ req, res, body }) => {
    if (!texter.verify(`${baseUrl(req)}${req.url}`, body, req.headers['x-twilio-signature'])) throw new HttpError(401, 'Bad signature');
    if (body.DialCallStatus === 'completed') {
      messages.answeredCall({ from: body.From });
      return twiml(res, '<Hangup/>');
    }
    await messages.missedCall({ from: body.From });
    return twiml(res, sorry());
  }, { isPublic: true });

  // ---- The dialer (build with CALLS_ENABLED) ----
  if (calls) {
    route('GET', '/api/calls/me', ({ actor }) => ({ call_phone: calls.repPhone(actor.user), active: calls.active(actor.user) }));
    route('PUT', '/api/calls/me', ({ body, actor }) => calls.setRepPhone(actor.user, body.call_phone));
    route('GET', '/api/calls/queue', () => calls.queue());
    route('GET', '/api/calls', ({ query }) => calls.list({ rep: query.get('rep'), flagged: query.get('flagged'), reviewed: query.get('reviewed'), from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
    route('GET', '/api/calls/:id', ({ params }) => calls.get(Number(params.id)));
    route('PATCH', '/api/calls/:id/review', ({ params, body, actor }) => calls.review(Number(params.id), body, actor), { roles: ADMIN });
    route('GET', '/api/leads/:id/calls', ({ params }) => calls.forLead(Number(params.id)));
    route('POST', '/api/leads/:id/calls', ({ params, actor }) => calls.start(Number(params.id), actor));
    // Twilio's side of a call. Each is signed by Twilio.
    const signed = (req, body) => {
      if (!texter.verify(`${baseUrl(req)}${req.url}`, body, req.headers['x-twilio-signature'])) throw new HttpError(401, 'Bad signature');
    };
    const callTwiml = (res, body) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
    };
    route('POST', '/webhooks/twilio/calls/:id/answer', ({ req, res, body, params }) => { signed(req, body); callTwiml(res, calls.answerTwiml(Number(params.id))); }, { isPublic: true });
    route('POST', '/webhooks/twilio/calls/:id/notice', ({ req, res, body, params }) => { signed(req, body); callTwiml(res, calls.noticeTwiml(Number(params.id))); }, { isPublic: true });
    route('POST', '/webhooks/twilio/calls/:id/dialed', ({ req, res, body, params }) => { signed(req, body); callTwiml(res, calls.dialed(Number(params.id), body)); }, { isPublic: true });
    route('POST', '/webhooks/twilio/calls/:id/transcript', ({ req, body, params }) => { signed(req, body); calls.transcript(Number(params.id), body); return { ok: true }; }, { isPublic: true });
    route('POST', '/webhooks/twilio/calls/:id/status', ({ req, body, params }) => { signed(req, body); calls.ended(Number(params.id), body); return { ok: true }; }, { isPublic: true });
  }

  // ---- Pipelines (admins set them up) ----
  route('GET', '/api/pipelines', () => ({
    pipelines: pipelines.list(),
    vehicle_types: VEHICLE_TYPES,
    people: users.list().filter((u) => u.active !== false && u.role !== 'shop').map((u) => ({ name: u.name, role: u.role })),
  }), { roles: ADMIN });
  route('PUT', '/api/pipelines', ({ body, actor }) => pipelines.save(body.pipelines, actor), { roles: ADMIN });

  // ---- Time clock, time off and pay ----
  // Everyone clocks in and out and asks for time off; admins approve it, set hourly rates and see the
  // hours and pay for a period on the Time & Pay page.
  // Each answer says whether this login has to be at the shop to clock in (the geo-lock).
  const clockView = (actor, s) => ({ ...s, ...timeClock.geofenceStatus(actor.role) });
  route('GET', '/api/clock', ({ actor }) => clockView(actor, timeClock.status(actor.user)), { roles: ANY_LOGIN });
  route('POST', '/api/clock/in', ({ actor, body }) => clockView(actor, timeClock.clockIn(actor.user, { role: actor.role, location: body?.location })), { roles: ANY_LOGIN });
  route('POST', '/api/clock/out', ({ actor, body }) => clockView(actor, timeClock.clockOut(actor.user, { approveWeek: Boolean(body?.approve_week) })), { roles: ANY_LOGIN });
  route('POST', '/api/timecard/approve-week', ({ actor }) => clockView(actor, timeClock.approveWeek(actor.user)), { roles: ANY_LOGIN });
  route('POST', '/api/clock/lunch', ({ actor }) => clockView(actor, timeClock.startLunch(actor.user)), { roles: ANY_LOGIN });
  route('GET', '/api/timecard', ({ query, actor }) => timeClock.timecard(actor.user, { from: query.get('from'), to: query.get('to') }), { roles: ANY_LOGIN });
  route('POST', '/api/timecard/corrections', ({ body, actor }) => timeClock.requestCorrection(actor.user, body), { roles: ANY_LOGIN });
  route('DELETE', '/api/timecard/corrections/:id', ({ params, actor }) => timeClock.cancelCorrection(Number(params.id), actor), { roles: ANY_LOGIN });
  route('GET', '/api/timecard/corrections', ({ query }) => timeClock.listCorrections({ status: query.get('status') }), { roles: ADMIN });
  route('PATCH', '/api/timecard/corrections/:id', ({ params, body, actor }) => timeClock.decideCorrection(Number(params.id), body, actor), { roles: ADMIN });
  route('POST', '/api/time-off', ({ body, actor }) => timeClock.requestOff(actor.user, body), { roles: ANY_LOGIN });
  route('DELETE', '/api/time-off/:id', ({ params, actor }) => timeClock.cancelOff(Number(params.id), actor), { roles: ANY_LOGIN });
  route('GET', '/api/time-off/calendar', ({ query, actor }) => timeClock.calendarOff({ from: query.get('from'), to: query.get('to'), full: actor.role === 'admin' }), { roles: ANY_LOGIN });
  route('GET', '/api/time-off', ({ query }) => timeClock.listOff({ status: query.get('status') }), { roles: ADMIN });
  route('PATCH', '/api/time-off/:id', ({ params, body, actor }) => timeClock.decideOff(Number(params.id), body, actor), { roles: ADMIN });
  route('GET', '/api/payroll', ({ query }) => timeClock.payroll({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  route('POST', '/api/payroll/weeks/:start/approve', ({ params, actor }) => timeClock.approvePayrollWeek(params.start, actor), { roles: ADMIN });
  route('POST', '/api/payroll/weeks/:start/email', ({ params }) => timeClock.emailWeek(params.start), { roles: ADMIN });
  // The red bar for admins: clock-ins away from the shop nobody has marked seen yet.
  route('GET', '/api/clock/alerts', () => timeClock.listAlerts(), { roles: ADMIN });
  route('POST', '/api/clock/alerts/seen', ({ body, actor }) => timeClock.markAlertsSeen(body?.ids === 'all' ? 'all' : (body?.ids || []), actor), { roles: ADMIN });
  route('GET', '/api/schedules', () => timeClock.listSchedules(), { roles: ADMIN });
  route('PUT', '/api/schedules', ({ body, actor }) => timeClock.saveSchedules(body.schedules, actor), { roles: ADMIN });
  route('PUT', '/api/payroll/settings', ({ body }) => timeClock.saveSettings(body), { roles: ADMIN });
  route('PUT', '/api/pay-rates', ({ body, actor }) => timeClock.setRate(body.user_name, body.rate, actor), { roles: ADMIN });
  route('POST', '/api/time/punches', ({ body, actor }) => timeClock.addPunch(body, actor), { roles: ADMIN });
  route('PATCH', '/api/time/punches/:id', ({ params, body, actor }) => timeClock.editPunch(Number(params.id), body, actor), { roles: ADMIN });
  route('DELETE', '/api/time/punches/:id', ({ params }) => timeClock.removePunch(Number(params.id)), { roles: ADMIN });

  // ---- Analytics (admin): every number the app tracks, for a date range ----
  route('GET', '/api/analytics', ({ query }) => {
    const report = analytics.report({ from: query.get('from'), to: query.get('to'), pipeline: query.get('pipeline') });
    return calls ? { ...report, calls: calls.stats({ start: report.range.from, end: report.range.to }) } : report;
  }, { roles: ADMIN });

  // ---- Lead source report (admin) ----
  route('GET', '/api/reports/sources', ({ query }) => leads.sourceReport({ from: query.get('from'), to: query.get('to') }), { roles: ADMIN });
  // Monthly ad spend by source, for cost per lead and per booking on that report.
  route('GET', '/api/ad-spend', ({ query }) => ({ sources: PAID_SOURCES, rows: adSpend.list({ from: query.get('from'), to: query.get('to') }) }), { roles: ADMIN });
  route('PUT', '/api/ad-spend', ({ body, actor }) => adSpend.save(body, actor), { roles: ADMIN });
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

  // Google Local Services leads: pulled every 5 minutes, or now from the Sync Google button.
  route('POST', '/api/google/sync', () => googleLsa.sync(), { roles: ADMIN });
  route('GET', '/api/google/status', () => ({ configured: googleLsa.configured, ...googleLsa.status() }), { roles: ADMIN });

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
  workTime.stopForgotten();
  const sweep = setInterval(() => { leads.archiveOldLeads(); workTime.stopForgotten(); timeClock.closeForgotten(); }, 3600000);
  sweep.unref();
  // Review-request emails go out every 15 minutes once they're due.
  const sendReviews = () => reviews.sendDue().catch((err) => console.error('Review requests failed:', err.message));
  sendReviews();
  const reviewTimer = setInterval(sendReviews, 15 * 60000);
  reviewTimer.unref();
  // New-lead alerts and the "nobody called yet" alert to admins, and the next win-back messages, every minute.
  const sendCampaigns = () => campaigns.sendNext().catch((err) => console.error('Campaign sending failed:', err.message));
  const sendWelcomes = () => messages.sendWelcomes().catch((err) => console.error('Welcome texts failed:', err.message));
  const alertTimer = setInterval(() => {
    runAlerts(); sendCampaigns(); sendWelcomes();
    timeClock.sendWeeklyDue().catch((err) => console.error('Weekly payroll email failed:', err.message));
  }, 60000);
  alertTimer.unref();
  // Day-before reminders to customers and the shop's morning day sheet, checked every 5 minutes.
  const sendReminders = () => {
    messages.sendDueReminders().catch((err) => console.error('Customer reminders failed:', err.message));
    daySheets.sendDue().catch((err) => console.error('Day sheet email failed:', err.message));
    campaigns.sendQuoteFollowups().catch((err) => console.error('Quote follow-ups failed:', err.message));
    if (googleLsa.configured) googleLsa.sync().catch((err) => console.error('Google Local Services sync failed:', err.message));
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
          if (/^\/r\/[a-z0-9]+\/?$/i.test(url.pathname)) return serveStatic(req, res, '/refer.html');
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
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message, ...(err.code && status < 500 && { code: err.code }) }, cors);
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
