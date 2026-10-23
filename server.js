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

// Returns the signed-in user ({ name }), or null if the login is wrong.
// With no logins configured, everyone is let in without a name.
function authenticate(req) {
  if (!config.users.length) return { name: null };
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const name = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  // Compare against every user so timing doesn't reveal which names exist.
  let found = null;
  for (const u of config.users) {
    const nameOk = safeEqual(name.toLowerCase(), u.name.toLowerCase());
    const passwordOk = safeEqual(password, u.password);
    if (nameOk && passwordOk) found = u;
  }
  return found && { name: found.name };
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

function createApp({ db = openDatabase(config.dbPath), fetchImpl } = {}) {
  const leads = createLeadService(db, { reminderHour: config.reminderHour, skipWeekends: config.reminderSkipWeekends, brand: config.brand });
  const fb = facebook.createFacebookClient(config.facebook, fetchImpl);
  const mailer = createMailer(config.email, fetchImpl);
  const routes = [];

  // `pattern` supports ":param" segments; public routes skip dashboard login.
  function route(method, pattern, handler, { isPublic = false } = {}) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    const re = new RegExp(`^${source}/?$`);
    routes.push({ method, re, keys, handler, isPublic });
  }

  async function ingestFacebookLead(leadgenId) {
    const fbLead = await fb.fetchLead(leadgenId);
    return leads.ingest(facebook.mapFacebookLead(fbLead));
  }

  // ---- Dashboard API ----
  route('GET', '/api/meta', ({ actor }) => ({
    currentUser: actor.user,
    brand: config.brand,
    stages: STAGES,
    dispositions: DISPOSITIONS,
    reminderHour: config.reminderHour,
    reminderSkipWeekends: config.reminderSkipWeekends,
    facebookConfigured: Boolean(config.facebook.pageAccessToken),
    facebookFormIds: config.facebook.formIds,
    emailConfigured: mailer.configured,
    emailPlaceholders: PLACEHOLDERS,
    vehicleFields: VEHICLE_FIELDS,
    vehicleTypes: VEHICLE_TYPES,
    pipelines: PIPELINES,
    bookingServices: BOOKING_SERVICES,
    heardAboutOptions: HEARD_ABOUT_OPTIONS,
  }));
  route('GET', '/api/leads', ({ query }) => leads.listLeads({ q: query.get('q'), source: query.get('source'), pipeline: query.get('pipeline') }));
  route('POST', '/api/leads', ({ body, actor }) => leads.ingest({ ...body, source: 'manual' }, actor));
  route('GET', '/api/leads/:id', ({ params }) => leads.getLead(Number(params.id)));
  route('PATCH', '/api/leads/:id', ({ params, body, actor }) => leads.updateLead(Number(params.id), body, actor));
  route('POST', '/api/leads/:id/disposition', async ({ params, body, actor }) => {
    const id = Number(params.id);
    const result = leads.dispositionLead(id, body, actor);
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
  route('PUT', '/api/settings/email', ({ body }) => leads.saveEmailSettings(body));
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
  });

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

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) {
        if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          const openAsset = url.pathname.startsWith('/icons/') || url.pathname.startsWith('/brand/');
          if (!openAsset && !authenticate(req)) return send(res, 401, 'Login required', { 'WWW-Authenticate': 'Basic realm="Lead Pipeline"' });
          return serveStatic(req, res, url.pathname);
        }
        return send(res, 404, { error: 'Not found' });
      }
      const user = match.isPublic ? null : authenticate(req);
      if (!match.isPublic && !user) {
        return send(res, 401, { error: 'Login required' }, { 'WWW-Authenticate': 'Basic realm="Lead Pipeline"' });
      }
      const actor = { user: user?.name ?? null };
      const values = url.pathname.match(match.re).slice(1);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
      const body = parseBody(raw, req.headers['content-type']);
      const result = await match.handler({ req, res, params, query: url.searchParams, body, raw, actor });
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
  if (!config.users.length) console.warn('Warning: no APP_USERS or APP_PASSWORD set, so the dashboard has no login.');
  if (!config.facebook.appSecret) console.warn('Warning: FB_APP_SECRET is not set, so Facebook webhook signatures are not checked.');
  http.createServer(createApp()).listen(config.port, () => {
    console.log(`Lead Pipeline running at http://localhost:${config.port}`);
  });
}

module.exports = { createApp };
