import { t, currentLanguage } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, usd } from './billing-format.js';
import { savePercent, rateStamp } from './billing-plan-cards.js';

/**
 * The checkout drawn as "Configure your plan" (2026-11-17): the period as two radio cards, the billing
 * information as an inline form, how it is paid, and on the right the summary with the renewal notice,
 * the consent box and Subscribe. Pure markup from the state it is given; what the buttons do, the
 * profile save and the order stay in billing-plans.js.
 */

const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';

/** The fields of the billing form, in the order they are asked; `draft` and the saved profile name them by `key`. */
export const PROFILE_FIELDS = [
  { id: 'name', key: 'name', label: 'name', extra: 'autocomplete="name" maxlength="120" required' },
  { id: 'email', key: 'email', label: 'email', extra: 'type="email" autocomplete="email" maxlength="254" required' },
  { id: 'country', key: 'country', label: 'country', extra: 'autocomplete="country" maxlength="2" required size="3"', hint: true },
  { id: 'address', key: 'address', label: 'address', extra: 'autocomplete="street-address" maxlength="300"' },
  { id: 'company', key: 'companyName', label: 'company', extra: 'autocomplete="organization" maxlength="120"' },
  { id: 'tax', key: 'taxCode', label: 'tax', extra: 'inputmode="numeric" maxlength="20" autocomplete="off"' },
  { id: 'invoiceName', key: 'invoiceName', label: 'invoiceName', extra: 'maxlength="120" autocomplete="off"' },
];

/** What the form holds, by input name, taken from a draft or a saved profile. */
export function formValues(source) {
  return Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, source?.[f.key] ?? '']));
}

/** The form's keys with the inputs they are read from, so the page can read what was typed without knowing the markup. */
export const FORM_FIELDS = PROFILE_FIELDS.map((f) => ({ key: f.key, input: f.id }));

function formHtml(values, formError) {
  const field = (f) => `<div class="field"><label for="bill-${f.id}">${esc(t(`billing.profile.${f.label}`))}</label><input id="bill-${f.id}" name="${f.id}" value="${esc(values[f.key])}" ${f.extra}${f.hint ? ' aria-describedby="bill-country-hint"' : ''}></div>${f.hint ? `<p id="bill-country-hint" class="plans__muted">${esc(t('billing.profile.countryHint'))}</p>` : ''}`;
  return `<section class="checkout__info" aria-labelledby="bill-heading"><h3 id="bill-heading">${esc(t('billing.profile.title'))}</h3>
      <form data-profile novalidate>
        <p class="plans__muted">${esc(t('billing.profile.why'))}</p>
        ${PROFILE_FIELDS.map(field).join('')}
        ${formError ? `<p class="plans__error" role="alert">${esc(formError)}</p>` : ''}
      </form></section>`;
}

/** Monthly | Yearly as two cards, a radio group with one tab stop (arrow keys move inside it; the handler is the page's). */
function periodCardsHtml({ checkout, period, plan, label }) {
  const pct = savePercent(plan);
  const vi = currentLanguage() === 'vi';
  const cards = ['month', 'year'].map((x) => {
    const q = checkout.quotes[x];
    const price = q.unavailable ? '—' : vi || !plan ? vnd(q.priceVnd) : `${usd(plan.usdCents[x])} (${vnd(q.priceVnd)})`;
    const off = q.kind === 'later';
    // A period that cannot be bought here says why in words, not only by being grey.
    const why = off ? `<span class="checkout__why" id="co-why-${x}">${esc(t(q.unavailable ? 'billing.checkout.periodUnavailable' : 'billing.checkout.periodLater'))}</span>` : '';
    const badge = x === 'year' && pct ? `<span class="checkout__badge" id="co-badge-year">${esc(t('billing.plans.save', { pct }))}</span>` : '';
    // Named by what the card is; the reason it cannot be chosen is its description, so a screen reader says it once.
    const name = `co-title-${x} co-price-${x} co-billed-${x}${badge ? ` co-badge-${x}` : ''}`;
    return `<button type="button" role="radio" class="checkout__card" data-period="${x}" aria-checked="${x === period}" tabindex="${x === period ? 0 : -1}" aria-labelledby="${name}"${off ? ` disabled aria-describedby="co-why-${x}"` : ''}>
        <span class="checkout__dot" aria-hidden="true"></span>
        <span class="checkout__cardtext"><span class="checkout__cardtitle" id="co-title-${x}">${esc(t(x === 'year' ? 'billing.checkout.cardYear' : 'billing.checkout.cardMonth', { plan: label }))}</span>
        <span class="checkout__cardprice" id="co-price-${x}">${esc(price)}</span>
        <span class="checkout__cardbilled" id="co-billed-${x}">${esc(t(x === 'year' ? 'billing.checkout.billedYear' : 'billing.checkout.billedMonth'))}</span>${why}</span>${badge}
      </button>`;
  });
  return `<div class="checkout__period" role="radiogroup" aria-label="${esc(t('billing.plans.period'))}">${cards.join('')}</div>`;
}

/** Bank transfer is the one way to pay; the balance is offered when there is one, unless the renewal order already decided. */
function methodHtml(checkout, q) {
  const balance = q.balanceVnd > 0
    ? q.useBalance != null
      ? `<p class="plans__muted" data-fixed-balance>${esc(t(q.useBalance ? 'billing.checkout.fixedUse' : 'billing.checkout.fixedNot'))}</p>`
      : `<label class="checkout__balance"><input type="checkbox" data-use-balance${checkout.useBalance ? ' checked' : ''}> ${esc(t('billing.checkout.useBalance', { balance: vnd(q.balanceVnd) }))}</label>`
    : '';
  return `<section class="checkout__method" aria-labelledby="co-method"><h3 id="co-method">${esc(t('billing.checkout.method'))}</h3>
      <p class="checkout__qrmethod"><span class="checkout__dot is-on" aria-hidden="true"></span><span>${esc(t('billing.checkout.methodQr'))}</span></p>
      ${balance}</section>`;
}

/** The consent sentence with its Terms link; the words come from the locale with a marker where the link goes. */
function consentHtml(checked, renews) {
  const marker = '\u0001';
  const link = `<a href="/terms.html" target="_blank" rel="noopener">${esc(t('billing.checkout.terms'))}</a>`;
  const text = esc(t(renews ? 'billing.checkout.consent' : 'billing.checkout.consentOnce', { terms: marker })).replace(marker, link);
  return `<label class="checkout__consent"><input type="checkbox" data-consent${checked ? ' checked' : ''}> <span>${text}</span></label>`;
}

/**
 * The loaded checkout. `dueVnd` and `balanceUsed` are worked out by the caller, who knows whether the balance pays.
 *
 * @param {{ checkout: any, period: string, plan: any, label: string, profile: any, dueVnd: number, balanceUsed: number, busy: boolean }} s
 */
export function checkoutHtml({ checkout, period, plan, label, profile, dueVnd, balanceUsed, busy }) {
  const q = checkout.quotes[period];
  const row = (text, value, cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${esc(text)}</dt><dd>${esc(value)}</dd></div>`;
  const later = q.kind === 'later';
  const lines = [
    row(t('billing.checkout.line', { plan: label, period: t(`billing.period.${period}`) }), vnd(q.priceVnd)),
    q.creditVnd ? row(t('billing.checkout.credit'), `−${vnd(q.creditVnd)}`) : '',
    row(t('billing.checkout.subtotal'), vnd(q.totalVnd)),
    // Only when the seller set a rate; the figure is the server's, worked out as the receipt does (the price includes the tax).
    !later && q.taxRate != null && q.taxVnd != null ? row(t('billing.checkout.tax', { rate: q.taxRate }), vnd(q.taxVnd), 'checkout__tax') : '',
    balanceUsed ? row(t('billing.checkout.balanceUsed'), `−${vnd(balanceUsed)}`) : '',
    row(t('billing.checkout.total'), vnd(dueVnd), 'checkout__total'),
  ].join('');
  const date = q.renewsAt ? rateStamp(q.renewsAt)?.date : '';
  // A plan renews from the balance only when its auto-renew is on (the quote says what the server will do after this order); with it off
  // the box says when the plan ends and where to turn renewal on, and the consent no longer speaks of a renewal.
  const renews = q.autoRenew !== false;
  const renew = !later && date ? `<p class="checkout__renew">${esc(t(renews ? 'billing.checkout.renewInfo' : 'billing.checkout.endInfo', { date }))}</p>` : '';
  // Why Subscribe is off, for anyone who cannot see it is grey: no tick yet, or a change that is not bought here.
  const why = later ? 'co-later' : !checkout.consent ? 'co-consent-hint' : '';
  const off = !checkout.consent || busy || later;
  return `<div class="checkout__bar"><button type="button" class="icon-btn checkout__back" data-back aria-label="${esc(t('billing.back'))}"${busy ? ' disabled' : ''}>${BACK}</button></div>
    <div class="checkout">
      <div class="checkout__main">
        ${periodCardsHtml({ checkout, period, plan, label })}
        ${later ? `<p class="plans__muted" id="co-later" role="status">${esc(t('billing.checkout.later'))}</p>` : ''}
        ${formHtml(checkout.draft || formValues(profile), checkout.formError)}
        ${methodHtml(checkout, q)}
      </div>
      <aside class="checkout__summary" aria-labelledby="co-plan">
        <h3 id="co-plan">${esc(t('billing.checkout.summary', { plan: label }))}</h3>
        <dl class="checkout__lines">${lines}</dl>
        ${renew}
        ${consentHtml(checkout.consent, renews)}
        ${checkout.orderError ? `<p class="plans__error" role="alert">${esc(checkout.orderError)}</p>` : ''}
        <button type="button" class="btn btn--primary checkout__subscribe" data-continue${off ? ' disabled' : ''}${off && why ? ` aria-describedby="${why}"` : ''}>${esc(t('billing.checkout.subscribe'))}</button>
        ${!checkout.consent ? `<p class="checkout__hint plans__muted" id="co-consent-hint">${esc(t('billing.checkout.consentHint'))}</p>` : ''}
      </aside>
    </div>`;
}
