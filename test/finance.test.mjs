/**
 * The finance layer (server/finance/): the cache table, the pooled ceilings, the
 * one fetch helper, the cache, the Vietnamese market rules, every source adapter
 * against its recorded answer, and the tool's answer.
 *
 * No network. Each source is played by its recorded answer from
 * test/fixtures/finance/ (trimmed from the research probes), served by a stand-in
 * `fetch` that also records what was asked, so what is pinned is how an answer is
 * read and what leaves the server.
 *
 *   node test/finance.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';

process.env.ENCRYPTION_KEY ||= 'finance-test-encryption-key';
// No waiting between calls to one host, except where the pacing itself is tested.
process.env.FIN_PACE_SCALE = '0';
delete process.env.SEC_USER_AGENT;
delete process.env.COINGECKO_DEMO_KEY;
delete process.env.FRED_API_KEY;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const memory = await PGlite.create();
const { initStore } = await import('../server/store/index.js');
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });

/* ── the cache table (schema 45) ───────────────────────────────────── */

section('finance_cache: one row per key, shared by every account (schema 45)');
{
  const later = new Date(Date.now() + 60_000);
  await store.financePut('yahoo|quote|AAPL|', { price: 350.69, currency: 'USD' }, later);
  const row = await store.financeGet('yahoo|quote|AAPL|');
  check('what was put is read back', row?.value?.price === 350.69 && row.value.currency === 'USD', JSON.stringify(row));
  check('  with when it was fetched and when it expires', row && !Number.isNaN(new Date(row.fetched_at).getTime()) && Math.abs(new Date(row.expires_at).getTime() - later.getTime()) < 1000);
  await store.financePut('yahoo|quote|AAPL|', { price: 351 }, later);
  check('putting the same key again replaces it', (await store.financeGet('yahoo|quote|AAPL|'))?.value?.price === 351);
  check('a key never put is nothing', (await store.financeGet('nobody|asked|this|')) === null);

  await store.financePut('kbs|quote|FPT|', { price: 50900 }, new Date(Date.now() - 60_000));
  const stale = await store.financeGet('kbs|quote|FPT|');
  check('an expired row is still returned — the caller decides what stale means', stale?.value?.price === 50900 && new Date(stale.expires_at) < new Date());

  await store.financePut('vndirect|bars|FPT|2026-09-18', { c: 71700 }, null);
  check('a row kept for good has no expiry', (await store.financeGet('vndirect|bars|FPT|2026-09-18'))?.expires_at === null);

  // What the sweep takes: expired more than a day ago, or kept for good and older than 400 days.
  await store.financePut('old|expired|x|', { a: 1 }, new Date(Date.now() - 2 * 86_400_000));
  await store.financePut('old|forever|x|', { a: 1 }, null);
  await memory.query(`UPDATE finance_cache SET fetched_at = NOW() - INTERVAL '401 days' WHERE key = 'old|forever|x|'`);
  const swept = await store.financeSweep();
  const left = (await memory.query('SELECT key FROM finance_cache ORDER BY key')).rows.map((r) => r.key);
  check('the sweep deletes what expired over a day ago and what was kept past 400 days', swept === 2 && !left.includes('old|expired|x|') && !left.includes('old|forever|x|'), `${swept} · ${left.join(', ')}`);
  check('  and leaves what expired a minute ago, and a bar kept for good', left.includes('kbs|quote|FPT|') && left.includes('vndirect|bars|FPT|2026-09-18'), left.join(', '));
  await memory.query('DELETE FROM finance_cache');
}

/* ── pooled ceilings: minutes and hours ───────────────────────────── */

const tiers = await import('../server/freeTier.js');

section('free tiers count by the minute and the hour too');
{
  const at = new Date('2026-11-10T08:15:42Z');
  const minute = tiers.periodOf('minute', at);
  check('a minute, in UTC, and when it ends', minute.key === '2026-11-10T08:15' && minute.ends.toISOString() === '2026-11-10T08:16:00.000Z', JSON.stringify(minute));
  const hour = tiers.periodOf('hour', at);
  check('an hour', hour.key === '2026-11-10T08' && hour.ends.toISOString() === '2026-11-10T09:00:00.000Z', JSON.stringify(hour));
  const late = tiers.periodOf('minute', new Date('2026-12-31T23:59:30Z'));
  check('  the last minute of a year ends at the next one', late.key === '2026-12-31T23:59' && late.ends.toISOString() === '2027-01-01T00:00:00.000Z', JSON.stringify(late));
  check('a day and a month are as they were', tiers.periodOf('day', at).key === '2026-11-10' && tiers.periodOf('month', at).key === '2026-11' && tiers.periodOf('month', at).ends.toISOString() === '2026-12-01T00:00:00.000Z');

  for (const name of ['coingecko', 'coingecko_minute', 'yahoo', 'vndirect', 'kbs', 'vietcap', 'sec', 'fred']) {
    check(`${name} has a pooled ceiling`, tiers.FREE_SERVICES.includes(name));
  }
  const gecko = await tiers.allowance('coingecko');
  check("CoinGecko's month is under its 10,000 credits", gecko.limit === 9_500 && gecko.left <= 9_500, JSON.stringify(gecko));
  process.env.COINGECKO_FREE_MONTHLY = '120';
  check('  and can be set', (await tiers.allowance('coingecko')).limit === 120);
  delete process.env.COINGECKO_FREE_MONTHLY;
  check('its minute is 90, under the Demo plan\'s 100', (await tiers.allowance('coingecko_minute')).limit === 90);
  check('FRED by the minute, SEC and the brokers by the day', (await tiers.allowance('fred')).limit === 100 && (await tiers.allowance('sec')).limit === 20_000 && (await tiers.allowance('kbs')).limit === 3_000 && (await tiers.allowance('yahoo')).limit === 5_000);

  process.env.FRED_FREE_MINUTE = '2';
  const took = [await tiers.take('fred', 1), await tiers.take('fred', 1), await tiers.take('fred', 1)];
  check('a minute\'s ceiling reached says no to the next call', took.join() === 'true,true,false', took.join());
  delete process.env.FRED_FREE_MINUTE;
  const report = await tiers.freeTierReport();
  const row = report.services.find((s) => s.service === 'coingecko_minute');
  check("the administrators' view lists them, each with its period", row?.per === 'minute' && report.services.some((s) => s.service === 'vndirect' && s.per === 'day'), JSON.stringify(row));
}

/* ── the one fetch ────────────────────────────────────────────────── */

const http = await import('../server/finance/http.js');
const chains = await import('../server/finance/chains.js');

/** A stand-in `fetch` that answers `status` with `body`, and records every call. */
function fakeFetch(answer = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, at: Date.now() });
    const { status = 200, body = {}, headers = {} } = answer(String(url), init) || {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  fn.calls = calls;
  return fn;
}
const refusal = async (promise) => promise.then(() => null, (err) => err);

section('http.js: every call says who it is, and nothing else');
{
  http.__resetHttp();
  const fetchImpl = fakeFetch(() => ({ body: { ok: 1 } }));
  const got = await http.getJson('kbs', 'https://kbbuddywts.kbsec.com.vn/x', { fetchImpl, headers: { Referer: 'https://www.kbsec.com.vn/', Origin: 'https://www.kbsec.com.vn', 'User-Agent': 'Mozilla/5.0 Chrome' } });
  const sent = fetchImpl.calls[0]?.headers || {};
  const ua = sent['User-Agent'];
  check('JSON comes back parsed', got?.ok === 1);
  check('an honest User-Agent, with the app\'s version', /^Synapsez\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/; market data on request\)$/.test(ua), ua);
  check('  never a Referer or Origin, and never the caller\'s own UA', !Object.keys(sent).some((k) => /^(referer|origin)$/i.test(k)) && !/Chrome/.test(ua), JSON.stringify(sent));
  await http.getJson('yahoo', 'https://query1.finance.yahoo.com/x', { fetchImpl });
  check('Yahoo keeps the Mozilla/5.0 it has always been sent — and only Yahoo', fetchImpl.calls[1].headers['User-Agent'] === 'Mozilla/5.0');

  const secCalls = fakeFetch();
  const noUa = await refusal(http.getJson('sec', 'https://data.sec.gov/x', { fetchImpl: secCalls }));
  check('SEC without SEC_USER_AGENT is not asked, and the reason names the setting', noUa instanceof http.SourceError && /SEC_USER_AGENT/.test(noUa.message) && secCalls.calls.length === 0, noUa?.message);
  process.env.SEC_USER_AGENT = 'Synapsez ops@example.com';
  await http.getJson('sec', 'https://data.sec.gov/x', { fetchImpl: secCalls });
  check('  with it, SEC gets exactly that', secCalls.calls[0]?.headers['User-Agent'] === 'Synapsez ops@example.com');
  delete process.env.SEC_USER_AGENT;
}

section('http.js: switched off, standing aside, or over a ceiling means no call at all');
{
  http.__resetHttp();
  process.env.FIN_SOURCE_KBS = 'off';
  const fetchImpl = fakeFetch();
  const off = await refusal(http.getJson('kbs', 'https://kbbuddywts.kbsec.com.vn/x', { fetchImpl }));
  check('a source switched off is never fetched', off instanceof http.SourceError && fetchImpl.calls.length === 0 && /FIN_SOURCE_KBS/.test(off.message), off?.message);
  check('  and drops out of every chain', !chains.chainFor('quote', 'vn').includes('kbs') && chains.chainFor('quote', 'vn').includes('vndirect'), chains.chainFor('quote', 'vn').join(','));
  delete process.env.FIN_SOURCE_KBS;
  check('  and comes back when the switch is gone', chains.chainFor('quote', 'vn').join(',') === 'vndirect,kbs,yahoo', chains.chainFor('quote', 'vn').join(','));

  const busy = fakeFetch(() => ({ status: 429, body: 'Too Many Requests' }));
  const first = await refusal(http.getJson('vietcap', 'https://iq.vietcap.com.vn/x', { fetchImpl: busy }));
  const second = await refusal(http.getJson('vietcap', 'https://iq.vietcap.com.vn/y', { fetchImpl: busy }));
  check('a 429 stands the source aside', first?.standAside === true && first.status === 429, first?.message);
  check('  so the next call is refused without asking', second?.standAside === true && busy.calls.length === 1, `${busy.calls.length} calls`);
  check('  for an hour, for a Vietnamese broker', http.standingAside('vietcap') - Date.now() > 59 * 60_000);
  const denied = fakeFetch(() => ({ status: 403, body: 'no' }));
  await refusal(http.getJson('yahoo', 'https://query1.finance.yahoo.com/x', { fetchImpl: denied }));
  const yahooAside = http.standingAside('yahoo') - Date.now();
  check('a 403 from Yahoo: fifteen minutes', yahooAside > 14 * 60_000 && yahooAside <= 15 * 60_000, String(yahooAside));
  const broken = fakeFetch(() => ({ status: 503, body: 'down' }));
  const down = await refusal(http.getJson('sjc', 'https://sjc.com.vn/x', { fetchImpl: broken }));
  check('any other failure is an error with its status, and no standing aside', down?.status === 503 && !down.standAside && !http.standingAside('sjc'), down?.message);
  const html = fakeFetch(() => ({ body: '<html>blocked</html>', headers: { 'content-type': 'text/html' } }));
  const notJson = await refusal(http.getJson('worldbank', 'https://api.worldbank.org/x', { fetchImpl: html }));
  check('a page that is not JSON is a readable failure', notJson instanceof http.SourceError && /not JSON/i.test(notJson.message), notJson?.message);

  process.env.KBS_FREE_DAILY = '0';
  const capped = fakeFetch();
  const over = await refusal(http.getJson('kbs', 'https://kbbuddywts.kbsec.com.vn/x', { fetchImpl: capped }));
  check('a pooled ceiling reached: refused before the call', over instanceof http.SourceError && capped.calls.length === 0 && /allowance/i.test(over.message), over?.message);
  delete process.env.KBS_FREE_DAILY;
  http.__resetHttp();
  check('the test reset clears standing aside', !http.standingAside('vietcap') && !http.standingAside('yahoo'));
}

section('http.js: one host is asked at most so often, per instance');
{
  http.__resetHttp();
  process.env.FIN_PACE_SCALE = '0.05';
  const fetchImpl = fakeFetch();
  await Promise.all([
    http.getJson('kbs', 'https://kbbuddywts.kbsec.com.vn/a', { fetchImpl }),
    http.getJson('kbs', 'https://kbbuddywts.kbsec.com.vn/b', { fetchImpl }),
    http.getJson('frankfurter', 'https://api.frankfurter.dev/c', { fetchImpl }),
  ]);
  const [a, b] = fetchImpl.calls.filter((c) => c.url.includes('kbsec'));
  const gap = b.at - a.at;
  check('two KBS calls at once go a second apart (scaled to 50 ms here)', gap >= 45, `${gap} ms`);
  check('  while a source with no pace is not held up', fetchImpl.calls.findIndex((c) => c.url.includes('frankfurter')) < 2, fetchImpl.calls.map((c) => c.url.slice(-1)).join(','));
  process.env.FIN_PACE_SCALE = '0';
  http.__resetHttp();
}

section('chains.js: the table, and only the sources it names');
{
  check('every kind has a chain', ['quote', 'history', 'intraday', 'statements', 'ratios', 'profile', 'events', 'news', 'fund', 'options', 'fx', 'gold', 'macro', 'screen'].every((k) => chains.CHAINS[k]));
  check('US statements: SEC, then Yahoo', chains.chainFor('statements', 'us').join(',') === 'sec,yahoo');
  check('a Vietnamese screen does not exist — it would mean crawling a market', chains.chainFor('screen', 'vn').length === 0 && chains.chainFor('screen', 'us').join() === 'sec');
  const named = new Set(Object.values(chains.CHAINS).flatMap((m) => Object.values(m).flat()).map((s) => s.split(':')[0]));
  const allowed = new Set(['yahoo', 'vndirect', 'kbs', 'vietcap', 'sec', 'coingecko', 'frankfurter', 'ecb', 'erapi', 'vietcombank', 'sjc', 'worldbank', 'fred', 'nso', 'fmarket']);
  check('every source in the table has a kill switch', [...named].every((s) => allowed.has(s)), [...named].join(','));
  const never = /finnhub|tiingo|twelve|polygon|massive|alpaca|fmp|eodhd|alpha|ssi|msn|btmc|stooq|binance|tcbs/i;
  check('and none of them is one the owner ruled out', ![...named].some((s) => never.test(s)));
}

/* ── the cache ────────────────────────────────────────────────────── */

const cache = await import('../server/finance/cache.js');

section('cache.js: asked twice, fetched once — for every account and instance');
{
  cache.__resetCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { price: 100 + loads };
  };
  const a = await cache.cached('test|quote|A|', 60_000, load);
  const b = await cache.cached('test|quote|A|', 60_000, load);
  check('the second ask does not call the source', loads === 1 && a.price === 101 && b.price === 101, `${loads} loads`);
  cache.__resetCache();
  const c = await cache.cached('test|quote|A|', 60_000, load);
  check('  another instance (empty memory) reads it from the database', loads === 1 && c.price === 101, `${loads} loads`);
  const later = Date.now() + 120_000;
  const d = await cache.cached('test|quote|A|', 60_000, load, { now: later });
  check('expired: the source is asked again', loads === 2 && d.price === 102, `${loads} loads`);
  const [x, y] = await Promise.all([cache.cached('test|quote|B|', 60_000, load), cache.cached('test|quote|B|', 60_000, load)]);
  check('two asks at the same moment share one call', loads === 3 && x.price === y.price, `${loads} loads`);
  await cache.cached('test|bar|A|2026-09-18', Infinity, async () => ({ c: 71700 }));
  check('a bar kept for good is stored with no expiry', (await store.financeGet('test|bar|A|2026-09-18'))?.expires_at === null);
  const realGet = store.financeGet;
  store.financeGet = async () => {
    throw new Error('database away');
  };
  cache.__resetCache();
  const e = await cache.cached('test|quote|C|', 60_000, load);
  store.financeGet = realGet;
  check('a database that fails is not a failed answer — the source is asked', e.price === 104, JSON.stringify(e));
  const stale = await cache.cached('test|quote|A|', 60_000, load, { now: later, valid: () => false });
  check('an entry its caller says is no longer valid is fetched again', stale.price === 105);
  check('peek reads without fetching', (await cache.peek('test|quote|A|'))?.value?.price === 105 && (await cache.peek('test|never|x|')) === null);
  await memory.query('DELETE FROM finance_cache');
  cache.__resetCache();
}

section('cache.js: how long each kind of answer is kept (spec §4)');
{
  const H = 3_600_000;
  // Friday 13 November 2026, 16:00 in Hanoi (09:00 UTC); Monday's open is 09:00 ICT = 02:00 UTC.
  const friday = new Date('2026-11-13T09:00:00Z');
  const toMonday = cache.ttlFor('quote', { market: 'vn', session: 'closed', now: friday });
  check('a VN quote after Friday\'s close lasts until Monday 09:00 ICT', friday.getTime() + toMonday === Date.parse('2026-11-16T02:00:00Z'), new Date(friday.getTime() + toMonday).toISOString());
  const early = new Date('2026-11-10T01:00:00Z'); // 08:00 ICT on a Tuesday
  check('  before Tuesday\'s open, until 09:00 that morning', early.getTime() + cache.ttlFor('quote', { market: 'vn', session: 'pre', now: early }) === Date.parse('2026-11-10T02:00:00Z'));
  const lunch = new Date('2026-11-10T05:00:00Z'); // 12:00 ICT
  check('  over the lunch break, until 13:00', lunch.getTime() + cache.ttlFor('quote', { market: 'vn', session: 'break', now: lunch }) === Date.parse('2026-11-10T06:00:00Z'));
  check('in session: 45 s in Vietnam, 20 s in the US', cache.ttlFor('quote', { market: 'vn', session: 'continuous', now: lunch }) === 45_000 && cache.ttlFor('quote', { market: 'us', now: new Date('2026-11-10T15:00:00Z') }) === 20_000);
  // Saturday 14 Nov 2026 12:00 New York (EST, UTC-5) → Monday 16 Nov 09:30 EST = 14:30 UTC.
  const sat = new Date('2026-11-14T17:00:00Z');
  check('  a US quote on Saturday lasts until Monday 09:30 New York', sat.getTime() + cache.ttlFor('quote', { market: 'us', now: sat }) === Date.parse('2026-11-16T14:30:00Z'));
  // And in summer time (EDT, UTC-4): Saturday 11 July 2026 → Monday 13 July 09:30 EDT = 13:30 UTC.
  const summer = new Date('2026-07-11T17:00:00Z');
  check('  in summer time too', summer.getTime() + cache.ttlFor('quote', { market: 'us', now: summer }) === Date.parse('2026-07-13T13:30:00Z'));
  check('intraday bars: 2 minutes', cache.ttlFor('intraday', {}) === 120_000);
  check('a closed day\'s raw bars: kept for good', cache.ttlFor('history', { closedDay: true, adjusted: false, market: 'vn', now: lunch }) === Infinity);
  check('  adjusted bars: until the next open, when an ex-date would rewrite them', lunch.getTime() + cache.ttlFor('history', { closedDay: true, adjusted: true, market: 'vn', now: lunch }) === Date.parse('2026-11-11T02:00:00Z'));
  check('statements and ratios a day, events 8 hours, news 10 minutes', cache.ttlFor('statements', {}) === 24 * H && cache.ttlFor('ratios', {}) === 24 * H && cache.ttlFor('events', {}) === 8 * H && cache.ttlFor('news', {}) === 600_000);
  check('Vietcombank\'s rates 5 minutes (its own rule), other rates an hour, a past day\'s for good', cache.ttlFor('fx', { source: 'vietcombank' }) === 300_000 && cache.ttlFor('fx', { source: 'frankfurter' }) === H && cache.ttlFor('fx', { source: 'frankfurter', past: true }) === Infinity);
  check('gold 5 minutes; macro, listings and the SEC ticker map a day; the Yahoo crumb 6 hours', cache.ttlFor('gold', {}) === 300_000 && cache.ttlFor('macro', {}) === 24 * H && cache.ttlFor('listings', {}) === 24 * H && cache.ttlFor('sec-tickers', {}) === 24 * H && cache.ttlFor('crumb', {}) === 6 * H);
  check('nothing from CoinGecko is kept past 24 hours (its terms, 6.1)', cache.ttlFor('profile', { source: 'coingecko' }) <= 24 * H && cache.ttlFor('history', { source: 'coingecko', closedDay: true, adjusted: false }) <= 24 * H);

  const cachedAt = Date.parse('2026-09-18T10:00:00Z');
  const bonus = [{ code: 'ISS', exDate: '2026-09-21' }];
  check('an adjusted series fetched before an ex-date that has since passed is no longer valid', cache.adjustedStillValid(cachedAt, bonus, Date.parse('2026-09-22T03:00:00Z')) === false);
  check('  one fetched after it still is', cache.adjustedStillValid(Date.parse('2026-09-21T09:00:00Z'), bonus, Date.parse('2026-09-22T03:00:00Z')) === true);
  check('  and an ex-date still to come changes nothing yet', cache.adjustedStillValid(cachedAt, bonus, Date.parse('2026-09-19T03:00:00Z')) === true);
}

/* ── Vietnamese market rules ──────────────────────────────────────── */

const vn = await import('../server/finance/vn.js');

section('vn.js: price bands, rounded to the tick the way the exchange does (research §5)');
{
  const fpt = vn.limits('HOSE', 65_200);
  check('HOSE reference 65,200 → ceiling 69,700, floor 60,700 (as VNDirect published on 2026-09-21)', fpt.ceiling === 69_700 && fpt.floor === 60_700, JSON.stringify(fpt));
  const acv = vn.limits('UPCOM', 39_200);
  check('UPCoM reference 39,200 → 45,000 / 33,400', acv.ceiling === 45_000 && acv.floor === 33_400, JSON.stringify(acv));
  const split = vn.limits('HOSE', 51_000);
  check('each limit takes the tick of its own price: 51,000 → 54,500 / 47,450 (VNDirect, 2026-11-10)', split.ceiling === 54_500 && split.floor === 47_450, JSON.stringify(split));
  const hnx = vn.limits('HNX', 12_000);
  check('HNX ±10%: 12,000 → 13,200 / 10,800', hnx.ceiling === 13_200 && hnx.floor === 10_800, JSON.stringify(hnx));
  check('bands: ±7% HOSE, ±10% HNX, ±15% UPCoM', vn.band('HOSE') === 0.07 && vn.band('HNX') === 0.1 && vn.band('UPCOM') === 0.15);
  check('  and a first trading day: ±20 / 30 / 40%', vn.band('HOSE', { firstDay: true }) === 0.2 && vn.band('HNX', { firstDay: true }) === 0.3 && vn.band('UPCOM', { firstDay: true }) === 0.4);
  check('ticks: HOSE 10 under 10,000, 50 under 50,000, 100 above', vn.tick('HOSE', 9_990) === 10 && vn.tick('HOSE', 25_000) === 50 && vn.tick('HOSE', 65_200) === 100);
  check('  HOSE ETFs and covered warrants 10; HNX and UPCoM 100', vn.tick('HOSE', 65_200, { instrument: 'etf' }) === 10 && vn.tick('HOSE', 2_000, { instrument: 'cw' }) === 10 && vn.tick('HNX', 12_000) === 100 && vn.tick('UPCOM', 9_000) === 100);
  check('change is against the reference, never the previous close (UPCoM ACV: ref 39,200, price 40,000)', Math.abs(vn.changePct(40_000, 39_200) - 2.0408) < 0.001, String(vn.changePct(40_000, 39_200)));
}

section('vn.js: the session from the clock in Hanoi');
{
  const at = (hhmm, day = '2026-11-10') => new Date(`${day}T${hhmm}:00+07:00`);
  check('HOSE 08:50 is before the open', vn.sessionAt('HOSE', at('08:50')) === 'pre');
  check('HOSE 09:05 is the opening auction (ATO)', vn.sessionAt('HOSE', at('09:05')) === 'ato');
  check('HOSE 10:00 continuous', vn.sessionAt('HOSE', at('10:00')) === 'continuous');
  check('HOSE 11:45 lunch', vn.sessionAt('HOSE', at('11:45')) === 'break');
  check('HOSE 14:35 the closing auction (ATC)', vn.sessionAt('HOSE', at('14:35')) === 'atc');
  check('HOSE 14:50 put-through', vn.sessionAt('HOSE', at('14:50')) === 'putthrough');
  check('HOSE 15:05 closed', vn.sessionAt('HOSE', at('15:05')) === 'closed');
  check('HNX 09:05 is already continuous (no ATO), 14:50 post-close (PLO)', vn.sessionAt('HNX', at('09:05')) === 'continuous' && vn.sessionAt('HNX', at('14:50')) === 'plo');
  check('UPCoM 14:40 is still continuous — it trades until 15:00', vn.sessionAt('UPCOM', at('14:40')) === 'continuous');
  check('Saturday is closed', vn.sessionAt('HOSE', at('10:00', '2026-11-14')) === 'closed');
  check('the index names a person uses are the codes the brokers use', vn.vnIndexCode('VN-Index') === 'VNINDEX' && vn.vnIndexCode('hnx') === 'HNXIndex' && vn.vnIndexCode('upcom') === 'HNXUpcomIndex' && vn.vnIndexCode('FPT') === null);
  check('the disclaimer, in both languages', /không phải khuyến nghị đầu tư/.test(vn.VN_LABEL.vi) && /not investment advice/.test(vn.VN_LABEL.en));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll finance checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
