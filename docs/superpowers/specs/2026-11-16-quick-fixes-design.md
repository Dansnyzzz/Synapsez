# Quick fixes (1.31.0) — design

Owner's request 2026-11-15 (screens of Settings → Users, the getting-started guide, the Progress panel and
compaction). Decisions already taken by the owner are marked **(owner)**; the rest are proposals in this
document, approved when the owner approves it.

Out of scope here, each with its own spec later: the `/admin` page (dashboard) and its books + draft tax
forms tab; the provider videos in the guide (need the Chrome extension connected, or the owner's own
recordings).

---

## 1. Settings → Administration → Users

**Keep only (owner):** Users, Administrators, Recommended models, Free allowances. Themes, Billing and Security
activity move to the `/admin` page **when that page is built** — until then they stay where they are, so
nothing an administrator uses today disappears in between.

**Notes removed (owner):** `admin.lede` (the ALLOW_SIGNUP paragraph), `recommend.lede`, `freetier.lede`, and
the `freetier.enforced` / `freetier.enforcedFallback` status line. The monthly share stays visible to each
person in Settings → Usage ("This month's free share"), so nothing is hidden from members.

**Recommended models saves itself (owner).** No Save button. Each of the three selects saves on `change`
(`PUT` as today, one field at a time is not needed — the whole trio is sent). While saving, the select is
disabled; on success a quiet "Saved" line beside it (polite live region), on failure the select goes back
to the value it had and the error is shown under it. A change made while one is still saving waits for it.

**Users list (owner):** the top 10 accounts by tokens used this month, highest first, then a **See all**
button. See all opens a full-screen dialog listing every account, 20 a page, with ← and → buttons on both
sides and "Page 2 of 7" between them; keyboard: ← → move pages when focus is not in a text box, Esc closes.
Each row keeps today's facts and buttons (chats, tokens this month, worker paired, unconfirmed, suspended,
limit; Limit / Suspend / Remove as the viewer's permissions allow).

Server: `GET /api/admin/users?page=1&size=10` (size 1–50, default 20) answers
`{ users, total, page, size }`, sorted by tokens this month (desc), then name. The paging is in SQL
(`LIMIT/OFFSET` over the same query `listUsers` runs today), so the page never loads every account at once.
The owner's Administrators card still needs every administrator: it gets them from
`GET /api/admin/users?role=admin` (all administrators, not paged — there are few). Permissions unchanged:
`users` or `delete_users` to see the list.

## 2. Getting-started guide

**Tabs scroll sideways (owner).** When the step tabs do not fit, the row scrolls horizontally with a thin bar
on a transparent track (no background band), the current tab is scrolled into view when it changes, and
soft fades at the edges say there is more. Touch and trackpad scroll it; arrow keys already move between
tabs.

**A to Z (owner asks whether it is complete).** Today: 1 What Synapsez does · 2 API key · 3 Model & limits ·
4 Cloud computer · 5 Freedom level · 6 First task. Missing for a new person: where their work lives and how
to make it carry on without them. **Owner chose (2026-11-16) one step, added before "First task":**
- **Automations & Bot** — schedule a task, the Bot page, what runs while you are away.

That makes seven steps (Projects & files, Connectors & skills and Memory & privacy were offered and not
chosen). The new step follows the guide's existing rule: every sentence is held to the code
or an official page and pinned by the "getting-started guide says only what is true" checks in
`test/features.test.mjs`, and gets a recorded clip from `npm run onboarding:record` like steps 1, 4, 5 and 6.

**Provider videos (owner): later** — the step 2 illustrations stay until the videos exist.

## 3. Adding keys in the guide: one at a time, checked as you paste

**(owner)** One key per box. Pasting into the box checks the key at once — no "Add key" press — with
"Checking the key…" while it runs:
- right key for this provider → ✓ "Added", the box locks, and a new empty box appears below for another key;
- a key for another provider → the existing intake-by-shape moves it there (built in 1.7.0) and says so:
  "That is an OpenRouter key — added to OpenRouter";
- refused (wrong, expired, no credit) → the box stays, red, with the provider's reason; no second box until
  the first is good;
- typing (not pasting) checks after a pause, or on Enter.

A plain line under the box **(owner)**: "One key per account. Several keys from the same account share that
account's limit, so a second key only helps if it comes from another account." Where the provider lets us
tell two keys of one account apart (OpenRouter's `/api/v1/key`, already used), the second key from the same
account is refused with that sentence. Settings → Providers keeps its own box as it is.

## 4. Progress panel

**(owner)** On the "N earlier steps" button, the up chevron shows only on hover or keyboard focus (like
Claude); "Hide earlier steps" keeps its chevron always, as now. Opening and folding the earlier steps slides
(height and opacity, about 200 ms, ease-out); with `prefers-reduced-motion` it changes at once.

## 5. Compaction

**Live % (owner).** "Compacting the conversation…" gets a percentage at the right of the same line, the
same figure the bar shows. It is the share of the summary written so far against the summary's expected
length (estimated from how much is being folded, bounded by the summary's own token limit), held below
100 until the summary is saved, then 100. It never moves backwards.

**Keep recent turns by size, not count (owner).** Today the last 8 messages are kept word for word
(`KEEP_RECENT = 8`), so a long report among them stays and a chat can still be 30% full after compacting.
New rule:
- The verbatim tail is chosen by tokens: walk back from the newest message, adding whole turns while the
  tail stays within **10% of the model's window** (at least 4,000 tokens).
- The person's latest message and everything after it are always kept, whatever their size.
- A turn is never split from its tool results (today's `tailStart` rule).
- Everything older — long outputs included — goes into the summary.
- "Should we compact?" asks whether there is anything older than the tail to fold, instead of comparing
  with 8.

The parts that can never be compacted (tool list, system prompt, memory, skills, room kept for the reply —
about 13% of a 262K window in the owner's chat) are unchanged; with the new tail a chat like the owner's lands
near 15–20% after compacting.

## Testing

- Server: paging and sort of `/api/admin/users` (store-level and route-level, permissions); compaction tail
  by size (a huge old reply is folded, the latest question is always kept, tool pairs never split, the
  small-window floor); the % never decreases and ends at 100.
- Browser: no Save button and each select saves on change (and reverts on a refused save); top 10 + See all
  dialog paging with buttons and keys; the guide's tabs scroll and keep the current tab in view; one-key
  paste flow (good, wrong provider moved, refused); the chevron only on hover/focus; the slide, and none
  under reduced motion; the % beside the compaction line.
- `features` pins for every new guide sentence; i18n for every string in vi and en.
- Gate + `test:ui` before release 1.31.0.

---

## 6. Billing screens like Claude's, the rate once a day, yearly saves 17% (owner, 2026-11-16)

Asked with screens of Synapsez's plans sheet and checkout next to claude.ai's upgrade pages. Decisions taken
the same day: Frankfurter first (no attribution needed); a "coming soon" Team tab; yearly prices that save 17%.

**Rate.** Order of sources becomes **Frankfurter v2** (`/v2/rates?base=USD&quotes=VND`: about twenty central
banks blended, no key, no attribution, MIT) → Vietcombank's transfer rate → Exchange Rate API (open access;
its terms require a "Rates By Exchange Rate API" link, so that link shows **only on a day its rate is the one
in use**). The rate is fetched **once a day at 06:00 Vietnam time** by the existing 23:00 UTC cron
(`/api/cron/refresh-models`); between runs the stored rate is used. On a cold start with no stored rate, or a
stored rate older than 48 hours, it is fetched on demand as today; older than 48 hours with every source down
is still `BillingUnavailable`. Every page shows a single line: "Tỷ giá cập nhật lúc 06:00, 16/11/2026" (the
time it was fetched), plus the small link only when the source is Exchange Rate API. The checkout keeps its
own line saying which rate the order is locked at.

**Yearly prices save 17%:** a year is ten months' price — **Plus 50, Pro 80, Max 150 USD** (was 57/91/171).
Monthly prices unchanged. Worst-case margin (a person using everything included, every month) on a yearly
plan falls from about 37% to about 28%; monthly plans keep about 40%. Saved as "Tiết kiệm 17%".

**Plans sheet (Claude's layout, our own drawings).**
- Title "Các gói lớn lên cùng bạn". Under it a segmented control **Cá nhân · Nhóm** (Individual · Team) —
  not month/year.
- Individual: four cards, Free · Plus · Pro · Max (four columns when wide, two when medium, one on a phone).
  Each card: a small line icon of our own (growing richer from Free to Max — not Anthropic's drawings), the
  name, a one-line tagline, the price large with "/ tháng" and a second line ("thanh toán hằng tháng", or
  "1.285.000 ₫ thanh toán hằng năm" on yearly), the button, then a divider and the list: Free lists its own
  lines; Plus "Mọi thứ trong gói Miễn phí, và:"; Pro "Mọi thứ trong Plus, và:"; Max "Mọi thứ trong Pro, và:",
  each line with a tick.
- **Monthly / Yearly · Tiết kiệm 17%** is a small toggle inside each paid card, one state for all three cards.
- Under a monthly button: "Không ràng buộc · Huỷ bất cứ lúc nào". Buttons: a light filled button with dark
  text for paid plans, a dark one for Free (theme tokens, both themes).
- **On a monthly plan** (owner, image 3): that plan's card shows an info box — "Bạn đang trả theo tháng. Trả
  theo năm để tiết kiệm 17%." — and its button becomes "Chuyển sang <Plan> theo năm".
- Under the cards: the pay-as-you-go line, then the one rate line.
- **Team tab (owner: coming soon):** one card — "Gói nhóm sắp ra mắt", what it will bring (several people,
  shared management, a price per seat), and **"Báo tôi khi mở"**, which records that this account wants to be
  told (kept with the account's preferences, shown to administrators as a count on the Billing card), then
  says "Đã ghi nhận — chúng tôi sẽ báo qua email."

**Checkout (Claude's "Configure your plan").**
- A back arrow, the title "Thiết lập gói của bạn".
- Left: two radio cards — "<Plan> theo tháng · <price> · Thanh toán hằng tháng" and "<Plan> theo năm ·
  <price> · Thanh toán hằng năm" with a "Tiết kiệm 17%" badge; then **Thông tin thanh toán** as an inline
  form prefilled from the profile (Họ tên, Quốc gia, Địa chỉ, Tên doanh nghiệp (tuỳ chọn), Mã số thuế (tuỳ
  chọn), Tên khác trên hoá đơn (tuỳ chọn)); then **Phương thức thanh toán**: VietQR bank transfer through
  SePay, and "Dùng số dư (x ₫)" when there is a balance.
- Right: a summary card — "Gói <Plan>", the line, any upgrade credit, Tạm tính, a tax line only if
  `BILLING_TAX_RATE` is set, **Tổng cần thanh toán hôm nay**; an info box "Gói tự gia hạn ngày <date> từ số
  dư; nếu số dư không đủ, chúng tôi gửi email kèm mã QR 3 ngày trước."; a consent checkbox (Synapsez takes
  the amount above now and renews it each period until you cancel, under the Terms; you can cancel any time
  in Settings → Billing) — the button **"Đăng ký"** stays disabled until it is ticked; then the QR step as
  today.
- Everything Tasks 9–10 of the billing plan built stays: locked renewal price, `later` periods unavailable,
  late answers ignored, refunds, the live status line.
