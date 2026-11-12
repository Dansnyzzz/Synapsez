/**
 * Several keys per deployment service (spec A, owner 2026-11-12): server/keyPool.js, and
 * server/freeTier.js counting per key. The environment's key is key 1; the owner's others
 * are rows in `service_keys`, sealed. A service's capacity is the sum of its keys; the key
 * with the largest share left answers; a refused, spent or rate-limited key hands over to
 * the next; the one paid key takes charged calls only once every free key is full.
 *
 * No provider is called: `fetch` is answered here, and every key is made up — and none of
 * them may show in anything this suite prints, logs or is thrown (the last section).
 *
 *   node test/key-pool.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'key-pool-test-encryption-key-long-enough-to-be-quiet';
process.env.SESSION_SECRET ||= 'key-pool-test-session-secret';
for (const name of [
  'DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'FREE_TIER_ONLY', 'E2B_CREDIT_MILLS', 'E2B_CREDIT_LASTING_MILLS', 'E2B_CREDIT_EXPIRES', 'E2B_TEMPLATE',
  'EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'FIRECRAWL_API_KEY', 'E2B_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'COINGECKO_DEMO_KEY', 'FRED_API_KEY', 'RESEND_API_KEY',
]) delete process.env[name];

/** Every key this suite makes up. None may be printed, logged, stored as an error or thrown. */
const KEYS = {
  env: 'tvly-env-0000-aaaa-1111',
  a: 'tvly-stored-a-2222-bbbb',
  b: 'tvly-stored-b-3333-cccc',
  wide: 'tvly-wide-ceiling-9999-zzzz',
  fc1: 'fc-hobby-4444-dddd',
  fc2: 'fc-free-5555-eeee',
  // Another key ending in the same four characters as `env`, and one that does not.
  twin: 'tvly-twin-9999-zzzz-1111',
  replaced: 'tvly-replaced-7777-2222',
  e2bEnv: 'e2b_env_6666_ffff',
  e2b: 'e2b_stored_7777_gggg',
  exa: 'exa-good-1212-jjjj',
  bad: 'not-a-real-key-1616-nnnn',
  noTemplate: 'e2b_no_template_1717_oooo',
};
const leaks = (text) => Object.entries(KEYS).filter(([, key]) => String(text).includes(key)).map(([name]) => name);

// What the code under test says is kept apart from what this suite prints, so both can be searched.
const print = console.log.bind(console);
const printed = [];
const heard = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => heard.push(args.map(String).join(' '));
/** Every message keyPool threw at a caller here. */
const thrown = [];

let failures = 0;
const section = (name) => {
  printed.push(name);
  print(`\n\x1b[1m${name}\x1b[0m`);
};
const check = (label, pass, detail = '') => {
  const line = `${label}${detail ? ` — ${detail}` : ''}`;
  printed.push(line);
  print(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${line}`);
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
const { periodOf } = tiers;

let added = 0;
/** A key stored as Task 4's route will store it: sealed to its service and row. */
const addKey = async (service, key, { ceiling = null, label = null } = {}) => {
  const id = `sk${(added += 1)}`;
  await store.addServiceKey({ id, service, sealed: encryptSecret(key, serviceKeyContext(service, id)), fingerprint: sha256(`${service}:${key}`), hint: key.slice(-4), label, ceiling, addedBy: null });
  return id;
};
const resetCounts = () => sql.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:%' OR bucket LIKE 'paid:%'");
const fresh = (service) => pool.keysFor(service, { fresh: true });
const entry = async (service, id) => (await pool.keysFor(service)).find((k) => k.id === id);
const limitOf = async (service) => (await tiers.allowance(service)).limit;
const month = periodOf('month').key;
/** A provider's refusal as a caller hands it to withKey: its status, and what it said. */
const refusal = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
const caught = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    thrown.push(String(err?.message));
    return err;
  }
};

/* ── the providers, answered here ──────────────────────────────────── */

const realFetch = globalThis.fetch;
const asked = [];
const answers = new Map();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const headers = new Headers(init.headers || {});
  asked.push({ host: u.host, path: u.pathname, query: u.searchParams, headers });
  const answer = answers.get(`${u.host}${u.pathname}`);
  if (answer) return answer(u, headers);
  throw new TypeError('fetch failed');
};
const bearer = (headers) => String(headers.get('authorization') || '').replace(/^Bearer /, '');

try {
  section('capacity is the sum of the keys, and follows them without a restart');
  let a;
  let c;
  {
    process.env.TAVILY_API_KEY = KEYS.env;
    a = await addKey('tavily', KEYS.a, { label: 'account 2' });
    const b = await addKey('tavily', KEYS.b);
    const keys = await fresh('tavily');
    check("the environment's key first, then the stored ones in the order added", keys.map((k) => k.id).join() === `env,${a},${b}` && keys[0].fromEnv && !keys[1].fromEnv && keys[1].label === 'account 2', keys.map((k) => k.id).join());
    check('  each opened, its hint its last four characters', keys[1].key === KEYS.a && keys[1].hint === KEYS.a.slice(-4) && keys[0].hint === KEYS.env.slice(-4) && keys.every((k) => k.state === 'ok'));
    check("two stored Tavily keys and the environment's: 3 × 950", (await limitOf('tavily')) === 2850, String(await limitOf('tavily')));
    await store.deleteServiceKey(b);
    check('  one removed is still counted until this instance looks again', (await limitOf('tavily')) === 2850);
    await fresh('tavily');
    check('  and not once it has: 1,900', (await limitOf('tavily')) === 1900, String(await limitOf('tavily')));

    c = await addKey('tavily', KEYS.b);
    pool.__testing.age(31_000);
    check('another instance\'s change with the version unmoved is not read again', (await limitOf('tavily')) === 1900);
    await store.setSetting('service_keys_version', 42);
    pool.__testing.age(31_000);
    check('  with service_keys_version moved, it is, after 30 s: 2,850 again', (await limitOf('tavily')) === 2850, String(await limitOf('tavily')));
    const wide = await addKey('tavily', KEYS.wide, { ceiling: 4000 });
    await pool.bumpKeysVersion();
    check('bumpKeysVersion drops this instance\'s copy at once, and moves the version', (await limitOf('tavily')) === 6850 && (await store.getSetting('service_keys_version')) !== 42, String(await limitOf('tavily')));
    check('  a stored ceiling is the owner\'s override of the default', (await pool.ceilingOf('tavily', await entry('tavily', wide), new Date())) === 4000);

    section('choosing a key: the largest share left');
    await tiers.spend('tavily', 300);
    await tiers.spend('tavily', 100, undefined, { keyId: a });
    await tiers.spend('tavily', 500, undefined, { keyId: c });
    await tiers.spend('tavily', 2400, undefined, { keyId: wide });
    let pick = await pool.pickKey('tavily', 1);
    check('the key with the largest share left answers (850 of 950)', pick?.key.id === a && pick.paid === false, JSON.stringify({ id: pick?.key.id, paid: pick?.paid }));
    await tiers.spend('tavily', 400, undefined, { keyId: a });
    pick = await pool.pickKey('tavily', 1);
    check('  by share, not amount: 650 of 950 before 1,600 of 4,000', pick?.key.id === 'env', pick?.key.id);
    check('  a key without room for the call is passed over', (await pool.pickKey('tavily', 1601)) === null && (await pool.pickKey('tavily', 1600))?.key.id === wide);
    await store.deleteServiceKey(wide);
    await pool.bumpKeysVersion();
    await resetCounts();
    check('  ties go to the earliest key', (await pool.pickKey('tavily', 1))?.key.id === 'env');
    check('poolHas: a service with a key has it; one with none does not', pool.poolHas('tavily') && !pool.poolHas('exa'));
    process.env.EXA_API_KEY = KEYS.exa;
    check("  the environment's key counts on its own", pool.poolHas('exa'));
    delete process.env.EXA_API_KEY;
  }

  section('a refusal hands over to the next key, and sets the first aside as it deserves');
  {
    let order = [];
    /** A call that fails as `fail` says for a key, and otherwise answers with the key's id. */
    const run = (fail) => async (key, meta) => {
      order.push(meta.id);
      const err = fail(key, meta);
      if (err) throw err;
      return meta.id;
    };
    const healthy = async () => {
      for (const id of ['env', a, c]) await pool.markKey('tavily', id, 'ok');
      order = [];
    };

    let got = await pool.withKey('tavily', 1, run((key) => (key === KEYS.env ? refusal(401, { body: { detail: { error: 'Unauthorized: missing or invalid API key.' } } }) : null)));
    check('a 401: that key is refused, and the next one answers', got === a && order.join() === `env,${a}` && (await entry('tavily', 'env')).state === 'invalid', `${got} · ${order.join()}`);
    check("  the environment key's state is kept in the settings, for the other instances", (await store.getSetting('service_env_state'))?.tavily?.state === 'invalid');
    check('  and it is not chosen again', (await pool.pickKey('tavily', 1))?.key.id === a);
    await healthy();

    const before = Date.now();
    got = await pool.withKey('tavily', 1, run((key) => (key === KEYS.env ? refusal(432, { body: { detail: { error: "This request exceeds your plan's set usage limit." } } }) : null)));
    const spent = await entry('tavily', 'env');
    check("Tavily's 432: spent until its month ends, and the next key answers", got === a && spent.state === 'exhausted' && spent.retryAt === periodOf('month').ends.getTime(), `${spent.state} ${spent.retryAt}`);
    await healthy();

    got = await pool.withKey('tavily', 1, run((key) => (key === KEYS.env ? refusal(429, { headers: new Headers({ 'retry-after': '5' }) }) : null)));
    const cooling = await entry('tavily', 'env');
    check('a 429 asking for 5 s: waits 30 s, the least, while the next key answers', got === a && cooling.state === 'cooling' && cooling.retryAt - before >= 30_000 && cooling.retryAt - Date.now() <= 30_000, `${cooling.state} ${cooling.retryAt - before}`);
    await healthy();

    got = await pool.withKey('tavily', 1, run((key, meta) => (meta.id !== c ? refusal(401, { message: `invalid key ${key}` }) : null)));
    const row = (await store.listServiceKeys('tavily')).find((r) => r.id === a);
    check("a stored key refused is marked on its row, for every instance", got === c && row.state === 'invalid' && !!row.state_at, `${got} ${row.state}`);
    check('  its error kept short, and with the key itself taken out of it', !!row.last_error && leaks(row.last_error).length === 0, String(row.last_error).slice(0, 60));
    await healthy();

    await sql.query("UPDATE service_keys SET state = 'cooling', retry_at = NOW() - INTERVAL '1 second' WHERE id = $1", [a]);
    await fresh('tavily');
    check('a key whose wait is over is healthy again', (await entry('tavily', a)).state === 'ok' && (await entry('tavily', a)).retryAt === null);
    await healthy();

    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    got = await pool.withKey('tavily', 1, run((key) => (key === KEYS.env ? timeout : null)));
    check('a timeout: the next key once, and the first left as it was', got === a && order.join() === `env,${a}` && (await entry('tavily', 'env')).state === 'ok', order.join());
    await healthy();

    const down = await caught(pool.withKey('tavily', 1, run(() => refusal(503))));
    check('  a second in a row: the service may be down for every key — its error, not a third key', down?.status === 503 && order.join() === `env,${a}`, `${down?.message} · ${order.join()}`);
    await healthy();

    const bad = await caught(pool.withKey('tavily', 1, run(() => refusal(400, { body: { detail: { error: 'Bad query' } } }))));
    check('an error that is not about the key goes straight back, and no key is blamed', bad?.status === 400 && order.join() === 'env' && (await entry('tavily', 'env')).state === 'ok', order.join());
    await healthy();

    const none = await caught(pool.withKey('tavily', 1, run((key) => refusal(key === KEYS.env ? 401 : key === KEYS.a ? 402 : 429))));
    check('every key refused: the service stands aside, as a spent allowance does', none?.skip === true && none.message === 'tavily: no key with room' && order.join() === `env,${a},${c}`, `${none?.message} · ${order.join()}`);
    await healthy();
  }

  section('what each refusal is (classify)');
  {
    const cases = [
      ['tavily', { status: 401 }, 'invalid'],
      ['e2b', { status: 403, body: { code: 403, message: 'team is blocked' } }, 'invalid'],
      ['exa', { status: 401, body: { requestId: 'r', error: 'Invalid API key', tag: 'INVALID_API_KEY' } }, 'invalid'],
      ['exa', { status: 402, body: { error: 'No more credits', tag: 'NO_MORE_CREDITS' } }, 'exhausted'],
      ['exa', { status: 402, code: 'TEAM_BUDGET_EXCEEDED' }, 'exhausted'],
      ['exa', { status: 429, body: { tag: 'RATE_LIMIT_EXCEEDED' } }, 'cooling'],
      ['brave', { status: 422, body: { type: 'ErrorResponse', error: { status: 422, code: 'SUBSCRIPTION_TOKEN_INVALID' } } }, 'invalid'],
      ['brave', { status: 422, body: { error: { code: 'VALIDATION' } } }, null],
      ['tavily', { status: 432 }, 'exhausted'],
      ['tavily', { status: 433 }, 'exhausted'],
      ['firecrawl', { status: 432 }, null],
      ['firecrawl', { status: 402 }, 'exhausted'],
      ['firecrawl', { status: 429, body: { error: 'Rate limit exceeded' } }, 'cooling'],
      // A site Firecrawl will not read is the page's refusal; a token it will not take is the key's.
      ['firecrawl', { status: 403, body: { success: false, error: 'This website is no longer supported, please reach out to help@firecrawl.com' } }, null],
      ['firecrawl', { status: 403, body: { success: false, error: 'Unauthorized: Invalid token' } }, 'invalid'],
      ['brave', { status: 429 }, 'cooling'],
      ['e2b', { status: 401, body: { code: 401, message: 'Invalid API key' } }, 'invalid'],
      ['exa', { status: 0, cause: { code: 'ECONNRESET' } }, 'transient'],
      ['tavily', { status: 500 }, 'transient'],
      ['tavily', { status: 503 }, 'transient'],
      ['tavily', { name: 'TimeoutError' }, 'transient'],
      ['tavily', { name: 'AbortError' }, null],
      ['tavily', { status: 404 }, null],
    ];
    const wrong = cases.filter(([service, err, want]) => pool.classify(service, err) !== want).map(([service, err, want]) => `${service} ${JSON.stringify(err)} → ${pool.classify(service, err)}, not ${want}`);
    check(`${cases.length} refusals, each its class: refused · spent · waiting · try the next once · not the key's doing`, wrong.length === 0, wrong.join(' | '));
  }

  section('the buckets: the environment key keeps today\'s names, so this month carries over');
  {
    const at = new Date('2026-11-17T09:00:00Z');
    check("the environment key's: free:tavily:2026-11", pool.keyBucket('tavily', 'env', at).bucket === 'free:tavily:2026-11' && pool.keyBucket('tavily', 'env', at).ends.toISOString() === '2026-12-01T00:00:00.000Z');
    check(`  a stored key's: free:tavily@<id>:2026-11`, pool.keyBucket('tavily', a, at).bucket === `free:tavily@${a}:2026-11`, pool.keyBucket('tavily', a, at).bucket);
    check('  a paid key\'s, apart: paid:tavily@<id>:2026-11', pool.keyBucket('tavily', a, at, { paid: true }).bucket === `paid:tavily@${a}:2026-11` && pool.keyBucket('tavily', 'env', at, { paid: true }).bucket === 'paid:tavily@env:2026-11');
    check("  Firecrawl's free index keeps its own day", pool.keyBucket('firecrawl_index', 'env', at).bucket === 'free:firecrawl_index:2026-11-17' && pool.keyBucket('firecrawl_index', 'k1', at).bucket === 'free:firecrawl_index@k1:2026-11-17');
    check('  a service with one key of its own and no pool has no key bucket', pool.keyBucket('google', 'env', at) === null && pool.keyBucket('resend', 'env', at) === null);
    await resetCounts();
    await tiers.spend('tavily', 3, undefined, { keyId: a });
    await tiers.spend('tavily', 2);
    check('spend counts against the key it is given; the old call shape is the environment key', (await store.readCounter(`free:tavily@${a}:${month}`)) === 3 && (await store.readCounter(`free:tavily:${month}`)) === 2);
    check('  and the service is the sum of them', (await tiers.allowance('tavily')).left === 2850 - 5);
    await tiers.refund('tavily', 3, undefined, { keyId: a });
    check('  refund gives back to that key', (await store.readCounter(`free:tavily@${a}:${month}`)) === 0);
    process.env.TAVILY_FREE_CREDITS = '4';
    const took = [];
    for (let i = 0; i < 4; i += 1) took.push(await tiers.take('tavily', 1, undefined, { keyId: c }));
    check("take holds a key to its own ceiling, and leaves the others' alone", took.join() === 'true,true,true,true' && (await tiers.take('tavily', 1, undefined, { keyId: c })) === false && (await tiers.take('tavily', 1)) === true, took.join());
    await tiers.exhaust('tavily', undefined, { keyId: a });
    check('  exhaust fills one key to its ceiling', (await pool.leftOf('tavily', await entry('tavily', a), new Date())) === 0 && (await pool.leftOf('tavily', await entry('tavily', 'env'), new Date())) > 0);
    delete process.env.TAVILY_FREE_CREDITS;
    await resetCounts();
  }

  section('the paid key: only past every free key, only for a charged call, only under its cap');
  {
    for (const k of await pool.keysFor('tavily')) await tiers.spend('tavily', 950, undefined, { keyId: k.id });
    await pool.setPaidKey('tavily', a, 5);
    const paid = await pool.paidKeyOf('tavily');
    check('the owner chose one key, with a monthly cap', paid?.keyId === a && paid.capMonthly === 5, JSON.stringify(paid));
    const free = await caught(pool.withKey('tavily', 1, async () => 'answered', { paid: false }));
    check('every free key full: a call nobody is charged for stands aside — nothing billed', free?.skip === true, String(free?.message));
    // As withKey says a charged call must: held with take before it is made, not made when take says no.
    const charged = (need) => pool.withKey('tavily', need, async (key, meta) => {
      if (!(await tiers.take('tavily', need, undefined, { keyId: meta.id, paid: meta.paid }))) throw Object.assign(new Error('held back at the cap'), { skip: true });
      return { mine: key === KEYS.a, id: meta.id, paid: meta.paid };
    }, { paid: true });
    const first = await charged(2);
    check('a charged call goes to the paid key, past its free ceiling', first.mine && first.id === a && first.paid === true, JSON.stringify(first));
    check(`  counted apart, under paid:tavily@<id>:${month}`, (await store.readCounter(`paid:tavily@${a}:${month}`)) === 2);
    await charged(3);
    const capped = await caught(charged(1));
    check('  and it stops at its monthly cap', capped?.skip === true && (await store.readCounter(`paid:tavily@${a}:${month}`)) === 5, String(await store.readCounter(`paid:tavily@${a}:${month}`)));
    check('  take, for a paid call, holds to the cap too', (await tiers.take('tavily', 1, undefined, { keyId: a, paid: true })) === false);
    await pool.setPaidKey('tavily', a, 10);
    process.env.FREE_TIER_ONLY = 'false';
    const lifted = await pool.pickKey('tavily', 1);
    check('with the ceilings lifted (FREE_TIER_ONLY=false) any call may use it', lifted?.key.id === a && lifted.paid === true);
    delete process.env.FREE_TIER_ONLY;
    await pool.markKey('tavily', a, 'invalid', { error: 'refused even a paid call' });
    check('a paid key that is refused stands aside, and nothing takes its place by itself', (await pool.pickKey('tavily', 1, { paid: true })) === null);
    await pool.markKey('tavily', a, 'ok');
    const refusedChoice = await caught(pool.setPaidKey('tavily', 'sk-not-here', null));
    check('only one of its own keys can be chosen', !!refusedChoice && (await pool.paidKeyOf('tavily'))?.keyId === a, String(refusedChoice?.message));
    await pool.setPaidKey('tavily', null);
    check('  and the choice can be cleared', (await pool.paidKeyOf('tavily')) === null && (await pool.pickKey('tavily', 1, { paid: true })) === null);
    await resetCounts();
  }

  section("Firecrawl: each key's plan read from Firecrawl, and the shares of their sum");
  {
    const plans = { [KEYS.fc1]: { plan: 5000, left: 4800 }, [KEYS.fc2]: { plan: 1000, left: 1000 } };
    answers.set('api.firecrawl.dev/v2/team/credit-usage', (u, headers) => {
      const p = plans[bearer(headers)];
      return p
        ? json({ success: true, data: { remainingCredits: p.left, planCredits: p.plan, billingPeriodStart: null, billingPeriodEnd: '2099-01-01T00:00:00Z' } })
        : json({ success: false, error: 'Unauthorized: Invalid token' }, 401);
    });
    const f1 = await addKey('firecrawl', KEYS.fc1);
    const f2 = await addKey('firecrawl', KEYS.fc2);
    await fresh('firecrawl');
    check('before Firecrawl is asked, 950 a key', (await limitOf('firecrawl')) === 1900, String(await limitOf('firecrawl')));
    for (const k of await pool.keysFor('firecrawl')) await pool.liveUsage('firecrawl', k, { fresh: true });
    check('after: 95% of each plan — 4,750 for Hobby\'s 5,000, 950 for Free\'s 1,000', (await limitOf('firecrawl')) === 5700, String(await limitOf('firecrawl')));
    const shares = { search: await limitOf('firecrawl_search'), scrape: await limitOf('firecrawl_scrape'), more: await limitOf('firecrawl_more'), index: await limitOf('firecrawl_index') };
    check('  searches 60% of the sum, pages 35%, the rest 5%; the free index 950 a day each', shares.search === 3420 && shares.scrape === 1995 && shares.more === 285 && shares.index === 1900, JSON.stringify(shares));
    const row = (await store.listServiceKeys('firecrawl')).find((r) => r.id === f1);
    check('  the figure is kept on the key\'s row, its plan named', row.live?.limit === 5000 && row.live.used === 200 && row.live.plan === 'Hobby' && !!row.live.at, JSON.stringify(row.live));
    const sent = asked.filter((q) => q.host === 'api.firecrawl.dev');
    check('  each asked with its own key, at the fixed address', sent.length === 2 && sent.every((q) => q.path === '/v2/team/credit-usage') && bearer(sent[0].headers) === KEYS.fc1 && bearer(sent[1].headers) === KEYS.fc2);
    plans[KEYS.fc2].left = 100;
    await pool.liveUsage('firecrawl', await entry('firecrawl', f2), { fresh: true });
    check("Firecrawl's own count of what is left is believed when lower than ours, never when higher", (await tiers.allowance('firecrawl')).left === 4750 + 100, String((await tiers.allowance('firecrawl')).left));
    await tiers.spend('firecrawl', 40, undefined, { keyId: f2 });
    check('  and keeps falling as calls are counted here, until it is asked again', (await pool.leftOf('firecrawl', await entry('firecrawl', f2), new Date())) === 60);
    const count = asked.length;
    await pool.liveUsage('firecrawl', await entry('firecrawl', f1));
    check('  asked again only when the last answer is two minutes old', asked.length === count);
    await resetCounts();
  }

  section('Tavily: the plan read from Tavily; E2B and Brave one key each; the rest as before');
  {
    answers.set('api.tavily.com/usage', (u, headers) => {
      if (bearer(headers) === KEYS.a) return json({ key: { usage: 120, limit: 2000 }, account: { current_plan: 'Researcher', plan_usage: 300, plan_limit: 1000 } });
      if (bearer(headers) === KEYS.env) return json({ key: { usage: 10, limit: null }, account: { current_plan: 'Researcher', plan_usage: 10, plan_limit: 1000 } });
      return json({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401);
    });
    const live = await pool.liveUsage('tavily', await entry('tavily', a), { fresh: true });
    check("Tavily's /usage: the key's own limit when it has one", live?.plan === 'Researcher' && live.used === 120 && live.limit === 2000 && (await pool.ceilingOf('tavily', await entry('tavily', a), new Date())) === 1900, JSON.stringify(live));
    const envLive = await pool.liveUsage('tavily', await entry('tavily', 'env'), { fresh: true });
    check("  the account's plan when the key has none — the environment key's figure kept in memory", envLive?.limit === 1000 && envLive.used === 10 && (await entry('tavily', 'env')).live?.limit === 1000);
    check('  a service whose provider says no figure has none', (await pool.liveUsage('exa', { id: 'env', key: KEYS.exa, hint: 'jjjj', live: null })) === null);

    const caps = Object.fromEntries(Object.entries(pool.POOLED).map(([service, p]) => [service, p.maxKeys]));
    check('Exa, Tavily and Firecrawl take ten keys at most; Brave and E2B keep their one (owner, 2026-11-12)', JSON.stringify(caps) === JSON.stringify({ exa: 10, tavily: 10, firecrawl: 10, brave: 1, e2b: 1 }), JSON.stringify(caps));
    process.env.E2B_API_KEY = KEYS.e2bEnv;
    // A row the add route would refuse, put straight into the table: still never used.
    const stray = await addKey('e2b', KEYS.e2b);
    const e2bKeys = await fresh('e2b');
    const cap = tiers.e2bMonthCap({ now: new Date() });
    check('E2B: its one key, the environment\'s, and the month its credit allows', e2bKeys.map((k) => k.id).join() === 'env' && (await limitOf('e2b')) === cap, `${e2bKeys.map((k) => k.id).join()} · ${await limitOf('e2b')} vs ${cap}`);
    await tiers.spend('e2b', 25);
    check('  spent against its whole credit, as before', (await store.readCounter('free:e2b:total')) === 25 && (await store.readCounter(`free:e2b@${stray}:total`)) === 0);
    await store.deleteServiceKey(stray);
    delete process.env.E2B_API_KEY;

    const outside = ['google', 'coingecko', 'fred', 'resend', 'stackexchange'];
    check('Google, CoinGecko, FRED and Resend are not in the pool', outside.every((s) => !pool.POOLED[s] && !pool.poolHas(s)) && !('google' in pool.NOT_POOLED) && 'stackexchange' in pool.NOT_POOLED);
    const before = { google: await limitOf('google'), coingecko: await limitOf('coingecko'), minute: await limitOf('coingecko_minute'), fred: await limitOf('fred') };
    await tiers.spend('google', 3);
    check('  and are counted as before: one bucket by period, the same ceilings', JSON.stringify(before) === JSON.stringify({ google: 450, coingecko: 9500, minute: 90, fred: 100 }) && (await store.readCounter(`free:google:${periodOf('day').key}`)) === 3 && !tiers.FREE_SERVICES.some((s) => s.startsWith('resend')), JSON.stringify(before));
    await resetCounts();
  }

  section('checking a key: a fixed address per service, the key never echoed');
  {
    answers.set('api.exa.ai/websets/v0/teams/me', (u, h) => (h.get('x-api-key') === KEYS.exa ? json({ object: 'team', id: 't' }) : json({ error: 'Invalid API key', tag: 'INVALID_API_KEY' }, 401)));
    answers.set('api.e2b.app/v2/sandboxes', (u, h) => ([KEYS.e2b, KEYS.noTemplate].includes(h.get('x-api-key')) ? json([]) : json({ code: 401, message: 'Invalid API key' }, 401)));
    answers.set('api.e2b.app/templates/aliases/synapsez-computer', (u, h) => (h.get('x-api-key') === KEYS.e2b ? json({ templateID: 'x', public: false }) : json({ code: 404, message: 'not found' }, 404)));
    const good = { exa: KEYS.exa, tavily: KEYS.a, firecrawl: KEYS.fc1, e2b: KEYS.e2b };
    const results = {};
    for (const [service, key] of Object.entries(good)) results[service] = { good: await pool.checkKey(service, key), bad: await pool.checkKey(service, KEYS.bad) };
    const wrong = Object.entries(results).filter(([, r]) => r.good.ok !== true || r.bad.ok !== false || r.bad.reason !== 'refused').map(([s, r]) => `${s} ${JSON.stringify(r)}`);
    check('Exa, Tavily, Firecrawl, E2B: their own key passes, a wrong one is refused', wrong.length === 0, wrong.join(' | '));
    check('  Tavily and Firecrawl say the plan', results.tavily.good.plan === 'Researcher' && results.firecrawl.good.plan === 'Hobby', JSON.stringify([results.tavily.good, results.firecrawl.good]));
    const hosts = [...new Set(asked.map((q) => `${q.host}${q.path}`))].sort();
    const fixed = ['api.e2b.app/templates/aliases/synapsez-computer', 'api.e2b.app/v2/sandboxes', 'api.exa.ai/websets/v0/teams/me', 'api.firecrawl.dev/v2/team/credit-usage', 'api.tavily.com/usage'];
    check('  only the fixed addresses were asked, each with the key in its header', hosts.every((h) => fixed.includes(h)) && asked.every((q) => ![...q.query.values()].some((v) => leaks(v).length)), hosts.join(' '));
    const before = asked.length;
    check('Brave has no free check: passed without a call, checked on first use', (await pool.checkKey('brave', KEYS.bad)).ok === true && asked.length === before);
    check("an E2B account without the Synapsez template is said so", JSON.stringify(await pool.checkKey('e2b', KEYS.noTemplate)) === JSON.stringify({ ok: false, reason: 'template' }));
    answers.delete('api.exa.ai/websets/v0/teams/me');
    check('a provider that cannot be reached is said so, not called a refusal', (await pool.checkKey('exa', KEYS.exa)).reason === 'unreachable');
    // Since `before`: two calls for E2B's, one for the unreachable Exa.
    check('  nor is a key with a line break in it sent at all', (await pool.checkKey('tavily', `${KEYS.a}\r\nX: y`)).reason === 'refused' && asked.length === before + 3, String(asked.length - before));
    check('a service outside the pool has no check', (await pool.checkKey('stackexchange', KEYS.bad)).ok === false && (await pool.checkKey('google', KEYS.bad)).ok === false && asked.length === before + 3);
  }

  section("the administrators' view: every key by its hint, whose figure it is, the paid key");
  {
    await pool.setPaidKey('tavily', c, 300);
    await tiers.spend('tavily', 4, undefined, { keyId: c, paid: true });
    const report = await tiers.freeTierReport();
    const tav = report.pool?.find((s) => s.service === 'tavily');
    check('freeTierReport carries the pool: the five pooled services and the two that cannot be', report.pool?.length === 7 && report.pool.filter((s) => s.pooled).map((s) => s.service).join() === 'exa,tavily,firecrawl,brave,e2b' && report.services.some((s) => s.service === 'tavily'), JSON.stringify(report.pool?.map((s) => s.service)));
    check('  Tavily\'s keys by hint and label, the environment\'s first', tav?.keys.map((k) => k.id).join() === `env,${a},${c}` && tav.keys[0].fromEnv && tav.keys[1].hint === KEYS.a.slice(-4) && tav.keys[1].label === 'account 2', JSON.stringify(tav?.keys.map((k) => [k.id, k.hint])));
    check('  whose figure each is: Tavily\'s own, or counted here', tav?.keys[1].source === 'provider' && tav.keys[1].plan === 'Researcher' && tav.keys[1].limit === 2000 && tav.keys[2].source === 'counted' && tav.keys[2].limit === 950 && tav.keys[2].used === 4, JSON.stringify(tav?.keys[2]));
    check('  the paid key marked, with what it spent this month', tav?.keys[2].paid === true && tav.keys[1].paid === false && tav.paid?.keyId === c && tav.paid.capMonthly === 300 && tav.paid.spent === 4, JSON.stringify(tav?.paid));
    const se = report.pool?.find((s) => s.service === 'stackexchange');
    check('  a service that cannot pool says why', se?.pooled === false && se.note === 'freetier.notPooled.stackexchange' && se.keys.length === 0 && se.paid === null, JSON.stringify(se));
    const services = Object.fromEntries(report.services.map((s) => [s.service, s]));
    // Tavily: 95% of key a's own 2,000, of the environment account's 1,000, and the default 950.
    check('  and the services table sums the keys: Tavily 1,900 + 950 + 950, Firecrawl from its live plans', services.tavily.limit === 3800 && services.tavily.used === 4 && services.firecrawl_search.limit === 3420, JSON.stringify([services.tavily, services.firecrawl_search]));
    const text = JSON.stringify(report);
    check('  no key, sealed value or fingerprint in it', leaks(text).length === 0 && !/"(sealed|fingerprint|key)":/.test(text), leaks(text).join());
    await pool.setPaidKey('tavily', null);
    await resetCounts();
  }

  section("a replaced environment key starts afresh; the key put back keeps its state (review, round 1)");
  {
    process.env.TAVILY_API_KEY = KEYS.env;
    await fresh('tavily');
    answers.set('api.tavily.com/usage', (u, headers) => json({ key: { usage: 1, limit: bearer(headers) === KEYS.env ? 400 : null }, account: { current_plan: 'Researcher', plan_usage: 1, plan_limit: 1000 } }));
    await pool.liveUsage('tavily', await entry('tavily', 'env'), { fresh: true });
    await pool.markKey('tavily', 'env', 'invalid', { error: 'HTTP 401' });
    check('the environment key refused, its own plan read', (await entry('tavily', 'env')).state === 'invalid' && (await entry('tavily', 'env')).live?.limit === 400);
    process.env.TAVILY_API_KEY = KEYS.twin;
    const twin = await entry('tavily', 'env');
    check('  another key in its place — one ending in the same four characters — has neither its state nor its figure', twin.hint === KEYS.env.slice(-4) && twin.state === 'ok' && twin.live === null && (await pool.pickKey('tavily', 1))?.key.id === 'env', JSON.stringify({ state: twin.state, live: twin.live }));
    process.env.TAVILY_API_KEY = KEYS.replaced;
    const other = await import('../server/keyPool.js?instance=redeployed');
    const there = (await other.keysFor('tavily', { fresh: true }))[0];
    check('  nor has a key put in its place on a fresh instance reading the same database', there?.hint === KEYS.replaced.slice(-4) && there.state === 'ok' && (await other.pickKey('tavily', 1))?.key.id === 'env', JSON.stringify({ hint: there?.hint, state: there?.state }));
    process.env.TAVILY_API_KEY = KEYS.env;
    check('  the refused key put back is still refused, here and there', (await entry('tavily', 'env')).state === 'invalid' && (await other.keysFor('tavily', { fresh: true }))[0]?.state === 'invalid');
    check('  the saved state names its key by a hash, never by the key', !!(await store.getSetting('service_env_state'))?.tavily?.id && leaks(JSON.stringify(await store.getSetting('service_env_state'))).length === 0);

    const version = () => store.getSetting('service_keys_version');
    const asides = () => heard.filter((line) => line.includes('a key set aside')).length;
    const before = { version: await version(), asides: asides() };
    await pool.markKey('tavily', 'env', 'invalid', { error: 'HTTP 401' });
    await pool.markKey('tavily', c, 'ok');
    check('marking a key as it already is writes nothing, moves no version, logs nothing', (await version()) === before.version && asides() === before.asides, `${before.version} → ${await version()}`);
    await pool.markKey('tavily', 'env', 'ok');
    check('  a real change still does', (await version()) !== before.version && (await entry('tavily', 'env')).state === 'ok');
    answers.delete('api.tavily.com/usage');
  }

  section("a charged call is held to the paid key's cap — all at once, and when the count cannot be written (review, round 1)");
  {
    await resetCounts();
    await pool.setPaidKey('tavily', 'env', 3);
    const took = await Promise.all(Array.from({ length: 6 }, () => tiers.take('tavily', 1, undefined, { keyId: 'env', paid: true })));
    check('six charged calls at once against a cap of three: three go, and three are counted', took.filter(Boolean).length === 3 && (await store.readCounter(`paid:tavily@env:${month}`)) === 3 && (await store.readCounter(`free:tavily:${month}`)) === 3, JSON.stringify(took));
    await resetCounts();
    await pool.setPaidKey('tavily', 'env', 5);
    const write = store.addToCounter;
    store.addToCounter = async () => {
      throw new Error('database away');
    };
    const down = { paid: await tiers.take('tavily', 1, undefined, { keyId: 'env', paid: true }), free: await tiers.take('tavily', 1) };
    process.env.FREE_TIER_ONLY = 'false';
    down.lifted = await tiers.take('tavily', 1, undefined, { keyId: 'env', paid: true });
    delete process.env.FREE_TIER_ONLY;
    store.addToCounter = write;
    check("a count that cannot be written: a charged call does not go, ceilings lifted or not — the cap is the owner's", down.paid === false && down.lifted === false, JSON.stringify(down));
    check('  while an uncharged Tavily call goes, as before (Tavily refuses by itself once spent)', down.free === true);
    await tiers.take('tavily', 1, undefined, { keyId: 'env', paid: true });
    // The paid count's own write fails; anything taken back afterwards goes through.
    store.addToCounter = async (bucket, amount, until) => {
      if (String(bucket).startsWith('paid:') && amount > 0) throw new Error('database away');
      return write.call(store, bucket, amount, until);
    };
    const half = await tiers.take('tavily', 1, undefined, { keyId: 'env', paid: true });
    store.addToCounter = write;
    const counts = { free: await store.readCounter(`free:tavily:${month}`), paid: await store.readCounter(`paid:tavily@env:${month}`) };
    check('  one whose paid count fails half way: refused, its free count given back, the paid count untouched', half === false && counts.free === 1 && counts.paid === 1, JSON.stringify({ half, ...counts }));
    await pool.setPaidKey('tavily', null);
    await resetCounts();
  }

  section('the keys stay on the server');
  {
    const rows = await store.listServiceKeys();
    const stored = rows.map((r) => `${r.last_error || ''} ${JSON.stringify(r.live || {})}`).join('\n');
    const settings = JSON.stringify(await sql.query("SELECT value FROM settings WHERE key LIKE 'service_%'"));
    check('nothing printed, logged or thrown here carries a key', leaks([...printed, ...heard, ...thrown].join('\n')).length === 0, leaks([...printed, ...heard, ...thrown].join('\n')).join());
    check('  nor any error or figure kept in the database', leaks(stored).length === 0 && leaks(settings).length === 0, leaks(stored + settings).join());
    check('  and something was logged, so this looked at real lines', heard.length > 0, String(heard.length));
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures) {
  // What the code said, with every made-up key taken out, to see why.
  const scrub = (line) => Object.values(KEYS).reduce((text, key) => text.split(key).join('[key]'), line);
  for (const line of heard) print(`  \x1b[2m${scrub(line)}\x1b[0m`);
}
print(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
