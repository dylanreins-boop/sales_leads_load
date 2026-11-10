'use strict';
// The dialer (only in the build with CALLS_ENABLED): call a lead from the app, watch the call written
// out live, get call notes to save as the call outcome, work through the call list one lead after
// another, and (admins) review calls. Uses the helpers from app.js ($, h, fill, api, toast, fail, state...).

const dial = { call: null, poll: null, session: null, countdown: null };
const callsOn = () => Boolean(state.meta?.callsEnabled) && state.meta.currentRole !== 'shop';
const secs = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const CALL_STATUS = {
  calling_rep: 'Ringing your phone… pick up to be connected.',
  calling_customer: 'Calling the customer…',
  connected: 'Connected',
  ended: 'Call ended',
  rep_missed: 'You didn\'t pick up, so the customer wasn\'t called.',
  failed: 'The call didn\'t go through.',
};
const DISPO_LABEL = (id) => state.meta.dispositions.find((d) => d.id === id)?.label || id;

// ---------- on a lead ----------
async function renderCalls(lead) {
  const box = $('#callSection');
  if (!callsOn() || !box) { if (box) box.hidden = true; return; }
  box.hidden = false;
  let past = [];
  try { past = await api(`/api/leads/${lead.id}/calls`); } catch { /* shown without history */ }
  if (state.openLeadId !== lead.id) return;
  const live = dial.call && dial.call.lead_id === lead.id ? dial.call : null;
  const ready = state.meta.callsReady || {};
  const missing = [!ready.phone && 'the Twilio keys', !ready.publicUrl && 'PUBLIC_URL'].filter(Boolean);
  fill(box,
    h('div', { class: 'section-head' }, h('h3', {}, 'Calls'),
      lead.phone && h('button', { type: 'button', class: 'primary call-now', disabled: Boolean(dial.call && !['ended', 'rep_missed', 'failed'].includes(dial.call.status)), onclick: () => startCall(lead.id) }, `Call ${lead.phone}`)),
    missing.length > 0 && h('p', { class: 'hint' }, `The dialer needs ${missing.join(' and ')} on the server before calls can go out.`),
    live ? liveCard(live) : null,
    // The last call stays open with its suggested next step; older ones fold away.
    !live && past[0]?.summary ? h('div', { class: 'call-last' }, h('div', { class: 'soc-label' }, 'Last call'), pastCall(past[0], { next: true })) : null,
    past.filter((c) => (live ? c.id !== live.id : c !== past[0] || !c.summary)).length > 0 && h('details', { class: 'call-history' },
      h('summary', {}, `Earlier calls (${past.filter((c) => (live ? c.id !== live.id : c !== past[0] || !c.summary)).length})`),
      ...past.filter((c) => (live ? c.id !== live.id : c !== past[0] || !c.summary)).map((c) => pastCall(c))));
}

function liveCard(c) {
  const done = ['ended', 'rep_missed', 'failed'].includes(c.status);
  const talking = c.status === 'connected' && c.connected_at;
  return h('div', { class: `call-live ${done ? 'done' : 'on'}` },
    h('div', { class: 'call-live-head' },
      !done && h('span', { class: 'work-dot', 'aria-hidden': 'true' }),
      h('strong', {}, CALL_STATUS[c.status] || c.status),
      talking && h('span', { class: 'call-clock', 'data-since': c.connected_at }, secs((Date.now() - new Date(c.connected_at)) / 1000)),
      done && c.talk_seconds > 0 && h('span', { class: 'muted' }, `${secs(c.talk_seconds)} talking`)),
    c.lines?.length > 0 && h('ol', { class: 'call-lines', 'aria-live': 'polite' }, ...c.lines.slice(-8).map((l) => h('li', { class: l.speaker }, h('b', {}, l.speaker === 'rep' ? 'You' : 'Customer'), ' ', l.text))),
    c.status === 'ended' && !c.summary && h('p', { class: 'muted' }, 'Writing the call notes…'),
    c.summary && notesCard(c, { useButton: true }));
}

// The call notes: what the admins review and what the rep saves as the call outcome.
function notesCard(c, { useButton = false, next = useButton } = {}) {
  const n = c.summary;
  const row = (label, value) => ((Array.isArray(value) ? value.length > 0 : Boolean(value))
    ? h('div', { class: 'note-row' }, h('span', {}, label), h('span', {}, Array.isArray(value) ? value.join(' · ') : value)) : null);
  return h('div', { class: 'call-notes' },
    h('p', { class: 'call-summary' }, n.summary),
    row('Wants', n.customer_wants),
    row('Price given', n.price_quoted),
    row('Concerns', n.objections),
    row('Next step', n.next_step),
    c.flag_labels?.length > 0 && h('div', { class: 'call-flags' }, ...c.flag_labels.map((f) => h('span', { class: 'call-flag' }, f))),
    n.coaching_tip && h('p', { class: 'call-tip' }, h('b', {}, 'Tip: '), n.coaching_tip),
    callScoreBox(c),
    n.objection_types?.length > 0 && row('Kind of concern', n.objection_types.map((t) => OBJECTION_LABEL[t] || t)),
    next && n.suggested_action && n.suggested_action !== 'none' && h('div', { class: 'call-next' },
      h('button', { type: 'button', class: 'primary', onclick: () => doSuggested(c) }, `Next: ${ACTION_LABEL[n.suggested_action] || n.suggested_action}${n.suggested_action === 'schedule_callback' && n.callback_at ? ` (${new Date(n.callback_at.replace(' ', 'T')).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })})` : ''}`),
      n.suggested_reason && h('span', { class: 'muted' }, n.suggested_reason)),
    c.summary_source === 'basic' && h('p', { class: 'hint' }, c.summary_error ? `Basic notes: ${c.summary_error}` : 'Basic notes (AI notes turn on with an Anthropic API key).'),
    useButton && h('button', { type: 'button', onclick: () => useNotes(c) }, `Use as the call outcome${c.suggested_disposition ? ` (${DISPO_LABEL(c.suggested_disposition)})` : ''}`));
}

const RUBRIC_LABELS = { opening: 'Opening', discovery: 'Finding out what they need', value: 'Explaining the value', objections: 'Handling concerns', close: 'Asking for the booking' };
const OBJECTION_LABEL = { price: 'Price', timing: 'Timing', partner: 'Checking with someone', shopping: 'Shopping around', need: 'Not sure it\'s needed', other: 'Other' };
const ACTION_LABEL = { send_quote: 'Send a quote', send_booking_link: 'Send a booking link', schedule_callback: 'Schedule the call back', send_info: 'Text them more info', call_again: 'Try them again later' };

// The AI's score for the call, part by part (shown to admins, or to everyone if they turned that on).
function callScoreBox(c) {
  const n = c.summary;
  if (c.score == null || !n?.scores) return null;
  return h('details', { class: 'call-scorecard' },
    h('summary', {}, h('span', { class: `score-pill ${c.score >= 80 ? 'good' : c.score >= 60 ? 'ok' : 'low'}` }, `Call score ${c.score}`),
      n.not_a_missed_chance && h('span', { class: 'muted' }, ' · customer wasn\'t going to buy now (not held against the rep)')),
    h('ul', { class: 'rubric' }, ...Object.entries(RUBRIC_LABELS).map(([id, label]) => h('li', {},
      h('span', {}, label), h('span', { class: 'rubric-dots', 'aria-label': `${n.scores[id]} of 5` }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n.scores[id] ? 'on' : '' })))))),
    h('p', { class: 'hint' }, 'Scored by AI from what was said, 1 to 5 for each part. A guide for coaching, not a grade: check the call before acting on it.'));
}

// The suggested next step, one tap: it fills in or opens the right thing; the rep still saves it.
function doSuggested(c) {
  const n = c.summary;
  const go = (sel) => { const el = $(sel); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return el; };
  if (n.suggested_action === 'send_quote') { go('#quoteSection')?.querySelector('select, input')?.focus(); toast('Build the quote here and send it.'); return; }
  if (n.suggested_action === 'send_booking_link') {
    const sec = go('#bookLinkSection');
    const d = sec?.querySelector('details');
    if (d) d.open = true;
    toast('Make the booking link here; it opens a text to send.');
    return;
  }
  if (n.suggested_action === 'send_info') { go('#textSection')?.querySelector('textarea')?.focus(); toast('Write the text here.'); return; }
  useNotes(c);
  const form = $('#dispoForm');
  if (n.suggested_action === 'schedule_callback') {
    if ([...form.disposition.options].some((o) => o.value === 'callback_requested')) {
      form.disposition.value = 'callback_requested';
      form.disposition.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (form.reminder) { form.reminder.checked = true; form.reminder.dispatchEvent(new Event('change', { bubbles: true })); }
    if (n.callback_at && form.reminder_at) form.reminder_at.value = n.callback_at.replace(' ', 'T');
    toast(n.callback_at ? 'Call back filled in for the time they gave. Check it and save.' : 'Pick the call-back time and save.');
  }
}

function pastCall(c, { next = false } = {}) {
  const when = new Date(c.started_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return h('div', { class: 'call-past' },
    h('div', { class: 'call-past-head' }, h('strong', {}, `${when} · ${c.user_name}`), h('span', { class: 'muted' }, c.talk_seconds ? secs(c.talk_seconds) : CALL_STATUS[c.status] || c.status),
      c.review_score && h('span', { class: 'call-score', title: `Scored by ${c.reviewed_by}` }, `${'★'.repeat(c.review_score)}${'☆'.repeat(5 - c.review_score)}`)),
    c.summary && notesCard(c, { next }),
    c.review_comment && h('p', { class: 'call-coaching' }, h('b', {}, `Coaching from ${c.reviewed_by}: `), c.review_comment));
}

// Fills the call outcome form from the notes; the rep checks it and saves.
function useNotes(c) {
  const form = $('#dispoForm');
  const n = c.summary;
  if (c.suggested_disposition && [...form.disposition.options].some((o) => o.value === c.suggested_disposition)) {
    form.disposition.value = c.suggested_disposition;
    form.disposition.dispatchEvent(new Event('change', { bubbles: true }));
  }
  form.note.value = [n.summary, n.price_quoted && `Price given: ${n.price_quoted}.`, n.objections?.length && `Concerns: ${n.objections.join('; ')}.`, n.next_step && `Next: ${n.next_step}`].filter(Boolean).join(' ');
  form.note.dispatchEvent(new Event('input', { bubbles: true }));
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Call notes filled in. Check them and save the outcome.');
}

async function startCall(leadId) {
  try {
    const me = await api('/api/calls/me');
    if (!me.call_phone) {
      toast('Add your phone for the dialer first (To do → My phone).', 'error');
      showPanel($('#remindersPanel'));
      $('#callPhoneForm')?.call_phone.focus();
      return;
    }
    dial.call = await api(`/api/leads/${leadId}/calls`, { method: 'POST' });
    toast('Calling your phone. Pick up and you\'ll be connected to the customer.');
    watchCall();
  } catch (err) { fail(err); }
}

// Follows the call until its notes are written (or it ends without any).
function watchCall() {
  clearInterval(dial.poll);
  let after = 0;
  const tick = async () => {
    if (!dial.call) return clearInterval(dial.poll);
    try { dial.call = await api(`/api/calls/${dial.call.id}`); } catch { return; }
    const c = dial.call;
    if (state.openLeadId === c.lead_id && state.openLead) {
      const box = $('#callSection .call-live');
      const card = liveCard(c);
      if (box) box.replaceWith(card); else renderCalls(state.openLead);
    }
    renderDialerBar();
    const finished = ['rep_missed', 'failed'].includes(c.status) || (c.status === 'ended' && c.summary);
    if (finished || (c.status === 'ended' && ++after > 30)) clearInterval(dial.poll);
  };
  dial.poll = setInterval(tick, 1500);
  tick();
}

// ---------- the dialer: one lead after another ----------
async function startDialer() {
  try {
    const list = await api('/api/calls/queue');
    if (!list.length) return toast('Nobody to call right now: no call-backs due and no new leads waiting.');
    dial.session = { list, i: 0, paused: false, done: 0 };
    nextInDialer(0);
  } catch (err) { fail(err); }
}

function nextInDialer(step = 1) {
  const s = dial.session;
  if (!s) return;
  clearInterval(dial.countdown);
  s.i += step;
  if (s.i >= s.list.length) { stopDialer(`Done: ${s.done} call${s.done === 1 ? '' : 's'}. The call list is empty.`); return; }
  const next = s.list[s.i];
  dial.call = null;
  renderDialerBar();
  openLead(next.id).then(() => { if (!s.paused) startCall(next.id); });
}

function stopDialer(message) {
  clearInterval(dial.countdown);
  dial.session = null;
  renderDialerBar();
  if (message) toast(message);
}

// After the rep saves the outcome for the dialer's current lead, the next call starts in a few seconds.
function dialerAfterSave(lead) {
  const s = dial.session;
  if (!s || s.list[s.i]?.id !== lead.id) return;
  s.done++;
  let left = 5;
  clearInterval(dial.countdown);
  dial.countdown = setInterval(() => {
    left--;
    renderDialerBar(left);
    if (left <= 0) { clearInterval(dial.countdown); nextInDialer(1); }
  }, 1000);
  renderDialerBar(left);
}

function renderDialerBar(countdown) {
  const bar = $('#dialerBar');
  const s = dial.session;
  bar.hidden = !s;
  if (!s) return;
  const cur = s.list[s.i];
  const next = s.list[s.i + 1];
  const counting = dial.countdown && countdown != null && countdown > 0;
  fill(bar,
    h('div', { class: 'dialer-info' },
      h('strong', {}, `Dialer · ${s.i + 1} of ${s.list.length}`),
      h('span', {}, `${cur.name}${cur.best_time ? ` · best time: ${cur.best_time}` : ''} · ${cur.why}`),
      counting ? h('span', { class: 'dialer-next' }, `Next: ${next ? next.name : 'done'} in ${countdown}s`)
        : h('span', { class: 'muted' }, dial.call ? CALL_STATUS[dial.call.status] || '' : 'Save the call outcome to move on.')),
    h('div', { class: 'dialer-actions' },
      counting && h('button', { type: 'button', onclick: () => { clearInterval(dial.countdown); dial.countdown = null; s.paused = true; renderDialerBar(); } }, 'Pause'),
      !counting && s.paused && h('button', { type: 'button', class: 'primary', onclick: () => { s.paused = false; startCall(cur.id); } }, 'Call now'),
      h('button', { type: 'button', onclick: () => nextInDialer(1) }, 'Skip'),
      h('button', { type: 'button', onclick: () => stopDialer('Dialer stopped.') }, 'Stop')));
}

// ---------- admins: review calls ----------
async function openCallsPanel() {
  showPanel($('#callsPanel'));
  await Promise.all([loadCallsList(), loadCallsCoach()]);
}

// The team's patterns over the last 30 days, and the AI settings (who sees scores, transcripts, how long).
async function loadCallsCoach() {
  try {
    const [c, ai] = await Promise.all([api('/api/calls/coaching'), api('/api/settings/calls')]);
    const max = Math.max(1, ...c.objections.map((o) => o.n));
    const settings = h('form', { class: 'ai-settings', onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/settings/calls', { method: 'PUT', body: { scores: f.scores.value, transcripts: f.transcripts.value, transcript_days: Number(f.days.value || 0) } });
        toast('Saved');
        state.meta.callScores = f.scores.value;
      } catch (err) { fail(err); }
    } },
    h('label', {}, 'Who sees the AI call scores', h('select', { name: 'scores' },
      ...[['admins', 'Admins only (check them first)'], ['everyone', 'Everyone (reps see their own calls\' scores)'], ['off', 'Off (no scores)']].map(([v, t]) => h('option', { value: v, selected: ai.scores === v }, t)))),
    h('label', {}, 'Who can read what was said on a call', h('select', { name: 'transcripts' },
      ...[['everyone', 'Everyone who can open the lead'], ['admins', 'Admins only']].map(([v, t]) => h('option', { value: v, selected: ai.transcripts === v }, t)))),
    h('label', {}, 'Delete what was said after (days; 0 keeps it)', h('input', { name: 'days', type: 'number', min: '0', max: '3650', value: ai.transcript_days })),
    h('p', { class: 'hint' }, 'Calls are never recorded; what was said is written out live. After the days above it\'s deleted and only the short notes stay. Customers hear the call notice set in CALL_NOTICE; have a lawyer confirm it for Nevada and anyone you call out of state.'),
    h('button', { type: 'submit', class: 'primary' }, 'Save'));
    fill($('#callsCoach'),
      h('section', { class: 'card-section calls-coach' },
        h('h3', {}, 'Last 30 days'),
        c.objections.length ? [h('div', { class: 'soc-label' }, 'Concerns customers raised'),
          h('ul', { class: 'coach-bars' }, ...c.objections.map((o) => h('li', {}, h('span', {}, o.label), h('span', { class: 'ov-bar' }, h('i', { style: `width:${Math.round((o.n / max) * 100)}%` })), h('b', {}, o.n))))]
          : h('p', { class: 'muted' }, 'No concerns noted yet.'),
        ai.scores !== 'off' && c.scored_calls ? [h('div', { class: 'soc-label' }, `How the calls went (${c.scored_calls} scored, 1 to 5)`),
          h('ul', { class: 'coach-bars' }, ...c.rubric.map((r) => h('li', { class: c.weakest?.id === r.id ? 'weakest' : '' }, h('span', {}, r.label), h('span', { class: 'ov-bar' }, h('i', { style: `width:${Math.round(((r.avg || 0) / 5) * 100)}%` })), h('b', {}, r.avg ?? '–')))),
          c.weakest && h('p', { class: 'hint' }, `Coaching idea: ${c.weakest.label.toLowerCase()} scores lowest. Pick two calls below and listen for it.`)] : null),
      h('details', { class: 'card-section soc-panel-settings' }, h('summary', {}, h('h3', {}, 'AI call settings')), settings));
  } catch { /* the calls list still works */ }
}

async function loadCallsList() {
  const f = $('#callsFilter');
  const q = new URLSearchParams({ from: new Date(Date.now() - Number(f.period.value) * 86400000).toISOString() });
  if (f.rep.value) q.set('rep', f.rep.value);
  if (f.unreviewed.checked) q.set('reviewed', 'no');
  if (f.flagged.checked) q.set('flagged', 'yes');
  try {
    const list = await api(`/api/calls?${q}`);
    const reps = [...new Set(list.map((c) => c.user_name))];
    if (!f.rep.value) fill(f.rep, h('option', { value: '' }, 'Everyone'), ...reps.map((r) => h('option', { value: r }, r)));
    fill($('#callsList'), list.length ? list.map(callRow) : h('p', { class: 'muted' }, 'No calls match.'));
  } catch (err) { fail(err); }
}

function callRow(c) {
  const when = new Date(c.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return h('details', { class: `call-row ${c.reviewed_at ? 'reviewed' : ''}`, ontoggle: (e) => e.target.open && openCallDetail(e.target, c.id) },
    h('summary', {},
      h('span', { class: 'call-row-who' }, h('strong', {}, c.lead_name), h('span', { class: 'muted' }, ` · ${c.user_name} · ${when}`)),
      h('span', { class: 'call-row-meta' },
        h('span', { class: 'muted' }, c.talk_seconds ? secs(c.talk_seconds) : CALL_STATUS[c.status]),
        c.flag_labels.length > 0 && h('span', { class: 'call-flag' }, `${c.flag_labels.length} flag${c.flag_labels.length === 1 ? '' : 's'}`),
        c.review_score ? h('span', { class: 'call-score' }, '★'.repeat(c.review_score)) : h('span', { class: 'call-flag todo' }, 'To review')),
      c.summary && h('span', { class: 'call-row-summary' }, c.summary.summary)),
    h('div', { class: 'call-detail' }, h('p', { class: 'muted' }, 'Loading…')));
}

async function openCallDetail(details, id) {
  try {
    const c = await api(`/api/calls/${id}`);
    const box = details.querySelector('.call-detail');
    let score = c.review_score || 0;
    const stars = h('div', { class: 'call-stars', role: 'radiogroup', 'aria-label': 'Score' },
      ...[1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(n === score), 'aria-label': `${n} of 5`,
        onclick: (e) => { score = n; e.target.parentElement.querySelectorAll('button').forEach((b, i) => { b.textContent = i < n ? '★' : '☆'; b.setAttribute('aria-checked', String(i + 1 === n)); }); } }, n <= score ? '★' : '☆')));
    fill(box,
      c.summary ? notesCard(c) : h('p', { class: 'muted' }, 'No notes for this call.'),
      c.lines.length > 0 && h('details', { class: 'call-transcript' }, h('summary', {}, `What was said (${c.lines.length} lines)`),
        h('ol', { class: 'call-lines' }, ...c.lines.map((l) => h('li', { class: l.speaker }, h('b', {}, l.speaker === 'rep' ? c.user_name : 'Customer'), ' ', l.text)))),
      h('form', { class: 'call-review', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api(`/api/calls/${id}/review`, { method: 'PATCH', body: { score: score || null, comment: e.target.comment.value } });
          toast(`Review saved${e.target.comment.value.trim() ? `. ${c.user_name} will see the coaching note on the lead.` : ''}`);
          loadCallsList();
        } catch (err) { fail(err); }
      } },
      h('label', {}, 'Score', stars),
      h('label', {}, `Coaching note for ${c.user_name} (optional)`, h('textarea', { name: 'comment', rows: '2', maxlength: '1000', placeholder: 'What went well, what to try next time' }, c.review_comment || '')),
      h('button', { type: 'submit', class: 'primary' }, c.reviewed_at ? 'Update review' : 'Save review')));
  } catch (err) { fail(err); }
}

// ---------- my phone for the dialer ----------
async function loadCallPhone() {
  try {
    const me = await api('/api/calls/me');
    $('#callPhoneForm').call_phone.value = me.call_phone || '';
    if (me.active) { dial.call = me.active; watchCall(); }
  } catch { /* not available */ }
}

function initCalls() {
  if (!callsOn()) return;
  document.querySelectorAll('.dialer-only').forEach((b) => { b.hidden = false; });
  $('#callPhoneForm').hidden = false;
  $('#callPhoneHint').hidden = false;
  $('#callPhoneForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/calls/me', { method: 'PUT', body: { call_phone: e.target.call_phone.value } });
      e.target.call_phone.value = r.call_phone || '';
      toast(r.call_phone ? 'Saved. The dialer will ring this phone.' : 'Removed.');
    } catch (err) { fail(err); }
  });
  $('#dialerBtn').addEventListener('click', startDialer);
  $('#callsBtn').addEventListener('click', openCallsPanel);
  $('#callsFilter').addEventListener('change', loadCallsList);
  setInterval(() => document.querySelectorAll('.call-clock[data-since]').forEach((el) => { el.textContent = secs((Date.now() - new Date(el.dataset.since)) / 1000); }), 1000);
  loadCallPhone();
}
