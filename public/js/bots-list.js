import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { faceHtml, inkOf } from './bot-avatar.js';
import { describeStep } from './render.js';

/*
 * The Bot page's list, said in markup (spec B.2, B.3): its order, its rows' marks, the
 * "Needs you" strip above them, the row menu, and the strip of who a group's message
 * called. Pure: the page (bots.js) owns the state and the events.
 */

/**
 * Pinned first, then whoever spoke last (spec B.3). Chief is not in the rows: it has its
 * own place at the top.
 *
 * @param {{ bots: any[], groups: any[] }} team
 * @returns {Array<{ kind: 'bot' | 'group', item: any }>}
 */
export function sortRows(team) {
  const rows = [
    ...team.groups.map((g) => ({ kind: /** @type {const} */ ('group'), item: g })),
    ...team.bots.filter((b) => !b.main).map((b) => ({ kind: /** @type {const} */ ('bot'), item: b })),
  ];
  const time = (r) => new Date(r.item.at).getTime() || 0;
  return rows.sort((a, b) => Number(!!b.item.pinned) - Number(!!a.item.pinned) || time(b) - time(a));
}

/** The rows the Needs-you list names, as "bot:<id>" and "group:<id>" — a group's item marks the group. */
export function needsKeys(items) {
  const keys = new Set();
  for (const i of items || []) {
    if (i.group) keys.add(`group:${i.group}`);
    else if (i.bot) keys.add(`bot:${i.bot}`);
  }
  return keys;
}

/** The marks at a row's end: at work, wanted by the person, unread — in that order of weight. */
export function rowMarks(item, { needed = false, busy = '' } = {}) {
  const marks = [];
  if (item.running) marks.push(busy);
  if (needed) marks.push(`<span class="botmark botmark--needs" role="img" aria-label="${escapeHtml(t('bots.needsMark'))}" title="${escapeHtml(t('bots.needsMark'))}"></span>`);
  else if (item.unread) marks.push(`<span class="botmark botmark--unread" role="img" aria-label="${escapeHtml(t('bots.unread'))}" title="${escapeHtml(t('bots.unread'))}"></span>`);
  return marks.join('');
}

/**
 * One line of "Needs you": whose face, what it says, and what its button does.
 *
 * @param {any} item  a row of GET /bots/attention
 * @param {{ botOf: (id: string) => any, groupOf: (id: string) => any }} lookups
 * @returns {{ face: any, faceKind: 'bot' | 'group', text: string, action: 'answer' | 'view' | 'continue' | 'retry', label: string, open: string } | null}
 */
export function needLine(item, { botOf, groupOf }) {
  const bot = item.bot ? botOf(item.bot) : null;
  const group = item.group ? groupOf(item.group) : null;
  const said = String(item.text || '').replace(/\s+/g, ' ').trim();
  if (item.kind === 'question' && group) {
    return { face: bot || group, faceKind: bot ? 'bot' : 'group', text: t('bots.needs.askGroup', { bot: bot?.name || '', group: group.name, text: said }), action: 'answer', label: t('bots.needs.answer'), open: `group:${group.id}` };
  }
  if (item.kind === 'question' && bot) return { face: bot, faceKind: 'bot', text: t('bots.needs.askBot', { bot: bot.name, text: said }), action: 'answer', label: t('bots.needs.answer'), open: `bot:${bot.id}` };
  if (item.kind === 'approval' && bot) return { face: bot, faceKind: 'bot', text: t('bots.needs.approval', { bot: bot.name, text: said }), action: 'view', label: t('bots.needs.view'), open: `bot:${bot.id}` };
  if (item.kind === 'ceiling' && group) return { face: group, faceKind: 'group', text: t('bots.needs.ceiling', { group: group.name }), action: 'continue', label: t('bots.continue'), open: `group:${group.id}` };
  if (item.kind === 'failed' && (bot || group)) {
    return {
      face: group || bot,
      faceKind: group ? 'group' : 'bot',
      text: t('bots.needs.failed', { task: said, reason: String(item.reason || '').replace(/\s+/g, ' ').trim() || t('bots.needs.noReason') }),
      action: 'retry',
      label: t('bots.needs.retry'),
      open: group ? `group:${group.id}` : `bot:${bot.id}`,
    };
  }
  return null;
}

/**
 * The strip above the rows (spec B.2): shown only when something waits, one row each,
 * the count in its heading equal to its rows.
 *
 * @param {any[]} items @param {{ botOf: (id: string) => any, groupOf: (id: string) => any, groupFaces: (g: any) => string }} lookups
 */
export function needsHtml(items, { botOf, groupOf, groupFaces }) {
  const lines = (items || []).map((item, i) => ({ i, line: needLine(item, { botOf, groupOf }) })).filter((x) => x.line);
  if (!lines.length) return '';
  const rows = lines
    .map(({ i, line }) => {
      const face = line.faceKind === 'group' ? groupFaces(line.face) : faceHtml(line.face, 26);
      return `<li class="botneed botneed--${line.action}">
        <button class="botneed__open" type="button" data-open="${escapeHtml(line.open)}">${face}<span class="botneed__text">${escapeHtml(line.text)}</span></button>
        <button class="btn btn--small botneed__act" type="button" data-need="${i}">${escapeHtml(line.label)}</button>
      </li>`;
    })
    .join('');
  return `<section class="botneeds" aria-labelledby="botneeds-title">
    <h2 class="botneeds__title" id="botneeds-title">${escapeHtml(t('bots.needs.title'))} <span class="botneeds__n">${lines.length}</span></h2>
    <ul class="botneeds__rows">${rows}</ul>
  </section>`;
}

/**
 * The row menu's items for a bot or a group (spec B.3): Open, Settings, Pin, Pause,
 * Duplicate, Export, Delete — what does not apply is left out (Chief is never paused,
 * copied or deleted; a group is neither paused nor copied).
 *
 * @param {'bot' | 'group'} kind @param {any} item
 */
export function menuItems(kind, item) {
  const items = [
    { act: 'open', label: t('bots.menu.open') },
    { act: 'settings', label: t('bots.menu.settings') },
  ];
  if (!(kind === 'bot' && item.main)) items.push({ act: item.pinned ? 'unpin' : 'pin', label: t(item.pinned ? 'bots.menu.unpin' : 'bots.menu.pin') });
  if (kind === 'bot' && !item.main) {
    items.push({ act: item.paused ? 'resume' : 'pause', label: t(item.paused ? 'bots.menu.resume' : 'bots.menu.pause') });
    items.push({ act: 'duplicate', label: t('bots.menu.duplicate') });
  }
  items.push({ act: 'export', label: t('bots.menu.export') });
  if (!(kind === 'bot' && item.main)) items.push({ act: 'delete', label: t('bots.menu.delete'), danger: true });
  return items;
}

/** @param {'bot' | 'group'} kind @param {any} item */
export function menuHtml(kind, item) {
  return menuItems(kind, item)
    .map((m) => `<button type="button" role="menuitem" tabindex="-1" data-row-act="${m.act}"${m.danger ? ' class="is-danger"' : ''}>${escapeHtml(m.label)}</button>`)
    .join('');
}

/** What a member's state says in the strip. */
const STATE_KEYS = Object.freeze({ called: 'bots.called.called', working: 'bots.called.working', answered: 'bots.called.answered', passed: 'bots.called.passed', failed: 'bots.called.failed', paused: 'bots.called.paused', waiting: 'bots.called.waiting' });

/**
 * Who the person's message called in a running group, and how each is doing (spec B.3):
 * called → working (its step in the home transcript's words) → answered, passed, failed.
 *
 * @param {Array<{ bot: string, how: string }>} called @param {Map<string, { tool?: string }>} working
 * @param {(id: string) => any} botOf
 */
export function calledHtml(called, working, botOf) {
  const chips = (called || [])
    .map((c) => {
      const bot = botOf(c.bot);
      if (!bot) return '';
      const live = working.get(c.bot);
      const how = live ? 'working' : STATE_KEYS[c.how] ? c.how : 'called';
      const step = live?.tool ? describeStep(live.tool, {}).verb : '';
      const said = how === 'working' && step ? step : t(STATE_KEYS[how]);
      return `<li class="botcalled__chip botcalled__chip--${how}" style="--ink:${inkOf(bot)}">${how === 'working' ? '<span class="spinner" aria-hidden="true"></span>' : ''}${faceHtml(bot, 18)}<span class="botcalled__name">${escapeHtml(bot.name)}</span><span class="botcalled__how">${escapeHtml(said)}</span></li>`;
    })
    .filter(Boolean)
    .join('');
  return chips ? `<ul class="botcalled" aria-label="${escapeHtml(t('bots.called.label'))}">${chips}</ul>` : '';
}
