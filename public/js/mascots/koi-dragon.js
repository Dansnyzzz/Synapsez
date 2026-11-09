import { ACCENTS, Mask } from './pixels.js';

/**
 * The koi turning dragon, worn for first place on a board (owner, 2026-11-08): the
 * most ornate of all the creatures. A red koi resting on the floor, facing left, its
 * scales caught by a wave of gold that rolls from head to tail; a dragon's two gold
 * horns, a row of gold spines down its back, gold whiskers curling from its snout,
 * long flowing fins, and a pearl in a flame floating over its tail with sparkles
 * about it. Drawn from scratch for Synapsez.
 *
 * Asleep, it lays its horns down under the nightcap.
 */

const palette = Object.freeze({
  fill: '#ef4a36',
  outline: '#5c0d12',
  belly: '#ffd977',
  shade: '#f2ad3e',
  scale: '#cc3529',
  shine: '#ff8a66',
  gold: '#ffcc33',
  goldDeep: '#d98a12',
  fin: '#ff8f6a',
  finTip: '#ffe2c4',
  pearl: '#f7f3ff',
  pearlShade: '#c7bdf2',
  eye: '#2a0508',
  shadow: '#5c0d1238',
});

const FLOOR = 58;
/** The tail's sway by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];
/** Where its sparkles are, and when each is brightest: [x, y, phase]. @type {[number, number, number][]} */
const SPARKLES = [[60, 14, 0], [45, 28, 6], [61, 56, 11]];
const TWINKLE = [0, 1, 2, 2, 1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
/** The pearl's bob over sixteen frames. */
const BOB = [0, 0, -1, -1, -1, -1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0];

/** The head, the body and the stock of the tail, as one shape. */
function bodyMask(squash) {
  const front = new Mask().blob(31, FLOOR - 9 + squash / 2, 12.5 + squash, 9 - squash / 2, 2.3);
  const rear = new Mask().blob(44, FLOOR - 7 + squash / 2, 10 + squash, 7 - squash / 2, 2);
  const stock = new Mask().blob(52, FLOOR - 11 + squash / 2, 3.5, 4);
  return front.merge(rear).merge(stock);
}

/** The highest row of a shape in a column. @param {Mask} m @param {number} x */
function topOf(m, x) {
  for (let y = 0; y < 64; y += 1) if (m.has(x, y)) return y;
  return 64;
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash, cap } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([39 + dx, FLOOR]),
    shadowW: 42,
    // With its horns up, the top of its head is the top of the horns.
    headTop: at(28, cap ? 40 : 32, true),
    headLeft: at(20, 41, true),
    emitter: at(24, 41, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(23, 46, true), at(29, 46, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(20, 49, true), at(30, 49, true)]),
    mouth: at(26, 51, true),
    nose: /** @type {[number, number, number]} */ ([17 + dx - squash, 49 + dy + squash, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(17, 56),
    cap: { x: 22 + dx, y: 42 + dy + squash, w: 13, tip: 1 },
  };
}

/** The pearl in its flame, centred on `x, y`; the flame's tip flickers from side to side. */
function pearl(p, x, y, frame) {
  const flicker = Math.floor(frame / 2) % 2;
  const flame = new Mask().blob(x + 0.5, y + 0.5, 3.9, 3.9).span(y - 4, x - 1, x + 1).span(y - 5, x - 1 + flicker, x + flicker).add(x + flicker, y - 6);
  p.shape(flame, ACCENTS.orange, palette.outline);
  p.fill(new Mask().blob(x + 0.5, y + 0.5, 3, 3).span(y - 3, x - 1, x + 1).add(x, y - 4).add(x + flicker, y - 5), palette.gold);
  const orb = new Mask().blob(x + 0.5, y + 0.5, 2.3, 2.3);
  p.shape(orb, palette.pearl, palette.pearlShade);
  p.px(x - 1, y - 1, ACCENTS.white);
  p.px(x + 1, y + 1, palette.pearlShade);
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame, cap } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // Sparkles come and go around it, each in its turn.
  for (const [sx, sy, phase] of SPARKLES) {
    const size = TWINKLE[(frame + phase) % TWINKLE.length];
    if (size < 0) continue;
    /** @type {[number, number][]} */
    const arms = [[sx - 1, sy], [sx + 1, sy], [sx, sy - 1], [sx, sy + 1]];
    if (size >= 2) arms.push([sx - 2, sy], [sx + 2, sy], [sx, sy - 2], [sx, sy + 2]);
    if (size >= 1) p.dots(arms, ACCENTS.yellow);
    p.px(sx, sy, ACCENTS.white);
  }

  // The pearl floats over the tail.
  pearl(p, 55 + dx, 25 + dy + BOB[frame % BOB.length], frame);

  const shape = bodyMask(squash);

  // The tail: a wide fork flowing back from the stock, its lobes swaying apart and
  // together, pale at the tips and gold along its rays.
  const upper = new Mask().rows(52, 35, ['........##', '.......###', '......####', '.....#####', '....######', '...#######', '..#######.', '.#######..', '#######...', '######....', '#####.....']);
  const lower = new Mask().rows(52, 46, ['######....', '#######...', '.#######..', '..#######.', '...#######', '....######', '.....#####', '......####', '.......###']);
  const veil = upper.shift(0, wag).merge(lower.shift(0, -wag));
  p.shape(move(veil), palette.fin, palette.outline);
  p.fill(move(veil.and(new Mask().rect(59, 0, 5, 64))), palette.finTip);
  const rays = new Mask();
  for (let k = 0; k < 8; k += 1) rays.add(53 + k, 44 - k + wag).add(53 + k, 47 + k - wag);
  p.fill(move(rays.and(veil)), palette.gold);

  // A row of gold spines down its back, behind it.
  const spines = new Mask();
  for (const x of [37, 41, 45]) {
    const top = topOf(shape, x);
    spines.add(x + 2, top - 3).span(top - 2, x + 1, x + 2).span(top - 1, x, x + 2).span(top, x, x + 3);
  }
  p.shape(move(spines), palette.gold, palette.outline);
  p.fill(move(spines.edge(1, 0)), palette.goldDeep);

  // Two horns like a stag's, swept back with a tine forward; a nightcap takes their place.
  if (!cap) {
    const horns = new Mask();
    for (const x of [24, 30]) horns.rows(x, 32 + squash, ['....#', '...#.', '#.#..', '.##..', '.#...', '.#...', '.#...', '.#...']);
    p.shape(move(horns), palette.gold, palette.outline);
    p.fill(move(new Mask().add(25, 37 + squash).add(25, 38 + squash).add(31, 37 + squash).add(31, 38 + squash)), palette.goldDeep);
  }

  p.shape(move(shape), palette.fill, palette.outline);
  // Light along the top of its head.
  p.fill(move(new Mask().span(41 + squash, 23, 30).span(42 + squash, 22, 22).and(shape)), palette.shine);

  // The belly: gold, with a deeper band where it meets the floor.
  const belly = shape.and(new Mask().blob(31, FLOOR + 1, 14 + squash, 7.5));
  p.fill(move(belly), palette.belly);

  // Scales from behind the head to the tail, each a shallow cup, and a slanting wave of
  // gold rolling along them from head to tail.
  const inside = new Mask().merge(shape).cut(shape.inner());
  const scales = new Mask();
  const glint = new Mask();
  const wave = 50 + (frame % 16) * 2;
  for (const [x, y] of inside) {
    if (x < 34 || belly.has(x, y) || belly.has(x, y + 1)) continue;
    const row = Math.floor((y - squash) / 3);
    const u = (x + (row % 2) * 2) % 4;
    const v = (y - squash) % 3;
    const t = x + Math.floor((y - squash) / 2) - wave;
    if (t >= 0 && t <= 2) glint.add(x, y);
    if ((v === 0 && u === 0) || (v === 1 && u > 0)) scales.add(x, y);
  }
  p.fill(move(new Mask().merge(scales).cut(glint)), palette.scale);
  p.fill(move(glint.and(scales)), palette.gold);
  p.fill(move(glint.cut(scales)), palette.shine);

  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);

  // Gold whiskers curling forward and up from its snout, swaying with the beat.
  const sway = beat % 2;
  /** @type {[number, number][]} */
  const whiskers = [
    [18, 43], [17, 43], [16, 42], [15, 42], [14, 41 + sway],
    [21, 41], [20, 40], [19, 39], [18, 39], [17, 38 + sway],
  ];
  p.dots(whiskers.map(([x, y]) => /** @type {[number, number]} */ ([x + dx, y + dy + squash])), palette.gold);

  // The long front fin, flowing back; it taps as it writes.
  const fin = new Mask().rows(31, 51 + tap, ['##........', '.####.....', '..######..', '....######', '......####']);
  p.shape(move(fin), palette.fin, palette.outline);
  p.fill(move(fin.and(new Mask().rect(38, 0, 26, 64))), palette.finTip);
  p.fill(move(new Mask().span(52 + tap, 33, 35).span(53 + tap, 35, 38).span(54 + tap, 38, 40).and(fin)), palette.gold);
}

/**
 * A small one, horned too, about 14 by 10, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 3, y - 7 + wag, ['...#', '..##', '.##.', '##..', '.##.', '..##']), palette.fin, palette.outline);
  const m = new Mask().blob(x - 0.5, y - 3.5, 4.8, 3.2);
  p.shape(new Mask().add(x - 3, y - 7).add(x - 2, y - 8).add(x, y - 7).add(x + 1, y - 8), palette.gold, palette.outline);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 6, y - 2, 7, 2)), palette.belly);
  p.dots([[x + 1, y - 5], [x + 2, y - 4]], palette.scale);
  p.px(x - 4, y - 4, palette.eye);
  p.px(x - 1, y - 4, palette.eye);
}

export default Object.freeze({ id: 'koi-dragon', pet: 'pet-koi-dragon', palette, anchors, body, mini });
