import { getStore } from './store/index.js';
import { log } from './util/trace.js';

/**
 * Free tiers, kept to (owner, 2026-11-02): this deployment pays nothing.
 *
 * Every paid service here has a free allowance, and every allowance belongs to
 * the deployment — one key, every account's searches drawn from it. It is
 * never one allowance per person, nor per person's address: the server makes
 * the calls, from its own address. So it is counted here, once for everyone,
 * in the database every serverless instance shares, and a service that has
 * used its allowance for the period stands aside until the period turns. The
 * free engines — DuckDuckGo, Stack Exchange — carry on meanwhile.
 *
 * The allowances (checked 2026-11-02), each ceiling a little under the real
 * one so a count that is a call or two behind never crosses it:
 *   - Exa: $10 of credit a month, no card. Counted in thousandths of a
 *     dollar, from the cost Exa reports on each answer.
 *   - Tavily: 1,000 credits a month, no card; basic is 1, advanced 2.
 *   - Brave: $5 of credit a month (about 1,000 searches) — but Brave keeps a
 *     card on file with no spending cap, so this count is what stands between
 *     a busy month and a bill. Set a usage limit in Brave's dashboard too.
 *   - Google search through the deployment's Gemini key: a daily free quota.
 *     An account's own key is its own and not counted here.
 *   - Stack Exchange: 300 requests a day per server address without a key,
 *     10,000 with a free one (STACKEXCHANGE_KEY, from stackapps.com).
 *
 * Each ceiling can be set (EXA_FREE_MILLS, TAVILY_FREE_CREDITS,
 * BRAVE_FREE_REQUESTS, GOOGLE_FREE_DAILY, STACKEXCHANGE_FREE_DAILY), and
 * FREE_TIER_ONLY=false lifts them all, for a deployment that pays.
 *
 * And a fair share: an account may make FREE_TIER_USER_DAILY metered searches
 * a day (30 by default). Past that its searches go to the free engines, so one
 * person cannot spend everyone's month in an afternoon.
 */

const num = (name, fallback) => {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Each service's ceiling and the period it resets on. */
const TIERS = {
  exa: { per: 'month', limit: () => num('EXA_FREE_MILLS', 9_500) },
  tavily: { per: 'month', limit: () => num('TAVILY_FREE_CREDITS', 950) },
  brave: { per: 'month', limit: () => num('BRAVE_FREE_REQUESTS', 950) },
  google: { per: 'day', limit: () => num('GOOGLE_FREE_DAILY', 450) },
  stackexchange: { per: 'day', limit: () => num('STACKEXCHANGE_FREE_DAILY', process.env.STACKEXCHANGE_KEY ? 9_500 : 280) },
};

export const FREE_SERVICES = Object.keys(TIERS);

/** Whether the ceilings hold — they do unless FREE_TIER_ONLY says otherwise. */
export const freeTierOnly = () => !/^(0|false|no|off)$/i.test(String(process.env.FREE_TIER_ONLY || '').trim());

/** The period a moment falls in, in UTC — the month for monthly credit, the day for daily quotas — and when it ends. */
export function periodOf(per, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const month = `${y}-${String(m + 1).padStart(2, '0')}`;
  if (per === 'month') return { key: month, ends: new Date(Date.UTC(y, m + 1, 1)) };
  return { key: `${month}-${String(d).padStart(2, '0')}`, ends: new Date(Date.UTC(y, m, d + 1)) };
}

const bucketOf = (service, now) => {
  const { key, ends } = periodOf(TIERS[service].per, now);
  return { bucket: `free:${service}:${key}`, ends };
};

/**
 * What is left of a service's allowance this period, beside its ceiling.
 * Unbounded when the ceilings are off, or when the count cannot be read — the
 * services with no card on file refuse by themselves once they are spent.
 *
 * @returns {Promise<{ left: number, limit: number }>}
 */
export async function allowance(service, now = new Date()) {
  const tier = TIERS[service];
  if (!tier || !freeTierOnly()) return { left: Infinity, limit: Infinity };
  const limit = tier.limit();
  try {
    const used = await getStore().readCounter(bucketOf(service, now).bucket);
    return { left: Math.max(0, limit - used), limit };
  } catch {
    return { left: Infinity, limit };
  }
}

/** Count what a call spent. Always counted — the totals are worth having even with the ceilings off. */
export async function spend(service, amount, now = new Date()) {
  if (!TIERS[service] || !(Number(amount) > 0)) return;
  try {
    const { bucket, ends } = bucketOf(service, now);
    await getStore().addToCounter(bucket, amount, ends);
  } catch (err) {
    // No database at all is a script or a test, with nothing to count against.
    if (!/not ready yet/.test(String(err?.message))) log.warn('free tier: not counted', { service, error: String(err?.message || err).slice(0, 160) });
  }
}

/** Mark a service's allowance as used up for the period — when the service itself says so. */
export async function exhaust(service, now = new Date()) {
  const { left } = await allowance(service, now);
  if (Number.isFinite(left) && left > 0) await spend(service, left, now);
}

const userBucket = (userId, now) => `free:user:${userId}:${periodOf('day', now).key}`;

/** Whether this account may still use a metered engine today — its fair share of the pooled allowances. */
export async function mayMeter(userId, now = new Date()) {
  if (!freeTierOnly() || !userId) return true;
  try {
    return (await getStore().readCounter(userBucket(userId, now))) < num('FREE_TIER_USER_DAILY', 30);
  } catch {
    return true;
  }
}

/** One metered search counted against this account's share for today. */
export async function countMetered(userId, now = new Date()) {
  if (!userId) return;
  try {
    await getStore().addToCounter(userBucket(userId, now), 1, periodOf('day', now).ends);
  } catch {
    /* a share that cannot be counted is not worth failing a search over */
  }
}

/**
 * Exa's price for one search, in thousandths of a dollar (exa.ai/pricing,
 * 2026-11-02): the search by type, a dollar per thousand pages for each kind
 * of content asked for, and a dollar per thousand results past ten. Used
 * before a call to see whether it fits, and after when Exa does not say.
 */
const EXA_SEARCH_MILLS = { lite: 4, instant: 4, fast: 7, auto: 7, deep: 12, 'deep-reasoning': 15 };
export function exaMills(type, results, contentKinds = 1) {
  const n = Math.max(0, Number(results) || 0);
  return (EXA_SEARCH_MILLS[type] ?? 15) + n * contentKinds + Math.max(0, n - 10);
}

/** What Exa says a call cost, in thousandths of a dollar — or the estimate when it does not say. */
export const exaSpent = (json, estimate) => {
  const total = Number(json?.costDollars?.total);
  // Rounded up, but not by the float's own dust: 0.021 × 1000 is 21.000000000000004.
  return Number.isFinite(total) && total > 0 ? Math.ceil(total * 1000 - 1e-6) : estimate;
};

/** Each service's use this period, for the administrators' view. */
export async function freeTierReport(now = new Date()) {
  const rows = [];
  for (const service of FREE_SERVICES) {
    const { per, limit } = TIERS[service];
    const { bucket, ends } = bucketOf(service, now);
    const used = await getStore().readCounter(bucket).catch(() => null);
    rows.push({ service, per, limit: limit(), used, resets: ends.toISOString() });
  }
  return { enforced: freeTierOnly(), userDaily: num('FREE_TIER_USER_DAILY', 30), services: rows };
}
