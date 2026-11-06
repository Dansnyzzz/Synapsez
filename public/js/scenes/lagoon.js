import { W, H, TAU, clamp, wave, along, seeded, rgba, ramp, bayer, Art, noise2, fbm2, puffs, slide } from './art.js';

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

export default lagoon;
