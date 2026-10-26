// Quote builder (lead drawer, sales and admins) and the Price list panel (admins).
// Shares globals with app.js.

const quoting = { prices: null, lead: null, preview: null, timer: null };

async function loadPrices() {
  if (!quoting.prices) quoting.prices = await api('/api/settings/prices');
  return quoting.prices;
}

const rateLabel = (r) => `${r.label} – ${money(r.per_foot_cents, { cents: false })}/ft`;
const pkgLabel = (p) => `${p.label} – ${money(p.price_cents, { cents: false })}`;

// Called by renderLead in app.js.
async function renderQuoteSection(lead) {
  const section = $('#quoteSection');
  section.hidden = state.meta.currentRole === 'shop';
  if (section.hidden) return;
  quoting.lead = lead;
  const prices = await loadPrices().catch(() => null);
  if (!prices || quoting.lead !== lead) return;

  const rv = state.meta.pipelines[0].types.includes(lead.vehicle_type);
  const base = $('#quoteBase');
  const sameLead = base.dataset.lead === String(lead.id);
  const keep = sameLead ? base.value : '';
  base.dataset.lead = lead.id;
  const groups = [
    ['RV & trailer (per foot)', prices.rv.map((r) => [r.id, rateLabel(r)])],
    ['Vehicle packages', prices.vehicle.map((p) => [p.id, pkgLabel(p)])],
  ];
  if (!rv) groups.reverse();
  base.replaceChildren(h('option', { value: '' }, 'Choose…'),
    ...groups.filter(([, opts]) => opts.length).map(([label, opts]) => h('optgroup', { label }, ...opts.map(([id, text]) => h('option', { value: id }, text)))));
  base.value = keep;

  $('#quoteAddons').replaceChildren(h('legend', {}, 'Add-ons'), ...(prices.addons.length
    ? prices.addons.map((a) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: a.id, disabled: a.price_cents == null }),
      ` ${a.label} `,
      h('span', { class: 'muted' }, a.price_cents == null ? '(price not set yet)' : money(a.price_cents, { cents: false }))))
    : [h('span', { class: 'muted' }, 'No add-ons on the price list.')]));
  if (!sameLead) {
    $('#quoteFeet').value = '';
    $('#quoteCustom').replaceChildren();
    $('#quoteDiscount').value = '';
    $('#quoteNote').value = '';
  }
  syncQuoteForm();
  renderQuoteList(lead);
}

function quoteInput() {
  return {
    base: $('#quoteBase').value,
    feet: $('#quoteFeet').value,
    addons: [...$('#quoteAddons').querySelectorAll('input:checked')].map((i) => i.value),
    custom: [...$('#quoteCustom').querySelectorAll('.custom-line')].map((row) => ({
      label: row.querySelector('[name=label]').value, price: row.querySelector('[name=price]').value,
    })),
    discount: $('#quoteDiscount').value,
    note: $('#quoteNote').value,
  };
}

function syncQuoteForm() {
  const isRate = quoting.prices?.rv.some((r) => r.id === $('#quoteBase').value);
  $('#quoteFeetField').hidden = !isRate;
  clearTimeout(quoting.timer);
  quoting.timer = setTimeout(previewQuote, 250);
}

// Live total from the server, so the screen always matches what gets saved.
async function previewQuote() {
  const input = quoteInput();
  const empty = !input.base && !input.custom.some((c) => c.label || c.price);
  $('#quoteError').hidden = true;
  if (empty) { $('#quoteTotal').replaceChildren(h('span', { class: 'muted' }, 'Pick a package or rate to see the total.')); return; }
  try {
    const q = await api('/api/quotes/preview', { method: 'POST', body: input });
    quoting.preview = q;
    $('#quoteTotal').replaceChildren(
      h('ul', { class: 'quote-lines' }, ...q.lines.map((l) => h('li', {},
        h('span', {}, l.label, l.detail && h('span', { class: 'muted' }, ` · ${l.detail}`)), h('span', { class: 'amt' }, money(l.cents))))),
      h('div', { class: 'quote-sum' }, h('span', {}, 'Total'), h('strong', {}, money(q.total_cents))));
  } catch (err) {
    $('#quoteTotal').replaceChildren(h('span', { class: 'muted' }, err.message));
  }
}

function addCustomLine() {
  const row = h('div', { class: 'custom-line' },
    h('input', { name: 'label', placeholder: 'What (e.g. Headlight restore)', 'aria-label': 'Custom line', maxlength: '80' }),
    h('input', { name: 'price', inputmode: 'decimal', placeholder: '$', 'aria-label': 'Price' }),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove line', onclick: () => { row.remove(); syncQuoteForm(); } }, '×'));
  $('#quoteCustom').append(row);
  row.querySelector('input').focus();
}

async function saveQuote(e) {
  e.preventDefault();
  try {
    const quote = await api(`/api/leads/${state.openLeadId}/quotes`, { method: 'POST', body: quoteInput() });
    toast(`Quote saved: ${money(quote.total_cents)}`);
    await openLead(state.openLeadId);
  } catch (err) {
    $('#quoteError').textContent = err.message;
    $('#quoteError').hidden = false;
  }
}

function renderQuoteList(lead) {
  const list = $('#quoteList');
  const quotes = lead.quotes || [];
  list.replaceChildren(...quotes.slice(0, 5).map((q, i) => h('li', { class: 'quote-item' },
    h('div', { class: 'quote-head' },
      h('strong', {}, money(q.total_cents)),
      i === 0 && h('span', { class: 'tag' }, 'Latest'),
      h('span', { class: 'muted' }, `${q.created_by ? `${q.created_by} · ` : ''}${fmtDateTime(q.created_at)}`)),
    h('div', { class: 'muted' }, q.lines.map((l) => l.label).join(' + ')),
    q.note && h('div', { class: 'quote-note' }, `“${q.note}”`),
    q.emailed_at && h('div', { class: 'muted' }, `Emailed to ${q.emailed_to} · ${fmtDateTime(q.emailed_at)}`),
    h('div', { class: 'quote-actions' },
      h('button', { type: 'button', disabled: !lead.email, title: lead.email ? '' : 'Add an email in Lead info first', onclick: () => emailQuote(q) },
        q.emailed_at ? 'Email again' : 'Email to customer'),
      h('button', { type: 'button', onclick: () => useQuote(q) }, 'Use for booking')))));
}

async function emailQuote(q) {
  try {
    const { lead } = await api(`/api/quotes/${q.id}/email`, { method: 'POST' });
    toast(`Quote emailed to ${lead.email}`);
    renderLead(lead);
  } catch (err) { fail(err); }
}

// Fills the booking form with the quote total.
function useQuote(q) {
  const form = $('#dispoForm');
  form.disposition.value = 'booked';
  form.disposition.dispatchEvent(new Event('change'));
  form.job_amount.value = (q.total_cents / 100).toFixed(2);
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Booking filled in with the quote total. Pick services and times, then save.');
}

// ---------- Price list panel (admins) ----------
function priceRow(group, item = {}) {
  const cents = group === 'rv' ? item.per_foot_cents : item.price_cents;
  return h('div', { class: 'price-row', dataset: { id: item.id || '' } },
    h('input', { name: 'label', value: item.label || '', placeholder: group === 'rv' ? 'RV / trailer coating' : 'Name', 'aria-label': 'Name', maxlength: '80' }),
    h('span', { class: 'price-input' }, h('span', { 'aria-hidden': 'true' }, '$'),
      h('input', { name: 'price', inputmode: 'decimal', value: cents == null ? '' : String(cents / 100), placeholder: group === 'addons' ? 'not set' : '0', 'aria-label': group === 'rv' ? 'Price per foot' : 'Price' }),
      group === 'rv' && h('span', { class: 'muted' }, '/ft')),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: (e) => e.target.closest('.price-row').remove() }, '×'));
}

async function openPrices() {
  try {
    quoting.prices = await api('/api/settings/prices');
    for (const group of ['vehicle', 'rv', 'addons']) {
      document.querySelector(`.price-group[data-group="${group}"] .price-rows`).replaceChildren(...quoting.prices[group].map((item) => priceRow(group, item)));
    }
    $('#pricesError').hidden = true;
    showPanel($('#pricesPanel'));
  } catch (err) { fail(err); }
}

async function savePrices(e) {
  e.preventDefault();
  const read = (group) => [...document.querySelectorAll(`.price-group[data-group="${group}"] .price-row`)].map((row) => ({
    id: row.dataset.id || undefined,
    label: row.querySelector('[name=label]').value,
    [group === 'rv' ? 'per_foot' : 'price']: row.querySelector('[name=price]').value,
  }));
  try {
    quoting.prices = await api('/api/settings/prices', { method: 'PUT', body: { vehicle: read('vehicle'), rv: read('rv'), addons: read('addons') } });
    toast('Price list saved');
    showPanel(null);
  } catch (err) {
    $('#pricesError').textContent = err.message;
    $('#pricesError').hidden = false;
  }
}

function initQuotes() {
  $('#quoteForm').addEventListener('input', syncQuoteForm);
  $('#quoteForm').addEventListener('change', syncQuoteForm);
  $('#quoteForm').addEventListener('submit', saveQuote);
  $('#quoteAddLine').addEventListener('click', addCustomLine);
  $('#pricesBtn').addEventListener('click', openPrices);
  $('#pricesForm').addEventListener('submit', savePrices);
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    const group = b.dataset.add;
    const row = priceRow(group);
    document.querySelector(`.price-group[data-group="${group}"] .price-rows`).append(row);
    row.querySelector('input').focus();
  }));
}

initQuotes();
