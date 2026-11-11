import { getJson, getResponse, getText, SourceError } from '../http.js';
import { cached, forget, ttlFor } from '../cache.js';
import { dayIn } from '../clock.js';
import { vnIndexCode } from '../vn.js';
import { num, plainText } from '../util.js';

/**
 * Yahoo Finance: US and global prices, HOSE only for Vietnam (research §3.1).
 *
 * Unofficial and grey, as it was before this layer; what changed is the labelling
 * and the safeguards around it. The chart (v8) and the statement timeseries need
 * nothing; v10 quoteSummary, v7 quote and v7 options need the A3 cookie from
 * fc.yahoo.com and a crumb, fetched together and kept six hours in the shared
 * cache so a cold start does not pay for them again.
 *
 * Yahoo has no HNX or UPCoM stock, and no `^VN30.VN` or `^HNX.VN`: only HOSE codes
 * and `^VNINDEX.VN` are ever sent to it — the old `TICKERS` table sent all of them.
 */

const Q1 = 'https://query1.finance.yahoo.com';
const Q2 = 'https://query2.finance.yahoo.com';
const SOURCE = 'yahoo';
const CRUMB_KEY = 'yahoo|crumb||';

/** Names people use, as Yahoo's tickers. */
const NAMED = {
  vnindex: '^VNINDEX.VN', 'vn-index': '^VNINDEX.VN',
  sp500: '^GSPC', 's&p500': '^GSPC', 's&p 500': '^GSPC', dow: '^DJI', 'dow jones': '^DJI', nasdaq: '^IXIC', nasdaq100: '^NDX',
  nikkei: '^N225', 'hang seng': '^HSI', ftse: '^FTSE', dax: '^GDAXI', vix: '^VIX',
  gold: 'GC=F', 'vàng': 'GC=F', silver: 'SI=F', 'bạc': 'SI=F', oil: 'CL=F', wti: 'CL=F', 'dầu': 'CL=F', brent: 'BZ=F', gas: 'NG=F', copper: 'HG=F', dxy: 'DX-Y.NYB',
};

/**
 * The Yahoo ticker for a symbol, or a `SourceError` when Yahoo does not list it.
 * A Vietnamese code goes to Yahoo only when its board is known to be HOSE.
 *
 * @param {string} symbol
 * @param {{ market?: string, board?: string | null }} [where]
 */
export function yahooSymbol(symbol, { market, board } = {}) {
  const s = String(symbol || '').trim();
  const named = NAMED[s.toLowerCase()];
  if (named) return named;
  if (market === 'vn') {
    const index = vnIndexCode(s);
    if (index === 'VNINDEX') return '^VNINDEX.VN';
    if (index) throw new SourceError(SOURCE, `Yahoo has no ${s} index — only VN-Index.`);
    if (board !== 'HOSE') throw new SourceError(SOURCE, `Yahoo lists HOSE stocks only, and ${s.toUpperCase()} is ${board ? `on ${board}` : 'not known to be on HOSE'}.`);
    return `${s.toUpperCase()}.VN`;
  }
  if (market === 'crypto') return `${s.toUpperCase()}-USD`;
  return s.toUpperCase();
}

/** The chart, or a `SourceError` for Yahoo's "Not Found" (which arrives as JSON with a 404). */
async function chart(ticker, params, ctx) {
  const res = await getResponse(SOURCE, `${Q1}/v8/finance/chart/${encodeURIComponent(ticker)}?${new URLSearchParams(params)}`, { ...ctx, okOnly: false });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SourceError(SOURCE, `Yahoo answered HTTP ${res.status} with something that is not JSON.`, { status: res.status });
  }
  const error = data?.chart?.error;
  if (error) throw new SourceError(SOURCE, `Yahoo has no ${ticker} (${error.description || error.code}).`, { status: res.status });
  if (!res.ok) throw new SourceError(SOURCE, `Yahoo answered HTTP ${res.status}.`, { status: res.status });
  const result = data?.chart?.result?.[0];
  if (!result?.meta) throw new SourceError(SOURCE, `Yahoo had no chart for ${ticker}.`);
  return result;
}

const unitOf = (meta) => (meta.instrumentType === 'INDEX' ? 'points' : meta.currency || '');
const zoneOf = (meta) => meta.exchangeTimezoneName || 'UTC';

/** Bars from a chart, in time order. `adjusted` uses adjclose and scales the day's range with it. */
function barsOf(result, { adjusted, daily }) {
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const zone = zoneOf(result.meta);
  const bars = [];
  (result.timestamp || []).forEach((ts, i) => {
    const close = num(q.close?.[i]);
    if (close === null) return;
    const factor = adjusted && num(adj[i]) !== null && close ? num(adj[i]) / close : 1;
    const scaled = (v) => (num(v) === null ? null : num(v) * factor);
    bars.push({ t: daily ? dayIn(new Date(ts * 1000), zone) : new Date(ts * 1000).toISOString(), o: scaled(q.open?.[i]), h: scaled(q.high?.[i]), l: scaled(q.low?.[i]), c: close * factor, v: num(q.volume?.[i]) });
  });
  return bars;
}

/**
 * The latest price. The change is against the previous session's close — the
 * last bar before the day of the latest price, not Yahoo's `chartPreviousClose`,
 * which is the close before the whole range.
 */
export async function quote(symbol, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const result = await chart(ticker, { range: '5d', interval: '1d' }, ctx);
  const meta = result.meta;
  const price = num(meta.regularMarketPrice);
  if (price === null) throw new SourceError(SOURCE, `Yahoo had no price for ${ticker}.`);
  const zone = zoneOf(meta);
  const today = dayIn(new Date(meta.regularMarketTime * 1000), zone);
  const bars = barsOf(result, { adjusted: false, daily: true });
  const before = [...bars].reverse().find((b) => b.t < today);
  const previous = before ? before.c : num(meta.chartPreviousClose);
  return {
    symbol: meta.symbol || ticker,
    name: meta.longName || meta.shortName || undefined,
    exchange: meta.fullExchangeName || meta.exchangeName,
    currency: meta.currency,
    unit: unitOf(meta),
    price,
    previousClose: previous,
    change: previous ? price - previous : null,
    changePct: previous ? ((price - previous) / previous) * 100 : null,
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    asOf: new Date(meta.regularMarketTime * 1000).toISOString(),
    zone,
    delay: 'delayed',
    series: bars.map((b) => ({ t: b.t, c: b.c })),
    source: SOURCE,
  };
}

/** Rows a period needs at most 250 of: daily up to a year, weekly to five, monthly beyond. */
function spanFor({ period, from, to }) {
  if (from) {
    const days = (Date.parse(to || new Date().toISOString().slice(0, 10)) - Date.parse(from)) / 86_400_000;
    return { params: { period1: String(Math.floor(Date.parse(from) / 1000)), period2: String(Math.floor(Date.parse(to || new Date().toISOString()) / 1000) + 86_400) }, interval: days > 5 * 366 ? '1mo' : days > 366 ? '1wk' : '1d' };
  }
  const range = ['5d', '1mo', '3mo', '6mo', '1y', '5y', 'max'].includes(period) ? period : '1mo';
  return { params: { range }, interval: range === 'max' ? '1mo' : range === '5y' ? '1wk' : '1d' };
}

/**
 * Daily (or weekly, monthly) bars. Yahoo's `close` is already split-adjusted, so
 * a "raw" series from Yahoo is not raw: `note` says so.
 *
 * @param {string} symbol
 * @param {{ period?: string, from?: string, to?: string, adjusted?: boolean }} [options]
 * @param {Record<string, any>} [ctx]
 */
export async function history(symbol, { period, from, to, adjusted = true } = {}, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const span = spanFor({ period, from, to });
  const result = await chart(ticker, { ...span.params, interval: span.interval }, ctx);
  const bars = barsOf(result, { adjusted, daily: true }).slice(-250);
  return {
    symbol: result.meta.symbol || ticker,
    currency: result.meta.currency,
    unit: unitOf(result.meta),
    adjusted: true,
    dividendsAdjusted: !!adjusted,
    interval: span.interval,
    zone: zoneOf(result.meta),
    bars,
    source: SOURCE,
    note: adjusted
      ? "Yahoo's adjusted close (splits and dividends); open, high and low scaled with it."
      : "Yahoo's close, which is split-adjusted already — Yahoo has no raw series.",
  };
}

const INTERVALS = { '1m': ['1m', '1d'], '5m': ['5m', '1d'], '15m': ['15m', '5d'], '30m': ['30m', '5d'], '1h': ['60m', '5d'] };

/** Intraday bars: 1m for the last day; 15m and longer over five. */
export async function intraday(symbol, interval = '5m', ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const [step, range] = INTERVALS[interval] || INTERVALS['5m'];
  const result = await chart(ticker, { range, interval: step }, ctx);
  return { symbol: result.meta.symbol || ticker, currency: result.meta.currency, unit: unitOf(result.meta), adjusted: false, interval, zone: zoneOf(result.meta), bars: barsOf(result, { adjusted: false, daily: false }).slice(-250), source: SOURCE };
}

/** Dividends and splits over two years, from the chart's events. */
export async function events(symbol, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const result = await chart(ticker, { range: '2y', interval: '1mo', events: 'div,split' }, ctx);
  const zone = zoneOf(result.meta);
  const out = [];
  for (const d of Object.values(result.events?.dividends || {})) {
    out.push({ date: dayIn(new Date(d.date * 1000), zone), code: 'DIV', title_en: `Cash dividend ${num(d.amount)} ${result.meta.currency || ''}`.trim(), title_vi: `Cổ tức tiền mặt ${num(d.amount)} ${result.meta.currency || ''}`.trim(), exDate: dayIn(new Date(d.date * 1000), zone), valuePerShare: num(d.amount) });
  }
  for (const s of Object.values(result.events?.splits || {})) {
    out.push({ date: dayIn(new Date(s.date * 1000), zone), code: 'SPLIT', title_en: `Split ${s.splitRatio || `${s.numerator}:${s.denominator}`}`, title_vi: `Chia tách ${s.splitRatio || `${s.numerator}:${s.denominator}`}`, exDate: dayIn(new Date(s.date * 1000), zone) });
  }
  if (!out.length) throw new SourceError(SOURCE, `Yahoo lists no dividend or split for ${ticker} in two years.`);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** Statement lines Yahoo's timeseries carries, per kind; labels are its own type names, spelt out. */
const SERIES = {
  income: ['TotalRevenue', 'CostOfRevenue', 'GrossProfit', 'OperatingExpense', 'OperatingIncome', 'PretaxIncome', 'TaxProvision', 'NetIncome', 'DilutedEPS', 'EBITDA'],
  balance: ['TotalAssets', 'CurrentAssets', 'CashAndCashEquivalents', 'Inventory', 'AccountsReceivable', 'TotalLiabilitiesNetMinorityInterest', 'CurrentLiabilities', 'TotalDebt', 'StockholdersEquity'],
  cashflow: ['OperatingCashFlow', 'InvestingCashFlow', 'FinancingCashFlow', 'CapitalExpenditure', 'FreeCashFlow', 'CashDividendsPaid'],
};
/** "TotalRevenue" → "Total revenue", "DilutedEPS" → "Diluted EPS". */
const spell = (type) =>
  type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word, i) => (/^[A-Z]{2,}$/.test(word) || i === 0 ? word : word.toLowerCase()))
    .join(' ');

/** Annual or quarterly statement lines, four periods, newest first. */
export async function statements(symbol, kind = 'income', period = 'year', ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const prefix = period === 'quarter' ? 'quarterly' : 'annual';
  const types = (SERIES[kind] || SERIES.income).map((t) => `${prefix}${t}`);
  const now = Math.floor(Date.now() / 1000);
  const data = await getJson(SOURCE, `${Q2}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?${new URLSearchParams({ type: types.join(','), period1: String(now - 6 * 366 * 86_400), period2: String(now) })}`, ctx);
  const series = new Map();
  let currency = '';
  for (const r of data?.timeseries?.result || []) {
    const type = r?.meta?.type?.[0];
    const points = (type && r[type]) || [];
    if (!points.length) continue;
    series.set(type, points);
    currency ||= points.find((p) => p?.currencyCode)?.currencyCode || '';
  }
  if (!series.size) throw new SourceError(SOURCE, `Yahoo has no ${kind} statement for ${ticker}.`);
  const dates = [...new Set([...series.values()].flat().map((p) => p?.asOfDate).filter(Boolean))].sort().reverse().slice(0, 4);
  const lines = types
    .filter((type) => series.has(type))
    .map((type) => {
      const byDate = new Map(series.get(type).map((p) => [p.asOfDate, num(p?.reportedValue?.raw)]));
      const label = spell(type.slice(prefix.length));
      return { code: type, label_vi: label, label_en: label, values: dates.map((d) => byDate.get(d) ?? null) };
    });
  return {
    symbol: ticker,
    kind,
    period,
    unit: currency || 'USD',
    periods: dates.map((d) => ({ label: period === 'quarter' ? d : `FY ${d.slice(0, 4)} (to ${d})` })),
    lines,
    source: SOURCE,
  };
}

/** The A3 cookie and a crumb, fetched together and kept six hours for everybody. */
export async function crumb(ctx = {}) {
  return cached(CRUMB_KEY, ttlFor('crumb'), async () => {
    const res = await getResponse(SOURCE, 'https://fc.yahoo.com/', { ...ctx, okOnly: false, accept: '*/*' });
    const cookie = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''])
      .map((c) => String(c).split(';')[0])
      .filter((c) => /^A3=/.test(c))
      .join('; ');
    if (!cookie) throw new SourceError(SOURCE, 'Yahoo did not set the cookie its crumb needs.');
    const text = String(await getText(SOURCE, `${Q2}/v1/test/getcrumb`, { ...ctx, headers: { Cookie: cookie } })).trim();
    if (!/^[A-Za-z0-9./_-]{6,20}$/.test(text)) throw new SourceError(SOURCE, 'Yahoo did not hand out a crumb.');
    return { cookie, crumb: text };
  });
}

/**
 * A crumb-gated call: v10 quoteSummary, v7 quote, v7 options. A crumb Yahoo has
 * stopped accepting (401 "Invalid Crumb") is forgotten and fetched once more,
 * rather than failing every such call until its six hours are up.
 */
async function withCrumb(url, ctx) {
  const sep = url.includes('?') ? '&' : '?';
  const ask = async () => {
    const { cookie, crumb: value } = await crumb(ctx);
    return getJson(SOURCE, `${url}${sep}crumb=${encodeURIComponent(value)}`, { ...ctx, headers: { Cookie: cookie } });
  };
  try {
    return await ask();
  } catch (err) {
    if (!(err instanceof SourceError) || err.status !== 401) throw err;
    await forget(CRUMB_KEY);
    return ask();
  }
}

/** v10 quoteSummary modules for a symbol. */
export async function summary(symbol, modules, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const data = await withCrumb(`${Q2}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${encodeURIComponent(modules.join(','))}`, ctx);
  const result = data?.quoteSummary?.result?.[0];
  if (!result) throw new SourceError(SOURCE, `Yahoo had no summary for ${ticker}${data?.quoteSummary?.error?.description ? ` (${data.quoteSummary.error.description})` : ''}.`);
  return { ticker, result };
}

const raw = (field) => num(field?.raw ?? field);

/** Valuation figures from quoteSummary (the global and US fallback). */
export async function ratios(symbol, ctx = {}) {
  const { ticker, result } = await summary(symbol, ['summaryDetail', 'defaultKeyStatistics', 'price'], ctx);
  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const items = [
    ['pe', 'P/E (trailing)', raw(sd.trailingPE)],
    ['forwardPe', 'P/E (forward)', raw(sd.forwardPE)],
    ['pb', 'P/B', raw(ks.priceToBook)],
    ['ps', 'P/S (trailing 12 months)', raw(sd.priceToSalesTrailing12Months)],
    ['dividendYield', 'Dividend yield', raw(sd.dividendYield), 'fraction'],
    ['netMargin', 'Profit margin', raw(ks.profitMargins), 'fraction'],
    ['beta', 'Beta', raw(sd.beta)],
    ['marketCap', 'Market cap', raw(sd.marketCap), 'money'],
    ['enterpriseValue', 'Enterprise value', raw(ks.enterpriseValue), 'money'],
  ]
    .filter(([, , value]) => value !== null)
    .map(([key, label, value, kind]) => ({ key, label_vi: label, label_en: label, value, ...(kind ? { kind } : {}) }));
  if (!items.length) throw new SourceError(SOURCE, `Yahoo had no valuation figures for ${ticker}.`);
  return { symbol: ticker, asOf: new Date().toISOString(), currency: sd.currency || result.price?.currency || '', items, source: SOURCE };
}

/** The company, from quoteSummary's assetProfile — the business, never its officers' names. */
export async function profile(symbol, ctx = {}) {
  const { ticker, result } = await summary(symbol, ['assetProfile', 'price'], ctx);
  const p = result.assetProfile || {};
  return {
    symbol: ticker,
    name: result.price?.longName || result.price?.shortName || ticker,
    exchange: result.price?.exchangeName,
    sector: p.sector,
    industry: p.industry,
    country: p.country,
    employees: num(p.fullTimeEmployees),
    website: p.website,
    summary: plainText(p.longBusinessSummary, 400),
    source: SOURCE,
  };
}

/** An ETF's or fund's top holdings and category. */
export async function fund(symbol, ctx = {}) {
  const { ticker, result } = await summary(symbol, ['topHoldings', 'fundProfile', 'price'], ctx);
  const holdings = (result.topHoldings?.holdings || []).slice(0, 10).map((h) => ({ code: h.symbol, name: h.holdingName, pct: raw(h.holdingPercent) === null ? null : raw(h.holdingPercent) * 100 }));
  if (!holdings.length && !result.fundProfile) throw new SourceError(SOURCE, `Yahoo has no fund data for ${ticker}.`);
  return { code: ticker, name: result.price?.longName || ticker, category: result.fundProfile?.categoryName, family: result.fundProfile?.family, currency: result.price?.currency, nav: raw(result.price?.regularMarketPrice), holdings, source: SOURCE };
}

/** The nearest expiry's options (or `date`'s), a few strikes either side of the price. */
export async function options(symbol, date, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const data = await withCrumb(`${Q2}/v7/finance/options/${encodeURIComponent(ticker)}${date ? `?date=${Math.floor(Date.parse(date) / 1000)}` : ''}`, ctx);
  const r = data?.optionChain?.result?.[0];
  const chain = r?.options?.[0];
  if (!chain) throw new SourceError(SOURCE, `Yahoo has no options for ${ticker}.`);
  const price = num(r.quote?.regularMarketPrice);
  const near = (list) =>
    [...(list || [])]
      .sort((a, b) => (price === null ? a.strike - b.strike : Math.abs(a.strike - price) - Math.abs(b.strike - price)))
      .slice(0, 8)
      .sort((a, b) => a.strike - b.strike)
      .map((c) => ({ strike: num(c.strike), last: num(c.lastPrice), bid: num(c.bid), ask: num(c.ask), volume: num(c.volume), openInterest: num(c.openInterest), iv: num(c.impliedVolatility) }));
  return {
    symbol: r.underlyingSymbol || ticker,
    currency: r.quote?.currency || 'USD',
    price,
    expiry: new Date(chain.expirationDate * 1000).toISOString().slice(0, 10),
    expiries: (r.expirationDates || []).slice(0, 8).map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
    calls: near(chain.calls),
    puts: near(chain.puts),
    source: SOURCE,
  };
}

/** The crumb-gated v7 quote, for when the chart has nothing. */
export async function quoteV7(symbol, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const data = await withCrumb(`${Q1}/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`, ctx);
  const q = data?.quoteResponse?.result?.[0];
  if (!q || num(q.regularMarketPrice) === null) throw new SourceError(SOURCE, `Yahoo's quote had no price for ${ticker}.`);
  return {
    symbol: q.symbol,
    name: q.longName || q.shortName,
    exchange: q.fullExchangeName,
    currency: q.currency,
    unit: q.quoteType === 'INDEX' ? 'points' : q.currency,
    price: num(q.regularMarketPrice),
    previousClose: num(q.regularMarketPreviousClose),
    change: num(q.regularMarketChange),
    changePct: num(q.regularMarketChangePercent),
    volume: num(q.regularMarketVolume),
    asOf: new Date(num(q.regularMarketTime) * 1000).toISOString(),
    zone: q.exchangeTimezoneName || 'UTC',
    delay: num(q.exchangeDataDelayedBy) ? 'delayed' : 'live',
    source: SOURCE,
  };
}

/** Headlines and links about a symbol, from Yahoo's search — never the articles. */
export async function news(symbol, ctx = {}) {
  const ticker = yahooSymbol(symbol, ctx);
  const data = await getJson(SOURCE, `${Q2}/v1/finance/search?${new URLSearchParams({ q: ticker, quotesCount: '1', newsCount: '8' })}`, ctx);
  const items = (data?.news || [])
    .filter((n) => n?.title && /^https?:\/\//.test(String(n.link || '')))
    .map((n) => ({ date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString().slice(0, 10) : '', title: plainText(n.title, 200), publisher: n.publisher, url: n.link }));
  if (!items.length) throw new SourceError(SOURCE, `Yahoo has no news for ${ticker}.`);
  return items;
}
