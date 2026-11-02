'use strict';
// Growing the lead count: referral links (customers and partners) and ad spend vs. results.
// Uses the helpers from app.js ($, h, fill, api, toast, fail, state, showPanel, isAdmin, money).

// ---------- a customer's referral link (lead drawer) ----------
function renderReferral(lead) {
  const section = $('#referSection');
  const customer = lead.stage === 'booked' || (lead.jobs || []).some((j) => j.status !== 'cancelled');
  section.hidden = !customer && !lead.referred_by;
  if (section.hidden) return;
  const url = lead.referral_code ? `${location.origin}/r/${lead.referral_code}` : null;
  const canText = lead.phone && lead.sms_opt_in !== 0 && state.meta.textingConfigured;
  fill($('#referBox'),
    lead.referred_by && h('p', { class: 'referred-by' }, `${lead.referred_by.kind === 'partner' ? 'Sent by partner' : 'Referred by'} ${lead.referred_by.name}`),
    customer && h('p', { class: 'muted' }, url ? 'Their link to share with friends. Anyone who fills it in comes in as a lead credited to them.'
      : 'Give this customer a link to share; anyone who uses it comes in credited to them.'),
    customer && h('div', { class: 'small-btns refer-btns' },
      url && h('span', { class: 'refer-url' }, url.replace(/^https?:\/\//, '')),
      h('button', { type: 'button', onclick: () => referralLink(lead, 'copy') }, url ? 'Copy link' : 'Make link'),
      canText && h('button', { type: 'button', onclick: () => referralLink(lead, 'text') }, 'Text it to them')));
}

async function referralLink(lead, how) {
  try {
    const r = await api(`/api/leads/${lead.id}/referral-link`, { method: 'POST', body: { send: how === 'text' ? 'text' : null } });
    if (how === 'text') toast('Referral link texted');
    else await copyLink(r.url);
    renderLead(r.lead);
  } catch (err) { fail(err); }
}

// ---------- Referrals and partners (admins) ----------
async function loadReferrals() {
  const data = await api('/api/referrals');
  const link = (code) => `${data.base}/r/${code}`;
  $('#partnerTable').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Partner', 'Link', 'Leads this year', 'Booked', 'Revenue', 'To thank', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...(data.partners.length ? data.partners.map((p) => h('tr', { class: p.active ? '' : 'inactive' },
      h('td', {}, h('strong', {}, p.name), p.contact && h('div', { class: 'muted' }, p.contact)),
      h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => copyLink(link(p.code)) }, `/r/${p.code}`)),
      h('td', { class: 'num' }, p.leads_this_year),
      h('td', { class: 'num' }, p.booked),
      h('td', { class: 'num' }, money(p.revenue_cents)),
      h('td', { class: 'num' }, p.to_thank || ''),
      h('td', {}, h('button', { type: 'button', onclick: () => togglePartner(p) }, p.active ? 'Turn off' : 'Turn on'))))
      : [h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'No partners yet.'))])));
  $('#referrerTable').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Customer', 'Leads sent', 'Booked', 'Revenue', 'To thank', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...(data.customers.length ? data.customers.map((c) => h('tr', {},
      h('td', {}, c.name),
      h('td', { class: 'num' }, c.leads),
      h('td', { class: 'num' }, c.booked),
      h('td', { class: 'num' }, money(c.revenue_cents)),
      h('td', { class: 'num' }, c.to_thank || ''),
      h('td', {}, c.lead_id && h('button', { type: 'button', onclick: () => openLead(c.lead_id) }, 'Open'))))
      : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'Nobody has referred anyone yet. Text past customers their link from their lead.'))])));
  $('#referredTable').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Lead', 'From', 'Came in', 'Booked', 'Thanked', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...(data.referred.length ? data.referred.map((l) => h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: () => openLead(l.id) }, l.name)),
      h('td', {}, l.referrer),
      h('td', {}, shortDate(l.received_at)),
      h('td', {}, l.booked ? `Yes${l.revenue_cents ? ` · ${money(l.revenue_cents)}` : ''}` : 'Not yet'),
      h('td', {}, l.referral_rewarded_at ? `${shortDate(l.referral_rewarded_at)}${l.referral_rewarded_by ? ` · ${l.referral_rewarded_by}` : ''}` : ''),
      h('td', {}, l.booked && h('button', { type: 'button', onclick: () => markThanked(l, !l.referral_rewarded_at) }, l.referral_rewarded_at ? 'Undo' : 'Mark thanked'))))
      : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No referred leads yet.'))])));
}

async function addPartner(e) {
  e.preventDefault();
  const f = e.target;
  try {
    const p = await api('/api/partners', { method: 'POST', body: { name: f.name.value, contact: f.contact.value } });
    f.reset();
    toast(`${p.name} added. Copy their link from the table.`);
    await loadReferrals();
  } catch (err) { fail(err); }
}

async function togglePartner(p) {
  try {
    await api(`/api/partners/${p.id}`, { method: 'PATCH', body: { active: !p.active } });
    await loadReferrals();
  } catch (err) { fail(err); }
}

async function markThanked(l, rewarded) {
  try {
    await api(`/api/leads/${l.id}/referral-reward`, { method: 'POST', body: { rewarded } });
    await loadReferrals();
  } catch (err) { fail(err); }
}

function initGrowth() {
  if (!isAdmin()) return;
  $('#referralsBtn').addEventListener('click', async () => {
    try {
      await loadReferrals();
      showPanel($('#referralsPanel'));
    } catch (err) { fail(err); }
  });
  $('#partnerForm').addEventListener('submit', addPartner);
}
