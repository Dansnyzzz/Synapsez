import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm1, fbm2, ridged, slide } from './art.js';

/**
 * Dawn on the steppe, Year of the Horse. We travel with the herd, which is why the
 * grass rushes by and the horses themselves cross the frame only slowly: a gallop at
 * its real speed would cross this canvas in two seconds. The ground is a true
 * perspective plane, so the near grass passes fast and the far grass hardly at all.
 *
 * One light: the huge low sun ahead of them. Whatever faces it has a burning edge.
 */

const SUN = { x: 372, y: 128, r: 68 };
const HORIZON = 176;
/** How fast the ground passes at the bottom edge of the picture, pixels a second. */
const CAMERA = 52;
const FINE = 3;
/** Ten drawings to a stride; a stride takes this long. */
const STRIDE_FRAMES = 10;
const STRIDE_SECONDS = 0.74;
/** The width of the grass's pattern before it repeats. */
const GROUND_PERIOD = 960;

const see = (hex, alpha) => ((rgba(hex) & 0xffffff) | (alpha << 24)) >>> 0;
/** How much a row of the plain is magnified: nothing at the horizon, one at the bottom. */
const scaleAt = (y) => 0.22 + 0.78 * clamp((y - HORIZON) / (H - HORIZON - 1));

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

function limb(art, x0, y0, x1, y1, r0, r1, c) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i += 1) {
    const k = i / n;
    art.disc(mix(x0, x1, k), mix(y0, y1, k), mix(r0, r1, k), c);
  }
}

/** Through every point of a closed outline, smoothly. */
function smoothLoop(points, steps = 5) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const [p0, p1, p2, p3] = [points[(i + n - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]];
    for (let j = 0; j < steps; j += 1) {
      const u = j / steps;
      const u2 = u * u;
      const u3 = u2 * u;
      out.push([
        0.5 * (2 * p1[0] + (p2[0] - p0[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * u3),
        0.5 * (2 * p1[1] + (p2[1] - p0[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * u3),
      ]);
    }
  }
  return out;
}

/** A smooth path through keys [at, x, y], `at` running 0 to 1. */
function along3(keys, s) {
  let i = 0;
  while (i < keys.length - 2 && s > keys[i + 1][0]) i += 1;
  const [a, b] = [keys[i], keys[i + 1]];
  const p0 = keys[Math.max(0, i - 1)];
  const p3 = keys[Math.min(keys.length - 1, i + 2)];
  const u = clamp((s - a[0]) / (b[0] - a[0]));
  const u2 = u * u;
  const u3 = u2 * u;
  const cr = (q0, q1, q2, q3) => 0.5 * (2 * q1 + (q2 - q0) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u2 + (3 * q1 - q0 - 3 * q2 + q3) * u3);
  return [cr(p0[1], a[1], b[1], p3[1]), cr(p0[2], a[2], b[2], p3[2])];
}

/* ── the horse ────────────────────────────────────────────────────── */

/**
 * The gallop, from the footfall order of a real one: trailing hind, leading hind,
 * trailing fore, leading fore, then all four off the ground and gathered under the
 * body. `touch` is when each hoof lands in the stride, `duty` how long it stays down.
 */
const LEGS = {
  hindFar: { touch: 0, duty: 0.24, fore: false, far: true },
  hindNear: { touch: 0.12, duty: 0.24, fore: false, far: false },
  foreFar: { touch: 0.28, duty: 0.24, fore: true, far: true },
  foreNear: { touch: 0.42, duty: 0.24, fore: true, far: false },
};
/** Where the fetlock travels while the leg is in the air, relative to the elbow or stifle. */
const FORE_SWING = [[0, -13, 23], [0.2, -17, 15], [0.42, -11, 4], [0.62, 4, 2], [0.82, 18, 11], [1, 13, 23]];
const HIND_SWING = [[0, -21, 25], [0.2, -29, 17], [0.45, -16, 10], [0.7, 7, 13], [0.88, 15, 19], [1, 11, 25]];

/** Part codes while drawing: what is on the far side, the body, and marks of form. */
const FAR_PART = 0xff000001;
const BODY_PART = 0xff000002;
const FORM_PART = 0xff000003;

function paintHorse(fine, ox, oy, s, g, o) {
  const X = (v) => (ox + v * s) * FINE;
  const Y = (v) => (oy + (v - 36) * s) * FINE;
  const R = (r) => Math.max(r * s * FINE, 0.9);
  const theta = 0.075 * Math.cos(TAU * (g - 0.12));
  const dy = -2.4 * Math.cos(TAU * (g - 0.83));
  const [cs, sn] = [Math.cos(theta), Math.sin(theta)];
  const rot = (x, y) => [x * cs + y * sn, -x * sn + y * cs + dy];
  const at = (x, y) => {
    const [a, b] = rot(x, y);
    return [X(a), Y(b)];
  };

  const leg = (spec) => {
    const p = ((g - spec.touch) % 1 + 1) % 1;
    const base = spec.fore ? [16, 8] : [-20, 6];
    const down = p < spec.duty;
    const keys = spec.fore ? FORE_SWING : HIND_SWING;
    let px;
    let py;
    let flex;
    if (down) {
      const k = p / spec.duty;
      px = spec.fore ? mix(13, -13, k) : mix(11, -21, k);
      py = spec.fore ? 23 : 25;
      flex = 0.55 - k * 1.05;
    } else {
      const k = (p - spec.duty) / (1 - spec.duty);
      [px, py] = along3(keys, k);
      flex = k < 0.72 ? -1.25 * Math.sin(Math.PI * Math.min(1, k / 0.72)) : ((k - 0.72) / 0.28) * 0.5;
    }
    // Shoulder and hip ride forward and back with the leg, which is half of what makes it look strong.
    const [ax, ay] = rot(base[0] + px * (spec.fore ? 0.14 : 0.18), base[1]);
    const fx = ax + px;
    const fy = down ? 31 : ay + py;
    const c = spec.far ? FAR_PART : BODY_PART;
    const [upper, lower] = spec.fore ? [13.5, 11.5] : [14.5, 13];
    let dist = Math.hypot(fx - ax, fy - ay);
    const reach = upper + lower - 0.3;
    const ux = (fx - ax) / (dist || 1);
    const uy = (fy - ay) / (dist || 1);
    dist = clamp(dist, Math.abs(upper - lower) + 0.5, reach);
    const along2 = (upper * upper + dist * dist - lower * lower) / (2 * dist);
    const lift2 = Math.sqrt(Math.max(0, upper * upper - along2 * along2));
    // A foreleg's knee points forward, a hind leg's hock back.
    const side = spec.fore ? -1 : 1;
    const kx = ax + ux * along2 - uy * lift2 * side;
    const ky = ay + uy * along2 + ux * lift2 * side;
    const tx = ax + ux * dist;
    const ty = ay + uy * dist;
    const cannon = Math.atan2(ty - ky, tx - kx);
    const hoofX = tx + Math.cos(cannon - flex) * 5.2;
    const hoofY = ty + Math.sin(cannon - flex) * 5.2;
    if (spec.fore) {
      const [sx, sy] = rot(17, -5);
      limb(fine, X(sx), Y(sy), X(ax), Y(ay), R(7), R(4.2), c);
      limb(fine, X(ax), Y(ay), X(kx), Y(ky), R(4), R(2.05), c);
      fine.disc(X(kx), Y(ky), R(2.1), c);
      limb(fine, X(kx), Y(ky), X(tx), Y(ty), R(1.55), R(1.3), c);
    } else {
      const [sx, sy] = rot(-21, -6);
      limb(fine, X(sx), Y(sy), X(ax), Y(ay), R(9.5), R(5.4), c);
      limb(fine, X(ax), Y(ay), X(kx), Y(ky), R(5.2), R(2.15), c);
      fine.disc(X(kx), Y(ky), R(2.25), c);
      limb(fine, X(kx), Y(ky), X(tx), Y(ty), R(1.65), R(1.35), c);
    }
    fine.disc(X(tx), Y(ty), R(1.8), c);
    limb(fine, X(tx), Y(ty), X(hoofX), Y(hoofY), R(1.3), R(1.45), c);
    const toe = cannon - flex;
    limb(fine, X(hoofX - Math.cos(toe) * 0.3), Y(hoofY - Math.sin(toe) * 0.3), X(hoofX + Math.cos(toe) * 1.3), Y(hoofY + Math.sin(toe) * 1.3), R(1.9), R(2.3), c);
  };

  // The tail, streaming, in several locks, wave running down it.
  const [dockX, dockY] = rot(-28, -9);
  for (let i = 0; i < 8; i += 1) {
    const spread = (i - 3.5) / 3.5;
    const len = o.tail * (0.8 + (1 - Math.abs(spread)) * 0.24);
    let prev = null;
    const n = 12;
    for (let j = 0; j <= n; j += 1) {
      const u = j / n;
      const x = dockX - len * u;
      const y = dockY - Math.sin(u * 2.3) * 5.5 + u * u * 8 + spread * (1 + u * 6) + Math.sin(u * 4.6 - TAU * g + i * 0.16) * (0.5 + u * 3.2);
      if (prev) limb(fine, X(prev[0]), Y(prev[1]), X(x), Y(y), R(mix(2.2, 0.5, (j - 1) / n)), R(mix(2.2, 0.5, j / n)), BODY_PART);
      prev = [x, y];
    }
  }

  leg(LEGS.hindFar);
  leg(LEGS.foreFar);

  // The body.
  const outline = smoothLoop([[16, -13.5], [6, -11], [-6, -11], [-17, -13.5], [-26, -10.5], [-29.5, -3], [-27, 5], [-18, 8.5], [-6, 10.5], [8, 12.5], [18, 10], [25, 2], [25, -6]]).map(([x, y]) => at(x, y));
  fine.poly(outline, BODY_PART);

  // Neck and head, nodding against the stride: up when the hinds land, down when the fores do.
  const nod = 3 * Math.cos(TAU * (g - 0.2));
  const swayX = 1.5 * Math.sin(TAU * (g - 0.2));
  const [pollX, pollY] = rot(41 + swayX, -29 - nod);
  const [throatX, throatY] = rot(37.5 + swayX, -18.5 - nod);
  const neck = smoothLoop([[11, -14], [23, -20.5], [pollX - 2, pollY + 0.5], [pollX + 1, pollY + 4], [throatX, throatY], [33, -7], [26, 3], [14, 2]].map(([x, y], i) => (i === 2 || i === 3 || i === 4 ? [x, y] : rot(x, y))), 4);
  fine.poly(neck.map(([x, y]) => [X(x), Y(y)]), BODY_PART);
  const a = 0.86 + nod * 0.03;
  const d = [Math.cos(a), Math.sin(a)];
  const n = [Math.sin(a), -Math.cos(a)];
  const on = (u, v) => [pollX + d[0] * u + n[0] * v, pollY + d[1] * u + n[1] * v];
  const head = smoothLoop([on(-1.5, 2.6), on(6, 3.5), on(14, 2.6), on(20, 2), on(22, -0.4), on(20.4, -3.2), on(13, -3.3), on(6, -6.2), on(0, -6.6)], 3);
  fine.poly(head.map(([x, y]) => [X(x), Y(y)]), BODY_PART);
  // Ears, a little back for the speed.
  const ear = (u, tip) => {
    const [bx0, by0] = on(u, 2);
    const [bx1, by1] = on(u + 3.4, 2.4);
    const [ex, ey] = on(u - 2.4, tip);
    fine.poly([[X(bx0), Y(by0)], [X(bx1), Y(by1)], [X(ex), Y(ey)]], BODY_PART);
  };
  ear(-1, 8.6);
  ear(1, 8);

  // The mane: a lock from every point of the crest, lifting and streaming.
  const [baseX, baseY] = rot(14, -14.5);
  for (let i = 0; i < o.mane; i += 1) {
    const u0 = i / (o.mane - 1);
    const rootX = mix(pollX - 1, baseX, u0);
    const rootY = mix(pollY - 0.5, baseY, u0) - Math.sin(u0 * Math.PI) * 0.8;
    const len = (o.maneLen * (0.72 + Math.sin(i * 2.4) * 0.18)) * (1 - u0 * 0.18);
    let prev = [rootX, rootY];
    const steps = 9;
    for (let j = 1; j <= steps; j += 1) {
      const u = j / steps;
      const x = rootX - len * u;
      const y = rootY - u * u * (1.5 + (i % 3)) + u * 2.2 + Math.sin(u * 4.2 - TAU * g + i * 0.5) * (0.2 + u * 2);
      limb(fine, X(prev[0]), Y(prev[1]), X(x), Y(y), R(mix(2, 0.5, (j - 1) / steps)), R(mix(2, 0.5, j / steps)), BODY_PART);
      prev = [x, y];
    }
  }

  leg(LEGS.hindNear);
  leg(LEGS.foreNear);

  // Marks of form, for those large enough to carry them: the shoulder and the great muscle of the quarters.
  if (s > 0.6) {
    const stroke = (points) => {
      for (let i = 0; i + 1 < points.length; i += 1) {
        const [x0, y0] = at(points[i][0], points[i][1]);
        const [x1, y1] = at(points[i + 1][0], points[i + 1][1]);
        limb(fine, x0, y0, x1, y1, R(0.8), R(0.55), FORM_PART);
      }
    };
    stroke([[20, -8], [24, -2], [22, 4]]);
    stroke([[-12, -9], [-10, -2], [-13, 5]]);
  }
}

/**
 * One size of horse, every drawing of its stride: painted fine, thinned, then coloured
 * by what each pixel was, with the edge towards the sun burning.
 */
function horseFrames(s, o, coat) {
  const w = Math.ceil(146 * s) + 4;
  const h = Math.ceil(84 * s) + 4;
  const ox = Math.ceil(80 * s) + 2;
  const oy = Math.ceil(80 * s) + 2;
  const colours = {
    [FAR_PART]: rgba(coat.far),
    [BODY_PART]: rgba(coat.body),
    [FORM_PART]: rgba(coat.form),
  };
  const rim = rgba(coat.rim);
  const hot = rgba(coat.hot);
  const soft = rgba(coat.soft);
  const frames = [];
  for (let f = 0; f < STRIDE_FRAMES; f += 1) {
    const fine = new Art(w * FINE, h * FINE);
    paintHorse(fine, ox, oy, s, f / STRIDE_FRAMES, o);
    const art = new Art(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let count = 0;
        let code = 0;
        let form = 0;
        for (let j = 0; j < FINE; j += 1) {
          for (let i = 0; i < FINE; i += 1) {
            const v = fine.px[(y * FINE + j) * fine.w + x * FINE + i];
            if (!v) continue;
            count += 1;
            code = v;
            if (v === FORM_PART) form += 1;
          }
        }
        if (count < 3) continue;
        art.px[y * w + x] = form ? colours[FORM_PART] : colours[code];
      }
    }
    // The burning edge: what has empty air on the sun's side, and a softer pixel just inside it.
    const edge = [];
    const inner = [];
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!art.get(x, y)) continue;
        const front = !art.get(x + 1, y);
        const top = !art.get(x, y - 1);
        const strand = (!art.get(x - 1, y) && front) || (top && !art.get(x, y + 1));
        if (strand) {
          if (bayer(x, y) < 0.3) inner.push([x, y]);
        } else if (front || top) edge.push([x, y, front && top]);
        else if (!art.get(x + 2, y) || !art.get(x + 1, y - 1)) inner.push([x, y]);
      }
    }
    for (const [x, y] of inner) if (bayer(x, y) < 0.6) art.put(x, y, soft);
    for (const [x, y, both] of edge) art.put(x, y, both ? hot : rim);
    frames.push(art.canvas());
  }
  return { frames, ox, oy, s };
}

/** A clump of long grass, in five positions of the wind; lit tips because the sun is behind it. */
function tuftFrames(rand, tall, blades, base, tip, plume) {
  const list = [];
  for (let i = 0; i < blades; i += 1) {
    const at = rand() - 0.5;
    list.push({ x: at * tall * 0.8, h: tall * (0.4 + rand() * 0.34 + (1 - (at * 2) ** 2) * 0.26), lean: at * tall * 0.5 + (rand() - 0.5) * tall * 0.16, tone: rand(), seed: plume && rand() < 0.3 });
  }
  const w = Math.ceil(tall * 2) + 6;
  const h = Math.ceil(tall) + 3;
  return [-1, -0.5, 0, 0.5, 1].map((bend) => {
    const art = new Art(w, h);
    for (const b of list) {
      const steps = Math.ceil(b.h);
      for (let j = 0; j <= steps; j += 1) {
        const k = j / steps;
        const x = w / 2 + b.x + (b.lean - bend * tall * 0.3) * k * k;
        const y = h - 1 - j;
        const lit = k * k * 0.84 + b.tone * 0.2;
        art.put(x, y, lit > 0.88 ? tip[2] : lit > 0.6 ? tip[1] : lit > 0.3 ? tip[0] : base);
        if (b.seed && k > 0.72) {
          art.put(x + (j % 2 ? 1 : -1), y, tip[2]);
          if (tall > 26 && j % 2) art.put(x + (j % 4 === 1 ? 2 : -2), y + 1, tip[1]);
        }
      }
    }
    return art.canvas();
  });
}

/** A place on the ground where someone is passing: `start` along the ground, `v` px/s at this row. */
const passing = (start, v, span, margin, t) => (((start - t * v) % span) + span) % span - margin;

/** Long lit streaks of cloud on a sheet that wraps. */
function streaks(rand, seed, height, count, colours, longest) {
  const art = new Art(960, height);
  const fray = noise2(seed, 64);
  for (let i = 0; i < count; i += 1) {
    const cx = rand() * 960;
    const cy = 3 + rand() * (height - 6);
    const half = longest * (0.3 + rand() * 0.7);
    const thick = 1.2 + rand() * 4.2;
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
        // Lit from below: the sun has not cleared the horizon by much.
        const shade = clamp(0.5 + dy / (thick * 1.6) + edge * 0.1);
        art.wrap(px, y, colours[Math.min(colours.length - 1, Math.floor(shade * colours.length))]);
      }
    }
  }
  return art.canvas();
}

const goldenHorse = {
  build() {
    const rand = seeded(2026);
    const fine = noise2(2600, 64);

    /* ── the sky ──────────────────────────────────────────────────── */
    const SKY = ramp('#7b4a80', '#935080', '#ad587e', '#c6647a', '#db7372', '#ea8668', '#f49c5f', '#fab35a', '#fdc95f', '#ffdb72', '#ffe98e', '#fff3ad', '#fffad0');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot((x - SUN.x) / 1.5, y - SUN.y);
      return clamp(0.03 + (y / 176) ** 1.25 * 0.56 + 0.56 * Math.exp(-((Math.max(0, d - SUN.r * 0.7) / 84) ** 1.4)) + (fbm2(fine, x / 26, y / 11, 3) - 0.5) * 0.05);
    }, 0.95);
    // The sun: pale at the heart, deep gold at the rim, a few darker bars low across it.
    const DISC = ramp('#ffb24a', '#ffc25a', '#ffd16e', '#ffdf88', '#ffeaa6', '#fff2c2', '#fff8dc');
    for (let y = SUN.y - SUN.r; y <= SUN.y + SUN.r; y += 1) {
      for (let x = SUN.x - SUN.r; x <= SUN.x + SUN.r; x += 1) {
        const d = Math.hypot(x - SUN.x, y - SUN.y) / SUN.r;
        if (d > 1) continue;
        const bar = y > SUN.y + 12 && Math.sin(y * 1.05 + Math.sin(x / 31) * 1.3) > 0.72 ? 0.24 : 0;
        sky.tone(x, y, DISC, clamp(1 - d * d * 0.92 - bar - (y - SUN.y) / SUN.r * 0.14 + (fbm2(fine, x / 9, y / 4, 2) - 0.5) * 0.1), 0.65);
      }
    }
    const raysArt = new Art();
    const rayNoise = noise1(2601, 128);
    for (let y = 0; y < HORIZON + 6; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const dx = x - SUN.x;
        const dy = y - SUN.y;
        const dist = Math.hypot(dx, dy);
        if (dist < SUN.r - 2) continue;
        const beam = clamp((fbm1(rayNoise, Math.atan2(dy, dx) * 8 + 40, 3) - 0.5) * 7);
        const a = beam * 0.34 * Math.exp(-(dist - SUN.r) / 150);
        const level = Math.floor(a * 14 + bayer(x, y));
        if (level > 0) raysArt.px[y * W + x] = see('#ffe2a0', Math.round((level / 14) * 255));
      }
    }
    const cloudsHigh = streaks(rand, 2602, 74, 20, ramp('#8a5288', '#a65f88', '#c67480', '#e49274', '#f7b472', '#ffd488'), 130);
    const cloudsLow = streaks(rand, 2603, 42, 14, ramp('#a05a7c', '#c06e78', '#de8a6c', '#f4a862', '#ffc86a', '#ffe494'), 100);

    /* ── the mountains, in three depths ───────────────────────────── */
    const range = (seed, base, height, colours, snow, cell) => {
      const line = noise1(seed, 960 / cell);
      const art = new Art(960, 90);
      const top = (x) => base - ridged(line, x / cell, 5) * height;
      for (let x = 0; x < 960; x += 1) {
        const y0 = Math.round(top(x));
        const slope = top(x + 2) - top(x - 2);
        for (let y = Math.max(0, y0); y < 90; y += 1) {
          const depth = y - y0;
          const face = fbm2(fine, (x + depth * 0.7) / 7.5, depth / 6, 3) - 0.5;
          let v = 0.42 - slope * 0.06 + face * 0.42 + (y / 90) * 0.42;
          if (snow && y < snow) v += clamp((snow - y) / 14) * 0.5 * (face > -0.08 ? 1 : 0.3);
          art.wrap(x, y, colours[Math.round(clamp(v + (bayer(x, y) - 0.5) * 0.14) * (colours.length - 1))]);
        }
      }
      return art.canvas();
    };
    const FAR_RANGE = range(2604, 80, 46, ramp('#b5697c', '#c17680', '#ce8484', '#da9488', '#e6a58c', '#efb892', '#f8d2a2'), 42, 40);
    const MID_RANGE = range(2605, 84, 28, ramp('#8f4c70', '#9f5674', '#b06278', '#c1707a', '#d2807c', '#e2967e', '#f0b080'), 0, 30);
    const NEAR_RANGE = range(2606, 88, 13, ramp('#6e3c5e', '#7c4460', '#8c4e62', '#9e5a64', '#b26a66', '#c88268', '#de9e6c'), 0, 20);

    /* ── the plain, a true perspective plane ──────────────────────── */
    const rows = H - HORIZON;
    const widest = Math.ceil(W / scaleAt(HORIZON)) + 2;
    const planeWidth = GROUND_PERIOD + widest;
    const GRASS = ramp('#54320f', '#6e4415', '#8a591a', '#a8721f', '#c58b28', '#dba234', '#ecba47', '#f6d05f', '#fde184', '#fff0ae');
    const blade = noise2(2607, 64);
    const plain = new Art(planeWidth, rows);
    const gustLight = new Art(planeWidth, rows);
    const gustDark = new Art(planeWidth, rows);
    const swell = noise2(2608, 32);
    for (let r = 0; r < rows; r += 1) {
      const d = r / (rows - 1);
      const rr = Math.log(1 + d * 8) * 11;
      const base = mix(0.8, 0.3, d ** 0.85);
      const amp = 0.2 + d * 0.5;
      for (let x = 0; x < GROUND_PERIOD; x += 1) {
        const lump = fbm2(fine, x / 15, rr, 3) - 0.5;
        const tick = fbm2(blade, x / 1.875, r / 1.6, 2) - 0.5;
        const v = base + lump * amp + tick * (0.14 + d * 0.5);
        const n = GRASS.length - 1;
        const idx = Math.round(clamp(v) * n + (bayer(x, r) - 0.5) * 0.8);
        plain.px[r * planeWidth + x] = GRASS[clamp(idx, 0, n)];
        // Wind: broad swells of light and shade, lying along the ground, that run across it.
        const s0 = fbm2(swell, x / 30, rr * 0.5, 3);
        const lightA = clamp((s0 - 0.55) * 7) * 0.5;
        const lightLevel = Math.floor(lightA * 8 + bayer(x, r));
        if (lightLevel > 0) gustLight.px[r * planeWidth + x] = see('#fff0a8', Math.round((lightLevel / 8) * 190));
        const s1 = fbm2(swell, x / 30 + 32, rr * 0.5 + 21, 3);
        const darkA = clamp((s1 - 0.56) * 7) * 0.5;
        const darkLevel = Math.floor(darkA * 8 + bayer(x + 1, r));
        if (darkLevel > 0) gustDark.px[r * planeWidth + x] = see('#6e3d12', Math.round((darkLevel / 8) * 170));
      }
      for (const layer of [plain, gustLight, gustDark]) {
        for (let x = GROUND_PERIOD; x < planeWidth; x += 1) layer.px[r * planeWidth + x] = layer.px[r * planeWidth + x - GROUND_PERIOD];
      }
    }

    /* ── the herd ─────────────────────────────────────────────────── */
    const nearCoat = { far: '#3c1c1a', body: '#1c0e13', form: '#2e1719', soft: '#70361c', rim: '#ff9f3f', hot: '#ffe297' };
    const nearCoat2 = { far: '#46211c', body: '#27121a', form: '#39201e', soft: '#823f1e', rim: '#ffa545', hot: '#ffe8a4' };
    const midCoat = { far: '#5a2f20', body: '#361a1a', form: '#432420', soft: '#8f4d20', rim: '#ffac4a', hot: '#ffe59c' };
    const farCoat = { far: '#8a5026', body: '#6a3820', form: '#6a3820', soft: '#b06a28', rim: '#ffc060', hot: '#ffe6a4' };
    const farthestCoat = { far: '#b47e38', body: '#99602c', form: '#99602c', soft: '#c98a3a', rim: '#ffd27c', hot: '#ffe9ac' };
    const big = horseFrames(1.08, { tail: 44, mane: 11, maneLen: 23 }, nearCoat);
    const big2 = horseFrames(1, { tail: 38, mane: 10, maneLen: 18 }, nearCoat2);
    const medium = horseFrames(0.72, { tail: 40, mane: 9, maneLen: 20 }, midCoat);
    const small = horseFrames(0.46, { tail: 38, mane: 7, maneLen: 18 }, farCoat);
    const tiny = horseFrames(0.29, { tail: 34, mane: 5, maneLen: 16 }, farthestCoat);

    /* Who runs where. `dy` keeps a row from being a parade; each is in order, nearest last. */
    const rowsOfHerd = [
      { sheet: tiny, feet: 189, v: 5, margin: 50, list: [[20, -2], [46, 1], [66, -1], [126, 2], [188, 0], [214, -2], [238, 1], [316, -1], [344, 2], [410, 0], [470, -2], [492, 1]] },
      { sheet: small, feet: 204, v: 8, margin: 80, list: [[10, -3], [70, 1], [126, -1], [232, 2], [300, -2], [362, 1], [480, -1], [530, 2]] },
      { sheet: medium, feet: 225, v: 12, margin: 110, list: [[30, -2], [186, 2], [342, -1], [520, 1]] },
      { sheet: big, sheet2: big2, feet: 252, v: 17, margin: 170, list: [[60, 0, 0], [380, 2, 1], [630, -1, 0]] },
    ];
    for (const row of rowsOfHerd) {
      row.span = W + row.margin * 2;
      row.speed = CAMERA * scaleAt(row.feet);
      row.shadow = glowOf(Math.round(row.sheet.s * 54), Math.max(2, Math.round(row.sheet.s * 7)), '#2c1208', 0.74, 0.8);
      row.horses = row.list.map(([x, dy, second], i) => ({ x, dy, sheet: second ? row.sheet2 : row.sheet, phase: (i * 0.37 + x * 0.013) % 1, period: 13 + i * 3 }));
    }

    // Dust: stepped puffs, the colour of low sun in dry air.
    const puffs3 = [3, 5, 8, 12].map((r) => glowOf(r, Math.max(2, Math.round(r * 0.8)), '#ffb868', 0.9, 1));

    /* ── long grass that goes by, in four depths ──────────────────── */
        const tuftsSmall = tuftFrames(rand, 6, 4, rgba('#d0982e'), [rgba('#dba234'), rgba('#f3c552'), rgba('#fff0a8')], false);
    const tuftsMid = tuftFrames(rand, 13, 8, rgba('#b98226'), [rgba('#cf9a2e'), rgba('#f3c552'), rgba('#fff0a8')], true);
    const tuftsBig = tuftFrames(rand, 23, 11, rgba('#996a1f'), [rgba('#b88327'), rgba('#ecba47'), rgba('#fff0a8')], true);
    const tuftsNear = tuftFrames(rand, 42, 20, rgba('#2e1a0c'), [rgba('#5a3414'), rgba('#c9862c'), rgba('#ffe28e')], true);
    const spray = (count, feet, margin, frames) => {
      const list = [];
      const span = W + margin * 2;
      for (let i = 0; i < count; i += 1) list.push({ x: rand() * span, phase: rand() * TAU });
      return { list, feet, span, margin, frames, speed: CAMERA * scaleAt(feet) };
    };
    const grass = {
      far: spray(30, 197, 12, tuftsSmall),
      mid: spray(24, 216, 18, tuftsMid),
      near: spray(15, 240, 28, tuftsBig),
      front: spray(10, 274, 44, tuftsNear),
    };

    /* ── birds ────────────────────────────────────────────────────── */
    const eagle = [-1, -0.45, 0.1, 0.5].map((beat) => {
      const f = new Art(46 * FINE, 24 * FINE);
      const rib = (x0, y0, x1, y1, r0, r1) => limb(f, (23 + x0) * FINE, (13 + y0) * FINE, (23 + x1) * FINE, (13 + y1) * FINE, r0 * FINE, r1 * FINE, BODY_PART);
      rib(-2, 0.6, 4, 0, 1.15, 0.85);
      rib(4, 0, 6.4, 0.8, 0.7, 0.36);
      rib(-2, 0.6, -6, 1.8, 0.8, 1.25);
      for (const side of [-1, 1]) {
        const ex = side * 9;
        const ey = -5 - beat * 3;
        const tx = side * 19;
        const ty = -1 - beat * 8;
        rib(side * 0.5, -0.4, ex, ey, 1.7, 1.35);
        rib(ex, ey, tx, ty, 1.35, 0.7);
        for (let k = 0; k < 4; k += 1) rib(tx - side * k * 1.4, ty + k * 0.5, tx + side * (3.4 - k * 0.6), ty + 1 + k * 1.7, 0.42, 0.3);
      }
const art = new Art(46, 24);
      for (let y = 0; y < 24; y += 1) {
        for (let x = 0; x < 46; x += 1) {
          let n = 0;
          for (let j = 0; j < FINE; j += 1) for (let i = 0; i < FINE; i += 1) if (f.px[(y * FINE + j) * f.w + x * FINE + i]) n += 1;
          if (n >= 4) art.px[y * 46 + x] = rgba('#3a1f2e');
        }
      }
      const edge = [];
      for (let y = 0; y < 24; y += 1) for (let x = 0; x < 46; x += 1) if (art.get(x, y) && (!art.get(x + 1, y) || !art.get(x, y + 1))) edge.push([x, y]);
      for (const [x, y] of edge) art.put(x, y, rgba('#ffb35a'));
      return art.canvas();
    });
    const flock = [];
    for (let i = 0; i < 11; i += 1) {
      const rankRow = Math.ceil(i / 2);
      flock.push({ dx: -rankRow * 8 + rand() * 1.5, dy: (i % 2 ? -1 : 1) * rankRow * 3.2 + rand(), off: i * 0.17 });
    }
    const motes = [];
    for (let i = 0; i < 70; i += 1) motes.push({ x: rand() * W, y: 110 + rand() * 150, z: rand(), v: 12 + rand() * 40, sway: 2 + rand() * 6, period: 3 + rand() * 6, phase: rand() });

    const planeCanvas = plain.canvas();
    const gustLightCanvas = gustLight.canvas();
    const gustDarkCanvas = gustDark.canvas();

    return {
      sky: sky.canvas(), rays: raysArt.canvas(), cloudsHigh, cloudsLow, FAR_RANGE, MID_RANGE, NEAR_RANGE,
      plain: planeCanvas, gustLight: gustLightCanvas, gustDark: gustDarkCanvas,
      rowsOfHerd, puffs3, grass, eagle, flock, motes,
      sunGlow: glowOf(150, 118, '#ffc56e', 0.32, 2),
      glare: glowOf(190, 24, '#fff0b4', 0.56, 1.5),
      haze: glowOf(260, 14, '#ffe0a0', 0.5, 1.3),
    };
  },

  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 + wave(t, 21) * 0.3;
    ctx.drawImage(s.rays, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    slide(ctx, s.cloudsHigh, along(t, 0.7, 960), 4);
    slide(ctx, s.cloudsLow, along(t, 1.3, 960), 92);

    // Three ranges, moving only as far off things move.
    slide(ctx, s.FAR_RANGE, along(t, 0.22, 960), HORIZON - 88);
    slide(ctx, s.MID_RANGE, along(t, 0.5, 960), HORIZON - 88);
    slide(ctx, s.NEAR_RANGE, along(t, 1, 960), HORIZON - 88);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(s.sunGlow, SUN.x - 150, SUN.y - 118);
    ctx.globalCompositeOperation = 'source-over';

    // The eagle, high up and turning slowly; the flock, going about its business.
    const eagleSpan = W + 100;
    const ex = Math.round(((t * 7 + 120) % eagleSpan) - 50);
    const ey = Math.round(34 + wave(t, 37) * 13 + wave(t, 11, 0.3) * 3);
    const beat = wave(t, 9) > 0.55 ? Math.floor(t * 4) % 4 : 2;
    ctx.drawImage(s.eagle[beat], ex - 23, ey - 13);
    const crossing = (t % 58) / 26;
    if (crossing < 1) {
      ctx.fillStyle = '#4a2840';
      const fx = W + 30 - crossing * (W + 110);
      for (const b of s.flock) {
        const x = Math.round(fx - b.dx);
        const y = Math.round(76 + b.dy + wave(t, 7) * 2);
        const up = wave(t, 0.62, b.off) > 0;
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(x - 2, y - (up ? 1 : -1), 2, 1);
        ctx.fillRect(x + 1, y - (up ? 1 : -1), 2, 1);
      }
    }

    // The plain, row by row: each a slice of the same flat ground, seen from further or nearer.
    const cam = t * CAMERA;
    const rows = H - HORIZON;
    for (const [image, cameraAt] of [[s.plain, cam], [s.gustDark, cam + t * 44], [s.gustLight, cam + t * 68]]) {
      for (let r = 0; r < rows; r += 1) {
        const y = HORIZON + r;
        const k = scaleAt(y);
        const width = W / k;
        const u = ((cameraAt - width / 2) % GROUND_PERIOD + GROUND_PERIOD) % GROUND_PERIOD;
        ctx.drawImage(image, u, r, width, 1, 0, y, W, 1);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(s.glare, SUN.x - 190, HORIZON - 12);
    ctx.drawImage(s.haze, 240 - 260, HORIZON - 8);
    ctx.globalCompositeOperation = 'source-over';

    // Grass and horses, from far to near, each depth passing at its own rate.
    const grassLayer = (layer) => {
      for (const g of layer.list) {
        const x = passing(g.x, layer.speed, layer.span, layer.margin, t);
        const bend = Math.sin(g.x * 0.041 + t * 2.3 + g.phase * 0.25) * 0.62 + Math.sin(x * 0.013 + t * 0.9) * 0.38;
        const frame = layer.frames[clamp(Math.floor((bend * 0.5 + 0.5) * 5), 0, 4)];
        ctx.drawImage(frame, Math.round(x - frame.width / 2), layer.feet - frame.height + 1);
      }
    };
    const herdRow = (row) => {
      const { sheet, feet, v, span, margin, speed, shadow } = row;
      const placed = [];
      for (const h of row.horses) {
        const x = ((h.x + t * v) % span) - margin;
        placed.push({ h, x, feetY: feet + h.dy + Math.round(wave(t, h.period, h.phase) * 1.2) });
      }
      // Dust first, behind and under them: it stays with the ground while the horse moves on.
      const scale = sheet.s;
      ctx.globalCompositeOperation = 'lighter';
      for (const p of placed) {
        const lifetime = 2.9;
        const step = lifetime / (scale > 0.8 ? 12 : scale > 0.6 ? 9 : scale > 0.4 ? 6 : 4);
        const youngest = (t + p.h.phase * 3) % step;
        for (let age = youngest; age < lifetime; age += step) {
          const at = t - age;
          const seed = Math.floor((at + p.h.phase * 3) / step + 0.5);
          const jitter = (((seed * 2654435761) >>> 0) % 1000) / 1000;
          const fromX = ((p.h.x + at * v) % span + span) % span - margin - scale * (10 + jitter * 44);
          const x = fromX - age * speed * 0.55;
          const k = age / lifetime;
          const y = p.feetY - scale * 3 - k * scale * (32 + jitter * 28);
          const puff = s.puffs3[clamp(Math.floor(scale * 2.4 + k * 2.8), 0, 3)];
          ctx.globalAlpha = (1 - k) * 0.62;
          ctx.drawImage(puff, Math.round(x - puff.width / 2), Math.round(y - puff.height / 2));
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      for (const p of placed) {
        const sh = shadow;
        ctx.drawImage(sh, Math.round(p.x - sh.width * 0.56), p.feetY - (sh.height >> 1) + 1);
      }
      for (const p of placed) {
        const sprites = p.h.sheet;
        const f = Math.floor(((t / STRIDE_SECONDS + p.h.phase) % 1) * STRIDE_FRAMES);
        ctx.drawImage(sprites.frames[f], Math.round(p.x) - sprites.ox, p.feetY - sprites.oy);
      }
    };
    const [tiny, small, medium, big] = s.rowsOfHerd;
    grassLayer(s.grass.far);
    herdRow(tiny);
    herdRow(small);
    grassLayer(s.grass.mid);
    herdRow(medium);
    grassLayer(s.grass.near);
    herdRow(big);
    grassLayer(s.grass.front);

    // Seeds and specks in the light, going past with the wind.
    for (const m of s.motes) {
      const span = W + 20;
      const x = ((m.x - t * m.v) % span + span) % span - 10;
      const y = m.y + wave(t, m.period, m.phase) * m.sway;
      ctx.fillStyle = m.z > 0.5 ? '#fff4c0' : '#ffd678';
      ctx.fillRect(Math.round(x), Math.round(y), m.z > 0.85 ? 2 : 1, 1);
    }
  },
};

export default goldenHorse;
