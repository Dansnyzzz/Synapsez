/**
 * What this service charges on top of the provider's price.
 *
 * The app is an intermediary: every price a person is shown — the per-million
 * rate in the picker, the "new model" notice, the cost of a turn, the month on
 * the usage page — is the provider's price plus this share, on input and output
 * alike. One number in one place, so no screen can show the bare provider rate
 * while another shows the marked-up one.
 *
 * What is *stored* stays the provider's figure (`usage_events.cost_usd`,
 * `shared_models.price_in`). The markup is applied where a price is shown, so
 * changing it re-prices history consistently instead of mixing two rates in one
 * table, and so the audit trail keeps what was actually paid upstream.
 *
 * `PRICE_MARKUP` overrides it — a fraction, 0.1 for ten percent. A value that
 * is not a sane fraction is ignored rather than trusted: a typo of `10` would
 * otherwise show every price at eleven times what it is.
 */
export const PRICE_MARKUP = (() => {
  const raw = process.env.PRICE_MARKUP;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1;
})();

/** A USD figure as shown to a person. Free stays free; unknown stays unknown. */
export function withMarkup(usd) {
  if (usd == null) return usd;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  // Rounded to a millionth of a dollar: a per-million rate of $0.045 must not
  // come out as 0.049500000000000006.
  return Math.round(n * (1 + PRICE_MARKUP) * 1e6) / 1e6;
}

/** `{ in, out }` per million tokens, as shown. */
export function markedPrice(price) {
  if (!price) return price ?? null;
  return { ...price, in: withMarkup(price.in), out: withMarkup(price.out) };
}
