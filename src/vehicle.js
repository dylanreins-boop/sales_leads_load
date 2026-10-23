// Vehicle details for a ceramic coating lead, and how to find them in
// Facebook / website form answers whatever the questions were called.
const VEHICLE_FIELDS = [
  { key: 'vehicle_type', label: 'Vehicle type' },
  { key: 'vehicle_year', label: 'Year' },
  { key: 'vehicle_make', label: 'Make' },
  { key: 'vehicle_model', label: 'Model' },
  { key: 'vehicle_color', label: 'Color' },
];

// Choices for the Vehicle type dropdown. Edit this list to change them.
const VEHICLE_TYPES = [
  'Car', 'SUV', 'Truck', 'Van', 'Motorcycle', 'SXS / OHV', 'Semi', 'Coach / RV', 'Trailer / Toy Hauler', 'Boat', 'Jet Ski',
  'Plane', 'Other',
];

// Words in a form answer that point to one of the types above (checked in order).
const TYPE_WORDS = [
  ['Jet Ski', ['jet ski', 'jetski', 'pwc', 'sea-doo', 'seadoo', 'waverunner']],
  ['Plane', ['plane', 'airplane', 'aircraft', 'jet', 'helicopter']],
  ['Boat', ['boat', 'yacht', 'pontoon', 'sailboat', 'vessel']],
  ['Trailer / Toy Hauler', ['toy hauler', 'toyhauler', 'fifth wheel', '5th wheel', 'travel trailer', 'trailer', 'airstream']],
  ['Semi', ['semi', 'tractor', 'big rig', '18 wheeler', '18-wheeler', 'peterbilt', 'kenworth', 'freightliner']],
  ['Coach / RV', ['coach', 'rv', 'motorhome', 'motor home', 'camper', 'bus']],
  ['SXS / OHV', ['sxs', 'side by side', 'side-by-side', 'utv', 'atv', 'ohv', 'rzr', 'quad', 'dune buggy']],
  ['Motorcycle', ['motorcycle', 'motorbike', 'bike']],
  ['Truck', ['truck', 'pickup']],
  ['SUV', ['suv', 'crossover']],
  ['Van', ['van', 'minivan']],
  // Their quote form offers "Auto", "RV" and "Boat".
  ['Car', ['car', 'auto', 'automobile', 'sedan', 'coupe', 'hatchback', 'convertible', 'wagon']],
];

// Turns a free-text answer like "motorhome" into "Coach / RV". Unknown answers are kept as typed.
function normalizeVehicleType(text) {
  const value = String(text || '').trim();
  if (!value) return value;
  const exact = VEHICLE_TYPES.find((t) => t.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const lower = ` ${value.toLowerCase().replace(/[^a-z0-9-]+/g, ' ')} `;
  const hit = TYPE_WORDS.find(([, ws]) => ws.some((w) => lower.includes(` ${w} `)));
  return hit ? hit[0] : value;
}

// Words in a form field name that tell us what the answer is.
const MATCHERS = [
  ['vehicle_year', ['year']],
  ['vehicle_make', ['make', 'brand', 'manufacturer']],
  ['vehicle_model', ['model']],
  ['vehicle_color', ['color', 'colour', 'paint']],
  ['vehicle_type', ['type', 'kind', 'services']],
];

const words = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function classify(fieldName) {
  const w = words(fieldName);
  const hits = MATCHERS.filter(([, keys]) => keys.some((k) => w.includes(k))).map(([field]) => field);
  if (!hits.length) return null;
  // "Color" and "type" questions are what they say, even if they mention the vehicle.
  if (hits.includes('vehicle_color')) return 'vehicle_color';
  if (hits.includes('vehicle_type')) return 'vehicle_type';
  // A combined "year, make and model" question keeps the whole answer together.
  const carParts = hits.filter((h) => ['vehicle_year', 'vehicle_make', 'vehicle_model'].includes(h));
  if (carParts.length > 1) return 'vehicle_model';
  return carParts[0] || hits[0];
}

// Pulls vehicle details out of a { fieldName: answer } object.
function extractVehicle(answers) {
  const vehicle = {};
  for (const [name, value] of Object.entries(answers || {})) {
    const text = value == null ? '' : String(value).trim();
    if (!text) continue;
    const field = classify(name);
    if (!field || vehicle[field]) continue;
    if (field === 'vehicle_type') {
      const type = normalizeVehicleType(text);
      // A loosely named question like "Services" only counts if the answer is a vehicle type.
      if (words(name).includes('services') && !VEHICLE_TYPES.includes(type)) continue;
      vehicle[field] = type;
    } else {
      vehicle[field] = text;
    }
  }
  return vehicle;
}

// Empty is fine; otherwise a plausible 4-digit model year.
function isValidYear(value) {
  if (value == null || String(value).trim() === '') return true;
  const year = Number(String(value).trim());
  return /^\d{4}$/.test(String(value).trim()) && year >= 1900 && year <= new Date().getFullYear() + 2;
}

module.exports = { VEHICLE_FIELDS, VEHICLE_TYPES, extractVehicle, normalizeVehicleType, isValidYear };
