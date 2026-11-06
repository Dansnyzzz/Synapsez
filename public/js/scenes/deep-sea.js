import { W, H, TAU, clamp, wave, along, seeded, rgba, ramp, bayer, Art, noise1, fbm1, slide, ridge } from './art.js';

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

export default deepSea;
