import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';

/*
 * Settings → People → Free allowances, in the Administration group (server/freeTier.js,
 * server/keyPool.js; owner 2026-11-12): one row per service — the allowance the whole deployment shares — and, for the
 * services that take several keys, a button opening every key: its last four characters (never
 * the key), what it has used, whose figure that is, its state. The owner alone adds, checks and
 * removes keys and chooses the paid one; an administrator with `free_tier` reads the same rows.
 *
 * Every figure says whose it is: "Tavily reports" is the provider's own answer, "counted here"
 * is what Synapsez counted. While the page is on screen and the tab is visible it asks again
 * every minute; otherwise it asks nothing.
 */

/** How often the visible page asks again on its own. */
const LIVE_EVERY_MS = 60_000;
/** Time a "Really remove?" waits for the second press. */
const ARMED_MS = 4000;

/** What a ceiling is entered in, per service. Exa and E2B count in thousandths of a dollar. */
const UNITS = { exa: 'usd', e2b: 'usd', tavily: 'credits', firecrawl: 'credits', brave: 'requests' };
/** Services whose plan the provider reports: no ceiling is asked for. */
const PLAN_READ = new Set(['tavily', 'firecrawl']);
/** How many keys each service takes at most (keyPool.js POOLED, repeated for the "+ Add key" button). */
const MAX_KEYS = { exa: 10, tavily: 10, firecrawl: 10, brave: 1, e2b: 1 };
/** Services whose one key is the server's setting and no other: E2B's machines are made with it (server/e2b.js), so the server refuses another. */
const ENV_ONLY = new Set(['e2b']);
const PER_LABEL = { month: 'freetier.perMonth', day: 'freetier.perDay', hour: 'freetier.perHour', minute: 'freetier.perMinute' };
/** The word for each key state; `spent` and `waiting` take a figure. */
const STATE_WORD = { ok: 'freetier.state.ok', invalid: 'freetier.state.invalid', exhausted: 'freetier.state.exhausted', cooling: 'freetier.state.cooling' };

/**
 * @typedef {{ freeTier: () => Promise<any>, secretsPolicy: (on: boolean) => Promise<any>, addServiceKey: (body: any) => Promise<any>, removeServiceKey: (id: string) => Promise<any>, checkServiceKey: (id: string) => Promise<any>, setPaidKey: (service: string, keyId: string|null, capMonthly: number|null) => Promise<any> }} Api
 * @typedef {{ api: Api, toast: (text: string, kind?: string) => void }} Deps
 */

const locale = () => (currentLanguage() === 'vi' ? 'vi-VN' : 'en-US');
const day = (iso) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(new Date(iso));
const clock = (iso) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
/** Exa and E2B in dollars; the rest in requests or credits. */
const amount = (service, n) => (UNITS[service] === 'usd' ? `$${(Number(n) / 1000).toFixed(2)}` : Number(n).toLocaleString(locale()));
const hintOf = (hint) => `…${String(hint || '').replace(/^…/, '')}`;

/**
 * Where the move off the old credential envelope is (server/secretsCutover.js, owner
 * 2026-11-12), in one line — counts only — and, for the owner, the switch on it.
 *
 * @param {any} secrets
 * @param {boolean} owner
 */
function secretsLine(secrets, owner) {
  if (!secrets) return '';
  const when = (iso) => (iso ? day(iso) : '—');
  const count = secrets.lastCount;
  let text;
  if (secrets.refuseV1?.on || secrets.envRefuses) text = t('freetier.secretsRefused', { when: when(secrets.refuseV1?.at) });
  else if (secrets.refuseV1?.by === 'owner') text = t('freetier.secretsHeld');
  else if (!count) text = t('freetier.secretsPending');
  else if (count.safe) text = t('freetier.secretsSafe');
  else text = t('freetier.secretsMoving', { left: String(count.resealed || 0), stuck: String(count.unopenable || 0), when: when(count.at) });
  const refused = secrets.refuseV1?.on === true;
  const button = owner && !secrets.envRefuses
    ? ` <button type="button" class="btn btn--ghost btn--small" data-secrets-policy="${refused ? 'allow' : 'refuse'}">${escapeHtml(t(refused ? 'freetier.secretsAllow' : 'freetier.secretsRefuse'))}</button>`
    : '';
  return `<p class="hint">${escapeHtml(text)}${button}</p>`;
}

/** The share of a ceiling used, as a bar that is only decoration: the figures beside it say it. */
function bar(used, limit) {
  const share = used == null || !limit ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return `<span class="freetier__bar${share >= 90 ? ' is-near' : ''}" aria-hidden="true"><span style="width:${share}%"></span></span>`;
}

/** What a key is doing, in words — and until when. */
function stateWord(key, now) {
  if (key.state === 'exhausted') return key.retryAt ? t('freetier.state.exhaustedUntil', { when: day(key.retryAt) }) : t(STATE_WORD.exhausted);
  if (key.state === 'cooling') return t(STATE_WORD.cooling, { n: String(Math.max(0, Math.ceil((new Date(key.retryAt || now).getTime() - now) / 1000))) });
  return t(STATE_WORD[key.state] || STATE_WORD.ok);
}

/** Two Firecrawl keys that report the same team: the same credits, the same period, the same use. */
function sameTeam(keys) {
  const seen = new Set();
  for (const key of keys) {
    if (key.source !== 'provider') continue;
    const mark = `${key.limit}|${key.resets}|${key.used}`;
    if (seen.has(mark)) return true;
    seen.add(mark);
  }
  return false;
}

/**
 * @param {HTMLElement} host  `#admin-free-tier`
 * @param {Deps} deps
 */
export function createFreeAllowances(host, deps) {
  const { api, toast } = deps;
  /** Services whose keys are open, kept across a redraw. */
  const open = new Set();
  let visible = false;
  let heardAt = 0;
  /** The newest request's number, and whether one is out: an older answer is dropped. */
  let latest = 0;
  let asking = false;
  let tavilyOn = false;

  /** One key's row. */
  function keyRow(service, key, owner, now) {
    const used = key.used == null || key.limit == null ? '—' : `${amount(service, key.used)} / ${amount(service, key.limit)}`;
    const whose = key.source === 'provider' ? t('freetier.src.provider', { service: t(`freetier.${service}`) }) : t('freetier.src.counted');
    const name = key.fromEnv ? t('freetier.envKey') : key.label || '';
    const radio = owner
      ? `<label class="freepool__paid"><input type="radio" name="paid-${escapeHtml(service)}" value="${escapeHtml(key.id)}" data-paid-radio${key.paid ? ' checked' : ''}> ${escapeHtml(t('freetier.paid.radio'))}</label>`
      : key.paid ? `<span class="freepool__badge">${escapeHtml(t('freetier.paid.radio'))}</span>` : '';
    const acts = owner
      ? `<button type="button" class="btn btn--ghost btn--small" data-key-check="${escapeHtml(key.id)}">${escapeHtml(t('freetier.check'))}</button>${
        key.fromEnv ? '' : ` <button type="button" class="btn btn--ghost btn--small" data-key-remove="${escapeHtml(key.id)}">${escapeHtml(t('action.remove'))}</button>`
      }`
      : '';
    return `<li class="freepool__key" data-key-row data-key-id="${escapeHtml(key.id)}" data-key-hint="${escapeHtml(String(key.hint || ''))}">
        <span class="freepool__name"><code>${escapeHtml(hintOf(key.hint))}</code>${name ? ` <span>${escapeHtml(name)}</span>` : ''}${key.plan ? ` <span class="freepool__plan">${escapeHtml(key.plan)}</span>` : ''}</span>
        <span class="freetier__used">${bar(key.used, key.limit)}<span>${escapeHtml(used)} <span class="crow__desc">· ${escapeHtml(whose)} · ${escapeHtml(t('freetier.resetsOn', { day: key.resets ? day(key.resets) : '—' }))}</span></span></span>
        <span class="freepool__state is-${escapeHtml(key.state)}">${escapeHtml(stateWord(key, now))}</span>
        <span class="freepool__acts">${radio}${acts ? ` ${acts}` : ''}</span>
      </li>`;
  }

  /** The paid-key controls under a service's keys: none, the cap, and what the provider must allow. */
  function paidBox(entry, owner) {
    const { service } = entry;
    const unit = UNITS[service];
    const cap = entry.paid?.capMonthly;
    const shown = cap == null ? '' : unit === 'usd' ? String(Number(cap) / 1000) : String(cap);
    const spent = entry.paid && entry.paid.spent != null ? `<p class="hint">${escapeHtml(t('freetier.paid.spent', { amount: amount(service, entry.paid.spent) }))}</p>` : '';
    const none = owner
      ? `<label class="freepool__paid"><input type="radio" name="paid-${escapeHtml(service)}" value="" data-paid-radio${entry.paid ? '' : ' checked'}> ${escapeHtml(t('freetier.paid.none'))}</label>`
      : '';
    const capField = owner
      ? `<label class="freepool__cap">${escapeHtml(t('freetier.paid.cap', { unit: t(`freetier.unit.${unit}`) }))}
          <input type="number" min="0" step="any" inputmode="decimal" data-paid-cap value="${escapeHtml(shown)}"></label>`
      : cap != null ? `<p class="hint">${escapeHtml(t('freetier.paid.capIs', { amount: amount(service, cap) }))}</p>` : '';
    const brave = service === 'brave' && owner && cap == null ? `<p class="hint">${escapeHtml(t('freetier.paid.braveCap'))}</p>` : '';
    return `<div class="freepool__paidbox">${none}${capField}<p class="hint">${escapeHtml(t('freetier.paid.note'))}</p>${brave}${spent}</div>`;
  }

  /** The inline "+ Add key" form: a password box that never echoes, a label, a ceiling where one is asked. */
  function addForm(service) {
    const unit = UNITS[service];
    const ceiling = PLAN_READ.has(service)
      ? ''
      : `<label for="fa-ceiling-${service}">${escapeHtml(t('freetier.add.ceiling', { unit: t(`freetier.unit.${unit}`) }))}</label>
         <input id="fa-ceiling-${service}" type="number" min="0" step="any" inputmode="decimal" data-add-ceiling>`;
    return `<form class="freepool__add" id="fa-form-${service}" data-add-form="${service}" hidden>
        <label for="fa-key-${service}">${escapeHtml(t('freetier.add.key'))}</label>
        <input id="fa-key-${service}" type="password" autocomplete="off" spellcheck="false" required data-add-key>
        <label for="fa-label-${service}">${escapeHtml(t('freetier.add.label'))}</label>
        <input id="fa-label-${service}" type="text" maxlength="60" autocomplete="off" data-add-label>
        ${ceiling}
        <span class="freepool__acts"><button type="submit" class="btn btn--small" data-add-save>${escapeHtml(t('freetier.add.save'))}</button>
        <button type="button" class="btn btn--ghost btn--small" data-add-cancel>${escapeHtml(t('action.cancel'))}</button></span>
      </form>`;
  }

  /** A pooled service's row and the keys beneath it. */
  function pooledGroup(s, entry, owner, now, label) {
    const service = s.service;
    const count = entry.keys.length;
    const expanded = open.has(service);
    const used = s.used == null ? '—' : `${amount(service, s.used)} / ${amount(service, s.limit)}`;
    const warn = [];
    if (service === 'firecrawl' && sameTeam(entry.keys)) warn.push(t('freetier.sameTeam'));
    if (service === 'tavily' && tavilyOn) warn.push(t('freetier.tavilyHint'));
    const keys = entry.keys.map((k) => keyRow(service, k, owner, now)).join('');
    const canAdd = owner && !ENV_ONLY.has(service) && count < (MAX_KEYS[service] ?? 1);
    return `<div class="freepool" data-pool="${escapeHtml(service)}" role="rowgroup">
        <div class="ctable__row" role="row">
          <span role="cell"><strong>${escapeHtml(label)}</strong>
            <span class="freepool__chip">${escapeHtml(t(count === 1 ? 'freetier.keysOne' : 'freetier.keysMany', { n: String(count) }))}</span>
            <button type="button" class="btn btn--ghost btn--small freepool__toggle" data-pool-toggle aria-expanded="${expanded}" aria-controls="fa-keys-${escapeHtml(service)}">${escapeHtml(t(expanded ? 'freetier.hideKeys' : 'freetier.showKeys'))}</button></span>
          <span role="cell" class="freetier__used">${bar(s.used, s.limit)}${escapeHtml(used)} ${escapeHtml(t(PER_LABEL[s.per] || 'freetier.perDay'))}</span>
          <span role="cell" class="crow__desc">${escapeHtml(t('freetier.resets', { day: day(s.resets) }))}</span>
        </div>
        <div class="freepool__keys" id="fa-keys-${escapeHtml(service)}" role="row"${expanded ? '' : ' hidden'}><div role="cell">
          ${warn.map((w) => `<p class="hint freepool__warn">${escapeHtml(w)}</p>`).join('')}
          <fieldset class="freepool__set"><legend class="sr-only">${escapeHtml(t('freetier.paid.legend', { service: label }))}</legend>
            <ul class="freepool__list">${keys || `<li class="hint">${escapeHtml(t('freetier.noKeys'))}</li>`}</ul>
            ${paidBox(entry, owner)}
          </fieldset>
          ${canAdd ? `<button type="button" class="btn btn--ghost btn--small" data-pool-add aria-controls="fa-form-${escapeHtml(service)}">${escapeHtml(t('freetier.add.open'))}</button>${addForm(service)}` : ''}
        </div></div>
      </div>`;
  }

  /** @param {any} report */
  function draw(report) {
    const owner = report.owner === true;
    const now = Date.now();
    const pool = new Map((report.pool || []).map((p) => [p.service, p]));
    const rows = [];
    for (const s of report.services) {
      const label = t(`freetier.${s.service}`);
      const entry = pool.get(s.service);
      if (entry?.pooled) {
        rows.push(pooledGroup(s, entry, owner, now, label));
        pool.delete(s.service);
        continue;
      }
      // Drawn here with its note: the loop below is only for services with no allowance row.
      pool.delete(s.service);
      const used = s.used == null ? '—' : `${amount(s.service, s.used)} / ${amount(s.service, s.limit)}`;
      const note = entry?.note ? t(entry.note) : s.service === 'google' ? t('freetier.googleNote') : '';
      rows.push(`<div class="ctable__row" role="row">
          <span role="cell"><strong>${escapeHtml(label)}</strong>${note ? `<span class="hint freepool__note">${escapeHtml(note)}</span>` : ''}</span>
          <span role="cell" class="freetier__used">${bar(s.used, s.limit)}${escapeHtml(used)} ${escapeHtml(t(PER_LABEL[s.per] || 'freetier.perDay'))}</span>
          <span role="cell" class="crow__desc">${escapeHtml(t('freetier.resets', { day: s.per === 'minute' || s.per === 'hour' ? clock(s.resets) : day(s.resets) }))}</span>
        </div>`);
    }
    // A service that is not pooled and has no allowance row of its own still says why.
    for (const entry of pool.values()) {
      if (entry.pooled || !entry.note) continue;
      rows.push(`<div class="ctable__row" role="row"><span role="cell"><strong>${escapeHtml(t(`freetier.${entry.service}`))}</strong><span class="hint freepool__note">${escapeHtml(t(entry.note))}</span></span><span role="cell">—</span><span role="cell">—</span></div>`);
    }
    host.innerHTML = `<div class="freepool__bar"><button type="button" class="btn btn--ghost btn--small" data-free-refresh>${escapeHtml(t('freetier.refresh'))}</button>
        <span class="hint" role="status" aria-live="polite">${escapeHtml(t('freetier.heard', { time: clock(new Date(heardAt).toISOString()) }))}</span></div>
      <div class="ctable ctable--free" role="table" aria-label="${escapeHtml(t('freetier.title'))}">
        <div class="ctable__head" role="row"><span role="columnheader">${escapeHtml(t('freetier.service'))}</span><span role="columnheader">${escapeHtml(t('freetier.used'))}</span><span role="columnheader">${escapeHtml(t('freetier.when'))}</span></div>
        ${rows.join('')}
      </div>
      <p class="hint">${escapeHtml(report.enforced ? t('freetier.enforced', { n: String(report.userDaily) }) : t('freetier.off'))}</p>${
        Number.isFinite(report.firecrawl?.remaining)
          ? `<p class="hint">${escapeHtml(t('freetier.firecrawlLive', { left: Number(report.firecrawl.remaining).toLocaleString(locale()), plan: report.firecrawl.plan == null ? '—' : Number(report.firecrawl.plan).toLocaleString(locale()) }))}</p>`
          : ''
      }${
        // The id `npm run secrets:reseal -- --apply --key-id` must be given (a hash, never the key).
        report.encryptionKeyId ? `<p class="hint">${escapeHtml(t('freetier.keyId'))} <code>${escapeHtml(report.encryptionKeyId)}</code></p>` : ''
      }${secretsLine(report.secrets, owner)}`;
  }

  /** Whether the person is in the middle of something a redraw would wipe. */
  const editing = () => !!host.querySelector('[data-add-form]:not([hidden])') || (host.contains(document.activeElement) && !!document.activeElement?.matches('input:not([data-paid-radio])'));

  async function load({ force = false } = {}) {
    // A quiet poll waits for one already asked; a forced load always asks, and its answer wins.
    if (!force && asking) return;
    const mine = ++latest;
    asking = true;
    try {
      const report = await api.freeTier();
      if (mine !== latest) return;
      tavilyOn = report.tavilyHint === true;
      heardAt = Date.now();
      // The page is being used: a quiet refresh waits for the person to finish.
      if (force || !editing()) {
        // A keyboard user who has just chosen a paid key stays on that radio.
        const was = document.activeElement;
        const radio = /** @type {HTMLInputElement | null} */ (was?.matches('input[data-paid-radio]') && host.contains(was) ? /** @type {HTMLInputElement} */ (was) : null);
        const where = radio ? { service: radio.closest('[data-pool]')?.getAttribute('data-pool'), value: radio.value } : null;
        draw(report);
        if (where) /** @type {HTMLElement | null} */ (host.querySelector(`[data-pool="${where.service}"] input[data-paid-radio][value="${window.CSS.escape(where.value)}"]`))?.focus();
      }
    } catch (err) {
      if (!host.querySelector('.ctable')) host.textContent = err.message;
      else if (force) toast(err.message, 'error');
    } finally {
      if (mine === latest) asking = false;
    }
  }

  /**
   * Make a call, say its failure as a toast, redraw on success. `redraw`: draw from the server
   * after a failure too, for a control (the paid radio) that already moved under the person's hand.
   *
   * @param {() => Promise<any>} run
   */
  async function act(run, button, { redraw = false } = {}) {
    if (button) button.disabled = true;
    try {
      const out = await run();
      await load({ force: true });
      return out;
    } catch (err) {
      toast(err.message, 'error');
      if (button?.isConnected) button.disabled = false;
      if (redraw) await load({ force: true });
      return null;
    }
  }

  /** The cap as the server counts it: dollars are thousandths. */
  const capOf = (service, group) => {
    const raw = /** @type {HTMLInputElement | null} */ (group.querySelector('[data-paid-cap]'))?.value.trim() ?? '';
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? (UNITS[service] === 'usd' ? Math.round(n * 1000) : n) : null;
  };

  /** Choose the paid key, or none; the cap field rides along. @param {HTMLElement} group */
  function savePaid(group) {
    const service = /** @type {string} */ (group.dataset.pool);
    const picked = /** @type {HTMLInputElement | null} */ (group.querySelector('input[data-paid-radio]:checked'));
    const keyId = picked && picked.value ? picked.value : null;
    return act(() => api.setPaidKey(service, keyId, keyId ? capOf(service, group) : null), null, { redraw: true }).then((out) => {
      if (out) toast(t('freetier.paid.saved'), 'ok');
    });
  }

  host.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const group = /** @type {HTMLElement | null} */ (target.closest('[data-pool]'));
    const toggle = target.closest('[data-pool-toggle]');
    if (toggle && group) {
      const service = /** @type {string} */ (group.dataset.pool);
      const now = toggle.getAttribute('aria-expanded') !== 'true';
      if (now) open.add(service);
      else open.delete(service);
      toggle.setAttribute('aria-expanded', String(now));
      toggle.textContent = t(now ? 'freetier.hideKeys' : 'freetier.showKeys');
      /** @type {HTMLElement} */ (group.querySelector('.freepool__keys')).hidden = !now;
      return;
    }
    if (target.closest('[data-free-refresh]')) {
      await load({ force: true });
      return;
    }
    const policy = /** @type {HTMLButtonElement | null} */ (target.closest('[data-secrets-policy]'));
    if (policy) {
      await act(() => api.secretsPolicy(policy.dataset.secretsPolicy === 'refuse'), policy);
      return;
    }
    if (!group) return;
    if (target.closest('[data-pool-add]')) {
      const form = /** @type {HTMLFormElement} */ (group.querySelector('[data-add-form]'));
      form.hidden = false;
      /** @type {HTMLElement} */ (form.querySelector('[data-add-key]')).focus();
      return;
    }
    if (target.closest('[data-add-cancel]')) {
      const form = /** @type {HTMLFormElement} */ (group.querySelector('[data-add-form]'));
      form.reset();
      form.hidden = true;
      /** @type {HTMLElement | null} */ (group.querySelector('[data-pool-add]'))?.focus();
      return;
    }
    const check = /** @type {HTMLButtonElement | null} */ (target.closest('[data-key-check]'));
    if (check) {
      const out = await act(() => api.checkServiceKey(/** @type {string} */ (check.dataset.keyCheck)), check);
      if (out) toast(out.ok ? t('freetier.checkOk') : t(out.reason === 'refused' ? 'freetier.checkRefused' : 'freetier.checkLater'), out.ok ? 'ok' : 'error');
      return;
    }
    const remove = /** @type {HTMLButtonElement | null} */ (target.closest('[data-key-remove]'));
    if (remove) {
      // Two presses: the first says what the second will do.
      if (remove.dataset.armed !== '1') {
        remove.dataset.armed = '1';
        const was = remove.textContent;
        remove.textContent = t('action.reallyRemove');
        setTimeout(() => {
          if (remove.isConnected) {
            remove.dataset.armed = '';
            remove.textContent = was;
          }
        }, ARMED_MS);
        return;
      }
      await act(() => api.removeServiceKey(/** @type {string} */ (remove.dataset.keyRemove)), remove);
    }
  });

  host.addEventListener('change', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const group = /** @type {HTMLElement | null} */ (target.closest('[data-pool]'));
    if (!group) return;
    if (target.matches('input[data-paid-radio]')) void savePaid(group);
    // A cap changed while a key is chosen: saved with it.
    else if (target.matches('[data-paid-cap]') && group.querySelector('input[data-paid-radio]:checked')?.getAttribute('value')) void savePaid(group);
  });

  host.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.target);
    const group = /** @type {HTMLElement} */ (form.closest('[data-pool]'));
    const service = /** @type {string} */ (group.dataset.pool);
    const keyBox = /** @type {HTMLInputElement} */ (form.querySelector('[data-add-key]'));
    const ceilingBox = /** @type {HTMLInputElement | null} */ (form.querySelector('[data-add-ceiling]'));
    const raw = ceilingBox?.value.trim() ?? '';
    const ceiling = raw === '' ? null : UNITS[service] === 'usd' ? Math.round(Number(raw) * 1000) : Number(raw);
    const submit = /** @type {HTMLButtonElement} */ (form.querySelector('[data-add-save]'));
    const body = { service, key: keyBox.value, label: /** @type {HTMLInputElement} */ (form.querySelector('[data-add-label]')).value.trim() || undefined, ceiling };
    // The key leaves the box the moment it is sent, whatever the answer: it is never kept on the page.
    keyBox.value = '';
    submit.disabled = true;
    try {
      await api.addServiceKey(body);
      form.reset();
      form.hidden = true;
      toast(t('freetier.add.done'), 'ok');
      await load({ force: true });
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
    }
  });

  // Ask again every minute, but only while this is on screen and the tab is visible.
  const watching = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible && document.visibilityState === 'visible' && Date.now() - heardAt > LIVE_EVERY_MS) void load();
  }) : null;
  watching?.observe(host);
  setInterval(() => {
    if (visible && document.visibilityState === 'visible' && host.isConnected) void load();
  }, LIVE_EVERY_MS);

  return { load: () => load({ force: true }) };
}
