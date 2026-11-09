import { ACCENTS, Mask } from './pixels.js';

/**
 * The bronze seahorse, worn for ten dollars spent (owner, 2026-11-08): upright, facing
 * left, a long snout, a small crown of knobs, a ringed pale belly, a fan of a dorsal fin
 * that flutters, and its tail curled under it on the floor. A coin spins beside it: the
 * first of the spending titles. Drawn from scratch for Synapsez.
 *
 * It stands on its tail's curl (row 58). Squashed, its head drops and its belly widens;
 * the curl stays put.
 */

const palette = Object.freeze({
  fill: '#cd8a4e',
  outline: '#4b2410',
  belly: '#f8dbb4',
  shade: '#eab27c',
  deep: '#a5602c',
  fin: '#f4c495',
  shine: '#e9a56a',
  eye: '#2a1206',
  shadow: '#4b241038',
});

const FLOOR = 58;
/** The dorsal fin's flutter by beat: its outer edge out, in, out, further out. */
const FLUTTER = [0, -1, 0, 1];
/** The coin turning, by step: face on, edge on and back. Each is its rows of width. */
const COIN = [
  ['.###.', '#####', '#####', '#####', '.###.'],
  ['.##.', '####', '####', '####', '.##.'],
  ['.#.', '###', '###', '###', '.#.'],
  ['#', '#', '#', '#', '#'],
  ['.#.', '###', '###', '###', '.#.'],
  ['.##.', '####', '####', '####', '.##.'],
];

/** The tail from under the belly, down and round into a curl on the floor. */
const TAIL = [
  '.......######.',
  '........#####.',
  '.........####.',
  '..####...####.',
  '.##..##.####..',
  '.#..##.####...',
  '.##....####...',
  '..########....',
];

/** The head, the neck and the belly, as one shape. */
function bodyMask(squash) {
  const head = new Mask().blob(41.5, 31.5 + squash, 5.5, 4.8, 2.2);
  // A thin snout with a small flared mouth at its end.
  const snout = new Mask().rect(31, 32 + squash, 6, 2).rect(29, 31 + squash, 2, 3);
  const crown = new Mask().rows(40, 25 + squash, ['#.#.#', '#####']);
  const neck = new Mask().blob(43.5, 37.5 + squash / 2, 4, 3.6);
  const trunk = new Mask().blob(41.5, 45 + squash / 2, 6.8 + squash, 6.6 - squash / 2, 2.2);
  return head.merge(snout).merge(crown).merge(neck).merge(trunk);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([41 + dx, FLOOR]),
    shadowW: 24,
    headTop: at(42, 25, true),
    headLeft: at(36, 28, true),
    emitter: at(42, 26, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(38, 29, true), at(42, 29, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(36, 32, true), at(43, 32, true)]),
    mouth: at(30, 32, true),
    nose: /** @type {[number, number, number]} */ ([28 + dx, 32 + dy + squash, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(33, 42),
    cap: { x: 36 + dx, y: 28 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame, cap } = pose;
  const flutter = FLUTTER[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // The coin, turning beside it; still while it sleeps.
  const turn = cap ? 0 : Math.floor(frame / 2) % COIN.length;
  const rows = COIN[turn];
  const coin = new Mask().rows(56 - Math.floor(rows[0].length / 2), 30, rows);
  p.shape(move(coin), ACCENTS.yellow, palette.outline);
  if (rows[0].length >= 3) p.fill(move(coin.edge(1, 0)), ACCENTS.amber);
  if (rows[0].length >= 4) p.px(55 + dx, 31 + dy, ACCENTS.white);

  // The dorsal fin, a fan off its back.
  const fin = new Mask().rows(48, 40 + squash, ['##..', '###.', '####', '####', '###.', '##..']);
  for (const y of [41, 42, 43, 44]) fin.add(52 + flutter, y + squash);
  p.shape(move(fin), palette.fin, palette.outline);
  p.fill(move(new Mask().span(41 + squash, 49, 50).span(43 + squash, 49, 51).span(45 + squash, 49, 50)), palette.shade);

  // The body runs on into the tail: one shape, no line where they meet.
  const tail = new Mask().rows(33, 50, TAIL);
  const shape = bodyMask(squash).merge(tail);
  p.shape(move(shape), palette.fill, palette.outline);
  // Rings down the tail.
  p.fill(move(new Mask().span(52, 42, 46).span(55, 40, 44).add(36, 53).add(34, 55).and(tail)), palette.deep);
  // A knob on its back above the fin and one below.
  const spines = new Mask();
  for (const y of [37, 48]) {
    let edge = 40;
    while (shape.has(edge + 1, y + squash)) edge += 1;
    spines.add(edge + 1, y + squash);
  }
  p.shape(move(spines), palette.deep, palette.outline);

  // The ringed belly, pale, a plate every second row.
  const belly = shape.and(new Mask().blob(37.5, 45.5 + squash / 2, 5.2 + squash, 7));
  p.fill(move(belly), palette.belly);
  for (let y = 39; y <= 52; y += 2) p.fill(move(new Mask().span(y + squash, 30, 44).and(belly)), palette.shade);
  p.fill(move(belly.shift(0, 0).cut(belly.shift(2, -1))), palette.shade);
  // Light along its brow and snout.
  p.fill(move(new Mask().span(27 + squash, 39, 43).span(32 + squash, 31, 35).and(shape)), palette.shine);

  // A small front fin, at its chest, tapping as it writes.
  const front = new Mask().rows(33, 41 + tap, ['.##', '###', '##.']);
  p.shape(move(front), palette.fin, palette.outline);
}

/**
 * A small one, about 9 by 11, standing on `y`: upright, snout to the left, its tail
 * curled under.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const sway = Math.floor(frame / 3) % 2;
  const m = new Mask()
    .rows(x - 4, y - 10, ['....##..', '.######.', '#######.', '...####.', '...#####', '...#####', '....###.', '....##..', '..#.##..', '...##...'])
    .shift(sway, 0);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 1 + sway, y - 7, 2, 4)), palette.belly);
  p.px(x - 1 + sway, y - 9, palette.eye);
  p.px(x + 2 + sway, y - 5, palette.fin);
}

export default Object.freeze({ id: 'seahorse', pet: 'pet-seahorse', palette, anchors, body, mini });
