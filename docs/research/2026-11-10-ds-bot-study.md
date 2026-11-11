# DS Bot (Fei2411/DS-Bot) — design and mechanisms, and the gap to Synapsez's Bot page

Research date: 2026-11-10. Clone read: `scratchpad/repos/DS-Bot-src/DS-Bot` at `8e0013e` (depth 1; DS Bot 0.3.2, tracks DeepSeek Harness "DSH" 0.2.2-rc.1). Read-only: nothing in the clone was run, nothing in `d:\AI remote` was changed.

Licence note: DS Bot is Apache-2.0. Synapsez takes its **design only** (NOTICE, "Bot page" section). Everything below describes DS Bot's mechanisms in my own words; where a number or a rule is load-bearing it is stated as a fact, not as quoted prompt text. Recommendations in §6 say *what* to build, never "copy this prompt".

---

## 1. Summary

**What DS Bot is.** A DSH plugin (plus an Electron desktop app, a Docker image, an Expo mobile remote) that turns DSH into a persistent *team* of Bots on the user's own computer. Each Bot is a long-lived identity whose work runs in a *chain* of DSH Sessions: one for its own chat, one hidden Session per group it is in, and a fresh "part" whenever the context fills. Everything (team, groups, memory, usage) is local files (`state.json`, Markdown memory, SQLite indexes).

**The ten ideas that define its Bot page**

1. **Main Bot ("Chief")** created on first open, with a guided first-run (model setup card → fixed greeting → goal card → suggested-Bots card → first task) that is a *code-driven step table*, not model-driven. Main Bots create/change/stop other Bots and run every group; there can be several Main Bots; only the user deletes a Bot.
2. **Group chats with an admin** (admin-first by default, or "everyone answers in turn"), `@Name` calls resolved by **one shared rule** for host and page, members called together start in parallel, and a call takes effect **the moment the line that makes it is posted** — even mid-turn.
3. **The group's own Session never calls a model**: the host synthesises its single relay tool call. Each member speaks from its **own hidden Session per group**, sees only what is new since it last looked, and is told its place in the round.
4. **Work never holds a round up**: a member still busy 15 s after its first tool call lets the round move on and posts later; silence for 4 min is a "no answer" notice; members waiting for an approval yield; the user's own messages during a round join the round at once.
5. **No count limits between Bots** (they were removed); instead structural guards: a **work tree** for private Bot-to-Bot delegation (a reply only goes up once everything handed on is back; messaging a Bot that waits on you is refused), merging unread messages, idempotent `request_id`, and an **idle guard** that pauses a group after 6 consecutive tool-less "ack/standby" turns.
6. **Memory in three scopes** (Bot, group, team) as Markdown (`MEMORY.md` + topic files, Agent-Memory-Repo line format with id/source/by/added/until/pinned), written by tools, by an **automatic post-turn review**, and by the user's **memory panel** (model-written summary, all entries, change history with per-row undo, "ask or update", move between scopes), plus a daily **tidy**. Memory is **data, never instructions**; key-like text is refused.
7. **Prompt-cache discipline everywhere**: the system prompt is byte-stable per Session; memory is frozen at a part's start and changes arrive as small appended messages; group memory comes as a snapshot *message* so group Sessions share the Bot's own prefix.
8. **Long chats never "fill up"**: a small "context steward" call decides *compact in place* vs *move to a fresh part* (handoff note + recent verbatim user messages); old parts are full-text searchable by the Bot (`read_own_chat`).
9. **Per-Bot runtime**: own model + thinking level, permission preset, working folder, capabilities, connector switches, private flag, own browser profile, computer-use level; a Bot can be a local agent CLI.
10. **A polished, motion-led UI**: animated characters whose motion shows state (thinking/searching/working/sending/waiting/alert/done), a header "island" that stretches for events, one capsule above the composer for everyone at work, a Usage page with ranges/compare/heatmap/drill-down, and a written UI standard (springs, radii, type scale, colours, a11y).

**Synapsez today** already has the core shape (Chief, admin-first groups with `@Name` hand-offs, bot + group memory as data, details panel, settings with usage, scheduled tasks per bot, faces, notices) and is stricter in several places that must not regress (tenant scoping, approval for memory/instruction writes after outside reads, a hard cost ceiling, incognito, a private chat that never enters a group).

**Biggest gaps, ranked** (detail in §6): (1) a *security* gap Synapsez has that DS Bot's structure also has — text relayed by another bot in a group does not count as "outside content", so Chief can plant instructions/memory unasked; (2) the user cannot write into a group while it answers (409) — DS Bot folds it into the running round; (3) memory sits in the system prompt and changes it per turn (cache misses) — DS Bot freezes + sends deltas; (4) missing group **notice**, "admin passed" notice, per-member stop/status, live status in `list_bots`; (5) memory panel lacks edit/pin/until/summary/history/undo; (6) no Bot-to-Bot private delegation (`message_bot`), `post_to_group`, `stop_bot`, `read_group_chat`/own-chat search; (7) Usage page lacks compare/heatmap/drill-down/"what for"; (8) no first-run guided Chief onboarding; (9) sidebar lacks unread/approval/working states, pin, context menu, search.

---

## 2. Files read (checklist)

Legend: **F** read fully · **P** read in part (structure + the parts that bear on the Bot page) · **H** headings/skim only · **–** not opened (listed for completeness).

### DS Bot — top-level docs
- F `README.md` · H `README.zh.md` (same structure as English; translation) · F `docs/vision.md` · H `docs/vision.zh.md`
- F `ds-bot/README.md` (features, config, models, memory, web search, browser, secrets, data layout, dev)
- F `AGENTS.md` · H `CONTRIBUTING.md` · H `CONTRIBUTING.zh.md` · F `SECURITY_MODEL.md` · F `docs/known-issues.md` · – `docs/known-issues.zh.md`
- F `CHANGELOG.md` (0.1.0 → 0.3.2, links stripped)
- F `docs/design/ui-standard.md` (draft 0.2: colours, type, spacing, radii, elevation, icons, characters, motion, components, copy, a11y, deviations, decisions)
- F `.github/ISSUE_TEMPLATE/bug.yml` · H `config.yml`, `install.yml`, `pull_request_template.md`
- – `NOTICE` (DS Bot's), `LICENSE`, `docker/*`, `app/*` (Electron shell), `mobile/*` code, `browser-plugins/*`, `scripts/*`

### DS Bot — design plans (`docs/plans/`, Chinese)
- F `README.md` (index) · F `2026-10-07-group-chat.md` · F `2026-10-07-roles-and-permissions.md` · F `2026-10-16-bot-handoffs.md`
- F `2026-10-09-context-and-memory.md` · F `2026-11-09-memory-layers.md` · F `2026-11-01-memory-restore.md`
- F `2026-10-10-bot-runtime.md` · F `2026-10-27-private-bots.md` · F `2026-11-01-group-goal.md`
- F `2026-11-04-sidebar-sections.md` · F `2026-10-23-avatar-library.md` · F `2026-10-16-long-messages.md` · F `2026-10-22-message-layout.md` · F `2026-10-27-agents-md-upkeep.md`
- F `2026-10-20-widget-views.md` · F `2026-10-21-btw.md` (Side chat) · F `2026-10-13-dsh-concessions.md` · F `2026-10-08-browser-and-secrets.md` · F `2026-10-21-browser-plugins.md` · F `2026-11-04-computer-use.md`
- P `2026-10-26-windows-onboarding.md` (§5–§7: Main Bot setup card, first useful reply, repair card, first hour) · P `2026-11-04-connectors.md` (per-Bot switches, cards) · P `2026-10-24-mobile-app.md`
- H `2026-11-04-im.md`, `2026-11-04-local-agents.md`, `2026-10-27-office-documents.md`, `2026-10-16-desktop-app.md`, `2026-10-26-start-window.md`, `2026-10-29-start-copy.md`, `2026-10-21-linux-app-package.md`

### DS Bot — host (`ds-bot/src/host/`)
- F `constants.js` · F `prompt.js` · F `roster.js` · F `groups.js` · F `group-log.js` · F `handoffs.js` (status + work tree)
- P `tools.js` (every team tool definition and refusal; tool scoping) · P `memory.js` (layout, section builder, freeze, pre-step messages, tools, panel) · F `memory-entries.js` · F `memory-copy.js` (rules, review/tidy/ask/summary requests) · P `memory-review.js` (header, constants, batching) · F `memory-search.js`
- P `turns.js` (header, failures/blocked, routing index) · P `delivery.js` (message headers by role) · P `schedules.js` · P `usage.js` (header, ledger) · P `steward.js` · P `steer.js` · F `thinking.js` · F `time-context.js` · P `feed.js` · P `goals.js` (limits, `group_goal` tool) · P `learning.js` (constants) · P `chat-index.js` (own-chat brief)
- H by name/grep only: `parts.js`, `store.js`, `channel.js`, `models.js`, `providers.js`, `permissions.js`, `privacy.js`, `folders.js`, `capabilities.js`, `secrets.js`, `images.js`, `side.js`, `btw.js`, `resume.js`, `requests.js`, `approvals.js`, `connectors/*`, `im/*`, `local-agents/*`, `browser*`, `computer/*`, `avatar*.js`, `diagnostics.js`, `update.js`, `dsh-update.js`, `home-lock.js`, `memory-tidy.js`, `memory-pending.js`, `office-skills.js`, `goal-skills.js`, `links.js`, `text.js`, `files.js`, `legacy.mjs`
### DS Bot — shared
- F `shared/mentions.js` · F `shared/group-replies.js` · – `shared/im-platforms.js`

### DS Bot — client (`ds-bot/src/client/`)
- F (strings) `i18n.js` — every English source string extracted (≈1,490 keys), which maps every UI state
- P `details-drawer.js` (whole Bot and group layout) · P `sidebar.js` (rows, tile, previews, comments index) · P `new-chat.js` · P `mark.js` (states, stars, group avatar) · P `cells.js` (group replies, team tool lines, events, activity rows)
- H (comment index + strings): `member-status.js`, `activity-row.js`, `at-menu.js`, `handoff-card.js`, `header.js`, `team-actions.js`, `create-bot.js`, `bot-draft.js`, `bot-settings.js`, `group-settings.js`, `memory-panel.js`, `usage-page.js`, `usage-data.js`, `schedules.js`, `goal.js`, `queue-dock.js`, `turn-error.js`, `turn-reasoning.js`, `text.js`, `approval-notices.js` (F)
- – the rest (`styles.js`, `browser-pane.js`, `connectors*.js`, `im-page.js`, `computer.js`, `secret-card.js`, `model-menu.js`, `characters.js` data, etc.)
### DS Bot — tests
- – `ds-bot/test/*` (≈200 files): names listed only; behaviour was read from source and plans instead.

### Synapsez (`d:\AI remote`)
- F `NOTICE` · F `server/bots/memory.js` · F `server/bots/prompt.js` · F `server/bots/rounds.js` · F `server/bots/team.js` · F `server/bots/tools.js` · F `server/routes/bots.js`
- F `public/js/bots.js` · F `public/js/bots-settings.js` · F `public/js/bots-usage.js` · F `public/js/bot-mentions.js` · F `public/js/bot-avatar.js`
- P `server/agent.js` (bot persona, withheld tools, `MEMORY_WRITES`, `turnReadOutside`, model choice) · P `server/store/pg.js` (schema 42/43 bot tables) · P `server/scheduler.js` (bot tasks) · P `server/redact.js` · P `public/js/app.js` (home-chat lending L3160–3257) · P `public/css/app.css` (Bot page media queries L12474–12490) · P `public/js/locales/{en,vi}.js` (142 `bots.*` keys each)
- P `test/bots.test.mjs` (header + every `check(...)` line) · – `test/ui-bots.test.mjs` (name only)

---

## 3. DS Bot, mechanism by mechanism

### 3.1 Architecture and data
- **A Bot = a Session chain.** `bot.sessionId` is the current part of its own chat; `bot.segments[]` the earlier parts. In each group a member has its own Session (`room.sessions[botId]`) with its own segments. A group also has its **own Session**, which only relays.
- **Team file** `state.json` (bots, rooms, Bot-to-Bot exchanges, prefs, open questions/views, works). Written whole on every save, so every long text keeps only its first **2,000** chars there; the rest lives where it was delivered, or in `group-lines/<room>/<seq>.txt` (≤**20,000** chars, removed when the line leaves the latest **60** lines), or `handoff-results/<work>.txt`.
- **One writer per team**: `state.lock` (pid + heartbeat); a second DSH on the same home opens the team **read-only**, shows why, refuses changes, and takes over on its next request when the first exits.
- **Indexes**: `chat-index.sqlite` (FTS5, trigram; ≤2-char words via LIKE) for earlier parts; `usage.sqlite` (rebuilt from Session logs); `group-logs/<room>.jsonl` (every group line forever, for the review and `read_group_chat`).
- **Tools are scoped per Session**: a Bot's own chat and its group Sessions get every team tool; a group's own Session gets only the relay tool; ordinary DSH Sessions get none. DSH's own blocking question tool, its goal tools and all delegation tools (subagents, workflows, teammates) are hidden from Bot Sessions (and a guard refuses them), so all parallelism is Bot-to-Bot and visible.
- **Live feed**: an SSE stream (`revision`, `live`, `message`, `stream`) for windows that draw the team; the group reply cell additionally polls round progress every **1 s** (**5 s** when the tab is hidden).

### 3.2 Roles and rights
| Who | Can |
|---|---|
| User | everything; only the user sets/clears Main Bot, private flag, permission presets, browser grants, what a Bot "runs on" |
| Main Bot (≥1; several allowed) | create/change any non-private Bot, `stop_bot`, create/change/**delete** groups, post into any group, run any group's goal, write team memory, read/write another Bot's memory **when the user asks**, attach/detach capabilities, move entries between sidebar sections |
| Group admin (one per group, must be a member) | change its own group (name, notice, members, admin, reply mode), set/run its goal, post into it, write team memory; cannot delete the group or set its folder/permissions; cannot leave without handing the role on |
| Ordinary Bot | change **itself** (name, role, colour, model, thinking level, folder, instructions, capabilities), speak/`@` in its groups, post into groups it is in (calls only those it names), `message_bot` anyone non-private, read/write its group's memory there |
- Rights come from the calling Session's owner, never from tool arguments. Refusals are written so the model can re-route ("ask a Main Bot", "add it to the group first").
- A Main Bot cannot be deleted until it loses the role; the team always keeps one; deleting a Bot leaves the groups it led **without an admin** (they then answer as "everyone").

### 3.3 Bot lifecycle
- **Create (form)**: "New…" pane → *Create new Bot* (or type a name that does not exist → *Create new Bot "X"*). Form order: what it runs on (DS Bot model / local agent CLI) → look (20 characters × 12 colours + aurora, or photo upload, or the avatar library; Shuffle) → name → model (+thinking level). Nothing exists until **Create**. Model default: team "default model for new Bots" if served and usable → DSH default → first usable. After create: opens the Bot's chat **and** its details in settings view.
- **Create (tool)**: Main Bot only; params name, role label (short), instructions, optional brief, model, effort, work_dir, section, avatar (path or data URL ≤~120 KB). Model fallback: team default → creator's own model → none.
- **Kickoff greeting**: right after creation the new Bot gets a hidden setup message and **greets the user in its own chat** (one model call). Wording depends on: first Main Bot (greets, says it runs the team, asks what to start with), a copy ("same job, fresh memory"), made by another Bot (that Bot's name + the brief), made with a typed first message (introduce + help with it), or plain. A greeting is held until the Bot has a usable model; held again if a key/sign-in/balance failure blocks it; dropped if the user writes first (except the first Main Bot, which then answers that message first).
- **Names**: ≤40 chars, trimmed; no `@`, backtick, newline; not "all/everyone/所有人/全体" (they call everyone) nor "user/you" (the transcript speakers). Unique, case-insensitive, and **held** between check and write so two concurrent creates cannot take one name. Role label ≤24 chars. Instructions unbounded (trimmed).
- **Edit**: in the details panel (inline rename by clicking the name; model menu; permission picker; folder menu) or the settings form (avatar editor, name, label, runs-on, instructions, memory row, tasks, Main Bot role, sidebar pin/hide, privacy, duplicate, delete). The settings form **saves on blur or Enter**, no Save button; Escape restores the saved value; a required field never saves empty.
- **Profile-change notice**: when role or instructions change (by user or another Bot), the Bot's chat gets a short "your profile changed, follow the latest" message so its next turn follows it — except when the Bot edited itself in its own chat in the same turn.
- **Duplicate**: copies job, look, model, effort, folder, section; fresh memory; name "X copy", "X copy 2"…; private Bots cannot be copied.
- **Delete**: user only; two-click "Click again to delete. Its chats are archived." Archives memory to `memory/archive/`, removes it from every group (admin → none), drops its secrets' grants, archives every part (stopping scheduled tasks on them), tells every Bot waiting for its reply that it was deleted.
- **Sidebar flags**: pin (kept above others), hide (search still finds it), mark as unread, sections (below).

### 3.4 Chief / Main Bot
- Made on first load: name/role from defaults, the DeepSeek-blue **whale**; starts with **no model** so its chat opens on a **model setup card**; greets only once a usable model works (no chat ever starts with a red error).
- **First-run (new teams)**, a code-driven step table (the model never chooses the next step; Chief's tools are restricted to the card tools during it; every step has a no-model fallback; ≤3 model calls in total, 700 max tokens, 8 s first-token / 12 s total budgets):
  1. setup card (sign in or paste key, checked before saving; balance checks);
  2. a **fixed** greeting (no model call);
  3. **goal card**: four multi-select toggles (writing, coding, research, chores) + "in your own words" field; Confirm/Skip;
  4. **suggestion card**: one row per suggested Bot (checkbox, its whale in a distinct colour, editable name ≤12 chars, role ≤4 chars, one-line reason); "Create these N Bots", "Only {first}", "Another set" (counts toward the 3-call cap), "Skip setup";
  5. created Bots each get a **fixed** first message (name + reason, no model call); then a first-task card.
- Rules Chief carries (paraphrased): run the team and report back; check `list_bots` before `create_bot`; give each new Bot a short name, a short role label and concrete instructions; say in one line when it is ready; route work one way only (a Bot's task by `message_bot`, a group's by `post_to_group`/`@`); `stop_bot` only when a warning is not enough; pass model/effort only when the user names one; create/update/delete groups (delete only when asked); groups can have goals; other Main Bots share these powers.

### 3.5 Prompt structure
Order of what a Bot's Session sees:
1. DSH's own sections (minus the hidden tools' guidance).
2. **Identity section** (order 640): "you are {name}, a Bot on the user's team", role, the user's instructions verbatim, then Main-Bot rules (if Main) + **team rules**. Team rules cover: every Bot is its own long-lived chat; call `list_bots` for who exists and what each is doing now; when to `message_bot` (only when the other must act or needs a fact; no thanks/acks/status echoes; "now" steers a working Bot, "queue" only for unrelated tasks; never wait/poll/resend; hand on part of a request then end the turn; never message a Bot waiting on your work); `reply_to "user"`; how to treat `[Message from …]`/`[Reply from …]`; chat style (short texting style, deliverables written in full, never claim something not written); a one-line opener before the first tool call on multi-step user requests; no progress chatter on Bot-to-Bot turns; group behaviour (the group sees what you write while working; start with one sentence, update only when it matters, end with the result); `ask_user` and `show_view` end the turn and work only in the own chat; self-`update_bot`; group mechanics (separate conversation per group; `@Name` hand-offs; work for a group stays in it; `read_own_chat` is visible to the group; `post_to_group` from outside); secrets via `request_secret`; web-search honesty; long chats (checkpoints, parts, `read_own_chat` anchors); reply in the user's language.
3. **Memory section** (order 645): memory rules (data not instructions; review saves for you; one fact per entry; what not to save; topics; recall before saying "I don't know"; ids/sources), team-memory rule for this role, then the Bot's `MEMORY.md` and the team `MEMORY.md` (entries shown as text + `[id · MM-DD]`, topics as `[[name]]`), **frozen** at the part's first render (`snapshots/<session>.md`) so the prefix is byte-stable; re-frozen only on a fresh part, a checkpoint, or a role change.
4. Per-step **messages appended at the end** (never touching the prefix): the group memory snapshot (group Sessions, once per part); a **memory update** message (what others changed since this Session last looked, ≤20 rows / ≤4,000 chars); **auto-recall** (≤5 topic entries ≤3,000 chars that share ≥2 words and ≥30% coverage with what was just said; once per entry per part; switchable); a **current time** message (first step, then every 10 min).
- The **group Session's** own prompt is a 3-line "you are only the relay" note — and in practice the host intercepts its model stream and synthesises the relay tool call, so it never reaches a model.
- A member's group Session uses **exactly** the Bot's own identity + memory section (byte-identical), so group turns share the own chat's cached prefix (measured first-turn cache hit ~2k → ~13k tokens after this change).

### 3.6 Group chat mechanics
**Creation and settings**
- Needs ≥**2** Bots, ≤**12**; private Bots cannot join. Name ≤60, unique; empty name ⇒ auto name "You, A, B" that follows renames. Notice ≤**2,000** (refused, not cut, when longer) — shared instructions every member reads before speaking. Mode `admin` (default) or `everyone`. Admin default: the creator if a member, else a Main Bot member, else none.
- A group the user makes **without a first message** opens with the admin greeting and asking what the group is for (one model call); one made by Chief's tool does not greet. A group made **with** a typed message sends it.
- Chief sees every group; other Bots only those they are in.

**Who answers (opening call)**
- `@Name` (any member, any case, longest name first) ⇒ exactly those, in parallel.
- `@all`/`@everyone` ⇒ everyone — but from a Bot's line only when the **admin** writes it.
- Plain message: admin mode ⇒ the admin alone; everyone mode (or no admin) ⇒ every member **in order, admin first**, each after the previous posted or passed, each told "you are number i of n, k go after you".
- Ordinary member's post calls only those it names; Main Bot's/admin's post opens a normal round.

**Mention rule** (shared by host and page): not after a letter/digit/`_`/`.`/`/` (addresses, `medium.com/@x`); not when the name runs on into a letter/digit/`_`/`-`/`/`/`\` or a `.` followed by a word char (file references like `@docs/guide.md`); not inside code spans, fenced blocks, or Markdown links; DSH chat-reference labels are references, not calls; the speaker's own name takes part so `@新 Bot 2` is never read as `@新 Bot`.

**The round engine** (one per relay call)
- Slots with statuses `waiting → speaking → posted | passed | working | waiting-approval | missed | failed | left | cancelled`. A slot can start when its member answers nothing else in this round and (if ordered) all earlier ordered slots are done. The loop wakes on: a turn ending, a new call, a user message, stop.
- **Calls take effect at once**: every line a member writes *while working* is posted to the group and any `@` in it starts those members immediately — not after the speaker finishes. "Call members before you start on your own part."
- Members called in one line form a **batch**: when Bot X calls B and C together, X is woken **once**, after the last of them finishes, and only if they actually worked (used tools) and none of them already answered by `@`-ing someone. If X is still in its own turn, it is woken after that turn.
- **User messages during a round** are drained from the group Session's inbox into the log at once and call their speakers inside the running round (a message with images or chat references waits for its own round). The user's own `@` is always answered.
- **One call at a time per member**; a waiting call that is called again keeps one slot with the newest note.
- The round ends when nothing runs, nothing waits, and the inbox is empty. Then (if a goal is active and nothing runs) the admin may be woken for a goal check.

**What a member is told** (each turn, as the user message of its group Session)
- Members list (the user, peers with "(admin)", "you"), the calling rules, the notice, the goal block, an admin note (if admin), **earlier lines** before the round (≤8, "context only"), **this round's lines** (first look: last **12**; later: up to **24** unseen, excluding its own), each line up to **20,000** chars (cut marker with total length), referenced chats (once per member per round), "still at work: X (n min, k unread)", its **place** (order position, or "called together with … you do not see each other's replies until they post"), the others' statuses in this round, and reply rules (no name prefix; make the first tool call in the same step as the opening note; the group sees what you write; end with the result, never a promise; `[PASS]` to stay silent).
- A **brand-new** member Session starts with a fixed brief of the member's latest **10** own-chat lines (each ≤400 chars), labelled private ("share only what the group needs"). More only via `read_own_chat`, and the group **sees** each lookup as an event line.
- Images and files on the shown lines are attached to the member's prompt.

**Posting back**
- Final text minus an echoed "Name:" prefix (also bold/full-width colon) is posted; `[PASS]`/`【pass】`/`(pass)`/empty = silence.
- Step lines written less than **30 s** apart are merged into one post; the first line on asked-for work and any line that calls someone go at once.
- **Work grace**: a member still busy **15 s** after its first (non-team) tool call → slot `working`, an event "X started on it", the round goes on; its result posts later as a **late reply**, answered by whoever asked for it (not by the admin; work the user asked for is left for the user).
- **Silence timeout**: **4 min** with no event from the member's Session → `missed` + a notice explaining the round moved on and what brings it back.
- **Approval**: member needs a yes → `waiting-approval`, event "X paused for your approval"; the capsule and group details list it with **Allow once / Reject**; a system notification fires if permitted and the window is not showing that chat. The turn continues in the background after the decision.
- **Model failure** → `failed`, event row with code, and a log line so later speakers know the work stopped there.
- **Promise-only guard**: a called member that only says "on it / checking now" without calling a tool is auto-continued once on the same call (it may `[PASS]` if the line already answered; "already done" wording is not re-pushed).
- **Admin passed alone**: in admin mode, if the admin was the only speaker and passed, the group gets a notice "X did not answer or call anyone; call a member with @Name".
- **Idle guard**: per group, count consecutive Bot turns with **zero tool calls** whose text is only acks/thanks/"standing by"/repeats; at **6** the group pauses: a notice explains, the calls those turns would make are **parked** (not dropped) and run only after the **user** writes. Real work or new content resets the count before a pause; once paused only the user lifts it.

**Bot posts from outside** (`post_to_group`): from a Bot's own chat or another group; `report_back:true` returns the replies (who replied, who is still working, who waits for approval, who passed/failed) to the conversation the post came from; a post landing during a round joins that round. In a group, `message_bot` to a member is exactly an `@Name` line there; to a non-member it is refused ("add it to the group first"); the same work may not be sent both via `post_to_group` and `message_bot` in one turn.

**Stopping**: group details → "Stop all" (stops the relay round, then each member's work in this group, including their subagents; each stopped member leaves "stopped" in the log; their work elsewhere continues) and a Stop per member.

**Restarts**: a member cut off by a DSH restart picks its work back up and the group sees "X was cut off by a restart and picked its work back up"; a second cut stops it ("ask it to go on").

**Log line kinds**: user line, member line, `lookup`, `resumed`, `cut`, `stopped`, `done`, and `notice` with reasons `missed`, `paused` (idle / legacy limit), `admin-passed`, `folder` (group folder gone), `goal` (draft/start/pass/rework/revise/pause/resume/complete/stop), `failed`. Notices store **fields**, and the sentence is composed when read, so old lines stay true when wording changes.

**`read_group_chat`**: latest 30 lines (each ≤2,000, with "read seq N whole"), a `seq` to read one line whole however old, or a word search over the full log (newest first, ≤20).

**Group goal** (admin or Main Bot via `group_goal`): states drafting → active → paused/complete/stopped (≤5 past goals kept); title ≤80, objective, acceptance, constraints (≤20 × 300), stages (≤20; title ≤80, acceptance ≤1,000, tasks ≤12 × 500 each assigned to one member); task statuses pending → working → reported → done; `pass` requires evidence; `rework` sends tasks back; every member turn carries a `<group_goal>` block (full ledger for the admin, own task for others) in the round message, not the system prompt; auto-nudge the admin when a round ends with an active goal and nothing running, stop nudging after 2 idle nudges or an admin `[PASS]` ("waiting for you"); UI = header island + hanging pod (stage bar, faces with state) + focused stage panel with stepper.

### 3.7 Bot-to-Bot outside groups
- `message_bot(to, message, reply_to me|user, when now|queue, request_id?)`. "now" reaches a working Bot at its **next step** (it can change course) and it answers once its work is done; "queue" waits for the work to end. `reply_to:"user"` ⇒ the recipient answers the user in its own chat, nothing comes back. Replies arrive later as `[Reply from …]`; the sender must not wait or poll.
- **Work tree**: a request is a *work*; what the recipient hands on while working on it hangs below; its answer goes up only when every child is back, with the children's results appended (`[Handed back to X for this work]`). The only refusal: messaging a Bot that is waiting on the work you are doing (loop). Same Bot may appear several times (design → build → review → accept).
- **Unread merge**: a second message from the same sender for the same work, not yet read, is merged into the first (one reply answers both); result tells the sender.
- **request_id** (≤ a name limit): same id + same content ⇒ the first receipt is replayed, nothing re-sent; same id + other content ⇒ refused; unknown outcome ⇒ refused with "check first".
- **Status** of every Bot, first match wins: waiting for the user's approval (where, how long) → moving to a fresh part → working (own chat or which group, minutes, for whom, which tool on what, or its last words) → waiting for others to hand back (whom, for whom) → idle; plus "question card waits" and "unread: n from X". Shown in `list_bots`, in `message_bot` results, and as the avatar motion; **never** in the system prompt (cache).
- **Give up a wait** (right-click a waiting Bot → "Give up waiting for X"): settles that one branch with an explicit "no reply came back" result so the parent continues; a late real reply is delivered marked late and settles nothing; on restart, waits whose target Bot/group no longer exists are settled the same way. No timeouts.
- `stop_bot(bot, reason)` (Main only): cancels its running turns everywhere, drops its queued messages, tells it why in a new turn whose reply returns to the stopper.
- Message headers the recipient sees: `[Message from X]`, `[Reply from X · for the work Y asked you for…]`, `[Stopped by X]`, `[Group chat "G" · note]`, `[Group chat "G" · replies to your post]`, `[Bot team setup]`, `[Your profile was updated…]`, plus restart/retry variants.
- Hidden turns: a turn that answers another Bot is hidden from the user's chat; the chat shows one folded line "N messages with X" that opens the **Bot exchange** dialog (the transcript between the two Bots, newest first, following new replies).
- Long messages >**20,000** chars go as an attached file (first **1,000** chars inline + a note to read it all; shell hint if a line >2,000).

### 3.8 Memory
- **Scopes**: Bot (`memory/bots/<id>/`), group (`memory/groups/<id>/`, read only by members and only in that group), team (`memory/team/`, read by all). Removal from a group revokes at once (its group Session is retired; tools re-check membership).
- **Format**: Markdown; `MEMORY.md` with entries above `## Index` and `[[topic]]` links; topic files (≤40, ≤16,000 chars each; full topics continue as `topic-2`; `earlier` is where overflow goes). Entry line: `- text [id: 7f3a; source: part 2 #1234 | group "G" #88; by: Bot; added: YYYY-MM-DD; until: YYYY-MM-DD; pinned: user]`.
- **Limits** (entry text only, metadata free): entry **300**; `MEMORY.md` Bot **8,000**, group **12,000**, team **4,000** (user-changeable); each layer ≤**2%** of the model's usable window in the prompt (newest and pinned kept, "n more" noted). A write **never fails for room**: oldest unpinned (expired first) entries move to `earlier`.
- **Team memory**: what every Bot always reads takes only what the user says (the `always` flag or the panel); other team writes wait in topic `shared` for `recall`/auto-recall.
- **Write paths** (one writer, one at a time): tools (`remember` with `replace`/`topic`/`until`/`pin`/`always`/`scope`; `forget`; both throw a coded error when nothing was saved so the model and UI see it); the **memory review**; the **panel**. Key-like / password-given / ID-number / ≥15-digit text is refused. Each change writes `pending.json` first, then files, then a `journal.jsonl` row (before/after line); a torn journal row moves to `journal.torn`. Private Bots keep their own journal.
- **Memory review** (after a conversation goes idle, 2 s delay, one at a time, `memoryReview:false` turns it off): own chat → the Bot's model writes the Bot's memory; a group → **once per group** with the admin's (or first member's) model, into group memory only. Reads new lines (first review back to the user's latest line, ≥6 lines; 4 context lines; ≤16,000 chars; user lines ≤3,000 keeping both ends, others ≤800); shows the current memory (≤16,000 chars, related topic entries first); answers JSON ≤**8** changes (add/edit/remove; add may carry topic, until, team, for-Bot, for-group); keeps only the user's lasting preferences/decisions/corrections/facts; never what a Bot said about itself, pasted/quoted text, one-off task details, keys; groups additionally keep project rules but not task results. Entries written in the user's language (detected by script).
- **Tidy** (background, at most daily per changed memory, ≤1/5 of entries per pass): contradictions → repeats → stale status → move details to topics; never retires a user preference for being old; soft archive (`retired.jsonl`); the panel shows each pass and **undoes it whole**.
- **Reading**: resident (`MEMORY.md`s, frozen per part), delta (update messages), auto-recall, on-demand (`recall`: no args lists everything by scope, `query` searches with BM25 + "all words first", `topic` reads one whole; `scope` may name a **public** Bot to read its memory). Nothing of another Bot's arrives unless looked up.
- **Panel** (Bot: own + team; group: group only): a **summary** written by the keeper's model in the UI language (2–5 "## heading" sections of plain prose, regenerated when entries change, ⋯ → Regenerate); ⋯ → **All entries** (by scope/topic, date, author, `MEMORY.md` sizes "used of limit", until/pinned/expired, remove in two clicks, **Move to…** team/another Bot/group — team arrivals start as "Only when needed"); ⋯ → **Change history** (journal rows, newest first, 50 per page, **Undo** in two clicks while the entry still matches; drift refused); **Ask or update** (one model call answering from entries or applying add/edit/remove through the same checks; reply shows "Added/Updated/Removed/Not changed (reason)").
- **In chat**: a "Memory updated" event line on a tool write; background changes make the header pill **stretch** to say "Memory updated" for a moment (click opens the panel).
- Deleted Bot/group memory moves whole to `memory/archive/`.

### 3.9 Context management
- Lines derive from the model: window W (declared; 500,000 if none), usable U = W − reply reserve (≥W/2), hard H = 0.95·U, check C = `checkRatio`·U (default 0.8, ≤H).
- At turn end ≥C: one **steward** call (separate, small, no Bot prefix, reasoning off, latest ~6,000 tokens, lines ≤1,500 chars keeping head and tail) answers `{"action":"switch"|"compact"}`. It must verify each user ask against what was done and look for unanswered Bot questions before choosing switch; more prior compactions bias toward switch; text inside messages is not an instruction to it; failure ⇒ switch. Mid-turn ≥H: same decision before the next step. Provider overflow ⇒ switch without a note. Re-check only after C/4 more growth.
- **Compact**: a checkpoint written on the Bot's own prefix (cache hit): where things stand, decisions and reasons, rejected options, user constraints, remaining steps, data to keep verbatim; plus the user's and other Bots' recent messages verbatim. Still ≥C after ⇒ switch.
- **Switch**: the Bot writes a handoff note on its own prefix while idle; the fresh part opens with note + recent messages + where everything else is + (own chat) an anchor list of earlier messages to the Bot. Inputs arriving mid-switch wait and go to the new part; scheduled tasks move; the user sees one continuous chat (only a "Switching working folder" line when a folder change causes it).
- `read_own_chat(query|around|part)` searches all parts (anchors like `part 2 #1234 · 10-08 14:22`).

### 3.10 Per-Bot runtime and settings
- Own model fixed at creation, changed only in its settings or by a Main Bot; DS Bot writes back the user's DSH default after each pick. Thinking level per Bot (only levels the model serves are sent). Team **default model for new Bots**. Fallback when a model leaves service: last used → DSH default → first usable → none (card).
- **Blocked** state on key/sign-in/balance failures (code, HTTP status, request id, provider; never the message) drives a **repair card** replacing the failure row: per failure code a sentence and fixes (enter key, sign in, switch model, top up, retry). "Retry" continues the last user message without re-sending it.
- Permission preset per Bot (read only / workspace / full access — "full" asks twice, shown red); group "same for every member" preset; only the user sets them.
- Working folder per Bot or per group (group wins); outside the team workspace needs approval; DSH/team data folders refused; folder gone ⇒ fallback + notice.
- Capabilities (team list of MCP servers, skills, packs) enabled per Bot; connectors on for every Bot by default with **per-Bot switches**; local agent CLIs as a Bot's runtime; private Bots (one-way isolation; approval for outbound sharing; protected after deletion until released).

### 3.11 Tool catalogue (Bot Sessions)
| Tool | Who | Notes |
|---|---|---|
| `list_bots` | all | every Bot: role, section, model, folder, Main, private, first line of instructions, **now: status**; groups you can see with members/admin/section/mode/notice line/folder/permissions/goal stage |
| `message_bot` | all | §3.7 |
| `stop_bot` | Main | §3.7 |
| `create_bot` / `update_bot` | Main / self (Main for others) | §3.3; `update_bot` can change model/effort/folder/avatar; engine switch user-only |
| `list_bot_models` | all | refs, image support, default, thinking levels |
| `create_group` / `update_group` / `delete_group` | Main / admin+Main / Main | notice, mode, admin "none" (Main only), section, work_dir (Main) |
| `post_to_group` | Main any; member own groups | `report_back` |
| `group_relay` | group Session only | synthesised |
| `read_own_chat` / `read_group_chat` | all | §3.6, §3.9 |
| `remember` / `forget` / `recall` | all | §3.8 |
| `ask_user` | own chat only | 2–4 (≤6) options, detail, multi, custom answer; ends the turn |
| `show_view` | own chat only | JSON blueprint of a fixed component catalogue (stack/row/text/metric/table/chart/progress/callout/sources/html sandbox; inputs slider/number/choice/toggle with local formulas; answers options/confirm/form/submit); ≤8 KiB, depth 8, 64 nodes, table ≤50×8, form ≤6 fields, options ≤8 |
| `request_secret` / `list_secrets` | own chat | secure card; value never seen; `$DSH_SECRET_<NAME>` |
| `group_goal` | admin/Main (show: all) | §3.6 |
| capabilities ×5, `list_connectors`, `request_connector`, mail tools, `read_browser`, browser plugin tools, computer tools | per settings | |

### 3.12 Scheduling
- DSH's Automation tasks; per **Bot** (delivered to its own chat, moved along with each fresh part) and per **group** (delivered to the group's own Session, read as the user's message `[Scheduled task] …`). Kinds: once (future date/time), daily (time), weekly (days + time), every N minutes (1 min–7 days); title ≤120; "what to do". Created in Settings → Scheduled tasks, from the composer's **+ → Scheduled task**, or by the Bot itself (its schedule tools are fenced to its own chat's tasks). Details panel shows the Bot's next tasks or "tell the Bot in its chat what to do and when". States: scheduled / overdue / paused / finished.

### 3.13 Files, images, long text
- Files and images go with group lines to every member the line is shown to; images are OCR'd to text for text-only models (cached). Long messages fold in the UI (>1,500 chars or 25 lines → first 10 lines ≤600 chars, "Show all · N characters"; a Bot's own replies to the user fold only past 20,000). Steer queue shows attachments as thumbnails.

### 3.14 Streaming and live UI states
- Own chat: normal DSH streaming; **steering** — a user message sent while the Bot works cuts the running model call and is moved to the front, so the Bot reads it at once ("Not read yet" under it until read; Enter on an empty box sends queued messages into the running turn).
- **Activity row** at the transcript tail: Bot mark (state motion) + shimmering phrase + clock (`8s`, `1m 8s`), phrase held long enough to read; generic rotating phrases ("thinking about it", "working out a plan"…) and tool-specific ones (searching online, reading a page, running shell commands, opening/looking through files, writing changes, working on an image, creating/updating/posting in a group, asking X, stopping X, creating X, checking the team, reading G, looking back through the chat, saving/updating/checking memory, moving to a fresh conversation, switching working folder).
- Group: pending speakers each show "Name · phrase…" or "Name is typing…" with their mark; one **capsule above the composer** for everyone at work/waiting (approvals first) that opens the group's details; a Bot's own chat shows a capsule for groups it is working in.
- Reasoning: hidden by default (setting "Show thinking"); when shown, one "Thinking" row with a live clock, then "Thought it through · duration", folded to the last lines.

### 3.15 Notifications
- System notification (only if already permitted; DS Bot never asks) when an approval starts waiting while the window is in the background or shows another chat: title "{Bot} is waiting for your approval", body "group · tool", click opens it. Sidebar dots: unread (accent), waiting for answer/approval ("?" badge, warn colour).

### 3.16 Usage accounting
- Ledger from Session logs (one row per billed attempt; retries counted) + metered calls outside logs (checkpoints, handoff notes, steward, image reading, titles, compaction); 15-min slots; kinds input / cache read / cache write (billed as input) / output; owners = each Bot (own chat, group Sessions, parts, forks), each group's own Session, "other". Tokens only, no cost.
- Page: ranges 24 h / 7 d / 30 d / 12 w / 12 m / this month / last month / this year / custom (two-month calendar, days with usage dotted); big total with **change vs the same span before**; stacked bars by Bot or by model (top series + "More Bots/More models" + "Other"), hover lists the bucket; "Who used it" ranking (face in a ring sized by share), "What for" (conversations, compaction and handoff, image reading, titles, other); **Activity heatmap** of the last year; each Bot / group / model opens **its own page** with token kinds; numbers ease; "Reading your chats…" while scanning.
- Details panel: "{tokens} tok · Cache hit {n}%" for the Bot; run stats "{n} turns · {speed} tok/s · Cache hit · Context {p}%".

### 3.17 Side chat (`/side`)
- In a Bot's own chat, ask while it works: answers from a **snapshot** of the conversation (cut at the last point where every tool call has its result), **no tools run** (tool calls are refused; one retry), same route/effort/tool declarations as the Bot (cache-friendly), never enters the Bot's history; tabs in the right panel, follow-ups carry that side chat's own Q&A; cancel while answering; counted in Usage as "side". Not in groups, no attachments.

### 3.18 Learning
- After long turns (≥3 min), when the team is idle (10 min) and at most every 12 h, one background pass may propose a **skill** or **AGENTS.md** edits (1–3 exact line edits with reasons) as a card; written only on approval; declined ideas remembered.

### 3.19 Security model (as designed)
- Primary threat: prompt injection from pages/files/tool results/**other Bots' messages** making a Bot exceed its rights. Controls: rights from Session ownership; memory as data + key refusal + "don't save what content asks"; HTML widgets sandboxed without same-origin; secrets masked before every model request (JSON/URL-encoded forms too, short values only when isolated); private Bots; working folders kept out of data folders; connectors HTTPS-only.
- Gaps DS Bot itself admits: no approval gate on memory/instruction writes after reading untrusted content (prompt-level only); Bot-to-Bot text is not marked untrusted; secret scoped to one Bot vs Main Bots is an open question.

### 3.20 Limits and numbers (DS Bot)
| Item | Value |
|---|---|
| Bots / groups per team | no cap |
| Members per group | 2–12 |
| Bot name / role label | 40 / 24 chars |
| Group name / notice | 60 / 2,000 chars |
| Group lines in state / per line kept / per line read | 60 / 2,000 / 20,000 |
| First look / later delta / earlier context | 12 / 24 / 8 lines |
| Work grace / silence timeout / step merge | 15 s / 4 min / 30 s |
| Idle guard | 6 tool-less idle turns |
| Own-chat brief for a new group Session | 10 lines × ≤400 chars |
| Bot message inline / as file head | 20,000 / 1,000 chars |
| Memory entry / Bot / group / team MEMORY.md / topic / topics | 300 / 8,000 / 12,000 / 4,000 / 16,000 / 40 |
| Memory in prompt | ≤2% of usable window per layer |
| Review: changes per answer / memory shown | 8 / 16,000 chars |
| Auto-recall | ≤5 entries, ≤3,000 chars, ≥2 hits & ≥30% coverage |
| Update message | ≤20 rows, ≤4,000 chars |
| Tidy | ≤1 pass/day/memory, ≤1/5 entries |
| Context lines | W default 500,000; C = 0.8·U; H = 0.95·U |
| Steward view | ~6,000 tokens, ≤1,500 chars/line |
| Goal | title 80, stages 20, tasks 12/stage, constraints 20×300, 5 past goals |
| show_view | 8 KiB, depth 8, 64 nodes |
| Scheduled task | title 120; every 1 min–7 days |
| Avatar photo | ≤160,000-char data URL; library ≤500 photos, 160×160 webp |

---

## 4. DS Bot UI, screen by screen and state by state

### 4.1 Frame
- Left column (own, drawn over DSH's collapsed sidebar): **264–420 px** draggable; drag below 176 px and release ⇒ **88 px avatar rail** (44 px avatars); a top-left switch hides/shows the whole column. Right panel: details **320 px**; browser 520 px (≥360, chat keeps ≥420). Narrowing the window folds the right panel first, then the left column to the rail; opening the panel on a narrow window folds the left column first and only then covers the chat. Desktop min width 508 px. Phone width: details cover the chat, settings fill the screen, menus stay above the on-screen keyboard, controls clear the home indicator, inputs do not zoom, a tap on a message opens its tools; window <1024 px: picking a chat closes the open sidebar.

### 4.2 Sidebar
- **Main Bot tile** (95 px wide, radius 12): 60 px live avatar with the large Main star, name, role chip. Not in any section.
- **Rows** (36 px avatar; 44 px on the rail): name (+agent badge, +pin mark), one preview line chosen by state: *running in own chat* → shimmering "{phrase}…"; *working in a group* → "{group} · {phrase}… +n"; *waiting on hand-backs* → "Waiting for X and Y"; else the last message. Right edge: accent **unread** dot, or a warn dot for approval/question. Group rows: composite group avatar (2 on a diagonal, 3 in a triangle, 4 in a grid, >4 three + "+N"; one Bot left shows the user beside it), preview or "{member} · {phrase}… +n". `aria-label` concatenates name, Main, Pinned, Working, waiting-for, approval/answer, unread.
- **Order**: pinned first, then latest activity; rows glide to new places (critically-damped spring).
- **Sections**: collapsible groups (30 px header, rotating chevron, optional colour dot, count); collapsed shows ≤3 tiny faces (+N) and an aggregate state (approval "?" > working dot > unread); the open chat's row stays visible under a collapsed header; header `+` (new Bot/group here, add existing) and `···` (rename, colour, move up/down, ungroup); drag rows between sections; rail shows a collapsed section as a 56×56 face cluster.
- **Context menu** on a row: Pin/Unpin, Mark as unread, Rename, Edit Bot / Group settings, Duplicate, Make Main Bot / Remove Main Bot role, Hide from sidebar, Give up waiting for X (only while waiting), Move to section…, Delete (danger, last). Typing while the sidebar has focus starts **search** (Bots, chats, messages).
- Foot: account avatar menu (Settings, Feedback…), update cloud button top-right when a newer release exists.

### 4.3 New chat / Create Bot / New group
- "New…" pane with a **To:** token field: search Bots by name or role; options *Create new Bot*, *Create group chat*, *Add DSH Agent*; picking one Bot opens its chat (a typed message is sent first); picking several makes a group; *Create group chat* asks for the **admin first** (star token), then members; placeholder "Message A and B". A typed message goes with the new group, otherwise the admin greets.
- Create Bot pane: §3.3; a back arrow returns to the list; created ⇒ open chat + details settings.

### 4.4 A Bot's own chat
- **Header pill** ("island"): 40 px, 24 px live avatar, name; on hover a right arrow springs in (←/→ while details open); click opens details; events stretch it ("Memory updated") with a spring and pop icon, then contract.
- Transcript: flat or bubble layout (Settings); bubble width slider 50–100% (default 80%); flat text width 50–100% (default 100%); in flat layout each reply has a head row (avatar, bold name, time) once per turn; time separators ("Today 1:12 AM", "Yesterday …", "Thu, Sep 3 …"); per-reply hover toolbar (reaction, reply, more: copy/download…); team tool lines as event rows with faces: "Messaged [face] X" (opens the exchange), "Stopped X", "Created [face] X", "Updated X", "Created group / Updated group / Deleted group / Posted in [faces] G"; failed versions ("Couldn't message X"); memory notices; folded "N messages with X"; question/view/secret/connector/mail/handoff **cards** inline (or docked above the composer when their call is not drawn), and after answering they stay folded to one line with the result.
- **Repair card** on failure (per code; Technical details: code, HTTP status, request id, provider message, copyable).
- Composer: "Message {name}" placeholder; `@` menu lists other Bots first; **+** menu: Add files, Reference a chat, Scheduled task, Set a goal (groups); voice; Enter-sends preference; queue dock shows only the user's own queued sends (Bot deliveries never appear as if typed).

### 4.5 A group chat
- Header island: group avatar + name; with a goal it shows the goal's short title and "stage i/n"; a pod hangs below (state dot, bar label, segments per stage, faces of the current stage with pulse/check/dim), expanding into the stage panel.
- Transcript rows: user bubbles (right, time, "via WeChat" tag when from IM); member messages with a 22 px avatar beside the **last** bubble of a run, name in the Bot's colour, Admin star, time, "Ran for …"; consecutive messages from one Bot stack under one name; event rows: "{name} started on it", "{name} paused for your approval", "{name} finished its work", "{name} looked up its own chat (for "…")", restart lines, "The user stopped X's work here", folder notice, goal events, "did not answer or call anyone", idle pause, failure rows with the reason; pending speakers "Name · phrase…" / "Name is typing…".
- Above the composer: the **work capsule** (members at work, approvals first; opens details). Composer `@` menu: members + "Everyone".

### 4.6 Details drawer
- **Bot**: top row of round buttons — gear (Edit Bot), share (copy conversation as Markdown, "Copied" state), close (Esc). Identity: 64 px live avatar (gaze follows pointer, poke to spin; no badges at this size), name (click to rename inline; Enter saves, Escape cancels), role. Tabs **Details · Browser · Computer** (Computer only if enabled) with a gliding thumb. Details: run stats line; **Model** (model menu with a stepped thinking-level slider; "Pick a model and {name} can start"); Sessions (local agents); **Permissions** picker; **Connectors** switches; **Working folder** menu; **About** = instructions folded to 5 lines/240 chars with Show more (or "Add instructions in Bot settings"); **Memory** row ("n entries", Manage); **Usage** line; **Scheduled tasks** summary. The settings view slides in from the right inside the same drawer (back chevron).
- **Group**: member pile (≤4 overlapping discs, +N); name (empty ⇒ named after members); subtitle (mode/member count); **Notice** (folded) or "Add a notice in group settings"; **Members · n** with **Stop all** beside the title while anything runs; one row per member: 32 px mark with state, name, Admin tag, a second line with what it is doing *here* (or its role), Stop while it works here, and its pending approvals with Allow once / Reject; **Goal** (title + bar label + Show, or Set a goal — disabled without an admin); **Who answers**; **Permissions** (if group preset); **Memory** row; **Usage**.

### 4.7 Settings dialog (one size for every page: min(1100, 100vw−48) × min(780, …); 198 px left nav; radius 16; Esc/scrim/× close)
- **General**: theme (DeepSeek, Mono, Paper, Moonlight; light/dark), accent (7 presets or custom), message layout (Bubble/Flat), bubble width, text width, Show thinking, Bot animation (Quiet/Normal/Lively), Enter sends message, New Bots → Default model, Bring up related memory (auto-recall), memory sizes (group/Bot/team), Mode (Classic Agent), Locations (team workspace, data location).
- **Models** (providers fold, search), **Local agents**, **Bots** ("Bots · n"; Main Bot hand-over: "first in the sidebar; pick another Bot to hand it the role", "Add a Main Bot", Move to first; each Bot's settings; "Closed after deletion · n" with two-click Remove protection), **Group chats** ("Group chats · n", "No group chats yet. A group chat lets several Bots work on one thing with you.", group settings form: name, notice, Who answers segmented, members with Make admin/Remove/Add member/Leave without admin, permissions Same for every member, sidebar Pin/Hide, Delete group two-click "Its history is archived"), **Connectors**, **Capabilities**, **Browser**, **Computer use**, **IM**, **Scheduled tasks**, **Usage**, **Secrets**, **Feedback** (versions, system, models, recent errors; Report on GitHub/Copy/Download/Clear), **About**.

### 4.8 Memory dialog (min(680, 100vw−48) × min(760, …), radius 20)
- Summary view ("Writing the summary…", "Updated {time}", "The summary is out of date: …", "could not be written: …"); empty: "{name} has not saved anything yet" + what Bots keep; group variant. Header ⋯: All entries, Change history, Regenerate summary. Bottom: **Ask or update** box with Send; results as "Added/Updated/Removed/Not changed".

### 4.9 Usage page — §3.16. Empty: "No usage yet. Token usage shows up here after a model is called."; "Nothing in this range."; "Still reading older chats; totals may grow."

### 4.10 Motion and characters
- 20 original 3D-traced characters (whale, star, moon, wave, squircle, zed, hex, gumdrop, peanut, saucer, bunny, kitty, beacon, plus, magnet, acorn, pebbles, cushion, ring, gem) × 12 colours + aurora; eyes cut through all layers; or a photo (circle). States: idle, thinking (tilt bob 2.2 s, squint), searching (peek 1 s, eyes scan), working (bob 1.6 s), sending (lunge 1.1 s), waiting (sway, eyes circling), alert (two hops, "?"), done (squash 1.8 s). Levels: Quiet (states only), Normal (+hover rub, click spin, gaze), Lively (+idle blinks/fidgets per Bot, 9 s cycle, continuous hop while waiting). Badges: 12 px circle (8 px working), green working dot, accent "?"; Main Bot large solid star (36% of avatar, 14–22 px); admin small star in a disc. Transcript marks stay still.
- Springs only for shape (SHAPE 420 ms/2%, TAP 290 ms, LIST 190 ms, STRETCH 560 ms/12%, POP 430 ms/17%); colours/opacity .12/.16/.22 s; every surface has an exit animation; `prefers-reduced-motion` stops avatar motion and jumps sliders.

### 4.11 Copy and i18n
- English source strings, Chinese in one table; sentence case; buttons start with a verb; no dev/process talk in UI; settings rows carry no description by default; error copy says what happened and what to do, next to where it happened.

---

## 5. Gap table: DS Bot → Synapsez

Status: **Same** · **Diff** (exists, works differently) · **Missing**. "Deliberate" = said so in NOTICE, `server/bots/rounds.js` L8–34, `server/bots/memory.js` L6–22, `server/bots/team.js` L40–48, or an owner-dated comment.

### 5.1 Team, Chief, bots
| # | DS Bot | Synapsez (file:line) | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 1 | Main Bot made on first open | `ensureChief` team.js:155; GET /bots routes/bots.js:45 | Same | — | keep |
| 2 | Several Main Bots, hand-over, Main star | single `is_main`, star in tile bots.js:172 | Diff | implicit ("the main bot, Chief") | keep single Chief unless asked; cheap win: none |
| 3 | First Main Bot starts with no model → setup card | Chief uses top-bar model agent.js:1571–1575 | Diff | yes (owner 2026-11-10: top-bar model) | keep |
| 4 | Guided first-run (goal card → suggested Bots, ≤3 model calls, no-model fallbacks) | empty-state text `bots.emptyChief` en.js:97 | Missing | no | **add** (P2): a no-model "what do you want help with" card in Chief's empty chat with preset Bot suggestions; create on click |
| 5 | Kickoff greeting by each new Bot (model call) | none; `bots.empty` "Say hello to {name}" | Diff | cost (implicit) | keep no-call; optionally show a fixed, non-model intro line built from role+instructions |
| 6 | `create_bot` brief → first context | params name/role/instructions/creature tools.js:30–42 | Missing | no | add optional `brief`, stored as the first memory entry (source "by Chief"), no model call |
| 7 | Name ≤40; reserved all/everyone/user/you; held during create | `nameProblem` bot-mentions.js:40; NAME_MAX 32→40; RESERVED adds `me`, `<>`, tab | Same+ | — | keep (Synapsez stricter) |
| 8 | Role label ≤24 | role ≤40 team.js:31 | Diff | — | fine |
| 9 | Instructions unbounded | ≤4,000 team.js:32 | Diff | — | keep (cost guard) |
| 10 | Avatar: 20 chars × 12 colours, photo, library | creatures + automatic hue team.js:99–146 | Diff | yes (NOTICE: own creatures, not DS Bot art) | add a **colour (hue) picker** in the form (hue column exists, schema 43) |
| 11 | Settings form saves on blur/Enter, Esc reverts | explicit Save button bots-settings.js:179 | Diff | — | optional; keep Save (clear on mobile) |
| 12 | Inline rename in details | none | Missing | — | P3 add |
| 13 | Profile-change notice into the Bot's chat | none (prompt re-read per turn) | Diff | — | P3: optional; prompt already fresh each turn |
| 14 | Duplicate Bot | none | Missing | — | P3 |
| 15 | Delete: user only, two-click, archives, admin → none | DELETE routes/bots.js:97; two-press 3 s bots-settings.js:270; admin → first member team.js:323 | Same/Diff | — | keep; Synapsez admin hand-over is friendlier |
| 16 | Delete tells waiting Bots, archives memory | memory rows deleted with bot (FK), notices in groups team.js:313 | Diff | memory.js says no archive | keep |
| 17 | Sidebar pin / hide / mark unread / sections / search / context menu | none (list sorted by activity) bots.js:166–194 | Missing | — | P2: unread dot + running/approval marks first; pin; right-click/long-press menu (Open, Settings, Pin, Delete) |
| 18 | Private Bots | none | Missing | — | P3 (web app: other bots only read via tools Synapsez lacks; revisit if `recall` across bots is added) |
| 19 | Per-Bot model + thinking level | top-bar model for all | Diff | **yes** (owner 2026-11-10) | keep |
| 20 | Permission presets, working folders, local agents, computer use, IM | none | Missing | N/A for hosted web | keep out |
| 21 | Per-Bot connector switches | account connectors for every bot | Missing | — | P3: per-bot "connectors off" list (withhold tools by prefix, like DS Bot) |
| 22 | Per-Bot browser profile | none | Missing | **yes** (NOTICE: "no per-bot browser") | keep |
| 23 | Account limits | none | bots 24 / groups 20 / members 12 team.js:27–38 | Diff | yes (loop stop) | keep |

### 5.2 Prompt and tools
| # | DS Bot | Synapsez | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 24 | Identity + instructions + Main rules + team rules, byte-stable | `botPersona` prompt.js:55; TEAM_RULES :22, MAIN_RULES :30 | Same shape | — | keep |
| 25 | **Memory frozen per part; changes as appended "update" messages** | memory re-read every turn into the system prompt prompt.js:62–89, agent.js:1575 | **Diff** | no — prompt.js:19–20 claims "kept stable", but memory changes it | **P1**: freeze the memory section per chat (store snapshot on first turn) and append later changes as a short message; same for group memory (as a message, not system text) |
| 26 | Group memory as a snapshot *message*, so group Sessions share the Bot's prefix | group section + member list in system prompt prompt.js:70–83, :88 | Diff | no | P2 with #25: move group block into the round message |
| 27 | Status in `list_bots` (working where, for whom, tool; waiting; unread) | list_bots: name/main/role/creature + groups tools.js:149–157 | Missing | — | **P1** cheap: add "busy in its own chat / in group G" from `run_lock_at` (already read in routes/bots.js:38) |
| 28 | `message_bot` private delegation + work tree + request_id + merge unread | none | Missing | not stated | P2 (large): see §6 — a bounded synchronous variant fits serverless |
| 29 | `post_to_group` (+report_back) from Chief's own chat | none: Chief makes a group but cannot start it | Missing | — | **P1/P2**: let Chief post a first message into a group and run that round (same ceiling) |
| 30 | `stop_bot` | none | Missing | — | P3 |
| 31 | `delete_group` by Main on request | user only ("Only the user deletes a bot or a group" prompt.js:36) | Diff | yes | keep |
| 32 | `read_group_chat` / `read_own_chat` (all parts, anchors) | none; `search_chats` excludes bot chats (pg.js:1025 etc.) | Missing | — | P2: let a bot search its own chat and (Chief) read a group's log |
| 33 | `recall` (search all, other public Bot's memory) | none; memory only in prompt (4,000 chars) | Missing | — | P2 with #25: `recall` over the bot's entries beyond what fits |
| 34 | `ask_user` / `show_view` in own chat, refused in groups | `ask_options` withheld for every bot agent.js:1708–1709 ("draws no question cards yet") | Diff | stated as temporary | **P1**: bot chats now render in the home transcript (app.js:3160) — verify cards draw there and lift the withhold for own chats; keep it for group turns |
| 35 | `request_secret` secure card | home chat has its own key/secret flows (not checked) | ? | — | verify parity in home chat |
| 36 | Hidden subagent/delegation tools in Bot Sessions | home agent tools offered as usual | Diff | — | consider withholding "run a sub-agent" tools for group turns (unwatchable, unstoppable cost) |
| 37 | Rights from the Session's owner | `runBotTool` reads chat→bot from store tools.js:135–143 | Same | — | keep |
| 38 | Refusals tell the model what to do instead | refusal texts tools.js:143, :165 | Same | — | keep |

### 5.3 Group chat
| # | DS Bot | Synapsez | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 39 | Min 2 Bots | min 1 team.js:246 | Diff | — | fine (a 1-bot "group" is a project room) |
| 40 | Auto name from members | name required team.js:240 | Diff | — | P3 |
| 41 | **Group notice ≤2,000** (members read it each turn) | none | **Missing** | — | **P1**: add `notice` to groups (form + `create_group`/`update_group`), put it in the round message (rounds.js:60) not the system prompt |
| 42 | Modes admin / everyone-in-turn | admin only | Diff | **yes** rounds.js:32–34 | keep |
| 43 | `@all` from the user or admin calls everyone | `all/everyone` reserved, but not a call bot-mentions.js:29 | Missing | not stated | P2: `@all` from the **user** calls every member (counts under the ceiling? user calls don't) — or keep off for cost and say so in the picker |
| 44 | Mention rule: skip code, **Markdown links**, `.word`/`\` run-ons, chat-reference labels | skips code only (QUOTED :26, RUNS_ON :22); page also skips `<a>` (bots.js:207) | Diff | NOTICE says "one shared reading" | **P1 bug**: server and page disagree for `[x](…@Writer…)` / `@Docs.md`; add link spans and `.`+word/`\` run-ons to the shared rule |
| 45 | Plain message → admin; named → those, parallel | `named` else admin rounds.js:118–120 | Same | — | keep |
| 46 | Calls take effect mid-turn as each line posts | callees start after the whole batch ends rounds.js:220–243 | Diff | implied (one streamed request) | P3 (latency only) |
| 47 | Batch barrier: caller woken once when all callees done | `back` map per asker rounds.js:237–242 | Same | — | keep |
| 48 | Only wake caller if callees worked & didn't @-answer | wakes whenever callee posted | Diff | — | fine (ceiling bounds it) |
| 49 | **User messages during a round join it** | 409 "already answering" routes/bots.js:288 | **Missing** | not stated | **P1**: accept the post, store it in the log, and have the running round pick up new user lines between batches (they call admin/named; not counted) |
| 50 | One call at a time per member | dedupe by botId per batch rounds.js:225–229 | Same | — | keep |
| 51 | Member sees: list, notice, goal, admin note, earlier ≤8, round lines (12 first / 24 later), still-at-work, place, rules | `[Group chat]`, new lines ≤24 × 4,000, why, together, rules rounds.js:60–77; members+admin in system prompt | Diff | — | P2: add "still at work" and the notice; consider an "earlier (context only)" split for first looks |
| 52 | New member Session gets a 10-line private brief of own chat | **never** reads the private chat (rounds.js:17–18; test bots.test.mjs:322) | Diff | **yes** | **keep** (stricter privacy) |
| 53 | Strip echoed "Name:" incl. bold/full-width colon | ascii colon, optional "(admin)" rounds.js:192 | Diff | — | P3: also strip `**Name**:` |
| 54 | `[PASS]` variants (【pass】, (pass), empty) | `^\[?PASS\]?\.?$` rounds.js:44 | Diff | — | P3: accept `(PASS)`/`**PASS**` |
| 55 | **"Admin passed alone" notice** | silent: PASS → nothing rounds.js:190 | **Missing** | — | **P1** cheap: when the admin was the only speaker and passed, post a notice "nobody answered; call a member with @Name" |
| 56 | Work grace 15 s + late replies | waits inside the round; no late replies | Diff | **yes** rounds.js:32–34 | keep |
| 57 | Silence timeout 4 min ("missed") | round budget 285 s, turn floor 40 s, "out of time" notice rounds.js:40–42 | Diff | yes | keep |
| 58 | Approval in group → Allow once/Reject in details, notification | member stops, notice, moves on rounds.js:178–180 | Diff | **yes** | keep; P3: add a "Open {bot}'s chat" link in the notice |
| 59 | Failure row with code + log line for later speakers | 'failed' notice, redacted ≤200 rounds.js:186–188 | Same | — | keep |
| 60 | Promise-only auto-continue once | prompt asks "never a promise" only | Missing | — | P2: if a called member's reply has no tool call and reads as a promise, run it once more (counts toward the ceiling) |
| 61 | Idle guard (6 tool-less ack turns → pause till user) | hard ceiling 6 hand-offs/message team.js:48 | Diff | **yes** | keep ceiling (Synapsez better for billing) |
| 62 | Stop all + per-member stop | one Stop for the group routes/bots.js:257, button in details bots.js:399 | Diff | — | P2: per-member stop needs per-member abort signals; low priority |
| 63 | Work capsule above composer | `botchat__working` rows bots.js:344–354 | Same-ish | — | P2: friendly phrases from tool names (reuse render.js step labels) instead of raw `using {tool}` |
| 64 | Event rows: started/paused/finished/looked up/restart | notices: made/joined/left/renamed/admin/deleted/botRenamed/approval/failed/ceiling/time/stopped team.js:370, rounds.js | Diff | — | keep; add "admin passed" (#55) |
| 65 | Consecutive messages from one Bot stack under one name | each line a full row bots.js:281–294 | Missing | — | P3 |
| 66 | Member row: 22 px face by last bubble, name in colour, admin star, time, "ran for" | 28 px face, name, Admin tag, 30-min stamps bots.js:281–309 | Diff | — | P3: per-message time on hover, run duration |
| 67 | Group greeting when made without a message | none (empty-state text) | Diff | cost | keep |
| 68 | Group scheduled tasks | per-bot only routes/bots.js:115 | Missing | — | P2: allow a task on a group (runs a round with the prompt as the user's line) |
| 69 | Group goal | none | Missing | — | P3 (large); revisit after #41/#49 |
| 70 | Group log kept forever + searchable | all messages in DB | Same | — | keep |

### 5.4 Memory
| # | DS Bot | Synapsez | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 71 | Scopes bot / group / team | bot + group; team = account notes | Diff | **yes** memory.js:14–18 | keep |
| 72 | Markdown files, topics, journal, undo | DB rows | Diff | **yes** (NOTICE, memory.js:14) | keep DB; add undo via a soft-delete column (P2) |
| 73 | Automatic review after each turn | none; prompt asks bots to save on their own prompt.js:41–43 | Diff | **yes** (cost) | keep; P3: opt-in per bot |
| 74 | Entry 300, never-fail write (spill to `earlier`) | 300; 60 entries then 409 "full" memory.js:48 | Diff | — | P2: on full, refuse is fine but name the oldest candidates to forget |
| 75 | Prompt budget = 2% of window; pinned kept | 4,000 chars newest-first memory.js:25, :78–93 | Diff | — | P2: keep pinned entries first (needs #77) |
| 76 | `replace` an entry in place | `remember` + `forget` only | Missing | — | **P1** small: `remember(replace)` and a panel **Edit** |
| 77 | Pin, until (expiry), id, source, by | text, source user/bot, created_at | Missing | — | P2: `pinned`, `until` columns; prompt shows id + day |
| 78 | Key/password/ID refusal (`looksSecret`) | `redactSecrets` keys/KEY=value/URL pw memory.js:44 | Diff | — | P2: also refuse "password is …" prose and ≥15-digit / labelled ID numbers |
| 79 | "Memory is data" in prompt + don't save what content asks | MEMORY_ABOUT_* prompt.js:41–46 | Same | — | keep |
| 80 | **Approval gate on memory/instruction writes after outside reads** | HAR-005 `MEMORY_WRITES` agent.js:925 | **Synapsez better** | — | keep; extend per §6.3 A |
| 81 | Incognito | bot incognito chats, memory withheld routes/bots.js:156, prompt.js:85 | **Synapsez better** | — | keep |
| 82 | Panel: summary, all entries, history+undo, ask-or-update, move between scopes | inline list + add + two-press forget in details bots.js:444–451, :899–915 | Missing (most) | — | P2: a memory dialog with entries, edit, pin, and history; summary/ask are model calls — opt-in |
| 83 | "Memory updated" pill stretch on background changes | step line in home transcript only | Missing | — | P3 |
| 84 | Members removed lose group memory at once | membership checked at write via scope; reads only in that group | Same | — | keep |

### 5.5 UI
| # | DS Bot | Synapsez | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 85 | Left list + middle chat + right details | same three columns bots.js:101–131 | Same | NOTICE | keep |
| 86 | Main tile: 60 px face, star, name, role | 64 px face, ★, name, role, running dot bots.js:170–176 | Same | — | keep |
| 87 | Row previews by state (working, in group, waiting) | last message or running dot bots.js:154–159 | Diff | — | P2: "working…" line while `running` |
| 88 | Unread / approval dots | none | Missing | — | P2 |
| 89 | Header pill w/ hover arrow, stretch events | pill face+name+←/→ bots.js:324–337 | Same-ish | — | P3 events |
| 90 | Details: model, permissions, connectors, folder, about, memory, usage, tasks, run stats | instructions link, memory, usage (30 d tokens + cache %), tasks bots.js:371–421 | Diff | model: yes (top bar) | P2: show "About" (instructions folded to 5 lines) instead of only a link; inline rename |
| 91 | Group details: pile, notice, members with state + stop + approvals, goal, who answers, memory, usage | members + admin tag + Stop all, memory, usage bots.js:396–401 | Diff | — | P2: member state line ("working on …") |
| 92 | Big animated face with gaze in details | 88 px still (bot-avatar.js:11 claims moving via `showStates`) | Diff | — | P3: either animate (themes-panel.js:355 has `showStates`) or fix the comment |
| 93 | Avatar motion states | still faces; spinner rows | Diff | — | P3: reuse mascot states for "working/thinking" |
| 94 | Settings: one fixed-size dialog, nav, pages | dialog with Bots, Groups, Usage + links bots-settings.js:26–33 | Same | NOTICE | keep |
| 95 | Usage: ranges, compare, stacked by bot/model, rankings, "what for", heatmap, per-bot/model pages, calendar | ranges + custom, tiles, stacked, legend, two lists bots-usage.js:18–239 | Diff | — | P2: add "vs the span before" on the big tile, per-bot drill-down; P3 heatmap |
| 96 | Composer `@` menu in groups (+ "Everyone"), in own chat lists other Bots | group only, members bots.js:695–723 | Diff | — | keep |
| 97 | Coloured @Name while typing | overlay layer under the textarea bots.js:740–791 | **Synapsez better** (DS Bot's known issue shows file chips) | — | keep |
| 98 | "+ → Reference a chat" | none | Missing | — | P3 |
| 99 | Side chat `/side` | none | Missing | — | P3 (cheap-ish: one tool-less call on a snapshot) |
| 100 | Repair card per failure code | home chat errors (not checked) | ? | — | verify |
| 101 | Steering / "Not read yet" | home chat behaviour (not checked) | ? | — | inherits home chat |
| 102 | System notification for approvals | none on Bot page | Missing | — | P3 (only if permission already granted) |
| 103 | Phone: list ↔ chat, details cover chat | `is-chatting` toggling, details overlay ≤1100 px app.css:12474–12490 | Same | — | keep |
| 104 | Reduced motion | app-wide | ? | — | verify bot list/working rows respect it |
| 105 | a11y: focus rings, menu arrow keys (DS Bot admits gaps) | `role=log aria-live`, listbox picker with `aria-activedescendant`, Escape closes menu bots.js:124, :128, :987 | Synapsez ≥ | — | keep; add arrow keys to the "+" menu |

### 5.6 Scheduling, usage, security
| # | DS Bot | Synapsez | Status | Deliberate? | Recommendation |
|---|---|---|---|---|---|
| 106 | Tasks per Bot and per group; once/daily/weekly/every N min | per bot; free-text "when" via `parseSchedule` routes/bots.js:115–146 | Diff | per-bot only (owner 2026-11-10) | P2 group tasks (#68) |
| 107 | Bot creates its own tasks from chat (fenced to its own chat) | "made here or by the bot in its chat" routes/bots.js:110–113 | Same | — | keep |
| 108 | Tokens only, no cost | usage_events has cost_usd (pg.js:705) | Synapsez ≥ | — | P3: show cost too, since it is billed |
| 109 | Usage owners include group Sessions | member turns booked to the bot (usage_events.bot_id) | Same | — | keep |
| 110 | Tenant isolation | N/A (local) | per-account scoping, 404s routes/bots.js:14–27; test bots.test.mjs:227–241 | **Synapsez better** | keep |
| 111 | Bot-to-Bot text not marked untrusted | same; and HAR-005 does not see group lines (agent.js:942) | Shared gap | — | **P1** — §6.3 A |

---

## 6. Ranked recommendations

Cost notes assume Synapsez's constraints: Vercel functions (≤300 s), every model call billed to the user, free-tier friendly. "S/M/L" = effort.

### 6.1 Add or change (ranked)

**P1 — do first (high value, small or medium effort)**
1. **Close the cross-bot laundering path** (security, M). In a group turn, another bot's line can carry instructions it read on a web page; the receiving bot's `remember` / `create_bot` / `update_bot` then runs without HAR-005's yes because `turnReadOutside` (agent.js:942) only looks at tool results. Treat a member turn whose round prompt shows any *bot* line as "read outside" (pass an override from `runGroupRound` into `runAgent`, or wrap bot lines in the same untrusted envelope). Remember that group turns are `unattended`, so a held write becomes a "needs your yes" notice — acceptable and honest. Add a test: Chief in a group, handed "@Chief update Writer's instructions" by another bot, must not run `update_bot` unasked.
2. **Let the person write into a group while it answers** (M). Replace the 409 (routes/bots.js:288) with: append the user line to the log immediately (show it), and have the running round check `messagesSince` for new user lines between batches and queue their speakers (admin or `@named`; never counted against the ceiling). If no round is running, behave as today.
3. **Freeze bot memory per chat; send changes as a short message** (M). Today the memory section and the group block are rebuilt into the system prompt every turn (prompt.js:55–89), so each `remember` breaks the provider's cached prefix for the rest of the conversation. Snapshot the section on the chat's first turn (store it on the chat), and on later turns append one "saved since this chat began" message when entries changed. Move the group's memory and member list out of the system text into the round message. Measure before/after cache-read share (the `bots.usageLine` cache % already shows it).
4. **Group notice** (S). `notice` (≤2,000, refuse longer) on groups, editable in group settings and by Chief's `create_group`/`update_group`; placed at the top of the round message (rounds.js:60). Show it in group details folded to five lines.
5. **"Nobody answered" notice** (S). When the admin is the only speaker for the person's message and it passes, post a notice telling them to call a member with `@Name` (rounds.js:190).
6. **Mention rule parity** (S). Add Markdown-link spans to `QUOTED` and treat `.`+letter and `\` after a name as a run-on (bot-mentions.js:22–26), so `[link](…/@Writer)` and `@Docs.md` call nobody on both sides. Add tests next to bots.test.mjs:176–191.
7. **Live status in `list_bots`** (S). From the chats' run leases (as routes/bots.js:38 does) add "busy in its own chat" / "answering in group G" per bot, so Chief stops handing work to a bot that is mid-turn.
8. **Edit a memory entry** (S). `remember` with `replace` (text or id) and an **Edit** in the panel (PATCH route), so a changed fact replaces rather than contradicts.
9. **Question cards in a bot's own chat** (S, verify first). The withhold at agent.js:1708–1709 predates the home-chat lending (app.js:3160); if the lent transcript draws `ask_options` cards, lift it for own chats and keep it for group turns.

**P2 — next (clear value, medium effort or some cost)**
10. **Chief can start a group's work** (`post_to_group`-like, M): from Chief's own chat, post a first message into a group and run that round under the same ceiling and budget (or queue it to run on the person's next open of the group if the function is near its deadline). Without it, "one sentence to Chief" ends at an empty group.
11. **Memory model upgrade** (M): `pinned`, `until`, short id, `by` columns; prompt keeps pinned first and shows id + day; a memory dialog with all entries, edit, pin, remove and a change list with undo (soft delete). Summary / "ask or update" only as opt-in model calls.
12. **Own-chat search and group reading for bots** (M): allow `search_chats` over the bot's own chat, and give Chief a read-only "latest lines of group G" tool; this is DS Bot's `read_own_chat` / `read_group_chat` without the private-brief leak.
13. **Sidebar states** (S/M): unread dot, "working…" preview while running, waiting-for-your-yes mark; then pin and a row menu (Open, Settings, Pin, Delete).
14. **Friendly working phrases** (S): map tool names to the same labels the home transcript uses (render.js step labels) in `renderWorking` (bots.js:344).
15. **Usage page** (M): "vs the same span before" on the total tile, per-bot drill-down (tokens by kind, models used), and cost alongside tokens since Synapsez is billed.
16. **Group scheduled tasks** (M): a task that posts its prompt as the person's line in a group and runs a round.
17. **Promise-only retry** (S): a called member whose reply has no tool call and reads as "on it / will do" gets one more run in the same round (counted as a hand-off).
18. **First-run for Chief without model calls** (M): a card with 4 goal toggles and preset bot suggestions (editable names/roles), creating bots on click.
19. **Private delegation `message_bot`** (L): if wanted, a **bounded** version fits serverless: the caller's tool call runs the callee's turn inline (in the callee's own chat, as hidden "from Chief" turns), returns its final text as the tool result, counts toward a per-turn ceiling, and is refused when the callee is busy. No work tree or late replies.

**P3 — later / only if asked**
20. Inline rename, duplicate, colour picker, stacked consecutive messages, per-message time and run duration, "Memory updated" pill stretch, animated details face (or fix bot-avatar.js:11), side chat, reference a chat, approval notifications, per-member stop, `@all` from the person, group goal, sections, opt-in memory review, per-bot connector switches, private bots.

### 6.2 Where Synapsez is already better — do not regress
- **Tenant scoping**: every store call scoped to the account, other accounts' ids 404 (routes/bots.js:14–27; tests bots.test.mjs:227–241). DS Bot is single-user.
- **Approval gate on durable writes** after outside reads (HAR-005, agent.js:922–925) for `remember`, `create_bot`, `update_bot`. DS Bot only has prompt rules.
- **Hard cost ceiling** (6 hand-offs per message, team.js:40–48) and a round deadline with an honest "out of time" notice (rounds.js:196–201). DS Bot relies on the user watching.
- **Private chat never enters a group** (rounds.js:17–18; test bots.test.mjs:322). DS Bot seeds every new group Session with 10 private lines.
- **Incognito bot chats** (routes/bots.js:156; prompt.js:85; memory tools withheld agent.js:1714).
- **No model calls the person did not cause**: no greeting per bot, no group greeting, no per-turn memory review, no steward call (memory.js:14–18).
- **Bot chat = the home chat** (app.js:3160–3256): themes, modes, files, live thinking, model chip, incognito all hold.
- **One model for the team** (owner 2026-11-10), so there is no per-bot model drift or blocked-bot state to manage.
- **Typing overlay** that colours `@Name` as you type (bots.js:740–791); DS Bot's own known issue shows pending mentions as file chips.
- **Group stop across instances** via the run lease (routes/bots.js:252–268).
- **Honest group approval handling**: a member that needs a yes says so and the group moves on, instead of hidden waits.
- **Accessibility basics** on the page (log `aria-live`, listbox picker with `aria-activedescendant`, Escape handling) and full **vi + en** (142 `bots.*` keys each).
- **Automatic distinct faces** (hue per creature, team.js:106–146).

### 6.3 Findings outside the brief (with severity)
- **A — Medium (security): cross-bot instruction laundering in groups.** See P1-1. Found by reading `turnReadOutside` (agent.js:942–946) and `memberTurn` (rounds.js:127–193); not reproduced by running code.
- **B — Low (correctness): mention rule mismatch between server and page.** Server `mentionedBots` reads `@Name` inside Markdown links and before `.ext`; the page's `markMentions` skips `<a>` (bots.js:207), so a bot can be called without its name being coloured. Breaks NOTICE's "one shared reading". See P1-6.
- **C — Low (cost): memory in the system prompt changes per turn**, contradicting prompt.js:19–20 ("kept stable"). See P1-3.
- **D — Low (code health): dead code.** `soloHtml` and `eventLine` (bots.js:232–261) are only reachable from `renderLog` for a bot chat, which no longer renders there since bot chats moved into the home transcript (bots.js:518–543). CLAUDE.md §5 asks for no dead code.
- **E — Low (docs): stale comment.** bot-avatar.js:11 says the details panel draws its big face moving with `showStates`; bots.js:382 draws a still 88 px face.
- **F — Info:** the `ask_options` withhold comment (agent.js:1708) may be stale since the home-chat lending; worth checking (P1-9).

---

*Method note:* DS Bot behaviour was read from source and decided-design docs, not by running it; Synapsez line numbers are from the working tree on 2026-11-10. What a real model does with either app's prompts is not tested here.
