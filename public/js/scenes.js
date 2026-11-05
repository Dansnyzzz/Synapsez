/**
 * The animated scenes behind a theme (owner, 2026-11-04): original pixel art, drawn
 * by code on a small canvas and shown large with `image-rendering: pixelated`.
 *
 * Every frame is a pure function of a time in seconds, so a still frame is the same
 * picture every time and nothing keeps a clock of its own. Each motion here is
 * periodic and wraps off-canvas, which is what makes every loop seamless without a
 * loop length to agree on.
 *
 * What costs time is paid once: the sky, the hills and the buildings are painted
 * pixel by pixel into layers when a scene is first needed, and a frame only slides
 * those layers about and draws a few dozen small things over them. One timer runs
 * every scene on screen, about fourteen times a second, and it stops altogether when
 * the tab is hidden, when nothing is playing, or when the person asked for less
 * motion.
 *
 * The art is this file's own. The owner's reference videos set a mood and nothing
 * in them is traced: no signage text, no characters, no logos.
 */

/** The canvas every scene is drawn on. Small on purpose: the pixels are the look. */
export const SCENE_WIDTH = 480;
export const SCENE_HEIGHT = 270;
const W = SCENE_WIDTH;
const H = SCENE_HEIGHT;
const FPS = 14;
const TAU = Math.PI * 2;

/* ── a small painter ───────────────────────────────────────────── */

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, k) => a + (b - a) * k;
const smooth = (k) => k * k * (3 - 2 * k);
/** A number that repeats every `period` seconds, -1 to 1. */
const wave = (t, period, phase = 0) => Math.sin((t / period + phase) * TAU);
/** A position `speed` pixels a second along something `size` wide, in whole pixels. */
const along = (t, speed, size) => (Math.floor(t * speed) % size + size) % size;

/** The same numbers from the same seed, which is what keeps a still frame still. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' as the bytes a canvas holds, opaque. */
const rgba = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0;
};
const ramp = (...hexes) => hexes.map(rgba);

/** Ordered dither, so two colours meet in a pattern rather than in a blend. */
const BAYER = Float32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], (v) => (v + 0.5) / 16);
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

class Art {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.px = new Uint32Array(w * h);
  }

  put(x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[(y | 0) * this.w + (x | 0)] = c;
  }

  /** As `put`, joining the left edge to the right, for a layer that scrolls for ever. */
  wrap(x, y, c) {
    if (y < 0 || y >= this.h) return;
    this.px[(y | 0) * this.w + ((((x | 0) % this.w) + this.w) % this.w)] = c;
  }

  get(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[(y | 0) * this.w + (x | 0)] : 0;
  }

  rect(x, y, w, h, c) {
    for (let j = Math.max(0, y | 0); j < Math.min(this.h, (y | 0) + h); j += 1) {
      for (let i = Math.max(0, x | 0); i < Math.min(this.w, (x | 0) + w); i += 1) this.px[j * this.w + i] = c;
    }
  }

  /** A colour from a ramp, its edges dithered. `v` runs 0 to 1. */
  tone(x, y, colours, v, spread = 0.8) {
    const n = colours.length - 1;
    const i = Math.round(clamp(v) * n + (bayer(x, y) - 0.5) * spread);
    this.put(x, y, colours[i < 0 ? 0 : i > n ? n : i]);
  }

  /** Fill by a function of position, returning 0 to 1, or a negative for nothing. */
  shade(colours, fn, spread = 0.8, box = [0, 0, this.w, this.h]) {
    for (let y = Math.max(0, box[1]); y < Math.min(this.h, box[3]); y += 1) {
      for (let x = Math.max(0, box[0]); x < Math.min(this.w, box[2]); x += 1) {
        const v = fn(x, y);
        if (v >= 0) this.tone(x, y, colours, v, spread);
      }
    }
  }

  disc(cx, cy, r, c) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= cy + r; y += 1) {
      for (let x = Math.floor(cx - r); x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) this.put(x, y, c);
    }
  }

  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y += 1) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x += 1) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.put(x, y, c);
    }
  }

  line(x0, y0, x1, y1, c) {
    let [x, y] = [Math.round(x0), Math.round(y0)];
    const [tx, ty] = [Math.round(x1), Math.round(y1)];
    const dx = Math.abs(tx - x);
    const dy = -Math.abs(ty - y);
    const sx = x < tx ? 1 : -1;
    const sy = y < ty ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.put(x, y, c);
      if (x === tx && y === ty) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** A filled shape from its corners. `paint` may be one colour or a function of x, y. */
  poly(points, paint) {
    const ys = points.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y += 1) {
      const cuts = [];
      for (let i = 0; i < points.length; i += 1) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) cuts.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
      }
      cuts.sort((a, b) => a - b);
      for (let k = 0; k + 1 < cuts.length; k += 2) {
        for (let x = Math.round(cuts[k]); x < Math.round(cuts[k + 1]); x += 1) {
          if (typeof paint === 'function') paint(x, y);
          else this.put(x, y, paint);
        }
      }
    }
  }

  /** The layer as something a frame can draw. */
  canvas() {
    const out = document.createElement('canvas');
    out.width = this.w;
    out.height = this.h;
    const data = new window.ImageData(new Uint8ClampedArray(this.px.buffer), this.w, this.h);
    out.getContext('2d').putImageData(data, 0, 0);
    return out;
  }
}

/** Smooth noise along a line. `period` makes it join up, for a layer that wraps. */
function noise1(seed, period = 256) {
  const rand = seeded(seed);
  const table = Float32Array.from({ length: period }, () => rand());
  return (x) => {
    const i = Math.floor(x);
    const k = smooth(x - i);
    const a = table[((i % period) + period) % period];
    const b = table[(((i + 1) % period) + period) % period];
    return mix(a, b, k);
  };
}

/** Smooth noise over a plane, joined at `period` both ways. */
function noise2(seed, period = 128) {
  const rand = seeded(seed);
  const table = Float32Array.from({ length: period * period }, () => rand());
  const at = (x, y) => table[((((y % period) + period) % period) * period) + (((x % period) + period) % period)];
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const kx = smooth(x - ix);
    const ky = smooth(y - iy);
    return mix(mix(at(ix, iy), at(ix + 1, iy), kx), mix(at(ix, iy + 1), at(ix + 1, iy + 1), kx), ky);
  };
}

/** Layers of noise, large to small; 0 to 1. */
const fbm1 = (fn, x, octaves = 4) => {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let total = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += fn(x * f + i * 17) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
};
const fbm2 = (fn, x, y, octaves = 4) => {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let total = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += fn(x * f + i * 13, y * f + i * 7) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
};
/** Sharp-topped noise, for mountains. */
const ridged = (fn, x, octaves = 5) => {
  let sum = 0;
  let amp = 0.55;
  let f = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += (1 - Math.abs(fn(x * f + i * 31) * 2 - 1)) * amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum;
};

/**
 * Round masses lit from one side: a cloud, a tree's crown. A union of balls, each
 * pixel shaded by the ball nearest the eye and by how high it is in the mass, so the
 * balls read as lumps on one thing rather than as a heap of separate boulders.
 *
 * @param {Art} art
 * @param {{x:number,y:number,r:number,z?:number}[]} list
 * @param {number[]} colours  dark to light
 * @param {{ base?: number, wrap?: boolean, light?: number[], spread?: number, lift?: number, height?: number, grain?: (x:number,y:number)=>number, flat?: number }} [o]
 *   `height` is how much of the shade comes from the height in the mass, 0 to 1;
 *   `lift` moves everything lighter; `flat` how far up a flat underside darkens.
 */
function puffs(art, list, colours, o = {}) {
  const { base = Infinity, wrap = false, light = [-0.45, -0.8, 0.4], spread = 0.7, lift = 0, height = 0.5, grain = null, flat = 7 } = o;
  const len = Math.hypot(...light);
  const [lx, ly, lz] = light.map((v) => v / len);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of list) {
    x0 = Math.min(x0, p.x - p.r);
    x1 = Math.max(x1, p.x + p.r);
    y0 = Math.min(y0, p.y - p.r);
    y1 = Math.max(y1, p.y + p.r);
  }
  const top = y0;
  const span = Math.max(1, Math.min(y1, base) - y0);
  y1 = Math.min(y1, base);
  for (let y = Math.floor(y0); y <= y1; y += 1) {
    if (y < 0 || y >= art.h) continue;
    for (let x = Math.floor(x0); x <= x1; x += 1) {
      let best = -Infinity;
      let shade = 0;
      for (const p of list) {
        const dx = x - p.x;
        const dy = y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > p.r * p.r) continue;
        const nz = Math.sqrt(p.r * p.r - d2);
        const z = nz + (p.z || 0);
        if (z > best) {
          best = z;
          shade = (dx * lx + dy * ly + nz * lz) / p.r;
        }
      }
      if (best === -Infinity) continue;
      let v = mix(shade * 0.5 + 0.5, 1 - (y - top) / span, height) + lift;
      if (grain) v += grain(x, y);
      if (base !== Infinity) v -= smooth(clamp((y - (base - flat)) / flat)) * 0.28;
      if (wrap) {
        const n = colours.length - 1;
        const i = Math.round(clamp(v) * n + (bayer(x, y) - 0.5) * spread);
        art.wrap(x, y, colours[i < 0 ? 0 : i > n ? n : i]);
      } else art.tone(x, y, colours, v, spread);
    }
  }
}

/**
 * A cloud's balls: tallest in the middle, flat along `base`, and big ones crowded
 * with small ones so its edge is a scallop and not a curve.
 */
function cumulus(rand, cx, base, width, height) {
  const list = [];
  const cores = Math.max(4, Math.round(width / 22));
  for (let i = 0; i < cores; i += 1) {
    const at = (i + 0.5) / cores * 2 - 1 + (rand() - 0.5) * 0.2;
    const bell = Math.max(0.08, 1 - at * at);
    const r = height * (0.2 + 0.34 * bell) * (0.85 + rand() * 0.3);
    const ball = { x: cx + at * width * 0.5, y: base - r * 0.55 - height * bell * (0.1 + rand() * 0.34), r, z: rand() * 3 };
    list.push(ball);
    const buds = 4 + Math.floor(rand() * 4);
    for (let k = 0; k < buds; k += 1) {
      const a = -Math.PI * (0.05 + rand() * 0.9);
      const small = r * (0.26 + rand() * 0.26);
      list.push({ x: ball.x + Math.cos(a) * r * 0.86, y: ball.y + Math.sin(a) * r * 0.86, r: small, z: rand() * 3 - 1 });
    }
  }
  // A skirt, so the underside is one line.
  for (let i = 0; i < cores * 2; i += 1) {
    const at = (i + 0.5) / (cores * 2) * 2 - 1;
    const r = height * (0.12 + rand() * 0.1) * (0.6 + 0.6 * (1 - at * at));
    list.push({ x: cx + at * width * 0.55, y: base - r * 0.7, r, z: -3 });
  }
  return list;
}

/** A sprite from rows of letters; a space is nothing. */
function sprite(rows, colours) {
  const art = new Art(Math.max(...rows.map((r) => r.length)), rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (colours[ch]) art.put(x, y, rgba(colours[ch]));
    });
  });
  return art.canvas();
}

/** A layer that wraps, drawn twice where it crosses the seam. */
function slide(ctx, image, offset, y = 0) {
  const w = image.width;
  const x = -(((offset % w) + w) % w);
  ctx.drawImage(image, x, y);
  if (x + w < W) ctx.drawImage(image, x + w, y);
}

/* ── the scenes ────────────────────────────────────────────────── */

/* The rest of the file is one builder per scene: `build` paints the layers once,
   `draw` makes a frame from them, and `still` is the moment shown when not playing. */

/** Pale sky, drifting clouds. */
const cloudDrift = {
  mode: 'light',
  focus: [0.5, 0.42],
  still: 16,
  build() {
    const rand = seeded(1101);
    const SKY = ramp('#4f9fe0', '#60aae6', '#73b6ec', '#87c2f0', '#9ccdf3', '#b1d8f6', '#c6e3f8', '#d9ecfa', '#e9f4fb', '#f5faf9', '#fffdf2');
    const sky = new Art();
    const [sx, sy] = [368, 42];
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot(x - sx, (y - sy) * 1.15);
      return clamp(0.08 + (y / H) * 0.72 + 0.55 * Math.exp(-((d / 88) ** 2)) + 0.18 * Math.exp(-((d / 190) ** 2)));
    }, 0.95);
    sky.disc(sx, sy, 15, rgba('#fffef6'));
    sky.disc(sx, sy, 12, rgba('#ffffff'));

    // Thin streaks, high up: stretched noise and a dither, so they have no edge.
    const cirrus = new Art(960, 96);
    const wisp = noise2(1102, 64);
    const CIRRUS = rgba('#f4fafd');
    for (let y = 0; y < 96; y += 1) {
      for (let x = 0; x < 960; x += 1) {
        const n = fbm2(wisp, (x / 960) * 16, (y / 96) * 22, 3) - 0.56 - Math.abs(y - 42) / 900;
        if (n * 6.5 > bayer(x, y)) cirrus.put(x, y, CIRRUS);
      }
    }

    // Far: a low band, close to the colour of the sky.
    const FAR = ramp('#a9d0ee', '#bedcf3', '#d2e7f7', '#e6f2fa', '#f7fbfd');
    const far = new Art(960, 96);
    for (let i = 0; i < 11; i += 1) {
      const cx = (i + rand() * 0.7) * (960 / 11);
      puffs(far, cumulus(rand, cx, 88 - rand() * 18, 50 + rand() * 66, 16 + rand() * 22), FAR, { base: 88, wrap: true, spread: 0.5, height: 0.55, lift: 0.08 });
    }

    // Middle: the clouds somebody looks at.
    const MID = ramp('#8fb9de', '#a9cce9', '#c5dff2', '#deedf8', '#f2f8fc', '#ffffff');
    const mid = new Art(1200, 190);
    const midAt = [[90, 150, 146, 58], [300, 92, 110, 40], [520, 170, 176, 74], [760, 110, 124, 44], [965, 158, 150, 62], [1130, 78, 96, 32]];
    for (const [cx, base, w, h] of midAt) puffs(mid, cumulus(rand, cx, base, w, h), MID, { base, wrap: true, spread: 0.5, height: 0.82, lift: 0.1 });

    // Near: a floor of cloud, the whole way round.
    const NEAR = ramp('#88b2da', '#a3c7e6', '#c0dbf1', '#dbebf7', '#f0f7fb', '#ffffff');
    const near = new Art(1440, 112);
    const floorPuffs = [];
    for (let i = 0; i < 46; i += 1) {
      const x = (i / 46) * 1440 + rand() * 10;
      const swell = 0.5 + 0.5 * Math.sin((x / 1440) * TAU * 4 + 1);
      const r = 14 + rand() * 12 + swell * 12;
      const ball = { x, y: 92 - swell * 30 + rand() * 10, r, z: rand() * 4 };
      floorPuffs.push(ball);
      for (let k = 0; k < 5; k += 1) {
        const a = -Math.PI * (0.05 + rand() * 0.9);
        floorPuffs.push({ x: x + Math.cos(a) * r * 0.85, y: ball.y + Math.sin(a) * r * 0.85, r: r * (0.24 + rand() * 0.24), z: rand() * 3 - 1 });
      }
    }
    puffs(near, floorPuffs, NEAR, { wrap: true, spread: 0.5, height: 0.8, lift: 0.12 });
    for (let y = 70; y < 112; y += 1) for (let x = 0; x < 1440; x += 1) if (!near.get(x, y)) near.tone(x, y, NEAR, 0.86, 0.5);

    // A small balloon, for the one warm colour on the page.
    const balloon = new Art(21, 33);
    const STRIPES = [ramp('#c84a3f', '#e8604c', '#fb8567'), ramp('#d9b98c', '#f3dcb2', '#fff4d8')];
    for (let y = 0; y < 22; y += 1) {
      const k = y / 21;
      const half = k < 0.62 ? Math.sqrt(1 - ((k - 0.48) / 0.5) ** 2) * 10 : mix(9.5, 3, (k - 0.62) / 0.38);
      for (let x = -Math.round(half); x <= Math.round(half); x += 1) {
        const u = x / Math.max(1, half);
        const band = Math.floor((Math.asin(clamp(u, -1, 1)) / Math.PI + 0.5) * 6) % 2;
        balloon.tone(10 + x, y, STRIPES[band], clamp(0.75 - u * 0.5 - k * 0.25), 0.55);
      }
    }
    balloon.rect(8, 27, 5, 4, rgba('#7c5238'));
    balloon.rect(8, 27, 5, 1, rgba('#a97a52'));
    for (const [a, b] of [[7, 8], [13, 12]]) balloon.line(a, 22, b, 27, rgba('#8a6a50'));

    return {
      sky: sky.canvas(),
      cirrus: cirrus.canvas(),
      far: far.canvas(),
      mid: mid.canvas(),
      near: near.canvas(),
      balloon: balloon.canvas(),
    };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    // The sun's edge breathes: a ring of single pixels, on a period of its own.
    ctx.fillStyle = '#fffdf0';
    const ring = 19 + Math.round((wave(t, 11) + 1) * 2);
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * TAU + t / 40;
      ctx.fillRect(368 + Math.round(Math.cos(a) * ring), 42 + Math.round(Math.sin(a) * ring), 1, 1);
    }
    slide(ctx, s.cirrus, along(t, 0.55, 960), 6);
    slide(ctx, s.far, along(t, 1.05, 960), 112);
    // The far balloon sits between the far band and the middle clouds.
    const bx = W + 22 - ((t * 2.4) % (W + 70));
    ctx.drawImage(s.balloon, Math.round(bx), Math.round(84 + wave(t, 13) * 4));
    slide(ctx, s.mid, along(t, 2.1, 1200), 8);
    // A few birds now and then.
    const pass = (t % 53) / 17;
    if (pass < 1) {
      ctx.fillStyle = '#4c78a6';
      const flap = Math.floor(t * 2.5) % 2;
      for (const [dx, dy] of [[0, 0], [9, -3], [9, 4], [18, -6], [18, 7]]) {
        const x = Math.round(W + 20 - pass * (W + 80)) + dx;
        const y = Math.round(58 + wave(t, 9) * 3) + dy;
        ctx.fillRect(x - 1, y - flap, 1, 1);
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(x + 1, y - flap, 1, 1);
      }
    }
    slide(ctx, s.near, along(t, 4, 1440), H - 112);
  },
};

/** Stars for a night sky: a few fixed, the rest breathing at their own pace. */
function starField(rand, count, maxY) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const big = rand() < 0.1;
    stars.push({ x: Math.floor(rand() * W), y: Math.floor(rand() * rand() * maxY), big, period: 3 + rand() * 9, phase: rand(), tone: rand() < 0.2 ? '#ffe9c4' : rand() < 0.4 ? '#c9dcff' : '#ffffff' });
  }
  return stars;
}

function drawStars(ctx, stars, t) {
  for (const s of stars) {
    const glow = 0.45 + 0.55 * (wave(t, s.period, s.phase) * 0.5 + 0.5);
    ctx.globalAlpha = glow;
    ctx.fillStyle = s.tone;
    ctx.fillRect(s.x, s.y, 1, 1);
    if (s.big && glow > 0.72) {
      ctx.globalAlpha = (glow - 0.72) * 2.4;
      ctx.fillRect(s.x - 1, s.y, 3, 1);
      ctx.fillRect(s.x, s.y - 1, 1, 3);
    }
  }
  ctx.globalAlpha = 1;
}

/** A ridge of land, lit from one side, its height a function of x. */
function ridge(art, height, colours, { light = 0.5, spread = 0.8, depth = 60 } = {}) {
  for (let x = 0; x < art.w; x += 1) {
    const top = Math.round(height(x));
    const slope = height(x + 3) - height(x - 3);
    for (let y = Math.max(0, top); y < art.h; y += 1) {
      const fall = clamp((y - top) / depth);
      art.tone(x, y, colours, clamp(light + slope * 0.03 - fall * 0.42), spread);
    }
  }
}

/** A dark fir: stacked skirts, narrow at the top. */
function fir(art, x, base, height, colours, rand, wrap = false) {
  const half = height * 0.24;
  for (let y = 0; y < height; y += 1) {
    const k = y / height;
    const skirt = (k * 6) % 1;
    const w = half * k * (0.72 + skirt * 0.42);
    for (let dx = -Math.round(w); dx <= Math.round(w); dx += 1) {
      const v = clamp(0.3 + (dx < 0 ? 0.12 : -0.08) * (Math.abs(dx) / Math.max(1, w)) + (1 - skirt) * 0.3 - 0.1 + (rand() - 0.5) * 0.08);
      const n = colours.length - 1;
      const c = colours[Math.round(v * n)];
      if (wrap) art.wrap(x + dx, base - height + y, c);
      else art.put(x + dx, base - height + y, c);
    }
  }
}

/** Indigo night: a crescent, stars that breathe, cloud sliding under the moon, a village asleep. */
const moonNight = {
  mode: 'dark',
  focus: [0.55, 0.4],
  still: 30,
  build() {
    const rand = seeded(2201);
    const [mx, my] = [356, 62];
    const SKY = ramp('#090e2a', '#0c1333', '#10193e', '#141f4a', '#1a2858', '#213167', '#2a3c78', '#354989', '#42589a', '#5369aa');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot(x - mx, (y - my) * 1.1);
      return clamp(0.04 + (y / H) * 0.44 + 0.62 * Math.exp(-((d / 96) ** 2)) + 0.16 * Math.exp(-((d / 210) ** 2)));
    }, 0.95);

    const moon = new Art(64, 64);
    const MOON = ramp('#b9a878', '#dcc98e', '#f1e0a8', '#fbf0c4', '#fff9e2');
    const craters = [[20, 22, 3], [14, 36, 2], [25, 44, 3], [12, 26, 1.5], [18, 50, 2]];
    moon.shade(MOON, (x, y) => {
      const inside = Math.hypot(x - 32, y - 32) <= 25;
      const cut = Math.hypot(x - 43, y - 25) <= 22;
      if (!inside || cut) return -1;
      let v = clamp(0.92 - Math.hypot(x - 22, y - 34) / 42);
      for (const [cx, cy, r] of craters) if (Math.hypot(x - cx, y - cy) <= r) v -= 0.22;
      return clamp(v);
    }, 0.6);

    const FAR = ramp('#141c47', '#1b2655', '#253367', '#33437b', '#475a93');
    const far = new Art(960, 110);
    for (let i = 0; i < 9; i += 1) {
      const cx = (i + rand() * 0.7) * (960 / 9);
      const base = 98 - rand() * 28;
      puffs(far, cumulus(rand, cx, base, 70 + rand() * 90, 16 + rand() * 18), FAR, { base, wrap: true, spread: 0.55, height: 0.7, light: [0.5, -0.8, 0.3], flat: 5 });
    }
    const NEAR = ramp('#111840', '#1b2552', '#293769', '#3f5186', '#6579ad', '#94a5d0');
    const near = new Art(1200, 130);
    for (const [cx, base, w, h] of [[120, 104, 190, 46], [430, 86, 130, 30], [700, 112, 230, 56], [1010, 92, 150, 34]]) {
      puffs(near, cumulus(rand, cx, base, w, h), NEAR, { base, wrap: true, spread: 0.55, height: 0.72, light: [0.5, -0.8, 0.3], flat: 6 });
    }

    const hillNoise = noise1(2202, 256);
    const land = new Art(W, 96);
    const BACK = ramp('#0a1032', '#0f173f', '#16204e', '#1f2c5f');
    ridge(land, (x) => 24 + fbm1(hillNoise, x / 60, 3) * 40, BACK, { light: 0.72, depth: 80 });
    const FRONT = ramp('#050819', '#080c24', '#0c1230', '#121a3e');
    const front = (x) => 58 + fbm1(hillNoise, (x + 700) / 44, 3) * 26;
    ridge(land, front, FRONT, { light: 0.62, depth: 44 });
    for (let i = 0; i < 46; i += 1) {
      const x = Math.floor(rand() * W);
      fir(land, x, Math.round(front(x)) + 2, 8 + rand() * 12, FRONT, rand);
    }
    // A hamlet: houses as simple blocks with a roof, each window remembered for the night.
    const windows = [];
    for (const hx of [68, 96, 118, 212, 238, 372, 402, 430]) {
      const top = Math.round(front(hx)) - 5;
      land.rect(hx - 6, top, 13, 10, rgba('#0d1330'));
      for (let k = 0; k < 7; k += 1) land.rect(hx - 7 + k, top - k + 1, 15 - k * 2, 1, rgba('#070b22'));
      windows.push({ x: hx - 3, y: top + 3 + (H - 96), period: 7 + rand() * 13, phase: rand() });
      if (rand() > 0.3) windows.push({ x: hx + 2, y: top + 3 + (H - 96), period: 9 + rand() * 17, phase: rand() });
    }
    return { sky: sky.canvas(), moon: moon.canvas(), far: far.canvas(), near: near.canvas(), land: land.canvas(), stars: starField(rand, 170, 190), windows };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    drawStars(ctx, s.stars, t);
    ctx.drawImage(s.moon, 324, 30);
    slide(ctx, s.far, along(t, 0.9, 960), 66);
    // Now and then a star falls: a short bright line, only for a moment.
    const fall = (t % 41) / 1.1;
    if (fall < 1) {
      for (let i = 0; i < 12; i += 1) {
        ctx.globalAlpha = (1 - i / 12) * (1 - fall);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(120 + fall * 120 - i * 2), Math.round(30 + fall * 44 - i * 0.75), 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    slide(ctx, s.near, along(t, 1.8, 1200), 92);
    ctx.drawImage(s.land, 0, H - 96);
    for (const w of s.windows) {
      const on = wave(t, w.period, w.phase) > -0.45;
      ctx.fillStyle = on ? (wave(t, 2.3, w.phase) > 0.9 ? '#ffe9a8' : '#ffc968') : '#141a38';
      ctx.fillRect(w.x, w.y, 2, 2);
    }
  },
};

/** A turtle seen from above, in three strokes of its flippers. */
function turtleFrames() {
  const SHELL = ramp('#2f5a3c', '#3f7349', '#558c55', '#74a662', '#98bd76');
  const SKIN = ramp('#6d8b58', '#86a56a', '#a3bd7e');
  const frames = [];
  for (const stroke of [0, 1, 2, 1]) {
    const art = new Art(64, 72);
    const cx = 32;
    const cy = 38;
    const flip = [-0.7, 0, 0.7][stroke];
    const flipper = (side, ax, ay, length, angle, width) => {
      const dx = Math.cos(angle) * side;
      const dy = Math.sin(angle);
      for (let i = 0; i <= length; i += 1) {
        const w = width * Math.sin((i / length) * Math.PI * 0.92 + 0.12);
        for (let k = -w; k <= w; k += 0.5) {
          const v = clamp(0.5 + k / (width * 2));
          art.tone(cx + side * ax + dx * i - dy * k, ay + dy * i + dx * k * side, SKIN, v, 0.5);
        }
      }
    };
    flipper(-1, 13, cy - 11, 22, -0.75 + flip, 5);
    flipper(1, 13, cy - 11, 22, -0.75 + flip, 5);
    flipper(-1, 11, cy + 15, 11, 0.7 - flip * 0.4, 3.4);
    flipper(1, 11, cy + 15, 11, 0.7 - flip * 0.4, 3.4);
    art.ellipse(cx, cy - 26, 6, 7, SKIN[1]);
    art.ellipse(cx - 1, cy - 28, 3, 3, SKIN[2]);
    art.rect(cx - 5, cy - 29, 1, 2, rgba('#1d2a1c'));
    art.rect(cx + 4, cy - 29, 1, 2, rgba('#1d2a1c'));
    art.shade(SHELL, (x, y) => {
      const e = ((x - cx) / 17) ** 2 + ((y - cy) / 21) ** 2;
      if (e > 1) return -1;
      const hx = Math.abs(((x - cx + 60) % 12) - 6);
      const hy = Math.abs(((y - cy + 60 + (Math.floor((x - cx + 60) / 12) % 2) * 6) % 12) - 6);
      const seam = hx < 1 || hy < 1 ? 0.3 : 0;
      return clamp(0.86 - e * 0.5 - seam - (x - cx) * 0.012 + (y < cy ? 0.08 : 0));
    }, 0.55);
    frames.push(art.canvas());
  }
  return frames;
}

/** Turquoise water seen from above: a sand bar, coral, a turtle, a school of small fish. */
const lagoon = {
  mode: 'light',
  focus: [0.5, 0.5],
  still: 22,
  build() {
    const rand = seeded(3301);
    const WATER = ramp('#0a7fa6', '#0c8fb2', '#10a0bd', '#17b1c6', '#25c1cd', '#3bcfd2', '#58dbd6', '#7ae5da', '#a0ecdf', '#c5f2e3', '#e6f5dc', '#f5efc7');
    const SAND = ramp('#d8b77c', '#e6cb93', '#f0dcab', '#f8e9c4', '#fff4db');
    const bed = noise2(3302, 64);
    const shore = (x, y) => {
      // The distance to two sand bars, on the top right and the bottom left.
      const a = Math.hypot((x - 430) / 1.5, y + 24) - 92;
      const b = Math.hypot((x - 40) / 1.7, y - 300) - 104;
      return Math.min(a, b);
    };
    const water = new Art();
    water.shade(WATER, (x, y) => {
      const d = shore(x, y) + (fbm2(bed, x / 26, y / 26, 3) - 0.5) * 32;
      const shallow = clamp(1 - d / 150);
      return d < 0 ? 1 : clamp(0.06 + shallow * 0.88 + (fbm2(bed, x / 14 + 9, y / 14, 3) - 0.5) * 0.2);
    }, 0.95);
    water.shade(SAND, (x, y) => {
      const d = shore(x, y) + (fbm2(bed, x / 16, y / 16, 3) - 0.5) * 12;
      if (d > 0) return -1;
      return clamp(0.5 + d / 90 + (fbm2(bed, x / 5, y / 5, 2) - 0.5) * 0.5);
    }, 0.7);

    // Coral: small clusters on the edge of the deep, each a warm cluster of balls.
    const CORALS = [ramp('#a33a56', '#d15a70', '#ef8791', '#f8b4ab'), ramp('#b16a2d', '#d99444', '#f0b969', '#f9d898'), ramp('#6a3f96', '#8d5fbd', '#b48bd8', '#d4b9ec')];
    for (const [cx, cy, n] of [[52, 92, 7], [120, 42, 5], [188, 232, 6], [300, 248, 5], [438, 170, 7], [352, 118, 4]]) {
      const colours = CORALS[Math.floor(rand() * CORALS.length)];
      const list = [];
      for (let i = 0; i < n * 9; i += 1) {
        const a = rand() * TAU;
        const k = rand() ** 0.7;
        list.push({ x: cx + Math.cos(a) * k * 15, y: cy + Math.sin(a) * k * 10, r: 1.2 + rand() * 2.4, z: rand() * 2 });
      }
      puffs(water, list, colours, { spread: 0.7, height: 0.6 });
    }

    // Light on the water: two fine nets of noise that slide against each other.
    const net = (seed, ink) => {
      const n = noise2(seed, 48);
      const art = new Art(480, 270);
      const c = rgba(ink);
      for (let y = 0; y < 270; y += 1) {
        for (let x = 0; x < 480; x += 1) {
          const v = Math.abs(fbm2(n, (x / 480) * 36, (y / 270) * 20, 2) - 0.5);
          if (v < 0.011 && bayer(x, y) < 0.62) art.px[y * 480 + x] = c;
        }
      }
      return art.canvas();
    };
    // The foam along each sand bar, as points to shimmer.
    const foam = [];
    for (let x = 0; x < W; x += 2) {
      for (let y = 0; y < H; y += 2) {
        const d = shore(x, y) + (fbm2(bed, x / 16, y / 16, 3) - 0.5) * 12;
        if (d > 0 && d < 7) foam.push({ x, y, phase: rand(), d });
      }
    }
    const fish = [];
    for (let i = 0; i < 26; i += 1) fish.push({ dx: (rand() - 0.5) * 66, dy: (rand() - 0.5) * 34, phase: rand(), tone: rand() < 0.75 ? '#ff9a3d' : '#ffe27a' });
    return { water: water.canvas(), netA: net(3303, '#d6fbf3'), netB: net(3304, '#bff4ef'), turtle: turtleFrames(), foam, fish };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.water, 0, 0);
    ctx.globalAlpha = 0.42;
    slide(ctx, s.netA, along(t, 3, 480));
    ctx.globalAlpha = 0.3;
    slide(ctx, s.netB, -along(t, 2, 480));
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    for (const f of s.foam) {
      if (wave(t, 4.7, f.phase + f.d / 14) > 0.55) ctx.fillRect(f.x, f.y, 1, 1);
    }

    // The school turns as one, on a slow figure of eight.
    const sx = 150 + Math.sin(t / 17) * 110;
    const sy = 150 + Math.sin(t / 8.5) * 52;
    const heading = Math.atan2(Math.cos(t / 8.5) * 52 / 8.5, Math.cos(t / 17) * 110 / 17);
    for (const f of s.fish) {
      const x = Math.round(sx + f.dx + Math.sin(t * 0.9 + f.phase * 9) * 3);
      const y = Math.round(sy + f.dy + Math.cos(t * 0.8 + f.phase * 9) * 3);
      ctx.fillStyle = 'rgba(6,90,110,0.28)';
      ctx.fillRect(x + 3, y + 5, 4, 2);
      ctx.fillStyle = f.tone;
      ctx.fillRect(x, y, 4, 2);
      ctx.fillRect(x + Math.round(Math.cos(heading + Math.PI) * 3), y + Math.round(Math.sin(heading + Math.PI) * 3), 2, 2);
    }

    // The turtle crosses in about a minute and a half, in a long lazy curve.
    const span = W + 180;
    const pass = (t / 90) % 1;
    const tx = -90 + pass * span;
    const ty = 138 + Math.sin(pass * TAU * 1.5) * 34;
    const frame = s.turtle[Math.floor(t * 2.2) % s.turtle.length];
    const face = Math.PI / 2 + Math.atan2(Math.cos(pass * TAU * 1.5) * 34 * TAU * 1.5 / span, 1);
    ctx.save();
    ctx.translate(Math.round(tx + 8), Math.round(ty + 12));
    ctx.rotate(face);
    ctx.globalAlpha = 0.22;
    ctx.filter = 'brightness(0)';
    ctx.drawImage(frame, -32, -36);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.save();
    ctx.translate(Math.round(tx), Math.round(ty));
    ctx.rotate(face);
    ctx.drawImage(frame, -32, -36);
    ctx.restore();
  },
};

/** A forest at night: three depths of trees, low mist, grass that moves, fireflies. */
const fireflyGrove = {
  mode: 'dark',
  focus: [0.5, 0.65],
  still: 18,
  build() {
    const rand = seeded(4401);
    const SKY = ramp('#040d12', '#06141a', '#091d22', '#0d272a', '#123332', '#1a4140', '#25524c', '#35675a', '#4a7f69');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot((x - 250) / 1.6, y - 128);
      return clamp(0.08 + 0.88 * Math.exp(-((d / 118) ** 2)) + (y / H) * 0.05);
    }, 0.95);

    const FAR = ramp('#0f2d2d', '#143836', '#1a443f', '#225148');
    const far = new Art();
    const farNoise = noise1(4402, 256);
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(140 + fbm1(farNoise, x / 30, 3) * 40);
      for (let y = top; y < H; y += 1) far.tone(x, y, FAR, clamp(0.72 - (y - top) / 170), 0.9);
    }
    for (let i = 0; i < 40; i += 1) {
      const x = Math.floor(rand() * W);
      fir(far, x, 196 + Math.floor(rand() * 18), 44 + rand() * 46, FAR, rand);
    }

    const MID = ramp('#071a1c', '#0a2224', '#0f2c2c', '#153a36');
    const mid = new Art();
    for (let i = 0; i < 26; i += 1) {
      const x = Math.floor((i / 26) * W + rand() * 14);
      fir(mid, x, 226 + Math.floor(rand() * 12), 86 + rand() * 80, MID, rand);
    }
    const midGround = noise1(4403, 128);
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(216 + fbm1(midGround, x / 40, 2) * 14);
      for (let y = top; y < H; y += 1) mid.tone(x, y, MID, clamp(0.5 - (y - top) / 90), 0.8);
    }

    const NEAR = ramp('#020708', '#040c0e', '#071314', '#0a1b1b');
    const near = new Art();
    // Two great trunks frame the middle; each has a mossed, lit edge.
    for (const [cx, half] of [[42, 25], [438, 31]]) {
      for (let y = 0; y < H; y += 1) {
        const swell = half + Math.sin(y / 34) * 2 + Math.max(0, y - 214) * 0.34;
        for (let x = Math.round(cx - swell); x <= cx + swell; x += 1) {
          const u = (x - cx) / swell;
          near.tone(x, y, NEAR, clamp(0.34 + (cx < 200 ? u : -u) * 0.34 + Math.sin((x + y * 0.2) / 3) * 0.07), 0.8);
        }
      }
    }
    // Boughs from the top, a roof of dark leaves.
    const roof = [];
    for (let i = 0; i < 90; i += 1) {
      const x = rand() * W;
      const edge = Math.abs(x - 240) / 240;
      roof.push({ x, y: rand() * (18 + edge * 62) - 12, r: 8 + rand() * 18, z: rand() * 3 });
    }
    puffs(near, roof, NEAR, { spread: 0.8, height: 0.45, light: [0, 1, 0.3] });
    const grassBand = noise1(4404, 128);
    const groundY = (x) => 240 + fbm1(grassBand, x / 34, 2) * 14;
    for (let x = 0; x < W; x += 1) {
      for (let y = Math.round(groundY(x)); y < H; y += 1) near.tone(x, y, NEAR, clamp(0.5 - (y - groundY(x)) / 40), 0.8);
    }

    const mist = new Art(960, 70);
    const mistNoise = noise2(4405, 64);
    const MIST = rgba('#bfe6d2');
    for (let y = 0; y < 70; y += 1) {
      for (let x = 0; x < 960; x += 1) {
        const v = fbm2(mistNoise, (x / 960) * 16, (y / 70) * 4, 3) * (1 - Math.abs(y - 35) / 35);
        if (v * 1.5 > 0.32 + bayer(x, y) * 0.62) mist.put(x, y, MIST);
      }
    }

    const blades = [];
    for (let i = 0; i < 240; i += 1) {
      const x = Math.floor(rand() * W);
      blades.push({ x, y: Math.round(groundY(x)) + 2, h: 3 + Math.floor(rand() * 7), phase: rand(), tone: rand() < 0.5 ? '#0d2a24' : rand() < 0.5 ? '#123529' : '#0a2020' });
    }
    const flies = [];
    for (let i = 0; i < 48; i += 1) {
      flies.push({ x: 40 + rand() * 400, y: 100 + rand() * 150, ax: 14 + rand() * 30, ay: 8 + rand() * 18, p1: 9 + rand() * 16, p2: 7 + rand() * 13, p3: 2.4 + rand() * 3.6, phase: rand() });
    }
    return { sky: sky.canvas(), far: far.canvas(), mid: mid.canvas(), near: near.canvas(), mist: mist.canvas(), blades, flies };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    ctx.drawImage(s.far, 0, 0);
    ctx.globalAlpha = 0.16;
    slide(ctx, s.mist, along(t, 1.1, 960), 158);
    ctx.globalAlpha = 1;
    ctx.drawImage(s.mid, 0, 0);
    ctx.globalAlpha = 0.09;
    slide(ctx, s.mist, -along(t, 1.7, 960), 200);
    ctx.globalAlpha = 1;
    for (const f of s.flies) {
      const x = Math.round(f.x + Math.sin(t / f.p1 * TAU + f.phase * 9) * f.ax);
      const y = Math.round(f.y + Math.cos(t / f.p2 * TAU + f.phase * 9) * f.ay);
      const glow = Math.max(0, wave(t, f.p3, f.phase));
      if (glow < 0.04) continue;
      ctx.fillStyle = `rgba(190,235,90,${(0.09 * glow).toFixed(3)})`;
      for (const [dy, half] of [[-5, 1], [-4, 3], [-3, 4], [-2, 4], [-1, 5], [0, 5], [1, 5], [2, 4], [3, 4], [4, 3], [5, 1]]) ctx.fillRect(x - half, y + dy, half * 2 + 1, 1);
      ctx.fillStyle = `rgba(215,245,110,${(0.2 * glow).toFixed(3)})`;
      for (const [dy, half] of [[-2, 1], [-1, 2], [0, 2], [1, 2], [2, 1]]) ctx.fillRect(x - half, y + dy, half * 2 + 1, 1);
      ctx.fillStyle = `rgba(240,255,150,${(0.7 * glow).toFixed(3)})`;
      ctx.fillRect(x - 1, y, 3, 1);
      ctx.fillRect(x, y - 1, 1, 3);
      ctx.fillStyle = '#fffde0';
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.drawImage(s.near, 0, 0);
    for (const b of s.blades) {
      const lean = wave(t, 4.5, b.phase + b.x / 90) * 1.6;
      ctx.fillStyle = b.tone;
      for (let i = 0; i < b.h; i += 1) ctx.fillRect(Math.round(b.x + lean * (i / b.h) ** 2), b.y - i, 1, 1);
    }
  },
};

/** One jellyfish: a bell that pulses and trailing threads, drawn in place each frame. */
function drawJelly(ctx, j, t) {
  const pulse = (Math.sin((t / j.period) * TAU + j.phase * 9) + 1) / 2;
  const R = j.r;
  const span = R * (0.88 + pulse * 0.26);
  const tall = R * (0.92 - pulse * 0.2);
  const x = Math.round(j.x);
  const y = Math.round(j.y);
  for (let i = 0; i < j.threads; i += 1) {
    const u = (i + 0.5) / j.threads * 2 - 1;
    const long = j.r * (2.1 + (i % 3) * 0.55);
    ctx.fillStyle = i % 2 ? j.pale : j.mid;
    for (let k = 0; k < long; k += 1) {
      const sway = Math.sin(k / 6 + (t / j.period) * TAU * 0.6 + i) * (k / long) * (R * 0.34);
      ctx.fillRect(Math.round(x + u * span * 0.86 + sway), y + 1 + k, 1, 1);
    }
  }
  ctx.fillStyle = j.glow;
  for (let row = -3; row < tall + 3; row += 1) {
    const k = (row + 3) / (tall + 6);
    const half = Math.round((span + 4) * Math.sqrt(Math.max(0, 1 - (1 - k) ** 2)));
    ctx.fillRect(x - half, y - Math.round(tall) + row, half * 2 + 1, 1);
  }
  for (let row = 0; row < tall; row += 1) {
    const k = row / tall;
    const half = Math.round(span * Math.sqrt(1 - (1 - k) ** 2));
    const yy = y - Math.round(tall) + row;
    ctx.fillStyle = j.dark;
    ctx.fillRect(x - half, yy, half * 2 + 1, 1);
    ctx.fillStyle = j.mid;
    ctx.fillRect(x - half + 1, yy, Math.max(1, Math.round(half * 1.3)), 1);
    ctx.fillStyle = j.pale;
    ctx.fillRect(x - half + 2, yy, Math.max(1, Math.round(half * 0.5)), 1);
  }
  ctx.fillStyle = j.dark;
  ctx.fillRect(x - Math.round(span) + 1, y, Math.round(span) * 2 - 1, 1);
  ctx.fillStyle = j.heart;
  for (const dx of [-0.42, 0, 0.42]) ctx.fillRect(Math.round(x + span * dx) - 1, y - Math.round(tall * 0.44), 3, 2);
}

/** The deep: light from far above, jellyfish in three sizes, drifting specks, kelp. */
const deepSea = {
  mode: 'dark',
  focus: [0.5, 0.42],
  still: 24,
  build() {
    const rand = seeded(5501);
    const SEA = ramp('#01040f', '#020818', '#030d22', '#04132e', '#061b3b', '#08244a', '#0b305b', '#0f3f6f', '#165085', '#1f659c');
    const water = new Art();
    water.shade(SEA, (x, y) => clamp(0.96 - (y / H) * 1.02 + Math.sin(x / 90) * 0.03), 1);
    // Shafts of light: long leaning bands, faint and dithered.
    const shaft = new Art(960, H);
    const SHAFT = rgba('#7cc2e6');
    for (let i = 0; i < 12; i += 1) {
      const start = rand() * 960;
      const width = 8 + rand() * 26;
      for (let y = 0; y < H; y += 1) {
        const fade = (1 - y / H) ** 1.6;
        const lean = y * 0.46;
        for (let k = 0; k < width + y * 0.09; k += 1) {
          const edge = Math.min(k, width - k) / width;
          if (fade * clamp(edge * 2.4 + 0.3) * 0.9 > bayer(Math.floor(start + k + lean), y)) shaft.wrap(start + k + lean, y, SHAFT);
        }
      }
    }
    const bedNoise = noise1(5502, 128);
    const FLOOR = ramp('#01040c', '#020713', '#040b1c', '#061227');
    const floor = new Art(W, 70);
    const heightOf = (x) => 28 + fbm1(bedNoise, x / 38, 3) * 30;
    ridge(floor, heightOf, FLOOR, { light: 0.7, depth: 40 });
    const kelp = [];
    for (let i = 0; i < 18; i += 1) {
      const x = Math.floor(rand() * W);
      kelp.push({ x, y: H - 70 + Math.round(heightOf(x)), n: 22 + Math.floor(rand() * 44), phase: rand(), tone: rand() < 0.5 ? '#07271f' : '#0a3226' });
    }
    const PAL = [
      { dark: '#612f8f', mid: '#a35fd0', pale: '#e8c6ff', heart: '#ffd9fb', glow: 'rgba(170,110,240,0.1)' },
      { dark: '#8f3366', mid: '#d6709d', pale: '#ffd1df', heart: '#fff0f4', glow: 'rgba(240,120,170,0.09)' },
      { dark: '#1f6d8a', mid: '#4fb3c8', pale: '#c5f3f6', heart: '#efffff', glow: 'rgba(90,210,230,0.09)' },
    ];
    const jellies = [];
    for (const [x, y, r, sp] of [[92, 72, 9, 3.2], [188, 150, 15, 4.4], [326, 62, 10, 3.6], [402, 170, 21, 5.4], [264, 208, 7, 2.8], [58, 196, 12, 4]]) {
      jellies.push({ x0: x, y0: y, x, y, r, period: sp, phase: rand(), threads: Math.max(5, Math.round(r * 0.8)), drift: 40 + rand() * 40, ...PAL[Math.floor(rand() * PAL.length)] });
    }
    const specks = [];
    for (let i = 0; i < 110; i += 1) specks.push({ x: rand() * W, y: rand() * H, v: 1 + rand() * 3, phase: rand(), size: rand() < 0.1 ? 2 : 1 });
    const bubbles = [];
    for (const vent of [132, 318, 452]) for (let i = 0; i < 7; i += 1) bubbles.push({ x: vent, phase: i / 7, r: 1 + (i % 3 === 0 ? 1 : 0), speed: 16 + rand() * 12 });
    return { water: water.canvas(), shaft: shaft.canvas(), floor: floor.canvas(), kelp, jellies, specks, bubbles };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.water, 0, 0);
    ctx.globalAlpha = 0.14 + 0.03 * wave(t, 9);
    slide(ctx, s.shaft, along(t, 1.4, 960));
    ctx.globalAlpha = 1;
    for (const p of s.specks) {
      const x = (p.x + Math.sin(t / 9 + p.phase * 9) * 6 + W) % W;
      const y = (p.y - t * p.v + H * 100) % H;
      ctx.fillStyle = y < H / 2 ? 'rgba(170,220,240,0.5)' : 'rgba(120,180,210,0.34)';
      ctx.fillRect(Math.round(x), Math.round(y), p.size, p.size);
    }
    // Smallest first, so the near ones swim in front.
    for (const j of [...s.jellies].sort((a, b) => a.r - b.r)) {
      const rise = (t * (0.45 + 6 / j.r) + j.phase * 300) % (H + j.r * 6);
      j.x = j.x0 + Math.sin(t / j.drift * TAU + j.phase * 9) * 18;
      j.y = H + j.r * 2 - rise;
      drawJelly(ctx, j, t);
    }
    ctx.fillStyle = 'rgba(180,235,250,0.6)';
    for (const b of s.bubbles) {
      const y = H - 40 - (((t * b.speed) / H + b.phase) % 1) * (H - 30);
      const x = Math.round(b.x + Math.sin(y / 11 + b.phase * 9) * 3);
      ctx.fillRect(x, Math.round(y), b.r, b.r);
    }
    ctx.drawImage(s.floor, 0, H - 70);
    for (const k of s.kelp) {
      ctx.fillStyle = k.tone;
      for (let i = 0; i < k.n; i += 1) {
        const x = Math.round(k.x + wave(t, 6.5, k.phase + i / 40) * (i / k.n) * 7);
        ctx.fillRect(x, k.y - i, 2, 1);
        if (i % 7 === 3) ctx.fillRect(x + (i % 14 === 3 ? 2 : -2), k.y - i, 2, 1);
      }
    }
  },
};

/** Curtains of light over snow: one of the few things in the sky that moves by itself. */
const auroraPeak = {
  mode: 'dark',
  focus: [0.5, 0.45],
  still: 37,
  build() {
    const rand = seeded(6601);
    const SKY = ramp('#040813', '#060c1c', '#081126', '#0b1731', '#0f1f3d', '#14294a', '#1b3558');
    const sky = new Art();
    sky.shade(SKY, (x, y) => clamp((y / H) * 0.98 - 0.03), 1);
    // A strip for each colour of curtain: bright at its foot, gone at its top.
    const curtain = (stops) => {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 150;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 150);
      for (const [at, color] of stops) grad.addColorStop(at, color);
      g.fillStyle = grad;
      g.fillRect(0, 0, 1, 150);
      return c;
    };
    const green = curtain([[0, 'rgba(90,240,170,0)'], [0.4, 'rgba(90,240,170,0.2)'], [0.7, 'rgba(120,255,190,0.52)'], [0.84, 'rgba(170,255,210,0.5)'], [1, 'rgba(170,255,210,0)']]);
    const violet = curtain([[0, 'rgba(160,90,255,0)'], [0.45, 'rgba(160,90,255,0.26)'], [0.75, 'rgba(120,170,255,0.4)'], [1, 'rgba(120,180,255,0)']]);

    const noiseA = noise1(6602, 256);
    const peak = (x, shift, scale) => ridged(noiseA, (x + shift) / scale, 5);
    const rock = noise2(6603, 64);
    /** A mountain: snow down from its top, faces picked out by which way the rock leans. */
    const massif = (art, height, colours, snowDepth, base) => {
      for (let x = 0; x < W; x += 1) {
        const top = Math.round(height(x));
        const slope = height(x + 5) - height(x - 5);
        for (let y = Math.max(0, top); y < 150; y += 1) {
          const face = fbm2(rock, (x + y * 0.7) / 11, (y - x * 0.7) / 11, 3) - 0.5;
          const snow = clamp(1.1 - (y - top) / snowDepth + face * 1.6);
          art.tone(x, y, colours, clamp(base + snow * 0.66 - slope * 0.022 + face * 0.42), 0.8);
        }
      }
    };
    const FAR = ramp('#22324e', '#334560', '#4a5e7a', '#6d82a0', '#9eb1c8', '#cfdcea');
    const far = new Art(W, 150);
    const farH = (x) => 128 - peak(x, 40, 46) * 74;
    massif(far, farH, FAR, 44, 0.14);
    const NEAR = ramp('#141f33', '#1f2d44', '#2f425c', '#4d6682', '#86a0bb', '#c5d7e6', '#f0f7fc');
    const near = new Art(W, 150);
    const nearH = (x) => 142 - peak(x, 900, 62) * 76;
    massif(near, nearH, NEAR, 60, 0.14);
    const SNOW = ramp('#3a5068', '#5e7890', '#8ea7bd', '#c1d4e2', '#ebf4fa');
    const ground = new Art(W, 70);
    const groundH = (x) => 26 + fbm1(noiseA, x / 70 + 40, 2) * 22;
    ridge(ground, groundH, SNOW, { light: 0.86, depth: 80, spread: 0.7 });
    const PINE = ramp('#06101a', '#0a1824', '#0f2230', '#16303d');
    for (let i = 0; i < 44; i += 1) {
      const x = Math.floor(rand() * W);
      fir(ground, x, Math.round(groundH(x)) + 3 + Math.floor(rand() * 18), 14 + rand() * 24, PINE, rand);
    }
    const flakes = [];
    for (let i = 0; i < 80; i += 1) flakes.push({ x: rand() * W, y: rand() * H, v: 5 + rand() * 11, sway: 3 + rand() * 7, phase: rand(), big: rand() < 0.15 });
    return { sky: sky.canvas(), green, violet, far: far.canvas(), near: near.canvas(), ground: ground.canvas(), stars: starField(rand, 150, 150), flakes, noise: noiseA };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    drawStars(ctx, s.stars, t);
    // Each band is columns of one strip, its height and foot moving with slow noise.
    const band = (strip, base, reach, speed, seed, alpha) => {
      for (let x = 0; x < W; x += 2) {
        const n = s.noise((x + t * speed) / 42 + seed);
        const m = s.noise((x - t * speed * 0.6) / 19 + seed * 3);
        const foot = base + (n - 0.5) * 66 + (m - 0.5) * 14;
        const tall = reach * (0.52 + m * 0.72);
        const a = alpha * (0.3 + 0.7 * s.noise(x / 11 + t * 0.34 + seed)) * (0.82 + 0.18 * wave(t, 8, seed));
        ctx.globalAlpha = clamp(a);
        ctx.drawImage(strip, 0, 0, 1, 150, x, Math.round(foot - tall), 2, Math.round(tall));
      }
      ctx.globalAlpha = 1;
    };
    band(s.violet, 92, 110, 7, 3.3, 0.62);
    band(s.green, 112, 104, 10, 0.7, 0.9);
    ctx.drawImage(s.far, 0, H - 190);
    ctx.drawImage(s.near, 0, H - 150);
    ctx.drawImage(s.ground, 0, H - 70);
    ctx.fillStyle = 'rgba(240,248,255,0.85)';
    for (const f of s.flakes) {
      const y = (f.y + t * f.v) % H;
      const x = (f.x + Math.sin(t / 7 + f.phase * 9) * f.sway + W) % W;
      ctx.fillRect(Math.round(x), Math.round(y), f.big ? 2 : 1, f.big ? 2 : 1);
    }
  },
};

/** A crown of blossom, built from clusters so its top is a scallop. */
function blossomCrown(rand, cx, base, width, height) {
  const list = [];
  const count = Math.round((width * height) / 12);
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    const x = cx + Math.cos(a) * k * width * 0.5;
    const y = base - height * 0.5 + Math.sin(a) * k * height * 0.5;
    list.push({ x, y, r: 2.4 + rand() * 3.2, z: rand() * 2 });
  }
  return list;
}

/** A warm late afternoon, cherry trees in bloom along a railway, a crossing that blinks, a cat. */
const sakuraCrossing = {
  mode: 'light',
  focus: [0.42, 0.58],
  still: 14,
  build() {
    const rand = seeded(7701);
    const SKY = ramp('#f4b183', '#f7bd8d', '#f9c999', '#fbd4a6', '#fcdfb5', '#fde8c5', '#fef0d6', '#fff6e4');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot((x - 340) / 1.5, y - 138);
      return clamp(0.05 + (y / H) * 0.42 + 0.66 * Math.exp(-((d / 130) ** 2)));
    }, 0.95);
    const CLOUD = ramp('#e79a7f', '#f0ae8e', '#f6c3a2', '#fbd8bb', '#fee9d3', '#fff6ea');
    const clouds = new Art(960, 170);
    for (const [cx, base, w, h] of [[110, 120, 210, 86], [360, 142, 170, 62], [600, 108, 240, 90], [840, 136, 180, 66]]) {
      puffs(clouds, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.55, height: 0.62, light: [0.55, -0.75, 0.3], lift: 0.12, flat: 8 });
    }

    const land = new Art();
    // Far hills, in the haze.
    const hillNoise = noise1(7702, 128);
    const HAZE = ramp('#c89a9f', '#d4abab', '#dfbcb6', '#e9ccc1');
    const hills = (x) => 136 + fbm1(hillNoise, x / 66, 3) * 34;
    for (let x = 0; x < W; x += 1) for (let y = Math.round(hills(x)); y < 200; y += 1) land.tone(x, y, HAZE, clamp(0.72 - (y - hills(x)) / 60), 0.8);

    // The bank, in grass, and the trees along the top of it.
    const GRASS = ramp('#8f9c4e', '#a4ad59', '#b8bd68', '#cfcd7c', '#e3dc95');
    const bank = noise2(7703, 64);
    land.shade(GRASS, (x, y) => (y < 176 + Math.sin(x / 40) * 3 ? -1 : clamp(0.7 - (y - 176) / 60 + (fbm2(bank, x / 7, y / 5, 2) - 0.5) * 0.7)), 0.9, [0, 170, W, 216]);
    const BARK = ramp('#4a2e2f', '#65403d', '#83574c');
    const BLOSSOM = ramp('#c76a84', '#dd8399', '#ec9fae', '#f6bcc4', '#fcd6d8', '#ffeceb');
    const trees = [[22, 84], [86, 96], [150, 76], [214, 104], [282, 80], [346, 100], [414, 90], [474, 86]];
    for (const [x, tall] of trees) {
      const base = 186;
      land.line(x, base, x - 2, base - tall * 0.5, BARK[0]);
      land.rect(x - 2, base - tall * 0.55, 5, tall * 0.55, BARK[1]);
      land.rect(x - 1, base - tall * 0.55, 1, tall * 0.55, BARK[2]);
      for (const [dx, dy] of [[-14, -0.4], [12, -0.45], [-5, -0.68]]) land.line(x, base - tall * 0.34, x + dx, base + tall * dy, BARK[0]);
    }
    const petalGrain = noise2(7705, 64);
    const flowers = (x, y) => (fbm2(petalGrain, x / 3.2, y / 3.2, 2) - 0.5) * 0.55;
    for (const [x, tall] of trees) {
      const base = 182 - tall * 0.3;
      puffs(land, blossomCrown(rand, x, base, tall * 1.02, tall * 0.84), BLOSSOM, { spread: 0.9, height: 0.74, light: [0.5, -0.8, 0.4], lift: 0.06, grain: flowers });
    }

    // A dry-stone wall under the bank, course by course.
    const STONE = ramp('#a88561', '#bb9971', '#cdad84', '#dcc098', '#e9d1ab');
    for (let row = 0; row < 3; row += 1) {
      const y = 196 + row * 7;
      let x = -(row % 2) * 6;
      while (x < W) {
        const w = 10 + Math.floor(rand() * 9);
        const tone = 0.25 + rand() * 0.6;
        for (let j = 0; j < 6; j += 1) for (let i = 0; i < w - 1; i += 1) land.tone(x + i, y + j, STONE, clamp(tone + (j === 0 ? 0.2 : j === 5 ? -0.25 : 0)), 0.5);
        for (let j = 0; j < 7; j += 1) land.put(x + w - 1, y + j, rgba('#856445'));
        x += w;
      }
      for (let i = 0; i < W; i += 1) land.put(i, y + 6, rgba('#856445'));
    }
    // A plain timber fence along the top of the wall.
    const FENCE = rgba('#6e4a35');
    const FENCE_LIT = rgba('#9a6d4b');
    land.rect(0, 186, W, 2, FENCE_LIT);
    land.rect(0, 188, W, 1, FENCE);
    for (let x = 6; x < W; x += 34) {
      land.rect(x, 182, 3, 15, FENCE);
      land.rect(x, 182, 1, 15, FENCE_LIT);
    }

    // Ballast, sleepers and two rails.
    const BALLAST = ramp('#675a53', '#7c6c62', '#94826f', '#ad9a84', '#c6b39d');
    const stones = noise2(7704, 64);
    land.shade(BALLAST, (x, y) => clamp(0.58 + (fbm2(stones, x / 2.3, y / 2.3, 2) - 0.5) * 1.5 - Math.abs(y - 244) / 60), 0.9, [0, 217, W, H]);
    for (let x = -4; x < W; x += 15) {
      land.rect(x, 234, 8, 25, rgba('#4b3a33'));
      land.rect(x, 234, 8, 2, rgba('#6c5448'));
    }
    for (const y of [238, 252]) {
      land.rect(0, y, W, 1, rgba('#f7e6cf'));
      land.rect(0, y + 1, W, 2, rgba('#6a5e58'));
      land.rect(0, y + 3, W, 1, rgba('#3e3433'));
    }

    // The crossing: a mast, a crossbuck, two lamps and the arm standing up.
    const POST = 402;
    for (let y = 92; y < 226; y += 1) {
      const dark = Math.floor((y + 4) / 8) % 2 === 0;
      land.rect(POST - 2, y, 4, 1, rgba(dark ? '#2b2726' : '#f1c84a'));
      land.put(POST - 2, y, rgba(dark ? '#4b4442' : '#ffe48a'));
    }
    const buck = (x0, y0, x1, y1) => {
      for (let k = 0; k <= 1; k += 1 / 44) {
        const x = mix(x0, x1, k);
        const y = mix(y0, y1, k);
        const dark = Math.floor(k * 7) % 2 === 0;
        land.disc(x, y, 2.2, rgba(dark ? '#2b2726' : '#f4cf54'));
      }
    };
    buck(POST - 22, 72, POST + 22, 112);
    buck(POST + 22, 72, POST - 22, 112);
    land.rect(POST - 30, 126, 60, 3, rgba('#2b2726'));
    for (const lx of [POST - 25, POST + 25]) {
      land.disc(lx, 136, 11, rgba('#27211f'));
      land.disc(lx, 136, 8, rgba('#4d1a1a'));
      land.rect(lx - 12, 123, 24, 4, rgba('#17110f'));
    }
    land.rect(POST - 6, 172, 12, 18, rgba('#3a3433'));
    land.rect(POST - 5, 173, 10, 2, rgba('#5c5350'));
    const barrier = (y0) => {
      for (let i = 0; i < 74; i += 1) land.rect(POST + 6, y0 - i, 2, 1, rgba(Math.floor(i / 9) % 2 ? '#fff3df' : '#c9402f'));
    };
    barrier(182);

    // A black cat, sitting on the wall: tail, two ears, eyes that close.
    const CAT = { k: '#1d1a20', d: '#2d2931', e: '#f5d76e', p: '#f0a4a4' };
    const cat = (eyes) => sprite([
      '  k     k   ',
      ' kkk   kkk  ',
      ' kkkkkkkkk  ',
      ` k${eyes}kkk${eyes}k  `,
      ' kkkkpkkkk  ',
      '  kkkkkkk   ',
      '   kkkkk    ',
      '  kkkkkkk   ',
      '  kkkkkkkk  ',
      ' kkkkkkkkk  ',
      ' kkkkkkkkkk ',
      ' kkkkkkkkkk ',
      ' kk kkkk kk ',
    ], CAT);

    // Near blossom, hanging in from the corner, swaying as one.
    const bough = new Art(190, 86);
    const close = [];
    for (let i = 0; i < 420; i += 1) {
      const k = rand();
      close.push({ x: 186 * k + (rand() - 0.5) * 8, y: 4 + (1 - k) * 26 + rand() * (48 * (1 - k * 0.72)), r: 1.8 + rand() * 3.2, z: rand() * 2 });
    }
    puffs(bough, close, BLOSSOM, { spread: 0.9, height: 0.6, lift: 0.06, grain: flowers });
    for (let i = 0; i < 150; i += 1) bough.put(i, Math.round(3 + (150 - i) * 0.1), BARK[1]);

    const petals = [];
    for (let i = 0; i < 110; i += 1) {
      const z = rand();
      petals.push({ x: rand() * (W + 40), y: rand() * H, z, v: 7 + z * 24, drift: 8 + z * 20, sway: 4 + rand() * 12, period: 3 + rand() * 5, phase: rand(), tone: rand() < 0.5 ? '#ffd8dd' : rand() < 0.5 ? '#ffc2cc' : '#ffeef0' });
    }
    return { sky: sky.canvas(), clouds: clouds.canvas(), land: land.canvas(), bough: bough.canvas(), catOpen: cat('e'), catShut: cat('k'), petals, lampsAt: [POST - 25, POST + 25] };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.clouds, along(t, 0.9, 960), 22);
    ctx.drawImage(s.land, 0, 0);

    // The lamps take it in turn, once a second, each with a soft bloom.
    const lit = Math.floor(t) % 2;
    const lx = s.lampsAt[lit];
    ctx.fillStyle = 'rgba(255,90,60,0.1)';
    ctx.fillRect(lx - 20, 116, 40, 40);
    ctx.fillStyle = 'rgba(255,110,70,0.2)';
    ctx.fillRect(lx - 12, 124, 24, 24);
    ctx.fillStyle = '#ff4930';
    for (const [dy, half] of [[-7, 3], [-6, 5], [-5, 6], [-4, 7], [-3, 7], [-2, 8], [-1, 8], [0, 8], [1, 8], [2, 8], [3, 7], [4, 7], [5, 6], [6, 5], [7, 3]]) ctx.fillRect(lx - half, 136 + dy, half * 2, 1);
    ctx.fillStyle = '#ffb99c';
    ctx.fillRect(lx - 3, 131, 3, 2);

    // A cat, on a period of its own: mostly still, a slow blink, a tail that flicks.
    const blink = (t % 6.3) < 0.26;
    const px = 190;
    const py = 170;
    ctx.drawImage(blink ? s.catShut : s.catOpen, px, py);
    ctx.fillStyle = '#1d1a20';
    const flick = wave(t, 3.1) * 3;
    for (let i = 0; i < 9; i += 1) ctx.fillRect(Math.round(px + 12 + i * 0.55 + flick * (i / 9) ** 2), py + 11 - Math.round((i / 9) ** 2 * 7), 2, 1);

    for (const p of s.petals) {
      const y = (p.y + t * p.v) % (H + 8);
      const x = ((p.x - t * p.drift + Math.sin((t / p.period + p.phase) * TAU) * p.sway) % (W + 40) + W + 40) % (W + 40) - 20;
      const flip = wave(t, p.period, p.phase) > 0;
      ctx.fillStyle = p.tone;
      const big = p.z > 0.82 ? 2 : 1;
      ctx.fillRect(Math.round(x), Math.round(y), (flip ? 2 : 1) * big, (flip ? 1 : 2) * big);
    }
    ctx.drawImage(s.bough, Math.round(wave(t, 8) * 1.5) - 8, Math.round(wave(t, 5.3) * 1) - 4);
  },
};

/** Pink dusk on a city corner: a low sun, wires, shops closing, a signal that keeps blinking. */
const roseStreet = {
  mode: 'dark',
  focus: [0.5, 0.6],
  still: 21,
  build() {
    const rand = seeded(8801);
    const SKY = ramp('#b65f72', '#c56b78', '#d27881', '#de868a', '#e79695', '#efa7a1', '#f4b8ae');
    const sky = new Art();
    sky.shade(SKY, (x, y) => clamp(0.08 + (y / 180) * 0.8 + 0.3 * Math.exp(-((Math.hypot(x - 300, y - 76) / 90) ** 2))), 0.95);
    sky.disc(300, 76, 30, rgba('#f7cdbb'));
    for (let y = 46; y < 106; y += 1) for (let x = 268; x < 332; x += 1) if (Math.hypot(x - 300, y - 76) <= 30 && (x + y) % 2 === 0 && y > 88) sky.put(x, y, rgba('#f4c1af'));

    const CLOUD = ramp('#d68488', '#e59c9a', '#f1b5ad', '#f9cfc2');
    const clouds = new Art(960, 90);
    for (let i = 0; i < 9; i += 1) {
      const cx = (i + rand()) * (960 / 9);
      const base = 44 + rand() * 40;
      puffs(clouds, cumulus(rand, cx, base, 46 + rand() * 62, 10 + rand() * 12), CLOUD, { base, wrap: true, spread: 0.45, height: 0.82, flat: 3, lift: 0.1 });
    }

    const land = new Art();
    const VIOLET = ['#8d5570', '#7a4a66', '#68405c', '#573751'];
    // Far blocks in four depths, each a step darker and nearer.
    VIOLET.forEach((hex, depth) => {
      let x = -8 + depth * 11;
      const c = rgba(hex);
      const lit = rgba(['#c9808a', '#b97684', '#a66b7c', '#945f72'][depth]);
      while (x < W) {
        const w = 18 + Math.floor(rand() * 26);
        const top = 118 + depth * 13 - Math.floor(rand() * (38 - depth * 7));
        land.rect(x, top, w, H, c);
        land.rect(x + w - 2, top, 2, H, lit);
        if (rand() > 0.55) land.rect(x + 4 + Math.floor(rand() * (w - 8)), top - 7, 1, 7, c);
        if (depth >= 1) {
          for (let wy = top + 5; wy < 210; wy += 7) for (let wx = x + 3; wx < x + w - 4; wx += 5) if (rand() < 0.3) land.put(wx, wy, rgba('#d99a8e'));
        }
        x += w + (rand() > 0.8 ? 6 : 0);
      }
    });

    // The corner building, its dither the only texture on the page.
    const BRICK = ramp('#3a2a44', '#463250', '#553b5c', '#664668');
    land.shade(BRICK, (x, y) => (x > 170 + (y - 60) * 0.06 ? -1 : clamp(0.6 - (x / 170) * 0.5 + ((y % 6 === 0 ? -0.2 : 0) + ((x + Math.floor(y / 6) * 5) % 11 === 0 ? -0.18 : 0)))), 0.7, [0, 56, 186, 226]);
    for (let i = 0; i < 186; i += 1) land.rect(i, 52, 1, 4, rgba(i % 8 < 1 ? '#2b2036' : '#231a2e'));
    land.rect(0, 50, 186, 2, rgba('#7b5877'));
    // Floors of windows, remembered so they can come on.
    const windows = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const x = 14 + col * 32;
        const y = 66 + row * 38;
        land.rect(x - 1, y - 1, 20, 27, rgba('#2a1f35'));
        land.rect(x, y, 18, 25, rgba('#4b3d5d'));
        land.rect(x + 8, y, 1, 25, rgba('#2a1f35'));
        land.rect(x, y + 12, 18, 1, rgba('#2a1f35'));
        land.rect(x - 2, y + 26, 22, 2, rgba('#6a4e6c'));
        windows.push({ x, y, period: 11 + rand() * 31, phase: rand() });
      }
    }
    // A shop on the ground floor, with its striped awning.
    land.rect(4, 190, 170, 36, rgba('#2b2036'));
    land.rect(10, 196, 66, 30, rgba('#6c5a78'));
    land.rect(84, 196, 26, 30, rgba('#3c2d48'));
    land.rect(118, 196, 50, 30, rgba('#6c5a78'));
    for (let i = 0; i < 172; i += 1) {
      const stripe = Math.floor(i / 8) % 2 ? '#f2d4c6' : '#b5475f';
      for (let k = 0; k < 8; k += 1) land.put(4 + i + k * 0.4, 180 + k, rgba(stripe));
    }

    // Road, pavement and the crossing's bars.
    land.rect(0, 226, W, 5, rgba('#8b6f86'));
    land.rect(0, 226, W, 1, rgba('#b18fa1'));
    const ROAD = ramp('#3b2c42', '#463550', '#52405c');
    land.shade(ROAD, (x, y) => clamp(0.6 - (y - 231) / 60 + (bayer(x, y) - 0.5) * 0.2), 0.8, [0, 231, W, H]);
    for (let i = 0; i < 9; i += 1) {
      const y = 238 + i * 3;
      for (let bar = 0; bar < 8; bar += 1) {
        const x0 = 196 + bar * 34 - i * 2.6;
        land.rect(x0, y, 22 + i * 0.6, 2, rgba('#d9bcc0'));
      }
    }

    // A pole and its wires, drawn last so they cross everything.
    const POLE = rgba('#221a2c');
    land.rect(330, 42, 4, 188, POLE);
    land.rect(331, 42, 1, 188, rgba('#4c3a50'));
    land.rect(312, 58, 40, 3, POLE);
    land.rect(318, 80, 28, 2, POLE);
    land.rect(332, 96, 28, 2, POLE);
    land.rect(356, 98, 12, 3, rgba('#1b1422'));
    for (const [y0, y1, sag] of [[58, 74, 14], [58, 66, 11], [80, 90, 16]]) {
      for (let x = 0; x < 330; x += 1) land.put(x, Math.round(mix(y0 + 8, y0, x / 330) + Math.sin((x / 330) * Math.PI) * sag), POLE);
      for (let x = 334; x < W; x += 1) land.put(x, Math.round(mix(y1, y0, (x - 334) / (W - 334)) + Math.sin(((x - 334) / (W - 334)) * Math.PI) * sag * 0.6), POLE);
    }
    // A signal box on a thin post, right of the road.
    land.rect(420, 150, 3, 80, POLE);
    land.rect(413, 126, 17, 30, rgba('#241b2e'));
    land.rect(414, 127, 15, 1, rgba('#4b3a4e'));
    land.disc(421, 134, 5, rgba('#47233a'));
    land.disc(421, 148, 5, rgba('#233a34'));
    // A cherry tree in the corner, the one thing still in colour.
    const TREE = ramp('#a34c6c', '#c0677f', '#d98593', '#ecabad', '#f7cec7');
    land.rect(383, 180, 4, 48, rgba('#2b2036'));
    const crown = [];
    for (let i = 0; i < 190; i += 1) {
      const a = rand() * TAU;
      const k = Math.sqrt(rand());
      crown.push({ x: 385 + Math.cos(a) * k * 32, y: 164 + Math.sin(a) * k * 24, r: 2 + rand() * 3, z: rand() * 2 });
    }
    puffs(land, crown, TREE, { spread: 0.9, height: 0.7, lift: 0.04 });

    const car = sprite([
      '       cccccccccc       ',
      '     ccwwwcwwwwwwcc     ',
      '   ccccwwwcwwwwwwccc    ',
      ' ccccccccccccccccccccc  ',
      'rcccccccccccccccccccccy ',
      'ccdddddcccccccccdddddccc',
      '  dkkkd         dkkkd   ',
    ], { c: '#231a2c', w: '#5a4a68', d: '#120c18', k: '#3a2d44', r: '#ff4d58', y: '#ffe9a8' });
    const drift = [];
    for (let i = 0; i < 26; i += 1) drift.push({ x: rand() * W, y: rand() * H, v: 6 + rand() * 12, sway: 3 + rand() * 6, phase: rand() });
    return { sky: sky.canvas(), clouds: clouds.canvas(), land: land.canvas(), windows, car, drift };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.clouds, along(t, 1.1, 960), 8);
    ctx.drawImage(s.land, 0, 0);
    for (const w of s.windows) {
      // Whole minutes between changes: somebody comes home, somebody goes to bed.
      if (wave(t, w.period, w.phase) < 0.1) continue;
      ctx.fillStyle = '#f5cf8e';
      ctx.fillRect(w.x, w.y, 8, 12);
      ctx.fillRect(w.x + 9, w.y, 9, 12);
      ctx.fillRect(w.x, w.y + 13, 8, 12);
      ctx.fillRect(w.x + 9, w.y + 13, 9, 12);
    }
    // The shop's light is an old tube: steady, and every so often it catches.
    const flicker = (t % 13) < 0.5 && Math.floor(t * 14) % 3 === 0;
    ctx.fillStyle = flicker ? '#a98f92' : '#ffd9a5';
    ctx.fillRect(10, 196, 66, 30);
    ctx.fillRect(118, 196, 50, 30);
    ctx.fillStyle = flicker ? '#8c7176' : '#ffc27f';
    ctx.fillRect(14, 214, 58, 12);
    ctx.fillRect(122, 214, 42, 12);
    ctx.fillStyle = '#2b2036';
    for (const x of [28, 44, 60, 132, 148]) ctx.fillRect(x, 196, 1, 30);
    ctx.fillStyle = flicker ? 'rgba(255,214,160,0.03)' : 'rgba(255,214,160,0.13)';
    ctx.fillRect(4, 226, 176, 10);
    // The street lamp, and the circle of light it keeps.
    ctx.fillStyle = 'rgba(255,230,180,0.14)';
    ctx.fillRect(350, 101, 24, 12);
    ctx.fillStyle = '#fff1c9';
    ctx.fillRect(358, 101, 8, 2);
    // The signal takes turns: green that blinks, then red, and round again.
    const phase = t % 12;
    const green = phase < 6 || (phase < 8 && Math.floor(t * 2) % 2 === 0);
    ctx.fillStyle = green ? '#6ff5b4' : '#ff5a5f';
    const signal = green ? 148 : 134;
    for (const [dy, half] of [[-3, 2], [-2, 3], [-1, 4], [0, 4], [1, 4], [2, 3], [3, 2]]) ctx.fillRect(421 - half, signal + dy, half * 2, 1);
    ctx.fillStyle = green ? 'rgba(111,245,180,0.14)' : 'rgba(255,90,95,0.14)';
    ctx.fillRect(411, signal - 10, 20, 20);

    // A car, about twice a minute.
    const span = W + 60;
    const pass = (t % 34) / 7;
    if (pass < 1) ctx.drawImage(s.car, Math.round(span - pass * (span + 30)) - 30, 234);
    // A few petals from the tree, going the way of the wind.
    ctx.fillStyle = '#f7c4c2';
    for (const p of s.drift) {
      const y = (p.y + t * p.v) % H;
      const x = ((p.x - t * 9 + Math.sin(t / 4 + p.phase * 9) * p.sway) % W + W) % W;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    // Birds cross the sun now and then.
    const birds = (t % 47) / 15;
    if (birds < 1) {
      ctx.fillStyle = '#4c3550';
      const flap = Math.floor(t * 3) % 2;
      for (const [dx, dy] of [[0, 0], [11, 3], [20, -2], [30, 4]]) {
        const x = Math.round(birds * (W + 60)) - 30 + dx;
        const y = 70 + dy + Math.round(wave(t, 6) * 3);
        ctx.fillRect(x - 2, y - flap, 2, 1);
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(x + 1, y - flap, 2, 1);
      }
    }
  },
};

/** The scenes by id, in catalogue order. */
const BUILDERS = {
  'cloud-drift': cloudDrift,
  'moon-night': moonNight,
  lagoon,
  'firefly-grove': fireflyGrove,
  'deep-sea': deepSea,
  'aurora-peak': auroraPeak,
  'sakura-crossing': sakuraCrossing,
  'rose-street': roseStreet,
};

/* ── playing them ──────────────────────────────────────────────── */

/**
 * What the rest of the app may know: how each is called, and how the interface
 * should look over it. The words are in the locale files.
 *
 * @type {Record<string, { id: string, mode: string, focus: number[] }>}
 */
export const SCENES = Object.fromEntries(Object.entries(BUILDERS).map(([id, s]) => [id, { id, mode: s.mode, focus: s.focus }]));

/** Built layers, newest last. A few at most: each is several megabytes of canvas. */
const worlds = new Map();
const KEEP_WORLDS = 3;

function worldOf(id) {
  let world = worlds.get(id);
  if (world) {
    worlds.delete(id);
    worlds.set(id, world);
    return world;
  }
  world = BUILDERS[id].build();
  worlds.set(id, world);
  const busy = new Set([...playing].map((m) => m.id));
  for (const key of worlds.keys()) {
    if (worlds.size <= KEEP_WORLDS) break;
    if (key !== id && !busy.has(key)) worlds.delete(key);
  }
  return world;
}

/** @type {Set<any>} every mount that is moving */
const playing = new Set();
let timer = 0;
let lastTick = 0;
let framesDrawn = 0;

const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const stillOnly = () => !!reducedQuery?.matches;

function wake() {
  if (timer || !playing.size || document.hidden || stillOnly()) return;
  timer = window.setTimeout(tick, 1000 / FPS);
}

function tick() {
  timer = 0;
  if (document.hidden || stillOnly() || !playing.size) return;
  const now = performance.now();
  // A long gap is a throttled tab or a sleeping laptop: the picture carries on from where it was.
  const step = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  for (const mount of playing) {
    mount.clock += step;
    mount.paint(mount.clock);
  }
  wake();
}

function stirred() {
  clearTimeout(timer);
  timer = 0;
  lastTick = performance.now();
  wake();
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', stirred);
// Asking for less motion stops everything at once, and changing back starts it again.
reducedQuery?.addEventListener?.('change', () => {
  for (const mount of playing) if (stillOnly()) mount.still();
  stirred();
});

/**
 * A scene on a canvas.
 *
 * It holds one still frame until told to play. `pause` puts that still frame back,
 * and from then on the canvas costs nothing.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string} id
 * @param {{ animate?: boolean }} [options]
 */
export function mountScene(canvas, id, { animate = false } = {}) {
  const scene = BUILDERS[id];
  if (!scene) return { play() {}, pause() {}, destroy() {} };
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;
  canvas.style.objectPosition = `${scene.focus[0] * 100}% ${scene.focus[1] * 100}%`;

  const mount = {
    id,
    clock: scene.still,
    paint(at) {
      scene.draw(ctx, at, worldOf(id));
      framesDrawn += 1;
    },
    still() {
      mount.clock = scene.still;
      mount.paint(scene.still);
    },
  };
  mount.still();

  const handle = {
    play() {
      if (playing.has(mount)) return;
      if (!playing.size) lastTick = performance.now();
      playing.add(mount);
      wake();
    },
    pause() {
      if (playing.delete(mount)) mount.still();
    },
    destroy() {
      playing.delete(mount);
    },
  };
  if (animate) handle.play();
  return handle;
}

/** Whether anything would move right now, and how much has been drawn: for a test and for a person measuring. */
export const sceneStats = () => ({ frames: framesDrawn, playing: playing.size, timer: !!timer, worlds: worlds.size });

/** One frame's work, for measuring: draws at `t` on a scratch canvas, built world and all. */
export function drawFrameForMeasure(ctx, id, t) {
  BUILDERS[id].draw(ctx, t, worldOf(id));
}
