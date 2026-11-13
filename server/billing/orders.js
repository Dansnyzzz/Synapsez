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
import { PLANS, RANK, TOPUP, ORDER_TTL_MS, GRACE_DAYS, isPaidPlan, isPeriod, planVnd } from './plans.js';
import { newPaymentCode } from './codes.js';
import { addDays, prorate } from './period.js';
import { usdVnd, BillingUnavailable } from './fx.js';
import { activate, isLive, planInForce } from './subscriptions.js';

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
    const later = RANK[plan] < RANK[sub.plan] || (plan === sub.plan && (period === sub.period || (period === 'month' && sub.period === 'year')));
    kind = later ? 'later' : 'upgrade';
    // Never more credit than the price: the unused part of a dearer plan is not paid out.
    if (!later) creditVnd = Math.min(priceVnd, prorate(sub.paidVnd, sub.periodStart, sub.periodEnd, now));
  }
  return {
    kind, plan, period, priceVnd, creditVnd, totalVnd: kind === 'later' ? 0 : priceVnd - creditVnd,
    rate: rate.rate, rateSource: rate.source, rateAt: rate.at, balanceVnd: state.balanceVnd,
    startsAt: (kind === 'later' ? sub.periodEnd : now).toISOString(),
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

/**
 * Insert an order under a fresh payment code (a clash on the code is retried). Null when the draft's own
 * fixed id is taken, which is how two callers asking for the same renewal become one order.
 */
async function insert(draft) {
  const store = getStore();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await store.createOrder({ id: crypto.randomUUID(), ...draft, code: newPaymentCode() });
    } catch (err) {
      if (err?.code !== '23505') throw err;
      if (draft.id && (await store.getOrder(draft.id))) return null;
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
 * One renewal order per period and per terms, with an id fixed by them: two requests (or a reminder and a
 * catch-up) that both want the renewal reach the same row, so it can be paid once. An order that was
 * cancelled or expired is not reused; the next id in the family is.
 */
const renewalIds = (sub) => {
  const plan = sub.nextPlan ?? sub.plan;
  const period = sub.nextPeriod ?? sub.period;
  const base = `rn-${sub.userId}-${sub.periodEnd.getTime()}-${plan}-${period}`;
  return { plan, period, ids: [base, `${base}-1`, `${base}-2`] };
};

/** The renewal order that is waiting (pending) or has been paid for this period, or null. */
export async function findRenewalOrder(sub) {
  const store = getStore();
  for (const id of renewalIds(sub).ids) {
    const found = await store.getOrder(id);
    if (!found) return null;
    if (found.status === 'pending' || found.status === 'paid') return found;
  }
  return null;
}

/** Make (or find) the renewal order. It lasts until grace ends. `created` says whether this call made it. */
export async function renewalOrderFor(sub, { now = new Date(), useBalance = true } = {}) {
  const store = getStore();
  const { plan, period, ids } = renewalIds(sub);
  for (const id of ids) {
    const found = await store.getOrder(id);
    if (found) {
      if (found.status === 'pending' || found.status === 'paid') return { order: found, created: false };
      continue;
    }
    const { rate, priceVnd } = await renewalTerms(sub, { now });
    const made = await insert({
      id, userId: sub.userId, kind: 'renewal', plan, period, usdCents: PLANS[plan].usdCents[period], rate: rate.rate, rateSource: rate.source,
      priceVnd, creditVnd: 0, totalVnd: priceVnd, useBalance, expiresAt: addDays(sub.periodEnd, GRACE_DAYS),
    });
    if (made) return { order: made, created: true };
    const winner = await store.getOrder(id);
    if (winner && (winner.status === 'pending' || winner.status === 'paid')) return { order: winner, created: false };
  }
  throw Object.assign(new Error('This renewal could not be prepared. Please try again.'), { status: 503 });
}

/** A renewal order is only good for the terms it was made on: the plan has not moved on, or been cancelled. */
function renewalStillWanted(order, sub) {
  return !!sub && sub.status !== 'ended' && !sub.cancelAtEnd && order.plan === (sub.nextPlan ?? sub.plan)
    && order.period === (sub.nextPeriod ?? sub.period) && +order.expiresAt === +addDays(sub.periodEnd, GRACE_DAYS);
}

/**
 * The one door that pays an order and starts what it bought: the balance pays it (or nothing happens),
 * then the plan is activated. Safe to call again and again, and after every credit: a paid order changes
 * nothing, an order the balance cannot yet cover stays pending. Returns the subscription it started or
 * changed, or null.
 */
export async function tryApply(orderId, { now = new Date() } = {}) {
  const store = getStore();
  const order = await store.getOrder(orderId);
  if (!order || order.kind === 'topup') return null;
  if (order.status === 'paid') {
    const sub = await store.getSubscription(order.userId);
    // A renewal activates idempotently, which also mends a payment that landed before the process died.
    return order.kind === 'renewal' && sub ? activate(order, { now }) : sub;
  }
  if (order.status !== 'pending') return null;
  if (order.kind === 'renewal' && !renewalStillWanted(order, await store.getSubscription(order.userId))) {
    await store.cancelOrder(order.id, order.userId);
    return null;
  }
  const paid = await store.payOrderFromBalance(order.id, now);
  return paid ? activate(paid, { now }) : null;
}

async function draftOf(userId, kind, input, now) {
  const { plan, period, amountVnd, useBalance } = input;
  if (kind === 'plan') {
    const q = await quote(userId, { plan, period }, { now });
    if (q.kind === 'later') throw Object.assign(new Error('That change takes effect when the current period ends, so it is scheduled instead of paid for now.'), { status: 422 });
    return {
      kind, plan, period, usdCents: PLANS[plan].usdCents[period], rate: q.rate, rateSource: q.rateSource, priceVnd: q.priceVnd,
      creditVnd: q.creditVnd, totalVnd: q.totalVnd, useBalance, expiresAt: new Date(now.getTime() + ORDER_TTL_MS),
    };
  }
  if (!Number.isSafeInteger(amountVnd)) throw Object.assign(new Error('Enter the amount in whole đồng.'), { status: 422 });
  const withPlan = (await planInForce(userId, { now })).plan !== 'free';
  const min = withPlan ? TOPUP.minWithPlan : TOPUP.minNoPlan;
  const max = withPlan ? TOPUP.maxBalanceWithPlan : TOPUP.maxBalanceNoPlan;
  if (amountVnd < min) throw Object.assign(new Error(`The smallest top-up is ${dong(min)}đ.`), { status: 422 });
  const { balanceVnd } = await getStore().billingState(userId);
  if (balanceVnd + amountVnd > max) throw Object.assign(new Error(`A top-up cannot take your balance past ${dong(max)}đ.`), { status: 422 });
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
    order = await insert({ userId, ...draft, simulated: !!simulated });
  }
  let balance = (await store.billingState(userId)).balanceVnd;
  if (order.useBalance && order.status === 'pending' && balance >= order.totalVnd) {
    await tryApply(order.id, { now });
    order = await store.getOrder(order.id);
    if (order.status === 'paid') return { order, paidNow: true, due: null };
    balance = (await store.billingState(userId)).balanceVnd;
  }
  const vnd = dueOf(order, balance);
  if (!vnd) return { order, paidNow: false, due: null };
  try {
    return { order, paidNow: false, due: { vnd, qr: qrFor(order, vnd, env) } };
  } catch (err) {
    // An order nobody can pay by transfer is not left lying about.
    if (created) await store.cancelOrder(order.id, userId);
    throw err;
  }
}
