// Vehicle details for a ceramic coating lead, and how to find them in
// Facebook / website form answers whatever the questions were called.
const VEHICLE_FIELDS = [
  { key: 'vehicle_year', label: 'Year' },
  { key: 'vehicle_make', label: 'Make' },
  { key: 'vehicle_model', label: 'Model' },
  { key: 'vehicle_color', label: 'Color' },
  { key: 'service_interest', label: 'Service interested in' },
];

// Words in a form field name that tell us what the answer is.
const MATCHERS = [
  ['vehicle_year', ['year']],
  ['vehicle_make', ['make', 'brand', 'manufacturer']],
  ['vehicle_model', ['model']],
  ['vehicle_color', ['color', 'colour', 'paint']],
  ['service_interest', ['service', 'package', 'coating', 'interested']],
];

const words = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function classify(fieldName) {
  const w = words(fieldName);
  const hits = MATCHERS.filter(([, keys]) => keys.some((k) => w.includes(k))).map(([field]) => field);
  if (!hits.length) return null;
  // "Color" or "service" questions are what they say, even if they mention the car.
  if (hits.includes('vehicle_color')) return 'vehicle_color';
  if (hits.includes('service_interest') && !hits.some((h) => ['vehicle_year', 'vehicle_make', 'vehicle_model'].includes(h))) {
    return 'service_interest';
  }
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
    if (field && !vehicle[field]) vehicle[field] = text;
  }
  return vehicle;
}

// Empty is fine; otherwise a plausible 4-digit model year.
function isValidYear(value) {
  if (value == null || String(value).trim() === '') return true;
  const year = Number(String(value).trim());
  return /^\d{4}$/.test(String(value).trim()) && year >= 1900 && year <= new Date().getFullYear() + 2;
}

module.exports = { VEHICLE_FIELDS, extractVehicle, isValidYear };
