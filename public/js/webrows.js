/**
 * One site the assistant searched or read, as a row: its icon, its title cut
 * to fit, and its domain — the same row in the web card of a reply and in the
 * side panel, so the two never disagree about what a result looks like.
 *
 * The link is the exact address the assistant used, never the site's
 * homepage: somebody pressing a row wants to see what was read. The icon comes
 * from this app's own server (`/api/favicon/:host`), so the browser never tells
 * a third party which sites a conversation touched; a site without one shows a
 * globe.
 */

import { escapeHtml } from './markdown.js';

const GLOBE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

/** The domain a person recognises: no "www.", no port, no path. */
export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** A readable stand-in title from an address: its last path segment, un-slugged. */
export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.(html?|php|aspx?|rss|xml)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s\d{5,}$/, '')
      .trim();
    return last || u.hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

/**
 * A title for a page the assistant read, from what the tool returned — or null,
 * and the row falls back to the address.
 *
 * A feed names itself ("Tin mới nhất - VnExpress RSS — 46 items"); a page's
 * text usually opens with its headline. Only the text inside the untrusted
 * envelope is looked at, and only a short line with letters in it counts.
 */
export function titleFromContent(tool, content) {
  const text = String(content || '');
  const inside = text.split(/<untrusted[^>]*>\n?/)[1] || '';
  const lines = inside.split('\n').map((l) => l.trim()).filter(Boolean);
  if (tool === 'read_feed') {
    const head = lines.find((l) => !l.startsWith('('));
    const name = head?.split(' — ')[0];
    return name && name.length <= 140 ? name : null;
  }
  if (tool === 'http_request') return null;
  const first = lines.find((l) => !/^[#[<(]/.test(l) && /\p{L}/u.test(l));
  return first && first.length <= 140 ? first : null;
}

/**
 * @param {{ url: string, title?: string, state?: 'read'|'failed'|'pending'|null }} hit
 * @returns {string} markup; everything in it is escaped
 */
export function webRowHtml({ url, title, state = null }) {
  const site = siteOf(url);
  const safe = /^https?:\/\//i.test(url) ? url : '#';
  const name = title || titleFromUrl(url);
  const icon = site
    ? `<img class="webrow__icon" src="/api/favicon/${encodeURIComponent(site)}" alt="" loading="lazy" decoding="async" data-fallback>`
    : '';
  return `<a class="webrow${state ? ` is-${state}` : ''}" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(`${name}\n${url}`)}">
    <span class="webrow__mark" aria-hidden="true">${icon}<span class="webrow__globe">${GLOBE}</span></span>
    <span class="webrow__title">${escapeHtml(name)}</span>
    <span class="webrow__site">${escapeHtml(site)}</span>
  </a>`;
}

/**
 * A missing icon shows the globe beneath it. One listener for the whole page,
 * because rows are drawn as markup and an inline handler would need a CSP hole.
 */
if (typeof document !== 'undefined') {
  document.addEventListener(
    'error',
    (event) => {
      const img = /** @type {HTMLElement} */ (event.target);
      if (img?.matches?.('img[data-fallback]')) img.closest('.webrow__mark')?.classList.add('is-bare');
    },
    true,
  );
}
