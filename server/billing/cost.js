/**
 * What the deployment's paid keys cost this month, against what billing took in (owner, 2026-11-13): the admin card's margin.
 * The counts are spec A's: every paid call is counted in `paid:<service>@<keyId>:<month>` (keyPool.js `countPaid`), one counter per
 * key per UTC month. Free-key use costs nothing and is not counted here. Prices are the providers' pay-as-you-go list prices as
 * checked on 2026-11-12; a plan with a provider that differs is the owner's to correct here.
 */
import { getStore } from '../store/index.js';
import { POOLED, keyBucket, keysFor } from '../keyPool.js';
import { meteringRate } from './fx.js';

/** USD per unit, where the unit is the one keyPool counts in: Exa and E2B in mills ($0.001), the rest as named. Checked 2026-11-12. */
export const UNIT_USD = Object.freeze({ exa: 0.001, e2b: 0.001, tavily: 0.008, brave: 0.005, firecrawl: 0.005 });
const SERVICES = Object.keys(UNIT_USD);

/**
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ byService: Record<string, { units: number, usd: number, vnd: number }>, totalVnd: number, moneyInMonthVnd: number, marginVnd: number }>}
 */
export async function costOfMonth({ now = new Date() } = {}) {
  const store = getStore();
  const rate = await meteringRate();
  const byService = {};
  for (const service of SERVICES) {
    let units = 0;
    if (Object.hasOwn(POOLED, service)) {
      const keys = await keysFor(service, { fresh: true }).catch(() => []);
      const buckets = keys.map((k) => keyBucket(service, k.id, now, { paid: true })?.bucket).filter(Boolean);
      if (buckets.length) for (const n of (await store.readCounters(buckets)).values()) units += n;
    }
    const usd = units * UNIT_USD[service];
    byService[service] = { units, usd, vnd: Math.round(usd * rate) };
  }
  const totalVnd = SERVICES.reduce((sum, s) => sum + byService[s].vnd, 0);
  // Real money in this UTC month: plan purchases and pay-as-you-go usage, less what was refunded (simulated money is left out by the store).
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { entries } = await store.billingAdminFigures(start);
  const moneyInMonthVnd = Math.max(0, entries.plan.outVnd + entries.usage.outVnd - entries.refund.inVnd);
  return { byService, totalVnd, moneyInMonthVnd, marginVnd: moneyInMonthVnd - totalVnd };
}
