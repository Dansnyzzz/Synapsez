/**
 * The VAT figure: one formula for the receipt, the checkout and the e-invoice, though not one base. The checkout and the e-invoice
 * take the sale total; the receipt takes the amount actually transferred, which is less when the balance paid part of the order.
 * Prices here include the tax, so the tax is the share of a total, not a surcharge on it. Nothing is stated unless the seller sets a rate: a guess would be a
 * tax statement nobody made.
 */

/** The VAT percentage the seller set (`BILLING_TAX_RATE`), or null when it is unset, blank, negative or not a number. */
export function taxRate(env = process.env) {
  const raw = String(env.BILLING_TAX_RATE ?? '').trim();
  if (raw === '') return null;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/** The tax inside a total that already includes it, in whole đồng. */
export function taxIn(totalVnd, rate) {
  return Math.round((Math.trunc(totalVnd) * rate) / (100 + rate));
}
