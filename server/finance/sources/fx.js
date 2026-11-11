import { enabled, getJson, SourceError, sourceLabel } from '../http.js';
import { cached, ttlFor } from '../cache.js';
import { dayIn, ICT } from '../clock.js';
import { num } from '../util.js';
import * as yahoo from './yahoo.js';

/**
 * Exchange rates (research §3.5), each source with the credit its terms ask for:
 *
 *   - Frankfurter v2 — free for commercial use, VND included (blended from other
 *     central banks, not the State Bank's): a reference mid-rate.
 *   - ECB — euro reference rates, "Source: ECB statistics."
 *   - open.er-api.com — once a day; its terms want a link to exchangerate-api.com
 *     wherever its rate is shown, which `convert_units` never gave until now.
 *   - Yahoo `EURUSD=X` — the last resort.
 *   - Vietcombank — the bank's own posted cash, transfer and selling rates against
 *     ₫. Its feed says "Only one request every 5 minutes!": kept five minutes,
 *     shared by every account and instance.
 *
 * There is no free API for the State Bank's central rate, so none is claimed.
 */

export const ATTRIBUTION = {
  ecb: 'Source: ECB statistics.',
  erapi: 'Rates By Exchange Rate API: https://www.exchangerate-api.com',
};

const ccy = (code) => {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new SourceError('frankfurter', `"${code}" is not a currency code.`);
  return c;
};

const past = (date, now = new Date()) => !!date && date < dayIn(now, ICT);

/** Frankfurter v2: `[{ date, base, quote, rate }]`. */
async function frankfurter(base, quotes, date, ctx) {
  const data = await getJson('frankfurter', `https://api.frankfurter.dev/v2/rates?${new URLSearchParams({ base, quotes: quotes.join(','), ...(date ? { date } : {}) })}`, ctx);
  const rows = (Array.isArray(data) ? data : []).filter((r) => quotes.includes(String(r?.quote).toUpperCase()) && num(r.rate) !== null);
  if (!rows.length) throw new SourceError('frankfurter', `Frankfurter has no ${base}/${quotes.join(',')} rate${date ? ` for ${date}` : ''}.`);
  return rows.map((r) => ({ base, quote: String(r.quote).toUpperCase(), rate: num(r.rate), date: r.date, kind: 'reference' }));
}

/** ECB reference rates, against the euro; any other pair is crossed through it. */
async function ecb(base, quotes, date, ctx) {
  const others = [...new Set([base, ...quotes].filter((c) => c !== 'EUR'))];
  if (!others.length) return quotes.map((quote) => ({ base, quote, rate: 1, date: date || dayIn(new Date(), ICT), kind: 'reference' }));
  const params = date ? { startPeriod: date, endPeriod: date, format: 'jsondata' } : { lastNObservations: '1', format: 'jsondata' };
  const data = await getJson('ecb', `https://data-api.ecb.europa.eu/service/data/EXR/D.${others.join('+')}.EUR.SP00.A?${new URLSearchParams(params)}`, ctx);
  const currencies = data?.structure?.dimensions?.series?.find((d) => d.id === 'CURRENCY')?.values || data?.structure?.dimensions?.series?.[1]?.values || [];
  const times = data?.structure?.dimensions?.observation?.[0]?.values || [];
  const perEur = { EUR: 1 };
  let when = '';
  for (const [key, series] of Object.entries(data?.dataSets?.[0]?.series || {})) {
    const code = currencies[Number(key.split(':')[1])]?.id;
    const last = Object.keys(series?.observations || {}).sort((a, b) => Number(a) - Number(b)).at(-1);
    const value = num(series?.observations?.[last]?.[0]);
    if (code && value !== null) perEur[code] = value;
    if (last !== undefined) when = times[Number(last)]?.id || when;
  }
  return quotes.map((quote) => {
    if (perEur[base] === undefined || perEur[quote] === undefined) throw new SourceError('ecb', `The ECB publishes no ${base === 'EUR' ? quote : base} rate.`);
    return { base, quote, rate: perEur[quote] / perEur[base], date: when, kind: 'reference' };
  });
}

/** open.er-api.com: today's rates against one base; no past dates. */
async function erapi(base, quotes, date, ctx) {
  if (past(date)) throw new SourceError('erapi', 'open.er-api.com has only today\'s rates.');
  const data = await getJson('erapi', `https://open.er-api.com/v6/latest/${base}`, ctx);
  if (data?.result !== 'success') throw new SourceError('erapi', 'open.er-api.com did not answer with rates.');
  const when = num(data.time_last_update_unix) ? new Date(num(data.time_last_update_unix) * 1000).toISOString().slice(0, 10) : '';
  return quotes.map((quote) => {
    const rate = num(data.rates?.[quote]);
    if (rate === null) throw new SourceError('erapi', `open.er-api.com has no ${base}/${quote} rate.`);
    return { base, quote, rate, date: when, kind: 'reference' };
  });
}

/** Yahoo's `XXXYYY=X`, today only. */
async function yahooFx(base, quotes, date, ctx) {
  if (past(date)) throw new SourceError('yahoo', 'Yahoo is asked for today\'s rates only.');
  return Promise.all(
    quotes.map(async (quote) => {
      const q = await yahoo.quote(`${base}${quote}=X`, { ...ctx, market: 'global' });
      return { base, quote, rate: q.price, date: q.asOf.slice(0, 10), kind: 'reference' };
    }),
  );
}

/**
 * Vietcombank's posted rates against ₫ for a day (today by default): per currency,
 * its cash buying, transfer buying and selling rate. Kept five minutes, as the
 * bank asks.
 */
export async function vndBank(date, ctx = {}) {
  const day = date || dayIn(new Date(), ICT);
  return cached(`vietcombank|fx|VND|${day}`, ttlFor('fx', { source: 'vietcombank' }), async () => {
    const data = await getJson('vietcombank', `https://www.vietcombank.com.vn/api/exchangerates?date=${day}`, ctx);
    const rows = (data?.Data || [])
      .map((r) => ({ code: String(r.currencyCode || '').toUpperCase(), name: String(r.currencyName || '').trim(), cash: num(r.cash), transfer: num(r.transfer), sell: num(r.sell) }))
      .filter((r) => /^[A-Z]{3}$/.test(r.code) && (r.cash || r.transfer || r.sell));
    if (!rows.length) throw new SourceError('vietcombank', `Vietcombank has no rates for ${day}.`);
    return { date: String(data.Date || day).slice(0, 10), updated: data.UpdatedDate || undefined, rows };
  });
}

/** Vietcombank as rows of the common shape, for pairs quoted in ₫. */
async function vietcombank(base, quotes, date, ctx) {
  if (quotes.some((q) => q !== 'VND') || base === 'VND') throw new SourceError('vietcombank', 'Vietcombank posts rates against ₫ only.');
  const board = await vndBank(date, ctx);
  const row = board.rows.find((r) => r.code === base);
  if (!row) throw new SourceError('vietcombank', `Vietcombank posts no ${base} rate.`);
  return [
    { base, quote: 'VND', rate: row.cash, date: board.date, kind: 'bank-cash', updated: board.updated },
    { base, quote: 'VND', rate: row.transfer, date: board.date, kind: 'bank-transfer', updated: board.updated },
    { base, quote: 'VND', rate: row.sell, date: board.date, kind: 'bank-sell', updated: board.updated },
  ].filter((r) => r.rate !== null);
}

const READERS = { frankfurter, ecb, erapi, yahoo: yahooFx, vietcombank };

/**
 * One source's rates for `base` against `quotes`, kept as long as rates are
 * (an hour; a past day's for good). Vietcombank keeps its own five minutes.
 *
 * @param {string} source  frankfurter | ecb | erapi | yahoo | vietcombank
 * @param {string} base
 * @param {string[]} quotes
 * @param {string | null} [date]  YYYY-MM-DD, or today
 * @param {Record<string, any>} [ctx]
 */
export async function fromSource(source, base, quotes, date = null, ctx = {}) {
  const read = READERS[source];
  if (!read) throw new SourceError(source, `${source} gives no exchange rates.`);
  const b = ccy(base);
  const q = quotes.map(ccy).filter((c) => c !== b);
  if (!q.length) throw new SourceError(source, 'Name a second currency.');
  // Vietcombank is named as the source on every line; it asks for no other credit.
  if (source === 'vietcombank') return { rates: await read(b, q, date, ctx), source, attribution: [] };
  const rows = await cached(`${source}|fx|${b}|${q.join(',')}|${date || 'latest'}`, ttlFor('fx', { source, past: past(date) }), () => read(b, q, date, ctx));
  return { rates: rows, source, attribution: ATTRIBUTION[source] ? [ATTRIBUTION[source]] : [] };
}

/** The reference chain for any pair: Frankfurter → ECB → open.er-api → Yahoo, less what is switched off. */
const REFERENCE = ['frankfurter', 'ecb', 'erapi', 'yahoo'];

/**
 * Rates from the first source that has them, and what the others said on the way.
 *
 * @returns {Promise<{ rates: any[], source: string, attribution: string[], tried: string[] }>}
 */
export async function rates(base, quotes, date = null, ctx = {}) {
  const tried = [];
  for (const source of REFERENCE.filter((s) => enabled(s))) {
    try {
      return { ...(await fromSource(source, base, quotes, date, ctx)), tried };
    } catch (err) {
      tried.push(`${sourceLabel(source)}: ${err?.message || err}`);
    }
  }
  throw new SourceError('fx', `No rate source answered. ${tried.join(' ')}`);
}

/**
 * An amount in one currency in another, at a reference rate — for `convert_units`.
 *
 * @returns {Promise<{ amount: number, from: string, to: string, rate: number, value: number, date: string, source: string, attribution: string[] }>}
 */
export async function convert(amount, from, to, ctx = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new SourceError('fx', 'Give the amount as a number.');
  const got = await rates(from, [to], null, ctx);
  const rate = got.rates[0].rate;
  return { amount: n, from: ccy(from), to: ccy(to), rate, value: n * rate, date: got.rates[0].date, source: got.source, attribution: got.attribution };
}
