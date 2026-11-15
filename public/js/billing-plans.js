import { t, currentLanguage, localeTag } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, usd, planName, minutes, clock } from './billing-format.js';

/**
 * The plans sheet and the checkout by SePay VietQR (billing preview, 2026-11-14) — one lazy
 * `<dialog id="plans">` with four views: the plans, the checkout, the QR to pay with, and "you're on
 * Plus". Nothing here runs for an account the server says does not see billing: app.js never asks.
 *
 * Plans are a month's allowance with no daily figure anywhere (owner, 2026-11-13). The money shown
 * large is the one the person pays in: đồng in Vietnamese, US dollars in English with the đồng it is
 * billed as beneath — the order locks that rate and price for the 30 minutes its QR is good.
 */

const ORDER = ['free', 'plus', 'pro', 'max'];
const RANK = { free: 0, plus: 1, pro: 2, max: 3 };
/** What a free account has: nothing metered included, half a gigabyte of storage (owner's table). */
const FREE = { searches: 0, sandboxMinutes: 0, storageGb: 0.5 };
/** One question every 5 s while the tab is visible; the server answers at most once a second per order. */
const POLL_MS = 5000;
const ATTRIBUTION = 'https://www.exchangerate-api.com';
const SOURCES = { erapi: 'Exchange Rate API', vietcombank: 'Vietcombank', frankfurter: 'Frankfurter' };
const COPY = ['bank', 'account', 'holder', 'amount', 'content'];
/** A renewal order stays good until grace ends, days away: past this the deadline is a date and time, not a clock. */
const CLOCK_MAX_MS = 3_600_000;

const number = (n) => new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(n);

/**
 * @param {{ api: any, toast: (message: string, kind?: string) => void, onChanged?: () => any }} deps
 */
export function createPlansSheet({ api, toast, onChanged = () => {} }) {
  /** @type {HTMLDialogElement | null} */
  let dialog = null;
  let view = 'sheet';
  let period = 'month';
  /** @type {any} */ let data = null; // { plans, account } once loaded
  /** @type {string | null} */ let failure = null;
  /** @type {{ id: string, period: string } | null} */ let confirming = null;
  /** @type {any} */ let checkout = null;
  /** @type {any} */ let pay = null;
  let pollTimer = 0;
  let clockTimer = 0;
  let polling = false;
  let busy = false;
  /** The amount of a top-up that failed, so "Try again" makes that top-up again and not the plans sheet. */
  let retryTopUp = null;
  // Bumped whenever the person leaves what an order was being made for (Esc, Back, a new open): an answer that comes
  // back afterwards is for a screen that is gone and must not start a clock or a poll on it (review, 2026-11-15).
  let flow = 0;

  /* ── timers: at most one poll, and none once the dialog is shut ───── */
  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    pollTimer = 0;
    clockTimer = 0;
    document.removeEventListener('visibilitychange', onVisible);
  }
  function onVisible() {
    if (!document.hidden) void poll();
  }

  function ensure() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'plans';
    dialog.className = 'sheet plans';
    dialog.setAttribute('aria-labelledby', 'plans-title');
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      flow += 1;
      busy = false;
      stopTimers();
      pay = null;
      checkout = null;
      confirming = null;
      delete dialog.dataset.order;
    });
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('change', onChange);
    dialog.addEventListener('keydown', onKey);
    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      if (/** @type {HTMLElement} */ (event.target).matches?.('form[data-profile]')) void saveProfile();
    });
    return dialog;
  }

  const $ = (selector) => /** @type {HTMLElement | null} */ (dialog?.querySelector(selector));
  const titleOf = () => t({ sheet: 'billing.plans.title', checkout: 'billing.checkout.title', pay: 'billing.pay.title', done: 'billing.done.title' }[view]);

  /** Draws the whole dialog for the current view; the caller says where focus goes. */
  function paint(focus = 'title') {
    const d = ensure();
    keepTyped();
    d.dataset.view = view;
    const body = { sheet: sheetHtml, checkout: checkoutHtml, pay: payHtml, done: doneHtml }[view]();
    d.innerHTML = `<div class="sheet__head"><h2 id="plans-title" tabindex="-1">${esc(titleOf())}</h2><button type="button" class="icon-btn" data-close aria-label="${esc(t('action.close'))}">✕</button></div><div class="sheet__body plans__body" data-view="${view}"><p class="plans__preview">${esc(t('billing.previewNote'))}</p>${body}</div>`;
    if (pay?.order) d.dataset.order = pay.order.id;
    if (focus === 'title') $('#plans-title')?.focus();
    else if (focus) $(focus)?.focus();
  }

  /** What is typed in the billing form survives any repaint (a period chosen, the balance ticked). */
  function keepTyped() {
    const form = /** @type {HTMLFormElement | null} */ (dialog?.querySelector('form[data-profile]'));
    if (!form || !checkout) return;
    const value = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name))?.value ?? '';
    checkout.draft = { name: value('name'), email: value('email'), country: value('country'), address: value('address'), taxCode: value('tax') };
  }

  /* ── loading ──────────────────────────────────────────────────────── */
  async function load() {
    failure = null;
    try {
      const [plans, account] = await Promise.all([api.billingPlans(), api.billing()]);
      data = { plans, account };
      if (!['month', 'year'].includes(period)) period = 'month';
    } catch (err) {
      failure = err.message;
    }
  }

  async function open() {
    ensure();
    stopTimers();
    flow += 1;
    retryTopUp = null;
    view = 'sheet';
    period = 'month';
    confirming = null;
    checkout = null;
    pay = null;
    // Nothing from last time is offered while this time's answer is on its way: a card pressed on stale data
    // could buy what the account no longer is.
    data = null;
    paint('title');
    if (!dialog.open) dialog.showModal();
    await load();
    if (!dialog.open) return;
    // A plan paid while the sheet was shut is on the line under the name at once.
    void onChanged();
    view = 'sheet';
    // The period the account is on is the one shown first, so "Current plan" is not hiding one click away.
    if (data?.plans?.current?.period === 'year') period = 'year';
    paint(failure ? '[data-retry]' : '.plans__period [aria-checked="true"]');
  }

  async function openCheckout(plan, chosen = 'month') {
    ensure();
    stopTimers();
    if (!dialog.open) dialog.showModal();
    // Read again each time: the account may have changed since (a plan in grace, the billing information) and the
    // Billing tab opens the checkout straight from its own copy.
    retryTopUp = null;
    await load();
    if (!dialog.open) return;
    await startCheckout(plan, chosen);
  }

  /** A top-up has no plan to choose: the order is made at once and the QR shown. */
  async function openTopUp(amountVnd) {
    ensure();
    stopTimers();
    checkout = null;
    pay = null;
    view = 'sheet';
    failure = null;
    retryTopUp = null;
    // Nothing from an earlier screen is shown while the order is being made.
    data = null;
    paint('title');
    if (!dialog.open) dialog.showModal();
    await makeOrder({ kind: 'topup', amountVnd }, 'topup');
  }

  /* ── the plans ────────────────────────────────────────────────────── */
  const planById = (id) => data?.plans?.plans?.find((p) => p.id === id);
  const current = () => data?.plans?.current || { plan: 'free', period: null };

  /** In grace the plan in force has ended and its renewal is the thing to pay for (spec: Renew now). */
  const inGrace = () => data?.account?.plan?.status === 'grace';

  /** What a card's button does: 'current', 'renew' (the plan in grace), 'buy' (an order) or 'later' (at the end of the period). */
  function actionFor(id) {
    const cur = current();
    if (cur.plan === 'free') return id === 'free' ? 'current' : 'buy';
    if (id === 'free') return data.account.plan.cancelAtEnd ? 'scheduled' : 'later';
    if ((period === 'month' && cur.period === 'year') || RANK[id] < RANK[cur.plan]) {
      return id === cur.plan && period === cur.period ? 'current' : data.account.plan.nextPlan === id && data.account.plan.nextPeriod === period ? 'scheduled' : 'later';
    }
    if (id === cur.plan && period === cur.period) return inGrace() ? 'renew' : 'current';
    return 'buy';
  }

  function priceHtml(id) {
    if (id === 'free') return `<p class="plans__price"><span class="plans__amount">${esc(currentLanguage() === 'vi' ? vnd(0) : usd(0))}</span></p>`;
    const p = planById(id);
    if (!p?.vnd) return `<p class="plans__price"><span class="plans__amount">—</span></p>`;
    const per = esc(t(`billing.per.${period}`));
    if (currentLanguage() === 'vi') return `<p class="plans__price"><span class="plans__amount">${esc(vnd(p.vnd[period]))}</span> <span class="plans__per">${per}</span></p>`;
    return `<p class="plans__price"><span class="plans__amount">${esc(usd(p.usdCents[period]))}</span> <span class="plans__per">${per}</span></p><p class="plans__billed">${esc(t('billing.billedAs', { vnd: vnd(p.vnd[period]) }))}</p>`;
  }

  function cardHtml(id) {
    const p = id === 'free' ? FREE : planById(id) || FREE;
    const action = actionFor(id);
    const cur = current();
    const noRate = !data.plans.rate;
    let label;
    if (action === 'current') label = t('billing.plans.current');
    else if (action === 'renew') label = t('billing.plans.renew');
    else if (action === 'scheduled') label = t('billing.plans.scheduled');
    else if (action === 'later') label = t('billing.plans.later');
    else if (id === cur.plan) label = t('billing.plans.switchYearly');
    else label = t(cur.plan === 'free' ? 'billing.plans.get' : 'billing.plans.switch', { plan: planName(id) });
    const disabled = action === 'current' || action === 'scheduled' || (noRate && action === 'buy');
    const lines = [
      p.searches ? t('billing.plans.searches', { n: number(p.searches) }) : t('billing.plans.searchesNone'),
      p.sandboxMinutes ? t('billing.plans.computer', { time: minutes(p.sandboxMinutes * 60) }) : t('billing.plans.computerNone'),
      t('billing.plans.storage', { gb: number(p.storageGb) }),
      t('billing.plans.people'),
    ];
    return `<article class="plans__card${action === 'current' || action === 'renew' ? ' is-current' : ''}" data-plan="${id}" aria-labelledby="plan-${id}-name">
      <h3 id="plan-${id}-name">${esc(planName(id))}</h3>
      ${noRate ? '' : priceHtml(id)}
      <button type="button" class="btn${action === 'buy' || action === 'renew' ? ' btn--primary' : ''}" data-pick="${id}" data-action="${action}"${disabled ? ' disabled' : ''}>${esc(label)}</button>
      <ul class="plans__lines">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    </article>`;
  }

  function rateHtml() {
    const rate = data.plans.rate;
    if (!rate) return `<p class="plans__rate" role="status">${esc(t('billing.ratesDown'))}</p>`;
    const at = new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(rate.at));
    const link = rate.source === 'erapi' ? ` <a href="${ATTRIBUTION}" target="_blank" rel="noopener noreferrer">${esc(t('billing.rate.attribution'))}</a>` : '';
    return `<p class="plans__rate">${esc(t('billing.rate', { rate: number(rate.rate), source: SOURCES[rate.source] || rate.source, at }))}${link}</p>`;
  }

  function paygHtml() {
    const prices = data.plans.payg?.prices;
    if (!prices) return '';
    return `<p class="plans__payg">${esc(t('billing.plans.payg', { search: vnd(prices.searchVnd), hour: vnd(prices.sandboxVndPerMinute * 60), storage: vnd(prices.storageVndPerGbMonth) }))}</p>`;
  }

  function sheetHtml() {
    if (failure) return `<p class="plans__error" role="alert">${esc(failure)}</p><p><button type="button" class="btn" data-retry>${esc(t('billing.retry'))}</button></p>`;
    if (!data) return `<p class="plans__muted">${esc(t('common.loading'))}</p>`;
    const plan = data.account.plan;
    const when = plan.end ? new Intl.DateTimeFormat(localeTag(), { dateStyle: 'long' }).format(new Date(plan.end)) : '';
    let scheduled = '';
    if (plan.cancelAtEnd && plan.plan !== 'free') scheduled = t('billing.plans.endsOn', { date: when });
    else if (plan.nextPlan && (plan.nextPlan !== plan.plan || plan.nextPeriod !== plan.period)) scheduled = t('billing.plans.changesOn', { plan: planName(plan.nextPlan), date: when });
    const keep = scheduled ? `<p class="plans__scheduled" role="status">${esc(scheduled)} <button type="button" class="btn btn--small" data-withdraw>${esc(t('billing.plans.keep'))}</button></p>` : '';
    let ask = '';
    if (confirming) {
      const text = confirming.id === 'free' ? t('billing.plans.confirmEnd', { date: when }) : t('billing.plans.confirmLater', { plan: planName(confirming.id), period: t(`billing.period.${confirming.period}`).toLowerCase(), date: when });
      ask = `<div class="plans__confirm" role="alert"><p>${esc(text)}</p><p class="plans__actions"><button type="button" class="btn btn--primary" data-confirm>${esc(t('billing.plans.confirm'))}</button> <button type="button" class="btn" data-keep>${esc(t('billing.plans.keepCurrent'))}</button></p></div>`;
    }
    return `${keep}${ask}${periodHtml('plans__period', t('billing.plans.period'), true)}
      <div class="plans__cards">${ORDER.map(cardHtml).join('')}</div>${paygHtml()}${rateHtml()}`;
  }

  /** Monthly | Yearly, a radio group with one tab stop (arrow keys move inside it). */
  function periodHtml(className, label, withSave, prices) {
    return `<div class="${className}" role="radiogroup" aria-label="${esc(label)}">${['month', 'year']
      .map((p) => `<button type="button" role="radio" data-period="${p}" aria-checked="${p === period}" tabindex="${p === period ? 0 : -1}"${prices && laterQuote(p) ? ' disabled' : ''}><span>${esc(t(`billing.period.${p}`))}</span>${prices ? `<span class="plans__periodprice">${esc(prices[p])}</span>` : ''}${withSave && p === 'year' ? `<span class="plans__save">${esc(t('billing.plans.save'))}</span>` : ''}</button>`)
      .join('')}</div>`;
  }

  /* ── the checkout ─────────────────────────────────────────────────── */
  async function startCheckout(plan, chosen) {
    period = chosen;
    view = 'checkout';
    checkout = { plan, quotes: null, useBalance: true, editing: !data?.account?.profile, error: null, draft: null };
    paint('title');
    await loadQuotes();
  }

  async function loadQuotes() {
    const wanted = checkout;
    try {
      const [month, year] = await Promise.all([api.billingQuote({ plan: wanted.plan, period: 'month' }), api.billingQuote({ plan: wanted.plan, period: 'year' })]);
      if (checkout !== wanted) return;
      wanted.quotes = { month, year };
      wanted.error = null;
      // A move the server only schedules (a year back to months, or the plan already in force) is not bought here:
      // start on the other period, and keep the radio off (the plans sheet offers it as "Changes at renewal").
      if (month.kind === 'later' && year.kind !== 'later') period = 'year';
      else if (year.kind === 'later' && month.kind !== 'later') period = 'month';
    } catch (err) {
      if (checkout !== wanted) return;
      wanted.error = err.message;
    }
    paint(null);
    if (wanted.error) $('[data-back]')?.focus();
  }

  const laterQuote = (x) => checkout?.quotes?.[x]?.kind === 'later';
  const profileOf = () => data?.account?.profile || null;

  function dueToday() {
    const q = checkout.quotes[period];
    return Math.max(0, q.totalVnd - (checkout.useBalance ? Math.min(q.balanceVnd, q.totalVnd) : 0));
  }

  function profileHtml() {
    const p = profileOf();
    const f = checkout.draft || p || {};
    if (!checkout.editing && p) {
      const rows = [p.name, p.email, p.country, p.address, p.taxCode ? t('billing.profile.taxLine', { code: p.taxCode }) : ''].filter(Boolean);
      return `<section class="checkout__side" aria-labelledby="bill-heading"><h3 id="bill-heading">${esc(t('billing.profile.title'))}</h3>
        <div class="checkout__summary">${rows.map((r) => `<p>${esc(r)}</p>`).join('')}</div>
        <p><button type="button" class="btn btn--small" data-update-profile>${esc(t('billing.profile.update'))}</button></p></section>`;
    }
    const field = (id, key, value, extra = '') => `<div class="field"><label for="bill-${id}">${esc(t(`billing.profile.${key}`))}</label><input id="bill-${id}" name="${id}" value="${esc(value ?? '')}" ${extra}></div>`;
    return `<section class="checkout__side" aria-labelledby="bill-heading"><h3 id="bill-heading">${esc(t('billing.profile.title'))}</h3>
      <form data-profile novalidate>
        <p class="plans__muted">${esc(t('billing.profile.why'))}</p>
        ${field('name', 'name', f.name, 'autocomplete="name" maxlength="120" required')}
        ${field('email', 'email', f.email, 'type="email" autocomplete="email" maxlength="254" required')}
        ${field('country', 'country', f.country, 'autocomplete="country" maxlength="2" required aria-describedby="bill-country-hint" size="3"')}
        <p id="bill-country-hint" class="plans__muted">${esc(t('billing.profile.countryHint'))}</p>
        ${field('address', 'address', f.address, 'autocomplete="street-address" maxlength="300"')}
        ${field('tax', 'tax', f.taxCode, 'inputmode="numeric" maxlength="20" autocomplete="off"')}
        ${checkout.formError ? `<p class="plans__error" role="alert">${esc(checkout.formError)}</p>` : ''}
        <p class="plans__actions"><button type="submit" class="btn btn--primary" data-save-profile>${esc(t('billing.profile.save'))}</button>${profileOf() ? ` <button type="button" class="btn" data-cancel-profile>${esc(t('billing.profile.cancel'))}</button>` : ''}</p>
      </form></section>`;
  }

  function checkoutHtml() {
    if (checkout.error) return `<p class="plans__error" role="alert">${esc(checkout.error)}</p><p><button type="button" class="btn" data-back>${esc(t('billing.back'))}</button></p>`;
    if (!checkout.quotes) return `<p class="plans__muted">${esc(t('common.loading'))}</p>`;
    const q = checkout.quotes[period];
    const p = planById(checkout.plan);
    const prices = Object.fromEntries(['month', 'year'].map((x) => [x, currentLanguage() === 'vi' || !p ? vnd(checkout.quotes[x].priceVnd) : `${usd(p.usdCents[x])} (${vnd(checkout.quotes[x].priceVnd)})`]));
    const balanceUsed = checkout.useBalance ? Math.min(q.balanceVnd, q.totalVnd) : 0;
    const row = (label, value, cls = '') => `<div class="${cls}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
    const lines = [
      row(t('billing.checkout.line', { plan: planName(checkout.plan), period: t(`billing.period.${period}`) }), vnd(q.priceVnd)),
      q.creditVnd ? row(t('billing.checkout.credit'), `−${vnd(q.creditVnd)}`) : '',
      balanceUsed ? row(t('billing.checkout.balanceUsed'), `−${vnd(balanceUsed)}`) : '',
      row(t('billing.checkout.total'), vnd(dueToday()), 'checkout__total'),
    ].join('');
    const rateLine = q.rate ? `<p class="plans__muted">${esc(t('billing.checkout.rate', { rate: number(q.rate) }))}</p>` : '';
    return `<div class="checkout">
      <section class="checkout__main" aria-labelledby="co-plan">
        <h3 id="co-plan">${esc(planName(checkout.plan))}</h3>
        ${periodHtml('checkout__period', t('billing.plans.period'), false, prices)}
        ${q.kind === 'later' ? `<p class="plans__muted" role="status">${esc(t('billing.checkout.later'))}</p>` : ''}
        <dl class="checkout__lines">${lines}</dl>
        ${rateLine}
        ${q.balanceVnd > 0 ? `<label class="checkout__balance"><input type="checkbox" data-use-balance${checkout.useBalance ? ' checked' : ''}> ${esc(t('billing.checkout.useBalance', { balance: vnd(q.balanceVnd) }))}</label>` : ''}
        ${checkout.orderError ? `<p class="plans__error" role="alert">${esc(checkout.orderError)}</p>` : ''}
      </section>
      ${profileHtml()}
    </div>
    <div class="plans__foot"><button type="button" class="btn" data-back${busy ? ' disabled' : ''}>${esc(t('billing.back'))}</button>
      <button type="button" class="btn btn--primary" data-continue${checkout.editing || busy || q.kind === 'later' ? ' disabled' : ''}>${esc(t('billing.checkout.continue'))}</button></div>`;
  }

  async function saveProfile() {
    const form = /** @type {HTMLFormElement | null} */ ($('form[data-profile]'));
    if (!form || busy) return;
    const value = (name) => /** @type {HTMLInputElement} */ (form.elements.namedItem(name)).value.trim();
    const body = { name: value('name'), email: value('email'), country: value('country'), address: value('address'), taxCode: value('tax') };
    checkout.draft = { ...body };
    if (!body.name || !body.email || !body.country) {
      checkout.formError = t('billing.profile.required');
      paint(null);
      $(`#bill-${!body.name ? 'name' : !body.email ? 'email' : 'country'}`)?.focus();
      return;
    }
    busy = true;
    try {
      const saved = await api.billingProfile(body);
      data.account.profile = saved.profile;
      checkout.editing = false;
      checkout.formError = null;
      checkout.draft = null;
    } catch (err) {
      checkout.formError = err.message;
    } finally {
      busy = false;
    }
    paint(checkout.editing ? '#bill-name' : '[data-continue]');
  }

  /* ── an order, its QR and its payment ─────────────────────────────── */
  async function makeOrder(body, kind) {
    if (busy) return;
    busy = true;
    const mine = checkout;
    const token = flow;
    if (checkout) {
      checkout.orderError = null;
      paint(null);
    }
    try {
      const made = await api.billingOrder(body);
      busy = false;
      if (!dialog.open || flow !== token || checkout !== mine) {
        // The person left while it was being made: the order is real, so close it rather than leave it open for 30 minutes.
        // A renewal is the one order the whole period shares (the server will not cancel it either): cancelling it here could
        // cancel the order a sheet opened again is showing.
        if (!made.paidNow && made.order?.id && made.order.kind !== 'renewal') api.billingCancelOrder(made.order.id).catch(() => {});
        return;
      }
      if (made.paidNow) {
        pay = { order: made.order, kind, received: 0, total: made.order.totalVnd };
        await finish();
        return;
      }
      const due = made.due;
      // Neither paid nor owing: nothing to show a QR for. Said in words, not left to a TypeError.
      if (!due?.qr) throw new Error(t('billing.pay.noDue'));
      pay = { order: made.order, kind, qr: due.qr, dueVnd: due.vnd, received: 0, total: made.order.totalVnd, expiresAt: Date.parse(made.order.expiresAt), state: 'waiting' };
      view = 'pay';
      paint('title');
      startTimers();
    } catch (err) {
      busy = false;
      if (!dialog.open || flow !== token || checkout !== mine) return;
      if (checkout) {
        checkout.orderError = err.message;
        // A price that moved under the person: ask again so the lines are today's.
        if (err.status === 422) await loadQuotes();
        else paint('[data-continue]');
      } else {
        failure = err.message;
        if (body.kind === 'topup') retryTopUp = body.amountVnd;
        view = 'sheet';
        paint('[data-retry]');
        toast(err.message, 'error');
      }
    }
  }

  function startTimers() {
    stopTimers();
    tickClock();
    clockTimer = window.setInterval(tickClock, 1000);
    pollTimer = window.setInterval(() => void poll(), POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  /** What the time left reads as: a clock for the last hour, the date and time of the deadline when it is days away. */
  function deadline() {
    const left = pay.expiresAt - Date.now();
    if (left > CLOCK_MAX_MS) return { label: t('billing.pay.goodUntil'), text: new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(pay.expiresAt)) };
    return { label: t('billing.pay.timeLeft'), text: clock(left) };
  }

  function tickClock() {
    if (!pay || view !== 'pay') return;
    const left = pay.expiresAt - Date.now();
    const shown = deadline();
    const label = $('.pay__timelabel');
    if (label && label.textContent !== shown.label) label.textContent = shown.label;
    const timer = $('.pay__timer');
    if (timer && timer.textContent !== shown.text) timer.textContent = shown.text;
    if (left <= 0 && pay.state === 'waiting' && !pay.lastLook) {
      pay.lastLook = true;
      // One last look - the money may have landed in the final seconds - then it is over.
      void poll().then(() => pay?.state === 'waiting' && setState('expired'));
    }
  }

  function setState(state) {
    pay.state = state;
    if (state !== 'waiting') {
      clearInterval(pollTimer);
      clearInterval(clockTimer);
      pollTimer = 0;
      clockTimer = 0;
      document.removeEventListener('visibilitychange', onVisible);
    }
    // In place: the status line is a live region, and a node that is replaced is often not read. Focus stays where it
    // is, so nothing talks over the announcement either.
    updatePay();
  }

  async function poll() {
    if (!pay || view !== 'pay' || pay.state !== 'waiting' || polling || document.hidden) return;
    const mine = pay;
    polling = true;
    try {
      const s = await api.billingOrderStatus(mine.order.id);
      if (pay !== mine || view !== 'pay') return;
      if (s.status === 'paid') {
        await finish();
      } else if (s.status !== 'pending') {
        // Expired, cancelled, refunded: the wait is over whatever it is called (refunded is money taken and given back).
        setState(s.status);
      } else if (s.dueVnd > 0 && (s.receivedVnd !== mine.received || s.dueVnd !== mine.dueVnd)) {
        mine.received = s.receivedVnd;
        mine.dueVnd = s.dueVnd;
        mine.qr = { ...mine.qr, amount: s.dueVnd, image: freshImage(mine.qr.image, s.dueVnd) };
        updatePay();
      }
    } catch {
      /* a refused or failed poll is only asked again in 5 s */
    } finally {
      polling = false;
    }
  }

  /** The same QR for a smaller amount: SePay's picture takes the amount from its address. */
  function freshImage(image, amount) {
    try {
      const u = new URL(image);
      if (u.host !== 'qr.sepay.vn') return image;
      u.searchParams.set('amount', String(amount));
      return u.href;
    } catch {
      return image;
    }
  }

  async function finish() {
    const order = pay.order;
    stopTimers();
    view = 'done';
    pay.state = 'paid';
    pay.receipt = null;
    paint('title');
    // Only a real transfer has a receipt (a simulated one has none), so a missing one is not an error.
    api.billingReceipts?.()
      .then((r) => {
        const mine = r.receipts?.find((x) => x.orderId === order.id);
        if (mine && pay?.order === order) {
          pay.receipt = mine.number;
          paint(null);
          $('[data-done]')?.focus();
        }
      })
      .catch(() => {});
    void onChanged();
  }

  function statusText() {
    if (pay.state === 'expired') return t('billing.pay.expired');
    if (pay.state === 'cancelled') return t('billing.pay.cancelled');
    if (pay.state === 'refunded') return t('billing.pay.refunded');
    // In terms of what is left to transfer: with the balance used the order's total is not what the bank sees.
    if (pay.received > 0) return t('billing.pay.short', { received: vnd(pay.received), left: vnd(pay.dueVnd) });
    return t('billing.pay.waiting');
  }

  function footHtml() {
    return pay.state === 'waiting' ? `<button type="button" class="btn" data-cancel>${esc(t('billing.pay.cancel'))}</button>` : `<button type="button" class="btn btn--primary" data-back>${esc(t('billing.back'))}</button>`;
  }

  function payHtml() {
    const q = pay.qr;
    const labels = { bank: t('billing.pay.bank'), account: t('billing.pay.account'), holder: t('billing.pay.holder'), amount: t('billing.pay.amount'), content: t('billing.pay.content') };
    const values = { bank: q.bank, account: q.account, holder: q.holder, amount: vnd(q.amount), content: q.content };
    const waiting = pay.state === 'waiting';
    const status = statusText();
    const shown = deadline();
    return `<div class="pay">
      <p class="pay__lead">${esc(t('billing.pay.lead'))}</p>
      <div class="pay__grid">
        <div class="pay__qr"><img src="${esc(q.image)}" alt="${esc(t('billing.pay.qrAlt', { amount: vnd(q.amount), content: q.content }))}" width="220" height="220"></div>
        <dl class="pay__rows">${COPY.map((k) => `<div><dt>${esc(labels[k])}</dt><dd id="pay-${k}">${esc(values[k])}</dd><button type="button" class="btn btn--small" data-copy="${k}" aria-label="${esc(t('billing.pay.copy', { what: labels[k] }))}">${esc(t('billing.pay.copyShort'))}</button></div>`).join('')}</dl>
      </div>
      <p class="pay__time"${waiting ? '' : ' hidden'}><span class="pay__timelabel">${esc(shown.label)}</span> <span class="pay__timer" role="timer" aria-live="off">${esc(shown.text)}</span></p>
      <p class="pay__status" role="status" tabindex="-1">${esc(status)}</p>
      <div class="plans__foot pay__foot">${footHtml()}</div>
    </div>`;
  }

  /**
   * Changes the QR view where it stands: the status line keeps its node (so it is announced), the picture its element
   * (a new address, no flash), the amount its row; focus is never moved.
   */
  function updatePay() {
    if (view !== 'pay' || !pay) return;
    const status = $('.pay__status');
    if (status) status.textContent = statusText();
    const img = /** @type {HTMLImageElement | null} */ ($('.pay__qr img'));
    if (img) {
      if (img.getAttribute('src') !== pay.qr.image) img.setAttribute('src', pay.qr.image);
      img.alt = t('billing.pay.qrAlt', { amount: vnd(pay.qr.amount), content: pay.qr.content });
    }
    const amount = $('#pay-amount');
    if (amount) amount.textContent = vnd(pay.qr.amount);
    const time = $('.pay__time');
    if (time) time.hidden = pay.state !== 'waiting';
    const foot = $('.pay__foot');
    if (foot && !!foot.querySelector('[data-cancel]') !== (pay.state === 'waiting')) foot.innerHTML = footHtml();
  }

  function doneHtml() {
    const topup = pay.kind === 'topup';
    const text = topup ? t('billing.done.topup', { amount: vnd(pay.order.totalVnd) }) : t('billing.done.plan', { plan: planName(pay.order.plan) });
    const receipt = pay.receipt ? `<p><a class="btn" href="/api/billing/receipts/${encodeURIComponent(pay.receipt)}.pdf" target="_blank" rel="noopener">${esc(t('billing.done.receipt'))}</a></p>` : '';
    return `<div class="pay__done" role="status"><p class="pay__tick" aria-hidden="true">✓</p><p class="pay__donetext">${esc(text)}</p>${receipt}</div>
      <div class="plans__foot"><button type="button" class="btn btn--primary" data-done>${esc(t('billing.done.close'))}</button></div>`;
  }

  /* ── copy ─────────────────────────────────────────────────────────── */
  async function copy(key) {
    const labels = { bank: 'billing.pay.bank', account: 'billing.pay.account', holder: 'billing.pay.holder', amount: 'billing.pay.amount', content: 'billing.pay.content' };
    const value = key === 'amount' ? String(pay.qr.amount) : String(pay.qr[key]);
    try {
      await navigator.clipboard.writeText(value);
      toast(t('billing.pay.copied', { what: t(labels[key]) }), 'ok');
    } catch {
      // The clipboard was refused (an insecure origin, a policy): select the text so Ctrl+C finishes it.
      const el = $(`#pay-${key}`);
      if (el) window.getSelection()?.selectAllChildren(el);
      toast(t('billing.pay.selected'));
    }
  }

  /* ── events ───────────────────────────────────────────────────────── */
  function choosePeriod(next, focus = true) {
    if (next === period || (view === 'checkout' && laterQuote(next))) return;
    period = next;
    if (view === 'checkout') paint(null);
    else {
      confirming = null;
      paint(null);
    }
    if (focus) $(`[data-period="${next}"]`)?.focus();
  }

  async function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('button, a'));
    if (!el || el.tagName === 'A') return;
    if (el.hasAttribute('data-close') || el.hasAttribute('data-done')) return void dialog.close();
    if (el.dataset.period) return choosePeriod(el.dataset.period);
    if (el.hasAttribute('data-retry')) {
      if (retryTopUp != null) {
        const amount = retryTopUp;
        retryTopUp = null;
        failure = null;
        paint('title');
        await makeOrder({ kind: 'topup', amountVnd: amount }, 'topup');
        return;
      }
      await load();
      paint(failure ? '[data-retry]' : 'title');
      return;
    }
    if (el.dataset.pick) return pick(el.dataset.pick);
    if (el.hasAttribute('data-keep')) {
      const was = confirming?.id;
      confirming = null;
      paint(`[data-pick="${was}"]`);
      return;
    }
    if (el.hasAttribute('data-confirm')) return void change();
    if (el.hasAttribute('data-withdraw')) return void withdraw();
    if (el.hasAttribute('data-back')) {
      if (busy) return;
      flow += 1;
      stopTimers();
      view = 'sheet';
      checkout = null;
      pay = null;
      paint('title');
      await load();
      if (view === 'sheet' && dialog.open) paint(null);
      return;
    }
    if (el.hasAttribute('data-update-profile')) {
      checkout.editing = true;
      checkout.draft = null;
      paint('#bill-name');
      return;
    }
    if (el.hasAttribute('data-cancel-profile')) {
      checkout.editing = false;
      checkout.formError = null;
      checkout.draft = null;
      paint('[data-continue]');
      return;
    }
    if (el.hasAttribute('data-save-profile')) return void saveProfile();
    if (el.hasAttribute('data-continue')) return void makeOrder({ kind: 'plan', plan: checkout.plan, period, useBalance: checkout.useBalance }, 'plan');
    if (el.dataset.copy) return void copy(el.dataset.copy);
    if (el.hasAttribute('data-cancel')) return void cancelOrder();
  }

  function onChange(event) {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (el.hasAttribute?.('data-use-balance')) {
      checkout.useBalance = el.checked;
      paint(null);
      $('[data-use-balance]')?.focus();
    }
  }

  /** Arrow keys move inside a radio group, as native radios do; the checked one is the only tab stop. */
  function onKey(event) {
    const el = /** @type {HTMLElement} */ (event.target);
    if (el.getAttribute?.('role') !== 'radio') return;
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!dir) return;
    event.preventDefault();
    choosePeriod(period === 'month' ? 'year' : 'month');
  }

  function pick(id) {
    if (!data) return;
    const action = actionFor(id);
    if (action === 'buy' || action === 'renew') {
      void startCheckout(id, period);
    } else if (action === 'later') {
      confirming = { id, period };
      paint('[data-confirm]');
    }
  }

  async function change() {
    const asked = confirming;
    // A second press (a double click) finds nothing to confirm: one change, not two and a TypeError.
    if (!asked) return;
    confirming = null;
    try {
      const body = asked.id === 'free' ? { cancelAtEnd: true } : { nextPlan: asked.id, nextPeriod: asked.period };
      await api.billingSubscription(body);
      toast(t('billing.plans.changed'), 'ok');
      await load();
      void onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
    paint(`[data-pick="${asked.id}"]`);
  }

  async function withdraw() {
    try {
      const p = data.account.plan;
      // One request, so a refusal leaves everything as it was (the route applies the plan change first, then the switches).
      const body = {};
      if (p.cancelAtEnd) body.cancelAtEnd = false;
      if (p.nextPlan) body.nextPlan = null;
      if (Object.keys(body).length) await api.billingSubscription(body);
      await load();
      void onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
    paint('title');
  }

  async function cancelOrder() {
    const mine = pay;
    try {
      await api.billingCancelOrder(mine.order.id);
      toast(t('billing.pay.cancelledToast'), 'ok');
    } catch (err) {
      // Already paid or closed in the meantime: the next look at the order says which.
      if (err.status === 409) {
        await poll();
        if (pay === mine && pay.state === 'waiting') toast(err.message, 'error');
        return;
      }
      toast(err.message, 'error');
      return;
    }
    flow += 1;
    stopTimers();
    pay = null;
    checkout = null;
    view = 'sheet';
    paint('title');
    await load();
    if (view === 'sheet' && dialog.open) paint(null);
    void onChanged();
  }

  return { open, openCheckout, openTopUp };
}
