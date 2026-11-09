/**
 * Which creature stands on the writing box for each title (owner, 2026-11-08).
 *
 * The same animal as the title's creature on the Ranking page (ranking-panel.js,
 * `CREATURES`), drawn again in pixels so it can do what the whale does. A place on a
 * board wears its place's creature, whatever the board or the period.
 *
 * Only what has been drawn is listed in `DRAWN`; a title whose creature is not drawn
 * yet keeps the whale. Each creature is its own module, fetched the first time it is
 * worn, so nobody downloads eleven animals to see one.
 */

/** Title id → creature id. */
export const TITLE_CREATURES = Object.freeze({
  newcomer: 'minnow',
  'tokens-1m': 'jellyfish',
  'tokens-10m': 'electric-ray',
  'tokens-100m': 'sea-dragon',
  'tokens-1b': 'cosmic-whale',
  'spend-10': 'seahorse',
  'spend-100': 'jade-turtle',
  'spend-1000': 'gold-whale',
});

/** First, second and third place on any board. */
export const PLACE_CREATURES = Object.freeze({ 1: 'koi-dragon', 2: 'silver-marlin', 3: 'bronze-dolphin' });

/** The creatures drawn so far, and where each is. */
const DRAWN = Object.freeze({
  minnow: () => import('./minnow.js'),
  jellyfish: () => import('./jellyfish.js'),
  'electric-ray': () => import('./electric-ray.js'),
  seahorse: () => import('./seahorse.js'),
  'gold-whale': () => import('./gold-whale.js'),
});

/**
 * A place title's id: `rank-2` (a place shown before anyone has won it) or a board's
 * prize, `top:tokens:quarter:2026-Q4:2` (server/themes.js `awardId`).
 */
const PLACE = /^(?:rank-([123])|(?:top|award):(?:tokens|spend):(?:quarter|year):\d{4}(?:-Q[1-4])?:([123]))$/;

/** The creature a title wears, drawn or not; null for no title or one this does not know. @param {string|null|undefined} titleId */
export function creatureFor(titleId) {
  const id = String(titleId || '');
  if (!id) return null;
  if (Object.hasOwn(TITLE_CREATURES, id)) return TITLE_CREATURES[id];
  const place = PLACE.exec(id);
  return place ? PLACE_CREATURES[place[1] || place[2]] : null;
}

/** Whether a creature has its pixels yet. @param {string|null} creatureId */
export const isDrawn = (creatureId) => !!creatureId && Object.hasOwn(DRAWN, creatureId);

/** Every creature drawn so far, by id: for a test, and for a page that shows them all. */
export const DRAWN_IDS = Object.freeze(Object.keys(DRAWN));

/**
 * The creature a title wears, loaded. Null is the whale: no title, or one whose
 * creature is not drawn yet.
 *
 * @param {string|null|undefined} titleId @returns {Promise<import('./engine.js').Creature|null>}
 */
export async function loadCreature(titleId) {
  const id = creatureFor(titleId);
  if (!isDrawn(id)) return null;
  return (await DRAWN[id]()).default;
}

/** A canvas for a creature, put on the page at once so the space is never empty while it loads. */
function canvasIn(box) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pixel-creature';
  canvas.setAttribute('aria-hidden', 'true');
  box.append(canvas);
  return canvas;
}

/**
 * A title's creature moving in a box on a page (the Ranking page's title panel), as
 * big as fits in whole pixels and centred on the animal itself: the room the square
 * keeps above it for props is not wanted there. Null when the title's creature is not
 * drawn yet; otherwise what takes it away again.
 *
 * @param {HTMLElement} box @param {string} titleId @param {{ state?: string, still?: boolean }} [options]
 * @returns {(() => void) | null}
 */
export function showCreature(box, titleId, { state = 'idle', still = false } = {}) {
  if (!isDrawn(creatureFor(titleId))) return null;
  const canvas = canvasIn(box);
  let view = null;
  let gone = false;
  Promise.all([loadCreature(titleId), import('./stage.js')]).then(
    ([creature, stage]) => {
      if (gone || !creature) return;
      const ratio = window.devicePixelRatio || 1;
      const width = box.clientWidth || 192;
      const height = box.clientHeight || width;
      const { x0, y0, x1, y1 } = stage.idleBox(creature);
      const scale = Math.max(1, Math.floor(Math.min((width * 0.86 * ratio) / (x1 - x0 + 1), (height * 0.86 * ratio) / (y1 - y0 + 1))));
      view = stage.mountCreature(canvas, creature, { state, still, scale });
      // Whole device pixels from the box's corner, so the grid stays square on screen.
      canvas.style.left = `${Math.round((width * ratio) / 2 - ((x0 + x1 + 1) / 2) * scale) / ratio}px`;
      canvas.style.top = `${Math.round((height * ratio) / 2 - ((y0 + y1 + 1) / 2) * scale) / ratio}px`;
    },
    // Not fetched: the box stays empty rather than half drawn.
    () => canvas.remove(),
  );
  return () => {
    gone = true;
    view?.destroy();
    canvas.remove();
  };
}

/**
 * One creature in each of several boxes, one state each (Settings → Theme → Mascot).
 *
 * @param {[string, HTMLElement][]} boxes  state and the box it is drawn in
 * @param {import('./engine.js').Creature} creature @param {{ still?: boolean, size?: number }} [options]
 * @returns {() => void} what takes them all away
 */
export function showStates(boxes, creature, { still = false, size = 64 } = {}) {
  const canvases = boxes.map(([state, box]) => /** @type {[string, HTMLCanvasElement]} */ ([state, canvasIn(box)]));
  let views = [];
  let gone = false;
  import('./stage.js').then(
    (stage) => {
      if (!gone) views = canvases.map(([state, canvas]) => stage.mountCreature(canvas, creature, { state, still, size }));
    },
    () => canvases.forEach(([, canvas]) => canvas.remove()),
  );
  return () => {
    gone = true;
    views.forEach((view) => view.destroy());
    canvases.forEach(([, canvas]) => canvas.remove());
  };
}
