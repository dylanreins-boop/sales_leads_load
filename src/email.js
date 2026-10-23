// Sends email through an HTTP email service (no SMTP library needed).
// Supported: Resend, SendGrid, Postmark. Set EMAIL_PROVIDER, EMAIL_API_KEY
// and EMAIL_FROM in .env.

const PLACEHOLDERS = ['first_name', 'last_name', 'full_name', 'vehicle', 'email', 'phone'];

// "2023 Tesla Model Y", or the vehicle type, or just "vehicle".
function vehicleText(lead) {
  const named = [lead.vehicle_year, lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ');
  return named || (lead.vehicle_type ? lead.vehicle_type.toLowerCase() : 'vehicle');
}

// Fills {{first_name}}-style placeholders from the lead. Unknown ones are left as-is.
function renderTemplate(template, lead) {
  const first = lead.first_name || (lead.full_name || '').split(' ')[0] || 'there';
  const values = { ...lead, first_name: first, full_name: lead.full_name || first, vehicle: vehicleText(lead) };
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    PLACEHOLDERS.includes(key) ? (values[key] ?? '') : match);
}

function createMailer({ provider, apiKey, from, replyTo }, fetchImpl = (...a) => fetch(...a)) {
  const configured = Boolean(provider && apiKey && from);

  const requests = {
    resend: ({ to, subject, text }) => ['https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { from, to: [to], subject, text, ...(replyTo && { reply_to: replyTo }) },
    }],
    sendgrid: ({ to, subject, text }) => ['https://api.sendgrid.com/v3/mail/send', {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        ...(replyTo && { reply_to: { email: replyTo } }),
        subject,
        content: [{ type: 'text/plain', value: text }],
      },
    }],
    postmark: ({ to, subject, text }) => ['https://api.postmarkapp.com/email', {
      headers: { 'X-Postmark-Server-Token': apiKey, Accept: 'application/json' },
      body: { From: from, To: to, Subject: subject, TextBody: text, ...(replyTo && { ReplyTo: replyTo }) },
    }],
  };

  return {
    configured,
    async send(message) {
      const build = requests[provider];
      if (!configured || !build) throw new Error('Email sending is not set up (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM).');
      const [url, { headers, body }] = build(message);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Email service returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
    },
  };
}

module.exports = { renderTemplate, createMailer, PLACEHOLDERS };
