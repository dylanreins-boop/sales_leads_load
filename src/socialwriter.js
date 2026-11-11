// Writes a social post for the shop: the caption, hashtags, the words that show on the video (an opening
// line and the ending), and an idea for an AI intro clip. Uses Claude when ANTHROPIC_API_KEY is set;
// otherwise (or if Claude can't be reached) a plain template for the kind of post.

const POST_TYPES = {
  before_after: 'Before & after',
  showcase: 'Finished job',
  tip: 'Tip or how-to',
  offer: 'Special offer',
  review: 'Customer review',
  behind: 'Behind the scenes',
};

const SYSTEM = `You write social media posts for a ceramic coating and paint protection shop. The posts go on the
shop's Facebook, Instagram, TikTok and YouTube Shorts as a short vertical video or photos.

Write like a confident local shop owner, not an ad agency: short, specific, plain words, no hype words like
"elevate", "unleash" or "game-changer". At most two emoji. Never use customer names or anything that could
identify a customer (no plates, no addresses). Only claim what the notes and job details say; do not invent
prices, discounts, warranties, years of protection or reviews. If the notes give an offer, use its exact terms.

Return:
- caption: 2 to 5 short lines, ending with a clear call to action using the shop's phone number if given.
- hashtags: 5 to 8 relevant hashtags on one line, including the city if given.
- hook: the opening words on the video, 3 to 8 words, that make someone stop scrolling.
- end_text: the closing words on the video's last screen, 2 to 6 words (the phone number is added under it).
- clip_prompt: one or two sentences describing a short vertical b-roll clip an AI video tool could make for the
  opening: close-ups of glossy paint, water beading, a polisher, studio light sweeping over a hood. No people,
  no faces, no text, no logos, no license plates, and no specific customer's vehicle.`;

// The template used without Claude (or if it fails).
function basicPost({ type = 'showcase', notes = '', vehicles = [], services = '', brand = {} }) {
  const v = vehicles[0] || 'this one';
  const city = brand.city || '';
  const phone = brand.phone ? ` ${brand.phone}` : '';
  const tag = city ? `#${city.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
  const lines = {
    before_after: [`${v}: before and after.`, services ? `${services}.` : 'Ceramic coating.', `Book yours:${phone}`],
    showcase: [`Fresh out of the shop: ${v}.`, services ? `${services}.` : 'Coated and protected.', `Book yours:${phone}`],
    tip: [notes || 'Wash a coated car with a pH-neutral soap and two buckets, and skip the automatic car wash.', `Questions? Call us:${phone}`],
    offer: [notes || 'Ask about this month\'s special.', `Call or text to book:${phone}`],
    review: [notes ? `"${notes}"` : 'Thank you to everyone who trusts us with their vehicle.', `Book yours:${phone}`],
    behind: [notes || `A look inside the shop${city ? ` in ${city}` : ''}.`, `Book yours:${phone}`],
  }[type] || [notes || `${v}.`, `Book yours:${phone}`];
  return {
    caption: lines.join('\n').trim(),
    hashtags: ['#ceramiccoating', '#paintprotection', '#detailing', '#cardetailing', tag].filter(Boolean).join(' '),
    hook: { before_after: 'Watch this finish come back', showcase: 'Fresh out of the shop', tip: 'Do this after a coating', offer: 'This month only', review: 'What our customers say', behind: 'Inside the shop' }[type] || 'Fresh out of the shop',
    end_text: 'Book yours today',
    clip_prompt: 'Slow-motion close-up of water beading and rolling off glossy black car paint under soft studio light, vertical 9:16, no people, no text, no logos.',
  };
}

function createSocialWriter({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
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
      caption: z.string(), hashtags: z.string(), hook: z.string(), end_text: z.string(), clip_prompt: z.string(),
    }));
  }

  // { post, source: 'ai' | 'basic', error }
  async function write(input) {
    const fallback = basicPost(input);
    if (!configured) return { post: fallback, source: 'basic', error: null };
    const { type = 'showcase', notes = '', vehicles = [], services = '', brand = {} } = input;
    const about = [
      `Kind of post: ${POST_TYPES[type] || type}.`,
      brand.name && `Shop: ${brand.name}${brand.city ? ` in ${brand.city}` : ''}.`,
      brand.phone && `Phone: ${brand.phone}.`,
      vehicles.length && `Vehicles in the photos: ${vehicles.join('; ')}.`,
      services && `Work done: ${services}.`,
      notes && `Notes from the shop: ${notes}`,
    ].filter(Boolean).join('\n');
    try {
      setup();
      const response = await client.sdk.beta.messages.parse({
        model: 'claude-opus-5-5',
        max_tokens: 4000,
        output_config: { effort: 'low', format: schema },
        // If Claude declines (rare), Anthropic's server retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: about }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) {
        return { post: fallback, source: 'basic', error: response.stop_reason === 'refusal' ? 'Claude declined to write this post.' : 'Claude returned something the app could not read.' };
      }
      const out = response.parsed_output;
      const clip = (s, n) => String(s || '').trim().slice(0, n);
      return {
        post: {
          caption: clip(out.caption, 2000) || fallback.caption,
          hashtags: clip(out.hashtags, 300),
          hook: clip(out.hook, 60) || fallback.hook,
          end_text: clip(out.end_text, 40) || fallback.end_text,
          clip_prompt: clip(out.clip_prompt, 600) || fallback.clip_prompt,
        },
        source: 'ai',
        error: null,
      };
    } catch (err) {
      const { Anthropic } = client || {};
      let why = err.message;
      if (Anthropic && err instanceof Anthropic.AuthenticationError) why = 'The Anthropic API key was not accepted.';
      else if (Anthropic && err instanceof Anthropic.RateLimitError) why = 'Claude is busy right now; a basic version was used.';
      else if (Anthropic && err instanceof Anthropic.APIConnectionError) why = 'Could not reach Claude; a basic version was used.';
      else if (Anthropic && err instanceof Anthropic.APIError) why = `Claude returned an error (${err.status}); a basic version was used.`;
      return { post: fallback, source: 'basic', error: why };
    }
  }

  return { configured, write };
}

module.exports = { createSocialWriter, basicPost, POST_TYPES };
