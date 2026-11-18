/**
 * Metering (spec B1, Task 6): searches, machine minutes and storage held before the call and kept or
 * given back after it, for billable accounts only (an administrator in preview holding a plan or a
 * balance). Real SQL on PGlite and a fake clock; no search engine, rate source or E2B is reached.
 *
 *   node test/billing-meter.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'billing-meter-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'billing-meter-test-session-secret';
process.env.DDG_MIN_INTERVAL_MS = '1';
process.env.EXA_API_KEY = 'exa-test-key';
process.env.E2B_API_KEY = 'e2b_test_key';
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'SEARCH_ORDER', 'FREE_TIER_ONLY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'FIRECRAWL_API_KEY', 'FREE_TIER_USER_MONTHLY_MIN', 'FREE_TIER_USER_MONTHLY_MAX']) delete process.env[name];

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const meter = await import('../server/billing/meter.js');
const { unitsForPages } = await import('../server/billing/plans.js');

const db = await PGlite.create();
const query = async (text, params = []) => (await db.query(text, params)).rows;
const store = await initStore({ driver: { query } });

// Fixed dates in the future: a counter lasts until its window's end and the database's own clock decides whether it is still there.
const T0 = new Date('2027-03-10T03:00:00Z');
const hours = (h) => new Date(T0.getTime() + h * 3_600_000);
const days = (d) => hours(d * 24);
let n = 0;
const makeUser = (role = 'admin') => {
  n += 1;
  return store.createUser({ id: `bm${n}`, email: `bm${n}@example.test`, passwordHash: 'x', role });
};
/** An account holding a plan from `start`, a year long so several months fall inside it. */
const withPlan = async (user, plan = 'plus', start = T0) => store.createSubscription({
  userId: user.id, plan, period: 'year', status: 'active', periodStart: start, periodEnd: new Date(start.getTime() + 365 * 86_400_000), paidVnd: 1000, anchorAt: start,
});
const withBalance = (user, vnd) => store.creditBalance(user.id, vnd, { kind: 'topup', topup: true });
const balanceOf = async (user) => (await store.billingState(user.id)).balanceVnd;
const counter = (bucket) => store.readCounter(bucket);
const usage = async (user, category) => { const r = (await query("SELECT COALESCE(SUM(units),0) AS u, COALESCE(SUM(delta_vnd),0) AS v FROM balance_entries WHERE user_id = $1 AND kind = 'usage' AND category = $2", [user.id, category]))[0]; return { u: Number(r.u), v: Number(r.v) }; };
const wouldOf = async (user, kind) => Number((await query("SELECT COALESCE(SUM(count),0) AS c FROM rate_limits WHERE bucket LIKE $1", [`bill:would:${user.id}:${kind}:%`]))[0].c);
const month = (start) => String(start.getTime());
/**
 * A free account with a balance is paid for by its free share first (owner, 2026-11-17). An older check that is about the
 * balance uses the share up, as the caller's own count would, rather than turning the ceilings off: the order is the point.
 */
const usedUpShare = async (user, now) => {
  const { searchBucket } = await import('../server/freeShares.js');
  const { bucket, ends } = searchBucket(user.id, now);
  await store.addToCounter(bucket, 1_000_000, ends);
};
const ever = async () => Number((await query("SELECT COUNT(*) AS c FROM rate_limits WHERE bucket LIKE 'bill:%'"))[0].c);

section('who is metered');
{
  const user = await makeUser('user');
  await withPlan(user);
  await withBalance(user, 50_000);
  const a = await meter.holdSearch(user.id, { service: 'search', now: T0 });
  const b = await meter.holdSandbox(user.id, 600, { now: T0 });
  check('a non-administrator holding a plan and a balance gets NOT_BILLED in preview', a === meter.NOT_BILLED && b === meter.NOT_BILLED && !a.billed && !a.paid);
  await a.settle(1);
  await a.release();
  check('  and nothing is written, nothing charged', (await ever()) === 0 && (await balanceOf(user)) === 50_000 && (await usage(user, 'search')).u === 0);
  const nobody = await makeUser();
  check('an administrator with no plan and no balance gets NOT_BILLED', (await meter.holdSearch(nobody.id, { service: 'search', now: T0 })) === meter.NOT_BILLED && (await ever()) === 0);
  check('no account at all, none either', (await meter.holdSearch(null, { service: 'search' })) === meter.NOT_BILLED && (await meter.holdSearch('nobody-here', { service: 'search' })) === meter.NOT_BILLED);
  check('the Hold of NOT_BILLED is the documented shape', meter.NOT_BILLED.source === null && meter.NOT_BILLED.refused === false && meter.NOT_BILLED.units === 0);
  process.env.BILLING_MODE = 'off';
  meter.forgetBillable();
  const admin = await makeUser();
  await withPlan(admin);
  check('with billing off, nobody is metered', (await meter.holdSearch(admin.id, { service: 'search', now: T0 })) === meter.NOT_BILLED);
  delete process.env.BILLING_MODE;
  meter.forgetBillable();
  process.env.BILLING_MODE = 'live';
  const anyone = await makeUser('user');
  await withBalance(anyone, 5000);
  await usedUpShare(anyone, T0);
  const live = await meter.holdSearch(anyone.id, { service: 'search', now: T0 });
  check('in live any account with a balance is held (the admin check is preview only)', live.billed && live.source === 'balance');
  delete process.env.BILLING_MODE;
  meter.forgetBillable();
}

section('searches: the month first, then the balance, then nothing (never refused in preview)');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const key = `bill:search:${admin.id}:${month(T0)}`;
  const first = await meter.holdSearch(admin.id, { service: 'search', now: hours(1) });
  check('Plus: a search is held from the included allowance', first.billed && first.source === 'included' && first.paid && !first.refused && first.units === 1);
  let last = first;
  for (let i = 1; i < 150; i += 1) last = await meter.holdSearch(admin.id, { service: 'search', now: hours(2) });
  check('all 150 of the month can be used in one day (no daily limit)', last.source === 'included' && (await counter(key)) === 150, String(await counter(key)));
  const over = await meter.holdSearch(admin.id, { service: 'search', now: hours(3) });
  check('the 151st, with no balance, is held from nothing: unpaid, not refused', over.billed && over.source === 'none' && over.paid === false && over.refused === false);
  check('  and a would-count says it would have been charged', (await wouldOf(admin, 'search')) === 1 && (await counter(key)) === 150);
  await over.settle(0);
  check('  settling it as unused takes the would-count back', (await wouldOf(admin, 'search')) === 0);

  await withBalance(admin, 800);
  meter.forgetBillable();
  const bal = await meter.holdSearch(admin.id, { service: 'search', now: hours(3) });
  check('with a balance, past the month, a search costs 400đ', bal.source === 'balance' && bal.paid && (await balanceOf(admin)) === 400 && (await counter(key)) === 150);
  const row = await usage(admin, 'search');
  check('  and is one usage row: 1 unit, 400đ', row.u === 1 && row.v === -400, JSON.stringify(row));
  await bal.settle(0);
  check('settle(0) gives the balance unit back: balance up, usage row down', (await balanceOf(admin)) === 800 && (await usage(admin, 'search')).u === 0 && (await usage(admin, 'search')).v === 0);
  await bal.settle(1);
  await bal.release();
  check('  a second settle does nothing', (await balanceOf(admin)) === 800);

  await first.settle(0);
  check('settle(0) gives an included unit back: the counter is down', (await counter(key)) === 149);
  await first.settle(0);
  check('  once only', (await counter(key)) === 149);
}

section('settling with more or fewer than was held');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const key = `bill:search:${admin.id}:${month(T0)}`;
  const crawl = await meter.holdSearch(admin.id, { service: 'search', now: hours(1) });
  await crawl.settle(unitsForPages(10));
  check('a crawl of 10 pages (held 1) settles as 4 units', unitsForPages(10) === 4 && (await counter(key)) === 4, String(await counter(key)));
  const two = await meter.holdSearch(admin.id, { service: 'search', units: 3, now: hours(1) });
  await two.settle(1);
  check('held 3, used 1: two come back', (await counter(key)) === 5, String(await counter(key)));

  // Past the month and out of balance an extra is unpaid in preview, and with a balance it is charged.
  const poor = await makeUser();
  await withBalance(poor, 1000);
  await usedUpShare(poor, hours(1));
  const held = await meter.holdSearch(poor.id, { service: 'search', now: hours(1) });
  await held.settle(3);
  check('no plan, 1000đ: held 1 (400đ), used 3: the extra 2 are one block from one source, 800đ does not fit the 600đ left, so both are unpaid', (await balanceOf(poor)) === 600 && (await wouldOf(poor, 'search')) === 2, `${await balanceOf(poor)} ${await wouldOf(poor, 'search')}`);
  await held.release();
}

section('a month rolls over on the plan\'s own day');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const early = await meter.holdSearch(admin.id, { service: 'search', units: 150, now: days(10) });
  const full = await meter.holdSearch(admin.id, { service: 'search', now: days(11) });
  check('the 150 used up, the next is not included', early.source === 'included' && full.source === 'none');
  const next = await meter.holdSearch(admin.id, { service: 'search', now: new Date('2027-04-10T03:00:01Z') });
  check('from the plan\'s own day (the 10th, 10:00 Vietnamese time) the allowance is new', next.source === 'included');
  const before = await meter.holdSearch(admin.id, { service: 'search', now: new Date('2027-04-10T02:59:59Z') });
  check('  and a second earlier it was not', before.source === 'none');
}

section('20 holds at once with 4,000đ and no plan: exactly 10 are paid');
{
  const admin = await makeUser();
  await withBalance(admin, 4000);
  await usedUpShare(admin, T0);
  const holds = await Promise.all(Array.from({ length: 20 }, () => meter.holdSearch(admin.id, { service: 'search', now: T0 })));
  check('10 from the balance', holds.filter((h) => h.source === 'balance').length === 10, holds.map((h) => h.source).join(','));
  check('  10 unpaid, none refused', holds.filter((h) => h.source === 'none' && !h.paid && !h.refused).length === 10);
  check('  the balance is 0, never below', (await balanceOf(admin)) === 0);
}

section('the prices follow the rate at the moment of the hold');
{
  const admin = await makeUser();
  await withBalance(admin, 10_000);
  await usedUpShare(admin, T0);
  await store.setSetting('billing_fx', { rate: 30_000, source: 'erapi', at: T0.toISOString() });
  (await import('../server/billing/fx.js'))._resetFxForTests();
  const { paygPrices } = await import('../server/billing/plans.js');
  const h = await meter.holdSearch(admin.id, { service: 'search', now: T0 });
  check('a search costs what paygPrices says at the known rate, not 400đ', h.source === 'balance' && (await balanceOf(admin)) === 10_000 - paygPrices(30_000).searchVnd && paygPrices(30_000).searchVnd !== 400, String(await balanceOf(admin)));
  await store.setSetting('billing_fx', null);
  (await import('../server/billing/fx.js'))._resetFxForTests();
}

section('the cloud computer: seconds from the plan, started minutes from the balance');
{
  const poor = await makeUser();
  await withBalance(poor, 10_000);
  const a = await meter.holdSandbox(poor.id, 59, { now: T0 });
  check('59 s from the balance is one started minute: 84đ', a.source === 'balance' && a.paid && a.units === 59 && (await balanceOf(poor)) === 9_916);
  const b = await meter.holdSandbox(poor.id, 2, { now: T0 });
  check('2 s more makes a second started minute: 84đ again', b.source === 'balance' && (await balanceOf(poor)) === 9_832);
  await b.release();
  check('release reverses exactly what was taken', (await balanceOf(poor)) === 9_916);
  await a.release();
  check('  both', (await balanceOf(poor)) === 10_000 && (await usage(poor, 'sandbox')).u === 0 && (await usage(poor, 'sandbox')).v === 0);
  await a.release();
  check('  and again does nothing', (await balanceOf(poor)) === 10_000);

  const split = await makeUser();
  await withBalance(split, 10_000);
  await meter.holdSandbox(split.id, 30, { now: T0 });
  await meter.holdSandbox(split.id, 30, { now: T0 });
  check('30 s and 30 s are 84đ in all', (await balanceOf(split)) === 9_916);

  const admin = await makeUser();
  await withPlan(admin, 'plus');
  await withBalance(admin, 1000);
  const incl = await meter.holdSandbox(admin.id, 240 * 60, { now: hours(1) });
  check('Plus: its 240 minutes are held from the plan, nothing charged', incl.source === 'included' && (await balanceOf(admin)) === 1000 && (await counter(`bill:sandbox:${admin.id}:${month(T0)}`)) === 14_400);
  const past = await meter.holdSandbox(admin.id, 90, { now: hours(2) });
  check('  past them, the balance pays: 2 started minutes = 168đ', past.source === 'balance' && (await balanceOf(admin)) === 832);
  await incl.release();
  check('  releasing the included window gives the seconds back', (await counter(`bill:sandbox:${admin.id}:${month(T0)}`)) === 0);

  const none = await makeUser();
  await withPlan(none, 'plus');
  const free = await meter.holdSandbox(none.id, 240 * 60 + 5, { now: hours(1) });
  check('with neither room nor balance, the window goes ahead unpaid with a would-count (preview never refuses)', free.source === 'none' && !free.paid && !free.refused && (await wouldOf(none, 'sandbox')) === 240 * 60 + 5);
  await free.release();
  check('  and release takes that back', (await wouldOf(none, 'sandbox')) === 0);
}

section('storage: a day past the plan\'s GB');
{
  const admin = await makeUser();
  const start = new Date('2027-06-01T00:00:00+07:00');
  await withPlan(admin, 'plus', start);
  await withBalance(admin, 1000);
  const real = store.storageBytesByUser;
  store.storageBytesByUser = async (ids) => new Map(ids.map((id) => [id, id === admin.id ? 3.25e9 : 0]));
  const out = await meter.chargeStorageDay({ now: new Date('2027-06-15T05:00:00Z') });
  check('3.25 GB on Plus (3 GB) in a 30-day month: 3 tenths over = ceil(300/30) = 10đ', out.charged === 1 && (await balanceOf(admin)) === 990, JSON.stringify(out));
  const twice = await meter.chargeStorageDay({ now: new Date('2027-06-15T06:00:00Z') });
  check('  the same day asked again charges nobody again (a claim per account and day)', twice.charged === 0 && (await balanceOf(admin)) === 990, JSON.stringify(twice));
  const row = await usage(admin, 'storage');
  check('  one usage row: 3 tenths, 10đ', row.u === 3 && row.v === -10, JSON.stringify(row));
  const broke = await makeUser();
  await withPlan(broke, 'plus', start);
  store.storageBytesByUser = async (ids) => new Map(ids.map((id) => [id, id === broke.id ? 3.25e9 : 0]));
  const again = await meter.chargeStorageDay({ now: new Date('2027-06-16T05:00:00Z') });
  check('  with no balance, it only counts a would', again.would === 1 && (await wouldOf(broke, 'storage')) === 3 && again.charged === 0, JSON.stringify(again));
  store.storageBytesByUser = async (ids) => new Map(ids.map((id) => [id, 2.9e9]));
  const under = await meter.chargeStorageDay({ now: new Date('2027-06-17T05:00:00Z') });
  check('  under the plan\'s GB nothing is charged', under.charged === 0 && under.would === 0);
  store.storageBytesByUser = real;
}

section('the storage room of a billable account');
{
  const { storageOf, assertRoom } = await import('../server/storageQuota.js');
  const admin = await makeUser();
  await withPlan(admin, 'pro', new Date('2027-06-01T00:00:00+07:00'));
  const user = await store.getUserById(admin.id);
  const room = await storageOf(user);
  check('a billable administrator holding Pro reports its 5 GB, not "no limit"', room.limitBytes === 5e9, JSON.stringify(room));
  check('  and is never refused (it is charged past them)', (await assertRoom(user, 9e9).then(() => true, () => false)) === true);
  const plain = await store.getUserById((await makeUser()).id);
  check('an administrator with nothing is unlimited as before', (await storageOf(plain)).limitBytes === null);
  const person = await makeUser('user');
  check('a non-administrator keeps the 0.5 GB', (await storageOf(await store.getUserById(person.id))).limitBytes === 500_000_000);
}

section('This period');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  await withBalance(admin, 5000);
  await meter.holdSearch(admin.id, { service: 'search', units: 150, now: hours(1) });
  await meter.holdSearch(admin.id, { service: 'search', units: 2, now: hours(2) });
  await meter.holdSandbox(admin.id, 30, { now: hours(2) });
  const p = await meter.periodUsage(admin.id, { now: hours(5) });
  check('plan, month window and finance flag', p.plan === 'plus' && +p.month.start === +T0 && +p.month.end === +new Date('2027-04-10T03:00:00Z') && p.finance.free === true, JSON.stringify(p.month));
  check('search: included 150, used 150, 2 paid units for 800đ', p.search.included === 150 && p.search.used === 150 && p.search.paidUnits === 2 && p.search.paidVnd === 800, JSON.stringify(p.search));
  check('sandbox: 240 min included, 30 s of them used, nothing paid', p.sandbox.includedSeconds === 14_400 && p.sandbox.usedSeconds === 30 && p.sandbox.paidMinutes === 0, JSON.stringify(p.sandbox));
  check('storage and would are present', p.storage.includedGb === 3 && p.storage.paidVnd === 0 && p.would.search === 0 && p.would.sandbox === 0 && p.would.storage === 0, JSON.stringify([p.storage, p.would]));
}

section('every plan gets at least the free share (owner, 2026-11-17)');
{
  const shares = await import('../server/freeShares.js');
  const { countMetered, e2bAccountAllowance, e2bAccountSpend } = await import('../server/freeTier.js');
  const { paygPrices } = await import('../server/billing/plans.js');
  const { meteringRate } = await import('../server/billing/fx.js');
  // The 1st of the month: a share worked out for the days left is the whole one, so the figures below stay exact.
  const FIRST = new Date('2027-03-01T03:00:00Z');
  const at = (h) => new Date(FIRST.getTime() + h * 3_600_000);
  /** Fix this month's share: a capacity far above any key's, so it is never worked out again. */
  const pin = async (searches, machineMills) => {
    await store.setSetting('free_shares:2027-03', { month: '2027-03', searches, machineMills, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: FIRST.toISOString() });
    shares.__testing.forget();
  };
  const price = paygPrices(await meteringRate()).searchVnd;
  const perMinute = paygPrices(await meteringRate()).sandboxVndPerMinute;
  const S = 4;
  await pin(S, 25);
  const share = (await shares.searchShareOf('probe', FIRST)).share;
  check('the pinned share is what the meter will read', share === S, String(share));

  // Free with a balance: the share first, as the caller counts it, then the balance.
  const free = await makeUser();
  await withBalance(free, 10_000);
  const sources = [];
  for (let i = 0; i < S; i += 1) {
    const h = await meter.holdSearch(free.id, { service: 'search', now: at(1) });
    sources.push(h.source === 'share' && h.billed && !h.paid && !h.refused);
    await h.settle(1);
  }
  check('Free with a balance: the first S searches are share holds (billed, paid false: free keys only)', sources.every(Boolean), JSON.stringify(sources));
  check('  the balance does not move and no usage row is written', (await balanceOf(free)) === 10_000 && (await usage(free, 'search')).u === 0);
  check('  settling each counted it against the share, once', (await counter(shares.searchBucket(free.id, at(1)).bucket)) === S);
  const past = await meter.holdSearch(free.id, { service: 'search', now: at(1) });
  check('  the next one is billed from the balance, paid, at the pay-as-you-go price', past.billed && past.source === 'balance' && past.paid === true && (await balanceOf(free)) === 10_000 - price, `${past.source} ${await balanceOf(free)}`);

  // A balance-sourced hold that settles with more never draws on the share.
  const grow = await makeUser();
  await withBalance(grow, 10_000);
  for (let i = 0; i < S; i += 1) await countMetered(grow.id, at(1));
  const held = await meter.holdSearch(grow.id, { service: 'search', now: at(1) });
  await pin(100, 25);
  await held.settle(3);
  check('settle(more) on a billed hold: all 3 units are charged, none taken from a share that has room', held.source === 'balance' && (await usage(grow, 'search')).u === 3 && (await balanceOf(grow)) === 10_000 - 3 * price, `${(await usage(grow, 'search')).u} ${await balanceOf(grow)}`);
  await pin(S, 25);

  // Plus, share no larger than its own 150: the plan's month, then the balance, never the share.
  const plus = await makeUser();
  await withPlan(plus, 'plus', FIRST);
  await withBalance(plus, 10_000);
  const incl = await meter.holdSearch(plus.id, { service: 'search', units: 150, now: at(1) });
  check('Plus with S <= 150: the included month comes first, paid', incl.billed && incl.source === 'included' && incl.paid === true);
  const after = [];
  for (let i = 0; i < 3; i += 1) after.push(await meter.holdSearch(plus.id, { service: 'search', now: at(2) }));
  check('  after it, the balance is charged and NOT_BILLED never appears', after.every((h) => h.billed && h.source === 'balance' && h.paid) && (await balanceOf(plus)) === 10_000 - 3 * price);

  // Plus, share larger than its own 150: S - 150 more are free, then the balance.
  await pin(153, 25);
  const big = await makeUser();
  await withPlan(big, 'plus', FIRST);
  await withBalance(big, 10_000);
  const first = await meter.holdSearch(big.id, { service: 'search', units: 150, now: at(1) });
  const free3 = [];
  for (let i = 0; i < 3; i += 1) {
    const h = await meter.holdSearch(big.id, { service: 'search', now: at(2) });
    free3.push(h);
    await h.settle(1);
  }
  check('Plus with S = 153: 150 included, then S - 150 = 3 share holds', first.source === 'included' && free3.every((h) => h.source === 'share') && (await balanceOf(big)) === 10_000, JSON.stringify(free3.map((h) => h.source)));
  const then = await meter.holdSearch(big.id, { service: 'search', now: at(2) });
  check('  then the balance', then.billed && then.source === 'balance' && (await balanceOf(big)) === 10_000 - price);
  check('  paid is true on the included and balance holds, false on each share one', first.paid === true && then.paid === true && free3.every((h) => h.paid === false && h.billed === true));
  await pin(S, 25);

  // With the ceilings lifted there is no share: a Free account with a balance is charged from the first search.
  process.env.FREE_TIER_ONLY = 'false';
  const lifted = await makeUser();
  await withBalance(lifted, 10_000);
  const h = await meter.holdSearch(lifted.id, { service: 'search', now: at(1) });
  check('FREE_TIER_ONLY=false: charged from the first search, as before', h.billed && h.source === 'balance' && (await balanceOf(lifted)) === 10_000 - price);
  delete process.env.FREE_TIER_ONLY;

  // The computer: Free with a balance.
  const cost = 10;
  const box = await makeUser();
  await withBalance(box, 10_000);
  const w1 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('computer, Free with a balance: a window the share can pay is a share hold (billed, paid false), nothing charged', w1.source === 'share' && w1.billed && !w1.paid && (await balanceOf(box)) === 10_000);
  await w1.settle(1);
  await w1.release();
  check('  its settle and release count nothing: payUntil spends the share', (await e2bAccountAllowance(box.id, at(1))).left === 25);
  await e2bAccountSpend(box.id, cost, at(1));
  const w2 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('  the second also (15 left of 25)', w2.source === 'share' && (await e2bAccountAllowance(box.id, at(1))).left === 15);
  await e2bAccountSpend(box.id, cost, at(1));
  const w3 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('  with 5 left it takes from the balance, 10 started minutes', w3.billed && w3.source === 'balance' && w3.paid === true && (await balanceOf(box)) === 10_000 - 10 * perMinute, `${w3.source} ${await balanceOf(box)}`);
  const bare = await makeUser();
  await withBalance(bare, 10_000);
  const w4 = await meter.holdSandbox(bare.id, 600, { now: at(1) });
  check('  with shareCost omitted the share is skipped and the balance pays', w4.billed && w4.source === 'balance' && (await balanceOf(bare)) === 10_000 - 10 * perMinute);

  // With the ceilings lifted the machine has no share either.
  process.env.FREE_TIER_ONLY = 'false';
  const liftedBox = await makeUser();
  await withBalance(liftedBox, 10_000);
  const wl = await meter.holdSandbox(liftedBox.id, 600, { now: at(1), shareCost: cost });
  check('FREE_TIER_ONLY=false: a window is charged to the balance, no share step', wl.billed && wl.source === 'balance' && (await balanceOf(liftedBox)) === 10_000 - 10 * perMinute);
  delete process.env.FREE_TIER_ONLY;
  const nothing = await meter.holdSandbox(liftedBox.id, 60, { now: at(1), shareCost: 0 });
  check('a window that costs the share nothing takes no share step: the balance pays', nothing.billed && nothing.source === 'balance');

  // The computer, a paid plan: its hours, then the share beyond them, then the balance.
  await pin(S, 552);
  const plusBox = await makeUser();
  await withPlan(plusBox, 'plus', FIRST);
  await withBalance(plusBox, 10_000);
  const inc = await meter.holdSandbox(plusBox.id, 240 * 60, { now: at(1), shareCost: cost });
  const s1 = await meter.holdSandbox(plusBox.id, 600, { now: at(2), shareCost: cost });
  await e2bAccountSpend(plusBox.id, cost, at(2));
  const s2 = await meter.holdSandbox(plusBox.id, 600, { now: at(2), shareCost: cost });
  await e2bAccountSpend(plusBox.id, cost, at(2));
  const b1 = await meter.holdSandbox(plusBox.id, 600, { now: at(2), shareCost: cost });
  check('computer, Plus: 240 minutes included (paid), then 552 - 532 = 20 mills of share (two windows of 10), then the balance',
    inc.source === 'included' && inc.paid && s1.source === 'share' && s2.source === 'share' && b1.source === 'balance' && b1.paid && (await balanceOf(plusBox)) === 10_000 - 10 * perMinute,
    `${inc.source} ${b1.source} ${await balanceOf(plusBox)}`);
  await pin(S, 25);
}

section('the share is only for free capacity that exists, and it counts what it pays for (fix round 1)');
{
  const shares = await import('../server/freeShares.js');
  const tiers = await import('../server/freeTier.js');
  const { paygPrices } = await import('../server/billing/plans.js');
  const { meteringRate } = await import('../server/billing/fx.js');
  const FIRST = new Date('2027-03-01T03:00:00Z');
  const at = (h) => new Date(FIRST.getTime() + h * 3_600_000);
  const pin = async (searches, machineMills) => {
    await store.setSetting('free_shares:2027-03', { month: '2027-03', searches, machineMills, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: FIRST.toISOString() });
    shares.__testing.forget();
  };
  const price = paygPrices(await meteringRate()).searchVnd;
  const shareCount = async (user) => counter(shares.searchBucket(user.id, at(1)).bucket);
  await pin(100, 25);

  // What a share hold keeps: one unit against the share, the rest on the balance.
  const four = await makeUser();
  await withBalance(four, 10_000);
  const h4 = await meter.holdSearch(four.id, { service: 'search', now: at(1) });
  await h4.settle(4);
  check('a share hold settled with 4: 1 counted against the share, 3 charged to the balance', h4.source === 'share' && (await shareCount(four)) === 1 && (await usage(four, 'search')).u === 3 && (await balanceOf(four)) === 10_000 - 3 * price, `${await shareCount(four)} ${(await usage(four, 'search')).u} ${await balanceOf(four)}`);
  const none = await makeUser();
  await withBalance(none, 10_000);
  const h0 = await meter.holdSearch(none.id, { service: 'search', now: at(1) });
  await h0.settle(0);
  const hr = await meter.holdSearch(none.id, { service: 'search', now: at(1) });
  await hr.release();
  await hr.settle(1);
  check('  settle(0) and release() count nothing, and a settle after a release is nothing', (await shareCount(none)) === 0 && (await balanceOf(none)) === 10_000 && (await usage(none, 'search')).u === 0);
  check('  a share hold is frozen', Object.isFrozen(h4));

  // The free keys must have room for the share to be used.
  const drySearch = async (service) => {
    const user = await makeUser();
    await withBalance(user, 10_000);
    meter.forgetFreePools();
    return { user, hold: await meter.holdSearch(user.id, { now: at(1), service }) };
  };
  const wet = await drySearch('exa');
  check('with Exa free room, a read asking for the Exa pool is a share hold', wet.hold.source === 'share');
  await tiers.exhaust('exa', at(1));
  const dryExa = await drySearch('exa');
  check('Exa used up: the read is charged to the balance, paid, so the paid key may serve it', dryExa.hold.source === 'balance' && dryExa.hold.paid === true && (await balanceOf(dryExa.user)) === 10_000 - price);
  const drySearchHold = await drySearch('search');
  check('  the pooled search engines used up: a search is charged too', drySearchHold.hold.source === 'balance' && drySearchHold.hold.paid === true);
  const noService = await drySearch(undefined).then(() => null, (err) => err);
  check('  a hold that names no service throws here (in production it takes no share), and share: false needs none', /needs a service/.test(String(noService?.message)) && (await meter.holdSearch((await makeUser()).id, { now: at(1), share: false })) === meter.NOT_BILLED);
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:exa%'");
  meter.forgetFreePools();

  // The computer needs E2B's free month to hold the window too.
  const box = await makeUser();
  await withBalance(box, 10_000);
  await tiers.exhaust('e2b', at(1));
  const spentBox = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: 10 });
  check('E2B used up: a window the share has room for is charged to the balance', spentBox.billed && spentBox.source === 'balance' && spentBox.paid === true);
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:e2b%' AND bucket NOT LIKE '%:user:%'");

  // A share that cannot be read is no share.
  const real = store.readCounters;
  const lines = [];
  const warnWas = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  const sick = await makeUser();
  await withBalance(sick, 10_000);
  store.readCounters = async () => { throw new Error('store is down'); };
  let sickHold;
  let sickBox;
  try {
    sickHold = await meter.holdSearch(sick.id, { service: 'search', now: at(1) });
    sickBox = await meter.holdSandbox(sick.id, 600, { now: at(1), shareCost: 10 });
  } finally {
    store.readCounters = real;
    console.warn = warnWas;
  }
  check('a count that cannot be read: the search and the window are charged to the balance', sickHold.source === 'balance' && sickBox.source === 'balance');
  check('  one warning says so and names no account', lines.some((l) => /could not be read/.test(l)) && !lines.some((l) => l.includes(sick.id)), lines.join(' | '));

  // The day a paid account first uses its month is the day it joined: a later share is not worked out for the days left.
  await pin(153, 25);
  const plus = await makeUser();
  await withPlan(plus, 'plus', FIRST);
  await withBalance(plus, 10_000);
  await meter.holdSearch(plus.id, { service: 'search', units: 150, now: at(1) });
  const tenth = new Date('2027-03-10T04:00:00Z');
  const kept = [];
  for (let i = 0; i < 3; i += 1) {
    const h = await meter.holdSearch(plus.id, { service: 'search', now: tenth });
    kept.push(h.source);
    await h.settle(1);
  }
  const after = await meter.holdSearch(plus.id, { service: 'search', now: tenth });
  check('Plus using its month from the 1st, reaching the share on the 10th: the whole S - 150 is there, not a prorated one', kept.every((s) => s === 'share') && after.source === 'balance', `${kept.join(',')} then ${after.source}`);
  const plusBox = await makeUser();
  await withPlan(plusBox, 'plus', FIRST);
  await meter.holdSandbox(plusBox.id, 600, { now: at(1) });
  const arrival = await counter(`free:arrive:machine:2027-03:user:${plusBox.id}`);
  check('  a window of the plan\'s own hours writes no arrival: only an account that reaches the share pays that write', arrival === 0, String(arrival));
  await pin(4, 25);
}

section('a plan that began mid-month gets the whole share when it reaches it (fix round, A3)');
{
  const shares = await import('../server/freeShares.js');
  const MONTH = new Date('2027-03-01T03:00:00Z');
  const tenth = new Date('2027-03-10T04:00:00Z');
  const twentieth = new Date('2027-03-20T04:00:00Z');
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 300, machineMills: 2000, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: MONTH.toISOString() });
  shares.__testing.forget();
  meter.forgetFreePools();
  const mid = await makeUser();
  await withPlan(mid, 'plus', new Date('2027-03-10T03:00:00Z'));
  await withBalance(mid, 10_000);
  await meter.holdSearch(mid.id, { service: 'search', units: 150, now: tenth });
  const first = await meter.holdSearch(mid.id, { service: 'search', now: twentieth });
  await first.settle(1);
  const got = await shares.searchShareOf(mid.id, twentieth);
  check('Plus anchored on the 10th, its 150 used, reaching the share on the 20th: the whole 300, not 22/31 of it', first.source === 'share' && got.share === 300 && got.joinedOn === null, JSON.stringify([first.source, got]));
  await meter.holdSandbox(mid.id, 240 * 60, { now: tenth });
  const window = await meter.holdSandbox(mid.id, 600, { now: twentieth, shareCost: 10 });
  const machine = await shares.machineShareOf(mid.id, twentieth);
  check('  and the computer the same: the whole 2000 mills', window.source === 'share' && machine.share === 2000 && machine.joinedOn === null, JSON.stringify([window.source, machine]));
  check('  the arrival is written once, as day 1, and not again by a later share count', (await counter(`free:arrive:search:2027-03:user:${mid.id}`)) === 1);

  // An account whose plan is at least as large as the whole share reads none of its own counters: its room is provably 0.
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 100, machineMills: 25, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: MONTH.toISOString() });
  shares.__testing.forget();
  const big = await makeUser();
  await withPlan(big, 'plus', MONTH);
  await withBalance(big, 10_000);
  await meter.holdSearch(big.id, { service: 'search', units: 150, now: tenth });
  await meter.holdSandbox(big.id, 240 * 60, { now: tenth });
  const real = store.readCounters;
  const reads = [];
  store.readCounters = async (names) => { reads.push(...names); return real.call(store, names); };
  let past;
  let box;
  try {
    past = await meter.holdSearch(big.id, { service: 'search', now: twentieth });
    box = await meter.holdSandbox(big.id, 600, { now: twentieth, shareCost: 10 });
  } finally {
    store.readCounters = real;
  }
  check('Plus with S <= its plan: past the plan the balance pays, and none of its share counters is read', past.source === 'balance' && box.source === 'balance' && !reads.some((name) => name.includes(`:user:${big.id}`) || name.includes(`user:${big.id}:`)), reads.join(' '));
}

section('the Usage card of a paid account shows what the meter allows (fix round, B)');
{
  const shares = await import('../server/freeShares.js');
  const MONTH = new Date('2027-03-01T03:00:00Z');
  const twentieth = new Date('2027-03-20T04:00:00Z');
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 400, machineMills: 2000, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: MONTH.toISOString() });
  shares.__testing.forget();
  meter.forgetFreePools();
  const plus = await makeUser();
  await withPlan(plus, 'plus', MONTH);
  await withBalance(plus, 10_000);
  // 150 of its own month, 250 from the share: 400 in all, and the share beyond the plan was S - P = 250.
  await meter.holdSearch(plus.id, { service: 'search', units: 150, now: twentieth });
  await meter.holdSandbox(plus.id, 6000, { now: twentieth });
  const { bucket, ends } = shares.searchBucket(plus.id, twentieth);
  await store.addToCounter(bucket, 250, ends);
  const mach = shares.machineBucket(plus.id, twentieth);
  await store.addToCounter(mach.bucket, 100, mach.ends);
  const raw = await shares.accountShares(plus.id, twentieth);
  const card = await meter.usageShare(plus, { now: twentieth });
  check('the base card says 250 of 400, which is what the review found misleading', raw.searches.used === 250 && raw.searches.share === 400, JSON.stringify(raw.searches));
  check('a Plus account with S = 400 that used 150 included and 250 from the share sees 400 of 400', card.withPlan === true && card.billable === true && card.searches.used === 400 && card.searches.share === 400, JSON.stringify(card.searches));
  check('  and its next search is charged', (await meter.holdSearch(plus.id, { service: 'search', now: twentieth })).source === 'balance');
  check('  the computer the same: its plan\'s 6000 s (222 mills) and the 100 of the share, of the larger 2000', card.machine.usedMills === 322 && card.machine.shareMills === 2000, JSON.stringify(card.machine));
  const small = await makeUser();
  await withPlan(small, 'pro', MONTH);
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 100, machineMills: 25, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: MONTH.toISOString() });
  shares.__testing.forget();
  const pro = await meter.usageShare(small, { now: twentieth });
  check('a plan larger than the share is the allowance: Pro shows 0 of 250', pro.withPlan && pro.searches.share === 250 && pro.searches.used === 0 && pro.machine.shareMills === 798, JSON.stringify([pro.searches, pro.machine]));
  const free = await makeUser();
  await withBalance(free, 10_000);
  const freeCard = await meter.usageShare(free, { now: twentieth });
  check('a Free account with a balance keeps its card (the share) and is told it is billable', freeCard.billable === true && freeCard.withPlan === false && freeCard.searches.share === 100 && freeCard.searches.used === 0, JSON.stringify([freeCard.searches, freeCard.billable, freeCard.withPlan]));
  const member = await makeUser('user');
  const plain = await meter.usageShare(member, { now: twentieth });
  check('an account that is not billable is unchanged', plain.billable === undefined && plain.withPlan === undefined && plain.searches.share === 100, JSON.stringify([plain.billable, plain.searches]));
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 4, machineMills: 25, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: MONTH.toISOString() });
  shares.__testing.forget();
}

section('the free-pool memo (fix round, A2)');
{
  const shares = await import('../server/freeShares.js');
  const tiers = await import('../server/freeTier.js');
  const pool = await import('../server/keyPool.js');
  const AT = new Date('2027-03-02T03:00:00Z');
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 50, machineMills: 100, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: AT.toISOString() });
  shares.__testing.forget();
  const fresh = async () => {
    const user = await makeUser();
    await withBalance(user, 10_000);
    return user;
  };
  // A key added or taken away moves the keys' version, and the figure is asked again at once.
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:exa%'");
  meter.forgetFreePools();
  await tiers.exhaust('exa', AT);
  const dry = await meter.holdSearch((await fresh()).id, { service: 'exa', now: AT });
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:exa%'");
  const stale = await meter.holdSearch((await fresh()).id, { service: 'exa', now: AT });
  await pool.bumpKeysVersion();
  const seen = await meter.holdSearch((await fresh()).id, { service: 'exa', now: AT });
  check('a dry figure is kept for a minute, but not past a change of the keys', dry.source === 'balance' && stale.source === 'balance' && seen.source === 'share', `${dry.source} ${stale.source} ${seen.source}`);

  // A count that failed says nothing: a billed engine's 0 from an error is not "dry", and is not kept.
  process.env.BRAVE_API_KEY = 'brave-test-key';
  process.env.SEARCH_ORDER = 'brave,duckduckgo';
  await pool.warmPools();
  meter.forgetFreePools();
  const real = store.readCounters;
  store.readCounters = async () => { throw new Error('store is down'); };
  let during;
  try {
    during = await meter.holdSearch((await fresh()).id, { service: 'search', now: AT });
  } finally {
    store.readCounters = real;
  }
  const after = await meter.holdSearch((await fresh()).id, { service: 'search', now: AT });
  check('an allowance that could not be read is charged at the time, and not remembered as dry', during.source === 'balance' && after.source === 'share', `${during.source} ${after.source}`);
  delete process.env.BRAVE_API_KEY;
  delete process.env.SEARCH_ORDER;
  await pool.warmPools();
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:exa%'");
  meter.forgetFreePools();
  await store.setSetting('free_shares:2027-03', { month: '2027-03', searches: 4, machineMills: 25, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: AT.toISOString() });
  shares.__testing.forget();
}

/* ── search and the tools ───────────────────────────────────────────── */
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ddgPage = (k) => Array.from({ length: k }, (_, i) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`https://example.com/${i}`)}">Result ${i}</a><a class="result__snippet">Snippet ${i}</a>`).join('');
let asked = [];
const web = (exa) => {
  asked = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    asked.push(url);
    if (url.includes('api.exa.ai')) return exa();
    if (url.includes('duckduckgo')) return new Response(ddgPage(3), { status: 200, headers: { 'Content-Type': 'text/html' } });
    throw new Error(`nothing stubbed for ${url}`);
  };
};
const exaAnswers = () => json({ results: [{ title: 'T', url: 'https://example.com/t', highlights: ['a'] }] });
const search = await import('../server/search.js');
const pool = await import('../server/keyPool.js');
/** An engine a section made fail is cooled; put it back so the next section starts with Exa. */
const heal = async () => { search.clearEngineTrouble(); await pool.markKey('exa', 'env', 'ok'); };
const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');

section('search(): metered, and billed');
{
  search.clearSearchCache();
  await heal();
  web(exaAnswers);
  const a = await search.search('metered one', { userId: 'x' });
  check('an Exa answer is metered', a.metered === true && a.engine === 'Exa');
  const again = await search.search('metered one', { userId: 'x' });
  check('the same query again is a cache hit: not metered', again.metered === false && again.results.length === 1);
  web(() => json({}, 500));
  const free = await search.search('free one', { userId: 'x' });
  check('a DuckDuckGo-only answer is not metered', free.metered === false && /DuckDuckGo/.test(free.engine), free.engine);
  const none = await search.search('nothing here', { userId: 'x', count: 3 }).catch(() => null);
  check('a result is never missing the field', none === null || typeof none.metered === 'boolean');

  // billed: skips the account's free share (countMetered), as the hold already paid for it
  search.clearSearchCache();
  await heal();
  web(exaAnswers);
  await search.search('unbilled share', { userId: 'share-user' });
  const unbilled = Number((await query("SELECT COALESCE(SUM(count),0) AS c FROM rate_limits WHERE bucket LIKE 'free:user:share-user:%'"))[0].c);
  search.clearSearchCache();
  await heal();
  web(exaAnswers);
  await search.search('billed share', { userId: 'share-user-b', billed: true });
  const billed = Number((await query("SELECT COALESCE(SUM(count),0) AS c FROM rate_limits WHERE bucket LIKE 'free:user:share-user-b:%'"))[0].c);
  check('an unbilled metered search counts against the free share; a billed one does not', unbilled === 1 && billed === 0, `${unbilled} / ${billed}`);
}

section('web_search holds a unit and settles what really ran');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const key = `bill:search:${admin.id}:${month(T0)}`;
  const run = (q) => CLOUD_IMPLEMENTATIONS.web_search({ query: q, depth: 'quick' }, { userId: admin.id });
  // The tools hold at the real time; give this account a plan that is in force now.
  await query('UPDATE subscriptions SET period_start = $2, period_end = $3, anchor_at = $2 WHERE user_id = $1', [admin.id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 300 * 86_400_000)]);
  const real = (await meter.periodUsage(admin.id)).month;
  const live = `bill:search:${admin.id}:${month(real.start)}`;
  search.clearSearchCache();
  await heal();
  web(exaAnswers);
  await run('billed query');
  check('a metered answer keeps its unit', (await counter(live)) === 1, String(await counter(live)));
  await run('billed query');
  check('the same query again (cache) costs nothing', (await counter(live)) === 1);
  web(() => json({}, 500));
  await run('free engines only');
  check('a DuckDuckGo-only answer gives its unit back', (await counter(live)) === 1);
  check('(the earlier month\'s counter is untouched)', (await counter(key)) === 0);
}

section('a billable account\'s cloud computer window is held and given back');
{
  const named = (name, message, extra = {}) => Object.assign(new Error(message), { name }, extra);
  const state = { boxes: new Map(), next: 1, createError: null };
  class Sandbox {
    constructor(id, metadata) {
      this.sandboxId = id;
      this.metadata = metadata;
      this.commands = { run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
      this.files = { write: async () => {}, read: async () => new Uint8Array(), getInfo: async () => ({ size: 0 }) };
    }
    getHost(port) { return `${port}-${this.sandboxId}.e2b.app`; }
    async setTimeout() {}
    async getInfo() { return { cpuCount: 2, memoryMB: 1024 }; }
    async pause() {}
    async kill() { state.boxes.delete(this.sandboxId); }
    static async kill(id) { state.boxes.delete(id); }
    static async create(_template, opts) {
      if (state.createError) throw state.createError;
      const box = new Sandbox(`sbx${state.next++}`, opts.metadata);
      state.boxes.set(box.sandboxId, box);
      return box;
    }
    static async connect(id) {
      const box = state.boxes.get(id);
      if (!box) throw named('SandboxNotFoundError', `404: sandbox ${id} not found`, { statusCode: 404 });
      return box;
    }
    static list() { return { hasNext: false, nextItems: async () => [] }; }
  }
  const e2b = await import('../server/e2b.js');
  e2b.__testing.useSdk({ Sandbox });
  const admin = await makeUser();
  const now = new Date();
  await store.createSubscription({ userId: admin.id, plan: 'plus', period: 'year', status: 'active', periodStart: new Date(now.getTime() - 3_600_000), periodEnd: new Date(now.getTime() + 300 * 86_400_000), paidVnd: 1, anchorAt: new Date(now.getTime() - 3_600_000) });
  const live = (await meter.periodUsage(admin.id)).month;
  const bucket = `bill:sandbox:${admin.id}:${month(live.start)}`;
  state.createError = named('Error', 'all busy');
  await e2b.e2bMachineFor(admin.id, 'eph-bm').then(() => null, (e) => e);
  check('a start that fails gives its window back to the plan', (await counter(bucket)) === 0, String(await counter(bucket)));
  state.createError = null;
  await e2b.e2bMachineFor(admin.id, 'eph-bm');
  check('a machine that starts keeps its window: 4 minutes of the plan', (await counter(bucket)) === 240, String(await counter(bucket)));
  const other = await makeUser('user');
  await e2b.e2bMachineFor(other.id, 'eph-other');
  check('an account that is not billable writes no billing counter', Number((await query("SELECT COUNT(*) AS c FROM rate_limits WHERE bucket LIKE $1", [`bill:%:${other.id}:%`]))[0].c) === 0);
  check('a billed window is not also drawn from a free share', Number((await query("SELECT COALESCE(SUM(count),0) AS c FROM rate_limits WHERE bucket LIKE $1", ['free:e2b:%:user:' + admin.id]))[0].c) === 0);
  const pool = async () => Number((await query("SELECT COALESCE(SUM(count),0) AS c FROM rate_limits WHERE bucket LIKE 'free:e2b:%' AND bucket NOT LIKE '%:user:%'"))[0].c);
  const poolBefore = await pool();
  const heldBefore = await counter(bucket);
  state.createError = named('Error', 'all busy');
  const failed = await e2b.e2bScratch({ userId: admin.id, ms: 120_000 }).then(() => null, (e) => e);
  check('a scratch machine that fails to start gives back its hold and the credit', failed && (await counter(bucket)) === heldBefore && (await pool()) === poolBefore, `${await counter(bucket)} vs ${heldBefore}, pool ${await pool()} vs ${poolBefore}`);
  state.createError = null;
  const scratch = await e2b.e2bScratch({ userId: admin.id, ms: 120_000 });
  check('  and one that starts keeps its 2 minutes', typeof scratch.runCommand === 'function' && (await counter(bucket)) === heldBefore + 120);
  e2b.__testing.useSdk(null);
}

/** An administrator whose plan is in force at the real time (the tools hold at `new Date()`), and its month's counter names. */
const liveAdmin = async (plan = 'plus') => {
  const admin = await makeUser();
  const at = Date.now();
  await store.createSubscription({ userId: admin.id, plan, period: 'year', status: 'active', periodStart: new Date(at - 3_600_000), periodEnd: new Date(at + 300 * 86_400_000), paidVnd: 1, anchorAt: new Date(at - 3_600_000) });
  const key = month((await meter.periodUsage(admin.id)).month.start);
  return { admin, search: `bill:search:${admin.id}:${key}`, sandbox: `bill:sandbox:${admin.id}:${key}` };
};
const http = await import('node:http');
const refuser = http.createServer((_req, res) => { res.statusCode = 403; res.end('no'); });
await new Promise((resolve) => refuser.listen(0, '127.0.0.1', resolve));
const refusedUrl = `http://127.0.0.1:${refuser.address().port}/paper`;
process.env.ALLOW_PRIVATE_FETCH = 'true';
const stubWeb = (extra = {}) => {
  asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    asked.push(url);
    for (const [fragment, respond] of Object.entries(extra)) if (url.includes(fragment)) return respond(init);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (url.includes('api.exa.ai/contents')) return json({ results: [{ title: 'P', url: refusedUrl, text: 'Exa read this page in full. '.repeat(20) }] });
    if (url.includes('api.exa.ai')) return json({ results: [{ title: 'P', url: refusedUrl, highlights: ['a'] }] });
    if (url.includes('duckduckgo')) return new Response(ddgPage(3), { status: 200, headers: { 'Content-Type': 'text/html' } });
    throw new Error(`nothing stubbed for ${url}`);
  };
};

section('a web_search that reads its pages through Exa is still one unit');
{
  const { admin, search: bucket } = await liveAdmin();
  search.clearSearchCache();
  await heal();
  stubWeb();
  await CLOUD_IMPLEMENTATIONS.web_search({ query: 'one unit whatever is read', depth: 'thorough' }, { userId: admin.id });
  check('the page was read through Exa', asked.some((u) => u.includes('api.exa.ai/contents')), asked.join(' '));
  check('  and the whole call settled exactly 1 unit', (await counter(bucket)) === 1, String(await counter(bucket)));
}

section('Firecrawl, end to end: charged by the pages read');
{
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
  const pool2 = await import('../server/keyPool.js');
  await pool2.warmPools();
  const { admin, search: bucket } = await liveAdmin();
  const crawlOf = (k) => Array.from({ length: k }, (_, i) => ({ markdown: `Page ${i}`, metadata: { sourceURL: `https://example.com/p${i}`, title: `P${i}`, statusCode: 200 } }));
  stubWeb({
    'firecrawl.dev/v2/crawl/crawl-1': () => json({ success: true, status: 'completed', creditsUsed: 10, data: crawlOf(10) }),
    'firecrawl.dev/v2/crawl': () => json({ success: true, id: 'crawl-1' }),
  });
  const out = await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'crawl', url: 'https://example.com', limit: 10 }, { userId: admin.id, deadline: Date.now() + 200_000 });
  check('a crawl of 10 pages settles 4 units', /10 pages of example\.com/.test(out) && (await counter(bucket)) === 4, `${out.slice(0, 80)} / ${await counter(bucket)}`);
  const fc = await import('../server/firecrawl.js');
  stubWeb({ 'firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: 'A long PDF. '.repeat(40), metadata: { statusCode: 200, totalPages: 300, creditsUsed: 6 } } }) });
  const scraped = await fc.firecrawlScrape('https://example.com/big.pdf');
  check('a scrape of a 300-page PDF says 5 pages were read', scraped?.pages === 300 && scraped?.pagesRead === 5, JSON.stringify([scraped?.pages, scraped?.pagesRead]));
  const before = await counter(bucket);
  search.clearSearchCache();
  stubWeb({
    'api.exa.ai': () => json({}, 500),
    'firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: 'A long PDF. '.repeat(40), metadata: { statusCode: 200, totalPages: 300, numPages: 300, creditsUsed: 6 } } }),
  });
  const page = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: admin.id });
  check('web_fetch of it through Firecrawl settles 2 units (5 pages read), not 100', /read through Firecrawl/.test(page) && (await counter(bucket)) - before === 2, `${page.slice(0, 60)} / ${(await counter(bucket)) - before}`);
  delete process.env.FIRECRAWL_API_KEY;
  await pool2.warmPools();
}

section('deep research and code_context settle one unit per metered search');
{
  const { admin, search: bucket } = await liveAdmin();
  const { gatherEvidence } = await import('../server/research/gather.js');
  search.clearSearchCache();
  await heal();
  stubWeb();
  await gatherEvidence(['alpha topic', 'beta topic'], { userId: admin.id, readPage: async () => '', target: 0, timeoutMs: 1000 });
  check('two metered searches in a research run are two units', (await counter(bucket)) === 2, String(await counter(bucket)));
  search.clearSearchCache();
  await heal();
  stubWeb({ 'stackexchange': () => json({ items: [] }) });
  const before = await counter(bucket);
  await CLOUD_IMPLEMENTATIONS.code_context({ query: 'how to call the thing' }, { userId: admin.id });
  check('code_context charges at most one unit however many sources answered', (await counter(bucket)) - before === 1, String((await counter(bucket)) - before));
}

section('a member out of their share is told about the share, not a balance');
{
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
  const pool3 = await import('../server/keyPool.js');
  await pool3.warmPools();
  const member = await makeUser('user');
  const { searchBucket } = await import('../server/freeShares.js');
  const { bucket, ends } = searchBucket(member.id, new Date());
  await store.addToCounter(bucket, 1_000_000, ends);
  const said = await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'map', url: 'https://example.com' }, { userId: member.id });
  check('the share sentence, and never the word balance', /share of this month's metered web calls is used/.test(said) && !/balance/i.test(said), said);
  delete process.env.FIRECRAWL_API_KEY;
  await pool3.warmPools();
}

section('end to end: a share-paid call counts, and a dry free pool is the balance\'s (fix round 1)');
{
  const shares = await import('../server/freeShares.js');
  const tiers = await import('../server/freeTier.js');
  const { paygPrices } = await import('../server/billing/plans.js');
  const { meteringRate } = await import('../server/billing/fx.js');
  const price = paygPrices(await meteringRate()).searchVnd;
  const thisMonth = tiers.periodOf('month').key;
  const pinNow = async (searches, machineMills) => {
    await store.setSetting(`free_shares:${thisMonth}`, { month: thisMonth, searches, machineMills, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: new Date().toISOString() });
    shares.__testing.forget();
    meter.forgetFreePools();
  };
  const shareOf = (user) => counter(shares.searchBucket(user.id, new Date()).bucket);
  const machineShareCount = (user) => counter(shares.machineBucket(user.id, new Date()).bucket);
  const fresh = async () => {
    const user = await makeUser();
    await withBalance(user, 10_000);
    return user;
  };
  await pinNow(50, 1000);

  // A read through Exa the share pays for is counted against the share (it was never counted at all).
  const reader = await fresh();
  search.clearSearchCache();
  await heal();
  stubWeb();
  await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: reader.id });
  check('an Exa read paid from the share moves the share counter, and not the balance', asked.some((u) => u.includes('api.exa.ai/contents')) && (await shareOf(reader)) === 1 && (await balanceOf(reader)) === 10_000, `${await shareOf(reader)} ${await balanceOf(reader)}`);

  // Firecrawl: the pages pool is its smallest share, and runs dry first.
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
  const pool4 = await import('../server/keyPool.js');
  await pool4.warmPools();
  const scrapeStub = { 'api.exa.ai': () => json({}, 500), 'firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: 'A long PDF. '.repeat(40), metadata: { statusCode: 200, totalPages: 300, numPages: 300, creditsUsed: 6 } } }) };
  const pager = await fresh();
  search.clearSearchCache();
  stubWeb(scrapeStub);
  const viaShare = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: pager.id });
  check('a Firecrawl read paid from the share: 1 unit counted against it, the other of its 2 units on the balance', /read through Firecrawl/.test(viaShare) && (await shareOf(pager)) === 1 && (await balanceOf(pager)) === 10_000 - price, `${viaShare.slice(0, 50)} ${await shareOf(pager)} ${await balanceOf(pager)}`);
  // Every free key's credits spent: a charged read goes on the owner's paid key (a spent share alone would not open it: keyPool.js).
  await tiers.exhaust('firecrawl');
  meter.forgetFreePools();
  await pool4.setPaidKey('firecrawl', 'env', 100_000);
  const spent = await fresh();
  search.clearSearchCache();
  stubWeb(scrapeStub);
  const viaBalance = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: spent.id });
  check('  the free credits used up: the read is charged to the balance, and read', /read through Firecrawl/.test(viaBalance) && (await shareOf(spent)) === 0 && (await balanceOf(spent)) === 10_000 - 2 * price, `${viaBalance.slice(0, 50)} ${await shareOf(spent)} ${await balanceOf(spent)}`);
  await pool4.setPaidKey('firecrawl', null);
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:firecrawl%' OR bucket LIKE 'paid:firecrawl%'");
  delete process.env.FIRECRAWL_API_KEY;
  await pool4.warmPools();
  meter.forgetFreePools();

  // The cloud computer, through e2b.js payUntil.
  const named = (name, message, extra = {}) => Object.assign(new Error(message), { name }, extra);
  const state = { boxes: new Map(), next: 1, createError: null };
  class Sandbox {
    constructor(id, metadata) {
      this.sandboxId = id;
      this.metadata = metadata;
      this.commands = { run: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
      this.files = { write: async () => {}, read: async () => new Uint8Array(), getInfo: async () => ({ size: 0 }) };
    }
    getHost(port) { return `${port}-${this.sandboxId}.e2b.app`; }
    async setTimeout() {}
    async getInfo() { return { cpuCount: 2, memoryMB: 1024 }; }
    async pause() {}
    async kill() { state.boxes.delete(this.sandboxId); }
    static async kill(id) { state.boxes.delete(id); }
    static async create(_template, opts) {
      if (state.createError) throw state.createError;
      const box = new Sandbox(`fb${state.next++}`, opts.metadata);
      state.boxes.set(box.sandboxId, box);
      return box;
    }
    static async connect(id) {
      const box = state.boxes.get(id);
      if (!box) throw named('SandboxNotFoundError', `404: sandbox ${id} not found`, { statusCode: 404 });
      return box;
    }
    static list() { return { hasNext: false, nextItems: async () => [] }; }
  }
  const e2b = await import('../server/e2b.js');
  e2b.__testing.useSdk({ Sandbox });
  const poolMonth = () => counter(`free:e2b:${thisMonth}`);
  const clearE2b = async () => query("DELETE FROM rate_limits WHERE bucket LIKE 'free:e2b%' OR bucket LIKE 'paid:e2b%' OR bucket LIKE 'bill:sandbox%'");
  await clearE2b();

  const onShare = await fresh();
  await e2b.e2bMachineFor(onShare.id, 'eph-fb1');
  const cost = await poolMonth();
  check('a window the share pays for goes on a free key, and the share is spent once: the balance is untouched', cost > 0 && (await machineShareCount(onShare)) === cost && (await balanceOf(onShare)) === 10_000, `pool ${cost} share ${await machineShareCount(onShare)} balance ${await balanceOf(onShare)}`);

  await tiers.exhaust('e2b');
  await pool.setPaidKey('e2b', 'env', 1_000_000);
  const onBalance = await fresh();
  const started = await e2b.e2bMachineFor(onBalance.id, 'eph-fb2').then((m) => m.provider, (err) => err.name);
  check('  E2B\'s free month used up: the share is not used, the window is charged to the balance and starts on the paid key', started === 'e2b' && (await machineShareCount(onBalance)) === 0 && (await balanceOf(onBalance)) < 10_000 && (await counter(`paid:e2b@env:${thisMonth}`)) > 0, `${started} ${await balanceOf(onBalance)}`);
  await pool.setPaidKey('e2b', null);
  await clearE2b();

  // A share hold the free keys cannot serve after all is given back, and nothing stays counted.
  const stuck = await fresh();
  await pool.markKey('e2b', 'env', 'exhausted');
  const refusedStart = await e2b.e2bMachineFor(stuck.id, 'eph-fb3').then(() => 'started', (err) => err.name);
  await pool.markKey('e2b', 'env', 'ok');
  check('  and a start no key can serve is refused with the balance and the share untouched', refusedStart === 'E2BOutOfCredit' && (await balanceOf(stuck)) === 10_000 && (await machineShareCount(stuck)) === 0, `${refusedStart} ${await balanceOf(stuck)}`);
  e2b.__testing.useSdk(null);
  await clearE2b();
  await pinNow(4, 25);
}

section('a share search the free engines answer is held again on the balance (fix round, A1, A4, A5)');
{
  const shares = await import('../server/freeShares.js');
  const tiers = await import('../server/freeTier.js');
  const { paygPrices } = await import('../server/billing/plans.js');
  const { meteringRate } = await import('../server/billing/fx.js');
  const { gatherEvidence } = await import('../server/research/gather.js');
  const price = paygPrices(await meteringRate()).searchVnd;
  const thisMonth = tiers.periodOf('month').key;
  const shareOf = (user) => counter(shares.searchBucket(user.id, new Date()).bucket);
  const fresh = async () => {
    const user = await makeUser();
    await withBalance(user, 10_000);
    return user;
  };
  const reset = async () => {
    await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:exa%' OR bucket LIKE 'paid:exa%' OR bucket LIKE 'free:firecrawl%' OR bucket LIKE 'paid:firecrawl%'");
    await pool.setPaidKey('exa', null);
    await pool.setPaidKey('firecrawl', null);
    search.clearSearchCache();
    await heal();
    meter.forgetFreePools();
  };
  await store.setSetting(`free_shares:${thisMonth}`, { month: thisMonth, searches: 50, machineMills: 1000, capacity: { searches: 1e12, machineMills: 1e12 }, people: { searches: 1, machines: 1 }, committed: { searches: 0, machineMills: 0 }, at: new Date().toISOString() });
  shares.__testing.forget();
  await reset();

  // Exa and Firecrawl's search are dry and Tavily has room: that room is behind Google and DuckDuckGo, which answer first and count
  // nothing, so it is not the share's. The account is charged and the paid key serves it.
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
  await pool.warmPools();
  await tiers.exhaust('exa');
  await tiers.exhaust('firecrawl_search');
  await pool.setPaidKey('exa', 'env', 100_000);
  const reaches = await search.shareSearchEngines();
  check('a share search reaches the metered engines ahead of the first free one: Exa and Firecrawl, not Tavily', reaches.join() === 'exa,firecrawl', reaches.join());
  const hasKeys = await tiers.allowance('tavily');
  stubWeb({ 'api.tavily.com': () => json({ results: [{ title: 'Tavily', url: 'https://example.com/tv', content: 'x' }] }) });
  const free = await fresh();
  const viaPaid = await CLOUD_IMPLEMENTATIONS.web_search({ query: 'dry free engines one', depth: 'quick' }, { userId: free.id });
  check('Exa and Firecrawl dry, Tavily with room: web_search is charged to the balance and served by Exa on the paid key', hasKeys.left > 0 && /from Exa/.test(viaPaid) && (await balanceOf(free)) === 10_000 - price && (await counter(`paid:exa@env:${thisMonth}`)) > 0, `${viaPaid.slice(0, 40)} ${await balanceOf(free)} ${await counter(`paid:exa@env:${thisMonth}`)}`);
  check('  never by Google or DuckDuckGo, and nothing was counted against the share', !asked.some((u) => u.includes('duckduckgo') || u.includes('google')) && (await shareOf(free)) === 0, asked.join(' '));
  await reset();

  // The same, when the figure said there was room (a minute's memory) and the engine had stood aside by then.
  await meter.holdSearch((await fresh()).id, { service: 'search' }).then((h) => h.release());
  await tiers.exhaust('exa');
  await pool.setPaidKey('exa', 'env', 100_000);
  const stale = await fresh();
  stubWeb();
  const again = await CLOUD_IMPLEMENTATIONS.web_search({ query: 'a stale figure one', depth: 'quick' }, { userId: stale.id });
  check('a stale figure: the share hold sees a free engine answer, is released, and the search is held again on the balance and served by Exa', /from Exa/.test(again) && (await balanceOf(stale)) === 10_000 - price && (await shareOf(stale)) === 0 && asked.some((u) => u.includes('duckduckgo')), `${again.slice(0, 40)} ${await balanceOf(stale)} ${await shareOf(stale)}`);
  await reset();

  await meter.holdSearch((await fresh()).id, { service: 'search' }).then((h) => h.release());
  await tiers.exhaust('exa');
  await pool.setPaidKey('exa', 'env', 100_000);
  const researcher = await fresh();
  stubWeb();
  const gathered = await gatherEvidence(['a stale figure two'], { userId: researcher.id, readPage: async () => '', target: 0, timeoutMs: 1000 });
  check('gather does the same: charged once and the paid key served it', gathered.ledger.size === 1 && (await balanceOf(researcher)) === 10_000 - price && (await shareOf(researcher)) === 0, `${gathered.ledger.size} ${await balanceOf(researcher)}`);
  await reset();

  // A4: Exa's free allowance is spent, and a charged read goes on the paid key.
  await tiers.exhaust('exa');
  await pool.setPaidKey('exa', 'env', 100_000);
  meter.forgetFreePools();
  const reader = await fresh();
  stubWeb();
  const page = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: reader.id });
  check('an Exa read with the free allowance spent is read on the paid key and charged once', /read through Exa/.test(page) && (await balanceOf(reader)) === 10_000 - price && (await counter(`paid:exa@env:${thisMonth}`)) > 0, `${page.slice(0, 40)} ${await balanceOf(reader)} ${await counter(`paid:exa@env:${thisMonth}`)}`);
  await reset();

  // A5: Firecrawl's pages share is spent, the key still has credits: a charged read goes on the paid key, not nowhere.
  await pool.setPaidKey('firecrawl', 'env', 100_000);
  await tiers.exhaust('firecrawl_scrape');
  meter.forgetFreePools();
  const fc = await import('../server/firecrawl.js');
  stubWeb({ 'firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: 'A page. '.repeat(40), metadata: { statusCode: 200, creditsUsed: 1 } } }) });
  const uncharged = await fc.firecrawlScrape('https://example.com/p', { paid: false });
  const charged = await fc.firecrawlScrape('https://example.com/p', { paid: true });
  check('a charged Firecrawl read with the pages share spent is served by the paid key (an uncharged one is not)', uncharged === null && !!charged?.text && (await counter(`paid:firecrawl@env:${thisMonth}`)) > 0, `${uncharged} ${charged?.text?.length} ${await counter(`paid:firecrawl@env:${thisMonth}`)}`);
  const holder = await fresh();
  stubWeb({ 'api.exa.ai': () => json({}, 500), 'firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: 'A long page. '.repeat(40), metadata: { statusCode: 200, creditsUsed: 1 } } }) });
  const whole = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: refusedUrl }, { userId: holder.id });
  check('  end to end, the read is charged to the balance, not refused', /read through Firecrawl/.test(whole) && (await balanceOf(holder)) < 10_000 && (await shareOf(holder)) === 0, `${whole.slice(0, 40)} ${await balanceOf(holder)}`);
  await reset();

  // Final review N1: Google has no paid key, so a charged search past its daily free quota must not ask it — the deployment's
  // Gemini key would be used past its free grounding quota with nothing charged for it.
  process.env.GEMINI_API_KEY = 'gemini-test-key';
  process.env.SEARCH_ORDER = 'google, duckduckgo';
  await tiers.exhaust('google');
  meter.forgetFreePools();
  const pastGoogle = await fresh();
  stubWeb({ 'generativelanguage.googleapis.com': () => json({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) });
  await CLOUD_IMPLEMENTATIONS.web_search({ query: 'google is spent', depth: 'quick' }, { userId: pastGoogle.id });
  check("a charged search with Google's daily free quota spent does not ask Google (it has no paid key)", !asked.some((u) => u.includes('generativelanguage')), asked.join(' '));
  delete process.env.GEMINI_API_KEY;
  delete process.env.SEARCH_ORDER;
  await query("DELETE FROM rate_limits WHERE bucket LIKE 'free:google%'");
  await reset();
  delete process.env.TAVILY_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  await pool.warmPools();
  meter.forgetFreePools();
}

refuser.close();

globalThis.fetch = realFetch;
console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : '\n\x1b[32mAll billing meter checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
