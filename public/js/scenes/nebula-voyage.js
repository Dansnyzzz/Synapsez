import { W, H, TAU, BAYER, Art, clamp, mix, smooth, seeded, rgba, noise2, fbm2 } from './art.js';

/**
 * The reward for a billion tokens: one small boat with one lantern, on a still sea,
 * under a galaxy that fills the sky and turns.
 *
 * A galaxy turning by a few pixels a second cannot be a sprite: a turned dither pattern
 * shimmers. So the sky is worked out in full colour for every frame, the sea is that
 * same sky seen in moving ripples, and only then is the whole picture dithered in place
 * into one palette. The grain stays still on the screen while the light moves behind it.
 */

/** The sea starts here. */
const HORIZON = 168;
const SEA = H - HORIZON;
/** Texture of the galaxy, seen face-on. */
const TS = 512;
/** Where its heart is on screen, how far it is tipped back, and how far it is leaning. */
const CX = 288;
const CY = 58;
const TILT = 0.52;
const LEAN = -0.17;
/** Seconds for one turn. */
const TURN = 360;

/* Scratch paper: the whole frame in light, before it becomes pixels. */
const FR = new Float32Array(W * H * 3);

/* The boat: where its waterline sits on screen. */
const BOAT_X = 352;
const BOAT_Y = 216;

const PALETTE = [
  // night and violet
  '#04030f', '#070519', '#0b0826', '#100b33', '#160f42', '#1d1452', '#261a63', '#312276', '#3e2b8a', '#4e389f', '#6349b3', '#7d62c6', '#9c84d8', '#bdaae6', '#ddd2f3', '#f4f0fc', '#ffffff',
  // magenta
  '#1e0a2e', '#2f0f40', '#451453', '#5e1a66', '#7b207a', '#9b288b', '#bb3498', '#d648a4', '#ea68b2', '#f58fc6', '#fbb8da', '#fedcec',
  // teal
  '#04151f', '#06202e', '#082e3e', '#0a3f4f', '#0d5360', '#116a72', '#188485', '#229e96', '#36b8a6', '#58d0b7', '#8be3cb', '#c0f2e2',
  // blue
  '#0a1034', '#0f194c', '#152468', '#1c3286', '#2645a6', '#355ec4', '#4c7cdc', '#6f9cec', '#9cbef5', '#cbdffb',
  // warm: core and lantern
  '#2a1420', '#4a1f2c', '#722c36', '#a0423c', '#cd6340', '#ee8c48', '#fab35c', '#ffd27c', '#ffe9a8', '#fff6d6', '#ffd9c4', '#ffb6a6', '#f98c94',
];

/** Every colour we might want, to the nearest in the palette. */
function paletteTable() {
  const pal = PALETTE.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >>> 16, (n >>> 8) & 255, n & 255, rgba(hex)];
  });
  const lut = new Uint32Array(32768);
  for (let r = 0; r < 32; r += 1) {
    for (let g = 0; g < 32; g += 1) {
      for (let b = 0; b < 32; b += 1) {
        let best = 0;
        let bestD = Infinity;
        const cr = r * 8 + 4;
        const cg = g * 8 + 4;
        const cb = b * 8 + 4;
        for (let i = 0; i < pal.length; i += 1) {
          const p = pal[i];
          const d = (p[0] - cr) ** 2 * 2 + (p[1] - cg) ** 2 * 4 + (p[2] - cb) ** 2 * 3;
          if (d < bestD) {
            bestD = d;
            best = p[3];
          }
        }
        lut[(r << 10) | (g << 5) | b] = best;
      }
    }
  }
  return lut;
}

/* ── the galaxy, painted once, face-on ─────────────────────────── */

function paintGalaxy(scale) {
  const tex = new Uint8ClampedArray(TS * TS * 3);
  const warpN = noise2(9101, 16);
  const cloudN = noise2(9102, 32);
  const fineN = noise2(9103, 64);
  const farN = noise2(9104, 16);
  const farM = noise2(9105, 16);
  for (let j = 0; j < TS; j += 1) {
    for (let i = 0; i < TS; i += 1) {
      const u = (i - TS / 2) / scale;
      const v = (j - TS / 2) / scale;
      const r = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const warp = fbm2(warpN, i / 32, j / 32, 3) - 0.5;
      const cloud = fbm2(cloudN, i / 16, j / 16, 4);
      const fine = fbm2(fineN, i / 6, j / 6, 2);
      // Two arms winding out, pushed about by noise so they are not drawn with a compass.
      const phase = 2 * a - Math.log(r / 20 + 1) * 3.1 + warp * 2.3;
      const crest = 0.5 + 0.5 * Math.cos(phase);
      const arm = crest ** 3;
      const lane = (0.5 + 0.5 * Math.cos(phase + 0.95)) ** 7 * smooth(clamp(r / 40));
      const disc = Math.exp(-r / 300);
      const body = disc * (0.13 + arm * 1.45) * (0.32 + cloud * 1.2) * (1 - lane * 0.8);
      // Pink where stars are being born, blue-violet further out, teal at the far ends.
      const out = smooth(clamp((r - 50) / 240));
      const edge = smooth(clamp((r - 210) / 170));
      let cr = mix(255, 110, out);
      let cg = mix(92, 92, out);
      let cb = mix(186, 255, out);
      cr = mix(cr, 40, edge);
      cg = mix(cg, 220, edge);
      cb = mix(cb, 214, edge);
      let red = cr * body;
      let grn = cg * body;
      let blu = cb * body;
      // Bright knots along the arms.
      const knot = smooth(clamp((fine - 0.58) / 0.24)) * arm * disc * disc;
      red += 255 * knot * 0.92;
      grn += 120 * knot * 0.92;
      blu += 190 * knot * 0.92;
      // Clouds that have nothing to do with the arms, filling the rest of the sky.
      const far = fbm2(farN, i / 40, j / 40, 5);
      const tint = fbm2(farM, i / 56 + 7, j / 56 + 3, 3);
      const veil = smooth(clamp((far - 0.42) / 0.3)) ** 1.6 * smooth(clamp(r / 110));
      const fil = (1 - Math.abs(cloud * 2 - 1)) ** 4 * veil;
      const teal = smooth(clamp((tint - 0.46) / 0.14));
      red += veil * mix(62, 6, teal) + fil * mix(110, 18, teal);
      grn += veil * mix(18, 62, teal) + fil * mix(32, 120, teal);
      blu += veil * mix(102, 80, teal) + fil * mix(160, 124, teal);
      // The heart.
      const bulge = Math.exp(-((r / 12) ** 2)) * 1.1 + Math.exp(-r / 26) * 0.58;
      red += 255 * bulge;
      grn += 208 * bulge;
      blu += 178 * bulge;
      const c = (j * TS + i) * 3;
      tex[c] = red;
      tex[c + 1] = grn;
      tex[c + 2] = blu;
    }
  }
  return tex;
}

/* ── the boat, one drawing for each way it can lean ────────────── */

const SAIL = ['#3e2b8a', '#4e389f', '#6349b3', '#7d62c6', '#9c84d8', '#bdaae6', '#ddd2f3', '#f4f0fc'].map(rgba);
const SAIL_WARM = ['#722c36', '#a0423c', '#cd6340', '#ee8c48', '#fab35c', '#ffd27c', '#ffe9a8'].map(rgba);
const JIB = ['#152468', '#1c3286', '#2645a6', '#355ec4', '#4c7cdc', '#6f9cec', '#9cbef5', '#cbdffb'].map(rgba);
const WOOD = ['#100b33', '#1e0a2e', '#2a1420', '#4a1f2c', '#722c36', '#a0423c', '#cd6340'].map(rgba);
const ink = rgba('#0b0826');
const shade = rgba('#100b33');

const BOAT_W = 96;
const BOAT_H = 92;
const BOAT_PIVOT = [50, 80];

function paintBoat(degrees) {
  const art = new Art(BOAT_W, BOAT_H);
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const on = ([x, y]) => [BOAT_PIVOT[0] + x * c - y * s, BOAT_PIVOT[1] + x * s + y * c];
  const back = (x, y) => {
    const dx = x - BOAT_PIVOT[0];
    const dy = y - BOAT_PIVOT[1];
    return [dx * c + dy * s, -dx * s + dy * c];
  };
  const shape = (pts, paint) => art.poly(pts.map(on), paint);
  const stroke = (p, q, col) => {
    const [ax, ay] = on(p);
    const [bx, by] = on(q);
    art.line(ax, ay, bx, by, col);
  };

  // The mainsail, swelling away from the mast. Starlit above, lantern-warm below.
  shape([[0, -68], [15, -50], [25, -30], [29, -13], [0, -11]], (x, y) => {
    const [lx, ly] = back(x, y);
    const seam = Math.abs((ly + 68 + lx * 0.28) % 10) < 1 ? -0.13 : 0;
    const belly = Math.sin(clamp(lx / 28) * Math.PI) * 0.26;
    const v = clamp(0.5 + belly + (-ly - 40) * 0.008 + seam);
    const warm = clamp((ly + 40) / 26) * clamp(1.15 - lx / 32);
    if (warm * warm > BAYER[(y & 3) * 4 + (x & 3)]) art.tone(x, y, SAIL_WARM, clamp(0.14 + warm * 0.62 + belly * 0.5 + seam), 0.7);
    else art.tone(x, y, SAIL, v, 0.9);
  });
  // The jib, cooler, in the shadow of the night side.
  shape([[-3, -64], [-3, -11], [-29, -13], [-18, -34]], (x, y) => {
    const [lx, ly] = back(x, y);
    const seam = Math.abs((ly + lx * 0.5) % 11) < 1 ? -0.12 : 0;
    art.tone(x, y, JIB, clamp(0.46 + (lx + 15) * 0.012 + (-ly - 34) * 0.009 + seam), 0.9);
  });

  // Mast, boom, a pennant.
  stroke([-1, -5], [-1, -72], ink);
  stroke([0, -5], [0, -70], WOOD[3]);
  stroke([0, -11], [30, -12], WOOD[2]);
  stroke([0, -10], [30, -11], ink);
  shape([[0, -72], [-9, -70], [0, -67]], rgba('#d648a4'));
  stroke([0, -72], [-6, -70.6], rgba('#f58fc6'));
  // A stay from the masthead to the bow.
  stroke([-1, -66], [-32, -13], shade);

  // The hull: planks, a lit rail, warm near the lantern.
  shape([[-35, -14], [-16, -7], [10, -6], [30, -9], [27, 3], [0, 4], [-22, 3]], (x, y) => {
    const [lx, ly] = back(x, y);
    const plank = Math.floor(ly + lx * 0.03 + 40) % 3 === 0 ? -0.1 : 0;
    const warm = clamp(1 - Math.hypot(lx + 28, ly + 10) / 34) * 0.55;
    art.tone(x, y, WOOD, clamp(0.3 + plank + warm - (ly + 8) * 0.018), 0.8);
  });
  stroke([-35, -14], [-16, -8], rgba('#ee8c48'));
  stroke([-16, -8], [10, -7], WOOD[6]);
  stroke([10, -7], [30, -10], WOOD[5]);

  // Someone at the stern, looking up.
  shape([[12, -7], [22, -7], [21, -14], [18, -19], [14, -19], [12, -14]], ink);
  const [hx, hy] = on([16, -21.5]);
  art.disc(hx, hy, 2.9, ink);
  const [ex, ey] = on([14.6, -22.6]);
  art.put(ex, ey, WOOD[5]);
  stroke([12, -17], [12, -9], WOOD[4]);

  // The lantern, on a bent pole over the bow.
  stroke([-28, -11], [-30, -24], ink);
  stroke([-30, -24], [-35, -28], ink);
  const [lx, ly] = on([-35, -24]);
  art.rect(Math.round(lx) - 2, Math.round(ly) - 3, 4, 1, ink);
  art.rect(Math.round(lx) - 2, Math.round(ly) + 3, 4, 1, ink);
  art.rect(Math.round(lx) - 1, Math.round(ly) - 2, 2, 5, rgba('#fff6d6'));
  art.rect(Math.round(lx) - 2, Math.round(ly) - 2, 1, 5, rgba('#fab35c'));
  art.rect(Math.round(lx) + 1, Math.round(ly) - 2, 1, 5, rgba('#fab35c'));

  // As a list of pixels: what a frame needs, and nothing it does not.
  const xs = [];
  const ys = [];
  const cs = [];
  for (let y = 0; y < BOAT_H; y += 1) {
    for (let x = 0; x < BOAT_W; x += 1) {
      const px = art.px[y * BOAT_W + x];
      if (px >>> 24) {
        xs.push(x - BOAT_PIVOT[0]);
        ys.push(y - BOAT_PIVOT[1]);
        cs.push(px);
      }
    }
  }
  return { xs: Int16Array.from(xs), ys: Int16Array.from(ys), cs: Uint32Array.from(cs), lanternX: lx - BOAT_PIVOT[0], lanternY: ly - BOAT_PIVOT[1] };
}

const BOAT_ANGLES = 9;
const BOAT_SWING = 3.6;

const nebulaVoyage = {
  build() {
    const rand = seeded(1000000000 % 65521);
    const cosL = Math.cos(LEAN);
    const sinL = Math.sin(LEAN);
    // Each sky pixel, as a point on the galaxy's own plane, and how much of that plane the sky shows.
    const PX = new Float32Array(W * HORIZON);
    const PY = new Float32Array(W * HORIZON);
    let reach = 1;
    for (let y = 0, i = 0; y < HORIZON; y += 1) {
      for (let x = 0; x < W; x += 1, i += 1) {
        const dx = x - CX;
        const dy = y - CY;
        PX[i] = dx * cosL + dy * sinL;
        PY[i] = (-dx * sinL + dy * cosL) / TILT;
        reach = Math.max(reach, Math.hypot(PX[i], PY[i]));
      }
    }
    const scale = (TS / 2 - 2) / reach;
    for (let i = 0; i < PX.length; i += 1) {
      PX[i] *= scale;
      PY[i] *= scale;
    }
    const tex = paintGalaxy(scale);

    // Night, deepening upward, with a band of far light where the sky meets the water.
    const base = new Float32Array(HORIZON * 3);
    for (let y = 0; y < HORIZON; y += 1) {
      const k = y / (HORIZON - 1);
      const low = Math.exp(-(HORIZON - 1 - y) / 16);
      const wide = Math.exp(-(HORIZON - 1 - y) / 58);
      base[y * 3] = mix(5, 13, k) + wide * 16 + low * 44;
      base[y * 3 + 1] = mix(4, 9, k) + wide * 15 + low * 66;
      base[y * 3 + 2] = mix(18, 40, k) + wide * 42 + low * 96;
    }

    // Thousands of stars, more of them along the disc, each in the galaxy's plane.
    const N = 5600;
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sb = new Float32Array(N);
    const sr = new Float32Array(N);
    const sg = new Float32Array(N);
    const sc = new Float32Array(N);
    const sp = new Float32Array(N);
    const TONES = [[255, 255, 255], [255, 255, 255], [214, 228, 255], [190, 212, 255], [255, 232, 206], [255, 206, 196], [206, 255, 240]];
    for (let i = 0; i < N; i += 1) {
      let r;
      let a;
      if (i % 3 === 0) {
        r = Math.sqrt(rand()) * reach;
        a = rand() * TAU;
      } else {
        r = -Math.log(1 - rand() * 0.94) * 130;
        // Nudged towards an arm.
        const arm = (Math.log(r / 20 + 1) * 3.1 + (rand() < 0.5 ? 0 : TAU)) / 2;
        a = arm + (rand() - 0.5) * 1.4;
      }
      sx[i] = Math.cos(a) * r;
      sy[i] = Math.sin(a) * r;
      const v = rand();
      sb[i] = 26 + v * v * v * v * 300 + v * 44;
      const tone = TONES[Math.floor(rand() * TONES.length)];
      sr[i] = tone[0] / 255;
      sg[i] = tone[1] / 255;
      sc[i] = tone[2] / 255;
      sp[i] = rand() * TAU;
    }

    // Islands at both ends of the horizon, so far off they are only a darker blue.
    const isle = new Int16Array(W);
    const hillN = noise2(9201, 32);
    for (let x = 0; x < W; x += 1) {
      const m = Math.exp(-(((x - 30) / 56) ** 2)) * 13 + Math.exp(-(((x - 118) / 22) ** 2)) * 5 + Math.exp(-(((x - 462) / 44) ** 2)) * 17 + Math.exp(-(((x - 214) / 12) ** 2)) * 2.5;
      isle[x] = Math.round(m * (0.72 + fbm2(hillN, x / 9, 4.5, 3) * 0.6));
    }

    // The ripple tile: long, flat, wrapping.
    const rA = noise2(9301, 32);
    const rB = noise2(9302, 32);
    const tile = new Float32Array(256 * 64);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        tile[y * 256 + x] = (fbm2(rA, x / 8, y / 2, 3) * 0.7 + fbm2(rB, x / 4, y / 2, 2) * 0.3 - 0.5) * 2.6;
      }
    }

    // A column of light on the water, under the heart of the galaxy.
    const sheen = new Float32Array(W * SEA);
    for (let y = 0; y < SEA; y += 1) {
      const d = y / (SEA - 1);
      const w = 26 + d * 46;
      for (let x = 0; x < W; x += 1) {
        sheen[y * W + x] = Math.exp(-(((x - CX) / w) ** 2)) * (0.16 + 0.64 * d * (1 - d) + 0.2 * (1 - d));
      }
    }

    // Glints: more of them under the bright part of the sky.
    const G = 300;
    const gx = new Int16Array(G);
    const gy = new Int16Array(G);
    const gf = new Float32Array(G);
    const gp = new Float32Array(G);
    for (let i = 0; i < G; i += 1) {
      const near = rand() < 0.5;
      gx[i] = near ? Math.round(CX + (rand() + rand() + rand() - 1.5) * 110) : Math.floor(rand() * W);
      gy[i] = HORIZON + 1 + Math.floor(rand() * rand() * (SEA - 2));
      gf[i] = 0.9 + rand() * 2.4;
      gp[i] = rand() * TAU;
    }

    const boats = [];
    for (let i = 0; i < BOAT_ANGLES; i += 1) boats.push(paintBoat(((i / (BOAT_ANGLES - 1)) * 2 - 1) * BOAT_SWING));

    const offset = Int16Array.from(BAYER, (v) => Math.round((v - 0.5) * 20));

    const canvas = new Art(W, H).canvas();
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);

    return { PX, PY, tex, base, sx, sy, sb, sr, sg, sc, sp, N, scale, isle, tile, sheen, gx, gy, gf, gp, G, boats, lut: paletteTable(), offset, img, out: new Uint32Array(img.data.buffer) };
  },

  draw(ctx, t, s) {
    const { PX, PY, tex, base, sx, sy, sb, sr, sg, sc, sp, N, isle, tile, sheen, gx, gy, gf, gp, G, boats, lut, offset, img, out } = s;
    const theta = (t / TURN) * TAU;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const mid = TS / 2;

    // The sky, in full colour.
    let i = 0;
    let j = 0;
    for (let y = 0; y < HORIZON; y += 1) {
      const br = base[y * 3];
      const bg = base[y * 3 + 1];
      const bb = base[y * 3 + 2];
      for (let x = 0; x < W; x += 1, i += 1, j += 3) {
        const px = PX[i];
        const py = PY[i];
        const u = px * c - py * sn + mid;
        const v = px * sn + py * c + mid;
        const iu = u | 0;
        const iv = v | 0;
        const fu = u - iu;
        const fv = v - iv;
        const t0 = (iv * TS + iu) * 3;
        const t2 = t0 + TS * 3;
        const a0 = (1 - fu) * (1 - fv);
        const a1 = fu * (1 - fv);
        const a2 = (1 - fu) * fv;
        const a3 = fu * fv;
        FR[j] = br + tex[t0] * a0 + tex[t0 + 3] * a1 + tex[t2] * a2 + tex[t2 + 3] * a3;
        FR[j + 1] = bg + tex[t0 + 1] * a0 + tex[t0 + 4] * a1 + tex[t2 + 1] * a2 + tex[t2 + 4] * a3;
        FR[j + 2] = bb + tex[t0 + 2] * a0 + tex[t0 + 5] * a1 + tex[t2 + 2] * a2 + tex[t2 + 5] * a3;
      }
    }

    // The stars, wheeling with it.
    const cosL = Math.cos(LEAN);
    const sinL = Math.sin(LEAN);
    for (let k = 0; k < N; k += 1) {
      const px = sx[k] * c + sy[k] * sn;
      const py = (-sx[k] * sn + sy[k] * c) * TILT;
      const x = (CX + px * cosL - py * sinL) | 0;
      const y = (CY + px * sinL + py * cosL) | 0;
      if (x < 1 || y < 1 || x >= W - 1 || y >= HORIZON - 1) continue;
      let b = sb[k];
      if (b > 90) {
        b *= 0.72 + 0.28 * Math.sin(t * (1 + (k % 7) * 0.4) + sp[k]);
      }
      const q = (y * W + x) * 3;
      const r0 = sr[k] * b;
      const g0 = sg[k] * b;
      const b0 = sc[k] * b;
      FR[q] += r0;
      FR[q + 1] += g0;
      FR[q + 2] += b0;
      if (b > 190) {
        const f = (b - 190) / 300;
        for (const o of [-3, 3, -W * 3, W * 3]) {
          FR[q + o] += r0 * f;
          FR[q + o + 1] += g0 * f;
          FR[q + o + 2] += b0 * f;
        }
      }
    }

    // A shooting star now and then, on a clock of its own.
    for (let lane = 0; lane < 2; lane += 1) {
      const period = lane ? 13.7 : 8.3;
      const slot = Math.floor(t / period);
      const rnd = seeded(slot * 31 + lane * 977 + 5);
      if (rnd() > 0.72) continue;
      const age = t - slot * period - rnd() * (period - 1.4);
      const dur = 0.55 + rnd() * 0.5;
      if (age < 0 || age > dur) continue;
      const x0 = 30 + rnd() * 420;
      const y0 = 8 + rnd() * 70;
      const dir = rnd() < 0.5 ? -1 : 1;
      const vx = dir * (150 + rnd() * 120);
      const vy = 46 + rnd() * 70;
      const k = age / dur;
      const fade = Math.sin(k * Math.PI);
      for (let q = 0; q < 34; q += 1) {
        const back = q * 0.012;
        if (back > age) break;
        const x = (x0 + vx * (age - back)) | 0;
        const y = (y0 + vy * (age - back)) | 0;
        if (x < 0 || y < 0 || x >= W || y >= HORIZON) continue;
        const w = fade * (1 - q / 34) ** 1.4 * 300;
        const o = (y * W + x) * 3;
        FR[o] += w * 0.92;
        FR[o + 1] += w * 0.96;
        FR[o + 2] += w;
      }
    }

    // Islands, the same blue as the far haze.
    for (let x = 0; x < W; x += 1) {
      for (let h = 0; h < isle[x]; h += 1) {
        const o = ((HORIZON - 1 - h) * W + x) * 3;
        const fog = (isle[x] - h) / 26;
        FR[o] = 10 + fog * 34;
        FR[o + 1] = 8 + fog * 32;
        FR[o + 2] = 30 + fog * 66;
      }
    }

    // The sea is that same sky, seen in moving ripples.
    const drift = t * 6;
    const rise = t * 1.6;
    j = HORIZON * W * 3;
    for (let y = HORIZON; y < H; y += 1) {
      const row = y - HORIZON;
      const d = row / (SEA - 1);
      const src = HORIZON - 1 - row * 1.46;
      const ax = 0.8 + d * 8;
      const ay = 1 + d * 16;
      const shift = (Math.sin(row * 0.9 + t * 1.3) + Math.sin(row * 0.37 - t * 0.8) * 0.7) * (0.3 + d * 2.6);
      const gain = mix(0.96, 0.62, d);
      const stretch = 1.5 - d * 1.05;
      const b1 = ((((row * 3.3 + rise) | 0) & 63) << 8) >>> 0;
      const b2 = ((((row * 2.1 - rise * 0.7 + 31) | 0) & 63) << 8) >>> 0;
      let u1 = drift + row * 11;
      let u2 = -drift * 0.7 + row * 5 + 90;
      const sheenAt = row * W;
      for (let x = 0; x < W; x += 1, j += 3) {
        const w1 = tile[b1 + ((u1 | 0) & 255)];
        const w2 = tile[b2 + ((u2 | 0) & 255)];
        u1 += stretch;
        u2 += stretch * 0.8;
        const w = (w1 + w2) * 0.5;
        let qx = (x + shift + w * ax) | 0;
        qx = qx < 0 ? 0 : qx >= W ? W - 1 : qx;
        let qy = (src + w * ay) | 0;
        qy = qy < 0 ? 0 : qy >= HORIZON ? HORIZON - 1 : qy;
        const q = (qy * W + qx) * 3;
        // Crests catch more of the sky, troughs less.
        const lit = gain * (w > 0.26 ? 1.3 : w < -0.26 ? 0.62 : 1);
        const glow = sheen[sheenAt + x] * (w > 0 ? 1 : 0.4);
        FR[j] = FR[q] * lit * 0.78 + 4 + glow * 110;
        FR[j + 1] = FR[q + 1] * lit * 0.86 + 7 + glow * 66;
        FR[j + 2] = FR[q + 2] * lit * 0.96 + 16 + glow * 104;
      }
    }

    // The boat's lean and its lantern, which lights the air and draws a path on the water.
    const lean = Math.sin(t * 0.8) * 2.5 + Math.sin(t * 0.47 + 1) * 1.1;
    const pick = clamp(Math.round(((lean + BOAT_SWING) / (BOAT_SWING * 2)) * (BOAT_ANGLES - 1)), 0, BOAT_ANGLES - 1);
    const boat = boats[pick];
    const bob = Math.round(Math.sin(t * 1.1) * 1.3);
    const bx = BOAT_X;
    const by = BOAT_Y + bob;
    const lanternX = bx + boat.lanternX;
    const lanternY = by + boat.lanternY;
    const flicker = 0.86 + 0.09 * Math.sin(t * 9.1) + 0.05 * Math.sin(t * 23.3 + 1);
    for (let y = Math.max(0, (lanternY - 34) | 0); y < Math.min(H, lanternY + 34); y += 1) {
      for (let x = Math.max(0, (lanternX - 34) | 0); x < Math.min(W, lanternX + 34); x += 1) {
        const e = ((x - lanternX) ** 2 + (y - lanternY) ** 2) / (34 * 34);
        if (e >= 1) continue;
        const w = (1 - e) ** 2.6 * flicker;
        const o = (y * W + x) * 3;
        FR[o] += w * 170;
        FR[o + 1] += w * 96;
        FR[o + 2] += w * 34;
      }
    }
    // Rings going out from the hull as it rocks.
    for (let ring = 0; ring < 3; ring += 1) {
      const p = (t * 0.16 + ring / 3) % 1;
      const rx = 34 + p * 42;
      const ry = 3.4 + p * 8;
      const strength = (1 - p) ** 1.6 * 44;
      const steps = Math.round(rx * 3);
      for (let k = 0; k <= steps; k += 1) {
        if ((k + ring * 5) % 7 < 2) continue;
        const a = (k / steps) * Math.PI;
        const x = Math.round(bx + Math.cos(a) * rx);
        const y = Math.round(by + 2 + Math.sin(a) * ry);
        if (x < 0 || x >= W || y < HORIZON || y >= H) continue;
        const o = (y * W + x) * 3;
        FR[o] += strength * 0.7;
        FR[o + 1] += strength * 0.9;
        FR[o + 2] += strength;
      }
    }
    // The lantern's path on the water.
    for (let y = by + 1; y < Math.min(H, by + 52); y += 1) {
      const q = (y - by) / 52;
      const half = 1.5 + q * 7;
      for (let x = (lanternX - half) | 0; x <= lanternX + half; x += 1) {
        if (x < 0 || x >= W) continue;
        const wv = tile[((((y * 3 + t * 2) | 0) & 63) << 8) + (((x * 1.4 + t * 9) | 0) & 255)];
        if (wv < -0.05) continue;
        const f = (1 - q) ** 1.5 * (1 - Math.abs(x - lanternX) / (half + 1)) * flicker;
        const o = (y * W + x) * 3;
        FR[o] += f * 240;
        FR[o + 1] += f * 150;
        FR[o + 2] += f * 56;
      }
    }

    // A far boat, on the left, with a light of its own.
    const farX = 86;
    const farY = 178 + Math.round(Math.sin(t * 0.9 + 2) * 0.6);
    const farGlow = 0.8 + 0.2 * Math.sin(t * 6.3 + 2);
    for (let y = farY - 9; y < farY + 18; y += 1) {
      for (let x = farX - 9; x < farX + 10; x += 1) {
        const e = ((x - farX + 3) ** 2 + ((y - farY + 1) * (y > farY ? 0.4 : 1)) ** 2) / 64;
        if (e >= 1) continue;
        const w = (1 - e) ** 2 * farGlow;
        const o = (y * W + x) * 3;
        FR[o] += w * 120;
        FR[o + 1] += w * 70;
        FR[o + 2] += w * 26;
      }
    }

    // Now into pixels: one palette, dithered where it stands on the screen.
    i = 0;
    j = 0;
    for (let y = 0; y < H; y += 1) {
      const dRow = (y & 3) * 4;
      for (let x = 0; x < W; x += 1, i += 1, j += 3) {
        const d = offset[dRow + (x & 3)];
        let r = (FR[j] + d) | 0;
        let g = (FR[j + 1] + d) | 0;
        let b = (FR[j + 2] + d) | 0;
        r = r < 0 ? 0 : r > 255 ? 255 : r;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        b = b < 0 ? 0 : b > 255 ? 255 : b;
        out[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
      }
    }

    // Glints on the water, each lighting up on its own beat.
    const PALE = lut[(30 << 10) | (28 << 5) | 31];
    const SOFT_WHITE = lut[(31 << 10) | (31 << 5) | 31];
    for (let k = 0; k < G; k += 1) {
      const v = Math.sin(t * gf[k] + gp[k]);
      if (v < 0.88) continue;
      const o = gy[k] * W + gx[k];
      if (gx[k] < 2 || gx[k] >= W - 2) continue;
      if (v > 0.985) {
        out[o] = SOFT_WHITE;
        out[o - 1] = PALE;
        out[o + 1] = PALE;
      } else out[o] = PALE;
    }

    // The boat, and its dark double on the water.
    const { xs, ys, cs } = boat;
    for (let k = 0; k < xs.length; k += 1) {
      const row = ys[k];
      if (row < -1) {
        const down = -row;
        const my = by + Math.round(down * 0.86) + 1;
        if (my < H && (down < 22 || (xs[k] + my) % 2 === 0)) {
          const wob = Math.round(Math.sin(down * 0.8 + t * 2.2) * (0.5 + down * 0.05));
          const mx = bx + xs[k] + wob;
          if (mx >= 0 && mx < W) {
            const o = my * W + mx;
            // Halfway between the water and a darkened boat.
            out[o] = (((out[o] >>> 1) & 0x7f7f7f) + ((cs[k] >>> 2) & 0x3f3f3f)) | 0xff000000;
          }
        }
      }
    }
    for (let k = 0; k < xs.length; k += 1) {
      const x = bx + xs[k];
      const y = by + ys[k];
      if (x >= 0 && x < W && y >= 0 && y < H && ys[k] <= 1) out[y * W + x] = cs[k];
    }

    // The far boat itself: a dark hull, a sliver of sail, one warm point.
    const inkC = lut[(1 << 10) | (1 << 5) | 5];
    const sailC = lut[(11 << 10) | (9 << 5) | 20];
    for (let h = 0; h < 8; h += 1) for (let x = 0; x <= Math.floor(h * 0.6); x += 1) out[(farY - 9 + h) * W + farX + x] = sailC;
    for (let x = -5; x <= 5; x += 1) out[farY * W + farX + x] = inkC;
    for (let x = -4; x <= 4; x += 1) out[(farY + 1) * W + farX + x] = inkC;
    out[(farY - 1) * W + farX - 3] = lut[(31 << 10) | (26 << 5) | 15];

    ctx.putImageData(img, 0, 0);
  },
};

export default nebulaVoyage;
