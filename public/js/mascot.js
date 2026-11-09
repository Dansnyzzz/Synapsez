import { creatureFor, isDrawn, loadCreature } from './mascots/index.js';

/**
 * A small whale on the edge of the writing box (owner, 2026-11-04). On `auto` it
 * shows what the assistant is doing; set to one state, it keeps that one; `off`
 * draws nothing. It is decoration: it never takes a press, is hidden from screen
 * readers, and takes no room, so nothing around it can move because of it.
 *
 * Wearing a title puts that title's creature there instead (owner, 2026-11-08), drawn
 * in pixels on a canvas (mascots/), doing the same eight things. A title whose creature
 * is not drawn yet keeps the whale.
 *
 * Each GIF, and each creature, is fetched the first time it is shown. Art and where it
 * comes from: public/assets/mascot/NOTICE.txt.
 */

export const MASCOT_STATES = ['idle', 'thinking', 'typing', 'conducting', 'notification', 'error', 'happy', 'sleeping'];

/** How long the whale's moment stays up on its own, and how long a quiet box takes to fall asleep. */
const HAPPY_MS = 6000;
const ERROR_MS = 8000;
const SLEEP_MS = 120_000;
/** A creature ends its own moment after whole loops; this much later, the page does it anyway. */
const MOMENT_SLACK_MS = 2000;

/** How big a creature stands, in CSS pixels: the stylesheet says, by screen width (`--mascot-size`). @param {HTMLElement} node */
function sizeOf(node) {
  const size = parseFloat(getComputedStyle(node).getPropertyValue('--mascot-size'));
  return size > 0 ? size : 128;
}

/** @param {{ host: HTMLElement }} deps */
export function createMascot({ host }) {
  let pref = 'auto';
  let state = 'idle';
  let img = null;
  /** The worn title's creature, loaded, and the module that plays it; null is the whale. */
  let creature = null;
  let stage = null;
  /** Its canvas and what plays on it, while it is up. */
  let pixel = null;
  /** The title last asked for, so an older load that lands late changes nothing. */
  let asked = null;
  let settle = 0;
  let sleep = 0;

  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const still = () => !!motion?.matches;
  const shown = () => (pref === 'auto' ? state : pref);

  function dropWhale() {
    img?.remove();
    img = null;
  }

  function dropCreature() {
    pixel?.view.destroy();
    pixel?.canvas.remove();
    pixel = null;
  }

  /** A turn's moment has played its loops. */
  function settled() {
    if (state !== 'happy' && state !== 'error') return;
    clearTimeout(settle);
    set('idle');
  }

  function paintCreature(now, restart) {
    dropWhale();
    // On automatic a moment plays its loops and passes; chosen in Settings, it keeps on.
    const how = { still: still(), once: pref === 'auto', restart };
    if (!pixel) {
      const canvas = document.createElement('canvas');
      canvas.className = 'mascot mascot--pixel';
      canvas.setAttribute('aria-hidden', 'true');
      host.append(canvas);
      pixel = { canvas, view: stage.mountCreature(canvas, creature, { state: now, size: sizeOf(canvas), ...how, onDone: settled }) };
    } else {
      pixel.view.setCreature(creature);
      pixel.view.set(now, how);
    }
    pixel.canvas.dataset.state = now;
    pixel.canvas.dataset.creature = creature.id;
  }

  function paint(restart = false) {
    const now = shown();
    if (pref === 'off') {
      dropWhale();
      dropCreature();
      return;
    }
    if (creature && stage) {
      paintCreature(now, restart);
      return;
    }
    dropCreature();
    // Asking for less motion leaves the whale off: a GIF cannot be held on one frame.
    // A creature can, so it stays, still.
    if (still()) {
      dropWhale();
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
    const src = `/assets/mascot/${now}.gif`;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.dataset.state = now;
  }

  /** The box has gone quiet: after a while, it nods off. */
  function armSleep() {
    clearTimeout(sleep);
    sleep = window.setTimeout(() => {
      if (state === 'idle') set('sleeping');
    }, SLEEP_MS);
  }

  function set(next, restart = false) {
    state = next;
    paint(restart);
    if (next === 'idle') armSleep();
    else clearTimeout(sleep);
  }

  // A window turned or zoomed: the creature keeps whole pixels at its new size.
  window.addEventListener('resize', () => pixel?.view.resize(sizeOf(pixel.canvas)));
  motion?.addEventListener?.('change', () => paint());

  return {
    /** The saved choice. */
    setPref(value) {
      pref = value || 'auto';
      paint();
    },
    pref: () => pref,
    /**
     * The title being worn, or none: its creature stands on the box, or the whale.
     *
     * @param {string|null|undefined} titleId @returns {Promise<any>} the creature, or null for the whale
     */
    setCreature(titleId) {
      const id = titleId || null;
      asked = id;
      if (!isDrawn(creatureFor(id))) {
        creature = null;
        paint();
        return Promise.resolve(null);
      }
      return Promise.all([loadCreature(id), stage || import('./mascots/stage.js')]).then(
        ([loaded, module]) => {
          if (asked !== id) return creature;
          stage = module;
          creature = loaded;
          paint();
          return creature;
        },
        // Not fetched (offline, or a deploy mid-way): the whale stands in, as for a creature not drawn yet.
        () => {
          if (asked === id) {
            creature = null;
            paint();
          }
          return null;
        },
      );
    },
    /** The creature on the box now; null when it is the whale. */
    creature: () => creature,
    /** What the run is doing now. */
    show(next) {
      clearTimeout(settle);
      set(next);
    },
    /** A turn finished, well or badly; either way it passes. */
    finished(ok = true) {
      clearTimeout(settle);
      set(ok ? 'happy' : 'error', true);
      // A creature ends it itself, after whole loops; this covers a tab nobody is looking at.
      const ms = pixel ? stage.holdMs(state) + (still() ? 0 : MOMENT_SLACK_MS) : ok ? HAPPY_MS : ERROR_MS;
      settle = window.setTimeout(() => set('idle'), ms);
    },
    /** Somebody is typing: awake again, and not asleep for a while. */
    stir() {
      if (state === 'sleeping') set('idle');
      else if (state === 'idle') armSleep();
    },
    current: () => (pref === 'auto' ? state : pref),
  };
}
