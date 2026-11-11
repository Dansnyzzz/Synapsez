import { getJson, SourceError } from '../http.js';
import { num } from '../util.js';

/**
 * FMarket: Vietnamese open-ended funds — NAV, returns, fees, top holdings — by
 * product id (research §3.2). Its fund list and NAV history are POST-only, so a
 * GET-only build needs ids kept by hand: only the ones seen in the probes are
 * here, and a fund not in the list is said plainly rather than guessed.
 */

/** Fund code → FMarket product id. Seen in the research probes (2026-11-10). */
export const FUNDS = { VESAF: 23 };

/** One fund's latest NAV per unit, returns over time, fees and largest holdings. */
export async function fund(code, ctx = {}) {
  const key = String(code || '').trim().toUpperCase();
  const id = FUNDS[key];
  if (!id) throw new SourceError('fmarket', `FMarket's fund list can only be read with a POST, so only these funds are known here: ${Object.keys(FUNDS).join(', ')}. ${key || 'That fund'} is not one of them.`);
  const data = await getJson('fmarket', `https://api.fmarket.vn/res/products/${id}`, ctx);
  const p = data?.data;
  if (!p || num(p.nav) === null) throw new SourceError('fmarket', `FMarket had no NAV for ${key}.`);
  const c = p.productNavChange || {};
  return {
    code: p.shortName || p.code || key,
    name: p.name,
    manager: p.owner?.name || undefined,
    type: p.dataFundAssetType?.name || undefined,
    currency: 'VND',
    nav: num(p.nav),
    asOf: num(c.updateAt || p.updateAt) ? new Date(num(c.updateAt || p.updateAt)).toISOString() : undefined,
    returns: [
      ['previous', num(c.navToPrevious)],
      ['1m', num(c.navTo1Months)],
      ['12m', num(c.navTo12Months)],
      ['36m', num(c.navTo36Months)],
      ['36m annualised', num(c.annualizedReturn36Months)],
    ]
      .filter(([, v]) => v !== null)
      .map(([window, pct]) => ({ window, pct })),
    managementFee: num(p.managementFee),
    holdings: (p.productTopHoldingList || []).slice(0, 5).map((h) => ({ code: h.stockCode, industry: h.industry, pct: num(h.netAssetPercent) })),
    source: 'fmarket',
  };
}
