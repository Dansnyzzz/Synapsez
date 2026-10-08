/**
 * Roughly where the person is: the city Vercel's edge places their connection
 * in, from headers it adds to every request on every plan (`x-vercel-ip-*`).
 *
 * For "find me somewhere to eat near me" and nothing else. It is read per
 * request and never put in the system prompt. A nearby search that uses it
 * (place_lookup in tools/library.js) sends the rounded coordinates to
 * OpenStreetMap and keeps them out of everything it returns — the map is drawn
 * without a centre. What the answer does keep is the city's name and the
 * places found with their distances, and those stay in the conversation like
 * any other tool result: sent to the model, and in a share link if the
 * conversation is shared (privacy.html, section 2). Rounded to about a
 * kilometre, because a city is all an IP address honestly says — a mobile
 * network can place someone in the wrong district, and the answer says it is
 * approximate.
 *
 * Elsewhere than Vercel the headers are absent and this is null: the tool then
 * asks the model to name a place. A client that sends the headers itself on a
 * local server only changes where its own search is centred.
 *
 * @param {Record<string, string | string[] | undefined>} [headers]
 * @returns {{ lat: number, lon: number, city: string } | null}
 */
export function approximateLocation(headers = {}) {
  const get = (name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const lat = Number(get('x-vercel-ip-latitude'));
  const lon = Number(get('x-vercel-ip-longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  let city = '';
  try {
    // Printable characters only: a header value is somebody else's text.
    city = [...decodeURIComponent(String(get('x-vercel-ip-city') || ''))].filter((ch) => ch >= ' ').join('').slice(0, 80);
  } catch {
    city = '';
  }
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, city };
}
