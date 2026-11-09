import { Mask } from './pixels.js';

/**
 * The jade turtle, worn for a hundred dollars spent (owner, 2026-11-08): a sea turtle
 * resting on the floor, facing left, carved from jade. Its shell is cut into plates
 * by darker grooves with gold set where they meet, the plates along its side lit one
 * after another, and a gold rim round its edge; its head and flippers are a paler
 * jade with darker spots. Drawn from scratch for Synapsez.
 */

const palette = Object.freeze({
  fill: '#36a873',
  outline: '#0d3a28',
  belly: '#f2efc6',
  shade: '#d6cf96',
  skin: '#a3e2bb',
  fin: '#5fbd8c',
  spot: '#3f9a6e',
  carve: '#1e7a52',
  shine: '#8fe8bb',
  glow: '#d2ffe6',
  gold: '#f5c443',
  goldDeep: '#b9861c',
  eye: '#0a241a',
  shadow: '#0d3a2838',
});

const FLOOR = 58;
/** How the back flipper paddles, by beat: still, up, still, down. */
const PADDLE = [0, -1, 0, 1];
/** The rows the shell keeps; the rim is its last two. */
const ABOVE_RIM = new Mask().rect(0, 0, 64, 54);
/** The plates along the side, front to back, as the columns each spans: lit in that order. @type {[number, number][]} */
const SIDE_PLATES = [[29, 36], [37, 44], [44, 51], [51, 61]];

/** The dome of the shell, its rim along the bottom. */
function shellMask(squash) {
  return new Mask().blob(44.5, 55, 15 + squash, 17 - squash, 2).and(ABOVE_RIM);
}

/** The grooves that part the plates, for a shell standing `squash` lower. */
function grooves(shell, squash) {
  const s = squash;
  const out = new Mask();
  // Between the plates along the top and those down the side: a line following the dome.
  out.merge(shell.shift(0, 5).and(shell).ring().and(new Mask().rect(0, 0, 64, 46 + s)));
  // The side plates, parted by slanting cuts.
  for (const [x, lean] of /** @type {[number, number][]} */ ([[37, -1], [44, 0], [51, 1]])) {
    for (let y = 44 + s; y <= 51; y += 1) out.add(x + (y < 48 ? lean : 0), y);
  }
  // The plates along the top.
  for (const x of [40, 48]) for (let y = 38 + s; y <= 43 + s; y += 1) out.add(x, y);
  return out.and(shell);
}

/** @param {import('./engine.js').Pose} pose */
function anchors(pose) {
  const { dx, dy, squash } = pose;
  const at = (x, y, top = false) => /** @type {[number, number]} */ ([x + dx, y + dy + (top ? squash : 0)]);
  return {
    ground: /** @type {[number, number]} */ ([40 + dx, FLOOR]),
    shadowW: 42,
    headTop: at(26, 37, true),
    headLeft: at(19, 38, true),
    emitter: at(25, 38, true),
    eyes: /** @type {[[number, number], [number, number]]} */ ([at(22, 43, true), at(28, 43, true)]),
    blush: /** @type {[[number, number], [number, number]]} */ ([at(19, 46, true), at(29, 46, true)]),
    mouth: at(25, 47, true),
    nose: /** @type {[number, number, number]} */ ([17 + dx, 44 + dy + squash, -1]),
    frontFloor: /** @type {[number, number]} */ ([17, FLOOR]),
    fin: at(19, 57),
    cap: { x: 20 + dx, y: 39 + dy + squash, w: 11, tip: 1 },
  };
}

/** @param {import('./pixels.js').Pixels} p @param {import('./engine.js').Pose} pose */
function body(p, pose) {
  const { dx, dy, squash, beat, tap, frame } = pose;
  const paddle = PADDLE[beat % 4];
  const move = (m) => m.shift(dx, dy);
  const floor = new Mask().rect(0, FLOOR, 64, 6);

  // The back flipper, behind, paddling.
  const back = new Mask().rows(54, 53 + paddle, ['###...', '#####.', '.#####', '..####', '...###']).cut(floor);
  p.shape(move(back), palette.fin, palette.outline);
  p.px(58 + dx, 55 + paddle + dy, palette.spot);

  // Under the shell, the cream plates of its underside on the floor.
  const under = new Mask().blob(43, FLOOR - 2.5, 13.5 + squash, 3, 2.6);
  p.shape(move(under), palette.belly, palette.outline);
  p.fill(move(under.and(new Mask().rect(0, FLOOR - 1, 64, 1))), palette.shade);

  // The head held up on its neck: round, and a little big, as a turtle's is when drawn kindly.
  const head = new Mask().blob(26, 43.5 + squash, 7 + squash / 2, 5.9 - squash / 2, 2.2);
  const skull = new Mask().blob(30, 49 + squash / 2, 4.5, 4 - squash / 2).merge(head);
  p.shape(move(skull), palette.skin, palette.outline);
  p.fill(move(skull.and(new Mask().blob(26, 51.5, 8, 4))), palette.belly);
  p.fill(move(new Mask().add(29, 39 + squash).add(30, 40 + squash).add(31, 39 + squash).add(31, 44 + squash).add(32, 43 + squash).and(head)), palette.spot);

  // The shell: jade cut into plates, gold where the grooves meet, a gold rim.
  const shell = shellMask(squash);
  p.shape(move(shell), palette.fill, palette.outline);
  const cuts = grooves(shell, squash);
  // Light along the top of the dome, as on polished stone.
  p.fill(move(shell.inner().and(new Mask().rect(32, 0, 19, 45 + squash))), palette.shine);
  // One side plate lit at a time, front to back.
  const plates = new Mask().merge(shell).cut(cuts).cut(shell.inner());
  const [x0, x1] = SIDE_PLATES[Math.floor(frame / 4) % SIDE_PLATES.length];
  const lit = plates.and(new Mask().rect(x0, 44 + squash, x1 - x0 + 1, 8 - squash));
  p.fill(move(lit), palette.shine);
  p.fill(move(lit.edge(-1, -1)), palette.glow);
  p.fill(move(cuts), palette.carve);
  // Gold set where the side cuts meet the line along the top.
  p.fill(move(new Mask().add(36, 44 + squash).add(44, 43 + squash).add(52, 44 + squash).and(shell)), palette.gold);
  // The rim: gold, notched where the edge plates meet.
  const rim = shell.and(new Mask().rect(0, 52, 64, 2));
  p.fill(move(rim), palette.gold);
  const notches = new Mask();
  for (let x = 32; x <= 56; x += 4) notches.add(x, 53);
  p.fill(move(notches.and(rim)), palette.goldDeep);

  // The front flipper, long, planted forward on the floor; it taps as it writes.
  const front = new Mask().rows(20, 53 + tap, ['........######', '.....########.', '..#########...', '#########.....', '.######.......']).cut(floor);
  p.shape(move(front), palette.fin, palette.outline);
  p.fill(move(new Mask().add(24, 56 + tap).add(28, 55 + tap).add(31, 54 + tap).and(front)), palette.spot);
}

/**
 * A small one, about 14 by 9, standing on `y`.
 *
 * @param {import('./pixels.js').Pixels} p @param {number} x @param {number} y @param {number} frame
 */
function mini(p, x, y, frame) {
  const step = Math.floor(frame / 3) % 2;
  p.shape(new Mask().rect(x - 4, y - 1 - step, 3, 1).merge(new Mask().rect(x + 3, y - 2 + step, 3, 1)), palette.skin, palette.outline);
  const head = new Mask().blob(x - 5, y - 4, 2.6, 2.2);
  p.shape(head, palette.skin, palette.outline);
  const shell = new Mask().blob(x + 1, y - 1, 5, 5.5).and(new Mask().rect(x - 6, y - 9, 14, 8));
  p.shape(shell, palette.fill, palette.outline);
  p.fill(shell.and(new Mask().rect(x - 4, y - 2, 11, 1)), palette.gold);
  p.dots([[x + 1, y - 5], [x + 1, y - 4], [x - 1, y - 3], [x + 3, y - 3]], palette.carve);
  p.px(x - 6, y - 5, palette.eye);
}

export default Object.freeze({ id: 'jade-turtle', pet: 'pet-jade-turtle', palette, anchors, body, mini });
