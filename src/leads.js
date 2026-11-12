const { transaction } = require('./db');
const { STAGE_IDS, STAGES, DISPOSITIONS_BY_ID, stageAfterDisposition, tomorrowAt } = require('./pipeline');
const { renderTemplate } = require('./email');
const { VEHICLE_FIELDS, PIPELINES, typesFor, claimedTypes, pipelineFor, pipelineLabel, isValidYear } = require('./vehicle');
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
// Stages where a lead is still being worked (not booked, not waste).
const OPEN_STAGES = ['new', 'voicemail', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'contacted'];
// The newest text from the customer, not counting STOP / START (those change texting, they need no answer).
const LAST_REPLY_SQL = `(SELECT MAX(t.created_at) FROM texts t WHERE t.lead_id = l.id AND t.direction = 'in'
  AND lower(trim(t.body, ' .!')) NOT IN ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'start', 'unstop'))`;
// A customer texted and nobody has called or texted them back since (a rep's own text counts as contact).
const needsReply = (l) => Boolean(l.last_reply_at) && !l.archived_at && !(l.last_contacted_at >= l.last_reply_at);
// Being worked, talked to, and nothing planned next (no call reminder).
const noNextStep = (l) => !l.archived_at && OPEN_STAGES.includes(l.stage) && Boolean(l.last_contacted_at) && !l.next_reminder_at;

function statusOf(lead) {
  if (!lead.archived_at) return 'active';
  if (lead.stage === 'booked') return 'customer';
  return lead.stage === 'waste' ? 'dead' : 'old';
}

function createLeadService(db, { reminderHour = 9, skipWeekends = false, archiveDays = 14, brand = { name: 'Lead Pipeline' } } = {}) {
  const EMAIL_SETTINGS = defaultEmailSettings(brand);
  const stmt = (sql) => db.prepare(sql);
  // Lets the server add deposit and commission figures to a lead's jobs.
  let decorateJob = (job) => job;
  const setJobDecorator = (fn) => { decorateJob = fn; };
  // Called with each brand-new lead (the server uses it for new-lead alerts).
  let onCreated = () => {};
  const setCreatedHook = (fn) => { onCreated = fn; };

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
  // `silent` (imports) skips the new-lead hook, so old leads don't set off alerts.
  function ingest(input, { user, silent = false } = {}) {
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

    const result = transaction(db, () => {
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
      // Where a website lead came from: the ad tags in the link, the page with the form, the site before it.
      const from = ['utm_source', 'utm_medium', 'utm_content', 'utm_term', 'landing_page', 'referrer_url'];
      if (from.some((k) => input[k])) {
        stmt(`UPDATE leads SET ${from.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...from.map((k) => (input[k] ? String(input[k]).slice(0, 300) : null)), id);
      }
      logActivity(id, 'created', { to_stage: 'new', note: `Lead received from ${lead.source}`, user });
      return { lead: getLead(id), created: true, duplicate: false };
    });
    if (result.created && !silent) {
      try { onCreated(result.lead); } catch (err) { console.error('New-lead hook failed:', err.message); }
    }
    return result;
  }

  // view: 'active' (the boards), 'old' (Old & Dead Leads) or 'all'.
  function listLeads({ q, source, pipeline, view = 'active', vehicleType, status } = {}) {
    const where = [];
    const params = [];
    if (view === 'active') where.push('l.archived_at IS NULL');
    if (view === 'old') where.push("l.archived_at IS NOT NULL AND l.stage != 'booked'");
    if (view === 'customers') where.push("l.archived_at IS NOT NULL AND l.stage = 'booked'");
    if (view === 'imported') where.push('l.import_batch IS NOT NULL');
    if (status === 'dead') where.push("l.stage = 'waste'");
    if (status === 'old') where.push("l.stage != 'waste'");
    if (vehicleType === 'none') where.push("coalesce(l.vehicle_type, '') = ''");
    else if (vehicleType) {
      where.push('l.vehicle_type = ?');
      params.push(vehicleType);
    }
    if (pipeline && PIPELINES.some((p) => p.id === pipeline)) {
      // A pipeline is its vehicle types; "other" is every type no other pipeline claims.
      const types = pipeline === 'other' ? claimedTypes() : typesFor(pipeline);
      const marks = types.map(() => '?').join(', ') || "''";
      where.push(pipeline === 'other' ? `(l.vehicle_type IS NULL OR l.vehicle_type NOT IN (${marks}))` : `l.vehicle_type IN (${marks})`);
      params.push(...types);
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
                        l.last_contact_by, l.last_contact_kind, l.last_opened_at, l.last_opened_by,
                        l.welcome_due_at, l.welcome_sent_at, l.best_time, l.best_time_note, l.best_time_by,
                        l.received_at, l.updated_at, l.archived_at, l.first_contacted_at, l.referrer_id, l.import_batch,
                        (SELECT b.file FROM import_batches b WHERE b.id = l.import_batch) AS import_file,
                        (SELECT b.created_at FROM import_batches b WHERE b.id = l.import_batch) AS imported_at,
                        (SELECT MIN(due_at) FROM reminders r WHERE r.lead_id = l.id AND r.done_at IS NULL) AS next_reminder_at,
                        ${LAST_REPLY_SQL} AS last_reply_at,
                        (SELECT COUNT(*) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS jobs_done,
                        (SELECT MAX(j.picked_up_at) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS last_pickup_at,
                        (SELECT SUM(j.amount_cents) FROM jobs j WHERE j.lead_id = l.id AND j.status = 'picked_up') AS spent_cents
                 FROM leads l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY l.received_at DESC`).all(...params)
      .map((row) => ({ ...row, booked_services: parseServices(row.booked_services), pipeline: pipelineFor(row.vehicle_type), status: statusOf(row),
        needs_reply: needsReply(row), no_next_step: noNextStep(row) }));
  }

  // The to-do list: what needs someone now, most urgent first. Customer replies nobody has answered,
  // new leads not called yet, quotes with no answer, and leads being worked with nothing planned next.
  // (Call reminders come from listReminders.)
  function workQueue({ quoteDays = 2 } = {}) {
    const active = listLeads({ view: 'active' }).filter((l) => l.stage !== 'booked' || l.needs_reply);
    const pick = (l) => ({
      id: l.id, full_name: l.full_name, first_name: l.first_name, last_name: l.last_name, phone: l.phone, email: l.email, stage: l.stage, pipeline: l.pipeline,
      vehicle_year: l.vehicle_year, vehicle_make: l.vehicle_make, vehicle_model: l.vehicle_model, vehicle_type: l.vehicle_type,
      received_at: l.received_at, last_disposition: l.last_disposition, last_contacted_at: l.last_contacted_at, last_contact_by: l.last_contact_by,
      last_contact_kind: l.last_contact_kind, next_reminder_at: l.next_reminder_at, best_time: l.best_time, last_reply_at: l.last_reply_at,
    });
    const replies = active.filter((l) => l.needs_reply)
      .map((l) => ({ ...pick(l), reply: stmt("SELECT body FROM texts WHERE lead_id = ? AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1").get(l.id)?.body ?? '' }))
      .sort((a, b) => a.last_reply_at.localeCompare(b.last_reply_at));
    const seen = new Set(replies.map((l) => l.id));
    const fresh = active.filter((l) => !seen.has(l.id) && l.stage === 'new' && !l.last_contacted_at)
      .sort((a, b) => a.received_at.localeCompare(b.received_at)).map(pick);
    fresh.forEach((l) => seen.add(l.id));
    const cutoff = new Date(Date.now() - quoteDays * 86400000).toISOString();
    const quotes = active.filter((l) => !seen.has(l.id) && OPEN_STAGES.includes(l.stage) && !l.next_reminder_at)
      .map((l) => ({ l, q: stmt('SELECT id, total_cents, created_at, emailed_at FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id) }))
      .filter(({ l, q }) => q && (q.emailed_at || q.created_at) < cutoff && !(l.last_contacted_at > (q.emailed_at || q.created_at)))
      .map(({ l, q }) => ({ ...pick(l), quote: { total_cents: q.total_cents, sent_at: q.emailed_at || q.created_at } }))
      .sort((a, b) => a.quote.sent_at.localeCompare(b.quote.sent_at));
    quotes.forEach((l) => seen.add(l.id));
    const stuck = active.filter((l) => !seen.has(l.id) && l.no_next_step)
      .sort((a, b) => a.last_contacted_at.localeCompare(b.last_contacted_at)).map(pick);
    return { replies, fresh, quotes, stuck };
  }

  // The search box: every lead, working, past customers, old and dead, best matches first (names
  // that start with what was typed, then the newest), with the basics to tell them apart.
  function searchLeads(q, { limit = 12 } = {}) {
    const text = String(q || '').trim();
    if (text.length < 2 && !/\d/.test(text)) return { results: [], total: 0 };
    const rows = listLeads({ q: text, view: 'all' });
    const t = text.toLowerCase();
    const score = (l) => {
      const name = (l.full_name || '').toLowerCase();
      if (name.startsWith(t)) return 0;
      if (name.split(/\s+/).some((w) => w.startsWith(t))) return 1;
      return 2;
    };
    const ranked = rows.map((l, i) => ({ l, s: score(l), i })).sort((a, b) => a.s - b.s || a.i - b.i).slice(0, limit).map((x) => x.l);
    return {
      total: rows.length,
      results: ranked.map((l) => ({
        id: l.id, full_name: l.full_name, first_name: l.first_name, last_name: l.last_name, phone: l.phone, email: l.email,
        vehicle_year: l.vehicle_year, vehicle_make: l.vehicle_make, vehicle_model: l.vehicle_model, vehicle_color: l.vehicle_color, vehicle_type: l.vehicle_type,
        stage: l.stage, status: l.status, pipeline: l.pipeline, source: l.source, received_at: l.received_at,
        last_contacted_at: l.last_contacted_at, next_reminder_at: l.next_reminder_at, jobs_done: l.jobs_done, last_pickup_at: l.last_pickup_at,
      })),
    };
  }

  // Someone opened the lead.
  function markOpened(id, { user } = {}) {
    stmt('UPDATE leads SET last_opened_at = ?, last_opened_by = ? WHERE id = ?').run(now(), user ?? null, id);
  }

  // A rep reached out some other way than a logged call (a text they sent).
  function markContacted(id, { user, kind }) {
    const ts = now();
    stmt('UPDATE leads SET last_contacted_at = ?, last_contact_by = ?, last_contact_kind = ?, first_contacted_at = COALESCE(first_contacted_at, ?) WHERE id = ?').run(ts, user ?? null, kind, ts, id);
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
    lead.texts = stmt('SELECT * FROM texts WHERE lead_id = ? ORDER BY id').all(id);
    lead.referral_code = stmt("SELECT code FROM referrers WHERE kind = 'customer' AND lead_id = ?").get(id)?.code ?? null;
    lead.referred_by = lead.referrer_id ? stmt('SELECT name, kind FROM referrers WHERE id = ?').get(lead.referrer_id) ?? null : null;
    lead.booking_links = stmt('SELECT id, token, amount_cents, deposit_cents, work_hours, created_by, created_at, expires_at, cancelled_at, job_id, booked_at, deposit_paid_at FROM booking_links WHERE lead_id = ? ORDER BY id DESC').all(id);
    lead.quotes = stmt('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC').all(id).map((q) => ({ ...q, lines: JSON.parse(q.lines) }));
    lead.jobs = stmt('SELECT * FROM jobs WHERE lead_id = ? ORDER BY start_at DESC').all(id).map((j) => decorateJob(j));
    lead.last_reply_at = stmt(`SELECT ${LAST_REPLY_SQL} AS at FROM leads l WHERE l.id = ?`).get(id).at;
    lead.next_reminder_at = lead.reminders.filter((r) => !r.done_at).map((r) => r.due_at).sort()[0] ?? null;
    lead.needs_reply = needsReply(lead);
    lead.no_next_step = noNextStep(lead);
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
      // A rep sets the best time to reach them (when the customer said so on the phone).
      if ('best_time' in patch) {
        const value = clean(patch.best_time)?.slice(0, 60) ?? null;
        if (value !== (lead.best_time ?? null)) {
          sets.push('best_time = ?', 'best_time_note = NULL', 'best_time_by = ?', 'best_time_at = ?');
          params.push(value, value ? user ?? 'rep' : null, value ? now() : null);
          changes.push(`Best time to reach: ${lead.best_time || '(blank)'} → ${value || '(blank)'}`);
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
      const call = def.call !== false;
      stmt(`UPDATE leads SET stage = ?, last_disposition = ?, last_contacted_at = ?, last_contact_by = ?, last_contact_kind = ?,
            first_contacted_at = COALESCE(first_contacted_at, ?), updated_at = ? WHERE id = ?`)
        .run(toStage, def.id, call ? ts : lead.last_contacted_at, call ? user ?? null : lead.last_contact_by, call ? 'call' : lead.last_contact_kind, call ? ts : null, ts, id);
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

  // Already sold: every lead at Booked, on the board or in Past Customers (imported ones too), with when it
  // was sold, who sold it and its job. `rep`: only that rep's sales (sales logins see their own).
  function soldLeads({ rep = null } = {}) {
    const rows = stmt(`SELECT l.id, l.full_name, l.first_name, l.last_name, l.phone, l.email, l.source, l.vehicle_year, l.vehicle_make, l.vehicle_model,
        l.vehicle_color, l.vehicle_type, l.booked_services, l.archived_at, l.import_batch, l.received_at, l.stage,
        l.sold_at AS marked_sold_at, l.sold_by AS marked_sold_by, l.sold_cents AS marked_sold_cents,
        (SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id AND (a.to_stage = 'booked' OR a.disposition = 'booked')) AS booked_activity_at,
        (SELECT a.user_name FROM activities a WHERE a.lead_id = l.id AND (a.to_stage = 'booked' OR a.disposition = 'booked') ORDER BY a.id DESC LIMIT 1) AS booked_by,
        (SELECT MIN(j.created_at) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS first_job_at,
        (SELECT COUNT(*) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS job_count,
        (SELECT SUM(j.amount_cents) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS amount_cents,
        (SELECT j.id FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled' ORDER BY j.start_at DESC LIMIT 1) AS job_id,
        (SELECT j.start_at FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled' ORDER BY j.start_at DESC LIMIT 1) AS job_start,
        (SELECT j.status FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled' ORDER BY j.start_at DESC LIMIT 1) AS job_status,
        (SELECT coalesce(j.commission_rep, j.created_by) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled' ORDER BY j.created_at LIMIT 1) AS job_rep
      FROM leads l WHERE l.stage = 'booked' ORDER BY l.received_at DESC`).all();
    const out = rows.map((r) => ({
      ...r,
      booked_services: parseServices(r.booked_services),
      // Sold = when the job was first put on the calendar, or the sale an admin recorded (Mark as sold), or
      // when the lead was marked Booked; an imported sale, when it came in.
      sold_at: r.first_job_at || r.marked_sold_at || r.booked_activity_at || r.received_at,
      sold_by: r.job_rep || r.marked_sold_by || r.booked_by || null,
      amount_cents: r.amount_cents ?? r.marked_sold_cents ?? null,
      imported: Boolean(r.import_batch),
      pipeline: pipelineFor(r.vehicle_type),
    }));
    return rep ? out.filter((r) => r.sold_by === rep) : out;
  }

  // Several leads at once (the Imported tab): put them on the board, move them to a stage, or take them
  // off the board (to Old & Dead Leads, or Past Customers if booked). Each lead's history notes it.
  // `sold` (admins only): mark them sold (Booked), with when (`sold_on`: 'received' = when each came in, 'today',
  // or a YYYY-MM-DD date), who sold them and, for one lead, the amount. They then show on the Sold page.
  function bulkUpdate({ ids, action, stage, sold_on: soldOn = 'received', sold_by: soldByIn = null, amount = null } = {}, { user, role } = {}) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
    if (!list.length) throw new HttpError(400, 'Pick some leads first.');
    if (list.length > 5000) throw new HttpError(400, 'Pick 5,000 or fewer at a time.');
    if (!['board', 'stage', 'off', 'sold'].includes(action)) throw new HttpError(400, 'Pick what to do with them.');
    if (action === 'stage' && !STAGE_IDS.has(stage)) throw new HttpError(400, `Unknown stage: ${stage}`);
    let soldCents = null;
    let soldDate = null;
    let soldBy = null;
    if (action === 'sold') {
      if (role !== 'admin') throw new HttpError(403, 'Only admins can mark leads as sold.');
      if (!['received', 'today'].includes(soldOn)) {
        const d = new Date(`${soldOn}T12:00:00`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(soldOn)) || Number.isNaN(d.getTime())) throw new HttpError(400, 'Pick when they were sold.');
        if (d.getTime() > Date.now() + 86400000) throw new HttpError(400, 'The sold date can\'t be in the future.');
        soldDate = d.toISOString();
      }
      if (amount !== null && amount !== undefined && String(amount).trim() !== '') {
        const dollars = Number(String(amount).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1000000) throw new HttpError(400, 'Type the amount in dollars, like 1895.');
        if (list.length > 1) throw new HttpError(400, 'An amount can only be set on one lead at a time.');
        soldCents = Math.round(dollars * 100);
      }
      soldBy = soldByIn ? String(soldByIn).trim().slice(0, 80) || null : null;
    }
    let changed = 0;
    transaction(db, () => {
      const ts = now();
      for (const id of list) {
        const lead = stmt('SELECT id, stage, archived_at FROM leads WHERE id = ?').get(id);
        if (!lead) continue;
        if (action === 'sold') {
          const { received_at: receivedAt } = stmt('SELECT received_at FROM leads WHERE id = ?').get(id);
          const at = soldOn === 'today' ? ts : soldDate || receivedAt || ts;
          stmt("UPDATE leads SET stage = 'booked', sold_at = ?, sold_by = ?, sold_cents = ?, updated_at = ? WHERE id = ?").run(at, soldBy, soldCents, ts, id);
          logActivity(id, 'stage_change', {
            from_stage: lead.stage,
            to_stage: 'booked',
            note: `Marked as sold${soldBy ? ` by ${soldBy}` : ''} (sold ${at.slice(0, 10)}${soldCents != null ? `, $${(soldCents / 100).toLocaleString('en-US')}` : ''})`,
            user,
          });
        } else if (action === 'board') {
          if (!lead.archived_at) continue;
          bringBack(lead, { note: 'Put on the board (from the Imported leads)', user });
        } else if (action === 'off') {
          if (lead.archived_at) continue;
          stmt('UPDATE leads SET archived_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
          stmt('UPDATE reminders SET done_at = ? WHERE lead_id = ? AND done_at IS NULL').run(ts, id);
          logActivity(id, 'archived', { note: `Taken off the board (from the Imported leads) to ${lead.stage === 'booked' ? 'Past Customers' : 'Old & Dead Leads'}`, user });
        } else {
          if (lead.stage === stage) continue;
          stmt('UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?').run(stage, ts, id);
          logActivity(id, 'stage_change', { from_stage: lead.stage, to_stage: stage, note: `Moved to ${stageLabel(stage)} (from the Imported leads)`, user });
        }
        changed += 1;
      }
    });
    return { changed, unchanged: list.length - changed };
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
    searchLeads, ingest, listLeads, workQueue, getLead, markOpened, markContacted, updateLead, dispositionLead, addNote,
    listReminders, completeReminder, snoozeReminder,
    getEmailSettings, saveEmailSettings, followUpEmailFor, recordEmail, sourceReport,
    archiveOldLeads, restoreLead, bulkUpdate, soldLeads, exportLeads, logActivity, setJobDecorator, setCreatedHook, listUpdates, countUnseenUpdates, markUpdatesSeen,
  };
}

module.exports = { createLeadService, HttpError, toIso };
