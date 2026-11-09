import { Mask } from './pixels.js';

/**
 * The newcomer's minnow (owner, 2026-11-08): the first title anyone wears, so the
 * plainest creature. A small blue fish resting on its belly, facing left, a forked
 * tail behind, two fins and a lateral line. Drawn from scratch for Synapsez.
 *
 * Rows from the floor up: the body stands on row 58 (its outline), so the 64-pixel
 * square keeps rows 0 to 40 and the columns left of 21 free for the props.
 */

const palette = Object.freeze({
  fill: '#4cb8e8',
  outline: '#163a63',
  belly: '#eefaff',
  shade: '#b5e3f7',
  fin: '#8fdcf5',
  stripe: '#3a9bd0',
  eye: '#0f1d33',
  shadow: '#163a6338',
});

/** Where the floor is: the body's outline sits on it. */
const FLOOR = 58;

/** The tail's wag by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];

/** The body as it stands in a pose, before it is moved by `dx, dy`. */
function bodyMask(squash) {
  const front = new Mask().blob(33, FLOOR - 8 + squash / 2, 11 + squash, 8 - squash / 2, 2.2);
  const rear = new Mask().blob(43, FLOOR - 6.5 + squash / 2, 9 + squash, 6.5 - squash / 2, 2);
  return front.merge(rear);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([37 + dx, FLOOR]),
    shadowW: 30,
    headTop: at(30, 41, true),
    headLeft: at(23, 44, true),
    emitter: at(29, 41, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(27, 47, true), at(31, 47, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(25, 50, true), at(32, 50, true)]),
    mouth: at(29, 51, true),
    nose: /** @type {[number, number, number]} */ ([20 + dx - squash, 51 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([19, FLOOR]),
    fin: at(20, 53),
    cap: { x: 24 + dx, y: 43 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);

  const tail = new Mask().rows(48, 42 + wag, [
    '.......##',
    '......###',
    '.....####',
    '....####.',
    '...####..',
    '..####...',
    '.####....',
    '####.....',
    '.####....',
    '..####...',
    '...####..',
    '....####.',
    '.....###.',
    '......##.',
  ]);
  p.shape(move(tail), palette.fin, palette.outline);
  // A darker ray down each lobe.
  p.fill(move(new Mask().add(54, 44 + wag).add(53, 45 + wag).add(53, 52 + wag).add(54, 53 + wag)), palette.stripe);

  const dorsal = new Mask().rows(35, 38 + squash, ['..##....', '.####...', '.######.']);
  p.shape(move(dorsal), palette.fin, palette.outline);

  const shape = bodyMask(squash);
  p.shape(move(shape), palette.fill, palette.outline);
  const belly = shape.and(new Mask().blob(31, FLOOR + 0.5, 11.5 + squash, 6.5));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);
  // The lateral line, from behind the gill to the tail.
  p.fill(move(new Mask().span(50, 41, 49).and(shape)), palette.stripe);
  // A glint along the top, to say it is wet.
  p.fill(move(new Mask().span(43 + squash, 27, 30).add(26, 44 + squash)), palette.fin);

  const pectoral = new Mask().rows(39, 52 + tap, ['##..', '.###', '..##']);
  p.shape(move(pectoral), palette.fin, palette.outline);
}

/**
 * A small one, for when it conducts others like it: about 13 by 8, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 3, y - 6 + wag, ['..#', '.##', '##.', '.##', '..#']), palette.fin, palette.outline);
  const m = new Mask().blob(x - 0.5, y - 3.5, 4.6, 2.9);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 5, y - 2, 6, 2)), palette.belly);
  p.px(x - 3, y - 4, palette.eye);
  p.px(x - 1, y - 4, palette.eye);
}

export default Object.freeze({ id: 'minnow', pet: 'pet-minnow', palette, anchors, body, mini });
