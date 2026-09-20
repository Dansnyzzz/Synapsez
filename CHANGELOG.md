# Changelog

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
