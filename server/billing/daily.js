/**
 * The billing work that has no request to ride on (spec B1, Task 7; owner, 2026-11-13). Nothing here is a timer: on a
 * deployment `/api/cron/run-tasks` calls `billingTick` in its heartbeat, and a long-lived local process calls it from its
 * minute tick (server/scheduler.js), so both reach the same state.
 *
 * Every tick (cheap): orders past their time are closed, transfers a crash left `taking` are finished, renewal reminders
 * are made and mailed, and each plan that is near an end or past it is brought up to date (renewed from the balance, in
 * grace, ended) with the account told. Once per Vietnamese day (claimed with a counter, so two instances at once do it
 * once): the day of storage is charged, balances 12 months old expire (and those 30 days from it are warned), SePay is
 * asked for the last three days of transfers the webhook may have missed, e-invoice status is looked at, and low-balance
 * emails go. Each step is its own try, so one failing never stops the others, and the tick never throws into the heartbeat.
 */
import { getStore } from '../store/index.js';
import { log } from '../util/trace.js';
import { billingMode } from './mode.js';
import { addDays, vnDay, vnDayEnd } from './period.js';
import { catchUp, planInForce, remindersDue } from './subscriptions.js';
import { createOrder, dueOf, qrFor } from './orders.js';
import { chargeStorageDay, forgetBillable } from './meter.js';
import { reconcile, takeTransfer } from './sepay.js';
import { mailable, sendBillingMail } from './mail.js';
import { EXPIRY_WARNING_DAYS, GRACE_DAYS, TOPUP } from './plans.js';

/** A transfer left `taking` this long is not a request still being served: it is finished from its stored row. */
const TAKING_MS = 5 * 60_000;
const RECONCILE_DAYS = 3;
/** How long the "already told" mark of a one-off mail is kept: longer than any period it guards. */
const TOLD_MS = 400 * 86_400_000;

const fail = (step, err) => log.warn(`billing: ${step} failed`, { error: String(err?.message || err).slice(0, 160), code: err?.code });

/**
 * Run one step; its failure is logged (no personal data) and becomes the fallback value.
 * @param {string} name
 * @param {() => Promise<any>} fn
 * @param {any} [fallback]
 */
async function step(name, fn, fallback = 0) {
  try {
    return await fn();
  } catch (err) {
    fail(name, err);
    return fallback;
  }
}

/**
 * Send a mail at most once for `key`, however many instances ask at once: the mark is claimed first (the first to bump the
 * counter to 1 sends, the rest stop), and given back when nothing was sent - no mail provider yet, or the provider refused - so
 * the mail still goes when one is set up or on the next try.
 */
export async function tellOnce(key, kind, user, data, { now = new Date() } = {}) {
  const store = getStore();
  const bucket = `bill:told:${key}`;
  const until = new Date(now.getTime() + TOLD_MS);
  if ((await store.addToCounter(bucket, 1, until)) !== 1) return false;
  const sent = await sendBillingMail(kind, user, data);
  if (!sent.ok) await store.addToCounter(bucket, -1, until);
  return sent.ok;
}

/** An account as the mails need it, or null. A suspended or deleted account is not written to. */
async function personFor(userId) {
  const u = await getStore().getUserById(userId);
  return u && !u.suspended_at ? { id: u.id, email: u.email, name: u.name } : null;
}

/**
 * `catchUp`, and the account told of what it did: renewed from the balance, into grace, or ended. The mail is marked per
 * account and period, so two requests that both see the change send one.
 */
export async function catchUpAndTell(userId, { now = new Date() } = {}) {
  const store = getStore();
  const before = await store.getSubscription(userId);
  const after = await catchUp(userId, { now });
  if (!before || !after) return after;
  const id = `${userId}:${before.periodEnd.getTime()}`;
  if (+after.periodEnd > +before.periodEnd && after.status === 'active') {
    forgetBillable(userId);
    const person = await personFor(userId);
    if (person) await tellOnce(`renewed:${id}`, 'renewed', person, { plan: after.plan, period: after.period, amountVnd: after.paidVnd, endsAt: after.periodEnd }, { now });
  } else if (before.status === 'active' && after.status === 'grace') {
    const person = await personFor(userId);
    if (person) await tellOnce(`grace:${id}`, 'grace', person, { plan: after.plan, endsAt: addDays(after.periodEnd, GRACE_DAYS) }, { now });
  } else if (before.status !== 'ended' && after.status === 'ended') {
    forgetBillable(userId);
    const person = await personFor(userId);
    if (person) await tellOnce(`ended:${id}`, 'ended', person, { plan: before.plan }, { now });
  }
  return after;
}

/** Task 8 fills this in: ask SePay how the e-invoices not yet finished are doing. Returns how many it looked at. */
export async function einvoiceStep() {
  return 0;
}

async function remind(now) {
  let sent = 0;
  for (const due of await remindersDue(now)) {
    const { userId } = due;
    const order = /** @type {any} */ (due.order);
    const person = await personFor(userId);
    if (!person) continue;
    const balance = (await getStore().billingState(userId)).balanceVnd;
    let qr = null;
    try {
      qr = qrFor(order, dueOf(order, balance));
    } catch {
      // Bank details unset: the reminder still goes, without the QR.
    }
    const told = await tellOnce(`soon:${order.id}`, 'renewal-soon', person, {
      plan: order.plan, period: order.period, amountVnd: order.totalVnd, endsAt: addDays(order.expiresAt, -GRACE_DAYS), code: order.code, balanceVnd: balance, qr,
    }, { now });
    if (told) sent += 1;
  }
  return sent;
}

/** Finish the transfers a crash left `taking`, from the row itself (the money was recorded; the steps after it are what is repeated). */
async function resume(now) {
  const store = getStore();
  let done = 0;
  for (const row of await store.listTakingTransfers(new Date(now.getTime() - TAKING_MS))) {
    try {
      await takeTransfer({
        id: row.sepayId, referenceCode: row.referenceCode, gateway: row.gateway, accountNumber: row.accountNumber, code: row.code, content: row.content,
        transferType: 'in', transferAmount: row.amountVnd, transactionDate: row.transactionAt ? new Date(+row.transactionAt + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ') : null,
      }, { via: row.via, now });
      done += 1;
    } catch (err) {
      fail('finishing a transfer', err);
    }
  }
  return done;
}

async function warnExpiring(now) {
  const store = getStore();
  let sent = 0;
  for (const b of await store.listBalancesExpiringBetween(now, addDays(now, EXPIRY_WARNING_DAYS))) {
    const person = await personFor(b.userId);
    if (!person) continue;
    // One warning per top-up: the date of the last top-up names it, and a new top-up is a new date.
    if (await tellOnce(`expiring:${b.userId}:${b.lastTopupAt.getTime()}`, 'expiring', person, { balanceVnd: b.vnd, expiresAt: b.expiresAt }, { now })) sent += 1;
  }
  return sent;
}

/**
 * Low-balance mails: one when the balance is below the threshold, none again until it is back at or over it. The mail carries a QR
 * for the smallest top-up the account may make (an order is made for it); money sent after that order expires still lands in the balance.
 */
async function lowBalance(now) {
  const store = getStore();
  let sent = 0;
  for (const a of await store.listLowBalanceAccounts()) {
    if (a.balanceVnd >= a.lowBalanceVnd) {
      if (a.lowAlertSentAt) await store.markLowAlert(a.userId, null);
      continue;
    }
    if (a.lowAlertSentAt) continue;
    const person = await personFor(a.userId);
    if (!person) continue;
    // Nothing is prepared for a mail that will not go: no provider (or an account that cannot see billing) makes no QR order.
    if (!(await mailable(person))) continue;
    /** @type {Record<string, any>} */
    const data = { balanceVnd: a.balanceVnd, thresholdVnd: a.lowBalanceVnd };
    try {
      const withPlan = (await planInForce(a.userId, { now })).plan !== 'free';
      const amount = withPlan ? TOPUP.minWithPlan : TOPUP.minNoPlan;
      const made = await createOrder(a.userId, { kind: 'topup', amountVnd: amount }, { now });
      if (made.due) Object.assign(data, { topupVnd: amount, code: /** @type {any} */ (made.order).code, qr: made.due.qr });
    } catch (err) {
      // No rate or bank details, or the cap: the mail still goes, without a QR.
      fail('the low-balance top-up order', err);
    }
    const result = await sendBillingMail('low-balance', person, data);
    if (result.ok) {
      await store.markLowAlert(a.userId, now);
      sent += 1;
    }
  }
  return sent;
}

/** The part that is done once a Vietnamese day. */
async function dayWork(now) {
  const store = getStore();
  const storage = await step('the day of storage', async () => chargeStorageDay({ now }), { charged: 0, would: 0 });
  const expired = await step('expiring balances', async () => {
    const taken = await store.expireBalances(now);
    for (const t of taken) forgetBillable(t.userId);
    return taken.length;
  });
  const expiring = await step('expiry warnings', () => warnExpiring(now));
  const reconciled = await step('reconciling with SePay', () => reconcile({ since: addDays(now, -RECONCILE_DAYS), now }));
  const einvoices = await step('e-invoice status', () => einvoiceStep());
  const lowAlerts = await step('low-balance mails', () => lowBalance(now));
  return { storage, expired, expiring, reconciled, einvoices, lowAlerts };
}

/**
 * The whole of it. Returns counts (`daily` is null on every tick but the first of a Vietnamese day); never throws.
 * Does nothing at all while billing is off.
 *
 * @param {{ now?: Date }} [options]
 */
export async function billingTick({ now = new Date() } = {}) {
  const out = { expired: 0, resumed: 0, reminders: 0, caughtUp: 0, daily: null };
  if (billingMode() === 'off') return out;
  const store = getStore();
  out.expired = await step('closing old orders', () => store.expireOrders(now));
  out.resumed = await step('finishing transfers', () => resume(now));
  out.reminders = await step('renewal reminders', () => remind(now));
  out.caughtUp = await step('bringing plans up to date', async () => {
    let n = 0;
    for (const sub of await store.listSubscriptionsToWork(now)) {
      await step('a plan', () => catchUpAndTell(sub.userId, { now }), null);
      n += 1;
    }
    return n;
  });
  const claimed = await step('claiming the day', async () => (await store.addToCounter(`bill:daily:${vnDay(now)}`, 1, vnDayEnd(now))) === 1, false);
  if (claimed) out.daily = await dayWork(now);
  return out;
}
