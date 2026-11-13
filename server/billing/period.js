/**
 * Periods in Vietnamese time (owner, 2026-11-12/13). Vietnam is UTC+7 all year, so a subscription
 * month is counted in that wall time, not in UTC. A month that starts on day 31 ends on the last
 * day of a shorter month, and every later month is counted from the original start day, so one
 * short month does not move the billing day for good. Proration gives back the unused share of a
 * period, rounded down to the đồng so the customer is never over-credited.
 */
export const VN_OFFSET_MS = 7 * 3600_000;
const DAY_MS = 86_400_000;
const vnParts = (date) => { const d = new Date(date.getTime() + VN_OFFSET_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), ms: d.getTime() % DAY_MS }; };
const fromVn = (y, m, d, ms) => new Date(Date.UTC(y, m, d) + ms - VN_OFFSET_MS);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** 'YYYY-MM-DD' of the Vietnamese day `date` falls in. */
export const vnDay = (date) => new Date(date.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
/** The end of that Vietnamese day (the next VN midnight), for counters that expire with the day. */
export const vnDayEnd = (date) => { const p = vnParts(date); return fromVn(p.y, p.m, p.d + 1, 0); };
export const daysInVnMonth = (date) => { const p = vnParts(date); return daysIn(p.y, p.m); };
/** `start` moved `n` months on, same Vietnamese wall time, the day clamped to the month's last. */
export function addMonths(start, n) {
  const p = vnParts(start);
  const total = p.m + n;
  const y = p.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  return fromVn(y, m, Math.min(p.d, daysIn(y, m)), p.ms);
}
export const periodEnd = (start, period) => addMonths(start, period === 'year' ? 12 : 1);
/** The month inside a subscription that `now` falls in, always counted from the original start. */
export function monthWindow(subStart, now) {
  let k = 0;
  while (addMonths(subStart, k + 1) <= now) k += 1;
  const start = addMonths(subStart, k);
  return { start, end: addMonths(subStart, k + 1), key: String(start.getTime()) };
}
/** Credit for the unused share of a period, rounded down to the đồng. */
export function prorate(paidVnd, start, end, now) {
  const span = end.getTime() - start.getTime();
  if (span <= 0 || now >= end) return 0;
  if (now <= start) return paidVnd;
  return Math.floor((paidVnd * (end.getTime() - now.getTime())) / span);
}
export const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);
