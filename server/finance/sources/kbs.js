import { getJson, SourceError } from '../http.js';
import { dayIn, ICT } from '../clock.js';
import { limits, normBoard, vnIndexCode } from '../vn.js';
import { dmyDash, num, plainText } from '../util.js';

/**
 * KBS Securities: daily and intraday bars, index levels, statements, a company
 * profile — HNX and UPCoM included (research §3.2). A broker's internal API with
 * no published terms: grey, on request only, labelled, and switched off by
 * `FIN_SOURCE_KBS=off` if it objects.
 *
 * Prices are in ₫ and already adjusted. The newest row may carry its numbers as
 * strings and no `va`: every figure goes through `num()`. Statements are asked in
 * thousand ₫ (`unit=1000`) and multiplied back to ₫ here.
 */

const BASE = 'https://kbbuddywts.kbsec.com.vn/iis-server/investment';
const SOURCE = 'kbs';

const code = (symbol) => {
  const s = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(s)) throw new SourceError(SOURCE, `"${symbol}" is not a Vietnamese stock code.`);
  return s;
};

/** The rows of whichever `data…` list a bars answer carries (data_day, data_5P…). */
function rowsOf(data) {
  const key = Object.keys(data || {}).find((k) => /^data/i.test(k) && Array.isArray(data[k]));
  return key ? data[key] : [];
}

const bar = (r, daily) => ({
  // KBS's daily rows carry a 07:00 time: a date, nothing more.
  t: daily ? String(r.t).slice(0, 10) : new Date(`${String(r.t).replace(' ', 'T')}:00+07:00`).toISOString(),
  o: num(r.o),
  h: num(r.h),
  l: num(r.l),
  c: num(r.c),
  v: num(r.v),
});

/** Ten days before `to`, the default window for a latest price. */
const tenDaysBefore = (iso) => new Date(Date.parse(iso) - 10 * 86_400_000).toISOString().slice(0, 10);

/**
 * Daily adjusted bars, from `from` to `to`.
 *
 * @param {string} symbol
 * @param {{ from: string, to: string }} range
 * @param {Record<string, any>} [ctx]
 */
export async function history(symbol, { from, to }, ctx = {}) {
  const index = vnIndexCode(symbol);
  const path = index ? `index/${index}` : `stocks/${code(symbol)}`;
  const data = await getJson(SOURCE, `${BASE}/${path}/data_day?sdate=${dmyDash(from)}&edate=${dmyDash(to)}`, ctx);
  const bars = rowsOf(data)
    .map((r) => bar(r, true))
    .filter((b) => b.c !== null)
    .sort((a, b) => a.t.localeCompare(b.t));
  if (!bars.length) throw new SourceError(SOURCE, `KBS has no bars for ${index || code(symbol)} from ${from} to ${to}.`);
  return { symbol: index || code(symbol), currency: index ? '' : 'VND', unit: index ? 'points' : 'VND', adjusted: true, interval: '1d', zone: ICT, bars: bars.slice(-250), source: SOURCE };
}

/**
 * The latest day's price. KBS gives no reference price, so on HOSE and HNX —
 * where the reference is the previous close — it is the previous bar's (adjusted)
 * close, and the band is worked out from it; on UPCoM, whose reference is
 * yesterday's average, it is left out rather than guessed.
 *
 * @param {string} symbol
 * @param {Record<string, any>} [ctx]  `board` when known; `now` for tests
 */
export async function quote(symbol, ctx = {}) {
  const today = dayIn(ctx.now || new Date(), ICT);
  const h = await history(symbol, { from: tenDaysBefore(today), to: today }, ctx);
  const last = h.bars.at(-1);
  const prev = h.bars.at(-2);
  const board = normBoard(ctx.board);
  const isIndex = h.unit === 'points';
  const reference = prev && (isIndex || board === 'HOSE' || board === 'HNX') ? prev.c : null;
  const band = reference && !isIndex && board ? limits(board, reference) : null;
  return {
    symbol: h.symbol,
    board: isIndex ? null : board,
    currency: h.currency,
    unit: h.unit,
    price: last.c,
    ...(reference ? { reference, change: last.c - reference, changePct: ((last.c - reference) / reference) * 100 } : {}),
    ...(band ? { ceiling: band.ceiling, floor: band.floor, bandComputed: true } : {}),
    open: last.o,
    high: last.h,
    low: last.l,
    volume: last.v,
    asOf: `${last.t}T00:00:00+07:00`,
    dateOnly: true,
    zone: ICT,
    delay: 'delayed',
    series: h.bars.map((b) => ({ t: b.t, c: b.c })),
    source: SOURCE,
  };
}

const INTERVALS = { '1m': '1P', '5m': '5P', '15m': '15P', '30m': '30P', '1h': '60P' };

/** Intraday bars for today (or the last trading days), in ₫ or points. */
export async function intraday(symbol, interval = '5m', ctx = {}) {
  const index = vnIndexCode(symbol);
  const path = index ? `index/${index}` : `stocks/${code(symbol)}`;
  const today = dayIn(ctx.now || new Date(), ICT);
  const step = INTERVALS[interval] || INTERVALS['5m'];
  const from = interval === '1m' || interval === '5m' ? new Date(Date.parse(today) - 3 * 86_400_000).toISOString().slice(0, 10) : tenDaysBefore(today);
  const data = await getJson(SOURCE, `${BASE}/${path}/data_${step}?sdate=${dmyDash(from)}&edate=${dmyDash(today)}`, ctx);
  const bars = rowsOf(data)
    .map((r) => bar(r, false))
    .filter((b) => b.c !== null)
    .sort((a, b) => a.t.localeCompare(b.t));
  if (!bars.length) throw new SourceError(SOURCE, `KBS has no ${interval} bars for ${index || code(symbol)}.`);
  return { symbol: index || code(symbol), currency: index ? '' : 'VND', unit: index ? 'points' : 'VND', adjusted: true, interval, zone: ICT, bars: bars.slice(-250), source: SOURCE };
}

const TYPES = { income: 'KQKD', balance: 'CDKT', cashflow: 'LCTT', ratios: 'CSTC' };

/** KBS's finance-info answer: periods from `Head`, lines from `Content`, labelled by its own names. */
async function financeInfo(symbol, type, period, ctx) {
  const sym = code(symbol);
  const term = period === 'quarter' ? '2' : '1';
  // The cash-flow statement is asked with `termType` and the code again (research §3.2).
  const params = type === 'LCTT'
    ? { page: '1', pageSize: '4', type, unit: '1000', termType: term, languageid: '1', code: sym }
    : { page: '1', pageSize: '4', type, unit: '1000', termtype: term, languageid: '1' };
  const data = await getJson(SOURCE, `${BASE}/stock/finance-info/${sym}?${new URLSearchParams(params)}`, ctx);
  const head = Array.isArray(data?.Head) ? data.Head.slice(0, 4) : [];
  const rows = Object.values(data?.Content || {}).find((list) => Array.isArray(list)) || [];
  if (!head.length || !rows.length) throw new SourceError(SOURCE, `KBS has no ${type} for ${sym}.`);
  return { sym, data, head, rows };
}

/**
 * Four periods of one statement, newest first, in ₫. Each period says whether it
 * was audited (KT), reviewed (SX) or not (CKT), and whether it is consolidated
 * (HN) or the parent company's — from the code lists KBS sends with it.
 */
export async function statements(symbol, kind = 'income', period = 'year', ctx = {}) {
  const { sym, data, head, rows } = await financeInfo(symbol, TYPES[kind] || 'KQKD', period, ctx);
  const audit = Object.fromEntries((data.Audit || []).map((a) => [a.AuditedStatusCode, a.DescriptionEn]));
  const unit = Object.fromEntries((data.Unit || []).map((u) => [u.UnitedCode, u.UnitedNameEN]));
  const periods = head.map((h) => ({
    label: period === 'quarter' ? `${h.TermNameEN || h.TermName || h.TermCode} ${h.YearPeriod}` : String(h.YearPeriod),
    published: String(h.DatePubDepartment || h.ReportDate || '').slice(0, 10) || undefined,
    audited: audit[h.AuditedStatus] ? String(audit[h.AuditedStatus]).toLowerCase() : undefined,
    consolidated: h.United ? h.United === 'HN' : undefined,
    basis: unit[h.United] || undefined,
  }));
  const lines = rows
    .map((r) => ({
      code: String(r.ReportNormID ?? r.ID),
      label_vi: String(r.Name || '').trim(),
      label_en: String(r.NameEn || r.Name || '').trim().replace(/\s+/g, ' '),
      values: head.map((_, i) => (num(r[`Value${i + 1}`]) === null ? null : num(r[`Value${i + 1}`]) * 1000)),
    }))
    .filter((l) => l.label_vi && l.values.some((v) => v !== null && v !== 0))
    .slice(0, 15);
  return { symbol: sym, kind, period, unit: 'VND', periods, lines, source: SOURCE, note: 'KBS figures asked in thousand ₫ and given here in ₫.' };
}

/** KBS's financial ratios (CSTC), as KBS names and gives them — not multiplied. */
export async function ratios(symbol, ctx = {}) {
  const { sym, head, rows } = await financeInfo(symbol, 'CSTC', 'quarter', ctx);
  const items = rows
    .filter((r) => num(r.Value1) !== null && String(r.Name || '').trim())
    .slice(0, 15)
    .map((r) => ({ key: `kbs:${r.ReportNormID ?? r.ID}`, label_vi: String(r.Name).trim(), label_en: String(r.NameEn || r.Name).trim(), value: num(r.Value1) }));
  if (!items.length) throw new SourceError(SOURCE, `KBS has no ratios for ${sym}.`);
  return { symbol: sym, asOf: `${head[0].TermNameEN || head[0].TermName || ''} ${head[0].YearPeriod}`.trim(), items, source: SOURCE };
}

/** The listing: exchange, founding and listing dates, par value, and what the company does. */
export async function profile(symbol, ctx = {}) {
  const sym = code(symbol);
  const p = await getJson(SOURCE, `${BASE}/stockinfo/profile/${sym}?l=1`, ctx);
  if (!p || (!p.SB && !p.EX)) throw new SourceError(SOURCE, `KBS has no profile for ${sym}.`);
  return { symbol: p.SB || sym, exchange: normBoard(p.EX) || p.EX, founded: p.FD, listed: p.LD, parValue: num(p.FV), summary: plainText(p.SM, 400), source: SOURCE };
}

/**
 * Headlines about a company. This answer was not probed; it is read for the
 * fields such lists carry, and a shape it does not know is a `SourceError`, so
 * the chain moves on to the next source rather than showing nothing as news.
 */
export async function news(symbol, ctx = {}) {
  const sym = code(symbol);
  const data = await getJson(SOURCE, `${BASE}/stockinfo/news/${sym}?l=1&p=1&s=8`, ctx);
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const items = list
    .map((n) => ({ date: String(n.PublishTime || n.PostDate || n.date || '').slice(0, 10), title: plainText(n.Title || n.title || n.Head || '', 200), url: n.URL || n.Link || n.url || '' }))
    .filter((n) => n.title && /^https?:\/\//.test(n.url));
  if (!items.length) throw new SourceError(SOURCE, `KBS has no news for ${sym} that this can read.`);
  return items;
}
