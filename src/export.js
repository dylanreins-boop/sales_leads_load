// Turns leads into an Excel workbook: a summary by vehicle type and lead type,
// every lead on one sheet, and one sheet per vehicle type.
const { buildWorkbook } = require('./xlsx');
const { STAGES, DISPOSITIONS_BY_ID } = require('./pipeline');
const { pipelineLabel } = require('./vehicle');
const { serviceLabels } = require('./services');
const { JOB_STATUSES } = require('./jobs');

const SOURCES = { facebook: 'Facebook', website: 'Website', manual: 'Manual' };
const STATUS = { active: 'Active', old: 'Old', dead: 'Dead', customer: 'Past customer' };
const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label ?? id;

// "2026-10-23 15:07" in the server's time zone (TZ), so it sorts correctly in Excel.
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ACTIVITY = {
  created: 'Lead created', reinquiry: 'Submitted again', stage_change: 'Stage changed', disposition: 'Call',
  note: 'Note', reminder_done: 'Reminder done', email: 'Email', info_updated: 'Lead info updated',
  archived: 'Moved to old leads', restored: 'Restored', job: 'Shop job',
};

function historyText(activities) {
  return activities.map((a) => {
    const what = a.type === 'disposition' ? DISPOSITIONS_BY_ID[a.disposition]?.label || a.disposition
      : a.type === 'stage_change' ? `${stageLabel(a.from_stage)} → ${stageLabel(a.to_stage)}`
        : ACTIVITY[a.type] || a.type;
    const who = a.user_name ? ` (${a.user_name})` : '';
    return `${when(a.created_at)}${who} ${what}${a.note ? `: ${a.note.replace(/\s*\n\s*/g, '; ')}` : ''}`;
  }).join('\n');
}

const vehicleTypeOf = (lead) => lead.vehicle_type || 'No vehicle type';

const COLUMNS = [
  ['Status', 9, (l) => STATUS[l.status]],
  ['Pipeline', 18, (l) => pipelineLabel(l.pipeline)],
  ['Vehicle type', 18, vehicleTypeOf],
  ['Lead type', 11, (l) => SOURCES[l.source] || l.source],
  ['Name', 22, (l) => l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ')],
  ['Phone', 15, (l) => l.phone],
  ['Email', 26, (l) => l.email],
  ['OK to text', 10, (l) => (l.sms_opt_in === 1 ? 'Yes' : l.sms_opt_in === 0 ? 'No' : '')],
  ['Heard about us', 24, (l) => l.heard_about],
  ['Year', 7, (l) => (/^\d{4}$/.test(l.vehicle_year || '') ? Number(l.vehicle_year) : l.vehicle_year)],
  ['Make', 14, (l) => l.vehicle_make],
  ['Model', 18, (l) => l.vehicle_model],
  ['Color', 14, (l) => l.vehicle_color],
  ['Stage', 14, (l) => stageLabel(l.stage)],
  ['Last call outcome', 28, (l) => DISPOSITIONS_BY_ID[l.last_disposition]?.label || ''],
  ['Services booked', 30, (l) => serviceLabels(l.booked_services || [])],
  ['Campaign', 22, (l) => l.campaign],
  ['Form', 18, (l) => l.form_name],
  ['Message', 40, (l) => l.message],
  ['Received', 17, (l) => when(l.received_at)],
  ['Last contacted', 17, (l) => when(l.last_contacted_at)],
  ['Moved to old leads', 17, (l) => when(l.archived_at)],
  ['Job drop-off', 17, (l) => when(l.job?.start_at)],
  ['Job pick-up', 17, (l) => when(l.job?.end_at)],
  ['Job status', 16, (l) => (l.job ? JOB_STATUSES.find((s) => s.id === l.job.status)?.label : '')],
  ['Job amount', 12, (l) => (l.job?.amount_cents != null ? l.job.amount_cents / 100 : '')],
  ['Checklist', 10, (l) => (l.job ? `${l.job.checklist_done}/${l.job.checklist_total}` : '')],
  ['Job photos', 10, (l) => (l.job ? l.job.photo_count : '')],
  ['Job notes', 30, (l) => l.job?.notes],
  ['Notes & history', 80, (l) => historyText(l.activities || [])],
  ['Lead ID', 8, (l) => l.id],
];

function leadSheet(name, leads) {
  return {
    name,
    columns: COLUMNS.map(([header, width]) => ({ header, width })),
    rows: leads.map((l) => COLUMNS.map(([, , value]) => value(l) ?? '')),
  };
}

function summarySheet(leads) {
  const types = [...new Set(leads.map(vehicleTypeOf))].sort();
  const sources = Object.keys(SOURCES).filter((s) => leads.some((l) => l.source === s));
  const count = (type, source) => leads.filter((l) => vehicleTypeOf(l) === type && (!source || l.source === source)).length;
  const rows = types.map((t) => [t, ...sources.map((s) => count(t, s)), count(t)]);
  rows.push(['Total', ...sources.map((s) => leads.filter((l) => l.source === s).length), leads.length]);
  return {
    name: 'Summary',
    columns: [{ header: 'Vehicle type', width: 22 }, ...sources.map((s) => ({ header: SOURCES[s], width: 12 })), { header: 'Total', width: 10 }],
    rows,
  };
}

function leadsWorkbook(leads, { title = 'All Leads' } = {}) {
  const byType = new Map();
  for (const l of leads) {
    const t = vehicleTypeOf(l);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(l);
  }
  const typeSheets = [...byType.keys()].sort().map((t) => leadSheet(t, byType.get(t)));
  return buildWorkbook([summarySheet(leads), leadSheet(title, leads), ...typeSheets]);
}

module.exports = { leadsWorkbook };
