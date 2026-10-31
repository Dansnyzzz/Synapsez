import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { knownLimits, alertFor } from './usage-math.js';
import { MORE, limitName } from './usage-panel.js';

/**
 * Near a limit, a line above the composer, after Claude's "You've used 85% of
 * your weekly limit · resets Sun, Nov 1 at 12:00 PM · Get more usage · View
 * usage" (owner, 2026-10-31).
 *
 * From 80% of the tightest limit the page knows (usage-math.js `alertFor`),
 * again at 90%, and at the limit; closing it holds until the next of those or
 * the next period. Asked after every turn and as the app opens — the limits
 * only (`?part=limits`), and OpenRouter's answer is shared for a few seconds
 * with the Usage page (server/usageReport.js), so it costs next to nothing.
 *
 * @typedef {{ load: () => Promise<any>, providers: () => any, openUsage: () => void, openKeys: () => void }} Deps
 */

const DISMISSED = 'synapsez.usageAlert';
/** Asked at most this often unless something has just happened that moves a limit. */
const QUIET_MS = 20_000;

const locale = () => (currentLanguage() === 'vi' ? 'vi-VN' : 'en-US');

/** @param {HTMLElement} host @param {Deps} deps */
export function createUsageAlert(host, deps) {
  let shown = '';
  let askedAt = 0;
  /** @type {Promise<void> | null} */
  let asking = null;

  const remembered = () => {
    try {
      return localStorage.getItem(DISMISSED) || '';
    } catch {
      return '';
    }
  };

  /** Draw it from a report — the composer's own ask, or the Usage page's. */
  function show(report) {
    const limits = knownLimits(report, 'all');
    const alert = alertFor(limits);
    const id = alert ? `${alert.limit.id}|${alert.level}|${alert.limit.to ? alert.limit.to.toISOString() : ''}` : '';
    if (!alert || id === remembered()) {
      host.hidden = true;
      shown = '';
      return;
    }
    shown = id;
    const { limit, share, level } = alert;
    const keys = (report.live?.openrouter || []).length;
    const name = limitName(limit, deps.providers(), keys);
    // Floored, so 99.6% is not called 100% while there is still some left.
    const said = level === 'out' ? t('usage.alert.out', { limit: name }) : t('usage.alert.close', { pct: `${Math.floor(share * 100)}%`, limit: name });
    const resets = limit.to ? t('usage.alert.resets', { when: new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(limit.to) }) : '';
    const more =
      limit.kind === 'shared'
        ? `<button type="button" class="usage-alert__link" data-alert-keys>${escapeHtml(t('usage.addOwnKey'))}</button>`
        : `<a class="usage-alert__link" href="${MORE[limit.kind]}" target="_blank" rel="noopener">${escapeHtml(t('usage.getMore'))}</a>`;
    host.className = `usage-alert${level === 'out' ? ' is-out' : ''}`;
    host.innerHTML = `<p class="usage-alert__text">${escapeHtml(said)}${resets ? ` · ${escapeHtml(resets)}` : ''} · ${more} · <button type="button" class="usage-alert__link" data-alert-usage>${escapeHtml(t('usage.alert.view'))}</button></p>
      <button type="button" class="usage-alert__close" data-alert-close aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button>`;
    host.hidden = false;
  }

  /**
   * Ask again. `soon` is for after a turn: what it spent is on the server by
   * then. Otherwise not more than every twenty seconds, and two at once are one.
   */
  function refresh({ soon = false } = {}) {
    if (asking) return asking;
    if (!soon && Date.now() - askedAt < QUIET_MS) return Promise.resolve();
    askedAt = Date.now();
    asking = deps
      .load()
      .then(show, () => {})
      .finally(() => {
        asking = null;
      });
    return asking;
  }

  host.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement} */ (event.target).closest('button, a');
    if (!el) return;
    if (el.hasAttribute('data-alert-close')) {
      try {
        localStorage.setItem(DISMISSED, shown);
      } catch {
        /* a private window: closed for now, back next time */
      }
      host.hidden = true;
    } else if (el.hasAttribute('data-alert-usage')) deps.openUsage();
    else if (el.hasAttribute('data-alert-keys')) deps.openKeys();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  return { show, refresh };
}
