import { renderMarkdown, escapeHtml } from './markdown.js';
import { t } from './i18n.js';
import { humanSize } from './format.js';

/**
 * The Markdown behind each assistant turn, keyed by the turn's own node.
 *
 * The copy button is served by one delegated listener on the whole transcript,
 * so it has a DOM node and needs the source that produced it. A WeakMap rather
 * than a `data-` attribute: an answer runs to tens of thousands of characters,
 * and a second copy of every one of them in the DOM is memory spent for
 * nothing. It also lets go by itself when a transcript is rebuilt.
 */
const RAW = new WeakMap();

/** The Markdown an assistant turn was rendered from. */
export const markdownOf = (node) => RAW.get(node) ?? '';

/**
 * One repaint per frame, and a real fallback when there are no frames.
 *
 * A backgrounded tab does not run `requestAnimationFrame` at all, so a reply
 * streaming into a tab the user has switched away from would never paint and
 * would arrive all at once on return. `setTimeout` still fires there (throttled,
 * which is fine — nobody is looking), so the streamed text keeps accumulating
 * into the DOM either way.
 */
const raf = (fn) =>
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16))(fn);

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
};

const ms = (n) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

/**
 * The mark at the head of a card: waiting, or done.
 *
 * A fixed-width slot in both states, so the title does not jump sideways when
 * the tick lands. Pending is a hollow ring rather than a spinning one — see the
 * note in `appendThinking`: the turn already has one moving indicator, the
 * status line under the transcript, and four more of them spinning in four
 * different places is noise rather than information.
 */
const MARK_PENDING = '<span class="mark mark--pending" aria-hidden="true"></span>';
const MARK_DONE = '<span class="mark">✓</span>';

/** The nearest ancestor that actually scrolls sideways, if there is one. */
function sidewaysScroller(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 2) continue;
    if (/auto|scroll|hidden/.test(getComputedStyle(el).overflowX)) return el;
  }
  return null;
}

/**
 * Centre the thing you just chose in the strip that holds it.
 *
 * Several strips here scroll sideways because they hold more than fits — nine
 * settings tabs, a dozen vendor chips. Picking one off the edge, or arriving at
 * a tab because a button sent you there, left the selection outside the visible
 * strip: you could see that the panel had changed and not see which tab was lit.
 *
 * Merely *reaching* it is not enough. Scrolling the minimum leaves your choice
 * pinned against the edge it came from, with the neighbours you might pick next
 * still hidden behind it — so the chip you tapped lands in the middle, where
 * both directions are visible. The ends are the exception: clamping to the
 * scrollable range keeps the first and last chips against their own edge rather
 * than pulling empty space into view to satisfy the arithmetic.
 *
 * Only the strip is scrolled, never the page — this is called from inside sheets
 * that must not jump under the pointer.
 */
export function revealInStrip(node) {
  if (!node) return;
  const strip = sidewaysScroller(node);
  if (!strip) return; // Nothing scrolls; it is already as visible as it gets.

  const box = node.getBoundingClientRect();
  const view = strip.getBoundingClientRect();
  const centred = strip.scrollLeft + (box.left - view.left) - (view.width - box.width) / 2;
  const left = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, centred));
  if (Math.abs(left - strip.scrollLeft) < 1) return;

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    strip.scrollTo({ left, behavior: still ? 'auto' : 'smooth' });
  } catch {
    strip.scrollLeft = left; // Older Safari: a jump beats an off-screen selection.
  }
}

/** One-line preview of a tool's arguments, so the timeline reads at a glance. */
export function summariseToolInput(name, input = {}) {
  switch (name) {
    case 'run_command':
      return input.command || '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return input.path || '';
    case 'glob':
      return input.pattern || '';
    case 'grep':
      return `/${input.pattern || ''}/${input.path ? ` in ${input.path}` : ''}`;
    case 'web_search':
      return input.query || '';
    case 'web_fetch':
      return input.url || '';
    case 'create_file':
      return `${input.name || 'document'}${input.format ? ` (${input.format})` : ''}`;
    case 'update_file':
      return input.name || t('tool.arg.rewriting');
    case 'memory_write':
    case 'memory_read':
      return input.key || t('tool.arg.allNotes');
    case 'update_plan':
      return `${(input.steps || []).length} steps`;
    default: {
      const json = JSON.stringify(input);
      return json.length > 90 ? `${json.slice(0, 90)}…` : json;
    }
  }
}

/**
 * A tool call, in words somebody would use.
 *
 * `summariseToolInput` above answers "what were the arguments"; this answers
 * "what happened", which is a different question and the one anybody watching is
 * actually asking. A run of ten browser calls used to read as ten lines of
 * `browser_click {"ref":"7"}` — technically complete, and unreadable at the
 * speed the steps go past.
 *
 * It began as the two families that come in long runs and now covers the whole
 * catalogue, because the argument was never about browsers: `skill_read
 * {"name":"Writing a Word document"}` is a function signature printed at
 * somebody who asked a question, and a transcript full of them reads as machine
 * output rather than as an account of what was done. The name of the function
 * is not a secret — it is one click away, inside the card, with the arguments
 * and the result. It is simply not the headline.
 *
 * Anything not listed still falls through to the raw name, so a tool added
 * later is plain rather than broken — and `test/i18n.test.mjs` fails the build
 * when a tool is added without a verb, so "later" is short.
 */
const STEP_VERBS = {
  /* ── files and the workspace ── */
  list_dir: 'step.list_dir',
  read_file: 'step.read_file',
  write_file: 'step.write_file',
  edit_file: 'step.edit_file',
  multi_edit: 'step.multi_edit',
  delete_file: 'step.delete_file',
  move_file: 'step.move_file',
  glob: 'step.glob',
  grep: 'step.grep',
  set_workspace: 'step.set_workspace',
  download_file: 'step.download_file',
  export_pdf: 'step.export_pdf',
  edit_image: 'step.edit_image',
  open_url: 'step.open_url',
  index_folder: 'step.index_folder',
  fs_search: 'step.fs_search',
  fs_browse: 'step.fs_browse',
  fs_read_text: 'step.fs_read_text',
  fs_reveal: 'step.fs_reveal',
  fs_describe: 'step.fs_describe',

  /* ── commands ── */
  run_command: 'step.run_command',
  run_background: 'step.run_background',
  run_background_logs: 'step.run_background_logs',
  run_background_stop: 'step.run_background_stop',

  /* ── the machine itself ── */
  clipboard_read: 'step.clipboard_read',
  clipboard_write: 'step.clipboard_write',
  notify: 'step.notify',
  system_stats: 'step.system_stats',
  process_list: 'step.process_list',
  process_kill: 'step.process_kill',
  launch_app: 'step.launch_app',

  /* ── the web ── */
  web_search: 'step.web_search',
  web_fetch: 'step.web_fetch',
  youtube_transcript: 'step.youtube_transcript',
  deep_research: 'step.deep_research',
  extract: 'step.extract',

  /* ── documents it writes ── */
  create_file: 'step.create_file',
  update_file: 'step.update_file',
  read_generated_file: 'step.read_generated_file',
  file_versions: 'step.file_versions',
  generate_image: 'step.generate_image',
  show_widget: 'step.show_widget',
  chart: 'step.chart',
  calculate: 'step.calculate',

  /* ── what it remembers, and what it knows how to do ── */
  memory_write: 'step.memory_write',
  memory_append: 'step.memory_append',
  memory_edit: 'step.memory_edit',
  memory_read: 'step.memory_read',
  memory_delete: 'step.memory_delete',
  skill_read: 'step.skill_read',
  skill_write: 'step.skill_write',
  load_tools: 'step.load_tools',
  update_plan: 'step.update_plan',

  /* ── work that outlives the turn ── */
  run_parallel: 'step.run_parallel',
  schedule_task: 'step.schedule_task',
  workflow_write: 'step.workflow_write',
  workflow_status: 'step.workflow_status',
  list_tasks: 'step.list_tasks',
  cancel_task: 'step.cancel_task',

  /* ── the shelf of sources ── */
  search_docs: 'step.search_docs',
  list_indexed: 'step.list_indexed',
  forget_docs: 'step.forget_docs',

  /* ── other people's systems ── */
  github: 'step.github',
  github_write: 'step.github_write',
  notion_search: 'step.notion_search',
  telegram_send: 'step.telegram_send',
  meta_page_post: 'step.meta_page_post',
  slack_post: 'step.slack_post',
  send_email: 'step.send_email',

  /* ── the browser and the desktop, where this started ── */
  browser_open: 'step.browser.open',
  browser_tabs: 'step.browser.tabs',
  browser_switch: 'step.browser.switchTab',
  browser_close_tab: 'step.browser.closeTab',
  browser_look: 'step.browser.look',
  browser_click: 'step.browser.click',
  browser_type: 'step.browser.type',
  browser_press: 'step.browser.press',
  browser_back: 'step.browser.back',
  browser_forward: 'step.browser.forward',
  browser_select: 'step.browser.select',
  browser_hover: 'step.browser.hover',
  browser_scroll: 'step.browser.scroll',
  browser_wait: 'step.browser.wait',
  browser_close: 'step.browser.close',
  desktop_windows: 'step.desktop.windows',
  desktop_launch: 'step.desktop.launch',
  desktop_look: 'step.desktop.look',
  desktop_focus: 'step.desktop.focus',
  desktop_click: 'step.desktop.click',
  desktop_type: 'step.desktop.type',
  desktop_key: 'step.desktop.key',
  desktop_scroll: 'step.desktop.scroll',
  desktop_wait: 'step.desktop.wait',
  desktop_close: 'step.desktop.close',
};

/** A URL as somebody would say it aloud: the host, and the path if it says anything. */
function readableUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    const host = url.host.replace(/^www\./, '');
    const tail = url.pathname.replace(/\/$/, '');
    return tail && tail !== '' ? `${host}${tail}` : host;
  } catch {
    return text;
  }
}

const clip = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * A path, clipped from the *front*.
 *
 * `clip` keeps the beginning, which for a path is the half that says nothing:
 * every file under a deep workspace starts the same way and the filename — the
 * only part anybody is reading for — is what falls off the end.
 */
const tailPath = (raw, max = 52) => {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
};

const seconds = (n) => t('step.seconds').replace('{n}', String(Number(n) || 0));
const count = (n) => t('steps.count').replace('{n}', String(Number(n) || 0));

/**
 * What to show beside the verb, per tool.
 *
 * Only where the arguments say something a person wants at a glance. A tool
 * whose interesting part is its *result* — `system_stats`, `list_tasks` — is
 * deliberately absent: repeating "no arguments" as an empty detail is noise,
 * and the result is one click away.
 */
const STEP_DETAILS = {
  /* files and the workspace */
  list_dir: (i) => tailPath(i.path),
  read_file: (i) => tailPath(i.path),
  write_file: (i) => tailPath(i.path),
  edit_file: (i) => tailPath(i.path),
  multi_edit: (i) => tailPath(i.path),
  delete_file: (i) => tailPath(i.path),
  move_file: (i) => `${tailPath(i.from, 24)} → ${tailPath(i.to, 24)}`,
  glob: (i) => clip(i.pattern),
  grep: (i) => `/${clip(i.pattern, 40)}/${i.path ? ` — ${tailPath(i.path, 24)}` : ''}`,
  set_workspace: (i) => tailPath(i.path),
  download_file: (i) => readableUrl(i.url),
  export_pdf: (i) => tailPath(i.path || i.url || ''),
  edit_image: (i) => tailPath(i.path),
  open_url: (i) => readableUrl(i.target) || tailPath(i.target),
  index_folder: (i) => tailPath(i.path),
  fs_search: (i) => clip(i.query),
  fs_browse: (i) => tailPath(i.path),
  fs_read_text: (i) => tailPath(i.path),
  fs_reveal: (i) => clip(i.name),
  fs_describe: (i) => clip(i.name),

  /* commands */
  run_command: (i) => clip(i.command, 72),
  run_background: (i) => clip(i.name || i.command, 72),
  run_background_logs: (i) => clip(i.id, 24),
  run_background_stop: (i) => clip(i.id, 24),

  /* the machine itself */
  clipboard_write: (i) => clip(i.text, 48),
  notify: (i) => clip(i.title || i.body),
  process_list: (i) => clip(i.filter || ''),
  process_kill: (i) => clip(i.name || (i.pid != null ? `PID ${i.pid}` : '')),
  launch_app: (i) => clip(i.app),

  /* the web */
  web_search: (i) => clip(i.query),
  web_fetch: (i) => readableUrl(i.url),
  deep_research: (i) => clip(i.question, 72),
  extract: (i) => `${readableUrl(i.url)}${i.what ? ` — ${clip(i.what, 32)}` : ''}`,

  /* documents it writes */
  create_file: (i) => `${clip(i.name || i.title || '')}${i.format ? ` (${i.format})` : ''}`,
  update_file: (i) => clip(i.name || i.file_id || ''),
  read_generated_file: (i) => clip(i.file_id, 24),
  file_versions: (i) => clip(i.file_id, 24),
  generate_image: (i) => clip(i.prompt, 64),
  show_widget: (i) => clip(i.title),
  chart: (i) => `${clip(i.title)}${i.type ? ` (${i.type})` : ''}`,
  calculate: (i) => clip(i.expression, 64),

  /* what it remembers, and what it knows how to do */
  memory_write: (i) => clip(i.key),
  memory_append: (i) => clip(i.key),
  memory_edit: (i) => clip(i.key),
  memory_read: (i) => clip(i.key) || t('tool.arg.allNotes'),
  memory_delete: (i) => clip(i.key),
  skill_read: (i) => clip(i.name),
  skill_write: (i) => clip(i.name),
  load_tools: (i) => (Array.isArray(i.names) ? clip(i.names.join(', ')) : clip(i.names)),
  update_plan: (i) => count((i.steps || []).length),

  /* work that outlives the turn */
  run_parallel: (i) => count((i.tasks || []).length),
  schedule_task: (i) => `${clip(i.title, 40)}${i.when ? ` — ${clip(i.when, 24)}` : ''}`,
  workflow_write: (i) => clip(i.title || i.id || i.action || ''),
  workflow_status: (i) => clip(i.id, 24),
  cancel_task: (i) => clip(i.id, 24),

  /* the shelf of sources */
  search_docs: (i) => clip(i.query),
  forget_docs: (i) => clip(i.source),

  /* other people's systems */
  github: (i) => clip(i.path, 56),
  github_write: (i) => `${String(i.method || 'POST').toUpperCase()} ${clip(i.path, 48)}`,
  notion_search: (i) => clip(i.query),
  telegram_send: (i) => clip(i.text, 48),
  meta_page_post: (i) => clip(i.message, 48),
  slack_post: (i) => `${clip(i.channel, 20)} — ${clip(i.text, 40)}`,
  send_email: (i) => `${clip(i.to, 32)}${i.subject ? ` — ${clip(i.subject, 32)}` : ''}`,

  /* the browser and the desktop */
  browser_open: (i) => readableUrl(i.url),
  // The model's own description of what it is clicking beats a reference
  // number, which means nothing to the person reading.
  browser_click: (i) => clip(i.description || (i.ref != null ? `[${i.ref}]` : '')),
  browser_hover: (i) => clip(i.description || (i.ref != null ? `[${i.ref}]` : '')),
  browser_type: (i) => clip(i.text, 48),
  desktop_type: (i) => clip(i.text, 48),
  browser_press: (i) => clip(i.key),
  desktop_key: (i) => clip(i.key),
  browser_select: (i) => clip(i.value),
  browser_scroll: (i) => clip(i.direction || 'down'),
  desktop_scroll: (i) => clip(i.direction || 'down'),
  browser_wait: (i) => seconds(i.seconds ?? 3),
  desktop_wait: (i) => seconds(i.seconds ?? 3),
  browser_switch: (i) => (i.tab != null ? String(i.tab) : ''),
  browser_close_tab: (i) => (i.tab != null ? String(i.tab) : ''),
  desktop_launch: (i) => clip(i.app || i.path || ''),
  desktop_focus: (i) => clip(i.title || i.window || ''),
  desktop_close: (i) => clip(i.title || i.window || ''),
};

/**
 * The call itself, for whoever opens the card.
 *
 * The headline says what was done in words; this is the other half of the
 * bargain. Replacing `skill_read {"name":"…"}` in the summary with "Read a
 * skill" would be a downgrade if the exact call then existed nowhere — the
 * function name and its arguments are what you need to say "it passed the wrong
 * path" or to reproduce a step outside the app. So it moves inside rather than
 * going away.
 *
 * Text nodes, never `innerHTML`: every value here was chosen by a model, and
 * some of them are quoting a web page back.
 */
function toolCallDetail(call) {
  const node = el('div', 'tool__call');

  const name = el('code', 'tool__fn');
  name.textContent = call.name;
  node.append(name);

  const args = call.input && Object.keys(call.input).length ? call.input : null;
  if (args) {
    const pre = el('pre', 'tool__args');
    try {
      pre.textContent = JSON.stringify(args, null, 2);
    } catch {
      // A circular or otherwise unserialisable argument is still worth showing
      // the shape of, and is not a reason to draw no card at all.
      pre.textContent = String(args);
    }
    node.append(pre);
  }
  return node;
}

/**
 * The address a step acted on, when it is one you could open yourself.
 *
 * Read off `input.url` rather than from a list of tool names, because every
 * tool that works on a page already takes it under that name — `web_fetch`,
 * `extract`, `youtube_transcript`, `open_url`, the browser family — so one
 * added tomorrow that follows the same convention gets this without anybody
 * remembering to come back here.
 *
 * `http(s)` only. A `file:` or `javascript:` argument stays text: the model
 * chooses these, and a model reads pages that can tell it what to write next.
 */
export function stepLink(input = {}) {
  const raw = String(input?.url ?? '');
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/**
 * The detail beside a step's verb, as a link when there is one to follow.
 *
 * The URL was already printed there, shortened for reading — but only as text,
 * so seeing where a fetch went and going there yourself were different things,
 * and the second one meant opening the card and reading a JSON argument.
 */
function detailNode(className, detail, href) {
  if (!href) {
    const plain = el('span', className);
    plain.textContent = detail;
    return plain;
  }
  const link = document.createElement('a');
  link.className = `${className} step__link`;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // The shortened form is what reads; the whole address is what you hover for.
  link.title = href;
  link.textContent = detail;
  // The card underneath opens on click. Without this, following the link also
  // unfolds the raw call and result you were trying not to have to read.
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

export function describeStep(name, input = {}) {
  const key = STEP_VERBS[name];
  if (!key) return { verb: name, detail: summariseToolInput(name, input) };

  const detail = STEP_DETAILS[name];
  // A detail function that throws on an argument shaped unexpectedly must not
  // take the whole transcript down with it: this runs on every step of every
  // turn, and the model is the one choosing the arguments.
  try {
    return { verb: t(key), detail: detail ? detail(input) || '' : '' };
  } catch {
    return { verb: t(key), detail: '' };
  }
}

/**
 * Which run of steps this call belongs to, or null for "on its own".
 *
 * Only the two families that come in long runs are grouped. Grouping everything
 * would fold a single `read_file` into a card you have to open to see, which
 * costs a click to learn something that was already on screen.
 */
export function stepFamily(name) {
  if (/^browser_/.test(name)) return 'browser';
  if (/^desktop_/.test(name)) return 'desktop';
  return null;
}

/** A file's extension, upper-cased, as the stand-in for a thumbnail. */
const extensionBadge = (name) => String(name || 'file').split('.').pop().slice(0, 4).toUpperCase();

/**
 * What kind of thing this is, in words, for the line under a filename.
 *
 * Keys, resolved when the noun is needed rather than when this module loads.
 * Calling `t()` in the object literal looked equivalent and was not: it runs
 * once at import, before the language is settled, and freezes whatever was
 * current — so switching language left every file still described in the old
 * one. The names that are the same in both languages stay literals.
 */
const FILE_NOUN_KEY = {
  docx: 'file.docx',
  doc: 'file.docx',
  xlsx: 'file.xlsx',
  xls: 'file.xlsx',
  pptx: 'file.pptx',
  ppt: 'file.pptx',
  csv: 'file.csv',
  html: 'file.html',
  txt: 'file.txt',
};

const FILE_NOUN_LITERAL = { pdf: 'PDF', md: 'Markdown', json: 'JSON' };

const fileNoun = (extension) =>
  FILE_NOUN_LITERAL[extension] || (FILE_NOUN_KEY[extension] ? t(FILE_NOUN_KEY[extension]) : '');


/**
 * What was sent, above what was said about it.
 *
 * `preview` is a local object URL for something just picked, which the browser
 * already holds; `id` is a stored one, fetched from the server. Both end up in
 * the same markup — the difference only matters for where the bytes come from.
 *
 * Anything already stored is a button, because it can be opened: a Word
 * document or a spreadsheet is unreadable as a name in a bubble, and the whole
 * point of attaching one is that both parties can see it. A file still
 * uploading has nothing to open yet and stays inert.
 */
function attachmentStrip(files) {
  const strip = el('div', 'bubble__files');

  for (const file of files) {
    const src = file.preview || (file.id ? `/api/attachments/${file.id}` : null);
    const image = file.preview ? true : /^image\//i.test(file.mime || '');

    if (src && image) {
      const img = el('img', 'bubble__image');
      img.src = src;
      img.alt = file.name || '';
      img.loading = 'lazy';
      if (file.id) {
        const open = el('button', 'bubble__thumb');
        open.type = 'button';
        open.dataset.file = file.id;
        open.title = t('chat.openNamed').replace('{name}', file.name || '');
        open.append(img);
        strip.append(open);
      } else {
        strip.append(img);
      }
      continue;
    }

    const chip = el(file.id ? 'button' : 'span', 'bubble__file');
    if (file.id) {
      chip.type = 'button';
      chip.dataset.file = file.id;
      chip.title = file.name ? t('chat.openNamed', { name: file.name }) : t('chat.openThisFile');
    }
    const kind = el('span', 'bubble__file-ext');
    kind.textContent = extensionBadge(file.name);
    const label = el('span');
    label.textContent = file.name || 'file';
    chip.append(kind, label);
    strip.append(chip);
  }
  return strip;
}

/**
 * A document the assistant made.
 *
 * Deliberately not a line of prose saying a file was written. A file people can
 * see the size of, open, and download is the difference between "here is your
 * quotation" and a paragraph claiming there is one — and the two buttons are the
 * two things anybody does next.
 */
/**
 * A widget, drawn in the transcript.
 *
 * **In an iframe, and that is not optional.** This is markup a model wrote, and
 * putting it in the page directly would give it the same origin as the session —
 * one `<img onerror>` away from reading the conversation or the cookie. Sandboxed
 * with `allow-scripts` withheld and no `allow-same-origin`, it can draw and
 * nothing else, which is the whole job. The same reasoning as the artifact frame
 * in viewer.js, one step stricter because a widget never needs to run anything.
 *
 * `srcdoc` rather than a URL, because the markup lives in the tool result rather
 * than in a file with an id to fetch.
 *
 * The height comes from the content: an iframe defaults to 150px and would crop
 * most diagrams, and there is no way to measure inside a frame we deliberately
 * cannot script into. So the frame reports its own height once, through the one
 * channel a sandboxed document still has — and if it never does, the CSS floor
 * keeps the picture visible rather than clipped to nothing.
 */
export function widgetFrame(widget) {
  const host = document.createElement('figure');
  host.className = 'widget';

  const caption = document.createElement('figcaption');
  caption.className = 'widget__caption';
  caption.textContent = widget.title || t('chat.diagram');

  const frame = document.createElement('iframe');
  frame.className = 'widget__frame';
  frame.title = widget.title || t('chat.diagram');
  /**
   * No `allow-scripts`: a widget is a finished picture. Anything that needs to
   * run is a `create_file` artifact, which has its own frame and its own warning.
   *
   * `allow-same-origin` is here only so this page can measure the drawing and
   * size the frame to it — without it the frame gets an opaque origin and its
   * height is unreadable, which is why every widget used to be exactly 340px
   * whether it held a four-bar chart or a thirty-row table. It grants nothing to
   * the markup: with scripts still forbidden, there is nothing inside to use it.
   */
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('loading', 'lazy');

  /**
   * Fit the frame to the picture.
   *
   * Measured after load rather than guessed: a chart and a table want very
   * different heights, and a fixed one is wrong for both — empty space under the
   * small one, a scrollbar through the middle of the large one. The CSS keeps a
   * max-height, so something genuinely enormous still scrolls instead of pushing
   * the conversation off the screen.
   */
  const fit = () => {
    try {
      const body = frame.contentDocument?.body;
      if (!body) return;
      const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
      if (height > 0) frame.style.height = `${height + 4}px`;
    } catch {
      // Cross-origin or detached: leave the CSS height, which still works.
    }
  };
  frame.addEventListener('load', fit);

  // A document rather than a fragment, so the picture is not styled by this page
  // and cannot reach out of its box.
  /**
   * Nothing in a widget may reach the network.
   *
   * The sandbox stops the markup *running* anything, and that was read as the
   * whole story. It is not: a picture needs no script to phone home. The model
   * writes this markup, and `<img src="https://somewhere/?id=…">` fires the
   * moment the frame renders — confirming delivery and handing a third party an
   * IP address, a user-agent and a timestamp, from an app whose entire promise
   * is that your things stay on your machine. A model can be talked into
   * emitting that by a page it read a moment earlier.
   *
   * A widget is a finished picture drawn from what the model already knows, so
   * it has nothing legitimate to fetch. `default-src 'none'` says exactly that,
   * and inline styles are re-permitted because the block below is one.
   *
   * In the document rather than as the frame's `csp` attribute: that attribute
   * is not in Safari or Firefox, and this has to hold everywhere.
   */
  frame.srcdoc =
    '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" ' +
    "content=\"default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:\">" +
    '<style>' +
    'html,body{margin:0;padding:0;background:transparent;' +
    "font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#c8d3de}" +
    'body{padding:10px}svg{max-width:100%;height:auto;display:block}' +
    'table{border-collapse:collapse;font-size:12px}td,th{border:1px solid #2a3642;padding:4px 8px}' +
    'a{color:#7cc7ff}' +
    '</style>' +
    `<body>${widget.markup}</body>`;

  host.append(caption, frame);
  return host;
}

export function fileCard(file) {
  const card = el('div', 'filecard');
  card.dataset.file = file.id;

  const icon = el('span', 'filecard__icon');
  icon.textContent = extensionBadge(file.name);

  const body = el('div', 'filecard__body');
  const name = el('span', 'filecard__name');
  name.textContent = file.name;
  const meta = el('span', 'filecard__meta');
  meta.textContent = [fileNoun(extensionBadge(file.name).toLowerCase()), humanSize(file.bytes || 0)]
    .filter(Boolean)
    .join(' · ');
  body.append(name, meta);

  const open = el('button', 'btn btn--ghost filecard__btn');
  open.type = 'button';
  open.dataset.file = file.id;
  open.textContent = t('chat.open');

  const download = el('a', 'btn btn--ghost filecard__btn');
  // The version marker only changes when the file is rewritten; without it a
  // browser holding the immutable first version would download that forever.
  download.href = `/api/attachments/${file.id}?download=1${file.version ? `&v=${file.version}` : ''}`;
  download.setAttribute('download', file.name);
  download.textContent = t('chat.download');

  card.append(icon, body, open, download);
  return card;
}

/**
 * The copy button, in the one shape both sides of the conversation use.
 *
 * Written once rather than twice: what you press to take a message away should
 * not depend on who wrote it, and two copies of the same markup drift.
 */
function copyButton() {
  return (
    `<button class="msg__action" type="button" data-act="copy" title="${escapeHtml(t('chat.copy'))}" aria-label="${escapeHtml(t('chat.copy'))}">` +
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" />' +
    '</svg></button>'
  );
}

/**
 * A web address, as written, with the punctuation that ends a sentence left
 * outside it. `http` and `https` only — a `javascript:` or `data:` URL typed
 * into the composer stays what it is, words, rather than becoming something
 * that can be pressed.
 */
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/g;

/**
 * What you typed, with its links pressable.
 *
 * A pasted URL sat in the bubble as plain text — you could see it, select it
 * and copy it, but not open it, which is the one thing a link is for. The
 * commonest shape of message in this app is an address plus a sentence about
 * what to do with it, so that was a dead end on most turns.
 *
 * Built as DOM nodes and never as `innerHTML`. This is text a person typed,
 * and the only way to be certain it is never parsed as markup is to hand the
 * browser text nodes. The regex picks out the addresses; every character
 * between them stays exactly as written.
 */
export function withLinks(text) {
  const frag = document.createDocumentFragment();
  const source = String(text);
  let last = 0;
  for (const match of source.matchAll(URL_IN_TEXT)) {
    const at = match.index ?? 0;
    if (at > last) frag.append(document.createTextNode(source.slice(last, at)));
    const link = document.createElement('a');
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = match[0];
    frag.append(link);
    last = at + match[0].length;
  }
  if (last < source.length) frag.append(document.createTextNode(source.slice(last)));
  return frag;
}

export function userMessage(text, files = [], id = null) {
  const wrap = el('div', 'msg msg--user');
  if (id) wrap.dataset.messageId = id;
  const bubble = el('div', 'bubble');

  if (files.length) bubble.append(attachmentStrip(files));

  if (text) {
    const body = el('div', 'bubble__text');
    // `textContent` still reads back the message exactly as typed — an anchor
    // contributes its own text — so copying and editing a bubble are unchanged.
    body.append(withLinks(text));
    bubble.append(body);
  }

  wrap.append(bubble);

  /**
   * Copy and edit, under the bubble and only while you are pointing at it.
   *
   * Always-visible controls on every turn would put two buttons beside every
   * line of a conversation, which is a lot of furniture for something used
   * rarely. They appear on hover, and on keyboard focus as well — otherwise
   * they would be reachable by tabbing to a control nobody can see.
   */
  const actions = el('div', 'msg__actions');
  actions.innerHTML =
    copyButton() +
    `<button class="msg__action" type="button" data-act="edit" title="${escapeHtml(t('chat.edit'))}" aria-label="${escapeHtml(t('chat.edit'))}">` +
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z" />' +
    '</svg></button>';
  wrap.append(actions);

  return wrap;
}

/**
 * An assistant turn. Reasoning, tool calls and prose all land in one block so
 * the transcript reads as a single continuous action rather than a pile of
 * disconnected cards.
 */
export function assistantMessage() {
  // No "ASSISTANT" label. In a two-party conversation where one side is in a
  // bubble on the right and the other is not, saying which is which every turn
  // is a caption on an unambiguous picture — it adds a line of chrome to every
  // reply and tells nobody anything they did not already know.
  const wrap = el('div', 'msg msg--assistant');

  const body = el('div', 'msg__body');
  wrap.append(body);

  let thinkingBlock = null;
  let thinkingBody = null;
  let prose = null;
  let rawText = '';
  /** Whether a repaint is already scheduled for the next frame — see appendText. */
  let paintQueued = false;

  /**
   * A run of steps in one family, drawn as a single card.
   *
   * Held open while it is being added to, so you watch the work happen, and
   * collapsed the moment the run ends — at which point it is history, and eight
   * expanded browser actions between you and the answer are eight things to
   * scroll past. `closeGroup` is what "the run ended" means, and it is called
   * from exactly two places: prose arriving, and a step of a different family.
   */
  let group = null;

  function closeGroup() {
    if (!group) return;
    // The run is history now: swap the waiting mark for a tick and fold it up.
    const mark = group.node.querySelector(':scope > summary > .mark');
    if (mark) mark.outerHTML = MARK_DONE;
    group.node.open = false;
    group = null;
  }

  /** Redraw the one line somebody reads without opening the card. */
  function paintGroupSummary() {
    if (!group) return;
    const label = group.family === 'desktop' ? t('steps.desktop') : t('steps.browser');
    const count = t('steps.count').replace('{n}', String(group.count));
    group.title.textContent = label;
    group.tally.textContent = count;
    if (group.failed) group.node.classList.add('steps--error');
  }

  /**
   * One step inside a run.
   *
   * A row rather than a card: the verb, what it acted on, how long it took, and
   * — once it finishes — a thumbnail of what the screen looked like. The raw
   * tool output is still there, behind a disclosure, because when something goes
   * wrong that text is the only thing that explains it.
   */
  function startStep(call, family) {
    const run = groupFor(family);
    run.count += 1;
    paintGroupSummary();

    const { verb, detail } = describeStep(call.name, call.input);
    const href = stepLink(call.input);

    const item = el('li', 'step');
    const mark = el('span', 'step__mark', '<span class="spinner"></span>');
    const label = el('span', 'step__label');
    const verbNode = el('span', 'step__verb');
    verbNode.textContent = verb;
    label.append(verbNode);
    if (detail) label.append(detailNode('step__detail', detail, href));
    const time = el('span', 'step__time');
    item.append(mark, label, time);
    run.list.append(item);

    return {
      complete(result) {
        item.classList.toggle('step--error', !!result.isError);
        mark.innerHTML = '';
        mark.textContent = result.isError ? '✗' : '✓';
        if (result.ms != null) time.textContent = ms(result.ms);
        if (result.isError) {
          run.failed = true;
          paintGroupSummary();
        }

        /**
         * What the screen looked like when this step finished.
         *
         * The single most useful thing in the whole card, and the reason it is
         * a thumbnail rather than a full frame: eight full-width screenshots
         * turn a run into a scroll, while eight thumbnails read as a strip you
         * can take in at once. Clicking one opens it properly.
         */
        if (result.shot?.id) {
          const shot = el('button', 'step__shot');
          shot.type = 'button';
          shot.dataset.file = result.shot.id;
          const img = el('img');
          img.src = `/api/attachments/${result.shot.id}`;
          img.alt = `${verb}${detail ? ` — ${detail}` : ''}`;
          img.loading = 'lazy';
          shot.append(img);
          item.append(shot);
        }

        // Errors are opened, successes are not. A failed step is the one thing
        // in the run somebody needs to read, and making them find and click it
        // is making them work for information the interface already has.
        const out = el('details', 'step__out');
        out.open = !!result.isError;
        out.append(el('summary', null, escapeHtml(t('step.output'))));
        // The call that produced it, above the result it produced — the same
        // bargain the standalone cards make: plain words outside, the exact
        // call and its arguments for whoever opens it.
        out.append(toolCallDetail(call));
        const pre = el('pre');
        pre.textContent = result.content || t('chat.noOutput');
        out.append(pre);
        item.append(out);

        if (result.file?.id) {
          const card = fileCard(result.file);
          const existing = [...body.querySelectorAll('.filecard')].find(
            (node) => node.dataset.file === result.file.id,
          );
          if (existing) existing.replaceWith(card);
          else body.append(card);
        }
        if (result.widget?.markup) body.append(widgetFrame(result.widget));
      },
    };
  }

  /** The card this call belongs in, opening a new one if the run just started. */
  function groupFor(family) {
    if (group && group.family === family) return group;
    closeGroup();

    const node = el('details', 'block steps');
    node.open = true;
    const summary = el('summary');
    summary.innerHTML = MARK_PENDING;
    const title = el('span', 'steps__title');
    const tally = el('span', 'steps__tally');
    summary.append(title, tally);
    node.append(summary);

    const list = el('ol', 'steps__list');
    node.append(list);
    body.append(node);

    group = { family, node, list, title, tally, count: 0, failed: false };
    return group;
  }

  /**
   * The copy button, added the moment there is prose worth copying.
   *
   * Not drawn up front: a turn that only ran tools has nothing to put on the
   * clipboard, and a button that copies an empty string is worse than no
   * button. Added once — `appendText` runs per delta.
   */
  function ensureActions() {
    if (wrap.querySelector(':scope > .msg__actions')) return;
    const actions = el('div', 'msg__actions');
    actions.innerHTML = copyButton();
    wrap.append(actions);
  }

  const api = {
    node: wrap,

    appendThinking(delta) {
      if (!thinkingBlock) {
        thinkingBlock = el('details', 'block');
        /**
         * No spinner here, and none on the cards below.
         *
         * One turn draws a status line under the transcript that says what is
         * happening by name — "Running deep_research…", "Thinking…" — and every
         * card that had not finished drew its own spinning ring as well. Three
         * or four of them at once, in different places, all saying the thing
         * the one line at the bottom already said. A card that is still working
         * is the one with no tick, which is quieter and just as clear.
         */
        thinkingBlock.append(el('summary', null, `${MARK_PENDING} ${escapeHtml(t('chat.reasoning'))}`));
        thinkingBody = el('div', 'block__body');
        thinkingBody.append(el('pre'));
        thinkingBlock.append(thinkingBody);
        body.append(thinkingBlock);
      }
      thinkingBody.querySelector('pre').textContent += delta;
    },

    finishThinking() {
      if (thinkingBlock) {
        thinkingBlock.querySelector('summary').innerHTML = `${MARK_DONE} ${escapeHtml(t('chat.reasoning'))}`;
      }
    },

    /**
     * The reasoning turned out to be the whole answer — show it as one.
     *
     * The server decided this (see `reasonedAloud` in `server/agent.js`) and
     * stored the turn with the words as its reply, so a reload already shows it
     * correctly. This is the live view catching up: without it the person who
     * watched the turn arrive still sees an empty bubble until they refresh,
     * and the two views of the same turn disagree.
     */
    adoptThinkingAsReply(text) {
      if (prose || !thinkingBlock) return;
      thinkingBlock.remove();
      thinkingBlock = null;
      thinkingBody = null;
      api.appendText(text);
      api.flushText();
    },

    /**
     * Add to the reply, and repaint at most once a frame.
     *
     * This used to re-parse and re-insert the *whole* reply on every delta.
     * `renderMarkdown` is a line-scanning parse with a dozen regex passes over
     * the accumulated text, so running it per token is O(n²) in reply length: a
     * 20,000-character answer arriving four characters at a time is about 5,000
     * parses averaging 10,000 characters, each followed by throwing away and
     * rebuilding the entire prose subtree. It was the most expensive thing in
     * the client, on its hottest path.
     *
     * Two consequences were worse than the jank, because they are things a
     * person notices without knowing why: **you could not select text in a
     * streaming reply** — the selection was destroyed every token — and any
     * `<details>` a reply had opened snapped shut continuously.
     *
     * Coalescing to one paint per animation frame collapses ~16ms of tokens
     * into a single parse, which on a fast stream is a 10–50× cut with no
     * change to what is finally shown. `flushText` exists so the end of a turn
     * is never left waiting on a frame that may not come — a backgrounded tab
     * does not run rAF at all.
     */
    appendText(delta) {
      rawText += delta;
      RAW.set(wrap, rawText);
      if (!prose) {
        // Prose is the natural boundary between two pieces of work: the
        // assistant stopped acting and said something. Folding the steps either
        // side of that into one card would claim a structure the turn does not have.
        closeGroup();
        prose = el('div', 'prose');
        body.append(prose);
        ensureActions();
      }
      if (paintQueued) return;
      paintQueued = true;
      raf(() => {
        paintQueued = false;
        // `prose` can have been torn down by `resetText` between scheduling and
        // painting — a provider restarting the reply on another key does exactly
        // that — and painting into the removed node would resurrect the draft
        // this whole mechanism exists to discard.
        if (prose) prose.innerHTML = renderMarkdown(rawText);
      });
    },

    /** Paint whatever is pending right now, without waiting for a frame. */
    flushText() {
      paintQueued = false;
      if (prose) prose.innerHTML = renderMarkdown(rawText);
    },

    /**
     * Throw away the prose written so far.
     *
     * A provider that restarts a reply on another key is replacing it, not
     * continuing it. Letting the replacement accumulate on top would be the
     * quiet kind of wrong: a reader has no way to tell a repeated paragraph
     * from an intended one, and might carry it off and use it.
     */
    resetText() {
      rawText = '';
      RAW.delete(wrap);
      // A restarted reply restarts its reasoning too. Both callers are `retry`
      // handlers, and keeping the abandoned attempt's thinking showed one trace
      // that contradicts itself partway through — the server now discards it
      // for the same reason (CODE-018).
      if (thinkingBlock) {
        thinkingBlock.remove();
        thinkingBlock = null;
        thinkingBody = null;
      }
      // Cancel any frame still owed. Without this the queued paint would run
      // after the node was removed — harmless now that `appendText` re-checks
      // `prose`, but leaving a scheduled write to a discarded draft in flight is
      // not a thing to rely on being harmless.
      paintQueued = false;
      if (prose) {
        prose.remove();
        prose = null;
        wrap.querySelector(':scope > .msg__actions')?.remove();
      }
    },

    setPlan(steps) {
      let plan = body.querySelector('.plan');
      if (!plan) {
        plan = el('div', 'plan');
        // The heading was hard-coded English, which left the one panel the user
        // watches while they wait untranslated on a Vietnamese account.
        const heading = el('h4');
        heading.textContent = t('chat.plan');
        const list = el('ul');
        /**
         * The plan rewrites itself as the work moves, and a screen reader was
         * told none of it — the steps simply changed underneath. `polite`
         * announces the current step when it changes without interrupting
         * whatever is being read; `false` re-reads the whole list rather than
         * just the changed node, which is what makes "step 3 of 6" make sense.
         */
        list.setAttribute('aria-live', 'polite');
        list.setAttribute('aria-atomic', 'false');
        plan.append(heading, list);
        body.append(plan);
      }
      plan.querySelector('ul').innerHTML = (steps || [])
        .map((s) => {
          const cls = s.status === 'done' ? 'is-done' : s.status === 'in_progress' ? 'is-active' : '';
          const mark = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▸' : '○';
          // The mark is decorative — the status it encodes is already carried by
          // aria-current and the list order, and read aloud it is a shape.
          return (
            `<li class="${cls}"${s.status === 'in_progress' ? ' aria-current="step"' : ''}>` +
            `<span aria-hidden="true">${mark}</span><span>${escapeHtml(s.title)}</span></li>`
          );
        })
        .join('');
      // Keep the plan pinned above the prose it describes.
      body.prepend(plan);
    },

    /** Start a collapsed card for a tool call; returns a handle to complete it. */
    startTool(call) {
      const family = stepFamily(call.name);
      if (family) return startStep(call, family);

      // A call that is not part of a run ends whatever run was in progress:
      // `read_file` between two browser actions really is a change of activity.
      closeGroup();

      // The headline is what was done; the function name and its arguments are
      // inside, one click away, for whoever wants them.
      const { verb, detail } = describeStep(call.name, call.input);
      const href = stepLink(call.input);
      /**
       * Drawn in two halves: markup for the parts that are markup, and a real
       * node for the argument, because when the argument is an address it is
       * an anchor with a listener on it and `innerHTML` cannot carry either.
       */
      const paintHead = (mark, trailing = '') => {
        summary.innerHTML = `${mark}<span class="tool__name">${escapeHtml(verb)}</span>`;
        if (detail) summary.append(detailNode('tool__arg', detail, href));
        if (trailing) summary.insertAdjacentHTML('beforeend', trailing);
      };

      const block = el('details', 'block tool');
      const summary = el('summary');
      paintHead(MARK_PENDING);
      block.append(summary);

      const inner = el('div', 'block__body');
      inner.append(toolCallDetail(call));
      // Held rather than looked up: the arguments are a `pre` too, and they now
      // come first, so `querySelector('pre')` finds the call and the result
      // overwrites what it was called with.
      const output = el('pre');
      inner.append(output);
      block.append(inner);
      body.append(block);

      return {
        complete(result) {
          block.classList.toggle('tool--error', !!result.isError);
          paintHead(
            `<span class="mark">${result.isError ? '✗' : '✓'}</span>`,
            result.ms != null ? `<span class="tool__time">${ms(result.ms)}</span>` : '',
          );
          output.textContent = result.content || t('chat.noOutput');

          /**
           * A document came out of this call.
           *
           * The card goes beside the collapsed tool block rather than inside it:
           * the tool call is machinery nobody opens, and the file is the thing
           * that was asked for. A rewrite replaces the card for that same id, so
           * a document edited three times is one card, not four.
           */
          if (result.file?.id) {
            const card = fileCard(result.file);
            const existing = [...body.querySelectorAll('.filecard')].find(
              (node) => node.dataset.file === result.file.id,
            );
            if (existing) existing.replaceWith(card);
            else body.append(card);
          }

          /**
           * A picture drawn into the conversation itself.
           *
           * Beside the tool block like a file card, for the same reason: the call
           * is machinery and the picture is the point. Unlike a file it is not
           * something to open — it is already open, which is what makes it the
           * right shape for "here is what I found" rather than "here is a report".
           */
          if (result.widget?.markup) body.append(widgetFrame(result.widget));
        },
      };
    },

    /** Rebuild from a persisted message when reloading a conversation. */
    hydrate(message, resultsByCallId) {
      if (message.thinking) {
        api.appendThinking(message.thinking);
        api.finishThinking();
      }
      for (const call of message.toolCalls || []) {
        if (call.name === 'update_plan') api.setPlan(call.input?.steps);
        const handle = api.startTool(call);
        const result = resultsByCallId?.get(call.id);
        handle.complete(result || { content: t('chat.noResult'), isError: false });
      }
      if (message.text) api.appendText(message.text);
      api.finish();
      return api;
    },

    /**
     * The turn is over.
     *
     * A run of steps that is never closed keeps its spinner and stays expanded
     * for the rest of the conversation — a turn that finished an hour ago still
     * drawn as though it were working.
     */
    finish() {
      // The last tokens of a reply may still be owed a frame. A turn that ends
      // must show all of what it said, not all but the final sentence.
      if (paintQueued) api.flushText();
      closeGroup();
    },
  };

  return api;
}

/**
 * Where the earlier part of a conversation was folded up.
 *
 * Shown as a quiet rule rather than hidden, because the transcript the model
 * sees and the one you read have just parted company — and the moment that
 * happened is exactly the thing worth being able to point at when an answer
 * later seems to have forgotten something. The summary itself is behind the
 * disclosure: available, not in the way.
 */
export function summaryDivider(replaced, text) {
  const wrap = el('div', 'compacted');
  const line = el('div', 'compacted__line');
  // Two keys rather than a plural rule: this dictionary has no plural machinery
  // on purpose, and Vietnamese does not inflect the noun anyway.
  line.textContent =
    replaced === 1 ? t('chat.compactedOne') : t('chat.compacted').replace('{n}', String(replaced));
  wrap.append(line);

  if (text) {
    const fold = el('details', 'block compacted__fold');
    fold.append(el('summary', null, escapeHtml(t('chat.summaryFold'))));
    const body = el('div', 'block__body');
    const pre = el('pre');
    pre.textContent = text;
    body.append(pre);
    fold.append(body);
    wrap.append(fold);
  }
  return wrap;
}

/**
 * Why the reply above this line is not a finished answer.
 *
 * Drawn into the transcript rather than toasted, and that is the whole point of
 * it: a toast is gone in three seconds, and the question "was this answer cut
 * off?" is asked while scrolling back through a conversation an hour later. The
 * three outcomes it covers — truncated at the output cap, declined by a safety
 * classifier, blocked by a content filter — used to leave nothing behind at all,
 * so a half-written answer and a complete one looked the same for ever.
 *
 * `role="status"` rather than `alert`: it is worth announcing to a screen reader
 * when it appears, and it is not an interruption.
 */
export function stopNote(kind, text, onContinue = null) {
  const wrap = el('div', `stopnote stopnote--${kind || 'unknown'}`);
  wrap.setAttribute('role', 'status');
  const line = el('div', 'stopnote__line');
  line.textContent = text;
  wrap.append(line);

  /**
   * The way on, where the explanation is.
   *
   * Only for the stops that really can carry on — see `isResumable` on the
   * server. Offering it on a refusal would be a button that reproduces the
   * refusal, which is worse than no button.
   *
   * It removes itself before handing over: a second press would start a second
   * run against the same conversation, which the run lock refuses with a 409
   * and which reads as the button being broken.
   */
  if (onContinue) {
    const go = el('button', 'stopnote__go');
    go.type = 'button';
    go.textContent = t('chat.continue');
    go.addEventListener('click', () => {
      wrap.remove();
      onContinue();
    });
    wrap.append(go);
  }

  return wrap;
}

/**
 * What is happening right now, under the transcript.
 *
 * `bar` adds an indeterminate progress track — a stripe that travels, with no
 * percentage on it. That is deliberate and it is the honest shape for the one
 * thing that uses it: folding the earlier turns is a single request to a
 * model, so there are no steps to count and nothing to be a fraction of. A
 * number here would have to be invented, and an invented number is worse than
 * no number, because it is believed.
 */
export function statusLine(text, { bar = false } = {}) {
  const node = el('div', 'status-line');
  node.innerHTML =
    `<span class="spinner"></span><span>${escapeHtml(text)}</span>` +
    (bar ? '<span class="status-line__bar" role="presentation"><i></i></span>' : '');
  return node;
}

export function toast(message, kind = 'info') {
  // An error goes to the assertive region: it is why the thing the user just
  // asked for did not happen, and a polite announcement queues behind whatever
  // is being read — which for a streaming reply is a long time.
  const host = document.getElementById(kind === 'error' ? 'toasts-alert' : 'toasts');

  // Repeating the same message stacks noise without adding information — the
  // second click of a failing button should not double the wall of red.
  // Checked across both regions, so a message cannot appear once in each.
  for (const region of ['toasts', 'toasts-alert']) {
    const node = document.getElementById(region);
    for (const existing of node ? node.children : []) {
      if (existing.dataset.message === message) return;
    }
  }

  const node = el('div', `toast${kind === 'error' ? ' toast--error' : ''}`);
  node.dataset.message = message;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6500 : 3200);
}
