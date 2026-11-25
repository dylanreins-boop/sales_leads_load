// "Connect Facebook": an admin logs in with Facebook once and the app does the rest. It keeps the Page's
// key, finds the Page's Instagram account and lead forms, subscribes the Page to lead ads and points
// Meta's webhook at the app. Facebook lead ads, Sync Facebook and Facebook/Instagram posting all read
// their keys from here, falling back to the FB_* settings on the server when nobody has connected.
//
// One-time setup in Meta (an admin does it once): a Business app with Facebook Login for Business, this
// app's callback address as a valid redirect, and its App ID and App Secret saved under Social > Settings.
// Keys are stored encrypted (AES-256-GCM) with APP_ENCRYPTION_KEY, or SETUP_CODE when that isn't set.
const crypto = require('node:crypto');
const { HttpError } = require('./leads');

// What the login asks for: lead ads, posting to the Page and to Instagram.
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_manage_ads', 'leads_retrieval',
  'pages_manage_posts', 'instagram_basic', 'instagram_content_publish', 'business_management'];
const KEY = 'meta_connection';
const STATE_MS = 15 * 60000;

function createMetaConnect(db, { env = {}, publicUrl = '', graphVersion = 'v23.0', secret = '', fetchImpl = (...a) => fetch(...a) } = {}) {
  const stmt = (sql) => db.prepare(sql);
  const graph = `https://graph.facebook.com/${graphVersion}`;
  const now = () => new Date().toISOString();
  const redirectUri = () => (publicUrl ? `${publicUrl.replace(/\/$/, '')}/auth/facebook/callback` : '');

  // ---- stored settings, with the secrets encrypted ----
  const key = crypto.createHash('sha256').update(`meta-connect:${secret || 'local-dev'}`).digest();
  function seal(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${body.toString('base64')}`;
  }
  function open(sealed) {
    if (!sealed) return '';
    try {
      const [, iv, tag, body] = String(sealed).split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    } catch { return ''; } // the key changed: the admin connects again
  }
  function load() {
    try { return JSON.parse(stmt('SELECT value FROM settings WHERE key = ?').get(KEY)?.value || '{}'); } catch { return {}; }
  }
  const save = (s) => stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(s));

  // ---- what the rest of the app reads (the connection first, then the server's FB_* settings) ----
  const s = () => load();
  const keys = {
    appId: () => s().app_id || env.FB_APP_ID || '',
    appSecret: () => open(s().app_secret) || env.FB_APP_SECRET || '',
    pageToken: () => open(s().page_token) || env.FB_PAGE_ACCESS_TOKEN || '',
    pageId: () => s().page_id || env.FB_PAGE_ID || '',
    instagramId: () => (s().page_id ? s().ig_user_id || '' : env.IG_USER_ID || ''),
    formIds: () => (s().page_id ? s().form_ids || [] : String(env.FB_FORM_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)),
    // Meta's webhook check: the server's FB_VERIFY_TOKEN, or one made when the app is saved.
    verifyToken: () => env.FB_VERIFY_TOKEN || s().verify_token || '',
  };

  // ---- talking to Meta ----
  async function call(method, url, params = {}) {
    const u = new URL(url);
    let res;
    if (method === 'GET' || method === 'DELETE') {
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      res = await fetchImpl(u.toString(), { method });
    } else {
      res = await fetchImpl(u.toString(), { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error?.message || `Facebook answered ${res.status}`);
    return body;
  }

  // ---- the admin saves the Meta app once ----
  function saveApp({ app_id: appId, app_secret: appSecret, config_id: configId } = {}, { user } = {}) {
    const id = String(appId ?? '').trim();
    if (!/^\d{6,25}$/.test(id)) throw new HttpError(400, 'The App ID is the number at the top of the Meta app\'s dashboard.');
    const cur = load();
    const secretIn = String(appSecret ?? '').trim();
    if (!secretIn && !cur.app_secret) throw new HttpError(400, 'Paste the App Secret (App settings > Basic > App secret > Show).');
    if (secretIn && !/^[a-f0-9]{32}$/i.test(secretIn)) throw new HttpError(400, 'The App Secret is 32 letters and numbers (App settings > Basic > App secret > Show).');
    const config = String(configId ?? '').trim();
    if (config && !/^\d{6,25}$/.test(config)) throw new HttpError(400, 'The configuration ID is a number (Facebook Login for Business > Configurations).');
    const changedApp = cur.app_id && cur.app_id !== id;
    const next = {
      ...(changedApp ? {} : cur),
      app_id: id,
      app_secret: secretIn ? seal(secretIn) : cur.app_secret,
      config_id: config || null,
      verify_token: cur.verify_token || `bmcc-${crypto.randomBytes(12).toString('hex')}`,
      app_saved_by: user ?? null,
      app_saved_at: now(),
    };
    save(next);
    return status();
  }

  // ---- step 1: the link to Facebook's login ----
  const pendingStates = new Map(); // state -> { user, at }
  const pendingPicks = new Map(); // pick token -> { user, at, pages, userName }
  const sweep = (m) => { for (const [k, v] of m) if (Date.now() - v.at > STATE_MS) m.delete(k); };
  function startUrl({ user } = {}) {
    if (!keys.appId() || !keys.appSecret()) throw new HttpError(400, 'Save the Meta app\'s App ID and App Secret first.');
    if (!redirectUri()) throw new HttpError(400, 'The app needs its web address (PUBLIC_URL) set on the server first.');
    sweep(pendingStates);
    const state = crypto.randomBytes(18).toString('base64url');
    pendingStates.set(state, { user, at: Date.now() });
    const u = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
    u.searchParams.set('client_id', keys.appId());
    u.searchParams.set('redirect_uri', redirectUri());
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    // Facebook Login for Business uses a saved configuration; a classic login names the permissions.
    if (load().config_id) u.searchParams.set('config_id', load().config_id);
    else u.searchParams.set('scope', SCOPES.join(','));
    return { url: u.toString() };
  }

  // ---- step 2: Facebook sends them back with a code ----
  async function finishLogin({ code, state, error, error_description: why } = {}, { user } = {}) {
    sweep(pendingStates);
    const st = pendingStates.get(state);
    if (!st) throw new HttpError(400, 'That login link expired. Tap Connect Facebook again.');
    pendingStates.delete(state);
    if (st.user && user && st.user !== user) throw new HttpError(403, 'Connect Facebook from your own login.');
    if (error || !code) throw new HttpError(400, why ? `Facebook said: ${why}` : 'The Facebook login was cancelled.');
    const short = await call('GET', `${graph}/oauth/access_token`, { client_id: keys.appId(), client_secret: keys.appSecret(), redirect_uri: redirectUri(), code });
    // A long-lived login; the Page keys made from it don't expire.
    const long = await call('GET', `${graph}/oauth/access_token`, { grant_type: 'fb_exchange_token', client_id: keys.appId(), client_secret: keys.appSecret(), fb_exchange_token: short.access_token });
    const me = await call('GET', `${graph}/me`, { fields: 'id,name', access_token: long.access_token });
    const pages = [];
    let next = `${graph}/me/accounts?fields=${encodeURIComponent('id,name,access_token,tasks,instagram_business_account{id,username}')}&limit=100&access_token=${encodeURIComponent(long.access_token)}`;
    for (let i = 0; next && i < 5; i++) {
      const page = await call('GET', next);
      pages.push(...(page.data || []));
      next = page.paging?.next || null;
    }
    if (!pages.length) throw new HttpError(400, 'That Facebook login doesn\'t manage any Pages. Log in as an admin of the shop\'s Page, and tick the Page when Facebook asks which ones to allow.');
    if (pages.length === 1) return { connected: await connectPage(pages[0], { user, userName: me.name }) };
    sweep(pendingPicks);
    const pick = crypto.randomBytes(18).toString('base64url');
    pendingPicks.set(pick, { user, at: Date.now(), pages, userName: me.name });
    return { pick, pages: pages.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram_business_account?.username || null })) };
  }

  // ---- step 3 (with more than one Page): which one is the shop's ----
  async function choosePage({ pick, page_id: pageId } = {}, { user } = {}) {
    sweep(pendingPicks);
    const p = pendingPicks.get(pick);
    if (!p) throw new HttpError(400, 'That choice expired. Tap Connect Facebook again.');
    const page = p.pages.find((x) => x.id === String(pageId));
    if (!page) throw new HttpError(400, 'Pick one of the Pages listed.');
    pendingPicks.delete(pick);
    return connectPage(page, { user, userName: p.userName });
  }
  const pickList = (pick) => {
    const p = pendingPicks.get(pick);
    return p ? p.pages.map((x) => ({ id: x.id, name: x.name, instagram: x.instagram_business_account?.username || null })) : null;
  };

  // Saves the Page and sets up lead ads. Each step's outcome is kept to show the admin.
  async function connectPage(page, { user, userName }) {
    const steps = [];
    const step = async (name, fn) => {
      try { const r = await fn(); steps.push({ name, ok: true }); return r; } catch (err) { steps.push({ name, ok: false, error: err.message }); return null; }
    };
    const cur = load();
    const next = {
      ...cur,
      page_id: String(page.id), page_name: page.name, page_token: seal(page.access_token),
      ig_user_id: page.instagram_business_account?.id || null, ig_username: page.instagram_business_account?.username || null,
      fb_user: userName || null, connected_by: user ?? null, connected_at: now(), form_ids: [],
    };
    save(next);
    await step('Page subscribed to lead ads', () => call('POST', `${graph}/${page.id}/subscribed_apps`, { subscribed_fields: 'leadgen', access_token: page.access_token }));
    await step('Webhook pointed at this app', () => call('POST', `${graph}/${keys.appId()}/subscriptions`, {
      object: 'page', callback_url: `${publicUrl.replace(/\/$/, '')}/webhooks/facebook`, fields: 'leadgen', include_values: 'true',
      verify_token: keys.verifyToken(), access_token: `${keys.appId()}|${keys.appSecret()}`,
    }));
    const forms = await step('Lead forms found', async () => {
      const r = await call('GET', `${graph}/${page.id}/leadgen_forms`, { fields: 'id,name,status', limit: '100', access_token: page.access_token });
      return r.data || [];
    });
    save({ ...load(), form_ids: (forms || []).map((f) => String(f.id)), forms: (forms || []).map((f) => ({ id: String(f.id), name: f.name, status: f.status })), steps, checked_at: now() });
    return status();
  }

  // Looks again for new lead forms (Sync Facebook does this first).
  async function refreshForms() {
    const cur = load();
    if (!cur.page_id) return keys.formIds();
    const r = await call('GET', `${graph}/${cur.page_id}/leadgen_forms`, { fields: 'id,name,status', limit: '100', access_token: open(cur.page_token) });
    const forms = (r.data || []).map((f) => ({ id: String(f.id), name: f.name, status: f.status }));
    save({ ...load(), forms, form_ids: forms.map((f) => f.id) });
    return forms.map((f) => f.id);
  }

  async function disconnect() {
    const cur = load();
    if (cur.page_id && cur.page_token) {
      try { await call('DELETE', `${graph}/${cur.page_id}/subscribed_apps`, { access_token: open(cur.page_token) }); } catch { /* already gone */ }
    }
    // Keeps the Meta app (App ID, secret, verify token) so connecting again is one tap.
    const keep = { ...cur };
    for (const k of ['page_id', 'page_name', 'page_token', 'ig_user_id', 'ig_username', 'form_ids', 'forms', 'steps', 'fb_user', 'connected_by', 'connected_at', 'checked_at']) delete keep[k];
    save(keep);
    return status();
  }

  // What the admin sees (never a key).
  function status() {
    const cur = load();
    const fromServer = !cur.page_id && Boolean(env.FB_PAGE_ACCESS_TOKEN);
    return {
      app_saved: Boolean(keys.appId() && keys.appSecret()),
      app_id: keys.appId() || null,
      config_id: cur.config_id || null,
      redirect_uri: redirectUri(),
      webhook_url: publicUrl ? `${publicUrl.replace(/\/$/, '')}/webhooks/facebook` : '',
      verify_token: keys.verifyToken() || null,
      connected: Boolean(cur.page_id && cur.page_token) || fromServer,
      from_server: fromServer,
      page: cur.page_id ? { id: cur.page_id, name: cur.page_name } : (fromServer ? { id: env.FB_PAGE_ID || null, name: null } : null),
      instagram: cur.ig_user_id ? { id: cur.ig_user_id, username: cur.ig_username } : null,
      forms: cur.forms || [],
      steps: cur.steps || [],
      fb_user: cur.fb_user || null,
      connected_by: cur.connected_by || null,
      connected_at: cur.connected_at || null,
    };
  }

  return { keys, saveApp, startUrl, finishLogin, choosePage, pickList, refreshForms, disconnect, status, SCOPES };
}

module.exports = { createMetaConnect, SCOPES };
