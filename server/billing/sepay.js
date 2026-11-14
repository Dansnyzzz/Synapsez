/**
 * SePay (owner, 2026-11-13): the bank tells us about each transfer by webhook, we check it on the raw bytes it
 * signed, take it exactly once, and either match it to the order whose code it carries or keep it for the owner.
 * A poll of SePay's transaction list mends a webhook that never arrived, and in preview a transfer can be
 * simulated. Every credit of a transfer is `topup` money (real money, it starts the 12-month clock); what the
 * order needs is then taken out of the balance by `tryApply`, so the money and the plan can never disagree.
 *
 * Retries: SePay retries a webhook the server answered with an error, and a poll can meet a transfer the webhook
 * has not finished. A transfer is recorded first as `taking` (with its order and account), the credit is one
 * statement gated by `credited_at`, the receipt is unique per transfer, and the outcome is written last; so the
 * same transfer arriving again FINISHES whatever a crash left undone, and finishing twice changes nothing.
 */
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { billingMode } from './mode.js';
import { findCode } from './codes.js';
import { dueOf, tryApply } from './orders.js';
import { log } from '../util/trace.js';

const WINDOW_S = 300;
const USERAPI = 'https://userapi.sepay.vn/v2/transactions';
const POLL_ALL_MS = 10_000;
const POLL_ORDER_MS = 30_000;
const POLL_PAGES = 5;

const headerOf = (headers, name) => {
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === name) return Array.isArray(headers[key]) ? headers[key][0] : headers[key];
  }
  return undefined;
};

/**
 * Whether this request is SePay's: `X-SePay-Signature: sha256=<hex>` is HMAC-SHA256 of `<timestamp>.<raw body>`
 * under the shared secret, and the timestamp (unix seconds) is within five minutes of now. Never throws.
 */
export function verifySepay({ raw, headers, secret, now = Date.now() }) {
  try {
    if (!secret || !Buffer.isBuffer(raw)) return false;
    const given = headerOf(headers, 'x-sepay-signature');
    const stamp = headerOf(headers, 'x-sepay-timestamp');
    if (typeof given !== 'string' || typeof stamp !== 'string') return false;
    const match = /^sha256=([0-9a-f]{64})$/i.exec(given.trim());
    const ts = stamp.trim();
    if (!match || !/^\d{1,12}$/.test(ts)) return false;
    if (Math.abs(Number(now) / 1000 - Number(ts)) > WINDOW_S) return false;
    const want = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}.`), raw])).digest();
    const got = Buffer.from(match[1], 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

const atOf = (now) => (now instanceof Date ? new Date(+now) : new Date(Number(now)));
/** SePay writes Vietnamese time as `YYYY-MM-DD HH:mm:ss`. */
const transactionAt = (text) => {
  const d = new Date(`${String(text || '').trim().replace(' ', 'T')}+07:00`);
  return Number.isNaN(+d) ? null : d;
};
const vnStamp = (d) => new Date(+d + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
// A NUL byte is not storable in Postgres text (22021) and would fail the insert, and so every redelivery, for good.
const cut = (value, n) => (value == null ? null : String(value).replaceAll(String.fromCharCode(0), '').slice(0, n));

/** What the receipt says it is for. No buyer details: those travel sealed in `buyer_sealed`. */
function receiptLines(order, amountVnd) {
  return [{ kind: order.kind, plan: order.plan ?? null, period: order.period ?? null, code: order.code, amountVnd }];
}

async function issueReceipt(transfer, order, userId) {
  const store = getStore();
  // Checked first so a finished retry does not use up a receipt number (the sequence is drawn before the unique index answers).
  if (await store.receiptForTransfer(transfer.id)) return;
  // The profile's own sealed snapshot is copied: it is already sealed for this account (billingProfileContext), so it opens the same.
  const buyerSealed = (await store.getBillingProfile(userId))?.sealed ?? null;
  try {
    await store.createReceipt({ userId, transferId: transfer.id, orderId: order.id, amountVnd: transfer.amountVnd, lines: receiptLines(order, transfer.amountVnd), buyerSealed });
  } catch (err) {
    if (err?.code !== '23505') throw err; // one receipt per transfer: a finished retry meets the one already issued
  }
}

/**
 * Take one transfer: dedupe, ignore what is not money in to our account, find the order its code names, credit the
 * balance, then pay and start the order (or mark a top-up paid). Idempotent at every step, so the same transfer
 * arriving again finishes what a crash left. Returns `{ outcome, transferId, orderId, repeat }`; `repeat` means it
 * was already finished and nothing was done.
 * @param {Record<string, any>} payload
 * @param {{ via?: 'webhook'|'poll'|'simulated', now?: Date|number, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function takeTransfer(payload, { via = 'webhook', now = Date.now(), env = process.env } = {}) {
  const store = getStore();
  const at = atOf(now);
  const amount = payload?.transferAmount;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('A transfer needs a positive whole amount.');
  const reference = cut(String(payload.referenceCode ?? '').trim(), 120) || null;
  const idText = payload.id == null ? '' : cut(String(payload.id).trim(), 80);
  if (!reference && !idText) throw new Error('A transfer needs a reference or an id.');
  const dedupe = reference ? `ref:${reference}` : `id:${idText}`;

  const account = String(env.SEPAY_BANK_ACCOUNT || '').trim();
  const moneyIn = payload.transferType === 'in' && (via === 'simulated' || (!!account && String(payload.accountNumber ?? '').trim() === account));
  const code = moneyIn ? findCode(payload.code, payload.content) : null;
  const found = code ? await store.getOrderByCode(code) : null;
  // An order whose account is gone has nobody to credit: the owner decides.
  const order0 = found?.userId ? found : null;

  const draft = {
    dedupe, sepayId: cut(idText, 80), referenceCode: reference, gateway: cut(payload.gateway, 60), accountNumber: cut(payload.accountNumber, 60),
    amountVnd: amount, code, content: cut(payload.content, 300), transactionAt: transactionAt(payload.transactionDate),
    orderId: order0?.id ?? null, userId: order0?.userId ?? null, via,
    outcome: !moneyIn ? 'ignored' : order0 ? 'taking' : 'unmatched',
  };
  let row = await store.recordTransfer(draft);
  if (row && row.outcome === 'ignored' && payload.transferType === 'in') {
    // Money in that we ignored but that names an order: a wrong or unset SEPAY_BANK_ACCOUNT would look exactly like this.
    const named = findCode(payload.code, payload.content);
    if (named && (await store.getOrderByCode(named))) log.warn('an incoming SePay transfer names an order but was ignored (is SEPAY_BANK_ACCOUNT right?)', { transfer: row.id });
  }
  if (row && row.outcome !== 'taking') return { outcome: row.outcome, transferId: row.id, orderId: null, repeat: false };
  if (!row) {
    row = await store.getTransferByDedupe(dedupe);
    if (!row) throw new Error('A transfer that was just recorded could not be read back.');
    // A different transfer reusing a reference must not pass silently as a repeat; the recorded row is what counts.
    if (row.amountVnd !== amount) log.warn('a SePay transfer repeats a reference with another amount', { transfer: row.id, recorded: row.amountVnd, received: amount, via });
    if (row.outcome !== 'taking') return { outcome: row.outcome, transferId: row.id, orderId: row.orderId, repeat: true };
  }

  // From here the row says which order and account it belongs to, and how much it was; a retry follows the row, not the payload.
  const userId = row.userId;
  const order = await store.getOrder(row.orderId);
  if (!userId || !order || !order.userId) {
    // The order or the account went away while the transfer was being taken: nothing to credit, or already credited with nobody to apply it to.
    // Whether it was credited is decided by the statement itself, not by the row read above: another run may have credited it since.
    const done = (await store.endLostTransfer(row.id)) ?? (await store.getTransfer(row.id));
    log.warn('a SePay transfer in progress lost its order or account', { transfer: row.id, outcome: done.outcome });
    return { outcome: done.outcome, transferId: row.id, orderId: null, repeat: false };
  }
  const vnd = row.amountVnd;
  const live = order.status === 'pending' && order.expiresAt > at;
  await store.creditTransfer({ transferId: row.id, userId, vnd, orderId: order.id, countReceived: live });
  // The statement that claims the credit decides, once, whether it counted toward the order; every later try follows that.
  const counted = (await store.getTransfer(row.id)).counted;
  // What was still due when this transfer was credited is kept on the row by the claiming statement itself, so every run judges `over` the same way.

  let outcome;
  if (!counted) {
    outcome = 'late';
  } else if (order.kind === 'topup') {
    // A top-up order is only a code and an amount: whatever arrives closes it, and it stays in the balance.
    await store.markTopupPaid(order.id, at);
    outcome = 'topup';
  } else {
    await tryApply(order.id, { now: at }); // after every credit, even when the order looks short: it decides
    const after = await store.getOrder(order.id);
    const dueBefore = (await store.getTransfer(row.id)).dueBefore;
    if (after.status === 'paid') outcome = (dueBefore == null ? after.receivedVnd > after.totalVnd : vnd > dueBefore) ? 'over' : 'applied';
    else outcome = after.status === 'pending' && after.expiresAt > at ? 'short' : 'late';
  }

  if (via !== 'simulated') await issueReceipt(row, order, userId);
  // The first to finish sets the label, so two deliveries at once cannot disagree about it.
  const finished = (await store.finishTransfer(row.id, { outcome, orderId: order.id, userId })) ?? (await store.getTransfer(row.id));
  outcome = finished.outcome;
  log.info('a SePay transfer was taken', { transfer: row.id, outcome, via });
  return { outcome, transferId: row.id, orderId: order.id, repeat: false };
}

/**
 * The webhook, on its raw bytes. 404 when billing is off or no secret is set (the endpoint does not exist), 401
 * when the signature is not SePay's, 400 for a body that is not a transfer; the success body is written only after
 * the database work, and any failure of ours is a 500 so SePay tries again.
 */
export async function acceptSepay({ raw, headers, now = Date.now(), env = process.env }) {
  const secret = String(env.SEPAY_WEBHOOK_SECRET || '');
  // No account number means no transfer could ever be recognised as ours (and dedupe would then bar a later poll): the endpoint is not ready.
  if (billingMode(env) === 'off' || !secret) return { status: 404, body: { success: false } };
  // Set up but not ready: a status SePay will retry, rather than a 404 that says the endpoint is not there.
  if (!String(env.SEPAY_BANK_ACCOUNT || '').trim()) return { status: 503, body: { success: false } };
  if (!verifySepay({ raw, headers, secret, now })) return { status: 401, body: { success: false } };
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { success: false } };
  }
  const amount = payload?.transferAmount;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Number.isSafeInteger(amount) || amount <= 0) return { status: 400, body: { success: false } };
  if (!String(payload.referenceCode ?? '').trim() && (payload.id == null || String(payload.id).trim() === '')) return { status: 400, body: { success: false } };
  try {
    await takeTransfer(payload, { via: 'webhook', now, env });
    return { status: 200, body: { success: true } };
  } catch (err) {
    // The message is the database's or ours; never the body, the signature or the secret.
    log.warn('a SePay transfer could not be taken', { code: err?.code, error: String(err?.message || err).slice(0, 120) });
    return { status: 500, body: { success: false } };
  }
}

/*
 * Politeness toward SePay's list API, kept per process on purpose: it only spaces our own asks out, and a second
 * serverless instance asking too is allowed for by SePay's own limit (3 requests a second). Nothing here is money.
 */
const asked = { all: -Infinity, byOrder: new Map() };
export const _resetSepayForTests = () => { asked.all = -Infinity; asked.byOrder.clear(); };

/** One row of the v2 list in the shape of a webhook body. v2's `id` is a UUID, so the bank's reference number is what dedupes. */
const fromList = (row) => ({
  id: row.id, gateway: row.bank_brand_name, transactionDate: row.transaction_date, accountNumber: row.account_number, code: row.code ?? null,
  content: row.transaction_content, transferType: Number(row.amount_in) > 0 ? 'in' : 'out', transferAmount: Number(row.amount_in), referenceCode: row.reference_number,
});

/**
 * Ask SePay for the money in since `since` (or about one order) and take what the webhook missed. Only rows that
 * carry the bank's reference number are taken, so a transfer the webhook already brought dedupes to the same key.
 * Needs SEPAY_API_TOKEN; spaced at most once per 30 s per order and once per 10 s overall. Returns how many were new.
 * @param {{ since?: Date|number, orderId?: string|null, now?: Date|number, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function reconcile({ since, orderId = null, now = Date.now(), env = process.env } = {}) {
  const token = String(env.SEPAY_API_TOKEN || '').trim();
  // Without our account number every row would be recorded as ignored, and dedupe would then bar the real take later.
  if (!token || billingMode(env) === 'off' || !String(env.SEPAY_BANK_ACCOUNT || '').trim()) return 0;
  const t = +atOf(now);
  if (t - asked.all < POLL_ALL_MS) return 0;
  if (orderId && t - (asked.byOrder.get(orderId) ?? -Infinity) < POLL_ORDER_MS) return 0;
  const store = getStore();
  const order = orderId ? await store.getOrder(orderId) : null;
  if (orderId && !order) return 0;
  asked.all = t;
  for (const [id, when] of asked.byOrder) if (t - when >= POLL_ORDER_MS) asked.byOrder.delete(id);
  if (orderId) asked.byOrder.set(orderId, t);

  const params = new URLSearchParams({ transfer_type: 'in', transaction_date_sort: 'asc', per_page: '100', transaction_date_from: vnStamp(atOf(since ?? t - 86_400_000)) });
  if (order) params.set('q', order.code);
  let taken = 0;
  for (let page = 1; page <= POLL_PAGES; page += 1) {
    params.set('page', String(page));
    let body;
    try {
      const res = await fetch(`${USERAPI}?${params}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn('SePay did not give the transaction list', { status: res.status });
        break;
      }
      body = await res.json();
    } catch (err) {
      log.warn('SePay could not be asked for the transaction list', { error: String(err?.name || 'error') });
      break;
    }
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    for (const row of rows) {
      if (!String(row?.reference_number ?? '').trim() || !(Number(row?.amount_in) > 0)) continue;
      try {
        const done = await takeTransfer(fromList(row), { via: 'poll', now: t, env });
        if (!done.repeat && done.outcome !== 'ignored') taken += 1;
      } catch (err) {
        log.warn('a polled SePay transfer could not be taken', { code: err?.code, error: String(err?.message || err).slice(0, 120) });
      }
    }
    if (!body?.meta?.pagination?.has_more) break;
  }
  return taken;
}

/**
 * Preview only: act as the bank for an order, with its code and what is still due. It goes through the same door as a
 * real transfer (`via: 'simulated'`), gets no receipt and is left out of the money figures. Who may ask is the route's call.
 */
export async function simulateTransfer(orderId, { now = Date.now(), env = process.env } = {}) {
  if (billingMode(env) !== 'preview') return { status: 409, error: 'Simulated transfers are only available in preview mode.' };
  const store = getStore();
  const at = atOf(now);
  const order = await store.getOrder(orderId);
  if (!order) return { status: 404, error: 'That order was not found.' };
  const due = order.status === 'pending' && order.expiresAt > at ? dueOf(order, (await store.billingState(order.userId)).balanceVnd) : 0;
  if (due <= 0) return { status: 409, error: 'This order has nothing left to pay.' };
  const done = await takeTransfer({
    id: null, referenceCode: `SIM-${crypto.randomUUID()}`, gateway: 'Simulated', transactionDate: vnStamp(at), accountNumber: String(env.SEPAY_BANK_ACCOUNT || ''),
    code: order.code, content: order.code, transferType: 'in', transferAmount: due,
  }, { via: 'simulated', now: at, env });
  return { status: 200, ...done };
}
