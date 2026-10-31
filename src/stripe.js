// Card deposits through Stripe Checkout (Stripe's own hosted payment page), using its REST API.
// Set STRIPE_SECRET_KEY; STRIPE_WEBHOOK_SECRET is optional (payments are also checked when the
// customer comes back from the payment page).
const crypto = require('node:crypto');

// Stripe's form encoding: nested objects become key[sub][0][name]=value.
function formEncode(data, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

// Stripe-Signature: "t=1700000000,v1=hex..." signed over "t.rawBody" with the webhook secret.
function verifyStripeSignature(raw, header, secret, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createStripe({ secretKey, webhookSecret }, fetchImpl = (...a) => fetch(...a)) {
  const configured = Boolean(secretKey);
  async function call(method, path, data) {
    const res = await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: data ? formEncode(data).toString() : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Payment service returned ${res.status}${json.error?.message ? `: ${json.error.message}` : ''}`);
    return json;
  }
  return {
    configured,
    webhookConfigured: Boolean(webhookSecret),
    // A hosted payment page for one deposit; returns { id, url }.
    checkout: ({ cents, name, email, successUrl, cancelUrl, metadata }) => call('POST', '/checkout/sessions', {
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name } } }],
      customer_email: email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata,
      payment_intent_data: { metadata },
    }),
    getSession: (id) => call('GET', `/checkout/sessions/${encodeURIComponent(id)}`),
    verify: (raw, header) => Boolean(webhookSecret) && verifyStripeSignature(raw, header, webhookSecret),
  };
}

module.exports = { createStripe, formEncode, verifyStripeSignature };
