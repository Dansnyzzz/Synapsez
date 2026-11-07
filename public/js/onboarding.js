import { t, applyI18n, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { createKeyGuide } from './onboarding-keys.js';

/**
 * The six-step guide a new account is shown once (rebuilt 2026-10-20).
 *
 * Built for somebody who is not a developer, which changes what belongs in it.
 * Not a feature tour — the things that decide whether a new account works, in
 * the order they come up:
 *
 *   1. what this is, so the rest has somewhere to land
 *   2. an API key, without which nothing answers at all: which provider, then every
 *      step from its page to the key pasted here (onboarding-keys.js)
 *   3. the model suggested for those keys and what "free" really allows, because that
 *      is where people stall
 *   4. the cloud computer, which is where real work runs
 *   5. the five levels of freedom, because the first approval prompt is otherwise a fright
 *   6. one real task, because reading about it teaches nobody
 *
 * **Every sentence is true of this app** (owner, 2026-10-20: "minh bạch, chính
 * xác, thực tế 100%"). The one before said free models were fixed by paying,
 * listed three of five levels, promised work "on your computer" after pairing
 * had left the interface, and said a suggestion ran when it is only put in the
 * box. The facts it states are pinned to the code in test/features.
 *
 * Steps 2 and 3 are done here rather than shown: their clip used to be somebody typing
 * a key one character at a time and a list of every model (owner, 2026-11-06). The
 * others have a short clip recorded from the app itself — an illustration,
 * never the only place something is said. Only the current step's clip plays,
 * it can always be paused (WCAG 2.2.2), and with reduced motion it waits to be
 * asked.
 *
 * Three rules it keeps from the guide before it:
 *
 *   **Skippable at every step, and skipping means skipped.**
 *   **Never over a question** — the model announcement is also a modal.
 *   **Step 2 marks itself done** when the account has a key.
 */

const TOTAL = 6;

const PLAY_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 4.5v11l9-5.5z" fill="currentColor"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5.5 4.5h3v11h-3zM11.5 4.5h3v11h-3z" fill="currentColor"/></svg>';

/**
 * @param {{
 *   providers: () => Record<string, { configured?: boolean, keys?: any[] }>,
 *   isFree: () => boolean,
 *   policies?: () => { id: string, label: string, hint: string }[],
 *   defaultPolicy?: string,
 *   recommended: () => any,
 *   suggestion: () => any,
 *   currentModel: () => string,
 *   addKey: (provider: string, key: string) => Promise<any>,
 *   useModel: (id: string) => Promise<any> | void,
 *   onTryPrompt: (text: string) => void,
 *   onFinish: () => void,
 * }} deps
 */
export function createOnboarding({ providers, addKey, useModel, recommended, suggestion, currentModel, onTryPrompt, onFinish, isFree, policies = () => [], defaultPolicy = 'guarded' }) {
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('onboarding'));
  const stepLabel = document.getElementById('onb-step');
  const steps = document.getElementById('onb-steps');
  const media = document.getElementById('onb-media');
  const video = /** @type {HTMLVideoElement} */ (document.getElementById('onb-video'));
  const play = document.getElementById('onb-play');
  const body = document.getElementById('onb-body');
  const back = document.getElementById('onb-back');
  const next = document.getElementById('onb-next');
  const skip = document.getElementById('onb-skip');

  let step = 1;
  /** The person paused the clip: it stays paused from step to step until they play it. */
  let paused = false;
  /** Clips that would not load, so coming back to their step does not show an empty frame. */
  const broken = new Set();
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Does this account already have a key anywhere? Step 2 turns on this. */
  const hasKey = () => Object.values(providers() || {}).some((p) => p?.configured);

  const keyGuide = createKeyGuide({ providers, recommended, addKey, onSaved: () => render() });

  const li = (key) => `<li>${escapeHtml(t(key))}</li>`;
  const p = (key, className = '') => `<p${className ? ` class="${className}"` : ''}>${escapeHtml(t(key))}</p>`;

  /**
   * The six steps by name — a way to jump as well as a sense of how far there
   * is to go. A short name each: the full titles were cut to "Synapsez là…" in
   * a sixth of the sheet (owner, 2026-10-26). The short name is the button's
   * name, so "click Autonomy" finds it by voice (WCAG 2.5.3); the full title
   * heads the step below, and is the button's description on hover.
   */
  function paintSteps() {
    steps.innerHTML = Array.from({ length: TOTAL }, (_, i) => {
      const n = i + 1;
      const state = n === step ? ' is-current' : n < step ? ' is-done' : '';
      return `<li class="onb__dot${state}"><button type="button" data-step="${n}"${n === step ? ' aria-current="step"' : ''} title="${escapeHtml(t(`onb.${n}.title`))}">
        <span class="onb__dot-n" aria-hidden="true">${n < step ? '✓' : n}</span><span class="onb__dot-label">${escapeHtml(t(`onb.${n}.tab`))}</span></button></li>`;
    }).join('');
  }

  /** This step's clip, in the interface's language; its still frame shows at once. */
  function paintMedia() {
    // Done here rather than watched, so there is nothing to show above them.
    if (step === 2 || step === 3) {
      video.pause();
      media.hidden = true;
      return;
    }
    const lang = currentLanguage() === 'vi' ? 'vi' : 'en';
    const clip = `/onboarding/${lang}/step-${step}`;
    media.hidden = broken.has(clip);
    if (video.dataset.clip !== clip) {
      video.dataset.clip = clip;
      video.poster = `${clip}.jpg`;
      video.src = `${clip}.webm`;
    }
    video.setAttribute('aria-label', t('onb.video.label', { title: t(`onb.${step}.title`) }));
    if (dialog.open && !paused && !still()) video.play().catch(() => paintPlay());
    else video.pause();
    paintPlay();
  }

  function paintPlay() {
    const playing = !video.paused;
    play.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    play.setAttribute('aria-label', t(playing ? 'onb.video.pause' : 'onb.video.play'));
    play.title = t(playing ? 'onb.video.pause' : 'onb.video.play');
    // The label already says what a press does; aria-pressed as well would
    // announce "Pause, pressed" for a clip that is playing (UI-007).
  }

  /**
   * The models suggested for this account, and nothing else to choose between
   * (owner, 2026-11-06). Two free ones for everybody: the first is used, the second
   * takes over when it runs out or stops answering. Somebody whose key has paid for
   * credit is also offered the best paid one; pressing it is their decision.
   */
  function modelCards() {
    if (!hasKey()) return `<div class="onb__tip"><p>${escapeHtml(t('onb.3.needKey'))}</p><button class="btn btn--primary btn--small" type="button" data-to-keys>${escapeHtml(t('onb.3.toKeys'))}</button></div>`;
    const rec = recommended() || {};
    const funded = !!suggestion()?.funded;
    const current = currentModel();
    const card = (model, kind) => {
      if (!model) return '';
      const on = current === model.id;
      return `<li class="onb__model${on ? ' is-on' : ''}" data-kind="${kind}">
          <div class="onb__model-text">
            <span class="onb__model-role">${escapeHtml(t(`onb.3.role.${kind}`))}</span>
            <strong>${escapeHtml(model.id === 'auto' ? t('models.autoName') : model.label)}</strong>
            <span class="onb__model-why">${escapeHtml(t(`onb.3.why.${kind}`))}</span>
          </div>
          ${on ? `<span class="onb__badge">${escapeHtml(t('onb.3.inUse'))}</span>` : `<button class="btn btn--small${kind === 'paid' ? ' btn--ghost' : ''}" type="button" data-use-model="${escapeHtml(model.id)}">${escapeHtml(t('onb.3.use'))}</button>`}
        </li>`;
    };
    return `<ul class="onb__models">${card(rec.free, 'first')}${card(rec.freeSecond, 'second')}${funded ? card(rec.paid, 'paid') : ''}</ul>`;
  }

  function render() {
    stepLabel.textContent = t('onb.step', { n: step, total: TOTAL });
    back.hidden = step === 1;
    paintSteps();

    if (step === 1) {
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.1.title'))}</h3>
        ${p('onb.1.body')}
        <ul class="onb__list">${li('onb.1.a')}${li('onb.1.b')}${li('onb.1.c')}${li('onb.1.d')}</ul>
        ${p('onb.1.note', 'hint')}`;
    } else if (step === 2) {
      const ready = hasKey();
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.2.title'))}</h3>
        ${p('onb.2.body')}
        <div id="onb-key-guide"></div>
        <p class="onb__state ${ready ? 'is-done' : 'is-todo'}">${escapeHtml(t(ready ? 'onb.2.done' : 'onb.2.pending'))}</p>
        ${p('onb.2.many', 'hint')}
        ${p('onb.2.safety', 'hint')}`;
      keyGuide.mount(/** @type {HTMLElement} */ (body.querySelector('#onb-key-guide')));
    } else if (step === 3) {
      const free = isFree();
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.3.title'))}</h3>
        ${modelCards()}
        <p class="onb__state ${free ? 'is-free' : 'is-done'}">${escapeHtml(t(free ? 'onb.3.free' : 'onb.3.paid'))}</p>
        <ul class="onb__tip onb__facts">${li('onb.3.limits')}${li('onb.3.keys')}${li('onb.3.fallback')}${li('onb.3.gemini')}</ul>
        ${p('onb.3.note', 'hint')}`;
      for (const button of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-use-model]'))) {
        button.addEventListener('click', async () => {
          await useModel(button.dataset.useModel);
          render();
        });
      }
      body.querySelector('[data-to-keys]')?.addEventListener('click', () => go(2));
    } else if (step === 4) {
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.4.title'))}</h3>
        ${p('onb.4.body')}
        <ul class="onb__list">${li('onb.4.a')}${li('onb.4.b')}${li('onb.4.c')}</ul>
        ${p('onb.4.limit', 'hint')}`;
    } else if (step === 5) {
      // The levels as the menu itself names and describes them, so the guide and
      // the button beside Send can never disagree.
      const levels = policies()
        .map(
          (level) =>
            `<li class="onb__level"><strong>${escapeHtml(level.label)}</strong>${
              level.id === defaultPolicy ? ` <span class="onb__badge">${escapeHtml(t('onb.5.default'))}</span>` : ''
            } — ${escapeHtml(level.hint)}</li>`,
        )
        .join('');
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.5.title'))}</h3>
        ${p('onb.5.body')}
        <ul class="onb__list onb__levels">${levels}</ul>
        ${p('onb.5.honest', 'onb__tip')}`;
    } else {
      const tries = [1, 2, 3, 4, 5, 6].map((n) => `onb.6.try${n}`);
      body.innerHTML = `
        <h3 class="onb__title">${escapeHtml(t('onb.6.title'))}</h3>
        ${p('onb.6.body')}
        <div class="onb__tries">
          ${tries.map((key) => `<button class="onb__try" type="button" data-key="${key}">${escapeHtml(t(key))}</button>`).join('')}
        </div>
        ${p('onb.6.note', 'hint')}`;
      for (const btn of body.querySelectorAll('.onb__try')) {
        btn.addEventListener('click', () => {
          // Closes the guide and puts the sentence in the box — not sent: the
          // person reads it, changes it if they like, and sends it themselves.
          finish();
          onTryPrompt(t(/** @type {HTMLElement} */ (btn).dataset.key));
        });
      }
    }

    applyI18n(dialog);
    // After the dialog's own strings, or its `data-i18n` puts "Continue" back on
    // the last step's button.
    next.textContent = step === TOTAL ? t('onb.6.finish') : t('action.next');
    paintMedia();
  }

  function go(to) {
    step = Math.min(Math.max(1, to), TOTAL);
    keyGuide.leave();
    render();
  }

  function finish() {
    keyGuide.leave();
    video.pause();
    if (dialog.open) dialog.close();
    onFinish();
  }

  // A clip that will not load leaves the step as it is: the text says it all.
  video.addEventListener('error', () => {
    if (video.dataset.clip) broken.add(video.dataset.clip);
    media.hidden = true;
  });
  video.addEventListener('play', paintPlay);
  video.addEventListener('pause', paintPlay);
  play.addEventListener('click', () => {
    if (video.paused) {
      paused = false;
      video.play().catch(() => paintPlay());
    } else {
      paused = true;
      video.pause();
    }
  });

  steps.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target).closest?.('[data-step]');
    if (target) go(Number(/** @type {HTMLElement} */ (target).dataset.step));
  });
  back.addEventListener('click', () => go(step - 1));
  next.addEventListener('click', () => (step === TOTAL ? finish() : go(step + 1)));
  skip.addEventListener('click', finish);

  /*
   * ← and → turn the pages, unless somebody is typing. Heard on the document,
   * not the dialog: after a key is saved from step 2 the button that opened the
   * settings is gone, so closing them leaves focus on the page body — and the
   * arrows went nowhere. A key pressed inside another dialog is that dialog's.
   */
  document.addEventListener('keydown', (event) => {
    if (!dialog.open) return;
    const target = /** @type {HTMLElement} */ (event.target);
    const lost = target === document.body || target === document.documentElement;
    if (!lost && !dialog.contains(target)) return;
    if (target.closest?.('input, textarea, [contenteditable="true"]')) return;
    if (event.key === 'ArrowRight' && step < TOTAL) {
      event.preventDefault();
      go(step + 1);
    } else if (event.key === 'ArrowLeft' && step > 1) {
      event.preventDefault();
      go(step - 1);
    }
  });

  // Escape is an answer here, unlike the model announcement — this is help, not a
  // question, and refusing to close would make it the opposite of help.
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    finish();
  });
  dialog.addEventListener('close', () => video.pause());

  return {
    open(atStep = 1) {
      step = Math.min(Math.max(1, atStep), TOTAL);
      // Drawn before it opens, so focus lands on the first step's name rather
      // than on the clip's pause button; the clip starts once it is open.
      render();
      dialog.showModal();
      paintMedia();
    },
    /** Repaint while open, so a key saved anywhere updates the step behind the sheet. */
    refresh() {
      // Not while somebody is typing or pasting into the step's own box.
      if (dialog.open && !document.activeElement?.closest?.('textarea, input')) render();
    },
    isOpen: () => dialog.open,
  };
}
