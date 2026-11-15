import { getStore } from '../store/index.js';
import { requirePermission, requireOwner, isOwner } from '../adminRoles.js';
import { limit as rateLimit } from '../ratelimit.js';
import { audit } from '../audit.js';
import { clientError } from '../util/clientError.js';
import { log } from '../util/trace.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { billingProfileContext } from '../secretContexts.js';
import { billingMode, billingVisible } from '../billing/mode.js';
import { PLANS, PAID_PLANS, PAYG_ANCHOR_RATE, PAYG_BASE, TOPUP, GRACE_DAYS, paygPrices, planVnd } from '../billing/plans.js';
import { addMonths, addDays } from '../billing/period.js';
import { usdVnd, BillingUnavailable, RATE_ATTRIBUTION } from '../billing/fx.js';
import { quote, createOrder, dueOf } from '../billing/orders.js';
import { planInForce, scheduleChange, setAutoRenew, setCancelAtEnd } from '../billing/subscriptions.js';
import { periodUsage, forgetBillable } from '../billing/meter.js';
import { reconcile, simulateTransfer } from '../billing/sepay.js';
import { capacityOf } from '../billing/capacity.js';
import { costOfMonth } from '../billing/cost.js';
import { createPromo, redeem } from '../billing/promo.js';
import { catchUpAndTell, tellOnce } from '../billing/tell.js';
import { sendBillingMail, within } from '../billing/mail.js';
import { drawReceipt } from '../billing/receipt.js';
import { einvoiceStatus, einvoicePdf } from '../billing/einvoice.js';
import { mailLanguage } from '../auth.js';

/**
 * Billing's HTTP surface (spec B1, Task 7; owner, 2026-11-13).
 *
 * Who may reach it is decided before any route runs: billing off is a 404 for everyone, and in preview an account that is
 * not an administrator gets a 404 too (not a 403, so it says nothing about what exists). The administrator's routes need the
 * `billing` permission on top. Every user route is scoped to the caller: an order is read by its owner only (a stranger's id is
 * a 404, the same as one that does not exist), a ledger and a list of receipts are the caller's own, and money figures and
 * amounts always come from the server, never from what the browser says was paid.
 */

const NOT_FOUND = { error: 'Not found' };
const KINDS = ['topup', 'plan', 'usage', 'promo', 'assign', 'expire', 'forfeit', 'adjust', 'refund'];
const ORDER_STATUSES = ['pending', 'paid', 'expired', 'cancelled', 'refunded'];
const TRANSFER_OUTCOMES = ['taking', 'applied', 'short', 'over', 'late', 'topup', 'unmatched', 'assigned', 'dismissed', 'ignored'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * An order as the person sees it: no account, no basis, no rate.
 * @param {any} o
 */
const orderView = (o) => ({ id: o.id, kind: o.kind, plan: o.plan, period: o.period, code: o.code, totalVnd: o.totalVnd, status: o.status, expiresAt: o.expiresAt });

/** The billing information of an account, opened; null when none was given or it will not open (never logged). */
function openProfile(userId, sealed) {
  if (!sealed) return null;
  try {
    const parsed = JSON.parse(decryptSecret(sealed, billingProfileContext(userId)) || 'null');
    return isObject(parsed) ? { name: parsed.name ?? '', email: parsed.email ?? '', country: parsed.country ?? '', address: parsed.address ?? null, taxCode: parsed.taxCode ?? null } : null;
  } catch {
    log.warn('billing information could not be opened');
    return null;
  }
}

/** The plan in force with what the Billing tab needs beside it. */
async function planView(userId, now) {
  const [inForce, state] = await Promise.all([planInForce(userId, { now }), getStore().billingState(userId)]);
  const sub = inForce.plan !== 'free' ? state.subscription : null;
  // In grace: whether this period's renewal is already an order with its price locked (read-only), so the sheet knows Renew can be
  // offered even when the exchange rate cannot be read.
  const renewalLocked = !!sub && inForce.status === 'grace'
    && (await getStore().renewalOrdersFor(userId, addDays(sub.periodEnd, GRACE_DAYS))).some((o) => o.status === 'pending' && o.plan === (sub.nextPlan ?? sub.plan) && o.period === (sub.nextPeriod ?? sub.period));
  return {
    ...inForce,
    autoRenew: sub ? sub.autoRenew : false,
    cancelAtEnd: sub ? sub.cancelAtEnd : false,
    nextPlan: sub ? sub.nextPlan : null,
    nextPeriod: sub ? sub.nextPeriod : null,
    // What the period in force cost, in full.
    priceVnd: sub ? sub.paidVnd : 0,
    renewalLocked,
  };
}

/**
 * Billing information, checked field by field. Returns the value to seal, or the sentence that says what is wrong.
 * @returns {{ value: { name: string, email: string, country: string, address: string | null, taxCode: string | null } } | { error: string }}
 */
function checkProfile(body) {
  if (!isObject(body)) return { error: 'Enter your billing information.' };
  const text = (v) => (typeof v === 'string' ? v.trim() : null);
  const name = text(body.name);
  if (!name || name.length > 120) return { error: 'Enter a name of up to 120 characters.' };
  const email = text(body.email);
  if (!email || email.length > 254 || !EMAIL.test(email)) return { error: 'Enter a valid email address.' };
  const country = text(body.country);
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return { error: 'Choose a country (a two-letter code, for example VN).' };
  let address = null;
  if (body.address != null && body.address !== '') {
    address = text(body.address);
    if (address === null || address.length > 300) return { error: 'The address is at most 300 characters.' };
  }
  let taxCode = null;
  if (body.taxCode != null && body.taxCode !== '') {
    taxCode = text(body.taxCode);
    if (taxCode === null || !/^[0-9-]{1,20}$/.test(taxCode)) return { error: 'The tax code is digits and dashes, up to 20 characters.' };
  }
  return { value: { name, email, country: country.toUpperCase(), address, taxCode } };
}

/** An administrator's view of an order or a transfer, with the account's address instead of its id alone. */
async function emailsOf(ids) {
  const store = getStore();
  const out = new Map();
  for (const id of new Set(ids.filter(Boolean))) out.set(id, (await store.getUserById(id))?.email ?? null);
  return out;
}

/** The receipt for money an administrator assigned: one per transfer, and a failure here never undoes the credit. */
async function receiptFor(transfer, userId) {
  const store = getStore();
  try {
    const existing = await store.receiptForTransfer(transfer.id);
    if (existing) return existing.number;
    const buyerSealed = (await store.getBillingProfile(userId))?.sealed ?? null;
    return (await store.createReceipt({
      userId, transferId: transfer.id, orderId: null, amountVnd: transfer.amountVnd,
      lines: [{ kind: 'assign', plan: null, period: null, code: null, amountVnd: transfer.amountVnd }], buyerSealed,
    })).number;
  } catch (err) {
    if (err?.code === '23505') return (await store.receiptForTransfer(transfer.id))?.number ?? null;
    log.warn('a receipt for assigned money could not be issued', { transfer: transfer.id, error: String(err?.message || err).slice(0, 120) });
    return null;
  }
}

export function mountBillingRoutes(api, admin, { wrap }) {
  /** A route whose own refusals (a 4xx or the rate being unavailable) are said to the person; anything else is the app's 500. */
  const route = (handler) => wrap(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = Number(err?.status);
      if (!res.headersSent && ((status >= 400 && status < 500) || status === 503)) return res.status(status).json({ error: clientError(err) });
      throw err;
    }
  });

  // ── who may see billing at all ────────────────────────────────────
  // Decided once for everything under /billing, before a route can count a try or say anything about itself.
  const gate = (req, res, next) => {
    if (billingMode() === 'off' || !billingVisible(req.user)) return res.status(404).json(NOT_FOUND);
    next();
  };
  // A plan that is due is brought up to date when its owner next looks (it may renew from the balance, which is intended).
  const settle = wrap(async (req, _res, next) => {
    await catchUpAndTell(req.user.id).catch((err) => log.warn('billing: a plan could not be brought up to date', { error: String(err?.message || err).slice(0, 160) }));
    next();
  });
  // The gate is for everything; `settle` is added per route AFTER its own rate limit, so a refused try costs no catch-up.
  api.use('/billing', gate);

  // ── the account's own billing ────────────────────────────────────
  api.get('/billing', settle, route(async (req, res) => {
    const now = new Date();
    const store = getStore();
    const [plan, state, usage, row] = await Promise.all([planView(req.user.id, now), store.billingState(req.user.id), periodUsage(req.user.id, { now }), store.getBillingProfile(req.user.id)]);
    res.json({
      mode: billingMode(),
      plan,
      balance: { vnd: state.balanceVnd, expiresAt: state.balanceVnd > 0 && state.lastTopupAt ? addMonths(state.lastTopupAt, 12) : null },
      usage,
      profile: openProfile(req.user.id, row?.sealed),
      alerts: { lowBalanceVnd: row?.lowBalanceVnd ?? null },
      bounds: TOPUP,
    });
  }));

  api.get('/billing/plans', settle, route(async (req, res) => {
    const now = new Date();
    let rate = null;
    try {
      rate = await usdVnd({ now });
    } catch (err) {
      // No honest rate: the plans are listed without prices rather than with a wrong one.
      if (!(err instanceof BillingUnavailable)) throw err;
    }
    const current = await planInForce(req.user.id, { now });
    res.json({
      plans: PAID_PLANS.map((id) => ({
        id,
        usdCents: PLANS[id].usdCents,
        vnd: rate ? { month: planVnd(id, 'month', rate.rate), year: planVnd(id, 'year', rate.rate) } : null,
        searches: PLANS[id].searches,
        sandboxMinutes: PLANS[id].sandboxMinutes,
        storageGb: PLANS[id].storageGb,
      })),
      payg: { anchorRate: PAYG_ANCHOR_RATE, base: PAYG_BASE, prices: rate ? paygPrices(rate.rate) : null },
      rate: rate ? { rate: rate.rate, source: rate.source, at: rate.at, attribution: RATE_ATTRIBUTION } : null,
      current: { plan: current.plan, period: current.period },
    });
  }));

  api.post('/billing/quote', settle, route(async (req, res) => {
    const q = await quote(req.user.id, { plan: req.body?.plan, period: req.body?.period });
    const { basis: _basis, ...visible } = q;
    res.json(visible);
  }));

  api.post('/billing/orders', rateLimit('billing-order', (req) => req.user?.id), settle, route(async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    const input = {
      kind: b.kind, plan: typeof b.plan === 'string' ? b.plan : undefined, period: typeof b.period === 'string' ? b.period : undefined,
      amountVnd: b.amountVnd, useBalance: typeof b.useBalance === 'boolean' ? b.useBalance : undefined,
    };
    const made = await createOrder(req.user.id, input);
    if (made.paidNow) {
      forgetBillable(req.user.id);
      const o = /** @type {any} */ (made.order);
      await audit(req, req.user.id, 'billing_order_paid', { order: o.id, kind: o.kind, plan: o.plan ?? null, period: o.period ?? null, amountVnd: o.totalVnd });
      const person = { id: req.user.id, email: req.user.email, name: req.user.name };
      if (o.kind === 'plan') await tellOnce(`plan:${o.id}`, 'plan-changed', person, { plan: o.plan, period: o.period, change: 'started' });
    }
    res.json({ order: orderView(made.order), paidNow: made.paidNow, due: made.due });
  }));

  // Reads the order's owner only. The id is looked up and its account compared; a stranger's order is a 404 like any other.
  const mineOrder = async (req) => {
    const order = await getStore().getOrder(req.params.id);
    return order && order.userId === req.user.id ? order : null;
  };

  // Once a second per order, checked before the catch-up: a page that polls cannot become a flood of questions to SePay, and a refused
  // poll costs nothing. The order is looked up (and must be the caller's) first, so a stranger's id is a 404 and is never counted.
  const statusLimit = wrap(async (req, res, next) => {
    const found = await mineOrder(req);
    if (!found) return res.status(404).json(NOT_FOUND);
    const counted = await getStore().hitRateLimit(`billing-status:${found.id}`, 1, 1000).catch(() => null);
    if (counted && !counted.allowed) {
      res.set('Retry-After', '1');
      return res.status(429).json({ error: 'Ask again in a moment.', code: 'rate_limited' });
    }
    next();
  });
  api.get('/billing/orders/:id', statusLimit, settle, route(async (req, res) => {
    const store = getStore();
    let order = await mineOrder(req);
    if (!order) return res.status(404).json(NOT_FOUND);
    // A transfer the webhook has not delivered may be waiting at SePay; asking is spaced by reconcile itself.
    if (order.status === 'pending') {
      await reconcile({ orderId: order.id }).catch(() => 0);
      order = (await store.getOrder(order.id)) ?? order;
    }
    const balance = (await store.billingState(req.user.id)).balanceVnd;
    res.json({ status: order.status, receivedVnd: order.receivedVnd, dueVnd: order.status === 'pending' ? dueOf(order, balance) : 0, plan: order.plan });
  }));

  api.post('/billing/orders/:id/cancel', settle, route(async (req, res) => {
    const order = await mineOrder(req);
    if (!order) return res.status(404).json(NOT_FOUND);
    const closed = await getStore().cancelOrder(order.id, req.user.id);
    if (!closed) return res.status(409).json({ error: 'This order is no longer open.' });
    res.json({ status: closed.status });
  }));

  api.put('/billing/subscription', settle, route(async (req, res) => {
    const b = req.body;
    const allowed = ['autoRenew', 'cancelAtEnd', 'nextPlan', 'nextPeriod'];
    if (!isObject(b) || !Object.keys(b).length || Object.keys(b).some((k) => !allowed.includes(k))) return res.status(400).json({ error: 'Say what to change: auto-renew, cancelling at the period end, or the next plan.' });
    for (const k of ['autoRenew', 'cancelAtEnd']) if (k in b && typeof b[k] !== 'boolean') return res.status(400).json({ error: 'Auto-renew and cancelling are on or off.' });
    for (const k of ['nextPlan', 'nextPeriod']) if (k in b && b[k] !== null && typeof b[k] !== 'string') return res.status(400).json({ error: 'Choose a plan and a period from the list.' });
    const userId = req.user.id;
    let scheduled = null;
    // All or nothing: the plan change is the part that can be refused for what it is, so it goes first; the two switches only need a plan.
    if ('nextPlan' in b || 'nextPeriod' in b) {
      const sub = await getStore().getSubscription(userId);
      if (!sub) return res.status(422).json({ error: 'You have no plan to change.' });
      if (b.nextPlan === null) {
        // Withdraw: choosing what is already in force clears what was scheduled.
        await scheduleChange(userId, { plan: sub.plan, period: sub.period });
      } else {
        const next = await scheduleChange(userId, { plan: b.nextPlan ?? sub.nextPlan ?? sub.plan, period: b.nextPeriod ?? (b.nextPlan ? sub.period : sub.nextPeriod ?? sub.period) });
        if (next.nextPlan) scheduled = next;
      }
    }
    if ('autoRenew' in b) await setAutoRenew(userId, b.autoRenew);
    if ('cancelAtEnd' in b) await setCancelAtEnd(userId, b.cancelAtEnd);
    const view = await planView(userId, new Date());
    // Told once the switches are in: a plan that is being cancelled is not changing to anything.
    if (scheduled && !view.cancelAtEnd) {
      await tellOnce(`sched:${userId}:${scheduled.nextPlan}:${scheduled.nextPeriod}:${scheduled.periodEnd.getTime()}`, 'plan-changed', { id: userId, email: req.user.email, name: req.user.name }, { plan: scheduled.nextPlan, period: scheduled.nextPeriod, change: 'scheduled', effectiveAt: scheduled.periodEnd });
    }
    res.json({ plan: view });
  }));

  api.put('/billing/profile', settle, route(async (req, res) => {
    const checked = checkProfile(req.body);
    if ('error' in checked) return res.status(400).json({ error: checked.error });
    // The whole profile is sealed to this account; what is stored is not the text and is never logged.
    await getStore().setBillingProfile(req.user.id, encryptSecret(JSON.stringify(checked.value), billingProfileContext(req.user.id)));
    await audit(req, req.user.id, 'billing_profile_updated', {});
    res.json({ profile: checked.value });
  }));

  api.put('/billing/alerts', settle, route(async (req, res) => {
    const v = req.body?.lowBalanceVnd;
    if (v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 100_000_000)) return res.status(400).json({ error: 'Enter the amount in whole đồng, or turn the alert off.' });
    const store = getStore();
    await store.setLowBalance(req.user.id, v);
    // A new threshold is a new promise: the mail is allowed to go again.
    await store.markLowAlert(req.user.id, null);
    res.json({ alerts: { lowBalanceVnd: v } });
  }));

  api.post('/billing/promo', rateLimit('billing-promo', (req) => req.user?.id), settle, route(async (req, res) => {
    const creditedVnd = await redeem(req.user.id, req.body?.code);
    res.json({ creditedVnd, balanceVnd: (await getStore().billingState(req.user.id)).balanceVnd });
  }));

  api.get('/billing/transactions', settle, route(async (req, res) => {
    const kind = req.query.kind == null || req.query.kind === '' ? null : String(req.query.kind);
    if (kind !== null && !KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a kind of transaction from the list.' });
    const before = req.query.before == null || req.query.before === '' ? null : Number(req.query.before);
    if (before !== null && !Number.isSafeInteger(before)) return res.status(400).json({ error: 'That page does not exist.' });
    const size = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 50));
    const rows = await getStore().listBalanceEntries(req.user.id, { kind, before, limit: size });
    res.json({
      entries: rows.map((e) => ({ id: e.id, kind: e.kind, category: e.category, day: e.day, units: e.units, deltaVnd: e.deltaVnd, ref: e.ref, note: e.note, createdAt: e.createdAt, balanceAfterVnd: e.balanceAfterVnd })),
      next: rows.length === size ? rows[rows.length - 1].id : null,
    });
  }));

  // The list; the PDF of one is below and checks the same thing: the receipt's account is the caller.
  api.get('/billing/receipts', settle, route(async (req, res) => {
    const rows = await getStore().listReceipts(req.user.id);
    res.json({ receipts: rows.map((r) => ({ number: r.number, amountVnd: r.amountVnd, issuedAt: r.issuedAt, orderId: r.orderId })) });
  }));

  /** A PDF as a download. Numbers are sequential and guessable, so what is sent was checked against the caller before this. */
  const sendPdf = (res, name, bytes) => {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"`, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  };

  api.get('/billing/receipts/:number.pdf', rateLimit('billing-pdf', (req) => req.user?.id), settle, route(async (req, res) => {
    const receipt = await getStore().getReceipt(req.params.number);
    // Another account's receipt, a deleted account's (no owner left), and one that does not exist are the same 404.
    if (!receipt || !receipt.userId || receipt.userId !== req.user.id) return res.status(404).json(NOT_FOUND);
    const language = await mailLanguage(req.user, req);
    sendPdf(res, receipt.number, await drawReceipt(receipt, { language }));
  }));

  // The invoice is looked up by its order's id: the order's account is the caller, or it is a 404 like any other.
  api.get('/billing/invoices/:id.pdf', rateLimit('billing-pdf', (req) => req.user?.id), settle, route(async (req, res) => {
    const order = await mineOrder(req);
    if (!order) return res.status(404).json(NOT_FOUND);
    const row = await einvoiceStatus(order.id);
    const bytes = row?.status === 'issued' ? await einvoicePdf(order.id) : null;
    if (!bytes) return res.status(404).json(NOT_FOUND);
    sendPdf(res, row.referenceCode, bytes);
  }));

  // ── the administrator's billing ──────────────────────────────────
  const adminGate = (_req, res, next) => (billingMode() === 'off' ? res.status(404).json(NOT_FOUND) : next());
  admin.use('/billing', adminGate, requirePermission('billing'));

  admin.get('/billing', route(async (req, res) => {
    const now = new Date();
    const days = Math.min(365, Math.max(1, Math.trunc(Number(req.query.days)) || 30));
    const since = new Date(now.getTime() - days * 86_400_000);
    const figures = await getStore().billingAdminFigures(since);
    const rate = await usdVnd({ now }).then((r) => ({ rate: r.rate, source: r.source, at: r.at })).catch(() => null);
    res.json({
      mode: billingMode(), days, since, rate, figures,
      capacity: await capacityOf({ bytes: figures.databaseBytes }),
      // This UTC month: what the paid keys cost (spec A's paid counters at list prices), the real money taken in, and the difference.
      ...(await costOfMonth({ now }).then((c) => ({ cost: { byService: c.byService, totalVnd: c.totalVnd }, revenueMonthVnd: c.revenueMonthVnd, promoMonthVnd: c.promoMonthVnd, marginVnd: c.marginVnd })).catch((err) => {
        log.warn('billing: the cost of the month could not be worked out', { error: String(err?.message || err).slice(0, 160) });
        return { cost: null, revenueMonthVnd: null, promoMonthVnd: null, marginVnd: null };
      })),
      // Whether this administrator may simulate a transfer: the owner, in preview.
      simulate: billingMode() === 'preview' && isOwner(req.user),
    });
  }));

  admin.get('/billing/orders', route(async (req, res) => {
    const status = req.query.status == null || req.query.status === '' ? null : String(req.query.status);
    if (status !== null && !ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'Choose a status from the list.' });
    const rows = await getStore().listOrders({ status, limit: Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit)) || 50)) });
    const emails = await emailsOf(rows.map((o) => o.userId));
    res.json({
      orders: rows.map((o) => ({
        ...orderView(o), userId: o.userId, email: emails.get(o.userId) ?? null, receivedVnd: o.receivedVnd, simulated: o.simulated, paidAt: o.paidAt, createdAt: o.createdAt,
      })),
    });
  }));

  admin.get('/billing/transfers', route(async (req, res) => {
    const outcome = req.query.outcome == null || req.query.outcome === '' ? null : String(req.query.outcome);
    if (outcome !== null && !TRANSFER_OUTCOMES.includes(outcome)) return res.status(400).json({ error: 'Choose an outcome from the list.' });
    const rows = await getStore().listTransfers({ outcome, limit: Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit)) || 50)) });
    // The content of a transfer is what the payer typed; it is shown to the billing administrator and nobody else.
    res.json({
      transfers: rows.map((t) => ({
        id: t.id, via: t.via, outcome: t.outcome, amountVnd: t.amountVnd, code: t.code, content: t.content, gateway: t.gateway, referenceCode: t.referenceCode,
        orderId: t.orderId, userId: t.userId, transactionAt: t.transactionAt, receivedAt: t.receivedAt, creditedAt: t.creditedAt,
      })),
    });
  }));

  admin.post('/billing/transfers/:id/assign', route(async (req, res) => {
    const store = getStore();
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'Say which account the money belongs to.' });
    const id = Number(req.params.id);
    const transfer = Number.isSafeInteger(id) ? await store.getTransfer(id) : null;
    if (!transfer) return res.status(404).json({ error: 'That transfer was not found.' });
    // Play money is never given to an account.
    if (transfer.via === 'simulated') return res.status(409).json({ error: 'This transfer is no longer waiting to be assigned.' });
    const target = await store.getUserByEmail(email);
    if (!target) return res.status(404).json({ error: 'No account has that email.' });
    // One statement: the transfer is claimed only while it is still unmatched and uncredited, and it credits the balance then.
    // A second assign, a dismiss or a repeat finds it claimed and changes nothing.
    const balance = await store.creditTransfer({ transferId: transfer.id, userId: target.id, vnd: transfer.amountVnd, kind: 'assign', clock: true, onlyOutcome: 'unmatched', setOutcome: 'assigned' });
    if (balance === null) return res.status(409).json({ error: 'This transfer is no longer waiting to be assigned.' });
    forgetBillable(target.id);
    const receipt = await receiptFor(transfer, target.id);
    await audit(req, req.user.id, 'billing_transfer_assigned', { transfer: transfer.id, to: target.id, amountVnd: transfer.amountVnd });
    if (!target.suspended_at) {
      await within(8_000, sendBillingMail('paid', { id: target.id, email: target.email, name: target.name }, { amountVnd: transfer.amountVnd, what: { kind: 'topup' }, balanceVnd: balance, receiptNumber: receipt }));
    }
    res.json({ ok: true, outcome: 'assigned', balanceVnd: balance, receipt });
  }));

  admin.post('/billing/transfers/:id/dismiss', route(async (req, res) => {
    const store = getStore();
    const id = Number(req.params.id);
    const transfer = Number.isSafeInteger(id) ? await store.getTransfer(id) : null;
    if (!transfer) return res.status(404).json({ error: 'That transfer was not found.' });
    const done = await store.dismissTransfer(transfer.id);
    if (!done) return res.status(409).json({ error: 'This transfer is no longer waiting to be assigned.' });
    await audit(req, req.user.id, 'billing_transfer_dismissed', { transfer: transfer.id, amountVnd: transfer.amountVnd });
    res.json({ ok: true, outcome: 'dismissed' });
  }));

  admin.get('/billing/promos', route(async (_req, res) => {
    res.json({ promos: await getStore().listPromos() });
  }));

  admin.post('/billing/promos', route(async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    const promo = await createPromo({ code: b.code, creditVnd: b.creditVnd, maxUses: b.maxUses, expiresAt: b.expiresAt }, req.user.id);
    // The code is the secret of a promo: the record keeps the size of it and its last four characters.
    await audit(req, req.user.id, 'billing_promo_created', { hint: promo.code.slice(-4), creditVnd: promo.creditVnd, maxUses: promo.maxUses });
    res.status(201).json({ promo });
  }));

  admin.delete('/billing/promos/:code', route(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!(await getStore().disablePromo(code))) return res.status(404).json({ error: 'That code was not found.' });
    await audit(req, req.user.id, 'billing_promo_disabled', { hint: code.slice(-4) });
    res.json({ ok: true });
  }));

  // Acting as the bank, for trying the whole flow without money: the owner's, and only while billing is in preview.
  admin.post('/billing/simulate', requireOwner, route(async (req, res) => {
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
    if (!orderId) return res.status(400).json({ error: 'Say which order to simulate a transfer for.' });
    const done = /** @type {any} */ (await simulateTransfer(orderId));
    if (done.status !== 200) return res.status(done.status).json({ error: done.error });
    await audit(req, req.user.id, 'billing_simulated', { order: orderId, outcome: done.outcome });
    res.json({ outcome: done.outcome, transferId: done.transferId, orderId: done.orderId });
  }));
}
