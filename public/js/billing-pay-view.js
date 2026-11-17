import { t, localeTag } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, clock } from './billing-format.js';

/**
 * The QR to pay with, drawn (billing preview, 2026-11-17): the picture, the rows a person can copy, the time left, the status line and
 * the foot with "Cancel this order" and the confirmation that guards it. Pure markup from the order's state; the timers, the polling
 * and what the buttons do stay in billing-plans.js.
 *
 * A customer who has paid and then closes the sheet must never lose the order, so closing keeps it, and the only road to cancelling
 * is the button here followed by the confirmation below.
 */

/** The rows of the QR view a person can copy, in order, and the words each is called by. */
export const COPY = { bank: 'billing.pay.bank', account: 'billing.pay.account', holder: 'billing.pay.holder', amount: 'billing.pay.amount', content: 'billing.pay.content' };
/** One question every 5 s while the order is on screen (the sheet's, and the Billing card's); the server answers at most once a second per order. */
export const POLL_MS = 5000;
/** A renewal order stays good until grace ends, days away: past this the deadline is a date and time, not a clock. */
export const CLOCK_MAX_MS = 3_600_000;

/** What the time left reads as: a clock for the last hour, the date and time of the deadline when it is days away. */
export function deadline(pay) {
  const left = pay.expiresAt - Date.now();
  if (left > CLOCK_MAX_MS) return { label: t('billing.pay.goodUntil'), text: new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(pay.expiresAt)) };
  return { label: t('billing.pay.timeLeft'), text: clock(left) };
}

/**
 * What the status line says. Empty while the order simply waits: the line is a live region that speaks only when something
 * changes (part of it received, paid, expired, cancelled, refunded), not a sentence repeated at everyone who is looking at a QR.
 */
export function statusText(pay) {
  if (pay.state === 'expired') return t('billing.pay.expired');
  if (pay.state === 'cancelled') return t('billing.pay.cancelled');
  if (pay.state === 'refunded') return t('billing.pay.refunded');
  // In terms of what is left to transfer: with the balance used the order's total is not what the bank sees.
  if (pay.received > 0) return t('billing.pay.short', { received: vnd(pay.received), left: vnd(pay.dueVnd) });
  return '';
}

/** Bottom right, red outline: the one destructive control of the sheet; once the wait is over it gives way to the way back. */
export function footHtml(pay) {
  return pay.state === 'waiting' ? `<button type="button" class="btn btn--danger pay__cancel" data-cancel>${esc(t('billing.pay.cancel'))}</button>` : `<button type="button" class="btn btn--primary" data-back>${esc(t('billing.back'))}</button>`;
}

/**
 * The confirmation, in the page and not the browser's (a browser stops showing its own after a few uses). Labelled by its question and
 * described by what to know before answering; the safe answer comes first and takes focus.
 */
export function askHtml() {
  return `<div class="pay__ask" role="alertdialog" aria-labelledby="pay-ask-q" aria-describedby="pay-ask-why" data-ask>
    <p><strong id="pay-ask-q">${esc(t('billing.pay.askTitle'))}</strong> <span id="pay-ask-why">${esc(t('billing.pay.askBody'))}</span></p>
    <p class="plans__actions"><button type="button" class="btn btn--primary" data-ask-keep>${esc(t('billing.pay.askKeep'))}</button> <button type="button" class="btn btn--danger" data-ask-confirm>${esc(t('billing.pay.askConfirm'))}</button></p>
  </div>`;
}

export function payHtml(pay) {
  const q = pay.qr;
  const labels = Object.fromEntries(Object.entries(COPY).map(([k, key]) => [k, t(key)]));
  const values = { bank: q.bank, account: q.account, holder: q.holder, amount: vnd(q.amount), content: q.content };
  const waiting = pay.state === 'waiting';
  const shown = deadline(pay);
  return `<div class="pay">
      <p class="pay__lead">${esc(t('billing.pay.lead'))}</p>
      ${pay.note ? `<p class="pay__note" data-pay-note>${esc(t('billing.pay.alreadyOpen'))}</p>` : ''}
      <div class="pay__grid">
        <div class="pay__qr"><img src="${esc(q.image)}" alt="${esc(t('billing.pay.qrAlt', { amount: vnd(q.amount), content: q.content }))}" width="220" height="220"></div>
        <dl class="pay__rows">${Object.keys(COPY).map((k) => `<div><dt>${esc(labels[k])}</dt><dd id="pay-${k}">${esc(values[k])}</dd><button type="button" class="btn btn--small" data-copy="${k}" aria-label="${esc(t('billing.pay.copy', { what: labels[k] }))}">${esc(t('billing.pay.copyShort'))}</button></div>`).join('')}</dl>
      </div>
      <p class="pay__time"${waiting ? '' : ' hidden'}><span class="pay__timelabel">${esc(shown.label)}</span> <span class="pay__timer" role="timer" aria-live="off">${esc(shown.text)}</span></p>
      <p class="pay__status" role="status" tabindex="-1">${esc(statusText(pay))}</p>
      <div class="plans__foot pay__foot">${footHtml(pay)}</div>
    </div>`;
}
