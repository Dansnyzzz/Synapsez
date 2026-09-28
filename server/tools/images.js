import { untrusted } from './untrusted.js';
import { allowedImageUrl } from '../imageProxy.js';

/**
 * Find pictures on the web, and show them.
 *
 * Openverse first — WordPress's index of openly licensed images, hundreds of
 * millions of them from Flickr, Wikimedia and museum collections — then
 * Wikimedia Commons directly when Openverse has nothing. Both free, neither
 * needs a key. They are openly licensed collections rather than the whole web,
 * which is a real limit (no product photos, few news pictures) and also the
 * reason every result can be shown and reused with a licence beside it.
 *
 * The browser never fetches these pictures itself: each thumbnail is sent
 * through `/api/image`, which only accepts the hosts these two services serve
 * from (see imageProxy.js).
 */

const UA = 'Synapsez/1.0 (+https://synapsez.vercel.app)';
const MAX_RESULTS = 12;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}.`);
  return res.json();
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** One result, or null when it has no picture this app is allowed to show. */
export function openverseItem(r) {
  const thumb = allowedImageUrl(r?.thumbnail) ? r.thumbnail : allowedImageUrl(r?.url) ? r.url : null;
  if (!thumb) return null;
  return {
    thumb,
    title: stripTags(r.title) || 'Untitled',
    page: r.foreign_landing_url || r.url || '',
    creator: stripTags(r.creator),
    license: [r.license ? `CC ${String(r.license).toUpperCase()}` : '', r.license_version || ''].filter(Boolean).join(' '),
    width: Number(r.width) || null,
    height: Number(r.height) || null,
    provider: r.source || r.provider || 'openverse',
  };
}

async function fromOpenverse(query, count) {
  const data = await getJson(
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${count}&mature=false`,
  );
  return (data?.results || []).map(openverseItem).filter(Boolean);
}

export function commonsItem(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const thumb = allowedImageUrl(info.thumburl) ? info.thumburl : null;
  if (!thumb) return null;
  const meta = info.extmetadata || {};
  return {
    thumb,
    title: String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
    page: info.descriptionurl || '',
    creator: stripTags(meta.Artist?.value),
    license: stripTags(meta.LicenseShortName?.value),
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    provider: 'wikimedia',
  };
}

async function fromCommons(query, count) {
  const data = await getJson(
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6' +
      `&gsrlimit=${count}&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}` +
      '&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=480',
  );
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map(commonsItem).filter(Boolean);
}

/** @param {{ query?: string, count?: number }} input */
export async function imageSearchTool({ query, count }) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Say what to look for, e.g. "Ha Long Bay at sunset".');
  const n = Math.min(MAX_RESULTS, Math.max(1, Number(count) || 8));

  let items = await fromOpenverse(text, n).catch(() => []);
  if (!items.length) items = await fromCommons(text, n).catch(() => []);
  if (!items.length) {
    return `No openly licensed pictures of "${text}" were found. Try fewer or English words — or web_search for pages that show it.`;
  }

  const listing = items
    .map((it, i) => `${i + 1}. ${it.title}${it.creator ? ` — ${it.creator}` : ''}${it.license ? ` (${it.license})` : ''} ${it.page}`)
    .join('\n');
  return {
    content:
      untrusted('image search', listing) +
      `\n${items.length} pictures are shown to the user as a gallery; each opens its source page. ` +
      'Refer to them by number if it helps; do not paste the links again.',
    widget: { kind: 'images', title: text, images: items },
  };
}
