/**
 * The 30-second answer to "is this account metered by billing", kept per instance (meter.js asks, everything that credits,
 * refunds or changes a plan forgets). Its own module so orders.js and subscriptions.js can forget without importing meter.js,
 * which imports them (a cycle).
 */
export const BILLABLE_MS = 30_000;
export const BILLABLE_MAX = 500;
/** user id -> { until, value, mode }: one yes/no per account per instance, a question every call would otherwise ask the database. */
export const billableCache = new Map();

/** Forget the answer for one account (this instance charged, credited or refunded it), or for all (tests). */
export function forgetBillable(userId) {
  if (userId == null) billableCache.clear();
  else billableCache.delete(String(userId));
}
