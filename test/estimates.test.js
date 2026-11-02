const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createEstimateService, colorFamily } = require('../src/estimates');

const DAY = 86400000;
function setup() {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const estimates = createEstimateService(db, { getShopHours: jobs.getShopHours });
  jobs.setEstimator((lead, services) => estimates.suggest({ ...lead, services }).hours);
  let n = 0;
  // A job finished on the work timer `daysAgo` days ago that took `hours`.
  const finished = (type, color, hours, { services = ['full_decon_coat'], daysAgo = 10 } = {}) => {
    n++;
    const { lead } = leads.ingest({ full_name: `Past ${n}`, phone: `702-555-${String(1000 + n)}`, vehicle_type: type, vehicle_color: color });
    const end = new Date(Date.now() - daysAgo * DAY);
    const start = new Date(end - hours * 3600000);
    const ts = end.toISOString();
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO jobs (lead_id, start_at, end_at, status, services, work_hours, work_started_at, work_finished_at, created_at, updated_at)
                                                VALUES (?, ?, ?, 'picked_up', ?, 4, ?, ?, ?, ?)`).run(lead.id, start.toISOString(), ts, JSON.stringify(services), start.toISOString(), ts, ts, ts);
    db.prepare('INSERT INTO job_work (job_id, user_name, started_at, stopped_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'Mike', start.toISOString(), ts, ts);
  };
  return { db, leads, jobs, estimates, finished };
}

test('paint colors fall into families', () => {
  assert.deepEqual(['Jet Black', 'Pearl White', 'Nardo Grey', 'Midnight Silver', 'Santorini Black', 'Navy', 'Champagne', 'Mauve', ''].map(colorFamily),
    ['Black', 'White', 'Silver / gray', 'Silver / gray', 'Black', 'Blue', 'Brown / tan', 'Other', null]);
});

test('with no history the standard time is used; with history it learns the vehicle type, the paint color and extra services', () => {
  const { estimates, finished } = setup();
  let s = estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Black' });
  assert.deepEqual([s.hours, s.learned], [4, false]);
  assert.match(s.reasons[0], /No finished Cars on the work timer yet/);

  for (let i = 0; i < 4; i++) finished('Car', 'White', 5);
  for (let i = 0; i < 4; i++) finished('Car', 'Jet Black', 7);
  const black = estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Obsidian Black' });
  const white = estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Pearl White' });
  const red = estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Red' });
  assert.ok(black.hours > red.hours && red.hours > white.hours, `black ${black.hours} > no-history color ${red.hours} > white ${white.hours}`);
  assert.equal(red.hours, 5.5, 'cars average 5.6 h (leaning a little on the standard 4 h)');
  assert.equal(black.hours, 6);
  assert.match(black.reasons.join(' | '), /^Cars here average 5\.6 hours \(8 finished jobs\) \| Black paint runs 11% longer \(4 jobs\)$/);
  assert.equal(black.learned, true);

  // Paint correction on top.
  for (let i = 0; i < 3; i++) finished('Car', 'Red', 9, { services: ['full_decon_coat', 'paint_correction'] });
  const pc = estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Black', services: ['full_decon_coat', 'paint_correction'] });
  assert.match(pc.reasons.join(' | '), /Paint correction runs \d+% longer \(3 jobs\)/);
  assert.ok(pc.hours > estimates.suggest({ vehicle_type: 'Car', vehicle_color: 'Black' }).hours);

  const m = estimates.model();
  assert.equal(m.samples, 11);
  assert.ok(m.colors.find((c) => c.color === 'Black').factor > 1);
  assert.ok(m.services.find((x) => x.id === 'paint_correction').factor > 1);
});

test('newer jobs count more, so the estimate keeps adapting', () => {
  const { estimates, finished } = setup();
  for (let i = 0; i < 5; i++) finished('SUV', 'Silver', 8, { daysAgo: 720 }); // two years ago: slow
  const before = estimates.suggest({ vehicle_type: 'SUV' }).raw_hours;
  for (let i = 0; i < 5; i++) finished('SUV', 'Silver', 5, { daysAgo: 5 }); // the shop got faster
  const after = estimates.suggest({ vehicle_type: 'SUV' }).raw_hours;
  const plainAverage = (5 * 8 + 5 * 5 + 2 * 4) / 12;
  assert.ok(after < before, 'the faster recent jobs pull it down');
  assert.ok(after < plainAverage - 0.4, `recent jobs outweigh old ones: ${after} vs ${plainAverage.toFixed(2)}`);
});

test('a new booking with no work time picked gets the learned time', () => {
  const { leads, jobs, finished } = setup();
  for (let i = 0; i < 6; i++) finished('Truck', 'Black', 8);
  const { lead } = leads.ingest({ full_name: 'New Truck', phone: '702-555-9999', vehicle_type: 'Truck', vehicle_color: 'Black' });
  leads.dispositionLead(lead.id, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], reminder: false });
  const job = jobs.scheduleLead(lead.id, jobs.parseSchedule({ job_start: new Date(2026, 11, 7, 8).toISOString(), job_end: new Date(2026, 11, 8, 16).toISOString() }), {});
  assert.equal(job.work_hours, 7, 'learned from the trucks (8 h, leaning on the standard 4 h), not the flat 4 hours');
});
