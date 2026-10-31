'use strict';
// Texts on a lead (the conversation, saved texts, sending) and the admins' Texts & reminders panel.
// Uses the helpers from app.js ($, h, api, toast, fail, state, showPanel, ...).

const msg = { templates: [], notices: null };
const TEXT_PLACEHOLDERS = ['first_name', 'last_name', 'vehicle', 'rep', 'company', 'company_phone', 'address', 'quote_total', 'drop_off', 'pick_up', 'services'];
const NOTICE_PLACEHOLDERS = ['first_name', 'vehicle', 'company', 'company_phone', 'address', 'drop_off', 'pick_up', 'services'];

// ---------- texts on a lead ----------
function renderTexts(lead) {
  const thread = $('#textThread');
  thread.replaceChildren(...(lead.texts?.length
    ? lead.texts.map((t) => h('li', { class: `bubble ${t.direction} ${t.status}`, title: t.error || '' },
      h('div', { class: 'bubble-body' }, t.body),
      h('div', { class: 'bubble-meta' }, [
        fmtDateTime(t.created_at),
        t.direction === 'out' && (t.user_name || 'Automatic'),
        t.status === 'failed' && `Not sent: ${t.error}`,
      ].filter(Boolean).join(' · '))))
    : [h('li', { class: 'muted empty' }, 'No texts yet')]));
  thread.scrollTop = thread.scrollHeight;

  const form = $('#textForm');
  let why = '';
  if (!lead.phone) why = 'Add a phone number to text this lead.';
  else if (lead.sms_opt_in === 0) why = 'This customer asked not to get texts (they replied STOP).';
  else if (!state.meta.textingConfigured) why = 'Texting isn\'t connected yet. An admin adds the Twilio keys on the server to turn it on.';
  $('#textHint').hidden = !why;
  $('#textHint').textContent = why;
  for (const el of form.elements) el.disabled = Boolean(why);
  $('#textTemplate').replaceChildren(h('option', { value: '' }, 'Start from a saved text…'),
    ...msg.templates.map((t) => h('option', { value: t.id }, t.label)));
  if (state.textLeadId !== lead.id) {
    form.body.value = '';
    state.textLeadId = lead.id;
  }
  countText();
}

// Texts over 160 characters go out as several messages (and cost a little more).
function countText() {
  const n = $('#textForm').body.value.length;
  const parts = n > 160 ? Math.ceil(n / 153) : 1;
  $('#textCount').textContent = n ? `${n} characters${parts > 1 ? ` · ${parts} messages` : ''}` : '';
}

async function fillFromTemplate(e) {
  const id = e.target.value;
  if (!id) return;
  try {
    const { body } = await api(`/api/leads/${state.openLeadId}/texts/fill`, { method: 'POST', body: { template_id: id } });
    const box = $('#textForm').body;
    box.value = body;
    box.focus();
    countText();
  } catch (err) { fail(err); }
  e.target.value = '';
}

async function sendLeadText(e) {
  e.preventDefault();
  const form = e.target;
  if (!form.body.value.trim()) { form.body.classList.add('invalid'); form.body.focus(); return; }
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { lead } = await api(`/api/leads/${state.openLeadId}/texts`, { method: 'POST', body: { body: form.body.value } });
    form.body.value = '';
    renderLead(lead);
    toast('Text sent');
  } catch (err) {
    fail(err);
    if (state.openLeadId) openLead(state.openLeadId);
  } finally { button.disabled = false; }
}

// After a booking: say how the customer was told.
function reportConfirmation(confirmation) {
  if (!confirmation || confirmation.off) return;
  const how = confirmation.sent.join(' and ');
  if (how) toast(`Booking confirmation sent by ${how}`);
  if (confirmation.problems?.length) toast(`Confirmation problem: ${confirmation.problems[0]}`, 'error');
}

// ---------- Texts & reminders panel (admins) ----------
function placeholderChips(target, names, field) {
  target.replaceChildren(...names.map((p) => h('button', {
    type: 'button',
    class: 'chip',
    title: 'Insert into the message you were last typing in',
    onclick: () => {
      const box = field();
      if (!box) return toast('Click into a message first', 'error');
      const at = box.selectionStart ?? box.value.length;
      box.setRangeText(`{{${p}}}`, at, box.selectionEnd ?? at, 'end');
      box.focus();
    },
  }, `{{${p}}}`)));
}

let lastNoticeField = null;
let lastTemplateField = null;

async function openMessagesPanel() {
  try {
    [msg.notices, msg.templates] = await Promise.all([api('/api/settings/notices'), api('/api/texts/templates')]);
  } catch (err) { return fail(err); }
  const n = msg.notices;
  const status = $('#messagesStatus');
  const missing = [!n.textingConfigured && 'texting (Twilio keys)', !n.emailConfigured && 'email'].filter(Boolean);
  status.hidden = !missing.length;
  status.textContent = `Not connected yet: ${missing.join(' and ')}. You can set up the messages now; they go out once the server has the keys.`;
  const form = $('#noticesForm');
  for (const key of ['confirm_enabled', 'reminder_enabled', 'by_text', 'by_email']) form[key].checked = n[key];
  for (const key of ['confirm_text', 'confirm_subject', 'confirm_email', 'reminder_text', 'reminder_subject', 'reminder_email']) form[key].value = n[key];
  form.reminder_hour.replaceChildren(...Array.from({ length: 15 }, (_, i) => i + 6).map((hr) => h('option', { value: hr, selected: hr === n.reminder_hour },
    new Date(2026, 0, 1, hr).toLocaleTimeString([], { hour: 'numeric' }))));
  renderTemplateRows();
  showPanel($('#messagesPanel'));
}

function renderTemplateRows() {
  $('#templateRows').replaceChildren(...msg.templates.map((t, i) => h('div', { class: 'template-row' },
    h('div', { class: 'template-row-head' },
      h('input', { value: t.label, maxlength: '40', 'aria-label': 'Name', placeholder: 'Name', oninput: (e) => { t.label = e.target.value; } }),
      h('button', { type: 'button', class: 'icon-btn remove', 'aria-label': `Remove ${t.label}`, title: 'Remove', onclick: () => { msg.templates.splice(i, 1); renderTemplateRows(); } }, '×')),
    h('textarea', { rows: '3', maxlength: '1000', 'aria-label': `${t.label} message`, oninput: (e) => { t.body = e.target.value; }, onfocus: (e) => { lastTemplateField = e.target; } }, t.body))));
}

async function saveNotices(e) {
  e.preventDefault();
  const f = e.target;
  const body = { reminder_hour: Number(f.reminder_hour.value) };
  for (const key of ['confirm_enabled', 'reminder_enabled', 'by_text', 'by_email']) body[key] = f[key].checked;
  for (const key of ['confirm_text', 'confirm_subject', 'confirm_email', 'reminder_text', 'reminder_subject', 'reminder_email']) body[key] = f[key].value;
  try {
    msg.notices = { ...msg.notices, ...await api('/api/settings/notices', { method: 'PUT', body }) };
    toast('Automatic messages saved');
  } catch (err) { fail(err); }
}

async function saveTemplates(e) {
  e.preventDefault();
  try {
    msg.templates = await api('/api/texts/templates', { method: 'PUT', body: { templates: msg.templates } });
    renderTemplateRows();
    toast('Saved texts updated');
  } catch (err) { fail(err); }
}

function initMessages() {
  if (state.meta.currentRole === 'shop') return;
  api('/api/texts/templates').then((t) => {
    msg.templates = t;
    if (state.openLead) renderTexts(state.openLead);
  }).catch(() => {});
  $('#textForm').addEventListener('submit', sendLeadText);
  $('#textForm').body.addEventListener('input', (e) => { e.target.classList.remove('invalid'); countText(); });
  $('#textTemplate').addEventListener('change', fillFromTemplate);
  $('#messagesBtn').addEventListener('click', openMessagesPanel);
  $('#noticesForm').addEventListener('submit', saveNotices);
  $('#noticesForm').addEventListener('focusin', (e) => { if (e.target.matches('textarea, input:not([type=checkbox])')) lastNoticeField = e.target; });
  $('#templatesForm').addEventListener('submit', saveTemplates);
  $('#addTemplate').addEventListener('click', () => {
    msg.templates.push({ id: '', label: 'New text', body: 'Hi {{first_name}}, ' });
    renderTemplateRows();
    $('#templateRows').lastElementChild?.querySelector('textarea')?.focus();
  });
  placeholderChips($('.placeholder-chips[data-for="notices"]'), NOTICE_PLACEHOLDERS, () => lastNoticeField);
  placeholderChips($('.placeholder-chips[data-for="templates"]'), TEXT_PLACEHOLDERS, () => lastTemplateField);
}
