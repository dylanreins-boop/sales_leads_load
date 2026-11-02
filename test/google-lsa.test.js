const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../src/db');
const { createLeadService } = require('../src/leads');
const { createGoogleLsaClient } = require('../src/google-lsa');

const KEYS = { developerToken: 'dev', clientId: 'cid', clientSecret: 'sec', refreshToken: 'ref', customerId: '1234567890', loginCustomerId: '999', apiVersion: 'v25' };

function fakeGoogle(leadsByCall) {
  const calls = [];
  let searches = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    const { query } = JSON.parse(opts.body);
    if (/FROM local_services_lead_conversation/.test(query)) {
      return new Response(JSON.stringify({ results: [{ localServicesLeadConversation: { messageDetails: { text: 'Need a quote for my 40 ft Newmar' } } }] }));
    }
    const results = leadsByCall[Math.min(searches++, leadsByCall.length - 1)].map((g) => ({ localServicesLead: g }));
    return new Response(JSON.stringify({ results }));
  };
  return { fetchImpl, calls };
}

test('Google Local Services leads come in once each, tagged Google, with the message text', async () => {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const first = [
    { id: '101', resourceName: 'customers/1234567890/localServicesLeads/101', leadType: 'PHONE_CALL', leadStatus: 'NEW', creationDateTime: '2026-11-02 09:15:00', contactDetails: { phoneNumber: '+17025550501' } },
    { id: '102', resourceName: 'customers/1234567890/localServicesLeads/102', leadType: 'MESSAGE', leadStatus: 'NEW', creationDateTime: '2026-11-02 09:40:00', contactDetails: { phoneNumber: '+17025550502', consumerName: 'Rita Gomez' } },
    { id: '103', leadType: 'PHONE_CALL', leadStatus: 'WIPED_OUT', creationDateTime: '2026-11-02 09:50:00', contactDetails: null },
  ];
  const later = [...first, { id: '104', leadType: 'BOOKING', leadStatus: 'NEW', creationDateTime: '2026-11-02 11:00:00', contactDetails: { phoneNumber: '+17025550501', consumerName: 'Sal' } }];
  const { fetchImpl, calls } = fakeGoogle([first, later]);
  const g = createGoogleLsaClient(KEYS, { db, leads, fetchImpl });
  assert.equal(g.configured, true);

  assert.deepEqual(await g.sync({ at: new Date('2026-11-02T18:00:00Z') }), { fetched: 3, created: 2 });
  const search = calls.find((c) => c.url.includes('googleAds:search'));
  assert.equal(search.url, 'https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search');
  assert.deepEqual([search.opts.headers.Authorization, search.opts.headers['developer-token'], search.opts.headers['login-customer-id']], ['Bearer tok', 'dev', '999']);
  assert.match(JSON.parse(search.opts.body).query, /creation_date_time >= '2026-10-03 18:00:00'/, 'first sync looks back 30 days');

  const rita = leads.listLeads({ q: 'Gomez' })[0];
  assert.deepEqual([rita.source, rita.campaign, rita.message], ['google', 'Google Local Services', 'Sent a message: Need a quote for my 40 ft Newmar']);
  assert.equal(leads.listLeads({ q: '0501' })[0].message, 'Called');

  // Next sync: the same three aren't added again; a booking from a known number is logged on that lead.
  assert.deepEqual(await g.sync({ at: new Date('2026-11-02T20:00:00Z') }), { fetched: 4, created: 0 });
  assert.equal(leads.listLeads({ q: '0501' }).length, 1);
  assert.deepEqual(await g.sync({ at: new Date('2026-11-02T20:05:00Z') }), { fetched: 4, created: 0 });
  const caller = leads.getLead(leads.listLeads({ q: '0501' })[0].id);
  assert.equal(caller.activities.filter((a) => a.type === 'reinquiry').length, 1, 'logged once, not every sync');
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'sign-in is reused');
  assert.equal(g.status().last_error, null);
});

test('without the keys it says what to set; Google errors are reported', async () => {
  const db = openDatabase(':memory:');
  const leads = createLeadService(db, { archiveDays: 14 });
  const off = createGoogleLsaClient({ ...KEYS, refreshToken: '' }, { db, leads, fetchImpl: async () => { throw new Error('should not call'); } });
  assert.equal(off.configured, false);
  await assert.rejects(off.sync(), /GOOGLE_ADS/);

  const failing = createGoogleLsaClient(KEYS, { db, leads, fetchImpl: async (url) => (url.includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'tok' }))
    : new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 })) });
  await assert.rejects(failing.sync(), /does not have permission/);
  assert.match(failing.status().last_error, /does not have permission/);
});
