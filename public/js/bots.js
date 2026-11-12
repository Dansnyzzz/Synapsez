import { api, runGroup, continueGroup } from './api.js';
import { t, localeTag } from './i18n.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { counted } from './format.js';
import { faceHtml, paintFaces, inkOf } from './bot-avatar.js';
import { mentionSpans, atQuery } from './bot-mentions.js';
import { openBotSettings, mergeTeam, changeLine } from './bots-settings.js';
import { compactCount } from './bots-usage.js';
import { fileCard, copyButton, describeStep } from './render.js';
import { sortRows, needsKeys, rowMarks, needsHtml, menuHtml, calledHtml } from './bots-list.js';
import { firstRunHtml, createFromFirstRun } from './bots-firstrun.js';
import { createAside } from './bots-aside.js';
import { openTeamFiles, exportTeam } from './bots-porting.js';

/**
 * The Bot page (owner, 2026-11-09): the person's team of bots, led by Chief.
 *
 * Laid out the way DS Bot lays out its team (NOTICE), in this app's own look: on the
 * left, Chief's card and then the group chats and bots with what was said last; in
 * the middle, the open conversation with a pill naming it and a box to write in; on
 * the right, its details — model, instructions, memory, usage. Bot settings is a
 * dialog of its own (bots-settings.js).
 *
 * A bot's own chat is an ordinary conversation of this app, and since 2026-11-10 it is
 * shown and written in the home chat itself (`home`, from app.js): the transcript and
 * the box are moved into the middle column, so thinking and text stream as they do
 * there, files go with a message, and the modes, the model chip and incognito hold
 * (owner: "as smooth as the home chat, the same box"). A group's round is one streamed
 * request of its own (`/bot-groups/:id/run`), drawn here, written in the same borrowed
 * box; one Stop stops every member that is working.
 *
 * Every name, message and memory entry drawn here was written by a person or a model:
 * it goes through `escapeHtml`, or through `renderMarkdown`, which escapes first.
 */

const $ = (id) => document.getElementById(id);
const ID = /^[\w-]{1,80}$/;

/** `#bot`, `#bot/b/<bot>`, `#bot/g/<group>` — where the page is, so a reload or a link lands there. */
export function readBotsHash(hash = location.hash) {
  const m = /^#bot(?:\/(b|g)\/([^/?#]+))?$/.exec(String(hash || ''));
  if (!m) return null;
  let id = null;
  try {
    id = m[2] ? decodeURIComponent(m[2]) : null;
  } catch {
    id = null;
  }
  return { kind: m[1] === 'g' ? 'group' : 'bot', id: id && ID.test(id) ? id : null };
}
const hashOf = (open) => (open ? `#bot/${open.kind === 'group' ? 'g' : 'b'}/${encodeURIComponent(open.id)}` : '#bot');
function setHash(open) {
  const hash = hashOf(open);
  if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}
function clearHash() {
  if (readBotsHash()) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

/** A tool call, as one line of what the bot did: the team's own tools read as events. */
const TEAM_EVENTS = new Set(['create_bot', 'create_group', 'update_bot', 'update_group', 'remember', 'forget']);

/** @param {string} iso */
const timeOf = (iso) => {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const time = at.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
  const today = new Date().toDateString() === at.toDateString();
  return today ? t('bots.today', { time }) : `${at.toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })} ${time}`;
};

/**
 * @param {{
 *   toast: (text: string, kind?: string) => void,
 *   openSettings: (tab?: string) => void,
 *   openFeedback: () => void,
 *   openAutomations: (tab: string) => void,
 *   onShow?: () => void,
 *   home: { input: HTMLTextAreaElement, lend: (slot: HTMLElement, ids: ('thread' | 'dock')[]) => void, giveBack: () => void,
 *     open: (chatId: string, options?: { incognito?: boolean }) => Promise<boolean>, blank: () => void,
 *     setHook: (hook: any) => void, refreshSend: () => void, setBlocker: (fn: (() => string | null) | null) => void,
 *     incognito: () => boolean, model: () => string | undefined,
 *     setTitle: (text: string) => void, setPlaceholder: (text: string | null) => void },
 *   openFile?: (id: string) => void,
 * }} deps  `home`: the home chat's transcript and box, lent to the Bot page (owner, 2026-11-10);
 *   `openFile`: the home chat's viewer, for a file a bot made in a group
 */
export function createBotPage({ toast, openSettings, openFeedback, openAutomations, onShow = () => {}, home, openFile = () => {} }) {
  const page = $('bot-page');
  /** @type {{ bots: any[], groups: any[], creatures: string[], limits: any } | null} */
  let team = null;
  /** What is open: a bot or a group, by id. */
  let open = /** @type {{ kind: 'bot' | 'group', id: string } | null} */ (null);
  /** The open conversation as last read. */
  let chat = /** @type {{ chatId: string, messages: any[] } | null} */ (null);
  /** A run in progress here: what stops it. */
  let run = /** @type {{ controller: AbortController, kind: string, id: string, chatId?: string } | null} */ (null);
  let detailsOpen = false;
  /** The newest details drawn: an older read that lands late changes nothing. */
  let detailsTurn = 0;
  let memoryOpen = false;
  /** Which bots are working in the open group, and what each has said so far. */
  const working = new Map();
  /**
   * The open group's round as the server last said: running (a segment holds it, or it is
   * between two) and what it has waiting — the Continue after the ceiling or a long round.
   */
  let groupState = /** @type {{ running: boolean, pending: { reason: string } | null }} */ ({ running: false, pending: null });
  /** Following a round this tab did not start (another tab, another invocation): the poll's timer. */
  let follow = /** @type {{ timer: any, target: any } | null} */ (null);
  let shown = false;
  let picker = /** @type {{ start: number, items: any[], index: number } | null} */ (null);
  /** Each bot's own conversation once known, so opening it again goes straight to the home chat. */
  const chatIds = new Map();
  /** What waits for the person (GET /bots/attention), read with the team (spec B.2). */
  let attention = /** @type {any[]} */ ([]);
  /** Whom the open group's message called, and how each went (spec B.3). */
  let called = /** @type {Array<{ bot: string, how: string }>} */ ([]);
  /** The row menu: for which row, and what opened it (focus goes back there). */
  let rowMenu = /** @type {{ kind: 'bot' | 'group', id: string, from: HTMLElement } | null} */ (null);
  /** A webhook's address and secret, shown once after it is made or rotated (spec C.1). */
  let hookShown = /** @type {{ taskId: string, url: string, secret: string } | null} */ (null);
  /** The hook whose deliveries are open, and what was read for it. */
  let hookOpen = '';
  let hookData = /** @type {any} */ (null);
  /** The open bot's waits (spec C.2), as chips above its box. */
  let waits = /** @type {any[]} */ ([]);
  /** The first-run card (spec B.7): the goals ticked, what was typed for each, and whether it was put away. */
  const firstPicked = new Set(['write']);
  const firstDrafts = new Map();
  let firstSkipped = (() => {
    try {
      return localStorage.getItem('bots.firstSkipped') === '1';
    } catch {
      return false;
    }
  })();

  page.innerHTML = `
    <aside class="botlist" aria-label="${escapeHtml(t('bots.list'))}">
      <header class="botlist__head">
        <h1 class="botlist__title">${escapeHtml(t('bots.title'))}</h1>
        <button class="icon-btn" type="button" data-act="new" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(t('bots.new'))}" aria-label="${escapeHtml(t('bots.new'))}">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>
        </button>
        <button class="icon-btn" type="button" data-act="settings" title="${escapeHtml(t('bots.settings'))}" aria-label="${escapeHtml(t('bots.settings'))}">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg>
        </button>
        <div class="botmenu" role="menu" data-menu="new" hidden>
          <button type="button" role="menuitem" data-act="new-bot">${escapeHtml(t('bots.newBot'))}</button>
          <button type="button" role="menuitem" data-act="new-group">${escapeHtml(t('bots.newGroup'))}</button>
          <button type="button" role="menuitem" data-act="team-files">${escapeHtml(t('bots.port.menu'))}</button>
        </div>
      </header>
      <div class="botlist__chief" data-chief></div>
      <div class="botlist__needs" data-needs></div>
      <ul class="botlist__rows" data-rows></ul>
      <div class="botmenu botrowmenu" role="menu" data-row-menu hidden></div>
    </aside>
    <section class="botchat" aria-label="${escapeHtml(t('bots.title'))}" data-chat>
      <header class="botchat__head">
        <button class="icon-btn botchat__back" type="button" data-act="back" aria-label="${escapeHtml(t('bots.back'))}" title="${escapeHtml(t('bots.back'))}">‹</button>
        <button class="botchat__pill" type="button" data-act="details" aria-expanded="false"></button>
        <button class="btn btn--small botchat__aside" type="button" data-act="aside" hidden>${escapeHtml(t('bots.aside.button'))}</button>
      </header>
      <div class="botchat__log scroll-quiet" role="log" aria-live="polite" aria-relevant="additions" data-log></div>
      <div class="botchat__working" data-working aria-live="polite"></div>
      <div class="botfirst-wrap scroll-quiet" data-first hidden></div>
      <div class="botpaused" data-paused role="status" hidden></div>
      <ul class="botwaits" data-waits hidden></ul>
      <aside data-aside hidden></aside>
      <!-- The home chat's transcript and box are lent here (app.js lendHome). -->
      <div class="botchat__home" data-home>
        <div class="atpick" role="listbox" aria-label="${escapeHtml(t('bots.pickerLabel'))}" data-picker hidden></div>
      </div>
    </section>
    <aside class="botdetails scroll-quiet" data-details hidden></aside>`;

  const list = /** @type {HTMLElement} */ (page.querySelector('[data-rows]'));
  const chiefBox = /** @type {HTMLElement} */ (page.querySelector('[data-chief]'));
  const log = /** @type {HTMLElement} */ (page.querySelector('[data-log]'));
  const pill = /** @type {HTMLButtonElement} */ (page.querySelector('[data-act="details"]'));
  // The home chat's own box, lent to this page while it shows (app.js).
  const input = home.input;
  const homeSlot = /** @type {HTMLElement} */ (page.querySelector('[data-home]'));
  const pickerBox = /** @type {HTMLElement} */ (page.querySelector('[data-picker]'));
  const details = /** @type {HTMLElement} */ (page.querySelector('[data-details]'));
  const workingBox = /** @type {HTMLElement} */ (page.querySelector('[data-working]'));
  const newMenu = /** @type {HTMLElement} */ (page.querySelector('[data-menu="new"]'));
  const needsBox = /** @type {HTMLElement} */ (page.querySelector('[data-needs]'));
  const rowMenuBox = /** @type {HTMLElement} */ (page.querySelector('[data-row-menu]'));
  const firstBox = /** @type {HTMLElement} */ (page.querySelector('[data-first]'));
  const pausedBox = /** @type {HTMLElement} */ (page.querySelector('[data-paused]'));
  const waitsBox = /** @type {HTMLElement} */ (page.querySelector('[data-waits]'));
  const asideButton = /** @type {HTMLElement} */ (page.querySelector('[data-act="aside"]'));
  /** Who a group's message called, above the working lines. */
  const calledBox = document.createElement('div');
  calledBox.className = 'botcalled-wrap';
  workingBox.prepend(calledBox);

  const botOf = (id) => team?.bots.find((b) => b.id === id) || null;
  const groupOf = (id) => team?.groups.find((g) => g.id === id) || null;
  const chief = () => team?.bots.find((b) => b.main) || null;
  const subject = () => (open?.kind === 'group' ? groupOf(open.id) : open ? botOf(open.id) : null);
  const adminOf = (group) => (group?.admin && group.members.includes(group.admin) ? group.admin : group?.members?.[0] || null);
  const membersOf = (group) => (group?.members || []).map(botOf).filter(Boolean);
  /** The card beside a bot's chat for a question asked aside (spec B.6). */
  const aside = createAside({ host: /** @type {HTMLElement} */ (page.querySelector('[data-aside]')), api, toast, botOf: (id) => botOf(id), model: () => home.model() });

  /* ── the list on the left ─────────────────────────────────────── */

  function previewOf(item, isGroup) {
    // At work: who, rather than the last thing said (owner, 2026-11-10: what was that dot?).
    if (item.running) {
      const who = isGroup ? botOf(item.working?.[0])?.name : item.name;
      return who ? t('bots.workingNow', { name: who }) : t('bots.busyNow');
    }
    const last = item.last;
    if (!last?.text) return '';
    const who = last.role === 'user' ? t('bots.you') : isGroup ? botOf(last.bot)?.name || '' : '';
    return `${who ? `${who}: ` : ''}${last.text}`.replace(/\s+/g, ' ').slice(0, 90);
  }

  function groupFaces(group) {
    const faces = membersOf(group).slice(0, 3);
    return `<span class="botfaces" aria-hidden="true">${faces.map((b) => faceHtml(b, 20)).join('')}</span>`;
  }

  /** A bot or group at work: the same small ring as its working line, saying so to a screen reader and on hover. */
  const busyMark = () => `<span class="botbusy spinner" role="img" aria-label="${escapeHtml(t('bots.running'))}" title="${escapeHtml(t('bots.running'))}"></span>`;

  function renderList() {
    if (!team) return;
    const lead = chief();
    chiefBox.innerHTML = lead
      ? `<button class="botchief${open?.kind === 'bot' && open.id === lead.id ? ' is-open' : ''}" type="button" data-open="bot:${escapeHtml(lead.id)}" aria-current="${open?.id === lead.id ? 'true' : 'false'}">
           ${faceHtml(lead, 64, 'botchief__face')}
           <span class="botchief__star" aria-hidden="true">★</span>
           <span class="botchief__name">${escapeHtml(lead.name)}</span>
           <span class="botchief__role">${escapeHtml(lead.role || t('bots.mainTag'))}</span>
           ${rowMarks(lead, { needed: needsKeys(attention).has(`bot:${lead.id}`), busy: busyMark() })}
         </button>`
      : '';
    // Pinned first, then whoever spoke last (spec B.3).
    const needed = needsKeys(attention);
    list.innerHTML = sortRows(team)
      .map(({ kind, item }) => {
        const isOpen = open?.kind === kind && open.id === item.id;
        const preview = previewOf(item, kind === 'group');
        const key = `${kind}:${escapeHtml(item.id)}`;
        const pin = item.pinned ? `<span class="botrow__pin" role="img" aria-label="${escapeHtml(t('bots.pinnedMark'))}" title="${escapeHtml(t('bots.pinnedMark'))}">📌</span>` : '';
        const paused = item.paused ? `<span class="bottag bottag--paused">${escapeHtml(t('bots.pausedTag'))}</span>` : '';
        return `<li class="botrowwrap"><button class="botrow${isOpen ? ' is-open' : ''}${item.paused ? ' is-paused' : ''}" type="button" data-open="${key}" data-row="${key}" aria-current="${isOpen ? 'true' : 'false'}">
          ${kind === 'group' ? groupFaces(item) : faceHtml(item, 36)}
          <span class="botrow__text"><span class="botrow__name">${pin}${escapeHtml(item.name)}${paused}</span>${preview ? `<span class="botrow__last">${escapeHtml(preview)}</span>` : ''}</span>
          ${rowMarks(item, { needed: needed.has(`${kind}:${item.id}`), busy: busyMark() })}
        </button><button class="icon-btn botrow__more" type="button" data-row-more="${key}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('bots.menu.more', { name: item.name }))}" title="${escapeHtml(t('bots.menu.more', { name: item.name }))}">⋯</button></li>`;
      })
      .join('');
    // What waits for the person, above the rows; nothing at all when nothing does (spec B.2).
    needsBox.innerHTML = needsHtml(attention, { botOf, groupOf, groupFaces });
    paintFaces(page);
  }

  /**
   * The open conversation is read to its end: its unread mark goes, here at once and on the
   * server just after (spec B.3). Only while the page shows and the tab is in front.
   */
  let readTimer = /** @type {any} */ (0);
  function markRead() {
    if (!open || !shown || document.hidden) return;
    const target = open;
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const it = target.kind === 'group' ? groupOf(target.id) : botOf(target.id);
      if (it?.unread) {
        it.unread = false;
        renderList();
      }
      (target.kind === 'group' ? api.readGroup(target.id) : api.readBot(target.id)).catch(() => {});
    }, 400);
  }

  /** How one member called in the open group is doing, for the strip above the box. */
  function markCalled(bot, how) {
    const have = called.find((c) => c.bot === bot);
    if (have) have.how = how;
    else called.push({ bot, how });
  }

  /* ── the conversation ─────────────────────────────────────────── */

  /**
   * "@Name" in a bubble, in the bot's colour, with its face — found in the text nodes only, never in code.
   *
   * @param {HTMLElement} root @param {any[]} bots
   */
  function markMentions(root, bots) {
    if (!bots.length) return;
    const { SHOW_TEXT, FILTER_REJECT, FILTER_ACCEPT } = window.NodeFilter;
    const walker = document.createTreeWalker(root, SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('code, pre, a') ? FILTER_REJECT : FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue || '';
      const spans = mentionSpans(text, bots);
      if (!spans.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const span of spans) {
        frag.append(text.slice(at, span.start));
        const mark = document.createElement('span');
        mark.className = 'botmention';
        mark.style.setProperty('--ink', inkOf(span.bot));
        mark.innerHTML = `${faceHtml(span.bot, 16)}${escapeHtml(text.slice(span.start, span.end))}`;
        frag.append(mark);
        at = span.end;
      }
      frag.append(text.slice(at));
      node.replaceWith(frag);
    }
  }

  /**
   * A group's notice — made, joined, left, a new name, a new admin, stopped — a small line in
   * the middle, each bot it names by its face (owner, 2026-11-10, after DS Bot).
   */
  function noticeHtml(message) {
    const p = message.params || {};
    const SLOT = '\u0001';
    const named = (bot, fallback) => `<span class="botnotice__who">${bot ? faceHtml(bot, 18) : ''}${escapeHtml(bot?.name || fallback || t('bots.deletedBot'))}</span>`;
    const fill = (key, params, html) => escapeHtml(t(key, params)).split(SLOT).join(html);
    let html;
    if (message.notice === 'made') html = fill('bots.notice.made', { names: SLOT }, (p.members || []).map(botOf).filter(Boolean).map((b) => named(b)).join(', '));
    else if (message.notice === 'renamed') html = escapeHtml(t('bots.notice.renamed', { name: p.name || '' }));
    else if (message.notice === 'botRenamed') html = fill('bots.notice.botRenamed', { from: p.from || '', name: SLOT }, named(botOf(p.bot), p.name));
    else html = fill(`bots.notice.${message.notice}`, { name: SLOT, n: p.n ?? '' }, named(botOf(p.bot), p.name));
    // The round waits for the person here: Continue, on the newest such notice only.
    const waits = (message.notice === 'ceiling' || message.notice === 'segments') && groupState.pending && ['ceiling', 'segments'].includes(groupState.pending.reason) && message === lastWaitNotice();
    const go = waits && !run ? ` <button class="btn btn--small botnotice__go" type="button" data-act="continue">${escapeHtml(t('bots.continue'))}</button>` : '';
    return `<p class="botnotice">${html}${go}</p>`;
  }

  /** The newest ceiling or long-round notice in the open log: the one Continue belongs to. */
  const lastWaitNotice = () => [...(chat?.messages || [])].reverse().find((m) => m.notice === 'ceiling' || m.notice === 'segments') || null;

  /**
   * One line of a group's log, drawn as the home chat draws its own (owner, 2026-11-10):
   * a bot's reply is prose over the theme with no bubble, under its face and name; the
   * person's line is the home chat's bubble; each with its time and Copy. Files the bot
   * made go in `[data-files]` once the line is on the page.
   */
  function groupHtml(message, group) {
    if (message.notice) return noticeHtml(message);
    const key = escapeHtml(String(message.id || message.seq || ''));
    const time = message.createdAt ? `<span class="msg__time">${escapeHtml(timeOf(message.createdAt))}</span>` : '';
    const actions = `<div class="msg__actions">${time}${copyButton()}</div>`;
    const files = message.files?.length ? `<div class="botline__files" data-files="${key}"></div>` : '';
    if (message.role === 'user') return `<div class="msg msg--user botline" data-line="${key}"><div class="bubble">${escapeHtml(message.text || '')}</div>${files}${actions}</div>`;
    const bot = botOf(message.bot);
    const admin = adminOf(group) === message.bot;
    // A question a member asked the person (ask_person): marked as one (owner, 2026-11-10).
    return `<div class="msg msg--assistant botline botline--bot${message.ask ? ' botline--ask' : ''}" data-line="${key}" style="--ink:${inkOf(bot)}">
      <p class="botline__who">${faceHtml(bot || '', 22, 'botmsg__face')}<span class="botmsg__name">${escapeHtml(bot?.name || t('bots.deletedBot'))}</span>${admin ? `<span class="bottag">${escapeHtml(t('bots.admin'))}</span>` : ''}${message.ask ? `<span class="botline__asks">${escapeHtml(t('bots.asksYou'))}</span>` : ''}</p>
      <div class="msg__body prose" data-md>${renderMarkdown(message.text || '')}</div>
      ${files}${actions}
    </div>`;
  }

  /** The lines on the page, in order, and the time of the last: what an added line is drawn after. */
  let drawn = /** @type {string[]} */ ([]);
  let drawnAt = 0;
  const lineKey = (m) => String(m.id || m.seq || '');

  /** Lines as markup, with a time stamp where half an hour has passed. */
  function linesHtml(messages, group) {
    const html = [];
    for (const message of messages) {
      const at = new Date(message.createdAt).getTime();
      if (Number.isFinite(at) && at - drawnAt > 30 * 60_000) html.push(`<p class="botstamp">${escapeHtml(timeOf(message.createdAt))}</p>`);
      if (Number.isFinite(at)) drawnAt = at;
      html.push(groupHtml(message, group));
    }
    return html.join('');
  }

  /** What a new piece of the log needs once it is on the page: mentions, faces, file cards. */
  function finishLines(root, messages, group) {
    const bots = membersOf(group);
    for (const bubble of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-md]'))) if (!bubble.dataset.marked) {
      bubble.dataset.marked = '1';
      markMentions(bubble, bots);
    }
    for (const message of messages) {
      if (!message.files?.length) continue;
      const slot = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-files]')]).find((node) => node.dataset.files === lineKey(message));
      if (!slot || slot.childElementCount) continue;
      for (const f of message.files) slot.append(fileCard({ id: f.id, name: f.name, bytes: f.size }));
    }
    paintFaces(root);
  }

  /**
   * The open group's log. The first draw is the whole of it; after that only the lines
   * that are new are added (owner, 2026-11-10: smooth while a round streams and polls),
   * unless what is on the page no longer leads what is in `chat` (a line replaced).
   */
  function renderLog() {
    const it = subject();
    if (!it || !chat || open?.kind !== 'group') {
      log.innerHTML = '';
      drawn = [];
      return;
    }
    const keys = chat.messages.map(lineKey);
    const leads = drawn.length > 0 && drawn.length <= keys.length && drawn.every((k, i) => k === keys[i]);
    const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (leads) {
      const fresh = chat.messages.slice(drawn.length);
      if (fresh.length) {
        log.querySelector('.botempty')?.remove();
        log.insertAdjacentHTML('beforeend', linesHtml(fresh, it));
        finishLines(log, fresh, it);
        if (nearEnd) log.scrollTop = log.scrollHeight;
        markRead();
      }
      // Continue comes and goes with what waits: the notices are drawn again, nothing else.
      for (const node of log.querySelectorAll('.botnotice__go')) node.remove();
      const waiting = lastWaitNotice();
      if (waiting && groupState.pending && ['ceiling', 'segments'].includes(groupState.pending.reason) && !run) {
        const notices = log.querySelectorAll('.botnotice');
        const index = chat.messages.filter((m) => m.notice).indexOf(waiting);
        notices[index]?.insertAdjacentHTML('beforeend', ` <button class="btn btn--small botnotice__go" type="button" data-act="continue">${escapeHtml(t('bots.continue'))}</button>`);
      }
      drawn = keys;
      return;
    }
    drawnAt = 0;
    const html = linesHtml(chat.messages, it);
    log.innerHTML = chat.messages.length ? html : `<p class="botempty">${escapeHtml(t('bots.emptyGroup'))}</p>`;
    finishLines(log, chat.messages, it);
    drawn = keys;
    log.scrollTop = log.scrollHeight;
  }

  function renderHead() {
    const it = subject();
    if (!it) {
      pill.innerHTML = '';
      return;
    }
    const face = open?.kind === 'group' ? groupFaces(it) : faceHtml(it, 24);
    pill.innerHTML = `${face}<span class="botchat__name">${escapeHtml(it.name)}</span><span class="botchat__chev" aria-hidden="true">←</span>`;
    pill.setAttribute('aria-expanded', String(detailsOpen));
    pill.setAttribute('aria-label', t('bots.detailsOpen', { name: it.name }));
    home.setPlaceholder(t('bots.message', { name: it.name }));
    home.setTitle(it.name);
    paintFaces(pill);
    // A paused bot: said above the box, which keeps what is typed and does not send (spec B.5).
    const paused = open?.kind === 'bot' && !!it.paused;
    pausedBox.hidden = !paused;
    if (paused) {
      const said = t('bots.pausedBar', { name: it.name });
      if (pausedBox.dataset.said !== said) {
        pausedBox.dataset.said = said;
        pausedBox.innerHTML = `<span>${escapeHtml(said)}</span><button class="btn btn--small" type="button" data-act="resume-open">${escapeHtml(t('bots.menu.resume'))}</button>`;
      }
    }
    home.setBlocker(paused ? () => t('bots.pausedSend', { name: it.name }) : null);
    // Ask aside: a bot's kept chat, not a group's or an incognito one (spec B.6).
    asideButton.hidden = !(open?.kind === 'bot') || home.incognito();
    if (asideButton.hidden || aside.showingFor() !== (open?.kind === 'bot' ? open.id : '')) aside.close();
    renderFirst();
  }

  /** Chief alone with an empty chat: the first-run card in place of a blank box (spec B.7). */
  function renderFirst() {
    const lead = chief();
    const show = !firstSkipped && !!lead && !!team && open?.kind === 'bot' && open.id === lead.id && team.bots.length === 1 && team.groups.length === 0 && !lead.last && !home.incognito();
    firstBox.hidden = !show;
    page.classList.toggle('is-firstrun', show);
    if (!show) {
      if (firstBox.childElementCount) firstBox.innerHTML = '';
      return;
    }
    if (!firstBox.childElementCount) firstBox.innerHTML = firstRunHtml(firstPicked, firstDrafts);
  }
  /** What was typed in the card, kept before it is drawn again. */
  function keepFirstDrafts() {
    for (const li of /** @type {NodeListOf<HTMLElement>} */ (firstBox.querySelectorAll('[data-draft]'))) {
      const value = (f) => /** @type {HTMLInputElement} */ (li.querySelector(`[data-field="${f}"]`))?.value ?? '';
      firstDrafts.set(String(li.dataset.draft), { name: value('name'), role: value('role'), instructions: value('instructions') });
    }
  }

  /** Send or Stop in the borrowed box: the home chat decides, asking `groupHook.busy`. */
  function renderSend() {
    home.refreshSend();
  }

  /**
   * Who is at work in the open group: one line a bot, made once and kept while it works
   * (owner, 2026-11-10: the ring stuttered because every streamed word made the line, and
   * its ring, again). A word changes the line's text; the ring and the face stay the same
   * elements, so the ring turns evenly. Drawn at most once a frame.
   */
  const workRows = new Map();
  let workFrame = 0;
  function renderWorking() {
    if (workFrame) return;
    workFrame = requestAnimationFrame(() => {
      workFrame = 0;
      drawWorking();
    });
  }
  let calledDrawn = '';
  function drawWorking() {
    // Whom the message called (spec B.3): drawn again only when what it says changed, so its rings keep turning.
    const showCalled = open?.kind === 'group' && (groupState.running || !!run || !!follow);
    const calledNow = showCalled ? calledHtml(called, working, botOf) : '';
    if (calledNow !== calledDrawn) {
      calledDrawn = calledNow;
      calledBox.innerHTML = calledNow;
      paintFaces(calledBox);
    }
    for (const [id, row] of workRows) {
      if (working.has(id)) continue;
      row.node.remove();
      workRows.delete(id);
    }
    for (const [id, state] of working) {
      const bot = botOf(id);
      if (!bot) continue;
      let row = workRows.get(id);
      if (!row) {
        const node = document.createElement('div');
        node.className = 'botworking';
        node.style.setProperty('--ink', inkOf(bot));
        // A ring while it works, never a row of dots (owner, 2026-11-10).
        node.innerHTML = `<span class="spinner" aria-hidden="true"></span>${faceHtml(bot, 20)}<span class="botworking__who"></span><span class="botworking__text" hidden></span>`;
        workingBox.append(node);
        paintFaces(node);
        row = { node, who: /** @type {HTMLElement} */ (node.querySelector('.botworking__who')), text: /** @type {HTMLElement} */ (node.querySelector('.botworking__text')) };
        workRows.set(id, row);
      }
      // Its step in the home transcript's own words (spec B.3), not the tool's name.
      const doing = state.tool ? t('bots.using', { name: bot.name, tool: describeStep(state.tool, {}).verb }) : state.thinking && !state.text ? t('bots.thinkingLive') : t('bots.working', { name: bot.name });
      if (row.who.textContent !== doing) row.who.textContent = doing;
      const tail = state.text ? state.text.slice(-160) : '';
      if (row.text.textContent !== tail) row.text.textContent = tail;
      row.text.hidden = !tail;
    }
  }

  /* ── details on the right ─────────────────────────────────────── */

  async function usageLine(botIds) {
    const to = new Date(Date.now() + 60_000);
    const from = new Date(Date.now() - 30 * 86_400_000);
    const { rows } = await api.botUsage({ from: from.toISOString(), to: to.toISOString(), unit: 'month' });
    return botIds.map((id) => {
      const mine = rows.filter((r) => r.bot === id);
      const input = mine.reduce((s, r) => s + r.input, 0);
      const output = mine.reduce((s, r) => s + r.output, 0);
      const cache = mine.reduce((s, r) => s + r.cacheRead, 0);
      return { id, tokens: input + output, rate: input ? Math.round((cache / input) * 100) : 0 };
    });
  }

  /** What the panel last read, for the subject it was read for: drawn again at once, never a spinner where numbers were. */
  let detailsData = /** @type {{ key: string, entries: any[], forgotten?: any[], usage: any[], tasks: any[] } | null} */ (null);
  let detailsTimer = /** @type {any} */ (null);
  let detailsKey = '';

  /**
   * Open or close the panel (owner, 2026-11-10: smooth, no lag). It slides and fades in
   * its own column while the conversation eases narrower; closed, it leaves the page
   * once it has slid away. With reduced motion it is there or not, at once.
   */
  function showDetails(on) {
    clearTimeout(detailsTimer);
    if (on) {
      if (!details.hidden && page.classList.contains('has-details')) return;
      details.hidden = false;
      details.inert = false;
      // The closed state drawn first, so that opening is a change the browser can move through.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (detailsOpen) page.classList.add('has-details');
      }));
      return;
    }
    page.classList.remove('has-details');
    details.inert = true;
    const settle = () => {
      if (!detailsOpen) details.hidden = true;
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) settle();
    else detailsTimer = setTimeout(settle, 260);
  }

  async function renderDetails() {
    if (!detailsOpen) {
      showDetails(false);
      return;
    }
    const it = subject();
    if (!it) return;
    showDetails(true);
    const isGroup = open?.kind === 'group';
    const kind = isGroup ? 'bot-groups' : 'bots';
    const key = `${open?.kind}:${it.id}`;
    const turn = ++detailsTurn;
    // The heading only when the subject changed: the panel keeps its place and its focus otherwise.
    if (detailsKey !== key || !details.querySelector('[data-body]')) {
      detailsKey = key;
      details.innerHTML = `<header class="botdetails__head"><button class="icon-btn" type="button" data-act="close-details" aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button></header>
      <div class="botdetails__who">
        ${isGroup ? groupFaces(it) : faceHtml(it, 88, 'botdetails__face')}
        <h2 class="botdetails__name">${escapeHtml(it.name)}</h2>
        ${!isGroup && it.role ? `<p class="botdetails__role">${escapeHtml(it.role)}</p>` : ''}
      </div>
      <div data-body><p class="botloading" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">${escapeHtml(t('bots.loading'))}</span></p></div>`;
      paintFaces(details);
    }
    if (detailsData?.key === key) drawDetailsBody(it, detailsData);
    const [memory, usage, tasks] = await Promise.all([
      api.botMemory(kind, it.id).catch(() => ({ entries: detailsData?.key === key ? detailsData.entries : [] })),
      usageLine(isGroup ? it.members : [it.id]).catch(() => (detailsData?.key === key ? detailsData.usage : [])),
      (isGroup ? api.groupTasks(it.id) : api.botTasks(it.id)).catch(() => ({ tasks: detailsData?.key === key ? detailsData.tasks : [] })),
    ]);
    if (turn !== detailsTurn) return;
    detailsData = { key, entries: memory.entries || [], forgotten: memory.forgotten || (detailsData?.key === key ? detailsData.forgotten : []) || [], usage, tasks: tasks.tasks || [] };
    drawDetailsBody(it, detailsData);
  }

  /** The panel's body, from what was read; drawn only when it would look different. */
  let drawnBody = '';
  function drawDetailsBody(it, data) {
    const body = /** @type {HTMLElement | null} */ (details.querySelector('[data-body]'));
    if (!body) return;
    const isGroup = open?.kind === 'group';
    const { entries, usage, tasks } = data;
    const parts = [];
    if (isGroup) {
      const admin = adminOf(it);
      parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.members'))}</h3>
        ${run?.kind === 'group' && run.id === it.id ? `<button class="btn btn--small botsec__stop" type="button" data-act="stop">${escapeHtml(t('bots.stopAll'))}</button>` : ''}
        <ul class="botmembers">${membersOf(it).map((b) => `<li style="--ink:${inkOf(b)}">${faceHtml(b, 22)}<span>${escapeHtml(b.name)}</span>${b.id === admin ? `<span class="bottag">${escapeHtml(t('bots.admin'))}</span>` : ''}</li>`).join('')}</ul>
        <button class="botlink" type="button" data-act="edit-group">${escapeHtml(t('bots.groupSettings'))} ›</button></section>`);
      // The group's standing note, folded to a few lines (owner, 2026-11-10).
      if (String(it.notice || '').trim()) parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.g.notice'))}</h3><p class="botnoticebox">${escapeHtml(it.notice)}</p></section>`);
    } else {
      // No model of its own: every bot answers on the model in the top bar (owner, 2026-11-10).
      parts.push(`<button class="botlink botlink--center" type="button" data-act="edit-bot">${escapeHtml(t(it.instructions ? 'bots.instructionsEdit' : 'bots.instructionsAdd'))}</button>`);
    }
    // Memory opens and closes where it is (owner, 2026-11-10): the list is always drawn, folded.
    parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.memory'))}</h3>
      <button class="botcard" type="button" data-act="memory" aria-expanded="${memoryOpen}" aria-controls="botmemory-fold"><span data-memory-count>${escapeHtml(counted(entries.length, 'bots.entries'))}</span><span class="botcard__more">${escapeHtml(t('bots.manage'))}<span class="botcard__chev" aria-hidden="true">›</span></span></button>
      <div class="botmemory-fold${memoryOpen ? ' is-open' : ''}" id="botmemory-fold" data-memory-fold${memoryOpen ? '' : ' inert'}><div class="botmemory-fold__in" data-memory-body>${memoryHtml(entries)}</div></div></section>`);
    const usageRows = usage
      .map((u) => {
        const b = botOf(u.id);
        return `<li><span>${escapeHtml(b?.name || '')}</span><span>${escapeHtml(t('bots.usageLine', { tokens: compactCount(u.tokens), rate: `${u.rate}%` }))}</span></li>`;
      })
      .join('');
    parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.usage'))}</h3>${usage.some((u) => u.tokens) ? `<ul class="botusage">${usageRows}</ul>` : `<p class="hint">${escapeHtml(t('bots.usageNone'))}</p>`}</section>`);
    // A bot's own scheduled tasks, and a group's (spec B.4), here and only here (owner, 2026-11-10).
    parts.push(tasksHtml(tasks || []));
    // Reset, at the foot: asked once more before anything goes (owner, 2026-11-10).
    parts.push(`<section class="botsec botsec--reset"><button class="botlink botlink--danger" type="button" data-act="reset">${escapeHtml(t('bots.reset'))}</button></section>`);
    const html = parts.join('');
    if (html === drawnBody && body.childElementCount) return;
    drawnBody = html;
    // What is being typed in the memory box survives a redraw.
    const typing = /** @type {HTMLInputElement | null} */ (body.querySelector('[data-memory-text]'));
    const draft = typing?.value || '';
    const hadFocus = !!typing && document.activeElement === typing;
    body.innerHTML = html;
    if (draft) {
      const box = /** @type {HTMLInputElement | null} */ (body.querySelector('[data-memory-text]'));
      if (box) {
        box.value = draft;
        if (hadFocus) box.focus();
      }
    }
    paintFaces(body);
  }

  /** Open or close the memory list where it is: no redraw, no request, the arrow turning with it. */
  function toggleMemory() {
    memoryOpen = !memoryOpen;
    const button = details.querySelector('[data-act="memory"]');
    const fold = /** @type {HTMLElement | null} */ (details.querySelector('[data-memory-fold]'));
    button?.setAttribute('aria-expanded', String(memoryOpen));
    if (fold) {
      fold.classList.toggle('is-open', memoryOpen);
      fold.inert = !memoryOpen;
    }
  }

  /** The memory list and its count, drawn again from what is held, after an entry came or went. */
  function paintMemory() {
    const entries = detailsData?.entries || [];
    const count = details.querySelector('[data-memory-count]');
    if (count) count.textContent = counted(entries.length, 'bots.entries');
    const list = /** @type {HTMLElement | null} */ (details.querySelector('[data-memory-body]'));
    if (!list) return;
    const box = /** @type {HTMLInputElement | null} */ (list.querySelector('[data-memory-text]'));
    const draft = box?.value || '';
    list.innerHTML = memoryHtml(entries);
    const again = /** @type {HTMLInputElement | null} */ (list.querySelector('[data-memory-text]'));
    if (again && draft) again.value = draft;
    drawnBody = '';
  }

  /* ── reset ──────────────────────────────────────────────────────── */

  const confirmBox = document.createElement('dialog');
  confirmBox.className = 'botconfirm';
  page.append(confirmBox);

  /** Reset the open conversation, once the person says yes in a dialog that says what goes and what stays. */
  function askReset() {
    const it = subject();
    if (!it || !open) return;
    const target = { kind: open.kind, id: it.id };
    const isGroup = target.kind === 'group';
    confirmBox.innerHTML = `<form method="dialog" class="botconfirm__form">
      <h2 class="botconfirm__title">${escapeHtml(t('bots.resetTitle', { name: it.name }))}</h2>
      <p class="botconfirm__text">${escapeHtml(t(isGroup ? 'bots.resetBodyGroup' : 'bots.resetBody', { name: it.name }))}</p>
      <div class="botconfirm__acts">
        <button class="btn" type="submit" value="cancel" autofocus>${escapeHtml(t('action.cancel'))}</button>
        <button class="btn btn--danger" type="submit" value="reset">${escapeHtml(t('bots.resetConfirm'))}</button>
      </div>
    </form>`;
    confirmBox.returnValue = '';
    confirmBox.addEventListener(
      'close',
      () => {
        if (confirmBox.returnValue === 'reset') void doReset(target);
      },
      { once: true },
    );
    confirmBox.showModal();
  }

  async function doReset(target) {
    try {
      if (target.kind === 'group') await api.resetGroup(target.id);
      else await api.resetBot(target.id);
      if (target.kind === 'bot') chatIds.delete(target.id);
      toast(t('bots.resetDone'), 'ok');
      if (open && open.kind === target.kind && open.id === target.id) {
        chat = null;
        drawn = [];
        await loadChat();
      }
      await readTeamNow();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  let taskFormOpen = false;
  /** @param {any[]} tasks */
  function tasksHtml(tasks) {
    const isBot = open?.kind === 'bot';
    const when = (task) => (task.enabled === false ? t('bots.taskPaused') : task.trigger === 'hook' ? t('bots.hook.label') : task.next_run_at ? t('bots.taskNext', { when: new Date(task.next_run_at).toLocaleString(localeTag(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) }) : '');
    const rows = tasks
      .map((task) => {
        const hook = task.trigger === 'hook';
        return `<li class="bottask"><span class="bottask__text"><span class="bottask__name">${escapeHtml(task.title)}</span><span class="bottask__when">${escapeHtml(when(task))}</span></span>
        ${hook ? `<button class="btn btn--small" type="button" data-hook-open="${escapeHtml(task.id)}" aria-expanded="${hookOpen === task.id}">${escapeHtml(t('bots.hook.manage'))}</button>` : ''}
        <button class="btn btn--small" type="button" data-task-toggle="${escapeHtml(task.id)}" data-enabled="${task.enabled === false ? '0' : '1'}">${escapeHtml(t(task.enabled === false ? 'bots.taskResume' : 'bots.taskPause'))}</button>
        <button class="btn btn--small" type="button" data-task-delete="${escapeHtml(task.id)}">${escapeHtml(t('bots.taskDelete'))}</button></li>
        ${hook && hookOpen === task.id ? `<li class="bothook">${hookPanelHtml(task)}</li>` : ''}`;
      })
      .join('');
    const once = hookShown && tasks.some((x) => x.id === hookShown.taskId) ? hookOnceHtml(hookShown) : '';
    return `<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.scheduled'))}</h3>
      ${once}
      ${tasks.length ? `<ul class="bottasks">${rows}</ul>` : `<p class="hint">${escapeHtml(t('bots.tasksNone'))}</p>`}
      ${taskFormOpen
        ? `<form class="bottask__form" data-task-add>
            <input type="text" maxlength="120" required data-task-title aria-label="${escapeHtml(t('bots.taskName'))}" placeholder="${escapeHtml(t('bots.taskName'))}" />
            <textarea rows="2" maxlength="8000" required data-task-prompt aria-label="${escapeHtml(t('bots.taskPrompt'))}" placeholder="${escapeHtml(t('bots.taskPrompt'))}"></textarea>
            ${isBot ? `<label class="bottask__trigger"><span>${escapeHtml(t('bots.hook.trigger'))}</span><select data-task-trigger><option value="schedule">${escapeHtml(t('bots.hook.onSchedule'))}</option><option value="hook">${escapeHtml(t('bots.hook.onRequest'))}</option></select></label>` : ''}
            <input type="text" maxlength="60" required data-task-when aria-label="${escapeHtml(t('bots.taskWhen'))}" placeholder="${escapeHtml(t('bots.taskWhen'))}" />
            <button class="btn btn--primary btn--small" type="submit">${escapeHtml(t('bots.taskSave'))}</button>
          </form>`
        : `<button class="botlink" type="button" data-act="task-add">${escapeHtml(t('bots.taskAdd'))} ›</button>`}</section>`;
  }

  /** A hook's address and secret, once: the secret is never shown again (spec C.1). */
  function hookOnceHtml({ url, secret }) {
    const field = (label, value) => `<div class="bothook__field"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code><button class="btn btn--small" type="button" data-copy-value="${escapeHtml(value)}">${escapeHtml(t('bots.hook.copy'))}</button></div>`;
    return `<div class="bothook__once" role="status">
      <p><strong>${escapeHtml(t('bots.hook.onceTitle'))}</strong> ${escapeHtml(t('bots.hook.onceHint'))}</p>
      ${field(t('bots.hook.url'), url)}${field(t('bots.hook.secret'), secret)}
      <p class="hint">${escapeHtml(t('bots.hook.howToSign'))}</p>
      <button class="btn btn--small" type="button" data-hook-dismiss>${escapeHtml(t('bots.hook.done'))}</button></div>`;
  }

  /** A hook's last deliveries and why one was ignored, its filters, Test and Rotate. */
  function hookPanelHtml(task) {
    if (!hookData || hookData.taskId !== task.id) return `<p class="hint" role="status">…</p>`;
    const when = (at) => new Date(at).toLocaleString(localeTag(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const receipts = hookData.receipts.length
      ? `<ul class="bothook__receipts">${hookData.receipts.map((r) => `<li><span class="bothook__status bothook__status--${escapeHtml(r.status)}">${escapeHtml(t(`bots.hook.status.${r.status}`) === `bots.hook.status.${r.status}` ? r.status : t(`bots.hook.status.${r.status}`))}</span><span>${escapeHtml(when(r.at))}</span>${r.reason ? `<span class="hint">${escapeHtml(r.reason)}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="hint">${escapeHtml(t('bots.hook.none'))}</p>`;
    const match = [...(hookData.filters?.match || []), ...Array(5).fill(null)].slice(0, 5);
    const rows = match
      .map((m, i) => `<div class="bothook__match"><input type="text" maxlength="200" data-filter-pointer="${i}" value="${escapeHtml(m?.pointer || '')}" placeholder="/repository/name" aria-label="${escapeHtml(t('bots.hook.pointer', { n: i + 1 }))}" /><input type="text" maxlength="500" data-filter-value="${i}" value="${escapeHtml(m ? JSON.stringify(m.value) : '')}" placeholder='"site"' aria-label="${escapeHtml(t('bots.hook.value', { n: i + 1 }))}" /></div>`)
      .join('');
    return `<div class="bothook__panel">
      <p class="bothook__url"><code>${escapeHtml(hookData.url)}</code> <button class="btn btn--small" type="button" data-copy-value="${escapeHtml(hookData.url)}">${escapeHtml(t('bots.hook.copy'))}</button></p>
      <h4>${escapeHtml(t('bots.hook.deliveries'))}</h4>${receipts}
      <form class="bothook__filters" data-hook-filters="${escapeHtml(task.id)}">
        <h4>${escapeHtml(t('bots.hook.filters'))}</h4>
        <label class="field"><span>${escapeHtml(t('bots.hook.type'))}</span><input type="text" maxlength="100" data-filter-type value="${escapeHtml(hookData.filters?.type || '')}" placeholder="build.done" /></label>
        <p class="hint">${escapeHtml(t('bots.hook.matchHint'))}</p>${rows}
        <button class="btn btn--small" type="submit">${escapeHtml(t('bots.hook.saveFilters'))}</button>
      </form>
      <div class="bothook__acts"><button class="btn btn--small" type="button" data-hook-test="${escapeHtml(task.id)}">${escapeHtml(t('bots.hook.test'))}</button>
        <button class="btn btn--small btn--danger" type="button" data-hook-rotate="${escapeHtml(task.id)}">${escapeHtml(t('bots.hook.rotate'))}</button></div>
    </div>`;
  }

  /** Read the open hook again, and draw the panel with it. */
  async function readHook(taskId) {
    try {
      hookData = { taskId, ...(await api.botTaskHook(taskId)) };
    } catch (err) {
      hookData = null;
      hookOpen = '';
      toast(err.message, 'error');
    }
    await renderDetails();
  }

  /** The open bot's waits as chips above its box (spec C.2): what it parked, each with ✕. */
  async function loadWaits() {
    const target = open;
    if (!target || target.kind !== 'bot' || home.incognito()) {
      waits = [];
      return drawWaits();
    }
    try {
      const answer = await api.botWaits(target.id);
      if (open !== target) return;
      waits = answer.waits || [];
    } catch {
      waits = [];
    }
    drawWaits();
  }
  function drawWaits() {
    waitsBox.hidden = !waits.length || open?.kind !== 'bot';
    waitsBox.setAttribute('aria-label', t('bots.waits.label'));
    waitsBox.innerHTML = waits
      .map((w) => `<li class="botwait" title="${escapeHtml(w.request)}"><span aria-hidden="true">⏳</span><span class="botwait__text">${escapeHtml(w.note)}</span><button class="botwait__x" type="button" data-wait-close="${escapeHtml(w.id)}" aria-label="${escapeHtml(t('bots.waits.close', { note: w.note.slice(0, 60) }))}">✕</button></li>`)
      .join('');
  }

  /** An entry being edited where it is, and one just forgotten (its Undo, for a few seconds). */
  let editingEntry = '';
  let forgotten = /** @type {{ id: string, text: string, timer: any } | null} */ (null);

  /**
   * Who saved an entry and where (owner, 2026-11-12): the memory review's own line,
   * and the chat it was saved in with what that chat had last read from outside — a
   * host or a kind of tool, never what it said.
   */
  function savedHtml(e) {
    const parts = [];
    if (e.source === 'review') parts.push(t('bots.memoryByReview'));
    if (e.saved?.chatId) {
      parts.push(e.saved.chatTitle ? t('bots.memorySavedIn', { chat: e.saved.chatTitle }) : t('bots.memorySavedInGone'));
      if (e.saved.outside) parts.push(t('bots.memoryAfterReading', { source: e.saved.outside }));
    }
    return parts.length ? `<span class="botmemory__meta">${escapeHtml(parts.join(' · '))}</span>` : '';
  }

  /** The versions a bot or its review replaced, each with a way back. */
  function earlierHtml(e) {
    if (!e.history?.length) return '';
    const what = escapeHtml(e.text.slice(0, 40));
    const day = (iso) => (iso ? new Date(iso).toLocaleDateString(localeTag()) : '');
    const rows = e.history
      .map((v) => `<li><span class="botmemory__text">${escapeHtml(v.text)}</span><span class="botmemory__meta">${escapeHtml([day(v.validFrom), day(v.invalidAt)].filter(Boolean).join(' – '))}</span><button class="botmemory__forget" type="button" data-restore="${escapeHtml(v.id)}" aria-label="${escapeHtml(t('bots.memoryRestore'))}: ${escapeHtml(v.text.slice(0, 40))}">${escapeHtml(t('bots.memoryRestore'))}</button></li>`)
      .join('');
    return `<details class="botmemory__earlier"><summary aria-label="${escapeHtml(t('bots.memoryEarlier', { count: e.history.length }))}: ${what}">${escapeHtml(t('bots.memoryEarlier', { count: e.history.length }))}</summary><ul>${rows}</ul></details>`;
  }

  /** One entry: its words (or the box to change them), Pin, Edit and Forget (owner, 2026-11-10). */
  function entryHtml(e) {
    const id = escapeHtml(e.id);
    const what = escapeHtml(e.text.slice(0, 40));
    if (editingEntry === e.id) {
      return `<li class="is-editing"><form class="botmemory__edit" data-memory-edit="${id}"><input type="text" maxlength="300" data-edit-text value="${escapeHtml(e.text)}" aria-label="${escapeHtml(t('bots.memoryEdit'))}: ${what}" /><button class="btn btn--small btn--primary" type="submit">${escapeHtml(t('bots.memorySave'))}</button><button class="btn btn--small" type="button" data-edit-cancel>${escapeHtml(t('action.cancel'))}</button></form></li>`;
    }
    // A review's change can be taken back where it is: its earlier version, or the entry it added.
    const undoReview = e.source === 'review' ? `<button class="botmemory__forget" type="button" data-undo-review="${id}" aria-label="${escapeHtml(t('bots.memoryUndoReview'))}: ${what}">${escapeHtml(t('bots.memoryUndoReview'))}</button>` : '';
    return `<li class="${e.pinned ? 'is-pinned' : ''}"><span class="botmemory__main"><span class="botmemory__text">${e.pinned ? `<span class="botmemory__pin" aria-label="${escapeHtml(t('bots.memoryPinned'))}">📌</span>` : ''}${escapeHtml(e.text)}</span>${savedHtml(e)}${earlierHtml(e)}</span>
      <span class="botmemory__acts">
        ${undoReview}
        <button class="botmemory__forget" type="button" data-pin="${id}" aria-pressed="${!!e.pinned}" aria-label="${escapeHtml(t(e.pinned ? 'bots.memoryUnpin' : 'bots.memoryPin'))}: ${what}">${escapeHtml(t(e.pinned ? 'bots.memoryUnpin' : 'bots.memoryPin'))}</button>
        <button class="botmemory__forget" type="button" data-edit="${id}" aria-label="${escapeHtml(t('bots.memoryEdit'))}: ${what}">${escapeHtml(t('bots.memoryEdit'))}</button>
        <button class="botmemory__forget" type="button" data-forget="${id}" aria-label="${escapeHtml(t('bots.forget'))}: ${what}">${escapeHtml(t('bots.forget'))}</button>
      </span></li>`;
  }

  /** What the bot or its review forgot: kept for a while, to bring back or leave to go (schema 50). */
  function forgottenHtml(list) {
    if (!list?.length) return '';
    const rows = list
      .map((f) => `<li><span class="botmemory__main"><span class="botmemory__text">${escapeHtml(f.text)}</span>${savedHtml(f)}</span><span class="botmemory__acts"><button class="botmemory__forget" type="button" data-restore="${escapeHtml(f.id)}" aria-label="${escapeHtml(t('bots.memoryRestore'))}: ${escapeHtml(f.text.slice(0, 40))}">${escapeHtml(t('bots.memoryRestore'))}</button><button class="botmemory__forget" type="button" data-forget="${escapeHtml(f.id)}" aria-label="${escapeHtml(t('action.delete'))}: ${escapeHtml(f.text.slice(0, 40))}">${escapeHtml(t('action.delete'))}</button></span></li>`)
      .join('');
    return `<details class="botmemory__forgotten"><summary>${escapeHtml(t('bots.memoryForgottenList', { count: list.length }))}</summary><ul class="botmemory__list">${rows}</ul></details>`;
  }

  function memoryHtml(entries) {
    const undo = forgotten ? `<li class="botmemory__gone"><span>${escapeHtml(t('bots.memoryForgot'))}</span><button class="botmemory__forget" type="button" data-undo-forget="${escapeHtml(forgotten.id)}">${escapeHtml(t('bots.memoryUndo'))}</button></li>` : '';
    // Pinned first, as the bot reads them.
    const ordered = [...entries.filter((e) => e.pinned), ...entries.filter((e) => !e.pinned)];
    return `<div class="botmemory">
      ${entries.length || undo ? `<ul class="botmemory__list">${undo}${ordered.map(entryHtml).join('')}</ul>` : `<p class="hint">${escapeHtml(t('bots.memoryEmpty'))}</p>`}
      ${forgottenHtml(detailsData?.forgotten)}
      <form class="botmemory__add" data-memory-add>
        <input type="text" maxlength="300" data-memory-text aria-label="${escapeHtml(t('bots.memoryAdd'))}" placeholder="${escapeHtml(t('bots.memoryPlaceholder'))}" />
        <button class="btn btn--small" type="submit">${escapeHtml(t('bots.memoryAdd'))}</button>
      </form></div>`;
  }

  /* ── loading and opening ─────────────────────────────────────── */

  /** @param {{ announce?: boolean }} [options]  `announce`: say what was made or deleted since the last read */
  async function loadTeam({ announce = false } = {}) {
    const before = team;
    const [next, seen] = await Promise.all([api.bots(), api.botAttention().catch(() => null)]);
    team = next;
    if (seen) attention = seen.items || [];
    if (announce && before) announceChanges(before, team);
    renderList();
    fillStepFaces();
    // Something new where the person is looking is read.
    if (shown && subject()?.unread) markRead();
    return team;
  }

  /**
   * The team read again because a step changed it — Chief's create_bot, an update_group in
   * a round — while the turn goes on (owner, 2026-11-10: each one shows as it is made, not
   * all at the end). Reads come one at a time, so two bots made at once are each said once;
   * a step that lands while one is on its way asks for one more after it.
   */
  let teamReading = /** @type {Promise<void> | null} */ (null);
  let readAgain = false;
  function readTeamNow() {
    if (teamReading) {
      readAgain = true;
      return teamReading;
    }
    teamReading = loadTeam({ announce: true })
      .then(() => renderHead(), () => {})
      .finally(() => {
        teamReading = null;
        if (readAgain) {
          readAgain = false;
          readTeamNow();
        }
      });
    return teamReading;
  }

  /** Each team step in the home transcript wears the face of whom it made or changed (render.js `stepface`). */
  function fillStepFaces() {
    if (!team) return;
    for (const slot of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.stepface:not([data-filled])'))) {
      const name = String(slot.dataset.faceName || '').toLowerCase();
      const group = slot.dataset.faceKind === 'group';
      const it = (group ? team.groups : team.bots).find((x) => x.name.toLowerCase() === name);
      if (!it) continue;
      slot.dataset.filled = '1';
      slot.innerHTML = group ? groupFaces(it) : faceHtml(it, 18);
      paintFaces(slot);
    }
  }

  /**
   * What a turn made or deleted — Chief's create_bot, a group made in a chat — said in a
   * line each, as Bot settings says its own (owner, 2026-11-10).
   */
  function announceChanges(before, after) {
    for (const kind of /** @type {('bot' | 'group')[]} */ (['bot', 'group'])) {
      const key = kind === 'group' ? 'groups' : 'bots';
      const had = new Set(before[key].map((x) => x.id));
      const has = new Set(after[key].map((x) => x.id));
      for (const x of after[key]) if (!had.has(x.id)) toast(changeLine({ kind, item: x }, true, x.name), 'ok');
      for (const x of before[key]) if (!has.has(x.id)) toast(changeLine({ kind, removed: x.id }, false, x.name), 'ok');
    }
  }

  async function loadChat() {
    if (!open) return;
    const asked = open;
    if (open.kind === 'group') {
      const data = await api.groupChat(open.id);
      if (open !== asked) return;
      chat = { chatId: data.chatId, messages: data.messages || [] };
      groupState = { running: !!data.running, pending: data.pending || null };
      called = data.called || [];
      drawn = [];
      renderLog();
      renderWorking();
      // A round this tab did not start is running: follow it.
      if (groupState.running && !run) followLive();
      renderSend();
      return;
    }
    // A bot's own chat (or, with incognito on, one that is not kept), in the home chat. Its id
    // is asked for once; the home chat reads the messages, so they are not sent here as well.
    const incognito = home.incognito();
    const known = incognito ? null : chatIds.get(asked.id);
    const data = known ? { chatId: known, incognito: false } : await api.botChat(asked.id, { incognito, light: true });
    if (open !== asked) return;
    if (!incognito) chatIds.set(asked.id, data.chatId);
    chat = { chatId: data.chatId, messages: [] };
    const landed = await home.open(data.chatId, { incognito: !!data.incognito });
    fillStepFaces();
    // A remembered id that no longer opens is asked for again, once.
    if (!landed && known && open === asked) {
      chatIds.delete(asked.id);
      await loadChat();
    }
  }

  /** What the borrowed box does while a group chat is open. */
  const groupHook = {
    send: (text) => sendGroup(text),
    stop: () => void stopRun(),
    busy: () => (!!run && run.kind === 'group') || !!follow,
  };

  /** @param {'bot' | 'group'} kind @param {string} id @param {{ focus?: boolean, chatting?: boolean }} [options] */
  async function openSubject(kind, id, { focus = true, chatting = true } = {}) {
    if (!team) await loadTeam();
    const it = kind === 'group' ? groupOf(id) : botOf(id);
    const target = it ? { kind, id } : chief() ? { kind: 'bot', id: chief().id } : null;
    if (!target) return;
    const changed = !open || open.kind !== target.kind || open.id !== target.id;
    open = /** @type {any} */ (target);
    if (changed) {
      chat = null;
      memoryOpen = false;
      called = [];
      stopFollowing();
      groupState = { running: false, pending: null };
      working.clear();
      renderWorking();
      log.innerHTML = '';
      drawn = [];
    }
    // On a phone the list and the conversation take turns; the page opened from the rail starts on the list,
    // with nothing laid over it.
    page.classList.toggle('is-chatting', chatting);
    if (!chatting) detailsOpen = false;
    setHash(open);
    // A bot's chat is the home chat's own transcript and box; a group borrows the box alone.
    const isGroup = open.kind === 'group';
    page.classList.toggle('is-group', isGroup);
    log.hidden = !isGroup;
    workingBox.hidden = !isGroup;
    if (isGroup) {
      if (changed) home.blank();
      home.lend(homeSlot, ['dock']);
      home.setHook(groupHook);
    } else {
      home.setHook(null);
      home.lend(homeSlot, ['thread', 'dock']);
    }
    syncMentions();
    renderList();
    renderHead();
    renderSend();
    await loadChat();
    renderHead();
    // Always: closed, it hides itself; open, it reads the newly opened one.
    renderDetails();
    markRead();
    void loadWaits();
    if (focus && matchMedia('(min-width: 760px)').matches && firstBox.hidden) input.focus();
  }

  /* ── sending and stopping ─────────────────────────────────────── */

  /** Write in the open group and follow its round. What was written shows at once. */
  async function sendGroup(text) {
    if (!open || open.kind !== 'group') return;
    closePicker();
    syncMentions();
    const target = open;
    // A new message calls anew: the strip starts again (spec B.3).
    called = [];
    const mine = { id: `mine-${crypto.randomUUID()}`, role: 'user', text, createdAt: new Date().toISOString() };
    if (chat) {
      chat.messages.push(mine);
      renderLog();
    }
    // The group is working already (here or elsewhere): the line joins that round.
    if (run || follow) {
      try {
        const answer = await runGroup({ groupId: target.id, text, runId: crypto.randomUUID(), model: home.model(), signal: new AbortController().signal, onEvent: () => {} });
        if (chat && answer.message) replaceLine(mine, answer.message);
      } catch (err) {
        toast(err.message || t('bots.failed'), 'error');
      }
      return;
    }
    await streamRun(target, (signal, onEvent) => runGroup({ groupId: target.id, text, runId: crypto.randomUUID(), model: home.model(), signal, onEvent }), mine);
  }

  /** The person's own line on screen, replaced by the stored one. */
  function replaceLine(mine, saved) {
    if (!chat) return;
    const at = chat.messages.indexOf(mine);
    if (at >= 0) chat.messages[at] = saved;
    else if (!chat.messages.some((m) => m.id === saved.id)) chat.messages.push(saved);
    renderLog();
  }

  /** Continue: carry on what the open group has waiting, and follow it. */
  async function continueRun() {
    if (!open || open.kind !== 'group' || run) return;
    const target = open;
    groupState = { ...groupState, pending: null };
    renderLog();
    await streamRun(target, (signal, onEvent) => continueGroup({ groupId: target.id, model: home.model(), signal, onEvent }), null);
  }

  /**
   * Follow a segment this tab started, from its stream. A round that goes on past it in
   * another invocation (`paused`), or a line that joined a round running elsewhere, is
   * followed from then on with `followLive`.
   */
  async function streamRun(target, start, mine) {
    const controller = new AbortController();
    run = { controller, kind: 'group', id: target.id, chatId: chat?.chatId };
    stopFollowing();
    renderSend();
    const here = () => open && open.kind === target.kind && open.id === target.id;
    /** Members whose turn used a team tool: the team is read when each is done. */
    const touched = new Set();
    let goesOn = false;
    try {
      const answer = await start(controller.signal, (event, data) => {
          if (!here()) return;
          if (event === 'paused') goesOn = true;
          else if (event === 'done') goesOn = goesOn || (!!data?.pending && data?.stopReason === 'time');
          if (event === 'post' && chat) {
            // The person's own line is on screen already: the stored one takes its place.
            if (data.message.role === 'user' && mine && chat.messages.includes(mine)) chat.messages[chat.messages.indexOf(mine)] = data.message;
            else if (!chat.messages.some((m) => m.id === data.message.id)) chat.messages.push(data.message);
            if (data.message.bot) working.delete(data.message.bot);
            const said = data.message;
            if (said.bot && !said.notice) markCalled(said.bot, 'answered');
            else if (said.params?.bot && ['failed', 'paused', 'approval'].includes(said.notice)) markCalled(said.params.bot, said.notice === 'approval' ? 'waiting' : said.notice);
            renderLog();
            renderWorking();
          } else if (event === 'member_start') {
            working.set(data.bot, { text: '', tool: '', thinking: true });
            markCalled(data.bot, 'working');
            renderWorking();
          } else if (event === 'member_thinking') {
            const w = working.get(data.bot);
            if (w) w.thinking = true;
            renderWorking();
          } else if (event === 'member_text') {
            const w = working.get(data.bot);
            if (w) {
              w.text += data.delta;
              w.thinking = false;
            }
            renderWorking();
          } else if (event === 'member_tool') {
            const w = working.get(data.bot);
            if (w) w.tool = data.name;
            if (TEAM_EVENTS.has(data.name)) touched.add(data.bot);
            renderWorking();
          } else if (event === 'member_end') {
            working.delete(data.bot);
            // Passed, unless its answer is posted next (the post says answered).
            if (called.find((c) => c.bot === data.bot)?.how === 'working') markCalled(data.bot, 'passed');
            renderWorking();
            // What it made or changed shows now, and the group's own notices with it.
            if (touched.delete(data.bot)) readTeamNow().then(() => (here() ? loadChat() : undefined)).catch(() => {});
          } else if (event === 'error') toast(data.message || t('bots.failed'), 'error');
      });
      // Another segment held the group: this line joined its round.
      if (answer?.joined) {
        if (mine && answer.message) replaceLine(mine, answer.message);
        goesOn = true;
      }
    } catch (err) {
      if (!controller.signal.aborted) toast(err.message || t('bots.failed'), 'error');
    } finally {
      run = null;
      working.clear();
      renderWorking();
      renderSend();
      await readTeamNow();
      if (here()) await loadChat().catch(() => {});
      if (goesOn && here() && !controller.signal.aborted) followLive();
      if (detailsOpen && here()) renderDetails();
      if (here()) markRead();
    }
  }

  /**
   * Follow the open group's round from the server, every 1.5 s while the page shows and the
   * round runs: new lines added, who is at work in the working lines (owner, 2026-11-10:
   * leave the page, come back, and it is still going — and still visible). Nothing is asked
   * while the tab is hidden; on its return the next look comes at once.
   */
  function followLive() {
    stopFollowing();
    if (!open || open.kind !== 'group' || run) return;
    const target = open;
    follow = { timer: null, target };
    renderSend();
    const again = (ms) => {
      if (follow?.target === target) follow.timer = setTimeout(look, ms);
    };
    const look = async () => {
      if (!follow || follow.target !== target) return;
      if (!shown || open !== target || run) return stopFollowing();
      if (document.hidden) return again(1500);
      const since = Math.max(-1, ...(chat?.messages || []).map((m) => Number(m.seq)).filter(Number.isFinite));
      try {
        const data = await api.groupLive(target.id, since);
        if (!follow || follow.target !== target || open !== target) return;
        groupState = { running: !!data.running, pending: data.pending || null };
        if (Array.isArray(data.called) && data.called.length) called = data.called;
        if (chat) for (const m of data.messages || []) if (!chat.messages.some((x) => x.id === m.id)) chat.messages.push(m);
        working.clear();
        for (const w of data.working || []) working.set(w.bot, { text: '', tool: w.tool || '', thinking: !w.tool });
        renderLog();
        renderWorking();
        if (data.running) return again(1500);
        stopFollowing();
        await readTeamNow();
        renderLog();
      } catch {
        again(4000);
      }
    };
    again(0);
  }
  function stopFollowing() {
    if (!follow) return;
    clearTimeout(follow.timer);
    follow = null;
    working.clear();
    renderWorking();
    renderSend();
  }

  async function stopRun() {
    if (!run && follow) {
      // A round running elsewhere: the server stops it; the next look sees it end.
      const target = follow.target;
      await api.stopGroup(target.id).catch((err) => toast(err.message, 'error'));
      return;
    }
    if (!run) return;
    const current = run;
    try {
      await api.stopGroup(current.id);
    } catch {
      /* hanging up below still ends what this tab shows */
    }
    current.controller.abort();
  }

  /* ── the @ picker ─────────────────────────────────────────────── */

  function closePicker() {
    // Typing outside a group asks this at every key: shut is left as it is.
    if (!picker && pickerBox.hidden) return;
    picker = null;
    pickerBox.hidden = true;
    pickerBox.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function updatePicker() {
    const group = open?.kind === 'group' ? groupOf(open.id) : null;
    const at = group ? atQuery(input.value, input.selectionStart ?? input.value.length) : null;
    if (!at) return closePicker();
    const q = at.query.toLowerCase();
    const items = membersOf(group).filter((b) => b.name.toLowerCase().startsWith(q) || b.name.toLowerCase().includes(q));
    if (!items.length) return closePicker();
    const index = picker && picker.start === at.start ? Math.min(picker.index, items.length - 1) : 0;
    picker = { start: at.start, items, index };
    pickerBox.innerHTML = items
      .map((b, i) => `<div class="atpick__item${i === index ? ' is-on' : ''}" role="option" id="atpick-${i}" aria-selected="${i === index}" data-pick="${i}" style="--ink:${inkOf(b)}">${faceHtml(b, 22)}<span class="atpick__name">${escapeHtml(b.name)}</span>${b.role ? `<span class="atpick__role">${escapeHtml(b.role)}</span>` : ''}</div>`)
      .join('');
    pickerBox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `atpick-${index}`);
    paintFaces(pickerBox);
  }

  function pick(i) {
    if (!picker) return;
    const bot = picker.items[i];
    const caret = input.selectionStart ?? input.value.length;
    input.value = `${input.value.slice(0, picker.start)}@${bot.name} ${input.value.slice(caret)}`;
    const end = picker.start + bot.name.length + 2;
    input.setSelectionRange(end, end);
    closePicker();
    syncMentions();
    input.focus();
  }

  /* ── "@Name" bold in the box (owner, 2026-11-10) ───────────────── */

  /**
   * A textarea cannot bold a word, so in a group a layer under the box draws the same
   * text with each "@Name" that will call a member marked in that bot's colour; the box's
   * own letters go clear above it, its caret, selection and spelling marks still its own.
   * Laid out with the box's font, padding and width, and scrolled with it, so the two do
   * not drift. Only in a group: anywhere else "@" calls nobody, and the box is as it was.
   */
  const lay = document.createElement('div');
  lay.className = 'mentionlay';
  lay.setAttribute('aria-hidden', 'true');
  let laid = '';
  let watching = 0;

  function syncMentions() {
    const group = inGroup() ? groupOf(open?.id) : null;
    const text = input.value;
    const spans = group ? mentionSpans(text, membersOf(group)) : [];
    if (!spans.length) {
      if (laid || lay.isConnected) {
        laid = '';
        input.classList.remove('has-mentions');
        lay.remove();
      }
      return;
    }
    if (!lay.isConnected) input.before(lay);
    input.classList.add('has-mentions');
    const style = getComputedStyle(input);
    Object.assign(lay.style, {
      top: `${input.offsetTop + input.clientTop}px`,
      left: `${input.offsetLeft + input.clientLeft}px`,
      width: `${input.clientWidth}px`,
      height: `${input.clientHeight}px`,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      padding: style.padding,
      textAlign: style.textAlign,
    });
    let html = '';
    let at = 0;
    for (const span of spans) {
      html += `${escapeHtml(text.slice(at, span.start))}<span class="mentionlay__at" style="--ink:${inkOf(/** @type {any} */ (span.bot))}">${escapeHtml(text.slice(span.start, span.end))}</span>`;
      at = span.end;
    }
    // The zero-width space keeps a last empty line its height, as the box gives it one.
    lay.innerHTML = `${html}${escapeHtml(text.slice(at))}\u200b`;
    laid = text;
    lay.scrollTop = input.scrollTop;
    // The box is also filled, emptied and sized from script, which says nothing: a look each
    // frame keeps the layer true while it shows, and stops when it goes.
    if (!watching) {
      const look = () => {
        if (!laid) return void (watching = 0);
        if (input.value !== laid || lay.offsetHeight !== input.clientHeight) syncMentions();
        else lay.scrollTop = input.scrollTop;
        watching = laid ? requestAnimationFrame(look) : 0;
      };
      watching = requestAnimationFrame(look);
    }
  }

  /* ── the row menu (spec B.3) ─────────────────────────────────────── */

  /**
   * Open the menu of a row: under its ⋯ button, or where the pointer is for a right click
   * or a long press. Arrow keys move in it, Escape shuts it and gives focus back.
   *
   * @param {'bot' | 'group'} kind @param {string} id @param {HTMLElement} from @param {{ x: number, y: number } | null} [at]
   */
  function openRowMenu(kind, id, from, at = null) {
    const item = kind === 'group' ? groupOf(id) : botOf(id);
    if (!item) return;
    closeRowMenu(false);
    rowMenu = { kind, id, from };
    rowMenuBox.innerHTML = menuHtml(kind, item);
    rowMenuBox.setAttribute('aria-label', t('bots.menu.more', { name: item.name }));
    rowMenuBox.hidden = false;
    from.setAttribute('aria-expanded', 'true');
    const r = from.getBoundingClientRect();
    const w = rowMenuBox.offsetWidth;
    const h = rowMenuBox.offsetHeight;
    const x = at ? at.x : r.right - w;
    const y = at ? at.y : r.bottom + 4;
    rowMenuBox.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    rowMenuBox.style.top = `${Math.max(8, y + h > innerHeight - 8 ? y - h - (at ? 0 : r.height + 8) : y)}px`;
    /** @type {HTMLElement | null} */ (rowMenuBox.querySelector('[role="menuitem"]'))?.focus();
  }
  function closeRowMenu(focusBack = true) {
    if (!rowMenu) return;
    const { from } = rowMenu;
    rowMenu = null;
    rowMenuBox.hidden = true;
    rowMenuBox.innerHTML = '';
    if (from.isConnected) {
      from.setAttribute('aria-expanded', 'false');
      if (focusBack) from.focus();
    }
  }

  /** Ask once more before a bot or a group goes (spec B.5), in the dialog Reset uses. */
  function askDelete(kind, item) {
    confirmBox.innerHTML = `<form method="dialog" class="botconfirm__form">
      <h2 class="botconfirm__title">${escapeHtml(t('bots.deleteTitle', { name: item.name }))}</h2>
      <p class="botconfirm__text">${escapeHtml(t(kind === 'group' ? 'bots.deleteBodyGroup' : 'bots.deleteBody', { name: item.name }))}</p>
      <div class="botconfirm__acts">
        <button class="btn" type="submit" value="cancel" autofocus>${escapeHtml(t('action.cancel'))}</button>
        <button class="btn btn--danger" type="submit" value="delete">${escapeHtml(t('bots.menu.delete'))}</button>
      </div>
    </form>`;
    confirmBox.returnValue = '';
    confirmBox.addEventListener(
      'close',
      async () => {
        if (confirmBox.returnValue !== 'delete') return;
        try {
          await (kind === 'group' ? api.deleteGroup(item.id) : api.deleteBot(item.id));
          toast(changeLine({ kind, removed: item.id }, false, item.name), 'ok');
          await applyChange({ kind, removed: item.id });
        } catch (err) {
          toast(err.message, 'error');
        }
      },
      { once: true },
    );
    confirmBox.showModal();
  }

  /** What a row menu item does. @param {string} act */
  async function rowAction(act) {
    if (!rowMenu) return;
    const { kind, id } = rowMenu;
    const item = kind === 'group' ? groupOf(id) : botOf(id);
    closeRowMenu(act !== 'open' && act !== 'settings' && act !== 'delete');
    if (!item) return;
    try {
      if (act === 'open') await openSubject(kind, id);
      else if (act === 'settings') openBotSettings({ ...settingsDeps(), page: kind === 'group' ? 'groups' : 'bots', id });
      else if (act === 'pin' || act === 'unpin') {
        const answer = kind === 'group' ? await api.updateGroup(id, { pinned: act === 'pin' }) : await api.updateBot(id, { pinned: act === 'pin' });
        await applyChange({ kind, item: answer.group || answer.bot });
      } else if (act === 'pause' || act === 'resume') {
        const { bot } = await api.updateBot(id, { paused: act === 'pause' });
        toast(t(act === 'pause' ? 'bots.pausedDone' : 'bots.resumedDone', { name: item.name }), 'ok');
        await applyChange({ kind: 'bot', item: bot });
      } else if (act === 'duplicate') {
        const { bot } = await api.duplicateBot(id);
        toast(t('bots.duplicated', { name: bot.name }), 'ok');
        await applyChange({ kind: 'bot', item: bot });
      } else if (act === 'export') {
        await exportTeam(api, { kind, name: item.name });
        toast(t('bots.port.exported'), 'ok');
      } else if (act === 'delete') askDelete(kind, item);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  rowMenuBox.addEventListener('keydown', (event) => {
    const items = /** @type {HTMLElement[]} */ ([...rowMenuBox.querySelectorAll('[role="menuitem"]')]);
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const go = (i) => items[(i + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Escape') closeRowMenu();
    else if (event.key === 'Tab') return closeRowMenu(false);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  rowMenuBox.addEventListener('click', (event) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-row-act]'));
    if (item) void rowAction(String(item.dataset.rowAct));
  });
  // A right click on a row, or the keyboard's menu key, opens its menu where it is.
  page.addEventListener('contextmenu', (event) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-row]'));
    if (!row) return;
    event.preventDefault();
    const [kind, id] = String(row.dataset.row).split(':');
    const keyboard = event.button !== 2 && !event.clientX && !event.clientY;
    openRowMenu(/** @type {'bot' | 'group'} */ (kind), id, row, keyboard ? null : { x: event.clientX, y: event.clientY });
  });
  // A long press on a phone opens it too; the tap that ends the press opens nothing.
  let press = /** @type {{ timer: any, row: HTMLElement, x: number, y: number, fired: boolean } | null} */ (null);
  page.addEventListener('pointerdown', (event) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-row]'));
    if (!row || event.pointerType === 'mouse') return;
    const at = { x: event.clientX, y: event.clientY };
    press = {
      row,
      ...at,
      fired: false,
      timer: setTimeout(() => {
        if (!press) return;
        press.fired = true;
        const [kind, id] = String(row.dataset.row).split(':');
        openRowMenu(/** @type {'bot' | 'group'} */ (kind), id, row, at);
      }, 550),
    };
  });
  const endPress = (event) => {
    if (!press) return;
    if (event.type === 'pointermove' && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 10) return;
    clearTimeout(press.timer);
    if (!press.fired) press = null;
  };
  for (const type of ['pointerup', 'pointercancel', 'pointermove']) page.addEventListener(type, endPress);
  page.addEventListener(
    'click',
    (event) => {
      if (!press?.fired) return;
      press = null;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  document.addEventListener('pointerdown', (event) => {
    if (rowMenu && !rowMenuBox.contains(/** @type {Node} */ (event.target)) && !/** @type {HTMLElement} */ (event.target).closest?.('[data-row-more]')) closeRowMenu(false);
  });

  /* ── wiring ──────────────────────────────────────────────────── */

  const inGroup = () => shown && open?.kind === 'group';
  input.addEventListener('input', () => {
    if (inGroup()) updatePicker();
    else closePicker();
    syncMentions();
  });
  input.addEventListener('scroll', () => {
    if (laid) lay.scrollTop = input.scrollTop;
  });
  // Caught before the box's own keys, so Enter picks a name rather than sending.
  input.closest('form')?.addEventListener('keydown', (event) => {
    if (event.target !== input || !inGroup()) return;
    if (picker) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        picker.index = (picker.index + (event.key === 'ArrowDown' ? 1 : picker.items.length - 1)) % picker.items.length;
        const keep = picker.index;
        updatePicker();
        if (picker) picker.index = keep;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        pick(picker.index);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker();
        return;
      }
    }
  }, true);
  input.addEventListener('click', () => (inGroup() ? updatePicker() : undefined));
  // Shut once the box has really been left. Opening a group moves the box, which blurs it for an
  // instant; a close that ignored the focus coming back shut the picker the person had just opened
  // by typing "@" (owner, 2026-11-11: found under load, where the 150 ms outlived the typing).
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement !== input) closePicker();
    }, 150),
  );
  pickerBox.addEventListener('mousedown', (event) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-pick]'));
    if (!item) return;
    event.preventDefault();
    pick(Number(item.dataset.pick));
  });

  const closeNewMenu = () => {
    newMenu.hidden = true;
    page.querySelector('[data-act="new"]')?.setAttribute('aria-expanded', 'false');
  };
  /**
   * A change made in Bot settings, on this page the moment the server answered it (owner,
   * 2026-11-10): the list and the heading drawn from it at once, the conversation on screen
   * left as it is — it used to be read again, with the whole team, before the dialog said
   * anything. The team is read once more behind it, for what only the server knows, and
   * that read is the answer the dialog takes.
   *
   * @param {import('./bots-settings.js').TeamChange} change
   */
  async function applyChange(change) {
    if (!team) return null;
    team = mergeTeam(team, change);
    if (change.removed) chatIds.delete(change.removed);
    renderList();
    if (open && !subject()) {
      // What was open is gone: Chief, where the page was (on a phone the list stays the list).
      const lead = chief();
      if (lead) await openSubject('bot', lead.id, { focus: false, chatting: page.classList.contains('is-chatting') || !matchMedia('(max-width: 760px)').matches });
    } else if (open) {
      renderHead();
      // The open group's log, read again for what the change said in it (team.js sayInGroup).
      if (open.kind === 'group') loadChat().catch(() => renderLog());
      if (detailsOpen) renderDetails();
      syncMentions();
    }
    try {
      await loadTeam();
      renderHead();
      return team;
    } catch {
      return null;
    }
  }
  const settingsDeps = () => ({ team, toast, onChanged: applyChange, openSettings, openFeedback, openAutomations });

  page.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    // A file a bot made in the group opens as it does in the home chat; its download link is the browser's.
    const fileOpener = /** @type {HTMLElement | null} */ (target.closest('[data-file]'));
    if (fileOpener && !target.closest('a[download], [data-no-open]')) {
      event.preventDefault();
      openFile(String(fileOpener.dataset.file));
      return;
    }
    // A webhook's panel, its secret shown once, and Copy (spec C.1); a wait's ✕ (spec C.2).
    const copyValue = /** @type {HTMLElement | null} */ (target.closest('[data-copy-value]'));
    if (copyValue) {
      navigator.clipboard?.writeText(String(copyValue.dataset.copyValue)).then(() => toast(t('viewer.copied'), 'ok'), () => {});
      return;
    }
    const hookToggle = /** @type {HTMLElement | null} */ (target.closest('[data-hook-open]'));
    if (hookToggle) {
      const taskId = String(hookToggle.dataset.hookOpen);
      hookOpen = hookOpen === taskId ? '' : taskId;
      if (hookOpen) await readHook(taskId);
      else await renderDetails();
      return;
    }
    if (target.closest('[data-hook-dismiss]')) {
      hookShown = null;
      await renderDetails();
      return;
    }
    const hookTest = /** @type {HTMLElement | null} */ (target.closest('[data-hook-test]'));
    if (hookTest) {
      try {
        const answer = await api.testBotTaskHook(String(hookTest.dataset.hookTest));
        toast(answer.accepted ? t('bots.hook.testSent') : t('bots.hook.testIgnored', { why: answer.ignored || answer.error || '' }), answer.accepted ? 'ok' : 'error');
      } catch (err) {
        toast(err.message, 'error');
      }
      setTimeout(() => (hookOpen ? void readHook(hookOpen) : undefined), 1500);
      return;
    }
    const hookRotate = /** @type {HTMLElement | null} */ (target.closest('[data-hook-rotate]'));
    if (hookRotate) {
      if (hookRotate.dataset.armed !== '1') {
        hookRotate.dataset.armed = '1';
        hookRotate.textContent = t('bots.hook.rotateConfirm');
        return;
      }
      try {
        const taskId = String(hookRotate.dataset.hookRotate);
        const answer = await api.rotateBotTaskHook(taskId);
        hookShown = { taskId, url: answer.url, secret: answer.secret };
        toast(t('bots.hook.rotated'), 'ok');
        await readHook(taskId);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const waitClose = /** @type {HTMLElement | null} */ (target.closest('[data-wait-close]'));
    if (waitClose && open?.kind === 'bot') {
      const waitId = String(waitClose.dataset.waitClose);
      const before = waits;
      waits = waits.filter((w) => w.id !== waitId);
      drawWaits();
      await api.closeBotWait(open.id, waitId).catch((err) => {
        waits = before;
        drawWaits();
        toast(err.message, 'error');
      });
      return;
    }
    const more = /** @type {HTMLElement | null} */ (target.closest('[data-row-more]'));
    if (more) {
      const [kind, id] = String(more.dataset.rowMore).split(':');
      if (rowMenu && rowMenu.from === more) closeRowMenu();
      else openRowMenu(/** @type {'bot' | 'group'} */ (kind), id, more);
      return;
    }
    // A line of Needs you: its button does what it says (spec B.2).
    const need = /** @type {HTMLElement | null} */ (target.closest('[data-need]'));
    if (need) {
      const item = attention[Number(need.dataset.need)];
      if (!item) return;
      if (item.kind === 'failed' && item.taskId) {
        attention = attention.filter((x) => x !== item);
        renderList();
        toast(t('bots.needs.retrying', { name: item.text }), 'ok');
        api.runTask(item.taskId).catch((err) => toast(err.message, 'error')).finally(() => readTeamNow());
      } else if (item.kind === 'ceiling' && item.group) {
        await openSubject('group', item.group);
        await continueRun();
      } else if (item.group) await openSubject('group', item.group);
      else if (item.bot) await openSubject('bot', item.bot);
      return;
    }
    const opener = /** @type {HTMLElement | null} */ (target.closest('[data-open]'));
    if (opener) {
      const [kind, id] = String(opener.dataset.open).split(':');
      openSubject(/** @type {'bot' | 'group'} */ (kind), id);
      return;
    }
    const taskToggle = /** @type {HTMLElement | null} */ (target.closest('[data-task-toggle]'));
    if (taskToggle) {
      await api.setTaskEnabled(taskToggle.dataset.taskToggle, taskToggle.dataset.enabled !== '1').catch((err) => toast(err.message, 'error'));
      renderDetails();
      return;
    }
    const taskDelete = /** @type {HTMLElement | null} */ (target.closest('[data-task-delete]'));
    if (taskDelete) {
      await api.deleteTask(taskDelete.dataset.taskDelete).catch((err) => toast(err.message, 'error'));
      renderDetails();
      return;
    }
    const kindNow = open?.kind === 'group' ? 'bot-groups' : 'bots';
    const pinBtn = /** @type {HTMLElement | null} */ (target.closest('[data-pin]'));
    if (pinBtn && open && detailsData) {
      const entry = detailsData.entries.find((e) => e.id === pinBtn.dataset.pin);
      if (!entry) return;
      const was = !!entry.pinned;
      entry.pinned = !was;
      paintMemory();
      await api.editBotMemory(kindNow, open.id, entry.id, { pinned: !was }).catch((err) => {
        entry.pinned = was;
        paintMemory();
        toast(err.message, 'error');
      });
      return;
    }
    const editBtn = /** @type {HTMLElement | null} */ (target.closest('[data-edit]'));
    if (editBtn) {
      editingEntry = String(editBtn.dataset.edit);
      paintMemory();
      /** @type {HTMLInputElement | null} */ (details.querySelector('[data-edit-text]'))?.focus();
      return;
    }
    if (target.closest('[data-edit-cancel]')) {
      editingEntry = '';
      paintMemory();
      return;
    }
    // An earlier version or a forgotten entry back, or a review's change taken back (owner, 2026-11-12).
    const restoreBtn = /** @type {HTMLElement | null} */ (target.closest('[data-restore], [data-undo-review]'));
    if (restoreBtn && open && detailsData) {
      const reviewed = restoreBtn.dataset.undoReview ? detailsData.entries.find((e) => e.id === restoreBtn.dataset.undoReview) : null;
      try {
        if (restoreBtn.dataset.restore) await api.restoreBotMemory(kindNow, open.id, restoreBtn.dataset.restore);
        else if (reviewed?.history?.length) await api.restoreBotMemory(kindNow, open.id, reviewed.history[0].id);
        else if (reviewed) await api.deleteBotMemory(kindNow, open.id, reviewed.id);
        const fresh = await api.botMemory(kindNow, open.id);
        detailsData.entries = fresh.entries || [];
        detailsData.forgotten = fresh.forgotten || [];
        toast(t('bots.memoryRestored'), 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
      paintMemory();
      return;
    }
    const undoBtn = /** @type {HTMLElement | null} */ (target.closest('[data-undo-forget]'));
    if (undoBtn && open && forgotten) {
      const back = forgotten;
      clearTimeout(back.timer);
      forgotten = null;
      try {
        await api.undoBotMemory(kindNow, open.id, [back.id]);
        const { entries } = await api.botMemory(kindNow, open.id);
        if (detailsData) detailsData.entries = entries || [];
      } catch (err) {
        toast(err.message, 'error');
      }
      paintMemory();
      return;
    }
    const forgetBtn = /** @type {HTMLElement | null} */ (target.closest('[data-forget]'));
    if (forgetBtn) {
      if (forgetBtn.dataset.armed !== '1') {
        forgetBtn.dataset.armed = '1';
        forgetBtn.textContent = t('bots.forgetConfirm');
        setTimeout(() => {
          if (forgetBtn.isConnected) {
            forgetBtn.dataset.armed = '';
            forgetBtn.textContent = t('bots.forget');
          }
        }, 3000);
        return;
      }
      const id = String(forgetBtn.dataset.forget);
      const held = detailsData?.entries || [];
      const before = [...held];
      if (detailsData) detailsData.entries = held.filter((e) => e.id !== id);
      // One the bot forgot, deleted by the person: gone from that list too, every version with it.
      if (detailsData?.forgotten) detailsData.forgotten = detailsData.forgotten.filter((f) => f.id !== id);
      // Undo, where it was, for eight seconds.
      if (forgotten) clearTimeout(forgotten.timer);
      forgotten = {
        id,
        text: held.find((e) => e.id === id)?.text || '',
        timer: setTimeout(() => {
          forgotten = null;
          paintMemory();
        }, 8000),
      };
      paintMemory();
      await api.deleteBotMemory(open?.kind === 'group' ? 'bot-groups' : 'bots', open?.id, id).catch((err) => {
        if (detailsData) detailsData.entries = before;
        paintMemory();
        toast(err.message, 'error');
      });
      return;
    }
    const act = /** @type {HTMLElement | null} */ (target.closest('[data-act]'))?.dataset.act;
    if (!act) {
      if (!target.closest('[data-menu]')) closeNewMenu();
      return;
    }
    if (act === 'new') {
      newMenu.hidden = !newMenu.hidden;
      page.querySelector('[data-act="new"]')?.setAttribute('aria-expanded', String(!newMenu.hidden));
      if (!newMenu.hidden) /** @type {HTMLElement} */ (newMenu.querySelector('button')).focus();
    } else if (act === 'team-files') {
      closeNewMenu();
      openTeamFiles({ api, toast, onImported: () => readTeamNow() });
    } else if (act === 'aside' && open?.kind === 'bot') {
      if (aside.showingFor() === open.id) aside.close();
      else aside.open(open.id);
    } else if (act === 'resume-open' && open?.kind === 'bot') {
      try {
        const { bot } = await api.updateBot(open.id, { paused: false });
        toast(t('bots.resumedDone', { name: bot.name }), 'ok');
        await applyChange({ kind: 'bot', item: bot });
      } catch (err) {
        toast(err.message, 'error');
      }
    } else if (act === 'first-create') {
      const lead = chief();
      if (!lead) return;
      keepFirstDrafts();
      const button = /** @type {HTMLButtonElement} */ (target.closest('button'));
      button.disabled = true;
      const { made, failed, group } = await createFromFirstRun({ picked: firstPicked, drafts: firstDrafts, chiefId: lead.id, api });
      for (const line of failed) toast(line, 'error');
      if (made.length) toast(t('bots.first.done', { n: made.length }), 'ok');
      await readTeamNow();
      if (group) await openSubject('group', group.id);
      else if (made.length === 1) await openSubject('bot', made[0].id);
      else button.disabled = false;
    } else if (act === 'first-skip') {
      firstSkipped = true;
      try {
        localStorage.setItem('bots.firstSkipped', '1');
      } catch {
        /* the card comes back next time; nothing else depends on it */
      }
      renderFirst();
      input.focus();
    } else if (act === 'new-bot' || act === 'new-group') {
      closeNewMenu();
      openBotSettings({ ...settingsDeps(), page: act === 'new-bot' ? 'bots' : 'groups', id: 'new' });
    } else if (act === 'settings') openBotSettings({ ...settingsDeps(), page: 'bots', id: null });
    else if (act === 'edit-bot') openBotSettings({ ...settingsDeps(), page: 'bots', id: open?.id || null });
    else if (act === 'edit-group') openBotSettings({ ...settingsDeps(), page: 'groups', id: open?.id || null });
    else if (act === 'details') {
      detailsOpen = !detailsOpen;
      renderHead();
      renderDetails();
    } else if (act === 'close-details') {
      detailsOpen = false;
      renderHead();
      renderDetails();
      pill.focus();
    } else if (act === 'memory') toggleMemory();
    else if (act === 'reset') askReset(); else if (act === 'task-add') {
      taskFormOpen = true;
      await renderDetails();
      /** @type {HTMLInputElement | null} */ (details.querySelector('[data-task-title]'))?.focus();
    } else if (act === 'stop') stopRun();
    else if (act === 'continue') continueRun();
    else if (act === 'copy') {
      const line = /** @type {HTMLElement | null} */ (target.closest('[data-line]'));
      const message = chat?.messages.find((m) => lineKey(m) === line?.dataset.line);
      if (message) {
        navigator.clipboard?.writeText(String(message.text || '')).then(() => toast(t('viewer.copied'), 'ok'), () => {});
      }
    }
    else if (act === 'automations') openAutomations('scheduled');
    else if (act === 'back') {
      page.classList.remove('is-chatting');
      // The details lie over the list on a phone; going back to the list closes them.
      detailsOpen = false;
      renderHead();
      renderDetails();
      /** @type {HTMLElement | null} */ (list.querySelector('[aria-current="true"]') || chiefBox.querySelector('button'))?.focus();
    }
  });

  page.addEventListener('change', (event) => {
    const box = /** @type {HTMLInputElement} */ (event.target);
    if (box.matches('[data-task-trigger]')) {
      const whenBox = /** @type {HTMLInputElement | null} */ (box.closest('form')?.querySelector('[data-task-when]') || null);
      if (whenBox) {
        whenBox.hidden = box.value === 'hook';
        whenBox.required = box.value !== 'hook';
      }
      return;
    }
    if (!box.matches('[data-goal]')) return;
    keepFirstDrafts();
    if (box.checked) firstPicked.add(String(box.dataset.goal));
    else firstPicked.delete(String(box.dataset.goal));
    firstBox.innerHTML = firstRunHtml(firstPicked, firstDrafts);
    /** @type {HTMLElement | null} */ (firstBox.querySelector(`[data-goal="${box.dataset.goal}"]`))?.focus();
  });

  page.addEventListener('submit', async (event) => {
    const form = /** @type {HTMLElement} */ (event.target);
    if (form.matches('[data-task-add]') && open) {
      event.preventDefault();
      const value = (sel) => /** @type {HTMLInputElement} */ (form.querySelector(sel)).value.trim();
      try {
        const trigger = /** @type {HTMLSelectElement | null} */ (form.querySelector('[data-task-trigger]'))?.value || 'schedule';
        const task = { title: value('[data-task-title]'), prompt: value('[data-task-prompt]'), when: value('[data-task-when]'), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, trigger };
        // A group's task runs as a round from its prompt (spec B.4); a bot's may wait for a request (spec C.1).
        const made = await (open.kind === 'group' ? api.addGroupTask(open.id, task) : api.addBotTask(open.id, task));
        if (made?.hook) hookShown = { taskId: made.task.id, url: made.hook.url, secret: made.hook.secret };
        taskFormOpen = false;
        await renderDetails();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    if (form.matches('[data-hook-filters]')) {
      event.preventDefault();
      const taskId = String(form.dataset.hookFilters);
      const match = [];
      for (let i = 0; i < 5; i += 1) {
        const pointer = /** @type {HTMLInputElement | null} */ (form.querySelector(`[data-filter-pointer="${i}"]`))?.value.trim() || '';
        const raw = /** @type {HTMLInputElement | null} */ (form.querySelector(`[data-filter-value="${i}"]`))?.value.trim() || '';
        if (!pointer) continue;
        let value = raw;
        try {
          value = JSON.parse(raw);
        } catch {
          /* a bare word is a string */
        }
        match.push({ pointer, value });
      }
      const type = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-filter-type]'))?.value.trim() || '';
      try {
        await api.setBotTaskHookFilters(taskId, { ...(type ? { type } : {}), match });
        toast(t('bots.hook.filtersSaved'), 'ok');
        await readHook(taskId);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    if (form.matches('[data-memory-edit]') && open && detailsData) {
      event.preventDefault();
      const entry = detailsData.entries.find((e) => e.id === form.dataset.memoryEdit);
      const box = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-edit-text]'));
      const text = box?.value.trim() || '';
      editingEntry = '';
      if (!entry || !text || text === entry.text) return void paintMemory();
      const was = entry.text;
      entry.text = text;
      paintMemory();
      try {
        const { entry: saved } = await api.editBotMemory(open.kind === 'group' ? 'bot-groups' : 'bots', open.id, entry.id, { text });
        // The person's own words now: no earlier version is kept, nor where a bot saved it (PRV-006).
        Object.assign(entry, saved, { history: [], saved: null });
      } catch (err) {
        entry.text = was;
        toast(err.message, 'error');
      }
      paintMemory();
      return;
    }
    if (!form.matches('[data-memory-add]')) return;
    event.preventDefault();
    const field = /** @type {HTMLInputElement} */ (form.querySelector('[data-memory-text]'));
    const text = field.value.trim();
    if (!text || !open) return;
    const pending = { id: `new-${crypto.randomUUID()}`, text, source: 'user' };
    if (detailsData) detailsData.entries = [...detailsData.entries, pending];
    field.value = '';
    paintMemory();
    /** @type {HTMLInputElement | null} */ (details.querySelector('[data-memory-text]'))?.focus();
    try {
      const answer = await api.addBotMemory(open.kind === 'group' ? 'bot-groups' : 'bots', open.id, text);
      const saved = Array.isArray(answer?.entries) ? answer.entries : answer?.entry ? [answer.entry] : [];
      if (detailsData) detailsData.entries = [...detailsData.entries.filter((e) => e !== pending && !saved.some((s) => s.id === e.id)), ...saved];
      paintMemory();
    } catch (err) {
      if (detailsData) detailsData.entries = detailsData.entries.filter((e) => e !== pending);
      paintMemory();
      toast(err.message, 'error');
    }
  });

  page.addEventListener('keydown', (event) => {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.('[data-row]'));
    if (row && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault();
      const [kind, id] = String(row.dataset.row).split(':');
      openRowMenu(/** @type {'bot' | 'group'} */ (kind), id, row);
      return;
    }
    if (event.key === 'Escape' && !newMenu.hidden) {
      closeNewMenu();
      /** @type {HTMLElement | null} */ (page.querySelector('[data-act="new"]'))?.focus();
    }
  });

  return {
    /** Show the page at a bot or group (or Chief), as the rail or an address asks. */
    async show(route = null) {
      shown = true;
      page.hidden = false;
      onShow();
      try {
        // Seen before: drawn at once from what was last read, and read again behind it —
        // unless the address names one that read does not have.
        const known = !route || (route.kind === 'group' ? groupOf(route.id) : botOf(route.id));
        if (team && known) {
          renderList();
          loadTeam().then(() => renderHead(), () => {});
        } else await loadTeam();
        const r = route || (open ? { kind: open.kind, id: open.id } : null);
        const narrow = matchMedia('(max-width: 760px)').matches;
        await openSubject(r?.kind || 'bot', r?.id || chief()?.id, { focus: !route, chatting: !!route || !narrow });
      } catch (err) {
        toast(err.message || t('bots.loadFailed'), 'error');
      }
    },
    hide() {
      if (!shown) return;
      shown = false;
      closeRowMenu(false);
      aside.close();
      // The round goes on without the page (owner, 2026-11-10); coming back follows it again.
      stopFollowing();
      page.hidden = true;
      closePicker();
      syncMentions();
      home.giveBack();
      clearHash();
    },
    showing: () => shown,
    /** The top bar's incognito switch changed: the bot on screen opens again, kept or not. */
    async incognitoChanged() {
      if (shown && open?.kind === 'bot') await loadChat();
    },
    /** The chip changed: an open group answers its next batch on that model, even mid-round. */
    modelChanged(model) {
      if (shown && open?.kind === 'group' && model) api.setGroupModel(open.id, model).catch(() => {});
    },
    /** A turn ended somewhere: the list shows what was said last, if it was a bot's chat. */
    turnEnded(chatId) {
      if (shown && chat?.chatId === chatId) {
        readTeamNow().then(() => markRead());
        void loadWaits();
      }
    },
    /** A step of the turn on screen made or changed a bot or a group: shown now, not at the end. */
    teamChanged() {
      if (shown) readTeamNow();
    },
  };
}
