const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.APP_USERS = 'Dylan:admin-pass:admin,Sam:sales-pass:sales';
process.env.APP_PASSWORD = '';
process.env.CALLS_ENABLED = '1';
process.env.CALL_HOURS = '0-24';
process.env.CALL_NOTES_DELAY_MS = '0';
process.env.TWILIO_ACCOUNT_SID = 'AC123';
process.env.TWILIO_AUTH_TOKEN = 'tw-secret';
process.env.TWILIO_FROM = '+17025550000';
process.env.PUBLIC_URL = 'https://leads.example.com';

const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { twilioSignature } = require('../src/sms');

const twilioCalls = [];
const fetchImpl = async (url, opts) => {
  if (String(url).includes('api.twilio.com') && String(url).endsWith('/Calls.json')) {
    twilioCalls.push(Object.fromEntries(new URLSearchParams(opts.body)));
    return new Response(JSON.stringify({ sid: `CA${twilioCalls.length}` }), { status: 201 });
  }
  return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
};
// Stands in for Claude: notes from what was said.
const summarized = [];
const summarizer = {
  configured: true,
  async summarize({ lines, lead }) {
    summarized.push({ lines, lead });
    return {
      source: 'ai',
      error: null,
      notes: { summary: 'Ana wants her Model Y coated; $1,300 quoted; she will check with her husband.', customer_wants: '2024 Tesla Model Y, full coat', price_quoted: '$1,300', objections: ['Checking with husband'], next_step: '', outcome: 'follow_up', flags: ['no_next_step'], coaching_tip: 'Set a time to follow up before hanging up.' },
    };
  },
};

let server;
let base;
before(async () => {
  server = http.createServer(createApp({ db: openDatabase(':memory:'), fetchImpl, summarizer }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const auth = (n, p) => `Basic ${Buffer.from(`${n}:${p}`).toString('base64')}`;
const ADMIN = auth('Dylan', 'admin-pass');
const SAM = auth('Sam', 'sales-pass');
async function call(method, url, body, a = SAM) {
  const res = await fetch(base + url, { method, headers: { Authorization: a, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* TwiML */ }
  return { status: res.status, data };
}
// What Twilio would post, signed.
async function twilio(path, fields, { sign = true } = {}) {
  const sig = twilioSignature('tw-secret', `https://leads.example.com${path}`, fields);
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sign && { 'X-Twilio-Signature': sig }) }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, text: await res.text() };
}

test('a dialer call: rings the rep, tells the customer, writes out the call, and leaves notes; admins review it', async () => {
  const meta = (await call('GET', '/api/meta')).data;
  assert.equal(meta.callsEnabled, true);
  const { lead } = (await call('POST', '/api/leads', { full_name: 'Ana Cruz', phone: '702-555-0901', vehicle_type: 'Car', vehicle_year: '2024', vehicle_make: 'Tesla', vehicle_model: 'Model Y' })).data;

  assert.match((await call('POST', `/api/leads/${lead.id}/calls`)).data.error, /Add your phone number/);
  assert.equal((await call('PUT', '/api/calls/me', { call_phone: 'abc' })).status, 400);
  await call('PUT', '/api/calls/me', { call_phone: '702-555-0777' });
  const started = await call('POST', `/api/leads/${lead.id}/calls`);
  assert.equal(started.status, 201);
  const id = started.data.id;
  assert.deepEqual([twilioCalls[0].To, twilioCalls[0].From, twilioCalls[0].Url], ['+17025550777', '+17025550000', `https://leads.example.com/webhooks/twilio/calls/${id}/answer`], 'rings the rep first');
  assert.match((await call('POST', `/api/leads/${lead.id}/calls`)).data.error, /already have a call/);

  assert.equal((await twilio(`/webhooks/twilio/calls/${id}/answer`, { CallSid: 'CA1' }, { sign: false })).status, 401, 'only Twilio');
  const answer = (await twilio(`/webhooks/twilio/calls/${id}/answer`, { CallSid: 'CA1' })).text;
  assert.match(answer, /<Say>Calling Ana\.<\/Say>/);
  assert.match(answer, /<Start><Transcription statusCallbackUrl="https:\/\/leads\.example\.com\/webhooks\/twilio\/calls\/\d+\/transcript" track="both_tracks"/);
  assert.match(answer, /<Dial callerId="\+17025550000"[^>]*><Number url="[^"]+\/notice">\+17025550901<\/Number><\/Dial>/);
  assert.doesNotMatch(answer, /<Record|record=/i, 'never recorded');
  const notice = (await twilio(`/webhooks/twilio/calls/${id}/notice`, { CallSid: 'CA2' })).text;
  assert.match(notice, /may be transcribed for quality/);

  const say = (Track, transcript, Final = 'true') => twilio(`/webhooks/twilio/calls/${id}/transcript`, { TranscriptionEvent: 'transcription-content', Track, Final, TranscriptionData: JSON.stringify({ transcript, confidence: 0.9 }) });
  await say('inbound_track', 'Hi Ana, it\'s Sam with Bob Moses Ceramic Coating.');
  await say('outbound_track', 'Hi, yes, about the Model', 'false');
  await say('outbound_track', 'Hi, yes, about the Model Y.');
  await say('inbound_track', 'The full coat comes to thirteen hundred.');
  await say('outbound_track', 'Let me check with my husband.');
  const live = (await call('GET', `/api/calls/${id}`)).data;
  assert.equal(live.status, 'connected');
  assert.deepEqual(live.lines.map((l) => l.speaker), ['rep', 'customer', 'rep', 'customer'], 'partials skipped, each side labeled');

  assert.equal((await twilio(`/webhooks/twilio/calls/${id}/dialed`, { DialCallStatus: 'completed', DialCallDuration: '95' })).text.includes('<Hangup/>'), true);
  await twilio(`/webhooks/twilio/calls/${id}/status`, { CallStatus: 'completed' });
  await new Promise((r) => setTimeout(r, 30));
  const done = (await call('GET', `/api/calls/${id}`)).data;
  assert.deepEqual([done.status, done.talk_seconds, done.summary_source, done.suggested_disposition], ['ended', 95, 'ai', 'contacted_follow_up']);
  assert.deepEqual(done.flag_labels, ['No next step set']);
  assert.equal(summarized[0].lead.vehicle, '2024 Tesla Model Y');
  assert.equal(summarized[0].lines.length, 4);
  const activity = (await call('GET', `/api/leads/${lead.id}`)).data.activities.map((a) => a.note);
  assert.ok(activity.some((n) => /^Call notes \(2 min\): Ana wants her Model Y coated/.test(n)));
  assert.equal((await call('GET', `/api/leads/${lead.id}/calls`)).data.length, 1);

  // Admins review.
  assert.equal((await call('GET', '/api/calls')).status, 403, 'admins only');
  const list = (await call('GET', '/api/calls?flagged=yes&reviewed=no', undefined, ADMIN)).data;
  assert.deepEqual([list.length, list[0].lead_name, list[0].user_name], [1, 'Ana Cruz', 'Sam']);
  assert.equal((await call('PATCH', `/api/calls/${id}/review`, { score: 4 })).status, 403);
  assert.equal((await call('PATCH', `/api/calls/${id}/review`, { score: 9 }, ADMIN)).status, 400);
  const reviewed = (await call('PATCH', `/api/calls/${id}/review`, { score: 4, comment: 'Good price talk. Book a follow-up time next call.' }, ADMIN)).data;
  assert.deepEqual([reviewed.review_score, reviewed.reviewed_by], [4, 'Dylan']);
  assert.ok((await call('GET', `/api/leads/${lead.id}`)).data.activities.some((a) => /Coaching from Dylan on Sam's call/.test(a.note)), 'the rep sees the coaching on the lead');
  assert.equal((await call('GET', '/api/calls?reviewed=no', undefined, ADMIN)).data.length, 0);

  const stats = (await call('GET', `/api/analytics?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`, undefined, ADMIN)).data.calls;
  assert.deepEqual([stats.calls, stats.connected, stats.talk_seconds, stats.reps[0].name, stats.reps[0].avg_score], [1, 1, 95, 'Sam', 4]);
});

test('the call list puts due call-backs first, then new leads; the rep missing the ring leaves no notes', async () => {
  const { lead: fresh } = (await call('POST', '/api/leads', { full_name: 'Bo New', phone: '702-555-0902' })).data;
  const { lead: due } = (await call('POST', '/api/leads', { full_name: 'Cy Due', phone: '702-555-0903' })).data;
  await call('POST', `/api/leads/${due.id}/disposition`, { disposition: 'no_answer_vm', note: 'VM', reminder_at: new Date(Date.now() - 60000).toISOString() });
  const { lead: dnc } = (await call('POST', '/api/leads', { full_name: 'Di Stop', phone: '702-555-0904' })).data;
  await call('POST', `/api/leads/${dnc.id}/disposition`, { disposition: 'do_not_call', note: 'Asked us to stop' });
  const q = (await call('GET', '/api/calls/queue')).data;
  const names = q.map((l) => l.name);
  assert.ok(names.indexOf('Cy Due') < names.indexOf('Bo New'), names.join(', '));
  assert.ok(!names.includes('Di Stop'));
  assert.equal(q.find((l) => l.name === 'Cy Due').why, 'Call-back due');
  assert.match((await call('POST', `/api/leads/${dnc.id}/calls`)).data.error, /do not call/);

  const { id } = (await call('POST', `/api/leads/${fresh.id}/calls`)).data;
  await twilio(`/webhooks/twilio/calls/${id}/status`, { CallStatus: 'no-answer' });
  const c = (await call('GET', `/api/calls/${id}`)).data;
  assert.deepEqual([c.status, c.summary], ['rep_missed', null]);
  assert.equal((await call('GET', '/api/calls/me')).data.active, null, 'free to call again');
});
