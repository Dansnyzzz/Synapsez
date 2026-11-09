import { ACCENTS, Mask } from './pixels.js';

/**
 * The bronze dolphin, worn for third place on a board (owner, 2026-11-08): a dolphin
 * resting on the floor, facing left, cast in bronze. A round brow over a short beak,
 * a darker back, a pale copper belly, a curved dorsal fin, its tail lifted with the
 * flukes up, a light that runs along its back and one glint. The plainest of the
 * three places, as third should be. Drawn from scratch for Synapsez.
 */

const palette = Object.freeze({
  fill: '#cc8640',
  outline: '#4a2a10',
  belly: '#f0c287',
  shade: '#dc9e5e',
  back: '#97561f',
  shine: '#ffd394',
  gleam: '#fff1d9',
  eye: '#2a1606',
  shadow: '#4a2a1038',
});

const FLOOR = 58;
/** The tail's lift by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];
const TWINKLE = [0, 1, 2, 2, 1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

/** The round brow and the body, rising at the back into the tail. */
function bodyMask(squash) {
  const brow = new Mask().blob(32, FLOOR - 8 + squash / 2, 8.5 + squash, 8 - squash / 2, 2);
  const trunk = new Mask().blob(41, FLOOR - 6.5 + squash / 2, 13 + squash, 6.5 - squash / 2, 2.1);
  const haunch = new Mask().blob(50, FLOOR - 8 + squash / 2, 5, 6 - squash / 2);
  return brow.merge(trunk).merge(haunch);
}

/** The beak, below the brow, drawn first so the brow's outline parts them. */
const BEAK = ['.#######', '########', '.#######'];

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([39 + dx, FLOOR]),
    shadowW: 38,
    headTop: at(30, 41, true),
    headLeft: at(25, 44, true),
    emitter: at(28, 43, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(28, 48, true), at(34, 48, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(25, 50, true), at(35, 50, true)]),
    mouth: at(31, 52, true),
    nose: /** @type {[number, number, number]} */ ([17 + dx, 53 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(18, 57),
    cap: { x: 26 + dx, y: 44 + dy + squash, w: 11, tip: -1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // One glint, now and then.
  const size = TWINKLE[frame % TWINKLE.length];
  if (size >= 0) {
    /** @type {[number, number][]} */
    const arms = [[51, 30], [53, 30], [52, 29], [52, 31]];
    if (size >= 2) arms.push([50, 30], [54, 30], [52, 28], [52, 32]);
    if (size >= 1) p.dots(arms, ACCENTS.yellow);
    p.px(52, 30, ACCENTS.white);
  }

  // The tail stock rising from the back, and the flukes held up.
  const stock = new Mask().blob(54, 47 + wag / 2, 3, 4).blob(56, 43 + wag, 2.2, 3);
  p.shape(move(stock), palette.fill, palette.outline);
  const flukes = new Mask().rows(51, 36 + wag, ['##.......##', '###.....###', '.###...###.', '..#######..', '...#####...', '....###....']);
  p.shape(move(flukes), palette.fill, palette.outline);
  p.fill(move(flukes.edge(0, -1).and(flukes)), palette.back);

  // The dorsal fin, curved back, behind the body.
  const dorsal = new Mask().rows(41, 38 + squash, ['.....#', '....##', '...###', '..####', '.#####', '######', '#######']);
  p.shape(move(dorsal), palette.back, palette.outline);
  p.fill(move(new Mask().add(45, 39 + squash).add(44, 40 + squash).add(43, 41 + squash).add(42, 42 + squash).and(dorsal)), palette.fill);

  const beak = new Mask().rows(19, 52, BEAK);
  p.shape(move(beak), palette.fill, palette.outline);
  p.fill(move(beak.and(new Mask().rect(0, 54, 64, 1))), palette.belly);

  const shape = bodyMask(squash);
  p.shape(move(shape), palette.fill, palette.outline);
  // The darker back, over the body but not the face.
  const back = new Mask().merge(shape).cut(shape.shift(0, 4)).cut(new Mask().rect(0, 0, 38, 64));
  p.fill(move(back), palette.back);
  // Light on its round brow.
  p.fill(move(new Mask().span(43 + squash, 29, 33).span(44 + squash, 27, 28).add(26, 45 + squash).and(shape)), palette.shine);
  p.fill(move(new Mask().add(29, 44 + squash).add(30, 44 + squash).add(28, 45 + squash).and(shape)), palette.gleam);

  // A light running along its back, head to tail, over sixteen frames.
  const run = 34 + (frame % 16) * 2;
  p.fill(move(shape.edge(0, -1).and(back.shift(0, 1)).and(new Mask().rect(run, 0, 3, 64)).merge(back.and(new Mask().rect(run, 0, 3, 64)).edge(0, -1))), palette.shine);

  // The belly, pale copper, and the shade where it meets the floor.
  const belly = shape.and(new Mask().blob(38, FLOOR + 1.5, 16 + squash, 6.5));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);

  // The flipper, swept back; it taps as it writes.
  const flipper = new Mask().rows(37, 52 + tap, ['##.....', '.####..', '..#####', '....###']);
  p.shape(move(flipper), palette.back, palette.outline);
  p.fill(move(new Mask().span(52 + tap, 37, 38).span(53 + tap, 39, 40).and(flipper)), palette.fill);
}

/**
 * A small one, about 14 by 10, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 3, y - 8 + wag, ['#..#', '####', '.##.', '.##.', '.##.']), palette.fill, palette.outline);
  p.shape(new Mask().rows(x, y - 8, ['..#', '.##', '###']), palette.back, palette.outline);
  const m = new Mask().blob(x - 0.5, y - 3, 4.6, 3).merge(new Mask().rect(x - 7, y - 2, 2, 1));
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 7, y - 2, 12, 2)), palette.belly);
  p.px(x - 4, y - 4, palette.eye);
  p.px(x - 1, y - 4, palette.eye);
}

export default Object.freeze({ id: 'bronze-dolphin', pet: 'pet-bronze-dolphin', palette, anchors, body, mini });
