import { TAU, clamp, mix, smooth, seeded, ramp, bayer, newCanvas, noise2, fbm2 } from './art.js';

/**
 * The creature each title shows (owner, 2026-11-06): one a title, and the harder a
 * title is to earn, the more there is to it. A fish at the start; a galaxy in the shape
 * of a whale, and a koi that becomes a dragon, at the end.
 *
 * Each one is a small shader. Its body is a shape measured pixel by pixel as a signed
 * distance, so limbs blend into a body and one form can become another, then shaded
 * through a ramp with an ordered dither, which is what keeps them pixel art. What flies
 * around them is drawn over that. Only one plays at a time, in the panel beside the
 * titles, and in the scene worker.
 *
 * Every frame is a pure function of the time, like the scenes. All of it is this file's
 * own drawing.
 */

/* ── shapes ──────────────────────────────────────────────────────── */

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const ellipse = (x, y, cx, cy, rx, ry) => {
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return (k - 1) * Math.min(rx, ry);
};
/** A line with round ends, its radius going from `ra` to `rb`. */
const stroke = (x, y, ax, ay, bx, by, ra, rb = ra) => {
  const dx = bx - ax;
  const dy = by - ay;
  const k = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(x - ax - dx * k, y - ay - dy * k) - mix(ra, rb, k);
};
/** Two shapes melted together. */
const smin = (a, b, k = 6) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k);
  return mix(b, a, h) - k * h * (1 - h);
};

/** A whale, nose to the left: one shape every whale here is cut from. */
function whaleShape(x, y, cx, cy, s, wag) {
  const u = (x - cx) / s;
  const v = (y - cy) / s;
  let d = ellipse(u, v, -0.15, 0, 0.72, 0.42);
  d = smin(d, stroke(u, v, 0.35, -0.02, 0.92, -0.12 + wag * 0.1, 0.27, 0.05), 0.16);
  const tailX = 0.98;
  const tailY = -0.14 + wag * 0.14;
  d = smin(d, stroke(u, v, tailX, tailY, tailX + 0.3, tailY - 0.3 + wag * 0.16, 0.08, 0.02), 0.06);
  d = smin(d, stroke(u, v, tailX, tailY, tailX + 0.34, tailY + 0.16 + wag * 0.16, 0.08, 0.02), 0.06);
  d = smin(d, stroke(u, v, -0.2, 0.3, -0.06, 0.62 + wag * 0.05, 0.12, 0.03), 0.08);
  return d * s;
}

/* ── the canvas they are drawn on ───────────────────────────────── */

/** The layers one creature keeps: its pixels, and a background painted once. */
function makeWorld(size, backdrop) {
  const canvas = newCanvas(size, size);
  const c = canvas.getContext('2d');
  const image = new ImageData(size, size);
  const px = new Uint32Array(image.data.buffer);
  const back = new Uint32Array(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) back[y * size + x] = backdrop(x, y);
  return { size, canvas, c, image, px, back };
}

const tone = (colours, v, x, y, spread = 0.8) => {
  const n = colours.length - 1;
  const i = Math.round(clamp(v) * n + (bayer(x, y) - 0.5) * spread);
  return colours[i < 0 ? 0 : i > n ? n : i];
};

/** A soft backdrop: a ramp from the corner of the light. */
const glowBack = (size, colours, cx = 0.5, cy = 0.42, reach = 0.8) => (x, y) => tone(colours, clamp(1 - Math.hypot(x / size - cx, y / size - cy) / reach), x, y, 0.9);

/** Paint a shape into the frame. `shade` gives a colour for a pixel inside it, 0 to leave it. */
function paint(world, box, inside, shade) {
  const { size, px } = world;
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(size, Math.ceil(box[2]));
  const y1 = Math.min(size, Math.ceil(box[3]));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const d = inside(x, y);
      if (d > 0) continue;
      const colour = shade(x, y, d);
      if (colour) px[y * size + x] = colour;
    }
  }
}

function begin(world) {
  world.px.set(world.back);
}

function finish(ctx, world) {
  world.c.putImageData(world.image, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(world.canvas, 0, 0);
}

/** A round glow, drawn adding to what is under it. */
function glow(ctx, x, y, r, colour, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, colour);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

const dot = (ctx, x, y, size, colour, alpha = 1) => {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), size, size);
  ctx.globalAlpha = 1;
};

/** Things that keep rising, each from its own place and at its own pace. */
function risers(ctx, list, t, size, colour) {
  for (const b of list) {
    const k = ((t * b.speed + b.phase) % 1 + 1) % 1;
    const x = b.x + Math.sin(k * TAU * 2 + b.phase * 9) * 3;
    const y = size * (1 - k);
    dot(ctx, x, y, b.size, colour, (1 - k) * b.alpha);
  }
}

const list = (seed, n, fn) => {
  const rand = seeded(seed);
  return Array.from({ length: n }, () => fn(rand));
};

/* ── Lính mới: a small fish, and one bubble at a time ──────────────── */

const BODY_MINNOW = ramp('#1d5f8c', '#2a7fb0', '#3ea3cf', '#6cc5e4', '#a4e3f3');
const minnow = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#0a1a2e', '#0d2238', '#102a44', '#153450')));
    world.bubbles = list(11, 7, (r) => ({ x: 56 + r() * 40, speed: 0.08 + r() * 0.06, phase: r(), size: 1 + Math.floor(r() * 2), alpha: 0.8 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const cy = 80 + Math.sin(t * 1.3) * 5;
    const cx = 80 + Math.sin(t * 0.5) * 4;
    const wag = Math.sin(t * 7);
    const shape = (x, y) => {
      let d = ellipse(x, y, cx, cy, 26, 17);
      d = smin(d, stroke(x, y, cx + 24, cy, cx + 42, cy - 12 + wag * 5, 5, 1), 5);
      d = smin(d, stroke(x, y, cx + 24, cy, cx + 42, cy + 12 + wag * 5, 5, 1), 5);
      return d;
    };
    paint(w, [cx - 32, cy - 26, cx + 50, cy + 26], shape, (x, y, d) => {
      const lit = 0.72 - (y - cy) / 26 - (x - cx) / 110;
      return tone(BODY_MINNOW, lit + Math.max(0, -d - 8) * 0.012, x, y);
    });
    finish(ctx, w);
    dot(ctx, cx - 14, cy - 5, 5, '#0a1626');
    dot(ctx, cx - 13, cy - 5, 2, '#ffffff');
    dot(ctx, cx - 25, cy + 4 + Math.sin(t * 2), 3, '#a4e3f3', 0.5);
    risers(ctx, w.bubbles, t, 160, '#cfeffa');
  },
};

/* ── Triệu token: a jellyfish that glows as it breathes ───────────── */

const BELL = ramp('#3a1c70', '#5a2ea6', '#8150d8', '#ae85f0', '#dcc8ff', '#ffffff');
const jelly = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#070a1c', '#0b0f28', '#111636', '#1a1e48'), 0.5, 0.4));
    world.specks = list(12, 26, (r) => ({ x: r() * 160, speed: 0.02 + r() * 0.03, phase: r(), size: 1, alpha: 0.5 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const breath = Math.sin(t * 1.8);
    const cx = 80 + Math.sin(t * 0.4) * 5;
    const cy = 62 - breath * 4;
    const rx = 36 + breath * 5;
    const ry = 30 - breath * 4;
    const shape = (x, y) => (y > cy + 9 + Math.sin((x - cx) * 0.4 + t * 3) * 2 ? 1 : ellipse(x, y, cx, cy, rx, ry));
    paint(w, [cx - rx - 2, cy - ry - 2, cx + rx + 2, cy + 14], shape, (x, y, d) => {
      const spots = Math.sin(x * 0.5 + t) * Math.sin(y * 0.6 - t * 0.7);
      return tone(BELL, 0.34 + (0.28 * (cy - y)) / ry + Math.min(0.3, -d * 0.035) * (d > -3 ? 2 : 0.4) + spots * 0.1 + (breath + 1) * 0.08, x, y);
    });
    finish(ctx, w);
    glow(ctx, cx, cy, 70, 'rgba(140,100,255,0.55)', 0.5 + breath * 0.2);
    // The threads, each with its own slow wave.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 9; i += 1) {
      const startX = cx + ((i - 4) / 4) * (rx - 4);
      ctx.fillStyle = i % 2 ? '#b08cff' : '#7fb4ff';
      for (let k = 0; k < 16; k += 1) {
        const y = cy + 11 + k * 4;
        const x = startX + Math.sin(k * 0.45 + t * 2 + i) * (1 + k * 0.42);
        ctx.globalAlpha = (1 - k / 16) * 0.85;
        ctx.fillRect(Math.round(x), Math.round(y), 2, 3);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    risers(ctx, w.specks, t, 160, '#c8d4ff');
  },
};

/* ── Mười triệu: a ray, with lightning along its wings ────────────── */

const RAY = ramp('#0b2a33', '#124552', '#1c6a78', '#2c97a5', '#58c7cf', '#a7f0ef');
const manta = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#04121c', '#061a26', '#0a2432', '#0f3140', '#154150'), 0.5, 0.2, 1.05));
    world.bits = list(13, 18, (r) => ({ x: r() * 160, speed: 0.03 + r() * 0.05, phase: r(), size: 1, alpha: 0.6 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const flap = Math.sin(t * 2.2);
    const cx = 80;
    const cy = 76 + Math.sin(t * 0.8) * 5;
    const shape = (x, y) => {
      const u = (x - cx) / 62;
      const v = (y - cy - flap * 16 * u * u) / 30;
      let d = (Math.abs(u) ** 1.4 + Math.abs(v + 0.25 * Math.abs(u)) - 1) * 26;
      d = smin(d, stroke(x, y, cx, cy + 16, cx + Math.sin(t * 3) * 7, cy + 62, 3, 0.8), 5);
      d = smin(d, stroke(x, y, cx - 9, cy - 26, cx - 12, cy - 38 + flap * 2, 2.5, 1), 3);
      d = smin(d, stroke(x, y, cx + 9, cy - 26, cx + 12, cy - 38 + flap * 2, 2.5, 1), 3);
      return d;
    };
    paint(w, [cx - 66, cy - 44, cx + 66, cy + 72], shape, (x, y, d) => {
      const u = (x - cx) / 62;
      const fold = 0.42 + flap * u * 0.45 * Math.sign(u) * 0.5 - (y - cy) / 90 + Math.min(0.3, -d * 0.02);
      return tone(RAY, fold, x, y);
    });
    finish(ctx, w);
    dot(ctx, cx - 11, cy - 16, 3, '#04121c');
    dot(ctx, cx + 8, cy - 16, 3, '#04121c');
    glow(ctx, cx, cy, 80, 'rgba(70,220,230,0.35)', 0.6 + flap * 0.2);
    // Lightning: a new path eight times a second, from the same seed each time it comes round.
    const beat = Math.floor(t * 8);
    const rand = seeded(1000 + (beat % 64));
    ctx.globalCompositeOperation = 'lighter';
    for (const side of [-1, 1]) {
      if (rand() < 0.2) continue;
      let x = cx + side * 10;
      let y = cy - 6;
      for (let k = 0; k < 11; k += 1) {
        const nx = x + side * (3 + rand() * 5);
        const ny = y + flap * 2 + (rand() - 0.5) * 7 + 1;
        ctx.strokeStyle = k % 3 ? '#8ff4ff' : '#ffffff';
        ctx.globalAlpha = 0.85 - k * 0.05;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), Math.round(y));
        ctx.lineTo(Math.round(nx), Math.round(ny));
        ctx.stroke();
        x = nx;
        y = ny;
      }
      glow(ctx, x, y, 14, 'rgba(160,250,255,0.9)', 0.6);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    risers(ctx, w.bits, t, 160, '#9ff6ff');
  },
};

/* ── Trăm triệu: a sea dragon, its colours running along it ───────── */

const DRAGON_RAMPS = [ramp('#2a1457', '#4a2389', '#7a39c2', '#a964e6', '#d6a4ff'), ramp('#0d3f55', '#136a80', '#1e9cab', '#4fd0cd', '#a4f2df'), ramp('#5a1648', '#8c2368', '#c33f8b', '#ec74ad', '#ffb6d2')];
const seadragon = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#060416', '#0b0824', '#120d34', '#1a1346', '#231a58'), 0.6, 0.3, 1));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const pathAt = (i, at = t) => ({
      x: 18 + i * 8.6 + Math.sin(at * 0.7) * 3,
      y: 80 + Math.sin(i * 0.62 - at * 2.4) * (12 + i * 0.9) * (0.7 + 0.3 * Math.sin(at * 0.4)),
    });
    const points = Array.from({ length: 16 }, (_, i) => pathAt(i));
    const radius = (i) => mix(10.5, 2.2, smooth(i / 15));
    const shape = (x, y) => {
      let d = 99;
      for (let i = 0; i < 15; i += 1) d = Math.min(d, stroke(x, y, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, radius(i), radius(i + 1)));
      d = smin(d, stroke(x, y, points[0].x, points[0].y, points[0].x - 16, points[0].y + 2, 5, 1.5), 3);
      return d;
    };
    const cycle = (t * 0.25) % DRAGON_RAMPS.length;
    paint(w, [0, 20, 160, 140], shape, (x, y, d) => {
      const i = clamp((x - 18) / 8.6, 0, 15);
      // One colour into the next by a dither, not along a line.
      const phase = (i * 0.1 + cycle) % DRAGON_RAMPS.length;
      const colours = DRAGON_RAMPS[(Math.floor(phase) + (phase % 1 > bayer(x, y) ? 1 : 0)) % DRAGON_RAMPS.length];
      const scale = Math.sin(x * 1.3) * Math.sin(y * 1.3) * 0.08;
      return tone(colours, 0.45 + Math.min(0.5, -d * 0.09) - (y - pathAt(i).y) * 0.02 + scale, x, y);
    });
    finish(ctx, w);
    // Leaf fins, each swinging on its own beat.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < 15; i += 2) {
      const p = points[i];
      const swing = Math.sin(t * 3 + i) * 0.6;
      for (const side of [-1, 1]) {
        for (let k = 1; k < 7; k += 1) {
          const x = p.x + Math.sin(swing + side * 0.4) * k * 1.8;
          const y = p.y + side * (radius(i) + k * 2.1);
          ctx.fillStyle = k % 2 ? '#7fe6d8' : '#c79bff';
          ctx.globalAlpha = 0.65 - k * 0.07;
          ctx.fillRect(Math.round(x), Math.round(y), 3 - (k >> 2), 2);
        }
      }
    }
    // The trail: where it was a moment ago, fading.
    for (let k = 1; k < 26; k += 1) {
      const p = pathAt(15, t - k * 0.04);
      ctx.fillStyle = k % 2 ? '#a4f2df' : '#d6a4ff';
      ctx.globalAlpha = (1 - k / 26) * 0.7;
      ctx.fillRect(Math.round(p.x + k * 1.4), Math.round(p.y + Math.sin(k * 0.8) * 3), 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    glow(ctx, points[0].x, points[0].y, 50, 'rgba(180,140,255,0.45)', 0.7);
    dot(ctx, points[0].x - 5, points[0].y - 5, 3, '#fff');
    dot(ctx, points[0].x - 5, points[0].y - 5, 1, '#1b1040');
  },
};

/* ── Tỷ token: a whale that is a galaxy, and comes apart into stars ── */

const COSMIC_T = 14;
const cosmicWhale = {
  build() {
    const size = 200;
    const n = noise2(9001, 64);
    const NEBULA = ramp('#04030f', '#070519', '#0c0824', '#160c36', '#24104a', '#37155a', '#4d1b68', '#2a2a78', '#1d4a8c');
    const world = makeWorld(size, (x, y) => {
      const v = fbm2(n, x / 26, y / 26, 4);
      return tone(NEBULA, clamp((v - 0.32) * 2.1 + (1 - Math.hypot(x - 100, y - 100) / 150) * 0.2), x, y, 0.9);
    });
    const rand = seeded(9002);
    world.field = Array.from({ length: 150 }, () => ({ x: rand() * size, y: rand() * size, big: rand() < 0.12, phase: rand() * TAU, speed: 0.5 + rand() * 2 }));
    world.swirl = noise2(9003, 64);
    // Where a constellation's stars sit: along the whale's edge, found once.
    const outline = [];
    for (let i = 0; i < 2400 && outline.length < 34; i += 1) {
      const x = 22 + rand() * 170;
      const y = 44 + rand() * 120;
      const d = whaleShape(x, y, 90, 100, 66, 0);
      if (Math.abs(d) < 1.6 && !outline.some((p) => Math.hypot(p.x - x, p.y - y) < 12)) outline.push({ x, y });
    }
    outline.sort((a, b) => Math.atan2(a.y - 100, a.x - 90) - Math.atan2(b.y - 100, b.x - 90));
    world.outline = outline;
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const size = w.size;
    const phase = t % COSMIC_T;
    // Solid; coming apart; a constellation; gathering again.
    const solid = phase < 7 ? 1 : phase < 9 ? 1 - smooth((phase - 7) / 2) : phase < 12 ? 0 : smooth((phase - 12) / 2);
    const bob = Math.sin(t * 0.9) * 4;
    const wag = Math.sin(t * 1.6);
    const cx = 90;
    const cy = 100 + bob;
    const GALAXY = ramp('#0e0a2c', '#23125a', '#42208e', '#6d32c0', '#a052dd', '#d97fe6', '#ffc0ea', '#ffffff');
    if (solid > 0.01) {
      paint(w, [10, 30, size, 180], (x, y) => whaleShape(x, y, cx, cy, 66, wag), (x, y, d) => {
        // It dissolves from the middle out, pixel by pixel.
        const grain = fbm2(w.swirl, x / 11, y / 11, 2);
        if (solid < 1 && grain > solid * 1.1) return 0;
        const dx = x - cx + 12;
        const dy = y - cy;
        const a = Math.atan2(dy, dx * 0.7) + t * 0.22;
        const r = Math.hypot(dx * 0.7, dy) / 42;
        const arms = Math.sin(a * 2 + r * 7) * 0.5 + 0.5;
        const dust = fbm2(w.swirl, x / 16 + t * 0.12, y / 16 - t * 0.05, 3);
        const core = Math.exp(-r * r * 7) * 0.55;
        const edge = d > -3 ? 0.35 : 0;
        return tone(GALAXY, 0.1 + arms * 0.28 * (1 - Math.min(1, r)) + dust * 0.35 + core + edge, x, y);
      });
    }
    finish(ctx, w);
    // Stars behind everything, and sparkling inside the body.
    for (const s of w.field) {
      const a = 0.45 + 0.55 * Math.sin(t * s.speed + s.phase);
      dot(ctx, s.x, s.y, s.big ? 2 : 1, s.big ? '#fff3c9' : '#dbe6ff', Math.max(0.1, a));
    }
    glow(ctx, cx - 12, cy, 92, 'rgba(160,90,255,0.5)', 0.55 + solid * 0.25);
    // The constellation: its stars and the lines between them.
    const stars = 1 - solid;
    if (stars > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#a9c6ff';
      ctx.globalAlpha = stars * 0.7;
      ctx.beginPath();
      w.outline.forEach((p, i) => {
        const x = p.x + Math.sin(t + i) * 1.4 * (1 - solid);
        const y = p.y + bob + Math.cos(t * 0.8 + i) * 1.4;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const [i, p] of w.outline.entries()) {
        const k = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.7);
        const x = p.x + Math.sin(t + i) * 1.4;
        const y = p.y + bob + Math.cos(t * 0.8 + i) * 1.4;
        glow(ctx, x, y, 6 + k * 4, 'rgba(255,240,200,0.95)', stars * (0.5 + k * 0.5));
        dot(ctx, x - 1, y - 1, 2, '#ffffff', stars);
      }
      ctx.globalCompositeOperation = 'source-over';
    } else {
      dot(ctx, cx - 40, cy - 9, 4, '#ffffff');
      dot(ctx, cx - 39, cy - 9, 2, '#120a33');
    }
    // Two planets on one tilted orbit, passing behind and in front.
    for (const [speed, phaseAt, r, hue, ring] of [[0.5, 0, 6, '#ffb36b', true], [0.32, 2.4, 4, '#74d6ff', false]]) {
      const a = t * speed + phaseAt;
      const px = cx - 6 + Math.cos(a) * 84;
      const py = cy + Math.sin(a) * 26;
      const front = Math.sin(a) > 0;
      if (!front) ctx.globalAlpha = 0.55;
      ctx.fillStyle = hue;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.arc(px + r * 0.45, py + r * 0.3, r * 0.82, 0, TAU);
      ctx.fill();
      if (ring) {
        ctx.strokeStyle = '#ffe1b0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(px, py, r * 2, r * 0.62, 0.35, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // A star falling every so often.
    const fall = (t % 9) / 0.9;
    if (fall < 1) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 12; i += 1) dot(ctx, 170 - fall * 90 + i * 2, 18 + fall * 34 - i * 0.8, 1, '#ffffff', (1 - i / 12) * (1 - fall));
      ctx.globalCompositeOperation = 'source-over';
    }
  },
};

/* ── Nhà tài trợ nhỏ: a bronze seahorse under a spinning coin ─────── */

const BRONZE = ramp('#3d2110', '#6a3a18', '#99591f', '#c9842e', '#efb45c', '#ffe3a8');
const seahorse = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#140c08', '#1c120b', '#26180e', '#332011', '#442b15'), 0.5, 0.35));
    world.motes = list(14, 18, (r) => ({ x: r() * 160, speed: 0.03 + r() * 0.03, phase: r(), size: 1, alpha: 0.6 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const bob = Math.sin(t * 1.2) * 4;
    const ox = 78;
    const oy = 78 + bob;
    const curve = [[6, -30], [10, -18], [8, -6], [2, 6], [-2, 18], [2, 30], [14, 36], [24, 28], [20, 18], [10, 20]];
    const shape = (x, y) => {
      let d = 99;
      for (let i = 0; i < curve.length - 1; i += 1) {
        const [ax, ay] = curve[i];
        const [bx, by] = curve[i + 1];
        d = Math.min(d, stroke(x, y, ox + ax, oy + ay, ox + bx, oy + by, mix(11, 2, i / 9), mix(11, 2, (i + 1) / 9)));
      }
      d = smin(d, stroke(x, y, ox + 2, oy - 34, ox - 20, oy - 28, 3.4, 2.4), 3);
      d = smin(d, circle(x, y, ox + 6, oy - 36, 8), 3);
      d = smin(d, stroke(x, y, ox + 6, oy - 43, ox + 3, oy - 50, 2, 0.8), 2);
      d = smin(d, stroke(x, y, ox + 11, oy - 41, ox + 15, oy - 47, 2, 0.8), 2);
      return d;
    };
    const sheen = (t * 0.6) % 1;
    paint(w, [ox - 30, oy - 56, ox + 34, oy + 46], shape, (x, y, d) => {
      const ring = Math.sin((y - oy) * 1.4) * 0.07;
      const band = Math.exp(-(((x + y) / 200 - sheen * 1.6 + 0.2) ** 2) / 0.004) * 0.4;
      return tone(BRONZE, 0.42 - (x - ox) * 0.012 + Math.min(0.28, -d * 0.05) + ring + band, x, y);
    });
    finish(ctx, w);
    // The fin on its back, fluttering.
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 10; k += 1) {
      const y = oy - 8 + k * 2.2;
      const len = 11 - Math.abs(k - 5) + Math.sin(t * 9 + k) * 2;
      ctx.fillStyle = '#f2b65d';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(Math.round(ox + 15), Math.round(y), Math.round(len), 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    dot(ctx, ox + 3, oy - 39, 3, '#1b0e06');
    dot(ctx, ox + 3, oy - 39, 1, '#fff');
    // The coin overhead.
    const spin = Math.cos(t * 2.4);
    const coinX = 112;
    const coinY = 34 + Math.sin(t * 1.5) * 3;
    const wide = Math.max(1, Math.abs(spin) * 10);
    ctx.fillStyle = spin > 0 ? '#ffd76a' : '#d39a2d';
    ctx.beginPath();
    ctx.ellipse(coinX, coinY, wide, 10, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#8a5a13';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (wide > 3) {
      ctx.beginPath();
      ctx.ellipse(coinX, coinY, wide * 0.62, 6, 0, 0, TAU);
      ctx.stroke();
    }
    glow(ctx, coinX, coinY, 26, 'rgba(255,205,90,0.7)', 0.45 + Math.abs(spin) * 0.3);
    risers(ctx, w.motes, t, 160, '#ffd98c');
  },
};

/* ── Nhà tài trợ lớn: a jade turtle, its plates lighting in turn ───── */

const JADE = ramp('#06291f', '#0c4733', '#14704e', '#23a06f', '#54cf98', '#a8f2c9', '#efffee');
const SKIN = ramp('#22391f', '#3a5a2e', '#5a7f3f', '#83a858', '#b4cc7c');
const jadeTurtle = {
  build() {
    const world = makeWorld(160, glowBack(160, ramp('#03110e', '#051a15', '#07231c', '#0a2e24', '#0e3a2d'), 0.5, 0.45));
    world.motes = list(15, 16, (r) => ({ x: r() * 160, speed: 0.03 + r() * 0.04, phase: r(), size: 1, alpha: 0.6 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const bob = Math.sin(t * 0.9) * 4;
    const cx = 80;
    const cy = 82 + bob;
    const flap = Math.sin(t * 1.7);
    const limbs = (x, y) => {
      let d = circle(x, y, cx - 44 + Math.sin(t) * 2, cy - 8, 11);
      d = Math.min(d, stroke(x, y, cx - 26, cy + 14, cx - 50, cy + 28 + flap * 10, 6, 3));
      d = Math.min(d, stroke(x, y, cx + 26, cy + 14, cx + 50, cy + 28 - flap * 10, 6, 3));
      d = Math.min(d, stroke(x, y, cx - 22, cy - 18, cx - 44, cy - 34 - flap * 8, 6, 3));
      d = Math.min(d, stroke(x, y, cx + 24, cy - 18, cx + 46, cy - 32 + flap * 8, 6, 3));
      d = Math.min(d, stroke(x, y, cx + 36, cy, cx + 50, cy + 2, 4, 1));
      return d;
    };
    paint(w, [cx - 64, cy - 52, cx + 64, cy + 52], limbs, (x, y, d) => tone(SKIN, 0.45 - (y - cy) * 0.012 + Math.min(0.3, -d * 0.08), x, y));
    // Hexagon plates, by the nearest of a grid, each with a beat of its own.
    const HEX = 13.5;
    paint(w, [cx - 40, cy - 34, cx + 40, cy + 34], (x, y) => ellipse(x, y, cx, cy, 37, 30), (x, y, d) => {
      const row = Math.round((y - cy) / (HEX * 0.87));
      const col = Math.round((x - cx) / HEX - (row & 1) * 0.5);
      const gx = cx + (col + (row & 1) * 0.5) * HEX;
      const gy = cy + row * HEX * 0.87;
      const off = Math.max(Math.abs(x - gx) * 0.95 + Math.abs(y - gy) * 0.5, Math.abs(y - gy));
      const seam = off > HEX * 0.44;
      const beat = Math.max(0, Math.sin(t * 1.6 - (col + row * 2) * 0.9));
      const v = 0.3 + beat ** 4 * 0.6 - (y - cy) * 0.006 - (x - cx) * 0.003 + Math.min(0.2, -d * 0.02);
      return tone(JADE, seam ? 0.08 : v, x, y, 0.55);
    });
    finish(ctx, w);
    dot(ctx, cx - 49, cy - 12, 3, '#0a1a10');
    dot(ctx, cx - 49, cy - 12, 1, '#fff');
    // Crystals on one tilted ring, behind it and in front of it.
    for (let i = 0; i < 6; i += 1) {
      const a = t * 0.7 + (i / 6) * TAU;
      const x = cx + Math.cos(a) * 62;
      const y = cy + Math.sin(a) * 18 - 2;
      const s = 3.5 + Math.sin(a) * 1.5;
      ctx.globalAlpha = Math.sin(a) > 0 ? 1 : 0.5;
      ctx.fillStyle = i % 2 ? '#a8f2c9' : '#9fd8ff';
      ctx.beginPath();
      ctx.moveTo(x, y - s * 1.6);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s * 1.6);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(x - 1), Math.round(y - s), 1, 2);
      ctx.globalAlpha = 1;
      glow(ctx, x, y, 12, 'rgba(150,255,210,0.8)', Math.sin(a) > 0 ? 0.7 : 0.3);
    }
    glow(ctx, cx, cy, 72, 'rgba(90,240,170,0.28)', 0.6 + Math.sin(t * 1.6) * 0.2);
    risers(ctx, w.motes, t, 160, '#c6ffe3');
  },
};

/* ── Đại gia: a whale of gold, a crown, rings of light, a rain of coins ── */

const GOLD = ramp('#2e1a04', '#5c3607', '#8f590c', '#c48414', '#eab02a', '#ffd964', '#fff3b8', '#ffffff');
const goldWhale = {
  build() {
    const size = 200;
    const world = makeWorld(size, glowBack(size, ramp('#0a0614', '#120a1e', '#1b0f2a', '#281536', '#371c40', '#4a2644'), 0.5, 0.48, 0.85));
    world.coins = list(16, 26, (r) => ({ x: r() * size, speed: 0.12 + r() * 0.16, phase: r(), wobble: r() * TAU, size: 2 + Math.floor(r() * 3) }));
    world.sparks = list(17, 32, (r) => ({ a: r() * TAU, r: 30 + r() * 64, speed: 0.4 + r() * 1.2, phase: r() * TAU }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const size = w.size;
    const bob = Math.sin(t * 0.9) * 4;
    const wag = Math.sin(t * 1.8);
    const cx = 96;
    const cy = 112 + bob;
    // Every twelve seconds it swells and throws off a ring.
    const pulseAt = t % 12;
    const swell = pulseAt < 1.6 ? Math.sin((pulseAt / 1.6) * Math.PI) : 0;
    const scale = 58 + swell * 7;
    paint(w, [8, 40, size, 190], (x, y) => whaleShape(x, y, cx, cy, scale, wag), (x, y, d) => {
      // Polished: bands of reflected light that slide with the time.
      const fold = (y - cy) / 40 + (x - cx) / 160;
      const bands = Math.sin(fold * 6 + t * 1.1) * 0.25 + Math.sin(fold * 15 - t * 0.7) * 0.1;
      const sweep = Math.exp(-(((x - y) / 200 - ((t * 0.28) % 1.5) + 0.5) ** 2) / 0.002) * 0.7;
      const rim = d > -2.4 ? 0.25 : 0;
      return tone(GOLD, 0.42 + bands - fold * 0.14 + sweep + rim + swell * 0.2, x, y, 0.65);
    });
    finish(ctx, w);
    // Light turning behind it.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * TAU + t * 0.14;
      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * 130, cy + Math.sin(a) * 130);
      g.addColorStop(0, 'rgba(255,205,90,0.2)');
      g.addColorStop(1, 'rgba(255,205,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a - 0.07) * 150, cy + Math.sin(a - 0.07) * 150);
      ctx.lineTo(cx + Math.cos(a + 0.07) * 150, cy + Math.sin(a + 0.07) * 150);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    glow(ctx, cx, cy, 104, 'rgba(255,190,70,0.42)', 0.6 + swell * 0.4);
    // Two rings of light: the half behind was drawn dimmer, so it reads as going round.
    for (const [rx, ry, tilt, speed, colour] of [[86, 22, -0.22, 0.9, '#ffe48a'], [78, 18, 0.2, -0.7, '#ffc24d']]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, tilt, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (let i = 0; i < 4; i += 1) {
        const a = t * speed + (i / 4) * TAU;
        const px = cx + Math.cos(a) * rx * Math.cos(tilt) - Math.sin(a) * ry * Math.sin(tilt);
        const py = cy + Math.cos(a) * rx * Math.sin(tilt) + Math.sin(a) * ry * Math.cos(tilt);
        glow(ctx, px, py, 10, 'rgba(255,240,180,0.95)', 0.9);
        dot(ctx, px - 1, py - 1, 3, '#ffffff');
      }
    }
    // The ring it threw off.
    if (pulseAt < 2.4) {
      const k = pulseAt / 2.4;
      ctx.strokeStyle = '#fff1b0';
      ctx.lineWidth = 2 * (1 - k) + 0.5;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, 30 + k * 96, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // The crown.
    const hx = cx - scale * 0.3;
    const hy = cy - scale * 0.42 - 2;
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath();
    ctx.moveTo(hx - 16, hy + 8);
    ctx.lineTo(hx - 18, hy - 8);
    ctx.lineTo(hx - 8, hy);
    ctx.lineTo(hx, hy - 13);
    ctx.lineTo(hx + 8, hy);
    ctx.lineTo(hx + 18, hy - 8);
    ctx.lineTo(hx + 16, hy + 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#9a5f0d';
    ctx.fillRect(Math.round(hx - 16), Math.round(hy + 5), 32, 3);
    for (const [gx, gy, colour] of [[-18, -8, '#ff5d8f'], [0, -13, '#7fd8ff'], [18, -8, '#7dffb0']]) {
      dot(ctx, hx + gx - 1, hy + gy - 1, 3, colour);
      glow(ctx, hx + gx, hy + gy, 7, 'rgba(255,255,255,0.9)', 0.4 + 0.4 * Math.sin(t * 3 + gx));
    }
    dot(ctx, cx - scale * 0.56, cy - scale * 0.14, 5, '#2e1a04');
    dot(ctx, cx - scale * 0.56, cy - scale * 0.14, 2, '#ffffff');
    // A rain of gold, turning as it falls.
    for (const c of w.coins) {
      const k = ((t * c.speed + c.phase) % 1 + 1) % 1;
      const x = c.x + Math.sin(k * 8 + c.wobble) * 3;
      const y = k * (size + 8) - 4;
      const wide = Math.abs(Math.cos(t * 3 + c.wobble)) * c.size + 0.5;
      ctx.fillStyle = Math.cos(t * 3 + c.wobble) > 0 ? '#ffd964' : '#c48414';
      ctx.fillRect(Math.round(x - wide / 2), Math.round(y), Math.ceil(wide), c.size + 1);
    }
    for (const s of w.sparks) {
      const k = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      if (k < 0.72) continue;
      dot(ctx, cx + Math.cos(s.a) * s.r, cy + Math.sin(s.a) * s.r * 0.72, 2, '#fff8d8', (k - 0.72) * 3.2);
    }
  },
};

/* ── Hạng ba: a bronze dolphin, out of the water and back ─────────── */

const dolphinTone = ramp('#3a200d', '#633818', '#8f5420', '#bd7a2e', '#e4a653', '#ffd691');
const bronzeDolphin = {
  build() {
    const world = makeWorld(160, (x, y) => tone(ramp('#120f1c', '#1c1626', '#271d30', '#33263a'), y / 160, x, y));
    world.drops = list(21, 22, (r) => ({ dx: (r() - 0.5) * 2, up: 0.5 + r() * 0.9, size: 1 + Math.floor(r() * 2) }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const size = 160;
    const water = 118;
    // A leap every four seconds, along an arc.
    const k = (t % 4) / 4;
    const x = 30 + k * 100;
    const y = water + 12 - Math.sin(k * Math.PI) * 92;
    const dir = Math.atan2(-Math.cos(k * Math.PI) * 92, 100);
    const cos = Math.cos(dir);
    const sin = Math.sin(dir);
    const shape = (px, py) => {
      const u = (px - x) * cos + (py - y) * sin;
      const v = -(px - x) * sin + (py - y) * cos;
      let d = ellipse(u, v, 0, 0, 30, 11);
      d = smin(d, stroke(u, v, 26, 0, 40, 0, 4, 2), 4);
      d = smin(d, stroke(u, v, -28, -1, -42, -9, 3.5, 1), 3);
      d = smin(d, stroke(u, v, -28, -1, -42, 8, 3.5, 1), 3);
      d = smin(d, stroke(u, v, 2, -9, -6, -20, 5, 1), 4);
      d = smin(d, stroke(u, v, 8, 9, 0, 20, 4, 1), 3);
      return d;
    };
    paint(w, [x - 50, y - 50, x + 50, y + 50], shape, (px, py, d) => {
      const v = -(px - x) * sin + (py - y) * cos;
      const sheen = Math.exp(-(((px + py) / 160 - ((t * 0.5) % 2) + 0.2) ** 2) / 0.004) * 0.3;
      return tone(dolphinTone, 0.5 - v * 0.03 + Math.min(0.2, -d * 0.03) + sheen, px, py);
    });
    // Water, in front of a dive.
    const WATER = ramp('#16283c', '#1d3650', '#274866', '#335d7f', '#4b7f9f');
    for (let py = water; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        const ripple = Math.sin(px * 0.22 + t * 2.4 + py * 0.5) * 0.14 + Math.sin(px * 0.07 - t * 1.3) * 0.1;
        w.px[py * size + px] = tone(WATER, 0.68 - (py - water) / 50 + ripple, px, py);
      }
    }
    finish(ctx, w);
    // Spray where it broke the surface, going up and coming down.
    for (const [at, from] of [[0, 34], [0.93, 124]]) {
      const since = ((k - at + 1) % 1) * 4;
      if (since > 1.2) continue;
      for (const d of w.drops) {
        const dx = from + d.dx * since * 32;
        const dy = water - d.up * since * 54 + since * since * 34;
        if (dy > water) continue;
        dot(ctx, dx, dy, d.size, '#e4eef6', 1 - since / 1.2);
      }
    }
    // A laurel, for the place it stands for: a stem, and leaves along it.
    ctx.strokeStyle = '#cd7f32';
    ctx.fillStyle = '#e09a4d';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6 + 0.2 * Math.sin(t * 2);
    ctx.beginPath();
    ctx.arc(80, 62, 50, Math.PI * 0.72, Math.PI * 2.28);
    ctx.stroke();
    for (let a = 0.76; a < 2.26; a += 0.09) {
      const out = Math.PI * a;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(80 + Math.cos(out) * (50 + side * 3.5), 62 + Math.sin(out) * (50 + side * 3.5), 4, 1.6, out + (side * Math.PI) / 3 + Math.PI / 2, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    glow(ctx, 80, 62, 66, 'rgba(205,127,50,0.3)', 0.55);
  },
};

/* ── Hạng nhì: a silver marlin, fast ──────────────────────────────── */

const SILVER = ramp('#1b2230', '#34405a', '#566783', '#8598b2', '#b9c8d8', '#e6eef5', '#ffffff');
const silverMarlin = {
  build() {
    const size = 180;
    const world = makeWorld(size, (x, y) => tone(ramp('#060a14', '#0a101e', '#0f1829', '#142136', '#1b2c45'), 1 - Math.hypot(x / size - 0.5, y / size - 0.5) * 1.5, x, y));
    world.streaks = list(22, 34, (r) => ({ y: r() * size, speed: 120 + r() * 240, phase: r() * size, length: 8 + r() * 24 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const cx = 92 + Math.sin(t * 0.8) * 8;
    const cy = 92 + Math.sin(t * 1.1) * 6;
    const wag = Math.sin(t * 9);
    const sail = 0.8 + 0.2 * Math.sin(t * 0.7);
    const shape = (x, y) => {
      let d = ellipse(x, y, cx, cy, 46, 13);
      d = smin(d, stroke(x, y, cx - 40, cy - 2, cx - 82, cy - 6, 3.2, 0.6), 4);
      d = smin(d, stroke(x, y, cx + 40, cy, cx + 58, cy - 18 + wag * 3, 5, 1), 4);
      d = smin(d, stroke(x, y, cx + 40, cy, cx + 58, cy + 18 + wag * 3, 5, 1), 4);
      // The sail: tall at the front and falling away, raised and lowered as it turns.
      const along = (x - (cx - 32)) / 62;
      if (along > 0 && along < 1) {
        const top = cy - 10 - 38 * sail * Math.sqrt(1 - along) * smooth(Math.min(1, along * 7));
        if (y < cy - 8 && y > top + Math.sin(along * 22) * 1.2) d = Math.min(d, -1);
      }
      d = smin(d, stroke(x, y, cx - 8, cy + 10, cx - 16, cy + 28, 3, 0.8), 3);
      return d;
    };
    const sweep = (t * 0.9) % 2.2;
    paint(w, [cx - 90, cy - 50, cx + 66, cy + 36], shape, (x, y, d) => {
      const shine = Math.exp(-(((x - cx) / 90 - sweep + 1.1) ** 2) / 0.012) * 0.6;
      // The sail is the dark of the sea with bright spines through it; the body, silver.
      const inSail = y < cy - 11;
      if (inSail) return tone(SILVER, 0.18 + (Math.sin(x * 0.85) > 0.72 ? 0.36 : 0) + ((cy - y) / 40) * 0.14 + shine * 0.6, x, y, 0.6);
      const stripes = y < cy && Math.sin((x - t * 30) * 0.5) > 0.86 ? 0.2 : 0;
      return tone(SILVER, 0.5 - (y - cy) * 0.024 + Math.min(0.18, -d * 0.04) + stripes + shine, x, y, 0.65);
    });
    finish(ctx, w);
    dot(ctx, cx - 36, cy - 6, 4, '#0a101e');
    dot(ctx, cx - 35, cy - 6, 2, '#ffffff');
    // How fast it is going.
    ctx.globalCompositeOperation = 'lighter';
    for (const s of w.streaks) {
      const x = 180 - ((t * s.speed + s.phase) % 220) + 20;
      ctx.fillStyle = '#9fb7d6';
      ctx.globalAlpha = 0.35;
      ctx.fillRect(Math.round(x), Math.round(s.y), Math.round(s.length), 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    glow(ctx, cx, cy, 86, 'rgba(180,205,235,0.3)', 0.7);
    // A glint running off the bill.
    const glint = (t * 0.6) % 1;
    if (glint < 0.16) glow(ctx, cx - 82, cy - 6, 18 * (1 - glint / 0.16), 'rgba(255,255,255,0.95)', 1 - glint / 0.16);
  },
};

/* ── Hạng nhất: a koi that becomes a dragon, and comes back ───────── */

const KOI_T = 16;
const KOI_GOLD = ramp('#4a1806', '#7f2c08', '#b8480b', '#e27a12', '#f8ad24', '#ffda63', '#fff6c7');
const KOI_RED = ramp('#3d0509', '#6f0b10', '#a8151a', '#dc2c25', '#f85d3c', '#ffa56e', '#ffe1bd');
const koiDragon = {
  build() {
    const size = 200;
    const world = makeWorld(size, glowBack(size, ramp('#0c0406', '#16070a', '#23090d', '#340d0f', '#471412', '#5a1c13'), 0.5, 0.5, 0.85));
    world.embers = list(23, 50, (r) => ({ x: r() * size, speed: 0.08 + r() * 0.14, phase: r(), size: 1 + Math.floor(r() * 2), alpha: 0.9 }));
    return world;
  },
  draw(ctx, t, w) {
    begin(w);
    const phase = t % KOI_T;
    // A koi; a change; a dragon; a change back.
    const dragon = phase < 5 ? 0 : phase < 7 ? smooth((phase - 5) / 2) : phase < 13 ? 1 : phase < 15 ? 1 - smooth((phase - 13) / 2) : 0;
    const count = 14;
    const span = mix(9, 13, dragon);
    const swim = t * mix(2.8, 2.1, dragon);
    const wave = mix(7, 20, dragon);
    const pointAt = (i) => ({ x: 28 + i * span + (dragon ? 0 : 0), y: 104 + Math.sin(i * mix(0.45, 0.72, dragon) - swim) * wave * (0.3 + (i / count) * mix(1.1, 0.75, dragon)) });
    const points = Array.from({ length: count + 1 }, (_, i) => pointAt(i));
    const radius = (i) => {
      const k = i / count;
      const koi = 19 * Math.sin(Math.min(1, k * 1.1 + 0.22) * Math.PI) ** 0.8 + 1.5;
      const long = mix(13, 3, smooth(k));
      return mix(koi, long, dragon);
    };
    const shape = (x, y) => {
      let d = 99;
      for (let i = 0; i < count; i += 1) d = Math.min(d, stroke(x, y, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, radius(i), radius(i + 1)));
      const end = points[count];
      d = smin(d, stroke(x, y, end.x, end.y, end.x + 18, end.y - 16 + Math.sin(t * 5) * 6, 5, 1), 5);
      d = smin(d, stroke(x, y, end.x, end.y, end.x + 18, end.y + 16 + Math.sin(t * 5) * 6, 5, 1), 5);
      if (dragon > 0.05) {
        const h = points[0];
        // Antlers, growing as it changes.
        d = Math.min(d, stroke(x, y, h.x + 2, h.y - 10, h.x + 12 * dragon, h.y - 30 * dragon, 2.2, 0.8));
        d = Math.min(d, stroke(x, y, h.x + 8 * dragon, h.y - 22 * dragon, h.x + 18 * dragon, h.y - 24 * dragon, 1.5, 0.6));
        d = Math.min(d, stroke(x, y, h.x - 2, h.y - 10, h.x - 6 * dragon, h.y - 28 * dragon, 2.2, 0.8));
        // A jaw.
        d = smin(d, stroke(x, y, h.x - 6, h.y + 2, h.x - 22 * dragon, h.y + 4, 6, 2.5), 3);
      }
      return d;
    };
    paint(w, [0, 20, 200, 190], shape, (x, y, d) => {
      const i = clamp((x - 28) / span, 0, count);
      const near = points[Math.round(i)] || points[0];
      const v = (y - near.y) / Math.max(4, radius(Math.round(i)));
      // Scales in rows.
      const row = Math.floor((y - near.y + 40) / 4.5);
      const col = (x + (row & 1) * 2.5) / 5;
      const scale = 0.5 - Math.abs(((col % 1) + 1) % 1 - 0.5);
      // The koi's red patches; the dragon is gold from nose to tail, ablaze.
      const patch = Math.sin(x * 0.11 + 1.3) + Math.sin(y * 0.2 + x * 0.05) > 0.5 ? KOI_RED : KOI_GOLD;
      const colours = dragon > 0.5 ? KOI_GOLD : patch;
      const shine = Math.exp(-(((x - y * 0.5) / 200 - ((t * 0.32) % 1.6) + 0.25) ** 2) / 0.004) * 0.5;
      return tone(colours, 0.56 - v * 0.34 + scale * 0.24 + Math.min(0.2, -d * 0.03) + shine + dragon * 0.08, x, y, 0.6);
    });
    finish(ctx, w);
    const head = points[0];
    dot(ctx, head.x - 6, head.y - 6, 4, '#120403');
    dot(ctx, head.x - 6, head.y - 6, 2, dragon > 0.5 ? '#ff5a2a' : '#ffffff');
    // The whiskers.
    ctx.strokeStyle = '#ffd97a';
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(head.x - 12, head.y + 2);
      for (let k = 1; k < 8; k += 1) ctx.lineTo(head.x - 12 - k * mix(1.4, 3.6, dragon), head.y + 2 + side * k * mix(0.8, 1.6, dragon) + Math.sin(t * 4 + k) * mix(0.5, 2.2, dragon));
      ctx.stroke();
    }
    // The fire it changes in.
    if (dragon > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 1; i < count; i += 1) {
        for (let k = 0; k < 4; k += 1) {
          const rise = ((t * 1.4 + i * 0.37 + k * 0.29) % 1 + 1) % 1;
          const p = points[i];
          ctx.fillStyle = rise < 0.4 ? '#ffe28a' : rise < 0.7 ? '#ff9a32' : '#e0401a';
          ctx.globalAlpha = (1 - rise) * dragon * 0.85;
          ctx.fillRect(Math.round(p.x + Math.sin(i * 7 + k) * radius(i)), Math.round(p.y - radius(i) - rise * 26), 2 + (k & 1), 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    // The moment of the change: a ring and a flash.
    const flash = Math.max(0, 1 - Math.abs(phase - 6) / 0.9);
    if (flash > 0) {
      glow(ctx, 100, 104, 130, 'rgba(255,220,130,1)', flash * 0.8);
      ctx.strokeStyle = '#fff1b4';
      ctx.lineWidth = 2;
      ctx.globalAlpha = flash;
      ctx.beginPath();
      ctx.arc(100, 104, 20 + (1 - flash) * 80, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    glow(ctx, 90, 104, 110, 'rgba(255,140,50,0.4)', 0.4 + dragon * 0.5);
    risers(ctx, w.embers, t, 200, dragon > 0.5 ? '#ffb24d' : '#ffd98c');
  },
};

/** The creatures by their id in the catalogue. */
export default {
  'pet-minnow': minnow,
  'pet-jelly': jelly,
  'pet-manta': manta,
  'pet-seadragon': seadragon,
  'pet-cosmic-whale': cosmicWhale,
  'pet-seahorse': seahorse,
  'pet-jade-turtle': jadeTurtle,
  'pet-gold-whale': goldWhale,
  'pet-bronze-dolphin': bronzeDolphin,
  'pet-silver-marlin': silverMarlin,
  'pet-koi-dragon': koiDragon,
};
