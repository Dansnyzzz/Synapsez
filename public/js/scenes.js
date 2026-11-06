import { CATALOG } from './scenes/catalog.js';

/**
 * The scenes behind a theme (owner, 2026-11-04), as the page asks for them: original
 * art, drawn by code, each in its own module under `scenes/`.
 *
 * Choosing a theme must never wait for one to be painted, so on a browser that can
 * hand a canvas to a worker (every current one) all of it happens there: the page
 * says what should be showing, and hears back when it is. A browser that cannot runs
 * the same engine on the page.
 *
 * A tile in a list is a picture made ahead of time, `sceneStill`, which costs nothing
 * to show and paints nothing. A moving canvas is mounted only for what is being looked at.
 *
 * The art is this app's own. The owner's reference videos set a mood and nothing in
 * them is traced: no signage text, no characters, no logos.
 */

/**
 * What the rest of the app may know: how each is called, and how it is shown. The
 * words are in the locale files.
 *
 * @type {Record<string, { id: string, mode: string, focus: number[], smooth?: boolean }>}
 */
export const SCENES = Object.fromEntries(Object.entries(CATALOG).map(([id, s]) => [id, { id, mode: s.mode, focus: s.focus, smooth: !!s.smooth }]));

/** The picture made ahead of time. `npm run scenes:stills` makes them, and a test holds them to the catalogue. */
export const sceneStill = (id) => `/assets/scenes/${id}.webp`;

const canHandOver = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof HTMLCanvasElement?.prototype?.transferControlToOffscreen === 'function';

/** @type {Worker | null} */
let worker = null;
/** The engine, when it has to run on the page. */
let onPage = null;
let nextKey = 1;
/** @type {Map<number, () => void>} */
const waiting = new Map();
/** @type {Map<number, (stats: any) => void>} */
const asked = new Map();

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function tell(message, transfer = []) {
  worker?.postMessage(message, transfer);
}

function startWorker() {
  if (worker || !canHandOver) return;
  worker = new Worker(new URL('./scene-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      waiting.get(data.key)?.();
      waiting.delete(data.key);
    } else if (data.type === 'stats') {
      asked.get(data.asked)?.(data.stats);
      asked.delete(data.asked);
    }
  };
  tell({ type: 'hidden', value: document.hidden });
  tell({ type: 'stillOnly', value: !!motionQuery?.matches });
}

function engine() {
  if (!onPage) {
    onPage = import('./scenes/engine.js').then((module) => {
      module.setHidden(document.hidden);
      module.setStillOnly(!!motionQuery?.matches);
      return module;
    });
  }
  return onPage;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    tell({ type: 'hidden', value: document.hidden });
    onPage?.then((module) => module.setHidden(document.hidden));
  });
}
// Asking for less motion stops everything at once, and changing back starts it again.
motionQuery?.addEventListener?.('change', () => {
  tell({ type: 'stillOnly', value: motionQuery.matches });
  onPage?.then((module) => module.setStillOnly(motionQuery.matches));
});

/**
 * A scene on a canvas. The canvas belongs to it from now on: a canvas handed to a
 * worker cannot be taken back, so mounting again means a new one.
 *
 * It holds one still frame until told to play. `pause` puts that still frame back.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} id
 * @param {{ animate?: boolean, onReady?: () => void }} [options]
 */
export function mountScene(canvas, id, { animate = false, onReady = null } = {}) {
  const facts = CATALOG[id];
  if (!facts) return { play() {}, pause() {}, destroy() {} };
  canvas.style.objectPosition = `${facts.focus[0] * 100}% ${facts.focus[1] * 100}%`;
  canvas.classList.toggle('is-smooth', !!facts.smooth);
  if (canHandOver) {
    startWorker();
    const key = nextKey;
    nextKey += 1;
    if (onReady) waiting.set(key, onReady);
    const handle = canvas.transferControlToOffscreen();
    tell({ type: 'mount', key, id, canvas: handle, animate }, [handle]);
    return {
      play: () => tell({ type: 'play', key }),
      pause: () => tell({ type: 'pause', key }),
      destroy() {
        waiting.delete(key);
        tell({ type: 'destroy', key });
      },
    };
  }
  /** @type {any} */
  let held = null;
  let gone = false;
  let moving = animate;
  engine().then((module) => {
    if (!gone) held = module.mount(canvas, id, { animate: moving, onReady });
  });
  return {
    play() {
      moving = true;
      held?.play();
    },
    pause() {
      moving = false;
      held?.pause();
    },
    destroy() {
      gone = true;
      held?.destroy();
    },
  };
}

/** Whether anything would move right now, and how much has been drawn: for a test and for a person measuring. */
/**
 * Play a scene over a picture of it while something is being looked at. What it
 * returns takes the moving copy away again.
 *
 * @param {HTMLElement} frame  the element holding the picture
 * @param {string} id
 */
export function playInFrame(frame, id) {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-live';
  canvas.setAttribute('aria-hidden', 'true');
  frame.append(canvas);
  const handle = mountScene(canvas, id, { animate: true, onReady: () => canvas.classList.add('is-in') });
  return () => {
    handle.destroy();
    canvas.remove();
  };
}

export function sceneStats() {
  if (!canHandOver) return engine().then((module) => module.stats());
  startWorker();
  return new Promise((resolve) => {
    const key = nextKey;
    nextKey += 1;
    asked.set(key, resolve);
    tell({ type: 'stats', asked: key });
  });
}
