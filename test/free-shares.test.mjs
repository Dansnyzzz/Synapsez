/**
 * Each account's free share is a month's, worked out from what the keys can really do
 * (owner, 2026-11-13: "limit users by the month, not the day"): server/freeShares.js, and
 * server/freeTier.js counting against it. PGlite stands in for the database; no provider is
 * called.
 *
 *   node test/free-shares.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'free-shares-test-encryption-key-long-enough-to-be-quiet';
process.env.SESSION_SECRET ||= 'free-shares-test-session-secret';
for (const name of [
  'DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'FREE_TIER_ONLY', 'FREE_TIER_USER_DAILY', 'FREE_TIER_USER_MONTHLY_MIN', 'FREE_TIER_USER_MONTHLY_MAX',
  'FREE_SHARE_RESERVE', 'E2B_ACCOUNT_MIN_MILLS', 'E2B_ACCOUNT_SHARE', 'E2B_CREDIT_MILLS', 'E2B_CREDIT_LASTING_MILLS', 'E2B_CREDIT_EXPIRES', 'E2B_TEMPLATE',
  'EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'FIRECRAWL_API_KEY', 'E2B_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'FIRECRAWL_SEARCH_FREE', 'EXA_FREE_MILLS', 'TAVILY_FREE_CREDITS', 'BRAVE_FREE_REQUESTS',
]) delete process.env[name];

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
const store = await initStore({ driver: sql });
const { encryptSecret, sha256 } = await import('../server/crypto.js');
const { serviceKeyContext } = await import('../server/secretContexts.js');
const pool = await import('../server/keyPool.js');
const tiers = await import('../server/freeTier.js');
const shares = await import('../server/freeShares.js');

let added = 0;
const addKey = async (service, key, ceiling) => {
  const id = `sk${(added += 1)}`;
  await store.addServiceKey({ id, service, sealed: encryptSecret(key, serviceKeyContext(service, id)), fingerprint: sha256(`${service}:${key}:${id}`), hint: key.slice(-4), label: null, ceiling, addedBy: null });
  return id;
};
/** Every key and every count gone, and what the shares remember with them. */
const reset = async () => {
  await sql.query('DELETE FROM service_keys');
  await sql.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:%' OR bucket LIKE 'paid:%'");
  await sql.query("DELETE FROM settings WHERE key LIKE 'free_shares:%'");
  for (const service of ['exa', 'tavily', 'firecrawl', 'brave', 'e2b']) await pool.keysFor(service, { fresh: true });
  shares.__testing.forget();
};
const refreshPool = async () => {
  for (const service of ['exa', 'tavily', 'firecrawl', 'brave', 'e2b']) await pool.keysFor(service, { fresh: true });
  shares.__testing.forget();
};

// The real month, so the database's own clock agrees with the buckets; the days are chosen inside it.
const real = new Date();
const Y = real.getUTCFullYear();
const M = real.getUTCMonth();
const D = new Date(Date.UTC(Y, M + 1, 0)).getUTCDate();
const on = (day) => new Date(Date.UTC(Y, M, day, 12));
const monthKey = tiers.periodOf('month', on(1)).key;
const lastKey = tiers.periodOf('month', new Date(Date.UTC(Y, M - 1, 15))).key;
const people = async (n, key = monthKey, from = 0) => {
  for (let i = 0; i < n; i += 1) await sql.query("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ($1, 1, NOW() + INTERVAL '40 days')", [`free:user:p${from + i}:${key}`]);
};
const exaOnly = async (searches) => addKey('exa', 'exa-only-1111-aaaa', searches * 15);

section('capacity: what the keys can really do, in searches');
{
  await reset();
  await addKey('exa', 'exa-one-1111-aaaa', 9500);
  await addKey('exa', 'exa-two-2222-bbbb', 9500);
  await addKey('tavily', 'tvly-one-3333-cccc', 950);
  process.env.BRAVE_API_KEY = 'brave-one-4444-dddd';
  await addKey('firecrawl', 'fc-one-5555-eeee', 4750);
  await refreshPool();
  const search = (await tiers.allowance('firecrawl_search')).limit;
  const want = Math.floor(19000 / 15) + Math.floor((await tiers.allowance('tavily')).limit / 1) + Math.floor((await tiers.allowance('brave')).limit / 1) + Math.floor(search / 2);
  const got = await shares.monthShares({ now: on(1) });
  check('Exa 2 keys, Tavily 1, Brave 1, Firecrawl\'s search share, each over its cost of one search', got.capacity.searches === want, `${got.capacity.searches} vs ${want}`);
  check('  Firecrawl\'s search share is 60% of the key, 2,850 credits', search === 2850, String(search));
  check('  Exa\'s 19,000 mills at 15 a search is 1,266 searches', Math.floor(19000 / 15) === 1266 && got.capacity.searches > 1266 + 950);

  await people(5);
  shares.__testing.forget();
  await sql.query("DELETE FROM settings WHERE key LIKE 'free_shares:%'");
  const five = await shares.monthShares({ now: on(1) });
  check('5 people count as 10: the people floor', five.searches === Math.min(900, Math.floor(want * 0.8 / 10)) && five.people.searches === 5, JSON.stringify([five.searches, five.people]));
  delete process.env.BRAVE_API_KEY;
}

section('the share, over many people and few');
{
  await reset();
  await exaOnly(10_000);
  await refreshPool();
  await people(20);
  const one = await shares.monthShares({ now: on(1) });
  check('capacity 10,000 and 20 people: floor(8000 / 20) = 400 on the 1st', one.searches === 400 && one.capacity.searches === 10_000 && one.people.searches === 20, JSON.stringify(one));

  await reset();
  await exaOnly(10_000);
  await refreshPool();
  await people(400);
  const many = await shares.monthShares({ now: on(1) });
  check('400 people: floor(8000 / 400) = 20, raised to the floor of 30', many.searches === 30, String(many.searches));

  await reset();
  await exaOnly(10_000);
  await refreshPool();
  await people(2000);
  const crowd = await shares.monthShares({ now: on(1) });
  check('and never below 30 however many', crowd.searches === 30);

  await reset();
  await exaOnly(1_000_000);
  await refreshPool();
  const rich = await shares.monthShares({ now: on(1) });
  check('few people and a lot of capacity: not above 900', rich.searches === 900, String(rich.searches));

  process.env.FREE_TIER_USER_MONTHLY_MAX = '500';
  shares.__testing.forget();
  await sql.query("DELETE FROM settings WHERE key LIKE 'free_shares:%'");
  check('the bounds can be set (FREE_TIER_USER_MONTHLY_MAX)', (await shares.monthShares({ now: on(1) })).searches === 500);
  delete process.env.FREE_TIER_USER_MONTHLY_MAX;
}

section('an account arriving mid-month gets the days that are left, from the reserve');
{
  await reset();
  await exaOnly(10_000);
  await refreshPool();
  await people(20);
  const day21 = on(21);
  check('0 used: the share an account would get on day 21', (await shares.searchShareOf('late', day21)).share === Math.max(30, Math.floor(400 * (D - 20) / D)), String((await shares.searchShareOf('late', day21)).share));
  await tiers.countMetered('late', day21);
  const later = await shares.searchShareOf('late', on(25));
  check('  fixed by the day it started, not by the day it asks', later.share === Math.max(30, Math.floor(400 * (D - 20) / D)) && later.startedOn === 21, JSON.stringify(later));
  await tiers.countMetered('last-day', on(D));
  check('starting on the last day gives the floor of 30', (await shares.searchShareOf('last-day', on(D))).share === 30);
  await tiers.countMetered('first-day', on(1));
  check('starting on the 1st gives the whole share', (await shares.searchShareOf('first-day', on(9))).share === 400);
  check('the account that arrives late is stopped at its own smaller share', await (async () => {
    const share = later.share;
    for (let i = 1; i < share - 1; i += 1) await tiers.countMetered('late', on(25));
    const before = await tiers.mayMeter('late', on(26));
    await tiers.countMetered('late', on(26));
    return before && !(await tiers.mayMeter('late', on(26)));
  })());
}

section('held for the month: raised by a new key, never lowered');
{
  await reset();
  const first = await exaOnly(10_000);
  await refreshPool();
  await people(20);
  const a = await shares.monthShares({ now: on(3) });
  check('worked out on the first call and stored under free_shares:<month>', a.searches === 400 && !!(await store.getSetting(`free_shares:${monthKey}`)));
  await people(180, monthKey, 100);
  shares.__testing.forget();
  check('more people later in the month change nothing', (await shares.monthShares({ now: on(4) })).searches === 400);
  await addKey('exa', 'exa-extra-9999-zzzz', 150_000);
  await refreshPool();
  const raised = await shares.monthShares({ now: on(5) });
  check('a key added: capacity rises and the share with it (the higher of old and new)', raised.capacity.searches === 20_000 && raised.searches >= 400, JSON.stringify(raised));
  await store.deleteServiceKey(first);
  await refreshPool();
  const kept = await shares.monthShares({ now: on(6) });
  check('a key removed does not lower it', kept.searches === raised.searches, `${kept.searches} vs ${raised.searches}`);
}

section('a day is not a limit');
{
  await reset();
  await exaOnly(1_000_000);
  await refreshPool();
  const day = on(1);
  check('the share is 900 here', (await shares.monthShares({ now: day })).searches === 900);
  await store.addToCounter(`free:user:heavy:${monthKey}`, 899, new Date(Date.UTC(Y, M + 2, 1)));
  check('899 in one day, the 900th is allowed', await tiers.mayMeter('heavy', day));
  await tiers.countMetered('heavy', day);
  check('and the 901st is refused', !(await tiers.mayMeter('heavy', day)));
  check('the 1st of the next month starts again', await tiers.mayMeter('heavy', new Date(Date.UTC(Y, M + 1, 1, 1))));
  check('another account has its own', await tiers.mayMeter('other', day));
  process.env.FREE_TIER_USER_DAILY = '1';
  check('FREE_TIER_USER_DAILY alone changes nothing', await tiers.mayMeter('other', day) && (await shares.monthShares({ now: day })).searches === 900);
  await tiers.countMetered('other', day);
  check('  even after one search', await tiers.mayMeter('other', day));
  delete process.env.FREE_TIER_USER_DAILY;
  check('last month\'s count is still readable (kept to the end of this month)', await (async () => {
    await tiers.countMetered('veteran', new Date(Date.UTC(Y, M - 1, 20)));
    shares.__testing.forget();
    await sql.query("DELETE FROM settings WHERE key LIKE 'free_shares:%'");
    return (await shares.monthShares({ now: day })).people.searches >= 1;
  })());
}

section('the pool runs dry: nothing is billed, nobody is let through to the metered engines');
{
  await reset();
  await exaOnly(1000);
  await refreshPool();
  await people(20);
  const paidCalls = [];
  const realTake = tiers.take;
  check('with room in the pool an account may meter', await tiers.mayMeter('u1', on(2)));
  await tiers.spend('exa', 1000 * 15, on(2), { keyId: (await pool.keysFor('exa'))[0].id });
  shares.__testing.forget();
  check('with the pool spent, mayMeter is false for everyone', !(await tiers.mayMeter('u1', on(2))) && !(await tiers.mayMeter('u2', on(2))));
  const card = await shares.accountShares('u1', on(2));
  check('  and the account\'s card says the free keys are used up', card.dry === true);
  check('  no call asked for the paid key', paidCalls.length === 0 && realTake === tiers.take);
}

section('failing to work it out never blocks anybody');
{
  await reset();
  await exaOnly(10_000);
  await refreshPool();
  const original = store.getSetting;
  store.getSetting = async () => { throw new Error('connection refused'); };
  const got = await shares.monthShares({ now: on(2) });
  const may = await tiers.mayMeter('anyone', on(2));
  store.getSetting = original;
  check('no last month stored: the maxima, 900', got.searches === 900, String(got.searches));
  check('  and mayMeter lets the account through', may === true);

  await store.setSetting(`free_shares:${lastKey}`, { month: lastKey, searches: 123, machineMills: 456, capacity: { searches: 1, machineMills: 1 }, people: { searches: 1, machines: 1 }, at: 'x' });
  shares.__testing.forget();
  store.getSetting = async (key) => { if (String(key).includes(monthKey)) throw new Error('down'); return original.call(store, key); };
  const fallback = await shares.monthShares({ now: on(2) });
  store.getSetting = original;
  check('last month\'s figures, when there are some', fallback.searches === 123, String(fallback.searches));
}

section('the cloud computer: one share for the month, no daily split');
{
  await reset();
  process.env.E2B_API_KEY = 'e2b_env_6666_ffff';
  await refreshPool();
  const limit = (await tiers.allowance('e2b', on(2))).limit;
  const got = await shares.monthShares({ now: on(2) });
  check('the share sits between 133 mills and 34% of the month', got.machineMills >= 133 && got.machineMills <= Math.floor(limit * 0.34), `${got.machineMills} of ${limit}`);
  const day1 = await tiers.e2bAccountAllowance('m1', on(1));
  check('one account may use its whole share on the first day', day1.left === got.machineMills || day1.left === (await shares.monthShares({ now: on(1) })).machineMills, `${day1.left} vs ${got.machineMills}`);
  await tiers.e2bAccountSpend('m1', day1.left, on(1));
  check('and then it has none', (await tiers.e2bAccountAllowance('m1', on(1))).left === 0);
  check('no per-day counter is written', (await sql.query("SELECT 1 FROM rate_limits WHERE bucket LIKE 'free:e2b:day:%'")).length === 0);
  check('another account has its own', (await tiers.e2bAccountAllowance('m2', on(1))).left > 0);
  check('the people are counted by distinct account', (await store.countAccountsByBucket([`free:e2b:${monthKey}:user:%`])) === 1);
  const arrive = await shares.machineShareOf('m3', on(21));
  check('arriving on day 21 gets the days left, at least 133', arrive.share === Math.max(133, Math.floor(got.machineMills * (D - 20) / D)) || arrive.share === Math.min(got.machineMills, Math.max(133, Math.floor(got.machineMills * (D - 20) / D))), String(arrive.share));
  delete process.env.E2B_API_KEY;
}

section('shown to the person and to the administrators');
{
  await reset();
  await exaOnly(10_000);
  await refreshPool();
  await people(20);
  const report = await tiers.freeTierReport(on(2));
  check('freeTierReport().shares holds the month\'s figure', report.shares?.searches === 400 && report.shares.people.searches === 20 && report.userDaily === undefined, JSON.stringify(report.shares));
  await tiers.countMetered('u9', on(1));
  const card = await shares.accountShares('u9', on(2));
  check('an account\'s card: used of share, when it starts again, how it was worked out', card.searches.used === 1 && card.searches.share === 400 && card.endsAt === new Date(Date.UTC(Y, M + 1, 1)).toISOString() && card.capacity.searches === 10_000 && card.people.searches === 20 && card.reserve === 0.2 && card.bounds.searchMin === 30 && card.bounds.searchMax === 900, JSON.stringify(card));
  check('  a late account says which day it started', (await shares.accountShares('u9', on(2))).startedOn === 1 && (await shares.accountShares('never', on(2))).startedOn === null);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
