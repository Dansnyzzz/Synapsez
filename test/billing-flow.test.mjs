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

const NOW = new Date('2026-11-13T05:00:00Z');
const hours = (h) => new Date(NOW.getTime() + h * 3_600_000);
let n = 0;
const makeUser = async (role = 'user') => {
  n += 1;
  return store.createUser({ id: `bf${n}`, email: `bf${n}@example.test`, passwordHash: 'x', role });
};
const balanceOf = async (userId) => (await store.billingState(userId)).balanceVnd;
const caught = async (promise) => { try { await promise; return null; } catch (err) { return err; } };

section('the day\'s rate: erapi, then Vietcombank, then Frankfurter');
{
  await forget();
  allDown();
  erapiSays(25655.85);
  const a = await fx.usdVnd({ now: NOW });
  check('open.er-api answers first', a.rate === 25655.85 && a.source === 'erapi' && a.at === NOW.toISOString(), JSON.stringify(a));
  const before = asked.length;
  const b = await fx.usdVnd({ now: hours(0.5) });
  check('a second call within the hour asks nothing', asked.length === before && b.rate === 25655.85);
  check('  and the rate is kept in the billing_fx setting', (await store.getSetting('billing_fx'))?.rate === 25655.85);

  await forget();
  const kept = await fx.usdVnd({ now: hours(0.5) });
  check('a new instance reads the setting while it is fresh, asking nobody', kept.rate === 25655.85 && !asked.slice(before).length, JSON.stringify(asked.slice(before)));

  await forget();
  allDown();
  vcbSays(25400);
  frankSays(25500);
  const c = await fx.usdVnd({ now: hours(2) });
  check('erapi down: the Vietcombank transfer rate', c.rate === 25400 && c.source === 'vietcombank', JSON.stringify(c));

  await forget();
  allDown();
  frankSays(25500);
  const d = await fx.usdVnd({ now: hours(4) });
  check('both down: Frankfurter', d.rate === 25500 && d.source === 'frankfurter', JSON.stringify(d));

  await forget();
  allDown();
  await store.setSetting('billing_fx', { rate: 25111, source: 'erapi', at: hours(-47).toISOString() });
  const e = await fx.usdVnd({ now: NOW });
  check('all down, a 47-hour-old rate is still used', e.rate === 25111 && e.source === 'erapi', JSON.stringify(e));

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
const prime = async () => { await forget(); allDown(); erapiSays(25655.85); };
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
  check('month to year on the same plan is an upgrade', yr.kind === 'upgrade' && yr.priceVnd === 1463000 && yr.creditVnd === 64500 && yr.totalVnd === 1398500, JSON.stringify(yr));
  await store.saveSubscription(subRow(u.id, { plan: 'plus', period: 'year', paidVnd: 1463000, periodStart: new Date('2026-11-01T12:00:00Z'), periodEnd: new Date('2027-11-01T12:00:00Z') }));
  const back = await orders.quote(u.id, { plan: 'plus', period: 'month' }, { now: mid });
  check('year to month is later', back.kind === 'later' && back.totalVnd === 0, JSON.stringify(back));
  const bad = await caught(orders.quote(u.id, { plan: 'gold', period: 'month' }, { now: NOW }));
  check('a plan that does not exist is a 422', bad?.status === 422, String(bad));
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
  const b = await fx.usdVnd({ now: NOW });
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
  check('two first purchases at once: one is paid', [n1, n2].filter(async () => true).length === 2 && 500000 - (await balanceOf(none.id)) <= 385000 && (await store.listOrders({ userId: none.id })).filter((o) => o.status === 'paid').length === 1);
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

globalThis.fetch = realFetch;
await db.close();
if (failures) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32mall passed\x1b[0m');
process.exit(0);
