const { HttpError } = require('./leads');
const { parseAmount } = require('./jobs');

// Deposits and sales commissions on jobs.
// A commission is the rate (10% by default) of the job amount, earned by the rep who booked the job
// (an admin can hand it to someone else or set a different amount). It shows as:
//   pending  - not earned yet (see owed_when)
//   owed     - earned and not paid
//   paid     - an admin marked it paid
//   no_amount / cancelled - nothing to pay
const OWED_WHEN = ['picked_up', 'deposit', 'booked'];
const DEPOSIT_METHODS = ['Cash', 'Card', 'Check', 'Zelle', 'Venmo', 'Other'];
const DEFAULTS = { rate_pct: 10, deposit_pct: 10, owed_when: 'picked_up' };

const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const now = () => new Date().toISOString();
const pctOf = (cents, pct) => (cents == null ? null : Math.round((cents * pct) / 100));

function createCommissionService(db, { leads, jobs }) {
  const stmt = (sql) => db.prepare(sql);

  function getSettings() {
    const row = stmt("SELECT value FROM settings WHERE key = 'commission'").get();
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { /* keep defaults */ }
    return { ...DEFAULTS, ...saved };
  }

  function saveSettings(input = {}) {
    const next = { ...getSettings() };
    for (const key of ['rate_pct', 'deposit_pct']) {
      if (!(key in input)) continue;
      const pct = Number(input[key]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'Percentages go from 0 to 100.');
      next[key] = Math.round(pct * 100) / 100;
    }
    if ('owed_when' in input) {
      if (!OWED_WHEN.includes(input.owed_when)) throw new HttpError(400, 'Pick when commission is owed.');
      next.owed_when = input.owed_when;
    }
    stmt("INSERT INTO settings (key, value) VALUES ('commission', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  // Adds the deposit and commission figures to a job row.
  function figures(job, settings = getSettings()) {
    const rep = job.commission_rep || job.created_by || null;
    const paid = job.commission_paid_at != null;
    const commission = paid ? job.commission_paid_cents
      : job.commission_override_cents ?? pctOf(job.amount_cents, settings.rate_pct);
    const earned = { picked_up: job.status === 'picked_up', deposit: job.deposit_cents != null, booked: true }[settings.owed_when];
    let status;
    if (paid) status = 'paid';
    else if (job.status === 'cancelled') status = 'cancelled';
    else if (commission == null) status = 'no_amount';
    else status = earned ? 'owed' : 'pending';
    return {
      ...job,
      commission_rep: rep,
      commission_cents: commission,
      commission_status: status,
      deposit_due_cents: pctOf(job.amount_cents, settings.deposit_pct),
    };
  }

  // Every job with its commission and deposit, optionally for one rep.
  function list({ rep } = {}) {
    const settings = getSettings();
    const rows = stmt(`SELECT j.id, j.lead_id, j.start_at, j.end_at, j.status, j.created_at, j.created_by, j.picked_up_at,
                         j.amount_cents, j.deposit_cents, j.deposit_method, j.deposit_by, j.deposit_at,
                         j.commission_rep, j.commission_override_cents, j.commission_paid_cents, j.commission_paid_by, j.commission_paid_at,
                         l.full_name, l.first_name, l.last_name, l.phone, l.vehicle_type, l.vehicle_year, l.vehicle_make, l.vehicle_model
                       FROM jobs j JOIN leads l ON l.id = j.lead_id
                       ORDER BY j.start_at DESC`).all().map((j) => figures(j, settings));
    const mine = rep ? rows.filter((j) => (j.commission_rep || '').toLowerCase() === String(rep).toLowerCase()) : rows;
    return { settings, jobs: mine };
  }

  function forJob(id) {
    return figures(jobs.getJob(id));
  }

  // Sales and admins record the deposit when the customer pays it.
  function setDeposit(id, { taken, amount, method } = {}, { user } = {}) {
    const job = jobs.getJob(id);
    if (taken === false) {
      if (job.deposit_cents == null) return forJob(id);
      stmt('UPDATE jobs SET deposit_cents = NULL, deposit_method = NULL, deposit_by = NULL, deposit_at = NULL, updated_at = ? WHERE id = ?').run(now(), id);
      leads.logActivity(job.lead_id, 'deposit', { note: `Deposit marked not taken (was ${money(job.deposit_cents)})`, user });
      return forJob(id);
    }
    const settings = getSettings();
    let cents = amount == null || String(amount).trim() === '' ? pctOf(job.amount_cents, settings.deposit_pct) : parseAmount(amount);
    if (cents == null) throw new HttpError(400, 'Enter the deposit amount, or add the job amount first so it can be worked out.');
    if (cents <= 0) throw new HttpError(400, 'The deposit has to be more than $0.');
    const how = method ? String(method).trim().slice(0, 30) : null;
    if (how && !DEPOSIT_METHODS.includes(how)) throw new HttpError(400, `Pick how they paid: ${DEPOSIT_METHODS.join(', ')}.`);
    stmt('UPDATE jobs SET deposit_cents = ?, deposit_method = ?, deposit_by = ?, deposit_at = ?, updated_at = ? WHERE id = ?')
      .run(cents, how, user ?? null, now(), now(), id);
    leads.logActivity(job.lead_id, 'deposit', { note: `Deposit taken: ${money(cents)}${how ? ` (${how})` : ''}`, user });
    return forJob(id);
  }

  // Admins: who earns it, and an amount other than the standard rate (blank = standard).
  function setCommission(id, input = {}, { user } = {}) {
    const job = forJob(id);
    if (job.commission_status === 'paid') throw new HttpError(400, 'This commission is already paid. Mark it unpaid first to change it.');
    const sets = [];
    const params = [];
    const notes = [];
    if ('rep' in input) {
      const rep = String(input.rep ?? '').trim().slice(0, 40) || null;
      sets.push('commission_rep = ?');
      params.push(rep);
      notes.push(`Commission goes to ${rep || job.created_by || 'nobody'}`);
    }
    if ('amount' in input) {
      const cents = parseAmount(input.amount);
      sets.push('commission_override_cents = ?');
      params.push(cents);
      notes.push(cents == null ? 'Commission set back to the standard rate' : `Commission set to ${money(cents)}`);
    }
    if (!sets.length) return job;
    stmt(`UPDATE jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, now(), id);
    for (const note of notes) leads.logActivity(job.lead_id, 'commission', { note, user });
    return forJob(id);
  }

  // Admins mark owed commissions paid (usually a rep's whole list at once).
  function pay(ids = [], { user, note } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Pick the commissions to mark paid.');
    const ts = now();
    let total = 0;
    const paid = [];
    for (const id of ids.map(Number)) {
      const job = forJob(id);
      if (job.commission_status !== 'owed') continue;
      stmt('UPDATE jobs SET commission_paid_cents = ?, commission_paid_by = ?, commission_paid_at = ?, commission_rep = ? WHERE id = ?')
        .run(job.commission_cents, user ?? null, ts, job.commission_rep, id);
      leads.logActivity(job.lead_id, 'commission', {
        note: `Commission paid to ${job.commission_rep || 'nobody'}: ${money(job.commission_cents)}${note ? ` (${String(note).slice(0, 100)})` : ''}`, user,
      });
      total += job.commission_cents;
      paid.push(id);
    }
    if (!paid.length) throw new HttpError(400, 'None of those are owed right now.');
    return { paid, total_cents: total };
  }

  function unpay(id, { user } = {}) {
    const job = forJob(id);
    if (job.commission_status !== 'paid') throw new HttpError(400, 'That commission isn\'t marked paid.');
    stmt('UPDATE jobs SET commission_paid_cents = NULL, commission_paid_by = NULL, commission_paid_at = NULL WHERE id = ?').run(id);
    leads.logActivity(job.lead_id, 'commission', { note: `Commission payment to ${job.commission_rep} undone (${money(job.commission_cents)})`, user });
    return forJob(id);
  }

  return { getSettings, saveSettings, figures, list, forJob, setDeposit, setCommission, pay, unpay };
}

module.exports = { createCommissionService, DEPOSIT_METHODS, OWED_WHEN };
