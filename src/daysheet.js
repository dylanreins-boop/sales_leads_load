// The day sheet emailed to the shop each work-day morning (the same sheet is on the calendar).
const { HttpError } = require('./leads');
const ShopTime = require('../public/shop-time');

const DEFAULTS = { enabled: false, to: [], hour: 7 };
const clock = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function createDaySheetMailer(db, { jobs, mailer, brand = {} }) {
  const stmt = (sql) => db.prepare(sql);

  function getSettings() {
    const row = stmt("SELECT value FROM settings WHERE key = 'day_sheet'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* keep defaults */ }
    return { ...DEFAULTS, ...saved };
  }

  function saveSettings(input = {}) {
    const next = getSettings();
    if ('enabled' in input) next.enabled = Boolean(input.enabled);
    if ('to' in input) {
      const list = (Array.isArray(input.to) ? input.to : String(input.to || '').split(/[,;\s]+/)).map((s) => s.trim()).filter(Boolean);
      const bad = list.find((e) => !isEmail(e));
      if (bad) throw new HttpError(400, `${bad} isn't an email address.`);
      next.to = [...new Set(list)].slice(0, 10);
    }
    if ('hour' in input) {
      const hour = Number(input.hour);
      if (!Number.isInteger(hour) || hour < 4 || hour > 11) throw new HttpError(400, 'Pick a time between 4 and 11 AM.');
      next.hour = hour;
    }
    if (next.enabled && !next.to.length) throw new HttpError(400, 'Add at least one email address to send the sheet to.');
    stmt("INSERT INTO settings (key, value) VALUES ('day_sheet', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  // Plain-text version of the sheet for email.
  function text(sheet) {
    const title = ShopTime.fromKey(sheet.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const line = (j, when) => [
      `- ${when ? `${when}  ` : ''}${j.customer}${j.phone ? ` (${j.phone})` : ''}`,
      `  ${[j.vehicle, j.color].filter(Boolean).join(', ')}${j.services ? ` · ${j.services}` : ''} · ${j.work} of work`,
      j.notes && `  Notes: ${j.notes}`,
    ].filter(Boolean).join('\n');
    const block = (label, list, when) => `${label} (${list.length})\n${list.length ? list.map((j) => line(j, when?.(j))).join('\n') : '- none'}`;
    return [
      `${brand.name || 'Shop'} day sheet: ${title}`,
      `${ShopTime.hrs(sheet.booked_hours)} of work booked (the shop works ${ShopTime.hrs(sheet.hours_per_day)} a day)${sheet.booked_hours > sheet.hours_per_day ? '  ** OVER **' : ''}`,
      '',
      block('DROP-OFFS', sheet.dropoffs, (j) => clock(j.start_at)),
      '',
      block('PICK-UPS', sheet.pickups, (j) => clock(j.end_at)),
      '',
      block('ALREADY IN THE SHOP', sheet.in_shop),
    ].join('\n');
  }

  // Sends today's sheet once, on work days, at the set hour.
  async function sendDue(at = new Date()) {
    const settings = getSettings();
    if (!settings.enabled || !settings.to.length || !mailer.configured) return false;
    const key = ShopTime.dayKey(at);
    if (!ShopTime.isWorkDay(at, jobs.getShopHours()) || at.getHours() < settings.hour) return false;
    if (stmt("SELECT value FROM settings WHERE key = 'day_sheet_sent'").get()?.value === key) return false;
    stmt("INSERT INTO settings (key, value) VALUES ('day_sheet_sent', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key);
    const sheet = jobs.daySheet(key);
    const subject = `Day sheet ${ShopTime.fromKey(key).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: ${sheet.dropoffs.length} drop-off${sheet.dropoffs.length === 1 ? '' : 's'}, ${sheet.pickups.length} pick-up${sheet.pickups.length === 1 ? '' : 's'}`;
    for (const to of settings.to) {
      await mailer.send({ to, subject, text: text(sheet) }).catch((err) => console.error(`Day sheet to ${to} failed:`, err.message));
    }
    return true;
  }

  return { getSettings, saveSettings, text, sendDue };
}

module.exports = { createDaySheetMailer };
