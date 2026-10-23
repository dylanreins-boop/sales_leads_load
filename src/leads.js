const { transaction } = require('./db');
const { STAGE_IDS, STAGES, DISPOSITIONS_BY_ID, stageAfterDisposition, tomorrowAt } = require('./pipeline');

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

function createLeadService(db, { reminderHour = 9 } = {}) {
  const stmt = (sql) => db.prepare(sql);

  function logActivity(leadId, type, fields = {}) {
    stmt(`INSERT INTO activities (lead_id, type, disposition, from_stage, to_stage, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      leadId, type, fields.disposition ?? null, fields.from_stage ?? null,
      fields.to_stage ?? null, fields.note ?? null, now(),
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
  function ingest(input) {
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
        return { lead: getLead(existing.lead.id), created: false, duplicate: true };
      }

      const ts = now();
      const { lastInsertRowid } = stmt(`INSERT INTO leads
        (source, external_id, first_name, last_name, full_name, email, phone, email_norm, phone_norm,
         message, campaign, form_name, stage, raw, received_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`).run(
        lead.source, lead.external_id, lead.first_name, lead.last_name, lead.full_name, lead.email,
        lead.phone, lead.email_norm, lead.phone_norm, lead.message, lead.campaign, lead.form_name,
        input.raw ? JSON.stringify(input.raw) : null, toIso(input.received_at, ts), ts, ts,
      );
      const id = Number(lastInsertRowid);
      logActivity(id, 'created', { to_stage: 'new', note: `Lead received from ${lead.source}` });
      return { lead: getLead(id), created: true, duplicate: false };
    });
  }

  function listLeads({ q, source } = {}) {
    const where = [];
    const params = [];
    if (source) {
      where.push('l.source = ?');
      params.push(source);
    }
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push('(lower(l.full_name) LIKE ? OR l.email_norm LIKE ? OR l.phone_norm LIKE ?)');
      params.push(like, like, `%${q.replace(/\D/g, '') || q}%`);
    }
    return stmt(`SELECT l.id, l.source, l.full_name, l.first_name, l.last_name, l.email, l.phone, l.stage,
                        l.campaign, l.last_disposition, l.last_contacted_at, l.received_at, l.updated_at,
                        (SELECT MIN(due_at) FROM reminders r WHERE r.lead_id = l.id AND r.done_at IS NULL) AS next_reminder_at
                 FROM leads l ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY l.received_at DESC`).all(...params);
  }

  function getLead(id) {
    const lead = stmt('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    delete lead.raw;
    lead.activities = stmt('SELECT * FROM activities WHERE lead_id = ? ORDER BY id DESC').all(id);
    lead.reminders = stmt('SELECT * FROM reminders WHERE lead_id = ? ORDER BY due_at DESC').all(id);
    return lead;
  }

  const EDITABLE = ['first_name', 'last_name', 'full_name', 'email', 'phone', 'message'];

  function updateLead(id, patch) {
    const lead = getLead(id);
    return transaction(db, () => {
      const sets = [];
      const params = [];
      for (const field of EDITABLE) {
        if (field in patch) {
          sets.push(`${field} = ?`);
          params.push(clean(patch[field]));
        }
      }
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
        logActivity(id, 'stage_change', { from_stage: lead.stage, to_stage: patch.stage });
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
  function dispositionLead(id, { disposition, note, reminder, reminder_at } = {}) {
    const def = DISPOSITIONS_BY_ID[disposition];
    if (!def) throw new HttpError(400, `Unknown disposition: ${disposition}`);
    const lead = getLead(id);
    const toStage = stageAfterDisposition(lead.stage, def);
    const wantReminder = reminder ?? def.reminder;
    let dueAt = null;
    if (wantReminder) {
      const due = reminder_at ? new Date(reminder_at) : tomorrowAt(reminderHour);
      if (Number.isNaN(due.getTime())) throw new HttpError(400, 'Invalid reminder time');
      dueAt = due.toISOString();
    }

    return transaction(db, () => {
      const ts = now();
      stmt(`UPDATE leads SET stage = ?, last_disposition = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?`)
        .run(toStage, def.id, ts, ts, id);
      logActivity(id, 'disposition', {
        disposition: def.id, from_stage: lead.stage, to_stage: toStage, note: clean(note),
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

  function addNote(id, note) {
    getLead(id);
    if (!clean(note)) throw new HttpError(400, 'Note is empty');
    logActivity(id, 'note', { note: clean(note) });
    stmt('UPDATE leads SET updated_at = ? WHERE id = ?').run(now(), id);
    return getLead(id);
  }

  function listReminders({ status = 'open' } = {}) {
    return stmt(`SELECT r.*, l.full_name, l.first_name, l.last_name, l.email, l.phone, l.stage
                 FROM reminders r JOIN leads l ON l.id = r.lead_id
                 ${status === 'open' ? 'WHERE r.done_at IS NULL' : ''}
                 ORDER BY r.due_at ASC`).all();
  }

  function getReminder(id) {
    const r = stmt('SELECT * FROM reminders WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'Reminder not found');
    return r;
  }

  function completeReminder(id) {
    const r = getReminder(id);
    if (!r.done_at) {
      stmt('UPDATE reminders SET done_at = ? WHERE id = ?').run(now(), id);
      logActivity(r.lead_id, 'reminder_done', { note: r.note });
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

  return {
    ingest, listLeads, getLead, updateLead, dispositionLead, addNote,
    listReminders, completeReminder, snoozeReminder,
  };
}

module.exports = { createLeadService, HttpError, toIso };
