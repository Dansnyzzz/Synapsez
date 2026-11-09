import { ACCENTS, Mask } from './pixels.js';

/**
 * The leafy sea dragon, worn for a hundred million tokens (owner, 2026-11-08): a long
 * olive-gold body facing left, a long thin snout, violet bars across its back, its tail
 * curled under it on the floor, and lobed leaves all over it: on its head, along its
 * back, hanging from its belly and off its tail. The leaves sway, and a light runs
 * along them from head to tail. Drawn from scratch for Synapsez.
 *
 * It rests on its belly leaves and its tail's curl (row 58); its face is on the head at
 * the left, the snout reaching to column 20.
 */

const palette = Object.freeze({
  fill: '#cfc24e',
  outline: '#383b12',
  belly: '#f6f0c4',
  shade: '#e6db8a',
  leaf: '#6cbd55',
  vein: '#3f8c3f',
  glow: '#c8f27c',
  band: '#9a76d6',
  eye: '#1c1e08',
  shadow: '#383b1238',
});

const FLOOR = 58;
/** A leaf's sway by beat: still, left, still, right. */
const SWAY = [0, -1, 0, 1];

/** A lobed leaf, five across and seven tall: three lobes a side, a point at each end. */
const LEAF = ['..#..', '.###.', '#####', '.###.', '#####', '.###.', '..#..'];
/** A small one, for the head and the snout. */
const SPRIG = ['.#.', '###', '.#.', '###', '.#.'];

/**
 * A leaf on a stalk: its foot at `x, y`, the stalk `stalk` long, standing up (`dir` -1)
 * or hanging (1). The far half of it leans by `lean`.
 *
 * @returns {{ leaf: Mask, vein: Mask, tips: Mask }}
 */
function frond(x, y, stalk, dir, lean, rows = LEAF) {
  const leaf = new Mask();
  const vein = new Mask();
  const tips = new Mask();
  const half = Math.floor(rows[0].length / 2);
  for (let k = 0; k < stalk; k += 1) leaf.add(x, y + dir * k);
  rows.forEach((row, j) => {
    // Counted from the stalk outwards, so a hanging leaf is the same leaf turned over.
    const y0 = y + dir * (stalk + j);
    const shift = j >= rows.length / 2 ? lean : 0;
    for (let i = 0; i < row.length; i += 1) if (row[i] === '#') leaf.add(x - half + i + shift, y0);
    if (j > 0 && j < rows.length - 1) vein.add(x + shift, y0);
    // The ends of the lobes and the point catch the light.
    if (!row.includes('.')) tips.add(x - half + shift, y0).add(x + half + shift, y0);
    if (j === rows.length - 1) tips.add(x + shift, y0);
  });
  return { leaf, vein, tips };
}

/** Every leaf, from head to tail: [foot x, foot y, stalk, direction, small]. @type {[number, number, number, number, boolean][]} */
const FRONDS = [
  [31, 35, 0, -1, false],
  [36, 38, 1, -1, true],
  [42, 41, 1, -1, false],
  [49, 43, 1, -1, false],
  [56, 47, 1, -1, true],
  [24, 41, 1, 1, true],
  [40, 49, 1, 1, false],
  [48, 49, 1, 1, false],
];

/** The tail, from the end of the back, down and round into a curl on the floor. */
const TAIL = [
  '###.......',
  '.####.....',
  '...####...',
  '.....####.',
  '......####',
  '.......###',
  '..###..###',
  '.##..#.###',
  '.#..##.##.',
  '.##....##.',
  '..######..',
];

/** The head, the snout and the body, as one shape. */
function bodyMask(squash) {
  const s = squash;
  const head = new Mask().blob(30.5, 39.5 + s / 2, 5.5 + s, 4.6 - s / 2, 2);
  const snout = new Mask().rect(22, 39 + s, 4, 2).rect(20, 38 + s, 2, 3);
  const neck = new Mask().blob(36.5, 43 + s / 2, 3, 3.4 - s / 2);
  const chest = new Mask().blob(42, 45 + s / 2, 6 + s, 3.9 - s / 2, 2.2);
  const back = new Mask().blob(49.5, 45.8 + s / 2, 4.5 + s, 3 - s / 2);
  return head.merge(snout).merge(neck).merge(chest).merge(back).merge(new Mask().rows(52, 47, TAIL));
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([41 + dx, FLOOR]),
    shadowW: 38,
    headTop: at(31, 29, true),
    headLeft: at(26, 35, true),
    emitter: at(28, 35, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(28, 38, true), at(32, 38, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(25, 41, true), at(33, 41, true)]),
    mouth: at(21, 39, true),
    nose: /** @type {[number, number, number]} */ ([19 + dx, 39 + dy + squash, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(33, 47),
    cap: { x: 25 + dx, y: 37 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const sway = SWAY[beat % 4];
  const move = (m) => m.shift(dx, dy);
  // The light along the leaves, one at a time from head to tail, then a rest.
  const lit = Math.floor(frame / 4) % (FRONDS.length + 4);

  FRONDS.forEach(([x, y, stalk, dir, small], i) => {
    // What stands on the back drops with it when squashed; what hangs stays on the floor.
    // Every leaf is swept back (to the right) a pixel, and sways about that.
    const { leaf, vein, tips } = frond(x, y + (dir < 0 ? squash : 0), stalk, dir, 1 + (dir < 0 ? sway : -sway), small ? SPRIG : LEAF);
    const on = i === lit;
    p.shape(move(leaf), on ? palette.glow : palette.leaf, palette.outline);
    p.fill(move(tips), on ? ACCENTS.white : palette.glow);
    p.fill(move(vein), on ? palette.leaf : palette.vein);
  });

  const shape = bodyMask(squash);
  p.shape(move(shape), palette.fill, palette.outline);

  // The pale underside, and its shade.
  const belly = shape.and(new Mask().blob(40, 50 + squash / 2, 15 + squash, 5)).cut(new Mask().rect(53, 0, 11, 64));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.shift(0, 0).cut(belly.shift(2, -1))), palette.shade);
  // Violet bars across the back, and down the tail.
  const bars = new Mask();
  for (const x of [39, 43, 47, 51]) for (let y = 38; y <= 48; y += 1) bars.add(x, y);
  p.fill(move(bars.and(shape).cut(belly)), palette.band);
  p.fill(move(new Mask().span(50, 57, 60).span(53, 59, 61).and(shape)), palette.band);
  // Light along the brow and the snout.
  p.fill(move(new Mask().span(36 + squash, 28, 31).add(27, 37 + squash).span(39 + squash, 22, 24).and(shape)), palette.belly);

  // A small fin behind the head, tapping as it writes.
  const fin = new Mask().rows(32, 45 + tap, ['.##', '###', '##.']);
  p.shape(move(fin), palette.leaf, palette.outline);
  // The odd glint off a leaf.
  if (frame % 16 === 8) p.px(42 + dx + sway, 33 + dy + squash, ACCENTS.white);
}

/**
 * A small one, about 14 by 10, standing on `y`: snout to the left, a leaf up, its tail
 * curled.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const sway = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x - 1 + sway, y - 9, ['.#.', '###', '.#.']), palette.leaf, palette.outline);
  const m = new Mask().rows(x - 6, y - 6, ['.....####...', '#######.##..', '.....#####..', '......######', '.........#.#', '..........##']);
  p.shape(m, palette.fill, palette.outline);
  p.px(x - 1, y - 5, palette.eye);
  p.fill(m.and(new Mask().rect(x - 1, y - 4, 5, 1)), palette.belly);
}

export default Object.freeze({ id: 'sea-dragon', pet: 'pet-seadragon', palette, anchors, body, mini });
