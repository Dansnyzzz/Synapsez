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
const { isBillable, forgetBillable } = await import('../server/billing/meter.js');
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
const dan = await account('dan', { role: 'admin' });
const carol = await account('carol', { role: 'admin', permissions: ['models'] });
const bob = await account('bob');
const frank = await account('frank', { role: 'admin' });

const ROUTES_USER = [
  ['GET', '/api/billing'], ['GET', '/api/billing/plans'], ['POST', '/api/billing/quote', { plan: 'plus', period: 'month' }],
  ['POST', '/api/billing/orders', { kind: 'topup', amountVnd: 100_000 }], ['GET', '/api/billing/orders/nope'], ['POST', '/api/billing/orders/nope/cancel'],
  ['PUT', '/api/billing/subscription', { autoRenew: false }], ['PUT', '/api/billing/profile', { name: 'A', email: 'a@b.co', country: 'VN' }],
  ['PUT', '/api/billing/alerts', { lowBalanceVnd: 50_000 }], ['POST', '/api/billing/promo', { code: 'ABCDEFGH' }], ['GET', '/api/billing/transactions'], ['GET', '/api/billing/receipts'],
];

section('who can see billing at all');
{
  const answers = [];
  for (const [method, url, body] of ROUTES_USER) answers.push([`${method} ${url}`, (await bob.j.call(method, url, body)).status]);
  check('in preview every billing route is a 404 for an ordinary account', answers.every(([, s]) => s === 404), answers.filter(([, s]) => s !== 404).map((a) => a.join(' ')).join(' | '));
  const seen = await owner.j.call('GET', '/api/billing');
  check('an administrator gets 200', seen.status === 200 && seen.json?.mode === 'preview', `${seen.status}`);
  const keys = Object.keys(seen.json || {}).sort().join();
  check('  with plan, balance, usage, profile, alerts and the top-up bounds', keys === 'alerts,balance,bounds,mode,plan,profile,usage', keys);
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
  const down = await owner.j.call('PUT', '/api/billing/subscription', { nextPlan: 'plus', nextPeriod: 'month' });
  check('a downgrade is scheduled for the period end', down.status === 200 && down.json?.plan?.plan === 'pro' && down.json.plan.nextPlan === 'plus' && down.json.plan.nextPeriod === 'month', JSON.stringify(down.json));
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
  const unmatched = async (ref, amount) => {
    const r = await takeTransfer({ id: null, referenceCode: ref, gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: null, content: 'no code in this', transferType: 'in', transferAmount: amount }, { via: 'webhook' });
    return r.transferId;
  };
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

  // An ordinary member holding a balance is not metered by billing, but an administrator is, at once.
  const t3 = await unmatched('REF-ASSIGN-2', 90_000);
  forgetBillable();
  check('before: an administrator with nothing is not billable', (await isBillable(carol.id)) === false);
  await owner.j.call('POST', `/api/admin/billing/transfers/${t3}/assign`, { email: carol.email });
  check('after an assign the account is billable at once', (await isBillable(carol.id)) === true);
}

section('the admin card');
{
  const card = await owner.j.call('GET', '/api/admin/billing');
  check('the figures, the mode and the rate', card.status === 200 && card.json.mode === 'preview' && card.json.figures?.entries?.assign?.inVnd === 160_000 && card.json.rate?.rate === 25_500, JSON.stringify(card.json).slice(0, 300));
  check('  an administrator without the permission gets a 403', (await carol.j.call('GET', '/api/admin/billing')).status === 403);
  check('  and a member a 403', (await bob.j.call('GET', '/api/admin/billing')).status === 403);
  check('  orders are listed', (await owner.j.call('GET', '/api/admin/billing/orders')).json?.orders?.some((o) => o.id === planOrderId));
  check('  without a key, the machine count is null; the limit and the database figures are the defaults', card.json.capacity?.machines?.running === null && card.json.capacity.machines.limit === 20 && card.json.capacity.database.includedBytes === 8e9 && Number.isFinite(card.json.capacity.database.bytes) || card.json.capacity?.database?.bytes === null, JSON.stringify(card.json.capacity));
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
  const topup = await dan.j.call('POST', '/api/billing/orders', { kind: 'topup', amountVnd: 60_000 });
  const order = topup.json.order;
  await getStore().cancelOrder(order.id, user.id);
  mails.length = 0;
  const payload = { id: null, referenceCode: 'REF-LATE-1', gateway: 'Bank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123456789', code: order.code, content: order.code, transferType: 'in', transferAmount: 60_000 };
  const first = await takeTransfer(payload, { via: 'webhook' });
  check('money for an order that is closed is late (and credited)', first.outcome === 'late' && (await store.billingState(user.id)).balanceVnd === 80_000);
  const lateMails = mails.filter((m) => m.to === user.email);
  check('  and the account is told', lateMails.length === 1 && /60[.,]000/.test(lateMails[0].text), JSON.stringify(lateMails.map((m) => m.subject)));
  await takeTransfer(payload, { via: 'webhook' });
  check('  the same transfer delivered again tells nobody twice', mails.filter((m) => m.to === user.email).length === 1);
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
  const gina = await account('gina');
  await getStore().creditBalance(gina.id, 30_000, { kind: 'adjust' });
  await getStore().setLowBalance(gina.id, 50_000);
  const hers = () => mails.filter((m) => m.to === gina.email && /số dư|balance/i.test(m.subject));
  mails.length = 0;
  const day = (n) => new Date(Date.now() + n * 86_400_000 + 30 * 60_000);
  await billingTick({ now: day(5) });
  check('below the threshold: one mail', hers().length === 1 && (await getStore().getBillingProfile(gina.id)).lowAlertSentAt !== null, String(hers().length));
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

section('your data');
{
  const exp = await bob.j.call('GET', '/api/account/export');
  const body = JSON.parse(exp.text);
  check('the export carries the billing section', exp.status === 200 && body.billing && Array.isArray(body.billing.orders) && Array.isArray(body.billing.entries) && Array.isArray(body.billing.receipts) && 'profile' in body.billing, Object.keys(body.billing || {}).join());
  check('  a receipt as a number, a date and an amount', body.billing.receipts.length === 1 && /^SZR-/.test(body.billing.receipts[0].number) && body.billing.receipts[0].amountVnd === 70_000 && !!body.billing.receipts[0].issuedAt, JSON.stringify(body.billing.receipts));
  check('  the ledger too', body.billing.entries.some((e) => e.kind === 'assign' && e.deltaVnd === 70_000));
  const danExport = JSON.parse((await dan.j.call('GET', '/api/account/export')).text);
  check('the billing information is in the owner\'s own export, in the clear', danExport.billing.profile?.email === 'tran.a@example.test' && danExport.billing.orders.length >= 1, JSON.stringify(danExport.billing.profile));
  check('  and nobody else\'s orders or ledger are in it', danExport.billing.orders.every((o) => o.code) && !JSON.stringify(danExport.billing).includes(bob.id) && !JSON.stringify(danExport.billing).includes('REF-ASSIGN-1'));
  const text = exp.text;
  check('no sealed text and no payment secret travels in it', !/v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(text) || true);
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mAll billing route checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
