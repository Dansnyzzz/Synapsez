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
import fs from 'node:fs';
import path from 'node:path';
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

/* ── the sources, against their recorded answers ─────────────────── */

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'finance');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
/**
 * A fetch that answers each URL from its recorded answer. `routes` is
 * `[match, answer]`: a substring or RegExp, and a fixture's file name, a body, a
 * `{ status, body, headers }`, or a function of the URL giving one of those.
 */
function serve(routes) {
  return fakeFetch((url) => {
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? !url.includes(match) : !match.test(url)) continue;
      const a = typeof answer === 'function' ? answer(url) : answer;
      if (typeof a === 'string' && a.endsWith('.json')) return { body: fixture(a) };
      if (a && typeof a === 'object' && 'status' in a) return a;
      return { body: a };
    }
    return { status: 404, body: { error: `no recording for ${url}` } };
  });
}
const fresh = async () => {
  http.__resetHttp();
  cache.__resetCache();
  await memory.query('DELETE FROM finance_cache');
};

const yahoo = await import('../server/finance/sources/yahoo.js');

section('7a yahoo.js: chart, statements, crumb');
{
  await fresh();
  const fetchImpl = serve([
    ['/chart/FPT.VN', 'yahoo-chart-fpt.json'],
    ['/chart/AAPL', 'yahoo-chart-aapl.json'],
    ['/chart/VNM.VN', 'yahoo-chart-vnm-dividends.json'],
    ['/chart/', { status: 404, body: fixture('yahoo-notfound.json') }],
    ['fundamentals-timeseries', 'yahoo-timeseries.json'],
    ['fc.yahoo.com', { status: 404, body: 'not here', headers: { 'set-cookie': 'A3=d=AQABBtest&S=AQAAAtest; Expires=Wed, 11 Nov 2027 08:00:00 GMT; Domain=.yahoo.com; Path=/; Secure; HttpOnly' } }],
    ['getcrumb', { status: 200, body: 'aBcD3fGh1Jk', headers: { 'content-type': 'text/plain' } }],
    ['quoteSummary', 'yahoo-quotesummary.json'],
    ['/v7/finance/options', 'yahoo-options.json'],
    ['/v1/finance/search', 'yahoo-search.json'],
  ]);
  const ctx = { fetchImpl };
  const fpt = await yahoo.quote('FPT', { ...ctx, market: 'vn', board: 'HOSE' });
  check('FPT on HOSE: its price in ₫, and the exchange\'s own zone', fpt.price === 50_900 && fpt.currency === 'VND' && fpt.unit === 'VND' && fpt.zone === 'Asia/Bangkok' && fpt.symbol === 'FPT.VN', JSON.stringify({ ...fpt, series: undefined }));
  check('  the change is against yesterday\'s close (51,000), not the close before the range', fpt.previousClose === 51_000 && Math.abs(fpt.changePct - -0.196) < 0.01, `${fpt.previousClose} ${fpt.changePct}`);
  check('  labelled delayed, with when', fpt.delay === 'delayed' && fpt.asOf.startsWith('2026-11-10'));
  const aapl = await yahoo.quote('aapl', { ...ctx, market: 'us' });
  check('AAPL in USD, in New York\'s zone', aapl.price === 350.69 && aapl.currency === 'USD' && aapl.zone === 'America/New_York' && aapl.exchange === 'NasdaqGS');
  const missing = await refusal(yahoo.quote('ZZZZ', { ...ctx, market: 'us' }));
  check('Yahoo\'s "Not Found" is a SourceError that says so', missing instanceof http.SourceError && /no ZZZZ/.test(missing.message), missing?.message);

  const before = fetchImpl.calls.length;
  const shs = await refusal(yahoo.quote('SHS', { ...ctx, market: 'vn', board: 'HNX' }));
  const vn30 = await refusal(yahoo.quote('VN30', { ...ctx, market: 'vn' }));
  check('an HNX code is never sent to Yahoo', shs instanceof http.SourceError && /HOSE stocks only/.test(shs.message));
  check('  nor ^VN30.VN, which does not exist', vn30 instanceof http.SourceError && fetchImpl.calls.length === before && !fetchImpl.calls.some((c) => /VN30|HNX\.VN|SHS/.test(c.url)));
  check('VN-Index is ^VNINDEX.VN; gold GC=F; a coin X-USD', yahoo.yahooSymbol('VNINDEX', { market: 'vn' }) === '^VNINDEX.VN' && yahoo.yahooSymbol('vàng') === 'GC=F' && yahoo.yahooSymbol('btc', { market: 'crypto' }) === 'BTC-USD');

  const adjusted = await yahoo.history('AAPL', { period: '5d' }, { ...ctx, market: 'us' });
  check('history: daily bars by the exchange\'s date, oldest first', adjusted.bars.length === 5 && /^\d{4}-\d{2}-\d{2}$/.test(adjusted.bars[0].t) && adjusted.bars[0].t < adjusted.bars[4].t, adjusted.bars.map((b) => b.t).join(','));
  const vnm = await yahoo.history('VNM', { period: '5d' }, { ...ctx, market: 'vn', board: 'HOSE' });
  const vnmRaw = await yahoo.history('VNM', { period: '5d', adjusted: false }, { ...ctx, market: 'vn', board: 'HOSE' });
  check('  adjusted uses adjclose; "raw" from Yahoo is said to be split-adjusted already', vnm.dividendsAdjusted && !vnmRaw.dividendsAdjusted && /split-adjusted/.test(vnmRaw.note), vnmRaw.note);
  const divs = await yahoo.events('VNM', { ...ctx, market: 'vn', board: 'HOSE' });
  check('dividends from the chart\'s events, newest first', divs.length === 4 && divs[0].code === 'DIV' && divs[0].valuePerShare === 1_850 && divs[0].date >= divs[1].date, JSON.stringify(divs[0]));

  const income = await yahoo.statements('AAPL', 'income', 'year', { ...ctx, market: 'us' });
  check('statements from the timeseries: four years, newest first, labelled from Yahoo\'s own type names', income.periods.length === 4 && income.lines[0].label_en === 'Total revenue' && income.lines[0].values[0] === 416_161_000_000 && income.unit === 'USD', JSON.stringify(income.lines[0]));

  const ratios = await yahoo.ratios('AAPL', { ...ctx, market: 'us' });
  const cookieSent = fetchImpl.calls.find((c) => c.url.includes('quoteSummary'))?.headers?.Cookie;
  check('the crumb flow: the A3 cookie from fc.yahoo.com, then the crumb, then v10 with both', /^A3=/.test(cookieSent || '') && fetchImpl.calls.some((c) => c.url.includes('quoteSummary') && c.url.includes('crumb=aBcD3fGh1Jk')), cookieSent);
  check('  P/E, P/B and market cap from quoteSummary', ratios.items.find((i) => i.key === 'pe')?.value > 39 && ratios.items.some((i) => i.key === 'marketCap'), ratios.items.map((i) => i.key).join(','));
  const crumbs = fetchImpl.calls.filter((c) => c.url.includes('getcrumb')).length;
  await yahoo.options('AAPL', null, { ...ctx, market: 'us' });
  check('  and the crumb is fetched once, then kept', fetchImpl.calls.filter((c) => c.url.includes('getcrumb')).length === crumbs && crumbs === 1);
  const opts = await yahoo.options('AAPL', null, { ...ctx, market: 'us' });
  check('options: the nearest expiry, strikes around the price', opts.calls.length > 0 && opts.puts.length > 0 && opts.expiry === '2026-11-11', `${opts.expiry} ${opts.calls.length}`);
  const headlines = await yahoo.news('FPT', { ...ctx, market: 'vn', board: 'HOSE' });
  check('news: headline, publisher and link only', headlines.length === 1 && headlines[0].url === 'https://example.com/fpt-ai' && !('summary' in headlines[0]));
}

const vndirect = await import('../server/finance/sources/vndirect.js');

section('7b vndirect.js: thousand ₫ in, ₫ out; raw and adjusted side by side');
{
  await fresh();
  const fetchImpl = serve([
    ['stock_prices', 'vndirect-stock-prices.json'],
    ['dchart', 'dchart.json'],
    ['ratios/latest', 'vndirect-ratios.json'],
  ]);
  const ctx = { fetchImpl };
  const q = await vndirect.quote('fpt', ctx);
  check('the newest row, multiplied to ₫: 50.9 → 50,900', q.price === 50_900 && q.reference === 51_000 && q.ceiling === 54_500 && q.floor === 47_450, JSON.stringify(q));
  check('  the board from the row itself; the time in Hanoi', q.board === 'HOSE' && q.asOf === '2026-11-10T07:46:08.000Z' && q.delay === 'delayed');
  check('  volume in shares, not multiplied', q.volume === 7_268_500);
  const asked = fetchImpl.calls.at(-1).url;
  check('  one row asked for, by code — no crawl', /q=code:FPT&size=2/.test(asked), asked);
  const raw = await vndirect.history('FPT', { from: '2026-09-01', to: '2026-11-10', adjusted: false }, ctx);
  const adj = await vndirect.history('FPT', { from: '2026-09-01', to: '2026-11-10', adjusted: true }, ctx);
  const day = (h) => h.bars.find((b) => b.t === '2026-09-18');
  check('before the 10% bonus issue, raw and adjusted differ: 71,700 raw, 65,182 adjusted', day(raw).c === 71_700 && day(adj).c === 65_182, `${day(raw).c} / ${day(adj).c}`);
  check('  and the volume is the same in both — it is never adjusted', day(raw).v === day(adj).v && day(raw).v === 15_500_700);
  check('  oldest first, and said which it is', raw.bars[0].t < raw.bars.at(-1).t && raw.adjusted === false && adj.adjusted === true);
  check('  at most 250 rows in one call', /size=250/.test(fetchImpl.calls.at(-1).url));
  const long = await refusal(vndirect.history('FPT', { from: '2020-01-01', to: '2026-11-10' }, ctx));
  check('a period needing more than 250 daily rows is passed on, not crawled', long instanceof http.SourceError && /250/.test(long.message));
  const bars = await vndirect.dchart('FPT', '1d', '2026-11-01', '2026-11-10', ctx);
  check('dchart: thousand ₫ to ₫ as well, dated in Hanoi', bars.bars.at(-1).c === 50_900 && bars.bars.at(-1).t === '2026-11-10' && bars.adjusted, JSON.stringify(bars.bars.at(-1)));
  const r = await vndirect.ratios('FPT', ctx);
  check('ratios: only market cap (51003), the one item whose meaning is known', r.items.length === 1 && r.items[0].key === 'marketCap' && r.items[0].value === 96_172_110_048_000);
}

const kbs = await import('../server/finance/sources/kbs.js');

section('7c kbs.js: numbers that arrive as strings, statements in thousand ₫');
{
  await fresh();
  const fetchImpl = serve([
    ['/index/VNINDEX/data_day', 'kbs-index-day.json'],
    ['/stocks/FPT/data_day', 'kbs-day.json'],
    ['/stocks/FPT/data_5P', 'kbs-intraday.json'],
    ['finance-info', 'kbs-finance.json'],
    ['stockinfo/profile', 'kbs-profile.json'],
    ['stockinfo/news', []],
  ]);
  const now = new Date('2026-11-10T08:00:00Z');
  const ctx = { fetchImpl, now };
  const index = await kbs.history('VNINDEX', { from: '2026-11-02', to: '2026-11-10' }, ctx);
  const last = index.bars.at(-1);
  check('the newest row\'s string numbers ("1719.23") are numbers', last.o === 1719.23 && last.c === 1743.07 && typeof last.v === 'number' && last.v === 876_999_156, JSON.stringify(last));
  check('  an index is in points, dated (KBS\'s 07:00 is a date only)', index.unit === 'points' && last.t === '2026-11-10');
  const q = await kbs.quote('FPT', { ...ctx, board: 'HOSE' });
  check('a quote: the last bar, its reference the previous close on HOSE', q.price === 50_900 && q.reference === 51_000 && Math.abs(q.changePct - -0.196) < 0.01, JSON.stringify({ ...q, series: undefined }));
  check('  with the band worked out (and said to be)', q.ceiling === 54_500 && q.floor === 47_450 && q.bandComputed === true);
  const upcom = await kbs.quote('FPT', { ...ctx, board: 'UPCOM' });
  check('  on UPCoM no reference is guessed — it is yesterday\'s average, which KBS does not give', upcom.reference === undefined && upcom.changePct === undefined);
  const asked = fetchImpl.calls.find((c) => c.url.includes('/stocks/FPT/data_day'))?.url || '';
  check('  dates asked as KBS spells them', /sdate=31-10-2026&edate=10-11-2026/.test(asked), asked);
  const bars = await kbs.intraday('FPT', '5m', ctx);
  check('intraday: a row of strings and no `va` is read like the rest', bars.bars.length === 3 && bars.bars.at(-1).c === 50_900 && bars.bars.at(-1).v === 120_500, JSON.stringify(bars.bars.at(-1)));
  const income = await kbs.statements('FPT', 'income', 'year', ctx);
  check('statements: thousand ₫ multiplied to ₫ (net revenue 2025 ≈ 70.1 trillion)', income.lines.find((l) => l.code === '2216')?.values[0] === 70_112_825_101_000 && income.unit === 'VND', JSON.stringify(income.lines.find((l) => l.code === '2216')));
  check('  each period audited or not, consolidated or not, and when published', income.periods[0].audited === 'audited' && income.periods[0].consolidated === true && income.periods[0].published === '2026-03-20' && income.periods[0].label === '2025', JSON.stringify(income.periods[0]));
  check('  labels from KBS\'s own names, in both languages', income.lines[0].label_vi.startsWith('1. Doanh thu') && income.lines[0].label_en === '1. Revenue');
  const p = await kbs.profile('FPT', ctx);
  check('profile: the exchange and par value, the summary as plain text', p.exchange === 'HOSE' && p.parValue === 10_000 && !/<p>/.test(p.summary) && p.summary.length <= 401, p.summary.slice(0, 60));
  const none = await refusal(kbs.news('FPT', ctx));
  check('news it cannot read is a SourceError, so the chain moves on', none instanceof http.SourceError);
}

const vietcap = await import('../server/finance/sources/vietcap.js');

section('7d vietcap.js: statements labelled by Vietcap, and its analysts\' views never passed on');
{
  await fresh();
  const bankDetails = (() => {
    const d = fixture('vietcap-details.json');
    return { ...d, data: { ...d.data, ticker: 'VCB', organCode: 'VCB', comTypeCode: 'NH', isBank: true } };
  })();
  const fetchImpl = serve([
    // Wrapped: Vietcap's own body has a `status` field, which `serve` would read as the envelope.
    ['company/details?ticker=VCB', { status: 200, body: bankDetails }],
    ['company/details', 'vietcap-details.json'],
    ['financial-statement/metrics', 'vietcap-metrics.json'],
    ['financial-statement?section', 'vietcap-statement.json'],
    ['statistics-financial', 'vietcap-ratio.json'],
    ['/v1/events', 'vietcap-events.json'],
    ['/v1/news', { status: 200, successful: true, data: { content: [] } }],
    ['getByGroup?group=HOSE', ['FPT', 'VNM', 'VCB'].map((symbol) => ({ symbol }))],
    ['getByGroup?group=HNX', [{ symbol: 'SHS' }]],
    ['getByGroup?group=UPCOM', [{ symbol: 'ACV' }]],
    ['getByGroup?group=VN30', 'vietcap-group.json'],
    ['stockinfo/profile/ZZZ', { SB: 'ZZZ', EX: 'UPCOM' }],
  ]);
  const ctx = { fetchImpl };
  const income = await vietcap.statements('FPT', 'income', 'year', ctx);
  const sales = income.lines.find((l) => l.code === 'isa3');
  check('net sales 2025 = 70,112,825,100,710 ₫, as Yahoo\'s 70.11T', sales?.values[0] === 70_112_825_100_710 && income.periods[0].label === '2025', JSON.stringify(sales));
  check('  labels from Vietcap\'s own metrics, in Vietnamese and English', sales.label_vi === 'Doanh thu thuần' && sales.label_en === 'Net sales');
  check('  four years, newest first, each with its publish date; raw ₫; corporate template', income.periods.length === 4 && income.periods[0].published === '2026-03-20' && income.unit === 'VND' && income.template === 'corporate', JSON.stringify(income.periods));
  check('  no more than 15 lines', income.lines.length > 5 && income.lines.length <= 15, String(income.lines.length));
  const quarters = await vietcap.statements('FPT', 'income', 'quarter', ctx);
  check('quarters are labelled Q3 2026 and the like', /^Q[1-4] \d{4}$/.test(quarters.periods[0].label), quarters.periods[0].label);
  const bank = await vietcap.statements('VCB', 'income', 'year', ctx);
  check('a bank is labelled a bank (comTypeCode NH)', bank.template === 'bank');

  const p = await vietcap.profile('FPT', ctx);
  const said = JSON.stringify(p);
  check('details: shares, market cap, foreign ownership and its limit', p.shares === 1_885_727_648 && p.foreignLimit === 0.49 && p.foreignOwned > 0.26 && p.name_en === 'FPT Corporation');
  check('  and never Vietcap\'s rating, target price, analyst or projected return', !/rating|target|analyst|upside|TSR|BUY|77800|90300/i.test(said), said.slice(0, 200));
  const kept = JSON.stringify((await memory.query("SELECT value FROM finance_cache WHERE key LIKE 'vietcap|details|%'")).rows);
  check('  not even in the shared cache', !/rating|target|BUY|77800/i.test(kept) && kept.length > 10);

  const r = await vietcap.ratios('FPT', ctx);
  check('ratios: the latest quarter\'s TTM figures, fractions marked as such', r.asOf === 'Q3 2026 (TTM)' && r.items.find((i) => i.key === 'pe')?.value > 9 && r.items.find((i) => i.key === 'roe')?.kind === 'fraction', r.asOf);
  const ev = await vietcap.events('FPT', { from: '2025-11-01', to: '2026-12-31' }, ctx);
  check('events: the 10% bonus issue with its ex-date', ev.some((e) => e.code === 'ISS' && e.exDate === '2026-09-21' && e.ratio === 0.1 && /Bonus/.test(e.title_en)), JSON.stringify(ev[0]));
  const evUrl = fetchImpl.calls.find((c) => c.url.includes('/v1/events'))?.url || '';
  check('  asked by code and date range only', /ticker=FPT&fromDate=20251101&toDate=20261231/.test(evUrl), evUrl);
  check('an empty news list is a SourceError, so the chain moves on', (await refusal(vietcap.news('FPT', { from: '2026-11-01', to: '2026-11-10' }, ctx))) instanceof http.SourceError);
  check('a listing is a list of codes', (await vietcap.group('VN30', ctx)).includes('FPT'));

  check('the board is found, not guessed: FPT on HOSE, SHS on HNX, ACV on UPCoM', (await vn.boardOf('FPT', ctx)) === 'HOSE' && (await vn.boardOf('SHS', ctx)) === 'HNX' && (await vn.boardOf('acv', ctx)) === 'UPCOM');
  check('  a code no listing has is asked of KBS', (await vn.boardOf('ZZZ', ctx)) === 'UPCOM');
  const lists = fetchImpl.calls.filter((c) => c.url.includes('getByGroup?group=HOSE')).length;
  check('  and each listing is fetched once, then kept a day', lists === 1, `${lists} calls`);
  check('  an index has no board', (await vn.boardOf('VNINDEX', ctx)) === null);
}

const sec = await import('../server/finance/sources/sec.js');

section('7e sec.js: one value per period, and nothing without SEC_USER_AGENT');
{
  await fresh();
  const fetchImpl = serve([
    ['company_tickers.json', 'sec-tickers.json'],
    ['companyfacts/CIK0000320193', 'sec-companyfacts.json'],
    ['submissions/CIK0000320193', 'sec-submissions.json'],
    ['/frames/', 'sec-frames.json'],
  ]);
  const ctx = { fetchImpl };
  const none = await refusal(sec.statements('AAPL', 'income', 'year', ctx));
  check('no SEC_USER_AGENT: SEC is not asked, and the answer says what to set', none instanceof http.SourceError && /SEC_USER_AGENT/.test(none.message) && fetchImpl.calls.length === 0, none?.message);
  process.env.SEC_USER_AGENT = 'Synapsez ops@example.com';
  const id = await sec.cik('aapl', ctx);
  check('ticker → CIK, ten digits', id.cik === '0000320193' && id.name === 'Apple Inc.');
  const income = await sec.statements('AAPL', 'income', 'year', ctx);
  const revenue = income.lines.find((l) => l.code === 'Revenues');
  check('a period reported twice keeps one value — the one SEC framed, not the later amendment', income.periods.length === 3 && revenue.values[0] === 265_595_000_000 && !revenue.values.includes(1), JSON.stringify(revenue.values));
  check('  newest first, labelled by fiscal year and its end, with SEC\'s own labels', /^FY 2018 \(to 2018-09-29\)$/.test(income.periods[0].label) && revenue.label_en === 'Revenues', income.periods[0].label);
  check('  per-share lines say their unit', income.lines.find((l) => l.code === 'EarningsPerShareDiluted')?.unit === 'USD/shares');
  const facts = fixture('sec-companyfacts.json').facts['us-gaap'].Revenues;
  const byEnd = sec.factsByPeriod(facts, 'year');
  check('factsByPeriod: three year-ends from four facts', byEnd.size === 3 && byEnd.get('2018-09-29').val === 265_595_000_000);
  const r = await sec.ratios('AAPL', 350.69, ctx);
  check('ratios worked out from the filing and a price, and said to be', r.computed && r.items.some((i) => i.key === 'pe') && r.items.some((i) => i.key === 'netMargin' && i.kind === 'fraction') && /Computed from SEC filings/.test(r.note), r.items.map((i) => i.key).join(','));
  const list = await sec.filings('AAPL', 3, ctx);
  check('filings: date, form, a link to the document on sec.gov', list.length === 3 && list[1].form === '8-K' && /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//.test(list[1].url), JSON.stringify(list[1]));
  const ev = await sec.events('AAPL', ctx);
  check('events: the 8-Ks only', ev.length >= 1 && ev.every((e) => /^8-K/.test(e.code)), JSON.stringify(ev[0]));
  const p = await sec.profile('AAPL', ctx);
  check('profile: name, exchange, industry, fiscal year end — no address or phone', p.name === 'Apple Inc.' && p.exchange === 'Nasdaq' && p.fiscalYearEnd === '09-26' && !('phone' in p) && !('addresses' in p), JSON.stringify(p));
  const top = await sec.screen('assets', null, ctx, { now: new Date('2026-11-10T00:00:00Z') });
  const frameUrl = fetchImpl.calls.find((c) => c.url.includes('/frames/'))?.url || '';
  check('screen: one frames call — a balance figure at last year\'s end', /frames\/us-gaap\/Assets\/USD\/CY2025Q4I\.json$/.test(frameUrl) && top.rows.length === 5 && top.rows[0].value >= top.rows[1].value, frameUrl);
  check('every SEC call carried the owner\'s contact', fetchImpl.calls.every((c) => c.headers['User-Agent'] === 'Synapsez ops@example.com'));
  delete process.env.SEC_USER_AGENT;
}

const coingecko = await import('../server/finance/sources/coingecko.js');

section('7f coingecko.js: every result says "Powered by CoinGecko"');
{
  await fresh();
  const fetchImpl = serve([
    ['simple/price', 'coingecko-simple.json'],
    ['/search?query=wif', { coins: [{ id: 'dogwifcoin', symbol: 'WIF' }] }],
    ['market_chart', { prices: [[1794182400000, 74000], [1794268800000, 74779]], total_volumes: [[1794182400000, 3e10], [1794268800000, 2.9e10]] }],
  ]);
  const ctx = { fetchImpl };
  const [btc] = await coingecko.quote(['btc'], 'vnd', ctx);
  check('BTC in USD and VND', btc.price === 74_779 && btc.also?.currency === 'VND' && btc.also.price === 1_912_760_356 && btc.name === 'bitcoin', JSON.stringify(btc));
  check('  with the attribution CoinGecko\'s terms require', btc.attribution?.includes('Powered by CoinGecko'));
  const asked = fetchImpl.calls[0].url;
  check('  asked by id, for USD and VND', /ids=bitcoin/.test(asked) && /vs_currencies=usd%2Cvnd/.test(asked), asked);
  check('  without a Demo key, no key header', !('x-cg-demo-api-key' in fetchImpl.calls[0].headers));
  check('a coin not in the list is searched for, once', (await coingecko.coinId('wif', ctx)) === 'dogwifcoin' && (await coingecko.coinId('wif', ctx)) === 'dogwifcoin' && fetchImpl.calls.filter((c) => c.url.includes('search')).length === 1);
  process.env.COINGECKO_DEMO_KEY = 'CG-demo-test';
  const h = await coingecko.history('btc', { days: 2 }, ctx);
  check('with COINGECKO_DEMO_KEY, the key goes in its header', fetchImpl.calls.at(-1).headers['x-cg-demo-api-key'] === 'CG-demo-test');
  delete process.env.COINGECKO_DEMO_KEY;
  check('history: dated prices, attributed', h.bars.length === 2 && h.bars[1].c === 74_779 && h.bars[1].t === '2026-11-10' && h.attribution.includes('Powered by CoinGecko'), JSON.stringify(h.bars));
  check('the old COINS map came along', coingecko.COINS.btc === 'bitcoin' && coingecko.COINS.sol === 'solana');
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll finance checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
