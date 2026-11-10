import { loadCreatureById, DRAWN_IDS } from './mascots/index.js';
import { escapeHtml } from './markdown.js';
import { t } from './i18n.js';

/**
 * A bot's face: one of the app's own pixel creatures (owner, 2026-11-09).
 *
 * The creatures were drawn for the titles (mascots/); a bot picks one. Here each is
 * drawn once, standing still, cropped to the animal, and kept as a picture, so a
 * list of twenty bots costs eleven small drawings at most and no animation. The
 * details panel draws its one big face moving (mascot.js `showStates`).
 *
 * Markup is a placeholder (`faceHtml`) that `paintFaces` fills in once the picture
 * is ready, so a page drawn as a string never waits on a creature.
 */

/** Each creature's own colour, for a bot's name in a group chat. Mixed with the text colour in CSS for contrast. */
export const CREATURE_INK = Object.freeze({
  minnow: '#4cb8e8',
  jellyfish: '#b69cf2',
  'electric-ray': '#2fb3c4',
  'sea-dragon': '#cfc24e',
  'cosmic-whale': '#8f86ff',
  seahorse: '#cd8a4e',
  'gold-whale': '#f2b33d',
  'jade-turtle': '#36a873',
  'koi-dragon': '#ef4a36',
  'silver-marlin': '#9fb3cc',
  'bronze-dolphin': '#cc8640',
});

export const inkOf = (creature) => CREATURE_INK[creature] || '#9aa8b5';
export const CREATURE_IDS = DRAWN_IDS;

/** The Ranking page's pets name the same animals; three were named before the creatures were. */
const PET = Object.freeze({ jellyfish: 'pet-jelly', 'electric-ray': 'pet-manta', 'sea-dragon': 'pet-seadragon' });
/** A creature's name in the person's language. @param {string} id */
export const creatureName = (id) => t(`ranking.pet.${PET[id] || `pet-${id}`}.name`);

/** @type {Map<string, Promise<string>>} */
const stills = new Map();

/** The creature standing still, cropped to itself, as a data URL. @param {string} id */
export function creatureStill(id) {
  if (!stills.has(id)) {
    stills.set(
      id,
      Promise.all([loadCreatureById(id), import('./mascots/engine.js'), import('./mascots/stage.js')]).then(([creature, engine, stage]) => {
        if (!creature) return '';
        const full = document.createElement('canvas');
        full.width = engine.SIZE;
        full.height = engine.SIZE;
        engine.drawFrame(/** @type {any} */ (full.getContext('2d')), creature, 'idle', engine.STILL_FRAMES.idle ?? 0);
        const { x0, y0, x1, y1 } = stage.idleBox(creature);
        const side = Math.max(x1 - x0 + 1, y1 - y0 + 1) + 2;
        const cx = (x0 + x1 + 1) / 2;
        const cy = (y0 + y1 + 1) / 2;
        const out = document.createElement('canvas');
        out.width = side;
        out.height = side;
        out.getContext('2d')?.drawImage(full, Math.round(cx - side / 2), Math.round(cy - side / 2), side, side, 0, 0, side, side);
        return out.toDataURL('image/png');
      }),
    );
  }
  return /** @type {Promise<string>} */ (stills.get(id));
}

/**
 * A face, to be filled in by `paintFaces`. Decoration: the name beside it says who it
 * is, so it is hidden from screen readers.
 *
 * @param {string} creature @param {number} [size] @param {string} [extra]  more classes
 */
export function faceHtml(creature, size = 28, extra = '') {
  return `<span class="botface ${extra}" data-creature="${escapeHtml(creature || '')}" style="--face:${Number(size) || 28}px" aria-hidden="true"></span>`;
}

/** Fill every face placeholder under `root` with its creature. @param {ParentNode} root */
export function paintFaces(root) {
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.botface[data-creature]:not([data-painted])'))) {
    node.dataset.painted = '1';
    creatureStill(node.dataset.creature || '').then(
      (url) => {
        if (url) node.style.backgroundImage = `url("${url}")`;
      },
      () => {},
    );
  }
}
