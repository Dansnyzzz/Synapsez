import { W, H, TAU, clamp, smooth, wave, along, seeded, rgba, ramp, bayer, newCanvas, Art, noise1, noise2, fbm1, fbm2, slide, ridge } from './art.js';

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

/** One jellyfish: a bell that pulses, frilled arms and fading threads, drawn in place each frame. */
function drawJelly(ctx, j, t, halos) {
  const pulse = (Math.sin((t / j.period) * TAU + j.phase * 9) + 1) / 2;
  const R = j.r;
  const span = R * (0.88 + pulse * 0.26);
  const tall = R * (0.92 - pulse * 0.2);
  const x = Math.round(j.x);
  const y = Math.round(j.y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.5 + pulse * 0.3;
  const size = Math.round(R * 6.4);
  ctx.drawImage(halos[j.hue], x - size / 2, y - Math.round(tall * 0.5) - size / 2, size, size);
  ctx.globalCompositeOperation = 'source-over';
  // Threads, thinning out to nothing.
  for (let i = 0; i < j.threads; i += 1) {
    const u = (i + 0.5) / j.threads * 2 - 1;
    const long = j.r * (2.3 + (i % 3) * 0.7);
    ctx.fillStyle = i % 2 ? j.pale : j.mid;
    for (let k = 0; k < long; k += 2) {
      const sway = Math.sin(k / 6 + (t / j.period) * TAU * 0.6 + i) * (k / long) * (R * 0.42);
      ctx.globalAlpha = 0.9 * (1 - k / long);
      ctx.fillRect(Math.round(x + u * span * 0.86 + sway), y + 1 + k, 1, 2);
    }
  }
  // The arms: heavier ribbons in the middle of the bell, in a slower swing.
  const arms = Math.max(2, Math.round(R / 5));
  ctx.fillStyle = j.pale;
  for (let i = 0; i < arms; i += 1) {
    const u = arms > 1 ? (i / (arms - 1) - 0.5) * 0.7 : 0;
    const long = R * 1.5;
    for (let k = 0; k < long; k += 1) {
      const sway = Math.sin(k / 4 + (t / j.period) * TAU * 0.4 + i * 2) * (k / long) * (R * 0.26);
      const frill = R > 11 && k % 3 === 0 ? 2 : 1;
      ctx.globalAlpha = 0.72 * (1 - (k / long) ** 2);
      ctx.fillRect(Math.round(x + u * span + sway), y + k, frill + (R > 16 ? 1 : 0), 1);
    }
  }
  // The bell, seen through: a skin of colour, paler to the left and at the crown.
  ctx.globalAlpha = 0.92;
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
  ctx.globalAlpha = 1;
  // Its rim, and the lights in it that run round as it beats.
  ctx.fillStyle = j.dark;
  ctx.fillRect(x - Math.round(span) + 1, y, Math.round(span) * 2 - 1, 1);
  ctx.fillStyle = j.heart;
  const beads = Math.max(5, Math.round(R * 0.8));
  for (let i = 0; i < beads; i += 1) {
    if ((i + Math.floor(t * 3 + j.phase * 9)) % 3 === 0) continue;
    ctx.fillRect(Math.round(x + ((i + 0.5) / beads * 2 - 1) * (span - 1)), y, 1, 1);
  }
  for (const dx of [-0.42, 0, 0.42]) ctx.fillRect(Math.round(x + span * dx) - 1, y - Math.round(tall * 0.44), 3, 2);
}

/**
 * The deep: light from far above, a whale going by a long way off, jellyfish in four
 * sizes, a shoal, drifting specks, kelp, and coral lit from inside on the sea bed.
 */
const deepSea = {
  build() {
    const rand = seeded(5501);
    const SEA = ramp('#01040f', '#020818', '#030d22', '#04132e', '#061b3b', '#08244a', '#0b305b', '#0f3f6f', '#165085', '#1f659c', '#2f7fb5');
    const water = new Art();
    water.shade(SEA, (x, y) => clamp(1 - (y / H) * 1.04 + Math.sin(x / 90) * 0.03), 1);
    // Shafts of light: long leaning bands, faint and dithered.
    const shaft = new Art(960, H);
    const SHAFT = rgba('#8fd0ee');
    for (let i = 0; i < 14; i += 1) {
      const start = rand() * 960;
      const width = 8 + rand() * 30;
      for (let y = 0; y < H; y += 1) {
        const fade = (1 - y / H) ** 1.4;
        const lean = y * 0.46;
        for (let k = 0; k < width + y * 0.09; k += 1) {
          const edge = Math.min(k, width - k) / width;
          if (fade * clamp(edge * 2.4 + 0.3) * 0.95 > bayer(Math.floor(start + k + lean), y)) shaft.wrap(start + k + lean, y, SHAFT);
        }
      }
    }
    // The surface, far up: a net of light that shifts on itself.
    const net = noise2(5506, 64);
    const caustic = new Art(480, 36);
    const CAUSTIC = rgba('#b8ecff');
    for (let y = 0; y < 36; y += 1) {
      for (let x = 0; x < 480; x += 1) {
        const a = 1 - Math.abs(fbm2(net, (x / 480) * 22, (y / 36) * 3.4 + 2, 2) * 2 - 1);
        if ((a - 0.8) * 8 * (1 - y / 36) ** 1.5 > bayer(x, y)) caustic.put(x, y, CAUSTIC);
      }
    }

    // A whale, a long way off and nearly the colour of the water.
    const WHALE = ramp('#041730', '#062039', '#092c49', '#0e3b5c', '#144c70');
    const whale = new Art(200, 70);
    const backOf = (u) => 32 - Math.sin(Math.PI * u ** 0.72) * 20;
    const bellyOf = (u) => 34 + Math.sin(Math.PI * u ** 0.58) * 17;
    for (let x = 0; x < 164; x += 1) {
      const u = x / 164;
      const top = backOf(u);
      const low = bellyOf(u);
      for (let y = Math.round(top); y <= low; y += 1) {
        const k = (y - top) / Math.max(1, low - top);
        const pleat = k > 0.56 && u > 0.5 && y % 3 === 0 ? -0.2 : 0;
        whale.tone(x + 32, y, WHALE, clamp(0.78 - k * 0.72 + pleat), 0.8);
      }
    }
    // Fin and flukes.
    whale.poly([[118, 44], [98, 66], [90, 66], [104, 44]], WHALE[1]);
    whale.poly([[38, 33], [8, 18], [0, 22], [14, 33], [2, 46], [10, 49]], WHALE[1]);
    whale.rect(182, 30, 1, 1, rgba('#3f7fa0'));

    const heightOf = noise1(5502, 128);
    const SHELF = ramp('#041024', '#051730', '#071e3c', '#0a2848');
    const shelf = new Art(W, 90);
    ridge(shelf, (x) => 36 + fbm1(heightOf, x / 50 + 30, 3) * 44, SHELF, { light: 0.8, depth: 60 });
    const FLOOR = ramp('#01040c', '#020713', '#040b1c', '#061227');
    const floor = new Art(W, 70);
    const bedOf = (x) => 28 + fbm1(heightOf, x / 38, 3) * 30;
    ridge(floor, bedOf, FLOOR, { light: 0.7, depth: 40 });
    // Coral: branching fans whose tips hold a light of their own.
    const CORALS = [ramp('#1a0d2e', '#3d1650', '#7a2577', '#d14f98'), ramp('#06242c', '#0b4450', '#14808c', '#42d6cf'), ramp('#2a1208', '#5a2410', '#a9481c', '#f09a4a')];
    const tips = [];
    const branch = (x, y, angle, long, depth, tones) => {
      const steps = Math.round(long);
      let [px, py] = [x, y];
      for (let k = 0; k < steps; k += 1) {
        px += Math.cos(angle);
        py += Math.sin(angle);
        const tone = tones[Math.min(3, 3 - depth + (k > steps / 2 ? 1 : 0))] || tones[0];
        floor.put(Math.round(px), Math.round(py), tone);
        if (depth > 2) floor.put(Math.round(px) + 1, Math.round(py), tone);
      }
      if (depth <= 0) {
        tips.push({ x: Math.round(px), y: Math.round(py) + (H - 70), hue: tones === CORALS[0] ? 1 : tones === CORALS[1] ? 2 : 3, period: 3 + rand() * 4, phase: rand() });
        return;
      }
      for (const turn of [-0.42 - rand() * 0.3, 0.42 + rand() * 0.3]) branch(px, py, angle + turn, long * (0.66 + rand() * 0.14), depth - 1, tones);
    };
    for (const [cx, i, long] of [[36, 0, 11], [70, 1, 8], [156, 2, 9], [214, 0, 7], [292, 1, 10], [352, 2, 8], [416, 0, 12], [454, 1, 9]]) {
      branch(cx, Math.round(bedOf(cx)) + 3, -Math.PI / 2 + (rand() - 0.5) * 0.3, long, 3, CORALS[i]);
    }
    const kelp = [];
    for (let i = 0; i < 22; i += 1) {
      const x = Math.floor(rand() * W);
      kelp.push({ x, y: H - 70 + Math.round(bedOf(x)), n: 26 + Math.floor(rand() * 58), phase: rand(), tone: rand() < 0.5 ? '#07271f' : '#0a3226', lit: rand() < 0.5 ? '#0f4634' : '#135240' });
    }
    const PAL = [
      { hue: 0, dark: '#612f8f', mid: '#a35fd0', pale: '#e8c6ff', heart: '#ffd9fb' },
      { hue: 1, dark: '#8f3366', mid: '#d6709d', pale: '#ffd1df', heart: '#fff0f4' },
      { hue: 2, dark: '#1f6d8a', mid: '#4fb3c8', pale: '#c5f3f6', heart: '#efffff' },
    ];
    const jellies = [];
    for (const [x, y, r, sp, hue] of [[92, 72, 9, 3.2, 0], [188, 150, 15, 4.4, 1], [326, 62, 10, 3.6, 2], [402, 170, 24, 5.8, 2], [264, 208, 7, 2.8, 1], [58, 196, 13, 4, 0], [142, 40, 5, 2.4, 2], [448, 60, 6, 2.6, 1]]) {
      jellies.push({ x0: x, y0: y, x, y, r, period: sp, phase: rand(), threads: Math.max(5, Math.round(r * 0.8)), drift: 40 + rand() * 40, ...PAL[hue] });
    }
    const shoal = [];
    for (let i = 0; i < 54; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand());
      shoal.push({ ox: Math.cos(a) * d * 46, oy: Math.sin(a) * d * 15, phase: rand(), bright: rand() < 0.25 });
    }
    const specks = [];
    for (let i = 0; i < 110; i += 1) specks.push({ x: rand() * W, y: rand() * H, v: 1 + rand() * 3, phase: rand(), size: rand() < 0.1 ? 2 : 1 });
    const bubbles = [];
    for (const vent of [132, 318, 452]) for (let i = 0; i < 7; i += 1) bubbles.push({ x: vent, phase: i / 7, r: 1 + (i % 3 === 0 ? 1 : 0), speed: 16 + rand() * 12 });
    const glowOf = (c) => halo(96, [[0, `rgba(${c},0.34)`], [0.34, `rgba(${c},0.14)`], [1, `rgba(${c},0)`]]);
    return {
      water: water.canvas(), shaft: shaft.canvas(), caustic: caustic.canvas(), whale: whale.canvas(), shelf: shelf.canvas(), floor: floor.canvas(), kelp, jellies, specks, bubbles, shoal, tips,
      halos: [glowOf('170,110,240'), glowOf('240,120,170'), glowOf('90,210,230')],
      tipGlow: [null, halo(13, [[0, 'rgba(255,120,190,0.7)'], [1, 'rgba(255,100,180,0)']]), halo(13, [[0, 'rgba(90,255,235,0.7)'], [1, 'rgba(70,230,220,0)']]), halo(13, [[0, 'rgba(255,180,90,0.7)'], [1, 'rgba(250,150,70,0)']])],
    };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.water, 0, 0);
    ctx.globalAlpha = 0.2 + 0.05 * wave(t, 9);
    slide(ctx, s.shaft, along(t, 1.4, 960));
    ctx.globalAlpha = 0.5 + 0.12 * wave(t, 5);
    slide(ctx, s.caustic, along(t, 3, 480));
    ctx.globalAlpha = 0.28;
    slide(ctx, s.caustic, -along(t, 2, 480));
    ctx.globalAlpha = 1;
    // The whale, on a long round: its tail bends, and the rest of it hardly moves.
    const wx = ((t * 5 + 300) % 900) - 200;
    const wy = 74 + Math.sin(t / 13) * 5;
    if (wx < W && wx > -200) {
      for (let col = 0; col < 200; col += 2) {
        const bend = col < 70 ? Math.sin(t / 3.4 + col / 30) * ((70 - col) / 70) ** 2 * 7 : 0;
        ctx.drawImage(s.whale, col, 0, 2, 70, Math.round(wx + col), Math.round(wy + bend), 2, 70);
      }
    }
    ctx.drawImage(s.shelf, 0, H - 90);
    for (const p of s.specks) {
      const x = (p.x + Math.sin(t / 9 + p.phase * 9) * 6 + W) % W;
      const y = (p.y - t * p.v + H * 100) % H;
      ctx.fillStyle = y < H / 2 ? 'rgba(170,220,240,0.5)' : 'rgba(120,180,210,0.34)';
      ctx.fillRect(Math.round(x), Math.round(y), p.size, p.size);
    }
    // A shoal, passing in a loose cloud, each one turning in its own time.
    const sx = ((t * 8 + 120) % 760) - 140;
    const sy = 190 + Math.sin(t / 11) * 22;
    for (const f of s.shoal) {
      const x = Math.round(sx + f.ox + Math.sin(t / 2.3 + f.phase * 9) * 3);
      const y = Math.round(sy + f.oy + Math.cos(t / 3.1 + f.phase * 9) * 2);
      ctx.fillStyle = f.bright ? '#a9dcec' : '#5f9fb8';
      ctx.fillRect(x, y, 3, 1);
      ctx.fillRect(x - 1, y - (Math.floor(t * 4 + f.phase * 9) % 2), 1, 1);
    }
    // Smallest first, so the near ones swim in front.
    for (const j of [...s.jellies].sort((a, b) => a.r - b.r)) {
      const rise = (t * (0.45 + 6 / j.r) + j.phase * 300) % (H + j.r * 6);
      j.x = j.x0 + Math.sin(t / j.drift * TAU + j.phase * 9) * 18;
      j.y = H + j.r * 2 - rise;
      drawJelly(ctx, j, t, s.halos);
    }
    ctx.fillStyle = 'rgba(180,235,250,0.6)';
    for (const b of s.bubbles) {
      const y = H - 40 - (((t * b.speed) / H + b.phase) % 1) * (H - 30);
      const x = Math.round(b.x + Math.sin(y / 11 + b.phase * 9) * 3);
      ctx.fillRect(x, Math.round(y), b.r, b.r);
    }
    ctx.drawImage(s.floor, 0, H - 70);
    for (const k of s.kelp) {
      for (let i = 0; i < k.n; i += 1) {
        const x = Math.round(k.x + wave(t, 6.5, k.phase + i / 40) * (i / k.n) * 8);
        ctx.fillStyle = i > k.n * 0.55 ? k.lit : k.tone;
        ctx.fillRect(x, k.y - i, 2, 1);
        if (i % 7 === 3) ctx.fillRect(x + (i % 14 === 3 ? 2 : -2), k.y - i, 2, 1);
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of s.tips) {
      ctx.globalAlpha = smooth(clamp(0.55 + 0.45 * wave(t, p.period, p.phase)));
      ctx.drawImage(s.tipGlow[p.hue], p.x - 6, p.y - 6);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  },
};

export default deepSea;
