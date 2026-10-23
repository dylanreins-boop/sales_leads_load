// Services a rep picks when booking an appointment. Edit this list to change them.
// `types` limits a service to those vehicle types; leave it out to offer it for everything.
const BOOKING_SERVICES = [
  { id: 'full_decon_coat', label: 'Full decon & coat' },
  { id: 'paint_correction', label: 'Paint correction' },
  { id: 'wheels_windows', label: 'Wheels & windows' },
  { id: 'wheels', label: 'Wheels & calipers only' },
  { id: 'windows', label: 'Windows / glass only' },
  { id: 'trim', label: 'Trim & plastics' },
  { id: 'interior', label: 'Interior protection' },
  { id: 'pop_outs', label: 'Pop-outs / slide-outs', types: ['Coach / RV'] },
  { id: 'roof', label: 'Roof', types: ['Coach / RV'] },
  { id: 'hull', label: 'Hull & gelcoat', types: ['Boat', 'Jet Ski'] },
  { id: 'other', label: 'Other (see notes)' },
];
const SERVICES_BY_ID = Object.fromEntries(BOOKING_SERVICES.map((s) => [s.id, s]));

// Keeps known ids, in list order, without duplicates.
function cleanServices(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  return BOOKING_SERVICES.filter((s) => wanted.has(s.id)).map((s) => s.id);
}

const serviceLabels = (ids) => ids.map((id) => SERVICES_BY_ID[id]?.label ?? id).join(', ');

function parseServices(json) {
  try {
    return cleanServices(JSON.parse(json || '[]'));
  } catch {
    return [];
  }
}

module.exports = { BOOKING_SERVICES, cleanServices, serviceLabels, parseServices };
