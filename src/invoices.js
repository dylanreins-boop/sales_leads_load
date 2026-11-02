// Invoices and receipts as PDFs: what the job is, what it costs, what's been paid (deposit and
// payments) and what's still due. A job paid in full prints as a receipt.
const { createPdf } = require('./pdf');
const { serviceLabels } = require('./services');

const money = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// job: a job with its money figures (payments.decorate) and lead fields; lead: getLead.
function invoicePdf(job, lead, { brand = {}, colors = {} } = {}) {
  const pdf = createPdf();
  const navy = colors.bar || '#00142b';
  const stripe = colors.highlight || '#ffad43';
  const M = 54; // margin
  const R = pdf.width - M;
  const paidInFull = job.amount_due_cents === 0;
  const kind = paidInFull ? 'RECEIPT' : 'INVOICE';
  const number = `${paidInFull ? 'R' : 'INV'}-${String(job.id).padStart(5, '0')}`;

  // Header band with the company's details.
  pdf.rect(0, 0, pdf.width, 92, { fill: navy });
  pdf.rect(0, 92, pdf.width, 4, { fill: stripe });
  pdf.text(M, 44, brand.name || 'Invoice', { size: 20, bold: true, color: '#ffffff' });
  pdf.text(M, 64, [brand.address, brand.phone].filter(Boolean).join('  ·  '), { size: 9, color: '#c9d3e0' });
  if (brand.website) pdf.text(M, 78, brand.website, { size: 9, color: '#c9d3e0' });
  pdf.text(R, 44, kind, { size: 20, bold: true, color: '#ffffff', align: 'right' });
  pdf.text(R, 64, number, { size: 10, color: '#c9d3e0', align: 'right' });
  pdf.text(R, 78, `Date ${day(new Date().toISOString())}`, { size: 9, color: '#c9d3e0', align: 'right' });

  // Customer and vehicle.
  let y = 130;
  const name = lead.full_name || [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Customer';
  pdf.text(M, y, 'BILL TO', { size: 8, bold: true, color: '#5d6878' });
  pdf.text(320, y, 'VEHICLE', { size: 8, bold: true, color: '#5d6878' });
  y += 16;
  const vehicle = [lead.vehicle_year, lead.vehicle_make, lead.vehicle_model].filter(Boolean).join(' ') || lead.vehicle_type || '';
  const left = [name, lead.phone, lead.email].filter(Boolean);
  const right = [vehicle, [lead.vehicle_color, vehicle && lead.vehicle_type !== vehicle ? lead.vehicle_type : null].filter(Boolean).join(' · '),
    `Drop-off ${day(job.start_at)} · Pick-up ${day(job.end_at)}`].filter(Boolean);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i]) pdf.text(M, y, left[i], { size: 11, bold: i === 0 });
    if (right[i]) pdf.text(320, y, right[i], { size: 11, bold: i === 0 });
    y += 16;
  }

  // Line items: the quote's lines when they add up to the job amount, else the services booked.
  y += 14;
  pdf.rect(M, y - 13, R - M, 20, { fill: '#f1f4f8' });
  pdf.text(M + 8, y, 'DESCRIPTION', { size: 8, bold: true, color: '#5d6878' });
  pdf.text(R - 8, y, 'AMOUNT', { size: 8, bold: true, color: '#5d6878', align: 'right' });
  y += 24;
  const quote = (lead.quotes || []).find((q) => q.total_cents === job.amount_cents);
  const services = Array.isArray(job.services) ? job.services : JSON.parse(job.services || '[]');
  const lines = quote
    ? quote.lines.map((l) => ({ label: [l.label, l.detail !== money(l.cents) && l.detail].filter(Boolean).join(' · '), cents: l.cents }))
    : [{ label: `Ceramic coating${services.length ? `: ${serviceLabels(services)}` : ''}`, cents: job.amount_cents ?? 0 }];
  for (const l of lines) {
    const after = pdf.paragraph(M + 8, y, l.label, 380, { size: 10 });
    pdf.text(R - 8, y, money(l.cents), { size: 10, align: 'right' });
    y = after + 6;
    pdf.line(M, y - 8, R, y - 8);
    if (y > 680) { pdf.newPage(); y = 72; }
  }

  // Totals, what's been paid, and the balance.
  y += 8;
  const row = (label, value, { bold = false, color } = {}) => {
    pdf.text(R - 150, y, label, { size: 10, bold, color, align: 'right' });
    pdf.text(R - 8, y, value, { size: 10, bold, color, align: 'right' });
    y += 17;
  };
  row('Total', money(job.amount_cents ?? 0), { bold: true });
  if (job.deposit_cents) row(`Deposit ${day(job.deposit_at)}${job.deposit_method ? ` (${job.deposit_method})` : ''}`, money(-job.deposit_cents));
  for (const p of job.amount_payments || []) {
    row(`${p.kind === 'refund' ? 'Refund' : 'Payment'} ${day(p.paid_at)} (${p.method})`, money(p.kind === 'refund' ? p.cents : -p.cents));
  }
  y += 4;
  pdf.line(R - 260, y - 12, R, y - 12, { color: '#0e1a2b' });
  y += 4;
  if (paidInFull) row('Paid in full', money(0), { bold: true, color: '#1d8a52' });
  else row('Balance due', money(job.amount_due_cents ?? job.amount_cents ?? 0), { bold: true, color: '#c7392f' });

  // Thanks.
  y += 30;
  pdf.paragraph(M, y, `Thank you for choosing ${brand.name || 'us'}!${brand.phone ? ` Questions about this ${kind.toLowerCase()}? Call or text ${brand.phone}.` : ''}`, R - M, { size: 10, color: '#5d6878' });

  return { buffer: pdf.toBuffer(), number, kind: paidInFull ? 'receipt' : 'invoice', filename: `${paidInFull ? 'receipt' : 'invoice'}-${number}.pdf` };
}

module.exports = { invoicePdf };
