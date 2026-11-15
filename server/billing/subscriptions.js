/**
 * The plan's life (owner, 2026-11-12/13). A plan is a period paid in advance. At its end it renews
 * from the balance when auto-renew is on and the balance covers it; otherwise there are three days of
 * grace (the plan still counts, and a payment in grace continues from the old end, not from the
 * day it was paid); after that it ends and the account is free. Unpaid grace days are not charged.
 *
 * Nothing here runs on a timer. `catchUp` does what is due for one account when it is next looked at,
 * and the cron route calls it for every account that is near an end, so both places reach the same
 * answer and neither depends on a process staying alive.
 *
 * Money moves only through orders. A subscription is changed by field-level statements or by a compare-and-set on
 * the row that was read (store.patchSubscription), so one request does not overwrite another's field. Two orders
 * paid at once cannot both take money because of the unique index on (user, basis) over paid orders (schema 53): the
 * second payment's statement fails whole. A paid order is started and marked applied in one statement, and one that
 * can no longer be started is refunded (orders.js settleUnapplied), so money never stays without its plan.
 */
import { getStore } from '../store/index.js';
import { RANK, isPaidPlan, isPeriod, GRACE_DAYS, REMIND_DAYS } from './plans.js';
import { periodEnd, addDays, monthWindow, renewalEnd } from './period.js';
import { BillingUnavailable } from './fx.js';
import { log } from '../util/trace.js';
import { applyOrder, findRenewalOrder, paidRenewalFor, renewalOrderFor, renewalTerms, settleUnapplied } from './orders.js';

/** Whether a stored subscription still counts at `now`: not ended, and not past its grace. */
export const isLive = (sub, now) => !!sub && sub.status !== 'ended' && now < addDays(sub.periodEnd, GRACE_DAYS);

/**
 * What choosing `plan`/`period` means for an account on `sub`: `upgrade` starts now (the unused part of what was
 * paid is credited), `later` waits for the period end. Any move from a year to a month waits, whatever the plan
 * (owner ruling 2026-11-13): an immediate upgrade from a year is a higher plan's year.
 */
export function moveKind(sub, plan, period) {
  if ((period === 'month' && sub.period === 'year') || RANK[plan] < RANK[sub.plan]) return 'later';
  if (plan === sub.plan) return period === sub.period ? 'later' : 'upgrade';
  return 'upgrade';
}

/**
 * The subscription an order is based on, as the order remembers it: plan|period|period end in ms while one is in force, else
 * none|<end in ms of the lapse it follows> (none|0 for a first purchase), so each lapse can be paid for once.
 */
export const basisOf = (sub, now) => (isLive(sub, now) ? `${sub.plan}|${sub.period}|${sub.periodEnd.getTime()}` : `none|${sub ? sub.periodEnd.getTime() : 0}`);

/**
 * Start or continue a plan because its order was paid. Null when the order can no longer be applied (the plan it was based on
 * has moved on, or the period it renews is not the row's): the caller refunds it. A new plan or an upgrade starts a period now; a
 * renewal continues from the old end, counted from the original start day so a short month does not move it.
 * Applying is idempotent: the order is recorded on the row (`last_order`), a renewal is also tied to its
 * period, and the write is a compare-and-set on the row that was read (re-read and tried again if it moved).
 */
export async function activate(order, { now = new Date() } = {}) {
  return (await applyPaidOrder(order, { now })).sub;
}

/**
 * `activate`, and `applied`: whether this call's own statement started it. The statement claims the order, so of two callers
 * at once exactly one is told `true`; the other (and one that finds it started already) is told `false` and has nothing to tell.
 */
export async function applyPaidOrder(order, { now = new Date() } = {}) {
  const store = getStore();
  const theirs = (sub) => ({ sub, applied: false });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const old = await store.getSubscription(order.userId);
    if (old?.lastOrder === order.id) return theirs(old);
    let next;
    if (order.kind === 'renewal') {
      // A renewal continues the period it was made for, and only that one: it never starts a plan of its own.
      if (!old || +addDays(old.periodEnd, GRACE_DAYS) !== +order.expiresAt) return theirs(null);
      // Paid before the end: the money is taken and the order is recorded as paid, the plan changes at the end.
      if (now < old.periodEnd) return theirs(old);
      const anchor = old.anchorAt ?? old.periodStart;
      next = await store.patchSubscription(order.userId, { seenEnd: old.periodEnd }, {
        plan: order.plan, period: order.period, status: 'active', periodStart: old.periodEnd, periodEnd: renewalEnd(anchor, old.periodEnd, order.period),
        paidVnd: order.priceVnd, anchorAt: anchor, nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null, lastOrder: order.id,
      }, { appliedOrder: order.id });
    } else {
      // Only the plan the order was quoted on is replaced; anything else is not overwritten.
      if (order.basis && order.basis !== basisOf(old, now)) return theirs(null);
      const fields = {
        plan: order.plan, period: order.period, status: 'active', periodStart: now, periodEnd: periodEnd(now, order.period), paidVnd: order.priceVnd,
        anchorAt: now, cancelAtEnd: false, nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null, lastOrder: order.id,
      };
      next = old
        ? await store.patchSubscription(order.userId, { seenEnd: old.periodEnd }, fields, { appliedOrder: order.id })
        : await store.createSubscription({ userId: order.userId, ...fields }, { appliedOrder: order.id });
    }
    if (next) return { sub: next, applied: true };
    // The write did not happen: either the row moved (look again) or the order was settled meanwhile (stop).
    const fresh = await store.getOrder(order.id);
    if (fresh?.status === 'refunded') return theirs(null);
    if (fresh?.appliedAt) return theirs(await store.getSubscription(order.userId));
  }
  throw Object.assign(new Error('Your plan could not be updated right now. Please try again.'), { status: 503 });
}

/** Change the row we read, unless somebody else moved it meanwhile (then theirs stands, and `mine` is false). */
async function transition(before, patch) {
  const store = getStore();
  const changed = await store.patchSubscription(before.userId, { seenEnd: before.periodEnd, seenStatus: before.status }, patch);
  return changed ? { sub: changed, mine: true } : { sub: await store.getSubscription(before.userId), mine: false };
}

async function liveOrRefuse(userId, now) {
  const sub = await getStore().getSubscription(userId);
  if (!isLive(sub, now)) throw Object.assign(new Error('You have no plan to change.'), { status: 422 });
  return sub;
}

/** A downgrade (or year to month) waits for the period end: it is recorded here and applied by the renewal. */
export async function scheduleChange(userId, { plan, period }, { now = new Date() } = {}) {
  if (!isPaidPlan(plan)) throw Object.assign(new Error('That plan is not available.'), { status: 422 });
  if (!isPeriod(period)) throw Object.assign(new Error('Choose a monthly or a yearly plan.'), { status: 422 });
  const sub = await liveOrRefuse(userId, now);
  if (moveKind(sub, plan, period) === 'upgrade') {
    throw Object.assign(new Error('That is an upgrade, so it is paid for now instead of scheduled.'), { status: 422 });
  }
  if ((await findRenewalOrder(sub))?.status === 'paid') {
    throw Object.assign(new Error('The next period is already paid for, so a change can only be made once it has started.'), { status: 422 });
  }
  const same = plan === sub.plan && period === sub.period;
  // The reminder and its order were made for the old terms; a fresh one is made for the new. Only the period we
  // looked at is changed: a renewal that moved it meanwhile wins, and this is asked again.
  const next = await getStore().patchSubscription(userId, { seenEnd: sub.periodEnd }, {
    nextPlan: same ? null : plan, nextPeriod: same ? null : period, remindedAt: null, renewalOrder: null,
  });
  if (!next) throw Object.assign(new Error('Your plan changed while you were choosing. Please look again.'), { status: 422 });
  return next;
}

export async function setAutoRenew(userId, on, { now = new Date() } = {}) {
  await liveOrRefuse(userId, now);
  return getStore().patchSubscription(userId, {}, { autoRenew: !!on });
}

export async function setCancelAtEnd(userId, on, { now = new Date() } = {}) {
  await liveOrRefuse(userId, now);
  return getStore().patchSubscription(userId, {}, { cancelAtEnd: !!on });
}

/**
 * Renew from the balance if it covers the price: the renewed subscription, with `paid` the order when this call's own statement
 * took the money (null when a concurrent caller did), or null when it did not happen.
 */
async function renewFromBalance(sub, now) {
  const store = getStore();
  try {
    let order = await findRenewalOrder(sub);
    // A price already fixed by a reminder stays; otherwise today's rate prices it.
    const total = order ? order.totalVnd : (await renewalTerms(sub, { now })).priceVnd;
    if ((await store.billingState(sub.userId)).balanceVnd < total) return null;
    order ??= (await renewalOrderFor(sub, { now })).order;
    const { paid } = await applyOrder(order.id, { now, autoRenew: true });
    const cur = await store.getSubscription(sub.userId);
    return cur && +cur.periodEnd !== +sub.periodEnd ? { sub: cur, paid } : null;
  } catch (err) {
    // No rate to price the renewal with: the plan stays in grace instead of ending early over a
    // rate source being down. It is retried on the next call.
    if (err instanceof BillingUnavailable) return null;
    throw err;
  }
}

/**
 * The subscription in force after doing what is due for this account (lazy, idempotent, safe to call on
 * every request). A renewal that was paid (early, or whose activation never finished) starts at the end whatever
 * auto-renew says (settleUnapplied); otherwise cancel-at-end or three days of grace gone means ended; otherwise renewed from the
 * balance when it can be, else grace.
 */
export async function catchUp(userId, { now = new Date() } = {}) {
  return (await catchUpChanges(userId, { now })).sub;
}

/**
 * @typedef {{ kind: 'renewed'|'grace'|'ended', from: Date, sub: any, paid: any }} PlanChange
 *   `from` is the period end the plan moved on from (it names the mail); `paid` is the renewal order when this call took its money.
 */

/**
 * `catchUp`, and what its own statements changed, for the account to be told (tell.js). Taken from the statements, not from a look
 * before and after, so a caller that only saw somebody else's change reports nothing, and the one that made it reports it wherever it
 * ran: the daily job, a billing page, or a metered call that met the period's end first.
 *
 * @returns {Promise<{ sub: any, changes: PlanChange[] }>}
 */
export async function catchUpChanges(userId, { now = new Date() } = {}) {
  /** @type {PlanChange[]} */
  const changes = [];
  // Paid orders that were never started are started now (or refunded) before anything else is decided.
  for (const started of await settleUnapplied(userId, { now })) {
    if (started.applied && started.order.kind === 'renewal') changes.push({ kind: 'renewed', from: started.sub.periodStart, sub: started.sub, paid: null });
  }
  const sub = await getStore().getSubscription(userId);
  if (!sub || sub.status === 'ended' || now < sub.periodEnd) return { sub, changes };
  if (sub.cancelAtEnd || now >= addDays(sub.periodEnd, GRACE_DAYS)) return moved(sub, 'ended', changes);
  if (sub.autoRenew) {
    const renewed = await renewFromBalance(sub, now);
    if (renewed) {
      // Two callers at once: only the one whose payment took the money has it to tell.
      if (renewed.paid) changes.push({ kind: 'renewed', from: sub.periodEnd, sub: renewed.sub, paid: renewed.paid });
      return { sub: renewed.sub, changes };
    }
  }
  return sub.status === 'grace' ? { sub, changes } : moved(sub, 'grace', changes);
}

async function moved(sub, status, changes) {
  const { sub: after, mine } = await transition(sub, { status });
  if (mine) changes.push({ kind: /** @type {'grace'|'ended'} */ (status), from: sub.periodEnd, sub: after, paid: null });
  return { sub: after, changes };
}

/** The plan an account has right now, as the allowances and the page read it. Pure: it writes nothing. */
export async function planInForce(userId, { now = new Date() } = {}) {
  const sub = await getStore().getSubscription(userId);
  // A plan set to end is free from its end, before any catch-up has written it down.
  let over = !!sub && sub.cancelAtEnd && now >= sub.periodEnd;
  // ...unless the next period was paid before it was cancelled: that one starts at the end, and counts until catchUp says so.
  if (over && (await paidRenewalFor(sub))) over = false;
  if (!isLive(sub, now) || over) return { plan: 'free', period: null, status: sub ? 'ended' : 'none', start: null, end: null, month: null };
  // In grace the allowance month is still the last one paid for, not a new one.
  const at = now < sub.periodEnd ? now : new Date(sub.periodEnd.getTime() - 1);
  return {
    plan: sub.plan, period: sub.period, status: now < sub.periodEnd ? sub.status : 'grace',
    start: sub.periodStart, end: sub.periodEnd, month: monthWindow(sub.anchorAt ?? sub.periodStart, at),
  };
}

/**
 * Renewals three days from their end whose balance will not cover them: a renewal order is made (once per period)
 * and handed back so the caller can send the mail. A subscription that is reminded is marked, so asking again
 * returns nothing new. One account failing never stops the others.
 *
 * @returns {Promise<Array<{ userId: string, order: object }>>}
 */
export async function remindersDue(now = new Date()) {
  const store = getStore();
  const out = [];
  for (const sub of await store.listSubscriptionsToWork(now)) {
    if (sub.remindedAt || !sub.autoRenew || sub.cancelAtEnd) continue;
    if (addDays(sub.periodEnd, -REMIND_DAYS) > now || now >= addDays(sub.periodEnd, GRACE_DAYS)) continue;
    try {
      const existing = await findRenewalOrder(sub);
      if (existing?.status === 'paid') continue;
      const price = existing ? existing.totalVnd : (await renewalTerms(sub, { now })).priceVnd;
      if ((await store.billingState(sub.userId)).balanceVnd >= price) continue;
      const { order } = await renewalOrderFor(sub, { now });
      const saved = await store.patchSubscription(sub.userId, { seenEnd: sub.periodEnd, seenStatus: sub.status }, { remindedAt: now, renewalOrder: order.id });
      if (saved) out.push({ userId: sub.userId, order });
    } catch (err) {
      // No rate today, or this one account's rows are in a state we cannot read: the others still get theirs,
      // and this one is tried again on the next pass.
      log.warn('a renewal reminder could not be made', { user: sub.userId, error: String(err?.message || err).slice(0, 160) });
    }
  }
  return out;
}
