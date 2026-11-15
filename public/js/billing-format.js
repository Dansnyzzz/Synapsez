import { t, localeTag } from './i18n.js';

/**
 * How money and time are written in the plans sheet (billing preview, 2026-11-14): in the app's
 * language, never the browser's, so a Vietnamese page does not show 129,000 beside a Vietnamese sentence.
 */

/** Whole đồng: `129.000 ₫` in Vietnamese, `129,000 ₫` in English. */
export function vnd(n) {
  // Number then sign (the currency style puts the sign first in English); a no-break space keeps them together.
  return `${new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}\u00a0₫`;
}

/** Whole US dollars from cents, cents shown only when there are some: `$5`, `$57`, `$4.75`. */
export function usd(cents) {
  const whole = Number(cents) % 100 === 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
}

/** The plan's display name; an unknown id is shown as it came rather than hidden. */
export function planName(id) {
  const key = `billing.plan.${id}`;
  return ['free', 'plus', 'pro', 'max'].includes(id) ? t(key) : String(id || '');
}

/** `1 h 12 min` / `1 giờ 12 phút`; a whole hour is `4 h`, under an hour `45 min`. */
export function minutes(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) / 60) || 0);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [];
  if (h) parts.push(t('billing.fmt.hours', { n: h }));
  if (m || !h) parts.push(t('billing.fmt.minutes', { n: m }));
  return parts.join(' ');
}

/** `mm:ss` for a countdown. */
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
