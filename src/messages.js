// Texts and automatic customer messages: saved text templates the reps send from a lead, replies
// coming back in, the booking confirmation, and the reminder the day before drop-off.
const { HttpError } = require('./leads');
const { renderTemplate } = require('./email');
const { toE164 } = require('./sms');
const { serviceLabels } = require('./services');

const DEFAULT_TEMPLATES = [
  { id: 'follow_up', label: 'Following up', body: 'Hi {{first_name}}, this is {{rep}} with {{company}}. Following up on ceramic coating for your {{vehicle}}. Is now a good time to chat?' },
  { id: 'quote', label: 'Your quote', body: 'Hi {{first_name}}, {{rep}} from {{company}}. Your quote for the {{vehicle}} comes to {{quote_total}}. Reply here with any questions or to pick a day.' },
  { id: 'missed', label: 'Missed your call', body: 'Hi {{first_name}}, sorry we missed you! This is {{rep}} with {{company}}. Text back here or call {{company_phone}} when it suits you.' },
  { id: 'late', label: 'Running late', body: 'Hi {{first_name}}, {{rep}} from {{company}} here. Running about 10 minutes late, sorry about that!' },
  { id: 'ready', label: 'Ready for pickup', body: 'Hi {{first_name}}, your {{vehicle}} is ready for pickup at {{company}}. See you soon!' },
];

const DEFAULT_NOTICES = {
  confirm_enabled: true,
  reminder_enabled: true,
  by_text: true,
  by_email: true,
  // Day-before reminders go out at this hour (shop time) the day before drop-off.
  reminder_hour: 10,
  confirm_text: "Hi {{first_name}}, you're booked at {{company}}! Drop-off: {{drop_off}}. Expected pick-up: {{pick_up}}. {{address}} Questions? Reply here or call {{company_phone}}.",
  confirm_subject: 'Your appointment at {{company}}: {{drop_off}}',
  confirm_email: "Hi {{first_name}},\n\nThanks for booking with {{company}}! Here are your details:\n\nVehicle: {{vehicle}}\nServices: {{services}}\nDrop-off: {{drop_off}}\nExpected pick-up: {{pick_up}}\n{{address}}\n\nIf anything changes, just reply to this email or call {{company_phone}}.\n\n{{company}}",
  reminder_text: 'Hi {{first_name}}, a reminder from {{company}}: we see your {{vehicle}} tomorrow, {{drop_off}}. {{address}} Need to change it? Reply here or call {{company_phone}}.',
  reminder_subject: 'See you tomorrow: {{drop_off}}',
  reminder_email: 'Hi {{first_name}},\n\nA quick reminder that your {{vehicle}} is booked with {{company}} tomorrow, {{drop_off}}.\n{{address}}\n\nNeed to change it? Reply to this email or call {{company_phone}}.\n\n{{company}}',
  // When the shop marks the job Ready for pickup.
  ready_enabled: true,
  ready_text: 'Hi {{first_name}}, your {{vehicle}} is ready for pickup at {{company}}! {{balance_due}} {{address}} See you soon.',
  ready_subject: 'Your {{vehicle}} is ready for pickup',
  ready_email: 'Hi {{first_name}},\n\nGood news: your {{vehicle}} is ready for pickup at {{company}}.\n\n{{balance_due}}\n{{address}}\n\nQuestions? Reply to this email or call {{company_phone}}.\n\n{{company}}',
  // Texted to anyone whose call to the Twilio number wasn't answered.
  missed_call_enabled: true,
  missed_call_text: 'Hi, this is {{company}}. Sorry we missed your call! Text us back here with your vehicle (year, make and model) and what you would like done, and we will get right back to you.',
};
const NOTICE_TEXT_FIELDS = ['confirm_text', 'confirm_subject', 'confirm_email', 'reminder_text', 'reminder_subject', 'reminder_email', 'ready_text', 'ready_subject', 'ready_email', 'missed_call_text'];
const NOTICE_FLAGS = ['confirm_enabled', 'reminder_enabled', 'ready_enabled', 'missed_call_enabled', 'by_text', 'by_email'];
// Each automatic message: the job column that marks it sent, and how it's logged.
const KINDS = {
  confirm: { sentColumn: 'confirm_sent_at', trigger: 'confirmation', email: 'Booking confirmation', name: 'Booking confirmation' },
  reminder: { sentColumn: 'reminder_sent_at', trigger: 'reminder', email: 'Reminder email', name: 'Day-before reminder' },
  ready: { sentColumn: 'ready_sent_at', trigger: 'ready', email: 'Ready-for-pickup email', name: 'Ready-for-pickup message' },
};

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'];
const START_WORDS = ['start', 'unstop', 'yes'];
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const now = () => new Date().toISOString();

function createMessageService(db, { leads, jobs, texter, mailer, brand = {}, onReply = () => {} }) {
  const stmt = (sql) => db.prepare(sql);

  function readSetting(key, fallback) {
    const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
    try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
  }
  const writeSetting = (key, value) => stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));

  // ---- saved texts ----
  const getTemplates = () => readSetting('text_templates', DEFAULT_TEMPLATES);
  function saveTemplates(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Send the list of saved texts.');
    const clean = list.map((t, i) => ({
      id: String(t.id || `t${Date.now()}${i}`).slice(0, 40),
      label: String(t.label ?? '').trim().slice(0, 40),
      body: String(t.body ?? '').trim().slice(0, 1000),
    })).filter((t) => t.label && t.body);
    if (clean.length > 30) throw new HttpError(400, 'Keep it to 30 saved texts or fewer.');
    writeSetting('text_templates', clean);
    return clean;
  }

  // ---- automatic customer messages ----
  const getNotices = () => ({ ...DEFAULT_NOTICES, ...readSetting('customer_notices', {}) });
  function saveNotices(input = {}) {
    const next = getNotices();
    for (const key of NOTICE_FLAGS) if (key in input) next[key] = Boolean(input[key]);
    if ('reminder_hour' in input) {
      const hour = Number(input.reminder_hour);
      if (!Number.isInteger(hour) || hour < 6 || hour > 20) throw new HttpError(400, 'Pick a reminder time between 6 AM and 8 PM.');
      next.reminder_hour = hour;
    }
    for (const key of NOTICE_TEXT_FIELDS) {
      if (!(key in input)) continue;
      const text = String(input[key] ?? '').trim();
      if (!text) throw new HttpError(400, 'Messages can\'t be blank. Turn the message off instead.');
      next[key] = text.slice(0, 3000);
    }
    writeSetting('customer_notices', next);
    return next;
  }

  // Values for {{placeholders}}: the company, the rep, the lead's latest quote and its upcoming job.
  function valuesFor(lead, { rep, job, extra = {} } = {}) {
    const quote = lead.quotes?.[0];
    const upcoming = job || lead.jobs?.find((j) => !['picked_up', 'cancelled'].includes(j.status));
    return {
      rep: rep || 'the team',
      company: brand.name || '',
      company_phone: brand.phone || '',
      address: brand.address ? `Address: ${brand.address}.` : '',
      quote_total: quote ? money(quote.total_cents) : '',
      drop_off: upcoming ? when(upcoming.start_at) : '',
      pick_up: upcoming ? when(upcoming.end_at) : '',
      services: upcoming ? serviceLabels(typeof upcoming.services === 'string' ? JSON.parse(upcoming.services || '[]') : upcoming.services || []) : '',
      booking_link: '',
      balance_due: '',
      ...extra,
    };
  }
  const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const render = (template, lead, options) => tidy(renderTemplate(template, lead, valuesFor(lead, options)));

  // ---- texts ----
  function recordText(leadId, fields) {
    const { lastInsertRowid } = stmt(`INSERT INTO texts (lead_id, direction, phone, body, status, error, trigger, provider_id, user_name, created_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leadId, fields.direction, fields.phone, fields.body, fields.status, fields.error ?? null,
      fields.trigger ?? null, fields.provider_id ?? null, fields.user ?? null, now(),
    );
    return stmt('SELECT * FROM texts WHERE id = ?').get(Number(lastInsertRowid));
  }

  const LABELS = { missed_call: 'Missed-call text', manual: 'Text', confirmation: 'Booking confirmation text', reminder: 'Reminder text', booking_link: 'Booking link text', ready: 'Ready-for-pickup text' };

  // Sends a text to a lead and logs it. Throws a 400 the rep can read when it can't go out.
  async function sendText(leadId, body, { user, trigger = 'manual' } = {}) {
    const lead = leads.getLead(leadId);
    const text = String(body ?? '').trim();
    if (!text) throw new HttpError(400, 'Type a message first.');
    if (text.length > 1000) throw new HttpError(400, 'That text is too long. Keep it under 1,000 characters.');
    if (!lead.phone || !toE164(lead.phone)) throw new HttpError(400, 'This lead has no mobile number to text.');
    if (lead.sms_opt_in === 0) throw new HttpError(400, 'This customer asked not to get texts.');
    if (!texter.configured) throw new HttpError(400, 'Texting isn\'t connected yet. An admin adds the Twilio keys to turn it on.');
    const label = LABELS[trigger] || 'Text';
    try {
      const { id } = await texter.send({ to: lead.phone, body: text });
      const row = recordText(leadId, { direction: 'out', phone: lead.phone, body: text, status: 'sent', trigger, provider_id: id, user });
      leads.logActivity(leadId, 'text', { note: `${label} sent: ${text}`, user });
      return row;
    } catch (err) {
      recordText(leadId, { direction: 'out', phone: lead.phone, body: text, status: 'failed', error: err.message, trigger, user });
      leads.logActivity(leadId, 'text', { note: `${label} not sent: ${err.message}`, user });
      throw new HttpError(502, `The text didn't go out: ${err.message}`);
    }
  }

  // A reply from a customer (Twilio webhook). Unknown numbers become new leads.
  function receiveText({ from, body, id }) {
    const text = String(body ?? '').trim();
    const digits = String(from ?? '').replace(/\D/g, '').slice(-10);
    if (!digits) return null;
    let lead = stmt("SELECT * FROM leads WHERE phone_norm = ? ORDER BY (stage = 'waste'), id DESC LIMIT 1").get(digits);
    let created = false;
    if (!lead) {
      lead = leads.ingest({ source: 'text', phone: from, message: text }).lead;
      created = true;
    }
    recordText(lead.id, { direction: 'in', phone: from, body: text, status: 'received', provider_id: id });
    leads.logActivity(lead.id, 'text', { note: `Text from customer: ${text}` });
    const word = text.toLowerCase().replace(/[^a-z]/g, '');
    if (STOP_WORDS.includes(word)) {
      stmt('UPDATE leads SET sms_opt_in = 0, updated_at = ? WHERE id = ?').run(now(), lead.id);
      leads.logActivity(lead.id, 'text', { note: 'Customer opted out of texts (replied STOP)' });
    } else if (START_WORDS.includes(word) && lead.sms_opt_in === 0) {
      stmt('UPDATE leads SET sms_opt_in = 1, updated_at = ? WHERE id = ?').run(now(), lead.id);
      leads.logActivity(lead.id, 'text', { note: 'Customer opted back in to texts' });
    } else if (!created) {
      stmt('UPDATE leads SET updated_at = ? WHERE id = ?').run(now(), lead.id);
    }
    const fresh = leads.getLead(lead.id);
    if (!created) onReply(fresh, text);
    return fresh;
  }

  // ---- missed calls (Twilio voice) ----
  // A call nobody answered: the caller becomes (or is matched to) a lead and gets a text right away,
  // at most once every 12 hours.
  async function missedCall({ from }) {
    if (!toE164(from)) return null;
    const { lead, created } = leads.ingest({ source: 'call', phone: from, message: 'Called and nobody answered' });
    if (!created) leads.logActivity(lead.id, 'call', { note: 'Missed call from the customer' });
    const settings = getNotices();
    const recent = stmt(`SELECT 1 FROM texts WHERE lead_id = ? AND trigger = 'missed_call' AND created_at > ?`)
      .get(lead.id, new Date(Date.now() - 12 * 3600000).toISOString());
    let texted = false;
    if (settings.missed_call_enabled && !recent && texter.configured && lead.sms_opt_in !== 0) {
      try {
        await sendText(lead.id, render(settings.missed_call_text, leads.getLead(lead.id)), { trigger: 'missed_call' });
        texted = true;
      } catch (err) { console.error('Missed-call text failed:', err.message); }
    }
    // A new lead already set off the new-lead alert; someone we know gets their rep pinged.
    if (!created) onReply(leads.getLead(lead.id), 'Called and nobody answered');
    return { lead: leads.getLead(lead.id), created, texted };
  }

  // An answered call from someone we know goes in their history.
  function answeredCall({ from }) {
    const digits = String(from ?? '').replace(/\D/g, '').slice(-10);
    const lead = digits && stmt("SELECT id FROM leads WHERE phone_norm = ? ORDER BY (stage = 'waste'), id DESC LIMIT 1").get(digits);
    if (lead) leads.logActivity(lead.id, 'call', { note: 'Called the shop (answered)' });
    return lead || null;
  }

  // ---- booking confirmation and the day-before reminder ----
  // Sends one of the automatic messages by text and/or email, whichever the lead has and is set up.
  async function notify(jobId, kind, { user, extra = {} } = {}) {
    const settings = getNotices();
    const job = jobs.getJob(jobId);
    const lead = leads.getLead(job.lead_id);
    const k = KINDS[kind];
    const sent = [];
    const problems = [];
    const canText = settings.by_text && texter.configured && lead.phone && toE164(lead.phone) && lead.sms_opt_in !== 0;
    if (canText) {
      try {
        await sendText(lead.id, render(settings[`${kind}_text`], lead, { job, rep: user, extra }), { user, trigger: k.trigger });
        sent.push('text');
      } catch (err) { problems.push(err.message); }
    }
    if (settings.by_email && lead.email && mailer.configured) {
      const message = { to: lead.email, subject: render(settings[`${kind}_subject`], lead, { job, rep: user, extra }), text: render(settings[`${kind}_email`], lead, { job, rep: user, extra }) };
      const label = k.email;
      try {
        await mailer.send(message);
        leads.recordEmail(lead.id, message, { status: 'sent', trigger: kind, user, label });
        sent.push('email');
      } catch (err) {
        leads.recordEmail(lead.id, message, { status: 'failed', error: err.message, trigger: kind, user, label });
        problems.push(err.message);
      }
    }
    stmt(`UPDATE jobs SET ${k.sentColumn} = ? WHERE id = ?`).run(now(), jobId);
    if (!sent.length && !problems.length) {
      const why = !texter.configured && !mailer.configured ? 'texting and email aren\'t connected yet'
        : !lead.phone && !lead.email ? 'no phone or email on file'
          : lead.sms_opt_in === 0 && !lead.email ? 'the customer opted out of texts and has no email on file'
            : !texter.configured ? 'no email on file (texting isn\'t connected yet)'
              : !mailer.configured ? 'no mobile number on file (email isn\'t connected yet)'
                : 'no way to reach the customer';
      leads.logActivity(lead.id, 'notice', { note: `${k.name} not sent: ${why}`, user });
    }
    return { sent, problems };
  }

  // When the shop marks a job Ready for pickup: once per job, with what's still owed.
  async function sendReady(jobId, { user, balanceCents } = {}) {
    if (!getNotices().ready_enabled) return { sent: [], problems: [], off: true };
    if (stmt('SELECT ready_sent_at FROM jobs WHERE id = ?').get(jobId)?.ready_sent_at) return { sent: [], problems: [], already: true };
    const balance = balanceCents == null ? ''
      : balanceCents > 0 ? `Balance due at pickup: ${money(balanceCents)}.` : 'Your balance is paid in full.';
    return notify(jobId, 'ready', { user, extra: { balance_due: balance } });
  }

  async function sendConfirmation(jobId, options) {
    if (!getNotices().confirm_enabled) return { sent: [], problems: [], off: true };
    return notify(jobId, 'confirm', options);
  }

  // The day-before reminders that are due: run every few minutes.
  async function sendDueReminders(at = new Date()) {
    const settings = getNotices();
    if (!settings.reminder_enabled) return 0;
    const due = stmt(`SELECT id, start_at, created_at FROM jobs WHERE status = 'scheduled' AND reminder_sent_at IS NULL
                      AND start_at > ? AND start_at < ?`).all(at.toISOString(), new Date(at.getTime() + 2 * 86400000).toISOString());
    let count = 0;
    for (const job of due) {
      const remindAt = new Date(job.start_at);
      remindAt.setDate(remindAt.getDate() - 1);
      remindAt.setHours(settings.reminder_hour, 0, 0, 0);
      if (at < remindAt) continue;
      // Booked after the reminder time (e.g. the day before): the confirmation already covers it.
      if (new Date(job.created_at) > remindAt) {
        stmt("UPDATE jobs SET reminder_sent_at = 'skipped' WHERE id = ?").run(job.id);
        continue;
      }
      await notify(job.id, 'reminder');
      count++;
    }
    return count;
  }

  // A moved job gets a fresh day-before reminder for its new date.
  function jobMoved(jobId) {
    stmt('UPDATE jobs SET reminder_sent_at = NULL WHERE id = ?').run(jobId);
  }

  return {
    getTemplates, saveTemplates, getNotices, saveNotices, render, valuesFor,
    sendText, receiveText, missedCall, answeredCall, sendConfirmation, sendReady, sendDueReminders, jobMoved,
  };
}

module.exports = { createMessageService, DEFAULT_TEMPLATES, DEFAULT_NOTICES };
