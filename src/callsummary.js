// Call notes for the dialer. When a call ends, what was said (written out live; never recorded) is
// turned into short notes for the lead and for the admins who review calls: what the customer wants,
// any price given, objections, the next step, and anything the rep missed.
//
// With ANTHROPIC_API_KEY set, Claude writes the notes. Without it (or if Claude can't be reached), the
// app writes basic notes from the words used, so calls are never left without notes.

const OUTCOMES = ['booked', 'follow_up', 'callback_requested', 'not_interested', 'voicemail', 'no_conversation'];
const FLAGS = {
  no_price_given: 'No price given',
  no_next_step: 'No next step set',
  no_booking_link_offered: 'Booking link not offered',
  customer_upset: 'Customer upset',
  rep_talked_over: 'Rep talked over the customer',
  asked_not_to_call: 'Asked not to be called',
  wrong_number: 'Wrong number',
};
// How the call went, part by part (1-5 each), when there was a real conversation.
const RUBRIC = [
  { id: 'opening', label: 'Opening' },
  { id: 'discovery', label: 'Finding out what they need' },
  { id: 'value', label: 'Explaining the value' },
  { id: 'objections', label: 'Handling concerns' },
  { id: 'close', label: 'Asking for the booking' },
];
// The kind of each concern, so they can be counted ("price came up on 6 calls this month").
const OBJECTION_TYPES = {
  price: 'Price', timing: 'Timing / not ready yet', partner: 'Has to check with someone', shopping: 'Shopping around',
  need: 'Not sure it\'s needed', other: 'Other',
};
// What the rep should do next; the app offers it as one tap (nothing happens on its own).
const ACTIONS = {
  send_quote: 'Send a quote', send_booking_link: 'Send a booking link', schedule_callback: 'Schedule the call back',
  send_info: 'Text them more info', call_again: 'Try them again later', none: 'Nothing needed',
};

// The call outcome, as the disposition the rep logs.
const DISPOSITION_FOR = {
  booked: 'booked',
  follow_up: 'contacted_follow_up',
  callback_requested: 'callback_requested',
  not_interested: 'not_interested',
  voicemail: 'no_answer_vm',
  no_conversation: 'no_answer',
};

const SYSTEM = `You write call notes for a ceramic coating shop's sales team (Bob Moses Ceramic Coating, Las Vegas: cars, trucks, RVs, boats). A sales rep called a customer who asked for a quote. You get the call written out line by line, labeled REP and CUSTOMER. The text comes from live speech-to-text, so expect misheard words; go by the meaning.

Write notes a busy rep and the shop owner can read in ten seconds:
- summary: two or three plain sentences on what happened.
- customer_wants: the vehicle and the work they want, in their terms ("2022 Tesla Model Y, full ceramic coat").
- price_quoted: the price or range the rep gave, exactly as said ("$1,300", "$1,200 to $1,500"); empty if none.
- objections: the customer's concerns or reasons to wait, short phrases.
- next_step: what was agreed to happen next and when; empty if nothing was agreed.
- outcome: booked (a date was set), follow_up (talked, no booking yet), callback_requested (asked to be called at another time), not_interested, voicemail (reached voicemail), no_conversation (nobody really talked).
- flags: only the ones that clearly apply. no_price_given: they talked about the job and the rep never gave a price or range. no_next_step: the call ended without a next step. no_booking_link_offered: the customer seemed ready and the rep didn't offer to book or send the booking link. customer_upset, rep_talked_over, asked_not_to_call, wrong_number as named.
- coaching_tip: one specific, kind suggestion for the rep from this call; empty if the call went well.
- scored: true only if the rep and customer actually talked about the job; false for voicemail, no answer, wrong number or a few words.
- scores (1 to 5 each, 3 is fine, 5 is excellent; when scored is false use 3 for all): opening (friendly, says who they are and why they're calling), discovery (asks about the vehicle, how it's used, what the customer wants), value (explains what the coating does for them, not just the price), objections (answers concerns with substance instead of dropping them or arguing; 3 if there were none), close (asks for the booking or a clear next step).
- not_a_missed_chance: true when the customer was clearly never going to buy now (sold the vehicle, wrong person, just wanted a ballpark for later, firm no) so a low score is not the rep's fault.
- objection_types: the kinds of concerns raised: price, timing (not ready yet), partner (has to check with a spouse or someone), shopping (getting other quotes), need (not sure it's needed), other.
- suggested_action: the single most useful next step for the rep: send_quote (they want pricing in writing), send_booking_link (they're ready to pick a day), schedule_callback (they asked to talk at another time), send_info (they want more details or photos), call_again (no real conversation), none (booked, or a firm no).
- suggested_reason: a few words on why, from the call.
- callback_at: if a call-back time was agreed, the local date and time as YYYY-MM-DD HH:MM (24-hour) using today's date given below; otherwise empty.

Write only what the call supports. Never invent prices, dates or vehicles. Score the rep's part, not the customer's mood.`;

const transcriptText = (lines) => lines.map((l) => `${l.speaker === 'rep' ? 'REP' : 'CUSTOMER'}: ${l.text}`).join('\n');

// Basic notes without AI: the words used, the first things the customer said, and simple checks.
// Simple word checks for the kinds of concern, when there are no AI notes.
function objectionTypesIn(text) {
  const t = text.toLowerCase();
  const out = [];
  if (/expensive|too much|more than (i|we) (wanted|thought|expected)|price|cost|cheaper|budget|afford/.test(t)) out.push('price');
  if (/next month|not ready|later|after the holidays|not right now|few weeks|busy right now/.test(t)) out.push('timing');
  if (/wife|husband|spouse|partner|talk (it over|to my)|check with/.test(t)) out.push('partner');
  if (/other (quotes|shops|places)|shop(ping)? around|compare|another quote/.test(t)) out.push('shopping');
  if (/not sure (i|we) need|worth it|do i really need/.test(t)) out.push('need');
  return out;
}
const neutralScores = () => Object.fromEntries(RUBRIC.map((r) => [r.id, 3]));
// The next step from the outcome, when there are no AI notes.
function basicAction(outcome, price) {
  if (outcome === 'callback_requested') return 'schedule_callback';
  if (outcome === 'follow_up') return price ? 'send_booking_link' : 'send_quote';
  if (outcome === 'voicemail' || outcome === 'no_conversation') return 'call_again';
  return 'none';
}

function basicSummary(lines) {
  const said = (who) => lines.filter((l) => l.speaker === who).map((l) => l.text).join(' ');
  const rep = said('rep');
  const customer = said('customer');
  const all = `${rep} ${customer}`.toLowerCase();
  if (!lines.length || customer.split(/\s+/).filter(Boolean).length < 4) {
    const voicemail = /voicemail|leave (a|your) message|after the (tone|beep)|not available/.test(all);
    return { summary: voicemail ? 'Reached voicemail.' : 'No real conversation was captured.', customer_wants: '', price_quoted: '', objections: [], next_step: '', outcome: voicemail ? 'voicemail' : 'no_conversation', flags: [], coaching_tip: '',
      scored: false, scores: neutralScores(), not_a_missed_chance: false, objection_types: [], suggested_action: 'call_again', suggested_reason: voicemail ? 'Reached voicemail' : 'Nobody really talked', callback_at: '' };
  }
  const price = (rep.match(/\$\s?\d[\d,]*(?:\.\d\d)?(?:\s*(?:to|-)\s*\$?\s?\d[\d,]*)?|\b\d{3,5}\s*(?:dollars|bucks)\b/i) || [''])[0];
  const nextStep = /(call (you|me) back|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|send (you )?(the|a) (link|quote)|book(ed)?|schedule|drop (it )?off)/i.exec(all);
  const notInterested = /not interested|no thanks|don't call|do not call|stop calling|too expensive|went with (someone|another)/i.test(customer);
  const flags = [];
  if (!price) flags.push('no_price_given');
  if (!nextStep) flags.push('no_next_step');
  if (/don't call|do not call|stop calling/i.test(customer)) flags.push('asked_not_to_call');
  if (/wrong number/i.test(all)) flags.push('wrong_number');
  const firstWords = lines.filter((l) => l.speaker === 'customer').slice(0, 2).map((l) => l.text).join(' ');
  const outcome = notInterested ? 'not_interested' : /book(ed)?|schedule|see you (on|monday|tuesday|wednesday|thursday|friday)/i.test(all) ? 'booked' : 'follow_up';
  return {
    summary: `Talked with the customer. They said: "${firstWords.slice(0, 160)}${firstWords.length > 160 ? '…' : ''}"`,
    customer_wants: '',
    price_quoted: price.trim(),
    objections: [],
    next_step: nextStep ? `Mentioned: ${nextStep[0]}` : '',
    outcome,
    flags,
    coaching_tip: '',
    // Basic notes don't grade the call; the parts show only with AI notes.
    scored: false, scores: neutralScores(), not_a_missed_chance: false,
    objection_types: objectionTypesIn(customer), suggested_action: basicAction(outcome, price), suggested_reason: '', callback_at: '',
  };
}

function createCallSummarizer({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const configured = Boolean(apiKey);
  let client = null;
  let schema = null;

  // Loaded only when there's a key, so the app runs without the SDK installed.
  function setup() {
    if (client) return;
    const Anthropic = require('@anthropic-ai/sdk');
    const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
    const { z } = require('zod');
    client = { sdk: new Anthropic({ apiKey }), Anthropic };
    schema = betaZodOutputFormat(z.object({
      summary: z.string(),
      customer_wants: z.string(),
      price_quoted: z.string(),
      objections: z.array(z.string()),
      next_step: z.string(),
      outcome: z.enum(OUTCOMES),
      flags: z.array(z.enum(Object.keys(FLAGS))),
      coaching_tip: z.string(),
      scored: z.boolean(),
      scores: z.object(Object.fromEntries(RUBRIC.map((r) => [r.id, z.number().int()]))),
      not_a_missed_chance: z.boolean(),
      objection_types: z.array(z.enum(Object.keys(OBJECTION_TYPES))),
      suggested_action: z.enum(Object.keys(ACTIONS)),
      suggested_reason: z.string(),
      callback_at: z.string(),
    }));
  }

  // Notes for one call: { notes, source: 'ai' | 'basic', error }.
  async function summarize({ lines, lead = {}, rep = '', now = new Date() }) {
    if (!configured || lines.length === 0) return { notes: basicSummary(lines), source: 'basic', error: null };
    try {
      setup();
      const about = [lead.vehicle && `Vehicle on file: ${lead.vehicle}.`, lead.services && `Services on file: ${lead.services}.`, rep && `The rep is ${rep}.`].filter(Boolean).join(' ');
      const response = await client.sdk.beta.messages.parse({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        output_config: { effort: 'medium', format: schema },
        // If Claude declines (rare), Anthropic's server retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: `${about}\nToday is ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.\n\nThe call:\n${transcriptText(lines)}` }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        return { notes: basicSummary(lines), source: 'basic', error: response.stop_reason === 'refusal' ? 'Claude declined to summarize this call.' : 'Claude returned notes the app could not read.' };
      }
      const notes = response.parsed_output;
      notes.flags = [...new Set(notes.flags)].filter((f) => FLAGS[f]);
      notes.objection_types = [...new Set(notes.objection_types)].filter((t) => OBJECTION_TYPES[t]);
      for (const r of RUBRIC) notes.scores[r.id] = Math.min(5, Math.max(1, Math.round(Number(notes.scores[r.id]) || 3)));
      if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(notes.callback_at || '')) notes.callback_at = '';
      return { notes, source: 'ai', error: null };
    } catch (err) {
      const { Anthropic } = client || {};
      let why = err.message;
      if (Anthropic && err instanceof Anthropic.AuthenticationError) why = 'The Anthropic API key was not accepted.';
      else if (Anthropic && err instanceof Anthropic.RateLimitError) why = 'Claude is busy (rate limited); basic notes were used.';
      else if (Anthropic && err instanceof Anthropic.APIConnectionError) why = 'Could not reach Claude; basic notes were used.';
      else if (Anthropic && err instanceof Anthropic.APIError) why = `Claude returned an error (${err.status}); basic notes were used.`;
      return { notes: basicSummary(lines), source: 'basic', error: why };
    }
  }

  return { configured, summarize };
}

// The call's score out of 100 (the parts averaged), when it was scored.
const callScore = (notes) => (notes?.scored && notes.scores ? Math.round((RUBRIC.reduce((n, r) => n + (notes.scores[r.id] || 3), 0) / RUBRIC.length) * 20) : null);

module.exports = { createCallSummarizer, basicSummary, callScore, FLAGS, OUTCOMES, DISPOSITION_FOR, RUBRIC, OBJECTION_TYPES, ACTIONS };
