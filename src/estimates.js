// Learned work times. Every job finished on the shop's work timer teaches the app how long work really
// takes, so a new booking's work time can start from that instead of a flat 4 hours or 2 days:
//
//   suggested = (average real hours for that vehicle type)
//             × (how much longer or shorter that paint color runs, e.g. black)
//             × (how much longer or shorter each extra service runs, e.g. paint correction)
//
// Each average leans on the standard time until there are a few jobs behind it (so one odd job can't
// swing it), and newer jobs count more than old ones (a job from six months ago counts half), so the
// numbers keep adapting as the shop gets faster or the work changes.
const ShopTime = require('../public/shop-time');
const { pipelineFor } = require('./vehicle');
const { parseServices, serviceLabels } = require('./services');

const HOUR = 3600000;
const DAY = 86400000;
const HALF_LIFE_DAYS = 180; // a job this old counts half as much as one finished today
const PRIOR = 2; // the standard time counts like this many jobs until real ones outweigh it
const CORE_SERVICE = 'full_decon_coat'; // nearly every job has it, so it isn't an "extra"

// Paint color in a word, from whatever was typed ("Jet Black", "Pearl White", "Nardo Grey").
const COLOR_FAMILIES = [
  ['Black', /\b(black|jet|obsidian|onyx|ebony|raven|piano)\b/],
  ['White', /\b(white|pearl|ivory|snow|glacier|chalk|alpine|frost|cream)\b/],
  ['Silver / gray', /\b(silver|gr[ae]y|graphite|gunmetal|charcoal|titanium|platinum|slate|ash|cement|nardo|steel)\b/],
  ['Red', /\b(red|maroon|burgundy|crimson|ruby|cherry|wine|scarlet)\b/],
  ['Blue', /\b(blue|navy|sapphire|cobalt|azure|teal)\b/],
  ['Green', /\b(green|olive|emerald|forest|lime|sage)\b/],
  ['Yellow / orange', /\b(yellow|orange|gold|amber)\b/],
  ['Brown / tan', /\b(brown|tan|beige|bronze|champagne|copper|sand|khaki)\b/],
];
function colorFamily(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  for (const [name, re] of COLOR_FAMILIES) if (re.test(t)) return name;
  return 'Other';
}

function createEstimateService(db, { getShopHours }) {
  const stmt = (sql) => db.prepare(sql);
  // Leans the weighted average of `n` jobs toward `prior` until there are a few of them. Recency only
  // decides which jobs count more against each other; how much to trust them is the job count.
  const shrink = (n, sumW, sumWX, prior) => (n ? (n / (n + PRIOR)) * (sumWX / sumW) + (PRIOR / (n + PRIOR)) * prior : prior);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // Finished, timed jobs: real hours, vehicle and services, weighted by how recent they are.
  function samples(at = new Date()) {
    return stmt(`SELECT j.id, j.services, j.work_finished_at, l.vehicle_type, l.vehicle_color,
                        (SELECT SUM((julianday(COALESCE(w.stopped_at, j.work_finished_at)) - julianday(w.started_at)) * 24) FROM job_work w WHERE w.job_id = j.id) AS hours
                 FROM jobs j JOIN leads l ON l.id = j.lead_id
                 WHERE j.work_finished_at IS NOT NULL AND j.status != 'cancelled'`).all()
      .filter((s) => s.hours > 0.1)
      .map((s) => ({
        ...s,
        type: s.vehicle_type || 'Not given',
        color: colorFamily(s.vehicle_color),
        services: parseServices(s.services),
        weight: 0.5 ** (Math.max(0, at - new Date(s.work_finished_at)) / DAY / HALF_LIFE_DAYS),
      }));
  }

  // Everything learned so far, in one pass.
  function model(at = new Date()) {
    const settings = getShopHours();
    const all = samples(at);
    const standard = (type) => ShopTime.defaultHours(pipelineFor(type === 'Not given' ? '' : type), settings);

    const byType = new Map();
    for (const s of all) {
      const t = byType.get(s.type) || { w: 0, wx: 0, n: 0 };
      t.w += s.weight; t.wx += s.weight * s.hours; t.n++;
      byType.set(s.type, t);
    }
    const typeBase = (type) => {
      const t = byType.get(type);
      return t ? shrink(t.n, t.w, t.wx, standard(type)) : standard(type);
    };

    // Each job's hours against the real average for its vehicle type: 1.2 means 20% longer than usual.
    for (const s of all) { const t = byType.get(s.type); s.ratio = s.hours / (t.wx / t.w); }
    const factor = (rows) => {
      const w = rows.reduce((n, s) => n + s.weight, 0);
      const wx = rows.reduce((n, s) => n + s.weight * s.ratio, 0);
      return { factor: clamp(shrink(rows.length, w, wx, 1), 0.5, 2.5), n: rows.length };
    };
    const colors = new Map();
    for (const name of new Set(all.map((s) => s.color).filter(Boolean))) colors.set(name, factor(all.filter((s) => s.color === name)));
    const services = new Map();
    for (const id of new Set(all.flatMap((s) => s.services).filter((id) => id !== CORE_SERVICE))) {
      services.set(id, factor(all.filter((s) => s.services.includes(id))));
    }
    return {
      samples: all.length,
      types: [...byType.entries()].map(([type, t]) => ({ type, jobs: t.n, hours: round(typeBase(type)), standard_hours: standard(type) })).sort((a, b) => b.jobs - a.jobs),
      colors: [...colors.entries()].map(([color, f]) => ({ color, jobs: f.n, factor: round(f.factor) })).sort((a, b) => b.jobs - a.jobs),
      services: [...services.entries()].map(([id, f]) => ({ id, label: serviceLabels([id]), jobs: f.n, factor: round(f.factor) })).sort((a, b) => b.jobs - a.jobs),
      typeBase,
      typeJobs: (type) => byType.get(type)?.n || 0,
      colorFactor: (c) => colors.get(c),
      serviceFactor: (id) => services.get(id),
      standard,
      settings,
    };
  }

  // The suggested work time for a vehicle and its services, with the reasons in plain words.
  function suggest({ vehicle_type: vehicleType, vehicle_color: vehicleColor, services = [] } = {}, { at = new Date(), m = model(at) } = {}) {
    const type = vehicleType || 'Not given';
    const standard = m.standard(type);
    const jobs = m.typeJobs(type);
    const plural = type === 'Not given' ? 'vehicles' : `${type}${/s$/i.test(type) ? '' : 's'}`;
    const reasons = [];
    let hours = m.typeBase(type);
    reasons.push(jobs
      ? `${plural} here average ${fmt(hours)} (${jobs} finished job${jobs === 1 ? '' : 's'})`
      : `No finished ${plural} on the work timer yet, so this starts from the standard ${fmt(standard)}`);
    const color = colorFamily(vehicleColor);
    const cf = color && m.colorFactor(color);
    if (cf && Math.abs(cf.factor - 1) >= 0.05) {
      hours *= cf.factor;
      reasons.push(`${color} paint runs ${pct(cf.factor)} (${cf.n} job${cf.n === 1 ? '' : 's'})`);
    }
    for (const id of parseServices(JSON.stringify(services))) {
      if (id === CORE_SERVICE) continue;
      const sf = m.serviceFactor(id);
      if (sf && Math.abs(sf.factor - 1) >= 0.05) {
        hours *= sf.factor;
        reasons.push(`${serviceLabels([id])} runs ${pct(sf.factor)} (${sf.n} job${sf.n === 1 ? '' : 's'})`);
      }
    }
    const perDay = m.settings.hours_per_day;
    // Half hours for a day or less, whole hours beyond.
    const rounded = Math.max(1, hours <= perDay ? Math.round(hours * 2) / 2 : Math.round(hours));
    return { hours: rounded, raw_hours: round(hours), standard_hours: standard, learned: jobs > 0 || reasons.length > 1, color_family: color, reasons };
  }

  return { model, suggest, colorFamily };
}

const round = (x) => Math.round(x * 100) / 100;
const fmt = (h) => `${Math.round(h * 10) / 10} hours`;
const pct = (f) => `${Math.round(Math.abs(f - 1) * 100)}% ${f > 1 ? 'longer' : 'shorter'}`;

module.exports = { createEstimateService, colorFamily };
