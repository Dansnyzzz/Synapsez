import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { safeFetch, readCapped } from '../util/safeFetch.js';
import { validZone } from '../util/zone.js';
import { getStore } from '../store/index.js';
import { saveGenerated } from '../attachments.js';
import { untrusted } from './untrusted.js';
import { solarToLunar, lunarToSolar, yearName, dayName } from './lunar.js';

/**
 * The everyday toolbox: the questions people ask that a model should answer
 * from a lookup or a calculation rather than from memory.
 *
 * Every one of these is deferred (see `DEFERRABLE` in definitions.js), so a
 * turn that never needs them pays one line each in `load_tools`, not a schema.
 * Every outside service is free and needs no key — nothing here has a setting
 * to get wrong — and every reply that carries somebody else's text goes through
 * `untrusted`, the same as a web page.
 *
 * Kept out of cloud.js, which is already the size where one more thing in it is
 * a reason not to read it.
 */

const UA = 'Synapsez/1.0 (+https://synapsez.vercel.app)';

/** JSON from a fixed public service, with a timeout and a readable failure. */
async function getJson(url, headers = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}.`);
  return res.json();
}

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 6 }) : String(n));

/* ── dates ─────────────────────────────────────────────────────── */

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

/** "2026-09-27", "27/09/2026" or "27-9-2026" → a UTC midnight Date. */
export function parseDay(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return utcDay(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return utcDay(+m[3], +m[2], +m[1]);
  if (/^today$|^hôm nay$/i.test(s) || !s) {
    const now = new Date();
    return utcDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  }
  throw new Error(`"${s}" is not a date. Write it as YYYY-MM-DD or DD/MM/YYYY.`);
}

function utcDay(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) throw new Error(`${d}/${mo}/${y} is not a real date.`);
  return date;
}

const iso = (date) => date.toISOString().slice(0, 10);
const dmy = (date) => `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`;

/** Monday–Friday days from `a` up to but not including `b`. */
function businessDays(a, b) {
  const step = a <= b ? 1 : -1;
  let n = 0;
  for (let t = a.getTime(); step > 0 ? t < b.getTime() : t > b.getTime(); t += step * DAY_MS) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) n += step;
  }
  return n;
}

/** ISO 8601 week number. */
function isoWeek(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
}

const lunarLine = (date) => {
  const l = solarToLunar(date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear());
  return `lunar ${l.day}/${l.month}${l.leap ? ' (leap month)' : ''}/${l.year}, year ${yearName(l.year)}, day ${dayName(date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear())}`;
};

/** A clock time in one zone, as the instant it is, read in another. */
export function convertTime(when, fromZone, toZone) {
  if (!validZone(fromZone) || !validZone(toZone)) throw new Error('Both zones must be IANA names, e.g. "Asia/Ho_Chi_Minh", "Europe/London".');
  const m = String(when || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('Give the time as "YYYY-MM-DD HH:MM".');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  // Guess the instant as if the wall clock were UTC, then correct by the zone's
  // offset at that instant — twice, which settles across a DST change.
  let instant = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i += 1) instant = Date.UTC(y, mo - 1, d, h, mi) - offsetMs(new Date(instant), fromZone);
  const say = (zone) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant));
  return `${say(fromZone)} in ${fromZone} is ${say(toZone)} in ${toZone}.`;
}

function offsetMs(date, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime();
}

/**
 * Vietnam's public holidays for a year.
 *
 * Nager.Date has the solar ones and not the lunar ones, which are the ones that
 * matter most — Tết and the Hùng Kings' day move every year. Those two are
 * computed here from the lunar calendar, so the list is whole.
 */
async function holidays(country, year) {
  const code = String(country || 'VN').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('Country is a two-letter code, e.g. VN, US, JP.');
  const list = (await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${code}`)).map((h) => ({
    date: h.date,
    name: h.localName && h.localName !== h.name ? `${h.localName} (${h.name})` : h.name,
  }));
  if (code === 'VN') {
    const lunar = (d, m) => {
      const s = lunarToSolar(d, m, year);
      return s ? iso(utcDay(s[2], s[1], s[0])) : null;
    };
    const eve = lunarToSolar(1, 1, year);
    const tet = eve ? utcDay(eve[2], eve[1], eve[0]) : null;
    if (tet) {
      list.push({ date: iso(new Date(tet.getTime() - DAY_MS)), name: 'Giao thừa — Tết holiday begins (usually 5+ days off)' });
      for (let i = 0; i < 4; i += 1) list.push({ date: iso(new Date(tet.getTime() + i * DAY_MS)), name: `Tết Nguyên Đán, day ${i + 1} (Lunar New Year, ${yearName(year)})` });
    }
    const hung = lunar(10, 3);
    if (hung) list.push({ date: hung, name: 'Giỗ Tổ Hùng Vương (Hùng Kings\' Commemoration)' });
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  return (
    `Public holidays in ${code}, ${year}:\n` +
    list.map((h) => `- ${h.date} (${WEEKDAY[new Date(`${h.date}T00:00:00Z`).getUTCDay()]}): ${h.name}`).join('\n') +
    `\nSource: date.nager.at${code === 'VN' ? '; Tết and Giỗ Tổ computed from the lunar calendar. The government sets the exact days off each year' : ''}.`
  );
}

async function dateCalcTool({ op, date, to, days, months, time, from_zone: fromZone, to_zone: toZone, lunar_day: lDay, lunar_month: lMonth, lunar_year: lYear, leap, country, year }) {
  switch (op) {
    case 'diff': {
      const a = parseDay(date);
      const b = parseDay(to);
      const total = Math.round((b.getTime() - a.getTime()) / DAY_MS);
      return `From ${iso(a)} to ${iso(b)}: ${total} days (${round(total / 7, 1)} weeks, about ${round(total / 30.4375, 1)} months), ${businessDays(a, b)} of them Monday–Friday.`;
    }
    case 'add': {
      const a = parseDay(date);
      const out = new Date(a);
      if (months) out.setUTCMonth(out.getUTCMonth() + Number(months));
      out.setUTCDate(out.getUTCDate() + (Number(days) || 0));
      return `${iso(a)} ${months ? `+ ${months} month(s) ` : ''}+ ${Number(days) || 0} day(s) = ${iso(out)}, a ${WEEKDAY[out.getUTCDay()]} (${lunarLine(out)}).`;
    }
    case 'info': {
      const a = parseDay(date);
      const start = Date.UTC(a.getUTCFullYear(), 0, 1);
      return `${iso(a)} (${dmy(a)}) is a ${WEEKDAY[a.getUTCDay()]}, ISO week ${isoWeek(a)}, day ${Math.round((a.getTime() - start) / DAY_MS) + 1} of the year; ${lunarLine(a)}.`;
    }
    case 'to_lunar': {
      const a = parseDay(date);
      return `${dmy(a)} (solar) is ${lunarLine(a)}.`;
    }
    case 'to_solar': {
      const y = Number(lYear) || new Date().getUTCFullYear();
      const s = lunarToSolar(Number(lDay), Number(lMonth), y, !!leap);
      if (!s || !lDay || !lMonth) throw new Error(`Lunar ${lDay}/${lMonth}${leap ? ' (leap)' : ''}/${y} does not exist.`);
      const out = utcDay(s[2], s[1], s[0]);
      return `Lunar ${lDay}/${lMonth}${leap ? ' (leap month)' : ''}/${y} (${yearName(y)}) is ${iso(out)} (${dmy(out)}), a ${WEEKDAY[out.getUTCDay()]}.`;
    }
    case 'convert_time':
      return convertTime(time, fromZone, toZone);
    case 'holidays':
      return holidays(country, Number(year) || new Date().getUTCFullYear());
    default:
      throw new Error('op is one of: diff, add, info, to_lunar, to_solar, convert_time, holidays.');
  }
}

/* ── units ─────────────────────────────────────────────────────── */

/** Each unit's size in its dimension's base unit. Temperature is handled apart. */
const UNITS = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
  mass: { kg: 1, g: 0.001, mg: 1e-6, t: 1000, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318, 'lạng': 0.1, 'tạ': 100, 'yến': 10 },
  area: { m2: 1, km2: 1e6, cm2: 1e-4, mm2: 1e-6, ha: 10000, acre: 4046.8564224, ft2: 0.09290304, in2: 0.00064516, mi2: 2589988.110336, 'sào': 360, 'mẫu': 3600 },
  volume: { l: 1, ml: 0.001, m3: 1000, cm3: 0.001, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478, tsp: 0.00492892159 },
  speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444, 'ft/s': 0.3048 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800, month: 2629746, year: 31556952 },
  data: { bit: 0.125, B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 },
  energy: { J: 1, kJ: 1000, cal: 4.184, kcal: 4184, Wh: 3600, kWh: 3.6e6, BTU: 1055.05585 },
  pressure: { Pa: 1, kPa: 1000, MPa: 1e6, bar: 1e5, psi: 6894.757293, atm: 101325, mmHg: 133.322387 },
  power: { W: 1, kW: 1000, MW: 1e6, hp: 745.699872 },
};

const ALIASES = {
  meter: 'm', meters: 'm', metre: 'm', mét: 'm', kilometer: 'km', kilometers: 'km', mile: 'mi', miles: 'mi', feet: 'ft', foot: 'ft',
  inch: 'in', inches: 'in', yard: 'yd', yards: 'yd', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', gram: 'g', grams: 'g', tonne: 't', ton: 't', tấn: 't',
  pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', 'm²': 'm2', sqm: 'm2', 'km²': 'km2', hectare: 'ha', acres: 'acre', 'ft²': 'ft2', sqft: 'ft2',
  liter: 'l', liters: 'l', litre: 'l', lít: 'l', L: 'l', 'm³': 'm3', gallon: 'gal', gallons: 'gal', kph: 'km/h', kmh: 'km/h', knot: 'kn', knots: 'kn',
  sec: 's', second: 's', seconds: 's', minute: 'min', minutes: 'min', hour: 'h', hours: 'h', hr: 'h', days: 'day', weeks: 'week', months: 'month', years: 'year',
  byte: 'B', bytes: 'B', bits: 'bit', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', kib: 'KiB', mib: 'MiB', gib: 'GiB',
  joule: 'J', calorie: 'cal', calories: 'cal', kwh: 'kWh', watt: 'W', watts: 'W', kw: 'kW', horsepower: 'hp',
  celsius: 'C', '°c': 'C', c: 'C', fahrenheit: 'F', '°f': 'F', f: 'F', kelvin: 'K', k: 'K',
};

function findUnit(raw) {
  const text = String(raw || '').trim();
  const key = ALIASES[text] || ALIASES[text.toLowerCase()] || text;
  if (['C', 'F', 'K'].includes(key)) return { dim: 'temperature', unit: key };
  for (const [dim, table] of Object.entries(UNITS)) {
    if (key in table) return { dim, unit: key };
    const loose = Object.keys(table).find((u) => u.toLowerCase() === key.toLowerCase());
    if (loose) return { dim, unit: loose };
  }
  throw new Error(`"${text}" is not a unit this knows. Try m, km, kg, lb, °C, l, km/h, GB, kWh, psi…`);
}

export function convertUnits(value, from, to) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Give the value as a number.');
  const a = findUnit(from);
  const b = findUnit(to);
  if (a.dim !== b.dim) throw new Error(`Cannot convert ${a.dim} (${a.unit}) to ${b.dim} (${b.unit}).`);
  let out;
  if (a.dim === 'temperature') {
    const kelvin = a.unit === 'C' ? n + 273.15 : a.unit === 'F' ? ((n - 32) * 5) / 9 + 273.15 : n;
    out = b.unit === 'C' ? kelvin - 273.15 : b.unit === 'F' ? ((kelvin - 273.15) * 9) / 5 + 32 : kelvin;
  } else {
    out = (n * UNITS[a.dim][a.unit]) / UNITS[b.dim][b.unit];
  }
  return `${fmt(n)} ${a.unit} = ${fmt(Number(out.toPrecision(12)))} ${b.unit}${
    ['sào', 'mẫu'].includes(a.unit) || ['sào', 'mẫu'].includes(b.unit) ? ' (Northern Vietnam sào = 360 m²; in the South 1 sào is often 1,000 m²).' : '.'
  }`;
}

/** Money, by the names and signs people use, as an ISO code — or null when it is not money. */
const CURRENCY_NAMES = {
  $: 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD', 'đô': 'USD', 'đô la': 'USD',
  vnd: 'VND', 'đ': 'VND', '₫': 'VND', 'đồng': 'VND', dong: 'VND', 'vnđ': 'VND',
  '€': 'EUR', eur: 'EUR', euro: 'EUR', euros: 'EUR',
  '£': 'GBP', gbp: 'GBP', pound: 'GBP',
  '¥': 'JPY', jpy: 'JPY', yen: 'JPY', 'yên': 'JPY',
  cny: 'CNY', rmb: 'CNY', yuan: 'CNY', 'nhân dân tệ': 'CNY', krw: 'KRW', won: 'KRW',
};
export function currencyCode(raw) {
  const text = String(raw || '').trim();
  const named = CURRENCY_NAMES[text.toLowerCase()];
  if (named) return named;
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

/**
 * Units, and money too.
 *
 * "1 USD → VND" is a conversion to anybody asking, and the model reached for
 * this tool, failed on "USD is not a unit", and had to find the exchange-rate
 * one on a second try. Two currencies are converted here at the day's
 * reference rate (open.er-api.com, keyless) instead.
 */
async function convertUnitsTool({ value, from, to }) {
  const a = currencyCode(from);
  const b = currencyCode(to);
  let unitA = null;
  try {
    unitA = findUnit(from);
  } catch {
    unitA = null;
  }
  if (a && b && !unitA) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new Error('Give the value as a number.');
    const data = await getJson(`https://open.er-api.com/v6/latest/${a}`);
    const rate = Number(data?.rates?.[b]);
    if (!Number.isFinite(rate)) throw new Error(`There is no rate from ${a} to ${b} today.`);
    return (
      `${fmt(amount)} ${a} = ${fmt(Number((amount * rate).toPrecision(12)))} ${b} ` +
      `(1 ${a} = ${fmt(Number(rate.toPrecision(10)))} ${b}, updated ${data?.time_last_update_utc || 'today'}). ` +
      'A mid-market reference rate from open.er-api.com, not what a bank or exchange will quote.'
    );
  }
  return convertUnits(value, from, to);
}

/* ── markets ───────────────────────────────────────────────────── */

const COINS = {
  btc: 'bitcoin', eth: 'ethereum', usdt: 'tether', usdc: 'usd-coin', bnb: 'binancecoin', sol: 'solana', xrp: 'ripple',
  ada: 'cardano', doge: 'dogecoin', ton: 'the-open-network', trx: 'tron', dot: 'polkadot', ltc: 'litecoin', avax: 'avalanche-2',
  link: 'chainlink', shib: 'shiba-inu', matic: 'matic-network', pol: 'polygon-ecosystem-token', xlm: 'stellar', atom: 'cosmos',
  near: 'near', apt: 'aptos', arb: 'arbitrum', op: 'optimism', sui: 'sui', pepe: 'pepe', uni: 'uniswap', bch: 'bitcoin-cash',
};

async function coinId(symbol) {
  const s = String(symbol).trim().toLowerCase();
  if (COINS[s]) return COINS[s];
  const found = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(s)}`);
  const hit = found?.coins?.find((c) => c.symbol?.toLowerCase() === s) || found?.coins?.[0];
  if (!hit) throw new Error(`No coin called "${symbol}".`);
  return hit.id;
}

async function cryptoQuotes(symbols, vs) {
  const ids = await Promise.all(symbols.map(coinId));
  const currencies = [...new Set(['usd', String(vs || 'vnd').toLowerCase()])];
  const data = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=${currencies.join(',')}&include_24hr_change=true&include_market_cap=true`,
  );
  const lines = ids.map((id, i) => {
    const q = data[id];
    if (!q) return `- ${symbols[i]}: no price`;
    const prices = currencies.map((c) => `${fmt(q[c])} ${c.toUpperCase()}`).join(' · ');
    const change = q.usd_24h_change != null ? `, 24h ${q.usd_24h_change >= 0 ? '+' : ''}${round(q.usd_24h_change)}%` : '';
    return `- ${symbols[i].toUpperCase()} (${id}): ${prices}${change}${q.usd_market_cap ? `, market cap $${fmt(Math.round(q.usd_market_cap))}` : ''}`;
  });
  return `Crypto prices now:\n${lines.join('\n')}\nSource: CoinGecko.`;
}

/** Common names people use, as the tickers the quote service knows. */
const TICKERS = {
  vnindex: '^VNINDEX.VN', 'vn-index': '^VNINDEX.VN', vn30: '^VN30.VN', hnx: '^HNX.VN',
  'sp500': '^GSPC', 's&p500': '^GSPC', 's&p 500': '^GSPC', dow: '^DJI', 'dow jones': '^DJI', nasdaq: '^IXIC', nasdaq100: '^NDX',
  nikkei: '^N225', 'hang seng': '^HSI', ftse: '^FTSE', dax: '^GDAXI', vix: '^VIX',
  gold: 'GC=F', 'vàng': 'GC=F', silver: 'SI=F', oil: 'CL=F', wti: 'CL=F', brent: 'BZ=F', 'dxy': 'DX-Y.NYB',
};

export function tickerFor(symbol, market) {
  const s = String(symbol || '').trim();
  const named = TICKERS[s.toLowerCase()];
  if (named) return named;
  // A bare three-letter code asked about on the Vietnamese market is a HOSE listing.
  if (String(market || '').toLowerCase() === 'vn' && /^[A-Za-z]{3}$/.test(s)) return `${s.toUpperCase()}.VN`;
  return s.toUpperCase();
}

async function stockQuotes(symbols, market) {
  const lines = await Promise.all(
    symbols.map(async (raw) => {
      const ticker = tickerFor(raw, market);
      try {
        const data = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`, {
          'User-Agent': 'Mozilla/5.0',
        });
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return `- ${raw}: no quote for ${ticker}`;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        const change = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : null;
        const when = new Date(meta.regularMarketTime * 1000).toISOString().replace('T', ' ').slice(0, 16);
        return (
          // An index is in points, not in the currency its exchange trades in.
          `- ${meta.symbol}${meta.longName || meta.shortName ? ` (${meta.longName || meta.shortName})` : ''}: ${fmt(meta.regularMarketPrice)} ${meta.instrumentType === 'INDEX' ? 'points' : meta.currency || ''}` +
          `${change != null ? `, ${change >= 0 ? '+' : ''}${round(change)}% vs previous close ${fmt(prev)}` : ''}` +
          ` · ${meta.fullExchangeName || meta.exchangeName}, as of ${when} UTC`
        );
      } catch (err) {
        return `- ${raw}: ${err.message}`;
      }
    }),
  );
  return `Market quotes:\n${lines.join('\n')}\nSource: Yahoo Finance (may be delayed; not for trading decisions).`;
}

async function marketDataTool({ kind, symbols, vs, market }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(/[,;]/))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!list.length) throw new Error('Name at least one symbol — e.g. BTC, ETH, AAPL, FPT, VNINDEX, gold.');
  if (kind === 'crypto') return cryptoQuotes(list, vs);
  if (kind === 'stock') return stockQuotes(list, market);
  throw new Error('kind is crypto or stock.');
}

/* ── places ────────────────────────────────────────────────────── */

async function geocode(name) {
  const text = String(name || '').trim();
  if (!text) throw new Error('Name the place.');
  const hits = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(text)}`);
  const hit = hits?.[0];
  if (!hit) throw new Error(`No place called "${text}" was found on OpenStreetMap.`);
  return { name: hit.display_name, lat: Number(hit.lat), lon: Number(hit.lon), kind: hit.addresstype || hit.type };
}

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371.0088;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const hm = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

/**
 * A route's line, thinned to at most `max` points — enough to draw on a small
 * map, not the thousands OSRM returns for a long drive, since the map is
 * stored with the conversation.
 */
export function thinLine(coords, max = 160) {
  const pts = (Array.isArray(coords) ? coords : []).filter((c) => Array.isArray(c) && c.length >= 2);
  if (pts.length <= max) return pts.map(([lon, lat]) => [round(lat, 5), round(lon, 5)]);
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]).map(([lon, lat]) => [round(lat, 5), round(lon, 5)]);
}

/** The first part of a Nominatim name — "Hoàn Kiếm Lake", not the whole address. */
const shortName = (name) => String(name || '').split(',')[0].trim();

async function placeLookupTool({ op, place, from, to }) {
  if (op === 'find') {
    const p = await geocode(place);
    return {
      content: `${p.name} (${p.kind}) — lat ${round(p.lat, 5)}, lon ${round(p.lon, 5)}. Map: https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=14/${p.lat}/${p.lon}\nSource: OpenStreetMap. A map is shown to the user.`,
      widget: { kind: 'map', title: shortName(p.name), points: [{ lat: p.lat, lon: p.lon, label: shortName(p.name), detail: p.name }] },
    };
  }
  if (op === 'distance') {
    const [a, b] = await Promise.all([geocode(from), geocode(to)]);
    const straight = haversineKm(a, b);
    let road = '';
    let line = [];
    try {
      const route = await getJson(
        `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`,
      );
      const r = route?.routes?.[0];
      if (r) {
        road = ` By road: about ${fmt(round(r.distance / 1000, 1))} km, roughly ${hm(r.duration)} driving without traffic.`;
        line = thinLine(r.geometry?.coordinates);
      }
    } catch {
      /* the straight line still answers the question */
    }
    return {
      content: `${a.name} → ${b.name}: ${fmt(round(straight, 1))} km in a straight line.${road}\nSource: OpenStreetMap / OSRM. A map with the route is shown to the user.`,
      widget: {
        kind: 'map',
        title: `${shortName(a.name)} → ${shortName(b.name)}`,
        points: [
          { lat: a.lat, lon: a.lon, label: shortName(a.name), detail: a.name },
          { lat: b.lat, lon: b.lon, label: shortName(b.name), detail: b.name },
        ],
        line: line.length ? line : [[a.lat, a.lon], [b.lat, b.lon]],
      },
    };
  }
  throw new Error('op is find or distance.');
}

/* ── feeds ─────────────────────────────────────────────────────── */

/**
 * Entities first, tags after: a feed's description is usually HTML that has
 * been entity-encoded (`&lt;p&gt;`), so stripping tags before decoding leaves
 * every one of them in the summary.
 */
const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (w, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';

/** RSS <item>s or Atom <entry>s, newest first as the feed gives them. */
export function parseFeed(xml) {
  const text = String(xml || '');
  const title = decode(tag(text.replace(/<(item|entry)\b[\s\S]*$/i, ''), 'title'));
  const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = blocks.map((b) => ({
    title: decode(tag(b, 'title')),
    link: decode(tag(b, 'link')) || b.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || '',
    date: decode(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date')),
    summary: decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 280),
  }));
  return { title, items };
}

/** One read of an address the model named: status, and the body as text, capped. */
async function fetchFeedText(target) {
  const res = await safeFetch(target, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = res.ok ? (await readCapped(res, 2_000_000)).buffer.toString('utf8') : '';
  if (!res.ok) res.body?.resume?.();
  return { ok: res.ok, status: res.status, text };
}

/**
 * The feeds a web page points at: its `<link rel="alternate">` tags first, then
 * any link to a `.rss` address, made absolute and without repeats.
 */
export function feedLinks(html, base) {
  const found = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(m[0])) continue;
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (href) found.push(href);
  }
  for (const m of String(html).matchAll(/href=["']([^"'#?]+\.(?:rss|atom)(?:\?[^"']*)?)["']/gi)) found.push(m[1]);
  const out = [];
  for (const href of found) {
    try {
      const abs = new URL(href.replace(/&amp;/g, '&'), base).href;
      if (/^https?:/.test(abs) && !out.includes(abs)) out.push(abs);
    } catch {
      /* not an address */
    }
  }
  return out;
}

/**
 * Find the feed a site really has, when the address given was a guess.
 *
 * Models write feed addresses from memory — `vnexpress.net/rss/tin-moi.rss`,
 * where the real one is `tin-moi-nhat.rss` — and the site answered with its
 * homepage or a 404, so every such call failed and the model guessed again.
 * Sites list their feeds on the page the guess led to, on `/rss`, or in the
 * homepage's `<link rel="alternate">`, so that is where this looks. A feed whose
 * name begins with what was asked for is read straight away, as is a site's
 * only feed; otherwise the real addresses come back so the next call is right.
 *
 * @returns {Promise<{ url: string, feed: ReturnType<typeof parseFeed> } | { choices: string[] }>}
 */
async function discoverFeed(asked, firstPage) {
  const pages = [firstPage && { url: asked.href, text: firstPage }];
  let links = firstPage ? feedLinks(firstPage, asked) : [];
  for (const path of ['/rss', '/']) {
    if (links.length) break;
    const at = new URL(path, asked.origin);
    const got = await fetchFeedText(at).catch(() => null);
    if (got?.ok) {
      pages.push({ url: at.href, text: got.text });
      links = feedLinks(got.text, at);
    }
  }
  if (!links.length) return { choices: [] };

  const wanted = asked.pathname.split('/').pop().replace(/\.(rss|xml|atom)$/i, '').toLowerCase();
  const named = wanted ? links.find((l) => new URL(l).pathname.split('/').pop().toLowerCase().startsWith(wanted)) : null;
  const pick = named || (links.length === 1 ? links[0] : null);
  if (pick && pick !== asked.href) {
    const got = await fetchFeedText(new URL(pick)).catch(() => null);
    const feed = got?.ok ? parseFeed(got.text) : null;
    if (feed?.items.length) return { url: pick, feed };
  }
  return { choices: links.slice(0, 30) };
}

async function readFeedTool({ url, limit }) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  const first = await fetchFeedText(parsed);
  let feed = first.ok ? parseFeed(first.text) : { title: '', items: [] };
  let source = parsed.href;
  if (!feed.items.length) {
    const found = await discoverFeed(parsed, first.ok ? first.text : '');
    if ('feed' in found) {
      feed = found.feed;
      source = found.url;
    } else {
      // Whole sentences, so each one translates as a unit.
      const list = found.choices.join('\n');
      if (found.choices.length && first.ok) {
        throw new Error(`${parsed.href} led to a web page, not an RSS or Atom feed. The feeds ${parsed.host} lists are:\n${list}\nCall read_feed with the one you want.`);
      }
      if (found.choices.length) {
        throw new Error(`${parsed.href} returned HTTP ${first.status}. The feeds ${parsed.host} lists are:\n${list}\nCall read_feed with the one you want.`);
      }
      if (first.ok) {
        throw new Error(`${parsed.href} led to a web page, not a feed, and ${parsed.host} lists no feeds. Use web_search or web_fetch for this site instead.`);
      }
      throw new Error(`${parsed.href} returned HTTP ${first.status}, and ${parsed.host} lists no feeds. Use web_search or web_fetch for this site instead.`);
    }
  }
  const n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const body = feed.items
    .slice(0, n)
    .map((i, k) => `${k + 1}. ${i.title}${i.date ? ` — ${i.date}` : ''}\n   ${i.link}${i.summary ? `\n   ${i.summary}` : ''}`)
    .join('\n');
  const moved = source !== parsed.href ? `(${parsed.href} is not a feed; this is the site's own feed at ${source})\n` : '';
  return untrusted(source, `${moved}${feed.title || parsed.host} — ${feed.items.length} items, newest ${n}:\n${body}`);
}

/* ── text ──────────────────────────────────────────────────────── */

/** Vietnamese without its marks: "Hà Nội" → "Ha Noi". */
export const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

/** A line diff by longest common subsequence — small inputs only. */
export function lineDiff(a, b) {
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  if (x.length * y.length > 4_000_000) throw new Error('Those texts are too long to diff here.');
  const L = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i -= 1) for (let j = y.length - 1; j >= 0; j -= 1) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i += 1;
      j += 1;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  const changed = out.filter((l) => !l.startsWith('  ')).length;
  return changed ? out.join('\n') : 'The two texts are identical.';
}

async function textToolsTool({ op, text = '', text2 = '', pattern, flags, algorithm, count }) {
  const s = String(text);
  switch (op) {
    case 'count': {
      const words = s.trim() ? s.trim().split(/\s+/).length : 0;
      return `${s.length} characters (${s.replace(/\s/g, '').length} without spaces), ${words} words, ${s ? s.split('\n').length : 0} lines, ${(s.match(/[.!?…]+(\s|$)/g) || []).length} sentences; about ${Math.max(1, Math.round(words / 220))} min to read.`;
    }
    case 'hash': {
      const algo = String(algorithm || 'sha256').toLowerCase();
      if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) throw new Error('algorithm is md5, sha1, sha256 or sha512.');
      return `${algo}: ${crypto.createHash(algo).update(s, 'utf8').digest('hex')}`;
    }
    case 'base64_encode':
      return Buffer.from(s, 'utf8').toString('base64');
    case 'base64_decode':
      return Buffer.from(s.trim(), 'base64').toString('utf8');
    case 'url_encode':
      return encodeURIComponent(s);
    case 'url_decode':
      return decodeURIComponent(s);
    case 'uuid':
      return Array.from({ length: Math.min(Math.max(Number(count) || 1, 1), 20) }, () => crypto.randomUUID()).join('\n');
    case 'json_format':
      try {
        return JSON.stringify(JSON.parse(s), null, 2);
      } catch (err) {
        throw new Error(`Not valid JSON: ${err.message}`);
      }
    case 'regex': {
      let re;
      try {
        re = new RegExp(String(pattern || ''), `${String(flags || '').replace(/[^imsu]/g, '')}g`);
      } catch (err) {
        throw new Error(`Not a valid regular expression: ${err.message}`);
      }
      const hits = [...s.matchAll(re)].slice(0, 50);
      return hits.length
        ? `${hits.length} match(es):\n${hits.map((m) => `- "${m[0]}" at ${m.index}${m.length > 1 ? `, groups: ${JSON.stringify(m.slice(1))}` : ''}`).join('\n')}`
        : 'No matches.';
    }
    case 'diff':
      return lineDiff(s, text2);
    case 'slug':
      return stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    case 'remove_accents':
      return stripAccents(s);
    case 'upper':
      return s.toLocaleUpperCase('vi');
    case 'lower':
      return s.toLocaleLowerCase('vi');
    case 'title':
      return s.toLocaleLowerCase('vi').replace(/(^|\s)(\S)/g, (w, sp, c) => sp + c.toLocaleUpperCase('vi'));
    default:
      throw new Error('op is one of: count, hash, base64_encode, base64_decode, url_encode, url_decode, uuid, json_format, regex, diff, slug, remove_accents, upper, lower, title.');
  }
}

/* ── tables ────────────────────────────────────────────────────── */

/** CSV with quoted fields, comma or semicolon or tab separated. */
export function parseCsv(text) {
  // A byte-order mark from Excel's 'CSV UTF-8' would otherwise stick to the first column's name.
  const src = String(text || '').replace(new RegExp('^' + String.fromCharCode(0xfeff)), '');
  const first = src.split('\n', 1)[0];
  const sep = [',', ';', '\t'].map((c) => ({ c, n: first.split(c).length })).sort((a, b) => b.n - a.n)[0].c;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  const [head = [], ...body] = rows;
  const columns = head.map((h, i) => h.trim() || `column${i + 1}`);
  return body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()])));
}

/** "1,234.5", "1.234,5" and "12%" as numbers; anything else null. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value ?? '').trim().replace(/[\s%$€£₫đ]|VND|USD/gi, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const stats = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / v.length;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { count: v.length, sum, mean, median, min: v[0], max: v[v.length - 1], sd };
};

/**
 * @param {Array<Record<string, any>>} rows
 * @param {{ op?: string, column?: string, group_by?: string, agg?: string, top?: number, descending?: boolean }} options
 */
export function analyzeRows(rows, { op = 'describe', column, group_by: groupBy, agg = 'sum', top = 10, descending = true }) {
  if (!rows.length) throw new Error('There are no rows to analyse.');
  const columns = Object.keys(rows[0]);
  const need = (c) => {
    if (!c) throw new Error(`Name a column. There are: ${columns.join(', ')}.`);
    const found = columns.find((x) => x === c) || columns.find((x) => x.toLowerCase() === String(c).toLowerCase());
    if (!found) throw new Error(`No column "${c}". There are: ${columns.join(', ')}.`);
    return found;
  };

  if (op === 'describe') {
    const lines = columns.map((c) => {
      const values = rows.map((r) => r[c]);
      const numbers = values.map(toNumber).filter((n) => n != null);
      const blank = values.filter((v) => v === '' || v == null).length;
      if (numbers.length >= Math.max(1, (values.length - blank) * 0.8)) {
        const s = stats(numbers);
        return `- ${c} (number): min ${fmt(s.min)}, max ${fmt(s.max)}, mean ${fmt(round(s.mean))}, median ${fmt(s.median)}, sum ${fmt(round(s.sum))}, sd ${fmt(round(s.sd))}${blank ? `, ${blank} blank` : ''}`;
      }
      const counts = new Map();
      for (const v of values) if (v !== '') counts.set(v, (counts.get(v) || 0) + 1);
      const common = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `"${String(v).slice(0, 40)}" ×${n}`);
      return `- ${c} (text): ${counts.size} distinct${blank ? `, ${blank} blank` : ''}; most common ${common.join(', ')}`;
    });
    return `${rows.length} rows × ${columns.length} columns.\n${lines.join('\n')}`;
  }

  if (op === 'group') {
    const key = need(groupBy);
    const value = agg === 'count' ? null : need(column);
    const groups = new Map();
    for (const r of rows) {
      const k = r[key] === '' ? '(blank)' : r[key];
      if (!groups.has(k)) groups.set(k, []);
      if (value) {
        const n = toNumber(r[value]);
        if (n != null) groups.get(k).push(n);
      } else groups.get(k).push(1);
    }
    const pick = { sum: (s) => s.sum, avg: (s) => s.mean, mean: (s) => s.mean, min: (s) => s.min, max: (s) => s.max, median: (s) => s.median, count: (s) => s.count };
    if (!pick[agg]) throw new Error('agg is sum, avg, min, max, median or count.');
    const out = [...groups].map(([k, v]) => [k, v.length ? pick[agg](stats(v)) : 0]).sort((a, b) => (descending ? b[1] - a[1] : a[1] - b[1]));
    return `${agg}${value ? ` of ${value}` : ''} by ${key} (${out.length} groups):\n| ${key} | ${agg} |\n|---|---|\n${out
      .slice(0, 100)
      .map(([k, v]) => `| ${k} | ${fmt(round(v))} |`)
      .join('\n')}`;
  }

  if (op === 'top') {
    const c = need(column);
    const n = Math.min(Math.max(Number(top) || 10, 1), 100);
    const sorted = rows
      .filter((r) => toNumber(r[c]) != null)
      .sort((a, b) => (descending ? toNumber(b[c]) - toNumber(a[c]) : toNumber(a[c]) - toNumber(b[c])))
      .slice(0, n);
    return `${descending ? 'Top' : 'Bottom'} ${sorted.length} by ${c}:\n| ${columns.join(' | ')} |\n|${columns.map(() => '---').join('|')}|\n${sorted
      .map((r) => `| ${columns.map((k) => r[k]).join(' | ')} |`)
      .join('\n')}`;
  }

  throw new Error('op is describe, group or top.');
}

async function analyzeDataTool({ data, file_id: fileId, ...options }, { userId }) {
  let text = data;
  if (fileId) {
    const file = await getStore().getAttachment(userId, String(fileId));
    if (!file) throw new Error(`No file with the id "${fileId}" on this account.`);
    text = Buffer.from(String(file.data || ''), 'base64').toString('utf8');
  }
  if (!text) throw new Error('Give the table as `data` (CSV or a JSON array), or the `file_id` of an attached CSV.');
  const trimmed = String(text).trim();
  let rows;
  if (trimmed.startsWith('[')) {
    try {
      rows = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(rows) || typeof rows[0] !== 'object') throw new Error('JSON data must be an array of objects.');
  } else {
    rows = parseCsv(trimmed);
  }
  return analyzeRows(rows, options);
}

/* ── QR codes ──────────────────────────────────────────────────── */

async function makeQrTool({ text, name }, { userId, chatId }) {
  const content = String(text || '');
  if (!content.trim()) throw new Error('Give the text or link the QR code should hold.');
  if (content.length > 2000) throw new Error('That is too long for a QR code a phone can read; keep it under 2,000 characters.');
  const url = await QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
  const base = String(name || 'qr-code').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60).trim() || 'qr-code';
  const file = await saveGenerated(userId, { name: `${base}.png`, mime: 'image/png', kind: 'image', data: url.split(',')[1], source: null, chatId });
  return {
    content: `Made a QR code (${file.name}) holding: ${content.slice(0, 200)}. It is in the conversation now, ready to download.`,
    file: { id: file.id, name: file.name, mime: file.mime, kind: file.kind, bytes: file.bytes },
  };
}

/* ── any API ───────────────────────────────────────────────────── */

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_RESPONSE = 40_000;

async function httpRequestTool({ method = 'GET', url, headers, body, json }) {
  const verb = String(method).toUpperCase();
  if (!METHODS.has(verb)) throw new Error('method is GET, HEAD, POST, PUT, PATCH or DELETE.');
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https addresses.');
  const sendHeaders = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...(headers && typeof headers === 'object' ? headers : {}) };
  let payload;
  if (json !== undefined && verb !== 'GET' && verb !== 'HEAD') {
    payload = JSON.stringify(json);
    sendHeaders['Content-Type'] ??= 'application/json';
  } else if (body !== undefined && verb !== 'GET' && verb !== 'HEAD') {
    payload = String(body);
  }
  // `safeFetch`: the address comes from a model, which reads pages that can
  // tell it where to go. Private and metadata addresses are refused.
  const res = await safeFetch(parsed, { method: verb, headers: sendHeaders, body: payload, signal: AbortSignal.timeout(30_000) });
  const type = res.headers.get('content-type') || '';
  // Bytes enough for the 40,000 characters shown, and not one byte more held.
  let text = verb === 'HEAD' ? '' : (await readCapped(res, MAX_RESPONSE * 4)).buffer.toString('utf8');
  // A redirect safeFetch would not follow — a body is never resent to another
  // origin — comes back as it is, with where it pointed.
  const moved = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (moved) text = `Redirected to ${moved} — not followed, because the request body would have gone to a different site. Repeat the call there if that is right.\n${text}`;
  if (/json/i.test(type)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON after all — shown as it came */
    }
  }
  const cut = text.length > MAX_RESPONSE;
  return untrusted(
    `${verb} ${parsed.href}`,
    `HTTP ${res.status}${type ? ` (${type.split(';')[0]})` : ''}\n${cut ? `${text.slice(0, MAX_RESPONSE)}\n… (${text.length - MAX_RESPONSE} more characters cut)` : text}`,
  );
}

/* ── encyclopedia ──────────────────────────────────────────────── */

async function encyclopediaTool({ query, lang }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Say what to look up.');
  const language = /^[a-z]{2,3}$/.test(String(lang || '')) ? lang : /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(q) ? 'vi' : 'en';
  const host = `https://${language}.wikipedia.org`;
  const found = await getJson(`${host}/w/rest.php/v1/search/title?limit=1&q=${encodeURIComponent(q)}`);
  const page = found?.pages?.[0];
  if (!page) throw new Error(`Wikipedia (${language}) has no article matching "${q}".`);
  const summary = await getJson(`${host}/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`);
  const link = summary?.content_urls?.desktop?.page || `${host}/wiki/${encodeURIComponent(page.key)}`;
  return untrusted(link, `${summary.title}${summary.description ? ` — ${summary.description}` : ''}\n\n${summary.extract || '(no summary)'}\n\nSource: ${link}`);
}

export const LIBRARY_IMPLEMENTATIONS = {
  date_calc: dateCalcTool,
  convert_units: convertUnitsTool,
  market_data: marketDataTool,
  place_lookup: placeLookupTool,
  read_feed: readFeedTool,
  text_tools: textToolsTool,
  analyze_data: analyzeDataTool,
  make_qr: makeQrTool,
  http_request: httpRequestTool,
  encyclopedia: encyclopediaTool,
};
