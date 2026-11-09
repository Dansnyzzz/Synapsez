import { ACCENTS, Mask } from './pixels.js';

/**
 * The cosmic whale, worn for a billion tokens (owner, 2026-11-08): the top of the token
 * titles. A long, low whale whose body is a night sky, deep indigo with a light along
 * its back, stars that twinkle in it and a small spiral galaxy, a pale milky underside
 * below the line of its mouth, a swept dorsal fin and a crescent moon for a tail. A
 * ringed planet orbits it, passing behind its back and in front of its belly. Drawn
 * from scratch for Synapsez.
 *
 * Not the golden whale in other colours: longer and lower, its tail lies back as a
 * crescent instead of rising in flukes, and it has a dorsal fin. Its eyes are pale,
 * starlight on the dark.
 */

const palette = Object.freeze({
  fill: '#2e2a7c',
  outline: '#120d3a',
  belly: '#cbc4ff',
  shade: '#9d93f0',
  rim: '#6f66de',
  deep: '#211c61',
  moon: '#ffe9a6',
  eye: '#f4f1ff',
  shadow: '#120d3a38',
});

const FLOOR = 58;
/** The tail's lift by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];

/** Stars in its body, [x, y, phase]: each brightens in its turn. @type {[number, number, number][]} */
const STARS = [[31, 43, 0], [48, 47, 5], [53, 50, 10], [33, 49, 15], [45, 51, 20], [21, 45, 8], [40, 42, 13]];
const TWINKLE = [1, 1, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** A spiral galaxy: a bright core (w, y), two arms (v) turning about it to pink tips (p). */
const GALAXY = ['..vvv....', '.v...v...', 'p..ywy..p', '...v...v.', '....vvv..'];

/** The crescent moon of its tail, horns up and down. */
const MOON = [
  '.....##',
  '....###',
  '...###.',
  '...##..',
  '..###..',
  '.###...',
  '####...',
  '####...',
  '.###...',
  '..###..',
  '...##..',
  '...###.',
  '....###',
  '.....##',
];

/** The planet's orbit, a tilted ring about its back half, and how long a turn takes. */
const ORBIT = { cx: 46, cy: 48, rx: 13, ry: 8, steps: 24, frames: 2 };

/** The head, the back and the stock of the tail, as one shape: highest at the head, tapering to the tail. */
function bodyMask(squash) {
  const s = squash;
  const head = new Mask().blob(31, 48.5 + s / 2, 12 + s, 9 - s / 2, 2.3);
  const back = new Mask().blob(44, 50.5 + s / 2, 10 + s, 7 - s / 2, 2);
  const stock = new Mask().blob(53.5, 50.5 + s / 2, 3.5, 3.5 - s / 2);
  return head.merge(back).merge(stock);
}

/** Where the planet is on a frame, and whether it is in front. @returns {[number, number, boolean]} */
function planetAt(frame, lag = 0) {
  const step = (Math.floor(frame / ORBIT.frames) - lag + ORBIT.steps * 4) % ORBIT.steps;
  // It starts at the far right and goes round under the belly first. At either end it is
  // behind (the tail at one, the body at the other), so it never lands on the face or the moon.
  const a = (step / ORBIT.steps) * 2 * Math.PI;
  return [Math.round(ORBIT.cx + ORBIT.rx * Math.cos(a)), Math.round(ORBIT.cy + ORBIT.ry * Math.sin(a)), Math.sin(a) > 0.3];
}

/** A small ringed planet. */
function planet(p, x, y) {
  p.shape(new Mask().rect(x - 1, y - 1, 3, 3).remove(x - 1, y - 1).remove(x + 1, y + 1), ACCENTS.orange, palette.outline);
  p.px(x, y - 1, ACCENTS.yellow);
  p.dots([[x - 3, y + 1], [x - 2, y + 1], [x - 1, y], [x, y], [x + 1, y], [x + 2, y - 1], [x + 3, y - 1]], palette.moon);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([38 + dx, FLOOR]),
    shadowW: 40,
    headTop: at(31, 40, true),
    headLeft: at(22, 43, true),
    emitter: at(25, 42, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(23, 47, true), at(28, 47, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(20, 50, true), at(29, 50, true)]),
    mouth: at(25, 51, true),
    nose: /** @type {[number, number, number]} */ ([18 + dx - squash, 51 + dy, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(19, 54),
    cap: { x: 26 + dx, y: 41 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);
  const [px, py, front] = planetAt(frame);
  const trail = [planetAt(frame, 1), planetAt(frame, 2)];

  // The planet, when it is round the back, goes first: the body hides it.
  if (!front) {
    trail.forEach(([tx, ty], i) => p.px(tx + dx, ty + dy, i ? ACCENTS.violet : ACCENTS.lightCyan));
    planet(p, px + dx, py + dy);
  }

  // The crescent moon of the tail, and the dorsal fin, behind the body.
  const moon = new Mask().rows(55, 43 + wag, MOON);
  p.shape(move(moon), palette.moon, palette.outline);
  // Its inner curve in shadow, a glint on its outer edge.
  p.fill(move(moon.edge(1, 0).cut(new Mask().rect(0, 0, 64, 45 + wag)).cut(new Mask().rect(0, 55 + wag, 64, 9))), ACCENTS.amber);
  p.fill(move(moon.edge(-1, 0).and(new Mask().rect(55, 48 + wag, 2, 4))), ACCENTS.white);
  const dorsal = new Mask().rows(45, 40 + squash, ['.##...', '.###..', '#####.']);
  p.shape(move(dorsal), palette.fill, palette.outline);
  p.fill(move(new Mask().add(46, 40 + squash).add(46, 41 + squash)), palette.rim);

  const shape = bodyMask(squash);
  p.shape(move(shape), palette.fill, palette.outline);
  // Deeper night along the back, a light along its edge to read on a dark page.
  p.fill(move(shape.and(new Mask().blob(40, 42 + squash, 16, 2.5)).cut(shape.edge(0, -1))), palette.deep);
  p.fill(move(shape.edge(0, -1).cut(new Mask().rect(0, 50, 64, 14))), palette.rim);

  // The milky underside, below the line of its mouth.
  const belly = shape.and(new Mask().blob(35, 59.5, 18 + squash, 6.5));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.shift(0, 0).cut(belly.shift(2, -1))), palette.shade);
  p.fill(move(new Mask().add(33, 55).add(40, 56).add(46, 55).and(belly)), ACCENTS.white);

  // The galaxy in a haze of light, its core brightening and dimming, its arms taking
  // turns to glow so it seems to turn.
  p.fill(move(shape.and(new Mask().blob(40.5, 46.5 + squash, 6, 3.2))), palette.rim);
  const glow = Math.floor(frame / 6) % 2 === 0;
  p.sprite(36 + dx, 44 + dy + squash, GALAXY, {
    p: ACCENTS.pink,
    v: glow ? ACCENTS.violet : ACCENTS.lightCyan,
    w: frame % 16 < 8 ? ACCENTS.white : ACCENTS.yellow,
    y: ACCENTS.yellow,
  });
  // Stars, each brightening in its turn.
  for (const [sx, sy, phase] of STARS) {
    const size = TWINKLE[(frame + phase) % TWINKLE.length];
    const x = sx + dx;
    const y = sy + dy + squash;
    if (!shape.has(sx, sy + squash)) continue;
    p.px(x, y, size ? ACCENTS.white : ACCENTS.lightCyan);
    if (size >= 2) p.dots([[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]], ACCENTS.yellow);
  }

  // A short flipper, in front, tapping as it writes.
  const flipper = new Mask().rows(31, 54 + tap, ['###..', '.####', '..###', '...#.']);
  p.shape(move(flipper), palette.fill, palette.outline);
  p.fill(move(new Mask().span(54 + tap, 31, 33)), palette.rim);

  // The planet in front, after the body.
  if (front) {
    trail.forEach(([tx, ty], i) => p.px(tx + dx, ty + dy, i ? ACCENTS.violet : ACCENTS.lightCyan));
    planet(p, px + dx, py + dy);
  }
}

/**
 * A small one, about 15 by 9, standing on `y`: indigo, a star in it, a moon for a tail.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 4, y - 8 + wag, ['.##', '##.', '#..', '##.', '.##']), palette.moon, palette.outline);
  const m = new Mask().blob(x - 1.5, y - 3.5, 5.6, 3);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 7, y - 2, 11, 1)), palette.belly);
  p.px(x - 5, y - 4, palette.eye);
  p.px(x - 2, y - 4, palette.eye);
  p.px(x + 1, y - 5, frame % 6 < 3 ? ACCENTS.white : ACCENTS.yellow);
}

export default Object.freeze({ id: 'cosmic-whale', pet: 'pet-cosmic-whale', palette, anchors, body, mini });
