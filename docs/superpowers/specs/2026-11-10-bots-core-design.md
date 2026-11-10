# Bot page — fixes and core (spec A) · 2026-11-10

Owner requests of 2026-11-10 ("Yes full all", plus eight screenshots), and the
research into OpenBot, DS Bot and dsh-superagent
(`scratchpad/research/{openbot,ds-bot,dsh-superagent}.md`). This spec is wave 1 of
four: A (this), D (finance, built alongside), B (team features), C (triggers from
outside). It also carries one request outside the Bot page: §E.

Licences: OpenBot is PolyForm Noncommercial — ideas and behaviour only, never its
code or words. DS Bot is Apache-2.0 — design only, as NOTICE already says.
dsh-superagent is MIT — the "how bots speak" rules (§A.8) are written in our own
words after its `prompts/team/communication.md`; NOTICE gains its copyright line
and MIT text.

## 0. What the screenshots showed, and why (root causes, read in the code)

| # | Seen | Cause |
|---|---|---|
| 1 | Bots stop when the person leaves the Bot page; Chief never answers; "I made a .docx" but no file | A group round is **one function invocation** (`ROUND_BUDGET_MS` 285 s inside Vercel's 300 s). Three researching bots plus a .docx run past it and the invocation is killed mid-round: no "out of time" notice, no report turn, and **nothing resumes it** — `listCutOffRuns` skips every chat with `bot_group_id` (server/store/pg.js:1797). Leaving the page is not the cause (the page never stops the round). |
| 2 | The .docx a bot said it made is nowhere | A member's group post copies only its **text** (server/bots/rounds.js:192); files it made stay in its hidden per-group conversation. |
| 3 | Green dot on the group row | `botdot` = "running": the round's lease was renewed in the last 75 s (server/routes/bots.js:38). True while the round lived, never explained, and a killed round left nothing after it. |
| 4 | The yellow ring stutters | `renderWorking()` rebuilds the working rows' `innerHTML` on **every streamed token** (public/js/bots.js:352): each rebuild makes a new spinner, whose rotation restarts at 0°. |
| 5 | The group chat does not look like the home chat | Group lines draw their own opaque bubbles (`.botmsg__bubble` `--surface-2`; the person's in `--accent`), public/css/app.css:12298. |
| 6 | The details pill opens/closes with a jump | `details.hidden` flips and the grid column snaps (bots.js:372). |
| 7 | "Quản lý ›" reloads, its arrow does not turn | It flips `memoryOpen` and calls `renderDetails()`, which blanks the panel to a spinner and fetches memory, usage and tasks again (bots.js:385, :941); "›" is text. |
| 8 | "Đã ghi nhớ" in red | A failed step keeps its success label — every tool (public/js/render.js:2457, :2972). The save failed because Chief wrote 327 characters against the 300 limit. |

## A0. The screenshots, fixed

**A0.1 Rounds finish, whatever the page does.** A round becomes a series of
*segments* over one durable `pending` record on the group:

- `bot_groups.pending jsonb` (schema 44): `{ messageId, queue: [{ botId, by, report, resume }], handoffs, segments, model, reason: 'time' | 'ceiling' | 'chief' | 'task', at }`. Written after **every** batch (not only at the end), so a killed invocation loses at most the batch in flight.
- A member turn cut off mid-step is not started again: its queue item carries `resume: true`, and the next segment calls `runAgent` on that member's own group conversation without a new round prompt — the agent loop resumes exactly where it stopped (finished calls keep their results; a change-making call is never run twice, server/agent.js `resumableCalls`).
- **Out of time** (the 40 s floor): the segment saves `pending`, posts nothing alarming, and chains itself — `waitUntil(fetch(PUBLIC_URL + '/api/internal/bot-rounds/continue', { Authorization: Bearer CRON_SECRET, body: { userId, groupId } }))`. The next invocation claims the group's lease and runs the next segment. At most **8 segments** per person message (≈ 38 minutes); then a notice offers Continue.
- **Killed** (no time to chain): the heartbeat's new phase `resumeGroupRounds` finds group logs whose lease is stale and whose `pending` is set, and runs the next segment (counts toward the 8). `listCutOffRuns` keeps excluding group chats; groups have their own path.
- **The hand-off ceiling** (6 per person message, across all segments) still stops the round; that stop saves `pending` with `reason: 'ceiling'` and waits for the person: a **Continue** button on the notice, or a message that is only "continue / tiếp tục / go on / làm tiếp".
- **Model**: `pending.model` is the chip's model when the person wrote. Changing the chip while a group is open sends it to the group (`PATCH /bot-groups/:id/model`), and every next batch reads it — the round carries on, on the new model.
- **Watching**: the tab that sent the message streams it as today. Any other view (coming back, another tab, after a chained segment) polls `GET /bot-groups/:id/live?since=<seq>` every 1.5 s while the group is open, visible and running: new lines + who is working on what (`members: [{ bot, tool, since }]`, kept in `pending.working`). No polling when hidden or idle.
- A bot's **own chat** is the home chat and already survives the page (its cut-off turns resume from the heartbeat, server/resume.js); unchanged.

**A0.2 Files made in a group show in the group.** When a member's turn ends, the
files it created or changed in that turn (attachments of its group conversation
newer than the turn's start) go onto its group post as `files: [{ id, name, mime, size }]`;
the group log draws them with the home chat's file card (open, download, share).
Same for a report turn. A turn that only made a file and said nothing still posts
"(made a file)" with the card, never silence.

**A0.3 A ring that turns evenly.** Working rows are keyed by bot and created once;
a token updates only the text node, batched to one `requestAnimationFrame`; the
spinner element and the face canvas are never recreated while the bot works. The
ring stays `transform`-only (compositor); `prefers-reduced-motion` keeps today's rule.

**A0.4 The group chat looks like the home chat.** Group lines use the home
transcript's look: a bot's reply is prose with no bubble over the theme, under a
header of face + name (+ Quản trị tag); the person's line is the home chat's own
bubble; notices and stamps as now. Message actions (copy, time) as in the home
chat. The theme behind stays visible, as in screenshot 5.

**A0.5 The dot says what it is.** The running mark becomes the same small ring as
the working rows, with `aria-label`/tooltip "Đang làm việc", and the row's preview
line says "{Name} đang làm…" (the name of a member at work, from `pending.working`).
An unread mark (B) is a different, plain dot.

**A0.6 The details panel opens and closes smoothly.** The panel slides and fades
(transform + opacity, 220 ms, standard easing) while the chat column eases its
width; the pill's arrow turns with it. Reduced motion: instant. No layout jump of
the transcript (its scroll position is kept).

**A0.7 Reset a conversation.** "Đặt lại cuộc trò chuyện" at the foot of the details
panel, for a bot and for a group. One confirm dialog says what goes (every message
and file of this conversation; for a group, also every member's conversation for
this group and where each had read to) and what stays (memory, instructions,
members, scheduled tasks). It **deletes the rows** (messages, attachments and their
blobs, member group chats, `seen`, `pending`) — no soft delete, so the space is
freed. Refused while a round or turn runs (the dialog offers Stop first). Chief's
chat can be reset too; Chief itself stays.

**A0.8 Memory opens in place.** "Quản lý" toggles the memory list where it is:
no panel redraw, no new request (entries come with the details' first read and
are kept current after add, edit, forget). The chevron turns 90° (transform
transition) and the list opens with a height transition (`interpolate-size` where
supported, instant elsewhere). `aria-expanded` follows.

**A0.9 A memory entry that is too long is split, not refused.** Text is normalised
to NFC before counting (decomposed Vietnamese counts each mark). Over 300
characters, it is split at sentence ends (., !, ?, ;, line breaks) into entries of
≤ 300; refused only when one sentence alone is longer, with the reason. The tool
description states the same rule (and the drift test, A.10, checks the number).

**A0.10 A failed step says it failed** (the bug class, every tool). A step whose
result is an error shows a failure label — "Không ghi nhớ được", "Tìm kiếm không
thành công", … — from `step.<tool>.failed` keys, falling back to "{Tên bước} — không
thành công". Both languages; i18n tests cover every tool that has a step label.

## A. Fixes and core

**A.1 Only a person reshapes the team.** Every turn gets a server-set `origin`:
`person` (typed in this conversation by the signed-in person), `handoff` (started
by another bot in a round), `task` (scheduled), `webhook` (C), `review` (A.6).
`create_bot`, `create_group`, `update_group`, and `update_bot` on another bot or on
its own instructions are refused unless `origin === 'person'`; the refusal tells
the bot to ask the person in its own chat. In a group turn, another bot's lines
count as outside content for the approval gate (`turnReadOutside`), so a held
write becomes "needs your yes", never silent. Tests per origin.

**A.2 A round never ends in silence.** When a bot's hand-offs come back, the asker
always gets its turn, told who answered, who passed and who failed ("X gave no
answer — do not wait for it"). If the admin was the only one called and passed:
notice "Không ai trả lời — gọi một thành viên bằng @Tên". The `seen` mark moves
only after a member's turn ends well; a failed or stopped turn leaves its lines
unread.

**A.3 Continue.** As A0.1. The Continue notice/button resumes exactly the saved
queue; any other message from the person clears `pending` and starts fresh.

**A.4 Writing while a group answers.** No more 409. The line is stored and shown at
once; the running segment reads new person lines between batches and queues whom
they call (the admin, or those named) — never counted against the ceiling.

**A.5 Group notice and live status.** `bot_groups.notice` (≤ 2,000 characters),
editable in group settings and by Chief's `create_group`/`update_group`, read at
the top of every member's round prompt (not the system prompt), shown folded to
five lines in group details. `list_bots` adds each bot's state: idle, "busy in its
own chat", or "answering in group G", from the leases.

**A.6 Memory that keeps up.**
- **Edit / replace**: `remember` takes `replace` (an entry's id or text); the panel gets Edit (PATCH).
- **Pin**: `bot_memory.pinned`; pinned entries enter the prompt first. A pin the person set cannot be changed by a bot.
- **Recall**: `recall(query)` searches all of the bot's (and, in a group, the group's) entries — `text_folded` (lower-case, diacritics removed in JS, so no database extension) with `ILIKE` per word, newest first, ≤ 20 hits. The prompt keeps pinned + newest within 4,000 characters and says how many more are a `recall` away. Cap rises 60 → 200 entries.
- **Undo**: `bot_memory.deleted_at` (soft delete for 30 days, swept). After a turn that saved or forgot, one line "Đã lưu 2, đã quên 1 · Hoàn tác". After `update_bot` changed instructions: "Chief đã đổi hướng dẫn của Writer · Xem · Hoàn tác" (`bots.instructions_prev`; undo only if nothing changed since).
- **A stopped or failed turn takes its saves back**: entries carry `turn_id`; on abort or error, that turn's entries are removed.
- **Frozen per conversation** (prompt cache): the memory section is taken once per conversation (`chats.memory_snapshot`, `memory_snapshot_at`); later turns add one short "Saved since this conversation began: …" message at the end instead of changing the system prompt. Group memory and the member list move from the system prompt into the round prompt. Measured before/after with the cache share already on screen.
- **Review** (owner: "both automatic"): every 20 completed turns of a bot conversation, one tool-less call on the free Auto model reads the turns since the last review and the bot's entries and answers add / update / forget as JSON; applied through the same checks; never touches entries the person wrote or pinned; booked to the bot in usage. Bot settings: Off / every 20 / every 40 (default every 20). Runs after the turn via `waitUntil`, never inside a round.

**A.7 Questions.** `ask_options` question cards work in a bot's own chat (the
withhold at agent.js:1708 predates the home-chat lending). In a group, a member can
`ask_person(question)`: it ends its turn with the question shown as a card in the
group; the person's next plain line there goes to that bot first, not the admin.
A new question from the same bot replaces the old.

**A.8 How bots speak** (after dsh's communication contract, in our words): one
short sentence unless the work itself is long; report results, not plans; no
"thanks / got it / on it" posts between bots; a relayed result starts with whose
it is; never claim a check without a tool result; never hand work back to whoever
gave it. In code: a member post that is only an acknowledgement (≤ 8 words, no
mention, no file) counts as a pass; a called member whose reply has no tool call
and only promises ("I'll …", "Tôi sẽ …") runs once more (counted as a hand-off).

**A.9 Mentions read the same on both sides.** `@Name` inside a Markdown link, or
followed by `.letter` or `\`, calls nobody — server (bot-mentions.js) and page alike;
tests beside the existing ones.

**A.10 Prompts stay true to the code.** A test collects every model-facing string
(system prompt branches, bot prompt sections, tool descriptions, refusals) and fails
when a tool name it mentions does not exist for that role, when an "at most N" in
the text differs from its constant (memory entry 300, entries 200, hand-offs 6,
notice 2,000, …), or when a role's prompt + tools grows more than 5 % over today's
measured size.

**A.11 Tidy.** Remove `soloHtml`/`eventLine` (bots.js, unreachable since bot chats
moved into the home transcript); correct bot-avatar.js:11 (the details face is still).

## E. Suggested models changed — tell everyone once

When an administrator changes the suggested models (Settings → admin → suggested
models; `setRecommended`), the change gets an id (`recommended.version`, a time
stamp). Every account sees one notice — at its next visit, or within the 20-second
worker poll if it is on the page at that moment — "Mô hình gợi ý đã đổi: {free} /
{paid}" with **Dùng mô hình này** (when the account is not already on it) and
**Để sau**. Either answer, or closing it, stores `seenRecommended = version` for the
account; a later change shows again. An account that never chose a model already
follows the suggestion (as today) and is told it moved. Nothing shows for a change
made before the account existed.

## Data (schema 44, one migration)

- `bot_groups`: `pending jsonb`, `notice text`, `model text`.
- `bot_memory`: `pinned boolean default false`, `pinned_by text`, `text_folded text`, `turn_id text`, `deleted_at timestamptz`, `updated_at timestamptz`; index `(user_id, bot_id) where deleted_at is null`.
- `bots`: `instructions_prev text`, `instructions_changed_by text`, `review_every int default 20`, `turns_since_review int default 0`.
- `chats`: `memory_snapshot text`, `memory_snapshot_at timestamptz`.
- messages in a group log may carry `files` (in the message JSON, as the home chat's do).
- Sweep: soft-deleted memory after 30 days.

## Routes

`POST /bot-groups/:id/continue`, `GET /bot-groups/:id/live`, `PATCH /bot-groups/:id/model`,
`POST /bots/:id/reset`, `POST /bot-groups/:id/reset`, `PATCH /bots/:kind/:id/memory/:entry`
(edit, pin), `POST /bots/memory/undo`, `POST /bots/:id/instructions/undo`,
`POST /api/internal/bot-rounds/continue` (CRON_SECRET only), `POST /api/models/suggestion/seen`.
Every route scoped to the account; other accounts' ids 404 (as today).

## Testing

- bots.test: origin gate per origin; asker report turn on all-pass and all-fail; admin-passed notice; seen only after success; pending written per batch; time cut → chained segment (fake fetch) resumes the queue and a cut-off member turn without a second prompt; heartbeat resumes a stale group; 8-segment cap; ceiling → Continue; person line during a round; notice in round prompt; files on the group post; reset deletes rows and keeps memory; memory split/NFC, replace, pin, recall (Vietnamese without marks finds marked text), undo, turn rollback, snapshot + "saved since" message, review applies only allowed changes; mention parity.
- ui-bots (headless Chrome): ring element identity kept across 50 tokens; group lines without bubbles; details open/close transition runs and ends at the right size; memory toggle makes no request and turns the chevron; reset dialog; Continue button; live polling shows a line written by another "tab".
- render/i18n: failure label for every step label key, vi and en.
- E: version stored; notice once per change, shown on boot and on the 20 s poll; "Use" sets the default.
- A.10 drift test.

## Not in this spec

Team features (B), webhooks / waits / Telegram (C), finance (D).
