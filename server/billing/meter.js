/**
 * Metering (spec B1, Task 6; owner, 2026-11-13). A search, a minute of the cloud computer and a day's
 * storage past the plan are counted against the plan's month first and the balance after it. The
 * call asks for a hold before it runs and settles it after: what it really used is kept, the rest is
 * given back. Only a billable account is held at all (an administrator in preview who holds a plan or
 * a balance); everybody else gets `NOT_BILLED` and their calls go exactly as they did before.
 *
 * In preview nothing is ever refused: when neither the plan nor the balance can hold a call it goes
 * ahead unpaid, as today, and a "would" counter says it would have been charged. There are no daily
 * limits; an allowance is a month's. Prices come from the rate at the moment of each hold. No state
 * lives here except a 30 s answer to "is this account billable", per instance.
 */
import { getStore } from '../store/index.js';
import { log } from '../util/trace.js';
import { billingMode } from './mode.js';
import { PLANS, paygPrices } from './plans.js';
import { vnDay, vnDayEnd, addDays, addMonths, daysInVnMonth } from './period.js';
import { meteringRate } from './fx.js';
import { catchUp, planInForce } from './subscriptions.js';
import { BILLABLE_MAX, BILLABLE_MS, billableCache, forgetBillable } from './billable.js';

/**
 * @typedef {{ billed: boolean, source: 'included'|'balance'|'none'|null, paid: boolean, refused: boolean, units: number,
 *   settle: (actual: number) => Promise<void>, release: () => Promise<void> }} Hold
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
    await catchUp(id, { now });
    value = (await planInForce(id, { now })).plan !== 'free' || (await getStore().billingState(id)).balanceVnd > 0;
  }
  if (billableCache.size >= BILLABLE_MAX) billableCache.clear();
  billableCache.set(id, { until: Date.now() + BILLABLE_MS, value, mode });
  return value;
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
 * Take `units` from one source: the plan's month, else the balance, else nothing (a would-count in preview).
 * Null in live when nothing could be held.
 */
async function takeSearch(ctx, units) {
  const { userId, now, plan } = ctx;
  const store = getStore();
  if (plan.plan !== 'free') {
    const bucket = searchBucket(userId, ctx.month);
    const ends = lasts(ctx.month);
    if ((await store.addToCounter(bucket, units, ends)) <= PLANS[plan.plan].searches) return { source: 'included', units, bucket, ends };
    await store.addToCounter(bucket, -units, ends);
  }
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

/** Give back `n` units of what a piece took. */
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
 * more holds the extra by the same rules. A store that fails lets the call go ahead unpaid.
 *
 * @param {string|null|undefined} userId
 * @param {{ units?: number, now?: Date }} [options]
 * @returns {Promise<Hold>}
 */
export async function holdSearch(userId, { units = 1, now = new Date() } = {}) {
  try {
    if (!(await isBillable(userId, { now }))) return NOT_BILLED;
    const id = String(userId);
    const plan = await planInForce(id, { now });
    const ctx = { userId: id, now, plan, month: monthOf(plan, now) };
    const first = await takeSearch(ctx, units);
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
          const extra = await takeSearch(ctx, want - held);
          if (extra) pieces.push(extra);
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
 * Hold `seconds` of cloud computer time. The plan's month first (counted in seconds); then the balance, charged
 * per started minute over what this month's balance-paid seconds already covered (so 30 s + 30 s is one minute);
 * then nothing. `release()` takes back exactly what was taken. A partial settle keeps the whole window: a window
 * is paid up front and is either used or given back (e2b.js `giveBack`).
 *
 * @param {string|null|undefined} userId
 * @param {number} seconds
 * @param {{ now?: Date }} [options]
 * @returns {Promise<Hold>}
 */
export async function holdSandbox(userId, seconds, { now = new Date() } = {}) {
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
      if ((await store.addToCounter(bucket, secs, ends)) <= PLANS[plan.plan].sandboxMinutes * 60) piece = { source: 'included', bucket, ends };
      else await store.addToCounter(bucket, -secs, ends);
    }
    if (!piece) {
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
