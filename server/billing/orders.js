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
import { addDays, prorate } from './period.js';
import { usdVnd, BillingUnavailable } from './fx.js';
import { activate, basisOf, isLive, moveKind, planInForce } from './subscriptions.js';

const dong = (n) => Number(n).toLocaleString('en-US');

/**
 * What a plan would cost this account now, and what it changes. `later` is a downgrade or year to month:
 * nothing is charged, it waits for the period end.
 */
export async function quote(userId, { plan, period }, { now = new Date() } = {}) {
  if (!isPaidPlan(plan)) throw Object.assign(new Error('That plan is not available.'), { status: 422 });
  if (!isPeriod(period)) throw Object.assign(new Error('Choose a monthly or a yearly plan.'), { status: 422 });
  const [rate, state] = await Promise.all([usdVnd({ now }), getStore().billingState(userId)]);
  const priceVnd = planVnd(plan, period, rate.rate);
  const sub = state.subscription;
  let kind = 'new';
  let creditVnd = 0;
  if (isLive(sub, now)) {
    kind = moveKind(sub, plan, period);
    // Never more credit than the price: the unused part of a dearer plan is not paid out.
    if (kind === 'upgrade') creditVnd = Math.min(priceVnd, prorate(sub.paidVnd, sub.periodStart, sub.periodEnd, now));
  }
  return {
    kind, plan, period, priceVnd, creditVnd, totalVnd: kind === 'later' ? 0 : priceVnd - creditVnd,
    rate: rate.rate, rateSource: rate.source, rateAt: rate.at, balanceVnd: state.balanceVnd,
    startsAt: (kind === 'later' ? sub.periodEnd : now).toISOString(), basis: basisOf(sub, now),
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
 * A plan order that was paid but whose plan never started (the process died between the two) is started now, once:
 * only while the plan is still the one it was quoted on and it is the account's latest paid order.
 */
async function mend(order, sub, now) {
  if (sub?.lastOrder === order.id) return sub;
  if (order.kind === 'renewal') return sub ? activate(order, { now }) : null;
  if (order.basis && order.basis === basisOf(sub, now)) {
    const latest = (await getStore().listOrders({ userId: order.userId, status: 'paid', limit: 10 })).find((o) => o.kind === 'plan' || o.kind === 'renewal');
    if (latest?.id === order.id) return activate(order, { now });
  }
  return sub;
}

/**
 * The one door that pays an order and starts what it bought: the balance pays it (or nothing happens),
 * then the plan is activated. Safe to call again and again, and after every credit: a paid order changes
 * nothing (or mends an activation that never finished), an order the balance cannot yet cover stays pending.
 * A plan order is paid only while the plan it was quoted on is still the plan in force. Returns the
 * subscription it started or changed, or null.
 */
export async function tryApply(orderId, { now = new Date() } = {}) {
  const store = getStore();
  const order = await store.getOrder(orderId);
  if (!order || order.kind === 'topup') return null;
  const sub = await store.getSubscription(order.userId);
  if (order.status === 'paid') return mend(order, sub, now);
  if (order.status !== 'pending') return null;
  if (order.kind === 'renewal' ? !renewalStillWanted(order, sub) : order.basis && order.basis !== basisOf(sub, now)) return refuseStale(order);
  const paid = await store.payOrderFromBalance(order.id, now);
  if (!paid) {
    // Short balance or a lapsed order leaves it pending; a plan that moved between the check above and the debit
    // is refused by the payment itself, and the order is closed here.
    const again = await store.getOrder(order.id);
    if (again?.status === 'pending' && again.kind === 'plan' && again.basis && again.basis !== basisOf(await store.getSubscription(order.userId), now)) return refuseStale(again);
    return null;
  }
  if (paid.kind === 'plan') await store.cancelPendingPlanOrders(paid.userId, paid.id);
  return activate(paid, { now });
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
  const { kind } = input;
  if (kind !== 'plan' && kind !== 'topup' && kind !== 'renewal') throw Object.assign(new Error('Choose what to pay for.'), { status: 422 });
  let order;
  let created = true;
  if (kind === 'renewal') {
    const sub = await store.getSubscription(userId);
    if (!isLive(sub, now)) throw Object.assign(new Error('You have no plan to renew.'), { status: 422 });
    if (sub.cancelAtEnd) throw Object.assign(new Error('This plan is set to end at the period end. Turn that off to renew it.'), { status: 422 });
    ({ order, created } = await renewalOrderFor(sub, { now, useBalance: input.useBalance !== false }));
  } else {
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
    if (order.status === 'cancelled') throw Object.assign(new Error('Prices changed since this order was made — get a new price.'), { status: 422 });
    balance = (await store.billingState(userId)).balanceVnd;
  }
  const vnd = dueOf(order, balance);
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
