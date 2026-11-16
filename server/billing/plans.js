/**
 * The plans and the prices (owner, 2026-11-12/13). Plans are option A: a monthly or yearly plan
 * with a month's allowance. Prices are set in USD and charged in đồng at the day's rate, rounded
 * up to the next 1,000đ, so a rate change moves the price and never the allowance. Pay-as-you-go
 * is anchored to 25,656 đ/USD and follows the rate. There are no daily limits: an allowance is a
 * month's, usable on any day, so no plan carries a per-day field.
 */
export const PLAN_IDS = ['free', 'plus', 'pro', 'max'];
export const PAID_PLANS = ['plus', 'pro', 'max'];
export const PERIODS = ['month', 'year'];
export const RANK = Object.freeze({ free: 0, plus: 1, pro: 2, max: 3 });
export const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', usdCents: { month: 0, year: 0 }, searches: 0, sandboxMinutes: 0, storageGb: 0.5 }),
  plus: Object.freeze({ id: 'plus', usdCents: { month: 500, year: 5000 }, searches: 150, sandboxMinutes: 240, storageGb: 3 }),
  pro: Object.freeze({ id: 'pro', usdCents: { month: 800, year: 8000 }, searches: 250, sandboxMinutes: 360, storageGb: 5 }),
  max: Object.freeze({ id: 'max', usdCents: { month: 1500, year: 15000 }, searches: 450, sandboxMinutes: 720, storageGb: 10 }),
});
/** Pay-as-you-go prices at the anchor rate (owner, 2026-11-13: they follow the USD rate, as plan prices do). */
export const PAYG_ANCHOR_RATE = 25_656;
export const PAYG_BASE = Object.freeze({ searchVnd: 400, sandboxVndPerHour: 5000, storageVndPerGbMonth: 1000 });
/** Integer ceiling division: floats are never used for a step, so a rate cannot round one step too high. */
const ceilDiv = (n, d) => Math.floor((n + d - 1) / d);
/** The pay-as-you-go prices at a rate, in whole đồng, by integer maths on the rate in hundredths. */
export function paygPrices(rate = PAYG_ANCHOR_RATE) {
  const rc = Number(rate) > 0 ? Math.round(Number(rate) * 100) : PAYG_ANCHOR_RATE * 100;
  const anchorC = PAYG_ANCHOR_RATE * 100;
  return {
    searchVnd: ceilDiv(PAYG_BASE.searchVnd * rc, anchorC * 10) * 10,
    sandboxVndPerMinute: ceilDiv(PAYG_BASE.sandboxVndPerHour * rc, anchorC * 60),
    storageVndPerGbMonth: ceilDiv(PAYG_BASE.storageVndPerGbMonth * rc, anchorC * 10) * 10,
  };
}
export const TOPUP = Object.freeze({ minNoPlan: 50_000, minWithPlan: 100_000, maxBalanceNoPlan: 200_000, maxBalanceWithPlan: 1_000_000, presets: Object.freeze([100_000, 200_000, 500_000]) });
export const BALANCE_EXPIRY_MONTHS = 12;
export const EXPIRY_WARNING_DAYS = 30;
export const ORDER_TTL_MS = 30 * 60_000;
export const GRACE_DAYS = 3;
export const REMIND_DAYS = 3;
export const PAGES_PER_UNIT = 3;
export const isPlan = (id) => Object.hasOwn(PLANS, String(id));
export const isPaidPlan = (id) => PAID_PLANS.includes(String(id));
export const isPeriod = (p) => PERIODS.includes(String(p));
/** Whole đồng for a plan at a rate, rounded up to the next 1,000đ. Integer arithmetic only. */
export function planVnd(plan, period, rate) {
  const cents = PLANS[plan].usdCents[period];
  const rateCenti = Math.round(Number(rate) * 100);
  return Math.ceil((cents * rateCenti) / 10_000_000) * 1000;
}
export const unitsForPages = (pages) => Math.max(1, Math.ceil((Number(pages) || 1) / PAGES_PER_UNIT));
