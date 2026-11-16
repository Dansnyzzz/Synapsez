/**
 * The billing flow (spec B1, Task 4): the day's USD rate, quotes and orders, and the plan's
 * life (activate, upgrade, schedule a downgrade, renew from the balance, grace, end). Real SQL
 * on PGlite; the rate sources are answered here, so nothing leaves the machine.
 *
 *   node test/billing-flow.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'billing-flow-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'billing-flow-test-session-secret';
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'SEPAY_BANK_ACCOUNT', 'SEPAY_BANK_CODE', 'SEPAY_ACCOUNT_NAME']) delete process.env[name];

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const { __resetCache } = await import('../server/finance/cache.js');
const { __resetHttp } = await import('../server/finance/http.js');
const { PAYG_ANCHOR_RATE } = await import('../server/billing/plans.js');
const { periodEnd, addDays } = await import('../server/billing/period.js');
const { default: crypto } = await import('node:crypto');
const { newPaymentCode } = await import('../server/billing/codes.js');
const fx = await import('../server/billing/fx.js');
const orders = await import('../server/billing/orders.js');
const subs = await import('../server/billing/subscriptions.js');

const db = await PGlite.create();
const query = async (text, params = []) => (await db.query(text, params)).rows;
const store = await initStore({ driver: { query } });

/* ── the rate sources, answered here ───────────────────────────────── */
const realFetch = globalThis.fetch;
const asked = [];
const answers = new Map();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  asked.push(`${u.host}${u.pathname}`);
  const answer = answers.get(`${u.host}${u.pathname}`);
  if (answer) return answer(u);
  throw new TypeError('fetch failed');
};
const ERAPI = 'open.er-api.com/v6/latest/USD';
const VCB = 'www.vietcombank.com.vn/api/exchangerates';
const FRANK = 'api.frankfurter.dev/v2/rates';
const erapiSays = (rate) => answers.set(ERAPI, () => json({ result: 'success', time_last_update_unix: 1_784_000_000, rates: { VND: rate } }));
const vcbSays = (transfer) => answers.set(VCB, () => json({ Date: '2026-11-13', Data: [{ currencyCode: 'USD', currencyName: 'US DOLLAR', cash: transfer - 100, transfer, sell: transfer + 200 }] }));
const frankSays = (rate) => answers.set(FRANK, () => json([{ date: '2026-11-13', base: 'USD', quote: 'VND', rate }]));
const allDown = () => { answers.clear(); };
/** The finance layer keeps what it was told for an hour (and in the database): forget it between phases. */
const forget = async () => { __resetCache(); __resetHttp(); await query('DELETE FROM finance_cache'); fx._resetFxForTests(); };
// A day with nothing kept anywhere: the next price asks the chain.
const reset = async () => { await forget(); await query("DELETE FROM settings WHERE key = 'billing_fx'"); };
const keptRate = async () => { const v = await store.getSetting('billing_fx'); return v && { rate: v.rate, source: v.source, at: v.at }; };

const NOW = new Date('2026-11-13T05:00:00Z');
const hours = (h) => new Date(NOW.getTime() + h * 3_600_000);
let n = 0;
// Administrators: in preview only an account that sees billing renews from its balance (ruling, final review 2026-11-15).
const makeUser = async (role = 'admin') => {
  n += 1;
  return store.createUser({ id: `bf${n}`, email: `bf${n}@example.test`, passwordHash: 'x', role });
};
const balanceOf = async (userId) => (await store.billingState(userId)).balanceVnd;
const caught = async (promise) => { try { await promise; return null; } catch (err) { return err; } };

section('the day\'s rate: Frankfurter, then Vietcombank, then Exchange Rate API, read once a day');
{
  await reset();
  allDown();
  frankSays(25736);
  vcbSays(25400);
  erapiSays(25500);
  const a = await fx.usdVnd({ now: NOW });
  check('Frankfurter answers first, though the others are up', a.rate === 25736 && a.source === 'frankfurter' && a.at === NOW.toISOString() && asked.at(-1).includes('frankfurter'), JSON.stringify(a));
  const before = asked.length;
  const b = await fx.usdVnd({ now: hours(0.5) });
  const sameDay = await fx.usdVnd({ now: hours(17) });
  check('a second call the same day asks nobody', asked.length === before && b.rate === 25736 && sameDay.rate === 25736);
  check('  and the rate is kept in the billing_fx setting with its source and time', JSON.stringify(await keptRate()) === JSON.stringify({ rate: 25736, source: 'frankfurter', at: NOW.toISOString() }));

  await forget();
  const kept = await fx.usdVnd({ now: hours(0.5) });
  check('a new instance reads the setting, asking nobody', kept.rate === 25736 && !asked.slice(before).length, JSON.stringify(asked.slice(before)));

  // 05:00Z is 12:00 in Vietnam: the next 06:00 there is 23:00Z, 18 hours on.
  const stale = await fx.usdVnd({ now: hours(19) });
  check('past the next 06:00 Vietnam time the rate is still used, nobody is asked', stale.rate === 25736 && !asked.slice(before).length, JSON.stringify(asked.slice(before)));
  frankSays(25800);
  const sameDayAgain = await fx.refreshRate({ now: hours(17) });
  check('the cron the same day asks nobody either', sameDayAgain.rate === 25736 && !asked.slice(before).length);
  const fresher = await fx.refreshRate({ now: hours(19) });
  check('the cron past that 06:00 asks again and stores the new rate with its source and time', fresher.rate === 25800 && fresher.source === 'frankfurter' && fresher.at === hours(19).toISOString() && JSON.stringify(await keptRate()) === JSON.stringify({ rate: fresher.rate, source: fresher.source, at: fresher.at }), JSON.stringify(fresher));
  check('  and the day\'s next price uses it', (await fx.usdVnd({ now: hours(20) })).rate === 25800);
  allDown();
  await forget();
  await store.setSetting('billing_fx', fresher);
  const none = await fx.refreshRate({ now: hours(50), force: true });
  check('the cron with every source down answers null, never throws, and leaves the kept rate', none === null && (await store.getSetting('billing_fx'))?.rate === 25800);

  await reset();
  allDown();
  vcbSays(25400);
  erapiSays(25500);
  const c = await fx.usdVnd({ now: hours(2) });
  check('Frankfurter down: the Vietcombank transfer rate', c.rate === 25400 && c.source === 'vietcombank', JSON.stringify(c));

  await reset();
  allDown();
  erapiSays(25500);
  const d = await fx.usdVnd({ now: hours(4) });
  check('both down: Exchange Rate API last', d.rate === 25500 && d.source === 'erapi', JSON.stringify(d));

  await forget();
  allDown();
  await store.setSetting('billing_fx', { rate: 25111, source: 'erapi', at: hours(-47).toISOString() });
  const askedBefore = asked.length;
  const e = await fx.usdVnd({ now: NOW });
  check('a 47-hour-old rate is still used, without asking', e.rate === 25111 && e.source === 'erapi' && asked.length === askedBefore, JSON.stringify(e));

  await forget();
  frankSays(25700);
  await store.setSetting('billing_fx', { rate: 25111, source: 'erapi', at: hours(-49).toISOString() });
  const f = await fx.usdVnd({ now: NOW });
  check('a 49-hour-old rate is asked for afresh', f.rate === 25700 && f.source === 'frankfurter', JSON.stringify(f));
  allDown();

  await forget();
  await store.setSetting('billing_fx', { rate: 25111, source: 'erapi', at: hours(-49).toISOString() });
  const err = await caught(fx.usdVnd({ now: NOW }));
  check('all down, 49 hours old: BillingUnavailable', err instanceof fx.BillingUnavailable, String(err));

  await forget();
  const m = await fx.meteringRate();
  check('meteringRate never fetches, and reads a setting of any age', m === 25111, String(m));
  await query(`DELETE FROM settings WHERE key = 'billing_fx'`);
  await forget();
  check('  with nothing known it is the anchor', (await fx.meteringRate()) === PAYG_ANCHOR_RATE);
  check('the attribution text is exact', fx.RATE_ATTRIBUTION === 'Rates By Exchange Rate API: https://www.exchangerate-api.com');
}

/* From here the rate is 25655.85. */
const prime = async () => { await reset(); allDown(); erapiSays(25655.85); };
await prime();
const subRow = (userId, over = {}) => ({
  userId, plan: 'plus', period: 'month', status: 'active', periodStart: new Date('2026-11-01T00:00:00+07:00'), periodEnd: new Date('2026-12-01T00:00:00+07:00'),
  paidVnd: 129000, autoRenew: true, cancelAtEnd: false, nextPlan: null, nextPeriod: null, remindedAt: null, renewalOrder: null, ...over,
});

section('quotes');
{
  const u = await makeUser();
  const fresh = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: NOW });
  check('a new Plus month at 25655.85 is 129,000đ', fresh.kind === 'new' && fresh.priceVnd === 129000 && fresh.totalVnd === 129000 && fresh.creditVnd === 0, JSON.stringify(fresh));
  check('  the quote carries the rate, its source and the balance', fresh.rate === 25655.85 && fresh.rateSource === 'erapi' && fresh.balanceVnd === 0 && fresh.startsAt === NOW.toISOString());

  const half = new Date('2026-11-16T12:00:00Z');
  await store.saveSubscription(subRow(u.id, { periodStart: new Date('2026-11-01T12:00:00Z'), periodEnd: new Date('2026-12-01T12:00:00Z') }));
  const mid = new Date('2026-11-16T12:00:00Z');
  const up = await orders.quote(u.id, { plan: 'pro', period: 'month' }, { now: mid });
  check('Plus to Pro half way through a 129,000đ month: credit 64,500, total 141,500', up.kind === 'upgrade' && up.creditVnd === 64500 && up.totalVnd === 141500 && up.priceVnd === 206000, JSON.stringify(up));
  const down = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: half });
  check('the same plan again is later, nothing charged', down.kind === 'later' && down.totalVnd === 0, JSON.stringify(down));
  await store.saveSubscription(subRow(u.id, { plan: 'pro', paidVnd: 206000, periodStart: new Date('2026-11-01T12:00:00Z'), periodEnd: new Date('2026-12-01T12:00:00Z') }));
  const low = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: mid });
  check('Pro to Plus is later: total 0, starts when the period ends', low.kind === 'later' && low.totalVnd === 0 && low.startsAt === new Date('2026-12-01T12:00:00Z').toISOString(), JSON.stringify(low));
  await store.saveSubscription(subRow(u.id, { periodStart: new Date('2026-11-01T12:00:00Z'), periodEnd: new Date('2026-12-01T12:00:00Z') }));
  const yr = await orders.quote(u.id, { plan: 'plus', period: 'year' }, { now: mid });
  check('month to year on the same plan is an upgrade', yr.kind === 'upgrade' && yr.priceVnd === 1283000 && yr.creditVnd === 64500 && yr.totalVnd === 1218500, JSON.stringify(yr));
  await store.saveSubscription(subRow(u.id, { plan: 'plus', period: 'year', paidVnd: 1283000, periodStart: new Date('2026-11-01T12:00:00Z'), periodEnd: new Date('2027-11-01T12:00:00Z') }));
  const back = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: mid });
  check('year to month is later', back.kind === 'later' && back.totalVnd === 0, JSON.stringify(back));
  const bad = await caught(orders.quote(u.id, { plan: 'gold', period: 'month' }, { now: NOW }));
  check('a plan that does not exist is a 422', bad?.status === 422, String(bad));
  // In grace the same terms are the renewal itself (Renew now), not "later": Task 10 found the checkout offered nothing to pay.
  await store.saveSubscription(subRow(u.id, { periodStart: new Date('2026-10-01T12:00:00Z'), periodEnd: new Date('2026-11-01T12:00:00Z') }));
  const inGrace = new Date('2026-11-02T12:00:00Z');
  const renew = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  check('in grace, the same plan and period is a renewal at full price', renew.kind === 'renewal' && renew.creditVnd === 0 && renew.totalVnd === 129000, JSON.stringify(renew));
  const dearer = await orders.quote(u.id, { plan: 'pro', period: 'month' }, { now: inGrace });
  check('  another plan in grace is still an upgrade, and the credit is 0 (nothing of the ended period is left)', dearer.kind === 'upgrade' && dearer.creditVnd === 0, JSON.stringify(dearer));

  // Round 1 (review): with a downgrade scheduled, the renewal is the scheduled plan, and the plan that ran is only a change.
  const proRow = (over = {}) => subRow(u.id, { plan: 'pro', paidVnd: 206000, periodStart: new Date('2026-10-01T12:00:00Z'), periodEnd: new Date('2026-11-01T12:00:00Z'), nextPlan: 'plus', nextPeriod: 'month', ...over });
  await store.saveSubscription(proRow());
  const sched = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  const ran = await orders.quote(u.id, { plan: 'pro', period: 'month' }, { now: inGrace });
  check('pro in grace with plus scheduled: plus is the renewal, pro is later (not a renewal)', sched.kind === 'renewal' && sched.totalVnd === 129000 && ran.kind === 'later', JSON.stringify({ sched: sched.kind, ran: ran.kind }));
  await store.saveSubscription(proRow({ period: 'year', paidVnd: 2000000, nextPeriod: 'year', periodEnd: new Date('2026-11-01T12:00:00Z'), periodStart: new Date('2025-11-01T12:00:00Z') }));
  const yearSched = await orders.quote(u.id, { plan: 'plus', period: 'year' }, { now: inGrace });
  const yearRan = await orders.quote(u.id, { plan: 'pro', period: 'year' }, { now: inGrace });
  const yearMonth = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  check('pro yearly with plus yearly scheduled: plus yearly is the renewal, pro yearly and plus monthly are later', yearSched.kind === 'renewal' && yearRan.kind === 'later' && yearMonth.kind === 'later', JSON.stringify([yearSched.kind, yearRan.kind, yearMonth.kind]));
}

section('a renewal that exists keeps its price, and a direct same-terms purchase in grace is that renewal');
{
  const u = await makeUser();
  const lapsed = new Date('2026-11-01T12:00:00Z');
  const inGrace = new Date('2026-11-02T12:00:00Z');
  await store.saveSubscription(subRow(u.id, { periodStart: new Date('2026-10-01T12:00:00Z'), periodEnd: lapsed, status: 'grace' }));
  process.env.SEPAY_BANK_ACCOUNT = '0123456789';
  process.env.SEPAY_BANK_CODE = 'MBBank';
  const made = await orders.createOrder(u.id, { kind: 'plan', plan: 'plus', period: 'month', useBalance: false }, { now: inGrace });
  check('a plan purchase of the same terms in grace becomes the renewal order (createOrder, not the route)', made.order.kind === 'renewal' && made.order.priceVnd === 129000 && +made.order.expiresAt === +addDays(lapsed, 3), JSON.stringify([made.order.kind, made.order.priceVnd]));
  const again = await orders.createOrder(u.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: inGrace });
  check('  asking again returns the same order, not a second one', again.order.id === made.order.id);
  await query(`DELETE FROM settings WHERE key = 'billing_fx'`);
  await forget();
  allDown();
  erapiSays(30000);
  const q = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  check('  at another rate, the quote is still the locked price and rate, and says the order does not use the balance', q.kind === 'renewal' && q.priceVnd === 129000 && q.totalVnd === 129000 && q.rate === 25655.85 && q.useBalance === false, JSON.stringify(q));
  const none = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  check('  the quote carries the amount still to transfer, which is what the QR will ask for', none.dueVnd === 129000, String(none.dueVnd));
  await store.addOrderReceived(made.order.id, 50000);
  const short = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: inGrace });
  check('  after a short transfer it is the rest (total less what arrived), not the total', short.totalVnd === 129000 && short.dueVnd === 79000, JSON.stringify([short.totalVnd, short.dueVnd]));
  const other = await orders.quote(u.id, { plan: 'pro', period: 'month' }, { now: inGrace });
  check('  and a plan with no order made is priced at the rate of the day, with no say about the balance or the due amount', other.rate === 30000 && other.useBalance === null && other.dueVnd === null, JSON.stringify(other));
  await prime();
}

section('orders: paid from the balance, or a QR for the rest');
{
  process.env.SEPAY_BANK_ACCOUNT = '0123456789';
  process.env.SEPAY_BANK_CODE = 'MBBank';
  process.env.SEPAY_ACCOUNT_NAME = 'SYNAPSEZ';
  const rich = await makeUser();
  await store.creditBalance(rich.id, 200000, { kind: 'topup', topup: true });
  const paid = await orders.createOrder(rich.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: NOW });
  const sub = await store.getSubscription(rich.id);
  check('a covering balance pays at once', paid.paidNow === true && paid.order.status === 'paid' && paid.due === null, JSON.stringify(paid.order));
  check('  the plan is active for a month from now, the balance 71,000đ', sub.status === 'active' && sub.plan === 'plus' && +sub.periodStart === +NOW && +sub.periodEnd === +periodEnd(NOW, 'month') && sub.paidVnd === 129000 && (await balanceOf(rich.id)) === 71000, JSON.stringify(sub));
  const again = await orders.tryApply(paid.order.id, { now: NOW });
  check('tryApply on a paid order changes nothing and returns the subscription', again?.plan === 'plus' && (await balanceOf(rich.id)) === 71000);

  const poor = await makeUser();
  await store.creditBalance(poor.id, 29000, { kind: 'topup', topup: true });
  const short = await orders.createOrder(poor.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: NOW });
  check('a short balance leaves the order pending with the rest to transfer', short.paidNow === false && short.order.status === 'pending' && short.due.vnd === 100000, JSON.stringify(short.due));
  const qr = short.due.qr;
  check('  the QR names the amount and the order code', qr.image === `https://qr.sepay.vn/img?acc=0123456789&bank=MBBank&amount=100000&des=${short.order.code}` && /^SZ\d{10}$/.test(qr.content) && qr.content === short.order.code && qr.holder === 'SYNAPSEZ', JSON.stringify(qr));
  check('  the order is good for 30 minutes at the locked price', +short.order.expiresAt === NOW.getTime() + 1_800_000 && short.order.priceVnd === 129000 && short.order.rate === 25655.85);
  check('  nothing was taken from the balance and no plan started', (await balanceOf(poor.id)) === 29000 && (await store.getSubscription(poor.id)) === null);
  const bankOnly = await orders.createOrder(poor.id, { kind: 'plan', plan: 'plus', period: 'month', useBalance: false }, { now: NOW });
  check('useBalance:false asks for the whole price', bankOnly.due.vnd === 129000 && bankOnly.order.useBalance === false, JSON.stringify(bankOnly.due));
  check('dueOf follows the order\'s own rule', orders.dueOf({ useBalance: true, totalVnd: 129000, receivedVnd: 0 }, 29000) === 100000 && orders.dueOf({ useBalance: false, totalVnd: 129000, receivedVnd: 50000 }, 999999) === 79000 && orders.dueOf({ useBalance: true, totalVnd: 100, receivedVnd: 0 }, 500) === 0);
  const noBank = await caught((async () => orders.qrFor(short.order, 100000, {}))());
  check('qrFor without the bank variables is BillingUnavailable', noBank instanceof fx.BillingUnavailable, String(noBank));
  const stranded = await caught(orders.createOrder(poor.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: NOW, env: {} }));
  check('an order that needs a transfer is not created when there is no bank to pay', stranded instanceof fx.BillingUnavailable && (await store.listOrders({ userId: poor.id })).filter((o) => o.plan === 'max').every((o) => o.status === 'cancelled'), String(stranded));
  const later = await caught(orders.createOrder(rich.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: NOW }));
  check('an order for a change that is later (not an upgrade) is a 422', later?.status === 422, String(later));
  const nope = await caught(orders.createOrder(poor.id, { kind: 'plan', plan: 'gold', period: 'month' }, { now: NOW }));
  const nope2 = await caught(orders.createOrder(poor.id, { kind: 'plan', plan: 'plus', period: 'week' }, { now: NOW }));
  check('a wrong plan or period is a 422', nope?.status === 422 && nope2?.status === 422);
}

section('top-ups: the bounds');
{
  const noPlan = await makeUser();
  const low = await caught(orders.createOrder(noPlan.id, { kind: 'topup', amountVnd: 49999 }, { now: NOW }));
  check('below 50,000đ with no plan is a 422', low?.status === 422, String(low));
  const ok = await orders.createOrder(noPlan.id, { kind: 'topup', amountVnd: 50000 }, { now: NOW });
  check('50,000đ is accepted; it is paid by the transfer, not the balance', ok.order.kind === 'topup' && ok.order.totalVnd === 50000 && ok.order.useBalance === false && ok.due.vnd === 50000 && ok.paidNow === false, JSON.stringify(ok.order));
  check('  tryApply never pays a top-up from the balance', (await orders.tryApply(ok.order.id, { now: NOW })) === null && (await store.getOrder(ok.order.id)).status === 'pending');
  const frac = await caught(orders.createOrder(noPlan.id, { kind: 'topup', amountVnd: 50000.5 }, { now: NOW }));
  check('a fraction of a đồng is a 422', frac?.status === 422);
  await store.creditBalance(noPlan.id, 150000, { kind: 'topup', topup: true });
  const over = await caught(orders.createOrder(noPlan.id, { kind: 'topup', amountVnd: 60000 }, { now: NOW }));
  check('one that would take the balance past 200,000đ is a 422', over?.status === 422, String(over));
  await store.cancelOrder(ok.order.id, noPlan.id);
  const exact = await orders.createOrder(noPlan.id, { kind: 'topup', amountVnd: 50000 }, { now: NOW });
  check('  but exactly 200,000đ is allowed', exact.order.totalVnd === 50000);

  const withPlan = await makeUser();
  await store.saveSubscription(subRow(withPlan.id, { periodStart: new Date('2026-11-10T00:00:00Z'), periodEnd: new Date('2026-12-10T00:00:00Z') }));
  const small = await caught(orders.createOrder(withPlan.id, { kind: 'topup', amountVnd: 99999 }, { now: NOW }));
  check('with a plan the minimum is 100,000đ', small?.status === 422, String(small));
  await store.creditBalance(withPlan.id, 950000, { kind: 'topup', topup: true });
  const past = await caught(orders.createOrder(withPlan.id, { kind: 'topup', amountVnd: 100000 }, { now: NOW }));
  check('100,000đ on top of 950,000đ is a 422 (past 1,000,000đ)', past?.status === 422, String(past));
  const edge = await makeUser();
  await store.saveSubscription(subRow(edge.id, { periodStart: new Date('2026-11-10T00:00:00Z'), periodEnd: new Date('2026-12-10T00:00:00Z') }));
  await store.creditBalance(edge.id, 900000, { kind: 'topup', topup: true });
  const fits = await orders.createOrder(edge.id, { kind: 'topup', amountVnd: 100000 }, { now: NOW });
  check('  100,000đ on top of 900,000đ reaches the bound exactly and is allowed', fits.order.totalVnd === 100000);
}

section('catchUp: renew from the balance, grace, end');
{
  const T0 = new Date('2026-10-13T12:00:00Z');
  const T1 = new Date('2026-11-13T12:00:00Z');
  const atEnd = new Date(T1.getTime() + 60_000);
  const mk = async (balance, over = {}) => {
    const u = await makeUser();
    await store.saveSubscription(subRow(u.id, { periodStart: T0, periodEnd: T1, ...over }));
    if (balance) await store.creditBalance(u.id, balance, { kind: 'topup', topup: true });
    return u;
  };

  const a = await mk(300000);
  const before = await subs.catchUp(a.id, { now: new Date(T1.getTime() - 60_000) });
  check('before the period ends nothing happens', before.status === 'active' && +before.periodEnd === +T1 && (await balanceOf(a.id)) === 300000);
  const renewed = await subs.catchUp(a.id, { now: atEnd });
  check('at the period end a covering balance renews it: the next period starts at the old end', renewed.status === 'active' && +renewed.periodStart === +T1 && +renewed.periodEnd === +periodEnd(T1, 'month') && renewed.paidVnd === 129000, JSON.stringify(renewed));
  check('  129,000đ left the balance, once', (await balanceOf(a.id)) === 171000);
  await subs.catchUp(a.id, { now: atEnd });
  await subs.catchUp(a.id, { now: new Date(atEnd.getTime() + 3_600_000) });
  check('  calling it again changes nothing (idempotent)', (await balanceOf(a.id)) === 171000 && (await store.listOrders({ userId: a.id })).length === 1);
  const both = await Promise.all([subs.catchUp(a.id, { now: new Date(+periodEnd(T1, 'month') + 1000) }), subs.catchUp(a.id, { now: new Date(+periodEnd(T1, 'month') + 1000) })]);
  check('  two calls at once renew only once', (await balanceOf(a.id)) === 42000 && both.every((s) => +s.periodStart === +periodEnd(T1, 'month')), String(await balanceOf(a.id)));

  // What a caller reports comes from its own statements (final review, 2026-11-15): of two at once, only the one whose payment took
  // the money carries it (the paid line), and anything either reports is that one renewal of that one period.
  const twin = await mk(300000);
  const pair = await Promise.all([subs.catchUpChanges(twin.id, { now: atEnd }), subs.catchUpChanges(twin.id, { now: atEnd })]);
  const told = pair.flatMap((r) => r.changes);
  check('catchUpChanges, two callers at once: one renewal, reported with its payment by exactly one of them', (await balanceOf(twin.id)) === 171000 && told.filter((c) => c.paid).length === 1 && told.every((c) => c.kind === 'renewed' && +c.from === +T1 && +c.sub.periodStart === +T1) && told.find((c) => c.paid).paid.kind === 'renewal', JSON.stringify(told.map((c) => [c.kind, !!c.paid])));
  const quiet = await subs.catchUpChanges(twin.id, { now: new Date(atEnd.getTime() + 3_600_000) });
  check('  asked again afterwards it reports nothing', quiet.changes.length === 0 && +quiet.sub.periodStart === +T1);
  const short = await mk(10000);
  const graced = await Promise.all([subs.catchUpChanges(short.id, { now: atEnd }), subs.catchUpChanges(short.id, { now: atEnd })]);
  const graceTold = graced.flatMap((r) => r.changes);
  check('  into grace, two at once: reported once, by the one whose statement moved it', graceTold.length === 1 && graceTold[0].kind === 'grace' && !graceTold[0].paid && +graceTold[0].from === +T1, JSON.stringify(graceTold.map((c) => c.kind)));
  const member = await makeUser('user');
  await store.saveSubscription(subRow(member.id, { periodStart: T0, periodEnd: T1 }));
  await store.creditBalance(member.id, 300000, { kind: 'topup', topup: true });
  const left = await subs.catchUpChanges(member.id, { now: atEnd });
  check('an account that cannot see billing (a demoted administrator) is not renewed from its balance: grace, nothing taken', left.sub.status === 'grace' && (await balanceOf(member.id)) === 300000 && left.changes.length === 1 && left.changes[0].kind === 'grace' && !(await store.listOrders({ userId: member.id })).some((o) => o.status === 'paid'), JSON.stringify([left.sub.status, await balanceOf(member.id)]));

  const b = await mk(10000);
  const g = await subs.catchUp(b.id, { now: atEnd });
  check('a short balance goes into grace, the dates unchanged', g.status === 'grace' && +g.periodStart === +T0 && +g.periodEnd === +T1 && (await balanceOf(b.id)) === 10000, JSON.stringify(g));
  check('  grace still counts as the plan', (await subs.planInForce(b.id, { now: atEnd })).plan === 'plus' && (await subs.planInForce(b.id, { now: atEnd })).status === 'grace');
  await store.creditBalance(b.id, 200000, { kind: 'topup', topup: true });
  const paidInGrace = await subs.catchUp(b.id, { now: addDays(T1, 1) });
  check('money arriving in grace renews it from the old end', paidInGrace.status === 'active' && +paidInGrace.periodStart === +T1 && +paidInGrace.periodEnd === +periodEnd(T1, 'month') && (await balanceOf(b.id)) === 81000, JSON.stringify(paidInGrace));

  const c = await mk(0, { autoRenew: false });
  await subs.catchUp(c.id, { now: atEnd });
  check('with auto-renew off the sub waits in grace even if the balance would cover', (await store.getSubscription(c.id)).status === 'grace');
  await store.creditBalance(c.id, 200000, { kind: 'topup', topup: true });
  await subs.catchUp(c.id, { now: addDays(T1, 1) });
  check('  catchUp does not charge it', (await store.getSubscription(c.id)).status === 'grace' && (await balanceOf(c.id)) === 200000);
  const manual = await orders.createOrder(c.id, { kind: 'renewal' }, { now: addDays(T1, 1) });
  const cs = await store.getSubscription(c.id);
  check('  a renewal paid by hand in grace also starts at the old end', manual.paidNow && manual.order.kind === 'renewal' && cs.status === 'active' && +cs.periodStart === +T1 && +cs.periodEnd === +periodEnd(T1, 'month') && (await balanceOf(c.id)) === 71000, JSON.stringify(cs));
  check('  a renewal order lasts until grace ends', +manual.order.expiresAt === +addDays(T1, 3));

  // Round 2 (review): auto-renew on is consent to pay the renewal from the balance, even when the order was made with "use my
  // balance" unticked at a checkout (otherwise the plan ends in grace with the money sitting there).
  const consenting = await mk(300000);
  const unticked = await orders.createOrder(consenting.id, { kind: 'renewal', useBalance: false }, { now: addDays(T1, 1) });
  check('a renewal order made without the balance is waiting for a transfer', unticked.order.useBalance === false && unticked.order.status === 'pending' && !unticked.paidNow, JSON.stringify(unticked.order));
  const wentThrough = await subs.catchUp(consenting.id, { now: addDays(T1, 1) });
  check('  auto-renew on, enough balance: it renews from the balance all the same, once', wentThrough.status === 'active' && +wentThrough.periodStart === +T1 && (await balanceOf(consenting.id)) === 171000 && (await store.getOrder(unticked.order.id)).status === 'paid', JSON.stringify(wentThrough));
  const refusing = await mk(300000, { autoRenew: false });
  const noConsent = await orders.createOrder(refusing.id, { kind: 'renewal', useBalance: false }, { now: addDays(T1, 1) });
  const stayed = await subs.catchUp(refusing.id, { now: addDays(T1, 1) });
  check('  auto-renew off: the same order is not paid from the balance', stayed.status === 'grace' && (await balanceOf(refusing.id)) === 300000 && (await store.getOrder(noConsent.order.id)).status === 'pending');
  const topper = await mk(300000);
  const tup = await orders.createOrder(topper.id, { kind: 'topup', amountVnd: 100000 }, { now: addDays(T1, 1) });
  await subs.catchUp(topper.id, { now: addDays(T1, 1) });
  check('  a top-up order is never paid from the balance by this (the transfer is what credits it)', (await store.getOrder(tup.order.id)).status === 'pending');

  const d = await mk(5000);
  await subs.catchUp(d.id, { now: atEnd });
  const ended = await subs.catchUp(d.id, { now: new Date(addDays(T1, 3).getTime() + 60_000) });
  const inForce = await subs.planInForce(d.id, { now: new Date(addDays(T1, 3).getTime() + 60_000) });
  check('three days past the end, unpaid: ended, the plan is free, nothing charged', ended.status === 'ended' && inForce.plan === 'free' && (await balanceOf(d.id)) === 5000, JSON.stringify(inForce));

  const e = await mk(500000, { cancelAtEnd: true });
  const cancelled = await subs.catchUp(e.id, { now: atEnd });
  check('cancel at the end: ended at the end, no charge, even with the money there', cancelled.status === 'ended' && (await balanceOf(e.id)) === 500000);

  const f = await mk(0);
  const one = await subs.planInForce(f.id, { now: new Date(T0.getTime() + 86_400_000) });
  check('planInForce gives plan, period, status, dates and the month window', one.plan === 'plus' && one.period === 'month' && one.status === 'active' && +one.start === +T0 && +one.end === +T1 && +one.month.start === +T0 && +one.month.end === +T1, JSON.stringify(one));
  const none = await subs.planInForce((await makeUser()).id, { now: NOW });
  check('an account with no plan is free', none.plan === 'free' && none.status === 'none' && none.month === null);

  // A rate nobody can give must not end a plan early.
  await forget();
  allDown();
  await query(`DELETE FROM settings WHERE key = 'billing_fx'`);
  const r = await mk(300000);
  const stuck = await subs.catchUp(r.id, { now: atEnd });
  check('with no rate at all the plan waits in grace, uncharged', stuck.status === 'grace' && (await balanceOf(r.id)) === 300000, JSON.stringify(stuck));
  await prime();
}

section('plan changes: upgrade, a downgrade at period end, flags');
{
  const T0 = new Date('2026-11-01T00:00:00Z');
  const T1 = new Date('2026-12-01T00:00:00Z');
  const mid = new Date('2026-11-16T00:00:00Z');
  const u = await makeUser();
  await store.saveSubscription(subRow(u.id, { plan: 'pro', paidVnd: 206000, periodStart: T0, periodEnd: T1 }));
  await store.creditBalance(u.id, 400000, { kind: 'topup', topup: true });
  const sched = await subs.scheduleChange(u.id, { plan: 'plus', period: 'month' });
  check('a downgrade is scheduled for the period end', sched.nextPlan === 'plus' && sched.nextPeriod === 'month' && sched.plan === 'pro' && +sched.periodEnd === +T1, JSON.stringify(sched));
  const up = await caught(subs.scheduleChange(u.id, { plan: 'max', period: 'month' }));
  check('an upgrade cannot be scheduled (it is paid now)', up?.status === 422);
  const ren = await subs.catchUp(u.id, { now: new Date(T1.getTime() + 60_000) });
  check('at the end the renewal is the scheduled plan at today\'s price', ren.plan === 'plus' && ren.nextPlan === null && ren.nextPeriod === null && ren.paidVnd === 129000 && (await balanceOf(u.id)) === 271000, JSON.stringify(ren));

  const v = await makeUser();
  await store.saveSubscription(subRow(v.id, { periodStart: T0, periodEnd: T1 }));
  await store.creditBalance(v.id, 300000, { kind: 'topup', topup: true });
  const upgrade = await orders.createOrder(v.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: mid });
  const after = await store.getSubscription(v.id);
  check('an upgrade paid from the balance starts a new period now, less the credit', upgrade.paidNow && after.plan === 'pro' && +after.periodStart === +mid && +after.periodEnd === +periodEnd(mid, 'month') && upgrade.order.creditVnd === 64500 && after.paidVnd === 206000 && (await balanceOf(v.id)) === 158500, JSON.stringify([after, upgrade.order.creditVnd]));

  const w = await makeUser();
  await store.saveSubscription(subRow(w.id, { periodStart: T0, periodEnd: T1 }));
  check('auto-renew can be switched off and on', (await subs.setAutoRenew(w.id, false)).autoRenew === false && (await subs.setAutoRenew(w.id, true)).autoRenew === true);
  check('cancel at the end can be set and cleared', (await subs.setCancelAtEnd(w.id, true)).cancelAtEnd === true && (await subs.setCancelAtEnd(w.id, false)).cancelAtEnd === false);
  const noSub = await caught(subs.setAutoRenew((await makeUser()).id, true));
  check('with no plan there is nothing to switch (422)', noSub?.status === 422);
}

section('reminders: one renewal order per subscription');
{
  const end = new Date(NOW.getTime() + 2 * 86_400_000);
  const start = new Date('2026-10-13T05:00:00Z');
  const short = await makeUser();
  await store.saveSubscription(subRow(short.id, { periodStart: start, periodEnd: end }));
  const covered = await makeUser();
  await store.saveSubscription(subRow(covered.id, { periodStart: start, periodEnd: end }));
  await store.creditBalance(covered.id, 500000, { kind: 'topup', topup: true });
  const far = await makeUser();
  await store.saveSubscription(subRow(far.id, { periodStart: start, periodEnd: new Date(NOW.getTime() + 10 * 86_400_000) }));
  const first = await subs.remindersDue(NOW);
  const mine = first.filter((x) => x.userId === short.id);
  check('a short balance three days before the end gets a renewal order', mine.length === 1 && mine[0].order.kind === 'renewal' && mine[0].order.totalVnd === 129000 && +mine[0].order.expiresAt === +addDays(end, 3), JSON.stringify(mine));
  check('  a covered balance and a faraway end do not', !first.some((x) => x.userId === covered.id || x.userId === far.id));
  const second = await subs.remindersDue(NOW);
  check('asked twice, still one order and no second reminder', second.filter((x) => x.userId === short.id).length === 0 && (await store.listOrders({ userId: short.id })).filter((o) => o.kind === 'renewal').length === 1);
  const row = await store.getSubscription(short.id);
  check('  the subscription remembers the reminder and the order', row.remindedAt !== null && row.renewalOrder === mine[0].order.id);
  await store.creditBalance(short.id, 300000, { kind: 'topup', topup: true });
  const paid = await subs.catchUp(short.id, { now: new Date(end.getTime() + 60_000) });
  check('the order made by the reminder is the one the balance pays', paid.status === 'active' && +paid.periodStart === +end && (await store.listOrders({ userId: short.id })).filter((o) => o.kind === 'renewal').length === 1 && (await balanceOf(short.id)) === 171000, JSON.stringify(paid));
}

/* ── fix round 1 (review of d8db956) ───────────────────────────────── */
const far = new Date('2030-01-01T00:00:00Z');
/** An order made straight in the store, as if quoted earlier: no createOrder rules in the way. */
const direct = (userId, over = {}) => store.createOrder({
  id: crypto.randomUUID(), userId, kind: 'plan', plan: 'pro', period: 'month', code: newPaymentCode(), usdCents: 800, rate: 25655.85, rateSource: 'erapi',
  priceVnd: 206000, creditVnd: 0, totalVnd: 206000, useBalance: true, expiresAt: far, basis: 'none|0', ...over,
});
const P0 = new Date('2026-11-01T00:00:00Z');
const P1 = new Date('2026-12-01T00:00:00Z');
const PMID = new Date('2026-11-16T00:00:00Z');
const plusBasis = `plus|month|${P1.getTime()}`;

section('C1: an order is paid only against the plan it was quoted on');
{
  await prime();
  const u = await makeUser();
  await store.saveSubscription(subRow(u.id, { periodStart: P0, periodEnd: P1 }));
  const B = await orders.createOrder(u.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: PMID });
  const A = await orders.createOrder(u.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: PMID });
  check('creating a plan order closes the account\'s other open plan order', (await store.getOrder(B.order.id)).status === 'cancelled' && A.order.status === 'pending');
  await store.creditBalance(u.id, 1_000_000, { kind: 'topup', topup: true });
  const open = await direct(u.id, { plan: 'max', usdCents: 1500, priceVnd: 385000, totalVnd: 385000, basis: plusBasis });
  const applied = await orders.tryApply(A.order.id, { now: PMID });
  check('A (to Pro) pays and Pro starts', applied?.plan === 'pro');
  check('  paying it closed the other open plan order', (await store.getOrder(open.id)).status === 'cancelled');
  const after = await balanceOf(u.id);
  const late = await direct(u.id, { plan: 'max', usdCents: 1500, priceVnd: 385000, totalVnd: 385000, basis: plusBasis });
  const refused = await orders.tryApply(late.id, { now: PMID });
  check('B (to Max, quoted on Plus) is refused once the plan is Pro: cancelled, nothing taken', refused === null && (await store.getOrder(late.id)).status === 'cancelled' && (await balanceOf(u.id)) === after && (await store.getSubscription(u.id)).plan === 'pro');
  const raw = await direct(u.id, { plan: 'max', usdCents: 1500, priceVnd: 385000, totalVnd: 385000, basis: plusBasis });
  check('the payment statement itself refuses a stale basis', (await store.payOrderFromBalance(raw.id, PMID)) === null && (await balanceOf(u.id)) === after);
  const fresh = await orders.createOrder(u.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: PMID });
  check('a new order quoted on Pro pays (basis names the plan in force)', fresh.paidNow && (await store.getSubscription(u.id)).plan === 'max', JSON.stringify(fresh.order));
  const stale = await caught(orders.createOrder(u.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: PMID }));
  check('  and asking for the plan one already has is a 422', stale?.status === 422);

  const r = await makeUser();
  const E = new Date('2026-12-01T00:00:00Z');
  await store.saveSubscription(subRow(r.id, { periodStart: P0, periodEnd: E }));
  const up = await orders.createOrder(r.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: new Date(E.getTime() - 600_000) });
  await store.creditBalance(r.id, 400000, { kind: 'topup', topup: true });
  await subs.catchUp(r.id, { now: new Date(E.getTime() + 60_000) });
  const gone = await orders.tryApply(up.order.id, { now: new Date(E.getTime() + 120_000) });
  check('an order made before a renewal and paid after it is refused', gone === null && (await store.getOrder(up.order.id)).status === 'cancelled' && (await store.getSubscription(r.id)).plan === 'plus' && (await balanceOf(r.id)) === 271000, String(await balanceOf(r.id)));

  const n2 = await makeUser();
  await store.creditBalance(n2.id, 500000, { kind: 'topup', topup: true });
  const plain = { plan: 'plus', usdCents: 500, priceVnd: 129000, totalVnd: 129000 };
  const o1 = await direct(n2.id, plain);
  const o2 = await direct(n2.id, plain);
  const first = await orders.tryApply(o1.id, { now: PMID });
  const second = await orders.tryApply(o2.id, { now: PMID });
  check('two new-plan orders: the first starts the plan, the second is refused', first?.plan === 'plus' && second === null && (await balanceOf(n2.id)) === 371000, String(await balanceOf(n2.id)));
}

section('I1: changes are field-level and an activation is mended');
{
  for (const which of ['activate first', 'flag first']) {
    const u = await makeUser();
    await store.saveSubscription(subRow(u.id, { periodStart: P0, periodEnd: P1 }));
    await store.creditBalance(u.id, 1_000_000, { kind: 'topup', topup: true });
    const o = await direct(u.id, { creditVnd: 64500, totalVnd: 141500, basis: plusBasis });
    const paid = await store.payOrderFromBalance(o.id, PMID);
    const act = () => subs.activate(paid, { now: PMID });
    const flag = () => subs.setAutoRenew(u.id, false, { now: PMID });
    await Promise.all(which === 'activate first' ? [act(), flag()] : [flag(), act()]);
    const s = await store.getSubscription(u.id);
    check(`${which}: the upgrade stays and auto-renew stays off`, s.plan === 'pro' && s.autoRenew === false && s.paidVnd === 206000, JSON.stringify(s));
  }
  const c = await makeUser();
  await store.saveSubscription(subRow(c.id, { plan: 'pro', paidVnd: 206000, periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(c.id, 500000, { kind: 'topup', topup: true });
  const results = await Promise.allSettled([
    subs.catchUp(c.id, { now: new Date(P1.getTime() + 60_000) }),
    subs.scheduleChange(c.id, { plan: 'plus', period: 'month' }, { now: PMID }),
  ]);
  await subs.catchUp(c.id, { now: new Date(P1.getTime() + 120_000) });
  const renewals = (await store.listOrders({ userId: c.id })).filter((o) => o.kind === 'renewal' && o.status === 'paid');
  const cs = await store.getSubscription(c.id);
  check('a schedule racing the renewal: exactly one renewal charged, the period moved once', renewals.length === 1 && (await balanceOf(c.id)) === 500000 - renewals[0].totalVnd && +cs.periodStart === +P1 && results[0].status === 'fulfilled', JSON.stringify([renewals.map((o) => [o.plan, o.totalVnd]), cs.plan, results.map((x) => x.status)]));

  const m = await makeUser();
  await store.saveSubscription(subRow(m.id, { periodStart: P0, periodEnd: P1, autoRenew: false }));
  await store.creditBalance(m.id, 300000, { kind: 'topup', topup: true });
  const sub = await store.getSubscription(m.id);
  const { order: ro } = await orders.renewalOrderFor(sub, { now: PMID });
  await store.payOrderFromBalance(ro.id, PMID);
  const mended = await subs.catchUp(m.id, { now: new Date(P1.getTime() + 60_000) });
  check('a renewal paid but never activated is mended by catchUp, even with auto-renew off', mended.status === 'active' && +mended.periodStart === +P1 && (await balanceOf(m.id)) === 171000, JSON.stringify(mended));
  await subs.catchUp(m.id, { now: new Date(P1.getTime() + 120_000) });
  check('  and only once', (await balanceOf(m.id)) === 171000 && +(await store.getSubscription(m.id)).periodEnd === +periodEnd(P1, 'month'));

  const p = await makeUser();
  await store.creditBalance(p.id, 300000, { kind: 'topup', topup: true });
  const po = await direct(p.id, { plan: 'plus', usdCents: 500, priceVnd: 129000, totalVnd: 129000 });
  await store.payOrderFromBalance(po.id, PMID);
  const got = await orders.tryApply(po.id, { now: PMID });
  check('a plan order paid but never activated is mended by the next tryApply', got?.plan === 'plus' && got.paidVnd === 129000 && got.lastOrder === po.id, JSON.stringify(got));
  const stamp = (await store.getSubscription(p.id)).periodStart;
  await orders.tryApply(po.id, { now: new Date(PMID.getTime() + 60_000) });
  check('  and a second call changes nothing', +(await store.getSubscription(p.id)).periodStart === +stamp && (await balanceOf(p.id)) === 171000);
}

section('I2: a renewal paid early waits for the end');
{
  const u = await makeUser();
  await store.saveSubscription(subRow(u.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(u.id, 300000, { kind: 'topup', topup: true });
  const early = new Date(P1.getTime() - 2 * 86_400_000);
  const res = await orders.createOrder(u.id, { kind: 'renewal' }, { now: early });
  check('paid two days early: paid at once', res.paidNow && (await balanceOf(u.id)) === 171000);
  const row = await store.getSubscription(u.id);
  check('  plan, period and dates are untouched', row.plan === 'plus' && +row.periodStart === +P0 && +row.periodEnd === +P1, JSON.stringify(row));
  const inForce = await subs.planInForce(u.id, { now: new Date(P1.getTime() - 86_400_000) });
  check('  planInForce still shows the old period and its month window', +inForce.end === +P1 && +inForce.month.start === +P0 && +inForce.month.end === +P1);
  const none = await subs.remindersDue(new Date(P1.getTime() - 86_400_000 * 2.5));
  check('  a paid renewal gets no reminder', !none.some((x) => x.userId === u.id));
  await subs.setAutoRenew(u.id, false, { now: early });
  const at = await subs.catchUp(u.id, { now: new Date(P1.getTime() + 60_000) });
  check('  at the end the new period starts at the old end, charged once', at.status === 'active' && +at.periodStart === +P1 && +at.periodEnd === +periodEnd(P1, 'month') && (await balanceOf(u.id)) === 171000, JSON.stringify(at));
}

section('I3: the billing day does not drift after a short month');
{
  const u = await makeUser();
  await store.creditBalance(u.id, 5_000_000, { kind: 'topup', topup: true });
  const start = new Date('2027-01-31T05:00:00Z');
  await orders.createOrder(u.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: start });
  const ends = [(await store.getSubscription(u.id)).periodEnd.toISOString().slice(0, 10)];
  for (let i = 0; i < 11; i += 1) {
    const sub = await store.getSubscription(u.id);
    const s = await subs.catchUp(u.id, { now: new Date(sub.periodEnd.getTime() + 60_000) });
    ends.push(s.periodEnd.toISOString().slice(0, 10));
  }
  check('a 31 January monthly chain ends on the 28th, then back to the 31st', ends.join(' ') === '2027-02-28 2027-03-31 2027-04-30 2027-05-31 2027-06-30 2027-07-31 2027-08-31 2027-09-30 2027-10-31 2027-11-30 2027-12-31 2028-01-31', ends.join(' '));
  const y = await makeUser();
  await store.creditBalance(y.id, 9_000_000, { kind: 'topup', topup: true });
  await orders.createOrder(y.id, { kind: 'plan', plan: 'plus', period: 'year' }, { now: new Date('2028-02-29T05:00:00Z') });
  const yEnds = [(await store.getSubscription(y.id)).periodEnd.toISOString().slice(0, 10)];
  for (let i = 0; i < 2; i += 1) {
    const sub = await store.getSubscription(y.id);
    yEnds.push((await subs.catchUp(y.id, { now: new Date(sub.periodEnd.getTime() + 60_000) })).periodEnd.toISOString().slice(0, 10));
  }
  check('a yearly plan from 29 February keeps clamping to the 28th', yEnds.join(' ') === '2029-02-28 2030-02-28 2031-02-28', yEnds.join(' '));
}

section('I4/I7: year to month is later; credit comes from what the period was paid');
{
  const u = await makeUser();
  const start = new Date('2026-11-01T12:00:00Z');
  const yEnd = new Date('2027-11-01T12:00:00Z');
  await store.saveSubscription(subRow(u.id, { plan: 'pro', period: 'year', paidVnd: 2_340_000, periodStart: start, periodEnd: yEnd }));
  const now = new Date('2026-12-01T12:00:00Z');
  const toMonth = await orders.quote(u.id, { plan: 'max', period: 'month' }, { now });
  check('Pro year, a month in: Max month is later, total 0', toMonth.kind === 'later' && toMonth.totalVnd === 0, JSON.stringify(toMonth));
  const toYear = await orders.quote(u.id, { plan: 'max', period: 'year' }, { now });
  const credit = Math.floor((2_340_000 * (yEnd - now)) / (yEnd - start));
  check('Pro year to Max year is an upgrade with the prorated credit', toYear.kind === 'upgrade' && toYear.creditVnd === credit && toYear.totalVnd === toYear.priceVnd - credit, JSON.stringify(toYear));
  const up = await caught(subs.scheduleChange(u.id, { plan: 'max', period: 'year' }, { now }));
  check('an upgrade is refused by scheduleChange', up?.status === 422);
  const sched = await caught(subs.scheduleChange(u.id, { plan: 'max', period: 'month' }, { now }));
  check('a year-to-month move is scheduled, not refused', sched === null && (await store.getSubscription(u.id)).nextPlan === 'max');

  const v = await makeUser();
  await store.saveSubscription(subRow(v.id, { paidVnd: 100000, periodStart: P0, periodEnd: P1 }));
  const q = await orders.quote(v.id, { plan: 'pro', period: 'month' }, { now: PMID });
  check('a period paid 100,000đ gives half of that back, not half of the price', q.creditVnd === 50000 && q.totalVnd === 156000, JSON.stringify(q));

  const viaMax = await makeUser();
  const chain = await makeUser();
  await store.saveSubscription(subRow(viaMax.id, { periodStart: P0, periodEnd: P1 }));
  await store.saveSubscription(subRow(chain.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(viaMax.id, 1_000_000, { kind: 'topup', topup: true });
  await store.creditBalance(chain.id, 1_000_000, { kind: 'topup', topup: true });
  await orders.createOrder(viaMax.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: PMID });
  await orders.createOrder(chain.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: PMID });
  await orders.createOrder(chain.id, { kind: 'plan', plan: 'max', period: 'month' }, { now: PMID });
  const spent = async (id) => 1_000_000 - (await balanceOf(id));
  check('Plus to Pro to Max costs the same as Plus to Max', (await spent(chain.id)) === (await spent(viaMax.id)) && (await spent(viaMax.id)) === 320500, `${await spent(chain.id)} / ${await spent(viaMax.id)}`);
}

section('I5: renewal orders are not used up; reminders go on per account');
{
  const keep = { ...process.env };
  const u = await makeUser();
  const end = new Date(NOW.getTime() + 86_400_000);
  await store.saveSubscription(subRow(u.id, { periodStart: new Date(NOW.getTime() - 29 * 86_400_000), periodEnd: end }));
  for (const k of ['SEPAY_BANK_ACCOUNT', 'SEPAY_BANK_CODE']) delete process.env[k];
  let thrown = 0;
  for (let i = 0; i < 6; i += 1) if ((await caught(orders.createOrder(u.id, { kind: 'renewal' }, { now: NOW }))) instanceof fx.BillingUnavailable) thrown += 1;
  const mine = (await store.listOrders({ userId: u.id })).filter((o) => o.kind === 'renewal');
  check('with no bank set up, the shared renewal order is never cancelled and never multiplied', thrown === 6 && mine.length === 1 && mine[0].status === 'pending', JSON.stringify(mine.map((o) => o.status)));
  const o = await makeUser();
  await store.saveSubscription(subRow(o.id, { periodStart: new Date(NOW.getTime() - 29 * 86_400_000), periodEnd: end }));
  const made = await subs.remindersDue(NOW);
  check('  reminders for the other accounts are still made', made.some((x) => x.userId === o.id) && made.every((x) => x.order.status === 'pending'));
  Object.assign(process.env, keep);
}

section('I6: open top-up QRs count against the cap');
{
  const u = await makeUser();
  const a = await orders.createOrder(u.id, { kind: 'topup', amountVnd: 200000 }, { now: NOW });
  const b = await caught(orders.createOrder(u.id, { kind: 'topup', amountVnd: 200000 }, { now: NOW }));
  const c = await caught(orders.createOrder(u.id, { kind: 'topup', amountVnd: 50000 }, { now: NOW }));
  check('a second 200,000đ QR with none yet paid is a 422, so is any more', a.order.totalVnd === 200000 && b?.status === 422 && c?.status === 422, String(b));
  const later = await orders.createOrder(u.id, { kind: 'topup', amountVnd: 200000 }, { now: new Date(NOW.getTime() + 3_600_000) });
  check('  an expired QR no longer counts', later.order.totalVnd === 200000);
}

section('M1/M3: a slipped rate is not charged with; a cancelled plan is free once it ends');
{
  await forget();
  allDown();
  await query(`DELETE FROM settings WHERE key = 'billing_fx'`);
  erapiSays(2565.585);
  vcbSays(25400);
  const a = await fx.usdVnd({ now: NOW });
  check('a rate off by a factor of ten is skipped for the next source', a.source === 'vietcombank' && a.rate === 25400, JSON.stringify(a));
  await forget();
  await store.setSetting('billing_fx', { rate: 25000, source: 'erapi', at: hours(-3).toISOString() });
  erapiSays(31000);
  // The cron's read: a usdVnd the same day would just use the kept rate.
  const b = await fx.refreshRate({ now: NOW, force: true });
  check('a rate more than 20% from the last one is skipped too', b.source === 'vietcombank' && b.rate === 25400, JSON.stringify(b));
  await prime();
  const u = await makeUser();
  await store.saveSubscription(subRow(u.id, { periodStart: P0, periodEnd: P1, cancelAtEnd: true }));
  const before = await subs.planInForce(u.id, { now: new Date(P1.getTime() - 1000) });
  const past = await subs.planInForce(u.id, { now: new Date(P1.getTime() + 1000) });
  check('cancel at the end: still the plan before the end, free from the end on', before.plan === 'plus' && past.plan === 'free');
}

/* ── fix round 2 (re-review of d35355f): one payment per basis, refunds, early renewals ── */
const invariant = async (userId) => {
  const rows = await query(`SELECT (SELECT COALESCE(SUM(delta_vnd), 0) FROM balance_entries WHERE user_id = $1) AS e, (SELECT COALESCE(SUM(vnd), 0) FROM balances WHERE user_id = $1) AS b`, [userId]);
  return Number(rows[0].e) === Number(rows[0].b);
};
const upgradeOrder = (userId, over = {}) => direct(userId, { creditVnd: 64500, totalVnd: 141500, basis: plusBasis, ...over });

section('C1 under concurrency: one payment per basis');
{
  await prime();
  const a = await makeUser();
  await store.saveSubscription(subRow(a.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(a.id, 1_000_000, { kind: 'topup', topup: true });
  const o1 = await upgradeOrder(a.id);
  const o2 = await upgradeOrder(a.id, { plan: 'max', usdCents: 1500, priceVnd: 385000, totalVnd: 320500 });
  await Promise.allSettled([orders.tryApply(o1.id, { now: PMID }), orders.tryApply(o2.id, { now: PMID })]);
  const st = [(await store.getOrder(o1.id)).status, (await store.getOrder(o2.id)).status];
  const s = await store.getSubscription(a.id);
  const spent = 1_000_000 - (await balanceOf(a.id));
  const winner = st[0] === 'paid' ? o1 : o2;
  check('two upgrades paid together: exactly one is paid, one payment is taken, the other is closed', st.filter((x) => x === 'paid').length === 1 && spent === winner.totalVnd && s.lastOrder === winner.id && s.plan === winner.plan, JSON.stringify([st, spent, s.plan]));

  const dbl = await makeUser();
  await store.saveSubscription(subRow(dbl.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(dbl.id, 1_000_000, { kind: 'topup', topup: true });
  const clicks = await Promise.allSettled([1, 2].map(() => orders.createOrder(dbl.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: PMID })));
  const paidPlan = (await store.listOrders({ userId: dbl.id })).filter((o) => o.kind === 'plan' && o.status === 'paid');
  check('a double click on "upgrade to Pro" is one payment', paidPlan.length === 1 && 1_000_000 - (await balanceOf(dbl.id)) === 141500 && clicks.filter((x) => x.status === 'fulfilled' && x.value.paidNow).length === 1, JSON.stringify([paidPlan.length, await balanceOf(dbl.id), clicks.map((x) => x.status)]));
  check('  and the ledger still adds up', await invariant(dbl.id));

  const none = await makeUser();
  await store.creditBalance(none.id, 500000, { kind: 'topup', topup: true });
  const n1 = await direct(none.id, { plan: 'plus', usdCents: 500, priceVnd: 129000, totalVnd: 129000 });
  const n2 = await direct(none.id, { plan: 'max', usdCents: 1500, priceVnd: 385000, totalVnd: 385000 });
  await Promise.allSettled([orders.tryApply(n1.id, { now: PMID }), orders.tryApply(n2.id, { now: PMID })]);
  const paidNone = (await store.listOrders({ userId: none.id })).filter((o) => o.status === 'paid');
  check('two first purchases at once: exactly one is paid, and its total is what left the balance', paidNone.length === 1 && [n1.id, n2.id].includes(paidNone[0].id) && 500000 - (await balanceOf(none.id)) === paidNone[0].totalVnd, JSON.stringify(paidNone.map((o) => [o.plan, o.totalVnd])));
  const ended = await makeUser();
  await store.saveSubscription(subRow(ended.id, { status: 'ended', periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(ended.id, 500000, { kind: 'topup', topup: true });
  const back = await orders.createOrder(ended.id, { kind: 'plan', plan: 'plus', period: 'month' }, { now: new Date('2027-03-01T00:00:00Z') });
  check('a returning customer\'s order is based on the lapse it follows', back.paidNow && back.order.basis === `none|${P1.getTime()}`, String(back.order.basis));
}

section('N1/N2: a renewal paid early; asking again; an upgrade on top');
{
  process.env.SEPAY_BANK_ACCOUNT ||= '0123456789';
  process.env.SEPAY_BANK_CODE ||= 'MBBank';
  const b = await makeUser();
  await store.saveSubscription(subRow(b.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(b.id, 400000, { kind: 'topup', topup: true });
  const ren = await orders.createOrder(b.id, { kind: 'renewal' }, { now: new Date(P1.getTime() - 2 * 86_400_000) });
  const again = await caught(orders.createOrder(b.id, { kind: 'renewal' }, { now: new Date(P1.getTime() - 86_400_000) }));
  check('asking to renew again after paying early is a 422, not a QR for a paid order', ren.paidNow && again?.status === 422, String(again));
  const up = await caught(orders.createOrder(b.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: new Date(P1.getTime() - 86_400_000) }));
  check('an upgrade on top of a paid renewal is refused up front', up?.status === 422 && (await balanceOf(b.id)) === 271000, String(up));
  const s = await store.getSubscription(b.id);
  const after = await subs.catchUp(b.id, { now: new Date(s.periodEnd.getTime() + 60_000) });
  check('  and the renewal still starts at the end', after.plan === 'plus' && +after.periodStart === +P1 && (await balanceOf(b.id)) === 271000);
  const hold = await makeUser();
  await store.saveSubscription(subRow(hold.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(hold.id, 400000, { kind: 'topup', topup: true });
  await orders.createOrder(hold.id, { kind: 'renewal' }, { now: new Date(P1.getTime() - 2 * 86_400_000) });
  await subs.setCancelAtEnd(hold.id, true, { now: new Date(P1.getTime() - 86_400_000) });
  const stillIn = await subs.planInForce(hold.id, { now: new Date(P1.getTime() + 3_600_000) });
  check('cancel-at-end after paying the renewal: still in force until catchUp starts the paid period', stillIn.plan === 'plus');
}

section('I1: a crash between paying and activating is mended, never charged twice');
{
  const d = await makeUser();
  await store.saveSubscription(subRow(d.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(d.id, 1_000_000, { kind: 'topup', topup: true });
  const o1 = await upgradeOrder(d.id);
  await store.payOrderFromBalance(o1.id, PMID);
  for (let i = 0; i < 3; i += 1) await store.createOrder({ id: crypto.randomUUID(), userId: d.id, kind: 'topup', code: newPaymentCode(), priceVnd: 100000, totalVnd: 100000, useBalance: false, expiresAt: far });
  const retry = await orders.createOrder(d.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: PMID });
  const sub = await store.getSubscription(d.id);
  check('the person asks again: the paid order is applied, not paid a second time', retry.paidNow && retry.order.id === o1.id && sub.plan === 'pro' && sub.lastOrder === o1.id && 1_000_000 - (await balanceOf(d.id)) === 141500, JSON.stringify([retry.order.id === o1.id, await balanceOf(d.id)]));
  check('  an order that was applied is marked so', (await store.getOrder(o1.id)).appliedAt instanceof Date);
}

section('refunds: a paid order that can no longer be applied gives the money back');
{
  const r = await makeUser();
  await store.saveSubscription(subRow(r.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(r.id, 500000, { kind: 'topup', topup: true });
  const o = await upgradeOrder(r.id);
  await store.payOrderFromBalance(o.id, PMID);
  // The plan moves on before the activation happens (another device, a manual change).
  await store.patchSubscription(r.id, {}, { plan: 'max', periodEnd: new Date('2027-01-01T00:00:00Z') });
  check('paid and unapplied: the balance is down by the order', (await balanceOf(r.id)) === 358500);
  await subs.catchUp(r.id, { now: PMID });
  const o2 = await store.getOrder(o.id);
  const entries = await store.listBalanceEntries(r.id, { kind: 'refund' });
  check('catchUp refunds it: refunded, balance restored, one refund entry, ledger intact', o2.status === 'refunded' && (await balanceOf(r.id)) === 500000 && entries.length === 1 && entries[0].deltaVnd === 141500 && (await invariant(r.id)), JSON.stringify([o2.status, await balanceOf(r.id), entries.length]));
  check('  and the refund is not new money (the 12-month clock is untouched)', (await store.billingState(r.id)).lastTopupAt instanceof Date);
  await subs.catchUp(r.id, { now: PMID });
  check('  a second pass refunds nothing more', (await balanceOf(r.id)) === 500000);
}

section('N3: an old renewal cannot give a free period again');
{
  const e = await makeUser();
  await store.saveSubscription(subRow(e.id, { periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(e.id, 1_000_000, { kind: 'topup', topup: true });
  const t = new Date(P1.getTime() + 3_600_000);
  const ren = await orders.createOrder(e.id, { kind: 'renewal' }, { now: t });
  await orders.createOrder(e.id, { kind: 'plan', plan: 'pro', period: 'month' }, { now: new Date(t.getTime() + 86_400_000) });
  await store.patchSubscription(e.id, {}, { status: 'ended' });
  const before = await store.getSubscription(e.id);
  const balBefore = await balanceOf(e.id);
  const res = await orders.tryApply(ren.order.id, { now: new Date('2027-03-01T00:00:00Z') });
  const after = await store.getSubscription(e.id);
  check('re-applying the old renewal on an ended plan changes nothing', res?.status !== 'active' && after.status === 'ended' && +after.periodEnd === +before.periodEnd && after.lastOrder === before.lastOrder && (await balanceOf(e.id)) === balBefore, JSON.stringify(after));
}

section('F: a start and a refund of one order cannot both happen');
{
  const f = await makeUser();
  await store.saveSubscription(subRow(f.id, { status: 'grace', periodStart: P0, periodEnd: P1 }));
  await store.creditBalance(f.id, 1_000_000, { kind: 'topup', topup: true });
  const inGrace = new Date(P1.getTime() + 3 * 86_400_000 - 60_000);
  const pastGrace = new Date(P1.getTime() + 3 * 86_400_000 + 60_000);
  const o = await upgradeOrder(f.id, { creditVnd: 0, totalVnd: 206000 });
  const paid = await store.payOrderFromBalance(o.id, inGrace);
  // The start has read the row (still in grace) when a catch-up past the end of grace refunds the order.
  const realGet = store.getSubscription.bind(store);
  let first = true;
  store.getSubscription = async (id) => { const row = await realGet(id); if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 80)); } return row; };
  const y = subs.activate(paid, { now: inGrace });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const x = subs.catchUp(f.id, { now: pastGrace });
  await Promise.allSettled([y, x]);
  store.getSubscription = realGet;
  const ord = await store.getOrder(o.id);
  const sub = await store.getSubscription(f.id);
  const bal = await balanceOf(f.id);
  const refunded = ord.status === 'refunded' && !ord.appliedAt && sub.lastOrder !== o.id && sub.plan === 'plus' && bal === 1_000_000;
  const started = ord.status === 'paid' && ord.appliedAt instanceof Date && sub.lastOrder === o.id && sub.plan === 'pro' && bal === 794000;
  check('either refunded and not started, or started and not refunded', (refunded || started) && (await invariant(f.id)), JSON.stringify([ord.status, !!ord.appliedAt, sub.plan, bal]));
}

section('planInForce reads and writes nothing');
{
  const u = await makeUser();
  await store.saveSubscription(subRow(u.id, { periodStart: P0, periodEnd: P1, cancelAtEnd: true }));
  const sub = await store.getSubscription(u.id);
  const { order } = await orders.renewalOrderFor(sub, { now: PMID });
  await store.patchSubscription(u.id, {}, { nextPlan: 'max', nextPeriod: 'month' });
  await subs.planInForce(u.id, { now: new Date(P1.getTime() + 3_600_000) });
  check('a pending renewal made for other terms is left as it was', (await store.getOrder(order.id)).status === 'pending');
}

section('N5: the 20% band only holds against a recent rate');
{
  await forget();
  allDown();
  await store.setSetting('billing_fx', { rate: 20000, source: 'erapi', at: hours(-60).toISOString() });
  erapiSays(25655.85);
  const r = await fx.usdVnd({ now: NOW });
  check('a stale stored rate does not lock a good one out', r.rate === 25655.85 && r.source === 'erapi', JSON.stringify(r));
  await prime();
}

section('transfers: SePay checked on its raw bytes, taken once, matched to its order or kept');
{
  const sepay = await import('../server/billing/sepay.js');
  const { encryptSecret, openSecret } = await import('../server/crypto.js');
  const { billingProfileContext } = await import('../server/secretContexts.js');
  await prime();
  process.env.SEPAY_BANK_ACCOUNT = '0123456789';
  process.env.SEPAY_BANK_CODE = 'MBBank';
  process.env.SEPAY_WEBHOOK_SECRET = 'whsec-test-secret';
  process.env.SEPAY_API_TOKEN = 'api-token-test';
  delete process.env.BILLING_MODE;
  const SECRET = process.env.SEPAY_WEBHOOK_SECRET;
  const ts0 = Math.floor(NOW.getTime() / 1000);
  const sign = (raw, ts, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  const headersFor = (raw, ts = ts0) => ({ 'x-sepay-signature': sign(raw, ts), 'x-sepay-timestamp': String(ts) });
  const verify = (raw, headers, secret = SECRET, now = NOW.getTime()) => sepay.verifySepay({ raw: Buffer.from(raw), headers, secret, now });
  const body = '{"id":1,"transferAmount":5000}';

  /* verification */
  check('a good signature verifies', verify(body, headersFor(body)) === true);
  check('  the header names may be any case', verify(body, { 'X-SePay-Signature': sign(body, ts0), 'X-SePay-Timestamp': String(ts0) }) === true);
  check('a missing signature does not', verify(body, { 'x-sepay-timestamp': String(ts0) }) === false);
  check('a missing timestamp does not', verify(body, { 'x-sepay-signature': sign(body, ts0) }) === false);
  check('sha1= instead of sha256= does not', verify(body, { ...headersFor(body), 'x-sepay-signature': sign(body, ts0).replace('sha256=', 'sha1=') }) === false);
  check('one hex character short does not', verify(body, { ...headersFor(body), 'x-sepay-signature': sign(body, ts0).slice(0, -1) }) === false);
  const sig = sign(body, ts0);
  const flipped = sig.slice(0, 7) + (sig[7] === '0' ? '1' : '0') + sig.slice(8);
  check('one bit wrong does not', verify(body, { ...headersFor(body), 'x-sepay-signature': flipped }) === false);
  check('non-hex letters do not (and nothing throws)', verify(body, { ...headersFor(body), 'x-sepay-signature': `sha256=${'z'.repeat(64)}` }) === false);
  check('a signature over other bytes does not', verify(`${body} `, headersFor(body)) === false);
  check('another secret does not', verify(body, headersFor(body), 'other-secret') === false);
  check('an unset secret never verifies', verify(body, headersFor(body), '') === false);
  check('301 s old does not', verify(body, headersFor(body, ts0 - 301)) === false);
  check('301 s ahead does not', verify(body, headersFor(body, ts0 + 301)) === false);
  check('300 s old still does', verify(body, headersFor(body, ts0 - 300)) === true);
  check('a timestamp that is not a number does not', verify(body, { 'x-sepay-signature': sign(body, 'abc'), 'x-sepay-timestamp': 'abc' }) === false);

  /* the webhook's answers */
  const payload = (over = {}) => ({
    id: 90000 + (n += 1), gateway: 'MBBank', transactionDate: '2026-11-13 12:00:00', accountNumber: '0123456789', subAccount: '', code: null,
    content: '', transferType: 'in', description: '', transferAmount: 129000, accumulated: 0, referenceCode: `FT${n * 7919}`, ...over,
  });
  const send = (p, { now = NOW, headers = null } = {}) => {
    const raw = Buffer.from(typeof p === 'string' ? p : JSON.stringify(p));
    return sepay.acceptSepay({ raw, headers: headers ?? headersFor(raw, Math.floor(now.getTime() / 1000)), now: now.getTime() });
  };
  const ok = (a) => a.status === 200 && a.body.success === true && Object.keys(a.body).length === 1;
  const topupEntries = async () => Number((await query("SELECT COALESCE(SUM(delta_vnd), 0) AS s FROM balance_entries WHERE kind = 'topup'"))[0].s);
  const transferCount = async () => Number((await query('SELECT COUNT(*) AS c FROM sepay_transfers'))[0].c);
  const planOrder = async (userId, plan = 'plus', now = NOW) => (await orders.createOrder(userId, { kind: 'plan', plan, period: 'month' }, { now })).order;

  process.env.BILLING_MODE = 'off';
  check('mode off: the endpoint does not exist (404)', (await send(payload())).status === 404);
  delete process.env.BILLING_MODE;
  const savedSecret = process.env.SEPAY_WEBHOOK_SECRET;
  delete process.env.SEPAY_WEBHOOK_SECRET;
  check('no secret set: 404, not 401', (await send(payload())).status === 404);
  process.env.SEPAY_WEBHOOK_SECRET = savedSecret;
  check('a bad signature is 401', (await send(payload(), { headers: { 'x-sepay-signature': `sha256=${'0'.repeat(64)}`, 'x-sepay-timestamp': String(ts0) } })).status === 401);
  check('a request without the headers is 401', (await send(payload(), { headers: {} })).status === 401);
  check('a stale timestamp is 401', (await send(payload(), { headers: headersFor(Buffer.from(JSON.stringify(payload())), ts0 - 400) })).status === 401);
  const beforeCount = await transferCount();
  check('a signed body that is not JSON is 400', (await send('not json')).status === 400);
  check('  nor an array', (await send('[1]')).status === 400);
  check('  nor an object without a numeric transferAmount', (await send({ id: 5, transferAmount: '129000' })).status === 400);
  check('  nor a zero amount', (await send(payload({ transferAmount: 0 }))).status === 400);
  check('  and none of those wrote a transfer', (await transferCount()) === beforeCount);

  /* exact amount */
  const ann = await makeUser();
  await store.setBillingProfile(ann.id, encryptSecret(JSON.stringify({ name: 'Ann Buyer' }), billingProfileContext(ann.id)));
  const oa = await planOrder(ann.id);
  const exact = payload({ code: oa.code, content: `${oa.code} chuyen khoan`, transferAmount: 129000, referenceCode: 'FT-EXACT' });
  const ra = await send(exact);
  const subA = await store.getSubscription(ann.id);
  check('exactly the price: 200 with exactly {"success": true}', ok(ra) && JSON.stringify(ra.body) === '{"success":true}', JSON.stringify(ra));
  check('  the plan is active and the order paid', subA?.plan === 'plus' && subA.status === 'active' && (await store.getOrder(oa.id)).status === 'paid');
  const tA = await store.getTransferByDedupe('ref:FT-EXACT');
  check('  the transfer is recorded as applied, linked to the order and the account', tA.outcome === 'applied' && tA.orderId === oa.id && tA.userId === ann.id && tA.via === 'webhook' && tA.creditedAt instanceof Date, JSON.stringify(tA));
  check('  the money went in and out of the balance, ledger intact', (await balanceOf(ann.id)) === 0 && (await invariant(ann.id)));
  const rcA = await store.listReceipts(ann.id);
  check('  one receipt, for the transfer, with no buyer details in its lines', rcA.length === 1 && rcA[0].transferId === tA.id && rcA[0].amountVnd === 129000 && !JSON.stringify(rcA[0].lines).includes('Ann'), JSON.stringify(rcA));
  check('  its sealed buyer opens with the billing profile context', openSecret(rcA[0].buyerSealed, billingProfileContext(ann.id)).value.includes('Ann Buyer'));

  /* a repeat */
  const rep = await send(exact);
  check('the same referenceCode again: success, and nothing taken twice', ok(rep) && (await store.listTransfers({ limit: 500 })).filter((t) => t.referenceCode === 'FT-EXACT').length === 1 && (await balanceOf(ann.id)) === 0 && (await store.listReceipts(ann.id)).length === 1);
  const noRef = payload({ referenceCode: '', code: null, content: 'hello', transferAmount: 7000, id: 4242 });
  await send(noRef);
  await send(noRef);
  check('without a reference the id is the key, so that repeats too', (await query("SELECT 1 FROM sepay_transfers WHERE dedupe = 'id:4242'")).length === 1);

  /* ignored */
  const bob = await makeUser();
  const ob = await planOrder(bob.id);
  const before = await topupEntries();
  const rOut = await send(payload({ transferType: 'out', code: ob.code, content: ob.code }));
  const rOther = await send(payload({ accountNumber: '999999', code: ob.code, content: ob.code }));
  check('money going out is answered and ignored, no credit', ok(rOut) && (await topupEntries()) === before && (await store.listTransfers({ outcome: 'ignored' })).length >= 2);
  check('another account number is ignored too', ok(rOther) && (await balanceOf(bob.id)) === 0 && (await store.getOrder(ob.id)).status === 'pending');

  /* short, then the rest */
  const rs = await send(payload({ code: ob.code, content: ob.code, transferAmount: 100000, referenceCode: 'FT-SHORT1' }));
  const shortT = await store.getTransferByDedupe('ref:FT-SHORT1');
  const shortOrder = await store.getOrder(ob.id);
  check('short: the balance goes up, the order stays pending', ok(rs) && shortT.outcome === 'short' && (await balanceOf(bob.id)) === 100000 && shortOrder.status === 'pending' && !(await store.getSubscription(bob.id)));
  check('  dueOf the rest is what is missing', orders.dueOf(shortOrder, await balanceOf(bob.id)) === 29000);
  const rs2 = await send(payload({ code: ob.code, content: `SZ chuyen ${ob.code}`, transferAmount: 29000, referenceCode: 'FT-SHORT2' }));
  const shortT2 = await store.getTransferByDedupe('ref:FT-SHORT2');
  check('a second transfer with the same code finishes it: applied, plan active, balance used', ok(rs2) && shortT2.outcome === 'applied' && (await store.getSubscription(bob.id))?.plan === 'plus' && (await balanceOf(bob.id)) === 0 && (await store.getOrder(ob.id)).status === 'paid' && (await invariant(bob.id)));
  check('  each credited transfer has its receipt', (await store.listReceipts(bob.id)).length === 2);

  /* over */
  const cy = await makeUser();
  const oc = await planOrder(cy.id);
  await send(payload({ code: oc.code, content: oc.code, transferAmount: 150000, referenceCode: 'FT-OVER' }));
  check('more than the price: over, the plan starts, the rest stays in the balance', (await store.getTransferByDedupe('ref:FT-OVER')).outcome === 'over' && (await store.getSubscription(cy.id))?.plan === 'plus' && (await balanceOf(cy.id)) === 21000 && (await invariant(cy.id)));

  /* late */
  const dan = await makeUser();
  const od = await planOrder(dan.id);
  const rl = await send(payload({ code: od.code, content: od.code, transferAmount: 129000, referenceCode: 'FT-LATE' }), { now: hours(1) });
  check('after the order expired: late, the money is credited, no plan', ok(rl) && (await store.getTransferByDedupe('ref:FT-LATE')).outcome === 'late' && (await balanceOf(dan.id)) === 129000 && !(await store.getSubscription(dan.id)) && (await store.getOrder(od.id)).receivedVnd === 0);
  const eli = await makeUser();
  const oe = await planOrder(eli.id);
  await store.cancelOrder(oe.id, eli.id);
  await send(payload({ code: oe.code, content: oe.code, transferAmount: 50000, referenceCode: 'FT-CANC' }));
  check('a cancelled order is late too', (await store.getTransferByDedupe('ref:FT-CANC')).outcome === 'late' && (await balanceOf(eli.id)) === 50000);

  /* unmatched */
  const beforeUn = await topupEntries();
  await send(payload({ content: 'chuyen tien an trua', transferAmount: 80000, referenceCode: 'FT-NOCODE' }));
  await send(payload({ code: 'SZ0000000001', content: 'SZ0000000001', transferAmount: 80000, referenceCode: 'FT-NOORDER' }));
  const un = await store.getTransferByDedupe('ref:FT-NOCODE');
  const un2 = await store.getTransferByDedupe('ref:FT-NOORDER');
  check('no code, or a code with no order: unmatched, nothing credited, kept for the owner', un.outcome === 'unmatched' && un2.outcome === 'unmatched' && un.userId === null && un.creditedAt === null && (await topupEntries()) === beforeUn);
  check('  and no receipt for it', (await query('SELECT 1 FROM receipts WHERE transfer_id = ANY($1::bigint[])', [[un.id, un2.id]])).length === 0);

  /* a top-up order */
  const fay = await makeUser();
  const ot = (await orders.createOrder(fay.id, { kind: 'topup', amountVnd: 100000 }, { now: NOW })).order;
  await send(payload({ code: ot.code, content: ot.code, transferAmount: 100000, referenceCode: 'FT-TOPUP' }));
  const topT = await store.getTransferByDedupe('ref:FT-TOPUP');
  const topO = await store.getOrder(ot.id);
  check('a top-up: the balance is credited, the order marked paid with what arrived', topT.outcome === 'topup' && (await balanceOf(fay.id)) === 100000 && topO.status === 'paid' && topO.receivedVnd === 100000 && (await store.billingState(fay.id)).lastTopupAt instanceof Date);
  await send(payload({ code: ot.code, content: ot.code, transferAmount: 20000, referenceCode: 'FT-TOPUP2' }));
  check('  a second transfer to a paid top-up is credited too (late)', (await store.getTransferByDedupe('ref:FT-TOPUP2')).outcome === 'late' && (await balanceOf(fay.id)) === 120000 && (await invariant(fay.id)));

  /* a failing store: 500, nothing half-written, and the retry finishes it */
  const gil = await makeUser();
  const og = await planOrder(gil.id);
  const pg = payload({ code: og.code, content: og.code, transferAmount: 129000, referenceCode: 'FT-CRASH1' });
  const realCredit = store.creditTransfer;
  store.creditTransfer = async () => { throw new Error('connection lost'); };
  const r500 = await send(pg);
  store.creditTransfer = realCredit;
  check('the store fails before the credit: 500 and {success:false}', r500.status === 500 && JSON.stringify(r500.body) === '{"success":false}');
  check('  nothing is half-written: no credit, order pending, no receipt', (await balanceOf(gil.id)) === 0 && (await store.getOrder(og.id)).status === 'pending' && (await store.listReceipts(gil.id)).length === 0);
  check('  the error text is not in the answer', !JSON.stringify(r500).includes('connection'));
  const retry1 = await send(pg);
  check('SePay retries: the transfer is finished, credited once, plan active', ok(retry1) && (await store.getTransferByDedupe('ref:FT-CRASH1')).outcome === 'applied' && (await store.getSubscription(gil.id))?.plan === 'plus' && (await balanceOf(gil.id)) === 0 && (await invariant(gil.id)) && (await store.listReceipts(gil.id)).length === 1);

  /* a crash after the credit */
  const hal = await makeUser();
  const oh = await planOrder(hal.id);
  const ph = payload({ code: oh.code, content: oh.code, transferAmount: 129000, referenceCode: 'FT-CRASH2' });
  const realSetOutcome = store.finishTransfer;
  store.finishTransfer = async () => { throw new Error('connection lost'); };
  const r500b = await send(ph);
  store.finishTransfer = realSetOutcome;
  const midT = await store.getTransferByDedupe('ref:FT-CRASH2');
  check('a crash after the credit: 500, the transfer is still marked taking', r500b.status === 500 && midT.outcome === 'taking' && midT.creditedAt instanceof Date);
  const retry2 = await send(ph);
  const endT = await store.getTransferByDedupe('ref:FT-CRASH2');
  check('the retry finishes it: credited once, order paid, plan active, outcome set', ok(retry2) && endT.outcome === 'applied' && (await store.getOrder(oh.id)).status === 'paid' && (await store.getSubscription(hal.id))?.plan === 'plus' && (await balanceOf(hal.id)) === 0 && (await invariant(hal.id)));
  check('  the ledger holds one credit for it and the receipt is issued once', (await query("SELECT 1 FROM balance_entries WHERE kind = 'topup' AND ref = $1", [String(endT.id)])).length === 1 && (await store.listReceipts(hal.id)).length === 1);
  const retry3 = await send(ph);
  check('  and a third delivery changes nothing', ok(retry3) && (await store.listReceipts(hal.id)).length === 1 && (await balanceOf(hal.id)) === 0);

  /* a top-up that crashed after the credit */
  const ivy = await makeUser();
  const oi = (await orders.createOrder(ivy.id, { kind: 'topup', amountVnd: 100000 }, { now: NOW })).order;
  const pi = payload({ code: oi.code, content: oi.code, transferAmount: 100000, referenceCode: 'FT-CRASH3' });
  const realMark = store.markTopupPaid;
  store.markTopupPaid = async () => { throw new Error('connection lost'); };
  const r500c = await send(pi);
  store.markTopupPaid = realMark;
  await send(pi);
  const oiAfter = await store.getOrder(oi.id);
  check('a top-up that crashed before its order was closed: the retry closes it, credit once', r500c.status === 500 && (await balanceOf(ivy.id)) === 100000 && oiAfter.status === 'paid' && oiAfter.receivedVnd === 100000 && (await store.getTransferByDedupe('ref:FT-CRASH3')).outcome === 'topup');

  /* reconcile */
  const polls = [];
  let pollRows = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.host !== 'userapi.sepay.vn') return fetchBefore(url, init);
    polls.push({ path: u.pathname, auth: init?.headers?.Authorization ?? init?.headers?.authorization, query: Object.fromEntries(u.searchParams) });
    return json({ data: pollRows, meta: { pagination: { total: pollRows.length, per_page: 100, current_page: 1, last_page: 1, has_more: false } } });
  };
  const jay = await makeUser();
  const oj = await planOrder(jay.id);
  const row = (over = {}) => ({
    id: '0b1f2e3a-0000-4000-8000-000000000001', transaction_date: '2026-11-13 12:00:00', account_number: '0123456789', va: null, transfer_type: 'in', amount_in: 129000, amount_out: 0,
    accumulated: 0, transaction_content: `${oj.code} chuyen khoan`, reference_number: 'FT-POLL1', code: oj.code, bank_brand_name: 'MBBank', ...over,
  });
  pollRows = [row(), row({ id: '0b1f2e3a-0000-4000-8000-000000000002', reference_number: null, amount_in: 5000, transaction_content: 'no reference' })];
  sepay._resetSepayForTests();
  const since = new Date(NOW.getTime() - 86_400_000);
  const took = await sepay.reconcile({ since, now: NOW.getTime() });
  check('reconcile asks the v2 transactions list with the bearer token', polls.length === 1 && polls[0].path === '/v2/transactions' && polls[0].auth === 'Bearer api-token-test', JSON.stringify(polls));
  const tj = await store.getTransferByDedupe('ref:FT-POLL1');
  check('  a row with a reference number is taken (via poll); one without is left', took === 1 && tj.via === 'poll' && tj.outcome === 'applied' && (await store.getSubscription(jay.id))?.plan === 'plus' && (await query("SELECT 1 FROM sepay_transfers WHERE content = 'no reference'")).length === 0);
  const afterPoll = await balanceOf(jay.id);
  const rj = await send(payload({ code: oj.code, content: oj.code, transferAmount: 129000, referenceCode: 'FT-POLL1' }));
  check('the webhook that repeats a polled transfer credits nothing more', ok(rj) && (await balanceOf(jay.id)) === afterPoll && (await query("SELECT 1 FROM balance_entries WHERE kind = 'topup' AND user_id = $1", [jay.id])).length === 1);
  check('  and that same poll again takes nothing', (await sepay.reconcile({ since, now: NOW.getTime() + 11_000 })) === 0);
  const asked0 = polls.length;
  check('throttled: not twice within 10 s overall', (await sepay.reconcile({ since, now: NOW.getTime() + 12_000 })) === 0 && polls.length === asked0);
  sepay._resetSepayForTests();
  const p1 = polls.length;
  await sepay.reconcile({ since: NOW, orderId: oj.id, now: NOW.getTime() });
  await sepay.reconcile({ since: NOW, orderId: oj.id, now: NOW.getTime() + 11_000 });
  check('  and not twice within 30 s for one order', polls.length === p1 + 1);
  await sepay.reconcile({ since: NOW, orderId: oj.id, now: NOW.getTime() + 31_000 });
  check('  while after 30 s it asks again, naming the order\'s code', polls.length === p1 + 2 && polls.at(-1).query.q === oj.code && polls.at(-1).query.transfer_type === 'in', JSON.stringify(polls.at(-1)));
  const tokenWas = process.env.SEPAY_API_TOKEN;
  delete process.env.SEPAY_API_TOKEN;
  sepay._resetSepayForTests();
  const p2 = polls.length;
  check('without SEPAY_API_TOKEN: 0, and nothing is asked', (await sepay.reconcile({ since: NOW, now: NOW.getTime() })) === 0 && polls.length === p2);
  process.env.SEPAY_API_TOKEN = tokenWas;
  globalThis.fetch = fetchBefore;

  /* simulated */
  const kim = await makeUser();
  const ok2 = await planOrder(kim.id);
  const sim = await sepay.simulateTransfer(ok2.id, { now: NOW });
  const simT = await store.getTransfer(sim.transferId);
  check('simulateTransfer in preview takes the order\'s due as a simulated transfer', sim.status === 200 && sim.outcome === 'applied' && simT.via === 'simulated' && simT.amountVnd === 129000 && (await store.getSubscription(kim.id))?.plan === 'plus');
  check('  and never issues a receipt', (await store.listReceipts(kim.id)).length === 0);
  const lee = await makeUser();
  const ol = await planOrder(lee.id);
  process.env.BILLING_MODE = 'live';
  const refused = await sepay.simulateTransfer(ol.id, { now: NOW });
  delete process.env.BILLING_MODE;
  check('in live it is refused (409) and nothing moves', refused.status === 409 && (await balanceOf(lee.id)) === 0 && (await store.getOrder(ol.id)).status === 'pending');
  check('an unknown order is 404, a settled order 409', (await sepay.simulateTransfer('nope', { now: NOW })).status === 404 && (await sepay.simulateTransfer(ok2.id, { now: NOW })).status === 409);
  const mia = await makeUser();
  const om = await planOrder(mia.id);
  await send(payload({ code: om.code, content: om.code, transferAmount: 100000, referenceCode: 'FT-PART' }));
  const simPart = await sepay.simulateTransfer(om.id, { now: NOW });
  check('a partly paid order is simulated for what is left', simPart.outcome === 'applied' && (await store.getTransfer(simPart.transferId)).amountVnd === 29000);

  /* fix round 1: the row is the truth, not the redelivery */
  const seqNow = async () => Number((await query('SELECT last_value FROM receipt_seq'))[0].last_value);
  const quiet = async (fn) => {
    const seen = [];
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(saved)) console[k] = (...a) => seen.push(a.join(' '));
    try { await fn(); } finally { Object.assign(console, saved); }
    return seen;
  };
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-DUP3' });
    const seq0 = await seqNow();
    const res = await Promise.all([send(p), send(p), send(p)]);
    const t = await store.getTransferByDedupe('ref:FT-DUP3');
    check('three deliveries at once: all succeed, one credit, one receipt, one plan', res.every(ok) && (await query("SELECT 1 FROM balance_entries WHERE kind = 'topup' AND user_id = $1", [u.id])).length === 1 && (await store.listReceipts(u.id)).length === 1 && (await store.getSubscription(u.id))?.plan === 'plus' && (await balanceOf(u.id)) === 0);
    check('  and one label that stays: exactly the price is applied, not over', t.outcome === 'applied', t.outcome);
    const seq1 = await seqNow();
    await send(p);
    check('  a later redelivery does not use up a receipt number', (await seqNow()) === seq1 && seq1 > seq0);
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const real = store.creditTransfer;
    store.creditTransfer = async () => { throw new Error('boom'); };
    await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-AMT1', transferAmount: 129000 }));
    store.creditTransfer = real;
    const warned = await quiet(async () => { await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-AMT1', transferAmount: 5000000 })); });
    const t = await store.getTransferByDedupe('ref:FT-AMT1');
    check('a redelivery under the same reference with another amount credits what was recorded', t.amountVnd === 129000 && (await store.getOrder(o.id)).receivedVnd === 129000 && (await balanceOf(u.id)) === 0 && (await store.getSubscription(u.id))?.plan === 'plus' && (await invariant(u.id)));
    check('  and says so in the log, with ids and amounts only', warned.some((l) => l.includes('another amount') && l.includes('5000000') && l.includes('129000')) && !warned.some((l) => l.includes(o.code)), JSON.stringify(warned).slice(0, 200));
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const real = store.creditTransfer;
    store.creditTransfer = async () => { throw new Error('boom'); };
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-GONE1' });
    await send(p);
    store.creditTransfer = real;
    await store.deleteUser(u.id);
    const r = await send(p);
    const t = await store.getTransferByDedupe('ref:FT-GONE1');
    check('the account goes before the retry: success, the transfer ends unmatched for the owner, nothing credited', ok(r) && t.outcome === 'unmatched' && t.creditedAt === null, JSON.stringify([r.status, t.outcome]));
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const realFinish = store.finishTransfer;
    store.finishTransfer = async () => { throw new Error('boom'); };
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-GONE2', transferAmount: 129000 });
    await send(p);
    store.finishTransfer = realFinish;
    await store.deleteUser(u.id);
    const r = await send(p);
    check('credited, then the account goes: the retry finishes it (late) without throwing', ok(r) && (await store.getTransferByDedupe('ref:FT-GONE2')).outcome === 'late', String(r.status));
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-PAID1' }));
    const realFinish = store.finishTransfer;
    store.finishTransfer = async () => { throw new Error('boom'); };
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-PAID2', transferAmount: 10000 });
    await send(p);
    store.finishTransfer = realFinish;
    await send(p);
    check('an extra transfer to a paid order that crashed is still late when it resumes', (await store.getTransferByDedupe('ref:FT-PAID2')).outcome === 'late' && (await balanceOf(u.id)) === 10000 && (await store.getOrder(o.id)).receivedVnd === 129000);
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const r = await send(payload({ code: o.code, content: `${o.code}\u0000 x`, gateway: 'MB\u0000Bank', referenceCode: 'FT-NUL', transferAmount: 129000 }));
    check('a NUL character in the content does not fail the insert', ok(r) && (await store.getTransferByDedupe('ref:FT-NUL'))?.outcome === 'applied', String(r.status));
    const spaced = await send(payload({ accountNumber: ' 0123456789 ', code: o.code, content: o.code, referenceCode: 'FT-SPACE', transferAmount: 1000 }));
    check('an account number with spaces round it is still ours', ok(spaced) && (await store.getTransferByDedupe('ref:FT-SPACE')).outcome === 'late');
    const accountWas = process.env.SEPAY_BANK_ACCOUNT;
    delete process.env.SEPAY_BANK_ACCOUNT;
    const nobank = await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-NOBANK' }));
    process.env.SEPAY_BANK_ACCOUNT = accountWas;
    check('without SEPAY_BANK_ACCOUNT the webhook is not ready (503), and nothing is recorded to bar a later poll', nobank.status === 503 && !(await store.getTransferByDedupe('ref:FT-NOBANK')));
    const warnedOther = await quiet(async () => { await send(payload({ accountNumber: '111', code: o.code, content: o.code, referenceCode: 'FT-WARN' })); });
    check('an incoming transfer to another account that names an order is ignored with a warning', (await store.getTransferByDedupe('ref:FT-WARN')).outcome === 'ignored' && warnedOther.some((l) => l.includes('SEPAY_BANK_ACCOUNT')));
  }
  {
    const seen = [];
    const fetchWas = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.host !== 'userapi.sepay.vn') return fetchWas(url, init);
      seen.push(1);
      return json({ data: [{ id: 'z1', transaction_date: '2026-11-13 12:00:00', account_number: '0123456789', transfer_type: 'out', amount_in: 0, amount_out: 5000, transaction_content: 'out', reference_number: 'FT-POLL-OUT', bank_brand_name: 'MB' }], meta: { pagination: { has_more: false } } });
    };
    sepay._resetSepayForTests();
    const took0 = await sepay.reconcile({ since: NOW, now: NOW.getTime() });
    check('a polled row with no money in is skipped without a record', took0 === 0 && seen.length === 1 && !(await store.getTransferByDedupe('ref:FT-POLL-OUT')));
    process.env.BILLING_MODE = 'off';
    sepay._resetSepayForTests();
    const off = await sepay.reconcile({ since: NOW, now: NOW.getTime() });
    delete process.env.BILLING_MODE;
    globalThis.fetch = fetchWas;
    check('with billing off reconcile asks nothing', off === 0 && seen.length === 1);
  }

  /* fix round 2 */
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-STALE' });
    const realCredit = store.creditTransfer;
    store.creditTransfer = async () => { throw new Error('boom'); };
    await send(p);
    store.creditTransfer = realCredit;
    // Run B has read the transfer as not credited when run A credits it, crashes at the finish, and the account goes.
    const realGetOrder = store.getOrder;
    const realFinish = store.finishTransfer;
    let armed = true;
    store.getOrder = async (id) => {
      if (armed) {
        armed = false;
        store.getOrder = realGetOrder;
        store.finishTransfer = async () => { throw new Error('crash of A at finish'); };
        await send(p);
        store.finishTransfer = realFinish;
        await store.deleteUser(u.id);
      }
      return realGetOrder(id);
    };
    const rb = await send(p);
    store.getOrder = realGetOrder;
    const t = await store.getTransferByDedupe('ref:FT-STALE');
    check('a transfer another run credited is never ended unmatched (it ends late, so an owner cannot assign it again)', ok(rb) && t.creditedAt instanceof Date && t.outcome === 'late', JSON.stringify([rb.status, t.outcome]));
  }
  {
    const u = await makeUser();
    await store.creditBalance(u.id, 50000, { kind: 'topup', topup: true });
    const o = await planOrder(u.id);
    const straight = await sepay.takeTransfer(payload({ code: o.code, content: o.code, referenceCode: 'FT-LAB1' }), { now: NOW });
    const v = await makeUser();
    await store.creditBalance(v.id, 50000, { kind: 'topup', topup: true });
    const o2 = await planOrder(v.id);
    const realCredit = store.creditTransfer;
    store.creditTransfer = async (...a) => { const x = await realCredit.apply(store, a); if (x != null) await new Promise((r) => setTimeout(r, 100)); return x; };
    const p = payload({ code: o2.code, content: o2.code, referenceCode: 'FT-LAB2' });
    const two = await Promise.all([sepay.takeTransfer(p, { now: NOW }), sepay.takeTransfer(p, { now: NOW })]);
    store.creditTransfer = realCredit;
    check('with a balance already there the label is the same whichever run finishes first', straight.outcome === 'over' && two.every((x) => x.outcome === 'over') && (await store.getTransferByDedupe('ref:FT-LAB2')).outcome === 'over', JSON.stringify([straight.outcome, two.map((x) => x.outcome)]));
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    process.env.SEPAY_API_TOKEN = 'tok-again';
    const accountWas = process.env.SEPAY_BANK_ACCOUNT;
    delete process.env.SEPAY_BANK_ACCOUNT;
    const asked = [];
    const fetchWas = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (new URL(String(url)).host !== 'userapi.sepay.vn') return fetchWas(url, init);
      asked.push(1);
      return json({ data: [{ id: 'u9', transaction_date: '2026-11-13 12:00:00', account_number: '0123456789', amount_in: 129000, transaction_content: o.code, reference_number: 'FT-POLLNOACCT', code: o.code, bank_brand_name: 'MB' }], meta: { pagination: { has_more: false } } });
    };
    sepay._resetSepayForTests();
    const took = await sepay.reconcile({ since: NOW, now: NOW.getTime() });
    const hook = await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-POLLNOACCT' }));
    process.env.SEPAY_BANK_ACCOUNT = accountWas;
    globalThis.fetch = fetchWas;
    const later = await send(payload({ code: o.code, content: o.code, referenceCode: 'FT-POLLNOACCT' }));
    check('without the account number the poll asks nothing and the webhook answers 503 (retryable), so nothing is barred by an ignored row', took === 0 && asked.length === 0 && hook.status === 503 && ok(later) && (await store.getTransferByDedupe('ref:FT-POLLNOACCT')).outcome === 'applied');
  }
  {
    const u = await makeUser();
    const o = (await orders.createOrder(u.id, { kind: 'topup', amountVnd: 100000 }, { now: NOW })).order;
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-TOPEXP', transferAmount: 100000 });
    const realMark = store.markTopupPaid;
    store.markTopupPaid = async () => { throw new Error('boom'); };
    await send(p);
    store.markTopupPaid = realMark;
    await store.expireOrders(hours(2));
    const r = await send(p, { now: hours(2) });
    const oo = await store.getOrder(o.id);
    check('a top-up whose order the sweeper expired before the retry still ends topup, with the order paid', ok(r) && (await store.getTransferByDedupe('ref:FT-TOPEXP')).outcome === 'topup' && oo.status === 'paid' && oo.receivedVnd === 100000 && (await balanceOf(u.id)) === 100000);
  }
  {
    const u = await makeUser();
    const o = await planOrder(u.id);
    const p = payload({ code: o.code, content: o.code, referenceCode: 'FT-SEQ' });
    const realFinish = store.finishTransfer;
    store.finishTransfer = async () => { throw new Error('boom'); };
    await send(p);
    store.finishTransfer = realFinish;
    const before = await seqNow();
    await send(p);
    check('a retry after the receipt was issued does not draw another receipt number', (await seqNow()) === before && (await store.listReceipts(u.id)).length === 1);
  }

  /* the secrets stay out of everything said */
  check('no answer carries the secret or the token', ![ra, rep, r500, r500b].some((a) => JSON.stringify(a).includes('whsec') || JSON.stringify(a).includes('api-token')));
  await prime();
}

globalThis.fetch = realFetch;
await db.close();
if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mall passed\x1b[0m');
process.exit(0);
