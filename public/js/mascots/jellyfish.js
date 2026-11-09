import { ACCENTS, Mask } from './pixels.js';

/**
 * The lantern jelly, worn for a million tokens (owner, 2026-11-08): a lilac bell
 * hanging over its own arms, two frilled arms in the middle and thin threads at the
 * sides, the front one curled. It looks clear through flat colours only: a pale inside
 * inside a deeper rim, the arms showing through the lower bell, a lantern glowing in
 * its crown that brightens as the bell draws in. Drawn from scratch for Synapsez.
 *
 * It floats, but its arms reach the floor (row 58), so the shadow and the props line
 * up with every other creature. Its face is on the bell, symmetric about column 38.
 */

const palette = Object.freeze({
  fill: '#b69cf2',
  outline: '#3b2870',
  belly: '#f2ebff',
  shade: '#dccdfc',
  veil: '#cbb6f7',
  arm: '#f0a8dc',
  glow: '#ffd98c',
  eye: '#21154a',
  shadow: '#3b287038',
});

const FLOOR = 58;
const CX = 38;
/** The bell's breath by beat: at rest, drawn in, at rest, let out. */
const PULSE = [0, 1, 0, -1];
/** How far each row of an arm swings, along its length: a slow wave down it. */
const WAVE = [0, 0, 1, 1, 1, 0, 0, -1, -1, -1, 0, 0];

/** The rows of the bell's margin, under the dome. */
const RIM = 45;

/** The bell: a dome, its sides falling straight to a scalloped margin. */
function bellMask(squash, pulse) {
  const top = 29 + squash;
  const rx = 13.5 + squash - pulse;
  // Its height a little short of the top row's centre, so the crown is a flat run, not a point.
  const dome = new Mask().blob(CX + 0.5, RIM, rx, RIM - top - 0.1, 2.3);
  const out = new Mask();
  for (const [x, y] of dome) if (y < RIM) out.add(x, y);
  const half = Math.floor(rx) - 1;
  out.span(RIM, CX - half, CX + half);
  // The margin's scallops: three pixels down, one up.
  for (let x = CX - half; x <= CX + half; x += 1) if ((x - CX + 64) % 4 !== 2) out.add(x, RIM + 1);
  return out;
}

/** One arm hanging from `x0`, `width` across, down to `bottom`, waving with `phase`. */
function arm(x0, top, bottom, width, phase, frill) {
  const m = new Mask();
  for (let y = top; y <= bottom; y += 1) {
    const k = y - top;
    const x = x0 + WAVE[(k + phase) % WAVE.length];
    m.span(y, x, x + width - 1);
    // A frill out to one side every other row, alternating.
    if (frill && k % 4 === 1) m.add(x - 1, y);
    if (frill && k % 4 === 3) m.add(x + width, y);
  }
  // A narrower end.
  const end = x0 + WAVE[(bottom - top + phase) % WAVE.length];
  if (width > 1) m.remove(end + width - 1, bottom);
  return m;
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([CX + dx, FLOOR]),
    shadowW: 28,
    headTop: at(CX, 29, true),
    headLeft: at(27, 33, true),
    emitter: at(CX, 30, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(34, 37, true), at(42, 37, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(30, 40, true), at(45, 40, true)]),
    mouth: at(CX, 41, true),
    nose: /** @type {[number, number, number]} */ ([23 + dx - squash, 41 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(21, 50),
    cap: { x: 33 + dx, y: 31 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const pulse = PULSE[beat % 4];
  const phase = (beat * 3) % WAVE.length;
  const move = (m) => m.shift(dx, dy);

  // The arms, behind the bell: two frilled ones in the middle, a thread at the back.
  const back = arm(48, 44, 55, 1, (phase + 6) % WAVE.length, false);
  p.shape(move(back), palette.fill, palette.outline);
  const left = arm(33, 44, 57, 3, phase, true);
  const right = arm(41, 44, 57, 3, (phase + 4) % WAVE.length, true);
  p.shape(move(left.merge(right)), palette.arm, palette.outline);

  const bell = bellMask(squash, pulse);
  p.shape(move(bell), palette.fill, palette.outline);
  // Clear inside, deeper at the rim: the pale of the bell, inset from its edge.
  const inside = bell.and(new Mask().blob(CX + 0.5, RIM - 1, 11 + squash - pulse, 13 - squash, 2.3));
  p.fill(move(inside), palette.belly);
  // (A copy: `cut` changes the mask it is called on, and `inside` is wanted again.)
  p.fill(move(inside.shift(0, 0).cut(inside.shift(2, -1))), palette.shade);
  // The arms, seen through the lower bell.
  const through = left.merge(right).shift(0, -4).and(inside).cut(new Mask().rect(0, 0, 64, 42 + squash));
  p.fill(move(through), palette.veil);
  // The lantern in its crown, brightest as the bell draws in: a halo round it then.
  const lamp = new Mask().rows(CX - 2, 31 + squash, ['.#.#.', '#####', '.###.']);
  if (pulse > 0) p.fill(move(lamp.ring().and(inside)), palette.glow);
  p.fill(move(lamp.and(bell)), pulse > 0 ? ACCENTS.yellow : palette.glow);
  if (pulse > 0) p.px(CX + dx, 32 + dy + squash, ACCENTS.white);
  // Light on the glass, upper left.
  p.fill(move(new Mask().span(32 + squash, 29, 30).add(28, 33 + squash).add(28, 34 + squash).and(bell)), ACCENTS.white);
  if (frame % 24 < 2) p.px(47 + dx, 34 + dy + squash, ACCENTS.white);

  // The front thread, curled towards the keys, tapping as it writes.
  const front = new Mask();
  for (const [x, y] of /** @type {[number, number][]} */ ([[26, 47], [25, 48], [24, 49], [23, 50], [22, 51], [21, 51], [20, 50]])) front.add(x, y + tap);
  p.shape(move(front), palette.fill, palette.outline);
}

/**
 * A small one, about 11 by 11, standing on `y`: a bell and four threads.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const sway = Math.floor(frame / 3) % 2;
  for (const [k, tx] of [x - 3, x - 1, x + 1, x + 3].entries()) {
    for (let j = 0; j < 4; j += 1) p.px(tx + ((j + k + sway) % 2), y - 3 + j, palette.outline);
  }
  const bell = new Mask();
  for (const [bx, by] of new Mask().blob(x + 0.5, y - 4, 4.5, 4.5)) if (by < y - 4) bell.add(bx, by);
  bell.span(y - 4, x - 3, x + 3);
  p.shape(bell, palette.fill, palette.outline);
  p.fill(bell.and(new Mask().rect(x - 2, y - 7, 5, 3)), palette.belly);
  p.px(x - 2, y - 6, palette.eye);
  p.px(x + 2, y - 6, palette.eye);
  p.px(x, y - 8, palette.glow);
}

export default Object.freeze({ id: 'jellyfish', pet: 'pet-jelly', palette, anchors, body, mini });
