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

// `stage` is where the lead goes; `reminder` is whether a call-tomorrow
// reminder is set by default (the user can override it per disposition).
const DISPOSITIONS = [
  { id: 'no_answer_vm', label: 'No Answer – Left Voicemail', stage: NO_ANSWER, reminder: true },
  { id: 'no_answer', label: 'No Answer – No Voicemail', stage: NO_ANSWER, reminder: true },
  { id: 'contacted_follow_up', label: 'Contacted – Needs Follow Up', stage: 'contacted', reminder: true },
  { id: 'callback_requested', label: 'Contacted – Call Back Requested', stage: 'contacted', reminder: true },
  { id: 'booked', label: 'Appointment Booked', stage: 'booked', reminder: true },
  { id: 'not_interested', label: 'Not Interested', stage: 'waste', reminder: false },
  { id: 'wrong_number', label: 'Wrong / Bad Number', stage: 'waste', reminder: false },
  { id: 'duplicate', label: 'Duplicate Lead', stage: 'waste', reminder: false },
  { id: 'do_not_call', label: 'Do Not Call', stage: 'waste', reminder: false },
];
const DISPOSITIONS_BY_ID = Object.fromEntries(DISPOSITIONS.map((d) => [d.id, d]));

function stageAfterDisposition(currentStage, disposition) {
  if (disposition.stage !== NO_ANSWER) return disposition.stage;
  const i = ATTEMPT_CHAIN.indexOf(currentStage);
  // Leads outside the attempt chain (contacted, booked, ...) stay put.
  if (i === -1) return currentStage;
  return ATTEMPT_CHAIN[Math.min(i + 1, ATTEMPT_CHAIN.length - 1)];
}

function tomorrowAt(hour, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
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
