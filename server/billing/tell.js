/**
 * Telling an account what happened to its plan (spec B1; final review, 2026-11-15). The plan's own statements report what they
 * changed (subscriptions.js `catchUpChanges`), and this turns each change into its mail and, for money a renewal took from the
 * balance, the paid line in the account's record. Whoever's statement made a change tells it, wherever that ran: the daily job, a
 * billing page being opened, or a metered call that met the period's end first (meter.js). A caller that only saw somebody else's
 * change has nothing to tell, so each change is told once; the mark per account and period on each mail (`tellOnce`) keeps a
 * second report of the same change, from a caller at the same moment, to one mail.
 *
 * A module of its own so meter.js can reach it without importing daily.js, which imports meter.js.
 */
import { getStore } from '../store/index.js';
import { log } from '../util/trace.js';
import { audit } from '../audit.js';
import { sendBillingMail, within } from './mail.js';
import { addDays } from './period.js';
import { GRACE_DAYS } from './plans.js';
import { catchUpChanges } from './subscriptions.js';
import { forgetBillable } from './billable.js';

/** How long the "already told" mark of a one-off mail is kept: longer than any period it guards. */
const TOLD_MS = 400 * 86_400_000;

/**
 * Send a mail at most once for `key`, however many instances ask at once: the mark is claimed first (the first to bump the
 * counter to 1 sends, the rest stop), and given back when nothing was sent - no mail provider yet, or the provider refused - so a
 * caller that asks again can still send it. Only the expiry warning is asked again (every day of its window). A plan change is
 * reported once, by the statement that made it, and a renewal reminder once (its subscription is marked reminded when the order is
 * made), so a mail of theirs that did not go is not sent later. Low-balance mails keep their own mark and do not come through here.
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
export async function personFor(userId) {
  const u = await getStore().getUserById(userId);
  return u && !u.suspended_at ? { id: u.id, email: u.email, name: u.name } : null;
}

const warn = (what, err) => log.warn(`billing: ${what}`, { error: String(err?.message || err).slice(0, 160) });

async function mailChanges(userId, changes, now) {
  const person = await personFor(userId);
  if (!person) return;
  for (const c of changes) {
    // One mail failing leaves the others to go.
    try {
      const id = `${userId}:${c.from.getTime()}`;
      if (c.kind === 'renewed') await tellOnce(`renewed:${id}`, 'renewed', person, { plan: c.sub.plan, period: c.sub.period, amountVnd: c.sub.paidVnd, endsAt: c.sub.periodEnd }, { now });
      else if (c.kind === 'grace') await tellOnce(`grace:${id}`, 'grace', person, { plan: c.sub.plan, endsAt: addDays(c.sub.periodEnd, GRACE_DAYS) }, { now });
      else if (c.kind === 'ended') await tellOnce(`ended:${id}`, 'ended', person, { plan: c.sub.plan }, { now });
    } catch (err) {
      warn(`a "${c.kind}" mail could not be sent`, err);
    }
  }
}

/**
 * Tell the account of the changes `catchUpChanges` reported. Never throws: a plan that has changed stays changed whatever a mail
 * provider says. The paid lines are written first and always waited for (they are the record that money moved); `waitMs` bounds
 * how long the mails are waited for, for a caller that is in the middle of something else (a metered call), after which they finish
 * by themselves.
 *
 * @param {string} userId
 * @param {import('./subscriptions.js').PlanChange[]} changes
 * @param {{ now?: Date, waitMs?: number }} [options]
 */
export async function tellChanges(userId, changes, { now = new Date(), waitMs } = {}) {
  if (!changes?.length) return;
  try {
    forgetBillable(userId);
    for (const c of changes) {
      if (!c.paid) continue;
      const o = c.paid;
      await audit(null, userId, 'billing_order_paid', { order: o.id, kind: o.kind, plan: o.plan ?? null, period: o.period ?? null, amountVnd: o.totalVnd });
    }
    const mailed = mailChanges(userId, changes, now).catch((err) => warn('a plan change could not be told', err));
    await (waitMs ? within(waitMs, mailed) : mailed);
  } catch (err) {
    warn('a plan change could not be told', err);
  }
}

/** `catchUp`, and the account told of what this call changed: renewed from the balance, into grace, or ended. */
export async function catchUpAndTell(userId, { now = new Date() } = {}) {
  const { sub, changes } = await catchUpChanges(userId, { now });
  await tellChanges(userId, changes, { now });
  return sub;
}
