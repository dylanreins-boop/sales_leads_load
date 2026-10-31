// Importing leads from before the app: upload an Excel or CSV file, check how its columns line up
// (guessed from the headers), preview, then import. Duplicates (same phone or email as a lead already
// in the app, or earlier in the file) are skipped, nothing is lost (columns that aren't matched go into
// the lead's notes), and an import can be undone.
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const { readSheet } = require('./sheets');
const { normalizeVehicleType, VEHICLE_TYPES } = require('./vehicle');

const FIELDS = [
  { key: 'full_name', label: 'Full name', words: ['name', 'full name', 'customer', 'customer name', 'client', 'client name', 'contact', 'contact name', 'lead name', 'lead'] },
  { key: 'first_name', label: 'First name', words: ['first', 'first name', 'fname', 'given name'] },
  { key: 'last_name', label: 'Last name', words: ['last', 'last name', 'lname', 'surname', 'family name'] },
  { key: 'phone', label: 'Phone', words: ['phone', 'phone number', 'phone #', 'phone no', 'mobile', 'cell', 'cell phone', 'telephone', 'tel', 'number', 'contact number'] },
  { key: 'email', label: 'Email', words: ['email', 'e mail', 'email address', 'mail'] },
  { key: 'vehicle', label: 'Vehicle (year, make and model together)', words: ['vehicle', 'car', 'year make model', 'ymm', 'vehicle info', 'vehicle details', 'what vehicle'] },
  { key: 'vehicle_year', label: 'Year', words: ['year', 'vehicle year', 'yr', 'model year'] },
  { key: 'vehicle_make', label: 'Make', words: ['make', 'brand', 'manufacturer', 'vehicle make'] },
  { key: 'vehicle_model', label: 'Model', words: ['model', 'vehicle model'] },
  { key: 'vehicle_color', label: 'Color', words: ['color', 'colour', 'paint', 'vehicle color'] },
  { key: 'vehicle_type', label: 'Vehicle type', words: ['type', 'vehicle type', 'category', 'kind'] },
  { key: 'source', label: 'Lead source', words: ['source', 'lead source', 'origin', 'channel', 'came from', 'platform'] },
  { key: 'heard_about', label: 'How they heard about us', words: ['heard', 'heard about', 'how did you hear', 'how did you hear about us', 'referral', 'referred by'] },
  { key: 'received_at', label: 'Date the lead came in', words: ['date', 'created', 'created at', 'created date', 'received', 'date added', 'lead date', 'submitted', 'timestamp', 'date created', 'inquiry date'] },
  { key: 'status', label: 'Status / stage', words: ['status', 'stage', 'outcome', 'result', 'disposition', 'lead status'] },
  { key: 'message', label: 'Notes', words: ['notes', 'note', 'message', 'comments', 'comment', 'details', 'description', 'remarks'] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
const PLACEMENTS = ['auto', 'board', 'archive'];
const MAX_ROWS = 5000;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
const clean = (s) => String(s ?? '').trim();

// Matches each column to an app field from its header: exact words first, then partial matches.
function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  const heads = headers.map(norm);
  for (const pass of ['exact', 'partial']) {
    for (const field of FIELDS) {
      if (field.key in mapping) continue;
      const i = heads.findIndex((h, idx) => !used.has(idx) && h && (pass === 'exact'
        ? field.words.includes(h)
        : field.words.some((w) => w.length > 3 && (` ${h} `).includes(` ${w} `))));
      if (i >= 0) { mapping[field.key] = i; used.add(i); }
    }
  }
  // "Name" plus "First/Last name" columns: use the split ones.
  if ('first_name' in mapping && 'full_name' in mapping && heads[mapping.full_name] === 'name') delete mapping.full_name;
  return mapping;
}

const STAGE_WORDS = [
  ['booked', ['booked', 'sold', 'won', 'customer', 'completed', 'complete', 'done', 'paid', 'closed won', 'scheduled']],
  ['waste', ['dead', 'lost', 'not interested', 'no', 'waste', 'wrong number', 'bad number', 'do not call', 'dnc', 'junk', 'spam', 'closed lost']],
  ['voicemail', ['voicemail', 'vm', 'left message', 'left vm']],
  ['contacted', ['contacted', 'talked', 'spoke', 'follow up', 'following up', 'quoted', 'quote sent', 'interested', 'hot', 'warm']],
];
function stageFrom(text) {
  const t = ` ${norm(text)} `;
  if (!t.trim()) return 'new';
  for (const [stage, words] of STAGE_WORDS) if (words.some((w) => t.includes(` ${w} `))) return stage;
  return 'new';
}

// Lead source: Facebook and website keep their own label; anything else becomes "how they heard".
function sourceFrom(text) {
  const t = norm(text);
  if (/\b(facebook|fb|instagram|ig|meta)\b/.test(t)) return { source: 'facebook' };
  if (/\b(website|web|site|online form|form)\b/.test(t)) return { source: 'website' };
  if (!t) return { source: 'import' };
  if (/\b(google|search|internet|yelp)\b/.test(t)) return { source: 'import', heard_about: 'Searched on the internet' };
  if (/\b(referral|referred|friend|word of mouth|family)\b/.test(t)) return { source: 'import', heard_about: 'Word of mouth referral' };
  if (/\b(radio)\b/.test(t)) return { source: 'import', heard_about: 'Radio' };
  if (/\b(social|tiktok|ad|ads)\b/.test(t)) return { source: 'import', heard_about: 'Saw an ad on social media' };
  return { source: 'import', heard_about: 'Other', note: `Source: ${clean(text)}` };
}

// "2022 Tesla Model Y" -> year, make, model (and the type when the words say so: "motorhome", "jet ski").
function splitVehicle(text) {
  const value = clean(text);
  if (!value) return {};
  const type = normalizeVehicleType(value);
  const out = VEHICLE_TYPES.includes(type) ? { vehicle_type: type } : {};
  if (VEHICLE_TYPES.some((t) => t.toLowerCase() === value.toLowerCase())) return out;
  const m = value.match(/^((?:19|20)\d{2})\s+(\S+)\s*(.*)$/);
  if (m) return { ...out, vehicle_year: m[1], vehicle_make: m[2], vehicle_model: m[3] || null };
  return { ...out, vehicle_model: value };
}

function parseDate(value) {
  const text = clean(value);
  if (!text) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00:00` : text);
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d > new Date(Date.now() + 86400000) ? null : d.toISOString();
}

function prettyPhone(text) {
  const digits = clean(text).replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return clean(text) || null;
}

// One spreadsheet row -> a lead, using the column mapping. Unmatched columns go into the notes.
function rowToLead(row, headers, mapping) {
  const get = (key) => (key in mapping ? clean(row[mapping[key]]) : '');
  const lead = {};
  const notes = [];
  if (get('full_name')) lead.full_name = get('full_name');
  if (get('first_name')) lead.first_name = get('first_name');
  if (get('last_name')) lead.last_name = get('last_name');
  if (lead.full_name && !lead.first_name && !lead.last_name) {
    const [first, ...rest] = lead.full_name.split(/\s+/);
    lead.first_name = first;
    lead.last_name = rest.join(' ') || null;
  }
  lead.phone = prettyPhone(get('phone'));
  const email = get('email');
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) lead.email = email;
  else if (email) notes.push(`Email (as written): ${email}`);
  Object.assign(lead, splitVehicle(get('vehicle')));
  for (const key of ['vehicle_year', 'vehicle_make', 'vehicle_model', 'vehicle_color']) if (get(key)) lead[key] = get(key);
  if (get('vehicle_type')) lead.vehicle_type = normalizeVehicleType(get('vehicle_type'));
  if (lead.vehicle_year && !/^\d{4}$/.test(lead.vehicle_year)) {
    notes.push(`Year (as written): ${lead.vehicle_year}`);
    delete lead.vehicle_year;
  }
  const src = sourceFrom(get('source'));
  lead.source = src.source;
  if (src.heard_about) lead.heard_about = src.heard_about;
  if (src.note) notes.push(src.note);
  if (get('heard_about')) lead.heard_about = sourceFrom(get('heard_about')).heard_about || 'Other';
  lead.received_at = parseDate(get('received_at'));
  if (get('received_at') && !lead.received_at) notes.push(`Date (as written): ${get('received_at')}`);
  lead.stage = stageFrom(get('status'));
  if (get('status')) notes.push(`Status before the app: ${get('status')}`);
  if (get('message')) notes.unshift(get('message'));
  const mapped = new Set(Object.values(mapping));
  headers.forEach((h, i) => {
    const v = clean(row[i]);
    if (v && !mapped.has(i)) notes.push(`${clean(h) || `Column ${i + 1}`}: ${v}`);
  });
  lead.message = notes.join('\n') || null;
  return lead;
}

function createImportService(db, { leads, archiveDays = 14 }) {
  const stmt = (sql) => db.prepare(sql);
  const uploads = new Map(); // token -> { name, headers, rows, at }
  const now = () => new Date().toISOString();

  function load(buffer, name) {
    let rows;
    try { rows = readSheet(buffer, name); } catch (err) { throw new HttpError(400, `Couldn't read that file: ${err.message}`); }
    const headerAt = rows.findIndex((r) => r.filter((c) => clean(c)).length >= 2);
    if (headerAt < 0) throw new HttpError(400, 'That file looks empty. The first row should be the column names.');
    const headers = rows[headerAt].map(clean);
    const body = rows.slice(headerAt + 1).filter((r) => r.some((c) => clean(c)));
    if (body.length > MAX_ROWS) throw new HttpError(400, `That's ${body.length} rows. Split it into files of ${MAX_ROWS} or fewer.`);
    for (const [k, v] of uploads) if (Date.now() - v.at > 3600000) uploads.delete(k);
    const token = crypto.randomUUID();
    uploads.set(token, { name: String(name || 'leads').slice(0, 120), headers, rows: body, at: Date.now() });
    return { token, file: name, headers, mapping: guessMapping(headers), fields: FIELDS.map(({ key, label }) => ({ key, label })), total: body.length, placements: PLACEMENTS };
  }

  const upload = (token) => {
    const u = uploads.get(token);
    if (!u) throw new HttpError(400, 'That upload expired. Choose the file again.');
    return u;
  };
  function cleanMapping(mapping, headers) {
    const out = {};
    for (const [key, col] of Object.entries(mapping || {})) {
      const i = Number(col);
      if (FIELD_KEYS.includes(key) && col !== '' && col != null && Number.isInteger(i) && i >= 0 && i < headers.length) out[key] = i;
    }
    return out;
  }

  // Works out what each row would become. `commit` does it for real.
  function plan(token, mapping) {
    const u = upload(token);
    const map = cleanMapping(mapping, u.headers);
    const seen = new Set();
    return u.rows.map((row, i) => {
      const lead = rowToLead(row, u.headers, map);
      const name = lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' ');
      const phone = String(lead.phone || '').replace(/\D/g, '').slice(-10);
      const email = (lead.email || '').toLowerCase();
      let skip = null;
      if (!name && !phone && !email) skip = 'No name, phone or email';
      else if ((phone.length >= 7 && seen.has(`p${phone}`)) || (email && seen.has(`e${email}`))) skip = 'Same phone or email as a row above';
      else {
        const existing = stmt(`SELECT id, full_name FROM leads WHERE (? != '' AND phone_norm = ?) OR (? != '' AND email_norm = ?) LIMIT 1`)
          .get(phone.length >= 7 ? phone : '', phone, email, email);
        if (existing) skip = `Already in the app${existing.full_name ? ` (${existing.full_name})` : ''}`;
      }
      if (phone.length >= 7) seen.add(`p${phone}`);
      if (email) seen.add(`e${email}`);
      return { row: i + 2, name, lead, skip };
    });
  }

  function check(token, mapping) {
    const rows = plan(token, mapping);
    const ready = rows.filter((r) => !r.skip);
    return {
      total: rows.length,
      ready: ready.length,
      skipped: rows.length - ready.length,
      skips: rows.filter((r) => r.skip).slice(0, 50).map(({ row, name, skip }) => ({ row, name, reason: skip })),
      sample: rows.slice(0, 8).map(({ row, lead, skip }) => ({ row, skip, ...lead })),
      stages: ready.reduce((acc, r) => ({ ...acc, [r.lead.stage]: (acc[r.lead.stage] || 0) + 1 }), {}),
    };
  }

  // Imports the rows. placement: 'auto' (leads older than the 2-week window go straight to Old & Dead
  // Leads, or Past Customers if booked), 'board' (all on the board as fresh leads) or 'archive' (none).
  function commit(token, mapping, { placement = 'auto' } = {}, { user } = {}) {
    if (!PLACEMENTS.includes(placement)) throw new HttpError(400, 'Pick where the leads go.');
    const u = upload(token);
    const rows = plan(token, mapping);
    const batch = `imp_${crypto.randomUUID().slice(0, 8)}`;
    const ts = now();
    const cutoff = new Date(Date.now() - archiveDays * 86400000).toISOString();
    let created = 0;
    const counts = { board: 0, old: 0, customers: 0 };
    for (const r of rows.filter((x) => !x.skip)) {
      const { stage, ...input } = r.lead;
      const { lead } = leads.ingest({ ...input, received_at: input.received_at || ts }, { user, silent: true });
      const received = input.received_at || ts;
      const archive = placement === 'archive' || (placement === 'auto' && received < cutoff);
      stmt('UPDATE leads SET stage = ?, import_batch = ?, archived_at = ?, restored_at = ?, updated_at = ? WHERE id = ?').run(
        stage, batch, archive ? ts : null, placement === 'board' ? ts : null, ts, lead.id,
      );
      leads.logActivity(lead.id, 'import', { note: `Imported from ${u.name} (row ${r.row})${stage !== 'new' ? `, stage ${stage}` : ''}`, user });
      created++;
      if (!archive) counts.board++;
      else if (stage === 'booked') counts.customers++;
      else counts.old++;
    }
    stmt('INSERT INTO import_batches (id, file, created_count, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(batch, u.name, created, user ?? null, ts);
    uploads.delete(token);
    return { batch, created, skipped: rows.length - created, ...counts };
  }

  function batches() {
    return stmt(`SELECT b.*, (SELECT COUNT(*) FROM leads l WHERE l.import_batch = b.id) AS still_there
                 FROM import_batches b ORDER BY b.created_at DESC LIMIT 20`).all();
  }

  // Removes the leads an import added (and anything done to them since).
  function undo(batchId, { user } = {}) {
    const batch = stmt('SELECT * FROM import_batches WHERE id = ?').get(batchId);
    if (!batch) throw new HttpError(404, 'Import not found');
    if (batch.undone_at) throw new HttpError(400, 'That import was already undone.');
    const { changes } = stmt('DELETE FROM leads WHERE import_batch = ?').run(batchId);
    stmt('UPDATE import_batches SET undone_at = ?, undone_by = ? WHERE id = ?').run(now(), user ?? null, batchId);
    return { removed: Number(changes) };
  }

  const TEMPLATE = 'First name,Last name,Phone,Email,Vehicle,Color,Lead source,Date,Status,Notes\n'
    + 'Maria,Lopez,702-555-0142,maria@example.com,2022 Tesla Model Y,White,Facebook,3/14/2026,Booked,Full coat\n'
    + 'Derek,Chan,702-555-0188,,2019 Ford F-150,Black,Website,9/2/2026,Contacted,Wants a quote on wheels\n';

  return { load, check, commit, batches, undo, template: () => TEMPLATE };
}

module.exports = { createImportService, guessMapping, rowToLead, splitVehicle, stageFrom, FIELDS };
