# Quick fixes 1.31.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the owner's 2026-11-15 quick fixes as release 1.31.0: a leaner Users page, a guide that scrolls and covers Automations & Bot, one key at a time in the guide, a calmer Progress panel, and compaction that keeps recent turns by size with a live %.

**Architecture:** Each fix stays in the module that already owns it: user paging in `server/store/pg.js` + the users route in `server/app.js`, the Users page in `public/js/app.js` (`loadAdmin`, `loadRecommended`), the guide in `public/js/onboarding.js` / `onboarding-keys.js`, the Progress panel in `public/js/app.js` (`progress-fold`), compaction in `server/compact.js` with its progress sent through the existing `status` event (`phase: 'compacting'`).

**Tech Stack:** Node 22 ESM, Express, Postgres/PGlite store, vanilla JS front end, the repo's hand-rolled test harness (`node test/<name>.test.mjs`), Playwright for `test/ui*.test.mjs`.

Spec: `docs/superpowers/specs/2026-11-16-quick-fixes-design.md` (approved by the owner 2026-11-16).

## Global Constraints

- Users page keeps only: Users, Administrators, Recommended models, Free allowances. Themes, Billing, Security activity **stay where they are** until `/admin` exists (out of scope).
- Remove the notes `admin.lede`, `recommend.lede`, `freetier.lede`, and the `freetier.enforced` / `freetier.enforcedFallback` status line (markup, the code that writes them, and both locales). Members still see their monthly share in Settings → Usage.
- Recommended models: **no Save button**; each select saves on `change`; select disabled while saving; "Saved" in a polite live region on success; on failure the select returns to its previous value and the error shows under it; a change made while a save is in flight waits for it.
- Users list: top **10** by tokens this month (desc, then name), then **See all** → full-screen dialog, **20** a page, ← and → buttons on both sides, "Page N of M"; ← → keys move pages when focus is not in a text field; Esc closes; rows keep today's facts and buttons.
- `GET /api/admin/users?page=&size=` → `{ users, total, page, size }`; size 1–50, default 20; paging in SQL; `?role=admin` → every administrator, unpaged. Permission `users` or `delete_users` as today. Existing callers of `store.listUsers()` (feedback, account routes) are unchanged.
- Guide: step tabs scroll horizontally when they overflow — thin scrollbar on a **transparent** track, current tab scrolled into view, edge fades; one new step **Automations & Bot** before "First task" (7 steps); every sentence of it pinned by the "getting-started guide says only what is true" checks in `test/features.test.mjs`; a recorded clip like steps 1, 4, 5, 6 (`npm run onboarding:record`).
- Keys in the guide: one key per box; checked on **paste** (no Add press), after a pause or Enter when typed; "Checking the key…" while it runs; good → ✓ "Added", box locks, a new empty box appears; another provider's key → moved by the existing intake-by-shape with "That is an <Provider> key — added to <Provider>"; refused → red with the provider's reason, no new box. Line under the box: one key per account; several keys from one account share its limit. OpenRouter's same-account second key is refused (existing `/api/v1/key` check). Settings → Providers is unchanged.
- Progress panel: on "N earlier steps" the up chevron shows **only on hover or keyboard focus**; "Hide earlier steps" keeps its chevron; opening/folding slides (height + opacity, ~200 ms, ease-out); `prefers-reduced-motion` → instant.
- Compaction %: right end of the "Compacting the conversation…" line, same figure as the bar; share of the summary written against its expected length (from how much is folded, bounded by the summary's token limit); held below 100 until saved, then 100; never decreases.
- Compaction tail by size: walk back from the newest message adding whole turns while the tail ≤ **10% of the model's window, minimum 4,000 tokens**; the latest user message and everything after it always kept; never split a tool call from its results (`tailStart`'s rule); everything older is summarised; "should compact" asks whether anything older than the tail exists (not `> KEEP_RECENT + 2`).
- Every new user-facing string in both `public/js/locales/en.js` and `vi.js` (`test/i18n.test.mjs`); server errors a person sees in `server/i18n/vi.js`.
- Comments say why, not what; CODE-039 ceiling 93 back-to-back doc blocks (a section banner straight above a `/** */` counts — leave a blank line).
- `npm run typecheck` must stay within baseline (new errors fail the gate); `npm run lint` clean.
- Working tree is CRLF; never leave a lone CR.
- Never read, edit or stage `.env` or `.env.example`. Stage by path; never stage `.claude/AUDIT_RULES.md`, `.claude/audit-annex/`, `.vscode/`, `Exa Deep Research-3.4.1-v1/`.
- Run tests in the foreground; implementers never run `npm run gate` or the full `npm run test:ui` (the controller does).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Users paged on the server

**Files:**
- Modify: `server/store/pg.js` (new `listUsersPage({ page, size })` and `listAdmins()` beside `listUsers` at :590), `server/app.js` (the users route at :2977)
- Test: `test/database.test.mjs` (store), `test/http.test.mjs` or the suite that already covers `/api/admin/users` (route)

**Interfaces:**
- Produces: `store.listUsersPage({ page, size }) → { users, total }` — same row shape as `listUsers()` (including `tokens_this_month`, `chat_count`, `has_worker`, `is_owner`, `role`, flags), ordered `tokens_this_month DESC, lower(name or email) ASC, id`; `store.listAdmins() → users[]` (role admin or owner).
- Produces: `GET /api/admin/users?page=1&size=10` → `{ users, total, page, size }` with each user's `permissions: permissionsOf(u)` as today; `?role=admin` → `{ users }` of every administrator. Bad `page`/`size` → clamped (page ≥ 1, size 1–50).

- [ ] **Step 1: Write failing tests.** Store: seed 25 users with distinct monthly token totals (and a few at 0); page 1 size 10 = the 10 highest in order; page 3 size 10 = the last 5; `total` 25; ties ordered by name. Route: page/size clamp; `role=admin` lists administrators only; a member gets 403/404 as today; `permissions` present on each row.
- [ ] **Step 2: Run** `node test/database.test.mjs` and the route suite — new checks fail.
- [ ] **Step 3: Implement** with `LIMIT $n OFFSET $m` and a `COUNT(*) OVER ()` (or a second count query) over the same joins `listUsers` uses; no N+1.
- [ ] **Step 4: Run** the same suites — pass. `npm run lint`, `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(admin): accounts paged on the server, busiest this month first`.

### Task 2: The Users page — top 10, See all, saves itself, fewer notes

**Files:**
- Modify: `public/index.html` (panel-admin at :2335 — drop the four notes, keep the sections' order), `public/js/app.js` (`loadAdmin` :7184, `loadRecommended` :7038, the free-tier status line), `public/js/api.js` (users call takes `{ page, size, role }`), `public/css/app.css`, locales
- Create: `public/js/users-dialog.js` (the full-screen paged list)
- Test: `test/ui.test.mjs` (Users section) or a new `test/ui-admin-users.test.mjs` added to `test:ui` if the section is long

**Interfaces:**
- Consumes: Task 1's `GET /api/admin/users?page&size` and `?role=admin`.
- Produces: `createUsersDialog({ api, me, armed, onChanged }) → { open() }`.

- [ ] **Step 1: Failing browser checks:** the four notes gone (vi and en); no `#rec-save`; changing each select sends one save and shows "Saved"; a refused save puts the old value back and shows the error; the list shows exactly 10 rows in token order with See all; See all opens a full-screen dialog with 20 rows, "Page 1 of N", → and ← (buttons and keys) change page, Esc closes and focus returns to See all; row buttons still work inside the dialog (Suspend once); the Administrators card still lists every administrator; 360px width has no sideways scroll in the dialog.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** The dialog reuses the row renderer (move it to a shared function, no copy).
- [ ] **Step 4: Run** the suite, `node test/i18n.test.mjs`, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(admin): the Users page shows the ten busiest, the rest a page at a time; suggestions save as you pick`.

### Task 3: The guide scrolls, and covers Automations & Bot

**Files:**
- Modify: `public/js/onboarding.js`, `public/css/app.css`, locales (`onb.*`), `scripts/record-onboarding.mjs` (the new step's clip), `public/onboarding/{vi,en}/` (the clip and poster it writes), `test/features.test.mjs` (pins)
- Test: `test/ui-usage-guide.test.mjs` (the guide's browser suite)

**Found while recording the provider videos (2026-11-16): the key steps no longer match the providers' pages.** Correct them in both locales and their features pins:
- **OpenRouter.** "Create key" now has required **Expiration** (choose "No expiration") and **Credit limit** (choose a limit, or "No limit"). The step currently says the limit can be left empty. OpenRouter also warns that a never-expiring, unlimited key can spend the whole balance if it leaks, so say: set a limit if you have paid credit. OpenRouter may ask for a code sent to your email the first time.
- **Google.** In Vietnamese the button is **"Tạo khóa API"**, then **"Tạo khóa"** in the small form (name and the default project are pre-filled). The new key starts with `AQ.`, so drop any mention of `AIza` from the copy text.
- **Provider videos.** Committed in 113c2ab: `public/onboarding/keys/{openrouter,google}.{webm,jpg}` (1280×656, VP9; OpenRouter 35 s, Google 19 s; recorded 2026-11-16, everything personal blurred). Replace step 2's illustration for those two providers with the video: muted, looping, plays inline, the poster first, `prefers-reduced-motion` shows the poster with a play button, a caption under it saying it is the real page as of November 2026. OrcaRouter has one too (orcarouter.{webm,jpg}, 1280×712, recorded in Vietnamese). The same video serves both languages; OpenRouter's site is English only and Google's was recorded in Vietnamese.
- **OrcaRouter.** The free plan has a limit on the number of keys, and the owner's account showed "3 / 3"; at the limit, "Tạo khóa" opens the upgrade window. Say: if you are at the limit, delete a key you no longer use, or reuse one you have.

- [ ] **Step 1: Read** how Automations and the Bot page actually work today (`public/js/` automations and bot page, `server/` scheduler) — every sentence of the new step must be true and pinnable.
- [ ] **Step 2: Failing checks:** features pins for each new sentence; the guide has 7 steps with Automations & Bot sixth; at 360px and 768px the tab row scrolls horizontally, its track is transparent, the current tab is fully visible after Next/Back, the page itself never scrolls sideways.
- [ ] **Step 3: Run** — fails.
- [ ] **Step 4: Implement**; record the clip with `npm run onboarding:record` for the new step only (vi and en); keep the clip small like the others.
- [ ] **Step 5: Run** `node test/features.test.mjs`, the guide suite, i18n, lint, typecheck — pass.
- [ ] **Step 6: Commit** `feat(guide): Automations & Bot step; the steps scroll sideways when they do not fit`.

### Task 4: One key at a time in the guide

**Files:**
- Modify: `public/js/onboarding-keys.js` (`createKeyGuide`, the paste box at :138), locales, `public/css/app.css`
- Test: `test/ui-usage-guide.test.mjs` (or wherever the guide's key step is tested today)

**Interfaces:**
- Consumes: `addKey(provider, key)` → the existing `api.intakeKey` (moves a key to its provider by shape; OpenRouter one-account-one-key) — read `server/routes/account.js` intake to learn exactly what it answers for good / moved / refused / same account.

**Found while recording the provider videos (2026-11-16), part of this task:**
- **Google's new key format.** AI Studio now issues only "Authentication Keys" starting `AQ.` (e.g. `AQ.Ab8…`, ~50 characters after the dot), not `AIza…`. `server/keyIntake.js:33` recognises Google only by `/^AIza…/` and Google is in `STRICT`, so a key made today is **refused** in the Google box. Accept both shapes (`/^(AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{30,})$/`). Mask both in `server/redact.js:45` and `server/deidentify.js:136`. Hints `AIza… or AQ.…` in `public/js/onboarding-keys.js:24` and `server/providers/catalog.js:220`.
- **The Google key check must make a real call.** Forum reports (Google AI Developers Forum, June 2026) say some `AQ.` keys pass `models.list` but get 401 on `generateContent`. Read how the Google key is checked today, and make the check a cheap `generateContent` (or `countTokens`) so a key that cannot chat is refused at paste time with Google's reason. Add tests for both shapes, the 401 case and masking.

- [ ] **Step 1: Failing checks (stub the intake route):** pasting a good key checks at once (no Add press), shows "Checking the key…" then ✓ "Added", locks the box and shows a new empty box; a key of another provider says it was added there; a refused key turns the box red with the reason and no new box appears; a second key from the same OpenRouter account is refused with the one-key-per-account sentence; typed (not pasted) checks after a pause and on Enter; the one-key-per-account line is under the box; keyboard and screen reader: the result is announced, focus moves to the new box.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Remove the multi-line textarea and the Add key button from the guide; Settings → Providers untouched.
- [ ] **Step 4: Run** the suite, i18n, features (if guide sentences are pinned), lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(guide): keys one at a time, checked as they are pasted`.

### Task 5: Progress panel — chevron on hover, a slide

**Files:**
- Modify: `public/js/app.js` (progress fold at :8271–8290), `public/css/app.css`
- Test: `test/ui-chat.test.mjs` (the Progress section at ~:1395)

- [ ] **Step 1: Failing checks:** "N earlier steps" has an up chevron that is hidden at rest and visible on hover and on keyboard focus; "Hide earlier steps" keeps its chevron visible; opening and folding animate (a transition on height/opacity is present and the end state matches today's); with `prefers-reduced-motion: reduce` there is no transition; focus stays on the button; the existing Progress checks still pass.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement** (CSS `grid-template-rows` 0fr→1fr or a measured height; no layout jump of the steps after the fold).
- [ ] **Step 4: Run** `node test/ui-chat.test.mjs`, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(progress): the earlier-steps chevron shows on hover; folding slides`.

### Task 6: Compaction keeps recent turns by size, and shows a live %

**Files:**
- Modify: `server/compact.js` (`KEEP_RECENT`, `tailStart`, `shouldCompact`, `compact`'s `onProgress`), `server/agent.js` (:2414 status emit), `server/routes/chats.js` (manual compact, if it passes progress), `public/js/app.js` (compact bar at :5050), `public/css/app.css`, locales
- Test: `test/agent.test.mjs` or the suite that covers `server/compact.js` today (find it), `test/ui-chat.test.mjs` or `test/ui.test.mjs` for the % line

**Interfaces:**
- Produces: `tailStart(messages, { window })` choosing by tokens (10% of `window`, min 4,000); `onProgress({ folding, written, expected })` while the summary streams; the client shows `Math.round(100 * written / expected)` capped at 99 until the done event, then 100, never decreasing.

- [ ] **Step 1: Failing checks:** a transcript with a 60K-token old reply and short recent turns: the reply is folded, the tail ≤ 10% of a 262K window; a single latest user message bigger than the budget is still kept whole with what follows it; a tool call is never separated from its result at the boundary; a 32K window uses the 4,000 floor; `shouldCompact` is false when nothing lies before the tail; progress events carry `written`/`expected`; the client % only rises and ends at 100.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Keep `activeTranscript`'s `covers` logic as is. Throttle progress events (at most a few per second).
- [ ] **Step 4: Run** the compaction suite, the browser check, i18n, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(compact): keep the recent turns by size, not count; a live % while it summarises`.

### Task 7: The rate once a day from Frankfurter, and yearly prices that save 17%

**Files:**
- Modify: `server/billing/fx.js` (source order at :64-68; freshness), `server/billing/plans.js` (yearly `usdCents` at :14-16), the 06:00 cron handler behind `/api/cron/refresh-models` (find it in server/app.js or server/routes), `server/routes/billing.js` (`GET /plans` rate fields), tests that pin prices (`test/billing-core.test.mjs`, `test/billing-flow.test.mjs`, `test/billing-docs.test.mjs`, `test/features.test.mjs`), `README.md` billing table (:2747) and the yearly figures in `CHANGELOG.md`/`public/changelog.json` 1.30.0 notes only if they state prices as current
- Test: `test/billing-core.test.mjs` (rate chain), `test/billing-routes.test.mjs` (rate fields), `test/billing-flow.test.mjs` (yearly totals)

**Interfaces:**
- Produces: `GET /api/billing/plans` → `rate: { rate, source, at }` where `source ∈ 'frankfurter' | 'vietcombank' | 'erapi'`; the client shows one line and the Exchange Rate API link only when `source === 'erapi'`. `refreshRate({ now })` exported from fx.js and called by the 06:00 cron.

Rules (spec §6):
- Source order: `frankfurter` → `vietcombank` (bank-transfer row) → `erapi`.
- Fetched once a day by the 23:00 UTC cron (06:00 Vietnam). Between runs the stored rate (setting `billing_fx`) is used; the one-hour in-memory freshness becomes "fresh until the next 06:00 Vietnam time". A cold start with no stored rate, or one older than 48 h, fetches on demand as today; older than 48 h with every source down stays `BillingUnavailable`.
- Yearly: plus 5000, pro 8000, max 15000 USD cents (ten months' price). Monthly unchanged.
- Payment codes never start with 0 (owner set SePay's code structure to SZ + 10 characters, "Số nguyên", and the webhook to send only transfers carrying a code; a leading zero may not count as an integer there): `newPaymentCode` draws from 1,000,000,000 to 9,999,999,999 in server/billing/codes.js, with a test.

- [ ] **Step 1: Failing tests:** the chain asks Frankfurter first and uses Vietcombank only when Frankfurter fails, Exchange Rate API last; `refreshRate` stores the rate with its source and time; a second `usdVnd()` the same day does not fetch; after the next 06:00 VN boundary it is stale for the cron but still usable; the cron route calls `refreshRate`; yearly prices are 50/80/150 USD everywhere they are pinned; `/plans` gives `rate.source`.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Keep the plausibility band checks (0.5×–2× of the anchor, ±20% of a <48 h last rate).
- [ ] **Step 4: Run** billing-core, billing-flow, billing-routes, billing-docs, features, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(billing): the rate from Frankfurter once a day at 06:00; yearly plans save 17%`.

### Task 8: The plans sheet, laid out like Claude's

**Files:**
- Modify: `public/js/billing-plans.js` (the sheet view), `public/css/app.css`, locales, `server/routes/billing.js` + store prefs (Team interest), `public/js/billing-admin.js` (Team interest count)
- Test: `test/ui-billing.test.mjs`

**Interfaces:**
- Consumes: Task 7's `rate.source`; existing `createPlansSheet` API (`open`, `openCheckout`, `openTopUp`) unchanged.
- Produces: `POST /api/billing/team-interest` (signed-in, billing visible) → `{ ok: true }`, stored once per account in its preferences with the date; the admin figures gain `teamInterest: number`.

Exactly as spec §6 "Plans sheet": segmented **Cá nhân · Nhóm**; four cards with our own line icons, tagline, price + second line, button, divider, "Mọi thứ trong … và:" ticks; one Monthly/Yearly toggle state shown in each paid card with "Tiết kiệm 17%"; "Không ràng buộc · Huỷ bất cứ lúc nào" under monthly buttons; the monthly-plan info box and "Chuyển sang <Plan> theo năm" on the current plan's card; pay-as-you-go line; the one rate line ("Tỷ giá cập nhật lúc HH:MM, DD/MM/YYYY", Vietnam time) with the link only for `erapi`; the Team tab card with "Báo tôi khi mở". Everything the sheet does today stays (preview note for administrators, `later` periods, renewal in grace, rate-null behaviour, keyboard, live regions, 360 px).

- [ ] **Step 1: Failing checks:** the segmented control has Individual and Team, no month/year at the top; four cards in order with icon, tagline, price lines and ticks; the toggle in a paid card switches every paid card and the second line; the "Không ràng buộc" line only under monthly; a member on Plus monthly sees the info box and "Chuyển sang Plus theo năm" which opens checkout on yearly; the rate line has no link for Frankfurter and has the link for erapi; Team tab → the card → "Báo tôi khi mở" stores once and says so; the admin card shows the count; both themes readable (contrast 4.5:1 on the new text); 360 px no sideways scroll; keyboard reaches every control.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.** Icons are inline SVG drawn for Synapsez (no external images, nothing copied from Anthropic).
- [ ] **Step 4: Run** `node test/ui-billing.test.mjs`, billing-routes, i18n, features, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(billing): the plans sheet laid out like Claude's — Individual and Team, the year inside each card`.

### Task 9: Checkout as "Configure your plan"

**Files:**
- Modify: `public/js/billing-plans.js` (the checkout view), `public/css/app.css`, locales
- Test: `test/ui-billing.test.mjs`

Exactly as spec §6 "Checkout": back arrow and "Thiết lập gói của bạn"; left — two radio cards (month / year with "Tiết kiệm 17%"), the inline billing-information form prefilled from the profile (saved with the order, as the profile save does today), payment method (VietQR via SePay; "Dùng số dư (x ₫)" when there is a balance); right — summary card (plan, line, credit, subtotal, tax line only when `BILLING_TAX_RATE` is set, total due today), the auto-renew info box with the real date, the consent checkbox that enables **Đăng ký**, the locked-rate line; then the QR step as today.

- [ ] **Step 1: Failing checks:** radio cards switch the summary; the badge on yearly; the form is prefilled and an edit is saved; the consent box disables **Đăng ký** until ticked and its text names the renewal and the cancel place; the auto-renew line shows the right date for month and year; no tax line without `BILLING_TAX_RATE`; a renewal in grace still shows the locked price; the QR step and its live status unchanged; keyboard and 360 px.
- [ ] **Step 2: Run** — fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node test/ui-billing.test.mjs`, i18n, features, lint, typecheck — pass.
- [ ] **Step 5: Commit** `feat(billing): checkout as Configure your plan — consent before paying`.

### Task 10: Release 1.31.0

**Files:**
- Modify: `package.json` (1.31.0), `public/changelog.json` (1.31.0, vi and en, same array lengths), `CHANGELOG.md`, `README.md` (Users page, guide, compaction rule), `test/features.test.mjs` (pins: compaction 10% / 4,000; top 10 / 20 a page; yearly 50/80/150 USD; Frankfurter first)
- Memory (controller): `admin-dashboard-and-quick-fixes-decisions.md` — what shipped.

- [ ] **Step 1:** Write the features pins; run `node test/features.test.mjs` — fails until the docs and version are in.
- [ ] **Step 2:** Update the files.
- [ ] **Step 3:** Run `node test/features.test.mjs`, `node test/billing-docs.test.mjs`, `node test/i18n.test.mjs`, `node test/deploy.test.mjs`, lint — pass. (The controller runs the gate and `test:ui`.)
- [ ] **Step 4: Commit** `release: 1.31.0 — a leaner Users page, the guide, keys one at a time, compaction by size`.
