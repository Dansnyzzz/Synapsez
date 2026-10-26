/**
 * The documents a person agrees to, by version (LAW-001; owner, 2026-10-26).
 *
 * One place says which are current. The sign-in gate is told them by
 * `/api/session` and sends them back with the tick; signing up records them in
 * the security record (`consent_given`); `/api/bootstrap` says whether the
 * account's latest agreement covers them, and an account that never agreed —
 * or agreed to an older version — is asked once, by a banner, through
 * `/api/consent`. Each page carries its own string ("Phiên bản …" / "Version
 * …"), held to these by test/features: change a page, change its version here.
 */
export const LEGAL = Object.freeze({
  notice: 'privacy-2026-10-26',
  terms: 'terms-2026-10-26',
  usage: 'usage-2026-10-26',
});

const SHAPE = { notice: 'privacy', terms: 'terms', usage: 'usage' };

/**
 * The versions a request says were shown, each kept only if it has the shape
 * of one. The privacy notice arrives as `consent`, its name since LAW-001.
 *
 * @param {any} body
 * @returns {{ notice?: string, terms?: string, usage?: string }}
 */
export function agreement(body) {
  const given = { notice: body?.consent ?? body?.notice, terms: body?.terms, usage: body?.usage };
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [key, prefix] of Object.entries(SHAPE)) {
    const value = typeof given[key] === 'string' ? given[key].slice(0, 40) : '';
    if (new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}$`).test(value)) kept[key] = value;
  }
  return kept;
}

/** Whether a recorded agreement covers every document as it is now. */
export function agreedToCurrent(detail) {
  return !!detail && detail.notice === LEGAL.notice && detail.terms === LEGAL.terms && detail.usage === LEGAL.usage;
}
