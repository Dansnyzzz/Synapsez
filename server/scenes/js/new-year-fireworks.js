import { Art, TAU, clamp, mix, smooth, seeded, newCanvas, noise2, fbm2 } from './art.js';

/**
 * New Year's Eve on a river: shells fired from barges, a city across the water, a crowd
 * along the near embankment.
 *
 * Canvas blending clips at white, and a firework is mostly about what happens past
 * white, so the stars are added up in a floating-point buffer and only then exposed
 * like film: a dense core burns out to white and its edges keep their colour. The same
 * light feeds the bloom, the reflection, the smoke and whatever a flash falls on.
 *
 * Every shell is a closed formula of the time since it was fired (drag and gravity
 * integrate exactly), on a schedule that repeats every PERIOD seconds, so a frame needs
 * nothing from the frame before it. The buffers below are only scratch paper.
 */

const CW = 960;
const CH = 540;
/** Where the far bank meets the river. */
const WATER = 372;
/** Where the near embankment hides it. */
const WALL = 470;
const PERIOD = 56;
/** Smoke and hanging stars drift with this, one whole smoke tile a loop. */
const WIND = 512 / PERIOD;

/* Scratch paper. Star light at full size, the same light a quarter the size, and a coarse field of what the flashes light up. */
const FW = CW;
const FH = 392;
const LW = 240;
const LH = 98;
const GW = 64;
const GH = 36;
const RW = 480;
const RH = WALL + 6 - WATER;
const TW = 512;
const TH = 256;
const F = new Float32Array(FW * FH * 3);
const L = new Float32Array(LW * LH * 3);
const WIDE = new Float32Array(60 * 25 * 3);
const G = new Float32Array(GW * GH * 3);
const SMOKE = new Float32Array(LW * LH);
const COLUMN = new Float32Array(61 * 3);
const SCRATCH = new Float32Array(Math.max(LW, LH) * 3 + 8);

/* Numbers that look random and stay the same. */
const TWK = new Float32Array(256);
const JIT = new Float32Array(256);
const COS = new Float32Array(256);
const SIN = new Float32Array(256);
{
  const rand = seeded(2026);
  for (let i = 0; i < 256; i += 1) {
    TWK[i] = rand();
    JIT[i] = rand() * 2 - 1;
    const a = rand() * TAU;
    COS[i] = Math.cos(a);
    SIN[i] = Math.sin(a);
  }
}

/** Film: light in, a byte out. Past about 3 it is simply white. */
const TONE = new Uint8ClampedArray(2048);
for (let i = 0; i < 2048; i += 1) TONE[i] = 255 * (1 - Math.exp(-i / 256)) ** 0.78;

const pack = (r, g, b, a = 255) => ((a << 24) | (clamp(b, 0, 255) << 16) | (clamp(g, 0, 255) << 8) | clamp(r, 0, 255)) >>> 0;
const BLACK = 0xff000000;
const bump = (x, at, width) => Math.exp(-(((x - at) / width) ** 2));

/* ── putting light on the paper ────────────────────────────────── */

function hot(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= FW - 1 || y >= FH - 1) return;
  const ix = x | 0;
  const iy = y | 0;
  const fx = x - ix;
  const fy = y - iy;
  const gx = 1 - fx;
  const gy = 1 - fy;
  let j = (iy * FW + ix) * 3;
  let w = gx * gy;
  F[j] += r * w;
  F[j + 1] += g * w;
  F[j + 2] += b * w;
  w = fx * gy;
  F[j + 3] += r * w;
  F[j + 4] += g * w;
  F[j + 5] += b * w;
  j += FW * 3;
  w = gx * fy;
  F[j] += r * w;
  F[j + 1] += g * w;
  F[j + 2] += b * w;
  w = fx * fy;
  F[j + 3] += r * w;
  F[j + 4] += g * w;
  F[j + 5] += b * w;
  const c = ((iy >> 2) * LW + (ix >> 2)) * 3;
  L[c] += r;
  L[c + 1] += g;
  L[c + 2] += b;
}

/** A line of light, dim at its tail and bright at its head. */
function streak(x0, y0, x1, y1, r, g, b, i0, i1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (n < 1) {
    hot(x1, y1, r * i1, g * i1, b * i1);
    return;
  }
  const sx = dx / n;
  const sy = dy / n;
  const si = (i1 - i0) / n;
  let x = x0;
  let y = y0;
  let i = i0;
  for (let k = 0; k <= n; k += 1) {
    hot(x, y, r * i, g * i, b * i);
    x += sx;
    y += sy;
    i += si;
  }
}

/** A soft ball of light on the small buffer only: it reads as glare, not as a thing. */
function glare(x, y, radius, r, g, b) {
  const cx = x / 4;
  const cy = y / 4;
  const rc = radius / 4;
  const x0 = Math.max(0, Math.floor(cx - rc));
  const x1 = Math.min(LW - 1, Math.ceil(cx + rc));
  const y0 = Math.max(0, Math.floor(cy - rc));
  const y1 = Math.min(LH - 1, Math.ceil(cy + rc));
  const k = 1 / (rc * rc);
  for (let j = y0; j <= y1; j += 1) {
    for (let i = x0; i <= x1; i += 1) {
      const d = ((i - cx) * (i - cx) + (j - cy) * (j - cy)) * k;
      if (d >= 1) continue;
      const w = (1 - d) * (1 - d);
      const c = (j * LW + i) * 3;
      L[c] += r * w;
      L[c + 1] += g * w;
      L[c + 2] += b * w;
    }
  }
}

const COLS_A = new Float32Array(GW);
const COLS_B = new Float32Array(GW);
const ROWS_A = new Float32Array(GH);
const ROWS_B = new Float32Array(GH);
/** A flash, as it falls on the scene: strongly nearby, a little everywhere. */
function lightUp(x, y, r, g, b, reach) {
  for (let i = 0; i < GW; i += 1) {
    const d = ((i * CW) / (GW - 1) - x) / reach;
    COLS_A[i] = Math.exp(-d * d);
    COLS_B[i] = Math.exp(-d * d * 0.11);
  }
  for (let j = 0; j < GH; j += 1) {
    const d = ((j * CH) / (GH - 1) - y) / reach;
    ROWS_A[j] = Math.exp(-d * d);
    ROWS_B[j] = Math.exp(-d * d * 0.11);
  }
  let c = 0;
  for (let j = 0; j < GH; j += 1) {
    const ra = ROWS_A[j];
    const rb = ROWS_B[j];
    for (let i = 0; i < GW; i += 1) {
      const w = 0.72 * COLS_A[i] * ra + 0.28 * COLS_B[i] * rb;
      G[c] += r * w;
      G[c + 1] += g * w;
      G[c + 2] += b * w;
      c += 3;
    }
  }
}

function puff(x, y, radius, density) {
  const cx = x / 4;
  const cy = y / 4;
  const rc = radius / 4;
  const x0 = Math.max(0, Math.floor(cx - rc));
  const x1 = Math.min(LW - 1, Math.ceil(cx + rc));
  const y0 = Math.max(0, Math.floor(cy - rc));
  const y1 = Math.min(LH - 1, Math.ceil(cy + rc));
  const k = 1 / (rc * rc);
  for (let j = y0; j <= y1; j += 1) {
    for (let i = x0; i <= x1; i += 1) {
      const d = ((i - cx) * (i - cx) + (j - cy) * (j - cy)) * k;
      if (d < 1) SMOKE[j * LW + i] += density * (1 - d) * (1 - d);
    }
  }
}

/* ── colour over a star's life ─────────────────────────────────── */

const HUE = {
  red: [1, 0.09, 0.05],
  crimson: [1, 0.05, 0.17],
  orange: [1, 0.34, 0.05],
  gold: [1, 0.6, 0.15],
  lemon: [1, 0.86, 0.32],
  green: [0.14, 1, 0.3],
  emerald: [0.05, 0.85, 0.46],
  teal: [0.06, 0.82, 0.86],
  blue: [0.13, 0.3, 1],
  azure: [0.2, 0.56, 1],
  violet: [0.56, 0.2, 1],
  magenta: [1, 0.14, 0.62],
  pink: [1, 0.4, 0.64],
  silver: [0.8, 0.87, 1],
  white: [1, 0.95, 0.86],
};
const EMBER = [1, 0.22, 0.03];

/** A table of 64 steps through the given stops: [position, r, g, b, strength]. */
function table(stops) {
  const out = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i += 1) {
    const at = i / 63;
    let k = 0;
    while (k < stops.length - 2 && stops[k + 1][0] <= at) k += 1;
    const a = stops[k];
    const b = stops[k + 1];
    const f = clamp((at - a[0]) / (b[0] - a[0]));
    const s = mix(a[4], b[4], f);
    out[i * 3] = mix(a[1], b[1], f) * s;
    out[i * 3 + 1] = mix(a[2], b[2], f) * s;
    out[i * 3 + 2] = mix(a[3], b[3], f) * s;
  }
  return out;
}

const palettes = new Map();
/** White hot, then its colour, then (if given) another, then an ember going out. */
function starColours(name, then = null) {
  const key = `${name}:${then}`;
  if (palettes.has(key)) return palettes.get(key);
  const c = HUE[name];
  const d = then ? HUE[then] : c;
  const warm = [mix(d[0], EMBER[0], 0.75), mix(d[1], EMBER[1], 0.75), mix(d[2], EMBER[2], 0.75)];
  const out = table([
    [0, 1, 0.94, 0.82, 4.2],
    [0.05, mix(1, c[0], 0.65), mix(0.92, c[1], 0.65), mix(0.8, c[2], 0.65), 3],
    [0.16, ...c, 2.1],
    [0.46, ...c, 1.65],
    [0.56, ...d, 1.5],
    [0.8, ...d, 0.9],
    [0.93, ...warm, 0.42],
    [1, ...warm, 0],
  ]);
  palettes.set(key, out);
  return out;
}
const SPARKS_GOLD = table([
  [0, 1, 0.82, 0.5, 1.15],
  [0.16, 1, 0.62, 0.2, 0.9],
  [0.5, 1, 0.38, 0.08, 0.46],
  [0.8, 1, 0.2, 0.03, 0.16],
  [1, 1, 0.14, 0.02, 0],
]);
const SPARKS_SILVER = table([
  [0, 1, 1, 1, 1.15],
  [0.25, 0.85, 0.9, 1, 0.75],
  [0.6, 0.72, 0.72, 0.9, 0.32],
  [1, 0.6, 0.5, 0.6, 0],
]);
const tinted = (name) =>
  table([
    [0, 1, 0.95, 0.85, 1.05],
    [0.18, ...HUE[name], 0.8],
    [0.6, ...HUE[name], 0.32],
    [1, ...EMBER, 0],
  ]);

/* ── a burst ───────────────────────────────────────────────────── */

const SP_MAX = 256;
const spU = new Float32Array(SP_MAX);
const spX = new Float32Array(SP_MAX);
const spY = new Float32Array(SP_MAX);
const spT = new Float32Array(SP_MAX);
const spJ = new Float32Array(SP_MAX);
const spR = new Float32Array(SP_MAX);
const spG = new Float32Array(SP_MAX);
const spB = new Float32Array(SP_MAX);
const spS = new Int32Array(SP_MAX);

/**
 * One group of stars. A star's flight under drag `k` and gravity `g`:
 *   x(a) = x0 + v * dir * u(a) + wind * (a - u(a)),   u(a) = (1 - e^(-k a)) / k
 * Its sparks are left where it was at fixed moments, so a trail stays in the air and
 * does not slide along with the star that made it.
 */
function drawLayer(s, layer, at) {
  const a = at - layer.delay;
  if (a <= 0 || a >= layer.end) return;
  const { n, dx, dy, m, l, h, k, v, g, life, pal, head, tail, spark, strobe, crackle, sag } = layer;
  const bx = s.bx;
  const by = s.by;
  const fall = g / k;
  const u = (1 - Math.exp(-k * a)) / k;
  const wx = WIND * (a - u);
  let fy = fall * (a - u);
  const ap = a > tail ? a - tail : 0;
  const up = (1 - Math.exp(-k * ap)) / k;
  const wxp = WIND * (ap - up);
  let fyp = fall * (ap - up);
  if (sag && a > sag.at) {
    fy += 0.5 * sag.g * (a - sag.at) ** 2;
    fyp += ap > sag.at ? 0.5 * sag.g * (ap - sag.at) ** 2 : 0;
  }

  let sparks = 0;
  let holes = 0;
  if (spark) {
    holes = spark.holes;
    const times = spark.times;
    const from = a - spark.life;
    const f = spark.i;
    for (let j = 0, nt = times.length; j < nt && sparks < SP_MAX; j += 1) {
      const ts = times[j];
      if (ts > a) break;
      if (ts <= from) continue;
      const e = a - ts;
      const us = spark.us[j];
      const drift = ts - us;
      let sy = fall * drift + spark.fall * e + 0.5 * spark.grav * e * e;
      if (sag && ts > sag.at) sy += 0.5 * sag.g * (ts - sag.at) ** 2;
      const q = sparks;
      spU[q] = us;
      spX[q] = WIND * drift + WIND * e * 0.7;
      spY[q] = sy;
      spT[q] = ts;
      spJ[q] = spark.spread * e;
      const c = (((e / spark.life) * 63) | 0) * 3;
      spR[q] = spark.pal[c] * f;
      spG[q] = spark.pal[c + 1] * f;
      spB[q] = spark.pal[c + 2] * f;
      spS[q] = j;
      sparks += 1;
    }
  }

  for (let i = 0; i < n; i += 1) {
    const hi = h[i];
    const lifeOf = life * l[i];
    const ddx = dx[i] * v * m[i];
    const ddy = dy[i] * v * m[i];
    const nr = a / lifeOf;
    const cracked = crackle ? nr - crackle.at - TWK[(hi + 31) & 255] * crackle.spread : -1;
    if (cracked * lifeOf >= 0.34) continue;
    if (nr < 1) {
      const x = bx + ddx * u + wx;
      const y = by + ddy * u + fy;
      const c = ((nr * 63) | 0) * 3;
      let b = head * (0.72 + TWK[hi] * 0.56);
      if (nr > 0.68) b *= 0.45 + 0.55 * TWK[(hi + ((a * 22) | 0) * 13) & 255];
      if (strobe) {
        const ph = (a * (strobe.f0 + strobe.f1 * TWK[hi]) + TWK[(hi + 77) & 255]) % 1;
        b = ph < strobe.duty ? b * (1.6 - ph / strobe.duty) : b * 0.02;
      }
      if (cracked > 0) b = 0;
      if (b > 0.01) {
        const r0 = pal[c];
        const g0 = pal[c + 1];
        const b0 = pal[c + 2];
        const xp = bx + ddx * up + wxp;
        const yp = by + ddy * up + fyp;
        const len = Math.abs(x - xp) + Math.abs(y - yp);
        if (len > 1.2) {
          const each = b / (1 + len * 0.11);
          streak(xp, yp, x, y, r0, g0, b0, each * 0.05, each);
        }
        hot(x, y, r0 * b, g0 * b, b0 * b);
      }
      if (crackle) {
        // The star spends itself in one crack: a white pop and a few tiny sparks thrown off.
        if (cracked > 0) {
          const secs = cracked * lifeOf;
          const pop = Math.exp(-secs * 16) * crackle.i;
          hot(x, y, pop, pop * 0.96, pop * 0.82);
          if (secs < 0.34) {
            const rad = crackle.reach * (1 - Math.exp(-secs * 15));
            const lit = 1.5 * Math.exp(-secs * 8);
            for (let q = 0; q < 5; q += 1) {
              const ang = (hi * 7 + q * 53) & 255;
              hot(x + COS[ang] * rad, y + SIN[ang] * rad + secs * secs * 30, lit, lit * 0.84, lit * 0.5);
            }
          }
        }
      }
    }
    for (let j = 0; j < sparks; j += 1) {
      if (spT[j] > lifeOf) continue;
      const st = spS[j];
      const tw = TWK[(hi + st * 37) & 255];
      if (tw < holes) continue;
      const x = bx + ddx * spU[j] + spX[j] + JIT[(hi * 3 + st * 91) & 255] * spJ[j];
      const y = by + ddy * spU[j] + spY[j] + JIT[(hi * 5 + st * 59) & 255] * spJ[j] * 0.6;
      const w = 0.4 + tw * 0.9;
      hot(x, y, spR[j] * w, spG[j] * w, spB[j] * w);
    }
  }
}

/** The shell on its way up: a dim head and a thin line of sparks falling behind it. */
function drawRise(s, age) {
  const D = s.rise;
  const dx = s.bx - s.lx;
  const dy = s.by - s.ly;
  if (age < D) {
    const q = age / D;
    const x = s.lx + dx * q + Math.sin(q * 9 + s.bx) * 1.6 * (1 - q);
    const y = s.ly + dy * (1 - (1 - q) * (1 - q));
    const b = s.tailI * (1.5 - q * 0.8);
    hot(x, y, b * 1.3, b * 0.86, b * 0.4);
    hot(x, y + 1, b * 0.8, b * 0.5, b * 0.2);
  }
  const dt = 0.014;
  const base = Math.floor(Math.min(age, D) / dt);
  const lifeS = 0.42 + s.tailI * 0.36;
  for (let j = 0; j < 70; j += 1) {
    const step = base - j;
    if (step < 0) break;
    const ts = step * dt;
    const e = age - ts;
    if (e >= lifeS) break;
    const hash = (step * 41 + s.seed) & 255;
    const tw = TWK[hash];
    if (tw < 0.2) continue;
    const q = ts / D;
    const c = (((e / lifeS) * 63) | 0) * 3;
    const w = s.tailI * (0.3 + tw * 0.8);
    const x = s.lx + dx * q + Math.sin(q * 9 + s.bx) * 1.6 * (1 - q) + JIT[hash] * e * 7;
    const y = s.ly + dy * (1 - (1 - q) * (1 - q)) + e * 10 + e * e * 26 + JIT[(hash + 9) & 255] * e * 4;
    hot(x, y, SPARKS_GOLD[c] * w, SPARKS_GOLD[c + 1] * w, SPARKS_GOLD[c + 2] * w);
  }
  if (age < 0.16) {
    const f = Math.exp(-age * 24) * 0.9 * s.muzzle;
    glare(s.lx, s.ly, 26, f * 3, f * 2.1, f * 1.1);
    hot(s.lx, s.ly, f * 9, f * 7, f * 4);
  }
}

/* ── kinds of shell ────────────────────────────────────────────── */

function starsFor(n, rand, jitter, lifeJitter) {
  const m = new Float32Array(n);
  const l = new Float32Array(n);
  const h = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    m[i] = 1 + (rand() - 0.5) * jitter * 2;
    l[i] = 1 + (rand() - 0.5) * lifeJitter * 2;
    h[i] = Math.floor(rand() * 256);
  }
  return { n, m, l, h };
}

/** Stars spread evenly over a ball, seen from outside: denser towards the rim, as the real thing is. */
function sphereDirs(n, rand) {
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const a = rand() * TAU;
  const b = rand() * TAU;
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
  for (let i = 0; i < n; i += 1) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const x = Math.cos(i * golden) * r;
    const y = Math.sin(i * golden) * r;
    const y2 = y * ca - z * sa;
    const z2 = y * sa + z * ca;
    dx[i] = x * cb + z2 * sb;
    dy[i] = y2;
  }
  return { dx, dy };
}

function ringDirs(n, tilt, turn) {
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  const [ct, cz, sz] = [Math.cos(tilt), Math.cos(turn), Math.sin(turn)];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    const x = Math.cos(a);
    const y = Math.sin(a) * ct;
    dx[i] = x * cz - y * sz;
    dy[i] = x * sz + y * cz;
  }
  return { dx, dy };
}

/**
 * The moments a star leaves a spark, fixed for good. Evenly by distance while it flies
 * out, so the line from the centre is whole; evenly by time once it hangs and falls.
 */
function sparkOf(o, k, life) {
  const spark = { radial: 24, late: 0.05, life: 0.8, fall: 6, grav: 0, spread: 3, i: 1, holes: 0.15, pal: SPARKS_GOLD, ...o };
  const times = [];
  for (let i = 1; i <= spark.radial; i += 1) times.push(-Math.log(1 - (i / spark.radial) * 0.93) / k);
  let at = times.length ? times[times.length - 1] : 0;
  while (at < life * 1.2) {
    at += spark.late;
    times.push(at);
  }
  spark.times = Float32Array.from(times);
  spark.us = Float32Array.from(times, (ts) => (1 - Math.exp(-k * ts)) / k);
  return spark;
}

function layerOf(dirs, stars, o) {
  const k = o.k ?? 2.5;
  const life = o.life ?? 2;
  const out = {
    ...dirs,
    ...stars,
    k,
    v: o.v ?? (o.R ?? 100) * k,
    g: o.g ?? 30,
    life,
    pal: o.pal,
    head: o.head ?? 2.4,
    tail: o.tail ?? 0.05,
    delay: o.delay ?? 0,
    spark: o.spark ? sparkOf(o.spark, k, life) : null,
    strobe: o.strobe ?? null,
    crackle: o.crackle ?? null,
    sag: o.sag ?? null,
  };
  out.end = out.life * 1.3 + (out.spark ? out.spark.life : 0);
  return out;
}

const count = (n, d) => Math.round(n * d);
const sphereLayer = (rand, n, jitter, lifeJitter, o) => layerOf(sphereDirs(n, rand), starsFor(n, rand, jitter, lifeJitter), o);

const WILLOW_GOLD = table([[0, 1, 0.92, 0.72, 3], [0.05, 1, 0.74, 0.3, 1.6], [0.7, 1, 0.54, 0.14, 1], [1, 1, 0.26, 0.05, 0]]);

const KINDS = {
  /** Round, clean balls of colour with a tight heart of another. */
  peony: (rand, R, [a, b], d) => ({
    flash: 1.25,
    glow: 0.3,
    layers: [
      sphereLayer(rand, count(300, d), 0.04, 0.12, { R, k: 2.7, g: 34, life: 2.2, pal: starColours(a), head: 2.7, tail: 0.06, spark: { radial: 12, late: 0.07, life: 0.5, fall: 5, spread: 1.4, pal: tinted(a), i: 0.42, holes: 0.2 } }),
      sphereLayer(rand, count(100, d), 0.06, 0.12, { R: R * 0.46, k: 2.7, g: 34, life: 1.6, pal: starColours(b || a), head: 2.3, tail: 0.05, delay: 0.03 }),
    ],
  }),
  /** Every star draws a line of sparks from the heart outward, and the tips turn colour near the end. */
  chrysanthemum: (rand, R, [a, b, c], d) => ({
    flash: 1.4,
    glow: 0.34,
    layers: [
      sphereLayer(rand, count(230, d), 0.05, 0.1, {
        R,
        k: 2.4,
        g: 30,
        life: 2.7,
        pal: starColours(a, c || null),
        head: 2.2,
        tail: 0.1,
        spark: { radial: 26, late: 0.05, life: 1.15, fall: 7, spread: 2.2, pal: tinted(a), i: 0.72, holes: 0.12 },
      }),
      sphereLayer(rand, count(60, d), 0.08, 0.14, { R: R * 0.42, k: 2.4, g: 30, life: 1.9, pal: starColours(b || 'white'), head: 2.1, tail: 0.08, delay: 0.04 }),
    ],
  }),
  /** Long gold that hangs in the air and comes down slowly. */
  willow: (rand, R, _h, d) => ({
    flash: 1.05,
    glow: 0.4,
    layers: [
      sphereLayer(rand, count(140, d), 0.1, 0.16, {
        R,
        k: 2.6,
        g: 72,
        life: 5.2,
        pal: WILLOW_GOLD,
        head: 1.4,
        tail: 0.1,
        spark: { radial: 30, late: 0.045, life: 3, fall: 5, grav: 1.5, spread: 1.5, pal: SPARKS_GOLD, i: 0.62, holes: 0.08 },
      }),
    ],
  }),
  /** One or two rings, flat in the air at some tilt, with a small heart. */
  ring: (rand, R, [a, b], d) => {
    const tilt = 0.5 + rand() * 0.8;
    const turn = rand() * TAU;
    const n = count(64, Math.max(d, 0.7));
    const layers = [layerOf(ringDirs(n, tilt, turn), starsFor(n, rand, 0.012, 0.08), { R, k: 2.7, g: 22, life: 2.3, pal: starColours(a), head: 3, tail: 0.07 })];
    if (b) layers.push(layerOf(ringDirs(n, tilt + 1.2, turn + 1.7), starsFor(n, rand, 0.012, 0.08), { R: R * 0.82, k: 2.7, g: 22, life: 2.2, pal: starColours(b), head: 3, tail: 0.07, delay: 0.02 }));
    layers.push(sphereLayer(rand, 26, 0.1, 0.1, { R: R * 0.18, k: 2.8, g: 22, life: 1.5, pal: starColours(b || 'white'), head: 2, tail: 0.04 }));
    return { flash: 0.95, glow: 0.24, layers };
  },
  /** A dozen heavy comets that climb, bend and droop like fronds. */
  palm: (rand, R, [a], d) => {
    const n = Math.round((11 + rand() * 4) * Math.max(0.8, d));
    const dx = new Float32Array(n);
    const dy = new Float32Array(n);
    const off = rand() * TAU;
    for (let i = 0; i < n; i += 1) {
      const ang = off + (i / n) * TAU + (rand() - 0.5) * 0.18;
      const reach = 0.82 + rand() * 0.2;
      dx[i] = Math.cos(ang) * reach;
      dy[i] = Math.sin(ang) * reach * 0.86 - 0.2;
    }
    const pal = table([[0, 1, 0.94, 0.8, 4], [0.1, 1, 0.74, 0.32, 3], [0.7, 1, 0.5, 0.12, 2], [1, 1, 0.26, 0.04, 0]]);
    const front = layerOf({ dx, dy }, starsFor(n, rand, 0.05, 0.1), {
      R,
      k: 1.55,
      g: 86,
      life: 2.5,
      pal,
      head: 2.2,
      tail: 0.1,
      spark: { radial: 70, late: 0.014, life: 1.15, fall: 14, grav: 10, spread: 6, pal: a === 'silver' ? SPARKS_SILVER : SPARKS_GOLD, i: 0.92, holes: 0.08 },
    });
    return { flash: 1.2, glow: 0.34, tailI: 1.8, layers: [front, sphereLayer(rand, 40, 0.1, 0.16, { R: R * 0.32, k: 2.2, g: 40, life: 1.5, pal: starColours(a === 'silver' ? 'azure' : 'orange'), head: 1.6, tail: 0.06 })] };
  },
  /** Gold out to the rim, then every star cracks into a white pop. */
  crackle: (rand, R, [a], d) => ({
    flash: 1.05,
    glow: 0.26,
    layers: [
      sphereLayer(rand, count(140, d), 0.09, 0.1, {
        R,
        k: 2.4,
        g: 30,
        life: 2.2,
        pal: starColours(a || 'gold'),
        head: 1.5,
        tail: 0.08,
        spark: { radial: 16, late: 0.07, life: 0.6, fall: 4, spread: 2, pal: SPARKS_GOLD, i: 0.6, holes: 0.2 },
        crackle: { at: 0.42, spread: 0.46, i: 11, reach: 9 },
      }),
    ],
  }),
  /** Stars that hang and blink out of step, a field of silver glitter. */
  strobe: (rand, R, [a], d) => {
    const c = HUE[a === 'gold' ? 'silver' : a || 'silver'];
    return {
      flash: 0.85,
      glow: 0.2,
      layers: [
        sphereLayer(rand, count(190, d), 0.16, 0.14, {
          R,
          k: 2.8,
          g: 40,
          life: 3.9,
          pal: table([[0, 1, 1, 1, 3], [0.1, ...c, 2], [0.85, ...c, 1.7], [1, ...c, 0]]),
          head: 3,
          tail: 0.03,
          strobe: { f0: 3.2, f1: 4.6, duty: 0.3 },
        }),
      ],
    };
  },
  /** A dense crown of gold for the very end, falling almost to the water. */
  kamuro: (rand, R, _h, d) => ({
    flash: 1.3,
    glow: 0.5,
    layers: [
      sphereLayer(rand, count(190, d), 0.09, 0.15, {
        R,
        k: 2.3,
        g: 60,
        life: 6.4,
        pal: WILLOW_GOLD,
        head: 1.4,
        tail: 0.1,
        spark: { radial: 30, late: 0.055, life: 3.4, fall: 5, grav: 1.2, spread: 1.6, pal: SPARKS_GOLD, i: 0.66, holes: 0.08 },
      }),
    ],
  }),
  /** All flash, a white bang and a spit of sparks. */
  salute: (rand, R, _h, d) => ({
    flash: 2.6,
    glow: 0.05,
    white: true,
    noSmoke: true,
    layers: [sphereLayer(rand, count(46, d), 0.3, 0.3, { R: R * 0.36, k: 4.5, g: 20, life: 0.42, pal: table([[0, 1, 1, 1, 6], [0.5, 1, 0.96, 0.82, 2.2], [1, 1, 0.7, 0.3, 0]]), head: 1.8, tail: 0.05 })],
  }),
  /** One comet from a barge, part of a fan. */
  comet: (rand, R, [a], d, o) => ({
    flash: 0.1,
    glow: 0.03,
    noSmoke: true,
    layers: [
      layerOf({ dx: new Float32Array([Math.sin(o.angle)]), dy: new Float32Array([-Math.cos(o.angle)]) }, starsFor(1, rand, 0, 0.05), {
        R,
        k: 0.75,
        g: 70,
        life: 1.7,
        pal: starColours(a || 'gold'),
        head: 1.6,
        tail: 0.06,
        spark: { radial: 0, late: 0.012, life: 0.72, fall: 12, grav: 16, spread: 4.4, pal: a === 'silver' ? SPARKS_SILVER : SPARKS_GOLD, i: 0.86, holes: 0.14 },
      }),
    ],
  }),
};

/** Where stars must go to write the year. Each digit is 76 wide, 118 tall. */
function yearDirs(spacing, width, height, gap) {
  const strokes = {
    2: [
      ...Array.from({ length: 21 }, (_, i) => {
        const a = Math.PI * (1.06 + (i / 20) * 1.2);
        return [0.5 + 0.5 * Math.cos(a), 0.47 + 0.47 * Math.sin(a)];
      }),
      [0, 1],
      [1, 1],
    ],
    0: Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * TAU;
      return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
    }),
    7: [
      [0, 0],
      [1, 0],
      [0.34, 1],
    ],
  };
  const xs = [];
  const ys = [];
  const total = 4 * width + 3 * gap;
  [...'2027'].forEach((digit, index) => {
    const left = -total / 2 + index * (width + gap);
    const line = strokes[digit];
    let carry = 0;
    for (let i = 0; i + 1 < line.length; i += 1) {
      const ax = line[i][0] * width;
      const ay = line[i][1] * height;
      const bx = line[i + 1][0] * width;
      const by = line[i + 1][1] * height;
      const len = Math.hypot(bx - ax, by - ay);
      let at = carry;
      while (at < len) {
        xs.push(left + ax + ((bx - ax) * at) / len);
        ys.push(-height / 2 + ay + ((by - ay) * at) / len);
        at += spacing;
      }
      carry = at - len;
    }
    xs.push(left + line[line.length - 1][0] * width);
    ys.push(-height / 2 + line[line.length - 1][1] * height);
  });
  return { dx: Float32Array.from(xs), dy: Float32Array.from(ys) };
}

/* ── the programme ─────────────────────────────────────────────── */

const BARGES = [118, 286, 470, 652, 842];

function planShow(rand) {
  const plan = [];
  const fire = (at, kind, x, y, size, hues = [], { d = 1, far = false, ...extra } = /** @type {{ d?: number, far?: boolean, angle?: number }} */ ({})) => {
    const R = kind === 'comet' ? size : size * 1.2;
    const shell = KINDS[kind](rand, R, hues, d, extra);
    const lx = BARGES.reduce((best, b) => (Math.abs(b - x) < Math.abs(best - x) ? b : best), BARGES[0]) + (rand() - 0.5) * 12;
    const ly = WATER + 7;
    const height = ly - y;
    const rise = kind === 'comet' ? 0 : 0.86 + (height / 340) * 0.86 + rand() * 0.1;
    const launch = ((at - rise) % PERIOD + PERIOD) % PERIOD;
    const col = shell.white ? [1, 0.97, 0.9] : kind === 'willow' || kind === 'kamuro' || kind === 'palm' ? [1, 0.68, 0.34] : HUE[hues[0] || 'gold'];
    const scale = R / 120;
    plan.push({
      kind,
      launch,
      rise,
      bx: kind === 'comet' ? lx : clamp(x, R * 0.74 + 8, CW - R * 0.74 - 8),
      by: kind === 'comet' ? ly : Math.max(y, R * 0.8 + 10),
      lx,
      ly,
      R,
      seed: Math.floor(rand() * 4096),
      tailI: far ? 0.45 : shell.tailI ?? 0.82 + rand() * 0.3,
      muzzle: far ? 0.3 : 1,
      layers: shell.layers,
      flash: shell.flash * scale * (far ? 0.45 : 1),
      glow: shell.glow * scale * (far ? 0.4 : 1),
      flashR: 26 + 42 * scale,
      smoke: shell.noSmoke ? 0 : 0.5 * scale * (far ? 0.4 : 1),
      col: [mix(col[0], 1, 0.3), mix(col[1], 1, 0.3), mix(col[2], 1, 0.3)],
      end: Math.max(...shell.layers.map((l) => l.end)),
      span: rise + 26,
    });
  };

  const left = () => 70 + rand() * 190;
  const right = () => 712 + rand() * 180;
  const centre = () => 320 + rand() * 320;
  const high = () => 46 + rand() * 74;
  const mid = () => 100 + rand() * 70;
  const low = () => 160 + rand() * 54;
  const pick = (list) => list[Math.floor(rand() * list.length)];

  /** A fan of comets from one barge, one after the other. */
  const fan = (at, barge, n = 7, spread = 0.56, hue = 'gold', R = 230, reverse = false) => {
    for (let i = 0; i < n; i += 1) {
      const k = n > 1 ? i / (n - 1) : 0.5;
      fire(at + (reverse ? n - 1 - i : i) * 0.11, 'comet', BARGES[barge], WATER, R * (0.86 + rand() * 0.22), [hue], { angle: (k * 2 - 1) * spread });
    }
  };

  // Opening, while the last of the previous finale is still coming down.
  fire(0.7, 'peony', 168, 158, 112, ['crimson', 'gold']);
  fire(1.5, 'chrysanthemum', 806, 128, 128, ['azure', 'white']);
  fan(1.9, 2, 7, 0.5);
  fire(2.5, 'ring', 330, 110, 96, ['magenta']);
  fire(3.1, 'chrysanthemum', 112, 104, 106, ['gold', 'crimson'], { d: 0.9 });
  fire(3.7, 'peony', 640, 170, 108, ['emerald', 'lemon']);
  fire(4.5, 'willow', 868, 84, 118);
  fire(5.2, 'palm', 470, 150, 118, ['gold']);
  fire(5.9, 'ring', 742, 186, 92, ['teal', 'violet']);
  fire(6.5, 'peony', 228, 96, 118, ['violet', 'pink']);

  // Pairs across the river.
  for (let i = 0; i < 6; i += 1) {
    const at = 7.2 + i * 1.32;
    const hues = pick([['crimson', 'gold'], ['azure', 'silver'], ['emerald', 'gold'], ['magenta', 'azure'], ['violet', 'lemon'], ['orange', 'teal']]);
    const kind = pick(['peony', 'chrysanthemum', 'ring', 'peony', 'chrysanthemum']);
    const y = mid() - 30;
    fire(at, kind, left(), y, 88 + rand() * 30, hues, { d: 0.82 });
    fire(at + 0.08, kind, right(), y + rand() * 30 - 15, 88 + rand() * 30, hues, { d: 0.82 });
    if (i % 2) fire(at + 0.62, pick(['crackle', 'strobe']), centre(), low(), 72 + rand() * 22, ['gold'], { d: 0.8 });
  }
  fan(8.6, 0, 6, 0.46, 'silver');
  fan(11.2, 4, 6, 0.46, 'silver', 230, true);
  fire(12.8, 'willow', 196, 92, 124);
  fire(13.3, 'palm', 742, 118, 124, ['silver']);

  // It starts to build.
  const build1 = [['crimson', 'white'], ['gold', 'azure'], ['violet', 'gold'], ['teal', 'pink'], ['emerald', 'silver']];
  for (let i = 0; i < 10; i += 1) {
    const at = 15.4 + i * 0.68;
    const side = i % 3 === 0 ? left() : i % 3 === 1 ? right() : centre();
    const kind = pick(['chrysanthemum', 'chrysanthemum', 'peony', 'crackle', 'ring', 'palm', 'strobe']);
    fire(at, kind, side, pick([high, mid])(), 92 + rand() * 40, pick(build1), { d: 0.8 });
  }
  fan(17, 1, 6, 0.4);
  fan(19.6, 3, 6, 0.4);

  // The year, high in the middle, with the sky held quiet around it.
  const stars = yearDirs(5.2, 74, 112, 26);
  {
    const n = stars.dx.length;
    const k = 3.1;
    const layer = layerOf(stars, starsFor(n, rand, 0, 0.08), {
      k,
      v: k,
      g: 5,
      life: 4.3,
      pal: table([[0, 1, 1, 0.94, 5], [0.05, 1, 0.92, 0.62, 3.2], [0.5, 1, 0.76, 0.3, 2.6], [0.8, 1, 0.5, 0.12, 1.5], [1, 1, 0.26, 0.04, 0]]),
      head: 2.1,
      tail: 0.06,
      sag: { at: 2.6, g: 26 },
      spark: { radial: 8, late: 0.05, life: 0.9, fall: 10, grav: 6, spread: 1.6, i: 0.5, holes: 0.25, pal: SPARKS_GOLD },
    });
    const rise = 1.4;
    plan.push({ kind: 'year', launch: 24.6 - rise, rise, bx: 480, by: 126, lx: 470, ly: WATER + 7, R: 190, seed: 7, tailI: 1.4, muzzle: 1, layers: [layer], flash: 1.1, glow: 0.5, flashR: 90, smoke: 0.3, col: [1, 0.82, 0.55], end: layer.end, span: rise + 26 });
  }
  // Low colour on the margins while the year hangs: nothing crosses it.
  fire(24.1, 'peony', 118, 232, 60, ['crimson', 'gold'], { d: 0.5 });
  fire(25.1, 'peony', 852, 228, 62, ['azure', 'white'], { d: 0.5 });
  fan(25.6, 0, 5, 0.3, 'gold', 190);
  fan(25.9, 4, 5, 0.3, 'gold', 190, true);
  fire(26.6, 'ring', 100, 150, 58, ['magenta'], { d: 0.5 });
  fire(27.3, 'ring', 868, 150, 58, ['teal'], { d: 0.5 });
  fan(27.9, 1, 5, 0.3, 'silver', 170);
  fan(28.2, 3, 5, 0.3, 'silver', 170, true);

  // The long climb: layers of everything.
  const build2 = [['magenta', 'gold'], ['azure', 'white'], ['crimson', 'lemon'], ['emerald', 'pink'], ['violet', 'teal'], ['orange', 'azure'], ['gold', 'crimson']];
  for (let i = 0; i < 30; i += 1) {
    const at = 29 + i * (i < 15 ? 0.56 : 0.42);
    const side = [left, right, centre, right, left][i % 5]();
    const kind = pick(['chrysanthemum', 'chrysanthemum', 'peony', 'peony', 'ring', 'crackle', 'palm', 'strobe', 'willow']);
    fire(at, kind, side, pick([high, mid, low])(), 84 + rand() * 54, pick(build2), { d: 0.72 });
  }
  fan(33.5, 2, 7, 0.55);
  fan(36.2, 0, 6, 0.45, 'silver');
  fan(38, 4, 6, 0.45, 'silver');
  fan(40.3, 1, 7, 0.5);
  fan(40.8, 3, 7, 0.5, 'gold', 230, true);

  // The finale: faster and faster, ending in a wall of gold.
  let at = 44.4;
  let gap = 0.34;
  while (at < 52) {
    const side = pick([left, right, centre])();
    const kind = rand() < 0.2 ? 'salute' : pick(['chrysanthemum', 'chrysanthemum', 'peony', 'crackle', 'palm', 'ring']);
    fire(at, kind, side, pick([high, mid, low])(), 96 + rand() * 60, pick(build2), { d: kind === 'salute' ? 1 : 0.56 });
    at += gap;
    gap = Math.max(0.1, gap * 0.965);
  }
  fan(47, 0, 6, 0.5, 'gold');
  fan(47.2, 4, 6, 0.5, 'gold', 230, true);
  fan(49.2, 1, 6, 0.5, 'silver');
  fan(49.3, 3, 6, 0.5, 'silver', 230, true);
  for (let i = 0; i < 7; i += 1) fire(51.8 + i * 0.1, 'kamuro', 90 + i * 130 + rand() * 30, 60 + rand() * 46, 118 + rand() * 30, [], { d: 0.74 });
  for (let i = 0; i < 5; i += 1) fire(52 + i * 0.13, 'salute', 150 + rand() * 660, 80 + rand() * 120, 110, [], {});

  return plan;
}

/* ── painting the place ────────────────────────────────────────── */

function paintSky(rand) {
  const rows = WATER + 10;
  const buf = new Float32Array(CW * rows * 3);
  const wisp = noise2(3101, 64);
  const STOPS = [
    [0, 3, 5, 15],
    [0.34, 6, 9, 26],
    [0.6, 10, 14, 38],
    [0.8, 20, 22, 52],
    [0.93, 40, 32, 60],
    [1, 70, 46, 62],
  ];
  const dome = new Float32Array(CW);
  for (let x = 0; x < CW; x += 1) dome[x] = 0.42 + 0.5 * bump(x, 130, 120) + 0.66 * bump(x, 440, 150) + 0.5 * bump(x, 868, 110);
  for (let y = 0; y < rows; y += 1) {
    const h = clamp(y / WATER);
    let k = 0;
    while (k < STOPS.length - 2 && STOPS[k + 1][0] <= h) k += 1;
    const a = STOPS[k];
    const b = STOPS[k + 1];
    const f = smooth(clamp((h - a[0]) / (b[0] - a[0])));
    const low = Math.exp(-(WATER - y) / 58);
    const wide = Math.exp(-(WATER - y) / 170);
    for (let x = 0; x < CW; x += 1) {
      const n = smooth(clamp((fbm2(wisp, x / 96, y / 22, 4) - 0.46) / 0.32));
      const j = (y * CW + x) * 3;
      const d = dome[x];
      buf[j] = mix(a[1], b[1], f) * (0.8 + 0.2 * d) + low * d * 46 + n * (1 + wide * 7 * d);
      buf[j + 1] = mix(a[2], b[2], f) * (0.8 + 0.2 * d) + low * d * 24 + n * (1 + wide * 4.5 * d);
      buf[j + 2] = mix(a[3], b[3], f) * (0.82 + 0.18 * d) + low * d * 14 + n * (1.8 + wide * 6 * d);
    }
  }
  // Stars: a few that catch the eye, many more nearly lost in the city's light.
  for (let i = 0; i < 780; i += 1) {
    const x = rand() * (CW - 2);
    const y = rand() * rand() * (WATER - 90);
    const fade = (1 - y / (WATER - 60)) ** 1.5;
    const mag = rand() ** 3.2 * 150 * fade + 7 * fade;
    const tone = rand();
    const [r, g, b] = tone < 0.2 ? [1, 0.88, 0.7] : tone < 0.5 ? [0.76, 0.86, 1] : [1, 1, 1];
    const ix = x | 0;
    const iy = y | 0;
    const fx = x - ix;
    const fy = y - iy;
    const put = (px, py, w) => {
      const j = (py * CW + px) * 3;
      buf[j] += r * mag * w;
      buf[j + 1] += g * mag * w;
      buf[j + 2] += b * mag * w;
    };
    put(ix, iy, (1 - fx) * (1 - fy));
    put(ix + 1, iy, fx * (1 - fy));
    put(ix, iy + 1, (1 - fx) * fy);
    put(ix + 1, iy + 1, fx * fy);
  }
  const art = new Art(CW, CH);
  art.px.fill(BLACK);
  // A little noise, because a dark gradient in 8 bits would otherwise show its steps.
  for (let i = 0, n = CW * rows; i < n; i += 1) {
    const j = i * 3;
    const d = rand() - rand();
    art.px[i] = pack((buf[j] + d) | 0, (buf[j + 1] + d) | 0, (buf[j + 2] + d) | 0);
  }
  return art.canvas();
}

const WINDOW_WARM = [[255, 198, 122], [255, 216, 156], [255, 182, 98], [255, 228, 182]];
const WINDOW_COOL = [[198, 224, 255], [228, 240, 255], [176, 232, 226]];

function paintCity(rand) {
  const city = new Art(CW, WATER + 6);
  const lit = new Art(CW, CH);
  lit.px.fill(BLACK);
  const lights = [];
  const twinkles = [];
  const beacons = [];

  const LAYERS = [
    { base: [27, 27, 50], haze: [50, 40, 62], fade: 0.9, reach: 120, lit: 17, fx: 3, fy: 3, ww: 1, wh: 1, dim: 0.36 },
    { base: [15, 16, 34], haze: [33, 28, 44], fade: 0.72, reach: 96, lit: 32, fx: 3, fy: 4, ww: 1, wh: 1, dim: 0.62 },
    { base: [7, 8, 20], haze: [16, 15, 26], fade: 0.5, reach: 56, lit: 44, fx: 4, fy: 4, ww: 1, wh: 2, dim: 0.82 },
  ];

  const windows = (layer, x0, w, top, bottom, face, density) => {
    const warm = rand() < 0.7;
    const set = warm ? WINDOW_WARM : WINDOW_COOL;
    for (let y = top + 2; y < bottom - 1; y += layer.fy) {
      const band = rand();
      const floor = band < 0.09 ? 2.6 : band < 0.3 ? 0.1 : 1;
      for (let x = x0 + 1; x < x0 + w - layer.ww; x += layer.fx) {
        const onSide = x - x0 >= face;
        if (rand() > density * floor * (onSide ? 0.45 : 1)) {
          for (let dy = 0; dy < layer.wh; dy += 1) for (let dx = 0; dx < layer.ww; dx += 1) lit.put(x + dx, y + dy, pack(layer.lit * 0.42, layer.lit * 0.42, layer.lit * 0.48));
          continue;
        }
        const c = rand() < 0.1 ? (warm ? WINDOW_COOL : WINDOW_WARM)[Math.floor(rand() * 3)] : set[Math.floor(rand() * set.length)];
        const i = layer.dim * (0.3 + rand() * rand() * 0.7);
        if (rand() < 0.05) {
          twinkles.push({ x, y, w: layer.ww, h: layer.wh, c, i, n: 2 + Math.floor(rand() * 30), phase: rand(), edge: rand() * 0.5 - 0.05 });
          continue;
        }
        const col = pack(c[0] * i + 8, c[1] * i + 8, c[2] * i + 10);
        for (let dy = 0; dy < layer.wh; dy += 1) for (let dx = 0; dx < layer.ww; dx += 1) city.put(x + dx, y + dy, col);
        lights.push(x, y, (c[0] * i) / 255, (c[1] * i) / 255, (c[2] * i) / 255, 0);
      }
    }
  };

  const block = (layer, x0, w, top, bottom, density = 0.2, faceAt = 0.62 + rand() * 0.22) => {
    const face = Math.round(w * faceAt);
    const hazeTop = WATER - layer.reach;
    for (let y = Math.max(0, top); y < bottom; y += 1) {
      const fog = clamp((y - hazeTop) / layer.reach) ** 2 * layer.fade;
      for (let x = x0; x < x0 + w; x += 1) {
        const side = x - x0 >= face;
        const tone = side ? 0.7 : 1;
        city.put(x, y, pack(mix(layer.base[0] * tone, layer.haze[0], fog) | 0, mix(layer.base[1] * tone, layer.haze[1], fog) | 0, mix(layer.base[2] * tone, layer.haze[2], fog) | 0));
        let a = layer.lit * (side ? 0.42 : 0.9);
        if (y - top < 2) a *= 2;
        if (x === x0 || x === x0 + face - 1) a *= 1.3;
        lit.put(x, y, pack(a, a * 1.02, a * 1.14));
      }
    }
    windows(layer, x0, w, top, bottom, face, density);
  };

  /** A whole tower: setbacks, and something on top. */
  const tower = (layer, x, w, top, style, density) => {
    const bottom = WATER;
    if (style === 'stepped') {
      const mid1 = top + Math.round((bottom - top) * 0.2);
      const mid2 = top + Math.round((bottom - top) * 0.44);
      block(layer, x, w, mid2, bottom, density);
      block(layer, x + Math.round(w * 0.12), Math.round(w * 0.76), mid1, mid2, density);
      block(layer, x + Math.round(w * 0.27), Math.round(w * 0.46), top, mid1, density * 1.1);
    } else if (style === 'spire') {
      const mid1 = top + Math.round((bottom - top) * 0.14);
      block(layer, x, w, mid1, bottom, density);
      block(layer, x + Math.round(w * 0.2), Math.round(w * 0.6), top, mid1, density);
      const cx = x + (w >> 1);
      const spire = 14 + Math.floor(rand() * 20);
      for (let y = top - spire; y < top; y += 1) {
        const wide = (y - (top - spire)) / spire < 0.55 ? 1 : 2;
        for (let dx = 0; dx < wide; dx += 1) {
          city.put(cx + dx, y, pack(layer.base[0], layer.base[1], layer.base[2]));
          lit.put(cx + dx, y, pack(layer.lit, layer.lit, layer.lit * 1.1));
        }
      }
      beacons.push({ x: cx, y: top - spire, n: 18 + Math.floor(rand() * 16), phase: rand() });
    } else if (style === 'slant') {
      const drop = Math.round(w * 0.8);
      const dir = rand() < 0.5;
      for (let i = 0; i < w; i += 1) {
        const k = dir ? i / w : 1 - i / w;
        block(layer, x + i, 1, top + Math.round(k * drop), top + drop + 1, 0, 2);
      }
      block(layer, x, w, top + drop, bottom, density);
      const col = rand() < 0.5 ? [120, 200, 240] : [240, 170, 200];
      for (let i = 0; i < w; i += 1) {
        const k = dir ? i / w : 1 - i / w;
        city.put(x + i, top + Math.round(k * drop), pack(col[0] * 0.32, col[1] * 0.32, col[2] * 0.36));
      }
    } else if (style === 'crown') {
      block(layer, x, w, top + 6, bottom, density);
      block(layer, x + 2, w - 4, top, top + 6, 0);
      const col = [[230, 110, 170], [110, 200, 240], [240, 190, 110], [150, 130, 240]][Math.floor(rand() * 4)];
      for (let i = x + 3; i < x + w - 3; i += 1) {
        city.put(i, top + 2, pack(col[0] * 0.56, col[1] * 0.56, col[2] * 0.56));
        if (i % 3) city.put(i, top + 4, pack(col[0] * 0.3, col[1] * 0.3, col[2] * 0.3));
      }
      lights.push(x + (w >> 1), top + 3, (col[0] / 255) * 1.1, (col[1] / 255) * 1.1, (col[2] / 255) * 1.1, 1);
      beacons.push({ x: x + (w >> 1), y: top - 1, n: 22, phase: rand() });
    } else if (style === 'dome') {
      block(layer, x, w, top + Math.round(w * 0.4), bottom, density);
      const r = w * 0.42;
      const cx = x + w / 2;
      const cy = top + w * 0.4;
      for (let y = Math.floor(cy - r); y <= cy; y += 1) {
        for (let i = Math.floor(cx - r); i <= cx + r; i += 1) {
          if ((i - cx) ** 2 + (y - cy) ** 2 <= r * r) {
            city.put(i, y, pack(layer.base[0], layer.base[1], layer.base[2]));
            const a = layer.lit * (0.9 - ((i - cx) / r) * 0.5);
            lit.put(i, y, pack(a, a, a * 1.1));
          }
        }
      }
    } else {
      block(layer, x, w, top, bottom, density);
      if (rand() < 0.7) block(layer, x + 2 + Math.floor(rand() * Math.max(1, w - 8)), 3 + Math.floor(rand() * 5), top - 2 - Math.floor(rand() * 4), top, 0, 2);
    }
  };

  const envelope = (x) => 16 + 86 * bump(x, 134, 92) + 108 * bump(x, 436, 112) + 92 * bump(x, 866, 84) + 14 * bump(x, 650, 90);

  // Far: the whole city in the haze. Mid: the same, darker, with gaps. Near: the waterfront.
  LAYERS.forEach((layer, index) => {
    let x = -8 + Math.floor(rand() * 10);
    const lo = [9, 11, 14][index];
    const hi = [20, 24, 32][index];
    const scale = [1, 0.74, 0.24][index];
    while (x < CW + 10) {
      const w = lo + Math.floor(rand() * (hi - lo));
      const top = Math.round(WATER - 12 - envelope(x + w / 2) * scale * (0.5 + rand() * 0.62));
      const pickStyle = rand();
      const tall = WATER - top > 74;
      const style = index === 2 ? 'plain' : tall && pickStyle < 0.14 ? 'spire' : tall && pickStyle < 0.32 ? 'stepped' : tall && pickStyle < 0.44 ? 'slant' : 'plain';
      tower(layer, x, w, top, style, 0.1 + rand() * 0.2);
      x += w + (rand() < 0.2 ? 2 + Math.floor(rand() * 6) : 0);
    }
    // Set pieces, so each district has something to look at.
    if (index === 1) {
      tower(layer, 122, 20, 226, 'spire', 0.24);
      tower(layer, 100, 18, 262, 'slant', 0.2);
      tower(layer, 150, 18, 268, 'crown', 0.24);
      tower(layer, 448, 24, 208, 'stepped', 0.26);
      tower(layer, 424, 18, 254, 'crown', 0.2);
      tower(layer, 482, 18, 244, 'slant', 0.22);
      tower(layer, 868, 22, 224, 'spire', 0.24);
      tower(layer, 846, 18, 264, 'crown', 0.22);
      tower(layer, 896, 18, 270, 'stepped', 0.22);
    }
    if (index === 2) tower(layer, 300, 38, WATER - 44, 'dome', 0.16);
  });

  // The waterfront: a line of trees and lamps, and the bank's wall.
  const leaf = noise2(3201, 64);
  for (let x = 0; x < CW; x += 1) {
    const top = WATER - 5 - Math.round(fbm2(leaf, x / 8, 3, 3) ** 2 * 26);
    for (let y = top; y < WATER - 2; y += 1) {
      const fog = clamp((y - top) / 14) * 0.5;
      city.put(x, y, pack(mix(6, 18, fog) | 0, mix(8, 16, fog) | 0, mix(15, 26, fog) | 0));
      lit.put(x, y, pack(16, 24, 18));
    }
    for (let y = WATER - 3; y < WATER + 6; y += 1) {
      city.put(x, y, pack(5, 6, 14));
      lit.put(x, y, y === WATER - 3 ? pack(70, 68, 76) : pack(18, 18, 22));
    }
  }
  for (let x = 6 + rand() * 10; x < CW; x += 24 + rand() * 20) {
    const lx = Math.round(x);
    const c = rand() < 0.82 ? [255, 206, 136] : [206, 226, 255];
    for (let y = WATER - 9; y < WATER - 3; y += 1) city.put(lx, y, pack(10, 10, 18));
    city.put(lx, WATER - 10, pack(c[0] * 0.95, c[1] * 0.95, c[2] * 0.95));
    lights.push(lx, WATER - 10, (c[0] / 255) * 1.3, (c[1] / 255) * 1.3, (c[2] / 255) * 1.3, 1);
  }

  const canvas = city.canvas();
  const g = canvas.getContext('2d');

  // A cable-stayed bridge in the gap between the districts.
  const deck = WATER - 22;
  const bridge = { from: 566, to: 752, y: deck };
  g.lineCap = 'round';
  for (const px of [614, 704]) {
    g.fillStyle = 'rgb(17,17,36)';
    g.fillRect(px - 1.5, deck - 48, 1.5, 70);
    g.fillRect(px + 2.5, deck - 48, 1.5, 70);
    g.fillRect(px - 1.5, deck - 36, 5.5, 1.2);
    g.fillRect(px - 1.5, deck - 18, 5.5, 1.2);
    for (let i = 1; i <= 8; i += 1) {
      for (const side of [-1, 1]) {
        g.strokeStyle = 'rgba(110,110,150,0.22)';
        g.lineWidth = 0.5;
        g.beginPath();
        g.moveTo(px + 1, deck - 47 + i * 2);
        g.lineTo(px + 1 + side * i * 5.4, deck);
        g.stroke();
      }
    }
    for (let y = deck - 46; y < deck; y += 8) {
      lights.push(px - 1, y, 0.3, 0.34, 0.44, 0);
      g.fillStyle = 'rgb(150,166,205)';
      g.fillRect(px - 1, y, 1, 1);
      g.fillRect(px + 3, y, 1, 1);
    }
    beacons.push({ x: px + 1, y: deck - 50, n: 26, phase: rand() });
  }
  g.fillStyle = 'rgb(13,13,28)';
  g.fillRect(bridge.from, deck, bridge.to - bridge.from, 2);
  g.fillStyle = 'rgb(226,190,130)';
  for (let x = bridge.from + 3; x < bridge.to; x += 6) {
    g.fillRect(x, deck - 1, 1, 1);
    lights.push(x, deck - 1, 0.5, 0.38, 0.22, 0);
  }
  for (const px of [586, 660, 736]) {
    g.fillStyle = 'rgb(13,13,28)';
    g.fillRect(px, deck + 2, 2, WATER - deck - 2);
  }
  for (let i = bridge.from; i < bridge.to; i += 1) {
    lit.put(i, deck, pack(70, 70, 80));
    lit.put(i, deck + 1, pack(36, 36, 42));
  }

  // Everything lit breathes a little into the air around it.
  const glowCells = new Float32Array(LW * LH * 3);
  for (let i = 0; i < lights.length; i += 6) {
    const c = ((lights[i + 1] >> 2) * LW + (lights[i] >> 2)) * 3;
    if (c < 0 || c >= glowCells.length) continue;
    glowCells[c] += lights[i + 2];
    glowCells[c + 1] += lights[i + 3];
    glowCells[c + 2] += lights[i + 4];
  }
  for (let p = 0; p < 3; p += 1) blur(glowCells, LW, LH, 2);
  const glow = new Art(LW, LH);
  for (let i = 0, n = LW * LH; i < n; i += 1) {
    const j = i * 3;
    const r = glowCells[j] * 14;
    const gg = glowCells[j + 1] * 13;
    const b = glowCells[j + 2] * 12;
    const a = Math.max(r, gg, b, 0.001);
    glow.px[i] = pack((r / a) * 255, (gg / a) * 255, (b / a) * 255, Math.min(255, a));
  }
  g.imageSmoothingEnabled = true;
  g.globalCompositeOperation = 'lighter';
  g.drawImage(glow.canvas(), 0, 0, LW, LH, 0, 0, FW, FH);
  g.globalCompositeOperation = 'source-over';

  return { canvas, lit, lights, twinkles, beacons, bridge };
}

/** Separable box blur in place on an interleaved RGB array. */
function blur(a, w, h, radius) {
  const div = 1 / (radius * 2 + 1);
  for (let y = 0; y < h; y += 1) {
    const row = y * w * 3;
    for (let ch = 0; ch < 3; ch += 1) {
      let sum = a[row + ch] * (radius + 1);
      for (let i = 1; i <= radius; i += 1) sum += a[row + Math.min(i, w - 1) * 3 + ch];
      for (let x = 0; x < w; x += 1) {
        SCRATCH[x] = sum * div;
        sum += a[row + Math.min(x + radius + 1, w - 1) * 3 + ch] - a[row + Math.max(x - radius, 0) * 3 + ch];
      }
      for (let x = 0; x < w; x += 1) a[row + x * 3 + ch] = SCRATCH[x];
    }
  }
  for (let x = 0; x < w; x += 1) {
    const col = x * 3;
    for (let ch = 0; ch < 3; ch += 1) {
      let sum = a[col + ch] * (radius + 1);
      for (let i = 1; i <= radius; i += 1) sum += a[col + Math.min(i, h - 1) * w * 3 + ch];
      for (let y = 0; y < h; y += 1) {
        SCRATCH[y] = sum * div;
        sum += a[col + Math.min(y + radius + 1, h - 1) * w * 3 + ch] - a[col + Math.max(y - radius, 0) * w * 3 + ch];
      }
      for (let y = 0; y < h; y += 1) a[col + y * w * 3 + ch] = SCRATCH[y];
    }
  }
}

function paintRiver(rand, lights) {
  const h = CH - WATER;
  const art = new Art(CW, h);
  const STOPS = [
    [0, 24, 21, 38],
    [0.08, 15, 16, 33],
    [0.3, 8, 11, 25],
    [0.62, 5, 8, 18],
    [1, 2, 4, 10],
  ];
  const streaks = noise2(3301, 64);
  for (let y = 0; y < h; y += 1) {
    const k = clamp(y / (WALL - WATER));
    let s = 0;
    while (s < STOPS.length - 2 && STOPS[s + 1][0] <= k) s += 1;
    const a = STOPS[s];
    const b = STOPS[s + 1];
    const f = (k - a[0]) / (b[0] - a[0]);
    for (let x = 0; x < CW; x += 1) {
      const n = (fbm2(streaks, x / (30 - k * 12), y / 1.5, 2) - 0.5) * (1.4 + k * 3);
      const d = rand() - rand();
      art.px[y * CW + x] = pack((mix(a[1], b[1], f) + n + d) | 0, (mix(a[2], b[2], f) + n + d) | 0, (mix(a[3], b[3], f) + n * 1.3 + d) | 0);
    }
  }
  // The barges the shells go up from: dark, low, a work lamp on each.
  for (const x of BARGES) {
    for (let dy = 0; dy < 3; dy += 1) art.rect(x - 15 + dy, 8 + dy, 30 - dy * 2, 1, pack(4, 5, 11));
    art.rect(x - 6, 6, 12, 2, pack(6, 7, 14));
    art.put(x - 13, 7, pack(235, 170, 100));
    art.put(x + 13, 7, pack(235, 110, 84));
    lights.push(x - 13, WATER + 6, 0.5, 0.36, 0.2, 1);
    lights.push(x + 13, WATER + 6, 0.5, 0.24, 0.18, 1);
  }

  // The city's lights drawn out on the water, baked; a frame shakes them.
  const C = new Float32Array(RW * RH * 3);
  for (let i = 0; i < lights.length; i += 6) {
    const x = lights[i] >> 1;
    if (x < 0 || x >= RW) continue;
    const near = lights[i + 5];
    const m0 = Math.max(0, (WATER - lights[i + 1]) * 0.34);
    const len = near ? 56 + rand() * 44 : 14 + rand() * 34;
    const strength = near ? 0.2 : 0.075;
    for (let r = Math.floor(m0), n = Math.min(RH, m0 + len); r < n; r += 1) {
      const q = (r - m0) / len;
      const w = strength * (1 - q) * (1 - q);
      const j = (r * RW + x) * 3;
      C[j] += lights[i + 2] * w;
      C[j + 1] += lights[i + 3] * w;
      C[j + 2] += lights[i + 4] * w;
    }
  }
  // Wider the nearer it gets.
  for (let r = 0; r < RH; r += 1) {
    const passes = 1 + Math.floor((r / RH) * 3);
    const row = r * RW * 3;
    for (let p = 0; p < passes; p += 1) {
      for (let ch = 0; ch < 3; ch += 1) {
        let prev = C[row + ch];
        for (let x = 1; x < RW - 1; x += 1) {
          const j = row + x * 3 + ch;
          const cur = C[j];
          C[j] = 0.25 * prev + 0.5 * cur + 0.25 * C[j + 3];
          prev = cur;
        }
      }
    }
  }

  // Ripples: a tile of soft noise, read at a different scale on each row to give perspective.
  const a = noise2(3302, 64);
  const b = noise2(3303, 64);
  const tile = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y += 1) {
    for (let x = 0; x < TW; x += 1) {
      tile[y * TW + x] = fbm2(a, x / 8, y / 4, 3) * 0.66 + fbm2(b, x / 4, y / 2, 2) * 0.34;
    }
  }
  const rowDu = new Float32Array(RH);
  const rowV = new Float32Array(RH);
  const rowAX = new Float32Array(RH);
  const rowAY = new Float32Array(RH);
  const rowMirror = new Float32Array(RH);
  const rowGain = new Float32Array(RH);
  for (let r = 0; r < RH; r += 1) {
    const k = r / (RH - 1);
    const z = 1 / (0.1 + k);
    rowDu[r] = 0.1 + z * 0.2;
    rowV[r] = z * 150;
    rowAX[r] = 2 + k * 22;
    rowAY[r] = 60 + k * 360;
    rowMirror[r] = WATER - r * (1.2 + k * 2.8);
    rowGain[r] = mix(1, 0.6, k);
  }
  return { canvas: art.canvas(), C, tile, rowDu, rowV, rowAX, rowAY, rowMirror, rowGain };
}

/* ── the crowd ─────────────────────────────────────────────────── */

function figure(c, p, bottom) {
  const { x, y, s } = p;
  const sw = s * p.sw;
  const neck = y + s * 0.9;
  const sh = y + s * 1.34;
  c.beginPath();
  c.moveTo(x - s * 0.36, y + s * 0.5);
  c.lineTo(x - s * 0.4, neck);
  c.bezierCurveTo(x - s * 0.72, neck + s * 0.14, x - sw * 0.86, neck + s * 0.16, x - sw, sh + s * 0.36);
  c.bezierCurveTo(x - sw * 1.08, sh + s * 1.2, x - sw * 1.06, sh + s * 3, x - sw, bottom);
  c.lineTo(x + sw, bottom);
  c.bezierCurveTo(x + sw * 1.06, sh + s * 3, x + sw * 1.08, sh + s * 1.2, x + sw, sh + s * 0.36);
  c.bezierCurveTo(x + sw * 0.86, neck + s * 0.16, x + s * 0.72, neck + s * 0.14, x + s * 0.4, neck);
  c.lineTo(x + s * 0.36, y + s * 0.5);
  c.closePath();
  c.fill();
  c.beginPath();
  c.ellipse(x, y, s * 0.82, s, p.tilt, 0, TAU);
  c.fill();
  switch (p.top) {
    case 'long':
      c.beginPath();
      c.ellipse(x, y + s * 0.5, s * 0.98, s * 1.4, 0, 0, TAU);
      c.fill();
      break;
    case 'bun':
      c.beginPath();
      c.arc(x + s * 0.1, y - s * 1.08, s * 0.42, 0, TAU);
      c.fill();
      break;
    case 'tail':
      c.beginPath();
      c.ellipse(x + s * p.side * 0.82, y + s * 0.4, s * 0.34, s * 1, p.side * 0.25, 0, TAU);
      c.fill();
      break;
    case 'beanie':
      c.beginPath();
      c.ellipse(x, y - s * 0.3, s * 0.94, s * 0.86, 0, 0, TAU);
      c.fill();
      c.beginPath();
      c.arc(x, y - s * 1.28, s * 0.3, 0, TAU);
      c.fill();
      break;
    case 'cap':
      c.beginPath();
      c.ellipse(x, y - s * 0.46, s * 0.92, s * 0.62, 0, 0, TAU);
      c.fill();
      c.beginPath();
      c.ellipse(x + s * p.side * 0.92, y - s * 0.34, s * 0.62, s * 0.14, p.side * 0.12, 0, TAU);
      c.fill();
      break;
    case 'hood':
      c.beginPath();
      c.ellipse(x, y + s * 0.3, s * 1.2, s * 1.34, 0, 0, TAU);
      c.fill();
      break;
    case 'hat':
      c.beginPath();
      c.ellipse(x, y - s * 0.56, s * 1.42, s * 0.24, 0, 0, TAU);
      c.fill();
      c.beginPath();
      c.ellipse(x, y - s * 0.9, s * 0.74, s * 0.6, 0, 0, TAU);
      c.fill();
      break;
    default:
      c.beginPath();
      c.ellipse(x, y - s * 0.24, s * 0.88, s * 0.84, 0, 0, TAU);
      c.fill();
  }
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const arm of p.arms) drawArm(c, arm);
}

function drawArm(c, a) {
  c.lineWidth = a.w;
  c.beginPath();
  c.moveTo(a.sx, a.sy);
  c.quadraticCurveTo(a.ex, a.ey, a.hx, a.hy);
  c.stroke();
  const r = a.w * 0.62;
  c.beginPath();
  c.arc(a.hx, a.hy, r, 0, TAU);
  c.fill();
  if (a.item === 'fingers') {
    c.lineWidth = a.w * 0.26;
    for (const spread of [-0.34, 0.34]) {
      c.beginPath();
      c.moveTo(a.hx, a.hy);
      c.lineTo(a.hx + spread * r * 2.1, a.hy - r * 2.5);
      c.stroke();
    }
  }
  if (a.item === 'phone') {
    const w = a.w * 1.5;
    const h = a.w * 2.5;
    c.fillRect(a.hx - w / 2, a.hy - h * 0.92, w, h);
  }
}

function paintCrowd(rand, lit) {
  const canvas = newCanvas(CW, CH);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const mask = newCanvas(CW, CH);
  const m = mask.getContext('2d', { willReadFrequently: true });
  const fill = newCanvas(CW, CH);
  const f = fill.getContext('2d', { willReadFrequently: true });

  // The embankment: a parapet and a railing, behind everyone.
  const wallTop = WALL - 2;
  const wall = g.createLinearGradient(0, wallTop, 0, CH);
  wall.addColorStop(0, '#0c0d17');
  wall.addColorStop(0.2, '#05060c');
  wall.addColorStop(1, '#020205');
  g.fillStyle = wall;
  g.fillRect(0, wallTop, CW, CH - wallTop);
  g.fillStyle = '#14151f';
  g.fillRect(0, wallTop, CW, 1);
  for (let x = 0; x < CW; x += 1) {
    lit.put(x, wallTop, pack(110, 108, 116));
    lit.put(x, wallTop + 1, pack(50, 50, 56));
    for (let y = wallTop + 2; y < CH; y += 1) lit.put(x, y, pack(8, 8, 10));
  }
  g.fillStyle = '#080911';
  g.fillRect(0, wallTop - 15, CW, 1.4);
  g.fillRect(0, wallTop - 8, CW, 0.9);
  for (let x = 8; x < CW; x += 37) g.fillRect(x, wallTop - 16, 1.5, 17);
  for (let x = 0; x < CW; x += 1) {
    lit.put(x, wallTop - 15, pack(90, 88, 96));
    lit.put(x, wallTop - 8, pack(50, 50, 56));
  }
  // Lamp standards along the walk, their globes warm.
  const lamps = [[52, 412], [268, 418], [716, 416], [908, 410]];
  for (const [x, top] of lamps) {
    g.fillStyle = '#04050b';
    g.fillRect(x - 1.1, top + 4, 2.2, WALL - top);
    g.fillRect(x - 2.5, top + 20, 5, 1.5);
    g.fillRect(x - 3, WALL - 12, 6, 12);
    g.fillStyle = '#ffdf9e';
    g.beginPath();
    g.arc(x, top, 3.8, 0, TAU);
    g.fill();
    g.fillStyle = '#fff4d6';
    g.beginPath();
    g.arc(x, top, 2.2, 0, TAU);
    g.fill();
    for (let y = top + 5; y < WALL; y += 1) lit.put(x - 1, y, pack(90, 88, 90));
  }

  const ROWS = [
    { y: 458, s: 5.4, step: 11, tone: '#0d0e1a', rim: 20, arm: 0.1, light: 110 },
    { y: 473, s: 7.4, step: 15.5, tone: '#070812', rim: 12, arm: 0.15, light: 84 },
    { y: 497, s: 10.5, step: 25, tone: '#03040a', rim: 0, arm: 0.17, light: 50 },
    { y: 524, s: 15.5, step: 46, tone: '#010205', rim: 0, arm: 0.16, light: 30, margins: true },
  ];
  const TOPS = ['hair', 'hair', 'hair', 'long', 'bun', 'tail', 'beanie', 'beanie', 'cap', 'hood', 'hat'];
  const CLOTH = [[120, 40, 44], [40, 60, 110], [50, 80, 70], [110, 90, 50], [70, 50, 100], [90, 92, 100], [130, 70, 40]];
  const phones = [];
  const sparklers = [];
  const movers = [];

  ROWS.forEach((row, index) => {
    const people = [];
    let x = -6 + rand() * 8;
    while (x < CW + 8) {
      if (row.margins && x > 220 && x < 740) {
        x += row.step;
        continue;
      }
      const s = row.s * (0.8 + rand() * 0.42);
      const side = rand() < 0.5 ? -1 : 1;
      const p = {
        x,
        y: row.y + (rand() - 0.5) * row.s * 1.7,
        s,
        sw: 1.65 + rand() * 0.65,
        tilt: (rand() - 0.5) * 0.36,
        top: TOPS[Math.floor(rand() * TOPS.length)],
        side,
        arms: [],
        cloth: CLOTH[Math.floor(rand() * CLOTH.length)],
      };
      const neck = p.y + s * 1.34;
      const shoulder = (sgn) => [x + sgn * s * p.sw * 0.84, neck + s * 0.34];
      const margin = x < 280 || x > 680;
      if (rand() < row.arm * (margin ? 1.5 : 1)) {
        const kind = rand();
        const sgn = side;
        const [sx, sy] = shoulder(sgn);
        const reach = s * (3.5 + rand() * 1.1);
        const lean = sgn * s * (0.4 + rand() * 1);
        const arm = { sx, sy, ex: sx + sgn * s * 1.3, ey: sy - reach * 0.42, hx: sx + lean, hy: sy - reach, w: s * 0.58, item: null };
        if (kind < 0.2 && index >= 1) {
          arm.item = 'phone';
          arm.hx = x + sgn * s * 0.7;
          arm.hy = p.y - s * 2.3;
          arm.ex = sx + sgn * s * 0.5;
          phones.push({ x: arm.hx, y: arm.hy - arm.w * 1.25, w: arm.w * 1.1, h: arm.w * 1.9 });
          p.arms.push(arm);
        } else if (kind < 0.36 && index >= 1) {
          arm.hx = sx + sgn * s * 1.3;
          arm.hy = sy - reach * 0.9;
          p.arms.push(arm);
          sparklers.push({ x: arm.hx + sgn * s * 0.5, y: arm.hy - s * 1.1, hx: arm.hx, hy: arm.hy, size: s, seed: Math.floor(rand() * 256) });
        } else if (kind < 0.74) {
          movers.push({ ...arm, row: index, tone: row.tone, n: 16 + Math.floor(rand() * 16), phase: rand(), swing: s * (0.6 + rand() * 1.1) });
        } else {
          if (kind > 0.9) arm.item = 'fingers';
          p.arms.push(arm);
          if (rand() < 0.5) {
            const [sx2, sy2] = shoulder(-sgn);
            p.arms.push({ sx: sx2, sy: sy2, ex: sx2 - sgn * s * 1.2, ey: sy2 - reach * 0.44, hx: sx2 - sgn * s * (0.3 + rand() * 0.8), hy: sy2 - reach * (0.86 + rand() * 0.2), w: s * 0.58, item: null });
          }
        }
      }
      people.push(p);
      if (index >= 1 && rand() < 0.035) {
        // A child up on someone's shoulders, arms in the air.
        const ks = s * 0.68;
        const ky = p.y - s * 2.2;
        const kid = { x: x + side * s * 0.1, y: ky, s: ks, sw: 1.5, tilt: 0, top: rand() < 0.5 ? 'beanie' : 'hair', side, arms: [], cloth: CLOTH[Math.floor(rand() * CLOTH.length)] };
        for (const sgn of [-1, 1]) {
          const sx = kid.x + sgn * ks * 1.2;
          const sy = ky + ks * 1.7;
          kid.arms.push({ sx, sy, ex: sx + sgn * ks * 1.1, ey: sy - ks * 1.2, hx: sx + sgn * ks * (0.5 + rand() * 0.7), hy: sy - ks * 3, w: ks * 0.56, item: null });
        }
        people.push(kid);
      }
      x += row.step * (0.5 + rand() * rand() * 1.5) + (rand() < 0.05 ? row.step * 0.8 : 0);
    }
    // A row's silhouette, what catches light on its edges, and its clothes.
    m.clearRect(0, 0, CW, CH);
    f.clearRect(0, 0, CW, CH);
    for (const p of people) {
      m.fillStyle = '#fff';
      m.strokeStyle = '#fff';
      figure(m, p, CH + 4);
      const [cr, cg, cb] = p.cloth;
      f.fillStyle = `rgb(${cr},${cg},${cb})`;
      f.strokeStyle = f.fillStyle;
      figure(f, p, CH + 4);
    }
    const alpha = m.getImageData(0, 0, CW, CH).data;
    const cloth = f.getImageData(0, 0, CW, CH).data;
    const at = (px, py) => (px < 0 || py < 0 || px >= CW || py >= CH ? 0 : alpha[(py * CW + px) * 4 + 3]);
    const baked = newCanvas(CW, CH);
    const bg = baked.getContext('2d');
    bg.drawImage(mask, 0, 0);
    bg.globalCompositeOperation = 'source-in';
    bg.fillStyle = row.tone;
    bg.fillRect(0, 0, CW, CH);
    g.drawImage(baked, 0, 0);
    const edge = new Art(CW, CH);
    for (let py = 395; py < CH; py += 1) {
      for (let px = 0; px < CW; px += 1) {
        if (at(px, py) < 128) continue;
        const j = (py * CW + px) * 4;
        const up = at(px, py - 2) < 128 ? 1 : at(px, py - 3) < 128 ? 0.35 : 0;
        const fillK = 0.05 + 0.1 * clamp(1 - (py - 450) / 90);
        const v = row.light * up;
        lit.put(px, py, pack(cloth[j] * fillK + v, cloth[j + 1] * fillK + v, cloth[j + 2] * fillK + v * 1.04));
        if (row.rim && up > 0) edge.put(px, py, pack(row.rim, row.rim + 2, row.rim + 12, Math.round(110 * up)));
      }
    }
    if (row.rim) g.drawImage(edge.canvas(), 0, 0);
  });

  return { canvas, phones, sparklers, movers, lamps };
}

function sprite(size, stops) {
  const c = newCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/* ── one frame ─────────────────────────────────────────────────── */

const HAZE = new Float32Array(LW * LH);
/** Soft light in, a colour value out: for the glow, which is added to a dark sky and must not show steps. */
const SOFT = new Float32Array(4096);
for (let i = 0; i < 4096; i += 1) SOFT[i] = 255 * (1 - Math.exp(-i / 1024)) ** 0.88;

function stage(shells, T) {
  for (let i = 0, n = shells.length; i < n; i += 1) {
    const s = shells[i];
    let age = T - s.launch;
    if (age < 0) age += PERIOD;
    if (age >= s.span) continue;
    if (s.rise > 0 && age < s.rise + 1) drawRise(s, age);
    const a = age - s.rise;
    if (a < 0) continue;
    if (a < s.end) {
      for (let j = 0; j < s.layers.length; j += 1) drawLayer(s, s.layers[j], a);
      const [r, g, b] = s.col;
      if (a < 0.5) {
        const f = s.flash * Math.exp(-a * 13);
        glare(s.bx, s.by, s.flashR * (1.3 + a * 2), r * f * 6.5, g * f * 6.5, b * f * 6.5);
        hot(s.bx, s.by, r * f * 24, g * f * 24, b * f * 24);
      }
      const l = s.flash * Math.exp(-a * 6.5) * 1.3 + s.glow * Math.max(0, 1 - a / s.end) ** 1.4;
      if (l > 0.02) lightUp(s.bx, s.by, r * l, g * l, b * l, 150 + s.R * 1.1);
    }
    if (s.smoke > 0) {
      const dens = s.smoke * Math.exp(-a / 6.5) * Math.min(1, a / 0.5);
      if (dens > 0.035) puff(s.bx + WIND * a * 0.86, s.by - a * 1.4, s.R * (0.6 + 0.55 * (1 - Math.exp(-a / 5))), dens);
    }
  }
}

function exposeFire(w) {
  const O = w.fire.px;
  let j = 0;
  for (let i = 0, n = FW * FH; i < n; i += 1, j += 3) {
    const r = F[j];
    const g = F[j + 1];
    const b = F[j + 2];
    if (r + g + b < 0.004) {
      O[i] = BLACK;
      continue;
    }
    const ra = (r * 256) | 0;
    const ga = (g * 256) | 0;
    const ba = (b * 256) | 0;
    O[i] = BLACK | (TONE[ba > 2047 ? 2047 : ba] << 16) | (TONE[ga > 2047 ? 2047 : ga] << 8) | TONE[ra > 2047 ? 2047 : ra];
  }
  w.fire.ctx.putImageData(w.fire.img, 0, 0);
  F.fill(0);
}

/** A light blur that costs little: one pass of 1-2-1 each way, in place. */
function soften(a, w, h) {
  const stride = w * 3;
  for (let y = 0; y < h; y += 1) {
    const row = y * stride;
    for (let ch = 0; ch < 3; ch += 1) {
      let prev = a[row + ch];
      for (let j = row + 3 + ch, end = row + stride - 3; j < end; j += 3) {
        const cur = a[j];
        a[j] = (prev + cur + cur + a[j + 3]) * 0.25;
        prev = cur;
      }
    }
  }
  for (let x = 0; x < stride; x += 1) {
    let prev = a[x];
    for (let j = x + stride, end = (h - 1) * stride; j < end; j += stride) {
      const cur = a[j];
      a[j] = (prev + cur + cur + a[j + stride]) * 0.25;
      prev = cur;
    }
  }
}

/**
 * Everything soft, in one small picture stretched over the sky: the haze and smoke lit
 * by the flashes, and the bloom around the stars. One stretched blit rather than three.
 */
function exposeGlow(w, T) {
  // A sky can only get so bright, however many shells are bursting.
  for (let j = 0, n = GW * GH * 3; j < n; j += 1) {
    const v = G[j];
    G[j] = v / (1 + v * 0.8);
  }
  soften(L, LW, LH);
  WIDE.fill(0);
  for (let y = 0; y < LH; y += 1) {
    const row = (y >> 2) * 60;
    for (let x = 0; x < LW; x += 1) {
      const a = (y * LW + x) * 3;
      const c = (row + (x >> 2)) * 3;
      WIDE[c] += L[a];
      WIDE[c + 1] += L[a + 1];
      WIDE[c + 2] += L[a + 2];
    }
  }
  soften(WIDE, 60, 25);
  soften(WIDE, 60, 25);
  soften(WIDE, 60, 25);
  COLUMN.fill(0);
  for (let y = 0, c = 0; y < 25; y += 1) {
    for (let x = 0; x < 60; x += 1, c += 3) {
      COLUMN[x * 3] += WIDE[c];
      COLUMN[x * 3 + 1] += WIDE[c + 1];
      COLUMN[x * 3 + 2] += WIDE[c + 2];
    }
  }

  const O = w.glow.px;
  const tile = w.smokeTile;
  const scroll = (T / PERIOD) * 128;
  const ox = Math.floor(scroll);
  const fr = scroll - ox;
  const oy = Math.floor((T / PERIOD) * 256);
  const gxScale = (GW - 1) / (LW - 1);
  for (let y = 0; y < LH; y += 1) {
    const gy = ((y * 4 + 2) / CH) * (GH - 1);
    const y0 = gy | 0;
    const fy = gy - y0;
    const row0 = y0 * GW * 3;
    const row1 = row0 + GW * 3;
    const wv = y / 4;
    const wy0 = wv | 0;
    const wfy = wv - wy0;
    const wr0 = wy0 * 60 * 3;
    const wr1 = wy0 < 24 ? wr0 + 180 : wr0;
    const amb = Math.exp(-Math.max(0, WATER - y * 4) / 80);
    const ambR = 0.012 + amb * 0.05;
    const ambG = 0.012 + amb * 0.032;
    const ambB = 0.02 + amb * 0.034;
    for (let x = 0; x < LW; x += 1) {
      const i = y * LW + x;
      const gx = x * gxScale;
      const x0 = gx | 0;
      const fx = gx - x0;
      const a = row0 + x0 * 3;
      const c = row1 + x0 * 3;
      const k0 = (1 - fx) * (1 - fy);
      const k1 = fx * (1 - fy);
      const k2 = (1 - fx) * fy;
      const k3 = fx * fy;
      const gr = G[a] * k0 + G[a + 3] * k1 + G[c] * k2 + G[c + 3] * k3;
      const gg = G[a + 1] * k0 + G[a + 4] * k1 + G[c + 1] * k2 + G[c + 4] * k3;
      const gb = G[a + 2] * k0 + G[a + 5] * k1 + G[c + 2] * k2 + G[c + 5] * k3;

      const wu = x / 4;
      const wx0 = wu | 0;
      const wfx = wu - wx0;
      const wa = wr0 + wx0 * 3;
      const wc = wr1 + wx0 * 3;
      const wn = wx0 < 59 ? 3 : 0;
      const w0 = (1 - wfx) * (1 - wfy);
      const w1 = wfx * (1 - wfy);
      const w2 = (1 - wfx) * wfy;
      const w3 = wfx * wfy;
      const wideR = WIDE[wa] * w0 + WIDE[wa + wn] * w1 + WIDE[wc] * w2 + WIDE[wc + wn] * w3;
      const wideG = WIDE[wa + 1] * w0 + WIDE[wa + wn + 1] * w1 + WIDE[wc + 1] * w2 + WIDE[wc + wn + 1] * w3;
      const wideB = WIDE[wa + 2] * w0 + WIDE[wa + wn + 2] * w1 + WIDE[wc + 2] * w2 + WIDE[wc + wn + 2] * w3;

      const nx = (x - ox) & 127;
      const ny = y & 127;
      const billow = (tile[(ny << 7) + nx] * (1 - fr) + tile[(ny << 7) + ((nx - 1) & 127)] * fr) * 0.72 + tile[(((y + oy) & 127) << 7) + ((x + 53 - ox) & 127)] * 0.28;
      const body = (billow - 0.3) * 2.3;
      const raw = SMOKE[i];
      const smoke = (raw / (1 + raw)) * (body > 0 ? body : 0);
      const d = HAZE[i] * (0.86 + billow * 0.28) + smoke;

      const j = i * 3;
      const lr = L[j] * 0.042 + wideR * 0.008 + d * (gr * 0.62 + ambR);
      const lg = L[j + 1] * 0.042 + wideG * 0.008 + d * (gg * 0.62 + ambG);
      const lb = L[j + 2] * 0.042 + wideB * 0.008 + d * (gb * 0.62 + ambB);
      const ia = (lr * 1024) | 0;
      const ib = (lg * 1024) | 0;
      const ic = (lb * 1024) | 0;
      const vr = SOFT[ia > 4095 ? 4095 : ia] + 0.5;
      const vg = SOFT[ib > 4095 ? 4095 : ib] + 0.5;
      const vb = SOFT[ic > 4095 ? 4095 : ic] + 0.5;
      O[i] = BLACK | ((vb > 255 ? 255 : vb | 0) << 16) | ((vg > 255 ? 255 : vg | 0) << 8) | (vr > 255 ? 255 : vr | 0);
    }
  }
  SMOKE.fill(0);
  w.glow.ctx.putImageData(w.glow.img, 0, 0);

  // The same field as bytes, for what it falls on.
  const P = w.field.px;
  let j = 0;
  for (let i = 0, n = GW * GH; i < n; i += 1, j += 3) {
    const r = G[j] * 200;
    const g = G[j + 1] * 200;
    const b = G[j + 2] * 200;
    P[i] = BLACK | ((b > 255 ? 255 : b | 0) << 16) | ((g > 255 ? 255 : g | 0) << 8) | (r > 255 ? 255 : r | 0);
  }
  w.field.ctx.putImageData(w.field.img, 0, 0);
}

function exposeWater(w, T) {
  const { C, tile, rowDu, rowV, rowAX, rowAY, rowMirror, rowGain } = w.water;
  const O = w.river.px;
  const s = T / PERIOD;
  const tw = TW - 1;
  const th = TH - 1;
  const maxCell = LW * Math.floor(WATER / 4) * 3;
  const gxScale = (GW - 1) / RW;
  for (let r = 0; r < RH; r += 1) {
    const du = rowDu[r];
    const b1 = (((rowV[r] + s * TH * 4) | 0) & th) * TW;
    const b2 = (((rowV[r] * 0.72 - s * TH * 3 + 97) | 0) & th) * TW;
    let u1 = s * TW * 3 + r * 13.7;
    let u2 = -s * TW * 4 + r * 5.3 + 211;
    const ax = rowAX[r];
    const ay = rowAY[r];
    const mirror = rowMirror[r];
    const gain = rowGain[r];
    const gRow = ((((WATER + r) / CH) * (GH - 1)) | 0) * GW * 3;
    const line = r * RW;
    const k = r / RH;
    const crDisp = 5 + k * 12;
    for (let x = 0; x < RW; x += 1) {
      const n1 = tile[b1 + ((u1 | 0) & tw)];
      const n2 = tile[b2 + ((u2 | 0) & tw)];
      u1 += du;
      u2 += du * 0.83;
      const n = n1 + n2 - 1;
      const sx = x * 2 + n * ax;
      const sy = mirror + n * ay;
      let cell = ((sy < 0 ? 0 : sy) >> 2) * LW + ((sx < 0 ? 0 : sx > CW - 4 ? CW - 4 : sx) >> 2);
      cell *= 3;
      if (cell > maxCell) cell = maxCell;
      // A ripple is a little mirror that looks somewhere else: bright crests, dark between.
      let m = 0.56 + n * 3.6;
      m = m < 0.05 ? 0.05 : m > 1.6 ? 1.6 : m;
      const fg = gain * m;
      let cx = x + ((n * ax * 0.5) | 0);
      cx = cx < 0 ? 0 : cx >= RW ? RW - 1 : cx;
      let cr = r + ((n * crDisp) | 0);
      cr = cr < 0 ? 0 : cr >= RH ? RH - 1 : cr;
      const ci = (cr * RW + cx) * 3;
      const gc = gRow + ((x * gxScale) | 0) * 3;
      const sheen = m * 0.08;
      const cu = (sx < 0 ? 0 : sx > CW - 4 ? CW - 4 : sx) / 16;
      const c0 = cu | 0;
      const cf = cu - c0;
      const c3 = c0 * 3;
      const red = (L[cell] * 0.12 + C[ci] * 1.2 + (COLUMN[c3] * (1 - cf) + COLUMN[c3 + 3] * cf) * 0.0042) * fg + G[gc] * sheen;
      const grn = (L[cell + 1] * 0.12 + C[ci + 1] * 1.2 + (COLUMN[c3 + 1] * (1 - cf) + COLUMN[c3 + 4] * cf) * 0.0042) * fg + G[gc + 1] * sheen;
      const blu = (L[cell + 2] * 0.12 + C[ci + 2] * 1.2 + (COLUMN[c3 + 2] * (1 - cf) + COLUMN[c3 + 5] * cf) * 0.0042) * fg + G[gc + 2] * sheen;
      const a = ((red / (1 + red * 0.62)) * 256) | 0;
      const b = ((grn / (1 + grn * 0.62)) * 256) | 0;
      const d = ((blu / (1 + blu * 0.62)) * 256) | 0;
      O[line + x] = BLACK | (TONE[d > 2047 ? 2047 : d] << 16) | (TONE[b > 2047 ? 2047 : b] << 8) | TONE[a > 2047 ? 2047 : a];
    }
  }
  w.river.ctx.putImageData(w.river.img, 0, 0);
}

/** Only these bands of the picture can catch a flash: [top, height, where in the working canvas]. */
const LIT_BANDS = [
  [196, 180, 0],
  [420, 120, 180],
];

const newYearFireworks = {
  build() {
    const rand = seeded(20270101);
    const sky = paintSky(rand);
    const cityPainted = paintCity(rand);
    const water = paintRiver(rand, cityPainted.lights);
    const crowd = paintCrowd(rand, cityPainted.lit);
    const lit = cityPainted.lit.canvas();
    const shells = planShow(rand);

    const surface = (w, h) => {
      const canvas = newCanvas(w, h);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = true;
      const img = ctx.createImageData(w, h);
      return { canvas, ctx, img, px: new Uint32Array(img.data.buffer) };
    };
    const relit = newCanvas(CW, 300);
    const relitCtx = relit.getContext('2d', { alpha: false });
    relitCtx.imageSmoothingEnabled = true;

    // Haze: thin near the top, thick at the horizon, with a little high cloud to catch the light.
    const hazeN = noise2(3401, 32);
    for (let y = 0; y < LH; y += 1) {
      for (let x = 0; x < LW; x += 1) {
        const k = clamp((y * 4) / WATER);
        const cloud = smooth(clamp((fbm2(hazeN, x / 30, y / 8, 4) - 0.44) / 0.36));
        HAZE[y * LW + x] = 0.045 + 0.34 * k * k * k + cloud * (0.05 + 0.08 * k);
      }
    }
    const sn = noise2(3402, 8);
    const smokeTile = new Float32Array(128 * 128);
    for (let y = 0; y < 128; y += 1) for (let x = 0; x < 128; x += 1) smokeTile[y * 128 + x] = fbm2(sn, x / 16, y / 16, 4);

    const twinkleBy = new Map();
    for (const q of cityPainted.twinkles) {
      const key = `rgb(${(q.c[0] * (q.i + 0.1)) | 0},${(q.c[1] * (q.i + 0.1)) | 0},${(q.c[2] * (q.i + 0.1)) | 0})`;
      if (!twinkleBy.has(key)) twinkleBy.set(key, []);
      twinkleBy.get(key).push(q);
    }

    return {
      sky,
      city: cityPainted.canvas,
      beacons: cityPainted.beacons,
      twinkles: [...twinkleBy.entries()],
      bridge: cityPainted.bridge,
      lit,
      water,
      crowd,
      shells,
      smokeTile,
      fire: surface(FW, FH),
      glow: surface(LW, LH),
      field: surface(GW, GH),
      river: surface(RW, RH),
      relit,
      relitCtx,
      lampGlow: sprite(72, [[0, 'rgba(255,214,150,0.7)'], [0.12, 'rgba(255,186,116,0.28)'], [0.42, 'rgba(255,150,90,0.06)'], [1, 'rgba(255,120,60,0)']]),
      sparkGlow: sprite(64, [[0, 'rgba(255,244,214,0.9)'], [0.14, 'rgba(255,210,140,0.46)'], [0.5, 'rgba(255,150,70,0.09)'], [1, 'rgba(255,120,40,0)']]),
    };
  },

  draw(ctx, t, w) {
    const T = ((t % PERIOD) + PERIOD) % PERIOD;
    const phase = T / PERIOD;
    G.fill(0);
    stage(w.shells, T);
    exposeFire(w);
    exposeGlow(w, T);
    exposeWater(w, T);
    L.fill(0);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(w.sky, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(w.glow.canvas, 0, 0, LW, LH, 0, 0, FW, FH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(w.city, 0, 170, CW, WATER + 6 - 170, 0, 170, CW, WATER + 6 - 170);

    // Windows going on and off, aircraft lights, cars on the bridge.
    for (const [style, list] of w.twinkles) {
      ctx.fillStyle = style;
      for (let i = 0; i < list.length; i += 1) {
        const q = list[i];
        if (Math.sin(TAU * (q.n * phase + q.phase)) > q.edge) ctx.fillRect(q.x, q.y, q.w, q.h);
      }
    }
    ctx.drawImage(w.water.canvas, 0, WATER);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ff3a2e';
    for (let i = 0; i < w.beacons.length; i += 1) {
      const b = w.beacons[i];
      const v = (phase * b.n + b.phase) % 1;
      if (v < 0.16) {
        ctx.globalAlpha = 1 - v / 0.16;
        ctx.fillRect(b.x - 1, b.y - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
    const span = w.bridge.to - w.bridge.from;
    for (let i = 0; i < 9; i += 1) {
      const dir = i % 2;
      const v = (phase * (3 + (i % 3)) + i * 0.137) % 1;
      ctx.fillStyle = dir ? '#ff6a4e' : '#fff0d0';
      ctx.fillRect(w.bridge.from + (dir ? 1 - v : v) * span, w.bridge.y + 0.5, 1.2, 1);
    }

    ctx.drawImage(w.river.canvas, 0, 0, RW, RH, 0, WATER, CW, RH);
    ctx.drawImage(w.fire.canvas, 0, 0);

    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(w.crowd.canvas, 0, 395, CW, CH - 395, 0, 395, CW, CH - 395);

    // Arms that keep waving.
    const movers = w.crowd.movers;
    ctx.lineCap = 'round';
    for (let i = 0; i < movers.length; i += 1) {
      const a = movers[i];
      const sw = Math.sin(TAU * (a.n * phase + a.phase)) * a.swing;
      ctx.strokeStyle = a.tone;
      ctx.fillStyle = a.tone;
      ctx.lineWidth = a.w;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.quadraticCurveTo(a.ex + sw * 0.3, a.ey, a.hx + sw, a.hy);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(a.hx + sw, a.hy, a.w * 0.62, 0, TAU);
      ctx.fill();
    }

    // What the flashes fall on.
    const rc = w.relitCtx;
    rc.globalCompositeOperation = 'source-over';
    for (const [y, h, dy] of LIT_BANDS) rc.drawImage(w.lit, 0, y, CW, h, 0, dy, CW, h);
    rc.globalCompositeOperation = 'multiply';
    for (const [y, h, dy] of LIT_BANDS) rc.drawImage(w.field.canvas, 0, (y * GH) / CH, GW, (h * GH) / CH, 0, dy, CW, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const [y, h, dy] of LIT_BANDS) ctx.drawImage(w.relit, 0, dy, CW, h, 0, y, CW, h);

    // Lamp globes, phone screens, sparklers.
    for (const [x, y] of w.crowd.lamps) ctx.drawImage(w.lampGlow, x - 36, y - 36);
    ctx.fillStyle = '#b6ccf2';
    for (const p of w.crowd.phones) ctx.fillRect(p.x - p.w / 2, p.y, p.w, p.h);
    const tick = Math.floor(T * 30);
    ctx.strokeStyle = '#ffdca0';
    ctx.lineWidth = 0.6;
    for (const s of w.crowd.sparklers) {
      ctx.globalAlpha = 0.6 + TWK[(tick * 3 + s.seed) & 255] * 0.4;
      const size = 20 + s.size * 1.6;
      ctx.drawImage(w.sparkGlow, s.x - size / 2, s.y - size / 2, size, size);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let i = 0; i < 26; i += 1) {
        const h = (tick * 7 + s.seed + i * 29) & 255;
        const v = TWK[h];
        const r = 1.5 + v * v * (7 + s.size * 1.1);
        ctx.moveTo(s.x + COS[h] * r * 0.72, s.y + SIN[h] * r * 0.72 + r * r * 0.012);
        ctx.lineTo(s.x + COS[h] * r, s.y + SIN[h] * r + r * r * 0.02);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  },
};

export default newYearFireworks;