// Maps a website form submission (JSON or URL-encoded) into a lead.
// Accepts common field-name variants so most existing forms work as-is.
function mapWebsiteLead(body) {
  const pick = (...keys) => {
    for (const key of keys) {
      const v = body[key];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return null;
  };
  const first = pick('first_name', 'firstName', 'fname', 'first');
  const last = pick('last_name', 'lastName', 'lname', 'last');
  return {
    source: 'website',
    external_id: pick('submission_id', 'submissionId'),
    first_name: first,
    last_name: last,
    full_name: pick('full_name', 'fullName', 'name') || [first, last].filter(Boolean).join(' ') || null,
    email: pick('email', 'email_address', 'emailAddress'),
    phone: pick('phone', 'phone_number', 'phoneNumber', 'tel', 'mobile'),
    message: pick('message', 'comments', 'notes', 'details', 'inquiry'),
    campaign: pick('utm_campaign', 'campaign', 'utm_source'),
    form_name: pick('form_name', 'formName', 'page') || 'Website form',
    raw: body,
  };
}

// Hidden "_gotcha" field: humans leave it blank, spam bots fill it in.
const isSpam = (body) => Boolean(body._gotcha && String(body._gotcha).trim());

module.exports = { mapWebsiteLead, isSpam };
