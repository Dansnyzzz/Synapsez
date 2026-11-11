import { getJson, SourceError } from '../http.js';
import { cached, ttlFor } from '../cache.js';
import { num, plainText } from '../util.js';

/**
 * CoinGecko: crypto prices, keyless or with a free Demo key (no card). Its API
 * terms allow showing the data in a product that charges (4.1.6), on two
 * conditions this layer keeps (research §1): "Powered by CoinGecko" wherever its
 * numbers appear (4.1.4) — every result here carries it, and the card shows it —
 * and nothing kept longer than 24 hours (6.1), which `ttlFor` caps.
 *
 * With `COINGECKO_DEMO_KEY` set, calls carry it (100 a minute of the deployment's
 * own instead of a share of a datacenter address's), and both of its ceilings are
 * taken in http.js before each call.
 */

const API = 'https://api.coingecko.com/api/v3';
const SOURCE = 'coingecko';
export const ATTRIBUTION = 'Powered by CoinGecko';

/** The coins people name most, by CoinGecko's ids; anything else is searched for. */
export const COINS = {
  btc: 'bitcoin', eth: 'ethereum', usdt: 'tether', usdc: 'usd-coin', bnb: 'binancecoin', sol: 'solana', xrp: 'ripple',
  ada: 'cardano', doge: 'dogecoin', ton: 'the-open-network', trx: 'tron', dot: 'polkadot', ltc: 'litecoin', avax: 'avalanche-2',
  link: 'chainlink', shib: 'shiba-inu', matic: 'matic-network', pol: 'polygon-ecosystem-token', xlm: 'stellar', atom: 'cosmos',
  near: 'near', apt: 'aptos', arb: 'arbitrum', op: 'optimism', sui: 'sui', pepe: 'pepe', uni: 'uniswap', bch: 'bitcoin-cash',
};

const options = (ctx) => (process.env.COINGECKO_DEMO_KEY ? { ...ctx, headers: { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_KEY } } : ctx);

/** CoinGecko's id for a symbol or name: the list above, else its search (kept a day). */
export async function coinId(symbol, ctx = {}) {
  const s = String(symbol || '').trim().toLowerCase();
  if (!s) throw new SourceError(SOURCE, 'Name a coin.');
  if (COINS[s]) return COINS[s];
  if (Object.values(COINS).includes(s)) return s;
  return cached(`coingecko|search|${s}|`, ttlFor('listings', { source: SOURCE }), async () => {
    const found = await getJson(SOURCE, `${API}/search?query=${encodeURIComponent(s)}`, options(ctx));
    const hit = found?.coins?.find((c) => String(c.symbol || '').toLowerCase() === s) || found?.coins?.[0];
    if (!hit?.id) throw new SourceError(SOURCE, `CoinGecko has no coin called "${symbol}".`);
    return hit.id;
  });
}

/**
 * Prices for up to twelve coins in USD and one more currency (VND unless told),
 * with the 24-hour change and market cap.
 *
 * @param {string[]} symbols
 * @param {string} [vs]
 * @param {Record<string, any>} [ctx]
 */
export async function quote(symbols, vs = 'vnd', ctx = {}) {
  const list = symbols.slice(0, 12);
  const ids = await Promise.all(list.map((s) => coinId(s, ctx)));
  const other = String(vs || 'vnd').toLowerCase().replace(/[^a-z]/g, '') || 'vnd';
  const currencies = [...new Set(['usd', other])];
  const data = await getJson(
    SOURCE,
    `${API}/simple/price?${new URLSearchParams({ ids: [...new Set(ids)].join(','), vs_currencies: currencies.join(','), include_24hr_change: 'true', include_market_cap: 'true', include_last_updated_at: 'true' })}`,
    options(ctx),
  );
  return ids.map((id, i) => {
    const q = data?.[id];
    if (!q || num(q.usd) === null) throw new SourceError(SOURCE, `CoinGecko has no price for ${list[i]}.`);
    return {
      symbol: String(list[i]).toUpperCase(),
      name: id,
      currency: 'USD',
      unit: 'USD',
      price: num(q.usd),
      also: other !== 'usd' && num(q[other]) !== null ? { currency: other.toUpperCase(), price: num(q[other]) } : undefined,
      changePct: num(q.usd_24h_change),
      changeWindow: '24h',
      marketCap: num(q.usd_market_cap),
      asOf: num(q.last_updated_at) ? new Date(num(q.last_updated_at) * 1000).toISOString() : new Date().toISOString(),
      zone: 'UTC',
      delay: 'delayed',
      source: SOURCE,
      attribution: [ATTRIBUTION],
    };
  });
}

/** Daily (or, for a day or less, five-minute) prices over `days`, in USD. */
export async function history(symbol, { days = 30 } = {}, ctx = {}) {
  const id = await coinId(symbol, ctx);
  const span = Math.max(1, Math.min(365, Math.round(Number(days) || 30)));
  const data = await getJson(SOURCE, `${API}/coins/${encodeURIComponent(id)}/market_chart?${new URLSearchParams({ vs_currency: 'usd', days: String(span), ...(span > 1 ? { interval: 'daily' } : {}) })}`, options(ctx));
  const volumes = new Map((data?.total_volumes || []).map(([t, v]) => [t, num(v)]));
  const bars = (data?.prices || [])
    .filter(([t, p]) => num(t) !== null && num(p) !== null)
    .map(([t, p]) => ({ t: span > 1 ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString(), c: num(p), v: volumes.get(t) ?? null }));
  if (!bars.length) throw new SourceError(SOURCE, `CoinGecko has no price history for ${symbol}.`);
  return { symbol: String(symbol).toUpperCase(), currency: 'USD', unit: 'USD', adjusted: false, interval: span > 1 ? '1d' : '5m', zone: 'UTC', bars: bars.slice(-250), source: SOURCE, attribution: [ATTRIBUTION], note: 'CoinGecko gives a price per point, not open/high/low; volume is the 24-hour total.' };
}

/** What a coin is: rank, supply, all-time high, a short description. */
export async function profile(symbol, ctx = {}) {
  const id = await coinId(symbol, ctx);
  const c = await getJson(SOURCE, `${API}/coins/${encodeURIComponent(id)}?${new URLSearchParams({ localization: 'false', tickers: 'false', market_data: 'true', community_data: 'false', developer_data: 'false', sparkline: 'false' })}`, options(ctx));
  if (!c?.id) throw new SourceError(SOURCE, `CoinGecko has no coin ${symbol}.`);
  const m = c.market_data || {};
  return {
    symbol: String(c.symbol || symbol).toUpperCase(),
    name: c.name,
    rank: num(c.market_cap_rank),
    categories: (c.categories || []).filter(Boolean).slice(0, 4),
    launched: c.genesis_date || undefined,
    website: c.links?.homepage?.find((u) => /^https?:\/\//.test(String(u || ''))) || undefined,
    price: num(m.current_price?.usd),
    marketCap: num(m.market_cap?.usd),
    circulating: num(m.circulating_supply),
    maxSupply: num(m.max_supply),
    allTimeHigh: num(m.ath?.usd),
    summary: plainText(c.description?.en, 400),
    source: SOURCE,
    attribution: [ATTRIBUTION],
  };
}
