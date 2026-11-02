// Payments on jobs after the deposit: the final payment at pick-up (or any partial payment) and
// refunds. The balance due is the job amount less the deposit and payments. Field names start with
// amount_ so shop logins never get them (see hideAmount).
const { HttpError } = require('./leads');
const { parseAmount } = require('./jobs');
const { DEPOSIT_METHODS } = require('./commissions');

const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function createPaymentService(db, { leads, jobs }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  const list = (jobId) => stmt('SELECT * FROM job_payments WHERE job_id = ? ORDER BY paid_at, id').all(jobId);

  // Adds what's been paid and what's still due to a job row (deposit + payments - refunds).
  function decorate(job) {
    const rows = list(job.id);
    const payments = rows.reduce((sum, p) => sum + (p.kind === 'refund' ? -p.cents : p.cents), 0);
    const paid = (job.deposit_cents || 0) + payments;
    return {
      ...job,
      amount_payments: rows,
      amount_paid_cents: paid,
      amount_due_cents: job.amount_cents == null || job.status === 'cancelled' ? null : Math.max(0, job.amount_cents - paid),
    };
  }

  function add(jobId, { amount, method, note, kind = 'payment', paid_at: paidAt = null, ref = null } = {}, { user } = {}) {
    const job = decorate(jobs.getJob(jobId));
    if (!['payment', 'refund'].includes(kind)) throw new HttpError(400, 'Pick payment or refund.');
    const cents = amount == null || String(amount).trim() === '' ? job.amount_due_cents : parseAmount(amount);
    if (!cents || cents <= 0) throw new HttpError(400, 'Enter the amount paid.');
    const how = String(method || '').trim();
    if (!DEPOSIT_METHODS.includes(how)) throw new HttpError(400, `Pick how they paid: ${DEPOSIT_METHODS.join(', ')}.`);
    if (ref && stmt('SELECT 1 FROM job_payments WHERE ref = ?').get(ref)) throw new HttpError(400, 'That card payment is already recorded.');
    stmt('INSERT INTO job_payments (job_id, kind, cents, method, note, paid_by, paid_at, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jobId, kind, cents, how, String(note || '').trim().slice(0, 200) || null, user ?? null, paidAt || now(), ref);
    const after = decorate(jobs.getJob(jobId));
    const balance = after.amount_due_cents != null ? ` · balance ${money(after.amount_due_cents)}` : '';
    leads.logActivity(job.lead_id, 'payment', {
      note: `${kind === 'refund' ? 'Refund' : 'Payment'}: ${money(cents)} (${how})${note ? ` ${String(note).slice(0, 200)}` : ''}${balance}`, user,
    });
    return after;
  }

  // Admins remove a payment entered by mistake.
  function remove(paymentId, { user } = {}) {
    const p = stmt('SELECT * FROM job_payments WHERE id = ?').get(paymentId);
    if (!p) throw new HttpError(404, 'Payment not found');
    stmt('DELETE FROM job_payments WHERE id = ?').run(paymentId);
    const job = jobs.getJob(p.job_id);
    leads.logActivity(job.lead_id, 'payment', { note: `${p.kind === 'refund' ? 'Refund' : 'Payment'} of ${money(p.cents)} removed (entered by mistake)`, user });
    return decorate(job);
  }

  // Jobs that are done or ready with money still owed: admins' "Still owed" list.
  function owed() {
    return stmt(`SELECT j.*, l.full_name, l.first_name, l.last_name, l.phone, l.vehicle_type, l.vehicle_year, l.vehicle_make, l.vehicle_model
                 FROM jobs j JOIN leads l ON l.id = j.lead_id
                 WHERE j.status IN ('ready', 'picked_up') AND j.amount_cents IS NOT NULL ORDER BY j.end_at DESC`).all()
      .map(decorate).filter((j) => j.amount_due_cents > 0);
  }

  return { list, decorate, add, remove, owed };
}

module.exports = { createPaymentService };
