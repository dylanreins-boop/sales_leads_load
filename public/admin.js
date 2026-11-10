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

// ---- Automations: everything the app does on its own, grouped, with a switch and where to change it ----
async function openAutomations() {
  try {
    const list = await api('/api/automations');
    const groups = [...new Set(list.map((a) => a.group))];
    const goTo = (target) => {
      showPanel(null);
      if (target === 'reviewSettings') return $('#emailSettingsBtn').click();
      if (target === 'daySheet') { showSection('calendar'); setTimeout(() => { setView('sheet'); toggleSheetEmail(); }, 300); return; }
      if (target === 'payrollRules') { showSection('time'); setTimeout(() => $('#tpSettingsBtn').click(), 400); return; }
      document.getElementById(target)?.click();
    };
    const row = (a) => {
      const sw = a.can_switch && h('label', { class: 'switch', title: a.on ? 'On' : 'Off' },
        h('input', { type: 'checkbox', checked: a.on, 'aria-label': `${a.name} on or off`, onchange: async (e) => {
          const box = e.target;
          try {
            const saved = await api(`/api/automations/${a.id}`, { method: 'PATCH', body: { on: box.checked } });
            toast(`${a.name}: ${saved.on ? 'on' : 'off'}`);
            openAutomations();
          } catch (err) { box.checked = !box.checked; fail(err); }
        } }), h('span', { class: 'slider' }));
      return h('li', { class: `auto-row ${a.on ? 'on' : 'off'}` },
        h('div', { class: 'auto-main' },
          h('div', { class: 'auto-name' }, h('b', {}, a.name),
            a.manual ? h('span', { class: 'auto-tag' }, 'Started by hand') : !a.can_switch ? h('span', { class: 'auto-tag' }, a.on ? 'On' : 'Off') : null),
          h('div', { class: 'auto-when' }, a.when),
          a.on && a.needs.length > 0 && h('div', { class: 'auto-needs' }, `Won't go out until it has: ${a.needs.join(', ')}`)),
        h('div', { class: 'auto-side' }, sw, a.open && h('button', { type: 'button', class: 'link-btn', onclick: () => goTo(a.open) }, 'Change')));
    };
    openSettings('Automations', 'Everything the app does on its own. Switch each one on or off here; Change opens its wording and timing.',
      ...groups.map((g) => h('section', { class: 'card-section' }, h('h3', {}, g), h('ul', { class: 'auto-list' }, ...list.filter((a) => a.group === g).map(row)))),
      h('p', { class: 'hint' }, 'Texts only go to customers who haven\'t replied STOP, and only in the daytime. Every message sent shows on the lead.'));
  } catch (err) { fail(err); }
}

// ---- Admin log: sign-ins, exports, login changes, time and pay, money, settings, deletions ----
const AUDIT_AREAS = { '': 'Everything', signin: 'Sign-ins', team: 'Team', payroll: 'Time & pay', money: 'Money', settings: 'Settings', export: 'Exports', delete: 'Deletions' };
const auditLog = { area: '', rows: [] };
async function openAdminLog(more = false) {
  try {
    const q = new URLSearchParams();
    if (auditLog.area) q.set('area', auditLog.area);
    if (more && auditLog.rows.length) q.set('before', auditLog.rows[auditLog.rows.length - 1].id);
    const rows = await api(`/api/audit?${q}`);
    auditLog.rows = more ? [...auditLog.rows, ...rows] : rows;
    const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    let lastDay = '';
    openSettings('Admin log', 'Who signed in, exported, changed logins, time, pay, money or settings, or deleted something: when, and from what address.',
      h('div', { class: 'seg audit-filter', role: 'group', 'aria-label': 'Show' }, ...Object.entries(AUDIT_AREAS).map(([k, label]) => h('button', {
        type: 'button', 'aria-pressed': String(auditLog.area === k), onclick: () => { auditLog.area = k; openAdminLog(); },
      }, label))),
      auditLog.rows.length ? h('ul', { class: 'audit-list' }, ...auditLog.rows.flatMap((r) => {
        const d = day(r.at);
        const head = d !== lastDay ? h('li', { class: 'audit-day' }, d) : null;
        lastDay = d;
        return [head, h('li', { class: `audit-row ${r.area}${/Wrong|Locked/.test(r.action) ? ' warn' : ''}` },
          h('span', { class: 'audit-time' }, new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
          h('span', { class: 'audit-what' }, h('b', {}, r.user_name || 'Someone'), ` ${r.action}`),
          h('span', { class: 'audit-meta' }, [AUDIT_AREAS[r.area] || r.area, r.ip].filter(Boolean).join(' · ')))];
      })) : h('p', { class: 'muted' }, 'Nothing logged yet.'),
      auditLog.rows.length >= 200 && h('button', { type: 'button', onclick: () => openAdminLog(true) }, 'Show older'),
      h('p', { class: 'hint' }, 'Passwords are never shown here, only that one was changed. Everyday lead work (calls, notes, stages) is on each lead and in Updates.'));
  } catch (err) { fail(err); }
}

function initAdminScreens() {
  if (!isAdmin()) return;
  $('#scoringBtn').addEventListener('click', openScoring);
  $('#automationsBtn').addEventListener('click', openAutomations);
  $('#adminLogBtn').addEventListener('click', () => { auditLog.area = ''; openAdminLog(); });
}
