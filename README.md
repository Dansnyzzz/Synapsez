# Synapsez

A self-hosted, multi-user, multi-provider agentic AI workspace you drive from any device — including
your phone.

Bring your own API keys for **Claude**, **GPT**, **Gemini**, or **OpenRouter** (hundreds of models
under one key), pick a model per conversation, and let the assistant actually do the work: search the
web, read and edit your files, run commands, and remember what matters between sessions.

The interesting part is the split. The web app lives on Vercel so it is reachable from anywhere. The
tools that touch your computer run on your computer, in a worker you start and stop. Nothing on the
internet ever connects inward to your machine.

```
   Phone / laptop            Vercel                     Your PC (optional)
  ┌──────────────┐      ┌──────────────────┐        ┌─────────────────────┐
  │   Browser    │─────▶│  API + agent loop │◀──────│  Worker (polls out) │
  └──────────────┘  SSE └────────┬──────────┘  jobs └──────────┬──────────┘
                                 │                             │
                          Neon Postgres                 files · shell · git
                    chats · settings · job queue        inside one workspace
```

---

## What it can do

| | |
|---|---|
| **Any model** | Claude Opus 5 / Sonnet 5, GPT, Gemini, or anything on OpenRouter. Switch per conversation. |
| **Real tools** | `read_file`, `write_file`, `edit_file`, `delete_file`, `move_file`, `glob`, `grep`, `run_command`, `open_url`, `set_workspace`, `clipboard_read`, `clipboard_write`, `notify`, `system_stats`, `process_list`, `process_kill`, `launch_app`, `index_folder` on your machine; `create_file`, `update_file`, `web_search`, `web_fetch`, `search_docs`, `list_indexed` everywhere. |
| **Facts, not guesses** | `world_facts` (time, weather, exchange rates) always; on request through `load_tools`: `date_calc` (date maths, âm lịch both ways, time zones, holidays with Tết computed), `convert_units` (incl. sào, mẫu), `market_data` (crypto, US and Vietnamese stocks, VN-Index, gold), `place_lookup` (places, distance, driving time), `read_feed` (RSS/Atom), `encyclopedia` (Wikipedia, vi/en), `text_tools`, `analyze_data` (CSV/JSON stats and group totals), `make_qr`, `http_request` (any REST API; writes ask first). All keyless. |
| **Browser sandbox** | A real browser the assistant drives — and you watch live in the app, frame by frame. |
| **Desktop control** | Drives real applications through the accessibility layer — Windows, macOS and X11. Off by default; see the warning below. |
| **Your machine** | Clipboard both ways, desktop notifications, processes, CPU/memory/disk health, launching apps — on Windows, macOS and Linux alike. |
| **Your documents** | Point it at a folder and it reads the lot — text, Markdown, code, PDFs, Word, Excel, PowerPoint — then finds the right passage by meaning, not by keyword. Files never leave except as the passages themselves. |
| **Quick launcher** | A hotkey anywhere on the desktop opens one box. Type the thought, press Enter, and the app takes it from there. |
| **Skills** | Teach a procedure once; it is offered back in every future conversation. |
| **Scheduled tasks** | Daily or weekly work that runs unattended, into a conversation you read later. |
| **Workflows** | Several steps in order, run unattended, where each step sees what the last produced. It keeps its position: a run cut off at step three carries on at step three rather than sending the same email twice — and a step that was interrupted mid-flight is never repeated automatically, because nothing can tell you whether it had already happened. The shelf names the step that stopped and why. |
| **Sub-agents** | Fan a job out to several read-only agents at once and gather the answers. |
| **Deep research** | For a question where being right matters more than being fast: it searches several angles, cross-checks sources, and answers through an internal proposer–critic–arbiter debate. Searches run in parallel; eight pages are opened and read (a page that refuses is replaced by the next, spread across independent sites), and only the passages that bear on the question are kept. Every conclusion carries a confidence — HIGH / MEDIUM / LOW / CONFLICTING, counted from independent sources, not guessed — and is checked against the page it cites: a figure the page never states marks the conclusion down. Any claim with no source is flagged. It keeps time for the debate and always finishes with a report — from the last draft if the clock runs out. The full transcript is kept for audit. Runs on the conversation's own model, so it is affordable on a free one. |
| **Light and dark** | Follows your system by default; `Settings → Behaviour` overrides it per browser. |
| **Your computers** | Pair as many machines as you like with an eight-character code. Sign in anywhere and they are there. |
| **New-model alerts** | The daily scan spots a genuinely new release and tells you once, with the details — take it as your default or turn it down. |
| **Photos and files** | Attach screenshots, PDFs, Word, Excel, PowerPoint, code or logs — from the `+`, by pasting, or by dropping them on the window. Office documents are read out and previewed in the app. |
| **Documents it writes** | Ask for a report, a quotation or a deck and it makes the file: `.docx`, `.xlsx`, `.pptx`, Markdown, CSV, HTML or JSON. Preview it in the conversation, download it, or ask for a change — same file, not a second copy. |
| **Workspace files** | Browse the folder on your machine from the app, open a file, edit it, save it, make one, delete one — through the same worker tools the assistant uses, so the same workspace confinement applies. |
| **Arithmetic it does not guess** | Totals, averages and percentage changes are worked out rather than recalled, and the answer comes back with the expression beside it so the working can be checked. Getting a sum wrong is the oldest failure a language model has, and one wrong total puts every number near it in doubt. |
| **Reading a page for the facts** | Point it at a competitor's pricing page and ask for the plans: it reads the page in a call of its own and returns just the structured answer, instead of pasting twenty thousand characters of navigation and cookie notice into the conversation for every later turn to carry. If the page does not say, it says so rather than guessing. |
| **Charts** | Numbers become a chart drawn to scale — bar, horizontal bar, line, donut or stacked — with axes, a legend and every value labelled. The assistant supplies the data and the drawing is done in code, so a chart looks the same whether a flagship or a free model asked for it, and the palette is one checked for colour-blind separation rather than picked by eye. |
| **Artifacts** | A page the assistant writes `runs` — a calculator, a chart, a mock-up — sandboxed with no network and no access to your session. Edit the code beside it and save; every artifact ever made is on one shelf in the menu bar. |
| **Search that survives** | Exa, then DuckDuckGo, then Tavily, then Brave. The first that answers wins, the reply says which one did, and DuckDuckGo is paced so it does not get the address blocked. |
| **Spare API keys** | Several keys per provider, tried in order — including in the middle of an answer, which is when a free-tier key usually goes. A rate limit is waited out rather than mistaken for a dead key, a key already known to be resting is skipped rather than asked again, and when every key is limited you are told the time the first one frees up. |
| **A queue, not an interruption** | Type while it is working and the message waits above the composer, then goes when the turn ends — or when you press stop. Interrupting is still one press away, on the queued line. |
| **File panel** | A document the assistant makes opens *beside* the conversation on its own — Word as pages, spreadsheets as a grid with frozen headers, decks as slides with their notes, figures and all, PDFs in the browser's own reader. Open it in Word or Excel on your machine, show it in a folder, copy it with its formatting intact, or Print → Save as PDF. Every version it ever wrote is one press away. |
| **Housekeeping** | Expired codes, unsent uploads, finished tool jobs and stale throttle counters are swept without being asked. |
| **Connectors** | Google (Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks, Contacts) by signing in; GitHub, Notion, Slack, Telegram and more via a pasted token. |
| **Interruptible** | Keep typing while it works. A new message is picked up at the next step, so you can change your mind mid-task. |
| **Approval gate** | Ask before anything that changes your machine, auto-run everything, or read-only. Your call — from the control beside the send button. |
| **Auto-compact** | Long conversations fold their older turns into a summary before the window fills. A ring in the header shows how full it is. |
| **Live plan** | The assistant keeps a visible task list as it works through multi-step jobs. |
| **Reasoning** | Streamed and collapsible, for models that expose it. |
| **Memory** | Notes read back at the start of every conversation, project notes first, within a budget; `memory_search` for the rest. Identifiers are never saved and sensitive topics only if you allow it. Every note editable in Settings → Memory & privacy. |
| **Earlier conversations** | `search_chats` looks back through what was said, scoped to the project you are in, as Claude's chat search does. Switchable. |
| **Incognito** | A conversation kept out of history, search, export and memory, deleted when you leave it. |
| **Your data** | Export everything as one file; import conversations from Claude, ChatGPT or another Synapsez; delete the account; a security record of sign-ins, key and privacy changes; automatic deletion after 30–365 days if you want it. |
| **Phone-first** | Responsive down to small screens, safe-area aware, installable to the home screen. |
| **Cost** | Token counts every turn, and dollar estimates where pricing is known. |

---

## Quick start — on your own computer

No database to install and no Vercel account needed — Postgres runs in-process, stored under `./data`.

```bash
git clone <your-repo-url> ai-remote
cd ai-remote
npm install
npm start
```

**One command, one terminal, everything at once.** `npm start` brings up every piece you have
configured and labels their output so they can share a terminal:

| Piece | Runs when | What it gives you |
|---|---|---|
| Web app | always | The UI, at `http://localhost:5173` |
| Machine worker | always — `--no-worker` opts out | Paired, it connects. Unpaired, it shows a code and waits. |
| Cloudflare tunnel | `npm run share` | A public HTTPS URL for the local app |

They are independent, so running all three together is the normal case rather than a special one.
`Ctrl+C` stops the lot.

Open the printed address, create an account (the first one becomes the administrator), and add a
provider key in Settings. Then open the LAN address on your phone — same Wi-Fi — and you have the
remote.

> Running locally you need **no worker at all**: the app process is already on your machine, so the
> admin account gets the file and shell tools directly. A worker is only for reaching this computer
> *from somewhere else*.

Set `WORKSPACE` in `.env` to the folder the assistant works in — or leave it and change it later from
**Settings → Computers**, which is the point: the folder is a setting, not something you restart for.
On a local run the **admin** account gets the file and shell tools directly, with no separate worker
to start.

---

## Accounts

**Signing up is an email and a password.** Nothing else — no invite code, no shared secret to
remember. A code appears exactly once in an account's life: **six digits emailed** to prove the
address is a real inbox rather than a throwaway, and only when a mail provider is configured at all.

After that it is email and password, forever.

Registration is open by default. Set `ALLOW_SIGNUP=false` on a public deployment once the people you
want are in, and the door closes behind you — the very first account can always be created, or the
deployment would have no administrator.

The same Postgres runs everywhere: Neon when `DATABASE_URL` is set, and an in-process Postgres
(PGlite) stored under `./data` when it is not. Identical SQL, identical scoping, identical tests —
so a laptop and a deployment behave the same, and there is no second, weaker mode to reason about.

### The multi-user boundary

Letting other people in means one thing has to be airtight: **an account must never be able to reach
another account's computer.** So the worker is paired to an account, not to the deployment:

- Each computer is paired to an account with a one-time code and gets **its own** token. The server
  keeps only a SHA-256 digest, and the token never touches the browser — it goes to the machine.
- That token is what identifies whose machine is calling, and which one. Jobs are queued *and*
  claimed filtered by owner and by device, so a job can only ever be handed to the right machine
  belonging to the person whose conversation created it.
- Pairing runs the safe way round: a computer with no token can only ask to be adopted. It names no
  account and reads nothing. What attaches it is a signed-in person typing its code.
- Every chat, message, note and provider key query is filtered by the user id from the verified
  session — never by anything the client sent.

`npm test` runs that boundary as an executable test, across two accounts, one deliberately trying to
read the other's transcript, rename their chat, steal their worker's shell job, spoof a job result,
unpair their computer, move their working folder, replay a password-reset link, spend someone else's
reset code, spend someone else's recovery code, and slip past a quota. It also asserts which tools the
model is even shown, since a model cannot reach for a tool it cannot see. It runs the real SQL against
an in-process Postgres, so it catches a regression in the scoping rather than in a mock.

**Each person should bring their own API key.** If you set `ANTHROPIC_API_KEY` and friends in the
deployment environment, they become a shared fallback that every account spends against — convenient
for a private deployment, an unpleasant surprise on a public one. Leave them blank and each person
enters their own in Settings → Providers, where it is encrypted with `ENCRYPTION_KEY` before storage.

If you do want to share a key, set `DEFAULT_MONTHLY_TOKEN_LIMIT` so nobody can run up your bill, and
override it per person in Settings → People. The cap applies **only** to accounts riding the shared
key — someone using their own is never limited, because it is not your money.

### Email

**There is no confirmation step.** Sign up and you are in. An address that does not exist is a
problem for whoever typed it, not something to hold a working account hostage over — and a
deployment with no mail provider could never have released the hostage anyway.

Email is used for two things: letting somebody who forgot their password get back in, and the
assistant's `send_email` tool. Pick one backend, or none:

| Backend | Set | Notes |
|---|---|---|
| **Gmail** | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | The deployment's own Gmail mailbox. The password is an **App Password** (Google Account → Security → 2-Step Verification → App passwords), not the account password; spaces in it are ignored. Uses `smtp.gmail.com:465`. |
| **Resend** | `RESEND_API_KEY` | Plain HTTPS. Sends only from a domain you have verified with Resend, so not from a gmail.com address. |
| **SMTP** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Any other provider. Wins over the Gmail variables when both are set. |
| **Console** | nothing | Mail is printed to the server log. Fine locally for a reset code — and `send_email` refuses, saying the email was **not** sent, rather than pretending. |

**`send_email` writes as the business, from the deployment's mailbox.** Every account shares the one
sending mailbox — a provider will not send as an address it has not verified. The From line carries the
name in `EMAIL_FROM` (for example `Elite Business <you@gmail.com>`), replies come back to that mailbox
(or to `EMAIL_REPLY_TO` when set), and the footer names the person who sent it — **never their own email
address**, which appears nowhere in the message or its headers. Putting the person's name on the From line
was tried and sent mail to spam: a display name that belongs to someone other than the address is what
impersonation looks like to a filter.

**What it looks like.** The body is written in Markdown and laid out by `server/mailTemplate.js` for
what the email *is*. There are sixteen kinds: a letter, thank-you, apology, follow-up or job application
looks like a person's email; a newsletter, report, announcement, alert, invitation, reminder, quotation,
invoice, confirmation, meeting notes or welcome is a card that opens with a galaxy-gradient header (the
logo, the kind's label and the title in white). The logo is the web app's own, scaled to 96px
(`scripts/email-logo.js`) and embedded in the message as an inline attachment, so it shows without an
"images are hidden" prompt. Every gradient has a solid colour first, for clients that drop them. The assistant
names the kind from the request, or it is inferred from the subject, the opening words and the structure.
Details (`Label: value`) become a card, totals are highlighted, `- [ ]` items a checklist, a lone link a
button. The footer names the sender in the language the message is written in, beside a plain-text part. It is built from
tables and inline styles, at most 600px wide, with no images, web fonts or scripts, because that is what
renders identically in Gmail, Outlook and phone mail apps and loads nothing a spam filter scores.

**Landing in the inbox rather than spam** is mostly decided by the sending domain, not the code. A
consumer Gmail address sending automated mail to people who have never written to it will sometimes be
filtered, whatever the message says. Recipients can fix it for themselves (mark as not spam, add the
address to contacts). The lasting fix is a domain of your own sent through Resend with SPF, DKIM and
DMARC set up, and `EMAIL_FROM` on that domain. Asked to "email it to me", it sends to the address the
account signed up with; otherwise to exactly the address, or up to ten addresses, the person gave. A
refusal from the mail provider is reported as a refusal.

The reset email carries **both a six-digit code and a link** — type the code back into the tab you
already have open, or click through, whichever suits. On a phone the code is usually faster.

### Two-factor authentication

**Settings → Account → Two-factor** shows a QR code for any authenticator app (Google Authenticator,
1Password, Aegis, …), plus the key in text for when there is no camera to hand. Nothing is switched on
until you type a code back, so a half-finished setup cannot lock you out.

Enabling it hands over ten **recovery codes**, shown once and stored only as digests. Each works once,
in place of the app, for when the phone is lost. Turning 2FA off needs the password *and* a live code.

The implementation is plain TOTP (RFC 6238) using Node's own crypto — no dependency, and the test
suite checks it against the RFC's published vectors, because an authenticator that disagrees with the
standard by one digit is worse than none at all.

Both are single-use, expiring (24 hours to confirm, one hour to reset), and stored only as a SHA-256
digest, so a database dump cannot be replayed as a login. Using one burns the other. A code is scoped
to one account, so it only has to be unguessable for that account within its short life. Changing a
password invalidates any outstanding reset link. "Forgot password" answers identically whether or not
the address exists, so it cannot be used to find out who has an account here.

---

## The model library

**A model can be listed and still refuse to run.** Google's own catalogue still returns
`gemini-2.5-flash`, and calling it answers *"no longer available to new users"* — so a named version
is a catalogue entry with an expiry date nobody is told about. Two things follow from that:

- The built-in Google entries are the **`-latest` aliases**, which Google rotates as models change,
  rather than version numbers that quietly stop working.
- `POST /api/models/audit` calls every built-in with your own key — one token in, one token out —
  and says which run, which are gone, and which were refused for a reason that is about the key
  rather than the model. Listing cannot answer that question; only calling can. (It no longer has a
  button: Settings lost its Models tab to Languages, and the header chip is the one place to choose.)

And when one does fail mid-turn, the provider's nested JSON is unwrapped to the sentence inside it
and the model is named, instead of a wall of escaped braces arriving halfway through an answer.
Send `inclusionai/ling-3.0-flash:free` — or the model's OpenRouter URL — to `POST /api/models` and it
is verified against OpenRouter's live catalogue, then **saved for everyone**. One person finding a good free model makes
it selectable for the whole deployment, with no link to paste again.

Two filters are applied on import, both for the same reason — a model in the picker should actually
work:

- **Text output only.** A handful of models emit images or audio, which this app cannot display.
  Vision models are kept: they read images but reply in text.
- **Tool calling required.** Acting on your behalf is the point of this app, and a model without tool support
  degrades into a chatbot that promises to do things and then does nothing. Adding one by id is
  refused with an explanation rather than silently accepted.

The library also **refreshes itself once a day**, so new free models appear without anyone pressing
anything. On Vercel that is a cron job; the app also catches up on its own if the library is more than
a day stale when someone opens the picker, so it is never empty or badly out of date.

> Vercel's Hobby plan caps how *often* a cron may run, not how many you get: 100 jobs per project,
> each at most once a day. Both this refresh and the scheduled-task cron are daily, so **both of them
> run on the free plan** — you are not choosing between them. Hobby fires within the hour rather than
> on the minute, which nothing here needs.
> Set `CRON_SECRET` so neither endpoint can be hammered by anyone who finds the URL.

### Picking one

The first choice is **which provider**, because that is what decides which of your keys pays:

| | |
|---|---|
| **Anthropic**, **OpenAI**, **Google** | The built-in models, billed to your own key for that provider. |
| **OpenRouter** | The shared library — hundreds of models, including the free ones. Vendor chips (GPT, Qwen, Gemini, Claude, Mistral…) narrow it further. |
| **All** | Everything at once, built-ins first. |

Combinations that cannot match say so rather than showing an empty list: Anthropic has no free tier,
because those models bill to your own key, and the picker tells you to look under OpenRouter instead.

Within a provider the picker splits **free from paid** rather than interleaving them, and sorts newest
first by release date. The search box reads intent out of what you type:

| You type | What it does |
|---|---|
| `free claude` | free tier, Anthropic only |
| `>200k` | context window of at least 200,000 |
| `<$1` | at most $1 per million input tokens |
| `free gemini flash` | free tier, Google, matching "flash" |

Only the leftover words become a text search, so the filters and the words cooperate instead of
fighting each other.

### Auto

**Auto** at the top of the picker is OpenRouter's own free router,
[`openrouter/free`](https://openrouter.ai/openrouter/free). OpenRouter chooses a free model for each
message from the ones that are up right now and that support what the message needs — tool calling,
and reading images when one is attached — so there is nothing to toggle. It needs an OpenRouter key;
with none usable (or every one rate limited) the turn stops and says so rather than falling back to a
paid model.

---

## Languages

**Settings → Languages** switches the whole interface, and the choice follows your account onto every
device. English and Vietnamese are complete — every label, hint, placeholder, tooltip, notification,
and the sentences the server itself writes (errors, status lines while a turn runs, why an action
needs approval, connector help).

Two tests keep it that way. `test/i18n.test.mjs` walks `index.html` and fails on any visible text,
placeholder, title, aria-label or alt that no `data-i18n*` attribute covers, and on a key used by any
module but missing from either dictionary. `test/server-i18n.test.mjs` reads every sentence out of
the server's source (`scripts/server-messages.js`) and fails on one with no entry in
`server/i18n/vi.js`, or a translation that drops a value.

The server translates at the points a sentence leaves it — the `error` of every JSON response, the
events of the agent stream, a few help-text payloads — using the `X-Language` header the browser
sends. Text the server did not write, such as a provider's own error or a file name, is passed through
unchanged.

---

## The browser sandbox

Ask for a YouTube video and you get one: the assistant opens a real browser, and a panel in the app
mirrors it live while it works. What you see is not a rendering of what it *says* it did — it is a
screenshot of the page it is acting on.

It steers by **element reference, not pixels**. Before every action it takes a numbered snapshot of
everything on screen, and clicks "7" rather than a coordinate. Text models read a list far better than
they read positions out of an image, and a page that shifts underneath breaks a coordinate but not a
reference.

```
browser_open   open a page                 browser_scroll  only what is on screen is listed
browser_look   re-read it, numbered        browser_wait    let a video play while you watch
browser_click  click element [7]           browser_close   shut it down
browser_type   type into element [3]
```

**It uses a browser you already have.** `playwright-core` drives installed Chrome or Edge, so there is
no 400MB download. Set `BROWSER_HEADLESS=false` if you want the window on your desktop as well as in
the app.

**Frames come from Chrome's compositor, not a screenshot loop.** The sandbox subscribes to Chrome's
own screencast, so frames arrive when the page actually repaints — measured at 34–48 fps on a
continuously animating page, against about 2 for a screenshot timer, and costing nothing at all while
the page sits still. `SCREEN_EVERY_NTH` (default 1) trades smoothness for bandwidth.

### It works on the computer you are sitting at

With a laptop and a desktop both paired and both online, the assistant used to act on whichever had
checked in most recently — so you would sit at the laptop, say "open that file", and watch nothing
happen because it opened on the machine at home.

The worker answers one question on `127.0.0.1:8765`: *which computer is this?* A browser cannot know
what machine it is running on, but it can ask loopback, and the only thing answering there is a
worker on that very machine. The page passes the answer along with each message.

Three constraints on that endpoint, each closing a hole:

- **Bound to `127.0.0.1`**, not `0.0.0.0` — nothing else on the network can ask, which matters on
  cafe wifi.
- **It cannot be told to do anything.** One route, GET only, returning an identifier. There is no
  verb there to abuse.
- **CORS names exactly one origin**: the deployment that worker answers to, matched in full rather
  than by prefix. With `*`, every site you visit could quietly learn that you run Synapsez and what
  your machine is called.

Order of precedence when choosing a machine:

1. **One you pinned** with *Work on this one* — an explicit choice is not something software may
   quietly override, and "always use the one at home" is a real thing to want. *Follow me instead*
   clears it.
2. **The computer this browser is on.**
3. **Whichever answered most recently** — the old behaviour.

If the worker is not running, the port is taken, or the browser refuses the request, nothing breaks:
no hint is sent and the old behaviour stands. `WORKER_LOCAL_PORT=false` turns the endpoint off.

### Starting at login

`node scripts/autostart.js --install` — done for you by the one-line setup. The worker starts when
you log in, with no window, so the computer is simply there rather than there until the next reboot.

On Windows it is a per-user `Run` entry, **not** a scheduled task and **not** a service. A service
runs in session 0, which has no desktop for the `desktop_*` tools to act on; and
`schtasks /SC ONLOGON` fails with "Access is denied" for an ordinary account, which is fatal for a
setup line a stranger is asked to paste. The `Run` entry needs no elevation and shows up in Task
Manager → Startup, where somebody who has forgotten what it is can switch it off.

`--uninstall` removes it, `--status` says whether it is there. macOS (LaunchAgent) and Linux (systemd
user unit) are implemented but **have not been run** — there is no Mac or Linux box here to try them
on, and a tick for a code path that never executed would be worth less than this sentence.

Only one worker runs per computer. The second one exits with an explanation rather than quietly
fighting the first over the same browser and the same job queue.

### Watching it work

A run of browser or desktop actions is drawn as **one card, not one card per call** — "Used the
browser · 8 steps" — with each step as a sentence rather than a tool name: *Opened vercel.com*,
*Clicked Deploy*, *Waited 3 seconds*. Each carries a thumbnail of what the screen looked like when it
finished, so scrolling back through yesterday's session shows the pictures and not just the prose.

The run stays open while it is working and collapses when it ends. Prose between two runs splits
them, because that is the assistant stopping to say something — a real boundary between two pieces of
work, and folding across it would claim a structure the turn does not have.

Thumbnails are stored as attachments and referenced by id, never inlined into the transcript: a long
browsing session would otherwise put megabytes of base64 into a conversation that gets read back on
every load.

Desktop steps carry a picture as well, and it is the **live camera frame** rather than a capture of
its own — about 61KB against the browser's 4KB. That is a measurement, not an oversight: starting the
desktop capture host for a one-off shot takes **1516ms** on Windows, and paying that on every action
somebody is watching is a worse trade than 57KB.

### The sandbox is not your browser

Two different browsers, and confusing them is the single easiest way to be surprised by this app:

| | `browser_*` — the sandbox | `open_url` — your browser |
|---|---|---|
| Whose window | The assistant's own, launched fresh | Your real Chrome, with your logins and tabs |
| Can it read the page | Yes | No |
| Can it click and type | Yes | No |
| Can it close the page | Yes | **No** |
| Mirrored in the panel | Yes | No |

So "close the browser" only ever closes the sandbox. If the assistant handed a page to *your* Chrome
with `open_url`, that tab is yours — it will say so rather than pretending, and can offer to close
the window with the desktop tools instead.

The panel labels every frame **sandbox** or **desktop**, and the ✕ beside that label closes the
sandbox immediately without waiting for a turn.

### Tabs, and not destroying what you were doing

The sandbox has real tabs. `browser_open` with `new_tab: true` leaves the current one alone, and
`browser_tabs` / `browser_switch` / `browser_close_tab` move between them.

This exists because of a specific failure: asking for a news site while music was playing used to
navigate the only tab there was, killing the audio. The assistant is told to open a new tab whenever
the current one holds something worth keeping.

It is also told to **work the site rather than the URL bar** — go to the page, type in its search
box, click the result — instead of assembling query-string URLs to skip the steps you are watching.

### You can take the controls

The ✕ in the panel closes the sandbox. The **🖰** button next to it hands you the mouse: click, scroll
and type straight into the mirrored page. Coordinates are sent as fractions of the frame, so a phone
showing a scaled-down mirror still lands where you tapped.

Off until you press it, because a stray click while reading should not land in a page the assistant
is midway through using. The panel outlines itself in green while you hold the controls.

Local runs only — routing every click through the job queue would take about a second each, which is
a telegram rather than a pointer.

### Sound, and where it comes out

The sandbox runs **headed and unmuted by default**, because headless Chrome is silent: it has no
audio output device, so a video "playing" in it is a series of frames and nothing else.

Two flags make a clicked video actually play:

- `BROWSER_HEADLESS=false` *(the default; a local `npm start` writes it)* — a real window, and
  therefore a real audio device.
- `--autoplay-policy=no-user-gesture-required` — Chrome does not count an automation click as a user
  gesture, so without this a clicked video sits on its first frame.

> **The sound comes out of the speakers of the machine running the worker.** It does not travel to
> the browser tab you are watching from — the mirror is JPEG frames and carries no audio track.
> Sitting at that machine, you hear it. Watching from a phone, you will not. Streaming audio to a
> remote viewer needs a WebRTC pipeline, which is not implemented.

**The window is parked off the edge of the desktop**, at coordinates no monitor covers — measured at
`-1680,0` against a desktop starting at `0,0`. It has to exist for there to be an audio device and a
compositor, but it does not have to be in your way, steal focus, or be closeable by accident. That
last one was a real failure: closing it by hand made every following tool call report "no page is
open". Chrome is launched with backgrounding and timer throttling disabled so an unwatched window
still renders at full rate.

Set `BROWSER_SHOW=true` to put it back on screen, `BROWSER_MUTE=true` for silence, or
`BROWSER_HEADLESS=true` for no window at all — and no sound.

### One browser per conversation

Each conversation gets its own `BrowserContext` — its own cookies, its own
`localStorage`, its own tabs. Two conversations running at once no longer share a
sign-in, and closing the browser in one leaves the other alone.

A context rather than a whole Chrome per conversation: roughly 20–50MB against
~250MB, so five conversations cost about 150MB instead of over a gigabyte. What
is given up is crash isolation, not session isolation. At most six are held at
once, and one nobody has touched for ten minutes closes on its own —
`BROWSER_MAX_SESSIONS` and `BROWSER_IDLE_MS` change both.

Sub-agents run without a conversation of their own, so they share one bucket
rather than each opening a browser.

**The browser is always a clean sandbox**, launched from the Chrome or Edge
already installed — no 400MB download, and nothing of yours in it. Two other
modes exist in the worker and are reachable only by setting `BROWSER_MODE` on
that machine: `profile` keeps a signed-in profile of its own, and `attach`
drives a Chrome you started with `--remote-debugging-port`. Neither is offered in
Settings, and neither is split per conversation — each wraps one real identity,
so there is nothing there to split.

### Watching it work

A run of browser or desktop actions is drawn as **one card, not one card per call** — "Used the
browser · 8 steps" — with each step as a sentence rather than a tool name: *Opened vercel.com*,
*Clicked Deploy*, *Waited 3 seconds*. Each carries a thumbnail of what the screen looked like when it
finished, so scrolling back through yesterday's session shows the pictures and not just the prose.

The run stays open while it is working and collapses when it ends. Prose between two runs splits
them, because that is the assistant stopping to say something — a real boundary between two pieces of
work, and folding across it would claim a structure the turn does not have.

Thumbnails are stored as attachments and referenced by id, never inlined into the transcript: a long
browsing session would otherwise put megabytes of base64 into a conversation that gets read back on
every load.

Desktop steps carry a picture as well, and it is the **live camera frame** rather than a capture of
its own — about 61KB against the browser's 4KB. That is a measurement, not an oversight: starting the
desktop capture host for a one-off shot takes **1516ms** on Windows, and paying that on every action
somebody is watching is a worse trade than 57KB.

### The sandbox is not your browser

Two different browsers, and confusing them is the single easiest way to be surprised by this app:

| | `browser_*` — the sandbox | `open_url` — your browser |
|---|---|---|
| Whose window | The assistant's own, launched fresh | Your real Chrome, with your logins and tabs |
| Can it read the page | Yes | No |
| Can it click and type | Yes | No |
| Can it close the page | Yes | **No** |
| Mirrored in the panel | Yes | No |

So "close the browser" only ever closes the sandbox. If the assistant handed a page to *your* Chrome
with `open_url`, that tab is yours — it will say so rather than pretending, and can offer to close
the window with the desktop tools instead.

The panel labels every frame **sandbox** or **desktop**, and the ✕ beside that label closes the
sandbox immediately without waiting for a turn.

### Tabs, and not destroying what you were doing

The sandbox has real tabs. `browser_open` with `new_tab: true` leaves the current one alone, and
`browser_tabs` / `browser_switch` / `browser_close_tab` move between them.

This exists because of a specific failure: asking for a news site while music was playing used to
navigate the only tab there was, killing the audio. The assistant is told to open a new tab whenever
the current one holds something worth keeping.

It is also told to **work the site rather than the URL bar** — go to the page, type in its search
box, click the result — instead of assembling query-string URLs to skip the steps you are watching.

### You can take the controls

The ✕ in the panel closes the sandbox. The **🖰** button next to it hands you the mouse: click, scroll
and type straight into the mirrored page. Coordinates are sent as fractions of the frame, so a phone
showing a scaled-down mirror still lands where you tapped.

Off until you press it, because a stray click while reading should not land in a page the assistant
is midway through using. The panel outlines itself in green while you hold the controls.

Local runs only — routing every click through the job queue would take about a second each, which is
a telegram rather than a pointer.

### Sound, and where it comes out

The sandbox runs **headed and unmuted by default**, because headless Chrome is silent: it has no
audio output device, so a video "playing" in it is a series of frames and nothing else.

Two flags make a clicked video actually play:

- `BROWSER_HEADLESS=false` *(the default; a local `npm start` writes it)* — a real window, and
  therefore a real audio device.
- `--autoplay-policy=no-user-gesture-required` — Chrome does not count an automation click as a user
  gesture, so without this a clicked video sits on its first frame.

> **The sound comes out of the speakers of the machine running the worker.** It does not travel to
> the browser tab you are watching from — the mirror is JPEG frames and carries no audio track.
> Sitting at that machine, you hear it. Watching from a phone, you will not. Streaming audio to a
> remote viewer needs a WebRTC pipeline, which is not implemented.

**The window is parked off the edge of the desktop**, at coordinates no monitor covers — measured at
`-1680,0` against a desktop starting at `0,0`. It has to exist for there to be an audio device and a
compositor, but it does not have to be in your way, steal focus, or be closeable by accident. That
last one was a real failure: closing it by hand made every following tool call report "no page is
open". Chrome is launched with backgrounding and timer throttling disabled so an unwatched window
still renders at full rate.

Set `BROWSER_SHOW=true` to put it back on screen, `BROWSER_MUTE=true` for silence, or
`BROWSER_HEADLESS=true` for no window at all — and no sound.


---

## Desktop control

The browser sandbox is contained. This is not: the `desktop_*` tools drive **real applications on
your machine** — the same mouse and keyboard you are using.

```
desktop_windows  list what is open          desktop_type    type into control [3]
desktop_launch   start a program            desktop_key     ctrl+s, alt+f4, f5
desktop_look     read a window, numbered    desktop_scroll  scroll the window
desktop_focus    bring one to the front     desktop_wait    let something finish
desktop_click    press control [7]          desktop_close   close a window
```

**Off unless you turn it on.** Set `DESKTOP_ACCESS=true` on the machine running the worker. While it
is off the tools are not merely refused — they are never shown to the model at all, and a model
cannot decide to reach for a tool it cannot see.

**It reads the screen through the accessibility layer** the operating system already exposes for
screen readers. That is the same trick as the browser sandbox: the assistant gets a numbered list of
real controls and presses number 7, rather than guessing where a button sits in a screenshot.
Coordinates exist as a fallback for controls that expose nothing.

Each platform gives up a different amount, and the tools say which rather than failing quietly:

| | Setup | Numbered controls |
|---|---|---|
| **Windows** | nothing — UI Automation is built in | yes |
| **macOS** | grant Accessibility rights once, to the terminal running the worker: System Settings → Privacy & Security → Accessibility | yes, through System Events |
| **Linux / X11** | `sudo apt install xdotool wmctrl` | **no** — X11 has no element tree without AT-SPI, so work by coordinate and keyboard shortcut |
| **Linux / Wayland** | `ydotool`, with access to `/dev/uinput` | no — Wayland deliberately stops one program driving another |

The mirror needs a screenshot program too: `screencapture` on macOS (built in, may want Screen
Recording permission), and `grim`, `maim`, `scrot` or ImageMagick on Linux.

**Numbers belong to the window they came from.** Acting on a stale number is not a harmless miss —
index 22 in a different application is a real control that will really be pressed — so the host
refuses a number whose window has changed rather than guessing. This was found the hard way: an early
version silently switched a tab in an unrelated Notepad window.

**Nothing here needs installing.** No native module, no compiler, no extra dependency — UI Automation,
SendInput and System.Drawing all ship with Windows. The host is one long-lived PowerShell process
speaking JSON lines, because spawning `powershell.exe` per action costs ~700ms of assembly loading
every time.

Every action still goes through the approval prompt under the default `ask` policy, and the
`readonly` policy leaves only `desktop_look` and `desktop_windows`.

---

## The live screen

One panel, two possible sources — the browser sandbox or the desktop — and whichever the assistant is
working in claims it, so there are never two capture loops running.

Frames are **pushed over an event stream**, not polled. The old path sent every frame through the
database and had the browser ask for one twice a second, which put a write and a read on the critical
path of something that should be a pipe. Polling remains as a fallback for serverless, where a
held-open connection per viewer is exactly what you cannot have and the frame may have been captured
by a different instance entirely.

**Capture stops when nobody is looking.** Watching is what tells the worker to keep going; close the
panel or hide the tab and the machine stops being read. On the desktop side an unchanged screen is
detected and not re-sent, so an idle machine costs nothing.

The desktop mirror draws the **mouse cursor** back in — `CopyFromScreen` composites the desktop
without it, and a mirror where things get clicked by nothing does not read as someone using a
machine.

| | measured |
|---|---|
| Desktop capture pipeline | 24ms grab + 6ms scale + 5ms encode at 1280×800 |
| Desktop mirror, screen changing | ~7.5 fps sustained, ~85KB per frame |
| Desktop mirror, screen static | no frames at all until something changes |
| Browser sandbox, page animating | 34–48 fps, ~10KB per frame |

`SCREEN_WIDTH` (default 1280) is the biggest lever on both bandwidth and rate; `SCREEN_FPS`
(default 10) caps the desktop mirror; `SCREEN_QUALITY` sets JPEG quality — default 55 for the desktop mirror
and a still screenshot, 58 for the browser's live view.

---

## Projects

**Projects** in the sidebar. A project is a name, standing **instructions**, a shelf of **sources**,
and its own conversations — and inside one, the assistant answers *from the documents* rather than
from what it half-remembers.

| | |
|---|---|
| **Instructions** | Carried into every conversation in the project. Who you are, what the job is, how answers should read. Nothing gets re-explained on Monday. |
| **Sources** | PDFs, Word, Excel, PowerPoint, text and code. Read at the moment you add them and kept as text, so any model can use them — not only the two that take a PDF on the wire. |
| **Conversations** | Started inside the project, and they stay in it. The header names the project so you can see an answer is grounded. |

**Answers only from the sources** is the default, and it is the point. Every claim has to name the
file it came from, quoted where the wording matters. When the sources do not cover the question, *"the
sources here do not cover that"* is the correct answer and the assistant is told so in as many
words — a plausible guess dressed as an answer is the one thing a project exists to prevent. The
other setting, *sources first then general knowledge*, is there for the research kind of project, and
it still asks for filenames.

> **This is a prompt, not a cage.** No arrangement of words makes a language model incapable of
> inventing. What it can do is remove every excuse: put the relevant text in front of the model,
> require a filename beside each claim, and make "not in the sources" an explicitly correct answer
> rather than a failure to avoid. A model given all three invents far less than one given a question
> and an instruction to be careful. Check anything that matters, in the source it names.

**A shelf that fits is sent whole** — the budget is generous for exactly this reason, because
everything is more accurate than an excerpt. Past it, the passages that match your question are
selected and put back in document order with `[…]` marking what was left out, and the assistant is
told not to read across a gap as though it were continuous. The search is plain term matching with an
inverse-document-frequency weight: no embeddings, so no second API key, no vector column, and nothing
to re-index when a file changes.

**A picture cannot be a source.** It is refused when you add it, with the reason — a source is
something that can be quoted, and a file that sits in the list looking like knowledge while never
being consulted is the worst outcome available. The same goes for a scanned PDF with no text layer:
refused at the moment of upload, rather than silently contributing nothing. Send those in a message
instead, where a model that can see will look at them.

**Deleting a project keeps its conversations.** They are a record of work, and they simply stop
belonging to a project. Nothing said is ever deleted by tidying a folder.

### One project, opened

Every way into a project — the shelf, the breadcrumb beside a conversation's title, the moment you
finish naming a new one — lands on the same page. The left column is the work: a composer that says
*"How can I help you today?"*, and under it the conversations this project has already produced,
each showing when it was last spoken in. Nothing is created until you send something; the
conversation comes into existence at its first message, carrying the project with it.

The right column is what the work reads from, and what it has produced.

| | |
|---|---|
| **Instructions** | The standing instructions, edited in place. |
| **Memory** | What the assistant has learned. A note picked up inside a project is filed **under that project** and read back only by its conversations; the account's own notes apply everywhere, including here, and each row says which it is. A project is exactly the scale at which a preference means something — "cite the article number" is true of a law project and false of the deck beside it — and pooled into one account-wide list those contradict each other. Where a name exists in both, the project's wins: the narrower context is the more specific instruction. |
| **Output** | Everything made in this project's conversations, newest first. Pressing one opens it in the same panel a file card in a transcript opens. The shelf used to list what was put *in* and nothing of what came out, so a report written last Tuesday lived only in the transcript that wrote it — and the account-wide Artifacts page is the wrong grain, being every project's output at once. |
| **Context** | The sources. `+` offers **Upload from device** and **Add text content**, and files can be dropped straight onto the dashed area. Half of what belongs on a shelf was never a file — a brief from an email, notes from a call — so pasting one in is a first-class way to add it. |

> Claude's version of that menu also offers GitHub and Google Drive. Neither exists here, and a menu
> entry that opens an apology is worse than no entry, so the list is the two things that work.

### Pinning, archiving, and the ⋮

Hover a project card and a **⋮** appears — invisible until then, because a menu button on every card
is furniture on a shelf whose whole job is to be scanned. The same four actions are on the project
page's own header, so the two never drift apart.

| | |
|---|---|
| **Pin** | First place on the shelf, whatever the ordering — including by name. A pin is a statement about the shelf, not about one way of reading it. |
| **Edit details** | Name and standing instructions, the same two fields creating one asks for. |
| **Archive** | Off this shelf and onto the archived one, with everything still in it. Choose **Archived** from the sort pill to see it; **Restore** brings it back. Archived projects are never mixed into the main list — that is the entire point of archiving one. |
| **Delete** | Permanent, set apart from the rest, and it asks. The sources go; the conversations stay. |

> This slot used to be the model library. The model picker is one press away on the header chip, so
> the sidebar goes to the thing you come back to across days.

---

## Photos and files

Attach with the `+` beside the composer, by pasting a screenshot straight into the box, or by
dropping files anywhere on the window. Previews appear above the composer; each can be removed before
you send, and a file with no caption is a perfectly good message — *"what is this?"* is implied.

Four kinds, because four is what the model layer can genuinely do something with. Pretending
otherwise produces the worst failure available: a file that uploads, appears in the bubble, and is
never actually looked at.

| | | |
|---|---|---|
| **Images** | png · jpeg · webp · gif | Native — on models that can see. About half the catalogue cannot; the picker marks the ones that can. |
| **Text and code** | md · csv · json · logs · source | Inlined into the prompt, so it works on every model, vision or not. |
| **PDF** | | Handed over whole to Claude and Gemini, which read the layout, the tables and the pictures. The OpenAI wire format — every model reached through OpenRouter, so most of the library — has no document part at all, so the **text is extracted and inlined** instead. Worse than being shown the page; enormously better than "I cannot read PDFs". |
| **Office** | docx · xlsx · pptx | Read here and inlined as text — headings and formatting from Word, sheets as tables with their dates and numbers intact, slides as bullets with their speaker notes. **No provider anywhere accepts one of these as a file**, so this is not a fallback; it is the only way in. |

A PDF with no text in it — a scan, or photographs of pages — has nothing to extract, and the
assistant is told exactly that rather than being handed an empty document: *"say so, and suggest a
model that can look at the pages themselves."* Extraction is Firefox's PDF engine (`pdfjs-dist`),
loaded only when a document actually needs reading, and the result is cached per attachment because
a conversation is re-read on every step and parsing the same file forty times to send the same
characters is pure cost.

A document **linked on a page** goes through the same two readers: `web_fetch` on a URL ending in a
PDF, `.docx`, `.xlsx`, `.xls`, `.ods` or `.pptx` opens it and returns its text, rather than the bytes
decoded as if they were prose. So a past exam paper or an annual report published as a PDF can be
quoted directly, and the tool says plainly when what came back is a picture rather than pasting it in.

Office documents are read by a reader written for this project — no dependency, and the same code
draws the preview. That last part is deliberate: **what you see and what the assistant answered from
are the same reading**, so the two cannot quietly disagree. A preview generated some other way would
eventually differ, and the difference would surface as the assistant appearing to lie about a
document open on your screen.

Spreadsheets have a second reader behind the first: **every Excel form people send** — `.xlsx`,
`.xlsm`, templates, the old `.xls`, `.xlsb`, OpenDocument `.ods`, an "Excel" export that is really an
HTML table — is read. Anything the reader here cannot open goes to [SheetJS](https://sheetjs.com)
(`server/office/sheets.js`), on a worker thread with a deadline and a heap of its own, and comes back
in the same shape, so the preview and the assistant still see the same thing. A formula whose result
was never saved shows as the formula.

The old binary `.doc` and `.ppt` are refused by name, with the fix attached: open it and *Save As* the
modern one. A password-protected file says that it is password-protected — and the assistant is told
to ask for the password to come off — rather than "unsupported".

Anything else is refused by name at the moment you pick it. Six files per message, 5MB each.

**Every stored file opens.** Press the chip in a message — or the file card under an assistant turn —
and the viewer shows what it actually is:

| | |
|---|---|
| **Word** | As a page: headings, bold and italic, links, bulleted and numbered lists at their real depth, tables. |
| **Excel** | As a grid, with column letters and row numbers frozen where they belong, numbers aligned as numbers, and a tab per sheet. |
| **PowerPoint** | As slides in the deck's own order, bullets at their indent level, speaker notes underneath. |
| **PDF** | In your browser's own reader — better than anything this could build. A **Text** tab is one press away for the phone that will not render one inline, and for a scan, where "there are no words in this" is the answer. |
| **Text, Markdown, CSV** | Rendered, tabulated, or shown as source. An uploaded `.html` is shown as source and never rendered — see **Security**. |

**Print** is in the corner of the viewer, and it is also how you get a PDF: it prints the document
rather than the application around it, through your browser's own print dialog. There is no PDF
*writer* on the server, and that is a decision rather than an omission — one that got Vietnamese
right would need a Unicode font embedded in the deployment, and a document with □□□ where the
diacritics were is worse than no document at all. Your browser already has the fonts.

> **Not every model can be shown a picture**, and getting this wrong is not a
> worse answer — the provider rejects the whole request. On OpenRouter that comes
> back as a bare `404`, which reached one user as "not found" with nothing to
> connect it to the screenshot they had just pasted. So the capability is
> recorded when the library refreshes: the picker tags models that **see
> images**, the composer says so before you send, and if you send anyway the
> image is left out and the assistant is told why — which it can pass on.

The bytes live in their own table, not in the message. A conversation is re-read on every step of
every turn and searched as text, and a few screenshots inlined there would make both of those move
megabytes to answer questions that never needed them. The message keeps a list of ids; the browser
fetches a thumbnail, the provider layer fetches the data when it builds a request — and only for the
**eight most recent** attachments, because re-sending every screenshot from an hour ago on every turn
would quietly eat the context window. Older ones become a line naming the file, so the model knows it
existed and can ask.

---

## Documents it writes

Ask for a quotation, a report, a plan, a table of figures or a deck, and the assistant makes the
file. It appears as a card in the conversation — open it, download it, or ask for a change.

```
create_file  name: "Bao gia thang 8"  format: "docx"  content: "# Báo giá\n\n…"
update_file  file_id: "…"             content: "the complete new document"
```

| | |
|---|---|
| **Word** | `.docx` — headings, bold, italic, links, nested lists, tables, block quotes, code, page breaks. A4, with a stylesheet written into the file so it reads the same on every machine rather than picking up whatever that installation's Normal template says. |
| **Excel** | `.xlsx` — real numeric cells, so a column can be summed; real dates, so they sort; a frozen, filtered header row; column widths that fit what is in them. A table pasted in as text looks identical and is useless the moment anybody clicks AutoSum. |
| **PowerPoint** | `.pptx` — 16:9, one slide per heading, bullets at their indent level, speaker notes from block quotes. |
| **The plain ones** | `.md`, `.txt`, `.csv` (with a byte-order mark, so Excel reads UTF-8 rather than mojibake), `.html` (self-contained and styled, ready to print), `.json` (reformatted, which also validates it). |

**Everything is written in Markdown**, whatever comes out the other end. That is the one decision the
rest follows from: it is what a language model writes best, you can read the source, and one
converter feeds all four formats. A heading is a heading in Word, a sheet name in Excel and a slide
in PowerPoint. For a spreadsheet you can also hand it JSON —
`{"sheets":[{"name":…,"rows":[[…]]}]}` — or plain CSV, because a model asked for a table may
reasonably write any of the three, and two of them being a mistake nobody explained is not a design.

**A change is a change, not a second file.** `update_file` rewrites the same document, keeping its id
and its place in the conversation, and the viewer shows the new version. The Markdown each file was
built from is stored beside it, which is what makes "change the last row" possible at all: the edit
starts from the words rather than from a parsed approximation of them. You can read that source
yourself — the **Source** tab in the viewer.

> `create_file` puts a file in the conversation. `write_file` puts one on your disk. They are
> different requests, and the assistant is told to say plainly which one it did.

**No PDF writer**, for the reason in the previous chapter: make it a `.docx` or `.html` and use Print →
Save as PDF from the viewer. Also not attempted, and said plainly rather than half-done: images
inside generated documents, charts, headers and footers, and any layout beyond what Markdown
expresses.

---

## The workspace, from the interface

**Projects**, **Artifacts** and **Scheduled** are pages rather than dialogs: a shelf is somewhere
you go, and a sheet floating over the transcript is the wrong shape for that. One shell draws all
three, because the header is the same on each — a title, a way to search, a way to order, and the
one button that makes a new thing.

The magnifier in that header *becomes* the field rather than sitting beside it: a round icon with
nothing left to do next to a box that reads as a second, different search is one affordance too
many. Clearing it, or pressing Escape, gives the magnifier back and puts the shelf as it was.

**Workspace** in the menu bar opens the folder the assistant works in — on the machine running the
worker, which may be the one you are sitting at or one three countries away. Click into folders,
open a file, change it, press Save. New file makes one, and the ✕ on a row deletes it after a second
press.

The assistant has been able to do all of this since the beginning. What was missing was the person
in front of it being able to, without asking in prose and waiting a turn.

> **It is the same door.** Every one of these routes runs a worker tool — the same ones the
> assistant calls — so the workspace confinement, the symlink resolution and the per-account queue
> scoping are inherited rather than reimplemented. There is no second path to anybody's disk, which
> is the only way to be sure the second one is not weaker. A path that climbs out with `..`, an
> absolute path to somewhere else, another account asking for your machine: all refused, and
> [covered by tests](test/workspace.test.mjs).

What it deliberately does not do: move, rename, or search across files. The assistant does those
A file can be renamed or moved from the same row — one control, because they are one operation:
the path is handed to you as it stands, and changing the last segment renames while changing
anything before it moves. It refuses to overwrite unless told to, works across drives, and allows a
case-only rename, which Windows and macOS otherwise make impossible by reporting the file as
already existing at its own new name.

**Search** across the files is in the header. Plain text, not a pattern — somebody typing `a.b`
means those three characters — grouped by the file each hit is in, with line numbers that open the
file where the match is. A real regular expression is one line away in the chat, where `grep` lives.

Two things are refused rather than half-done. A **binary file** is not opened for editing — showing
mojibake somebody might then save over the original is worse than saying no. And the **workspace
root itself** cannot be deleted, because every other path resolves against it.

`delete_file` is new, and the assistant has it too: deleting used to mean `run_command` with `rm` or
`del`, which is a shell invocation graded by a pattern list and spelled differently on every
platform. As a named tool it is checked like every other file operation, says exactly what it
removed, and is classified as always worth stopping for — the one thing that cannot be undone gets
the one prompt nobody skips.

---

## Artifacts — things that run

`create_file` with `format: "html"` and real markup makes something you can **run** in the
conversation: a calculator, a chart, a small tool, a mock-up of a page. It opens running, with its
code one press away, and **Artifacts** in the menu bar is every one ever made — across every
conversation, because a week later the file is what you remember and the chat it came from is not.

| | |
|---|---|
| **Runs** | `.html` with markup in it. One self-contained page: inline styles and script, nothing fetched. |
| **Reads as source** | `.js`, `.ts`, `.py`, `.sql`, `.css`, `.sh` and the rest — stored exactly as written. |
| **Still a document** | `.html` with *Markdown* in it becomes a styled article instead, so both readings of "make me a web page" work. |
| **Editable** | The Code tab is a text box with a Save button. Saving rebuilds the file — the same operation the assistant performs, reachable without asking for it in prose and waiting a turn. |

> **The security model is one missing word.** An artifact is served under
> `Content-Security-Policy: sandbox allow-scripts` — and deliberately **not** `allow-same-origin`.
> That puts the page in an opaque origin: it cannot read this app's cookies or storage, cannot call
> the API as you, and cannot reach the network at all. It computes and it draws. Everything else —
> `connect-src 'none'`, the `sandbox` attribute on the frame, running only files the assistant
> wrote and never an uploaded page — is belt and braces on top of that one omission.

Not attempted, and said plainly: React and anything else that needs a build step, npm packages, and
network calls from inside an artifact. What runs is what one file of HTML, CSS and JavaScript can do.

---

## The file panel

Press any file — a document the assistant made, a photo you sent, a spreadsheet, a deck, a PDF, a
page that runs — and it opens **beside the conversation**, in the same right-hand rail the plan and
the sandbox use. Not over it. A document is something you read *while* you keep talking about it:
quote a line back, ask for one number changed, look again. A sheet covering the transcript made
every one of those start with closing it.

`⤢` gives it the whole window and `Esc` gives it back. On a narrow screen it takes the screen,
because there is no second column to be beside.

### It opens itself

A document the assistant makes appears there without being asked for. The reason to ask for a
report is to read it, and the card in the transcript is one more press between the two.

Doing that naively is worse than not doing it, so the restraint is the feature:

| | |
|---|---|
| **Once per turn** | Closing it means closed, exactly like the plan panel. One that reappears every time the assistant saves is a fight, not a convenience. |
| **The last file, not the first** | A turn that writes a `.docx` and then an `.html` preview of it lands on the `.html`, rather than flickering through both. |
| **A rewrite refreshes, never pops** | `update_file` on the document already open is the same thing changed, so the panel re-reads it in place — keeping your tab and your place. That happens whatever the setting says: showing a stale rendering of a file that just changed is the one thing this panel exists to prevent. |
| **Never over what you were reading** | If you opened something yourself, it stays. Taking that away to show you something you have not asked about yet is the difference between helpful and rude. |
| **Never on a narrow screen** | Below 900px the panel *is* the window, and burying the conversation mid-turn is an interruption, not a preview. |
| **Never while an approval waits** | That prompt is the thing to read. |

**Settings → New documents** turns it off entirely.

> The rules live in one function with no DOM in it
> ([`autopreview.js`](public/js/autopreview.js)), which returns *why* as well as *whether* — "it did
> not open" is a support question, "it did not open because you closed it earlier this turn" is an
> answer. Each rule has its own case in [the tests](test/autopreview.test.mjs).

| | |
|---|---|
| **Word, Excel, PowerPoint** | Drawn from the *same reading the model was given* — so what you are looking at and what the assistant answered from cannot quietly disagree. A preview generated some other way would eventually differ, and the difference would surface as the assistant "lying" about a document open on the screen. |
| **Figures** | Pictures are read out of the document with their bytes and drawn where they belong, captions and all. Both markups — the modern `w:drawing` and the Word 97 `w:pict` still emitted by anything that has been through an old version — because a reader that knows only one shows a blank where half the world's figures are. A picture used twenty times is stored once. |
| **PDF** | In a frame, because every browser already has a better PDF viewer than this could be. The extracted text is one press away for the phone that will not render one inline, and for a scan that has no text at all — where saying so is the answer. |
| **Images** | As themselves. |
| **Code and Markdown** | Rendered or as source, and editable when the assistant wrote it. |
| **A page** | Running, sandboxed, with its code behind the `</>` toggle. |

### Open in Word, and Show in folder

A file the assistant made lives on the server, not on anybody's disk — so "Open in Word" has to
mean *write it out first, then hand it to the desktop*, and that is what the button does. It lands
in one predictable tray (`%LOCALAPPDATA%\AI Remote\files`, or the platform equivalent) rather than
in your workspace: the workspace is the assistant's, and dropping files into a project directory
because somebody pressed Open would be a surprise.

The button **names the application it will really use**, read from the file association rather than
guessed from the extension — so it says "Open in Excel" only when Excel is what will open. Where
that cannot be resolved cheaply, it says "Open". With no computer connected it says **Download**,
because an Open that fails when pressed is worse than not offering one.

> **A program is never handed to the shell.** `.exe`, `.bat`, `.ps1`, `.vbs`, `.lnk`, `.js`, `.sh`
> and the rest are refused by name, with the reason. A model can be talked into writing any of them
> and Open is one click with no confirmation behind it. **Show in folder** stays available for
> everything, because revealing a file executes nothing.

> **Show in folder was opening the wrong folder.** Explorer does not parse its command line the way
> everything else does — it reads the raw string rather than going through `CommandLineToArgvW` —
> and Node quotes any argument containing a space. `/select,C:\…\AI Remote\files\x.docx` therefore
> arrived as one quoted token, the switch was never recognised, and Explorer opened its default
> location every time. It looked like the feature half working, which is why it went unnoticed;
> the giveaway was fourteen windows all sitting on Documents. Fixed with
> `windowsVerbatimArguments`, and verified by reading back the location of the window it opens.

### Copy, and Print

**Copy carries the formatting.** The clipboard holds several renderings of the
same thing at once and the application you paste into picks — so a report copied
here and pasted into Word arrives with its headings, bold runs and tables
intact, while the same press in a code editor gives plain text. A spreadsheet
becomes a real table; a picture copies as the picture.

> It used to write plain text only, which flattened every document into one grey
> wall. Worse, Office previews carried no text at all, so Copy on a `.docx`
> found nothing and said so — which reads as a broken button rather than a short
> payload.

**Print → Save as PDF** is the road to a PDF, because there is no PDF writer on
the server: one that got Vietnamese right would need a Unicode font embedded,
and a document with boxes where the diacritics were is worse than no document.
The browser already has the fonts and a good exporter behind its print dialog.

The panel moves to the top of the document tree before the dialog opens, so what
prints is the document rather than the application around it — table headers
repeat on every page, rows and figures are never sliced across the fold, and
headings do not sit alone at the bottom of one.

> **The bug that made it useless:** an expanded panel is `position: fixed` with
> `height: 100dvh`. A fixed element is pinned to the viewport, and a viewport is
> one page — so page one printed and everything after it was silently dropped.
> Every `overflow` in the chain clipped whatever was left. All of it is undone
> under `@media print`, and the test measures the panel's height against its
> contents rather than trusting the eye.

### Versions

`update_file` rewrites in place and keeps the id — a quotation with one number changed is the same
quotation, and a second nearly-identical file is how the wrong one gets sent. But rewriting in place
also *threw the previous copy away*, so "put that number back" meant asking for the whole document
again and hoping.

Every rewrite now files the outgoing copy first. The panel grows a **v1 v2 v3** strip once there is
more than one; pressing an older one shows it as it was, and **Restore this version** puts it back.
Restoring is itself a rewrite, so the copy it replaces is kept too — going back is never
destructive, in either direction.

An earlier draft is shown read-only. It is a record, not a draft.

---

## Searching the web

Four engines, tried in order, and the first one that answers wins:

| | | |
|---|---|---|
| **Exa** | `EXA_API_KEY` | Neural search — returns the passage that answers the question rather than a page that mentions the words. First for that reason. |
| **DuckDuckGo** | no key | Free, so it sits ahead of the paid fallbacks: an outage on the good engine should not start spending credits. |
| **Tavily** | `TAVILY_API_KEY` | Paid safety net. |
| **Brave** | `BRAVE_API_KEY` | Paid safety net. |

An engine with no key is skipped, so the chain is whatever you have configured plus DuckDuckGo,
which needs nothing. `SEARCH_ORDER=tavily,exa` changes the order; that is the whole configuration.

**The answer says who found it**, and what failed on the way: *"3 results from Tavily after Exa,
DuckDuckGo failed"*. A silent failover is indistinguishable from the first engine having worked,
right up until the bill or the outage says otherwise — and when an engine refuses, the reason is
quoted in its own words rather than as a status code, because *"the provided subscription token is
invalid"* names the key to replace and *"HTTP 422"* does not.

**DuckDuckGo is paced.** It has no quota; the limit is enforced by blocking the address for a while,
and an assistant running three searches at once is exactly the traffic that triggers it. Requests
queue behind each other with `DDG_MIN_INTERVAL_MS` (4 seconds by default) between them, and a
rate-limit page — which arrives as a cheerful HTTP 200 — is treated as a failure and handed to the
next engine rather than reported as "no results".

---

## More than one key per provider

**Settings → Providers.** Save a key and the button becomes **Add**: every key after the first is a
fallback. They are tried in order, and the first that is not refused answers.

Only failures that are *about the key* move to the next one — unauthorised, out of credit, rate
limited. A model that does not exist, a malformed request or a provider that is down fails the same
way on every key, and grinding through five of them turns one clear error into five slow ones.

The rotation stops the instant anything has been streamed: once you have seen half a sentence,
starting again on another key would either repeat it or silently replace it. So a failure before the
first token is retried and a failure mid-answer is reported. The key that worked is remembered, so a
dead first key costs one failed request rather than one per turn — and the failover is announced,
because a fallback nobody can see is how somebody finds out their first key died from the bill.

The key itself never comes back out. What the screen shows is a position, the last four characters
and a date, which is enough to tell one key from another and not enough to use one.

---

## The plan, and when there isn't one

For work that has real steps, the assistant puts a checklist at the top of its message and ticks it
off as it goes, so you can leave and come back and see where it got to rather than reading the whole
transcript to find out.

**It is supposed to be absent most of the time.** A checklist above a two-line answer is not a
smaller plan, it is furniture you have to read before getting what you asked for — and it makes a
question feel like a project. The rule the model is given is a countable one rather than a matter of
taste:

| | |
|---|---|
| **Plans** | three or more steps it can name up front, of different kinds — read, then change, then check; several files; several sites |
| **Does not plan** | a question, a lookup, one edit, something already in front of it |

Steps are written as outcomes in your language — "Rebuild the calibrated model", not "call
run_command" — and there are three to eight of them. Exactly one is marked in progress at a time,
and it moves as the work moves. A plan still showing step 1 while the assistant is on step 4 is
worse than no plan, because the panel is the thing you are reading to find out where it is.

Two of those rules are enforced rather than asked for, because a model will get them wrong
occasionally however clearly it is told:

- **A one-step list draws nothing.** The list is resent in full on every update, so a single step
  means the whole job was one step. The assistant is told no plan was shown and to simply answer.
- **Only one step can be in progress.** If it marks three at once, the first wins and the rest go
  back to pending, so the panel can still answer the question it exists to answer.

If the work turns out different from the plan, the list is resent with the steps that actually apply
and the assistant says what changed, rather than quietly abandoning a panel you are still watching.

---

## Long conversations

Every turn re-sends the whole transcript, so a conversation that goes well is a conversation that
eventually stops working: the prompt outgrows the model's window and the provider refuses it.

**The ring in the header says how full it is.** A shape rather than a number, because a quarter full
is obviously fine and the figure only starts mattering later — which is when it appears. Green,
then amber past two-thirds, then red. Click it for the numbers, to fold the conversation up yourself,
or to turn the automatic version off.

**Before it fills, the older turns are summarised.** Not dropped — summarised, into a message written
into the conversation, so what was decided survives even when the words do not. Two things follow
from that:

- **The transcript you read and the one the model sees are different.** The page still shows every
  turn; only what gets sent is trimmed. Scrolling back to something from an hour ago keeps working,
  and a quiet rule marks where the fold happened, with the summary itself behind it.
- **It chains.** Folding again summarises the previous summary along with everything since, so the
  cost stays flat however long the conversation runs.

The fold never lands between a tool call and its result — every provider rejects a `tool` message
whose call it cannot see, so a boundary in the wrong place turns a working conversation into a `400`.
The boundary walks backwards until it is somewhere legal, and the test suite checks every possible
split.

> How full it is comes from the provider, not a guess: every assistant turn records the prompt size
> it was actually billed for. Only the handful of messages added since the last of those is
> estimated, and the tooltip says so.

---

## Skills — teaching it a procedure

A job you do the same way every time should be explained once, not re-explained every conversation.
**Settings → Skills** takes a name, a description of *when it applies*, and the steps. The assistant
can also write one itself when you teach it something mid-conversation.

Only the **names and descriptions** reach the system prompt. Twenty skills of full instructions would
be thousands of tokens on every turn, nearly all of it irrelevant — so the model sees a menu and
reads the one it needs with `skill_read`. That is why the description matters more than the title:
it is the thing the model uses to decide.

---

## Scheduled tasks

"Summarise the campaign every Friday at five." Each run happens in **a fresh conversation you can
open afterwards** — the result waits for you with its full working visible, rather than arriving as a
notification with nothing behind it.

The clock is deliberately small: `17:00` for daily, `fri 17:00` for weekly, and a checkbox for
run-once. Cron expressions are powerful and almost nobody writes them correctly, and everything this
is for is "every day at" or "every Monday at".

**It is your clock.** The browser sends its IANA zone with the task and the schedule is stored with
it, so `17:00` means five in the afternoon where you are — not where the server is standing, which
on a deployment is UTC. Daylight saving is handled by walking the calendar rather than adding
86,400,000 milliseconds, so the hour holds across a clock change.

A local run polls for due work every minute. A deployment has no process to hold a timer, so it uses
`/api/cron/run-tasks` with `CRON_SECRET` — the claim is atomic (`FOR UPDATE SKIP LOCKED`), so two
instances cannot run the same task twice.

> [!IMPORTANT]
> Vercel's Hobby plan limits a cron to running **once a day** — the limit is frequency, not the
> number of jobs, so both crons in `vercel.json` do fire. It is enforced at deploy time: an
> expression that would run more often, like `*/15 * * * *`, is refused with *"Hobby accounts are
> limited to daily cron jobs"* and the deployment fails rather than degrades. So on Hobby the queue
> is nudged along whenever somebody opens the app (throttled, fire-and-forget), which closes most of
> the gap. On Pro, change that entry to `*/15 * * * *` — that is what the feature actually wants.
> The reasoning behind every line of `vercel.json` is in [docs/vercel-config.md](docs/vercel-config.md).

### Running on time with the app closed (free)

Hobby's once-a-day cron means a task set for 09:00 runs at 23:00 unless the app happens to be open.
The fix costs nothing and takes two minutes: a free pinger calls the heartbeat every few minutes.

1. Make an account at [cron-job.org](https://cron-job.org) (free, runs as often as every minute).
2. Create a cron job:
   - **URL:** `https://<your-deployment>/api/cron/run-tasks?background=1`
   - **Schedule:** every 5 minutes (every minute is fine too)
   - **Advanced → Headers:** `Authorization: Bearer <your CRON_SECRET>`
3. Save, then press *Test run* — the answer is `202 {"accepted":true}`.

`?background=1` answers at once and keeps working through Vercel's `waitUntil`, so the pinger's
thirty-second timeout never cuts a run off. The claims are atomic, so a ping that overlaps the last
one cannot run a task twice. Any other scheduler that can send a header works the same way.

Write the prompt as if to somebody with no memory of today, because that is exactly what it is.

---

## Sub-agents

`run_parallel` hands several **independent** questions to sub-agents that work at the same time.

Right for fan-out: read these six files, check these four sites, summarise each of these folders.
Wrong for anything sequential — sub-agents cannot see each other, which is what makes them parallel,
so a chain of steps stays in the main loop.

Two limits, both deliberate:

- **They are read-only.** Two agents editing the same file is a race with no referee, and the
  approval prompt has nowhere to appear when five things run at once. They find things out; the main
  loop decides and acts.
- **They do not nest.** A sub-agent has no `run_parallel` of its own, or one careless prompt becomes
  an exponential fan-out of API calls on your key.

---

## Connectors

**Settings → Connectors** takes a token for GitHub, Notion or Slack. Each is verified against the
service before it is stored, so a bad paste fails there rather than mid-task. Tokens are encrypted
with the same key as your provider keys and never returned to the browser.

| Service | Token from | Tools |
|---|---|---|
| **GitHub** | Settings → Developer settings → Fine-grained tokens | `github` — any REST path |
| **Notion** | notion.so/my-integrations → Internal Integration Secret | `notion_search` |
| **Slack** | api.slack.com/apps → Bot User OAuth Token | `slack_post` |

> **Google is a sign-in, not a token.** Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and
> Contacts appear once the deployment has an OAuth client (`GOOGLE_CLIENT_ID`,
> `GOOGLE_CLIENT_SECRET`); each account then ticks the products and signs in. Reads run at once,
> every write is shown first. Setup, and the 7-day expiry of an app left in Testing: [docs/google.md](docs/google.md).

Notion only sees pages explicitly shared with the integration, so an empty search often means
unshared rather than absent.

---

## Your own documents

Point it at a folder and it reads everything in there — text, Markdown, code, PDFs, and Word, Excel
and PowerPoint files — then answers
questions about it by meaning rather than by keyword. "What did we agree about the deposit" finds the
paragraph that never uses the word.

```
index_folder  path: "D:\contracts"     → reads it, once
search_docs   query: "notice period"   → the passages, with the file each came from
list_indexed                           → what is indexed, and with which model
forget_docs   source: "D:/contracts"   → forgets the index; the files are untouched
```

**What leaves the machine is the text of the passages, and only from the folder you named.** The
files stay where they are. The split is the same one the rest of the app runs on: your computer reads
and chunks, the server holds the API key and does the embedding.

Re-indexing is cheap — a file whose modification time has not moved is not read again — so pointing
it at the same folder weekly costs almost nothing.

**It needs an OpenAI or Google key.** Those are the two providers here that serve an embedding
endpoint; Anthropic has never had one and OpenRouter routes chat only. Vectors from different models
cannot be compared, so switching provider means re-indexing, and the tool says so rather than
returning quiet nonsense.

`node_modules`, `.git`, `dist` and their friends are skipped, along with anything that is not text.

---

## The quick launcher

```bash
npm run launcher
```

Press **Ctrl+Shift+Space** anywhere on the desktop and a single box appears. Type, press Enter, and
the app opens with the answer already running. Esc closes it.

That is the difference between an app you have to go to and an assistant you can reach — nobody hunts
for a browser tab to ask a passing question, so passing questions never get asked.

No extra dependency and no second copy of Chromium: the window is the browser already on your machine
opened in application mode, and the hotkey is claimed through the OS.

| | |
|---|---|
| **Windows** | Works as it stands. `npm run launcher` claims the key and waits. If something already owns your combination it says so and takes the next free one. |
| **macOS** | No program can claim a global key without Accessibility rights, so bind it where macOS already offers to: Shortcuts → Run Shell Script. `npm run launcher` prints the exact command. |
| **Linux** | Bind it in your desktop's keyboard settings. `npm run launcher:install` does it for you on GNOME. |

Set `LAUNCHER_HOTKEY` in `.env` to choose your own — `ctrl+alt+shift+Space`, `ctrl+shift+J`, whatever
is free. Avoid `alt+space` combinations: input-method editors claim those, and a launcher whose key
silently does nothing is worse than one that asks.

---

## Memory, and what never goes into it

**Notes are read back at the start of every conversation.** The assistant saves a note with
`memory_write` when it learns something worth keeping — how you like answers, a fact about a project,
a decision. From the next conversation on, the notes are in its prompt: a project's notes first (they
win where they disagree), then the account's, newest first, within about 1,500 tokens. Notes past that
budget are named rather than quoted, and `memory_search` finds them by subject — the same shape as
Claude Code's MEMORY.md. They sit in the cached part of the prompt, so after the first step they cost
a tenth of their size on the providers that cache.

Inside a project, notes are filed under the project and read only there. Outside, they belong to the
account and are read everywhere.

**What is never written into a note:**

| Never, even when asked | Only if Settings → Memory allows sensitive topics |
|---|---|
| Identity, passport, tax, social-security numbers; bank account numbers and IBANs; card numbers (checked by Luhn); criminal records; immigration status | Health, religion, politics, ethnicity, sexuality |

Credentials are stripped too — API keys, `NAME=secret` assignments, passwords in URLs, bearer headers
and private keys — and the assistant is told what was removed so it can say so. The guard matches
Vietnamese with its accents on, so "đồng tình" (agree) is not mistaken for "đồng tính". It is a filter,
not a guarantee: it misses what is said obliquely. The tool descriptions carry the same rule.

**Settings → Memory & privacy** has the switches and the notes:

- **Use memory** — off means nothing is read or saved; the notes stay until deleted.
- **Remember sensitive topics** — off by default.
- **Search earlier conversations** — lets the assistant use `search_chats` to look back through what
  was said (user and assistant text only, never tool output). Inside a project it searches that
  project's conversations; outside, conversations outside projects.
- **Keep conversations** — forever, or delete conversations not continued for 30/90/180/365 days, with
  their files. Pinned conversations are always kept.
- **Provider privacy** — Strict asks OpenRouter to route only to zero-data-retention endpoints that
  neither store nor train on prompts (`provider: { data_collection: "deny", zdr: true }`). Many free
  models are not served that way and stop working while it is on; the error says so.
- Every note, grouped by where it applies, with Edit and Delete, a Delete-all, and a box to paste in
  what Claude or ChatGPT says it remembers about you.

### Incognito conversations

The mask beside the model chip, on a blank conversation outside a project, makes the next conversation
incognito. It is never listed, searched, exported or shared; it reads no notes and writes none, cannot
search earlier conversations, and cannot save a skill. The browser deletes it the moment you leave it —
another conversation, a new one, or closing the tab — and the server sweeps any that slipped through a
day after their last use.

### Your data: export, import, leave

Settings → Account → **Your data**:

- **Export my data** downloads one JSON file — profile, preferences, notes, skills, projects with their
  source text, scheduled tasks, workflows and every conversation with its messages. Streamed, so a large
  account does not hit the host's response limit. API keys, connector tokens and uploaded files' bytes
  are not in it; incognito conversations are not part of the record.
- **Import conversations** reads `conversations.json` from Claude or ChatGPT (only the branch ChatGPT
  kept, not abandoned edits) or a Synapsez export, in the browser, and sends it fifty conversations at a
  time. Only user and assistant text comes in; original dates are kept.
- **Delete account** asks for the password, and the authenticator code when two-factor is on, then
  removes everything at once. The last administrator of a shared deployment must hand over first.

### Security activity

Settings → Account lists sign-ins (and failed attempts on your account), password and two-factor
changes, keys added and removed, exports, imports, shared links and privacy changes — never what was
said. Addresses are kept only to their network (an IPv4 /24, an IPv6 /48) and the browser only by
family. Kept 180 days. Administrators see the record across accounts in Settings → People.

---

## There is one mode

Every conversation is an agent conversation. Tools are always on.

There was once a tool-free "chat" mode with a toggle next to the message box. It existed to protect
conversations from models that could not call tools — but the library now refuses to import one of
those at all, so the only thing the toggle could still do was take abilities away for no reason.
What controls how much freedom the assistant has is the **approval policy** (ask / auto-run /
read-only), which is a far more useful dial.

---

## Choosing where to run it

There is a trap worth naming early: **if you want the assistant to control your computer, your
computer has to be switched on anyway.** Once it is on, a cloud host buys you nothing for that job —
so the "unlimited and free" answer is to skip the cloud and put a tunnel in front of your own machine.

| | Free forever | Time limit per run | PC must be on | Good for |
|---|---|---|---|---|
| **PC + Cloudflare Tunnel** | yes, no card | **none** | yes | Controlling your machine from anywhere |
| **Vercel Hobby** | yes, no card | 300s per request, auto-resumed | no | Chat + web search when your PC is off |
| Render free | yes | none, but sleeps after 15 min idle and cold-starts in 30–60s | no | Tolerable if you accept the wake-up delay |
| Oracle Cloud Always Free | yes, card to sign up | none — it is a real VM | no | A permanent always-on server, more setup |
| Fly.io | no longer free for new users | — | — | — |

Free-tier terms change often. Check the provider's current limits before you rely on them.

### The unlimited path: your PC + Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/) opens an **outbound** connection
from your machine to Cloudflare and hands you a public HTTPS URL. No port forwarding, no public IP, no
time or bandwidth cap, no credit card.

```bash
npm run share             # app + tunnel, one terminal
```

It prints a `https://<random>.trycloudflare.com` URL. Open it on your phone from anywhere, sign in,
done. Add a domain to your Cloudflare account if you want a stable address instead of a random one.

Install `cloudflared`: `winget install Cloudflare.cloudflared` (Windows), `brew install cloudflared`
(macOS), or grab a binary from Cloudflare's releases.

> That URL is public, and so is registration. Set `ALLOW_SIGNUP=false` once your own accounts exist,
> unless you mean to let strangers in.

### Why the Vercel limit rarely bites

A Vercel Hobby function is capped at 300 seconds. A chat turn takes seconds, so the cap only matters
on long agentic runs — and the agent loop writes its state after every step. When a connection is cut
the browser reconnects and continues from the last saved step, up to 25 times. A resumed run
re-checks the approval policy rather than assuming permission was already granted.

So the practical difference is not "limited vs unlimited" but *where the tools run*: Vercel can chat
and search the web; only your own machine can touch your files.

---

## Deploy — GitHub → Vercel → Neon

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Synapsez"
git branch -M main
git remote add origin https://github.com/<you>/ai-remote.git
git push -u origin main
```

`.gitignore` already excludes `.env` and `data/`. Never commit your keys.

### 2. Import into Vercel

New Project → import the repo → Deploy. Leave the framework preset as **Other** and leave the build
command empty. `vercel.json` routes `/api/*` to the Express function; everything in `public/` is
served straight from Vercel's CDN.

### 3. Add the database (free)

In the Vercel dashboard: **Storage → Create Database → Neon**, then connect it to the project. Vercel
sets `DATABASE_URL` for you. The schema is created automatically on first request.

> Neon's free tier is ample for this — chat history is small text. Any Postgres works: Supabase,
> Railway, or your own. Only `DATABASE_URL` matters. Free-tier limits change, so check the current
> terms before you rely on them.

### 4. Set environment variables

**Settings → Environment Variables**, then redeploy:

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | **yes** | Set for you by the Neon integration. |
| `SESSION_SECRET` | **yes** | Signs session cookies. Long and random. Changing it signs everyone out. |
| `ENCRYPTION_KEY` | **yes** | Encrypts stored provider keys. Changing it makes existing ones unreadable. |
| `ACCESS_TOKEN` | legacy | One value standing in for both of the above, from before they were separate. Still honoured — the two keys are derived apart from it — but it cannot be rotated in halves, so the server warns at boot. Set `SESSION_SECRET` and `ENCRYPTION_KEY` instead. |
| `CRON_SECRET` | **yes** | Authenticates the cron endpoints — the scheduler and the model-library refresh. Any long random string. Without it both refuse every call, so scheduled tasks never run. |
| `GMAIL_USER` + `GMAIL_APP_PASSWORD`, **or** `RESEND_API_KEY`, **or** `SMTP_*` | optional | Sends password-reset codes and the assistant's emails. Without one, reset links go to the server log and `send_email` says it cannot send. |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | optional | Lets accounts connect Gmail, Drive, Calendar, Docs, Sheets, Forms, Tasks and Contacts. See [docs/google.md](docs/google.md). |
| `GEMINI_API_KEY` | optional | Real Google results in web search (Gemini grounding). An account's own Google key works too. |
| `EMAIL_FROM` | optional | The From name and address, e.g. `Elite Business <you@gmail.com>`. The name also heads every email. Defaults to the Gmail/SMTP login. |
| `EMAIL_REPLY_TO` | optional | Where replies to the assistant's emails go, e.g. `support@yourcompany.com`. Unset, they come back to the sending mailbox. |
| `ALLOW_SIGNUP` | optional | Open by default. `false` closes registration; the first account is always allowed. |
| `DESKTOP_ACCESS` | optional, worker | `true` lets the assistant drive real applications on that machine. Off by default; see the platform table under "Desktop control". |
| `DEFAULT_MONTHLY_TOKEN_LIMIT` | optional | Monthly cap for accounts using a shared key. Ignored for accounts with their own. |
| `TAVILY_API_KEY` or `BRAVE_API_KEY` | recommended | Reliable web search. Without one, search scrapes DuckDuckGo, which is best-effort. |
| `ANTHROPIC_API_KEY` etc. | **usually leave blank** | A shared fallback every account without its own key spends against. See the warning above. |
| `PUBLIC_URL` | recommended | Your deployment URL. Used to build links in emails; without it they are guessed from the request. |
| `INSIGHTS` | optional | `off` stops the app loading Vercel Web Analytics and Speed Insights. On by default on Vercel only — see below. |
| `SPEED_INSIGHTS_SAMPLE_RATE` | optional | Share of page loads whose speed is sent, `0`–`1` (default `1`). Lower it if Speed Insights nears its free allowance. |

Worker tokens are not environment variables: each person generates their own in the app, under
**Settings → Worker**.

**Page views and page speed.** On Vercel the app loads Vercel Web Analytics and Speed Insights
(`@vercel/analytics`, `@vercel/speed-insights`, copied into `public/vendor/vercel` by
`npm run vendor:insights`). Turn both on once in the dashboard (**Analytics** and **Speed Insights**
tabs). Both are free on Hobby within their allowance — 50,000 analytics events a month and 10,000
speed events over a rolling 30 days; past either, collection pauses and nothing is billed. What is
sent is only the page's address cut to its path (this app keeps reset, share and chat tokens after
`?`, and those never leave), no cookies, and nothing at all from a browser set to Do Not Track or
Global Privacy Control. Settings → Memory & privacy tells people so. A self-hosted copy loads
neither.

Get one of the three required ones wrong and the deployment says so plainly — every request answers
`503` naming the variable that is missing, rather than a platform error page with the reason buried
in a log. `npm run test:deploy` checks the same things locally before you push: that `vercel.json`
declares the files read at runtime, that the schema migrates an existing database rather than
assuming a fresh one, and that the serverless-only branches behave.

<details>
<summary><b>Everything else the server reads</b> — none of it needed; each has a default that suits the free tier</summary>

| Variable | What it changes |
|---|---|
| `POSTGRES_URL` | Read when `DATABASE_URL` is not set; some integrations use this name. |
| `DATA_DIR` | Local runs only: where the in-process Postgres keeps its files. Default `data/`. |
| `PORT` | Local runs only: the port the app listens on. Default `5173`. |
| `MAX_TURN_TOKENS` | Tokens one turn may spend before it stops: 2,000,000 by default on a shared key, no limit on an account's own key. `0` turns the limit off. |
| `PRICE_MARKUP` | The markup shown on top of provider prices, as a fraction — `0.1` (ten percent) by default. A value outside 0–1 is ignored. Stored costs stay the provider's own. |
| `STREAM_STALL_FIRST_MS` / `STREAM_STALL_MS` | How long a reply may stay silent before it counts as stalled: before its first token (default `150000`) and between tokens (default `90000`). |
| `IMAGE_MODEL` | The model `generate_image` uses. Default `gemini-3.1-flash-image`. |
| `GOOGLE_SEARCH_MODEL` | The Gemini model behind grounded web search. Default `gemini-2.5-flash`. `GOOGLE_API_KEY` is read when `GEMINI_API_KEY` is not set. |
| `GOOGLE_REDIRECT_URI` | Overrides the Google connector's callback, `<your origin>/api/connectors/google/callback` by default. See [docs/google.md](docs/google.md). |
| `ANTHROPIC_BASE_URL` | Sends Anthropic requests to another endpoint, such as a proxy — what `OPENAI_BASE_URL` does for OpenAI. |
| `THESPORTSDB_KEY` | Your own TheSportsDB key for the scores card. Default is their free test key. |
| `RESEARCH_REPUTABLE_DOMAINS` | Comma-separated sites deep research counts as reputable, on top of its built-in list. |
| `SANDBOX_DISABLED` | `1` hides the cloud sandbox. On Vercel it is offered automatically; elsewhere it needs `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. |
| `CLOUD_ACTIONS_PER_DAY` / `CLOUD_ACTIONS_TOTAL_PER_DAY` | Cloud browser and sandbox actions a day, per account (default `60`) and in all (default `400`) — sized to Hobby's CPU allowance. Raise them on a paid plan. |
| `CLOUD_BROWSER_BLOCK_TRACKERS` | `0` lets the cloud browser load the well-known analytics, advertising and session-recording hosts it otherwise cannot resolve (on by default; the list is `TRACKERS` in `server/cloudBrowser/service.mjs`). |
| `CLOUD_CHECKS_PER_DAY` / `CLOUD_CHECKS_TOTAL_PER_DAY` | New stdio MCP servers checked on a scratch machine a day, per account (default `5`) and in all (default `30`). A check installs and starts a package on a machine of its own, so it costs far more than one action. A command somebody has already added needs no check. |
| `WORKER_IDLE_SLEEP_MS` | How long a connected computer's poll waits while its account is idle: `4000` on Vercel, `0` elsewhere. It saves function calls on the free tier; `0` turns it off. |
| `ALLOW_MCP_STDIO` | `true` lets stdio MCP servers (`npx -y gitnexus@latest mcp`) run as programs beside the server, on a single-owner machine. Off by default, and never on Vercel: on a shared server that is running a command somebody typed, with every account's keys in reach. Without it, stdio servers run on each account's own cloud computer (the Vercel Sandbox, so `SANDBOX_DISABLED` switches them off too): started only when a tool is called, and checked once on a scratch machine the first time anybody adds a command, so the next account to add the same one has it at once. |
| `LOG_LEVEL` / `LOG_FORMAT` | `debug` adds debug lines. `json` or `text` overrides the format, which is JSON on Vercel and readable text elsewhere. Every model call is one `gen_ai.span` line with the OpenTelemetry GenAI attributes (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `error.type`, `duration_ms`…) beside the request's trace id — never any content — so a collector that reads JSON logs can lift them as spans. |
| `REPO_URL` | The repository the "connect a computer" command clones. Default this project's; set it on a fork. |

</details>

### 5. Create the first account

Open the deployment. With no users yet, the gate offers to create the first account — **it becomes the
administrator**. Everyone after that signs up the same way, with an email and a password.
**Settings → People** lists who has joined, and lets an admin set per-person token limits, suspend an
account, or remove one. Set `ALLOW_SIGNUP=false` to close registration once everyone is in.

### 6. Connect a computer (optional but the good part)

Each person does this for their own machines, and only their own conversations can reach them.

On the computer you want the assistant to work on:

Press **Set up a computer** in Settings → Computers. It gives you one line to paste on the machine
you want to use — it already contains this deployment's address and a setup token for your account:

```powershell
$env:AIR_TOKEN='…'; $env:AIR_SERVER='https://your-app.vercel.app'; $env:AIR_REPO='…'; irm https://your-app.vercel.app/setup.ps1 | iex
```

That downloads the code, installs it, pairs the machine, and sets it to start at login. No code to
read off a terminal and type back.

**It stops and asks first, and that is deliberate.** Before anything is installed it prints the
account the machine is about to be given to, and refuses to continue without a typed `YES`:

```
  This will give  you@example.com  full access to this computer:
  its files, a shell, and control of your screen.

  Type YES to continue:
```

The reason is the direction. A pairing code travels *from* the machine *to* its owner, so nobody can
be tricked into typing somebody else's code. A setup token travels the other way, which means it can
be handed to a person along with a plausible story — "paste this to activate your trial" — and the
machine that pastes it belongs to whoever minted the token. Naming the account turns that from a
paste that looks harmless into a decision somebody made. Never paste a setup line another person
sent you.

The token lasts ten minutes and works once.

### Or do it by hand

```bash
git clone <your-repo-url> ai-remote
cd ai-remote
npm install

npm run connect -- https://your-app.vercel.app
```

The address is on the **Computers** tab of your own deployment, under Settings, already written into
a line you can copy — so there is nothing to type from memory.

**Not `npm start` here, and the difference matters.** `npm start` brings up a *second copy of the
app* on this machine and points the worker at that, so the pairing code it prints lands in a database
your deployment cannot see. Typing that code into the deployed app gets "this code is not valid" —
correctly, and confusingly. `npm run connect` starts the worker alone and points it at the address
you name.

The address is remembered in `worker/.env`, so from then on a plain `npm run connect` is enough. Name
a *different* server and the stored token is cleared first: a token only works on the server that
issued it, and carrying one across would give a 401 and a misleading "no longer paired".

It shows a pairing code:

```
  ┌─────────────────────────────────────┐
  │                                     │
  │      Pairing code:   H4PW-GW6T      │
  │                                     │
  └─────────────────────────────────────┘
```

Open the deployment on any device, sign in, and press **Computers** in the header. Type the eight
characters. The machine connects within a couple of seconds, writes its token to `worker/.env`, and
never asks again — the indicator turns green and the file and shell tools appear. `Ctrl+C` and they
disappear; the assistant is told they are unavailable rather than left to fail.

**Nobody needs to know a flag.** A plain `npm start` always brings the worker up: with a token it
connects, without one it offers a code and waits. Nothing to configure, nothing to remember.

**Whoever holds the code decides.** The machine names no account and reads nothing — it can only ask
to be adopted. So it can be paired from a phone, from a different browser, or by a **different
account entirely**: a colleague pairing a shared workstation to theirs is the same three steps.

**Every code is new and single-use.** A fresh one is minted for each attempt, it expires in ten
minutes, and claiming it deletes it. Unpair a machine in the app and it simply asks again — it prints
a new code and waits — rather than telling anybody to go and edit a file on it.

> If the app and the unpaired computer happen to be the same machine — the ordinary case for somebody
> who just ran `npm start` — the pairing sheet shows the code with a copy button, so there is nothing
> to read across from a terminal. That only works because the two are on the same disk: a server
> cannot otherwise tell which unclaimed code belongs to the person looking at it, which is the entire
> point of a code.

**Sign in on any device and your computers are simply there.** The pairing belongs to the account,
not to the browser, so a phone on mobile data reaches the desktop at home exactly as the laptop next
to it does.

**As many computers as you like.** A laptop and a desktop, work and home. Each gets its own token and
can be unpaired on its own. When more than one is online, **Settings → Computers** marks which one
the assistant is working on and lets you switch; tool calls are addressed to that machine rather than
going to whichever polled first.

**Change the working folder from the app.** Each computer has a box in **Settings → Computers** for
the folder it works in. Type a path, press Save, and it moves within about fifteen seconds — no file
to edit on that machine and nothing to restart. You can also just ask: *"work in D:\projects\shop
from now on"* uses the `set_workspace` tool, which always stops for a yes because it moves the
boundary the file tools are confined to. A folder that is not there is refused and reported rather
than silently created, so a typo does not become an empty workspace and a confusing hour.

> The folder and the reach are different settings, and it is worth knowing which
> is which. The **folder** is where relative paths resolve, chosen from the app.
> The **reach** — whether the assistant may leave that folder at all — is
> `FILE_ACCESS` on the machine itself, deliberately not remotely changeable: how
> far a computer can be driven is a decision that should need a hand on that
> computer. With the reach left narrow, moving the folder is how you grant
> access to one project rather than to the disk.

> Direction matters here. The computer asks for a code and waits — it never
> names an account and cannot reach anything. What makes it yours is a signed-in
> person typing that code, which is the only step that touches an account at all.

Want only the worker on a headless box? `npm run connect -- <url>`. Want only the
app, with no worker at all? `npm start -- --no-worker`.

> There used to be a second way in: generate an account-wide token, paste it into a file on the
> machine, restart. It is gone. One token per account meant adding a second computer silently cut off
> the first, it took six steps and a text editor, and every one of those steps was somewhere to give
> up. Tokens issued under the old scheme still authenticate, so nothing that was working stops.

> **Tip for one set of chats everywhere.** Put the same `DATABASE_URL` in your local `.env` as the
> deployment uses, and the local app becomes the *same* app — same accounts, same conversations —
> just served from your machine, with the tools running in-process and no worker needed.

---

### 7. A computer that is always on

Everything above assumes the machine being driven is the one in front of you, which means the
assistant stops existing when you shut the lid. It does not have to be. **The worker is what gets
driven, and it does not care whose computer it is running on** — put it on a Windows VM in a cloud
and you get a full desktop the assistant works in, awake while everything of yours is off.

Nothing here is a different mode of the app. It is the same three steps as any other computer, done
on a machine you rent instead of one you own.

```powershell
# On the VM, over RDP, once:
winget install OpenJS.NodeJS.LTS Git.Git
git clone <your-repo-url> C:\ai-remote ; cd C:\ai-remote ; npm install

# worker\.env
DESKTOP_ACCESS=true      # the whole screen, not just the browser sandbox
FILE_ACCESS=full         # optional: reach outside the workspace folder

npm run connect -- https://your-app.vercel.app   # worker only; the app is already deployed
```

Pair the code from any device, then **Settings → Computers** to make it the machine tool calls go to.
The live screen panel now mirrors that desktop, so you can watch it work from a phone.

> Watching is not the same as touching. *"You can take the controls"* in the panel drives the
> **browser sandbox**, and only when the app and the browser are on the same machine — it is not a
> remote desktop. To do something yourself on the VM, such as signing into a site the assistant is
> stuck on, connect over RDP. Everything the assistant does there is unaffected by you being
> connected at the same time.

Three things decide whether this actually works, and all three are Windows, not this app:

- **The session has to stay interactive.** UI Automation and `SendInput` drive a real desktop; there
  is not one in a locked session or in a service. Closing RDP with the ✕ **locks** the session and
  the desktop tools stop until you connect again. Disconnect with `tscon 1 /dest:console` instead,
  which leaves the session running on the virtual console — or turn on auto-logon and never sign out.
- **Start it at logon, not as a service.** A service runs in session 0, which has no desktop at all.
  A Task Scheduler task with *"At log on"*, *"Run only when user is logged on"*, pointed at
  `npm run connect`, is the arrangement that survives a reboot.
- **Nothing may lock the screen.** Turn off the screen saver, the lock timeout, and sleep. A lock
  screen is a desktop the assistant cannot see past.

**The always-running part is [scheduled tasks](#scheduled-tasks), not the VM.** The VM is only a
machine that stays awake; what makes work happen while you sleep is the scheduler in the app firing a
conversation on its own, whose tool calls land on that always-on desktop. A cloud VM without a
schedule is just a computer you can reach from your phone — which is also useful, and is what most
people want.

> **A Windows VM costs money, per hour, whether or not anything is happening.** A small always-on
> instance is roughly the price of a streaming subscription; the smallest ones will run the worker
> and struggle with a browser. This is the one part of Synapsez with an unavoidable bill attached,
> which is why it is opt-in and last in this document rather than assumed.

---

## How it is put together

```
api/index.js          Vercel entry point — exports the Express app
server/
  app.js              routes: auth, chats, settings, SSE stream, worker relay, admin
  agent.js            the agent loop, tool approval, resume
  auth.js             accounts, sessions, email links, 2FA, worker pairing
  crypto.js           scrypt password hashing, AES-GCM key encryption
  email.js            Resend / SMTP / console delivery and the templates
  screenHub.js        the live screen: SSE fan-out, polling fallback
  usage.js            per-account token accounting and the monthly quota
  settings.js         per-user prefs and encrypted provider keys
  pdf.js              text out of a PDF, for the models that cannot be handed one
  search.js           Exa, DuckDuckGo, Tavily, Brave — tried in order until one answers
  office/             Word, Excel and PowerPoint — read and written, no dependency
    zip.js            the archive an Office document actually is
    xml.js            just enough XML, with no entity resolution at all
    blocks.js         one document model every reader and writer meets in
    markdown.js       Markdown in, blocks out — the authoring language
    docx.js / xlsx.js / pptx.js   one format each, both directions
  providers/          one streaming interface over five APIs
  tools/              tool schemas, cloud implementations, execution router
  store/              Neon and PGlite behind one Postgres interface
  routes/             six route groups lifted out of app.js — chats, files,
                      workspace, connectors, mcp, workflows
  research/           deep_research: plan, gather, debate, grade, report
  workflows.js        multi-step jobs that survive being interrupted
  mcp/                tool servers the user connects, discovered per account
  skills/             procedures that ship with the app
  roleModel.js        which calls deserve the conversation's model, and which
                      go to a cheaper one
  autoPick.js         the `auto` model id → OpenRouter's free router
  i18n/               the server's own sentences, in the reader's language
  util/trace.js       the request id every log line carries
worker/               the process that runs on someone's machine
  browser.js          the browser sandbox, driven over CDP
  desktop.js          desktop control, and the camera process
  desktop/host.ps1    UI Automation + SendInput, one long-lived process
  desktop/capture.ps1 screen capture, deliberately its own process
  screen.js           which source owns the screen, and whether anyone watches
public/               the frontend — no build step, no framework
scripts/
  launch.js           one command: web app + worker + optional tunnel
  whoami.js           which accounts exist in this database
  reset-password.js   the way back in when email is not configured
  server-messages.js  every sentence the server writes, read from the source
test/                 the tenancy isolation suite, and one per area besides
```

A few decisions worth knowing about:

**Office documents are read and written here, with no library.** A .docx is a ZIP of XML, and Node
already ships the hard part of that — so the whole of `server/office/` is the bookkeeping around
`zlib`: a few fixed-width headers, a small XML reader, and one document model that every format
converts to and from. That is three formats in both directions for no supply chain, no bundle
weight and no upgrade treadmill, against specifications frozen since 2006. The same reader draws
the preview and feeds the model, which is what stops the two from ever disagreeing.

**The local database is claimed by one process, and it has to be.** PGlite has no cross-process
locking: two processes on one folder both write, and the write-ahead log ends up with a checkpoint
neither can read — a database that will not start and that PGlite ships no tool to repair. So the
data folder holds an `owner.pid` with the real operating-system pid, checked before Postgres is
even started. A second opener is turned away with a sentence; a lock left by a process that has
since died is ignored, because otherwise every crash would need a human. Postgres's own
`postmaster.pid` cannot do this job — the pid in it belongs to the WASM sandbox and no operating
system can check it — and a stale one is cleared automatically rather than reported as
`server exited with code 1` above ninety kilobytes of WebAssembly runtime.

**Sessions are signed cookies, not server state.** Every Vercel request may hit a different instance,
so there is nowhere to keep a session map. Changing `SESSION_SECRET` invalidates every session, which
is exactly what you want from a revoke button.

**Passwords use scrypt from Node's standard library.** Memory-hard, no dependency, and the cost factor
is stored in the hash so it can be raised later without invalidating existing accounts.

**Provider keys are encrypted before they touch the database.** They are other people's credentials; a
database dump alone should not hand them over.

**The agent loop is resumable.** Every step is written to the database before the next one starts. If
a serverless invocation is cut short, or the run stops for approval, the client reconnects and picks
up from stored state rather than starting over. This is what keeps a 300-second function cap from
being a 300-second ceiling on the work.

**The worker polls outward.** Your machine is not addressable from the internet, so jobs go into a
Postgres queue and the worker long-polls for them. No inbound ports, no tunnel, no firewall rules.

**A locally-run server skips the queue entirely.** If the app process is already on your machine,
there is nothing to relay: the admin account's tools execute in-process. The queue exists for the
hosted case, where the server is in a datacentre and your computer is not.

**Paths are checked against the workspace, with symlinks resolved.** Tool arguments come from a
language model and are treated as untrusted input. This applies to the file tools; `run_command` is
not confined — see [What the workspace actually confines](#what-the-workspace-actually-confines).

**A message typed mid-turn waits.** It sits above the composer and goes the moment the turn ends, or
the moment you press stop. Most of what gets typed during a long turn is the *next* thing rather than
a correction, and having it land halfway through derails work that was going fine — so interrupting
is still available, on a **Send now** button on the queued line, where it is a decision rather than a
side effect of pressing Enter.

**The loop can take a message mid-run.** Sending one does not wait for it to
finish: the message is saved, and the loop picks it up at its next step — the way you would cut in on
someone already halfway through a task. The transcript is re-ordered before it reaches the model so a
mid-run message never splits a tool call from its result, which every provider rejects.

---

## Security

Anyone who can log in as you can run commands on your computer whenever your worker is running. Treat
your password like an SSH key.

- Keep provider keys per-account. A shared fallback key means one person's usage lands on your bill.
- Switch the policy to **Ask first** for any workflow you do not yet trust.
- Point `WORKSPACE` at a specific project folder, not your home directory or a drive root.
- Stop the worker when you are not using it. That is the real off switch.

**A file somebody uploaded is never served back as something that can run.** Only images and PDFs
are echoed with their own content type; everything else — an uploaded `.html`, an `.svg`, a `.js` —
is served as `application/octet-stream` and forced to download, under a `default-src 'none'` policy
of its own. Without that, a file uploaded to this app and opened from it is a script running on this
origin with this session's cookie, which is stored cross-site scripting with the application's own
hands on it. The viewer shows such a file as source, never as a page.

**An artifact runs in an opaque origin, and that is the whole model.** The one route that serves
something executable sends `sandbox allow-scripts` without `allow-same-origin`, so the page has no
access to this app's cookies, storage or API, and `connect-src 'none'` leaves it no network either.
Only files the assistant generated are runnable; an uploaded page is somebody else's HTML and is
served as a download. See **Artifacts**.

**Office documents are parsed without resolving anything.** The XML reader skips `<!DOCTYPE>` whole
and never expands a declared entity, so neither the billion-laughs expansion nor an external-entity
file read is possible — they are not defended against, they are unimplemented. Decompression is
capped per part, so an archive that claims to inflate to gigabytes is refused rather than discovered
as an out-of-memory crash. Every preview is built from escaped text and tags this application chose.

### What is enforced, and where

Each of these is covered by a test, so it is a property of the build rather than an intention.

| | |
|---|---|
| **Sessions end when a password changes** | Cookies are stateless and signed, so there is no list to clear — the account's `session_epoch` is signed into the cookie and checked on every request. Changing your password bumps it, and every other device is out. The browser that made the change is re-issued a cookie, because being logged out for doing the right thing is a strange reward. |
| **Sign-in is throttled** | Ten attempts per address and per account per fifteen minutes, counted in the database so it holds across serverless instances. A correct sign-in clears the tally. |
| **Password hashing is bounded** | scrypt is memory-hard by design — ~32MB a call — so a flood of sign-ins was a way to exhaust a 1GB function with a hundred requests. Four at a time, and the rest queue. |
| **A TOTP code works once** | The 30-second step is recorded when spent, so a code read over your shoulder is not good for another ninety seconds. |
| **`web_fetch` cannot reach inside** | Every hop is resolved and checked against the private ranges — loopback, 10/8, 192.168/16, 172.16/12, and `169.254.169.254`, which is where cloud credentials live. Redirects are followed by hand so a public hostname cannot 302 its way inward. `ALLOW_PRIVATE_FETCH=true` opts out deliberately. |
| **Connector tokens stay on one host** | The `github` tool takes an API *path*, not a URL. It used to accept anything starting with `http`, which meant a page the model read could talk it into posting your token to somebody else's server. |
| **One agent loop per conversation** | Claimed with a conditional `UPDATE`, so two tabs cannot interleave their turns into the same transcript. The claim is a lease and expires, so a run killed mid-flight does not wedge the chat. |
| **Screen frames are not kept** | The stored frame is a photograph of your actual desktop. It is cleared when you sign out and when the sandbox closes, and in-memory frames are swept after a minute with nobody watching. |
| **No third-party requests** | No CDN, no web fonts, no analytics. A Content-Security-Policy with `script-src 'self'` is sent on every response, so an injected script has nowhere to load from. |
| **An upload cannot become a script** | Only images and PDFs are served with their own content type. An uploaded `.html` or `.svg` comes back as `application/octet-stream`, as a download, under its own `default-src 'none'` policy — otherwise a file opened from this app is a script on this origin holding this session's cookie. |
| **An artifact cannot reach your session** | Served under `sandbox` with no `allow-same-origin`, so it runs in an opaque origin: no cookies, no storage, no API, and `connect-src 'none'` for good measure. Only generated files run; uploads never do. |
| **A document cannot read the server** | The XML reader skips `<!DOCTYPE>` and never expands an entity, so external-entity reads and expansion bombs are unimplemented rather than defended against. Every part of an archive has a decompression ceiling. |

### Approval: what stops and what does not

Asking permission for everything and asking for nothing fail the same way — neither leaves you any
attention for the cases that matter. So the question is not "does this change something" but **could
this ruin my afternoon**.

| | |
|---|---|
| **Guarded** *(default)* | Ordinary work runs. Risky work stops and asks, with a reason. |
| **Auto-run** | Nothing is gated, including destructive actions. |
| **Ask first** | Every change waits for you. |
| **Plan** | Same tools as read-only, different brief: investigate, then hand back a plan instead of doing the work. |
| **Read-only** | The tools that change anything are never offered to the model at all. |

Under **Guarded**, this runs without asking: reading anything, editing inside the workspace, driving
the browser sandbox, clicking and typing on the desktop, and everyday shell commands like
`npm test`, `git status`, `where claude`.

This stops and asks: deleting or force-pushing, piping the internet into a shell, `shutdown`,
writing to an absolute path or one containing `..`, anything under `C:\Windows` or `Program Files`,
`alt+f4` and friends, launching a shell from the desktop tools, closing a window that may hold
unsaved work — and any tool that has not been classified at all, which is treated as risky rather
than waved through.

> **This is a pattern list, not a sandbox.** Something destructive that it does not recognise will
> run without asking. The classification errs upward and is covered by tests, but if you want a hard
> stop on every change, use **Ask first**.

The rules live in one place — `assessRisk()` in `server/tools/definitions.js` — and are asserted by
the test suite, so a change to them is a change you can see in a diff.

### What the workspace actually confines

Be precise about this, because it is easy to assume more protection than exists:

| Tool | Confined to `WORKSPACE`? |
|---|---|
| `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `open_url` | **Yes** — paths outside it are refused, symlinks resolved |
| `run_command` | **No.** Only its working directory is set. The command itself can read, write or run anything your OS account can, anywhere on the machine |

So the workspace is a guard rail for the file tools, not a sandbox for the assistant. Anyone who can
run `run_command` on your computer effectively has your user account. That is inherent to giving an
assistant a shell — but it means the **approval policy and stopping the worker are the real controls**,
not the workspace path.

**On a local run, both `FILE_ACCESS=full` and `DESKTOP_ACCESS=true` are written to `.env` for you on
first start**, and the app says so on the console when it does. That is deliberate: a local run means
you started the server on your own computer, only the administrator account — yours — reaches those
tools at all, and the point of the app is to drive that machine. The narrow default mostly taught
people to fight the error messages. What keeps it safe is the approval policy, not the reach.

Set either to `false` in `.env` to narrow it again:

- `FILE_ACCESS=` — the file tools go back to refusing anything outside `WORKSPACE`.
- `DESKTOP_ACCESS=false` — the `desktop_*` tools disappear from the model's view entirely.

On a hosted deployment neither is set by default; each person's worker decides for their own machine.

More things worth doing:

- Close registration with `ALLOW_SIGNUP=false` once your own accounts exist. Every account costs
  database rows and, if it pairs a worker, compute on its owner's machine.
- Run `npm test` after touching anything in `server/store/`, `server/auth.js`, or the tool schemas.

### What is not implemented

Being explicit, so you do not assume protection that is not there:

- **No rate limiting** on login, registration, or password-reset requests. Add a limiter before
  putting a public URL in front of this.
- **No audit log** of admin actions.
- **No OAuth sign-in** (Google, GitHub) — email and password, with optional 2FA.
- **2FA cannot be forced** on everyone; each person chooses it for their own account.
- **Desktop control is uneven across platforms.** Windows and macOS give numbered controls; X11 gives
  coordinates and keystrokes only, and Wayland needs `ydotool` and a permission you grant yourself.
  See the table under "Desktop control".
- **The desktop mirror is a series of images, not a video stream.** Around 7.5 fps on a changing
  screen. Fine for watching work happen; it is not screen-sharing quality.
- **UI Automation does not reach everything.** Apps that draw their own interface without exposing
  accessibility information — some games, some Electron and Java apps — show few or no numbered
  controls. Coordinates and keyboard shortcuts are the fallback there.
- **Google needs a one-time OAuth client** from the deployment owner ([docs/google.md](docs/google.md)).
  Unverified, it shows Google's warning screen and is capped at 100 users.
- **No browser extension.** The sandbox is a separate browser the assistant drives; it cannot act
  inside the Chrome window you are personally using, and there is no extension that would let it.
- **Sub-agents cannot write.** They are read-only on purpose — see above.
- **Scheduled runs are unattended, so `ask` and `guarded` policies will stall them** if the work
  needs approval. Nobody is there to answer. Schedule work that reads and reports, or set the policy
  to auto-run and understand what that means.

---

## Cost

You pay your providers directly; Synapsez adds nothing. Verified per-million-token pricing is shown
for Claude models and for anything loaded from the OpenRouter catalogue. Where a price is not
verified the app shows token counts rather than inventing a number — check your provider's pricing
page.

Agentic runs use more tokens than plain chat, because tool results re-enter the context each step.
`Settings → Behaviour` has the levers: reasoning effort, and the maximum tool steps per turn.

---

## Local development notes

```bash
npm start                     # app + worker (if configured), one terminal
npm run share                 # the same, plus a Cloudflare tunnel
npm run connect -- <url>      # this machine, driven by a deployment elsewhere
npm start -- --no-worker      # app only
npm run dev                   # server alone, with --watch
npm run worker                # the machine worker alone
npm run db:init               # create the schema against DATABASE_URL and verify access
npm run accounts              # which accounts exist in this database
npm run reset-password -- you@example.com    # set a password directly, no email needed
npm run make-admin -- you@example.com        # promote an account to administrator
npm run pair                  # the same thing, under its older name
npm run lint                  # eslint
npm run check                 # lint + every fast suite — the one to run before pushing
npm test                      # every fast suite
npm run gate                  # lint, hook tests, eval, type-check, npm test — what "done" means here
npm run test:deploy           # just the Vercel paths
npm run test:ui               # the real app in a real browser: layout, theme, filtering
```

`npm test` runs every fast suite, one file per area. Six of them are worth knowing apart, and each
has a script of its own:

| | |
|---|---|
| `test:isolation` | Real SQL against an in-process Postgres, then deliberate attempts to cross the boundary between two accounts. Also the crypto, the risk classifier, redaction, and the SSRF guards. |
| `test:agent` | The loop itself, driven with a stubbed provider — sub-agents, transcript re-ordering, approval gating, and the compaction that keeps a long conversation inside the window. It exists because `run_parallel` shipped calling an async generator with `await`, which silently did nothing at all, and no test would have noticed. |
| `test:http` | The app as something on a port: which routes need a session, which need an admin, that a password change really ends the other sessions, that guessing gets throttled, that a conversation runs in one place. |
| `test:devices` | Pairing, several computers on one account, moving a working folder from the app, and the new-model announcement. Two pairing endpoints are unauthenticated by necessity, so what an unclaimed pairing *cannot* do is pinned down hard. |
| `test:attachments` | Photos and files: what is accepted, where the bytes live, who may fetch them, and what each provider adapter finally builds out of them. |
| `test:deploy` | The app with `VERCEL=1`, plus the static checks that decide whether a build boots at all. Local and hosted are genuinely different programs here — the store, the screen transport, the scheduler and the local-tool path all fork on it — and production is the worst place to discover which half is wrong. |

None of them needs the network, a key or a browser; run them constantly. `npm run test:ui` adds
the checks that do need a real browser.

`npm run test:ui` drives the real app in a real browser. It uses Chrome or Edge if you have one and
falls back to Playwright's own Chromium, so `npx playwright install chromium` makes it work anywhere.
It exists because layout bugs are invisible to unit tests: it measures how many elements can actually
scroll, asserts the dialog is not wider than itself, and checks that the page loads nothing from
anybody else's server.

Locked out because email is not configured? `npm run accounts` shows who exists and
`npm run reset-password` sets one directly. `make-admin` exists for a real chicken-and-egg: admin
powers are granted under Settings → People, which only an admin can open, so if the first account is
lost or was created by accident nothing in the interface can fix it. Physical access to the database
is already total access, so none of these grant anything new — they just save writing the SQL by hand.

`WORKER_MODE=remote` forces local tools through the job queue even when running locally, which is how
you exercise the relay end to end.

`OPENAI_BASE_URL` points the OpenAI provider anywhere OpenAI-compatible — Ollama, LM Studio, vLLM —
so you can run a local model with the same agent loop.

The machine worker reads a few of its own. `npm run connect` writes the first three for you.

| Variable | What it changes |
|---|---|
| `SERVER_URL` | The app it connects to. Default `http://localhost:5173`. |
| `WORKER_TOKEN` / `WORKER_ID` | Its credential and its name for itself, from pairing. |
| `DEVICE_NAME` | What the app calls this computer. Default its hostname. |
| `ALLOW_INSECURE_SERVER` | `true` lets it reach a public address over plain `http`. Without it, `http` works only to this machine and (with a warning) to a private network: anywhere else the token would cross the internet in the clear. |
| `WORKER_CONCURRENCY` | Jobs run at once, `1`–`12`. Default `4`. |
| `WORKER_ALLOW_MULTIPLE` | `true` allows a second worker on the same machine, which otherwise stops: two would fight over one browser and one job queue. |
| `FILES_DIR` | Where files from a conversation land on this machine. |
| `BROWSER_CDP_URL` / `BROWSER_CDP_PORT` | The Chrome DevTools endpoint used to reach your own browser. Default port `9222`. |
| `SCREEN_HD_SCALE` / `SCREEN_HD_QUALITY` / `STEP_SHOT_QUALITY` | Scale and JPEG quality of the live screen in HD (`2`, `72`) and of each step's screenshot (`45`). |

---

## Licence

MIT. Use it however you like.
