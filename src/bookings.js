// Online booking links: a rep sends the customer a link (usually right after a quote); the customer
// sees the price, picks a drop-off day that still has room in the shop, and can pay the deposit by
// card. Booking puts the job on the calendar for that rep, just like booking it from a call.
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const ShopTime = require('../public/shop-time');
const { pipelineFor } = require('./vehicle');
const { cleanServices, serviceLabels, parseServices } = require('./services');
const { vehicleText } = require('./email');

const LINK_DAYS = 30; // links work for 30 days
const SHOW_DAYS = 45; // how far ahead customers can book
const money = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const when = (d) => new Date(d).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function createBookingService(db, { leads, jobs, commissions, messages, stripe, alerts, brand = {} }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  const shape = (row) => row && { ...row, services: parseServices(row.services) };
  const byToken = (token) => shape(stmt('SELECT * FROM booking_links WHERE token = ?').get(String(token || '')));
  const byId = (id) => shape(stmt('SELECT * FROM booking_links WHERE id = ?').get(id));
  const statusOf = (link, at = new Date()) => {
    if (link.cancelled_at) return 'cancelled';
    if (link.job_id) return 'booked';
    if (new Date(link.expires_at) < at) return 'expired';
    return 'open';
  };
  const listFor = (leadId) => stmt('SELECT * FROM booking_links WHERE lead_id = ? ORDER BY id DESC').all(leadId).map((l) => ({ ...shape(l), status: statusOf(l) }));

  // ---- for the reps ----
  function create(leadId, { amount, work_hours: workHours, services } = {}, { user } = {}) {
    const lead = leads.getLead(leadId);
    const settings = jobs.getShopHours();
    const cents = amount == null || String(amount).trim() === ''
      ? lead.quotes?.[0]?.total_cents ?? null
      : Math.round(Number(String(amount).replace(/[$,\s]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) throw new HttpError(400, 'Enter the price for the job (or save a quote first).');
    const hours = workHours ? Number(workHours) : ShopTime.defaultHours(pipelineFor(lead.vehicle_type), settings);
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 400) throw new HttpError(400, 'Pick how long the job takes.');
    const picked = cleanServices(services?.length ? services : lead.booked_services?.length ? lead.booked_services : ['full_decon_coat']);
    if (!picked.length) throw new HttpError(400, 'Pick at least one service.');
    const deposit = Math.round((cents * commissions.getSettings().deposit_pct) / 100);
    const token = crypto.randomBytes(18).toString('base64url');
    const ts = now();
    const { lastInsertRowid } = stmt(`INSERT INTO booking_links (token, lead_id, amount_cents, deposit_cents, work_hours, services, created_by, created_at, expires_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      token, leadId, cents, deposit, hours, JSON.stringify(picked), user ?? null, ts,
      new Date(Date.now() + LINK_DAYS * 86400000).toISOString(),
    );
    leads.logActivity(leadId, 'booking', { note: `Booking link made: ${money(cents)}, ${ShopTime.label(hours, settings)} of work (${serviceLabels(picked)})`, user });
    return { ...byId(Number(lastInsertRowid)), status: 'open' };
  }

  function cancel(id, { user } = {}) {
    const link = byId(id);
    if (!link) throw new HttpError(404, 'Booking link not found');
    if (link.job_id) throw new HttpError(400, 'The customer already booked with this link. Change the job on the calendar instead.');
    stmt('UPDATE booking_links SET cancelled_at = ? WHERE id = ?').run(now(), id);
    leads.logActivity(link.lead_id, 'booking', { note: 'Booking link turned off', user });
    return { ...byId(id), status: 'cancelled' };
  }

  // ---- what the customer sees ----
  // Days the job fits: the shop is open, and adding it keeps every day it's worked within the shop's hours.
  function openDays(link, from = new Date()) {
    const settings = jobs.getShopHours();
    const pipeline = pipelineFor(leads.getLead(link.lead_id).vehicle_type);
    const days = [];
    const day = new Date(from);
    day.setHours(0, 0, 0, 0);
    for (let i = 0; i < SHOW_DAYS; i++) {
      day.setDate(day.getDate() + 1);
      if (!ShopTime.isWorkDay(day, settings)) continue;
      const start = ShopTime.windowOn(day, settings).from;
      const end = ShopTime.finishAt(start, link.work_hours, settings);
      const check = jobs.capacity({ start: start.toISOString(), end: end.toISOString(), hours: link.work_hours, pipeline });
      if (check.warnings.some((w) => w.type === 'over' || w.type === 'closed')) continue;
      days.push({ date: ShopTime.dayKey(day), drop_off: start.toISOString(), pick_up: end.toISOString() });
    }
    return days;
  }

  function view(token) {
    const link = byToken(token);
    if (!link) throw new HttpError(404, 'This booking link doesn\'t work. Call or text us and we\'ll get you set up.');
    const lead = leads.getLead(link.lead_id);
    const status = statusOf(link);
    const job = link.job_id ? jobs.getJob(link.job_id) : null;
    const depositPaid = Boolean(link.deposit_paid_at) || (job && job.deposit_cents != null);
    return {
      company: { name: brand.name || '', phone: brand.phone || '', address: brand.address || '', website: brand.website || '' },
      first_name: lead.first_name || (lead.full_name || '').split(' ')[0] || '',
      vehicle: vehicleText(lead),
      services: serviceLabels(link.services),
      amount_cents: link.amount_cents,
      deposit_cents: link.deposit_cents,
      work_label: ShopTime.label(link.work_hours, jobs.getShopHours()),
      status,
      booked: job && job.status !== 'cancelled' ? { drop_off: when(job.start_at), pick_up: when(job.end_at) } : null,
      deposit_paid: depositPaid,
      pay_online: stripe.configured && link.deposit_cents > 0 && !depositPaid,
      days: status === 'open' ? openDays(link) : [],
    };
  }

  // The customer picked a day. Returns { redirect } when the deposit is paid by card next.
  async function book(token, { date } = {}, { baseUrl = '' } = {}) {
    const link = byToken(token);
    if (!link) throw new HttpError(404, 'This booking link doesn\'t work.');
    const status = statusOf(link);
    if (status !== 'open') throw new HttpError(400, { booked: 'You\'re already booked with this link.', expired: 'This link has expired. Call or text us to book.', cancelled: 'This link was turned off. Call or text us to book.' }[status]);
    const day = openDays(link).find((d) => d.date === date);
    if (!day) throw new HttpError(409, 'That day just filled up. Please pick another one.');

    // Everything up to here and below runs without waiting, so two clicks can't both book.
    leads.dispositionLead(link.lead_id, {
      disposition: 'booked', services: link.services, reminder: false,
      note: `Customer booked online for ${longDate(day.drop_off)} (link from ${link.created_by || 'the team'})`,
    }, { user: null });
    const job = jobs.scheduleLead(link.lead_id, { start: day.drop_off, end: day.pick_up, hours: link.work_hours }, { user: null });
    // Booked from this rep's link: it's their booking and their commission.
    stmt('UPDATE jobs SET created_by = ? WHERE id = ?').run(link.created_by, job.id);
    jobs.setAmount(job.id, (link.amount_cents / 100).toFixed(2), { user: null });
    stmt('UPDATE booking_links SET job_id = ?, booked_at = ? WHERE id = ?').run(job.id, now(), link.id);
    await messages.sendConfirmation(job.id, {}).catch((err) => console.error('Online booking confirmation failed:', err.message));
    const lead = leads.getLead(link.lead_id);
    if (link.created_by) {
      alerts.notify([link.created_by], {
        title: `${lead.full_name || 'A customer'} booked online`,
        body: `Drop-off ${when(day.drop_off)} · ${money(link.amount_cents)}`,
        url: `/?lead=${lead.id}`,
        tag: `booked-${lead.id}`,
      }).catch(() => {});
    }
    if (stripe.configured && link.deposit_cents > 0) return { redirect: await startPayment(token, { baseUrl }) };
    return { booked: true };
  }

  // A Stripe payment page for the deposit; the customer comes back to the booking page after.
  async function startPayment(token, { baseUrl = '' } = {}) {
    const link = byToken(token);
    if (!link?.job_id) throw new HttpError(400, 'Pick your drop-off day first.');
    if (!stripe.configured) throw new HttpError(400, 'Card payments aren\'t set up. We\'ll take the deposit at drop-off.');
    const lead = leads.getLead(link.lead_id);
    const session = await stripe.checkout({
      cents: link.deposit_cents,
      name: `Deposit: ${vehicleText(lead)} with ${brand.name || 'us'}`,
      email: lead.email,
      successUrl: `${baseUrl}/book/${token}?paid={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/book/${token}`,
      metadata: { booking_link: String(link.id), job_id: String(link.job_id) },
    });
    stmt('UPDATE booking_links SET stripe_session_id = ? WHERE id = ?').run(session.id, link.id);
    return session.url;
  }

  // Records a paid deposit once (from the webhook, or when the customer lands back on the page).
  function recordPayment(link, session) {
    if (link.deposit_paid_at || session.payment_status !== 'paid') return false;
    if (String(session.metadata?.booking_link) !== String(link.id)) return false;
    stmt('UPDATE booking_links SET deposit_paid_at = ? WHERE id = ?').run(now(), link.id);
    commissions.setDeposit(link.job_id, { taken: true, amount: (session.amount_total / 100).toFixed(2), method: 'Card' }, { user: 'Online payment' });
    return true;
  }

  async function confirmPayment(token, sessionId) {
    const link = byToken(token);
    if (!link || !stripe.configured || !sessionId) return false;
    if (link.stripe_session_id && link.stripe_session_id !== sessionId) return false;
    return recordPayment(link, await stripe.getSession(sessionId));
  }

  function paymentWebhook(event) {
    if (event?.type !== 'checkout.session.completed') return false;
    const session = event.data?.object || {};
    const link = byId(Number(session.metadata?.booking_link));
    return link ? recordPayment(link, session) : false;
  }

  return { create, cancel, listFor, view, openDays, book, startPayment, confirmPayment, paymentWebhook };
}

module.exports = { createBookingService };
