const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'America/Los_Angeles';

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createCommissionService } = require('../src/commissions');
const { createMessageService } = require('../src/messages');
const { createBookingService } = require('../src/bookings');
const { createQuoteService } = require('../src/quotes');
const { createCampaignService } = require('../src/campaigns');

const at = (day, hour, minute = 0) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour, minute); };

function setup() {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const commissions = createCommissionService(db, { leads, jobs });
  const texts = [];
  const texter = { configured: true, send: async (m) => { texts.push(m); return { id: `SM${texts.length}` }; } };
  const emails = [];
  const mailer = { configured: true, send: async (m) => { emails.push(m); } };
  const messages = createMessageService(db, { leads, jobs, texter, mailer, brand: { name: 'Bob Moses Ceramic Coating' } });
  const bookings = createBookingService(db, { leads, jobs, commissions, messages, stripe: { configured: false }, alerts: { notify: async () => [] }, brand: {} });
  const quotes = createQuoteService(db, { leads, brand: {} });
  const campaigns = createCampaignService(db, { leads, messages, bookings, mailer, texter, publicUrl: 'https://leads.example.com' });
  return { db, leads, quotes, messages, campaigns, texts, emails };
}

test('an unbooked quote gets a follow-up at 3 days and 7 days, during sending hours, with a booking link', async () => {
  const { db, leads, quotes, campaigns, texts } = setup();
  const { lead } = leads.ingest({ first_name: 'Ana', full_name: 'Ana Cruz', phone: '702-555-0101', vehicle_type: 'Car', vehicle_make: 'Tesla' }, { user: 'Sam' });
  const q = quotes.saveQuote(lead.id, { base: 'pkg1300' }, { user: 'Sam' });
  db.prepare('UPDATE quotes SET created_at = ? WHERE id = ?').run(at('2026-11-02', 10).toISOString(), q.id);

  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-04', 12)), 0, 'not yet');
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-05', 21)), 0, 'not at night');
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-05', 10)), 1);
  assert.match(texts[0].body, /^Hi Ana, Sam from Bob Moses Ceramic Coating here\. Just checking in on the \$1,300\.00 quote for your Tesla\. If you're ready, you can pick your day here: https:\/\/leads\.example\.com\/book\/[\w-]+$/);
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-06', 10)), 0, 'once');
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-09', 10)), 1, 'second at 7 days');
  assert.match(texts[1].body, /last nudge/);
  assert.equal(texts[1].body.match(/book\/([\w-]+)/)[1], texts[0].body.match(/book\/([\w-]+)/)[1], 'reuses the same booking link');
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-11-20', 10)), 0, 'then it stops');
});

test('follow-ups stop when the customer replies or books', async () => {
  const { db, leads, quotes, messages, campaigns, texts } = setup();
  const { lead } = leads.ingest({ full_name: 'Bo Diaz', phone: '702-555-0102', vehicle_type: 'Car' });
  const q = quotes.saveQuote(lead.id, { base: 'pkg1300' }, { user: 'Sam' });
  db.prepare('UPDATE quotes SET created_at = ? WHERE id = ?').run(at('2026-10-20', 10).toISOString(), q.id);
  messages.receiveText({ from: '+17025550102', body: 'Let me check with my wife' });
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-10-23', 10)), 0);
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-10-27', 10)), 0);
  assert.equal(texts.length, 0);

  const { lead: booked } = leads.ingest({ full_name: 'Cy Long', phone: '702-555-0103', vehicle_type: 'Car' });
  const q2 = quotes.saveQuote(booked.id, { base: 'pkg1300' }, { user: 'Sam' });
  db.prepare('UPDATE quotes SET created_at = ? WHERE id = ?').run(at('2026-10-20', 10).toISOString(), q2.id);
  leads.dispositionLead(booked.id, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], reminder: false });
  assert.equal(await campaigns.sendQuoteFollowups(at('2026-10-23', 10)), 0);
});

test('win-back goes to the picked old and dead leads, skips do-not-call and opted out, and replies bring leads back', async () => {
  const { db, leads, messages, campaigns, texts } = setup();
  const old = (name, phone, extra = {}) => {
    const { lead } = leads.ingest({ full_name: name, phone, vehicle_type: extra.type || 'Coach / RV', received_at: at('2026-06-01', 10).toISOString() });
    if (extra.dispo) leads.dispositionLead(lead.id, { disposition: extra.dispo, note: 'x', reminder: false });
    if (extra.optOut) db.prepare('UPDATE leads SET sms_opt_in = 0 WHERE id = ?').run(lead.id);
    return lead;
  };
  const rv = old('Old RV', '702-555-0201');
  old('Dead RV', '702-555-0202', { dispo: 'not_interested' });
  old('Do Not Call', '702-555-0203', { dispo: 'do_not_call' });
  old('Opted Out', '702-555-0204', { optOut: true });
  old('Old Car', '702-555-0205', { type: 'Car' });
  leads.archiveOldLeads(at('2026-11-01', 9));

  const check = campaigns.check({ statuses: ['old', 'dead'], pipeline: 'rv', months: 12, text: 'Hi {{first_name}}, spring RV special at {{company}}!' });
  assert.deepEqual([check.count, check.by_text, check.unreachable], [2, 2, 1], 'Old RV and Dead RV; the opted-out one has no other way');
  assert.equal(check.sample.text, 'Hi Old, spring RV special at Bob Moses Ceramic Coating!');
  assert.equal(campaigns.check({ statuses: ['old'], pipeline: 'rv' }).count, 1);
  assert.throws(() => campaigns.start({ statuses: ['old'], text: 'hi' }, { user: 'Dylan' }), /name/);

  const c = campaigns.start({ name: 'Spring RV special', statuses: ['old', 'dead'], pipeline: 'rv', text: 'Hi {{first_name}}, spring RV special!' }, { user: 'Dylan' });
  assert.deepEqual([c.pending, c.sent], [2, 0]);
  assert.equal(await campaigns.sendNext({ at: at('2026-11-08', 10) }), 0, 'not on Sunday');
  assert.equal(await campaigns.sendNext({ at: at('2026-11-09', 10) }), 2);
  assert.deepEqual(texts.map((t) => t.body).sort(), ['Hi Dead, spring RV special!', 'Hi Old, spring RV special!']);
  assert.equal(campaigns.summary(c.id).status, 'done');
  assert.equal(campaigns.check({ statuses: ['old', 'dead'], pipeline: 'rv' }).count, 0, 'not again within 30 days');

  messages.receiveText({ from: '+17025550201', body: 'How much for a 38 ft?' });
  assert.equal(leads.getLead(rv.id).archived_at, null, 'a reply puts the lead back on the board');
  assert.equal(campaigns.summary(c.id).replied, 1);
});
