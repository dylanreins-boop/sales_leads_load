'use strict';
// Admin screens opened from the side menu: Lead scoring, Automations, Admin log. They share one side
// panel (#settingsPanel). Uses the helpers from app.js ($, h, fill, api, toast, fail, showPanel, …).

function openSettings(title, sub, ...content) {
  $('#settingsTitle').textContent = title;
  $('#settingsSub').textContent = sub || '';
  fill($('#settingsBody'), ...content);
  showPanel($('#settingsPanel'));
}

// ---- Lead scoring: the points for each rule, and where Hot and Warm start ----
async function openScoring() {
  try {
    const s = await api('/api/settings/lead-score');
    const row = (r) => h('label', { class: 'score-rule' }, h('span', {}, r.label),
      h('input', { type: 'number', name: r.id, min: '-50', max: '50', step: '1', value: s.points[r.id], 'aria-label': `Points for ${r.label}` }));
    const form = h('form', { class: 'score-form', onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/settings/lead-score', { method: 'PUT', body: {
          points: Object.fromEntries(s.rules.map((r) => [r.id, Number(f[r.id].value)])), hot: Number(f.hot.value), warm: Number(f.warm.value),
        } });
        toast('Saved. Every lead\'s score updates right away.');
        loadLeads().catch(() => {});
        if (state.section === 'overview') loadOverview().catch(() => {});
      } catch (err) { fail(err); }
    } },
    h('div', { class: 'score-rules' }, ...s.rules.map(row)),
    h('div', { class: 'score-lines' },
      h('label', {}, 'Hot from', h('input', { type: 'number', name: 'hot', min: '2', max: '100', value: s.hot })),
      h('label', {}, 'Warm from', h('input', { type: 'number', name: 'warm', min: '1', max: '99', value: s.warm })),
      h('p', { class: 'hint' }, 'Below Warm is Cold. Scores are added up and kept between 0 and 100.')),
    h('div', { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Save'),
      h('button', { type: 'button', onclick: () => {
        for (const r of s.rules) form[r.id].value = r.points;
        form.hot.value = 70;
        form.warm.value = 40;
      } }, 'Back to the standard points')));
    openSettings('Lead scoring', 'Each lead gets 0-100 from these rules, so the best ones get called first. Every lead shows which rules counted.',
      h('p', { class: 'hint' }, 'Points can be negative. A rule set to 0 is ignored. This is simple rules, not a prediction: change them as you learn what makes a good lead.'), form);
  } catch (err) { fail(err); }
}

function initAdminScreens() {
  if (!isAdmin()) return;
  $('#scoringBtn').addEventListener('click', openScoring);
}
