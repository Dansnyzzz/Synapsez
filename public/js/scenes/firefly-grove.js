import { W, H, TAU, clamp, smooth, wave, along, seeded, rgba, ramp, bayer, newCanvas, Art, noise1, noise2, fbm1, fbm2, puffs, slide, fir } from './art.js';

/** A soft light that adds to what is under it; a gradient painted once, so a frame only copies it. */
function halo(size, stops) {
  const c = newCanvas(size, size);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * A forest at night under a small moon: three depths of trees, moonlight falling
 * through them, low mist, mushrooms that glow at the foot of two great trunks, grass
 * that moves, and fireflies, a few of them close enough to go soft.
 */
const fireflyGrove = {
  build() {
    const rand = seeded(4401);
    const [mx, my] = [250, 72];
    const SKY = ramp('#040d12', '#06141a', '#091d22', '#0d272a', '#123332', '#1a4140', '#25524c', '#35675a', '#4a7f69', '#6b9f83');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot((x - 250) / 1.6, y - 128);
      const m = Math.hypot(x - mx, y - my);
      return clamp(0.07 + 0.66 * Math.exp(-((d / 118) ** 2)) + 0.5 * Math.exp(-((m / 50) ** 2)) + (y / H) * 0.05);
    }, 0.95);
    const grain = noise2(4407, 64);
    const MOON = ramp('#b9dcc0', '#d6eed0', '#eef9e2', '#fffff2');
    sky.shade(MOON, (x, y) => {
      const m = Math.hypot(x - mx, y - my);
      if (m > 12) return -1;
      return clamp(1.02 - m / 34 - fbm2(grain, x / 7, y / 7, 2) * 0.42);
    }, 0.5, [mx - 13, my - 13, mx + 14, my + 14]);

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

    // Moonlight, fanning down from behind the far trees and broken up by them.
    const rays = new Art();
    const RAY = rgba('#b4efd0');
    const rayNoise = noise1(4406, 128);
    for (let y = my + 6; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const a = Math.atan2(x - mx, y - my);
        if (Math.abs(a) > 1.25) continue;
        const v = Math.max(0, fbm1(rayNoise, (a + 2) * 13, 2) - 0.46) * 4 * Math.exp(-Math.hypot(x - mx, y - my) / 175);
        if (v > bayer(x, y)) rays.put(x, y, RAY);
      }
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

    // The near ramp runs on into moss, for the sides the moon can reach.
    const NEAR = ramp('#020708', '#040c0e', '#071314', '#0a1b1b', '#0f2a25', '#174033', '#245a43', '#3a7a56');
    const ROOF = ramp('#020708', '#040c0e', '#071314', '#0a1b1b');
    const near = new Art();
    // Two great trunks frame the middle: long grain in the bark, moss on the lit side.
    for (const [cx, half, dir] of [[42, 25, 1], [438, 31, -1]]) {
      for (let y = 0; y < H; y += 1) {
        const swell = half + Math.sin(y / 34) * 2 + Math.max(0, y - 214) * 0.34;
        for (let x = Math.round(cx - swell); x <= cx + swell; x += 1) {
          const toward = ((x - cx) / swell) * dir;
          const furrow = 1 - Math.abs(grain(x / 2.4, y / 15) * 2 - 1);
          const rim = smooth(clamp((toward - 0.5) / 0.5));
          const moss = smooth(clamp((fbm2(grain, x / 8, y / 6, 2) - 0.5) * 7)) * rim * clamp(0.25 + y / H);
          near.tone(x, y, NEAR, clamp(0.03 + furrow * 0.13 + (toward + 1) * 0.04 + rim * 0.15 + moss * 0.42), 0.7);
        }
      }
      // Roots running out into the clearing, lit along their backs.
      for (let r = 0; r < 4; r += 1) {
        const long = 22 + r * 13 + rand() * 10;
        const start = 216 + r * 6;
        for (let k = 0; k <= 1; k += 1 / (long * 2)) {
          const rx = cx + dir * (half + 2 + k * long);
          const ry = start + k * k * (28 - r * 3) + Math.sin(k * 5 + r) * 1.5;
          const rad = (1 - k) * 5 + 1;
          for (let dy = -Math.round(rad); dy <= rad; dy += 1) {
            for (let dx = -Math.round(rad); dx <= rad; dx += 1) {
              if (dx * dx + dy * dy > rad * rad) continue;
              near.tone(Math.round(rx + dx), Math.round(ry + dy), NEAR, clamp(0.1 + (dy < 0 ? (-dy / rad) * 0.32 : 0)), 0.6);
            }
          }
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
    puffs(near, roof, ROOF, { spread: 0.8, height: 0.45, light: [0, 1, 0.3] });
    const grassBand = noise1(4404, 128);
    const groundY = (x) => 240 + fbm1(grassBand, x / 34, 2) * 14;
    for (let x = 0; x < W; x += 1) {
      const g = groundY(x);
      const lit = Math.exp(-(((x - 240) / 135) ** 2));
      for (let y = Math.round(g); y < H; y += 1) {
        near.tone(x, y, NEAR, clamp(0.06 + lit * (0.1 + fbm2(grain, x / 11, y / 5, 2) * 0.34) * clamp(1.15 - (y - g) / 24)), 0.8);
      }
    }
    // Ferns in the corners of the clearing.
    for (const [bx, n, size] of [[84, 9, 30], [118, 7, 20], [168, 6, 14], [326, 6, 15], [362, 8, 24], [398, 9, 32]]) {
      const by = Math.round(groundY(bx)) + 3;
      for (let i = 0; i < n; i += 1) {
        const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.5;
        const long = size * (0.72 + rand() * 0.4);
        for (let k = 0; k <= long; k += 1) {
          const s = k / long;
          const fx = bx + Math.cos(a) * k;
          const fy = by + Math.sin(a) * k + s * s * long * 0.55;
          const tone = NEAR[Math.round(1 + (1 - s) * 2 + (bx > 240 ? (a < -1.5 ? 1 : 0) : a > -1.5 ? 1 : 0))];
          near.put(Math.round(fx), Math.round(fy), tone);
          if (k % 2 === 0) {
            const leaf = Math.round((1 - s) * size * 0.16) + 1;
            for (let l = 1; l <= leaf; l += 1) {
              near.put(Math.round(fx - Math.sin(a) * l), Math.round(fy + Math.cos(a) * l), tone);
              near.put(Math.round(fx + Math.sin(a) * l), Math.round(fy - Math.cos(a) * l + l * 0.4), tone);
            }
          }
        }
      }
    }
    // Mushrooms, in little groups where the roots come down.
    const CAP = ramp('#17806f', '#2cb9a0', '#58e6cb', '#a9fff0');
    const shrooms = [];
    for (const [gx, count] of [[70, 4], [104, 3], [148, 2], [224, 2], [292, 3], [352, 3], [392, 5]]) {
      for (let i = 0; i < count; i += 1) {
        const x = gx + Math.round((rand() - 0.5) * 18);
        const y = Math.round(groundY(x)) + 1 + Math.floor(rand() * 7);
        const r = 2 + Math.floor(rand() * 3);
        const tall = r + 1 + Math.floor(rand() * 3);
        near.rect(x, y - tall, 1, tall, rgba('#a6d8c8'));
        for (let dy = 0; dy <= r; dy += 1) {
          const half = Math.round(Math.sqrt(r * r - dy * dy) * 1.25);
          for (let dx = -half; dx <= half; dx += 1) near.tone(x + dx, y - tall - dy, CAP, clamp(0.25 + (dy / r) * 0.5 - (dx / (half + 1)) * 0.25), 0.6);
        }
        shrooms.push({ x, y: y - tall, r, period: 4 + rand() * 5, phase: rand() });
      }
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
      const lit = Math.abs(x - 240) < 130;
      blades.push({ x, y: Math.round(groundY(x)) + 2, h: 3 + Math.floor(rand() * 7), phase: rand(), tone: lit && rand() < 0.4 ? '#1f5540' : rand() < 0.5 ? '#0d2a24' : rand() < 0.5 ? '#123529' : '#0a2020' });
    }
    const flies = [];
    for (let i = 0; i < 72; i += 1) {
      flies.push({ x: 40 + rand() * 400, y: 96 + rand() * 154, ax: 14 + rand() * 30, ay: 8 + rand() * 18, p1: 9 + rand() * 16, p2: 7 + rand() * 13, p3: 2.4 + rand() * 3.6, phase: rand() });
    }
    const close = [];
    for (const [x, y] of [[120, 120], [176, 196], [338, 150], [408, 208], [258, 226], [70, 176]]) {
      close.push({ x, y, ax: 18 + rand() * 22, ay: 12 + rand() * 12, p1: 13 + rand() * 12, p2: 10 + rand() * 9, p3: 3.4 + rand() * 3, phase: rand() });
    }
    return {
      sky: sky.canvas(), far: far.canvas(), rays: rays.canvas(), mid: mid.canvas(), near: near.canvas(), mist: mist.canvas(), blades, flies, close, shrooms,
      light: halo(15, [[0, 'rgba(226,255,120,0.75)'], [0.28, 'rgba(190,240,90,0.26)'], [1, 'rgba(170,230,80,0)']]),
      soft: halo(29, [[0, 'rgba(235,255,150,0.62)'], [0.2, 'rgba(210,250,110,0.42)'], [0.55, 'rgba(180,235,90,0.12)'], [1, 'rgba(170,230,80,0)']]),
      spore: halo(31, [[0, 'rgba(120,255,225,0.42)'], [0.4, 'rgba(70,225,195,0.14)'], [1, 'rgba(60,210,180,0)']]),
    };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    ctx.drawImage(s.far, 0, 0);
    ctx.globalAlpha = 0.2 + 0.05 * wave(t, 13);
    ctx.drawImage(s.rays, 0, 0);
    ctx.globalAlpha = 0.24;
    slide(ctx, s.mist, along(t, 1.1, 960), 158);
    ctx.globalAlpha = 1;
    ctx.drawImage(s.mid, 0, 0);
    ctx.globalAlpha = 0.14;
    slide(ctx, s.mist, -along(t, 1.7, 960), 200);
    ctx.globalAlpha = 1;
    const place = (f) => [Math.round(f.x + Math.sin(t / f.p1 * TAU + f.phase * 9) * f.ax), Math.round(f.y + Math.cos(t / f.p2 * TAU + f.phase * 9) * f.ay), Math.max(0, wave(t, f.p3, f.phase))];
    ctx.globalCompositeOperation = 'lighter';
    for (const f of s.flies) {
      const [x, y, glow] = place(f);
      if (glow < 0.04) continue;
      ctx.globalAlpha = glow;
      ctx.drawImage(s.light, x - 7, y - 7);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fffde0';
    for (const f of s.flies) {
      const [x, y, glow] = place(f);
      if (glow < 0.04) continue;
      ctx.globalAlpha = glow;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(s.near, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const m of s.shrooms) {
      ctx.globalAlpha = (0.62 + 0.3 * wave(t, m.period, m.phase)) * (m.r / 4);
      ctx.drawImage(s.spore, m.x - 15, m.y - 15);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (const b of s.blades) {
      const lean = wave(t, 4.5, b.phase + b.x / 90) * 1.6;
      ctx.fillStyle = b.tone;
      for (let i = 0; i < b.h; i += 1) ctx.fillRect(Math.round(b.x + lean * (i / b.h) ** 2), b.y - i, 1, 1);
    }
    // The nearest few, close enough to the eye to be out of focus.
    ctx.globalCompositeOperation = 'lighter';
    for (const f of s.close) {
      const [x, y, glow] = place(f);
      if (glow < 0.04) continue;
      ctx.globalAlpha = glow * 0.9;
      ctx.drawImage(s.soft, x - 14, y - 14);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  },
};

export default fireflyGrove;
