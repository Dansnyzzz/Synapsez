import { CHAINS, chainFor } from './chains.js';
import { cached, peek, ttlFor, adjustedStillValid } from './cache.js';
import { ICT, NEW_YORK, dayIn } from './clock.js';
import { boardOf, normBoard, sessionAt, vnIndexCode } from './vn.js';
import * as F from './format.js';
import * as yahoo from './sources/yahoo.js';
import * as vndirect from './sources/vndirect.js';
import * as kbs from './sources/kbs.js';
import * as vietcap from './sources/vietcap.js';
import * as sec from './sources/sec.js';
import * as coingecko from './sources/coingecko.js';
import * as fx from './sources/fx.js';
import * as gold from './sources/gold.js';
import * as macro from './sources/macro.js';
import * as fmarket from './sources/fmarket.js';

/**
 * `market_data`: one tool, fourteen kinds, over the finance layer (spec §1).
 *
 * A request is checked, sent down its chain (chains.js) — each step cached for
 * everybody (cache.js) and fetched only through http.js — and the first source
 * that answers is formatted (format.js). A source that fails is named in the
 * answer beside the one that answered instead; a whole chain failing is one
 * "temporarily unavailable" line, never an error that fails a batch.
 *
 * Only symbols, dates and indicator codes go to any source — never the person's
 * words or anything about their account (spec §8).
 */

export const KINDS = ['quote', 'history', 'intraday', 'statements', 'ratios', 'profile', 'events', 'news', 'fund', 'options', 'fx', 'gold', 'macro', 'screen'];
const MARKETS = ['vn', 'us', 'global', 'crypto'];
/** Calendar days each history period reaches back. */
const PERIOD_DAYS = { '5d': 8, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '5y': 1827, max: 7305 };
const DAY = 86_400_000;
const MAX_REQUESTS = 6;

const ATTRIBUTION = { coingecko: [coingecko.ATTRIBUTION], erapi: [fx.ATTRIBUTION.erapi], ecb: [fx.ATTRIBUTION.ecb], fred: [macro.ATTRIBUTION.fred], worldbank: [macro.ATTRIBUTION.worldbank] };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Where a request belongs when it does not say. */
function inferMarket(kind, symbols, raw) {
  if (kind === 'gold') return symbols.some((s) => /world|gc=f|si=f|silver|bạc|comex/i.test(s)) ? 'global' : 'vn';
  if (kind === 'fx') return [...symbols, raw.vs].some((s) => /VND|₫|đồng/i.test(String(s || ''))) ? 'vn' : 'global';
  if (kind === 'screen') return 'us';
  if (kind === 'macro') {
    const country = symbols.find((s) => /^[A-Z]{2,3}$/i.test(s));
    if (/^(VN|VNM)$/i.test(country || '')) return 'vn';
    if (/^(US|USA)$/i.test(country || '') || /^(10y|DGS10|FEDFUNDS|UNRATE)$/i.test(String(raw.indicator || ''))) return 'us';
    return 'global';
  }
  if (symbols.some((s) => vnIndexCode(s))) return 'vn';
  return 'us';
}

/**
 * The request as this layer reads it, or an Error the model can act on. The older
 * `{ kind: 'crypto' | 'stock' }` is a quote.
 */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let kind = String(r.kind || '').trim().toLowerCase();
  let market = String(r.market || '').trim().toLowerCase();
  if (kind === 'crypto') {
    kind = 'quote';
    market = 'crypto';
  } else if (kind === 'stock' || kind === 'price') kind = 'quote';
  if (!KINDS.includes(kind)) throw new Error(`kind is one of: ${KINDS.join(', ')}.`);
  const all = (Array.isArray(r.symbols) ? r.symbols : String(r.symbols ?? r.symbol ?? '').split(/[,;]/)).map((s) => String(s).trim()).filter(Boolean);
  const symbols = all.slice(0, kind === 'quote' || kind === 'fx' ? 12 : 1);
  const optionalSymbol = ['fx', 'gold', 'macro', 'screen'].includes(kind) || (kind === 'options' && market === 'vn');
  if (!symbols.length && !optionalSymbol) throw new Error('Name a symbol — e.g. FPT, VNM, SHS, VNINDEX for Vietnam; AAPL, ^GSPC, gold; BTC, ETH for crypto.');
  if (!MARKETS.includes(market)) market = inferMarket(kind, symbols, r);
  if (!CHAINS[kind][market]) throw new Error(`${kind} is offered for ${Object.keys(CHAINS[kind]).join(', ')} — not for ${market}.${kind === 'screen' ? ' A Vietnamese screen would mean crawling a whole market.' : ''}`);
  const periodWord = String(r.period || '').trim().toLowerCase();
  const statementPeriod = /^(q|quarter|quarterly|quý)$/.test(periodWord) ? 'quarter' : 'year';
  const from = isDate(r.from) ? r.from : null;
  const to = isDate(r.to) ? r.to : null;
  const statement = /balance|cân đối/i.test(String(r.statement || '')) ? 'balance' : /cash|lưu chuyển/i.test(String(r.statement || '')) ? 'cashflow' : 'income';
  return {
    kind,
    market,
    symbols,
    dropped: all.length - symbols.length,
    period: PERIOD_DAYS[periodWord] ? periodWord : kind === 'history' && !from ? '1mo' : null,
    statementPeriod,
    from,
    to,
    interval: ['1m', '5m', '15m', '30m', '1h'].includes(String(r.interval)) ? String(r.interval) : '5m',
    statement,
    adjusted: !(r.adjusted === false || r.adjusted === 'false'),
    vs: /^[A-Za-z]{3}$/.test(String(r.vs || '')) ? String(r.vs).toUpperCase() : null,
    indicator: String(r.indicator || '').trim().slice(0, 60),
    date: isDate(r.date) ? r.date : null,
    lang: market === 'vn' ? 'vi' : 'en',
  };
}

const short = (err) => String(err?.message || err).replace(/\s+/g, ' ').slice(0, 180);

/** The first source in the chain that answers; who failed on the way. */
async function runChain(kind, market, step, ctx) {
  const failed = [];
  for (const source of chainFor(kind, market)) {
    try {
      const value = await step(source);
      if (value !== undefined && value !== null) return { value, source, failed };
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      failed.push({ source, message: short(err) });
    }
  }
  return { value: null, source: null, failed };
}

/** A step's answer from the shared cache, or fetched and kept for `ttl`. */
const keep = (key, ttl, load, ctx, extra = {}) => cached(key, ttl, load, { now: ctx.now.getTime(), ...extra });
const baseOf = (source) => source.split(':')[0];

/* ── each kind ───────────────────────────────────────────────────── */

async function quoteOne(symbol, req, ctx) {
  const { market } = req;
  let board;
  const boardFor = async () => {
    if (board === undefined) board = market === 'vn' && !vnIndexCode(symbol) ? await boardOf(symbol, ctx) : null;
    return board;
  };
  const at = { ...ctx, market };
  const session = market === 'vn' ? sessionAt('HOSE', ctx.now) : undefined;
  const sym = symbol.toUpperCase();
  const run = await runChain(
    'quote',
    market,
    async (source) => {
      const ttl = ttlFor('quote', { market, now: ctx.now, session, source: baseOf(source) });
      const key = `${source}|quote|${sym}|${market}`;
      if (source === 'vndirect') return keep(key, ttl, () => vndirect.quote(symbol, at), ctx);
      if (source === 'kbs') return keep(key, ttl, async () => kbs.quote(symbol, { ...at, board: await boardFor() }), ctx);
      if (source === 'yahoo') return keep(key, ttl, async () => yahoo.quote(symbol, { ...at, board: market === 'vn' ? await boardFor() : null }), ctx);
      if (source === 'yahoo:v7') return keep(key, ttl, () => yahoo.quoteV7(symbol, at), ctx);
      if (source === 'coingecko') return keep(`${key}|${req.vs || 'VND'}`, ttl, async () => (await coingecko.quote([symbol], req.vs || 'vnd', at))[0], ctx);
      return undefined;
    },
    ctx,
  );
  if (!run.value) return { symbol: sym, failed: run.failed };
  const q = run.value;
  const where = normBoard(q.board) || (q.unit === 'points' ? null : await boardFor().catch(() => null));
  return { quote: { ...q, board: market === 'vn' ? where || q.board : q.board }, source: run.source, failed: run.failed, session: market === 'vn' ? sessionAt(where || 'HOSE', ctx.now) : undefined };
}

async function answerQuote(req, ctx) {
  const answers = await Promise.all(req.symbols.map((s) => quoteOne(s, req, ctx)));
  const ok = answers.filter((a) => a.quote);
  const attribution = [...new Set(ok.flatMap((a) => a.quote.attribution || ATTRIBUTION[baseOf(a.source)] || []))];
  const lines = answers.map((a) => (a.quote ? `${F.quoteLine(a.quote, { lang: req.lang, session: a.session })}${a.failed.length ? ` ${F.fallbackNote(a.failed, a.source, req.lang)}` : ''}` : F.unavailable(a.symbol, a.failed, req.lang)));
  const text = answers.length === 1 && ok.length ? `${lines[0]} · ${F.disclaimer(req.lang)}` : [...lines, F.disclaimer(req.lang)].join('\n');
  return { text, attribution, widget: ok.length ? F.quoteWidget(ok.map((a) => a.quote), { lang: req.lang, session: ok.length === 1 ? ok[0].session : undefined, attribution }) : undefined };
}

/** The dates a history request covers, in the market's own calendar. */
function rangeOf(req, ctx) {
  const today = dayIn(ctx.now, req.market === 'us' ? NEW_YORK : ICT);
  if (req.from) return { from: req.from, to: req.to && req.to <= today ? req.to : today, today };
  return { from: shift(today, -PERIOD_DAYS[req.period || '1mo']), to: today, today };
}

async function answerHistory(req, ctx, { intraday = false } = {}) {
  const symbol = req.symbols[0];
  const sym = symbol.toUpperCase();
  const { market } = req;
  const { from, to, today } = rangeOf(req, ctx);
  const days = (Date.parse(to) - Date.parse(from)) / DAY;
  const closedDay = to < today;
  let board;
  const boardFor = async () => {
    if (board === undefined) board = market === 'vn' && !vnIndexCode(symbol) ? await boardOf(symbol, ctx) : null;
    return board;
  };
  const at = { ...ctx, market };
  // An adjusted series is rewritten on every ex-date: one cached before the last one seen is fetched again.
  const events = market === 'vn' && req.adjusted && !intraday ? await peek(`vietcap|events|${sym}|`) : null;
  const valid = events ? (_value, fetchedAt) => adjustedStillValid(fetchedAt, events.value, ctx.now.getTime()) : undefined;
  const run = await runChain(
    intraday ? 'intraday' : 'history',
    market,
    async (source) => {
      const ttl = intraday ? ttlFor('intraday') : ttlFor('history', { market, now: ctx.now, closedDay, adjusted: req.adjusted, source: baseOf(source) });
      const key = `${source}|${intraday ? `intraday|${sym}|${req.interval}` : `history|${sym}|${from}|${to}|${req.adjusted ? 'adj' : 'raw'}`}`;
      const opts = { valid };
      if (intraday) {
        if (source === 'kbs') return keep(key, ttl, () => kbs.intraday(symbol, req.interval, at), ctx);
        if (source === 'vndirect:dchart') return keep(key, ttl, () => vndirect.dchart(symbol, req.interval, shift(today, -3), today, at), ctx);
        if (source === 'yahoo') return keep(key, ttl, async () => yahoo.intraday(symbol, req.interval, { ...at, board: market === 'vn' ? await boardFor() : null }), ctx);
        if (source === 'coingecko') return keep(key, ttl, () => coingecko.history(symbol, { days: 1 }, at), ctx);
        return undefined;
      }
      if (source === 'vndirect') return keep(key, ttl, () => vndirect.history(symbol, { from, to, adjusted: req.adjusted }, at), ctx, opts);
      if (source === 'vndirect:dchart') return keep(key, ttl, () => vndirect.dchart(symbol, days > 1830 ? '1mo' : days > 366 ? '1wk' : '1d', from, to, at), ctx, opts);
      if (source === 'kbs') return keep(key, ttl, () => kbs.history(symbol, { from, to }, at), ctx, opts);
      if (source === 'yahoo') return keep(key, ttl, async () => yahoo.history(symbol, { period: req.from ? undefined : req.period, from: req.from || undefined, to: req.to || undefined, adjusted: req.adjusted }, { ...at, board: market === 'vn' ? await boardFor() : null }), ctx, opts);
      if (source === 'coingecko') return keep(key, ttl, () => coingecko.history(symbol, { days: Math.min(365, Math.ceil(days)) }, at), ctx);
      return undefined;
    },
    ctx,
  );
  if (!run.value) return { text: F.unavailable(sym, run.failed, req.lang) };
  const h = run.value;
  const where = h.board || (market === 'vn' && h.unit !== 'points' ? await boardFor().catch(() => null) : null);
  const label = [sym, where].filter(Boolean).join(' · ');
  const attribution = h.attribution || ATTRIBUTION[baseOf(run.source)] || [];
  const note = !req.adjusted && h.adjusted && !intraday ? (req.lang === 'vi' ? 'Đã hỏi giá gốc, nhưng chỉ VNDIRECT có giá gốc và nó không trả lời được: đây là giá đã điều chỉnh.' : 'Raw prices were asked for, but only VNDIRECT has them and it did not answer: these are adjusted.') : '';
  const series = { ...h, note: [h.note, note].filter(Boolean).join(' ') || undefined };
  return { text: F.historyText(series, { lang: req.lang, label, failed: run.failed, intraday }), attribution, widget: F.historyWidget(series, { lang: req.lang, label, attribution }) };
}

/** The kinds whose answer is one object from one source, formatted by `format`. */
async function answerSimple(req, ctx, kind, step, format) {
  const symbol = req.symbols[0] || '';
  const run = await runChain(kind, req.market, (source) => step(source, symbol), ctx);
  if (!run.value) return { text: F.unavailable(symbol.toUpperCase() || kind, run.failed, req.lang) };
  const attribution = run.value.attribution || ATTRIBUTION[baseOf(run.source)] || [];
  return { text: format(run.value, run), attribution };
}

async function vnBoardIfHose(symbol, ctx) {
  return vnIndexCode(symbol) ? null : boardOf(symbol, ctx);
}

const ANSWERS = {
  quote: answerQuote,
  history: (req, ctx) => answerHistory(req, ctx),
  intraday: (req, ctx) => answerHistory(req, ctx, { intraday: true }),

  statements: (req, ctx) =>
    answerSimple(
      req,
      ctx,
      'statements',
      (source, symbol) => {
        const key = `${source}|statements|${symbol.toUpperCase()}|${req.statement}|${req.statementPeriod}`;
        const load = { vietcap: () => vietcap.statements(symbol, req.statement, req.statementPeriod, ctx), kbs: () => kbs.statements(symbol, req.statement, req.statementPeriod, ctx), sec: () => sec.statements(symbol, req.statement, req.statementPeriod, ctx), yahoo: () => yahoo.statements(symbol, req.statement, req.statementPeriod, { ...ctx, market: req.market, board: 'HOSE' }) }[source];
        return load ? keep(key, ttlFor('statements'), load, ctx) : undefined;
      },
      (s, run) => F.statementText(s, { lang: req.lang, failed: run.failed }),
    ),

  ratios: (req, ctx) =>
    answerSimple(
      req,
      ctx,
      'ratios',
      (source, symbol) => {
        const key = `${source}|ratios|${symbol.toUpperCase()}|`;
        const load = {
          vietcap: () => vietcap.ratios(symbol, ctx),
          vndirect: () => vndirect.ratios(symbol, ctx),
          kbs: () => kbs.ratios(symbol, ctx),
          sec: async () => sec.ratios(symbol, (await yahoo.quote(symbol, { ...ctx, market: 'us' }).catch(() => null))?.price ?? null, ctx),
          yahoo: () => yahoo.ratios(symbol, { ...ctx, market: req.market }),
        }[source];
        return load ? keep(key, ttlFor('ratios'), load, ctx) : undefined;
      },
      (r, run) => F.ratiosText(r, { lang: req.lang, failed: run.failed }),
    ),

  profile: (req, ctx) =>
    answerSimple(
      req,
      ctx,
      'profile',
      (source, symbol) => {
        const key = `${source}|profile|${symbol.toUpperCase()}|`;
        const load = { vietcap: () => vietcap.profile(symbol, ctx), kbs: () => kbs.profile(symbol, ctx), sec: () => sec.profile(symbol, ctx), yahoo: () => yahoo.profile(symbol, { ...ctx, market: req.market }), coingecko: () => coingecko.profile(symbol, ctx) }[source];
        return load ? keep(key, ttlFor('profile', { source }), load, ctx) : undefined;
      },
      (p, run) => F.profileText(p, { lang: req.lang, failed: run.failed, title: req.symbols[0] }),
    ),

  events: (req, ctx) => {
    const today = dayIn(ctx.now, ICT);
    return answerSimple(
      req,
      ctx,
      'events',
      (source, symbol) => {
        const key = `${source}|events|${symbol.toUpperCase()}|`;
        const load = {
          vietcap: () => vietcap.events(symbol, { from: shift(today, -365), to: shift(today, 180) }, ctx),
          yahoo: async () => yahoo.events(symbol, { ...ctx, market: req.market, board: req.market === 'vn' ? await vnBoardIfHose(symbol, ctx) : null }),
          sec: () => sec.events(symbol, ctx),
        }[source];
        return load ? keep(key, ttlFor('events'), load, ctx) : undefined;
      },
      (list, run) => F.eventsText(list, { lang: req.lang, failed: run.failed, label: req.symbols[0].toUpperCase(), source: run.source }),
    );
  },

  news: (req, ctx) => {
    const today = dayIn(ctx.now, ICT);
    return answerSimple(
      req,
      ctx,
      'news',
      (source, symbol) => {
        const key = `${source}|news|${symbol.toUpperCase()}|`;
        const load = {
          vietcap: () => vietcap.news(symbol, { from: shift(today, -30), to: today }, ctx),
          kbs: () => kbs.news(symbol, ctx),
          yahoo: async () => yahoo.news(symbol, { ...ctx, market: req.market, board: req.market === 'vn' ? await vnBoardIfHose(symbol, ctx) : null }),
        }[source];
        return load ? keep(key, ttlFor('news'), load, ctx) : undefined;
      },
      (list, run) => F.newsText(list, { lang: req.lang, failed: run.failed, label: req.symbols[0].toUpperCase(), source: run.source }),
    );
  },

  fund: (req, ctx) =>
    answerSimple(
      req,
      ctx,
      'fund',
      (source, symbol) => {
        const key = `${source}|fund|${symbol.toUpperCase()}|`;
        const load = { fmarket: () => fmarket.fund(symbol, ctx), yahoo: async () => yahoo.fund(symbol, { ...ctx, market: req.market, board: req.market === 'vn' ? await vnBoardIfHose(symbol, ctx) : null }) }[source];
        return load ? keep(key, ttlFor('fund'), load, ctx) : undefined;
      },
      (f, run) => F.fundText(f, { lang: req.lang, failed: run.failed }),
    ),

  options: (req, ctx) => {
    if (req.market === 'vn') {
      return answerSimple(
        req,
        ctx,
        'options',
        async () => {
          const [warrants, futures] = await Promise.all([vietcap.group('CW', ctx).catch(() => []), vietcap.group('FU_INDEX', ctx).catch(() => [])]);
          const under = (req.symbols[0] || '').toUpperCase();
          const list = [...futures, ...warrants.filter((c) => !under || c.includes(under))];
          if (!list.length) throw new Error(`Vietcap lists no covered warrants or index futures${under ? ` on ${under}` : ''}.`);
          return { list };
        },
        (v, run) => F.listingText(v.list, { lang: req.lang, failed: run.failed, label: req.symbols[0]?.toUpperCase() || 'VN' }),
      );
    }
    return answerSimple(
      req,
      ctx,
      'options',
      (source, symbol) => (source === 'yahoo' ? keep(`yahoo|options|${symbol.toUpperCase()}|${req.date || ''}`, ttlFor('options', { market: 'us', now: ctx.now }), () => yahoo.options(symbol, req.date, { ...ctx, market: 'us' }), ctx) : undefined),
      (o, run) => F.optionsText(o, { lang: req.lang, failed: run.failed }),
    );
  },

  fx: async (req, ctx) => {
    const fallback = req.market === 'vn' ? 'VND' : 'USD';
    const pairs = (req.symbols.length ? req.symbols : ['USD']).map((s) => {
      const parts = String(s).toUpperCase().replace(/[^A-Z]/g, ' ').trim().split(/\s+/);
      const [base, quote] = parts.length >= 2 ? parts : parts[0].length === 6 ? [parts[0].slice(0, 3), parts[0].slice(3)] : [parts[0], req.vs || (parts[0] === fallback ? 'USD' : fallback)];
      return { base, quote };
    });
    const answers = await Promise.all(
      pairs.map(async ({ base, quote }) => {
        const run = await runChain('fx', req.market, (source) => fx.fromSource(baseOf(source), base, [quote], req.date, ctx), ctx);
        return { base, quote, run };
      }),
    );
    const ok = answers.filter((a) => a.run.value);
    const attribution = [...new Set(ok.flatMap((a) => a.run.value.attribution || []))];
    const text = answers.map((a) => (a.run.value ? F.fxText(a.run.value, { lang: req.lang, failed: a.run.failed }) : F.unavailable(`${a.base}/${a.quote}`, a.run.failed, req.lang))).join('\n');
    return { text, attribution, widget: ok.length ? F.fxWidget(ok[0].run.value, { lang: req.lang, attribution }) : undefined };
  },

  gold: async (req, ctx) => {
    const run = await runChain('gold', req.market, (source) => (source === 'sjc' ? gold.sjc(ctx) : source === 'yahoo' ? gold.world(ctx) : undefined), ctx);
    if (!run.value) return { text: F.unavailable(req.lang === 'vi' ? 'Giá vàng' : 'Gold', run.failed, req.lang) };
    return { text: F.goldText(run.value, { lang: req.lang, failed: run.failed, source: run.source }), attribution: [], widget: F.goldWidget(run.value, { lang: req.lang, source: run.source }) };
  },

  macro: (req, ctx) => {
    const country = req.symbols.find((s) => /^[A-Z]{2,3}$/i.test(s))?.toUpperCase() || { vn: 'VN', us: 'US' }[req.market] || 'WLD';
    const indicator = req.indicator || req.symbols.find((s) => !/^[A-Z]{2,3}$/i.test(s)) || '';
    if (!indicator) throw new Error('macro needs an indicator: gdp, cpi (inflation), unemployment, rate, 10y, population — or a World Bank or FRED code.');
    return answerSimple(
      { ...req, symbols: [indicator] },
      ctx,
      'macro',
      (source) => {
        const key = `${source}|macro|${indicator.toLowerCase()}|${country}`;
        const load = { worldbank: () => macro.worldBank(country, indicator, 6, ctx), nso: () => macro.nso(indicator, ctx), fred: () => macro.fred(indicator, 12, ctx), ecb: () => macro.ecbSeries(indicator, 12, ctx) }[source];
        return load ? keep(key, ttlFor('macro'), load, ctx) : undefined;
      },
      (m, run) => F.macroText(m, { lang: req.lang, failed: run.failed }),
    );
  },

  screen: (req, ctx) => {
    const indicator = req.indicator || req.symbols[0] || 'revenue';
    const period = /^CY\d{4}(Q[1-4]I?)?$/i.test(String(req.symbols[1] || '')) ? String(req.symbols[1]).toUpperCase() : null;
    return answerSimple(
      { ...req, symbols: [indicator] },
      ctx,
      'screen',
      (source) => (source === 'sec' ? keep(`sec|screen|${indicator.toLowerCase()}|${period || ''}`, ttlFor('screen'), () => sec.screen(indicator, period, ctx, { now: ctx.now }), ctx) : undefined),
      (s, run) => F.screenText(s, { lang: req.lang, failed: run.failed }),
    );
  },
};

/** One request, answered: `{ text, widget?, attribution }`. Throws only for a request that cannot be read. */
async function answerOne(raw, ctx) {
  const req = normalize(raw);
  const out = await ANSWERS[req.kind](req, ctx);
  const extra = req.dropped > 0 ? (req.lang === 'vi' ? `\n(${req.dropped} mã còn lại không được hỏi: loại này nhận một mã mỗi yêu cầu.)` : `\n(${req.dropped} more symbols were not asked: this kind takes one per request.)`) : '';
  const credits = out.attribution?.length ? `\n${out.attribution.join(' · ')}` : '';
  return { ...out, text: `${out.text}${credits}${extra}`, req };
}

const NOTE_CARD = 'A card with these numbers is shown to the user; do not repeat every row. Say the source and that the figures are for reference only, not investment advice.';
const NOTE_PLAIN = 'Say the source and that the figures are for reference only, not investment advice. For a picture, call chart with the rows.';
const NOTE_VN = ' On the Vietnamese market, prices move within a daily band around the reference, and trades settle T+2.';

/**
 * The tool: one request or up to six (`requests`), each answered on its own — one
 * failing never fails the others.
 *
 * @param {Record<string, any>} input
 * @param {{ now?: Date, signal?: AbortSignal | null, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ content: string, note: string, widget?: any }>}
 */
export async function marketData(input, { now = new Date(), signal = null, fetchImpl } = {}) {
  const ctx = { now, signal, ...(fetchImpl ? { fetchImpl } : {}) };
  const asked = Array.isArray(input?.requests) && input.requests.length ? input.requests.slice(0, MAX_REQUESTS) : [input];
  const many = asked.length > 1 || (Array.isArray(input?.requests) && input.requests.length > 1);
  const answers = many
    ? await Promise.all(asked.map((one) => answerOne(one, ctx).catch((err) => ({ text: `Could not ask that: ${short(err)}`, attribution: [], req: null }))))
    : [await answerOne(asked[0], ctx)];
  const more = Array.isArray(input?.requests) && input.requests.length > MAX_REQUESTS ? `\n\n(${input.requests.length - MAX_REQUESTS} more were not asked: ${MAX_REQUESTS} at most in one call.)` : '';
  const first = answers.find((a) => a.widget);
  const attribution = [...new Set(answers.flatMap((a) => a.attribution || []))];
  const widget = first ? { ...first.widget, attribution: [...new Set([...(first.widget.attribution || []), ...attribution])] } : undefined;
  const vnQuote = answers.some((a) => a.req?.market === 'vn' && a.req?.kind === 'quote');
  return {
    content: `${answers.map((a) => a.text).join('\n\n')}${more}`,
    note: `${widget ? NOTE_CARD : NOTE_PLAIN}${vnQuote ? NOTE_VN : ''}`,
    ...(widget ? { widget } : {}),
  };
}
