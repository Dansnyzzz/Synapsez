import { W, H, clamp, wave, seeded, ramp, Art, noise1, noise2, fbm1, fbm2, ridged, starField, drawStars, ridge, fir } from './art.js';

/** Curtains of light over snow: one of the few things in the sky that moves by itself. */
const auroraPeak = {
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

export default auroraPeak;
