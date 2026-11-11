# Finance tools (spec D) · 2026-11-10

The owner's "Finance Tools — từ Việt Nam tới Global" plan (2026-11-05), checked
source by source on 2026-11-10 (`docs/research/2026-11-10-finance-sources.md`), and
the owner's decisions of 2026-11-10:

- **Vietnamese prices: grey, with safeguards.** VNDirect, KBS and Vietcap read-only
  GETs join Yahoo. On demand only, shared cache, an honest User-Agent, no spoofed
  Referer/Origin, a kill switch per source, every answer labelled with its source,
  its delay and "chỉ để tham khảo, không phải khuyến nghị đầu tư", no bulk export.
  The owner asks VNDirect and KBS for written permission.
- **Free-key APIs whose terms forbid display are left out** — Finnhub, Tiingo,
  Twelve Data, Massive (Polygon), Alpaca, FMP, EODHD, Alpha Vantage. Not wired, not
  even switched off.
- **SSI is excluded** (legal), in every layer. So are MSN (needs a key taken from
  Microsoft's client), BTMC (someone else's key), Stooq (JavaScript gate),
  Binance (451 from US IPs; commercial use needs consent), TCBS (dead).

The rules that already bind: free only; metered calls through `server/freeTier.js`;
a source is probed **from a server IP** before it is built on; zero cost.

## 1. One tool, not twelve

`market_data` (kept: evals and `stepOrder.js` know it) grows a `kind`. The owner's
twelve tools are all here as kinds; one schema costs ≈ 500 tokens and only on turns
that load it (it stays in `DEFERRABLE`), where twelve would cost 2,000–3,500 on
every step of those turns and blur the model's choice.

```
market_data
  requests[]  up to 6 of the objects below, answered together (existing pattern)
  kind        quote | history | intraday | statements | ratios | profile | events |
              news | fund | options | fx | gold | macro | screen
  symbols[]   up to 12 for quote/fx; 1 for the rest
  market      vn | us | global | crypto  (vn reads HOSE, HNX, UPCoM; the board is found, not guessed)
  period      history: 5d|1mo|3mo|6mo|1y|5y|max or from/to (YYYY-MM-DD); statements: year|quarter
  interval    intraday: 1m|5m|15m|30m|1h
  statement   income | balance | cashflow
  adjusted    history: true (default) | false
  vs          crypto/fx: the second currency (VND by default)
  indicator   macro: gdp | cpi | unemployment | rate | … or a World Bank / FRED code
```

`screen` is US only (SEC `frames`: companies by one reported figure); a Vietnamese
screen would mean crawling a whole market, which the safeguards forbid.

The tool description says, in the model's words: quotes may be delayed; never
present numbers as advice; cite the source line the result gives; for a picture,
call `chart` with the rows.

## 2. Sources and chains

Chains are a table (`server/finance/chains.js`), so an order or a kill switch is a
data change. `FIN_SOURCE_<NAME>=off` removes a source everywhere.

| kind | VN | US | global | crypto |
|---|---|---|---|---|
| quote | VNDirect `stock_prices` → KBS `data_day` → Yahoo (HOSE) | Yahoo chart → Yahoo v7 (crumb) | Yahoo | CoinGecko → Yahoo `X-USD` |
| history | VNDirect (raw + adjusted) → dchart → KBS → Yahoo (HOSE) | Yahoo | Yahoo | CoinGecko `market_chart` → Yahoo |
| intraday | KBS `data_{n}P` → dchart → Yahoo | Yahoo | Yahoo | CoinGecko |
| statements | Vietcap `financial-statement` (labels from its `metrics`) → KBS `finance-info` | SEC `companyfacts` → Yahoo timeseries | Yahoo timeseries | — |
| ratios | Vietcap `statistics-financial` → VNDirect `ratios/latest` → KBS `CSTC` | computed from SEC + price → Yahoo v10 (crumb) | Yahoo v10 | — |
| profile | Vietcap `company/details` (analyst rating and target **dropped**) → KBS `profile` | SEC `submissions` + Yahoo v10 | Yahoo v10 | CoinGecko `coins/{id}` |
| events | Vietcap `events` → Yahoo events | Yahoo events → SEC 8-K list | Yahoo | — |
| news | Vietcap `news` → KBS `news` → Yahoo search | Yahoo search | Yahoo search | — |
| fund | FMarket `products/{id}` (kept id map) · ETFs via Yahoo | Yahoo v10 `topHoldings` | Yahoo | — |
| options | VN: covered warrants / VN30F listed via Vietcap `getByGroup` (CW, FU_INDEX) | Yahoo v7 options (crumb) | — | — |
| fx | Vietcombank (bank rates) · Frankfurter v2 USD/VND (reference) | Frankfurter → ECB → open.er-api → Yahoo `=X` | same | — |
| gold | SJC `PriceService.ashx` (VND/lượng) | Yahoo `GC=F`, `SI=F` | same | — |
| macro | World Bank → NSO PX-Web | FRED (when `FRED_API_KEY`) → World Bank | World Bank, ECB | — |

Optional settings (free, no card): `COINGECKO_DEMO_KEY` (100/min instead of the
shared IP), `FRED_API_KEY`, and `SEC_USER_AGENT` ("Synapsez <contact>") — **the owner
supplies the contact**; until set, the SEC rows fall through to Yahoo and the result
says so. These go in docs/vercel-config.md, never in a committed env file.

## 3. Server shape

```
server/finance/
  index.js        marketData(request) → { text, widget?, attribution[] }: picks the chain, runs it, formats
  chains.js       the table above + kill switches
  http.js         the only fetch: honest UA, 8 s timeout, per-host pacing (≤1 req/s VN brokers,
                  ≤2 req/s Yahoo, ≤5 req/s SEC per instance), stand aside 15 min (Yahoo) / 60 min
                  (VN brokers) after 403/429, pooled daily caps through freeTier.js
  cache.js        Postgres `finance_cache` + a small per-instance LRU in front
  vn.js           board lookup (HOSE/HNX/UPCoM from Vietcap getByGroup, cached a day), sessions,
                  price bands, tick sizes, reference price rules, units
  format.js       compact tables, the header line, attribution
  sources/        yahoo.js vndirect.js kbs.js vietcap.js sec.js coingecko.js fx.js gold.js macro.js fmarket.js
```

Each source returns one normalised shape per kind (bars `{t,o,h,l,c,v,adj?}` in VND
or the instrument's currency; statements `{period, unit, consolidated, audited,
published, lines:[{code,label_vi,label_en,value}]}`), with types coerced (KBS sends
numbers as strings) and units fixed (VNDirect prices are thousand VND). No vnstock
code, mapping table or header list is copied; labels come from the sources' own
metadata.

`library.js` keeps its `market_data` entry point and calls `server/finance`. The
old `TICKERS` bug (`^VN30.VN`, `^HNX.VN`, every HNX/UPCoM code sent to `.VN`) is
gone with it. `convert_units` and `world_facts` read FX from `server/finance/sources/fx.js`.

## 4. Cache (schema 45)

`finance_cache(key text primary key, value jsonb, fetched_at timestamptz, expires_at
timestamptz)`, key = `source|kind|symbol|params`, swept by the heartbeat. TTLs:

| data | TTL |
|---|---|
| quote in session | VN 45 s, US 20 s; outside the session until the next open (VN 09:00 ICT) |
| intraday | 2 min |
| raw daily bar of a closed day | kept |
| adjusted history | until the next ex-date seen in events (`adjusted_as_of`) |
| statements, ratios | 1 day |
| events | 8 h · news 10 min |
| FX | Vietcombank 5 min (its own rule), Frankfurter / open.er-api 1 h, past dates kept |
| SJC gold | 5 min |
| macro, listings, SEC ticker map | 1 day |
| Yahoo cookie + crumb | 6 h |
| CoinGecko | ≤ 24 h (its terms) |

Values hold only the fields the tool returns (Supabase free tier is 500 MB).

## 5. freeTier.js

Adds `'minute'` and `'hour'` periods next to `'day'`/`'month'`. Metered: CoinGecko
Demo (9,500/month, 90/min). Polite pooled caps (not billed, but shown on the admin
Free allowances page): Yahoo 5,000/day, each VN broker 3,000/day, SEC 20,000/day,
FRED 100/min. A cap reached means the chain moves to its next source, then says
"temporarily unavailable" — never an error that fails the batch.

## 6. What a result looks like

Every answer starts with one header line:

`FPT · HOSE · 65.200 ₫ (+1,2 %) · tham chiếu 64.400 · trần 68.900 · sàn 59.900 · phiên liên tục · 10/11 14:12 ICT · trễ ~15 phút · nguồn VNDIRECT · chỉ để tham khảo`

- history: ≤ 30 rows by default (first/last/min/max/change, "N more rows — ask for chart"), raw or adjusted said; volumes are never adjusted, and the result says so when the series is adjusted.
- statements: ≤ 4 periods × ~15 headline lines; unit, period, consolidated or parent, audit status, publish date; bank/securities/insurance templates labelled.
- VN labels the facts that are easy to get wrong: thousand-VND vs VND, UPCoM's reference is yesterday's average (change % against the reference, never the previous close), HOSE 09:00–09:15 is an auction indication, not a trade, bands ±7/10/15 %, T+2.
- Attribution, in the text and in the card: "Powered by CoinGecko", the open.er-api link, the FRED notice, "Source: ECB statistics", World Bank CC BY 4.0, SEC, and each grey source's name.
- A per-symbol failure never fails the batch; it says which source failed and which answered instead.

**Card.** `quote`, `history`, `fx` and `gold` also return a `market` widget, drawn by
render.js like the map card: the numbers, a sparkline for history, the session
mark, and a footer with the source and attribution — so the terms are met even if
the model's sentence drops them. The existing CoinGecko and open.er-api
attribution gaps close with it.

## 7. Before building: probes from a server IP

`scripts/finance-probe.mjs` (like `e2b:probe`) runs every URL of
`docs/research/2026-11-10-finance-sources.md` §3.9 from inside a Vercel Sandbox
(US datacenter IP, as production) and writes which answered. A source that does
not answer there is not built, and the report says so. The result is recorded in
docs/research (no response bodies with personal data; these are public prices).

## 8. Privacy, legal, egress

- Only symbols, dates and indicator codes leave the server — never a person's words
  or account. The egress test's host allow-list gains exactly the hosts above.
- The privacy page's list of services the app calls gains "market data providers
  (symbols only)", if that list exists there; no consent change is needed since no
  personal data is sent (checked during implementation).
- NOTICE: data-source attributions (CoinGecko, ECB, World Bank CC BY 4.0, FRED,
  exchangerate-api link).
- Owner actions, said in the release note: set `SEC_USER_AGENT`; optionally the two
  keys; email VNDirect and KBS for permission.

## 9. Testing

- Adapters against recorded fixtures (`test/fixtures/finance/`, taken from the
  probes): units, type coercion, raw vs adjusted, board lookup, statement labels.
- Chains: a dead source falls through; a kill switch removes it; a cap reached falls
  through; a whole-chain failure says so.
- VN rules: bands rounded down/up to the tick, UPCoM reference, session from the clock.
- Cache: TTLs, adjusted history dropped after a newer ex-date.
- freeTier minute/hour periods.
- Token budget: the tool definition ≤ 600 tokens (toolbudget test).
- Card render (ui test) with attribution footer.
- Eval: a VN quote, a US statement and a gold-price question each pick `market_data`
  with the right kind in one call.

## Not in this spec

Licensed (paid) Vietnamese feeds; real-time streaming; portfolio tracking; alerts
(a scheduled task can already ask for a price).
