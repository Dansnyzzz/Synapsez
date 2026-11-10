import { W, H, clamp, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm1, fbm2, puffs, cumulus, slide, starField, drawStars, ridge, fir } from './art.js';

/** How much of the foot of the picture is water. */
const LAKE = 34;
const SHORE = H - LAKE;
const LAND_Y = H - 96 - LAKE + 6;

/**
 * Indigo night: a crescent with a ring round it, the Milky Way, stars that breathe,
 * cloud sliding under the moon, a village asleep beside a still lake that carries the
 * moon and the lit windows.
 */
const moonNight = {
  build() {
    const rand = seeded(2201);
    const [mx, my] = [356, 62];
    const milky = noise2(2203, 64);
    /** How far from the band of the Milky Way, which leans up across the sky. */
    const offBand = (x, y) => Math.abs(y - (146 - x * 0.4));
    const SKY = ramp('#090e2a', '#0c1333', '#10193e', '#141f4a', '#1a2858', '#213167', '#2a3c78', '#354989', '#42589a', '#5369aa');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot(x - mx, (y - my) * 1.1);
      const band = Math.exp(-((offBand(x, y) / 40) ** 2)) * fbm2(milky, x / 34, y / 20, 3);
      return clamp(0.03 + (y / H) * 0.42 + band * 0.42 + 0.58 * Math.exp(-((d / 96) ** 2)) + 0.16 * Math.exp(-((d / 210) ** 2)) + 0.07 * Math.exp(-(((d - 47) / 4) ** 2)));
    }, 0.95);
    // The band is thick with stars too faint to breathe.
    const DUST = ramp('#7686c6', '#a7b5e6', '#dbe3ff');
    for (let i = 0; i < 2600; i += 1) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * 190);
      if (rand() < Math.exp(-((offBand(x, y) / 30) ** 2)) * 0.7) sky.put(x, y, DUST[Math.floor(rand() * rand() * 3)]);
    }

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
    const smoke = [];
    for (const hx of [68, 96, 118, 212, 238, 372, 402, 430]) {
      const top = Math.round(front(hx)) - 5;
      land.rect(hx - 6, top, 13, 10, rgba('#0d1330'));
      for (let k = 0; k < 7; k += 1) land.rect(hx - 7 + k, top - k + 1, 15 - k * 2, 1, rgba('#070b22'));
      land.rect(hx + 3, top - 7, 2, 4, rgba('#070b22'));
      windows.push({ x: hx - 3, y: top + 3 + LAND_Y, period: 7 + rand() * 13, phase: rand() });
      if (rand() > 0.3) windows.push({ x: hx + 2, y: top + 3 + LAND_Y, period: 9 + rand() * 17, phase: rand() });
      if (hx === 96 || hx === 238 || hx === 402) smoke.push({ x: hx + 4, y: top - 8 + LAND_Y, phase: rand() * 9 });
    }

    // The lake: the sky's colours, darker, in long flat strokes.
    const WATER = ramp('#060a22', '#0a1030', '#0f173f', '#141f4e', '#1b2a62', '#253876', '#334a8c');
    const water = new Art(W, LAKE);
    const ripple = noise2(2204, 64);
    water.shade(WATER, (x, y) => {
      const d = Math.abs(x - mx) / 240;
      return clamp(0.8 - (y / LAKE) * 0.42 - d * 0.3 + (fbm2(ripple, x / 46, y * 1.1, 2) - 0.5) * 0.34);
    }, 0.7);
    // Under the near shore, the hills lie in the water.
    for (let x = 0; x < W; x += 1) {
      const deep = 3 + Math.round(fbm1(hillNoise, x / 26, 2) * 5);
      for (let y = 0; y < deep; y += 1) if (bayer(x, y) < 1 - y / deep * 0.7) water.put(x, y, rgba('#060a24'));
    }
    const reeds = [];
    for (let i = 0; i < 46; i += 1) {
      const left = i % 3 !== 0;
      const x = left ? Math.floor(rand() * rand() * 96) : W - 1 - Math.floor(rand() * rand() * 70);
      reeds.push({ x, n: 8 + Math.floor(rand() * 18), phase: rand(), head: rand() < 0.3 });
    }
    return { sky: sky.canvas(), moon: moon.canvas(), far: far.canvas(), near: near.canvas(), land: land.canvas(), water: water.canvas(), stars: starField(rand, 170, 170), windows, smoke, reeds };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    drawStars(ctx, s.stars, t);
    ctx.drawImage(s.moon, 324, 30);
    slide(ctx, s.far, along(t, 0.9, 960), 48);
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
    slide(ctx, s.near, along(t, 1.8, 1200), 72);
    ctx.drawImage(s.land, 0, LAND_Y);
    for (const c of s.smoke) {
      ctx.fillStyle = '#8c9bcf';
      for (let k = 0; k < 13; k += 1) {
        const rise = ((t * 1.1 + c.phase + k * 2.1) % 27);
        ctx.globalAlpha = 0.3 * (1 - rise / 27);
        ctx.fillRect(Math.round(c.x + Math.sin(rise / 4 + c.phase) * rise * 0.28 + rise * 0.18), Math.round(c.y - rise), rise > 14 ? 2 : 1, 1);
      }
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(s.water, 0, SHORE);
    // The moon on the water: strokes that widen towards the eye and never quite hold still.
    for (let i = 0; i < LAKE; i += 1) {
      const y = SHORE + i;
      const shiver = wave(t, 3.1, i * 0.17);
      const half = (3 + i * 0.42) * (0.55 + 0.45 * shiver);
      if (half < 0.9) continue;
      const off = Math.sin(t / 2.7 + i * 0.8) * (1 + i * 0.09);
      ctx.fillStyle = i < 14 ? '#fff6d2' : '#f4e3a6';
      ctx.globalAlpha = 0.95 - (i / LAKE) * 0.45;
      ctx.fillRect(Math.round(346 - half + off), y, Math.round(half * 2), 1);
    }
    ctx.globalAlpha = 1;
    for (const w of s.windows) {
      const on = wave(t, w.period, w.phase) > -0.45;
      ctx.fillStyle = on ? (wave(t, 2.3, w.phase) > 0.9 ? '#ffe9a8' : '#ffc968') : '#141a38';
      ctx.fillRect(w.x, w.y, 2, 2);
      if (!on) continue;
      // And each lit window, thinner, a little lower down.
      const y = Math.min(H - 2, SHORE + Math.round((SHORE - w.y) * 0.55));
      ctx.globalAlpha = 0.5;
      ctx.fillRect(w.x + Math.round(Math.sin(t / 1.9 + w.phase * 9)), y, 2, 1);
      ctx.fillRect(w.x + Math.round(Math.sin(t / 2.3 + w.phase * 7)), y + 2, 2, 1);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#04071a';
    for (const r of s.reeds) {
      const lean = wave(t, 5.5, r.phase + r.x / 70) * 1.5;
      for (let i = 0; i < r.n; i += 1) ctx.fillRect(Math.round(r.x + lean * (i / r.n) ** 2), H - 1 - i, 1, 1);
      if (r.head) ctx.fillRect(Math.round(r.x + lean) - 1, H - r.n - 3, 2, 4);
    }
  },
};

export default moonNight;
