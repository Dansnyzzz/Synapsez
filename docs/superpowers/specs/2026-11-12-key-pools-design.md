# Key pools: several keys per deployment service (spec A)

Owner, 2026-11-12: "every service has a fallback, because I have four more API keys for each"; the
keys are added by an administrator in Settings → Administration → Free allowances, and the table
counts the capacity of the keys actually added — "add two keys, add those two keys' capacity, in
real time" — reading each key's plan and usage from the provider where the provider says it.
Also that day: the owner moved Firecrawl to its **Hobby** plan.

Research: [key-usage-apis](../../research/2026-11-12-key-usage-apis.md),
[pricing-tax-check](../../research/2026-11-12-pricing-tax-check.md) §4–5,
[billing-audit](../../research/2026-11-12-billing-audit.md) §4.3. Decisions:
memory `billing-and-key-pools-decisions`. Spec B (billing) follows this one.

## What changes for whom

- **People using the app:** nothing they see. Searches, pages, the cloud computer, prices, mail
  keep working while one key is spent, refused or rate-limited — the next key takes over.
- **Administrators with `free_tier`:** the Free allowances table shows, per service, the sum of its
  keys, a count of keys, and opens to one row per key: its last characters, label, plan, used of
  limit, when it starts again, whose figure it is (the provider's, or counted here), and its state.
- **The owner:** adds and removes keys there. Adding is the owner's alone (see Security).

## Which services pool

| Service | Extra keys add capacity? | Live figure per key | Validity check (free) | Default ceiling per key |
|---|---|---|---|---|
| Exa | yes, if each key is its own Exa **user** (the $10 grant goes only to a user's first team) | no — counted from `costDollars` on every answer | `GET api.exa.ai/websets/v0/teams/me` | $9.50/month (9,500 mills), 1st of the month |
| Tavily | yes | **`GET /usage`** → `key.usage/limit`, `account.plan_usage/plan_limit` (≤10 calls/10 min: cached 5 min) | `/usage` | 950 credits/month |
| Brave | yes (each account has a card on file and no cap of its own) | no — counted, $0.005 a request | none free; checked on first use | 950 requests ($4.75)/month |
| Firecrawl | yes | **`GET /v2/team/credit-usage`** → `remainingCredits`, `planCredits`, `billingPeriodEnd` | the same call | 95% of the live `planCredits` (Hobby 5,000 → 4,750; Free 1,000 → 950), its own billing period |
| E2B | yes — but a machine stays on the account that made it, and the template must exist in each account | no — counted in mills | `GET api.e2b.app/v2/sandboxes` | its own one-time credit (default $100, lapsing as `E2B_CREDIT_EXPIRES`) spread by month as today |
| Google search (Gemini key) | only if the keys are from **different Google projects** (quota is per project) | no | `GET …/v1beta/models?pageSize=1` | 450/day |
| CoinGecko Demo | yes | no (`/key` is paid plans only) | `GET /api/v3/ping` | 9,500/month, 90/minute |
| FRED | yes (rate limit is per key) | no | `GET /fred/category?category_id=0` | 100/minute |
| Resend | yes | **`GET /usage`** → `emails.daily/monthly.{used,limit,resets_at}` (full-access key; a sending-only key answers 401 `restricted_api_key` and is then counted here) | `/usage` | 95/day, 2,850/month |
| Stack Exchange | **no** — the quota is per server address | `quota_remaining` | — | unchanged; the page says why adding a key does nothing |
| TheSportsDB | **no** — the free key is one public key | — | — | unchanged; same note |

Both "no" rows keep their single key and show a one-line reason instead of "Add key".

## Data

Schema **52**, table `service_keys`:

| column | type | |
|---|---|---|
| id | TEXT PK | random |
| service | TEXT NOT NULL | one of the pooled ids above |
| sealed | TEXT NOT NULL | crypto.js v2, kind **`service-key`**, context `['service-key', service, id]` |
| fingerprint | TEXT NOT NULL | HMAC-SHA256 of the key under the server's key-derivation secret; UNIQUE (service, fingerprint) — the same key twice is refused |
| hint | TEXT NOT NULL | the last four characters |
| label | TEXT | the owner's name for it ("account 2") |
| ceiling | DOUBLE PRECISION | the owner's override of the default ceiling, in the service's unit; NULL = default/live |
| state | TEXT NOT NULL DEFAULT 'ok' | ok · invalid · exhausted · cooling |
| state_at | TIMESTAMPTZ | |
| retry_at | TIMESTAMPTZ | when a cooling key may be tried again, or an exhausted one's period ends |
| live | JSONB | the provider's last answer about it: `{ plan, used, limit, resets, at }` |
| last_error | TEXT | short, secret-free |
| added_by | TEXT REFERENCES users(id) ON DELETE SET NULL | |
| added_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

RLS on like every table (the DO block stays last). Removing a key deletes its row (1:1). The
key in the environment stays **key 1** of its service, shown as "from the server's settings",
not removable here. At most **5 keys per service** including that one.

`secretsReseal.js` gains the table as a source so a key rotation reseals these too.

## Counting

`freeTier.js` counts per key. A key's bucket is `free:<service>@<keyId>:<period>`; the environment
key keeps the bucket it has today (`free:<service>:<period>`), so this month's counts carry over.
A service's ceiling is the **sum of its keys' ceilings**; its use is the sum of their counts — so a
key added counts at once and a key removed stops counting at once, with no restart.

Per-key ceiling, in order: the owner's override; else the provider's live limit × 0.95 (Tavily,
Firecrawl, Resend); else the default above. A provider's live **remaining** is believed when it is
lower than ours (as Firecrawl's is today), never when higher.

Firecrawl's three shares (search 60%, pages 35%, the rest 5%) become shares of the service's whole
capacity, so Hobby + four Free keys = 4,750 + 4 × 950 = 8,550 credits, of which searches may use
5,130. The Research/Government Index is free per call (1,000/day per team): pooled the same way.

The per-account fair share (`FREE_TIER_USER_DAILY`) and E2B's per-account day share are unchanged:
they are about people, not keys. Their pot grows with the capacity.

## Choosing a key, and moving on

`server/keyPool.js`:

- `keysFor(service)` — the healthy keys, opened once and kept per instance for 30 s (a change made
  in the admin page bumps a version row, so other instances see it within that).
- `pickKey(service, need)` — the healthy key with the **largest share left** (left ÷ ceiling), so
  keys are used evenly and none is spent while another sits full. A key with no room for `need` is
  passed over. None left → the service stands aside exactly as a spent allowance does today.
- `withKey(service, need, run)` — runs `run(key)`; on the answer:
  - **401/403, Exa `INVALID_API_KEY`, Brave 422 `SUBSCRIPTION_TOKEN_INVALID`, Gemini 400
    `API_KEY_INVALID`, CoinGecko 10002, FRED "not registered"** → that key `invalid` (not tried
    again until the owner re-checks it), next key;
  - **402, Tavily 432/433, Resend `daily_/monthly_quota_exceeded`, Exa `NO_MORE_CREDITS`** → that
    key `exhausted` until its period ends (or the provider's `resets`), next key;
  - **429** → that key `cooling` for `Retry-After` (30 s at least, 10 min at most), next key;
  - a timeout or 5xx → next key once, the key left as it is (the service may be down for all).
  Counting stays where it is today (`take`/`spend`/`hold`/`settle`), now with the key's id.
- **E2B is sticky:** the machine record keeps `keyId`; reconnecting, pausing and killing use that
  key. A new machine goes to `pickKey`. A key that is removed while machines run on it: those
  machines are left to time out (they pause on their own) and the next start makes a new one on a
  remaining key — the owner is told so before removing. A key whose account lacks the template is
  marked `invalid` with "the Synapsez template is not built in this E2B account"; the owner builds
  it there by running `scripts/e2b-template.mjs` once with that account's key in `E2B_API_KEY`.

The Gemini key here is only the deployment's search grounding (`search.js` google engine); the
deployment's model keys already rotate (providers).

## The paid key (owner, 2026-11-12)

"When the whole free allowance is used and the call is charged, take the one key the owner selects
and bill it in full, so the owner pays the service."

- Per service the owner may mark **one** key — any of its keys, the environment's too — as its
  **paid key** (radio in the key rows; "none" by default). Stored in `settings` under
  `service_paid_keys` as `{ [service]: { keyId, capMonthly } }` (`keyId` = a row id or `'env'`).
- Order of use: the free keys first, by largest share left, each inside its free ceiling. When none
  has room:
  - a call that is **charged** — `withKey(service, need, run, { paid: true })`, which spec B passes
    when a person's plan quota or service balance covers the call — goes to the paid key, past its
    free ceiling, billed by the provider to the owner's account;
  - with the ceilings lifted (`FREE_TIER_ONLY=false`) every call may;
  - any other call stands aside as today. **So nothing is billed before spec B charges people.**
- `capMonthly` (optional, in the service's unit: mills for Exa/E2B, requests or credits for the
  rest): the most the paid key may spend past its free ceiling in a month; reached, the paid key
  stands aside like a spent allowance. Recommended for Brave, which has no cap of its own; the
  page suggests one when Brave is chosen.
- Counted apart: `paid:<service>@<keyId>:<month>`, shown on the service row as "paid this month:
  $1.20 (key …a1b2)" — the figure spec B's real-cost line reads.
- A paid key that turns `invalid` or `exhausted` (the provider refuses even paid calls, e.g. no
  card) stands aside and the page shows it in red; nothing else takes its place by itself.
- The provider must allow going past the free amount on that account (Exa overage, Tavily
  pay-as-you-go limit, Firecrawl pay-as-you-go on Hobby, Brave's card, E2B's card): the page says
  this beside the radio. Only the owner can choose or clear it; audited (`service_paid_key_set`).

## Live figures

`keyPool.liveUsage(service, key)` per service that has one (Tavily `/usage`, Firecrawl
`/v2/team/credit-usage`, Resend `/usage`), each cached per key (Tavily 5 min, the others 2 min),
written to `service_keys.live`. Asked when the Free allowances page is open (every 60 s while it is
on screen, and by its Refresh button), and by the existing ten-minute Firecrawl refresh. Never on a
person's request path.

## Admin page (Settings → Administration → Free allowances)

- Each service row: name, `N keys` chip, the bar and `used / ceiling` summed, resets; pressed, it
  opens to its key rows: `…a1b2`, label, plan (live, e.g. "Hobby"), `used / limit`, "Firecrawl
  reports" or "counted here", resets, state (a coloured word: active / spent until 1 Dec / refused
  — check it / waiting 2 min), and, for the owner, **Remove**.
- **+ Add key** under each pooled service (owner): a password field, a label, and for Firecrawl /
  Tavily nothing else (the plan is read); for the others an optional ceiling. Added only after the
  validity check passes; the error said plainly ("Tavily refused this key"), never echoing it.
- Refresh button; the page asks again every 60 s while visible; the summary line says when it last
  heard from each provider.
- The two non-pooled services carry their reason; Gemini's row says the quota is per Google project.
- vi and en, keyboard reachable, the row expanders are buttons with `aria-expanded`.

## Routes

- `GET /api/admin/free-tier` — unchanged shape plus `services[].keys[]` (id, hint, label, plan,
  used, limit, resets, source: 'provider'|'counted', state, retryAt, fromEnv) and `pooled`.
- `POST /api/admin/service-keys` `{ service, key, label?, ceiling? }` — **owner only**; validated,
  sealed, audited (`service_key_added`: service + hint); 409 on a duplicate; 400 on a 6th key; at
  most 20 attempts an hour.
- `DELETE /api/admin/service-keys/:id` — owner only; audited (`service_key_removed`).
- `POST /api/admin/service-keys/:id/check` — owner only; re-runs the check, clears `invalid`.
- `PUT /api/admin/service-keys/paid` `{ service, keyId: string|null, capMonthly?: number|null }` —
  owner only; chooses or clears a service's paid key; audited.

## Security

- **Owner only for add/remove.** Whoever owns a key's account sees every query sent with it —
  every person's searches, pages and mail. An administrator given `free_tier` to watch allowances
  should not be able to route everyone's searches through an account of their own. (Same reasoning
  as the machine under the server being the owner's alone, adminRoles.js.)
- Keys never leave the server: the client gets the hint only; logs and errors carry the hint.
- Sealed with the v2 envelope bound to service and row id; a row copied to another service or id
  does not open.
- The validity checks are fixed URLs per service (no user-supplied host).
- Provider terms: the owner was told on 2026-11-12 that several free accounts per provider may break
  their terms. Firecrawl: keys of one **team** share credits and rate limits, so a key of the same
  team adds nothing; the page says so when the live figure shows the same team twice (same
  `planCredits` + same `billingPeriodEnd` + same remaining).

## Also in this round

- Firecrawl Hobby: ceilings come from the live `planCredits` (no hard-coded 950); the per-instance
  "asked to be left alone" becomes per key; Hobby's 100/min limits need no local throttle.
- The changelog, README's environment section (`*_API_KEY` stays key 1; more keys in the page),
  `.env.example` comment, privacy notice: not affected (no new data about people).

## Not in this round

- Keys for the model providers (they already rotate per account and per deployment).
- Stack Exchange per-user access tokens (would add 10,000 a day per token): a later choice.
- Gemini grounding after 2026-12-01: Google's docs say 2.5 Flash requests reroute to 3.5 Flash Lite,
  whose free tier has no grounding — the Google engine may stand aside then; told to the owner.

## Testing

- `test/key-pool.test.mjs`: pick by largest share; capacity = sum; add/remove changes it without a
  restart; each failure class → its state and the next key; cooling expires; exhausted until period
  end; legacy env bucket kept; Firecrawl shares of the summed capacity; E2B sticky key; duplicate
  fingerprint refused; 6th key refused; hint only in every response and log line; the paid key is
  used only after every free key is full and only for `paid: true` (or ceilings off), stops at its
  monthly cap, is counted under `paid:`, and is never used for an unpaid call.
- `test/database.test.mjs`: schema 52 table, RLS, cascade of `added_by`.
- `test/secrets-reseal.test.mjs`: the new kind is resealed.
- Route tests: owner-only, validation failure message, audit rows.
- `test/ui.test.mjs` (admin): the table opens to key rows; add with a stubbed validity check; remove.
- `server-i18n` / `i18n` for every new string.
