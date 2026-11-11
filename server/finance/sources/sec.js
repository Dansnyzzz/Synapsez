import { getJson, SourceError } from '../http.js';
import { cached, ttlFor } from '../cache.js';
import { num } from '../util.js';

/**
 * SEC EDGAR: US companies' reported figures, filings and a light cross-section —
 * public data, free for any use (research §1). SEC asks every client to say who
 * it is: http.js sends `SEC_USER_AGENT` ("Synapsez <contact email>", set by the
 * owner) and does not ask SEC at all without it, so the chain falls through to
 * Yahoo and the answer says why.
 *
 * Statements come from `companyfacts`, one call per company. A figure is often
 * reported several times — in its own year's 10-K and again as the comparative in
 * the next — so each period keeps one value: the one SEC assigned a `frame` to,
 * else the latest filed. Labels are SEC's own.
 */

const DATA = 'https://data.sec.gov';
const SOURCE = 'sec';

/** Ticker → [CIK, company name], from SEC's own list, kept a day for everybody. */
async function tickers(ctx) {
  return cached('sec|tickers||', ttlFor('sec-tickers'), async () => {
    const data = await getJson(SOURCE, 'https://www.sec.gov/files/company_tickers.json', ctx);
    const map = {};
    for (const row of Object.values(data || {})) {
      if (row && typeof row === 'object' && row.ticker && num(row.cik_str) !== null) map[String(row.ticker).toUpperCase()] = [num(row.cik_str), row.title];
    }
    if (!Object.keys(map).length) throw new SourceError(SOURCE, "SEC's ticker list came back empty.");
    return map;
  });
}

/** The 10-digit CIK of a ticker, and the company's name. */
export async function cik(ticker, ctx = {}) {
  const t = String(ticker || '').trim().toUpperCase().replace(/\./g, '-');
  const hit = (await tickers(ctx))[t];
  if (!hit) throw new SourceError(SOURCE, `SEC has no company with the ticker ${t}.`);
  return { cik: String(hit[0]).padStart(10, '0'), cikNumber: hit[0], name: hit[1] };
}

/** Headline lines, each a list of US-GAAP tags tried in order — the newest-reported one wins. */
const LINES = {
  income: [
    ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
    ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    ['GrossProfit'],
    ['ResearchAndDevelopmentExpense'],
    ['SellingGeneralAndAdministrativeExpense'],
    ['OperatingExpenses'],
    ['OperatingIncomeLoss'],
    ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
    ['IncomeTaxExpenseBenefit'],
    ['NetIncomeLoss', 'ProfitLoss'],
    ['EarningsPerShareBasic'],
    ['EarningsPerShareDiluted'],
    ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  ],
  balance: [
    ['Assets'],
    ['AssetsCurrent'],
    ['CashAndCashEquivalentsAtCarryingValue'],
    ['AccountsReceivableNetCurrent'],
    ['InventoryNet'],
    ['PropertyPlantAndEquipmentNet'],
    ['Liabilities'],
    ['LiabilitiesCurrent'],
    ['LongTermDebtNoncurrent', 'LongTermDebt'],
    ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    ['LiabilitiesAndStockholdersEquity'],
  ],
  cashflow: [
    ['NetCashProvidedByUsedInOperatingActivities'],
    ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization'],
    ['ShareBasedCompensation'],
    ['NetCashProvidedByUsedInInvestingActivities'],
    ['PaymentsToAcquirePropertyPlantAndEquipment'],
    ['NetCashProvidedByUsedInFinancingActivities'],
    ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    ['PaymentsForRepurchaseOfCommonStock'],
  ],
};

const ANNUAL_FORMS = /^(10-K|20-F|40-F)/;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/**
 * One value per period for one tag: annual (a year's span, or a year-end instant)
 * or quarterly (a quarter's span, or an instant). Where a period was reported more
 * than once, the fact SEC gave a `frame` wins, else the latest filed.
 *
 * @returns {Map<string, { end: string, val: number }>} by period end
 */
export function factsByPeriod(fact, period = 'year') {
  const unit = Object.keys(fact?.units || {})[0];
  const list = unit ? fact.units[unit] : [];
  const keep = new Map();
  for (const f of list) {
    if (!f?.end || num(f.val) === null) continue;
    if (f.start) {
      const span = days(f.start, f.end);
      if (period === 'year' ? span < 340 || span > 380 : span < 80 || span > 100) continue;
    } else if (period === 'year' ? !(f.fp === 'FY' && ANNUAL_FORMS.test(String(f.form || ''))) : !/^(10-Q|10-K)/.test(String(f.form || ''))) {
      continue;
    }
    if (period === 'year' && f.start && !ANNUAL_FORMS.test(String(f.form || ''))) continue;
    const held = keep.get(f.end);
    const better = !held || (!!f.frame && !held.frame) || (!!f.frame === !!held.frame && String(f.filed || '') > String(held.filed || ''));
    if (better) keep.set(f.end, { end: f.end, val: num(f.val), frame: f.frame, filed: f.filed });
  }
  return keep;
}

async function companyFacts(ticker, ctx) {
  const { cik: id, name } = await cik(ticker, ctx);
  const data = await getJson(SOURCE, `${DATA}/api/xbrl/companyfacts/CIK${id}.json`, { ...ctx, timeoutMs: 15_000 });
  const gaap = data?.facts?.['us-gaap'];
  if (!gaap) throw new SourceError(SOURCE, `SEC has no US-GAAP figures for ${String(ticker).toUpperCase()}.`);
  return { gaap, name: data.entityName || name, unitOf: (tag) => Object.keys(gaap[tag]?.units || {})[0] };
}

/**
 * Four periods of one statement, newest first, in the company's reporting unit
 * (USD; per-share lines in USD per share).
 */
export async function statements(ticker, kind = 'income', period = 'year', ctx = {}) {
  const { gaap, name } = await companyFacts(ticker, ctx);
  const lines = [];
  for (const candidates of LINES[kind] || LINES.income) {
    let best = null;
    for (const tag of candidates) {
      if (!gaap[tag]) continue;
      const byEnd = factsByPeriod(gaap[tag], period);
      const newest = [...byEnd.keys()].sort().at(-1);
      if (newest && (!best || newest > best.newest)) best = { tag, byEnd, newest, label: gaap[tag].label || tag, unit: Object.keys(gaap[tag].units || {})[0] };
    }
    if (best) lines.push(best);
  }
  if (!lines.length) throw new SourceError(SOURCE, `SEC has no ${kind} figures for ${String(ticker).toUpperCase()}.`);
  // The periods are the newest four of the first line that has them (revenue, assets, operating cash).
  const ends = [...lines[0].byEnd.keys()].sort().reverse().slice(0, 4);
  return {
    symbol: String(ticker).toUpperCase(),
    company: name,
    kind,
    period,
    unit: 'USD',
    periods: ends.map((end) => ({ label: period === 'year' ? `FY ${end.slice(0, 4)} (to ${end})` : `Quarter to ${end}` })),
    lines: lines.map((l) => ({ code: l.tag, label_vi: l.label, label_en: l.label, ...(l.unit && l.unit !== 'USD' ? { unit: l.unit } : {}), values: ends.map((end) => l.byEnd.get(end)?.val ?? null) })),
    source: SOURCE,
  };
}

/**
 * Ratios worked out from the latest annual filing and a price: P/E on diluted
 * EPS, ROE, ROA, net margin, liabilities to equity. Said to be computed.
 *
 * @param {string} ticker
 * @param {number | null} price  in USD, from the quote; P/E is left out without it
 * @param {Record<string, any>} [ctx]
 */
export async function ratios(ticker, price, ctx = {}) {
  // The balance sheet is a second view of the same filing; without it, the income-based ratios still stand.
  const [income, balance] = await Promise.all([statements(ticker, 'income', 'year', ctx), statements(ticker, 'balance', 'year', ctx).catch(() => null)]);
  const latest = (s, tags) => s?.lines.find((l) => tags.includes(l.code))?.values?.[0] ?? null;
  const revenue = latest(income, LINES.income[0]);
  const net = latest(income, LINES.income[9]);
  const eps = latest(income, ['EarningsPerShareDiluted']);
  const assets = latest(balance, ['Assets']);
  const liabilities = latest(balance, ['Liabilities']);
  const equity = latest(balance, LINES.balance[9]);
  const div = (a, b) => (a !== null && b ? a / b : null);
  const items = [
    ['pe', 'P/E (diluted EPS, last fiscal year)', price && eps > 0 ? price / eps : null],
    ['roe', 'ROE', div(net, equity), 'fraction'],
    ['roa', 'ROA', div(net, assets), 'fraction'],
    ['netMargin', 'Net margin', div(net, revenue), 'fraction'],
    ['debtToEquity', 'Liabilities to equity', div(liabilities, equity)],
  ]
    .filter(([, , value]) => value !== null && Number.isFinite(value))
    .map(([key, label, value, kind]) => ({ key, label_vi: label, label_en: label, value, ...(kind ? { kind } : {}) }));
  if (!items.length) throw new SourceError(SOURCE, `SEC's figures for ${String(ticker).toUpperCase()} are not enough to work out ratios.`);
  return { symbol: String(ticker).toUpperCase(), asOf: income.periods[0]?.label, currency: 'USD', computed: true, items, source: SOURCE, note: `Computed from SEC filings (${income.periods[0]?.label})${price ? ' and the latest price' : ''}.` };
}

async function submissions(ticker, ctx) {
  const id = await cik(ticker, ctx);
  return { id, data: await getJson(SOURCE, `${DATA}/submissions/CIK${id.cik}.json`, { ...ctx, timeoutMs: 15_000 }) };
}

/** The newest filings: date, form, what it is, a link to the document. */
export async function filings(ticker, n = 8, ctx = {}, { forms = null } = {}) {
  const { id, data } = await submissions(ticker, ctx);
  const r = data?.filings?.recent || {};
  const out = [];
  for (let i = 0; i < (r.form || []).length && out.length < n; i += 1) {
    if (forms && !forms.test(r.form[i])) continue;
    const accession = String(r.accessionNumber?.[i] || '');
    out.push({
      date: r.filingDate?.[i],
      form: r.form[i],
      title: r.primaryDocDescription?.[i] || r.form[i],
      items: r.items?.[i] || undefined,
      url: accession && r.primaryDocument?.[i] ? `https://www.sec.gov/Archives/edgar/data/${id.cikNumber}/${accession.replace(/-/g, '')}/${r.primaryDocument[i]}` : undefined,
    });
  }
  if (!out.length) throw new SourceError(SOURCE, `SEC lists no ${forms ? 'such ' : ''}filings for ${String(ticker).toUpperCase()}.`);
  return out;
}

/** 8-K filings as events: what a US company has said happened, newest first. */
export async function events(ticker, ctx = {}) {
  const list = await filings(ticker, 8, ctx, { forms: /^8-K/ });
  return list.map((f) => ({ date: f.date, code: f.form, title_en: `${f.form}${f.items ? ` (items ${f.items})` : ''}${f.title && f.title !== f.form ? ` — ${f.title}` : ''}`, title_vi: `${f.form}${f.items ? ` (mục ${f.items})` : ''}`, url: f.url }));
}

/** The company as SEC files it: name, exchanges, industry, fiscal year end, state. */
export async function profile(ticker, ctx = {}) {
  const { data } = await submissions(ticker, ctx);
  if (!data?.name) throw new SourceError(SOURCE, `SEC has no filer for ${String(ticker).toUpperCase()}.`);
  return {
    symbol: String(ticker).toUpperCase(),
    name: data.name,
    exchange: (data.exchanges || []).join(', ') || undefined,
    industry: data.sicDescription || undefined,
    fiscalYearEnd: data.fiscalYearEnd ? `${data.fiscalYearEnd.slice(0, 2)}-${data.fiscalYearEnd.slice(2)}` : undefined,
    incorporated: data.stateOfIncorporationDescription || undefined,
    website: data.website || undefined,
    source: SOURCE,
  };
}

/** Plain words for the figures a screen is asked about most, as US-GAAP tags; `instant` for balance-sheet ones. */
const SCREENS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', false],
  revenues: ['Revenues', false],
  'net income': ['NetIncomeLoss', false],
  netincome: ['NetIncomeLoss', false],
  profit: ['NetIncomeLoss', false],
  'operating income': ['OperatingIncomeLoss', false],
  assets: ['Assets', true],
  cash: ['CashAndCashEquivalentsAtCarryingValue', true],
  equity: ['StockholdersEquity', true],
  liabilities: ['Liabilities', true],
  'r&d': ['ResearchAndDevelopmentExpense', false],
};

/**
 * The 20 largest US filers by one reported figure in one period, from SEC frames
 * — one call, the only screen this layer offers (a Vietnamese one would mean
 * crawling a market). `period`: CY2025 for a year, CY2025Q2 for a quarter,
 * CY2025Q4I for a balance at a date; by default the last full year.
 */
export async function screen(indicator, period, ctx = {}, { now = new Date() } = {}) {
  const asked = String(indicator || 'revenue').trim();
  const named = SCREENS[asked.toLowerCase()];
  const tag = named ? named[0] : asked;
  if (!/^[A-Za-z][A-Za-z0-9]{2,120}$/.test(tag)) throw new SourceError(SOURCE, `"${asked}" is not a figure SEC frames know; try revenue, net income, assets, cash, equity, or a US-GAAP tag.`);
  const instant = named ? named[1] : false;
  const lastYear = now.getUTCFullYear() - 1;
  const frame = /^CY\d{4}(Q[1-4]I?)?$/.test(String(period || '')) ? String(period) : instant ? `CY${lastYear}Q4I` : `CY${lastYear}`;
  const data = await getJson(SOURCE, `${DATA}/api/xbrl/frames/us-gaap/${tag}/USD/${frame}.json`, { ...ctx, timeoutMs: 15_000 });
  const rows = (data?.data || [])
    .filter((r) => num(r.val) !== null)
    .sort((a, b) => num(b.val) - num(a.val))
    .slice(0, 20)
    .map((r) => ({ name: r.entityName, cik: r.cik, value: num(r.val), end: r.end }));
  if (!rows.length) throw new SourceError(SOURCE, `SEC has no ${tag} figures for ${frame}.`);
  return { tag, label: data.label || tag, period: frame, unit: 'USD', companies: num(data.pts), rows, source: SOURCE };
}
