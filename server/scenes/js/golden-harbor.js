import { W, H, TAU, clamp, mix, smooth, wave, along, seeded, rgba, ramp, bayer, BAYER, Art, newCanvas, noise1, noise2, fbm1, fbm2, slide } from './art.js';

/* Where things stand. The sun sits to the left over open sea; the town climbs in the
   middle; the lighthouse takes the right, with the dusk behind it so its beam shows. */
const SEA = 126; // the horizon
const ROWS = H - SEA;
const SUN = { x: 118, y: 101, r: 17 };
const BEACON = { x: 447, y: 27 };
const QUAY = 136; // where the town's sea wall meets the water

const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const pack = (r, g, b) => (0xff000000 | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
const blend = (a, b, k) => pack(mix(a & 255, b & 255, k), mix((a >> 8) & 255, (b >> 8) & 255, k), mix((a >> 16) & 255, (b >> 16) & 255, k));

/** A round glow to add on top, its alpha in dithered steps. */
function glowSprite(rx, ry, hex, peak, steps = 14, power = 1) {
  const w = Math.ceil(rx * 4);
  const h = Math.ceil(ry * 4);
  const art = new Art(w, h);
  const [r, g, b] = rgbOf(hex);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = ((x - w / 2) / rx) ** 2 + ((y - h / 2) / ry) ** 2;
      const k = Math.floor(peak * Math.exp(-(d ** power)) * steps + bayer(x, y)) / steps;
      if (k > 0) art.px[y * w + x] = ((Math.min(1, k) * 255) << 24 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return art.canvas();
}

/* ── the sky ────────────────────────────────────────────────────── */

function paintSky() {
  const SKY = ramp('#5f4c8a', '#7a5389', '#985c86', '#b76680', '#d27578', '#e6886c', '#f39e60', '#f9b558', '#fdcb5c', '#ffdd72', '#ffeb98', '#fff5c4', '#fffbe6');
  const sky = new Art();
  sky.shade(SKY, (x, y) => {
    const d = Math.hypot((x - SUN.x) / 2.1, y - SUN.y);
    const glow = Math.exp(-((d / 62) ** 1.2));
    const wide = Math.exp(-((d / 150) ** 2));
    return clamp(0.02 + (y / SEA) * 0.26 + wide * 0.34 + glow * 0.3);
  }, 0.95, [0, 0, W, SEA + 2]);
  // The sun itself: white at the heart, a ring of hot gold, and the bottom just thinning.
  sky.shade(ramp('#ff9a3c', '#ffb03e', '#ffc84a', '#ffdf6a', '#ffef9c'), (x, y) => {
    const d = Math.hypot(x - SUN.x, y - SUN.y) - SUN.r;
    return d > 0 && d < 7 ? clamp(1 - d / 7) : -1;
  }, 0.8, [SUN.x - 26, SUN.y - 26, SUN.x + 26, SUN.y + 26]);
  sky.disc(SUN.x, SUN.y, SUN.r, rgba('#fff4b4'));
  sky.disc(SUN.x, SUN.y, SUN.r - 2, rgba('#fffbdc'));
  sky.disc(SUN.x - 1, SUN.y - 1, SUN.r - 5, rgba('#ffffff'));
  return sky;
}

/** Long clouds, joined at the seam: rose on top and burning gold along the underside. */
function paintClouds(seed, h, band, reach, cut, y0Scale, tones) {
  const CLOUD = ramp(...tones);
  const n = noise2(seed, 16);
  const art = new Art(960, h);
  const field = (x, y) => fbm2(n, x / 60, y / y0Scale, 4);
  for (let y = 0; y < h; y += 1) {
    const off = (y - band) / reach;
    const need = cut + off * off * 0.2;
    for (let x = 0; x < 960; x += 1) {
      const d = field(x, y);
      if (d < need) continue;
      const rim = d - field(x, y + 2.4);
      const v = 0.14 + (d - need) * 1.5 + clamp(rim * 7) * 0.9 - clamp(-rim * 6) * 0.08;
      art.tone(x, y, CLOUD, clamp(v), 0.72);
    }
  }
  return art;
}

/** Light fanning out of the sun, thin and broken. */
function paintRays(seed) {
  const n = noise1(seed, 64);
  const art = new Art(356, SEA);
  const [r, g, b] = rgbOf('#ffe9a8');
  for (let y = 0; y < SEA; y += 1) {
    for (let x = 0; x < 356; x += 1) {
      const dx = x - SUN.x;
      const dy = y - SUN.y;
      const dist = Math.hypot(dx, dy);
      if (dist < SUN.r + 3 || dist > 238) continue;
      const a = ((Math.atan2(dy, dx) + Math.PI) / TAU) * 64;
      const blade = clamp((n(a) - 0.56) * 5);
      if (blade <= 0) continue;
      const k = Math.floor(blade * (1 - dist / 238) ** 1.4 * 0.3 * 10 + bayer(x, y)) / 10;
      if (k > 0) art.px[y * 356 + x] = ((k * 255) << 24 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return art.canvas();
}

/* ── the town ───────────────────────────────────────────────────── */

const WALLS = [
  ramp('#8d6584', '#c08f86', '#eebf92', '#fbdcab', '#fff0c8'),
  ramp('#85597a', '#b47a72', '#e3a366', '#f5c278', '#fde09c'),
  ramp('#8a5a7c', '#bc7a80', '#e59a88', '#f6b89e', '#fdd6b8'),
  ramp('#8f6c8c', '#c49c98', '#f2cfae', '#fde9c8', '#fff8e4'),
];
const ROOF = ramp('#6e3f58', '#97494e', '#c25c44', '#e27a48', '#f59c5c');
const PANE = rgba('#5b3f63');
const LEAF = ramp('#2f3a4e', '#3c4a4a', '#566242', '#7d8344', '#b8a850');

/** The hill's skyline: climbing from the shore, a top two thirds of the way along, down to the bluff. */
function hillTop(n, x) {
  const u = clamp((x - 182) / 240);
  return 134 - 96 * Math.sin(Math.PI * u ** 1.12) ** 0.82 + (fbm1(n, x / 18, 3) - 0.5) * 9;
}

function cypress(art, x, by, tall) {
  for (let i = 0; i < tall; i += 1) {
    const k = i / tall;
    const half = Math.round(Math.sin(k * Math.PI * 0.9 + 0.1) ** 0.7 * 2.2);
    for (let dx = -half; dx <= half; dx += 1) art.put(x + dx, by - i, dx === -half ? LEAF[3] : dx < 0 ? LEAF[1] : LEAF[0]);
  }
}

function olive(art, rand, x, y, r) {
  for (let i = 0; i < 9; i += 1) {
    const a = rand() * TAU;
    art.disc(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.5, r * 0.55, LEAF[1]);
  }
  for (let i = 0; i < 6; i += 1) {
    const a = Math.PI + rand() * 1.6 - 0.8;
    art.disc(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.45 - 1, r * 0.3, LEAF[3]);
  }
}

/** A palm, its fronds lit along their sunward side. */
function palm(art, rand, x, base, tall, lean = 3) {
  const TRUNK = [rgba('#4a3458'), rgba('#7e5a58'), rgba('#c79a68')];
  let cx = x;
  let cy = base;
  for (let i = 0; i <= tall; i += 1) {
    cx = x + Math.sin((i / tall) * 1.4) * lean;
    cy = base - i;
    art.put(Math.round(cx), cy, TRUNK[1]);
    art.put(Math.round(cx) - 1, cy, TRUNK[2]);
    if (i % 3 === 0) art.put(Math.round(cx), cy, TRUNK[0]);
  }
  const fronds = 8;
  for (let f = 0; f < fronds; f += 1) {
    const dir = (f / (fronds - 1)) * Math.PI;
    const dx = -Math.cos(dir);
    const dy = -Math.sin(dir);
    const len = tall * (0.42 + rand() * 0.14);
    for (let k = 0; k < len; k += 0.7) {
      const px = cx + dx * k;
      const py = cy + dy * k * 0.7 + (k * k) * 0.055;
      art.put(Math.round(px), Math.round(py), dx < 0 ? LEAF[3] : LEAF[1]);
      if (k > 2) art.put(Math.round(px), Math.round(py) + 1 + (Math.floor(k) % 2), dx < 0 ? LEAF[2] : LEAF[0]);
    }
  }
  art.disc(cx, cy, 1.3, LEAF[0]);
}

function paintLand(rand) {
  const art = new Art();
  const windows = [];
  // Far land, lost in the light, low on the horizon.
  const HAZE = ramp('#b57a8a', '#ca8c86', '#de9f7e', '#f0b878', '#fbd088');
  const far = noise1(6601, 128);
  for (let x = 0; x < 240; x += 1) {
    const near = Math.abs(x - SUN.x) / 130;
    const top = SEA - (x < 70 ? 7 : x > 150 ? 13 : 2) * (0.4 + fbm1(far, x / 16, 3)) - (x > 150 ? (x - 150) * 0.06 : 0);
    for (let y = Math.round(top); y < SEA; y += 1) art.tone(x, y, HAZE, clamp(1 - near * 0.8 - (y - top) * 0.02), 0.8);
  }

  // The hill: dry ground and terraces, gold where it faces the sun.
  const hillN = noise1(6602, 128);
  const ground = noise2(6603, 64);
  const GROUND = ramp('#4d4468', '#635070', '#7d5f6e', '#96705f', '#a98455', '#bb9a55', '#d2b464', '#e9cf7e');
  for (let x = 176; x < 424; x += 1) {
    const top = hillTop(hillN, x);
    const slope = hillTop(hillN, x + 5) - hillTop(hillN, x - 5);
    for (let y = Math.round(top); y < QUAY; y += 1) {
      const v = 0.5 - slope * 0.035 + (fbm2(ground, x / 5, y / 3, 3) - 0.5) * 0.7 - ((y - top) / 200);
      art.tone(x, y, GROUND, clamp(v), 0.85);
    }
    // A rim of light along the skyline.
    art.put(x, Math.round(top), rgba(slope < 0 ? '#ffe9a0' : '#a98470'));
  }

  // Terraces of houses, the top ones first so the lower ones stand in front.
  const STONE = ramp('#6a4f70', '#94707a', '#c49a80', '#e6c08c', '#f8dfa8');
  const house = (x, by, w, h, family, roofed = true) => {
    const walls = WALLS[family];
    const top = by - h;
    const sideW = Math.max(2, Math.round(w * 0.24));
    for (let y = top; y < by; y += 1) {
      for (let i = 0; i < w; i += 1) {
        const side = i >= w - sideW;
        const v = side ? 0.14 : 0.68 + (1 - i / w) * 0.3 - ((y - top) / h) * 0.12;
        art.tone(x + i, y, walls, clamp(v), 0.55);
      }
    }
    if (roofed) {
      const rise = Math.min(4, Math.round(h * 0.34));
      for (let k = 0; k < rise; k += 1) {
        for (let i = -1 + k; i <= w - k; i += 1) {
          const side = i >= w - sideW;
          art.tone(x + i, top - 1 - k, ROOF, clamp((side ? 0.22 : 0.62) + (1 - i / w) * 0.2 + ((i + k * 2) % 3 === 0 ? -0.12 : 0)), 0.45);
        }
      }
      art.rect(x - 1, top - 1, w + 2, 1, ROOF[0]);
    }
    // Windows in rows, shuttered and dark until somebody comes home.
    for (let wy = top + 2; wy < by - 2; wy += 4) {
      for (let wx = x + 2; wx < x + w - sideW - 1; wx += 3 + (w > 15 ? 1 : 0)) {
        art.rect(wx, wy, 1, 2, PANE);
        // Those facing the sun throw it back.
        if (rand() < 0.06) art.rect(wx, wy, 1, 2, rgba('#fff6c0'));
        else if (rand() < 0.62) windows.push({ x: wx, y: wy, h: 2, w: 1, period: 170 + rand() * 260, phase: rand(), duty: 0.55 + rand() * 0.4 });
      }
    }
  };
  for (let by = 48; by <= 124; by += 10) {
    let x = 180 + Math.floor(rand() * 6);
    while (x < 420) {
      const w = 9 + Math.floor(rand() * 13);
      const h = 7 + Math.floor(rand() * 7);
      const top = hillTop(hillN, x + w / 2);
      if (by - h - 3 > top && by - 2 > hillTop(hillN, x) && by - 2 > hillTop(hillN, x + w)) {
        const r = rand();
        if (r < 0.1) cypress(art, x + 3, by, 12 + Math.floor(rand() * 7));
        else if (r < 0.19) olive(art, rand, x + 4, by - 4, 4 + rand() * 2);
        else house(x, by, w, h, Math.floor(rand() * WALLS.length));
      }
      x += w + (rand() < 0.16 ? 4 + Math.floor(rand() * 5) : 0);
    }
    // The terrace wall under each row.
    for (let i = 176; i < 424; i += 1) {
      if (by + 1 > hillTop(hillN, i)) {
        art.put(i, by, STONE[3]);
        art.put(i, by + 1, STONE[1]);
      }
    }
  }

  // At the top, a bell tower and a gold dome.
  const crown = { x: 336, y: Math.round(hillTop(hillN, 336)) + 8 };
  house(crown.x - 22, crown.y + 6, 30, 13, 3);
  const CAMP = WALLS[3];
  for (let y = crown.y - 30; y < crown.y + 6; y += 1) {
    for (let i = 0; i < 9; i += 1) art.tone(crown.x + 12 + i, y, CAMP, clamp(i > 6 ? 0.14 : 0.92 - i * 0.05), 0.5);
  }
  art.rect(crown.x + 11, crown.y - 19, 11, 1, CAMP[1]);
  art.rect(crown.x + 11, crown.y - 8, 11, 1, CAMP[1]);
  art.rect(crown.x + 14, crown.y - 28, 3, 7, rgba('#6a4a6a'));
  art.poly([[crown.x + 11, crown.y - 30], [crown.x + 16.5, crown.y - 40], [crown.x + 22, crown.y - 30]], ROOF[2]);
  art.line(crown.x + 11, crown.y - 30, crown.x + 16, crown.y - 40, ROOF[4]);
  art.rect(crown.x + 16, crown.y - 44, 1, 4, rgba('#ffe89a'));
  const DOME = ramp('#8a5a48', '#bd8240', '#e8aa3e', '#fccf5e', '#fff0a4');
  art.shade(DOME, (x, y) => {
    const dx = (x - (crown.x - 8)) / 11;
    const dy = (y - (crown.y - 7)) / 11;
    if (dx * dx + dy * dy > 1 || y > crown.y - 6) return -1;
    return clamp(0.56 - dx * 0.56 - dy * 0.3);
  }, 0.6, [crown.x - 20, crown.y - 20, crown.x + 4, crown.y - 5]);
  art.rect(crown.x - 8, crown.y - 22, 1, 4, rgba('#ffe89a'));

  // The grand hotel on the lowest terraces: long, arched, every floor a balcony.
  const hotel = { x: 224, w: 78, top: 92, by: 124 };
  for (let y = hotel.top; y < hotel.by; y += 1) {
    for (let i = 0; i < hotel.w; i += 1) {
      const side = i >= hotel.w - 6;
      art.tone(hotel.x + i, y, WALLS[3], clamp(side ? 0.16 : 0.84 - (i / hotel.w) * 0.16 - (y % 8 === 7 ? 0.28 : 0)), 0.5);
    }
  }
  for (let i = -2; i < hotel.w + 2; i += 1) {
    art.tone(hotel.x + i, hotel.top - 1, ROOF, 0.7, 0.3);
    art.put(hotel.x + i, hotel.top - 2, ROOF[3]);
    if (i % 4 === 0) art.put(hotel.x + i, hotel.top, rgba('#a97a7a'));
  }
  art.poly([[hotel.x + 28, hotel.top - 1], [hotel.x + 39, hotel.top - 9], [hotel.x + 50, hotel.top - 1]], ROOF[2]);
  art.line(hotel.x + 28, hotel.top - 1, hotel.x + 39, hotel.top - 9, ROOF[4]);
  art.rect(hotel.x + 39, hotel.top - 15, 1, 6, rgba('#7a5a6a'));
  art.rect(hotel.x + 40, hotel.top - 15, 4, 2, rgba('#cf4a4a'));
  for (let floor = 0; floor < 4; floor += 1) {
    const y = hotel.top + 2 + floor * 8;
    for (let wx = hotel.x + 3; wx < hotel.x + hotel.w - 9; wx += 5) {
      art.rect(wx, y, 3, 5, PANE);
      art.put(wx, y, rgba('#fbdcab'));
      art.put(wx + 2, y, rgba('#fbdcab'));
      if (rand() < 0.04) art.rect(wx, y + 1, 3, 4, rgba('#fff6c0'));
      else windows.push({ x: wx, y: y + 1, h: 4, w: 3, period: 150 + rand() * 300, phase: rand(), duty: 0.6 + rand() * 0.36 });
    }
    // A rail along each floor, and every other bay a stripe of awning.
    art.rect(hotel.x + 1, y + 5, hotel.w - 7, 1, rgba('#b58a7c'));
    if (floor === 3) for (let wx = hotel.x + 3; wx < hotel.x + hotel.w - 9; wx += 10) art.rect(wx - 1, y - 1, 5, 2, rgba(wx % 20 < 10 ? '#d9583e' : '#fff0d0'));
  }

  // The sea wall, with arches for the boats and lamps along the top.
  const wallTop = 124;
  for (let y = wallTop; y < QUAY; y += 1) {
    for (let x = 180; x < 418; x += 1) {
      const row = Math.floor((y - wallTop) / 3);
      const joint = (y - wallTop) % 3 === 2 || (x + row * 5) % 11 === 10;
      art.tone(x, y, STONE, clamp(0.72 - ((y - wallTop) / 12) * 0.32 - (joint ? 0.2 : 0) - ((x - 180) / 240) * 0.2), 0.55);
    }
  }
  for (let x = 180; x < 418; x += 1) {
    art.put(x, wallTop, STONE[4]);
    art.put(x, wallTop + 1, STONE[3]);
  }
  for (let x = 196; x < 410; x += 34) {
    art.shade(ramp('#2e2448', '#463354', '#6a4656', '#a2684e'), (px, py) => {
      const dx = (px - x - 7) / 7;
      const dy = (py - 134) / 8;
      if (dx * dx + dy * dy > 1) return -1;
      return clamp(0.15 + (py - 126) * 0.05);
    }, 0.6, [x, 126, x + 15, QUAY]);
  }
  const quayLamps = [];
  for (let x = 186; x < 416; x += 16) {
    art.rect(x, 118, 1, 6, rgba('#4f3a58'));
    quayLamps.push({ x, y: 117, phase: rand() });
  }
  for (const [x, tall] of [[206, 25], [252, 22], [312, 26], [356, 23], [396, 25]]) palm(art, rand, x, 124, tall);

  // A rocky beach where the wall gives out.
  const ROCK = ramp('#42365e', '#5a4268', '#7a5270', '#9e666e', '#c6826a', '#e8a66a', '#f9cc84');
  const rockN = noise2(6604, 64);
  for (let x = 168; x < 184; x += 1) {
    const top = 136 - (x - 168) * 0.7 - (fbm2(rockN, x / 3, 2, 2) - 0.5) * 3;
    for (let y = Math.round(top); y < QUAY + 2; y += 1) art.tone(x, y, ROCK, clamp(0.6 - (y - top) * 0.05 + (fbm2(rockN, x / 3, y / 3, 2) - 0.5)), 0.6);
  }

  // The headland: hard-faced rock, a cap of grass, the keeper's cottage, the tower.
  const bluff = (x) => {
    if (x < 412) return Infinity;
    const u = smooth(clamp((x - 412) / 28));
    return 148 - 60 * u + (fbm1(hillN, x / 7 + 40, 3) - 0.5) * 7;
  };
  for (let x = 410; x < W; x += 1) {
    const top = bluff(x);
    if (top === Infinity) continue;
    const slope = bluff(x + 3) - bluff(x - 3 < 412 ? 412 : x - 3);
    for (let y = Math.round(top); y < 152; y += 1) {
      const raw = fbm2(rockN, x / 8, y / 6, 3);
      const facet = Math.floor(raw * 7) / 7;
      const lit = 0.56 - ((x - 412) / 110) * 0.2 - slope * 0.03 + (facet - 0.5) * 1.2 - ((y - top) / 170);
      if (y - top < 3 + fbm1(hillN, x / 4, 2) * 3) art.tone(x, y, GROUND, clamp(0.72 - (x - 430) * 0.008 + (raw - 0.5)), 0.7);
      else art.tone(x, y, ROCK, clamp(lit), 0.5);
    }
  }
  // The cottage, with a chimney and a lit door.
  house(459, 92, 16, 10, 3);
  art.rect(470, 76, 2, 5, rgba('#7a5a6a'));
  art.rect(462, 87, 2, 5, rgba('#6a4a6a'));
  windows.push({ x: 462, y: 87, h: 5, w: 2, period: 240, phase: 0.1, duty: 0.9 });
  // A low wall along the cliff edge.
  for (let x = 414; x < 438; x += 1) {
    art.put(x, Math.round(bluff(x)) - 1, rgba('#d2b090'));
    if (x % 5 === 0) art.put(x, Math.round(bluff(x)) - 2, rgba('#f4d8a8'));
  }

  // The tower: coursed stone, narrowing as it goes up, the sun on its left.
  const TOWER = ramp('#5e4a78', '#7f5f80', '#a97a80', '#d39c84', '#efc08c', '#fbdca4', '#fff2c8');
  const towerTop = 37;
  const towerBase = 92;
  for (let y = towerTop; y < towerBase; y += 1) {
    const half = mix(5, 9, (y - towerTop) / (towerBase - towerTop));
    const row = Math.floor((y - towerTop) / 3);
    for (let x = Math.round(BEACON.x - half); x <= BEACON.x + half; x += 1) {
      const k = (x - BEACON.x + half) / (half * 2);
      const joint = (y - towerTop) % 3 === 2 || (x + row * 3) % 6 === 5;
      art.tone(x, y, TOWER, clamp(1.02 - k * 0.98 - (joint ? 0.1 : 0)), 0.5);
    }
  }
  // Narrow windows, a door, a band of dressed stone.
  for (const y of [46, 60, 74]) art.rect(BEACON.x - 1, y, 2, 4, rgba('#4a3a68'));
  art.rect(BEACON.x - 3, 84, 5, 8, rgba('#3e2f5c'));
  art.rect(BEACON.x - 2, 85, 3, 7, rgba('#6a3f4a'));
  for (let x = BEACON.x - 8; x <= BEACON.x + 8; x += 1) art.put(x, 66, x < BEACON.x ? TOWER[5] : TOWER[1]);
  // The gallery and its rail.
  art.rect(BEACON.x - 8, 35, 17, 2, rgba('#3f3058'));
  art.rect(BEACON.x - 8, 35, 9, 1, rgba('#f4d8a8'));
  art.rect(BEACON.x - 8, 31, 17, 1, rgba('#3f3058'));
  for (let x = BEACON.x - 8; x <= BEACON.x + 8; x += 2) art.rect(x, 31, 1, 4, rgba('#3f3058'));
  // The lantern: glass in a dark frame, under a gold cap.
  art.rect(BEACON.x - 4, 22, 9, 10, rgba('#2e2448'));
  art.rect(BEACON.x - 3, 23, 7, 9, rgba('#ffe9a8'));
  art.rect(BEACON.x - 1, 23, 3, 9, rgba('#fffdf0'));
  art.rect(BEACON.x - 2, 23, 1, 9, rgba('#c79a58'));
  art.rect(BEACON.x + 2, 23, 1, 9, rgba('#c79a58'));
  art.poly([[BEACON.x - 6, 22], [BEACON.x, 15], [BEACON.x + 7, 22]], rgba('#c88a30'));
  art.line(BEACON.x - 6, 21, BEACON.x, 15, rgba('#ffe89a'));
  art.rect(BEACON.x, 11, 1, 4, rgba('#ffe89a'));

  // The harbour mole: a low stone arm out from the headland, a small green light at the end.
  for (let x = 348; x < 418; x += 1) {
    for (let y = 148; y < 154; y += 1) {
      const row = y < 150 ? 0.82 : 0.42 - (y - 150) * 0.06;
      art.tone(x, y, STONE, clamp(row - ((x - 348) / 120) * 0.2 - ((x + (y >> 1) * 3) % 9 === 8 ? 0.18 : 0)), 0.5);
    }
  }
  art.rect(349, 139, 2, 9, rgba('#4f3a58'));
  art.rect(348, 137, 4, 2, rgba('#2e3a4a'));
  return { art, windows, quayLamps };
}

/* ── boats ──────────────────────────────────────────────────────── */

const HULL_WHITE = ['#8a7498', '#b8989f', '#e3c2a8', '#f8dfbc', '#fff3d8', '#fffdf4'];
const HULL_DARK = ['#3a2c50', '#4c3858', '#62465e', '#805866', '#a87060', '#e0a060'];

/** A sailing yacht in five leans, each with the reflection that goes with it. */
function yacht({ length: L, mast: M, dir, tones = HULL_WHITE, cover = '#23385e' }) {
  const hullH = Math.max(4, Math.round(L * 0.13));
  const w = L + 16;
  const h = M + hullH + 9;
  const waterline = h - 1;
  const deck = waterline - hullH;
  const HULL = ramp(...tones);
  const lit = rgba(tones[tones.length - 1]);
  const mid = rgba(tones[2]);
  const shade = rgba(tones[0]);
  const coverC = rgba(cover);
  const frames = [-2, -1, 0, 1, 2].map((lean) => {
    const art = new Art(w, h);
    const X = (u) => Math.round(8 + (dir > 0 ? u * L : L - u * L));
    const pitch = (u) => Math.round(lean * (u - 0.5) * 0.9);
    // The hull: a raked bow, a sheer line, a clean stern.
    const profile = [[0, deck - 2], [0.18, deck - 1], [0.5, deck], [1, deck - 1], [0.985, deck + 2], [0.95, waterline], [0.14, waterline], [0.05, deck + 2]];
    art.poly(profile.map(([u, y]) => [X(u), y + pitch(u)]), (x, y) => {
      const k = (y - deck) / hullH;
      const along2 = (x - 8) / L;
      art.tone(x, y, HULL, clamp(0.94 - k * 0.42 - along2 * 0.3), 0.5);
    });
    for (let u = 0; u <= 1; u += 1 / L) {
      const y = deck - 1 + Math.round(Math.abs(u - 0.45) * 1.6) + pitch(u) - 1;
      art.put(X(u), y + 1, lit);
    }
    // A stripe at the waterline, in gold over navy.
    for (let u = 0.1; u <= 0.96; u += 1 / L) {
      art.put(X(u), waterline, shade);
      art.put(X(u), waterline - 1, coverC);
      art.put(X(u), waterline - 2, rgba('#e8b850'));
    }
    // The coachroof and its dark ports.
    const roofH = Math.max(2, Math.round(hullH * 0.6));
    art.poly([[X(0.3), deck - 1 + pitch(0.3)], [X(0.36), deck - 1 - roofH + pitch(0.36)], [X(0.62), deck - 1 - roofH + pitch(0.62)], [X(0.66), deck - 1 + pitch(0.66)]], lit);
    for (let u = 0.38; u < 0.6; u += 0.075) art.rect(X(u), deck - roofH + pitch(u), Math.max(1, Math.round(L * 0.03)), 1, rgba('#4a4468'));
    // Rails round the cockpit.
    for (let u = 0.1; u < 1; u += 0.11) art.rect(X(u), deck - 4 + pitch(u), 1, 3, mid);
    for (let u = 0.1; u < 0.98; u += 1 / L) art.put(X(u), deck - 4 + pitch(u), mid);
    // The mast, which is what moves the most.
    const foot = [X(0.38), deck - 1 - roofH];
    const top = [X(0.38) + lean * (M / 58), deck - M];
    const steps = Math.abs(foot[1] - top[1]);
    for (let i = 0; i <= steps; i += 1) {
      const k = i / steps;
      const mx = Math.round(mix(foot[0], top[0], k));
      art.put(mx, foot[1] - i, lit);
      if (L > 40) art.put(mx + 1, foot[1] - i, shade);
    }
    const onMast = (k) => [Math.round(mix(foot[0], top[0], k)), Math.round(mix(foot[1], top[1], k))];
    // Spreaders, stays, and a thin line of light where each one catches the sun.
    for (const k of [0.45, 0.72]) {
      const [sx, sy] = onMast(k);
      art.rect(sx - 3, sy, 7, 1, mid);
    }
    const stay = (x0, y0, x1, y1) => {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = 0; i <= n; i += 1) if (i % 2 === 0) art.put(Math.round(mix(x0, x1, i / n)), Math.round(mix(y0, y1, i / n)), mid);
    };
    stay(top[0], top[1], X(0.01), deck - 3 + pitch(0));
    stay(top[0], top[1], X(0.98), deck - 2 + pitch(1));
    // The boom, with its sail rolled on it.
    const boomY = deck - 7 - roofH;
    const boomEnd = X(0.82);
    art.line(foot[0], boomY, boomEnd, boomY + 1, mid);
    const a = Math.min(foot[0], boomEnd);
    const span = Math.abs(foot[0] - boomEnd);
    art.rect(a + 1, boomY - 1, Math.max(2, span - Math.round(span * 0.12)), L > 34 ? 2 : 1, coverC);
    return { art, top, lean };
  });
  return {
    w,
    h,
    frames: frames.map(({ art, top }) => {
      // A reflection is the sprite upside down, dimmed towards the water's own colour.
      const reflect = new Uint32Array(w * h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const p = art.px[(h - 1 - y) * w + x];
          if (p >>> 24) reflect[y * w + x] = blend(p, rgba('#7a6a96'), 0.3);
        }
      }
      return { canvas: art.canvas(), reflect, top };
    }),
  };
}

/** The big one: a long white motor yacht with four decks and tinted glass. */
function superyacht(L) {
  const w = L + 12;
  const h = 44;
  const waterline = h - 1;
  const HULL = ramp(...HULL_WHITE);
  const glass = rgba('#3c4274');
  const glint = rgba('#ffcf70');
  const frames = [-1, 0, 1].map((lean) => {
    const art = new Art(w, h);
    const X = (u) => Math.round(6 + u * L);
    const p = (u) => Math.round(lean * (u - 0.5));
    const paint = (x, y) => art.tone(x, y, HULL, clamp(0.96 - ((x - 6) / L) * 0.42 - ((y - 16) / 34) * 0.3), 0.5);
    // Main hull, raked at the bow.
    art.poly([[X(0), 24 + p(0)], [X(0.16), 26 + p(0.16)], [X(1), 28 + p(1)], [X(0.99), 36], [X(0.95), waterline], [X(0.12), waterline], [X(0.05), 32]], paint);
    // The decks, stepping back.
    art.poly([[X(0.2), 26 + p(0.2)], [X(0.28), 18 + p(0.28)], [X(0.93), 19 + p(0.93)], [X(0.96), 28 + p(0.96)]], paint);
    art.poly([[X(0.32), 18 + p(0.32)], [X(0.39), 11 + p(0.39)], [X(0.8), 12 + p(0.8)], [X(0.84), 19 + p(0.84)]], paint);
    art.poly([[X(0.44), 11 + p(0.44)], [X(0.49), 6 + p(0.49)], [X(0.68), 7 + p(0.68)], [X(0.72), 12 + p(0.72)]], paint);
    // Long ribbons of glass, each catching the low sun at its near end.
    const ribbon = (u0, u1, y, tall) => {
      for (let i = X(u0); i < X(u1); i += 1) {
        const u = (i - 6) / L;
        art.rect(i, y + p(u), 1, tall, glass);
        if (i < X(u0) + 5) art.rect(i, y + p(u), 1, 1, glint);
      }
    };
    ribbon(0.3, 0.9, 22, 3);
    ribbon(0.42, 0.78, 14, 2);
    ribbon(0.52, 0.68, 8, 2);
    ribbon(0.24, 0.92, 31, 1);
    // Rails and gold.
    for (let i = X(0.04); i < X(1); i += 1) art.put(i, 24 + Math.round(((i - 6) / L) * 3) + p((i - 6) / L), rgba('#fffef4'));
    for (let i = X(0.1); i < X(0.95); i += 1) {
      art.put(i, waterline - 1, rgba('#e8b850'));
      art.put(i, waterline, rgba('#2c3460'));
    }
    // A radar arch, a dome, a slim mast with a flag at the stern.
    art.rect(X(0.56), 2 + p(0.56), 1, 5, rgba('#fff6e4'));
    art.rect(X(0.62), 3 + p(0.62), 1, 4, rgba('#fff6e4'));
    art.rect(X(0.56), 2 + p(0.56), Math.round(L * 0.06), 1, rgba('#d9c0b0'));
    art.disc(X(0.59), 2 + p(0.59), 1.6, rgba('#fffdf0'));
    art.rect(X(0.985), 20 + p(1), 1, 8, rgba('#8a7498'));
    art.rect(X(0.985) + 1, 20 + p(1), 3 + lean, 2, rgba('#cf4a4a'));
    return art;
  });
  return {
    w,
    h,
    frames: frames.map((art) => {
      const reflect = new Uint32Array(w * h);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const c = art.px[(h - 1 - y) * w + x];
          if (c >>> 24) reflect[y * w + x] = blend(c, rgba('#7a6a96'), 0.28);
        }
      }
      return { canvas: art.canvas(), reflect, top: [0, 0] };
    }),
  };
}

/* ── the sea ────────────────────────────────────────────────────── */

/**
 * The sea is worked out per pixel: a base tone and a place on the way from cool to
 * gold are fixed, and two sliding sheets of waves push the tone up and down. Where
 * land stands behind, the wave troughs show its reflection instead.
 */
function paintSea(landPx) {
  const COOL = ['#2f3f6e', '#394a78', '#455480', '#565e88', '#6a6a8e', '#7f748f', '#96808e', '#ae8b8a', '#c59784', '#d9a67c', '#e9b777', '#f3c87a', '#fad98a', '#fee8a6', '#fff3c8', '#fffbe6'].map(rgba);
  const GOLD = ['#8a5a30', '#a06a30', '#b97a30', '#d08e32', '#e3a136', '#f0b33c', '#f8c448', '#fcd35a', '#fee072', '#ffe98e', '#fff0a8', '#fff5c0', '#fff9d6', '#fffce8', '#ffffff', '#ffffff'].map(rgba);
  const lut = new Uint32Array(8 * 16);
  for (let z = 0; z < 8; z += 1) for (let i = 0; i < 16; i += 1) lut[z * 16 + i] = blend(COOL[i], GOLD[i], z / 7);

  const size = W * ROWS;
  const base = new Int16Array(size);
  const zone = new Uint8Array(size);
  const amp = new Uint8Array(size);
  const mask = new Uint8Array(size);
  const refl = new Uint32Array(size);
  for (let dy = 0; dy < ROWS; dy += 1) {
    const d = dy / ROWS;
    const y = SEA + dy;
    const width = 9 + 92 * d ** 0.9;
    for (let x = 0; x < W; x += 1) {
      const i = dy * W + x;
      const path = Math.exp(-(((x - SUN.x) / width) ** 2));
      const warm = clamp(1 - Math.abs(x - SUN.x) / 300);
      const z = clamp(Math.max(path ** 0.7, warm * warm * 0.62 * (1 - d * 0.55)));
      zone[i] = Math.round(z * 7) * 16;
      const nearSky = Math.exp(-dy / 15);
      const tone = 3.2 + nearSky * 6.2 + path * (3.8 - d * 0.8) + warm * 2 - d * 1.6;
      base[i] = Math.round(tone * 16);
      amp[i] = Math.round(clamp((0.14 + path * 0.86) * (0.42 + 0.58 * Math.min(1, d * 2.6 + path))) * 255);
      // The land above, turned over.
      let shore = -1;
      if (x >= 168 && x < 348) shore = QUAY;
      else if (x >= 348 && x < 418) shore = 154;
      else if (x >= 418) shore = 152;
      if (shore > 0 && y >= shore) {
        const my = shore - (y - shore) * 1.08 - 1;
        if (my >= 0) {
          const p = landPx[Math.round(my) * W + x];
          if (p >>> 24) {
            const under = blend(p, COOL[4], 0.5);
            refl[i] = under;
            mask[i] = Math.round(clamp(1.08 - (y - shore) / 88) * 255);
          }
        }
      }
    }
  }
  const sheet = (seed) => {
    const n = noise2(seed, 32);
    const out = new Uint8Array(512 * 128);
    for (let y = 0; y < 128; y += 1) {
      for (let x = 0; x < 512; x += 1) out[(y << 9) | x] = Math.round(clamp((fbm2(n, x / 8, y / 2, 2) - 0.5) * 3.2 + 0.5) * 255);
    }
    return out;
  };
  const scaleX = new Int32Array(ROWS);
  const rowY = new Int32Array(ROWS);
  for (let dy = 0; dy < ROWS; dy += 1) {
    const d = dy / ROWS;
    scaleX[dy] = Math.round(256 / (0.34 + 0.86 * d));
    rowY[dy] = Math.floor(96 * Math.log(1 + d * 4));
  }
  const dither = Int32Array.from(BAYER, (v) => Math.floor(v * 16));
  const tremble = Int8Array.from({ length: 64 }, (_, i) => Math.round(Math.sin((i / 64) * TAU * 3) * 1.4 + Math.sin((i / 64) * TAU * 7) * 0.8));
  const frame = new ImageData(W, ROWS);
  return { lut, base, zone, amp, mask, refl, sheetA: sheet(6610), sheetB: sheet(6611), scaleX, rowY, dither, tremble, frame, out: new Uint32Array(frame.data.buffer) };
}

function drawSea(sea, t, moored) {
  const { lut, base, zone, amp, mask, refl, sheetA, sheetB, scaleX, rowY, dither, tremble, out } = sea;
  const slideA = along(t, 11, 512);
  const slideB = along(t, 7, 512);
  const riseA = along(t, 2, 128);
  const riseB = along(t, 3, 128);
  const step = Math.floor(t * 4);
  for (let dy = 0; dy < ROWS; dy += 1) {
    const fx = scaleX[dy];
    const ra = ((rowY[dy] + riseA) & 127) << 9;
    const rb = ((rowY[dy] + 165 - riseB) & 127) << 9;
    const wob = tremble[(dy * 3 + step) & 63];
    const row = dy * W;
    const bayerRow = (dy & 3) << 2;
    for (let x = 0; x < W; x += 1) {
      const tx = (x * fx) >> 8;
      const a = sheetA[ra | ((tx + slideA) & 511)];
      const i = row + x;
      if (mask[i] > a) {
        const sx = x + wob;
        out[i] = refl[row + (sx < 0 ? 0 : sx >= W ? W - 1 : sx)] || refl[i];
        continue;
      }
      const b = sheetB[rb | ((tx + 512 - slideB) & 511)];
      const tone = (base[i] + (((a + b - 255) * amp[i]) >> 8) + dither[bayerRow | (x & 3)]) >> 4;
      out[i] = lut[zone[i] + (tone < 0 ? 0 : tone > 15 ? 15 : tone)];
    }
  }
  // Every boat's reflection, broken more the further it is from the hull.
  for (const m of moored) {
    const f = m.boat.frames[m.index];
    const { w, h } = m.boat;
    const top = m.y + m.bob - SEA + 1;
    for (let r = 0; r < h; r += 1) {
      const dy = top + r;
      if (dy < 0 || dy >= ROWS) continue;
      const fade = (r / h) * 210;
      const wob = r > 3 ? tremble[(dy * 3 + step) & 63] : 0;
      for (let c = 0; c < w; c += 1) {
        const p = f.reflect[r * w + c];
        if (!p) continue;
        const x = m.x + c + wob;
        if (x < 0 || x >= W) continue;
        // Waves break it along their own crests, more so the further from the hull.
        const crest = sheetB[(((rowY[dy] + 165 - riseB) & 127) << 9) | ((((x * scaleX[dy]) >> 8) + 512 - slideB) & 511)];
        if (crest > 250 - fade) continue;
        out[dy * W + x] = p;
      }
    }
  }
}

/* ── small things ───────────────────────────────────────────────── */

/** The front of the picture: planks on the water, cleats, a lamp on a post. */
function paintDock(rand) {
  const art = new Art();
  const WOOD = ramp('#3a2c50', '#54395a', '#74495c', '#9a5f5a', '#c67e58', '#e6a260', '#f8c878');
  const plank = (x0, x1, y0, y1, along2) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const joint = along2 ? (y - y0) % 3 === 2 : (x - x0) % 4 === 3;
        art.tone(x, y, WOOD, clamp(0.72 - ((x - 240) / 400) * 0.34 - (joint ? 0.22 : 0) - (y - y0) * 0.004), 0.5);
      }
    }
  };
  // The walkway along the bottom, then its dark edge.
  plank(262, W, 254, H, false);
  for (let x = 262; x < W; x += 1) {
    art.put(x, 253, WOOD[6]);
    if (x % 37 === 0) art.rect(x, 255, 2, 2, rgba('#2e2448'));
  }
  // A finger running out between two berths, narrowing as it goes.
  for (let y = 214; y < 254; y += 1) {
    const k = (y - 214) / 40;
    const half = mix(2.5, 7, k);
    const cx = mix(372, 370, k);
    for (let x = Math.round(cx - half); x <= cx + half; x += 1) {
      art.tone(x, y, WOOD, clamp(0.76 - (x - cx + half) * 0.04 - (y % 3 === 2 ? 0.22 : 0)), 0.45);
    }
    art.put(Math.round(cx + half) + 1, y, WOOD[0]);
  }
  // Piles at the ends, bollards, a coil of rope.
  for (const [x, y, tall] of [[369, 203, 14], [376, 208, 12], [264, 240, 17], [362, 244, 11], [380, 242, 11]]) {
    art.rect(x, y, 3, tall, WOOD[1]);
    art.rect(x, y, 1, tall, WOOD[5]);
    art.rect(x - 1, y, 5, 1, WOOD[6]);
  }
  for (let i = 0; i < 3; i += 1) art.ellipse(300, 256 - i, 6 - i, 2, rgba(['#7a5a50', '#b89070', '#e8c898'][i]));
  art.rect(422, 244, 2, 12, rgba('#3a2c50'));
  art.rect(422, 244, 1, 12, rgba('#c67e58'));
  art.rect(420, 240, 6, 4, rgba('#fff0b0'));
  art.rect(420, 239, 6, 1, rgba('#3a2c50'));
  // A few things lying about, because somebody lives here.
  art.rect(446, 250, 8, 4, rgba('#f4d8a8'));
  art.rect(446, 250, 8, 1, rgba('#fff4d0'));
  art.rect(446, 253, 8, 1, rgba('#8a6050'));
  for (let i = 0; i < 12; i += 1) art.put(280 + Math.floor(rand() * 190), 258 + Math.floor(rand() * 10), rgba('#fbdc98'));
  return art;
}

function dotted(level, hex) {
  const art = new Art(4, 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) if (bayer(x, y) < level) art.put(x, y, rgba(hex));
  return newCanvas(1, 1).getContext('2d').createPattern(art.canvas(), 'repeat');
}

const BEAM_AT = [0.01, 0.13, 0.3, 0.5, 0.74, 1];
const BEAM_ALPHA = [0.6, 0.52, 0.46, 0.4, 0.32];

const goldenHarbor = {
  build() {
    const rand = seeded(6600);
    const sky = paintSky();
    const CLOUD_TONES = ['#7f5a8c', '#a0647f', '#c47676', '#e28f69', '#f4ad5c', '#fdcb60', '#ffe588', '#fff6c4'];
    const clouds = [
      paintClouds(6620, 64, 20, 22, 0.57, 7, CLOUD_TONES),
      paintClouds(6621, 76, 42, 20, 0.54, 5, CLOUD_TONES),
      paintClouds(6622, 40, 24, 12, 0.53, 3.4, ['#70508a', '#8c5a84', '#b26a7a', '#d9836c', '#f2a558', '#fdc85a', '#ffe68c', '#fff8d0']),
    ];
    const { art: land, windows, quayLamps } = paintLand(rand);
    const sea = paintSea(land.px);

    const sails = [
      yacht({ length: 30, mast: 42, dir: 1, cover: '#23385e' }),
      yacht({ length: 34, mast: 50, dir: -1, cover: '#6a2438' }),
      yacht({ length: 28, mast: 38, dir: -1, tones: HULL_DARK, cover: '#2a2038' }),
      yacht({ length: 52, mast: 74, dir: 1, cover: '#1e3058' }),
      yacht({ length: 60, mast: 88, dir: -1, cover: '#23385e' }),
      yacht({ length: 70, mast: 108, dir: 1, cover: '#6a2438' }),
      yacht({ length: 66, mast: 98, dir: -1, cover: '#1e3058' }),
    ];
    const big = superyacht(112);
    // Far to near, so the nearest stands in front.
    const berths = [
      { boat: sails[2], x: 92, y: 156 }, { boat: sails[0], x: 196, y: 152 }, { boat: sails[1], x: 246, y: 150 }, { boat: sails[0], x: 300, y: 153 },
      { boat: big, x: 334, y: 180 },
      { boat: sails[3], x: 186, y: 190 }, { boat: sails[4], x: 256, y: 198 },
      { boat: sails[5], x: 4, y: 226 }, { boat: sails[6], x: 288, y: 240 }, { boat: sails[5], x: 386, y: 238 },
    ].map((b) => ({ ...b, period: 5.5 + rand() * 4.5, phase: rand(), bobPeriod: 3.6 + rand() * 2.6 }));

    return {
      sky: sky.canvas(),
      clouds: clouds.map((c) => c.canvas()),
      rays: paintRays(6630),
      rays2: paintRays(6631),
      land: land.canvas(),
      sea,
      windows,
      quayLamps,
      berths,
      dock: paintDock(rand).canvas(),
      flare: glowSprite(60, 44, '#ff9e4a', 0.3, 16, 0.75),
      seaFlare: glowSprite(34, 7, '#ffd070', 0.4, 12),
      lampFlare: glowSprite(9, 9, '#fff4c8', 0.8, 10),
      beam: [0.8, 0.6, 0.42, 0.26, 0.13].map((level) => dotted(level, '#fff8dc')),
      sparkles: Array.from({ length: 90 }, () => {
        const d = rand() ** 1.2;
        const y = SEA + 2 + d * (ROWS - 4);
        const width = 9 + 92 * d ** 0.9;
        return { x: SUN.x + (rand() + rand() - 1) * width * 1.1, y, period: 1.4 + rand() * 2.6, phase: rand(), big: rand() < 0.25 + d * 0.3 };
      }),
      gulls: Array.from({ length: 9 }, (_, i) => ({ period: 34 + rand() * 60, phase: rand(), y: 18 + rand() * 90, dir: i % 3 ? 1 : -1, size: i < 3 ? 3 : i < 6 ? 2 : 1, beat: 2 + rand() * 1.4, bob: 7 + rand() * 9, sway: 3 + rand() * 6 })),
    };
  },

  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0, W, SEA + 1, 0, 0, W, SEA + 1);
    slide(ctx, s.clouds[0], along(t, 0.5, 960), 2);
    // Light through the cloud, trading between two fans so it seems to turn.
    ctx.globalCompositeOperation = 'lighter';
    const fade = Math.max(0, wave(t, 26));
    ctx.globalAlpha = fade;
    if (fade > 0.04) ctx.drawImage(s.rays, 0, 0);
    ctx.globalAlpha = 1 - fade;
    ctx.drawImage(s.rays2, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    slide(ctx, s.clouds[1], along(t, 0.8, 960), 26);
    slide(ctx, s.clouds[2], along(t, 1.3, 960), 88);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.86 + wave(t, 7) * 0.14;
    ctx.drawImage(s.flare, SUN.x - 120, SUN.y - 88);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Which lean every boat is at, then the sea with their reflections in it.
    for (const m of s.berths) {
      const n = m.boat.frames.length;
      m.index = Math.round(((wave(t, m.period, m.phase) + 1) / 2) * (n - 1));
      m.bob = Math.round(wave(t, m.bobPeriod, m.phase));
    }
    drawSea(s.sea, t, s.berths);
    ctx.putImageData(s.sea.frame, 0, SEA);

    ctx.drawImage(s.land, 0, 0, W, 156, 0, 0, W, 156);

    // A boat far out on the horizon, in no hurry.
    const far = (t / 340) % 1;
    const fx = Math.round(W * 0.42 - far * (W * 0.42 + 20));
    ctx.fillStyle = '#5a3f58';
    ctx.fillRect(fx, 126, 7, 1);
    ctx.fillRect(fx + 3, 120, 1, 6);
    ctx.fillRect(fx + 4, 121, 2, 4);
    ctx.fillStyle = '#ffe9a0';
    ctx.fillRect(fx + 1, 127, 6, 1);

    // The town, as people come home to it.
    ctx.fillStyle = '#ffd777';
    for (const w of s.windows) {
      if ((t / w.period + w.phase) % 1 < w.duty) ctx.fillRect(w.x, w.y, w.w, w.h);
    }
    for (const l of s.quayLamps) {
      ctx.fillStyle = wave(t, 5, l.phase) > 0.8 ? '#fff0b8' : '#ffdc8a';
      ctx.fillRect(l.x, l.y, 1, 1);
    }

    // The beam goes round; seen from here it stretches out and draws back on both sides.
    const turn = (t / 21) * TAU;
    const reach = Math.cos(turn);
    const facing = Math.abs(Math.sin(turn)) ** 10;
    if (Math.abs(reach) > 0.04) {
      const len = Math.abs(reach) ** 0.75 * 480;
      for (const side of [1, -1]) {
        const dir = side * Math.sign(reach);
        const piece = (from, to, fill, alpha) => {
          const a = len * from;
          const b = len * to;
          const halfA = 1 + a * 0.036;
          const halfB = 1 + b * 0.036;
          const drop = 0.035;
          ctx.fillStyle = fill;
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.moveTo(BEACON.x + dir * a, BEACON.y + a * drop - halfA);
          ctx.lineTo(BEACON.x + dir * b, BEACON.y + b * drop - halfB);
          ctx.lineTo(BEACON.x + dir * b, BEACON.y + b * drop + halfB);
          ctx.lineTo(BEACON.x + dir * a, BEACON.y + a * drop + halfA);
          ctx.closePath();
          ctx.fill();
        };
        for (let i = 0; i < s.beam.length; i += 1) {
          if (dir > 0 && BEACON.x + len * BEAM_AT[i] > W) break;
          piece(BEAM_AT[i], BEAM_AT[i + 1], s.beam[i], BEAM_ALPHA[i]);
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.4 + facing * 0.6;
    ctx.drawImage(s.lampFlare, BEACON.x - 18, BEACON.y - 18);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // The mole's little green light.
    ctx.fillStyle = (t % 5) < 1 ? '#8cffb0' : '#2e5a48';
    ctx.fillRect(349, 136, 2, 2);

    // A tender crossing the harbour, its wake opening behind it.
    const crossing = ((t + 58) % 96) / 48;
    if (crossing < 1) {
      const bx = Math.round(W + 30 - crossing * (W - 150));
      const by = 166;
      ctx.fillStyle = 'rgba(255,250,226,0.8)';
      for (let i = 1; i < 16; i += 1) {
        ctx.fillRect(bx + 8 + i * 2, by + 4 - Math.round(i * 0.22), 2, 1);
        ctx.fillRect(bx + 8 + i * 2, by + 4 + Math.round(i * 0.3), 2, 1);
      }
      ctx.fillStyle = '#fff6e4';
      ctx.fillRect(bx, by, 10, 3);
      ctx.fillRect(bx + 1, by + 3, 8, 1);
      ctx.fillStyle = '#23385e';
      ctx.fillRect(bx + 4, by - 3, 4, 3);
      ctx.fillStyle = '#c47a3a';
      ctx.fillRect(bx + 1, by + 4, 8, 1);
    }

    // The boats themselves, with water lapping along each hull.
    for (const m of s.berths) {
      const f = m.boat.frames[m.index];
      ctx.drawImage(f.canvas, m.x, m.y + m.bob - m.boat.h + 1);
      if (f.top[1]) {
        // A pennant at the masthead, flicking in what wind there is.
        const fl = (Math.floor(t * 5 + m.phase * 7) % 2) + 2;
        ctx.fillStyle = '#e8b850';
        ctx.fillRect(m.x + f.top[0] + 1, m.y + m.bob - m.boat.h + 1 + f.top[1], fl, 1);
        ctx.fillRect(m.x + f.top[0] + 1, m.y + m.bob - m.boat.h + 2 + f.top[1], fl - 1, 1);
      }
      const lap = (Math.floor(t * 2 + m.phase * 5) % 3);
      ctx.fillStyle = 'rgba(255,240,190,0.8)';
      ctx.fillRect(m.x + 10 + lap * 2, m.y + m.bob + 1, Math.round(m.boat.w * 0.26), 1);
      ctx.fillRect(m.x + Math.round(m.boat.w * 0.52) - lap, m.y + m.bob + 1, Math.round(m.boat.w * 0.2), 1);
    }

    ctx.drawImage(s.dock, 0, 200, W, H - 200, 0, 200, W, H - 200);

    // Glitter on the path: short-lived, some of them stars.
    for (const p of s.sparkles) {
      const phase = t / p.period + p.phase;
      const k = phase - Math.floor(phase);
      if (k > 0.22) continue;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, 1, 1);
      if (p.big && k > 0.05 && k < 0.17) {
        ctx.fillRect(x - 1, y, 3, 1);
        ctx.fillRect(x, y - 1, 1, 3);
        if (k > 0.09 && k < 0.13) {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillRect(x - 3, y, 7, 1);
          ctx.fillRect(x, y - 2, 1, 5);
        }
      }
    }
    // The sun's heat lying on the water right under it.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.8 + wave(t, 4.3) * 0.2;
    ctx.drawImage(s.seaFlare, SUN.x - 68, SEA - 12);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Gulls: dark against the sun, bright against the dusk.
    for (const g of s.gulls) {
      const k = (t / g.period + g.phase) % 1;
      if (k > 0.5) continue;
      const along2 = k * 2;
      const x = Math.round(g.dir > 0 ? -20 + along2 * (W + 40) : W + 20 - along2 * (W + 40));
      const y = Math.round(g.y + wave(t, g.bob, g.phase) * g.sway);
      const flap = [-1, 0, 1, 0][Math.floor(t * g.beat + g.phase * 11) & 3];
      ctx.fillStyle = Math.abs(x - SUN.x) < 110 ? '#5a3f62' : '#fff8ea';
      const size = g.size;
      ctx.fillRect(x - 1, y, 3, 1);
      for (let i = 1; i <= size + 1; i += 1) {
        const dy = flap * Math.min(i, size) + (i > size ? -flap : 0);
        ctx.fillRect(x - 1 - i, y + dy, 1, 1);
        ctx.fillRect(x + 1 + i, y + dy, 1, 1);
      }
      if (size === 3) ctx.fillRect(x + g.dir * 2, y - 1, 1, 1);
    }

    ctx.globalAlpha = 1;
  },
};

export default goldenHarbor;
