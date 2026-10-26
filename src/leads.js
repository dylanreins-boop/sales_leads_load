const { transaction } = require('./db');
const { STAGE_IDS, STAGES, DISPOSITIONS_BY_ID, stageAfterDisposition, tomorrowAt } = require('./pipeline');
const { renderTemplate } = require('./email');
const { VEHICLE_FIELDS, RV_TYPES, pipelineFor, pipelineLabel, isValidYear } = require('./vehicle');
const { cleanServices, serviceLabels, parseServices } = require('./services');

const VEHICLE_KEYS = VEHICLE_FIELDS.map((f) => f.key);
const FIELD_LABELS = {
  heard_about: 'Heard about us', first_name: 'First name', last_name: 'Last name', full_name: 'Name', email: 'Email', phone: 'Phone', message: 'Message',
  ...Object.fromEntries(VEHICLE_FIELDS.map((f) => [f.key, f.label])),
};

// Follow-up email template. Off until the user writes their own and turns it on.
function defaultEmailSettings({ name, city, phone, website, address }) {
  const where = city ? `${name} here in ${city}` : name;
  return {
    followup_email_enabled: 'false',
    followup_email_subject: `Sorry we missed you, {{first_name}} – ${name}`,
    followup_email_body: [
      'Hi {{first_name}},',
      '',
      `This is [your name] with ${where}. I just tried calling about ceramic coating for your {{vehicle}} and left you a voicemail.`,
      '',
      'We use SENSHA-World coating, which is known to last up to eight years.',
      '',
      'I\'d love to walk you through your options and get you a quote. You can call or text me back at '
        + `${phone || '[your number]'}, or just reply to this email with a good time to talk.`,
      '',
      'Thanks,',
      '[Your name]',
      name,
      ...(address ? [address] : []),
      ...(website ? [website] : []),
    ].join('\n'),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const clean = (v) => (v == null ? null : String(v).trim() || null);
const normEmail = (v) => clean(v)?.toLowerCase() ?? null;
// Compare on the last 10 digits so "+1 (555) 123-4567" matches "5551234567".
const normPhone = (v) => {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
};
const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;

function toIso(value, fallback) {
  if (!value) return fallback;
  // Facebook sends "+0000" offsets, which some parsers reject.
  const d = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function displayName(lead) {
  return lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || lead.phone || `Lead #${lead.id}`;
}

// active: on a board. old: aged out without booking. dead: aged out after being marked Waste.
// customer: booked, and their job was picked up a while ago (Past Customers).
function statusOf(lead) {
  if (!lead.archived_at) return 'active';
  if (lead.stage === 'booked') return 'customer';
  return lead.stage === 'waste' ? 'dead' : 'old';
}

function createLeadService(db, { reminderHour = 9, skipWeekends = false, archiveDays = 14, brand = { name: 'Lead Pipeline' } } = {}) {
  const EMAIL_SETTINGS = defaultEmailSettings(brand);
  const stmt = (sql) => db.prepare(sql);

  function logActivity(leadId, type, fields = {}) {
    stmt(`INSERT INTO activities (lead_id, type, disposition, from_stage, to_stage, note, user_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leadId, type, fields.disposition ?? null, fields.from_stage ?? null,
      fields.to_stage ?? null, fields.note ?? null, fields.user ?? null, now(),
    );
  }

  function findExisting({ source, external_id, email_norm, phone_norm }) {
    if (external_id) {
      const exact = stmt('SELECT * FROM leads WHERE source = ? AND external_id = ?').get(source, external_id);
      if (exact) return { lead: exact, exact: true };
    }
    // Same person submitting again (e.g. website form after a Facebook ad).
    // Waste leads are ignored so a returning lead gets a fresh card.
    const match = stmt(`SELECT * FROM leads WHERE stage != 'waste'
                        AND ((? IS NOT NULL AND email_norm = ?) OR (? IS NOT NULL AND phone_norm = ?))
                        ORDER BY id DESC LIMIT 1`).get(email_norm, email_norm, phone_norm, phone_norm);
    return match ? { lead: match, exact: false } : null;
  }

  // Adds a lead from any source, de-duplicating repeat submissions.
  function ingest(input, { user } = {}) {
    const lead = {
      source: input.source || 'manual',
      external_id: clean(input.external_id),
      first_name: clean(input.first_name),
      last_name: clean(input.last_name),
      full_name: clean(input.full_name),
      email: clean(input.email),
      phone: clean(input.phone),
      message: clean(input.message),
      campaign: clean(input.campaign),
      form_name: clean(input.form_name),
      ...Object.fromEntries(VEHICLE_KEYS.map((k) => [k, clean(input[k])])),
      heard_about: clean(input.heard_about),
      sms_opt_in: typeof input.sms_opt_in === 'boolean' ? Number(input.sms_opt_in) : null,
    };
    if (!lead.full_name) lead.full_name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
    lead.email_norm = normEmail(lead.email);
    lead.phone_norm = normPhone(lead.phone);
    if (!lead.full_name && !lead.email && !lead.phone) {
      throw new HttpError(400, 'A lead needs at least a name, email, or phone number.');
    }

    return transaction(db, () => {
      const existing = findExisting(lead);
      if (existing?.exact) return { lead: existing.lead, created: false, duplicate: true };
      if (existing) {
        const note = [`New inquiry via ${lead.source}`, lead.message].filter(Boolean).join(': ');
        logActivity(existing.lead.id, 'reinquiry', { note });
        stmt('UPDATE leads SET updated_at = ? WHERE id = ?').run(now(), existing.lead.id);
        // An old lead that reaches out again goes back on the board as new.
        if (existing.lead.archived_at) {
          const from = existing.lead.stage === 'booked' ? 'Past Customers' : 'Old Leads';
          bringBack(existing.lead, { stage: 'new', note: `Back from ${from}: new inquiry` });
        }
        return { lead: getLead(existing.lead.id), created: false, duplicate: true };
      }

      const ts = now();
      const { lastInsertRowid } = stmt(`INSERT INTO leads
        (source, external_id, first_name, last_name, full_name, email, phone, email_norm, phone_norm,
         message, campaign, form_name, ${VEHICLE_KEYS.join(', ')}, heard_about, sms_opt_in, stage, raw, received_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${VEHICLE_KEYS.map(() => '?').join(', ')}, ?, ?, 'new', ?, ?, ?, ?)`).run(
        lead.source, lead.external_id, lead.first_name, lead.last_name, lead.full_name, lead.email,
        lead.phone, lead.email_norm, lead.phone_norm, lead.message, lead.campaign, lead.form_name,
        ...VEHICLE_KEYS.map((k) => lead[k]), lead.heard_about, lead.sms_opt_in,
        input.raw ? JSON.stringify(input.raw) : null, toIso(input.received_at, ts), ts, ts,
      );
      const id = Number(lastInsertRowid);
      logActivity(id, 'created', { to_stage: 'new', note: `Lead received from ${lead.source}`, user });
      return { lead: getLead(id), created: true, duplicate: false };
    });
  }

  // view: 'active' (the boards), 'old' (Old & Dead Leads) or 'all'.
  function listLeads({ q, source, pipeline, view = 'active', vehicleType, status } = {}) {
    const where = [];
    const params = [];
    if (view === 'active') where.push('l.archived_at IS NULL');
    if (view === 'old') where.push("l.archived_at IS NOT NULL AND l.stage != 'booked'");
    if (view === 'customers') where.push("l.archived_at IS NOT NULL AND l.stage = 'booked'");
    if (status === 'dead') where.push("l.stage = 'waste'");
    if (status === 'old') where.push("l.stage != 'waste'");
    if (vehicleType === 'none') where.push("coalesce(l.vehicle_type, '') = ''");
    else if (vehicleType) {
      where.push('l.vehicle_type = ?');
      params.push(vehicleType);
    }
    if (pipeline === 'rv' || pipeline === 'other') {
      const marks = RV_TYPES.map(() => '?').join(', ');
      where.push(pipeline === 'rv' ? `l.vehicle_type IN (${marks})` : `(l.vehicle_type IS NULL OR l.vehicle_type NOT IN (${marks}))`);
      params.push(...RV_TYPES);
    }
    if (source) {
      where.push('l.source = ?');
      params.push(source);
    }
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(`(lower(l.full_name) LIKE ? OR l.email_norm LIKE ? OR l.phone_norm LIKE ?
                   OR lower(coalesce(l.vehicle_year, '') || ' ' || coalesce(l.vehicle_make, '') || ' ' || coalesce(l.vehicle_model, '')) LIKE ?)`);
      params.push(like, like, `%${q.replace(/\D/g, '') || q}%`, like);
    }
    return stmt(`SELECT l.id, l.source, l.full_name, l.first_name, l.last_name, l.email, l.phone, l.stage,
                        l.vehicle_year, l.vehicle_make, l.vehicle_model, l.vehicle_color, l.vehicle_type, l.booked_services, l.sms_opt_in,
                        l.campaign, l.form_name, l.message, l.heard_about, l.last_disposition, l.last_contacted_at,
                        l.received_at, l.updated_at, l.archived_at,
                        (SELECT MIN(due_at) FROM reminders r WHERE r.lead_id = l.id AND r.done_at IS NULL) AS next_reminder_at,
                        (SELECT COUNT(*) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS jobs_done,
                        (SELECT MAX(j.picked_up_at) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS last_pickup_at,
                        (SELECT SUM(j.amount_cents) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS spent_cents
                 FROM leads l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY l.received_at DESC`).all(...params)
      .map((row) => ({ ...row, booked_services: parseServices(row.booked_services), pipeline: pipelineFor(row.vehicle_type), status: statusOf(row) }));
  }

  function getLead(id) {
    const lead = stmt('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    delete lead.raw;
    lead.booked_services = parseServices(lead.booked_services);
    lead.pipeline = pipelineFor(lead.vehicle_type);
    lead.status = statusOf(lead);
    lead.activities = stmt('SELECT * FROM activities WHERE lead_id = ? ORDER BY id DESC').all(id);
    lead.reminders = stmt('SELECT * FROM reminders WHERE lead_id = ? ORDER BY due_at DESC').all(id);
    lead.emails = stmt('SELECT * FROM emails WHERE lead_id = ? ORDER BY id DESC').all(id);
    lead.quotes = stmt('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC').all(id).map((q) => ({ ...q, lines: JSON.parse(q.lines) }));
    lead.jobs = stmt('SELECT id, start_at, end_at, status, amount_cents, amount_by, amount_at FROM jobs WHERE lead_id = ? ORDER BY start_at DESC').all(id);
    return lead;
  }

  const EDITABLE = ['first_name', 'last_name', 'full_name', 'email', 'phone', 'message', ...VEHICLE_KEYS, 'heard_about'];

  function updateLead(id, patch, { user } = {}) {
    const lead = getLead(id);
    if ('vehicle_year' in patch && !isValidYear(patch.vehicle_year)) {
      throw new HttpError(400, 'Vehicle year should be 4 digits, like 2022.');
    }
    // Editing first/last name keeps the display name in step.
    if (!('full_name' in patch) && ('first_name' in patch || 'last_name' in patch)) {
      const first = 'first_name' in patch ? clean(patch.first_name) : lead.first_name;
      const last = 'last_name' in patch ? clean(patch.last_name) : lead.last_name;
      patch = { ...patch, full_name: [first, last].filter(Boolean).join(' ') || lead.full_name };
    }
    return transaction(db, () => {
      const sets = [];
      const params = [];
      const changes = [];
      for (const field of EDITABLE) {
        if (!(field in patch)) continue;
        const value = clean(patch[field]);
        if (value === (lead[field] ?? null)) continue;
        sets.push(`${field} = ?`);
        params.push(value);
        if (field !== 'full_name' || !('first_name' in patch || 'last_name' in patch)) {
          changes.push(`${FIELD_LABELS[field]}: ${lead[field] || '(blank)'} → ${value || '(blank)'}`);
        }
      }
      if ('sms_opt_in' in patch) {
        const value = patch.sms_opt_in == null ? null : Number(Boolean(patch.sms_opt_in));
        if (value !== lead.sms_opt_in) {
          sets.push('sms_opt_in = ?');
          params.push(value);
          const word = (v) => (v === 1 ? 'yes' : v === 0 ? 'no' : '(unknown)');
          changes.push(`OK to text: ${word(lead.sms_opt_in)} → ${word(value)}`);
        }
      }
      if ('booked_services' in patch) {
        const services = cleanServices(patch.booked_services);
        if (services.join() !== lead.booked_services.join()) {
          sets.push('booked_services = ?');
          params.push(JSON.stringify(services));
          changes.push(`Services booked: ${serviceLabels(lead.booked_services) || '(none)'} → ${serviceLabels(services) || '(none)'}`);
        }
      }
      if ('vehicle_type' in patch && pipelineFor(clean(patch.vehicle_type)) !== lead.pipeline) {
        changes.push(`Moved to ${pipelineLabel(pipelineFor(clean(patch.vehicle_type)))}`);
      }
      if (changes.length) logActivity(id, 'info_updated', { note: changes.join('\n'), user });
      if ('email' in patch) {
        sets.push('email_norm = ?');
        params.push(normEmail(patch.email));
      }
      if ('phone' in patch) {
        sets.push('phone_norm = ?');
        params.push(normPhone(patch.phone));
      }
      if (patch.stage && patch.stage !== lead.stage) {
        if (!STAGE_IDS.has(patch.stage)) throw new HttpError(400, `Unknown stage: ${patch.stage}`);
        sets.push('stage = ?');
        params.push(patch.stage);
        logActivity(id, 'stage_change', { from_stage: lead.stage, to_stage: patch.stage, user });
      }
      if (sets.length) {
        sets.push('updated_at = ?');
        params.push(now(), id);
        stmt(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      return getLead(id);
    });
  }

  // Records a call outcome, moves the lead to the matching stage, and
  // (by default) schedules a reminder to call again tomorrow.
  function dispositionLead(id, { disposition, note, reminder, reminder_at, services } = {}, { user } = {}) {
    const def = DISPOSITIONS_BY_ID[disposition];
    if (!def) throw new HttpError(400, `Unknown disposition: ${disposition}`);
    if (!clean(note)) throw new HttpError(400, 'Add a note about this call before saving.');
    const booked = def.services ? cleanServices(services) : null;
    if (booked && !booked.length) throw new HttpError(400, 'Pick at least one service for this booking.');
    const lead = getLead(id);
    const toStage = stageAfterDisposition(lead.stage, def);
    const wantReminder = reminder ?? def.reminder;
    let dueAt = null;
    if (wantReminder) {
      const due = reminder_at ? new Date(reminder_at) : tomorrowAt(reminderHour, new Date(), { skipWeekends });
      if (Number.isNaN(due.getTime())) throw new HttpError(400, 'Invalid reminder time');
      dueAt = due.toISOString();
    }

    return transaction(db, () => {
      const ts = now();
      // A note on a past customer stays a note; a call or a new booking puts them back on the board.
      if (lead.archived_at && !(lead.stage === 'booked' && toStage === 'booked' && !def.schedules)) {
        bringBack(lead, { stage: lead.stage, note: 'Back on the board: call logged', user });
      }
      const contactedAt = def.call === false ? lead.last_contacted_at : ts;
      stmt(`UPDATE leads SET stage = ?, last_disposition = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?`)
        .run(toStage, def.id, contactedAt, ts, id);
      if (booked) stmt('UPDATE leads SET booked_services = ? WHERE id = ?').run(JSON.stringify(booked), id);
      const fullNote = booked ? `Services booked: ${serviceLabels(booked)}\n${clean(note)}` : clean(note);
      logActivity(id, 'disposition', {
        disposition: def.id, from_stage: lead.stage, to_stage: toStage, note: fullNote, user,
      });
      // The call just happened, so any earlier reminders are satisfied.
      stmt('UPDATE reminders SET done_at = ? WHERE lead_id = ? AND done_at IS NULL').run(ts, id);
      let created = null;
      if (dueAt) {
        const text = `Call ${displayName(lead)} (${def.label} → ${stageLabel(toStage)})`;
        const { lastInsertRowid } = stmt('INSERT INTO reminders (lead_id, due_at, note, created_at) VALUES (?, ?, ?, ?)')
          .run(id, dueAt, text, ts);
        created = stmt('SELECT * FROM reminders WHERE id = ?').get(Number(lastInsertRowid));
      }
      return { lead: getLead(id), reminder: created };
    });
  }

  function addNote(id, note, { user } = {}) {
    getLead(id);
    if (!clean(note)) throw new HttpError(400, 'Note is empty');
    logActivity(id, 'note', { note: clean(note), user });
    stmt('UPDATE leads SET updated_at = ? WHERE id = ?').run(now(), id);
    return getLead(id);
  }

  // Moves leads that came in more than `archiveDays` ago (or were restored that long ago)
  // off the boards. Booked leads stay. Their open reminders are closed.
  function archiveOldLeads(at = new Date()) {
    const cutoff = new Date(at.getTime() - archiveDays * 86400000).toISOString();
    const due = stmt(`SELECT id, stage FROM leads WHERE archived_at IS NULL AND stage != 'booked'
                      AND coalesce(restored_at, received_at) < ?`).all(cutoff);
    // Booked customers move to Past Customers once their last job was picked up that long ago
    // and nothing else is on the calendar for them.
    const done = stmt(`SELECT l.id, l.stage FROM leads l WHERE l.archived_at IS NULL AND l.stage = 'booked'
                       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = l.id AND j.status NOT IN ('picked_up', 'cancelled'))
                       AND (SELECT MAX(j.picked_up_at) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') < ?
                       AND coalesce(l.restored_at, '') < ?`).all(cutoff, cutoff);
    if (!due.length && !done.length) return 0;
    transaction(db, () => {
      const ts = at.toISOString();
      for (const lead of [...due, ...done]) {
        stmt('UPDATE leads SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, lead.id);
        stmt('UPDATE reminders SET done_at = ? WHERE lead_id = ? AND done_at IS NULL').run(ts, lead.id);
        const note = lead.stage === 'booked'
          ? `Moved to Past Customers ${archiveDays} days after pick-up`
          : `Moved to ${lead.stage === 'waste' ? 'Dead Leads (marked Waste)' : 'Old Leads'} after ${archiveDays} days without a booking`;
        logActivity(lead.id, 'archived', { note });
      }
    });
    return due.length + done.length;
  }

  function bringBack(lead, { stage, note, user }) {
    const ts = now();
    const toStage = stage || (lead.stage === 'waste' ? 'new' : lead.stage);
    stmt('UPDATE leads SET archived_at = NULL, restored_at = ?, stage = ?, updated_at = ? WHERE id = ?').run(ts, toStage, ts, lead.id);
    logActivity(lead.id, 'restored', { from_stage: lead.stage, to_stage: toStage, note, user });
  }

  // Puts an old or dead lead back on its pipeline for another `archiveDays` days.
  function restoreLead(id, { user } = {}) {
    const lead = getLead(id);
    if (!lead.archived_at) throw new HttpError(400, 'This lead is already on the board.');
    // A past customer comes back as a fresh lead to call about their next job.
    const customer = lead.stage === 'booked';
    transaction(db, () => bringBack(lead, customer
      ? { stage: 'new', note: 'Back on the board: repeat customer', user }
      : { note: 'Restored to the pipeline', user }));
    return getLead(id);
  }

  // ---- Updates feed for admins: every change by anyone, newest first ----
  const seenKey = (user) => `updates_seen:${user || 'admin'}`;
  const lastActivityId = () => stmt('SELECT MAX(id) AS id FROM activities').get().id || 0;
  function seenId(user) {
    const row = stmt('SELECT value FROM settings WHERE key = ?').get(seenKey(user));
    if (row) return Number(row.value) || 0;
    // A new admin starts caught up rather than with the whole history marked new.
    markUpdatesSeen(user);
    return lastActivityId();
  }

  function listUpdates({ before = null, limit = 100, user } = {}) {
    const rows = stmt(`SELECT a.*, l.full_name, l.first_name, l.last_name, l.phone, l.vehicle_type, l.source,
                         (SELECT j.id FROM jobs j WHERE j.lead_id = a.lead_id ORDER BY j.start_at DESC LIMIT 1) AS job_id,
                         (SELECT j.start_at FROM jobs j WHERE j.lead_id = a.lead_id ORDER BY j.start_at DESC LIMIT 1) AS job_start
                       FROM activities a JOIN leads l ON l.id = a.lead_id
                       ${before ? 'WHERE a.id < ?' : ''}
                       ORDER BY a.id DESC LIMIT ?`).all(...(before ? [before] : []), Math.min(Math.max(limit, 1), 300));
    return { updates: rows, seenId: seenId(user) };
  }

  // Changes since this admin last opened the feed, not counting their own.
  function countUnseenUpdates(user) {
    return stmt("SELECT COUNT(*) AS n FROM activities WHERE id > ? AND coalesce(user_name, '') != ?").get(seenId(user), user || '').n;
  }

  function markUpdatesSeen(user) {
    stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(seenKey(user), String(lastActivityId()));
    return { ok: true };
  }

  // Every lead matching the filters, with its full activity history (for Excel export).
  function exportLeads(filters = {}) {
    const rows = listLeads({ ...filters, view: filters.view || 'all' });
    const wanted = new Set(rows.map((r) => r.id));
    const history = new Map();
    for (const a of stmt('SELECT * FROM activities ORDER BY lead_id, id').all()) {
      if (!wanted.has(a.lead_id)) continue;
      if (!history.has(a.lead_id)) history.set(a.lead_id, []);
      history.get(a.lead_id).push(a);
    }
    // Latest shop job per lead, with checklist progress and photo count.
    const jobs = new Map();
    for (const j of stmt(`SELECT j.*, (SELECT COUNT(*) FROM job_checklist c WHERE c.job_id = j.id) AS checklist_total,
                            (SELECT COUNT(*) FROM job_checklist c WHERE c.job_id = j.id AND c.done_at IS NOT NULL) AS checklist_done,
                            (SELECT COUNT(*) FROM job_photos p WHERE p.job_id = j.id) AS photo_count
                          FROM jobs j ORDER BY j.start_at`).all()) {
      if (wanted.has(j.lead_id)) jobs.set(j.lead_id, j);
    }
    return rows.map((r) => ({ ...r, activities: history.get(r.id) || [], job: jobs.get(r.id) || null }));
  }

  function listReminders({ status = 'open' } = {}) {
    return stmt(`SELECT r.*, l.full_name, l.first_name, l.last_name, l.email, l.phone, l.stage, l.vehicle_type
                 FROM reminders r JOIN leads l ON l.id = r.lead_id
                 ${status === 'open' ? 'WHERE r.done_at IS NULL' : ''}
                 ORDER BY r.due_at ASC`).all()
      .map((row) => ({ ...row, pipeline: pipelineFor(row.vehicle_type) }));
  }

  function getReminder(id) {
    const r = stmt('SELECT * FROM reminders WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reminder not found');
    return r;
  }

  function completeReminder(id, { user } = {}) {
    const r = getReminder(id);
    if (!r.done_at) {
      stmt('UPDATE reminders SET done_at = ? WHERE id = ?').run(now(), id);
      logActivity(r.lead_id, 'reminder_done', { note: r.note, user });
    }
    return getReminder(id);
  }

  function snoozeReminder(id, dueAt) {
    getReminder(id);
    const due = new Date(dueAt);
    if (Number.isNaN(due.getTime())) throw new HttpError(400, 'Invalid reminder time');
    stmt('UPDATE reminders SET due_at = ?, done_at = NULL WHERE id = ?').run(due.toISOString(), id);
    return getReminder(id);
  }

  function getEmailSettings() {
    const rows = stmt("SELECT key, value FROM settings WHERE key LIKE 'followup_email_%'").all();
    const s = { ...EMAIL_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    return { enabled: s.followup_email_enabled === 'true', subject: s.followup_email_subject, body: s.followup_email_body };
  }

  function saveEmailSettings({ enabled, subject, body }) {
    if (enabled && (!clean(subject) || !clean(body))) {
      throw new HttpError(400, 'Write a subject and a message before turning the email on.');
    }
    const save = stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    transaction(db, () => {
      save.run('followup_email_enabled', enabled ? 'true' : 'false');
      if (subject != null) save.run('followup_email_subject', String(subject));
      if (body != null) save.run('followup_email_body', String(body));
    });
    return getEmailSettings();
  }

  // The follow-up email this disposition should send, or null if it shouldn't send one.
  function followUpEmailFor(id, dispositionId) {
    const settings = getEmailSettings();
    const lead = getLead(id);
    if (!DISPOSITIONS_BY_ID[dispositionId]?.email || !settings.enabled || !lead.email) return null;
    return { to: lead.email, subject: renderTemplate(settings.subject, lead), text: renderTemplate(settings.body, lead) };
  }

  // Leads that came in during [from, to), with whether they booked and what their jobs brought in.
  function sourceReport({ from, to } = {}) {
    const start = toIso(from, null);
    const end = toIso(to, null);
    if (!start || !end) throw new HttpError(400, 'Pick a date range.');
    return stmt(`SELECT l.id, l.source, l.heard_about, l.stage, l.vehicle_type, l.received_at,
                   (l.stage = 'booked' OR EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled')) AS booked,
                   (SELECT SUM(j.amount_cents) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS revenue_cents
                 FROM leads l WHERE l.received_at >= ? AND l.received_at < ?
                 ORDER BY l.received_at`).all(start, end)
      .map((r) => ({ ...r, booked: Boolean(r.booked), pipeline: pipelineFor(r.vehicle_type) }));
  }

  function recordEmail(leadId, message, { status, error, trigger, user, label = 'Follow-up email' }) {
    stmt(`INSERT INTO emails (lead_id, to_email, subject, body, status, error, trigger, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      leadId, message.to, message.subject, message.text, status, error ?? null, trigger ?? null, now(),
    );
    const what = status === 'sent' ? `${label} sent to ${message.to}` : `${label} to ${message.to} not sent: ${error}`;
    logActivity(leadId, 'email', { note: what, user });
    return stmt('SELECT * FROM emails WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(leadId);
  }

  return {
    ingest, listLeads, getLead, updateLead, dispositionLead, addNote,
    listReminders, completeReminder, snoozeReminder,
    getEmailSettings, saveEmailSettings, followUpEmailFor, recordEmail, sourceReport,
    archiveOldLeads, restoreLead, exportLeads, logActivity, listUpdates, countUnseenUpdates, markUpdatesSeen,
  };
}

module.exports = { createLeadService, HttpError, toIso };
