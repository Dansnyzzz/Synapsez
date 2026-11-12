import { getStore } from './store/index.js';
import { log } from './util/trace.js';
import { periodOf, freeTierOnly, num, numIn, noDatabase } from './freeTierPeriod.js';
import { poolWindow, capacityOf, poolLimit, keyBucket, keyEntry, keyUsage, ceilingOf, countPaid, noteUse, creditBucket, paidKeyOf, poolReport } from './keyPool.js';

// Moved to freeTierPeriod.js so keyPool.js can read them without importing this file; still exported here.
export { periodOf, freeTierOnly, e2bMonthCap } from './freeTierPeriod.js';

/**
 * Free tiers, kept to (owner, 2026-11-02): this deployment pays nothing.
 *
 * Every paid service here has a free allowance, and every allowance belongs to
 * the deployment — its keys (several for some services, keyPool.js), every
 * account's searches drawn from them. It is
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
 *   - E2B, the cloud computer: a one-off credit, spread over the months before
 *     it lapses (`e2bMonthCap`). Its ceiling is worked out, not set.
 *   - Firecrawl (checked 2026-11-11, server/firecrawl.js): 1,000 credits a month on its
 *     Free plan, no card, a 402 at zero. Kept to 950 a key until Firecrawl says the
 *     key's plan (FIRECRAWL_FREE_CREDITS), shared as the owner chose: searches 60%
 *     (570 of one Free key; FIRECRAWL_SEARCH_FREE sets a figure outright), pages read 35%
 *     (FIRECRAWL_SCRAPE_FREE), site maps, crawls and code 5% (FIRECRAWL_MORE_FREE) — each
 *     share and the whole counted. Its Research and Government Indexes cost no credits
 *     but a thousand calls a day: 950 a key (FIRECRAWL_INDEX_FREE_DAILY).
 *
 * Each ceiling can be set (EXA_FREE_MILLS, TAVILY_FREE_CREDITS,
 * BRAVE_FREE_REQUESTS, GOOGLE_FREE_DAILY, STACKEXCHANGE_FREE_DAILY), and
 * FREE_TIER_ONLY=false lifts them all, for a deployment that pays.
 *
 * And a fair share: an account may make FREE_TIER_USER_DAILY metered searches
 * a day (30 by default). Past that its searches go to the free engines, so one
 * person cannot spend everyone's month in an afternoon.
 *
 * Market data (checked 2026-11-10, docs/research/2026-11-10-finance-sources.md §4),
 * counted by server/finance/http.js before each call:
 *   - CoinGecko Demo: 10,000 credits a month and 100 a minute, no card — kept to
 *     9,500 (COINGECKO_FREE_MONTHLY) and 90 a minute (COINGECKO_FREE_MINUTE). The
 *     one metered market source.
 *   - Polite caps on the keyless ones, which bill nothing and publish no limit, so
 *     the deployment never leans on a source harder than an on-demand tool should:
 *     Yahoo 5,000 a day (YAHOO_FREE_DAILY); VNDirect, KBS and Vietcap 3,000 a day
 *     each (VNDIRECT_FREE_DAILY, KBS_FREE_DAILY, VIETCAP_FREE_DAILY); SEC 20,000 a
 *     day (SEC_FREE_DAILY, under its 10 a second); FRED 100 a minute
 *     (FRED_FREE_MINUTE, under its ~120).
 * These go through `take` only, never the per-account fair share (`mayMeter`):
 * a price is cached for everyone, so one account asking does not use another's.
 * A ceiling reached moves the finance chain to its next source.
 *
 * Several keys (spec A, owner 2026-11-12, server/keyPool.js): Exa, Tavily and
 * Firecrawl may each have up to ten, the environment's first; Brave and E2B keep one.
 * Each is counted on its own — `take`, `spend`, `refund` and `exhaust` take `{ keyId }`,
 * the environment key's when it is left out, so a call written before keys keeps
 * working — and each figure above is now a key's: a service's allowance is the sum
 * of its keys'. Firecrawl's ceiling for a key is 95% of the plan Firecrawl reports
 * for it (Hobby's 5,000 → 4,750), its shares (searches 60%, pages 35%, the rest 5%)
 * shares of the sum, and its free indexes 950 calls a day for each key. A key's
 * calls past its free ceiling on the owner's paid key (`{ paid: true }`) are counted
 * apart as well (`paid:<service>@<keyId>:<month>`), up to that key's monthly cap.
 * The fair shares (`mayMeter`, `e2bAccountAllowance`) stay per person; only their
 * pot, the service's sum, grows.
 */

/** The whole credit's count outlives any month; it only has to outlast the credit. */
const LIFETIME_END = new Date(Date.UTC(2100, 0, 1));

/** A service counted per key (keyPool.js): its period and ceilings are the pool's. */
const pooled = (id) => ({ per: poolWindow(id).per, pooled: true, billed: !!poolWindow(id).billed });
/** One of Firecrawl's shares of all its keys' credits — or the absolute figure the owner set, as before. */
const share = (fraction, name) => ({ per: 'month', share: fraction, env: name });

/**
 * Each service's ceiling and the period it resets on.
 *
 * @type {Record<string, { per: string, limit?: () => number, pooled?: boolean, billed?: boolean, share?: number, env?: string }>}
 */
const TIERS = {
  exa: pooled('exa'),
  tavily: pooled('tavily'),
  // `billed`: a card on file and no cap of the service's own — see `take`.
  brave: pooled('brave'),
  google: { per: 'day', limit: () => num('GOOGLE_FREE_DAILY', 450) },
  stackexchange: { per: 'day', limit: () => num('STACKEXCHANGE_FREE_DAILY', process.env.STACKEXCHANGE_KEY ? 9_500 : 280) },
  // The cloud computer's machine time, in thousandths of a dollar (server/e2b.js), its ceiling worked out per key.
  e2b: pooled('e2b'),
  // Firecrawl: the month's credits, and each share of them (server/firecrawl.js).
  firecrawl: pooled('firecrawl'),
  firecrawl_search: share(0.6, 'FIRECRAWL_SEARCH_FREE'),
  firecrawl_scrape: share(0.35, 'FIRECRAWL_SCRAPE_FREE'),
  firecrawl_more: share(0.05, 'FIRECRAWL_MORE_FREE'),
  firecrawl_index: pooled('firecrawl_index'),
  // Market data (server/finance/http.js): see the header for each figure.
  coingecko: { per: 'month', limit: () => num('COINGECKO_FREE_MONTHLY', 9_500) },
  coingecko_minute: { per: 'minute', limit: () => num('COINGECKO_FREE_MINUTE', 90) },
  yahoo: { per: 'day', limit: () => num('YAHOO_FREE_DAILY', 5_000) },
  vndirect: { per: 'day', limit: () => num('VNDIRECT_FREE_DAILY', 3_000) },
  kbs: { per: 'day', limit: () => num('KBS_FREE_DAILY', 3_000) },
  vietcap: { per: 'day', limit: () => num('VIETCAP_FREE_DAILY', 3_000) },
  sec: { per: 'day', limit: () => num('SEC_FREE_DAILY', 20_000) },
  fred: { per: 'minute', limit: () => num('FRED_FREE_MINUTE', 100) },
};

export const FREE_SERVICES = Object.keys(TIERS);

/** A service's bucket by period alone: a service not counted per key, or one of Firecrawl's shares, which are of every key's credits together. */
const bucketOf = (service, now) => {
  const { key, ends } = periodOf(TIERS[service].per, now);
  return { bucket: `free:${service}:${key}`, ends };
};

/** The bucket a call is counted in: the key's, for a service counted per key. */
const countedIn = (service, keyId, now) => (TIERS[service].pooled ? keyBucket(service, keyId, now) : bucketOf(service, now));
/** A paid call is counted apart against the service's own window only, so one call is never counted there twice. */
const paidHere = (service, paid) => paid && TIERS[service].pooled && poolWindow(service).of === service;

/** A share of all Firecrawl's keys' credits this month, or the owner's own figure for it — the sum of their ceilings, no count read. */
async function shareLimit(tier, now) {
  const set = numIn(process.env, tier.env, null);
  if (set !== null) return set;
  // Not floored by the float's own dust: 5,700 × 0.35 is 1994.9999999999998.
  return Math.floor((await poolLimit('firecrawl', now)) * tier.share + 1e-6);
}

/** A ceiling to say when the count cannot be read: one key's default, as before several keys. */
function defaultLimit(service) {
  const tier = TIERS[service];
  if (tier.pooled) return poolWindow(service).limit();
  if (tier.share) return Math.floor(poolWindow('firecrawl').limit() * tier.share + 1e-6);
  return tier.limit();
}

/**
 * What is left of a service's allowance this period, beside its ceiling — for a
 * service with several keys, the sum over them. Unbounded when the ceilings are
 * off, or when the count cannot be read — the services with no card on file refuse
 * by themselves once they are spent. A `billed` one does not, so an unreadable count
 * is none left (HAR-009).
 *
 * @returns {Promise<{ left: number, limit: number }>}
 */
export async function allowance(service, now = new Date()) {
  const tier = TIERS[service];
  if (!tier || !freeTierOnly()) return { left: Infinity, limit: Infinity };
  try {
    if (tier.pooled) {
      const { left, limit } = await capacityOf(service, now);
      return { left, limit };
    }
    const limit = tier.share ? await shareLimit(tier, now) : tier.limit();
    const used = await getStore().readCounter(bucketOf(service, now).bucket);
    return { left: Math.max(0, limit - used), limit };
  } catch (err) {
    return { left: tier.billed && !noDatabase(err) ? 0 : Infinity, limit: defaultLimit(service) };
  }
}

/** Whether what the paid key has now spent this month is inside its cap. */
async function underCap(service, keyId, total) {
  const choice = await paidKeyOf(service);
  return choice?.keyId === keyId && (choice.capMonthly == null || total <= choice.capMonthly);
}

/**
 * Count a call before it is made, and say whether it fits (HAR-009). Reading
 * the count, calling, then adding let every call made at the same moment near
 * the ceiling through; this adds first, in one upsert, and takes it back when
 * the total has gone over. For a `billed` service, where going over is a bill.
 *
 * Counted against the key that will make the call (`keyId`; the environment's by
 * default) and its own ceiling. A call on the paid key past its free ceiling
 * (`paid`) is held to that key's monthly cap instead.
 */
export async function take(service, amount, now = new Date(), { keyId = 'env', paid = false } = {}) {
  const tier = TIERS[service];
  if (!tier || !(Number(amount) > 0)) return true;
  /** What has been added so far, to take back if the call does not go. */
  const counted = [];
  try {
    const store = getStore();
    const { bucket, ends } = countedIn(service, keyId, now);
    const total = await store.addToCounter(bucket, amount, ends);
    counted.push([bucket, ends]);
    // E2B's whole credit too, as `spend` counts it — so `refund`, which takes it off, gives back only what was put on.
    if (service === 'e2b') {
      const credit = creditBucket(keyId);
      await store.addToCounter(credit, amount, LIFETIME_END);
      counted.push([credit, LIFETIME_END]);
    }
    let fits;
    if (paidHere(service, paid)) {
      const apart = keyBucket(service, keyId, now, { paid: true });
      const paidTotal = await countPaid(service, keyId, amount, now);
      // Listed once it is written, so a failure taking it back never takes back what was not added.
      counted.push([apart.bucket, apart.ends]);
      fits = await underCap(service, keyId, paidTotal);
    } else if (!freeTierOnly() || (paid && (tier.pooled || tier.share))) {
      // The ceilings off; or a paid call in Firecrawl's index or one of its shares — free splits, not a paid call's.
      fits = true;
    } else if (tier.pooled) {
      fits = total <= (await ceilingOf(service, await keyEntry(service, keyId), now));
    } else {
      fits = total <= (tier.share ? await shareLimit(tier, now) : tier.limit());
    }
    if (fits) {
      if (tier.pooled) noteUse(service, keyId, amount);
      return true;
    }
    for (const [name, until] of counted) await store.addToCounter(name, -amount, until);
    return false;
  } catch (err) {
    // A charged call is a bill by definition, and its cap the owner's limit whatever FREE_TIER_ONLY
    // says: a count that cannot be written or read stops it (review, 2026-11-12). The rest as before.
    const goes = paid && !noDatabase(err) ? false : !freeTierOnly() || !tier.billed || noDatabase(err);
    if (!goes) for (const [name, until] of counted) await getStore().addToCounter(name, -amount, until).catch(() => {});
    return goes;
  }
}

/**
 * Count what a call spent, against the key that made it. Always counted — the
 * totals are worth having even with the ceilings off. E2B's is counted against
 * its whole credit too, unless it is only a month being closed (`exhaust`), which
 * spent nothing; a call on the paid key (`paid`) against its month apart as well.
 */
export async function spend(service, amount, now = new Date(), { ofCredit = true, keyId = 'env', paid = false } = {}) {
  if (!TIERS[service] || !(Number(amount) > 0)) return;
  try {
    const { bucket, ends } = countedIn(service, keyId, now);
    await getStore().addToCounter(bucket, amount, ends);
    if (service === 'e2b' && ofCredit) await getStore().addToCounter(creditBucket(keyId), amount, LIFETIME_END);
    if (paidHere(service, paid)) await countPaid(service, keyId, amount, now);
    if (TIERS[service].pooled) noteUse(service, keyId, amount);
  } catch (err) {
    // No database at all is a script or a test, with nothing to count against.
    if (!noDatabase(err)) log.warn('free tier: not counted', { service, error: String(err?.message || err).slice(0, 160) });
  }
}

/**
 * Give back what was counted for work that never ran (HAR-010): a cloud
 * computer paid for before it started, whose start then failed. Taken off the
 * key's period and, for E2B, off its whole credit — as `spend` put it on both.
 */
export async function refund(service, amount, now = new Date(), { keyId = 'env', paid = false } = {}) {
  if (!TIERS[service] || !(Number(amount) > 0)) return;
  try {
    const { bucket, ends } = countedIn(service, keyId, now);
    await getStore().addToCounter(bucket, -amount, ends);
    if (service === 'e2b') await getStore().addToCounter(creditBucket(keyId), -amount, LIFETIME_END);
    if (paidHere(service, paid)) await countPaid(service, keyId, -amount, now);
    if (TIERS[service].pooled) noteUse(service, keyId, -amount);
  } catch (err) {
    if (!noDatabase(err)) log.warn('free tier: not given back', { service, error: String(err?.message || err).slice(0, 160) });
  }
}

/**
 * One account's share of E2B's month (HAR-007). The credit is one pool for the
 * whole deployment, and the daily action ceiling still let one account keep its
 * machine awake about ten hours a day — the month gone in under a week, for
 * everybody. Past its share an account's work goes to the Vercel stand-in.
 * E2B_ACCOUNT_SHARE, a fraction of the month (default 0.34).
 *
 * That is the ceiling over a month. Over a day the credit is split evenly among
 * whoever is using it (owner, 2026-11-05: "each user shares the free resources
 * evenly"): what is left of the month, by the days left in it, is today's, and each
 * account that has used a machine today, and this one, gets an equal part. Nobody
 * using it leaves more for tomorrow; more people using it means less each, down to
 * `E2B_ACCOUNT_DAY_FLOOR` thousandths of a dollar, which is a few minutes of machine
 * and what makes it worth starting one at all.
 */
export const e2bAccountShare = (env = process.env) => {
  const n = Number(env.E2B_ACCOUNT_SHARE);
  return n > 0 && n <= 1 ? n : 0.34;
};

const accountBucketOf = (userId, now) => {
  const { bucket, ends } = bucketOf('e2b', now);
  return { bucket: `${bucket}:user:${userId}`, ends };
};

const dayKeyOf = (now) => now.toISOString().slice(0, 10);
const dayBuckets = (userId, now) => {
  const day = dayKeyOf(now);
  return {
    mine: `free:e2b:day:${day}:user:${userId}`,
    total: `free:e2b:day:${day}`,
    people: `free:e2b:day:${day}:people`,
    // A day after it ends: a row a day old costs nothing, and a clock a little off costs nothing either.
    ends: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2)),
  };
};
/** Days left in this month, today counted. */
const daysLeftIn = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate() - now.getUTCDate() + 1;

/**
 * What this account may spend today, all else being equal: see above. Exported so
 * the suite can hold it to the numbers.
 *
 * @param {{ monthLeft: number, spentToday: number, people: number, usedToday: number, daysLeft: number, floor: number }} day
 */
export function e2bDayShare({ monthLeft, spentToday, people, usedToday, daysLeft, floor }) {
  const pot = Math.max(0, monthLeft + spentToday) / Math.max(1, daysLeft);
  const sharing = Math.max(1, people + (usedToday > 0 ? 0 : 1));
  return Math.max(0, Math.max(floor, Math.floor(pot / sharing)) - usedToday);
}

/** What is left of this account's share of E2B, of the month and of today; unbounded with the ceilings off or the count unreadable. */
export async function e2bAccountAllowance(userId, now = new Date()) {
  if (!userId || !freeTierOnly()) return { left: Infinity };
  const { limit, left: monthLeft } = await allowance('e2b', now);
  if (!Number.isFinite(limit)) return { left: Infinity };
  try {
    const store = getStore();
    const used = await store.readCounter(accountBucketOf(userId, now).bucket);
    const ofMonth = Math.max(0, Math.floor(limit * e2bAccountShare()) - used);
    const { mine, total, people } = dayBuckets(userId, now);
    const ofDay = e2bDayShare({
      monthLeft,
      spentToday: await store.readCounter(total),
      people: await store.readCounter(people),
      usedToday: await store.readCounter(mine),
      daysLeft: daysLeftIn(now),
      floor: num('E2B_ACCOUNT_DAY_FLOOR', 15),
    });
    return { left: Math.min(ofMonth, ofDay) };
  } catch {
    return { left: Infinity };
  }
}

/** Count (or, negative, give back) what an account's machine time cost against its share. */
export async function e2bAccountSpend(userId, amount, now = new Date()) {
  if (!userId || !Number(amount)) return;
  try {
    const { bucket, ends } = accountBucketOf(userId, now);
    const store = getStore();
    await store.addToCounter(bucket, amount, ends);
    const day = dayBuckets(userId, now);
    const mine = await store.addToCounter(day.mine, amount, day.ends);
    await store.addToCounter(day.total, amount, day.ends);
    // Their first of the day: one more person to share it among.
    if (amount > 0 && mine === Math.round(amount)) await store.addToCounter(day.people, 1, day.ends);
    // A start that failed and was given back was nobody's first of the day after all.
    if (amount < 0 && mine <= 0) await store.addToCounter(day.people, -1, day.ends);
  } catch (err) {
    if (!/not ready yet/.test(String(err?.message))) log.warn('free tier: account share not counted', { error: String(err?.message || err).slice(0, 160) });
  }
}

/**
 * Mark a service's allowance as used up for the period — when the service itself says
 * so. One key's (`keyId`, the environment's by default), filled to its own ceiling.
 */
export async function exhaust(service, now = new Date(), { keyId = 'env' } = {}) {
  const tier = TIERS[service];
  if (!tier) return;
  if (!tier.pooled) {
    const { left } = await allowance(service, now);
    if (Number.isFinite(left) && left > 0) await spend(service, left, now, { ofCredit: false });
    return;
  }
  if (!freeTierOnly()) return;
  try {
    const { used, ceiling } = await keyUsage(service, await keyEntry(service, keyId), now);
    if (ceiling - used > 0) await spend(service, ceiling - used, now, { ofCredit: false, keyId });
  } catch (err) {
    if (!noDatabase(err)) log.warn('free tier: not marked spent', { service, error: String(err?.message || err).slice(0, 160) });
  }
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

/**
 * Each service's use this period, for the administrators' view — summed over its keys
 * where it has several — and `pool`: every pooled service's keys, by hint (keyPool.js).
 */
export async function freeTierReport(now = new Date()) {
  const rows = [];
  for (const service of FREE_SERVICES) {
    const tier = TIERS[service];
    const { ends } = bucketOf(service, now);
    let used = null;
    let limit = defaultLimit(service);
    if (tier.pooled) {
      const sum = await capacityOf(service, now).catch(() => null);
      used = sum?.used ?? null;
      limit = sum?.limit ?? limit;
    } else {
      used = await getStore().readCounter(bucketOf(service, now).bucket).catch(() => null);
      if (tier.share) limit = await shareLimit(tier, now).catch(() => limit);
    }
    rows.push({ service, per: tier.per, limit, used, resets: ends.toISOString() });
  }
  const pool = await poolReport(now).catch((err) => {
    if (!noDatabase(err)) log.warn('free tier: the keys could not be listed', { error: String(err?.message || err).slice(0, 160) });
    return [];
  });
  return { enforced: freeTierOnly(), userDaily: num('FREE_TIER_USER_DAILY', 30), services: rows, pool };
}

/** The setting holding the months a pooled service ran past four fifths of its summed capacity. */
const HIGH_MONTHS = 'pool_high_months';
/** How many months are kept (the hint needs two). */
const HIGH_KEEP = 3;

/**
 * Whether Tavily's Project plan is worth buying (owner, 2026-11-12): true once this month and
 * the month before both ran past 80% of the summed capacity of its keys. The month is written
 * when first seen past it, never twice; the last three are kept. Called for the administrators'
 * page, from the report it has just built.
 *
 * @param {{ services?: Array<{ service: string, used: number|null, limit: number|null }> }} report
 * @param {Date} [now]
 * @returns {Promise<boolean>}
 */
export async function tavilyHint(report, now = new Date()) {
  const row = (report?.services || []).find((one) => one.service === 'tavily');
  const month = now.toISOString().slice(0, 7);
  const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  try {
    const store = getStore();
    const saved = await store.getSetting(HIGH_MONTHS);
    const months = Array.isArray(saved?.tavily) ? saved.tavily.map(String) : [];
    if (row && Number(row.limit) > 0 && Number(row.used) > Number(row.limit) * 0.8 && !months.includes(month)) {
      months.push(month);
      months.sort();
      await store.setSetting(HIGH_MONTHS, { ...(saved && typeof saved === 'object' ? saved : {}), tavily: months.slice(-HIGH_KEEP) });
    }
    return months.includes(month) && months.includes(before);
  } catch (err) {
    if (!noDatabase(err)) log.warn('free tier: the busy months were not read', { error: String(err?.message || err).slice(0, 160) });
    return false;
  }
}
