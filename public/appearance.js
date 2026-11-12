'use strict';
// Appearance: each person's own look (light/dark, colors, background picture), saved to their login,
// on top of the company look admins set for everyone (plus the logos).
// Uses the helpers from app.js ($, h, api, toast, fail, state, showPanel, isAdmin).

// saved: the look in effect, with .company and .mine; scope: which one the panel is editing.
const look = { saved: null, scope: 'mine', draft: {}, bgUrl: null, previewTimer: null };
// The standard look's colors, shown in the color pickers when nothing is set.
const STANDARD = {
  accent: '#004ea2', highlight: '#ffad43',
  bar: '#ffffff', background: '#f1f4f8', panel: '#ffffff', border: '#d8dee7',
  dark_bar: '#00142b', dark_background: '#07111e', dark_panel: '#0f1c2e', dark_border: '#22324a',
};
const COLOR_KEYS = Object.keys(STANDARD);
const PRESETS = [
  { name: 'Bob Moses', colors: {} },
  { name: 'Midnight', colors: { accent: '#0f6fd6', highlight: '#ffad43', bar: '#00142b', background: '#e8edf4', border: '#cfd8e3' } },
  { name: 'Carbon', colors: { accent: '#c8102e', highlight: '#f2b134', bar: '#16181d', background: '#ececee', border: '#d6d6da', dark_bar: '#0b0c0e', dark_background: '#111215', dark_panel: '#1b1d21', dark_border: '#2d3036' } },
  { name: 'Clean white', colors: { accent: '#111827', highlight: '#2563eb', background: '#f8f8f9', border: '#e4e4e7', dark_bar: '#0f1115', dark_background: '#0f1115', dark_panel: '#181b20', dark_border: '#2a2e35' } },
  { name: 'Desert', colors: { accent: '#b5531c', highlight: '#e8b04b', bar: '#3b2a1a', background: '#f6f0e6', panel: '#fffdf8', border: '#e6d9c4', dark_bar: '#1f150c', dark_background: '#17110b', dark_panel: '#251b12', dark_border: '#3e2f20' } },
  { name: 'Forest', colors: { accent: '#1f6f4a', highlight: '#d4a72c', bar: '#0f2a1f', background: '#eef3ef', border: '#d3e0d7', dark_bar: '#0b1a13', dark_background: '#0c1712', dark_panel: '#13261d', dark_border: '#23402f' } },
];
// A preset sets every color (the ones it doesn't list go back to standard).
const presetColors = (p) => Object.fromEntries(COLOR_KEYS.map((k) => [k, p.colors[k] || null]));

// ---------- light / dark ----------
const themeChoice = () => { try { return localStorage.getItem('theme') || ''; } catch { return ''; } };
const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

// Kept on this device too, so the page opens in the right look before anything loads.
function showTheme(choice) {
  try { if (choice) localStorage.setItem('theme', choice); else localStorage.removeItem('theme'); } catch { /* storage unavailable */ }
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice)));
  applyLogo();
}

async function setTheme(choice) {
  showTheme(choice);
  if (!state.meta.currentUser) return;
  try {
    const a = await api('/api/appearance/mine', { method: 'PUT', body: { theme: choice || null } });
    look.saved = a;
  } catch (err) { fail(err); }
}

// ---------- menu icons: an emoji for each menu item, each with its own little animation ----------
// Keyed by the item's data-section, data-open or id. [emoji, animation]
const MENU_ICONS = {
  overview: ['📊', 'pop'], leads: ['🎯', 'hit'], sold: ['🤝', 'jump'], calendar: ['📅', 'flip'], callsBtn: ['📞', 'ring'], updatesBtn: ['🔔', 'bell'],
  leaderboard: ['🏆', 'jump'], analytics: ['📈', 'rise'], commissions: ['💵', 'sway'], revenue: ['💰', 'jingle'],
  time: ['⏰', 'ring'], socialBtn: ['📸', 'flash'],
  messagesBtn: ['💬', 'pop'], emailSettingsBtn: ['✉️', 'fly'], winbackBtn: ['🔁', 'spin'], referralsBtn: ['🎁', 'jump'], automationsBtn: ['⚡', 'zap'],
  teamBtn: ['👥', 'pop'], pricesBtn: ['🏷️', 'swing'], pipelinesBtn: ['🗂️', 'flip'], scoringBtn: ['🔥', 'flicker'], importBtn: ['📥', 'drop'],
  syncFb: ['🔄', 'spin'], syncGoogle: ['🔄', 'spin'], adminLogBtn: ['🛡️', 'pulse'], appearanceBtn: ['🎨', 'wiggle'], signOutBtn: ['🚪', 'swing'],
  todo: ['✅', 'pop'],
};
const GROUP_ICONS = { Workspace: '💼', Performance: '🏁', Operations: '🛠️', Marketing: '📣', Settings: '⚙️' };
const iconChoice = () => { try { return localStorage.getItem('menuIcons') === 'lines' ? 'lines' : 'emoji'; } catch { return 'emoji'; } };

function applyMenuIcons() {
  for (const btn of document.querySelectorAll('.side-item, .bottom-bar button')) {
    const key = btn.dataset.section || btn.dataset.open || btn.id;
    const icon = MENU_ICONS[key];
    if (!icon || btn.querySelector('.emo')) continue;
    const emo = h('span', { class: 'emo', 'aria-hidden': 'true', dataset: { anim: icon[1] } }, icon[0]);
    btn.insertBefore(emo, btn.querySelector('.ico') || btn.firstChild);
    // Plays once when tapped, too (hover already plays it on a computer).
    btn.addEventListener('click', () => { emo.classList.remove('play'); void emo.offsetWidth; emo.classList.add('play'); });
    emo.addEventListener('animationend', () => emo.classList.remove('play'));
  }
  for (const g of document.querySelectorAll('.side-group')) {
    const icon = GROUP_ICONS[g.textContent.trim()];
    if (icon && !g.querySelector('.grp-emo')) g.prepend(h('span', { class: 'grp-emo', 'aria-hidden': 'true' }, icon));
  }
  showIconChoice(iconChoice());
}

// Kept on this device: emoji (the default) or the simple line icons.
function showIconChoice(choice) {
  try { if (choice === 'lines') localStorage.setItem('menuIcons', 'lines'); else localStorage.removeItem('menuIcons'); } catch { /* storage unavailable */ }
  if (choice === 'lines') document.documentElement.dataset.icons = 'lines';
  else delete document.documentElement.dataset.icons;
  document.querySelectorAll('[data-icons-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.iconsChoice === choice)));
}

// ---------- applying the look ----------
function setAppearanceCss(css) {
  let tag = $('#appearanceCss');
  if (!tag) {
    tag = h('style', { id: 'appearanceCss' });
    document.head.append(tag);
  }
  tag.textContent = css || '';
}

// Is a color dark enough to need the light (white) logo on it?
function darkColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return false;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

// The top bar's logo: the dark-background one in the dark look, or when the top bar color is dark.
function applyLogo() {
  const a = look.saved;
  const img = document.querySelector('.brand-logo');
  if (!img || !a) return;
  const colors = { ...a, ...(look.previewColors || {}) };
  const bar = isDark() ? colors.dark_bar || STANDARD.dark_bar : colors.bar || STANDARD.bar;
  const onDark = darkColor(bar);
  // The <source> follows the device, not these settings, so the script picks the logo itself
  // (remembering the page's standard logos first).
  const source = img.parentElement.querySelector('source');
  if (!look.standardLogos) look.standardLogos = { light: img.getAttribute('src'), dark: source?.getAttribute('srcset') || img.getAttribute('src') };
  source?.remove();
  img.src = onDark ? a.logo_dark || a.logo || look.standardLogos.dark : a.logo || look.standardLogos.light;
  // The side menu is always dark: it uses the dark-background logo.
  const side = document.querySelector('.side-logo');
  if (side) {
    if (!look.standardSide) look.standardSide = side.getAttribute('src');
    side.src = a.logo_dark || look.standardSide;
  }
}

async function applyBackground(a) {
  if (look.bgUrl) { URL.revokeObjectURL(look.bgUrl); look.bgUrl = null; }
  const body = document.body;
  if (!a.background_image) { body.style.backgroundImage = ''; body.classList.remove('has-bg'); return; }
  try {
    const blob = await (await fetch(a.background_image)).blob();
    look.bgUrl = URL.createObjectURL(blob);
    const fade = 'color-mix(in srgb, var(--bg) var(--bg-dim, 70%), transparent)';
    body.style.setProperty('--bg-dim', `${a.background_dim ?? 70}%`);
    body.style.backgroundImage = `linear-gradient(${fade}, ${fade}), url("${look.bgUrl}")`;
    body.classList.add('has-bg');
  } catch { /* keep the plain background */ }
}

function applyAppearance(a) {
  look.saved = a;
  look.previewColors = null;
  // Light/dark follows the login; this device's copy catches up.
  if (a.mine && (a.theme || '') !== themeChoice()) showTheme(a.theme || '');
  setAppearanceCss(a.css);
  applyLogo();
  applyBackground(a);
}

// ---------- the panel ----------
const editing = () => look.saved[look.scope] || {};
// What a color shows when it isn't set: in my look the company's, in the company look the standard.
const fallback = (key) => (look.scope === 'mine' ? look.saved.company[key] || STANDARD[key] : STANDARD[key]);

// Ready-made looks. In my look, "Company look" clears my colors, and the others set every color.
function presetList() {
  if (look.scope === 'company') return PRESETS.map((p) => ({ name: p.name, colors: presetColors(p) }));
  return [
    { name: 'Company look', colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, null])) },
    ...PRESETS.map((p) => ({ name: p.name, colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, p.colors[k] || STANDARD[k]])) })),
  ];
}

function renderAppearance() {
  const a = look.saved;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === themeChoice())));
  const company = look.scope === 'company';
  document.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scope === look.scope)));
  document.querySelectorAll('#appearancePanel .company-only').forEach((el) => { el.hidden = !company; });
  $('#lookIntro').textContent = company
    ? 'What everyone sees unless they change their own look, including the sign-in and booking pages. Changes show here right away; Save to use them.'
    : 'Only for you, on any phone or computer you sign in on. Anything you don\'t change follows the company look. Changes show right away; Save to keep them.';
  $('#colorSave').textContent = company ? 'Save for everyone' : 'Save my look';
  $('#appearanceReset').textContent = company ? 'Go back to the standard Bob Moses look (for everyone)' : 'Use the company look again';

  const mine = editing();
  const colors = { ...pick(mine), ...look.draft };
  const f = $('#colorForm');
  for (const key of COLOR_KEYS) {
    f[key].value = colors[key] || fallback(key);
    const reset = f.querySelector(`[data-default="${key}"]`);
    reset.hidden = !colors[key];
    reset.textContent = company ? 'Default' : 'Company';
    reset.title = company ? 'Back to the standard color' : 'Back to the company color';
  }
  const clear = colors.column_clear ?? (company ? 0 : a.company.column_clear ?? 0);
  f.column_clear.value = clear;
  $('#columnClearValue').textContent = `${clear}%`;

  // Swatches show the look this device is in (light or dark).
  const d = isDark() ? 'dark_' : '';
  $('#themePresets').replaceChildren(...presetList().map((p) => {
    const c = Object.fromEntries(COLOR_KEYS.map((k) => [k, p.colors[k] || fallback(k)]));
    const active = COLOR_KEYS.every((k) => (colors[k] || null) === (p.colors[k] || null));
    return h('button', { type: 'button', class: 'preset', 'aria-pressed': String(active), onclick: () => { look.draft = { ...look.draft, ...p.colors }; renderAppearance(); preview(); } },
      h('span', { class: 'preset-swatch', style: `background:${c[`${d}background`]}` },
        h('i', { style: `background:${c[`${d}bar`]}` }), h('i', { style: `background:${c[`${d}panel`]}; border-color:${c[`${d}border`]}` }),
        h('i', { style: `background:${c.accent}` }), h('i', { style: `background:${c.highlight}` })),
      p.name);
  }));

  for (const box of document.querySelectorAll('.image-setting')) {
    const kind = box.dataset.image;
    const url = kind === 'background' ? mine.background_image : mine[kind];
    const empty = kind !== 'background' ? 'Standard logo'
      : !company && a.company.background_image ? 'Using the company picture' : 'No picture';
    box.querySelector('[data-thumb]').replaceChildren(url ? h('img', { src: url, alt: '' }) : h('span', { class: 'muted' }, empty));
    box.querySelector('[data-remove]').hidden = !url;
  }
  const dim = mine.background_dim ?? a.background_dim ?? 70;
  $('#bgDim').value = dim;
  $('#bgDimValue').textContent = `${dim}%`;
  $('#bgDim').closest('label').hidden = !(mine.background_image || (!company && a.company.background_image));
}
const pick = (a) => ({ ...Object.fromEntries(COLOR_KEYS.map((k) => [k, a[k] || null])), column_clear: a.column_clear ?? null });

// Shows the panel's colors on the whole app without saving.
function preview() {
  clearTimeout(look.previewTimer);
  look.previewTimer = setTimeout(async () => {
    try {
      const values = { ...pick(editing()), ...look.draft };
      const { css } = await api('/api/appearance/preview', { method: 'POST', body: { scope: look.scope, values } });
      setAppearanceCss(css);
      look.previewColors = Object.fromEntries(COLOR_KEYS.map((k) => [k, values[k] || (look.scope === 'mine' ? look.saved.company[k] : null)]));
      applyLogo();
    } catch (err) { fail(err); }
  }, 120);
}

// The address for this scope: my look, or the company look.
const scopeUrl = (path = '') => (look.scope === 'mine' ? `/api/appearance/mine${path}` : `/api/appearance${path}`);

async function openAppearance() {
  try { look.saved = await api('/api/appearance'); } catch (err) { return fail(err); }
  look.draft = {};
  look.scope = 'mine';
  renderAppearance();
  showPanel($('#appearancePanel'));
}

function switchScope(scope) {
  if (scope === look.scope) return;
  if (Object.keys(look.draft).length) undoColors();
  look.scope = scope;
  renderAppearance();
}

async function saveColors(e) {
  e.preventDefault();
  try {
    applyAppearance(await api(scopeUrl(), { method: 'PUT', body: { ...pick(editing()), ...look.draft } }));
    look.draft = {};
    renderAppearance();
    toast(look.scope === 'company' ? 'Colors saved for everyone' : 'Your look is saved');
  } catch (err) { fail(err); }
}

function undoColors() {
  look.draft = {};
  look.previewColors = null;
  applyLogo();
  setAppearanceCss(look.saved.css);
  renderAppearance();
}

// Pictures are resized in the browser first: backgrounds to 2400px wide JPEG, logos to 800px PNG.
async function resizeImage(file, max, type) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('resize failed'))), type, 0.85));
  } catch {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file;
    throw new Error(`${file.name} isn't a picture format the app can use. Save it as JPEG or PNG.`);
  }
}

async function uploadImage(e) {
  const kind = e.target.dataset.upload;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = kind === 'background' ? await resizeImage(file, 2400, 'image/jpeg') : await resizeImage(file, 800, 'image/png');
    const res = await fetch(kind === 'background' ? scopeUrl('/background') : `/api/appearance/${kind}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    applyAppearance(data);
    if (Object.keys(look.draft).length) preview();
    renderAppearance();
    toast(kind === 'background' ? 'Background picture saved' : 'Logo saved');
  } catch (err) { fail(err); }
}

async function removeImage(kind) {
  try {
    applyAppearance(await api(kind === 'background' ? scopeUrl('/background') : `/api/appearance/${kind}`, { method: 'DELETE' }));
    renderAppearance();
  } catch (err) { fail(err); }
}

async function saveDim(e) {
  try {
    applyAppearance(await api(scopeUrl(), { method: 'PUT', body: { background_dim: Number(e.target.value) } }));
    if (Object.keys(look.draft).length) preview();
    renderAppearance();
  } catch (err) { fail(err); }
}

async function resetAppearance() {
  const company = look.scope === 'company';
  if (!await askConfirm(company ? 'Reset the look for everyone?' : 'Use the company look again?', company
    ? 'Go back to the standard colors and logo, and remove the background picture, for everyone.'
    : 'Clear your own colors and background picture and use the company look again.', { ok: 'Reset' })) return;
  try {
    applyAppearance(await api(scopeUrl('/reset'), { method: 'POST' }));
    look.draft = {};
    renderAppearance();
    toast(company ? 'Back to the standard look' : 'You\'re on the company look again');
  } catch (err) { fail(err); }
}

function initAppearance() {
  applyMenuIcons();
  document.querySelectorAll('[data-icons-choice]').forEach((b) => b.addEventListener('click', () => showIconChoice(b.dataset.iconsChoice)));
  api('/api/appearance').then(applyAppearance).catch(() => {});
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyLogo);
  $('#appearanceBtn').addEventListener('click', openAppearance);
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeChoice)));
  document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => switchScope(b.dataset.scope)));
  const f = $('#colorForm');
  f.addEventListener('submit', saveColors);
  f.addEventListener('input', (e) => {
    if (!e.target.name) return;
    look.draft[e.target.name] = e.target.name === 'column_clear' ? Number(e.target.value) : e.target.value;
    renderAppearance();
    preview();
  });
  f.addEventListener('click', (e) => {
    const key = e.target.dataset?.default;
    if (!key) return;
    look.draft[key] = null;
    renderAppearance();
    preview();
  });
  $('#colorUndo').addEventListener('click', undoColors);
  document.querySelectorAll('[data-upload]').forEach((input) => input.addEventListener('change', uploadImage));
  document.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeImage(b.dataset.remove)));
  $('#bgDim').addEventListener('input', (e) => {
    $('#bgDimValue').textContent = `${e.target.value}%`;
    document.body.style.setProperty('--bg-dim', `${e.target.value}%`);
  });
  $('#bgDim').addEventListener('change', saveDim);
  $('#appearanceReset').addEventListener('click', resetAppearance);
}
