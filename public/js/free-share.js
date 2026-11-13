import { t, currentLanguage } from './i18n.js';

/*
 * How a month's free share is said (server/freeShares.js, owner 2026-11-13): shared by
 * Settings → Usage (the account's card) and the administrators' Free allowances page.
 */

/** About an hour of the 2-vCPU machine costs this many thousandths of a dollar (server/freeShares.js MACHINE_MILLS_PER_HOUR). */
const MILLS_PER_HOUR = 133;

const locale = () => (currentLanguage() === 'vi' ? 'vi-VN' : 'en-US');
export const countOf = (n) => new Intl.NumberFormat(locale()).format(n);

/** Machine time in mills, as the minutes a person understands: "35 min", "2 h 10 min". */
export function machineTime(mills) {
  const minutes = Math.max(0, Math.round((Number(mills) / MILLS_PER_HOUR) * 60));
  return minutes >= 60 ? t('usage.share.hm', { h: String(Math.floor(minutes / 60)), m: String(minutes % 60) }) : t('usage.share.min', { m: String(minutes) });
}

/** The administrators' sentence under the allowances table. */
export function freeShareLine(shares) {
  if (!shares || shares.fallback || !shares.capacity?.searches) return t('freetier.enforcedFallback');
  return t('freetier.enforced', {
    n: countOf(shares.searches),
    h: machineTime(shares.machineMills),
    c: countOf(shares.capacity.searches),
    p: countOf(shares.people?.searches ?? 0),
    min: '30',
    max: '900',
  });
}
