import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm2, ridged, slide, starField, drawStars, sprite } from './art.js';

/*
 * Blue dusk, the sun just gone behind the hills on the left, so everything that faces
 * left still holds a little of the afterglow and everything that faces right is blue.
 * The only warm light after that is what people have lit themselves.
 */

/** Snow, shadow to lit. The warm ramp has the same steps, for where a lamp reaches. */
const SNOW = ramp('#252d5c', '#2d3a6e', '#374880', '#445a92', '#5670a6', '#6e88ba', '#8ca3cc', '#adbfdd', '#cfdbed', '#eef4fb');
const SNOW_WARM = ramp('#3a3365', '#4b3e70', '#62507c', '#7c6384', '#987a8c', '#b39392', '#ccaea0', '#e2c8b4', '#f3e0cc', '#fff3e2');
const GLASS = ramp('#c8622f', '#e48a3f', '#f4ad52', '#fbcf74', '#ffe9a6');
const FRAME = rgba('#211829');

/** Two colours on a canvas, `k` of the way from the first to the second. */
const tint = (c, w, k) => (0xff000000 | (mix((c >> 16) & 255, (w >> 16) & 255, k) << 16) | (mix((c >> 8) & 255, (w >> 8) & 255, k) << 8) | mix(c & 255, w & 255, k)) >>> 0;

/** Lamplight falling on whatever has already been painted here, in a pattern and not a blend. */
function warmHalo(art, cx, cy, r, strength, hex = '#ffb060') {
  const warm = rgba(hex);
  for (let y = Math.floor(cy - r); y <= cy + r; y += 1) {
    for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
      const c = art.get(x, y);
      if (!c) continue;
      const k = strength * (1 - Math.hypot(x - cx, y - cy) / r);
      if (k <= 0) continue;
      const step = Math.floor(k * 5 + bayer(x, y) * 0.9) / 5;
      if (step > 0) art.put(x, y, tint(c, warm, step * 0.62));
    }
  }
}

/** A round glow as a sprite, thinning out in the ordered pattern. */
function glowSprite(rx, ry, hex, strength = 1) {
  const art = new Art(rx * 2 + 1, ry * 2 + 1);
  const c = rgba(hex) & 0xffffff;
  for (let y = 0; y <= ry * 2; y += 1) {
    for (let x = 0; x <= rx * 2; x += 1) {
      const d = Math.hypot((x - rx) / rx, (y - ry) / ry);
      if (d >= 1) continue;
      const level = Math.floor(strength * (1 - d) ** 1.7 * 7 + bayer(x, y) * 0.9) / 7;
      if (level > 0) art.px[y * art.w + x] = ((Math.round(level * 255) << 24) | c) >>> 0;
    }
  }
  return art.canvas();
}

/** A puff of smoke: lit from the left, thin at the edge. */
function puffSprite(r) {
  const size = Math.ceil(r) * 2 + 1;
  const art = new Art(size, size);
  const c0 = rgba('#e2e4ee') & 0xffffff;
  const c1 = rgba('#a9b0cc') & 0xffffff;
  const mid = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - mid, y - mid) / (r + 0.5);
      if (d >= 1) continue;
      const level = Math.floor((1 - d) ** 0.8 * 4 + bayer(x, y) * 0.9) / 4;
      if (level > 0) art.px[y * size + x] = ((Math.round(level * 215) << 24) | (x - mid + (y - mid) < 0 ? c0 : c1)) >>> 0;
    }
  }
  return art.canvas();
}

/** A fir under snow: skirts stacked from the bottom up, each a white tent over a dark hem. */
function snowFir(art, cx, base, tall, green, snow, rand) {
  const tiers = Math.max(3, Math.round(tall / 7.5));
  const half = tall * 0.3;
  const stem = Math.max(1, Math.round(tall * 0.035));
  art.rect(cx - stem, base - tall * 0.12, stem * 2, tall * 0.12 + 2, rgba('#1a1529'));
  for (let i = tiers - 1; i >= 0; i -= 1) {
    const k = (i + 1) / tiers;
    const top = base - tall + tall * 0.88 * (i / tiers) - (i ? tall / tiers * 0.5 : 0);
    const bot = base - tall * 0.08 - tall * 0.9 * (1 - k);
    const w = Math.max(1.5, half * (0.1 + 0.9 * k));
    const phase = rand() * TAU;
    const lift = bot - top;
    for (let dx = -Math.ceil(w); dx <= w; dx += 1) {
      const a = Math.min(1, Math.abs(dx) / w);
      const roof = top + lift * 0.86 * a ** 1.2 + Math.sin(dx * 1.7 + phase) * 0.4;
      const hem = bot - lift * 0.2 * (1 - a * a) + Math.sin(dx * 0.85 + phase) * Math.min(1.8, lift * 0.14);
      const cap = 1 + lift * (0.26 + rand() * 0.28);
      for (let y = Math.floor(roof); y <= hem; y += 1) {
        const d = y - roof;
        if (d < cap) art.tone(cx + dx, y, snow, 0.66 + (dx < 0 ? 0.24 : -0.2) * a + (1 - d / cap) * 0.16, 0.5);
        else art.tone(cx + dx, y, green, 0.16 + 0.5 * ((y - roof) / Math.max(1, hem - roof)) + (dx < 0 ? 0.12 : -0.08) * a, 0.7);
      }
    }
  }
}

/** A lit window: its frame, its panes, a sill with snow along it, and a little of its light on the wall. */
function windowAt(art, world, x, y, w, h, { arch = false, shutters = null, live = false, panes = true } = {}) {
  warmHalo(art, x + w / 2, y + h / 2, Math.max(w, h) * 1.05, 0.5);
  art.rect(x - 1, y - 1, w + 2, h + 2, FRAME);
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (arch && j < 2 && (i < 2 - j || i > w - 3 + j)) {
        art.put(x + i, y + j, FRAME);
        continue;
      }
      const v = 0.95 - (Math.abs(i - (w - 1) / 2) / w) * 0.75 - (1 - j / h) * 0.32;
      art.tone(x + i, y + j, GLASS, v, 0.8);
    }
  }
  if (panes) {
    if (w >= 5) art.rect(x + Math.floor(w / 2), y, 1, h, FRAME);
    if (h >= 6) art.rect(x, y + Math.floor(h / 2), w, 1, FRAME);
  }
  if (shutters) {
    const sw = Math.max(2, Math.round(h / 3.4));
    for (const sx of [x - 1 - sw, x + w + 1]) {
      art.rect(sx, y - 1, sw, h + 2, shutters[0]);
      for (let j = 1; j < h + 2; j += 2) art.rect(sx, y - 1 + j, sw, 1, shutters[1]);
      art.rect(sx, y - 2, sw, 1, SNOW[8]);
    }
  }
  art.rect(x - 2, y + h + 1, w + 4, 1, SNOW_WARM[6]);
  art.rect(x - 2, y + h, w + 4, 1, SNOW_WARM[9]);
  if (live) (art === world.frontArt ? world.windows : world.backWindows).push({ x, y, w, h, period: 9 + world.rand() * 13, phase: world.rand(), off: 40 + world.rand() * 70, offPhase: world.rand() });
}

/** A door, planks and a step, with a wreath on it if `wreath`. */
function doorAt(art, x, base, w, h, hex, { wreath = false, lamp = false } = {}) {
  const c = rgba(hex);
  art.rect(x - 1, base - h - 1, w + 2, h + 1, FRAME);
  art.rect(x, base - h, w, h, c);
  for (let i = 2; i < w; i += 3) art.rect(x + i, base - h, 1, h, tint(c, FRAME, 0.5));
  art.rect(x + w - 2, base - h * 0.48, 1, 1, rgba('#ffd98a'));
  art.rect(x - 2, base - 1, w + 4, 2, SNOW[8]);
  art.rect(x - 2, base + 1, w + 4, 1, SNOW[5]);
  if (wreath) {
    const cx = x + (w - 1) / 2;
    const cy = base - h * 0.68;
    for (let a = 0; a < TAU; a += 0.4) art.rect(Math.round(cx + Math.cos(a) * 2.4), Math.round(cy + Math.sin(a) * 2.4), 1, 1, a % 0.8 < 0.4 ? rgba('#2f8a5a') : rgba('#1f6a4c'));
    art.put(Math.round(cx), Math.round(cy + 2.4), rgba('#e24a4a'));
    art.put(Math.round(cx) - 1, Math.round(cy - 1), rgba('#ff5e5e'));
    art.put(Math.round(cx) + 2, Math.round(cy + 1), rgba('#ff5e5e'));
  }
  if (lamp) {
    art.rect(x + Math.floor(w / 2), base - h - 4, 1, 2, FRAME);
    art.rect(x + Math.floor(w / 2) - 1, base - h - 3, 3, 2, rgba('#ffe29a'));
  }
}

/**
 * A house seen a little from one side: a gable end facing left or right, its long wall
 * facing us, and the long roof running back from the gable, thick with snow.
 *
 * @returns the corners of it, for windows and doors
 */
function house(art, o, rand, drift) {
  const { x, base, gable, side, wall, roof, paint, flip = false, timber = false, tile = '#553243' } = o;
  const gx0 = flip ? x + side : x;
  const gx1 = gx0 + gable;
  const sx0 = flip ? x : x + gable;
  const sx1 = sx0 + side;
  const eave = base - wall;
  const apexX = gx0 + gable / 2;
  const apexY = eave - roof;
  const thick = Math.max(2, Math.round(roof / 8));

  // The long wall, darker under the eave where the roof shades it.
  for (let y = eave; y < base; y += 1) {
    for (let px = sx0; px < sx1; px += 1) {
      const under = clamp((y - eave) / (3 + wall * 0.14));
      art.tone(px, y, paint, 0.14 + under * 0.36 + (fbm2(drift, px / 5, y / 5, 2) - 0.5) * 0.28, 0.7);
    }
  }

  // The long roof, snow from ridge to eave with the tiles showing here and there.
  const [ridgeL, ridgeR] = flip ? [apexX - side, apexX] : [apexX, apexX + side];
  const tiles = rgba(tile);
  for (let y = Math.floor(apexY); y <= eave; y += 1) {
    const k = (y - apexY) / roof;
    const l = Math.round(mix(ridgeL, sx0, k));
    const r = Math.round(mix(ridgeR, sx1, k));
    for (let px = l; px <= r; px += 1) {
      const n = fbm2(drift, px / 16, y / 4.5, 3);
      if (n < 0.27 && k > 0.3 && (y & 1) === 0) art.put(px, y, tiles);
      else art.tone(px, y, SNOW, 0.95 - k * 0.3 + (n - 0.5) * 0.5, 0.7);
    }
  }
  for (let px = Math.round(ridgeL); px <= ridgeR; px += 1) {
    const bump = 1 + Math.round(fbm2(drift, px / 7, 3.3, 2) * 3);
    for (let j = 1; j <= bump; j += 1) art.tone(px, Math.floor(apexY) - j, SNOW, 0.98 - (j === 1 ? 0.1 : 0), 0.4);
  }
  // Snow hanging over the eave, and icicles under it.
  for (let px = sx0 - 1; px <= sx1 + 1; px += 1) {
    const drop = 1 + Math.round(fbm2(drift, px / 5, 8.7, 2) * 3.2);
    for (let j = 0; j <= drop; j += 1) art.tone(px, eave + j, SNOW, 0.66 - (j / drop) * 0.34, 0.5);
    if (rand() < 0.17) {
      const long = 1 + Math.floor(rand() * 4);
      for (let j = 1; j <= long; j += 1) art.put(px, eave + drop + j, j === long ? SNOW[6] : SNOW[8]);
    }
  }

  // The gable, and the snow along both slopes of it.
  const lit = flip ? 0.24 : 0.78;
  for (let y = Math.floor(apexY); y < base; y += 1) {
    const half = y < eave ? ((y - apexY) / roof) * (gable / 2) : gable / 2;
    for (let px = Math.round(apexX - half); px < apexX + half; px += 1) {
      art.tone(px, y, paint, lit - (y < eave ? 0 : 0.03) + (fbm2(drift, px / 5, y / 5, 2) - 0.5) * 0.28, 0.7);
    }
  }
  if (timber) {
    const beam = rgba('#2a1f2e');
    art.rect(gx0, eave, gable, 1, beam);
    for (let px = gx0; px <= gx1; px += Math.round(gable / 4)) {
      art.rect(Math.min(px, gx1 - 1), eave, 1, base - eave, beam);
      const top = apexY + (Math.abs(px - apexX) / (gable / 2)) * roof;
      art.rect(Math.min(px, gx1 - 1), top, 1, eave - top, beam);
    }
    art.rect(sx0, Math.round((eave + base) / 2) + 2, side, 1, beam);
    art.rect(sx0, base - 1, side, 1, beam);
    for (let px = sx0; px <= sx1; px += Math.round(side / 4)) art.rect(Math.min(px, sx1 - 1), eave, 1, base - eave, beam);
  }
  const board = rgba('#231a2b');
  for (let dx = -Math.ceil(gable / 2) - 2; dx <= gable / 2 + 2; dx += 1) {
    const a = Math.abs(dx) / (gable / 2);
    const line = Math.round(apexY + a * roof);
    art.rect(apexX + dx, line + 1, 1, 2, board);
    const cap = thick + 1 + (fbm2(drift, (apexX + dx) / 4, 5.1, 2) > 0.55 ? 1 : 0);
    for (let j = 0; j <= cap; j += 1) {
      art.tone(apexX + dx, line - j, SNOW, (dx < 0 ? 0.98 : 0.74) - (j === 0 ? 0.2 : 0) - (j === 1 ? 0.06 : 0), 0.4);
    }
  }
  return { gx0, gx1, sx0, sx1, eave, apexX, apexY, base, ridgeL, ridgeR };
}

/** A chimney standing on the roof, brick by brick, snow on its head. Its smoke is remembered. */
function chimneyAt(art, world, x, top, w, h, { list = 'smokeBack', rise = 74, wind = 26, alpha = 0.6, period = 8 } = {}) {
  const BRICK = ramp('#2e2036', '#472a3c', '#633543', '#7f4449');
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const mortar = j % 3 === 2 || (i + (Math.floor(j / 3) % 2) * 2) % 4 === 3;
      art.put(x + i, top + j, BRICK[mortar ? 0 : clamp(Math.round(2.6 - (i / w) * 2), 1, 3)]);
    }
  }
  art.rect(x - 1, top - 1, w + 2, 2, rgba('#3a2a3e'));
  art.rect(x - 1, top - 3, w + 2, 2, SNOW[9]);
  art.rect(x, top - 4, w, 1, SNOW[8]);
  art.rect(x - 2, top + h - 1, w + 4, 2, SNOW[8]);
  world[list].push({ x: x + w / 2, y: top - 2, n: Math.round(rise / 2.8), period: period * 1.5, phase: world.rand(), rise, wind, alpha });
}

/** A small dormer on the long roof, its own hat of snow and a light in it. */
function dormer(art, world, x, y, w) {
  const h = Math.round(w * 0.8);
  art.rect(x, y, w, h, rgba('#3a3c62'));
  windowAt(art, world, x + 1, y + 1, w - 2, h - 2, { live: true });
  for (let dx = -2; dx <= w + 1; dx += 1) {
    const a = Math.abs(dx - (w - 1) / 2) / (w / 2 + 2);
    const line = Math.round(y - 1 - (1 - a) * (w * 0.4));
    art.rect(x + dx, line + 1, 1, 1, FRAME);
    for (let j = 0; j < 3; j += 1) art.tone(x + dx, line - j, SNOW, dx < w / 2 ? 0.97 : 0.76, 0.4);
  }
}

/** A street lamp. The halo is put on at draw time, so it can breathe. */
function lampPost(art, world, x, base, tall) {
  const iron = rgba('#16111f');
  art.rect(x, base - tall, 2, tall, iron);
  art.rect(x - 1, base - 2, 4, 2, iron);
  art.rect(x - 1, base - tall * 0.56, 4, 1, iron);
  art.rect(x - 2, base - tall - 6, 6, 1, iron);
  art.rect(x - 2, base - tall - 5, 1, 5, iron);
  art.rect(x + 3, base - tall - 5, 1, 5, iron);
  art.rect(x - 1, base - tall - 5, 4, 5, rgba('#ffe7a8'));
  art.rect(x, base - tall - 3, 2, 2, rgba('#fff9df'));
  art.rect(x - 3, base - tall - 7, 8, 1, iron);
  art.rect(x - 2, base - tall - 9, 6, 2, SNOW[9]);
  art.rect(x - 3, base - tall - 8, 8, 1, SNOW[8]);
  world.lamps.push({ x: x + 1, y: base - tall - 3, phase: world.rand() });
  world.lights.push({ x: x + 1, y: base + 2, r: 22, s: 0.6 });
}

/** The tree in the square: fronds hung tier on tier, snow on their shoulders, then all that's been hung on it. */
function christmasTree(art, world, cx, base, top, rand) {
  const NEEDLE = ramp('#061723', '#09222d', '#0d3136', '#13423e', '#1a5647', '#256c50', '#38855d', '#5ca273');
  const tall = base - top;
  const halfMax = 49;
  const tiers = 14;
  const tips = [];
  for (let i = tiers - 1; i >= 0; i -= 1) {
    const k0 = i / tiers;
    const k1 = (i + 1) / tiers;
    const yT = top + (tall - 8) * k0 - (i ? 7 : 0);
    const yB = top + (tall - 8) * k1 + 1;
    const w = 2 + (halfMax - 2) * k1 ** 0.94;
    const count = Math.max(2, Math.round(w / 3.1));
    const us = [];
    for (let j = 0; j < count; j += 1) us.push((j / (count - 1)) * 2 - 1);
    us.sort((a, b) => Math.abs(b) - Math.abs(a));
    for (const u of us) {
      const jitter = (rand() - 0.5) * 2.4;
      const tipX = cx + u * w + jitter;
      const tipY = yB - Math.abs(u) ** 2 * 3 + rand() * 3;
      const fw = (w / count) * 1.5 + 1.5;
      const midY = mix(yT, tipY, 0.62);
      const ax = cx + u * w * 0.28;
      const seed = Math.floor(rand() * 7);
      art.poly([[ax, yT], [tipX + fw, midY], [tipX, tipY], [tipX - fw, midY]], (x, y) => {
        const d = clamp((y - yT) / (tipY - yT));
        const across = (x - tipX) / fw;
        const v = 0.04 + 0.66 * d ** 1.5 - ((x - cx) / halfMax) * 0.18 - across * 0.08 + ((x * 2 + y * 3 + seed) % 5 === 0 ? 0.12 : 0);
        art.tone(x, y, NEEDLE, v, 0.85);
      });
      tips.push({ x: tipX, y: tipY, u, w: 2 + Math.abs(u) * 3 });
    }
  }
  // Snow on the shoulders of the fronds.
  for (const tip of tips) {
    if (rand() > 0.62) continue;
    const blobs = 1 + Math.floor(rand() * 2.4);
    for (let b = 0; b < blobs; b += 1) {
      const rx = 1.4 + rand() * (1 + Math.abs(tip.u) * 2.4);
      const ry = 0.9 + rand() * 1;
      const px = tip.x + (rand() - 0.5) * 7 - tip.u * 2;
      const py = tip.y - 3 - rand() * 4;
      const fall = tip.u * 0.4;
      for (let y = Math.floor(py - ry - 2); y <= py + ry + 2; y += 1) {
        for (let x = Math.floor(px - rx); x <= px + rx; x += 1) {
          const ly = y - fall * (x - px);
          if (((x - px) / rx) ** 2 + ((ly - py) / ry) ** 2 > 1 || !art.get(x, y)) continue;
          art.tone(x, y, SNOW, 0.78 + ((py - ly) / ry) * 0.2 - ((x - cx) / halfMax) * 0.14, 0.5);
        }
      }
    }
  }
  // What's strung on it: tinsel in swags, and bulbs along the swags.
  const edge = (y) => 2 + (halfMax - 2) * clamp((y - top) / (tall - 8)) ** 0.94;
  const HUES = [['#ff4d4d', '#5e1e2e'], ['#ffc94a', '#5f4a1c'], ['#57f08a', '#1a6a44'], ['#59aaff', '#1f4470'], ['#ff7ad6', '#5e2354'], ['#fff3cf', '#5d553e']];
  const groups = HUES.map(([hex]) => ({ hex, list: [] }));
  const GOLD = [rgba('#ffe28a'), rgba('#d7a83e')];
  let row = 0;
  for (let y = top + 16; y < base - 16; y += 10 + row * 0.42) {
    const w = edge(y) * 0.98;
    const swags = Math.max(1, Math.round((w * 2) / 26));
    for (let sw = 0; sw < swags; sw += 1) {
      const xa = cx - w + (sw / swags) * w * 2;
      const xb = cx - w + ((sw + 1) / swags) * w * 2;
      const span = xb - xa;
      const sag = Math.min(6, span * 0.2);
      const at = (x) => y - (x - cx) * 0.05 + sag * (1 - ((x - (xa + xb) / 2) / (span / 2)) ** 2);
      for (let x = Math.ceil(xa); x < xb; x += 1) {
        const gy = Math.round(at(x));
        if (art.get(x, gy) && row % 2 === 0) art.put(x, gy + 2, GOLD[(x + row) % 3 === 0 ? 1 : 0]);
      }
      const gap = 4.2;
      for (let x = xa + gap / 2 + rand(); x < xb; x += gap) {
        const bx = Math.round(x);
        const by = Math.round(at(x));
        if (!art.get(bx, by)) continue;
        const hue = Math.floor(rand() * HUES.length);
        art.put(bx, by, rgba(HUES[hue][1]));
        groups[hue].list.push({ x: bx, y: by, period: 1.4 + rand() * 3.2, phase: rand() });
      }
    }
    row += 1;
  }
  // Baubles, each with the sky on its shoulder.
  const BAUBLES = [ramp('#6e1420', '#c92f3a', '#ff7a6e'), ramp('#6e4a12', '#d29a2a', '#ffe08a'), ramp('#1d3a78', '#3f7ad6', '#a4d0ff'), ramp('#50566e', '#a5adc4', '#f2f5fb')];
  for (let i = 0; i < 58; i += 1) {
    const k = 0.14 + 0.82 * Math.sqrt(rand());
    const y = top + (tall - 10) * k;
    const x = cx + (rand() * 2 - 1) * edge(y) * 0.84;
    if (!art.get(Math.round(x), Math.round(y))) continue;
    const pal = BAUBLES[Math.floor(rand() * BAUBLES.length)];
    const r = k > 0.5 && rand() < 0.5 ? 2 : 1;
    art.put(Math.round(x), Math.round(y) - r - 1, GOLD[1]);
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r * r + 0.5) art.put(Math.round(x) + dx, Math.round(y) + dy, pal[dx + dy > 0 ? 0 : 1]);
    art.put(Math.round(x) - (r > 1 ? 1 : 0), Math.round(y) - (r > 1 ? 1 : 0), pal[2]);
  }
  world.bulbs = groups;
}

/** A star cut in facets, a light face and a dark face on every point. */
function starSprite(R, r) {
  const size = R * 2 + 3;
  const art = new Art(size, size);
  const mid = (size - 1) / 2;
  const LIT = [rgba('#fffbd6'), rgba('#ffdf6e')];
  const DARK = [rgba('#ffc845'), rgba('#d58a22')];
  const corner = (i) => {
    const a = -Math.PI / 2 + (i * TAU) / 10;
    const rr = i % 2 ? r : R;
    return [mid + Math.cos(a) * rr, mid + Math.sin(a) * rr];
  };
  for (let i = 0; i < 10; i += 1) {
    const facing = i % 2 === 0 ? LIT : DARK;
    art.poly([[mid, mid], corner(i), corner(i + 1)], (x, y) => art.put(x, y, facing[i < 5 ? 1 : 0]));
  }
  art.put(Math.round(mid), Math.round(mid), LIT[0]);
  return art.canvas();
}

/** A little person, two steps of a walk, from rows of letters. Mirrored rows face the other way. */
const mirror = (rows) => rows.map((r) => [...r.padEnd(Math.max(...rows.map((q) => q.length)))].reverse().join(''));
const ADULT_A = ['  hh  ', ' hhhh ', '  ff  ', ' sscs ', ' cccc ', 'ccccc ', 'ccccc ', ' cccc ', ' cccc ', ' l  l ', ' l  l ', ' b  b '];
const ADULT_B = ['  hh  ', ' hhhh ', '  ff  ', ' sscs ', ' cccc ', ' ccccc', ' ccccc', ' cccc ', ' cccc ', '  ll  ', '  ll  ', '  bb  '];
const CHILD_A = [' hh ', 'hhhh', ' ff ', 'cccc', 'cccc', 'cccc', 'l  l', 'b  b'];
const CHILD_B = [' hh ', 'hhhh', ' ff ', 'cccc', 'cccc', 'cccc', ' ll ', ' bb '];

/** One step of the horse and sleigh, going right. */
function sleighFrame(step) {
  const art = new Art(72, 31);
  const HORSE = ['#2a1a2a', '#472a30', '#68403a', '#8c5a48'].map(rgba);
  const leg = (hipX, footX, footY, lit) => {
    const c = HORSE[lit ? 1 : 0];
    const kneeX = (hipX + footX) / 2 + (footY < 28 ? 2 : 0.5);
    const kneeY = (19 + footY) / 2;
    for (const ox of lit ? [0, 1] : [0]) {
      art.line(hipX + ox, 18, kneeX + ox, kneeY, c);
      art.line(kneeX + ox, kneeY, footX + ox, footY, c);
    }
    art.rect(footX, footY, lit ? 3 : 2, 1, rgba(lit ? '#cfd8e8' : '#8d97b6'));
  };
  const swing = [[5, 26], [2, 24], [-3, 28], [1, 28]];
  const footOf = (phase) => swing[(step + phase) % 4];
  // Far legs behind.
  leg(43, 43 + footOf(2)[0], footOf(2)[1], false);
  leg(55, 55 + footOf(0)[0], footOf(0)[1], false);
  // The tail.
  art.line(39, 12, 35, 15, HORSE[0]);
  art.line(35, 15, 35, 21, HORSE[0]);
  art.line(38, 12, 36, 18, HORSE[1]);
  // The body, lit along the top from the left, with a warm lick from the lantern.
  art.ellipse(48, 13.5, 9.5, 4.8, HORSE[1]);
  art.ellipse(41.5, 13.5, 4.5, 5, HORSE[1]);
  art.ellipse(55, 14, 4, 5, HORSE[1]);
  art.ellipse(46, 11.6, 7.5, 2, HORSE[2]);
  art.ellipse(41, 11.6, 2.5, 2, HORSE[3]);
  // Neck and head.
  art.poly([[52, 12], [57, 4], [63, 5], [60, 16], [55, 18]], HORSE[1]);
  art.poly([[58, 3], [62, 2], [68, 7], [68, 10], [64, 10], [60, 8]], HORSE[1]);
  art.poly([[59, 4], [62, 3], [66, 7], [62, 7]], HORSE[2]);
  art.rect(60, 0, 1, 3, HORSE[1]);
  art.rect(62, 1, 1, 2, HORSE[0]);
  art.put(63, 5, rgba('#0c0810'));
  art.put(67, 9, rgba('#1a0f18'));
  // The mane, pale, on the near side of the neck.
  art.line(58, 3, 53, 10, rgba('#d8d3cf'));
  art.line(59, 4, 54, 11, rgba('#aaa6ad'));
  // Harness: collar, a strap, three bells.
  art.line(58, 7, 56, 17, rgba('#b23242'));
  art.line(59, 7, 57, 17, rgba('#7c2233'));
  art.rect(40, 14, 16, 1, rgba('#7c2233'));
  for (const [bx, by] of [[46, 15], [50, 15], [54, 15]]) art.put(bx, by, rgba(step % 2 ? '#ffe28a' : '#d7a83e'));
  // Near legs in front.
  leg(41, 41 + footOf(0)[0], footOf(0)[1], true);
  leg(53, 53 + footOf(2)[0], footOf(2)[1], true);
  // Runners, with the curl at the front.
  const STEEL = rgba('#c9d2e4');
  const STEEL_D = rgba('#6f7ba0');
  art.rect(5, 28, 26, 1, STEEL);
  art.rect(5, 29, 26, 1, STEEL_D);
  art.line(31, 28, 35, 25, STEEL);
  art.line(35, 25, 35, 20, STEEL);
  art.line(35, 20, 33, 18, STEEL);
  art.rect(10, 24, 1, 4, STEEL_D);
  art.rect(25, 24, 1, 4, STEEL_D);
  // The shafts to the horse.
  art.line(32, 19, 52, 17, rgba('#1c1420'));
  // The body of the sleigh, red, curved like a shoe, gold along its edges.
  const RED = ramp('#4c1626', '#7c2233', '#ae2f3c', '#d84a4a');
  art.poly([[3, 9], [8, 13], [24, 14], [30, 10], [34, 12], [29, 24], [5, 24]], (x, y) => {
    const v = 0.88 - (y - 9) / 17 - (x - 3) / 90;
    art.tone(x, y, RED, v, 0.7);
  });
  const GOLD = rgba('#ffd976');
  art.line(3, 9, 8, 13, GOLD);
  art.line(8, 13, 24, 14, GOLD);
  art.line(24, 14, 30, 10, GOLD);
  art.line(5, 24, 29, 24, rgba('#c9962e'));
  art.rect(12, 18, 12, 1, rgba('#c9962e'));
  art.put(18, 19, GOLD);
  // Two people, wrapped up against it.
  art.rect(15, 6, 7, 8, rgba('#28345e'));
  art.rect(15, 6, 2, 8, rgba('#3b4b7c'));
  art.rect(16, 3, 5, 3, rgba('#e7bd9f'));
  art.rect(15, 1, 7, 3, rgba('#46322f'));
  art.rect(16, 0, 5, 2, rgba('#5e443b'));
  art.rect(21, 9, 4, 2, rgba('#28345e'));
  art.rect(6, 7, 7, 7, rgba('#5e2a4a'));
  art.rect(6, 7, 2, 7, rgba('#7f3a5e'));
  art.rect(7, 4, 5, 3, rgba('#f0c8a8'));
  art.rect(6, 2, 7, 3, rgba('#e9e4dc'));
  art.rect(6, 7, 7, 1, rgba('#e24a4a'));
  // Reins.
  art.line(25, 10, 39, 12, rgba('#1c1420'));
  art.line(39, 12, 58, 7, rgba('#1c1420'));
  // A pole at the front and the lantern on it.
  art.rect(31, 1, 1, 11, rgba('#1c1420'));
  art.rect(31, 1, 4, 1, rgba('#1c1420'));
  art.rect(33, 2, 3, 5, rgba('#ffe7a8'));
  art.rect(34, 3, 1, 3, rgba('#fffbe4'));
  art.rect(33, 7, 3, 1, rgba('#1c1420'));
  return art.canvas();
}

function fall(ctx, list, t, hex, gust) {
  const span = W + 40;
  ctx.fillStyle = hex;
  for (const f of list) {
    const y = ((f.y + t * f.v) % (H + 8)) - 4;
    const x = (((f.x - gust * f.k + Math.sin((t / f.period + f.phase) * TAU) * f.sway) % span) + span) % span - 20;
    const px = Math.round(x);
    const py = Math.round(y);
    if (f.size < 3) ctx.fillRect(px, py, f.size, f.size);
    else {
      ctx.fillRect(px, py + 1, 3, 1);
      ctx.fillRect(px + 1, py, 1, 3);
    }
  }
}

/** Windows breathe with the fires behind them, and now and then one goes dark. */
function breathe(ctx, list, t) {
  for (const w of list) {
    if (wave(t, w.off, w.offPhase) > 0.93) {
      ctx.fillStyle = '#2b2d55';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#211829';
      if (w.w >= 5) ctx.fillRect(w.x + Math.floor(w.w / 2), w.y, 1, w.h);
      if (w.h >= 6) ctx.fillRect(w.x, w.y + Math.floor(w.h / 2), w.w, 1);
      continue;
    }
    const k = wave(t, w.period, w.phase) + wave(t, w.period * 0.37, w.phase * 3) * 0.5;
    if (k > 0.3) {
      ctx.fillStyle = 'rgba(255,240,180,0.2)';
      ctx.fillRect(w.x, w.y + Math.floor(w.h / 2), w.w, Math.ceil(w.h / 2));
    } else if (k < -0.4) {
      ctx.fillStyle = 'rgba(160,70,30,0.18)';
      ctx.fillRect(w.x, w.y, w.w, w.h);
    }
  }
}

/** Those walking through, at the depth they walk at. */
function stroll(ctx, list, t, glow) {
  const stride = Math.floor(t * 4) % 2;
  for (const w of list) {
    const k = (t / w.period + w.phase) % 1;
    const x = Math.round(w.goingLeft ? W + 16 - k * (W + 32) : k * (W + 32) - 16);
    const frame = w.frames[stride];
    const y = w.base - frame.height;
    if (w.lantern) {
      ctx.globalAlpha = 0.7;
      ctx.drawImage(glow, x - 12, y - 1);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(frame, x, y);
    if (w.lantern) {
      ctx.fillStyle = '#ffe7a8';
      ctx.fillRect(x - 1, y + 9, 2, 2);
    }
  }
}

function rise(ctx, list, t, puffs) {
  for (const c of list) {
    for (let i = 0; i < c.n; i += 1) {
      const age = (t / c.period + c.phase + i / c.n) % 1;
      const sway = Math.sin(age * 6.5 + c.phase * TAU + t * 0.21) * (0.6 + age * 5);
      const size = Math.min(puffs.length - 1, Math.floor(age * puffs.length));
      const p = puffs[size];
      ctx.globalAlpha = Math.min(1, clamp(age * 14) * (1 - age) ** 0.9 * c.alpha * 1.35);
      ctx.drawImage(p, Math.round(c.x - age * age * c.wind + sway - p.width / 2), Math.round(c.y - age * c.rise - p.height / 2));
    }
  }
  ctx.globalAlpha = 1;
}

/** Christmas in a village in the hills, at the blue hour: the tree lit in the square and a sleigh going home. */
const snowVillage = {
  build() {
    const rand = seeded(5101);
    const world = { rand, windows: [], backWindows: [], lamps: [], lights: [], smokeBack: [], smokeFront: [], bulbs: [] };

    // The sky: night from the top, and what's left of the sun low on the left.
    const SKY = ramp('#0e1438', '#121a44', '#172151', '#1d2a5f', '#25356e', '#2e417c', '#3a4f8a', '#4b6096', '#6073a0', '#7e87a8', '#a097ab', '#c5a5a8', '#e6b6a0', '#f7c9a2');
    const MOON = [438, 42, 14];
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const after = Math.exp(-(((x - 120) / 210) ** 2));
      const moon = 0.13 * Math.exp(-((Math.hypot(x - MOON[0], y - MOON[1]) / 44) ** 2));
      return clamp(0.03 + (y / 138) ** 1.8 * (0.42 + 0.58 * after) + moon);
    }, 0.95);
    // A thin moon, lit from where the sun went, with the rest of it just showing.
    for (let y = MOON[1] - MOON[2]; y <= MOON[1] + MOON[2]; y += 1) {
      for (let x = MOON[0] - MOON[2]; x <= MOON[0] + MOON[2]; x += 1) {
        const d = Math.hypot(x - MOON[0], y - MOON[1]);
        if (d > MOON[2]) continue;
        const dark = Math.hypot(x - (MOON[0] + 6), y - (MOON[1] - 5)) < MOON[2] - 0.6;
        if (dark) sky.put(x, y, rgba((x + y) % 2 ? '#2c3a73' : '#27346b'));
        else sky.put(x, y, rgba(x - MOON[0] + (y - MOON[1]) * -0.4 < -5 ? '#fffbe6' : (x + y) % 3 ? '#fff3cf' : '#ecdcb6'));
      }
    }

    // High thin cloud, lit from under.
    const veilNoise = noise2(5102, 64);
    const veil = new Art(960, 120);
    const VEIL_TOP = rgba('#7f8dc8') & 0xffffff;
    const VEIL_LOW = rgba('#b59ab4') & 0xffffff;
    for (let y = 0; y < 120; y += 1) {
      const band = Math.sin((y / 120) * Math.PI) ** 0.7;
      const hue = y > 72 ? VEIL_LOW : VEIL_TOP;
      for (let x = 0; x < 960; x += 1) {
        const n = fbm2(veilNoise, x / 15, y / 2.6, 4);
        const k = (n - 0.54) * 5.5 * band;
        if (k <= 0) continue;
        const level = Math.floor(Math.min(1, k) * 4 + bayer(x, y) * 0.9) / 4;
        if (level > 0) veil.px[y * 960 + x] = ((Math.round(level * 86) << 24) | hue) >>> 0;
      }
    }

    // Hills, far and in the haze, then nearer and bluer, snow on all of them.
    const ranges = new Art();
    const farNoise = noise1(5103, 256);
    const nearNoise = noise1(5104, 256);
    const rock = noise2(5105, 64);
    const far = (x) => 148 - ridged(farNoise, x / 74, 4) * 50;
    const near = (x) => 172 - ridged(nearNoise, x / 58 + 40, 4) * 42;
    const FAR = ramp('#38457f', '#45538b', '#566496', '#6f76a2', '#8f86ab', '#b299b2', '#d3afb4');
    const NEAR = ramp('#1c2553', '#232e60', '#2d3a6e', '#3b4b7e', '#50618e', '#6f7ca0', '#9093b0');
    for (let x = 0; x < W; x += 1) {
      const a = far(x);
      for (let y = Math.round(a); y < 186; y += 1) {
        const slope = far(x + 2) - far(x - 2);
        const streak = fbm2(rock, (x - y * 0.7) / 7, y / 11, 3) - 0.5;
        ranges.tone(x, y, FAR, clamp(0.6 - slope * 0.13 + streak * 0.8 - ((y - a) / 58) * 0.3), 0.8);
      }
    }
    for (let x = 0; x < W; x += 1) {
      const a = near(x);
      for (let y = Math.round(a); y < 200; y += 1) {
        const slope = near(x + 2) - near(x - 2);
        const streak = fbm2(rock, (x + y * 0.6) / 6 + 30, y / 9, 3) - 0.5;
        ranges.tone(x, y, NEAR, clamp(0.52 - slope * 0.13 + streak * 0.9 - ((y - a) / 50) * 0.34), 0.8);
      }
    }

    // A dark wood across the foot of the hills, each tree a touch of snow.
    const WOOD_G = ramp('#17204a', '#1d2857', '#243364');
    const WOOD_S = ramp('#4a5e96', '#6780b2', '#8fa6cc');
    const treeLine = [];
    for (let i = 0; i < 200; i += 1) treeLine.push({ x: rand() * W, base: 176 + rand() * 16, tall: 8 + rand() * 13 });
    treeLine.sort((a, b) => a.base - b.base);
    for (const f of treeLine) snowFir(ranges, Math.round(f.x), Math.round(f.base), Math.round(f.tall), WOOD_G, WOOD_S, rand);

    const distantLights = [];
    for (let i = 0; i < 16; i += 1) distantLights.push({ x: Math.floor(rand() * W), y: 164 + Math.floor(rand() * 18), period: 4 + rand() * 11, phase: rand() });

    // The village: the ground first, and everything stood on it from the back to the front.
    const village = new Art();
    const front = new Art();
    world.frontArt = front;
    const drift = noise2(5106, 64);
    const RED = ramp('#2e1f3e', '#47264a', '#62304f', '#7e3d56', '#99505f');
    const OCHRE = ramp('#3a3050', '#54445c', '#6f5a64', '#8e7470', '#ab8f7e');
    const BLUE = ramp('#1f2a54', '#2c3b68', '#3e5080', '#546a98', '#7088b0');
    const GREEN = ramp('#1f3050', '#2a4260', '#395a6e', '#4f7478', '#6e9084');
    const PLASTER = ramp('#3e4470', '#565b84', '#767a9a', '#989bb0', '#bcbcc6');
    const SHUTTER_G = [rgba('#27564e'), rgba('#1c3f3f')];
    const SHUTTER_R = [rgba('#7e2c38'), rgba('#5a2030')];
    const SHUTTER_B = [rgba('#2d4f86'), rgba('#223c6c')];

    // The row at the back, small and simple.
    /** @type {[number, number, number, number, number, number, any][]} */
    const backs = [[6, 186, 16, 20, 14, 10, OCHRE], [46, 188, 14, 26, 13, 10, BLUE], [88, 186, 16, 22, 15, 11, GREEN], [128, 188, 14, 18, 13, 9, RED], [262, 187, 15, 24, 14, 10, RED], [306, 186, 14, 22, 15, 11, OCHRE], [350, 188, 15, 20, 13, 10, BLUE], [396, 186, 14, 24, 14, 11, GREEN], [440, 188, 16, 22, 15, 10, RED]];

    // Ground goes in once every light on it is known, so remember them first.
    const groundDone = () => {
      const lights = world.lights;
      const pooled = (x, y) => {
        let sum = 0;
        for (const l of lights) {
          const dx = (x - l.x) / l.r;
          if (dx > 1.8 || dx < -1.8) continue;
          const dy = ((y - l.y) * 2.5) / l.r;
          if (dy > 1.8 || dy < -1.8) continue;
          sum += l.s * Math.exp(-(dx * dx + dy * dy));
        }
        return sum > 1 ? 1 : sum;
      };
      return pooled;
    };

    // The lights on the ground, known ahead of the houses that throw them.
    world.lights.push(
      { x: 382, y: 234, r: 62, s: 0.82 },
      { x: 50, y: 234, r: 18, s: 0.34 }, { x: 80, y: 234, r: 18, s: 0.34 }, { x: 118, y: 234, r: 14, s: 0.3 }, { x: 142, y: 234, r: 16, s: 0.3 },
      { x: 226, y: 212, r: 14, s: 0.36 },
      { x: 456, y: 230, r: 16, s: 0.32 },
    );

    lampPost(front, world, 172, 234, 26);
    lampPost(front, world, 306, 238, 28);
    lampPost(front, world, 444, 240, 26);
    lampPost(village, world, 256, 212, 16);

    const pooled = groundDone();
    const GROUND = [0, 1, 2, 3, 4, 5].map((level) => SNOW.map((c, i) => tint(c, SNOW_WARM[i], level / 5)));
    const ROAD = (x, y) => Math.abs(y - 244 - Math.sin(x / 70) * 1.5);
    for (let y = 176; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const hill = 188 + Math.sin(x / 83 + 1) * 3 + Math.sin(x / 31) * 1.2;
        if (y < hill) continue;
        const n = fbm2(drift, x / 21, y / 5.2, 3);
        let v = 0.66 - (y - hill) / 240 + (n - 0.5) * 0.42;
        const road = ROAD(x, y);
        if (road < 8) v -= 0.1 * (1 - road / 8) + (Math.abs(road - 3.5) < 1 ? 0.08 : 0);
        const warm = pooled(x, y);
        v += warm * 0.18;
        const i = Math.round(clamp(v) * 9 + (bayer(x, y) - 0.5) * 0.8);
        const stepped = i < 0 ? 0 : i > 9 ? 9 : i;
        const level = Math.floor(warm * 5 + bayer(x + 1, y + 2) * 0.95);
        village.px[y * W + x] = GROUND[level > 5 ? 5 : level][stepped];
      }
    }

    for (const [x, base, gable, side, wall, roof, paint] of backs) {
      const g = house(village, { x, base, gable, side, wall, roof, paint }, rand, drift);
      for (let i = g.sx0 + 3; i < g.sx1 - 3; i += 6) if (rand() < 0.7) village.rect(i, g.eave + 5, 2, 3, GLASS[Math.floor(rand() * 3) + 2]);
      village.rect(g.gx0 + gable / 2 - 1, g.eave + 2, 2, 3, GLASS[3]);
      if (rand() < 0.75) chimneyAt(village, world, Math.round(mix(g.ridgeL, g.ridgeR, 0.3 + rand() * 0.4)), g.apexY - 5, 3, 6, { rise: 44, wind: 18, alpha: 0.42, period: 9 });
      for (let px = x - 2; px < g.sx1 + 2; px += 1) village.tone(px, base - (fbm2(drift, px / 5, 2.2, 2) > 0.5 ? 1 : 0), SNOW, 0.72, 0.6);
    }

    // The church, in the middle of them, its tower the tallest thing here but the tree.
    const churchX = 196;
    const nave = house(village, { x: churchX + 14, base: 208, gable: 26, side: 42, wall: 26, roof: 20, paint: PLASTER }, rand, drift);
    const STAINED = ['#e0525a', '#4f8fe0', '#f2c24e', '#5fc48a'].map(rgba);
    for (const wx of [nave.sx0 + 5, nave.sx0 + 18, nave.sx0 + 31]) {
      village.rect(wx - 1, 186, 8, 15, FRAME);
      for (let j = 0; j < 13; j += 1) {
        for (let i = 0; i < 6; i += 1) {
          if (j < 2 && (i < 2 - j || i > 3 + j)) continue;
          village.put(wx + i, 187 + j, STAINED[(Math.floor(i / 2) + Math.floor(j / 3)) % 4]);
        }
      }
      village.rect(wx + 2, 187, 1, 13, FRAME);
      village.rect(wx, 193, 6, 1, FRAME);
      village.rect(wx - 2, 201, 10, 1, SNOW_WARM[7]);
    }
    doorAt(village, nave.gx0 + 9, 208, 8, 15, '#4a2c30', { wreath: true, lamp: true });
    // The tower.
    const TOWER = ramp('#2c3158', '#3e4370', '#565c88', '#767c9f', '#9a9fb6');
    const tx = churchX;
    const ty = 142;
    for (let y = ty; y < 208; y += 1) {
      for (let x = tx; x < tx + 18; x += 1) {
        const course = y % 5 === 0 || (x + Math.floor(y / 5) * 4) % 8 === 0 ? -0.1 : 0;
        village.tone(x, y, TOWER, 0.8 - ((x - tx) / 18) * 0.55 + course, 0.7);
      }
    }
    village.rect(tx + 6, 151, 6, 10, FRAME);
    village.rect(tx + 7, 150, 4, 1, FRAME);
    village.rect(tx + 7, 158, 4, 3, rgba('#e4a54e'));
    village.rect(tx + 7, 152, 4, 1, rgba('#3a2a3e'));
    world.bell = { x: tx + 9, y: 153 };
    village.rect(tx - 1, 162, 20, 1, SNOW[8]);
    windowAt(village, world, tx + 7, 172, 4, 8, { arch: true, panes: false, live: true });
    doorAt(village, tx + 5, 208, 8, 12, '#3f262c', {});
    for (let y = 0; y < 34; y += 1) {
      const half = 10 * ((y + 1) / 34);
      for (let dx = -Math.round(half); dx < half; dx += 1) {
        const a = dx / Math.max(1, half);
        village.tone(tx + 9 + dx, ty - 34 + y, SNOW, 0.82 - a * 0.42 + (fbm2(drift, (tx + dx) / 5, y / 4, 2) - 0.5) * 0.3, 0.7);
      }
    }
    village.rect(tx - 1, ty - 1, 20, 2, SNOW[9]);
    village.rect(tx + 9, ty - 42, 1, 8, rgba('#3a3a5a'));
    village.put(tx + 9, ty - 43, rgba('#ffd976'));

    // The row in the middle.
    const mids = [
      { x: 8, base: 206, gable: 24, side: 30, wall: 28, roof: 18, paint: RED, shutters: SHUTTER_G },
      { x: 84, base: 208, gable: 22, side: 26, wall: 30, roof: 19, paint: BLUE, shutters: SHUTTER_R, chimney: true },
      { x: 142, base: 207, gable: 22, side: 28, wall: 26, roof: 17, paint: OCHRE, shutters: SHUTTER_B },
      { x: 262, base: 209, gable: 24, side: 30, wall: 30, roof: 20, paint: GREEN, shutters: SHUTTER_R },
      { x: 326, base: 206, gable: 22, side: 32, wall: 26, roof: 18, paint: OCHRE, shutters: SHUTTER_G },
      { x: 398, base: 208, gable: 24, side: 34, wall: 30, roof: 20, paint: RED, shutters: SHUTTER_B },
    ];
    for (const m of mids) {
      const g = house(village, m, rand, drift);
      const n = Math.round(m.side / 13);
      for (let i = 0; i < n; i += 1) windowAt(village, world, g.sx0 + 4 + i * 13, g.eave + 8, 6, 8, { shutters: m.side > 28 ? m.shutters : null, live: i === 0 });
      windowAt(village, world, g.gx0 + m.gable / 2 - 3, g.eave + 8, 6, 8, {});
      windowAt(village, world, g.gx0 + m.gable / 2 - 2, g.apexY + m.roof * 0.5, 4, 5, { panes: false });
      chimneyAt(village, world, Math.round(mix(g.ridgeL, g.ridgeR, 0.35 + rand() * 0.3)), g.apexY - 7, 5, 8, { rise: 58, wind: 22, alpha: 0.52, period: 8.5 });
      for (let px = m.x - 3; px < g.sx1 + 3; px += 1) {
        const up = Math.round(fbm2(drift, px / 6, 4.2, 2) * 4);
        for (let j = 0; j < up; j += 1) village.tone(px, m.base - j, SNOW, 0.7 + (j === up - 1 ? 0.12 : 0), 0.6);
      }

    }

    // Firs among the houses.
    const FIR_G = ramp('#0d1f35', '#123044', '#1a4450', '#265a5c');
    const FIR_S = ramp('#5a72a8', '#7c95c2', '#a8bcdc', '#d5e0ef', '#f0f5fb');
    for (const [x, base, tall] of [[62, 206, 36], [74, 210, 26], [130, 208, 30], [186, 210, 26], [320, 210, 30], [392, 208, 26], [470, 210, 34]]) snowFir(village, x, base, tall, FIR_G, FIR_S, rand);

    // The two houses nearest us, in full.
    const big = house(front, { x: 26, base: 228, gable: 46, side: 82, wall: 48, roof: 36, paint: PLASTER, flip: true, timber: true, tile: '#5a3248' }, rand, drift);
    for (const wx of [big.sx0 + 9, big.sx0 + 35]) windowAt(front, world, wx, big.eave + 12, 13, 16, { shutters: SHUTTER_R, live: true });
    doorAt(front, big.sx0 + 62, 228, 11, 24, '#6a2b33', { wreath: true, lamp: true });
    windowAt(front, world, big.gx0 + 7, big.eave + 12, 12, 16, {});
    windowAt(front, world, big.gx0 + 27, big.eave + 12, 12, 16, { live: true });
    windowAt(front, world, Math.round(big.apexX) - 4, Math.round(big.apexY) + 17, 8, 10, { arch: true });
    dormer(front, world, big.sx0 + 26, big.apexY + 12, 12);
    dormer(front, world, big.sx0 + 54, big.apexY + 12, 12);
    chimneyAt(front, world, big.sx0 + 42, big.apexY - 11, 8, 12, { list: 'smokeFront', rise: 92, wind: 30, alpha: 0.62, period: 9 });
    chimneyAt(front, world, Math.round(big.apexX) - 16, big.apexY - 8, 7, 10, { list: 'smokeFront', rise: 84, wind: 26, alpha: 0.55, period: 7.5 });

    // A string of small lights along the long eave, and along the gable.
    world.eaves = [];
    for (let x = big.sx0 + 2; x < big.sx1 - 1; x += 4) world.eaves.push({ x, y: big.eave + 5 + Math.round(Math.sin(x * 0.8)), period: 1.7 + rand() * 2.4, phase: rand() });
    for (let px = big.sx0 - 1; px <= big.gx1 + 1; px += 1) {
      const up = Math.round(fbm2(drift, px / 6, 7.4, 2) * 6);
      for (let j = 0; j < up; j += 1) front.tone(px, 229 - j, SNOW, 0.66 + (j === up - 1 ? 0.2 : 0), 0.6);
    }

    const right = house(front, { x: 438, base: 226, gable: 40, side: 60, wall: 44, roof: 32, paint: RED, tile: '#4a2a44' }, rand, drift);
    windowAt(front, world, right.gx0 + 6, right.eave + 12, 11, 14, { live: true });
    windowAt(front, world, right.gx0 + 24, right.eave + 12, 11, 14, {});
    windowAt(front, world, Math.round(right.apexX) - 4, Math.round(right.apexY) + 15, 8, 9, { arch: true });
    chimneyAt(front, world, Math.round(right.apexX) + 22, right.apexY - 7, 7, 10, { list: 'smokeFront', rise: 80, wind: 28, alpha: 0.58, period: 8 });

    for (let px = 434; px < W; px += 1) {
      const up = Math.round(fbm2(drift, px / 6, 9.4, 2) * 6);
      for (let j = 0; j < up; j += 1) front.tone(px, 227 - j, SNOW, 0.66 + (j === up - 1 ? 0.2 : 0), 0.6);
    }

    // The tree, a mound of snow and a heap of parcels at the foot of it.
    const TREE = { x: 382, base: 231, top: 64 };
    front.rect(TREE.x - 4, TREE.base - 14, 8, 15, rgba('#2c1c26'));
    front.rect(TREE.x - 4, TREE.base - 14, 2, 15, rgba('#4a2f30'));
    christmasTree(front, world, TREE.x, TREE.base - 3, TREE.top, rand);
    for (let dx = -52; dx <= 52; dx += 1) {
      const up = Math.round((1 - (dx / 52) ** 2) ** 0.7 * 6 + fbm2(drift, dx / 5 + 40, 2, 2) * 2 - 1);
      for (let j = 0; j <= up; j += 1) front.tone(TREE.x + dx, TREE.base + 3 - j, SNOW_WARM, 0.52 + (j / Math.max(1, up)) * 0.3 - (dx / 52) * 0.1, 0.6);
    }
    /** @type {[number, number, number, number, string, string][]} */
    const parcels = [[346, 225, 11, 7, '#c23a42', '#ffe08a'], [360, 228, 8, 6, '#2d5e9c', '#f2f5fb'], [371, 226, 9, 8, '#e0a53a', '#b82f3a'], [393, 227, 10, 7, '#2f8a5a', '#ffe08a'], [406, 224, 8, 9, '#8f3f8a', '#f2f5fb'], [415, 229, 7, 5, '#c23a42', '#f2f5fb']];
    for (const [x, y, w, h, hex, ribbon] of parcels) {
      front.rect(x, y, w, h, rgba(hex));
      front.rect(x + w - 2, y, 2, h, tint(rgba(hex), FRAME, 0.35));
      front.rect(x, y + h - 1, w, 1, tint(rgba(hex), FRAME, 0.45));
      front.rect(x + Math.floor(w / 2), y, 1, h, rgba(ribbon));
      front.rect(x, y + Math.floor(h / 2), w, 1, rgba(ribbon));
      front.rect(x, y - 1, w, 1, SNOW[9]);
      front.put(x + Math.floor(w / 2) - 1, y - 2, rgba(ribbon));
      front.put(x + Math.floor(w / 2) + 1, y - 2, rgba(ribbon));
    }

    // A snowman, who has been given a scarf.
    const sx = 244;
    const sy = 228;
    front.ellipse(sx, sy - 5, 7, 6, SNOW[8]);
    front.ellipse(sx - 1, sy - 6, 5, 4, SNOW[9]);
    front.ellipse(sx, sy - 14, 5, 5, SNOW[8]);
    front.ellipse(sx - 1, sy - 15, 3, 3, SNOW[9]);
    front.ellipse(sx, sy - 21, 4, 4, SNOW[8]);
    front.ellipse(sx - 1, sy - 22, 2.5, 2.5, SNOW[9]);
    front.rect(sx - 3, sy - 25, 7, 1, FRAME);
    front.rect(sx - 2, sy - 29, 5, 4, FRAME);
    front.rect(sx - 2, sy - 26, 5, 1, rgba('#b23242'));
    front.put(sx - 2, sy - 22, FRAME);
    front.put(sx + 1, sy - 22, FRAME);
    front.rect(sx, sy - 21, 3, 1, rgba('#f08a3a'));
    front.rect(sx - 4, sy - 18, 9, 2, rgba('#c9303f'));
    front.rect(sx + 2, sy - 16, 2, 5, rgba('#a32638'));
    front.put(sx, sy - 13, FRAME);
    front.put(sx, sy - 10, FRAME);
    front.line(sx - 5, sy - 14, sx - 12, sy - 19, rgba('#35252c'));
    front.line(sx + 5, sy - 14, sx + 11, sy - 18, rgba('#35252c'));

    // People: a family looking up at the tree, a couple arm in arm.
    const folk = (rows, coat, hat, x, y, scarf = coat, face = '#e7bd9f') => {
      const cv = sprite(rows, { c: coat, h: hat, f: face, s: scarf, l: '#1c1630', b: '#110e1c' });
      return { cv, x, y };
    };
    world.folk = [
      folk(ADULT_A, '#2d4f86', '#46322f', 322, 225, '#d84a4a'),
      folk(CHILD_A, '#c23a42', '#f2f5fb', 330, 229, '#c23a42'),
      folk(mirror(ADULT_A), '#5e2a4a', '#e9e4dc', 436, 226, '#e0a53a'),
      folk(mirror(ADULT_A), '#2a4a4a', '#26202c', 443, 227, '#7c3a5e'),
    ].map((p) => ({ ...p, bob: 2.4 + rand() * 3, phase: rand() }));
    for (const p of world.folk) p.h = p.cv.height;
    const walker = (a, b, coat, hat, scarf, base, period, phase, goingLeft, lantern) => ({
      frames: [sprite(goingLeft ? mirror(a) : a, { c: coat, h: hat, f: '#e7bd9f', s: scarf, l: '#1c1630', b: '#110e1c' }), sprite(goingLeft ? mirror(b) : b, { c: coat, h: hat, f: '#e7bd9f', s: scarf, l: '#1c1630', b: '#110e1c' })],
      base,
      period,
      phase,
      goingLeft,
      lantern,
    });
    world.backWalkers = [
      walker(ADULT_A, ADULT_B, '#3f2a4a', '#2a2036', '#c9962e', 220, 58, 0.15, true, true),
      walker(ADULT_A, ADULT_B, '#28345e', '#5a4a4a', '#b23242', 216, 73, 0.5, false, false),
    ];
    world.walkers = [
      walker(CHILD_A, CHILD_B, '#2f8a5a', '#d84a4a', '#2f8a5a', 239, 47, 0.6, false, false),
      walker(ADULT_A, ADULT_B, '#6a3a30', '#1c1630', '#cfd8e8', 238, 47, 0.633, false, false),
    ];

    // The sleigh and the light it carries along the road.
    const sleigh = [0, 1, 2, 3].map(sleighFrame);

    // The bank at our feet, a fence along it and firs at either end.
    const fore = new Art();
    const bankNoise = noise1(5107, 128);
    const bank = (x) => 258 + (bankNoise(x / 19) - 0.5) * 7 + Math.sin(x / 90) * 2;
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(bank(x));
      for (let y = top; y < H; y += 1) {
        const n = fbm2(drift, x / 15 + 7, y / 4, 2);
        fore.tone(x, y, SNOW, (y === top ? 0.86 : y === top + 1 ? 0.7 : 0.48 - (y - top) * 0.014) + (n - 0.5) * 0.3, 0.8);
      }
    }
    const fenceAt = (x) => 258 + Math.sin(x / 90) * 2;
    const POST = rgba('#1e1525');
    const POST_LIT = rgba('#46303a');
    for (let x = 8; x < W; x += 22) {
      const y = Math.round(fenceAt(x)) - 12;
      fore.rect(x, y, 3, 16, POST);
      fore.rect(x, y, 1, 16, POST_LIT);
      fore.rect(x - 1, y - 2, 5, 2, SNOW[9]);
      fore.rect(x, y - 3, 3, 1, SNOW[8]);
    }
    for (const rail of [5, 9]) {
      for (let x = 0; x < W; x += 1) {
        const y = Math.round(fenceAt(x) - 12 + rail);
        if (y < bank(x)) {
          fore.put(x, y, POST);
          fore.put(x, y - 1, fbm2(drift, x / 4, 11.1, 2) > 0.42 ? SNOW[8] : POST_LIT);
        }
      }
    }
    const NEAR_G = ramp('#091725', '#0d2433', '#143645', '#1f4d54');
    const NEAR_S = ramp('#46609a', '#6b86ba', '#9cb3d8', '#cfdcee', '#f0f5fb');
    for (const [x, base, tall] of [[468, 266, 66], [16, 268, 104], [44, 268, 62], [-6, 266, 74]]) snowFir(fore, x, base, tall, NEAR_G, NEAR_S, rand);

    // A fir's bough, close to us, reaching in from the top left: fronds on a limb, snow on their backs.
    const bough = new Art(214, 72);
    const limb = (x) => 2 + x * 0.1 + Math.sin(x / 34) * 2;
    const BOUGH_G = ramp('#050f1a', '#081824', '#0c2430', '#12333c', '#1a454a');
    const fronds = [];
    for (let i = 0; i < 36; i += 1) {
      const x0 = i * 5.2 + rand() * 3;
      const fade = 1 - x0 / 236;
      fronds.push({ x0, y0: limb(x0), len: (20 + rand() * 22) * fade, lean: 7 + rand() * 13, fw: (5 + rand() * 3.5) * fade });
    }
    fronds.sort((p, q) => q.len - p.len);
    for (const fr of fronds) {
      bough.poly([[fr.x0 - 1, fr.y0 - 1], [fr.x0 + fr.fw + fr.lean * 0.5, fr.y0 + fr.len * 0.5], [fr.x0 + fr.lean, fr.y0 + fr.len], [fr.x0 - fr.fw + fr.lean * 0.4, fr.y0 + fr.len * 0.56]], (x, y) => {
        bough.tone(x, y, BOUGH_G, 0.1 + clamp((y - fr.y0) / fr.len) * 0.72 + ((x * 2 + y * 3) % 5 === 0 ? 0.14 : 0), 0.8);
      });
    }
    for (let x = 0; x < 186; x += 1) bough.rect(x, limb(x), 1, x < 80 ? 3 : 2, rgba('#140e1a'));
    for (const fr of fronds) {
      for (let b = 0; b < 3; b += 1) {
        const k = 0.15 + rand() * 0.6;
        const px = fr.x0 + fr.lean * k * 0.6 - fr.fw * 0.2;
        const py = fr.y0 + fr.len * k * 0.72;
        const rx = 1.6 + rand() * 2.6;
        const ry = 0.9 + rand() * 0.9;
        for (let y = Math.floor(py - ry - 2); y <= py + ry + 2; y += 1) {
          for (let x = Math.floor(px - rx); x <= px + rx; x += 1) {
            const ly = y - (x - px) * 0.42;
            if (((x - px) / rx) ** 2 + ((ly - py) / ry) ** 2 <= 1 && bough.get(x, y)) bough.tone(x, y, SNOW, 0.72 + ((py - ly) / ry) * 0.26, 0.45);
          }
        }
      }
    }

    // A robin on the fence.
    const robin = [sprite([' kk  ', 'kkkke', 'rrkk ', 'rrkk ', ' ll  '], { k: '#3c3030', r: '#e2533f', e: '#f2c24e', l: '#1c1420' }), sprite(['     ', ' kk  ', 'kkkke', 'rrkk ', ' ll  '], { k: '#3c3030', r: '#e2533f', e: '#f2c24e', l: '#1c1420' })];

    const flakes = [];
    const layer = (count, v0, v1, sway, k, size) => {
      const list = [];
      for (let i = 0; i < count; i += 1) list.push({ x: rand() * (W + 40), y: rand() * H, v: v0 + rand() * (v1 - v0), sway: rand() * sway, period: 3 + rand() * 6, phase: rand(), k, size });
      return list;
    };
    flakes.push(layer(90, 5, 8, 1.5, 0.3, 1), layer(120, 11, 17, 3, 0.55, 1), layer(70, 22, 32, 5, 1, 1), layer(30, 34, 48, 8, 1.5, 2), layer(10, 58, 74, 12, 2.2, 3));

    const sparkles = [];
    for (let i = 0; i < 46; i += 1) sparkles.push({ x: Math.floor(rand() * W), y: 200 + Math.floor(rand() * 68), period: 2.6 + rand() * 5, phase: rand() });

    return {
      sky: sky.canvas(),
      stars: starField(rand, 170, 124).filter((s) => Math.hypot(s.x - MOON[0], s.y - MOON[1]) > MOON[2] + 2),
      veil: veil.canvas(),
      ranges: ranges.canvas(),
      village: village.canvas(),
      front: front.canvas(),
      fore: fore.canvas(),
      bough: bough.canvas(),
      puffs: [1, 1.5, 2, 2.6, 3.2, 4, 4.8, 5.6].map(puffSprite),
      halo: glowSprite(13, 13, '#ffcf80', 0.8),
      starGlow: glowSprite(30, 30, '#ffe39a', 0.62),
      starCut: starSprite(10, 4),
      lanternGlow: glowSprite(18, 18, '#ffc873', 0.7),
      roadPool: glowSprite(42, 7, '#ffd08a', 0.55),
      folkGlow: glowSprite(11, 11, '#ffc873', 0.6),
      sleigh,
      robin,
      distantLights,
      windows: world.windows,
      backWindows: world.backWindows,
      lamps: world.lamps,
      bulbs: world.bulbs,
      eaves: world.eaves,
      smokeBack: world.smokeBack,
      smokeFront: world.smokeFront,
      folk: world.folk,
      walkers: world.walkers,
      backWalkers: world.backWalkers,
      bell: world.bell,
      flakes,
      sparkles,
      tree: TREE,
    };
  },
  draw(ctx, t, s) {
    const gust = t * 7 + Math.sin(t / 13) * 34 + Math.sin(t / 5.3 + 1) * 11;

    ctx.drawImage(s.sky, 0, 0);
    drawStars(ctx, s.stars, t);
    slide(ctx, s.veil, along(t, 1.1, 960), 26);

    // A star falls, about once a minute and a bit.
    const fell = (t % 83) / 0.9;
    if (fell < 1) {
      ctx.fillStyle = '#fff6da';
      for (let i = 0; i < 9; i += 1) {
        ctx.globalAlpha = (1 - fell) * (1 - i / 9);
        ctx.fillRect(Math.round(120 + fell * 70 - i * 2), Math.round(20 + fell * 26 - i), 1, 1);
      }
      ctx.globalAlpha = 1;
    }

    ctx.drawImage(s.ranges, 0, 0);
    for (const l of s.distantLights) {
      ctx.fillStyle = wave(t, l.period, l.phase) > -0.5 ? '#ffd27e' : '#a8704e';
      ctx.fillRect(l.x, l.y, 1, 1);
    }
    fall(ctx, s.flakes[0], t, '#7f93bf', gust);

    ctx.drawImage(s.village, 0, 0);
    // The bell, rocking in its arch now and then.
    const ring = t % 40 < 9 ? Math.round(wave(t, 2.2)) : 0;
    ctx.fillStyle = '#d7a83e';
    ctx.fillRect(s.bell.x - 1 + ring, s.bell.y + 1, 3, 2);
    ctx.fillRect(s.bell.x + ring, s.bell.y, 1, 1);
    breathe(ctx, s.backWindows, t);
    stroll(ctx, s.backWalkers, t, s.folkGlow);
    rise(ctx, s.smokeBack, t, s.puffs);
    fall(ctx, s.flakes[1], t, '#b4c6e2', gust);

    const sx = s.tree.x;
    const sy = s.tree.top - 3;
    const breath = wave(t, 5.1) * 0.5 + 0.5;
    ctx.globalAlpha = 0.55 + breath * 0.35;
    ctx.drawImage(s.starGlow, sx - 30, sy - 30);
    ctx.globalAlpha = 1;
    ctx.drawImage(s.front, 0, 0);
    rise(ctx, s.smokeFront, t, s.puffs);

    breathe(ctx, s.windows, t);
    // Street lamps, with a soft breath to them.
    for (const l of s.lamps) {
      ctx.globalAlpha = 0.7 + 0.14 * wave(t, 3.7, l.phase);
      ctx.drawImage(s.halo, l.x - 13, l.y - 13);
    }
    ctx.globalAlpha = 1;

    // The lights along the eave.
    for (const e of s.eaves) {
      ctx.fillStyle = wave(t, e.period, e.phase) > -0.25 ? '#ffe5a0' : '#a8743e';
      ctx.fillRect(e.x, e.y, 1, 1);
    }

    // The tree's bulbs, each on its own clock, a slow swell climbing through them all.
    for (const group of s.bulbs) {
      ctx.fillStyle = group.hex;
      for (const b of group.list) {
        const k = clamp(0.58 + wave(t, b.period, b.phase) * 0.5 + Math.sin(t * 1.1 + b.y * 0.07) * 0.2);
        ctx.globalAlpha = 0.5 + k * 0.5;
        ctx.fillRect(b.x, b.y, 1, 1);
        if (k > 0.5) {
          ctx.globalAlpha = (k - 0.5) * 1.5;
          ctx.fillRect(b.x - 1, b.y, 3, 1);
          ctx.fillRect(b.x, b.y - 1, 1, 3);
        }
      }
    }
    // The brightest of them burn white at the heart.
    ctx.fillStyle = '#ffffff';
    for (const group of s.bulbs) {
      for (const b of group.list) {
        const k = clamp(0.58 + wave(t, b.period, b.phase) * 0.5 + Math.sin(t * 1.1 + b.y * 0.07) * 0.2);
        if (k > 0.82) {
          ctx.globalAlpha = (k - 0.82) * 5;
          ctx.fillRect(b.x, b.y, 1, 1);
        }
      }
    }
    ctx.globalAlpha = 1;

    // The star on top: its glow breathes, its rays lengthen and draw in.
    ctx.fillStyle = '#fff4c4';
    const rayH = 15 + Math.round(breath * 6);
    const rayD = 8 + Math.round((1 - breath) * 4);
    ctx.fillRect(sx, sy - rayH, 1, rayH + 6);
    ctx.fillRect(sx - rayH, sy, rayH * 2 + 1, 1);
    ctx.globalAlpha = 0.6;
    for (let i = 1; i <= rayD; i += 1) {
      ctx.fillRect(sx - i, sy - i, 1, 1);
      ctx.fillRect(sx + i, sy - i, 1, 1);
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(s.starCut, sx - 11, sy - 11);

    // Those looking at the tree shift from foot to foot.
    for (const p of s.folk) {
      const lift = wave(t, p.bob, p.phase) > 0.75 ? 1 : 0;
      ctx.drawImage(p.cv, p.x, p.y - lift);
    }
    stroll(ctx, s.walkers, t, s.folkGlow);

    fall(ctx, s.flakes[2], t, '#dbe6f4', gust);

    // A horse and sleigh about once a minute, with a lantern lighting the road ahead of it.
    const pass = (t % 61) / 34;
    if (pass < 1) {
      const x = Math.round(pass * (W + 170)) - 85;
      const y = 219 + (Math.floor(t * 8) % 2);
      ctx.globalAlpha = 0.8;
      ctx.drawImage(s.roadPool, x - 6, 243);
      ctx.drawImage(s.lanternGlow, x + 16, y - 14);
      ctx.globalAlpha = 1;
      ctx.drawImage(s.sleigh[Math.floor(t * 8) % 4], x, y);
    }

    ctx.drawImage(s.fore, 0, 0);

    // A robin, who hops along a post's width and back.
    const hop = (t % 11) / 11;
    const rx = hop < 0.5 ? 118 : 123;
    const pecking = (t % 3.3) < 0.3;
    ctx.drawImage(s.robin[pecking ? 1 : 0], rx, 243);

    // Glints on the snow.
    ctx.fillStyle = '#ffffff';
    for (const g of s.sparkles) {
      if (wave(t, g.period, g.phase) > 0.965) ctx.fillRect(g.x, g.y, 1, 1);
    }

    // The bough, and the bit of snow it drops every so often when the wind leans on it.
    ctx.drawImage(s.bough, -6 + Math.round(wave(t, 9.1) * 1.2), -3 + Math.round(wave(t, 6.7, 0.3)));
    const shed = (t % 29) / 2.4;
    if (shed < 1) {
      ctx.fillStyle = '#dfe9f6';
      for (let i = 0; i < 12; i += 1) {
        const px = 104 + ((i * 37) % 26) - shed * 6 + Math.sin(i * 2.4 + shed * 5) * 2;
        const py = 28 + ((i * 23) % 9) + shed * shed * (60 + (i % 5) * 16);
        ctx.globalAlpha = 1 - shed * shed;
        ctx.fillRect(Math.round(px), Math.round(py), 1, 1);
      }
      ctx.globalAlpha = 1;
    }

    fall(ctx, s.flakes[3], t, '#eef4fb', gust);
    ctx.globalAlpha = 0.72;
    fall(ctx, s.flakes[4], t, '#f6f9fd', gust);
    ctx.globalAlpha = 1;
  },
};

export default snowVillage;
