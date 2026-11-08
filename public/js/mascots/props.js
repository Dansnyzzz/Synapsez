import { ACCENTS, Mask } from './pixels.js';

/**
 * The things every title creature holds up, sits behind or wears (owner, 2026-11-08):
 * a thought cloud, a bulb, a screen and keys, badges, a sign, puffs, sparkles,
 * confetti, a nightcap, a bubble, sleepy z's, progress bars and a baton.
 *
 * Drawn here from scratch, in the house style of the whale's world (flat colours, a
 * 1-px outline, no shading between pixels) but none of its shapes. Each is placed by
 * the state renderers in engine.js against a creature's anchors, so a creature only
 * says where its head is, and every prop fits it.
 *
 * The outline of every prop is the same navy, so a prop reads on the light theme's
 * pale box and the dark theme's dark one alike.
 */

const A = ACCENTS;
const INK = A.navy;

/** A round badge eleven across: `pop` draws it a size smaller, the frame it appears. */
function disc(cx, cy, pop) {
  const r = pop ? 2.5 : 4.5;
  return new Mask().blob(cx + 0.5, cy + 0.5, r, r);
}

/** The thought cloud, centred on a pixel. About 19 by 12. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} cy */
export function cloud(p, cx, cy) {
  const puffs = new Mask()
    .blob(cx - 4.5, cy + 1.5, 4.5, 3.6)
    .blob(cx + 0.5, cy - 0.5, 5.2, 4.8)
    .blob(cx + 5.5, cy + 1.5, 4.2, 3.4)
    .rect(cx - 6, cy + 1, 13, 3);
  p.shape(puffs, A.white, INK);
  // A sliver of shade along its underside, so it has a bottom.
  for (const [x, y] of puffs) if (!puffs.has(x, y + 1) && x > cx - 7 && x < cx + 8) p.px(x, y, A.grey);
}

/** The dots a thought is waiting on, one to three. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} cy @param {number} count */
export function cloudDots(p, cx, cy, count) {
  for (let i = 0; i < count; i += 1) p.rect(cx - 5 + i * 4, cy, 2, 2, INK);
}

/** Two bubbles rising from the head to the cloud: the smaller nearer the head. @param {import('./pixels.js').Pixels} p @param {[number, number]} near @param {[number, number]} far */
export function trail(p, near, far) {
  p.shape(new Mask().add(near[0], near[1]), A.white, INK);
  p.shape(new Mask().rect(far[0], far[1], 2, 2), A.white, INK);
}

/** A bulb that has just lit, with sparks turning about it. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} cy @param {number} frame */
export function bulb(p, cx, cy, frame) {
  const glass = new Mask().blob(cx + 0.5, cy - 0.5, 3.6, 3.6).rect(cx - 1, cy + 2, 3, 2);
  p.shape(glass, A.yellow, INK);
  const base = new Mask().rect(cx - 1, cy + 4, 3, 2);
  p.shape(base, A.grey, INK);
  p.px(cx, cy + 5, A.slate);
  p.px(cx - 2, cy - 2, A.white);
  p.px(cx - 1, cy - 3, A.white);
  p.px(cx, cy + 1, A.amber);
  // Sparks: the straight four and the slanted four take turns.
  const straight = Math.floor(frame / 2) % 2 === 0;
  const rays = straight
    ? [[0, -7], [0, -8], [-7, -1], [-8, -1], [7, -1], [8, -1]]
    : [[-5, -6], [-6, -7], [5, -6], [6, -7], [-6, 3], [6, 3]];
  for (const [x, y] of rays) p.px(cx + x, cy + y, A.yellow);
  if (straight) p.dots([[cx, cy - 7], [cx - 7, cy - 1], [cx + 7, cy - 1]], A.white);
}

/** Lines of code on the screen, as [indent, length, colour]. Read in turn so the screen scrolls. @type {[number, number, string][]} */
const CODE = [
  [0, 6, A.violet],
  [2, 7, A.green],
  [2, 4, A.cyan],
  [4, 6, A.yellow],
  [2, 8, A.pink],
  [0, 3, A.violet],
  [2, 5, A.green],
  [4, 4, A.orange],
];

/**
 * A small screen on a stand, its right edge at `right`, its foot on `floor`: 16 by 15.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} right @param {number} floor @param {number} frame
 */
export function monitor(p, right, floor, frame) {
  const left = right - 15;
  const top = floor - 14;
  p.shape(new Mask().rect(left + 6, floor - 3, 4, 2), A.slate, INK);
  p.shape(new Mask().rect(left + 3, floor - 1, 10, 1), A.slate, INK);
  p.shape(new Mask().rect(left, top, 16, 11), A.slate, INK);
  p.rect(left + 1, top + 1, 14, 9, A.navy);
  // Three lines in view, a line further every four frames.
  const first = Math.floor(frame / 4);
  for (let row = 0; row < 3; row += 1) {
    const [indent, length, colour] = CODE[(first + row) % CODE.length];
    p.rect(left + 2 + indent, top + 2 + row * 2, Math.min(length, 12 - indent), 1, colour);
  }
  // The cursor, blinking at the end of the last line.
  const [indent, length] = CODE[(first + 2) % CODE.length];
  if (frame % 8 < 4) p.px(left + 2 + Math.min(indent + length, 12), top + 6, A.white);
  p.px(right - 2, top + 9, A.green);
}

/** Keys in front of the screen, one lit as it is pressed: 15 by 5. @param {import('./pixels.js').Pixels} p @param {number} left @param {number} floor @param {number} frame */
export function keyboard(p, left, floor, frame) {
  const top = floor - 1;
  p.shape(new Mask().rect(left, top, 13, 3), A.slate, INK);
  const keys = [];
  for (let i = 0; i < 6; i += 1) keys.push([left + 1 + i * 2, top]);
  for (let i = 0; i < 5; i += 1) keys.push([left + 2 + i * 2, top + 2]);
  p.dots(keys, A.grey);
  p.rect(left + 4, top + 2, 5, 1, A.grey);
  const [x, y] = keys[(frame * 7 + 3) % keys.length];
  if (frame % 2 === 0) p.px(x, y, A.white);
}

/** Code signs, five tall, that float up from the screen. */
const GLYPHS = {
  lt: ['..#', '.#.', '#..', '.#.', '..#'],
  gt: ['#..', '.#.', '..#', '.#.', '#..'],
  slash: ['..#', '..#', '.#.', '#..', '#..'],
  brace: ['.##', '.#.', '#..', '.#.', '.##'],
  hash: ['#.#', '###', '#.#', '###', '#.#'],
};
export const GLYPH_NAMES = Object.keys(GLYPHS);

/** @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {string} name @param {string} colour */
export function glyph(p, x, y, name, colour) {
  p.shape(new Mask().rows(x, y, GLYPHS[name]), colour, INK);
}

const TICK = ['.........', '.........', '......##.', '.....##..', '.##.##...', '..###....', '...#.....', '.........', '.........'];
const CROSS = ['.........', '.........', '.##...##.', '..##.##..', '...###...', '..##.##..', '.##...##.', '.........', '.........'];

/** A green badge with a white tick, done. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} cy @param {boolean} [pop] */
export function check(p, cx, cy, pop = false) {
  p.shape(disc(cx, cy, pop), A.green, INK);
  if (!pop) p.sprite(cx - 4, cy - 4, TICK, { '#': A.white });
  else p.dots([[cx - 1, cy], [cx, cy + 1], [cx + 1, cy], [cx + 2, cy - 1]], A.white);
}

/** A red badge with a white cross, it failed. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} cy @param {boolean} [pop] */
export function errorBadge(p, cx, cy, pop = false) {
  p.shape(disc(cx, cy, pop), A.red, A.darkRed);
  if (!pop) {
    p.sprite(cx - 4, cy - 4, CROSS, { '#': A.white });
    // A rim of light on its upper left: it is a thing, not a hole.
    p.dots([[cx - 2, cy - 4], [cx - 3, cy - 3], [cx - 4, cy - 2]], A.pink);
  } else p.dots([[cx - 1, cy - 1], [cx + 1, cy - 1], [cx, cy], [cx - 1, cy + 1], [cx + 1, cy + 1]], A.white);
}

const SIGN = [
  '.ooooooooo.',
  'oyyyyyyyyyo',
  'oyyyyrryyyo',
  'oyyyyrryyyo',
  'oyyyyrryyyo',
  'oyyyyrryyyo',
  'oyyyyrryyyo',
  'oyyyyyyyyyo',
  'oyyyyrryyyo',
  'oyyyyrryyyo',
  'oaaaaaaaaao',
  '.ooooooooo.',
  '....oao....',
  '.....o.....',
];

/** A yellow sign with a red "!", its point at `bottom`, waiting on someone. 11 by 14. @param {import('./pixels.js').Pixels} p @param {number} cx @param {number} bottom */
export function sign(p, cx, bottom) {
  p.sprite(cx - 5, bottom - SIGN.length + 1, SIGN, { o: INK, y: A.yellow, r: A.red, a: A.amber });
  p.dots([[cx - 4, bottom - 12], [cx - 4, bottom - 11]], A.white);
}

/** A grey puff of smoke, `size` 1 to 3. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} size */
export function puff(p, x, y, size) {
  const m = new Mask();
  if (size <= 1) m.rect(x, y, 2, 2);
  else if (size === 2) m.blob(x + 0.5, y + 0.5, 2.2, 1.8).blob(x + 2.5, y + 0.5, 1.6, 1.6);
  else m.blob(x + 0.5, y + 0.5, 2.8, 2.3).blob(x + 3, y + 1, 2, 1.6).blob(x - 2, y + 1, 1.6, 1.4);
  p.shape(m, A.grey, A.slate);
  if (size >= 2) p.px(x - 1, y - 1, A.white);
}

/** A four-pointed sparkle; 0 is a single glint. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} size */
export function star(p, x, y, size) {
  if (size <= 0) {
    p.px(x, y, A.yellow);
    return;
  }
  p.dots([[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]], A.yellow);
  if (size >= 2) p.dots([[x - 2, y], [x + 2, y], [x, y - 2], [x, y + 2]], A.amber);
  p.px(x, y, A.white);
}

/** Pieces of confetti, as [column, frame it starts falling, colour index, sway]. @type {[number, number, number, number][]} */
const PIECES = [
  [4, 0, 0, 1], [12, 3, 1, -1], [20, 1, 2, 1], [29, 5, 3, -1], [37, 2, 4, 1], [45, 6, 5, -1],
  [53, 1, 0, 1], [60, 4, 6, -1], [8, 12, 2, -1], [17, 15, 4, 1], [26, 11, 5, -1], [34, 16, 1, 1],
  [42, 13, 3, -1], [50, 17, 6, 1], [57, 14, 2, -1], [2, 18, 1, 1],
];
const CONFETTI = [A.yellow, A.pink, A.cyan, A.green, A.violet, A.orange, A.red];

/**
 * Confetti falling over the whole picture, `age` frames after it was thrown, and
 * gone by the floor.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} age @param {number} floor
 */
export function confetti(p, age, floor) {
  for (const [x0, start, hue, sway] of PIECES) {
    const t = age - start;
    if (t < 0) continue;
    const y = Math.floor(t * 1.5);
    if (y > floor - 2) continue;
    const x = x0 + (Math.floor(t / 3) % 2 === 0 ? 0 : sway);
    const colour = CONFETTI[hue];
    // It tumbles: lying flat, then on its edge.
    if (Math.floor(t / 2) % 2 === 0) p.rect(Math.min(x, 62), y, 2, 1, colour);
    else p.rect(x, y, 1, 2, colour);
  }
}

/**
 * A nightcap on the head, fitted by the creature's `cap` anchor: its band's left end,
 * the row it sits on, its width, and which way the tip falls.
 *
 * @param {import('./pixels.js').Pixels} p @param {{ x: number, y: number, w: number, tip: number }} cap
 */
export function nightcap(p, { x, y, w, tip }) {
  // Drawn falling to the right, then turned if it falls the other way: a cone that
  // leans as it narrows, and an end too long to stand that flops over and hangs.
  const cone = new Mask();
  const h = Math.max(6, Math.round(w * 0.8));
  for (let k = 0; k < h; k += 1) {
    const left = x + 1 + Math.round((k * (w - 1)) / h);
    const right = x + w - 2 + Math.round(k / 2);
    cone.span(y - 2 - k, Math.min(left, right), right);
  }
  const top = y - 1 - h;
  const end = x + w - 1 + Math.round((h - 1) / 2);
  cone.add(end, top).add(end + 1, top + 1).add(end + 1, top + 2);
  const band = new Mask().rect(x, y - 1, w, 2);
  // Mirrored about the band's middle column, so it still sits on the same head.
  const axis = x + Math.floor((w - 1) / 2);
  const flipped = (m) => (tip < 0 ? m.flip(axis) : m);
  p.shape(flipped(cone), A.violet, INK);
  // Stripes round it.
  for (const [px, py] of flipped(cone)) if ((py - y) % 3 === 0) p.px(px, py, A.pink);
  p.shape(flipped(band), A.white, INK);
  const ball = flipped(new Mask().blob(end + 1.5, top + 4.5, 1.6, 1.6));
  p.shape(ball, A.yellow, INK);
}

/**
 * Where a nightcap's peak is, for what rises from a sleeping head to start above it.
 *
 * @param {{ x: number, y: number, w: number, tip: number }} cap @returns {[number, number]}
 */
export function capPeak({ x, y, w, tip }) {
  const h = Math.max(6, Math.round(w * 0.8));
  const end = x + w - 1 + Math.round((h - 1) / 2);
  const axis = x + Math.floor((w - 1) / 2);
  return [tip < 0 ? 2 * axis - end : end, y - 1 - h];
}

/** A bubble blown from the nose as it sleeps, radius 1 to 4. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} r @param {number} side  -1 grows to the left */
export function bubble(p, x, y, r, side) {
  const cx = side < 0 ? x - r + 0.5 : x + r + 0.5;
  const m = new Mask().blob(cx, y + 0.5, r + 0.3, r + 0.3);
  p.shape(m, A.lightCyan, A.cyan);
  const b = m.bounds();
  if (b && r >= 2) p.px(b.x0 + 1, b.y0 + 1, A.white);
}

/** What is left of a bubble the moment it bursts. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} side */
export function burst(p, x, y, side) {
  const cx = x + side * 3;
  p.dots([[cx - 3, y - 2], [cx + 3, y - 2], [cx - 3, y + 2], [cx + 3, y + 2]], A.lightCyan);
  p.dots([[cx, y - 3], [cx, y + 3]], A.cyan);
}

const ZEES = {
  small: ['####', '..#.', '.#..', '####'],
  big: ['#####', '...#.', '..#..', '.#...', '#####'],
};

/** A sleepy z, small or big. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {boolean} big */
export function zee(p, x, y, big) {
  p.shape(new Mask().rows(x, y, big ? ZEES.big : ZEES.small), A.white, INK);
}

/** A progress bar, `filled` of `w` across. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} w @param {number} filled @param {string} colour */
export function progress(p, x, y, w, filled, colour) {
  p.shape(new Mask().rect(x, y, w, 2), A.slate, INK);
  if (filled > 0) p.rect(x, y, Math.min(w, filled), 2, colour);
}

/** Where the baton points, by beat: up and to the left, then up. @type {[number, number][][]} */
const SWINGS = [
  [[-1, -1], [-2, -2], [-3, -3], [-4, -4], [-5, -5]],
  [[-1, -1], [-1, -2], [-2, -3], [-2, -4], [-3, -5], [-3, -6]],
  [[0, -1], [0, -2], [-1, -3], [-1, -4], [-1, -5], [-1, -6]],
];

/** A conductor's baton held at `x, y`, swung by beat 0 to 2, a star at its tip. @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} beat */
export function baton(p, x, y, beat) {
  const path = SWINGS[beat % SWINGS.length];
  for (const [dx, dy] of path) p.px(x + dx, y + dy, INK);
  const [tx, ty] = path[path.length - 1];
  star(p, x + tx, y + ty - 1, 1);
}
