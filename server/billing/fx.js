/**
 * The day's USD to VND rate (owner, 2026-11-13). Plans are priced in dollars and charged in đồng,
 * so a price needs a rate that is honest and recent. The chain is Frankfurter, then Vietcombank's
 * transfer rate, then open.er-api (owner, 2026-11-16: Frankfurter asks for no attribution link, and
 * open.er-api asks for one wherever its rate shows), through the finance layer's own sources (their
 * politeness caps and attribution stay theirs). The rate is read once a day by the 06:00 Vietnam
 * cron (`refreshRate`) and kept in memory and in the `billing_fx` setting, so every instance of a
 * deployment agrees and a busy day asks nobody. A rate older than 48 hours is not good enough to
 * charge with (`BillingUnavailable`): a stale price would be a wrong price.
 *
 * Metering is the other side of this: a search or a minute of cloud computer must never wait on a
 * rate source, so `meteringRate` only ever reads what is already known.
 *
 * The memory below is one public number, the same for every account, never anything about a
 * person; losing it on a cold start costs one setting read.
 */
import { getStore } from '../store/index.js';
import { fromSource } from '../finance/sources/fx.js';
import { PAYG_ANCHOR_RATE } from './plans.js';
import { log } from '../util/trace.js';

export const RATE_ATTRIBUTION = 'Rates By Exchange Rate API: https://www.exchangerate-api.com';
const SETTING = 'billing_fx';
// 06:00 in Vietnam (UTC+7, no daylight saving) is 23:00 UTC the day before: the cron's hour.
export const REFRESH_UTC_HOUR = 23;
const USABLE_MS = 48 * 3_600_000;
// A source that slips a decimal point (2,565.585 would price Plus at 13,000đ) is skipped, not charged with: a rate must
// be within half to double the anchor and, when one is known, within 20% of the last one. Dong moves slowly.
const WITHIN_LAST = 0.2;
const plausible = (rate, last) => rate >= PAYG_ANCHOR_RATE * 0.5 && rate <= PAYG_ANCHOR_RATE * 2 && (!last || Math.abs(rate - last) <= last * WITHIN_LAST);

/** The day's rate cannot be had, so nothing is priced or charged today. */
export class BillingUnavailable extends Error {
  constructor(message = 'The exchange rate is not available right now. Please try again in a little while.') {
    super(message);
    this.name = 'BillingUnavailable';
    this.status = 503;
  }
}

/** @typedef {{ rate: number, source: 'erapi' | 'vietcombank' | 'frankfurter', at: string }} Rate */

// What this instance last read: one public number, the same for every account.
/** @type {Rate | null} */
let memory = null;

const usable = (e) => !!e && Number.isFinite(Number(e.rate)) && Number(e.rate) > 0 && Number.isFinite(Date.parse(e.at));
/** @returns {Rate} */
const clean = (e) => ({ rate: Number(e.rate), source: e.source, at: new Date(e.at).toISOString() });
const ageOf = (e, now) => now.getTime() - Date.parse(e.at);
const nextRefreshAfter = (ms) => {
  const d = new Date(ms);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), REFRESH_UTC_HOUR);
  return today > ms ? today : today + 86_400_000;
};
// Fresh until the next 06:00 Vietnam time after it was read; past that the cron is due to renew it, though it stays usable.
const fresh = (e, now) => !!e && ageOf(e, now) >= 0 && now.getTime() < nextRefreshAfter(Date.parse(e.at));
const newest = (...list) => list.filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;

async function stored() {
  try {
    let v = await getStore().getSetting(SETTING);
    if (typeof v === 'string') v = JSON.parse(v);
    return usable(v) ? clean(v) : null;
  } catch {
    return null;
  }
}

/**
 * One source after another; the first plausible rate wins.
 *
 * @returns {Promise<Rate | null>}
 */
async function ask(now, last) {
  /** @type {Array<{ source: 'erapi' | 'vietcombank' | 'frankfurter', pick: (rows: any[]) => any }>} */
  const chain = [
    { source: 'frankfurter', pick: (rows) => rows[0] },
    { source: 'vietcombank', pick: (rows) => rows.find((r) => r.kind === 'bank-transfer') },
    { source: 'erapi', pick: (rows) => rows[0] },
  ];
  for (const { source, pick } of chain) {
    try {
      const got = await fromSource(source, 'USD', ['VND']);
      const rate = Number(pick(got.rates.filter((r) => r.quote === 'VND'))?.rate);
      if (Number.isFinite(rate) && plausible(rate, last)) return { rate, source, at: now.toISOString() };
    } catch {
      // The next source is asked; why this one failed is the finance layer's to say.
    }
  }
  return null;
}

async function keep(got) {
  memory = got;
  try {
    await getStore().setSetting(SETTING, got);
  } catch {
    // Not remembering it costs another instance one more ask; it must not cost this order.
  }
}

// The band holds against a recent rate only: a stored rate older than we would charge with must not lock billing out for good.
const bandAgainst = (last, now) => (last && ageOf(last, now) <= USABLE_MS ? last.rate : null);

/**
 * The daily read, called by the 06:00 Vietnam cron: asks the chain unless the kept rate is still
 * fresh, so a repeated call the same day asks nobody (`force` asks regardless). Never throws; null
 * when no source answered, and the kept rate goes on being used until it is 48 hours old.
 *
 * @returns {Promise<Rate | null>}
 */
export async function refreshRate({ now = new Date(), force = false } = {}) {
  const last = newest(memory, await stored());
  if (!force && fresh(last, now)) {
    memory = last;
    return last;
  }
  const got = await ask(now, bandAgainst(last, now));
  if (!got) return null;
  await keep(got);
  return got;
}

/**
 * The rate to price and charge with: the one kept, while it is under 48 hours old (the cron renews it
 * daily and nothing asks a source in between). Asked for only on a cold start with nothing kept, or
 * when what is kept is too old to charge with.
 *
 * @returns {Promise<Rate>}
 */
export async function usdVnd({ now = new Date() } = {}) {
  if (fresh(memory, now)) return memory;
  const last = newest(memory, await stored());
  // A rate dated in the future (a clock that was wrong) is not trusted either: fresh() refuses it, so does this.
  if (last && ageOf(last, now) >= 0 && ageOf(last, now) <= USABLE_MS) {
    memory = last;
    return last;
  }
  // The only sign the 06:00 read is not running: a price had to wait for a source.
  if (last) log.warn('billing: the kept rate is too old to charge with, so the rate of the day is asked for now; is the 06:00 cron running?', { at: last.at });
  const got = await ask(now, bandAgainst(last, now));
  if (got) {
    await keep(got);
    return got;
  }
  throw new BillingUnavailable();
}

/** The last known rate of any age, else the anchor. Never fetches and never throws: a metered call is not held up for a rate. */
export async function meteringRate() {
  if (memory) return memory.rate;
  return (await stored())?.rate ?? PAYG_ANCHOR_RATE;
}

/** Tests: forget the per-instance memory (the setting stays). */
export function _resetFxForTests() {
  memory = null;
}
