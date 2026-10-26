// Pipeline stages, in board order.
const STAGES = [
  { id: 'new', label: 'New / Working' },
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'follow_up_1', label: 'Follow Up 1' },
  { id: 'follow_up_2', label: 'Follow Up 2' },
  { id: 'follow_up_3', label: 'Follow Up 3' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'booked', label: 'Booked' },
  { id: 'waste', label: 'Waste' },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));

// "No answer" dispositions walk a lead down this chain one step per attempt.
const NO_ANSWER = 'advance_attempt';
const ATTEMPT_CHAIN = ['new', 'voicemail', 'follow_up_1', 'follow_up_2', 'follow_up_3'];
// Dispositions that log something without moving the lead.
const KEEP_STAGE = 'keep_stage';

// `stage` is where the lead goes; `reminder` is whether a call-tomorrow
// reminder is set by default (the user can override it per disposition);
// `email` sends the follow-up email template, when the user has turned it on;
// `services` means the rep must pick which services were booked; `schedules` means the job
// must be put on the shop calendar (drop-off and pick-up times).
const DISPOSITIONS = [
  { id: 'no_answer_vm', label: 'No Answer – Left Voicemail', stage: NO_ANSWER, reminder: true, email: true },
  { id: 'no_answer', label: 'No Answer – No Voicemail', stage: NO_ANSWER, reminder: true },
  { id: 'contacted_follow_up', label: 'Contacted – Needs Follow Up', stage: 'contacted', reminder: true },
  { id: 'callback_requested', label: 'Contacted – Call Back Requested', stage: 'contacted', reminder: true },
  { id: 'booked', label: 'Appointment Booked', stage: 'booked', reminder: true, services: true, schedules: true },
  { id: 'updated_notes', label: 'Updated Notes', stage: KEEP_STAGE, reminder: true, call: false },
  { id: 'not_interested', label: 'Not Interested', stage: 'waste', reminder: false },
  { id: 'wrong_number', label: 'Wrong / Bad Number', stage: 'waste', reminder: false },
  { id: 'duplicate', label: 'Duplicate Lead', stage: 'waste', reminder: false },
  { id: 'do_not_call', label: 'Do Not Call', stage: 'waste', reminder: false },
];
const DISPOSITIONS_BY_ID = Object.fromEntries(DISPOSITIONS.map((d) => [d.id, d]));

function stageAfterDisposition(currentStage, disposition) {
  if (disposition.stage === KEEP_STAGE) return currentStage;
  if (disposition.stage !== NO_ANSWER) return disposition.stage;
  const i = ATTEMPT_CHAIN.indexOf(currentStage);
  // Leads outside the attempt chain (contacted, booked, ...) stay put.
  if (i === -1) return currentStage;
  return ATTEMPT_CHAIN[Math.min(i + 1, ATTEMPT_CHAIN.length - 1)];
}

// The next day at `hour`. With skipWeekends, Saturday and Sunday roll on to Monday.
function tomorrowAt(hour, now = new Date(), { skipWeekends = false } = {}) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (skipWeekends && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

module.exports = {
  STAGES,
  STAGE_IDS,
  DISPOSITIONS,
  DISPOSITIONS_BY_ID,
  stageAfterDisposition,
  tomorrowAt,
};
