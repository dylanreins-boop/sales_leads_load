// Automatic follow-up that brings leads back:
//  - Quote follow-ups: a quote that hasn't turned into a booking gets a text (or email) with a booking
//    link a few days later, and one more a few days after that. It stops when the customer replies,
//    books, or the lead is marked Waste.
//  - Win-back campaigns: an admin picks old or dead leads, writes the message and approves the batch;
//    it goes out a few at a time during sending hours. Replies bring the lead back on the board.
// Nothing is sent outside 9 AM-7 PM, Monday to Saturday (shop time).
const { HttpError } = require('./leads');
const { toE164 } = require('./sms');
const { pipelineFor } = require('./vehicle');

const DEFAULT_FOLLOWUPS = {
  quote_followup_enabled: true,
  quote_followup_days_1: 3,
  quote_followup_days_2: 7,
  quote_followup_1: 'Hi {{first_name}}, {{rep}} from {{company}} here. Just checking in on the {{quote_total}} quote for your {{vehicle}}. If you\'re ready, you can pick your day here: {{booking_link}}',
  quote_followup_2: 'Hi {{first_name}}, last nudge from {{company}} about your {{vehicle}}. Our calendar fills up fast; grab a day here when it suits you: {{booking_link}} Questions? Just reply.',
  quote_followup_subject: 'Your quote from {{company}}',
};
const SKIP_DISPOSITIONS = ['do_not_call', 'wrong_number', 'duplicate'];
const sendingHours = (at) => at.getDay() !== 0 && at.getHours() >= 9 && at.getHours() < 19;

function createCampaignService(db, { leads, messages, bookings, mailer, texter, publicUrl = '' }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const readSetting = (key) => { try { return JSON.parse(stmt('SELECT value FROM settings WHERE key = ?').get(key)?.value || '{}'); } catch { return {}; } };

  // ---- quote follow-ups ----
  const getFollowups = () => ({ ...DEFAULT_FOLLOWUPS, ...readSetting('quote_followups') });
  function saveFollowups(input = {}) {
    const next = getFollowups();
    if ('quote_followup_enabled' in input) next.quote_followup_enabled = Boolean(input.quote_followup_enabled);
    for (const key of ['quote_followup_days_1', 'quote_followup_days_2']) {
      if (!(key in input)) continue;
      const d = Number(input[key]);
      if (!Number.isInteger(d) || d < 1 || d > 60) throw new HttpError(400, 'Follow-up days go from 1 to 60.');
      next[key] = d;
    }
    if (next.quote_followup_days_2 <= next.quote_followup_days_1) throw new HttpError(400, 'The second follow-up has to come after the first.');
    for (const key of ['quote_followup_1', 'quote_followup_2', 'quote_followup_subject']) {
      if (!(key in input)) continue;
      const text = String(input[key] ?? '').trim();
      if (!text) throw new HttpError(400, 'Follow-up messages can\'t be blank. Turn follow-ups off instead.');
      next[key] = text.slice(0, 1000);
    }
    stmt("INSERT INTO settings (key, value) VALUES ('quote_followups', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  // The lead's open booking link, or a new one from their quote (booked for the rep who quoted).
  function bookingLinkFor(lead, quote) {
    if (!publicUrl) return '';
    const open = stmt(`SELECT token FROM booking_links WHERE lead_id = ? AND cancelled_at IS NULL AND job_id IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1`).get(lead.id, now());
    const token = open?.token || bookings.create(lead.id, { amount: (quote.total_cents / 100).toFixed(2) }, { user: quote.created_by }).token;
    return `${publicUrl}/book/${token}`;
  }

  // Sends a message to a lead by text when we can, else email. Returns 'text', 'email' or null.
  async function reach(lead, { text, subject, trigger, label, user }) {
    if (texter.configured && lead.phone && toE164(lead.phone) && lead.sms_opt_in !== 0) {
      await messages.sendText(lead.id, text, { user, trigger });
      return 'text';
    }
    if (mailer.configured && lead.email) {
      const message = { to: lead.email, subject, text };
      try {
        await mailer.send(message);
        leads.recordEmail(lead.id, message, { status: 'sent', trigger, user, label });
      } catch (err) {
        leads.recordEmail(lead.id, message, { status: 'failed', error: err.message, trigger, user, label });
        throw err;
      }
      return 'email';
    }
    return null;
  }

  async function sendQuoteFollowups(at = new Date()) {
    const s = getFollowups();
    if (!s.quote_followup_enabled || !sendingHours(at)) return 0;
    // Each lead's latest quote, still waiting on the customer.
    const due = stmt(`SELECT q.* FROM quotes q JOIN leads l ON l.id = q.lead_id
                      WHERE q.id = (SELECT MAX(id) FROM quotes WHERE lead_id = q.lead_id)
                        AND q.followup2_at IS NULL AND l.archived_at IS NULL AND l.stage NOT IN ('booked', 'waste')
                        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled')`).all();
    let sent = 0;
    for (const q of due) {
      const step = q.followup1_at ? 2 : 1;
      const days = s[`quote_followup_days_${step}`];
      if (at - new Date(q.created_at) < days * 86400000) continue;
      const column = step === 1 ? 'followup1_at' : 'followup2_at';
      // The customer answered since the quote: a person takes it from here.
      const replied = stmt(`SELECT 1 FROM texts WHERE lead_id = ? AND direction = 'in' AND created_at > ?`).get(q.lead_id, q.created_at);
      if (replied) {
        stmt("UPDATE quotes SET followup1_at = coalesce(followup1_at, 'replied'), followup2_at = 'replied' WHERE id = ?").run(q.id);
        continue;
      }
      stmt(`UPDATE quotes SET ${column} = ? WHERE id = ?`).run(now(), q.id);
      const lead = leads.getLead(q.lead_id);
      const extra = { booking_link: bookingLinkFor(lead, q) };
      try {
        const how = await reach(lead, {
          text: messages.render(s[`quote_followup_${step}`], lead, { rep: q.created_by, extra }),
          subject: messages.render(s.quote_followup_subject, lead, { rep: q.created_by, extra }),
          trigger: 'quote_followup', label: 'Quote follow-up',
        });
        if (how) sent++;
        else leads.logActivity(lead.id, 'notice', { note: `Quote follow-up ${step} not sent: no way to reach the customer` });
      } catch (err) { console.error('Quote follow-up failed:', err.message); }
    }
    return sent;
  }

  // ---- win-back campaigns ----
  const AUDIENCES = ['old', 'dead'];
  // Old and dead leads matching the picks, minus anyone who can't or shouldn't be contacted.
  function audience({ statuses = ['old'], pipeline = '', months = 12, channel = 'both' } = {}) {
    const picks = (Array.isArray(statuses) ? statuses : [statuses]).filter((s) => AUDIENCES.includes(s));
    if (!picks.length) throw new HttpError(400, 'Pick old leads, dead leads or both.');
    const since = new Date(Date.now() - Math.max(1, Math.min(60, Number(months) || 12)) * 30 * 86400000).toISOString();
    const recently = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = stmt(`SELECT * FROM leads l WHERE l.archived_at IS NOT NULL AND l.stage != 'booked' AND l.received_at >= ?
                       AND NOT EXISTS (SELECT 1 FROM campaign_sends c WHERE c.lead_id = l.id AND c.created_at > ?)
                       ORDER BY l.received_at DESC`).all(since, recently)
      .filter((l) => picks.includes(l.stage === 'waste' ? 'dead' : 'old'))
      .filter((l) => !pipeline || pipelineFor(l.vehicle_type) === pipeline)
      .filter((l) => !SKIP_DISPOSITIONS.includes(l.last_disposition));
    const how = (l) => {
      const canText = texter.configured && toE164(l.phone) && l.sms_opt_in !== 0;
      const canEmail = mailer.configured && l.email;
      if (channel !== 'email' && canText) return 'text';
      if (channel !== 'text' && canEmail) return 'email';
      return null;
    };
    const reachable = rows.map((l) => ({ lead: l, channel: how(l) }));
    return {
      leads: reachable.filter((r) => r.channel),
      unreachable: reachable.filter((r) => !r.channel).length,
    };
  }

  function check(input = {}) {
    const { leads: list, unreachable } = audience(input);
    const sample = list[0]?.lead;
    return {
      count: list.length,
      by_text: list.filter((r) => r.channel === 'text').length,
      by_email: list.filter((r) => r.channel === 'email').length,
      unreachable,
      sample: sample ? { name: sample.full_name || sample.first_name || sample.phone, text: messages.render(input.text || '', leads.getLead(sample.id)) } : null,
      texting: texter.configured,
      email: mailer.configured,
    };
  }

  function start(input = {}, { user } = {}) {
    const name = String(input.name || '').trim().slice(0, 60);
    const text = String(input.text || '').trim().slice(0, 1000);
    if (!name) throw new HttpError(400, 'Give the campaign a name, like "Spring RV special".');
    if (!text) throw new HttpError(400, 'Write the message.');
    const subject = String(input.subject || '').trim().slice(0, 200) || `A note from {{company}}`;
    const { leads: list } = audience(input);
    if (!list.length) throw new HttpError(400, 'Nobody matches. Widen who it goes to.');
    const ts = now();
    const { lastInsertRowid } = stmt(`INSERT INTO campaigns (name, audience, text_body, email_subject, status, created_by, created_at)
                                      VALUES (?, ?, ?, ?, 'sending', ?, ?)`).run(name, JSON.stringify({ statuses: input.statuses, pipeline: input.pipeline || '', months: input.months, channel: input.channel || 'both' }), text, subject, user ?? null, ts);
    const id = Number(lastInsertRowid);
    const add = stmt("INSERT INTO campaign_sends (campaign_id, lead_id, channel, status, created_at) VALUES (?, ?, ?, 'pending', ?)");
    for (const r of list) add.run(id, r.lead.id, r.channel, ts);
    return summary(id);
  }

  function summary(id) {
    const c = stmt('SELECT * FROM campaigns WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Campaign not found');
    const counts = Object.fromEntries(stmt('SELECT status, COUNT(*) AS n FROM campaign_sends WHERE campaign_id = ? GROUP BY status').all(id).map((r) => [r.status, r.n]));
    const replied = stmt(`SELECT COUNT(DISTINCT s.lead_id) AS n FROM campaign_sends s
                          WHERE s.campaign_id = ? AND s.status = 'sent' AND EXISTS (SELECT 1 FROM texts t WHERE t.lead_id = s.lead_id AND t.direction = 'in' AND t.created_at > s.sent_at)`).get(id).n;
    const booked = stmt(`SELECT COUNT(DISTINCT s.lead_id) AS n FROM campaign_sends s
                         WHERE s.campaign_id = ? AND s.status = 'sent' AND EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = s.lead_id AND j.created_at > s.sent_at AND j.status != 'cancelled')`).get(id).n;
    return { ...c, audience: JSON.parse(c.audience), pending: counts.pending || 0, sent: counts.sent || 0, failed: counts.failed || 0, replied, booked };
  }
  const list = () => stmt('SELECT id FROM campaigns ORDER BY id DESC LIMIT 20').all().map((r) => summary(r.id));

  function stop(id, { user } = {}) {
    stmt("UPDATE campaign_sends SET status = 'stopped' WHERE campaign_id = ? AND status = 'pending'").run(id);
    stmt("UPDATE campaigns SET status = 'stopped', stopped_by = ? WHERE id = ?").run(user ?? null, id);
    return summary(id);
  }

  // Sends the next few waiting messages; runs every minute during sending hours.
  async function sendNext({ at = new Date(), batch = 10 } = {}) {
    if (!sendingHours(at)) return 0;
    const due = stmt(`SELECT s.*, c.name, c.text_body, c.email_subject, c.created_by FROM campaign_sends s JOIN campaigns c ON c.id = s.campaign_id
                      WHERE s.status = 'pending' AND c.status = 'sending' ORDER BY s.id LIMIT ?`).all(batch);
    let sent = 0;
    for (const s of due) {
      stmt("UPDATE campaign_sends SET status = 'sending' WHERE id = ?").run(s.id);
      const lead = leads.getLead(s.lead_id);
      try {
        const text = messages.render(s.text_body, lead, { rep: s.created_by });
        const how = await reach(lead, { text, subject: messages.render(s.email_subject, lead), trigger: 'campaign', label: `Campaign "${s.name}"` });
        stmt('UPDATE campaign_sends SET status = ?, channel = ?, sent_at = ? WHERE id = ?').run(how ? 'sent' : 'failed', how, now(), s.id);
        if (how) {
          leads.logActivity(lead.id, 'campaign', { note: `Win-back "${s.name}" sent by ${how}` });
          sent++;
        }
      } catch (err) {
        stmt("UPDATE campaign_sends SET status = 'failed', error = ? WHERE id = ?").run(String(err.message).slice(0, 300), s.id);
      }
    }
    stmt(`UPDATE campaigns SET status = 'done' WHERE status = 'sending'
          AND NOT EXISTS (SELECT 1 FROM campaign_sends s WHERE s.campaign_id = campaigns.id AND s.status IN ('pending', 'sending'))`).run();
    return sent;
  }

  return { getFollowups, saveFollowups, sendQuoteFollowups, check, start, list, summary, stop, sendNext };
}

module.exports = { createCampaignService, DEFAULT_FOLLOWUPS, sendingHours };
