// How the app looks, set by admins for everyone: the main colors, a background image and the logo.
// The colors are served as /appearance.css (loaded by every page right after styles.css) so there's
// no flash of the default look; /api/appearance has everything for the pages' scripts and the panel.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const { imageType } = require('./jobs');

// Buttons/links and highlight apply to both looks; the rest is set for the light and dark look separately.
const LOOK_COLORS = ['bar', 'background', 'panel', 'border'];
const COLORS = ['accent', 'highlight', ...LOOK_COLORS, ...LOOK_COLORS.map((k) => `dark_${k}`)];
const IMAGES = { background: 8_000_000, logo: 2_000_000, logo_dark: 2_000_000 };
const DEFAULTS = {
  ...Object.fromEntries(COLORS.map((k) => [k, null])),
  column_clear: 0, background_image: null, background_dim: 70, logo: null, logo_dark: null,
};
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v));

// Black or white text, whichever reads better on the color.
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#0e1a2b' : '#ffffff';
}

// One look's colors: top bar (with readable text on it), page, columns and cards (text follows
// their color so it stays readable), and borders.
function lookVars(a, prefix) {
  const v = [];
  const bar = a[`${prefix}bar`];
  const panel = a[`${prefix}panel`];
  if (bar) {
    const t = textOn(bar);
    v.push(`--bar: ${bar}`, `--bar-text: ${t}`, `--bar-muted: color-mix(in srgb, ${t} 62%, ${bar})`,
      `--bar-field: color-mix(in srgb, ${t} 7%, ${bar})`, `--bar-border: color-mix(in srgb, ${t} 20%, ${bar})`);
  }
  if (a[`${prefix}background`]) v.push(`--bg: ${a[`${prefix}background`]}`);
  if (panel) {
    const t = textOn(panel);
    v.push(`--panel: ${panel}`, `--text: ${t}`, `--muted: color-mix(in srgb, ${t} 62%, ${panel})`);
  }
  if (a[`${prefix}border`]) v.push(`--border: ${a[`${prefix}border`]}`);
  return v;
}

function createAppearanceService(db, { photosDir }) {
  const stmt = (sql) => db.prepare(sql);

  function get() {
    const row = stmt("SELECT value FROM settings WHERE key = 'appearance'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* defaults */ }
    return { ...DEFAULTS, ...saved };
  }
  const put = (value) => stmt("INSERT INTO settings (key, value) VALUES ('appearance', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(value));

  // What the browser needs: colors, and image addresses that change when the image does.
  function view(a = get()) {
    const url = (file) => (file ? `/api/appearance/files/${file}` : null);
    return { ...a, background_image: url(a.background_image), logo: url(a.logo), logo_dark: url(a.logo_dark), css: css(a) };
  }

  // The colors from the panel, checked (shared by Save and the live preview).
  function withColors(input = {}) {
    const next = get();
    for (const key of COLORS) {
      if (!(key in input)) continue;
      const v = input[key];
      if (v == null || v === '') next[key] = null;
      else if (isHex(v)) next[key] = v.toLowerCase();
      else throw new HttpError(400, 'Pick a color.');
    }
    if ('column_clear' in input) {
      const clear = Number(input.column_clear);
      if (!Number.isFinite(clear) || clear < 0 || clear > 80) throw new HttpError(400, 'See-through goes from 0 to 80%.');
      next.column_clear = Math.round(clear);
    }
    if ('background_dim' in input) {
      const dim = Number(input.background_dim);
      if (!Number.isFinite(dim) || dim < 0 || dim > 95) throw new HttpError(400, 'Dimming goes from 0 to 95%.');
      next.background_dim = Math.round(dim);
    }
    return next;
  }

  function save(input) {
    const next = withColors(input);
    put(next);
    return view(next);
  }

  // How the panel's choices would look, without saving them.
  const preview = (input) => ({ css: css(withColors(input)) });

  // Saves an uploaded image (background, logo or dark-background logo), replacing the old one.
  function setImage(kind, buffer) {
    if (!(kind in IMAGES)) throw new HttpError(404, 'Unknown image');
    if (!buffer?.length) throw new HttpError(400, 'No image was sent.');
    if (buffer.length > IMAGES[kind]) throw new HttpError(413, `That image is too big (keep it under ${IMAGES[kind] / 1e6} MB).`);
    const type = imageType(buffer);
    if (!type) throw new HttpError(415, 'Use a JPEG, PNG or WebP image.');
    const a = get();
    fs.mkdirSync(photosDir, { recursive: true });
    const file = `brand-${kind.replace('_', '-')}-${crypto.randomUUID()}.${type.ext}`;
    fs.writeFileSync(path.join(photosDir, file), buffer);
    const key = kind === 'background' ? 'background_image' : kind;
    if (a[key]) fs.rm(path.join(photosDir, path.basename(a[key])), { force: true }, () => {});
    a[key] = file;
    put(a);
    return view(a);
  }

  function removeImage(kind) {
    const key = kind === 'background' ? 'background_image' : kind;
    if (!(kind in IMAGES)) throw new HttpError(404, 'Unknown image');
    const a = get();
    if (a[key]) fs.rm(path.join(photosDir, path.basename(a[key])), { force: true }, () => {});
    a[key] = null;
    put(a);
    return view(a);
  }

  function reset() {
    const a = get();
    for (const key of ['background_image', 'logo', 'logo_dark']) {
      if (a[key]) fs.rm(path.join(photosDir, path.basename(a[key])), { force: true }, () => {});
    }
    put(DEFAULTS);
    return view(DEFAULTS);
  }

  // An image file, only if it's one of the current ones.
  function imagePath(file) {
    const a = get();
    if (![a.background_image, a.logo, a.logo_dark].includes(file)) throw new HttpError(404, 'Not found');
    const type = imageType(fs.readFileSync(path.join(photosDir, path.basename(file))).subarray(0, 16));
    return { path: path.join(photosDir, path.basename(file)), mime: type?.mime || 'application/octet-stream' };
  }

  // The CSS that applies the settings on every page.
  function css(a = get()) {
    const out = [];
    const both = [];
    if (a.accent) both.push(`--accent: ${a.accent}`, `--accent-text: ${textOn(a.accent)}`);
    if (a.highlight) both.push(`--highlight: ${a.highlight}`);
    // Listed with the dark look's own selectors so these win in both looks.
    if (both.length) out.push(`:root, :root:not([data-theme="light"]), :root[data-theme] { ${both.join('; ')}; }`);

    const light = lookVars(a, '');
    if (a.accent) light.push(`--link: ${a.accent}`);
    if (light.length) {
      // Light look: picked under Appearance, or "match my device" on a device set to light.
      out.push(`:root[data-theme="light"] { ${light.join('; ')}; }`,
        `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${light.join('; ')}; } }`);
    }
    const dark = lookVars(a, 'dark_');
    if (a.accent) dark.push(`--link: color-mix(in srgb, ${a.accent} 55%, #ffffff)`);
    if (dark.length) {
      out.push(`:root[data-theme="dark"] { ${dark.join('; ')}; }`,
        `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark.join('; ')}; } }`);
    }
    // See-through columns let the background picture show; a light blur keeps cards readable.
    if (a.column_clear > 0) {
      const keep = 100 - a.column_clear;
      out.push(`.column, .week-col { background: color-mix(in srgb, color-mix(in srgb, var(--panel) 55%, var(--bg)) ${keep}%, transparent); backdrop-filter: blur(6px); }`);
    }
    // The background image itself is put in place by the page's script (see applyAppearance).
    if (a.background_image) out.push(`body.app-page { --bg-dim: ${a.background_dim ?? 70}%; }`);
    return `/* Set under Appearance in the app. */\n${out.join('\n')}\n`;
  }

  return { get, view, save, preview, setImage, removeImage, reset, imagePath, css };
}

module.exports = { createAppearanceService, textOn };
