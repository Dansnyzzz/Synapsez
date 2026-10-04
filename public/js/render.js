import { renderMarkdown, escapeHtml } from './markdown.js';
import { t, currentLanguage } from './i18n.js';
import { humanSize, repeatsAs, cronParts } from './format.js';
import { chartFigure } from './chart.js';
import { richWidget } from './cards.js';
import { api } from './api.js';
import { mediaTools, svgToPng, fileNameFrom, imageUrlToPng } from './media.js';
import { webRowHtml, titleFromContent } from './webrows.js';
import { parseResults } from './rail.js';
import { rememberSearch, rememberPage, auditCitations } from './cite.js';
import { normalisePlan, planItemHtml, planChange } from './plan.js';

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
/**
 * A tool's answer as a person reads it.
 *
 * Outside content reaches the model wrapped in `<untrusted source=…>` (see
 * server/tools/untrusted.js). That boundary is for the model; on screen the tags
 * were noise around the page text — the source is already the card's headline.
 */
export function forDisplay(text) {
  return String(text ?? '')
    .replace(/<untrusted source="[^"]*">\n?/g, '')
    .replace(/\n?<\/untrusted>/g, '')
    .trim();
}

const MARK_PENDING = '<span class="mark mark--pending" aria-hidden="true"></span>';

/** The tools drawn as the web card rather than as cards of their own. */
const WEB_TOOLS = new Set(['web_search', 'web_fetch', 'extract', 'http_request', 'read_feed']);
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
  ask_options: 'step.ask_options',
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
  world_facts: 'step.world_facts',
  date_calc: 'step.date_calc',
  convert_units: 'step.convert_units',
  market_data: 'step.market_data',
  place_lookup: 'step.place_lookup',
  read_feed: 'step.read_feed',
  text_tools: 'step.text_tools',
  analyze_data: 'step.analyze_data',
  make_qr: 'step.make_qr',
  http_request: 'step.http_request',
  encyclopedia: 'step.encyclopedia',
  image_search: 'step.image_search',
  sports: 'step.sports',
  show_card: 'step.show_card',
  sandbox_run: 'step.sandbox_run',
  cloud_browser: 'step.cloud_browser',
  publish_file: 'step.publish_file',
  look_at: 'step.look_at',
  gmail: 'step.gmail',
  google_calendar: 'step.google_calendar',
  google_drive: 'step.google_drive',
  google_docs: 'step.google_docs',
  google_sheets: 'step.google_sheets',
  google_forms: 'step.google_forms',
  google_tasks: 'step.google_tasks',
  google_contacts: 'step.google_contacts',

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
  world_facts: (i) => clip([i.kind, i.location || i.timezone || (i.base && `${i.base}→${i.quote || ''}`)].filter(Boolean).join(' · '), 64),
  date_calc: (i) => clip([i.op, i.date, i.to, i.time].filter(Boolean).join(' · '), 64),
  convert_units: (i) => clip(`${i.value} ${i.from} → ${i.to}`, 64),
  market_data: (i) => clip([].concat(i.symbols || []).join(', '), 64),
  place_lookup: (i) => clip(i.place || [i.from, i.to].filter(Boolean).join(' → '), 64),
  read_feed: (i) => clip(i.url, 64),
  text_tools: (i) => clip(i.op, 64),
  analyze_data: (i) => clip([i.op, i.group_by, i.column].filter(Boolean).join(' · '), 64),
  make_qr: (i) => clip(i.text, 64),
  http_request: (i) => clip(`${String(i.method || 'GET').toUpperCase()} ${i.url || ''}`, 64),
  encyclopedia: (i) => clip(i.query, 64),
  image_search: (i) => clip(i.query, 64),
  sports: (i) => clip(i.team || i.league || i.player || i.date || i.op, 64),
  show_card: (i) => clip(i.card?.title || i.type, 64),
  sandbox_run: (i) => clip(i.command || i.download || (i.files || []).map((f) => f?.path).join(', '), 72),
  cloud_browser: (i) => clip([i.action, i.url || i.value || i.text || i.key || (i.ref != null ? `#${i.ref}` : '')].filter(Boolean).join(' · '), 72),
  publish_file: (i) => clip(i.file_id, 24),
  look_at: (i) => clip(i.question || i.url || i.file_id, 64),
  gmail: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_calendar: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_drive: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_docs: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_sheets: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_forms: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_tasks: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),
  google_contacts: (i) => clip([i.action, i.query || i.subject || i.summary || i.title || i.name || i.range || i.to].filter(Boolean).join(' · '), 64),

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
  // The function's name used to sit here as a grey badge ("world_facts"). The
  // headline already says what was done in words, and the badge was the one
  // thing in the card nobody read; the name is still on the card's tooltip for
  // whoever is reproducing a step.
  node.title = call.name;

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
  if (/^browser_/.test(name) || name === 'cloud_browser') return 'browser';
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
 * What was sent, as the same tiles it was waiting in above the composer.
 *
 * Above the bubble, not inside it: the files are not part of the sentence, and
 * inside it they were drawn a second, different way from the tray — and an edit,
 * which rebuilds the bubble from the words, took them off the screen although
 * they were still attached. A picture is the picture and a PDF its first page,
 * both from the small copy kept with the file (`/thumb`) rather than the whole
 * file; anything else is its name and its type.
 *
 * `preview` and `thumb` are what the browser already holds for something just
 * sent; `id` is a stored file, and a stored file is a button that opens it.
 */
export function sentFiles(files) {
  const strip = el('div', 'msg__files');
  for (const file of files) strip.append(sentTile(file));
  return strip;
}

/** Its name and type, for anything that is not a picture — or a picture that cannot be drawn. */
function fileFace(tile, name) {
  tile.classList.remove('stage--media');
  tile.classList.add('stage--file');
  tile.replaceChildren();
  const type = extensionBadge(name);
  const icon = el('span', 'stage__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type;
  const label = el('span', 'stage__name');
  label.textContent = name;
  const kind = el('span', 'stage__type');
  kind.textContent = type;
  tile.append(icon, label, kind);
}

function sentTile(file) {
  const name = file.name || 'file';
  const mime = String(file.mime || '');
  const isImage = !!file.isImage || /^image\//i.test(mime) || (!!file.preview && !/pdf/i.test(mime));
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name);
  const tile = el(file.id ? 'button' : 'div', 'stage stage--sent');
  if (file.id) {
    tile.type = 'button';
    tile.dataset.file = file.id;
    tile.setAttribute('aria-label', t('chat.openNamed', { name }));
  }
  tile.title = name;

  const local = file.preview || file.thumb;
  if (!isImage && !isPdf && !local) {
    fileFace(tile, name);
    return tile;
  }
  tile.classList.add('stage--media');
  const img = el('img', 'stage__img');
  img.alt = name;
  img.loading = 'lazy';
  img.decoding = 'async';
  if (local) img.src = local;
  else if (file.id) {
    img.src = `/api/attachments/${encodeURIComponent(file.id)}/thumb`;
    // Sent before small copies were kept: a picture falls back to itself, a
    // PDF to its name. Either way the tile never shows a broken image.
    img.addEventListener('error', function fallback() {
      if (isImage && !img.dataset.full) {
        img.dataset.full = '1';
        img.src = `/api/attachments/${encodeURIComponent(file.id)}`;
      } else {
        img.removeEventListener('error', fallback);
        fileFace(tile, name);
      }
    });
  } else {
    fileFace(tile, name);
    return tile;
  }
  tile.append(img);
  return tile;
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

  /**
   * The same colour scheme inside the frame as outside it.
   *
   * A frame whose document uses a different scheme from the page is painted on
   * an **opaque** canvas — white, for a light-scheme document in a dark page.
   * The frame declared none, so every chart and diagram sat on a white slab
   * with light text on it, legible only by selecting it. Declared to match, the
   * canvas stays transparent and the picture sits on the conversation.
   */
  const scheme = usedScheme();
  frame.style.colorScheme = scheme;
  const ink = scheme === 'light' ? '#1d2733' : '#c8d3de';
  const rule = scheme === 'light' ? '#d5dde5' : '#2a3642';

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
    `:root{color-scheme:${scheme}}` +
    'html,body{margin:0;padding:0;background:transparent;' +
    `font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:${ink}}` +
    // No scrollbar inside a picture: the drawing is scaled to fit instead, and
    // anything genuinely taller scrolls without a bar drawn through it.
    'html{scrollbar-width:none}html::-webkit-scrollbar{display:none}' +
    'body{padding:10px}svg{max-width:100%;max-height:64vh;height:auto;display:block;margin:0 auto}' +
    `table{border-collapse:collapse;font-size:12px}td,th{border:1px solid ${rule};padding:4px 8px}` +
    'a{color:#7cc7ff}' +
    '</style>' +
    `<body>${widget.markup}</body>`;

  host.append(caption, frame);
  // Copy and download, when there is a drawing to take. A fragment of HTML
  // has no single picture to hand over, so it gets none.
  if (/^\s*<svg[\s>]/i.test(String(widget.markup || ''))) {
    host.append(
      mediaTools({
        name: fileNameFrom(widget.title, 'png'),
        blob: () => {
          const svg = frame.contentDocument?.querySelector('svg');
          if (svg) return svgToPng(svg);
          const parsed = new globalThis.DOMParser().parseFromString(widget.markup, 'image/svg+xml').documentElement;
          return svgToPng(/** @type {SVGSVGElement} */ (/** @type {unknown} */ (parsed)));
        },
      }),
    );
  }
  return host;
}

/** Which scheme the page is actually drawn in right now: 'dark' or 'light'. */
function usedScheme() {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'dark' || chosen === 'light') return chosen;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * A chart from the `chart` tool is drawn in the page, interactive; anything
 * else, or a chart whose markup does not survive cleaning, is the sandboxed
 * picture.
 *
 * `toolName` catches the charts drawn before they carried their numbers: the
 * markup is still this app's own drawing, so it goes in the page too — as a
 * picture without the hover, rather than in a frame.
 */
export function widgetNode(widget, toolName = null) {
  const rich = richWidget(widget);
  if (rich) return rich;
  const ours = widget?.kind === 'chart' || toolName === 'chart';
  return (ours && chartFigure(widget)) || widgetFrame(widget);
}

/**
 * Whether a result carries something to draw. A map, a gallery or a card has
 * no markup — it is drawn from its data — so `markup` alone is not the test.
 */
const drawable = (widget) => !!(widget && (widget.markup || ['map', 'images', 'card'].includes(widget.kind)));

/**
 * When a scheduled run fires next, in the zone it was set in.
 *
 * The zone is the task's, not the browser's: somebody who set a 07:30 summary
 * from Hanoi and opens the conversation from a hotel in Tokyo should still read
 * "07:30", because 07:30 Hanoi is when it will arrive.
 */
function nextRunText(iso, tz) {
  const when = new Date(iso);
  if (!iso || !Number.isFinite(when.getTime())) return '';
  /** @type {Intl.DateTimeFormatOptions} */
  const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try {
    return when.toLocaleString(currentLanguage(), tz ? { ...options, timeZone: tz } : options);
  } catch {
    // A zone name this browser does not know. Its own clock is the honest fallback.
    return when.toLocaleString(currentLanguage(), options);
  }
}

/**
 * Standing work, set up in this conversation — or found already set up.
 *
 * A schedule used to come back as one sentence in the transcript: correct, gone
 * as soon as it scrolled away, and with no way from there to the thing itself.
 * Adjusting the time meant finding the Scheduled shelf, finding the row, and
 * opening it. This says the same facts at a glance — how often, which zone,
 * when next — and ends in a pill that opens it, which is where changing it
 * happens.
 *
 * `existing` is the duplicate case. The model was asked for something already
 * set up and is about to ask what to do; this card is what it is asking about,
 * so the heading says "already set up" rather than claiming it was just made.
 *
 * The pill carries the kind and id and nothing else: one delegated listener on
 * the transcript opens it, the same way file cards open, so a transcript of a
 * hundred turns does not hold a hundred handlers.
 */
/** Line icons for the card's rows — fixed markup, never built from data. */
const SCHED_ICON = {
  task: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2.5h6"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="7" height="6" rx="1.5"/><rect x="14" y="14.5" width="7" height="6" rx="1.5"/><path d="M6.5 9.5v3.5a2 2 0 0 0 2 2H14"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
  end: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  steps: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
};

/**
 * What the work will do, as the card's closing section.
 *
 * A task's instructions read better as points when they already are points —
 * lines of their own, or a handful of sentences — and as a paragraph when
 * they are one long thought. A workflow's steps are points by nature.
 */
function scheduleContent(schedule) {
  let points = [];
  if (Array.isArray(schedule.stepList)) points = schedule.stepList.filter(Boolean);
  else if (schedule.prompt) {
    const text = String(schedule.prompt).trim();
    const lines = text.split(/\n+/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    const sentences = text.split(/(?<=[.!?;])\s+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 1) points = lines;
    else if (sentences.length > 1 && sentences.length <= 8) points = sentences;
    else points = [text];
  }
  if (!points.length) return null;

  const section = el('div', 'schedcard__content');
  const label = el('div', 'schedcard__label');
  label.textContent = t(schedule.kind === 'workflow' ? 'sched.stepsHeading' : 'sched.contentHeading');
  section.append(label);
  if (points.length === 1 && schedule.kind !== 'workflow') {
    const p = el('p', 'schedcard__para');
    p.textContent = points[0];
    section.append(p);
  } else {
    const list = el(schedule.kind === 'workflow' ? 'ol' : 'ul', 'schedcard__points');
    for (const point of points) {
      const li = el('li');
      li.textContent = point;
      list.append(li);
    }
    section.append(list);
  }
  return section;
}

/**
 * The confirmation, laid out the way people now expect one: a heading, then a
 * card with the name and whether it is on, its time, how often and in which
 * zone, when it runs next, and what it will do — and under the card a round
 * pill that opens it in the panel beside the conversation to adjust.
 */
export function scheduleCard(schedule) {
  const wrap = el('div', `schedcard${schedule.existing ? ' schedcard--existing' : ''}`);
  wrap.dataset.scheduleKind = schedule.kind;
  wrap.dataset.scheduleId = schedule.id;

  const heading = el('div', 'schedcard__heading');
  const mark = el('span', 'schedcard__mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = schedule.existing ? '!' : '✓';
  const headingText = el('span');
  headingText.textContent = t(
    schedule.existing
      ? 'sched.alreadyThere'
      : schedule.kind === 'workflow'
        ? 'sched.createdWorkflow'
        : 'sched.createdTask',
  );
  heading.append(mark, headingText);

  // How often. A cron of null means two different things depending on the
  // kind: a task with a next run and no cron fires once; with neither, it — or
  // a workflow — waits for somebody to press Run.
  const often = schedule.cron
    ? repeatsAs(schedule)
    : schedule.nextRunAt
      ? t('sched.once')
      : t('freq.manualOnly');
  const parts = cronParts(schedule.cron);

  const card = el('div', 'schedcard__box');

  const top = el('div', 'schedcard__top');
  const icon = el('span', 'schedcard__icon', SCHED_ICON[schedule.kind === 'workflow' ? 'workflow' : 'task']);
  icon.setAttribute('aria-hidden', 'true');
  const who = el('div', 'schedcard__who');
  const name = el('div', 'schedcard__name');
  name.textContent = schedule.title;
  const sub = el('div', 'schedcard__sub');
  sub.textContent = [
    t(schedule.enabled ? 'sched.on' : 'proj.taskPaused'),
    schedule.cron ? t(`sched.repeat.${parts.frequency}`) : often,
  ].join(' · ');
  who.append(name, sub);
  const state = el('span', `schedcard__state${schedule.enabled ? '' : ' is-off'}`);
  state.textContent = t(schedule.enabled ? 'pages.tasks.active' : 'pages.tasks.paused');
  top.append(icon, who, state);
  card.append(top);

  const rows = el('ul', 'schedcard__rows');
  const row = (iconKey, text, strong = false) => {
    if (!text) return;
    const li = el('li');
    li.append(el('span', 'schedcard__ri', SCHED_ICON[iconKey]));
    const span = el(strong ? 'strong' : 'span');
    span.textContent = text;
    li.append(span);
    rows.append(li);
  };
  if (schedule.cron) {
    // The times it runs at, or — for an interval, which has none — the interval.
    row('clock', ['minutes', 'hours', 'hourly'].includes(parts.frequency) ? often : parts.times.join(', '), true);
  }
  row('calendar', [often, schedule.tz ? t('sched.inZone', { tz: schedule.tz }) : t('sched.serverTime')].join(' · '));
  if (schedule.nextRunAt) row('next', t('sched.next', { when: nextRunText(schedule.nextRunAt, schedule.tz) }));
  if (schedule.endsOn) {
    // A calendar date, read as one: formatted in UTC so no zone shifts the day.
    const [y, m, d] = String(schedule.endsOn).split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(currentLanguage(), { timeZone: 'UTC', dateStyle: 'medium' });
    row('end', t('sched.endsOn', { date }));
  }
  if (schedule.kind === 'workflow' && schedule.steps && !schedule.stepList) row('steps', t('sched.stepCount', { n: schedule.steps }));
  if (rows.children.length) card.append(rows);

  const content = scheduleContent(schedule);
  if (content) card.append(content);

  // The one control. Blue for when, plain for what — it reads as a summary and
  // opens the panel where every part of it can be changed.
  const next = schedule.nextRunAt ? nextRunText(schedule.nextRunAt, schedule.tz) : '';
  const pill = el('button', 'schedcard__pill');
  pill.type = 'button';
  pill.dataset.scheduleKind = schedule.kind;
  pill.dataset.scheduleId = schedule.id;
  const when = el('span', 'schedcard__when');
  when.textContent = [often, next ? t('sched.next', { when: next }) : null].filter(Boolean).join(' · ');
  const what = el('span', 'schedcard__what');
  what.textContent = schedule.title;
  pill.append(when, document.createTextNode(' · '), what);
  pill.title = t('sched.open');

  wrap.append(heading, card, pill);
  return wrap;
}

/**
 * One card per schedule in a turn, however many times the model touched it.
 *
 * A turn that creates a workflow and then updates it twice would otherwise show
 * three cards for the one thing, two of them already out of date. The newest
 * replaces the older, the same rule the file cards follow.
 */
function placeScheduleCard(body, schedule) {
  const card = scheduleCard(schedule);
  const existing = [...body.querySelectorAll('.schedcard')].find(
    (node) => node.dataset.scheduleKind === schedule.kind && node.dataset.scheduleId === schedule.id,
  );
  if (existing) existing.replaceWith(card);
  else body.append(card);
}

/** A question card's answer, drawn as the person's own bubble. */
function placeAnswer(body, text) {
  const bubble = el('div', 'answerbubble');
  bubble.setAttribute('aria-label', t('chat.yourAnswer'));
  bubble.textContent = text;
  body.append(bubble);
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

  card.append(icon, body, open, download, shareButton(file, card));
  return card;
}

/**
 * Share by link: press once to publish and copy the link, and a row appears
 * with the link and a way to take it back. The link is the same every time it
 * is asked for, so pressing again never breaks one already sent round.
 */
function shareButton(file, card) {
  const button = el('button', 'btn btn--ghost filecard__btn');
  button.type = 'button';
  button.dataset.noOpen = '';
  button.textContent = t('share.button');

  const showRow = (path) => {
    card.querySelector('.filecard__share')?.remove();
    const row = el('div', 'filecard__share');
    row.dataset.noOpen = '';
    const url = `${location.origin}${path}`;
    const field = el('input', 'filecard__link');
    field.type = 'text';
    field.readOnly = true;
    field.value = url;
    field.setAttribute('aria-label', t('share.linkLabel'));
    field.addEventListener('focus', () => field.select());
    const copy = el('button', 'btn btn--ghost filecard__btn');
    copy.type = 'button';
    copy.textContent = t('share.copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = t('share.copied');
      } catch {
        field.select();
      }
    });
    const stop = el('button', 'btn btn--ghost filecard__btn');
    stop.type = 'button';
    stop.textContent = t('share.stop');
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      try {
        await api.unshareFile(file.id);
        row.remove();
        button.textContent = t('share.button');
      } catch (err) {
        stop.disabled = false;
        row.append(el('span', 'filecard__share-error', escapeHtml(err.message)));
      }
    });
    row.append(el('span', 'filecard__share-note', escapeHtml(t('share.note'))), field, copy, stop);
    card.append(row);
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const { path } = await api.shareFile(file.id);
      showRow(path);
      button.textContent = t('share.shared');
      try {
        await navigator.clipboard.writeText(`${location.origin}${path}`);
      } catch {
        /* the link is on screen to copy by hand */
      }
    } catch (err) {
      button.textContent = t('share.failed');
      button.title = err.message;
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

/**
 * A file the assistant made, placed in the transcript — replacing the card for
 * the same id, so a document edited three times is one card, not four.
 *
 * A picture is also *shown*: a generated image behind an "Open" button is a
 * picture nobody sees until they go looking. It sits above its card, with the
 * corner buttons to copy or download it.
 */
function placeFile(body, file) {
  const card = fileCard(file);
  const existing = [...body.querySelectorAll('.filecard')].find((node) => node.dataset.file === file.id);
  if (existing) existing.replaceWith(card);
  else body.append(card);

  if (!/^image\//i.test(file.mime || '') || /svg/i.test(file.mime || '')) return;
  const src = `/api/attachments/${file.id}${file.version ? `?v=${file.version}` : ''}`;
  const figure = el('figure', 'media');
  figure.dataset.media = file.id;
  const open = el('button', 'media__open');
  open.type = 'button';
  open.dataset.file = file.id;
  open.title = t('chat.openNamed').replace('{name}', file.name || '');
  const img = el('img');
  img.src = src;
  img.alt = file.name || '';
  img.loading = 'lazy';
  open.append(img);
  figure.append(
    open,
    mediaTools({
      name: file.name || fileNameFrom('image', 'png'),
      blob: () => imageUrlToPng(src),
    }),
  );
  const shown = [...body.querySelectorAll('figure.media')].find((node) => node.dataset.media === file.id);
  if (shown) shown.replaceWith(figure);
  else card.before(figure);
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


  if (text) {
    const body = el('div', 'bubble__text');
    // `textContent` still reads back the message exactly as typed — an anchor
    // contributes its own text — so copying and editing a bubble are unchanged.
    body.append(withLinks(text));
    bubble.append(body);
  }

  // The files above the words, and outside them — see sentFiles.
  if (files.length) wrap.append(sentFiles(files));
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
/**
 * The newest web card and the block it is in, so the next step's block can
 * add to it rather than draw another beside it (see `webCard`). Module-level
 * because each step is a separate `assistantMessage`.
 * @type {{ card: any, wrap: HTMLElement, body: HTMLElement } | null}
 */
let lastWebCard = null;

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
  /** Settled since its last delta, so `finishThinking` has nothing to do. */
  let thinkingDone = false;
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

  /** Whatever run is open — steps or the web card — ends here. */
  function closeGroup() {
    closeSteps();
    closeWeb();
  }

  /**
   * The web card: searching, reading a page, extracting, calling an API,
   * reading a feed — one card per run of them, like Claude's "Searched the web".
   *
   * The header says what happened and the query it was for; the body lists every
   * site involved as a row — its icon, its title, its domain — pointing at the
   * exact address used. A page read after a search is the same row as its
   * result, not a second one. The raw JSON that used to fill these cards is not
   * something anybody reads; the tool's answer is still what the model got.
   *
   * One search, one card. A second query gets a card of its own rather than a
   * "· +1" on the first, which hid what was asked and mixed two lists of
   * results into one. `webs` holds every card of the current run, because two
   * searches sent together finish in either order and each must settle its own.
   */
  let web = null;
  /** @type {Set<any>} */
  const webs = new Set();

  function closeWeb() {
    for (const w of webs) {
      w.live = false;
      paintWeb(w);
      w.node.open = false;
    }
    webs.clear();
    web = null;
  }

  function paintWeb(w) {
    const working = w.live && w.pending > 0;
    const allFailed = !working && w.calls > 0 && w.failures === w.calls;
    w.mark.innerHTML = working ? MARK_PENDING : `<span class="mark">${allFailed ? '✗' : '✓'}</span>`;
    w.title.textContent = t(w.searched ? (working ? 'web.searching' : 'web.searched') : working ? 'web.reading' : 'web.read');
    w.query.textContent = w.queryText;
    w.node.classList.toggle('web--error', allFailed);
    w.list.innerHTML = [...w.rows.values()].map((row) => webRowHtml(row)).join('');
    w.list.hidden = w.rows.size === 0;
  }

  /** The card this call belongs in: a search that follows a search starts a new one. */
  function webCard(isSearch) {
    if (web && !(isSearch && web.searched)) return web;
    /**
     * Carried over from the step before.
     *
     * Every saved step of a turn is drawn in a block of its own, so four page
     * reads in four steps drew four "Read the web" cards stacked one after
     * another. When this block has shown nothing yet and the one right before
     * it ended on a web card, the read joins that card instead — the same work,
     * one card. A reasoning card or a line of reply between them is a real
     * break, and so is a second search (one query, one card).
     */
    const last = lastWebCard;
    if (
      !web &&
      last &&
      body.childElementCount === 0 &&
      last.wrap.nextElementSibling === wrap &&
      last.card.node.isConnected &&
      // Nothing drawn after the card: in its own block, and in the block that
      // last joined it (which holds nothing of its own).
      last.card.node.parentElement?.lastElementChild === last.card.node &&
      (last.body === last.card.node.parentElement || last.body.childElementCount === 0) &&
      !(isSearch && last.card.searched)
    ) {
      web = last.card;
      web.live = true;
      web.node.open = true;
      webs.add(web);
      // The chain continues from this block: the next step joins it here too.
      lastWebCard = { card: web, wrap, body };
      return web;
    }
    closeSteps();
    const node = el('details', 'block web');
    node.open = true;
    // The chevron is the one every `details.block` draws after its summary —
    // a second one of its own here put two arrows side by side.
    const summary = el('summary', 'web__head');
    const mark = el('span', 'web__mark');
    const title = el('span', 'web__title');
    const query = el('span', 'web__query');
    summary.append(mark, title, query);
    const list = el('div', 'web__list');
    node.append(summary, list);
    body.append(node);
    web = { node, mark, title, query, list, rows: new Map(), queryText: '', pending: 0, calls: 0, failures: 0, searched: false, live: true };
    webs.add(web);
    lastWebCard = { card: web, wrap, body };
    return web;
  }

  /**
   * The plan as it stood before this update — the last plan card above it,
   * in this message first and then anywhere in the conversation.
   */
  function previousPlan() {
    const here = body.querySelectorAll('[data-plan-steps]');
    let node = here[here.length - 1];
    if (!node) {
      const all = document.querySelectorAll('#messages [data-plan-steps]');
      node = all[all.length - 1];
    }
    try {
      return node ? JSON.parse(/** @type {HTMLElement} */ (node).dataset.planSteps || '[]') : [];
    } catch {
      return [];
    }
  }

  /**
   * An update to the plan, said as what changed: "Added task Run the full
   * pipeline", "Completed Read chapter 1" — and opened, the steps it touched
   * with their detail. "Updated the plan · 7 steps" was true every time and
   * told nobody anything, least of all that a task had been added half-way.
   */
  function startPlanCard(call) {
    closeGroup();
    const steps = normalisePlan(call.input?.steps);
    const change = planChange(previousPlan(), steps);

    const block = el('details', 'block tool plancard');
    block.dataset.planSteps = JSON.stringify(steps);
    const summary = el('summary');
    const paint = (mark) => {
      summary.innerHTML = `${mark}<span class="tool__name">${escapeHtml(change.headline)}</span>`;
      if (change.arg) summary.append(detailNode('tool__arg', change.arg, null));
    };
    paint(MARK_PENDING);
    const inner = el('div', 'block__body');
    const list = el('ul', 'plancard__list');
    list.innerHTML = change.steps.map((s) => planItemHtml(s, { withDetail: true })).join('');
    inner.append(list);
    block.append(summary, inner);
    body.append(block);

    return {
      complete(result) {
        block.classList.toggle('tool--error', !!result.isError);
        paint(`<span class="mark">${result.isError ? '✗' : '✓'}</span>`);
        if (result.isError) {
          const why = el('pre');
          why.textContent = result.content || '';
          inner.append(why);
        }
      },
    };
  }

  function startWeb(call) {
    const w = webCard(call.name === 'web_search');
    w.calls += 1;
    w.pending += 1;
    const input = call.input || {};
    if (call.name === 'web_search') {
      w.searched = true;
      w.queryText = String(input.query || '');
    }
    const url = call.name === 'web_search' ? null : String(input.url || '');
    if (url) {
      const row = w.rows.get(url) || { url, title: null, state: null };
      row.state = 'pending';
      w.rows.set(url, row);
    }
    paintWeb(w);
    return {
      complete(result) {
        w.pending = Math.max(0, w.pending - 1);
        if (result.isError) w.failures += 1;
        if (call.name === 'web_search') {
          // What a citation chip's card shows beyond the name in the reply.
          if (!result.isError) rememberSearch(result.content);
          for (const hit of parseResults(result.content)) {
            const row = w.rows.get(hit.url);
            if (row) row.title ||= hit.title;
            else w.rows.set(hit.url, { url: hit.url, title: hit.title, state: null });
          }
        } else if (url) {
          const row = w.rows.get(url);
          row.state = result.isError ? 'failed' : 'read';
          row.note = result.isError ? String(result.content || '').split('\n')[0].slice(0, 160) : null;
          row.title ||= titleFromContent(call.name, result.content);
          if (!result.isError) rememberPage(url, row.title);
        }
        paintWeb(w);
        // Folded once nothing in it is still loading: the sites are one click
        // away, and an open list of ten results pushed the answer off screen.
        if (w.pending === 0) w.node.open = false;
      },
    };
  }

  function closeSteps() {
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
        pre.textContent = forDisplay(result.content) || t('chat.noOutput');
        out.append(pre);
        item.append(out);

        if (result.file?.id) placeFile(body, result.file);
        if (drawable(result.widget)) body.append(widgetNode(result.widget, result.name));
        if (result.schedule?.id) placeScheduleCard(body, result.schedule);
        if (result.answered) placeAnswer(body, result.answered);
      },
    };
  }

  /** The card this call belongs in, opening a new one if the run just started. */
  function groupFor(family) {
    if (group && group.family === family) return group;
    closeGroup();
    // closeGroup ended the web card too: a browser step after a search is a new
    // piece of work.

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

  /** Folded, the window shows the newest lines — the ones just finished. */
  const keepTailInView = () => {
    if (!thinkingBody || thinkingBlock?.classList.contains('is-open')) return;
    thinkingBody.scrollTop = thinkingBody.scrollHeight;
  };

  const api = {
    node: wrap,

    /**
     * The reasoning, as a card that is readable both folded and open.
     *
     * Folded, it is a window a few lines tall that always shows the newest
     * lines, fading at its edges — you can watch it think without it taking
     * the screen. Open, it is the whole text. Either way the words that just
     * arrived glow and settle, so the eye finds where it is up to.
     *
     * No spinner, the same as every other card: the status line under the
     * transcript already says, in words, what is running. A card still working
     * is the one without a tick.
     */
    appendThinking(delta) {
      if (!thinkingBlock) {
        thinkingBlock = el('div', 'think is-live');
        const head = el(
          'button',
          'think__head',
          `${MARK_PENDING} <span class="think__title">${escapeHtml(t('status.thinking'))}</span><span class="think__chev" aria-hidden="true">›</span>`,
        );
        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');
        head.addEventListener('click', () => {
          const open = !thinkingBlock.classList.contains('is-open');
          thinkingBlock.classList.toggle('is-open', open);
          head.setAttribute('aria-expanded', String(open));
          if (!open) keepTailInView();
        });
        thinkingBody = el('div', 'think__body');
        thinkingBody.append(el('div', 'think__text'));
        thinkingBlock.append(head, thinkingBody);
        body.append(thinkingBlock);
      }
      thinkingDone = false;
      const text = thinkingBody.firstElementChild;
      const fresh = el('span', 'think__new');
      fresh.textContent = delta;
      text.append(fresh);
      // Settled spans go back to plain text, so a long trace is not ten
      // thousand elements. The last few keep their glow.
      const spans = text.querySelectorAll('.think__new');
      if (spans.length > 48) {
        for (const span of [...spans].slice(0, spans.length - 24)) span.replaceWith(span.textContent);
        text.normalize();
      }
      keepTailInView();
    },

    finishThinking() {
      // Called on every text delta. Settling the trace — two queries, a
      // normalize over the whole of it, and a forced layout — once is enough.
      if (!thinkingBlock || thinkingDone) return;
      thinkingDone = true;
      thinkingBlock.classList.remove('is-live');
      thinkingBlock.querySelector('.think__head .mark')?.replaceWith(el('span', 'mark', '✓'));
      thinkingBlock.querySelector('.think__title').textContent = t('chat.reasoning');
      const text = thinkingBody.firstElementChild;
      for (const span of text.querySelectorAll('.think__new')) span.replaceWith(span.textContent);
      text.normalize();
      keepTailInView();
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
      // Through the same rules the server applies, so a reloaded transcript
      // shows the plan that was shown live — see plan.js.
      plan.querySelector('ul').innerHTML = normalisePlan(steps)
        .map((s) => planItemHtml(s))
        .join('');
      // Keep the plan pinned above the prose it describes.
      body.prepend(plan);
    },

    /**
     * A card for a call the model is still writing.
     *
     * Between the moment a model names a tool and the moment its arguments are
     * complete there can be a minute or more — a 130-question quiz is a very long
     * `content` string — and all that showed was a status line that never moved.
     * This draws the card straight away with the same headline it will have, and
     * a size that grows as the arguments arrive. The real card replaces it when
     * the call is whole.
     */
    draftTool(name) {
      // Browser clicks and file reads are tiny and grouped into a run of steps;
      // a draft card between them would only flicker.
      if (stepFamily(name) || WEB_TOOLS.has(name)) return null;
      const { verb } = describeStep(name, {});
      const block = el('div', 'block tool tool--draft');
      block.setAttribute('role', 'status');
      const head = el('div', 'tool__draft');
      const size = el('span', 'tool__time');
      head.innerHTML = `${MARK_PENDING}<span class="tool__name">${escapeHtml(verb)}</span>`;
      head.append(size);
      block.append(head);
      body.append(block);
      return {
        progress(chars) {
          const kb = chars / 1024;
          size.textContent = t('chat.drafting', {
            size: kb >= 1 ? `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB` : `${chars} B`,
          });
        },
        remove() {
          block.remove();
        },
      };
    },

    /** Start a collapsed card for a tool call; returns a handle to complete it. */
    startTool(call) {
      if (WEB_TOOLS.has(call.name)) return startWeb(call);
      if (call.name === 'update_plan') return startPlanCard(call);
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
          output.textContent = forDisplay(result.content) || t('chat.noOutput');

          /**
           * A document came out of this call.
           *
           * The card goes beside the collapsed tool block rather than inside it:
           * the tool call is machinery nobody opens, and the file is the thing
           * that was asked for. A rewrite replaces the card for that same id, so
           * a document edited three times is one card, not four.
           */
          if (result.file?.id) placeFile(body, result.file);

          /**
           * A picture drawn into the conversation itself.
           *
           * Beside the tool block like a file card, for the same reason: the call
           * is machinery and the picture is the point. Unlike a file it is not
           * something to open — it is already open, which is what makes it the
           * right shape for "here is what I found" rather than "here is a report".
           */
          if (drawable(result.widget)) body.append(widgetNode(result.widget, result.name));

          /**
           * A schedule set up — or found already there — by this call.
           *
           * Beside the tool block for the reason the other two are: the call is
           * machinery, and "it is set for 07:30 every weekday, press here to
           * change it" is what was asked for.
           */
          if (result.schedule?.id) placeScheduleCard(body, result.schedule);

          /**
           * What the person answered on a question card, on their side of the
           * conversation — so a setup filled in through a form reads back like
           * something they said, live and after a reload.
           */
          if (result.answered) placeAnswer(body, result.answered);
        },
      };
    },

    /** Rebuild from a persisted message when reloading a conversation. */
    /**
     * @param pending  this turn is still running, so a call with no result yet
     *   is waiting for one rather than lost.
     */
    hydrate(message, resultsByCallId, { pending = false } = {}) {
      if (message.thinking) {
        api.appendThinking(message.thinking);
        api.finishThinking();
      }
      for (const call of message.toolCalls || []) {
        if (call.name === 'update_plan') api.setPlan(call.input?.steps);
        const handle = api.startTool(call);
        const result = resultsByCallId?.get(call.id);
        /*
         * No result, and nothing still running: the server was cut off before
         * the call could answer (a long deep research past the time limit).
         * That was drawn as a green tick over "no result" — a success that
         * never happened. It is said for what it is; a turn still running
         * leaves the card spinning until its result arrives.
         */
        if (result) handle.complete(result);
        else if (!pending) handle.complete({ content: t('chat.cutOff'), isError: true });
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
      // Sources the conversation cannot account for are marked once the reply
      // is whole; opening a chip checks again with whatever has loaded since.
      if (prose) auditCitations(prose);
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
      // `false` is "nothing started" — a run was still going — and then the
      // button stays, rather than vanishing having done nothing.
      if (onContinue() !== false) wrap.remove();
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

  // 'ok' is a success: the same toast with a green edge, as an error has a red one.
  const node = el('div', `toast${kind === 'error' ? ' toast--error' : kind === 'ok' ? ' toast--ok' : ''}`);
  node.dataset.message = message;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6500 : 3200);
}
