// A check for sexual or nude picture requests, before any picture is asked of Google (1.33.1).
//
// Google's branding review (2026-11-18) asked the app to ensure "it does not use Google APIs
// for AI NCII" (AI-generated non-consensual intimate imagery). `generate_image` makes pictures
// through Google's Gemini API. Ephapse does not allow sexual, nude or intimate pictures of anyone,
// real or not, and this is the server's part of keeping to that: a request whose wording matches
// is refused before any picture is asked of Google.
//
// The list is words, not a classifier: it catches what a request says in English or Vietnamese,
// not what it might imply, and plain wording outside it passes (the review's "intimate photo of
// my ex"). So the public pages describe a check, not a guarantee. Three things stand behind it:
// the tool's description tells the model to refuse without calling the tool, `IMAGE_SAFETY_SETTINGS`
// asks Gemini for its strictest sexual-content filter on every request that does go, and Google's
// own block of one comes back as the same refusal (`googleSafetyBlock`). It is strict on purpose:
// "nude heels" or "population by age and sex" are refused too, and can be reworded.

// English, matched as whole words after accents are taken off, so "Essex", "Sussex" and
// "sextant" pass and "nüde" does not.
const ENGLISH = new Set([
  'nude', 'nudes', 'nudity', 'naked', 'nakedness', 'nudist', 'nudism', 'unclothed', 'nsfw', 'xxx',
  'sex', 'sexual', 'sexually', 'sexy', 'sexualized', 'sexualised', 'erotic', 'erotica', 'topless',
  'undress', 'undressed', 'undresses', 'undressing', 'lingerie', 'deepfake', 'deepfakes', 'hentai',
]);

// Every word that begins so: porn, porno, pornstar, pornography, pornographic, pornhub…
const ENGLISH_STEMS = ['porn'];

// "Explicit" alone is ordinary ("explicit labels"); before one of these it is not.
const EXPLICIT_WHAT = new Set(['content', 'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'scene', 'scenes', 'video', 'videos']);

// Phrases, each as it is written with its accents (both places for the tone mark where both are
// in use). A phrase counts when it is written exactly so, or with no accents at all, as a keyboard
// without Vietnamese input types it. Accents dropped from only part of it do not count, because
// that is how different words look alike: "khoa thận" (the kidney ward), "coi đó" (look at that),
// "loa thế này" (a speaker like this) and "ảnh nông thôn" (a countryside photo) are not requests
// for nudity. English phrases have no accents, so for them the rule is plain matching.
const PHRASES_WRITTEN = [
  'khoả thân', 'khỏa thân', 'lõa thể', 'loã thể', 'lõa lồ', 'loã lồ', 'trần truồng', 'khiêu dâm',
  'gợi dục', 'tình dục', 'cởi đồ', 'cởi quần áo', 'không mặc quần áo', 'không mặc gì', 'ảnh nóng',
  'wearing nothing', 'no clothes', 'without clothes', 'without clothing', 'no clothing', 'wearing no clothing', 'x rated',
];

// Phrases that count only written with their accents: typed without them they are everyday words
// too ("anh nong" is also "anh nông dân", a farmer). Final review, 1.33.1.
const ACCENTS_REQUIRED = new Set(['ảnh nóng']);

// What Gemini's Interactions API takes on `interactions.create` (`safety_settings`, each a `type`
// and a `threshold`): https://ai.google.dev/gemini-api/docs/safety-settings, read 2026-11-18, and
// the installed @google/genai 2.20.0 types (CreateModelInteraction.safety_settings).
// `block_low_and_above` is the strictest threshold the page lists. Not yet seen on a live key.
// There is deliberately no retry without it: a retry on a 400 would drop the filter exactly when
// it fires. If Google rejects the field, no picture is made, and the owner's guide says to stop.
export const IMAGE_SAFETY_SETTINGS = Object.freeze([
  Object.freeze({ type: 'sexually_explicit', threshold: 'block_low_and_above' }),
]);

// The codes Google's safety page gives for a blocked interaction: `safety` for a filter, the rest
// for an input blocked outright (its message then starts "Input blocked:").
const GOOGLE_BLOCK_CODES = new Set(['safety', 'prohibited_content', 'jailbreak', 'blocklist']);

// Accents off, đ as d, lower case: the form every list is compared in.
const bare = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

// Grouped by their accent-free form, so one pass over the words checks every phrase.
const PHRASES = PHRASES_WRITTEN.reduce((by, phrase) => {
  const key = bare(phrase);
  const entry = by.get(key) || { length: key.split(' ').length, written: new Set(), bareCounts: true };
  entry.written.add(phrase.normalize('NFC'));
  if (ACCENTS_REQUIRED.has(phrase)) entry.bareCounts = false;
  by.set(key, entry);
  return by;
}, new Map());
const LONGEST = Math.max(...[...PHRASES.values()].map((p) => p.length));

/**
 * Whether a picture request's wording asks for sexual or nude content.
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
    if (ENGLISH.has(plain[i]) || ENGLISH_STEMS.some((stem) => plain[i].startsWith(stem))) return true;
    if (plain[i] === 'explicit' && EXPLICIT_WHAT.has(plain[i + 1])) return true;
    for (let n = 1; n <= LONGEST && i + n <= words.length; n += 1) {
      const key = plain.slice(i, i + n).join(' ');
      const phrase = PHRASES.get(key);
      if (!phrase) continue;
      const written = words.slice(i, i + n).join(' ');
      if ((phrase.bareCounts && written === key) || phrase.written.has(written)) return true;
    }
  }
  return false;
}

/**
 * Whether Google itself blocked a picture request on safety grounds.
 *
 * Takes what `interactions.create` threw, or an entry of a finished interaction's `errors`. The
 * @google/genai 2.20.0 client throws a 400 with `status` 400, Google's `{ code, message }` (the
 * SDK's `ErrorT`) under `.error.error`, and a message of "400 " and Google's own; checked against
 * the real client with a stand-in network.
 *
 * @param {any} failure
 * @returns {boolean}
 */
export function googleSafetyBlock(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const status = Number(failure.status ?? failure.statusCode ?? 0);
  if (status && status !== 400) return false;
  const found = [failure.error?.error, failure.error, failure];
  const code = found.map((e) => e?.code).find((c) => typeof c === 'string') || '';
  const message = String(found.map((e) => e?.message).find((m) => typeof m === 'string') || '').replace(/^\d{3}\s+/, '');
  return GOOGLE_BLOCK_CODES.has(code.toLowerCase()) || message.startsWith('Input blocked:');
}
