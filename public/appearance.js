'use strict';
// Appearance: each person's light/dark choice, and the colors, background picture and logo admins set
// for everyone. Uses the helpers from app.js ($, h, api, toast, fail, state, showPanel, isAdmin).

const look = { saved: null, draft: {}, bgUrl: null, previewTimer: null };
// The standard look's colors (light), shown in the color pickers when nothing is set.
const STANDARD = { accent: '#004ea2', highlight: '#ffad43', bar: '#ffffff', background: '#f1f4f8' };
const PRESETS = [
  { name: 'Bob Moses', colors: { accent: null, highlight: null, bar: null, background: null } },
  { name: 'Midnight', colors: { accent: '#0f6fd6', highlight: '#ffad43', bar: '#00142b', background: '#e8edf4' } },
  { name: 'Carbon', colors: { accent: '#c8102e', highlight: '#f2b134', bar: '#16181d', background: '#ececee' } },
  { name: 'Clean white', colors: { accent: '#111827', highlight: '#2563eb', bar: '#ffffff', background: '#f8f8f9' } },
  { name: 'Desert', colors: { accent: '#b5531c', highlight: '#e8b04b', bar: '#3b2a1a', background: '#f6f0e6' } },
  { name: 'Forest', colors: { accent: '#1f6f4a', highlight: '#d4a72c', bar: '#0f2a1f', background: '#eef3ef' } },
];

// ---------- light / dark ----------
const themeChoice = () => { try { return localStorage.getItem('theme') || ''; } catch { return ''; } };
const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

function setTheme(choice) {
  try { if (choice) localStorage.setItem('theme', choice); else localStorage.removeItem('theme'); } catch { /* storage unavailable */ }
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice)));
  applyLogo();
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
  const onDark = isDark() || darkColor(look.previewBar ?? a.bar);
  // The <source> follows the device, not these settings, so the script picks the logo itself
  // (remembering the page's standard logos first).
  const source = img.parentElement.querySelector('source');
  if (!look.standardLogos) look.standardLogos = { light: img.getAttribute('src'), dark: source?.getAttribute('srcset') || img.getAttribute('src') };
  source?.remove();
  img.src = onDark ? a.logo_dark || a.logo || look.standardLogos.dark : a.logo || look.standardLogos.light;
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
  look.previewBar = undefined;
  setAppearanceCss(a.css);
  applyLogo();
  applyBackground(a);
}

// ---------- the panel ----------
function renderAppearance() {
  const a = look.saved;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === themeChoice())));
  if (!isAdmin()) return;
  const colors = { ...pick(a), ...look.draft };
  const f = $('#colorForm');
  for (const key of Object.keys(STANDARD)) {
    f[key].value = colors[key] || STANDARD[key];
    f.querySelector(`[data-default="${key}"]`).hidden = !colors[key];
  }
  $('#themePresets').replaceChildren(...PRESETS.map((p) => {
    const c = { ...STANDARD, ...Object.fromEntries(Object.entries(p.colors).filter(([, v]) => v)) };
    const active = Object.keys(STANDARD).every((k) => (colors[k] || null) === (p.colors[k] || null));
    return h('button', { type: 'button', class: 'preset', 'aria-pressed': String(active), onclick: () => { look.draft = { ...p.colors }; renderAppearance(); preview(); } },
      h('span', { class: 'preset-swatch', style: `background:${c.background}` },
        h('i', { style: `background:${c.bar}` }), h('i', { style: `background:${c.accent}` }), h('i', { style: `background:${c.highlight}` })),
      p.name);
  }));
  for (const box of document.querySelectorAll('.image-setting')) {
    const kind = box.dataset.image;
    const url = kind === 'background' ? a.background_image : a[kind];
    box.querySelector('[data-thumb]').replaceChildren(url
      ? h('img', { src: url, alt: '' })
      : h('span', { class: 'muted' }, kind === 'background' ? 'No picture' : 'Standard logo'));
    box.querySelector('[data-remove]').hidden = !url;
  }
  $('#bgDim').value = a.background_dim ?? 70;
  $('#bgDimValue').textContent = `${a.background_dim ?? 70}%`;
  $('#bgDim').closest('label').hidden = !a.background_image;
}
const pick = (a) => Object.fromEntries(Object.keys(STANDARD).map((k) => [k, a[k] || null]));

// Shows the panel's colors on the whole app without saving.
function preview() {
  clearTimeout(look.previewTimer);
  look.previewTimer = setTimeout(async () => {
    try {
      const { css } = await api('/api/appearance/preview', { method: 'POST', body: { ...pick(look.saved), ...look.draft } });
      setAppearanceCss(css);
      look.previewBar = 'bar' in look.draft ? look.draft.bar : undefined;
      applyLogo();
    } catch (err) { fail(err); }
  }, 120);
}

async function openAppearance() {
  try { look.saved = await api('/api/appearance'); } catch (err) { return fail(err); }
  look.draft = {};
  renderAppearance();
  showPanel($('#appearancePanel'));
}

async function saveColors(e) {
  e.preventDefault();
  try {
    applyAppearance(await api('/api/appearance', { method: 'PUT', body: { ...pick(look.saved), ...look.draft } }));
    look.draft = {};
    renderAppearance();
    toast('Colors saved for everyone');
  } catch (err) { fail(err); }
}

function undoColors() {
  look.draft = {};
  look.previewBar = undefined;
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
    const res = await fetch(`/api/appearance/${kind}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
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
    applyAppearance(await api(`/api/appearance/${kind}`, { method: 'DELETE' }));
    renderAppearance();
  } catch (err) { fail(err); }
}

async function saveDim(e) {
  try {
    applyAppearance(await api('/api/appearance', { method: 'PUT', body: { background_dim: Number(e.target.value) } }));
    if (Object.keys(look.draft).length) preview();
    renderAppearance();
  } catch (err) { fail(err); }
}

async function resetAppearance() {
  if (!window.confirm('Go back to the standard colors and logo, and remove the background picture, for everyone?')) return;
  try {
    applyAppearance(await api('/api/appearance/reset', { method: 'POST' }));
    look.draft = {};
    renderAppearance();
    toast('Back to the standard look');
  } catch (err) { fail(err); }
}

function initAppearance() {
  api('/api/appearance').then(applyAppearance).catch(() => {});
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyLogo);
  $('#appearanceBtn').addEventListener('click', openAppearance);
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeChoice)));
  if (!isAdmin()) return;
  const f = $('#colorForm');
  f.addEventListener('submit', saveColors);
  f.addEventListener('input', (e) => {
    if (!e.target.name) return;
    look.draft[e.target.name] = e.target.value;
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
