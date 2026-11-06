/**
 * What `world_facts` can look up beyond the time, the weather and a rate of exchange
 * (owner, 2026-11-05: "what else can it look up?"). Each is a free service with no key,
 * so there is nothing to set up, or something worked out here with no service at all.
 * Each answers in one short paragraph, because a model reads a number better than a
 * payload and a person reads the same words.
 */

/**
 * @param {string} name
 * @param {(url: string) => Promise<any>} getJson
 * @returns {Promise<{ name: string, latitude: number, longitude: number, timezone?: string, elevation?: number, population?: number, label: string }>}
 */
export async function geocode(name, getJson) {
  const wanted = String(name || '').trim();
  if (!wanted) throw new Error('Say which place — a city name, e.g. "Hanoi" or "Ho Chi Minh City".');
  const found = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(wanted)}`);
  const hit = found?.results?.[0];
  if (!hit) throw new Error(`No place called "${wanted}" was found. Try the city's English name, e.g. "Ho Chi Minh City".`);
  return { ...hit, label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ') };
}

const AIR_LEVELS = [
  [20, 'good'],
  [40, 'fair'],
  [60, 'moderate'],
  [80, 'poor'],
  [100, 'very poor'],
  [Infinity, 'extremely poor'],
];

export async function airQuality(location, getJson) {
  const place = await geocode(location, getJson);
  const data = await getJson(
    `https://air-quality-api.open-meteo.com/v1/air-quality?timezone=auto&latitude=${place.latitude}&longitude=${place.longitude}&current=european_aqi,us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,uv_index`,
  );
  const now = data?.current;
  if (!now) throw new Error(`No air quality reading for ${place.label}.`);
  const level = AIR_LEVELS.find(([top]) => Number(now.european_aqi) <= Number(top))?.[1];
  return `Air in ${place.label} at ${now.time} (local): European AQI ${now.european_aqi} (${level}), US AQI ${now.us_aqi}, PM2.5 ${now.pm2_5} µg/m³, PM10 ${now.pm10} µg/m³, ozone ${now.ozone} µg/m³, NO₂ ${now.nitrogen_dioxide} µg/m³, UV index ${now.uv_index}. Source: Open-Meteo.`;
}

const hhmm = (iso) => String(iso || '').slice(11, 16);

export async function sunTimes(location, date, getJson) {
  const place = await geocode(location, getJson);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null;
  const span = day ? `&start_date=${day}&end_date=${day}` : '&forecast_days=1';
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?timezone=auto&latitude=${place.latitude}&longitude=${place.longitude}&daily=sunrise,sunset,daylight_duration${span}`);
  const when = data?.daily;
  if (!when?.sunrise?.[0]) throw new Error(`No sunrise time for ${place.label}.`);
  const seconds = Number(when.daylight_duration?.[0]) || 0;
  return `${place.label} on ${when.time[0]}: sunrise ${hhmm(when.sunrise[0])}, sunset ${hhmm(when.sunset[0])} local time (${data.timezone}), ${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min of daylight. Source: Open-Meteo.`;
}

const SYNODIC_DAYS = 29.530588853;
// A new moon, 6 January 2000 18:14 UTC, to count from.
const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const PHASES = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous', 'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];

/** The moon by arithmetic: within about a day of the almanac, and it needs no service. */
export function moonPhase(date = new Date()) {
  const days = (date.getTime() - NEW_MOON_MS) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const lit = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2) * 100);
  const phase = PHASES[Math.round((age / SYNODIC_DAYS) * 8) % 8];
  const untilFull = (SYNODIC_DAYS / 2 - age + SYNODIC_DAYS) % SYNODIC_DAYS;
  const full = new Date(date.getTime() + untilFull * 86_400_000).toISOString().slice(0, 10);
  return `The moon on ${date.toISOString().slice(0, 10)}: ${phase}, ${lit}% lit, ${age.toFixed(1)} days old. Next full moon about ${full}. Worked out from the lunar cycle, so good to about a day.`;
}

export async function publicHolidays(country, year, getJson, now = new Date()) {
  const code = await countryCode(country, getJson);
  const when = Number(year) >= 1975 && Number(year) <= 2100 ? Number(year) : now.getUTCFullYear();
  const list = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${when}/${code}`);
  if (!Array.isArray(list) || !list.length) throw new Error(`No public holidays are listed for ${code} in ${when}.`);
  const today = now.toISOString().slice(0, 10);
  const lines = list.map((h) => `${h.date}${h.date >= today ? '' : ' (past)'}: ${h.localName}${h.name && h.name !== h.localName ? ` (${h.name})` : ''}`);
  return `Public holidays in ${code}, ${when}:\n${lines.join('\n')}\nSource: Nager.Date; lunar-calendar days and days a government adds by decree may be missing.`;
}

async function countryCode(country, getJson) {
  const said = String(country || '').trim();
  if (!said) throw new Error('Say which country, e.g. Vietnam or VN.');
  if (/^[A-Za-z]{2}$/.test(said)) return said.toUpperCase();
  const found = await getJson(`https://restcountries.com/v3.1/name/${encodeURIComponent(said)}?fields=cca2`);
  const code = Array.isArray(found) ? found[0]?.cca2 : null;
  if (!code) throw new Error(`No country called "${said}" was found. Try its English name.`);
  return code;
}

export async function countryFacts(country, getJson) {
  const said = String(country || '').trim();
  if (!said) throw new Error('Say which country, e.g. Vietnam or VN.');
  const fields = 'name,capital,population,area,region,subregion,languages,currencies,timezones,idd,tld,borders,car,cca2';
  const url = /^[A-Za-z]{2,3}$/.test(said) ? `https://restcountries.com/v3.1/alpha/${encodeURIComponent(said)}?fields=${fields}` : `https://restcountries.com/v3.1/name/${encodeURIComponent(said)}?fields=${fields}`;
  const found = await getJson(url);
  const c = Array.isArray(found) ? found[0] : found;
  if (!c?.name) throw new Error(`No country called "${said}" was found. Try its English name.`);
  const money = Object.entries(c.currencies || {}).map(([code, v]) => `${v?.name} (${code}${v?.symbol ? `, ${v.symbol}` : ''})`).join(', ');
  return (
    `${c.name.common} (${c.name.official}, ${c.cca2}): capital ${(c.capital || []).join(', ') || 'none'}, ` +
    `population ${Number(c.population).toLocaleString('en')}, area ${Number(c.area).toLocaleString('en')} km², ${[c.subregion, c.region].filter(Boolean).join(', ')}. ` +
    `Languages: ${Object.values(c.languages || {}).join(', ')}. Currency: ${money}. Time zones: ${(c.timezones || []).join(', ')}. ` +
    `Calling code: ${c.idd?.root || ''}${(c.idd?.suffixes || []).length === 1 ? c.idd.suffixes[0] : ''}. Internet: ${(c.tld || []).join(', ')}. Drives on the ${c.car?.side || 'unknown'}. Source: REST Countries.`
  );
}

export async function earthquakes(period, getJson) {
  const window = period === 'week' ? 'significant_week' : period === 'month' ? 'significant_month' : '4.5_day';
  const data = await getJson(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${window}.geojson`);
  const list = (data?.features || []).slice(0, 12);
  if (!list.length) return `USGS lists no ${period === 'week' || period === 'month' ? 'significant ' : 'magnitude 4.5+ '}earthquakes in that time.`;
  const lines = list.map((f) => `M${Number(f.properties.mag).toFixed(1)} ${f.properties.place} — ${new Date(f.properties.time).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  return `Earthquakes (${data?.metadata?.title || window}):\n${lines.join('\n')}\nSource: USGS.`;
}

export async function elevation(location, getJson) {
  const place = await geocode(location, getJson);
  return `${place.label} is at ${place.latitude}, ${place.longitude}, ${place.elevation ?? '?'} m above sea level, in the time zone ${place.timezone || '?'}, population ${Number(place.population || 0).toLocaleString('en') || '?'}. Source: Open-Meteo Geocoding.`;
}

/**
 * The time in a place, or a clock time in one place as it reads in another.
 *
 * @param {{ location?: string, timezone?: string, to?: string, at?: string }} ask
 * @param {(url: string) => Promise<any>} getJson
 * @param {Date} [now]
 */
export async function timeBetween({ location, timezone, to, at }, getJson, now = new Date()) {
  const zoneOf = async (where) => {
    const text = String(where || '').trim();
    if (!text) return null;
    if (/^[A-Za-z_]+\/[A-Za-z_+-]+/.test(text) || text === 'UTC') return { zone: text, label: text };
    const place = await geocode(text, getJson);
    return { zone: place.timezone, label: place.label };
  };
  const from = await zoneOf(location || timezone);
  const target = await zoneOf(to);
  if (!from && !target) throw new Error('Say which place or time zone.');
  const show = (date, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, dateStyle: 'full', timeStyle: 'short' }).format(date);
  if (!at || !from) {
    const place = from || target;
    return `In ${place.label} it is ${show(now, place.zone)} (${place.zone}).${from && target ? ` In ${target.label} it is ${show(now, target.zone)} (${target.zone}).` : ''}`;
  }
  const clock = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  if (!clock) throw new Error('Say the clock time as HH:MM, or YYYY-MM-DD HH:MM.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: from.zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-');
  const [year, month, day] = clock[1] ? [clock[1], clock[2], clock[3]] : today;
  // That clock time as if it were UTC, moved by how far the zone was from UTC at that moment.
  const asIf = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(clock[4]), Number(clock[5]));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: from.zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(asIf));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const moment = new Date(asIf - (shown - asIf));
  const there = target || { zone: 'UTC', label: 'UTC' };
  return `${show(moment, from.zone)} in ${from.label} is ${show(moment, there.zone)} in ${there.label}.`;
}
