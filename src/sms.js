// Sends and receives text messages through Twilio's REST API (no SDK needed).
// Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) in .env.
const crypto = require('node:crypto');

// "(702) 555-0101" -> "+17025550101". US numbers without a country code get +1.
function toE164(phone) {
  const raw = String(phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// Twilio signs each webhook: HMAC-SHA1 of the full URL plus the POST fields sorted by name.
function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function createTexter({ accountSid, authToken, from, messagingServiceSid }, fetchImpl = (...a) => fetch(...a)) {
  const configured = Boolean(accountSid && authToken && (from || messagingServiceSid));
  return {
    configured,
    async send({ to, body }) {
      if (!configured) throw new Error('Texting is not set up (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).');
      const number = toE164(to);
      if (!number) throw new Error(`${to} doesn't look like a phone number.`);
      const form = new URLSearchParams({ To: number, Body: body });
      if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
      else form.set('From', from);
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Texting service returned ${res.status}${data.message ? `: ${data.message}` : ''}`);
      return { id: data.sid || null };
    },
    // True when a webhook really came from Twilio (or when there's no auth token to check against).
    verify(url, params, signature) {
      if (!authToken) return true;
      const expected = twilioSignature(authToken, url, params);
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature || ''));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { createTexter, toE164, twilioSignature };
