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

/**
 * A bot as its face is drawn: a creature id alone, or a bot ({ avatar, hue }). `hue` turns
 * the creature's colours round the wheel, so two bots sharing a creature are told apart
 * (owner, 2026-11-10); 0 is as drawn.
 *
 * @param {string | { avatar?: string, hue?: number } | null | undefined} who
 */
const faceOf = (who) => (who && typeof who === 'object' ? { creature: String(who.avatar || ''), hue: Number(who.hue) || 0 } : { creature: String(who || ''), hue: 0 });

/** A colour turned round the wheel by `deg`. @param {string} hex @param {number} deg */
function turned(hex, deg) {
  if (!deg) return hex;
  const n = parseInt(hex.slice(1), 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** A bot's colour for its name and its @mentions. @param {string | { avatar?: string, hue?: number } | null | undefined} who */
export const inkOf = (who) => {
  const { creature, hue } = faceOf(who);
  return turned(CREATURE_INK[creature] || '#9aa8b5', hue);
};
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
 * @param {string | { avatar?: string, hue?: number } | null | undefined} who  a creature id, or a bot with its hue
 * @param {number} [size] @param {string} [extra]  more classes
 */
export function faceHtml(who, size = 28, extra = '') {
  const { creature, hue } = faceOf(who);
  const tint = hue ? `;filter:hue-rotate(${hue}deg)` : '';
  return `<span class="botface ${extra}" data-creature="${escapeHtml(creature)}" style="--face:${Number(size) || 28}px${tint}" aria-hidden="true"></span>`;
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
