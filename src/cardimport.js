// Card payments from the shop's card processor (Talech / Elavon, or any processor's export). Admins
// export the transactions from the processor's back office as Excel or CSV and upload the file; the
// app reads it, matches each card payment to the job it was for (amount, customer name, date), shows
// the matches to check, and records the ones they keep as payments on the jobs. Each transaction is
// recorded once (by its transaction ID), so the same file or overlapping exports can be uploaded again.
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const { readSheet } = require('./sheets');

const COLUMNS = [
  { key: 'id', label: 'Transaction ID', words: ['transaction id', 'txn id', 'trans id', 'transaction', 'transaction number', 'transaction #', 'reference', 'reference number', 'ref', 'ref #', 'order id', 'order', 'order #', 'receipt', 'receipt #', 'receipt number', 'ticket', 'ticket #', 'check #', 'invoice', 'invoice #', 'id'] },
  { key: 'date', label: 'Date / time', words: ['date', 'date time', 'transaction date', 'trans date', 'created', 'created at', 'time', 'settle date', 'settlement date', 'processed', 'processed date', 'business date'] },
  { key: 'amount', label: 'Amount', words: ['amount', 'total', 'sale amount', 'transaction amount', 'amount charged', 'total amount', 'grand total', 'payment amount', 'charged', 'paid', 'net sales', 'gross'] },
  { key: 'tip', label: 'Tip (left out)', words: ['tip', 'tips', 'gratuity', 'tip amount'] },
  { key: 'type', label: 'Type (sale / refund)', words: ['type', 'transaction type', 'trans type', 'txn type', 'kind', 'action'] },
  { key: 'status', label: 'Status', words: ['status', 'result', 'response', 'approval status', 'state'] },
  { key: 'tender', label: 'Tender / payment method', words: ['tender', 'tender type', 'payment type', 'payment method', 'method', 'card type', 'card brand', 'brand'] },
  { key: 'name', label: 'Customer / cardholder', words: ['customer', 'customer name', 'cardholder', 'card holder', 'cardholder name', 'name', 'name on card', 'guest', 'client'] },
  { key: 'last4', label: 'Card (last 4)', words: ['card', 'card number', 'card #', 'last 4', 'last four', 'masked card', 'account', 'account number', 'pan'] },
  { key: 'note', label: 'Note / description', words: ['note', 'notes', 'description', 'memo', 'comment', 'comments', 'item', 'items'] },
];
const MAX_ROWS = 5000;
const DAY = 86400000;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
const clean = (s) => String(s ?? '').trim();
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function guessColumns(headers) {
  const heads = headers.map(norm);
  const out = {};
  const used = new Set();
  for (const pass of ['exact', 'partial']) {
    for (const c of COLUMNS) {
      if (c.key in out) continue;
      const i = heads.findIndex((h, idx) => !used.has(idx) && h && (pass === 'exact' ? c.words.includes(h) : c.words.some((w) => w.length > 3 && ` ${h} `.includes(` ${w} `))));
      if (i >= 0) { out[c.key] = i; used.add(i); }
    }
  }
  return out;
}

const cents = (v) => {
  const t = clean(v);
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/[$\s]/g, ''));
  const n = Number(t.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) * (neg ? -1 : 1) : null;
};
function parseWhen(v) {
  const t = clean(v);
  if (!t) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T12:00:00` : t.replace(/(\d)(am|pm)\b/i, '$1 $2'));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
}
// Words from a customer's name, for matching "J SMITH", "Smith/John", "JOHN A SMITH".
const nameWords = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !/^\d+$/.test(w));

function createCardImportService(db, { payments, leads }) {
  const stmt = (sql) => db.prepare(sql);
  const uploads = new Map();

  function load(buffer, name) {
    let rows;
    try { rows = readSheet(buffer, name); } catch (err) { throw new HttpError(400, `Couldn't read that file: ${err.message}`); }
    // Exports often have a title or date-range line or two above the column names.
    const headerAt = rows.findIndex((r) => {
      const g = guessColumns(r.map(clean));
      return 'amount' in g && ('date' in g || 'id' in g);
    });
    if (headerAt < 0) throw new HttpError(400, 'Couldn\'t find the columns. The export needs at least an amount column and a date or transaction ID column.');
    const headers = rows[headerAt].map(clean);
    const body = rows.slice(headerAt + 1).filter((r) => r.some((c) => clean(c)));
    if (body.length > MAX_ROWS) throw new HttpError(400, `That's ${body.length} rows. Export a shorter date range.`);
    for (const [k, v] of uploads) if (Date.now() - v.at > 3600000) uploads.delete(k);
    const token = crypto.randomUUID();
    uploads.set(token, { name: String(name || 'card payments').slice(0, 120), headers, rows: body, at: Date.now() });
    return { token, file: name, headers, columns: guessColumns(headers), fields: COLUMNS.map(({ key, label }) => ({ key, label })), ...check(token, guessColumns(headers)) };
  }

  const upload = (token) => {
    const u = uploads.get(token);
    if (!u) throw new HttpError(400, 'That upload expired. Choose the file again.');
    return u;
  };

  // The file's rows as transactions: card sales and refunds that went through (declines, voids and
  // cash are left out). Each gets an ID: the processor's, or one made from its date, amount and card.
  function transactions(u, columns) {
    const get = (r, key) => (key in columns ? clean(r[columns[key]]) : '');
    const out = [];
    const skipped = { declined: 0, not_card: 0, unreadable: 0 };
    // A tip is only taken off when the amount column is a total that includes it ("Total", "Grand total").
    const totalWithTip = 'amount' in columns && /total|grand/.test(norm(u.headers[columns.amount]));
    for (const r of u.rows) {
      const status = norm(get(r, 'status'));
      const type = norm(get(r, 'type'));
      const tender = norm(get(r, 'tender'));
      if (/declin|void|fail|error|cancel|reject|pending/.test(status) || /\bvoid|auth only|pre ?auth|declin/.test(type)) { skipped.declined++; continue; }
      if (/\b(cash|check|gift|store credit|house)\b/.test(tender)) { skipped.not_card++; continue; }
      let amount = cents(get(r, 'amount'));
      const when = parseWhen(get(r, 'date'));
      if (!amount || (!when && !get(r, 'id'))) { skipped.unreadable++; continue; }
      const tip = totalWithTip ? Math.abs(cents(get(r, 'tip')) || 0) : 0;
      const refund = amount < 0 || /refund|return|credit/.test(type);
      amount = Math.abs(amount) - (refund ? 0 : Math.min(tip, Math.abs(amount)));
      const last4 = (get(r, 'last4').match(/(\d{4})\D*$/) || [])[1] || null;
      const id = get(r, 'id') || `${when?.toISOString().slice(0, 16)}|${amount}|${last4 || ''}`;
      out.push({ ref: `card:${id}`, id, at: when ? when.toISOString() : null, cents: amount, kind: refund ? 'refund' : 'payment', name: get(r, 'name'), last4, note: get(r, 'note') });
    }
    return { rows: out, skipped };
  }

  // Jobs a card payment could be for, with what's still owed on each.
  function openJobs() {
    return stmt(`SELECT j.*, l.full_name, l.first_name, l.last_name, l.vehicle_year, l.vehicle_make, l.vehicle_model
                 FROM jobs j JOIN leads l ON l.id = j.lead_id
                 WHERE j.status != 'cancelled' AND j.amount_cents IS NOT NULL`).all().map((j) => payments.decorate(j));
  }

  // Scores each job for a transaction: amount (the balance, the deposit, the whole job), the customer's
  // name, and the date (around drop-off for a deposit, around pick-up for the balance).
  function candidates(t, jobs) {
    const words = nameWords(t.name);
    return jobs.map((j) => {
      let score = 0;
      const why = [];
      const due = j.amount_due_cents;
      if (t.kind === 'payment') {
        if (due && t.cents === due) { score += 4; why.push('the balance due'); }
        else if (t.cents === j.amount_cents) { score += 3; why.push('the job price'); }
        else if (j.deposit_cents == null && t.cents === Math.round(j.amount_cents * 0.1)) { score += 2; why.push('the deposit'); }
        else if (due && t.cents < due) { score += 1; why.push('part of the balance'); }
        else score -= 3;
      } else if (t.cents <= (j.amount_paid_cents || 0)) score += 1;
      const last = norm(j.last_name || (j.full_name || '').split(' ').slice(-1)[0]);
      const first = norm(j.first_name || (j.full_name || '').split(' ')[0]);
      if (words.length && last && words.includes(last)) { score += 3; why.push('the name'); if (first && words.some((w) => w === first || (w.length === 1 && first.startsWith(w)))) score += 1; }
      else if (words.length && (last || first)) score -= 1;
      if (t.at) {
        const at = new Date(t.at);
        const start = new Date(j.start_at);
        const end = new Date(j.picked_up_at || j.end_at);
        if (at >= new Date(start - 21 * DAY) && at <= new Date(+end + 45 * DAY)) {
          score += 1;
          if (Math.abs(at - end) < 2 * DAY || Math.abs(at - start) < 2 * DAY) { score += 2; why.push('the date'); }
        } else score -= 4;
      }
      return { job_id: j.id, score, why, label: `${j.full_name || [j.first_name, j.last_name].filter(Boolean).join(' ') || 'Customer'} · ${[j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || 'vehicle'} · ${money(j.amount_cents)}${due ? `, ${money(due)} due` : ', paid'}` };
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  }

  function check(token, columns) {
    const u = upload(token);
    const { rows, skipped } = transactions(u, columns);
    const jobs = openJobs();
    const known = new Set(stmt('SELECT ref FROM job_payments WHERE ref IS NOT NULL').all().map((r) => r.ref));
    const out = rows.map((t) => {
      if (known.has(t.ref)) return { ...t, status: 'recorded', options: [] };
      const options = candidates(t, jobs).slice(0, 5);
      const [best, next] = options;
      let status = 'unmatched';
      let job = null;
      if (best && best.score >= 7 && (!next || best.score - next.score >= 2)) { status = 'matched'; job = best.job_id; }
      else if (best && best.score >= 4) { status = 'suggested'; job = best.job_id; }
      return { ...t, status, job_id: job, options };
    });
    const count = (s) => out.filter((r) => r.status === s).length;
    const open = jobs.filter((j) => j.amount_due_cents > 0).map((j) => ({ job_id: j.id, label: candidates({ kind: 'refund', cents: 0, name: '', at: null }, [j])[0]?.label || `Job ${j.id}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { rows: out, skipped, open, summary: { total: out.length, matched: count('matched'), suggested: count('suggested'), unmatched: count('unmatched'), recorded: count('recorded') } };
  }

  // Records the transactions the admin kept, each on the job picked for it.
  function commit(token, columns, picks = [], { user } = {}) {
    const { rows } = check(token, columns);
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    let recorded = 0;
    let cents = 0;
    for (const p of picks) {
      const t = byRef.get(p.ref);
      const jobId = Number(p.job_id);
      if (!t || t.status === 'recorded' || !jobId) continue;
      const note = ['Card', t.last4 && `…${t.last4}`, `processor #${t.id}`].filter(Boolean).join(' ');
      payments.add(jobId, { amount: (t.cents / 100).toFixed(2), method: 'Card', note, kind: t.kind, paid_at: t.at, ref: t.ref }, { user });
      recorded++;
      cents += t.kind === 'refund' ? -t.cents : t.cents;
    }
    uploads.delete(token);
    return { recorded, cents };
  }

  return { load, check: (token, columns) => check(token, columns), commit };
}

module.exports = { createCardImportService, guessColumns };
