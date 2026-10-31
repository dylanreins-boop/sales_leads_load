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

test('the customer signs off at drop-off; the signature, notes and wording are kept', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const zlib = require('node:zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-'));
  const db = openDatabase(':memory:');
  const leads = createLeadService(db);
  const jobs = createJobService(db, { leads, photosDir: dir });
  const { lead } = leads.ingest({ full_name: 'Ana Cruz', phone: '702-555-0101', vehicle_type: 'Car', vehicle_year: '2023', vehicle_make: 'Tesla', vehicle_model: 'Model 3' });
  leads.dispositionLead(lead.id, { disposition: 'booked', note: 'x', services: ['full_decon_coat'], reminder: false });
  const job = jobs.scheduleLead(lead.id, { start: at('2026-11-10', 8), end: at('2026-11-10', 12), hours: 4 });

  // A real (tiny) PNG: 40x10, one row of dark pixels.
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(40, 0); ihdr.writeUInt32BE(10, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.concat(Array.from({ length: 10 }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(40, y === 5 ? 0 : 255)])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0)), Buffer.alloc(200)]);
  const signature = `data:image/png;base64,${png.toString('base64')}`;

  assert.throws(() => jobs.signOff(job.id, { name: 'Ana Cruz', signature }, { user: 'Mike' }), /tick the box/);
  assert.throws(() => jobs.signOff(job.id, { name: 'Ana Cruz', agree: true, signature: 'data:image/png;base64,AAAA' }), /sign in the box/);
  const signed = jobs.signOff(job.id, { name: 'Ana Cruz', notes: 'Chip on the hood', agree: true, signature }, { user: 'Mike', company: 'Bob Moses Ceramic Coating' });
  assert.equal(signed.signoff_name, 'Ana Cruz');
  assert.equal(signed.signoff_by, 'Mike');
  assert.match(signed.signoff_terms, /^I, Ana Cruz, walked around my 2023 Tesla Model 3 with Bob Moses Ceramic Coating at drop-off on /);
  assert.match(signed.signoff_terms, /Condition notes: Chip on the hood\nBefore photos taken: 0\.$/);
  assert.deepEqual(fs.readFileSync(jobs.signOffImage(job.id)), png);
  assert.throws(() => jobs.signOff(job.id, { name: 'Again', agree: true, signature }), /already signed/);
  assert.ok(leads.getLead(lead.id).activities.some((a) => a.type === 'signoff' && a.user_name === 'Mike'));
  assert.equal(jobs.daySheet('2026-11-10').dropoffs[0].signed_off, true);

  const cleared = jobs.clearSignOff(job.id, { user: 'Dylan' });
  assert.equal(cleared.signoff_at, null);
});
