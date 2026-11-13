/**
 * Payment codes (owner, 2026-11-13). A transfer must carry its order code so the webhook can
 * match the money to an order. The code is SZ plus ten digits and no dashes, because banks drop
 * dashes and punctuation from transfer content. SePay parses a `code` field itself; the content
 * is the fallback, matched only where the ten digits end, so an eleven-digit run never matches.
 */
import crypto from 'node:crypto';
export const CODE_PREFIX = 'SZ';
const EXACT = /^SZ\d{10}$/i;
const INSIDE = /SZ(\d{10})(?!\d)/i;
export const newPaymentCode = (randomInt = crypto.randomInt) => `${CODE_PREFIX}${String(randomInt(0, 10_000_000_000)).padStart(10, '0')}`;
/** The order code a transfer carries: SePay's parsed `code` first, else the content. Uppercase, or null. */
export function findCode(code, content) {
  if (code && EXACT.test(String(code).trim())) return String(code).trim().toUpperCase();
  const m = INSIDE.exec(String(content || ''));
  return m ? `${CODE_PREFIX}${m[1]}` : null;
}
