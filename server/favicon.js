import { safeFetch, readCapped } from './util/safeFetch.js';

/**
 * A site's own icon, fetched by this server rather than by the browser.
 *
 * The web card and the side panel show the icon of every site the assistant
 * searched or read. Asking a third party for them (a favicon service) would
 * hand it the list of sites every conversation touched, tied to the person's
 * address; asking the site from the browser would do the same to each site.
 * So the server asks, through `safeFetch` — public addresses only, every hop
 * checked — keeps a small cache, and the browser only ever talks to this app.
 *
 * `/favicon.ico` first, which nearly every site has; failing that, the icon the
 * homepage names in `<link rel="icon">`. Nothing found is remembered too, so a
 * site without one is not asked again on every render.
 */

const MAX_ICON_BYTES = 100 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_CACHED = 500;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

/** host → { type, data } | { miss: expiry } */
const cache = new Map();

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;

/** A bare hostname, or null — never a path, a port or an address the model could aim. */
export function cleanHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  // A name, not an address: safeFetch would refuse a private one anyway, but an
  // icon is only ever asked for by the name a page was reached at.
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  return HOST.test(host) ? host : null;
}

const ICONISH = /^image\/(x-icon|vnd\.microsoft\.icon|png|jpeg|gif|webp|svg\+xml)$/i;

async function fetchIcon(url) {
  const res = await safeFetch(url, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    res.body?.resume?.();
    return null;
  }
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
  const { buffer, truncated } = await readCapped(res, MAX_ICON_BYTES);
  if (truncated || !buffer.length) return null;
  // Some servers label an .ico as octet-stream; its magic bytes say what it is.
  const ico = buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0;
  if (ICONISH.test(type)) return { type, data: buffer };
  if (ico) return { type: 'image/x-icon', data: buffer };
  return null;
}

/** The icon the homepage names, as an absolute URL, or null. */
async function namedIcon(host) {
  const res = await safeFetch(new URL(`https://${host}/`), { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    res.body?.resume?.();
    return null;
  }
  const html = (await readCapped(res, MAX_PAGE_BYTES)).buffer.toString('utf8');
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/rel=["'][^"']*\bicon\b[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, '&'), `https://${host}/`);
      if (/^https?:$/.test(url.protocol)) return url;
    } catch {
      /* not an address */
    }
  }
  return null;
}

/** The icon for `host`, or null when it has none that can be read. */
export async function faviconFor(host) {
  const hit = cache.get(host);
  if (hit && (!hit.miss || hit.miss > Date.now())) return hit.miss ? null : hit;

  let icon = null;
  try {
    icon = await fetchIcon(new URL(`https://${host}/favicon.ico`));
    if (!icon) {
      const named = await namedIcon(host);
      if (named) icon = await fetchIcon(named);
    }
  } catch {
    icon = null;
  }

  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(host, icon || { miss: Date.now() + MISS_TTL_MS });
  return icon;
}

export const __testing = { cache };
