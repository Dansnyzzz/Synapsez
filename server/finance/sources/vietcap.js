import { getJson, SourceError } from '../http.js';
import { cached, ttlFor } from '../cache.js';
import { compact, num, plainText } from '../util.js';

/**
 * Vietcap: statements, ratios, company details, corporate actions, news and the
 * board listings — all GETs on its IQ and trading hosts (research §3.2). A
 * broker's internal API with no published terms: grey, on request only,
 * labelled, and switched off by `FIN_SOURCE_VIETCAP=off` if it objects.
 *
 * Statement labels come from Vietcap's own `financial-statement/metrics` (titleVi,
 * titleEn per field code) — no mapping table is copied from anywhere. Statement
 * figures are raw ₫.
 *
 * Vietcap's `company/details` also carries its analysts' rating, target price and
 * projected return. Those are Vietcap's own research, not data: they are never
 * read, kept or shown (research §6.6). `details` below keeps a list of the fields
 * it may pass on, so a field Vietcap adds later is dropped by default too.
 */

const IQ = 'https://iq.vietcap.com.vn/api/iq-insight-service';
const TRADING = 'https://trading.vietcap.com.vn/api';
const SOURCE = 'vietcap';

const code = (symbol) => {
  const s = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(s)) throw new SourceError(SOURCE, `"${symbol}" is not a Vietnamese stock code.`);
  return s;
};

/** Vietcap's answers wrap the data; one that says it failed is a `SourceError`. */
async function iq(path, ctx) {
  const body = await getJson(SOURCE, `${IQ}${path}`, ctx);
  if (body && body.successful === false) throw new SourceError(SOURCE, `Vietcap said: ${String(body.msg || 'not successful').slice(0, 80)}.`);
  return body?.data;
}

/** The templates Vietcap's `comTypeCode` names. A bank has no gross profit; its lines differ. */
const TEMPLATES = { CT: 'corporate', NH: 'bank', CK: 'securities', BH: 'insurance' };

/**
 * The company, as far as it is data: names, sector, shares, market cap, foreign
 * ownership and room, listing date, a short summary. Kept a day for everybody.
 */
export async function details(symbol, ctx = {}) {
  const sym = code(symbol);
  return cached(`vietcap|details|${sym}`, ttlFor('profile'), async () => {
    const d = await iq(`/v1/company/details?ticker=${sym}`, ctx);
    if (!d || !(d.ticker || d.organCode)) throw new SourceError(SOURCE, `Vietcap has no details for ${sym}.`);
    // Only these fields, by name — never rating, target, analyst, upside or projected return.
    return {
      symbol: d.ticker || d.organCode,
      name_vi: d.viOrganName,
      name_en: d.enOrganName,
      template: TEMPLATES[d.comTypeCode] || 'corporate',
      sector_vi: d.sectorVn,
      sector_en: d.sector,
      shares: num(d.issueShare),
      marketCap: num(d.marketCap),
      foreignOwned: num(d.foreignerPercentage),
      foreignLimit: num(d.maximumForeignPercentage),
      stateOwned: num(d.statePercentage),
      freeFloat: num(d.freeFloatPercentage),
      listed: String(d.listingDate || '').slice(0, 10) || undefined,
      high52w: num(d.highestPrice1Year),
      low52w: num(d.lowestPrice1Year),
      summary: plainText(d.enProfile || d.profile, 400),
      source: SOURCE,
    };
  });
}

/** The profile is the details. */
export const profile = details;

/** Vietcap's labels for each field code of a company's statements, kept a day. */
export async function metrics(symbol, ctx = {}) {
  const sym = code(symbol);
  return cached(`vietcap|metrics|${sym}`, ttlFor('metrics'), async () => {
    const data = await iq(`/v1/company/${sym}/financial-statement/metrics`, ctx);
    if (!data || typeof data !== 'object') throw new SourceError(SOURCE, `Vietcap has no statement labels for ${sym}.`);
    const out = {};
    for (const [section, list] of Object.entries(data)) {
      if (!Array.isArray(list)) continue;
      out[section] = list.map((m, order) => ({ field: m.field, vi: m.titleVi, en: m.titleEn, level: num(m.level), order }));
    }
    return out;
  });
}

const SECTIONS = { income: 'INCOME_STATEMENT', balance: 'BALANCE_SHEET', cashflow: 'CASH_FLOW' };

/**
 * The headline lines of a company's (corporate template) statements — this app's
 * choice of which of Vietcap's lines to show, labelled by Vietcap. Other templates
 * show their first level-one lines that carry a figure.
 */
const HEADLINE = {
  income: ['isa1', 'isa3', 'isa4', 'isa5', 'isa6', 'isa7', 'isa8', 'isa9', 'isa10', 'isa11', 'isa16', 'isa19', 'isa20', 'isa22', 'isa23'],
  balance: ['bsa1', 'bsa2', 'bsa5', 'bsa8', 'bsa15', 'bsa23', 'bsa29', 'bsa43', 'bsa53', 'bsa54', 'bsa55', 'bsa67', 'bsa78', 'bsa96'],
  cashflow: ['cfa1', 'cfa2', 'cfa18', 'cfa19', 'cfa20', 'cfa26', 'cfa27', 'cfa29', 'cfa30', 'cfa32', 'cfa34', 'cfa35', 'cfa36'],
};

/**
 * Four periods of one statement, newest first, raw ₫, with the template
 * (corporate, bank, securities, insurance) and each period's publish date.
 */
export async function statements(symbol, kind = 'income', period = 'year', ctx = {}) {
  const sym = code(symbol);
  const section = SECTIONS[kind] || SECTIONS.income;
  const [data, labels, company] = await Promise.all([
    iq(`/v1/company/${sym}/financial-statement?section=${section}`, ctx),
    metrics(sym, ctx),
    details(sym, ctx).catch(() => null),
  ]);
  const rows = (period === 'quarter' ? data?.quarters : data?.years) || [];
  const ordered = rows
    .filter((r) => num(r.yearReport) !== null)
    .sort((a, b) => num(b.yearReport) - num(a.yearReport) || num(b.lengthReport) - num(a.lengthReport))
    .slice(0, 4);
  if (!ordered.length) throw new SourceError(SOURCE, `Vietcap has no ${kind} statement for ${sym}.`);
  const known = labels[section] || [];
  const template = company?.template || 'corporate';
  const hasFigure = (field) => ordered.some((r) => num(r[field]) !== null && num(r[field]) !== 0);
  const chosen =
    template === 'corporate'
      ? HEADLINE[kind].map((field) => known.find((m) => m.field === field)).filter((m) => m && hasFigure(m.field))
      : known.filter((m) => m.level === 1 && hasFigure(m.field)).slice(0, 15);
  if (!chosen.length) throw new SourceError(SOURCE, `Vietcap's ${kind} statement for ${sym} has no lines it labels.`);
  return {
    symbol: sym,
    kind,
    period,
    unit: 'VND',
    template,
    periods: ordered.map((r) => ({ label: period === 'quarter' ? `Q${r.lengthReport} ${r.yearReport}` : String(r.yearReport), published: String(r.publicDate || '').slice(0, 10) || undefined })),
    lines: chosen.map((m) => ({ code: m.field, label_vi: m.vi, label_en: m.en, values: ordered.map((r) => num(r[m.field])) })),
    source: SOURCE,
  };
}

/**
 * The ratios Vietcap computes, for the latest quarter (trailing twelve months).
 * Its field names are the metadata; these are their usual names. Fractions are
 * marked so they are shown as percentages.
 */
const RATIOS = [
  ['pe', 'P/E', 'P/E'],
  ['pb', 'P/B', 'P/B'],
  ['ps', 'P/S', 'P/S'],
  ['evToEbitda', 'EV/EBITDA', 'EV/EBITDA'],
  ['roe', 'ROE', 'ROE', 'fraction'],
  ['roa', 'ROA', 'ROA', 'fraction'],
  ['grossMargin', 'Biên lợi nhuận gộp', 'Gross margin', 'fraction'],
  ['afterTaxProfitMargin', 'Biên lợi nhuận ròng', 'Net margin', 'fraction'],
  ['debtToEquity', 'Nợ/Vốn chủ sở hữu', 'Debt to equity'],
  ['currentRatio', 'Hệ số thanh toán hiện hành', 'Current ratio'],
  ['dividendYield', 'Tỷ suất cổ tức', 'Dividend yield', 'fraction'],
  ['marketCap', 'Vốn hoá thị trường', 'Market capitalisation', 'money'],
  ['npl', 'Tỷ lệ nợ xấu (NPL)', 'Non-performing loans', 'fraction'],
  ['car', 'Hệ số an toàn vốn (CAR)', 'Capital adequacy (CAR)', 'fraction'],
  ['casaRatio', 'Tỷ lệ CASA', 'CASA ratio', 'fraction'],
  ['netInterestMargin', 'Biên lãi thuần (NIM)', 'Net interest margin', 'fraction'],
  ['ldrLoanDepositRatio', 'Tỷ lệ cho vay/huy động (LDR)', 'Loan to deposit', 'fraction'],
];

export async function ratios(symbol, ctx = {}) {
  const sym = code(symbol);
  const data = await iq(`/v1/company/${sym}/statistics-financial`, ctx);
  const rows = (Array.isArray(data) ? data : []).filter((r) => num(r.yearReport ?? r.year) !== null);
  rows.sort((a, b) => num(a.yearReport ?? a.year) - num(b.yearReport ?? b.year) || num(a.quarter) - num(b.quarter));
  const latest = [...rows].reverse().find((r) => num(r.pe) !== null || num(r.roe) !== null);
  if (!latest) throw new SourceError(SOURCE, `Vietcap has no ratios for ${sym}.`);
  const items = RATIOS.filter(([key]) => num(latest[key]) !== null && num(latest[key]) !== 0).map(([key, vi, en, kind]) => ({ key, label_vi: vi, label_en: en, value: num(latest[key]), ...(kind ? { kind } : {}) }));
  return { symbol: sym, asOf: `Q${latest.quarter} ${latest.yearReport ?? latest.year} (TTM)`, currency: 'VND', items, source: SOURCE };
}

const EVENT_CODES = 'DIV,ISS,DDIND,DDINS,DDRP,AGME,AGMR,EGME,AIS,MA,MOVE,NLIS,OTHE,RETU,SUSP';

/** Corporate actions — dividends, share issues, meetings — with their ex-dates, newest first. */
export async function events(symbol, { from, to }, ctx = {}) {
  const sym = code(symbol);
  const data = await iq(`/v1/events?${new URLSearchParams({ ticker: sym, fromDate: compact(from), toDate: compact(to), eventCode: EVENT_CODES, page: '0', size: '20' })}`, ctx);
  const list = Array.isArray(data?.content) ? data.content : [];
  if (!list.length) throw new SourceError(SOURCE, `Vietcap lists no events for ${sym} from ${from} to ${to}.`);
  const day = (v) => String(v || '').slice(0, 10) || undefined;
  return list
    .map((e) => ({
      date: day(e.exrightDate) || day(e.publicDate) || day(e.displayDate1) || '',
      code: e.eventCode,
      title_vi: e.eventTitleVi,
      title_en: e.eventTitleEn,
      exDate: day(e.exrightDate),
      recordDate: day(e.recordDate),
      payDate: day(e.payoutDate),
      ratio: num(e.exerciseRatio),
      valuePerShare: num(e.valuePerShare),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Headlines and disclosures. Not probed beyond its status; read for the fields
 * such lists carry, and a shape it does not know is a `SourceError`.
 */
export async function news(symbol, { from, to }, ctx = {}) {
  const sym = code(symbol);
  const data = await iq(`/v1/news?${new URLSearchParams({ ticker: sym, fromDate: compact(from), toDate: compact(to), languageId: '1', page: '0', size: '8' })}`, ctx);
  const list = Array.isArray(data?.content) ? data.content : Array.isArray(data) ? data : [];
  const items = list
    .map((n) => ({ date: String(n.publicDate || n.publishDate || n.date || '').slice(0, 10), title: plainText(n.newsTitle || n.title || '', 200), publisher: n.newsSource || n.source || undefined, url: n.newsSourceLink || n.url || n.link || '' }))
    .filter((n) => n.title && /^https?:\/\//.test(n.url));
  if (!items.length) throw new SourceError(SOURCE, `Vietcap has no news for ${sym} that this can read.`);
  return items;
}

/** The codes in one of Vietcap's listings — VN30, HOSE, HNX, UPCOM, ETF, CW, FU_INDEX — kept a day. */
export async function group(name, ctx = {}) {
  const list = String(name || '').toUpperCase();
  if (!/^(VN30|HOSE|HNX|UPCOM|ETF|CW|FU_INDEX|HNX30|VN100)$/.test(list)) throw new SourceError(SOURCE, `Vietcap has no listing called ${name}.`);
  return cached(`vietcap|listings|${list}`, ttlFor('listings'), async () => {
    const data = await getJson(SOURCE, `${TRADING}/price/symbols/getByGroup?group=${list}`, ctx);
    const codes = (Array.isArray(data) ? data : []).map((r) => String(r?.symbol || '').toUpperCase()).filter(Boolean);
    if (!codes.length) throw new SourceError(SOURCE, `Vietcap's ${list} listing came back empty.`);
    return codes;
  });
}
