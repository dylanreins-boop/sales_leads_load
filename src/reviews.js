const { renderTemplate } = require('./email');
const { HttpError } = require('./leads');

// Review requests: a few days after a job is picked up, email the customer a link to leave a review.
// Off until an admin turns it on and adds the review link.
function defaultReviewSettings(brand = {}) {
  return {
    enabled: false,
    delay_days: 2,
    link: '',
    subject: `How does your {{vehicle}} look, {{first_name}}?`,
    body: [
      'Hi {{first_name}},',
      '',
      `Thanks for trusting ${brand.name || 'us'} with your {{vehicle}}. We hope you love how it turned out.`,
      '',
      'If you have a minute, a quick review helps other people find us:',
      '{{review_link}}',
      '',
      'Thank you!',
      brand.name || '',
    ].join('\n'),
  };
}

// Only jobs picked up recently get an email, so turning this on never emails old customers.
const MAX_AGE_DAYS = 30;

function createReviewService(db, { leads, mailer, brand }) {
  const stmt = (sql) => db.prepare(sql);
  const DEFAULTS = defaultReviewSettings(brand);
  const clean = (v) => (v == null ? '' : String(v).trim());

  function getSettings() {
    const row = stmt("SELECT value FROM settings WHERE key = 'review_email'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* keep defaults */ }
    return { ...DEFAULTS, ...saved };
  }

  function saveSettings(input = {}) {
    const next = { ...getSettings() };
    if ('enabled' in input) next.enabled = Boolean(input.enabled);
    if ('delay_days' in input) {
      const days = Number(input.delay_days);
      if (!Number.isInteger(days) || days < 0 || days > 30) throw new HttpError(400, 'Send it 0 to 30 days after pick-up.');
      next.delay_days = days;
    }
    for (const key of ['link', 'subject', 'body']) if (key in input) next[key] = clean(input[key]);
    if (next.link && !/^https?:\/\/\S+$/.test(next.link)) throw new HttpError(400, 'The review link has to start with https://');
    if (next.enabled && (!next.link || !next.subject || !next.body)) {
      throw new HttpError(400, 'Add the review link, a subject and a message before turning review requests on.');
    }
    stmt("INSERT INTO settings (key, value) VALUES ('review_email', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  function messageFor(lead, settings = getSettings()) {
    const fill = (text) => renderTemplate(String(text).replace(/\{\{\s*review_link\s*\}\}/g, settings.link), lead);
    return { to: lead.email, subject: fill(settings.subject), text: fill(settings.body) };
  }

  // Sends every review request that's due. Returns how many went out.
  async function sendDue(at = new Date()) {
    const settings = getSettings();
    if (!settings.enabled || !settings.link || !mailer.configured) return 0;
    const due = new Date(at.getTime() - settings.delay_days * 86400000).toISOString();
    const oldest = new Date(at.getTime() - (settings.delay_days + MAX_AGE_DAYS) * 86400000).toISOString();
    const jobs = stmt(`SELECT j.id, j.lead_id FROM jobs j
                       WHERE j.status = 'picked_up' AND j.review_sent_at IS NULL
                       AND j.picked_up_at <= ? AND j.picked_up_at >= ?
                       AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.lead_id = j.lead_id AND o.id != j.id AND o.review_sent_at IS NOT NULL
                                       AND o.review_sent_at != 'skipped' AND o.review_sent_at >= ?)`)
      .all(due, oldest, new Date(at.getTime() - 180 * 86400000).toISOString());
    let sent = 0;
    for (const job of jobs) {
      const lead = leads.getLead(job.lead_id);
      if (!lead.email) {
        stmt("UPDATE jobs SET review_sent_at = 'skipped' WHERE id = ?").run(job.id);
        continue;
      }
      // Mark first so a slow email service can't cause a second copy.
      stmt('UPDATE jobs SET review_sent_at = ? WHERE id = ?').run(at.toISOString(), job.id);
      const message = messageFor(lead, settings);
      try {
        await mailer.send(message);
        leads.recordEmail(lead.id, message, { status: 'sent', trigger: 'review', label: 'Review request' });
        sent++;
      } catch (err) {
        leads.recordEmail(lead.id, message, { status: 'failed', error: err.message, trigger: 'review', label: 'Review request' });
      }
    }
    return sent;
  }

  return { getSettings, saveSettings, sendDue, messageFor };
}

module.exports = { createReviewService, defaultReviewSettings };
