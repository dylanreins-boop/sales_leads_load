const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

process.env.APP_PASSWORD = '';
process.env.APP_USERS = '';
process.env.WEBSITE_API_KEY = 'site-key';
process.env.FB_VERIFY_TOKEN = 'verify-me';
process.env.FB_APP_SECRET = 'app-secret';
process.env.FB_PAGE_ACCESS_TOKEN = 'page-token';
process.env.FB_FORM_IDS = 'form-1';
process.env.REMINDER_HOUR = '9';
process.env.EMAIL_PROVIDER = 'resend';
process.env.EMAIL_API_KEY = 'email-key';
process.env.EMAIL_FROM = 'office@example.com';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { stageAfterDisposition, DISPOSITIONS_BY_ID } = require('../src/pipeline');

const fbLead = (id, name, phone) => ({
  id,
  created_time: '2026-10-22T14:03:11+0000',
  form_id: 'form-1',
  field_data: [
    { name: 'full_name', values: [name] },
    { name: 'phone_number', values: [phone] },
    { name: 'email', values: [`${id}@example.com`] },
    { name: 'what_service_are_you_interested_in?', values: ['Roof repair'] },
  ],
});

const sentEmails = [];

// Fake Graph API (single-lead lookups and form lead lists) and email service.
const fakeFetch = async (url, options = {}) => {
  const u = new URL(url);
  const json = (body) => ({ ok: true, json: async () => body });
  if (u.hostname === 'api.resend.com') {
    const message = JSON.parse(options.body);
    if (message.to[0].startsWith('bounce')) return { ok: false, status: 422, text: async () => 'invalid address' };
    sentEmails.push({ message, auth: options.headers.Authorization });
    return json({ id: 'email-1' });
  }
  if (u.pathname.endsWith('/form-1/leads')) {
    return json({ data: [fbLead('fb-200', 'Sam Sync', '555-000-0200'), fbLead('fb-201', 'Pat Sync', '555-000-0201')] });
  }
  const id = u.pathname.split('/').pop();
  return json(fbLead(id, 'Jordan Facebook', '+1 (555) 000-0100'));
};

let server;
let base;

before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl: fakeFetch }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, data, headers: res.headers };
}

const findLead = async (name) => (await call('GET', '/api/leads')).data.find((l) => l.full_name === name);

test('website form creates a lead and requires the API key', async () => {
  const denied = await call('POST', '/api/intake/website', { name: 'Nope' });
  assert.equal(denied.status, 401);

  const ok = await call('POST', '/api/intake/website',
    { first_name: 'Alex', last_name: 'Web', phone: '555-111-2222', message: 'Need a quote' },
    { 'X-API-Key': 'site-key' });
  assert.equal(ok.status, 201);
  const lead = await findLead('Alex Web');
  assert.equal(lead.source, 'website');
  assert.equal(lead.stage, 'new');
});

test('url-encoded website form redirects to the thank-you page and ignores spam', async () => {
  const form = new URLSearchParams({ name: 'Casey Form', email: 'casey@example.com', api_key: 'site-key', _redirect: 'https://example.com/thanks' });
  const res = await call('POST', '/api/intake/website', form.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://example.com/thanks');
  assert.ok(await findLead('Casey Form'));

  await call('POST', '/api/intake/website', { name: 'Spam Bot', _gotcha: 'x', api_key: 'site-key' });
  assert.equal(await findLead('Spam Bot'), undefined);
});

test('repeat submission from the same phone is logged on the existing lead', async () => {
  await call('POST', '/api/intake/website', { name: 'Alex Again', phone: '(555) 111-2222', message: 'Still interested' }, { 'X-API-Key': 'site-key' });
  const leads = (await call('GET', '/api/leads')).data;
  assert.equal(leads.filter((l) => l.phone?.replace(/\D/g, '').endsWith('5551112222')).length, 1);
  const detail = (await call('GET', `/api/leads/${(await findLead('Alex Web')).id}`)).data;
  assert.ok(detail.activities.some((a) => a.type === 'reinquiry' && a.note.includes('Still interested')));
});

test('facebook webhook verification handshake', async () => {
  const ok = await call('GET', '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(ok.data, 12345);
  const bad = await call('GET', '/webhooks/facebook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1');
  assert.equal(bad.status, 403);
});

test('facebook webhook checks the signature and pulls the lead from the Graph API', async () => {
  const payload = JSON.stringify({
    object: 'page',
    entry: [{ id: 'page-1', changes: [{ field: 'leadgen', value: { leadgen_id: 'fb-100', form_id: 'form-1', page_id: 'page-1' } }] }],
  });
  const unsigned = await call('POST', '/webhooks/facebook', payload, { 'X-Hub-Signature-256': 'sha256=bad' });
  assert.equal(unsigned.status, 401);

  const sig = `sha256=${crypto.createHmac('sha256', 'app-secret').update(payload).digest('hex')}`;
  const res = await call('POST', '/webhooks/facebook', payload, { 'X-Hub-Signature-256': sig });
  assert.equal(res.status, 201);
  assert.equal(res.data.results[0].created, true);

  const lead = (await call('GET', `/api/leads/${res.data.results[0].lead_id}`)).data;
  assert.equal(lead.source, 'facebook');
  assert.equal(lead.full_name, 'Jordan Facebook');
  assert.match(lead.message, /Roof repair/);
  assert.equal(lead.received_at, '2026-10-22T14:03:11.000Z');

  // Meta retries deliveries; the same lead must not be added twice.
  const again = await call('POST', '/webhooks/facebook', payload, { 'X-Hub-Signature-256': sig });
  assert.equal(again.data.results[0].created, false);
});

test('facebook sync pulls leads from configured forms', async () => {
  const res = await call('POST', '/api/facebook/sync');
  assert.deepEqual(res.data, { fetched: 2, created: 2 });
  const again = await call('POST', '/api/facebook/sync');
  assert.deepEqual(again.data, { fetched: 2, created: 0 });
});

test('disposition moves the lead and sets a call reminder for tomorrow', async () => {
  const lead = await findLead('Alex Web');
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Left VM' });
  assert.equal(res.status, 201);
  assert.equal(res.data.lead.stage, 'voicemail');

  const due = new Date(res.data.reminder.due_at);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  assert.equal(due.toDateString(), tomorrow.toDateString());
  assert.equal(due.getHours(), 9);

  const reminders = (await call('GET', '/api/reminders')).data.filter((r) => r.lead_id === lead.id);
  assert.equal(reminders.length, 1);
});

test('next disposition closes the old reminder and walks through follow-ups', async () => {
  const lead = await findLead('Alex Web');
  const custom = new Date(Date.now() + 2 * 86400_000).toISOString();
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer', note: 'Test call', reminder_at: custom });
  assert.equal(res.data.lead.stage, 'follow_up_1');
  assert.equal(res.data.reminder.due_at, custom);
  const open = (await call('GET', '/api/reminders')).data.filter((r) => r.lead_id === lead.id);
  assert.equal(open.length, 1, 'only the newest reminder stays open');

  const booked = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'booked', note: 'Test call' });
  assert.equal(booked.data.lead.stage, 'booked');
});

test('updated notes keeps the stage and still sets a reminder', async () => {
  const lead = await findLead('Pat Sync');
  await call('PATCH', `/api/leads/${lead.id}`, { stage: 'follow_up_1' });
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'updated_notes', note: 'Prefers texts' });
  assert.equal(res.data.lead.stage, 'follow_up_1');
  assert.equal(res.data.lead.last_disposition, 'updated_notes');
  assert.equal(res.data.lead.last_contacted_at, null, 'a note is not a call');
  assert.ok(res.data.reminder);
});

test('waste dispositions skip the reminder unless asked', async () => {
  const lead = await findLead('Casey Form');
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'not_interested', note: 'Test call' });
  assert.equal(res.data.lead.stage, 'waste');
  assert.equal(res.data.reminder, null);

  const bad = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'nope', note: 'Test call' });
  assert.equal(bad.status, 400);
});

test('reminders can be snoozed and completed; stage can be moved by hand', async () => {
  const lead = await findLead('Jordan Facebook');
  const { reminder } = (await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'callback_requested', note: 'Test call' })).data;
  const later = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await call('POST', `/api/reminders/${reminder.id}/snooze`, { due_at: later })).data.due_at, later);
  assert.ok((await call('POST', `/api/reminders/${reminder.id}/complete`)).data.done_at);

  const moved = await call('PATCH', `/api/leads/${lead.id}`, { stage: 'follow_up_2' });
  assert.equal(moved.data.stage, 'follow_up_2');
  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, { stage: 'bogus' })).status, 400);
});

test('attempt chain stops at Follow Up 3 and leaves other stages alone', () => {
  const vm = DISPOSITIONS_BY_ID.no_answer_vm;
  assert.equal(stageAfterDisposition('new', vm), 'voicemail');
  assert.equal(stageAfterDisposition('follow_up_2', vm), 'follow_up_3');
  assert.equal(stageAfterDisposition('follow_up_3', vm), 'follow_up_3');
  assert.equal(stageAfterDisposition('contacted', vm), 'contacted');
});

test('follow-up email is off until the user turns it on', async () => {
  const settings = (await call('GET', '/api/settings/email')).data;
  assert.equal(settings.enabled, false);
  assert.match(settings.body, /\{\{first_name\}\}/);

  await call('POST', '/api/leads', { first_name: 'Emma', last_name: 'Stone', email: 'emma@example.com' });
  const lead = await findLead('Emma Stone');
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Test call' });
  assert.equal(res.data.email, null);
  assert.equal(sentEmails.length, 0);

  const blank = await call('PUT', '/api/settings/email', { enabled: true, subject: '', body: '' });
  assert.equal(blank.status, 400);
});

test('left-voicemail disposition emails the lead using the saved template', async () => {
  const saved = await call('PUT', '/api/settings/email', {
    enabled: true, subject: 'Missed you, {{first_name}}', body: 'Hi {{first_name}}, call me back. {{unknown}}',
  });
  assert.equal(saved.data.enabled, true);

  const lead = await findLead('Emma Stone');
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Test call' });
  assert.equal(res.data.email.status, 'sent');
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0].message.to, ['emma@example.com']);
  assert.equal(sentEmails[0].message.subject, 'Missed you, Emma');
  assert.equal(sentEmails[0].message.text, 'Hi Emma, call me back. {{unknown}}');
  assert.equal(sentEmails[0].auth, 'Bearer email-key');
  assert.equal(res.data.lead.emails.length, 1);
  assert.ok(res.data.lead.activities.some((a) => a.type === 'email'));

  // Other dispositions, an unticked box, and leads without email don't send.
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'contacted_follow_up', note: 'Test call' });
  await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Test call', send_email: false });
  const noEmail = await findLead('Tanya Brooks') || (await call('POST', '/api/leads', { full_name: 'Tanya Brooks', phone: '555-909-4410' })).data.lead;
  await call('POST', `/api/leads/${noEmail.id}/disposition`, { disposition: 'no_answer_vm', note: 'Test call' });
  assert.equal(sentEmails.length, 1);
});

test('a failed email is recorded on the lead without undoing the disposition', async () => {
  await call('POST', '/api/leads', { full_name: 'Bad Address', email: 'bounce@example.com' });
  const lead = await findLead('Bad Address');
  const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer_vm', note: 'Test call' });
  assert.equal(res.status, 201);
  assert.equal(res.data.lead.stage, 'voicemail');
  assert.equal(res.data.email.status, 'failed');
  assert.match(res.data.email.error, /422/);
  await call('PUT', '/api/settings/email', { enabled: false });
});

test('a disposition without notes is rejected', async () => {
  const lead = await findLead('Chris Sync') || await findLead('Pat Sync');
  for (const note of [undefined, '', '   ']) {
    const res = await call('POST', `/api/leads/${lead.id}/disposition`, { disposition: 'no_answer', note });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /note/i);
  }
});

test('dashboard is served and unknown API routes 404', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Lead Pipeline/);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
});

test('vehicle details are picked up from website and Facebook forms', () => {
  const { mapWebsiteLead } = require('../src/website');
  const { mapFacebookLead } = require('../src/facebook');
  const web = mapWebsiteLead({ name: 'Kai Lee', phone: '555-1234567', vehicle_year: '2023', make: 'Tesla', model: 'Model Y', color: 'Pearl White', type: 'car' });
  assert.equal(web.vehicle_year, '2023');
  assert.equal(web.vehicle_make, 'Tesla');
  assert.equal(web.vehicle_model, 'Model Y');
  assert.equal(web.vehicle_color, 'Pearl White');
  assert.equal(web.vehicle_type, 'Car');

  const fb = mapFacebookLead({
    id: 'fb-v1',
    field_data: [
      { name: 'full_name', values: ['Rae Kim'] },
      { name: 'what_is_the_year,_make_and_model_of_your_vehicle?', values: ['2021 BMW M3'] },
      { name: 'what_color_is_your_vehicle?', values: ['Isle of Man Green'] },
      { name: 'what_type_of_vehicle_is_it?', values: ['Motorhome'] },
    ],
  });
  assert.equal(fb.vehicle_model, '2021 BMW M3');
  assert.equal(fb.vehicle_color, 'Isle of Man Green');
  assert.equal(fb.vehicle_type, 'Coach / RV');

  const { normalizeVehicleType } = require('../src/vehicle');
  assert.equal(normalizeVehicleType('Pontoon boat'), 'Boat');
  assert.equal(normalizeVehicleType('Sea-Doo jet ski'), 'Jet Ski');
  assert.equal(normalizeVehicleType('Cessna aircraft'), 'Plane');
  assert.equal(normalizeVehicleType('pickup'), 'Truck');
  assert.equal(normalizeVehicleType('Golf cart'), 'Golf cart', 'unknown types are kept as typed');
});

test('lead info can be edited and every change is logged', async () => {
  await call('POST', '/api/intake/website',
    { first_name: 'Nora', last_name: 'Diaz', phone: '555-888-1212', vehicle_year: '2019', make: 'Audi', model: 'Q5' },
    { 'X-API-Key': 'site-key' });
  const lead = await findLead('Nora Diaz');
  assert.equal(lead.vehicle_make, 'Audi');

  const res = await call('PATCH', `/api/leads/${lead.id}`, {
    vehicle_year: '2020', vehicle_make: 'Audi', vehicle_color: 'Navarra Blue', vehicle_type: 'SUV', last_name: 'Diaz-Ruiz', email: 'nora@example.com',
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.vehicle_year, '2020');
  assert.equal(res.data.vehicle_color, 'Navarra Blue');
  assert.equal(res.data.vehicle_type, 'SUV');
  assert.equal(res.data.full_name, 'Nora Diaz-Ruiz');
  const log = res.data.activities.find((a) => a.type === 'info_updated');
  assert.match(log.note, /Year: 2019 → 2020/);
  assert.match(log.note, /Color: \(blank\) → Navarra Blue/);
  assert.doesNotMatch(log.note, /Make/, 'unchanged fields are not logged');

  assert.equal((await call('PATCH', `/api/leads/${lead.id}`, { vehicle_year: '20' })).status, 400);
  assert.ok((await call('GET', '/api/leads?q=audi q5')).data.some((l) => l.id === lead.id), 'search finds the vehicle');
});
