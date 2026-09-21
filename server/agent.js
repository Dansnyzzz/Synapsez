import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getPrefs, usesSharedKey, providerStatus } from './settings.js';
import { checkQuota, record as recordUsage, turnTokenLimit } from './usage.js';
import { streamCompletion } from './providers/index.js';
import { budgetStop } from './providers/stop.js';
import { resolve as resolveModelId } from './models.js';
import { isAuto, pickAutoModel, NO_AUTO_MESSAGE } from './autoPick.js';
import { availableTools, assessRisk, riskReason, TOOLS_BY_NAME } from './tools/definitions.js';
import { UNTRUSTED_RULE } from './tools/untrusted.js';
import { executeTool } from './tools/execute.js';
import { normalisePlan, PLAN_MIN_STEPS } from './tools/cloud.js';
import { workerStatus } from './localTools.js';
import { skillMenu } from './skills.js';
import { connectorSummary } from './connectors.js';
import { mcpTools } from './mcp/registry.js';
import { priceTurn } from './providers/catalog.js';
import { loadForTranscript, toParts } from './attachments.js';
import { projectPrompt } from './projects.js';
import { compact, shouldCompact, measure, activeTranscript } from './compact.js';
import { log, annotate } from './util/trace.js';
import { mapWithLimit, MAX_PARALLEL_TOOLS } from './util/parallel.js';

/**
 * There is one mode.
 *
 * A separate "plain chat" mode existed to protect conversations from models
 * that could not call tools — but the library now refuses to import a model
 * without tool support, so the only thing the toggle could still do was take
 * abilities away for no reason. Every conversation is an agent conversation.
 */
// Exported for the eval suite, which asserts against the prompt the loop
// actually builds rather than a copy of it — a rule deleted here has to fail
// there, and it only does if both read the same function.
/**
 * Which version of the app's own prompt is in effect.
 *
 * The system prompt is ~5,000–14,000 characters of tuned instruction assembled
 * from string literals below, and nothing identified which version of it a turn
 * ran under. So a paragraph could be edited and the next week's behaviour — or
 * cost — could not be put beside the last week's: every prompt change in this
 * repository was unmeasured (GAP-003).
 *
 * This is a fingerprint of everything the *app* authors, across every branch it
 * can take: no worker, a worker with a desktop, and each policy. It excludes the
 * three things that are not the app's to version — the date line, which would
 * change it daily; and the account's own additions and connected data (custom
 * instructions, skills, connectors, projects), which vary per person rather than
 * per release.
 *
 * It is attached to every log line of a turn, so a before and an after can be
 * separated by filtering on it. And `test/eval` stamps it, so changing the prompt
 * is a deliberate two-line act that shows up in the diff, not a side effect of an
 * unrelated edit.
 *
 * Computed on first use rather than at import: this module sits in three import
 * cycles (ARCH-008), and evaluating at import is the exact thing that makes one
 * of those break.
 */
let promptVersionCache = null;
export function promptVersion() {
  if (promptVersionCache) return promptVersionCache;
  const variants = [
    { workerOnline: false, policy: 'guarded' },
    { workerOnline: true, worker: { info: { platform: 'win32', desktop: true } }, policy: 'guarded' },
    { workerOnline: true, worker: { info: { platform: 'linux' } }, policy: 'auto' },
    { workerOnline: false, policy: 'readonly' },
    { workerOnline: false, policy: 'plan' },
  ];
  const text = variants
    .map((v) => buildSystemPrompt(v).replace(/^Current date: .*$/m, ''))
    .join('\n\0\n');
  promptVersionCache = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  return promptVersionCache;
}

/**
 * Only `policy` and `workerOnline` shape every prompt; the rest describe what
 * this account has connected, and are absent for a fresh one — which is also
 * how `promptVersion` calls it.
 *
 * @param {{
 *   workerOnline?: boolean,
 *   worker?: any,
 *   policy?: string,
 *   extra?: string,
 *   skills?: string,
 *   connectors?: string,
 *   project?: string,
 *   mcpServers?: Array<{ id: string, tools?: number, error?: string }>,
 * }} options
 */
export function buildSystemPrompt({ workerOnline, worker, policy, extra, skills, connectors, project, mcpServers }) {
  const lines = [
    'You are Synapse — an agentic assistant the user drives from their phone, tablet, or laptop.',
    'Work autonomously: use your tools to find things out rather than asking the user to look them up.',
    '',
    '## Environment',
  ];

  if (workerOnline) {
    lines.push(
      `Your filesystem and shell tools act on the user's real computer (${worker?.info?.platform || 'unknown OS'})${
        worker?.local ? '' : ', reached through a worker they are running'
      }.`,
      `Workspace root: ${worker?.info?.workspace || 'unknown'}. Relative paths resolve from there.`,
      worker?.info?.fullDisk
        ? 'Full-disk access is enabled: absolute paths anywhere on the machine work. Stay inside the workspace unless the task genuinely requires otherwise, and say so when you step outside it.'
        : 'The file tools cannot leave the workspace. `run_command` is not restricted that way, so do not use the shell to work around the limit — if a task truly needs a file elsewhere, ask.',
      `Shell: ${worker?.info?.shell || 'system default'}.`,
      '',
      '### Two browsers, and they are not the same thing',
      'The **sandbox** (`browser_*`) is a separate browser window that belongs to you. You can read it, click it, type into it, and close it. The user watches it live in the panel.',
      "Their **own browser** (`open_url`) is where their logins and their tabs are. Handing it a page is a one-way door: you cannot see it, act on it, or close it.",
      'Default to the sandbox. Reach for `open_url` only when they clearly want the thing for themselves — something to watch properly, or a page that needs their login.',
      'Say which one you used, in those words. "I opened it in your browser" and "I opened it in the sandbox" mean different things to them, and only one of them can be undone by you.',
      'If they ask you to close or stop something you opened with `open_url`, be straight: that tab is theirs. Offer to close the window with the desktop tools if you have them, or ask them to close it.',
      '',
      'Driving the sandbox: `browser_look` before every click, because only what is on screen is listed and the page moves under you.',
      'Click and type by the number in square brackets. If a number is gone, look again rather than guessing.',
      'A dropdown needs `browser_select` — clicking one opens a list the page cannot see, so a click will never set it. A wrong turn needs `browser_back`, not re-opening the previous URL.',
      'The listing covers embedded frames as well as the top page — many business applications put their real forms in one — so a control listed there is a control you can act on.',
      '',
      '**A sign-in page is a stop sign.** The moment you land on one — a login form, a verification code, a CAPTCHA, a phone prompt — stop and hand it over. Do not try passwords you found lying about, do not hunt for a way around it, do not write a script to read their mail. One short message: which page you are on, what you need, and what you will do the moment it is done.',
      ...(worker?.local
        ? [
            'They can do it themselves right there: the panel is a live browser and they can click and type in it. Say so, then `browser_wait` a few seconds and `browser_look` to carry on from wherever they left it.',
            '',
          ]
        : [
            'Say what you need plainly, then wait rather than asking again.',
            '',
          ]),
      '**Never send the same message twice.** If you have already asked for something and their reply does not contain it, do not repeat yourself — `browser_look` first, because the page may have moved on without you, and say what you can see now. Repeating a request word for word is how an assistant becomes useless.',
      '',
      '**Work it like a person, not like a URL bar.** Go to the site, type in its search box, click the result you want. Do not assemble query-string URLs to skip steps — the user is watching, they asked for an assistant rather than a redirect, and a page reached by clicking is the page a person would have got.',
      '`browser_open` is for arriving somewhere; everything after that should be looking, clicking and typing.',
      '',
      "**Tabs are real, and opening a page keeps the old one.** `browser_open` makes a new tab by default, so a lookup never destroys a form you had half filled in or a video somebody was listening to. Work across several at once when that is the natural shape of the job — the reference open in one tab, the form you are filling in another. `browser_tabs` lists them, `browser_switch` moves between them, `browser_close_tab` closes one without touching the rest, and `replace_tab: true` reuses the current one when you are genuinely finished with it. The user sees the tabs in the panel and can press one to move you.",
      'When they want to *watch* something, open it and then `browser_wait` — that keeps the picture moving for them instead of finishing instantly with nothing to see.',
      "The sandbox window sits off the edge of their desktop, so it never covers what they are doing, but its sound comes out of that machine's speakers — a video really does play, and they hear it.",
      '',
      '### The machine itself',
      'These work on every platform, and reaching for them without being asked is most of what makes you useful rather than merely capable.',
      '`clipboard_read` when they say "this", "that link", "what I just copied" — read it instead of asking them to paste it again.',
      '`clipboard_write` for anything they are going to paste somewhere: a command, a block of text, a password they asked you to generate. Do not print a wall of text and leave them to select it.',
      '`notify` when something long finishes and they have looked away. One line. It is a nudge, not a substitute for your reply — say the same thing properly in the chat.',
      '`system_stats` before you blame anything else for a machine being slow, and `process_list` before `process_kill`, so you stop the process you meant rather than one that shares its name.',
      '**Anything that is not meant to finish goes to `run_background`, not `run_command`** — a dev server, a watcher, a tunnel. `run_command` kills it at the timeout, so you would report starting something that is already dead. Read it with `run_background_logs` before claiming it is up, and stop what you started before you finish.',
      '`download_file` for anything that is not text — an image, an archive, a spreadsheet somebody linked. `web_fetch` gives you words, which is no use for a file.',
      '`export_pdf` prints a real PDF through the browser on their machine, so accents come out right. That is a file on their disk; `create_file` puts one in the conversation. Say which you did.',
      'Killing a program takes its unsaved work with it. Name what you are about to stop and wait, unless they asked for exactly that.',
      '',
      '### Their own documents',
      '`search_docs` searches what they have indexed by meaning, not by keyword. **Search before you say you do not know something about their work** — the answer is often already on their disk.',
      'It is not `grep`. Ask it a question in words; "what did we agree about the deposit" finds the paragraph that never uses the word.',
      'Always cite the file you answered from. A passage with no source is indistinguishable from something you made up.',
      '`index_folder` is what puts a folder in reach, and it reads every document in it — say which folder before you start, and prefer the narrow one.',
      'If a search finds nothing, `list_indexed` tells you whether the folder was never indexed or simply has no match. Those need different replies.',
    );

    if (worker?.info?.desktop) {
      lines.push(
        '',
        '### Their actual desktop',
        'The `desktop_*` tools drive real applications on the machine — the same mouse and keyboard the user has.',
        'This is not a sandbox. There is one screen and one keyboard, and you are sharing them with a person.',
        'Work from `desktop_windows` or `desktop_launch`, then act on the numbers from the listing.',
        'Numbers belong to the window they were read from. After anything that may have changed the screen, `desktop_look` again — a stale number in a different window is a real control that will really be pressed.',
        'Prefer `ref` over coordinates, and `desktop_key` over hunting for a menu: "ctrl+s" is more reliable than finding Save.',
      'Some desktops list no controls at all — X11 has no element tree. When the listing is empty that is the answer, not a reason to look again: work by coordinate from what you can see, and by keyboard shortcut, and say that is what you are doing.',
        'Never close a window with unsaved work without saving or asking first.',
        'Use the browser sandbox for anything on the web — it is contained, and it does not fight the user for their screen.',
      );
    }
  } else {
    lines.push(
      "No worker is connected, so you have no access to the user's filesystem or shell right now.",
      'Only the web and memory tools are available. If a request genuinely needs local access, say so plainly and tell the user to start the worker on their computer.',
    );
  }

  /**
   * Say which servers are plugged in, and say when one is broken.
   *
   * A model that can see `mcp__figma__get_file` but has not been told Figma is
   * connected will not think to reach for it. And a server that failed to start
   * has to be *named*: without this its tools are simply absent, and the model
   * concludes the task is impossible rather than that something is misconfigured —
   * which is the difference between "I cannot do that" and "your Figma server is
   * not starting, here is what it said".
   */
  if (mcpServers?.length) {
    const working = mcpServers.filter((s) => !s.error);
    const broken = mcpServers.filter((s) => s.error);
    lines.push('', '## Connected MCP servers');
    if (working.length) {
      lines.push(
        `Plugged in, with their tools prefixed \`mcp__<server>__\`: ${working
          .map((s) => `${s.id} (${s.tools} tools)`)
          .join(', ')}.`,
        'These come from outside this app, so every one of them stops for approval before it runs. You have the description the server gave and nothing else — read it before calling.',
      );
    }
    if (broken.length) {
      lines.push(
        `**Not working right now:** ${broken.map((s) => `${s.id} — ${s.error}`).join('; ')}.`,
        'Their tools are missing for that reason, not because the task is impossible. Say so plainly if the user asks for something one of them would have done.',
      );
    }
  }

  if (skills) lines.push('', '## Skills they have taught you', skills);
  if (connectors) {
    lines.push(
      '',
      '## Connected services',
      `This account has connected: ${connectors}. Use those tools rather than asking them to fetch things by hand.`,
    );
  }

  // Skipped under the two looking-only policies, where these tools are not
  // offered at all — describing an ability the model does not have is how it
  // ends up apologising for failing to use one.
  if (policy !== 'readonly' && policy !== 'plan') {
    lines.push(
      '',
      '## Documents',
      '- When they ask for a report, a quotation, a plan, a set of figures or a deck, make the file with `create_file` rather than pasting it into the reply. They can preview it and download it from the message.',
      /**
       * The conventions are in a skill rather than here.
       *
       * `create_file` writes Word, Excel and PowerPoint, and its description says
       * so — but the rules that make the output good (a heading above a table
       * starts a new sheet; a blockquote under a slide is the speaker notes) are
       * thousands of tokens and belong nowhere near every request. So they live in
       * the built-in skills, and this is the line that gets them read.
       */
      '- **Read the matching skill before you write the file**, the first time in a conversation: `skill_read` with "docx", "xlsx", "pptx", "pdf" or "artifact". They carry the conventions of each format — a heading above a table starts a new sheet, a blockquote under a slide becomes the speaker notes — and none of that is guessable from the tool description.',
      '- A picture that belongs inside your explanation is `show_widget`, not a file: a flow chart of what you found, a chart of four numbers. It draws inline where you called it. Something they will keep or come back to is a file.',
      '- Word, Excel, PowerPoint, Markdown, text, CSV, HTML and JSON. You write Markdown either way; the format decides what it becomes.',
      '- Changing something you already made is `update_file` on the same id. A second nearly-identical file is how the wrong version gets sent to somebody.',
      '- No PDFs. Make it a .docx or .html and say the viewer has Print → Save as PDF — that goes through their browser, which has the fonts and gets the accents right.',
      '- For a small tool, a chart, a calculator or a mock-up, `create_file` with `format: "html"` and real markup makes something they can **run** in the chat. One self-contained page: inline styles and script, nothing fetched from the internet — it runs sandboxed with no network and no access to their session.',
      '- Code goes in code files — `js`, `py`, `sql`, `sh` and the rest — rather than in a fenced block in your reply, whenever it is something they will keep or run.',
      '- `create_file` puts a file in the conversation; `write_file` puts one on their disk. They are different requests and it is worth being clear which you did.',
    );
  }

  lines.push(
    '',
    '## How to work',
    /**
     * Both halves, because only one of them used to be here.
     *
     * The line was "for anything beyond a couple of steps, call `update_plan`",
     * which says when to plan and never says when not to. That is the half that
     * decides how the app feels: a model with no stopping rule either plans for
     * everything — a three-item checklist above a one-sentence answer, and the
     * whole list resent on every update — or, reading "a couple" as vague
     * permission, never plans at all. Both were happening.
     *
     * So the rule is a countable test rather than an adjective, and the negative
     * case is spelled out with the reason it matters, because "do not overuse
     * it" is not something a model can act on.
     */
    '- **Plan when the work is a job, not an answer**: three or more steps you can name up front, of different kinds — read, then change, then check; several files; several sites. Call `update_plan` first and keep it moving; the user watches it fill in while they wait.',
    '- **Do not plan when the reply is the answer**: a question, a lookup, one edit, something already in front of you. A checklist there is furniture they must read first, and short work is finished faster than it is planned.',
    '- Steps are outcomes in their language, three to eight of them — "Rebuild the calibrated model", not "call run_command". Fifteen means you are listing keystrokes.',
    '- Exactly one step `in_progress`, moved as you finish each. Still showing step 1 while you are on step 4 is worse than no plan, because they read it to find out where you are. If the work turns out different, resend the list with what actually applies and say what changed.',
    '- Read before you write. Never edit a file you have not read in this conversation.',
    '- Prefer `edit_file` over `write_file` when changing part of a file, and `multi_edit` over several `edit_file` calls on the same file — it is one round trip, and it writes nothing at all if any edit fails to match.',
    '- Search the web whenever the answer depends on current information; do not answer from memory on things that change.',
    '- Save durable facts and user preferences with `memory_write` so future conversations start informed, and `memory_delete` one that has gone stale — a note you leave behind is read into every future conversation. Never write a credential into a note.',
    '- When they teach you how they want a recurring job done, save it with `skill_write` rather than letting it evaporate with the conversation.',
    '- Run tools that do not depend on each other in the same turn — they execute together.',
    '- For a job that fans out — several files to read, several sites to check — send the parts to `run_parallel` instead of grinding through them one at a time. Only for parts that do not depend on each other.',
    '',
    '## Communicating',
    "- The user reads your text between tool calls; they cannot see tool output unless you say it. Lead with the outcome.",
    '- Report faithfully: if a command failed, say so and show the relevant output. Do not claim work you did not verify.',
    '- Keep it readable and concise. Complete sentences, no arrow chains or invented shorthand.',
    /**
     * Said explicitly because some models will not do it on their own.
     *
     * Several open-weight models — particularly the ones trained mostly on
     * Chinese — drop a Chinese word into the middle of a Vietnamese or English
     * sentence. It happens at the token level, so no instruction can fully
     * prevent it, but an instruction cuts it down a great deal and costs
     * nothing. When it still happens, the model is the thing to change.
     */
    '- Reply in the language the user wrote in, and stay in it for the whole reply. Do not slip words of another language — Chinese especially — into a sentence. If a term genuinely has no equivalent, keep the English one.',
    '- Write tables as Markdown pipe tables with a `|---|---|` line under the header, and leave a blank line before the table. Never draw a table with spaces or box characters.',
    '',
    '## Sending things to other people',
    '- `send_email`, `slack_post`, `telegram_send`, `meta_page_post` and `github_write` reach an audience that is not the person you are talking to, and none of them can be recalled.',
    '- Read the recipient and the exact wording back first and wait for a yes, unless they asked for precisely this. Every one of these stops for approval anyway — do not treat that prompt as a formality to be talked past.',
    '- After it goes, say plainly what was sent and to whom. If it failed, say it failed; never describe an email as sent when the send returned an error.',
    '',
    '## They can interrupt you',
    '- A new message may arrive while you are working. Treat it as the current instruction and adjust immediately.',
    '- If it contradicts what you were doing, stop that and follow the new one — do not finish the old task first out of tidiness.',
    '- Acknowledge the change in a sentence so they know you heard it.',
  );

  lines.push('', '## Permission');
  if (policy === 'readonly') {
    lines.push('The user has set a read-only policy: you can inspect but not modify anything.');
  } else if (policy === 'plan') {
    // Read-only with a job attached. Without saying what the job is, the model
    // reads the missing tools as a failure and apologises for what it cannot
    // do, instead of doing the thing the mode exists for.
    lines.push(
      'The user has asked for a plan, not the work. The tools that change anything are not available to you in this mode — that is deliberate, not a fault to report or work around.',
      'Investigate properly first: read the files, run the read-only commands, find out how things actually are rather than guessing.',
      'Then hand back a plan — what you would change, in which files, in what order, and anything you found that makes the request harder than it sounds.',
      'Use `update_plan` for the steps so the user can watch it take shape. Do not ask for permission to proceed; they will switch modes when they want the work done.',
    );
  } else if (policy === 'ask') {
    lines.push(
      'The user approves every action that changes their machine. A denial is a decision — adapt rather than retrying the same call.',
    );
  } else if (policy === 'auto') {
    lines.push(
      'Nothing is gated: every tool call runs the moment you make it, including destructive ones.',
      'That trust is the user\'s to give and yours to be careful with. Re-read before you overwrite, and say plainly what you changed.',
    );
  } else {
    lines.push(
      'Ordinary work runs without asking — reading, editing inside the workspace, driving the browser, everyday shell commands.',
      'Anything destructive or outside the workspace stops for a yes: deleting, overwriting system paths, closing a window with unsaved work.',
      'So do not ask permission in prose for things you can simply do; the user chose not to be asked. When something genuinely does stop, a denial is a decision — adapt rather than retrying the same call.',
    );
  }

  /**
   * The boundary between what you were told and what you read.
   *
   * Placed before the user's own instructions and before the project, so that
   * everything after it is read in its light — and stated once, in the stable
   * part of the prompt, so it is cached rather than repeated per tool result.
   */
  lines.push('', UNTRUSTED_RULE);

  if (extra?.trim()) lines.push('', '## User instructions', extra.trim());

  // Last, and deliberately: a project's sources are what this particular
  // conversation is about, and they sit closest to the question being asked.
  if (project?.trim()) lines.push('', project.trim());

  lines.push('', `Current date: ${new Date().toISOString().slice(0, 10)}.`);
  return lines.join('\n');
}

const newId = () => crypto.randomUUID();

/**
 * How long the provider may say nothing before the interface says so.
 *
 * Long enough that an ordinary fast reply never shows it — a model that answers
 * in two seconds should not be narrated — and short enough to arrive well before
 * somebody decides the app is broken and reloads the page, which is the thing
 * this exists to prevent.
 */
const WAIT_NOTICE_MS = 6000;

/**
 * Attach the resolved file parts to the messages that carry them.
 *
 * The provider adapters read `m.parts`; nothing else in the loop knows or cares.
 * Messages without attachments are handed back untouched rather than copied, so
 * the common case costs nothing.
 */
/**
 * Which providers can be handed a PDF as a PDF.
 *
 * Not a model capability but a wire-format one: these two have a document part
 * in their protocol and the OpenAI shape simply does not, whatever model is
 * behind it. Everything else reads the extracted text instead.
 */
const READS_PDF = new Set(['anthropic', 'google']);
export const readsPdfNatively = (entry) => READS_PDF.has(entry?.provider);

function withAttachments(messages, loaded, entry) {
  const vision = entry?.vision !== false;
  const documents = readsPdfNatively(entry);
  return messages.map((m) =>
    m.attachments?.length ? { ...m, parts: toParts(m, loaded, { vision, documents }) } : m,
  );
}

/**
 * Put the transcript into an order the providers accept.
 *
 * A message sent while tools are running lands, by timestamp, between the
 * assistant turn that requested them and the results that answer it. Every
 * provider rejects that: a tool result has to follow its own tool call
 * immediately. So new user turns are lifted out and re-inserted after the
 * results, which is also when the model can actually act on them.
 */
/**
 * Attach a project's selected passages to the question they were selected for.
 *
 * They used to live at the end of the system prompt, and that is what killed
 * prompt caching for every project conversation. `selectSources` picks passages
 * by the *current* question, so the system block changed every turn — and since
 * caching is a prefix match over tools, then system, then messages, a system
 * block that changes invalidates the entire transcript behind it as well. The
 * cache breakpoints were there; nothing could ever hit them.
 *
 * Here instead, on the last user turn — the one they were chosen to answer, and
 * the one place they can change freely without disturbing anything cached in
 * front of them. The model reads the same words; only the position moved.
 *
 * Non-destructive: the array is rebuilt and the stored message is never touched,
 * because this is a wire detail and writing it into the transcript would send it
 * again next turn, in the wrong place, with the wrong passages.
 */
export function withProjectSources(messages, passages, images = []) {
  const hasPassages = !!passages?.trim();
  if (!hasPassages && !images.length) return messages;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') continue;
    const copy = [...messages];
    copy[i] = {
      ...messages[i],
      text: hasPassages ? `${passages}\n\n---\n\n${messages[i].text || ''}` : messages[i].text,
      /**
       * The shelf's pictures travel as attachments on this turn.
       *
       * Ahead of the message's own files rather than after them, because
       * `loadForTranscript` keeps the *last* so many and the person's own
       * screenshot is the one they are asking about — a shelf of four diagrams
       * must not push it out of the budget.
       *
       * Non-destructive, like the passages above: the stored message is never
       * touched, so nothing is sent twice or sent again next turn.
       */
      attachments: images.length ? [...images, ...(messages[i].attachments || [])] : messages[i].attachments,
    };
    return copy;
  }
  return messages;
}

export function normaliseOrder(messages) {
  const out = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    out.push(message);
    i += 1;

    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

    // Pull the matching tool message forward past anything that slipped in.
    const interrupted = [];
    while (i < messages.length && messages[i].role !== 'tool') {
      interrupted.push(messages[i]);
      i += 1;
    }
    if (i < messages.length) {
      out.push(messages[i]);
      i += 1;
    }
    out.push(...interrupted);
  }
  return out;
}

/**
 * Which of these calls the user has to say yes to.
 *
 *   auto      nothing — get on with it
 *   guarded   only the ones that could ruin an afternoon (the default)
 *   ask       anything that changes something
 *   plan      nothing gets this far; same tools as readonly, different brief
 *   readonly  nothing gets this far; the tools were never offered
 *
 * `guarded` exists because asking about everything and asking about nothing are
 * both bad in the same way: neither leaves the person any attention for the
 * cases that actually matter.
 */
/**
 * Refuse, rather than run, a call the policy promised could not happen.
 *
 * `needsApproval` below returns nothing for `readonly` and `plan`, and the
 * comment above it says why: "the tools were never offered". That is true of the
 * catalogue and false of the model. A model can name a tool it was not offered —
 * a hallucination, or a page it just read telling it to — and nothing between
 * the stream and `executeTool` checked. So under the two policies a person picks
 * precisely to mean "change nothing", a recursive `delete_file` ran **with no
 * prompt at all**, while the same call under the more permissive `guarded`
 * policy stopped to ask. Measured, not inferred: offered under readonly — false;
 * needs approval — false; `executeTool` finds it — true.
 *
 * Anthropic sets `strict: true` and will not emit an unoffered name. The
 * OpenAI-compatible adapter and Gemini have no equivalent (GAP-004), so this is
 * reachable on the providers this app leans on most.
 *
 * Checked at execution, per call, the same belt-and-braces `subagents.js`
 * already applies for the same reason. Under every other policy this returns
 * null and the ordinary approval rules decide.
 */
export function policyRefusal(call, policy) {
  if (policy !== 'readonly' && policy !== 'plan') return null;
  if (assessRisk(call.name, call.input) === 'safe') return null;
  return {
    toolCallId: call.id,
    name: call.name,
    content:
      `"${call.name}" can change things, and this conversation is set to ${policy === 'plan' ? 'plan' : 'read-only'} mode, `
      + 'so it was not run. Describe what you would do instead, and the user can switch modes if they want it done.',
    isError: true,
    ms: 0,
  };
}

/**
 * Tools whose effect lands on somebody other than the person in the chat.
 */
export const OUTBOUND = new Set(['send_email', 'slack_post', 'telegram_send', 'meta_page_post', 'github_write']);

/** How many of them one turn may send when nobody is asked about each. */
export const OUTBOUND_PER_TURN = 5;

/**
 * Refuse an outbound message past the per-turn allowance, under `auto` only.
 *
 * Every other policy stops for approval before each of these (they are
 * ALWAYS_SENSITIVE), so a person is already counting. Under `auto` nobody is:
 * a page carrying an instruction, or a model stuck retrying, could send the
 * same email forty times in one turn and every one of them is unrecallable.
 * Five is more than any single request plausibly needs, and the refusal tells
 * the model to stop and report rather than to keep trying.
 *
 * `sent` is one object per turn. The check and the increment happen before any
 * await, so calls running in parallel cannot both pass on the last slot.
 *
 * @param {{ id: string, name: string }} call
 * @param {string} policy
 * @param {{ count: number }} sent
 */
export function outboundRefusal(call, policy, sent) {
  if (policy !== 'auto' || !OUTBOUND.has(call.name)) return null;
  if (sent.count < OUTBOUND_PER_TURN) {
    sent.count += 1;
    return null;
  }
  return {
    toolCallId: call.id,
    name: call.name,
    content:
      `${OUTBOUND_PER_TURN} messages have already gone out in this turn without anyone approving them, so "${call.name}" was not run. `
      + 'Stop sending, tell the user exactly what was sent and to whom, and let them ask for more.',
    isError: true,
    ms: 0,
  };
}

export function needsApproval(toolCalls, policy) {
  if (policy === 'auto' || policy === 'readonly' || policy === 'plan') return [];
  return toolCalls.filter((call) => {
    const risk = assessRisk(call.name, call.input);
    if (risk === 'safe') return false;
    return policy === 'ask' ? true : risk === 'sensitive';
  });
}

/**
 * A reply that arrived entirely as reasoning is still the reply.
 *
 * Some models — the free reasoning ones on OpenRouter especially — put
 * everything on the non-standard `reasoning` field and leave `content` empty.
 * The turn then ends with a full, correct answer folded inside a collapsed
 * "Reasoning" block and an empty bubble beside it, which reads as the assistant
 * having said nothing at all. People reasonably conclude the app is broken; the
 * answer was there the whole time, one disclosure triangle away.
 *
 * Only when there is nothing else. A turn with prose has said its piece, and a
 * turn whose point was a tool call is *supposed* to look like thinking followed
 * by an action — promoting that one would paste a private deliberation into the
 * conversation as though it had been addressed to the user. The narrowness is
 * the whole safety of this: it fires exactly when the alternative is showing
 * nothing.
 *
 * `thinking` is cleared rather than copied, so the same words are never shown
 * twice under two headings, and `reasonedAloud` records that this happened —
 * the turn did not come back the way it was written down.
 *
 * @returns whether the promotion happened, so the caller can tell the browser.
 */
export function promoteReasoning(assistant) {
  if (!assistant || String(assistant.text || '').trim()) return false;
  if (assistant.toolCalls?.length) return false;
  if (!String(assistant.thinking || '').trim()) return false;

  assistant.text = assistant.thinking;
  assistant.thinking = '';
  assistant.reasonedAloud = true;
  return true;
}

/**
 * Is this answer about the question that was asked?
 *
 * `decision` was a bare word — `allow` or `deny` — applied to whatever happened
 * to be outstanding when the resume arrived. That is the same batch almost
 * always, and not always. The app mirrors across tabs, so a turn started in a
 * second tab leaves a *different* batch waiting, and a click on the first tab's
 * prompt then approved calls nobody had been shown. The prompt lists every call
 * with its arguments precisely so that the decision is an informed one; a
 * decision that can land on a different set undoes that.
 *
 * So the client sends back the ids it displayed and they have to be the ids
 * still waiting. A mismatch is not an error — it means the screen is out of
 * date — so the caller falls through to asking again, with what is pending now.
 *
 * A missing `decisionFor` counts as a mismatch rather than being waved through.
 * The client ships with this server, so there is no older one to be gentle
 * with, and defaulting the other way would leave the gap open to anything that
 * simply omits the field.
 */
export function answersTheseCalls(toolCalls, decisionFor) {
  if (!Array.isArray(decisionFor)) return false;
  const waiting = (toolCalls || []).map((c) => String(c.id)).sort();
  const answered = decisionFor.map(String).sort();
  return answered.length === waiting.length && answered.every((id, i) => id === waiting[i]);
}

/**
 * Which outstanding calls a resume may run, and what to say about the rest.
 *
 * A resume finds an assistant turn with tool calls and no results, and it used
 * to run every one of them (AUTO-007). But "no results stored" has two causes:
 * the run stopped before the calls started — for approval, or cut off early —
 * or it was killed while they ran, after a tool had done its work and before
 * the results were written. A deployment's function timeout lands in exactly
 * that window, and it is as long as the tools take, which for `run_command` is
 * minutes. Running `send_email` again from there is a second email.
 *
 * `startedCalls`, written just before execution, separates the two. A call that
 * never started runs normally. A call that started and is read-only runs again,
 * because reading twice costs nothing. A call that started and can change
 * something is **not** run again: it gets a result saying it may already have
 * happened, so the model checks rather than repeats. Tools outside the catalogue
 * — MCP — count as able to change something, the same conservative default
 * `assessRisk` uses.
 *
 * Pure, and exported, because the loop around it needs a store, an account and a
 * live model to drive, and this is the decision worth holding still.
 */
export function resumableCalls(toolCalls, startedIds = []) {
  const started = new Set((startedIds || []).map(String));
  const run = [];
  const skipped = [];
  for (const call of toolCalls || []) {
    const readOnly = TOOLS_BY_NAME[call.name]?.readOnly === true;
    if (started.has(String(call.id)) && !readOnly) {
      skipped.push({
        toolCallId: call.id,
        name: call.name,
        content:
          'This call had already started when the previous run was interrupted, so it was not run a second time. '
          + 'It may have completed. Check whether it took effect before trying it again.',
        isError: true,
        ms: 0,
      });
    } else {
      run.push(call);
    }
  }
  return { run, skipped };
}

async function runToolCalls({ user, toolCalls, chatId, emit, signal, deviceHint, onLoadTools, deliverable, policy, sent }) {
  const results = await mapWithLimit(
    toolCalls,
    MAX_PARALLEL_TOOLS,
    async (call) => {
      // The policy's promise, enforced where the call would actually run. See
      // `policyRefusal`.
      const refused = policyRefusal(call, policy) || outboundRefusal(call, policy, sent);
      if (refused) {
        emit('tool_result', refused);
        return refused;
      }
      const started = Date.now();
      emit('tool_call', { id: call.id, name: call.name, input: call.input });
      const { content, isError, file, widget, shot } = await executeTool({
        user,
        name: call.name,
        input: call.input,
        chatId,
        signal,
        deviceHint,
        // So `load_tools` can refuse to promise a tool this account cannot be
        // given, instead of reporting it loaded and never delivering it.
        deliverable,
      });
      const result = {
        toolCallId: call.id,
        name: call.name,
        content,
        isError,
        ms: Date.now() - started,
        // A document the assistant wrote. Stored on the result rather than
        // announced separately, so reopening the conversation rebuilds the card
        // from the transcript instead of needing a second source of truth.
        ...(file ? { file } : {}),
        // A picture drawn into the transcript. Stored on the result for the same
        // reason as `file`: reopening the conversation rebuilds it from here
        // rather than needing somewhere else to have remembered it.
        ...(widget ? { widget } : {}),
        // A thumbnail of what the screen looked like when this step finished.
        // An id, never the bytes — see `keepStepShot`. Stored on the result for
        // the same reason as the two above: scrolling back through a browsing
        // session should show the pictures, and the transcript is the only
        // place that could remember them.
        ...(shot ? { shot } : {}),
      };
      emit('tool_result', result);
      /**
       * The model asked for tools it does not yet have.
       *
       * Recorded on the shared set the loop rebuilds the catalogue from, so they
       * are in the request that goes out on the next step. Nothing is added
       * mid-request — that is not something any provider allows — and nothing
       * needs to be: the next step carries more than the last one did.
       */
      if (call.name === 'load_tools' && !isError && onLoadTools) {
        onLoadTools(Array.isArray(call.input?.names) ? call.input.names : []);
      }
      if (call.name === 'update_plan' && !isError) {
        // Normalised through the same function the tool answered with, so the
        // panel and the model never disagree about what the plan is. A list too
        // short to be a plan draws nothing — see PLAN_MIN_STEPS.
        const steps = normalisePlan(call.input?.steps);
        if (steps.length >= PLAN_MIN_STEPS) emit('plan', { steps });
      }
      return result;
    },
  );
  return { id: newId(), role: 'tool', results };
}

/**
 * Drive one turn to completion, streaming events out through `emit`.
 *
 * The loop is resumable: state lives in the database after every step, so if a
 * serverless invocation is cut short — or the user has to approve a tool — the
 * client can reconnect and call this again to pick up exactly where it stopped.
 *
 * @param decision  'allow' | 'deny' when resuming from an approval prompt
 */
/**
 * Fold one stream event into the assistant turn being built.
 *
 * Only the two events that touch the draft prose live here, and they are
 * together because they are opposites: one adds to it, the other throws it
 * away. `retry` means the provider is starting this reply again on another key,
 * so what has been sent is being *replaced* rather than continued — and this
 * draft is what gets persisted at the end of the turn, so a version that kept
 * its discarded half would be stored and then read as one reply.
 *
 * Pulled out of the loop so that can be tested without standing up a provider.
 */
export function applyStreamEvent(ev, assistant, emit) {
  if (ev.type === 'text') {
    assistant.text += ev.delta ?? '';
    emit('text', { delta: ev.delta });
  } else if (ev.type === 'retry') {
    /*
     * The whole attempt is abandoned, reasoning included. Only the text used to
     * be cleared, so the discarded attempt's thinking stayed and the next
     * attempt's was appended onto it — stored that way, and shown that way, as
     * one reasoning trace that argues with itself halfway through (CODE-018).
     */
    assistant.text = '';
    assistant.thinking = '';
    emit('retry', { reason: ev.reason || '' });
  }
  return ev;
}

/**
 * @param stream  the provider call, injectable so the loop can be driven in a
 *   test with no network — see `compact()` and `runParallel` for the same seam.
 *   Defaults to the real `streamCompletion`.
 */
export async function runAgent({ userId, user, chatId, modelId, decision, decisionFor, emit, signal, deviceHint, policy: policyOverride = null, stream = streamCompletion }) {
  const store = getStore();
  const prefs = await getPrefs(userId);

  const chat = await store.getChat(userId, chatId);
  if (!chat) throw new Error('Chat not found.');

  /**
   * One model for the whole account, not one per conversation.
   *
   * `chat.model` is still recorded — it is useful history of what a conversation
   * was started on — but it is deliberately not consulted here. Reading it made
   * the stored value a second, competing setting: the header chip and Settings →
   * Models showed two different names, both live, with no way to tell from
   * looking which one the next turn would actually use.
   *
   * `modelId` is still honoured, because that is an explicit per-request override
   * (a sub-agent, a scheduled task) rather than a stale preference.
   */
  let messages = await store.listMessages(userId, chatId);

  /**
   * Resolve the model, expanding the special `auto` id to OpenRouter's free
   * router, which picks a free model per request — including one that reads
   * images when the turn carries one. Checked per turn because keys go into and
   * come out of cooldown. With no usable OpenRouter key the turn stops with a
   * plain message rather than quietly falling back to a paid model.
   */
  const wantModel = modelId || prefs.defaultModel;
  let entry;
  if (isAuto(wantModel)) {
    entry = await pickAutoModel(userId);
    if (!entry) {
      emit('error', { message: NO_AUTO_MESSAGE, code: 'no_auto_model' });
      emit('done', { stopReason: 'no_auto_model' });
      return;
    }
  } else {
    entry = await resolveModelId(wantModel);
  }

  // Refuse before spending anything, and say plainly how to lift the cap.
  const usingSharedKey = await usesSharedKey(userId, entry.provider);
  const quota = await checkQuota(user, { usingSharedKey });
  // Per turn, alongside the monthly quota above. See `turnTokenLimit`.
  const turnLimit = turnTokenLimit({ usingSharedKey });
  let turnTokens = 0;
  if (!quota.allowed) {
    emit('error', { message: quota.reason, code: 'quota_exceeded' });
    emit('done', { stopReason: 'quota_exceeded' });
    return;
  }

  // A built-in the provider has shut down resolves to its replacement; say so,
  // rather than let the model — and the bill — change without a word. See
  // RETIREMENTS in providers/catalog.js.
  if (entry?.retiredFrom) {
    emit('status', { message: `${entry.retiredFrom} has been shut down by its provider, so this is using ${entry.label} instead.` });
  }

  // The question decides which passages of a long shelf are worth sending, so
  // the sources are chosen after the transcript is known rather than before.
  const asked = [...messages].reverse().find((m) => m.role === 'user')?.text || '';

  const [worker, skills, connectors, project, providerKeys, mcp] = await Promise.all([
    workerStatus(user, prefs),
    skillMenu(userId),
    connectorSummary(userId),
    projectPrompt(userId, chat, asked),
    providerStatus(userId),
    // Never allowed to fail the turn. One unreachable server must not take the
    // assistant's own tools away with it — `mcpTools` records the failure and
    // carries on, and this catch is the belt to that braces.
    mcpTools(userId).catch(() => ({ tools: [], servers: [] })),
  ]);
  const workerOnline = worker.online;
  /**
   * The account's setting, unless this particular run was given one.
   *
   * A scheduled task carries its own: it runs with nobody watching, so "pause
   * and ask" and "never pause" are genuinely different decisions and the person
   * who made the task is the one who should make them. Interactive turns pass
   * nothing and keep the account default, exactly as before.
   */
  const policy = policyOverride || prefs.toolPolicy;

  // Every line this turn logs from here on carries the prompt version, so a
  // change to the prompt can be measured by filtering on it. See `promptVersion`.
  annotate({ promptVersion: promptVersion() });
  const system = buildSystemPrompt({
    workerOnline,
    worker,
    policy,
    extra: prefs.systemPrompt,
    skills,
    connectors: connectors.summary,
    // The briefing only — stable across the whole conversation, so the cached
    // prefix stays cached. The passages this question selected travel in the
    // conversation instead; see `withProjectSources`.
    project: project?.briefing,
    mcpServers: mcp.servers,
  });
  /**
   * Tools the model has asked for this turn.
   *
   * The catalogue is re-sent on every request of every step, so its size is paid
   * per step rather than per turn — about 12,000 tokens, of which roughly half
   * describes things a given turn was never going to touch. The rarely-used half
   * is withheld and listed by name in `load_tools` instead; when the model asks
   * for something, it goes in here and the catalogue is rebuilt before the next
   * step.
   *
   * Rebuilding per step is what makes this work on every provider rather than
   * only the one with a native mechanism for it: nothing is added mid-request,
   * the next request simply carries more.
   */
  const activated = new Set();
  /** Outbound messages sent this turn without a prompt. See `outboundRefusal`. */
  const sent = { count: 0 };
  const buildTools = () => availableTools({
    workerOnline,
    desktopOnline: !!worker?.info?.desktop,
    policy,
    activated,
    // So a connector tool that cannot work is never offered, and so the
    // catalogue is cut down to fit a genuinely small window rather than eating
    // it. See `availableTools`.
    connected: connectors.ids,
    // So `generate_image` is not advertised to an account that has no Google key
    // and therefore no way to make a picture.
    providers: Object.entries(providerKeys)
      .filter(([, status]) => status?.configured)
      .map(([provider]) => provider),
    context: entry.context,
    // Tools from outside this repository, already in the same shape.
    extra: mcp.tools,
  });

  /** Take the names `load_tools` asked for, so the next step carries them. */
  const activate = (names) => {
    for (const name of names) if (typeof name === 'string') activated.add(name);
    log.info('tools activated', { names: names.join(','), total: activated.size });
  };

  /**
   * Every tool this account could actually be given this turn.
   *
   * `load_tools` used to check only that a name was a real tool, so it happily
   * answered "Loaded send_email — you will have it from your next step onward"
   * for a connector that was never linked, and the tool then never appeared.
   * The model planned around a capability it could not receive.
   *
   * Derived by asking `availableTools` with everything activated, so it is
   * filtered by the *same* worker, connector, provider and policy rules that
   * decide the real catalogue — the two cannot drift, because there is one
   * function deciding both. `context: 0` means "nobody said", which switches off
   * the window-based trimming: this is a question about eligibility, not about
   * what fits.
   */
  const loadable = () =>
    new Set(
      availableTools({
        workerOnline,
        desktopOnline: !!worker?.info?.desktop,
        policy,
        connected: connectors.ids,
        providers: Object.entries(providerKeys)
          .filter(([, status]) => status?.configured)
          .map(([provider]) => provider),
        context: 0,
        extra: mcp.tools,
      }).map((t) => t.name),
    );

  /**
   * `priced` says whether the running cost is worth showing at all, and
   * `estimated` whether it is our arithmetic or the provider's own invoice.
   * Both travel to the browser so the usage line can say which it is rather
   * than presenting a guess with the confidence of a receipt.
   */
  const totals = { input: 0, output: 0, cost: 0, cacheRead: 0, estimated: false };

  // ── Resume: the previous run ended with tool calls still outstanding ──
  // Either it stopped for approval, or the connection was cut mid-run.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    // Re-check the policy rather than trusting that a decision was made. A run
    // cut short before it could ask must still ask on resume.
    const stillPending = needsApproval(last.toolCalls, policy);

    const answersThis = answersTheseCalls(last.toolCalls, decisionFor);

    if (stillPending.length && !(answersThis && (decision === 'allow' || decision === 'deny'))) {
      emit('approval_required', {
        toolCalls: last.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          needsApproval: stillPending.some((p) => p.id === c.id),
          reason: riskReason(c.name, c.input),
        })),
      });
      return;
    }

    let toolMessage;
    if (decision === 'deny') {
      toolMessage = {
        id: newId(),
        role: 'tool',
        results: last.toolCalls.map((c) => ({
          toolCallId: c.id,
          name: c.name,
          content: 'The user declined this action. Do not retry it; take a different approach or ask what they want instead.',
          isError: true,
          ms: 0,
        })),
      };
      for (const r of toolMessage.results) emit('tool_result', r);
    } else {
      // Never started runs; started and read-only runs again; started and able
      // to change something does not. See `resumableCalls`.
      const { run, skipped } = resumableCalls(last.toolCalls, last.startedCalls);
      for (const r of skipped) emit('tool_result', r);

      await store.markToolCallsStarted(userId, chatId, last.id, run.map((c) => c.id));
      const ran = run.length
        ? await runToolCalls({ user, toolCalls: run, chatId, emit, signal, deviceHint, onLoadTools: activate, deliverable: loadable(), policy, sent })
        : { id: newId(), role: 'tool', results: [] };

      // Back into the order the model asked for them, which is the order it will
      // read the results in.
      const byId = new Map([...skipped, ...ran.results].map((r) => [String(r.toolCallId), r]));
      toolMessage = { ...ran, results: last.toolCalls.map((c) => byId.get(String(c.id))).filter(Boolean) };
    }
    /*
     * Not written by a run that was superseded mid-way. The invocation that took
     * the lease is resuming this same turn, and it will write this turn's results
     * itself — two tool messages answering one assistant turn is a transcript no
     * provider accepts (AUTO-008).
     */
    if (signal?.reason === 'superseded') {
      emit('done', { stopReason: 'aborted' });
      return;
    }
    // The stored copy, which carries the `seq` `absorbNewMessages` reads as its
    // high-water mark.
    messages.push(await store.appendMessage(userId, chatId, toolMessage));
  }

  /**
   * Pick up anything the user sent while we were working.
   *
   * The store is the source of truth — every assistant and tool turn is written
   * before the next step — so re-reading it is how a new instruction reaches the
   * model. This is what lets someone change their mind mid-task instead of
   * waiting for the run to finish.
   */
  async function absorbNewMessages() {
    /**
     * Ask only for what is newer than the highest turn already in hand.
     *
     * This used to re-read the whole conversation — every message body, tool
     * result included — once per step, purely to discover whether one new user
     * message had arrived, and then throw all but that away. On a thirty-step
     * turn that moved the entire transcript thirty times.
     *
     * Messages appended in this process carry a `seq` from `appendMessage`, so
     * the high-water mark is simply the largest one seen. A message with no
     * `seq` cannot move the mark (`|| 0`), and a mark of 0 asks for everything —
     * which is the correct answer for a conversation nothing has been stored in
     * yet.
     */
    const known = new Set(messages.map((m) => m.id));
    const highWater = messages.reduce((n, m) => Math.max(n, Number(m.seq) || 0), 0);
    const fresh = await store.messagesSince(userId, chatId, highWater);
    const added = fresh.filter((m) => m.role === 'user' && !known.has(m.id));
    if (!added.length) return false;

    messages = normaliseOrder([...messages, ...added]);
    for (const m of added) emit('steer', { text: m.text });
    return true;
  }

  for (let step = 0; step < prefs.maxSteps; step += 1) {
    if (signal?.aborted) {
      emit('done', { stopReason: 'aborted' });
      return;
    }

    // Checked before the next request, not after: the point is not to send it.
    if (turnLimit && turnTokens >= turnLimit) {
      /**
       * Said on `done`, not as a passing status line.
       *
       * It used to be a `status` event, which the browser shows as a toast —
       * gone in three seconds, leaving a turn that appears to have stopped for
       * no reason. It is the opposite of passing information: the one thing
       * somebody needs to know about this turn is why it is not finished.
       */
      const stop = budgetStop(
        'token_limit',
        `Stopped after ${turnTokens.toLocaleString()} tokens in this turn. Send a message to continue.`,
      );
      emit('done', { stopReason: 'token_limit', stop });
      return;
    }

    await absorbNewMessages();

    /**
     * Fold the older turns up before they stop fitting.
     *
     * Done here, at the top of a step, because this is the one place where the
     * transcript is complete and nothing is half-written — and because doing it
     * *before* the request is what makes it work at all. Waiting until the
     * provider refuses means the compaction call has no room either.
     */
    if (prefs.autoCompact !== false && shouldCompact(messages, entry)) {
      emit('status', { phase: 'compacting' });
      try {
        const summary = await compact({
          userId,
          chatId,
          entry,
          prefs,
          messages,
          signal,
          // Said as soon as the count is known, which is before the request
          // goes out: "folding 24 earlier turns" is a great deal more settling
          // than a spinner while the conversation appears to stall.
          onProgress: (p) => emit('status', { phase: 'compacting', ...p }),
        });
        if (summary) {
          messages.push(summary);
          emit('compacted', { replaced: summary.replaced, text: summary.text });
        }
      } catch (err) {
        // A conversation that cannot be summarised is still a conversation. Let
        // the turn proceed and fail on its own terms, which at least says what
        // the actual limit was.
        log.error('compaction failed', err, { step: step + 1 });
      }
    }

    emit('context', measure(messages, entry));
    emit('status', { phase: 'thinking', step: step + 1, model: entry.label });

    const assistant = { id: newId(), role: 'assistant', text: '', thinking: '', toolCalls: [] };
    let done = null;
    /** What to book once the reply itself is safely stored. See below. */
    let pendingUsage = null;

    /**
     * Say when the provider has not started answering yet.
     *
     * "Thinking…" was shown from the moment the request left, and it stayed
     * there whether the model was producing reasoning tokens or had not yet been
     * given a slot. Those look identical to somebody watching and they need
     * different reactions: one is working, the other is a queue you may not want
     * to wait in.
     *
     * They are not rare, either. A free model on a busy aggregator can sit
     * unanswered for a minute, and a rate limit puts this loop into a wait of up
     * to another minute on top — with the interface saying the same reassuring
     * word throughout. That is the difference between "it is slow" and "it is
     * broken" and the app was refusing to tell anybody which.
     *
     * Once the first token of anything arrives this stops for good: a model that
     * has started and then pauses mid-sentence is thinking, and interrupting
     * that with a progress notice would be noise.
     */
    let started = false;
    const waitedFrom = Date.now();
    const waiting = setInterval(() => {
      if (started) return;
      emit('status', {
        phase: 'waiting',
        seconds: Math.round((Date.now() - waitedFrom) / 1000),
        model: entry.label,
        free: entry.price?.in === 0,
      });
    }, WAIT_NOTICE_MS);
    waiting.unref?.();

    try {
      // Attachment bytes are fetched here rather than carried in the transcript:
      // a conversation is re-read on every step, and dragging megabytes of
      // base64 through each one to send them once is pure cost. Older files fall
      // out of the budget and become a line of prose naming them.
      /**
       * The transcript the model will actually be sent, built before the bytes
       * are fetched rather than after.
       *
       * A project's pictures are attached here, and `loadForTranscript` has to
       * see them to fetch them — it reads `message.attachments`, so attaching
       * them afterwards meant asking for images nobody had loaded.
       */
      const grounded = withProjectSources(
        activeTranscript(normaliseOrder(messages)),
        project?.passages,
        project?.images,
      );
      const loaded = await loadForTranscript(userId, grounded, {
        // Only worth parsing when the model cannot be shown the file itself.
        extractText: !readsPdfNatively(entry),
      });

      for await (const ev of stream({
        userId,
        entry,
        system,
        // Ordered defensively: a mid-run message must never split a tool call
        // from its result.
        // `activeTranscript` is what makes a folded conversation smaller: the
        // page still holds every turn, and only the summary plus what followed
        // it is sent.
        // The project's passages and pictures ride on the question they were
        // chosen for, rather than in the cached system block they used to
        // invalidate. `activeTranscript` is what makes a folded conversation
        // smaller: the page still holds every turn, and only the summary plus
        // what followed it is sent.
        messages: withAttachments(grounded, loaded, entry),
        // Rebuilt per step: anything `load_tools` activated last step is in it
        // now. On a turn that activates nothing this returns the same list every
        // time, so the cached prefix is undisturbed.
        tools: buildTools(),
        effort: prefs.effort,
        signal,
      })) {
        // Anything at all counts as having started — a reasoning token, a tool
        // call, a notice that a key was refused. What is being timed is the
        // silence before the provider says its first word, not the silence
        // before it says something the interface happens to draw.
        started = true;
        if (ev.type === 'text' || ev.type === 'retry') {
          applyStreamEvent(ev, assistant, emit);
        } else if (ev.type === 'thinking') {
          assistant.thinking += ev.delta;
          emit('thinking', { delta: ev.delta });
        } else if (ev.type === 'tool_call_start') {
          emit('status', { phase: 'tool', name: ev.name });
        } else if (ev.type === 'notice') {
          // A key was refused and the next one is being tried. Worth seeing:
          // silent failover is how somebody discovers their first key died a
          // week ago from the bill rather than from the app.
          emit('status', { message: ev.text });
        } else if (ev.type === 'done') {
          done = ev;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        /**
         * Keep what was already said.
         *
         * This returned here, before the `appendMessage` below, so half an
         * answer the user had sat and watched arrive was discarded the moment
         * they pressed stop — gone on reload, and gone from the transcript the
         * next turn is built from. So the next turn re-sent the same question
         * and the account paid for the same reply twice.
         *
         * `toolCalls` are deliberately not carried. They were never completed,
         * never approved, and a stored assistant turn with outstanding calls is
         * what the resume path picks up — so persisting them would turn a stop
         * into a queued action.
         */
        /*
         * Except when this run was superseded. A reconnection that took the
         * lease is already streaming its own reply to the same question, so
         * this fragment would land in the transcript beside the live answer.
         * `app.js` puts the reason on the signal when the heartbeat loses the
         * lease.
         */
        if (assistant.text.trim() && signal?.reason !== 'superseded') {
          assistant.model = entry.id;
          assistant.toolCalls = [];
          assistant.stopped = true;
          await store.appendMessage(userId, chatId, assistant).catch((e) =>
            log.error('stopped reply not saved', e, { chatId }));
        }
        emit('done', { stopReason: 'aborted' });
        return;
      }
      throw err;
    } finally {
      // In a `finally` rather than after the loop: a turn that throws, or one
      // the user stops, must not leave a timer narrating a wait that ended.
      clearInterval(waiting);
    }

    assistant.toolCalls = done?.toolCalls || [];
    if (done?.raw) assistant.raw = done.raw;

    if (promoteReasoning(assistant)) emit('reasoning_was_reply', { text: assistant.text });
    if (done?.usage) {
      assistant.usage = done.usage;
      totals.input += done.usage.input || 0;
      totals.output += done.usage.output || 0;
      totals.cacheRead += done.usage.cacheRead || 0;
      // The provider's own figure where it gave one — OpenRouter and OrcaRouter
      // both do — and our price table where it did not. See `priceTurn`.
      const priced = priceTurn(entry, done.usage);
      if (priced) {
        totals.cost += priced.usd;
        if (priced.source === 'estimate') totals.estimated = true;
      }
      /**
       * Booked *after* the reply is safely stored — see the append below.
       *
       * This used to be awaited here, before `appendMessage`, and uncaught. A
       * connection-pool blip on the usage write threw out of the step loop, the
       * route emitted `error`, and the reply the user had just watched being
       * written was never persisted: gone on reload, and the next turn re-sent
       * their question so the model answered — and charged — a second time.
       * Losing the accounting for one turn is a far smaller harm than losing
       * the turn itself, so the order now reflects that.
       */
      pendingUsage = { chatId, model: entry.id, usage: done.usage, costUsd: priced?.usd || 0, role: 'turn' };
      turnTokens += (Number(done.usage.input) || 0) + (Number(done.usage.output) || 0);
    }
    assistant.model = entry.id;

    // `seq` comes back on the stored copy; see `absorbNewMessages`.
    const stored = await store.appendMessage(userId, chatId, assistant);
    assistant.seq = stored.seq;

    /**
     * Never fatal, but never silent either.
     *
     * `checkQuota` enforces the shared-key monthly limit against this table, so
     * a write that keeps failing is unmetered spend on the deployment's key —
     * swallowing it without a word is how that goes unnoticed for a month.
     */
    if (pendingUsage) {
      await recordUsage(userId, pendingUsage).catch((err) =>
        log.error('usage not recorded', err, { role: pendingUsage.role, model: pendingUsage.model }),
      );
      pendingUsage = null;
    }
    messages.push(assistant);
    emit('message', { message: assistant });
    // Priced when we have a rate card *or* the provider invoiced us. The second
    // half is what makes a cost appear at all for the large part of the library
    // whose price was never verified.
    emit('usage', { ...totals, priced: entry.price != null || totals.cost > 0 });

    if (!assistant.toolCalls.length) {
      /**
       * Say why it stopped, not merely that it did.
       *
       * `stop` is the normalised form, and its `message` is non-null exactly
       * when the reply in front of the user is *not* a finished answer — cut
       * off at the output cap, declined by a safety classifier, blocked by a
       * content filter. All three used to end the turn looking identical to a
       * complete one, which is the whole reason this travels.
       */
      const stop = done?.stop || { kind: done?.stopReason ? 'unknown' : 'end_turn', raw: done?.stopReason ?? null, message: null };
      emit('done', { stopReason: done?.stopReason || 'end_turn', stop });
      return;
    }

    /**
     * A turn can stop badly *and* still have asked for tools.
     *
     * The commonest is truncation: the model hit its output cap part-way
     * through writing a tool call, so the arguments are cut off and the call
     * that follows will fail on an argument nobody mangled deliberately. Said
     * here rather than only on the `done` path, because on this path the loop
     * carries on and the reason would otherwise never be seen at all.
     */
    if (done?.stop?.message) emit('status', { message: done.stop.message, stop: done.stop.kind });

    const pending = needsApproval(assistant.toolCalls, policy);
    if (pending.length) {
      emit('approval_required', {
        toolCalls: assistant.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          needsApproval: pending.some((p) => p.id === c.id),
          reason: riskReason(c.name, c.input),
        })),
      });
      return; // The client resumes by calling back with a decision.
    }

    // Marked before anything runs, so a run killed mid-execution leaves a record
    // that these calls began — which is what stops a resume repeating them.
    await store.markToolCallsStarted(userId, chatId, assistant.id, assistant.toolCalls.map((c) => c.id));
    const toolMessage = await runToolCalls({ user, toolCalls: assistant.toolCalls, chatId, emit, signal, deviceHint, onLoadTools: activate, deliverable: loadable(), policy, sent });
    // See the resume path: a superseded run leaves the results to the run that
    // replaced it, rather than writing a second tool message for one turn.
    if (signal?.reason === 'superseded') {
      emit('done', { stopReason: 'aborted' });
      return;
    }
    messages.push(await store.appendMessage(userId, chatId, toolMessage));
  }

  // `stopReason` keeps its value: server/workflows.js reads it to fail a step
  // that ran out of room, and the browser reads `stop` to offer the way on.
  const stop = budgetStop('max_steps', `Stopped after ${prefs.maxSteps} steps. Send a message to continue.`);
  emit('done', { stopReason: 'max_steps', stop });
}

/** Cheap, free title from the opening message — the user can always rename. */
export function deriveTitle(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New chat';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/** Exposed for the suite that pins how a restart is folded into a turn. */
/**
 * Any event from the provider ends the wait — see the timer in the step loop.
 * Named so the suite can assert the rule rather than the timer.
 */
const countsAsStarted = (event) => !!event?.type;

export const __testing = { applyStreamEvent, mapWithLimit, MAX_PARALLEL_TOOLS, WAIT_NOTICE_MS, countsAsStarted };
