import { getJson, SourceError } from '../http.js';
import { num } from '../util.js';

/**
 * Economic series (research §3.8), each with the credit its terms ask for:
 *
 *   - World Bank — annual, every country, CC BY 4.0.
 *   - FRED — US series, only with the owner's free `FRED_API_KEY`, and always with
 *     its notice. Only FRED's own series are mapped here; third-party series need
 *     their owner's permission beyond personal use.
 *   - ECB — euro-area policy rate and inflation, "Source: ECB statistics."
 *   - NSO (Vietnam's statistics office) — its PX-Web answers a GET with the list of
 *     its databases, but a figure needs a POST query, which this version does not
 *     make: it says so rather than pretend.
 */

export const ATTRIBUTION = {
  worldbank: 'World Bank Open Data, CC BY 4.0',
  fred: 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.',
  ecb: 'Source: ECB statistics.',
  nso: 'General Statistics Office of Vietnam (NSO)',
};

/** Plain words for the series people ask for, per source. */
const INDICATORS = {
  gdp: { wb: 'NY.GDP.MKTP.KD.ZG', fred: { id: 'A191RL1Q225SBEA', label: 'Real GDP growth, annualised quarterly rate', unit: '%' } },
  'gdp per capita': { wb: 'NY.GDP.PCAP.CD' },
  cpi: { wb: 'FP.CPI.TOTL.ZG', fred: { id: 'CPIAUCSL', units: 'pc1', label: 'Consumer prices, change from a year earlier', unit: '%' }, ecb: { flow: 'ICP', key: 'M.U2.N.000000.4.ANR', label: 'Euro-area HICP inflation, annual rate', unit: '%' } },
  inflation: { alias: 'cpi' },
  unemployment: { wb: 'SL.UEM.TOTL.ZS', fred: { id: 'UNRATE', label: 'Unemployment rate', unit: '%' } },
  rate: { wb: 'FR.INR.LEND', fred: { id: 'FEDFUNDS', label: 'Federal funds effective rate', unit: '%' }, ecb: { flow: 'FM', key: 'B.U2.EUR.4F.KR.MRR_FR.LEV', label: 'ECB main refinancing rate', unit: '%' } },
  'interest rate': { alias: 'rate' },
  '10y': { fred: { id: 'DGS10', label: 'US 10-year Treasury yield', unit: '%' } },
  population: { wb: 'SP.POP.TOTL' },
  exports: { wb: 'NE.EXP.GNFS.ZS' },
  fdi: { wb: 'BX.KLT.DINV.WD.GD.ZS' },
};

/** What an indicator means to one source: a code (and how to read it), or null. */
export function indicatorFor(source, indicator) {
  const raw = String(indicator || '').trim();
  let entry = INDICATORS[raw.toLowerCase()];
  if (entry?.alias) entry = INDICATORS[entry.alias];
  if (entry) {
    if (source === 'worldbank') return entry.wb ? { id: entry.wb } : null;
    return entry[source] || null;
  }
  // A code given as is: World Bank codes have dots (NY.GDP.MKTP.KD.ZG); FRED ids do not (DGS10).
  if (source === 'worldbank' && /^[A-Z]{2,3}(\.[A-Z0-9]+){1,6}$/i.test(raw)) return { id: raw.toUpperCase() };
  if (source === 'fred' && /^[A-Z0-9]{3,25}$/i.test(raw)) return { id: raw.toUpperCase() };
  return null;
}

const unitFrom = (name) => (/%/.test(String(name)) ? '%' : /current US\$/i.test(String(name)) ? 'USD' : '');

/** World Bank: the last `n` non-empty years of one indicator for one country (ISO2/ISO3, or WLD). */
export async function worldBank(country, indicator, n = 6, ctx = {}) {
  const found = indicatorFor('worldbank', indicator);
  if (!found) throw new SourceError('worldbank', `The World Bank has no series called "${indicator}".`);
  const where = String(country || 'WLD').trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(where)) throw new SourceError('worldbank', `"${country}" is not a country code.`);
  const data = await getJson('worldbank', `https://api.worldbank.org/v2/country/${where}/indicator/${found.id}?${new URLSearchParams({ format: 'json', mrnev: String(Math.min(30, Math.max(1, n))) })}`, ctx);
  const rows = Array.isArray(data?.[1]) ? data[1].filter((r) => num(r.value) !== null) : [];
  if (!rows.length) throw new SourceError('worldbank', `The World Bank has no ${found.id} for ${where}${data?.[0]?.message ? ` (${JSON.stringify(data[0].message).slice(0, 80)})` : ''}.`);
  return {
    indicator: rows[0].indicator?.value || found.id,
    code: found.id,
    country: rows[0].country?.value || where,
    unit: unitFrom(rows[0].indicator?.value),
    frequency: 'annual',
    points: rows.map((r) => ({ date: String(r.date), value: num(r.value) })).sort((a, b) => b.date.localeCompare(a.date)),
    source: 'worldbank',
    attribution: [ATTRIBUTION.worldbank],
  };
}

/** FRED: the latest `n` observations of one series. Needs `FRED_API_KEY`. */
export async function fred(indicator, n = 12, ctx = {}) {
  const key = String(process.env.FRED_API_KEY || '').trim();
  if (!key) throw new SourceError('fred', 'FRED needs FRED_API_KEY (free, from fred.stlouisfed.org) set on the deployment.');
  const found = indicatorFor('fred', indicator);
  if (!found) throw new SourceError('fred', `FRED has no series called "${indicator}".`);
  const params = { series_id: found.id, api_key: key, file_type: 'json', sort_order: 'desc', limit: String(Math.min(60, Math.max(1, n))), ...(found.units ? { units: found.units } : {}) };
  const data = await getJson('fred', `https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams(params)}`, ctx);
  const points = (data?.observations || []).map((o) => ({ date: o.date, value: num(o.value) })).filter((p) => p.value !== null);
  if (!points.length) throw new SourceError('fred', `FRED has no observations for ${found.id}.`);
  return { indicator: found.label || found.id, code: found.id, country: 'United States', unit: found.unit || '', frequency: 'as published', points, source: 'fred', attribution: [ATTRIBUTION.fred] };
}

/** An ECB series (euro area): the latest `n` observations. */
export async function ecbSeries(indicator, n = 12, ctx = {}) {
  const found = indicatorFor('ecb', indicator);
  if (!found) throw new SourceError('ecb', `The ECB series here are rate and cpi, not "${indicator}".`);
  const data = await getJson('ecb', `https://data-api.ecb.europa.eu/service/data/${found.flow}/${found.key}?${new URLSearchParams({ lastNObservations: String(Math.min(60, Math.max(1, n))), format: 'jsondata' })}`, ctx);
  const times = data?.structure?.dimensions?.observation?.[0]?.values || [];
  const series = Object.values(data?.dataSets?.[0]?.series || {})[0];
  const points = Object.entries(series?.observations || {})
    .map(([i, o]) => ({ date: times[Number(i)]?.id, value: num(o?.[0]) }))
    .filter((p) => p.date && p.value !== null)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!points.length) throw new SourceError('ecb', `The ECB has no observations for ${found.label}.`);
  return { indicator: found.label, code: `${found.flow}.${found.key}`, country: 'Euro area', unit: found.unit, frequency: 'as published', points, source: 'ecb', attribution: [ATTRIBUTION.ecb] };
}

/** NSO's databases, which a GET can list. */
export async function nsoDatabases(ctx = {}) {
  const data = await getJson('nso', 'https://pxweb.nso.gov.vn/api/v1/vi/', ctx);
  const list = (Array.isArray(data) ? data : []).map((d) => String(d?.text || d?.dbid || '').trim()).filter(Boolean);
  if (!list.length) throw new SourceError('nso', 'NSO listed no databases.');
  return list;
}

/** An NSO figure: not in this version — a query is a POST. Says which databases there are. */
export async function nso(indicator, ctx = {}) {
  const list = await nsoDatabases(ctx);
  throw new SourceError('nso', `NSO's figures need a POST query, which this version does not make (no "${indicator}" from it). Its databases: ${list.slice(0, 12).join(', ')}.`);
}
