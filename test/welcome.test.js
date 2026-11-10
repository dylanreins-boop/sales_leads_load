const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'America/Los_Angeles';

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createJobService } = require('../src/jobs');
const { createMessageService, parseBestTime } = require('../src/messages');

test('replies are read into a best time of day', () => {
  const cases = {
    'Mornings are best': 'Morning',
    'afternoon works': 'Afternoon',
    'After 3 works for me': 'Afternoon',
    'anytime after 5pm': 'Evening',
    'evenings or weekends': 'Evening, weekends',
    'Anytime!': 'Anytime',
    'between 10 and 11am': 'Morning',
    'Lunch time or after work': 'Afternoon or Evening',
    'Saturday': 'Weekends',
    'Thursday works best for me. Do you have anything open?': 'Thursday',
    'tuesday or wednesday mornings': 'Morning, Tuesday or Wednesday',
    '10:30 am': 'Morning',
    'I have a 2021 Model 3, how much?': null,
    'Call me at 702 555 1234': null,
  };
  for (const [text, label] of Object.entries(cases)) assert.equal(parseBestTime(text)?.label ?? null, label, text);
});

function setup() {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const jobs = createJobService(db, { leads, photosDir: '/tmp' });
  const texts = [];
  const texter = { configured: true, send: async (m) => { texts.push(m); return { id: `SM${texts.length}` }; } };
  const messages = createMessageService(db, { leads, jobs, texter, mailer: { configured: false }, brand: { name: 'Bob Moses Ceramic Coating' } });
  return { db, leads, messages, texts };
}
const at = (h, m = 0, day = 3) => new Date(2026, 10, day, h, m);

test('new leads get the welcome text during the day; night leads get it at 8 AM', async () => {
  const { leads, messages, texts } = setup();
  const { lead: day } = leads.ingest({ source: 'website', first_name: 'Ana', phone: '702-555-0101' });
  const { lead: night } = leads.ingest({ source: 'facebook', first_name: 'Bo', phone: '702-555-0102' });
  const { lead: imported } = leads.ingest({ source: 'import', first_name: 'Cy', phone: '702-555-0103' }, { silent: true });
  const { lead: optedOut } = leads.ingest({ source: 'website', first_name: 'Di', phone: '702-555-0104', sms_opt_in: false });
  assert.equal(messages.queueWelcome(day, { at: at(14) }), true);
  assert.equal(messages.queueWelcome(night, { at: at(23, 30) }), true);
  assert.equal(messages.queueWelcome(imported, { at: at(14) }), false);
  assert.equal(messages.queueWelcome(optedOut, { at: at(14) }), false);
  assert.equal(leads.getLead(night.id).welcome_due_at, at(8, 0, 4).toISOString(), 'night lead waits for 8 AM');

  assert.equal(await messages.sendWelcomes(at(14, 1)), 1);
  assert.equal(texts[0].body, 'Hi Ana, thanks for your interest in Bob Moses Ceramic Coating! What time of day is best to reach you: morning, afternoon or evening? Just reply here.');
  assert.equal(await messages.sendWelcomes(at(14, 2)), 0, 'once');
  assert.equal(await messages.sendWelcomes(at(7, 59, 4)), 0);
  assert.equal(await messages.sendWelcomes(at(8, 0, 4)), 1);
});

test('the customer\'s answer goes on the lead and they get a short thanks; a rep can set it too', async () => {
  const { leads, messages, texts } = setup();
  const { lead } = leads.ingest({ source: 'website', first_name: 'Hank', phone: '702-555-6623' });
  // Sent yesterday at 10 AM (welcome texts only go out in the daytime; answers count for 14 days).
  const sent = new Date(); sent.setDate(sent.getDate() - 1); sent.setHours(10, 0, 0, 0);
  messages.queueWelcome(lead, { at: sent });
  await messages.sendWelcomes(new Date(sent.getTime() + 60000));
  messages.receiveText({ from: '+17025556623', body: 'How much for a 43 ft coach?' });
  assert.equal(leads.getLead(lead.id).best_time, null, 'not an answer');
  messages.receiveText({ from: '+17025556623', body: 'After 3 works best, weekdays' });
  await new Promise((r) => setTimeout(r, 10));
  const l = leads.getLead(lead.id);
  assert.deepEqual([l.best_time, l.best_time_note, l.best_time_by], ['Afternoon, weekdays', 'After 3 works best, weekdays', 'customer']);
  assert.equal(texts.at(-1).body, 'Thanks Hank! We will reach out in the afternoon.');
  const card = leads.listLeads({}).find((x) => x.id === lead.id);
  assert.equal(card.best_time, 'Afternoon, weekdays', 'on the board card');

  leads.updateLead(lead.id, { best_time: 'Morning' }, { user: 'Sam' });
  assert.deepEqual([leads.getLead(lead.id).best_time, leads.getLead(lead.id).best_time_by], ['Morning', 'Sam']);
});

test('a lead a rep already reached doesn\'t get the welcome text', async () => {
  const { leads, messages, texts } = setup();
  const { lead } = leads.ingest({ source: 'website', first_name: 'Eve', phone: '702-555-0105' });
  messages.queueWelcome(lead, { at: at(23) });
  leads.dispositionLead(lead.id, { disposition: 'contacted_follow_up', note: 'Talked', reminder: false });
  assert.equal(await messages.sendWelcomes(at(8, 5, 4)), 0);
  assert.equal(texts.length, 0);
});
