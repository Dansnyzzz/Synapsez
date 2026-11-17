/**
 * The SePay e-invoice client (spec B1, Task 8; research: docs/research/2026-11-12-sepay-einvoice.md). Built and tested against
 * recorded answers, and OFF until the owner has a tax code and a digital signature: `einvoiceEnabled` is true only when the
 * three SEPAY_EINVOICE_* variables are set, and with it false nothing here reaches SePay.
 *
 * What the rules of the API force on the design:
 *  - `reference_code` is the idempotency key, and it is the order's id: one invoice per order, and a second create is a 409.
 *  - An answer that did not confirm anything (a dropped connection, a 5xx with no `error.code`, SePay's own "not confirmed with
 *    the provider") is stored as `unknown` and the invoice is NEVER created again; only its status is asked. Sending it again
 *    could print a second signed invoice that cannot be taken back.
 *  - `issued_date` has to be today, and "today" is the Vietnamese day (a server in UTC is a day behind from 00:00 to 07:00).
 *  - The token lasts 24 h and has no refresh. It is cached for the seller's one set of credentials (not per user: no account's
 *    data is in it) until 5 minutes before it ends, and a 401 fetches a new one once.
 * Nothing here runs inside the SePay webhook: a create can take as long as SePay's own patience, and a webhook that waits on it
 * could time out and be sent again. The daily step (daily.js) issues, asks and retries, with a time budget and a cap.
 * Credentials, the token and the Authorization header are never logged or put in a stored message.
 */
import { getStore } from '../store/index.js';
import { decryptSecret } from '../crypto.js';
import { billingProfileContext } from '../secretContexts.js';
import { log } from '../util/trace.js';
import { vnDay } from './period.js';

const PRODUCTION = 'https://einvoice-api.sepay.vn';
const SANDBOX = 'https://einvoice-api-sandbox.sepay.vn';
const TIMEOUT_MS = 15_000;
const TOKEN_LIFE_MS = 24 * 3_600_000;
const TOKEN_SPARE_MS = 5 * 60_000;

/** True only with the client id, the secret and the template all set. */
export function einvoiceEnabled(env = process.env) {
  return ['SEPAY_EINVOICE_CLIENT_ID', 'SEPAY_EINVOICE_CLIENT_SECRET', 'SEPAY_EINVOICE_TEMPLATE'].every((name) => String(env[name] ?? '').trim() !== '');
}

const hostOf = (env) => (String(env.SEPAY_EINVOICE_SANDBOX ?? '').trim() === '1' ? SANDBOX : PRODUCTION);

/** The token in use: one seller, one credential. Kept per process only to save a call; losing it costs one call. */
const cache = { key: '', token: '', until: 0 };
export const _resetEinvoiceForTests = () => { cache.key = ''; cache.token = ''; cache.until = 0; };

/** The token could not be had: nothing about the invoice was sent. */
class TokenError extends Error {}

/** A text with the credentials and the token taken out, for anything stored or logged. */
function scrub(text, env) {
  let out = String(text ?? '');
  for (const secret of [env.SEPAY_EINVOICE_CLIENT_SECRET, env.SEPAY_EINVOICE_CLIENT_ID, cache.token]) {
    const s = String(secret ?? '');
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer ***').replace(/Basic\s+[\w+/=]+/gi, 'Basic ***');
}

/**
 * One request. Rejects only when no answer came back at all.
 * @param {any} env @param {any} fetchImpl
 * @param {{ method?: string, path: string, authorization?: string, body?: any }} options
 */
async function request(env, fetchImpl, { method = 'GET', path, authorization, body }) {
  const res = await fetchImpl(`${hostOf(env)}${path}`, {
    method,
    headers: { Authorization: authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (a gateway's page): the status alone is what there is.
  }
  return { status: res.status, json };
}

async function tokenFor(env, fetchImpl, now, { fresh = false } = {}) {
  const key = `${hostOf(env)}|${env.SEPAY_EINVOICE_CLIENT_ID}`;
  if (!fresh && cache.key === key && cache.token && +now < cache.until) return cache.token;
  let answer;
  try {
    const basic = Buffer.from(`${env.SEPAY_EINVOICE_CLIENT_ID}:${env.SEPAY_EINVOICE_CLIENT_SECRET}`).toString('base64');
    answer = await request(env, fetchImpl, { method: 'POST', path: '/v1/token', authorization: `Basic ${basic}` });
  } catch {
    throw new TokenError('SePay could not be reached to get a token.');
  }
  const token = answer.json?.data?.access_token;
  if (answer.status !== 200 || typeof token !== 'string' || !token) throw new TokenError(`SePay refused the e-invoice credentials (HTTP ${answer.status}).`);
  const life = Number(answer.json?.data?.expires_in) > 0 ? Number(answer.json.data.expires_in) * 1000 : TOKEN_LIFE_MS;
  Object.assign(cache, { key, token, until: +now + life - TOKEN_SPARE_MS });
  return token;
}

/** A call with the bearer token; a 401 (expired) gets one new token and one more try, which is safe: a 401 processed nothing. */
async function authed(env, fetchImpl, now, req) {
  let res = await request(env, fetchImpl, { ...req, authorization: `Bearer ${await tokenFor(env, fetchImpl, now)}` });
  if (res.status === 401) {
    _resetEinvoiceForTests();
    res = await request(env, fetchImpl, { ...req, authorization: `Bearer ${await tokenFor(env, fetchImpl, now, { fresh: true })}` });
  }
  return res;
}

const codeOf = (res) => (typeof res.json?.error?.code === 'string' ? res.json.error.code : '');
const reason = (res, env) => scrub(`${codeOf(res) || `HTTP ${res.status}`}: ${String(res.json?.error?.message ?? '').slice(0, 200)}`.replace(/: $/, ''), env);

/** What SePay's status answers mean for us: pending (still going), issued, or failed. */
function fromCheck(json) {
  const s = json?.data?.status;
  if (s === 'Success') return { status: 'issued', error: null };
  if (s === 'Failed') return { status: 'failed', error: String(json?.data?.message ?? 'SePay could not issue the invoice.').slice(0, 200) };
  if (s === 'Pending') return { status: 'pending', error: null };
  return null;
}

/** The invoice's own record (found by reference code): issued, still a draft, or cancelled. */
function fromDetail(json) {
  const s = json?.data?.status;
  if (s === 'issued') return { status: 'issued', error: null };
  if (s === 'draft') return { status: 'pending', error: null };
  if (s === 'cancelled') return { status: 'failed', error: 'The invoice was cancelled at SePay.' };
  return null;
}

/** The provider account's template and this year's series, read now because the series is year-bound (C26 in 2026). */
async function templateFor(env, fetchImpl, now) {
  const list = await authed(env, fetchImpl, now, { path: '/v1/provider-accounts?per_page=100' });
  const items = Array.isArray(list.json?.data?.items) ? list.json.data.items : Array.isArray(list.json?.data) ? list.json.data : [];
  const account = items.find((a) => a?.active !== false && a?.id);
  if (list.status !== 200 || !account) throw new Error('SePay lists no active e-invoice provider account.');
  const detail = await authed(env, fetchImpl, now, { path: `/v1/provider-accounts/${encodeURIComponent(account.id)}` });
  const templates = Array.isArray(detail.json?.data?.templates) ? detail.json.data.templates : [];
  const code = String(env.SEPAY_EINVOICE_TEMPLATE).trim();
  const year = `C${vnDay(now).slice(2, 4)}`;
  const mine = templates.filter((t) => String(t?.template_code) === code);
  const found = mine.find((t) => String(t?.invoice_series).includes(year));
  if (!found) throw new Error(`The provider account has no series ${year} for template ${code}.`);
  return { providerAccountId: String(account.id), templateCode: String(found.template_code), series: String(found.invoice_series) };
}

/** The buyer from an account's billing information, opened; null when there is none, the account is gone, or it will not open. */
export async function buyerFor(userId) {
  if (!userId) return null;
  try {
    const sealed = (await getStore().getBillingProfile(userId))?.sealed;
    return sealed ? JSON.parse(decryptSecret(sealed, billingProfileContext(userId)) || 'null') : null;
  } catch {
    return null; // the invoice goes out without a buyer rather than not at all
  }
}

/** What the invoice says was sold. */
function itemName(order) {
  if (order.kind === 'topup') return 'Nạp tiền vào số dư dịch vụ';
  const plan = order.plan ? String(order.plan).charAt(0).toUpperCase() + String(order.plan).slice(1) : '';
  return `Gói ${plan} (${order.period === 'year' ? 'năm' : 'tháng'})`;
}

/** The buyer as the invoice takes it; nothing is required, so an account with no billing information is a private buyer. */
function buyerBody(buyer) {
  if (!buyer) return { type: 'personal' };
  const taxCode = buyer.taxCode ? String(buyer.taxCode) : '';
  // "Another name on the invoice" is what the buyer is called on it; the company name is the legal name that goes with a tax code.
  const called = buyer.invoiceName || buyer.name;
  return {
    type: taxCode ? 'company' : 'personal',
    ...(called ? { name: String(called), ...(taxCode ? { legal_name: String(buyer.companyName || buyer.name || called) } : {}) } : {}),
    ...(taxCode ? { tax_code: taxCode } : {}),
    ...(buyer.address ? { address: String(buyer.address) } : {}),
    ...(buyer.email ? { email: String(buyer.email) } : {}),
  };
}

/**
 * Ask SePay to issue the invoice for a paid order, once. Never throws: the answer is the stored row. An order that already has a
 * row (any status but `error`) is not sent again.
 *
 * @param {{ id: string, kind: string, plan?: string | null, period?: string | null, totalVnd: number }} order
 * @param {{ name?: string, email?: string, address?: string | null, taxCode?: string | null, companyName?: string | null, invoiceName?: string | null } | null} buyer
 * @param {{ now?: Date, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [options]
 */
export async function issueEinvoice(order, buyer, { now = new Date(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!einvoiceEnabled(env)) return null;
  const store = getStore();
  const referenceCode = String(order.id);
  const existing = await store.getEinvoice(order.id);
  if (existing && existing.status !== 'error') return existing;
  const save = (fields) => store.saveEinvoice({ orderId: order.id, referenceCode, ...fields });

  let where;
  try {
    where = await templateFor(env, fetchImpl, now);
  } catch (err) {
    // Nothing was created yet, so this is safe to try again later.
    return save({ status: 'error', error: scrub(err?.message, env) });
  }

  const rate = String(env.BILLING_TAX_RATE ?? '').trim() === '' ? NaN : Number(env.BILLING_TAX_RATE);
  const body = {
    template_code: where.templateCode, invoice_series: where.series, provider_account_id: where.providerAccountId,
    issued_date: `${vnDay(now)} ${new Date(+now + 7 * 3_600_000).toISOString().slice(11, 19)}`,
    currency: 'VND', reference_code: referenceCode, payment_method: 'CK', is_draft: false, buyer: buyerBody(buyer),
    items: [{
      line_number: 1, line_type: 1, item_name: itemName(order), unit: 'lần', quantity: 1, unit_price: order.totalVnd,
      ...(Number.isFinite(rate) ? { tax_rate: rate } : {}),
    }],
    total_amount: order.totalVnd,
  };

  let res;
  try {
    res = await authed(env, fetchImpl, now, { method: 'POST', path: '/v1/invoices/create', body });
  } catch (err) {
    if (err instanceof TokenError) return save({ status: 'error', error: scrub(err.message, env) });
    // The request may or may not have arrived. It is never sent again; only asked about.
    log.warn('an e-invoice request got no answer; it will only be asked about from now on', { order: order.id });
    return save({ status: 'unknown', error: 'SePay gave no answer to the create request; its status is asked, it is never sent again.' });
  }

  const tracking = res.json?.data?.tracking_code;
  if (res.status >= 200 && res.status < 300 && typeof tracking === 'string' && tracking) return save({ status: 'pending', trackingCode: tracking });
  if (res.status === 409) {
    // It exists already (a repeat of ours, or a crash between SePay's answer and our save): learn where it has got to.
    const found = await ask(env, fetchImpl, now, `/v1/invoices/${encodeURIComponent(referenceCode)}`, fromDetail);
    return save({ status: found?.status ?? 'pending', error: found?.error ?? null });
  }
  const unconfirmed = res.status >= 500 && /chưa xác nhận/i.test(String(res.json?.error?.message ?? ''));
  if (res.status >= 500 && (!codeOf(res) || unconfirmed) || (res.status >= 200 && res.status < 300)) {
    log.warn('an e-invoice request was not confirmed; it will only be asked about from now on', { order: order.id, status: res.status });
    return save({ status: 'unknown', error: 'SePay did not confirm the create request; its status is asked, it is never sent again.' });
  }
  if (codeOf(res) === 'REGISTRATION_NOT_TAX_APPROVED') {
    const text = 'REGISTRATION_NOT_TAX_APPROVED: the tax authority has not approved the e-invoice registration yet. Nothing was issued; finish the registration with SePay.';
    log.warn('e-invoices are refused: the tax registration is not approved yet', { order: order.id });
    return save({ status: 'error', error: text });
  }
  log.warn('an e-invoice was refused', { order: order.id, status: res.status, code: codeOf(res) });
  return save({ status: 'error', error: reason(res, env) });
}

/** One status question; null when SePay does not know it or does not answer (the row then stays as it is). */
async function ask(env, fetchImpl, now, path, mapper) {
  try {
    const res = await authed(env, fetchImpl, now, { path });
    return res.status === 200 ? mapper(res.json) : null;
  } catch {
    return null;
  }
}

/**
 * The stored invoice of an order, brought up to date from SePay when it is not finished. A row that is `issued`, `failed` or an
 * `error` is final here (an `error` is a refusal, retried only by asking `issueEinvoice` again); the others are asked about.
 *
 * @param {string} orderId
 * @param {{ now?: Date, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [options]
 */
export async function einvoiceStatus(orderId, { now = new Date(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const store = getStore();
  const row = await store.getEinvoice(orderId);
  if (!row || !einvoiceEnabled(env) || !['pending', 'unknown'].includes(row.status)) return row;
  const found = row.trackingCode
    ? await ask(env, fetchImpl, now, `/v1/invoices/create/check/${encodeURIComponent(row.trackingCode)}`, fromCheck)
    : await ask(env, fetchImpl, now, `/v1/invoices/${encodeURIComponent(row.referenceCode)}`, fromDetail);
  if (!found || (found.status === row.status && !found.error)) return row;
  return store.saveEinvoice({ orderId, referenceCode: row.referenceCode, trackingCode: row.trackingCode, status: found.status, error: found.error });
}

/**
 * The issued invoice as a PDF, from SePay (never SePay's public link: the route checks the owner, and the file is fetched with
 * the token). Null when there is none to give yet.
 *
 * @param {string} orderId
 * @param {{ now?: Date, fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<Buffer | null>}
 */
export async function einvoicePdf(orderId, { now = new Date(), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const row = await getStore().getEinvoice(orderId);
  if (!row || row.status !== 'issued' || !einvoiceEnabled(env)) return null;
  let res;
  try {
    res = await authed(env, fetchImpl, now, { path: `/v1/invoices/${encodeURIComponent(row.trackingCode || row.referenceCode)}/download?type=pdf` });
  } catch {
    throw Object.assign(new Error('The invoice could not be fetched from SePay just now. Try again in a moment.'), { status: 503 });
  }
  if (res.status === 404) return null;
  const content = res.json?.data?.content ?? res.json?.content;
  if (res.status !== 200 || typeof content !== 'string') throw Object.assign(new Error('The invoice could not be fetched from SePay just now. Try again in a moment.'), { status: 503 });
  const bytes = Buffer.from(content, 'base64');
  return bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? bytes : null;
}
