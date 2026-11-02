// Google Local Services Ads leads. When the Google Ads API keys are set, the app asks Google every
// few minutes for new Local Services leads (calls, messages and bookings) and puts them on the
// board like Facebook leads, tagged "Google". Each Google lead is brought in once.
const { HttpError } = require('./leads');
const { prettyPhone } = require('./sms');

const TYPES = { PHONE_CALL: 'Called', MESSAGE: 'Sent a message', BOOKING: 'Booked a time' };
const LOOKBACK_DAYS = 30; // the first sync reaches back this far

function createGoogleLsaClient(config, { db, leads, fetchImpl = fetch }) {
  const configured = Boolean(config.developerToken && config.clientId && config.clientSecret && config.refreshToken && config.customerId);
  const stmt = (sql) => db.prepare(sql);
  let token = null; // { value, expires }

  const status = () => {
    try { return JSON.parse(stmt("SELECT value FROM settings WHERE key = 'google_lsa'").get()?.value || '{}'); } catch { return {}; }
  };
  const saveStatus = (s) => stmt("INSERT INTO settings (key, value) VALUES ('google_lsa', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ ...status(), ...s }));

  async function accessToken() {
    if (token && token.expires > Date.now() + 60000) return token.value;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken }).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`Google sign-in failed: ${json.error_description || json.error || res.status}`);
    token = { value: json.access_token, expires: Date.now() + (json.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function search(query) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'developer-token': config.developerToken, 'Content-Type': 'application/json' };
    if (config.loginCustomerId) headers['login-customer-id'] = config.loginCustomerId;
    const url = `https://googleads.googleapis.com/${config.apiVersion}/customers/${config.customerId}/googleAds:search`;
    const rows = [];
    let pageToken;
    do {
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ query, ...(pageToken && { pageToken }) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = json.error?.details?.[0]?.errors?.[0]?.message || json.error?.message || res.status;
        throw new Error(`Google Ads: ${detail}`);
      }
      rows.push(...(json.results || []));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return rows;
  }

  // "YYYY-MM-DD HH:MM:SS" the way Google wants it (the account's own time zone; a day of slack covers the difference).
  const gTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

  async function messageText(resourceName) {
    try {
      const rows = await search(`SELECT local_services_lead_conversation.message_details.text FROM local_services_lead_conversation
        WHERE local_services_lead_conversation.lead = '${resourceName}' AND local_services_lead_conversation.conversation_channel = 'MESSAGE'`);
      return rows.map((r) => r.localServicesLeadConversation?.messageDetails?.text).filter(Boolean).join('\n') || null;
    } catch { return null; } // the lead still comes in without the message
  }

  async function sync({ at = new Date() } = {}) {
    if (!configured) throw new HttpError(400, 'Add the Google Ads API keys (GOOGLE_ADS_*) to pull in Local Services leads.');
    const last = status().last_lead_at;
    const since = new Date(Math.min(last ? new Date(last).getTime() : Infinity, at.getTime()) - (last ? 86400000 : LOOKBACK_DAYS * 86400000));
    try {
      const rows = await search(`SELECT local_services_lead.id, local_services_lead.resource_name, local_services_lead.lead_type,
          local_services_lead.contact_details, local_services_lead.lead_status, local_services_lead.creation_date_time
        FROM local_services_lead WHERE local_services_lead.creation_date_time >= '${gTime(since)}'
        ORDER BY local_services_lead.creation_date_time`);
      let created = 0;
      let newest = last || null;
      for (const { localServicesLead: g } of rows) {
        if (!g?.id) continue;
        const when = g.creationDateTime ? new Date(`${g.creationDateTime.replace(' ', 'T')}`) : at;
        if (!Number.isNaN(when.getTime()) && (!newest || when.toISOString() > newest)) newest = when.toISOString();
        if (stmt('SELECT 1 FROM lsa_seen WHERE lsa_id = ?').get(String(g.id))) continue;
        const contact = g.contactDetails || {};
        if (g.leadStatus === 'WIPED_OUT' || (!contact.phoneNumber && !contact.email && !contact.consumerName)) {
          stmt('INSERT INTO lsa_seen (lsa_id, lead_id, seen_at) VALUES (?, NULL, ?)').run(String(g.id), at.toISOString());
          continue;
        }
        const text = g.leadType === 'MESSAGE' && g.resourceName ? await messageText(g.resourceName) : null;
        const result = leads.ingest({
          source: 'google',
          external_id: String(g.id),
          full_name: contact.consumerName,
          phone: prettyPhone(contact.phoneNumber),
          email: contact.email,
          message: [TYPES[g.leadType] || g.leadType, text].filter(Boolean).join(': '),
          campaign: 'Google Local Services',
          heard_about: 'Google',
        });
        stmt('INSERT INTO lsa_seen (lsa_id, lead_id, seen_at) VALUES (?, ?, ?)').run(String(g.id), result.lead.id, at.toISOString());
        if (result.created) created++;
      }
      saveStatus({ last_sync_at: at.toISOString(), last_error: null, last_lead_at: newest });
      return { fetched: rows.length, created };
    } catch (err) {
      saveStatus({ last_sync_at: at.toISOString(), last_error: err.message });
      throw err instanceof HttpError ? err : new HttpError(502, err.message);
    }
  }

  return { configured, sync, status };
}

module.exports = { createGoogleLsaClient };
