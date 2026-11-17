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
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'BILLING_MODE', 'SEARCH_ORDER', 'FREE_TIER_ONLY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'FIRECRAWL_API_KEY']) delete process.env[name];

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
  const a = await meter.holdSearch(user.id, { now: T0 });
  const b = await meter.holdSandbox(user.id, 600, { now: T0 });
  check('a non-administrator holding a plan and a balance gets NOT_BILLED in preview', a === meter.NOT_BILLED && b === meter.NOT_BILLED && !a.billed && !a.paid);
  await a.settle(1);
  await a.release();
  check('  and nothing is written, nothing charged', (await ever()) === 0 && (await balanceOf(user)) === 50_000 && (await usage(user, 'search')).u === 0);
  const nobody = await makeUser();
  check('an administrator with no plan and no balance gets NOT_BILLED', (await meter.holdSearch(nobody.id, { now: T0 })) === meter.NOT_BILLED && (await ever()) === 0);
  check('no account at all, none either', (await meter.holdSearch(null)) === meter.NOT_BILLED && (await meter.holdSearch('nobody-here')) === meter.NOT_BILLED);
  check('the Hold of NOT_BILLED is the documented shape', meter.NOT_BILLED.source === null && meter.NOT_BILLED.refused === false && meter.NOT_BILLED.units === 0);
  process.env.BILLING_MODE = 'off';
  meter.forgetBillable();
  const admin = await makeUser();
  await withPlan(admin);
  check('with billing off, nobody is metered', (await meter.holdSearch(admin.id, { now: T0 })) === meter.NOT_BILLED);
  delete process.env.BILLING_MODE;
  meter.forgetBillable();
  process.env.BILLING_MODE = 'live';
  const anyone = await makeUser('user');
  await withBalance(anyone, 5000);
  await usedUpShare(anyone, T0);
  const live = await meter.holdSearch(anyone.id, { now: T0 });
  check('in live any account with a balance is held (the admin check is preview only)', live.billed && live.source === 'balance');
  delete process.env.BILLING_MODE;
  meter.forgetBillable();
}

section('searches: the month first, then the balance, then nothing (never refused in preview)');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const key = `bill:search:${admin.id}:${month(T0)}`;
  const first = await meter.holdSearch(admin.id, { now: hours(1) });
  check('Plus: a search is held from the included allowance', first.billed && first.source === 'included' && first.paid && !first.refused && first.units === 1);
  let last = first;
  for (let i = 1; i < 150; i += 1) last = await meter.holdSearch(admin.id, { now: hours(2) });
  check('all 150 of the month can be used in one day (no daily limit)', last.source === 'included' && (await counter(key)) === 150, String(await counter(key)));
  const over = await meter.holdSearch(admin.id, { now: hours(3) });
  check('the 151st, with no balance, is held from nothing: unpaid, not refused', over.billed && over.source === 'none' && over.paid === false && over.refused === false);
  check('  and a would-count says it would have been charged', (await wouldOf(admin, 'search')) === 1 && (await counter(key)) === 150);
  await over.settle(0);
  check('  settling it as unused takes the would-count back', (await wouldOf(admin, 'search')) === 0);

  await withBalance(admin, 800);
  meter.forgetBillable();
  const bal = await meter.holdSearch(admin.id, { now: hours(3) });
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
  const crawl = await meter.holdSearch(admin.id, { now: hours(1) });
  await crawl.settle(unitsForPages(10));
  check('a crawl of 10 pages (held 1) settles as 4 units', unitsForPages(10) === 4 && (await counter(key)) === 4, String(await counter(key)));
  const two = await meter.holdSearch(admin.id, { units: 3, now: hours(1) });
  await two.settle(1);
  check('held 3, used 1: two come back', (await counter(key)) === 5, String(await counter(key)));

  // Past the month and out of balance an extra is unpaid in preview, and with a balance it is charged.
  const poor = await makeUser();
  await withBalance(poor, 1000);
  await usedUpShare(poor, hours(1));
  const held = await meter.holdSearch(poor.id, { now: hours(1) });
  await held.settle(3);
  check('no plan, 1000đ: held 1 (400đ), used 3: the extra 2 are one block from one source, 800đ does not fit the 600đ left, so both are unpaid', (await balanceOf(poor)) === 600 && (await wouldOf(poor, 'search')) === 2, `${await balanceOf(poor)} ${await wouldOf(poor, 'search')}`);
  await held.release();
}

section('a month rolls over on the plan\'s own day');
{
  const admin = await makeUser();
  await withPlan(admin, 'plus');
  const early = await meter.holdSearch(admin.id, { units: 150, now: days(10) });
  const full = await meter.holdSearch(admin.id, { now: days(11) });
  check('the 150 used up, the next is not included', early.source === 'included' && full.source === 'none');
  const next = await meter.holdSearch(admin.id, { now: new Date('2027-04-10T03:00:01Z') });
  check('from the plan\'s own day (the 10th, 10:00 Vietnamese time) the allowance is new', next.source === 'included');
  const before = await meter.holdSearch(admin.id, { now: new Date('2027-04-10T02:59:59Z') });
  check('  and a second earlier it was not', before.source === 'none');
}

section('20 holds at once with 4,000đ and no plan: exactly 10 are paid');
{
  const admin = await makeUser();
  await withBalance(admin, 4000);
  await usedUpShare(admin, T0);
  const holds = await Promise.all(Array.from({ length: 20 }, () => meter.holdSearch(admin.id, { now: T0 })));
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
  const h = await meter.holdSearch(admin.id, { now: T0 });
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
  await meter.holdSearch(admin.id, { units: 150, now: hours(1) });
  await meter.holdSearch(admin.id, { units: 2, now: hours(2) });
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
    const h = await meter.holdSearch(free.id, { now: at(1) });
    sources.push(h === meter.NOT_BILLED && !h.paid && !h.billed);
    await countMetered(free.id, at(1));
  }
  check('Free with a balance: the first S searches are NOT_BILLED, paid false', sources.every(Boolean), JSON.stringify(sources));
  check('  the balance does not move and no usage row is written', (await balanceOf(free)) === 10_000 && (await usage(free, 'search')).u === 0);
  const past = await meter.holdSearch(free.id, { now: at(1) });
  check('  the next one is billed from the balance, paid, at the pay-as-you-go price', past.billed && past.source === 'balance' && past.paid === true && (await balanceOf(free)) === 10_000 - price, `${past.source} ${await balanceOf(free)}`);

  // A balance-sourced hold that settles with more never draws on the share.
  const grow = await makeUser();
  await withBalance(grow, 10_000);
  for (let i = 0; i < S; i += 1) await countMetered(grow.id, at(1));
  const held = await meter.holdSearch(grow.id, { now: at(1) });
  await pin(100, 25);
  await held.settle(3);
  check('settle(more) on a billed hold: all 3 units are charged, none taken from a share that has room', held.source === 'balance' && (await usage(grow, 'search')).u === 3 && (await balanceOf(grow)) === 10_000 - 3 * price, `${(await usage(grow, 'search')).u} ${await balanceOf(grow)}`);
  await pin(S, 25);

  // Plus, share no larger than its own 150: the plan's month, then the balance, never the share.
  const plus = await makeUser();
  await withPlan(plus, 'plus', FIRST);
  await withBalance(plus, 10_000);
  const incl = await meter.holdSearch(plus.id, { units: 150, now: at(1) });
  check('Plus with S <= 150: the included month comes first, paid', incl.billed && incl.source === 'included' && incl.paid === true);
  const after = [];
  for (let i = 0; i < 3; i += 1) after.push(await meter.holdSearch(plus.id, { now: at(2) }));
  check('  after it, the balance is charged and NOT_BILLED never appears', after.every((h) => h.billed && h.source === 'balance' && h.paid) && (await balanceOf(plus)) === 10_000 - 3 * price);

  // Plus, share larger than its own 150: S - 150 more are free, then the balance.
  await pin(153, 25);
  const big = await makeUser();
  await withPlan(big, 'plus', FIRST);
  await withBalance(big, 10_000);
  const first = await meter.holdSearch(big.id, { units: 150, now: at(1) });
  const free3 = [];
  for (let i = 0; i < 3; i += 1) {
    const h = await meter.holdSearch(big.id, { now: at(2) });
    free3.push(h === meter.NOT_BILLED);
    await countMetered(big.id, at(2));
  }
  check('Plus with S = 153: 150 included, then S - 150 = 3 NOT_BILLED', first.source === 'included' && free3.every(Boolean) && (await balanceOf(big)) === 10_000, JSON.stringify(free3));
  const then = await meter.holdSearch(big.id, { now: at(2) });
  check('  then the balance', then.billed && then.source === 'balance' && (await balanceOf(big)) === 10_000 - price);
  check('  paid is true on included and balance holds, false on the share ones', first.paid === true && then.paid === true && meter.NOT_BILLED.paid === false);
  await pin(S, 25);

  // With the ceilings lifted there is no share: a Free account with a balance is charged from the first search.
  process.env.FREE_TIER_ONLY = 'false';
  const lifted = await makeUser();
  await withBalance(lifted, 10_000);
  const h = await meter.holdSearch(lifted.id, { now: at(1) });
  check('FREE_TIER_ONLY=false: charged from the first search, as before', h.billed && h.source === 'balance' && (await balanceOf(lifted)) === 10_000 - price);
  delete process.env.FREE_TIER_ONLY;

  // The computer: Free with a balance.
  const cost = 10;
  const box = await makeUser();
  await withBalance(box, 10_000);
  const w1 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('computer, Free with a balance: a window the share can pay is NOT_BILLED, paid false, nothing charged', w1 === meter.NOT_BILLED && !w1.paid && (await balanceOf(box)) === 10_000);
  await e2bAccountSpend(box.id, cost, at(1));
  const w2 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('  the second also (15 left of 25)', w2 === meter.NOT_BILLED && (await e2bAccountAllowance(box.id, at(1))).left === 15);
  await e2bAccountSpend(box.id, cost, at(1));
  const w3 = await meter.holdSandbox(box.id, 600, { now: at(1), shareCost: cost });
  check('  with 5 left it takes from the balance, 10 started minutes', w3.billed && w3.source === 'balance' && w3.paid === true && (await balanceOf(box)) === 10_000 - 10 * perMinute, `${w3.source} ${await balanceOf(box)}`);
  const bare = await makeUser();
  await withBalance(bare, 10_000);
  const w4 = await meter.holdSandbox(bare.id, 600, { now: at(1) });
  check('  with shareCost omitted the share is skipped and the balance pays', w4.billed && w4.source === 'balance' && (await balanceOf(bare)) === 10_000 - 10 * perMinute);

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
    inc.source === 'included' && inc.paid && s1 === meter.NOT_BILLED && s2 === meter.NOT_BILLED && b1.source === 'balance' && b1.paid && (await balanceOf(plusBox)) === 10_000 - 10 * perMinute,
    `${inc.source} ${b1.source} ${await balanceOf(plusBox)}`);
  await pin(S, 25);
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
  await e2b.e2bMachineFor(admin.id, 'synz-bm').then(() => null, (e) => e);
  check('a start that fails gives its window back to the plan', (await counter(bucket)) === 0, String(await counter(bucket)));
  state.createError = null;
  await e2b.e2bMachineFor(admin.id, 'synz-bm');
  check('a machine that starts keeps its window: 4 minutes of the plan', (await counter(bucket)) === 240, String(await counter(bucket)));
  const other = await makeUser('user');
  await e2b.e2bMachineFor(other.id, 'synz-other');
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

refuser.close();

globalThis.fetch = realFetch;
console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : '\n\x1b[32mAll billing meter checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
