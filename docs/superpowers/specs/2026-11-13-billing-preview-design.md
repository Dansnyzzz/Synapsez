# Billing, as an administrators' preview (spec B1)

Owner, 2026-11-12: an **Upgrade plan** row in the account menu, above **View changelog**; a plans
sheet (Claude's upgrade page); a checkout (Claude's, with and without a saved method); a
**Billing** tab in Settings (Claude's, with OpenRouter's Credits page for the balance); invoices
with **Download PDF**; payment through **SePay** only; one pay-as-you-go price for every search
tool; three plans, **Plus, Pro, Max**. And: "hide both new sections from users for now; only
administrators see them, as a preview."

Research: [billing-audit](../../research/2026-11-12-billing-audit.md),
[sepay-payments](../../research/2026-11-12-sepay-payments.md),
[sepay-einvoice](../../research/2026-11-12-sepay-einvoice.md),
[pricing-tax-check](../../research/2026-11-12-pricing-tax-check.md). Decisions: memory
`billing-and-key-pools-decisions`. Spec A (key pools, 1.29.0) came first; this is the second.

**B1 and B2.** This spec (B1) builds all of billing and lets administrators use it end to end with
real money on their own accounts. Nobody else sees or feels any of it. **B2** (later, its own spec)
switches it on for everyone: the Free plan's rules, the limits on conversations, projects, exports
and own keys, the legal pages, and tax once the seller is registered. See "Not in B1".

## What changes for whom

- **People using the app:** nothing. No menu row, no tab, no routes (`404`), and their searches,
  cloud computer and files work and are counted exactly as today.
- **Administrators:** see the Upgrade plan row, the plan under their name, the plans sheet, the
  checkout and the Billing tab, and can buy a plan or add credit by bank transfer. Once an
  administrator holds a plan or a balance, their own searches, cloud computer minutes and storage
  are counted and charged as a customer's would be, **but never refused**: whatever the live app
  would refuse goes ahead and is counted as "would have been refused" (see Modes).
- **Administrators with the new `billing` permission (the owner has every permission):** a
  Billing card in Settings → Administration: money in, balances held, real cost and margin, orders,
  transfers that matched nothing, promo codes.

## Modes

`BILLING_MODE` in the environment, read by the server on every request; the browser is told, never
trusted.

| Mode | Who sees billing | Who is counted and charged | Refuses? |
|---|---|---|---|
| `off` | nobody; every billing route `404`, the webhook too | nobody | — |
| `preview` (**default**) | administrators | administrators holding a plan or a balance | never; counts "would refuse" |
| `live` (B2) | everyone signed in | B2 decides | yes |

`live` is accepted by the code so B2 is a switch, but B1 ships with nothing that needs it, and the
tests hold that `preview` is what an unset variable means.

## Plans

Owner's option A (2026-11-12). Prices are in USD and charged in đồng at the day's rate (see Money).
Every plan is one person.

| | Free | Plus | Pro | Max |
|---|---|---|---|---|
| Monthly | 0 | **5 USD** | **8 USD** | **15 USD** |
| Yearly (≈5% off) | — | **57 USD** | **91 USD** | **171 USD** |
| Searches included a month | 0 | **150** | **250** | **450** |
| …of which at most a day | — | 30 | 50 | 100 |
| Cloud computer a month | 0 | **4 h** | **6 h** | **12 h** |
| …of which at most a day | — | 1 h | 1 h 30 | 3 h |
| Storage included | — | **3 GB** | **5 GB** | **10 GB** |

At 25,655.85 đ/USD (open.er-api, 2026-11-12) the sheet would read Plus 129,000đ / 1,463,000đ,
Pro 206,000đ / 2,335,000đ, Max 385,000đ / 4,388,000đ.

A yearly plan gives its monthly allowance twelve times, each month starting on the plan's own day.
What a month leaves unused is lost. The plans live in code (`server/billing/plans.js`); changing a
price is a deploy, and `test/features` holds the sheet's numbers to that file.

**Pay as you go**, from the balance, once a month's allowance (or the day's share of it) is used,
and for an account with no plan:

| Unit | Price |
|---|---|
| One search-tool call | **400đ** |
| Cloud computer | **5,000đ an hour, charged by the minute: 84đ** |
| Storage past the plan's | **1,000đ per GB a month**, charged by the day |

## Money

- **Currency.** Every amount charged is in đồng: SePay moves đồng only. Amounts are whole đồng
  (`BIGINT`), USD prices whole cents. Nothing about money is a float, in the database or in code.
- **The rate.** USD→VND from open.er-api (no key, refreshed once a day, attribution link
  required: "Rates By Exchange Rate API"), falling back to Vietcombank's transfer rate, then
  Frankfurter — the sources `server/finance/sources/fx.js` already reads. Kept for an hour in the
  instance and in the `billing_fx` setting so instances agree; a rate older than 48 hours is not
  used, and the plans sheet then says prices cannot be shown right now.
- **Rounding.** A plan's đồng price is rounded **up to the next 1,000đ**. Pay-as-you-go prices are
  set in đồng and are not converted.
- **Locked per order.** An order keeps the rate, its source and the price; a QR is good for **30
  minutes**. Money that comes later is still taken (see Transfers).
- **Shown.** In Vietnamese, đồng. In English, the USD price large and "billed as 129,000đ" under
  it. The rate and its source are named under the sheet.
- **No tax line** while the seller is not registered (owner, 2026-11-12). `BILLING_TAX_RATE`, unset,
  is where a rate goes later; set, checkout shows a separate Tax line on the base price.

## The balance ("Số dư dịch vụ")

Credit for this app's own services, not a wallet: it cannot be withdrawn, sent to another account
or turned back into money, and the page says so in those words.

- **Everything goes through it.** Every transfer that arrives is credited to the balance first; a
  plan is then bought by taking its price out of the balance. So short, over and late transfers
  need no special money paths: they are a balance that is or is not enough yet.
- **Added** by transfer (Add credits, or a plan order's QR), by a promo code, or by the owner
  assigning a transfer that matched nothing.
- **Bounds** (from the owner's limits table): Add credits takes at least **50,000đ** with no plan
  and **100,000đ** with one; the form will not take a top-up past a balance of **200,000đ** (no
  plan) or **1,000,000đ** (a plan). A transfer that goes past it anyway is still credited.
- **Expires** 12 months after the last top-up (owner's limits table); the page shows the date, and
  an email goes 30 days before.
- **Never below zero.** Every change is one SQL statement (a data-modifying CTE that updates
  `balances` and writes `balance_entries` together), with `CHECK (vnd >= 0)`; a charge that does
  not fit changes nothing.
- **The ledger.** `balance_entries` holds every change, so the balance is always the sum of its
  entries. Usage is written as one row per account, kind of tool and Vietnamese day ("Searches · 12
  calls · −4,800đ"), not a row per call.

## Orders and checkout

An order is one of: `plan` (a new plan, an upgrade, monthly→yearly), `renewal`, `topup`.

1. **Quote.** The price at the locked rate; for an upgrade, the **prorated credit**: what the
   current period was paid × the share of it left, rounded down to the đồng. The new plan starts
   **today**, with a new day of the month. "Use my balance (X đ)" is on by default.
2. **Paid at once** when the balance covers the total and the person said to use it: no QR.
3. **Otherwise a QR** for what is still due: SePay's own image
   (`qr.sepay.vn/img?acc=…&bank=…&amount=…&des=…`), the bank, account number and holder, the amount
   and the transfer content (the order's code) each with a copy button, a 30-minute countdown, and a
   status line that changes by itself when the money arrives.
4. **Codes.** `SZ` and ten random digits (`crypto.randomInt`), unique, no dashes (banks drop them).
   SePay is set to read the `SZ` prefix, so its `code` field carries it; failing that, the content
   is searched for `SZ\d{10}`, ignoring case.
5. **Applied** when, after a transfer, `use_balance` ? balance ≥ total : received for this order ≥
   total. Then, in one statement, the total leaves the balance and the order is `paid`; the
   subscription starts or changes.
6. **Downgrades** (Max→Pro, Pro→Plus, yearly→monthly) and **cancelling** take effect at the end of
   the period; nothing is refunded and nothing is charged now.

The checkout's two Claude states become: **first time** (no billing information yet) — the
information form, then the QR; **after** — the saved information with **Update**, and the QR or
"Pay 141,500đ from balance" at once.

## Transfers (SePay)

- **Webhook** `POST /api/billing/sepay`, mounted with the other outside hooks: before
  `express.json`, so it is checked on the raw bytes. Checked: `X-SePay-Signature: sha256=<hex>` is
  HMAC-SHA256(`SEPAY_WEBHOOK_SECRET`, `<X-SePay-Timestamp>.<raw body>`), present, the right length
  before a timing-safe compare, and the timestamp within 300 seconds. Anything else is `401`.
- **Answered only after the work is written**, and then with exactly `{"success": true}`: SePay
  counts any other body as a failure that it will not retry, and Vercel stops a function once it
  has answered. Our own failure answers `500`, so SePay retries (7 times over about 33 minutes).
- **Only money in, to our account:** `transferType` `in` and `accountNumber` equal to
  `SEPAY_BANK_ACCOUNT`; others are stored as `ignored`.
- **Once.** `sepay_transfers.dedupe` is `ref:<referenceCode>` when SePay gives one, else
  `id:<id>`, and UNIQUE; a repeat is answered `{"success": true}` and changes nothing.
- **Matching** by code: a pending order → credit and try to apply (`applied`, `short`, `over`); an
  expired or cancelled order → credit only (`late`) and an email saying the money is in the
  balance; a `topup` order → credit (`topup`); no code or an unknown one → `unmatched`, for the
  owner to assign to an account by email or mark as returned outside the app.
- **Missed webhooks.** With `SEPAY_API_TOKEN` set, an open checkout's status call asks SePay's
  `userapi.sepay.vn/v2/transactions` at most once every 30 seconds per order (and once every 10
  seconds overall, under SePay's 3 a second); the daily job looks back three days. Those ids are
  UUIDs, so only transactions with a reference number are taken this way, by the same `dedupe`.
- **Simulated transfers** (preview only, owner only): the admin card can make one for an order, so
  the whole path can be tried without moving money. It is marked `simulated`, kept out of every
  money figure, and gets no receipt. `live` refuses it.

## Subscriptions

- **Periods** start on the day bought, in Vietnamese time, and run a month or a year; a month from
  the 31st ends on the last day of a shorter month. The included searches and minutes count from
  each month's start.
- **Renewal.** With auto-renew on (the default) the price at that day's rate is taken from the
  balance at the period's end. Three days before, if the balance will not cover it, an email goes
  with the amount, a link to pay and a QR for a `renewal` order whose price stays good until the
  grace ends.
- **Grace.** Unpaid at the end: the plan carries on for **3 days**, with the next period dated from
  the old end so paying late changes no dates. Unpaid after that: back to Free; what was used in
  those days is not charged.
- **Done lazily too.** The daily job does renewals, reminders and grace; an account's own request
  does the same for that account first, so a once-a-day job (Vercel Hobby) is never a day late
  for anybody who is using the app.

## Metering

An administrator who holds a plan or a balance is **billable**; everyone else is counted as today
and nothing below touches them.

**Search tools.** One call of `web_search`, `web_fetch` through a paid reader, `site_pages`,
`code_context` — any tool that may draw on Exa, Tavily, Brave or Firecrawl — is **one unit**,
whatever engines answered and however many. A call that reads several pages through Firecrawl
(a crawl, a long PDF) is one unit per three pages read. Nothing is charged when the answer came
from a free engine (DuckDuckGo, Stack Exchange, the free Firecrawl indexes) or from the ten-minute
cache.

1. Before the call, the unit is **held**: from the month's allowance if the day's share and the
   month's are not used, else 400đ from the balance.
2. The held call may use the owner's paid keys once the free keys are spent (`paid: true`, spec
   A) — the one place B1 turns that on.
3. After, the hold is **kept** if a metered engine answered, **given back** otherwise.
4. Nothing to hold from: live refuses the metered engines and the free ones answer; preview goes
   ahead as today (not `paid`) and counts one "would have been refused".

**Cloud computer.** The windows `server/e2b.js` already pays ahead are held the same way — from the
month's minutes, then 84đ a minute — and settled to the minutes the machine ran, rounded up to the
minute, when it stops or the window closes; a start that fails gives it all back, as `giveBack`
does now. Held windows may use the paid E2B key.

**Storage.** The account's files and their versions (`attachments`, `attachment_versions`),
measured by the daily job. Past the plan's GB (rounded up to a tenth): 1,000đ a GB a month, taken
each day as `ceil(tenths × 100 / days in the month)` đồng. Nothing new is refused in B1.

**Spend by kind of tool** on the Billing tab, the way Settings → Usage shows providers: searches,
cloud computer, storage — included used and left, today's share, and what was paid from the
balance — and finance tools, listed as free.

## Promo codes

The owner (or a `billing` administrator) makes one: a code of at least 8 letters and digits, an
amount of credit in đồng, how many accounts may use it, when it ends. An account uses a code once.
Redeeming is limited to 10 tries an hour per account; a wrong code says only that it did not work.

## Receipts and e-invoices

- **A receipt for every transfer received** (not for buying from the balance — that money was
  receipted when it came in): number `SZR-2026-000001` from a sequence, date in Vietnamese time,
  the buyer's billing information as it was, the amount, the reference, what it paid for (Plus
  monthly 13 Nov – 13 Dec, credit added), and the line **"Payment receipt — not a VAT invoice."**
- **Drawn as a PDF** with `@napi-rs/canvas`'s `PDFDocument` and the Arimo font already in
  `server/assets/fonts` (it has Vietnamese), when downloaded, from the stored figures.
- **SePay e-invoices: built, off.** With `SEPAY_EINVOICE_CLIENT_ID`/`_SECRET` and the template
  settings set, a paid order is sent to SePay's e-invoice API with the order id as
  `reference_code`; its status is asked by the daily job and when the person opens the tab (there is
  no webhook); an answer that cannot be confirmed is never sent again (that makes a second signed
  invoice); `issued_date` is today in Vietnamese time. **Download PDF** goes through our route,
  which checks the invoice is the person's. Off until the owner has a tax code, a digital signature
  and the tax office's approval; tested against recorded answers only.

## Emails

In the account's language, through `sendEmail` and the mail layout (no gradient behind white text):
payment received (with the receipt), plan started or changed, renewal in 3 days, renewed, grace
started, plan ended, balance low (below the person's threshold, once until it is topped up
again), balance expiring in 30 days, money arrived after its order closed.

## Screens

- **Account menu:** **Upgrade plan** right above View changelog; and under the name at the foot of
  the sidebar, the plan ("Free plan", "Plus"), as Claude has. Both only when the server says this
  account sees billing.
- **Plans sheet** (Claude's upgrade page): "Plans that grow with you", Monthly | Yearly (save 5%),
  four cards — Free, Plus, Pro, Max — each with its price, a line about who it is for, its button
  (Get Plus · Current plan · Switch to Pro · Changes at renewal), and what it includes (the table
  above, in words, and the pay-as-you-go prices after). The rate and its source under the cards.
- **Checkout** (Claude's): the plan and period on the left with the lines — price, prorated credit,
  balance used, **total due today**; billing information and payment on the right (see Orders).
  Then "You're on Plus", and the receipt.
- **Settings → Billing** (after Usage; Claude's tab with OpenRouter's Credits):
  - *Plan* — name, price, "Renews 13 Dec from your balance" or "Ends 13 Dec"; **Adjust plan** opens
    the sheet; Cancel plan / Keep plan; Auto-renew.
  - *Credits* — **Total available** large; **Add credits** (100,000 / 200,000 / 500,000đ or an
    amount, within the bounds) to a QR; **View usage**; **Redeem promo code**; when it expires.
  - *Low-balance email* in place of Auto top-up: "Email me a QR when my balance falls below
    [50,000đ]", and the sentence that bank transfers cannot be charged automatically.
  - *This period* — spend by kind of tool, as above.
  - *Billing information* (Claude's payment-method screens, without a card) — name, email for
    receipts, country, and optionally address and tax code; **Update**.
  - *Payment method* — "Bank transfer by VietQR, through SePay, from any Vietnamese bank app."
  - *Recent transactions* — date, what, amount, balance after; All · Top-ups · Plans · Usage.
  - *Receipts* (and invoices, when on) — date, number, amount, **Download PDF**.
  - In preview, a note at the top: "Preview — only administrators see this."
- **Settings → Administration → Billing** (`billing`): the mode; the rate in use; 30 days of money
  in (plans, pay as you go, top-ups) beside the real cost of the units sold (the paid keys' counts
  from spec A × their unit prices, the paid E2B minutes) and the margin; balances held (money owed
  in service); recent orders; unmatched transfers with Assign / Mark returned; promo codes; in
  preview, Simulate a transfer (owner).

Every screen: keyboard and screen reader (the accessibility-checklist skill), both languages,
dark and light, 360px wide.

## Routes

All under `/api/billing`: `404` in `off`; in `preview` `404` to anyone who is not an
administrator (not `403`, so it says nothing); in `live`, signed in. Each checks the order, receipt
or invoice is the caller's.

| Route | What |
|---|---|
| `GET /api/billing` | plan, balance and its expiry, this period's spend, billing information, settings |
| `GET /api/billing/plans` | the plans in đồng at the current rate, the rate and source, the caller's plan |
| `POST /api/billing/quote` | price lines for a plan and period; creates nothing |
| `POST /api/billing/orders` | a plan, renewal or top-up order: paid at once from the balance, or a QR (10 an hour) |
| `GET /api/billing/orders/:id` | its status; may ask SePay (see Transfers) |
| `POST /api/billing/orders/:id/cancel` | a pending order |
| `PUT /api/billing/subscription` | auto-renew; cancel or keep at period end |
| `PUT /api/billing/profile` | billing information |
| `PUT /api/billing/alerts` | the low-balance threshold |
| `POST /api/billing/promo` | redeem (10 tries an hour) |
| `GET /api/billing/transactions` | the ledger, a page at a time, by kind |
| `GET /api/billing/receipts/:number.pdf` | a receipt |
| `GET /api/billing/invoices/:id.pdf` | an e-invoice, through SePay (when on) |
| `POST /api/billing/sepay` | SePay's webhook (outside; no session) |
| `GET /api/admin/billing` | the admin card's figures (`billing`) |
| `GET /api/admin/billing/orders`, `…/transfers` | lists (`billing`) |
| `POST /api/admin/billing/transfers/:id/assign` · `/dismiss` | an unmatched transfer (`billing`) |
| `GET, POST, DELETE /api/admin/billing/promos` | promo codes (`billing`) |
| `POST /api/admin/billing/simulate` | a simulated transfer (owner; preview only) |

`/api/me` gains `billing: { visible, plan }`. The daily job (`/api/cron/run-tasks`) gains the
billing day: renewals, reminders, grace, storage charges, expiry, reconciliation, e-invoice status.

## Data (schema 53)

Above the Schema 49 row-level-security block, so the new tables are covered by it.

- `billing_profiles` — `user_id` (cascade), `sealed` (crypto v2, context `['billing-profile',
  user_id]`: name, email, country, address, tax code), `low_balance_vnd`, `low_alert_sent_at`.
- `balances` — `user_id` (cascade), `vnd BIGINT CHECK (vnd >= 0)`, `last_topup_at`.
- `balance_entries` — `id`, `user_id` (set null), `kind` (topup · plan · usage · promo · assign ·
  expire · forfeit · adjust), `category`, `day`, `units`, `delta_vnd`, `ref`, `created_at`; unique
  (`user_id`, `category`, `day`) where `kind = 'usage'`.
- `billing_orders` — `id`, `user_id` (set null), `kind`, `plan`, `period`, `code UNIQUE`,
  `usd_cents`, `rate`, `rate_source`, `price_vnd`, `credit_vnd`, `total_vnd`, `use_balance`,
  `received_vnd`, `status`, `expires_at`, `paid_at`, `simulated`.
- `sepay_transfers` — `dedupe UNIQUE`, SePay's id and reference, `amount_vnd`, `code`, `content`
  (cut to 500 characters), `transaction_at`, `order_id`, `user_id` (set null), `outcome`, `via`
  (webhook · poll · simulated).
- `subscriptions` — `user_id` (cascade), `plan`, `period`, `status` (active · grace · ended),
  `period_start`, `period_end`, `paid_vnd`, `auto_renew`, `cancel_at_end`, `next_plan`,
  `next_period`, `reminded_at`, `renewal_order`.
- `promo_codes`, `promo_redemptions` (`code`, `user_id`; once each).
- `receipts` — `number`, `user_id` (set null), `transfer_id`, `order_id`, `amount_vnd`, `lines`
  (no personal data), `buyer_sealed` (cleared when the account is deleted), `issued_at`; and
  `receipt_seq`.
- `einvoices` — `order_id`, `reference_code UNIQUE`, `tracking_code`, `status`, `error`.
- Allowance counters in `rate_limits`, as everything else counted:
  `bill:search:<user>:<period start>`, `bill:search-day:<user>:<VN day>`, the same for `sandbox`
  in minutes, and `bill:would:<user>:<kind>:<VN day>`.

## Deleting an account, and Your data

Owner, 2026-11-12: personal and billing-profile data go; **money records stay**, detached. Before
the account goes, a `forfeit` entry writes off what is left of its balance; then the cascade
removes the profile, balance and subscription, the receipts lose their buyer, and orders,
transfers, receipts and the ledger keep their amounts, dates and codes with no account. Your data's
export gains the account's billing information, orders, transactions and receipts.

## Security

- Owner-held secrets only in the environment: `SEPAY_WEBHOOK_SECRET`, `SEPAY_API_TOKEN`, the
  e-invoice credentials. None reaches the browser or a log line; the SePay token is scrubbed from
  errors as spec A's keys are.
- The webhook is the only way money is credited from outside; the browser never says what was paid.
  Status calls read the database (and SePay), never a figure the browser sent.
- Amounts from the browser are whole đồng within the bounds; plan and period from fixed lists; the
  rest of a quote is the server's.
- Every money change is one atomic statement; holds are taken before a call and given back after,
  so two calls at once cannot spend the same đồng.
- Billing information is sealed at rest and never logged; receipts are served only to their
  account; transfer content is shown only to `billing` administrators.
- Audit log: `billing_order_paid`, `billing_transfer_assigned`, `billing_transfer_dismissed`,
  `billing_promo_created`, `billing_promo_disabled`, `billing_simulated`; the account's own
  activity list shows plan changes and billing-information updates.
- Rate limits: orders 10 an hour, promo 10 tries an hour, the status call once a second per order.

## First: spec A's leftovers before anything passes `paid: true`

From spec A's final review, all needed before a held call reaches the owner's paid key:

1. Firecrawl's paid key is blocked by the low-count rule — exempt a call marked `paid`.
2. The `fullest` fallback can return the paid key past its cap when the ceilings are lifted.
3. Hold the paid key's unpaid Exa and Tavily calls, as Brave's already are.
4. The owner's free ceiling for a key is capped at the free amount (M1).
5. The cap box saves "no cap" on input it cannot read (L1).
6. An `env` paid choice survives the environment key being swapped (L5).
7. The stale "Firecrawl Free plan, never a bill" lines (README.md:1168, :2084; server/freeTier.js:35-36).

## Owner's steps (outside the code)

- In Vercel: `SEPAY_WEBHOOK_SECRET`, `SEPAY_BANK_ACCOUNT`, `SEPAY_BANK_CODE` (e.g. `MBBank`),
  `SEPAY_ACCOUNT_NAME`, optionally `SEPAY_API_TOKEN`; `BILLING_MODE` may stay unset (preview).
- In SePay: the payment-code prefix `SZ`; a webhook to `https://synapsez.vercel.app/api/billing/sepay`
  with HMAC and the same secret; "resend automatically when the server returns an error" on.
- Give the `billing` permission to any administrator who should see the money.
- Test: a simulated transfer, then one small real transfer (50,000đ top-up) on your own account.

## Not in B1 (B2, going live)

The Free plan for everyone (does it keep today's 30 searches a day?); refusing anybody; the limits
on conversations, projects, file exports, own-key requests and history from the owner's table;
seats and a Team plan; a search-a-minute cap and three machines at once; the terms (credit expiry,
no withdrawals) and privacy policy (billing data, SePay); a tax line; cards through SePay's
gateway (needs a registered business); switching `BILLING_MODE` to `live`.

## Chosen here, for the owner to change in review

1. A call that reads several pages through Firecrawl is one unit per three pages (a ten-page crawl
   costs Firecrawl about 1,300đ).
2. Plan prices round up to the next 1,000đ.
3. In preview an administrator is charged only once they hold a plan or a balance.
4. An upgrade starts a new period today, with the unused share of the old one as credit.
5. Unpaid days of grace are not charged.
6. Balance bounds, minimum top-ups and 12-month expiry are the owner's table's.
7. Currency by the interface language: đồng in Vietnamese, USD (billed in đồng) in English.
8. A low-balance email with a QR in place of automatic top-up.
9. Simulated transfers in preview, owner only.
10. SePay e-invoices built now and left off.

## Testing

- **Units:** plan prices and rounding; the rate chain, its lock and its age limit; periods
  (month-end, Vietnamese midnight, a year's twelve months); proration; codes; the webhook check
  (missing headers, wrong length, wrong signature, stale time, a repeat); matching (exact, short,
  over, late, unknown, money out, another account); the ledger (never below zero, two holds at
  once, usage rows per day); metering (allowance → day's share → balance → nothing; preview never
  refuses; cache and free engines free; pages to units); renewal, reminder and grace; promo codes;
  the receipt PDF (`%PDF-`, its number and Vietnamese read back through pdfjs); the e-invoice
  client against recorded answers, never resending what is unconfirmed.
- **HTTP:** each mode and role on every route; admin routes by permission; the webhook before the
  JSON parser and the hooks route.
- **Database:** schema 53, its constraints, row-level security on the new tables, the deletion path.
- **Browser:** the menu row and plan line only for administrators; the sheet; checkout first time
  and after, paid from the balance and by a simulated transfer; the Billing tab; keyboard and
  screen reader; 360px.
- `features` holds the sheet to `plans.js`; `i18n` holds every new string in both languages. The
  gate, from Bash, before it is called done.
