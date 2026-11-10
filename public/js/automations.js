import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
import { counted } from './format.js';

/**
 * The Automations page's own furniture (owner, 2026-11-08).
 *
 * Workflows and scheduled tasks were two rail items and two shelves; they are
 * one item and one page with the two as tabs. It was called "Bot" for a day; a
 * Bot is a different thing (bots.js), so since 2026-11-09 this page is
 * "Automations", under the clock the Scheduled item used to wear. The shelf shell in
 * pages.js still draws each tab — this file holds what both tabs share and what
 * the rail needs: where the page is in the address bar, which tab was used
 * last, the status pill on every row, the ⋯ menu, and the count on the rail.
 *
 * Every value drawn here that came from a person or a model goes through
 * `escapeHtml`; the rest are the dictionary's own words.
 */

/** The tabs, in the order they are shown. Workflows first. */
export const AUTO_TABS = /** @type {const} */ (['workflows', 'scheduled']);
export const isAutoTab = (which) => AUTO_TABS.includes(which);

/** Kept from when the page was "Bot", so the tab remembered then is still the one opened. */
const TAB_KEY = 'ai-remote:bot-tab';

/** The tab used last, or the first. Private browsing may refuse storage, which only costs the memory. */
export function lastAutoTab() {
  try {
    const kept = localStorage.getItem(TAB_KEY);
    return isAutoTab(kept) ? kept : AUTO_TABS[0];
  } catch {
    return AUTO_TABS[0];
  }
}

export function rememberAutoTab(tab) {
  if (!isAutoTab(tab)) return;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* remembered for this visit only */
  }
}

/**
 * Where the page is, in the address bar: `#automations/workflows`,
 * `#automations/scheduled`, and `#automations/<tab>/<id>` with that item open
 * beside the list — so a reload, or a link somebody sends, lands in the same
 * place. Replaced, never pushed: Back leaves the app as it always did rather than
 * walking through every tab.
 *
 * A link from when the page was "Bot" — `#bot/workflows…`, `#bot/scheduled…` —
 * still lands on the same tab and item. A bare `#bot` is the Bot page now
 * (bots.js), so only those two tabs are read as this page's.
 */
const ID = /^[\w-]{1,80}$/;
const LEGACY = /^#bot\/(workflows|scheduled)(?:\/([^/?#]+))?$/;

/** @returns {{ tab: string, id: string | null } | null} */
export function readAutoHash(hash = location.hash) {
  const text = String(hash || '');
  const m = /^#automations(?:\/([a-z]+))?(?:\/([^/?#]+))?$/.exec(text) || LEGACY.exec(text);
  if (!m) return null;
  const tab = isAutoTab(m[1]) ? m[1] : lastAutoTab();
  let id = null;
  try {
    id = m[2] && isAutoTab(m[1]) ? decodeURIComponent(m[2]) : null;
  } catch {
    id = null;
  }
  return { tab, id: id && ID.test(id) ? id : null };
}

export function setAutoHash(tab, id = null) {
  const hash = `#automations/${tab}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash === hash) return;
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
}

/** Off the address bar once the page is left — only a hash this page put there. */
export function clearAutoHash() {
  if (!location.hash.startsWith('#automations') && !LEGACY.test(location.hash)) return;
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
 * @param {import('./automation-status.js').AutoState} state
 * @param {string | null} [tz]
 */
export function pillsHtml(state, tz = null) {
  const pill = (kind, text) => `<span class="autopill autopill--${kind}">${escapeHtml(text)}</span>`;
  const out = [];
  if (state.run === 'running') {
    out.push(pill('running', state.steps ? t('auto.pill.running', { step: state.step, steps: state.steps }) : t('auto.pill.runningNow')));
  } else if (state.run === 'needs') out.push(pill('needs', t('auto.pill.needs')));
  else if (state.run === 'failed') out.push(pill('failed', t('auto.pill.failed')));
  else if (state.run === 'stopped') out.push(pill('stopped', t('auto.pill.stopped')));

  if (state.plan === 'overdue') out.push(pill('overdue', t('auto.pill.overdue')));
  else if (state.plan === 'paused') out.push(pill('paused', t('auto.pill.paused')));
  else if (state.plan === 'manual') out.push(pill('manual', t('auto.pill.manual')));
  else if (state.next) out.push(pill('next', t('auto.pill.next', { when: whenText(state.next, tz) })));
  return `<span class="autopills">${out.join('')}</span>`;
}

/** The ⋯ button on a row; its menu is `openRowMenu`. */
export const moreButtonHtml = (id, name) =>
  `<button class="icon-btn autorow__more" type="button" data-more="${escapeHtml(id)}" aria-haspopup="menu" aria-expanded="false"
           title="${escapeHtml(t('auto.more', { name }))}" aria-label="${escapeHtml(t('auto.more', { name }))}">⋯</button>`;

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
    { label: t('auto.history'), icon: '↺', run: actions.history },
    null,
    { label: t('auto.delete'), icon: '🗑', danger: true, confirm: t('auto.deleteConfirm'), run: actions.remove },
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
export function paintAutoTabs(host, summary, active) {
  for (const tab of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-auto-tab]'))) {
    const which = tab.dataset.autoTab;
    const on = which === active;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const part = summary?.[which];
    /** @type {HTMLElement} */ (tab.querySelector('[data-auto-count]')).textContent = part ? ` · ${part.count}` : '';
    const needs = Number(part?.attention) || 0;
    /** @type {HTMLElement} */ (tab.querySelector('.auto__dot')).hidden = !needs;
    /** @type {HTMLElement} */ (tab.querySelector('[data-auto-needs]')).textContent = needs ? `, ${counted(needs, 'auto.needYou')}` : '';
  }
}

/**
 * The count on the rail's Automations item: what failed, waits for the person, or is
 * overdue, across both tabs.
 *
 * No timer of its own. It is asked at start, when the tab comes back, when a
 * task or workflow changes, and when the conversation list's own poll sees a
 * run start or end (`nudge`) — and at most every few minutes otherwise, on that
 * same poll, so an overdue task is noticed without a second clock ticking.
 *
 * @param {{ api: { autoSummary: () => Promise<any> }, button: HTMLElement, badge: HTMLElement }} wiring
 */
export function createAutoBadge({ api, button, badge }) {
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
      const say = counted(n, 'auto.needYou');
      badge.setAttribute('aria-label', say);
      // The button's own name, so it is "Automations — 2 need you" even in the folded
      // rail, where the visible label is not drawn at all.
      button.setAttribute('aria-label', t('auto.railNeeds', { needs: say }));
      button.title = t('auto.railNeeds', { needs: say });
    } else {
      badge.removeAttribute('aria-label');
      button.removeAttribute('aria-label');
      button.title = t('nav.automations');
    }
  }

  function refresh() {
    inFlight ||= api
      .autoSummary()
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
