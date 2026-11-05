/**
 * A small whale on the edge of the writing box (owner, 2026-11-04). On `auto` it
 * shows what the assistant is doing; set to one state, it keeps that one; `off`
 * draws nothing. It is decoration: it never takes a press, is hidden from screen
 * readers, and takes no room, so nothing around it can move because of it.
 *
 * Each GIF is fetched the first time it is shown. Art and licence: public/assets/mascot/NOTICE.txt.
 */

export const MASCOT_STATES = ['idle', 'thinking', 'typing', 'conducting', 'notification', 'error', 'happy', 'sleeping'];

/** How long a moment stays up on its own, and how long a quiet box takes to fall asleep. */
const HAPPY_MS = 6000;
const ERROR_MS = 8000;
const SLEEP_MS = 120_000;

/** @param {{ host: HTMLElement }} deps */
export function createMascot({ host }) {
  let pref = 'auto';
  let state = 'idle';
  let img = null;
  let settle = 0;
  let sleep = 0;

  const still = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function paint() {
    const shown = pref === 'auto' ? state : pref;
    // Asking for less motion leaves it off: a GIF cannot be held on one frame.
    if (pref === 'off' || still()) {
      img?.remove();
      img = null;
      return;
    }
    if (!img) {
      img = document.createElement('img');
      img.className = 'mascot';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.decoding = 'async';
      img.draggable = false;
      host.append(img);
    }
    const src = `/assets/mascot/${shown}.gif`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.dataset.state = shown;
  }

  /** The box has gone quiet: after a while, it nods off. */
  function armSleep() {
    clearTimeout(sleep);
    sleep = window.setTimeout(() => {
      if (state === 'idle') set('sleeping');
    }, SLEEP_MS);
  }

  function set(next) {
    state = next;
    paint();
    if (next === 'idle') armSleep();
    else clearTimeout(sleep);
  }

  return {
    /** The saved choice. */
    setPref(value) {
      pref = value || 'auto';
      paint();
    },
    pref: () => pref,
    /** What the run is doing now. */
    show(next) {
      clearTimeout(settle);
      set(next);
    },
    /** A turn finished, well or badly; either way it passes. */
    finished(ok = true) {
      clearTimeout(settle);
      set(ok ? 'happy' : 'error');
      settle = window.setTimeout(() => set('idle'), ok ? HAPPY_MS : ERROR_MS);
    },
    /** Somebody is typing: awake again, and not asleep for a while. */
    stir() {
      if (state === 'sleeping') set('idle');
      else if (state === 'idle') armSleep();
    },
    current: () => (pref === 'auto' ? state : pref),
  };
}
