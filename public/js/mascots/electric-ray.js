import { ACCENTS, Mask } from './pixels.js';

/**
 * The electric ray, worn for ten million tokens (owner, 2026-11-08): a teal ray resting
 * on the floor, seen from above and in front, its wings spread to two points. Lightning
 * runs along the wings and turns white as they beat, and a tail curls up behind with a
 * spark at the end. Drawn from scratch for Synapsez.
 *
 * Its face is on the front edge, in the middle, so it is symmetric about column 38.
 */

const palette = Object.freeze({
  fill: '#2fb3c4',
  outline: '#0b3c4d',
  belly: '#e3fbf8',
  shade: '#9fe3dd',
  spot: '#1f8ea0',
  eye: '#082a36',
  shadow: '#0b3c4d38',
});

const FLOOR = 58;
const CX = 38;
/** How far the wing tips lift, by beat: resting, up, resting, down. */
const FLAP = [0, 1, 0, -1];

/**
 * The outline of the ray: a rounded kite, wide and pointed at the sides, its head a
 * rounder bulge at the front. Wing tips lift with the beat.
 */
function kite(squash, flap) {
  const cy = FLOOR - 9 + squash / 2;
  const core = new Mask().blob(CX + 0.5, cy, 10.5 + squash, 9 - squash / 2, 2.3);
  const span = new Mask().blob(CX + 0.5, cy + 0.5, 20.5 + squash, 7.5 - squash / 2, 1.45);
  const out = new Mask();
  for (const [x, y] of span.merge(core)) {
    const a = Math.abs(x - CX) / 20;
    // The outer part of each wing rises and falls; the middle stays on the floor.
    const lift = a > 0.5 ? Math.round((a - 0.5) * 2 * (1 + flap)) : 0;
    out.add(x, y - lift);
  }
  return out;
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([CX + dx, FLOOR]),
    shadowW: 38,
    headTop: at(CX, 39, true),
    headLeft: at(29, 42, true),
    emitter: at(CX, 40, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(35, 49, true), at(41, 49, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(32, 52, true), at(43, 52, true)]),
    mouth: at(CX, 53, true),
    nose: /** @type {[number, number, number]} */ ([27 + dx, 54 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([16, FLOOR]),
    fin: at(17, 48),
    cap: { x: 33 + dx, y: 42 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, frame } = pose;
  const flap = FLAP[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // The tail, from the back of the right wing, curling up, a spark at its end.
  const sway = flap > 0 ? -1 : 0;
  /** @type {[number, number][]} */
  const path = [[45, 41], [46, 40], [47, 39], [48, 39], [49, 38], [50, 38], [51, 37], [52, 36], [53, 35], [53, 34], [54, 33]];
  const tail = new Mask();
  for (const [x, y] of path) tail.add(x, y < 37 ? y + sway : y);
  p.shape(move(tail), palette.spot, palette.outline);
  const [tx, ty] = path[path.length - 1];
  const bolt = move(new Mask().rows(tx - 1, ty - 5 + sway, ['..#', '.#.', '###', '.#.', '#..']));
  p.shape(bolt, frame % 4 < 2 ? ACCENTS.yellow : ACCENTS.white, palette.outline);

  const shape = kite(squash, flap);
  p.shape(move(shape), palette.fill, palette.outline);

  // The darker back down the middle, and a spot on each wing.
  p.fill(move(shape.and(new Mask().blob(CX + 0.5, FLOOR - 14 + squash, 4.5, 3.2))), palette.spot);
  p.fill(move(shape.and(new Mask().rect(24, 46 + squash, 2, 2).merge(new Mask().rect(51, 46 + squash, 2, 2)))), palette.spot);

  // Lightning from the shoulders out to the tips, white the beat they come up.
  const zap = new Mask();
  for (let k = 0; k <= 11; k += 1) {
    const y = 48 - Math.floor(k / 4) + (Math.floor(k / 2) % 2) + squash;
    zap.add(30 - k, y).add(46 + k, y);
  }
  for (const [x, y] of zap) {
    const a = Math.abs(x - CX) / 20;
    const lift = a > 0.5 ? Math.round((a - 0.5) * 2 * (1 + flap)) : 0;
    if (shape.has(x, y - lift)) p.px(x + dx, y - lift + dy, flap > 0 ? ACCENTS.white : ACCENTS.yellow);
  }
  if (flap > 0) {
    // Sparks jump off the tips as they rise.
    p.dots([[15 + dx, 45 + dy], [14 + dx, 43 + dy], [61 + dx, 45 + dy], [62 + dx, 43 + dy]], ACCENTS.lightCyan);
  }

  // The pale underside shows along the front edge; the face sits just above it.
  const belly = shape.shift(0, 0).cut(shape.shift(0, -2));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);
  // A glint on the back.
  p.fill(move(new Mask().span(41 + squash, 33, 35).add(32, 42 + squash).and(shape)), palette.belly);
}

/**
 * A small one, about 15 by 7, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const up = Math.floor(frame / 3) % 2;
  const m = new Mask();
  for (let i = -6; i <= 6; i += 1) {
    const a = Math.abs(i) / 6.5;
    const lift = Math.abs(i) >= 5 ? up : 0;
    const thick = Math.round(1.4 + 3.6 * (1 - a));
    const mid = y - 4;
    for (let j = 0; j < thick; j += 1) m.add(x + i, mid - lift - Math.floor(thick / 2) + j + 1);
  }
  p.shape(m, palette.fill, palette.outline);
  p.px(x - 1, y - 3, palette.eye);
  p.px(x + 1, y - 3, palette.eye);
  p.px(x - 4, y - 3 - up, up ? ACCENTS.white : ACCENTS.yellow);
  p.px(x + 4, y - 3 - up, up ? ACCENTS.white : ACCENTS.yellow);
}

export default Object.freeze({ id: 'electric-ray', pet: 'pet-manta', palette, anchors, body, mini });
