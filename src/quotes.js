const { HttpError } = require('./leads');
const { renderTemplate } = require('./email');

// Starting price list. Admins change it from the Price list panel (saved in settings).
const DEFAULT_PRICES = {
  vehicle: [
    { id: 'pkg800', label: 'Coating package', price_cents: 80000 },
    { id: 'pkg1300', label: 'Coating package', price_cents: 130000 },
    { id: 'pkg1400', label: 'Coating package', price_cents: 140000 },
    { id: 'pkg1700', label: 'Coating package', price_cents: 170000 },
  ],
  rv: [
    // $130/ft is the body only; $150/ft includes windows and slide-outs.
    { id: 'rv130', label: 'RV / trailer, no wheels or windows', per_foot_cents: 13000 },
    { id: 'rv150', label: 'RV / trailer, windows & slides included', per_foot_cents: 15000 },
  ],
  addons: [
    { id: 'wheels_windows', label: 'Wheels & windows', price_cents: null },
  ],
};

const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const now = () => new Date().toISOString();
const clean = (v) => (v == null ? '' : String(v).trim());

// "$1,250" / "1250.5" / 1250 -> cents; blank -> null.
function toCents(value, what) {
  if (value == null || clean(value) === '') return null;
  const text = clean(value).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new HttpError(400, `Enter ${what} in dollars, like 1300 or 1,300.00.`);
  return Math.round(Number(text) * 100);
}

function slug(label, used) {
  const base = clean(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

// Checks a price list sent from the Price list panel.
function cleanPriceList(input = {}) {
  const used = new Set();
  const rows = (list) => (Array.isArray(list) ? list : []).filter((r) => clean(r?.label));
  const vehicle = rows(input.vehicle).map((r) => ({
    id: clean(r.id) || slug(r.label, used), label: clean(r.label).slice(0, 80), price_cents: toCents(r.price ?? (r.price_cents != null ? r.price_cents / 100 : null), `the ${clean(r.label)} price`),
  }));
  const rv = rows(input.rv).map((r) => ({
    id: clean(r.id) || slug(r.label, used), label: clean(r.label).slice(0, 80), per_foot_cents: toCents(r.per_foot ?? (r.per_foot_cents != null ? r.per_foot_cents / 100 : null), `the ${clean(r.label)} price per foot`),
  }));
  const addons = rows(input.addons).map((r) => ({
    id: clean(r.id) || slug(r.label, used), label: clean(r.label).slice(0, 80), price_cents: toCents(r.price ?? (r.price_cents != null ? r.price_cents / 100 : null), `the ${clean(r.label)} price`),
  }));
  for (const r of [...vehicle, ...rv]) {
    if ((r.price_cents ?? r.per_foot_cents) == null) throw new HttpError(400, `Add a price for ${r.label}.`);
  }
  if (!vehicle.length && !rv.length) throw new HttpError(400, 'Keep at least one vehicle package or RV rate.');
  return { vehicle, rv, addons };
}

function createQuoteService(db, { leads, brand = {} }) {
  const stmt = (sql) => db.prepare(sql);

  function getPrices() {
    const row = stmt("SELECT value FROM settings WHERE key = 'price_list'").get();
    if (!row) return DEFAULT_PRICES;
    try { return JSON.parse(row.value); } catch { return DEFAULT_PRICES; }
  }

  function savePrices(input) {
    const prices = cleanPriceList(input);
    stmt("INSERT INTO settings (key, value) VALUES ('price_list', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(prices));
    return prices;
  }

  // Turns the rep's picks into priced lines. Prices always come from the saved price list.
  function priceQuote({ base, feet, addons = [], custom = [], discount } = {}) {
    const prices = getPrices();
    const lines = [];
    const pkg = prices.vehicle.find((p) => p.id === base);
    const rate = prices.rv.find((r) => r.id === base);
    if (pkg) {
      lines.push({ label: pkg.label, detail: money(pkg.price_cents), cents: pkg.price_cents });
    } else if (rate) {
      const length = Number(feet);
      if (!Number.isFinite(length) || length <= 0 || length > 80) throw new HttpError(400, 'Enter the length in feet (for example 38).');
      const ft = Math.round(length * 10) / 10;
      lines.push({ label: rate.label, detail: `${ft} ft × ${money(rate.per_foot_cents)}/ft`, cents: Math.round(ft * rate.per_foot_cents) });
    } else if (base) {
      throw new HttpError(400, 'That package is no longer on the price list. Pick another.');
    }
    for (const id of Array.isArray(addons) ? addons : []) {
      const addon = prices.addons.find((a) => a.id === id);
      if (!addon) continue;
      if (addon.price_cents == null) {
        throw new HttpError(400, `${addon.label} doesn't have a price yet. Add it on the price list, or add it as a custom line.`);
      }
      lines.push({ label: addon.label, detail: '', cents: addon.price_cents });
    }
    for (const c of Array.isArray(custom) ? custom : []) {
      if (!clean(c?.label) && clean(c?.price) === '') continue;
      if (!clean(c.label)) throw new HttpError(400, 'Name each custom line.');
      const cents = toCents(c.price, `the price for ${clean(c.label)}`);
      if (cents == null) throw new HttpError(400, `Add a price for ${clean(c.label)}.`);
      lines.push({ label: clean(c.label).slice(0, 80), detail: '', cents });
    }
    const off = toCents(discount, 'the discount');
    const subtotal = lines.reduce((n, l) => n + l.cents, 0);
    if (off) {
      if (off > subtotal) throw new HttpError(400, 'The discount is bigger than the quote.');
      lines.push({ label: 'Discount', detail: '', cents: -off });
    }
    if (!lines.length) throw new HttpError(400, 'Pick a package or RV rate, or add a line.');
    return { lines, total_cents: subtotal - (off || 0) };
  }

  const shape = (q) => (q ? { ...q, lines: JSON.parse(q.lines) } : null);
  const listQuotes = (leadId) => stmt('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC').all(leadId).map(shape);
  const getQuote = (id) => {
    const q = shape(stmt('SELECT * FROM quotes WHERE id = ?').get(id));
    if (!q) throw new HttpError(404, 'Quote not found');
    return q;
  };

  function saveQuote(leadId, input = {}, { user } = {}) {
    leads.getLead(leadId);
    const { lines, total_cents } = priceQuote(input);
    const note = clean(input.note).slice(0, 1000) || null;
    const { lastInsertRowid } = stmt(`INSERT INTO quotes (lead_id, lines, total_cents, note, created_by, created_at)
                                      VALUES (?, ?, ?, ?, ?, ?)`).run(leadId, JSON.stringify(lines), total_cents, note, user ?? null, now());
    const summary = lines.map((l) => `${l.label}${l.detail ? ` (${l.detail})` : ''} ${money(l.cents)}`).join(' + ');
    leads.logActivity(leadId, 'quote', { note: `Quote ${money(total_cents)}: ${summary}`, user });
    return getQuote(Number(lastInsertRowid));
  }

  // Plain-text quote email for the customer.
  function quoteEmail(quoteId) {
    const quote = getQuote(quoteId);
    const lead = leads.getLead(quote.lead_id);
    if (!lead.email) throw new HttpError(400, 'Add the customer\'s email in Lead info first.');
    const width = Math.max(...quote.lines.map((l) => `${l.label}${l.detail ? ` (${l.detail})` : ''}`.length), 5);
    const row = (left, cents) => `${left.padEnd(width + 2)}${money(cents)}`;
    const text = [
      'Hi {{first_name}},',
      '',
      `Thanks for talking with ${brand.name || 'us'}. Here is your quote for your {{vehicle}}:`,
      '',
      ...quote.lines.map((l) => row(`${l.label}${l.detail ? ` (${l.detail})` : ''}`, l.cents)),
      '-'.repeat(width + 12),
      row('Total', quote.total_cents),
      ...(quote.note ? ['', quote.note] : []),
      '',
      `To book, reply to this email${brand.phone ? ` or call ${brand.phone}` : ''}.`,
      '',
      brand.name || '',
      [brand.city, brand.website].filter(Boolean).join(' · '),
    ].join('\n');
    return {
      quote,
      message: { to: lead.email, subject: renderTemplate(`Your quote from ${brand.name || 'us'}, {{first_name}}`, lead), text: renderTemplate(text, lead) },
    };
  }

  function markEmailed(quoteId, to) {
    stmt('UPDATE quotes SET emailed_at = ?, emailed_to = ? WHERE id = ?').run(now(), to, quoteId);
    return getQuote(quoteId);
  }

  return { getPrices, savePrices, priceQuote, saveQuote, listQuotes, getQuote, quoteEmail, markEmailed };
}

module.exports = { createQuoteService, DEFAULT_PRICES };
