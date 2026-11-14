# Billing preview (spec B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build all of billing — plans, checkout by SePay VietQR, a service balance, metering of search tools, the cloud computer and storage, receipts, the Billing tab and an admin card — visible and active for administrators only (`BILLING_MODE=preview`, the default).

**Architecture:** A new `server/billing/` package (pure rules in `plans.js`, `period.js`, `codes.js`, `mode.js`; money in `ledger` store methods that change the balance in one SQL statement each; `fx.js`, `orders.js`, `subscriptions.js`, `sepay.js`, `meter.js`, `promo.js`, `mail.js`, `receipt.js`, `einvoice.js`, `daily.js`), one route module `server/routes/billing.js`, schema 53, and four browser modules (`billing-format.js`, `billing-plans.js`, `billing-panel.js`, `billing-admin.js`). Every transfer credits the balance first; a plan is bought by taking its price out of the balance.

**Tech Stack:** Node 22 ESM, Express 5, Postgres (PGlite in tests), vanilla JS in `public/`, `@napi-rs/canvas` `PDFDocument` for receipts, the repo's hand-rolled test harness (`node test/<name>.test.mjs`), Playwright suites under `npm run test:ui`.

**Spec:** `docs/superpowers/specs/2026-11-13-billing-preview-design.md` — read the section named in each task before starting it.

## Global Constraints

- `BILLING_MODE`: `off` | `preview` | `live`; unset or unknown means `preview`. In `off` every billing route and the webhook answer `404`. In `preview` a non-administrator gets `404` (not `403`) from every `/api/billing*` route. `live` is accepted but B1 wires nothing that needs it beyond `hold.refused`.
- Billable account = an administrator (`role === 'admin'`) in `preview` who holds a subscription (`active` or `grace`) or a balance > 0. Nobody else is metered by billing; their behaviour is unchanged byte for byte.
- In `preview`, billing **never refuses**: when nothing can be held, the call goes ahead exactly as today (`paid: false`, today's fair-share rules) and `bill:would:<user>:<kind>:<VN day>` is incremented.
- Plans (USD cents): plus 500/5700, pro 800/9100, max 1500/17100. Included a month: searches 150/250/450; cloud computer minutes 240/360/720; storage GB 3/5/10. Free: 0 of each, storage 0.5 GB (owner's table, 500 MB).
- **No daily limits** (owner, 2026-11-13): an allowance is a month's, usable on any day. No per-day counter, field or display anywhere in billing.
- Pay as you go **follows the USD rate** (owner, 2026-11-13): base prices at the anchor rate **25,656 đ/USD** are search **400đ** a unit, cloud computer **5,000đ** an hour, storage **1,000đ** per GB-month; at rate `r` they are `search = ceil10(400 × r / 25656)`, `minute = ceil(5000 × r / 25656 / 60)` (84đ at the anchor), `storageGbMonth = ceil10(1000 × r / 25656)`. Metering uses the last known rate of any age (a call is never blocked for want of a rate), the anchor when none was ever read. Storage is charged daily as `ceil(overTenths × storageGbMonth / 10 / daysInVnMonth)` đ.
- A Firecrawl call that reads several pages: `max(1, ceil(pages / 3))` units.
- Free engines (DuckDuckGo, Google, Stack Exchange, free Firecrawl indexes) and the ten-minute search cache cost **0** units. Metered engines: exa, tavily, brave, firecrawl (`ENGINES[x].metered` in `server/search.js`).
- Plan đồng price = `Math.ceil(usdCents × rateCenti / 10_000_000) × 1000` where `rateCenti = Math.round(rate × 100)`. PAYG prices: see above (anchored to 25,656 and scaled by the rate).
- Rate chain: open.er-api (`erapi`) → Vietcombank transfer rate (`vietcombank`, the `bank-transfer` row) → `frankfurter`, via `fromSource` in `server/finance/sources/fx.js`. Cached 1 h in memory and in setting `billing_fx`; older than 48 h is unusable (`BillingUnavailable`).
- Orders lock rate and price; QR good **30 min** (`ORDER_TTL_MS = 1_800_000`). Renewal orders stay good until grace ends.
- Payment code: `SZ` + exactly 10 digits from `crypto.randomInt`; matched from SePay's `code` field (`/^SZ\d{10}$/i`) else `/SZ(\d{10})(?!\d)/i` on `content`; stored uppercase.
- Top-up bounds: min 50,000đ (no plan) / 100,000đ (a plan); the form refuses a top-up that would take the balance past 200,000đ (no plan) / 1,000,000đ (a plan); presets 100,000 / 200,000 / 500,000. Transfers past the bound are still credited. Balance expires 12 months after the last top-up; email 30 days before.
- Periods in Vietnamese time (UTC+7, no DST); a month from day 31 ends on the last day of a shorter month, always counted from the original start day. Upgrade (higher rank, or month→year) starts a new period now with credit `floor(paidVnd × (end − now) / (end − start))`. Downgrade, **any** year→month move (whatever the plan rank — an immediate upgrade from a year plan is a higher plan's year) and cancel take effect at period end; a period's `paid_vnd` is its full value (`price_vnd`), so chained upgrades keep their carried credit; the billing day is kept by `subscriptions.anchor_at`; an order carries the `basis` it was quoted on and is refused if the subscription changed (controller rulings after Task 4 review, 2026-11-13). Grace **3 days**; reminder **3 days** before the end; unpaid grace days are not charged.
- Money: whole đồng `BIGINT`, USD whole cents, never a float in the database. Every balance change is **one SQL statement** (data-modifying CTE) with `CHECK (vnd >= 0)`; a charge that does not fit changes nothing.
- Webhook `POST /api/billing/sepay`: before `express.json`, raw bytes; `X-SePay-Signature: sha256=<hex>` = HMAC-SHA256(`SEPAY_WEBHOOK_SECRET`, `${X-SePay-Timestamp}.${raw}`); missing header, wrong length or wrong signature or `|now − ts| > 300 s` → `401`; success body exactly `{"success": true}` written only after the database work; own failure → `500`. Only `transferType === 'in'` and `accountNumber === SEPAY_BANK_ACCOUNT`; others `ignored`. Dedupe key `ref:<referenceCode>` else `id:<id>`, UNIQUE.
- Rate limits: orders 10/hour per account; promo redeem 10 tries/hour per account; order status 1/second per order; SePay userapi at most once per 30 s per order and once per 10 s overall.
- Secrets only from env: `SEPAY_WEBHOOK_SECRET`, `SEPAY_API_TOKEN`, `SEPAY_EINVOICE_CLIENT_ID`, `SEPAY_EINVOICE_CLIENT_SECRET`; bank details `SEPAY_BANK_ACCOUNT`, `SEPAY_BANK_CODE`, `SEPAY_ACCOUNT_NAME`; `BILLING_SELLER_NAME` (default `Synapsez`); `BILLING_TAX_RATE` (unset = no tax line). None in a response, a log line or a thrown message.
- **Never read, edit or stage `.env` or `.env.example`** (owner's permission rule). New variables are documented in README only. Stage files by path; never stage `.claude/AUDIT_RULES.md`, `.claude/audit-annex/`, `.vscode/`, `Exa Deep Research-3.4.1-v1/`.
- Every new user-facing string in both `public/js/locales/en.js` and `vi.js` (`test/i18n.test.mjs`); every new server error a person can see has its Vietnamese in `server/i18n/vi.js` (`test/server-i18n.test.mjs`).
- Working tree is CRLF; never leave a lone CR. Follow the repo's comment style (why, not what) and gate rule CODE-039 (no more than 93 back-to-back doc blocks).
- Run the gate from the **Bash tool**: `npm run gate > <log> 2>&1` (from PowerShell the clipboard checks fail).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `server/keyPool.js`, `server/app.js` (service-key routes), `public/js/free-allowances.js`, `README.md`, `server/freeTier.js` | 1 | spec A leftovers |
| `server/freeShares.js`, `server/freeTier.js`, `server/usageReport.js`, `public/js/usage-panel.js` | 1b | each account's free share, worked out monthly from capacity, shown |
| `server/storageQuota.js`, `server/attachments.js` | 1c | 0.5 GB for an account with no plan |
| `server/billing/plans.js` | 2 | plans, PAYG prices, bounds, rounding |
| `server/billing/period.js` | 2 | Vietnamese-time periods, proration |
| `server/billing/codes.js` | 2 | payment codes |
| `server/billing/mode.js` | 2 | `BILLING_MODE`, who sees billing |
| `server/store/schema.sql`, `server/store/pg.js` | 3 | schema 53, billing store methods |
| `server/secretContexts.js`, `server/secretsReseal.js` | 3 | sealed billing profiles |
| `server/billing/fx.js` | 4 | the USD→VND rate |
| `server/billing/orders.js` | 4 | quotes, orders, applying payments |
| `server/billing/subscriptions.js` | 4 | activate, change, renew, grace, end |
| `server/billing/sepay.js` | 5 | webhook check, matching, QR, reconcile, simulate |
| `server/billing/meter.js` | 6 | holds for search and the cloud computer, storage, period usage |
| `server/search.js`, `server/tools/cloud.js`, `server/tools/codeContext.js`, `server/research/gather.js`, `server/e2b.js` | 6 | metering hooks |
| `server/billing/promo.js`, `server/billing/mail.js`, `server/billing/daily.js` | 7 | promo codes, emails, the daily work |
| `server/routes/billing.js`, `server/app.js`, `server/adminRoles.js`, `server/audit.js`, `server/routes/account.js` | 7 | routes, webhook mount, permission, audit kinds, export |
| `server/billing/receipt.js`, `server/billing/einvoice.js` | 8 | receipt PDFs, SePay e-invoices (off) |
| `public/js/billing-format.js`, `public/js/billing-plans.js`, `public/js/account-menu.js`, `public/index.html`, `public/css/app.css`, `public/js/api.js`, locales | 9 | menu row, plan line, plans sheet, checkout |
| `public/js/billing-panel.js`, `public/js/billing-admin.js`, `public/js/app.js`, `public/js/privacy.js` | 10 | Billing tab, admin card |
| `package.json`, `public/changelog.json`, `CHANGELOG.md`, `README.md`, `test/features.test.mjs` | 11 | release 1.30.0 |

New test files, each added to the `npm test` chain in `package.json` right after `node test/key-pool.test.mjs`: `test/free-shares.test.mjs` (1b), `test/storage-quota.test.mjs` (1c), `test/billing-core.test.mjs` (Task 2), `test/billing-store.test.mjs` (3), `test/billing-flow.test.mjs` (4–5), `test/billing-meter.test.mjs` (6), `test/billing-routes.test.mjs` (7), `test/billing-docs.test.mjs` (8). Browser: `test/ui-billing.test.mjs` appended to `test:ui` (9–10).

---

### Task 1: Spec A's leftovers before anything passes `paid: true`

**Files:**
- Modify: `server/keyPool.js`, `server/app.js` (the `/api/admin/service-keys*` routes), `public/js/free-allowances.js`, `server/freeTier.js:35-36`, `README.md` (the two "Firecrawl Free plan, never a bill" lines, near :1168 and :2084)
- Test: `test/key-pool.test.mjs`, `test/http.test.mjs`

**Interfaces:**
- Consumes: spec A's `pickKey(service, amount, { paid })`, `paidKeyOf(service)`, `setPaidKey(service, keyId, capMonthly)`, `ceilingOf`, `envIdOf(service)`, Brave's held unpaid call in `server/search.js` (`take('brave', 1, …, { keyId: meta.id, paid: meta.paid })`).
- Produces: nothing new; the paid key becomes safe to reach.

The seven findings (from spec A's final review and Opus security review):

1. **Firecrawl paid key blocked by the low-count rule.** The rule that passes over a key whose live remaining count is low (`passOver`) also passes over the paid key on a charged call. Exempt a pick whose `meta.paid` is true.
2. **`fullest` fallback.** When every key is over its ceiling and ceilings are lifted (`FREE_TIER_ONLY=false`), the fallback that returns the fullest key can return the paid key past its monthly cap. The paid key may only be returned through the paid path, which checks the cap.
3. **Unpaid Exa/Tavily calls on the paid key.** Brave's unpaid call on its single key is held with `take` before the call (`server/search.js` ~:356). Exa and Tavily calls that land on the key chosen as paid, while unpaid, must be held the same way so they count against the free ceiling and never bill silently.
4. **M1 — free ceiling unbounded.** `POST /api/admin/service-keys` (and any ceiling update) accepts any positive ceiling, and `ceilingOf` prefers it over the provider's plan. Cap it on the server at the service's free amount (the default per-key ceiling, or 95% of the live plan figure where the provider reports one); refuse higher with `422` and the message "Billing past the free amount is what the paid key and its monthly cap are for." (with its Vietnamese in `server/i18n/vi.js`).
5. **L1 — unreadable cap saves "no cap".** In `free-allowances.js` the monthly cap box: when `input.validity.badInput` (e.g. "2,000"), show an error and do not save; "no cap" only when the box is empty **and** the person pressed the explicit "No cap" action (add that button, both languages).
6. **L5 — `env` paid choice survives a key swap.** Store `envIdOf(service)` alongside a paid choice of `'env'`; on read, a mismatch means no paid key.
7. **Stale words.** Replace the "Firecrawl Free plan, never a bill" sentences with the Hobby plan and the paid-key rule as shipped (README and `server/freeTier.js:35-36`).

- [ ] **Step 1: Write failing tests** in `test/key-pool.test.mjs` (new section "before spec B charges anything"): (1) a Firecrawl paid key with a low live count is chosen for `{ paid: true }`; (2) with `FREE_TIER_ONLY=false` and every free key spent, an unpaid pick never returns the paid key past its cap; (3) an unpaid Exa call landing on the paid key is counted against its free ceiling (`free:exa@<id>:<month>`) and refused once over it; (4) `setPaidKey('exa','env',…)` then a different `EXA_API_KEY` → `paidKeyOf('exa')` is null; and in `test/http.test.mjs`: (5) adding an Exa key with ceiling 100000 mills → `422`; with 9500 → `201`.
- [ ] **Step 2: Run** `node test/key-pool.test.mjs` and `node test/http.test.mjs` — the new checks fail.
- [ ] **Step 3: Implement** the seven fixes.
- [ ] **Step 4: Run** both suites, plus `node test/search.test.mjs`, `node test/firecrawl.test.mjs`, `node test/ui.test.mjs` (free-allowances page) — all pass.
- [ ] **Step 5: Commit** `fix(keys): the paid key is safe to reach — spec A's leftovers before billing`.

---

### Task 1b: Today's free shares — a month's, worked out from the real capacity (owner, 2026-11-13)

The owner: "limit users by the month, not the day", and "the numbers must not need changing when there are many more users". A fixed 900 a month runs the deployment's free keys dry after about 17 heavy accounts; so each account's monthly share is **worked out on the 1st** from what the keys can really do and how many people use them, held for the month, and **shown to the person with how it was worked out**.

**Files:**
- Create: `server/freeShares.js` (the share rules and the stored month figure)
- Modify: `server/freeTier.js` (`mayMeter`, `countMetered`, `userBucket`, `freeTierReport`, `e2bAccountAllowance`, `e2bAccountSpend`; remove `e2bDayShare`, the `free:e2b:day:*` buckets and `E2B_ACCOUNT_DAY_FLOOR`; the module comment), `server/store/pg.js` (one method, below), `server/search.js:128` and `server/tools/cloud.js:3458` ("share of today's …" → "share of this month's …"), `server/usageReport.js` (the account's shares in the Usage payload), `public/js/usage-panel.js` (a "This month's free share" card in the overview), `public/js/free-allowances.js:233` (the line under the table), both locales, `server/i18n/vi.js`, `README.md` (:1302 and the env table near :2080)
- Test: `test/free-shares.test.mjs` (new, PGlite; add to the `npm test` chain after `key-pool`), `test/features.test.mjs` (the fair-share section near :2490), `test/e2b.test.mjs` (the `e2bDayShare` section near :798 is replaced), `test/ui-usage-guide.test.mjs` or `test/ui.test.mjs` (the card)

**Interfaces — Produces:**
```js
// server/freeShares.js
/** What one metered search costs each pooled engine at the medium search level, to turn allowances into searches. */
export const SEARCH_COST = Object.freeze({ exa: 15 /* mills: auto 7 + 8 pages of text */, tavily: 1 /* credit */, brave: 1 /* request */, firecrawl: 2 /* credits a search, of its search share */ });
export const SHARE_BOUNDS = (env = process.env) => ({
  searchMin: num(env.FREE_TIER_USER_MONTHLY_MIN, 30), searchMax: num(env.FREE_TIER_USER_MONTHLY_MAX, 900), searchPeopleFloor: 10,
  machineMinMills: num(env.E2B_ACCOUNT_MIN_MILLS, 133) /* about an hour of the 2-vCPU machine */, machineMaxShare: e2bAccountShare(env) /* 0.34 */, machinePeopleFloor: 3,
});
/** This month's shares: { month, searches, machineMills, capacity: { searches, machineMills }, people: { searches, machines }, at } */
export async function monthShares({ now = new Date() } = {})
```
- `server/store/pg.js`: `countAccountsByBucket(patterns)` → number of distinct account ids among live `rate_limits` buckets matching any of the `LIKE` patterns (the id is the segment after `free:user:` / before `:` in `free:e2b:<month>:user:<id>`).

**Rules:**
- **Capacity of searches this month** = Σ over exa, tavily, brave, firecrawl of `floor(allowance(service).limit / SEARCH_COST[service])` (Firecrawl: its *search* share's limit). Google's daily quota and the free engines are not counted.
- **People** = distinct accounts with a metered-search count this month or last month (`free:user:<id>:<month>`, the bucket now kept until the end of the **next** month so last month's can be read).
- **A reserve for people who arrive later** (owner, 2026-11-13: "what if more users come after the 1st?"): only `(1 − FREE_SHARE_RESERVE)` of the capacity is shared out on the 1st — default reserve **0.2** — so 20% stays for accounts that start mid-month.
- **An account's monthly searches** = `clamp(floor(capacity × (1 − reserve) / max(10, people)), 30, 900)`.
- **Arriving mid-month:** a **newcomer** — an account with no metered count last month (one that had one is already in the 1st's divisor and is never prorated; controller ruling after review, 2026-11-13) — whose first metered search of the month comes on day `d` of a month of `D` days gets `max(30, floor(N × (D − d + 1) / D))` — the share for the days that are left — drawn from the reserve. Its card says why ("you started on the 20th, so this month's share covers 11 of 30 days").
- **When the pool still runs dry** (more people than any forecast): nothing is billed — these calls are unpaid by construction and can never reach the paid key (spec A, Task 1) — the metered engines stand aside and the free ones answer, for everyone, until the 1st. The card says so in that case ("the free keys are used up for this month").
- **Cloud computer:** capacity = this month's E2B ceiling (`allowance('e2b').limit`, mills); people = distinct accounts with a machine count this month or last (`free:e2b:<month>:user:<id>`, kept likewise); share = `clamp(floor(capacity × (1 − reserve) / max(3, people)), 133, floor(capacity × E2B_ACCOUNT_SHARE))` mills, prorated the same way for an account starting mid-month (at least 133). No daily split.
- **Held for the month:** the first call of a UTC month works the figures out and stores them in setting `free_shares:<month>`; later calls read it. If the capacity rises during the month (a key added), the shares are worked out again and the higher of old and new kept — **never lowered mid-month**. Any failure to work them out falls back to the last stored month's figures, else to the maxima (900, 34%) — a share that cannot be computed never blocks anybody.
- `mayMeter(userId)` → this month's count `< monthShares().searches`; `countMetered` adds to `free:user:<id>:<month>`. `FREE_TIER_USER_DAILY` is no longer read (README says it was replaced in 1.30.0 by the worked-out share and its two bounds).
- `freeTierReport()` gains `shares` (the stored month figure); the Free allowances page's line: "This month each account may make N metered searches and use H of the cloud computer — the keys' capacity (C searches) shared by P people, between 30 and 900."
- **Shown to everyone:** Settings → Usage overview gets a card "This month's free share": searches used X of N, cloud computer used of H, when it starts again (the 1st), and one sentence on how N is worked out (capacity ÷ people, the bounds). The share applies to every account today, administrators included; from Task 6 on, a billable account's searches skip it, and its card says its plan applies instead.

- [ ] **Step 0 (tests for the reserve):** with capacity 10,000 and 20 people the 1st's share is `floor(8000/20) = 400`; an account starting on day 21 of a 30-day month gets `floor(400 × 10/30) = 133`; one starting on day 30 gets 30 (the floor); with the pool spent, `mayMeter` is false for everyone and no call is made with `paid: true`.
- [ ] **Step 1: Write failing tests** (`test/free-shares.test.mjs`): capacity with Exa 2 keys (19,000 mills) + Tavily 1 (950) + Brave 1 (950) + Firecrawl Hobby search share → the expected sum; 5 people → `min(900, floor(cap/10))` (people floor 10); 400 people → `floor(cap/400)` not below 30; 900 searches in one day by one account allowed when the share is 900, the next refused; the 1st of the next month starts again; a key added mid-month raises N, removing one does not lower it; a store failure → 900 and nobody blocked; E2B: one account may use its whole monthly share on day one, the share is between 133 mills and 34% of the month; `FREE_TIER_USER_DAILY=1` alone changes nothing; `freeTierReport().shares` present; the Usage card shows "X of N".
- [ ] **Step 2: Run** `node test/free-shares.test.mjs` — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node test/free-shares.test.mjs`, `node test/features.test.mjs`, `node test/e2b.test.mjs`, `node test/search.test.mjs`, `node test/firecrawl.test.mjs`, `node test/key-pool.test.mjs`, `node test/i18n.test.mjs`, `node test/server-i18n.test.mjs`, and the UI suite holding the card — pass.
- [ ] **Step 5: Commit** `feat(free tier): each account's free share is a month's, worked out from the keys' real capacity and shown`.

---

### Task 1c: 0.5 GB of files for an account with no plan, until files leave the database (owner, 2026-11-13)

Files are stored in Postgres as base64 (`attachments.data`, `attachment_versions`), so a GB of files costs about 4,265đ a month of database disk ($0.125/GB past the 8 GB included, × 4/3 for base64) — and nothing limits an account today. Until files move to object storage (its own project, required before B2), an account with no paid plan may keep **0.5 GB**.

**Files:**
- Create: `server/storageQuota.js`
- Modify: `server/attachments.js` (each `createAttachment` path), `server/routes/chatShare.js:573` (copying a shared chat's files), the version-writing path in `server/store/pg.js` (~:2699) through its caller, `server/usageReport.js` + `public/js/usage-panel.js` (a storage line on Task 1b's card), locales, `server/i18n/vi.js`, `README.md`
- Test: `test/storage-quota.test.mjs` (new, PGlite; add to the chain), `test/attachments.test.mjs`

**Interfaces — Produces:**
```js
// server/storageQuota.js
export const freeStorageBytes = (env = process.env) => num(env.FREE_STORAGE_BYTES, 500_000_000);
export class StorageFull extends Error { /* status 422, code 'storage_full', usedBytes, limitBytes */ }
/** Throws StorageFull when adding `bytes` would take a limited account past its room. */
export async function assertRoom(user, bytes)
export async function storageOf(user) // → { usedBytes, limitBytes | null }  (null = no limit)
```
- Store: `bytesOfUser(userId)` → `SUM(attachments.bytes) + SUM(attachment_versions.bytes)` for that account (raw bytes, one query).

**Rules:**
- Limited: an account that is not an administrator (B1 adds: and holds no paid plan — Task 6 must call `storageOf` with that in mind; until then every non-administrator is limited). Administrators: no limit, as with the chat limit.
- Refused: a new upload, a new file the assistant writes, a new version of a file, a shared chat's files copied in — when it would pass the limit. Office renders and thumbnails derived from a file already kept are **not** refused (they are pictures of something the person already has), but they are counted.
- Message (both languages): "Your files are full: {used} of {limit} used. Delete files you no longer need in Settings → Privacy → Your data, then try again." — point at the place this app really lists and deletes files (find it; say it exactly).
- Nothing already stored is deleted; an account already over keeps its files and cannot add more until under.
- Task 1b's card shows "Files: X of 0.5 GB".

- [ ] **Step 1: Write failing tests**: a member at 499 MB adding 2 MB → refused (422, `storage_full`, the message with both figures); an administrator not refused; 499 MB + 1 MB → allowed; versions counted; a derived render not refused; a shared-chat copy refused when over; nothing is deleted.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node test/storage-quota.test.mjs`, `node test/attachments.test.mjs`, `node test/http.test.mjs`, `node test/office.test.mjs`, `node test/i18n.test.mjs`, `node test/server-i18n.test.mjs` — pass.
- [ ] **Step 5: Commit** `feat(files): half a gigabyte of files for an account with no plan, while files live in the database`.

---

### Task 1d: The Vercel stand-in machine can never bill (owner, 2026-11-13: "make sure nothing loses money")

When an account's E2B share is spent, its work goes to a Vercel Sandbox "stand-in" (`server/sandbox.js`). On Vercel **Hobby** that is free — past the 5 included Active-CPU hours creation pauses. On Vercel **Pro** (which the owner plans before the first customer) it is billed ($0.128 per Active-CPU hour, plus memory), and today only per-day action caps bound it. So the app counts it and stops at Hobby's free amount whatever the plan.

**Files:** Modify `server/sandbox.js` (where a Vercel Sandbox is created and kept awake), `server/freeTier.js` (a `vercel` row in `TIERS` and the report), `public/js/free-allowances.js` (its row), locales, `README.md`. Test: `test/cloudBrowser.test.mjs` or the sandbox suite that drives the stand-in (find it), `test/key-pool.test.mjs` only if the report shape there changes.

**Rules:**
- Counted per UTC month as CPU-seconds = wall seconds the stand-in is kept awake × its vCPUs (an upper bound of Active CPU, so the count is never under the bill). Bucket `free:vercel:<month>`.
- Ceiling `VERCEL_SANDBOX_MONTHLY_CPU_HOURS`, default **4.5** (90% of Hobby's 5). Past it the stand-in is not started: the person is told the cloud computer is unavailable until the 1st (both languages), exactly as when E2B is unavailable and there is no stand-in.
- A paying account's machine time (B1 Task 6) is charged to it on E2B; it never uses the stand-in past the ceiling either.
- The Free allowances page shows the row: used of 4.5 CPU-hours, "counted here".

- [ ] **Step 1: Write failing tests:** a stand-in kept awake 10 minutes on 2 vCPUs counts 1,200 CPU-seconds; at the ceiling a new stand-in is refused with the message and no Vercel call is made; the count starts again on the 1st; the report has the `vercel` row.
- [ ] **Step 2: Run** — fails. **Step 3: Implement.** **Step 4: Run** the stand-in suite, `node test/features.test.mjs`, `node test/i18n.test.mjs`, `node test/server-i18n.test.mjs` — pass.
- [ ] **Step 5: Commit** `fix(sandbox): the Vercel stand-in stops at Hobby's free hours, so it can never bill`.

---

### Task 2: The rules — plans, periods, codes, mode

**Files:**
- Create: `server/billing/plans.js`, `server/billing/period.js`, `server/billing/codes.js`, `server/billing/mode.js`
- Test: `test/billing-core.test.mjs` (add to the `npm test` chain)

**Interfaces — Produces** (every later task uses these names):

```js
// server/billing/plans.js
export const PLAN_IDS = ['free', 'plus', 'pro', 'max'];
export const PAID_PLANS = ['plus', 'pro', 'max'];
export const PERIODS = ['month', 'year'];
export const RANK = Object.freeze({ free: 0, plus: 1, pro: 2, max: 3 });
export const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', usdCents: { month: 0, year: 0 }, searches: 0, sandboxMinutes: 0, storageGb: 0.5 }),
  plus: Object.freeze({ id: 'plus', usdCents: { month: 500, year: 5700 }, searches: 150, sandboxMinutes: 240, storageGb: 3 }),
  pro: Object.freeze({ id: 'pro', usdCents: { month: 800, year: 9100 }, searches: 250, sandboxMinutes: 360, storageGb: 5 }),
  max: Object.freeze({ id: 'max', usdCents: { month: 1500, year: 17100 }, searches: 450, sandboxMinutes: 720, storageGb: 10 }),
});
/** Pay-as-you-go prices at the anchor rate (owner, 2026-11-13: they follow the USD rate, as plan prices do). */
export const PAYG_ANCHOR_RATE = 25_656;
export const PAYG_BASE = Object.freeze({ searchVnd: 400, sandboxVndPerHour: 5000, storageVndPerGbMonth: 1000 });
const ceil10 = (n) => Math.ceil(n / 10) * 10;
/** The pay-as-you-go prices at a rate, in whole đồng. */
export function paygPrices(rate = PAYG_ANCHOR_RATE) {
  const k = Number(rate) > 0 ? Number(rate) / PAYG_ANCHOR_RATE : 1;
  return {
    searchVnd: ceil10(PAYG_BASE.searchVnd * k),
    sandboxVndPerMinute: Math.ceil((PAYG_BASE.sandboxVndPerHour * k) / 60),
    storageVndPerGbMonth: ceil10(PAYG_BASE.storageVndPerGbMonth * k),
  };
}
export const TOPUP = Object.freeze({ minNoPlan: 50_000, minWithPlan: 100_000, maxBalanceNoPlan: 200_000, maxBalanceWithPlan: 1_000_000, presets: Object.freeze([100_000, 200_000, 500_000]) });
export const BALANCE_EXPIRY_MONTHS = 12;
export const EXPIRY_WARNING_DAYS = 30;
export const ORDER_TTL_MS = 30 * 60_000;
export const GRACE_DAYS = 3;
export const REMIND_DAYS = 3;
export const PAGES_PER_UNIT = 3;
export const isPlan = (id) => Object.hasOwn(PLANS, String(id));
export const isPaidPlan = (id) => PAID_PLANS.includes(String(id));
export const isPeriod = (p) => PERIODS.includes(String(p));
/** Whole đồng for a plan at a rate, rounded up to the next 1,000đ. Integer arithmetic only. */
export function planVnd(plan, period, rate) {
  const cents = PLANS[plan].usdCents[period];
  const rateCenti = Math.round(Number(rate) * 100);
  return Math.ceil((cents * rateCenti) / 10_000_000) * 1000;
}
export const unitsForPages = (pages) => Math.max(1, Math.ceil((Number(pages) || 1) / PAGES_PER_UNIT));
```

```js
// server/billing/period.js — Vietnamese time is UTC+7 all year.
export const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;
const vnParts = (date) => { const d = new Date(date.getTime() + VN_OFFSET_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), ms: d.getTime() % DAY_MS }; };
const fromVn = (y, m, d, ms) => new Date(Date.UTC(y, m, d) + ms - VN_OFFSET_MS);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** 'YYYY-MM-DD' of the Vietnamese day `date` falls in. */
export const vnDay = (date) => new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
/** The end of that Vietnamese day (the next VN midnight), for counters that expire with the day. */
export const vnDayEnd = (date) => { const p = vnParts(date); return fromVn(p.y, p.m, p.d + 1, 0); };
export const daysInVnMonth = (date) => { const p = vnParts(date); return daysIn(p.y, p.m); };
/** `start` moved `n` months on, same Vietnamese wall time, the day clamped to the month's last. */
export function addMonths(start, n) {
  const p = vnParts(start);
  const total = p.m + n;
  const y = p.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return fromVn(y, m, Math.min(p.d, daysIn(y, m)), p.ms);
}
export const periodEnd = (start, period) => addMonths(start, period === 'year' ? 12 : 1);
/** The month inside a subscription that `now` falls in, always counted from the original start. */
export function monthWindow(subStart, now) {
  let k = 0;
  while (addMonths(subStart, k + 1) <= now) k += 1;
  const start = addMonths(subStart, k);
  return { start, end: addMonths(subStart, k + 1), key: String(start.getTime()) };
}
/** Credit for the unused share of a period, rounded down to the đồng. */
export function prorate(paidVnd, start, end, now) {
  const span = end.getTime() - start.getTime();
  if (span <= 0 || now >= end) return 0;
  if (now <= start) return paidVnd;
  return Math.floor((paidVnd * (end.getTime() - now.getTime())) / span);
}
export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
```

```js
// server/billing/codes.js
import crypto from 'node:crypto';
export const CODE_PREFIX = 'SZ';
const EXACT = /^SZ\d{10}$/i;
const INSIDE = /SZ(\d{10})(?!\d)/i;
export const newPaymentCode = (randomInt = crypto.randomInt) => `${CODE_PREFIX}${String(randomInt(0, 10_000_000_000)).padStart(10, '0')}`;
/** The order code a transfer carries: SePay's parsed `code` first, else the content. Uppercase, or null. */
export function findCode(code, content) {
  if (code && EXACT.test(String(code).trim())) return String(code).trim().toUpperCase();
  const m = INSIDE.exec(String(content || ''));
  return m ? `${CODE_PREFIX}${m[1]}` : null;
}
```

```js
// server/billing/mode.js
export const MODES = ['off', 'preview', 'live'];
export function billingMode(env = process.env) {
  const v = String(env.BILLING_MODE || '').trim().toLowerCase();
  return MODES.includes(v) ? v : 'preview';
}
/** Whether this account sees billing at all. The server's word; the browser is only told. */
export function billingVisible(user, env = process.env) {
  const mode = billingMode(env);
  if (mode === 'off' || !user) return false;
  return mode === 'live' ? true : user.role === 'admin';
}
```

- [ ] **Step 1: Write the failing tests** in `test/billing-core.test.mjs` (same harness style as `test/key-pool.test.mjs`: `section`, `check`, exit code = failures):
  - `planVnd('plus','month',25655.85) === 129000`; pro month 206000; max month 385000; plus year 1463000; pro year 2335000; max year 4388000; `planVnd('plus','month',25000) === 125000` (exact thousands stay).
  - `unitsForPages(1) === 1`, `(3) === 1`, `(4) === 2`, `(10) === 4`, `(0) === 1`.
  - `paygPrices()` and `paygPrices(25656)` → `{ searchVnd: 400, sandboxVndPerMinute: 84, storageVndPerGbMonth: 1000 }`; `paygPrices(27000)` → search 430, minute 88, storage 1060; `paygPrices(24000)` → search 380, minute 78, storage 940; `paygPrices(0)` and `paygPrices(NaN)` → the anchor prices.
  - `vnDay(new Date('2026-11-12T17:30:00Z')) === '2026-11-13'`; `vnDayEnd` of that = `2026-11-13T17:00:00.000Z`.
  - `addMonths(VN 2026-01-31 10:00, 1)` = VN 2026-02-28 10:00; `(…, 2)` = VN 2026-03-31 10:00; `addMonths(VN 2028-02-29, 12)` = VN 2029-02-28.
  - `monthWindow(VN Jan 31, VN Mar 5)` → start VN Feb 28, end VN Mar 31.
  - `prorate(129000, start, start+30d, start+15d) === 64500`; at start → 129000; at end → 0.
  - codes: `newPaymentCode(() => 42)` = `'SZ0000000042'`; 1000 real codes match `/^SZ\d{10}$/` and are distinct; `findCode('sz1234567890', '')` = `'SZ1234567890'`; `findCode(null, 'MBVCB.123 SZ1234567890 chuyen tien')` = `'SZ1234567890'`; `findCode(null, 'SZ12345678901')` = null; `findCode('SZ-1', 'no code')` = null.
  - mode: unset → `preview`; `'LIVE'` → `live`; `'nonsense'` → `preview`; `billingVisible({role:'admin'})` true in preview; `{role:'user'}` false in preview, true in live; null false; anything false in off.
- [ ] **Step 2: Run** `node test/billing-core.test.mjs` — fails (modules missing).
- [ ] **Step 3: Create the four modules** with the code above (module comments in the repo's style: why each rule is what it is, with the owner's dates).
- [ ] **Step 4: Run** it — all pass. Add it to the `npm test` chain after `node test/key-pool.test.mjs`.
- [ ] **Step 5: Commit** `feat(billing): the rules — plans, periods, payment codes, mode`.

---

### Task 3: Schema 53 and the billing store

**Files:**
- Modify: `server/store/schema.sql` (insert **above** the `-- ── Schema 49` RLS block), `server/store/pg.js` (`SCHEMA_VERSION = 53`, the version list comment, store methods, `deleteUser`), `server/secretContexts.js`, `server/secretsReseal.js`, `test/schema.test.mjs` (restamp 53 + new fingerprint), `test/secrets-reseal.test.mjs`
- Test: `test/billing-store.test.mjs` (PGlite, like `test/key-pool.test.mjs` lines 59–63)

**Interfaces:**
- Consumes: `vnDay` (Task 2).
- Produces (store methods, all on `getStore()`):
  - `billingState(userId)` → `{ balanceVnd, lastTopupAt, subscription | null }` in one query.
  - `creditBalance(userId, vnd, { kind, ref = null, note = null, topup = false })` → new balance (number). Inserts the balance row if missing; `topup: true` sets `last_topup_at = NOW()`.
  - `debitBalance(userId, vnd, { kind, ref = null, note = null })` → new balance, or `null` when it does not fit (nothing changed).
  - `chargeUsage(userId, category, units, vnd, day)` → new balance or `null`; adds to the `usage` row for (user, category, day).
  - `refundUsage(userId, category, units, vnd, day)` → new balance.
  - `listBalanceEntries(userId, { kind = null, before = null, limit = 50 })`.
  - `expireBalances(now)` → `[{ userId, vnd }]` for balances whose `last_topup_at + 12 months <= now` (writes `expire` entries, zeroes them).
  - `createOrder(o)`, `getOrder(id)`, `getOrderByCode(code)`, `listOrders({ userId = null, status = null, limit = 50 })`, `addOrderReceived(id, vnd)`, `cancelOrder(id, userId)`, `expireOrders(now)` → count.
  - `payOrderFromBalance(orderId, now)` → paid order row or `null` (see SQL below).
  - `recordTransfer(t)` → row, or `null` when its `dedupe` exists; `setTransferOutcome(id, { outcome, orderId = null, userId = null })`; `getTransfer(id)`; `listTransfers({ outcome = null, limit = 50 })`.
  - `getSubscription(userId)`, `saveSubscription(row)` (upsert by user_id), `listSubscriptionsToWork(now)` → active/grace rows with `period_end <= now + 3 days`.
  - `getBillingProfile(userId)` → `{ sealed, lowBalanceVnd, lowAlertSentAt } | null`; `setBillingProfile(userId, sealed)`; `setLowBalance(userId, vnd | null)`; `markLowAlert(userId, at | null)`.
  - `createPromo({ code, creditVnd, maxUses, expiresAt, createdBy })` (`{code:'duplicate'}` error on conflict), `listPromos()`, `disablePromo(code)`, `redeemPromo(code, userId, now)` → credited đồng or `null` (one statement: the redemption, `used + 1`, and the credit).
  - `createReceipt({ userId, transferId, orderId, amountVnd, lines, buyerSealed })` → `{ number }` formatted `SZR-<VN year>-<6-digit seq>`; `getReceipt(number)`; `listReceipts(userId)`.
  - `saveEinvoice(row)`, `getEinvoice(orderId)`, `listEinvoicesPending()`.
  - `storageBytesByUser(userIds)` → `Map<userId, bytes>` (attachments + attachment_versions).
  - `billingAdminFigures(since)` → money in by kind, balances held, counts, and `databaseBytes` (`pg_database_size`) (Task 7 renders it).
  - `serviceKeyContext` sibling: `billingProfileContext(userId)` → `['billing-profile', userId]` in `server/secretContexts.js`, `'billing-profile'` in `SECRET_KINDS`; a reseal source for `billing_profiles.sealed` in `server/secretsReseal.js`.

Schema (copy verbatim; comment each table in the file's style):

```sql
-- ── Schema 53: billing (spec B1) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_profiles (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sealed           TEXT,
  low_balance_vnd  BIGINT CHECK (low_balance_vnd IS NULL OR low_balance_vnd >= 0),
  low_alert_sent_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS balances (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vnd           BIGINT NOT NULL DEFAULT 0 CHECK (vnd >= 0),
  last_topup_at TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS balance_entries (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('topup','plan','usage','promo','assign','expire','forfeit','adjust')),
  category   TEXT,
  day        DATE,
  units      BIGINT NOT NULL DEFAULT 0,
  delta_vnd  BIGINT NOT NULL,
  ref        TEXT,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS balance_entries_usage_day ON balance_entries (user_id, category, day) WHERE kind = 'usage';
CREATE INDEX IF NOT EXISTS balance_entries_user_idx ON balance_entries (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS billing_orders (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('plan','renewal','topup')),
  plan         TEXT,
  period       TEXT CHECK (period IS NULL OR period IN ('month','year')),
  code         TEXT NOT NULL UNIQUE,
  usd_cents    INTEGER,
  rate         NUMERIC(12,4),
  rate_source  TEXT,
  price_vnd    BIGINT NOT NULL CHECK (price_vnd >= 0),
  credit_vnd   BIGINT NOT NULL DEFAULT 0 CHECK (credit_vnd >= 0),
  total_vnd    BIGINT NOT NULL CHECK (total_vnd >= 0),
  use_balance  BOOLEAN NOT NULL DEFAULT TRUE,
  received_vnd BIGINT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','cancelled')),
  expires_at   TIMESTAMPTZ NOT NULL,
  paid_at      TIMESTAMPTZ,
  simulated    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS billing_orders_user_idx ON billing_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_orders_pending_idx ON billing_orders (expires_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS sepay_transfers (
  id             BIGSERIAL PRIMARY KEY,
  dedupe         TEXT NOT NULL UNIQUE,
  sepay_id       TEXT,
  reference_code TEXT,
  gateway        TEXT,
  account_number TEXT,
  amount_vnd     BIGINT NOT NULL,
  code           TEXT,
  content        TEXT,
  transaction_at TIMESTAMPTZ,
  order_id       TEXT REFERENCES billing_orders(id) ON DELETE SET NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('applied','short','over','late','topup','unmatched','assigned','dismissed','ignored')),
  via            TEXT NOT NULL CHECK (via IN ('webhook','poll','simulated')),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sepay_transfers_outcome_idx ON sepay_transfers (outcome, received_at DESC);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan          TEXT NOT NULL,
  period        TEXT NOT NULL CHECK (period IN ('month','year')),
  status        TEXT NOT NULL CHECK (status IN ('active','grace','ended')),
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  paid_vnd      BIGINT NOT NULL DEFAULT 0,
  auto_renew    BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_at_end BOOLEAN NOT NULL DEFAULT FALSE,
  next_plan     TEXT,
  next_period   TEXT,
  reminded_at   TIMESTAMPTZ,
  renewal_order TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS promo_codes (
  code        TEXT PRIMARY KEY,
  credit_vnd  BIGINT NOT NULL CHECK (credit_vnd > 0),
  max_uses    INTEGER NOT NULL CHECK (max_uses > 0),
  used        INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  code       TEXT NOT NULL REFERENCES promo_codes(code) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code, user_id)
);
CREATE SEQUENCE IF NOT EXISTS receipt_seq;
CREATE TABLE IF NOT EXISTS receipts (
  number       TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  transfer_id  BIGINT REFERENCES sepay_transfers(id) ON DELETE SET NULL,
  order_id     TEXT,
  amount_vnd   BIGINT NOT NULL,
  lines        JSONB NOT NULL,
  buyer_sealed TEXT,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS receipts_user_idx ON receipts (user_id, issued_at DESC);
CREATE TABLE IF NOT EXISTS einvoices (
  order_id       TEXT PRIMARY KEY,
  reference_code TEXT NOT NULL UNIQUE,
  tracking_code  TEXT,
  status         TEXT NOT NULL,
  error          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The atomic statements (the rest follow the same shape):

```sql
-- debitBalance($1 user, $2 vnd, $3 kind, $4 ref, $5 note): nothing happens unless it fits.
WITH d AS (
  UPDATE balances SET vnd = vnd - $2, updated_at = NOW()
   WHERE user_id = $1 AND vnd >= $2
  RETURNING vnd
), e AS (
  INSERT INTO balance_entries (user_id, kind, delta_vnd, ref, note)
  SELECT $1, $3, -$2, $4, $5 FROM d
)
SELECT vnd FROM d;

-- chargeUsage($1 user, $2 category, $3 units, $4 vnd, $5 day)
WITH d AS (
  UPDATE balances SET vnd = vnd - $4, updated_at = NOW()
   WHERE user_id = $1 AND vnd >= $4
  RETURNING vnd
), e AS (
  INSERT INTO balance_entries (user_id, kind, category, day, units, delta_vnd)
  SELECT $1, 'usage', $2, $5::date, $3, -$4 FROM d
  ON CONFLICT (user_id, category, day) WHERE kind = 'usage'
  DO UPDATE SET units = balance_entries.units + EXCLUDED.units, delta_vnd = balance_entries.delta_vnd + EXCLUDED.delta_vnd
)
SELECT vnd FROM d;

-- payOrderFromBalance($1 order id, $2 now): the order is paid and the balance pays it, or neither.
WITH o AS (
  SELECT id, user_id, total_vnd FROM billing_orders
   WHERE id = $1 AND status = 'pending' AND expires_at > $2
     AND (use_balance OR received_vnd >= total_vnd)
   FOR UPDATE
), d AS (
  UPDATE balances b SET vnd = b.vnd - o.total_vnd, updated_at = NOW()
    FROM o WHERE b.user_id = o.user_id AND b.vnd >= o.total_vnd
  RETURNING b.user_id
), p AS (
  UPDATE billing_orders SET status = 'paid', paid_at = $2
   WHERE id IN (SELECT o.id FROM o JOIN d ON d.user_id = o.user_id)
  RETURNING *
), e AS (
  INSERT INTO balance_entries (user_id, kind, delta_vnd, ref)
  SELECT p.user_id, 'plan', -p.total_vnd, p.id FROM p
)
SELECT * FROM p;
```

(A `total_vnd` of 0 — a downgrade-free switch fully covered by credit — passes with `vnd >= 0`; the balance row must exist, so `payOrderFromBalance` first does `INSERT INTO balances (user_id) VALUES ($user) ON CONFLICT DO NOTHING` in the same CTE chain or a preceding statement that is harmless to repeat.)

`deleteUser(id)` gains, **before** the `DELETE FROM users`: one statement that writes a `forfeit` entry for any positive balance (`delta_vnd = -vnd`, `note = 'account deleted'`), and `UPDATE receipts SET buyer_sealed = NULL WHERE user_id = $1`. Everything else is the foreign keys' work.

- [ ] **Step 1: Write failing tests** in `test/billing-store.test.mjs`: schema applies; RLS is on for every new table (`pg_tables.rowsecurity`); credit then debit; a debit larger than the balance returns null and leaves balance and entries unchanged; 20 concurrent `debitBalance(…, 400)` against 4,000đ → exactly 10 succeed, balance 0, never negative; `chargeUsage` twice on a day → one `usage` row with units 2 and −800; `refundUsage` takes it back; `payOrderFromBalance` on an expired order → null; on `use_balance=false` with `received_vnd < total` → null even with a big balance; on a good order → paid, one `plan` entry, balance down by `total_vnd`; the same call again → null (paid once); `recordTransfer` twice with the same `dedupe` → second null; `redeemPromo` once per account, never past `max_uses` (11 accounts on a 10-use code → 10 credited), never after `expires_at` or when inactive; receipt numbers `SZR-2026-000001`, `…002`; `expireBalances` only past 12 months; `deleteUser` → forfeit entry with `user_id` NULL afterwards, orders/transfers/receipts kept with `user_id` NULL and `buyer_sealed` NULL; `storageBytesByUser` sums attachments and versions per user. Balance sum invariant: after the whole suite, for every user, `balances.vnd = SUM(balance_entries.delta_vnd)`.
- [ ] **Step 2: Run** `node test/billing-store.test.mjs` — fails.
- [ ] **Step 3: Implement** the schema, `SCHEMA_VERSION = 53` with a line `53  billing — balances, orders, transfers, subscriptions, promo codes, receipts, e-invoices (spec B1)` in the version list, the store methods, the context and reseal source.
- [ ] **Step 4: Run** `node test/billing-store.test.mjs`, `node test/schema.test.mjs` (restamp `STAMPED = { version: 53, fingerprint: '<new>' }` from its own failure message), `node test/database.test.mjs`, `node test/secrets-reseal.test.mjs` — all pass.
- [ ] **Step 5: Commit** `feat(billing): schema 53 — the balance, orders, transfers and receipts, each money change one statement`.

---

### Task 4: The rate, orders and subscriptions

> **Carried from Task 3 review (2026-11-13):** every credit of real money (a transfer, an owner's assignment) passes `topup: true` (it starts the 12-month clock); crediting a transfer and paying its order are separate statements, so after a credit always call `tryApply` again — a usage charge landing in between must never leave a covered order unpaid; never pay a bank-paid order by any path but `payOrderFromBalance` (the transfer was credited to the balance first).

**Files:**
- Create: `server/billing/fx.js`, `server/billing/orders.js`, `server/billing/subscriptions.js`
- Test: `test/billing-flow.test.mjs` (PGlite; `fetch` answered in the test as `test/key-pool.test.mjs` does)

**Interfaces:**
- Consumes: Task 2 rules; Task 3 store methods; `fromSource(source, 'USD', ['VND'])` from `server/finance/sources/fx.js` (Vietcombank returns rows with `kind` `bank-cash` / `bank-transfer` / `bank-sell`: take `bank-transfer`).
- Produces:
  - `fx.js`: `export class BillingUnavailable extends Error {}`; `export async function usdVnd({ now = new Date() } = {})` → `{ rate: number, source: 'erapi'|'vietcombank'|'frankfurter', at: string /* ISO */ }`; `export async function meteringRate()` → the last known rate of any age (memory, then the `billing_fx` setting), else `PAYG_ANCHOR_RATE` — never throws, never fetches (metering must not wait on a rate source); `export const RATE_ATTRIBUTION = 'Rates By Exchange Rate API: https://www.exchangerate-api.com'`; `export function _resetFxForTests()`.
  - `orders.js`:
    - `quote(userId, { plan, period }, { now })` → `{ kind: 'new'|'upgrade'|'later', plan, period, priceVnd, creditVnd, totalVnd, rate, rateSource, rateAt, balanceVnd, startsAt /* ISO */ }` — `later` for a downgrade or year→month (nothing charged now; the change is scheduled by `PUT /api/billing/subscription` in Task 7 via `scheduleChange`).
    - `createOrder(userId, { kind, plan, period, amountVnd, useBalance = true }, { now, simulated = false })` → `{ order, paidNow: boolean, due: { vnd, qr } | null }`; `kind` `plan` | `topup` | `renewal`. Validates plan/period with `isPlan`/`isPeriod`, a top-up amount against `TOPUP` and the account's plan (Global Constraints), an integer amount; errors carry `{ status: 422 }`.
    - `dueOf(order, balanceVnd)` → đồng still to transfer: `use_balance ? max(0, total − balance) : max(0, total − received)`.
    - `tryApply(orderId, { now })` → the subscription it started/changed, or null; calls `payOrderFromBalance`, then `activate` for `plan`/`renewal`.
    - `qrFor(order, dueVnd, env = process.env)` → `{ image, bank, account, holder, amount, content }`; image = `https://qr.sepay.vn/img?acc=${enc(SEPAY_BANK_ACCOUNT)}&bank=${enc(SEPAY_BANK_CODE)}&amount=${dueVnd}&des=${order.code}`; `BillingUnavailable` when the bank variables are unset.
  - `subscriptions.js`:
    - `activate(order, { now })` — new plan or upgrade: `period_start = now`, `period_end = periodEnd(now, period)`, `paid_vnd = order.price_vnd − order.credit_vnd`, `status 'active'`, `cancel_at_end false`, clears `next_*`; renewal: `period_start = old period_end`, `period_end = periodEnd(old period_end, next_period ?? period)`, plan = `next_plan ?? plan`, `reminded_at = null`.
    - `scheduleChange(userId, { plan, period })`, `setAutoRenew(userId, on)`, `setCancelAtEnd(userId, on)`.
    - `catchUp(userId, { now })` → the subscription in force after lazily doing what is due for this account: at/after `period_end` → if `cancel_at_end` → `ended`; else if `auto_renew` and the balance covers the renewal at today's rate → create and pay a `renewal` order from the balance → `activate`; else `grace`; past `period_end + 3 days` unpaid → `ended`.
    - `planInForce(userId, { now })` → `{ plan: 'free'|…, period, status, start, end, month: monthWindow(...) }` (grace counts as in force; `ended`/none → free).
    - `remindersDue(now)` → subscriptions whose `period_end − 3 days <= now`, `reminded_at` null, `auto_renew` and balance short: create a `renewal` order with `expires_at = period_end + 3 days` and return `[{ userId, order }]` for Task 7's mail.

- [ ] **Step 1: Write failing tests** (`test/billing-flow.test.mjs`, section "rate, orders, subscriptions"): rate from erapi; erapi down → Vietcombank `bank-transfer`; both down → frankfurter; all down with a 47-hour-old `billing_fx` setting → that rate; 49 hours → `BillingUnavailable`; second call within the hour asks nothing. Quote new Plus at 25655.85 → 129,000; upgrade Plus→Pro half way through a 129,000đ month → credit 64,500, total 141,500; Pro→Plus → `later`, total 0; month→year same plan → upgrade. Order with a covering balance → `paidNow`, subscription active, balance down; without → `due.vnd` = total − balance and a QR whose `des` is the code; `useBalance:false` → due = total. Top-up below 50,000 (no plan) → 422; one that would pass 200,000 → 422; 100,000 with a plan and 950,000 balance → 422 (past 1,000,000). `catchUp`: renewal from balance at period end; short balance → grace, dates unchanged; paying during grace → next period starts at the old end; past 3 days → ended, plan free; `cancel_at_end` → ended at end, no charge. `remindersDue` makes one renewal order per subscription (twice → still one).
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** `node test/billing-flow.test.mjs` and `node test/billing-store.test.mjs` — pass. Add `billing-flow` to the `npm test` chain.
- [ ] **Step 5: Commit** `feat(billing): the day's rate, quotes, orders and the plan's life`.

---

### Task 5: SePay — the webhook, matching, reconciling, simulating

> **Carried from Task 3 review:** `takeTransfer` credits with `topup: true`; the receipt's `buyer_sealed` is sealed with `billingProfileContext(userId)` (secretsReseal already reseals it); `receipts.lines` never carry buyer details; after crediting, `tryApply` again (see Task 4).

**Files:**
- Create: `server/billing/sepay.js`
- Modify: `server/app.js` (mount the webhook with the outside hooks, before `express.json`)
- Test: `test/billing-flow.test.mjs` (section "transfers"), `test/http.test.mjs` (the mount)

**Interfaces:**
- Consumes: `findCode` (2); `recordTransfer`, `setTransferOutcome`, `getOrderByCode`, `addOrderReceived`, `creditBalance` (3); `tryApply`, `dueOf` (4); `billingMode` (2).
- Produces:
  - `verifySepay({ raw, headers, secret, now = Date.now() })` → `true | false` (never throws: missing header, wrong prefix, wrong length, bad hex, stale timestamp → false; `crypto.timingSafeEqual` only on equal-length buffers).
  - `acceptSepay({ raw, headers, now })` → `{ status, body }`: `404` when mode `off` or the secret is unset; `401` unverified; `400` when the body is not a JSON object with numeric `transferAmount`; otherwise `takeTransfer(payload, { via: 'webhook' })` and `{ status: 200, body: { success: true } }` — any thrown error is `{ status: 500, body: { success: false } }`.
  - `takeTransfer(payload, { via, now })` → `{ outcome, transferId, orderId }` — dedupe, ignore (`transferType !== 'in'` or wrong account), find the code, credit and apply per spec "Matching" (pending → `applied` if it paid the order, else `short`; `over` when after applying the order more than its due arrived; expired/cancelled → `late`; `topup` order → `topup` and the order marked paid with what arrived; none → `unmatched`). Every credited transfer gets a receipt row (Task 8 draws it; here only `createReceipt` with `lines` and the sealed buyer snapshot from `getBillingProfile`), except `simulated`.
  - `reconcile({ since, orderId = null, now })` → count taken; asks `GET https://userapi.sepay.vn/v2/transactions` with `Authorization: Bearer ${SEPAY_API_TOKEN}`, only rows with a reference number (dedupe `ref:`), `via 'poll'`; throttled (Global Constraints). No token → 0, nothing asked.
  - `simulateTransfer(orderId, { now })` → as `takeTransfer` with `via 'simulated'`, the order's due amount and its code; refused (`{status:409}`) unless mode is `preview`.
  - In `server/app.js`, beside `/api/hooks/telegram/:secret`:
    ```js
    app.post('/api/billing/sepay', express.raw({ type: () => true, limit: '256kb' }), outside(async (req, res) => {
      const answer = await acceptSepay({ raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), headers: req.headers });
      res.status(answer.status).json(answer.body);
    }));
    ```

- [ ] **Step 1: Write failing tests**: verification (good; missing signature; missing timestamp; `sha1=`; one hex char short; one bit wrong; 301 s old; 301 s ahead); exact `{"success": true}` body on success; a repeat (same `referenceCode`) answers success and credits once; `transferType:'out'` → ignored, no credit; another account number → ignored; exact amount → applied, plan active; short → balance up, order pending, `dueOf` the rest, a second transfer with the same code → applied; over → applied, the rest in the balance; late (order expired) → `late`, balance up, no plan; no code → `unmatched`, nothing credited; a store failure mid-way → 500 and nothing half-written; `reconcile` takes a poll row with a reference the webhook later repeats → credited once; `simulateTransfer` in preview works and is `simulated`, in live → 409. In `test/http.test.mjs`: `POST /api/billing/sepay` with a JSON content-type reaches the handler with raw bytes (signature over the exact bytes verifies) and mode `off` → 404.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/billing-flow.test.mjs`, `node test/http.test.mjs` — pass.
- [ ] **Step 5: Commit** `feat(billing): SePay transfers — checked, taken once, matched to their order or kept for the owner`.

---

### Task 6: Metering — searches, the cloud computer, storage

> **Carried from Task 3 review:** a refund (`refundUsage`) passes the **charge's own** VN day, never a day recomputed at refund time (after VN midnight it would land on the next day's row).

**Files:**
- Create: `server/billing/meter.js`
- Modify: `server/search.js` (`billed` option, `metered` in the result), `server/tools/cloud.js` (`webSearch`, `fetchedThroughExa`, `fetchedThroughFirecrawl`, `sitePagesTool`, the `code_context` entry), `server/tools/codeContext.js` (`onCharge`), `server/research/gather.js:363`, `server/e2b.js` (`payUntil`, `giveBack`)
- Test: `test/billing-meter.test.mjs`; the existing `test/search.test.mjs`, `test/webfetch.test.mjs`, `test/firecrawl.test.mjs`, `test/research.test.mjs`, `test/e2b.test.mjs` must stay green unchanged for non-billable accounts

**Interfaces:**
- Consumes: plans/period/mode (2); `billingState`, `chargeUsage`, `refundUsage`, `storageBytesByUser`, store counters `addToCounter(bucket, amount, expiresAt)` / `readCounter(bucket)` (3); `planInForce`, `catchUp` (4); `getStore().getUserById(id)` for the role.
- Produces:
  ```js
  /** @typedef {{ billed: boolean, source: 'included'|'balance'|'none'|null, paid: boolean, refused: boolean, units: number, settle: (actual: number) => Promise<void>, release: () => Promise<void> }} Hold */
  export async function isBillable(userId, { now }) // admin in preview (any signed-in in live) with a plan in force or balance > 0; cached per instance 30 s
  export async function holdSearch(userId, { units = 1, now = new Date() } = {}) // → Hold
  export async function holdSandbox(userId, seconds, { now = new Date() } = {}) // → Hold
  export async function chargeStorageDay({ now = new Date() } = {}) // → { charged: number, would: number }
  export async function periodUsage(userId, { now = new Date() } = {}) // the Billing tab's "This period"
  export const NOT_BILLED // { billed:false, source:null, paid:false, refused:false, units:0, settle: async()=>{}, release: async()=>{} }
  ```
  Counter buckets (expire at the window's end + 1 day): `bill:search:<user>:<month.key>`, `bill:sandbox:<user>:<month.key>` (seconds), `bill:sandbox-paid:<user>:<month.key>` (seconds paid from the balance), `bill:would:<user>:<search|sandbox|storage>:<vnDay>`. No per-day allowance counters (Global Constraints: no daily limits).

Rules:
- **Prices** come from `paygPrices(await meteringRate())` (Task 2, Task 4) at the moment of each hold — never a hard-coded 400/84/1000.
- **holdSearch:** not billable → `NOT_BILLED`. Else, all `units` from one source: included when the month counter + units ≤ `searches` (add, roll back if over); else balance `chargeUsage(user,'search',units,units*searchVnd,vnDay)`; else `none`: preview → `paid:false, refused:false`, `bill:would:…:search` += units; live → `refused:true`. `paid = source in (included, balance)`. `settle(actual)`: `0` → release all; less → give back the difference on the same source; more → hold the extra with the same rules (preview never refuses; a failed extra in live is not charged and logged). `release()` = `settle(0)`; both idempotent.
- **holdSandbox(seconds):** included when the month's second-counter fits `sandboxMinutes*60`; else balance: add seconds to `bill:sandbox-paid`, charge `(ceil(after/60) − ceil(before/60)) × sandboxVndPerMinute` đ with units = that minute delta (roll back the counter if `chargeUsage` returns null); else `none` as for search. Release reverses exactly what was taken.
- **Callers** (keep today's code path untouched when `!hold.billed`):
  - `server/search.js` `search(query, { …, billed = false })`: when `billed`, `ask.mayMeter = true` and `countMetered` is skipped; the result gains `metered: answered.some(a => ENGINES[chain[a.at]].metered)`; a cache hit returns `metered: false`.
  - `webSearch`: `const hold = await holdSearch(userId)`; `hold.refused` → behave as `mayMeter === false` today; `search(…, { paid: hold.paid, billed: hold.billed && !hold.refused && hold.source !== 'none' })`; `finally hold.settle(found?.metered ? 1 : 0)`.
  - `fetchedThroughExa`: hold 1, `readThroughExa(url, { maxChars, paid: hold.paid })`, settle `read ? 1 : 0`.
  - `fetchedThroughFirecrawl`: hold 1 (skip `mayMeter`/`countMetered` when billed with a source), `firecrawlScrape(url, { signal, paid: hold.paid })`, settle `read ? unitsForPages(read.pages || 1) : 0`.
  - `sitePagesTool`: map → hold 1, settle `1` after Firecrawl answered (even with no links), `0` on a throw; crawl → hold 1, settle `pages.length ? unitsForPages(pages.length) : 0`; billed holds skip `mayMeter`/`countMetered`; pass `paid: hold.paid`.
  - `code_context`: hold 1; `codeContextTool(input, { …, paid: hold.paid, billed, onCharge: (n) => { charged = Math.max(charged, n); } })`; inside, `onCharge(1)` once when Exa or Firecrawl's developer index returned rows or the web-search fallback came back `metered`; settle `charged`.
  - `server/research/gather.js`: each query's `search(query, { userId })` becomes hold → `search(query, { userId, paid, billed })` → settle(`out?.metered ? 1 : 0`) when `search` is the default one (a test-injected `search` is left alone).
  - `server/e2b.js` `payUntil(record, until, userId, { paid })`: when `userId`, `hold = await holdSandbox(userId, Math.ceil((until - from) / 1000))`; `hold.refused` → `throw new E2BOutOfCredit()`; a billed hold with a source sets `paid = paid || hold.paid` and skips the per-account free share (`shared`); the returned receipt carries `hold`; `giveBack` calls `receipt.hold?.release()`.
- **Storage room (Task 1c):** a billable account holding a paid plan is not limited by `assertRoom`'s 0.5 GB — its plan's GB apply, and past them it is charged below (preview never refuses). Extend `storageOf`/`assertRoom` accordingly.
- **Storage:** `chargeStorageDay` — for billable accounts only: `overTenths = max(0, ceil(bytes / 1e8) − storageGb × 10)`; `vnd = ceil(overTenths × storageVndPerGbMonth / 10 / daysInVnMonth(now))`; `chargeUsage(user,'storage',overTenths,vnd,vnDay)`; null → `bill:would:…:storage` += overTenths. Run once per VN day (Task 7 claims it).
- **periodUsage:** `{ plan, month: {start,end}, search: { included, used, paidUnits, paidVnd }, sandbox: { includedSeconds, usedSeconds, paidMinutes, paidVnd }, storage: { bytes, includedGb, paidVnd }, would: { search, sandbox, storage }, finance: { free: true } }` — paid figures from this month's `usage` entries.

- [ ] **Step 1: Write failing tests** (`test/billing-meter.test.mjs`, PGlite, a fake clock): a non-admin → `NOT_BILLED`, nothing written; an admin with nothing → `NOT_BILLED`; an admin with Plus → included for all 150 of the month even when used in one day (no daily limit), then balance 400đ each, then (balance 0) `none` with `paid:false` and a would-count, never refused in preview; `settle(0)` gives the included unit back (counter down) and a balance unit back (balance up, usage row down); a crawl hold of 1 settled with 10 pages → 4 units; month rollover on the plan's own day resets included; 20 concurrent holds with 4,000đ and no plan → exactly 10 balance holds; sandbox: 59 s then 2 s from the balance → 84đ then 84đ (two started minutes), 30 s + 30 s → 84đ total; release reverses; storage: 3.25 GB on Plus in a 30-day month → 3 tenths over → `ceil(300/30)` = 10đ; `periodUsage` shape. Search integration with a fake engine: a metered answer settles 1; a DuckDuckGo-only answer settles 0; the same query again (cache) settles 0; `billed` skips `countMetered`. E2B: a billable admin's window is held and `giveBack` releases it.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** `meter.js`, then the callers one by one, running that caller's existing suite after each.
- [ ] **Step 4: Run** `node test/billing-meter.test.mjs` and `node test/search.test.mjs`, `node test/webfetch.test.mjs`, `node test/firecrawl.test.mjs`, `node test/research.test.mjs`, `node test/e2b.test.mjs`, `node test/agent.test.mjs`, `node test/key-pool.test.mjs` — all pass. Add `billing-meter` to the chain.
- [ ] **Step 5: Commit** `feat(billing): searches, machine minutes and storage held, kept or given back — administrators only`.

---

### Task 7: Routes, promo codes, emails, the daily work, deletion and export

> **Carried from Task 4–5 reviews:** the owner's **assign** of an unmatched transfer requires `credited_at IS NULL` in the same statement (a second wall against crediting the same money twice); the daily job resumes `sepay_transfers` rows still `taking` after a few minutes (`takeTransfer` on the stored row); simulated money stays out of every figure **and** out of the 12-month clock — an order paid by a simulated transfer is not flagged `simulated`, so join on `sepay_transfers.via` (or have `simulateTransfer` refuse an order that already holds a real transfer); a `late` outcome sends the `late-money` mail (hook it where `takeTransfer` returns); in grace, buying the same plan and period is routed to a renewal; a subscription row is never deleted (its basis would collide with the first purchase).

> **Carried from Task 3 review:** `getReceipt`, `getOrder` and `listOrders({ userId })` are unscoped store methods — every user-facing route checks the row's `user_id` against the caller (receipt numbers are sequential and guessable: an unscoped route is an IDOR), and never calls `listOrders` with an undefined `userId`; `billingAdminFigures` must leave simulated money out of every figure (ledger entries carry no simulated flag — join on the order/transfer `simulated`/`via`).

**Files:**
- Create: `server/routes/billing.js`, `server/billing/promo.js`, `server/billing/mail.js`, `server/billing/daily.js`
- Modify: `server/app.js` (mount; `publicUser` gains `billing: { visible: billingVisible(user) }`; `runHeartbeat` calls `billingTick`), `server/adminRoles.js` (`'billing'` appended to `ADMIN_PERMISSIONS`), `server/audit.js` (kinds), `server/ratelimit.js` (`'billing-order': { limit: 10, windowMs: 3_600_000 }`, `'billing-promo': { limit: 10, windowMs: 3_600_000 }`), `server/routes/account.js` (export gains `billing`), `server/i18n/vi.js`
- Test: `test/billing-routes.test.mjs`, `test/http.test.mjs` (gating), `test/email.test.mjs` or `test/mail-template.test.mjs` (the billing mails render in both languages)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `mountBillingRoutes(api, admin, { wrap })` — every route in the spec's Routes table. A `gate` middleware first: mode `off` → 404; `!billingVisible(req.user)` → 404. Each user route calls `catchUp(req.user.id)` first. Admin routes use `requirePermission('billing')` (and `requireOwner` for `/simulate`). Response shapes:
    - `GET /api/billing` → `{ mode, plan: planInForce + { autoRenew, cancelAtEnd, nextPlan, nextPeriod, priceVnd }, balance: { vnd, expiresAt }, usage: periodUsage, profile: { name, email, country, address, taxCode } | null, alerts: { lowBalanceVnd }, bounds: TOPUP }`
    - `GET /api/billing/plans` → `{ plans: [{ id, usdCents, vnd: { month, year }, searches, sandboxMinutes, storageGb }], payg: PAYG, rate: { rate, source, at, attribution }, current: { plan, period } }`; `rate: null` and `vnd: null` when `BillingUnavailable`.
    - `POST /api/billing/orders` → `{ order: { id, kind, plan, period, code, totalVnd, status, expiresAt }, paidNow, due: { vnd, qr: { image, bank, account, holder, amount, content } } | null }`.
    - `GET /api/billing/orders/:id` → `{ status, receivedVnd, dueVnd, plan }` (404 when not the caller's).
    - `PUT /api/billing/subscription` body any of `{ autoRenew: boolean, cancelAtEnd: boolean, nextPlan, nextPeriod }` — `nextPlan`/`nextPeriod` only for a change that `quote` calls `later` (a downgrade or year→month), else `422`; `nextPlan: null` withdraws a scheduled change.
    - `POST /api/admin/billing/transfers/:id/assign` body `{ email }` → credits that account (`creditBalance` kind `assign`, `topup: true`), outcome `assigned`, a receipt; `…/dismiss` → outcome `dismissed`, nothing credited. Both only for an `unmatched` transfer (else `409`).
    - `PUT /api/billing/profile` body `{ name (1–120), email (valid, ≤ 254), country (ISO-2), address (≤ 300, optional), taxCode (digits and '-', ≤ 20, optional) }` → sealed with `billingProfileContext`; `400` on anything else.
  - `promo.js`: `createPromo({ code, creditVnd, maxUses, expiresAt }, by)` (code `/^[A-Z0-9]{8,32}$/` after uppercasing; credit 1,000–1,000,000đ; uses 1–10,000), `redeem(userId, code)` → credited đồng or throws `{ status: 400, message: 'That code did not work.' }` (same message for every failure).
  - `mail.js`: `sendBillingMail(kind, user, data)` for kinds `paid`, `plan-changed`, `renewal-soon`, `renewed`, `grace`, `ended`, `low-balance`, `expiring`, `late-money`; built with `layoutEmail` (no gradient behind white text — memory `mail-rendering-rules`), language from `mailLanguage(user)`; the receipt linked by URL, not attached.
  - `daily.js`: `billingTick({ now })` — every heartbeat: `expireOrders`, `remindersDue` → `renewal-soon` mails, `catchUp` for `listSubscriptionsToWork`; once per VN day (claim with `addToCounter('bill:daily:<vnDay>', 1, vnDayEnd(now)) === 1`): `chargeStorageDay`, `expireBalances` (+ `expiring` mails 30 days ahead), `reconcile({ since: now − 3 days })`, e-invoice status (Task 8 fills the hook), low-balance alerts. Returns counts; failures logged, never thrown into the heartbeat.
  - Audit kinds appended: `'billing_order_paid', 'billing_transfer_assigned', 'billing_transfer_dismissed', 'billing_promo_created', 'billing_promo_disabled', 'billing_simulated', 'billing_profile_updated'`.
  - Export: `billing: { profile, orders, entries, receipts }` (receipts as numbers, dates, amounts).
  - `GET /api/admin/billing` includes `capacity: { machines: { running | null, limit }, database: { bytes, includedBytes } }` — `running` from `GET https://api.e2b.app/v2/sandboxes` (state running, paged) with `E2B_API_KEY`, cached 60 s, `null` on any failure; `limit` = `E2B_CONCURRENT_LIMIT` (20); `includedBytes` = `DATABASE_INCLUDED_GB` (8) × 1e9. The key never leaves the server.

- [ ] **Step 1: Write failing tests** (`test/billing-routes.test.mjs`, the app booted as `test/http.test.mjs` boots it): every route → 404 for a member in preview and for everyone in off; an admin gets 200; `GET /api/billing/plans` with the rate unavailable → plans with `vnd: null`; orders rate-limited at 11; another admin's order → 404; profile validation (bad email, 121-char name, `country:'Vietnam'`) → 400, good → 200 and the stored value is sealed (not plain text in `billing_profiles.sealed`); promo: wrong code and used code and expired code give the same 400 body; admin routes need `billing` (an admin without it → 403), simulate needs the owner and preview; `publicUser().billing.visible` true for an admin in preview, false for a member; `billingTick` twice in one VN day runs the daily part once; export contains `billing`. Mails render in vi and en with no `undefined`/`NaN` and no gradient behind white text.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/billing-routes.test.mjs`, `node test/http.test.mjs`, `node test/server-i18n.test.mjs`, `node test/email.test.mjs`, `node test/mail-template.test.mjs`, `node test/data-rights.test.mjs` — pass. Add `billing-routes` to the chain.
- [ ] **Step 5: Commit** `feat(billing): the routes, promo codes, the mails and the day's work — administrators only`.

---

### Task 8: Receipts and e-invoices (off)

> **Carried from Task 5 review:** a receipt for a `late` transfer must not describe a purchase — the lines say money added to the balance (pass the transfer outcome into the lines, or join the transfer when drawing).

**Files:**
- Create: `server/billing/receipt.js`, `server/billing/einvoice.js`
- Modify: `server/routes/billing.js` (the two `.pdf` routes), `server/billing/daily.js` (e-invoice status), `server/billing/sepay.js` or `orders.js` (issue an e-invoice after a paid order when on)
- Test: `test/billing-docs.test.mjs`

**Interfaces:**
- Consumes: `getReceipt`, `saveEinvoice`, `getEinvoice`, `listEinvoicesPending` (3); `openSecret(buyer_sealed, billingProfileContext(userId))`.
- Produces:
  - `drawReceipt(receipt, { language, seller = process.env.BILLING_SELLER_NAME || 'Synapsez' })` → `Buffer` (a PDF): A4 (595×842 pt) via `new PDFDocument({ title, producer: seller })`, Arimo registered from `server/assets/fonts/Arimo-VariableWeight.ttf` with `GlobalFonts.register`; seller, "Payment receipt" / "Biên nhận thanh toán", number, VN date and time, buyer (when not erased), each line, total, reference, "Bank transfer via SePay (VietQR)", and the line "Payment receipt — not a VAT invoice." / "Biên nhận thanh toán — không phải hoá đơn GTGT.". No tax line unless `BILLING_TAX_RATE` is a number.
  - `einvoiceEnabled(env)` → true only with `SEPAY_EINVOICE_CLIENT_ID`, `SEPAY_EINVOICE_CLIENT_SECRET` and `SEPAY_EINVOICE_TEMPLATE` set (and `SEPAY_EINVOICE_SANDBOX=1` for the sandbox host).
  - `issueEinvoice(order, buyer, { now, fetchImpl })` — `POST /v1/token` (Basic) → JWT cached until 5 minutes before its 24 h; `POST` the invoice with `reference_code = order.id`, `issued_date` = `vnDay(now)`; a `409` means it exists → fetch status; a network error or 5xx with no `error.code` → status `unknown` and **never sent again** (only status checks); `422 REGISTRATION_NOT_TAX_APPROVED` → `error` stored, plain message to the owner.
  - `einvoiceStatus(orderId)`, `einvoicePdf(orderId)` → `Buffer` via `GET /v1/invoices/{tracking_code}/download` (base64).
  - Routes: `GET /api/billing/receipts/:number.pdf` and `GET /api/billing/invoices/:id.pdf` → `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="<number>.pdf"`, 404 unless it is the caller's.

- [ ] **Step 1: Write failing tests**: the PDF starts with `%PDF-`, and its text read back through pdfjs (`server/pdf.js`'s reader) contains the number, "Biên nhận thanh toán — không phải hoá đơn GTGT." with its diacritics intact, the amount formatted `129.000 ₫` in vi; with the buyer erased it says the buyer was removed and still renders; e-invoice client against recorded answers (token, create 200, create 409 → status, 500 with `error.code` → stored error, a thrown network error → `unknown` and a second `issueEinvoice` sends nothing), `issued_date` is the VN day at 00:30 VN; `einvoiceEnabled` false without all three variables; routes 404 for someone else's receipt.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/billing-docs.test.mjs`, `node test/billing-routes.test.mjs` — pass. Add `billing-docs` to the chain.
- [ ] **Step 5: Commit** `feat(billing): receipts as PDFs; SePay e-invoices built and left off`.

---

### Task 9: The menu row, the plan line, the plans sheet and checkout

**Files:**
- Create: `public/js/billing-format.js`, `public/js/billing-plans.js`
- Modify: `public/js/account-menu.js` (row `upgrade` right before `changelog`, `deps.billingVisible()`, `deps.openPlans()`), `public/js/app.js` (wiring; the plan line `.account__plan` under the name), `public/index.html` (the sheet's `<dialog id="plans">` and checkout markup), `public/css/app.css`, `public/js/api.js`, `public/js/locales/en.js`, `public/js/locales/vi.js`
- Test: `test/ui-billing.test.mjs` (new, appended to `test:ui`), `test/i18n.test.mjs`, `test/ui.test.mjs` (account menu order)

**Interfaces:**
- Consumes: `GET /api/billing`, `GET /api/billing/plans`, `POST /api/billing/quote`, `POST /api/billing/orders`, `GET /api/billing/orders/:id`, `POST /api/billing/orders/:id/cancel`, `PUT /api/billing/profile` (Task 7 shapes); `state.me.billing.visible`.
- Produces:
  - `billing-format.js`: `vnd(n)` → `129.000 ₫` (vi) / `129,000 ₫` (en) via `Intl.NumberFormat(locale, { style: 'currency', currency: 'VND' })`; `usd(cents)` → `$5` / `$57`; `planName(id)`; `minutes(seconds)` → `1 h 12 min` / `1 giờ 12 phút`.
  - `billing-plans.js`: `createPlansSheet({ api, toast, onChanged })` → `{ open(), openCheckout(plan, period), openTopUp(amount) }`.
  - `api.js`: `billing()`, `billingPlans()`, `billingQuote(body)`, `billingOrder(body)`, `billingOrderStatus(id)`, `billingCancelOrder(id)`, `billingProfile(body)`, `billingSubscription(body)`, `billingAlerts(body)`, `billingPromo(code)`, `billingTransactions(query)`, plus the admin ones for Task 10.

Behaviour (spec "Screens"):
- **Menu:** `{ id: 'upgrade', label: t('account.upgrade'), icon: ICON.upgrade, run: () => deps.openPlans() }` placed immediately before the `changelog` row, only when `deps.billingVisible()`. The account button shows `.account__plan` (`t('billing.plan.free')` "Free plan" / plan name) under the name, only when visible; hidden in the collapsed rail.
- **Plans sheet:** a modal `<dialog>` (focus trapped, Esc closes, `aria-labelledby`), title `t('billing.plans.title')` "Plans that grow with you", a two-option segmented control Monthly | Yearly (`role="radiogroup"`; Yearly says "save 5%"), four cards Free/Plus/Pro/Max. Price: vi → `vnd` large; en → `usd` large and `t('billing.billedAs', { vnd })` under it. Button per card: current → disabled "Current plan"; higher → "Get Plus"/"Switch to Pro"; lower → "Changes at renewal" (calls `PUT /api/billing/subscription` with `{ nextPlan, nextPeriod }` after a confirm). Included lines from the plan (searches a month, computer hours a month, storage — no daily figures), then the PAYG prices, "1 person". Under the cards: the rate, its source and time, and the ExchangeRate-API attribution link when the source is `erapi`. `rate: null` → prices replaced by `t('billing.ratesDown')` and the buttons disabled.
- **Checkout:** a second view in the same dialog: left — plan, period radios with both prices, lines (price, prorated credit, balance used, **Total due today**), the "Use my balance (X)" checkbox; right — the billing-information form when `profile` is null (first time), else the saved summary with **Update**. **Continue** → `POST /api/billing/orders`: `paidNow` → success view "You're on Plus" + receipt link when there is one; else the QR view: `<img alt>` of `due.qr.image`, bank, account, holder, amount and content each with a copy button (`navigator.clipboard`, a toast), a `mm:ss` countdown to `expiresAt`, a `role="status"` line polling `GET /api/billing/orders/:id` every 5 s while visible (stop on close/hidden/paid/expired), "Received X of Y — Z to go" for a short payment with a fresh QR for Z, "Expired — any money that arrives goes to your balance" at 0. Cancel → `POST …/cancel`.
- **Preview note** at the top of the sheet and checkout: `t('billing.previewNote')` "Preview — only administrators see this."
- Keyboard and screen reader per the `accessibility-checklist` skill; 360px wide works (cards stack); dark and light.

- [ ] **Step 1: Write failing tests** (`test/ui-billing.test.mjs`, boot like `test/ui-usage-guide.test.mjs`, with `BILLING_MODE` unset and the rate answered by a fake erapi): a member sees no Upgrade row and no plan line; an admin sees Upgrade plan directly above View changelog and "Free plan" under the name; the sheet shows four cards and the yearly toggle changes prices; Get Plus → checkout first time shows the form; after saving, the summary; Continue with no balance → QR with the code, copy buttons, countdown; a simulated transfer (admin route) → the status turns to "You're on Plus" within one poll; Esc closes; Tab order reaches every control; at 360px no horizontal scroll. `test/i18n.test.mjs` passes with every new key in both languages.
- [ ] **Step 2: Run** `node test/ui-billing.test.mjs` — fails.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/ui-billing.test.mjs`, `node test/ui.test.mjs`, `node test/i18n.test.mjs` — pass. Append `node test/ui-billing.test.mjs` to `test:ui`.
- [ ] **Step 5: Commit** `feat(billing): Upgrade plan, the plans sheet and checkout by VietQR — administrators only`.

---

### Task 10: The Billing tab and the admin card

**Files:**
- Create: `public/js/billing-panel.js`, `public/js/billing-admin.js`
- Modify: `public/index.html` (tab `data-tab="billing"` in the preferences group right after `usage`, `hidden` by default, its panel; an Administration card `#admin-billing` with `data-needs="billing"`), `public/js/app.js` (`selectTab` loads/leaves the panel; `fillSettings` unhides the tab when `me.billing.visible`; the permission label), `public/js/privacy.js` (activity lines for the new audit kinds), `public/css/app.css`, locales
- Test: `test/ui-billing.test.mjs`, `test/ui.test.mjs`

**Interfaces:**
- Consumes: Task 7 routes; `createPlansSheet` (Task 9) for Adjust plan and Add credits.
- Produces: `createBillingPanel(host, { api, toast, plans })` → `{ load(), leave() }`; `createBillingAdmin(host, { api, toast, me })` → `{ load() }`.

Behaviour (spec "Screens", Settings → Billing and Administration → Billing):
- **Plan** card: name, price, "Renews 13 Dec from your balance" / "Ends 13 Dec" / "In grace until 16 Dec — add credit to keep Plus"; **Adjust plan** → `plans.open()`; Cancel plan / Keep plan; Auto-renew switch.
- **Credits** card (OpenRouter's): "Total available" large; **Add credits** → a small form with the three presets and an amount box (validated against `bounds`; `badInput` shows an error) → `plans.openTopUp(amount)` (the QR view); **View usage** scrolls to *This period*; **Redeem promo code** box + button; the expiry date line.
- **Low-balance email:** switch + threshold box; the sentence that transfers cannot be charged automatically.
- **This period:** one row per kind — bar of the month's included used/left, paid units and đồng; finance tools "free"; in preview, "N calls would have been refused" when non-zero.
- **Billing information**, **Payment method**, **Recent transactions** (All · Top-ups · Plans · Usage chips; 20 a page; "Load more"), **Receipts** (Download PDF links; invoices when present).
- Preview note at the top. Polls nothing; reloads on `load()` and after each action.
- **Admin card** (`billing` permission): mode line; rate; 30-day money in by kind, real cost, margin; balances held; **capacity** — cloud computers running now of `E2B_CONCURRENT_LIMIT` (default 20, E2B Hobby; read from E2B's running-sandbox list with the env key, kept a minute, "unknown" when it cannot be read) and database size of `DATABASE_INCLUDED_GB` (default 8, Supabase Pro), each turning amber at 75% and red at 90% with the sentence saying what to buy (E2B Pro, more disk); recent orders table; unmatched transfers with Assign (email box) / Mark returned (two-press confirm like free-allowances' remove); promo codes list + create form + disable; in preview and for the owner, a "Simulate a transfer" picker of pending orders.

- [ ] **Step 1: Write failing tests** in `test/ui-billing.test.mjs`: a member has no Billing tab (and opening `#settings/billing` lands on another tab); an admin sees it after Usage; after a simulated top-up the Total available shows it and Recent transactions lists it; promo redeem adds credit; Adjust plan opens the sheet; Download PDF answers `application/pdf`; the admin card shows the unmatched transfer and Assign credits the named account; an admin without `billing` sees no card; keyboard and 360px checks.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `node test/ui-billing.test.mjs`, `node test/ui.test.mjs`, `node test/i18n.test.mjs` — pass.
- [ ] **Step 5: Commit** `feat(billing): the Billing tab and the administrators' Billing card`.

---

### Task 11: Release 1.30.0

**Files:**
- Modify: `package.json` (1.30.0), `public/changelog.json` (1.30.0 entry in both languages, saying it is an administrators' preview), `CHANGELOG.md`, `README.md` (a Billing section: modes, the env variables by name with what each is for, the owner's SePay steps from the spec, what is unverified live), `test/features.test.mjs` (pins: the sheet's numbers equal `server/billing/plans.js`; the menu row sits before View changelog; `BILLING_MODE` unset is preview)
- Memory (not in the repo): update `billing-and-key-pools-decisions.md` with what shipped.

- [ ] **Step 1:** Write the features pins; run `node test/features.test.mjs` — fails until the docs and version are in.
- [ ] **Step 2:** Update the files above.
- [ ] **Step 3:** Run the gate from Bash: `npm run gate > "<scratchpad>/gate-b1.log" 2>&1`; read the log; and `npm run test:ui > "<scratchpad>/ui-b1.log" 2>&1`. Both green.
- [ ] **Step 4: Commit** `release: 1.30.0 — billing, as an administrators' preview`.

---

## Self-review notes

- Spec coverage: Modes → 2, 7; Plans → 2, 9; Money → 2, 4; Balance → 3, 7, 10; Orders and checkout → 4, 9; Transfers → 5; Subscriptions → 4, 7; Metering → 6; Promo → 3, 7, 10; Receipts/e-invoices → 8; Emails → 7; Screens → 9, 10; Routes → 5, 7, 8; Data → 3; Deletion/export → 3, 7; Security → throughout, gated in 5 and 7; spec A leftovers → 1; Owner's steps → 11 (README); Testing → every task.
- `/api/me` in the spec is `publicUser` (the session payload) here; the plan name comes from `GET /api/billing`, since `publicUser` is synchronous.
- Free includes 0.5 GB of storage (the owner's table's 500 MB): the spec's "—" read as "the owner's figure".
