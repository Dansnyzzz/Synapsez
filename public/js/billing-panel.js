import { t, localeTag } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, planName, minutes, clock } from './billing-format.js';
import { PROFILE_FIELDS } from './billing-checkout-view.js';
import { POLL_MS } from './billing-pay-view.js';

/**
 * Settings → Billing (billing preview, 2026-11-15): the plan, the credits, the low-balance email, what this month used, the
 * billing information, the payment method, the ledger and the receipts. Claude's tab with OpenRouter's Credits card, drawn
 * for bank transfer: nothing here charges anything, money goes to the balance by a QR the plans sheet shows.
 *
 * Nothing polls. The tab is read when it is opened, after each thing done on it, and when the plans sheet says something
 * changed while this tab is on screen. Each card is drawn on its own, so a switch pressed redraws its card and not the page,
 * and what is typed in another card is not lost. A card that is redrawn gives focus back to the control that had it.
 */

const CHIPS = ['all', 'topup', 'plan', 'usage'];
const PAGE = 20;
const MAX_PAGES = 25;
/** The server's grace (server/billing/plans.js GRACE_DAYS), only to say the date a plan in grace ends. */
const GRACE_MS = 3 * 86_400_000;
const LOW_DEFAULT = 50_000;
const LOW_MAX = 100_000_000;
const SECTIONS = ['pending', 'plan', 'credits', 'alerts', 'period', 'info', 'payment', 'tx', 'receipts'];
const KIND_WORDS = { topup: 'topup', plan: 'plan', usage: 'usage', promo: 'promo', assign: 'assign', expire: 'expire', forfeit: 'forfeit', adjust: 'adjust', refund: 'refund' };

/** @param {string | number | Date} value @param {'full' | 'long' | 'medium' | 'short'} [style] */
const dateOf = (value, style = 'long') => new Intl.DateTimeFormat(localeTag(), { dateStyle: style }).format(new Date(value));
const count = (n) => new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(n);
const signed = (n) => `${n < 0 ? '−' : '+'}${vnd(Math.abs(n))}`;

/**
 * @param {HTMLElement} host
 * @param {{ api: any, toast: (message: string, kind?: string) => void, plans: { open: () => any, openCheckout: (plan: string, period: string) => any, openTopUp: (amount: number) => any } }} deps
 */
export function createBillingPanel(host, { api, toast, plans }) {
  /** @type {any} */ let account = null;
  /** @type {any[]} */ let receipts = [];
  const feed = { chip: 'all', entries: [], next: null, loading: false, gen: 0 };
  // What is typed or open, kept across a redraw of its card.
  const ui = { topupOpen: false, amount: '', amountError: '', promo: '', promoMessage: null, low: '', lowError: '', editInfo: false, infoDraft: null, infoError: '', busy: false };
  let active = false;
  let built = false;
  let failure = '';
  // What each card last drew: an identical card is left alone, so a read that found nothing new does not replace the button the
  // plans sheet will hand focus back to when it closes.
  const drawn = new Map();
  // The newest read wins: an answer that comes back after a newer one was asked for is for a screen that has moved on.
  let latest = 0;
  // The pending-order card's one-second clock and its status question (every POLL_MS): they run only while that card is on screen,
  // for one order at a time. `gaveUp` is the order whose end this page has already read for, so a clock that disagrees with the
  // server's can cost one read and never a loop.
  let pendingTimer = 0;
  let pendingPoll = 0;
  let watched = null;
  let asking = false;
  let gaveUp = null;

  const $ = (selector) => /** @type {HTMLElement | null} */ (host.querySelector(selector));
  const section = (name) => $(`[data-sec="${name}"]`);

  /** Words said in the one status line the page keeps, so a screen reader hears what changed without focus moving. */
  function say(text) {
    const live = $('#bill-live');
    if (live) live.textContent = text;
  }

  /* ── drawing ──────────────────────────────────────────────────────── */
  function build() {
    host.innerHTML = `<p class="plans__preview">${esc(t('billing.previewNote'))}</p>
      <p id="bill-live" class="sr-only" role="status" aria-live="polite"></p>
      <div data-fail></div>
      ${SECTIONS.map((name) => `<section class="bill__card" data-sec="${name}" aria-labelledby="bill-h-${name}" hidden></section>`).join('')}`;
    built = true;
  }

  /** The control that has focus inside a card, as something that can be found again after the card is redrawn. */
  function focusKey(node) {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !node.contains(el)) return null;
    return el.id ? `#${el.id}` : el.dataset.focus ? `[data-focus="${el.dataset.focus}"]` : null;
  }

  function paint(names = SECTIONS) {
    if (!built) build();
    const fail = $('[data-fail]');
    if (fail) fail.innerHTML = failure ? `<p class="plans__error" role="alert">${esc(failure)}</p><p><button type="button" class="btn" data-retry>${esc(t('billing.retry'))}</button></p>` : '';
    for (const name of names) {
      const node = section(name);
      if (!node) continue;
      node.hidden = !account;
      if (!account) continue;
      const key = focusKey(node);
      const html = { pending: pendingHtml, plan: planHtml, credits: creditsHtml, alerts: alertsHtml, period: periodHtml, info: infoHtml, payment: paymentHtml, tx: txHtml, receipts: receiptsHtml }[name]();
      // Only while an order waits for its transfer is there a card at all.
      if (name === 'pending') node.hidden = !html;
      if (drawn.get(name) === html) continue;
      drawn.set(name, html);
      node.innerHTML = html;
      if (key) /** @type {HTMLElement | null} */ (node.querySelector(key))?.focus();
    }
    syncPendingClock();
  }

  /* ── the order that is still waiting ──────────────────────────────── */

  /**
   * "Order waiting for payment": what it is for, what is left to transfer, the time it has and the way back to its QR. The time is
   * not in the markup (it changes every second and would make every read look like a new card); syncPendingClock writes it.
   */
  function pendingHtml() {
    const p = account.pending;
    if (!p) return '';
    const what = p.kind === 'topup' ? t('billing.panel.pendingTopup') : `${planName(p.plan)} · ${t(`billing.period.${p.period}`)}`;
    return `${head('pending')}<div class="bill__pending"><div class="bill__pending-what"><p>${esc(what)} · ${esc(vnd(p.dueVnd))}</p><p class="plans__muted bill__pending-left" data-pending-left></p></div><button type="button" class="btn btn--primary" data-pending-view data-focus="pending-view">${esc(t('billing.panel.pendingView'))}</button></div>`;
  }

  function stopPending() {
    clearInterval(pendingTimer);
    clearInterval(pendingPoll);
    pendingTimer = 0;
    pendingPoll = 0;
    watched = null;
  }

  /** The time left on the card; an order is good for 30 minutes (a renewal has no card), so it is always a clock. */
  const pendingLeftText = () => t('billing.panel.pendingLeft', { time: clock(Date.parse(account.pending.expiresAt) - Date.now()) });

  function tickPending() {
    const p = account?.pending;
    if (!p) return;
    if (Date.parse(p.expiresAt) <= Date.now()) {
      // Over by this page's clock: the card goes now, and the server is asked once. If it still offers the order (the two clocks
      // disagree) the card is dropped again without another read.
      account.pending = null;
      stopPending();
      paint(['pending']);
      if (gaveUp !== p.id) {
        gaveUp = p.id;
        void read();
      }
      return;
    }
    const node = $('[data-pending-left]');
    const text = pendingLeftText();
    if (node && node.textContent !== text) node.textContent = text;
  }

  /**
   * While the card is on screen and the page is visible, the order is asked about as the sheet does: once it is not pending, or part of
   * it arrived, the tab is read again so the card ends (or shows what is left to transfer) without the customer doing anything.
   */
  async function askPending() {
    const p = account?.pending;
    if (!p || asking || document.hidden || !active || document.querySelector('#plans[open]')) return;
    asking = true;
    try {
      const s = await api.billingOrderStatus(p.id);
      if (account?.pending?.id !== p.id) return;
      if (s.status !== 'pending' || s.receivedVnd !== p.receivedVnd || s.dueVnd !== p.dueVnd) await read();
    } catch {
      /* asked again in a few seconds */
    } finally {
      asking = false;
    }
  }

  /** Starts (or keeps) the clock and the question for the order on the card, writes the time now; stops both when there is no card. */
  function syncPendingClock() {
    const p = active ? account?.pending : null;
    if (!p) return stopPending();
    if (watched !== p.id) {
      stopPending();
      watched = p.id;
      pendingTimer = window.setInterval(tickPending, 1000);
      pendingPoll = window.setInterval(() => void askPending(), POLL_MS);
    }
    tickPending();
  }

  /** @param {string} name */
  const head = (name, extra = '') => `<h4 id="bill-h-${name}" tabindex="-1">${esc(t(`billing.panel.${name}`))}</h4>${extra}`;

  /* ── the plan ─────────────────────────────────────────────────────── */

  /** What a renewal would buy: the change that is scheduled, else what ran. Renew now and the grace line both speak of this, not of the plan that ended. */
  const renewalOf = (p) => ({ plan: p.nextPlan ?? p.plan, period: p.nextPeriod ?? p.period });

  function planLine(p) {
    const end = p.end ? dateOf(p.end) : '';
    if (p.plan === 'free') return t('billing.panel.freeLine');
    if (p.cancelAtEnd) return t('billing.panel.ends', { date: end });
    if (p.status === 'grace') {
      // Only an account that renews by itself is topped up by credit alone; without that the person has to press Renew now.
      return t(p.autoRenew ? 'billing.panel.grace' : 'billing.panel.graceNow', { date: dateOf(new Date(p.end).getTime() + GRACE_MS), plan: planName(renewalOf(p).plan) });
    }
    if (p.nextPlan && (p.nextPlan !== p.plan || p.nextPeriod !== p.period)) return t('billing.plans.changesOn', { plan: planName(p.nextPlan), date: end });
    return p.autoRenew ? t('billing.panel.renews', { date: end }) : t('billing.panel.noRenew', { date: end });
  }

  function planHtml() {
    const p = account.plan;
    const free = p.plan === 'free';
    const grace = p.status === 'grace';
    const price = free ? '' : ` · ${vnd(p.priceVnd)} ${t(`billing.per.${p.period}`)}`;
    const buttons = [
      grace && !p.cancelAtEnd ? `<button type="button" class="btn btn--primary" data-renew data-focus="renew">${esc(t('billing.panel.renew'))}</button>` : '',
      `<button type="button" class="btn${grace || free ? '' : ' btn--primary'}" data-adjust data-focus="adjust">${esc(t(free ? 'billing.panel.choose' : 'billing.panel.adjust'))}</button>`,
      !free && !p.cancelAtEnd && !grace ? `<button type="button" class="btn" data-cancel-plan data-focus="plan-toggle">${esc(t('billing.panel.cancel'))}</button>` : '',
      !free && p.cancelAtEnd ? `<button type="button" class="btn" data-keep-plan data-focus="plan-toggle">${esc(t('billing.panel.keep'))}</button>` : '',
    ].join('');
    const renew = free ? '' : `<label class="bill__switch"><input type="checkbox" role="switch" id="bill-autorenew"${p.autoRenew ? ' checked' : ''}${ui.busy ? ' disabled' : ''}> <span>${esc(t('billing.panel.autoRenew'))}</span></label>`;
    return `${head('plan')}<p class="bill__name">${esc(planName(p.plan))}${esc(price)}</p><p class="bill__line">${esc(planLine(p))}</p><div class="bill__actions">${buttons}</div>${renew}`;
  }

  /* ── the credits ──────────────────────────────────────────────────── */
  function creditsHtml() {
    const { balance, bounds } = account;
    const presets = bounds.presets.map((n) => `<button type="button" class="btn btn--small" data-preset="${n}"${String(n) === ui.amount ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(vnd(n))}</button>`).join(' ');
    const form = ui.topupOpen
      ? `<form class="bill__form" data-topup-form novalidate>
          <div class="bill__presets" role="group" aria-label="${esc(t('billing.panel.presets'))}">${presets}</div>
          <div class="field"><label for="bill-amount">${esc(t('billing.panel.amount'))}</label>
            <input id="bill-amount" type="number" inputmode="numeric" min="${minTopup()}" step="1000" value="${esc(ui.amount)}" aria-describedby="bill-amount-hint bill-amount-err"${ui.amountError ? ' aria-invalid="true"' : ''}></div>
          <p id="bill-amount-hint" class="plans__muted">${esc(t('billing.panel.amountHint', { min: vnd(minTopup()), max: vnd(maxBalance()) }))}</p>
          <p id="bill-amount-err" class="plans__error" role="alert">${esc(ui.amountError)}</p>
          <p class="bill__actions"><button type="submit" class="btn btn--primary" data-topup-go>${esc(t('billing.panel.toQr'))}</button> <button type="button" class="btn" data-topup-cancel>${esc(t('action.cancel'))}</button></p>
        </form>`
      : '';
    const promoMessage = ui.promoMessage ? `<p id="bill-promo-msg" class="${ui.promoMessage.ok ? 'plans__muted' : 'plans__error'}" role="${ui.promoMessage.ok ? 'status' : 'alert'}">${esc(ui.promoMessage.text)}</p>` : '<p id="bill-promo-msg" class="plans__muted"></p>';
    return `${head('credits')}
      <p class="bill__total"><span class="bill__total-label">${esc(t('billing.panel.total'))}</span> <span class="bill__total-amount">${esc(vnd(balance.vnd))}</span></p>
      ${balance.expiresAt ? `<p class="plans__muted bill__expiry">${esc(t('billing.panel.expires', { date: dateOf(balance.expiresAt) }))}</p>` : ''}
      <div class="bill__actions"><button type="button" class="btn btn--primary" data-add-credits data-focus="add" aria-expanded="${ui.topupOpen}">${esc(t('billing.panel.addCredits'))}</button> <button type="button" class="btn" data-view-usage data-focus="usage">${esc(t('billing.panel.viewUsage'))}</button></div>
      ${form}
      <form class="bill__promo" data-promo-form novalidate>
        <div class="field"><label for="bill-promo">${esc(t('billing.panel.promoLabel'))}</label>
          <input id="bill-promo" autocomplete="off" spellcheck="false" autocapitalize="characters" maxlength="40" value="${esc(ui.promo)}" aria-describedby="bill-promo-msg"></div>
        <button type="submit" class="btn" data-redeem>${esc(t('billing.panel.redeem'))}</button>
      </form>${promoMessage}`;
  }

  const withPlan = () => account.plan.plan !== 'free';
  const minTopup = () => (withPlan() ? account.bounds.minWithPlan : account.bounds.minNoPlan);
  const maxBalance = () => (withPlan() ? account.bounds.maxBalanceWithPlan : account.bounds.maxBalanceNoPlan);

  /** The sentence that says what is wrong with an amount, or '' when it can go to a QR. */
  function amountProblem(input) {
    if (input.validity.badInput) return t('billing.panel.amountBad');
    const text = input.value.trim();
    if (!text) return t('billing.panel.amountEmpty');
    const n = Number(text);
    if (!Number.isSafeInteger(n)) return t('billing.panel.amountWhole');
    if (n < minTopup()) return t('billing.panel.amountMin', { min: vnd(minTopup()) });
    if (account.balance.vnd + n > maxBalance()) return t('billing.panel.amountMax', { max: vnd(maxBalance()) });
    return '';
  }

  /* ── the low-balance email ────────────────────────────────────────── */
  function alertsHtml() {
    const on = account.alerts.lowBalanceVnd != null;
    const value = ui.low || String(on ? account.alerts.lowBalanceVnd : LOW_DEFAULT);
    return `${head('alerts')}
      <label class="bill__switch"><input type="checkbox" role="switch" id="bill-low-on"${on ? ' checked' : ''}> <span>${esc(t('billing.panel.lowOn'))}</span></label>
      <div class="field"><label for="bill-low-amount">${esc(t('billing.panel.lowAmount'))}</label>
        <input id="bill-low-amount" type="number" inputmode="numeric" min="1000" step="1000" value="${esc(value)}"${on ? '' : ' disabled'} aria-describedby="bill-low-hint bill-low-err"${ui.lowError ? ' aria-invalid="true"' : ''}></div>
      <p id="bill-low-err" class="plans__error" role="alert">${esc(ui.lowError)}</p>
      <p id="bill-low-hint" class="plans__muted">${esc(t('billing.panel.lowHint'))}</p>`;
  }

  /* ── what this month used ─────────────────────────────────────────── */
  function bar(used, total, label) {
    if (!total) return '';
    const share = Math.min(1, used / total);
    return `<div class="usage__bar${share >= 1 ? ' is-out' : share >= 0.9 ? ' is-close' : ''}" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${Math.min(used, total)}"><span style="width:${Math.round(share * 100)}%"></span></div>`;
  }

  function periodHtml() {
    const u = account.usage;
    const would = u.would || {};
    const searchLeft = Math.max(0, u.search.included - u.search.used);
    const sandboxLeft = Math.max(0, u.sandbox.includedSeconds - u.sandbox.usedSeconds);
    const gb = u.storage.bytes / 1e9;
    const row = (kind, title, summary, barHtml, lines) => `<div class="bill__kind" data-kind="${kind}"><p class="bill__kindhead"><span>${esc(title)}</span> <span>${esc(summary)}</span></p>${barHtml}${lines.filter(Boolean).map((l) => `<p class="plans__muted">${esc(l)}</p>`).join('')}</div>`;
    const search = row(
      'search', t('billing.panel.kind.search'),
      u.search.included ? t('billing.panel.left', { n: count(searchLeft), total: count(u.search.included) }) : t('billing.panel.notIncluded'),
      bar(u.search.used, u.search.included, t('billing.panel.kind.search')),
      [u.search.paidUnits ? t('billing.panel.paidSearch', { n: count(u.search.paidUnits), vnd: vnd(u.search.paidVnd) }) : '', would.search ? t('billing.panel.wouldSearch', { n: count(would.search) }) : ''],
    );
    const sandbox = row(
      'sandbox', t('billing.panel.kind.sandbox'),
      u.sandbox.includedSeconds ? t('billing.panel.leftTime', { time: minutes(sandboxLeft), total: minutes(u.sandbox.includedSeconds) }) : t('billing.panel.notIncluded'),
      bar(u.sandbox.usedSeconds, u.sandbox.includedSeconds, t('billing.panel.kind.sandbox')),
      [u.sandbox.paidMinutes ? t('billing.panel.paidSandbox', { time: minutes(u.sandbox.paidMinutes * 60), vnd: vnd(u.sandbox.paidVnd) }) : '', would.sandbox ? t('billing.panel.wouldSandbox', { time: minutes(would.sandbox) }) : ''],
    );
    const storage = row(
      'storage', t('billing.panel.kind.storage'),
      t('billing.panel.usedGb', { used: count(gb), total: count(u.storage.includedGb) }),
      bar(gb, u.storage.includedGb, t('billing.panel.kind.storage')),
      [u.storage.paidVnd ? t('billing.panel.paidStorage', { vnd: vnd(u.storage.paidVnd) }) : ''],
    );
    const finance = `<p class="bill__kindhead" data-finance><span>${esc(t('billing.panel.kind.finance'))}</span> <span>${esc(t('billing.panel.free'))}</span></p>`;
    const until = u.month?.end ? `<p class="plans__muted">${esc(t('billing.panel.resets', { date: dateOf(u.month.end) }))}</p>` : '';
    return `${head('period')}${until}${search}${sandbox}${storage}${finance}`;
  }

  /* ── billing information, payment method ──────────────────────────── */
  function infoHtml() {
    const p = account.profile;
    if (ui.editInfo) {
      const f = ui.infoDraft || p || {};
      const field = (id, key, value, extra = '') => `<div class="field"><label for="bp-${id}">${esc(t(`billing.profile.${key}`))}</label><input id="bp-${id}" name="${id}" value="${esc(value ?? '')}" ${extra}></div>`;
      return `${head('info')}<form data-info-form novalidate>
        ${PROFILE_FIELDS.map((p) => field(p.id, p.label, f[p.key], p.extra)).join('')}
        ${ui.infoError ? `<p class="plans__error" id="bp-err" role="alert" tabindex="-1">${esc(ui.infoError)}</p>` : ''}
        <p class="bill__actions"><button type="submit" class="btn btn--primary" data-save-info>${esc(t('billing.profile.save'))}</button> <button type="button" class="btn" data-cancel-info>${esc(t('billing.profile.cancel'))}</button></p>
      </form>`;
    }
    const rows = p ? [p.name, p.email, p.country, p.address, p.companyName, p.taxCode ? t('billing.profile.taxLine', { code: p.taxCode }) : '', p.invoiceName].filter(Boolean) : [];
    const body = rows.length ? rows.map((r) => `<p class="bill__info">${esc(r)}</p>`).join('') : `<p class="plans__muted">${esc(t('billing.panel.noInfo'))}</p>`;
    return `${head('info')}${body}<p><button type="button" class="btn btn--small" data-edit-info data-focus="edit-info">${esc(t(rows.length ? 'billing.profile.update' : 'billing.panel.addInfo'))}</button></p>`;
  }

  function paymentHtml() {
    return `${head('payment')}<p>${esc(t('billing.panel.paymentBody'))}</p>`;
  }

  /* ── transactions and receipts ────────────────────────────────────── */
  function whatOf(e) {
    if (e.kind === 'usage') return t(`billing.panel.tx.usage.${['search', 'sandbox', 'storage'].includes(e.category) ? e.category : 'other'}`);
    return t(`billing.panel.tx.${KIND_WORDS[e.kind] || 'other'}`);
  }

  function txRow(e) {
    return `<li data-tx="${e.id}" tabindex="-1"><span class="bill__tx-what"><span>${esc(whatOf(e))}</span> <span class="plans__muted">${esc(dateOf(e.createdAt, 'medium'))}</span></span>
      <span class="bill__tx-amt${e.deltaVnd < 0 ? ' is-out' : ''}">${esc(signed(e.deltaVnd))}</span>${e.balanceAfterVnd == null ? '' : `<span class="bill__tx-bal plans__muted">${esc(t('billing.panel.balanceAfter', { vnd: vnd(e.balanceAfterVnd) }))}</span>`}</li>`;
  }

  function txHtml() {
    const chips = CHIPS.map((c) => `<button type="button" class="btn btn--small bill__chip" data-chip="${c}" data-focus="chip-${c}" aria-pressed="${feed.chip === c}">${esc(t(`billing.panel.chip.${c}`))}</button>`).join(' ');
    const list = feed.entries.length ? `<ul class="bill__tx">${feed.entries.map(txRow).join('')}</ul>` : `<p class="plans__muted">${esc(t(feed.loading ? 'common.loading' : feed.next != null ? 'billing.panel.noneYet' : 'billing.panel.noTx'))}</p>`;
    const more = feed.next != null ? `<p><button type="button" class="btn" data-more data-focus="more"${feed.loading ? ' disabled' : ''}>${esc(t('billing.panel.more'))}</button></p>` : '';
    return `${head('tx')}<div class="bill__chips" role="group" aria-label="${esc(t('billing.panel.chips'))}">${chips}</div>${list}${more}`;
  }

  function receiptsHtml() {
    const rows = receipts.map((r) => `<li><span>${esc(dateOf(r.issuedAt, 'medium'))}</span> <span class="bill__num">${esc(r.number)}</span> <span>${esc(vnd(r.amountVnd))}</span>
      <a href="/api/billing/receipts/${encodeURIComponent(r.number)}.pdf" target="_blank" rel="noopener" aria-label="${esc(t('billing.panel.downloadFor', { number: r.number }))}">${esc(t('billing.panel.download'))}</a></li>`).join('');
    return `${head('receipts')}${rows ? `<ul class="bill__receipts">${rows}</ul>` : `<p class="plans__muted">${esc(t('billing.panel.noReceipts'))}</p>`}`;
  }

  /* ── reading ──────────────────────────────────────────────────────── */
  const visible = (entries) => entries.filter((e) => !(e.kind === 'usage' && !e.units));

  /**
   * One page of what is worth showing. A page that is all hidden rows (a charge and its refund on a free back-end) would leave Load
   * more with nothing to draw, so the next page is read until a row arrives or there are no more.
   */
  async function readFeed(before = null, chip = feed.chip) {
    let cursor = before;
    // Bounded, so one press cannot read a whole ledger of hidden rows page by page. Past the bound there may still be more.
    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      const page = await api.billingTransactions({ kind: chip === 'all' ? null : chip, limit: PAGE, before: cursor });
      const entries = visible(page.entries || []);
      const next = page.next ?? null;
      if (entries.length || next == null) return { entries, next };
      cursor = next;
    }
    return { entries: [], next: cursor };
  }

  /** Everything the tab shows, read again. Typed text and an open form stay as they are. */
  async function read() {
    const mine = ++latest;
    // The list is for the chip that was chosen when this began, and replaces whatever a Load more has in flight.
    const chip = feed.chip;
    const gen = ++feed.gen;
    try {
      const [acc, first, list] = await Promise.all([api.billing(), readFeed(null, chip), api.billingReceipts()]);
      if (mine !== latest) return;
      account = acc;
      if (feed.chip === chip && feed.gen === gen) {
        feed.entries = first.entries;
        feed.next = first.next;
        feed.loading = false;
      }
      receipts = list.receipts || [];
      failure = '';
    } catch (err) {
      if (mine !== latest) return;
      feed.loading = false;
      failure = err.message;
    }
    paint();
  }

  async function load() {
    active = true;
    if (!built) build();
    // Said every time, so a tab opened again is not taken for the old figures before the new ones arrive.
    const fail = $('[data-fail]');
    if (fail) fail.innerHTML = `<p class="plans__muted" data-loading>${esc(t('common.loading'))}</p>`;
    await read();
  }

  function leave() {
    active = false;
    latest += 1;
    stopPending();
  }

  /** The plans sheet says something changed: read again, but only for a tab that is on screen. */
  async function changed() {
    if (!active || !host.closest('dialog')?.open) return;
    await read();
  }

  /** Does something to the account, then reads again; a refusal is said where the person is looking. */
  async function act(run, done) {
    if (ui.busy) return;
    ui.busy = true;
    try {
      await run();
      if (done) say(done);
    } catch (err) {
      toast(err.message, 'error');
      // A switch the person turned is not what the card says any more: draw it again.
      drawn.clear();
    } finally {
      ui.busy = false;
    }
    await read();
  }

  /* ── events ───────────────────────────────────────────────────────── */
  async function chooseChip(chip) {
    if (feed.loading || chip === feed.chip) return;
    feed.chip = chip;
    feed.loading = true;
    feed.entries = [];
    feed.next = null;
    const gen = ++feed.gen;
    paint(['tx']);
    try {
      const first = await readFeed(null, chip);
      if (gen !== feed.gen) return;
      feed.entries = first.entries;
      feed.next = first.next;
    } catch (err) {
      if (gen === feed.gen) toast(err.message, 'error');
    } finally {
      if (gen === feed.gen) feed.loading = false;
    }
    paint(['tx']);
    say(t('billing.panel.shown', { n: feed.entries.length }));
  }

  async function more() {
    if (feed.loading || feed.next == null) return;
    feed.loading = true;
    const gen = feed.gen;
    // A read that lands while this is on its way must draw the card again, not be taken for the card as it was.
    drawn.delete('tx');
    const list = $('.bill__tx');
    const button = /** @type {HTMLButtonElement | null} */ ($('[data-more]'));
    if (button) button.disabled = true;
    try {
      const page = await readFeed(feed.next, feed.chip);
      // A read (or another chip) replaced the list while this was on its way: these rows belong to a list that is gone.
      if (gen !== feed.gen) return;
      const first = feed.entries.length;
      feed.entries = feed.entries.concat(page.entries);
      feed.next = page.next;
      feed.loading = false;
      // Appended in place so the rows already read stay where they are; focus goes to the first new one.
      if (list) {
        list.insertAdjacentHTML('beforeend', page.entries.map(txRow).join(''));
        if (!feed.next) button?.closest('p')?.remove();
        else if (button) button.disabled = false;
        (list.querySelectorAll('li')[first] ?? null)?.focus();
      } else {
        // Nothing was drawn yet, so there is no list to add to: draw the card.
        paint(['tx']);
        $('.bill__tx li')?.focus();
      }
      // What is on screen now is what the card would draw, so a later read that finds the same list leaves it alone (and one that finds
      // a different list, the first page again, draws it).
      drawn.set('tx', txHtml());
      say(t('billing.panel.shown', { n: feed.entries.length }));
    } catch (err) {
      if (gen === feed.gen) feed.loading = false;
      if (button) button.disabled = false;
      toast(err.message, 'error');
    }
  }

  function submitTopup() {
    const input = /** @type {HTMLInputElement} */ ($('#bill-amount'));
    ui.amount = input.value.trim();
    ui.amountError = amountProblem(input);
    if (ui.amountError) {
      paint(['credits']);
      $('#bill-amount')?.focus();
      return;
    }
    const amount = Number(ui.amount);
    ui.topupOpen = false;
    ui.amount = '';
    paint(['credits']);
    void plans.openTopUp(amount);
  }

  async function redeem() {
    const input = /** @type {HTMLInputElement} */ ($('#bill-promo'));
    ui.promo = input.value.trim();
    if (!ui.promo || ui.busy) {
      ui.promoMessage = ui.promo ? ui.promoMessage : { ok: false, text: t('billing.panel.promoEmpty') };
      paint(['credits']);
      $('#bill-promo')?.focus();
      return;
    }
    ui.busy = true;
    try {
      const done = await api.billingPromo(ui.promo);
      ui.promo = '';
      ui.promoMessage = { ok: true, text: t('billing.panel.promoDone', { vnd: vnd(done.creditedVnd) }) };
      say(ui.promoMessage.text);
    } catch (err) {
      ui.promoMessage = { ok: false, text: err.message };
    } finally {
      ui.busy = false;
    }
    await read();
    $('#bill-promo')?.focus();
  }

  async function saveInfo() {
    const form = /** @type {HTMLFormElement} */ ($('form[data-info-form]'));
    const value = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name)).value.trim();
    // One list of the fields (the checkout's): the PUT replaces the whole profile, so a second copy would drop what it forgot.
    const body = Object.fromEntries(PROFILE_FIELDS.map((p) => [p.key, value(p.id)]));
    ui.infoDraft = body;
    if (!body.name || !body.email || !body.country) {
      ui.infoError = t('billing.profile.required');
      paint(['info']);
      $(`#bp-${!body.name ? 'name' : !body.email ? 'email' : 'country'}`)?.focus();
      return;
    }
    try {
      await api.billingProfile(body);
      ui.editInfo = false;
      ui.infoDraft = null;
      ui.infoError = '';
      say(t('billing.panel.infoSaved'));
    } catch (err) {
      ui.infoError = err.message;
      paint(['info']);
      $('#bp-err')?.focus();
      return;
    }
    await read();
    $('[data-edit-info]')?.focus();
  }

  async function saveLow(on) {
    const input = /** @type {HTMLInputElement} */ ($('#bill-low-amount'));
    ui.low = input.value.trim();
    const amount = Number(ui.low || LOW_DEFAULT);
    if (on && (!Number.isSafeInteger(amount) || amount < 1000 || amount > LOW_MAX)) {
      ui.lowError = t('billing.panel.lowBad', { max: vnd(LOW_MAX) });
      paint(['alerts']);
      $('#bill-low-amount')?.focus();
      return;
    }
    ui.lowError = '';
    // A change event that finds the saved figure already there (blur after a typed save) asks for nothing.
    if (on && account.alerts.lowBalanceVnd === amount) return;
    await act(() => api.billingAlerts({ lowBalanceVnd: on ? amount : null }), t(on ? 'billing.panel.lowSaved' : 'billing.panel.lowOff'));
    ui.low = '';
    paint(['alerts']);
  }

  host.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button'));
    if (!el) return;
    if (el.hasAttribute('data-retry')) return void read();
    if (el.hasAttribute('data-adjust') || el.hasAttribute('data-pending-view')) return void plans.open();
    if (el.hasAttribute('data-renew')) {
      const next = renewalOf(account.plan);
      return void plans.openCheckout(next.plan, next.period);
    }
    if (el.hasAttribute('data-cancel-plan')) return void act(() => api.billingSubscription({ cancelAtEnd: true }), t('billing.panel.cancelled', { date: dateOf(account.plan.end) }));
    if (el.hasAttribute('data-keep-plan')) return void act(() => api.billingSubscription({ cancelAtEnd: false }), t('billing.panel.kept'));
    if (el.hasAttribute('data-add-credits')) {
      ui.topupOpen = !ui.topupOpen;
      paint(['credits']);
      if (ui.topupOpen) $('#bill-amount')?.focus();
      else $('[data-add-credits]')?.focus();
      return;
    }
    if (el.hasAttribute('data-topup-cancel')) {
      ui.topupOpen = false;
      ui.amountError = '';
      paint(['credits']);
      $('[data-add-credits]')?.focus();
      return;
    }
    if (el.dataset.preset) {
      ui.amount = el.dataset.preset;
      ui.amountError = '';
      paint(['credits']);
      $(`[data-preset="${el.dataset.preset}"]`)?.focus();
      return;
    }
    if (el.hasAttribute('data-view-usage')) {
      const heading = $('#bill-h-period');
      heading?.scrollIntoView({ block: 'start' });
      heading?.focus();
      return;
    }
    if (el.dataset.chip) return void chooseChip(el.dataset.chip);
    if (el.hasAttribute('data-more')) return void more();
    if (el.hasAttribute('data-edit-info')) {
      ui.editInfo = true;
      ui.infoDraft = null;
      ui.infoError = '';
      paint(['info']);
      $('#bp-name')?.focus();
      return;
    }
    if (el.hasAttribute('data-cancel-info')) {
      ui.editInfo = false;
      ui.infoError = '';
      paint(['info']);
      $('[data-edit-info]')?.focus();
    }
  });

  host.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = /** @type {HTMLElement} */ (event.target);
    if (form.matches('[data-topup-form]')) submitTopup();
    else if (form.matches('[data-promo-form]')) void redeem();
    else if (form.matches('[data-info-form]')) void saveInfo();
  });

  host.addEventListener('change', (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (el.id === 'bill-autorenew') void act(() => api.billingSubscription({ autoRenew: el.checked }), t(el.checked ? 'billing.panel.autoOn' : 'billing.panel.autoOff'));
    else if (el.id === 'bill-low-on') void saveLow(el.checked);
    else if (el.id === 'bill-low-amount' && $('#bill-low-on') && /** @type {HTMLInputElement} */ ($('#bill-low-on')).checked) void saveLow(true);
  });

  // What is typed survives a redraw of its card (a switch pressed elsewhere on the tab, the sheet telling us something changed).
  host.addEventListener('input', (event) => {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (el.id === 'bill-amount') ui.amount = el.value;
    else if (el.id === 'bill-promo') ui.promo = el.value;
    else if (el.id === 'bill-low-amount') ui.low = el.value;
  });

  return { load, leave, changed };
}
