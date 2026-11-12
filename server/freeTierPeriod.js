/**
 * The clock and the figures the free allowances are kept by — shared by freeTier.js and
 * keyPool.js, and kept here so neither has to import the other (freeTier.js asks keyPool.js
 * for a service's keys; keyPool.js needs the periods and the ceilings' defaults). Moved out
 * of freeTier.js unchanged (2026-11-12), which still exports each of them.
 */

/** A number from the environment, or `fallback` when it is unset, empty, negative or not a number. */
export const numIn = (env, name, fallback) => {
  const raw = env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
};
export const num = (name, fallback) => numIn(process.env, name, fallback);

/** No database at all is a script or a test, with nothing to count against — not a database that is down. */
export const noDatabase = (err) => /not ready yet/.test(String(err?.message));

/** Whether the ceilings hold — they do unless FREE_TIER_ONLY says otherwise. */
export const freeTierOnly = () => !/^(0|false|no|off)$/i.test(String(process.env.FREE_TIER_ONLY || '').trim());

/**
 * The period a moment falls in, in UTC — the month for monthly credit, the day for
 * daily quotas, the hour and the minute for the per-minute ones (CoinGecko, FRED) —
 * and when it ends.
 */
export function periodOf(per, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const month = `${y}-${String(m + 1).padStart(2, '0')}`;
  if (per === 'month') return { key: month, ends: new Date(Date.UTC(y, m + 1, 1)) };
  const day = `${month}-${String(d).padStart(2, '0')}`;
  const pad = (n) => String(n).padStart(2, '0');
  if (per === 'minute') {
    const h = now.getUTCHours();
    const mi = now.getUTCMinutes();
    return { key: `${day}T${pad(h)}:${pad(mi)}`, ends: new Date(Date.UTC(y, m, d, h, mi + 1)) };
  }
  if (per === 'hour') {
    const h = now.getUTCHours();
    return { key: `${day}T${pad(h)}`, ends: new Date(Date.UTC(y, m, d, h + 1)) };
  }
  return { key: day, ends: new Date(Date.UTC(y, m, d + 1)) };
}

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
