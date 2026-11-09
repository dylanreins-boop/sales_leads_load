// The boards (pipelines), set up by admins. Each has a name, the vehicle types whose leads go on it,
// and who sees it in their menu (everyone, or picked people). RV and All Other Vehicles always exist;
// All Other Vehicles is last and takes every lead no other pipeline claims. Saved in settings and
// applied right away: a lead's pipeline follows its vehicle type, so changing the types moves leads.
const { HttpError } = require('./leads');
const { VEHICLE_TYPES, DEFAULT_PIPELINES, PIPELINES, setPipelines } = require('./vehicle');

const MAX = 12;
const RESERVED = ['rv', 'other', 'old', 'customers', 'calendar', 'revenue', 'analytics', 'commissions', 'leads'];
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

function createPipelineService(db) {
  const stmt = (sql) => db.prepare(sql);

  function load() {
    let saved = null;
    try { saved = JSON.parse(stmt("SELECT value FROM settings WHERE key = 'pipelines'").get()?.value || 'null'); } catch { saved = null; }
    setPipelines(Array.isArray(saved) && saved.length ? normalize(saved) : DEFAULT_PIPELINES);
    return list();
  }

  const list = () => PIPELINES.map((p) => ({ ...p, builtin: p.id === 'rv' || p.id === 'other' }));

  // Checks and tidies an admin's list: names, types each in one pipeline, RV and Other kept, Other last.
  function normalize(input) {
    if (!Array.isArray(input)) throw new HttpError(400, 'Send the list of pipelines.');
    const out = [];
    const seenTypes = new Map();
    const ids = new Set();
    // Ids already in use (kept by the pipelines that have them), so a new one never takes one.
    const known = new Set([...PIPELINES.map((p) => p.id), 'rv', 'other']);
    const taken = new Set([...RESERVED, ...input.map((r) => clean(r.id, 40)).filter((id) => known.has(id))]);
    for (const raw of input) {
      const label = clean(raw.label, 40);
      if (!label) throw new HttpError(400, 'Every pipeline needs a name.');
      let id = clean(raw.id, 40);
      if (!known.has(id)) {
        // A new pipeline: an id from its name ("Boats" -> "boats").
        const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pipeline';
        id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
        taken.add(id);
      }
      if (ids.has(id)) continue;
      ids.add(id);
      const types = id === 'other' ? [] : [...new Set((raw.types || []).map((t) => clean(t, 40)))].filter((t) => VEHICLE_TYPES.includes(t));
      for (const t of types) {
        if (seenTypes.has(t)) throw new HttpError(400, `${t} is in both ${seenTypes.get(t)} and ${label}. A vehicle type goes on one pipeline.`);
        seenTypes.set(t, label);
      }
      const visible = id === 'other' ? [] : [...new Set((raw.visible_to || []).map((n) => clean(n, 60)).filter(Boolean))];
      out.push({ id, label, types, visible_to: visible });
    }
    if (!out.some((p) => p.id === 'rv')) out.unshift({ ...DEFAULT_PIPELINES[0], types: [], visible_to: [] });
    const other = out.find((p) => p.id === 'other') || { ...DEFAULT_PIPELINES[1] };
    const result = [...out.filter((p) => p.id !== 'other'), other];
    if (result.length > MAX) throw new HttpError(400, `Keep it to ${MAX} pipelines or fewer.`);
    return result;
  }

  function save(input, { user } = {}) {
    const next = normalize(input);
    stmt("INSERT INTO settings (key, value) VALUES ('pipelines', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    setPipelines(next);
    stmt('INSERT INTO user_events (user_name, action, detail, by_user, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user || 'admin', 'pipelines', next.map((p) => `${p.label}${p.types.length ? ` (${p.types.join(', ')})` : ''}`).join('; '), user ?? null, new Date().toISOString());
    return list();
  }

  // The pipelines a person sees in their menu: admins see every one; others see the ones open to
  // everyone or picked for them. All Other Vehicles is always shown.
  function visibleTo({ user, role } = {}) {
    if (role === 'admin') return list();
    const me = String(user || '').toLowerCase();
    return list().filter((p) => p.id === 'other' || !p.visible_to.length || p.visible_to.some((n) => n.toLowerCase() === me));
  }

  return { load, list, save, visibleTo };
}

module.exports = { createPipelineService };
