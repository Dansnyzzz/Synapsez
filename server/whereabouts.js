/**
 * Roughly where the person is: the city Vercel's edge places their connection
 * in, from headers it adds to every request on every plan (`x-vercel-ip-*`).
 *
 * For "find me somewhere to eat near me" and nothing else. It is read per
 * request and never stored; it reaches the model only inside the answer of a
 * nearby search that asked for it (place_lookup in tools/library.js), never in
 * the system prompt; and it is rounded to about a kilometre, because a city is
 * all an IP address honestly says — a mobile network can place someone in the
 * wrong district, and the answer says it is approximate.
 *
 * Elsewhere than Vercel the headers are absent and this is null: the tool then
 * asks the model to name a place. A client that sends the headers itself on a
 * local server only changes where its own search is centred.
 *
 * @param {Record<string, string | string[] | undefined>} [headers]
 * @returns {{ lat: number, lon: number, city: string, region: string, country: string } | null}
 */
export function approximateLocation(headers = {}) {
  const get = (name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const lat = Number(get('x-vercel-ip-latitude'));
  const lon = Number(get('x-vercel-ip-longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const text = (name, max) => {
    try {
      // Printable characters only: a header value is somebody else's text.
      return [...decodeURIComponent(String(get(name) || ''))].filter((ch) => ch >= ' ').join('').slice(0, max);
    } catch {
      return '';
    }
  };
  return {
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    city: text('x-vercel-ip-city', 80),
    region: text('x-vercel-ip-country-region', 20),
    country: text('x-vercel-ip-country', 2).toUpperCase(),
  };
}
