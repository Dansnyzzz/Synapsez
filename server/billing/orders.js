/**
 * Quotes and orders (owner, 2026-11-12/13). An order locks the rate and the price for 30 minutes so
 * the number on the QR is the number that is charged. Every order is paid the same way: from the
 * balance, with `payOrderFromBalance` (a bank transfer is credited to the balance first, then the
 * order is applied), so the money and the plan can never disagree. A top-up order is the exception
 * that proves it: it is just a code and an amount for a transfer to carry, and the transfer itself is
 * what credits the balance.
 */
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { PLANS, TOPUP, ORDER_TTL_MS, GRACE_DAYS, isPaidPlan, isPeriod, planVnd } from './plans.js';
import { newPaymentCode } from './codes.js';
import { addDays, prorate, periodEnd, renewalEnd } from './period.js';
import { usdVnd, BillingUnavailable } from './fx.js';
import { activate, applyPaidOrder, basisOf, isLive, moveKind, planInForce } from './subscriptions.js';
import { forgetBillable } from './billable.js';

const dong = (n) => Number(n).toLocaleString('en-US');

/**
 * Whether buying these terms now is the renewal of the plan in grace: the plan has ended, is not being cancelled, and these are the
 * terms its renewal would be made on (the scheduled change if there is one, else what ran). Anything else in grace is a change.
 */
export function isRenewalTerms(sub, plan, period, now) {
  return isLive(sub, now) && now >= sub.periodEnd && !sub.cancelAtEnd && plan === (sub.nextPlan ?? sub.plan) && period === (sub.nextPeriod ?? sub.period);
}

/**
 * What a plan would cost this account now, and what it changes. `later` is a downgrade or year to month:
 * nothing is charged, it waits for the period end. `renewal` is what a plan in grace buys to carry on (see isRenewalTerms).
 *
 * A renewal order that already exists (a reminder makes one) has its price and rate locked, so for it the quote returns that order's
 * own price, total and rate (no exchange rate is needed to read it), `useBalance` (what the order decided: the checkout's checkbox cannot
 * change it) and `dueVnd`, the amount its QR will ask for (total less what already arrived). For anything else those last two are null.
 * `rateAt` is when the rate used was read, or, for a locked order, when the order (and so its rate) was made.
 * `renewsAt` is when the period this would start ends, so the checkout can say the day the plan renews (null for `later`: nothing starts now).
 */
export async function quote(userId, { plan, period }, { now = new Date() } = {}) {
  if (!isPaidPlan(plan)) throw Object.assign(new Error('That plan is not available.'), { status: 422 });
  if (!isPeriod(period)) throw Object.assign(new Error('Choose a monthly or a yearly plan.'), { status: 422 });
  const store = getStore();
  const state = await store.billingState(userId);
  const sub = state.subscription;
  /** The renewal order that already exists, whose price was locked when it was made: null when there is none (or it is not a renewal). */
  let open = null;
  const renewing = isRenewalTerms(sub, plan, period, now);
  if (renewing) {
    // A reminder may have made the order already, at the rate of that day: the checkout must show what the QR will ask for.
    open = (await store.renewalOrdersFor(userId, addDays(sub.periodEnd, GRACE_DAYS))).find((o) => o.status === 'pending' && o.plan === plan && o.period === period) ?? null;
  }
  let rate = null;
  try {
    rate = await usdVnd({ now });
  } catch (err) {
    // A locked order needs no rate to be read; everything else does.
    if (!(err instanceof BillingUnavailable) || !open) throw err;
  }
  const priceVnd = open ? open.priceVnd : planVnd(plan, period, rate.rate);
  let kind = 'new';
  let creditVnd = 0;
  if (isLive(sub, now)) {
    // In grace, the terms the plan would renew on (the scheduled change if there is one, else what ran) are the renewal itself, not
    // "changed at renewal": createOrder makes it the period's one shared renewal order. Any other plan in grace is a change.
    kind = renewing ? 'renewal' : moveKind(sub, plan, period);
    // Never more credit than the price: the unused part of a dearer plan is not paid out.
    if (kind === 'upgrade') creditVnd = Math.min(priceVnd, prorate(sub.paidVnd, sub.periodStart, sub.periodEnd, now));
  }
  const used = open ? { rate: open.rate, source: open.rateSource, at: open.createdAt.toISOString() } : { rate: rate.rate, source: rate.source, at: rate.at };
  return {
    kind, plan, period, priceVnd, creditVnd, totalVnd: kind === 'later' ? 0 : priceVnd - creditVnd,
    rate: used.rate, rateSource: used.source, rateAt: used.at, balanceVnd: state.balanceVnd,
    // What the order that exists already decided (the checkbox cannot change an order that is made), and what its QR will ask for.
    useBalance: open ? open.useBalance : null,
    dueVnd: open ? dueOf(open, state.balanceVnd) : null,
    startsAt: (kind === 'later' ? sub.periodEnd : now).toISOString(), basis: basisOf(sub, now),
    // A renewal continues the old period (as applyPaidOrder will); anything else starts a new one today.
    // What the plan will do after this order is paid: a new subscription renews by default, an existing row keeps its own switch (paying never turns it on).
    autoRenew: sub ? sub.autoRenew : true,
    renewsAt: kind === 'later' ? null : (kind === 'renewal' ? renewalEnd(sub.anchorAt ?? sub.periodStart, sub.periodEnd, period) : periodEnd(now, period)).toISOString(),
  };
}

/** Đồng still to be transferred for an order. */
export const dueOf = (order, balanceVnd) => Math.max(0, order.totalVnd - (order.useBalance ? balanceVnd : order.receivedVnd));

/** The QR a bank app reads, and what to type if it cannot. The bank details come only from the environment. */
export function qrFor(order, dueVnd, env = process.env) {
  const account = String(env.SEPAY_BANK_ACCOUNT || '').trim();
  const bank = String(env.SEPAY_BANK_CODE || '').trim();
  if (!account || !bank) throw new BillingUnavailable('Bank transfer is not set up yet, so this cannot be paid by transfer.');
  const enc = encodeURIComponent;
  return {
    image: `https://qr.sepay.vn/img?acc=${enc(account)}&bank=${enc(bank)}&amount=${dueVnd}&des=${order.code}`,
    bank, account, holder: String(env.SEPAY_ACCOUNT_NAME || '').trim(), amount: dueVnd, content: order.code,
  };
}

/** Insert an order under a fresh payment code (a clash on the code is retried). */
async function insert(draft) {
  const store = getStore();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await store.createOrder({ id: crypto.randomUUID(), ...draft, code: newPaymentCode() });
    } catch (err) {
      if (err?.code !== '23505') throw err;
    }
  }
  throw Object.assign(new Error('The order could not be created. Please try again.'), { status: 503 });
}

/** The terms a renewal would be made on: what the plan is to become, at today's rate. */
export async function renewalTerms(sub, { now = new Date() } = {}) {
  const plan = sub.nextPlan ?? sub.plan;
  const period = sub.nextPeriod ?? sub.period;
  const rate = await usdVnd({ now });
  return { plan, period, rate, priceVnd: planVnd(plan, period, rate.rate) };
}

/**
 * The renewal order for this period: a paid one (whatever it was paid for), else the pending one, else null. There is
 * at most one live renewal per account and period (a unique index on user and grace end), which is what makes two
 * callers that both want the renewal reach the same row, so it is paid once. A pending one made for terms that have
 * since changed (a scheduled downgrade) is closed, and the next ask makes a fresh one.
 */
export async function findRenewalOrder(sub) {
  const store = getStore();
  const rows = await store.renewalOrdersFor(sub.userId, addDays(sub.periodEnd, GRACE_DAYS));
  const paid = rows.find((o) => o.status === 'paid');
  if (paid) return paid;
  const plan = sub.nextPlan ?? sub.plan;
  const period = sub.nextPeriod ?? sub.period;
  for (const o of rows) {
    if (o.plan === plan && o.period === period) return o;
    await store.cancelOrder(o.id, o.userId);
  }
  return null;
}

/** Whether this period's renewal is paid. Read-only (findRenewalOrder also closes pending orders made for other terms). */
export async function paidRenewalFor(sub) {
  return (await getStore().renewalOrdersFor(sub.userId, addDays(sub.periodEnd, GRACE_DAYS))).find((o) => o.status === 'paid') ?? null;
}

/** Make (or find) the renewal order. It lasts until grace ends. `created` says whether this call made it. */
export async function renewalOrderFor(sub, { now = new Date(), useBalance = true } = {}) {
  const store = getStore();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const found = await findRenewalOrder(sub);
    if (found) return { order: found, created: false };
    const { plan, period, rate, priceVnd } = await renewalTerms(sub, { now });
    try {
      const order = await store.createOrder({
        id: crypto.randomUUID(), code: newPaymentCode(), userId: sub.userId, kind: 'renewal', plan, period, usdCents: PLANS[plan].usdCents[period],
        rate: rate.rate, rateSource: rate.source, priceVnd, creditVnd: 0, totalVnd: priceVnd, useBalance, expiresAt: addDays(sub.periodEnd, GRACE_DAYS),
        // The period it continues: an upgrade quoted on the same period shares this basis, so only one of them can ever be paid.
        basis: `${sub.plan}|${sub.period}|${sub.periodEnd.getTime()}`,
      });
      return { order, created: true };
    } catch (err) {
      // Either somebody made the renewal first (found on the next turn) or the code clashed (a new one is drawn).
      if (err?.code !== '23505') throw err;
    }
  }
  throw Object.assign(new Error('This renewal could not be prepared. Please try again.'), { status: 503 });
}

/** A renewal order is only good for the terms it was made on: the plan has not moved on, or been cancelled. */
function renewalStillWanted(order, sub) {
  return !!sub && sub.status !== 'ended' && !sub.cancelAtEnd && order.plan === (sub.nextPlan ?? sub.plan)
    && order.period === (sub.nextPeriod ?? sub.period) && +order.expiresAt === +addDays(sub.periodEnd, GRACE_DAYS);
}

/** Close a plan order whose quote no longer holds. The money stays in the balance. */
const refuseStale = (order) => getStore().cancelOrder(order.id, order.userId).then(() => null);

/**
 * Start every paid order of the account whose plan has not started (the process died between paying and starting, or a renewal
 * paid early has reached its end), and refund the ones that can no longer be started: the paid order's money goes back to the
 * balance in one statement, so it never stays without its plan. A renewal paid early is left alone until its period ends.
 * Returns the orders that are started now, each with its subscription and `applied`: whether this call's own statement started
 * it (a caller at the same moment may have, and then it is theirs to tell).
 *
 * @returns {Promise<Array<{ order: any, sub: any, applied: boolean }>>}
 */
export async function settleUnapplied(userId, { now = new Date() } = {}) {
  const store = getStore();
  const started = [];
  for (const order of await store.unappliedOrders(userId)) {
    const { sub, applied } = await applyPaidOrder(order, { now });
    if (sub === null) {
      // Money back in the balance makes the account billable now, not when the 30-second answer runs out.
      if (await store.refundOrder(order.id)) forgetBillable(order.userId);
    }
    else if (sub.lastOrder === order.id) started.push({ order, sub, applied });
  }
  return started;
}

/** A paid order: nothing to do when it was applied, else apply it (or refund it) now. */
async function mend(order, sub, now) {
  if (order.appliedAt || sub?.lastOrder === order.id) return sub;
  await settleUnapplied(order.userId, { now });
  return getStore().getSubscription(order.userId);
}

/**
 * The one door that pays an order and starts what it bought: the balance pays it (or nothing happens),
 * then the plan is activated. Safe to call again and again, and after every credit: a paid order changes
 * nothing (or is started, or refunded, if that never finished), an order the balance cannot yet cover stays pending.
 * An order is paid only while the plan it is based on is still the plan in force; when two orders based on the same plan
 * are paid at once, the unique index on paid (user, basis) makes the second payment fail whole, nothing leaves the balance, and
 * that order is closed as stale. Returns the subscription it started or changed, or null (it never throws for a stale order).
 */
export async function tryApply(orderId, options = {}) {
  return (await applyOrder(orderId, options)).sub;
}

/**
 * `tryApply`, and `paid`: the order when this call's own statement took the money and its plan stands (null when it was paid
 * before, by somebody else, or not at all). The one that paid is the one that writes the paid line and tells the account.
 *
 * @returns {Promise<{ sub: any, paid: any }>}
 */
export async function applyOrder(orderId, { now = new Date(), autoRenew = false } = {}) {
  const store = getStore();
  const none = { sub: null, paid: null };
  const stale = async (o) => {
    await refuseStale(o);
    return none;
  };
  const order = await store.getOrder(orderId);
  if (!order || order.kind === 'topup') return none;
  const sub = await store.getSubscription(order.userId);
  if (order.status === 'paid') return { sub: await mend(order, sub, now), paid: null };
  if (order.status !== 'pending') return none;
  if (order.kind === 'renewal' && !renewalStillWanted(order, sub)) return stale(order);
  if (order.basis && order.basis !== basisOf(sub, now)) return stale(order);
  let paid;
  try {
    // Auto-renew on is consent to pay this subscription's own renewal from the balance, whatever the order's checkbox said when it was made
    // (otherwise a plan with the money in the balance would end in grace). Only a renewal that is still wanted, for this subscription.
    const consent = autoRenew && order.kind === 'renewal' && !!sub?.autoRenew;
    paid = await store.payOrderFromBalance(order.id, now, { consent });
  } catch (err) {
    if (err?.code === '23505') return stale(order);
    throw err;
  }
  if (!paid) {
    // Short balance or a lapsed order leaves it pending; a plan that moved between the check above and the debit
    // is refused by the payment itself, and the order is closed here.
    const again = await store.getOrder(order.id);
    if (again?.status === 'pending' && again.basis && again.basis !== basisOf(await store.getSubscription(order.userId), now)) return stale(again);
    return none;
  }
  if (paid.kind === 'plan') await store.cancelPendingPlanOrders(paid.userId, paid.id);
  const started = await activate(paid, { now });
  if (started === null) {
    // Paid and given straight back: the balance is as it was, so there is nothing to tell.
    if (await store.refundOrder(paid.id)) forgetBillable(paid.userId);
    return none;
  }
  return { sub: started, paid };
}

/**
 * Before a plan order is asked for: finish what an earlier try left (a paid order that never started is started, so asking
 * again is not paying again), and refuse a change while the next period is already paid for.
 */
async function beforePlanOrder(userId, input, now) {
  const started = await settleUnapplied(userId, { now });
  const same = started.find(({ order: o }) => o.kind === 'plan' && o.plan === input.plan && o.period === input.period);
  if (same) return same.order;
  const sub = await getStore().getSubscription(userId);
  if (isLive(sub, now) && (await findRenewalOrder(sub))?.status === 'paid') {
    throw Object.assign(new Error('Your renewal is already paid — you can change plan when it starts.'), { status: 422 });
  }
  return null;
}

async function draftOf(userId, kind, input, now) {
  const { plan, period, amountVnd, useBalance } = input;
  if (kind === 'plan') {
    const q = await quote(userId, { plan, period }, { now });
    if (q.kind === 'later') throw Object.assign(new Error('That change takes effect when the current period ends, so it is scheduled instead of paid for now.'), { status: 422 });
    return {
      kind, plan, period, usdCents: PLANS[plan].usdCents[period], rate: q.rate, rateSource: q.rateSource, priceVnd: q.priceVnd,
      creditVnd: q.creditVnd, totalVnd: q.totalVnd, useBalance, basis: q.basis, expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
    };
  }
  if (!Number.isSafeInteger(amountVnd)) throw Object.assign(new Error('Enter the amount in whole đồng.'), { status: 422 });
  const withPlan = (await planInForce(userId, { now })).plan !== 'free';
  const min = withPlan ? TOPUP.minWithPlan : TOPUP.minNoPlan;
  const max = withPlan ? TOPUP.maxBalanceWithPlan : TOPUP.maxBalanceNoPlan;
  if (amountVnd < min) throw Object.assign(new Error(`The smallest top-up is ${dong(min)}đ.`), { status: 422 });
  const store = getStore();
  const { balanceVnd } = await store.billingState(userId);
  // QRs already open count: four of them paid at once must not carry the balance past the cap.
  const open = (await store.listOrders({ userId, status: 'pending', limit: 200 })).filter((o) => o.kind === 'topup' && o.expiresAt > now).reduce((sum, o) => sum + o.totalVnd, 0);
  if (balanceVnd + open + amountVnd > max) throw Object.assign(new Error(`A top-up cannot take your balance past ${dong(max)}đ.`), { status: 422 });
  // The transfer is what credits a top-up, so the balance never pays for it.
  return { kind, priceVnd: amountVnd, creditVnd: 0, totalVnd: amountVnd, useBalance: false, expiresAt: new Date(now.getTime() + ORDER_TTL_MS) };
}

/**
 * Ask for a payment: a plan (new or upgrade), a renewal, or a top-up. With a balance that covers it, a plan
 * or renewal is paid and started at once (`paidNow`); otherwise `due` is what to transfer, with the QR.
 *
 * @returns {Promise<{ order: object, paidNow: boolean, due: { vnd: number, qr: object } | null }>}
 */
export async function createOrder(userId, input, { now = new Date(), simulated = false, env = process.env } = {}) {
  const store = getStore();
  let { kind } = input;
  // In grace, buying the same terms again is the renewal (it continues from the old end and shares the period's one renewal order),
  // not a new plan from today: decided here, once, for every caller.
  if (kind === 'plan' && isRenewalTerms(await store.getSubscription(userId), input.plan, input.period, now)) kind = 'renewal';
  if (kind !== 'plan' && kind !== 'topup' && kind !== 'renewal') throw Object.assign(new Error('Choose what to pay for.'), { status: 422 });
  let order;
  let created = true;
  if (kind === 'renewal') {
    const sub = await store.getSubscription(userId);
    if (!isLive(sub, now)) throw Object.assign(new Error('You have no plan to renew.'), { status: 422 });
    if (sub.cancelAtEnd) throw Object.assign(new Error('This plan is set to end at the period end. Turn that off to renew it.'), { status: 422 });
    ({ order, created } = await renewalOrderFor(sub, { now, useBalance: input.useBalance !== false }));
    if (order.status === 'paid') throw Object.assign(new Error('This renewal is already paid.'), { status: 422 });
  } else {
    const prior = kind === 'plan' ? await beforePlanOrder(userId, input, now) : null;
    if (prior) return { order: await store.getOrder(prior.id), paidNow: true, due: null };
    const draft = await draftOf(userId, kind, { ...input, useBalance: input.useBalance !== false }, now);
    // One open plan QR at a time: the older one would be quoted on a plan that this one is about to change.
    if (kind === 'plan') await store.cancelPendingPlanOrders(userId);
    order = await insert({ userId, ...draft, simulated: !!simulated });
  }
  let balance = (await store.billingState(userId)).balanceVnd;
  if (order.useBalance && order.status === 'pending' && balance >= order.totalVnd) {
    await tryApply(order.id, { now });
    order = await store.getOrder(order.id);
    if (order.status === 'paid') return { order, paidNow: true, due: null };
    if (order.status === 'cancelled' || order.status === 'refunded') throw Object.assign(new Error('Prices changed since this order was made — get a new price.'), { status: 422 });
    balance = (await store.billingState(userId)).balanceVnd;
  }
  const vnd = order.status === 'pending' ? dueOf(order, balance) : 0;
  if (!vnd) return { order, paidNow: false, due: null };
  try {
    return { order, paidNow: false, due: { vnd, qr: qrFor(order, vnd, env) } };
  } catch (err) {
    // An order of ours that nobody can pay by transfer is not left lying about. A renewal is shared (a reminder
    // may have sent its price already) and lives until its grace ends, so it stays.
    if (created && kind !== 'renewal') await store.cancelOrder(order.id, userId);
    throw err;
  }
}
