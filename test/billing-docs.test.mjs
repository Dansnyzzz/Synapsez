/**
 * Billing documents (spec B1, Task 8): receipts drawn as PDFs, and the SePay e-invoice client, tested against recorded answers
 * (nothing leaves the machine) and left off unless the three SEPAY_EINVOICE_* variables are set.
 *
 *   node test/billing-docs.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'billing-docs-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'billing-docs-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-billing-docs-test-${process.pid}`);
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'BILLING_TAX_RATE', 'BILLING_SELLER_NAME', 'SEPAY_API_TOKEN', 'SEPAY_EINVOICE_CLIENT_ID', 'SEPAY_EINVOICE_CLIENT_SECRET', 'SEPAY_EINVOICE_TEMPLATE', 'SEPAY_EINVOICE_SANDBOX', 'E2B_API_KEY', 'RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD']) delete process.env[name];
process.env.SEPAY_BANK_ACCOUNT = '0123456789';
process.env.SEPAY_BANK_CODE = 'MBBank';
process.env.SEPAY_ACCOUNT_NAME = 'EPHAPSE TEST';
process.env.EMAIL_CONFIRMATION = 'off';
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/* ── the outside world: the rate source, and SePay's e-invoice API as recorded ─────────────── */
const realFetch = globalThis.fetch;
const outside = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FAKE_PDF = Buffer.from('%PDF-1.4\n% an invoice as SePay would send it\n%%EOF\n');
let einvoiceRoutes = (_req) => json({ error: { code: 'NOPE' } }, 404);
globalThis.fetch = async (url, options) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, options);
  outside.push(`${u.host}${u.pathname}`);
  if (u.host === 'open.er-api.com') return json({ result: 'success', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { VND: 25_500 } });
  if (u.host.startsWith('einvoice-api')) return einvoiceRoutes({ method: options?.method || 'GET', url: u, headers: options?.headers || {}, body: options?.body ? JSON.parse(options.body) : null });
  throw new TypeError('fetch failed');
};

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword, encryptSecret } = await import('../server/crypto.js');
const { billingProfileContext } = await import('../server/secretContexts.js');
const { extractPdfText } = await import('../server/pdf.js');
const { drawReceipt, money } = await import('../server/billing/receipt.js');
const einvoice = await import('../server/billing/einvoice.js');
const { takeTransfer } = await import('../server/billing/sepay.js');
const orders = await import('../server/billing/orders.js');
const { billingTick, einvoiceStep } = await import('../server/billing/daily.js');
const { LIMITS } = await import('../server/ratelimit.js');
const { setPrefs } = await import('../server/settings.js');

const PORT = 5239;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;
function jar(ip) {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await realFetch(`${base}${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'x-real-ip': ip } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const bytes = Buffer.from(await res.arrayBuffer());
      let parsed = null;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
      return { status: res.status, json: parsed, headers: res.headers, bytes };
    },
  };
}
const password = 'billing-docs-long-enough-password';
let seq = 0;
async function account(name, { role = 'user' } = {}) {
  seq += 1;
  const row = await store.createUser({ id: `bd-${name}`, email: `${name}@example.test`, name, passwordHash: await hashPassword(password), role });
  const j = jar(`10.88.${seq}.1`);
  const login = await j.call('POST', '/api/login', { email: `${name}@example.test`, password });
  if (login.status !== 200) throw new Error(`login ${name}: ${login.status}`);
  return { id: row.id, email: `${name}@example.test`, j };
}
const sealedBuyer = (userId, buyer) => encryptSecret(JSON.stringify(buyer), billingProfileContext(userId));
const textOf = async (pdf) => (await extractPdfText(pdf))?.text || '';
const squash = (s) => s.replace(/\s+/g, ' ');

const owner = await account('owner', { role: 'admin' });
const other = await account('other', { role: 'admin' });
const member = await account('member');

/* ── receipts ─────────────────────────────────────────────────────── */
section('the receipt is a PDF with what a receipt must say');
{
  const buyer = { name: 'Trần Văn Ánh', email: 'anh@example.test', country: 'VN', address: '12 Lê Lợi, Quận 1, TP. Hồ Chí Minh', taxCode: '0312345678' };
  const receipt = { number: 'SZR-2026-000042', userId: owner.id, transferId: 7, orderId: 'o-1', amountVnd: 129_000, issuedAt: new Date('2026-11-13T17:30:00Z'), buyerSealed: sealedBuyer(owner.id, buyer), lines: [{ kind: 'plan', plan: 'plus', period: 'month', code: 'SZ0123456789', amountVnd: 129_000 }] };
  const vi = await drawReceipt(receipt, { language: 'vi', env: {} });
  const viText = squash(await textOf(vi));
  check('it starts with %PDF-', Buffer.isBuffer(vi) && vi.subarray(0, 5).toString() === '%PDF-');
  check('  the number is on it', viText.includes('SZR-2026-000042'), viText.slice(0, 120));
  check('  the "not a VAT invoice" line, with its diacritics', viText.includes('Biên nhận thanh toán — không phải hoá đơn GTGT.'), viText.slice(-160));
  check('  the title and the way it was paid', viText.includes('Biên nhận thanh toán') && viText.includes('Chuyển khoản ngân hàng qua SePay (VietQR)'));
  check('  the amount written 129.000 ₫', viText.includes('129.000 ₫'), viText);
  check('  the Vietnamese date and time (14/11/2026, 00:30 in Vietnam)', /14\/11\/2026/.test(viText) && /00:30/.test(viText), viText);
  check('  the buyer opened from the sealed copy, stacked vowels intact', viText.includes('Trần Văn Ánh') && viText.includes('12 Lê Lợi') && viText.includes('0312345678'), viText);
  check('  the reference and the seller (Ephapse by default)', viText.includes('SZ0123456789') && viText.includes('Ephapse'));
  check('  the plan line', viText.includes('Gói Plus (tháng)'));
  check('  no tax line without BILLING_TAX_RATE', !/Trong đó thuế/.test(viText));

  const en = squash(await textOf(await drawReceipt(receipt, { language: 'en', env: {}, seller: 'Acme Ltd' })));
  check('English: title, the line, the amount as 129,000 ₫, the seller from the option', en.includes('Payment receipt') && en.includes('Payment receipt — not a VAT invoice.') && en.includes('129,000 ₫') && en.includes('Bank transfer via SePay (VietQR)') && en.includes('Acme Ltd'), en);
  check('money() writes both ways', money(129_000, 'vi') === '129.000 ₫' && money(129_000, 'en') === '129,000 ₫' && money(0, 'vi') === '0 ₫');

  const taxed = squash(await textOf(await drawReceipt(receipt, { language: 'vi', env: { BILLING_TAX_RATE: '10', BILLING_SELLER_NAME: 'Công ty Mẫu' } })));
  check('with BILLING_TAX_RATE a tax line appears (of the total, tax included), and the seller comes from the environment', taxed.includes('thuế GTGT 10%') && taxed.includes('11.727 ₫') && taxed.includes('Công ty Mẫu'), taxed);
  const creditOnly = squash(await textOf(await drawReceipt({ ...receipt, lines: [{ kind: 'credit', plan: null, period: null, code: 'SZ0123456789', amountVnd: 129_000 }] }, { language: 'vi', env: { BILLING_TAX_RATE: '10' } })));
  const { taxRate, taxIn } = await import('../server/billing/tax.js');
  check('the one tax formula: a rate from the environment (null when unset, blank or not a number) and the tax inside a total', taxRate({}) === null && taxRate({ BILLING_TAX_RATE: '  ' }) === null && taxRate({ BILLING_TAX_RATE: 'ten' }) === null && taxRate({ BILLING_TAX_RATE: '-1' }) === null && taxRate({ BILLING_TAX_RATE: '8' }) === 8 && taxRate({ BILLING_TAX_RATE: '0' }) === 0 && taxIn(129_000, 10) === 11_727 && taxIn(129_000.9, 10) === 11_727 && taxIn(110, 10) === 10 && taxIn(0, 10) === 0);
  check('a credit-only receipt (money added to the balance) has no VAT line even when a rate is set', creditOnly.includes('Tiền đã chuyển vào số dư') && !creditOnly.includes('Trong đó thuế'), creditOnly);
  const many = squash(await textOf(await drawReceipt({ ...receipt, lines: Array.from({ length: 60 }, (_, i) => ({ kind: 'topup', plan: null, period: null, code: 'SZ0123456789', amountVnd: 1000 + i })) }, { language: 'en', env: {} })));
  check('a receipt with far more lines than a page holds keeps its footer and says how many it left out', many.includes('Payment receipt — not a VAT invoice.') && /and [0-9]+ more/.test(many), many.slice(-200));
  const bad = squash(await textOf(await drawReceipt(receipt, { language: 'vi', env: { BILLING_TAX_RATE: 'ten' } })));
  check('  a rate that is not a number draws none', !bad.includes('Trong đó thuế'));

  const gone = await drawReceipt({ ...receipt, userId: null, buyerSealed: null }, { language: 'vi', env: {} });
  const goneText = squash(await textOf(gone));
  check('a receipt whose account was deleted says the buyer was removed, and still renders', gone.subarray(0, 5).toString() === '%PDF-' && goneText.includes('Người mua đã được xoá') && !goneText.includes('Trần Văn Ánh'), goneText);
  const goneEn = squash(await textOf(await drawReceipt({ ...receipt, userId: null, buyerSealed: null }, { language: 'en', env: {} })));
  check('  in English too', goneEn.includes('The buyer was removed'));
  const none = squash(await textOf(await drawReceipt({ ...receipt, buyerSealed: null }, { language: 'en', env: {} })));
  check('an account that never gave billing information gets a receipt that says none was given', none.includes('No buyer details were given') && !none.includes('removed'));
  const wrong = squash(await textOf(await drawReceipt({ ...receipt, buyerSealed: sealedBuyer('someone-else', buyer) }, { language: 'en', env: {} })));
  check('a sealed copy that will not open for this account is not shown', !wrong.includes('Trần') && wrong.includes('No buyer details'));
  const a4 = vi.toString('latin1');
  check('the page is A4 (595 x 842)', /\/MediaBox\s*\[\s*0\s+0\s+595(\.0+)?\s+842(\.0+)?\s*\]/.test(a4), (a4.match(/MediaBox[^\]]*\]/) || ['none'])[0]);
}

section('a receipt for money that came late describes no purchase');
{
  const late = await account('late', { role: 'admin' });
  const stale = await orders.createOrder(late.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: new Date(Date.now() - 2 * 3_600_000) });
  const taken = await takeTransfer({ id: null, referenceCode: 'DOCS-LATE-1', gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: stale.order.code, content: stale.order.code, transferType: 'in', transferAmount: 130_000 }, { via: 'webhook' });
  const rc = (await store.listReceipts(late.id))[0];
  check('the transfer was late', taken.outcome === 'late', taken.outcome);
  check('  its receipt line says money added to the balance, not a plan', rc?.lines?.length === 1 && rc.lines[0].kind === 'credit' && rc.lines[0].plan === null, JSON.stringify(rc?.lines));
  const text = squash(await textOf(await drawReceipt(rc, { language: 'vi', env: {} })));
  check('  and the PDF reads so', text.includes('Tiền đã chuyển vào số dư') && !text.includes('Gói Plus'), text);

  const live = await orders.createOrder((await account('paid2', { role: 'admin' })).id, { kind: 'plan', plan: 'plus', period: 'month' });
  const paid = await takeTransfer({ id: null, referenceCode: 'DOCS-OK-1', gateway: 'Bank', transactionDate: '2026-11-13 10:05:00', accountNumber: '0123456789', code: live.order.code, content: live.order.code, transferType: 'in', transferAmount: live.order.totalVnd }, { via: 'webhook' });
  const rc2 = await store.receiptForTransfer(paid.transferId);
  const full = await store.getReceipt(rc2.number);
  check('a transfer that paid the plan still says the plan', paid.outcome === 'applied' && full.lines[0].kind === 'plan' && full.lines[0].plan === 'plus', `${paid.outcome} ${JSON.stringify(full.lines)}`);
}

/* ── the receipt route ───────────────────────────────────────────── */
section('GET /api/billing/receipts/:number.pdf');
{
  const made = await store.createReceipt({ userId: owner.id, amountVnd: 70_000, lines: [{ kind: 'topup', plan: null, period: null, code: 'SZ1111111111', amountVnd: 70_000 }], buyerSealed: sealedBuyer(owner.id, { name: 'Owner Person', email: 'o@example.test', country: 'VN' }) });
  const res = await owner.j.call('GET', `/api/billing/receipts/${made.number}.pdf`);
  check('the owner gets a PDF', res.status === 200 && res.bytes.subarray(0, 5).toString() === '%PDF-', `${res.status}`);
  check('  with the headers the brief names', res.headers.get('content-type') === 'application/pdf' && res.headers.get('content-disposition') === `attachment; filename="${made.number}.pdf"` && res.headers.get('cache-control') === 'no-store', [...res.headers.entries()].filter(([k]) => /content|cache/.test(k)).join(' | '));
  const read = squash(await textOf(res.bytes));
  check('  and it is this receipt, in English for an account that did not choose Vietnamese', read.includes(made.number) && read.includes('Payment receipt') && read.includes('70,000 ₫') && read.includes('Owner Person'), read);
  await setPrefs(owner.id, { language: 'vi' });
  const inVi = squash(await textOf((await owner.j.call('GET', `/api/billing/receipts/${made.number}.pdf`)).bytes));
  check('  and in Vietnamese once the account chose it', inVi.includes('Biên nhận thanh toán') && inVi.includes('70.000 ₫'), inVi);
  await setPrefs(owner.id, { language: 'en' });
  const other404 = await other.j.call('GET', `/api/billing/receipts/${made.number}.pdf`);
  check("another account's receipt is a 404 (numbers are guessable)", other404.status === 404 && !other404.bytes.toString().includes('%PDF'), `${other404.status}`);
  check('  so is one that does not exist', (await owner.j.call('GET', '/api/billing/receipts/SZR-2026-999999.pdf')).status === 404);
  check('  and a member (billing is not theirs) gets a 404', (await member.j.call('GET', `/api/billing/receipts/${made.number}.pdf`)).status === 404);
  const orphan = await store.createReceipt({ userId: null, amountVnd: 5_000, lines: [], buyerSealed: null });
  check("  a deleted account's receipt has no owner left to ask for it", (await owner.j.call('GET', `/api/billing/receipts/${orphan.number}.pdf`)).status === 404);
  const anon = await realFetch(`${base}/api/billing/receipts/${made.number}.pdf`);
  check('  nobody signed in gets no PDF', anon.status === 401 || anon.status === 403 || anon.status === 404, `${anon.status}`);
  process.env.BILLING_MODE = 'off';
  check('  with billing off it is a 404 for everyone', (await owner.j.call('GET', `/api/billing/receipts/${made.number}.pdf`)).status === 404);
  delete process.env.BILLING_MODE;
  check('the download is limited per account', LIMITS['billing-pdf']?.limit === 30 && LIMITS['billing-pdf'].windowMs === 60_000);
}

/* ── the e-invoice client, against recorded answers ───────────────── */
const ENV = { SEPAY_EINVOICE_CLIENT_ID: 'client-id-xyz', SEPAY_EINVOICE_CLIENT_SECRET: 'client-secret-abc', SEPAY_EINVOICE_TEMPLATE: '2' };
const NOW = new Date('2026-11-13T17:30:00Z'); // 00:30 on 14 November in Vietnam
const calls = [];
let tokens = 0;
/** SePay as recorded; `create` is what answers the create call. */
function recorded(create) {
  return async (url, options = {}) => {
    const u = new URL(String(url));
    const req = { method: options.method || 'GET', path: u.pathname + u.search, host: u.host, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
    calls.push(req);
    if (req.path === '/v1/token') {
      tokens += 1;
      return json({ success: true, data: { access_token: `jwt-${tokens}.secret.part`, token_type: 'Bearer', expires_in: 86400 } });
    }
    if (req.path.startsWith('/v1/provider-accounts?')) return json({ success: true, data: { items: [{ id: 'acc-1', provider: 'matbao', active: true, tax_authority_approved_date: '2026-01-01' }] } });
    if (req.path === '/v1/provider-accounts/acc-1') return json({ success: true, data: { id: 'acc-1', templates: [{ template_code: '1', invoice_series: 'C26TSE', invoice_label: 'VAT' }, { template_code: '2', invoice_series: 'C25TSE', invoice_label: 'old' }, { template_code: '2', invoice_series: 'C26TSE', invoice_label: 'Sales' }] } });
    return create(req);
  };
}
const created = () => calls.filter((c) => c.path === '/v1/invoices/create');
const reset = () => { calls.length = 0; tokens = 0; einvoice._resetEinvoiceForTests(); };
const order = (id) => ({ id, kind: 'plan', plan: 'plus', period: 'month', totalVnd: 129_000 });
const buyerIn = { name: 'Trần Văn Ánh', email: 'anh@example.test', address: '12 Lê Lợi', taxCode: null };

section('einvoiceEnabled');
{
  check('false with nothing', einvoice.einvoiceEnabled({}) === false);
  check('false with any one of the three missing', ['SEPAY_EINVOICE_CLIENT_ID', 'SEPAY_EINVOICE_CLIENT_SECRET', 'SEPAY_EINVOICE_TEMPLATE'].every((k) => einvoice.einvoiceEnabled({ ...ENV, [k]: '' }) === false && einvoice.einvoiceEnabled({ ...ENV, [k]: '  ' }) === false));
  check('true with all three', einvoice.einvoiceEnabled(ENV) === true);
  check('false by default in this process', einvoice.einvoiceEnabled() === false);
  reset();
  const none = await einvoice.issueEinvoice(order('off-1'), buyerIn, { now: NOW, env: {}, fetchImpl: recorded(() => { throw new Error('must not be asked'); }) });
  check('issueEinvoice with it off sends nothing and stores nothing', none === null && calls.length === 0 && (await store.getEinvoice('off-1')) === null);
}

section('issueEinvoice: the happy path');
{
  reset();
  const row = await einvoice.issueEinvoice(order('inv-1'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-1', tracking_url: '/v1/invoices/create/check/trk-1', message: 'accepted' } })) });
  const call = created()[0];
  check('create 200: pending, with the tracking code, stored', row?.status === 'pending' && row.trackingCode === 'trk-1' && row.referenceCode === 'inv-1' && (await store.getEinvoice('inv-1'))?.trackingCode === 'trk-1', JSON.stringify(row));
  check('  the token was asked with Basic auth, an empty body, on the production host', calls[0].path === '/v1/token' && calls[0].method === 'POST' && calls[0].host === 'einvoice-api.sepay.vn' && calls[0].headers.Authorization === `Basic ${Buffer.from('client-id-xyz:client-secret-abc').toString('base64')}` && calls[0].body === null);
  check('  the create call carries the Bearer token', call.headers.Authorization === 'Bearer jwt-1.secret.part');
  check('  reference_code is the order id', call.body.reference_code === 'inv-1');
  check('  issued_date is the Vietnamese day at 00:30 (not the UTC day)', call.body.issued_date === '2026-11-14 00:30:00', call.body.issued_date);
  check("  template and this year's series come from the provider account, not hard-coded", call.body.template_code === '2' && call.body.invoice_series === 'C26TSE' && call.body.provider_account_id === 'acc-1', JSON.stringify([call.body.template_code, call.body.invoice_series]));
  check('  a real boolean is_draft, VND, bank transfer, the whole amount as an integer', call.body.is_draft === false && call.body.currency === 'VND' && call.body.payment_method === 'CK' && call.body.total_amount === 129_000 && call.body.items[0].unit_price === 129_000 && call.body.items[0].quantity === 1);
  check('  the buyer is a private person without a tax code', call.body.buyer.type === 'personal' && call.body.buyer.name === 'Trần Văn Ánh' && !('tax_code' in call.body.buyer));
  check('  no tax_rate unless the seller set one', !('tax_rate' in call.body.items[0]));

  const again = await einvoice.issueEinvoice(order('inv-1'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => { throw new Error('must not be sent again'); }) });
  check('an order that has an invoice is not sent twice', again.status === 'pending' && created().length === 1);
  check('the token was fetched once and used for every call', tokens === 1);
  const company = await einvoice.issueEinvoice(order('inv-co'), { name: 'Công ty ABC', taxCode: '0312345678', address: 'Hà Nội', email: 'ketoan@abc.test' }, { now: NOW, env: { ...ENV, BILLING_TAX_RATE: '8' }, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-co' } })) });
  const cb = created().at(-1).body;
  check('a buyer with a tax code is a company, and a seller-set rate goes on the line', company.status === 'pending' && cb.buyer.type === 'company' && cb.buyer.tax_code === '0312345678' && cb.buyer.legal_name === 'Công ty ABC' && cb.items[0].tax_rate === 8);
  const noBuyer = await einvoice.issueEinvoice(order('inv-nb'), null, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-nb' } })) });
  check('an order with no billing information still gets an invoice (nothing in buyer is required)', noBuyer.status === 'pending' && created().at(-1).body.buyer.type === 'personal');

  // The checkout form's two optional names: "another name on the invoice" is what the buyer is called; the company name is the legal one.
  const mk = async (id, buyer) => {
    await einvoice.issueEinvoice(order(id), buyer, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: `trk-${id}` } })) });
    return created().at(-1).body.buyer;
  };
  const both = await mk('inv-names', { name: 'Trần Văn Ánh', invoiceName: 'Kế toán ABC', companyName: 'Công ty ABC', taxCode: '0312345678', email: 'k@abc.test' });
  check('with a tax code: the invoice name is the buyer, the company name the legal name, the tax code kept', both.type === 'company' && both.name === 'Kế toán ABC' && both.legal_name === 'Công ty ABC' && both.tax_code === '0312345678', JSON.stringify(both));
  const noInv = await mk('inv-co-only', { name: 'Trần Văn Ánh', companyName: 'Công ty ABC', taxCode: '0312345678' });
  check('  without another invoice name the buyer is the person, the legal name still the company', noInv.name === 'Trần Văn Ánh' && noInv.legal_name === 'Công ty ABC', JSON.stringify(noInv));
  const noCo = await mk('inv-inv-only', { name: 'Trần Văn Ánh', invoiceName: 'Kế toán ABC', taxCode: '0312345678' });
  check('  without a company name the legal name is the name of the person, as before', noCo.name === 'Kế toán ABC' && noCo.legal_name === 'Trần Văn Ánh', JSON.stringify(noCo));
  const priv = await mk('inv-private', { name: 'Trần Văn Ánh', invoiceName: 'Anh T.', companyName: 'Công ty ABC' });
  check('  without a tax code it is a private buyer under the invoice name, and no legal name', priv.type === 'personal' && priv.name === 'Anh T.' && !('legal_name' in priv) && !('tax_code' in priv), JSON.stringify(priv));
  const plain = await mk('inv-plain', { name: 'Trần Văn Ánh', email: 'anh@example.test' });
  check('  neither name given: exactly as before', plain.name === 'Trần Văn Ánh' && plain.type === 'personal', JSON.stringify(plain));
}

section('the token is cached until five minutes before its 24 hours');
{
  reset();
  const f = recorded(() => json({ success: true, data: { tracking_code: 'trk-t' } }));
  await einvoice.issueEinvoice(order('tok-1'), null, { now: NOW, env: ENV, fetchImpl: f });
  await einvoice.issueEinvoice(order('tok-2'), null, { now: new Date(+NOW + 23 * 3_600_000), env: ENV, fetchImpl: f });
  check('23 hours later it is the same token', tokens === 1);
  await einvoice.issueEinvoice(order('tok-3'), null, { now: new Date(+NOW + 24 * 3_600_000 - 4 * 60_000), env: ENV, fetchImpl: f });
  check('4 minutes before the 24 hours it is asked again', tokens === 2, String(tokens));
  let expired = true;
  const g = recorded((req) => {
    if (expired && req.headers.Authorization === 'Bearer jwt-2.secret.part') { expired = false; return json({ success: false, error: { code: 'TOKEN_EXPIRED', message: 'expired' } }, 401); }
    return json({ success: true, data: { tracking_code: 'trk-401' } });
  });
  const r = await einvoice.issueEinvoice(order('tok-4'), null, { now: new Date(+NOW + 24 * 3_600_000 - 4 * 60_000 + 1000), env: ENV, fetchImpl: g });
  check('a 401 gets one new token and one more try (a 401 processed nothing)', r.status === 'pending' && r.trackingCode === 'trk-401' && tokens === 3, `${r.status} ${tokens}`);
}

section('issueEinvoice: what the errors become');
{
  reset();
  const exists = await einvoice.issueEinvoice(order('inv-409'), buyerIn, {
    now: NOW, env: ENV,
    fetchImpl: recorded((req) => (req.path === '/v1/invoices/create' ? json({ success: false, error: { code: 'EINVOICE_DOCUMENT_EXISTED', message: 'exists' } }, 409) : json({ success: true, data: { reference_code: 'inv-409', status: 'issued' } }))),
  });
  check('a 409 means it exists: its status is fetched by reference code and stored', exists.status === 'issued' && calls.some((c) => c.method === 'GET' && c.path === '/v1/invoices/inv-409') && created().length === 1, JSON.stringify(exists));

  reset();
  const quota = await einvoice.issueEinvoice(order('inv-500'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: false, error: { code: 'QUOTA_HAS_BEEN_USERD_UP', message: 'No quota left' } }, 500)) });
  check('a 500 with an error.code is a stored error (a known refusal, nothing issued)', quota.status === 'error' && /QUOTA_HAS_BEEN_USERD_UP/.test(quota.error), JSON.stringify(quota));
  const retry = await einvoice.issueEinvoice(order('inv-500'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-r' } })) });
  check('  and an error may be asked for again (it processed nothing)', retry.status === 'pending' && retry.trackingCode === 'trk-r');

  reset();
  const reg = await einvoice.issueEinvoice(order('inv-422'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: false, error: { code: 'REGISTRATION_NOT_TAX_APPROVED', message: 'CQT chua duyet' } }, 422)) });
  check('422 REGISTRATION_NOT_TAX_APPROVED is stored with a plain message for the owner', reg.status === 'error' && /REGISTRATION_NOT_TAX_APPROVED/.test(reg.error) && /not approved the e-invoice registration/.test(reg.error), reg.error);

  reset();
  let attempts = 0;
  const lost = await einvoice.issueEinvoice(order('inv-net'), buyerIn, {
    now: NOW, env: ENV,
    fetchImpl: recorded(() => { attempts += 1; throw new TypeError('fetch failed'); }),
  });
  check('a network error on the create call is stored as unknown', lost.status === 'unknown' && attempts === 1, JSON.stringify(lost));
  const second = await einvoice.issueEinvoice(order('inv-net'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => { attempts += 1; return json({ success: true, data: { tracking_code: 'DOUBLE' } }); }) });
  check('  and a second issueEinvoice sends NOTHING', second.status === 'unknown' && attempts === 1 && created().length === 1);

  reset();
  const five = await einvoice.issueEinvoice(order('inv-5xx'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => new Response('<html>Bad gateway</html>', { status: 502 })) });
  check('a 5xx with no error.code is unknown too', five.status === 'unknown');
  const sure = await einvoice.issueEinvoice(order('inv-unsure'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: false, error: { code: 'PROVIDER_ERROR', message: 'Hệ thống chưa xác nhận được kết quả phát hành với nhà cung cấp hóa đơn' } }, 500)) });
  check("  and so is SePay's own 'not confirmed with the provider' answer, whatever its code", sure.status === 'unknown');
  const vague = await einvoice.issueEinvoice(order('inv-200'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true })) });
  check('  and a 200 that names no tracking code', vague.status === 'unknown');

  reset();
  const noToken = await einvoice.issueEinvoice(order('inv-tok'), buyerIn, { now: NOW, env: ENV, fetchImpl: async () => json({ success: false, error: { code: 'UNAUTHORIZED', message: 'bad client' } }, 401) });
  check('credentials SePay refuses: an error before anything was created (so it can be retried), with no secret in it', noToken.status === 'error' && !/client-secret-abc|client-id-xyz/.test(JSON.stringify(noToken)), JSON.stringify(noToken));
  reset();
  const down = await einvoice.issueEinvoice(order('inv-down'), buyerIn, { now: NOW, env: ENV, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  check('SePay unreachable before the create is an error, not unknown (nothing could have been created)', down.status === 'error');
  const echo = await einvoice.issueEinvoice(order('inv-echo'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ error: { code: 'BAD', message: 'rejected client-secret-abc with Bearer jwt-1.secret.part' } }, 400)) });
  check('a message that echoes the secret or the token is scrubbed before it is stored', echo.status === 'error' && !/client-secret-abc|jwt-1\.secret\.part/.test(echo.error), echo.error);
  reset();
  const sandboxed = [];
  await einvoice.issueEinvoice(order('inv-sbx'), buyerIn, { now: NOW, env: { ...ENV, SEPAY_EINVOICE_SANDBOX: '1' }, fetchImpl: async (url) => { sandboxed.push(new URL(String(url)).host); return json({}, 500); } });
  check('SEPAY_EINVOICE_SANDBOX=1 uses the sandbox host', sandboxed.length > 0 && sandboxed.every((h) => h === 'einvoice-api-sandbox.sepay.vn'), sandboxed.join());
  const noYear = await einvoice.issueEinvoice(order('inv-yr'), buyerIn, { now: new Date('2027-03-01T05:00:00Z'), env: ENV, fetchImpl: recorded(() => { throw new Error('must not create without a series for the year'); }) });
  check("without this year's series the invoice is an error (nothing sent), not a rejected create", noYear.status === 'error' && /C27/.test(noYear.error), noYear.error);
}

section('einvoiceStatus and einvoicePdf');
{
  reset();
  await einvoice.issueEinvoice(order('st-1'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-st' } })) });
  let answer = { success: true, data: { reference_code: 'st-1', status: 'Pending', message: 'queued' } };
  const asked = (status) => recorded((req) => (req.path === '/v1/invoices/create/check/trk-st' ? json(answer, status) : json({}, 404)));
  check('still pending stays pending', (await einvoice.einvoiceStatus('st-1', { now: NOW, env: ENV, fetchImpl: asked(200) })).status === 'pending');
  answer = { success: true, data: { reference_code: 'st-1', status: 'Success' } };
  const done = await einvoice.einvoiceStatus('st-1', { now: NOW, env: ENV, fetchImpl: asked(200) });
  check('Success becomes issued, and the tracking code is kept', done.status === 'issued' && done.trackingCode === 'trk-st');
  const callsBefore = calls.length;
  await einvoice.einvoiceStatus('st-1', { now: NOW, env: ENV, fetchImpl: asked(200) });
  check('an issued one is not asked about again', calls.length === callsBefore);

  const file = recorded((req) => (req.path === '/v1/invoices/trk-st/download?type=pdf' ? json({ success: true, data: { file_type: 'pdf', file_name: 'HD_1.pdf', content: FAKE_PDF.toString('base64') } }) : json({}, 404)));
  const pdf = await einvoice.einvoicePdf('st-1', { now: NOW, env: ENV, fetchImpl: file });
  check('the PDF is downloaded with the bearer token and decoded from base64', Buffer.isBuffer(pdf) && pdf.equals(FAKE_PDF) && calls.at(-1).headers.Authorization.startsWith('Bearer '));
  check('  a row that is not issued has none', (await einvoice.einvoicePdf('nope', { now: NOW, env: ENV, fetchImpl: file })) === null);
  const notPdf = recorded(() => json({ success: true, data: { content: Buffer.from('<html>').toString('base64') } }));
  check('  bytes that are not a PDF are not passed on', (await einvoice.einvoicePdf('st-1', { now: NOW, env: ENV, fetchImpl: notPdf })) === null);
  const broken = await einvoice.einvoicePdf('st-1', { now: NOW, env: ENV, fetchImpl: recorded(() => json({}, 500)) }).then(() => null, (e) => e);
  check('  SePay failing is a 503 for the person, with words, not a stack', broken?.status === 503 && /try again/i.test(broken.message) && !/500/.test(broken.message));

  await einvoice.issueEinvoice(order('st-f'), buyerIn, { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { tracking_code: 'trk-f' } })) });
  const failed = await einvoice.einvoiceStatus('st-f', { now: NOW, env: ENV, fetchImpl: recorded(() => json({ success: true, data: { status: 'Failed', message: 'Series not valid' } })) });
  check('Failed is stored with SePay\'s message', failed.status === 'failed' && /Series not valid/.test(failed.error));

  await store.saveEinvoice({ orderId: 'st-u', referenceCode: 'st-u', status: 'unknown', error: 'no answer' });
  const createsBefore = created().length;
  const unk = await einvoice.einvoiceStatus('st-u', { now: NOW, env: ENV, fetchImpl: recorded((req) => (req.path === '/v1/invoices/st-u' ? json({ success: true, data: { status: 'issued' } }) : json({}, 404))) });
  check('an unknown invoice is only ever asked about (by reference code) and settles when SePay knows it', unk.status === 'issued' && created().length === createsBefore);
  await store.saveEinvoice({ orderId: 'st-u2', referenceCode: 'st-u2', status: 'unknown', error: 'no answer' });
  const still = await einvoice.einvoiceStatus('st-u2', { now: NOW, env: ENV, fetchImpl: recorded(() => json({ error: { code: 'NOT_FOUND' } }, 404)) });
  check('  one SePay does not know stays unknown, and is not created', still.status === 'unknown');
}

/* ── the daily step does all the e-invoice work; the webhook does none ───────────── */
const setup = async (name, amount = 50_000, via = 'webhook') => {
  const acc = await account(name, { role: 'admin' });
  const o = await orders.createOrder(acc.id, { kind: 'topup', amountVnd: amount });
  await takeTransfer({ id: null, referenceCode: `DOCS-${name}`, gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: o.order.code, content: o.order.code, transferType: 'in', transferAmount: amount }, { via });
  return { acc, order: o.order };
};
const backdate = (id, days) => store.rawQuery('UPDATE billing_orders SET paid_at = $2::timestamptz WHERE id = $1', [id, new Date(+NOW - days * 86_400_000)]);
const checks = () => calls.filter((c) => c.path.startsWith('/v1/invoices/create/check/'));

section('a webhook never calls the e-invoice API, even with e-invoices on');
let hooked;
{
  Object.assign(process.env, ENV);
  outside.length = 0;
  hooked = await setup('hook');
  check('a paid top-up taken while e-invoices are on reaches no e-invoice host', !outside.some((h) => h.startsWith('einvoice-api')), outside.join());
  check('  and leaves no invoice row (the daily step will issue it)', (await store.getEinvoice(hooked.order.id)) === null);
  for (const k of Object.keys(ENV)) delete process.env[k];
}

section('the daily step: issue, ask, retry, give up, within a budget');
{
  // Whatever earlier sections left is out of the way: this section counts what it asks.
  await store.rawQuery("UPDATE einvoices SET status = 'failed' WHERE status NOT IN ('issued', 'failed')");
  await store.rawQuery("UPDATE billing_orders SET paid_at = $1::timestamptz WHERE status = 'paid' AND id NOT IN (SELECT order_id FROM einvoices) AND id <> $2", [new Date(+NOW - 30 * 86_400_000), hooked.order.id]);
  reset();
  for (const id of ['d-ok', 'd-bad', 'd-ok2']) await store.saveEinvoice({ orderId: id, referenceCode: id, trackingCode: `trk-${id}`, status: 'pending' });
  await store.saveEinvoice({ orderId: 'd-err', referenceCode: 'd-err', status: 'error', error: 'refused' });
  await store.saveEinvoice({ orderId: 'd-done', referenceCode: 'd-done', trackingCode: 'x', status: 'issued' });
  const off = await einvoiceStep({ now: NOW, env: {}, fetchImpl: async () => { throw new Error('must not be asked'); } });
  check('with e-invoices off it looks at nothing and asks nothing', off === 0);
  const looked = await einvoiceStep({ now: NOW, env: ENV, fetchImpl: recorded((req) => {
    if (req.path.endsWith('trk-d-bad')) throw new TypeError('fetch failed');
    return json({ success: true, data: { status: 'Success' } });
  }) });
  check('with them on: the pending ones are looked at; a failure of one leaves the others', (await store.getEinvoice('d-ok')).status === 'issued' && (await store.getEinvoice('d-ok2')).status === 'issued' && (await store.getEinvoice('d-bad')).status === 'pending', String(looked));
  check('  an issued row is left alone, and an error row with no order to build from is skipped', !calls.some((c) => c.path.includes('d-done') || c.path.includes('d-err')));
  await store.rawQuery("UPDATE einvoices SET status = 'failed' WHERE status NOT IN ('issued', 'failed')");

  // 60 unfinished rows: no more than 50 asked in a run, and the ten left over are asked in the next (nobody starves).
  reset();
  for (let i = 0; i < 60; i += 1) await store.saveEinvoice({ orderId: `l-${i}`, referenceCode: `l-${i}`, trackingCode: `trk-l-${i}`, status: 'pending' });
  const answerOk = recorded(() => json({ success: true, data: { status: 'Success' } }));
  const first = await einvoiceStep({ now: NOW, env: ENV, fetchImpl: answerOk });
  const issuedAfterFirst = (await store.rawQuery("SELECT COUNT(*)::int AS n FROM einvoices WHERE order_id LIKE 'l-%' AND status = 'issued'"))[0].n;
  check('60 pending rows: at most 50 are asked in one run', first === 50 && checks().length === 50 && issuedAfterFirst === 50, `${first} ${checks().length} ${issuedAfterFirst}`);
  const second = await einvoiceStep({ now: NOW, env: ENV, fetchImpl: answerOk });
  const issuedAfterSecond = (await store.rawQuery("SELECT COUNT(*)::int AS n FROM einvoices WHERE order_id LIKE 'l-%' AND status = 'issued'"))[0].n;
  check('  the other ten are asked in the next run', second === 10 && issuedAfterSecond === 60, `${second} ${issuedAfterSecond}`);

  // A stuck row: seven days after the order was paid it is given up on, with its last words, and not asked again.
  reset();
  const stuck = await setup('stuck');
  await backdate(stuck.order.id, 8);
  await store.saveEinvoice({ orderId: stuck.order.id, referenceCode: stuck.order.id, trackingCode: 'trk-stuck', status: 'unknown', error: 'SePay did not confirm' });
  const young = await setup('young');
  await store.saveEinvoice({ orderId: young.order.id, referenceCode: young.order.id, trackingCode: 'trk-young', status: 'pending' });
  const stillPending = recorded(() => json({ success: true, data: { status: 'Pending' } }));
  await einvoiceStep({ now: NOW, env: ENV, fetchImpl: stillPending });
  const gone = await store.getEinvoice(stuck.order.id);
  check('an invoice unresolved 8 days after payment becomes failed, keeping its last error', gone.status === 'failed' && /did not confirm/.test(gone.error), JSON.stringify(gone));
  check('  a young one that is still pending stays pending', (await store.getEinvoice(young.order.id)).status === 'pending');
  reset();
  await einvoiceStep({ now: NOW, env: ENV, fetchImpl: stillPending });
  check('  the failed one is not asked again', !calls.some((c) => c.path.includes('stuck')));
  const figures = await owner.j.call('GET', '/api/admin/billing');
  check('  the administrator sees how many e-invoices failed', figures.status === 200 && figures.json?.figures?.einvoicesFailed >= 1, JSON.stringify(figures.json?.figures?.einvoicesFailed));
  await store.rawQuery("UPDATE einvoices SET status = 'failed' WHERE status NOT IN ('issued', 'failed')");

  // A paid order with no row gets its invoice from the step; old money, play money and an order with a row do not.
  reset();
  const fresh = await setup('fresh');
  const old = await setup('oldpay');
  await backdate(old.order.id, 10);
  const play = await setup('playpay', 50_000, 'simulated');
  const made = [];
  await einvoiceStep({ now: NOW, env: ENV, fetchImpl: recorded((req) => {
    if (req.path !== '/v1/invoices/create') return json({}, 404);
    made.push(req.body);
    return json({ success: true, data: { tracking_code: `trk-${req.body.reference_code}` } });
  }) });
  const freshRow = await store.getEinvoice(fresh.order.id);
  const hookRow = await store.getEinvoice(hooked.order.id);
  check('a paid order with no row gets its invoice from the next daily step', freshRow?.status === 'pending' && made.some((b) => b.reference_code === fresh.order.id && b.total_amount === 50_000), JSON.stringify(freshRow));
  check('  so does the one the webhook took while it was on', hookRow !== null);
  check('  an order paid more than 7 days ago is not invoiced late (the date must be today)', (await store.getEinvoice(old.order.id)) === null && !made.some((b) => b.reference_code === old.order.id));
  check('  simulated money is not invoiced', (await store.getEinvoice(play.order.id)) === null && !made.some((b) => b.reference_code === play.order.id));
  const before = made.length;
  await einvoiceStep({ now: NOW, env: ENV, fetchImpl: recorded((req) => (req.path === '/v1/invoices/create' ? (made.push(req.body), json({ success: true, data: { tracking_code: 'again' } })) : json({ success: true, data: { status: 'Pending' } }))) });
  check('  and it is asked for once: the next run sends no second create', made.length === before);

  // An error row is retried; the repeat is a 409 and then the status is fetched.
  reset();
  const retry = await setup('retry');
  await store.saveEinvoice({ orderId: retry.order.id, referenceCode: retry.order.id, status: 'error', error: 'REGISTRATION_NOT_TAX_APPROVED: not yet' });
  await einvoiceStep({ now: NOW, env: ENV, fetchImpl: recorded((req) => (req.path === '/v1/invoices/create'
    ? json({ success: false, error: { code: 'EINVOICE_DOCUMENT_EXISTED', message: 'exists' } }, 409)
    : json({ success: true, data: { status: 'issued' } }))) });
  check('an error row is retried, the repeat is a 409, and the status is fetched', created().length === 1 && calls.some((c) => c.method === 'GET' && c.path === `/v1/invoices/${retry.order.id}`) && (await store.getEinvoice(retry.order.id)).status === 'issued', JSON.stringify(await store.getEinvoice(retry.order.id)));

  // The time budget stops the loop cleanly.
  reset();
  await store.saveEinvoice({ orderId: 'b-1', referenceCode: 'b-1', trackingCode: 'trk-b-1', status: 'pending' });
  const spent = await einvoiceStep({ now: NOW, env: ENV, budgetMs: -1, fetchImpl: async () => { throw new Error('out of time: nothing may be asked'); } });
  check('with its time budget spent the step stops cleanly, having asked nothing', spent === 0 && (await store.getEinvoice('b-1')).status === 'pending');
  await store.rawQuery("UPDATE einvoices SET status = 'failed' WHERE status NOT IN ('issued', 'failed')");
}

/* ── the invoice route ───────────────────────────────────────────── */
section('GET /api/billing/invoices/:id.pdf');
{
  einvoiceRoutes = ({ url, body }) => {
    if (url.pathname === '/v1/token') return json({ success: true, data: { access_token: 'jwt-live.x.y', expires_in: 86400 } });
    if (url.pathname === '/v1/provider-accounts') return json({ success: true, data: { items: [{ id: 'acc-1', active: true }] } });
    if (url.pathname === '/v1/provider-accounts/acc-1') return json({ success: true, data: { templates: [{ template_code: '2', invoice_series: `C${new Date(Date.now() + 7 * 3_600_000).toISOString().slice(2, 4)}TSE` }] } });
    if (url.pathname === '/v1/invoices/create') return json({ success: true, data: { tracking_code: `trk-${body.reference_code}` } });
    if (url.pathname.startsWith('/v1/invoices/create/check/')) return json({ success: true, data: { status: 'Success' } });
    if (url.pathname.endsWith('/download')) return json({ success: true, data: { content: FAKE_PDF.toString('base64') } });
    return json({}, 404);
  };
  const paidFor = await setup('invpay');
  const playFor = await setup('invplay', 50_000, 'simulated');
  Object.assign(process.env, ENV);
  einvoice._resetEinvoiceForTests();
  await einvoiceStep({ now: new Date() });
  const res = await paidFor.acc.j.call('GET', `/api/billing/invoices/${paidFor.order.id}.pdf`);
  check("the order's owner gets the invoice PDF (status settles to issued first)", res.status === 200 && res.bytes.equals(FAKE_PDF), `${res.status}`);
  check("  with the brief's headers", res.headers.get('content-type') === 'application/pdf' && res.headers.get('content-disposition') === `attachment; filename="${paidFor.order.id}.pdf"` && res.headers.get('cache-control') === 'no-store', [...res.headers.entries()].filter(([k]) => /content-(type|disp)|cache/.test(k)).join(' | '));
  check("  another account's invoice is a 404", (await other.j.call('GET', `/api/billing/invoices/${paidFor.order.id}.pdf`)).status === 404);
  check('  an order with no invoice is a 404', (await playFor.acc.j.call('GET', `/api/billing/invoices/${playFor.order.id}.pdf`)).status === 404);
  check('  an id that does not exist is a 404', (await paidFor.acc.j.call('GET', '/api/billing/invoices/nope.pdf')).status === 404);
  check('  a member gets a 404', (await member.j.call('GET', `/api/billing/invoices/${paidFor.order.id}.pdf`)).status === 404);
  for (const k of Object.keys(ENV)) delete process.env[k];
  check('  with e-invoices off there is no invoice to give (404)', (await paidFor.acc.j.call('GET', `/api/billing/invoices/${paidFor.order.id}.pdf`)).status === 404);
}

section('billingTick carries the e-invoice step');
{
  const out = await billingTick({ now: new Date(Date.now() + 86_400_000 * 3) });
  check('the day\'s work reports e-invoices as a count', typeof out.daily?.einvoices === 'number', JSON.stringify(out.daily));
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mAll billing document checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
