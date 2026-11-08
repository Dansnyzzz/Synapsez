import { ACCENTS, Mask, Pixels, SIZE } from './pixels.js';
import * as prop from './props.js';

/**
 * Pixel creatures for the titles (owner, 2026-11-08): every title a person can wear
 * has its own animal on the writing box, doing what the whale does, in the same
 * eight states.
 *
 * A creature is a small module (see minnow.js) that knows only itself:
 *
 *   { id, pet, palette, anchors(pose), body(p, pose), mini(p, x, y, frame) }
 *
 * `p` is a Pixels grid (pixels.js), 64 by 64, the shapes laid down in whole pixels and
 * handed to the canvas at the end. `anchors(pose)` says where its parts are in that
 * pose: the floor under it, the top of its head, its eyes. Everything else (the
 * cloud, the screen, the sign, the cap) is drawn here and in props.js against those
 * anchors, so every creature wears the same props and a new one needs no prop code.
 *
 * Nothing here reads the clock, chance or the page: the same creature, state and
 * frame is the same picture, which is what lets a test hold all of them.
 *
 * @typedef {'rest'|'blink'|'happy'|'x'|'wide'|'sleep'} Eyes
 * @typedef {'none'|'open'|'o'|'frown'} Mouth
 * @typedef {{ frame: number, dx: number, dy: number, squash: number, eyes: Eyes, look: [number, number],
 *   mouth: Mouth, blush: boolean, beat: number, tap: number, cap: boolean }} Pose
 * @typedef {[number, number]} Point
 * @typedef {{ ground: Point, shadowW: number, headTop: Point, headLeft: Point, emitter: Point,
 *   eyes: [Point, Point], blush: [Point, Point], mouth: Point|null, nose: [number, number, number],
 *   frontFloor: Point, fin: Point, cap: { x: number, y: number, w: number, tip: number } }} Anchors
 * @typedef {{ id: string, pet: string, palette: Record<string, string>, anchors: (pose: Pose) => Anchors,
 *   body: (p: Pixels, pose: Pose) => void, mini: (p: Pixels, x: number, y: number, frame: number) => void }} Creature
 */

export { ACCENTS, Mask, Pixels, SIZE };

/** One frame time for every state, so a loop's length is its frame count and nothing else. */
export const FRAME_MS = 80;

export const FRAMES = Object.freeze({
  idle: 48,
  thinking: 48,
  typing: 48,
  conducting: 48,
  notification: 32,
  error: 48,
  happy: 52,
  sleeping: 64,
});

export const STATES = Object.freeze(/** @type {(keyof typeof FRAMES)[]} */ (Object.keys(FRAMES)));

/**
 * A finished turn is a moment, not a state: it plays whole loops and goes back to idle.
 * Whole loops, because each one starts and ends on the resting pose, so the change
 * back is not seen.
 */
export const MOMENTS = Object.freeze({ happy: 2, error: 2 });

/** For someone who asked for less motion: the one frame that says the most about each state. */
export const STILL_FRAMES = Object.freeze({
  idle: 0,
  thinking: 30,
  typing: 20,
  conducting: 20,
  notification: 14,
  error: 20,
  happy: 16,
  sleeping: 30,
});

/** How long a moment stays up, in ms; a state that is not one stays until it is changed. @param {string} state */
export function holdMs(state) {
  const loops = MOMENTS[state];
  return loops ? loops * FRAMES[state] * FRAME_MS : Infinity;
}

/**
 * Which frame shows `elapsed` ms into a state. A moment past its hold stays on its first
 * frame, the resting pose, until it is replaced.
 *
 * @param {string} state @param {number} elapsed
 */
export function frameAt(state, elapsed) {
  const count = FRAMES[state] || 1;
  const index = Math.floor(Math.max(0, elapsed) / FRAME_MS);
  const loops = MOMENTS[state];
  if (loops && index >= loops * count) return 0;
  return index % count;
}

/** @param {number} frame @returns {Pose} */
const restPose = (frame) => ({ frame, dx: 0, dy: 0, squash: 0, eyes: 'rest', look: [0, 0], mouth: 'none', blush: false, beat: 0, tap: 0, cap: false });

/** A jump, frame by frame, as [rise, squash]: crouch, up, hang, down, land. @type {Record<number, [number, number]>} */
const LEAP = { 0: [0, 1], 1: [0, 1], 2: [-2, -1], 3: [-4, -1], 4: [-5, 0], 5: [-6, 0], 6: [-6, 0], 7: [-5, 0], 8: [-4, 0], 9: [-2, -1], 10: [0, 1], 11: [0, 1] };
/** @type {Record<number, [number, number]>} */
const JOY = {
  1: [0, 1], 2: [0, 1], 3: [-2, -1], 4: [-4, 0], 5: [-6, 0], 6: [-7, 0], 7: [-7, 0], 8: [-6, 0], 9: [-4, 0], 10: [-2, -1], 11: [0, 1], 12: [0, 1],
  21: [-1, -1], 22: [-3, 0], 23: [-4, 0], 24: [-4, 0], 25: [-3, 0], 26: [-1, 0], 27: [0, 1],
};
/** A mini's hop over twelve frames. */
const HOP = [0, 0, -1, -2, -3, -3, -2, -1, 0, 0, 0, 0];

/** How each state holds the body, frame by frame. @type {Record<string, (f: number) => Pose>} */
const POSES = {
  idle(f) {
    const pose = restPose(f);
    pose.squash = f % 24 >= 12 && f % 24 < 20 ? 1 : 0;
    // A beat every four frames: never still long enough to look stuck.
    pose.beat = Math.floor(f / 4) % 4;
    if (f === 40 || f === 41) pose.eyes = 'blink';
    return pose;
  },
  thinking(f) {
    const pose = restPose(f);
    pose.look = [-1, -1];
    pose.beat = Math.floor(f / 8) % 4;
    if (f >= 36) {
      pose.eyes = 'wide';
      pose.look = [0, -1];
      pose.mouth = 'o';
    }
    return pose;
  },
  typing(f) {
    const pose = restPose(f);
    pose.look = [-1, 0];
    pose.tap = f % 4 < 2 ? 1 : 0;
    pose.beat = Math.floor(f / 6) % 4;
    pose.squash = f % 8 < 1 ? 1 : 0;
    if (f === 30 || f === 31) pose.eyes = 'blink';
    return pose;
  },
  conducting(f) {
    const pose = restPose(f);
    pose.look = [-1, -1];
    pose.squash = f % 12 < 2 ? 1 : 0;
    pose.beat = Math.floor(f / 3) % 4;
    return pose;
  },
  notification(f) {
    const pose = restPose(f);
    const [dy, squash] = LEAP[f] || [0, 0];
    pose.dy = dy;
    pose.squash = squash;
    pose.eyes = 'wide';
    pose.mouth = dy < 0 ? 'o' : 'none';
    pose.beat = Math.floor(f / 4) % 4;
    return pose;
  },
  error(f) {
    const pose = restPose(f);
    if (f === 0) return pose;
    if (f <= 2) pose.squash = 1;
    if (f >= 3 && f <= 14) pose.dx = Math.floor(f / 2) % 2 ? 1 : -1;
    if (f <= 37) {
      pose.eyes = 'x';
      pose.mouth = 'frown';
    } else if (f === 41 || f === 42) pose.eyes = 'blink';
    return pose;
  },
  happy(f) {
    const pose = restPose(f);
    if (f === 0 || f >= 48) return pose;
    const [dy, squash] = JOY[f] || [0, 0];
    pose.dy = dy;
    pose.squash = squash;
    if (f >= 30 && f < 46) pose.dx = [0, -1, 0, 1][Math.floor(f / 3) % 4];
    pose.eyes = 'happy';
    pose.mouth = 'open';
    pose.blush = true;
    pose.beat = Math.floor(f / 3) % 4;
    return pose;
  },
  sleeping(f) {
    const pose = restPose(f);
    pose.eyes = 'sleep';
    pose.cap = true;
    pose.squash = f % 32 >= 16 && f % 32 < 28 ? 1 : 0;
    return pose;
  },
};

/** The pose a state has on a frame, for a creature drawn outside this file (a still on a page). @param {string} state @param {number} frame */
export const poseOf = (state, frame) => (POSES[state] || POSES.idle)(frame);

/** The shadow on the floor: narrower the higher the body is off it. */
function shadow(p, creature, ground, width, lift) {
  const w = Math.max(8, width - 2 * Math.ceil(lift / 2));
  const x0 = ground[0] - Math.floor(w / 2);
  const colour = creature.palette.shadow;
  p.rect(x0 + 2, ground[1] - 1, w - 4, 1, colour);
  p.rect(x0, ground[1], w, 1, colour);
  p.rect(x0 + 2, ground[1] + 1, w - 4, 1, colour);
}

/**
 * The face, the same for every creature: only the eye and mouth pixels change between
 * feelings, so a creature need only say where its eyes and mouth are.
 *
 * @param {Pixels} p @param {Creature} creature @param {Anchors} a @param {Pose} pose
 */
function face(p, creature, a, pose) {
  const ink = creature.palette.eye;
  const [lx, ly] = pose.look;
  a.eyes.forEach(([ex, ey], i) => {
    const out = i === 0 ? -1 : 1;
    const x = ex + lx;
    const y = ey + ly;
    switch (pose.eyes) {
      case 'blink':
      case 'sleep':
        p.px(x, y + 1, ink);
        p.px(x + out, y + 1, ink);
        break;
      case 'happy':
        p.dots([[x - 1, y + 1], [x, y], [x + 1, y + 1]], ink);
        break;
      case 'x':
        p.dots([[x - 1, y - 1], [x + 1, y - 1], [x, y], [x - 1, y + 1], [x + 1, y + 1]], ink);
        break;
      case 'wide': {
        const left = i === 0 ? x - 1 : x;
        p.rect(left, y - 1, 2, 3, ink);
        p.px(left, y - 1, ACCENTS.white);
        break;
      }
      default:
        p.px(x, y, ink);
        p.px(x, y + 1, ink);
    }
  });
  if (pose.blush) for (const [bx, by] of a.blush) p.rect(bx, by, 2, 1, ACCENTS.pink);
  if (!a.mouth) return;
  const [mx, my] = a.mouth;
  if (pose.mouth === 'open') {
    p.dots([[mx - 1, my], [mx, my], [mx + 1, my]], ink);
    p.px(mx, my + 1, ACCENTS.pink);
  } else if (pose.mouth === 'o') p.dots([[mx, my], [mx, my + 1]], ink);
  else if (pose.mouth === 'frown') p.dots([[mx - 1, my + 1], [mx, my], [mx + 1, my + 1]], ink);
}

/** Inside the grid, by whole pixels. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * One picture: the shadow, what stands behind, the body and its face, what stands in front.
 * Props that are not part of a jump (a sign, a badge) hang off where the head is at rest.
 *
 * @param {Pixels} p @param {Creature} creature @param {Pose} pose
 * @param {{ back?: (a: Anchors, rest: Anchors) => void, front?: (a: Anchors, rest: Anchors) => void }} [layers]
 */
function scene(p, creature, pose, { back, front } = {}) {
  const rest = creature.anchors({ ...pose, dx: 0, dy: 0, squash: 0 });
  const a = creature.anchors(pose);
  shadow(p, creature, rest.ground, rest.shadowW, -pose.dy);
  back?.(a, rest);
  creature.body(p, pose);
  face(p, creature, a, pose);
  front?.(a, rest);
}

/** Where the minis stand when the big one conducts, and the bar over each. @type {Point[]} */
const PLAYERS = [[9, 23], [24, 18], [39, 23]];
const BARS = [ACCENTS.cyan, ACCENTS.yellow, ACCENTS.violet];
const PACE = [0.25, 0.4, 0.6];

/** Each state, drawn the same way for every creature. @type {Record<string, (p: Pixels, c: Creature, f: number) => void>} */
const RENDER = {
  idle(p, c, f) {
    scene(p, c, POSES.idle(f));
  },

  thinking(p, c, f) {
    const pose = POSES.thinking(f);
    scene(p, c, pose, {
      back(a, rest) {
        const [hx, hy] = rest.headLeft;
        if (f >= 36) {
          prop.bulb(p, rest.headTop[0], rest.headTop[1] - 10, f);
          return;
        }
        const cx = clamp(hx - 4, 10, 52);
        const cy = clamp(hy - 15, 7, 50);
        prop.cloud(p, cx, cy);
        prop.cloudDots(p, cx, cy, f < 8 ? 0 : f < 16 ? 1 : f < 24 ? 2 : 3);
        prop.trail(p, [hx + 1, hy - 3], [hx - 1, hy - 7]);
      },
    });
  },

  typing(p, c, f) {
    const pose = POSES.typing(f);
    scene(p, c, pose, {
      back(a, rest) {
        const [right, floor] = rest.frontFloor;
        prop.monitor(p, right, floor, f);
        const top = floor - 14;
        const k = Math.floor(f / 10);
        const age = f % 10;
        if (k < 4) prop.glyph(p, right - 13 + ((k * 5) % 11), top - 6 - Math.floor(age / 2), prop.GLYPH_NAMES[k], [ACCENTS.green, ACCENTS.cyan, ACCENTS.yellow, ACCENTS.pink][k]);
        if (f >= 40) prop.check(p, right - 7, top - 8, f === 40);
      },
      front(a, rest) {
        const [right, floor] = rest.frontFloor;
        prop.keyboard(p, right - 12, floor + 2, f);
      },
    });
  },

  conducting(p, c, f) {
    const pose = POSES.conducting(f);
    scene(p, c, pose, {
      back() {
        PLAYERS.forEach(([x, y], i) => {
          const hop = HOP[(f + 12 - i * 4) % 12];
          c.mini(p, x, y + hop, f + i * 5);
          const filled = Math.min(9, Math.floor(f * PACE[i]));
          prop.progress(p, x - 4, y - 17, 9, filled, filled >= 9 ? ACCENTS.green : BARS[i]);
        });
      },
      front(a) {
        prop.baton(p, a.fin[0], a.fin[1], [0, 1, 2, 1][pose.beat]);
      },
    });
  },

  notification(p, c, f) {
    const pose = POSES.notification(f);
    scene(p, c, pose, {
      back(a, rest) {
        prop.sign(p, rest.headTop[0], rest.headTop[1] - 9 - (f % 8 < 4 ? 0 : 1));
      },
    });
  },

  error(p, c, f) {
    const pose = POSES.error(f);
    scene(p, c, pose, {
      back(a, rest) {
        const [ex, ey] = rest.emitter;
        for (let k = 0; k < 4; k += 1) {
          const age = f - (4 + k * 7);
          if (age < 0 || age >= 14) continue;
          const size = age < 4 ? 1 : age < 9 ? 2 : 3;
          prop.puff(p, ex - 3 - Math.floor(age / 3) - (k % 2) * 3, ey - 4 - Math.floor(age / 2), size);
        }
      },
      front(a, rest) {
        if (f >= 2 && f <= 41) prop.errorBadge(p, rest.headTop[0] + 9, rest.headTop[1] - 8, f === 2);
      },
    });
  },

  happy(p, c, f) {
    const pose = POSES.happy(f);
    scene(p, c, pose, {
      back(a, rest) {
        if (f >= 3) prop.confetti(p, f - 3, rest.ground[1]);
      },
      front(a, rest) {
        if (f >= 12 && f <= 45) prop.check(p, rest.headTop[0] + 10, rest.headTop[1] - 10, f === 12);
      },
    });
  },

  sleeping(p, c, f) {
    const pose = POSES.sleeping(f);
    scene(p, c, pose, {
      front(a) {
        prop.nightcap(p, a.cap);
        const [nx, ny, side] = a.nose;
        const r = f < 12 ? 1 : f < 26 ? 2 : f < 40 ? 3 : f < 46 ? 4 : 0;
        if (r) prop.bubble(p, nx, ny, r, side);
        else if (f < 50) prop.burst(p, nx, ny, side);
        // The z's rise from above the cap's peak, away from the side its tip hangs.
        const [peakX, peakY] = prop.capPeak(a.cap);
        const away = a.cap.tip < 0 ? -1 : 1;
        for (const [shift, big] of /** @type {[number, boolean][]} */ ([[0, false], [32, true]])) {
          const age = (f + shift) % 64;
          if (age >= 40) continue;
          const zx = peakX + away * (3 + Math.floor(age / 8)) - (away < 0 ? 4 : 0);
          prop.zee(p, zx, peakY - 6 - Math.floor(age / 4), big);
        }
      },
    });
  },
};

/**
 * One frame as pixels, before it reaches a canvas: what the tests read.
 *
 * @param {Creature} creature @param {string} state @param {number} frame
 */
export function framePixels(creature, state, frame) {
  const count = FRAMES[state];
  if (!count) throw new Error(`No such state: ${state}`);
  const p = new Pixels();
  RENDER[state](p, creature, ((Math.floor(frame) % count) + count) % count);
  return p;
}

/**
 * Draw one frame. `ctx` is in grid units (the caller scales it by a whole number), and
 * the 64 by 64 square is cleared first.
 *
 * @param {{ clearRect: (x: number, y: number, w: number, h: number) => void, fillStyle: any, fillRect: (x: number, y: number, w: number, h: number) => void }} ctx
 * @param {Creature} creature @param {string} state @param {number} frame
 */
export function drawFrame(ctx, creature, state, frame) {
  ctx.clearRect(0, 0, SIZE, SIZE);
  framePixels(creature, state, frame).flush(ctx);
}
