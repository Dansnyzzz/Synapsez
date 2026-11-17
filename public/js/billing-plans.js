import { t, localeTag } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, planName, minutes, clock } from './billing-format.js';
import { planIconHtml, savePercent, priceHtml, cardToggleHtml, listHtml, teamCardHtml, rateStamp } from './billing-plan-cards.js';
import { checkoutHtml as checkoutViewHtml, FORM_FIELDS } from './billing-checkout-view.js';

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
/** The rows of the QR view a person can copy, in order, and the words each is called by. */
const COPY = { bank: 'billing.pay.bank', account: 'billing.pay.account', holder: 'billing.pay.holder', amount: 'billing.pay.amount', content: 'billing.pay.content' };
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
  /** The segmented control: 'individual' (the four cards) or 'team' (the coming-soon card). */
  let audience = 'individual';
  let teamBusy = false;
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
    // The billing form is saved with the order (Subscribe), so a form submit by itself goes nowhere.
    dialog.addEventListener('submit', (event) => event.preventDefault());
    return dialog;
  }

  const $ = (selector) => /** @type {HTMLElement | null} */ (dialog?.querySelector(selector));
  const titleOf = () => t({ sheet: 'billing.plans.title', checkout: 'billing.checkout.title', pay: 'billing.pay.title', done: 'billing.done.title' }[view]);

  /** Draws the whole dialog for the current view; the caller says where focus goes. */
  function paint(focus = 'title') {
    const d = ensure();
    keepTyped();
    // The consent is to "the amount above": when what is due today is not what was ticked for (another period, a price that moved, the
    // balance used or not), the box is empty again and has to be ticked for the new figure.
    if (view === 'checkout' && checkout?.quotes && checkout.consent && checkout.consentFor !== dueToday()) checkout.consent = false;
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
    checkout.draft = typed(form);
  }

  /** What is in the billing form, by the profile's own keys, as typed (not yet trimmed). */
  function typed(form) {
    return Object.fromEntries(FORM_FIELDS.map((f) => [f.key, /** @type {HTMLInputElement} */ (form.elements.namedItem(f.input))?.value ?? '']));
  }

  /* ── loading ──────────────────────────────────────────────────────── */
  async function load() {
    failure = null;
    try {
      const [plans, account] = await Promise.all([api.billingPlans(), api.billing()]);
      data = { plans, account };
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
    audience = 'individual';
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
    paint(failure ? '[data-retry]' : '.plans__audience [aria-checked="true"]');
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

  /**
   * What a card's button does: 'current' (in force), 'renew' (the terms the plan in grace renews on: the scheduled change if there is one,
   * else what ran), 'buy' (an order), 'later' (at the end of the period) or 'scheduled' (already chosen for then).
   */
  function actionFor(id) {
    const cur = current();
    if (cur.plan === 'free') return id === 'free' ? 'current' : 'buy';
    if (id === 'free') return data.account.plan.cancelAtEnd ? 'scheduled' : 'later';
    // The renewal is of what comes next (a scheduled change, else what ran): that card is "Renew", and the plan that ran is only current.
    if (inGrace() && !data.account.plan.cancelAtEnd) {
      const next = data.account.plan;
      if (id === (next.nextPlan ?? next.plan) && period === (next.nextPeriod ?? next.period)) return 'renew';
    }
    if ((period === 'month' && cur.period === 'year') || RANK[id] < RANK[cur.plan]) {
      return id === cur.plan && period === cur.period ? 'current' : data.account.plan.nextPlan === id && data.account.plan.nextPeriod === period ? 'scheduled' : 'later';
    }
    return id === cur.plan && period === cur.period ? 'current' : 'buy';
  }

  /** On a monthly plan, that plan's own card offers the year (spec: "Chuyển sang <Plan> theo năm"); in grace the card says Renew instead. */
  const yearSwitch = (id) => id !== 'free' && current().plan === id && current().period === 'month' && !inGrace() && actionFor(id) === 'current';

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
    else if (id === cur.plan) label = t('billing.plans.switchYearly', { plan: planName(id) });
    else label = t(cur.plan === 'free' ? 'billing.plans.get' : 'billing.plans.switch', { plan: planName(id) });
    const toYear = yearSwitch(id);
    if (toYear) label = t('billing.plans.switchYearly', { plan: planName(id) });
    // A renewal whose price is already locked needs no exchange rate; any other purchase does.
    const disabled = (action === 'current' && !toYear) || action === 'scheduled' || (toYear && noRate) || (noRate && (action === 'buy' || (action === 'renew' && !data.account.plan.renewalLocked)));
    // One card is lit: the plan in force, or in grace the renewal's terms (the plan that ran is then plain).
    const lit = action === 'renew' || (action === 'current' && !ORDER.some((x) => actionFor(x) === 'renew'));
    const lines = [
      p.searches ? t('billing.plans.searches', { n: number(p.searches) }) : t('billing.plans.searchesNone'),
      p.sandboxMinutes ? t('billing.plans.computer', { time: minutes(p.sandboxMinutes * 60) }) : t('billing.plans.computerNone'),
      t('billing.plans.storage', { gb: number(p.storageGb) }),
      t('billing.plans.people'),
    ];
    const paid = id !== 'free';
    const pct = paid ? savePercent(p) : 0;
    const note = toYear ? `<p class="plans__note">${esc(t('billing.plans.monthlyNote', { pct }))}</p>` : '';
    // "No commitment" sits under a monthly buy button only; the card of the plan in force carries its own mark instead.
    const terms = paid && period === 'month' && (action === 'buy' || action === 'renew') ? `<p class="plans__terms">${esc(t('billing.plans.noCommitment'))}</p>` : '';
    const mark = action === 'current' || toYear ? `<span class="plans__badge">${esc(t('billing.plans.current'))}</span>` : '';
    return `<article class="plans__card${lit ? ' is-current' : ''}" data-plan="${id}" aria-labelledby="plan-${id}-name">
      <div class="plans__head">${planIconHtml(id)}<h3 id="plan-${id}-name">${esc(planName(id))}</h3>${mark}</div>
      <p class="plans__tagline">${esc(t(`billing.plans.tagline.${id}`))}</p>
      ${paid ? cardToggleHtml(id, period, pct) : ''}
      ${noRate ? '' : priceHtml(id, p, period)}
      <button type="button" class="btn plans__cta ${paid ? 'plans__cta--paid' : 'plans__cta--free'}" data-pick="${id}" data-action="${toYear ? 'switch-year' : action}"${disabled ? ' disabled' : ''}>${esc(label)}</button>
      ${terms}${note}
      ${listHtml(id, lines)}
    </article>`;
  }

  function rateHtml() {
    const rate = data.plans.rate;
    if (!rate) return `<p class="plans__rate" role="status">${esc(t('billing.ratesDown'))}</p>`;
    const stamp = rateStamp(rate.at);
    if (!stamp) return '';
    // Exchange Rate API's terms ask for a link on any day its rate is the one in use; Frankfurter and Vietcombank ask for none.
    const link = rate.source === 'erapi' ? ` <a href="${ATTRIBUTION}" target="_blank" rel="noopener noreferrer">${esc(t('billing.rate.attribution'))}</a>` : '';
    return `<p class="plans__rate">${esc(t('billing.rate.updated', stamp))}${link}</p>`;
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
    const seg = ['individual', 'team']
      .map((a) => `<button type="button" role="radio" data-audience="${a}" aria-checked="${a === audience}" tabindex="${a === audience ? 0 : -1}">${esc(t(`billing.plans.${a}`))}</button>`)
      .join('');
    const choose = `<div class="plans__audience" role="radiogroup" aria-label="${esc(t('billing.plans.audience'))}">${seg}</div>`;
    if (audience === 'team') return `${keep}${ask}${choose}<div class="plans__cards plans__cards--team">${teamCardHtml({ noted: !!data.account.teamInterest, busy: teamBusy })}</div>`;
    return `${keep}${ask}${choose}
      <div class="plans__cards">${ORDER.map(cardHtml).join('')}</div>${paygHtml()}${rateHtml()}`;
  }

  /* ── the checkout ─────────────────────────────────────────────────── */
  async function startCheckout(plan, chosen) {
    period = chosen;
    view = 'checkout';
    // The consent box starts empty for every checkout: it speaks for this order, not for the last one.
    checkout = { plan, quotes: null, useBalance: true, consent: false, error: null, draft: null };
    paint('title');
    await loadQuotes();
  }

  async function loadQuotes() {
    const wanted = checkout;
    try {
      const settled = await Promise.allSettled([api.billingQuote({ plan: wanted.plan, period: 'month' }), api.billingQuote({ plan: wanted.plan, period: 'year' })]);
      if (checkout !== wanted) return;
      const good = settled.find((r) => r.status === 'fulfilled');
      // None came back, so the first is a rejection.
      if (!good) throw /** @type {PromiseRejectedResult} */ (settled[0]).reason;
      // With the rate source down only a renewal whose price is already locked can be quoted: the other period is left out (shown
      // as unavailable and not chosen) instead of failing the whole checkout.
      const [month, year] = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : { ...good.value, period: i ? 'year' : 'month', kind: 'later', priceVnd: 0, creditVnd: 0, totalVnd: 0, dueVnd: null, useBalance: null, unavailable: true }));
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

  /** A renewal order that already exists decided for itself whether the balance pays; the checkbox only speaks for an order not yet made. */
  const useBalanceFor = (q) => (q.useBalance == null ? checkout.useBalance : q.useBalance);

  function dueToday() {
    const q = checkout.quotes[period];
    // An order that exists knows what its QR will ask for (a short transfer already counted); the server's figure is the one shown.
    if (q.dueVnd != null) return q.dueVnd;
    return Math.max(0, q.totalVnd - (useBalanceFor(q) ? Math.min(q.balanceVnd, q.totalVnd) : 0));
  }

  function checkoutHtml() {
    if (checkout.error) return `<p class="plans__error" role="alert">${esc(checkout.error)}</p><p><button type="button" class="btn" data-back>${esc(t('billing.back'))}</button></p>`;
    if (!checkout.quotes) return `<p class="plans__muted">${esc(t('common.loading'))}</p>`;
    const q = checkout.quotes[period];
    const balanceUsed = useBalanceFor(q) ? Math.min(q.balanceVnd, q.totalVnd) : 0;
    return checkoutViewHtml({ checkout, period, plan: planById(checkout.plan), label: planName(checkout.plan), profile: profileOf(), dueVnd: dueToday(), balanceUsed, busy });
  }

  /**
   * The profile as the form would send it: trimmed, the country in capitals, an empty optional field as nothing.
   * @returns {Record<string, string>}
   */
  function profileBody(form) {
    /** @type {Record<string, string>} */
    const v = Object.fromEntries(Object.entries(typed(form)).map(([k, x]) => [k, x.trim()]));
    return { ...v, country: v.country.toUpperCase() };
  }

  /**
   * Saves the billing information that was typed, as part of subscribing: nothing is sent when it is what the account already
   * holds. Says in the form what is wrong and returns false, so no order is made on information the server refused.
   */
  async function saveProfile() {
    const form = /** @type {HTMLFormElement | null} */ ($('form[data-profile]'));
    if (!form || busy) return false;
    const mine = checkout;
    const token = flow;
    const body = profileBody(form);
    checkout.draft = typed(form);
    if (!body.name || !body.email || !body.country) {
      checkout.formError = t('billing.profile.required');
      paint(null);
      $(`#bill-${!body.name ? 'name' : !body.email ? 'email' : 'country'}`)?.focus();
      return false;
    }
    const saved = profileOf();
    if (saved && FORM_FIELDS.every((f) => (saved[f.key] ?? '') === body[f.key])) {
      checkout.formError = null;
      return true;
    }
    busy = true;
    paint(null);
    try {
      const done = await api.billingProfile(body);
      busy = false;
      // The sheet was closed or left meanwhile: what was saved is saved, and nothing here may carry on for a screen that is gone.
      if (!dialog.open || flow !== token || checkout !== mine) return false;
      data.account.profile = done.profile;
      checkout.formError = null;
      checkout.draft = null;
      return true;
    } catch (err) {
      busy = false;
      if (!dialog.open || flow !== token || checkout !== mine) return false;
      checkout.formError = err.message;
      paint(null);
      $('#bill-name')?.focus();
      return false;
    }
  }

  /** Subscribe: the form is saved with the order, then the order is made. Off until the consent box is ticked. */
  async function subscribe() {
    if (!checkout?.quotes || !checkout.consent || busy) return;
    const mine = checkout;
    const token = flow;
    if (!(await saveProfile())) return;
    // The box may have been unticked while the information was being saved: then no order is made.
    if (!dialog.open || flow !== token || checkout !== mine || !checkout.consent) return;
    await makeOrder({ kind: 'plan', plan: checkout.plan, period, useBalance: useBalanceFor(checkout.quotes[period]) }, 'plan');
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
    api.billingReceipts()
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
    const labels = Object.fromEntries(Object.entries(COPY).map(([k, key]) => [k, t(key)]));
    const values = { bank: q.bank, account: q.account, holder: q.holder, amount: vnd(q.amount), content: q.content };
    const waiting = pay.state === 'waiting';
    const status = statusText();
    const shown = deadline();
    return `<div class="pay">
      <p class="pay__lead">${esc(t('billing.pay.lead'))}</p>
      <div class="pay__grid">
        <div class="pay__qr"><img src="${esc(q.image)}" alt="${esc(t('billing.pay.qrAlt', { amount: vnd(q.amount), content: q.content }))}" width="220" height="220"></div>
        <dl class="pay__rows">${Object.keys(COPY).map((k) => `<div><dt>${esc(labels[k])}</dt><dd id="pay-${k}">${esc(values[k])}</dd><button type="button" class="btn btn--small" data-copy="${k}" aria-label="${esc(t('billing.pay.copy', { what: labels[k] }))}">${esc(t('billing.pay.copyShort'))}</button></div>`).join('')}</dl>
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
    const value = key === 'amount' ? String(pay.qr.amount) : String(pay.qr[key]);
    try {
      await navigator.clipboard.writeText(value);
      toast(t('billing.pay.copied', { what: t(COPY[key]) }), 'ok');
    } catch {
      // The clipboard was refused (an insecure origin, a policy): select the text so Ctrl+C finishes it.
      const el = $(`#pay-${key}`);
      if (el) window.getSelection()?.selectAllChildren(el);
      toast(t('billing.pay.selected'));
    }
  }

  /* ── events ───────────────────────────────────────────────────────── */

  /** The plan whose card holds the pressed control: all three toggles show one state, but the person's focus stays in the card they pressed. */
  const cardOf = (el) => /** @type {HTMLElement | null} */ (el.closest('[data-plan]'))?.dataset.plan || '';

  function choosePeriod(next, focus = true, card = '') {
    if (next === period || (view === 'checkout' && laterQuote(next))) return;
    period = next;
    if (view === 'checkout') paint(null);
    else {
      confirming = null;
      paint(null);
    }
    if (focus) $(`${card ? `[data-plan="${card}"] ` : ''}[data-period="${next}"]`)?.focus();
  }

  function chooseAudience(next) {
    if (next === audience) return;
    audience = next;
    confirming = null;
    paint(null);
    $(`[data-audience="${next}"]`)?.focus();
  }

  /** Records, once, that this account wants to hear when Team opens; the status line is changed in place so it is announced. */
  async function wantTeam() {
    if (!data || teamBusy || data.account.teamInterest) return;
    teamBusy = true;
    const status = $('.plans__teamstatus');
    const token = flow;
    const mine = data;
    try {
      await api.billingTeamInterest();
      // The sheet was closed or opened again meanwhile: the server has it, and the screen this answer is for is gone.
      if (flow !== token || data !== mine) return;
      data.account.teamInterest = true;
      if (status) status.textContent = t('billing.team.noted');
      $('[data-team-interest]')?.setAttribute('aria-disabled', 'true');
    } catch (err) {
      if (flow === token) toast(err.message, 'error');
    } finally {
      teamBusy = false;
    }
  }

  async function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('button, a'));
    if (!el || el.tagName === 'A') return;
    if (el.hasAttribute('data-close') || el.hasAttribute('data-done')) return void dialog.close();
    if (el.dataset.period) return choosePeriod(el.dataset.period, true, cardOf(el));
    if (el.dataset.audience) return chooseAudience(el.dataset.audience);
    if (el.hasAttribute('data-team-interest')) return void wantTeam();
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
      if (view === 'sheet' && dialog.open) paint('title');
      return;
    }
    if (el.hasAttribute('data-continue')) return void subscribe();
    if (el.dataset.copy) return void copy(el.dataset.copy);
    if (el.hasAttribute('data-cancel')) return void cancelOrder();
  }

  function onChange(event) {
    const el = /** @type {HTMLInputElement} */ (event.target);
    if (el.hasAttribute?.('data-use-balance')) {
      checkout.useBalance = el.checked;
      paint(null);
      $('[data-use-balance]')?.focus();
    } else if (el.hasAttribute?.('data-consent')) {
      checkout.consent = el.checked;
      checkout.consentFor = el.checked ? dueToday() : null;
      paint(null);
      $('[data-consent]')?.focus();
    }
  }

  /** Arrow keys move inside a radio group, as native radios do; the checked one is the only tab stop. */
  function onKey(event) {
    const el = /** @type {HTMLElement} */ (event.target);
    if (el.getAttribute?.('role') !== 'radio') return;
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!dir) return;
    event.preventDefault();
    // Two choices in each group, so any arrow is "the other one".
    if (el.dataset.audience) return chooseAudience(audience === 'individual' ? 'team' : 'individual');
    choosePeriod(period === 'month' ? 'year' : 'month', true, cardOf(el));
  }

  function pick(id) {
    if (!data) return;
    const action = actionFor(id);
    // The plan in force, paid by the month: its card's button moves it to the year (the checkout opens on yearly).
    if (yearSwitch(id)) {
      void startCheckout(id, 'year');
    } else if (action === 'buy' || action === 'renew') {
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
