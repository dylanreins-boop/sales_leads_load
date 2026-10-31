// Shop jobs on the calendar: created when a lead is booked, then worked by the shop
// (status, notes, vehicle checklist, photos).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transaction } = require('./db');
const { HttpError } = require('./leads');
const { pipelineFor } = require('./vehicle');
const { cleanServices, serviceLabels, parseServices } = require('./services');
const ShopTime = require('../public/shop-time');

const JOB_STATUSES = [
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'in_shop', label: 'In the shop' },
  { id: 'ready', label: 'Ready for pickup' },
  { id: 'picked_up', label: 'Picked up' },
  { id: 'cancelled', label: 'Cancelled / Rescheduled' },
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

const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "$1,250", "1250.5" or 1250 -> cents. Blank clears the amount (null).
function parseAmount(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new HttpError(400, 'Enter the job amount in dollars, like 1250 or 1,250.00.');
  const cents = Math.round(Number(text) * 100);
  if (cents > 100_000_000) throw new HttpError(400, 'That amount looks too big. Check the number.');
  return cents;
}

// Job prices, deposits and commissions are for sales and admins; shop logins never get them.
const isMoneyKey = (k) => /^(amount|deposit|commission)_/.test(k);
function hideAmount(value) {
  if (Array.isArray(value)) return value.map(hideAmount);
  if (value && typeof value === 'object' && Object.keys(value).some(isMoneyKey)) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !isMoneyKey(k)));
  }
  return value;
}

function createJobService(db, { leads, photosDir }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  function parseTime(value, what) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) throw new HttpError(400, `Pick a ${what} date and time.`);
    return d.toISOString();
  }

  // ---- shop hours ----
  // When the shop works (8 hours a day, Monday to Friday by default) and the usual work time per job.
  function getShopHours() {
    const row = stmt("SELECT value FROM settings WHERE key = 'shop_hours'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* keep defaults */ }
    return ShopTime.settingsOf(saved);
  }

  function saveShopHours(input = {}) {
    const next = getShopHours();
    if ('open' in input) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.open))) throw new HttpError(400, 'Pick the time the shop opens.');
      next.open = String(input.open);
    }
    for (const [key, min, max, what] of [['hours_per_day', 1, 16, 'Hours a day go from 1 to 16.'], ['car_hours', 0.5, 80, 'The usual car job goes from half an hour to 80 hours.'], ['rv_days', 1, 10, 'The usual RV job goes from 1 to 10 days.']]) {
      if (!(key in input)) continue;
      const n = Number(input[key]);
      if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, what);
      next[key] = Math.round(n * 2) / 2;
    }
    if ('work_days' in input) {
      const days = [...new Set((Array.isArray(input.work_days) ? input.work_days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!days.length) throw new HttpError(400, 'Pick at least one work day.');
      next.work_days = days;
    }
    if (next.open.split(':').map(Number).reduce((h, m) => h + m / 60) + next.hours_per_day > 24) {
      throw new HttpError(400, 'The work day has to end by midnight.');
    }
    stmt("INSERT INTO settings (key, value) VALUES ('shop_hours', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  // Work time in hours ("4", 16). Blank means the usual for the vehicle (null).
  function parseHours(value) {
    if (value == null || String(value).trim() === '') return null;
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 400) throw new HttpError(400, 'Pick how long the job takes.');
    return Math.round(hours * 4) / 4;
  }

  // Checks drop-off/pick-up times and work time from a booking; throws a 400 the rep can read.
  // With a work time and no pick-up, pick-up is when the work is done.
  function parseSchedule({ job_start, job_end, job_hours } = {}) {
    const start = parseTime(job_start, 'drop-off');
    const hours = parseHours(job_hours);
    const end = !job_end && hours != null ? ShopTime.finishAt(start, hours, getShopHours()).toISOString() : parseTime(job_end, 'pick-up');
    if (end <= start) throw new HttpError(400, 'Pick-up has to be after drop-off.');
    return { start, end, hours };
  }

  // The shop's booked hours on each day a job (or a proposed one) is worked, with warnings for days
  // over the shop's hours, closed days and pick-ups before the work can be done.
  function capacity({ id, start, end, hours, pipeline, status } = {}) {
    const from = parseTime(start, 'drop-off');
    const to = parseTime(end, 'pick-up');
    const dayStart = new Date(from);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(to);
    dayEnd.setHours(24, 0, 0, 0);
    const others = listJobs({ from: dayStart.toISOString(), to: dayEnd.toISOString() });
    const settings = getShopHours();
    return ShopTime.check({ id, start_at: from, end_at: to, work_hours: hours, pipeline, status }, others, settings);
  }

  // ---- the day sheet ----
  // Everything the shop needs for one day: drop-offs, pick-ups and what's already in the building.
  function daySheet(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) throw new HttpError(400, 'Pick a day.');
    const day = ShopTime.fromKey(dateKey);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const settings = getShopHours();
    const all = listJobs({ from: day.toISOString(), to: next.toISOString() }).filter((j) => j.status !== 'cancelled');
    const load = ShopTime.loadByDay(all, settings).get(dateKey);
    const summary = (j) => ({
      id: j.id, lead_id: j.lead_id, status: j.status, start_at: j.start_at, end_at: j.end_at,
      customer: j.full_name || [j.first_name, j.last_name].filter(Boolean).join(' ') || j.phone || 'Customer',
      phone: j.phone, vehicle: [j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || j.vehicle_type || '',
      vehicle_type: j.vehicle_type, color: j.vehicle_color, pipeline: j.pipeline,
      services: serviceLabels(j.services), notes: j.notes, work: ShopTime.label(ShopTime.jobHours(j, settings), settings),
      hours_today: load?.jobs.find((x) => x.id === j.id)?.hours ?? 0,
      checklist_done: j.checklist_done, checklist_total: j.checklist_total, photo_count: j.photo_count,
      signed_off: Boolean(j.signoff_at),
    });
    const inDay = (iso) => new Date(iso) >= day && new Date(iso) < next;
    return {
      date: dateKey,
      open: ShopTime.isWorkDay(day, settings),
      hours_per_day: settings.hours_per_day,
      booked_hours: load?.hours ?? 0,
      dropoffs: all.filter((j) => inDay(j.start_at)).map(summary),
      pickups: all.filter((j) => inDay(j.end_at) && !inDay(j.start_at)).map(summary),
      same_day: all.filter((j) => inDay(j.start_at) && inDay(j.end_at)).map((j) => j.id),
      in_shop: all.filter((j) => !inDay(j.start_at) && !inDay(j.end_at)).map(summary),
    };
  }

  const capacityFor = (job) => capacity({ id: job.id, start: job.start_at, end: job.end_at, hours: job.work_hours, pipeline: job.pipeline, status: job.status });

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
  function scheduleLead(leadId, { start, end, hours = null }, { user } = {}) {
    const lead = leads.getLead(leadId);
    const services = lead.booked_services;
    return transaction(db, () => {
      const ts = now();
      const open = stmt(`SELECT * FROM jobs WHERE lead_id = ? AND status NOT IN ('picked_up', 'cancelled')
                         ORDER BY id DESC LIMIT 1`).get(leadId);
      if (open) {
        stmt('UPDATE jobs SET start_at = ?, end_at = ?, services = ?, work_hours = COALESCE(?, work_hours), updated_at = ? WHERE id = ?')
          .run(start, end, JSON.stringify(services), hours, ts, open.id);
        leads.logActivity(leadId, 'job', { note: `Job moved: drop-off ${when(start)}, pick-up ${when(end)}`, user });
        return getJob(open.id);
      }
      const work = hours ?? ShopTime.defaultHours(pipelineFor(lead.vehicle_type), getShopHours());
      const { lastInsertRowid } = stmt(`INSERT INTO jobs (lead_id, start_at, end_at, status, services, work_hours, created_by, created_at, updated_at)
                                        VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`)
        .run(leadId, start, end, JSON.stringify(services), work, user ?? null, ts, ts);
      const jobId = Number(lastInsertRowid);
      const add = stmt('INSERT INTO job_checklist (job_id, section, label, position, created_at) VALUES (?, ?, ?, ?, ?)');
      checklistFor(lead.vehicle_type, services).forEach((item, i) => add.run(jobId, item.section, item.label, (i + 1) * 10, ts));
      const what = serviceLabels(services);
      leads.logActivity(leadId, 'job', { note: `Job on the calendar: drop-off ${when(start)}, pick-up ${when(end)} · ${ShopTime.label(work, getShopHours())} of work${what ? ` · ${what}` : ''}`, user });
      return getJob(jobId);
    });
  }

  function setAmount(id, value, { user } = {}) {
    const job = getJob(id);
    const cents = parseAmount(value);
    if (cents === job.amount_cents) return job;
    stmt('UPDATE jobs SET amount_cents = ?, amount_by = ?, amount_at = ?, updated_at = ? WHERE id = ?')
      .run(cents, user ?? null, now(), now(), id);
    const was = job.amount_cents == null ? '' : ` (was ${money(job.amount_cents)})`;
    leads.logActivity(job.lead_id, 'amount', { note: cents == null ? `Job amount cleared${was}` : `Job amount: ${money(cents)}${was}`, user });
    return getJob(id);
  }

  // Every job dropped off or booked in [from, to), for the admin Revenue page.
  function revenueJobs({ from, to } = {}) {
    const start = parseTime(from, 'start');
    const end = parseTime(to, 'end');
    return stmt(`SELECT j.id, j.lead_id, j.start_at, j.end_at, j.status, j.created_at, j.created_by, j.amount_cents, j.services,
                   l.full_name, l.first_name, l.last_name, l.vehicle_type, l.vehicle_year, l.vehicle_make, l.vehicle_model
                 FROM jobs j JOIN leads l ON l.id = j.lead_id
                 WHERE (j.start_at >= ? AND j.start_at < ?) OR (j.created_at >= ? AND j.created_at < ?)
                 ORDER BY j.start_at`).all(start, end, start, end).map(shape);
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
    if ('work_hours' in patch) {
      const hours = parseHours(patch.work_hours) ?? ShopTime.defaultHours(job.pipeline, getShopHours());
      if (hours !== job.work_hours) {
        sets.push('work_hours = ?');
        params.push(hours);
        notes.push(`Work time: ${ShopTime.label(hours, getShopHours())}${job.work_hours ? ` (was ${ShopTime.label(job.work_hours, getShopHours())})` : ''}`);
      }
    }
    if ('status' in patch && patch.status !== job.status) {
      if (!STATUS_LABEL[patch.status]) throw new HttpError(400, `Unknown job status: ${patch.status}`);
      sets.push('status = ?', 'picked_up_at = ?');
      params.push(patch.status, patch.status === 'picked_up' ? now() : null);
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

  // ---- customer sign-off at drop-off ----
  // The customer reviews the vehicle's condition with the shop and signs on the tablet or phone.
  // The wording, the condition notes and the before-photo count are saved with the signature.
  function signOff(jobId, { name, notes, signature, agree } = {}, { user, company = 'the shop' } = {}) {
    const job = getJob(jobId);
    if (job.signoff_at) throw new HttpError(400, 'This job is already signed off.');
    const who = String(name ?? '').trim().slice(0, 80);
    if (!who) throw new HttpError(400, 'Type the customer\'s name.');
    if (!agree) throw new HttpError(400, 'The customer needs to tick the box to agree.');
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(signature || ''));
    const image = match ? Buffer.from(match[1], 'base64') : null;
    if (!image || imageType(image)?.mime !== 'image/png' || image.length < 200) throw new HttpError(400, 'Have the customer sign in the box first.');
    if (image.length > 600_000) throw new HttpError(413, 'That signature image is too big.');
    const before = job.photos.filter((p) => p.phase === 'before').length;
    const condition = String(notes ?? '').trim().slice(0, 2000);
    const ts = now();
    const terms = [
      `I, ${who}, walked around my ${[job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ') || job.vehicle_type || 'vehicle'} with ${company} at drop-off on ${when(ts)}.`,
      'I agree its condition is as described below and shown in the before photos.',
      `Condition notes: ${condition || 'None noted.'}`,
      `Before photos taken: ${before}.`,
    ].join('\n');
    fs.mkdirSync(photosDir, { recursive: true });
    const file = `signoff-${jobId}-${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(photosDir, file), image);
    stmt('UPDATE jobs SET signoff_name = ?, signoff_at = ?, signoff_by = ?, signoff_file = ?, signoff_terms = ?, updated_at = ? WHERE id = ?')
      .run(who, ts, user ?? null, file, terms, ts, jobId);
    leads.logActivity(job.lead_id, 'signoff', { note: `${who} signed off on the vehicle's condition at drop-off${condition ? `: ${condition}` : ''}`, user });
    return getJob(jobId);
  }

  function signOffImage(jobId) {
    const job = getJob(jobId);
    if (!job.signoff_file) throw new HttpError(404, 'Not signed yet');
    return path.join(photosDir, path.basename(job.signoff_file));
  }

  // Admins can clear a sign-off made by mistake (the customer signs again).
  function clearSignOff(jobId, { user } = {}) {
    const job = getJob(jobId);
    if (!job.signoff_at) return job;
    stmt('UPDATE jobs SET signoff_name = NULL, signoff_at = NULL, signoff_by = NULL, signoff_file = NULL, signoff_terms = NULL, updated_at = ? WHERE id = ?').run(now(), jobId);
    leads.logActivity(job.lead_id, 'signoff', { note: `Sign-off by ${job.signoff_name} cleared`, user });
    if (job.signoff_file) fs.rm(path.join(photosDir, path.basename(job.signoff_file)), { force: true }, () => {});
    return getJob(jobId);
  }

  return {
    signOff, signOffImage, clearSignOff,
    getShopHours, saveShopHours, parseSchedule, capacity, capacityFor, daySheet, scheduleLead, listJobs, listUnscheduled, getJob, updateJob, setAmount, revenueJobs,
    addItem, updateItem, deleteItem, addPhoto, getPhoto, deletePhoto,
  };
}

module.exports = { createJobService, checklistFor, parseAmount, hideAmount, imageType, JOB_STATUSES, PHOTO_PHASES, CLOSED };
