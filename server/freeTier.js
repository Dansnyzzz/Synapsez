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
 *   - E2B, the cloud computer: a one-off credit, spread over the months before
 *     it lapses (`e2bMonthCap`). Its ceiling is worked out, not set.
 *
 * Each ceiling can be set (EXA_FREE_MILLS, TAVILY_FREE_CREDITS,
 * BRAVE_FREE_REQUESTS, GOOGLE_FREE_DAILY, STACKEXCHANGE_FREE_DAILY), and
 * FREE_TIER_ONLY=false lifts them all, for a deployment that pays.
 *
 * And a fair share: an account may make FREE_TIER_USER_DAILY metered searches
 * a day (30 by default). Past that its searches go to the free engines, so one
 * person cannot spend everyone's month in an afternoon.
 */

const numIn = (env, name, fallback) => {
  const raw = env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
};
const num = (name, fallback) => numIn(process.env, name, fallback);

/*
 * E2B's credit (owner, 2026-11-02): $100 that lapses on 1 December 2027 and $5
 * that never does, on the Hobby plan with no card — so a spent credit is a
 * refusal, never a bill. The owner wants all of it used. A fixed ceiling a
 * month would let whatever a quiet month left over lapse; instead a month may
 * use what was left of the lapsing part when it began, divided by the months
 * left before it lapses — so a quiet month passes its share on, and the last
 * month may use everything still there. Once that part is gone, or has lapsed,
 * the month may use what is left of the lasting part. Both are taken a little
 * under the real figures, so a count a call or two behind never crosses them.
 * Thousandths of a dollar, like Exa: E2B_CREDIT_MILLS, E2B_CREDIT_LASTING_MILLS,
 * E2B_CREDIT_EXPIRES.
 */
const CREDIT_MARGIN = 0.97;
const E2B_TOTAL = 'free:e2b:total';
/** The whole credit's count outlives any month; it only has to outlast the credit. */
const LIFETIME_END = new Date(Date.UTC(2100, 0, 1));

/**
 * What E2B may spend in the month `now` falls in, given what the whole credit
 * had spent before that month began.
 *
 * @param {{ usedBefore?: number, now?: Date, env?: Record<string, string | undefined> }} [options]
 */
export function e2bMonthCap({ usedBefore = 0, now = new Date(), env = process.env } = {}) {
  const lapsing = numIn(env, 'E2B_CREDIT_MILLS', 100_000) * CREDIT_MARGIN;
  const lasting = numIn(env, 'E2B_CREDIT_LASTING_MILLS', 5_000) * CREDIT_MARGIN;
  const parsed = new Date(env.E2B_CREDIT_EXPIRES || '2027-12-01T00:00:00Z');
  const expires = Number.isNaN(parsed.getTime()) ? new Date(Date.UTC(2027, 11, 1)) : parsed;
  // The credit is assumed spent lapsing-first, so the lasting part is what was spent past the lapsing one.
  const lastingLeft = Math.max(0, lasting - Math.max(0, usedBefore - lapsing));
  const lapsingLeft = Math.max(0, lapsing - usedBefore);
  if (now >= expires || lapsingLeft <= 0) return Math.floor(lastingLeft);
  const last = new Date(expires.getTime() - 1);
  const monthsLeft = (last.getUTCFullYear() - now.getUTCFullYear()) * 12 + (last.getUTCMonth() - now.getUTCMonth()) + 1;
  return Math.floor(lapsingLeft / Math.max(1, monthsLeft));
}

/** Each service's ceiling and the period it resets on. */
const TIERS = {
  exa: { per: 'month', limit: () => num('EXA_FREE_MILLS', 9_500) },
  tavily: { per: 'month', limit: () => num('TAVILY_FREE_CREDITS', 950) },
  // `billed`: a card on file and no cap of the service's own — see `take`.
  brave: { per: 'month', limit: () => num('BRAVE_FREE_REQUESTS', 950), billed: true },
  google: { per: 'day', limit: () => num('GOOGLE_FREE_DAILY', 450) },
  stackexchange: { per: 'day', limit: () => num('STACKEXCHANGE_FREE_DAILY', process.env.STACKEXCHANGE_KEY ? 9_500 : 280) },
  // The cloud computer's machine time, in thousandths of a dollar (server/e2b.js).
  e2b: {
    per: 'month',
    limit: () => e2bMonthCap(),
    /** This month's ceiling, from what the whole credit had spent before the month began. */
    async capFor(now, usedThisMonth) {
      const total = await getStore().readCounter(E2B_TOTAL);
      return e2bMonthCap({ usedBefore: Math.max(0, total - usedThisMonth), now });
    },
  },
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
 * services with no card on file refuse by themselves once they are spent. A
 * `billed` one does not, so an unreadable count is none left (HAR-009).
 *
 * @returns {Promise<{ left: number, limit: number }>}
 */
export async function allowance(service, now = new Date()) {
  const tier = TIERS[service];
  if (!tier || !freeTierOnly()) return { left: Infinity, limit: Infinity };
  let limit = tier.limit();
  try {
    const used = await getStore().readCounter(bucketOf(service, now).bucket);
    if (tier.capFor) limit = await tier.capFor(now, used);
    return { left: Math.max(0, limit - used), limit };
  } catch (err) {
    return { left: tier.billed && !noDatabase(err) ? 0 : Infinity, limit };
  }
}

/** No database at all is a script or a test, with nothing to count against — not a database that is down. */
const noDatabase = (err) => /not ready yet/.test(String(err?.message));

/**
 * Count a call before it is made, and say whether it fits (HAR-009). Reading
 * the count, calling, then adding let every call made at the same moment near
 * the ceiling through; this adds first, in one upsert, and takes it back when
 * the total has gone over. For a `billed` service, where going over is a bill.
 */
export async function take(service, amount, now = new Date()) {
  const tier = TIERS[service];
  if (!tier || !(Number(amount) > 0)) return true;
  const { bucket, ends } = bucketOf(service, now);
  try {
    const total = await getStore().addToCounter(bucket, amount, ends);
    if (!freeTierOnly() || total <= tier.limit()) return true;
    await getStore().addToCounter(bucket, -amount, ends);
    return false;
  } catch (err) {
    return !freeTierOnly() || !tier.billed || noDatabase(err);
  }
}

/**
 * Count what a call spent. Always counted — the totals are worth having even
 * with the ceilings off. E2B's is counted against its whole credit too, unless
 * it is only a month being closed (`exhaust`), which spent nothing.
 */
export async function spend(service, amount, now = new Date(), { ofCredit = true } = {}) {
  if (!TIERS[service] || !(Number(amount) > 0)) return;
  try {
    const { bucket, ends } = bucketOf(service, now);
    await getStore().addToCounter(bucket, amount, ends);
    if (service === 'e2b' && ofCredit) await getStore().addToCounter(E2B_TOTAL, amount, LIFETIME_END);
  } catch (err) {
    // No database at all is a script or a test, with nothing to count against.
    if (!/not ready yet/.test(String(err?.message))) log.warn('free tier: not counted', { service, error: String(err?.message || err).slice(0, 160) });
  }
}

/**
 * Give back what was counted for work that never ran (HAR-010): a cloud
 * computer paid for before it started, whose start then failed. Taken off the
 * period and, for E2B, off its whole credit — as `spend` put it on both.
 */
export async function refund(service, amount, now = new Date()) {
  if (!TIERS[service] || !(Number(amount) > 0)) return;
  try {
    const { bucket, ends } = bucketOf(service, now);
    await getStore().addToCounter(bucket, -amount, ends);
    if (service === 'e2b') await getStore().addToCounter(E2B_TOTAL, -amount, LIFETIME_END);
  } catch (err) {
    if (!/not ready yet/.test(String(err?.message))) log.warn('free tier: not given back', { service, error: String(err?.message || err).slice(0, 160) });
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
  } catch (err) {
    if (!/not ready yet/.test(String(err?.message))) log.warn('free tier: account share not counted', { error: String(err?.message || err).slice(0, 160) });
  }
}

/** Mark a service's allowance as used up for the period — when the service itself says so. */
export async function exhaust(service, now = new Date()) {
  const { left } = await allowance(service, now);
  if (Number.isFinite(left) && left > 0) await spend(service, left, now, { ofCredit: false });
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
    const { per, limit, capFor } = TIERS[service];
    const { bucket, ends } = bucketOf(service, now);
    const used = await getStore().readCounter(bucket).catch(() => null);
    const ceiling = capFor ? await capFor(now, used || 0).catch(() => limit()) : limit();
    rows.push({ service, per, limit: ceiling, used, resets: ends.toISOString() });
  }
  return { enforced: freeTierOnly(), userDaily: num('FREE_TIER_USER_DAILY', 30), services: rows };
}
