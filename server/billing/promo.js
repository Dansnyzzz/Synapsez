/**
 * Promo codes (spec B1, Task 7; owner, 2026-11-13): a code the owner hands out that adds đồng to a balance, once per
 * account, up to a number of uses, until it expires. Everything that can go wrong with a redemption says the same thing
 * ("That code did not work."), so a person trying codes learns nothing about which exist, which are spent or which ran out.
 * The count, the once-per-account rule and the credit are one statement in the store (`redeemPromo`).
 */
import { getStore } from '../store/index.js';
import { forgetBillable } from './meter.js';

const CODE = /^[A-Z0-9]{8,32}$/;
export const PROMO_CREDIT = Object.freeze({ min: 1_000, max: 1_000_000 });
export const PROMO_USES = Object.freeze({ min: 1, max: 10_000 });

/** A refusal the person can read: a 400 with its own words (server/i18n/vi.js translates each). */
const refuse = (error) => Object.assign(error, { status: 400 });

/**
 * Make a code. The owner's tool, but validated here whatever the route did: 8 to 32 letters and digits (upper-cased),
 * a credit of 1,000 to 1,000,000đ, 1 to 10,000 uses, and an expiry that is a real date or none.
 *
 * @param {{ code: any, creditVnd: any, maxUses: any, expiresAt?: any }} input
 * @param {string | null} by the administrator who made it
 */
export async function createPromo({ code, creditVnd, maxUses, expiresAt = null }, by = null) {
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!CODE.test(text)) throw refuse(new Error('A code is 8 to 32 letters and digits.'));
  if (!Number.isSafeInteger(creditVnd) || creditVnd < PROMO_CREDIT.min || creditVnd > PROMO_CREDIT.max) throw refuse(new Error('The credit is between 1,000đ and 1,000,000đ.'));
  if (!Number.isSafeInteger(maxUses) || maxUses < PROMO_USES.min || maxUses > PROMO_USES.max) throw refuse(new Error('A code can be used 1 to 10,000 times.'));
  let until = null;
  if (expiresAt != null && expiresAt !== '') {
    until = new Date(/** @type {any} */ (expiresAt));
    if (Number.isNaN(+until)) throw refuse(new Error('The expiry is not a date.'));
  }
  try {
    return await getStore().createPromo({ code: text, creditVnd, maxUses, expiresAt: until, createdBy: by });
  } catch (err) {
    if (err?.code === 'duplicate') throw Object.assign(new Error('That code already exists.'), { status: 409 });
    throw err;
  }
}

/**
 * Redeem a code for an account. Returns the đồng credited, or throws `{ status: 400, message: 'That code did not work.' }`
 * for a code that does not exist, is spent, expired, switched off, already used by this account, or is not shaped like one.
 * The account is made billable at once (it may be an administrator whose balance was nothing a moment ago).
 *
 * @param {string} userId
 * @param {unknown} code
 */
export async function redeem(userId, code) {
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!CODE.test(text)) throw refuse(new Error('That code did not work.'));
  const credited = await getStore().redeemPromo(text, String(userId), new Date());
  if (credited == null) throw refuse(new Error('That code did not work.'));
  forgetBillable(userId);
  return credited;
}
