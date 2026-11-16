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

/**
 * A size in the decimal units the files limit is written in (owner, 2026-11-13: "0.5 GB"); from
 * half a gigabyte up it reads in gigabytes, as the server's sentence about a full account does.
 */
export function filesSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  const one = (value) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value);
  if (n >= 5e8) return `${one(n / 1e9)} GB`;
  if (n >= 1e6) return `${one(n / 1e6)} MB`;
  if (n >= 1e3) return `${one(n / 1e3)} KB`;
  return `${n} B`;
}
