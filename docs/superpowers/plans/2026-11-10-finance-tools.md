# Finance Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `market_data` into one finance tool (13 kinds + US screen) over a small, cached, rate-limited, licence-clean data layer in `server/finance/`, Vietnam first and global through Yahoo, SEC, CoinGecko, FX and macro sources.

**Architecture:** `server/tools/library.js` keeps the `market_data` entry and hands every request to `server/finance/index.js`, which picks a chain of sources from a table (`chains.js`), runs it through one fetch helper (`http.js`: honest UA, timeouts, per-host pacing, stand-aside, kill switches, pooled caps via `freeTier.js`) and one cache (`cache.js`: Postgres `finance_cache` + per-instance LRU), normalises each source in `sources/*.js`, applies Vietnamese market rules in `vn.js`, and formats a compact text answer plus a `market` card widget in `format.js`.

**Tech Stack:** Node 22 ESM, Express, Postgres (pg / pglite in tests), the repo's hand-rolled test harness (`node test/<name>.test.mjs`, `check(label, condition)`), Playwright for the one UI test.

**Spec:** `docs/superpowers/specs/2026-11-10-finance-tools-design.md`. **Research (read §1–§7 before Task 1):** `docs/research/2026-11-10-finance-sources.md`. Raw probe responses to turn into fixtures: `C:/Users/user/AppData/Local/Temp/claude/e2a6cb1344d1fdcc/4d5c442b-aa7d-48e0-bc2d-62e8870ad7a8/scratchpad/research/probes/`.

## Global Constraints

- Free only. No paid API, no trial needing a card. Never wire Finnhub, Tiingo, Twelve Data, Massive/Polygon, Alpaca, FMP, EODHD, Alpha Vantage, SSI, MSN, BTMC, Stooq, Binance, TCBS — not even switched off.
- Honest `User-Agent: Synapsez/<package version> (+https://github.com/; market data on request)` on every call, except SEC, which gets `process.env.SEC_USER_AGENT`; **never** a spoofed Referer/Origin or a browser UA, except Yahoo where the existing code already sends `Mozilla/5.0` (keep that only for Yahoo; it is what works today).
- If `SEC_USER_AGENT` is unset, SEC is skipped (the chain falls through) and the result says "SEC needs SEC_USER_AGENT". Never put a contact address in code.
- Calls only when a user asks: no background crawling, no screener over a whole Vietnamese market, no bulk export. History ≤ 250 rows per call.
- Every result carries its source name, as-of time in the exchange's zone, live/delayed/EOD, unit, adjusted or raw, and "chỉ để tham khảo, không phải khuyến nghị đầu tư" / "for reference only, not investment advice" (in the result's language: Vietnamese when the market is `vn`, otherwise English — the model translates as it answers).
- Attribution where a source requires it: "Powered by CoinGecko"; open.er-api link `https://www.exchangerate-api.com`; FRED notice "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."; "Source: ECB statistics"; World Bank "CC BY 4.0".
- Drop Vietcap's analyst rating and target price fields wherever they appear.
- Do not copy vnstock code, mapping tables or header lists. Labels come from the sources' own metadata.
- Kill switch: `FIN_SOURCE_<NAME>=off` (`YAHOO, VNDIRECT, KBS, VIETCAP, SEC, COINGECKO, FRANKFURTER, ECB, ERAPI, VIETCOMBANK, SJC, WORLDBANK, FRED, NSO, FMARKET`).
- Schema version **45** for `finance_cache` (spec A, built in parallel, takes 44). If on merge 44 is not there yet, the lead renumbers — write the migration so it does not depend on 44.
- Browser tests: only the new `test/ui-market.test.mjs` on **port 5236**. Do not run `npm run test:ui`, `test/ui-bots.test.mjs` or `test/ui.test.mjs` (another worktree uses their ports). Run the non-browser suites freely.
- Every new user-facing string in vi and en (`server/i18n/vi.js` for server messages if any; `public/js/locales/{en,vi}.js` for the card). `test/i18n.test.mjs` must pass.
- CLAUDE.md §5 Definition of Done applies. Do not merge into main and do not push; commit on your worktree branch. Do not touch `.env*`.

---

## File structure

| File | Responsibility |
|---|---|
| `server/finance/index.js` | `marketData(request)`: validate, route to chain, format; batching of `requests[]` |
| `server/finance/chains.js` | `CHAINS[kind][market]` → ordered source names; `enabled(name)` (kill switch) |
| `server/finance/http.js` | `getJson/getText(url, {source, headers, timeoutMs})`: UA, timeout, pacing, stand-aside, caps |
| `server/finance/cache.js` | `cached(key, ttlMs, load)`, `ttlFor(kind, ctx)`; Postgres + LRU |
| `server/finance/vn.js` | board lookup, sessions, bands, ticks, reference rules, units |
| `server/finance/format.js` | header line, tables, attribution, `market` widget |
| `server/finance/sources/yahoo.js` | chart, crumb flow, v10 quoteSummary, v7 options, timeseries, search |
| `server/finance/sources/vndirect.js` | stock_prices (raw + adjusted), dchart, ratios/latest |
| `server/finance/sources/kbs.js` | data_day / data_nP, index, trade history, finance-info, profile, news |
| `server/finance/sources/vietcap.js` | financial-statement (+metrics labels), statistics-financial, details, events, news, getByGroup |
| `server/finance/sources/sec.js` | ticker→CIK, companyfacts, submissions, frames |
| `server/finance/sources/coingecko.js` | simple/price, market_chart, search, coins/{id} |
| `server/finance/sources/fx.js` | Frankfurter v2, ECB, open.er-api, Vietcombank |
| `server/finance/sources/gold.js` | SJC PriceService |
| `server/finance/sources/macro.js` | World Bank, FRED, NSO |
| `server/finance/sources/fmarket.js` | products/{id} with a kept id map |
| `server/store/schema.sql`, `server/store/pg.js` | `finance_cache` table, `SCHEMA_VERSION`, store methods |
| `server/freeTier.js` | `minute`/`hour` periods; `coingecko`, `yahoo`, `vndirect`, `kbs`, `vietcap`, `sec`, `fred` tiers |
| `server/tools/library.js` | `market_data` → `marketData`; `convert_units` FX via `sources/fx.js`; remove old `TICKERS`/`stockQuotes`/`cryptoQuotes` |
| `server/tools/definitions.js` | new `market_data` schema (~500 tokens) |
| `public/js/cards.js` | `kind: 'market'` figure |
| `public/css/app.css` | market card styles |
| `public/js/locales/{en,vi}.js` | card strings |
| `scripts/finance-probe.mjs` | server-IP probe (Vercel Sandbox) |
| `test/finance.test.mjs` (+ `package.json` script `test:finance`, added to `npm test`) | adapters, chains, vn rules, cache, format |
| `test/fixtures/finance/*.json` | trimmed probe responses |
| `test/ui-market.test.mjs` (port 5236) | card render |
| `test/egress.test.mjs` | allow-list gains the finance hosts |
| `test/toolbudget.test.mjs` | `market_data` ≤ 600 tokens |
| `test/eval/` | three cases |
| `docs/vercel-config.md`, `NOTICE`, `CHANGELOG.md` | env, attributions, entry |

---

### Task 1: Probe from a server IP (rule 3) and record fixtures

**Files:** Create `scripts/finance-probe.mjs`; Create `test/fixtures/finance/*.json`; Create `docs/research/2026-11-10-finance-probe-iad1.md`; Modify `package.json` (script `finance:probe`).

- [ ] **Step 1:** Read `scripts/e2b-probe.mjs` and `server/sandbox.js` to see how this repo starts a Vercel Sandbox (`@vercel/sandbox`) and runs a command in it. Write `scripts/finance-probe.mjs` that starts one sandbox, writes a small Node script into it that GETs each URL of research §3.9 (honest UA, 10 s timeout; SEC with `process.env.SEC_USER_AGENT` passed in) and prints `{url, status, ms, bytes, first120}` as JSON lines, runs it, prints the table, and stops the sandbox. No POSTs. If the sandbox cannot start (no credentials in this environment), print that and exit 2 — do not fake results.
- [ ] **Step 2:** Run `node scripts/finance-probe.mjs`. If it ran, write `docs/research/2026-11-10-finance-probe-iad1.md` with the table and which sources are therefore built. If it could not run, write that file saying so and continue: every source is still built behind its kill switch, and the report lists the probe as owed (the lead decides).
- [ ] **Step 3:** From the scratchpad `probes/` folder, make trimmed JSON fixtures (keep ≤ 5 rows / the fields we read) named `yahoo-chart-fpt.json`, `yahoo-chart-aapl.json`, `yahoo-timeseries.json`, `vndirect-stock-prices.json`, `dchart.json`, `kbs-day.json`, `kbs-intraday.json` (include one row with string numbers), `kbs-finance.json`, `vietcap-statement.json`, `vietcap-metrics.json`, `vietcap-events.json`, `vietcap-group.json`, `sec-tickers.json`, `sec-companyfacts.json`, `coingecko-simple.json`, `frankfurter.json`, `ecb.json`, `erapi.json`, `vietcombank.json`, `sjc.json`, `worldbank.json`. Where a probe file is missing for a shape, write the fixture from the response shape documented in research §3 and mark it `"_synthetic": true`.
- [ ] **Step 4:** Commit: `git add scripts/finance-probe.mjs test/fixtures/finance docs/research/2026-11-10-finance-probe-iad1.md package.json && git commit -m "chore(finance): server-IP probe and recorded fixtures"`.

### Task 2: Cache table and store methods (schema 45)

**Files:** Modify `server/store/schema.sql` (append), `server/store/pg.js` (header line, `SCHEMA_VERSION = 45` — or `max(current+1)`), store methods; Test `test/schema.test.mjs`, `test/finance.test.mjs`.

**Interfaces — Produces:** `store.financeGet(key) → { value, fetched_at, expires_at } | null`; `store.financePut(key, value, expiresAt: Date)`; `store.financeSweep() → number` (deletes `expires_at < now() - interval '1 day'` and rows with `expires_at` null older than 400 days).

- [ ] **Step 1:** Append to `schema.sql`:
```sql
-- 45 (owner, 2026-11-10): market data shared by every account and instance, so a
-- price asked twice is fetched once. Only the fields the tool returns are kept.
CREATE TABLE IF NOT EXISTS finance_cache (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS finance_cache_expires_idx ON finance_cache (expires_at);
```
Bump `SCHEMA_VERSION`, add the header comment line `45  finance_cache — market data shared across accounts (server/finance/cache.js)`.
- [ ] **Step 2:** Write the failing test in `test/finance.test.mjs` (copy the harness shape from `test/library.test.mjs`: pglite store via the same setup those tests use): put/get round trip, an expired row is still returned by `financeGet` (the caller decides staleness), sweep deletes old ones.
- [ ] **Step 3:** Implement the three methods in `pg.js` next to the other small tables (parameterised SQL, `value` as JSON).
- [ ] **Step 4:** `node test/schema.test.mjs && node test/finance.test.mjs` → PASS. Add `test:finance` to `package.json` and to the `test` chain (after `test:library`).
- [ ] **Step 5:** Commit `feat(finance): finance_cache table (schema 45)`.

### Task 3: freeTier minute/hour periods and finance tiers

**Files:** Modify `server/freeTier.js`; Test `test/finance.test.mjs` (and the existing free-tier tests must still pass — find them with `grep -l periodOf test`).

- [ ] **Step 1: failing tests:** `periodOf('minute', new Date('2026-11-10T08:15:42Z'))` → `{ key: '2026-11-10T08:15', ends: 2026-11-10T08:16:00Z }`; `periodOf('hour', …)` → key `2026-11-10T08`, ends 09:00Z; `day`/`month` unchanged. `allowance('coingecko')` is a number under the month ceiling; tiers listed in `FREE_SERVICES` include `coingecko, coingecko_minute, yahoo, vndirect, kbs, vietcap, sec, fred`.
- [ ] **Step 2:** Extend `periodOf`:
```js
if (per === 'minute') {
  const h = now.getUTCHours(); const mi = now.getUTCMinutes();
  return { key: `${month}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, ends: new Date(Date.UTC(y, m, d, h, mi + 1)) };
}
if (per === 'hour') {
  const h = now.getUTCHours();
  return { key: `${month}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}`, ends: new Date(Date.UTC(y, m, d, h + 1)) };
}
```
Add tiers (env-overridable like the others): `coingecko: month 9_500 (COINGECKO_FREE_MONTHLY)`, `coingecko_minute: minute 90`, `yahoo: day 5_000`, `vndirect/kbs/vietcap: day 3_000 each`, `sec: day 20_000`, `fred: minute 100`. Document them in the header comment (checked 2026-11-10, research §4). Keyless ones are "polite caps": they do not go through the per-user fair share (`mayMeter`), only `take`.
- [ ] **Step 3:** Run tests → PASS. **Step 4:** Commit `feat(finance): minute and hour free-tier periods, finance ceilings`.

### Task 4: `http.js` — the only fetch

**Files:** Create `server/finance/http.js`, `server/finance/chains.js`; Test `test/finance.test.mjs`.

**Interfaces — Produces:**
```js
export class SourceError extends Error { constructor(source, message, { status = 0, standAside = false } = {}) }
export async function getJson(source, url, { headers = {}, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) // → parsed JSON
export async function getText(source, url, options) // → string
export function enabled(source) // false when FIN_SOURCE_<SOURCE>=off
export function __resetHttp() // tests: clears pacing and stand-aside state
```
Behaviour: refuses at once (`SourceError`, no network) when the source is disabled, standing aside, or `take(<tier>, 1)` from freeTier says no; paces per host (`PACE_MS = { vndirect: 1000, kbs: 1000, vietcap: 1000, yahoo: 500, sec: 200, default: 0 }` — wait the remaining gap with a timer, per instance); `AbortSignal.timeout(timeoutMs)`; status 403/429 → stand aside (Yahoo 15 min, VN brokers 60 min, others 10 min) and throw `standAside: true`; non-2xx → throw with status; sets the UA per the Global Constraints. `fetchImpl` is injectable for tests.

- [ ] **Step 1: failing tests** with a fake fetch: disabled source never calls fetch; 429 sets stand-aside so the next call throws without fetching; pacing makes two kbs calls ≥ 1000 ms apart (use a fake clock or measure with a 50 ms pace override env `FIN_PACE_SCALE=0.05`); UA header is the honest one for kbs and SEC_USER_AGENT for sec; SEC without env throws `SourceError` mentioning SEC_USER_AGENT.
- [ ] **Step 2:** Implement. `chains.js` exports `CHAINS` exactly as spec §2's table (source names lower-case) and `chainFor(kind, market)` filtering by `enabled`.
- [ ] **Step 3:** PASS. **Step 4:** Commit `feat(finance): one fetch helper with pacing, stand-aside, kill switches; the chains table`.

### Task 5: `cache.js` and TTL rules

**Files:** Create `server/finance/cache.js`; Test `test/finance.test.mjs`.

**Interfaces — Produces:** `cached(key, ttlMs, load) → value` (LRU 300 entries in front of the store; a store failure falls back to calling `load`); `ttlFor(kind, { market, now, closedDay, session })` returning ms per spec §4 (quote in session VN 45 s / US 20 s; outside session until next open — VN next 09:00 Asia/Ho_Chi_Minh weekday; intraday 2 min; raw closed-day bar `Infinity` → stored with `expires_at` null; statements/ratios 1 day; events 8 h; news 10 min; fx vietcombank 5 min, others 1 h, past dates Infinity; gold 5 min; macro/listings/sec-tickers 1 day; crumb 6 h; coingecko ≤ 24 h).

- [ ] **Step 1: failing tests:** second `cached` call does not call `load`; expired → `load` again; `ttlFor('quote', {market:'vn', session:'closed', now: Fri 16:00 ICT})` reaches Monday 09:00 ICT; adjusted-history invalidation helper `adjustedStillValid(cachedAt, events)` false when an event's ex-date is after `cachedAt`.
- [ ] **Step 2:** Implement. **Step 3:** PASS. **Step 4:** Commit `feat(finance): shared cache with per-kind lifetimes`.

### Task 6: `vn.js` — Vietnamese market rules

**Files:** Create `server/finance/vn.js`; Test `test/finance.test.mjs`.

**Interfaces — Produces:**
```js
export function sessionAt(board, date) // 'pre' | 'ato' | 'continuous' | 'break' | 'atc' | 'plo' | 'putthrough' | 'closed'  (Asia/Ho_Chi_Minh)
export function band(board, { firstDay = false } = {}) // 0.07 | 0.10 | 0.15  (first day 0.20/0.30/0.40)
export function tick(board, price, { instrument = 'stock' } = {}) // HOSE <10k:10, <50k:50, else 100; ETF/CW 10; HNX/UPCoM 100
export function limits(board, reference) // { ceiling (round down to tick), floor (round up to tick) }
export function changePct(price, reference) // always against the reference, never the previous close
export async function boardOf(symbol) // 'HOSE' | 'HNX' | 'UPCOM' | null, from vietcap getByGroup lists cached 1 day; KBS search as fallback
export const VN_LABEL = { vi: 'chỉ để tham khảo, không phải khuyến nghị đầu tư', en: 'for reference only, not investment advice' }
```
- [ ] **Step 1: failing tests:** research §5 worked examples — ref 65.2k HOSE → ceiling 69.7k, floor 60.7k (in VND: 65,200 → 69,700 / 60,700); UPCoM ref 39,200 → 45,000 / 33,400; HOSE 09:05 is `ato`, 11:45 `break`, 14:35 `atc`, 14:50 `putthrough`, Saturday `closed`; UPCoM 14:40 `continuous`; tick(HOSE, 9,990)=10, (HOSE, 25,000)=50, (HOSE, 65,200)=100, (HNX, 12,000)=100.
- [ ] **Step 2:** Implement (Intl.DateTimeFormat with `timeZone: 'Asia/Ho_Chi_Minh'` for the clock). **Step 3:** PASS. **Step 4:** Commit `feat(finance): Vietnamese sessions, bands, ticks and board lookup`.

### Task 7: Source adapters (one commit per source)

**Files:** Create each `server/finance/sources/*.js`; Test `test/finance.test.mjs` against fixtures (pass `fetchImpl` that serves the fixture for the URL).

**Interfaces — Produces** (every adapter exports only what it supports; all async; all return plain objects in the shapes below; all throw `SourceError` on failure):
```js
// shapes
Quote  = { symbol, name?, board?, currency, unit: 'VND'|'USD'|'points'|…, price, reference?, ceiling?, floor?, change?, changePct?, volume?, asOf: ISO, delay: 'live'|'delayed'|'eod'|'auction', source }
Bars   = { symbol, currency, unit, adjusted: boolean, bars: [{ t: 'YYYY-MM-DD' | ISO, o, h, l, c, v }], source, note? }
Statement = { symbol, kind: 'income'|'balance'|'cashflow', period: 'year'|'quarter', unit, template?: 'corporate'|'bank'|'securities'|'insurance', periods: [{ label: '2025' | 'Q3 2025', published?, audited?, consolidated? }], lines: [{ code, label_vi, label_en, values: number[] }], source }
Ratios = { symbol, asOf, items: [{ key: 'pe'|'pb'|'roe'|…, label_vi, label_en, value }], source }
Profile, Events (= [{ date, code, title_vi, title_en, ratio?, exDate?, recordDate? }]), News (= [{ date, title, publisher?, url }]), Fx (= [{ base, quote, rate, date, kind: 'reference'|'bank-cash'|'bank-transfer'|'bank-sell' }]), Gold (= [{ name, branch?, buy, sell, unit: 'VND/lượng', asOf }]), Macro (= { indicator, country, unit, points: [{ date, value }] }).
```
Per source, read research §3 for URLs and field names, then:

- [ ] **7a yahoo.js:** `quote(sym)`, `history(sym, {period, from, to, interval, adjusted})` (adjusted → `adjclose`, else `close`, which is split-adjusted — say so in `note`), `intraday`, `statements(sym, kind, period)` via fundamentals-timeseries, `crumb()` (fc.yahoo.com cookie → getcrumb, cached 6 h via `cached`), `summary(sym, modules)` (v10 with crumb), `options(sym, date?)` (v7 with crumb), `search(q)` (quotes + news). Ticker mapping: `vnindex` → `^VNINDEX.VN`; **no** `^VN30.VN` / `^HNX.VN` (they do not exist); a VN code goes to Yahoo only when `boardOf` says HOSE. Tests: FPT fixture price/currency/zone; AAPL; "Not Found" → SourceError.
- [ ] **7b vndirect.js:** `quote`, `history` (raw `open..close` × 1000 to VND when `adjusted:false`; `adOpen..adClose` × 1000 when true; volume `nmVolume` never adjusted), `dchart(sym, resolution, from, to)` (× 1000), `ratios(sym)` (itemCode 51003 = market cap; others only if their meaning is in research — else omit). Tests: units ×1000, raw vs adjusted columns differ on the bonus-issue fixture row.
- [ ] **7c kbs.js:** `history`, `intraday(sym, interval)` (coerce string numbers with `Number()`; ignore missing `va`), `indexHistory(code)`, `ticks(sym, n)`, `statements(sym, kind, period)` (`unit=1000` → thousand VND, multiply to VND; `Audit` codes KT/SX/CKT → audited/reviewed/unaudited; `HN` → consolidated), `profile`, `news`. Tests: string-number row coerced; unit fixed.
- [ ] **7d vietcap.js:** `statements(sym, kind, period)` with labels from `/financial-statement/metrics` (cache 1 day), template from `comTypeCode` (CT/NH/CK/BH); `ratios(sym)` from `statistics-financial` (latest quarter TTM); `profile(sym)` from `company/details` **dropping any rating/target fields**; `events(sym, from, to)`; `news(sym)`; `group(name)` from `getByGroup` (VN30, HOSE, HNX, UPCOM, ETF, CW, FU_INDEX). Tests: labels vi/en present; rating/target absent; bank template detected.
- [ ] **7e sec.js:** `cik(ticker)` from company_tickers.json (cached 1 day); `statements(ticker, kind, period)` from companyfacts with ~15 headline us-gaap tags per kind (income: Revenues/RevenueFromContractWithCustomerExcludingAssessedTax, CostOfRevenue, GrossProfit, OperatingIncomeLoss, NetIncomeLoss, EarningsPerShareDiluted…; balance: Assets, Liabilities, StockholdersEquity, CashAndCashEquivalentsAtCarryingValue…; cashflow: NetCashProvidedByUsedInOperatingActivities, …InvestingActivities, …FinancingActivities, PaymentsToAcquirePropertyPlantAndEquipment) — dedupe by `frame` else latest `filed`; `filings(ticker, n)` from submissions; `screen(tag, period)` from frames (top 20 by value). Tests: dedupe picks one value per period; no UA → SourceError.
- [ ] **7f coingecko.js:** `quote(symbols, vs)` (keep the existing `COINS` map from library.js; `x-cg-demo-api-key` header when `COINGECKO_DEMO_KEY`; takes `coingecko` and `coingecko_minute`), `history(sym, days)`, `profile(sym)`. Attribution "Powered by CoinGecko" set on every result.
- [ ] **7g fx.js:** `rates(base, quotes, date?)` → Frankfurter v2 → ECB → open.er-api (attribution link) → Yahoo `=X`; `vndBank(date?)` → Vietcombank (cash/transfer/sell, strings → numbers; 5-minute cache shared via `cached`). Export `convert(amount, from, to)` for `convert_units`.
- [ ] **7h gold.js:** `sjc()` → rows in VND/lượng (37.5 g); world gold via yahoo `GC=F`.
- [ ] **7i macro.js:** `worldBank(country, code, n)`, `fred(series, n)` (only with `FRED_API_KEY`; FRED notice), `nso()` browse only (list tables; a query is POST — leave a typed "not available in this version" for NSO data points); indicator names map: gdp → NY.GDP.MKTP.KD.ZG, cpi → FP.CPI.TOTL.ZG, unemployment → SL.UEM.TOTL.ZS, US rate → FRED DGS10/FEDFUNDS.
- [ ] **7j fmarket.js:** `fund(id)` from `products/{id}`; a small kept map `FUNDS = { 'VESAF': 23, … }` only for ids seen in the probes — say plainly in the result when a fund is not in the map.
- [ ] Each sub-step: failing fixture test → implement → PASS → commit `feat(finance): <source> adapter`.

### Task 8: `format.js` and `index.js` — the tool's answer

**Files:** Create `server/finance/format.js`, `server/finance/index.js`; Test `test/finance.test.mjs`.

**Interfaces — Produces:** `export async function marketData(request, { now = new Date() } = {}) → { content: string, note: string, widget?: { kind: 'market', … } }` (accepts the legacy `{ kind: 'crypto' | 'stock', symbols, market }` too: `crypto` → kind quote market crypto; `stock` → kind quote). Batch: `requests[]` up to 6, each answered independently; one failing never fails the batch.

The header line, the tables and limits exactly as spec §6. `content` is the data (it is external, the execute layer envelopes it); `note` is the app's own guidance ("A card with these numbers is shown to the user; do not repeat every row. Say the source and that it is for reference.").

Widget shape:
```js
{ kind: 'market', title: 'FPT · HOSE', rows: [{ label, value, sub? }], series?: [{ t, c }], session?: 'continuous', source: 'VNDIRECT', attribution: ['…'], asOf: ISO, delay: 'delayed', disclaimer: 'chỉ để tham khảo…' }
```
- [ ] **Step 1: failing tests:** VN quote text has reference/ceiling/floor/session/source/disclaimer; UPCoM change % uses reference; history returns ≤ 30 rows + summary line, says "volumes are not adjusted" when adjusted; statement shows ≤ 4 periods and unit/period/audited/consolidated; first source failing → second answers and the text names both; whole chain failing → "temporarily unavailable" line, batch still answers the others; legacy `{kind:'crypto'}` works; CoinGecko result carries "Powered by CoinGecko" in text and widget.
- [ ] **Step 2:** Implement. **Step 3:** PASS. **Step 4:** Commit `feat(finance): one answer shape — header, tables, attribution, market card`.

### Task 9: Wire the tool

**Files:** Modify `server/tools/library.js` (replace `marketDataTool`, `cryptoQuotes`, `stockQuotes`, `TICKERS`, `tickerFor`'s VN branch; keep `tickerFor` exported only if a test imports it — grep first), `convertUnitsTool` (FX through `fx.convert`, with the open.er-api link when it answered), `server/tools/definitions.js` (`market_data` schema per spec §1), `server/stepOrder.js` (unchanged regex — check), `test/library.test.mjs` (update expectations that pinned the old text), `test/toolbudget.test.mjs` (cap 600 for market_data), `test/egress.test.mjs` (allow-list hosts: query1/query2.finance.yahoo.com, fc.yahoo.com, api-finfo.vndirect.com.vn, dchart-api.vndirect.com.vn, kbbuddywts.kbsec.com.vn, iq.vietcap.com.vn, trading.vietcap.com.vn, data.sec.gov, www.sec.gov, api.coingecko.com, api.frankfurter.dev, data-api.ecb.europa.eu, open.er-api.com, www.vietcombank.com.vn, sjc.com.vn, api.worldbank.org, api.stlouisfed.org, pxweb.nso.gov.vn, api.fmarket.vn).

- [ ] **Step 1:** `grep -rn "tickerFor\|marketDataTool\|stockQuotes\|cryptoQuotes\|open.er-api" server test public` and list every user. **Step 2:** failing test in `test/library.test.mjs`: `market_data({ kind: 'quote', market: 'vn', symbols: ['SHS'] })` with a fake fetch answers from KBS (HNX), not Yahoo; `^VN30` is never requested from Yahoo. **Step 3:** implement; write the new definition (description ≤ 450 characters; parameters per spec §1; `kind` enum; keep `requests`). **Step 4:** `node test/library.test.mjs && node test/toolbudget.test.mjs && node test/egress.test.mjs && node test/finance.test.mjs` → PASS. **Step 5:** commit `feat(finance): market_data reads the finance layer; FX for convert_units`.

### Task 10: The market card

**Files:** Modify `public/js/cards.js` (`if (widget?.kind === 'market') return marketFigure(widget);`), `public/css/app.css`, `public/js/locales/{en,vi}.js`; Create `test/ui-market.test.mjs` (port 5236; model it on the smallest existing ui test that renders a tool widget — find one with `grep -l "widget" test/ui*.mjs`).

- [ ] **Step 1: failing UI test:** a fake provider answers one `market_data` call; the card shows the title, ≥ 3 rows, the session chip, the source and the attribution footer, the disclaimer; a history widget draws an inline SVG sparkline (no library); keyboard focus reaches the card's link; dark and light themes both readable (contrast via computed colours ≥ 4.5:1 for text).
- [ ] **Step 2:** Implement `marketFigure` with DOM APIs / escaped strings like the other figures in cards.js; sparkline as an SVG polyline scaled to 120×32; numbers formatted with `Intl.NumberFormat(locale)`; up green / down red with a +/− sign (not colour alone).
- [ ] **Step 3:** `node test/ui-market.test.mjs && node test/i18n.test.mjs` → PASS. **Step 4:** commit `feat(finance): market card with source and attribution`.

### Task 11: Evals, docs, notices

**Files:** `test/eval/` (read `test/eval/run.mjs` and an existing case to learn the format), `docs/vercel-config.md`, `NOTICE`, `CHANGELOG.md` (an "Unreleased" entry; the lead sets the version), `.claude/skills/new-tool` not required.

- [ ] **Step 1:** Three eval cases: "Giá FPT hôm nay?" → one `market_data` call `{kind:'quote', market:'vn', symbols:['FPT']}`; "Apple's revenue last 4 years" → `{kind:'statements', market:'us', symbols:['AAPL'], statement:'income', period:'year'}`; "Giá vàng SJC" → `{kind:'gold'}`. Run `npm run eval` — if `PROMPT_STAMP` changes, update it as the eval tool instructs and say so in the hand-back.
- [ ] **Step 1b:** Privacy: `grep -rn "open.er-api\|coingecko\|Yahoo" public/legal docs/legal server/legal.js` — if the privacy page lists the outside services the app calls, add "market data providers — only the symbols, dates and indicator codes asked about; never your words or account" in vi and en, without changing the policy version (no personal data is sent, so no re-consent). If it lists none, change nothing and say so in the hand-back.
- [ ] **Step 2:** docs/vercel-config.md: `SEC_USER_AGENT` (format "Synapsez <contact email>", required for US statements), `COINGECKO_DEMO_KEY`, `FRED_API_KEY`, `FIN_SOURCE_<NAME>=off`. NOTICE: a "Market data" section with each source's attribution and the note that Vietnamese broker endpoints are used without a licence, on request only, labelled, and switched off by env if a broker objects.
- [ ] **Step 3:** `npm run lint && npm run typecheck && node test/finance.test.mjs && node test/library.test.mjs && node test/egress.test.mjs && node test/toolbudget.test.mjs && node test/ui-market.test.mjs && node test/i18n.test.mjs && node test/schema.test.mjs` → all PASS (typecheck uses a ratchet; a new error fails — fix it, never raise the baseline).
- [ ] **Step 4:** commit `docs(finance): settings, notices, evals`.

## Hand-back

Report: what was built per task, the probe result (or that it could not run), every test command run with its result, anything left out and why, the eval stamp change. Do not merge or push.
