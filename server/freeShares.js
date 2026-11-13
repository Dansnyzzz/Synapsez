import { getStore } from './store/index.js';
import { log } from './util/trace.js';
import { allowance, e2bAccountShare } from './freeTier.js';
import { keysFor, keysVersion } from './keyPool.js';
import { periodOf, freeTierOnly, numIn, noDatabase } from './freeTierPeriod.js';

/**
 * Each account's free share, a month's and worked out (owner, 2026-11-13: "limit users by the
 * month, not the day", "the numbers must not need changing when there are many more users").
 * A fixed 900 a month runs the deployment's free keys dry after about 17 heavy accounts, so on
 * the first call of a UTC month the share is worked out from what the keys can really do and
 * how many people use them, stored under the setting `free_shares:<month>`, and held.
 *
 * It is the deployment's figure, never one account's, so it is safe to keep a memory of it in this
 * instance (`memo`). Working it out reads the keys' capacity (about a dozen queries), so it is done
 * again only after ten minutes or when the key pool's version moves (a key added or removed) —
 * nothing else — and the stored figure is written so that it can only rise (store `raiseSetting`),
 * whichever instance writes last.
 */

/** What one metered search costs each pooled engine at the medium search level, to turn allowances into searches. */
export const SEARCH_COST = Object.freeze({ exa: 15 /* mills: auto 7 + 8 pages of text */, tavily: 1 /* credit */, brave: 1 /* request */, firecrawl: 2 /* credits a search, of its search share */ });

/** About an hour of the 2-vCPU machine, in thousandths of a dollar: turns a share of machine time into minutes to show. */
export const MACHINE_MILLS_PER_HOUR = 133;

export const SHARE_BOUNDS = (env = process.env) => ({
  searchMin: numIn(env, 'FREE_TIER_USER_MONTHLY_MIN', 30),
  searchMax: numIn(env, 'FREE_TIER_USER_MONTHLY_MAX', 900),
  searchPeopleFloor: 10,
  machineMinMills: numIn(env, 'E2B_ACCOUNT_MIN_MILLS', MACHINE_MILLS_PER_HOUR),
  machineMaxShare: e2bAccountShare(env),
  machinePeopleFloor: 3,
});

/** The part of the capacity kept back for people who arrive after the 1st (owner, 2026-11-13: "what if more users come after the 1st?"). */
export const shareReserve = (env = process.env) => {
  const n = numIn(env, 'FREE_SHARE_RESERVE', 0.2);
  return n < 0.9 ? n : 0.2;
};

const settingOf = (month) => `free_shares:${month}`;
const MEMO_MS = 10 * 60_000;
/** @type {{ month: string, at: number, version: string, value: any } | null} */
let memo = null;

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const daysIn = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
/** The share for the days that are left, drawn from the reserve; the 1st gets the whole of it. */
const prorated = (full, day, days, floor) => (day <= 1 ? full : Math.min(full, Math.max(floor, Math.floor((full * (days - day + 1)) / days))));

/** The month after next begins: a count is kept to the end of the NEXT month so last month's can still be read. */
const keptUntil = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));

/** An account's metered searches this month. */
export const searchBucket = (userId, now) => ({ bucket: `free:user:${userId}:${periodOf('month', now).key}`, ends: keptUntil(now) });
/** An account's cloud-computer time this month, in mills. */
export const machineBucket = (userId, now) => ({ bucket: `free:e2b:${periodOf('month', now).key}:user:${userId}`, ends: keptUntil(now) });
/** The day of the month an account first metered, so a share worked out for the days left does not move later. */
const arrivalBucket = (kind, userId, now) => ({ bucket: `free:arrive:${kind}:${periodOf('month', now).key}:user:${userId}`, ends: periodOf('month', now).ends });

/**
 * Remember the day an account first used something this month — written only if there is none, in
 * one statement, so it can be repeated until it has been written (the caller does, for an account's
 * first few counts). A day that is missing means the whole share, never a smaller one.
 */
export async function noteArrival(kind, userId, now = new Date()) {
  try {
    const { bucket, ends } = arrivalBucket(kind, userId, now);
    await getStore().setCounterIfAbsent(bucket, now.getUTCDate(), ends);
  } catch {
    /* tried again with the account's next count */
  }
}

/** What the keys can do this month, in searches and in mills of machine time, and how many searches are left. */
async function capacityNow(now) {
  let searches = 0;
  let left = 0;
  const parts = { exa: ['exa', 'exa'], tavily: ['tavily', 'tavily'], brave: ['brave', 'brave'], firecrawl: ['firecrawl_search', 'firecrawl'] };
  for (const [engine, [service, keyed]] of Object.entries(parts)) {
    // A service with no key at all adds nothing: its default ceiling is a figure for a key that is not there.
    if (!(await keysFor(keyed)).length) continue;
    const one = await allowance(service, now);
    searches += Math.floor(one.limit / SEARCH_COST[engine]);
    left += Math.floor(one.left / SEARCH_COST[engine]);
  }
  const machine = (await keysFor('e2b')).length ? await allowance('e2b', now) : { limit: 0 };
  return { searches, left, machineMills: machine.limit };
}

/** Distinct accounts that used something this month or last. */
async function peopleNow(now) {
  const store = getStore();
  const here = periodOf('month', now).key;
  const before = periodOf('month', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))).key;
  return {
    searches: await store.countAccountsByBucket([`free:user:%:${here}`, `free:user:%:${before}`]),
    machines: await store.countAccountsByBucket([`free:e2b:${here}:user:%`, `free:e2b:${before}:user:%`]),
  };
}

function workOut(capacity, people, env = process.env) {
  const bounds = SHARE_BOUNDS(env);
  const kept = 1 - shareReserve(env);
  const searches = clamp(Math.floor((capacity.searches * kept) / Math.max(bounds.searchPeopleFloor, people.searches)), bounds.searchMin, Math.max(bounds.searchMin, bounds.searchMax));
  const machineHigh = Math.floor(capacity.machineMills * bounds.machineMaxShare);
  // The share cap wins over the floor: an owner who sets E2B_ACCOUNT_SHARE very low means it.
  const machineMills = Math.min(machineHigh, Math.max(bounds.machineMinMills, Math.floor((capacity.machineMills * kept) / Math.max(bounds.machinePeopleFloor, people.machines))));
  return { searches, machineMills };
}

/** The maxima (900, 34%): a share that cannot be worked out never blocks anybody. */
async function maxima(now) {
  const bounds = SHARE_BOUNDS();
  const machine = await allowance('e2b', now).catch(() => ({ limit: Infinity }));
  return {
    month: periodOf('month', now).key,
    searches: bounds.searchMax,
    machineMills: Number.isFinite(machine.limit) ? Math.max(bounds.machineMinMills, Math.floor(machine.limit * bounds.machineMaxShare)) : Infinity,
    capacity: { searches: null, machineMills: Number.isFinite(machine.limit) ? machine.limit : null },
    people: { searches: null, machines: null },
    at: now.toISOString(),
    fallback: true,
  };
}

/** Test hook: forget the short memory. */
export const __testing = { forget: () => { memo = null; } };

/**
 * This month's shares: { month, searches, machineMills, capacity: { searches, machineMills },
 * people: { searches, machines }, at }.
 */
export async function monthShares({ now = new Date() } = {}) {
  const month = periodOf('month', now).key;
  try {
    if (!freeTierOnly()) return await maxima(now);
    const version = await keysVersion();
    if (memo && memo.month === month && memo.version === version && Date.now() - memo.at < MEMO_MS) return memo.value;
    const store = getStore();
    const saved = await store.getSetting(settingOf(month));
    let figure = saved && saved.month === month && saved.capacity ? saved : null;
    const cap = await capacityNow(now);
    if (!Number.isFinite(cap.searches) || !Number.isFinite(cap.machineMills)) return await maxima(now);
    if (!figure || cap.searches > figure.capacity.searches || cap.machineMills > figure.capacity.machineMills) {
      const people = await peopleNow(now);
      const worked = workOut(cap, people);
      // Written in one statement that keeps the larger of each figure (owner, 2026-11-13: never lowered mid-month),
      // so another instance working it out from other counts at the same moment cannot lower it; what is stored is what we use.
      figure = await store.raiseSetting(settingOf(month), { month, searches: worked.searches, machineMills: worked.machineMills, capacity: { searches: cap.searches, machineMills: cap.machineMills }, people, at: now.toISOString() });
    }
    memo = { month, at: Date.now(), version, value: figure };
    return figure;
  } catch (err) {
    if (!noDatabase(err)) log.warn('free shares: not worked out, using the last month\'s', { error: String(err?.message || err).slice(0, 160) });
    const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const last = await getStore().getSetting(settingOf(periodOf('month', before).key)).catch(() => null);
    return last && Number(last.searches) > 0 ? { ...last, month, fallback: true } : maxima(now);
  }
}

/** The account's own counts in one read: this month's, last month's (a returning account), and the day it joined. */
async function readAccount(store, arrival, counted, before) {
  const counts = await store.readCounters([arrival, counted, before]);
  const returning = (counts.get(before) || 0) > 0;
  // An account counted last month was in the 1st's divisor: never prorated. A newcomer with no day on record
  // (none yet, or the write failed) has the whole share rather than a smaller one each day.
  return { used: counts.get(counted) || 0, joinedOn: returning ? null : counts.get(arrival) || null };
}

const lastMonth = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));

/** An account's share of metered searches this month and what it has used. `joinedOn` is set for a newcomer who joined after the 1st. */
export async function searchShareOf(userId, now = new Date()) {
  const month = await monthShares({ now });
  let joinedOn = null;
  let used = 0;
  try {
    ({ used, joinedOn } = await readAccount(getStore(), arrivalBucket('search', userId, now).bucket, searchBucket(userId, now).bucket, searchBucket(userId, lastMonth(now)).bucket));
  } catch {
    /* unreadable: the whole share, none used */
  }
  const share = joinedOn ? prorated(month.searches, joinedOn, daysIn(now), SHARE_BOUNDS().searchMin) : month.searches;
  return { share, used, joinedOn: joinedOn > 1 ? joinedOn : null };
}

/** The same for the cloud computer, in mills. */
export async function machineShareOf(userId, now = new Date()) {
  const month = await monthShares({ now });
  let joinedOn = null;
  let used = 0;
  try {
    ({ used, joinedOn } = await readAccount(getStore(), arrivalBucket('machine', userId, now).bucket, machineBucket(userId, now).bucket, machineBucket(userId, lastMonth(now)).bucket));
  } catch {
    /* unreadable: the whole share, none used */
  }
  const share = !Number.isFinite(month.machineMills) ? Infinity : joinedOn ? prorated(month.machineMills, joinedOn, daysIn(now), SHARE_BOUNDS().machineMinMills) : month.machineMills;
  return { share, used, joinedOn: joinedOn > 1 ? joinedOn : null };
}

/** Everything the Usage card shows for one account. */
export async function accountShares(userId, now = new Date()) {
  const month = await monthShares({ now });
  const search = await searchShareOf(userId, now);
  const machine = await machineShareOf(userId, now);
  // Only the card says the keys are used up (computed when the card is drawn): a metered engine with nothing left stands aside
  // by itself and a free one answers, so nothing is billed and no search is held back for it.
  const dry = freeTierOnly() ? await capacityNow(now).then((cap) => cap.searches > 0 && cap.left === 0, () => false) : false;
  return {
    month: month.month,
    endsAt: periodOf('month', now).ends.toISOString(),
    enforced: freeTierOnly(),
    dry,
    reserve: shareReserve(),
    bounds: SHARE_BOUNDS(),
    capacity: month.capacity,
    people: month.people,
    daysInMonth: daysIn(now),
    joinedOn: search.joinedOn ?? machine.joinedOn,
    searches: { used: search.used, share: search.share },
    machine: { usedMills: machine.used, shareMills: Number.isFinite(machine.share) ? machine.share : null },
  };
}
