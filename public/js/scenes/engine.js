import { CATALOG } from './catalog.js';

/**
 * What plays the scenes. It knows nothing about the page: it is handed a canvas and
 * an id, and it runs in the scene worker (scene-worker.js) wherever a browser allows,
 * so painting a scene never holds up a press. On a browser that does not, the same
 * code runs on the page.
 *
 * Every frame is a pure function of a time in seconds, so a still frame is the same
 * picture every time and nothing keeps a clock of its own. What costs time is paid
 * once: the layers are painted when a scene is first needed and kept for the next
 * time. One timer runs every scene that is moving, and it stops altogether when the
 * tab is hidden, when nothing is playing, or when the person asked for less motion.
 */

const DEFAULT_FPS = 14;
/** Built layers, newest last. A few at most: each is several megabytes of canvas. */
const KEEP_WORLDS = 5;

/** @type {Map<string, Promise<any>>} */
const modules = new Map();
const worlds = new Map();
/** @type {Set<any>} every mount that is moving */
const playing = new Set();
/** @type {ReturnType<typeof setTimeout> | 0} */
let timer = 0;
let lastTick = 0;
let framesDrawn = 0;
let hidden = false;
let stillOnly = false;

/**
 * A scene's code, fetched the first time it is wanted. The id is the catalogue's,
 * never a person's. A file may hold a family of them (`module`), keyed by id.
 */
function sceneOf(id) {
  const facts = CATALOG[id];
  if (!facts) return Promise.reject(new Error('no such scene'));
  let held = modules.get(id);
  if (!held) {
    held = import(`./${facts.module || id}.js`).then((module) => (facts.module ? module.default[id] : module.default));
    modules.set(id, held);
  }
  return held;
}

function worldOf(id, scene) {
  let world = worlds.get(id);
  if (world) {
    worlds.delete(id);
    worlds.set(id, world);
    return world;
  }
  world = scene.build();
  worlds.set(id, world);
  const busy = new Set([...playing].map((m) => m.id));
  for (const key of worlds.keys()) {
    if (worlds.size <= KEEP_WORLDS) break;
    if (key !== id && !busy.has(key)) worlds.delete(key);
  }
  return world;
}

function wake() {
  if (timer || !playing.size || hidden || stillOnly) return;
  const fps = Math.max(...[...playing].map((m) => m.fps));
  timer = setTimeout(tick, 1000 / fps);
}

function tick() {
  timer = 0;
  if (hidden || stillOnly || !playing.size) return;
  const now = performance.now();
  // A long gap is a throttled tab or a sleeping laptop: the picture carries on from where it was.
  const step = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  for (const mount of playing) {
    mount.clock += step;
    mount.owed += step;
    // A scene slower than the fastest one on screen draws at its own pace.
    if (mount.owed >= 1 / mount.fps - 0.002) {
      mount.owed = 0;
      // One broken scene stops being played; the backdrop and every other one carry on.
      try {
        mount.paint(mount.clock);
      } catch (err) {
        playing.delete(mount);
        console.error('scene stopped', err);
      }
    }
  }
  wake();
}

function stirred() {
  clearTimeout(timer);
  timer = 0;
  lastTick = performance.now();
  wake();
}

/** The tab was hidden, or came back. */
export function setHidden(value) {
  hidden = !!value;
  stirred();
}

/** The person asked for less motion, or stopped asking. Everything goes still at once. */
export function setStillOnly(value) {
  stillOnly = !!value;
  if (stillOnly) for (const mount of playing) mount.still();
  stirred();
}

/**
 * A scene on a canvas: an element, or the worker's end of one.
 *
 * The first frame is drawn a moment later rather than here. A press that lands on
 * another theme meanwhile destroys this mount before anything has been painted for
 * it, so a run of presses costs only the last. `pause` puts the still frame back, and
 * from then on the canvas costs nothing.
 *
 * @param {any} canvas
 * @param {string} id
 * @param {{ animate?: boolean, onReady?: () => void }} [options]
 */
export function mount(canvas, id, { animate = false, onReady = null } = {}) {
  const facts = CATALOG[id];
  if (!facts) return { play() {}, pause() {}, destroy() {} };
  let dead = false;
  let drawn = false;
  let wanted = animate;
  /** @type {any} */
  const entry = {
    id,
    fps: facts.fps || DEFAULT_FPS,
    clock: facts.still,
    owed: 0,
    paint() {},
    still() {},
  };
  const start = () => {
    if (!playing.size) lastTick = performance.now();
    playing.add(entry);
    wake();
  };
  (async () => {
    const scene = await sceneOf(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dead) return;
    canvas.width = facts.width || 480;
    canvas.height = facts.height || 270;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = !!facts.smooth;
    const world = worldOf(id, scene);
    if (dead) return;
    entry.paint = (at) => {
      scene.draw(ctx, at, world);
      framesDrawn += 1;
    };
    entry.still = () => {
      entry.clock = facts.still;
      entry.paint(facts.still);
    };
    entry.still();
    drawn = true;
    onReady?.();
    if (wanted) start();
  })().catch(() => {
    /* a scene that will not load leaves the canvas empty; the page around it still works */
  });
  return {
    play() {
      wanted = true;
      if (drawn && !playing.has(entry)) start();
    },
    pause() {
      wanted = false;
      if (playing.delete(entry)) entry.still();
    },
    destroy() {
      dead = true;
      playing.delete(entry);
    },
  };
}

/** Whether anything would move right now, and how much has been drawn: for a test and for a person measuring. */
export const stats = () => ({ frames: framesDrawn, playing: playing.size, timer: !!timer, worlds: worlds.size });
