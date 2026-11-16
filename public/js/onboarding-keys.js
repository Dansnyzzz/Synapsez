import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { looksLikeKey, looksWhole } from './key-shapes.js';
import { hintText } from './key-hint.js';
import { CONNECTOR_BY_ID } from './connector-catalog.js';

const PLAY_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 4.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5.5 4.5h3v11h-3zM11.5 4.5h3v11h-3z" fill="currentColor"/></svg>';

/**
 * Getting a key, step by step, inside the guide (owner, 2026-11-06).
 *
 * Which provider first: the one the best free model runs on right now, read from the
 * administrators' suggestion each time the step is drawn, so it moves when they change
 * it. Then what to do there, from pressing the button that opens its page to the key
 * pasted back here, one key to a box: it is checked the moment it is pasted, locked when it
 * is kept, and a fresh box opens for the next. A refused key stays in its box, red, with the
 * provider's own reason, so it can be fixed in place.
 *
 * Above the steps plays a recording of the real provider page, made on 2026-11-16 with
 * everything personal blurred (public/onboarding/keys/). It replaces the drawings this
 * had: they had drifted from the pages, and a recording shows what to look for rather
 * than what somebody once believed it would be. A page changes without notice, so the
 * caption says when it was made, and the steps are words as well, for the day it no
 * longer matches. One file serves both languages: OpenRouter's site has only English,
 * Google's and OrcaRouter's were recorded in Vietnamese.
 *
 * @typedef {{ id: number, key: string, state: 'idle' | 'checking' | 'ok' | 'bad', tail: string, text: string, extra: string, timer: ReturnType<typeof setTimeout> | null }} KeyRow
 * @typedef {{ id: string, url: string, hint: string, width: number, height: number, steps: string[] }} ProviderGuide
 */

/** @type {Record<string, ProviderGuide>} */
const GUIDES = {
  openrouter: { id: 'openrouter', url: 'openrouter.ai/settings/keys', hint: 'sk-or-v1-…', width: 1280, height: 656, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  orcarouter: { id: 'orcarouter', url: 'www.orcarouter.ai/console', hint: 'sk-orca-…', width: 1280, height: 712, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
  google: { id: 'google', url: 'aistudio.google.com/apikey', hint: 'AIza… or AQ.…', width: 1280, height: 656, steps: ['open', 'signin', 'create', 'copy', 'paste'] },
};
/** How long a typed key may sit before it is checked: long enough to type a few more characters. */
const TYPING_PAUSE = 900;
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
  let rowIds = 0;
  /**
   * The boxes, in order: kept keys (locked) and the one being filled. The state lives here, not
   * in the page, because keeping a key redraws the whole step. A key sits in a row only until it
   * is kept: a locked row holds the last four characters and nothing more.
   * @type {KeyRow[]}
   */
  let rows = [blankRow()];

  /** Counts the boxes drawn afresh (another provider, leaving the step): an answer from before is no longer wanted. */
  let epoch = 0;
  /**
   * One announcer for the whole step, outside what is redrawn, so a result is heard however the step repaints.
   * @type {HTMLElement | null}
   */
  let live = null;

  /** @returns {KeyRow} */
  function blankRow() {
    rowIds += 1;
    return { id: rowIds, key: '', state: 'idle', tail: '', text: '', extra: '', timer: null };
  }

  function resetRows() {
    epoch += 1;
    for (const row of rows) clearTimeout(row.timer);
    rows = [blankRow()];
  }

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

  /** The line under a box: what is happening to its key, or what became of it. */
  function noteHtml(row) {
    const extra = row.extra ? ` ${escapeHtml(row.extra)}` : '';
    if (row.state === 'checking') return escapeHtml(t('onb.keys.checking'));
    if (row.state === 'ok') return `<span aria-hidden="true">✓</span> ${escapeHtml(row.text)}${extra}`;
    if (row.state === 'bad') return `${escapeHtml(row.text)}${extra}`;
    return extra.trim();
  }

  function rowHtml(row, n) {
    const locked = row.state === 'ok';
    const mode = locked ? 'data-key-done readonly' : `data-key-box placeholder="${escapeHtml(hintText(GUIDES[current()].hint))}"`;
    // Never read-only while it checks: a person typing on keeps their keystrokes.
    const flags = (row.state === 'bad' ? ' aria-invalid="true"' : '') + (row.state === 'checking' ? ' aria-busy="true"' : '');
    return `<li class="onbk__row is-${row.state}" data-key-row="${row.id}">
        <label for="onbk-key-${row.id}">${escapeHtml(t('onb.keys.boxLabel', { n }))}</label>
        <input id="onbk-key-${row.id}" class="onbk__box" type="text" spellcheck="false" autocomplete="off" ${mode} aria-describedby="onbk-note-${row.id} onbk-rule"${flags} />
        <p class="onbk__note" id="onbk-note-${row.id}">${noteHtml(row)}</p>
      </li>`;
  }

  /** Values go in as properties, never into the markup: a key does not belong in the page's HTML. */
  function paintRows() {
    const list = host?.querySelector('[data-key-rows]');
    if (!list) return;
    list.innerHTML = rows.map((row, i) => rowHtml(row, i + 1)).join('');
    for (const row of rows) {
      const input = /** @type {HTMLInputElement | null} */ (list.querySelector(`[data-key-row="${row.id}"] input`));
      if (input) input.value = row.state === 'ok' ? `…${row.tail}` : row.key;
    }
  }

  /** Redraw one row's state around its input, without replacing the input the person is typing in. */
  function paintRow(row) {
    const item = host?.querySelector(`[data-key-row="${row.id}"]`);
    const input = /** @type {HTMLInputElement | null | undefined} */ (item?.querySelector('input'));
    if (!item || !input) return;
    item.className = `onbk__row is-${row.state}`;
    if (row.state === 'bad') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    if (row.state === 'checking') input.setAttribute('aria-busy', 'true');
    else input.removeAttribute('aria-busy');
    const note = item.querySelector('.onbk__note');
    if (note) note.innerHTML = noteHtml(row);
  }

  /** Said once, politely: the region is emptied first so the same words twice are still heard. */
  function announce(text) {
    if (!live) return;
    const region = live;
    region.textContent = '';
    setTimeout(() => {
      region.textContent = text;
    }, 60);
  }

  const focusBox = () => /** @type {HTMLInputElement | null | undefined} */ (host?.querySelector('[data-key-box]:not([readonly])'))?.focus();

  /** Check one box's key with the server, which also moves it to its own provider by its shape. */
  async function check(row) {
    clearTimeout(row.timer);
    const key = row.key.trim();
    if (!key || row.state === 'checking' || row.state === 'ok') return;
    const provider = current();
    row.state = 'checking';
    row.text = '';
    paintRow(row);
    announce(t('onb.keys.checking'));
    const turn = epoch;
    try {
      const { saved } = await addKey(provider, key);
      // Another provider chosen, or the step left, or the box changed since: this answer is about
      // something no longer on screen. A changed box is looked at again as it now stands.
      if (turn !== epoch) return;
      if (row.key.trim() !== key) return settle(row);
      const where = saved.kind === 'service' ? CONNECTOR_BY_ID.get(saved.id)?.name || saved.id : NAMES[saved.id] || saved.id;
      row.state = 'ok';
      row.tail = key.slice(-4);
      row.key = '';
      row.text = saved.moved ? t(/^[AEIOU]/i.test(where) ? 'onb.keys.movedAn' : 'onb.keys.movedA', { where }) : t('onb.keys.added');
      if (row === rows[rows.length - 1]) rows.push(blankRow());
      // Keeping a key redraws the step (its "done" line, the card's count); the rows come back from here.
      onSaved();
      focusBox();
      announce(row.extra ? `${row.text}. ${row.extra}` : row.text);
    } catch (err) {
      if (turn !== epoch) return;
      if (row.key.trim() !== key) return settle(row);
      row.state = 'bad';
      row.text = err.message;
      paintRow(row);
      announce(row.extra ? `${err.message} ${row.extra}` : err.message);
    }
  }

  /** A check whose key was edited meanwhile: back to idle, and the edit checked when it looks whole. */
  function settle(row) {
    row.state = 'idle';
    paintRow(row);
    if (looksWhole(row.key)) void check(row);
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
        <ul class="onbk__keys" data-key-rows></ul>
        <p class="onbk__rule" id="onbk-rule">${escapeHtml(t('onb.keys.rule'))}</p>
      </div>`;
    paintRows();
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
        resetRows();
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
    });
    const rowOf = (target) => rows.find((row) => String(row.id) === target.closest?.('[data-key-row]')?.dataset.keyRow);
    host.addEventListener('paste', (event) => {
      const target = /** @type {HTMLInputElement} */ (event.target);
      const row = target.matches?.('[data-key-box]') ? rowOf(target) : null;
      if (!row) return;
      at = GUIDES[current()].steps.length - 1;
      paintStep();
      // A paste is a finished key: checked now, with no button to press.
      const parts = keysIn(/** @type {ClipboardEvent} */ (event).clipboardData?.getData('text'));
      if (!parts.length || row.state === 'checking') return;
      event.preventDefault();
      // "Key: sk-or-..." is a label and a key: the first part that looks like one, else the first.
      const keyLike = parts.filter(looksLikeKey);
      const taken = keyLike[0] || parts[0];
      target.value = row.key = taken;
      row.extra = keyLike.length > 1 || (!keyLike.length && parts.length > 1) ? t('onb.keys.onlyFirst') : '';
      void check(row);
    });
    host.addEventListener('input', (event) => {
      const target = /** @type {HTMLInputElement} */ (event.target);
      const row = target.matches?.('[data-key-box]') ? rowOf(target) : null;
      if (!row || row.state === 'ok') return;
      row.key = target.value;
      row.extra = '';
      // Typing again clears the red: it is a new key. Checked after a pause, in case more is coming.
      if (row.state === 'bad') {
        row.state = 'idle';
        row.text = '';
        paintRow(row);
      }
      clearTimeout(row.timer);
      // Only a key that looks whole is worth a check on a pause; Enter checks anything.
      if (looksWhole(row.key)) row.timer = setTimeout(() => void check(row), TYPING_PAUSE);
    });
    host.addEventListener('keydown', (event) => {
      const target = /** @type {HTMLInputElement} */ (event.target);
      if (event.key !== 'Enter' || !target.matches?.('[data-key-box]')) return;
      const row = rowOf(target);
      if (!row) return;
      event.preventDefault();
      row.key = target.value;
      void check(row);
    });
  }

  return {
    /** Draw into the guide's step. @param {HTMLElement} element */
    mount(element) {
      host = element;
      if (!live) {
        live = document.createElement('div');
        live.className = 'sr-only';
        live.setAttribute('data-key-live', '');
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
      }
      // In the dialog, which is modal: what sits outside it is not read. It outlives each redraw of the step.
      const home = element.closest('dialog') || document.body;
      if (live.parentElement !== home) home.append(live);
      listen();
      paint();
    },
    leave() {
      /** @type {HTMLVideoElement | null | undefined} */ (host?.querySelector('.onbk__video video'))?.pause();
      host = null;
      resetRows();
    },
  };
}
