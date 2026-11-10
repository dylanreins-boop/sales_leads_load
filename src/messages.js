// Texts and automatic customer messages: saved text templates the reps send from a lead, replies
// coming back in, the booking confirmation, and the reminder the day before drop-off.
const { HttpError } = require('./leads');
const { renderTemplate } = require('./email');
const { toE164, prettyPhone } = require('./sms');
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
  // Every new lead: thanks, and what time of day is best to reach them. Their answer goes on the lead.
  welcome_enabled: true,
  welcome_text: 'Hi {{first_name}}, thanks for your interest in {{company}}! What time of day is best to reach you: morning, afternoon or evening? Just reply here.',
  welcome_reply_enabled: true,
  welcome_reply_text: 'Thanks {{first_name}}! We will reach out {{best_time}}.',
  // After pickup: a check-in a month later, and a maintenance reminder months later (once per job).
  checkin_enabled: true,
  checkin_days: 30,
  checkin_text: "Hi {{first_name}}, it's {{company}}. It's been about a month since we coated your {{vehicle}}. How's it holding up? Any questions about washing or care, just reply here.",
  checkin_subject: 'How is your {{vehicle}} holding up?',
  checkin_email: "Hi {{first_name}},\n\nIt's been about a month since we coated your {{vehicle}}. How's it holding up?\n\nIf you have any questions about washing or caring for the coating, just reply to this email or call {{company_phone}}.\n\n{{company}}",
  maintenance_enabled: true,
  maintenance_months: 6,
  maintenance_text: "Hi {{first_name}}, {{company}} here. Your {{vehicle}}'s coating is about {{months}} months in, a good time for a maintenance wash to keep it slick. Want us to set one up? Reply here or call {{company_phone}}.",
  maintenance_subject: 'Time for a maintenance wash on your {{vehicle}}',
  maintenance_email: "Hi {{first_name}},\n\nYour {{vehicle}}'s coating is about {{months}} months in. A maintenance wash now keeps it slick and protected.\n\nWant us to set one up? Reply to this email or call {{company_phone}}.\n\n{{company}}",
};
const NOTICE_TEXT_FIELDS = ['confirm_text', 'confirm_subject', 'confirm_email', 'reminder_text', 'reminder_subject', 'reminder_email', 'ready_text', 'ready_subject', 'ready_email', 'missed_call_text', 'welcome_text', 'welcome_reply_text',
  'checkin_text', 'checkin_subject', 'checkin_email', 'maintenance_text', 'maintenance_subject', 'maintenance_email'];
const NOTICE_FLAGS = ['confirm_enabled', 'reminder_enabled', 'ready_enabled', 'missed_call_enabled', 'welcome_enabled', 'welcome_reply_enabled', 'checkin_enabled', 'maintenance_enabled', 'by_text', 'by_email'];
// Each automatic message: the job column that marks it sent, and how it's logged.
const KINDS = {
  confirm: { sentColumn: 'confirm_sent_at', trigger: 'confirmation', email: 'Booking confirmation', name: 'Booking confirmation' },
  reminder: { sentColumn: 'reminder_sent_at', trigger: 'reminder', email: 'Reminder email', name: 'Day-before reminder' },
  ready: { sentColumn: 'ready_sent_at', trigger: 'ready', email: 'Ready-for-pickup email', name: 'Ready-for-pickup message' },
  checkin: { sentColumn: 'checkin_sent_at', trigger: 'checkin', email: 'Check-in email', name: 'Check-in after pickup' },
  maintenance: { sentColumn: 'maintenance_sent_at', trigger: 'maintenance', email: 'Maintenance reminder email', name: 'Maintenance reminder' },
};

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'];

// The welcome text goes out between these hours; a lead that comes in at night gets it in the morning.
const WELCOME_HOURS = [8, 20];
// Reads "afternoons work best", "after 3", "evenings or weekends", "anytime" into a short label.
// Returns null when the reply doesn't say a time (then it's just a text on the lead).
function parseBestTime(text) {
  const t = ` ${String(text || '').toLowerCase().replace(/[’']/g, '')} `;
  const parts = new Set();
  if (/\b(any ?time|whenever|all day|doesnt matter|does not matter|flexible|any time is fine)\b/.test(t)) parts.add('Anytime');
  if (/\b(mornings?|early|before noon|before lunch|breakfast|a\.?m\.?)\b/.test(t)) parts.add('Morning');
  if (/\b(afternoons?|lunch|midday|mid day|noon)\b/.test(t)) parts.add('Afternoon');
  if (/\b(evenings?|nights?|tonight|after work|dinner|p\.?m\.? ?(?:is|works)? ?(?:best|fine|good)?$)\b/.test(t)) parts.add('Evening');
  // Clock times: "3pm", "10:30 am", "after 3", "around 5", "between 2 and 4".
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\W)/g)) {
    let hour = Number(m[1]);
    const ampm = (m[3] || '').replace(/\./g, '');
    const before = t.slice(Math.max(0, m.index - 10), m.index);
    if (!ampm && !/\b(after|before|around|at|by|between|and|til|until|from|-|to)\s*$/.test(before)) continue; // a number, not a time
    if (hour < 1 || hour > 12 && !ampm) continue;
    if (ampm === 'pm' && hour < 12) hour += 12;
    else if (!ampm && hour <= 7) hour += 12; // "after 3" means 3 PM
    parts.add(hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening');
  }
  const order = ['Anytime', 'Morning', 'Afternoon', 'Evening'];
  let label = order.filter((p) => parts.has(p)).join(' or ');
  if (parts.has('Anytime') && parts.size > 1) label = order.filter((p) => p !== 'Anytime' && parts.has(p)).join(' or ');
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].filter((d) => new RegExp(`\\b${d}s?\\b`).test(t));
  if (/\bweekends?\b|\bsaturdays?\b|\bsundays?\b/.test(t)) label = label ? `${label}, weekends` : 'Weekends';
  else if (/\bweekdays?\b/.test(t) && label) label = `${label}, weekdays`;
  else if (days.length) {
    const named = days.map((d) => d[0].toUpperCase() + d.slice(1)).join(' or ');
    label = label ? `${label}, ${named}` : named;
  }
  if (!label) return null;
  return { label, note: String(text).trim().slice(0, 120) };
}
// What the thank-you reply says for each answer: "in the afternoon", "this weekend", "anytime".
function bestTimePhrase(label) {
  const first = label.split(/ or |, /)[0];
  return { Anytime: 'soon', Morning: 'in the morning', Afternoon: 'in the afternoon', Evening: 'in the evening', Weekends: 'on the weekend' }[first] || 'soon';
}
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
    if ('checkin_days' in input) {
      const days = Number(input.checkin_days);
      if (!Number.isInteger(days) || days < 7 || days > 120) throw new HttpError(400, 'Send the check-in 7 to 120 days after pickup.');
      next.checkin_days = days;
    }
    if ('maintenance_months' in input) {
      const months = Number(input.maintenance_months);
      if (!Number.isInteger(months) || months < 1 || months > 24) throw new HttpError(400, 'Send the maintenance reminder 1 to 24 months after pickup.');
      next.maintenance_months = months;
    }
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

  const LABELS = { welcome: 'Welcome text', welcome_reply: 'Best-time thank-you', referral: 'Referral link text', quote_followup: 'Quote follow-up text', campaign: 'Win-back text', missed_call: 'Missed-call text', manual: 'Text', confirmation: 'Booking confirmation text', reminder: 'Reminder text', booking_link: 'Booking link text', ready: 'Ready-for-pickup text' };

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
      if (trigger === 'manual' && user) leads.markContacted(leadId, { user, kind: 'text' });
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
      lead = leads.ingest({ source: 'text', phone: prettyPhone(from), message: text }).lead;
      created = true;
    }
    recordText(lead.id, { direction: 'in', phone: from, body: text, status: 'received', provider_id: id });
    leads.logActivity(lead.id, 'text', { note: `Text from customer: ${text}` });
    // An old lead (or a past customer) texting back goes back on the board to be worked.
    if (lead.archived_at && !STOP_WORDS.includes(text.toLowerCase().replace(/[^a-z]/g, ''))) {
      try { leads.restoreLead(lead.id); } catch { /* already back */ }
    }
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
    if (!created && !STOP_WORDS.includes(word)) noteBestTime(lead, text);
    const fresh = leads.getLead(lead.id);
    if (!created) onReply(fresh, text);
    return fresh;
  }

  // ---- the welcome text: thanks, and the best time of day to reach them ----
  // When it should go out: now during the day, otherwise 8 AM.
  function welcomeTime(at = new Date()) {
    const d = new Date(at);
    if (d.getHours() >= WELCOME_HOURS[0] && d.getHours() < WELCOME_HOURS[1]) return d;
    if (d.getHours() >= WELCOME_HOURS[1]) d.setDate(d.getDate() + 1);
    d.setHours(WELCOME_HOURS[0], 0, 0, 0);
    return d;
  }

  // Lines up the welcome text for a new lead (imports and missed callers don't get it; callers already got a text).
  function queueWelcome(lead, { force = false, at = new Date() } = {}) {
    const settings = getNotices();
    if (!settings.welcome_enabled) return false;
    if (!force && ['import', 'call', 'manual'].includes(lead.source)) return false;
    if (!lead.phone || !toE164(lead.phone) || lead.sms_opt_in === 0) return false;
    stmt('UPDATE leads SET welcome_due_at = ? WHERE id = ? AND welcome_sent_at IS NULL').run(welcomeTime(at).toISOString(), lead.id);
    return true;
  }

  // Sends the welcome texts that are due. Skips leads a rep already reached or that are closed.
  async function sendWelcomes(at = new Date()) {
    const settings = getNotices();
    if (!settings.welcome_enabled || !texter.configured) return 0;
    const due = stmt(`SELECT id, stage, last_contacted_at, best_time FROM leads
                      WHERE welcome_due_at IS NOT NULL AND welcome_due_at <= ? AND welcome_sent_at IS NULL`).all(at.toISOString());
    let sent = 0;
    for (const row of due) {
      stmt('UPDATE leads SET welcome_sent_at = ? WHERE id = ?').run(at.toISOString(), row.id);
      if (row.stage === 'waste' || row.best_time || row.last_contacted_at) continue;
      try {
        await sendText(row.id, render(settings.welcome_text, leads.getLead(row.id)), { trigger: 'welcome' });
        sent++;
      } catch { /* logged on the lead by sendText */ }
    }
    return sent;
  }

  // A reply after the welcome text that names a time goes on the lead, and the customer gets a short thanks.
  function noteBestTime(lead, text) {
    if (!lead.welcome_sent_at || lead.best_time_by === 'customer') return;
    if (Date.now() - new Date(lead.welcome_sent_at) > 14 * 86400000) return;
    const parsed = parseBestTime(text);
    if (!parsed) return;
    stmt('UPDATE leads SET best_time = ?, best_time_note = ?, best_time_by = ?, best_time_at = ? WHERE id = ?').run(parsed.label, parsed.note, 'customer', now(), lead.id);
    leads.logActivity(lead.id, 'text', { note: `Best time to reach: ${parsed.label} ("${parsed.note}")` });
    const settings = getNotices();
    if (settings.welcome_reply_enabled && texter.configured) {
      const fresh = leads.getLead(lead.id);
      sendText(lead.id, render(settings.welcome_reply_text, fresh, { extra: { best_time: bestTimePhrase(parsed.label) } }), { trigger: 'welcome_reply' }).catch(() => {});
    }
  }

  // ---- missed calls (Twilio voice) ----
  // A call nobody answered: the caller becomes (or is matched to) a lead and gets a text right away,
  // at most once every 12 hours.
  async function missedCall({ from }) {
    if (!toE164(from)) return null;
    const { lead, created } = leads.ingest({ source: 'call', phone: prettyPhone(from), message: 'Called and nobody answered' });
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

  // After pickup: the check-in (days later) and the maintenance reminder (months later), once per job,
  // in the daytime. Only jobs picked up recently enough count, so turning it on doesn't message years of
  // old customers at once; a customer who already came back for another job gets no maintenance nudge.
  async function sendCareMessages(at = new Date()) {
    const s = getNotices();
    if (at.getHours() < s.reminder_hour || at.getHours() >= 19) return 0;
    const DAY = 86400000;
    let count = 0;
    const plans = [
      s.checkin_enabled && { kind: 'checkin', dueAt: (p) => new Date(p.getTime() + s.checkin_days * DAY) },
      s.maintenance_enabled && { kind: 'maintenance', dueAt: (p) => { const d = new Date(p); d.setMonth(d.getMonth() + s.maintenance_months); return d; } },
    ].filter(Boolean);
    for (const plan of plans) {
      const col = KINDS[plan.kind].sentColumn;
      const rows = stmt(`SELECT j.id, j.lead_id, j.picked_up_at FROM jobs j WHERE j.status = 'picked_up' AND j.picked_up_at IS NOT NULL AND j.${col} IS NULL`).all();
      for (const job of rows) {
        const due = plan.dueAt(new Date(job.picked_up_at));
        if (at < due) continue;
        const late = at - due > 14 * DAY;
        const cameBack = plan.kind === 'maintenance' && stmt("SELECT 1 FROM jobs WHERE lead_id = ? AND id != ? AND status != 'cancelled' AND start_at > ?").get(job.lead_id, job.id, job.picked_up_at);
        if (late || cameBack) { stmt(`UPDATE jobs SET ${col} = 'skipped' WHERE id = ?`).run(job.id); continue; }
        await notify(job.id, plan.kind, { extra: { months: String(s.maintenance_months) } });
        count += 1;
      }
    }
    return count;
  }

  // A moved job gets a fresh day-before reminder for its new date.
  function jobMoved(jobId) {
    stmt('UPDATE jobs SET reminder_sent_at = NULL WHERE id = ?').run(jobId);
  }

  return {
    getTemplates, saveTemplates, getNotices, saveNotices, render, valuesFor,
    sendText, receiveText, missedCall, answeredCall, sendConfirmation, sendReady, sendDueReminders, sendCareMessages, jobMoved,
    queueWelcome, sendWelcomes,
  };
}

module.exports = { createMessageService, DEFAULT_TEMPLATES, DEFAULT_NOTICES, parseBestTime };
