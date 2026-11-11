# Finance sources from a server address (rule 3) · 2026-11-10, run 2026-11-11

**Status: run, from iad1 and from sin1, on 2026-11-11 (06:27 and 06:29 UTC).**

`scripts/finance-probe.mjs` (`npm run finance:probe`) starts one Vercel Sandbox —
iad1 by default, the region the app's functions run in, or `--region sin1` — and
GETs every URL of `docs/research/2026-11-10-finance-sources.md` §3.9 from inside
it, printing status, time, size and the first characters of each answer. The
owner set the Sandbox credentials and `SEC_USER_AGENT` on 2026-11-11; both runs
used them. A third column below is the same URLs asked from a home connection in
Vietnam a minute later, to tell a refusal of the server's address apart from a
request the source rejects from anywhere.

## Results

| Source (URL) | iad1 | sin1 | Vietnam, home |
| --- | --- | --- | --- |
| VNDirect `api-finfo…/v4/stock_prices` | 200 · 1270 ms | 200 · 302 ms | — |
| VNDirect `dchart-api…/dchart/history` | 200 · 879 ms | 200 · 218 ms | — |
| KBS `kbbuddywts…/data_day` | 200 · 1370 ms | 200 · 359 ms | — |
| Vietcap `iq.vietcap…/financial-statement` | **400** · 4 bytes | 200 · 351 ms | 200 |
| Vietcap `trading.vietcap…/getByGroup?group=VN30` | **400** · 4 bytes | 200 · 635 ms | 200 |
| Vietcombank `/api/exchangerates` | 200 · 1383 ms | 200 · 158 ms | — |
| SJC `/GoldPrice/Services/PriceService.ashx` | **403** · Cloudflare page | **403** · "Just a moment…" | 200 |
| Fmarket `/res/products/23` | 200 · 1824 ms | 200 · 280 ms | — |
| Yahoo `query1…/v8/finance/chart/FPT.VN` | 200 · 98 ms | 200 · 42 ms | — |
| Yahoo crumb (`fc.yahoo.com` 404, then `query2…/getcrumb`) | 200, crumb of 11 characters, cookie set | same | — |
| SEC `data.sec.gov/submissions/CIK0000320193.json` | 200 · 36 ms | 200 · 87 ms | — |
| SEC `www.sec.gov/files/company_tickers.json` | 200 · 98 ms | 200 · 84 ms | — |
| CoinGecko `/api/v3/ping` | 200 · 77 ms | 200 · 276 ms | — |
| Frankfurter `/v2/rate/USD/VND` | 200 · 56 ms | 200 · 466 ms | — |
| World Bank `NY.GDP.MKTP.KD.ZG` | 200 · 44 ms | 200 · 1040 ms | — |
| NSO PxWeb `/api/v1/vi/` | 200 · 1108 ms | 200 · 257 ms | — |

The crumb's value and the cookie were never printed. The Yahoo `fc.yahoo.com` 404
is expected: it only sets the cookie the crumb request needs.

## What it means

- **Vietcap refuses US addresses** with a bare 400 and answers from Singapore and
  from Vietnam. The request is the same in all three, so this is the server's
  address, not the request. A 400 is not one of the answers that make the finance
  layer stand a source aside (403, 429 — `server/finance/http.js`), so from iad1
  every Vietcap call costs a round trip and fails before the chain moves on.
  Vietcap is the only source of Vietnamese financial statements and of the index
  constituent lists (VN30 …).
- **SJC is behind a Cloudflare challenge** that turns away datacenter addresses in
  both regions. The challenge is a bot check; the app does not try to pass it. A
  403 makes the layer leave SJC alone for 10 minutes, and gold for Vietnam then
  comes from Yahoo — the world price, not SJC's posted bar price.
- **Everything else answers from iad1**, SEC included now that `SEC_USER_AGENT`
  is set. The Vietnamese sources are 3–5 times faster from sin1.

## Recommended settings (the owner's to make, in Vercel)

1. `FIN_SOURCE_SJC=off` — it cannot answer a server, and the gold answer should
   say plainly that it is the world price.
2. `FIN_SOURCE_VIETCAP=off` while the app's functions run in iad1 — or keep it on
   and move the finance work to sin1 (below).
3. A decision, not a setting: Vietnamese financial statements need Vietcap, which
   needs a non-US address. Either go without them (1–2 above), or run the app (or
   only the finance tool) from sin1. Moving the whole app adds the distance to the
   database and the model providers to every request; a sin1 function for market
   data alone keeps that cost to finance calls.
