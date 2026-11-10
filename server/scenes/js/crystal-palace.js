import { W, H, TAU, clamp, mix, seeded, wave, Art, BAYER } from './art.js';

/*
 * A palace of crystal, drawn the way the old palette artists did it: the picture is
 * never stored as colours. Each pixel holds which facet it belongs to and how bright
 * that facet is there. A frame decides how each facet is catching the light and what
 * colour each family of stone has drifted to, then turns the lot into pixels. So the
 * refraction moves, the dither stays clean, and the lake is the same data turned over.
 */

const LAKE = 176; // the far shore: everything mirrors about this row
const LIGHT = { x: 272, y: -16 }; // the opening high up, where all the light comes from
const ARCH_X = 240;

/** A soft glow to add on top, in dithered steps so that it stays pixels. */
function glowSprite(rx, ry, rgb, peak, steps = 16) {
  const w = Math.ceil(rx * 4);
  const h = Math.ceil(ry * 4);
  const art = new Art(w, h);
  const [r, g, b] = rgb;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = ((x - w / 2) / rx) ** 2 + ((y - h / 2) / ry) ** 2;
      const k = Math.floor(peak * Math.exp(-d) * steps + BAYER[(y & 3) * 4 + (x & 3)]) / steps;
      if (k > 0) art.px[y * w + x] = ((Math.min(1, k) * 255) << 24 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return art.canvas();
}

const hex = (list) => list.map((c) => {
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
});
const blendRamp = (a, b, k) => a.map((c, i) => [mix(c[0], b[i][0], k), mix(c[1], b[i][1], k), mix(c[2], b[i][2], k)]);

const CAVE_R = hex(['#040410', '#060618', '#090822', '#0c0b2e', '#110e3a', '#161248', '#1d1756', '#261e68', '#31277c', '#403392', '#5343a8', '#6a59bc', '#8676ce', '#a597de', '#c7bdec', '#ece6fb']);
const AMETHYST_R = hex(['#0d0622', '#170a34', '#220d48', '#2f115e', '#3d1474', '#4d1a8a', '#5f21a0', '#7229b4', '#8535c6', '#9946d5', '#ae5de2', '#c278ec', '#d596f4', '#e4b4f9', '#f2d3fc', '#fdf0ff']);
const SAPPHIRE_R = hex(['#040a26', '#061238', '#081a4e', '#0a2366', '#0c2d80', '#0f3a9a', '#1347b2', '#1b57c8', '#2669da', '#367ee8', '#4c96f0', '#68aef6', '#88c6fa', '#aadafc', '#cfecfe', '#f2fcff']);
const ROSE_R = hex(['#1e061a', '#2e0a24', '#420e32', '#581240', '#721750', '#8d1c60', '#a92470', '#c33282', '#d84894', '#e862a8', '#f27eb8', '#f89ac8', '#fbb6d8', '#fdcfe6', '#fee6f2', '#fff7fb']);
const GOLD_R = hex(['#1e1006', '#33200a', '#4d320e', '#6b4712', '#8c5e16', '#ad781c', '#cb9226', '#e3ab34', '#f3c148', '#fbd463', '#ffe384', '#ffeca4', '#fff3c2', '#fff8dc', '#fffcee', '#ffffff']);
const DIAMOND_R = hex(['#2a2c58', '#343870', '#40488a', '#5060a4', '#6478bc', '#7c92d0', '#96aae0', '#aebfea', '#c2cff0', '#d2dcf4', '#dfe6f8', '#e9eefa', '#f1f5fc', '#f7fafe', '#fcfdff', '#ffffff']);
const TEAL_R = hex(['#021018', '#031a28', '#042638', '#06344a', '#08445c', '#0a5670', '#0e6a84', '#148098', '#1e96aa', '#2cacbc', '#42c0cc', '#60d2da', '#84e2e6', '#a8eef0', '#ccf6f8', '#f0fdff']);
const BLUSH_R = hex(['#3a2038', '#4c2a4c', '#603660', '#784678', '#925a90', '#ac70a4', '#c288b4', '#d4a0c2', '#e2b6cf', '#ecc8da', '#f3d7e4', '#f8e3ec', '#fbecf2', '#fdf4f8', '#fef9fb', '#ffffff']);
const HAZE = CAVE_R.map(() => [36, 34, 96]);

/* Which families exist. B is where a family's colour wanders to, slowly. */
const [CAVE, AMETHYST, SAPPHIRE, ROSE, GOLD, DIAMOND, FAR_A, FAR_S, FAR_R] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const FAMILIES = [
  { a: CAVE_R, b: blendRamp(CAVE_R, AMETHYST_R, 0.35), rate: 1 / 37, reach: 0.6 },
  { a: AMETHYST_R, b: blendRamp(AMETHYST_R, ROSE_R, 0.62), rate: 1 / 23, reach: 1 },
  { a: SAPPHIRE_R, b: TEAL_R, rate: 1 / 29, reach: 0.8 },
  { a: ROSE_R, b: blendRamp(ROSE_R, GOLD_R, 0.46), rate: 1 / 19, reach: 0.9 },
  { a: GOLD_R, b: blendRamp(GOLD_R, ROSE_R, 0.14), rate: 1 / 31, reach: 1 },
  { a: DIAMOND_R, b: BLUSH_R, rate: 1 / 17, reach: 1 },
  { a: blendRamp(AMETHYST_R, HAZE, 0.5), b: blendRamp(ROSE_R, HAZE, 0.52), rate: 1 / 41, reach: 0.5 },
  { a: blendRamp(SAPPHIRE_R, HAZE, 0.5), b: blendRamp(TEAL_R, HAZE, 0.5), rate: 1 / 47, reach: 0.6 },
  { a: blendRamp(ROSE_R, HAZE, 0.5), b: blendRamp(AMETHYST_R, HAZE, 0.5), rate: 1 / 53, reach: 0.6 },
];
/** A family's slot in the palette: room below and above, so a bright moment never needs a clamp. */
const BLOCK = 44;
const PAD = 12;

/* ── the painter's buffers ─────────────────────────────────────── */

function newPainter(rand) {
  return {
    rand,
    tq: new Uint16Array(W * H),
    fid: new Uint16Array(W * H),
    mq: new Uint16Array(W * LAKE),
    mf: new Uint16Array(W * LAKE),
    fam: [0],
    amp: [0],
    rate: [0],
    phase: [0],
    cx: [0],
    cy: [0],
    gain: [0],
    seams: [],
    scan: new Art(W, H),
  };
}

function facet(g, family, amp, cx, cy, gain = 1) {
  g.fam.push(family);
  g.amp.push(amp);
  g.rate.push(0.1 + g.rand() * 0.34);
  g.phase.push(g.rand() * TAU);
  g.cx.push(cx);
  g.cy.push(cy);
  g.gain.push(gain);
  return g.fam.length - 1;
}

/** One pixel of stone. `shift` says how far above the row it stands in the water's mirror; negative means it has no reflection. */
function plot(g, x, y, tone, id, shift) {
  if (x < 0 || x >= W) return;
  const q = Math.round(clamp(tone, 0, 15) * 16);
  if (y >= 0 && y < H) {
    const i = y * W + x;
    g.tq[i] = q;
    g.fid[i] = id;
  }
  if (shift >= 0) {
    const my = y - shift;
    if (my >= 0 && my < LAKE) {
      const i = my * W + x;
      g.mq[i] = q;
      g.mf[i] = id;
    }
  }
}

const fill = (g, points, tone, id, shift) => {
  g.scan.poly(points, (x, y) => plot(g, x, y, typeof tone === 'function' ? tone(x, y) : tone, id, shift));
};

function stroke(g, x0, y0, x1, y1, tone, id, shift) {
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1;
  for (let i = 0; i <= n; i += 1) plot(g, Math.round(mix(x0, x1, i / n)), Math.round(mix(y0, y1, i / n)), tone, id, shift);
}

/** Cut a flat face into shards, the way a gem's facets break the light. */
function shatter(poly, depth, rand) {
  if (depth <= 0) return [poly];
  const n = poly.length;
  const sides = poly.map((p, i) => ({ i, len: Math.hypot(poly[(i + 1) % n][0] - p[0], poly[(i + 1) % n][1] - p[1]) })).sort((a, b) => b.len - a.len);
  if (sides[0].len < 8) return [poly];
  let a = sides[0].i;
  let b = sides[1].i;
  if (a > b) [a, b] = [b, a];
  const along2 = (p, q, k) => [mix(p[0], q[0], k), mix(p[1], q[1], k)];
  const pa = along2(poly[a], poly[(a + 1) % n], 0.28 + rand() * 0.44);
  const pb = along2(poly[b], poly[(b + 1) % n], 0.28 + rand() * 0.44);
  const one = [pa, ...poly.slice(a + 1, b + 1), pb];
  const two = [pb, ...poly.slice(b + 1), ...poly.slice(0, a + 1), pa];
  return [...shatter(one, depth - 1, rand), ...shatter(two, depth - 1, rand)];
}

const middle = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];

/**
 * A crystal: three faces of a six-sided prism and a pointed tip, each face broken into
 * shards, with hard bright lines on every ridge. The side towards the opening is the
 * lit one. A hanging one is the same thing turned over.
 */
function crystal(g, o) {
  const { rand } = g;
  const { x, base, top, w, lean = 0, fam, second = fam, shift = 0, dim = 0, shards = 2, hang = false, amp = 1.1, rim = 6, seam = true, collars = [], glint = 1 } = o;
  const tall = base - top;
  const cut = Math.min(tall * 0.42, w * (0.85 + rand() * 0.55));
  const axis = (y) => x + (lean * (base - y)) / tall;
  const narrow = 0.8 + rand() * 0.12;
  const at = (f, y) => axis(y) + (f - 0.5) * w * mix(1, narrow, (base - y) / tall);
  const fs = [0, 0.2 + rand() * 0.12, 0.62 + rand() * 0.14, 1];
  const stagger = [1.02, 0.84, 0.7, 0.96].map((k) => top + cut * (k + (rand() - 0.5) * 0.14));
  const apex = [axis(top) + (rand() - 0.5) * w * 0.22, top];
  const turn = (p) => (hang ? [p[0], base + top - p[1]] : p);
  const side = clamp((LIGHT.x - x) / 220, -1, 1);
  const lit = [5.6 - side * 3 - dim, 6.4 - dim, 5.6 + side * 3 - dim];

  const paint = (poly, tone, parts) => {
    for (const shard of shatter(poly, parts, rand)) {
      const pts = shard.map(turn);
      const [cx, cy] = middle(pts);
      const family = rand() < 0.08 ? second : fam;
      const id = facet(g, family, amp * (0.5 + rand()), cx, cy, glint);
      const t0 = tone + (rand() - 0.5) * 2.2 + (rand() < 0.1 ? 3 : 0);
      const lean2 = (rand() - 0.5) * 0.09;
      fill(g, pts, (px, py) => t0 + (cy - py) * 0.03 + (px - cx) * lean2 - (hang ? 0 : clamp(py / LAKE) ** 1.6 * 3), id, shift);
      if (rand() < 0.4 && w > 16) {
        for (let i = 0; i < pts.length; i += 1) {
          const [a, b] = [pts[i], pts[(i + 1) % pts.length]];
          stroke(g, a[0], a[1], b[0], b[1], t0 + 1.6, id, shift);
        }
      }
    }
  };
  // The three long faces, then the tip.
  for (let i = 0; i < 3; i += 1) {
    const quad = [[at(fs[i], base), base], [at(fs[i + 1], base), base], [at(fs[i + 1], stagger[i + 1]), stagger[i + 1]], [at(fs[i], stagger[i]), stagger[i]]];
    paint(quad, lit[i], shards + (w > 40 ? 1 : 0));
    const tip = [[at(fs[i], stagger[i]), stagger[i]], [at(fs[i + 1], stagger[i + 1]), stagger[i + 1]], apex];
    paint(tip, lit[i] + 2.8, w > 22 ? 1 : 0);
  }
  // Gold collars round the great columns, hard against the stone.
  for (const y0 of collars) {
    for (let i = 0; i < 3; i += 1) {
      const quad = [[at(fs[i], y0 + 5), y0 + 5], [at(fs[i + 1], y0 + 5), y0 + 5], [at(fs[i + 1], y0), y0], [at(fs[i], y0), y0]];
      const id = facet(g, GOLD, 0.6, x, y0, 0.7);
      fill(g, quad, (px, py) => lit[i] + 2 + (py === y0 ? 4 : py >= y0 + 4 ? -3 : 0) + (px % 3 === 0 ? 0.9 : 0), id, shift);
    }
  }
  // Bright ridges: the sparkles will run along these.
  const distant = fam === FAR_A || fam === FAR_S || fam === FAR_R;
  const edgeLit = facet(g, distant ? fam : DIAMOND, 0.7, x, (base + top) / 2, 0.5);
  const edgeDim = facet(g, fam, 0.5, x, (base + top) / 2, 0.5);
  const ridge = (a, b, tone, record) => {
    const [p, q] = [turn(a), turn(b)];
    stroke(g, p[0], p[1], q[0], q[1], tone, record ? edgeLit : edgeDim, shift);
    if (record && seam && Math.hypot(p[0] - q[0], p[1] - q[1]) > 12) g.seams.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], shift });
  };
  for (let i = 0; i < 4; i += 1) {
    const bright = i === 0 ? side < 0 : i === 3 ? side > 0 : true;
    const tone = (bright ? rim + 3 : rim + 2) - dim * 0.6;
    ridge([at(fs[i], base), base], [at(fs[i], stagger[i]), stagger[i]], tone, bright);
    ridge([at(fs[i], stagger[i]), stagger[i]], apex, Math.min(15, tone + 4), bright);
    if (i < 3) ridge([at(fs[i], stagger[i]), stagger[i]], [at(fs[i + 1], stagger[i + 1]), stagger[i + 1]], tone, false);
  }
}

/* ── the room ───────────────────────────────────────────────────── */

/** The back of the cavern: great flat planes, lit towards the arch and lost at the corners. */
function caveWall(g) {
  const { rand } = g;
  const cols = 15;
  const rows = 8;
  const pts = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) pts.push([(i / cols) * (W + 40) - 20 + (rand() - 0.5) * 22, (j / rows) * (LAKE + 8) - 4 + (j > 0 && j < rows ? (rand() - 0.5) * 18 : 0)]);
  }
  const P = (i, j) => pts[j * (cols + 1) + i];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      for (const tri of rand() < 0.5 ? [[P(i, j), P(i + 1, j), P(i, j + 1)], [P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]] : [[P(i, j), P(i + 1, j), P(i + 1, j + 1)], [P(i, j), P(i + 1, j + 1), P(i, j + 1)]]) {
        const [cx, cy] = middle(tri);
        const near = Math.exp(-(((cx - ARCH_X) / 120) ** 2 + ((cy - 112) / 80) ** 2));
        const t0 = 1.2 + near * 5.2 + (rand() - 0.5) * 1.5 - ((LAKE - cy) / LAKE) * 0.6;
        const id = facet(g, CAVE, 0.5, cx, cy, 0.5);
        fill(g, tri, t0, id, 0);
        if (rand() < 0.5) {
          stroke(g, tri[0][0], tri[0][1], tri[1][0], tri[1][1], t0 + 1.2, id, 0);
        }
      }
    }
  }
}

/** Two tiers of tiny lit arches along the back wall, which is what shows how vast the columns are. */
function arcades(g) {
  const tier = (top, bottom, width, step, lightTone) => {
    for (let x = -6; x < W; x += step) {
      const cx = x + width / 2;
      const glow = facet(g, GOLD, 0.8, cx, top, 0.6);
      const pier = facet(g, CAVE, 0.2, cx, top, 0.2);
      const spring = top + width * 0.6;
      const dist = Math.abs(cx - ARCH_X) / 240;
      const reach = lightTone - 1.8 - dist * 3.4;
      for (let y = top; y < bottom; y += 1) {
        const half = y < spring ? (width / 2) * Math.sqrt(Math.max(0, 1 - ((spring - y) / (spring - top)) ** 2)) : width / 2;
        for (let dx = Math.round(-half); dx < half; dx += 1) plot(g, Math.round(cx) + dx, y, reach + ((y - top) / (bottom - top)) * 2.6 - Math.abs(dx) * 0.22, glow, 0);
        plot(g, Math.round(cx - half) - 1, y, 6.5 - dist * 2, pier, 0);
        plot(g, Math.round(cx + half), y, 3.5 - dist, pier, 0);
      }
    }
  };
  tier(104, 128, 8, 15, 7);
  tier(134, 172, 12, 21, 8.6);
  const ledge = facet(g, GOLD, 0.4, 240, 130, 0.5);
  for (let x = 0; x < W; x += 1) {
    plot(g, x, 129, 8 - (Math.abs(x - ARCH_X) / 240) * 3, ledge, 0);
    plot(g, x, 130, 3, ledge, 0);
  }
}

/** The arch at the far end: a throne under a pointed vault of gold, crowned in crystal. */
function throneArch(g) {
  const cx = ARCH_X;
  const spring = 116;
  const foot = 157;
  const curve = (half, apexY, k) => {
    const a = (k * Math.PI) / 2;
    return [half * Math.cos(a) ** 0.82, spring - (spring - apexY) * Math.sin(a) ** 1.28];
  };
  const OUT = 33;
  const IN = 22;
  const OUT_APEX = 58;
  const IN_APEX = 76;
  // The light inside it.
  const inner = [[cx - IN, foot]];
  for (let k = 0; k <= 16; k += 1) {
    const [dx, y] = curve(IN, IN_APEX, k / 16);
    inner.push([cx - dx, y]);
  }
  for (let k = 16; k >= 0; k -= 1) {
    const [dx, y] = curve(IN, IN_APEX, k / 16);
    inner.push([cx + dx, y]);
  }
  inner.push([cx + IN, foot]);
  const light = facet(g, GOLD, 0.5, cx, 110, 0.4);
  fill(g, inner, (x, y) => 10.6 + 3.6 * Math.exp(-(((x - cx) / 16) ** 2 + ((y - 92) / 24) ** 2)) - ((y - 76) / 80) * 1.6, light, 0);
  // The throne: a tall back, a crown of points, a seat with arms.
  const dark = facet(g, GOLD, 0.2, cx, 130, 0.1);
  const rimId = facet(g, GOLD, 0.7, cx, 120, 0.6);
  const gem = facet(g, ROSE, 0.9, cx, 118, 0.8);
  const back = [[cx - 9, foot], [cx - 9, 112], [cx - 6, 104], [cx - 3, 108], [cx, 96], [cx + 3, 108], [cx + 6, 104], [cx + 9, 112], [cx + 9, foot]];
  fill(g, back, (x, y) => 4 + (x < cx ? 1.2 : 0) + ((y % 7 === 0) ? 1.2 : 0), dark, 0);
  back.forEach((p, i) => {
    const q = back[(i + 1) % back.length];
    if (i < back.length - 1) stroke(g, p[0], p[1], q[0], q[1], p[0] <= cx ? 13 : 10, rimId, 0);
  });
  fill(g, [[cx - 5, 138], [cx - 5, 116], [cx, 110], [cx + 5, 116], [cx + 5, 138]], (x) => 6 + (x < cx ? 1.8 : 0), gem, 0);
  fill(g, [[cx - 13, 146], [cx + 13, 146], [cx + 13, 142], [cx - 13, 142]], 9, rimId, 0);
  for (const dx of [-13, -12, 11, 12]) stroke(g, cx + dx, 134, cx + dx, foot, dx < 0 ? 12 : 8, rimId, 0);
  stroke(g, cx - 14, 134, cx - 9, 134, 13, rimId, 0);
  stroke(g, cx + 9, 134, cx + 14, 134, 10, rimId, 0);
  fill(g, [[cx - 13, foot], [cx + 13, foot], [cx + 13, 146], [cx - 13, 146]], 4.5, dark, 0);
  for (const [dx, y] of [[0, 94], [-6, 102], [6, 102]]) plot(g, cx + dx, y, 15, facet(g, DIAMOND, 1.4, cx + dx, y, 1.4), 0);

  // The vault: stones of gold, with a gem set in every third.
  const N = 9;
  for (const side of [-1, 1]) {
    for (let k = 0; k < N; k += 1) {
      const [a, b] = [k / N, (k + 1) / N];
      const [ox0, oy0] = curve(OUT, OUT_APEX, a);
      const [ox1, oy1] = curve(OUT, OUT_APEX, b);
      const [ix0, iy0] = curve(IN, IN_APEX, a);
      const [ix1, iy1] = curve(IN, IN_APEX, b);
      const quad = [[cx + side * ox0, oy0], [cx + side * ox1, oy1], [cx + side * ix1, iy1], [cx + side * ix0, iy0]];
      const set = k % 3 === 1;
      const id = facet(g, set ? (side < 0 ? ROSE : SAPPHIRE) : GOLD, set ? 1.3 : 0.8, cx + side * ox0, oy0, 1.2);
      fill(g, quad, (set ? 10 : 8 - side * 1.4) + (k % 2 ? 0.8 : -0.4), id, 0);
      stroke(g, quad[0][0], quad[0][1], quad[1][0], quad[1][1], 13, id, 0);
      stroke(g, quad[3][0], quad[3][1], quad[2][0], quad[2][1], 14, id, 0);
      stroke(g, quad[0][0], quad[0][1], quad[3][0], quad[3][1], 4, id, 0);
      g.seams.push({ x0: quad[0][0], y0: quad[0][1], x1: quad[1][0], y1: quad[1][1], shift: 0 });
    }
    // The piers, in dressed blocks.
    for (let y = spring; y < foot; y += 8) {
      const id = facet(g, GOLD, 0.8, cx + side * 28, y, 1);
      fill(g, [[cx + side * IN, y], [cx + side * OUT, y], [cx + side * OUT, y + 8], [cx + side * IN, y + 8]], (px) => (side < 0 ? 9.6 - (px - cx + OUT) * 0.2 : 6.5 + (OUT - (px - cx)) * 0.12), id, 0);
      stroke(g, cx + side * IN, y, cx + side * OUT, y, 10.6, id, 0);
      stroke(g, cx + side * IN, y + 7, cx + side * OUT, y + 7, 5, id, 0);
    }
    const cap = facet(g, GOLD, 0.9, cx + side * 28, spring, 1);
    fill(g, [[cx + side * (IN - 2), spring - 3], [cx + side * (OUT + 2), spring - 3], [cx + side * (OUT + 2), spring + 1], [cx + side * (IN - 2), spring + 1]], 11, cap, 0);
    stroke(g, cx + side * (IN - 2), spring - 3, cx + side * (OUT + 2), spring - 3, 15, cap, 0);
    stroke(g, cx + side * IN, spring, cx + side * IN, foot, 14.6, cap, 0);
  }
  // A crown of crystal along the top of it, and two tall stones on either side.
  crystal(g, { x: cx, base: 72, top: 28, w: 13, fam: DIAMOND, second: ROSE, shards: 1, rim: 8, amp: 1.5, glint: 1.6 });
  for (const side of [-1, 1]) {
    crystal(g, { x: cx + side * 13, base: 76, top: 44, w: 9, lean: side * 2, fam: DIAMOND, shards: 1, rim: 8, amp: 1.4, glint: 1.4 });
    crystal(g, { x: cx + side * 25, base: 92, top: 62, w: 9, lean: side * 3, fam: side < 0 ? ROSE : SAPPHIRE, second: DIAMOND, shards: 1, rim: 7, amp: 1.2 });
    crystal(g, { x: cx + side * 50, base: 158, top: 84, w: 15, lean: side * 2, fam: side < 0 ? ROSE : SAPPHIRE, second: DIAMOND, shards: 2, rim: 7 });
    crystal(g, { x: cx + side * 62, base: 160, top: 112, w: 10, lean: side * 3, fam: side < 0 ? AMETHYST : ROSE, shards: 1, rim: 6 });
  }
  // The steps down to the water, each edged in gold, with a runner down the middle.
  const STEPS = 6;
  for (let s = 0; s < STEPS; s += 1) {
    const y0 = foot + s * 3;
    const half = 38 + s * 6;
    const tread = facet(g, GOLD, 0.6, cx, y0, 0.8);
    const riser = facet(g, CAVE, 0.3, cx, y0, 0.4);
    const carpet = facet(g, ROSE, 0.5, cx, y0, 0.6);
    for (let x = cx - half; x <= cx + half; x += 1) {
      const k = Math.abs(x - cx) / half;
      plot(g, x, y0, 13 - k * 3.4 + (x < cx ? 0.8 : -0.4), tread, 0);
      plot(g, x, y0 + 1, 6.4 - k * 1.8, riser, 0);
      plot(g, x, y0 + 2, 5 - k * 1.6, riser, 0);
    }
    const run = 9 + s * 1.4;
    for (let x = Math.round(cx - run); x <= cx + run; x += 1) {
      plot(g, x, y0, 8.4, carpet, 0);
      plot(g, x, y0 + 1, 6.4, carpet, 0);
      plot(g, x, y0 + 2, 5.4, carpet, 0);
    }
    plot(g, Math.round(cx - run) - 1, y0 + 1, 13, tread, 0);
    plot(g, Math.round(cx + run) + 1, y0 + 1, 11, tread, 0);
  }
}

/** A gold rail along the far shore, its lamps kept in a list so that they can burn. */
function balustrade(g) {
  const lamps = [];
  const rail = facet(g, GOLD, 0.5, 240, 168, 0.8);
  const pale = facet(g, GOLD, 0.4, 240, 172, 0.6);
  for (let x = 0; x < W; x += 1) {
    const away = Math.abs(x - ARCH_X);
    if (away < 73) continue;
    const dim2 = (away / 240) * 3;
    plot(g, x, 166, 13 - dim2, rail, 0);
    plot(g, x, 167, 7 - dim2, rail, 0);
    plot(g, x, 174, 12 - dim2, pale, 0);
    plot(g, x, 175, 5 - dim2, pale, 0);
    if (x % 5 === 0) {
      for (let y = 168; y < 174; y += 1) plot(g, x, y, 9.6 - dim2, pale, 0);
    }
    if (x % 44 === 8) {
      for (let y = 158; y < 174; y += 1) {
        plot(g, x, y, 12.6 - dim2, rail, 0);
        plot(g, x + 1, y, 5 - dim2, rail, 0);
      }
      plot(g, x - 1, 158, 12 - dim2, rail, 0);
      plot(g, x + 2, 158, 7 - dim2, rail, 0);
      lamps.push({ x, y: 156, phase: g.rand() });
    }
  }
  return lamps;
}

/** A chandelier on a long gold chain: tiers of drops, every one a small hard gem. */
function chandelier(g, cx, drop, size) {
  const chain = facet(g, GOLD, 0.4, cx, drop / 2, 0.6);
  for (let y = 0; y < drop; y += 1) {
    plot(g, cx, y, y % 3 === 0 ? 13 : 7, chain, 0);
    if (y % 6 === 0) plot(g, cx + 1, y, 9, chain, 0);
  }
  const lights = [];
  const ring = facet(g, GOLD, 0.8, cx, drop + 4, 1);
  for (let tier = 0; tier < 3; tier += 1) {
    const span = size * (1 - tier * 0.28);
    const y0 = drop + 3 + tier * Math.round(size * 0.36);
    for (let k = -1; k <= 1; k += 0.02) {
      plot(g, Math.round(cx + k * span), y0 + Math.round((1 - k * k) * 3), k < 0 ? 13 : 10, ring, 0);
    }
    const count = Math.round(span / 2.6);
    for (let i = -count; i <= count; i += 1) {
      const px = cx + (i / count) * span;
      const py = y0 + (1 - (i / count) ** 2) * 3 + 1;
      const id = facet(g, DIAMOND, 1.8, px, py, 1.8);
      const size2 = 1 + (i % 3 === 0 ? 0.8 : 0);
      fill(g, [[px, py], [px + size2, py + size2 * 1.4], [px, py + size2 * 3.4], [px - size2, py + size2 * 1.4]], (x) => (x < px ? 11.5 : 4), id, 0);
      lights.push({ x: Math.round(px), y: Math.round(py + size2 * 1.4), phase: g.rand(), period: 2 + g.rand() * 5 });
    }
  }
  // The finial under it.
  const end = drop + 3 + 2 * Math.round(size * 0.36) + 8;
  const fin = facet(g, DIAMOND, 1.6, cx, end, 1.6);
  fill(g, [[cx, end - 3], [cx + 2.4, end + 2], [cx, end + 10], [cx - 2.4, end + 2]], (x) => (x < cx ? 15 : 10), fin, 0);
  return lights;
}

/** The opening, far overhead, ringed in gold and too bright to look at. */
function opening(g) {
  const sky = facet(g, DIAMOND, 0.3, LIGHT.x, 4, 0.2);
  const shape = [[254, -2], [292, -2], [288, 6], [282, 10], [274, 13], [265, 11], [259, 7]];
  fill(g, shape, 15, sky, 0);
  const ring = facet(g, GOLD, 1, LIGHT.x, 8, 1);
  shape.forEach((p, i) => {
    const q = shape[(i + 1) % shape.length];
    if (i < shape.length - 1) {
      stroke(g, p[0], p[1] + 1, q[0], q[1] + 1, 12, ring, 0);
      stroke(g, p[0], p[1] + 2, q[0], q[1] + 2, 8, ring, 0);
    }
  });
}

/* ── the whole room, far to near ────────────────────────────────── */

function buildPalace(rand) {
  const g = newPainter(rand);
  caveWall(g);
  arcades(g);
  opening(g);

  // Far columns, half lost in the blue.
  const FAR = [FAR_A, FAR_S, FAR_R];
  const far = [[18, 38, 18], [56, 62, 24], [86, 24, 20], [112, 84, 14], [132, 44, 22], [160, 88, 16], [184, 56, 20], [298, 48, 22], [320, 92, 14], [342, 30, 24], [366, 72, 18], [392, 40, 20], [422, 66, 22], [454, 30, 22]];
  far.forEach(([x, top, w], i) => crystal(g, { x, base: LAKE, top, w, fam: FAR[i % 3], second: FAR[(i + 1) % 3], dim: 2, amp: 0.7, shards: 1, rim: 4, seam: false, lean: (rand() - 0.5) * 8 }));
  // Hanging from the roof, the same stone again.
  const hanging = [[108, 34, 16, FAR_S], [136, 22, 12, FAR_R], [168, 44, 18, FAR_A], [196, 26, 12, FAR_S], [214, 16, 9, FAR_A], [304, 22, 12, FAR_R], [330, 48, 18, FAR_S], [358, 26, 14, FAR_A], [384, 40, 15, FAR_R]];
  for (const [x, len, w, fam] of hanging) crystal(g, { x, base: len, top: -12, w, fam, second: FAR_A, dim: 1.5, amp: 0.8, shards: 1, rim: 5, hang: true, seam: false });

  throneArch(g);
  const lamps = balustrade(g);

  const glitter = [...chandelier(g, 160, 30, 19), ...chandelier(g, 316, 24, 22)];

  // Middle distance, in full colour.
  const mid = [
    { x: 164, top: 106, w: 13, fam: AMETHYST, second: ROSE, lean: 3 },
    { x: 130, top: 78, w: 20, fam: ROSE, second: AMETHYST, lean: -3 },
    { x: 318, top: 106, w: 13, fam: SAPPHIRE, second: DIAMOND, lean: -3 },
    { x: 354, top: 72, w: 22, fam: AMETHYST, second: SAPPHIRE, lean: 3 },
  ];
  for (const m of mid) crystal(g, { base: LAKE + 2, shift: 4, shards: 2, rim: 6, amp: 1, ...m });

  // Low shards standing in the lake itself.
  const shard = (x, yc, tall, w, fam, second, lean) => crystal(g, { x, base: yc, top: yc - tall, w, fam, second, lean, shift: 2 * (yc - LAKE), shards: 2, rim: 7, amp: 1.2, glint: 1.2 });
  shard(150, 206, 26, 11, AMETHYST, ROSE, -4);
  shard(160, 208, 15, 8, ROSE, DIAMOND, 4);
  shard(338, 212, 28, 12, SAPPHIRE, AMETHYST, 4);
  shard(327, 214, 15, 8, AMETHYST, ROSE, -4);

  // The enormous columns that hold the place up, with gold at their joints.
  const pillar = (o) => crystal(g, { shards: 3, amp: 1.3, rim: 7, glint: 1.3, ...o });
  pillar({ x: 92, base: 188, top: -30, w: 30, fam: SAPPHIRE, second: DIAMOND, shift: 24, lean: 3, collars: [136, 38] });
  pillar({ x: 392, base: 188, top: -34, w: 32, fam: ROSE, second: GOLD, shift: 24, lean: -3, collars: [132, 30] });
  pillar({ x: 36, base: 200, top: -46, w: 58, fam: AMETHYST, second: ROSE, shift: 48, lean: 4, collars: [152, 62] });
  pillar({ x: 444, base: 200, top: -46, w: 60, fam: SAPPHIRE, second: AMETHYST, shift: 48, lean: -4, collars: [150, 58] });
  // Clusters round their feet.
  shard(70, 205, 38, 14, ROSE, AMETHYST, 6);
  shard(58, 209, 20, 10, DIAMOND, ROSE, 6);
  shard(410, 205, 42, 15, AMETHYST, ROSE, -6);
  shard(422, 209, 22, 10, DIAMOND, SAPPHIRE, -6);

  // Stone hanging in close at the corners, nearly dark, with hard bright edges.
  for (const [x, len, w, fam, lean] of [[118, 40, 18, AMETHYST, 3], [366, 36, 18, SAPPHIRE, -3]]) {
    crystal(g, { x, base: len, top: -14, w, fam, second: DIAMOND, dim: 1.2, hang: true, shards: 2, rim: 7, lean, shift: -1 });
  }
  // And in the water at the bottom corners, closest of all.
  for (const [x, yc, tall, w, fam, lean] of [[8, 278, 70, 28, SAPPHIRE, 5], [38, 282, 36, 18, AMETHYST, 7], [472, 278, 74, 28, AMETHYST, -5], [442, 282, 38, 18, ROSE, -7]]) {
    crystal(g, { x, base: yc, top: yc - tall, w, fam, second: fam, dim: 3.2, shards: 2, rim: 7, lean, shift: -1, glint: 1.2 });
  }
  return { g, lamps, glitter };
}

/** Beams from the opening, as how much each pixel is lifted when a beam is bright. */
function paintBeams() {
  const a = new Uint8Array(W * LAKE);
  const b = new Uint8Array(W * LAKE);
  const beam = (mask, x0, x1, x2, x3, peak) => {
    for (let y = 0; y < LAKE; y += 1) {
      const k = y / LAKE;
      const left = mix(x0, x2, k);
      const right = mix(x1, x3, k);
      const v = peak * (1 - k * 0.46);
      for (let x = Math.max(0, Math.ceil(left)); x < Math.min(W, right); x += 1) {
        const u = (x - left) / (right - left);
        const shaped = Math.sin(u * Math.PI) ** 0.5;
        const stripe = 0.86 + Math.sin(u * 19) * 0.14;
        const i = y * W + x;
        mask[i] = Math.max(mask[i], Math.round(v * shaped * stripe));
      }
    }
  };
  beam(a, 258, 288, 204, 276, 255);
  beam(b, 262, 276, 116, 160, 215);
  beam(b, 278, 290, 318, 362, 215);
  beam(a, 262, 270, 16, 62, 170);
  beam(a, 282, 290, 418, 462, 170);
  return { a, b };
}

/* ── a frame ────────────────────────────────────────────────────── */

function drawPalette(s, t) {
  const { pal, lakePal, families } = s;
  for (let f = 0; f < families.length; f += 1) {
    const fam = families[f];
    const k = (Math.sin(t * fam.rate * TAU + f * 1.7) * 0.5 + 0.5) * fam.reach;
    const base = f * BLOCK + PAD;
    for (let i = 0; i < 16; i += 1) {
      const o = i * 3;
      const r = fam.a3[o] + (fam.b3[o] - fam.a3[o]) * k;
      const g = fam.a3[o + 1] + (fam.b3[o + 1] - fam.a3[o + 1]) * k;
      const b = fam.a3[o + 2] + (fam.b3[o + 2] - fam.a3[o + 2]) * k;
      pal[base + i] = 0xff000000 | (b << 16) | (g << 8) | r;
      // The water drinks some of it, and is a little bluer for it.
      lakePal[base + i] = 0xff000000 | (((b * 0.88 + 12) & 255) << 16) | (((g * 0.74 + 4) & 255) << 8) | ((r * 0.8 + 2) & 255);
    }
    for (let i = 1; i <= PAD; i += 1) {
      pal[base - i] = pal[base];
      lakePal[base - i] = lakePal[base];
    }
    for (let i = 16; i < BLOCK - PAD; i += 1) {
      pal[base + i] = pal[base + 15];
      lakePal[base + i] = lakePal[base + 15];
    }
  }
}

function drawFacets(s, t) {
  const { off, amp, rate, phase, cx, cy, gain } = s;
  // A slow band of brightness passes across the whole room, as if something turned overhead.
  const sweep = t * 0.19;
  for (let f = 1; f < off.length; f += 1) {
    const wavefront = Math.sin(cx[f] * 0.017 + cy[f] * 0.023 - sweep);
    const band = wavefront > 0.8 ? (wavefront - 0.8) * 5 : 0;
    off[f] = Math.round((Math.sin(t * rate[f] + phase[f]) * amp[f] + band * band * 2.6 * gain[f]) * 16);
  }
}

function drawPicture(s, t) {
  const { tq, fid, mq, mf, off, baseF, pal, lakePal, beamA, beamB, out, dither, lakeFade } = s;
  const lift = Math.round(84 + wave(t, 9.7) * 20);
  const lift2 = Math.round(64 + wave(t, 13.1, 0.3) * 22);
  for (let y = 0; y < LAKE; y += 1) {
    const row = y * W;
    const by = (y & 3) << 2;
    for (let x = 0; x < W; x += 1) {
      const i = row + x;
      const f = fid[i];
      const v = tq[i] + off[f] + ((beamA[i] * lift + beamB[i] * lift2) >> 8) + dither[by | (x & 3)];
      out[i] = pal[baseF[f] + (v >> 4)];
    }
  }
  // The lake is the same data turned over: dimmer, bluer, almost perfectly still.
  const drift = t * 0.62;
  for (let y = LAKE; y < H; y += 1) {
    const dy = y - LAKE;
    const row = y * W;
    const by = (y & 3) << 2;
    const my = (LAKE - 1 - dy) * W;
    const fade = lakeFade[dy];
    const swell = Math.sin(dy * 0.53 - drift) + Math.sin(dy * 0.19 + drift * 0.6) * 0.6;
    const wob = swell > 1.34 ? 1 : swell < -1.34 ? -1 : 0;
    for (let x = 0; x < W; x += 1) {
      const i = row + x;
      const f = fid[i];
      if (f) {
        const v = tq[i] + off[f] + dither[by | (x & 3)];
        out[i] = pal[baseF[f] + (v >> 4)];
      } else {
        let sx = x + wob;
        if (sx < 0) sx = 0;
        else if (sx >= W) sx = W - 1;
        const q = my + sx;
        const g = mf[q];
        const v = mq[q] + off[g] + ((beamA[q] * lift + beamB[q] * lift2) >> 9) + dither[by | (x & 3)] - fade;
        const tone = v >> 4;
        out[i] = lakePal[baseF[g] + (tone < -PAD ? -PAD : tone)];
      }
    }
  }
}

const crystalPalace = {
  build() {
    const rand = seeded(9900);
    const { g, lamps, glitter } = buildPalace(rand);
    const { a: beamA, b: beamB } = paintBeams();
    const n = g.fam.length;
    const frame = new ImageData(W, H);
    const seams = g.seams;
    const pick = () => seams[Math.floor(rand() * seams.length)];
    return {
      tq: g.tq,
      fid: g.fid,
      mq: g.mq,
      mf: g.mf,
      beamA,
      beamB,
      off: new Int32Array(n),
      baseF: Int32Array.from(g.fam, (f) => f * BLOCK + PAD),
      amp: Float32Array.from(g.amp),
      rate: Float32Array.from(g.rate),
      phase: Float32Array.from(g.phase),
      cx: Float32Array.from(g.cx),
      cy: Float32Array.from(g.cy),
      gain: Float32Array.from(g.gain),
      pal: new Uint32Array(FAMILIES.length * BLOCK),
      lakePal: new Uint32Array(FAMILIES.length * BLOCK),
      families: FAMILIES.map((f) => ({ ...f, a3: Int32Array.from(f.a.flat(), Math.round), b3: Int32Array.from(f.b.flat(), Math.round) })),
      dither: Int32Array.from(BAYER, (v) => Math.floor(v * 16)),
      lakeFade: Int32Array.from({ length: H - LAKE }, (_, dy) => Math.round(Math.min(10, 0.8 + dy * 0.07) * 16)),
      frame,
      out: new Uint32Array(frame.data.buffer),
      archGlow: glowSprite(44, 52, [255, 176, 84], 0.2),
      lakeGlow: glowSprite(38, 22, [255, 186, 96], 0.2),
      skyGlow: glowSprite(52, 26, [196, 196, 255], 0.5),
      lamps,
      glitter,
      sparkles: Array.from({ length: 84 }, () => ({ seam: pick(), period: 5 + rand() * 11, phase: rand(), life: 0.3 + rand() * 0.25 })),
      motes: Array.from({ length: 96 }, () => ({ x: rand() * W, y: rand() * LAKE, vx: (rand() - 0.5) * 3, vy: -0.6 - rand() * 2.2, sway: 3 + rand() * 9, period: 7 + rand() * 13, phase: rand(), big: rand() < 0.16, tone: rand() < 0.55 ? '#ffe9a8' : rand() < 0.5 ? '#f2c6ff' : '#bfe6ff' })),
      rings: Array.from({ length: 4 }, () => ({ x: 130 + rand() * 220, y: 205 + rand() * 50, period: 13 + rand() * 13, phase: rand() })),
      glints: Array.from({ length: 40 }, () => ({ x: Math.floor(rand() * W), period: 3 + rand() * 7, phase: rand(), len: 2 + Math.floor(rand() * 6) })),
    };
  },

  draw(ctx, t, s) {
    drawPalette(s, t);
    drawFacets(s, t);
    drawPicture(s, t);
    ctx.putImageData(s.frame, 0, 0);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.84 + wave(t, 6.3) * 0.16;
    ctx.drawImage(s.archGlow, ARCH_X - 88, 108 - 104);
    ctx.drawImage(s.lakeGlow, ARCH_X - 76, LAKE + 42 - 44);
    ctx.globalAlpha = 0.86 + wave(t, 8.9) * 0.14;
    ctx.drawImage(s.skyGlow, LIGHT.x - 104, 2 - 52);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Light along the far shore, where the water starts.
    for (const g of s.glints) {
      const k = wave(t, g.period, g.phase);
      if (k < 0.35) continue;
      ctx.fillStyle = k > 0.8 ? '#fff4c8' : 'rgba(255,226,170,0.55)';
      ctx.fillRect(g.x, LAKE + (g.phase > 0.6 ? 1 : 0), g.len, 1);
    }

    // The rail's lamps, and their doubles in the lake.
    for (const l of s.lamps) {
      const k = 0.7 + wave(t, 3.1, l.phase) * 0.3;
      ctx.globalAlpha = k;
      ctx.fillStyle = '#fff8d8';
      ctx.fillRect(l.x, l.y, 2, 2);
      ctx.globalAlpha = k * 0.3;
      ctx.fillStyle = '#ffd77a';
      ctx.fillRect(l.x - 1, l.y - 1, 4, 4);
      ctx.fillRect(l.x, 2 * LAKE - l.y - 2, 2, 2);
    }
    ctx.globalAlpha = 1;

    // The chandeliers: each drop catches the light on a time of its own.
    for (const d of s.glitter) {
      const k = wave(t, d.period, d.phase);
      if (k < 0.74) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(d.x, d.y, 1, 1);
      if (k > 0.94) {
        ctx.fillRect(d.x - 1, d.y, 3, 1);
        ctx.fillRect(d.x, d.y - 1, 1, 3);
      }
    }

    // Sparkles running along the ridges of the stone.
    for (const p of s.sparkles) {
      const k = (t / p.period + p.phase) % 1;
      if (k > p.life) continue;
      const u = k / p.life;
      const { x0, y0, x1, y1, shift } = p.seam;
      const x = mix(x0, x1, u);
      const y = mix(y0, y1, u);
      const glow = Math.sin(u * Math.PI);
      const ix = Math.round(x);
      const iy = Math.round(y);
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = glow;
      ctx.fillRect(ix, iy, 1, 1);
      ctx.globalAlpha = glow * 0.55;
      ctx.fillRect(Math.round(mix(x0, x1, u - 0.04)), Math.round(mix(y0, y1, u - 0.04)), 1, 1);
      if (glow > 0.72) {
        ctx.globalAlpha = (glow - 0.72) * 3;
        ctx.fillRect(ix - 2, iy, 5, 1);
        ctx.fillRect(ix, iy - 2, 1, 5);
      }
      // Its double, in the water.
      if (shift >= 0) {
        const my = 2 * (LAKE + shift / 2) - iy;
        if (my >= LAKE && my < H) {
          ctx.globalAlpha = glow * 0.5;
          ctx.fillRect(ix, Math.round(my), 1, 1);
        }
      }
    }

    // Motes on the air, rising so slowly they mostly seem to hang.
    const span = LAKE + 12;
    for (const m of s.motes) {
      const x = ((m.x + t * m.vx + Math.sin((t / m.period + m.phase) * TAU) * m.sway) % W + W) % W;
      const y = (((m.y + t * m.vy) % span) + span) % span;
      const glow = 0.45 + 0.55 * Math.sin((t / (m.period * 0.6) + m.phase) * TAU);
      if (glow <= 0.05) continue;
      const ix = Math.round(x);
      const iy = Math.round(y);
      ctx.fillStyle = m.tone;
      ctx.globalAlpha = glow;
      ctx.fillRect(ix, iy, 1, 1);
      if (m.big) {
        ctx.globalAlpha = glow * 0.34;
        ctx.fillRect(ix - 1, iy, 3, 1);
        ctx.fillRect(ix, iy - 1, 1, 3);
      }
      const mirrored = 2 * LAKE - iy;
      if (mirrored < H) {
        ctx.globalAlpha = glow * 0.32;
        ctx.fillRect(ix, mirrored, 1, 1);
      }
    }

    // Now and then a drop from far above breaks the mirror, and it closes again.
    for (const r of s.rings) {
      const phase = t / r.period + r.phase;
      const k = phase - Math.floor(phase);
      if (k > 0.34) continue;
      const u = k / 0.34;
      const rx = 2 + u * 34;
      const count = Math.round(10 + rx * 1.6);
      ctx.fillStyle = '#d9e4ff';
      ctx.globalAlpha = (1 - u) * 0.5;
      for (let i = 0; i < count; i += 1) {
        const a = (i / count) * TAU;
        ctx.fillRect(Math.round(r.x + Math.cos(a) * rx), Math.round(r.y + Math.sin(a) * rx * 0.3), 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  },
};

export default crystalPalace;
