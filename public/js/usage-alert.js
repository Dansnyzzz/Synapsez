import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { localMoment } from './format.js';
import { knownLimits, decisiveLimits, alertFor } from './usage-math.js';
import { moreLink, limitName } from './usage-panel.js';

/**
 * Near a limit, a line above the composer, after Claude's "You've used 85% of
 * your weekly limit · resets Sun, Nov 1 at 12:00 PM · Get more usage · View
 * usage" (owner, 2026-10-31).
 *
 * From 80% of what the provider of the model in use goes by (usage-math.js
 * `decisiveLimits` and `alertFor`, the same two functions that provider's Usage page
 * reads), again at 90%, and at the limit: the key in use, so one key out of requests
 * beside others with plenty says nothing (owner, 2026-11-04), and not the Overview's
 * total, which can have plenty left on a provider this model cannot use (owner,
 * 2026-11-06). Closing it holds for the rest of that
 * limit's period, whatever level it reaches (UX-021, owner 2026-11-02): it came
 * back at the next send before. Remembered per account (PRV-019), so on a
 * shared browser one person's close is not another's.
 *
 * Held back while something already sits above the composer — a question card
 * or an approval (UX-020): pushed up under the line, a long question lost its
 * top. Shown again when that goes.
 *
 * Asked after every turn and as the app opens — the limits only
 * (`?part=limits`), and OpenRouter's answer is shared for a few seconds with
 * the Usage page (server/usageReport.js), so it costs next to nothing.
 *
 * @typedef {{ load: () => Promise<any>, providers: () => any, openUsage: () => void, openKeys: () => void,
 *   user: () => string | undefined, changed?: (freeOutUntil: Date | null) => void, modelProvider?: () => string | null }} Deps
 */

/** Before closes were kept per account; whose it was cannot be told, so it is dropped. */
const UNSCOPED = 'synapsez.usageAlert';
/** Asked at most this often unless something has just happened that moves a limit. */
const QUIET_MS = 20_000;

/** @param {HTMLElement} host @param {Deps} deps */
export function createUsageAlert(host, deps) {
  let shown = '';
  let askedAt = 0;
  /** @type {Promise<void> | null} */
  let asking = null;
  /** The last report drawn from, so a hold can lift without asking again. */
  let lastReport = null;
  let held = false;
  /**
   * When every OpenRouter key is out of today's free requests, the moment they come back (UX-024).
   * @type {Date | null}
   */
  let freeOutUntil = null;

  const storeKey = () => {
    const id = deps.user();
    return id ? `${UNSCOPED}:${id}` : null;
  };
  const remembered = () => {
    try {
      localStorage.removeItem(UNSCOPED);
      const key = storeKey();
      return key ? localStorage.getItem(key) || '' : '';
    } catch {
      return '';
    }
  };

  /** Draw it from a report — the composer's own ask, or the Usage page's. */
  function show(report) {
    lastReport = report;
    // Whether a free model can be sent to at all is a question about each key.
    const free = knownLimits(report, 'openrouter').filter((l) => l.kind === 'free');
    const wasOut = !!freeOutUntil;
    freeOutUntil = free.length && free.every((l) => l.used >= l.limit) ? free.map((l) => l.to).filter(Boolean).sort((a, b) => a.getTime() - b.getTime())[0] || null : null;
    if (wasOut !== !!freeOutUntil) deps.changed?.(freeOutUntil);
    const alert = alertFor(decisiveLimits(report, deps.modelProvider?.() || 'all'));
    // The limit and its period, not its level: a close lasts until the period ends (UX-021).
    const id = alert ? `${alert.limit.id}|${alert.limit.to ? alert.limit.to.toISOString() : ''}` : '';
    if (!alert || id === remembered() || held) {
      host.hidden = true;
      shown = '';
      return;
    }
    shown = id;
    const { limit, share, level } = alert;
    const name = limitName(limit, deps.providers(), (report.live?.[limit.provider || 'openrouter'] || []).length);
    // Floored, so 99.6% is not called 100% while there is still some left.
    const said = level === 'out' ? t('usage.alert.out', { limit: name }) : t('usage.alert.close', { pct: `${Math.floor(share * 100)}%`, limit: name });
    const resets = limit.to ? t('usage.alert.resets', { when: localMoment(limit.to) }) : '';
    const more =
      limit.kind === 'shared'
        ? `<button type="button" class="usage-alert__link" data-alert-keys>${escapeHtml(t('usage.addOwnKey'))}</button>`
        : `<a class="usage-alert__link" href="${moreLink(limit)}" target="_blank" rel="noopener">${escapeHtml(t('usage.getMore'))}</a>`;
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
        const key = storeKey();
        if (key) localStorage.setItem(key, shown);
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

  /** Held back while a question or an approval sits above the composer (UX-020); drawn again after. */
  function hold(on) {
    if (held === !!on) return;
    held = !!on;
    if (held) host.hidden = true;
    else if (lastReport) show(lastReport);
  }

  /**
   * When a free model cannot be sent to: every OpenRouter key has used today's
   * free requests (UX-024). The moment they come back, or null when they have not run out.
   *
   * @returns {Date | null}
   */
  const freeBlockedUntil = () => (freeOutUntil && freeOutUntil > new Date() ? freeOutUntil : null);

  return { show, refresh, hold, freeBlockedUntil };
}
