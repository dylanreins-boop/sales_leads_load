const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Runs in its own process, so these logins don't affect the other test files.
process.env.APP_USERS = 'Dylan:sales-pass,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.WEBSITE_API_KEY = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { checklistFor } = require('../src/jobs');

const photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-photos-'));
let server;
let base;

before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), photosDir }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(photosDir, { recursive: true, force: true });
});

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const SALES = login('Dylan', 'sales-pass');
const SHOP = login('Mike', 'shop-pass');

async function call(method, url, body, auth = SALES, headers = {}) {
  const isRaw = Buffer.isBuffer(body);
  const res = await fetch(base + url, {
    method,
    headers: { Authorization: auth, ...(isRaw ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

// Smallest valid JPEG header bytes are enough for type detection.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);

let coachLeadId;
let jobId;

test('booking needs drop-off and pick-up times, then puts the job on the calendar', async () => {
  const { lead } = (await call('POST', '/api/leads', {
    full_name: 'Jess Morgan', phone: '702-555-9017', vehicle_type: 'Coach / RV', vehicle_make: 'Prevost', vehicle_model: 'H3-45',
  })).data;
  coachLeadId = lead.id;
  const booking = { disposition: 'booked', note: 'Booked at storage lot', services: ['full_decon_coat', 'pop_outs'] };

  const missing = await call('POST', `/api/leads/${lead.id}/disposition`, booking);
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /drop-off/);
  const backwards = await call('POST', `/api/leads/${lead.id}/disposition`, { ...booking, job_start: '2026-11-03T16:00:00Z', job_end: '2026-11-03T15:00:00Z' });
  assert.equal(backwards.status, 400);
  assert.match(backwards.data.error, /after drop-off/);
  assert.equal((await call('GET', `/api/leads/${lead.id}`)).data.stage, 'new', 'nothing saved when the schedule is wrong');

  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { ...booking, job_start: '2026-11-03T15:00:00Z', job_end: '2026-11-05T22:00:00Z' });
  assert.equal(res.status, 201);
  jobId = res.data.job.id;
  assert.equal(res.data.job.status, 'scheduled');
  assert.deepEqual(res.data.job.services, ['full_decon_coat', 'pop_outs']);
  const labels = res.data.job.checklist.map((c) => c.label);
  assert.ok(labels.includes('Slide-outs extended and checked'), 'coach check-in items');
  assert.ok(labels.includes('Pop-outs / slide-outs coated'), 'service work items');
  assert.ok(labels.indexOf('Pop-outs / slide-outs coated') < labels.indexOf('Coating applied'), 'service work comes before the coating step');
  assert.equal(res.data.lead.jobs.length, 1);
  assert.ok(res.data.lead.activities.some((a) => a.type === 'job' && /Job on the calendar/.test(a.note)));

  // Booking again moves the same job instead of adding a second one.
  const again = await call('POST', `/api/leads/${lead.id}/disposition`, { ...booking, job_start: '2026-11-04T15:00:00Z', job_end: '2026-11-06T22:00:00Z' });
  assert.equal(again.data.job.id, jobId);
  assert.equal(again.data.job.start_at, '2026-11-04T15:00:00.000Z');
});

test('the calendar lists jobs overlapping the visible dates', async () => {
  const week = (await call('GET', '/api/jobs?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z')).data;
  assert.equal(week.length, 1);
  assert.equal(week[0].full_name, 'Jess Morgan');
  assert.equal(week[0].pipeline, 'rv');
  assert.ok(week[0].checklist_total > 10);
  assert.equal(week[0].checklist_done, 0);
  assert.equal((await call('GET', '/api/jobs?from=2026-11-07T00:00:00Z&to=2026-11-14T00:00:00Z')).data.length, 0);
  assert.equal((await call('GET', '/api/jobs?from=nope&to=2026-11-14T00:00:00Z')).status, 400);
});

test('the shop can update a job, tick the checklist and add items', async () => {
  const moved = await call('PATCH', `/api/jobs/${jobId}`, { status: 'in_shop', notes: 'Keys in lockbox 4' }, SHOP);
  assert.equal(moved.data.status, 'in_shop');
  assert.equal(moved.data.notes, 'Keys in lockbox 4');
  assert.equal((await call('PATCH', `/api/jobs/${jobId}`, { status: 'teleported' }, SHOP)).status, 400);
  assert.equal((await call('PATCH', `/api/jobs/${jobId}`, { end_at: '2026-11-01T00:00:00Z' }, SHOP)).status, 400);

  const item = moved.data.checklist[0];
  const ticked = await call('PATCH', `/api/jobs/${jobId}/checklist/${item.id}`, { done: true }, SHOP);
  assert.equal(ticked.data.done_by, 'Mike');
  assert.ok(ticked.data.done_at);
  const unticked = await call('PATCH', `/api/jobs/${jobId}/checklist/${item.id}`, { done: false }, SHOP);
  assert.equal(unticked.data.done_at, null);

  const list = (await call('POST', `/api/jobs/${jobId}/checklist`, { label: 'Generator compartment wiped', section: 'Check-in' }, SHOP)).data;
  const added = list.find((c) => c.label === 'Generator compartment wiped');
  assert.equal(added.section, 'Check-in');
  const lastCheckIn = list.filter((c) => c.section === 'Check-in').pop();
  assert.equal(lastCheckIn.id, added.id, 'new item lands at the end of its section');
  assert.equal((await call('POST', `/api/jobs/${jobId}/checklist`, { label: '  ' }, SHOP)).status, 400);
  assert.equal((await call('DELETE', `/api/jobs/${jobId}/checklist/${added.id}`, undefined, SHOP)).status, 200);

  const lead = (await call('GET', `/api/leads/${coachLeadId}`)).data;
  assert.ok(lead.activities.some((a) => a.note === 'Job: Scheduled → In the shop' && a.user_name === 'Mike'));
});

test('photos can be added, viewed and deleted; only real images are kept', async () => {
  const added = await call('POST', `/api/jobs/${jobId}/photos?phase=before&caption=Driver%20side`, JPEG, SHOP, { 'Content-Type': 'image/jpeg' });
  assert.equal(added.status, 201);
  assert.equal(added.data.phase, 'before');
  assert.equal(added.data.caption, 'Driver side');
  assert.equal(added.data.uploaded_by, 'Mike');

  const notImage = await call('POST', `/api/jobs/${jobId}/photos`, Buffer.from('<script>alert(1)</script>'), SHOP, { 'Content-Type': 'image/jpeg' });
  assert.equal(notImage.status, 415);

  const img = await call('GET', `/api/jobs/${jobId}/photos/${added.data.id}`, undefined, SHOP);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/jpeg');
  assert.ok(img.data.equals(JPEG));
  assert.equal(fs.readdirSync(photosDir).length, 1);

  const job = (await call('GET', `/api/jobs/${jobId}`, undefined, SHOP)).data;
  assert.equal(job.photos.length, 1);
  assert.equal((await call('GET', '/api/jobs?from=2026-11-01T00:00:00Z&to=2026-11-08T00:00:00Z', undefined, SHOP)).data[0].photo_count, 1);

  assert.equal((await call('DELETE', `/api/jobs/${jobId}/photos/${added.data.id}`, undefined, SHOP)).status, 200);
  assert.equal((await call('GET', `/api/jobs/${jobId}/photos/${added.data.id}`, undefined, SHOP)).status, 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readdirSync(photosDir).length, 0, 'file removed from disk');
});

test('a shop login only reaches the calendar', async () => {
  const meta = (await call('GET', '/api/meta', undefined, SHOP)).data;
  assert.equal(meta.currentRole, 'shop');
  assert.ok(meta.jobStatuses.some((s) => s.id === 'ready'));
  for (const [method, url] of [['GET', '/api/leads'], ['GET', '/api/reminders'], ['GET', `/api/leads/${coachLeadId}`], ['GET', '/api/export.xlsx'], ['GET', '/api/jobs/unscheduled']]) {
    assert.equal((await call(method, url, undefined, SHOP)).status, 403, `${method} ${url}`);
  }
  assert.equal((await call('GET', '/api/meta', undefined, SALES)).data.currentRole, 'sales');
  assert.equal((await fetch(`${base}/`, { headers: { Authorization: SHOP } })).status, 200, 'shop can load the app');
});

test('booked leads without a job show as needing a time and can be scheduled', async () => {
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Old Booking', phone: '702-555-1111', vehicle_type: 'Boat' })).data;
  // Simulate a lead booked before the calendar existed.
  await call('PATCH', `/api/leads/${lead.id}`, { stage: 'booked' });
  const waiting = (await call('GET', '/api/jobs/unscheduled')).data;
  assert.deepEqual(waiting.map((l) => l.full_name), ['Old Booking']);
  const job = await call('POST', `/api/leads/${lead.id}/job`, { job_start: '2026-11-10T15:00:00Z', job_end: '2026-11-10T21:00:00Z' });
  assert.equal(job.status, 201);
  assert.ok(job.data.checklist.some((c) => c.label === 'Hull and gelcoat oxidation level noted'));
  assert.equal((await call('GET', '/api/jobs/unscheduled')).data.length, 0);
  const notBooked = (await call('POST', '/api/leads', { full_name: 'Not Booked', phone: '702-555-2222' })).data.lead;
  assert.equal((await call('POST', `/api/leads/${notBooked.id}/job`, { job_start: '2026-11-10T15:00:00Z', job_end: '2026-11-10T21:00:00Z' })).status, 400);
});

test('checklists fit the vehicle and services', () => {
  const car = checklistFor('Car', ['paint_correction', 'wheels_windows']).map((c) => c.label);
  assert.ok(car.includes('Paint depth readings taken'));
  assert.ok(car.includes('Glass coated'));
  assert.ok(!car.some((l) => /Slide-outs|Hull/.test(l)));
  const sections = [...new Set(checklistFor('Boat', []).map((c) => c.section))];
  assert.deepEqual(sections, ['Check-in', 'Work', 'Finish']);
});

test('the Excel export includes each lead\'s shop job', async () => {
  const res = await call('GET', '/api/export.xlsx');
  assert.equal(res.status, 200);
  const text = res.data.toString('utf8');
  for (const part of ['Job drop-off', 'Job status', 'In the shop', 'Keys in lockbox 4']) assert.ok(text.includes(part), part);
});
