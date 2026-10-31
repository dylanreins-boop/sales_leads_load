const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.TZ = 'America/Los_Angeles';
process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales,Mike:shop-pass:shop';
process.env.APP_PASSWORD = '';
process.env.TWILIO_ACCOUNT_SID = 'AC123';
process.env.TWILIO_AUTH_TOKEN = 'twilio-secret';
process.env.TWILIO_FROM = '+17025550000';
process.env.EMAIL_PROVIDER = 'resend';
process.env.EMAIL_API_KEY = 'key';
process.env.EMAIL_FROM = 'shop@example.com';
process.env.PUBLIC_URL = 'https://leads.example.com';
process.env.BRAND_PHONE = '(702) 555-0000';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { twilioSignature } = require('../src/sms');

// Pretend Twilio and the email service: record what was sent.
const outbox = [];
async function fakeFetch(url, options) {
  if (url.includes('api.twilio.com')) {
    const form = Object.fromEntries(new URLSearchParams(options.body));
    if (form.To === '+17025559999') return new Response(JSON.stringify({ message: 'Invalid number' }), { status: 400 });
    outbox.push({ kind: 'text', to: form.To, body: form.Body });
    return new Response(JSON.stringify({ sid: `SM${outbox.length}` }), { status: 201 });
  }
  const body = JSON.parse(options.body);
  outbox.push({ kind: 'email', to: body.to[0], subject: body.subject, body: body.text });
  return new Response('{}', { status: 200 });
}

let server;
let base;
let db;
before(async () => {
  db = openDatabase(':memory:');
  server = http.createServer(createApp({ db, fetchImpl: fakeFetch }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const login = (name, password) => `Basic ${Buffer.from(`${name}:${password}`).toString('base64')}`;
const ADMIN = login('Dylan', 'admin-pass');
const SAM = login('Sam', 'sales-pass');
const SHOP = login('Mike', 'shop-pass');
async function call(method, url, body, auth = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const at = (day, hour) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour).toISOString(); };
let n = 0;
async function newLead(extra = {}) {
  n += 1;
  return (await call('POST', '/api/leads', { first_name: 'Ana', last_name: `Cruz ${n}`, phone: `702-555-${String(3000 + n)}`, email: `ana${n}@example.com`, vehicle_type: 'Car', vehicle_year: '2023', vehicle_make: 'Tesla', vehicle_model: 'Model 3', ...extra })).data.lead;
}

test('reps text a lead from a saved message; it is logged on the lead', async () => {
  const lead = await newLead();
  const templates = (await call('GET', '/api/texts/templates')).data;
  assert.ok(templates.some((t) => t.id === 'follow_up'));
  const filled = (await call('POST', `/api/leads/${lead.id}/texts/fill`, { template_id: 'follow_up' })).data.body;
  assert.equal(filled, 'Hi Ana, this is Sam with Bob Moses Ceramic Coating. Following up on ceramic coating for your 2023 Tesla Model 3. Is now a good time to chat?');

  outbox.length = 0;
  const sent = await call('POST', `/api/leads/${lead.id}/texts`, { body: filled });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.deepEqual(outbox, [{ kind: 'text', to: `+1702555${String(3000 + n)}`, body: filled }]);
  assert.equal(sent.data.lead.texts.length, 1);
  assert.equal(sent.data.lead.texts[0].user_name, 'Sam');
  assert.ok(sent.data.lead.activities.some((a) => a.type === 'text' && a.note.startsWith('Text sent: Hi Ana')));

  assert.equal((await call('POST', `/api/leads/${lead.id}/texts`, { body: '  ' })).status, 400);
  assert.equal((await call('POST', `/api/leads/${lead.id}/texts`, { body: 'hi' }, SHOP)).status, 403);
  assert.equal((await call('PUT', '/api/texts/templates', { templates: [] })).status, 403, 'only admins edit saved texts');
  const saved = (await call('PUT', '/api/texts/templates', { templates: [...templates, { label: 'Thanks', body: 'Thanks {{first_name}}!' }] }, ADMIN)).data;
  assert.equal(saved.at(-1).label, 'Thanks');
});

test('customer replies land on the lead; STOP opts them out; unknown numbers become leads', async () => {
  const lead = await newLead();
  const post = async (fields, signature) => {
    const body = new URLSearchParams(fields).toString();
    const sig = signature ?? twilioSignature('twilio-secret', 'https://leads.example.com/webhooks/twilio', fields);
    return fetch(`${base}/webhooks/twilio`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body });
  };
  assert.equal((await post({ From: '+1' + lead.phone.replace(/\D/g, ''), Body: 'hi' }, 'forged')).status, 401);
  const ok = await post({ From: '+1' + lead.phone.replace(/\D/g, ''), Body: 'Does Tuesday work?', MessageSid: 'SMin1' });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /<Response><\/Response>/);
  let fresh = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.deepEqual(fresh.texts.map((t) => [t.direction, t.body]), [['in', 'Does Tuesday work?']]);

  await post({ From: '+1' + lead.phone.replace(/\D/g, ''), Body: 'STOP' });
  fresh = (await call('GET', `/api/leads/${lead.id}`)).data;
  assert.equal(fresh.sms_opt_in, 0);
  assert.match((await call('POST', `/api/leads/${lead.id}/texts`, { body: 'hello?' })).data.error, /asked not to get texts/);

  await post({ From: '+17025551234', Body: 'How much for a Model Y?' });
  const found = (await call('GET', '/api/leads?q=5551234')).data;
  assert.equal(found.length, 1);
  assert.equal(found[0].source, 'text');
});

test('booking sends the customer a confirmation by text and email; the day before, a reminder', async () => {
  const lead = await newLead();
  outbox.length = 0;
  const booked = await call('POST', `/api/leads/${lead.id}/disposition`, {
    disposition: 'booked', note: 'Booked', services: ['full_decon_coat'], job_start: at('2027-03-10', 8), job_hours: 4,
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.deepEqual(booked.data.confirmation.sent, ['text', 'email']);
  const text = outbox.find((m) => m.kind === 'text');
  assert.match(text.body, /^Hi Ana, you're booked at Bob Moses Ceramic Coating! Drop-off: Wednesday, Mar 10, 8:00 AM\. Expected pick-up: Wednesday, Mar 10, 12:00 PM\. Questions\? Reply here or call \(702\) 555-0000\.$/);
  const email = outbox.find((m) => m.kind === 'email');
  assert.equal(email.subject, 'Your appointment at Bob Moses Ceramic Coating: Wednesday, Mar 10, 8:00 AM');
  assert.match(email.body, /Services: Full decon & coat/);

  // A booking can skip the confirmation.
  const quiet = await newLead();
  outbox.length = 0;
  await call('POST', `/api/leads/${quiet.id}/disposition`, { disposition: 'booked', note: 'Booked', services: ['wheels'], job_start: at('2027-03-11', 8), job_hours: 4, send_confirmation: false });
  assert.equal(outbox.length, 0);

});

test('the day-before reminder goes out at 10 AM the day before drop-off, once', async () => {
  const { createLeadService } = require('../src/leads');
  const { createJobService } = require('../src/jobs');
  const { createMessageService } = require('../src/messages');
  const leads = createLeadService(db);
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const sentTexts = [];
  const texter = { configured: true, send: async (m) => { sentTexts.push(m); return { id: 'x' }; } };
  const mailer = { configured: false };
  const messages = createMessageService(db, { leads, jobs, texter, mailer, brand: { name: 'Bob Moses Ceramic Coating' } });

  const lead = await newLead();
  db.prepare("UPDATE jobs SET reminder_sent_at = 'old' WHERE reminder_sent_at IS NULL").run();
  const job = jobs.scheduleLead(lead.id, { start: at('2027-04-14', 8), end: at('2027-04-14', 12), hours: 4 }, { user: 'Sam' });
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(at('2027-04-01', 9), job.id);

  assert.equal(await messages.sendDueReminders(new Date(at('2027-04-13', 9))), 0, 'too early');
  assert.equal(await messages.sendDueReminders(new Date(at('2027-04-13', 10))), 1);
  assert.match(sentTexts[0].body, /^Hi Ana, a reminder from Bob Moses Ceramic Coating: we see your 2023 Tesla Model 3 tomorrow, Wednesday, Apr 14, 8:00 AM\./);
  assert.equal(await messages.sendDueReminders(new Date(at('2027-04-13', 11))), 0, 'only once');

  // Moving the job sends a fresh reminder for the new date.
  messages.jobMoved(job.id);
  jobs.updateJob(job.id, { start_at: at('2027-04-20', 8), end_at: at('2027-04-20', 12) });
  assert.equal(await messages.sendDueReminders(new Date(at('2027-04-13', 12))), 0);
  assert.equal(await messages.sendDueReminders(new Date(at('2027-04-19', 10))), 1);

  // Booked after the reminder time: the confirmation covers it.
  const late = jobs.scheduleLead((await newLead()).id, { start: at('2027-05-05', 8), end: at('2027-05-05', 12), hours: 4 }, { user: 'Sam' });
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(at('2027-05-04', 15), late.id);
  assert.equal(await messages.sendDueReminders(new Date(at('2027-05-04', 16))), 0);
  assert.equal(db.prepare('SELECT reminder_sent_at FROM jobs WHERE id = ?').get(late.id).reminder_sent_at, 'skipped');
});

test('admins edit the automatic messages', async () => {
  assert.equal((await call('PUT', '/api/settings/notices', { reminder_enabled: false })).status, 403);
  const saved = (await call('PUT', '/api/settings/notices', { reminder_hour: 17, confirm_text: 'Booked! {{drop_off}}' }, ADMIN)).data;
  assert.deepEqual([saved.reminder_hour, saved.confirm_text], [17, 'Booked! {{drop_off}}']);
  assert.equal((await call('PUT', '/api/settings/notices', { reminder_hour: 3 }, ADMIN)).status, 400);
  assert.equal((await call('PUT', '/api/settings/notices', { confirm_email: '' }, ADMIN)).status, 400);
  const got = (await call('GET', '/api/settings/notices')).data;
  assert.equal(got.textingConfigured, true);
});
