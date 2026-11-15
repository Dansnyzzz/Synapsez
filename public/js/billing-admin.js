import { t, localeTag } from './i18n.js';
import { escapeHtml as esc } from './markdown.js';
import { vnd, planName } from './billing-format.js';

/**
 * Settings → Administration → Billing (billing preview, 2026-11-15; the `billing` permission): the mode and the rate, the
 * money in against what the paid keys cost, what is held for people, how full the paid services are, the orders, the transfers
 * nobody claimed, promo codes, and — for the owner, in preview — a way to play the bank.
 *
 * Everything that came from a person (an account's email, what a payer typed as the content of a transfer) goes through `esc`:
 * the content of a transfer is whatever the sender wrote.
 */

const DAYS = 30;
const ARMED_MS = 5000;
const WARN = 0.75;
const BAD = 0.9;
const SOURCES = { erapi: 'Exchange Rate API', vietcombank: 'Vietcombank', frankfurter: 'Frankfurter' };

const when = (v) => new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
const day = (v) => new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(new Date(v));
const gb = (bytes) => `${new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(bytes / 1e9)} GB`;

/** ok / warn / bad by how full, or unknown when the figure could not be read. */
function levelOf(used, total) {
  if (used == null || !total) return 'unknown';
  const share = used / total;
  return share >= BAD ? 'bad' : share >= WARN ? 'warn' : 'ok';
}

/**
 * @param {HTMLElement} host
 * @param {{ api: any, toast: (message: string, kind?: string) => void }} deps
 */
export function createBillingAdmin(host, { api, toast }) {
  /** @type {any} */ let figures = null;
  /** @type {any[]} */ let orders = [];
  /** @type {any[]} */ let pending = [];
  /** @type {any[]} */ let transfers = [];
  /** @type {any[]} */ let promos = [];
  let failure = '';
  let latest = 0;
  /** What was said beside the promo form and the simulate button, kept across a redraw. */
  const said = { promo: null, sim: null };
  const typed = { code: '', credit: '', uses: '', exp: '' };

  /* ── drawing ──────────────────────────────────────────────────────── */
  const money = (n) => (n == null ? t('billing.admin.unknown') : vnd(n));
  const row = (label, value, attr = '') => `<div${attr}><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

  function modeHtml() {
    const rate = figures.rate;
    const rateText = rate ? t('billing.admin.rateIs', { rate: new Intl.NumberFormat(localeTag()).format(rate.rate), source: SOURCES[rate.source] || rate.source, at: when(rate.at) }) : t('billing.admin.rateDown');
    return `<dl class="adm__facts">${row(t('billing.admin.mode'), esc(t(`billing.admin.mode.${figures.mode}`)), ' data-adm="mode"')}${row(t('billing.admin.rate'), esc(rateText), ' data-adm="rate"')}</dl>`;
  }

  function moneyHtml() {
    const e = figures.entries;
    const cost = figures.cost;
    const spent = cost && Object.entries(cost.byService).filter(([, v]) => v.vnd > 0).map(([name, v]) => `${name} ${vnd(v.vnd)}`).join(', ');
    return `<h4 class="adm__h">${esc(t('billing.admin.last', { days: figures.days }))}</h4>
      <dl class="adm__facts">
        ${row(t('billing.admin.plans'), esc(vnd(e.plan.outVnd)))}
        ${row(t('billing.admin.payg'), esc(vnd(e.usage.outVnd)))}
        ${row(t('billing.admin.topups'), esc(vnd(e.topup.inVnd + e.assign.inVnd)))}
        ${row(t('billing.admin.held'), esc(t('billing.admin.heldValue', { vnd: vnd(figures.balancesHeldVnd), n: figures.accounts })))}
      </dl>
      <h4 class="adm__h">${esc(t('billing.admin.month'))}</h4>
      <dl class="adm__facts">
        ${row(t('billing.admin.revenue'), esc(money(figures.revenueMonthVnd)))}
        ${row(t('billing.admin.promoGiven'), esc(money(figures.promoMonthVnd)))}
        ${row(t('billing.admin.cost'), `${esc(money(cost ? cost.totalVnd : null))}${spent ? ` <span class="plans__muted">(${esc(spent)})</span>` : ''}`)}
        ${row(t('billing.admin.margin'), `<strong>${esc(money(figures.marginVnd))}</strong>`)}
      </dl>
      ${figures.figures?.einvoicesFailed ? `<p class="plans__error" role="status">${esc(t('billing.admin.einvoices', { n: figures.figures.einvoicesFailed }))}</p>` : ''}`;
  }

  function capacityRow(key, title, usedText, level, share, hint) {
    const bar = share == null ? '' : `<div class="usage__bar is-${level}" role="progressbar" aria-label="${esc(title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(1, share) * 100)}"><span style="width:${Math.round(Math.min(1, share) * 100)}%"></span></div>`;
    return `<div class="adm__cap is-${level}" data-cap="${key}" data-level="${level}"><p class="adm__caphead"><span>${esc(title)}</span> <span>${esc(usedText)} · <strong>${esc(t(`billing.admin.level.${level}`))}</strong></span></p>${bar}${hint ? `<p class="adm__hint">${esc(hint)}</p>` : ''}</div>`;
  }

  function capacityHtml() {
    const { machines, database } = figures.capacity;
    const ml = levelOf(machines.running, machines.limit);
    const dl = levelOf(database.bytes, database.includedBytes);
    return `<div data-adm="capacity">
      ${capacityRow('machines', t('billing.admin.machines'),
        t('billing.admin.of', { used: machines.running == null ? t('billing.admin.unknown') : machines.running, total: machines.limit }), ml,
        machines.running == null ? null : machines.running / machines.limit, ml === 'warn' || ml === 'bad' ? t(`billing.admin.machines.${ml}`) : '')}
      ${capacityRow('database', t('billing.admin.database'),
        t('billing.admin.of', { used: database.bytes == null ? t('billing.admin.unknown') : gb(database.bytes), total: gb(database.includedBytes) }), dl,
        database.bytes == null ? null : database.bytes / database.includedBytes, dl === 'warn' || dl === 'bad' ? t(`billing.admin.database.${dl}`) : '')}
    </div>`;
  }

  function ordersHtml() {
    const what = (o) => (o.plan ? `${planName(o.plan)} ${t(`billing.admin.kind.${o.kind}`)}` : t(`billing.admin.kind.${o.kind}`));
    const list = orders.map((o) => `<li data-order-row><span class="adm__main">${esc(o.email || t('billing.admin.noAccount'))}</span> <span>${esc(what(o))}</span> <span>${esc(vnd(o.totalVnd))}</span> <span class="adm__status is-${esc(o.status)}">${esc(t(`billing.admin.status.${o.status}`))}${o.simulated ? ` · ${esc(t('billing.admin.simulated'))}` : ''}</span> <span class="plans__muted">${esc(when(o.createdAt))}</span></li>`).join('');
    return `<h4 class="adm__h" id="adm-h-orders">${esc(t('billing.admin.orders'))}</h4>${list ? `<ul class="adm__list" aria-labelledby="adm-h-orders">${list}</ul>` : `<p class="plans__muted">${esc(t('billing.admin.noOrders'))}</p>`}`;
  }

  function transfersHtml() {
    const list = transfers.map((x) => `<li data-transfer="${x.id}">
        <p class="adm__tline"><strong>${esc(vnd(x.amountVnd))}</strong> <span class="plans__muted">${esc(when(x.receivedAt))}${x.gateway ? ` · ${esc(x.gateway)}` : ''}${x.via === 'simulated' ? ` · ${esc(t('billing.admin.simulated'))}` : ''}</span></p>
        <p class="adm__content">${esc(x.content || '—')}</p>
        <div class="adm__assign"><label for="adm-as-${x.id}">${esc(t('billing.admin.assignTo'))}</label>
          <input id="adm-as-${x.id}" type="email" autocomplete="off" data-assign-email${x.via === 'simulated' ? ' disabled' : ''}>
          <button type="button" class="btn btn--small btn--primary" data-assign${x.via === 'simulated' ? ' disabled' : ''}>${esc(t('billing.admin.assign'))}</button>
          <button type="button" class="btn btn--small" data-dismiss>${esc(t('billing.admin.markReturned'))}</button></div>
        <p class="plans__error" role="alert" data-transfer-error hidden></p>
      </li>`).join('');
    return `<h4 class="adm__h" id="adm-h-transfers">${esc(t('billing.admin.transfers'))}</h4><p class="plans__muted">${esc(t('billing.admin.transfersHint'))}</p>${list ? `<ul class="adm__list" aria-labelledby="adm-h-transfers">${list}</ul>` : `<p class="plans__muted">${esc(t('billing.admin.noTransfers'))}</p>`}`;
  }

  function promosHtml() {
    const now = Date.now();
    const list = promos.map((p) => {
      const expired = p.expiresAt && new Date(p.expiresAt).getTime() <= now;
      const state = !p.active ? t('billing.admin.promo.off') : expired ? t('billing.admin.promo.expired') : t('billing.admin.promo.on');
      return `<li data-promo-row="${esc(p.code)}"><code>${esc(p.code)}</code> <span>${esc(vnd(p.creditVnd))}</span> <span>${esc(t('billing.admin.promo.used', { used: p.used, max: p.maxUses }))}</span> <span class="plans__muted">${esc(p.expiresAt ? t('billing.admin.promo.until', { date: day(p.expiresAt) }) : t('billing.admin.promo.never'))}</span> <span class="adm__status">${esc(state)}</span>${p.active && !expired ? ` <button type="button" class="btn btn--small" data-promo-disable>${esc(t('billing.admin.promo.disable'))}</button>` : ''}</li>`;
    }).join('');
    const msg = said.promo ? `<p id="adm-promo-msg" class="${said.promo.ok ? 'plans__muted' : 'plans__error'}" role="${said.promo.ok ? 'status' : 'alert'}">${esc(said.promo.text)}</p>` : '<p id="adm-promo-msg" class="plans__muted"></p>';
    return `<h4 class="adm__h" id="adm-h-promos">${esc(t('billing.admin.promos'))}</h4>
      ${list ? `<ul class="adm__list" aria-labelledby="adm-h-promos">${list}</ul>` : `<p class="plans__muted">${esc(t('billing.admin.noPromos'))}</p>`}
      <form class="adm__form" data-promo-form novalidate>
        <div class="field"><label for="adm-promo-code">${esc(t('billing.admin.promo.code'))}</label><input id="adm-promo-code" autocomplete="off" spellcheck="false" maxlength="32" value="${esc(typed.code)}"></div>
        <div class="field"><label for="adm-promo-credit">${esc(t('billing.admin.promo.credit'))}</label><input id="adm-promo-credit" type="number" inputmode="numeric" min="1000" max="1000000" step="1000" value="${esc(typed.credit)}"></div>
        <div class="field"><label for="adm-promo-uses">${esc(t('billing.admin.promo.uses'))}</label><input id="adm-promo-uses" type="number" inputmode="numeric" min="1" max="10000" value="${esc(typed.uses)}"></div>
        <div class="field"><label for="adm-promo-exp">${esc(t('billing.admin.promo.expiry'))}</label><input id="adm-promo-exp" type="date" value="${esc(typed.exp)}"></div>
        <button type="submit" class="btn btn--primary btn--small" data-promo-create>${esc(t('billing.admin.promo.create'))}</button>
      </form>${msg}`;
  }

  function simulateHtml() {
    if (!figures.simulate) return '';
    const options = pending.map((o) => `<option value="${esc(o.id)}">${esc(`${o.email || '—'} · ${o.plan ? `${planName(o.plan)} ` : ''}${t(`billing.admin.kind.${o.kind}`)} · ${vnd(o.totalVnd)} · ${o.code}`)}</option>`).join('');
    const msg = said.sim ? `<p id="adm-sim-msg" class="${said.sim.ok ? 'plans__muted' : 'plans__error'}" role="${said.sim.ok ? 'status' : 'alert'}">${esc(said.sim.text)}</p>` : '<p id="adm-sim-msg" class="plans__muted" role="status"></p>';
    return `<h4 class="adm__h" id="adm-h-sim">${esc(t('billing.admin.simulate'))}</h4><p class="plans__muted">${esc(t('billing.admin.simulateHint'))}</p>
      <div class="adm__sim"><label for="adm-sim-order">${esc(t('billing.admin.simulateOrder'))}</label>
        <select id="adm-sim-order"><option value="">${esc(t('billing.admin.simulateChoose'))}</option>${options}</select>
        <button type="button" class="btn btn--small" data-simulate>${esc(t('billing.admin.simulateGo'))}</button></div>${msg}`;
  }

  function paint() {
    if (failure) {
      host.innerHTML = `<p class="plans__error" role="alert">${esc(failure)}</p><p><button type="button" class="btn btn--small" data-retry>${esc(t('billing.retry'))}</button></p>`;
      return;
    }
    if (!figures) return;
    const keep = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement.id : '';
    host.innerHTML = `<p class="plans__preview">${esc(t('billing.previewNote'))}</p>${modeHtml()}${moneyHtml()}<h4 class="adm__h">${esc(t('billing.admin.capacity'))}</h4>${capacityHtml()}${ordersHtml()}${transfersHtml()}${promosHtml()}${simulateHtml()}`;
    if (keep) /** @type {HTMLElement | null} */ (host.querySelector(`#${keep}`))?.focus();
  }

  /* ── reading ──────────────────────────────────────────────────────── */
  async function load() {
    const mine = ++latest;
    try {
      const [fig, recent, open, promo, waiting] = await Promise.all([
        api.adminBilling(DAYS),
        api.adminBillingOrders({ limit: 20 }),
        api.adminBillingTransfers({ outcome: 'unmatched', limit: 50 }),
        api.adminBillingPromos(),
        // Only for whoever may play the bank; the figures say whether that is this account.
        api.adminBillingOrders({ status: 'pending', limit: 50 }).catch(() => ({ orders: [] })),
      ]);
      if (mine !== latest) return;
      figures = { ...fig, entries: fig.figures.entries, balancesHeldVnd: fig.figures.balancesHeldVnd, accounts: fig.figures.accounts };
      orders = recent.orders;
      transfers = open.transfers;
      promos = promo.promos;
      pending = waiting.orders;
      failure = '';
    } catch (err) {
      if (mine !== latest) return;
      failure = err.message;
    }
    paint();
  }

  /* ── actions ──────────────────────────────────────────────────────── */
  /** Two presses: the first says what the second does, and it goes back by itself. */
  function twoPress(button, run) {
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      const was = button.textContent;
      button.textContent = t('billing.admin.sure');
      button.setAttribute('aria-live', 'polite');
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.armed = '';
        button.textContent = was;
        button.removeAttribute('aria-live');
      }, ARMED_MS);
      return;
    }
    run();
  }

  /** Says what went wrong beside the row it happened on, without redrawing the page under the person. */
  function rowError(li, text) {
    const err = /** @type {HTMLElement | null} */ (li.querySelector('[data-transfer-error]'));
    if (!err) return;
    err.textContent = text;
    err.hidden = !text;
  }

  async function assign(li, button) {
    const email = /** @type {HTMLInputElement} */ (li.querySelector('[data-assign-email]')).value.trim();
    if (!email) {
      rowError(li, t('billing.admin.assignEmpty'));
      /** @type {HTMLElement} */ (li.querySelector('[data-assign-email]')).focus();
      return;
    }
    button.disabled = true;
    try {
      const done = await api.adminAssignTransfer(li.dataset.transfer, email);
      toast(t('billing.admin.assigned', { balance: vnd(done.balanceVnd) }), 'ok');
      await load();
    } catch (err) {
      rowError(li, err.message);
      button.disabled = false;
    }
  }

  async function dismiss(li, button) {
    button.disabled = true;
    try {
      await api.adminDismissTransfer(li.dataset.transfer);
      toast(t('billing.admin.returned'), 'ok');
      await load();
    } catch (err) {
      rowError(li, err.message);
      button.disabled = false;
    }
  }

  async function createPromo() {
    const value = (id) => /** @type {HTMLInputElement} */ (host.querySelector(id)).value.trim();
    Object.assign(typed, { code: value('#adm-promo-code'), credit: value('#adm-promo-credit'), uses: value('#adm-promo-uses'), exp: value('#adm-promo-exp') });
    try {
      const made = await api.adminCreatePromo({ code: typed.code, creditVnd: Number(typed.credit), maxUses: Number(typed.uses), expiresAt: typed.exp ? new Date(`${typed.exp}T23:59:59`).toISOString() : null });
      said.promo = { ok: true, text: t('billing.admin.promo.made', { code: made.promo.code }) };
      Object.assign(typed, { code: '', credit: '', uses: '', exp: '' });
    } catch (err) {
      said.promo = { ok: false, text: err.message };
    }
    await load();
    host.querySelector('#adm-promo-code')?.focus();
  }

  async function simulate() {
    const select = /** @type {HTMLSelectElement} */ (host.querySelector('#adm-sim-order'));
    if (!select.value) {
      said.sim = { ok: false, text: t('billing.admin.simulateNone') };
      paint();
      host.querySelector('#adm-sim-order')?.focus();
      return;
    }
    try {
      const done = await api.adminSimulateTransfer(select.value);
      said.sim = { ok: true, text: t('billing.admin.simulated.done', { outcome: done.outcome }) };
    } catch (err) {
      said.sim = { ok: false, text: err.message };
    }
    await load();
    host.querySelector('#adm-sim-order')?.focus();
  }

  host.addEventListener('click', (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('button'));
    if (!el) return;
    const li = /** @type {HTMLElement | null} */ (el.closest('[data-transfer]'));
    if (el.hasAttribute('data-retry')) return void load();
    if (li && el.hasAttribute('data-assign')) return void assign(li, /** @type {HTMLButtonElement} */ (el));
    if (li && el.hasAttribute('data-dismiss')) return twoPress(el, () => void dismiss(li, /** @type {HTMLButtonElement} */ (el)));
    if (el.hasAttribute('data-promo-disable')) {
      const code = /** @type {HTMLElement} */ (el.closest('[data-promo-row]')).dataset.promoRow;
      return twoPress(el, () => {
        api.adminDisablePromo(code).then(() => load()).catch((err) => toast(err.message, 'error'));
      });
    }
    if (el.hasAttribute('data-simulate')) void simulate();
  });

  host.addEventListener('submit', (event) => {
    event.preventDefault();
    if (/** @type {HTMLElement} */ (event.target).matches('[data-promo-form]')) void createPromo();
  });

  return { load };
}
