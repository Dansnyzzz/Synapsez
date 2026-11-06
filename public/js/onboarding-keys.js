import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

/**
 * Getting a key, step by step, inside the guide (owner, 2026-11-06).
 *
 * Which provider first: the one the best free model runs on right now, read from the
 * administrators' suggestion each time the step is drawn, so it moves when they change
 * it. Then what to do there, from pressing the button that opens its page to the key
 * pasted back here, where one box takes as many keys as are pasted into it.
 *
 * The pictures are drawings of what to look for, marked as such: a provider's real
 * page sits behind its sign-in and changes without notice, and a screenshot of it would
 * be wrong the first time it did. The addresses and the steps come from each provider's
 * own documentation, and where that does not name a button, neither does this.
 *
 * @typedef {{ id: string, url: string, hint: string, steps: string[] }} ProviderGuide
 */

/** @type {Record<string, ProviderGuide>} */
const GUIDES = {
  openrouter: { id: 'openrouter', url: 'openrouter.ai/settings/keys', hint: 'sk-or-v1-…', steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  orcarouter: { id: 'orcarouter', url: 'www.orcarouter.ai/console', hint: 'sk-orca-…', steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  google: { id: 'google', url: 'aistudio.google.com/apikey', hint: 'AIza…', steps: ['open', 'signin', 'create', 'copy', 'paste'] },
};
const ORDER = ['openrouter', 'orcarouter', 'google'];
const NAMES = { openrouter: 'OpenRouter', orcarouter: 'OrcaRouter', google: 'Google Gemini' };

/** How long each picture stays up on its own. */
const STEP_MS = 4200;

/** Every key in what was pasted: one a line, or separated by spaces or commas. */
export const keysIn = (text) => [...new Set(String(text || '').split(/[\s,;]+/).map((key) => key.trim()).filter(Boolean))];

/** Which provider the top free suggestion runs on. Auto is OpenRouter's router. */
export function providerOfModel(id) {
  if (!id) return null;
  if (id === 'auto') return 'openrouter';
  const provider = String(id).split('/')[0];
  return Object.hasOwn(GUIDES, provider) ? provider : null;
}

/** The providers in the order offered: the suggested one first. */
export function providerOrder(recommended) {
  const first = providerOfModel(recommended?.free?.id) || 'openrouter';
  return [first, ...ORDER.filter((id) => id !== first)];
}

/**
 * @param {{ providers: () => Record<string, any>, recommended: () => any,
 *   addKey: (provider: string, key: string) => Promise<any>, onSaved: () => void }} deps
 */
export function createKeyGuide({ providers, recommended, addKey, onSaved }) {
  /** The provider chosen. Null until somebody presses one: then it follows the suggestion. */
  let picked = null;
  let at = 0;
  let timer = 0;
  /** Held on a step by being pointed at, or by choosing it: a moving guide must stop when asked (WCAG 2.2.2). */
  let held = false;
  /** @type {HTMLElement | null} */
  let host = null;
  /** The last paste's outcome, one line a key, until the next. */
  let lines = [];
  let busy = false;

  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const current = () => picked || providerOrder(recommended())[0];

  function stop() {
    clearTimeout(timer);
    timer = 0;
  }

  function schedule() {
    stop();
    if (held || still() || !host?.isConnected) return;
    timer = window.setTimeout(() => {
      const guide = GUIDES[current()];
      at = (at + 1) % guide.steps.length;
      paintStep();
      schedule();
    }, STEP_MS);
  }

  /** A drawing of what the page has on it, with the thing to look for lit. */
  function picture(guide, step) {
    const bar = (address) => `<div class="onbk__bar"><span class="onbk__dots" aria-hidden="true"></span><span class="onbk__url">${escapeHtml(address)}</span></div>`;
    const name = NAMES[guide.id];
    if (step === 'open') {
      return `<div class="onbk__page onbk__page--here">${bar('synapsez')}<div class="onbk__pad"><div class="onbk__line onbk__line--wide"></div><span class="onbk__fake is-lit">${escapeHtml(t('onb.keys.get', { provider: name }))} ↗</span></div></div>`;
    }
    if (step === 'signin') {
      return `<div class="onbk__page">${bar(guide.url)}<div class="onbk__pad onbk__pad--center"><strong>${escapeHtml(name)}</strong><span class="onbk__fake is-lit">${escapeHtml(t('onb.keys.draw.signin'))}</span><div class="onbk__line"></div></div></div>`;
    }
    if (step === 'create') {
      return `<div class="onbk__page">${bar(guide.url)}<div class="onbk__pad"><strong>API keys</strong><span class="onbk__field">${escapeHtml(t('onb.keys.draw.name'))}: Synapsez</span><span class="onbk__fake is-lit">${escapeHtml(t(`onb.keys.draw.create.${guide.id}`))}</span></div></div>`;
    }
    if (step === 'copy') {
      return `<div class="onbk__page">${bar(guide.url)}<div class="onbk__pad"><strong>${escapeHtml(t('onb.keys.draw.yourKey'))}</strong><span class="onbk__key">${escapeHtml(guide.hint)}••••••••••••<span class="onbk__fake is-lit">${escapeHtml(t('onb.keys.draw.copy'))}</span></span></div></div>`;
    }
    return `<div class="onbk__page onbk__page--here">${bar('synapsez')}<div class="onbk__pad"><span class="onbk__field onbk__field--tall is-lit">${escapeHtml(guide.hint)}••••<br />${escapeHtml(guide.hint)}••••</span></div></div>`;
  }

  function paintStep() {
    if (!host) return;
    const guide = GUIDES[current()];
    const step = guide.steps[at];
    const box = host.querySelector('.onbk__shot');
    if (box) {
      box.innerHTML = `${picture(guide, step)}<p class="onbk__sample">${escapeHtml(t('onb.keys.sample'))}</p>`;
    }
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-key-step]'))) {
      const on = Number(row.dataset.keyStep) === at;
      row.classList.toggle('is-at', on);
      if (on) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
    }
  }

  function outcomeHtml() {
    return lines.length ? `<ul class="onbk__results">${lines.map((line) => `<li class="${line.ok ? 'is-ok' : 'is-bad'}">${escapeHtml(line.text)}</li>`).join('')}</ul>` : '';
  }

  /** @param {string} text */
  async function take(text) {
    const keys = keysIn(text);
    if (!keys.length || busy) return;
    busy = true;
    lines = [];
    const provider = current();
    for (const key of keys) {
      const tail = key.slice(-4);
      try {
        const { saved } = await addKey(provider, key);
        const where = saved.kind === 'service' ? saved.id : NAMES[saved.id] || saved.id;
        lines.push({ ok: true, text: t(saved.moved ? 'onb.keys.moved' : 'onb.keys.saved', { tail, where }) });
      } catch (err) {
        lines.push({ ok: false, text: t('onb.keys.refused', { tail, why: err.message }) });
      }
    }
    busy = false;
    // Whatever was refused stays in the box to be looked at; what went in does not.
    const refused = lines.some((line) => !line.ok);
    const box = /** @type {HTMLTextAreaElement | null} */ (host?.querySelector('[data-key-box]'));
    if (box && !refused) box.value = '';
    onSaved();
  }

  function paint() {
    if (!host) return;
    const order = providerOrder(recommended());
    const chosen = current();
    const guide = GUIDES[chosen];
    const status = providers() || {};
    host.innerHTML = `<div class="onbk">
        <div class="onbk__choose" role="radiogroup" aria-label="${escapeHtml(t('onb.keys.which'))}">
          ${order
            .map((id, i) => {
              const held_ = (status[id]?.keys || []).length;
              return `<button type="button" class="onbk__card${id === chosen ? ' is-on' : ''}" role="radio" aria-checked="${id === chosen}" data-key-provider="${id}">
                <strong>${escapeHtml(NAMES[id])}</strong>
                <span class="onbk__why">${escapeHtml(t(i === 0 ? 'onb.keys.suggested' : `onb.keys.about.${id}`))}</span>
                ${held_ ? `<span class="onb__badge">${escapeHtml(t('onb.keys.held', { n: held_ }))}</span>` : ''}
              </button>`;
            })
            .join('')}
        </div>
        <div class="onbk__how">
          <ol class="onbk__steps">
            ${guide.steps.map((step, i) => `<li><button type="button" data-key-step="${i}" class="onbk__step"><span class="onbk__n">${i + 1}</span><span>${escapeHtml(t(`onb.keys.step.${step}.${guide.id}`))}</span></button></li>`).join('')}
          </ol>
          <div class="onbk__shot" aria-hidden="true"></div>
        </div>
        <div class="onbk__do">
          <a class="btn btn--primary" href="https://${guide.url}" target="_blank" rel="noopener" data-key-get>${escapeHtml(t('onb.keys.get', { provider: NAMES[chosen] }))} ↗</a>
        </div>
        <label class="onbk__paste"><span>${escapeHtml(t('onb.keys.pasteLabel'))}</span>
          <textarea class="onbk__box" data-key-box rows="3" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(guide.hint)}"></textarea>
        </label>
        <div class="onbk__do"><button type="button" class="btn" data-key-add>${escapeHtml(t('onb.keys.add'))}</button></div>
        <div data-key-outcome>${outcomeHtml()}</div>
      </div>`;
    paintStep();
    schedule();
  }

  /** Whatever this guide is listening with goes with the host it was drawn into. */
  function listen() {
    host.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const card = /** @type {HTMLElement | null} */ (target.closest('[data-key-provider]'));
      if (card) {
        picked = card.dataset.keyProvider;
        at = 0;
        held = false;
        lines = [];
        paint();
        return;
      }
      const step = /** @type {HTMLElement | null} */ (target.closest('[data-key-step]'));
      if (step) {
        at = Number(step.dataset.keyStep);
        held = true;
        stop();
        paintStep();
        return;
      }
      if (target.closest('[data-key-get]')) {
        // Off to the provider's page: the step they are now on is the one to read when they come back.
        at = 1;
        held = true;
        stop();
        paintStep();
        return;
      }
      if (target.closest('[data-key-add]')) void take(/** @type {HTMLTextAreaElement} */ (host.querySelector('[data-key-box]')).value);
    });
    host.addEventListener('paste', (event) => {
      if (!/** @type {HTMLElement} */ (event.target).matches?.('[data-key-box]')) return;
      at = GUIDES[current()].steps.length - 1;
      held = true;
      stop();
      paintStep();
    });
    const hold = (on) => {
      held = on;
      if (on) stop();
      else schedule();
    };
    host.addEventListener('pointerenter', () => hold(true));
    host.addEventListener('pointerleave', () => hold(false));
    host.addEventListener('focusin', () => hold(true));
  }

  return {
    /** Draw into the guide's step. @param {HTMLElement} element */
    mount(element) {
      stop();
      host = element;
      listen();
      paint();
    },
    leave() {
      stop();
      host = null;
      lines = [];
    },
  };
}
