/**
 * Metering (spec B1, Task 6; owner, 2026-11-13). A search, a minute of the cloud computer and a day's
 * storage past the plan are counted against the plan's month first and the balance after it. The
 * call asks for a hold before it runs and settles it after: what it really used is kept, the rest is
 * given back. Only a billable account is held at all (an administrator in preview who holds a plan or
 * a balance); everybody else gets `NOT_BILLED` and their calls go exactly as they did before.
 *
 * The free share comes between the two (owner, 2026-11-17): every account keeps its monthly share of the free keys, Free
 * after topping up too, and a paid plan gets the larger of that share and its own amount. A call the share pays for is a
 * `'share'` hold: billed (so the caller's member path stands aside), not paid (only free keys serve it), and counted against
 * the share by its own settle. The share is only of free capacity that exists: with the free keys used up, or with the
 * ceilings lifted (`FREE_TIER_ONLY` off), or when the share cannot be read, the call is charged instead.
 *
 * In preview nothing is ever refused: when neither the plan nor the balance can hold a call it goes
 * ahead unpaid, as today, and a "would" counter says it would have been charged. There are no daily
 * limits; an allowance is a month's. Prices come from the rate at the moment of each hold. No state
 * lives here except a 30 s answer to "is this account billable" and a minute's figure of what the free keys have left
 * (the deployment's, never an account's), per instance.
 */
import { getStore } from '../store/index.js';
import { log } from '../util/trace.js';
import { billingMode } from './mode.js';
import { PLANS, paygPrices } from './plans.js';
import { vnDay, vnDayEnd, addDays, addMonths, daysInVnMonth } from './period.js';
import { meteringRate } from './fx.js';
import { catchUpChanges, planInForce } from './subscriptions.js';
import { BILLABLE_MAX, BILLABLE_MS, billableCache, forgetBillable } from './billable.js';
import { freeTierOnly, periodOf } from '../freeTierPeriod.js';
import { allowance, countMetered } from '../freeTier.js';
import { searchShareOf, machineShareOf, searchCapacityLeft, noteArrival, MACHINE_MILLS_PER_HOUR } from '../freeShares.js';

/** How long a metered call waits for the mail of a plan change it made; the mail then finishes by itself. */
const TELL_MS = 8_000;

/**
 * @typedef {{ billed: boolean, source: 'included'|'balance'|'share'|'none'|null, paid: boolean, refused: boolean, units: number,
 *   settle: (actual: number) => Promise<void>, release: () => Promise<void> }} Hold
 */

/**
 * @typedef {{ source: 'included'|'none', units: number, bucket: string, ends: Date }
 *   | { source: 'balance', units: number, price: number, day: string }} SearchPiece what a search hold took from one source
 */

/** What a call that is not metered by billing holds: nothing, and nothing to give back. */
export const NOT_BILLED = Object.freeze({
  billed: false, source: null, paid: false, refused: false, units: 0, settle: async () => {}, release: async () => {},
});

export { forgetBillable };

/**
 * Whether this account is metered by billing: an administrator in preview (any account in live) that holds a
 * plan in force or a balance. `user` saves a read when the caller already has the account.
 *
 * @param {string|null|undefined} userId
 * @param {{ now?: Date, user?: { role?: string } | null }} [options]
 */
export async function isBillable(userId, { now = new Date(), user } = {}) {
  if (!userId) return false;
  const mode = billingMode();
  if (mode === 'off') return false;
  const id = String(userId);
  const hit = billableCache.get(id);
  if (hit && hit.until > Date.now() && hit.mode === mode) return hit.value;
  const account = user ?? (await getStore().getUserById(id));
  if (!account) return false;
  let value = false;
  if (mode === 'live' || account.role === 'admin') {
    // Done before the plan is read, so an ended period is ended and a due renewal is made (at most once: the answer is kept).
    const { changes } = await catchUpChanges(id, { now });
    // A period's end is often met here first; the change is then this call's to tell, as the daily job would have.
    if (changes.length) await tellFromHere(id, changes, now);
    value = (await planInForce(id, { now })).plan !== 'free' || (await getStore().billingState(id)).balanceVnd > 0;
  }
  if (billableCache.size >= BILLABLE_MAX) billableCache.clear();
  billableCache.set(id, { until: Date.now() + BILLABLE_MS, value, mode });
  return value;
}

/**
 * Tell the account of a plan change this call made. tell.js is loaded only then: it brings the mail stack, which a metered call
 * never needs otherwise, and nothing it imports leads back here. Never throws: the metered call goes on whatever the mail does.
 */
async function tellFromHere(userId, changes, now) {
  try {
    const { tellChanges } = await import('./tell.js');
    await tellChanges(userId, changes, { now, waitMs: TELL_MS });
  } catch (err) {
    warn('a plan change could not be told', err);
  }
}

/**
 * The paid plan a billable account holds, for the storage room (storageQuota.js); null for everybody else.
 * Never throws: a room that cannot be worked out is the account's usual one.
 */
export async function billedPlanOf(user, { now = new Date() } = {}) {
  try {
    if (!user?.id || billingMode() === 'off') return null;
    if (billingMode() === 'preview' && user.role !== 'admin') return null;
    if (!(await isBillable(user.id, { now, user }))) return null;
    const { plan } = await planInForce(user.id, { now });
    return plan === 'free' ? null : PLANS[plan];
  } catch (err) {
    log.warn('billing: storage plan could not be read', { error: String(err?.message || err).slice(0, 160) });
    return null;
  }
}

/* ── counters ───────────────────────────────────────────────────────── */

const searchBucket = (userId, month) => `bill:search:${userId}:${month.key}`;
const sandboxBucket = (userId, month) => `bill:sandbox:${userId}:${month.key}`;
const sandboxPaidBucket = (userId, month) => `bill:sandbox-paid:${userId}:${month.key}`;
const wouldBucket = (userId, kind, day) => `bill:would:${userId}:${kind}:${day}`;
/** Counters outlive their window by a day so a call settled just after midnight still finds its row. */
const lasts = (month) => addDays(month.end, 1);
const wouldEnds = (now) => addDays(vnDayEnd(now), 1);

/** The month a billable account's allowances are counted in: its plan's own, else the Vietnamese calendar month. */
function monthOf(plan, now) {
  if (plan.month) return plan.month;
  const start = new Date(`${vnDay(now).slice(0, 8)}01T00:00:00+07:00`);
  return { start, end: addMonths(start, 1), key: String(start.getTime()) };
}

const warn = (what, err) => log.warn(`billing: ${what}`, { error: String(err?.message || err).slice(0, 160) });

/** Taken by `takeSearch` when the free share pays for the call: a share hold, whose settle counts it (owner, 2026-11-17). */
const SHARE = Symbol('share');

const FREE_POOL_MS = 60_000;
/** @type {Map<string, { at: number, left: number }>} Deployment-wide figures only, never an account's: kept a minute per instance. */
const freePools = new Map();

/** For tests: forget what the free pools had left. */
export const forgetFreePools = () => freePools.clear();

/**
 * What the free keys of one service have left this month: `'exa'`; `'firecrawl_scrape'` (a page read) or `'firecrawl_more'`
 * (a map or a crawl), each with Firecrawl's whole credits; `'search'`, every pooled engine together. The share is of free
 * capacity that exists (owner, 2026-11-17: once it is used up, use goes to the paid key), so a dry pool is no share.
 */
async function freePoolLeft(service, now) {
  const key = `${service}:${periodOf('month', now).key}`;
  const hit = freePools.get(key);
  if (hit && Date.now() - hit.at < FREE_POOL_MS) return hit.left;
  let left;
  if (service === 'search') left = await searchCapacityLeft(now);
  else if (service === 'exa') left = (await allowance('exa', now)).left;
  else left = Math.min((await allowance(service, now)).left, (await allowance('firecrawl', now)).left);
  freePools.set(key, { at: Date.now(), left });
  return left;
}

/**
 * What is left of the free share beyond the plan's own amount: a plan gets the larger of the two (owner, 2026-11-17,
 * "the best for profit"), and Free gets the whole share. Nothing with the ceilings lifted: there is no share then, and
 * counting one would make every call free. Nothing when the free keys for `service` are used up, and nothing when the
 * share could not really be read (a count that failed, or a figure taken from last month): the call is charged then.
 */
async function searchRoom(userId, now, plan, service) {
  if (!freeTierOnly()) return 0;
  try {
    if (service && !((await freePoolLeft(service, now)) > 0)) return 0;
    const { share, used, unread } = await searchShareOf(userId, now);
    if (unread) {
      log.warn('billing: the free share could not be read, so the call is charged', {});
      return 0;
    }
    const own = plan.plan === 'free' ? 0 : PLANS[plan.plan].searches;
    return Number.isFinite(share) ? Math.max(0, share - own - used) : 0;
  } catch (err) {
    warn('the free share could not be read', err);
    return 0;
  }
}

/** The same for the cloud computer, in mills. */
async function machineRoom(userId, now, plan) {
  if (!freeTierOnly()) return 0;
  try {
    const { share, used, unread } = await machineShareOf(userId, now);
    if (unread) {
      log.warn('billing: the free machine share could not be read, so the window is charged', {});
      return 0;
    }
    const own = plan.plan === 'free' ? 0 : Math.round((PLANS[plan.plan].sandboxMinutes * MACHINE_MILLS_PER_HOUR) / 60);
    return Number.isFinite(share) ? Math.max(0, share - own - used) : 0;
  } catch (err) {
    warn('the free machine share could not be read', err);
    return 0;
  }
}

/** @returns {Hold} */
function makeHold({ source, paid, refused, units, settle }) {
  let done = false;
  const once = (fn) => async (...args) => {
    if (done) return;
    done = true;
    try {
      await fn(...args);
    } catch (err) {
      // Giving back must never break the caller's result; the figure stands and the owner can see this line.
      warn('a hold could not be settled', err);
    }
  };
  const run = once(settle);
  return { billed: true, source, paid, refused, units, settle: (actual) => run(actual), release: () => run(0) };
}

/* ── searches ───────────────────────────────────────────────────────── */

/**
 * Take `units` from one source: the plan's month, else the free share (`SHARE`: a share hold, which counts it when settled),
 * else the balance, else nothing (a would-count in preview). Null in live when nothing could be held. The extra units of a
 * settle pass `share: false`: they are past the one the share paid for and follow the plan and the balance.
 *
 * @param {{ userId: string, now: Date, plan: any, month: any, service?: string }} ctx
 * @param {number} units
 * @param {{ share?: boolean }} [options]
 * @returns {Promise<SearchPiece | typeof SHARE | null>}
 */
async function takeSearch(ctx, units, { share = true } = {}) {
  const { userId, now, plan } = ctx;
  const store = getStore();
  if (plan.plan !== 'free') {
    const bucket = searchBucket(userId, ctx.month);
    const ends = lasts(ctx.month);
    const total = await store.addToCounter(bucket, units, ends);
    if (total <= PLANS[plan.plan].searches) {
      // The day it first uses its month is the day it joined, so the share it reaches later is not worked out for the days left.
      if (total <= Math.max(3, units * 3)) await noteArrival('search', userId, now);
      return { source: 'included', units, bucket, ends };
    }
    await store.addToCounter(bucket, -units, ends);
  }
  if (share && (await searchRoom(userId, now, plan, ctx.service)) > 0) return SHARE;
  const price = paygPrices(await meteringRate()).searchVnd;
  const day = vnDay(now);
  const charged = await store.chargeUsage(userId, 'search', units, units * price, day);
  if (charged !== null) {
    forgetBillable(userId);
    return { source: 'balance', units, price, day };
  }
  if (billingMode() === 'live') return null;
  await store.addToCounter(wouldBucket(userId, 'search', day), units, wouldEnds(now));
  return { source: 'none', units, ends: wouldEnds(now), bucket: wouldBucket(userId, 'search', day) };
}

/**
 * The hold of a search the free share pays for: free keys only (`paid` false), and `billed`, so the caller's member path
 * (`mayMeter`, `countMetered`) stands aside and this counts instead. Settled with `actual`, one unit is counted against the
 * share; the rest are the plan's or the balance's. Given back unused, nothing is counted.
 *
 * @returns {Hold}
 */
function shareHold(ctx, units) {
  return Object.freeze(makeHold({
    source: 'share',
    paid: false,
    refused: false,
    units,
    settle: async (actual) => {
      const want = Math.max(0, Math.floor(Number(actual) || 0));
      if (want < 1) return;
      await countMetered(ctx.userId, ctx.now);
      if (want > 1 && !(await takeSearch(ctx, want - 1, { share: false }))) log.warn('billing: an extra unit could not be held', {});
    },
  }));
}

/**
 * Give back `n` units of what a piece took.
 *
 * @param {{ userId: string }} ctx
 * @param {SearchPiece} piece
 * @param {number} n
 */
async function giveSearch(ctx, piece, n) {
  const store = getStore();
  if (piece.source === 'balance') {
    await store.refundUsage(ctx.userId, 'search', n, n * piece.price, piece.day);
    forgetBillable(ctx.userId);
  } else {
    await store.addToCounter(piece.bucket, -n, piece.ends);
  }
}

/**
 * Hold search units before a metered call (a search, a read through Exa or Firecrawl, a crawl).
 * `settle(actual)` keeps `actual` of them: fewer gives the difference back on the same source,
 * more holds the extra by the same rules. A call the free share pays for is a `'share'` hold (see `shareHold`).
 * A store that fails lets the call go ahead unpaid.
 *
 * `service` names the free keys that would serve the call (`freePoolLeft`): with none left the share is not used and the
 * call is charged, so it may go on the paid key. Left out, the share is taken without asking.
 *
 * @param {string|null|undefined} userId
 * @param {{ units?: number, now?: Date, service?: 'exa'|'firecrawl_scrape'|'firecrawl_more'|'search', share?: boolean }} [options]
 * `share: false` skips the share step: a call that found the free keys dry after all is held again on the balance.
 * @returns {Promise<Hold>}
 */
export async function holdSearch(userId, { units = 1, now = new Date(), service, share = true } = {}) {
  try {
    if (!(await isBillable(userId, { now }))) return NOT_BILLED;
    const id = String(userId);
    const plan = await planInForce(id, { now });
    const ctx = { userId: id, now, plan, month: monthOf(plan, now), service };
    const first = await takeSearch(ctx, units, { share });
    if (first === SHARE) return shareHold(ctx, units);
    if (!first) return makeHold({ source: 'none', paid: false, refused: true, units, settle: async () => {} });
    const pieces = [first];
    return makeHold({
      source: first.source,
      paid: first.source !== 'none',
      refused: false,
      units,
      settle: async (actual) => {
        const want = Math.max(0, Math.floor(Number(actual) || 0));
        const held = pieces.reduce((sum, p) => sum + p.units, 0);
        if (want > held) {
          // More than was held: the extra is held by the same rules; in live one that cannot be held is not charged.
          const extra = await takeSearch(ctx, want - held, { share: false });
          if (extra && extra !== SHARE) pieces.push(extra);
          else log.warn('billing: an extra unit could not be held', {});
          return;
        }
        let give = held - want;
        for (let i = pieces.length - 1; i >= 0 && give > 0; i -= 1) {
          const n = Math.min(pieces[i].units, give);
          if (!n) continue;
          await giveSearch(ctx, pieces[i], n);
          pieces[i].units -= n;
          give -= n;
        }
      },
    });
  } catch (err) {
    warn('a search could not be held, so it goes ahead unpaid', err);
    return NOT_BILLED;
  }
}

/* ── the cloud computer ─────────────────────────────────────────────── */

/**
 * Hold `seconds` of cloud computer time. The plan's month first (counted in seconds); then the free share, when the caller
 * says what the window costs it (`shareCost`, in mills) and E2B's free month still holds that (a `'share'` hold, whose
 * settle and release count nothing: the caller spends the share, e2b.js `payUntil`); then the balance, charged
 * per started minute over what this month's balance-paid seconds already covered (so 30 s + 30 s is one minute);
 * then nothing. `release()` takes back exactly what was taken. A partial settle keeps the whole window: a window
 * is paid up front and is either used or given back (e2b.js `giveBack`).
 *
 * @param {string|null|undefined} userId
 * @param {number} seconds
 * @param {{ now?: Date, shareCost?: number }} [options] `shareCost` is in mills; left out, there is no share step
 * @returns {Promise<Hold>}
 */
export async function holdSandbox(userId, seconds, { now = new Date(), shareCost } = {}) {
  try {
    const secs = Math.max(0, Math.ceil(Number(seconds) || 0));
    if (!(await isBillable(userId, { now }))) return NOT_BILLED;
    const id = String(userId);
    const store = getStore();
    const plan = await planInForce(id, { now });
    const month = monthOf(plan, now);
    const ends = lasts(month);
    let piece = null;
    if (plan.plan !== 'free') {
      const bucket = sandboxBucket(id, month);
      const total = await store.addToCounter(bucket, secs, ends);
      if (total <= PLANS[plan.plan].sandboxMinutes * 60) {
        // As for searches: the first day it uses its included time is the day it joined, for the share it reaches later.
        if (total <= secs * 3) await noteArrival('machine', id, now);
        piece = { source: 'included', bucket, ends };
      } else await store.addToCounter(bucket, -secs, ends);
    }
    if (!piece) {
      if (shareCost > 0 && (await machineRoom(id, now, plan)) >= shareCost && (await allowance('e2b', now)).left >= shareCost) {
        return Object.freeze(makeHold({ source: 'share', paid: false, refused: false, units: secs, settle: async () => {} }));
      }
      const perMinute = paygPrices(await meteringRate()).sandboxVndPerMinute;
      const day = vnDay(now);
      const paidBucket = sandboxPaidBucket(id, month);
      const after = await store.addToCounter(paidBucket, secs, ends);
      // Windows released out of order can leave a minute less charged than started; that favours the customer and is accepted.
      const minutes = Math.ceil(after / 60) - Math.ceil((after - secs) / 60);
      // A window inside a minute already paid for costs nothing and writes no ledger row.
      const charged = minutes > 0 ? await store.chargeUsage(id, 'sandbox', minutes, minutes * perMinute, day) : 0;
      if (charged !== null) {
        forgetBillable(id);
        piece = { source: 'balance', bucket: paidBucket, ends, minutes, vnd: minutes * perMinute, day };
      } else {
        await store.addToCounter(paidBucket, -secs, ends);
        if (billingMode() === 'live') return makeHold({ source: 'none', paid: false, refused: true, units: secs, settle: async () => {} });
        const bucket = wouldBucket(id, 'sandbox', day);
        await store.addToCounter(bucket, secs, wouldEnds(now));
        piece = { source: 'none', bucket, ends: wouldEnds(now) };
      }
    }
    return makeHold({
      source: piece.source,
      paid: piece.source !== 'none',
      refused: false,
      units: secs,
      settle: async (actual) => {
        if (Math.max(0, Number(actual) || 0) > 0) return;
        await store.addToCounter(piece.bucket, -secs, piece.ends);
        if (piece.source === 'balance' && piece.minutes > 0) {
          await store.refundUsage(id, 'sandbox', piece.minutes, piece.vnd, piece.day);
          forgetBillable(id);
        }
      },
    });
  } catch (err) {
    warn('machine time could not be held, so it goes ahead unpaid', err);
    return NOT_BILLED;
  }
}

/* ── storage ────────────────────────────────────────────────────────── */

/**
 * Charge a day of storage past the plan's GB to every billable account holding a paid plan (B1: an account with
 * only a balance has no plan GB to go past, so it is not charged for storage). In tenths of a GB, rounded up.
 * Not idempotent: the daily job claims the day once (Task 7) and calls this.
 *
 * @returns {Promise<{ charged: number, would: number }>} accounts charged, and accounts that only would have been
 */
export async function chargeStorageDay({ now = new Date() } = {}) {
  const store = getStore();
  const out = { charged: 0, would: 0 };
  const day = vnDay(now);
  const ids = await store.listSubscribedUserIds();
  if (!ids.length) return out;
  const sizes = await store.storageBytesByUser(ids);
  const price = paygPrices(await meteringRate()).storageVndPerGbMonth;
  for (const id of ids) {
    try {
      if (!(await isBillable(id, { now }))) continue;
      const { plan } = await planInForce(id, { now });
      if (plan === 'free') continue;
      const overTenths = Math.max(0, Math.ceil((sizes.get(id) || 0) / 1e8) - PLANS[plan].storageGb * 10);
      if (!overTenths) continue;
      const vnd = Math.ceil((overTenths * price) / 10 / daysInVnMonth(now));
      // A claim per account and day, besides the daily claim of the job that calls this: a day is charged to an account once.
      if ((await store.addToCounter(`bill:storage:${id}:${day}`, 1, vnDayEnd(now))) !== 1) continue;
      if ((await store.chargeUsage(id, 'storage', overTenths, vnd, day)) !== null) {
        forgetBillable(id);
        out.charged += 1;
      } else {
        await store.addToCounter(wouldBucket(id, 'storage', day), overTenths, wouldEnds(now));
        out.would += 1;
      }
    } catch (err) {
      warn('a day of storage could not be charged', err);
    }
  }
  return out;
}

/* ── the Billing tab's "This period" ────────────────────────────────── */

/**
 * What this account has used in its current month, from the counters and the month's usage entries.
 * Paid figures are the usage entries of the month's days (Vietnamese time); "would" are preview's unpaid calls.
 */
export async function periodUsage(userId, { now = new Date() } = {}) {
  const store = getStore();
  const id = String(userId);
  const plan = await planInForce(id, { now });
  const month = monthOf(plan, now);
  const limits = PLANS[plan.plan];
  const first = vnDay(month.start);
  const last = vnDay(new Date(month.end.getTime() - 1));
  const sums = { search: { units: 0, vnd: 0 }, sandbox: { units: 0, vnd: 0 }, storage: { units: 0, vnd: 0 } };
  for (let before = null; ;) {
    const page = await store.listBalanceEntries(id, { kind: 'usage', before, limit: 200 });
    for (const e of page) if (sums[e.category] && e.day >= first && e.day <= last) {
      sums[e.category].units += e.units;
      sums[e.category].vnd += -e.deltaVnd;
    }
    // Newest first: once a page reaches before the month there is nothing more of it.
    if (page.length < 200 || page[page.length - 1].day < first) break;
    before = page[page.length - 1].id;
  }
  const days = [];
  for (let at = month.start; vnDay(at) <= last; at = addDays(at, 1)) days.push(vnDay(at));
  const kinds = ['search', 'sandbox', 'storage'];
  const wouldCounts = await store.readCounters(kinds.flatMap((k) => days.map((d) => wouldBucket(id, k, d))));
  const would = Object.fromEntries(kinds.map((k) => [k, days.reduce((sum, d) => sum + (wouldCounts.get(wouldBucket(id, k, d)) || 0), 0)]));
  const [searchUsed, sandboxUsed] = await Promise.all([store.readCounter(searchBucket(id, month)), store.readCounter(sandboxBucket(id, month))]);
  const bytes = (await store.storageBytesByUser([id])).get(id) || 0;
  return {
    plan: plan.plan,
    month: { start: month.start, end: month.end },
    search: { included: limits.searches, used: searchUsed, paidUnits: sums.search.units, paidVnd: sums.search.vnd },
    sandbox: { includedSeconds: limits.sandboxMinutes * 60, usedSeconds: sandboxUsed, paidMinutes: sums.sandbox.units, paidVnd: sums.sandbox.vnd },
    storage: { bytes, includedGb: limits.storageGb, paidVnd: sums.storage.vnd },
    would,
    finance: { free: true },
  };
}
