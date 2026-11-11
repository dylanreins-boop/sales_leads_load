// AI-made video clips for the opening of a social post, from Google's Veo model through the Gemini API
// (GEMINI_API_KEY). Optional and paid per clip by Google. Making a clip takes a few minutes: start() hands
// back an operation, check() says when it's done, download() saves the clip.
//
// The clips are only ever an intro or background shot, never shown as a real job, and every post that
// uses one is labeled as AI-made (on the video, in the caption, and with each platform's AI flag).

const fs = require('node:fs');

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Always added to what the shop asks for, so a clip can't pass for a real customer's vehicle.
const RULES = 'Vertical 9:16 video. No people, no faces, no hands, no text, no captions, no logos, no license plates, no brand badges.';

function createVideoAi({ apiKey = process.env.GEMINI_API_KEY, model = process.env.AI_VIDEO_MODEL || 'veo-3.1-generate-preview', fetchImpl = (...a) => fetch(...a) } = {}) {
  const configured = Boolean(apiKey);
  const headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };

  async function call(url, options = {}) {
    const res = await fetchImpl(url, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const msg = body.error?.message || `${res.status} from Google`;
      throw new Error(res.status === 401 || res.status === 403 ? `Google didn't accept the Gemini API key (${msg}).` : msg);
    }
    return body;
  }

  // Starts a clip. Returns { op } (the operation's name, used to check on it).
  async function start(prompt) {
    if (!configured) throw new Error('AI video isn\'t set up (no GEMINI_API_KEY on the server).');
    const body = await call(`${BASE}/models/${encodeURIComponent(model)}:predictLongRunning`, {
      method: 'POST',
      body: JSON.stringify({ instances: [{ prompt: `${String(prompt).trim()} ${RULES}` }], parameters: { aspectRatio: '9:16' } }),
    });
    if (!body.name) throw new Error('Google didn\'t start the video.');
    return { op: body.name };
  }

  // { done, uri, error }
  async function check(op) {
    if (!/^[\w./-]+$/.test(op)) throw new Error('Unknown video job.');
    const body = await call(`${BASE}/${op}`);
    if (!body.done) return { done: false };
    if (body.error) return { done: true, error: body.error.message || 'Google couldn\'t make the video.' };
    const resp = body.response?.generateVideoResponse || {};
    const uri = resp.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      const filtered = resp.raiMediaFilteredReasons?.[0];
      return { done: true, error: filtered ? `Google wouldn't make it: ${filtered}` : 'Google finished without a video. Try a different description.' };
    }
    return { done: true, uri };
  }

  // Saves the clip. The key goes only to Google's API address, not to wherever the file is redirected.
  async function download(uri, out) {
    let res = await fetchImpl(uri, { headers: { 'x-goog-api-key': apiKey }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) res = await fetchImpl(res.headers.get('location'));
    if (!res.ok) throw new Error(`Couldn't download the video (${res.status}).`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  }

  return { configured, model, start, check, download };
}

module.exports = { createVideoAi, AI_VIDEO_RULES: RULES };
