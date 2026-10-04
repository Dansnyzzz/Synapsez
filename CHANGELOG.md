# Changelog

## 2026-10-04 (evening) — pictures and videos in replies; a cloud browser that starts; workflows that finish

### Added

- **Photos in replies, like a search answer.** `web_fetch` lists a page's own pictures (its share image, then the
  large images in the body) as addresses this server signed; written as `![caption](address)` on their own lines
  they show as a row of tiles. Only signed addresses are fetched — any other image address in a reply stays a
  link, so a reply cannot carry the conversation off inside an image URL (`imageSignature` in imageProxy.js).
- **YouTube cards.** A YouTube link alone on its line becomes a card — thumbnail, title, YouTube — that plays in
  place from youtube-nocookie.com (`frame-src` allows only that). A list of them is a row.
- **Whether jobs run with the web closed** is said on the Scheduled and Workflows shelves: green with the last
  cloud heartbeat, or amber with the three steps to set up a free pinger (cron-job.org → `/api/cron/run-tasks?background=1`
  every 5 minutes with the `CRON_SECRET`). New route `GET /api/heartbeat`.

### Fixed

- **The cloud browser never started.** Its start script stopped the old service with `pkill -f 'node service.mjs'`,
  which matched the shell running the script and killed it before `exec`: an empty service.log and "did not come
  up in time" every time. Now stopped by pid. Chromium is also told it is on an AL2023-compatible host so it
  unpacks its shared libraries, and fonts try dnf, microdnf and yum. A test runs the script under bash (in CI).
- **The screen panel showed a broken image and its alt text** before there was a picture; it now says the picture
  appears once a page is open.
- **A workflow step cut off by the 300 s limit waited for a person** even when it was only reading (a deep research
  step). It now resumes where it stopped, up to three times; it still stops for a person when a change-making call
  (an email, a post) was cut off before its result came back.
- The "Searched the web" card folds itself once every page in it has loaded.

## 2026-10-04 (later) — a progress panel that stays true

### Changed

- **Progress marks**: the step being worked on is a turning ring (still once the turn ends), steps to come are
  dashed rings, finished steps a ticked ring — in the side panel and in the checklist inside the message. The
  running step shows its detail underneath.
- **Each plan update says what it changed**: "Added task …", "Completed …", "Started …", "Reordered the plan",
  "Dropped task …" instead of "Updated the plan · 7 steps"; opened, it lists the steps it touched with their
  detail. `update_plan` steps take an optional `detail`, and the tool asks the model to add, reorder or drop
  steps when the work changes mid-way.

### Fixed

- **After a refresh the panel showed several steps running at once.** It was rebuilt from the call's raw
  arguments, where the live view used the server's normalised plan. Both now go through the same rules
  (`public/js/plan.js`).
- **The plan left behind** (0/7 after a finished answer). A progress gate in code (`server/progress.js`):
  every 5 tool calls without an update, the newest tool result carries a reminder of where the plan stands;
  a turn about to finish with steps of this turn's plan not done is sent back once to mark them, before the
  turn's `done` — never twice, so a step genuinely left undone cannot loop. Neither note is stored.

## 2026-10-04 — an Archive shelf; no more computer pairing; tools that read what models send

### Added

- **Archive** in the sidebar, where Workspace was. It lists every archived conversation (and, behind the
  filter, archived projects) with when it was put away; opening one reads it, **Restore** puts it back in
  the sidebar, Delete removes it for good. Route: `GET /api/chats/archived`. Archiving used to promise
  "out of the list, not deleted" with nowhere to find it again.
- `calculate` reads arithmetic as it is written: implicit multiplication (`(1.5)(1.1)`, `2(3+4)`, `2pi`),
  × ÷ − and `**`, a leading `=`, `15%`, remainders, `5!`, √, constants pi/e, and many more functions —
  exp, ln, log, pow, floor/ceil, var/stdevp, comb/perm, and Excel-order finance: fv, pv, pmt, npv, irr, effect.

### Fixed

- **A list sent wrapped is read, not refused** — any tool. Models that write calls as XML arrive as
  `{ "questions": { "item": [ … ] } }`; `show_card` refused a full quiz over it. Schema arrays now accept
  that wrapper, an index-keyed object, a list sent as JSON text, or one value for a list of one; free-form
  objects are unwrapped at any depth. Quiz answers are read as an index, a letter, or the option's text,
  options may be `{ text }` objects or keyed by letter, and a refusal names which question failed and why.
- **Sub-agents can read the project.** `run_parallel` ran with no conversation, so `search_docs` could not
  find the project shelf. Each sub-agent is now told the project, its instructions and sources, is handed the
  best-matching passages up front, and its own tool calls carry the conversation.
- `look_at` on a big PDF by URL: 90 s and 48 MB instead of 30 s and 12 MB, PDFs served as
  octet-stream are recognised, and a timeout or a 404 says what happened instead of "aborted".
- Any tool cut off by its own deadline now tells the model it was slow and to change approach, rather than a
  bare "aborted".

### Removed

- Connecting a computer from the interface: Settings → Computers, the pairing sheet, and the Workspace file
  browser (`devices.js`, `workspace.js` and 93 strings). The cloud computer and sandbox do this work. The
  server routes are untouched, so a machine already paired, and `npm run connect` from a terminal, still work.

## 2026-09-28 (night) — the web as one card of sites

### Changed

- **Searching and reading the web is one card**, like Claude's "Searched the web": `web_search`,
  `web_fetch`, `extract`, `http_request` and `read_feed` no longer draw a raw call-and-result card each.
  The header says what was done, with the query beside it, and folds; inside is one row per site, with
  its icon, its title cut to fit, and its domain. A row opens the exact address the assistant used, not the
  site's homepage, and shows whether it is loading, was read, or failed.
- The side panel's search results use the same row and no longer scroll sideways under a long title.
- Both are transparent with a rounded border instead of a grey fill.

### Privacy

- Site icons come from this app's own server (`/api/favicon/:host`, signed-in only), which fetches them
  through `safeFetch` and caches them, so neither a favicon service nor the sites themselves learn which
  pages a conversation touched. Only a bare public hostname is accepted; a site without an icon shows a
  globe.

## 2026-09-28 (last) — sent files look as they did waiting; edits keep them; files cost less

### Fixed

- **Files in a sent message are the tiles they were waiting as** — a picture, a PDF's first page, or
  the file's name and type — above the words, not squeezed inside the bubble, and after a reload too.
  Each opens the file.
- **Editing a message keeps its files** on screen; they were always kept on the message, and are sent
  again with the edited words.

### Performance and tokens

- A file's small picture is stored with it (schema 24, `attachments.thumb`) and served from
  `/api/attachments/:id/thumb`, so a tile no longer downloads the whole photo, and a PDF's first page is
  not rendered again on every reload.
- Attachments are read from the database once per turn instead of once per step.
- A file attached twice is sent to the model once.
- An Office document's text is bounded like a PDF's (120,000 characters), and the model is told when it
  was cut.
- PDFs, Office documents and text files count toward how full the window is, so the conversation is
  folded before a large document overflows it rather than after the provider refuses.

## 2026-09-28 (late) — schedules that say what people mean; one state; one close

### Added

- **Schedules can be anything a person means**, from the side panel or in words to the assistant:
  once on a date; every N minutes (5 at least); every hour or every N hours at a minute; every day at
  one or more times; weekdays; chosen days of the week (Mon + Fri…) at one or more times; every N
  days from a first day; chosen days of the month, including the last. An interval that divides the
  day stays on the clock (every 10 minutes is :00, :10, :20…); one that does not (7 minutes, 23 hours)
  is counted from its first run and cannot drift. The grammar lives in one module the server and the
  panel share (`public/js/schedule-grammar.js`); every old schedule reads exactly as before.

### Changed

- **One state in the side panel** — Active, Paused, or "Runs when you press it" for a manual task —
  centred beside the buttons, instead of an "Activity" label and a badge. A manual task has no pause.
- **Closing a task or tool panel puts the side area back as it was**, instead of revealing the plan
  underneath and needing a second close.
- The Scheduled list says how often in words ("Every 15 minutes") rather than the stored form
  ("every hourly :00"), and a manual task no longer claims "once · next".
- The Scheduled and Workflows pages keep titles and cards readable beside an open side panel instead
  of breaking them one word per line.

## 2026-09-28 (later) — files above the composer show themselves; draw on a picture before sending

### Added

- **Draw or write on a picture before it is sent.** Press a picture waiting above the composer:
  it opens large with a pen (Sketch) and Text, seven colours, Undo/Redo (also Ctrl+Z / Ctrl+Y)
  and Save, which sends the drawing in its place.

### Changed

- **Files waiting to be sent are tiles.** A picture is the picture, a PDF shows its first page,
  anything else is its name and its type (DOCX, XLSX, HTML…). No file sizes. Uploading and failures
  are still shown on the tile.
- **Editing a message:** Save and ask again stays disabled until the text changes; a long message
  scrolls inside the box with a thin draggable bar; double-clicking the resize corner puts the box
  back to its size.

## 2026-09-28 (night) — workflows work like scheduled tasks; a readable Delete; a glass question card

### Fixed

- **Delete showed a blank red pill** after the first press on Scheduled (and on files and notes):
  the global armed style painted the text the same red as the fill. It now reads on the fill.

### Changed

- **Workflows use the same buttons as scheduled tasks** — Pause, Remove and a pencil — and the
  pencil opens the side panel, where the steps are edited in place (one per line, saved when you
  click away) and Run now lives. The edit sheet is gone; the sheet now only creates workflows.
- **The question card is glass**, like the composer, instead of a grey slab.

## 2026-09-28 (late evening) — tasks edited in the side panel; Context is what was used

### Changed

- **A task's pencil opens the side panel**, the same editor a schedule card in a conversation
  opens, where every field is changed in place. The edit form is gone (the form now only creates
  tasks), and so is the pencil in the panel's header.
- **Context in the side panel lists only what the conversation used**: connectors and MCP servers
  whose tools it called, skills it read, and the project's sources once it has started. A new chat
  shows none. Editing a message refreshes the panel, so the tools of the removed replies leave it.

## 2026-09-28 (evening) — the new-model notice follows the list; feeds are found, not guessed

### Fixed

- **The "new model" notice is the top of the model list.** It announces exactly the newest model
  in your tier — free if you are on a free model, paid if you are on a paid one — in the list's own
  Newest order, the day it appears there (first visit included). Once shown or answered it is not
  shown again, and nothing is shown the next day unless something newer arrives. A model you are
  already on, or used this month, is never announced. Removed the rules the list did not share (a
  20-hour quiet period, "only models imported after your first visit", a list of notable labs),
  which hid models on their release day and announced one you were already using.
- **read_feed finds a site's real feed.** Models guess feed addresses (`vnexpress.net/rss/tin-moi.rss`;
  the real one is `tin-moi-nhat.rss`) and every guess failed. When an address is not a feed, the
  site's own feeds are found — on the page it led to, on `/rss`, or in the homepage's
  `<link rel="alternate">` — and the matching one (or a site's only one) is read straight away;
  otherwise the real addresses are listed so the next call is right. Passing just the site works.

## 2026-09-28 (audit) — privacy, fewer tokens per step, and runs that cannot tangle

### Security and privacy

- **A fetch that carries data out now asks first.** "Read my inbox, then open
  `https://…/?d=<the inbox>`" was all reads, so nothing asked. Any tool that sends a URL
  (`web_fetch`, `http_request`, `browser_open`, `read_feed`, `download_file`, …) is approved first
  when the address carries a payload, and the prompt says why.
- **Private addresses are refused however they are written.** `[::ffff:169.254.169.254]` reached
  the check as `::ffff:a9fe:a9fe` and passed as public; IPv6 is now judged by value, including
  NAT64, 6to4 and IPv4-compatible forms.
- **An API key stays with its site.** A redirect to another origin drops every credential-shaped
  header (not only `Authorization`), and a request body is never resent to another origin — the
  redirect is reported to the model instead. `http_request` and `read_feed` read at most a capped
  number of bytes.
- **Password-reset links no longer reach a deployment's logs** when no mail provider is set.
- **Google results are data, not instructions**, everywhere: Drive search, calendars, Sheets,
  Forms, Tasks and Contacts join Gmail in the untrusted envelope. Calendar and Contacts listings
  are clipped. Gmail ids are validated before they enter an API path.
- A failed Google sign-in carries its reason in a same-origin cookie, not the URL, so a link can
  no longer put someone else's words in the app's error message.
- The shared model library refuses to drop more than a quarter of a provider's models at once.

### Tokens

- The `load_tools` index lists tool families on one line (~300 tokens less on every step), and its
  descriptions no longer stop at "e.g.".
- **Claude and Gemini through OpenRouter are cached.** They only cache when asked; every step
  re-bought the tool list and system prompt at full price.

### Fixed

- **Scheduled tasks and workflows** are no longer told to ask a form nobody will answer, and a
  question stops them as an approval does. A task conversation left paused no longer breaks every
  later run (calls without results are answered "not run" for the model).
- **Run now** takes the task's lease — a double press or a second tab no longer starts two runs
  (409) — and a manual task stays on after it runs. Hourly repeats keep their minute in half-hour
  zones (India, Nepal).
- A question and an approval in the same step no longer ask each other forever; a paused question
  comes back when the conversation is reopened.
- Lines queued in a conversation are delivered when you come back to it, even if its run finished
  while you were elsewhere; a reply never starts in the conversation you switched to while sending.
- Send is no longer stuck disabled after a stop during compaction; a watched run from another tab
  is not drawn twice, and shows its text while that tab is in the background.
- Accessibility: the tool pane takes and returns focus and closes on Escape; picking in a question
  form keeps keyboard focus; the "new group" field is no longer inside a button.

## 2026-09-28 (later still) — project documents found, small edits to big files, a quieter transcript

### Fixed

- **search_docs in a project** searches the project's own sources (see be470b9) — it answered
  "nothing has been indexed" in a project holding the document. Project context is also sized to
  the model's window, filtered to real matches, and cached when it fits whole.
- **Fixing part of a big file** no longer means rewriting all of it. `update_file` takes `edits`,
  `[{find, replace}]` — each find exact and unique, all or nothing — so a header fix to a 40 KB quiz
  sends a few lines instead of 40 KB that a free model's reply was cut off partway through.
- **"Waiting for the model — it has to queue"** no longer shows while the model is plainly
  thinking or writing: the line is cleared the moment reasoning, text or a tool call arrives. The
  status line under the transcript is dropped for tools too — each card's own mark spins (brand
  purple) while it works, and that is the one sign.
- The **Scheduled list in the sidebar** is gone: a handful of tasks pushed the conversation history
  off the screen. Scheduled work lives on the Scheduled page.
- The project page lays itself out by the room it has, so opening the side panel no longer squeezes
  the work column to a sliver.

### Added

- **Tools used, as connectors.** The side panel's Context lists the tools this conversation used —
  Web search first — beside the connected services. Pressing one opens every call in the panel:
  one group per message that asked, each group folding, each result a link with its site.

## 2026-09-28 (night) — every interruption has a Continue; Outputs and Context in the side panel

### Added

- **Continue after any abrupt stop.** A provider error, every key refusing, a connection that
  would not come back, a stall — each now leaves a note with a solid ↻ Continue button, not only
  the tidy limits. Continue picks up from the last saved step, and the server tells the model what
  happened: carry on from where it stopped, use what the steps above already did, and do not send
  anything a second time (`CONTINUE_NOTE`, for that request only).
- **A stall is detected.** A provider that accepts a request and then goes silent is given up on
  after 150 s before its first word, or 90 s between words (`STREAM_STALL_FIRST_MS`,
  `STREAM_STALL_MS`), and graded as a provider hiccup: retried, then reported with Continue.
  Rotating to the next key on a dead or rate-limited one was already there.
- **Outputs and Context in the side panel**, under the plan. Outputs lists every file made in this
  conversation, newest first, opening in the viewer. Context lists what the assistant reads from —
  the project's files, connected services, skills, MCP servers — each group only when it has
  something, the section only when any group does. Both fold.
- **Save to Google Drive** in the viewer's ▾ menu once Drive is allowed (Word, Excel and PowerPoint
  become Docs, Sheets and Slides), and **Open in a new tab** for a PDF, picture or page when no
  computer is paired.

## 2026-09-28 (evening) — compacting you can see and trust; a provider hiccup retried

### Fixed

- **An error sent mid-stream by the provider** ("JSON error injected into SSE stream" from
  OpenRouter) carries no HTTP status, so it was graded fatal and ended the turn. It — and
  overloaded / terminated / premature-close errors — is now a provider hiccup and retried.
- **The context ring stayed full after compacting**, and the next turn compacted again, a few
  messages at a time (27, then 7, then 3): the measurement kept reading the last billed figure,
  which described the transcript before the fold. After a fold it now measures what is actually
  sent — the summary and the kept turns — so the ring drops the moment the fold lands, and
  auto-compaction counts the live transcript, not every message ever sent.
- The Projects page cards: the title was indented and the ⋮ showed as a dark square — rules for a
  project's source cards shared the `.card` class and leaked onto them. They are scoped now.

### Changed

- Compacting is a bar above the composer that fills while the summary is written, turns green
  at the end, then gives way to a "compacted — carry on" notice. Sending waits for it. The summary
  is no longer drawn in the transcript — it is the model's working memory, not part of the
  conversation. "Compact now" is disabled while compacting and until a quarter of the window is in
  use again (the server refuses below 25% too).
- The context ring is purple again while there is room (amber, then red, as it fills).
- The Projects page cards are glass and lift a little under the pointer.

## 2026-09-28 (later) — setup in two steps, outputs as a row of pages, a glass project page

### Changed

- Setting something up is two steps that bend to what is known: a form for preferences
  ("Continue setup"), then a form showing **a preview of what will exist** — title, when, what it
  covers, an amber "Not active yet" badge — with only what is still missing (usually the address)
  and "Confirm". Either step is skipped when its answers are already in the message. The same
  guidance now applies to an email or repeat typed in an ordinary conversation, not only from a
  shelf. `ask_options` takes a `preview`.
- A project's **Outputs** are one row of cards, newest on the left, scrolled sideways with an arrow
  only on a side that has more. Each card shows its file: an HTML page running (sandboxed, no
  network), a document's opening lines, a picture. Cards lift on hover and open in the viewer.
  Previews load as they scroll into view.
- The project page is glass: the starter, the side column, source cards, conversation rows.

## 2026-09-28 — setting something up by describing it actually sets it up; forms and a better picker

### Fixed

- "Describe it to the assistant" from the Scheduled or Workflows shelf — and any message that plainly
  asks for a repeat ("mỗi sáng gửi tôi…", "every Monday") or an email — now hands the model
  `schedule_task` / `workflow_write` / `send_email` before its first step. They were deferred behind
  `load_tools`, and a small model would rather chat about the digest than fetch the tool, so the
  setup never happened. The shelf notes now say to set it up in this turn, never as a draft only.

### Added

- `ask_options` can be a **form**: `style: "form"`, a `title`, a `submit_label` ("Continue setup"),
  and fields of `kind: "email"` or `"text"` alongside the choices — every question on one card with
  one solid button, required fields and email addresses checked before it sends. The answer is
  drawn back as the person's own bubble in the transcript, live and after a reload.
- The question picker reads like a modern one: numbered rows, a single choice answers and moves on,
  a last row with a pencil where you type your own answer and a send arrow appears, and ↑/↓, Enter
  and the number keys work.

## 2026-09-27 (late) — Google, and colours that mean what they mean everywhere

### Added

- **Google connector** (OAuth): Gmail, Calendar, Drive, Docs, Sheets, Forms, Tasks and Contacts.
  The deployment owner sets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` once
  ([docs/google.md](docs/google.md)); each account ticks products and signs in. Eight tools, one
  per product with an `action`, offered only for the products actually granted, deferred behind
  `load_tools`. Reads are ordinary, every write is sensitive and shown first. The sign-in state
  is signed, bound to the account and the browser, and expires in ten minutes; the token is only
  ever sent to `*.googleapis.com`; access tokens refresh themselves; disconnecting revokes the
  grant at Google. Email subjects cannot smuggle headers; email and document text comes back
  marked untrusted.
- **Google Search** in the web-search chain, through Gemini grounding on a Gemini key (deployment
  or the account's own), second after Exa. Silent when there is no key.

### Changed

- Semantic colours follow the conventions people already know, instead of the brand purple for
  everything: new `--ok` green for done ticks, "On"/"Đang bật" badges, connected, saved, switches,
  success toasts and healthy meters; blue for links, in-progress rows and checkboxes; amber only
  for warnings (tool names are no longer amber); red for errors. The brand purple stays for brand
  things — selection, focus, primary identity.
- The schedule card's tick is green and its pill is a solid white, bold, full-width button.

## 2026-09-27 (night) — a schedule you adjust beside the conversation

### Changed

- The card a new scheduled task or workflow leaves in the transcript is laid out like a
  confirmation people now expect: a heading, then a card with the name and an "On" badge,
  the time, how often and in which zone, the next run, the end date if any, and what it
  will do (the task's instructions, or the workflow's steps) — and under it a round grey
  pill that opens it.
- The pill opens an editor in the side panel for **workflows as well as tasks** (a workflow
  used to open its full-screen form). Name, instructions, permissions, repeat, time (quarter
  hours, plus the current one if it is off the grid), weekday, day of month, minute, time
  zone and end of repeat are changed in place and saved as they change; the card in the
  conversation follows.

### Added

- A repeat can stop on a date: `ends_on` on tasks and workflows (schema 23). The run whose
  next occurrence would fall after that date — read in the row's own zone — retires the
  schedule the way a one-off does. An end date before the next run is refused.
- `PATCH /api/tasks/:id` and `PATCH /api/workflows/:id` accept `schedule` —
  `{ frequency, time, weekday, day, minute }` — and `endsOn`. The existing `frequency` and
  `when` forms are unchanged.

## 2026-09-27 (evening) — an everyday toolbox

Branch `feat/tool-library-2026-09-27`.

### Added

Ten tools for the questions a model should answer from a lookup or a calculation rather than
from memory. All are free with no key, all are deferred — listed in `load_tools` by one short
sentence and sent in full only to a turn that asks — so an ordinary turn costs 144 more tokens,
not ten schemas. Everything from outside comes back inside the untrusted envelope.

- `date_calc` — days between dates (and working days), date plus days/months, weekday and ISO
  week, the Vietnamese lunar calendar both ways (Hồ Ngọc Đức's algorithm; can chi names), a
  clock time moved between zones across daylight saving, and public holidays by country — with
  Tết and Giỗ Tổ computed, because the holiday service leaves Vietnam's lunar ones out.
- `convert_units` — length, weight, temperature, area (sào, mẫu, ha), volume, speed, time, data
  size, energy, pressure, power.
- `market_data` — crypto (CoinGecko) and stocks, indices and commodities (Yahoo Finance):
  US tickers, HOSE listings, VN-Index, VN30, gold, oil. Marked as possibly delayed.
- `place_lookup` — a place on OpenStreetMap, or the distance between two, straight and by road.
- `read_feed` — the latest items of an RSS or Atom feed.
- `text_tools` — count, hash, base64/URL encoding, UUIDs, JSON checks, regex, diff, slugs,
  Vietnamese accent stripping, case.
- `analyze_data` — describe, group-total or rank a CSV or JSON table, inline or attached;
  reads `1.234,5` and `1,234.5` alike.
- `make_qr` — a QR code image in the conversation.
- `http_request` — any REST call; GET and HEAD run, anything that writes asks first.
- `encyclopedia` — a Wikipedia summary and link, in Vietnamese for a Vietnamese query.

## 2026-09-27 (later) — work that runs on time, in one place, and says so

Branch `fix/realtime-runs-2026-09-27`.

### Added

- **`world_facts`** — the current time and date, the weather for a place (now and three days), and
  exchange rates, looked up live from Open-Meteo and open.er-api.com. No key, read-only, so it runs
  without asking. The system prompt's date is now read in the account's own zone rather than UTC,
  which was yesterday's date in Vietnam until 07:00.
- **A mode chip when a workflow or scheduled task is set up by describing it.** "Describe it to the
  assistant" on either shelf opens a chat marked "setting up a workflow" (or "a scheduled task"); the
  first message carries that to the server and the model is told which tool files it on which shelf.
- **`/api/cron/run-tasks?background=1`** answers `202` at once and finishes under Vercel's
  `waitUntil`, so a free outside pinger (cron-job.org) can drive the queue every few minutes. The
  README says how; without it Hobby only runs due work once a day or while the app is open.

### Changed

- **A scheduled task or a workflow keeps one conversation.** Each run adds to the one the last run
  wrote into, rather than making another; a deleted one is made again.
- **Opening a conversation something is running in follows it** — the request, the steps and the
  reply appear as each is saved, where before only the finished result showed. Run now goes straight
  to that conversation.
- **The reasoning is a card**: folded, a window on its newest lines, faded at the edges; open, the
  whole trace, with the words just arrived glowing. The title shimmers while it is still thinking.
- **Email: each briefing section is one card**, its "Sources" line included, and a sentence-long
  value is no longer set in bold. Commas between linked sources are kept.

### Fixed

- **The same email could be sent twice** — a step told to "put it in an email" sent it, then the
  next step sent it again. An identical email (same recipients and subject) accepted in the same
  conversation in the last 20 minutes is refused unless the user asked for a copy.
- **The email's title was black on the purple header in the Gmail app's dark mode**, which inverts
  text colours but not gradients. The header text is layered so it stays white there.

## 2026-09-27 — a schedule you set up is a card you can open

Branch `feat/schedule-card`.

### Changed

- **Setting up a scheduled task or a workflow draws a card in the conversation**, not only a
  sentence: what was set up, how often in words ("every weekday at 07:30", never `weekdays 07:30`),
  the time zone it fires in, and a pill at the foot — "every weekday at 07:30 · Next: 29 Sep, 07:30 ·
  Morning briefing" — that opens it. A task opens on its own page, where the time, the instructions
  and Run now are; a workflow opens in its form. The sentence used to scroll away and lead nowhere:
  changing the time meant finding the Scheduled shelf, finding the row, and opening it. The next run
  is shown in the task's own zone, so a 07:30 Hanoi briefing reads 07:30 wherever it is opened from.
  The card is stored on the tool result, so reopening the conversation redraws it; a turn that
  creates a workflow and then updates it shows one card, the latest.
- **Asking for something already set up shows the existing one as that same card**, marked as
  already there rather than just made, above the keep / change / add another / cancel question — so
  the person can see what they are being asked about.

### Fixed

- **The duplicate-workflow notice listed every step as "[object Object]".** A stored step is
  `{ instruction }`, and the list read a field that does not exist.

## 2026-09-22 (later) — what the screenshots showed

Branch `fix/project-memory-sheet`. Follow-up to the entry below, made after seeing the screenshots
that went with the original report.

### Fixed

- **Changing the language left the sidebar's own headings in the old one.** "CONVERSATIONS" stood in
  English over an otherwise Vietnamese sidebar until the conversation list happened to refresh for
  some unrelated reason: those headings are appended by script rather than carried on `data-i18n`
  nodes, so `applyI18n` could not reach them. The same repaint that fixed the four openers now
  covers them.
- **"This conversation is running. Stop it first."** said to stop it and not where. Now that a turn
  survives a refresh, that refusal is met far more often — and at exactly the moment the page has
  just reloaded, which makes it read as a fault. It names the Stop button above the composer.

### Changed

- **Output moved into the work column**, between the composer and the conversations that produced
  it, and is drawn as cards rather than a list of filenames. The right-hand column is what the work
  *reads from* — instructions, memory, the shelf of sources — and a finished report is not a source,
  it is the point. A project that has made nothing draws no heading at all.
- **The Memory card has a "View memory" button**, and behind it every note in full with a Delete on
  each. A note is read into every future conversation, so a stale one is not clutter — it is a wrong
  fact being repeated, and until now the only way to be rid of one was to ask the assistant to call
  `memory_delete` and hope it picked the right key. Two presses to delete, like everything else
  destructive here. Deleting a project note that was shadowing an account note of the same name
  reveals the account one rather than taking both.

## 2026-09-22 — a turn that survives a refresh, and a project that remembers its own way of working

Branch `fix/run-survives-refresh`.

### Fixed

- **Refreshing the page mid-answer threw the answer away, and sending again was refused.** A closed
  socket was read as "stop", so a reload, a locked phone or a shut laptop lid killed work that was
  minutes in; what came back was a transcript frozen at the last saved step, with no spinner and
  nothing saying whether anything was still happening. It now asks the run's lease instead of
  assuming: the lease cleared means somebody pressed stop and the run ends at once; the lease still
  held means the browser simply left, and the loop carries on writing steps. Reopening the
  conversation is told the run id it needs to walk back into that same turn, so the rest of it
  arrives live and step by step rather than in one lump at the end. A tab of the same browser that
  is already narrating the run is followed rather than superseded, so a second tab cannot stop an
  answer somebody is reading.
- **A model withdrawn by its provider stayed in the picker for ever, and an account pinned to one
  could not send anything at all.** The library only ever grew. A refresh now forgets what its
  source has stopped listing — per provider, and only for a source that actually answered, so an
  outage cannot empty the library. The failure itself reads as a sentence too: aggregators announce
  a withdrawal in the *body* of a 404, chattily ("Thank you for participating in the Stealth Ox
  Alpha testing period…"), and that reached the transcript verbatim, in English, on every attempt.
  It now says which model went, that nothing the user did caused it, the successor the provider
  names, and where to change it — in Vietnamese for a Vietnamese account.
- **Vietnamese was drawn wrong on the project and shelf titles.** They were the only serif in the
  app, set in Georgia, which stops at Latin Extended-A — so every letter carrying a Vietnamese tone
  mark fell out of the font and was drawn by whatever the browser found next. "luật thương mại quốc
  tế" rendered with five letters in a different typeface, off the baseline. The stack is now one
  that covers Vietnamese.
- **A conversation filed under an unpinned project appeared nowhere in the sidebar.** The project
  section lists only pinned projects and the conversation list took only chats with no project at
  all, so anything in between fell through both. Filing something is not hiding it: the heading is
  filtered, the work is not.
- **The four openers on a blank screen stayed in the old language until a reload.** They were
  evaluated once at import time. They are read from the dictionary when they are drawn now — which
  matters because a blank screen is what somebody is most likely to be looking at while changing
  the language.

### Changed

- **A project keeps its own memory, underneath the account's.** "Cite the article number" is true of
  a law project and false of the deck beside it; pooled into one account-wide list those contradict
  each other. A note learned inside a project is filed under it and read back by its conversations;
  the account's notes still apply everywhere, including inside. A name in both is the project's —
  the narrower context is the more specific instruction. `scope: "account"` files a genuinely
  general fact from inside a project. The project page marks each note with where it lives.
- **A project page shows what the project produced.** The shelf listed the documents put *in* and
  nothing of what came out, so last Tuesday's report lived only in the transcript that wrote it.
  Pressing one opens it in the same panel the transcript's own file cards use.
- **A conversation row in a project says when it was last spoken in, not how many messages it
  holds.** Scanning a project is a search through time; a count sorts you nowhere.
- **Asking twice for the same scheduled task or workflow no longer makes a second one.** Two jobs
  doing the same work arrive twice, and cancelling one leaves the other running. The tool declines,
  shows what is already there, and asks with buttons — keep it, change it, add a second anyway, or
  cancel. Nothing is decided for the user, and a second one is still available to anyone who wants
  it.
- **Two chips left the header.** "Add a computer" was a permanent invitation to a thing most
  accounts do once or never, and the project chip named the project a second time — both in the one
  row that also has to hold the conversation's title, which they overran on a narrow window.
  Pairing lives in Settings → Computers, where somebody looks for it; the breadcrumb left of the
  title is the project, and goes there.
- **The four openers are glass on the accent rather than grey tiles**, and they say what most people
  actually open this for: research that keeps its citations, a file read and charted, the working
  folder on your own machine, and work that runs on a clock without you.

## 2026-09-21 — a galaxy instead of a green, and a schedule that keeps its time

Branch `fix/web-fetch-documents`.

### Fixed

- **A scheduled task or workflow only ran again the next day, whatever time it was set for.** The
  overdue sweep fired exactly once, when the page loaded, and the only other trigger is the cron —
  which on the free plan is one tick a day. So a task set for 07:30 ran at 07:30 only if somebody
  happened to open the app at 07:30. It now sweeps every minute while the tab is visible, and on
  returning to the tab; the daily cron stays as the backstop. Skipped entirely while hidden, because
  a background tab is not a cron job.
- **Running one by hand could make it run again automatically a moment later.** `next_run_at` is
  usually already in the past when you press Run now, so the next sweep saw it as due. Both Run now
  paths move the schedule forward before starting, so the worst case is a skipped occurrence rather
  than a surprise repeat of a job that sends email.
- **The composer drew two focus rings** — the rounded box's own glow, and the global
  `:focus-visible` outline landing on the textarea as a hard rectangle inside it. The rectangle is
  gone; every other control keeps its focus ring.
- **A sources line linked to the front page, not the article.** In a "Sources:" / "Nguồn:" line a URL
  now reads as the outlet alone — `nhandan.vn` — while still pointing at the page it came from,
  which is the entire purpose of citing one. Elsewhere a link keeps its path, because a link in the
  middle of a sentence is usually the point of the sentence. `send_email` now tells the model to
  write full article URLs there.

### Changed

- **Both side panels can be dragged, and double-clicked back to their default.** The width is
  remembered, the handle is a real `separator` a keyboard can move with the arrow keys, and Home
  resets it. Bounded at both ends, so a panel cannot be dragged to nothing or made to swallow the
  window.
- **The accent is a galaxy gradient that drifts** — violet through magenta to cyan — on the primary
  button, the composer's focus ring, the active conversation's bar and the panel handles. `--accent`
  stays a solid colour for the many things that need one; `--galaxy` is the same identity as a
  moving surface, for the places big enough to show it. Still gradient, but still, under
  `prefers-reduced-motion`.
- **The opening question keeps the colour it had.** It is the first thing anybody sees and it was
  already right, so its two colours live in tokens of their own where a future change to the accent
  cannot drag it along by accident.

## 2026-09-20 — a big file is shrunk rather than refused

Branch `fix/web-fetch-documents`.

### Fixed

- **`Unexpected token 'R', "Request En"... is not valid JSON`** on any upload over about 3MB. That
  was the *host* refusing the request body at the edge, before a line of this app's code ran, with a
  plain-text `Request Entity Too Large` that `JSON.parse` then choked on. Errors that are not JSON —
  an edge refusal, a gateway timeout, a proxy error page — now read as what they are.
- **The declared 5MB limit was never reachable on the deployment.** Base64 inflates bytes by a third
  on the way out, so a 5MB file is a 6.7MB body and the host's ceiling is ~4.5MB. The browser now
  holds files to 3MB of *file*, which is what actually survives the trip.
- **An oversized file is made to fit instead of refused.** A photo is re-encoded at 1600px — more
  than any vision model reads, and routinely 44MB → 0.9MB. An oversized PDF is sent as the text
  inside it, read by the pdfjs already here for thumbnails; that is what every model on the OpenAI
  wire format would have been given anyway, so for most of the library nothing is lost but the
  layout — and the chip says so rather than leaving somebody to wonder. What genuinely cannot be
  shrunk, like a .pptx, is refused with its size, the limit, and what to do.
- **The composer's gradient covered the transcript's scrollbar** — most visibly when the
  conversation is long, the thumb is short and sitting at the bottom, which is exactly when somebody
  looks for it. The dock now stops short of it by the scrollbar's measured width (zero on the
  overlay scrollbars macOS and phones use), and its fade turns solid later.
- **The sidebar's two lists both claimed the free space**, so a long conversation list squeezed
  itself into half the height while the scheduled list sat empty above it. Scheduled work sizes to
  its content and is capped; the conversations take what is left.

### Changed

- **Section headings stay put while their own section scrolls.** Scrolling into the middle of a long
  list left you looking at rows with no way to tell whether you were inside a project, inside a
  group, or in the ordinary list — the one question a heading exists to answer.
- **The sidebar lists the twenty most recent conversations**, with "View all" for the rest. Past
  about twenty it stops being something you glance at. The order is by when something was last
  *said*: pinning, archiving and grouping deliberately do not move a conversation, because none of
  them mean it moved on.

## 2026-09-20 — a project's conversations live under the project

Branch `fix/web-fetch-documents`. Schema 21.

### Added

- **The sidebar files a project's conversations under it**, above the ordinary list, each project a
  heading you can fold. Mixed into one flat list, a project was a folder you could put things in and
  then never see the inside of: the shelf knew what was filed where, and the sidebar — the thing
  actually used to move between conversations — did not. Sections are open by default, because a
  sidebar that hides conversations until you find the right heading to click has lost the list it
  exists to be; folding one is a deliberate act and it sticks.
- **One menu of everything you can do to a conversation**, offered from two places: the ⋮ on its
  sidebar row, and a new chevron beside the title. Built from one description rather than written
  twice — two hand-written copies is how one of them ends up missing "Remove from project" for a
  year. The row leads with "Open in new window"; the title leads with "Schedule", because the
  conversation is already open and the useful offer is work like this, later.
- **Change project** opens a searchable panel beside the menu, ticking the one it is already in. The
  search doubles as the way to make a new one: a separate "New project" entry would be a second road
  to the same place, and the one nobody uses goes stale.
- **Move to group.** A group is a name somebody invents; the set of groups is the distinct set of
  names in use. The consequence is deliberate — moving the last conversation out of a group is what
  ends it — because a table would buy empty groups and a lifecycle to manage them, for a feature
  whose entire job is putting a few rows under a heading.
- **Archive, and mark as unread.** Archiving is not deleting, and the distinction matters precisely
  because they sit together in the same menu: it is what somebody reaches for when they are not
  sure, so it is genuinely reversible. "Mark as unread" is a note to yourself that a conversation is
  not finished with; nothing sets it automatically.
- The conversation header names the project it is filed under, and goes there.

### Fixed

- **The row menu's keyboard shortcuts were positions, not letters** — `{ p: 0, r: 1, d: 3 }` — which
  was right for a three-item menu and silently wrong the moment it grew: `d` would have stopped
  meaning Delete and started meaning whatever landed in slot three. They are read off each item now.
- **`updated_at` no longer moves when a conversation is archived, grouped or marked unread.** The
  sidebar orders by it, so those actions sent a conversation to the top of the list — the opposite
  of what all three mean.

## 2026-09-20 — a project schedules its own work

Branch `fix/web-fetch-documents`. Schema 20.

### Added

- **A project has its own Scheduled section.** A task made there runs *inside* the project — same
  standing instructions, same shelf of sources. Without that, "summarise this week's filings" set up
  from a project answered from nothing at all, which is worse than failing because it looks like it
  worked. `ON DELETE SET NULL`, so deleting a project leaves its tasks running as ordinary ones
  rather than silently taking them with it.
- **The task form asks with menus instead of a typed time.** Frequency is Manual, Hourly, Daily,
  Weekdays, Weekly or Monthly, and each says underneath what it actually means — "Hourly" chosen at
  09:30 means half past every hour, which a dropdown alone does not tell anybody. The written form
  (`fri 16:00`) is still what the agent's own `schedule_task` tool speaks, because a menu that could
  only express a third of the schedules would be a worse tool.
- **Manual is a real option**, not a repeat scheduled so far ahead it never fires. It stores no cron
  and no next run, and the due query — `enabled AND next_run_at <= now()` — matches neither, so it
  waits for Run now and nothing else.
- **Permissions, per task.** A run happens with nobody watching, so "pause and ask", "stop only at
  something that could do real harm" and "never pause" are genuinely different decisions rather than
  a preference. Each option says what it does at 3am. Unset means the account's own default.
- **A task has its own page** — the instructions it will follow, the project it answers from, how
  often it repeats, what it may do, its last run — with Run now, pause and delete. Run now is the
  only way a manual task ever runs, and the fastest way to find out whether a scheduled one does
  what you meant without waiting until morning. It opens the conversation the run wrote, because
  that is the output.
- **The sidebar lists scheduled work of its own**, above the conversations: a scheduled task is not
  a conversation you had, it is something that will happen. It refreshes on returning to the tab, so
  a task the assistant scheduled itself, or one added from a phone, appears without a reload.
- **A magnifier on a project's Context.** Cards are right for twenty sources and wrong for two
  hundred; past that the only question is "where is the one called X". A search box, a list, and the
  file itself beside them with the same download the card preview offers.

## 2026-09-20 — a project's shelf shows what is on it

Branch `fix/web-fetch-documents`. Schema 19.

### Added

- **A project source keeps the file it came from.** The bytes used to be read once for their text
  and dropped, which made the shelf a list of filenames: nothing to look at, nothing to open, and no
  way to get back what you uploaded. The original is now stored in the attachments table — the one
  that already has a sweep and a route that serves under `default-src 'none'` — and a source is
  drawn as a card with a picture of itself: an image scaled down, or a PDF's first page. Pressing
  one opens it large, and the original is one press away from there.
- **A picture can be a project source.** It used to be refused, on the reasoning that a source is
  something an answer can cite. What that missed is that half the library can *see*, and a diagram
  on the shelf is worth more to those models than the paragraph describing it. An image carries no
  text, so it never competes for the passage budget the quotable sources share; it rides on the
  question as a real picture instead, capped at four so a shelf of screenshots cannot quietly make
  every turn expensive. A model with no eyes is told there was a picture rather than left to answer
  as though the shelf were empty.
- **Sources can be selected and removed together.** Ticking one opens a bar with a count, a
  select-all and a delete; nothing offers to delete until asked, because a shelf is mostly read.
  Removing a source now also removes the original it kept, which would otherwise be a file nobody
  can reach counting against storage forever.
- `scripts/vendor-pdfjs.js`, and `public/vendor/pdfjs` — 1.7MB of pdfjs loaded **only** by someone
  adding a PDF to a project, to draw its first page once at upload. In the browser because pdfjs
  renders to a canvas and a canvas in Node is a native module, which a free serverless deployment
  cannot have. `test/projects.test.mjs` fails when the copy drifts from the installed package.

## 2026-09-20 — runs survive leaving, PDFs are read, steps read as sentences

Branch `fix/web-fetch-documents`.

### Fixed

- **Leaving a conversation mid-answer killed the answer.** Switching chats aborted the stream, which
  closes the socket, which the server takes as "stop this run" — so a glance at another conversation
  ended the work. Coming back showed a transcript frozen mid-thought with no sign of whether
  anything was still happening, then the whole finished reply appearing at once some minutes later.
  A run now owns its own element and every handler draws into that, so navigating away merely
  detaches it: the fetch stays open, the lease stays held, the model keeps working, and returning
  re-attaches it mid-sentence. The composer, the stop button, the status line and the queue all
  follow the conversation you are looking at.
- **Two conversations can now answer at once.** They cannot reach each other's nodes, so the bug
  that made aborting necessary — one run's prose grafted into another's transcript — is not
  reachable by construction. Within a single conversation there is still exactly one loop, enforced
  by the server's lease; anything typed meanwhile queues, per conversation, as before.
- **A PDF could not be read on the deployment at all.** `Setting up fake worker failed: "Cannot find
  module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'"`. pdfjs reaches its worker
  with `import(this.workerSrc)` — a variable specifier no bundler can follow — so Vercel traced
  `pdf.mjs` and shipped it without the worker beside it, while a laptop with the whole package on
  disk worked perfectly. The worker is now imported by name, which both traces the file and hands it
  over through `globalThis.pdfjsWorker` so the dynamic import is never reached.
- **Four spinners said what one status line already said.** A turn with a reasoning block, a run of
  steps and two tool calls open spun a ring in each of them while the line under the transcript
  named the tool that was working. A card in progress is now the one with no tick — a hollow ring
  the same size, so nothing shifts when the tick lands, and nothing moving.

- **An answer that arrived as reasoning was hidden inside "Reasoning".** Some models — the free
  reasoning ones on OpenRouter especially — put the whole reply on the non-standard `reasoning`
  field and leave `content` empty. The turn ended with a correct, complete answer folded into a
  collapsed block and an empty bubble beside it, which reads as the assistant having said nothing.
  When a turn has no prose and called no tool, its reasoning is now the reply — stored that way, so
  a reload agrees, and moved in the live view too. A turn that said something, or whose point was a
  tool call, is untouched: promoting that one would paste a private deliberation into the
  conversation as though it had been addressed to the user.
- **Every tool outside the browser and desktop families printed its own function name.**
  `skill_read {"name":"Writing a Word document"}` sat in the middle of a transcript otherwise
  written in sentences. All 93 tools now have a verb in both languages — "Read a guide", "Ran
  command", "Searched the web" — and `test/i18n.test.mjs` fails the build when a tool is added
  without one. The exact call and its arguments moved *inside* the card rather than going away, so
  "it passed the wrong path" is still something you can see.
- **`web_fetch failed: fdvn.vn returned 11014847 bytes, which is too large to read.`** An 11MB PDF
  was refused before a byte of it was read. The 8MB ceiling that stops a runaway page from filling
  the process was also the ceiling on a document, and the two are not the same problem: a page can
  be cut anywhere, a PDF cannot be cut at all. Documents now have their own 32MB ceiling and are
  read whole.
- **A fetched PDF or Word file came back as mojibake.** Anything that was not HTML was decoded as
  UTF-8 and pasted in, so the model paid for several thousand characters of binary in every
  following turn and could not read a word of it. `web_fetch` now opens a PDF, `.docx`, `.xlsx` or
  `.pptx` with the same readers an attachment goes through, and refuses bytes that are neither text
  nor a readable document instead of inlining them.
- **A page cut at the byte ceiling lost the sentence saying so.** The note was appended to the body
  and then sliced off again by `max_chars`. Both notes now go after the clip, and the truncation
  note says that calling again with a larger `max_chars` reads the rest.

### Changed

- `web_fetch` defaults to 60,000 characters for a parsed document and stays at 20,000 for a page:
  answering from the first third of an exam paper is the failure the tool exists to prevent. An
  explicit `max_chars` still wins, up to 200,000.
- The pulsing dot beside a running conversation in the sidebar is gone. It sat next to the bar that
  already marks the open row and duplicated the composer's own spinner. The list still knows what is
  running — it keeps refreshing every 5 seconds so a background run's title appears by itself.
- `extractPdfText` takes a `Buffer` as well as base64, so a freshly downloaded 30MB document is not
  encoded to base64 only to be decoded straight back.


## 2026-09-16 — background runs appear in the conversation list at once

Branch `feat/live-run-conversations`.

### Fixed

- **A workflow run halfway through its steps was missing from the sidebar**, which said "no
  conversations yet". The conversation existed from the start; the list only loaded on page load and
  after sending a message.

### Changed

- The chat list returns `running` for a conversation a workflow run, a scheduled task or a turn is
  working in, and lists such a conversation before its first message lands. Scheduled tasks record
  their conversation when they start (`markTaskChat`), not only when they finish.
- The sidebar marks running conversations with a pulsing dot (still under reduced motion, named for
  screen readers) and refreshes itself: every 5 seconds while anything runs, every 30 otherwise, never
  in a hidden tab, and at once on return. An unchanged list does not re-render, and no refresh happens
  while a conversation is being renamed or its menu is open. "Run now" on a workflow shows the
  conversation within a moment rather than when the request returns.

## 2026-09-15 — a NUL character no longer fails a step

Branch `fix/nul-in-stored-text`.

### Fixed

- **"unsupported Unicode escape sequence"** failed a workflow step whose web search read a page
  containing U+0000: Postgres refuses it in jsonb (as the `\u0000` escape) and in text columns. The store
  now removes it from every string before JSON encoding and from every text parameter, at the one
  query function all writes pass through. Text containing a literal backslash-u-0000 is untouched.

## 2026-09-15 (overnight) — galaxy look, the web logo, and no personal addresses

Branch `feat/email-galaxy-private`.

### Changed

- **Galaxy gradient replaces the green**: cards open with an indigo → violet → fuchsia header holding
  the logo, the kind's label and the title in white; buttons, section bars and a letter's top line use
  the same gradients, each with a solid fallback colour. Kind accents move into the same family; rise
  and fall figures keep green and red.
- **The web logo is in every email**, scaled to 96px and embedded as an inline (`cid:`) attachment by
  both the SMTP and Resend paths; without the file the image is left out rather than shown broken.
- **No personal email address in a message.** The footer names the sender only; Reply-To is no longer
  the person's address — replies come back to the business mailbox, or to the new `EMAIL_REPLY_TO`.
  The product tagline under the footer is gone: the brand is whatever `EMAIL_FROM` names.

## 2026-09-15 (late night) — every kind of email, laid out for what it is

Branch `feat/email-adaptive`.

### Changed

- **Sixteen kinds of email**, each with its own shape, colour and label: letter, thank-you, apology,
  follow-up and job application are written like a person's email; newsletter, report, announcement,
  alert, invitation, reminder, quotation, invoice, confirmation, meeting notes and welcome are
  labelled cards. `send_email` takes a `kind`; without one it is inferred from the subject and
  opening (whole words, longer phrases weigh more, one passing mention does not decide), then from
  structure.
- **Shapes documents are made of**: `Label: value` lines become a details card, a "Total/Tổng" row is
  highlighted, `- [ ]` becomes a checklist, a lone link becomes a button, `+x%`/`-x%` in a table are
  coloured.
- **Adaptive**: the footer and date follow the language the message is written in; dated kinds use
  the account's time zone; a first line repeating the subject is dropped; the inbox preview skips
  headings. Dark mode and phone spacing for Apple Mail and Outlook apps, with the inline light design
  standing on its own in Gmail.

## 2026-09-15 (night) — emails that look finished

Branch `feat/email-design`.

### Changed

- **`send_email` sends a designed email.** The body is Markdown, laid out by `server/mailTemplate.js`:
  a branded header, the date and subject as a title, section headings with an accent bar (a line
  written in capitals becomes one, capitals kept), lists, tables, callouts, quiet "Nguồn:/Sources:"
  lines, and a footer naming the sender with a reply hint — in Vietnamese or English. Tables and inline
  styles only, 600px wide, no images, fonts or scripts, so it renders the same in Gmail, Outlook and on
  a phone and carries nothing a filter scores as remote content. A plain-text part is sent beside it.
- **The password-reset email uses the same layout.**
- The tool tells the model to write Markdown, not HTML.

## 2026-09-15 (evening) — the app is Synapse; mail written to reach the inbox

Branch `feat/synapse-brand-and-inbox`.

### Changed

- **Renamed from AI Remote to Synapse** everywhere a person reads the name: the page, sign-in,
  onboarding, emails, server messages, the worker and launcher banners, the authenticator label for
  newly enrolled two-factor, and the author metadata of generated Word, Excel and PowerPoint files.
  `test/i18n.test.mjs` fails if the old name comes back.
- **Email From line is the deployment's name only.** "Lan Nguyen via …" <mailbox@gmail.com> looked
  like impersonation to spam filters. The person is now in Reply-To and a footer line.
- **Every text email has an HTML part** beside it, plain and escaped.

### Not renamed, on purpose

- The worker's autostart task (`AI Remote worker`) and the folder downloaded files live in
  (`AI Remote\files`): existing installs depend on those names.
- Browser storage keys, the `ai-remote` package name, install folders and the Vercel URL.
- Authenticator apps keep the label an account was enrolled with until two-factor is set up again.

## 2026-09-15 (later) — email for each person, and formulas that render

Branch `feat/email-per-user-and-math-render`.

### Fixed

- **`send_email` said "sent" when the provider refused.** `sendEmail` returns `{ ok: false }`
  rather than throwing, and the tool ignored it. A refusal is now reported as the email NOT sent,
  with the provider's reason.
- **Formulas printed as raw TeX.** `$…$`, `$$…$$`, `\(…\)` and `\[…\]` are typeset with KaTeX
  0.18.7, served from `public/vendor/katex` and loaded only when a reply contains one. Prices such
  as "$5 and $10" stay text.
- **Code under a bullet was mangled.** A fenced block indented under a list item renders inside that
  item; ``````lang code`````` on one line is inline code.

### Changed

- **`send_email` writes on the user's behalf.** `to` is optional — empty sends to the account's
  registered address — and accepts up to ten addresses. The From line names the person, and
  Reply-To is their address.
- **Gmail in two variables:** `GMAIL_USER` and `GMAIL_APP_PASSWORD`.

### Upgrade notes

- To send from the deployment's Gmail, set `GMAIL_USER` and `GMAIL_APP_PASSWORD` (an App
  Password) in the hosting environment and redeploy.
- `katex` is a dev dependency; after upgrading it run `npm run vendor:katex` — the test suite fails
  until the vendored copy matches.

## 2026-09-15 — Auto is OpenRouter's free router; a Languages tab; full translation

Branch `feat/auto-openrouter-free-languages`.

### Changed

- **Auto is `openrouter/free`.** It used to rank the library by a hand-kept family order and
  had a separate "prefer a model that reads images" setting. OpenRouter's router now picks a free
  model per message, including one that reads images, so the setting is gone. Auto needs an
  OpenRouter key; an OrcaRouter key alone no longer runs it.
- **Settings → Models is replaced by Settings → Languages.** The language choice moves out of
  Behaviour into its own tab. Adding a model by id and checking the built-ins lose their buttons;
  `POST /api/models` and `POST /api/models/audit` still work.

### Added

- **Complete Vietnamese.** Every label, hint, placeholder and tooltip in the page, every string the
  modules build (menus, cards, badges, statuses, the model picker), and the server's own sentences —
  HTTP errors, stream status and retry lines, approval reasons, connector help, MCP suggestions,
  stored workflow step errors.
- `server/i18n` translates at the response boundary from the `X-Language` header;
  `scripts/server-messages.js` lists every server sentence from the source.
- `test/server-i18n.test.mjs`, and a markup-coverage check in `test/i18n.test.mjs`.

### Upgrade notes

- The `autoVision` preference is ignored and no longer saved.
- `espree` is now a direct dev dependency (it was already installed through ESLint).

## 2026-09-14 — server and worker audit

Branch `audit/server-worker-2026-09-09`, from `main` at `3e8273e`. Every entry has a
ledger ID in `audit/ISSUE_LEDGER.md` with the evidence and the test that holds it;
`audit/RESULT.md` has the before/after measurements.

### Upgrade notes — read before deploying

- **Schema 18.** `chats.next_seq` is added and back-filled on first start. Nothing to
  run by hand; a database already at 18 skips it. (`ARCH-007`)
- **Worker: plain `http://` to an internet host is now refused.** `https://` works
  anywhere, `http://localhost` works, and a private-network address works with a
  warning. Set `ALLOW_INSECURE_SERVER=1` in `worker/.env` only if you accept the
  token and every command crossing the network unencrypted. (`SEC-032`)
- **Image generation uses `gemini-3.1-flash-image`.** Google shut down the Imagen 4
  endpoint the app used on 2026-08-17. Same Google key; checked against the SDK's
  types but **not yet run against a live key**. (`GAP-008`)
- **`openai/o4-mini` is substituted with `openai/gpt-5.6-terra` after 2026-10-23**,
  and the turn says so. (`GAP-009`)
- **Now asks first:** `schedule_task`, `workflow_write`, `skill_write`. (`SEC-027`)
- New optional variables, documented in `.env.example`: `MAX_TURN_TOKENS`,
  `RESEARCH_REPUTABLE_DOMAINS`, `ALLOW_INSECURE_SERVER`.

### Security

- Web pages, files, command output, GitHub and Notion text read by tools are marked
  as untrusted content at one exit, whichever path produced them. (`SEC-015`, `SEC-019`)
- The MCP http transport connects to the address it checked, closing DNS rebinding.
  (`SEC-016`)
- `python -c`, `node -e` and other interpreters launched as apps count as shells.
  (`SEC-017`)
- Server logs are redacted like replies. (`SEC-018`, `SEC-020`)
- An upsert can no longer cross an account boundary. (`SEC-021`)
- `export_pdf` can no longer print local files. (`SEC-022`)
- Read-only and plan mode refuse a changing tool even if the model names one it was
  not offered; an approval binds to the calls it was shown for. (`SEC-023`)
- A dangling link cannot carry a write out of the workspace. (`SEC-025`)
- A sub-agent runs only tools it was offered. (`SEC-026`)
- Re-pairing a computer to another account clears the last account's background
  commands and browser session. (`SEC-028`)
- One MCP server with a badly named tool, or two servers whose names reduce to the
  same id, no longer break every turn. (`SEC-029`)
- Under the `auto` policy, one turn sends at most five unapproved messages.
  (`SEC-030`)
- Credentials on the clipboard are redacted before the model reads them. (`SEC-031`)

### Correctness and reliability

- After auto-compaction the model keeps the recent turns and the question, not just
  the summary. (`ACC-007`)
- Vietnamese national press counts as a reputable source in research. (`ACC-006`)
- A tool call whose arguments were cut off is refused, not run on defaults; every
  call is checked against its schema first. (`AUTO-005`, `GAP-004`)
- An unattended run that was cut off is no longer recorded as ok. (`AUTO-006`)
- Resuming never repeats a call that may already have happened. (`AUTO-007`, `AUTO-008`)
- Pressing Stop stops the command on the computer, downloads and indexing included.
  (`AUTO-009`, `CODE-017`)
- Stopping keeps the half of the answer already shown. (`CODE-016`, `CODE-018`)
- Writing one memory note no longer erases the others. (`CODE-023`)
- A schema upgrade that fails part way on a local install leaves nothing half built.
  (`ARCH-009`)
- Sub-agents are only offered connectors the account has linked. (`CODE-026`)

### Cost and performance

- A per-turn token ceiling on shared keys (`MAX_TURN_TOKENS`). (`PERF-009`)
- A model that states no output limit gets a cautious budget, not 32,000.
  (`PERF-010`, `PERF-013`)
- Indexing a folder takes two statements, not two per file. (`PERF-012`)
- Image generation books its token usage. (`CODE-024`)

### Tooling and repository

- The gate stamp is judged by source content, so documentation commits do not expire
  it; sub-agents are never blocked at Stop. (`CFG-018`–`CFG-020`)
- The brief reports branch protection as it really is; cutting a release counts as
  publishing. (`CFG-012`, `CFG-017`, `CFG-021`)
- The prompt carries a version fingerprint the eval pins. (`GAP-003`)
- Four route files git treated as binary are plain text again, with a test.
  (`CODE-025`)
- No tracked source file may contain a raw control byte. (`CODE-022`)
- `claude.md` renamed to `CLAUDE.md`; stale numbers corrected across docs.
  (`CFG-016`, `CODE-012`–`CODE-015`, `CODE-027`)
- Type-error ceiling 363 → 362. Coverage 61.06% statements / 75.21% branches /
  75.32% functions.

### Not done, and why

- `GAP-005` prompt A/B, `GAP-006` OpenAI strict mode, `CODE-021` booking abandoned
  streams: each needs a live key, spend, or data the provider does not report.
- `GAP-010` translated server errors and `GAP-011` a self-check pass in the agent
  loop are features awaiting a decision, not defects.
