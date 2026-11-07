/**
 * The painter behind the scenes (owner, 2026-11-04): every scene is drawn by code on
 * a small canvas and shown large. Layers are painted pixel by pixel once, and a
 * frame slides them about, which is what makes a moving picture cheap.
 *
 * Runs in the scene worker where a browser allows it, on the page where it does not.
 * No window, no document: `newCanvas` is the one thing that differs.
 */

/** The canvas a scene is drawn on, unless it says otherwise. Small on purpose: the pixels are the look. */
export const W = 480;
export const H = 270;
export const TAU = Math.PI * 2;

/** A canvas nobody sees, on whichever thread this is. */
export const newCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  return out;
};

/* ── a small painter ───────────────────────────────────────────── */

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const mix = (a, b, k) => a + (b - a) * k;
export const smooth = (k) => k * k * (3 - 2 * k);
/** A number that repeats every `period` seconds, -1 to 1. */
export const wave = (t, period, phase = 0) => Math.sin((t / period + phase) * TAU);
/** A position `speed` pixels a second along something `size` wide, in whole pixels. */
export const along = (t, speed, size) => (Math.floor(t * speed) % size + size) % size;

/** The same numbers from the same seed, which is what keeps a still frame still. */
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' as the bytes a canvas holds, opaque. */
export const rgba = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | (n >>> 16)) >>> 0;
};
export const ramp = (...hexes) => hexes.map(rgba);

/** Ordered dither, so two colours meet in a pattern rather than in a blend. */
export const BAYER = Float32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], (v) => (v + 0.5) / 16);
export const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

export class Art {
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
    const out = newCanvas(this.w, this.h);
    const data = new ImageData(new Uint8ClampedArray(this.px.buffer), this.w, this.h);
    out.getContext('2d').putImageData(data, 0, 0);
    return out;
  }
}

/** Smooth noise along a line. `period` makes it join up, for a layer that wraps. */
export function noise1(seed, period = 256) {
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
export function noise2(seed, period = 128) {
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
export const fbm1 = (fn, x, octaves = 4) => {
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
export const fbm2 = (fn, x, y, octaves = 4) => {
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
export const ridged = (fn, x, octaves = 5) => {
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
export function puffs(art, list, colours, o = {}) {
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
export function cumulus(rand, cx, base, width, height) {
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
export function sprite(rows, colours) {
  const art = new Art(Math.max(...rows.map((r) => r.length)), rows.length);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (colours[ch]) art.put(x, y, rgba(colours[ch]));
    });
  });
  return art.canvas();
}

/** A layer that wraps, drawn twice where it crosses the seam. */
export function slide(ctx, image, offset, y = 0) {
  const w = image.width;
  const x = -(((offset % w) + w) % w);
  ctx.drawImage(image, x, y);
  if (x + w < W) ctx.drawImage(image, x + w, y);
}

/** Stars for a night sky: a few fixed, the rest breathing at their own pace. */
export function starField(rand, count, maxY) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const big = rand() < 0.1;
    stars.push({ x: Math.floor(rand() * W), y: Math.floor(rand() * rand() * maxY), big, period: 3 + rand() * 9, phase: rand(), tone: rand() < 0.2 ? '#ffe9c4' : rand() < 0.4 ? '#c9dcff' : '#ffffff' });
  }
  return stars;
}

export function drawStars(ctx, stars, t) {
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
export function ridge(art, height, colours, { light = 0.5, spread = 0.8, depth = 60 } = {}) {
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
export function fir(art, x, base, height, colours, rand, wrap = false) {
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
