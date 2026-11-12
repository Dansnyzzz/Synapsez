import { getStore } from './store/index.js';
import { openSecret, sha256 } from './crypto.js';
import { serviceKeyContext } from './secretContexts.js';
import { periodOf, freeTierOnly, num, e2bMonthCap, noDatabase } from './freeTierPeriod.js';
import { log } from './util/trace.js';

/**
 * Several keys per deployment service (spec A, owner 2026-11-12: "every service has a
 * fallback"; narrowed the same day to the services the owner has more keys for). The key in
 * the environment is key 1 (`id: 'env'`), never stored; the owner adds the rest in Settings
 * → Administration → Free allowances, as rows of `service_keys`, sealed to service and row.
 *
 *   - **Counted per key** (freeTier.js asks here): a key's bucket is
 *     `free:<service>@<keyId>:<period>`, the environment key's the name it had before
 *     (`free:<service>:<period>`), so a month's count carries over. A service's capacity
 *     is the sum of its keys' ceilings — a key added counts at once, one removed stops.
 *   - **A key's ceiling:** the owner's override, else 95% of what the provider says its
 *     plan is (Tavily, Firecrawl), else the default (the environment's figure, as before).
 *     The provider's own count of what is left is believed when it is lower, never higher.
 *   - **Choosing:** the healthy key with the largest share left, so keys are used evenly;
 *     a refusal sets that key aside by its class and the next key is tried (`withKey`).
 *   - **The paid key** (one per service, the owner's choice): used only when no free key
 *     has room, and then only for a charged call (`paid: true`) or with the ceilings off,
 *     and only under its monthly cap — so nothing is billed until a call is charged.
 *
 * Keys never leave the server: what this returns to a page, writes to a log or keeps as an
 * error carries a key's `hint` (its last four characters) and never the key.
 *
 * What one instance keeps in memory — the stored keys opened, the environment key's state
 * and the providers' last figures — belongs to the deployment, never to an account. The
 * setting `service_keys_version` moving (a key added or removed, set aside, chosen as the
 * paid key) makes every instance read the keys again within 30 s.
 */

/**
 * The services in the pool: where the environment's key is, what a ceiling is counted in,
 * the name said to the owner, and how many keys at most, the environment's among them
 * (owner, 2026-11-12). Exa, Tavily and Firecrawl take several. Brave and E2B keep their one
 * key — here so it has a state and may be the paid key; E2B also because a machine stays on
 * the account that made it and the template must be built in each account.
 */
export const POOLED = Object.freeze({
  exa: Object.freeze({ env: Object.freeze(['EXA_API_KEY']), unit: 'mills', label: 'Exa', maxKeys: 10 }),
  tavily: Object.freeze({ env: Object.freeze(['TAVILY_API_KEY']), unit: 'credits', label: 'Tavily', maxKeys: 10 }),
  firecrawl: Object.freeze({ env: Object.freeze(['FIRECRAWL_API_KEY']), unit: 'credits', label: 'Firecrawl', maxKeys: 10 }),
  brave: Object.freeze({ env: Object.freeze(['BRAVE_API_KEY']), unit: 'requests', label: 'Brave Search', maxKeys: 1 }),
  e2b: Object.freeze({ env: Object.freeze(['E2B_API_KEY']), unit: 'mills', label: 'E2B', maxKeys: 1 }),
});

/**
 * Two that cannot pool, each with the id of the page's sentence saying why: Stack
 * Exchange's quota is per server address, so a second key adds nothing; TheSportsDB's
 * free key is one public key.
 */
export const NOT_POOLED = Object.freeze({
  stackexchange: 'freetier.notPooled.stackexchange',
  thesportsdb: 'freetier.notPooled.thesportsdb',
});

/**
 * @typedef {'ok'|'invalid'|'exhausted'|'cooling'} KeyState
 * @typedef {{ id: string, fromEnv: boolean, key: string, hint: string, label: string|null, ceiling: number|null, state: KeyState, retryAt: number|null, live: any }} PoolKey
 * @typedef {{ of: string, per: string, limit: () => number, live?: boolean, own?: boolean, billed?: boolean, credit?: boolean }} Window
 */

/**
 * What each key of a pooled service is counted in (figures checked 2026-11-12, the spec's
 * table). A call must fit every window of its service but an `own` one, which is counted
 * per key and binds only the calls made against it (Firecrawl's free index, a thousand a
 * day per team). `live`: the provider says this window's figure per key; `billed`: a card on
 * file with no cap of the service's own (Brave), where a count that cannot be read is none
 * left; `credit`: E2B's one-off credit spread by month (`e2bMonthCap`), per key.
 *
 * @type {Readonly<Record<string, Window>>}
 */
const WINDOWS = Object.freeze({
  exa: { of: 'exa', per: 'month', limit: () => num('EXA_FREE_MILLS', 9_500) },
  tavily: { of: 'tavily', per: 'month', limit: () => num('TAVILY_FREE_CREDITS', 950), live: true },
  firecrawl: { of: 'firecrawl', per: 'month', limit: () => num('FIRECRAWL_FREE_CREDITS', 950), live: true },
  firecrawl_index: { of: 'firecrawl', per: 'day', limit: () => num('FIRECRAWL_INDEX_FREE_DAILY', 950), own: true },
  brave: { of: 'brave', per: 'month', limit: () => num('BRAVE_FREE_REQUESTS', 950), billed: true },
  e2b: { of: 'e2b', per: 'month', limit: () => e2bMonthCap(), credit: true },
});

/** A provider's limit is kept to this much of it, as every ceiling here is kept a little under the real one. */
const LIVE_SHARE = 0.95;
const KEEP_MS = 30_000;
const CHECK_MS = 8_000;
const COOL_MIN_MS = 30_000;
const COOL_MAX_MS = 10 * 60_000;
/** How long a provider's figure is kept before it is asked again: Tavily allows ten asks in ten minutes. */
const LIVE_MS = Object.freeze({ tavily: 5 * 60_000, firecrawl: 2 * 60_000 });
const VERSION = 'service_keys_version';
const PAID = 'service_paid_keys';
const ENV_STATE = 'service_env_state';
const KEY_STATES = Object.freeze(['ok', 'invalid', 'exhausted', 'cooling']);

/** The pooled service a service or window id belongs to, or null. */
const serviceOf = (id) => (POOLED[id] ? id : WINDOWS[id]?.of ?? null);
/** A service's windows that every one of its calls must fit. */
const bindingOf = (service) => Object.keys(WINDOWS).filter((id) => WINDOWS[id].of === service && !WINDOWS[id].own);
const hintOf = (key) => String(key || '').slice(-4);
const asState = (state) => (KEY_STATES.includes(state) ? state : 'ok');
/**
 * The key a service has in the environment, as set — '' when none. For a caller that must use
 * that key and no other (E2B's machines are made with it, e2b.js `connection`); the rest ask
 * `withKey`. Server-side only, like every key here.
 */
export const envKeyOf = (service) => {
  for (const name of POOLED[service]?.env || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

/** The last identity worked out per service, so a call does not hash the same key again. */
const envIds = new Map();
/**
 * Which key the environment holds, as its saved state and figure name it: a short hash of
 * service and key — never the key, and not its hint, which two keys may share. A key put in
 * the environment in place of another is a new key, and inherits nothing (review, 2026-11-12).
 */
const envIdOf = (service, key = envKeyOf(service)) => {
  if (!key) return '';
  const known = envIds.get(service);
  if (known?.key === key) return known.id;
  const id = sha256(`${service}:${key}`).slice(0, 16);
  envIds.set(service, { key, id });
  return id;
};

/** A window's own description, for freeTier.js: its period, its default ceiling, whether it is billed. Null for a service not counted per key. */
export const poolWindow = (id) => WINDOWS[id] ?? null;

/** The bucket E2B's whole credit is counted in, for one key: it outlives any month. */
export const creditBucket = (keyId) => (keyId === 'env' ? 'free:e2b:total' : `free:e2b@${keyId}:total`);

/* ── the keys, as this instance knows them ──────────────────────────── */

const EMPTY = Object.freeze({ version: null, checkedAt: 0, stored: new Map(), paid: {} });
/** @type {{ version: any, checkedAt: number, stored: Map<string, PoolKey[]>, paid: Record<string, { keyId: string, capMonthly: number|null }> } | null} */
let snapshot = null;
let loading = null;
let checking = null;
/** Moved by `bumpKeysVersion`, so a read begun before a change is not kept after it. */
let generation = 0;
/**
 * The environment key's state per service: it has no row (spec A). Mirrored in the setting
 * `service_env_state`; each entry names the key it is about (`envIdOf`), and holds for no other.
 */
const envStates = new Map();
/** The environment key's last figure from its provider, per service, with the identity of the key it was read for. */
const envLive = new Map();
/** When each key's provider was last asked, so a failing one is not asked on every call. */
const askedAt = new Map();

/** Only pooled services, each a key id and a cap that is a number of zero or more, or none. */
function cleanPaid(value) {
  const out = {};
  for (const [service, choice] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!POOLED[service] || !choice?.keyId) continue;
    const cap = choice.capMonthly == null ? null : Number(choice.capMonthly);
    out[service] = { keyId: String(choice.keyId), capMonthly: Number.isFinite(cap) && cap >= 0 ? cap : null };
  }
  return out;
}

async function load() {
  const store = getStore();
  const version = await store.getSetting(VERSION);
  const [rows, paid, envSaved] = await Promise.all([store.listServiceKeys(), store.getSetting(PAID), store.getSetting(ENV_STATE)]);
  const stored = new Map();
  for (const row of rows || []) {
    if (!POOLED[row.service]) continue;
    // A key that will not open (ENCRYPTION_KEY changed) stays listed, refused, so the owner sees it.
    const opened = openSecret(row.sealed, serviceKeyContext(row.service, row.id));
    const ceiling = row.ceiling == null ? null : Number(row.ceiling);
    // The same reading this instance already holds keeps what was counted here since (`noteUse`).
    const held = snapshot?.stored.get(row.service)?.find((key) => key.id === String(row.id))?.live;
    const live = held && row.live && held.at === row.live.at ? held : row.live ?? null;
    const list = stored.get(row.service) || [];
    list.push({
      id: String(row.id),
      fromEnv: false,
      key: opened.state === 'ok' ? opened.value : '',
      hint: String(row.hint || ''),
      label: row.label ?? null,
      ceiling: Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : null,
      state: opened.state === 'ok' ? asState(row.state) : 'invalid',
      retryAt: row.retry_at ? new Date(row.retry_at).getTime() : null,
      live,
    });
    stored.set(row.service, list);
  }
  for (const [service, saved] of Object.entries(envSaved && typeof envSaved === 'object' ? envSaved : {})) {
    const mine = envStates.get(service);
    if (POOLED[service] && saved && (!mine || Number(saved.at) > mine.at)) {
      envStates.set(service, { id: String(saved.id || ''), state: asState(saved.state), retryAt: Number(saved.retryAt) || null, error: String(saved.error || ''), at: Number(saved.at) || 0 });
    }
  }
  return { version: version ?? null, checkedAt: Date.now(), stored, paid: cleanPaid(paid) };
}

async function reload() {
  const mine = generation;
  const next = await load();
  if (mine === generation) snapshot = next;
  return next;
}

/** The snapshot: read again when asked to, when there is none, or when the version moved (asked at most every 30 s). */
async function current({ fresh = false } = {}) {
  try {
    if (fresh) return await reload();
    if (!snapshot) {
      if (!loading) loading = reload().finally(() => (loading = null));
      return await loading;
    }
    if (Date.now() - snapshot.checkedAt < KEEP_MS) return snapshot;
    if (!checking) {
      checking = (async () => {
        const version = await getStore().getSetting(VERSION);
        if (String(version ?? '') !== String(snapshot?.version ?? '')) await reload();
        else if (snapshot) snapshot.checkedAt = Date.now();
      })().finally(() => (checking = null));
    }
    await checking;
    return snapshot || EMPTY;
  } catch (err) {
    // No database at all is a script or a test: the environment's key alone, asked again next time.
    if (noDatabase(err)) return snapshot || EMPTY;
    log.warn('key pool: the stored keys could not be read', { error: String(err?.message || err).slice(0, 160) });
    snapshot = { ...(snapshot || EMPTY), checkedAt: Date.now() };
    return snapshot;
  }
}

/** A cooling or spent key whose time is up is healthy again. */
function effective(key, at = Date.now()) {
  if ((key.state === 'cooling' || key.state === 'exhausted') && key.retryAt != null && key.retryAt <= at) return { state: /** @type {KeyState} */ ('ok'), retryAt: null };
  return { state: key.state, retryAt: key.retryAt };
}

/** The environment key's figure, if it was read for the key the environment holds now. */
const envLiveOf = (service, id = envIdOf(service)) => {
  const saved = envLive.get(service);
  return saved && id && saved.id === id ? saved.live : null;
};

/** @returns {PoolKey[]} */
function compose(service, snap) {
  const out = [];
  const envKey = envKeyOf(service);
  if (envKey) {
    const id = envIdOf(service, envKey);
    const saved = envStates.get(service);
    // A state saved for the key the environment held before is not this key's.
    const mine = saved && saved.id === id ? saved : null;
    out.push({ id: 'env', fromEnv: true, key: envKey, hint: hintOf(envKey), label: null, ceiling: null, state: mine?.state || 'ok', retryAt: mine?.retryAt ?? null, live: envLiveOf(service, id) });
  }
  for (const key of snap.stored.get(service) || []) out.push({ ...key });
  const at = Date.now();
  return out.slice(0, POOLED[service].maxKeys).map((key) => ({ ...key, ...effective(key, at) }));
}

/** A service with no key at all is counted as it was before keys could be added: as the environment key's. */
const standIn = () => ({ id: 'env', fromEnv: true, key: '', hint: '', label: null, ceiling: null, state: /** @type {KeyState} */ ('ok'), retryAt: null, live: null });

/**
 * A service's keys: the environment's first (when set), then the stored ones in the order
 * they were added — at most the service's `maxKeys`. Each carries the key itself: for this
 * server's calls only, never for a response.
 *
 * @param {string} service
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<PoolKey[]>}
 */
export async function keysFor(service, { fresh = false } = {}) {
  const id = serviceOf(service);
  if (!id) return [];
  return compose(id, await current({ fresh }));
}

/** Whether a service has a key it may use — from the last snapshot; the environment's key counts without one. */
export function poolHas(service) {
  const id = serviceOf(service);
  if (!id) return false;
  return compose(id, snapshot || EMPTY).some((key) => key.state !== 'invalid');
}

/** The snapshot made current for every pooled service at once, so `poolHas` answers from it. */
export async function warmPools() {
  await current();
}

/** One key by id, for counting against it — a stand-in for an environment key not set, or a key removed since. */
export async function keyEntry(service, keyId) {
  const id = serviceOf(service);
  if (!id) return null;
  return (await keysFor(id)).find((key) => key.id === keyId) || { ...standIn(), id: String(keyId || 'env') };
}

/** Says the keys changed (Task 4's routes, after an add or a removal): this instance reads them now, every other within 30 s. */
export async function bumpKeysVersion() {
  await bump();
  generation += 1;
  snapshot = null;
}

/** A number that differs from every one before it, in practice: two changes in one millisecond still differ. */
const bump = () => getStore().setSetting(VERSION, Date.now() + Math.random());

/* ── counting ───────────────────────────────────────────────────────── */

/**
 * The bucket one key is counted in. The environment key keeps the name it had before
 * several keys (`free:<service>:<period>`), so a month's count carries over; a paid key's
 * spend is counted apart as well, by the month. Null for a service not counted per key.
 *
 * @param {string} service a window id: a pooled service, or Firecrawl's index
 * @param {string} keyId
 * @param {Date} [now]
 * @param {{ paid?: boolean }} [options]
 */
export function keyBucket(service, keyId, now = new Date(), { paid = false } = {}) {
  const window = WINDOWS[service];
  if (!window) return null;
  if (paid) {
    const { key, ends } = periodOf('month', now);
    return { bucket: `paid:${service}@${keyId}:${key}`, ends };
  }
  const { key, ends } = periodOf(window.per, now);
  return { bucket: keyId === 'env' ? `free:${service}:${key}` : `free:${service}@${keyId}:${key}`, ends };
}

/** The provider's figure for a key, where its window has one. */
const liveOf = (window, live) => (window.live && live && typeof live === 'object' ? live : null);

/** What the provider says is left, while its figure is for the period we are in; null otherwise. */
function liveLeft(window, key, now) {
  const figure = liveOf(window, key?.live);
  if (!figure || figure.used == null || figure.limit == null) return null;
  const used = Number(figure.used);
  const limit = Number(figure.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null;
  // A figure for a period that has ended says nothing about this one.
  const resets = figure.resets ? Date.parse(figure.resets) : NaN;
  const stale = Number.isFinite(resets) ? resets <= now.getTime() : periodOf(window.per, new Date(figure.at || 0)).key !== periodOf(window.per, now).key;
  return stale ? null : Math.max(0, limit - used);
}

/**
 * One key's ceiling in one window: the owner's override (the service's own window only),
 * else 95% of the provider's limit, else the default — for E2B, its credit's share of the month.
 *
 * @param {string} service a window id
 * @param {PoolKey} key
 * @param {Date} [now]
 */
export async function ceilingOf(service, key, now = new Date()) {
  const window = WINDOWS[service];
  if (!window) return 0;
  if (service === window.of && key?.ceiling != null && Number.isFinite(Number(key.ceiling)) && Number(key.ceiling) >= 0) return Number(key.ceiling);
  const live = liveOf(window, key?.live);
  if (live && Number(live.limit) > 0) return Math.floor(Number(live.limit) * LIVE_SHARE);
  if (window.credit) {
    const store = getStore();
    const id = key?.id || 'env';
    const used = await store.readCounter(keyBucket(service, id, now).bucket);
    const total = await store.readCounter(creditBucket(id));
    return e2bMonthCap({ usedBefore: Math.max(0, total - used), now });
  }
  return window.limit();
}

/**
 * One key in one window: what is counted, its ceiling, and what is left — none for a key
 * refused or spent, and lowered to the provider's own count when that is lower.
 *
 * @param {string} service a window id
 * @param {PoolKey} key
 * @param {Date} [now]
 */
export async function keyUsage(service, key, now = new Date()) {
  const window = WINDOWS[service];
  if (!window || !key) return { used: 0, ceiling: 0, left: 0 };
  const used = await getStore().readCounter(keyBucket(service, key.id, now).bucket);
  const ceiling = await ceilingOf(service, key, now);
  const { state } = effective(key);
  // Spent is its service's credit: a window of its own (Firecrawl's free index) is not spent with it.
  let left = state === 'invalid' || (state === 'exhausted' && !window.own) ? 0 : Math.max(0, ceiling - used);
  const theirs = liveLeft(window, key, now);
  if (theirs !== null) left = Math.min(left, theirs);
  return { used, ceiling, left };
}

/** What is left of one key's ceiling in one window (`keyUsage`). */
export async function leftOf(service, key, now = new Date()) {
  return (await keyUsage(service, key, now)).left;
}

/**
 * A window summed over its service's keys, for freeTier.js: what is used and left of the
 * sum of their ceilings. A refused key adds nothing; a service with no key at all is
 * counted as its environment key's, as before.
 *
 * @param {string} service a window id
 * @param {Date} [now]
 */
export async function capacityOf(service, now = new Date()) {
  const window = WINDOWS[service];
  if (!window) return null;
  const all = await keysFor(window.of);
  const counted = all.length ? all.filter((key) => key.state !== 'invalid') : [standIn()];
  let used = 0;
  let left = 0;
  let limit = 0;
  for (const key of counted) {
    const one = await keyUsage(service, key, now);
    used += one.used;
    left += one.left;
    limit += one.ceiling;
  }
  return { used, left, limit, keys: counted.length };
}

/**
 * A call counted here also comes off the provider's figure this instance holds, so a figure
 * read minutes ago keeps falling until it is read again (as firecrawl.js did with its own).
 * Memory only: the row keeps what the provider said.
 */
export function noteUse(service, keyId, amount) {
  const window = WINDOWS[service];
  if (!window?.live || !Number(amount)) return;
  const live = keyId === 'env' ? envLiveOf(window.of) : snapshot?.stored.get(window.of)?.find((key) => key.id === keyId)?.live;
  if (live && Number.isFinite(Number(live.used))) live.used = Math.max(0, Number(live.used) + Number(amount));
}

/** Count what the paid key spent this month, apart; the new total. */
export async function countPaid(service, keyId, amount, now = new Date()) {
  if (!WINDOWS[service] || !Number(amount)) return 0;
  const { bucket, ends } = keyBucket(service, keyId, now, { paid: true });
  return getStore().addToCounter(bucket, amount, ends);
}

/* ── choosing a key ─────────────────────────────────────────────────── */

/** The windows a call to `service` must fit, and the service whose keys answer it. */
function callOf(service) {
  if (POOLED[service]) return { service, windows: bindingOf(service) };
  const window = WINDOWS[service];
  return window ? { service: window.of, windows: [service] } : null;
}

/** One key's room for a call — the least over its windows — and its share left, the least too. */
async function roomOf(call, key, now) {
  try {
    let room = Infinity;
    let share = Infinity;
    for (const id of call.windows) {
      const { ceiling, left } = await keyUsage(id, key, now);
      room = Math.min(room, left);
      share = Math.min(share, ceiling > 0 ? left / ceiling : 0);
    }
    return { room, share };
  } catch (err) {
    // A count that cannot be read: none left where going over is a bill (Brave), as before (HAR-009).
    const billed = call.windows.some((id) => WINDOWS[id].billed);
    return billed && !noDatabase(err) ? { room: 0, share: 0 } : { room: Infinity, share: Infinity };
  }
}

/** The paid key, if it is healthy, not yet tried, and under its monthly cap for this call. */
async function paidChoice(service, keys, need, now) {
  const choice = (await current()).paid[service];
  const key = choice && keys.find((one) => one.id === choice.keyId);
  if (!key) return null;
  if (choice.capMonthly == null) return key;
  try {
    const spent = await getStore().readCounter(keyBucket(service, key.id, now, { paid: true }).bucket);
    return spent + need <= choice.capMonthly ? key : null;
  } catch {
    return null; // a cap that cannot be read is not passed
  }
}

async function choose(service, need, { paid = false, exclude = new Set() } = {}) {
  const call = callOf(service);
  if (!call) return null;
  const now = new Date();
  const want = Math.max(0, Number(need) || 0);
  const lifted = !freeTierOnly();
  // A key spent on its credits still serves a call counted only in windows of its own — Firecrawl's
  // free index, which costs no credits (review, 2026-11-12): `exhausted` is the credit window's state.
  const spentServes = call.windows.every((id) => WINDOWS[id].own);
  const usable = (state) => state === 'ok' || (spentServes && state === 'exhausted');
  const keys = (await keysFor(call.service)).filter((key) => usable(key.state) && key.key && !exclude.has(key.id));
  let best = null;
  let fullest = null;
  for (const key of keys) {
    const { room, share } = await roomOf(call, key, now);
    if (room > 0 && room >= want) {
      if (!best || share > best.share) best = { key, share };
    } else if (!fullest || share > fullest.share) fullest = { key, share };
  }
  if (best) return { key: best.key, paid: false };
  if (paid || lifted) {
    const key = await paidChoice(call.service, keys, want, now);
    if (key) return { key, paid: true };
  }
  // With the ceilings lifted the deployment pays, as it did before several keys.
  return lifted && fullest ? { key: fullest.key, paid: false } : null;
}

/**
 * The key for a call that needs `need` of the service: the healthy key with the largest
 * share left (ties to the earliest), passing over any without room; past every free key,
 * the paid key — for a charged call, or with the ceilings lifted. Null: the service stands
 * aside, as a spent allowance does.
 *
 * @param {string} service
 * @param {number} need
 * @param {{ paid?: boolean }} [options]
 * @returns {Promise<{ key: PoolKey, paid: boolean } | null>}
 */
export async function pickKey(service, need, { paid = false } = {}) {
  return choose(service, need, { paid });
}

const TRANSIENT_CODES = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_[A-Z_]+)$/;

/**
 * What a provider's refusal says about the key that made the call (spec A; the codes from
 * docs/research/2026-11-12-key-usage-apis.md): `invalid` — refused, not tried again until
 * the owner checks it; `exhausted` — spent until its period ends; `cooling` — asked to wait;
 * `transient` — a timeout or the service failing, which may be every key's; null — nothing
 * about the key (a bad query, a page not found, a call the person cancelled).
 *
 * @param {string} service
 * @param {{ status?: number, code?: any, body?: any, name?: string, cause?: any }} err
 * @returns {'invalid'|'exhausted'|'cooling'|'transient'|null}
 */
export function classify(service, err = {}) {
  const id = serviceOf(service);
  const status = Number(err?.status) || 0;
  const said = `${err?.code ?? ''} ${typeof err?.body === 'string' ? err.body : JSON.stringify(err?.body ?? '')}`;
  if (err?.name === 'AbortError') return null;
  if (id === 'exa' && /NO_MORE_CREDITS|_BUDGET_EXCEEDED/.test(said)) return 'exhausted';
  if (id === 'tavily' && (status === 432 || status === 433)) return 'exhausted';
  if (status === 402) return 'exhausted';
  // Firecrawl turns some sites away with a 403 ("This website is no longer supported"): about the
  // page, not the key, which it refuses with a 401 — else one such page would refuse every key in turn.
  if (id === 'firecrawl' && status === 403 && !/token|api.?key|unauthori[sz]ed/i.test(said)) return null;
  if (status === 401 || status === 403) return 'invalid';
  if (id === 'exa' && /INVALID_API_KEY/.test(said)) return 'invalid';
  if (id === 'brave' && /SUBSCRIPTION_TOKEN_INVALID/.test(said)) return 'invalid';
  if (status === 429) return 'cooling';
  if (status === 408 || status >= 500) return 'transient';
  if (err?.name === 'TimeoutError' || TRANSIENT_CODES.test(String(err?.code ?? '')) || TRANSIENT_CODES.test(String(err?.cause?.code ?? ''))) return 'transient';
  return null;
}

/** A refusal's own word on how long to wait: `retryAfterMs`, or a Retry-After header in seconds or as a date. */
function retryAfterOf(err) {
  if (Number(err?.retryAfterMs) > 0) return Number(err.retryAfterMs);
  const raw = typeof err?.headers?.get === 'function' ? err.headers.get('retry-after') : err?.headers?.['retry-after'] ?? err?.retryAfter;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const at = Date.parse(String(raw || ''));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/** Until when a spent key stands aside: the provider's own reset when it said one (Firecrawl's billing period), else (0) its period's end. */
function spentFor(key) {
  const now = Date.now();
  const resets = Date.parse(String(key?.live?.resets || ''));
  return Number.isFinite(resets) && resets > now ? resets - now : 0;
}

/** An error as it may be kept or logged: one line, short, the key taken out of it. */
function scrub(text, key, hint) {
  let out = String(text || '').replace(/\s+/g, ' ');
  if (key && key.length >= 4) out = out.split(key).join(`…${hint}`);
  return out.replace(/((?:api_)?key|token)=[^&\s]+/gi, '$1=…').slice(0, 160);
}

/**
 * Set a key aside — or back in use with `ok`. Cooling waits its Retry-After, 30 s at least
 * and 10 minutes at most; spent waits `retryAfterMs` when given, else its period's end;
 * refused waits for the owner. The environment key's state has no row: it is kept in this
 * instance and in the setting `service_env_state`.
 *
 * @param {string} service
 * @param {PoolKey|string} key the key, or its id
 * @param {KeyState} state
 * @param {{ retryAfterMs?: number, error?: string }} [options]
 */
export async function markKey(service, key, state, { retryAfterMs = 0, error = '' } = {}) {
  const id = serviceOf(service);
  const keyId = typeof key === 'string' ? key : String(key?.id || '');
  if (!id || !keyId || !KEY_STATES.includes(state)) return;
  const envKey = keyId === 'env' ? envKeyOf(id) : '';
  if (keyId === 'env' && !envKey) return; // no key in the environment: nothing to set aside
  const now = Date.now();
  const wait = Math.max(0, Number(retryAfterMs) || 0);
  const retryAt =
    state === 'cooling' ? now + Math.min(COOL_MAX_MS, Math.max(COOL_MIN_MS, wait))
    : state === 'exhausted' ? (wait > 0 ? now + wait : periodOf(WINDOWS[id].per, new Date(now)).ends.getTime())
    : null;
  const held = snapshot?.stored.get(id)?.find((one) => one.id === keyId);
  const known = typeof key === 'object' && key ? key : keyId === 'env' ? { key: envKey, hint: hintOf(envKey) } : held;
  const hint = known?.hint || '';
  const envId = keyId === 'env' ? envIdOf(id, envKey) : '';
  // What this instance thought, for the log when the database cannot be read.
  const mine = keyId === 'env' ? envStates.get(id) : held;
  const before = (keyId === 'env' && mine?.id !== envId ? null : mine?.state) || 'ok';
  const lastError = state === 'ok' ? '' : scrub(error, known?.key, hint);
  // This instance stops using it at once, whatever the database says next.
  if (keyId === 'env') envStates.set(id, { id: envId, state, retryAt, error: lastError, at: now });
  for (const one of snapshot?.stored.get(id) || []) if (one.id === keyId) Object.assign(one, { state, retryAt });
  const same = (was) => was.state === state && (was.retryAt ?? null) === retryAt;
  // Whether anything changes is the database's to say, not this instance's copy, which may be 30 s old:
  // the same state again writes nothing and moves no version, so a burst of refusals is one change.
  let was = null;
  try {
    const store = getStore();
    if (keyId === 'env') {
      const saved = await store.getSetting(ENV_STATE);
      const all = saved && typeof saved === 'object' ? saved : {};
      // A state saved for another key — the one the environment held before — is not this key's.
      const entry = all[id]?.id === envId ? all[id] : null;
      was = { state: asState(entry?.state), retryAt: Number(entry?.retryAt) || null };
      if (!same(was)) await store.setSetting(ENV_STATE, { ...all, [id]: { id: envId, state, retryAt, error: lastError, at: now } });
    } else {
      const row = (await store.listServiceKeys(id)).find((one) => String(one.id) === keyId);
      if (!row) return; // removed meanwhile
      was = { state: asState(row.state), retryAt: row.retry_at ? new Date(row.retry_at).getTime() : null };
      if (!same(was)) await store.setServiceKeyState(keyId, { state, retryAt: retryAt ? new Date(retryAt) : null, lastError: lastError || null });
    }
    if (same(was)) return;
    await bump();
  } catch (err) {
    if (!noDatabase(err)) log.warn('key pool: a key state was not saved', { service: id, hint, error: String(err?.message || err).slice(0, 160) });
  }
  if (state !== 'ok') log.warn('key pool: a key set aside', { service: id, hint, state, until: retryAt ? new Date(retryAt).toISOString() : '', error: lastError });
  else if ((was?.state ?? before) !== 'ok') log.info('key pool: a key is in use again', { service: id, hint });
}

/**
 * Run a call with a key, moving to the next on a refusal: `run(key, { id, paid })` makes the
 * call, and may throw an error carrying the provider's `status`, `code` and `body`. A
 * refused, spent or rate-limited key is set aside and the next is tried; a failing service
 * (a 5xx), the next key once, the first left as it was; a timeout, or a connection that did
 * not get through, goes straight back, no key blamed — it is the same for every key, and the
 * caller's own fallback (the search chain) is the retry (owner, 2026-11-12). An error with
 * `passOver` — this key cannot take this call, though it may a smaller one — tries the next
 * key and marks nothing. Anything else is the caller's to see. Counting stays with the caller
 * (`take`/`spend`, with `id` and `paid`). Every key out: an error with `skip`, the service
 * standing aside as a spent allowance does.
 *
 * **A charged call (`meta.paid`) must be held with `take(service, need, now, { keyId: meta.id,
 * paid: true })` inside `run`, before the request is made, and not made when that says no.**
 * Choosing the paid key here only reads its month's count; the atomic hold against its cap —
 * which also refuses when the count cannot be written — is `take`'s. `spend` afterwards counts
 * what was used past the hold, never instead of it.
 *
 * @template T
 * @param {string} service
 * @param {number} need
 * @param {(key: string, meta: { id: string, paid: boolean }) => Promise<T>} run
 * @param {{ paid?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function withKey(service, need, run, { paid = false } = {}) {
  const id = serviceOf(service);
  const exclude = new Set();
  let retried = false;
  let failing = null;
  for (;;) {
    const pick = await choose(service, need, { paid, exclude });
    if (!pick) {
      // A service failing for every key it was tried with says so, rather than standing aside.
      if (failing) throw failing;
      throw Object.assign(new Error(`${service}: no key with room`), { skip: true });
    }
    exclude.add(pick.key.id);
    try {
      return await run(pick.key.key, { id: pick.key.id, paid: pick.paid });
    } catch (err) {
      if (err?.passOver) continue;
      const kind = classify(id, err);
      if (kind === 'transient') {
        if (retried || !(Number(err?.status) >= 500)) throw err;
        retried = true;
        failing = err;
        continue;
      }
      if (!kind) throw err;
      failing = null;
      // A refusal this server said itself (`local`) carries no status of the provider's to report.
      const status = err?.local ? 0 : Number(err?.status) || 0;
      await markKey(id, pick.key, kind, {
        retryAfterMs: kind === 'cooling' ? retryAfterOf(err) : kind === 'exhausted' ? spentFor(pick.key) : 0,
        error: `${status ? `HTTP ${status}: ` : ''}${String(err?.message || err)}`,
      });
    }
  }
}

/* ── the paid key ───────────────────────────────────────────────────── */

/** @returns {Promise<{ keyId: string, capMonthly: number|null } | null>} */
export async function paidKeyOf(service) {
  const id = serviceOf(service);
  const choice = id ? (await current()).paid[id] : null;
  return choice ? { keyId: choice.keyId, capMonthly: choice.capMonthly } : null;
}

const refuse = (message) => Object.assign(new Error(message), { code: 'invalid' });

/**
 * The owner's choice of a service's paid key (any of its keys, the environment's too), and
 * the most it may spend in a month past its free ceiling, in the service's unit; `keyId`
 * null clears it. Stored in the setting `service_paid_keys`.
 *
 * @param {string} service
 * @param {string|null} keyId
 * @param {number|null} [capMonthly]
 */
export async function setPaidKey(service, keyId, capMonthly = null) {
  if (!POOLED[service]) throw refuse('That service does not take several keys.');
  const cap = capMonthly == null ? null : Number(capMonthly);
  if (cap !== null && !(Number.isFinite(cap) && cap >= 0)) throw refuse('A monthly cap is a number of zero or more.');
  if (keyId != null && !(await keysFor(service, { fresh: true })).some((key) => key.id === String(keyId))) throw refuse("That is not one of this service's keys.");
  const store = getStore();
  const saved = cleanPaid(await store.getSetting(PAID));
  if (keyId == null) delete saved[service];
  else saved[service] = { keyId: String(keyId), capMonthly: cap };
  await store.setSetting(PAID, saved);
  if (snapshot) snapshot.paid = saved;
  await bump();
}

/* ── what the providers say ─────────────────────────────────────────── */

/** Firecrawl names no plan; these two the spec does (Free 1,000 credits, Hobby 5,000). */
const FIRECRAWL_PLANS = Object.freeze({ 1000: 'Free', 5000: 'Hobby' });
const finite = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** One GET to a fixed address, its JSON, or an error carrying the status and body — never the address or the key. */
async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(CHECK_MS) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: said by the status */
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, body });
  return body;
}

/** Each provider with a figure per key (spec A, "Live figures"): what its plan is, what is used of it, when it starts again. */
const READERS = Object.freeze({
  async tavily(key) {
    const body = await getJson('https://api.tavily.com/usage', { Authorization: `Bearer ${key}` });
    // The key's own limit when it has one; else the account's plan.
    const own = finite(body?.key?.limit) !== null;
    return {
      plan: body?.account?.current_plan ? String(body.account.current_plan) : null,
      used: finite(own ? body.key.usage : body?.account?.plan_usage),
      limit: finite(own ? body.key.limit : body?.account?.plan_limit),
      // Tavily's credits start again on the first of each month, whatever the billing date.
      resets: periodOf('month').ends.toISOString(),
      at: new Date().toISOString(),
    };
  },
  async firecrawl(key) {
    const body = await getJson('https://api.firecrawl.dev/v2/team/credit-usage', { Authorization: `Bearer ${key}` });
    const left = finite(body?.data?.remainingCredits);
    const plan = finite(body?.data?.planCredits);
    if (left === null || plan === null) return null;
    return { plan: FIRECRAWL_PLANS[plan] ?? null, used: Math.max(0, plan - left), limit: plan, resets: body.data.billingPeriodEnd || null, at: new Date().toISOString() };
  },
});

/**
 * One key's plan and use, from its provider (Tavily, Firecrawl; the others null) — asked at
 * most every five minutes for Tavily and two for Firecrawl, unless `fresh`, and only from
 * the administrators' page and Firecrawl's own refresh, never on a person's call. Kept on
 * the key's row; the environment key's in this instance. On a failure, what was known.
 *
 * @param {string} service
 * @param {PoolKey} key
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<{ plan: string|null, used: number|null, limit: number|null, resets: string|null, at: string } | null>}
 */
export async function liveUsage(service, key, { fresh = false } = {}) {
  const id = serviceOf(service);
  const read = id ? READERS[id] : null;
  if (!read || !key?.key) return null;
  const slot = `${id}:${key.id}`;
  const known = key.live ?? null;
  if (!fresh && Date.now() - (askedAt.get(slot) || 0) < LIVE_MS[id]) return known;
  askedAt.set(slot, Date.now());
  let live;
  try {
    live = await read(key.key);
  } catch (err) {
    log.warn('key pool: a provider did not say its usage', { service: id, hint: key.hint, error: scrub(err?.message, key.key, key.hint) });
    return known;
  }
  if (!live) return known;
  if (key.id === 'env') {
    envLive.set(id, { id: envIdOf(id, key.key), live });
  } else {
    for (const one of snapshot?.stored.get(id) || []) if (one.id === key.id) one.live = live;
    await getStore().setServiceKeyLive(key.id, live).catch((err) => {
      if (!noDatabase(err)) log.warn('key pool: a usage figure was not saved', { service: id, hint: key.hint, error: String(err?.message || err).slice(0, 160) });
    });
  }
  return live;
}

/** A key as anyone types one: printable, no spaces or line breaks, of a sensible length. */
const PLAIN_KEY = /^[\x21-\x7e]{8,512}$/;

/** The one free call per service that says whether a key is good (spec A's table): fixed addresses only. Brave has none. */
const CHECKS = Object.freeze({
  exa: (key) => ['https://api.exa.ai/websets/v0/teams/me', { 'x-api-key': key }],
  tavily: (key) => ['https://api.tavily.com/usage', { Authorization: `Bearer ${key}` }],
  firecrawl: (key) => ['https://api.firecrawl.dev/v2/team/credit-usage', { Authorization: `Bearer ${key}` }],
  e2b: (key) => ['https://api.e2b.app/v2/sandboxes?limit=1', { 'X-API-Key': key }],
});

/**
 * Whether an E2B account has the template machines are made from: a key that works where
 * the template is missing starts nothing (spec A). Only "not found" counts against it — the
 * first machine made says the rest.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'template' }>}
 */
async function templateIn(key) {
  const { TEMPLATE_NAME } = await import('./e2b.js');
  const name = String(process.env.E2B_TEMPLATE || '').trim() || TEMPLATE_NAME;
  if (name === 'base') return { ok: true };
  try {
    const res = await fetch(`https://api.e2b.app/templates/aliases/${encodeURIComponent(name)}`, { headers: { 'X-API-Key': key }, signal: AbortSignal.timeout(CHECK_MS) });
    if (res.status === 404) return { ok: false, reason: 'template' };
  } catch {
    /* the key itself answered; the first machine started will say */
  }
  return { ok: true };
}

/**
 * Whether a key is good, by its service's free call (Brave has none: it is checked on first
 * use). `refused`: the service turned it away; `unreachable`: it could not be asked, or was
 * busy — try again; `template`: an E2B account without the Synapsez template.
 *
 * @param {string} service
 * @param {string} key
 * @returns {Promise<{ ok: true, plan?: string } | { ok: false, reason: 'refused'|'unreachable'|'template' }>}
 */
export async function checkKey(service, key) {
  const text = String(key ?? '').trim();
  if (!POOLED[service] || !PLAIN_KEY.test(text)) return { ok: false, reason: 'refused' };
  if (service === 'brave') return { ok: true };
  const [url, headers] = CHECKS[service](text);
  let res;
  let body = null;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(CHECK_MS) });
    body = await res.json().catch(() => null);
  } catch (err) {
    log.warn('key pool: a key could not be checked', { service, hint: hintOf(text), error: String(err?.name || 'fetch failed') });
    return { ok: false, reason: 'unreachable' };
  }
  const kind = res.ok ? null : classify(service, { status: res.status, body });
  if (kind === 'invalid') {
    log.info('key pool: a key was refused by its service', { service, hint: hintOf(text), status: res.status });
    return { ok: false, reason: 'refused' };
  }
  // Spent is still a good key: it counts again when its period turns.
  if (!res.ok && kind !== 'exhausted') return { ok: false, reason: 'unreachable' };
  if (service === 'e2b') return templateIn(text);
  const plan = service === 'tavily' ? body?.account?.current_plan : service === 'firecrawl' ? FIRECRAWL_PLANS[finite(body?.data?.planCredits)] : null;
  return plan ? { ok: true, plan: String(plan) } : { ok: true };
}

/* ── the administrators' view ───────────────────────────────────────── */

/**
 * Every service and its keys, by hint — the provider's figure where it says one, else what
 * is counted here — its state, and the paid key with what it spent this month. Read fresh.
 *
 * @param {Date} [now]
 */
export async function poolReport(now = new Date()) {
  const snap = await current({ fresh: true });
  const rows = [];
  for (const service of Object.keys(POOLED)) {
    const window = WINDOWS[service];
    const choice = snap.paid[service] || null;
    const keys = [];
    for (const key of compose(service, snap)) {
      const live = liveOf(window, key.live);
      const theirs = liveLeft(window, key, now) !== null;
      const counted = await keyUsage(service, key, now).catch(() => null);
      keys.push({
        id: key.id,
        fromEnv: key.fromEnv,
        hint: key.hint,
        label: key.label,
        plan: live?.plan ?? null,
        used: theirs ? Number(live.used) : counted?.used ?? null,
        limit: theirs ? Number(live.limit) : counted?.ceiling ?? null,
        resets: theirs ? live.resets ?? null : periodOf(window.per, now).ends.toISOString(),
        source: theirs ? 'provider' : 'counted',
        state: key.state,
        retryAt: key.retryAt ? new Date(key.retryAt).toISOString() : null,
        paid: choice?.keyId === key.id,
      });
    }
    const spent = choice ? await getStore().readCounter(keyBucket(service, choice.keyId, now, { paid: true }).bucket).catch(() => null) : null;
    rows.push({ service, pooled: true, keys, paid: choice ? { keyId: choice.keyId, capMonthly: choice.capMonthly, spent } : null });
  }
  for (const [service, note] of Object.entries(NOT_POOLED)) rows.push({ service, pooled: false, note, keys: [], paid: null });
  return rows;
}

/** Testing seam: make this instance's copy of the keys `ms` older, as if 30 s had passed. */
export const __testing = {
  age(ms) {
    if (snapshot) snapshot.checkedAt -= ms;
  },
};
