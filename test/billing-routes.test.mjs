/**
 * Billing routes (spec B1, Task 7): the HTTP surface, promo codes, the mails and the day's work.
 *
 * The app is booted the way test/http.test.mjs boots it (PGlite on a temp dir), the rate source is
 * answered here, and mail goes to a fake SMTP transport, so nothing leaves the machine.
 *
 *   node test/billing-routes.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'billing-routes-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'billing-routes-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-billing-routes-test-${process.pid}`);
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'SEPAY_API_TOKEN', 'E2B_API_KEY', 'E2B_CONCURRENT_LIMIT', 'DATABASE_INCLUDED_GB', 'RESEND_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD']) delete process.env[name];
process.env.SEPAY_BANK_ACCOUNT = '0123456789';
process.env.SEPAY_BANK_CODE = 'MBBank';
process.env.SEPAY_ACCOUNT_NAME = 'SYNAPSEZ TEST';
process.env.CRON_SECRET = 'billing-routes-cron-secret';
process.env.SMTP_HOST = 'smtp.test.invalid';
process.env.EMAIL_CONFIRMATION = 'off';
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/* ── the outside world: the rate source, E2B, and mail ─────────────── */
const realFetch = globalThis.fetch;
const outside = [];
let rateUp = true;
let frankUp = false;
let catalogueUp = false;
const e2bSandboxes = [{ sandboxID: 'a', state: 'running' }, { sandboxID: 'b', state: 'running' }, { sandboxID: 'c', state: 'paused' }, { sandboxID: 'd', state: 'running' }];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, options) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, options);
  outside.push(`${u.host}${u.pathname}${u.search}`);
  if (u.host === 'open.er-api.com') {
    if (!rateUp) return json({ result: 'error' }, 500);
    return json({ result: 'success', time_last_update_unix: Math.floor(Date.now() / 1000), rates: { VND: 25_500 } });
  }
  if (u.host === 'api.frankfurter.dev' && frankUp) return json([{ date: '2026-11-16', base: 'USD', quote: 'VND', rate: 25_736 }]);
  if (u.host === 'openrouter.ai' && catalogueUp) return json({ data: [] });
  if (u.host === 'api.e2b.app') return json(e2bSandboxes);
  throw new TypeError('fetch failed');
};

const email = await import('../server/email.js');
const mails = [];
email.__testing.useTransport({
  sendMail: async (m) => {
    mails.push({ to: [].concat(m.to).join(','), subject: m.subject, html: m.html, text: m.text });
    return { messageId: '<t@test>', accepted: [].concat(m.to), rejected: [], response: '250 OK' };
  },
});

const { createApp } = await import('../server/app.js');
const { initStore, getStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { planVnd, TOPUP } = await import('../server/billing/plans.js');
const { addMonths } = await import('../server/billing/period.js');
const { isBillable, forgetBillable, holdSearch } = await import('../server/billing/meter.js');
const { takeTransfer } = await import('../server/billing/sepay.js');
const orders = await import('../server/billing/orders.js');
const { billingTick } = await import('../server/billing/daily.js');
const mail = await import('../server/billing/mail.js');
const promo = await import('../server/billing/promo.js');
const { AUDIT_KINDS } = await import('../server/audit.js');
const { ADMIN_PERMISSIONS } = await import('../server/adminRoles.js');
const { LIMITS } = await import('../server/ratelimit.js');

const PORT = 5238;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

function jar(ip) {
  let cookie = '';
  return {
    async call(method, url, body, options = {}) {
      const res = await realFetch(`${base}${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'x-real-ip': ip } : {}), ...(options.headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 120) }; }
      return { status: res.status, json: parsed, headers: res.headers, text };
    },
  };
}
const password = 'billing-routes-long-enough-password';
let seq = 0;
async function account(name, { role = 'user', permissions } = {}) {
  seq += 1;
  const row = await store.createUser({ id: `br-${name}`, email: `${name}@example.test`, name, passwordHash: await hashPassword(password), role });
  if (permissions) await store.setAdminPermissions(row.id, permissions);
  const j = jar(`10.77.${seq}.1`);
  const login = await j.call('POST', '/api/login', { email: `${name}@example.test`, password });
  if (login.status !== 200) throw new Error(`login ${name}: ${login.status} ${login.text}`);
  return { id: row.id, email: `${name}@example.test`, j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The first account is the owner; the others are made after it.
const owner = await account('owner', { role: 'admin' });
const dan = await account('dan', { role: 'admin', permissions: ['billing'] });
const nolist = await account('nolist', { role: 'admin' });
const carol = await account('carol', { role: 'admin', permissions: ['models'] });
const bob = await account('bob');
const frank = await account('frank', { role: 'admin' });

const ROUTES_USER = [
  ['GET', '/api/billing'], ['GET', '/api/billing/plans'], ['POST', '/api/billing/quote', { plan: 'plus', period: 'month' }],
  ['POST', '/api/billing/orders', { kind: 'topup', amountVnd: 100_000 }], ['GET', '/api/billing/orders/nope'], ['POST', '/api/billing/orders/nope/cancel'],
  ['PUT', '/api/billing/subscription', { autoRenew: false }], ['PUT', '/api/billing/profile', { name: 'A', email: 'a@b.co', country: 'VN' }],
  ['PUT', '/api/billing/alerts', { lowBalanceVnd: 50_000 }], ['POST', '/api/billing/promo', { code: 'ABCDEFGH' }], ['GET', '/api/billing/transactions'], ['GET', '/api/billing/receipts'],
  ['POST', '/api/billing/team-interest'],
];

section('who can see billing at all');
{
  const answers = [];
  for (const [method, url, body] of ROUTES_USER) answers.push([`${method} ${url}`, (await bob.j.call(method, url, body)).status]);
  check('in preview every billing route is a 404 for an ordinary account', answers.every(([, s]) => s === 404), answers.filter(([, s]) => s !== 404).map((a) => a.join(' ')).join(' | '));
  const seen = await owner.j.call('GET', '/api/billing');
  check('an administrator gets 200', seen.status === 200 && seen.json?.mode === 'preview', `${seen.status}`);
  const keys = Object.keys(seen.json || {}).sort().join();
  check('  with plan, balance, usage, profile, alerts, the top-up bounds and the order still open', keys === 'alerts,balance,bounds,mode,pending,plan,profile,teamInterest,usage', keys);
  check('  a free account: plan free, no balance, no profile, the bounds are the code\'s', seen.json.plan.plan === 'free' && seen.json.balance.vnd === 0 && seen.json.balance.expiresAt === null && seen.json.profile === null && seen.json.bounds.minNoPlan === TOPUP.minNoPlan, JSON.stringify(seen.json.plan));

  const ownerMe = await owner.j.call('GET', '/api/bootstrap');
  const bobMe = await bob.j.call('GET', '/api/bootstrap');
  check('the session says billing is visible to an administrator in preview, and not to a member', ownerMe.json?.user?.billing?.visible === true && bobMe.json?.user?.billing?.visible === false, JSON.stringify([ownerMe.json?.user?.billing, bobMe.json?.user?.billing]));

  process.env.BILLING_MODE = 'off';
  const off = [];
  for (const [method, url, body] of ROUTES_USER) off.push([`${method} ${url}`, (await owner.j.call(method, url, body)).status]);
  check('with billing off every route is a 404 for everyone, the owner too', off.every(([, s]) => s === 404), off.filter(([, s]) => s !== 404).map((a) => a.join(' ')).join(' | '));
  check('  and so are the administrator\'s', (await owner.j.call('GET', '/api/admin/billing')).status === 404 && (await owner.j.call('GET', '/api/admin/billing/promos')).status === 404);
  check('  and the session no longer says visible', (await owner.j.call('GET', '/api/bootstrap')).json?.user?.billing?.visible === false);
  delete process.env.BILLING_MODE;

  check('the Administration page can hand out the billing permission', ADMIN_PERMISSIONS.includes('billing') && ADMIN_PERMISSIONS.at(-1) === 'billing');
  const kinds = ['billing_order_paid', 'billing_transfer_assigned', 'billing_transfer_dismissed', 'billing_promo_created', 'billing_promo_disabled', 'billing_simulated', 'billing_profile_updated'];
  check('the seven audit kinds exist', kinds.every((k) => AUDIT_KINDS.includes(k)));
  check('orders and promo tries are limited to ten an hour', LIMITS['billing-order']?.limit === 10 && LIMITS['billing-promo']?.limit === 10 && LIMITS['billing-order'].windowMs === 3_600_000);
}

section('the billing permission is only ever granted');
{
  const { permissionsOf } = await import('../server/adminRoles.js');
  const row = await store.getUserById(nolist.id);
  check('an administrator with no stored list holds what they held before billing, not billing', row.admin_permissions == null && !permissionsOf(row).includes('billing') && permissionsOf(row).includes('users') && permissionsOf(row).length === 7, permissionsOf(row).join());
  const owned = await store.getUserById(owner.id);
  check('the owner holds everything, billing included; an explicit grant gives it', permissionsOf(owned).includes('billing') && permissionsOf(await store.getUserById(dan.id)).join() === 'billing');
  const closed = [];
  for (const [method, url, body] of [['GET', '/api/admin/billing'], ['GET', '/api/admin/billing/orders'], ['GET', '/api/admin/billing/transfers'], ['GET', '/api/admin/billing/promos'], ['POST', '/api/admin/billing/promos', { code: 'NOLISTCODE1', creditVnd: 5000, maxUses: 1 }], ['DELETE', '/api/admin/billing/promos/NOLISTCODE1'], ['POST', '/api/admin/billing/transfers/1/assign', { email: bob.email }], ['POST', '/api/admin/billing/transfers/1/dismiss'], ['POST', '/api/admin/billing/simulate', { orderId: 'x' }]]) closed.push([method + ' ' + url, (await nolist.j.call(method, url, body)).status]);
  check('and every administrator route of billing is a 403 for them', closed.every(([, st]) => st === 403), closed.filter(([, st]) => st !== 403).map((a) => a.join(' ')).join(' | '));
}

section('the people list says what each account may do, from the server');
{
  const list = (await owner.j.call('GET', '/api/admin/users')).json?.users || [];
  const mine = list.find((u) => u.id === nolist.id);
  check('an administrator with no stored list is listed with the permissions they really hold, billing not among them', Array.isArray(mine?.permissions) && mine.permissions.length === 7 && !mine.permissions.includes('billing'), JSON.stringify(mine?.permissions));
  check('  an explicit grant is listed as it is, and a member holds none', list.find((u) => u.id === dan.id)?.permissions.join() === 'billing' && list.find((u) => u.id === bob.id)?.permissions.length === 0);
}

section('the plans, with and without a rate');
{
  // First with no rate anywhere (nothing has been read yet, so nothing is kept), then with one.
  rateUp = false;
  const down = await owner.j.call('GET', '/api/billing/plans');
  check('with no rate the plans come back with vnd and rate null, not an error', down.status === 200 && down.json.rate === null && down.json.plans.every((p) => p.vnd === null) && down.json.plans.length === 3 && down.json.payg.prices === null, `${down.status} ${JSON.stringify(down.json?.rate)}`);
  check('  and an order that needs the rate says so (503), not 500', (await owner.j.call('POST', '/api/billing/quote', { plan: 'plus', period: 'month' })).status === 503);
  rateUp = true;
  const ok = await owner.j.call('GET', '/api/billing/plans');
  const plus = ok.json?.plans?.find((p) => p.id === 'plus');
  check("the plans in đồng at the day's rate", ok.status === 200 && plus?.vnd?.month === planVnd('plus', 'month', 25_500) && plus?.vnd?.year === planVnd('plus', 'year', 25_500) && plus.usdCents.month === 500 && plus.searches === 150 && plus.sandboxMinutes === 240 && plus.storageGb === 3, JSON.stringify(plus));
  check('  the rate, its source and its attribution', ok.json?.rate?.rate === 25_500 && ok.json.rate.source === 'erapi' && /exchangerate-api/.test(ok.json.rate.attribution) && !!ok.json.rate.at, JSON.stringify(ok.json?.rate));
  check("  pay as you go and the caller's plan", ok.json?.payg?.prices?.searchVnd > 0 && ok.json?.current?.plan === 'free', JSON.stringify([ok.json?.payg, ok.json?.current]));
}

section('"tell me when Team opens": kept once per account, counted for the administrator');
{
  const before = (await owner.j.call('GET', '/api/admin/billing')).json?.figures?.teamInterest;
  check('nobody has asked yet, and the account says so', before === 0 && (await owner.j.call('GET', '/api/billing')).json?.teamInterest === false, String(before));
  check('a member is refused like every other billing route', (await bob.j.call('POST', '/api/billing/team-interest')).status === 404);
  // Another preference is already there: the press must add to the row, not replace it.
  await store.mergeUserSetting(owner.id, 'prefs', { language: 'vi' });
  const first = await owner.j.call('POST', '/api/billing/team-interest');
  const kept = (await store.getUserSetting(owner.id, 'prefs'))?.teamInterest;
  check('the first press answers ok and stores a date in the preferences', first.status === 200 && first.json?.ok === true && Number.isFinite(Date.parse(kept)), JSON.stringify([first.status, first.json, kept]));
  await sleep(20);
  const second = await owner.j.call('POST', '/api/billing/team-interest');
  check('the second press answers ok and changes nothing', second.status === 200 && second.json?.ok === true && (await store.getUserSetting(owner.id, 'prefs'))?.teamInterest === kept);
  const both = await Promise.all([dan.j.call('POST', '/api/billing/team-interest'), dan.j.call('POST', '/api/billing/team-interest')]);
  const danOnce = (await store.getUserSetting(dan.id, 'prefs'))?.teamInterest;
  await sleep(20);
  await dan.j.call('POST', '/api/billing/team-interest');
  check('two presses at once both answer ok, a date is stored, and a later press leaves that date as it was', both.every((r) => r.status === 200 && r.json?.ok === true) && Number.isFinite(Date.parse(danOnce)) && (await store.getUserSetting(dan.id, 'prefs'))?.teamInterest === danOnce, String(danOnce));
  const ownerPrefs = await store.getUserSetting(owner.id, 'prefs');
  check('the preferences it was merged into keep what they held', ownerPrefs?.language === 'vi' && ownerPrefs?.teamInterest === kept, JSON.stringify(ownerPrefs));
  const card = await owner.j.call('GET', '/api/admin/billing');
  check('the administrator figures count the accounts, once each', card.json?.figures?.teamInterest === 2, String(card.json?.figures?.teamInterest));
  check('and the account now says it has asked', (await owner.j.call('GET', '/api/billing')).json?.teamInterest === true);
}

section('billing information');
{
  const put = (body, who = dan) => who.j.call('PUT', '/api/billing/profile', body);
  const good = { name: 'Trần Văn A', email: 'tran.a@example.test', country: 'vn', address: '1 Lê Lợi, Quận 1', taxCode: '0312-345-678' };
  check('a bad email is a 400', (await put({ ...good, email: 'not-an-email' })).status === 400);
  check('a 121-character name is a 400', (await put({ ...good, name: 'x'.repeat(121) })).status === 400);
  check('an empty name is a 400', (await put({ ...good, name: '   ' })).status === 400);
  check('country "Vietnam" is a 400', (await put({ ...good, country: 'Vietnam' })).status === 400);
  check('a tax code with letters is a 400', (await put({ ...good, taxCode: '12AB' })).status === 400);
  check('an address of 301 characters is a 400', (await put({ ...good, address: 'y'.repeat(301) })).status === 400);
  check('a name that is not text is a 400', (await put({ ...good, name: { a: 1 } })).status === 400);
  const saved = await put(good);
  check('a good one is a 200 and the country is upper-cased', saved.status === 200 && saved.json?.profile?.country === 'VN' && saved.json.profile.name === good.name, JSON.stringify(saved.json));
  const row = await store.getBillingProfile(dan.id);
  check('what is stored is sealed, not the text', !!row?.sealed && !/Trần|tran\.a|Lê Lợi|0312/.test(row.sealed) && /^v2\./.test(row.sealed), String(row?.sealed).slice(0, 30));
  const again = await dan.j.call('GET', '/api/billing');
  check('and it reads back for its owner', again.json?.profile?.email === good.email && again.json.profile.taxCode === '0312-345-678', JSON.stringify(again.json?.profile));
  const mine = await owner.j.call('GET', '/api/billing');
  check('another account does not see it', mine.json?.profile === null);
  check('the optional fields may be left out', (await put({ name: 'B', email: 'b@example.test', country: 'US' }, owner)).json?.profile?.address === null);
  // Two optional names for the invoice (the checkout form asks for them): kept sealed with the rest, capped like the name.
  const named = await put({ name: 'B', email: 'b@example.test', country: 'US', companyName: '  Công ty ABC ', invoiceName: 'Kế toán ABC' }, owner);
  check('a company name and another invoice name are kept, trimmed', named.status === 200 && named.json?.profile?.companyName === 'Công ty ABC' && named.json.profile.invoiceName === 'Kế toán ABC', JSON.stringify(named.json));
  check('  and read back for their owner', (await owner.j.call('GET', '/api/billing')).json?.profile?.invoiceName === 'Kế toán ABC');
  const row2 = await store.getBillingProfile(owner.id);
  check('  sealed with the rest, not the text', !/ABC/.test(row2?.sealed || ''));
  check('  left out, both are null', (await put({ name: 'B', email: 'b@example.test', country: 'US' }, owner)).json?.profile?.companyName === null);
  check('  a company name of 121 characters is a 400', (await put({ ...good, companyName: 'c'.repeat(121) })).status === 400);
  check('  another invoice name of 121 characters is a 400', (await put({ ...good, invoiceName: 'i'.repeat(121) })).status === 400);
  check('  a name that is not text is a 400', (await put({ ...good, companyName: 5 })).status === 400 && (await put({ ...good, invoiceName: ['x'] })).status === 400);
  const audit = (await store.listAudit(dan.id, 20)).map((e) => e.kind);
  check('the update is in the account\'s own record', audit.includes('billing_profile_updated'), audit.join());
  const lowSet = await dan.j.call('PUT', '/api/billing/alerts', { lowBalanceVnd: 60_000 });
  check('the low-balance threshold is kept, and null turns it off', lowSet.status === 200 && (await store.getBillingProfile(dan.id)).lowBalanceVnd === 60_000 && (await dan.j.call('PUT', '/api/billing/alerts', { lowBalanceVnd: null })).status === 200 && (await store.getBillingProfile(dan.id)).lowBalanceVnd === null);
  check('  a fraction or a negative is a 400', (await dan.j.call('PUT', '/api/billing/alerts', { lowBalanceVnd: 1.5 })).status === 400 && (await dan.j.call('PUT', '/api/billing/alerts', { lowBalanceVnd: -5 })).status === 400);
  check('  and the profile survived the alert change', !!(await store.getBillingProfile(dan.id)).sealed);
}

section('orders: only your own, and ten an hour');
let ownerTopup;
{
  const low = await owner.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: TOPUP.minNoPlan - 1000 });
  check('a top-up under the minimum is a 422', low.status === 422, `${low.status} ${JSON.stringify(low.json)}`);
  check('a plan that does not exist is a 422', (await owner.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'gold', period: 'month' })).status === 422);
  check('a kind that does not exist is a 422', (await owner.j.call('POST', '/api/billing/orders', { kind: 'gift' })).status === 422);
  check('an amount that is not a whole number is a 422', (await owner.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: '100000' })).status === 422);
  ownerTopup = await owner.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: 100_000 });
  const o = ownerTopup.json?.order;
  check('a top-up order: a code, a total, an expiry and the QR to pay it', ownerTopup.status === 200 && /^SZ\d{10}$/.test(o?.code) && o.totalVnd === 100_000 && o.status === 'pending' && ownerTopup.json.paidNow === false && !!o.expiresAt, JSON.stringify(ownerTopup.json));
  const qr = ownerTopup.json?.due?.qr;
  check('  the QR carries bank, account, holder, amount and the code as the content', ownerTopup.json?.due?.vnd === 100_000 && qr?.bank === 'MBBank' && qr.account === '0123456789' && qr.holder === 'SYNAPSEZ TEST' && qr.amount === 100_000 && qr.content === o.code && qr.image.includes(o.code), JSON.stringify(qr));
  check('  the response never carries another account\'s id or the rate source internals', !('userId' in o) && !('basis' in o));

  const seen = await owner.j.call('GET', `/api/billing/orders/${o.id}`);
  check('its owner reads its status: received, still due, no plan', seen.status === 200 && seen.json.status === 'pending' && seen.json.receivedVnd === 0 && seen.json.dueVnd === 100_000 && seen.json.plan === null, JSON.stringify(seen.json));
  const quick = await owner.j.call('GET', `/api/billing/orders/${o.id}`);
  check('asked again within a second it is a 429 with Retry-After', quick.status === 429 && !!quick.headers.get('retry-after'), `${quick.status}`);
  check('another administrator gets a 404 for it (status, cancel)', (await dan.j.call('GET', `/api/billing/orders/${o.id}`)).status === 404 && (await dan.j.call('POST', `/api/billing/orders/${o.id}/cancel`)).status === 404);
  check('  and a 404 for one that does not exist', (await owner.j.call('GET', '/api/billing/orders/not-an-order')).status === 404);
  const stillThere = await store.getOrder(o.id);
  check('  the other administrator\'s cancel changed nothing', stillThere.status === 'pending');
  await sleep(1100);
  const cancel = await owner.j.call('POST', `/api/billing/orders/${o.id}/cancel`);
  check('its owner cancels it', cancel.status === 200 && cancel.json?.status === 'cancelled' && (await store.getOrder(o.id)).status === 'cancelled');
  check('  a second cancel is a 409', (await owner.j.call('POST', `/api/billing/orders/${o.id}/cancel`)).status === 409);

  // Ten an hour, counted per account (a fresh address and account for this).
  const eve = await account('eve', { role: 'admin' });
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await eve.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: TOPUP.minNoPlan })).status);
  check('the eleventh order in an hour is a 429', statuses[10] === 429 && statuses.slice(0, 10).every((s) => s !== 429), statuses.join());
  const quoted = await owner.j.call('POST', '/api/billing/quote', { plan: 'pro', period: 'month' });
  check('a quote prices a plan and creates nothing', quoted.status === 200 && quoted.json.priceVnd === planVnd('pro', 'month', 25_500) && quoted.json.kind === 'new' && !('basis' in quoted.json), JSON.stringify(quoted.json));
  check('  it says the plan renews (an account with no plan yet)', quoted.json.autoRenew === true);
  check('  it names the day the plan renews (a month on from when it starts)', quoted.json.renewsAt === addMonths(new Date(quoted.json.startsAt), 1).toISOString(), String(quoted.json.renewsAt));
  check('  and with no BILLING_TAX_RATE says no tax rate and states no tax', quoted.json.taxRate === null && quoted.json.taxVnd === null, JSON.stringify([quoted.json.taxRate, quoted.json.taxVnd]));
  const hadRate = process.env.BILLING_TAX_RATE;
  process.env.BILLING_TAX_RATE = '10';
  let taxed;
  try {
    taxed = await owner.j.call('POST', '/api/billing/quote', { plan: 'pro', period: 'month' });
  } finally {
    if (hadRate === undefined) delete process.env.BILLING_TAX_RATE;
    else process.env.BILLING_TAX_RATE = hadRate;
  }
  check('  with BILLING_TAX_RATE=10 it carries the rate and the tax inside the total (as the receipt works it out)', taxed.json.taxRate === 10 && taxed.json.taxVnd === Math.round((taxed.json.totalVnd * 10) / 110) && taxed.json.totalVnd === quoted.json.totalVnd, JSON.stringify([taxed.json.taxRate, taxed.json.taxVnd, taxed.json.totalVnd]));
}

section('the order still open: /api/billing carries it so the QR can be drawn again, and only for its owner');
{
  const piper = await account('piper', { role: 'admin' });
  const read = async (who = piper) => (await who.j.call('GET', '/api/billing')).json?.pending;
  check('an account with no order open has pending null', (await read()) === null, JSON.stringify(await read()));
  const made = await piper.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: 100_000 });
  const open = await read();
  check('a pending, unexpired order comes back with its id, kind, code, amount, expiry and the QR the order answered with', open?.id === made.json.order.id && open.kind === 'topup' && open.code === made.json.order.code && open.totalVnd === 100_000 && open.dueVnd === 100_000 && open.receivedVnd === 0 && open.expiresAt === made.json.order.expiresAt && JSON.stringify(open.qr) === JSON.stringify(made.json.due.qr), JSON.stringify(open));
  check('  and nothing that belongs to the account or the rate', !('userId' in open) && !('basis' in open) && !('rate' in open));
  check('another account never sees it', (await read(dan)) === null && (await read(owner))?.id !== open.id);
  await store.addOrderReceived(open.id, 40_000);
  const part = await read();
  check('part of it received: the QR asks for what is left, and says what has come', part?.receivedVnd === 40_000 && part.dueVnd === 60_000 && part.qr.amount === 60_000 && part.totalVnd === 100_000, JSON.stringify(part));
  await sleep(1100);
  await piper.j.call('POST', `/api/billing/orders/${open.id}/cancel`);
  check('cancelled: pending is null again', (await read()) === null);
  const old = await orders.createOrder(piper.id, { kind: 'topup', amountVnd: 60_000 }, { now: new Date(Date.now() - 2 * 3_600_000) });
  check('an order whose time has passed (not yet swept) is not offered', (await store.getOrder(old.order.id)).status === 'pending' && (await read()) === null);
  const next = await piper.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: 50_000 });
  check('with an old and a new one the newest unexpired is the one offered', (await read())?.id === next.json.order.id);
  const simulated = await owner.j.call('POST', '/api/admin/billing/simulate', { orderId: next.json.order.id });
  check('paid: pending is null again', (simulated.status === 200 || (await store.getOrder(next.json.order.id)).status === 'paid') && (await read()) === null, `${simulated.status} ${JSON.stringify(await read())}`);
}

section('the plan, paid by a (simulated) transfer, and what the owner may do with it');
let planOrderId;
{
  const planOrder = await owner.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'plus', period: 'month' });
  planOrderId = planOrder.json?.order?.id;
  check('a plan order has something to transfer', planOrder.status === 200 && planOrder.json.due?.vnd === planVnd('plus', 'month', 25_500), JSON.stringify(planOrder.json));
  check('simulating needs the billing permission (a member of staff without it: 403)', (await carol.j.call('POST', '/api/admin/billing/simulate', { orderId: planOrderId })).status === 403);
  check('  and the owner: another administrator is a 403', (await dan.j.call('POST', '/api/admin/billing/simulate', { orderId: planOrderId })).status === 403);
  check('  an order that does not exist is a 404', (await owner.j.call('POST', '/api/admin/billing/simulate', { orderId: 'nope' })).status === 404);
  process.env.BILLING_MODE = 'live';
  const inLive = await owner.j.call('POST', '/api/admin/billing/simulate', { orderId: planOrderId });
  delete process.env.BILLING_MODE;
  check('  and only in preview: in live it is a 409', inLive.status === 409, `${inLive.status}`);
  const sim = await owner.j.call('POST', '/api/admin/billing/simulate', { orderId: planOrderId });
  check('the owner simulates the transfer: the plan is applied', sim.status === 200 && sim.json?.outcome === 'applied', JSON.stringify(sim.json));
  const view = await owner.j.call('GET', '/api/billing');
  check('  the account now has Plus, with a price and a renewal', view.json.plan.plan === 'plus' && view.json.plan.period === 'month' && view.json.plan.status === 'active' && view.json.plan.autoRenew === true && view.json.plan.cancelAtEnd === false && view.json.plan.priceVnd === planVnd('plus', 'month', 25_500) && view.json.plan.nextPlan === null, JSON.stringify(view.json.plan));
  check('  and the usage of the period is there', view.json.usage?.plan === 'plus' && view.json.usage.search.included === 150);

  // Simulated money stays out of the clock and out of every figure.
  const state = await store.billingState(owner.id);
  check('simulated money does not start the 12-month clock', state.lastTopupAt === null && state.balanceVnd === 0, JSON.stringify(state));
  const figures = (await owner.j.call('GET', '/api/admin/billing')).json?.figures;
  check('  and is in no figure: no money in, no money out, no paid orders, nothing held', figures?.paidOrdersVnd === 0 && figures.entries.topup.inVnd === 0 && figures.entries.plan.outVnd === 0 && figures.balancesHeldVnd === 0 && figures.orders.paid === 0, JSON.stringify(figures));
  check('  the simulation is in the record', (await store.listAudit(owner.id, 30)).some((e) => e.kind === 'billing_simulated'));

  const setOff = await owner.j.call('PUT', '/api/billing/subscription', { autoRenew: false });
  check('auto-renew can be turned off', setOff.status === 200 && setOff.json?.plan?.autoRenew === false && (await store.getSubscription(owner.id)).autoRenew === false, JSON.stringify(setOff.json));
  const cancelEnd = await owner.j.call('PUT', '/api/billing/subscription', { cancelAtEnd: true });
  check('cancelling at the period end is kept, and can be undone', cancelEnd.json?.plan?.cancelAtEnd === true && (await owner.j.call('PUT', '/api/billing/subscription', { cancelAtEnd: false })).json?.plan?.cancelAtEnd === false);
  check('a change that is an upgrade is a 422 (it is paid for, not scheduled)', (await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: 'pro', nextPeriod: 'month' })).status === 422);
  check('an unknown field or a wrong type is a 400', (await owner.j.call('PUT', '/api/billing/subscription', { autoRenew: 'yes' })).status === 400 && (await owner.j.call('PUT', '/api/billing/subscription', {})).status === 400);
  check('a free account cannot change a plan it does not have (422)', (await dan.j.call('PUT', '/api/billing/subscription', { autoRenew: false })).status === 422);

  // Up to Pro, then a downgrade is scheduled and withdrawn.
  const up = await owner.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'pro', period: 'month' });
  await owner.j.call('POST', '/api/admin/billing/simulate', { orderId: up.json?.order?.id });
  const beforeFlag = (await store.getSubscription(owner.id)).autoRenew;
  const half = await owner.j.call('PUT', '/api/billing/subscription', { autoRenew: !beforeFlag, nextPlan: 'max', nextPeriod: 'month' });
  check('a request whose plan change is refused changes nothing at all (not even auto-renew)', half.status === 422 && (await store.getSubscription(owner.id)).autoRenew === beforeFlag, String(half.status));
  const both = await owner.j.call('PUT', '/api/billing/subscription', { autoRenew: !beforeFlag, nextPlan: 'plus', nextPeriod: 'month' });
  check('  and one that is accepted applies both', both.status === 200 && both.json.plan.autoRenew === !beforeFlag && both.json.plan.nextPlan === 'plus', JSON.stringify(both.json?.plan));
  await owner.j.call('PUT', '/api/billing/subscription', { autoRenew: beforeFlag, nextPlan: null });
  const down = await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: 'plus', nextPeriod: 'month' });
  check('a downgrade is scheduled for the period end', down.status === 200 && down.json?.plan?.plan === 'pro' && down.json.plan.nextPlan === 'plus' && down.json.plan.nextPeriod === 'month', JSON.stringify(down.json));
  mails.length = 0;
  const cancelling = await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: 'plus', nextPeriod: 'year', cancelAtEnd: true });
  check('a plan change asked together with cancelling at the end tells nobody about a change', cancelling.status === 200 && cancelling.json.plan.cancelAtEnd === true && !mails.some((m) => m.to === owner.email), mails.map((m) => m.subject).join());
  const keeping = await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: 'plus', nextPeriod: 'year', cancelAtEnd: false });
  check('  and without cancelling the change is told, after it is in', keeping.status === 200 && mails.some((m) => m.to === owner.email && /Plus/.test(m.subject)), mails.map((m) => m.subject).join());
  const withdrawn = await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: null });
  check('  and withdrawn with nextPlan null', withdrawn.status === 200 && withdrawn.json?.plan?.nextPlan === null && (await store.getSubscription(owner.id)).nextPlan === null);
  check('the subscription row is still there (a plan is ended, never deleted)', !!(await store.getSubscription(owner.id)));
}

section('promo codes');
{
  const make = (body, who = owner) => who.j.call('POST', '/api/admin/billing/promos', body);
  check('a short code is a 400', (await make({ code: 'SHORT', creditVnd: 5000, maxUses: 3 })).status === 400);
  check('a code with a symbol is a 400', (await make({ code: 'ABCD-EFGH', creditVnd: 5000, maxUses: 3 })).status === 400);
  check('a credit under 1,000đ or over 1,000,000đ is a 400', (await make({ code: 'LOWCREDIT1', creditVnd: 500, maxUses: 3 })).status === 400 && (await make({ code: 'HIGHCREDIT1', creditVnd: 1_000_001, maxUses: 3 })).status === 400);
  check('uses under 1 or over 10,000 is a 400', (await make({ code: 'NOUSES0001', creditVnd: 5000, maxUses: 0 })).status === 400 && (await make({ code: 'MANYUSES01', creditVnd: 5000, maxUses: 10_001 })).status === 400);
  check('without the billing permission it is a 403', (await make({ code: 'WELCOME2026', creditVnd: 5000, maxUses: 3 }, carol)).status === 403);
  const made = await make({ code: 'welcome2026', creditVnd: 20_000, maxUses: 2 });
  check('a good one is created, upper-cased', made.status === 201 && made.json?.promo?.code === 'WELCOME2026' && made.json.promo.creditVnd === 20_000 && made.json.promo.maxUses === 2, JSON.stringify(made.json));
  check('  the same code twice is a 409', (await make({ code: 'WELCOME2026', creditVnd: 20_000, maxUses: 2 })).status === 409);
  check('  the list shows it', (await owner.j.call('GET', '/api/admin/billing/promos')).json?.promos?.some((p) => p.code === 'WELCOME2026'));
  await store.createPromo({ code: 'LONGAGO2020', creditVnd: 5000, maxUses: 5, expiresAt: new Date(Date.now() - 86_400_000) });
  await make({ code: 'SWITCHEDOFF1', creditVnd: 5000, maxUses: 5 });
  check('a code can be switched off', (await owner.j.call('DELETE', '/api/admin/billing/promos/SWITCHEDOFF1')).status === 200 && (await owner.j.call('DELETE', '/api/admin/billing/promos/NOSUCHCODE1')).status === 404);

  // Dan is an administrator with nothing yet: not billable until the credit lands, and then at once.
  forgetBillable();
  check('before: the account is not billable', (await isBillable(dan.id)) === false);
  const redeem = (code, who = dan) => who.j.call('POST', '/api/billing/promo', { code });
  const first = await redeem('Welcome2026');
  check('a code is redeemed whatever its case, and credits the balance', first.status === 200 && first.json?.creditedVnd === 20_000 && first.json.balanceVnd === 20_000 && (await store.billingState(dan.id)).balanceVnd === 20_000, JSON.stringify(first.json));
  check('  the account is billable at once, not after the 30-second answer runs out', (await isBillable(dan.id)) === true);
  check('  and it starts no 12-month clock', (await store.billingState(dan.id)).lastTopupAt === null);
  const bad = [
    await redeem('NOSUCHCODE1'),
    await redeem('WELCOME2026'), // already used by this account
    await redeem('LONGAGO2020'), // expired
    await redeem('SWITCHEDOFF1'), // disabled
    await redeem('x'),
    await redeem('not a code!'),
  ];
  const sameBody = bad.every((r) => r.status === 400 && JSON.stringify(r.json) === JSON.stringify(bad[0].json));
  check('wrong, used, expired, disabled and malformed codes give the same 400 body', sameBody && bad[0].json?.error === 'That code did not work.', bad.map((r) => `${r.status} ${JSON.stringify(r.json)}`).join(' | '));
  const second = await redeem('WELCOME2026', owner);
  const third = await redeem('WELCOME2026', carol);
  check('a code with two uses is spent after two accounts', second.status === 200 && third.status === 400, `${second.status} ${third.status}`);
  check('  carol\'s try credited nothing', (await store.billingState(carol.id)).balanceVnd === 0);
  await owner.j.call('POST', '/api/admin/billing/promos', { code: 'ZZZ12345', creditVnd: 1000, maxUses: 1 });
  const tries = [];
  for (let i = 0; i < 11; i += 1) tries.push((await frank.j.call('POST', '/api/billing/promo', { code: `GUESSCODE${i}` })).status);
  check('the eleventh try in an hour is a 429', tries[10] === 429 && tries.slice(0, 10).every((s) => s === 400), tries.join());
  check('a code is switched off in the record', (await store.listAudit(owner.id, 50)).some((e) => e.kind === 'billing_promo_disabled') && (await store.listAudit(owner.id, 50)).some((e) => e.kind === 'billing_promo_created'));
  check('promo.js refuses a bad code with the status and the message', await (async () => {
    try { await promo.redeem(dan.id, 'NOSUCHCODE2'); return false; } catch (err) { return err.status === 400 && err.message === 'That code did not work.'; }
  })());
}

section('unmatched transfers: assign once, or dismiss');
{
  globalThis.unmatchedFor = async (ref, amount) => {
    const r = await takeTransfer({ id: null, referenceCode: ref, gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: null, content: 'no code in this', transferType: 'in', transferAmount: amount }, { via: 'webhook' });
    return r.transferId;
  };
  const unmatched = globalThis.unmatchedFor;
  const t1 = await unmatched('REF-ASSIGN-1', 70_000);
  check('a transfer with no code is unmatched', (await store.getTransfer(t1)).outcome === 'unmatched' && (await store.getTransfer(t1)).creditedAt === null);
  const list = await owner.j.call('GET', '/api/admin/billing/transfers?outcome=unmatched');
  check('the billing administrator lists it, content and all', list.status === 200 && list.json?.transfers?.some((t) => t.id === t1 && t.content === 'no code in this' && t.amountVnd === 70_000), JSON.stringify(list.json).slice(0, 200));
  check('  an ordinary account cannot', (await bob.j.call('GET', '/api/admin/billing/transfers')).status === 403 && (await carol.j.call('GET', '/api/admin/billing/transfers')).status === 403);
  check('assign: an email nobody has is a 404, a transfer that does not exist a 404', (await owner.j.call('POST', `/api/admin/billing/transfers/${t1}/assign`, { email: 'nobody@example.test' })).status === 404 && (await owner.j.call('POST', '/api/admin/billing/transfers/999999/assign', { email: bob.email })).status === 404);
  check('  without an email it is a 400', (await owner.j.call('POST', `/api/admin/billing/transfers/${t1}/assign`, {})).status === 400);
  check('  nothing was credited by those', (await store.billingState(bob.id)).balanceVnd === 0 && (await store.getTransfer(t1)).creditedAt === null);
  // Two assigns at once: the money is credited once.
  const [a, b] = await Promise.all([
    owner.j.call('POST', `/api/admin/billing/transfers/${t1}/assign`, { email: bob.email }),
    dan.j.call('POST', `/api/admin/billing/transfers/${t1}/assign`, { email: bob.email }),
  ]);
  const codes = [a.status, b.status].sort();
  check('two assigns at once: one is a 200 and the other a 409', codes[0] === 200 && codes[1] === 409, `${a.status} ${b.status}`);
  const after = await store.billingState(bob.id);
  check('  the account was credited once, and the clock started (it is real money)', after.balanceVnd === 70_000 && after.lastTopupAt !== null, JSON.stringify(after));
  const entries = (await store.listBalanceEntries(bob.id)).filter((e) => e.kind === 'assign');
  check('  one ledger entry of kind assign, referring to the transfer', entries.length === 1 && entries[0].deltaVnd === 70_000 && entries[0].ref === String(t1));
  const tr = await store.getTransfer(t1);
  check('  the transfer says assigned, to that account', tr.outcome === 'assigned' && tr.userId === bob.id && tr.creditedAt !== null);
  const receipts = await store.listReceipts(bob.id);
  check('  and the account has a receipt for it', receipts.length === 1 && receipts[0].amountVnd === 70_000 && receipts[0].transferId === t1, JSON.stringify(receipts.map((r) => r.number)));
  check('the same money can never be credited again, even by the store (credited_at gate)', (await store.creditTransfer({ transferId: t1, userId: bob.id, vnd: 70_000, kind: 'assign' })) === null && (await store.billingState(bob.id)).balanceVnd === 70_000);
  check('a dismiss of an assigned transfer is a 409', (await owner.j.call('POST', `/api/admin/billing/transfers/${t1}/dismiss`)).status === 409);

  const t2 = await unmatched('REF-DISMISS-1', 55_000);
  check('dismiss: the billing permission is needed (403)', (await carol.j.call('POST', `/api/admin/billing/transfers/${t2}/dismiss`)).status === 403);
  const dis = await owner.j.call('POST', `/api/admin/billing/transfers/${t2}/dismiss`);
  const t2row = await store.getTransfer(t2);
  check('a dismissed transfer credits nothing', dis.status === 200 && t2row.outcome === 'dismissed' && t2row.creditedAt === null && (await store.billingState(bob.id)).balanceVnd === 70_000);
  check('  and cannot then be assigned (409) or dismissed again (409)', (await owner.j.call('POST', `/api/admin/billing/transfers/${t2}/assign`, { email: bob.email })).status === 409 && (await owner.j.call('POST', `/api/admin/billing/transfers/${t2}/dismiss`)).status === 409 && (await store.billingState(bob.id)).balanceVnd === 70_000);
  const record = (await store.listAudit(owner.id, 80)).map((e) => e.kind);
  check('both are in the record', record.includes('billing_transfer_assigned') && record.includes('billing_transfer_dismissed'), record.join());

  const simTransfer = await store.recordTransfer({ dedupe: 'ref:SIM-UNMATCHED', referenceCode: 'SIM-UNMATCHED', amountVnd: 10_000, outcome: 'unmatched', via: 'simulated' });
  const simAssign = await owner.j.call('POST', '/api/admin/billing/transfers/' + simTransfer.id + '/assign', { email: bob.email });
  check('a simulated transfer can never be assigned (409), and credits nothing', simAssign.status === 409 && (await store.getTransfer(simTransfer.id)).creditedAt === null);
  const assignedAudit = (await store.listAudit(owner.id, 100)).find((e) => e.kind === 'billing_transfer_assigned');
  check('the record of an assignment names the account it went to', assignedAudit?.detail?.to === bob.id, JSON.stringify(assignedAudit?.detail));
  const lena = await account('lena', { role: 'admin' });
  await lena.j.call('PUT', '/api/billing/profile', { name: 'Lena', email: 'receipts@lena.test', country: 'VN' });
  const t4 = await unmatched('REF-ASSIGN-3', 55_000);
  mails.length = 0;
  await owner.j.call('POST', '/api/admin/billing/transfers/' + t4 + '/assign', { email: lena.email });
  check("the paid mail with the receipt goes to the billing information's email when there is one", mails.some((m) => m.to === 'receipts@lena.test' && /SZR-/.test(m.text)) && !mails.some((m) => m.to === lena.email), mails.map((m) => m.to).join());
  // An ordinary member holding a balance is not metered by billing, but an administrator is, at once.
  const t3 = await unmatched('REF-ASSIGN-2', 90_000);
  forgetBillable();
  check('before: an administrator with nothing is not billable', (await isBillable(carol.id)) === false);
  await owner.j.call('POST', `/api/admin/billing/transfers/${t3}/assign`, { email: carol.email });
  check('after an assign the account is billable at once', (await isBillable(carol.id)) === true);
}

section('mail only goes to accounts that can see billing, and nothing is prepared for a mail that will not go');
{
  const tm = await globalThis.unmatchedFor('REF-MEMBER-1', 45_000);
  mails.length = 0;
  await owner.j.call('POST', '/api/admin/billing/transfers/' + tm + '/assign', { email: bob.email });
  check('a member assigned money is not mailed about a Billing page they cannot open (the money is still theirs)', !mails.some((m) => m.to === bob.email) && (await store.billingState(bob.id)).balanceVnd === 70_000 + 45_000);
  const mona = await account('mona', { role: 'admin' });
  await getStore().creditBalance(mona.id, 10_000, { kind: 'adjust' });
  await getStore().setLowBalance(mona.id, 50_000);
  const savedHost = process.env.SMTP_HOST;
  delete process.env.SMTP_HOST;
  mails.length = 0;
  await billingTick({ now: new Date(Date.now() + 9 * 86_400_000 + 45 * 60_000) });
  process.env.SMTP_HOST = savedHost;
  check('with no mail provider the low-balance tick makes no QR order and marks nothing', (await store.listOrders({ userId: mona.id })).length === 0 && (await getStore().getBillingProfile(mona.id)).lowAlertSentAt === null && mails.length === 0);
}

section('the admin card');
{
  const card = await owner.j.call('GET', '/api/admin/billing');
  check('the figures, the mode and the rate', card.status === 200 && card.json.mode === 'preview' && card.json.figures?.entries?.assign?.inVnd === 260_000 && card.json.rate?.rate === 25_500, JSON.stringify(card.json).slice(0, 300));
  check('  an administrator without the permission gets a 403', (await carol.j.call('GET', '/api/admin/billing')).status === 403);
  check('  and a member a 403', (await bob.j.call('GET', '/api/admin/billing')).status === 403);
  check('  orders are listed', (await owner.j.call('GET', '/api/admin/billing/orders')).json?.orders?.some((o) => o.id === planOrderId));
  check('  without a key, the machine count is null; the limit and the database figures are the defaults', card.json.capacity?.machines?.running === null && card.json.capacity.machines.limit === 20 && card.json.capacity.database.includedBytes === 8e9 && (Number.isFinite(card.json.capacity.database.bytes) || card.json.capacity.database.bytes === null), JSON.stringify(card.json.capacity));
  process.env.E2B_API_KEY = 'e2b-test-key-should-never-leave-0001';
  process.env.E2B_CONCURRENT_LIMIT = '40';
  process.env.DATABASE_INCLUDED_GB = '2';
  const withKey = await owner.j.call('GET', '/api/admin/billing');
  check('with a key it counts the running machines (not the paused one) and uses the configured limits', withKey.json?.capacity?.machines?.running === 3 && withKey.json.capacity.machines.limit === 40 && withKey.json.capacity.database.includedBytes === 2e9, JSON.stringify(withKey.json?.capacity));
  const e2bCalls = outside.filter((u) => u.startsWith('api.e2b.app')).length;
  await owner.j.call('GET', '/api/admin/billing');
  check('  it asks E2B once a minute, not once a request', outside.filter((u) => u.startsWith('api.e2b.app')).length === e2bCalls && e2bCalls >= 1);
  check('  and the key is in no response', !JSON.stringify(withKey.json).includes('e2b-test-key'));
  delete process.env.E2B_API_KEY;
  delete process.env.E2B_CONCURRENT_LIMIT;
  delete process.env.DATABASE_INCLUDED_GB;

  // The key is read from the environment it is given, not from the process's.
  const { capacityOf } = await import('../server/billing/capacity.js');
  const seen = await capacityOf({ bytes: 1, env: { E2B_API_KEY: 'another-e2b-key-0002', E2B_CONCURRENT_LIMIT: '7' } });
  check('capacityOf reads its own env argument', seen.machines.running === 3 && seen.machines.limit === 7 && (await capacityOf({ bytes: 1, env: {} })).machines.running === null);

  // Cost and margin, from seeded paid counters.
  const pool = await import('../server/keyPool.js');
  process.env.EXA_API_KEY = 'exa-cost-test-key-0001';
  process.env.E2B_API_KEY = 'e2b-cost-test-key-0001';
  process.env.TAVILY_API_KEY = 'tavily-cost-test-key-0001';
  const exaKey = (await pool.keysFor('exa', { fresh: true }))[0];
  const tavilyKey = (await pool.keysFor('tavily', { fresh: true }))[0];
  const e2bKey = (await pool.keysFor('e2b', { fresh: true }))[0];
  await pool.countPaid('exa', exaKey.id, 5000);
  await pool.countPaid('tavily', tavilyKey.id, 100);
  await pool.countPaid('e2b', e2bKey.id, 2000);
  // A key removed during the month keeps its counter, and its cost.
  await pool.countPaid('exa', 'removed-key-id', 500);
  await getStore().chargeUsage(carol.id, 'search', 3, 1200, new Date().toISOString().slice(0, 10));
  const costed = (await owner.j.call('GET', '/api/admin/billing')).json;
  const by = costed.cost?.byService;
  check('the card has the real cost of the paid units this month, by service, at the rate', by?.exa?.units === 5500 && by.exa.usd === 5.5 && by.exa.vnd === 140_250 && by.tavily.units === 100 && Math.abs(by.tavily.usd - 0.8) < 1e-9 && by.tavily.vnd === 20_400 && by.e2b.vnd === 51_000, JSON.stringify(costed.cost));
  check('  a service with no paid use is 0 (brave, firecrawl)', by?.brave?.units === 0 && by.brave.vnd === 0 && by.firecrawl.vnd === 0);
  check('  the total, the real money in this month and the margin', costed.cost.totalVnd === 140_250 + 20_400 + 51_000 && costed.revenueMonthVnd === 1200 && costed.promoMonthVnd >= 40_000 && costed.marginVnd === costed.revenueMonthVnd - costed.promoMonthVnd - costed.cost.totalVnd && !('moneyInMonthVnd' in costed), JSON.stringify([costed.cost?.totalVnd, costed.revenueMonthVnd, costed.promoMonthVnd, costed.marginVnd]));
  const realSum = getStore().sumCountersLike;
  getStore().sumCountersLike = async () => { throw new Error('read failed'); };
  const broken = (await owner.j.call('GET', '/api/admin/billing')).json;
  getStore().sumCountersLike = realSum;
  check('  a failed read makes the cost unknown (null), not 0', broken.cost === null && broken.marginVnd === null && !!broken.figures);
  check('  and the 30-day figures are still there', !!costed.figures?.entries && costed.days === 30);
  delete process.env.EXA_API_KEY;
  delete process.env.E2B_API_KEY;
  delete process.env.TAVILY_API_KEY;

  // Held balances never count more than an account really holds (simulated spending lowers the balance, not the real ledger).
  const heldBefore = (await owner.j.call('GET', '/api/admin/billing')).json.figures.balancesHeldVnd;
  const jo = await account('jo', { role: 'admin' });
  await getStore().creditBalance(jo.id, 300_000, { kind: 'adjust' });
  const simPlan = await orders.createOrder(jo.id, { kind: 'plan', plan: 'plus', period: 'month' }, { simulated: true });
  const joBalance = (await store.billingState(jo.id)).balanceVnd;
  const heldAfter = (await owner.j.call('GET', '/api/admin/billing')).json.figures.balancesHeldVnd;
  check('what is held for an account is at most its real balance', simPlan.paidNow && joBalance < 300_000 && heldAfter - heldBefore === joBalance, (heldAfter - heldBefore) + ' vs ' + joBalance);
}

section('the transactions and receipts are the caller\'s own');
{
  const bobsEntries = await bob.j.call('GET', '/api/billing/transactions');
  check('a member cannot (billing is hidden)', bobsEntries.status === 404);
  const mine = await dan.j.call('GET', '/api/billing/transactions');
  check('an administrator reads their own ledger', mine.status === 200 && mine.json.entries.length >= 1 && mine.json.entries.every((e) => e.kind === 'promo') && mine.json.entries[0].deltaVnd === 20_000, JSON.stringify(mine.json).slice(0, 200));
  const filtered = await dan.j.call('GET', '/api/billing/transactions?kind=topup');
  check('  filtered by kind', filtered.status === 200 && filtered.json.entries.length === 0);
  check('  an unknown kind is a 400', (await dan.j.call('GET', '/api/billing/transactions?kind=drop%20table')).status === 400);
  const carolReceipts = await carol.j.call('GET', '/api/billing/receipts');
  const danReceipts = await dan.j.call('GET', '/api/billing/receipts');
  check('receipts: carol sees hers (the assign), dan none', carolReceipts.json?.receipts?.length === 1 && /^SZR-\d{4}-\d{6}$/.test(carolReceipts.json.receipts[0].number) && danReceipts.json?.receipts?.length === 0);
}

section('the running balance on each transaction');
{
  const ivy = await account('ivy', { role: 'admin' });
  await getStore().creditBalance(ivy.id, 100_000, { kind: 'adjust' });
  await getStore().debitBalance(ivy.id, 30_000, { kind: 'adjust' });
  await getStore().creditBalance(ivy.id, 50_000, { kind: 'topup', topup: true });
  const all = (await ivy.j.call('GET', '/api/billing/transactions')).json.entries.map((e) => e.balanceAfterVnd);
  const only = (await ivy.j.call('GET', '/api/billing/transactions?kind=adjust')).json.entries.map((e) => e.balanceAfterVnd);
  check('each row says what the balance was after it, newest first', all.join() === '120000,70000,100000', all.join());
  check('  and a filter by kind does not change those figures', only.join() === '70000,100000', only.join());
}

section('mail: every kind, both languages');
{
  const data = {
    paid: { amountVnd: 129_000, what: { kind: 'plan', plan: 'pro', period: 'month' }, balanceVnd: 0, receiptNumber: 'SZR-2026-000012' },
    'plan-changed': { plan: 'plus', period: 'month', change: 'scheduled', effectiveAt: '2026-12-13T00:00:00Z' },
    'renewal-soon': { plan: 'pro', period: 'month', amountVnd: 207_000, endsAt: '2026-12-13T00:00:00Z', code: 'SZ0123456789', balanceVnd: 5_000, qr: { image: 'https://qr.sepay.vn/img?acc=1&bank=MB&amount=202000&des=SZ0123456789', bank: 'MBBank', account: '0123456789', holder: 'SYNAPSEZ', amount: 202_000, content: 'SZ0123456789' } },
    renewed: { plan: 'pro', period: 'month', amountVnd: 207_000, endsAt: '2027-01-13T00:00:00Z' },
    grace: { plan: 'pro', endsAt: '2026-12-16T00:00:00Z', amountVnd: 207_000 },
    ended: { plan: 'pro' },
    'low-balance': { balanceVnd: 30_000, thresholdVnd: 50_000 },
    expiring: { balanceVnd: 120_000, expiresAt: '2027-11-13T00:00:00Z' },
    'late-money': { amountVnd: 100_000, code: 'SZ0123456789' },
  };
  check('the nine kinds are the ones the brief names', Object.keys(data).sort().join() === [...mail.BILLING_MAIL_KINDS].sort().join(), mail.BILLING_MAIL_KINDS.join());
  check('amounts are written the Vietnamese way in vi and the English way in en', mail.formatVnd(129_000, 'vi') === '129.000đ' && mail.formatVnd(129_000, 'en') === '129,000₫' && mail.formatVnd(0, 'vi') === '0đ');
  const problems = [];
  for (const kind of mail.BILLING_MAIL_KINDS) {
    for (const language of ['vi', 'en']) {
      const m = mail.buildBillingMail(kind, { language, data: data[kind], baseUrl: 'https://app.test' });
      const all = `${m.subject}\n${m.html}\n${m.text}`;
      if (/undefined|NaN|\[object|null\b/.test(all)) problems.push(`${kind}/${language}: has undefined, NaN or null`);
      if (!m.subject || !m.html.includes('<html') || !m.text) problems.push(`${kind}/${language}: incomplete`);
      if (language === 'vi' && !/[ạảãàáâăđêôơưệ]/i.test(m.text)) problems.push(`${kind}/vi: not Vietnamese`);
      if (language === 'en' && /đ\b|[ạảãàáâăêôơư]/i.test(m.text.replace(/₫/g, ''))) problems.push(`${kind}/en: has Vietnamese in it`);
      // No white text on an inline gradient: a gradient may only sit on an empty cell with a solid colour first.
      for (const g of m.html.matchAll(/<(td|div|span|a)\b[^>]*style="([^"]*gradient[^"]*)"[^>]*>([\s\S]*?)<\/\1>/g)) if (g[3].trim() !== '&nbsp;' || !/background-color:#[0-9a-f]{6};background-image/.test(g[2])) problems.push(`${kind}/${language}: text over a gradient`);
      const links = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      if (kind === 'paid' && !links.some((l) => l.includes('SZR-2026-000012'))) problems.push('paid: no receipt link');
      if (links.some((l) => !/^https?:|^mailto:/.test(l))) problems.push(`${kind}/${language}: odd link ${links.join(' ')}`);
    }
  }
  check('each renders in both languages with no undefined, NaN or gradient behind text, and a receipt link', problems.length === 0, problems.slice(0, 5).join(' | '));
  check('the receipt is linked by URL, never attached', !mail.buildBillingMail('paid', { language: 'en', data: data.paid, baseUrl: 'https://app.test' }).html.includes('attachment') && mail.buildBillingMail('paid', { language: 'en', data: data.paid, baseUrl: 'https://app.test' }).html.includes('https://app.test/api/billing/receipts/SZR-2026-000012.pdf'));
  const bare = mail.buildBillingMail('renewal-soon', { language: 'vi', data: { plan: 'plus' }, baseUrl: 'https://app.test' });
  check('a mail with half its data still has no undefined', !/undefined|NaN/.test(bare.html + bare.text));
  const sent = await mail.sendBillingMail('ended', { id: dan.id, email: dan.email, name: 'Dan' }, { plan: 'pro' });
  check('sendBillingMail sends to the account\'s address in its language', sent?.ok === true && mails.at(-1)?.to === dan.email && /pro/i.test(mails.at(-1).text), JSON.stringify(sent));
}

section('late money is told, once');
{
  const user = dan;
  const planned = await dan.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'plus', period: 'month' });
  const order = planned.json.order;
  await getStore().cancelOrder(order.id, user.id);
  mails.length = 0;
  const payload = { id: null, referenceCode: 'REF-LATE-1', gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: order.code, content: order.code, transferType: 'in', transferAmount: 60_000 };
  const first = await takeTransfer(payload, { via: 'webhook' });
  check('money for an order that is closed is late (and credited)', first.outcome === 'late' && (await store.billingState(user.id)).balanceVnd === 80_000);
  const lateMails = mails.filter((m) => m.to === user.email);
  check('  and the account is told', lateMails.length === 1 && /60[.,]000/.test(lateMails[0].text), JSON.stringify(lateMails.map((m) => m.subject)));
  await takeTransfer(payload, { via: 'webhook' });
  check('  the same transfer delivered again tells nobody twice', mails.filter((m) => m.to === user.email).length === 1);

  // A top-up locks no price: money after its QR ran out, or after it was cancelled, is still the top-up.
  const before = (await store.billingState(user.id)).balanceVnd;
  const t1 = await orders.createOrder(user.id, { kind: 'topup', amountVnd: 50_000 }, { now: new Date(Date.now() - 2 * 3_600_000) });
  await getStore().expireOrders(new Date());
  mails.length = 0;
  const lateTop = await takeTransfer({ ...payload, referenceCode: 'REF-LATE-2', code: t1.order.code, content: t1.order.code, transferAmount: 50_000 }, { via: 'webhook' });
  check('money for an expired top-up ends topup: credited, order closed as paid, a receipt, and no late mail', lateTop.outcome === 'topup' && (await store.billingState(user.id)).balanceVnd === before + 50_000 && (await store.getOrder(t1.order.id)).status === 'paid' && !!(await store.receiptForTransfer(lateTop.transferId)) && !mails.some((m) => /after the order had closed|sau khi đơn hàng đóng/.test(m.subject)), JSON.stringify([lateTop.outcome, mails.map((m) => m.subject)]));
  const t2 = await orders.createOrder(user.id, { kind: 'topup', amountVnd: 50_000 });
  await getStore().cancelOrder(t2.order.id, user.id);
  const cancelledTop = await takeTransfer({ ...payload, referenceCode: 'REF-LATE-3', code: t2.order.code, content: t2.order.code, transferAmount: 50_000 }, { via: 'webhook' });
  check('  a cancelled top-up too, and it stays cancelled', cancelledTop.outcome === 'topup' && (await store.getOrder(t2.order.id)).status === 'cancelled');
  const again = await takeTransfer({ ...payload, referenceCode: 'REF-LATE-4', code: t1.order.code, content: t1.order.code, transferAmount: 50_000 }, { via: 'webhook' });
  check('  but a second transfer to a top-up that is already paid stays late', again.outcome === 'late');
}

section('the day\'s work');
{
  const TICK = new Date();
  // An old pending order is closed; a transfer left "taking" is finished.
  const stale = await orders.createOrder(frank.id, { kind: 'topup', amountVnd: 60_000 }, { now: new Date(Date.now() - 2 * 3_600_000) });
  const live = await orders.createOrder(frank.id, { kind: 'topup', amountVnd: 50_000 });
  const taking = await getStore().recordTransfer({
    dedupe: 'ref:SWEEP-1', sepayId: null, referenceCode: 'SWEEP-1', gateway: 'Bank', accountNumber: '0123456789', amountVnd: 50_000, code: live.order.code, content: live.order.code,
    transactionAt: new Date(), orderId: live.order.id, userId: frank.id, outcome: 'taking', via: 'webhook',
  });
  const before = (await store.billingState(frank.id)).balanceVnd;
  const first = await billingTick({ now: TICK });
  check('the first tick of the day does the daily part', first.daily !== null && typeof first.daily === 'object', JSON.stringify(first.daily));
  check('  and closes orders past their time', (await store.getOrder(stale.order.id)).status === 'expired' && first.expired >= 1, JSON.stringify(first));
  check('  a transfer still "taking" that is only seconds old is left alone', (await store.getTransfer(taking.id)).outcome === 'taking' && (await store.billingState(frank.id)).balanceVnd === before);
  const later = await billingTick({ now: new Date(TICK.getTime() + 10 * 60_000) });
  const resumed = await store.getTransfer(taking.id);
  check('  after a few minutes it is finished: credited, order paid, receipt', resumed.outcome === 'topup' && (await store.billingState(frank.id)).balanceVnd === before + 50_000 && (await store.getOrder(live.order.id)).status === 'paid' && !!(await store.receiptForTransfer(taking.id)) && later.resumed === 1, JSON.stringify([resumed.outcome, later.resumed]));
  check('a second tick the same Vietnamese day does not do the daily part', later.daily === null, JSON.stringify(later.daily));
  check('  but still does the cheap part', typeof later.expired === 'number' && typeof later.reminders === 'number');
  const tomorrow = await billingTick({ now: new Date(TICK.getTime() + 26 * 3_600_000) });
  check('the next day does the daily part again', tomorrow.daily !== null);
  process.env.BILLING_MODE = 'off';
  const quiet = await billingTick({ now: new Date(TICK.getTime() + 60 * 3_600_000) });
  delete process.env.BILLING_MODE;
  check('with billing off the tick does nothing', quiet.daily === null && quiet.expired === 0);

  // Through the heartbeat: it runs, and its answer is in the heartbeat's.
  const beat = await realFetch(`${base}/api/cron/run-tasks`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const beatJson = await beat.json().catch(() => ({}));
  check('the heartbeat calls the tick and reports it', beat.status === 200 && beatJson.billing && typeof beatJson.billing.expired === 'number', `${beat.status} ${JSON.stringify(beatJson).slice(0, 200)}`);
}

section('low balance, once until it is topped up again; expiry warned 30 days ahead');
{
  const gina = await account('gina', { role: 'admin' });
  await getStore().creditBalance(gina.id, 30_000, { kind: 'adjust' });
  await getStore().setLowBalance(gina.id, 50_000);
  const hers = () => mails.filter((m) => m.to === gina.email && /số dư|balance/i.test(m.subject));
  mails.length = 0;
  const day = (n) => new Date(Date.now() + n * 86_400_000 + 30 * 60_000);
  await billingTick({ now: day(5) });
  check('below the threshold: one mail', hers().length === 1 && (await getStore().getBillingProfile(gina.id)).lowAlertSentAt !== null, String(hers().length));
  check('  it carries a QR for the smallest top-up, an order made for it, and the amount', /qr\.sepay\.vn/.test(hers()[0].html) && /SZ\d{10}/.test(hers()[0].text) && (await store.listOrders({ userId: gina.id })).some((o) => o.kind === 'topup' && o.totalVnd === TOPUP.minNoPlan) && /50[.,]000/.test(hers()[0].text), hers()[0].text.slice(0, 300));
  const kim = await account('kim', { role: 'admin' });
  await getStore().creditBalance(kim.id, 50_000, { kind: 'adjust' });
  await getStore().setLowBalance(kim.id, 50_000);
  await billingTick({ now: day(5) });
  check('  a balance exactly at the threshold is not below it: no mail', !mails.some((m) => m.to === kim.email));
  await billingTick({ now: day(6) });
  check('  the next day: no second mail', hers().length === 1);
  await getStore().creditBalance(gina.id, 100_000, { kind: 'adjust' });
  await billingTick({ now: day(7) });
  check('  topped up above the threshold: the mark is cleared', (await getStore().getBillingProfile(gina.id)).lowAlertSentAt === null && hers().length === 1);
  await getStore().debitBalance(gina.id, 120_000, { kind: 'adjust' });
  await billingTick({ now: day(8) });
  check('  and when it falls again, one more', hers().length === 2);

  // Expiry: a real top-up, then a tick 335 days later is inside the 30-day warning, 366 days later is past it.
  const credited = await getStore().creditBalance(gina.id, 40_000, { kind: 'topup', topup: true });
  const lastTop = (await getStore().billingState(gina.id)).lastTopupAt;
  const warnAt = new Date(lastTop.getTime() + 340 * 86_400_000);
  mails.length = 0;
  await billingTick({ now: warnAt });
  const warned = mails.filter((m) => m.to === gina.email && /hết hạn|expire/i.test(m.subject));
  check('thirty days before it expires she is told', warned.length === 1 && credited > 0, mails.map((m) => m.subject).join(' | '));
  await billingTick({ now: new Date(warnAt.getTime() + 86_400_000) });
  check('  once', mails.filter((m) => m.to === gina.email && /hết hạn|expire/i.test(m.subject)).length === 1);
  const gone = await billingTick({ now: new Date(lastTop.getTime() + 367 * 86_400_000) });
  const afterExpiry = await getStore().billingState(gina.id);
  check('past 12 months the balance is expired by the day\'s work', afterExpiry.balanceVnd === 0 && (await getStore().listBalanceEntries(gina.id, { kind: 'expire' })).length === 1 && gone.daily?.expired >= 1, JSON.stringify(gone.daily));
}

section('in grace, buying the same plan again is a renewal');
{
  const hana = await account('hana', { role: 'admin' });
  const past = (days) => new Date(Date.now() - days * 86_400_000);
  await getStore().createSubscription({ userId: hana.id, plan: 'pro', period: 'month', status: 'grace', periodStart: past(31), periodEnd: past(1), paidVnd: 207_000, autoRenew: false, cancelAtEnd: false, anchorAt: past(31) });
  const same = await hana.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'pro', period: 'month' });
  check("the same plan and period in grace comes back as a renewal order, for the plan's price", same.status === 200 && same.json?.order?.kind === 'renewal' && same.json.order.plan === 'pro' && same.json.order.totalVnd === planVnd('pro', 'month', 25_500) && same.json.due?.vnd === same.json.order.totalVnd, JSON.stringify(same.json));
  const again = await hana.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'pro', period: 'month' });
  check('  asked again it is the same order, not a second one', again.json?.order?.id === same.json?.order?.id, JSON.stringify(again.json?.order));
  const other = await hana.j.call('POST', '/api/billing/orders', { kind: 'plan', plan: 'max', period: 'month' });
  check('  another plan stays a plan order', other.status === 200 && other.json?.order?.kind === 'plan', JSON.stringify(other.json));
}

// A period's end is often first met by a metered call (isBillable catches up, and its answer is kept for 30 s), not by the daily
// job; the daily job then saw nothing change and told nobody, and the money taken for the renewal had no paid line (final review,
// 2026-11-15). Whoever's statement made the change tells it, once.
section('a plan that renews, goes into grace or ends inside a metered call is told once, with its paid line');
{
  const ago = (ms) => new Date(Date.now() - ms);
  const ended = async (name, over = {}, balance = 0) => {
    const who = await account(name, { role: 'admin' });
    // A month that ended a minute ago, begun a calendar month before (the anchor), so the renewed period is a whole month.
    const end = ago(60_000);
    const monthBefore = addMonths(end, -1);
    await getStore().createSubscription({ userId: who.id, plan: 'plus', period: 'month', status: 'active', periodStart: monthBefore, periodEnd: end, paidVnd: 129_000, autoRenew: true, cancelAtEnd: false, anchorAt: monthBefore, ...over });
    if (balance) await getStore().creditBalance(who.id, balance, { kind: 'topup', topup: true });
    forgetBillable(who.id);
    return who;
  };
  const mailsTo = (who, subject) => mails.filter((m) => m.to === who.email && subject.test(m.subject));
  const paidLines = async (who) => (await store.listAudit(who.id, 50)).filter((e) => e.kind === 'billing_order_paid');
  const RENEWED = /plan was renewed|đã được gia hạn$/;
  const GRACE = /period is over|đã hết kỳ/;
  const ENDED = /plan has ended|đã kết thúc/;

  const rae = await ended('rae', {}, 300_000);
  const endedAt = (await store.getSubscription(rae.id)).periodEnd;
  mails.length = 0;
  const hold = await holdSearch(rae.id);
  await hold.release();
  const renewed = await store.getSubscription(rae.id);
  const price = planVnd('plus', 'month', 25_500);
  check('the metered call renews the plan from the balance', renewed.status === 'active' && +renewed.periodStart === +endedAt && (await store.billingState(rae.id)).balanceVnd === 300_000 - price, JSON.stringify(renewed));
  check('  exactly one renewed mail goes out', mailsTo(rae, RENEWED).length === 1, JSON.stringify(mails.map((m) => [m.to, m.subject])));
  const lines = await paidLines(rae);
  check('  and one paid line is written for the renewal it paid', lines.length === 1 && lines[0].detail?.kind === 'renewal' && lines[0].detail.amountVnd === price && lines[0].detail.plan === 'plus', JSON.stringify(lines.map((l) => l.detail)));
  await billingTick({ now: new Date() });
  await rae.j.call('GET', '/api/billing');
  check('  the daily job and the Billing page afterwards send nothing more and write no second line', mailsTo(rae, RENEWED).length === 1 && (await paidLines(rae)).length === 1, JSON.stringify(mails.map((m) => [m.to, m.subject])));

  const gus = await ended('gus', {}, 10_000);
  mails.length = 0;
  await (await holdSearch(gus.id)).release();
  check('a short balance: the metered call moves it into grace', (await store.getSubscription(gus.id)).status === 'grace');
  check('  exactly one grace mail goes out, and no paid line', mailsTo(gus, GRACE).length === 1 && (await paidLines(gus)).length === 0, JSON.stringify(mails.map((m) => [m.to, m.subject])));
  await billingTick({ now: new Date() });
  await gus.j.call('GET', '/api/billing');
  check('  the daily job afterwards sends no second grace mail', mailsTo(gus, GRACE).length === 1, JSON.stringify(mails.map((m) => [m.to, m.subject])));

  const uma = await ended('uma', { cancelAtEnd: true });
  mails.length = 0;
  await (await holdSearch(uma.id)).release();
  check('set to end: the metered call ends it, and one ended mail goes out', (await store.getSubscription(uma.id)).status === 'ended' && mailsTo(uma, ENDED).length === 1, JSON.stringify(mails.map((m) => [m.to, m.subject])));
  await billingTick({ now: new Date() });
  check('  the daily job afterwards sends no second one', mailsTo(uma, ENDED).length === 1);

  // Two at once: one statement renews it, so one mail and one paid line, whichever caller won.
  const zoe = await ended('zoe', {}, 300_000);
  mails.length = 0;
  await Promise.all([holdSearch(zoe.id).then((h) => h.release()), billingTick({ now: new Date() }), zoe.j.call('GET', '/api/billing')]);
  check('a metered call, the daily job and the Billing page at once: one renewal, one mail, one paid line', (await store.billingState(zoe.id)).balanceVnd === 300_000 - price && mailsTo(zoe, RENEWED).length === 1 && (await paidLines(zoe)).length === 1, JSON.stringify([(await store.billingState(zoe.id)).balanceVnd, mailsTo(zoe, RENEWED).length, (await paidLines(zoe)).length]));

  // A mail provider that fails must not fail the metered call: the renewal and its paid line stand. holdSearch never throws (a
  // failure inside it is an unpaid NOT_BILLED), so what proves it is a real hold on the plan that has just renewed.
  const ned = await ended('ned', {}, 300_000);
  email.__testing.useTransport({ sendMail: async () => { throw new Error('the provider is down'); } });
  const during = await holdSearch(ned.id);
  await during.release();
  email.__testing.useTransport({
    sendMail: async (m) => {
      mails.push({ to: [].concat(m.to).join(','), subject: m.subject, html: m.html, text: m.text });
      return { messageId: '<t@test>', accepted: [].concat(m.to), rejected: [], response: '250 OK' };
    },
  });
  check('a mail provider that fails does not fail the metered call', during.billed === true && during.source === 'included' && (await store.getSubscription(ned.id)).status === 'active' && (await paidLines(ned)).length === 1, JSON.stringify({ billed: during.billed, source: during.source }));
}

// Controller ruling (final review): only an account that can see billing renews from its balance. A demoted administrator's plan is
// hidden from them (and no longer meters anything), so the daily job must not keep paying for it out of their balance.
section('a demoted administrator is not renewed from the balance');
{
  const dee = await account('dee', { role: 'user' });
  const ago = (ms) => new Date(Date.now() - ms);
  await getStore().createSubscription({ userId: dee.id, plan: 'plus', period: 'month', status: 'active', periodStart: addMonths(ago(60_000), -1), periodEnd: ago(60_000), paidVnd: 129_000, autoRenew: true, cancelAtEnd: false, anchorAt: addMonths(ago(60_000), -1) });
  await getStore().creditBalance(dee.id, 300_000, { kind: 'topup', topup: true });
  await billingTick({ now: new Date() });
  const sub = await store.getSubscription(dee.id);
  check('the daily job leaves the balance alone and the plan goes into grace', (await store.billingState(dee.id)).balanceVnd === 300_000 && sub.status === 'grace' && !(await store.listOrders({ userId: dee.id })).some((o) => o.status === 'paid'), JSON.stringify([sub.status, (await store.billingState(dee.id)).balanceVnd]));
  check('  and nobody is mailed about a Billing page they cannot open', !mails.some((m) => m.to === dee.email));
}

section('your data');
{
  const exp = await bob.j.call('GET', '/api/account/export');
  const body = JSON.parse(exp.text);
  check('the export carries the billing section', exp.status === 200 && body.billing && Array.isArray(body.billing.orders) && Array.isArray(body.billing.entries) && Array.isArray(body.billing.receipts) && 'profile' in body.billing, Object.keys(body.billing || {}).join());
  check('  a receipt as a number, a date and an amount', body.billing.receipts.length === 2 && body.billing.receipts.every((r) => /^SZR-/.test(r.number) && !!r.issuedAt) && body.billing.receipts.some((r) => r.amountVnd === 70_000), JSON.stringify(body.billing.receipts));
  check('  the ledger too', body.billing.entries.some((e) => e.kind === 'assign' && e.deltaVnd === 70_000));
  const danExport = JSON.parse((await dan.j.call('GET', '/api/account/export')).text);
  check('the billing information is in the owner\'s own export, in the clear', danExport.billing.profile?.email === 'tran.a@example.test' && danExport.billing.orders.length >= 1, JSON.stringify(danExport.billing.profile));
  check('  and nobody else\'s orders or ledger are in it', danExport.billing.orders.every((o) => o.code) && !JSON.stringify(danExport.billing).includes(bob.id) && !JSON.stringify(danExport.billing).includes('REF-ASSIGN-1'));
  check('no sealed text travels in it', !/buyerSealed|buyer_sealed|"sealed"/.test(exp.text) && !/"v2\.[A-Za-z0-9_-]+\./.test(exp.text));
}

section('the rate once a day, from the 06:00 cron');
{
  const cron = (headers = { Authorization: `Bearer ${process.env.CRON_SECRET}` }) => realFetch(`${base}/api/cron/refresh-models`, { headers });
  await store.setSetting('billing_fx', { rate: 25_500, source: 'erapi', at: new Date(Date.now() - 30 * 3_600_000).toISOString() });
  check('without the cron secret the rate is not touched', (await cron({})).status === 401 && (await store.getSetting('billing_fx')).source === 'erapi');
  // The finance layer remembers a source that failed earlier in this run: forget it, as a day would.
  (await import('../server/finance/cache.js')).__resetCache();
  (await import('../server/finance/http.js')).__resetHttp();
  (await import('../server/billing/fx.js'))._resetFxForTests();
  frankUp = true;
  const res = await cron();
  const body = await res.json().catch(() => null);
  const kept = await store.getSetting('billing_fx');
  // Here no catalogue answers, so the refresh itself is a 500 as it always was; the rate was read all the same.
  check('the model refresh also reads the rate, from Frankfurter first, whatever became of the library', res.status === 500 && kept.rate === 25_736 && kept.source === 'frankfurter' && body?.rate === undefined, JSON.stringify([res.status, kept, body]));
  const { refreshRate } = await import('../server/billing/fx.js');
  check('  and refreshRate answers the rate with its source', (await refreshRate({ force: true }))?.source === 'frankfurter');
  const plansNow = await owner.j.call('GET', '/api/billing/plans');
  check('/plans says which source the rate came from, so the client knows whether a link is owed', plansNow.json?.rate?.rate === 25_736 && plansNow.json.rate.source === 'frankfurter' && typeof plansNow.json.rate.at === 'string', JSON.stringify(plansNow.json?.rate));
  check('  and Frankfurter, which asks for no link, sends no attribution text', !('attribution' in plansNow.json.rate), JSON.stringify(plansNow.json?.rate));

  // A day later, with the library answering: the cron's own answer carries the rate.
  const aged = async () => {
    await store.setSetting('billing_fx', { rate: 25_736, source: 'frankfurter', at: new Date(Date.now() - 30 * 3_600_000).toISOString() });
    const finance = await import('../server/finance/cache.js');
    finance.__resetCache();
    // The answer a source gave is also kept in the database for a while: forget it so the next read asks again.
    for (const source of ['frankfurter', 'erapi']) await finance.forget(`${source}|fx|USD|VND|latest`);
    (await import('../server/finance/http.js')).__resetHttp();
    (await import('../server/billing/fx.js'))._resetFxForTests();
  };
  catalogueUp = true;
  await aged();
  const good = await cron();
  const goodBody = await good.json().catch(() => null);
  check('the cron answers with the rate it read: rate, source and at', good.status === 200 && goodBody?.rate?.rate === 25_736 && goodBody.rate.source === 'frankfurter' && typeof goodBody.rate.at === 'string' && Object.keys(goodBody.rate).length === 3, JSON.stringify(goodBody?.rate));

  // Every source down, the kept rate a day old: the chain really is asked, finds nobody, and the model refresh is none the worse.
  await aged();
  frankUp = false;
  rateUp = false;
  const asked = outside.length;
  const failing = await cron();
  const failBody = await failing.json().catch(() => null);
  check('every rate source down: the sources were asked, the kept rate stays, the model refresh still succeeds with rate null', failing.status === 200 && failBody?.rate === null && outside.slice(asked).some((x) => x.startsWith('api.frankfurter.dev')) && (await store.getSetting('billing_fx')).rate === 25_736, JSON.stringify([failing.status, failBody?.rate, outside.slice(asked)]));
  rateUp = true;

  process.env.BILLING_MODE = 'off';
  const skipped = await cron();
  const skipBody = await skipped.json().catch(() => null);
  delete process.env.BILLING_MODE;
  check('billing off: nothing is asked and the answer says skipped, not "no source answered"', skipped.status === 200 && skipBody?.rate?.skipped === 'off', JSON.stringify(skipBody?.rate));
  catalogueUp = false;
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mAll billing route checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
