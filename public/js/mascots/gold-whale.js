import { ACCENTS, Mask } from './pixels.js';

/**
 * The golden whale, worn for a thousand dollars spent (owner, 2026-11-08): the most
 * ornate of the first three. Solid gold with a light catching its back, a crown with
 * three pearls and three stones, the grooves of a humpback's throat, a long fin and
 * sparkles that come and go around it. Drawn from scratch for Synapsez.
 *
 * Asleep, it takes the crown off for the nightcap.
 */

const palette = Object.freeze({
  fill: '#f2b33d',
  outline: '#6e3d08',
  belly: '#fff2c7',
  shade: '#f5d27a',
  shine: '#ffe48a',
  deep: '#d18a1c',
  eye: '#3b1f04',
  shadow: '#6e3d0838',
});

const FLOOR = 58;
/** The tail's lift by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];
/** Where its sparkles are, and when each is brightest: [x, y, phase]. @type {[number, number, number][]} */
const SPARKLES = [[61, 52, 0], [47, 28, 5], [58, 24, 10], [18, 42, 15]];
const TWINKLE = [0, 1, 2, 2, 1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

/** The head, the back and the stock of the tail, as one shape. */
function bodyMask(squash) {
  const head = new Mask().blob(34, FLOOR - 11.5 + squash / 2, 14 + squash, 11.5 - squash / 2, 2.4);
  const rear = new Mask().blob(46, FLOOR - 8 + squash / 2, 9 + squash, 8 - squash / 2, 2);
  return head.merge(rear);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash, cap } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([38 + dx, FLOOR]),
    shadowW: 36,
    // With its crown on, the top of its head is the top of the crown.
    headTop: at(34, cap ? 34 : 25, true),
    headLeft: at(23, 37, true),
    // In front of the crown, so what rises from its head is not hidden behind it.
    emitter: at(24, 37, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(24, 44, true), at(30, 44, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(21, 47, true), at(31, 47, true)]),
    mouth: at(27, 48, true),
    nose: /** @type {[number, number, number]} */ ([18 + dx - squash, 49 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(18, 53),
    cap: { x: 28 + dx, y: 36 + dy + squash, w: 13, tip: 1 },
  };
}

/** The crown: a band, three points, a pearl on each, a stone in each bay. */
function crown(p, x0, base) {
  const m = new Mask()
    .rect(x0, base - 2, 13, 3)
    .span(base - 3, x0, x0 + 2)
    .span(base - 3, x0 + 4, x0 + 8)
    .span(base - 3, x0 + 10, x0 + 12)
    .span(base - 4, x0, x0 + 1)
    .span(base - 4, x0 + 5, x0 + 7)
    .span(base - 4, x0 + 11, x0 + 12)
    .add(x0, base - 5)
    .span(base - 5, x0 + 5, x0 + 7)
    .add(x0 + 12, base - 5)
    .add(x0 + 6, base - 6);
  p.shape(m, ACCENTS.yellow, palette.outline);
  p.rect(x0, base, 13, 1, ACCENTS.amber);
  p.dots([[x0 + 5, base - 4], [x0 + 1, base - 2], [x0 + 6, base - 5]], ACCENTS.white);
  for (const [px, py] of /** @type {[number, number][]} */ ([[x0, base - 7], [x0 + 6, base - 8], [x0 + 12, base - 7]])) {
    p.shape(new Mask().add(px, py), ACCENTS.white, palette.outline);
  }
  p.rect(x0 + 6, base - 2, 1, 2, ACCENTS.red);
  p.px(x0 + 3, base - 1, ACCENTS.cyan);
  p.px(x0 + 9, base - 1, ACCENTS.cyan);
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame, cap } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // Sparkles come and go around it, each in its turn.
  for (const [sx, sy, phase] of SPARKLES) {
    const size = TWINKLE[(frame + phase) % TWINKLE.length];
    if (size >= 0) p.dots(starPixels(sx, sy, size), size >= 1 ? ACCENTS.yellow : ACCENTS.white);
    if (size >= 1) p.px(sx, sy, ACCENTS.white);
  }

  // The stock of the tail rises from the back to the flukes.
  const stock = new Mask().blob(52.5, 47 + wag / 2, 3.4, 5).blob(55, 41 + wag, 2.6, 3.6);
  p.shape(move(stock), palette.fill, palette.outline);
  const flukes = new Mask().rows(49, 31 + wag, [
    '##.........##',
    '####.....####',
    '.#####.#####.',
    '..#########..',
    '....#####....',
    '.....###.....',
  ]);
  p.shape(move(flukes), palette.fill, palette.outline);
  p.fill(move(new Mask().span(32 + wag, 51, 52).span(32 + wag, 58, 59).span(33 + wag, 53, 54).span(33 + wag, 56, 57)), palette.shine);

  const shape = bodyMask(squash);
  p.shape(move(shape), palette.fill, palette.outline);
  // Light along the top of its head and back.
  p.fill(move(shape.edge(0, -1).and(new Mask().rect(0, 0, 64, 44 + squash)).cut(new Mask().rect(48, 0, 16, 64))), palette.shine);
  p.fill(move(new Mask().span(37 + squash, 24, 27).span(38 + squash, 23, 24)), palette.shine);

  // The throat: cream, with the grooves of a humpback running back from the chin.
  const belly = shape.and(new Mask().blob(31, FLOOR + 1, 13.5 + squash, 8));
  p.fill(move(belly), palette.belly);
  const grooves = new Mask().span(52, 25, 36).span(54, 23, 38).span(56, 24, 37).and(belly);
  p.fill(move(grooves), palette.shade);
  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);

  // A filigree of deeper gold along its side.
  const lace = new Mask();
  for (let x = 38; x <= 50; x += 1) lace.add(x, 47 + squash + (x % 3 === 0 ? 1 : 0));
  p.fill(move(lace.and(shape)), palette.deep);

  // The long fin, swept back, tapping as it writes.
  const fin = new Mask().rows(35, 51 + tap, ['##......', '.#####..', '..######', '....####']);
  p.shape(move(fin), palette.fill, palette.outline);
  p.fill(move(new Mask().span(51 + tap, 35, 36).span(52 + tap, 37, 39)), palette.shine);
  p.fill(move(new Mask().span(54 + tap, 40, 42)), palette.deep);

  if (!cap) crown(p, 28 + dx, 33 + dy + squash);
}

/** A sparkle's pixels, without its centre. @returns {[number, number][]} */
function starPixels(x, y, size) {
  if (size <= 0) return [[x, y]];
  /** @type {[number, number][]} */
  const out = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
  if (size >= 2) out.push([x - 2, y], [x + 2, y], [x, y - 2], [x, y + 2]);
  return out;
}

/**
 * A small one, crowned too, about 13 by 10, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 3, y - 7 - wag, ['#..#', '####', '.##.', '.##.']), palette.fill, palette.outline);
  const m = new Mask().blob(x - 0.5, y - 3.5, 4.8, 3.2);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 6, y - 2, 6, 2)), palette.belly);
  p.px(x - 4, y - 4, palette.eye);
  p.px(x - 1, y - 4, palette.eye);
  p.shape(new Mask().rows(x - 4, y - 9, ['#.#.#', '#####']), ACCENTS.yellow, palette.outline);
}

export default Object.freeze({ id: 'gold-whale', pet: 'pet-gold-whale', palette, anchors, body, mini });
