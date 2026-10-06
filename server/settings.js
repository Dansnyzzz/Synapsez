import { getStore } from './store/index.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { CATALOG } from './providers/catalog.js';

const PREFS_KEY = 'prefs';
const KEYS_KEY = 'providerKeys';

export const DEFAULT_PREFS = {
  defaultModel: 'anthropic/claude-opus-5',
  effort: 'high',
  /**
   * How many tool steps one turn may take.
   *
   * Thirty was a guess made before anything used the research tools, and a
   * real question — "look into this project and tell me what you find" — burns
   * fifteen to twenty-five searches and fetches before it has anything to say.
   * Hitting the ceiling mid-answer was the single most common way a turn
   * ended. Sixty covers that work; the hard cap in `server/app.js` is 100 for
   * anyone who wants more.
   *
   * This is the default for a *new* account. An account that already has prefs
   * stored keeps the number it has — Settings → Behaviour is where it changes.
   */
  maxSteps: 60,
  // Ordinary work proceeds; only the irreversible stops for a yes. Asking about
  // everything trains people to click through without reading, which protects
  // nobody.
  toolPolicy: 'guarded',
  systemPrompt: '',
  // Fold the older turns into a summary before the window fills, rather than
  // letting a long conversation quietly stop working. Off is a real choice —
  // some work wants every word kept — but it means hitting the ceiling.
  autoCompact: true,
  /**
   * The user's own timezone, as an IANA name — "Asia/Ho_Chi_Minh".
   *
   * Recorded because a scheduled task has to mean *their* five o'clock. The
   * HTTP routes have always taken it from the browser per request, but
   * `schedule_task` and `workflow_write` are tools: they run inside an agent
   * turn with no request to read it from, so they fell back to the server
   * clock, which on a deployment is UTC. Seven hours out for anyone in Vietnam,
   * silently, for ever — the exact failure scheduler.js's own header describes.
   *
   * Null means nobody has told us, and the tools say so rather than guessing.
   */
  timezone: null,
  // Which paired computer the assistant acts on, when more than one is online.
  // Null means "whichever answered most recently", which is the right answer for
  // the overwhelmingly common case of owning one computer.
  activeDevice: null,
  // A document the assistant just made opens beside the conversation on its
  // own. On by default: the reason to ask for a report is to read it, and
  // hunting for the card afterwards is a step nobody wanted. It opens once per
  // turn and closing it means closed, so it never fights anyone — and this
  // switch is for the person who wants it off entirely.
  autoPreview: true,
  /**
   * Which language the interface is in.
   *
   * Per-account rather than per-browser, unlike the theme: the theme belongs to
   * the screen somebody is looking at, the language belongs to the person. Null
   * means "nobody has said", and the browser decides from `navigator.language` —
   * so a Vietnamese customer gets Vietnamese on their first visit without having
   * to find a setting to ask for it.
   */
  language: null,
  /**
   * Whether the getting-started guide has been through once.
   *
   * On the account, not in local storage, because the point of dismissing it is
   * not to see it again — including on the phone they sign in on next.
   */
  onboarded: false,
  /**
   * Memory and privacy — Settings → Memory.
   *
   * `memory`: the assistant reads its saved notes at the start of a turn and may
   * write new ones. Off means neither, and the notes stay where they are until
   * deleted. `memorySensitive`: health, beliefs, politics, ethnicity and
   * sexuality may be remembered — off by default, as Claude has it; identifiers
   * are refused whatever this says (see server/memory.js). `chatSearch`: the
   * assistant may look back through earlier conversations.
   */
  memory: true,
  memorySensitive: false,
  chatSearch: true,
  /**
   * Days after its last use that a conversation is deleted; 0 keeps everything.
   * Pinned conversations are always kept. See `deleteChatsOlderThan`.
   */
  retentionDays: 0,
  /**
   * `strict` asks OpenRouter to route only to providers that neither store nor
   * train on prompts (`provider: { data_collection: "deny", zdr: true }`). Off by default
   * because many free models are served only by providers that log, and strict
   * makes those unavailable — a choice the person has to make knowingly.
   */
  providerPrivacy: 'standard',
};

/** The languages the interface has strings for. See public/js/locales/. */
const LANGUAGES = new Set(['vi', 'en']);

/** The retention periods Settings offers, in days; 0 is "keep everything". */
export const RETENTION_DAYS = [0, 30, 90, 180, 365];
export const PROVIDER_PRIVACY = ['standard', 'strict'];

/**
 * Deployment-wide keys. These act as a shared fallback: handy for a private
 * deployment, but in a multi-user setup every account should bring its own, or
 * one person's key pays for everyone.
 */
const ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  orcarouter: 'ORCAROUTER_API_KEY',
};

/**
 * The preferences, with a default model the account can actually run.
 *
 * `DEFAULT_PREFS.defaultModel` names a Claude model, which is the right choice
 * when there is an Anthropic key and completely useless when there is not.
 * Somebody who signs up and pastes an OpenRouter key — the common case, since it
 * is the one key that reaches everything — used to get "No API key for
 * Anthropic" on their very first message, with no hint that the *model* was the
 * thing to change.
 *
 * So an unchosen default resolves to a provider that is configured. An explicit
 * choice is never second-guessed: picking a model and finding it swapped would
 * be far worse than an error message.
 */
export async function getPrefs(userId) {
  const stored = (await getStore().getUserSetting(userId, PREFS_KEY)) || {};
  const prefs = { ...DEFAULT_PREFS, ...stored };

  if (!stored.defaultModel) {
    prefs.defaultModel = await usableDefaultModel(userId, prefs.defaultModel);
  }
  return prefs;
}

/**
 * Where somebody who has not chosen a model should land.
 *
 * The newest free model on OpenRouter, when there is an OpenRouter key. That is
 * a deliberate reordering: this used to prefer the built-in flagships and only
 * fall back to a free model when *nothing else* was configured, so an account
 * with an Anthropic key started on Claude Opus and started spending immediately,
 * without ever being told there was a free option.
 *
 * Free first is the friendlier default for somebody arriving, and it costs
 * nothing to change. Be clear about the trade, because it is real: free models
 * are rate-limited and weaker at chaining tool calls than the paid flagships, so
 * the interface says so and offers the swap in one press rather than leaving
 * anyone to work out why a long job stalled. See `renderTopbar` and the
 * onboarding step that names it.
 *
 * The invariant that matters more than any of this: **an explicit choice is never
 * second-guessed.** Only `getPrefs` calls this, and only when nothing is stored.
 */
async function usableDefaultModel(userId, fallback) {
  const status = await providerStatus(userId).catch(() => ({}));

  if (status.openrouter?.configured) {
    const [free] = await getStore()
      .listSharedModels({ tier: 'free', sort: 'new', limit: 1 })
      .catch(() => []);
    if (free) return free.id;
    // An OpenRouter key but an empty library — the daily refresh has not landed
    // yet. Fall through rather than returning nothing.
  }

  const stated = CATALOG.find((m) => m.id === fallback);
  if (status[stated?.provider]?.configured) return fallback;

  const runnable = CATALOG.find((m) => status[m.provider]?.configured);
  if (runnable) return runnable.id;

  // No keys at all. The stated default is as good as anything, and the error it
  // produces names the provider to add a key for.
  return fallback;
}

/**
 * The account's provider-privacy choice, for the provider layer.
 *
 * Asked on every model call — each step of every turn, every research role —
 * so it reads the stored row directly rather than through `getPrefs`, which may
 * resolve a default model on the way, and remembers the answer for a minute.
 * `setPrefs` forgets it, so a change applies to the very next call on this
 * instance; another warm instance catches up within the minute.
 */
const PRIVACY_CACHE = new Map();
const PRIVACY_TTL_MS = 60_000;
export async function providerPrivacyFor(userId) {
  if (!userId) return 'standard';
  const hit = PRIVACY_CACHE.get(userId);
  if (hit && Date.now() - hit.at < PRIVACY_TTL_MS) return hit.value;
  let stored;
  try {
    stored = (await getStore().getUserSetting(userId, PREFS_KEY)) || {};
  } catch {
    // A blip, or no store at all: the answer is unknown, and an unknown answer
    // is the strict one (PRV-002). Guessing "standard" sent somebody who chose
    // strict to a provider that may keep and train on what they wrote, for as
    // long as the database stayed unreachable; guessing "strict" costs a
    // standard account at most one refusal it can read ("No provider serving
    // this model promises…") on a turn that a database outage was about to
    // fail anyway. Not remembered, so the next call asks again.
    return hit?.value || 'strict';
  }
  const value = stored.providerPrivacy === 'strict' ? 'strict' : 'standard';
  PRIVACY_CACHE.set(userId, { value, at: Date.now() });
  if (PRIVACY_CACHE.size > 500) PRIVACY_CACHE.delete(PRIVACY_CACHE.keys().next().value);
  return value;
}

export async function setPrefs(userId, patch) {
  PRIVACY_CACHE.delete(userId);
  const next = { ...(await getPrefs(userId)), ...patch };

  // Validated here rather than at the route, because this is the only way into
  // the stored object and an unknown language would leave the interface asking
  // for strings that do not exist.
  if ('language' in patch && patch.language != null && !LANGUAGES.has(patch.language)) {
    throw new Error(`"${patch.language}" is not a language this interface has. Use one of: ${[...LANGUAGES].join(', ')}.`);
  }
  if ('onboarded' in patch) next.onboarded = !!patch.onboarded;
  for (const flag of ['memory', 'memorySensitive', 'chatSearch']) if (flag in patch) next[flag] = !!patch[flag];
  if ('retentionDays' in patch) {
    const days = Number(patch.retentionDays);
    if (!RETENTION_DAYS.includes(days)) {
      throw new Error(`Keep conversations for one of: ${RETENTION_DAYS.join(', ')} days (0 keeps everything).`);
    }
    next.retentionDays = days;
  }
  if ('providerPrivacy' in patch && !PROVIDER_PRIVACY.includes(patch.providerPrivacy)) {
    throw new Error(`Provider privacy is one of: ${PROVIDER_PRIVACY.join(', ')}.`);
  }
  /**
   * A zone that Intl does not recognise is worse than none at all.
   *
   * With no zone the schedulers say so and fall back visibly; with a bad one
   * every `toLocaleString` that touches it throws a RangeError, from inside a
   * scheduled run nobody is watching. Checked here because this is the only way
   * into the stored object — the same reason `language` is checked here.
   *
   * Validated inline rather than by importing `validZone` from scheduler.js,
   * which imports this module.
   */
  if ('timezone' in patch && patch.timezone != null) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: String(patch.timezone) });
    } catch {
      throw new Error(`"${patch.timezone}" is not a timezone this system recognises.`);
    }
  }

  await getStore().setUserSetting(userId, PREFS_KEY, next);
  return next;
}

async function storedKeys(userId) {
  return (await getStore().getUserSetting(userId, KEYS_KEY)) || {};
}

/**
 * One provider's keys, as a list.
 *
 * Stored as a single encrypted string until keys could be stacked, so a stored
 * string is read as a list of one. Nothing migrates on write and nothing has to
 * be converted: an account that never adds a second key keeps working, and the
 * moment it does the shape becomes the list it always meant.
 */
function keyList(stored, provider) {
  const held = stored[provider];
  if (!held) return [];
  if (typeof held === 'string') return [{ cipher: held, hint: '', addedAt: null }];
  return Array.isArray(held) ? held.filter((entry) => entry?.cipher) : [];
}

/**
 * Where a fallback should start.
 *
 * A key that ran out at nine in the morning is still out at ten, and paying a
 * failed round trip to rediscover that on every single request is a tax on the
 * whole account. So the last key that worked is remembered — in memory only,
 * because it is a hint rather than a fact, and a restart rediscovering it costs
 * one request.
 */
const cursor = new Map();
const cursorKey = (userId, provider) => `${userId}:${provider}`;

export function rememberWorkingKey(userId, provider, index) {
  cursor.set(cursorKey(userId, provider), index);
}

/**
 * Which keys are resting, and until when.
 *
 * Separate from `cursor` because it answers a different question. The cursor is
 * an optimisation — where to *start* — and being wrong costs one request. This
 * is a fact worth acting on: a key that returned 429 with a reset an hour away
 * will return 429 again if asked, and on OpenRouter a failed request still
 * counts against the day's allowance. Probing it is not a free way to check;
 * it is paying budget to be told what is already known.
 *
 * `Infinity` means dead rather than resting: no reset time is right for "this
 * key is invalid", so it stays down until the process restarts or somebody
 * edits the keys.
 *
 * In memory, like `cursor`, and for the same reason — on a serverless instance
 * it is a hint that fails safe. The worst a cold start costs is one probe.
 */
const resting = new Map();

const restKey = (userId, provider, index) => `${userId}:${provider}:${index}`;

/** This key returned a rate limit; leave it alone until `untilMs`. */
export function markKeyLimited(userId, provider, index, untilMs) {
  const until = Number(untilMs);
  if (!Number.isFinite(until)) return;
  resting.set(restKey(userId, provider, index), until);
  sweepIfCrowded();
}

/** This key is invalid or spent. It does not come back on a timer. */
export function markKeyDead(userId, provider, index) {
  resting.set(restKey(userId, provider, index), Infinity);
  sweepIfCrowded();
}

/**
 * Give the two maps back when they get large.
 *
 * Both grow by one entry per (account, provider) and are never emptied. On a
 * serverless instance that is irrelevant — the process is gone in minutes — but
 * a self-hosted server runs for months, and on a shared one every account that
 * ever signed in leaves something behind permanently.
 *
 * Only elapsed cooldowns go. A dead key is `Infinity` and stays: it is a fact
 * about the key, not a timer, and forgetting it would put a known-bad key back
 * into the rotation to be probed again on the next turn. The cursor is dropped
 * alongside its provider's rest entries because it is only a hint about where to
 * start, and rediscovering it costs one request.
 *
 * Called from the two places that add entries rather than on a timer: a process
 * with nothing happening in it has nothing to sweep, and an interval would keep
 * a quiet server awake for no reason.
 */
const SWEEP_ABOVE = 500;
function sweepIfCrowded() {
  if (resting.size < SWEEP_ABOVE) return;
  const now = Date.now();
  for (const [slot, until] of resting) {
    if (until !== Infinity && until <= now) resting.delete(slot);
  }
  // Still crowded means the entries are genuinely live, and that is fine —
  // this is a leak guard, not a cap on how many accounts may hold keys.
}

/** Whether this key is currently resting. An elapsed cooldown has lifted. */
function isResting(userId, provider, index) {
  const slot = restKey(userId, provider, index);
  const until = resting.get(slot);
  if (until == null) return false;
  if (until === Infinity) return true;
  if (until > Date.now()) return true;
  resting.delete(slot);
  return false;
}

/**
 * When the first resting key frees up, or null if none is on a timer.
 *
 * Dead keys are deliberately not counted: they have no reset, and reporting
 * `Infinity` as "try again at" would be a lie with a timestamp on it.
 */
export function keyRestingUntil(userId, provider) {
  const prefix = `${userId}:${provider}:`;
  const now = Date.now();
  let soonest = null;
  for (const [slot, until] of resting) {
    if (!slot.startsWith(prefix) || until === Infinity || until <= now) continue;
    if (soonest == null || until < soonest) soonest = until;
  }
  return soonest;
}

/**
 * Lift the rests that were due by `throughMs`.
 *
 * Called after actually waiting one out. `isResting` also forgets an elapsed
 * cooldown on its own, but only when the clock says so — and a caller that has
 * genuinely waited should not then have to trust that two clocks agree to the
 * millisecond. Dead keys are untouched: no amount of waiting revives one.
 */
export function liftKeyRest(userId, provider, throughMs) {
  const prefix = `${userId}:${provider}:`;
  for (const [slot, until] of [...resting]) {
    if (slot.startsWith(prefix) && until !== Infinity && until <= throughMs) resting.delete(slot);
  }
}

/** Forget everything about this account's keys for a provider. */
export function clearKeyRest(userId, provider) {
  const prefix = `${userId}:${provider}:`;
  for (const slot of [...resting.keys()]) {
    if (slot.startsWith(prefix)) resting.delete(slot);
  }
}

/** Exposed for the suite that pins when a key is left alone. */
export const __testing = { isResting };

/**
 * Every key this account can try for a provider, in the order to try them.
 *
 * Their own first — nobody should silently spend somebody else's budget — and
 * the deployment-wide key last, as the final fallback. The list starts at
 * whichever key last worked, then wraps, so a dead first key costs one failed
 * request per process rather than one per turn.
 *
 * @returns `[{ key, index, shared }]`
 */
export async function getApiKeys(userId, provider, { includeResting = false } = {}) {
  const list = keyList(await storedKeys(userId), provider);

  const own = [];
  list.forEach((entry, index) => {
    const decrypted = decryptSecret(entry.cipher);
    if (!decrypted) return;
    // A key already known to be rate limited or dead is worse than useless: on
    // OpenRouter the failed request it would earn still counts against the
    // day's allowance. `includeResting` exists so a caller can tell "no keys at
    // all" apart from "none free just now" — they need very different sentences.
    if (!includeResting && isResting(userId, provider, index)) return;
    own.push({ key: decrypted, index, shared: false });
  });

  const start = cursor.get(cursorKey(userId, provider)) || 0;
  const from = own.findIndex((entry) => entry.index === start);
  const ordered = from > 0 ? [...own.slice(from), ...own.slice(0, from)] : own;

  const environment = process.env[ENV_KEYS[provider]];
  if (environment && (includeResting || !isResting(userId, provider, -1))) {
    ordered.push({ key: environment, index: -1, shared: true });
  }
  return ordered;
}

/** The first key, for callers that only ever wanted one. */
export async function getApiKey(userId, provider) {
  const [first] = await getApiKeys(userId, provider);
  return first?.key || '';
}

/**
 * True when this account is spending the deployment's key rather than its own.
 * Quotas only apply in that case.
 */
export async function usesSharedKey(userId, provider) {
  const own = keyList(await storedKeys(userId), provider).some((entry) => decryptSecret(entry.cipher));
  if (own) return false;
  return !!process.env[ENV_KEYS[provider]];
}

/** The last four characters, which is how everybody tells one key from another. */
const hintFor = (value) => `…${String(value).slice(-4)}`;

/** Replace whatever is stored with this single key, or clear it. */
export async function setApiKey(userId, provider, value) {
  if (!(provider in ENV_KEYS)) throw new Error(`Unknown provider "${provider}"`);
  const keys = await storedKeys(userId);
  if (value) keys[provider] = [{ cipher: encryptSecret(value), hint: hintFor(value), addedAt: new Date().toISOString() }];
  else delete keys[provider];
  await getStore().setUserSetting(userId, KEYS_KEY, keys);
  cursor.delete(cursorKey(userId, provider));
  // Whatever was wrong with the old keys is not necessarily wrong with these.
  clearKeyRest(userId, provider);
}

/** Add a spare, kept behind the ones already there. */
export async function addApiKey(userId, provider, value) {
  if (!(provider in ENV_KEYS)) throw new Error(`Unknown provider "${provider}"`);
  const clean = String(value || '').trim();
  if (!clean) throw new Error('That is an empty key.');

  const keys = await storedKeys(userId);
  const list = keyList(keys, provider);
  // The same key twice is not a fallback; it is the same outage twice.
  if (list.some((entry) => decryptSecret(entry.cipher) === clean)) {
    throw new Error('That key is already on this provider.');
  }
  if (list.length >= 8) throw new Error('Eight keys per provider is the limit.');

  list.push({ cipher: encryptSecret(clean), hint: hintFor(clean), addedAt: new Date().toISOString() });
  keys[provider] = list;
  await getStore().setUserSetting(userId, KEYS_KEY, keys);
  return list.length;
}

/** Drop one key by its position, leaving the rest in order. */
export async function removeApiKey(userId, provider, index) {
  if (!(provider in ENV_KEYS)) throw new Error(`Unknown provider "${provider}"`);
  const keys = await storedKeys(userId);
  const list = keyList(keys, provider);
  /**
   * `Number.isInteger` first, because every comparison against NaN is false.
   *
   * A non-numeric position walked straight through `index < 0 || index >= len`
   * and reached `splice(NaN, 1)`, which coerces the index to 0 — so a malformed
   * request deleted the account's first API key and reported success. Belt to
   * the route's braces: this is the layer that must not be talked into it,
   * whatever the caller passes.
   */
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    throw new Error('There is no key in that position.');
  }

  list.splice(index, 1);
  if (list.length) keys[provider] = list;
  else delete keys[provider];

  await getStore().setUserSetting(userId, KEYS_KEY, keys);
  cursor.delete(cursorKey(userId, provider));
  // Whatever was wrong with the old keys is not necessarily wrong with these.
  clearKeyRest(userId, provider);
  return list.length;
}

/**
 * What the browser may know: whether a provider works, never the key itself.
 *
 * `shared` is the field that matters and the one the interface used to ignore —
 * it read a `fromEnv` that this function has never returned, so somebody quietly
 * spending the deployment's key saw the same "configured" badge as somebody
 * paying their own bill, with no way to tell the difference.
 */
export async function providerStatus(userId) {
  const stored = await storedKeys(userId);
  const out = {};

  for (const [provider, envName] of Object.entries(ENV_KEYS)) {
    const list = keyList(stored, provider);
    const shared = !!process.env[envName];
    out[provider] = {
      configured: list.length > 0 || shared,
      own: list.length > 0,
      // True when this account is riding the deployment's shared key.
      shared: list.length === 0 && shared,
      envVar: envName,
      // Enough to tell one key from another and no more: the last four
      // characters and when it was added. The key itself never leaves here.
      keys: list.map((entry, index) => ({
        position: index + 1,
        hint: entry.hint || '',
        addedAt: entry.addedAt || null,
      })),
      // Whether there is anywhere to fall back to if the first one is refused.
      spare: Math.max(0, list.length - 1) + (list.length && shared ? 1 : 0),
    };
  }
  return out;
}

/**
 * Optional endpoint override, so an OpenAI-compatible server — Ollama, LM
 * Studio, vLLM — can be used exactly like a hosted one.
 */
export function baseUrlFor(provider) {
  if (provider === 'openai') return process.env.OPENAI_BASE_URL || undefined;
  if (provider === 'anthropic') return process.env.ANTHROPIC_BASE_URL || undefined;
  return undefined;
}
