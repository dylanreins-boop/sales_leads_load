// Shop jobs on the calendar: created when a lead is booked, then worked by the shop
// (status, notes, vehicle checklist, photos).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transaction } = require('./db');
const { HttpError } = require('./leads');
const { pipelineFor } = require('./vehicle');
const { cleanServices, serviceLabels, parseServices } = require('./services');

const JOB_STATUSES = [
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'in_shop', label: 'In the shop' },
  { id: 'ready', label: 'Ready for pickup' },
  { id: 'picked_up', label: 'Picked up' },
  { id: 'cancelled', label: 'Cancelled' },
];
const STATUS_LABEL = Object.fromEntries(JOB_STATUSES.map((s) => [s.id, s.label]));
const CLOSED = ['picked_up', 'cancelled'];
const PHOTO_PHASES = ['before', 'during', 'after'];

// ---- vehicle checklist ----
// Every job starts with these; vehicle type and booked services add more. The shop can
// add, rename or remove items on each job.
const BASE_CHECKLIST = {
  'Check-in': [
    'Walk-around with customer: note chips, scratches and dents',
    'Before photos of every side',
    'Check glass for chips and cracks',
    'Check wheels and tires for curb rash',
    'Mileage / hours recorded',
    'Personal items removed or noted',
  ],
  Work: [
    'Decon wash (iron and tar removal)',
    'Clay bar',
    'Panel wipe before coating',
    'Coating applied',
    'Cure time complete',
  ],
  Finish: [
    'Final inspection under lights',
    'After photos',
    'Customer walk-through and care instructions',
  ],
};

const TYPE_CHECKLIST = {
  'Coach / RV': { 'Check-in': ['Roof checked: seals, vents and AC units', 'Slide-outs extended and checked', 'Awning condition noted'] },
  'Trailer / Toy Hauler': { 'Check-in': ['Roof checked: seals and vents', 'Slide-outs extended and checked', 'Ramp door and seals checked'] },
  Boat: { 'Check-in': ['Hull and gelcoat oxidation level noted', 'Trailer condition noted'] },
  'Jet Ski': { 'Check-in': ['Hull and gelcoat oxidation level noted', 'Trailer condition noted'] },
  Plane: { 'Check-in': ['Tail number recorded', 'Leading edges and de-ice boots checked'] },
  Semi: { 'Check-in': ['Unit / fleet number recorded'] },
};

const SERVICE_CHECKLIST = {
  paint_correction: { Work: ['Paint depth readings taken', 'Paint correction complete'] },
  wheels_windows: { Work: ['Wheels and calipers coated', 'Glass coated'] },
  wheels: { Work: ['Wheels and calipers coated'] },
  windows: { Work: ['Glass coated'] },
  trim: { Work: ['Trim and plastics coated'] },
  interior: { Work: ['Interior protection applied'] },
  pop_outs: { Work: ['Pop-outs / slide-outs coated'] },
  roof: { Work: ['Roof coated'] },
  hull: { Work: ['Hull and gelcoat coated'] },
};

const SECTIONS = ['Check-in', 'Work', 'Finish'];

function checklistFor(vehicleType, services) {
  const items = Object.fromEntries(SECTIONS.map((s) => [s, [...BASE_CHECKLIST[s]]]));
  const extras = [TYPE_CHECKLIST[vehicleType], ...services.map((id) => SERVICE_CHECKLIST[id])].filter(Boolean);
  for (const extra of extras) {
    for (const [section, labels] of Object.entries(extra)) {
      for (const label of labels) if (!items[section].includes(label)) items[section].push(label);
    }
  }
  // Service work goes before the coating step, so the list reads in the order the work happens.
  const work = items.Work;
  const coatingAt = work.indexOf('Panel wipe before coating');
  const extraWork = work.slice(BASE_CHECKLIST.Work.length);
  items.Work = [...work.slice(0, coatingAt), ...extraWork, ...work.slice(coatingAt, BASE_CHECKLIST.Work.length)];
  return SECTIONS.flatMap((section) => items[section].map((label) => ({ section, label })));
}

// ---- photos ----
// Only real images are stored, recognised by their first bytes rather than the file name.
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

const when = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function createJobService(db, { leads, photosDir }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  function parseTime(value, what) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) throw new HttpError(400, `Pick a ${what} date and time.`);
    return d.toISOString();
  }

  // Checks drop-off/pick-up times from a booking; throws a 400 the rep can read.
  function parseSchedule({ job_start, job_end } = {}) {
    const start = parseTime(job_start, 'drop-off');
    const end = parseTime(job_end, 'pick-up');
    if (end <= start) throw new HttpError(400, 'Pick-up has to be after drop-off.');
    return { start, end };
  }

  const LEAD_FIELDS = `l.full_name, l.first_name, l.last_name, l.phone, l.email, l.sms_opt_in, l.vehicle_type, l.vehicle_year,
                       l.vehicle_make, l.vehicle_model, l.vehicle_color, l.message, l.stage`;

  function shape(row) {
    return { ...row, services: parseServices(row.services), pipeline: pipelineFor(row.vehicle_type) };
  }

  function getJob(id) {
    const row = stmt(`SELECT j.*, ${LEAD_FIELDS} FROM jobs j JOIN leads l ON l.id = j.lead_id WHERE j.id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Job not found');
    const job = shape(row);
    job.checklist = stmt('SELECT * FROM job_checklist WHERE job_id = ? ORDER BY position, id').all(id);
    job.photos = stmt('SELECT id, phase, caption, size, uploaded_by, created_at FROM job_photos WHERE job_id = ? ORDER BY id').all(id);
    return job;
  }

  // Jobs that overlap [from, to), with checklist progress and photo counts for the calendar.
  function listJobs({ from, to } = {}) {
    const start = parseTime(from, 'start');
    const end = parseTime(to, 'end');
    return stmt(`SELECT j.*, ${LEAD_FIELDS},
                   (SELECT COUNT(*) FROM job_checklist c WHERE c.job_id = j.id) AS checklist_total,
                   (SELECT COUNT(*) FROM job_checklist c WHERE c.job_id = j.id AND c.done_at IS NOT NULL) AS checklist_done,
                   (SELECT COUNT(*) FROM job_photos p WHERE p.job_id = j.id) AS photo_count
                 FROM jobs j JOIN leads l ON l.id = j.lead_id
                 WHERE j.start_at < ? AND j.end_at > ?
                 ORDER BY j.start_at`).all(end, start).map(shape);
  }

  // Booked leads that aren't on the calendar yet (e.g. booked before the calendar existed).
  function listUnscheduled() {
    return stmt(`SELECT l.id, ${LEAD_FIELDS}, l.booked_services FROM leads l
                 WHERE l.stage = 'booked' AND l.archived_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled')
                 ORDER BY l.updated_at DESC`).all()
      .map((r) => ({ ...r, booked_services: parseServices(r.booked_services) }));
  }

  // Puts a booked lead on the calendar, or moves its open job to the new times.
  function scheduleLead(leadId, { start, end }, { user } = {}) {
    const lead = leads.getLead(leadId);
    const services = lead.booked_services;
    return transaction(db, () => {
      const ts = now();
      const open = stmt(`SELECT * FROM jobs WHERE lead_id = ? AND status NOT IN ('picked_up', 'cancelled')
                         ORDER BY id DESC LIMIT 1`).get(leadId);
      if (open) {
        stmt('UPDATE jobs SET start_at = ?, end_at = ?, services = ?, updated_at = ? WHERE id = ?')
          .run(start, end, JSON.stringify(services), ts, open.id);
        leads.logActivity(leadId, 'job', { note: `Job moved: drop-off ${when(start)}, pick-up ${when(end)}`, user });
        return getJob(open.id);
      }
      const { lastInsertRowid } = stmt(`INSERT INTO jobs (lead_id, start_at, end_at, status, services, created_by, created_at, updated_at)
                                        VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?)`)
        .run(leadId, start, end, JSON.stringify(services), user ?? null, ts, ts);
      const jobId = Number(lastInsertRowid);
      const add = stmt('INSERT INTO job_checklist (job_id, section, label, position, created_at) VALUES (?, ?, ?, ?, ?)');
      checklistFor(lead.vehicle_type, services).forEach((item, i) => add.run(jobId, item.section, item.label, (i + 1) * 10, ts));
      const what = serviceLabels(services);
      leads.logActivity(leadId, 'job', { note: `Job on the calendar: drop-off ${when(start)}, pick-up ${when(end)}${what ? ` · ${what}` : ''}`, user });
      return getJob(jobId);
    });
  }

  function updateJob(id, patch = {}, { user } = {}) {
    const job = getJob(id);
    const sets = [];
    const params = [];
    const notes = [];
    if ('start_at' in patch || 'end_at' in patch) {
      const start = 'start_at' in patch ? parseTime(patch.start_at, 'drop-off') : job.start_at;
      const end = 'end_at' in patch ? parseTime(patch.end_at, 'pick-up') : job.end_at;
      if (end <= start) throw new HttpError(400, 'Pick-up has to be after drop-off.');
      if (start !== job.start_at || end !== job.end_at) {
        sets.push('start_at = ?', 'end_at = ?');
        params.push(start, end);
        notes.push(`Job moved: drop-off ${when(start)}, pick-up ${when(end)}`);
      }
    }
    if ('status' in patch && patch.status !== job.status) {
      if (!STATUS_LABEL[patch.status]) throw new HttpError(400, `Unknown job status: ${patch.status}`);
      sets.push('status = ?');
      params.push(patch.status);
      notes.push(`Job: ${STATUS_LABEL[job.status]} → ${STATUS_LABEL[patch.status]}`);
    }
    if ('notes' in patch) {
      const text = String(patch.notes ?? '').trim() || null;
      sets.push('notes = ?');
      params.push(text);
      if (text !== (job.notes ?? null)) notes.push(text ? `Job notes: ${text}` : 'Job notes cleared');
    }
    if ('services' in patch) {
      sets.push('services = ?');
      params.push(JSON.stringify(cleanServices(patch.services)));
    }
    if (!sets.length) return job;
    return transaction(db, () => {
      sets.push('updated_at = ?');
      params.push(now(), id);
      stmt(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      for (const note of notes) leads.logActivity(job.lead_id, 'job', { note, user });
      return getJob(id);
    });
  }

  // ---- checklist ----
  function getItem(jobId, itemId) {
    const item = stmt('SELECT * FROM job_checklist WHERE id = ? AND job_id = ?').get(itemId, jobId);
    if (!item) throw new HttpError(404, 'Checklist item not found');
    return item;
  }

  function addItem(jobId, { label, section } = {}, { user } = {}) {
    const job = getJob(jobId);
    const text = String(label ?? '').trim();
    if (!text) throw new HttpError(400, 'Type what needs checking.');
    const where = SECTIONS.includes(section) ? section : 'Work';
    const last = stmt('SELECT MAX(position) AS p FROM job_checklist WHERE job_id = ? AND section = ?').get(jobId, where).p
      ?? stmt('SELECT MAX(position) AS p FROM job_checklist WHERE job_id = ?').get(jobId).p ?? 0;
    // Slot it at the end of its section by renumbering the rest after it.
    stmt('UPDATE job_checklist SET position = position + 1 WHERE job_id = ? AND position > ?').run(jobId, last);
    stmt('INSERT INTO job_checklist (job_id, section, label, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, where, text.slice(0, 200), last + 1, now());
    leads.logActivity(job.lead_id, 'checklist', { note: `Checklist item added (${where}): ${text.slice(0, 200)}`, user });
    return getJob(jobId).checklist;
  }

  function updateItem(jobId, itemId, { done, label } = {}, { user } = {}) {
    const before = getItem(jobId, itemId);
    const leadId = getJob(jobId).lead_id;
    if (label !== undefined) {
      const text = String(label).trim();
      if (!text) throw new HttpError(400, 'A checklist item needs text.');
      stmt('UPDATE job_checklist SET label = ? WHERE id = ?').run(text.slice(0, 200), itemId);
    }
    if (done !== undefined) {
      if (done) stmt('UPDATE job_checklist SET done_at = ?, done_by = ? WHERE id = ?').run(now(), user ?? null, itemId);
      else stmt('UPDATE job_checklist SET done_at = NULL, done_by = NULL WHERE id = ?').run(itemId);
      if (Boolean(done) !== Boolean(before.done_at)) {
        leads.logActivity(leadId, 'checklist', { note: `${done ? 'Checked off' : 'Unchecked'}: ${before.label}`, user });
      }
    }
    return getItem(jobId, itemId);
  }

  function deleteItem(jobId, itemId, { user } = {}) {
    const item = getItem(jobId, itemId);
    stmt('DELETE FROM job_checklist WHERE id = ?').run(itemId);
    leads.logActivity(getJob(jobId).lead_id, 'checklist', { note: `Checklist item removed: ${item.label}`, user });
    return { ok: true };
  }

  // ---- photos ----
  function addPhoto(jobId, buffer, { phase, caption } = {}, { user } = {}) {
    const job = getJob(jobId);
    if (!buffer?.length) throw new HttpError(400, 'No photo was sent.');
    const type = imageType(buffer);
    if (!type) throw new HttpError(415, 'That file is not a JPEG, PNG or WebP photo.');
    fs.mkdirSync(photosDir, { recursive: true });
    const file = `job-${jobId}-${crypto.randomUUID()}.${type.ext}`;
    fs.writeFileSync(path.join(photosDir, file), buffer);
    const { lastInsertRowid } = stmt(`INSERT INTO job_photos (job_id, file, mime, phase, caption, size, uploaded_by, created_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobId, file, type.mime, PHOTO_PHASES.includes(phase) ? phase : 'during',
      String(caption ?? '').trim().slice(0, 300) || null, buffer.length, user ?? null, now(),
    );
    leads.logActivity(job.lead_id, 'photo', { note: `Added a ${PHOTO_PHASES.includes(phase) ? phase : 'during'} photo`, user });
    return stmt('SELECT id, phase, caption, size, uploaded_by, created_at FROM job_photos WHERE id = ?').get(Number(lastInsertRowid));
  }

  function getPhoto(jobId, photoId) {
    const photo = stmt('SELECT * FROM job_photos WHERE id = ? AND job_id = ?').get(photoId, jobId);
    if (!photo) throw new HttpError(404, 'Photo not found');
    return { ...photo, path: path.join(photosDir, path.basename(photo.file)) };
  }

  function deletePhoto(jobId, photoId, { user } = {}) {
    const photo = getPhoto(jobId, photoId);
    stmt('DELETE FROM job_photos WHERE id = ?').run(photoId);
    leads.logActivity(getJob(jobId).lead_id, 'photo', { note: `Deleted a ${photo.phase} photo`, user });
    fs.rm(photo.path, { force: true }, () => {});
    return { ok: true };
  }

  return {
    parseSchedule, scheduleLead, listJobs, listUnscheduled, getJob, updateJob,
    addItem, updateItem, deleteItem, addPhoto, getPhoto, deletePhoto,
  };
}

module.exports = { createJobService, checklistFor, JOB_STATUSES, PHOTO_PHASES, CLOSED };
