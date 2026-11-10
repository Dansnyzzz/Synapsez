# Finance data sources for Synapsez — research report

Checked 2026-11-10. This is research only: nothing in `D:\AI remote` was changed.

**How the probes were run.** Every probe was a small GET from the owner's Windows development machine. Cloudflare served it from Hong Kong (HKG) and Tokyo (NRT), and api.binance.com answered 200, so this machine is **not on a US IP**. That means **none of these probes count as rule (3)'s server-IP check.** `vercel.json` sets no `regions`, so the functions run in Vercel's default region, iad1 (Washington DC, a US datacenter IP). §3.9 lists the URLs to re-probe from a deployed function.

**User-Agent.** The probes sent `Synapsez-research/1.0`, with two exceptions:
- The Yahoo cookie/crumb tests and one Yahoo chart call sent `Mozilla/5.0`, which is what `library.js` already sends.
- One batch would have retried IMF and FRED with a browser UA after they refused the generic one. The session's safety check stopped that batch and it never ran, which is correct. Those two sources are recorded below as "refused/timed out with an honest UA".

**What was not done.**
- No POST requests were made, because the brief allowed GET only. So the VCI chart, the FMarket NAV history and the SJC by-date query were not probed.
- No keys were sent. The BTMC key that vnstock hard-codes was not sent either.

Raw probe outputs are in `C:\Users\user\AppData\Local\Temp\claude\e2a6cb1344d1fdcc\4d5c442b-aa7d-48e0-bc2d-62e8870ad7a8\scratchpad\research\probes\`. The vnstock 4.0.9 source that was read is in `…\scratchpad\research\vnstock_src\`.

---

## 1. Verdict per source

Column key:
- **Display** means: may we show this data to our own users inside a commercial app (the app sells top-ups)?
  - **ok**: the terms allow it, sometimes with attribution.
  - **grey**: there are no terms, or the terms don't cover this case.
  - **no**: the terms forbid it, or limit use to personal or internal use.
- **Here** means: did it answer from this machine on 2026-11-10?

### Market data: Vietnam

| Source | Free? | Key | Limits (verified where) | Here | Display | Notes |
|---|---|---|---|---|---|---|
| **VNDirect** `api-finfo.vndirect.com.vn/v4/*`, `dchart-api.vndirect.com.vn` | yes | none | none published. Sends `Cache-Control: max-age=300` | 200 | grey→no | Broker's internal API with no published terms. Best VN history: **raw and adjusted** columns, HOSE, HNX and UPCoM, back to 2013. The old host `finfo-api.vndirect.com.vn` timed out. |
| **KBS** `kbbuddywts.kbsec.com.vn/iis-server/investment/*` | yes | none | none published | 200 | grey→no | Broker's internal API. Daily, intraday, ticks, statements, profile, HNX coverage. vnstock's `sas/kbsv-stock-data-store/.../historical-quotes` path returns 404 (stale). |
| **VCI / Vietcap** `iq.vietcap.com.vn/api/iq-insight-service/*`, `trading.vietcap.com.vn/api/*` | yes | none | none published | 200 (GETs) | grey→no | Broker's internal API. Statements, ratios, events, news, listings. **Its OHLC chart, ticks and price board are POST** (not probed). The `company/details` reply carries Vietcap analyst ratings and target prices, which are Vietcap's own research. |
| **TCBS** `apipubaws.tcbs.com.vn` | — | — | — | **404 "Service not found"** | — | **Dead.** Removed from vnstock 4.x. |
| **MSN** `assets.msn.com/service/Finance` | — | **scraped key** | — | not probed | **no** | vnstock pulls an apikey out of MSN's app config (the horoscope widget's key). Using a key taken from someone else's client is not acceptable. |
| **FMarket** `api.fmarket.vn/res/products/{id}` | yes | none | none published | 200 | grey | The fund list and NAV history are POST (`/res/products/filter`, `/res/product/get-nav-history`). |
| **HOSE / HNX** official | — | — | — | — | — | **No free public API.** HOSE sells feeds "for internal usage and/or redistribution" through information vendors ([HOSE info service](https://en.vietstock.vn/2019/07/about-hoses-market-information-service-113-365572.htm)). |

### Market data: global

| Source | Free? | Key | Limits (verified where) | Here | Display | Notes |
|---|---|---|---|---|---|---|
| **Yahoo** v8 chart `query1.finance.yahoo.com/v8/finance/chart/{sym}` | yes | none | none published. IP-based 429s are widely reported ([yfinance #2441](https://github.com/ranaroussi/yfinance/issues/2441)). | 200 | grey→no | Unofficial API. yfinance's README says "intended for personal use only". Yahoo's help pages say not to redistribute. The product already depends on it. **No HNX or UPCoM stocks** (SHS, ACV: "Not Found"). `^VN30.VN` and `^HNX.VN` also "Not Found". |
| **Yahoo** v10 quoteSummary, v7 quote, v7 options | yes | **A3 cookie + crumb** | as above | 401 "Invalid Crumb" without a crumb. **200 with one.** | grey→no | The crumb flow works (details in §3.1). |
| **Yahoo** `ws/fundamentals-timeseries/v1/...` | yes | none, **no crumb needed** | as above | 200 | grey→no | Annual and quarterly statement lines, e.g. `annualTotalRevenue`. |
| **Yahoo** `v1/finance/search` (quotes + news) | yes | none | as above | 200 | grey | News items are headlines plus links to publishers. |
| **Finnhub** | free key | yes (sign-up) | 60/min (third-party figures; the official pricing page didn't render). **Candles are not free** (403, [issue #546](https://github.com/finnhubio/Finnhub-API/issues/546)). | 401 without a key | **no** | [ToS](https://finnhub.io/terms-of-service): "strictly for personal use"; "not … redistribute or share access to data or derived results"; data must be deleted when the subscription ends. |
| **Tiingo** | free key | yes | **50/hour, 1,000/day, 500 symbols/month, 1 GB/month**, verified on the [pricing page](https://www.tiingo.com/about/pricing) | 403 without a token | **no** | "Internal use … may not display or share the data with another person or organization." |
| **Twelve Data** Basic | free key | yes | **8/min, 800/day**. `income_statement` = 100 credits per symbol ([pricing](https://twelvedata.com/pricing)) | not probed | **no** | Basic is "Internal non-display usage". Statements can't be fetched at all on free: 100 credits exceeds the 8-per-minute budget. |
| **Massive (formerly Polygon.io)** Basic | free key | yes | 5/min, 2 years, end-of-day only (third-party; massive.com would not resolve from here) | not probed | **no** | Renamed 2025-10-30. "Business or commercial users may not use services labeled for individual or personal use." |
| **EODHD** | free key | yes | 20/day (+500 one-time), 1 year of end-of-day data | not probed | no / unverified | Too small to be useful anyway. |
| **Alpha Vantage** | free key | yes (org + email) | **25/day**, verified on the [support page](https://www.alphavantage.co/support/) | not probed | unverified | Too small. |
| **FMP** | free key | yes | 250/day, 500 MB per 30 days (third-party; the FMP site returned 403) | not probed | **no** | Display needs FMP's "Data Display and Licensing Agreement". |
| **Stooq** | key via captcha since ~March 2026 ([pandas-datareader #1012](https://github.com/pydata/pandas-datareader/issues/1012)) | captcha | unknown | **JS browser check** ("This site requires JavaScript to verify your browser") | grey/no | Unusable from serverless. Drop it. |
| **Alpaca** Basic | free account | yes | IEX only, **200 historical calls/min**, 30 WebSocket symbols, history since 2016 ([docs](https://docs.alpaca.markets/docs/about-market-data-api)) | 401 without a key | **no** | "Unfortunately, you cannot redistribute Alpaca API data." ([Alpaca support](https://alpaca.markets/support/redistribute-alpaca-api)) |
| **SEC EDGAR** `data.sec.gov` + `www.sec.gov/files/company_tickers.json` | yes | none, but a **declared UA** is required | **10 req/s** ([SEC](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)) | data.sec.gov: 200. **www.sec.gov: 403 with the generic UA** | **ok** | US government public data. The UA must look like `Company Name admin@company.com`: **the owner must supply a real contact**, and this report invents none. |

### Crypto

| Source | Free? | Key | Limits (verified where) | Here | Display | Notes |
|---|---|---|---|---|---|---|
| **Binance** `api.binance.com`, `data-api.binance.vision` | yes | none | **6,000 weight/min per IP**, read from exchangeInfo. Price or 24h ticker = weight 2. 429, then a 418 ban. | 200 / 200 | **no** (grey) | [Binance FAQ](https://www.binance.com/en-BH/support/faq/how-to-download-historical-market-data-on-binance-5810ae42176b4770b880ce1f14932262): apps that "charge for or otherwise profit from" Binance market data need written consent. **Expect HTTP 451 from US/datacenter IPs** ([Vercel thread, 2025-12-14](https://community.vercel.com/t/binance-api-calls-on-vercel/29895)). |
| **CoinGecko** | yes; Demo key free, **no card** | optional Demo key | **Demo: 100/min, 10k credits/month** ([pricing](https://www.coingecko.com/en/api/pricing)). Keyless: IP-based, shared by everyone on the IP, no figure published | 200 keyless | **ok with attribution** | [API terms (5 Sep 2025)](https://www.coingecko.com/en/api_terms): you may charge for products that integrate it (4.1.6). **"Powered by CoinGecko"** is required (4.1.4). Caches must refresh at least every 24 h (6.1). |

### FX, gold and macro

| Source | Free? | Key | Limits (verified where) | Here | Display | Notes |
|---|---|---|---|---|---|---|
| **Vietcombank** `www.vietcombank.com.vn/api/exchangerates?date=` (JSON) and portal XML | yes | none | XML header: "**Only one request every 5 minutes!**" | 200 / 200 | grey | The bank's posted cash, transfer and sell rates. Cite the source. |
| **SJC** `sjc.com.vn/GoldPrice/Services/PriceService.ashx` | yes | none | unknown (behind Cloudflare) | 200 for a GET of current prices | grey | Historical by-date needs POST `method=GetSJCGoldPriceByDate&toDate=dd/mm/yyyy`. |
| **BTMC** `api.btmc.vn/api/BTMCAPI/getpricebtmc?key=…` | — | **someone else's key** | — | timed out without a key | **no** | vnstock hard-codes a key taken from BTMC's own site. Don't use it. |
| **Frankfurter** `api.frankfurter.dev/v2/*` | yes | none | "no quotas", only abuse limiting ([frankfurter.dev](https://frankfurter.dev/)) | 200 | **ok** | "Free for commercial use". Caching is encouraged. v2 has **VND, blended from 30 other central banks (not SBV)**. `api.frankfurter.app` now 301-redirects to `.dev`. |
| **ECB data API** | yes | none | — | 200 | **ok** | Free "irrespective of … commercial or non-commercial use". Credit "Source: ECB statistics." ([ECB policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html)) |
| **open.er-api.com** | yes | none | updates once a day. An abusive IP gets 429 for about 20 min ([docs](https://www.exchangerate-api.com/docs/free)) | 200 | **ok with a link** | Commercial use is OK and caching is OK. **An attribution link is required**, which the current tool does not show (§2.17). Redistribution is not allowed. |
| **FRED** `api.stlouisfed.org` | free key (account, no card seen) | yes | ~120/min (third-party figure) | 400 "api_key is not set". `fredgraph.csv` timed out | ok for FRED-owned series; grey for third-party series | Needs the notice "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis" ([terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)). Third-party series need the owner's permission beyond personal use. |
| **World Bank** `api.worldbank.org/v2` | yes | none | — | 200 | **ok** | CC BY 4.0, commercial use OK ([licences](https://datacatalog.worldbank.org/public-licenses)). |
| **IMF datamapper** | yes | none | — | **403 (Akamai) with the honest UA** | ? | Not retried with a browser UA. Unverified. |
| **NSO (formerly GSO) PX-Web** `pxweb.nso.gov.vn/api/v1/vi/` | yes | none | — | 200. The old `pxweb.gso.gov.vn` doesn't resolve | ok with citation (assumed) | Standard PX-Web API: GET to browse, POST to query. The licence wasn't verified in writing. |
| **SBV** (central rate, policy rates) | — | — | — | homepage 200, HTML only | — | **No official API.** The central rate isn't in the static HTML. |
| **SSI** (FastConnect or iBoard) | — | — | — | — | **excluded** | vnstock's header table still carries iBoard's Referer and Origin. Never copy them. |

**Short version:**
- **Usable for commercial display without a lawyer:**
  - SEC EDGAR (with the owner's contact in the UA)
  - World Bank, ECB, Frankfurter
  - open.er-api (with a link) and CoinGecko (with attribution)
  - FRED, for FRED-owned series and with the notice
  - NSO
- **Every commercial "free key" market-data API in the owner's list forbids display to third parties.** That covers Finnhub, Tiingo, Twelve Data, Massive, Alpaca, FMP and EODHD.
- **Everything that gives Vietnamese prices is grey:** VNDirect, KBS, Vietcap, Yahoo. They are unlicensed internal or unofficial endpoints.

---

## 2. Corrections to the owner's plan

1. **"VN = vnstock (KBS/VCI/TCBS/MSN/FMarket)": TCBS is dead and MSN is unusable.**
   - `apipubaws.tcbs.com.vn` answers `{"status":404,"message":"Service not found"}`, and vnstock 4.0.9 has no TCBS explorer.
   - MSN needs a key scraped from Microsoft's own client config.
   - Add **VNDirect** in their place. It is the only one that returns raw and adjusted prices side by side, and it covers UPCoM.

2. **vnstock's source is no longer on GitHub.** Since 2026-11-07, `thinh-vu/vnstock` main holds only the README and LICENSE: "Gen 5" moved to a Rust core shipped as prebuilt wheels, and Gen 6 is current. The last readable source is tag `v4.0.9` (2026-09-06). Endpoint knowledge here comes from that tag.

3. **VCI is mostly GET now, except prices.**
   - Statements, ratios, events, news and listings moved to REST GET on `iq.vietcap.com.vn/api/iq-insight-service/v1|v2/...`.
   - OHLC (`trading.vietcap.com.vn/api/chart/OHLCChart/gap-chart`), ticks (`market-watch/LEData/getAll`) and the price board (`price/symbols/getList`) are **POST**.
   - The GraphQL URL (`trading.vietcap.com.vn/data-mt/graphql`) is still in the constants but isn't used for statements.
   - `mt.vietcap.com.vn` is commented out and didn't answer.

4. **The "yfinance .VN fallback" is narrower than it looks.**
   - Yahoo has **HOSE only**. HNX and UPCoM stocks are "Not Found", and so are `^VN30.VN` and `^HNX.VN`.
   - Yahoo's `close` for `.VN` is **already adjusted for bonus shares**. It recorded FPT's 10% bonus issue as split `11:10` on 2026-09-21 and divided earlier closes by 1.1, so it is not a raw-price fallback.
   - **Bug in the shipping tool:** `library.js` `TICKERS` maps `vn30 → ^VN30.VN` and `hnx → ^HNX.VN`, and both return "no quote". `tickerFor(…,'vn')` also sends every three-letter code to `.VN`, so any HNX or UPCoM ticker fails.

5. **Finnhub can't be the "global realtime" layer.** Its free plan is personal use only with no redistribution, and `/stock/candle` is not free (403). Only `/quote`, profile, news and basic metrics are free.

6. **Tiingo's limits are correct (50/h, 1,000/day, 500 symbols/month) but the licence rules it out.** It is internal use only, and "may not display or share".

7. **Twelve Data:** 800/day and 8/min are correct, and `income_statement` does cost 100 credits. But Basic is *non-display*, and one statement call costs more than a whole minute's budget. Drop it.

8. **Polygon is now Massive** (2025-10-30). Basic is 5/min, 2 years, end-of-day only, as claimed, but it is **for individual, non-business use only**. Drop it.

9. **EODHD 20/day, Alpha Vantage 25/day, FMP 250/day are all correct.** FMP also caps bandwidth at 500 MB per 30 days, and needs a display licence. None is worth building on.

10. **Stooq is worse than "apikey via captcha".** From this machine even the CSV path returns a JavaScript browser challenge. Drop it.

11. **Alpaca:** IEX only and 200 historical calls/min are correct, but redistribution is prohibited. Drop it.

12. **Binance has a hosting problem as well as a licence problem.**
    - Vercel's default region is US. Binance.com returns **451 to US and datacenter IPs**.
    - `data-api.binance.vision` (market data only) answered here. It *may* work from iad1, but that is unverified.
    - Commercial apps that profit from Binance data need written consent.
    - So keep CoinGecko as the primary crypto source, and Yahoo `BTC-USD` as the keyless fallback.

13. **CoinGecko changed.**
    - The free Demo key is now **100/min and 10k credits/month, with no card** (it was 30/min).
    - Attribution ("Powered by CoinGecko") is **mandatory**.
    - Keyless calls are rate-limited by IP and shared with every other tenant on the Vercel IP, so get the Demo key.

14. **SEC: the 10 req/s figure is correct.** But:
    - The User-Agent rule is enforced on `www.sec.gov`: `company_tickers.json` returned **403** to a generic UA, while `data.sec.gov` answered 200.
    - The owner must configure `SEC_USER_AGENT="Synapsez <real contact email>"`.
    - Cache `company_tickers.json` for a day.
    - The bulk `companyfacts.zip` (nightly) exists but is far too big for a 300 s function. Use per-CIK calls.

15. **Yahoo v10 needs the A3 cookie plus a crumb** (flow in §3.1). Without them, v10 and options return 401 "Invalid Crumb", and v7 quote returns 401 "User is unable to access this feature".
    - `fundamentals-timeseries` and `v8 chart` need **neither**.
    - The `incomeStatementHistory` modules are thinned out (FPT.VN `costOfRevenue: 0`, `grossProfit: 0`). Use timeseries for Yahoo statements.

16. **The "EOD forever" cache rule is wrong for VN.** Every adjusted VN series is rewritten on each ex-date: FPT's pre-2026-09-21 adjusted closes all changed by ÷1.1. Instead:
    - Cache **raw** bars forever, plus the corporate-action events.
    - Compute the adjustment on read.
    - Or re-fetch the adjusted series when an event's ex-date is newer than the cached copy.

    The US is similar: Yahoo's `close` is split-adjusted. "Forever" is only true for raw bars.

17. **FX:**
    - Frankfurter v2 now covers VND (blended, not SBV) with daily history, keyless and free for commercial use. It is a better keyless VND history source than open.er-api.
    - open.er-api requires an attribution **link** on the page showing the rate. The current `convert_units`/`world_facts` text names it but doesn't link it, which is a small compliance gap.
    - CoinGecko attribution is also missing from `cryptoQuotes`.

18. **vnstock's licence does not stop us calling the same endpoints ourselves.** Details in §6.
    - License-2026.11 was published 2026-10-24 and takes effect 2026-11-30.
    - It says writing your own tool *without vnstock code* is not reverse engineering, and it grants no rights to the sources' data.
    - What we must not do is copy vnstock code. That includes its large field-mapping tables, `kbs_mappings.py` (55 KB) and the `RATIO_COLUMN_MAP_*` dictionaries: "All rights reserved", and the 2026.09 text explicitly reserved "schema, taxonomy, mapping and normalization logic".
    - Take labels from the sources' own metadata instead. VCI's `/financial-statement/metrics` returns `titleVi`/`titleEn` for every field code, and KBS returns item names.

19. **Don't copy vnstock's request headers.** vnstock 4.x spoofs the browser `Referer`/`Origin` of each broker's site, randomises browser User-Agents ("2026-10-06: user_agent defaults to a browser string") and ships block-detection and circuit-breaker logic. That is evidence the sources do block automated clients.
    - Every GET in this report worked **with an honest UA and no Referer**. Keep it that way.
    - If a source starts refusing honest requests, treat that as a "no", not as a puzzle to get around.

20. **"Global history = yfinance + Tiingo + Stooq":** Tiingo and Stooq are gone, so global history is Yahoo alone, plus SEC for US fundamentals. Be honest in the product that non-US global data has a single unofficial source.

---

## 3. Endpoint reference and recommended chains

### 3.1 Yahoo (US, global, HOSE only)

**Chart** (quote, history, intraday, events). No auth.
```
GET https://query1.finance.yahoo.com/v8/finance/chart/{SYM}
    ?range=1d|5d|1mo|6mo|1y|5y|max&interval=1m|5m|15m|1h|1d|1wk|1mo
    [&period1=unix&period2=unix][&events=div,split][&includePrePost=true]
```
- Response: `chart.result[0]` has `.meta` (regularMarketPrice, currency, exchangeTimezoneName, instrumentType, chartPreviousClose), `.timestamp[]`, `.indicators.quote[0].{open,high,low,close,volume}[]`, `.indicators.adjclose[0].adjclose[]` and `.events.{dividends,splits}`.
- An error looks like `chart.error.code = "Not Found"`.
- Yahoo's own header is `cache-control: max-age=10`.
- 1-minute bars only cover the last ~7 days, and intraday bars ~60 days. These are commonly reported figures, not verified here.

**Crumb flow** (needed for v10, v7 quote, v7 options):
1. `GET https://fc.yahoo.com/` returns 404, **but sets the HttpOnly `A3` cookie on `.yahoo.com`**. Keep it.
2. `GET https://query2.finance.yahoo.com/v1/test/getcrumb`, sending that cookie, returns an ~11-character plain-text crumb. If the body is "Too Many Requests", it is not a crumb.
3. Add `&crumb=` and the cookie to:
   - `https://query2.finance.yahoo.com/v10/finance/quoteSummary/{SYM}?modules=price,summaryDetail,defaultKeyStatistics,financialData,calendarEvents,assetProfile,recommendationTrend,earnings,topHoldings,fundProfile`
   - `https://query2.finance.yahoo.com/v7/finance/options/{SYM}[?date=unix]`
   - `https://query1.finance.yahoo.com/v7/finance/quote?symbols=A,B,C`
4. Cache the cookie and crumb in Postgres for a few hours. Every cold start would otherwise pay two extra calls.

**Statements**, no crumb:
```
GET https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/{SYM}
    ?type=annualTotalRevenue,quarterlyNetIncome,...&period1=..&period2=..
```
Response: `timeseries.result[]`, one per type, each with `[{asOfDate, periodType, currencyCode, reportedValue{raw}}]`.

**Search and news**, no crumb: `GET https://query2.finance.yahoo.com/v1/finance/search?q=..&quotesCount=5&newsCount=5` returns `quotes[]` (symbol, exchange, quoteType) and `news[]` (title, publisher, link, providerPublishTime). Show headlines and links only.

**Symbol conventions:**
- `.VN` = HOSE only. `^VNINDEX.VN` works; `^VN30.VN` and `^HNX.VN` do not.
- `GC=F`, `CL=F`, `BZ=F`, `SI=F` = futures.
- `EURUSD=X` = FX.
- `BTC-USD` = crypto.
- Exchange suffixes: `.L`, `.T`, `.HK`, `.DE`, etc.

### 3.2 Vietnam stocks

Units, read off the probes:
- VNDirect prices are in **thousand VND** (50.9 = 50,900 ₫).
- KBS, VCI and Yahoo prices are in **VND**.
- Volumes are in shares.

| Data | Primary (GET) | Fallback (GET) | Response shape and notes |
|---|---|---|---|
| Latest quote + reference/ceiling/floor | VNDirect `https://api-finfo.vndirect.com.vn/v4/stock_prices?sort=date&q=code:FPT&size=1&page=1` | KBS `…/iis-server/investment/stocks/FPT/data_day?sdate=dd-mm-yyyy&edate=dd-mm-yyyy` (last row); then Yahoo chart meta (HOSE only) | VNDirect `data[]` fields: `date, time, floor (exchange), basicPrice (reference), ceilingPrice, floorPrice, open…close, average, adOpen…adClose, nmVolume, nmValue, ptVolume, ptValue, change, pctChange`. Intraday freshness **unknown**: 14:46 and 15:11 rows were seen after the close. Label it "delayed". |
| Daily history, raw | VNDirect `stock_prices?sort=date&q=code:FPT~date:gte:2026-01-01~date:lte:2026-11-10&size=500&page=1` | none raw. KBS, dchart and Yahoo are all adjusted | Back to 2013-01-02 for FPT. |
| Daily history, adjusted | VNDirect `adClose` etc. (same call) | `https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=FPT&from=unix&to=unix` (TradingView UDF `{t[],o[],h[],l[],c[],v[],s}`, thousand VND). KBS `data_day` (VND, `[{t,o,h,l,c,v,va}]`). Yahoo (HOSE). | **Volume is not adjusted** in any of them. The adjustment factors differ slightly: FPT 2026-09-17 was VND 67.546 vs KBS 67,564. |
| Intraday bars | KBS `…/stocks/{SYM}/data_{1P,5P,15P,30P,60P}?sdate&edate`; indices at `…/index/{IDX}/data_*` | dchart `resolution=1,5,15,30,60`; Yahoo `interval=5m` (HOSE) | **KBS's latest row may have string numbers** (`"o":"1719.23"`) and no `va`. Coerce types. |
| Ticks (matched trades) | KBS `…/trade/history/{SYM}?page=1&limit=N` → `data[{t, TD, SB, FT, LC (B/S), FMP (price), FCV, FV (vol), AVO, AVA}]` | VCI `market-watch/LEData/getAll` is POST | — |
| Index levels | KBS `…/index/VNINDEX/data_day` (also VN30, HNXIndex, HNXUpcomIndex, per VCI's index-name map) | Yahoo `^VNINDEX.VN`; dchart `symbol=VNINDEX` | Points, not VND. |
| Statements | VCI `https://iq.vietcap.com.vn/api/iq-insight-service/v1/company/{SYM}/financial-statement?section=BALANCE_SHEET\|INCOME_STATEMENT\|CASH_FLOW` → `data.{years[], quarters[]}` with field codes `isa1…`, `bsa…`, `cfa…`, `yearReport`, `lengthReport`, `publicDate`, **raw VND**. Labels from `…/financial-statement/metrics` (`field`, `titleVi`, `titleEn`, `level`, `parent`). | KBS `…/iis-server/investment/stock/finance-info/{SYM}?page=1&pageSize=4&type=CDKT\|KQKD\|LCTT\|CSTC&unit=1000&termtype=1\|2&languageid=1` (LCTT uses `code=` and `termType=`). VNDirect `v4/financial_statements?q=code:FPT~reportType:QUARTER~modelType:{n}` (`itemCode` / `numericValue`; the meaning of `modelType` is unverified). | KBS: `unit=1000` = **thousand VND**. Its reply carries `Audit` (KT = audited, SX = reviewed, CKT = unaudited) and `Unit` (HN = consolidated) code lists. VCI's FPT 2025 net sales `isa3 = 70,112,825,100,710` ₫ matches Yahoo's 70.11T. |
| Ratios | VCI `…/company/{SYM}/statistics-financial` → per-quarter TTM `pe, pb, ps, roe, roa, evToEbitda, marketCap, dividendYield, npl, car, casaRatio…` | VNDirect `v4/ratios/latest?filter=itemCode:51003,…&where=code:FPT` (51003 = market cap, 9.617e13); KBS `type=CSTC` | Banks use a different field set (npl, car, casa). |
| Profile | VCI `…/v1/company/details?ticker=FPT` (shares, market cap, foreign %, foreign limit, sector; also Vietcap rating and target, which are **not data**) | KBS `…/stockinfo/profile/{SYM}?l=1` (codes SM, SB, FD, CC, LD, FV = par value, EX…) | VCI `…/{SYM}/shareholder-structure`, `/shareholder`, `/relationship` also exist (GET, not probed). |
| Corporate actions | VCI `…/v1/events?ticker=FPT&fromDate=yyyymmdd&toDate=yyyymmdd&eventCode=DIV,ISS,…&page=0&size=50` → `eventCode, eventTitleVi/En, exrightDate, recordDate, listingDate, exerciseRatio, category`. Probed: FPT "Bonus Issue ratio 10.0%", ex-date 2026-09-21. | Yahoo `events=div,split` (HOSE); KBS `…/stockinfo/event/{SYM}?l=1&p=1&s=N` (empty for FPT) | Full code list: `DIV, ISS, DDIND, DDINS, DDRP, AGME, AGMR, EGME, AIS, MA, MOVE, NLIS, OTHE, RETU, SUSP`. |
| News and disclosures | VCI `…/v1/news?ticker=FPT&fromDate&toDate&languageId=1&page=0&size=N` (titles; 200) | KBS `…/stockinfo/news/{SYM}`; Yahoo search news | Show title, date and link only. |
| Listings and search | VCI `https://trading.vietcap.com.vn/api/price/symbols/getByGroup?group=VN30\|HOSE\|HNX\|UPCOM\|ETF\|CW\|FU_INDEX` → `[{symbol}]`; `…/iq-insight-service/v2/company/search-bar?language=1` (148 KB, cache 1 day) | KBS `…/stock/search/data`, `…/index/{group}/stocks`, `…/sector/all` | — |
| Funds (open-ended) | FMarket `GET https://api.fmarket.vn/res/products/{id}` (NAV, fees, holdings; 100 KB) | — | List and NAV history are POST. `id` comes from the POST list, so a GET-only build needs a hand-kept id map. |

**HNX and UPCoM coverage:** verified for KBS (SHS) and VNDirect (ACV, UPCoM). Yahoo has neither.

### 3.3 United States

| Data | Primary | Fallback | Notes |
|---|---|---|---|
| Quote | Yahoo v8 chart meta | Yahoo v7 quote (crumb) | Label it "may be delayed". |
| History, daily or intraday | Yahoo v8 chart | none free and displayable | `close` is split-adjusted; `adjclose` also adjusts for dividends. |
| Statements | SEC `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`; per concept: `/api/xbrl/companyconcept/CIK…/us-gaap/{Tag}.json` | Yahoo fundamentals-timeseries | Ticker→CIK from `https://www.sec.gov/files/company_tickers.json`, needs the UA, cache 1 day. Facts carry `units.USD[{start,end,val,fy,fp,form,filed,frame}]`. Watch for duplicate facts across 10-K and 10-Q filings: use `frame` or the latest `filed`. |
| Cross-section ("which companies…") | SEC frames `https://data.sec.gov/api/xbrl/frames/us-gaap/{Tag}/USD/CY2025Q2I.json` (period formats CY2019, CY2019Q1, CY2019Q1I) | — | ~94 KB per call. Usable for a light "screen" of US companies on one XBRL fact. |
| Filings | SEC `https://data.sec.gov/submissions/CIK##########.json` → `filings.recent.{form[],filingDate[],accessionNumber[],primaryDocument[]}` | — | 8-K means events. |
| Ratios | Computed from SEC facts + Yahoo price | Yahoo quoteSummary `defaultKeyStatistics`, `financialData` (crumb) | — |
| Dividends and splits | Yahoo `events=div,split` | SEC 8-K | — |
| Options | Yahoo v7 options (crumb) | none | — |
| ETF holdings | Yahoo quoteSummary `topHoldings`, `fundProfile` (crumb) | — | — |
| News | Yahoo search news | — | — |

### 3.4 Global equities and indices

Yahoo only (suffixes and `^` indices). No free, displayable fallback exists. Say so in the tool's output when Yahoo fails.

### 3.5 FX

| Pair | Primary | Fallbacks | Notes |
|---|---|---|---|
| Major pairs | Frankfurter v2 `https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,JPY[&date=YYYY-MM-DD][&from=..&to=..]` → `[{date,base,quote,rate}]` | ECB SDMX `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata`; then open.er-api `https://open.er-api.com/v6/latest/USD` (daily, link required); then Yahoo `EURUSD=X` | — |
| VND, bank rates | Vietcombank `https://www.vietcombank.com.vn/api/exchangerates?date=YYYY-MM-DD` → `{Date, UpdatedDate, Data[{currencyCode, cash, transfer, sell}]}` | — | Strings like "25350.00". Cache ≥5 min. |
| VND, reference | Frankfurter v2 `USD/VND` (blended) | open.er-api | Label it a "reference mid-rate, not a bank quote". |
| SBV central rate | none | — | No API. Leave it out. |

### 3.6 Crypto

| Primary | Fallback 1 | Fallback 2 |
|---|---|---|
| CoinGecko `https://api.coingecko.com/api/v3/simple/price?ids=..&vs_currencies=usd,vnd&include_24hr_change=true`, `/coins/{id}/market_chart?vs_currency=usd&days=N`, `/search?query=`. Send a Demo key as header `x-cg-demo-api-key` when the owner sets one. | Yahoo `BTC-USD` | Binance `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT` and `/klines?symbol=BTCUSDT&interval=1d&limit=N`: **only if it answers from iad1 and the owner accepts the ToS risk**. |

### 3.7 Commodities

- **World:** Yahoo futures (`GC=F`, `SI=F`, `CL=F`, `BZ=F`, `NG=F`, `HG=F`).
- **VN gold:** SJC GET `PriceService.ashx` → `{success, latestDate, data[{TypeName, BranchName, BuyValue, SellValue}]}` in VND per tael (lượng). Label it "VND/lượng (37.5 g)". Historical needs POST.
- **No free VN petrol-price API was found.** It wasn't researched.

### 3.8 Macro

| Market | Primary | Fallback | Notes |
|---|---|---|---|
| VN | World Bank `https://api.worldbank.org/v2/country/VN/indicator/{code}?format=json&mrv=N` (GDP growth `NY.GDP.MKTP.KD.ZG`, CPI `FP.CPI.TOTL.ZG`, …; annual, CC BY 4.0) | NSO PX-Web `https://pxweb.nso.gov.vn/api/v1/vi/{db}/…` (monthly and quarterly; GET to browse, POST to query) | IMF datamapper refused the honest UA. |
| US and global | FRED `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=…&file_type=json` (key needed) | World Bank; ECB SDMX for euro-area series | — |

### 3.9 Keyless-first, and what a free key lights up

**Works with no keys** (once each URL has been probed from iad1):
- Yahoo (US, global, HOSE)
- VNDirect, KBS, VCI GETs (VN)
- SEC (needs only the UA contact)
- Frankfurter, ECB, open.er-api, Vietcombank, SJC
- CoinGecko keyless
- World Bank, NSO

**Lights up with a free key or config, no card:**
- `COINGECKO_DEMO_KEY`: 100/min instead of shared-IP throttling. Recommended.
- `FRED_API_KEY`: US macro.
- `SEC_USER_AGENT`: required for `www.sec.gov`; recommended for data.sec.gov.

**Don't wire up even if a key is added:** Finnhub, Tiingo, Twelve Data, Massive, Alpaca, FMP, EODHD, Alpha Vantage. Their free licences forbid display to the app's users; a paid display licence would be a separate decision. Wiring them "for later" invites someone to turn one on.

**Server-IP probe list (rule 3).** Probe these from a deployed function in iad1 before building. If iad1 is blocked, try a function pinned to `sin1` (Singapore) as a check:

```
https://api-finfo.vndirect.com.vn/v4/stock_prices?sort=date&q=code:FPT&size=1&page=1
https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=FPT&from=1794000000&to=1794300000
https://kbbuddywts.kbsec.com.vn/iis-server/investment/stocks/FPT/data_day?sdate=03-11-2026&edate=10-11-2026
https://iq.vietcap.com.vn/api/iq-insight-service/v1/company/FPT/financial-statement?section=INCOME_STATEMENT
https://trading.vietcap.com.vn/api/price/symbols/getByGroup?group=VN30
https://www.vietcombank.com.vn/api/exchangerates?date=2026-11-10
https://sjc.com.vn/GoldPrice/Services/PriceService.ashx
https://api.fmarket.vn/res/products/23
https://query1.finance.yahoo.com/v8/finance/chart/FPT.VN?range=5d&interval=1d
https://fc.yahoo.com/  then  https://query2.finance.yahoo.com/v1/test/getcrumb
https://data.sec.gov/submissions/CIK0000320193.json   (with the owner's UA)
https://www.sec.gov/files/company_tickers.json        (with the owner's UA)
https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT
https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT   (expect 451)
https://api.coingecko.com/api/v3/ping
https://api.frankfurter.dev/v2/rate/USD/VND
https://api.worldbank.org/v2/country/VN/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrv=1
https://pxweb.nso.gov.vn/api/v1/vi/
```

Moving the whole app to `sin1` changes latency to the Supabase database and the LLM providers, so it is a separate decision.

---

## 4. Rate-limit numbers to encode

Convention below: ceilings at about 90–95% of the published figure, as `freeTier.js` already does.

| Service | Published | Ceiling to encode | Period | Notes |
|---|---|---|---|---|
| CoinGecko Demo | 100/min, 10,000 credits/month | 9,500/month, 90/min | month (+ minute) | Keyless: no figure. Self-impose ~10/min and rely on cache. |
| CoinGecko attribution | — | — | — | Show "Powered by CoinGecko" wherever its numbers appear. |
| SEC EDGAR | 10 req/s | 5/s per instance | second | Can't be pooled across instances. Cache hard. |
| FRED | ~120/min (third-party) | 100/min | minute | — |
| Binance (if used) | 6,000 weight/min per IP; price and 24h ticker = 2; klines ≈ 2 | 3,000 weight/min | minute | Read the `x-mbx-used-weight-1m` header. On 429, honour `Retry-After`; 418 is a ban. |
| open.er-api | 1 update/day; 429 for about 20 min if abusive | 1 call per base per hour, cached 24 h | — | Cached, this never needs metering. |
| Frankfurter | no quotas, abuse limiting | cache 1 h for latest, forever for past dates | — | — |
| Vietcombank XML/JSON | "Only one request every 5 minutes!" | 1 per 5 min, global | 5 min | Enforce by cache TTL = 5 min, shared through Postgres. |
| SJC | unknown (Cloudflare) | 1 per 5 min, global | — | Enforce by cache. |
| Yahoo | not published; IP throttling | Self-imposed: ≤2 req/s per instance, ~5,000/day pooled; crumb ≤ 1 per 6 h | day | On 429, stand aside for 15 min via `exhaust`-style marking. |
| VNDirect / KBS / VCI | not published | Self-imposed per host: ≤1 req/s, ~3,000/day pooled; no bulk crawling | day | On 403/429, stand aside for an hour; on repeated refusals, disable the source by env switch. |
| World Bank / ECB / NSO | none published | cache 1 day | — | — |
| Tiingo / Twelve Data / Massive / EODHD / AV / FMP / Finnhub / Alpaca | (§1) | **not encoded** | — | Licence: no. |

**Gap in `freeTier.js`.** `periodOf` only knows `'month'` and `'day'`, but per-minute and per-second limits are what matter for CoinGecko, FRED, SEC and Binance. Two ways to close it:
- Add `'minute'` (and optionally `'hour'`) buckets to `periodOf`, using the same `addToCounter` with an `ends` a minute out. This costs one Postgres upsert per call, which is acceptable for rare calls.
- Or rely on the cache, plus a small per-instance token bucket for the per-second rules. SEC is the one that matters there.

Rule (2) says metered calls go through `freeTier.js`. CoinGecko Demo is the only *metered* one here. The keyless sources aren't billed, but adding them as polite pooled caps fits the rule's spirit, and gives the admin page a row per source.

**Cache TTLs** (Postgres, key = `source|kind|symbol|params`):

| Data | TTL |
|---|---|
| Quote during the session | 30–60 s (VN), 15–30 s (US) |
| Quote outside the session | until the next session open (VN: 09:00 ICT) |
| Intraday bars | 1–5 min |
| Raw daily bar for a closed day | permanent |
| **Adjusted** history | until the next corporate-action ex-date (store `adjusted_as_of`), or recompute from raw + events |
| Statements, VN | 1 day; reports land within weeks of quarter end and get restated |
| Statements, SEC | 1 day |
| Ratios (TTM) | 1 day |
| Events | 6–12 h |
| News | 10 min |
| FX | Vietcombank 5 min; Frankfurter and open.er-api 1 h; past dates permanent |
| SJC gold | 5–10 min |
| Macro | 1 day |
| Listings, search tables, SEC ticker map | 1 day |
| Yahoo crumb + cookie | ~6 h |
| CoinGecko | ≤ 24 h, by their terms (6.1) |

Keep payloads compact. Store only the fields the tool returns: the Supabase free tier has 500 MB.

---

## 5. VN-specific facts a tool's output must label correctly

**Units and currency**
- VND per share.
- **VNDirect prices are in thousand VND**: multiply by 1,000, or say "nghìn đồng".
- KBS, VCI and Yahoo prices are in VND.
- Index values are points.
- Volumes are shares; value (`va`, `nmValue`) is VND.
- Par value is 10,000 ₫. **Dividends are announced as a % of par**, so a "20% cash dividend" = 2,000 ₫ per share.

**Raw vs adjusted prices**
- Every source except VNDirect's raw columns is adjusted. Say which one the user is seeing.
- VNDirect `stock_prices`: `open…close` = raw, `adOpen…adClose` = adjusted.
- KBS `data_day` and dchart: adjusted.
- Yahoo `.VN` `close`: bonus/split-adjusted. `adjclose` may also strip dividends.
- **Volumes are never adjusted.** A series that adjusts prices for a 10% bonus but not volumes makes turnover look wrong before the ex-date.
- Factors differ slightly between sources. Don't mix sources inside one series.

**Ex-right reference price**, the standard form:

  `P_ref = (P_close − D_cash + Σ Pr_i × R_i) / (1 + Σ R_i + Σ S_j)`

  - `D_cash` = cash dividend per share.
  - `R_i` = rights per share at subscription price `Pr_i`.
  - `S_j` = bonus or stock-dividend shares per share.

  Example: a 10% bonus divides by 1.1. VNDirect shows FPT's reference on 2026-09-21 as 65.2, which is 71.7 ÷ 1.1.

  The exchange rounds this to the tick and publishes it. **Read the published `basicPrice` rather than computing it** wherever possible.

**Reference price and change %**
- HOSE and HNX: the reference is the previous close.
- **UPCoM: the reference is the previous day's weighted average of matched prices**, not the close. Compute change % against `basicPrice`, never against the previous bar's close. ACV on 2026-11-10: reference 39.2, previous-day average 39.5.

**Price bands (biên độ)** ([DSC](https://www.dsc.com.vn/kien-thuc/bien-do-giao-dich-san-chung-khoan-hose-hnx-upcom))
- Normal: HOSE ±7%, HNX ±10%, UPCoM ±15%.
- First trading day, or return after ≥25 sessions without trading: ±20% / ±30% / ±40%.
- Ceiling is rounded **down** to the tick and floor **up**. Checked against VNDirect: ref 65.2 → ceiling 69.7, floor 60.7; UPCoM ref 39.2 → 45.0 / 33.4.
- Prefer the source's `ceilingPrice`/`floorPrice` over computing them.

**Tick sizes (bước giá)**
- HOSE stocks and closed-end funds: <10,000 ₫ → 10 ₫; 10,000–49,950 → 50 ₫; ≥50,000 → 100 ₫.
- HOSE ETFs and covered warrants: 10 ₫.
- HNX and UPCoM stocks: 100 ₫. Commonly cited, but not confirmed against a current exchange document; label as such.

**Lots**
- Round lot 100 shares on all three boards.
- Odd lots of 1–99 shares trade in the continuous sessions.

**Sessions**, Mon–Fri, Asia/Ho_Chi_Minh (UTC+7, no DST). As stated by DSC, "as of September 2026" ([DSC](https://www.dsc.com.vn/kien-thuc/gio-giao-dich-chung-khoan-viet-nam)):

| Board | Opening auction | Continuous | Break | Continuous | Closing auction | After |
|---|---|---|---|---|---|---|
| HOSE | **ATO 09:00–09:15** | 09:15–11:30 | 11:30–13:00 | 13:00–14:30 | **ATC 14:30–14:45** | put-through 14:45–15:00 |
| HNX | none | 09:00–11:30 | 11:30–13:00 | 13:00–14:30 | ATC 14:30–14:45 | **PLO** (post-close at the closing price) 14:45–15:00 |
| UPCoM | none | 09:00–11:30 | 11:30–13:00 | **13:00–15:00** | none | — |
| VN30 futures | ATO 08:45–09:00 | 09:00–11:30 | 11:30–13:00 | 13:00–14:30 | ATC 14:30–14:45 | — |

- Under the KRX system (live since 5 May 2025), ATO and ATC orders no longer have priority over limit orders.
- A price shown between 09:00 and 09:15 on HOSE is an **indicative auction price**, not a trade. Label it.
- Yahoo reports the zone as `Asia/Bangkok` (same offset). KBS daily bars carry a `07:00` time: treat it as a date only.

**Settlement**
- T+2. Bought shares arrive in the afternoon of T+2, which brokers call "T+2.5".
- **Intraday T+0 trading is not live** as of 2026-11. A central counterparty is planned for 2027, per reports; unverified.
- Foreign investors: VCI `details` exposes `foreignerPercentage` and `maximumForeignPercentage` (foreign limit). Label "foreign room".

**Statements**
- Templates differ by company type: corporates (Circular 200), banks (SBV templates), securities firms (Circular 334/2016), insurers (Circular 232/2012).
- VCI's `comTypeCode` tells you which: CT corporate, NH bank, CK securities, BH insurance. The field sets differ, and a bank has no "gross profit".
- Label every figure with:
  - the **unit**: VCI raw VND; KBS thousand VND because we ask for `unit=1000`;
  - the **period**: year or quarter (VCI `yearReport`, `lengthReport`);
  - **consolidated vs parent** (KBS HN = consolidated);
  - the **audit status** (KBS KT / SX / CKT);
  - the **publish date**.
- Q4 self-reported numbers often differ from the audited annual report.

**Index names**
- The VCI/KBS index codes are `VNINDEX, VN30, HNXIndex, HNX30, HNXUpcomIndex, VN100, VNMIDCAP, VNSMALLCAP, VNALLSHARE, VNDIAMOND…`
- Yahoo has `^VNINDEX.VN` only.

---

## 6. Legal and licence risks, and a recommendation

1. **There is no free, licensed source of Vietnamese exchange prices for display in a commercial app.**
   - HOSE and HNX sell market data feeds through information vendors, for "internal usage and/or redistribution".
   - The broker endpoints (VNDirect, KBS, Vietcap) are undocumented internal APIs built for their own web apps. Their terms were not found, but the industry pattern is "no copying, transfer, display or distribution without written consent". DSC's terms say this verbatim ([DSC terms](https://dsc.com.vn/en/dieu-khoan-chung)).
   - Calling them is unlicensed use of data the broker itself receives under an exchange contract.
   - Realistic risks:
     - IP blocking, the most likely;
     - a takedown or cease-and-desist letter;
     - a contract or unfair-competition claim, the least likely for low-volume on-demand use.
   - Paid top-ups make the product clearly commercial.

2. **Yahoo** is the same kind of grey: unofficial endpoints, personal-use framing, "don't redistribute". It is already in production, and the owner has implicitly accepted that risk. The same mitigations apply.

3. **vnstock's own licence** is not the obstacle.
   - License-2026.11 (effective 2026-11-30) excludes "your own tool written without Vnstock code" from its reverse-engineering ban. It grants and transfers no rights to source data, and tells users to check each source's terms themselves.
   - Its "separate written agreement" clause is about using **vnstock software** to run a data-access product. It doesn't bind us if we don't use vnstock.
   - **Don't copy its code, its mapping tables or its header-spoofing.** Copying those is the one thing it reserves ("All rights reserved"), and the spoofing would undermine the honest-client stance.
   - **Don't depend on the library at all.** vnstock's own 4.0.9 changelog admits earlier versions wrote downloaded instructions into users' AI-assistant rule files (AGENTS.md and Claude Code globals) on `import`. That is a reason to stay away regardless of Python.

4. **"Free key" commercial APIs are a trap for this product.** Finnhub, Tiingo, Twelve Data, Massive, Alpaca and FMP all restrict their free tier to personal, internal or non-display use. EODHD and Alpha Vantage are too small to matter. Using any of them would breach the terms the owner clicked through, which is worse than grey.

5. **Binance:** commercial use needs written consent, and US datacenter IPs get 451. Leave it out.

6. **Stay clear of advice.**
   - Under Vietnamese securities law, investment advice and securities-information services are licensed activities.
   - The tool must present data with "for reference, not investment advice", which the current tool already says.
   - Never relay Vietcap's analyst rating or target price as if it were data. It is Vietcap's copyrighted research: drop those fields.

**Recommendation**
- **Ship freely, with attribution:**
  - SEC (owner's UA)
  - Frankfurter, ECB, open.er-api (add the link)
  - CoinGecko (add "Powered by CoinGecko"; get the Demo key)
  - World Bank, FRED (with the notice; FRED-owned series), NSO
  - Vietcombank and SJC, citing the source. These are public price boards posted by the issuer.
- **Ship as grey, with mitigations:** Yahoo, VNDirect, KBS, Vietcap GETs. Mitigations:
  - On-demand calls only, per user question. No background crawling, no screener sweeps over the whole market.
  - Aggressive shared cache. Polite per-host ceilings (§4).
  - An honest UA, and no spoofed Referer or Origin.
  - An env kill-switch per source, e.g. `FIN_SOURCE_VNDIRECT=off`.
  - Label every answer "nguồn: VNDIRECT / KBS / Vietcap / Yahoo, có thể trễ, chỉ để tham khảo" ("source: …; may be delayed; for reference only").
  - Never offer bulk export (CSV or xlsx) of their raw series. That looks like redistribution.
  - Have the owner email VNDirect and KBS asking for written permission for low-volume display with attribution. A yes turns grey into ok; a no tells us where we stand.
- **Do not use:**
  - SSI (excluded)
  - MSN (scraped key), BTMC (someone else's key)
  - Stooq (captcha / JS gate)
  - Finnhub, Tiingo, Twelve Data, Massive, Alpaca, FMP, EODHD, Alpha Vantage (licence)
  - Binance (consent + 451)
- **Not free:** a properly licensed VN feed (a HOSE/HNX information vendor or a commercial VN data vendor). That is the long-term answer if finance becomes a headline feature. It is outside the free-only rule, so this is noted, not recommended.

---

## 7. What the tool design for the agent should look like

**Measured from the code**, with the token-budget skill's estimator: `JSON.length / 4` over name + description + parameters.
- `market_data` today ≈ **228 tokens**. `world_facts` ≈ 447. The median tool ≈ 136.
- The 126 tools total ≈ 24k. The skill says the deferred catalogue is ~6.9k per step on a 128k window.
- `market_data` is already in `DEFERRABLE`.

The owner's 12 tools: `get_quote, get_history, get_intraday, get_fundamentals, get_statements, get_ratios, get_corporate_actions, get_options_futures, get_fund_etf, get_news_events, get_macro_fx_gold, screen_universe`.
- Each would need its own symbol, market and period parameters plus a VN/US caveat. Realistically that is 150–300 tokens each, or **≈2,000–3,500 tokens**, re-sent on every step of every turn that loads them.
- Twelve near-identical tools also make the model's choice harder. It will mix up `get_fundamentals`, `get_ratios` and `get_statements`.

**Recommendation: one tool.** Evolve `market_data` (keep the name: evals and the `LIVE` regex in `stepOrder.js` already know it) into a single finance tool with a `kind` enum and the existing `requests[]` batching. Keep it in `DEFERRABLE`. Target about 450–600 tokens.

```
market_data
  requests[]   up to 6 of the objects below in one call (existing pattern)
  kind         quote | history | intraday | statements | ratios | profile | events | news | fund | options | fx | gold | macro
  symbols[]    up to 12 (quote); 1 for history/statements/...
  market       vn | us | global | crypto   (vn = HOSE/HNX/UPCoM; resolves the board itself)
  period       history: 1m..max or from/to; statements: year|quarter, limit
  interval     intraday: 1m|5m|15m|30m|1h
  statement    income | balance | cashflow
  adjusted     true (default) | false     history only
  vs           crypto/fx quote currency
```

- **Leave out `screen_universe` for now.** A useful screen needs bulk data for the whole market. That is exactly the crawling pattern that raises the ToS risk and burns the polite ceilings. The one honest free screen is SEC `frames` for US companies on a single XBRL fact. If wanted, add it later as `kind: "screen"` with `market: "us"` only.
- **Options:** US only, via the Yahoo crumb. **VN futures and covered warrants:** list them through VCI `getByGroup` (FU_INDEX, CW); history through KBS index/derivative where available. Defer anything POST-only.

**Return values matter more than the schema.** Tool results are re-sent on every remaining step.
- Return a compact table, not raw JSON:
  - history: ≤30 rows by default, with min, max, change and a note "N more rows; ask for `chart`";
  - statements: ≤4 periods × the ~15 headline lines, labelled from the source's own metadata in vi or en.
- Every answer carries a one-line header:
  - source;
  - as-of time in the exchange's timezone;
  - live / delayed / end-of-day / auction-indicative;
  - currency and unit (₫ vs thousand ₫ vs points);
  - adjusted vs raw;
  - for VN quotes, also the reference, ceiling and floor, and the session (ATO / continuous / break / ATC / closed).
- Attribution text goes in the result where a source requires it ("Powered by CoinGecko", the exchangerate-api link, the FRED notice), so the UI and the model both carry it.
- Errors per symbol in a batch must not fail the whole call (the existing pattern). Say which source failed, and that the fallback was used.

**Server shape, following the repo's layering.**
- Put a `server/finance/` module behind the tool, with one small adapter per source:
  - `yahoo.js`, `vndirect.js`, `kbs.js`, `vietcap.js`, `sec.js`, `coingecko.js`, `fx.js`, `macro.js`.
  - Each exports `{ quote, history, … }` returning one normalised shape.
- A `chain(kind, market)` table drives the fallbacks in §3. That makes the order a data change, not a code change, and gives each source its kill-switch.
- Cache and ceilings go through one helper, so no adapter calls `fetch` directly.
- Mixed types (KBS strings), units (thousand VND) and adjustment flags are normalised inside the adapter and tested with recorded fixtures. The fixtures already captured in the probes folder are a starting point.

---

### Sources consulted
- vnstock v4.0.9 source and licence, read from GitHub raw: `thinh-vu/vnstock@v4.0.9`. Main branch LICENSE.md and README. [Web licence 2026.11](https://vnstocks.com/onboard/giay-phep-su-dung).
- [Finnhub ToS](https://finnhub.io/terms-of-service), [Tiingo pricing](https://www.tiingo.com/about/pricing), [Twelve Data pricing](https://twelvedata.com/pricing), [Alpaca market data](https://docs.alpaca.markets/docs/about-market-data-api), [Alpaca redistribution](https://alpaca.markets/support/redistribute-alpaca-api), [Alpha Vantage support](https://www.alphavantage.co/support/).
- [SEC fair access](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data), [SEC APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
- [CoinGecko pricing](https://www.coingecko.com/en/api/pricing), [CoinGecko API terms](https://www.coingecko.com/en/api_terms), [CoinGecko rate limits](https://docs.coingecko.com/docs/common-errors-rate-limit).
- [Binance API general info](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information), [Binance data FAQ](https://www.binance.com/en-BH/support/faq/how-to-download-historical-market-data-on-binance-5810ae42176b4770b880ce1f14932262), [Vercel/Binance 451 thread](https://community.vercel.com/t/binance-api-calls-on-vercel/29895).
- [Frankfurter](https://frankfurter.dev/), [exchangerate-api free docs](https://www.exchangerate-api.com/docs/free), [ECB reuse policy](https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html), [World Bank licences](https://datacatalog.worldbank.org/public-licenses), [FRED API terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html), [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html).
- [pandas-datareader #1012 (Stooq key)](https://github.com/pydata/pandas-datareader/issues/1012), [Finnhub candle 403](https://github.com/finnhubio/Finnhub-API/issues/546), [yfinance rate limits](https://github.com/ranaroussi/yfinance/issues/2441).
- Massive/Polygon individual-use terms, via search results ([market data terms](https://massive.com/legal/market-data-terms-of-service); the site didn't resolve from here).
- [DSC trading hours 2026](https://www.dsc.com.vn/kien-thuc/gio-giao-dich-chung-khoan-viet-nam), [DSC price bands](https://www.dsc.com.vn/kien-thuc/bien-do-giao-dich-san-chung-khoan-hose-hnx-upcom), [HOSE market information service](https://en.vietstock.vn/2019/07/about-hoses-market-information-service-113-365572.htm).
