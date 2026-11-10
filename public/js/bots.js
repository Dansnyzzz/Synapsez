import { api, runGroup, runBotChat } from './api.js';
import { t, localeTag } from './i18n.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { counted } from './format.js';
import { faceHtml, paintFaces, inkOf } from './bot-avatar.js';
import { mentionSpans, atQuery } from './bot-mentions.js';
import { openBotSettings } from './bots-settings.js';
import { compactCount } from './bots-usage.js';

/**
 * The Bot page (owner, 2026-11-09): the person's team of bots, led by Chief.
 *
 * Laid out the way DS Bot lays out its team (NOTICE), in this app's own look: on the
 * left, Chief's card and then the group chats and bots with what was said last; in
 * the middle, the open conversation with a pill naming it and a box to write in; on
 * the right, its details — model, instructions, memory, usage. Bot settings is a
 * dialog of its own (bots-settings.js).
 *
 * A bot's own chat is an ordinary conversation of this app, run by the same agent
 * loop (`/chats/:id/run`); a group's round is one streamed request of its own
 * (`/bot-groups/:id/run`). Both are stopped with one press, which for a group stops
 * every member that is working.
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
 * }} deps
 */
export function createBotPage({ toast, openSettings, openFeedback, openAutomations, onShow = () => {} }) {
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
  let shown = false;
  let picker = /** @type {{ start: number, items: any[], index: number } | null} */ (null);

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
        </div>
      </header>
      <div class="botlist__chief" data-chief></div>
      <ul class="botlist__rows" data-rows></ul>
    </aside>
    <section class="botchat" aria-label="${escapeHtml(t('bots.title'))}" data-chat>
      <header class="botchat__head">
        <button class="icon-btn botchat__back" type="button" data-act="back" aria-label="${escapeHtml(t('bots.back'))}" title="${escapeHtml(t('bots.back'))}">‹</button>
        <button class="botchat__pill" type="button" data-act="details" aria-expanded="false"></button>
      </header>
      <div class="botchat__log scroll-quiet" role="log" aria-live="polite" aria-relevant="additions" data-log></div>
      <div class="botchat__working" data-working aria-live="polite"></div>
      <form class="botchat__composer" data-composer>
        <div class="botchat__box">
          <div class="atpick" role="listbox" aria-label="${escapeHtml(t('bots.pickerLabel'))}" data-picker hidden></div>
          <textarea class="botchat__input" rows="1" data-input aria-label="" aria-autocomplete="list" aria-expanded="false"></textarea>
          <button class="btn btn--primary botchat__send" type="submit" data-send>${escapeHtml(t('bots.send'))}</button>
        </div>
      </form>
    </section>
    <aside class="botdetails scroll-quiet" data-details hidden></aside>`;

  const list = /** @type {HTMLElement} */ (page.querySelector('[data-rows]'));
  const chiefBox = /** @type {HTMLElement} */ (page.querySelector('[data-chief]'));
  const log = /** @type {HTMLElement} */ (page.querySelector('[data-log]'));
  const pill = /** @type {HTMLButtonElement} */ (page.querySelector('[data-act="details"]'));
  const input = /** @type {HTMLTextAreaElement} */ (page.querySelector('[data-input]'));
  const send = /** @type {HTMLButtonElement} */ (page.querySelector('[data-send]'));
  const pickerBox = /** @type {HTMLElement} */ (page.querySelector('[data-picker]'));
  const details = /** @type {HTMLElement} */ (page.querySelector('[data-details]'));
  const workingBox = /** @type {HTMLElement} */ (page.querySelector('[data-working]'));
  const newMenu = /** @type {HTMLElement} */ (page.querySelector('[data-menu="new"]'));

  const botOf = (id) => team?.bots.find((b) => b.id === id) || null;
  const groupOf = (id) => team?.groups.find((g) => g.id === id) || null;
  const chief = () => team?.bots.find((b) => b.main) || null;
  const subject = () => (open?.kind === 'group' ? groupOf(open.id) : open ? botOf(open.id) : null);
  const adminOf = (group) => (group?.admin && group.members.includes(group.admin) ? group.admin : group?.members?.[0] || null);
  const membersOf = (group) => (group?.members || []).map(botOf).filter(Boolean);

  /* ── the list on the left ─────────────────────────────────────── */

  function previewOf(item, isGroup) {
    const last = item.last;
    if (!last?.text) return '';
    const who = last.role === 'user' ? t('bots.you') : isGroup ? botOf(last.bot)?.name || '' : '';
    return `${who ? `${who}: ` : ''}${last.text}`.replace(/\s+/g, ' ').slice(0, 90);
  }

  function groupFaces(group) {
    const faces = membersOf(group).slice(0, 3);
    return `<span class="botfaces" aria-hidden="true">${faces.map((b) => faceHtml(b.avatar, 20)).join('')}</span>`;
  }

  function renderList() {
    if (!team) return;
    const lead = chief();
    chiefBox.innerHTML = lead
      ? `<button class="botchief${open?.kind === 'bot' && open.id === lead.id ? ' is-open' : ''}" type="button" data-open="bot:${escapeHtml(lead.id)}" aria-current="${open?.id === lead.id ? 'true' : 'false'}">
           ${faceHtml(lead.avatar, 64, 'botchief__face')}
           <span class="botchief__star" aria-hidden="true">★</span>
           <span class="botchief__name">${escapeHtml(lead.name)}</span>
           <span class="botchief__role">${escapeHtml(lead.role || t('bots.mainTag'))}</span>
           ${lead.running ? `<span class="botdot" aria-label="${escapeHtml(t('bots.running'))}"></span>` : ''}
         </button>`
      : '';
    const rows = [
      ...team.groups.map((g) => ({ kind: 'group', item: g, at: g.at })),
      ...team.bots.filter((b) => !b.main).map((b) => ({ kind: 'bot', item: b, at: b.at })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    list.innerHTML = rows
      .map(({ kind, item }) => {
        const isOpen = open?.kind === kind && open.id === item.id;
        const preview = previewOf(item, kind === 'group');
        return `<li><button class="botrow${isOpen ? ' is-open' : ''}" type="button" data-open="${kind}:${escapeHtml(item.id)}" aria-current="${isOpen ? 'true' : 'false'}">
          ${kind === 'group' ? groupFaces(item) : faceHtml(item.avatar, 36)}
          <span class="botrow__text"><span class="botrow__name">${escapeHtml(item.name)}</span>${preview ? `<span class="botrow__last">${escapeHtml(preview)}</span>` : ''}</span>
          ${item.running ? `<span class="botdot" role="img" aria-label="${escapeHtml(t('bots.running'))}"></span>` : ''}
        </button></li>`;
      })
      .join('');
    paintFaces(page);
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
        mark.style.setProperty('--ink', inkOf(span.bot.avatar));
        mark.innerHTML = `${faceHtml(span.bot.avatar, 16)}${escapeHtml(text.slice(span.start, span.end))}`;
        frag.append(mark);
        at = span.end;
      }
      frag.append(text.slice(at));
      node.replaceWith(frag);
    }
  }

  /** A team tool's call as an event line: "Created [face] Writer". */
  function eventLine(call, result) {
    if (result?.isError) return '';
    const input = call.input || {};
    if (call.name === 'create_bot') {
      const bot = team?.bots.find((b) => b.name.toLowerCase() === String(input.name || '').toLowerCase());
      return `<p class="botevent">${escapeHtml(t('bots.created'))} ${bot ? faceHtml(bot.avatar, 18) : ''}<span>${escapeHtml(String(input.name || ''))}</span></p>`;
    }
    if (call.name === 'create_group') {
      const group = team?.groups.find((g) => g.name.toLowerCase() === String(input.name || '').toLowerCase());
      return `<p class="botevent">${escapeHtml(t('bots.createdGroup'))} ${group ? groupFaces(group) : ''}<span>${escapeHtml(String(input.name || ''))}</span></p>`;
    }
    if (call.name === 'remember' || call.name === 'forget') return `<p class="botevent">${escapeHtml(t('bots.remembered'))}</p>`;
    return `<p class="botevent">${escapeHtml(t('bots.updated', { name: String(input.bot || input.group || input.name || '') }))}</p>`;
  }

  /** One message of a bot's own chat. */
  function soloHtml(message, results, bot) {
    if (message.role === 'user') return `<div class="botmsg botmsg--user"><div class="botmsg__bubble">${escapeHtml(message.text || '')}</div></div>`;
    if (message.role !== 'assistant') return '';
    const parts = [];
    if (String(message.thinking || '').trim()) {
      parts.push(`<details class="botthought"><summary>${escapeHtml(t('bots.thought'))}</summary><div class="botthought__text">${escapeHtml(message.thinking)}</div></details>`);
    }
    for (const call of message.toolCalls || []) {
      const result = results.get(call.id);
      parts.push(TEAM_EVENTS.has(call.name) ? eventLine(call, result) : `<p class="botstep">${escapeHtml(t('bots.used', { tool: call.name }))}</p>`);
    }
    if (String(message.text || '').trim()) parts.push(`<div class="botmsg botmsg--bot"><div class="botmsg__bubble prose" data-md>${renderMarkdown(message.text)}</div></div>`);
    return parts.join('') || (bot ? '' : '');
  }

  /** One line of a group's log. */
  function groupHtml(message, group) {
    if (message.notice) {
      const name = botOf(message.params?.bot)?.name || t('bots.deletedBot');
      return `<p class="botnotice">${escapeHtml(t(`bots.notice.${message.notice}`, { name, n: message.params?.n ?? '' }))}</p>`;
    }
    if (message.role === 'user') return `<div class="botmsg botmsg--user"><div class="botmsg__bubble">${escapeHtml(message.text || '')}</div></div>`;
    const bot = botOf(message.bot);
    const admin = adminOf(group) === message.bot;
    const ink = inkOf(bot?.avatar);
    return `<div class="botmsg botmsg--member" style="--ink:${ink}">
      ${faceHtml(bot?.avatar || '', 28, 'botmsg__face')}
      <div class="botmsg__body">
        <p class="botmsg__who"><span class="botmsg__name">${escapeHtml(bot?.name || t('bots.deletedBot'))}</span>${admin ? `<span class="bottag">${escapeHtml(t('bots.admin'))}</span>` : ''}</p>
        <div class="botmsg__bubble prose" data-md>${renderMarkdown(message.text || '')}</div>
      </div>
    </div>`;
  }

  function renderLog() {
    const it = subject();
    if (!it || !chat) {
      log.innerHTML = '';
      return;
    }
    const isGroup = open?.kind === 'group';
    const results = new Map();
    for (const m of chat.messages) if (m.role === 'tool') for (const r of m.results || []) results.set(r.toolCallId, r);
    const html = [];
    let lastAt = 0;
    for (const message of chat.messages) {
      const at = new Date(message.createdAt).getTime();
      if (Number.isFinite(at) && at - lastAt > 30 * 60_000) html.push(`<p class="botstamp">${escapeHtml(timeOf(message.createdAt))}</p>`);
      if (Number.isFinite(at)) lastAt = at;
      html.push(isGroup ? groupHtml(message, it) : soloHtml(message, results, it));
    }
    if (!chat.messages.length) {
      const empty = isGroup ? t('bots.emptyGroup') : it.main ? t('bots.emptyChief') : t('bots.empty', { name: it.name });
      html.push(`<p class="botempty">${escapeHtml(empty)}</p>`);
    }
    log.innerHTML = html.join('');
    const bots = isGroup ? membersOf(it) : [];
    for (const bubble of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll('[data-md]'))) markMentions(bubble, bots);
    paintFaces(log);
    log.scrollTop = log.scrollHeight;
  }

  function renderHead() {
    const it = subject();
    if (!it) {
      pill.innerHTML = '';
      return;
    }
    const face = open?.kind === 'group' ? groupFaces(it) : faceHtml(it.avatar, 24);
    pill.innerHTML = `${face}<span class="botchat__name">${escapeHtml(it.name)}</span><span class="botchat__chev" aria-hidden="true">${detailsOpen ? '→' : '←'}</span>`;
    pill.setAttribute('aria-expanded', String(detailsOpen));
    pill.setAttribute('aria-label', t('bots.detailsOpen', { name: it.name }));
    input.placeholder = t('bots.message', { name: it.name });
    input.setAttribute('aria-label', t('bots.message', { name: it.name }));
    paintFaces(pill);
  }

  function renderSend() {
    const busy = !!run && run.kind === open?.kind && run.id === open?.id;
    send.textContent = busy ? t('bots.stop') : t('bots.send');
    send.classList.toggle('is-stop', busy);
    send.type = busy ? 'button' : 'submit';
  }

  function renderWorking() {
    const rows = [...working.entries()].map(([id, state]) => {
      const bot = botOf(id);
      if (!bot) return '';
      const doing = state.tool ? t('bots.using', { name: bot.name, tool: state.tool }) : t('bots.working', { name: bot.name });
      return `<div class="botworking" style="--ink:${inkOf(bot.avatar)}">${faceHtml(bot.avatar, 20)}<span class="botworking__who">${escapeHtml(doing)}</span>${state.text ? `<span class="botworking__text">${escapeHtml(state.text.slice(-160))}</span>` : ''}</div>`;
    });
    workingBox.innerHTML = rows.join('');
    paintFaces(workingBox);
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

  async function renderDetails() {
    details.hidden = !detailsOpen;
    page.classList.toggle('has-details', detailsOpen);
    if (!detailsOpen) return;
    const it = subject();
    if (!it) return;
    const isGroup = open?.kind === 'group';
    const kind = isGroup ? 'bot-groups' : 'bots';
    const turn = ++detailsTurn;
    details.innerHTML = `<header class="botdetails__head"><button class="icon-btn" type="button" data-act="close-details" aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button></header>
      <div class="botdetails__who">
        ${isGroup ? groupFaces(it) : faceHtml(it.avatar, 88, 'botdetails__face')}
        <h2 class="botdetails__name">${escapeHtml(it.name)}</h2>
        ${!isGroup && it.role ? `<p class="botdetails__role">${escapeHtml(it.role)}</p>` : ''}
      </div>
      <div data-body><p class="hint">…</p></div>`;
    paintFaces(details);
    const [memory, usage] = await Promise.all([
      api.botMemory(kind, it.id).catch(() => ({ entries: [] })),
      usageLine(isGroup ? it.members : [it.id]).catch(() => []),
    ]);
    if (turn !== detailsTurn) return;
    const body = /** @type {HTMLElement} */ (details.querySelector('[data-body]'));
    const parts = [];
    if (isGroup) {
      const admin = adminOf(it);
      parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.members'))}</h3>
        ${run?.kind === 'group' && run.id === it.id ? `<button class="btn btn--small botsec__stop" type="button" data-act="stop">${escapeHtml(t('bots.stopAll'))}</button>` : ''}
        <ul class="botmembers">${membersOf(it).map((b) => `<li style="--ink:${inkOf(b.avatar)}">${faceHtml(b.avatar, 22)}<span>${escapeHtml(b.name)}</span>${b.id === admin ? `<span class="bottag">${escapeHtml(t('bots.admin'))}</span>` : ''}</li>`).join('')}</ul>
        <button class="botlink" type="button" data-act="edit-group">${escapeHtml(t('bots.groupSettings'))} ›</button></section>`);
    } else {
      parts.push(`<section class="botsec"><h3 class="botsec__label"><label for="bot-model-pick">${escapeHtml(t('bots.model'))}</label></h3>
        <select class="botselect" id="bot-model-pick" data-model><option value="">${escapeHtml(t('bots.modelAccount'))}</option>${it.model ? `<option value="${escapeHtml(it.model)}" selected>${escapeHtml(it.model)}</option>` : ''}</select></section>`);
      parts.push(`<button class="botlink botlink--center" type="button" data-act="edit-bot">${escapeHtml(t(it.instructions ? 'bots.instructionsEdit' : 'bots.instructionsAdd'))}</button>`);
    }
    const entries = memory.entries || [];
    parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.memory'))}</h3>
      <button class="botcard" type="button" data-act="memory" aria-expanded="${memoryOpen}"><span>${escapeHtml(counted(entries.length, 'bots.entries'))}</span><span class="botcard__more">${escapeHtml(t('bots.manage'))} ›</span></button>
      ${memoryOpen ? memoryHtml(entries) : ''}</section>`);
    const usageRows = usage
      .map((u) => {
        const b = botOf(u.id);
        return `<li><span>${escapeHtml(b?.name || '')}</span><span>${escapeHtml(t('bots.usageLine', { tokens: compactCount(u.tokens), rate: `${u.rate}%` }))}</span></li>`;
      })
      .join('');
    parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.usage'))}</h3>${usage.some((u) => u.tokens) ? `<ul class="botusage">${usageRows}</ul>` : `<p class="hint">${escapeHtml(t('bots.usageNone'))}</p>`}</section>`);
    parts.push(`<section class="botsec"><h3 class="botsec__label">${escapeHtml(t('bots.scheduled'))}</h3><button class="botlink" type="button" data-act="automations">${escapeHtml(t('bots.scheduledNote'))} ›</button></section>`);
    body.innerHTML = parts.join('');
    paintFaces(body);
    if (!isGroup) fillModels(/** @type {HTMLSelectElement} */ (body.querySelector('[data-model]')), it.model);
  }

  function memoryHtml(entries) {
    return `<div class="botmemory">
      ${entries.length ? `<ul class="botmemory__list">${entries.map((e) => `<li><span class="botmemory__text">${escapeHtml(e.text)}</span><button class="botmemory__forget" type="button" data-forget="${escapeHtml(e.id)}" aria-label="${escapeHtml(t('bots.forget'))}: ${escapeHtml(e.text.slice(0, 40))}">${escapeHtml(t('bots.forget'))}</button></li>`).join('')}</ul>` : `<p class="hint">${escapeHtml(t('bots.memoryEmpty'))}</p>`}
      <form class="botmemory__add" data-memory-add>
        <input type="text" maxlength="300" data-memory-text aria-label="${escapeHtml(t('bots.memoryAdd'))}" placeholder="${escapeHtml(t('bots.memoryPlaceholder'))}" />
        <button class="btn btn--small" type="submit">${escapeHtml(t('bots.memoryAdd'))}</button>
      </form></div>`;
  }

  /** The models a bot can run on: the account's, then the ones this account can reach. */
  let modelList = null;
  async function fillModels(select, current) {
    if (!select) return;
    try {
      modelList ||= api.models({}).then((data) => [...(data.builtin || []), ...(data.models || [])].slice(0, 300));
      const models = await modelList;
      const seen = new Set(['', ...(current ? [current] : [])]);
      for (const m of models) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        const option = document.createElement('option');
        option.value = m.id;
        option.textContent = m.label ? `${m.label}${m.provider ? ` · ${m.provider}` : ''}` : m.id;
        select.append(option);
      }
      select.value = current || '';
    } catch {
      /* the list is a convenience; the bot keeps its model */
    }
  }

  /* ── loading and opening ─────────────────────────────────────── */

  async function loadTeam() {
    team = await api.bots();
    renderList();
    return team;
  }

  async function loadChat() {
    if (!open) return;
    const asked = open;
    const data = open.kind === 'group' ? await api.groupChat(open.id) : await api.botChat(open.id);
    if (open !== asked) return;
    chat = { chatId: data.chatId, messages: data.messages || [] };
    renderLog();
  }

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
      working.clear();
      renderWorking();
      log.innerHTML = '';
    }
    // On a phone the list and the conversation take turns; the page opened from the rail starts on the list,
    // with nothing laid over it.
    page.classList.toggle('is-chatting', chatting);
    if (!chatting) detailsOpen = false;
    setHash(open);
    renderList();
    renderHead();
    renderSend();
    await loadChat();
    // Always: closed, it hides itself; open, it reads the newly opened one.
    renderDetails();
    if (focus && matchMedia('(min-width: 760px)').matches) input.focus();
  }

  /* ── sending and stopping ─────────────────────────────────────── */

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || !open || run) return;
    closePicker();
    input.value = '';
    autosize();
    const target = open;
    const controller = new AbortController();
    run = { controller, kind: target.kind, id: target.id };
    renderSend();
    const here = () => open && open.kind === target.kind && open.id === target.id;
    try {
      if (target.kind === 'group') {
        run.chatId = chat?.chatId;
        await runGroup({
          groupId: target.id,
          text,
          runId: crypto.randomUUID(),
          signal: controller.signal,
          onEvent: (event, data) => {
            if (!here()) return;
            if (event === 'post' && chat) {
              chat.messages.push(data.message);
              if (data.message.bot) working.delete(data.message.bot);
              renderLog();
              renderWorking();
            } else if (event === 'member_start') {
              working.set(data.bot, { text: '', tool: '' });
              renderWorking();
            } else if (event === 'member_text') {
              const w = working.get(data.bot);
              if (w) w.text += data.delta;
              renderWorking();
            } else if (event === 'member_tool') {
              const w = working.get(data.bot);
              if (w) w.tool = data.name;
              renderWorking();
            } else if (event === 'member_end') {
              working.delete(data.bot);
              renderWorking();
            } else if (event === 'error') toast(data.message || t('bots.failed'), 'error');
          },
        });
      } else {
        const chatId = chat?.chatId || (await api.botChat(target.id)).chatId;
        run.chatId = chatId;
        await api.sendMessage(chatId, text);
        if (here() && chat) {
          chat.messages.push({ role: 'user', text, createdAt: new Date().toISOString() });
          renderLog();
        }
        await runSolo(chatId, controller, here);
      }
    } catch (err) {
      if (!controller.signal.aborted) toast(err.message || t('bots.failed'), 'error');
    } finally {
      run = null;
      working.clear();
      renderWorking();
      renderSend();
      await loadTeam().catch(() => {});
      if (here()) await loadChat().catch(() => {});
      if (detailsOpen && here()) renderDetails();
    }
  }

  /** A bot's own chat, run; a step that needs the person's yes asks here, and goes on with the answer. */
  async function runSolo(chatId, controller, here, decision = undefined) {
    let live = null;
    let asking = null;
    await runBotChat({
      chatId,
      runId: crypto.randomUUID(),
      signal: controller.signal,
      decision,
      onEvent: (event, data) => {
        if (!here()) return;
        if (event === 'thinking') {
          live ||= addLive();
          live.thinking = true;
          paintLive(live);
        } else if (event === 'text') {
          live ||= addLive();
          live.text += data.delta || '';
          live.thinking = false;
          paintLive(live);
        } else if (event === 'tool_call') {
          live ||= addLive();
          live.tool = data.name;
          paintLive(live);
        } else if (event === 'approval_required') {
          asking = data.toolCalls || [];
        } else if (event === 'error') toast(data.message || t('bots.failed'), 'error');
      },
    });
    if (asking?.length && here() && !controller.signal.aborted) {
      const answer = await askYes(asking);
      await loadChat().catch(() => {});
      await runSolo(chatId, controller, here, { decision: answer, decisionFor: asking.map((c) => c.id) });
    }
  }

  function addLive() {
    const node = document.createElement('div');
    node.className = 'botlive';
    log.append(node);
    return { node, text: '', tool: '', thinking: false };
  }
  function paintLive(live) {
    live.node.innerHTML = `${live.thinking ? `<p class="botthinking">${escapeHtml(t('bots.thinking'))}</p>` : ''}${live.tool && !live.text ? `<p class="botstep">${escapeHtml(t('bots.used', { tool: live.tool }))}</p>` : ''}${live.text ? `<div class="botmsg botmsg--bot"><div class="botmsg__bubble">${escapeHtml(live.text)}</div></div>` : ''}`;
    log.scrollTop = log.scrollHeight;
  }

  /** A card under the conversation: what the bot wants to do, and Allow or Deny. */
  function askYes(calls) {
    return new Promise((resolve) => {
      const it = subject();
      const card = document.createElement('div');
      card.className = 'botask';
      card.setAttribute('role', 'group');
      card.innerHTML = `<p>${escapeHtml(t('bots.approval', { name: it?.name || '', what: calls.map((c) => c.name).join(', ') }))}</p>
        <div class="botask__acts"><button class="btn btn--primary btn--small" type="button" data-yes>${escapeHtml(t('bots.allow'))}</button><button class="btn btn--small" type="button" data-no>${escapeHtml(t('bots.deny'))}</button></div>`;
      log.append(card);
      log.scrollTop = log.scrollHeight;
      card.querySelector('[data-yes]')?.addEventListener('click', () => resolve('allow'));
      card.querySelector('[data-no]')?.addEventListener('click', () => resolve('deny'));
      /** @type {HTMLElement} */ (card.querySelector('[data-yes]')).focus();
    });
  }

  async function stopRun() {
    if (!run) return;
    const current = run;
    try {
      if (current.kind === 'group') await api.stopGroup(current.id);
      else if (current.chatId) await api.stopChat(current.chatId);
    } catch {
      /* hanging up below still ends what this tab shows */
    }
    current.controller.abort();
  }

  /* ── the @ picker ─────────────────────────────────────────────── */

  function closePicker() {
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
      .map((b, i) => `<div class="atpick__item${i === index ? ' is-on' : ''}" role="option" id="atpick-${i}" aria-selected="${i === index}" data-pick="${i}" style="--ink:${inkOf(b.avatar)}">${faceHtml(b.avatar, 22)}<span class="atpick__name">${escapeHtml(b.name)}</span>${b.role ? `<span class="atpick__role">${escapeHtml(b.role)}</span>` : ''}</div>`)
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
    input.focus();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }

  /* ── wiring ──────────────────────────────────────────────────── */

  input.addEventListener('input', () => {
    autosize();
    updatePicker();
  });
  input.addEventListener('keydown', (event) => {
    if (picker) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        picker.index = (picker.index + (event.key === 'ArrowDown' ? 1 : picker.items.length - 1)) % picker.items.length;
        const keep = picker.index;
        updatePicker();
        if (picker) picker.index = keep;
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(picker.index);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('click', updatePicker);
  input.addEventListener('blur', () => setTimeout(closePicker, 150));
  pickerBox.addEventListener('mousedown', (event) => {
    const item = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[data-pick]'));
    if (!item) return;
    event.preventDefault();
    pick(Number(item.dataset.pick));
  });

  page.querySelector('[data-composer]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });
  send.addEventListener('click', (event) => {
    if (send.classList.contains('is-stop')) {
      event.preventDefault();
      stopRun();
    }
  });

  const closeNewMenu = () => {
    newMenu.hidden = true;
    page.querySelector('[data-act="new"]')?.setAttribute('aria-expanded', 'false');
  };
  const refreshAll = async () => {
    await loadTeam();
    // Where the page was: on a phone, a change made in settings does not swap the list for the conversation.
    if (open) await openSubject(open.kind, open.id, { focus: false, chatting: page.classList.contains('is-chatting') || !matchMedia('(max-width: 760px)').matches });
  };
  const settingsDeps = () => ({ team, toast, onChanged: refreshAll, openSettings, openFeedback, openAutomations, models: () => (modelList ||= api.models({}).then((data) => [...(data.builtin || []), ...(data.models || [])].slice(0, 300))) });

  page.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const opener = /** @type {HTMLElement | null} */ (target.closest('[data-open]'));
    if (opener) {
      const [kind, id] = String(opener.dataset.open).split(':');
      openSubject(/** @type {'bot' | 'group'} */ (kind), id);
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
      await api.deleteBotMemory(open?.kind === 'group' ? 'bot-groups' : 'bots', open?.id, forgetBtn.dataset.forget).catch((err) => toast(err.message, 'error'));
      renderDetails();
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
    } else if (act === 'memory') {
      memoryOpen = !memoryOpen;
      renderDetails();
    } else if (act === 'stop') stopRun();
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

  page.addEventListener('submit', async (event) => {
    const form = /** @type {HTMLElement} */ (event.target);
    if (!form.matches('[data-memory-add]')) return;
    event.preventDefault();
    const field = /** @type {HTMLInputElement} */ (form.querySelector('[data-memory-text]'));
    const text = field.value.trim();
    if (!text || !open) return;
    try {
      await api.addBotMemory(open.kind === 'group' ? 'bot-groups' : 'bots', open.id, text);
      await renderDetails();
      /** @type {HTMLInputElement | null} */ (details.querySelector('[data-memory-text]'))?.focus();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  page.addEventListener('change', async (event) => {
    const select = /** @type {HTMLSelectElement} */ (event.target);
    if (!select.matches('[data-model]') || open?.kind !== 'bot') return;
    try {
      await api.updateBot(open.id, { model: select.value || null });
      await loadTeam();
      toast(t('bots.saved'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  page.addEventListener('keydown', (event) => {
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
        await loadTeam();
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
      page.hidden = true;
      closePicker();
      clearHash();
    },
    showing: () => shown,
  };
}
