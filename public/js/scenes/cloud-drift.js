import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, noise2, fbm2, puffs, cumulus, slide } from './art.js';

/** Pale sky, drifting clouds. */
const cloudDrift = {
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

export default cloudDrift;
