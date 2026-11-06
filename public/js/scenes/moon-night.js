import { W, H, clamp, wave, along, seeded, rgba, ramp, Art, noise1, fbm1, puffs, cumulus, slide, starField, drawStars, ridge, fir } from './art.js';

/** Indigo night: a crescent, stars that breathe, cloud sliding under the moon, a village asleep. */
const moonNight = {
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

export default moonNight;
