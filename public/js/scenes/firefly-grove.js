import { W, H, TAU, clamp, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm1, fbm2, puffs, slide, fir } from './art.js';

/** A forest at night: three depths of trees, low mist, grass that moves, fireflies. */
const fireflyGrove = {
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

export default fireflyGrove;
