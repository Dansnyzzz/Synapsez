import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';

const PLAY_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 4.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5.5 4.5h3v11h-3zM11.5 4.5h3v11h-3z" fill="currentColor"/></svg>';

/**
 * Getting a key, step by step, inside the guide (owner, 2026-11-06).
 *
 * Which provider first: the one the best free model runs on right now, read from the
 * administrators' suggestion each time the step is drawn, so it moves when they change
 * it. Then what to do there, from pressing the button that opens its page to the key
 * pasted back here, where one box takes as many keys as are pasted into it.
 *
 * Above the steps plays a recording of the real provider page, made on 2026-11-16 with
 * everything personal blurred (public/onboarding/keys/). It replaces the drawings this
 * had: they had drifted from the pages, and a recording shows what to look for rather
 * than what somebody once believed it would be. A page changes without notice, so the
 * caption says when it was made, and the steps are words as well, for the day it no
 * longer matches. One file serves both languages: OpenRouter's site has only English,
 * Google's and OrcaRouter's were recorded in Vietnamese.
 *
 * @typedef {{ id: string, url: string, hint: string, width: number, height: number, steps: string[] }} ProviderGuide
 */

/** @type {Record<string, ProviderGuide>} */
const GUIDES = {
  openrouter: { id: 'openrouter', url: 'openrouter.ai/settings/keys', hint: 'sk-or-v1-…', width: 1280, height: 656, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  orcarouter: { id: 'orcarouter', url: 'www.orcarouter.ai/console', hint: 'sk-orca-…', width: 1280, height: 712, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  google: { id: 'google', url: 'aistudio.google.com/apikey', hint: 'AIza…', width: 1280, height: 656, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
};
const ORDER = ['openrouter', 'orcarouter', 'google'];
const NAMES = { openrouter: 'OpenRouter', orcarouter: 'OrcaRouter', google: 'Google Gemini' };

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
  /** @type {HTMLElement | null} */
  let host = null;
  /** What was refused last time, back in the box when it is drawn again. */
  let keepInBox = '';
  /** The last paste's outcome, one line a key, until the next. */
  let lines = [];
  let busy = false;

  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The person paused the clip: it stays paused until they play it, whichever provider is shown. */
  let paused = false;
  const current = () => picked || providerOrder(recommended())[0];

  /** The recording of this provider's page, its still frame first, and a caption that dates it. */
  function clipHtml(guide) {
    const base = `/onboarding/keys/${guide.id}`;
    const name = NAMES[guide.id];
    return `<figure class="onbk__clip">
        <div class="onbk__video">
          <video muted loop playsinline preload="metadata" poster="${base}.jpg" src="${base}.webm" width="${guide.width}" height="${guide.height}" aria-label="${escapeHtml(t('onb.keys.clipLabel', { provider: name }))}"></video>
          <button type="button" class="onb__play" data-key-play></button>
        </div>
        <figcaption class="onbk__sample">${escapeHtml(t('onb.keys.clip', { provider: name }))}</figcaption>
      </figure>`;
  }

  function paintPlay() {
    const video = /** @type {HTMLVideoElement | null | undefined} */ (host?.querySelector('.onbk__video video'));
    const button = host?.querySelector('[data-key-play]');
    if (!video || !button) return;
    const playing = !video.paused;
    button.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    button.setAttribute('aria-label', t(playing ? 'onb.video.pause' : 'onb.video.play'));
    button.setAttribute('title', t(playing ? 'onb.video.pause' : 'onb.video.play'));
  }

  /** Which step is marked in the list: the one last pressed, as a place to keep. */
  function paintStep() {
    if (!host) return;
    for (const row of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-key-step]'))) {
      const on = Number(row.dataset.keyStep) === at;
      row.classList.toggle('is-at', on);
      if (on) row.setAttribute('aria-current', 'step');
      else row.removeAttribute('aria-current');
    }
  }

  /** Plays by itself, unless motion is unwelcome: then the still frame waits behind a play button (WCAG 2.2.2). */
  function startClip() {
    const video = /** @type {HTMLVideoElement | null} */ (host?.querySelector('.onbk__video video'));
    if (!video) return;
    video.addEventListener('play', paintPlay);
    video.addEventListener('pause', paintPlay);
    // A clip that will not load leaves the words, which say everything.
    video.addEventListener('error', () => {
      video.closest('.onbk__clip')?.setAttribute('hidden', '');
    });
    if (!paused && !still()) video.play().catch(() => paintPlay());
    paintPlay();
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
    // Whatever was refused stays in the box to be looked at, past the redraw; what went in does not.
    keepInBox = keys.filter((_key, i) => !lines[i].ok).join('\n');
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
          ${clipHtml(guide)}
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
    // Put back as a value, never in the markup: a key does not belong in an attribute or the page's HTML.
    /** @type {HTMLTextAreaElement} */ (host.querySelector('[data-key-box]')).value = keepInBox;
    paintStep();
    startClip();
  }

  /** Whatever this guide is listening with goes with the host it was drawn into. */
  function listen() {
    host.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const card = /** @type {HTMLElement | null} */ (target.closest('[data-key-provider]'));
      if (card) {
        picked = card.dataset.keyProvider;
        at = 0;
        keepInBox = '';
        lines = [];
        paint();
        return;
      }
      const step = /** @type {HTMLElement | null} */ (target.closest('[data-key-step]'));
      if (step) {
        at = Number(step.dataset.keyStep);
        paintStep();
        return;
      }
      if (target.closest('[data-key-play]')) {
        const video = /** @type {HTMLVideoElement | null} */ (host.querySelector('.onbk__video video'));
        if (!video) return;
        paused = !video.paused;
        if (paused) video.pause();
        else video.play().catch(() => paintPlay());
        return;
      }
      if (target.closest('[data-key-get]')) {
        // Off to the provider's page: the step they are now on is the one to read when they come back.
        at = 1;
        paintStep();
        return;
      }
      if (target.closest('[data-key-add]')) void take(/** @type {HTMLTextAreaElement} */ (host.querySelector('[data-key-box]')).value);
    });
    host.addEventListener('paste', (event) => {
      if (!/** @type {HTMLElement} */ (event.target).matches?.('[data-key-box]')) return;
      at = GUIDES[current()].steps.length - 1;
      paintStep();
    });
  }

  return {
    /** Draw into the guide's step. @param {HTMLElement} element */
    mount(element) {
      host = element;
      listen();
      paint();
    },
    leave() {
      /** @type {HTMLVideoElement | null | undefined} */ (host?.querySelector('.onbk__video video'))?.pause();
      host = null;
      lines = [];
    },
  };
}
