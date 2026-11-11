import { getJson, SourceError, throughFirecrawl } from '../http.js';
import { cached, ttlFor } from '../cache.js';
import { num } from '../util.js';
import * as yahoo from './yahoo.js';

/**
 * Gold. In Vietnam, SJC's own posted buying and selling prices per lượng (tael,
 * 37.5 g) — what people mean by "giá vàng SJC" — kept five minutes for everybody.
 * Elsewhere, the COMEX futures through Yahoo (USD per troy ounce): `GC=F` gold,
 * `SI=F` silver. A by-date SJC history needs a POST, which this does not make.
 * Read through Firecrawl (a credit of the free month each time), the board is kept half
 * an hour: SJC changes it a few times a day.
 */

const SJC = 'https://sjc.com.vn/GoldPrice/Services/PriceService.ashx';

/** "13:50 10/11/2026" in Hanoi → ISO. */
function sjcTime(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, h, mi, d, mo, y] = m;
  return new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00+07:00`).toISOString();
}

/** SJC's board: each kind of bar or ring, by branch, buying and selling in ₫ per lượng. */
export async function sjc(ctx = {}) {
  return cached('sjc|gold|SJC|', throughFirecrawl('sjc') ? Math.max(ttlFor('gold'), 30 * 60_000) : ttlFor('gold'), async () => {
    const data = await getJson('sjc', SJC, ctx);
    if (data?.success === false) throw new SourceError('sjc', 'SJC did not answer with prices.');
    const asOf = sjcTime(data?.latestDate) || new Date().toISOString();
    const rows = (data?.data || [])
      .map((r) => ({ name: String(r.TypeName || '').trim(), branch: String(r.BranchName || '').trim() || undefined, buy: num(r.BuyValue), sell: num(r.SellValue), unit: 'VND/lượng', asOf }))
      .filter((r) => r.name && (r.buy || r.sell));
    if (!rows.length) throw new SourceError('sjc', 'SJC posted no prices.');
    return rows;
  });
}

/** World gold (and silver) futures, USD per troy ounce. */
export async function world(ctx = {}) {
  const [gold, silver] = await Promise.all([yahoo.quote('GC=F', { ...ctx, market: 'global' }), yahoo.quote('SI=F', { ...ctx, market: 'global' }).catch(() => null)]);
  return [gold, silver].filter(Boolean).map((q) => ({ ...q, name: q.symbol === 'GC=F' ? 'Gold (COMEX futures)' : 'Silver (COMEX futures)', unit: 'USD/oz' }));
}
