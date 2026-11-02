// Referral and partner links. Every past customer can get a personal link to share; partners (RV
// dealers, storage lots, detailers) get one too. The link opens a short form; whoever fills it in
// lands on the board as a lead tagged with who sent them, and admins see who's sending work, what
// it booked, and which referrers are due a thank-you.
const crypto = require('node:crypto');
const { HttpError } = require('./leads');
const { splitVehicle } = require('./import');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (l, 1, o, 0)
const makeCode = () => Array.from(crypto.randomBytes(7), (b) => ALPHABET[b % ALPHABET.length]).join('');

function createReferralService(db, { leads, brand = {} }) {
  const stmt = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();
  const byCode = (code) => stmt('SELECT * FROM referrers WHERE code = ?').get(String(code || '').toLowerCase());
  const byId = (id) => stmt('SELECT * FROM referrers WHERE id = ?').get(id);
  const leadName = (l) => l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || 'Customer';

  function insert(fields) {
    for (let tries = 0; tries < 5; tries++) {
      try {
        const { lastInsertRowid } = stmt(`INSERT INTO referrers (code, kind, lead_id, name, contact, note, active, created_by, created_at)
                                          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(makeCode(), fields.kind, fields.lead_id ?? null, fields.name,
          fields.contact ?? null, fields.note ?? null, fields.user ?? null, now());
        return byId(Number(lastInsertRowid));
      } catch (err) {
        if (!/UNIQUE/.test(err.message)) throw err;
      }
    }
    throw new HttpError(500, 'Could not make a link. Try again.');
  }

  // A customer's own link (made the first time it's asked for).
  function forCustomer(leadId, { user } = {}) {
    const lead = leads.getLead(leadId);
    const existing = stmt("SELECT * FROM referrers WHERE kind = 'customer' AND lead_id = ?").get(leadId);
    if (existing) return existing;
    const made = insert({ kind: 'customer', lead_id: leadId, name: leadName(lead), user });
    leads.logActivity(leadId, 'referral', { note: 'Referral link made for this customer', user });
    return made;
  }

  function createPartner({ name, contact, note } = {}, { user } = {}) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) throw new HttpError(400, 'Add the partner\'s name.');
    return insert({ kind: 'partner', name: clean, contact: String(contact || '').trim().slice(0, 120) || null, note: String(note || '').trim().slice(0, 300) || null, user });
  }

  function updatePartner(id, patch = {}) {
    const p = byId(id);
    if (!p || p.kind !== 'partner') throw new HttpError(404, 'Partner not found');
    if ('active' in patch) stmt('UPDATE referrers SET active = ? WHERE id = ?').run(patch.active ? 1 : 0, id);
    for (const key of ['name', 'contact', 'note']) {
      if (!(key in patch)) continue;
      const value = String(patch[key] || '').trim();
      if (key === 'name' && !value) throw new HttpError(400, 'Add the partner\'s name.');
      stmt(`UPDATE referrers SET ${key} = ? WHERE id = ?`).run(value || null, id);
    }
    return byId(id);
  }

  // ---- the public form ----
  function publicView(code) {
    const r = byCode(code);
    if (!r || !r.active) throw new HttpError(404, 'This link isn\'t active. Call or text us and we\'ll help you out.');
    const first = r.kind === 'customer' ? r.name.split(' ')[0] : r.name;
    return { kind: r.kind, from: first, company: { name: brand.name || '', phone: brand.phone || '', address: brand.address || '' } };
  }

  function submit(code, body = {}) {
    const r = byCode(code);
    if (!r || !r.active) throw new HttpError(404, 'This link isn\'t active. Call or text us and we\'ll help you out.');
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    if (!String(body.first_name || '').trim()) throw new HttpError(400, 'Add your first name.');
    if (phone.replace(/\D/g, '').length < 10 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Add your phone number (or email) so we can reach you.');
    const vehicle = splitVehicle(body.vehicle);
    const { lead, created } = leads.ingest({
      source: 'referral',
      first_name: body.first_name,
      last_name: body.last_name,
      phone,
      email,
      ...vehicle,
      vehicle_type: body.vehicle_type || vehicle.vehicle_type,
      message: String(body.message || '').trim().slice(0, 1000) || null,
      campaign: r.kind === 'partner' ? `Partner: ${r.name}` : `Referral: ${r.name}`,
      heard_about: 'Word of mouth referral',
      sms_opt_in: Boolean(body.sms_opt_in),
    });
    // The first referrer to send someone gets the credit.
    if (!stmt('SELECT referrer_id FROM leads WHERE id = ?').get(lead.id).referrer_id) {
      stmt('UPDATE leads SET referrer_id = ? WHERE id = ?').run(r.id, lead.id);
    }
    leads.logActivity(lead.id, 'referral', { note: `${created ? 'Came in' : 'Reached out again'} through ${r.kind === 'partner' ? `partner ${r.name}` : `${r.name}'s referral link`}` });
    if (r.kind === 'customer' && r.lead_id) leads.logActivity(r.lead_id, 'referral', { note: `Referred ${leadName(lead)}` });
    return { ok: true };
  }

  // ---- for admins: who's sending work, what it booked, who to thank ----
  function report() {
    const referred = stmt(`SELECT l.id, l.full_name, l.first_name, l.last_name, l.phone, l.stage, l.received_at, l.referrer_id,
                                  l.referral_rewarded_at, l.referral_rewarded_by,
                                  (SELECT COUNT(*) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS jobs,
                                  (SELECT SUM(j.amount_cents) FROM jobs j WHERE j.lead_id = l.id AND j.status != 'cancelled') AS revenue_cents
                           FROM leads l WHERE l.referrer_id IS NOT NULL ORDER BY l.received_at DESC`).all()
      .map((l) => ({ ...l, name: leadName(l), booked: l.jobs > 0 }));
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const stats = (id) => {
      const mine = referred.filter((l) => l.referrer_id === id);
      return {
        leads: mine.length,
        leads_this_year: mine.filter((l) => l.received_at >= yearStart).length,
        booked: mine.filter((l) => l.booked).length,
        revenue_cents: mine.reduce((n, l) => n + (l.revenue_cents || 0), 0),
        to_thank: mine.filter((l) => l.booked && !l.referral_rewarded_at).length,
      };
    };
    const all = stmt('SELECT * FROM referrers ORDER BY created_at DESC').all().map((r) => ({ ...r, active: Boolean(r.active), ...stats(r.id) }));
    return {
      partners: all.filter((r) => r.kind === 'partner'),
      customers: all.filter((r) => r.kind === 'customer' && r.leads > 0).sort((a, b) => b.booked - a.booked || b.leads - a.leads),
      referred: referred.map((l) => ({ ...l, referrer: all.find((r) => r.id === l.referrer_id)?.name || '' })),
    };
  }

  // Marks that the person who sent this lead was thanked (or undoes it).
  function markRewarded(leadId, { rewarded = true } = {}, { user } = {}) {
    const lead = leads.getLead(leadId);
    if (!lead.referrer_id) throw new HttpError(400, 'This lead didn\'t come from a referral.');
    const r = byId(lead.referrer_id);
    stmt('UPDATE leads SET referral_rewarded_at = ?, referral_rewarded_by = ? WHERE id = ?').run(rewarded ? now() : null, rewarded ? user ?? null : null, leadId);
    leads.logActivity(leadId, 'referral', { note: rewarded ? `${r.name} thanked for referring this customer` : 'Referral thank-you undone', user });
    return leads.getLead(leadId);
  }

  return { forCustomer, createPartner, updatePartner, publicView, submit, report, markRewarded };
}

module.exports = { createReferralService };
