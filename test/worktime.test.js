const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop,Joe:shop-pass2:shop';
process.env.APP_PASSWORD = '';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');

let server;
let base;
let db;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SAM = auth('Sam', 'sales-pass');
const MIKE = auth('Mike', 'shop-pass');
const JOE = auth('Joe', 'shop-pass2');
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3600000;

async function bookedJob(name, phone, hours, amount) {
  const { lead } = (await call('POST', '/api/leads', { full_name: name, phone, vehicle_type: 'Car' })).data;
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: iso(Date.now() - 2 * HOUR), job_hours: hours, job_amount: amount, send_confirmation: false });
  return (await call('GET', `/api/leads/${lead.id}`)).data.jobs[0];
}
// Moves every stretch of work on a job back in time, as if it had been running that long.
const age = (jobId, ms) => db.prepare("UPDATE job_work SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, ?) WHERE job_id = ?").run(`-${ms / 1000} seconds`, jobId);

test('the shop starts, pauses and finishes work; each person\'s time is kept; the vehicle moves to In the shop', async () => {
  const job = await bookedJob('Ana Cruz', '702-555-0901', 4, '1300');
  assert.equal((await call('POST', `/api/jobs/${job.id}/work/start`, {}, SAM)).status, 403, 'sales can\'t run the shop clock');

  let r = (await call('POST', `/api/jobs/${job.id}/work/start`, {}, MIKE)).data;
  assert.equal(r.status, 'in_shop', 'starting work checks the vehicle in');
  assert.deepEqual(r.work.running.map((x) => x.user_name), ['Mike']);
  assert.equal((await call('POST', `/api/jobs/${job.id}/work/start`, {}, MIKE)).data.work.sessions.length, 1, 'starting twice keeps one clock');
  await call('POST', `/api/jobs/${job.id}/work/start`, {}, JOE);
  age(job.id, 2 * HOUR);
  r = (await call('POST', `/api/jobs/${job.id}/work/pause`, {}, MIKE)).data;
  assert.deepEqual(r.work.running.map((x) => x.user_name), ['Joe']);

  // Mike moves to another job; Joe's clock is still on Ana's.
  const other = await bookedJob('Bo Diaz', '702-555-0902', 6, '1700');
  await call('POST', `/api/jobs/${other.id}/work/start`, {}, MIKE);
  await call('POST', `/api/jobs/${other.id}/work/start`, {}, JOE);
  r = (await call('GET', `/api/jobs/${job.id}`, undefined, MIKE)).data;
  assert.equal(r.work.running.length, 0, 'starting another job pauses Joe here');
  assert.ok(Math.abs(r.work.hours - 4) < 0.05, `4 hours logged (2 each), got ${r.work.hours}`);
  assert.deepEqual(r.work.by_person.map((p) => p.name).sort(), ['Joe', 'Mike']);
  assert.equal(r.amount_cents, undefined, 'the shop still never sees the price');

  r = (await call('POST', `/api/jobs/${job.id}/work/finish`, {}, MIKE)).data;
  assert.ok(r.work.finished_at);
  assert.equal(r.work.finished_by, 'Mike');
  const lead = (await call('GET', `/api/leads/${job.lead_id}`)).data;
  assert.ok(lead.activities.some((a) => /^Work finished: 4 hours of work \(4 hours booked\)/.test(a.note)), 'logged on the lead');
  const list = (await call('GET', `/api/jobs?from=${iso(Date.now() - 86400000)}&to=${iso(Date.now() + 86400000)}`, undefined, MIKE)).data;
  assert.equal(list.find((j) => j.id === other.id).working, 2, 'the calendar shows who\'s working');

  // Admins fix the record.
  assert.equal((await call('POST', `/api/jobs/${job.id}/work`, { user_name: 'Joe', started_at: iso(Date.now() - 3 * HOUR), stopped_at: iso(Date.now() - 2 * HOUR) }, MIKE)).status, 403);
  r = (await call('POST', `/api/jobs/${job.id}/work`, { user_name: 'Joe', started_at: iso(Date.now() - 3 * HOUR), stopped_at: iso(Date.now() - 2 * HOUR) }, ADMIN)).data;
  assert.ok(Math.abs(r.work.hours - 5) < 0.05);
  const added = r.work.sessions.find((s) => s.edited_by === 'Dylan');
  r = (await call('PATCH', `/api/work/${added.id}`, { started_at: iso(Date.now() - 2.5 * HOUR), stopped_at: iso(Date.now() - 2 * HOUR) }, ADMIN)).data;
  assert.ok(Math.abs(r.work.hours - 4.5) < 0.05);
  r = (await call('DELETE', `/api/work/${added.id}`, undefined, ADMIN)).data;
  assert.ok(Math.abs(r.work.hours - 4) < 0.05);

  // Analytics: real hours against booked, by vehicle, by person, and revenue per hour.
  const a = (await call('GET', `/api/analytics?from=${iso(Date.now() - 86400000)}&to=${iso(Date.now() + 86400000)}`, undefined, ADMIN)).data.labor;
  assert.equal(a.jobs_finished, 1);
  assert.deepEqual([a.avg_actual_hours, a.avg_booked_hours, a.per_hour_cents], [4, 4, 32500]);
  assert.ok(Math.abs(a.vs_booked - 1) < 0.02);
  assert.ok(Math.abs(a.hours_logged - 4) < 0.05);
  assert.equal(a.working_now, 2);
  assert.deepEqual(a.people.map((p) => p.name).sort(), ['Joe', 'Mike']);
  assert.deepEqual([a.by_vehicle[0].key, a.by_vehicle[0].jobs], ['Car', 1]);
  assert.deepEqual(a.jobs[0].people.sort(), ['Joe', 'Mike']);
});

test('a clock left running overnight stops at closing time', async () => {
  const { createLeadService } = require('../src/leads');
  const { createJobService } = require('../src/jobs');
  const { createWorkTimeService } = require('../src/worktime');
  const db2 = openDatabase(':memory:');
  const leads = createLeadService(db2, { archiveDays: 14 });
  const jobs = createJobService(db2, { leads, photosDir: '/tmp' });
  const work = createWorkTimeService(db2, { jobs, leads });
  const { lead } = leads.ingest({ full_name: 'Cy Long', phone: '702-555-0903', vehicle_type: 'Car' });
  leads.dispositionLead(lead.id, { disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], reminder: false });
  const job = jobs.scheduleLead(lead.id, jobs.parseSchedule({ job_start: new Date(2026, 9, 5, 8).toISOString(), job_end: new Date(2026, 9, 6, 16).toISOString() }), {});
  work.start(job.id, { user: 'Mike' });
  db2.prepare('UPDATE job_work SET started_at = ?').run(new Date(2026, 9, 5, 13).toISOString());
  assert.equal(work.stopForgotten(new Date(2026, 9, 5, 22)), 0, 'not before midnight');
  assert.equal(work.stopForgotten(new Date(2026, 9, 6, 7)), 1);
  const s = work.summary(job.id).sessions[0];
  assert.equal(s.auto_stopped, true);
  assert.equal(new Date(s.stopped_at).getHours(), 16, 'stopped at closing (8 AM + 8 hours)');
  assert.equal(s.hours, 3);
});
