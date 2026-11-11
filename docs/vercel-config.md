# Why `vercel.json` looks the way it does

JSON has no comments. This file used to carry the reasoning in invented `comment`
keys, which is a deploy blocker rather than documentation: Vercel's published
schema declares `additionalProperties: false` on a `functions` entry, and the
only keys it accepts there are `runtime`, `memory`, `maxDuration`,
`supportsCancellation`, `maxConcurrency`, `includeFiles`, `excludeFiles`,
`regions`, `functionFailoverRegions` and `experimentalTriggers`. A `comment`
alongside them fails validation, so the reasoning lives here instead.

Every figure below was checked against Vercel's docs rather than remembered.

## `functions."api/index.js"`

### `maxDuration: 300`

The ceiling on Hobby, and also the default. With fluid compute — on by default
for every project created after 2025-04-23 — Hobby's default *and* maximum are
both 300s. Pro and Enterprise can go to 800s, or 1800s on the extended-duration
beta.

Stating it explicitly rather than leaning on the default is deliberate: it is the
number a long agent turn is being promised, and a project that later has its
dashboard default lowered should not quietly start truncating turns.

### `includeFiles: "server/**"`

Not optional. `server/store/schema.sql` is read at runtime with
`fs.readFileSync` from a path built out of `import.meta.url`. The bundler traces
`import` statements, not file reads, so without this the first request on a fresh
deployment fails with `ENOENT` and the database is never built.

### No `memory` key

Removed, and it must stay removed. Vercel's docs are explicit: *"You cannot set
your memory size using `vercel.json`. If you try to do so, you will receive a
warning at build time."*

It was also arguing for less than the plan already gives. The key said `1024`;
**Hobby always executes with 2 GB / 1 vCPU and cannot configure it at all.**
Only Pro and Enterprise can change the default, and only from the dashboard
(**Settings → Functions → Advanced Settings → Function CPU**). So the line
produced a build warning in exchange for asking for half of what was already
allocated.

## `functions."api/finance-sin1.js"`: Vietcap from Singapore

`regions: ["sin1"]`, `maxDuration: 30`. Vietcap answers a bare 400 to US addresses
and 200 from Singapore (the probe of 2026-11-11,
`docs/research/2026-11-10-finance-probe-iad1.md`), and Vietnamese financial
statements and index lists come only from Vietcap. So one small function runs in
Singapore and asks Vietcap for the app's functions in iad1
(`server/finance/relay.js`). It is not a proxy: only the deployment's own functions
call it, with `CRON_SECRET`; only GET to Vietcap's two API addresses; no redirects
followed; at most 4 MB in 15 s. Without `CRON_SECRET`, or without an https
`PUBLIC_URL` (or `VERCEL_URL`), the app does not use it and Vietcap stays off on
Vercel.

The rewrite that sends every `/api` path to `api/index.js` leaves this one path
out: `/api/((?!finance-sin1$).*)`.

Hobby's region limit ("single region") is not documented as counting per
deployment or per function; a preview deployment of this change is how it was
checked before it reached production.

## `crons`

### Both entries run on the free plan

The previous configuration claimed Hobby "runs only the first entry" and that the
model refresh was therefore dead in production. That is not what the limit is,
and believing it means switching off a feature that works.

The actual Hobby limits:

| | Cron jobs per project | Minimum interval | Scheduling precision |
|---|---|---|---|
| **Hobby** | 100 | Once per day | Per-hour (±59 min) |
| **Pro** | 100 | Once per minute | Per-minute |
| **Enterprise** | 100 | Once per minute | Per-minute |

So the constraint is **frequency, not count**. Both `/api/cron/run-tasks` and
`/api/cron/refresh-models` are scheduled once a day, both are well inside the
100-job allowance, and **both fire on the free plan.**

The real trap is the frequency rule, and it fails loudly: a cron expression that
would run more than once a day — `0 * * * *`, `*/30 * * * *` — is rejected **at
deployment time** with *"Hobby accounts are limited to daily cron jobs."* That is
a broken deploy, not a degraded feature, which is why `test/deploy.test.mjs`
asserts every schedule is at most daily.

### The times

`0 16 * * *` and `0 23 * * *` are UTC; 16:00 UTC is 23:00 in UTC+7, and 23:00
UTC is six in the morning there. They are apart so the two jobs do not contend
for the same cold start.

The model library is refreshed at six in the morning **on each person's own
clock**, not only by this cron: `refreshIfStale` treats the library as stale
when its last refresh was before 06:00 in the asking person's zone, so the first
person to open the app after their morning pulls today's catalogue — new models,
prices and discounts, and end dates ("going away") — wherever they are. The cron
is the backstop for a day nobody opens it.

Hobby fires within the hour, not on the minute: `0 16 * * *` lands somewhere
between 16:00 and 16:59. Nothing here needs the precision — scheduled tasks also
get nudged along when somebody opens the app, and the model library refreshes on
demand when it goes stale.

### On Hobby, from outside

A free external pinger (cron-job.org) calling `/api/cron/run-tasks?background=1` every few
minutes, with `Authorization: Bearer <CRON_SECRET>`, gives Hobby the heartbeat its own cron cannot.
The `background` form replies `202` immediately and finishes the work under `waitUntil`, inside
the same 300s ceiling. Setup steps are in the README, under Scheduled tasks.

### On Pro

Change `/api/cron/run-tasks` to `*/15 * * * *`. That is what the feature actually
wants, and it is only the Hobby frequency rule that stops it.

## Authentication

Both endpoints are behind `requireCron` and need `CRON_SECRET`. They are public
URLs otherwise, and `run-tasks` does real work. `test/deploy.test.mjs` checks
that a missing secret and a wrong secret both get a 401.

## Environment for market data (`server/finance`)

`market_data` works with none of these set. They are set in the Vercel dashboard
(Settings → Environment Variables), never in a committed file.

| Variable | What it does | Without it |
| --- | --- | --- |
| `SEC_USER_AGENT` | The User-Agent SEC EDGAR is asked with, as SEC requires: `Synapsez <contact email>` — the owner's real contact. **Required for US statements, filings and the US screen.** | SEC is never asked; US statements fall through to Yahoo, and the answer says "SEC needs SEC_USER_AGENT". |
| `COINGECKO_DEMO_KEY` | CoinGecko's free Demo key (no card): 100 calls a minute of this deployment's own, sent as `x-cg-demo-api-key`. | Keyless CoinGecko, rate-limited by the server's address and shared with every other tenant on it. |
| `FRED_API_KEY` | FRED's free key: US rates, inflation, unemployment, GDP. | US macro falls through to the World Bank (annual). |
| `FIN_SOURCE_<NAME>=off` | Switches one source off everywhere, at once, without a deploy. `<NAME>` is one of `YAHOO, VNDIRECT, KBS, VIETCAP, SEC, COINGECKO, FRANKFURTER, ECB, ERAPI, VIETCOMBANK, SJC, WORLDBANK, FRED, NSO, FMARKET`. Use it if a source objects, or keeps refusing. `=on` asks a source the deployment would otherwise leave alone. | Every source is on, except SJC on Vercel (a Cloudflare bot check turns every datacenter away) and Vietcap on Vercel outside Asia (a bare 400 to US addresses) — the probe of 2026-11-11, `docs/research/2026-11-10-finance-probe-iad1.md`. |

The pooled ceilings (`server/freeTier.js`) can be set too, each a number:
`COINGECKO_FREE_MONTHLY` (9,500), `COINGECKO_FREE_MINUTE` (90), `YAHOO_FREE_DAILY`
(5,000), `VNDIRECT_FREE_DAILY`, `KBS_FREE_DAILY`, `VIETCAP_FREE_DAILY` (3,000 each),
`SEC_FREE_DAILY` (20,000), `FRED_FREE_MINUTE` (100). They show on the admin Free
allowances page.

Before relying on a source in production, run `npm run finance:probe` where
Vercel Sandbox credentials are set (rule 3: a source is probed from a server
address before it is built on). Its result is recorded in
`docs/research/2026-11-10-finance-probe-iad1.md`; at the time of building it had
not been run.
