# Bot page — team features (spec B) · 2026-11-10

Wave 2, on top of spec A (the `pending` queue, questions, origins, memory
upgrade). Ideas from OpenBot (behaviour only), DS Bot (design), dsh-superagent
(MIT); research in `docs/research/2026-11-10-*-study.md`. Every item keeps the
rules that make Synapsez safer than all three: account scoping, the approval gate,
the hand-off ceiling, incognito, a private chat never entering a group.

## B.1 Chief starts a group's work

`post_to_group(group, message)` (Chief only, `origin: person` only): writes the
message into the group as "Chief: …" and queues a round from it — the same
`pending` record as Continue (`reason: 'chief'`), started at once through the
self-chained continue route, so Chief's own turn is not held up. Chief's tool
result says it started; the group shows the work; Chief's chat gets one line when
the round ends ("Tài liệu & Nghiên cứu xong — xem nhóm"). Same ceiling and budget.

## B.2 Needs you

A strip at the top of the Bot list, shown only when something waits: questions
from bots (A.7), approvals waiting in a bot's chat, rounds stopped at the ceiling
(Continue), failed scheduled runs (B.4), open waits that a person must close (C.2).
Each row: face, one line, and its action (Trả lời / Xem / Tiếp tục / Thử lại).
Counts equal the rows. Healthy takes no space. Read from one route
(`GET /bots/attention`) with the team read.

## B.3 The list says what is going on

- **Unread** dot (plain) when a bot or group said something since the person last opened it (`chats.read_seq` per conversation).
- **Working** ring (A0.5) with "{Name} đang làm…" as the preview.
- **Needs you** mark (amber) when B.2 lists it.
- **Pin** (pinned first, then by activity) and a row menu (right click / long press / ⋯): Mở, Cài đặt, Ghim, Tạm dừng, Nhân bản, Xuất, Xoá.
- In a running round, a strip of who is called with each one's state: được gọi → đang làm (tool in plain words: "đang tìm trên web", "đang viết tệp") → đã trả lời / bỏ qua / lỗi. Tool names map to the same phrases the home transcript uses.

## B.4 Scheduled runs that know when to keep quiet

- `no_update()` in scheduled (and webhook) runs: nothing worth saying — the answer folds under the run's marker, no unread, no mail, no preview change.
- `run_failed(reason ≤ 300)`: the run is marked failed with the reason in the task list and B.2.
- The task tool's description and the bot prompt say: each run starts from the newest messages only, so the prompt must say what to check, how, what to report, and when to report nothing.
- Missed runs (the daily cron makes misses normal): per task `missed: skip | once` (default once — run at the next nudge, then keep the schedule).
- **Group tasks**: a task can belong to a group; its run posts the prompt as the person's line and runs a round from `pending` (`reason: 'task'`). Shown in the group's details only.

## B.5 Managing bots

- **Pause** (`bots.paused_at`): its tasks pause, it is not called in groups (a call to it gets "X đang tạm dừng"), its chat stays readable; Resume skips missed runs.
- **Duplicate**: name "X (bản sao)", same role, instructions, face (next hue), memory copied, tasks copied paused.
- **Export / import** (JSON, `synapsez-bots/1`): bots, groups, notices, memory (no secrets — the memory check runs again on import), task prompts and schedules (imported paused). Import shows what it will add and adds each item or none (per-item rollback); names that clash get " (2)".
- **Migrate from another assistant**: a ready prompt (vi/en) the person pastes into ChatGPT/Gemini/Claude that answers in the export format (≤ 60 facts of ≤ 300 characters), then imports it.
- **Colour**: a hue picker in the bot form (the `hue` column exists).

## B.6 Ask aside

"Hỏi riêng" in a bot's chat: one tool-less call on the chip's model with the bot's
persona and the last 60 messages; the answer shows in a side card, is never stored
in the conversation or memory, and does not touch the cached prefix. The tab keeps
the last 5 Q&A until reload.

## B.7 First run

Chief's empty chat shows, with no model call: four goal toggles (Viết & nội dung,
Nghiên cứu, Lập trình, Việc cá nhân) and the suggested bots for them (name, role,
instructions — editable before saving); Tạo creates them and a group if more than
one was picked. Chief's instructions say how to interview for anything else: one
question per message, a recommended answer with each, never ask for secrets in chat.

## B.8 Usage

- The total tile compares with the span before ("+18 % so với 7 ngày trước").
- A bot's row opens its drill-down: tokens by kind (input, cached, output, reasoning), models used, groups it worked in, scheduled vs typed.
- Cost beside tokens (usage_events.cost_usd), since it is billed.
- Memory review (A.6) and ask aside (B.6) are their own lines.

## Data (schema 46)

`bots.paused_at`, `bots.pinned_at`, `bot_groups.pinned_at`, `chats.read_seq`,
`scheduled_tasks.bot_group_id`, `scheduled_tasks.missed text default 'once'`,
`scheduled_tasks.last_status`, `scheduled_tasks.last_error`.

## Testing

bots.test: post_to_group refused for non-Chief and non-person origins, runs a
round; attention list contents and counts; pause excluded from rounds; duplicate
copies memory and pauses tasks; export→import round trip, clash names, secret
check on import, rollback on a bad item; no_update folds and leaves no unread;
run_failed recorded; missed once/skip; group task runs a round. ui-bots: Needs you
strip, unread/working/needs marks, row menu with keyboard, member state strip,
first-run card creates bots without a model call, ask aside not stored, usage
compare and drill-down.
