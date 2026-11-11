# OpenBot (nightly-labs/openbot) — research for the Synapsez Bot page

Researched 2026-11-10 from the clone at `scratchpad/repos/openbot-src/openbot` (read only; nothing run).
**Licence: PolyForm Noncommercial 1.0.0.** Synapsez may take ideas and behaviour only. Every description
below is a paraphrase written for this report: no code, prompt text or UI wording from OpenBot is to be
copied into Synapsez. Where a number is quoted, it is a fact about OpenBot's behaviour, not a constant to
paste.

Working notes with more raw detail: `scratchpad/research/openbot-notes.md` and `notes-02…notes-10*.md`.
`changelog-added.txt` is every "Added" bullet of the CHANGELOG (841 lines).

---

## 1. What OpenBot is

OpenBot is a local-first Electron desktop app (plus a web client and an iPhone app that connect to the
desktop "host" over WebRTC) that turns local coding-agent CLIs (Codex app server, Claude Code, Grok, OpenCode,
Gemini/Antigravity, Cursor, Cline, Kimi, Devin, Copilot, Mistral Vibe, Hermes, custom ACP agents) into
**persistent named "teammates"**. Each agent has its own workspace folder, instruction file, memories,
skills, routines (schedule or signed-webhook triggers), side threads, queue and provider session. Agents
message each other through a crash-safe mailbox, work together in shared **channels** (group chats with a
lead, task ownership, delegation, stop/continue/reassign/cancel), and can answer in Slack, Discord, Telegram
and WhatsApp through per-platform "Orchestrator" agents. Around this sit a skills library with immutable
revisions and background skill learning, a plugin marketplace (MCP server + pinned skills), workflows on a
canvas, an embedded browser with takeover/sign-in, Computer Use, a vault for keys, team sharing with roles,
and a local-scripts HTTP API. It is a very mature product (0.66.0, ~120 releases, 3,351 changelog bullets);
most of its ideas are about making long-running multi-agent work **safe, bounded, quiet and recoverable**.

---

## 2. Files read (coverage checklist)

OpenBot docs
- [x] `docs/glossary.md` (full)
- [x] `docs/architecture/agents.md` (full, 1,086 lines)
- [x] `docs/architecture/channels-and-messaging.md` (lines 29–75 notifications, 144–805: channels, context packet table, messaging connections, mobile queue; skipped iPhone Live Activity 3–28 and Android 115–143 detail)
- [x] `docs/messaging.md` (full: Slack, Discord, Telegram, WhatsApp, workspace memories, posts, limits, adding a platform)
- [x] `docs/architecture/providers.md` (1–365: tool discovery, history retrieval, memory review, skill suggestions, skill fixes, idle sessions, compaction; 1335–1430 backup models, usage pacing, reset credits; 1532–1585 context indication)
- [x] `docs/architecture/skills-and-plugins.md` (full)
- [x] `docs/architecture/events.md` (1–130: ownership, route lifecycle, inbound request, analytics; headings of the rest)
- [x] `docs/webhooks.md` (full)
- [x] `docs/status-webhooks.md` (full)
- [x] `docs/automation.md` (full: local scripts API)
- [x] `docs/architecture/servers.md` (135–215 new chat / compact / delete history / side questions / voice; 338–577 UI blocks, subagents, multi-select, context usage, queue window, browser control, skill events, focus/activity; 876–965 roles, audit log)
- [x] `docs/architecture/side-panel.md` (full)
- [x] `docs/ui-foundation.md` (full)
- [x] `docs/i18n.md` (1–30, 79–135; headings of the rest)
- [~] `docs/architecture/integrations.md` (1–148: sign-in kinds, MCP renew, multi-account MCP, member MCP access, MCP proxy; headings of the rest)
- [~] `docs/architecture/team-api.md` (first 40 lines: WebRTC transport — desktop-specific, not relevant)
- [x] `README.md` (intro, What works, Agent setup, Local skills, Import from Grok Bot, Chat attachments)
- [x] `AGENTS.md` (headings, Terms)
- [x] `CHANGELOG.md` (all 841 "Added" bullets extracted; 228 bot-relevant filtered; full text of 17 key bullets)

OpenBot resources
- [x] `resources/managed-skills/openbot-skill-creator/SKILL.md`, `openbot-data/SKILL.md`, `openbot-site-hosting/SKILL.md`
- [x] `resources/agent-import/grok-bot/SKILL.md` (full), `resources/agent-import/hermes-agent/SKILL.md` (first 40 lines + headings)

OpenBot source (verification)
- [x] `src/backend/openbot-tools.ts` (full tool catalogue and schemas)
- [x] `src/backend/channel-tools.ts` (full), `channel-replies.ts` (constants), `channel-service.ts` (routing constants and outcomes, lines 140–175), `channel-history.ts` (constants)
- [x] `src/backend/routine-tool-schema.ts` (full)
- [x] `src/backend/memory-store.ts` (full), `agent-memory-selection.ts` (full), `agent-memory-store.ts` (search), `agent/agent-memories.ts` (196–455: staging, review apply, tools), `agent/memory-tool-inputs.ts`, `agent/memory-changes-message.ts`
- [x] `src/backend/agent-waits/agent-waits.ts` (full)
- [x] `src/backend/agent/skill-tools.ts` (full), `agent/skill-loads.ts` (full)
- [x] `src/backend/agent/plan-continuation.ts` (comments + core), `agent/side-question.ts` (head), `agent/delivery-content.ts` (outline), `agent/openbot-tool-router.ts` (plan card, 935–1004), `agent/duplication-gate.ts` (head), `agent/usage-limit-gate.ts` (comments), `agent/memory-hold.ts`, `agent/step-labels.ts`, `agent/instructions-changes.ts` (comments)
- [x] `packages/contracts/src/input-limits.ts` (full), `ipc-agent-memories.ts` (full), `agent-memory-context.ts`, `ui-blocks.ts` (limits, states, auto-answer), `ipc-agents.ts` (AgentSummary, defaults), `ipc-queue.ts` (statuses, busy modes, delivery), `ipc-chat-channels.ts` (limits), `ipc-agent-tasks.ts` (task limits)

Synapsez (read only, for the gap analysis)
- [x] `server/bots/memory.js`, `prompt.js`, `rounds.js`, `team.js`, `tools.js` (all full)
- [x] `server/routes/bots.js` (full)
- [x] `public/js/bots.js` (header, outline, 340–470: working rows, details panel, tasks, memory), `bots-settings.js` (header), `bots-usage.js`, `bot-avatar.js` (outlines), `bot-mentions.js` (full)
- [x] headers of `server/scheduler.js`, `server/skills.js`, `server/subagents.js`, `server/memory.js`, `server/workflows.js`, `server/tools/askOptions.js`; `vercel.json` (maxDuration 300, daily crons); keyword survey of `server/` and `public/js/app.js`

---

## 3. Feature inventory

Each item: **Sees** (what the user sees), **Works** (mechanism, states, edge cases, failures), **Numbers**.

### A. Agents: creation, editing, identity

1. **Prompt-driven creation.** *Sees:* the user asks any agent for a new teammate; it appears in the
   sidebar. *Works:* `create_agent` takes a profile (name, title, instructions) plus a **first task**; the new
   agent inherits the creator's provider/model/effort unless the user asked for others (then `list_models`
   first); it also inherits the creator's access limits so a sandboxed agent cannot escape through a
   teammate. Skills and routines are added afterwards with the same tools that act on oneself
   (`install_local_skill`, `create_routine`, each with optional `agentId`). There is no separate "generate
   profile" button. *Numbers:* name ≤80, title ≤120, description (summary for teammates) ≤2,000, 100 agents.
2. **Profile editing by tool.** `update_profile` (name, title, description, avatar, provider, model, effort,
   account, backup models, access, Computer Use, notifications) and `update_agents` (same setting for many
   agents; per-agent ok/error, no rollback; unknown model fails the whole call before any write).
   `read_agent` returns the full setup except secrets (MCP names and transports only). **Agents can only
   restrict** access/Computer Use (for self or a teammate); only the user widens them. Avatar from a file
   ≤512 KB PNG/JPEG/WebP.
3. **Provenance gate on management tools.** Workflow edits/deletes/runs, channel create/update, webhook
   routine create/update, saving keys, channel member/instruction/routine changes are refused unless the
   turn was started by **a person's message** (own chat, or a side thread the person opened). A routine or
   webhook run, an external chat, an agent's message, a team member's request (some), or a member reply
   get a tool failure — because run input can carry outside text. Destructive deletes additionally need an
   approval card even at Full access.
4. **New-agent welcome.** A new agent's first turn is a hidden setup message: the agent greets in the app
   language and asks **one question with three suggested first tasks plus free text**. The empty chat of
   an agent also shows the agent, its description and a faint animated *sample turn* (static with reduced
   motion). Agents created by other agents keep a visible first message.
5. **Exact colours.** Avatar colour `#rrggbb` with nearest-hue fallback; a separate **chat bubble colour**;
   members have one too. Avatar styles (flat/shape/eyes).
6. **Instruction file + change line.** Standing rules live in `AGENTS.md` in the workspace (≤32,000 chars
   injected, redacted, closing tag escaped). Editor uses optimistic concurrency (refuses save if the agent
   changed the file since the edit began; a second Save overwrites). When a turn changes the file, the chat
   gets a system line "updated its instructions" with **View** and **Undo** (undo refused after a later
   change); the user's own edits move the baseline so they don't show.
7. **Hidden agents** (instead of delete): keep everything; new messages refused; routines paused; queue held;
   hidden from lists, mention picker, counts, "Needs you"; a hidden channel lead stops routing and its
   assignments go back to the channel. **Restore marks missed runs as skipped** (no backlog).
8. **Duplicate agent**: copies profile, memories (uncapped), routines; not the automation flag or hidden
   state; waits for idle; a half-written copy is removed.
9. **Sections/folders** for agents (3 levels; delete moves contents up), and agent tools to manage them.
10. **Pending runtime**: a model/provider/account change requested while busy is stored and applied at the
    next turn; sessions are retired and each gets a transcript handoff.
11. **Templates / share links**: publish a link-only copy (name, title, instructions, avatar, routines,
    skills as refs or text — no memories, no files), blocked if a text looks like a secret, 1200×630 share
    card, max 5 per account, same link on republish, opening a link never installs without a press.
12. **Import/export.** (a) *Agent import*: a zip with a manifest (agents, skills, routines, memories,
    channels). Clever onboarding: OpenBot ships an **export skill that the user runs inside the other
    product** (Grok Bot, Hermes), which distils chats into ≤50 short facts per agent and ≤32 per group,
    strips secrets (replaced by an "ask the user for…" placeholder), excludes regenerable folders, writes
    `.part` then renames. Failed agents roll back individually. (b) *Instance transfer*: whole-server zip
    without any secret (secret-looking args emptied, URL credentials/query removed, MCP keeps origin only,
    a `cleared` list asks again; imported MCP servers start turned off).
13. **Marketplace agents** (17 curated) that install with skills and even an **active routine** (e.g. a
    weekday morning brief).

### B. Conversations, threads, branches

14. **Side threads ("tasks").** Extra conversations of one agent beside its main chat, each with its own
    session, queue, progress line and result; tabs per device; "+" draft tab; "Run in new thread" for a
    queued message; rename (sticky user title), archive (sending restores), delete with Undo toast
    (refused while running); unread dot per thread; "load older" pages of whole turns. *Numbers:* 1–4
    concurrent task turns (default 4), 50 open threads, agent may start up to 8 via `start_task` (brief must
    be complete; result stays in the task). Hold reasons shown: task-limit, restarting, usage-limit,
    server-busy, agent-busy, one-turn.
15. **Branch from here.** Copies the messages up to the end of a finished turn into a new side thread
    (title "source #N"), divider "branched from…" linking back, first turn gets a transcript handoff with a
    note that files were not rolled back; idempotent by request id; disabled while the source runs.
16. **Context reset ("New chat")** keeps messages visible above a marker; the next session reads only after
    the marker; refused while busy. **Compact now**; **Delete history** (agent or channel; setup, memories,
    routines kept). `start_new_chat` lets the agent reset itself when a long chat no longer matters (only
    if the user enabled it; takes effect when the queue is empty).
17. **History tools** for the agent itself: `history_search` (lists own chat + threads with activity since
    24h/7d/date, or searches current conversation first, then main + 8 newest threads) and
    `history_read` (paged, with work steps). Messaging chats search only themselves; channels get none.
    *Numbers:* 5/10 results, excerpts ≤400, results ≤8,000/16,000 chars.
18. **Side question ("ask aside").** A question about the chat answered by the agent's model with **no
    tools**, from profile + last 60 messages (≤60,000 chars); neither question nor answer enters the chat;
    the server keeps nothing (client sends ≤20 earlier Q&A).
19. **Delete a message**: only your own; busy messages refused; the text is scrubbed from the event log too.
20. **Visual replies** (`html_render` + `html_preview`): a sandboxed HTML page above the reply (no
    same-origin, scripts allowed); page actions only after a user click: put text in the composer (user
    sends), set a context quote; preview renders off-screen and returns PNG + height + console.

### C. Queues and scheduling of work

21. **Mailbox queue** per agent, crash-safe, with statuses queued/starting/running/completed/failed/
    interrupted/cancelled; reorder (≤100), cancel, **edit a queued message** (edit hold, no timeout, only the
    editor can change it), "Send now" (stop and send) for providers that cannot steer.
22. **Busy-message mode** per agent: *queue* (default) or *steer* (join the running turn); Tab in the
    composer steers; a message that could not steer shows "not steered" with the reason.
23. **Lanes and concurrency**: main chat lane, one lane per task, one per channel; one channel turn per agent
    across all channels; declared resources (`browser`, `workspace:<path>`) serialise channel tasks.
24. **Usage-limit gate**: when a plan limit refuses a turn, every agent on that account+model holds its
    queue until the reset instead of failing message by message; a user message may try once. Routine
    `limitPolicy` wait|skip.
25. **Backup models + failover**: ordered list (≤8), "ask before switching" or automatic; on a provider error
    before the turn did any work, the messages are re-queued and run on the backup with no error banner,
    the failed model is passed over for 10 minutes; a switch note shows in chat (and in affected
    channels); the agent returns to its model when the limit ends.
26. **Plan auto-continuation**: if a turn ends while the agent's own plan has open steps it is continued
    with a short note until done, a limit, or no progress (same open steps twice). Also (≤2 times) when a
    short answer (≤400 chars) only asks "shall I continue?" or announces a next work step it didn't do —
    but never for approval-type questions, risky verbs (deploy/delete), or "later/if you want" phrasing.

### D. Agent-to-agent messaging, replies, reactions, files

27. **send_message** to 1–32 agents with files (≤10) and `replyToMessageId`; `expectsReply` false marks
    information that must not be answered (ends the exchange, no turn opened for it).
28. **Teammate framing**: a teammate's message is delivered with a header saying it comes from a
    teammate, not the user; reply rules and the anti-acknowledgement-loop rule travel **with each
    teammate message** rather than living in the system prompt.
29. **Fan-out aggregation**: answers to a request sent to 2+ teammates wait until the last copy ends, then
    start **one** turn with all answers, naming each teammate who gave no answer ("do not wait for
    them"). A person's message does not wait: it starts at once and takes whatever answers are in.
30. **Communication policy** (in instructions): no narrating setup/context loading; report outcomes,
    blockers, decisions needed; delegated work needs an explicit reply; no ack loops; don't refuse before
    trying every path; when work is outside one's profile, `list_agents` and delegate to the teammate whose
    description covers it; never send a task back to whoever gave it; the answer that relays a delegated
    result **starts with the teammate's name**; never claim something was checked unless a tool result
    shows it; a blocked reply has four lines: status, result, evidence, unblock; may *offer* to create a
    specialist, creates it only after the user agrees. OpenBot keeps a manual evaluation table of
    scenarios for these behaviours.
31. **list_agents status** for coordinators: description (300 chars), status working/queued/ready,
    queued count, turn start, last activity, open waits. **interrupt_agent**: stop a teammate's turn only
    when that turn works on *your* request; cancels your queued requests first; then queues a notice with
    the reason.
32. **Reactions**: per-participant emoji reactions; the agent may react with one emoji to the user's
    message for a clear emotional moment (an emoji in text is not a reaction).
33. **Files**: attachments copied as managed files; 100 MB/file, 250 MB/message, 10 files; any type; long
    paste (>4,000 chars) becomes a text attachment.
34. **"Waiting for replies" block** above the composer: each asked teammate with status asked / working /
    replied / failed; closable once all are done; the person can steer any waiting answer into the running
    turn.

### E. Channels (group chats)

35. **Model**: one host, purpose/instructions, member agents, a selected **lead**; human access is not
    limited by membership; each channel–agent pair has its own execution thread (the agent's own chat is
    never touched). Archive (shown as Delete) stops work and keeps records; restore from "Deleted
    channels". Picture: icon on a hue or uploaded image.
36. **Routing**, deterministic first (no model): explicit recipient → task attached to the replied message →
    reply to a member's message → clear follow-up to the only open task → channel with one available
    member. Otherwise a **routing call** on the lead's model in a separate tool-less session, given the
    channel summary (not the transcript), the last 5 messages (600 chars each) and ≤20,000 bytes of the
    request; outcome is exactly one of: list of member ids / an existing task id / "needs no answer".
    Greetings, questions about the channel, unclear or unowned requests → lead only (the lead may ask the
    person). Opinion/feedback requests → every member whose area gives a *different view*; "whole group"
    → all. Routing cannot itself ask a question. A message that mentions a member is never "no answer".
    Each chosen owner gets a visible line from the lead ("X will take this") so the person can correct it;
    deterministic picks add none. An undecodable routing answer pauses the task with a Reassign button.
37. **Addressing**: a message that *opens* with "@A @B" goes straight to those members; "@everyone" to all;
    typed "@Name" without a tag matched by exact name, longest first; a quote chip between mentions does
    not end the address.
38. **Independent views**: each chosen member gets its own root task for the same request; its packet
    names the other answering members but not their replies, so answers are independent; after a member's
    own complete reply, follow-ups include the others' replies.
39. **Task ownership & delegation tools**: `channel_assign` (subtask; you stay owner and integrate;
    end your turn to wait), `channel_transfer` (hand over the whole task), `channel_result` (publish the
    result once), `channel_history` (paged). Handoff carries task, expected result, source message ids,
    resources, dependencies. Assign only when the person asks for that member/help, or a part clearly
    needs another role. *Numbers:* 8 automatic assignments per root request, 2 active assignments per
    channel; the stop card for the limit names the members that passed work between them.
40. **Member-to-member reply** (`channel_reply`): a short (≤2,000 chars) reply to another member's message
    that gives that member **one** answering turn as a child task; the caller waits and continues with the
    answer; ≤2 member replies per request (shared); refused after own result, to a person, to self, to a
    streaming message, over the limit — and refusals tell the model not to mention them. A reply turn
    can only answer (no further replies/assignments/management).
41. **Stop / Continue / Reassign / Cancel**: Stop pauses a task and descendants (reason shown); typed
    "continue/resume/go on/keep going" continues each stopped root task of the newest request (a failed one
    only if none stopped; the addressed member's first); Reassign; Cancel ends a stopped/failed run (all
    open tasks of the root). "Waiting for sub-tasks" list above the composer with Stop per row. Members can
    cancel their own run on a person's request (`channel_cancel`). Packets include `stoppedTasks` so a lead
    does not wait for a cancelled subtask. Task revisions stop an old assignment from completing a
    corrected request.
42. **Agent-driven channel management** on a person's request only: add/remove member, set instructions,
    channel routines CRUD; each writes a "channel-change" activity note (not unread, not in the model
    packet). Agents can create/update channels from their own chat (idempotent by tool-call id).
    `send_to_channel` from a direct chat posts a full brief ("members don't see this conversation"),
    framed as "request from teammate X", with optional files; "Send to channel" message action for humans.
43. **Channel context packet**: purpose, responsibilities, current assignment, referenced messages,
    shared decisions, recent transcript, attachment refs, and a **versioned rolling summary** of older
    messages; full history by paging. Thinking and commentary of turns that produced a final answer are
    left out. *Numbers:* packet 120,000 chars; transcript = ¼ of budget newest-first; summary 12,000
    (target 8,000), refreshed in the background after a turn at 75 % of threshold; a short assignment
    (≤2,000) repeated at the end; dependency instructions 500; history page 24,000, single message cut at
    16,000 with offset continuation; a teammate handoff cut to 18,000 head + 6,000 tail. Delta packets
    omit own replies and unchanged facts. Summary uses the lead's provider on a cheaper default model.
44. **Channel memory** ("keep memories in this channel", off by default): `remember` inside the channel
    saves a channel fact (≤32 facts × 500 chars), agent memories still flow in.
45. **Interactive things in channels**: questions, plan cards and visual pages are copied into the channel
    so any human reader can answer; screen capture always asks.
46. **Attention in channels**: the channel shows approvals of member threads; the agent's home row says it
    "waits in channel X"; notify **once** when the channel's work ends (newest message is an agent's, not
    streaming, no open tasks) while unread.

### F. Memory

47. **Store**: one generic store for agent, channel and messaging-connection memories. Entry = text ≤500
    (trimmed), origin automatic|manual, source turn, created/updated (strictly increasing). Exact duplicate
    text folds into the existing entry. Hard delete also erases its event history ("what the user asked to
    forget").
48. **Caps**: per-agent cap is a setting 64/128/256/**512**, default **256** (because background reviews
    add entries unasked); lowering never deletes — an over-cap agent just can't add (and is told not to
    delete for that). Channel 32, messaging connection 32 (every packet pays the whole block).
49. **Essential vs searchable**: only *essential* entries enter every prompt, within an **8,192-byte**
    budget (serialised as one JSON block); the rest are *searchable* via full-text search (bm25, then
    recency; word stemming so "closing" finds "closes"). The user can pin an entry as always-included or
    search-only (then the agent cannot change it), or leave it to the agent. Selection changes carry a
    revision (optimistic concurrency).
50. **Tools**: `remember(text, memoryId?, inclusion?)`, `forget_memory(id)`, `search_memories(query ≤256,
    1–10)`, `list_memories(cursor)`, `set_memory_inclusion(1–25 changes)`. Agents are told to **search
    memory before saying they don't know something about the user**. A recall shows as a step in the turn.
51. **Staging**: remember/forget calls are held and committed only if the turn completes; an interrupted
    or failed turn leaves nothing. A user "Clear" bumps an epoch so staged changes from before are dropped
    (no resurrection). Parallel conflicts show as "not changed". Over-budget "essential" quietly becomes
    searchable with a note. The cap is checked at call time so the agent can merge in the same turn.
52. **Memory-changes line** after a turn: a system message listing what was saved/updated/forgotten (with
    previous text), redacted; part of the collapsed "N steps" row.
53. **Background memory review**: per conversation, after **20** completed turns (setting 10/20/40/off),
    after **15 min idle with ≥3 new turns**, on chat clear, on closing a side thread; channel, messaging
    and routine turns don't count; a turn where the agent edited memory itself resets the count. One
    tool-less generation on the agent's provider using the provider's **default model when it is cheaper**;
    reads profile + memories + conversation since last review; includes all essential entries + as many
    searchable as fit 12,000 chars (most word-overlap first) and says how many were omitted; secrets
    redacted; returns add/update/forget JSON applied through the same checks; never touches entries the
    user wrote or pinned, entries changed since read, or entries whose text redaction changed. Only one
    review at a time and only if a slot stays free for the user; failures are silent; usage-limit skips.
    While reviews are on, the agent is told to apply corrections **without** a memory call (the review
    keeps them) — measured ~20k vs ~63k input tokens.

### G. Routines, automation, webhooks, waits, workflows

54. **Routine** = saved instruction for an agent or channel with one trigger (schedule or webhook). Run in
    the agent's chat (default) or its own **routine thread** (titled after the routine, reopened if
    archived). Each run is a **fresh session** whose first message carries an 8,000-char handoff (earlier
    runs of the routine + newest chat); after a non-quiet run a **digest** (1,500 chars/run, 6,000 total)
    is appended to the chat's next-turn handoff so the chat knows what the run did.
55. **Schedules**: hourly(minute), daily, weekdays, weekly, monthly, interval(N min/h/d with anchor),
    advanced (months × days-of-week/month × at-time or every N), cron, **once** (date+time, then pauses;
    cancellable). Not more often than every 3 minutes. Timezone defaults to the requesting person's zone,
    else a **server timezone** setting. When the device timezone changes the app offers to move routines
    (keeping clock times). `missedPolicy` skip | run-once (once-schedules default run-once). `limitPolicy`
    wait | skip.
56. **Self-contained instruction rule**: because each run sees only the newest chat, the routine
    instruction must name the service, tool, account, steps, what to report, where, and when to report
    nothing — never "as before".
57. **Quiet runs**: a scheduled/script/webhook run with nothing to report calls `routine_no_update` (or
    answers only a marker). The answer collapses under the run marker, does not count as unread, does not
    change the preview, sends no notification/sound. A marker inside a longer answer is shown. A manual
    Test run is never quiet.
58. **Failed runs**: `routine_report_failure(reason ≤500)` ends the run as failed (with reason) while the
    answer still shows; a failed run is never quiet; provider errors and interrupts take precedence.
59. **Run history** per routine (source: test/script/webhook/schedule), routine state mark on the agent row
    (running/waiting/blocked/failed), a **Schedule view** (day/week calendar of all agent and channel
    routines, past results and planned runs), an iCal feed of the next 30 days, "Copy run command".
60. **Routine flows**: per-agent canvas; link a routine's answer on to other agents; an agent with several
    inputs waits for all and gets them in one message; if all inputs failed it is skipped; a link applies
    to runs that start after it; agents edit links with tools.
61. **Webhook routines**: per-routine URL + secret (shown **once**; rotate = old stops immediately; "use
    the sender's secret" for Standard Webhooks senders). Request `{type, occurredAt?, data?}` ≤64 KiB JSON;
    HMAC-SHA256 over `timestamp.deliveryId.body`, ±5 min; verify before decoding; optional exact event type
    and ≤128 JSON-Pointer equality filters (all must match). Responses 202 (started or ignored with
    reason), 200 duplicate, 400/401/404/413/415/429/503. **Receipts 7 days** (no body) dedupe by delivery
    id, ignored requests too; history shows ignored requests with the reason. Payload goes into the run
    between "external input" markers as **data, not instructions**; it cannot grant tools or skip
    approvals. "Send test event" signs a matching event and receives it. Route ids are never reused.
    Agents create webhook routines by tool (person-started turns only) and never see the secret; a chat
    card shows the URL and a regenerate button for managers. ≤64 webhook routes per host.
62. **Waits** (`await_event`): when a request waits >~15 min for something outside the turn, the agent
    opens a wait (note ≤500, optional routine id) and ends its turn; the wait shows above the composer
    until closed; the **next run of any (or the named) routine, or a script event naming the wait, wakes
    it** and the run's input repeats the original request and the note; the agent closes it when done or
    impossible, or leaves it open to wait again. Only from the agent's own chat; the agent must own at
    least one routine; ≤20 open waits (near-limit nudge at 17; at the limit the refusal lists open waits
    so finished ones can be closed); users cancel waits; other agents can list/close them.
63. **Local scripts API** (per-agent opt-in, user-only): send a message (idempotent client id, 24 h), run a
    routine with a payload (≤4,000 chars, marked as data), read a delivery's status and final answer, read
    pending questions/approvals and answer them, change model/account, reset context; CLI with exit codes
    (0 done, 1 failed, 2 bad args, 3 waits for a person, 4 wait timed out, 5 not found). Per-agent hourly
    limit (30 default; 30/60/120/300/1,000) shared by messages and runs. Loopback only, Origin/Host checked
    before the token.
64. **Workflows** (canvas of agent/model/condition/approval/output nodes, loops, versions ≤50, retries use
    current settings, schedule/webhook/GitHub/Slack/Discord/Telegram triggers, outputs to notification /
    messaging / channel note / GitHub). Agents edit graphs with operation lists; the host lays out nodes; an
    animated cursor "plays" the agent's edit. Only a person's message may edit/delete/run.

### H. Skills, plugins, marketplace

65. **Skill format**: folder + `SKILL.md` with name + description (1–1,024), optional example prompt,
    scripts/references/assets, `assets/icon.png` as logo; installed copies + lock file of hashes; disabled
    folder; skills ≤32/agent; bundle ≤200 files, 10 MB.
66. **Local library with immutable revisions**: `create_skill` (from a workspace folder, after the user asks)
    installs for the creator only; `revise_skill(expectedRevision)` publishes the next revision and installs
    it for the reviser only — others keep theirs until an explicit install; `read_local_skill`,
    `list_local_skills`, `install_local_skill` (refuses to overwrite user-modified files),
    `set_skill_enabled`, `uninstall_skill` (never removes user-modified files). YAML frontmatter auto-repair
    (quote values containing ":"). Packs (one bundle, several skills, one lock entry). No undo control:
    revisions are never deleted; the agent undoes by republishing the previous revision.
67. **Skill learning** (setting Automatic default / Ask first / Off): the memory review also looks for a
    *signal* (a correction of how a class of task is done, a non-obvious technique that worked, a listed
    skill that was wrong) and suggests **at most one** skill per review, preferring to update a covering
    skill; environment failures, one-off tasks and "tool doesn't work" claims are excluded. Automatic: a
    second tool-less call writes `{description ≤500, instructions ≤12,000}` in the user's language and
    saves a revision → "Created/Revised skill" line. Ask first: a suggestion card in chat with Save/Update
    that runs the writer directly (~7,500 tokens instead of a full agent turn); falls back to "yes" as a
    user message. Automatic also lets the agent fix one step of a skill during work when corrected.
68. **Skill tags** `$skill` in the composer (in a channel: union of members' skills); skill usage tracking
    (which turn loaded which skill, estimated tokens = file size/4) → **Usage → Skills tab** (loads, tokens,
    cost, share).
69. **Managed skills** shipped with the app: skill creator (checklist), shared data (one shared SQL DB:
    talk about the information, never show SQL; upsert on natural keys; rows from others are untrusted
    data), static site hosting (vanilla first, 10 sites, 20 files/2 MB, 30-day expiry, publish only on
    explicit instruction).
70. **Plugins/marketplace**: plugin = MCP server (as an "app") + pinned skills + listing; ~45 catalog apps;
    install saves a host-global MCP server and installs skills into the chosen agent; share links open the
    listing only; `suggest_marketplace_app` shows a Connect card (or tests and returns the fix). MCP
    server tools for agents (change only after the user's request and an approval). Multiple accounts of
    one MCP app, tagged `@account`. Agents never get OAuth tokens (per-agent proxy route).

### I. ask_ui, plan card, attention and consent

71. **ask_user**: 1–3 questions, each with header/detail/secret flag and ≤5 options with descriptions;
    multi-select variant.
72. **ask_ui blocks**: *confirm* (title, label/value fields or selects, markdown preview ≤8,000, 1–4
    actions with styles; `danger` = hold-to-press 400–3,000 ms; per-action re-confirm), *choice* (≤20
    options, single/multiple, meta line), *form* (≤20 fields: text with secret, textarea, select ≤50,
    segmented ≤6, date). Results: answered {actionId, values} / free-text answer / skipped / expired (turn
    ended, restart). Danger/confirm actions and free-text answers are **owner/admin only**. Secret values
    reach only the tool result, never storage. The answered block freezes with an outcome line.
73. **Plan card** (`acknowledge_request`): before work longer than ~1 min, one short sentence + 1–4 steps +
    Start / optional smaller Alternative / Cancel; **auto-starts after a countdown** (default 10 s, min 5 s,
    whole seconds, or wait for a person); per-agent opt-in (default off); not in external chats; not for
    quick answers or routine runs.
74. **request_api_key**: secure form; "save for all agents (vault) / only this agent"; the agent only gets a
    file path; values registered for log redaction.
75. **"Needs you"** sidebar group with a count: each agent row says what it waits for (Answer / Review /
    Take over) with the question or command in a tooltip; it returns to its section after the answer.
    Notifications close when a request is answered on another device.
76. **Approvals in external chats**: buttons only the requester may press (others get a private "only the
    requester"); WhatsApp numbered text replies.

### J. Context monitoring and compaction

77. Context ring next to the send button (also per side thread), popover with categories (system, tools,
    messages, other; estimate flag), **Compact now** and **New chat** buttons; progress estimate from the
    previous compaction's duration.
78. Compaction at 80 % of the window, or *before* a turn whose estimated input (4 chars/token) would pass
    80 %; stop after 2 compactions in a row that leave ≥70 % ("ineffective" notice) or 2 failures in a row
    ("stopped" notice); a retry notice at the 3rd provider retry, forcing compaction at ≥50 %.
79. Replacement session **handoff** ≤32,000 chars: 24,000 recent messages, 4,000 older excerpts, 2,000
    captured work steps (commands, exit codes, output tails, changed paths), 2,000 instructions; big
    latest messages keep head and tail. Provider switch carries the same handoff.

### K. Notifications, presence, away

80. Events that notify: turn finished, stopped with error, could not start, waits for input/approval/browser
    step. Levels: server "all" or "needs me", per-member per-agent level, per-agent switch; quiet runs never
    notify. Body = the **lead of the answer** (first sentences, no code/tables/headings, secrets shown as
    dots). Phone push only while the phone is away/disconnected; a desktop reports keyboard idle time so
    the phone stays quiet while the user is at the computer. Channel replies notify once at the end of the
    work.

### L. External messaging (Slack, Discord, Telegram, WhatsApp)

81. One app per platform, one **Orchestrator** agent per platform answering every workspace/chat, placed in
    an "Integrations" sidebar section; it answers short requests itself and delegates other work to one
    teammate, whose answer returns into the same external thread; a "a teammate is working on it" post.
82. Each external conversation (thread / reply chain / topic / DM) is its own execution thread; the prompt
    frames text as external input, adds earlier thread messages and the connection's **workspace facts**
    (≤32 × 500, shown with ids, marked as data; not saved from DMs; anyone can ask to forget).
83. Lifecycle reactions: 👀 received → "Working on it…" status post with Stop → replaced by the answer →
    ✅/❌/⏹; quiet `NO_REPLY` removes the status post and keeps the reaction; "stop"/"cancel" text stops the
    sender's own request; posts never name the agent; posts never ping @channel/@everyone/roles.
84. Outbound posting from any turn (`messaging_list_places`, `messaging_post`); a routine posts only by
    calling the tool. Limits: 20 waiting requests per agent, 2 per person; Discord context = last 10
    messages of the preceding 15 min; split >2,000 chars; WhatsApp burst merge 1.5 s, answers ≤1 day old,
    allow-list or 6-character pairing code for unknown senders (≤3 pending, 1 h).
85. Connection status rows with an action each (token not accepted, missing permissions, rate-limited with
    retry time, tokens unreadable, reconnecting, cannot receive events, taken by another server).

### M. Usage, limits, admin

86. Usage page with breakdowns (agents, models, **skills**), CPU/memory for admins, usage-read pacing
    (one read per 4 min, back-off 5→60 min), "Reset usage" credits.
87. **Roles per agent** for team members: none / view / chat / manage; "Everyone" role; highest wins;
    owner/admin always manage; duplicated agents inherit levels first. **Audit log** of access changes
    (500 newest, names frozen at the time).
88. Limits everywhere are explicit and documented (see `input-limits.ts` in notes).

### N. i18n and UI rules

89. 15 locales; the backend sends English source text and the client maps it back to a key by template
    matching (placeholders `{count}` etc.) to render in the reader's language; checks fail on ambiguous
    templates and on hard-coded UI strings; agents write their welcome in the app language. Number/date/
    size/list formatters. Never translate stored values, prompts or user content.
90. UI rules: compact control scale (24/28/32/36 px), tokens only, hover only on fine pointers, press scale
    0.97, animations <300 ms with reduced motion, a component-choice guide, a11y gate in Storybook.

### O. Anything else worth knowing

91. **Tool discovery**: 11 direct tools + `tool_search` / `tool_describe` / `tool_call`; deferred tools cost
    only their names; up to 3 "strong" search hits return full schemas to save a step; a CI check fails if
    instruction/tool text grows (context-budget regression gate). Stable instruction order (rules →
    profile → memories last) for prompt caching.
92. **Collapsed "N steps" row** above a finished answer (thinking, tools, memory searches, skills used,
    memory changes); live activity line with readable step labels derived from commands.
93. **Feedback tool**: the agent drafts a bug/idea; the user reviews the plain text before it is sent.
94. **Read aloud / dictation / voice** in chats and threads.
95. **Global search** across agents, channels, files, routines, commands, settings.

---

## 4. Gap analysis against the Synapsez Bot page

Synapsez facts used (from the files checked): bots ≤24, groups ≤20, members ≤12, role ≤40, instructions
≤4,000, memory entry ≤300 chars, ≤60 entries per bot/group, ≤4,000 chars of each scope in the prompt (newest
kept), names ≤40 with reserved `all/everyone/user/you/me`; group round: admin answers un-addressed messages,
any "@Name" in a post hands work on, members called together run in parallel, `[PASS]` = silence,
`HANDOFF_CEILING` 6, round budget 285 s, no new turn with <40 s left, a member reads ≤24 new lines × 4,000
chars; one Stop for the round; approval inside a group → notice; group notices for made/joined/left/
renamed/admin/deleted; Chief (main bot) alone creates bots/groups; per-bot scheduled tasks (prompt ≤8,000);
usage by bot; bot chat reuses the home chat (queue, plan checklist, steer, question buttons, compaction,
incognito); Vercel `maxDuration` 300, crons once a day (+ browser nudges / external pinger).

Legend — Has: yes / partly / no. Fit: fits a serverless web app? Value: H/M/L. Effort: S/M/L.

| # | Feature | Synapsez has it? (file checked) | Fit | Value | Effort | Adaptation notes |
|---|---|---|---|---|---|---|
| 1 | Prompt-driven creation of teammates | yes — Chief `create_bot` (`server/bots/tools.js`) | yes | — | — | Missing only the "first task" argument (new bot starts its first job) — S. |
| 2 | New bot inherits creator's limits | n/a (no per-bot access) | — | L | — | Synapsez has no per-bot permissions; skip. |
| 3 | **Person-only gate for team/management tools** | **no** — `runBotTool` checks only `is_main` (`tools.js`); a group member's @Chief, or a scheduled task in Chief's chat, can run `create_bot`/`update_group`; any bot can rewrite its own instructions from injected text | yes | **H** | S | Record the turn's origin (person / bot hand-off / scheduled / webhook) and refuse create/update/delete tools unless a person started the turn. Security fix class, not a feature. |
| 4 | Welcome turn with 3 suggested first tasks | no (`createBot` + "ready" line) | yes | M | S | On first open of a new bot's chat, run one cheap turn that greets in the UI language and offers 3 tasks as question buttons (`tools/askOptions.js`). |
| 5 | Exact colours / chat bubble colour | partly — creature + 12 hues, distinct faces (`team.js pickHue`) | yes | L | S | Bubble tint per bot from its hue is cheap polish. |
| 6 | Instruction-change line with View/Undo | no — `update_bot` silently replaces instructions | yes | H | S | Store previous text; show "Chief changed Writer's instructions" with View/Undo (pairs with #3; same as notes' one-step undo in `server/memory.js`). |
| 7 | Hide (pause) a bot instead of delete | no (delete only, `routes/bots.js`) | yes | M | S | `hidden_at` column; pause its tasks; leave groups' membership but skip it; restore skips missed runs. |
| 8 | Duplicate bot | no | yes | M | S | Copy row + memory (uncapped) + tasks (paused). |
| 9 | Sections/folders for bots | no | yes | L | S | Only useful near the 24-bot cap. |
| 10 | Pending runtime / per-bot model + backup models | no by owner choice (every bot uses top-bar model, `prompt.js`) | yes | L | — | Respect the owner's decision; failover already exists app-wide (502 → next key → Auto). |
| 11 | Share a bot as a template link | no | yes | M | M | Public read-only card (name, role, instructions, creature, task prompts, skill refs — no memory); "Add to my team" button; secret scan before publish. |
| 12 | Import/export bots; "export prompt" for other assistants | no | yes | M | M | JSON export of bots/groups/memory/tasks; import with per-item rollback; a copy-paste prompt users run in ChatGPT/Gemini to produce the file (distil ≤60 facts of ≤300 chars). |
| 13 | Marketplace bots with skills + active task | partly — shared skills on Discover (`server/skills.js`) | yes | M | M | "Starter bots" gallery (e.g. Morning Brief) that create bot + skill + paused task. |
| 14 | Side threads per bot | no — one chat per bot (`routes/bots.js botChat`) | partly | M | L | Serverless + cost: better as "new conversation with this bot" (context reset marker) and branch (#15). |
| 15 | Branch from here | no (home chat neither, `app.js`) | yes | M | M | Copy messages to a new bot conversation; first turn gets a transcript handoff. |
| 16 | New chat / Compact now / Delete history per bot & group | partly — via home chat (`server/compact.js`); none for groups | yes | M | S | Group: "new conversation" = reset every member's per-group conversation + seen cursors; "delete history". |
| 17 | Bot reads its own other conversations (history tools) | no | yes | L | M | Lower priority; memory + digest (#26) cover most needs. |
| 18 | **Side question ("ask aside")** | no (grep: none) | yes | M | S | One tool-less call on the top-bar model with the last N messages; answer in a side card; nothing stored. |
| 19 | Delete own message | partly (home chat) | yes | L | — | — |
| 20 | Visual HTML replies | partly — chart/cards tools (`server/tools/chart.js`, `cards.js`) | yes | L | M | Keep current tools; sandboxed HTML is an XSS/size risk. |
| 21 | Queue with edit / reorder / cancel / send now | partly — home chat queue (`app.js` queue) | yes | L | — | Group rounds have no queue: a message during a round is refused ("already answering", `routes/bots.js`). Could queue one follow-up. |
| 22 | Steer vs queue mode | partly (home chat steer, `agent.js`) | yes | L | — | — |
| 23 | Usage-limit gate holding all bots on a model | partly (app-wide fallbacks) | yes | L | — | — |
| 24 | Plan auto-continuation | partly — plan checklist exists (`public/js/plan.js`); group prompt forbids "promise to do later" (`rounds.js`) | yes | M | M | Continue a bot turn whose plan has open steps or that ends with "shall I continue?" — bounded (≤2) and within the 300 s budget. |
| 25 | `expectsReply:false` information messages | no — every @mention starts a turn | yes | M | S | A "FYI @Name" form, or a rule that only a *leading* address hands off (see #37). |
| 26 | **Fan-out aggregation naming who did not answer** | partly — `rounds.js` sends the asker one report turn for the members that posted; **if every called member PASSes or fails, the asker gets no report turn and the user may get no answer** | yes | **H** | S | Always give the asker its report turn when its hand-offs end, listing who answered and who did not ("do not wait for them"). |
| 27 | **Delegation reply protocol** (status/result/evidence/unblock; no ack loops; never hand back to the giver; relay starts with teammate's name; no unverified "I checked") | partly — `TEAM_RULES`/`roundPrompt` cover brevity and "result, not promise" (`prompt.js`, `rounds.js`) | yes | **H** | S | Extend prompts (own words). Add a blocked-report line format and the "never pass back to whoever asked" rule. |
| 28 | `list_bots` with live status (working/queued/last activity/open waits) | partly — `list_bots` lists names/roles only (`tools.js`); page shows `running` (`routes/bots.js`) | yes | M | S | Add status + last activity to the tool result so Chief can coordinate. |
| 29 | interrupt_agent | no | partly | L | M | One-stop-for-all exists; per-member stop is the useful part (#33). |
| 30 | Reactions (bot reacts to user message) | no | yes | L | S | Cosmetic. |
| 31 | "Waiting for replies" block with per-member status | partly — live working rows with spinner per bot (`bots.js renderWorking`) | yes | M | S | Add states asked/working/replied/failed/passed per member for the current round. |
| 32 | **Model-based routing** (lead picks members by role; greetings → lead; opinions → several, independent) | no — un-addressed → admin only (`rounds.js`) | yes | M | M | The admin's own turn already acts as router; cheaper: add deterministic rules (#37) and an "opinions" mode where the admin's hand-off to several members makes them answer independently (they already do: parallel batch). |
| 33 | **Stop / Continue / Reassign per member; "continue" resumes cut-off work** | partly — one Stop ends the round; "Out of time… write again to carry on" (`rounds.js`), but the pending queue is lost | yes | **H** | M | Persist the round's pending queue (`group.pending`), and let "tiếp tục / continue" or a Continue button resume exactly those hand-offs. Serverless time cuts make this frequent. |
| 34 | Member-to-member short reply (one answering turn, ≤2 per request) | partly — hand-off by "@Name" is the only path (`rounds.js`) | yes | M | S | Make "@Name?" questions count against a separate small limit (2) inside the 6-ceiling, and tell the asked bot to answer only. |
| 35 | Visible "who answers" line from the admin | no | yes | M | S | When the admin hands work on, the system already shows the member's post; add a short "→ Writer" chip on the admin's message. |
| 36 | Agent-driven group management with activity notes | yes — Chief `update_group`, `sayInGroup` notices (`team.js`) | yes | — | — | Add the person-only gate (#3). |
| 37 | **Leading-address semantics**, `@all/@everyone` fan-out, mentions in code ignored | partly — any "@Name" anywhere in a bot post hands off; `all/everyone` reserved but not implemented (`bot-mentions.js`) | yes | **H** | S | (a) Hand-off only from mentions at the start of a line or an explicit `hand_off` tool, so "as @Writer said" costs nothing; (b) implement `@all` for the person (fan-out within ceiling). |
| 38 | Rolling group summary in the member packet | no — a member reads new lines since it last looked; its per-group conversation grows | yes | M | M | Keep a short group summary (cheap model, after a round, like OpenBot's background summary) and give it to members whose `seen` is far behind or new. |
| 39 | Isolated channel memory | yes — group memory scope (`memory.js`, `tools.js remember`) | yes | — | — | Already the default in a group. |
| 40 | Questions/approvals answerable inside a group | no — an approval stops the member with a notice (`rounds.js`) | partly | M | M | Show the question card in the group log and resume that member's turn on answer (needs a resumable member turn). |
| 41 | Notify once when a group's work ends | no (no web push; `bots.js`) | partly | M | M | Synapsez has event mail; a "round finished" browser notification when the tab is hidden is cheap. |
| 42 | **Essential vs searchable memory + search tool** | no — newest 4,000 chars per scope, older silently dropped (`memory.js memorySection`) | yes | **H** | M | Pin flag (`essential`), byte budget; Postgres `tsvector('simple')` + `unaccent` for Vietnamese; a `recall` tool; "search before saying you don't know". |
| 43 | Memory dedupe / forget by id / secret refusal | yes (`memory.js`) | — | — | — | Synapsez forget-by-substring with ambiguity refusal is good. |
| 44 | Larger cap with background additions | partly — 60 × 300 | yes | M | S | Raise once #42 exists (only essentials cost prompt space). |
| 45 | **Staged memory commits** (only if the turn completes; cleared-epoch guard) | no — `remember` writes immediately (`memory.js`) | yes | M | S | Collect bot-tool writes per turn and flush on success; drop on stop/error. |
| 46 | **Memory-changes line after a turn** with undo | partly — tool calls show as event lines (`bots.js TEAM_EVENTS`) | yes | M | S | One summary line "saved 2, forgot 1" with Undo per entry. |
| 47 | **Background memory review** every N turns on a cheaper model | no — explicitly left out for cost (`memory.js` header) | yes | **H** | M | Every 20 bot turns or on "new conversation", one call on the free/cheapest model (Auto), add/update/forget JSON, never touches user-written entries; off by default per account if cost is a concern. |
| 48 | Routine runs in own thread + run digest into chat | partly — tasks run "in its chat as it" (`routes/bots.js`, `scheduler.js`) | yes | M | S | Since runs share the bot chat, add a digest only when runs go to a separate log; otherwise fine. |
| 49 | Rich schedule kinds, once, missed/limit policy, server tz | partly — readable grammar incl. once, user tz (`scheduler.js`) | yes | L | S | Add missed-run policy (skip vs run once) — cron fires daily, so misses are common. |
| 50 | **Self-contained task instruction rule** | unknown/likely no | yes | M | S | Add to the task-creation tool description and the bot prompt. |
| 51 | **Quiet runs** (no-update) | no — grep finds no quiet path (`scheduler.js`) | yes | **H** | S | `task_no_update` tool: collapse the answer, no unread, no email. |
| 52 | **Failed-run reporting tool** | no | yes | M | S | `task_failed(reason)` → run marked failed with reason; shown in the task list. |
| 53 | Run history, state mark on bot row, calendar view | partly — next run + pause/delete (`bots.js tasksHtml`) | yes | M | S/M | Last-run status dot on the bot row; a week calendar is M. |
| 54 | Routine flows (pass a run's answer to other bots) | partly — `server/workflows.js` durable multi-step | yes | L | M | Could be "after this task, hand the result to @Name" — reuse the round engine. |
| 55 | **Webhook-triggered bot tasks** | no (grep: only `skillUpload.js`) | **yes (ideal)** | **H** | M | `POST /api/hooks/:routeId`, HMAC with timestamp+delivery id, event type + JSON-Pointer filters, receipts 7 days, answer 202 then run (Vercel `waitUntil` or the run lease), payload as untrusted data, secret shown once. |
| 56 | **Waits (park a request until the next run/webhook)** | no | **yes (ideal)** | **H** | M | `bot_waits` table (≤20 per bot, note ≤500); woken by the bot's next scheduled task or a webhook naming it; chips above the composer; "close" tool. Fits serverless because nothing has to stay running. |
| 57 | Personal API (send message, wait answer, answer questions) | no | yes | M | M | Per-account API token, per-bot opt-in, hourly limit, idempotency key; reuse webhook HMAC. |
| 58 | Workflow canvas | partly — workflows engine without canvas (`workflows.js`) | partly | L | L | Not for the Bot page. |
| 59 | Skills tagged with `$`, per-bot skills | partly — account skills with shared skills (`server/skills.js`); no per-bot assignment | yes | M | M | Let a bot have its own skill list (subset of the account's) shown in its details. |
| 60 | **Skill learning suggestions** from the review | no | yes | M-H | M | Same review call returns an optional single suggestion; "Save as skill?" card; writer call only on Save. |
| 61 | Skill revisions, never-delete, install per bot | partly (shared skills keep references) | yes | L | M | — |
| 62 | Skill usage by bot (loads, tokens) | no | yes | L | S | Count `skill_read` calls per bot in usage. |
| 63 | ask_user / multi-question with options | yes — question buttons (`tools/askOptions.js`) | — | — | — | — |
| 64 | **ask_ui confirm/choice/form blocks** (danger hold, preview, date, secret) | partly — buttons only | yes | M | M | A `confirm` with preview (letters/emails) and a small `form` are the valuable two. |
| 65 | **Plan card with auto-start countdown** | partly — Plan mode gate (memory index: 1.19.0) | yes | M | S | Per-bot opt-in "show plan first"; Start/Alternative/Cancel; auto-start after 10 s unless the user taps. |
| 66 | API-key request form (vault) | partly (connectors/keys elsewhere) | yes | L | — | — |
| 67 | **"Needs you" group** on the bot list | no | yes | M | S | Bots/groups with a pending question/approval float to the top with "Answer/Review". |
| 68 | Context ring + Compact now per bot | yes via home chat gauge (memory index: context breakdown) | — | — | — | Missing for groups. |
| 69 | Compaction stop rules (ineffective/failed twice) | unknown | yes | L | S | Worth checking `server/compact.js` for a loop guard. |
| 70 | Notifications with answer lead, away logic | partly (event mail) | partly | L | M | — |
| 71 | Slack / Discord / Telegram / WhatsApp | no | Telegram & Slack: yes (webhooks); Discord gateway / WhatsApp: no | M | L | Telegram first: bot webhook → orchestrator = Chief; per-connection facts ≤32. |
| 72 | Workspace (connection) facts memory | no | yes | L | S | Only with #71. |
| 73 | Usage by bot | yes (`routes/bots.js /bots/usage`, `bots-usage.js`) | — | — | — | Add per-group totals and skill breakdown later. |
| 74 | Per-bot access roles for team members | no (bots are per account) | — | L | — | Only if bots become shareable in a team. |
| 75 | i18n of server messages by template matching | partly (vi/en, tests) | yes | L | — | Synapsez already enforces vi/en by tests. |
| 76 | Collapsed "N steps" row incl. memory changes | yes in home chat (memory index: run gallery/steps) | — | — | — | Include memory changes in it (#46). |
| 77 | Tool discovery / context-budget CI gate | partly (`token-budget` skill, tool loading) | yes | L | S | A byte-budget test for the bot prompt section would stop silent growth. |

---

## 5. Ranked shortlist (what to carry over first)

Ranked by value × fit ÷ effort, adapted to Synapsez (Express on Vercel, 300 s functions, daily cron plus
browser/pinger nudges, Postgres, vanilla JS, vi/en).

**1. Person-only gate for team-changing tools (security, S).** Give every bot turn an `origin` that the
server sets, never the model: `person` (a message the signed-in person typed), `handoff` (started by
another bot's @mention in a round), `task` (scheduled), `webhook` (later). `runBotTool` refuses
`create_bot`, `create_group`, `update_group`, `update_bot` on another bot, and `update_bot` changing the
bot's *own instructions*, unless `origin === 'person'`; the refusal says "ask the person to confirm in
your own chat". In a round, Chief called by another bot can still *answer*, but cannot reshape the team.
Pair with #3 (undo line) so any instruction change is visible and reversible. Add one test per origin.

**2. Never strand the person in a group round (S–M).** Two fixes in `rounds.js`: (a) when a bot's
hand-offs end, always queue the asker's report turn, listing who posted and who passed/failed ("X gave no
answer — don't wait for it"); today, if every called member passes or fails, the asker never speaks and the
person sees silence. (b) When the round stops for time or the 6-hand-off ceiling, save the remaining queue
on the group (`pending`, with who asked and why). The notice then offers **Continue**; a message that is
only "continue / tiếp tục / go on" (or the button) resumes exactly that queue instead of starting over at
the admin. Clear `pending` on any other message. This turns the serverless time limit from a dead end into
a pause.

**3. Undoable change lines for instructions and memory (S).** After a turn that changed a bot's
instructions or memory, post one system line in that conversation: "Chief changed Writer's instructions —
View · Undo" / "Saved 2 notes, forgot 1 — Undo". Keep the previous instruction text in a column; Undo
restores it only if nothing changed since (compare `updated_at`). Same idea as the one-step undo already in
`server/memory.js` for account notes. Cheap, and it makes #1 and #4 trustworthy.

**4. Pinned vs searchable memory with recall (M).** Add `essential boolean` and `pinned_by_user boolean` to
bot memory; only essential entries (within a byte budget, e.g. 2–3 KB) go into the prompt; everything else
is found with a new `recall(query)` tool backed by Postgres full-text search (`to_tsvector('simple',
unaccent(text))` handles Vietnamese tone marks) plus `ILIKE` fallback. Tell bots to recall before saying
they don't know something about the person. The memory panel gets a pin toggle; a person's pin cannot be
changed by a bot. Then raise the cap (e.g. 60 → 200) because unpinned entries cost nothing per turn.

**5. Staged memory writes (S).** Buffer `remember`/`forget` calls during a turn and commit them when the
turn ends successfully; drop them if the person stopped the turn or it errored; drop them if the person
cleared the memory meanwhile (epoch/`updated_at` check). Removes the "half-finished turn saved a wrong fact"
class and gives #3 its single summary line.

**6. Background memory review, cost-bounded (M).** Every 20 completed turns of a bot's conversation (and
when the person starts a new conversation with it), run one tool-less call on the cheapest model available
to the account (the free Auto route) with: the bot's profile, its essential entries, ≤N searchable entries
that share words with the chat, and the chat since the last review (redacted). It answers add/update/forget
JSON; apply it through the same checks as #4/#5, never touching entries the person wrote or pinned. Make it
an account setting (Off / every 20 / every 40), default perhaps Off on the free tier. Run it as a tail step
of the turn that crossed the threshold, or on the next cron/nudge, never inside the 300 s window of a busy
round. Count its tokens under the bot in usage.

**7. Quiet and failed scheduled runs (S).** Two tools offered only in scheduled (and later webhook) runs:
`no_update` (nothing to report → the answer is collapsed under the run marker, no unread dot, no email, no
preview change) and `run_failed(reason ≤300)` (the run is marked failed with the reason in the task list
and the person is notified). Add a one-line rule to the task-creation tool: each run starts with only the
newest messages, so the prompt must name what to check, how, what to report and when to report nothing.
Add a missed-run policy (skip vs run once at the next nudge), because the daily cron makes misses normal.

**8. Waits: park a request until the next run (M).** A bot facing something that will only be true later
("tell me when the build in the sandbox ends", "check the price again tomorrow") calls `wait_for(note)`.
Store `{bot_id, request_message_id, request_text, note, task_id?, woken_run_id}` (≤20 per bot). The bot's
next scheduled task run — or a webhook (#9) naming the wait — gets a block listing the open waits with the
original request and the note; the bot continues and closes them with `close_wait`. Chips above the bot's
composer show open waits with a cancel ✕. Nothing has to stay alive between runs, which is exactly what a
serverless app needs.

**9. Webhook-triggered bot tasks (M).** A task's trigger can be "When a request arrives": the server makes
a route id and a secret (shown once, rotate invalidates at once). `POST /api/hooks/:routeId` with
`{type, occurredAt?, data?}` ≤64 KB, headers timestamp (±5 min) + delivery id + HMAC-SHA256 of
`timestamp.deliveryId.body`, verified before parsing; optional exact `type` and JSON-Pointer equality
filters; receipts (no body) for 7 days for dedupe and an "ignored because…" history; answer 202 at once and
run the bot turn under the run lease (or `waitUntil`), with the payload wrapped as untrusted external data
that cannot change tools or approvals. A "Send test event" button. Rate-limit per route and IP. Only a
person's turn may create or edit one (#1).

**10. Delegation and reporting rules in the bot prompts (S).** In the bots' own words: report outcomes, not
setup; a result relayed from another bot starts with that bot's name; never claim a check without a tool
result; never hand work back to the bot that gave it; a blocked report gives status, result, evidence and
the one action that unblocks it; no "thanks / got it" posts between bots (they cost a turn each); Chief may
*offer* a new specialist but creates it only after the person says yes. Add a handful of scripted
evaluation cases (the repo's `eval` skill) for these behaviours.

**11. Clearer addressing in groups (S).** Change hand-off parsing for **bot posts** so only an address at
the start of a line (or an explicit `hand_off(name, task)` tool) starts a member's turn; a name mentioned in
passing ("as @Writer said") does not — today every mention costs a turn and a hand-off slot. For **the
person**, implement the already-reserved `@all/@everyone` as "every member answers, independently, in one
batch" (still inside the ceiling), and make "reply to a bot's message" address that bot. Show a small "→
Name" chip on the admin's message when it hands on, so the person sees and can correct the routing.

**12. Team status at a glance (S–M).** (a) A "Needs you" group at the top of the bot list for bots/groups
waiting on a question card, approval or Connect, with "Answer/Review". (b) In a running round, a
"waiting for replies" strip with each called member's state: asked → working → replied / passed / failed.
(c) `list_bots` returns each bot's state (working / idle), last activity and open waits so Chief can
coordinate. (d) A browser notification when a round finishes while the tab is hidden — once per round.

**13. Side question (S).** A small "Ask aside" action in a bot's chat: one tool-less call on the top-bar
model with the bot's persona and the last ~60 messages; the answer shows in a side card and is never written
to the conversation or memory; the client keeps the last few Q&A. Good for "what did we decide about X?"
without polluting the thread or the cache prefix.

**14. Skill suggestions from the review (M, after #6).** Let the same review call optionally return one
skill suggestion, only when a clear signal fired (the person corrected *how* a kind of task is done, or a
non-obvious method worked), preferring an update of an existing skill. Show a card "Save this as a skill?"
with the proposed name and a one-line lesson; on Save, a second cheap call writes the skill in the person's
language and saves it through the existing skills store (`server/skills.js`), passing the existing safety
scan. Never automatic on the free tier.

**15. Bot portability and onboarding (S–M).** (a) A welcome turn for a new bot: greet in the UI language and
offer three first tasks as question buttons. (b) Hide/pause a bot instead of deleting it (tasks paused, not
offered in groups, restore skips missed runs). (c) Duplicate a bot (memory + paused tasks). (d) Export/import
bots and groups as JSON (memory distilled, no secrets, per-item rollback), plus a ready-made prompt the
person pastes into another assistant to produce that file — the cheapest possible migration path. (e) Later:
a public template link for a bot.

Optional later (L): a Telegram connection (webhook-based, fits Vercel) where Chief is the orchestrator,
with 👀 → "working…" → answer → ✅/❌ lifecycle, per-connection facts (≤32), "stop" by text, and approvals
answerable only by the requester.

---

## 6. Things NOT to carry over, and why

- **Code, prompts, tool descriptions, UI copy** — PolyForm Noncommercial forbids use in a commercial
  product; Synapsez must re-implement behaviours in its own words (this report already paraphrases).
- **Local CLI providers, per-agent workspaces, `AGENTS.md` files, provider sessions/handoff of captured
  work steps, idle-session pools, process groups** — desktop-only; Synapsez runs one agent loop on hosted
  models with no per-bot filesystem.
- **Per-bot model, backup-model lists, provider accounts, usage-reset credits** — the owner chose one model
  from the top bar for every bot (2026-11-10); app-wide fallback already exists.
- **Concurrent side-thread lanes (4 at once, 50 open), parallel task turns per bot** — each lane is a paid
  model call and a 300 s function; the cost and the free-tier ceilings make this a poor fit. Branching and
  "new conversation" give most of the value.
- **Model-based routing turn before every un-addressed group message** — one extra paid call per message;
  the admin's own turn already routes. Use deterministic rules (#11) instead.
- **Embedded browser takeovers, Computer Use, screen capture, local sign-in windows, vault autofill** —
  desktop-only; Synapsez has its own cloud browser and sandbox with their own safety model.
- **Local scripts loopback API as designed** (127.0.0.1, token files) — no localhost on Vercel; only the idea
  of a per-bot opt-in API with an hourly limit survives (#57, later).
- **WebRTC Team API, iPhone Live Activities, push "away" detection via keyboard idle time** — different
  architecture.
- **WhatsApp via an unofficial client (Baileys)** — ToS/ban risk; **Discord** needs a persistent gateway
  socket that serverless cannot hold; **Slack auto-joining every public channel** — noisy and needs a relay
  that keeps events within 2.5 s.
- **Shared SQL tables that agents create and query** — letting a model run SQL on the production Postgres is
  a large injection and quota risk; Synapsez has notes, memory and files instead.
- **Static site hosting, public GitHub issue filing by agents, status-page webhooks, routine iCal feed,
  workflow canvas with an animated "agent cursor"** — cost/abuse surface or low value for the Bot page.
- **`html_render` pages with scripts** — would need an isolated origin and size limits; existing chart/card
  tools cover the need with less risk.
- **Roles per bot for team members and an access audit log** — Synapsez bots belong to one account; revisit
  only if bots become shared within a team.
- **Danger-by-default access** (OpenBot agents run with full access and no approvals after first consent) —
  the opposite of Synapsez's approval policy; keep Synapsez's stricter defaults.
