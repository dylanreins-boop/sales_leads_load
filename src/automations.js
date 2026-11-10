'use strict';
// Automations: one list of everything the app does on its own (texts, emails, alerts, clean-up), with
// whether each is on, when it happens, what it still needs, and a switch. The wording and timing stay
// where they were (Texts & reminders, Emails, …); this page says where.
const { HttpError } = require('./leads');

function createAutomations({ messages, campaigns, reviews, daySheets, social, timeClock, leads, calls, texter, mailer, config }) {
  const needs = (...what) => what.filter(Boolean);
  const textNeed = () => (texter.configured ? null : 'texting (Twilio)');
  const mailNeed = () => (mailer.configured ? null : 'email');

  // Each one: how to read it, and (when it has a switch) how to flip it.
  const ITEMS = [
    { id: 'welcome', group: 'New leads', name: 'Welcome text', open: 'messagesBtn',
      read: () => { const n = messages.getNotices(); return { on: n.welcome_enabled, when: 'Right away (8 AM to 8 PM); asks the best time to call', needs: needs(textNeed()) }; },
      set: (on) => messages.saveNotices({ welcome_enabled: on }) },
    { id: 'speed_alert', group: 'New leads', name: 'Speed-to-lead alert to the team', open: null,
      read: () => ({ on: true, when: `When a new lead comes in, and again if nobody has worked it in ${config.speedToLeadMinutes} minutes (SPEED_TO_LEAD_MINUTES on the server)`, needs: [] }) },
    { id: 'voicemail_email', group: 'New leads', name: 'Follow-up email after a voicemail', open: 'emailSettingsBtn',
      read: () => ({ on: leads.getEmailSettings().enabled, when: 'When a rep logs No answer: left voicemail', needs: needs(mailNeed()) }),
      set: (on) => { const e = leads.getEmailSettings(); return leads.saveEmailSettings({ ...e, enabled: on }); } },
    { id: 'missed_call', group: 'New leads', name: 'Missed-call text-back', open: 'messagesBtn',
      read: () => ({ on: messages.getNotices().missed_call_enabled, when: 'When a call to the shop number isn\'t answered', needs: needs(textNeed()) }),
      set: (on) => messages.saveNotices({ missed_call_enabled: on }) },
    { id: 'quote_followups', group: 'Quotes and bookings', name: 'Quote follow-ups', open: 'messagesBtn',
      read: () => { const f = campaigns.getFollowups(); return { on: f.quote_followup_enabled, when: `${f.quote_followup_days_1} and ${f.quote_followup_days_2} days after a quote, until they reply or book`, needs: needs(textNeed(), !config.publicUrl && 'PUBLIC_URL') }; },
      set: (on) => campaigns.saveFollowups({ quote_followup_enabled: on }) },
    { id: 'confirm', group: 'Quotes and bookings', name: 'Booking confirmation', open: 'messagesBtn',
      read: () => ({ on: messages.getNotices().confirm_enabled, when: 'When a job is booked', needs: needs(textNeed() && mailNeed() && 'texting or email') }),
      set: (on) => messages.saveNotices({ confirm_enabled: on }) },
    { id: 'reminder', group: 'Quotes and bookings', name: 'Day-before reminder', open: 'messagesBtn',
      read: () => { const n = messages.getNotices(); return { on: n.reminder_enabled, when: `The day before drop-off at ${hourLabel(n.reminder_hour)}`, needs: needs(textNeed() && mailNeed() && 'texting or email') }; },
      set: (on) => messages.saveNotices({ reminder_enabled: on }) },
    { id: 'ready', group: 'After the job', name: 'Ready-for-pickup message', open: 'messagesBtn',
      read: () => ({ on: messages.getNotices().ready_enabled, when: 'When the shop marks the job Ready for pickup (with the balance due)', needs: needs(textNeed() && mailNeed() && 'texting or email') }),
      set: (on) => messages.saveNotices({ ready_enabled: on }) },
    { id: 'review', group: 'After the job', name: 'Review request email', open: 'reviewSettings',
      read: () => { const r = reviews.getSettings(); return { on: r.enabled, when: `${r.delay_days} day${r.delay_days === 1 ? '' : 's'} after pickup`, needs: needs(mailNeed(), !r.link && 'a review link') }; },
      set: (on) => reviews.saveSettings({ ...reviews.getSettings(), enabled: on }) },
    { id: 'checkin', group: 'After the job', name: 'Check-in text', open: 'messagesBtn',
      read: () => { const n = messages.getNotices(); return { on: n.checkin_enabled, when: `${n.checkin_days} days after pickup`, needs: needs(textNeed() && mailNeed() && 'texting or email') }; },
      set: (on) => messages.saveNotices({ checkin_enabled: on }) },
    { id: 'maintenance', group: 'After the job', name: 'Maintenance reminder', open: 'messagesBtn',
      read: () => { const n = messages.getNotices(); return { on: n.maintenance_enabled, when: `${n.maintenance_months} months after pickup`, needs: needs(textNeed() && mailNeed() && 'texting or email') }; },
      set: (on) => messages.saveNotices({ maintenance_enabled: on }) },
    { id: 'social_drafts', group: 'After the job', name: 'Social post drafts', open: 'socialBtn',
      read: () => ({ on: social.getSettings().auto_draft, when: 'When a job with after photos is marked Ready for pickup (and the customer OK\'d it); an admin still taps Post it', needs: [] }),
      set: (on) => social.saveSettings({ ...social.getSettings(), auto_draft: on }) },
    { id: 'winback', group: 'After the job', name: 'Win-back campaigns', open: 'winbackBtn',
      read: () => ({ on: true, manual: true, when: 'Started by an admin for a group of past customers or old leads; stops when they reply or book', needs: needs(textNeed()) }) },
    { id: 'day_sheet', group: 'Team', name: 'Morning day sheet email', open: 'daySheet',
      read: () => { const d = daySheets.getSettings(); return { on: d.enabled, when: `Every morning at ${hourLabel(d.hour)} to ${d.to.length ? d.to.join(', ') : 'nobody yet'}`, needs: needs(mailNeed(), !d.to.length && 'who gets it') }; },
      set: (on) => daySheets.saveSettings({ ...daySheets.getSettings(), enabled: on }) },
    { id: 'payroll_email', group: 'Team', name: 'Weekly payroll summary', open: 'payrollRules',
      read: () => { const t = timeClock.getSettings(); return { on: t.payroll_emails.length > 0, when: t.payroll_emails.length ? `When everyone has approved the week, to ${t.payroll_emails.join(', ')}` : 'Add who gets it under Time & Pay → Payroll rules', needs: needs(mailNeed()) }; } },
    { id: 'archive', group: 'Housekeeping', name: 'Old leads move off the board', open: null,
      read: () => ({ on: config.archiveDays > 0, when: `After ${config.archiveDays} days with no booking (LEAD_ARCHIVE_DAYS); they stay in Old & Dead Leads and come back if they text or call`, needs: [] }) },
    calls && { id: 'transcripts', group: 'Housekeeping', name: 'Delete what was said on calls', open: 'callsBtn',
      read: () => { const a = calls.getAiSettings(); return { on: a.transcript_days > 0, when: a.transcript_days ? `${a.transcript_days} days after the call (the short notes stay)` : 'Kept until deleted; set the days under Calls → AI call settings', needs: [] }; } },
  ].filter(Boolean);

  function list() {
    return ITEMS.map((i) => ({ id: i.id, group: i.group, name: i.name, open: i.open, can_switch: Boolean(i.set), ...i.read() }));
  }
  function set(id, on) {
    const item = ITEMS.find((i) => i.id === id);
    if (!item) throw new HttpError(404, 'No such automation.');
    if (!item.set) throw new HttpError(400, `${item.name} is set elsewhere: ${item.read().when}`);
    item.set(Boolean(on));
    return list().find((i) => i.id === id);
  }
  return { list, set };
}

const hourLabel = (h) => new Date(2026, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' });

module.exports = { createAutomations };
