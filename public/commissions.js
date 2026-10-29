// Deposits and commissions (sales and admins). Sales reps see their own; admins see everyone,
// change rates, hand a commission to another rep, and mark commissions paid. Shares globals with app.js.

const com = { data: null, settings: null, rep: '', status: 'owed', selected: new Set() };
const COM_STATUS = { owed: 'Owed', pending: 'Pending', paid: 'Paid', no_amount: 'No job amount', cancelled: 'Cancelled' };
const OWED_RULE = {
  picked_up: 'once the job is picked up',
  deposit: 'once the deposit is taken',
  booked: 'as soon as the job is booked',
};

// ---------- on the lead's Shop job box ----------
function depositEditor(job, { onSaved }) {
  const box = h('div', { class: 'job-amount deposit-box' });
  const methods = state.meta.depositMethods || [];
  const show = () => {
    const taken = job.deposit_cents != null;
    box.replaceChildren(
      h('span', { class: 'amount-label' }, 'Deposit'),
      taken
        ? h('span', { class: 'amount-value' }, money(job.deposit_cents))
        : h('span', { class: 'amount-missing' }, job.deposit_due_cents != null ? `Not taken · ${money(job.deposit_due_cents)} due` : 'Not taken'),
      taken && h('span', { class: 'muted' }, [job.deposit_method, job.deposit_by && `by ${job.deposit_by}`, job.deposit_at && shortDate(job.deposit_at)].filter(Boolean).join(' · ')),
      h('button', { type: 'button', class: 'amount-edit', onclick: taken ? undo : edit }, taken ? 'Not taken' : 'Mark taken'));
  };
  const save = async (body) => {
    try {
      const saved = await api(`/api/jobs/${job.id}/deposit`, { method: 'PATCH', body });
      Object.assign(job, saved);
      toast(saved.deposit_cents != null ? `Deposit recorded: ${money(saved.deposit_cents)}` : 'Deposit marked not taken');
      show();
      onSaved?.(saved);
    } catch (err) { fail(err); }
  };
  const undo = () => save({ taken: false });
  const edit = () => {
    const amount = h('input', { inputmode: 'decimal', 'aria-label': 'Deposit amount', value: job.deposit_due_cents != null ? (job.deposit_due_cents / 100).toFixed(2) : '', placeholder: '$' });
    const method = h('select', { 'aria-label': 'Paid by' }, ...methods.map((m) => h('option', { value: m }, m)));
    box.replaceChildren(h('form', { class: 'amount-form', onsubmit: (e) => { e.preventDefault(); save({ taken: true, amount: amount.value, method: method.value }); } },
      h('span', { class: 'amount-label' }, 'Deposit'), amount, method,
      h('button', { type: 'submit', class: 'primary' }, 'Save'), h('button', { type: 'button', onclick: show }, 'Cancel')));
    amount.focus();
  };
  show();
  return box;
}

function commissionLine(job) {
  if (job.commission_status === 'no_amount') return null;
  return h('div', { class: 'job-amount commission-box' },
    h('span', { class: 'amount-label' }, 'Commission'),
    h('span', { class: 'amount-value' }, job.commission_cents != null ? money(job.commission_cents) : '–'),
    h('span', { class: 'muted' }, job.commission_rep ? `to ${job.commission_rep}` : 'no rep'),
    h('span', { class: `com-pill ${job.commission_status}` }, COM_STATUS[job.commission_status] || job.commission_status));
}

// ---------- booking form ----------
function syncBookingDeposit() {
  const form = $('#dispoForm');
  const on = form.deposit_taken.checked;
  form.querySelectorAll('.deposit-field').forEach((el) => { el.hidden = !on; });
  const pct = (com.data?.settings || com.settings)?.deposit_pct ?? 10;
  const amount = Number(String(form.job_amount.value).replace(/[$,\s]/g, ''));
  form.deposit_amount.placeholder = amount > 0 ? `${money(Math.round(amount * pct))} (${pct}%)` : `${pct}% of the job`;
}

// ---------- Commissions page ----------
async function loadCommissions() {
  const query = isAdmin() && com.rep ? `?rep=${encodeURIComponent(com.rep)}` : '';
  com.data = await api(`/api/commissions${query}`);
  com.selected.clear();
  renderCommissions();
}

function renderCommissions() {
  const { jobs, settings, reps } = com.data;
  $('#comRule').textContent = `Reps earn ${settings.rate_pct}% of each job, owed ${OWED_RULE[settings.owed_when]}. `
    + `Deposits are ${settings.deposit_pct}% of the job. Cancelled jobs earn nothing.`;

  if (isAdmin()) {
    const select = $('#comRep');
    select.replaceChildren(h('option', { value: '' }, 'All reps'), ...reps.map((r) => h('option', { value: r }, r)));
    select.value = com.rep;
  }

  const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
  const sum = (list) => list.reduce((n, j) => n + (j.commission_cents || 0), 0);
  const owed = jobs.filter((j) => j.commission_status === 'owed');
  const pending = jobs.filter((j) => j.commission_status === 'pending');
  const paidYtd = jobs.filter((j) => j.commission_status === 'paid' && j.commission_paid_at >= yearStart);
  const noDeposit = jobs.filter((j) => j.deposit_cents == null && !['picked_up', 'cancelled'].includes(j.status));
  const tile = (label, cents, sub, flag) => h('section', { class: 'rev-tile' },
    h('h3', {}, label), h('div', { class: 'rev-total' }, cents), h('div', { class: 'rev-sub' }, sub), flag && h('div', { class: 'rev-flag' }, flag));
  $('#comTiles').replaceChildren(
    tile(isAdmin() ? 'Owed to reps' : 'Owed to you', money(sum(owed), { cents: false }), `${owed.length} job${owed.length === 1 ? '' : 's'}`),
    tile('Pending', money(sum(pending), { cents: false }), `${pending.length} job${pending.length === 1 ? '' : 's'} not earned yet`),
    tile('Paid this year', money(sum(paidYtd), { cents: false }), `${paidYtd.length} job${paidYtd.length === 1 ? '' : 's'}`),
    tile('Deposits not taken', String(noDeposit.length), 'upcoming and in-shop jobs',
      noDeposit.length ? `${money(noDeposit.reduce((n, j) => n + (j.deposit_due_cents || 0), 0), { cents: false })} to collect` : null));

  if (isAdmin()) renderRepTable(jobs, yearStart);
  renderComTable(jobs);
  document.querySelectorAll('#comStatus button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === com.status)));
}

function renderRepTable(jobs, yearStart) {
  const byRep = new Map();
  for (const j of jobs) {
    const rep = j.commission_rep || 'No rep';
    const r = byRep.get(rep) || { owed: 0, owedIds: [], pending: 0, paid: 0 };
    if (j.commission_status === 'owed') { r.owed += j.commission_cents; r.owedIds.push(j.id); }
    if (j.commission_status === 'pending') r.pending += j.commission_cents;
    if (j.commission_status === 'paid' && j.commission_paid_at >= yearStart) r.paid += j.commission_cents;
    byRep.set(rep, r);
  }
  const rows = [...byRep.entries()].sort((a, b) => b[1].owed - a[1].owed || a[0].localeCompare(b[0]));
  $('#comRepTable').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Rep'), h('th', { class: 'num' }, 'Owed'), h('th', { class: 'num' }, 'Pending'), h('th', { class: 'num' }, 'Paid this year'), h('th', {}))),
    h('tbody', {}, ...(rows.length ? rows.map(([rep, r]) => h('tr', {},
      h('td', {}, rep),
      h('td', { class: 'num' }, h('strong', {}, money(r.owed, { cents: false }))),
      h('td', { class: 'num' }, money(r.pending, { cents: false })),
      h('td', { class: 'num' }, money(r.paid, { cents: false })),
      h('td', {}, r.owedIds.length > 0 && h('button', { type: 'button', onclick: () => payJobs(r.owedIds, `${rep}: ${money(r.owed)}`) }, `Pay ${rep}`))))
      : [h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No commissions yet. They show up when jobs are booked with an amount.'))])));
}

function renderComTable(jobs) {
  const shown = jobs.filter((j) => !com.status || j.commission_status === com.status);
  const admin = isAdmin();
  const vehicle = (j) => [j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ') || j.vehicle_type || '';
  const deposit = (j) => (j.deposit_cents != null
    ? h('span', {}, h('span', { class: 'com-pill paid' }, 'Taken'), ` ${money(j.deposit_cents, { cents: false })}${j.deposit_method ? ` · ${j.deposit_method}` : ''}`)
    : j.status === 'cancelled' ? h('span', { class: 'muted' }, '–')
      : h('span', {}, h('span', { class: 'com-pill pending' }, 'Not taken'), j.deposit_due_cents != null ? ` ${money(j.deposit_due_cents, { cents: false })} due` : ''));
  const actions = (j) => {
    if (!admin) return null;
    if (j.commission_status === 'paid') return h('button', { type: 'button', class: 'link-btn', onclick: () => unpay(j) }, 'Undo paid');
    if (['owed', 'pending', 'no_amount'].includes(j.commission_status)) return h('button', { type: 'button', class: 'link-btn', onclick: (e) => editCommission(j, e.target.closest('tr')) }, 'Edit');
    return null;
  };
  $('#comTable').replaceChildren(
    h('thead', {}, h('tr', {}, admin && h('th', {}, ''), h('th', {}, 'Customer'), h('th', {}, 'Drop-off'), h('th', { class: 'num' }, 'Job'),
      h('th', {}, 'Deposit'), h('th', { class: 'num' }, 'Commission'), admin && h('th', {}, 'Rep'), h('th', {}, 'Status'), admin && h('th', {}, ''))),
    h('tbody', {}, ...(shown.length ? shown.map((j) => h('tr', {},
      admin && h('td', {}, j.commission_status === 'owed' && h('input', {
        type: 'checkbox', 'aria-label': `Select ${leadName(j)}`, checked: com.selected.has(j.id),
        onchange: (e) => { if (e.target.checked) com.selected.add(j.id); else com.selected.delete(j.id); syncPayBar(); },
      })),
      h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => { showSection('leads'); openLead(j.lead_id); } }, leadName(j)),
        h('div', { class: 'muted' }, vehicle(j))),
      h('td', {}, shortDate(j.start_at)),
      h('td', { class: 'num' }, j.amount_cents != null ? money(j.amount_cents, { cents: false }) : '–'),
      h('td', {}, deposit(j)),
      h('td', { class: 'num' }, j.commission_cents != null ? money(j.commission_cents) : '–'),
      admin && h('td', {}, j.commission_rep || '–'),
      h('td', {}, h('span', { class: `com-pill ${j.commission_status}` }, COM_STATUS[j.commission_status]),
        j.commission_status === 'paid' && h('div', { class: 'muted' }, `${shortDate(j.commission_paid_at)}${j.commission_paid_by ? ` · ${j.commission_paid_by}` : ''}`)),
      admin && h('td', {}, actions(j))))
      : [h('tr', {}, h('td', { colspan: admin ? 9 : 6, class: 'muted' }, {
        owed: 'Nothing owed right now.', pending: 'Nothing pending.', paid: 'No commissions paid yet.', '': 'No jobs yet.',
      }[com.status]))])));
  syncPayBar();
}

function syncPayBar() {
  const bar = $('#comPayBar');
  const picked = com.data.jobs.filter((j) => com.selected.has(j.id));
  bar.hidden = !isAdmin() || !picked.length;
  $('#comPayText').textContent = `${picked.length} selected · ${money(picked.reduce((n, j) => n + j.commission_cents, 0))}`;
}

async function payJobs(ids, label) {
  try {
    const res = await api('/api/commissions/pay', { method: 'POST', body: { job_ids: ids, note: $('#comPayNote').value } });
    toast(`Marked paid: ${label || money(res.total_cents)}`);
    $('#comPayNote').value = '';
    await loadCommissions();
  } catch (err) { fail(err); }
}

async function unpay(job) {
  try {
    await api(`/api/jobs/${job.id}/commission/unpay`, { method: 'POST' });
    toast('Payment undone. The commission is owed again.');
    await loadCommissions();
  } catch (err) { fail(err); }
}

// Admins: give the commission to another rep, or set a different amount (blank = standard rate).
function editCommission(job, row) {
  const reps = com.data.reps;
  const rep = h('select', { 'aria-label': 'Rep' }, h('option', { value: '' }, 'No rep'), ...reps.map((r) => h('option', { value: r, selected: r === job.commission_rep }, r)));
  const amount = h('input', { inputmode: 'decimal', 'aria-label': 'Commission amount', placeholder: `${com.data.settings.rate_pct}% (standard)`,
    value: job.commission_override_cents != null ? (job.commission_override_cents / 100).toFixed(2) : '' });
  const cell = h('td', { colspan: row.children.length },
    h('form', { class: 'amount-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api(`/api/jobs/${job.id}/commission`, { method: 'PATCH', body: { rep: rep.value, amount: amount.value } });
        toast('Commission updated');
        await loadCommissions();
      } catch (err) { fail(err); }
    } }, h('strong', {}, leadName(job)), rep, amount, h('button', { type: 'submit', class: 'primary' }, 'Save'), h('button', { type: 'button', onclick: renderCommissions }, 'Cancel')));
  row.replaceChildren(cell);
  amount.focus();
}

async function saveComSettings(e) {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/settings/commission', { method: 'PUT', body: { rate_pct: Number(f.rate_pct.value), deposit_pct: Number(f.deposit_pct.value), owed_when: f.owed_when.value } });
    toast('Rates saved');
    f.hidden = true;
    await loadCommissions();
  } catch (err) { fail(err); }
}

function initCommissions() {
  const form = $('#dispoForm');
  form.deposit_method.replaceChildren(...(state.meta?.depositMethods || ['Cash', 'Card', 'Check', 'Other']).map((m) => h('option', { value: m }, m)));
  form.deposit_taken.addEventListener('change', syncBookingDeposit);
  form.job_amount.addEventListener('input', syncBookingDeposit);
  form.addEventListener('reset', () => setTimeout(syncBookingDeposit));
  $('#comRep').addEventListener('change', (e) => { com.rep = e.target.value; loadCommissions().catch(fail); });
  $('#comStatus').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { com.status = b.dataset.status; com.selected.clear(); renderCommissions(); }
  });
  $('#comPayBtn').addEventListener('click', () => payJobs([...com.selected]));
  $('#comSettingsBtn').addEventListener('click', () => {
    const f = $('#comSettings');
    f.hidden = !f.hidden;
    if (!f.hidden && com.data) {
      f.rate_pct.value = com.data.settings.rate_pct;
      f.deposit_pct.value = com.data.settings.deposit_pct;
      f.owed_when.value = com.data.settings.owed_when;
    }
  });
  $('#comSettings').addEventListener('submit', saveComSettings);
  if (state.meta.currentRole !== 'shop') api('/api/settings/commission').then((s) => { com.settings = s; }).catch(() => {});
}
