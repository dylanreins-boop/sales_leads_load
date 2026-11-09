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

Write only what the call supports. Never invent prices, dates or vehicles.`;

const transcriptText = (lines) => lines.map((l) => `${l.speaker === 'rep' ? 'REP' : 'CUSTOMER'}: ${l.text}`).join('\n');

// Basic notes without AI: the words used, the first things the customer said, and simple checks.
function basicSummary(lines) {
  const said = (who) => lines.filter((l) => l.speaker === who).map((l) => l.text).join(' ');
  const rep = said('rep');
  const customer = said('customer');
  const all = `${rep} ${customer}`.toLowerCase();
  if (!lines.length || customer.split(/\s+/).filter(Boolean).length < 4) {
    const voicemail = /voicemail|leave (a|your) message|after the (tone|beep)|not available/.test(all);
    return { summary: voicemail ? 'Reached voicemail.' : 'No real conversation was captured.', customer_wants: '', price_quoted: '', objections: [], next_step: '', outcome: voicemail ? 'voicemail' : 'no_conversation', flags: [], coaching_tip: '' };
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
  return {
    summary: `Talked with the customer. They said: "${firstWords.slice(0, 160)}${firstWords.length > 160 ? '…' : ''}"`,
    customer_wants: '',
    price_quoted: price.trim(),
    objections: [],
    next_step: nextStep ? `Mentioned: ${nextStep[0]}` : '',
    outcome: notInterested ? 'not_interested' : /book(ed)?|schedule|see you (on|monday|tuesday|wednesday|thursday|friday)/i.test(all) ? 'booked' : 'follow_up',
    flags,
    coaching_tip: '',
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
    }));
  }

  // Notes for one call: { notes, source: 'ai' | 'basic', error }.
  async function summarize({ lines, lead = {}, rep = '' }) {
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
        messages: [{ role: 'user', content: `${about}\n\nThe call:\n${transcriptText(lines)}` }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        return { notes: basicSummary(lines), source: 'basic', error: response.stop_reason === 'refusal' ? 'Claude declined to summarize this call.' : 'Claude returned notes the app could not read.' };
      }
      const notes = response.parsed_output;
      notes.flags = [...new Set(notes.flags)].filter((f) => FLAGS[f]);
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

module.exports = { createCallSummarizer, basicSummary, FLAGS, OUTCOMES, DISPOSITION_FOR };
