// No sexual or nude picture is ever asked of Google (1.33.1).
//
// Google's branding review (2026-11-18) asked the app to ensure "it does not use Google APIs
// for AI NCII" (AI-generated non-consensual intimate imagery). `generate_image` makes pictures
// through Google's Gemini API, so a request for any sexual or nude picture, of anyone, real or
// not, is refused here, on the server, before anything is sent. That is the one rule the public
// pages state (public/about.html, public/usage-policy.html).
//
// The list is words, not a classifier: it catches what a request says in English or Vietnamese,
// not what it might imply. Two things stand behind it: the tool's description tells the model to
// refuse without calling the tool, and `IMAGE_SAFETY_SETTINGS` asks Gemini for its strictest
// sexual-content filter on every request that does go.

// English, matched as whole words after accents are taken off, so "Essex", "Sussex" and
// "sextant" pass and "nüde" does not.
const ENGLISH = new Set([
  'nude', 'nudes', 'nudity', 'naked', 'nsfw', 'porn', 'porno', 'pornography', 'pornographic',
  'sex', 'sexual', 'sexually', 'sexy', 'erotic', 'erotica', 'topless', 'undress', 'undressed',
  'undressing', 'lingerie', 'deepfake', 'deepfakes', 'hentai',
]);

// "Explicit" alone is ordinary ("explicit labels"); before one of these it is not.
const EXPLICIT_WHAT = new Set(['content', 'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'scene', 'scenes', 'video', 'videos']);

// Vietnamese, each as it is written with its accents (both places for the tone mark where both
// are in use). A phrase counts when it is written exactly so, or with no accents at all, as a
// keyboard without Vietnamese input types it. Accents dropped from only part of it do not
// count, because that is how different words look alike: "khoa thận" (the kidney ward),
// "coi đó" (look at that) and "loa thế này" (a speaker like this) are not requests for nudity.
const VIETNAMESE = [
  'khoả thân', 'khỏa thân', 'lõa thể', 'loã thể', 'lõa lồ', 'loã lồ', 'trần truồng', 'khiêu dâm',
  'gợi dục', 'tình dục', 'cởi đồ', 'cởi quần áo',
];

// What Gemini's Interactions API takes on `interactions.create` (`safety_settings`, each a `type`
// and a `threshold`): https://ai.google.dev/gemini-api/docs/safety-settings, read 2026-11-18, and
// the installed @google/genai 2.20.0 types (CreateModelInteraction.safety_settings).
// `block_low_and_above` is the strictest threshold the page lists. Not yet seen on a live key.
export const IMAGE_SAFETY_SETTINGS = Object.freeze([
  Object.freeze({ type: 'sexually_explicit', threshold: 'block_low_and_above' }),
]);

// Accents off, đ as d, lower case: the form both lists are compared in.
const bare = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

// Grouped by their accent-free form, so one pass over the words checks every phrase.
const PHRASES = VIETNAMESE.reduce((by, phrase) => {
  const key = bare(phrase);
  const entry = by.get(key) || { length: key.split(' ').length, written: new Set() };
  entry.written.add(phrase.normalize('NFC'));
  by.set(key, entry);
  return by;
}, new Map());
const LONGEST = Math.max(...[...PHRASES.values()].map((p) => p.length));

/**
 * Whether a picture request asks for sexual or nude content.
 *
 * @param {unknown} prompt
 * @returns {boolean}
 */
export function sexualImageRequest(prompt) {
  const text = String(prompt ?? '').normalize('NFC').toLowerCase();
  if (!text.trim()) return false;
  // "18+" as Vietnamese uses it for adult content; "2018+" or "118+" are not it.
  if (/(?<!\p{N})18\s?\+/u.test(text)) return true;

  const words = text.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  const plain = words.map(bare);
  for (let i = 0; i < words.length; i += 1) {
    if (ENGLISH.has(plain[i])) return true;
    if (plain[i] === 'explicit' && EXPLICIT_WHAT.has(plain[i + 1])) return true;
    for (let n = 1; n <= LONGEST && i + n <= words.length; n += 1) {
      const key = plain.slice(i, i + n).join(' ');
      const phrase = PHRASES.get(key);
      if (!phrase) continue;
      const written = words.slice(i, i + n).join(' ');
      if (written === key || phrase.written.has(written)) return true;
    }
  }
  return false;
}
