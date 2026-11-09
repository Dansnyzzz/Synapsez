import { ACCENTS, Mask } from './pixels.js';

/**
 * The silver marlin, worn for second place on a board (owner, 2026-11-08): a sleek
 * fish resting on the floor, facing left, its long bill raised. A steel-blue back
 * with pale blue bars, silver sides and a white belly; a tall sail of a fin with dark
 * rays, a crescent tail, a light that sweeps along its side, and two glints that come
 * and go. Less gold than first place, more shine than third. Drawn from scratch for
 * Synapsez.
 *
 * Its bill rises to its tip so it stays clear of the screen in front of it.
 */

const palette = Object.freeze({
  fill: '#b9c7d8',
  outline: '#1b2b48',
  belly: '#f3f7fc',
  shade: '#d3dde9',
  back: '#4b72a8',
  stripe: '#8fc4f2',
  sail: '#4f80c4',
  ray: '#2c5590',
  edge: '#86aee3',
  glint: '#e9f2ff',
  eye: '#0c1528',
  shadow: '#1b2b4838',
});

const FLOOR = 58;
/** The tail's sway by beat: still, up, still, down. */
const WAG = [0, -1, 0, 1];
/** Where its glints are, and when each is brightest: [x, y, phase]. @type {[number, number, number][]} */
const GLINTS = [[58, 30, 0], [48, 25, 8]];
const TWINKLE = [0, 1, 2, 2, 1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
/** The bill, from the root at the snout to the tip, which stays clear of the screen. @type {[number, number][]} */
const BILL = [[25, 47], [24, 47], [23, 46], [22, 46], [21, 45], [20, 44], [19, 44], [18, 43], [17, 42], [24, 48], [23, 47], [22, 47]];

/** The head and the body, narrowing to the tail. */
function bodyMask(squash) {
  const front = new Mask().blob(36, FLOOR - 7 + squash / 2, 11.5 + squash, 7 - squash / 2, 2.2);
  const rear = new Mask().blob(47, FLOOR - 5.5 + squash / 2, 9 + squash, 5.5 - squash / 2, 2);
  const stock = new Mask().blob(54.5, FLOOR - 6, 2.5, 3);
  return front.merge(rear).merge(stock);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([40 + dx, FLOOR]),
    shadowW: 40,
    // Its sail stands higher than its head: what is shown over its head goes over the sail.
    headTop: at(27, 31, true),
    headLeft: at(24, 43, true),
    emitter: at(27, 44, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(28, 48, true), at(34, 48, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(26, 51, true), at(34, 51, true)]),
    mouth: at(31, 52, true),
    nose: /** @type {[number, number, number]} */ ([23 + dx - squash, 53 + dy + squash, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(23, 56),
    cap: { x: 26 + dx, y: 46 + dy + squash, w: 11, tip: -1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const wag = WAG[beat % 4];
  const move = (m) => m.shift(dx, dy);

  // Two glints come and go, white and pale blue.
  for (const [gx, gy, phase] of GLINTS) {
    const size = TWINKLE[(frame + phase) % TWINKLE.length];
    if (size < 0) continue;
    /** @type {[number, number][]} */
    const arms = [[gx - 1, gy], [gx + 1, gy], [gx, gy - 1], [gx, gy + 1]];
    if (size >= 2) arms.push([gx - 2, gy], [gx + 2, gy], [gx, gy - 2], [gx, gy + 2]);
    if (size >= 1) p.dots(arms, ACCENTS.lightCyan);
    p.px(gx, gy, ACCENTS.white);
  }

  const shape = bodyMask(squash);

  // The crescent tail, its tips swaying.
  const tail = new Mask().rows(54, 38, [
    '......##',
    '.....###',
    '.....##.',
    '....###.',
    '....##..',
    '...###..',
    '...##...',
    '..###...',
    '..##....',
    '.###....',
    '###.....',
    '###.....',
    '###.....',
    '###.....',
    '.###....',
    '..###...',
    '...###..',
    '....###.',
    '.....###',
    '......##',
  ]);
  const upperTail = tail.and(new Mask().rect(0, 0, 64, 48)).shift(0, wag);
  const lowerTail = tail.and(new Mask().rect(0, 48, 64, 16)).cut(new Mask().rect(0, FLOOR, 64, 6));
  const fluke = upperTail.merge(lowerTail);
  p.shape(move(fluke), palette.back, palette.outline);
  p.fill(move(fluke.edge(-1, 0).and(new Mask().rect(0, 0, 64, 48 + wag))), palette.edge);

  // The sail: tall over the front of its back, sweeping down to the tail, ribbed.
  const sail = new Mask().rows(31, 30 + squash, [
    '..####..........',
    '.#######........',
    '.#########......',
    '.###########....',
    '.############...',
    '.#############..',
    '.##############.',
    '.##############.',
    '.###############',
    '.###############',
    '.###############',
    '.##############.',
    '.#############..',
    '.###########....',
    '..########......',
    '..######........',
  ]);
  const ribs = new Mask();
  for (const x of [34, 37, 40, 43, 46]) {
    // Each rib pokes a spine tip out over the edge.
    for (let y = 0; y < 64; y += 1) {
      if (!sail.has(x, y)) continue;
      sail.add(x, y - 1);
      break;
    }
    for (let y = 29; y < 48; y += 1) ribs.add(x, y + squash);
  }
  p.shape(move(sail), palette.sail, palette.outline);
  p.fill(move(ribs.and(sail.cut(sail.inner()))), palette.ray);
  p.fill(move(sail.edge(0, -1).merge(sail.edge(-1, 0)).and(sail)), palette.edge);

  // The bill, behind the head, so the head's outline parts them.
  const bill = new Mask();
  for (const [x, y] of BILL) bill.add(x, y + squash);
  p.shape(move(bill), palette.back, palette.outline);

  p.shape(move(shape), palette.fill, palette.outline);
  // The steel-blue back, a cap over the head and deeper behind it, with pale bars down from it.
  const back = new Mask().merge(shape).cut(shape.shift(0, 5)).cut(new Mask().rect(0, 46 + squash, 35, 18)).cut(new Mask().rect(35, 49 + squash, 3, 15));
  p.fill(move(back), palette.back);
  const bars = new Mask();
  for (const x of [38, 42, 46, 50]) for (let y = 44; y < 56; y += 1) if (y % 4 !== 3) bars.add(x, y + squash);
  p.fill(move(bars.and(shape).cut(shape.inner()).and(new Mask().rect(0, 0, 64, 52 + squash))), palette.stripe);
  // Light along the top of its head.
  p.fill(move(new Mask().span(45 + squash, 30, 34).add(29, 46 + squash).and(back)), palette.edge);

  // The belly, white, and a band of shade where it meets the floor.
  const belly = shape.and(new Mask().blob(38, FLOOR + 1.5, 15 + squash, 6.5));
  p.fill(move(belly), palette.belly);
  p.fill(move(belly.cut(belly.shift(2, -1))), palette.shade);

  // A light sweeping along its side, from head to tail, over sixteen frames.
  const sweep = 56 + (frame % 16) * 2;
  const rim = shape.inner();
  const light = new Mask();
  for (const [x, y] of shape) {
    const t = x + Math.floor((y - squash) / 2) - sweep;
    if (t >= 0 && t <= 1 && x >= 37 && !rim.has(x, y)) light.add(x, y);
  }
  p.fill(move(light.and(back)), palette.edge);
  p.fill(move(light.cut(back)), palette.glint);

  // The long front fin, a sickle swept back along its side; it taps as it writes.
  const fin = new Mask().rows(37, 52 + tap, ['##.......', '.#####...', '...######', '......###']);
  p.shape(move(fin), palette.sail, palette.outline);
  p.fill(move(new Mask().span(52 + tap, 37, 38).span(53 + tap, 39, 42).and(fin)), palette.edge);
}

/**
 * A small one, bill and sail and all, about 15 by 10, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const wag = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rows(x + 4, y - 7 + wag, ['..#', '.##', '##.', '.##', '..#']), palette.back, palette.outline);
  p.shape(new Mask().rows(x - 2, y - 8, ['.##..', '.####', '#####']), palette.sail, palette.outline);
  p.shape(new Mask().add(x - 6, y - 5).add(x - 7, y - 6), palette.back, palette.outline);
  const m = new Mask().blob(x - 0.5, y - 3, 4.6, 2.6);
  p.shape(m, palette.fill, palette.outline);
  p.fill(m.and(new Mask().rect(x - 5, y - 6, 10, 2)), palette.back);
  p.fill(m.and(new Mask().rect(x - 5, y - 2, 10, 2)), palette.belly);
  p.px(x - 3, y - 3, palette.eye);
  p.px(x - 1, y - 3, palette.eye);
}

export default Object.freeze({ id: 'silver-marlin', pet: 'pet-silver-marlin', palette, anchors, body, mini });
