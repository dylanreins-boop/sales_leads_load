// Other answers from Bob Moses' quote form (bobmosescc.com): "How did you hear about us?"
// and the text-message opt-in checkbox. Field names are matched loosely, like vehicle details.

// The choices on their form, used for the "How they heard about us" dropdown.
const HEARD_ABOUT_OPTIONS = [
  'Searched on the internet',
  'Saw an ad on social media',
  'Word of mouth referral',
  'Radio',
  'Other',
];

const HEARD_WORDS = [
  ['Saw an ad on social media', ['facebook', 'instagram', 'tiktok', 'social', 'ad', 'ads']],
  ['Searched on the internet', ['google', 'internet', 'search', 'searched', 'online', 'yelp', 'web']],
  ['Word of mouth referral', ['friend', 'family', 'word', 'referral', 'referred', 'neighbor']],
  ['Radio', ['radio']],
];

const words = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function normalizeHeardAbout(text) {
  const value = String(text || '').trim();
  if (!value) return value;
  const exact = HEARD_ABOUT_OPTIONS.find((o) => o.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const w = words(value);
  const hit = HEARD_WORDS.find(([, ws]) => ws.some((k) => w.includes(k)));
  return hit ? hit[0] : value;
}

const isHeardField = (name) => {
  const w = words(name);
  return w.includes('hear') || w.includes('heard') || (w.includes('referral') && !w.includes('code'));
};

const isOptInField = (name) => {
  const w = words(name);
  return w.includes('consent') || w.includes('sms') || (w.includes('opt') && (w.includes('in') || w.includes('text')))
    || w.includes('optin');
};

// "Yes", "true", "on", or the consent sentence itself count as opting in.
function isYes(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || ['no', 'false', '0', 'off', 'n'].includes(v)) return false;
  return ['yes', 'true', '1', 'on', 'y', 'checked'].includes(v) || v.includes('consent') || v.includes('agree');
}

// Returns { heard_about?, sms_opt_in? } from a { fieldName: answer } object.
function extractAnswers(answers) {
  const out = {};
  for (const [name, value] of Object.entries(answers || {})) {
    if (out.heard_about === undefined && isHeardField(name) && String(value ?? '').trim()) {
      out.heard_about = normalizeHeardAbout(value);
    }
    if (out.sms_opt_in === undefined && isOptInField(name)) out.sms_opt_in = isYes(value);
  }
  return out;
}

module.exports = { HEARD_ABOUT_OPTIONS, normalizeHeardAbout, extractAnswers };
