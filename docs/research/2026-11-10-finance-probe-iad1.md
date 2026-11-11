# Finance sources from a server address (rule 3) · 2026-11-10

**Status: not run. The probe is owed.**

`scripts/finance-probe.mjs` (`npm run finance:probe`) is written to start one
Vercel Sandbox — iad1 by default, the region the app's functions run in, or
`--region sin1` — and GET every URL of
`docs/research/2026-11-10-finance-sources.md` §3.9 from inside it, printing
status, time, size and the first 120 characters of each answer.

It could not start where the finance tools were built: that environment had no
Vercel Sandbox credentials (`VERCEL_TOKEN` + `VERCEL_TEAM_ID` +
`VERCEL_PROJECT_ID`, or a Vercel OIDC token), and the script reads only the
environment, never a `.env` file. It said so and exited 2:

```
No Vercel Sandbox credentials in the environment (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN).
The probe cannot start here, and no result has been made up. Run it where those are set.
```

No result has been invented, and nothing below is a server-IP answer.

## What was therefore built

Every source of the spec was built, each behind its kill switch
(`FIN_SOURCE_<NAME>=off`), so a source iad1 refuses can be switched off by an
environment variable without a deploy. A refused source also stands aside on its
own: a 403 or 429 makes the finance layer skip it for 15 minutes (Yahoo), 60
minutes (VNDirect, KBS, Vietcap) or 10 minutes (the others), and the chain answers
from the next source.

## To finish rule 3

1. Where Vercel Sandbox credentials are set, run `npm run finance:probe`
   (with `SEC_USER_AGENT` set too, or the two SEC rows are skipped).
2. Paste its table here, replacing the status line above.
3. For each source that does not answer 200: set `FIN_SOURCE_<NAME>=off` in
   the deployment, or remove it from `server/finance/chains.js`. If iad1 is
   refused by the Vietnamese brokers, run again with `--region sin1` — but moving
   the app's region is a separate decision (database and provider latency).

## What the probe asks, and how

- GET only. Nothing is posted.
- Every request says who it is: `Synapsez/<version> (+https://github.com/; market data on request)`,
  no Referer, no Origin.
- Yahoo is asked with `Mozilla/5.0`, the User-Agent the app has always sent it
  and the one exception the plan keeps.
- SEC is asked with `SEC_USER_AGENT` when it is set, and skipped when it is not:
  SEC wants a real contact, and no contact is written into the code.
- Binance, on §3.9's list, is left out: it is on the never-wire list, so its
  answer would decide nothing.
- The Yahoo crumb is a session token: only its length is printed.

## Fixtures

`test/fixtures/finance/*.json` were trimmed from the research's desktop probes
(the owner's machine, 2026-11-10; Hong Kong / Tokyo edge), keeping at most five
rows and only the fields the adapters read. Those marked `"_synthetic": true`
had no usable probe and are written from the documented shape:

- `sec-tickers.json` — `www.sec.gov` answered a block page to the research's generic UA.
- `sec-companyfacts.json` — companyfacts was not probed; built from the
  companyconcept answer, with a later duplicate fact added for the dedupe test.
- `kbs-intraday.json` — intraday bars were not probed; shaped like the day bars,
  the latest row with string numbers and no `va`, as the research saw.
- `yahoo-notfound.json` — Yahoo's documented error shape.
- `yahoo-search.json`'s one news item (`_synthetic_news`) — the probe's news list was empty.

`vietcap-details.json` keeps Vietcap's analyst rating and target price on
purpose — the test checks the adapter drops them — with the analyst's name
removed.
