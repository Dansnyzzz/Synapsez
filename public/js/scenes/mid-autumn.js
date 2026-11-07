import { W, H, TAU, clamp, mix, smooth, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm1, fbm2, puffs, slide, starField, drawStars } from './art.js';

/**
 * Mid-Autumn night, a Vietnamese village: the moon up over the village gate, a banyan
 * by the wall, and the children walking the lane with star and carp lanterns.
 *
 * Only two lights in the picture: the moon, upper right, which puts a cool edge on
 * everything that faces it, and the lanterns, which warm whatever they pass.
 */

const MOON = { x: 372, y: 82, r: 62 };
const GATE_X = 402;
const SHRINE_X = 104;
/** Sprites are drawn this much larger and thinned down, so a thin arm is still one clean pixel. */
const FINE = 3;
/** Where the near line and the far line of children walk. */
const NEAR_FEET = 254;
const FAR_FEET = 239;
const STEP_FRAMES = 8;

/** A colour with an opacity of its own, as the bytes a canvas holds. */
const see = (hex, alpha) => ((rgba(hex) & 0xffffff) | (alpha << 24)) >>> 0;

/** A soft light, in stepped, dithered rings, to be added to whatever is under it. */
function glowOf(rx, ry, hex, strength, falloff = 2) {
  const art = new Art(rx * 2 + 1, ry * 2 + 1);
  const steps = 14;
  for (let y = 0; y <= ry * 2; y += 1) {
    for (let x = 0; x <= rx * 2; x += 1) {
      const d = Math.hypot((x - rx) / rx, (y - ry) / ry);
      if (d >= 1) continue;
      const level = Math.floor(strength * (1 - d) ** falloff * steps + bayer(x, y));
      if (level > 0) art.px[y * art.w + x] = see(hex, Math.round(clamp(level / steps) * 255));
    }
  }
  return art.canvas();
}

/** Thin a fine drawing down to its real size: a pixel is kept when enough of it was covered. */
function thinned(fine, keep = 3) {
  const w = Math.floor(fine.w / FINE);
  const h = Math.floor(fine.h / FINE);
  const out = new Art(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let count = 0;
      let colour = 0;
      for (let j = 0; j < FINE; j += 1) {
        for (let i = 0; i < FINE; i += 1) {
          const v = fine.px[(y * FINE + j) * fine.w + x * FINE + i];
          if (v) {
            count += 1;
            colour = v;
          }
        }
      }
      if (count >= keep) out.px[y * w + x] = colour;
    }
  }
  return out;
}

/** A tapering stroke. */
function limb(art, x0, y0, x1, y1, r0, r1, c) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i += 1) {
    const k = i / n;
    art.disc(mix(x0, x1, k), mix(y0, y1, k), mix(r0, r1, k), c);
  }
}

/** Light one edge of a silhouette: whatever has nothing beside it on the side `dx, dy`. */
function edgeLit(art, dx, dy, c, chance = 1) {
  const lit = [];
  for (let y = 0; y < art.h; y += 1) {
    for (let x = 0; x < art.w; x += 1) {
      if (!art.px[y * art.w + x]) continue;
      if (!art.get(x + dx, y + dy) && bayer(x, y) < chance) lit.push(y * art.w + x);
    }
  }
  for (const i of lit) art.px[i] = c;
}

/* ── the children ─────────────────────────────────────────────────── */

/**
 * A child in profile, walking to the right, one arm up holding a pole. Fine drawing,
 * so `s` may be any size. Returns where the hand is, in sprite pixels.
 */
function paintChild(fine, ox, oy, s, ph, style, c) {
  const X = (u) => (ox + u * s) * FINE;
  const Y = (v) => (oy - v * s) * FINE;
  const R = (r) => r * s * FINE;
  const hipH = 9.2;
  const thigh = 4.6;
  const shin = 4.6;
  const leg = (a, turned) => {
    const bend = 1.05 * Math.max(0, Math.cos(TAU * ph + (turned ? Math.PI : 0)));
    const kneeU = Math.sin(a) * thigh;
    const kneeV = hipH - Math.cos(a) * thigh;
    return { kneeU, kneeV, footU: kneeU + Math.sin(a - bend) * shin, footV: kneeV - Math.cos(a - bend) * shin };
  };
  const swing = 0.42 * Math.sin(TAU * ph);
  const near = leg(swing, false);
  const far = leg(-swing, true);
  const lift = -Math.min(near.footV, far.footV);
  const hip = hipH + lift;
  const paintLeg = (l) => {
    limb(fine, X(0), Y(hip), X(l.kneeU), Y(l.kneeV + lift), R(1.15), R(0.82), c);
    limb(fine, X(l.kneeU), Y(l.kneeV + lift), X(l.footU), Y(l.footV + lift), R(0.82), R(0.62), c);
    limb(fine, X(l.footU - 0.1), Y(l.footV + lift + 0.32), X(l.footU + 1.7), Y(l.footV + lift + 0.32), R(0.62), R(0.5), c);
  };
  paintLeg(far);
  paintLeg(near);
  // The tunic, flared at the hem, leaning a little into the walk.
  const lean = 0.5;
  const hem = hip - 1.6;
  const shoulder = hip + 6.4;
  fine.poly([[X(-3.7), Y(hem)], [X(3.4), Y(hem)], [X(2.1 + lean), Y(shoulder)], [X(-1.9 + lean), Y(shoulder)]], c);
  fine.disc(X(lean + 0.1), Y(shoulder), R(1.8), c);
  // A narrow neck, so the head is a head; then what is on it.
  const hx = 0.8 + lean;
  const hy = shoulder + 4.9;
  limb(fine, X(lean + 0.2), Y(shoulder), X(hx), Y(hy - 2), R(0.8), R(0.8), c);
  fine.disc(X(hx), Y(hy), R(4), c);
  fine.disc(X(hx + 3.8), Y(hy - 1), R(0.7), c);
  if (style === 'bowl') {
    fine.disc(X(hx - 0.7), Y(hy + 0.8), R(4), c);
  } else if (style === 'buns') {
    fine.disc(X(hx - 3.7), Y(hy + 2.6), R(1.8), c);
    fine.disc(X(hx + 0.2), Y(hy + 4.3), R(1.8), c);
  } else if (style === 'knot') {
    fine.disc(X(hx - 0.8), Y(hy + 4.8), R(1.5), c);
  } else if (style === 'braid') {
    const flick = Math.sin(TAU * ph) * 0.7;
    limb(fine, X(hx - 3.3), Y(hy + 0.4), X(hx - 5 - flick), Y(hy - 7), R(1), R(0.45), c);
  } else if (style === 'hat') {
    fine.poly([[X(hx - 7.6), Y(hy + 0.7)], [X(hx + 7), Y(hy + 0.7)], [X(hx - 0.3), Y(hy + 7)]], c);
  }
  // The far arm swings behind; the near one holds the pole out in front.
  limb(fine, X(lean - 0.5), Y(shoulder - 0.6), X(lean - 3.1 - Math.sin(TAU * ph) * 1.1), Y(shoulder - 5.8), R(0.72), R(0.55), c);
  const bob = Math.sin(TAU * ph * 2) * 0.3;
  const handU = 5.7;
  const handV = shoulder + 1.6 + bob;
  limb(fine, X(lean + 0.5), Y(shoulder - 0.6), X(3.5), Y(shoulder - 2.6), R(0.78), R(0.66), c);
  limb(fine, X(3.5), Y(shoulder - 2.6), X(handU), Y(handV), R(0.66), R(0.6), c);
  fine.disc(X(handU), Y(handV), R(0.78), c);
  return { hx: ox + handU * s, hy: oy - handV * s };
}

/** Every step of one child, ready to stamp. */
function childFrames(s, style) {
  const w = Math.ceil(26 * s);
  const h = Math.ceil(32 * s);
  const ox = Math.round(w * 0.42);
  const oy = h - 1;
  const frames = [];
  for (let i = 0; i < STEP_FRAMES; i += 1) {
    const fine = new Art(w * FINE, h * FINE);
    const hand = paintChild(fine, ox, oy, s, i / STEP_FRAMES, style, rgba('#050719'));
    const art = thinned(fine, 3);
    // The lantern is in front of them: their front edge catches it.
    edgeLit(art, 1, 0, rgba('#b4632f'));
    edgeLit(art, 0, -1, rgba('#4a2e45'), 0.7);
    frames.push({ image: art.canvas(), hx: Math.round(hand.hx - ox), hy: Math.round(hand.hy - oy) });
  }
  return { frames, ox, oy, w, h };
}

/* ── lanterns ─────────────────────────────────────────────────────── */

const LAMP = {
  red: ramp('#4a0d19', '#83161f', '#bd2622', '#e04423', '#f26f2a', '#fb9c38', '#ffc957', '#ffe88f', '#fff9d2'),
  orange: ramp('#5e2410', '#9c4117', '#d36a20', '#f0922c', '#fbb545', '#ffd468', '#ffe995', '#fff7c6', '#fffcea'),
  gold: ramp('#5c3a12', '#99631a', '#d09324', '#efb838', '#fbd058', '#ffe27f', '#fff0a8', '#fff9d2', '#fffdf0'),
  rose: ramp('#551334', '#8d2247', '#c63b5d', '#e8606f', '#f58a7f', '#fdb48f', '#ffd5a4', '#fff0c8', '#fffcec'),
};

/** The star lantern of the festival: five points, two faces to each, candle in the middle, paper fringe below. */
function starLantern(R, colours, turn) {
  const size = Math.ceil(R) * 2 + 9;
  const cx = Math.floor(size / 2) + 0.5;
  const cy = Math.ceil(R) + 2.5;
  const art = new Art(size, size);
  const start = -Math.PI / 2 + turn;
  const tips = [];
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const a = start + (i * Math.PI) / 5;
    const r = i % 2 ? R * 0.44 : R;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    if (i % 2 === 0) tips.push(pts[i]);
  }
  art.poly(pts, (x, y) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy) / R;
    const sector = Math.floor(((Math.atan2(dy, dx) - start) / (Math.PI / 5) + 20) % 10);
    art.tone(x, y, colours, clamp(0.96 - d * 1.04 + (sector % 2 ? 0.1 : -0.1)), 0.55);
  });
  // The bamboo: an edge all round, and a spine out to each point.
  const edge = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!art.get(x, y)) continue;
      if (!art.get(x - 1, y) || !art.get(x + 1, y) || !art.get(x, y - 1) || !art.get(x, y + 1)) edge.push([x, y]);
    }
  }
  for (const [x, y] of edge) art.put(x, y, colours[0]);
  for (const [tx, ty] of tips) {
    for (let k = 0.4; k < 0.94; k += 0.07) {
      const x = mix(cx, tx, k);
      const y = mix(cy, ty, k);
      if (art.get(x, y)) art.put(x, y, colours[1]);
    }
  }
  // Paper fringe on the two lower points.
  const paper = rgba('#ffd362');
  const paperDeep = rgba('#ee6a2a');
  for (const [tx, ty] of [tips[2], tips[3]]) {
    art.put(tx, ty + 1, paper);
    art.put(tx - 1, ty + 2, paper);
    art.put(tx + 1, ty + 2, paperDeep);
    if (R > 8) {
      art.put(tx, ty + 3, paperDeep);
      art.put(tx - 1, ty + 3, paper);
    }
  }
  return { image: art.canvas(), ax: Math.floor(size / 2), ay: Math.ceil(R) + 2 };
}

/** A carp of paper and bamboo, nose to the right, its tail swinging by `swing` (-1 to 1). */
function carpLantern(L, swing) {
  const hmax = L * 0.2;
  const pad = Math.ceil(hmax) + 6;
  const w = L + 3;
  const h = pad * 2 + 1;
  const art = new Art(w, h);
  const FISH = ramp('#560f1a', '#8c1820', '#c22821', '#e04524', '#f26c2a', '#fa9636', '#fdbf52', '#ffdf81', '#fff3b8');
  const spine = (k) => pad + Math.sin(k * Math.PI * 1.3) * k * swing * 1.8;
  const half = (k) => hmax * Math.sin(Math.PI * Math.min(0.97, k * 1.06) ** 0.6) ** 0.72;
  for (let x = 0; x < w; x += 1) {
    const k = 1 - x / (L - 1);
    if (k < 0 || k > 1) continue;
    const sy = spine(k);
    if (k > 0.74) {
      // The tail: a fan with a notch, and its rays.
      const open = ((k - 0.74) / 0.26) ** 0.85 * hmax * 1.35 + hmax * 0.14;
      for (let y = Math.round(sy - open); y <= sy + open; y += 1) {
        const n = (y - sy) / open;
        const ray = Math.abs(Math.sin(n * 6.4 + k * 1.5));
        if (Math.abs(n) < 0.26 && k > 0.92) continue;
        art.tone(x, y, FISH, clamp(0.22 + ray * 0.3 + (1 - k) * 1.2), 0.45);
      }
      continue;
    }
    const hh = half(k);
    for (let y = Math.ceil(sy - hh); y <= sy + hh; y += 1) {
      const n = (y - sy) / Math.max(1, hh);
      // A candle inside: brightest low in the middle, red along the back, dark at the very edge.
      let v = 0.46 + n * 0.3 - n * n * 0.14 + 0.2 * Math.exp(-(((k - 0.46) / 0.24) ** 2));
      if (k > 0.2) {
        const row = Math.floor(y / 2);
        const cell = (x + (row % 2 ? 2 : 0)) % 4;
        if (cell === 0 || (cell === 1 && y % 2 === 0)) v -= 0.2;
        else if (cell === 2 && y % 2 === 1) v += 0.08;
      } else if (k > 0.16) v -= 0.3;
      if (Math.abs(n) > 0.86) v -= 0.2;
      art.tone(x, y, FISH, clamp(v), 0.4);
    }
  }
  // A fin along the back, one under the chest, an eye, whiskers.
  const fin = rgba('#a81f20');
  for (let k = 0.22; k < 0.7; k += 1 / L) {
    const x = Math.round((1 - k) * (L - 1));
    const top = spine(k) - half(k);
    const tall = Math.round(1 + 2.4 * Math.sin(((k - 0.22) / 0.48) * Math.PI));
    for (let j = 1; j <= tall; j += 1) art.put(x, Math.round(top) - j, j === tall ? rgba('#ee5c28') : fin);
  }
  const chin = Math.round(spine(0.3) + half(0.3));
  for (let j = 1; j < 4; j += 1) for (let i = 0; i <= 3 - j; i += 1) art.put(Math.round(0.72 * (L - 1)) - i, chin + j, j > 2 ? rgba('#ffcf63') : fin);
  const ex = Math.round(0.9 * (L - 1));
  const ey = Math.round(spine(0.1) - hmax * 0.3);
  const white = rgba('#fff6d6');
  art.put(ex - 1, ey, white);
  art.put(ex + 1, ey, white);
  art.put(ex, ey - 1, white);
  art.put(ex, ey + 1, white);
  art.put(ex, ey, rgba('#1a0a0a'));
  art.put(L, Math.round(spine(0) + 1), rgba('#b5261f'));
  art.put(L + 1, Math.round(spine(0) + 2), rgba('#f0602a'));
  return { image: art.canvas(), ax: Math.round(L * 0.44), ay: Math.round(pad - hmax) - 1 };
}

/** A round paper lantern on a string: ribs, two caps and a tassel. */
function paperLantern(w, h, colours) {
  const rx = w / 2;
  const ry = h / 2;
  const tassel = Math.round(h * 0.45) + 1;
  const art = new Art(w + 2, h + tassel + 4);
  const cx = rx + 0.5;
  const cy = ry + 2;
  for (let y = 0; y < h + 4; y += 1) {
    for (let x = 0; x <= w + 1; x += 1) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      // Ribs bend with the sphere, and the candle is low in the middle.
      const rib = Math.abs(Math.sin(Math.asin(clamp(nx / Math.sqrt(Math.max(0.05, 1 - ny * ny)), -1, 1)) * (w > 11 ? 4 : 3)));
      art.tone(x, y, colours, clamp(0.94 - Math.hypot(nx, ny - 0.12) * 0.84 - (rib < 0.16 ? 0.16 : 0)), 0.65);
    }
  }
  const capW = Math.max(3, Math.round(w * 0.42));
  const mid = Math.floor(cx);
  const capX = mid - Math.floor(capW / 2);
  art.rect(capX, 1, capW, 2, rgba('#2a1210'));
  art.rect(capX, 1, capW, 1, rgba('#7c4a1f'));
  art.rect(capX, h + 1, capW, 2, rgba('#2a1210'));
  art.rect(capX, h + 2, capW, 1, rgba('#7c4a1f'));
  for (let j = 0; j < tassel; j += 1) {
    art.put(mid, h + 3 + j, rgba(j > tassel - 3 ? '#ffd362' : '#e8542a'));
    if (j > tassel - 3 && w > 8) art.put(mid + (j % 2 ? 1 : -1), h + 3 + j, rgba('#ffb04a'));
  }
  return { image: art.canvas(), ax: mid, ay: 1 };
}

/** A paper lantern on its way up: wider at the crown, and bright where the flame is. */
function skyLantern(w, h) {
  const art = new Art(w + 2, h + 2);
  const mid = (w + 1) / 2;
  for (let y = 0; y < h; y += 1) {
    const k = y / (h - 1);
    const half = mix(w * 0.5, w * 0.34, k) * (y === 0 ? 0.72 : 1);
    for (let x = Math.ceil(mid - half); x <= mid + half; x += 1) {
      const nx = (x - mid) / half;
      art.tone(x, y + 1, LAMP.orange, clamp(0.12 + k * 0.8 - nx * nx * 0.34 + (Math.abs(nx) < 0.34 ? 0.08 : 0)), 0.65);
    }
  }
  art.rect(Math.round(mid - w * 0.17), h, Math.max(1, Math.round(w * 0.34)), 1, rgba('#fffbe0'));
  return art.canvas();
}

/* ── the village ──────────────────────────────────────────────────── */

/**
 * A long roof, side on: rows of tile, a heavy ridge whose ends curl up, eaves that
 * lift at the corners. `o.lit` is how much moon it gets.
 */
function paintRoof(art, x0, x1, top, eave, colours, grain, o = {}) {
  const { inset = 10, course = 3, rib = 4, lit = 0.5, ridge = 2, curl = 4 } = o;
  const span = eave - top;
  for (let y = top; y <= eave + curl; y += 1) {
    const k = clamp((y - top) / span);
    const side = mix(inset, 0, k ** 0.75);
    for (let x = Math.round(x0 + side); x <= x1 - side; x += 1) {
      // The eave lifts towards each corner.
      const toEnd = Math.min(x - x0, x1 - x);
      const lift = Math.max(0, 1 - toEnd / 16) ** 2 * curl;
      if (y > eave - lift) continue;
      const row = Math.floor((y - top) / course);
      let v = lit + (k - 0.5) * 0.14 + ((x - x0) / (x1 - x0) - 0.5) * 0.12 + (grain(x / 7, y / 4) - 0.5) * 0.24;
      if ((y - top) % course === 0) v -= 0.28;
      if ((x + row * 2) % rib === 0) v -= 0.14;
      if (y >= eave - lift - 1) v = 0.02;
      art.tone(x, y, colours, clamp(v), 0.4);
    }
  }
  // The ridge, its ends turned up, and the moon along it.
  const left = Math.round(x0 + inset - 3);
  const right = Math.round(x1 - inset + 3);
  const top1 = colours[colours.length - 1];
  const top2 = colours[Math.max(0, colours.length - 3)];
  for (let i = 0; i < ridge; i += 1) art.rect(left, top - 1 - i, right - left, 1, i === ridge - 1 ? top1 : top2);
  art.rect(left, top, right - left, 1, colours[0]);
  for (let i = 0; i < 5; i += 1) {
    const up = Math.round((i / 5) ** 1.6 * 5);
    art.rect(left - i, top - ridge - up, 2, ridge, top2);
    art.rect(right + i - 2, top - ridge - up, 2, ridge, top1);
  }
}

/** A clump of bamboo: stems that lean out from the root, each ending in a drooping plume. */
function paintBamboo(art, cx, base, w, h, colours, rand, grain) {
  const stems = [];
  const stem = colours[1];
  for (let c = 0; c < 8; c += 1) {
    const lean = ((c + 0.5) / 8 - 0.5) * w;
    const tall = h * (0.72 + rand() * 0.28) * (1 - Math.abs(lean / w) * 0.42);
    const fall = lean >= 0 ? 1 : -1;
    for (let i = 0; i < 40; i += 1) {
      const k = i / 39;
      art.put(cx + lean * 0.3 + lean * k * k, base - tall * k + k ** 4 * tall * 0.1, stem);
    }
    for (let i = 0; i < 26; i += 1) {
      const k = 0.42 + (i / 25) * 0.58;
      stems.push({ x: cx + lean * 0.3 + lean * k * k + fall * rand() * 4, y: base - tall * k + k ** 4 * tall * 0.1 + rand() * 3, r: 1.3 + rand() * 1.8, z: rand() * 2 });
    }
  }
  puffs(art, stems, colours, { light: [0.7, -0.65, 0.3], height: 0.2, spread: 0.8, grain, lift: 0.04 });
}

/** A betel palm: a bare trunk with a little curve, and a head of drooping fronds. */
function paintPalm(art, x, base, tall, lean, c, lit) {
  for (let i = 0; i <= tall; i += 1) {
    const k = i / tall;
    const px = x + lean * k * k;
    art.put(px, base - i, c);
    art.put(px + 1, base - i, lit);
  }
  const hx = x + lean;
  const hy = base - tall;
  for (let f = 0; f < 11; f += 1) {
    const a = -Math.PI * (f / 10);
    const len = 14 + (f % 3) * 3;
    for (let i = 0; i < len; i += 1) {
      const k = i / len;
      const fx = hx + Math.cos(a) * len * k;
      const fy = hy + Math.sin(a) * len * 0.62 * k + k * k * len * 0.55;
      art.put(fx, fy, f < 5 ? lit : c);
      if (i % 2 === 0 && i > 2) art.put(fx, fy + 1, c);
      if (i % 3 === 0 && i > 3) art.put(fx + (Math.cos(a) > 0 ? 0 : 1), fy + 2, c);
    }
  }
}

/** One mass of leaves: a ball of small round clusters. */
const foliage = (rand, cx, cy, rx, ry, count, rSmall, rBig) => {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    list.push({ x: cx + Math.cos(a) * k * rx, y: cy + Math.sin(a) * k * ry, r: rSmall + rand() * (rBig - rSmall), z: rand() * 2 });
  }
  return list;
};

/** The banyan: a crown like a hillside in masses of small leaf, a buttressed trunk, roots hanging down like rain. */
function paintBanyan(art, rand, leafy) {
  const CROWN = ramp('#04061c', '#060a26', '#090e31', '#0c133c', '#101947', '#162257', '#1e2c6c', '#2a3a82', '#3f4f9c');
  const TRUNK = ramp('#04061b', '#070a26', '#0b1033', '#111844', '#1a2459', '#28366f', '#3a4889');
  const tx = 50;
  const ground = 238;
  // The trunk: several stems grown together, flaring into roots.
  for (let y = 96; y < ground + 3; y += 1) {
    const k = (y - 96) / (ground - 96);
    const half = 13 + k ** 3 * 28;
    for (let x = Math.round(tx - half); x <= tx + half; x += 1) {
      const n = (x - tx) / half;
      const flute = Math.sin(n * 10 + Math.sin(y * 0.05) * 0.6) * 0.5 + 0.5;
      // Gaps open between the roots low down.
      if (k > 0.86 && flute < (k - 0.86) * 6 && Math.abs(n) > 0.2) continue;
      art.tone(x, y, TRUNK, clamp(0.12 + n * 0.26 + flute * 0.26 + (n > 0.45 ? 0.16 : 0)), 0.6);
    }
  }
  // Limbs reaching out under the crown.
  for (const [x0, y0, x1, y1, r] of [[54, 110, 140, 86, 5], [46, 110, -14, 90, 5], [58, 130, 118, 106, 3.4], [44, 130, 2, 114, 3]]) {
    limb(art, x0, y0, x1, y1, r, r * 0.5, TRUNK[1]);
    for (let k = 0; k <= 1; k += 0.01) art.put(mix(x0, x1, k) + k * 2, mix(y0, y1, k) - mix(r, r * 0.5, k) * 0.8, TRUNK[3]);
  }
  // The roots that hang.
  const dark = TRUNK[1];
  const edge = TRUNK[3];
  for (let i = 0; i < 30; i += 1) {
    const x = Math.round(-6 + rand() * 166);
    if (Math.abs(x - tx) < 22) continue;
    const near = x > 86 ? 1 - (x - 86) / 74 : 1;
    const end = Math.round(118 + rand() * 62 * near + (Math.abs(x - tx) < 40 ? 44 : 0));
    const wob = rand() * 9;
    for (let y = 72; y < end; y += 1) {
      const px = x + Math.sin(y / 15 + wob);
      art.put(px, y, dark);
      if (i % 3 === 0) art.put(px + 1, y, edge);
    }
  }
  // The crown, mass by mass: top ones first, so each lower mass's lit top lies over the dark under the last.
  const masses = [];
  for (const [cx, cy, rx, ry] of [
    [20, 16, 34, 18], [74, 12, 38, 16], [128, 22, 30, 14], [-14, 38, 30, 20], [38, 36, 36, 22], [92, 36, 34, 20], [146, 44, 30, 15],
    [-6, 64, 32, 19], [50, 60, 38, 21], [106, 58, 32, 19], [164, 66, 24, 13], [14, 86, 30, 15], [72, 84, 34, 16], [124, 80, 28, 15], [168, 88, 15, 8],
  ]) masses.push([cx, cy, rx, ry]);
  for (const [cx, cy, rx, ry] of masses) {
    const sun = clamp((cx + 20) / 190);
    puffs(art, foliage(rand, cx, cy, rx, ry, Math.round((rx * ry) / 8.5), 2.2, 5.4), CROWN, {
      light: [0.72, -0.62, 0.3], height: 0.62, spread: 0.85, lift: -0.17 + sun * 0.18, grain: leafy,
    });
  }
}

/** A shape for the old story: on the moon there sits a boy, under a banyan. Only ever a darker patch. */
function moonStory(rand) {
  const balls = [];
  for (let i = 0; i < 20; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    balls.push({ x: -15 + Math.cos(a) * k * 20, y: 1 + Math.sin(a) * k * 12, r: 3.6 + rand() * 3.2 });
  }
  return (dx, dy) => {
    for (const b of balls) if ((dx - b.x) ** 2 + (dy - b.y) ** 2 < b.r * b.r) return true;
    if (dy > 2 && dy < 36 && Math.abs(dx + 15 + (dy - 10) * 0.05) < 2 + (dy > 28 ? (dy - 28) * 0.7 : 0)) return true;
    for (const [bx, by, r] of [[4, 26, 2.2], [4.4, 31, 3], [8, 33, 1.5], [0, 34.4, 1.5]]) if ((dx - bx) ** 2 + (dy - by) ** 2 < r * r) return true;
    return false;
  };
}

/** Thin cloud: long streaks, tapered at both ends, on a sheet that wraps. */
function streaks(rand, seed, height, count, colours, longest) {
  const art = new Art(960, height);
  const fray = noise2(seed, 64);
  for (let i = 0; i < count; i += 1) {
    const cx = rand() * 960;
    const cy = 3 + rand() * (height - 6);
    const half = longest * (0.35 + rand() * 0.65);
    const thick = 1.2 + rand() * 3.4;
    for (let dy = -Math.ceil(thick); dy <= thick; dy += 1) {
      const k = Math.abs(dy) / (thick + 0.5);
      const reach = half * (1 - k * k) ** 0.8;
      const shift = (fray(i * 3.7, (dy + 9) * 0.9) - 0.5) * half * 0.34;
      for (let x = -reach; x <= reach; x += 1) {
        const px = cx + shift + x;
        const y = Math.round(cy + dy + Math.sin(px / 83) * 2);
        const edge = 1 - Math.abs(x) / reach;
        const a = edge * 2.4 * (0.5 + fbm2(fray, px / 15, y / 2.5, 2)) - 0.16;
        if (a <= bayer(Math.round(px), y)) continue;
        const shade = clamp(0.62 - dy / (thick * 1.8) + edge * 0.1);
        art.wrap(px, y, colours[Math.min(colours.length - 1, Math.floor(shade * colours.length))]);
      }
    }
  }
  return art.canvas();
}

/* ── the scene ────────────────────────────────────────────────────── */

const midAutumn = {
  build() {
    const rand = seeded(2027);

    // The sky: nearly black at the top, deepening blue, and the moon's warm breath around it.
    const SKY = ramp('#050823', '#070b2c', '#0a1037', '#0d1543', '#111b50', '#15225d', '#1a2a6b', '#213378', '#2a3d84', '#39488e', '#4e5094', '#695a96', '#886594', '#a97089', '#c97e73', '#e4955f', '#f6b25e');
    const skyNoise = noise2(2028, 64);
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot(x - MOON.x, y - MOON.y);
      const base = 0.05 + 0.3 * clamp(y / 190) ** 1.25 + (fbm2(skyNoise, x / 26, y / 15, 3) - 0.5) * 0.06;
      const near = Math.max(0, d - MOON.r);
      const corona = 0.58 * Math.exp(-((near / 17) ** 1.4)) + 0.22 * Math.exp(-((near / 66) ** 2));
      return clamp(base + corona);
    }, 0.95);
    // A warm low haze over the rooftops, from a whole village's lanterns.
    const FESTIVE = ramp('#2a3d84', '#3f468c', '#5a4f8e', '#7f5a88', '#a56a78');
    sky.shade(FESTIVE, (x, y) => {
      const k = (y - 132) / 60;
      if (k < 0) return -1;
      const v = k ** 1.7 * (0.72 + 0.34 * Math.sin(x / 67));
      return bayer(x + 2, y) < v * 1.2 ? clamp(v) : -1;
    }, 0.7, [0, 132, W, 200]);

    // The moon: warm all through, darker seas, and at its edge the sphere turning away.
    const MOONLIT = ramp('#b9652c', '#cf7c31', '#e0923a', '#eca848', '#f4bb5c', '#fbcd76', '#ffdc92', '#ffe8ae', '#fff2ca', '#fff9e4');
    const seas = noise2(2029, 64);
    const story = moonStory(seeded(2030));
    for (let y = MOON.y - MOON.r; y <= MOON.y + MOON.r; y += 1) {
      for (let x = MOON.x - MOON.r; x <= MOON.x + MOON.r; x += 1) {
        const nx = (x - MOON.x) / MOON.r;
        const ny = (y - MOON.y) / MOON.r;
        const d2 = nx * nx + ny * ny;
        if (d2 > 1) continue;
        const z = Math.sqrt(1 - d2);
        const sea = smooth(clamp((fbm2(seas, x / 21 + 5, y / 21, 4) - 0.47) * 5.5));
        const speck = fbm2(seas, x / 3.4, y / 3.4, 2) - 0.5;
        const dx = x - MOON.x;
        const dy = y - MOON.y;
        // The boy and his tree, with a rough edge so it is a patch of the moon and not a stamp on it.
        const inStory = story(dx + (seas(x / 3, y / 3) - 0.5) * 3, dy + (seas(x / 3 + 40, y / 3) - 0.5) * 3);
        const v = 0.46 + z * 0.4 + (nx * 0.07 - ny * 0.1) - sea * 0.2 + speck * 0.12 - (inStory ? 0.24 : 0) - (d2 > 0.92 ? (d2 - 0.92) * 2.4 : 0);
        sky.tone(x, y, MOONLIT, clamp(v), 0.7);
      }
    }
    // A few old craters, each with a lit lip on the side away from the light.
    for (const [cx, cy, r] of [[398, 58, 5], [356, 40, 3.2], [408, 104, 4], [330, 72, 2.6], [390, 122, 3], [418, 76, 2.4]]) {
      for (let a = 0; a < TAU; a += 0.17) {
        const px = Math.round(cx + Math.cos(a) * r);
        const py = Math.round(cy + Math.sin(a) * r);
        if (Math.hypot(px - MOON.x, py - MOON.y) >= MOON.r) continue;
        if ((px + py) % 3 !== 0) sky.put(px, py, MOONLIT[Math.cos(a) - Math.sin(a) > 0 ? 5 : 7]);
      }
    }

    const stars = starField(rand, 200, 170).filter((s) => Math.hypot(s.x - MOON.x, s.y - MOON.y) > MOON.r + 24 && !(s.x < 176 && s.y > 104));

    // Thin cloud, stretched long: two sheets that cross the moon at their own speeds.
    const cloudsHigh = streaks(rand, 2031, 56, 13, ramp('#1a2565', '#222e72', '#2c387e', '#39458a'), 92);
    const cloudsLow = streaks(rand, 2032, 74, 17, ramp('#2b3576', '#3a4186', '#4e4e93', '#6a5c9b', '#8e6d9c'), 118);

    // The moon's own glow, over the clouds that cross it: little on the disc, most just off its edge.
    const bloomArt = new Art(301, 301);
    for (let y = 0; y < 301; y += 1) {
      for (let x = 0; x < 301; x += 1) {
        const d = Math.hypot(x - 150, y - 150);
        const a = d < MOON.r ? 0.05 : 0.3 * Math.exp(-(d - MOON.r) / 30);
        const level = Math.floor(a * 16 + bayer(x, y));
        if (level > 0) bloomArt.px[y * 301 + x] = see('#ffa055', Math.round(clamp(level / 16) * 255));
      }
    }

    // Paper lanterns going up, of a few sizes.
    const sizes = [[5, 7], [5, 7], [6, 8], [7, 9], [8, 11], [10, 13], [12, 15]];
    const lanternSprites = sizes.map(([w, h]) => skyLantern(w, h));
    const risers = [[188, 2], [262, 0], [98, 4], [214, 1], [302, 2], [460, 3], [152, 5], [442, 5], [332, 0], [130, 0], [238, 4], [410, 1], [476, 1], [284, 6]].map(([x, size]) => {
      const [w, h] = sizes[size];
      return { x, size, w, h, v: 2 + (w / 12) * 3.2, y: rand() * 240, sway: 2 + rand() * 5, period: 7 + rand() * 9, phase: rand() };
    });
    const skyGlows = [glowOf(9, 9, '#ff9a3c', 0.34), glowOf(13, 13, '#ff9a3c', 0.34), glowOf(18, 18, '#ff9a3c', 0.34)];

    const grainFine = noise2(2033, 64);
    const leafy = (x, y) => (fbm2(grainFine, x / 2.6, y / 2.6, 2) - 0.5) * 0.5;
    const tile = noise2(2034, 64);
    const tileGrain = (x, y) => fbm2(tile, x, y, 2);

    const land = new Art();

    // A far hill behind the village, moonlit on its right, with a path up it.
    const HILL = ramp('#1c2868', '#222f73', '#29377d', '#314187', '#3b4c92');
    const hillLine = noise1(2037, 128);
    const hillTop = (x) => 192 - 56 * Math.exp(-(((x - 236) / 104) ** 2)) - 18 * Math.exp(-(((x - 96) / 46) ** 2)) + (fbm1(hillLine, x / 18, 3) - 0.5) * 9;
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(hillTop(x));
      const slope = hillTop(x + 5) - hillTop(x - 5);
      for (let y = top; y < 200; y += 1) land.tone(x, y, HILL, clamp(0.46 - (y - top) / 80 - slope * 0.05 + (fbm2(grainFine, x / 5, y / 5, 2) - 0.5) * 0.44), 0.7);
    }
    // The path up the hill, with a place for a far line of lights.
    const pathAt = (k) => [mix(160, 306, k) + Math.sin(k * 11) * 16, mix(186, 142, k ** 0.9) + Math.sin(k * 22) * 1.4];
    for (let k = 0; k < 1; k += 0.004) {
      const [x, y] = pathAt(k);
      land.put(x, y, HILL[4]);
    }

    // The far bamboo and betel palms, cut out against the haze.
    const FAR = ramp('#141e5a', '#182463', '#1c2a6c', '#233277', '#2d3d85', '#3c4d97');
    const FAR_FLAT = FAR[1];
    const FAR_EDGE = FAR[4];
    for (const [x, base, w, h] of [[138, 190, 40, 40], [186, 192, 56, 50], [262, 192, 44, 36], [308, 192, 60, 62], [354, 192, 40, 44], [452, 192, 56, 58]]) paintBamboo(land, x, base, w, h, FAR, rand, leafy);
    paintPalm(land, 324, 192, 94, 5, FAR_FLAT, FAR_EDGE);
    paintPalm(land, 347, 192, 74, -4, FAR_FLAT, FAR_EDGE);
    paintPalm(land, 228, 192, 72, 4, FAR_FLAT, FAR_EDGE);
    paintPalm(land, 469, 192, 106, -5, FAR_FLAT, FAR_EDGE);
    land.rect(0, 190, W, 44, FAR[0]);

    // Roofs behind the wall, mid-distance.
    const MID = ramp('#0a113d', '#0e1546', '#121b52', '#18225f', '#1f2b6c', '#2a397f', '#3c4a94', '#55649e');
    const mids = [[122, 214, 170, 196, 0.34], [196, 268, 176, 198, 0.42], [252, 346, 164, 196, 0.52], [326, 382, 178, 198, 0.38], [438, 502, 168, 196, 0.5]];
    for (const [x0, x1, top, eave, lit] of mids) {
      paintRoof(land, x0, x1, top, eave, MID, tileGrain, { lit, inset: 12, course: 3, rib: 3, ridge: 2, curl: 3 });
      land.rect(x0 + 2, eave - 1, x1 - x0 - 4, 30, MID[1]);
    }
    // A little warm in a wall or two, seen over the wall.
    const windows = [];
    for (const [x, y, w, h] of [[150, 196, 6, 3], [224, 197, 5, 3], [286, 196, 7, 4], [346, 197, 5, 3], [456, 196, 6, 3]]) {
      land.rect(x - 1, y - 1, w + 2, h + 1, rgba('#060a2c'));
      windows.push({ x, y, w, h, period: 9 + rand() * 13, phase: rand() });
    }

    // The wall along the lane: limewash gone blue in the moon, with a cap of tiles.
    const WALL = ramp('#141c54', '#1a2460', '#212d6e', '#29387c', '#33448b', '#3f5199', '#4d5fa6');
    const wallNoise = noise2(2035, 64);
    land.shade(WALL, (x, y) => {
      const toGround = clamp((y - 206) / 28);
      const stain = fbm2(wallNoise, x / 16, y / 22, 3);
      return clamp(0.66 - toGround * 0.5 + (stain - 0.5) * 0.42 + ((x - 240) / 240) * 0.08);
    }, 0.5, [0, 202, W, 236]);
    paintRoof(land, 70, 500, 197, 204, MID, tileGrain, { lit: 0.62, inset: 0, course: 2, rib: 3, ridge: 1, curl: 0 });
    for (let x = 70; x < W; x += 3) land.put(x, 205, MID[0]);
    land.rect(70, 206, W - 70, 1, rgba('#111850'));
    // A band of damp at the foot of the wall, and a few patches of old plaster.
    for (let i = 0; i < 26; i += 1) {
      const px = 80 + rand() * 390;
      const py = 210 + rand() * 18;
      const pw = 4 + rand() * 14;
      const ph = 2 + rand() * 3;
      for (let y = py; y < py + ph; y += 1) for (let x = px; x < px + pw; x += 1) land.tone(x, y, WALL, 0.28 + rand() * 0.1, 0.4);
    }

    // The village gate: arch, two tiers of roof, and the warm light of the green behind it.
    const ROOFN = ramp('#080c2c', '#0c1136', '#111844', '#172055', '#1f2c6b', '#2c3b84', '#3f50a0', '#5d6dbc');
    const GATEWALL = ramp('#10174a', '#161f58', '#1e2967', '#273478', '#31408a', '#3e4e9a', '#4f60ab');
    land.shade(GATEWALL, (x, y) => {
      const n = (x - GATE_X) / 40;
      return clamp(0.58 + n * 0.28 + (fbm2(wallNoise, x / 11, y / 15, 3) - 0.5) * 0.34 + (Math.abs(n) > 0.86 ? 0.14 : 0) - ((y - 180) / 56) * 0.28);
    }, 0.55, [GATE_X - 40, 176, GATE_X + 41, 238]);
    // Two pillars standing proud, each with its square cap.
    for (const side of [-1, 1]) {
      const px = GATE_X + side * 36;
      land.shade(GATEWALL, (x, y) => clamp(0.48 + ((x - px) / 5) * 0.34 - ((y - 170) / 70) * 0.2), 0.5, [px - 5, 170, px + 6, 238]);
      land.rect(px - 6, 165, 13, 4, ROOFN[5]);
      land.rect(px - 6, 169, 13, 1, ROOFN[0]);
      land.rect(px - 3, 160, 7, 5, ROOFN[3]);
      land.rect(px - 1, 156, 3, 4, ROOFN[6]);
    }
    // The arch: the light comes from beyond it.
    const ARCH = ramp('#7a3722', '#a84d24', '#cf6d29', '#ea8f35', '#f7ae4a', '#fdc969', '#ffe091');
    const inArch = (x, y) => {
      const n = x - GATE_X;
      const top = y - 206;
      return Math.abs(n) <= 14 && y < 238 && (top >= 0 || n * n + top * top <= 196);
    };
    land.shade(ARCH, (x, y) => (inArch(x, y) ? clamp(0.98 - (Math.abs(x - GATE_X) / 16) * 0.42 - ((236 - y) / 46) * 0.42) : -1), 0.7, [GATE_X - 15, 191, GATE_X + 16, 238]);
    for (let a = Math.PI; a <= TAU; a += 0.04) {
      for (let r = 14.5; r < 17; r += 0.7) land.put(Math.round(GATE_X + Math.cos(a) * r), Math.round(206 + Math.sin(a) * r), a < Math.PI * 1.5 ? ROOFN[1] : ROOFN[4]);
    }
    land.rect(GATE_X - 16, 206, 2, 32, ROOFN[1]);
    land.rect(GATE_X + 15, 206, 2, 32, ROOFN[3]);
    paintRoof(land, GATE_X - 50, GATE_X + 50, 166, 180, ROOFN, tileGrain, { lit: 0.56, inset: 10, course: 2, rib: 3, ridge: 2, curl: 4 });
    land.shade(GATEWALL, (x, y) => clamp(0.46 + (x - GATE_X) / 90 + (fbm2(wallNoise, x / 7, y / 4, 2) - 0.5) * 0.3), 0.5, [GATE_X - 22, 156, GATE_X + 23, 168]);
    paintRoof(land, GATE_X - 32, GATE_X + 32, 144, 158, ROOFN, tileGrain, { lit: 0.64, inset: 9, course: 2, rib: 3, ridge: 2, curl: 4 });

    // The lane: worn stones, wider as they come nearer.
    const LANE = ramp('#090d30', '#0d1239', '#111844', '#161f50', '#1c275f', '#24306e', '#2f3b7e');
    const stones = noise2(2036, 64);
    const rows = [234, 238, 243, 249, 256, 264, 273];
    for (let r = 0; r + 1 < rows.length; r += 1) {
      const top = rows[r];
      const tall = rows[r + 1] - top;
      const span = 12 + r * 5;
      let x = -Math.floor(rand() * span);
      while (x < W) {
        const w = span + Math.floor(rand() * span * 0.8);
        const tone = 0.38 + rand() * 0.3;
        for (let y = top; y < top + tall; y += 1) {
          for (let i = x; i < x + w; i += 1) {
            if (i === x || y === top) land.put(i, y, LANE[0]);
            else land.tone(i, y, LANE, clamp(tone + (y === top + 1 ? 0.16 : 0) + (fbm2(stones, i / 3, y / 2, 2) - 0.5) * 0.34 - (r / 6) * 0.12), 0.6);
          }
        }
        x += w;
      }
    }

    paintBanyan(land, rand, leafy);

    // A little shrine under the banyan, one flame kept going in it.
    land.rect(SHRINE_X - 7, 217, 14, 19, ROOFN[1]);
    land.rect(SHRINE_X - 7, 217, 1, 19, ROOFN[0]);
    land.rect(SHRINE_X + 6, 217, 1, 19, ROOFN[4]);
    land.rect(SHRINE_X - 4, 221, 8, 8, rgba('#a84d24'));
    land.rect(SHRINE_X - 3, 225, 6, 4, rgba('#cf6d29'));
    paintRoof(land, SHRINE_X - 11, SHRINE_X + 11, 211, 217, ROOFN, tileGrain, { lit: 0.5, inset: 4, course: 2, rib: 2, ridge: 1, curl: 2 });

    // Banana leaves at the far right corner, nearest of all, and grass along the lower edge.
    const front = new Art();
    const LEAF = ramp('#03051a', '#060924', '#0a0f33', '#101845', '#182359', '#253274', '#3a4894');
    const banana = (x, y, len, angle, droop) => {
      const steps = Math.ceil(len);
      let px = x;
      let py = y;
      let a = angle;
      for (let i = 0; i < steps; i += 1) {
        const k = i / steps;
        const half = Math.sin(Math.min(1, k * 1.04) * Math.PI) ** 0.6 * len * 0.14;
        const nx = -Math.sin(a);
        const ny = Math.cos(a);
        for (let j = -half; j <= half; j += 0.5) {
          const torn = Math.sin(i * 0.9 + (j > 0 ? 2 : 0)) > 0.72 && Math.abs(j) > half * 0.55;
          if (torn) continue;
          const rib = (i + Math.round(Math.abs(j) * 0.8)) % 4 === 0 ? -0.08 : 0;
          const v = clamp(0.22 + (j < 0 ? 0.26 : 0) + rib + (Math.abs(j) < 0.8 ? 0.34 : 0));
          front.tone(Math.round(px + nx * j), Math.round(py + ny * j), LEAF, v, 0.3);
        }
        px += Math.cos(a);
        py += Math.sin(a);
        a += droop;
      }
    };
    for (const [x, y, len, a, droop] of [[458, 278, 66, -2.55, -0.012], [490, 244, 50, -2.45, -0.02], [486, 268, 88, -2.02, -0.012], [472, 276, 76, -2.32, -0.014], [478, 274, 98, -1.56, -0.01]]) banana(x, y, len, a, droop);
    for (let x = 0; x < W; x += 1) {
      const fringe = 2 + Math.floor(rand() * 5) + (x < 80 ? 3 : 0);
      for (let j = 0; j < fringe; j += 1) front.put(x, H - 1 - j, LEAF[j === fringe - 1 ? 2 : 0]);
    }

    // A last curtain of banyan leaf at the top left, nearest, moving a little.
    const bough = new Art(176, 56);
    const BOUGH = ramp('#02041a', '#03051d', '#050824', '#080c2e', '#0d1442', '#16215c');
    const hanging = [];
    for (let s = 0; s < 34; s += 1) {
      const x = 2 + rand() * 170;
      const reach = (6 + rand() * 42) * (1 - (x / 176) * 0.72);
      for (let k = 0; k < reach; k += 1.8) hanging.push({ x: x + (rand() - 0.5) * 3 + Math.sin(k / 6 + s) * 1.5, y: k + rand(), r: 0.9 + rand() * 1.5, z: rand() });
    }
    puffs(bough, hanging, BOUGH, { light: [0.7, -0.62, 0.3], height: 0.1, spread: 0.7, lift: -0.02 });

    // The children, in two lines; the near one larger.
    const nearKids = [[1.38, 'bowl'], [1.22, 'buns'], [1.42, 'hat'], [1.16, 'knot'], [1.34, 'braid']].map(([s, style]) => childFrames(s, style));
    const farKids = [[0.86, 'knot'], [0.78, 'braid'], [0.92, 'hat']].map(([s, style]) => childFrames(s, style));

    // Stars in the shops' three colours, tilted as they sway; carp with the tail swung to each side.
    const starSet = (R) => [LAMP.red, LAMP.gold, LAMP.rose].map((colours) => [-0.14, -0.05, 0.05, 0.14].map((turn) => starLantern(R, colours, turn)));
    const stars11 = starSet(11);
    const stars6 = starSet(6.5);
    const carps = [-1, -0.4, 0.4, 1].map((swing) => carpLantern(30, swing));
    const carpsSmall = [-1, -0.4, 0.4, 1].map((swing) => carpLantern(18, swing));
    const round = [paperLantern(9, 11, LAMP.orange), paperLantern(11, 11, LAMP.gold)];

    // Near line: who carries what, and where they are along the lane. The gaps are uneven, as they would be.
    const SPAN = W + 140;
    const near = [
      { at: 8, kid: 0, kind: 'star', c: 0, pole: [8, -20], period: 2.7 },
      { at: 60, kid: 3, kind: 'carp', c: 0, pole: [9, -18], period: 3.1 },
      { at: 126, kid: 1, kind: 'star', c: 1, pole: [7, -19], period: 2.3 },
      { at: 178, kid: 2, kind: 'carp', c: 0, pole: [10, -20], period: 3.4 },
      { at: 250, kid: 4, kind: 'star', c: 2, pole: [8, -22], period: 2.6 },
      { at: 306, kid: 1, kind: 'star', c: 0, pole: [7, -20], period: 2.9 },
      { at: 358, kid: 3, kind: 'round', c: 1, pole: [8, -16], period: 2.1 },
      { at: 430, kid: 0, kind: 'carp', c: 0, pole: [10, -20], period: 3 },
      { at: 496, kid: 2, kind: 'star', c: 1, pole: [8, -20], period: 2.5 },
      { at: 550, kid: 4, kind: 'star', c: 0, pole: [7, -23], period: 2.8 },
    ];
    const far = [
      { at: 20, kid: 0, kind: 'star', c: 1, pole: [5, -13], period: 2.4 },
      { at: 74, kid: 2, kind: 'carp', c: 0, pole: [6, -12], period: 2.9 },
      { at: 116, kid: 1, kind: 'star', c: 0, pole: [5, -12], period: 2.2 },
      { at: 186, kid: 2, kind: 'star', c: 2, pole: [5, -13], period: 2.7 },
      { at: 232, kid: 0, kind: 'carp', c: 0, pole: [6, -13], period: 3.1 },
      { at: 298, kid: 1, kind: 'star', c: 1, pole: [5, -12], period: 2.5 },
      { at: 352, kid: 0, kind: 'star', c: 0, pole: [5, -13], period: 2.8 },
      { at: 410, kid: 2, kind: 'carp', c: 0, pole: [6, -12], period: 2.6 },
      { at: 470, kid: 1, kind: 'star', c: 2, pole: [5, -12], period: 2.3 },
    ];

    // Strings of lanterns: the ends, the sag, what hangs on them, and how they catch the air.
    const paper = [
      paperLantern(13, 15, LAMP.red),
      paperLantern(14, 13, LAMP.orange),
      paperLantern(12, 15, LAMP.gold),
      paperLantern(13, 14, LAMP.rose),
      paperLantern(9, 10, LAMP.red),
      paperLantern(10, 9, LAMP.orange),
      paperLantern(8, 10, LAMP.gold),
      paperLantern(9, 10, LAMP.rose),
    ];
    const strings = [
      { x0: 146, y0: 26, x1: 498, y1: 42, sag: 22, count: 7, big: false, period: 7.5, phase: 0.1 },
      { x0: 124, y0: 90, x1: 372, y1: 144, sag: 26, count: 7, big: true, period: 6.3, phase: 0.45 },
      { x0: 432, y0: 144, x1: 498, y1: 104, sag: 13, count: 2, big: true, period: 8.2, phase: 0.7 },
    ];
    let which = 0;
    for (const str of strings) {
      str.hung = [];
      for (let i = 0; i < str.count; i += 1) {
        const k = (i + 0.72) / (str.count + 0.44);
        str.hung.push({ k, sprite: (which % 4) + (str.big ? 0 : 4), phase: rand(), period: 2.6 + rand() * 2.2 });
        which += 1;
      }
    }

    // A far procession up the hill path, nothing but points of light.
    const dots = [];
    for (let i = 0; i < 15; i += 1) dots.push({ at: i / 15 + (rand() - 0.5) * 0.02, hot: i % 3 === 0 });

    return {
      sky: sky.canvas(), stars, cloudsHigh, cloudsLow, bloom: bloomArt.canvas(),
      risers, lanternSprites, skyGlows, land: land.canvas(), front: front.canvas(), bough: bough.canvas(),
      windows, nearKids, farKids, stars11, stars6, carps, carpsSmall, round, near, far, SPAN, strings, paper, dots, pathAt,
      paperGlows: [glowOf(22, 22, '#ff8a3a', 0.36), glowOf(14, 14, '#ff8a3a', 0.3)],
      lanternGlow: glowOf(36, 36, '#ff8232', 0.58), lanternGlowSmall: glowOf(22, 22, '#ff8232', 0.5),
      pool: glowOf(42, 9, '#ff9440', 0.42, 1.4), poolSmall: glowOf(26, 5, '#ff9440', 0.38, 1.4),
      gateGlow: glowOf(44, 34, '#ffb060', 0.3, 1.6), shrineGlow: glowOf(16, 12, '#ff9c4a', 0.4, 1.6), spill: glowOf(40, 8, '#ffb060', 0.42, 1.3),
    };
  },

  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    drawStars(ctx, s.stars, t);

    // Thin cloud across the moon, and the moon's own glow over the top of it.
    slide(ctx, s.cloudsHigh, along(t, 1.3, 960), 10);
    slide(ctx, s.cloudsLow, along(t, 2.4, 960), 58);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(s.bloom, MOON.x - 150, MOON.y - 150);
    ctx.globalCompositeOperation = 'source-over';

    // Far-off lanterns behind the village, going up. Each starts well below the rooftops.
    const fly = (r) => ({
      x: Math.round(r.x + Math.sin((t / r.period + r.phase) * TAU) * r.sway),
      y: Math.round(218 - ((r.y + t * r.v) % 250)),
    });
    ctx.globalCompositeOperation = 'lighter';
    for (const r of s.risers) {
      const { x, y } = fly(r);
      const g = s.skyGlows[r.w > 9 ? 2 : r.w > 6 ? 1 : 0];
      ctx.drawImage(g, x + (r.w >> 1) - (g.width >> 1), y + (r.h >> 1) - (g.height >> 1));
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const r of s.risers) {
      const { x, y } = fly(r);
      ctx.drawImage(s.lanternSprites[r.size], x, y);
    }

    ctx.drawImage(s.land, 0, 0);

    // The far line of lights going up the hill.
    for (const d of s.dots) {
      const k = ((d.at + t / 170) % 1 + 1) % 1;
      const fade = Math.sin(k * Math.PI);
      if (fade < 0.08) continue;
      const [x, y] = s.pathAt(k);
      ctx.globalAlpha = Math.min(1, fade * 1.8);
      ctx.fillStyle = d.hot ? '#ffe0a0' : '#ff9d4a';
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    ctx.globalAlpha = 1;

    // Whose light is on, at a slow breath; the gate and the shrine burn steadily.
    for (const w of s.windows) {
      ctx.fillStyle = wave(t, w.period, w.phase) > -0.35 ? '#ffb95f' : '#d98a3c';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#060a2c';
      ctx.fillRect(w.x + (w.w >> 1), w.y, 1, w.h);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.82 + wave(t, 3.7) * 0.1 + wave(t, 1.3) * 0.04;
    ctx.drawImage(s.gateGlow, GATE_X - 44, 214 - 34);
    ctx.drawImage(s.spill, GATE_X - 40, 238 - 8);
    ctx.globalAlpha = 0.75 + wave(t, 1.9) * 0.15 + wave(t, 0.7) * 0.1;
    ctx.drawImage(s.shrineGlow, SHRINE_X - 16, 226 - 12);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = wave(t, 0.7) > -0.2 ? '#fff0b0' : '#ffd070';
    ctx.fillRect(SHRINE_X - 1, 223, 2, 3);

    // The strings. The hang of each moves a little, and what is on it moves more.
    ctx.fillStyle = '#04061c';
    const hangs = [];
    for (const str of s.strings) {
      const breeze = wave(t, str.period, str.phase);
      const count = str.x1 - str.x0;
      let last = null;
      for (let i = 0; i <= count; i += 1) {
        const k = i / count;
        const y = Math.round(mix(str.y0, str.y1, k) + Math.sin(k * Math.PI) * (str.sag + breeze * 1.6));
        const top = last === null ? y : Math.min(last, y);
        ctx.fillRect(str.x0 + i, top, 1, last === null ? 1 : Math.abs(y - last) + 1);
        last = y;
      }
      for (const h of str.hung) {
        hangs.push({
          x: Math.round(mix(str.x0, str.x1, h.k)),
          y: Math.round(mix(str.y0, str.y1, h.k) + Math.sin(h.k * Math.PI) * (str.sag + breeze * 1.6)),
          sprite: h.sprite,
          swing: Math.round(wave(t, h.period, h.phase) * 1.4),
        });
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const h of hangs) {
      const g = s.paperGlows[h.sprite < 4 ? 0 : 1];
      const half = g.width >> 1;
      ctx.drawImage(g, h.x + h.swing - half, h.y + (h.sprite < 4 ? 9 : 7) - half);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const h of hangs) {
      const lamp = s.paper[h.sprite];
      ctx.fillStyle = '#04061c';
      ctx.fillRect(h.x, h.y, 1, 2);
      ctx.drawImage(lamp.image, h.x + h.swing - lamp.ax, h.y + 1 - lamp.ay);
    }

    // Two lines of children, each going at the pace of its own stride. First everyone's light,
    // on the wall and the ground, so that all the children stand dark against it.
    const placing = (line, kids, speed, feet, pace) => {
      const placed = [];
      for (const c of line) {
        const x = Math.round(((c.at + t * speed) % s.SPAN) - 70);
        if (x < -80 || x > W + 80) continue;
        const kid = kids[c.kid];
        const f = Math.floor(((t * STEP_FRAMES) / pace + c.at * 0.37) % STEP_FRAMES);
        const frame = kid.frames[f];
        const handX = x + frame.hx;
        const handY = feet + frame.hy;
        const sway = wave(t, c.period, c.at / 97);
        const topX = handX + c.pole[0] + Math.round(sway * 1.6);
        const topY = handY + c.pole[1] + Math.round(Math.abs(sway) * 0.6);
        placed.push({ c, x, kid, frame, handX, handY, topX, topY, sway, feet });
      }
      return placed;
    };
    const farLine = placing(s.far, s.farKids, 7, FAR_FEET, 1.85);
    const nearLine = placing(s.near, s.nearKids, 10.4, NEAR_FEET, 1.55);

    const lightOf = (line, glow, pool, small) => {
      const r = glow.width >> 1;
      for (const p of line) {
        ctx.drawImage(glow, p.topX - r, p.topY + (p.c.kind === 'star' ? 0 : small ? 5 : 9) - r);
        ctx.drawImage(pool, p.x - (pool.width >> 1) + 3, p.feet - (pool.height >> 1));
      }
    };
    ctx.globalCompositeOperation = 'lighter';
    lightOf(farLine, s.lanternGlowSmall, s.poolSmall, true);
    lightOf(nearLine, s.lanternGlow, s.pool, false);
    ctx.globalCompositeOperation = 'source-over';

    const walk = (line, stars, carps) => {
      for (const p of line) {
        ctx.drawImage(p.frame.image, p.x - p.kid.ox, p.feet - p.kid.oy);
        // The pole, one pixel wide, a little past the hand.
        ctx.fillStyle = '#16100f';
        const dx = p.topX - p.handX;
        const dy = p.topY - p.handY;
        const n = Math.max(Math.abs(dx), Math.abs(dy));
        for (let i = -4; i <= n; i += 1) ctx.fillRect(Math.round(p.handX + (dx * i) / n), Math.round(p.handY + (dy * i) / n), 1, 1);
      }
      for (const p of line) {
        if (p.c.kind === 'star') {
          const lamp = stars[p.c.c][Math.min(3, Math.floor((p.sway * 0.5 + 0.5) * 4))];
          ctx.drawImage(lamp.image, p.topX - lamp.ax, p.topY - lamp.ay);
        } else if (p.c.kind === 'carp') {
          // A carp hangs from the pole by a short thread, its tail going.
          const lamp = carps[Math.floor(((t / 1.4 + p.c.at * 0.13) % 1) * 4) % 4];
          ctx.fillStyle = '#16100f';
          ctx.fillRect(p.topX, p.topY, 1, 3);
          ctx.drawImage(lamp.image, p.topX - lamp.ax, p.topY + 2 - lamp.ay);
        } else {
          const lamp = s.round[p.c.c];
          ctx.fillStyle = '#16100f';
          ctx.fillRect(p.topX, p.topY, 1, 2);
          ctx.drawImage(lamp.image, p.topX - lamp.ax, p.topY + 1 - lamp.ay);
        }
      }
    };
    walk(farLine, s.stars6, s.carpsSmall);
    walk(nearLine, s.stars11, s.carps);

    // The corners, nearest of all.
    ctx.drawImage(s.front, 0, 0);
    ctx.drawImage(s.bough, -8 + Math.round(wave(t, 9.1) * 1.4), -3 + Math.round(wave(t, 6.7)));
  },
};

export default midAutumn;
