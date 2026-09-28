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
];

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

/** The picture at `value`, or null — off the list, not an image, or too large. */
export async function proxiedImage(value) {
  const url = allowedImageUrl(value);
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
