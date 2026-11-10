// The dialer (only in the build with CALLS_ENABLED). A rep taps Call on a lead: Twilio rings the rep's
// own phone, and when they pick up it calls the customer from the shop's number. The customer first
// hears a short notice that the call may be transcribed, then they're connected. What each side says
// is written out live (Twilio real-time transcription); no audio is ever recorded or kept. When the
// call ends, the app writes call notes (see callsummary.js) for the rep and for admins to review.
const { HttpError } = require('./leads');
const { toE164, prettyPhone } = require('./sms');
const { FLAGS, DISPOSITION_FOR } = require('./callsummary');

const ACTIVE = ['calling_rep', 'calling_customer', 'connected'];
const now = () => new Date().toISOString();

function createCallService(db, { leads, sms, summarizer, publicUrl, notice, hours = '8-21', brand = {}, fetchImpl = (...a) => fetch(...a) }) {
  const stmt = (sql) => db.prepare(sql);
  const configured = Boolean(sms.accountSid && sms.authToken && sms.from);
  const [openHour, closeHour] = String(hours).split('-').map(Number);
  const byId = (id) => {
    const c = stmt('SELECT * FROM calls WHERE id = ?').get(id);
    if (!c) throw new HttpError(404, 'Call not found');
    return c;
  };
  const shape = (c, { lines = false } = {}) => ({
    ...c,
    summary: c.summary ? JSON.parse(c.summary) : null,
    flags: c.flags ? JSON.parse(c.flags) : [],
    flag_labels: (c.flags ? JSON.parse(c.flags) : []).map((f) => FLAGS[f] || f),
    suggested_disposition: c.summary ? DISPOSITION_FOR[JSON.parse(c.summary).outcome] || null : null,
    ...(lines ? { lines: stmt('SELECT speaker, text, at FROM call_lines WHERE call_id = ? ORDER BY id').all(c.id) } : {}),
  });

  // ---- each rep's phone for the dialer ----
  const norm = (name) => String(name || '').trim().toLowerCase();
  function repPhone(name) {
    const row = stmt('SELECT call_phone, alert_phone FROM user_prefs WHERE name_norm = ?').get(norm(name));
    return row?.call_phone || row?.alert_phone || '';
  }
  function setRepPhone(name, phone) {
    const value = String(phone || '').trim();
    if (value && !toE164(value)) throw new HttpError(400, 'That doesn\'t look like a phone number.');
    stmt(`INSERT INTO user_prefs (name_norm, name, call_phone, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (name_norm) DO UPDATE SET call_phone = excluded.call_phone, updated_at = excluded.updated_at`).run(norm(name), name, value ? prettyPhone(value) : null, now());
    return { call_phone: repPhone(name) };
  }

  async function twilio(path, form) {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sms.accountSid}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(502, `The phone service said no: ${data.message || res.status}`);
    return data;
  }

  // ---- placing a call ----
  async function start(leadId, { user, at = new Date() } = {}) {
    if (!configured) throw new HttpError(400, 'The dialer needs the Twilio keys (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).');
    if (!publicUrl) throw new HttpError(400, 'The dialer needs PUBLIC_URL set, so the phone service can reach the app.');
    if (!user) throw new HttpError(400, 'Sign in to use the dialer.');
    const lead = leads.getLead(leadId);
    const customer = toE164(lead.phone);
    if (!customer) throw new HttpError(400, 'This lead has no phone number to call.');
    if (['do_not_call', 'wrong_number'].includes(lead.last_disposition)) throw new HttpError(400, 'This lead is marked do not call / wrong number.');
    const rep = toE164(repPhone(user));
    if (!rep) throw new HttpError(400, 'Add your phone number for the dialer first (To do → My phone).');
    const hour = at.getHours();
    if (hour < openHour || hour >= closeHour) throw new HttpError(400, `Calls go out between ${fmtHour(openHour)} and ${fmtHour(closeHour)}.`);
    if (stmt(`SELECT 1 FROM calls WHERE user_name = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) AND started_at > ?`)
      .get(user, ...ACTIVE, new Date(at - 2 * 3600000).toISOString())) {
      throw new HttpError(400, 'You already have a call going. Hang up or wait for it to end.');
    }
    const { lastInsertRowid } = stmt(`INSERT INTO calls (lead_id, user_name, rep_phone, customer_phone, status, started_at) VALUES (?, ?, ?, ?, 'calling_rep', ?)`)
      .run(leadId, user, rep, customer, at.toISOString());
    const id = Number(lastInsertRowid);
    try {
      const data = await twilio('Calls.json', {
        To: rep,
        From: sms.from,
        Url: `${publicUrl}/webhooks/twilio/calls/${id}/answer`,
        StatusCallback: `${publicUrl}/webhooks/twilio/calls/${id}/status`,
        StatusCallbackEvent: 'completed',
        Timeout: '25',
      });
      stmt('UPDATE calls SET provider_id = ? WHERE id = ?').run(data.sid || null, id);
    } catch (err) {
      stmt("UPDATE calls SET status = 'failed', ended_at = ?, summary_error = ? WHERE id = ?").run(now(), err.message, id);
      throw err;
    }
    leads.logActivity(leadId, 'call', { note: `${user} started a call from the dialer`, user });
    return shape(byId(id));
  }

  // ---- Twilio's side ----
  const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // The rep picked up: start writing out the call, then call the customer. On the rep's leg, the
  // inbound track is the rep's voice and the outbound track is what the rep hears (the customer).
  function answerTwiml(id) {
    const c = byId(id);
    if (c.status !== 'calling_rep') return '<Hangup/>';
    const lead = leads.getLead(c.lead_id);
    const name = lead.first_name || (lead.full_name || '').split(' ')[0] || 'the customer';
    stmt("UPDATE calls SET status = 'calling_customer' WHERE id = ?").run(id);
    return `<Say>Calling ${xml(name)}.</Say>`
      + `<Start><Transcription statusCallbackUrl="${xml(`${publicUrl}/webhooks/twilio/calls/${id}/transcript`)}" track="both_tracks" inboundTrackLabel="rep" outboundTrackLabel="customer"/></Start>`
      + `<Dial callerId="${xml(sms.from)}" answerOnBridge="true" timeout="25" action="${xml(`${publicUrl}/webhooks/twilio/calls/${id}/dialed`)}">`
      + `<Number url="${xml(`${publicUrl}/webhooks/twilio/calls/${id}/notice`)}">${xml(c.customer_phone)}</Number></Dial>`;
  }

  // Played to the customer when they answer, before the rep is connected.
  function noticeTwiml(id) {
    byId(id);
    stmt("UPDATE calls SET status = 'connected', connected_at = COALESCE(connected_at, ?) WHERE id = ?").run(now(), id);
    return `<Say>${xml(notice)}</Say>`;
  }

  // A finished piece of what someone said.
  function transcript(id, body) {
    const c = byId(id);
    if (body.TranscriptionEvent !== 'transcription-content') return;
    if (String(body.Final).toLowerCase() === 'false') return; // partial results are replaced by the final one
    let data = {};
    try { data = JSON.parse(body.TranscriptionData || '{}'); } catch { return; }
    const text = String(data.transcript || '').trim();
    if (!text) return;
    const speaker = /outbound/i.test(body.Track || '') ? 'customer' : 'rep';
    stmt('INSERT INTO call_lines (call_id, speaker, text, at) VALUES (?, ?, ?, ?)').run(c.id, speaker, text.slice(0, 2000), body.Timestamp || now());
  }

  // The customer's side of the call ended (or never connected).
  function dialed(id, body) {
    const c = byId(id);
    const status = String(body.DialCallStatus || 'completed');
    const seconds = Number(body.DialCallDuration) || 0;
    stmt('UPDATE calls SET customer_status = ?, talk_seconds = ? WHERE id = ?').run(status, status === 'completed' ? seconds : 0, c.id);
    return '<Hangup/>';
  }

  // The whole call is over: write the notes (after a moment, so the last words arrive first).
  function ended(id, body, { delay = Number(process.env.CALL_NOTES_DELAY_MS ?? 4000) } = {}) {
    const c = byId(id);
    if (!ACTIVE.includes(c.status)) return null;
    const repAnswered = c.status !== 'calling_rep';
    stmt('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?').run(repAnswered ? 'ended' : 'rep_missed', now(), c.id);
    if (!repAnswered) return null;
    const run = () => writeNotes(c.id).catch((err) => console.error('Call notes failed:', err.message));
    if (delay) setTimeout(run, delay).unref?.();
    else return run();
    return null;
  }

  async function writeNotes(id) {
    const c = byId(id);
    const lines = stmt('SELECT speaker, text FROM call_lines WHERE call_id = ? ORDER BY id').all(id);
    const lead = leads.getLead(c.lead_id);
    const vehicle = [lead.vehicle_year, lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ') || lead.vehicle_type || '';
    const { notes, source, error } = await summarizer.summarize({ lines, lead: { vehicle, services: (lead.booked_services || []).join(', ') }, rep: c.user_name });
    if (!c.talk_seconds && c.customer_status && c.customer_status !== 'completed') {
      notes.outcome = 'no_conversation';
      notes.summary = c.customer_status === 'no-answer' ? 'The customer didn\'t answer.' : c.customer_status === 'busy' ? 'The line was busy.' : notes.summary;
      notes.flags = [];
    }
    stmt('UPDATE calls SET summary = ?, summary_source = ?, summary_error = ?, flags = ? WHERE id = ?')
      .run(JSON.stringify(notes), source, error, JSON.stringify(notes.flags || []), id);
    const mins = c.talk_seconds ? ` (${Math.max(1, Math.round(c.talk_seconds / 60))} min)` : '';
    leads.logActivity(c.lead_id, 'call', { note: `Call notes${mins}: ${notes.summary}${notes.next_step ? ` Next: ${notes.next_step}` : ''}`, user: null });
    return shape(byId(id));
  }

  // ---- reading calls ----
  const get = (id) => shape(byId(id), { lines: true });
  const forLead = (leadId) => stmt('SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC').all(leadId).map((c) => shape(c));
  const active = (user) => {
    const c = stmt(`SELECT * FROM calls WHERE user_name = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`).get(user, ...ACTIVE);
    return c ? shape(c) : null;
  };

  // The admins' review list.
  function list({ rep, flagged, reviewed, from, to, limit = 200 } = {}) {
    const where = ["c.status IN ('ended', 'rep_missed', 'failed')"];
    const params = [];
    if (rep) { where.push('c.user_name = ?'); params.push(rep); }
    if (from) { where.push('c.started_at >= ?'); params.push(from); }
    if (to) { where.push('c.started_at < ?'); params.push(to); }
    if (reviewed === 'no') where.push('c.reviewed_at IS NULL');
    if (reviewed === 'yes') where.push('c.reviewed_at IS NOT NULL');
    if (flagged === 'yes') where.push("c.flags IS NOT NULL AND c.flags != '[]'");
    const rows = stmt(`SELECT c.*, l.full_name, l.first_name, l.last_name, l.vehicle_type, l.stage
                       FROM calls c JOIN leads l ON l.id = c.lead_id WHERE ${where.join(' AND ')}
                       ORDER BY c.started_at DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 200, 500));
    return rows.map((c) => ({ ...shape(c), lead_name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer' }));
  }

  // An admin reviews a call: a score and a coaching note the rep sees on the lead.
  function review(id, { score, comment } = {}, { user } = {}) {
    const c = byId(id);
    const s = score == null || score === '' ? null : Number(score);
    if (s != null && !(Number.isInteger(s) && s >= 1 && s <= 5)) throw new HttpError(400, 'Score the call from 1 to 5.');
    const text = String(comment || '').trim().slice(0, 1000) || null;
    stmt('UPDATE calls SET review_score = ?, review_comment = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(s, text, user ?? null, now(), id);
    if (text) leads.logActivity(c.lead_id, 'call', { note: `Coaching from ${user || 'an admin'} on ${c.user_name}'s call: ${text}`, user });
    return get(id);
  }

  // ---- the dialer's call list for a rep: who to call next ----
  // Call-now reminders first (most overdue first), then new leads nobody has reached, oldest first.
  // Leads whose best time is now come first within each group. Skips booked, waste and do-not-call.
  function queue({ at = new Date(), limit = 50 } = {}) {
    const part = at.getHours() < 12 ? 'Morning' : at.getHours() < 17 ? 'Afternoon' : 'Evening';
    const fits = (l) => (l.best_time ? (l.best_time.includes(part) || l.best_time.includes('Anytime') ? 0 : 1) : 0.5);
    const base = `SELECT l.id, l.full_name, l.first_name, l.last_name, l.phone, l.vehicle_type, l.stage, l.received_at, l.best_time, l.last_contacted_at,
                         (SELECT MIN(r.due_at) FROM reminders r WHERE r.lead_id = l.id AND r.done_at IS NULL) AS due_at
                  FROM leads l
                  WHERE l.archived_at IS NULL AND l.stage NOT IN ('booked', 'waste') AND l.phone_norm IS NOT NULL
                    AND COALESCE(l.last_disposition, '') NOT IN ('do_not_call', 'wrong_number')`;
    const rows = stmt(base).all();
    const due = rows.filter((l) => l.due_at && l.due_at <= at.toISOString()).sort((a, b) => fits(a) - fits(b) || a.due_at.localeCompare(b.due_at));
    const fresh = rows.filter((l) => !l.due_at && !l.last_contacted_at && l.stage === 'new').sort((a, b) => fits(a) - fits(b) || a.received_at.localeCompare(b.received_at));
    return [...due.map((l) => ({ ...l, why: 'Call-back due' })), ...fresh.map((l) => ({ ...l, why: 'New lead' }))].slice(0, limit)
      .map((l) => ({ id: l.id, name: l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone, phone: l.phone, vehicle_type: l.vehicle_type, best_time: l.best_time, why: l.why }));
  }

  // ---- numbers for Analytics ----
  function stats({ start, end }) {
    const rows = stmt("SELECT * FROM calls WHERE started_at >= ? AND started_at < ? AND status != 'failed'").all(start, end);
    const reps = new Map();
    for (const c of rows) {
      const r = reps.get(c.user_name) || { name: c.user_name, calls: 0, connected: 0, talk_seconds: 0, scores: [], flagged: 0, booked: 0 };
      r.calls++;
      if (c.talk_seconds > 0) r.connected++;
      r.talk_seconds += c.talk_seconds || 0;
      if (c.review_score) r.scores.push(c.review_score);
      if (c.flags && c.flags !== '[]') r.flagged++;
      if (c.summary && JSON.parse(c.summary).outcome === 'booked') r.booked++;
      reps.set(c.user_name, r);
    }
    const flagCounts = {};
    for (const c of rows) for (const f of (c.flags ? JSON.parse(c.flags) : [])) flagCounts[f] = (flagCounts[f] || 0) + 1;
    return {
      calls: rows.length,
      connected: rows.filter((c) => c.talk_seconds > 0).length,
      talk_seconds: rows.reduce((n, c) => n + (c.talk_seconds || 0), 0),
      reviewed: rows.filter((c) => c.reviewed_at).length,
      reps: [...reps.values()].map((r) => ({ ...r, avg_score: r.scores.length ? r.scores.reduce((a, b) => a + b, 0) / r.scores.length : null, scores: undefined })).sort((a, b) => b.calls - a.calls),
      flags: Object.entries(flagCounts).map(([flag, n]) => ({ flag, label: FLAGS[flag] || flag, n })).sort((a, b) => b.n - a.n),
    };
  }

  return { configured, start, answerTwiml, noticeTwiml, transcript, dialed, ended, writeNotes, get, forLead, active, list, review, queue, stats, repPhone, setRepPhone, brand };
}

const fmtHour = (h) => new Date(2026, 0, 1, h).toLocaleTimeString('en-US', { hour: 'numeric' });

module.exports = { createCallService };
