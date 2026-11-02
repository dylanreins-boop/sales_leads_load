// What the shop spends on ads each month, by lead source, so the source report can show cost per
// lead, cost per booking and what each dollar brought back.
const { HttpError } = require('./leads');
const { parseAmount } = require('./jobs');

const PAID_SOURCES = ['facebook', 'website', 'google', 'referral', 'other'];

function createAdSpendService(db) {
  const stmt = (sql) => db.prepare(sql);
  const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));

  // Spend for the months from..to (inclusive, "YYYY-MM").
  function list({ from, to } = {}) {
    if (!isMonth(from) || !isMonth(to)) throw new HttpError(400, 'Pick the months.');
    return stmt('SELECT month, source, cents, updated_by, updated_at FROM ad_spend WHERE month >= ? AND month <= ? ORDER BY month, source').all(from, to);
  }

  function save({ month, source, amount } = {}, { user } = {}) {
    if (!isMonth(month)) throw new HttpError(400, 'Pick the month.');
    if (!PAID_SOURCES.includes(source)) throw new HttpError(400, 'Pick where the money went.');
    const cents = parseAmount(amount);
    if (cents == null || cents === 0) {
      stmt('DELETE FROM ad_spend WHERE month = ? AND source = ?').run(month, source);
    } else {
      stmt(`INSERT INTO ad_spend (month, source, cents, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (month, source) DO UPDATE SET cents = excluded.cents, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(month, source, cents, user ?? null, new Date().toISOString());
    }
    return list({ from: month, to: month });
  }

  return { list, save };
}

module.exports = { createAdSpendService, PAID_SOURCES };
