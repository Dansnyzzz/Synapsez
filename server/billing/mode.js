/**
 * The billing mode (owner, 2026-11-12). `off` hides billing and answers 404 everywhere; `preview`
 * shows it to administrators only and never refuses a call; `live` shows it to everyone. An unset
 * or unknown value is `preview`, so a typo can never turn billing on for customers. The server
 * decides who sees billing; the browser is only told the answer.
 */
export const MODES = ['off', 'preview', 'live'];
export function billingMode(env = process.env) {
  const v = String(env.BILLING_MODE || '').trim().toLowerCase();
  return MODES.includes(v) ? v : 'preview';
}
/** Whether this account sees billing at all. The server's word; the browser is only told. */
export function billingVisible(user, env = process.env) {
  const mode = billingMode(env);
  if (mode === 'off' || !user) return false;
  return mode === 'live' ? true : user.role === 'admin';
}
