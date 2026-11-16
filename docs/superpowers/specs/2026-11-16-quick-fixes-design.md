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
to make it carry on without them. **Proposed — three steps added before "First task":**
- **Projects & files** — a project keeps its own chats, files and instructions; files you upload or the
  assistant makes are in Files; the 20-chat limit per place.
- **Connectors & skills** — connect Google Drive, Gmail and others; skills the assistant can use; where to
  turn them on.
- **Automations & Bot** — schedule a task, the Bot page, what runs while you are away.

That makes nine steps. Each new step follows the guide's existing rule: every sentence is held to the code
or an official page and pinned by the "getting-started guide says only what is true" checks in
`test/features.test.mjs`; each gets a recorded clip from `npm run onboarding:record` like steps 1, 4, 5 and 6.

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
