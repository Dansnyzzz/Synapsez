/**
 * The plan's life (owner, 2026-11-12/13). A plan is a period paid in advance. At its end it renews
 * from the balance when auto-renew is on and the balance covers it; otherwise there are three days of
 * grace (the plan still counts, and a payment in grace continues from the old end, not from the
 * day it was paid); after that it ends and the account is free. Unpaid grace days are not charged.
 *
 * Nothing here runs on a timer. `catchUp` does what is due for one account when it is next looked at,
 * and the cron route calls it for every account that is near an end, so both places reach the same
 * answer and neither depends on a process staying alive. It is idempotent: every money step goes
 * through one renewal order per period (see orders.js), so two calls at once pay once.
 */
import { getStore } from '../store/index.js';
import { RANK, isPaidPlan, isPeriod, GRACE_DAYS, REMIND_DAYS } from './plans.js';
import { periodEnd, addDays, monthWindow } from './period.js';
import { BillingUnavailable } from './fx.js';
import { findRenewalOrder, renewalOrderFor, renewalTerms, tryApply } from './orders.js';

/** Whether a stored subscription still counts at `now`: not ended, and not past its grace. */
export const isLive = (sub, now) => !!sub && sub.status !== 'ended' && now < addDays(sub.periodEnd, GRACE_DAYS);

/**
 * Start or continue a plan because its order was paid. A new plan or an upgrade starts a period now; a
 * renewal continues from the old end. A renewal is idempotent by construction: it is computed from the
 * old end alone, and a second call finds the period already moved and changes nothing.
 */
export async function activate(order, { now = new Date() } = {}) {
  const store = getStore();
  const old = await store.getSubscription(order.userId);
  if (order.kind === 'renewal' && old && old.status !== 'ended') {
    if (+addDays(old.periodEnd, GRACE_DAYS) !== +order.expiresAt) return old;
    const start = old.periodEnd;
    return store.saveSubscription({
      ...old, plan: order.plan, period: order.period, status: 'active', periodStart: start, periodEnd: periodEnd(start, order.period),
      paidVnd: order.totalVnd, nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null,
    });
  }
  return store.saveSubscription({
    userId: order.userId, plan: order.plan, period: order.period, status: 'active', periodStart: now, periodEnd: periodEnd(now, order.period),
    paidVnd: order.priceVnd - order.creditVnd, autoRenew: old?.autoRenew ?? true, cancelAtEnd: false,
    nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null,
  });
}

/** Save a change to the row we read, unless somebody else moved it meanwhile (then theirs stands). */
async function settle(before, patch) {
  const store = getStore();
  const cur = await store.getSubscription(before.userId);
  if (!cur || +cur.periodEnd !== +before.periodEnd || cur.plan !== before.plan || cur.status !== before.status) return cur;
  return store.saveSubscription({ ...cur, ...patch });
}

const refuseNoPlan = () => Object.assign(new Error('You have no plan to change.'), { status: 422 });

async function liveOrRefuse(userId, now = new Date()) {
  const sub = await getStore().getSubscription(userId);
  if (!isLive(sub, now)) throw refuseNoPlan();
  return sub;
}

/** A downgrade (or year to month) waits for the period end: it is recorded here and applied by the renewal. */
export async function scheduleChange(userId, { plan, period }, { now = new Date() } = {}) {
  if (!isPaidPlan(plan)) throw Object.assign(new Error('That plan is not available.'), { status: 422 });
  if (!isPeriod(period)) throw Object.assign(new Error('Choose a monthly or a yearly plan.'), { status: 422 });
  const sub = await liveOrRefuse(userId, now);
  if (RANK[plan] > RANK[sub.plan] || (plan === sub.plan && period === 'year' && sub.period === 'month')) {
    throw Object.assign(new Error('That is an upgrade, so it is paid for now instead of scheduled.'), { status: 422 });
  }
  const same = plan === sub.plan && period === sub.period;
  // The reminder and its order were made for the old terms; a fresh one is made for the new.
  return getStore().saveSubscription({
    ...sub, nextPlan: same ? null : plan, nextPeriod: same ? null : period, remindedAt: null, renewalOrder: null,
  });
}

export async function setAutoRenew(userId, on, { now = new Date() } = {}) {
  const sub = await liveOrRefuse(userId, now);
  return getStore().saveSubscription({ ...sub, autoRenew: !!on });
}

export async function setCancelAtEnd(userId, on, { now = new Date() } = {}) {
  const sub = await liveOrRefuse(userId, now);
  return getStore().saveSubscription({ ...sub, cancelAtEnd: !!on });
}

/** Renew from the balance if it covers the price; the renewal subscription, or null when it did not happen. */
async function renewFromBalance(sub, now) {
  const store = getStore();
  try {
    let order = await findRenewalOrder(sub);
    if (order?.status === 'paid') return activate(order, { now });
    // A price already fixed by a reminder stays; otherwise today's rate prices it.
    const total = order ? order.totalVnd : (await renewalTerms(sub, { now })).priceVnd;
    if ((await store.billingState(sub.userId)).balanceVnd < total) return null;
    order ??= (await renewalOrderFor(sub, { now })).order;
    await tryApply(order.id, { now });
    const cur = await store.getSubscription(sub.userId);
    return cur && +cur.periodEnd !== +sub.periodEnd ? cur : null;
  } catch (err) {
    // No rate to price the renewal with: the plan stays in grace instead of ending early over a
    // rate source being down. It is retried on the next call.
    if (err instanceof BillingUnavailable) return null;
    throw err;
  }
}

/**
 * The subscription in force after doing what is due for this account (lazy, idempotent, safe to call on
 * every request): cancel-at-end or three days of grace gone means ended; otherwise renewed from the
 * balance when it can be, else grace.
 */
export async function catchUp(userId, { now = new Date() } = {}) {
  const sub = await getStore().getSubscription(userId);
  if (!sub || sub.status === 'ended' || now < sub.periodEnd) return sub;
  if (sub.cancelAtEnd || now >= addDays(sub.periodEnd, GRACE_DAYS)) return settle(sub, { status: 'ended' });
  if (sub.autoRenew) {
    const renewed = await renewFromBalance(sub, now);
    if (renewed) return renewed;
  }
  return sub.status === 'grace' ? sub : settle(sub, { status: 'grace' });
}

/** The plan an account has right now, as the allowances and the page read it. Pure: it writes nothing. */
export async function planInForce(userId, { now = new Date() } = {}) {
  const sub = await getStore().getSubscription(userId);
  if (!isLive(sub, now)) return { plan: 'free', period: null, status: sub ? 'ended' : 'none', start: null, end: null, month: null };
  // In grace the allowance month is still the last one paid for, not a new one.
  const at = now < sub.periodEnd ? now : new Date(sub.periodEnd.getTime() - 1);
  return {
    plan: sub.plan, period: sub.period, status: now < sub.periodEnd ? sub.status : 'grace',
    start: sub.periodStart, end: sub.periodEnd, month: monthWindow(sub.periodStart, at),
  };
}

/**
 * Renewals three days from their end whose balance will not cover them: a renewal order is made (once; the
 * order id is fixed by the period) and handed back so the caller can send the mail. A subscription that is
 * reminded is marked, so asking again returns nothing new.
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
      const price = existing ? existing.totalVnd : (await renewalTerms(sub, { now })).priceVnd;
      if ((await store.billingState(sub.userId)).balanceVnd >= price) continue;
      const { order } = await renewalOrderFor(sub, { now });
      const saved = await settle(sub, { remindedAt: now, renewalOrder: order.id });
      if (saved?.renewalOrder === order.id) out.push({ userId: sub.userId, order });
    } catch (err) {
      // No rate today: the reminder waits for tomorrow's pass.
      if (!(err instanceof BillingUnavailable)) throw err;
    }
  }
  return out;
}
