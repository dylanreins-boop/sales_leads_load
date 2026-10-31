// How the app looks. Admins set the company look (colors, background picture, logos) that everyone
// starts from; each person can change their own colors, background picture and light/dark choice on
// top of it, saved to their account so it follows them to any device.
// The colors are served as /appearance.css (loaded by every page right after styles.css, and made for
// whoever is signed in) so there's no flash of the default look; /api/appearance has everything else.
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
// A person's own look: anything left null comes from the company look.
const MINE_DEFAULTS = { ...Object.fromEntries(COLORS.map((k) => [k, null])), column_clear: null, background_image: null, background_dim: null, theme: null };
const THEMES = ['light', 'dark'];
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
  const norm = (name) => String(name ?? '').trim().toLowerCase();
  const parse = (text, fallback) => { try { return { ...fallback, ...(text ? JSON.parse(text) : {}) }; } catch { return { ...fallback }; } };
  const removeFile = (file) => file && fs.rm(path.join(photosDir, path.basename(file)), { force: true }, () => {});

  // ---- storage: the company look in settings, each person's look with their other preferences ----
  const company = () => parse(stmt("SELECT value FROM settings WHERE key = 'appearance'").get()?.value, DEFAULTS);
  const mine = (name) => parse(stmt('SELECT appearance FROM user_prefs WHERE name_norm = ?').get(norm(name))?.appearance, MINE_DEFAULTS);
  function store(who, value) {
    if (!who) {
      stmt("INSERT INTO settings (key, value) VALUES ('appearance', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(value));
      return;
    }
    stmt(`INSERT INTO user_prefs (name_norm, name, appearance, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (name_norm) DO UPDATE SET appearance = excluded.appearance, updated_at = excluded.updated_at`)
      .run(norm(who), who, JSON.stringify(value), new Date().toISOString());
  }
  const read = (who) => (who ? mine(who) : company());

  // The company look with a person's own choices on top.
  function merged(who) {
    const c = company();
    if (!who) return c;
    const m = mine(who);
    const out = { ...c };
    for (const key of [...COLORS, 'column_clear']) if (m[key] != null) out[key] = m[key];
    if (m.background_image) out.background_image = m.background_image;
    if (m.background_dim != null) out.background_dim = m.background_dim;
    return out;
  }

  const url = (file) => (file ? `/api/appearance/files/${file}` : null);
  const withUrls = (a) => ({ ...a, background_image: url(a.background_image), logo: url(a.logo), logo_dark: url(a.logo_dark) });

  // Everything a page needs: the look in effect (top level), plus the company look and the person's own
  // choices for the Appearance panel.
  function view(who) {
    const m = who ? mine(who) : null;
    return { ...withUrls(merged(who)), css: css(merged(who)), theme: m?.theme ?? null, company: withUrls(company()), mine: m && withUrls(m) };
  }

  // The panel's choices, checked (shared by Save and the live preview). In a person's own look, an
  // empty value means "use the company's".
  function withColors(base, input = {}, personal = false) {
    const next = { ...base };
    for (const key of COLORS) {
      if (!(key in input)) continue;
      const v = input[key];
      if (v == null || v === '') next[key] = null;
      else if (isHex(v)) next[key] = v.toLowerCase();
      else throw new HttpError(400, 'Pick a color.');
    }
    const number = (key, max, what) => {
      if (!(key in input)) return;
      if (personal && (input[key] == null || input[key] === '')) { next[key] = null; return; }
      const n = Number(input[key]);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, what);
      next[key] = Math.round(n);
    };
    number('column_clear', 80, 'See-through goes from 0 to 80%.');
    number('background_dim', 95, 'Dimming goes from 0 to 95%.');
    if (personal && 'theme' in input) {
      if (input.theme && !THEMES.includes(input.theme)) throw new HttpError(400, 'Pick Light, Dark or Match my device.');
      next.theme = input.theme || null;
    }
    return next;
  }

  // who: a person's name for their own look, or null for the company look (admins).
  function save(who, input) {
    store(who, withColors(read(who), input, Boolean(who)));
    return view(who);
  }

  // How the panel's choices would look for this person, without saving them.
  function preview(viewer, scope, input) {
    if (scope === 'company') {
      const draft = withColors(company(), input);
      const m = viewer ? mine(viewer) : MINE_DEFAULTS;
      const out = { ...draft };
      for (const key of [...COLORS, 'column_clear']) if (m[key] != null) out[key] = m[key];
      if (m.background_image) out.background_image = m.background_image;
      return { css: css(out) };
    }
    const draft = withColors(mine(viewer), input, true);
    const out = { ...company() };
    for (const key of [...COLORS, 'column_clear']) if (draft[key] != null) out[key] = draft[key];
    if (draft.background_image) out.background_image = draft.background_image;
    if (draft.background_dim != null) out.background_dim = draft.background_dim;
    return { css: css(out) };
  }

  // Saves an uploaded image, replacing the old one. People can set their own background picture;
  // the logos are the company's.
  function setImage(who, kind, buffer) {
    if (!(kind in IMAGES) || (who && kind !== 'background')) throw new HttpError(404, 'Unknown image');
    if (!buffer?.length) throw new HttpError(400, 'No image was sent.');
    if (buffer.length > IMAGES[kind]) throw new HttpError(413, `That image is too big (keep it under ${IMAGES[kind] / 1e6} MB).`);
    const type = imageType(buffer);
    if (!type) throw new HttpError(415, 'Use a JPEG, PNG or WebP image.');
    const a = read(who);
    fs.mkdirSync(photosDir, { recursive: true });
    const file = `brand-${who ? 'user-bg' : kind.replace('_', '-')}-${crypto.randomUUID()}.${type.ext}`;
    fs.writeFileSync(path.join(photosDir, file), buffer);
    const key = kind === 'background' ? 'background_image' : kind;
    removeFile(a[key]);
    a[key] = file;
    store(who, a);
    return view(who);
  }

  function removeImage(who, kind) {
    if (!(kind in IMAGES) || (who && kind !== 'background')) throw new HttpError(404, 'Unknown image');
    const key = kind === 'background' ? 'background_image' : kind;
    const a = read(who);
    removeFile(a[key]);
    a[key] = null;
    store(who, a);
    return view(who);
  }

  // Back to the standard look (company), or back to the company look (a person; keeps light/dark).
  function reset(who) {
    const a = read(who);
    for (const key of ['background_image', 'logo', 'logo_dark']) removeFile(a[key]);
    store(who, who ? { ...MINE_DEFAULTS, theme: a.theme } : DEFAULTS);
    return view(who);
  }

  // An image file, only if it's one in use (the company's or someone's own background).
  function imagePath(file) {
    const c = company();
    const inUse = [c.background_image, c.logo, c.logo_dark].includes(file)
      || stmt('SELECT appearance FROM user_prefs WHERE appearance IS NOT NULL').all().some((r) => parse(r.appearance, MINE_DEFAULTS).background_image === file);
    if (!inUse) throw new HttpError(404, 'Not found');
    const full = path.join(photosDir, path.basename(file));
    const type = imageType(fs.readFileSync(full).subarray(0, 16));
    return { path: full, mime: type?.mime || 'application/octet-stream' };
  }

  // The CSS for the look this person sees (the company look when nobody is signed in).
  const cssFor = (who) => css(merged(who));

  // The CSS that applies the settings on every page.
  function css(a) {
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

  return { company, mine, merged, view, save, preview, setImage, removeImage, reset, imagePath, cssFor };
}

module.exports = { createAppearanceService, textOn };
