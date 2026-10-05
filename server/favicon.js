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

/**
 * Suffixes that a registry, not a registrant, controls — the ones a site name
 * sits under in three labels rather than two. A fixed list, not a pattern: a
 * pattern such as "co.<country>" also matches names somebody can buy under a
 * permissive country code, and that somebody would get back the channel
 * `siteOf` exists to close. A suffix missing from here costs a wrong or absent
 * icon, never a longer name.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn', 'ac.vn', 'info.vn', 'biz.vn', 'name.vn', 'pro.vn', 'health.vn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ac.kr', 'go.kr', 'ne.kr', 're.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.tw', 'org.tw', 'edu.tw', 'gov.tw', 'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'edu.sg', 'gov.sg', 'org.sg', 'com.my', 'edu.my', 'gov.my', 'org.my',
  'co.id', 'ac.id', 'go.id', 'or.id', 'co.th', 'ac.th', 'go.th', 'in.th', 'or.th',
  'com.ph', 'edu.ph', 'gov.ph', 'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in',
  'co.nz', 'org.nz', 'ac.nz', 'govt.nz', 'co.za', 'org.za', 'ac.za', 'gov.za',
  'com.br', 'org.br', 'gov.br', 'edu.br', 'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'gob.ar', 'com.tr', 'org.tr', 'edu.tr', 'gov.tr', 'co.il', 'org.il', 'ac.il', 'gov.il',
  'com.ua', 'org.ua', 'gov.ua', 'com.pk', 'com.sa', 'gov.sa', 'com.eg', 'com.ng', 'co.ke',
]);

/**
 * The registrable name a host belongs to: `news.bbc.co.uk` → `bbc.co.uk`,
 * `anything.attacker.example` → `attacker.example`.
 *
 * The host reaching the icon route can be written by the model — a citation chip
 * draws the icon of whatever address a reply cites (public/js/markdown.js). Asking
 * for that exact host would make this server look up a name of the model's
 * choosing, and a name is a channel: a reply steered by a page could cite
 * `<the user's notes, encoded>.attacker.example`, and the lookup alone — no click,
 * nothing shown — would carry them out (SEC-034). The image proxy closes the same
 * channel with signatures (imageProxy.js); here it is closed by never asking for
 * more than the registrable name, which cannot hold data its owner did not
 * register. The icon is the site's own either way.
 */
export function siteOf(host) {
  const labels = String(host || '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const keep = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
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

/**
 * The icon for `host`'s site, or null when it has none that can be read. Only
 * the registrable name is ever fetched or cached — see `siteOf`.
 */
export async function faviconFor(requested) {
  const host = siteOf(requested);
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
