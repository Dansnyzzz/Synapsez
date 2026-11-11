import { getStore } from '../store/index.js';
import { ICT, NEW_YORK, wallClock, nextWeekdayAt } from './clock.js';

/**
 * One cache for the finance layer: Postgres `finance_cache` (schema 45), shared by
 * every account and every instance, with a small per-instance LRU in front.
 *
 * Shared across accounts on purpose, and safely: a value is a public price or
 * figure keyed by `source|kind|symbol|params`, never anything about the person who
 * asked. That is what makes "a price asked twice is fetched once" true across a
 * whole deployment — which is most of how the polite ceilings are kept.
 *
 * A database that fails is never a failed answer: the source is asked instead.
 */

const MAX_ENTRIES = 300;
/** Per instance: the newest entries, oldest first (a Map keeps insertion order). */
const memory = new Map();
/** Per instance: one load in flight per key, so two asks at the same moment make one call. */
const inflight = new Map();

/** Tests: forget the per-instance memory (the database keeps its rows). */
export function __resetCache() {
  memory.clear();
  inflight.clear();
}

function remember(key, entry) {
  memory.delete(key);
  memory.set(key, entry);
  if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

function storeOrNull() {
  try {
    return getStore();
  } catch {
    return null;
  }
}

/** An entry from the database, or null — expired or not. */
async function fromStore(store, key) {
  if (!store) return null;
  try {
    const row = await store.financeGet(key);
    return row ? { value: row.value, fetchedAt: Date.parse(row.fetched_at), expiresAt: row.expires_at ? Date.parse(row.expires_at) : null } : null;
  } catch {
    return null;
  }
}

/**
 * The cached value for `key`, or `load()`'s, kept for `ttlMs` (Infinity: kept for
 * good, stored with no expiry; 0 or less: not kept). `valid(value, fetchedAt)` may
 * reject an entry that has not expired but is no longer right — an adjusted price
 * series after an ex-date.
 *
 * @template T
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<T>} load
 * @param {{ valid?: (value: T, fetchedAt: number) => boolean, now?: number }} [options]
 * @returns {Promise<T>}
 */
export async function cached(key, ttlMs, load, { valid, now = Date.now() } = {}) {
  const fresh = (entry) => !!entry && (entry.expiresAt === null || entry.expiresAt > now) && (!valid || valid(entry.value, entry.fetchedAt));
  const mine = memory.get(key);
  if (fresh(mine)) {
    remember(key, mine);
    return mine.value;
  }
  if (inflight.has(key)) return inflight.get(key);
  const work = (async () => {
    const store = storeOrNull();
    const kept = await fromStore(store, key);
    if (fresh(kept)) {
      remember(key, kept);
      return kept.value;
    }
    const value = await load();
    if (ttlMs > 0 && value !== undefined && value !== null) {
      const expiresAt = Number.isFinite(ttlMs) ? now + ttlMs : null;
      remember(key, { value, fetchedAt: now, expiresAt });
      if (store) await store.financePut(key, value, expiresAt === null ? null : new Date(expiresAt)).catch(() => {});
    }
    return value;
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

/** Forget a kept answer everywhere — a session token the source has stopped accepting. */
export async function forget(key) {
  memory.delete(key);
  const store = storeOrNull();
  if (store) await store.financePut(key, {}, new Date(0)).catch(() => {});
}

/** What is kept for `key`, fresh or not, without asking the source: `{ value, fetchedAt }` or null. */
export async function peek(key) {
  const mine = memory.get(key);
  if (mine) return { value: mine.value, fetchedAt: mine.fetchedAt };
  const kept = await fromStore(storeOrNull(), key);
  return kept ? { value: kept.value, fetchedAt: kept.fetchedAt } : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** In a US regular session: Monday to Friday, 09:30–16:00 New York. */
function usInSession(at) {
  const w = wallClock(at, NEW_YORK);
  if (w.weekday === 0 || w.weekday === 6) return false;
  const minutes = w.h * 60 + w.mi;
  return minutes >= 570 && minutes < 960;
}

/** Until a market's next session opens: 09:00 ICT, 09:30 New York, or six hours elsewhere. */
function untilOpen(market, at) {
  if (market === 'vn') return nextWeekdayAt(at, ICT, 9, 0) - at.getTime();
  if (market === 'us') return nextWeekdayAt(at, NEW_YORK, 9, 30) - at.getTime();
  return 6 * HOUR;
}

function quoteTtl(market, at, session) {
  if (market === 'vn') {
    if (session === 'break') return nextWeekdayAt(at, ICT, 13, 0) - at.getTime();
    if (session === 'pre' || session === 'closed') return untilOpen('vn', at);
    return 45_000;
  }
  if (market === 'us') return usInSession(at) ? 20_000 : untilOpen('us', at);
  return 60_000;
}

/**
 * How long one kind of answer is kept (spec §4), in ms; Infinity is for good.
 *
 * @param {string} kind
 * @param {{ market?: string, now?: Date | number, closedDay?: boolean, adjusted?: boolean, session?: string, source?: string, past?: boolean }} [context]
 */
export function ttlFor(kind, { market, now = new Date(), closedDay = false, adjusted = true, session, source, past = false } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  let ttl;
  switch (kind) {
    case 'quote':
    case 'options':
      ttl = quoteTtl(market, at, session);
      break;
    case 'intraday':
      ttl = 2 * MINUTE;
      break;
    case 'history':
      // A closed day's raw bar never changes. An adjusted one is rewritten on each
      // ex-date, which takes effect at an open — so it lasts until the next one.
      ttl = closedDay ? (adjusted ? untilOpen(market, at) : Infinity) : Math.max(2 * MINUTE, quoteTtl(market, at, session));
      break;
    case 'statements':
    case 'ratios':
    case 'profile':
    case 'macro':
    case 'listings':
    case 'sec-tickers':
    case 'metrics':
    case 'screen':
      ttl = DAY;
      break;
    case 'events':
      ttl = 8 * HOUR;
      break;
    case 'news':
      ttl = 10 * MINUTE;
      break;
    case 'fx':
      // Vietcombank: "Only one request every 5 minutes!" (its own feed's header).
      ttl = source === 'vietcombank' ? 5 * MINUTE : past ? Infinity : HOUR;
      break;
    case 'gold':
      ttl = 5 * MINUTE;
      break;
    case 'crumb':
      ttl = 6 * HOUR;
      break;
    case 'fund':
      ttl = HOUR;
      break;
    default:
      ttl = 5 * MINUTE;
  }
  // CoinGecko's API terms (6.1): data shown must be refreshed at least every 24 hours.
  return source === 'coingecko' ? Math.min(ttl, DAY) : ttl;
}

/**
 * Whether an adjusted series fetched at `cachedAt` is still right: not when a
 * corporate action's ex-date has come since (it rewrites every earlier price).
 * An ex-date is taken to start at midnight in Vietnam, before that day's open.
 *
 * @param {number} cachedAt  ms
 * @param {Array<{ exDate?: string }>} events
 */
export function adjustedStillValid(cachedAt, events, now = Date.now()) {
  return !(events || []).some((event) => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(event?.exDate || ''))) return false;
    const ex = Date.parse(`${String(event.exDate).slice(0, 10)}T00:00:00+07:00`);
    return ex > cachedAt && ex <= now;
  });
}
