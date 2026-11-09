import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
import { counted } from './format.js';

/**
 * The Bot page's own furniture (owner, 2026-11-08).
 *
 * Workflows and scheduled tasks were two rail items and two shelves; they are
 * one item, "Bot", and one page with the two as tabs. The shelf shell in
 * pages.js still draws each tab — this file holds what both tabs share and what
 * the rail needs: where the page is in the address bar, which tab was used
 * last, the status pill on every row, the ⋯ menu, and the count on the rail.
 *
 * Every value drawn here that came from a person or a model goes through
 * `escapeHtml`; the rest are the dictionary's own words.
 */

/** The tabs, in the order they are shown. Workflows first. */
export const BOT_TABS = /** @type {const} */ (['workflows', 'scheduled']);
export const isBotTab = (which) => BOT_TABS.includes(which);

const TAB_KEY = 'ai-remote:bot-tab';

/** The tab used last, or the first. Private browsing may refuse storage, which only costs the memory. */
export function lastBotTab() {
  try {
    const kept = localStorage.getItem(TAB_KEY);
    return isBotTab(kept) ? kept : BOT_TABS[0];
  } catch {
    return BOT_TABS[0];
  }
}

export function rememberBotTab(tab) {
  if (!isBotTab(tab)) return;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* remembered for this visit only */
  }
}

/**
 * Where the page is, in the address bar: `#bot/workflows`, `#bot/scheduled`,
 * and `#bot/<tab>/<id>` with that item open beside the list — so a reload, or
 * a link somebody sends, lands in the same place. Replaced, never pushed: Back
 * leaves the app as it always did rather than walking through every tab.
 */
const ID = /^[\w-]{1,80}$/;

/** @returns {{ tab: string, id: string | null } | null} */
export function readBotHash(hash = location.hash) {
  const m = /^#bot(?:\/([a-z]+))?(?:\/([^/?#]+))?$/.exec(String(hash || ''));
  if (!m) return null;
  const tab = isBotTab(m[1]) ? m[1] : lastBotTab();
  let id = null;
  try {
    id = m[2] && isBotTab(m[1]) ? decodeURIComponent(m[2]) : null;
  } catch {
    id = null;
  }
  return { tab, id: id && ID.test(id) ? id : null };
}

export function setBotHash(tab, id = null) {
  const hash = `#bot/${tab}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash === hash) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

/** Off the address bar once the page is left — only a hash this page put there. */
export function clearBotHash() {
  if (!location.hash.startsWith('#bot')) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
}

/** When a row runs next, on its own clock: "Mon 9 Nov, 08:00". */
export function whenText(iso, tz = null) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  const options = /** @type {Intl.DateTimeFormatOptions} */ ({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  try {
    return at.toLocaleString(localeTag(), tz ? { ...options, timeZone: tz } : options);
  } catch {
    return at.toLocaleString(localeTag(), options);
  }
}

/**
 * A row's state as pills: how the last run went, then what the schedule is
 * doing. Words, always — the colour only repeats what the word says, so the
 * row reads the same to somebody who cannot tell red from green.
 *
 * @param {import('./bot-status.js').BotState} state
 * @param {string | null} [tz]
 */
export function pillsHtml(state, tz = null) {
  const pill = (kind, text) => `<span class="botpill botpill--${kind}">${escapeHtml(text)}</span>`;
  const out = [];
  if (state.run === 'running') {
    out.push(pill('running', state.steps ? t('bot.pill.running', { step: state.step, steps: state.steps }) : t('bot.pill.runningNow')));
  } else if (state.run === 'needs') out.push(pill('needs', t('bot.pill.needs')));
  else if (state.run === 'failed') out.push(pill('failed', t('bot.pill.failed')));
  else if (state.run === 'stopped') out.push(pill('stopped', t('bot.pill.stopped')));

  if (state.plan === 'overdue') out.push(pill('overdue', t('bot.pill.overdue')));
  else if (state.plan === 'paused') out.push(pill('paused', t('bot.pill.paused')));
  else if (state.plan === 'manual') out.push(pill('manual', t('bot.pill.manual')));
  else if (state.next) out.push(pill('next', t('bot.pill.next', { when: whenText(state.next, tz) })));
  return `<span class="botpills">${out.join('')}</span>`;
}

/** The ⋯ button on a row; its menu is `openRowMenu`. */
export const moreButtonHtml = (id, name) =>
  `<button class="icon-btn botrow__more" type="button" data-more="${escapeHtml(id)}" aria-haspopup="menu" aria-expanded="false"
           title="${escapeHtml(t('bot.more', { name }))}" aria-label="${escapeHtml(t('bot.more', { name }))}">⋯</button>`;

/**
 * Edit, History, and Delete — the last needs a second press within three seconds,
 * on the item itself, so a slip of the finger on a phone deletes nothing.
 *
 * @param {HTMLElement} anchor
 * @param {{ edit: () => void, history: () => void, remove: () => Promise<void> | void }} actions
 */
export function openRowMenu(anchor, actions) {
  openMenu(anchor, [
    { label: t('pages.tasks.edit'), icon: '✎', run: actions.edit },
    { label: t('bot.history'), icon: '↺', run: actions.history },
    null,
    { label: t('bot.delete'), icon: '🗑', danger: true, confirm: t('bot.deleteConfirm'), run: actions.remove },
  ]);
}

/**
 * The tab labels — "Workflows · 3" — and a dot on a tab that holds something
 * needing the person, said in words for a screen reader as well.
 *
 * @param {HTMLElement} host  the tablist
 * @param {{ workflows?: { count: number, attention: number }, scheduled?: { count: number, attention: number } } | null} summary
 * @param {string} active
 */
export function paintBotTabs(host, summary, active) {
  for (const tab of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-bot-tab]'))) {
    const which = tab.dataset.botTab;
    const on = which === active;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const part = summary?.[which];
    /** @type {HTMLElement} */ (tab.querySelector('[data-bot-count]')).textContent = part ? ` · ${part.count}` : '';
    const needs = Number(part?.attention) || 0;
    /** @type {HTMLElement} */ (tab.querySelector('.bot__dot')).hidden = !needs;
    /** @type {HTMLElement} */ (tab.querySelector('[data-bot-needs]')).textContent = needs ? `, ${counted(needs, 'bot.needYou')}` : '';
  }
}

/**
 * The count on the rail's Bot item: what failed, waits for the person, or is
 * overdue, across both tabs.
 *
 * No timer of its own. It is asked at start, when the tab comes back, when a
 * task or workflow changes, and when the conversation list's own poll sees a
 * run start or end (`nudge`) — and at most every few minutes otherwise, on that
 * same poll, so an overdue task is noticed without a second clock ticking.
 *
 * @param {{ api: { botSummary: () => Promise<any> }, button: HTMLElement, badge: HTMLElement }} wiring
 */
export function createBotBadge({ api, button, badge }) {
  const STALE_MS = 5 * 60_000;
  let last = null;
  let fetchedAt = 0;
  let running = null;
  let inFlight = null;

  function paint(summary = null) {
    if (summary) last = summary;
    const n = Number(last?.attention) || 0;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
    if (n) {
      const say = counted(n, 'bot.needYou');
      badge.setAttribute('aria-label', say);
      // The button's own name, so it is "Bot — 2 need you" even in the folded
      // rail, where the visible label is not drawn at all.
      button.setAttribute('aria-label', t('bot.railNeeds', { needs: say }));
      button.title = t('bot.railNeeds', { needs: say });
    } else {
      badge.removeAttribute('aria-label');
      button.removeAttribute('aria-label');
      button.title = t('nav.bot');
    }
  }

  function refresh() {
    inFlight ||= api
      .botSummary()
      .then((summary) => {
        fetchedAt = Date.now();
        paint(summary);
        return summary;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** @param {Array<{ id: string, running?: boolean }>} chats  the conversation list just fetched */
  function nudge(chats = []) {
    paint();
    const now = chats.filter((chat) => chat.running).map((chat) => chat.id).sort().join(',');
    if (now !== running || Date.now() - fetchedAt > STALE_MS) {
      running = now;
      refresh();
    }
  }

  return { paint, refresh, nudge };
}
