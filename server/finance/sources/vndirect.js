import { getJson, SourceError } from '../http.js';
import { normBoard, vnIndexCode } from '../vn.js';
import { num, unixDay } from '../util.js';

/**
 * VNDirect: the best Vietnamese price history there is for free — the raw and
 * the adjusted columns side by side, HOSE, HNX and UPCoM, back to 2013 (research
 * §3.2). A broker's internal API with no published terms: grey, used on request
 * only, labelled, and switched off by `FIN_SOURCE_VNDIRECT=off` if it objects.
 *
 * **Prices arrive in thousand ₫** (50.9 = 50,900 ₫) and leave here in ₫. Volumes
 * are shares and are never adjusted. An index (VNINDEX…) is in points, so it is
 * not multiplied.
 */

const FINFO = 'https://api-finfo.vndirect.com.vn/v4';
const DCHART = 'https://dchart-api.vndirect.com.vn/dchart/history';
const SOURCE = 'vndirect';
const K = 1000;

const code = (symbol) => {
  const s = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(s)) throw new SourceError(SOURCE, `"${symbol}" is not a Vietnamese stock code.`);
  return s;
};
const vnd = (value) => (num(value) === null ? null : Math.round(num(value) * K * 100) / 100);

/** The newest day's row: price, reference, ceiling, floor, all in ₫. */
export async function quote(symbol, ctx = {}) {
  const sym = code(symbol);
  if (vnIndexCode(sym)) throw new SourceError(SOURCE, `${sym} is an index; VNDirect's price list is for stocks.`);
  const data = await getJson(SOURCE, `${FINFO}/stock_prices?sort=date&q=code:${sym}&size=2&page=1`, ctx);
  const row = data?.data?.[0];
  if (!row || num(row.close) === null) throw new SourceError(SOURCE, `VNDirect has no price for ${sym}.`);
  return {
    symbol: sym,
    board: normBoard(row.floor),
    currency: 'VND',
    unit: 'VND',
    price: vnd(row.close),
    reference: vnd(row.basicPrice),
    ceiling: vnd(row.ceilingPrice),
    floor: vnd(row.floorPrice),
    open: vnd(row.open),
    high: vnd(row.high),
    low: vnd(row.low),
    average: vnd(row.average),
    change: vnd(row.change),
    changePct: num(row.pctChange),
    volume: num(row.nmVolume),
    value: num(row.nmValue),
    putThroughVolume: num(row.ptVolume),
    asOf: new Date(`${row.date}T${row.time || '15:00:00'}+07:00`).toISOString(),
    zone: 'Asia/Ho_Chi_Minh',
    delay: 'delayed',
    source: SOURCE,
  };
}

/**
 * Daily bars from `from` to `to` (≤ 250 rows: one call, never a crawl). Raw prices
 * (`open…close`) or adjusted (`adOpen…adClose`), in ₫; volume is never adjusted.
 *
 * @param {string} symbol
 * @param {{ from: string, to: string, adjusted?: boolean }} range
 * @param {Record<string, any>} [ctx]
 */
export async function history(symbol, { from, to, adjusted = true }, ctx = {}) {
  const sym = code(symbol);
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > 366) throw new SourceError(SOURCE, 'VNDirect gives daily rows only, and this period needs more than 250 of them.');
  const data = await getJson(SOURCE, `${FINFO}/stock_prices?sort=date&q=code:${sym}~date:gte:${from}~date:lte:${to}&size=250&page=1`, ctx);
  const rows = (data?.data || []).filter((r) => r?.date && num(r.close) !== null);
  if (!rows.length) throw new SourceError(SOURCE, `VNDirect has no prices for ${sym} from ${from} to ${to}.`);
  const p = adjusted ? { o: 'adOpen', h: 'adHigh', l: 'adLow', c: 'adClose' } : { o: 'open', h: 'high', l: 'low', c: 'close' };
  return {
    symbol: sym,
    board: normBoard(rows[0].floor),
    currency: 'VND',
    unit: 'VND',
    adjusted: !!adjusted,
    interval: '1d',
    zone: 'Asia/Ho_Chi_Minh',
    bars: rows
      .map((r) => ({ t: r.date, o: vnd(r[p.o]), h: vnd(r[p.h]), l: vnd(r[p.l]), c: vnd(r[p.c]), v: num(r.nmVolume) }))
      .sort((a, b) => a.t.localeCompare(b.t)),
    source: SOURCE,
  };
}

const RESOLUTIONS = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '1d': 'D', '1wk': 'W', '1mo': 'M' };

/**
 * VNDirect's chart host (TradingView's format): adjusted bars, daily or intraday.
 * Thousand ₫ for a stock, points for an index.
 *
 * @param {string} symbol
 * @param {string} interval  1m | 5m | 15m | 30m | 1h | 1d | 1wk | 1mo
 * @param {string} from  YYYY-MM-DD
 * @param {string} to    YYYY-MM-DD
 * @param {Record<string, any>} [ctx]
 */
export async function dchart(symbol, interval, from, to, ctx = {}) {
  const raw = String(symbol || '').trim().toUpperCase();
  const index = vnIndexCode(raw);
  const sym = index ? (index === 'HNXUpcomIndex' ? 'UPCOM' : index === 'HNXIndex' ? 'HNX' : index) : code(raw);
  const resolution = RESOLUTIONS[interval] || 'D';
  const data = await getJson(SOURCE, `${DCHART}?${new URLSearchParams({ resolution, symbol: sym, from: String(unixDay(from)), to: String(unixDay(to) + 86_399) })}`, ctx);
  if (data?.s !== 'ok' || !Array.isArray(data.t) || !data.t.length) throw new SourceError(SOURCE, `VNDirect's chart has no bars for ${sym}${data?.s ? ` (${data.s})` : ''}.`);
  const price = (list, i) => (index ? num(list?.[i]) : vnd(list?.[i]));
  const daily = ['D', 'W', 'M'].includes(resolution);
  const at = (i) => (daily ? new Date((data.t[i] + 7 * 3600) * 1000).toISOString().slice(0, 10) : new Date(data.t[i] * 1000).toISOString());
  const bars = data.t
    .map((_, i) => ({ t: at(i), o: price(data.o, i), h: price(data.h, i), l: price(data.l, i), c: price(data.c, i), v: num(data.v?.[i]) }))
    .filter((b) => b.c !== null);
  return { symbol: sym, currency: index ? '' : 'VND', unit: index ? 'points' : 'VND', adjusted: true, interval, zone: 'Asia/Ho_Chi_Minh', bars: bars.slice(-250), source: SOURCE };
}

/**
 * The latest ratios VNDirect publishes. Only item 51003 (market capitalisation, ₫)
 * is read: the meaning of its other item codes is not documented anywhere this
 * could check, and a figure under a guessed name is worse than none.
 */
export async function ratios(symbol, ctx = {}) {
  const sym = code(symbol);
  const data = await getJson(SOURCE, `${FINFO}/ratios/latest?filter=itemCode:51003&where=code:${sym}`, ctx);
  const row = (data?.data || []).find((r) => String(r?.itemCode) === '51003' && num(r.value) !== null);
  if (!row) throw new SourceError(SOURCE, `VNDirect has no ratios for ${sym}.`);
  return { symbol: sym, asOf: row.reportDate, currency: 'VND', items: [{ key: 'marketCap', label_vi: 'Vốn hoá thị trường', label_en: 'Market capitalisation', value: num(row.value), kind: 'money' }], source: SOURCE };
}
