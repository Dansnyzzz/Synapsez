/**
 * The day's USD to VND rate (owner, 2026-11-13). Plans are priced in dollars and charged in đồng,
 * so a price needs a rate that is honest and recent. The chain is open.er-api, then Vietcombank's
 * transfer rate, then Frankfurter, through the finance layer's own sources (their politeness caps
 * and attribution stay theirs). A rate is kept an hour in memory and in the `billing_fx` setting,
 * so every instance of a deployment agrees and a busy hour asks nobody. A rate older than 48 hours
 * is not good enough to charge with (`BillingUnavailable`): a stale price would be a wrong price.
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

export const RATE_ATTRIBUTION = 'Rates By Exchange Rate API: https://www.exchangerate-api.com';
const SETTING = 'billing_fx';
const FRESH_MS = 3_600_000;
const USABLE_MS = 48 * 3_600_000;
// A source that answers nonsense (a rate in thousands of dong, or in dollars) is skipped, not charged with.
const PLAUSIBLE = { min: 1_000, max: 1_000_000 };

/** The day's rate cannot be had, so nothing is priced or charged today. */
export class BillingUnavailable extends Error {
  constructor(message = 'The exchange rate is not available right now. Please try again in a little while.') {
    super(message);
    this.name = 'BillingUnavailable';
    this.status = 503;
  }
}

/** @typedef {{ rate: number, source: 'erapi' | 'vietcombank' | 'frankfurter', at: string }} Rate */
/** @type {Rate | null} */
let memory = null;

const usable = (e) => !!e && Number.isFinite(Number(e.rate)) && Number(e.rate) > 0 && Number.isFinite(Date.parse(e.at));
/** @returns {Rate} */
const clean = (e) => ({ rate: Number(e.rate), source: e.source, at: new Date(e.at).toISOString() });
const ageOf = (e, now) => now.getTime() - Date.parse(e.at);

async function stored() {
  try {
    let v = await getStore().getSetting(SETTING);
    if (typeof v === 'string') v = JSON.parse(v);
    return usable(v) ? clean(v) : null;
  } catch {
    return null;
  }
}

/** One source after another; the first plausible rate wins. */
/** @returns {Promise<Rate | null>} */
async function ask(now) {
  /** @type {Array<{ source: 'erapi' | 'vietcombank' | 'frankfurter', pick: (rows: any[]) => any }>} */
  const chain = [
    { source: 'erapi', pick: (rows) => rows[0] },
    { source: 'vietcombank', pick: (rows) => rows.find((r) => r.kind === 'bank-transfer') },
    { source: 'frankfurter', pick: (rows) => rows[0] },
  ];
  for (const { source, pick } of chain) {
    try {
      const got = await fromSource(source, 'USD', ['VND']);
      const rate = Number(pick(got.rates.filter((r) => r.quote === 'VND'))?.rate);
      if (Number.isFinite(rate) && rate >= PLAUSIBLE.min && rate <= PLAUSIBLE.max) return { rate, source, at: now.toISOString() };
    } catch {
      // The next source is asked; why this one failed is the finance layer's to say.
    }
  }
  return null;
}

/**
 * The rate to price and charge with: fresh (under an hour) if there is one, else asked for, else the last
 * known if it is under 48 hours old.
 *
 * @returns {Promise<Rate>}
 */
export async function usdVnd({ now = new Date() } = {}) {
  const fresh = (e) => !!e && ageOf(e, now) >= 0 && ageOf(e, now) < FRESH_MS;
  if (fresh(memory)) return memory;
  const kept = await stored();
  if (fresh(kept)) {
    memory = kept;
    return kept;
  }
  const got = await ask(now);
  if (got) {
    memory = got;
    try {
      await getStore().setSetting(SETTING, got);
    } catch {
      // Not remembering it costs another instance one more ask; it must not cost this order.
    }
    return got;
  }
  const last = [memory, kept].filter(Boolean).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (last && ageOf(last, now) <= USABLE_MS) return last;
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
