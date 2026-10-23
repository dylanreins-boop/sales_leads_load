const crypto = require('node:crypto');
const { extractVehicle } = require('./vehicle');
const { extractAnswers } = require('./answers');

// Meta signs webhook payloads with the app secret (X-Hub-Signature-256).
function verifySignature(rawBody, header, appSecret) {
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
  const actual = Buffer.from(String(header || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Pulls { leadgen_id, form_id, page_id, ... } out of a Page webhook payload.
function extractLeadgenEvents(payload) {
  const events = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'leadgen' && change.value?.leadgen_id) events.push(change.value);
    }
  }
  return events;
}

const KNOWN_FIELDS = new Set(['full_name', 'first_name', 'last_name', 'email', 'phone_number', 'phone']);

// Converts a Graph API lead into the shape the lead service ingests.
function mapFacebookLead(fbLead) {
  const fields = {};
  for (const f of fbLead.field_data || []) fields[f.name] = (f.values || []).join(', ');
  // Custom form questions are kept as readable "question: answer" lines.
  const extras = Object.entries(fields)
    .filter(([name]) => !KNOWN_FIELDS.has(name))
    .map(([name, value]) => `${name.replace(/_/g, ' ')}: ${value}`);
  return {
    source: 'facebook',
    external_id: String(fbLead.id),
    first_name: fields.first_name,
    last_name: fields.last_name,
    full_name: fields.full_name,
    email: fields.email,
    phone: fields.phone_number || fields.phone,
    message: extras.join('\n'),
    campaign: fbLead.campaign_name || fbLead.ad_name || null,
    form_name: fbLead.form_id ? `Facebook form ${fbLead.form_id}` : 'Facebook Lead Ad',
    received_at: fbLead.created_time,
    ...extractVehicle(fields),
    // Facebook leads came from an ad unless the form says otherwise.
    heard_about: 'Saw an ad on social media',
    ...extractAnswers(fields),
    raw: fbLead,
  };
}

function createFacebookClient({ pageAccessToken, graphVersion }, fetchImpl = (...a) => fetch(...a)) {
  const base = `https://graph.facebook.com/${graphVersion}`;
  const LEAD_FIELDS = 'id,created_time,field_data,form_id,ad_id,ad_name,campaign_name';

  async function graphGet(url) {
    if (!pageAccessToken) throw new Error('FB_PAGE_ACCESS_TOKEN is not configured');
    const u = new URL(url);
    if (!u.searchParams.has('access_token')) u.searchParams.set('access_token', pageAccessToken);
    const res = await fetchImpl(u.toString());
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(`Facebook Graph API error: ${body.error?.message || res.status}`);
    }
    return body;
  }

  return {
    fetchLead: (leadgenId) => graphGet(`${base}/${encodeURIComponent(leadgenId)}?fields=${LEAD_FIELDS}`),

    // Pulls recent leads for a form (used by "Sync Facebook" as a backstop
    // in case a webhook delivery was missed).
    async fetchFormLeads(formId, maxPages = 5) {
      const leads = [];
      let url = `${base}/${encodeURIComponent(formId)}/leads?fields=${LEAD_FIELDS}&limit=100`;
      for (let page = 0; url && page < maxPages; page++) {
        const body = await graphGet(url);
        leads.push(...(body.data || []));
        url = body.paging?.next || null;
      }
      return leads;
    },
  };
}

module.exports = { verifySignature, extractLeadgenEvents, mapFacebookLead, createFacebookClient };
