import { FRAMES, FRAME_MS, MOMENTS, SIZE, STILL_FRAMES, framePixels } from './engine.js';

export { holdMs } from './engine.js';

/**
 * Title creatures on the page (owner, 2026-11-08): a canvas each, and one clock for
 * all of them. The clock runs only while something is moving and the tab can be seen;
 * a canvas taken off the page drops out of it on the next tick.
 *
 * Pixels stay square at any zoom or screen density: the canvas is a whole multiple of
 * 64 device pixels, and its size on the page is worked back from that, so a grid
 * pixel is never stretched across a fraction of a screen pixel.
 *
 * Frames are counted by ticks, not read off the clock: a slow tick makes a loop a
 * little longer, never skips a frame, and a happy moment always plays its whole loops.
 */

/** @type {Set<View>} */
const moving = new Set();
let timer = 0;
let watching = false;

function tick() {
  timer = 0;
  if (document.hidden) return;
  for (const view of [...moving]) {
    if (!view.canvas.isConnected) moving.delete(view);
    else view.step();
  }
  schedule();
}

function schedule() {
  if (timer || !moving.size || document.hidden) return;
  timer = window.setTimeout(tick, FRAME_MS);
}

function watch() {
  if (watching) return;
  watching = true;
  // A hidden tab draws nothing; back in view, it carries on from where it was.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.clearTimeout(timer);
      timer = 0;
    } else schedule();
  });
}

/**
 * Frames already worked out, as runs of one colour: [colour, x, y, width, ...]. Every
 * loop comes round again, so after the first one a frame is only rectangles: measured
 * at 0.3 to 0.6 ms to work one out on a desktop, and the Theme page shows eight at once.
 */
const runs = new Map();
const RUNS_KEPT = 600;

function runsOf(creature, state, frame) {
  const key = `${creature.id}:${state}:${frame}`;
  let list = runs.get(key);
  if (!list) {
    list = [];
    const out = list;
    const recorder = { fillStyle: '', fillRect: (x, y, w) => out.push(recorder.fillStyle, x, y, w) };
    framePixels(creature, state, frame).flush(recorder);
    if (runs.size >= RUNS_KEPT) runs.delete(runs.keys().next().value);
    runs.set(key, list);
  }
  return list;
}

/** @type {Map<string, { x0: number, y0: number, x1: number, y1: number }>} */
const extents = new Map();

/**
 * Where a creature is, across all of idle: what a frame showing only the animal (a
 * title's panel) is fitted to, rather than the whole square kept free for props.
 *
 * @param {import('./engine.js').Creature} creature
 */
export function idleBox(creature) {
  let box = extents.get(creature.id);
  if (box) return box;
  box = { x0: SIZE, y0: SIZE, x1: -1, y1: -1 };
  for (let f = 0; f < FRAMES.idle; f += 1) {
    const list = runsOf(creature, 'idle', f);
    for (let i = 0; i < list.length; i += 4) {
      box.x0 = Math.min(box.x0, list[i + 1]);
      box.x1 = Math.max(box.x1, list[i + 1] + list[i + 3] - 1);
      box.y0 = Math.min(box.y0, list[i + 2]);
      box.y1 = Math.max(box.y1, list[i + 2]);
    }
  }
  extents.set(creature.id, box);
  return box;
}

/** For a test, and for a person measuring: how many are moving, whether the clock is running, how many frames are kept. */
export const stageStats = () => ({ moving: moving.size, running: !!timer, kept: runs.size });

/**
 * How many device pixels a grid pixel takes for a size on the page, at least one. `fit`
 * rounds down, for a box it must not spill out of.
 *
 * @param {number} cssSize @param {boolean} [fit]
 */
export function scaleFor(cssSize, fit = false) {
  const ratio = window.devicePixelRatio || 1;
  const exact = (cssSize * ratio) / SIZE;
  return Math.max(1, fit ? Math.floor(exact) : Math.round(exact));
}

/**
 * @typedef {{ canvas: HTMLCanvasElement, step: () => void }} View
 * @typedef {{ state?: string, size?: number, fit?: boolean, scale?: number, still?: boolean, once?: boolean, onDone?: () => void }} Options
 */

/**
 * Show a creature on a canvas and keep it moving.
 *
 * `size` is roughly how big on the page, in CSS pixels (`fit`: no bigger than it), or
 * `scale` says outright how many device pixels a grid pixel takes; `still` holds one
 * frame per state, for someone who asked for less motion; `once` plays a moment
 * (happy, error) its whole loops and then calls `onDone`, rather than looping it.
 *
 * @param {HTMLCanvasElement} canvas @param {import('./engine.js').Creature} creature @param {Options} [options]
 */
export function mountCreature(canvas, creature, { state = 'idle', size = 128, fit = false, scale: fixed = 0, still = false, once = false, onDone } = {}) {
  watch();
  const ctx = canvas.getContext('2d');
  let current = creature;
  let shown = state;
  let held = still;
  let playOnce = once;
  let count = 0;
  let scale = 0;
  let drawn = '';

  function frameNow() {
    const frames = FRAMES[shown] || 1;
    if (held) return STILL_FRAMES[shown] ?? 0;
    const loops = MOMENTS[shown];
    if (playOnce && loops && count >= loops * frames) return 0;
    return count % frames;
  }

  function draw() {
    const frame = frameNow();
    const key = `${current.id}:${shown}:${frame}:${scale}`;
    if (key === drawn) return;
    drawn = key;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const list = runsOf(current, shown, frame);
    let colour = '';
    for (let i = 0; i < list.length; i += 4) {
      // Compared with the last one set, not read back: a canvas rewrites what it is given.
      if (list[i] !== colour) ctx.fillStyle = colour = list[i];
      ctx.fillRect(list[i + 1], list[i + 2], list[i + 3], 1);
    }
    canvas.dataset.frame = String(frame);
  }

  /** @type {View} */
  const view = {
    canvas,
    step() {
      count += 1;
      draw();
      const loops = MOMENTS[shown];
      if (playOnce && loops && count === loops * (FRAMES[shown] || 1)) {
        moving.delete(view);
        onDone?.();
      }
    },
  };

  function resize(cssSize) {
    const next = fixed || scaleFor(cssSize, fit);
    if (next === scale) return;
    scale = next;
    canvas.width = SIZE * scale;
    canvas.height = SIZE * scale;
    const side = `${(SIZE * scale) / (window.devicePixelRatio || 1)}px`;
    canvas.style.width = side;
    canvas.style.height = side;
    drawn = '';
    draw();
  }

  function run() {
    if (held) moving.delete(view);
    else moving.add(view);
    schedule();
  }

  resize(size);
  run();

  return {
    /**
     * Another state, from its first frame; the same one carries on unless `restart`.
     *
     * @param {string} next @param {{ still?: boolean, once?: boolean, restart?: boolean }} [how]
     */
    set(next, how = {}) {
      const changed = next !== shown || (how.still ?? held) !== held || !!how.restart;
      shown = next;
      held = how.still ?? held;
      playOnce = how.once ?? playOnce;
      if (changed) count = 0;
      draw();
      run();
    },
    /** Another creature, in the same state. @param {import('./engine.js').Creature} next */
    setCreature(next) {
      current = next;
      draw();
    },
    resize,
    /** Taken off the page: it stops at once. */
    destroy() {
      moving.delete(view);
    },
  };
}
