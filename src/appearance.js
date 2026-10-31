// How the app looks, set by admins for everyone: the main colors, a background image and the logo.
// The colors are served as /appearance.css (loaded by every page right after styles.css) so there's
// no flash of the default look; /api/appearance has everything for the pages' scripts and the panel.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const { imageType } = require('./jobs');

const COLORS = ['accent', 'highlight', 'bar', 'background'];
const IMAGES = { background: 8_000_000, logo: 2_000_000, logo_dark: 2_000_000 };
const DEFAULTS = { accent: null, highlight: null, bar: null, background: null, background_image: null, background_dim: 70, logo: null, logo_dark: null };
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v));

// Black or white text, whichever reads better on the color.
function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#0e1a2b' : '#ffffff';
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
    const light = [];
    const both = [];
    if (a.accent) {
      both.push(`--accent: ${a.accent}`, `--accent-text: ${textOn(a.accent)}`);
      light.push(`--link: ${a.accent}`);
      out.push(`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --link: color-mix(in srgb, ${a.accent} 55%, #ffffff); } }`,
        `:root[data-theme="dark"] { --link: color-mix(in srgb, ${a.accent} 55%, #ffffff); }`);
    }
    if (a.highlight) both.push(`--highlight: ${a.highlight}`);
    // The header and page colors are for the light look; the dark look keeps its dark colors.
    if (a.bar) {
      const t = textOn(a.bar);
      light.push(`--bar: ${a.bar}`, `--bar-text: ${t}`, `--bar-muted: color-mix(in srgb, ${t} 62%, ${a.bar})`,
        `--bar-field: color-mix(in srgb, ${t} 7%, ${a.bar})`, `--bar-border: color-mix(in srgb, ${t} 20%, ${a.bar})`);
    }
    if (a.background) light.push(`--bg: ${a.background}`);
    // Listed with the dark look's own selectors so these win in both looks.
    if (both.length) out.unshift(`:root, :root:not([data-theme="light"]), :root[data-theme] { ${both.join('; ')}; }`);
    if (light.length) {
      // Light look: picked under Appearance, or "match my device" on a device set to light.
      out.push(`:root[data-theme="light"] { ${light.join('; ')}; }`,
        `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { ${light.join('; ')}; } }`);
    }
    // The background image itself is put in place by the page's script (see applyAppearance).
    if (a.background_image) out.push(`body.app-page { --bg-dim: ${a.background_dim ?? 70}%; }`);
    return `/* Set under Appearance in the app. */\n${out.join('\n')}\n`;
  }

  return { get, view, save, preview, setImage, removeImage, reset, imagePath, css };
}

module.exports = { createAppearanceService, textOn };
