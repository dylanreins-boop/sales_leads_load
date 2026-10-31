const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'America/Los_Angeles';

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createDaySheetMailer } = require('../src/daysheet');

const at = (day, hour) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour).toISOString(); };

test('the day sheet lists drop-offs, pick-ups and jobs in the shop, and is emailed once each work-day morning', async () => {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db);
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const book = (name, type, start, end, hours, notes) => {
    const { lead } = leads.ingest({ full_name: name, phone: `702-555-${String(Math.floor(Math.random() * 9000) + 1000)}`, vehicle_type: type, vehicle_make: 'Tesla' });
    leads.dispositionLead(lead.id, { disposition: 'booked', note: 'x', services: ['full_decon_coat'], reminder: false });
    const job = jobs.scheduleLead(lead.id, { start, end, hours });
    if (notes) jobs.updateJob(job.id, { notes });
    return job;
  };
  book('Car Today', 'Car', at('2026-11-10', 8), at('2026-11-10', 12), 4, 'Gate code 4411');
  book('RV Monday', 'Coach / RV', at('2026-11-09', 8), at('2026-11-11', 16), 24);
  book('Trailer Out Today', 'Trailer / Toy Hauler', at('2026-11-06', 8), at('2026-11-10', 12), 16);
  const cancelled = book('Cancelled', 'Car', at('2026-11-10', 13), at('2026-11-10', 16), 3);
  jobs.updateJob(cancelled.id, { status: 'cancelled' });

  const sheet = jobs.daySheet('2026-11-10');
  assert.deepEqual(sheet.dropoffs.map((j) => j.customer), ['Car Today']);
  assert.deepEqual(sheet.same_day, [sheet.dropoffs[0].id]);
  assert.deepEqual(sheet.pickups.map((j) => j.customer), ['Trailer Out Today']);
  assert.deepEqual(sheet.in_shop.map((j) => j.customer), ['RV Monday']);
  assert.equal(sheet.dropoffs[0].notes, 'Gate code 4411');
  assert.equal(sheet.booked_hours, 4 + 8, 'car 4 and the RV a full day; the trailer\'s work finished Monday');
  assert.throws(() => jobs.daySheet('tomorrow'), /Pick a day/);

  const sent = [];
  const mailer = { configured: true, send: async (m) => { sent.push(m); } };
  const sheets = createDaySheetMailer(db, { jobs, mailer, brand: { name: 'Bob Moses Ceramic Coating' } });
  assert.throws(() => sheets.saveSettings({ enabled: true, to: 'not-an-email' }), /isn't an email/);
  sheets.saveSettings({ enabled: true, to: 'shop@example.com, mike@example.com', hour: 7 });
  assert.equal(await sheets.sendDue(new Date(at('2026-11-10', 6))), false, 'before 7 AM');
  assert.equal(await sheets.sendDue(new Date(at('2026-11-10', 7))), true);
  assert.equal(await sheets.sendDue(new Date(at('2026-11-10', 9))), false, 'once a day');
  assert.equal(await sheets.sendDue(new Date(at('2026-11-14', 8))), false, 'not on Saturday');
  assert.deepEqual(sent.map((m) => m.to), ['shop@example.com', 'mike@example.com']);
  assert.equal(sent[0].subject, 'Day sheet Tue, Nov 10: 1 drop-off, 1 pick-up');
  assert.match(sent[0].text, /12 hrs of work booked \(the shop works 8 hrs a day\)  \*\* OVER \*\*/);
  assert.match(sent[0].text, /DROP-OFFS \(1\)\n- 8:00 AM  Car Today \(702-555-\d{4}\)\n  Tesla · Full decon & coat · 4 hours of work\n  Notes: Gate code 4411/);
  assert.match(sent[0].text, /ALREADY IN THE SHOP \(1\)\n- RV Monday/);
});
