import { W, H, TAU, clamp, mix, smooth, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm1, fbm2, puffs, slide } from './art.js';

/**
 * Golden hour on a slow river through a maple wood. The sun is low on the right and
 * lights everything from that side; the wood stands in several depths, each paler for
 * the air in front of it, and the water holds all of it upside down.
 */

const SUN = { x: 436, y: 122, r: 22 };
const LIGHT = [0.76, -0.56, 0.32];
const BRIDGE_X = 300;
const LEAF_FRAMES = ['wide', 'mid', 'thin'];

/** Where the water's edge is: two banks coming forward on either side of a long straight reach. */
const shoreAt = (x) => {
  const left = 168 + 50 * smooth(clamp((196 - x) / 196)) ** 1.15;
  const right = 166 + 36 * smooth(clamp((x - 380) / 100)) ** 1.3;
  return Math.round(Math.max(left, right) + Math.sin(x / 23) * 1.1 + Math.sin(x / 9 + 1) * 0.6);
};

const see = (hex, alpha) => ((rgba(hex) & 0xffffff) | (alpha << 24)) >>> 0;

const channels = (p) => [p & 255, (p >>> 8) & 255, (p >>> 16) & 255];
const opaque = (r, g, b) => (0xff000000 | (clamp(Math.round(b), 0, 255) << 16) | (clamp(Math.round(g), 0, 255) << 8) | clamp(Math.round(r), 0, 255)) >>> 0;
const css = (r, g, b) => `rgb(${Math.round(clamp(r, 0, 255))},${Math.round(clamp(g, 0, 255))},${Math.round(clamp(b, 0, 255))})`;

/** A soft light, in stepped, dithered rings, to be added to whatever is under it. */
function glowOf(rx, ry, hex, strength, falloff = 2) {
  const art = new Art(rx * 2 + 1, ry * 2 + 1);
  const steps = 14;
  for (let y = 0; y <= ry * 2; y += 1) {
    for (let x = 0; x <= rx * 2; x += 1) {
      const d = Math.hypot((x - rx) / rx, (y - ry) / ry);
      if (d >= 1) continue;
      const level = Math.floor(strength * (1 - d) ** falloff * steps + bayer(x, y));
      if (level > 0) art.px[y * art.w + x] = see(hex, Math.round(clamp(level / steps) * 255));
    }
  }
  return art.canvas();
}

/** One mass of leaves: a ball of small round clusters. */
const foliage = (rand, cx, cy, rx, ry, count, rSmall, rBig) => {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    list.push({ x: cx + Math.cos(a) * k * rx, y: cy + Math.sin(a) * k * ry, r: rSmall + rand() * (rBig - rSmall), z: rand() * 2 });
  }
  return list;
};

/** A maple's crown: masses of leaf, top ones first, lit on the side towards the sun, with loose leaves at its edge. */
function paintCrown(art, rand, cx, cy, rx, ry, colours, leafy, o = {}) {
  const { masses = Math.round((rx * ry) / 260) + 6, small = 1.2, big = 3, lift = 0 } = o;
  const spots = [];
  for (let i = 0; i < masses; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand()) * 0.82;
    spots.push({ x: cx + Math.cos(a) * k * rx, y: cy + Math.sin(a) * k * ry, mx: rx * (0.24 + rand() * 0.14), my: ry * (0.2 + rand() * 0.12) });
  }
  spots.sort((p, q) => p.y - q.y);
  for (const p of spots) {
    const sunward = clamp((p.x - cx) / rx * 0.5 + 0.5);
    puffs(art, foliage(rand, p.x, p.y, p.mx, p.my, Math.round((p.mx * p.my) / 3.6), small, big), colours, {
      light: LIGHT, height: 0.66, spread: 0.8, grain: leafy, lift: lift - 0.12 + sunward * 0.2,
    });
  }
  const loose = Math.round(rx * 2.4);
  for (let i = 0; i < loose; i += 1) {
    const a = rand() * TAU;
    const k = 0.92 + rand() * 0.14;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    const tone = colours[Math.floor(colours.length * (0.3 + rand() * 0.5 + (Math.cos(a) > 0 ? 0.18 : 0))) % colours.length];
    art.put(x, y, tone);
    if (rand() < 0.5) art.put(x + 1, y, tone);
  }
}

/** A trunk that flares at the root and forks into the crown, lit on its right. */
function paintTrunk(art, rand, x, base, top, half, colours, forks, reach) {
  for (let y = top; y <= base; y += 1) {
    const k = (y - top) / (base - top);
    const w = half * (0.56 + k * 0.44) + k ** 8 * half * 1.5;
    const lean = Math.sin(k * 3 + x) * 1.5;
    for (let i = -Math.ceil(w); i <= w; i += 1) {
      const n = i / w;
      const bark = Math.sin(i * 1.7 + y * 0.28 + x) * 0.07;
      art.tone(x + lean + i, y, colours, clamp(0.26 + n * 0.34 + (n > 0.6 ? 0.2 : 0) + bark), 0.6);
    }
  }
  for (let i = 0; i < forks; i += 1) {
    const side = i % 2 ? 1 : -1;
    const y0 = top + (base - top) * (0.02 + rand() * 0.16);
    const len = reach * (0.45 + rand() * 0.4);
    const a = -Math.PI / 2 + side * (0.5 + rand() * 0.8);
    const n = Math.ceil(len);
    const r0 = Math.max(1, half * 0.42);
    for (let j = 0; j <= n; j += 1) {
      const k = j / n;
      const px = x + Math.cos(a) * len * k + side * k * k * 8;
      const py = y0 + Math.sin(a) * len * k;
      art.disc(px, py, Math.max(0.6, r0 * (1 - k * 0.8)), colours[1]);
      art.put(px + Math.max(0.6, r0 * (1 - k * 0.8)), py, colours[3]);
    }
  }
}

/** A stamp of letters, onto a layer rather than a canvas of its own. */
function stamp(art, rows, x, y, map) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      const c = map[row[i]];
      if (c) art.put(x + i, y + j, c);
    }
  });
}

/* A maple leaf, drawn three ways round, large and small. */
const LEAF = {
  big: {
    wide: ['   l   ', ' l l m ', 'l lmm m', ' lmmmm ', 'lmmmmdd', '  mmd  ', '   d   '],
    mid: ['  l  ', 'l l m', ' lmm ', 'lmmmd', ' mmd ', '  d  '],
    thin: [' l', 'lm', 'lm', 'md', 'd '],
  },
  small: {
    wide: ['  l  ', 'l l m', ' lmm ', 'lmmmd', '  d  '],
    mid: [' l ', 'lmm', ' md', ' d '],
    thin: ['l ', 'lm', 'md'],
  },
  tiny: {
    wide: [' l ', 'lmd', ' d '],
    mid: ['lm', 'md'],
    thin: ['l', 'm', 'd'],
  },
};
const LEAF_TONES = [
  { l: '#ff8a4a', m: '#d8342a', d: '#8e1a24' },
  { l: '#ffb14f', m: '#ec6a28', d: '#a83a20' },
  { l: '#ffe07c', m: '#f3ae30', d: '#b96f1e' },
  { l: '#ff6f4e', m: '#b8232a', d: '#6e1420' },
];

function leafSprites() {
  const out = {};
  for (const size of Object.keys(LEAF)) {
    out[size] = LEAF_TONES.map((tone) => {
      const map = { l: rgba(tone.l), m: rgba(tone.m), d: rgba(tone.d) };
      const frames = {};
      for (const name of LEAF_FRAMES) {
        const rows = LEAF[size][name];
        const art = new Art(Math.max(...rows.map((r) => r.length)), rows.length);
        stamp(art, rows, 0, 0, map);
        frames[name] = art.canvas();
      }
      return frames;
    });
  }
  return out;
}

/** The arched wooden bridge: curved girders, struts, a rail with its posts, and stone feet in the water. */
function paintBridge(art, rand) {
  const WOOD = ramp('#2a120f', '#431a14', '#5f2819', '#7f3a20', '#a2522a', '#c8743a', '#eaa155', '#ffd282');
  const STONE = ramp('#3a2320', '#54322a', '#704533', '#90603f', '#b4814f', '#dba965');
  const cx = BRIDGE_X;
  const half = 102;
  const crown = 112;
  const drop = 50;
  const water = 168;
  const archW = 62;
  const archH = 42;
  const deck = (x) => crown + drop * ((x - cx) / half) ** 2;
  const under = (x) => {
    const n = (x - cx) / archW;
    return Math.abs(n) < 1 ? water - archH * Math.sqrt(1 - n * n) : water;
  };
  // The stone feet the arch springs from.
  for (const side of [-1, 1]) {
    for (let x = cx + side * archW - (side > 0 ? -1 : 13); x < cx + side * archW + (side > 0 ? 13 : -1); x += 1) {
      for (let y = 158; y < 172; y += 1) {
        const course = Math.floor((y - 158) / 4);
        const joint = (y - 158) % 4 === 0 || (x + course * 5) % 9 === 0;
        art.tone(x, y, STONE, clamp(0.46 + ((x - cx) / half) * 0.3 + (joint ? -0.26 : 0) + (rand() - 0.5) * 0.1), 0.4);
      }
    }
  }
  for (let x = cx - half; x <= cx + half; x += 1) {
    const top = deck(x);
    const low = under(x);
    const sunward = (x - cx) / half;
    // The girder under the deck: plank ends in a row.
    for (let y = Math.round(top); y < top + 5; y += 1) {
      const face = (y - top) / 5;
      const notch = x % 4 === 0 ? -0.14 : 0;
      art.tone(x, y, WOOD, clamp(0.62 - face * 0.34 + sunward * 0.16 + notch), 0.4);
    }
    art.put(x, Math.round(top), WOOD[7]);
    // Struts between girder and rib, with the wood showing through.
    if (low > top + 9) {
      const strut = (x + 400) % 9;
      if (strut < 2) {
        for (let y = Math.round(top + 5); y < low - 4; y += 1) art.tone(x, y, WOOD, clamp(strut === 1 ? 0.52 + sunward * 0.1 : 0.26), 0.4);
      }
      // A cross-brace in every other bay.
      if ((Math.floor((x + 400) / 9) % 2) === 0 && strut >= 2) {
        const yb = top + 5 + ((strut - 2) / 7) * Math.max(0, low - 4 - top - 5);
        art.put(x, yb, WOOD[2]);
      }
    }
    // The rib of the arch.
    if (Math.abs(x - cx) < archW) {
      for (let y = Math.round(low - 4); y <= low; y += 1) art.tone(x, y, WOOD, clamp(0.5 - ((y - (low - 4)) / 4) * 0.42 + sunward * 0.12), 0.4);
    }
    // The rail and its middle bar.
    art.tone(x, Math.round(top - 9), WOOD, clamp(0.78 + sunward * 0.18), 0.4);
    art.tone(x, Math.round(top - 8), WOOD, clamp(0.46 + sunward * 0.12), 0.4);
    art.tone(x, Math.round(top - 4), WOOD, clamp(0.38 + sunward * 0.12), 0.4);
    if ((x + 400) % 12 < 2) {
      const lit = (x + 400) % 12 === 1;
      for (let y = Math.round(top - 11); y < top; y += 1) art.put(x, y, WOOD[lit ? 5 : 2]);
      art.put(x, Math.round(top - 12), WOOD[lit ? 7 : 4]);
    }
  }
}

/** Long streaks of warm cloud, on a sheet that wraps. */
function streaks(rand, seed, height, count, colours, longest) {
  const art = new Art(960, height);
  const fray = noise2(seed, 64);
  for (let i = 0; i < count; i += 1) {
    const cx = rand() * 960;
    const cy = 3 + rand() * (height - 6);
    const half = longest * (0.35 + rand() * 0.65);
    const thick = 1.2 + rand() * 3;
    for (let dy = -Math.ceil(thick); dy <= thick; dy += 1) {
      const k = Math.abs(dy) / (thick + 0.5);
      const reach = half * (1 - k * k) ** 0.8;
      const shift = (fray(i * 3.7, (dy + 9) * 0.9) - 0.5) * half * 0.34;
      for (let x = -reach; x <= reach; x += 1) {
        const px = cx + shift + x;
        const y = Math.round(cy + dy + Math.sin(px / 83) * 2);
        const edge = 1 - Math.abs(x) / reach;
        const a = edge * 2.4 * (0.5 + fbm2(fray, px / 15, y / 2.5, 2)) - 0.16;
        if (a <= bayer(Math.round(px), y)) continue;
        const shade = clamp(0.38 + dy / (thick * 1.8) + edge * 0.1);
        art.wrap(px, y, colours[Math.min(colours.length - 1, Math.floor(shade * colours.length))]);
      }
    }
  }
  return art.canvas();
}

/** Mist: a sheet that wraps, thick in its middle rows and gone at top and bottom, dithered through. */
function mistSheet(seed, height, amount, hexes) {
  const n = noise2(seed, 64);
  const art = new Art(960, height);
  const colours = ramp(...hexes);
  for (let y = 0; y < height; y += 1) {
    const band = Math.sin(((y + 0.5) / height) * Math.PI) ** 1.4;
    for (let x = 0; x < 960; x += 1) {
      const d = fbm2(n, x / 15, y / 5, 3);
      const a = clamp((d - 0.34) * 2.4) * band * amount;
      const level = Math.floor(a * 7 + bayer(x, y));
      if (level <= 0) continue;
      art.px[y * 960 + x] = (colours[Math.min(colours.length - 1, Math.floor(clamp(a * 1.5) * colours.length))] & 0xffffff | (Math.round((level / 7) * 150) << 24)) >>> 0;
    }
  }
  return art.canvas();
}

/** Shafts of low sun coming through the trees, spreading left and down. */
function shaftSheet(seed, gaps) {
  const n = noise1(seed, 128);
  const art = new Art();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < SUN.x + 20; x += 1) {
      const dx = SUN.x - x;
      const dy = y - SUN.y;
      const d = Math.hypot(dx, dy);
      if (d < 6) continue;
      const angle = Math.atan2(dy, dx);
      const rays = clamp((fbm1(n, angle * gaps + 20, 3) - 0.5) * 6);
      const a = rays * 0.3 * Math.exp(-d / 210);
      const level = Math.floor(a * 14 + bayer(x, y));
      if (level > 0) art.px[y * W + x] = see('#ffcb72', Math.round((level / 14) * 255));
    }
  }
  return art.canvas();
}

const mapleRiver = {
  build() {
    const rand = seeded(2704);
    const grainFine = noise2(2705, 64);
    const leafy = (x, y) => (fbm2(grainFine, x / 2.8, y / 2.8, 2) - 0.5) * 0.48;
    const shore = Int16Array.from({ length: W }, (_, x) => shoreAt(x));
    const waterTop = Math.min(...shore);

    /* ── the far layer: sky, hills, a distant wood, the bank ──────── */
    const back = new Art();
    const SKY = ramp('#a2779e', '#b98398', '#cf9090', '#e2a086', '#efb37c', '#f6c677', '#fbd680', '#fee595', '#fff2b8', '#fff9da');
    const skyNoise = noise2(2706, 64);
    back.shade(SKY, (x, y) => {
      const d = Math.hypot((x - SUN.x) / 1.35, y - SUN.y);
      return clamp(0.02 + (y / 176) * 0.56 + 0.62 * Math.exp(-((d / 118) ** 1.5)) + (fbm2(skyNoise, x / 24, y / 10, 3) - 0.5) * 0.05);
    }, 0.95);
    const SUNNY = ramp('#fff3bf', '#fff8d4', '#fffce8');
    for (let y = SUN.y - SUN.r; y <= SUN.y + SUN.r; y += 1) {
      for (let x = SUN.x - SUN.r; x <= SUN.x + SUN.r; x += 1) {
        const d = Math.hypot(x - SUN.x, y - SUN.y) / SUN.r;
        if (d <= 1) back.tone(x, y, SUNNY, clamp(1.2 - d), 0.8);
      }
    }
    const cloudSheet = streaks(rand, 2707, 92, 18, ramp('#c58c98', '#dc9c92', '#efb48c', '#fbcf94', '#ffe6ac'), 120);

    // Two ridges of hill in the haze, the nearer showing the wood on it.
    const HAZE1 = ramp('#c08d86', '#ca9a8a', '#d6a98e', '#e2b994', '#ecc99c');
    const HAZE2 = ramp('#a96f62', '#b67b66', '#c48a6c', '#d29b74', '#dfad7e');
    const line1 = noise1(2708, 128);
    const line2 = noise1(2709, 128);
    const ridge1 = (x) => 118 + fbm1(line1, x / 32, 4) * 36 - 18 * Math.exp(-(((x - 120) / 90) ** 2));
    const ridge2 = (x) => 132 + fbm1(line2, x / 26, 4) * 28;
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(ridge1(x));
      for (let y = top; y < 170; y += 1) back.tone(x, y, HAZE1, clamp(0.2 + (y - top) / 46 + (x - 240) / 1400), 0.8);
    }
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(ridge2(x));
      for (let y = top; y < 170; y += 1) back.tone(x, y, HAZE2, clamp(0.28 + (y - top) / 40 + (fbm2(grainFine, x / 3.5, y / 3.5, 2) - 0.5) * 0.5), 0.8);
    }

    // The far wood, in two rows, each paler than what stands in front of it.
    const FARTHEST = [ramp('#bb7d62', '#c88b68', '#d59c70', '#e1ae7c', '#ecc08c'), ramp('#b86c58', '#c67c5e', '#d48e66', '#e0a272', '#ebb782')];
    const FARTHER = [ramp('#a8542c', '#bf6a30', '#d38236', '#e49c42', '#f0b858', '#f8d27e'), ramp('#a14234', '#b95436', '#cf6b3a', '#e08540', '#eda352', '#f6c070'), ramp('#b0702a', '#c8862e', '#dc9e36', '#ebb646', '#f5cd60', '#fbe08a')];
    const row = (art, count, y0, rMin, rMax, sets) => {
      for (let i = 0; i < count; i += 1) {
        const r = rMin + rand() * (rMax - rMin);
        const cx = ((i + rand() * 0.8) / count) * (W + 40) - 20;
        const set = sets[Math.floor(rand() * sets.length)];
        puffs(art, foliage(rand, cx, y0 - r * 0.72, r * 1.2, r * 0.86, Math.round(r * r * 0.34) + 8, 1.5, 3.2), set, { light: LIGHT, height: 0.62, spread: 0.8, grain: leafy, lift: 0.02 });
      }
    };
    row(back, 26, 160, 9, 16, FARTHEST);
    row(back, 20, 166, 13, 22, FARTHER);
    // A taller row just behind the bridge: only the crowns show, soft with air.
    for (const [cx, r] of [[196, 30], [246, 36], [292, 40], [340, 34], [386, 26], [150, 28], [96, 30], [470, 24]]) {
      puffs(back, foliage(rand, cx, 158 - r * 1.05, r * 1.15, r * 0.92, Math.round(r * r * 0.5), 1.4, 3), FARTHER[Math.floor(rand() * 3)], { light: LIGHT, height: 0.64, spread: 0.8, grain: leafy, lift: 0.06 });
    }

    // The ground under the trees: leaf litter, warm, darkening to the water's edge.
    const LITTER = ramp('#4b2518', '#6b341e', '#8a4724', '#a95d2a', '#c67a34', '#dd9a48', '#ecb964');
    for (let x = 0; x < W; x += 1) {
      for (let y = 160; y < shore[x]; y += 1) {
        const toWater = shore[x] - y;
        const patches = (fbm2(grainFine, x / 15, y / 6, 3) - 0.5) * 1.1;
        const v = 0.34 + clamp(toWater / 22) * 0.24 + (x / W) * 0.12 + patches + (fbm2(grainFine, x / 2.2, y / 1.6, 2) - 0.5) * 0.5 - (toWater <= 1 ? 0.3 : 0);
        back.tone(x, y, LITTER, clamp(v), 0.8);
      }
    }
    for (const [tx, ty, reach, thick] of [[34, 212, 80, 7], [112, 186, 92, 4], [136, 176, 80, 2.4], [176, 170, 60, 2.4], [472, 197, 84, 6], [402, 170, 42, 2], [372, 167, 30, 2]]) {
      for (let i = 0; i < reach; i += 1) {
        const k = i / reach;
        const half = thick * (1 + k * 0.6);
        for (let j = -half; j <= half; j += 1) {
          const px = Math.round(tx - i);
          const py = Math.round(ty - k * 8 + j);
          if (px < 0 || py >= (shore[px] ?? 0) || py < 160) continue;
          if (bayer(px, py) < 0.9 * (1 - k * 0.62)) back.put(px, py, LITTER[k < 0.4 ? 1 : 2]);
        }
      }
    }
    for (let i = 0; i < 170; i += 1) {
      const x = Math.floor(rand() * W);
      if (shore[x] < 172) continue;
      const y = 161 + rand() * (shore[x] - 162);
      back.put(x, y, rgba(['#f0542c', '#ffa83c', '#ffe07c', '#c8332a'][Math.floor(rand() * 4)]));
    }
    // Stones at the waterline, each lit on its right.
    const ROCK = ramp('#2f2626', '#47393a', '#66534c', '#8a725e', '#ae9272', '#d6b98a');
    for (let i = 0; i < 16; i += 1) {
      const x = 10 + rand() * 460;
      if (Math.abs(x - BRIDGE_X) < 66) continue;
      const rx = 3 + rand() * 6;
      const ry = 2 + rand() * 3;
      const y = shore[Math.round(x)] - ry * 0.3;
      for (let py = -ry; py <= ry * 0.4; py += 1) {
        for (let px = -rx; px <= rx; px += 1) {
          if ((px / rx) ** 2 + (py / ry) ** 2 > 1) continue;
          back.tone(x + px, y + py, ROCK, clamp(0.5 + (px / rx) * 0.3 - (py / ry) * 0.24 + (rand() - 0.5) * 0.12), 0.5);
        }
      }
    }

    /* ── the middle layer: gold and orange trees, and the bridge ──── */
    const mid = new Art();
    const BARK_MID = ramp('#3e201a', '#55291f', '#6f3726', '#8e4a2e', '#b4683c');
    const GOLD = ramp('#7f4418', '#a3611c', '#c47f22', '#dfa02c', '#f1bf3e', '#fbd85e', '#ffec90');
    const AMBER = ramp('#7a3218', '#9c471c', '#bd6220', '#d9812a', '#ed9f38', '#f8bd50', '#fed87c');
    const EMBER = ramp('#6c2218', '#8e311c', '#ae4420', '#cb5c26', '#e27b32', '#f19f48', '#fac26c');
    /** @type {[number, number, number, number, number, number[], number][]} */
    const midTrees = [
      [176, 172, 98, 44, 40, GOLD, 3.2],
      [228, 168, 102, 36, 36, EMBER, 2.6],
      [136, 180, 110, 42, 42, AMBER, 3.4],
      [372, 168, 104, 36, 38, EMBER, 3],
      [344, 166, 94, 28, 26, GOLD, 2.2],
      [402, 170, 88, 24, 30, AMBER, 2.4],
    ];
    for (const [x, base, cy, rx, ry, colours, half] of midTrees) {
      paintTrunk(mid, rand, x, base, cy + ry * 0.2, half, BARK_MID, 4, ry * 0.7);
      paintCrown(mid, rand, x, cy, rx, ry, colours, leafy);
    }
    paintBridge(mid, rand);

    /* ── the near layer: the great trees either side ──────────────── */
    const near = new Art();
    const BARK = ramp('#190c10', '#2a1416', '#3f201d', '#5a3024', '#7e472e', '#ad6c40');
    const CRIMSON = ramp('#3a0b1a', '#5a1220', '#7f1a24', '#a32426', '#c63427', '#df512a', '#f07a38', '#fbad54');
    const SCARLET = ramp('#4e1219', '#70191d', '#962320', '#b93322', '#d44c25', '#e96e2c', '#f6963e', '#fec45f');
    const ORANGE = ramp('#5e2316', '#80331a', '#a4471d', '#c56121', '#de7f29', '#ef9f36', '#f9bf52', '#ffdd80');
    // Behind: one more tree on the left, amber, its trunk on the bank.
    paintTrunk(near, rand, 112, shore[112] + 1, 118, 4.4, BARK, 5, 40);
    paintCrown(near, rand, 112, 96, 62, 56, ORANGE, leafy, { lift: 0.02 });
    // The great crimson maple on the left, reaching overhead.
    paintTrunk(near, rand, 34, shore[34] + 2, 102, 8.5, BARK, 7, 60);
    paintCrown(near, rand, 30, 62, 88, 70, SCARLET, leafy, { lift: -0.03, big: 3.6 });
    paintCrown(near, rand, 8, 92, 58, 42, CRIMSON, leafy, { big: 3.6 });
    paintCrown(near, rand, 72, 28, 72, 36, CRIMSON, leafy, { lift: 0.04, big: 3.6 });
    // On the right, one crimson maple whose crown the sun comes in under.
    paintTrunk(near, rand, 472, shore[472] + 2, 70, 7, BARK, 6, 40);
    paintCrown(near, rand, 468, 40, 60, 48, CRIMSON, leafy, { lift: 0.02, big: 3.6 });
    paintCrown(near, rand, 492, 72, 34, 32, SCARLET, leafy, { lift: -0.08, big: 3.6 });

    // Sprigs that hang down into the light under the right-hand crown.
    const map = (tone) => ({ l: rgba(LEAF_TONES[tone].l), m: rgba(LEAF_TONES[tone].m), d: rgba(LEAF_TONES[tone].d) });
    const TWIG = BARK[1];
    for (let i = 0; i < 9; i += 1) {
      const x0 = 408 + rand() * 62;
      const y0 = 62 + rand() * 18;
      const len = 14 + rand() * 26;
      const lean = (rand() - 0.5) * 14;
      for (let k = 0; k <= 1; k += 0.03) near.put(x0 + lean * k, y0 + len * k, TWIG);
      for (let k = 0.3; k <= 1; k += 0.14) {
        stamp(near, LEAF.small.wide, x0 + lean * k - 2 + (rand() - 0.5) * 7, y0 + len * k - 2 + (rand() - 0.5) * 3, map(Math.floor(rand() * 2)));
      }
    }

    // Clear whatever hangs below the water's edge: that part belongs to the water.
    for (const layer of [back, mid, near]) {
      for (let x = 0; x < W; x += 1) {
        for (let y = shore[x]; y < H; y += 1) layer.px[y * W + x] = 0;
      }
    }

    /* ── the water: all of the above, upside down ─────────────────── */
    const source = (x, y) => near.get(x, y) || mid.get(x, y) || back.get(x, y);
    const WATER_PAD = 6;
    const water = new Art(W + WATER_PAD * 2, H);
    const streakNoise = noise2(2710, 64);
    const DEEP = [64, 40, 66];
    for (let y = waterTop; y < H; y += 1) {
      for (let wx = 0; wx < water.w; wx += 1) {
        const x = clamp(wx - WATER_PAD, 0, W - 1);
        const edge = shore[x];
        const ry = Math.max(edge, y);
        const sy = 2 * edge - ry - 1;
        const [r, g, b] = channels(source(x, sy < 0 ? 0 : sy));
        const below = (ry - edge) / (H - edge);
        const dark = 0.9 - below * 0.2 - Math.exp(-(ry - edge) / 3) * 0.3;
        const tint = 0.05 + below * 0.3;
        const band = 1 + (fbm2(streakNoise, x / 15, y / 0.9, 2) - 0.5) * 0.34;
        const dither = (bayer(x, y) - 0.5) * 7;
        water.px[y * water.w + wx] = opaque(
          mix(r * dark, DEEP[0], tint) * band + dither,
          mix(g * dark, DEEP[1], tint) * band + dither,
          mix(b * dark, DEEP[2], tint) * band + dither,
        );
      }
    }

    // Ripple marks, each a brighter or darker line of what the water is showing there.
    const marks = [];
    for (let i = 0; i < 300; i += 1) {
      const x = rand() * W;
      const near01 = rand() ** 0.7;
      const y = Math.round(mix(waterTop + 2, H - 1, near01));
      const xi = Math.floor(x);
      if (y < shore[xi] + 1) continue;
      const [r, g, b] = channels(water.px[y * water.w + xi + WATER_PAD]);
      const up = rand() < 0.62;
      const k = up ? 0.34 + rand() * 0.22 : 0.3;
      marks.push({
        x, y, len: Math.round(2 + near01 * 14 + rand() * 5), period: 2.4 + rand() * 4.6, phase: rand(), drift: 1 + near01 * 3,
        tone: up ? css(mix(r, 255, k), mix(g, 232, k), mix(b, 170, k)) : css(r * 0.66, g * 0.68, b * 0.74),
      });
    }
    // The sun's road on the water.
    const glitter = [];
    for (let i = 0; i < 90; i += 1) {
      const k = rand() ** 0.8;
      const y = Math.round(mix(shore[SUN.x] + 2, H - 1, k));
      glitter.push({ x: SUN.x + (rand() - 0.5) * (10 + k * 40), y, len: Math.round(2 + k * 11 + rand() * 4), period: 0.8 + rand() * 1.8, phase: rand(), hot: rand() < 0.4 });
    }

    // Leaves on their way down, and the ring each one leaves where it lands on the water.
    const sprites = leafSprites();
    const falling = [];
    for (let i = 0; i < 74; i += 1) {
      const z = rand();
      const size = z > 0.78 ? 'big' : z > 0.42 ? 'small' : 'tiny';
      const v = 7 + z * 15;
      const land = mix(176, 262, z) + (rand() - 0.5) * 22;
      falling.push({
        x: rand() * (W + 40), z, size, tone: Math.floor(rand() * 4), v, range: land + 12, land, start: rand() * 300,
        drift: 3 + z * 8, sway: 5 + rand() * 14, period: 3 + rand() * 5, phase: rand(), spin: 1.2 + rand() * 2.4,
      });
    }
    // Leaves already on the water, going where it goes.
    const floating = [];
    for (let i = 0; i < 46; i += 1) {
      const k = rand() ** 0.75;
      floating.push({
        x: rand() * (W + 30), y: mix(waterTop + 4, H - 4, k), k, v: 1.2 + k * 5, tone: Math.floor(rand() * 4), size: k > 0.72 ? 'big' : k > 0.34 ? 'small' : 'tiny',
        period: 3 + rand() * 4, phase: rand(), frame: LEAF_FRAMES[Math.floor(rand() * 2)],
      });
    }
    const motes = [];
    for (let i = 0; i < 44; i += 1) motes.push({ x: rand() * W, y: 60 + rand() * 120, v: 1.4 + rand() * 2.6, sway: 3 + rand() * 8, period: 4 + rand() * 7, phase: rand(), blink: 2 + rand() * 4 });

    /* ── a boat, a pair of herons ─────────────────────────────────── */
    const boat = new Art(62, 30);
    const HULL = ramp('#1f100f', '#351b16', '#4e2a1e', '#6e3f28', '#996036', '#d1934f');
    for (let x = 0; x < 62; x += 1) {
      const k = x / 61;
      const rise = (2 * k - 1) ** 4 * 8;
      const top = Math.round(21 - rise);
      const low = Math.round(29 - rise * 0.45 - (k > 0.9 ? (k - 0.9) * 30 : 0) - (k < 0.1 ? (0.1 - k) * 30 : 0));
      for (let y = top; y <= low; y += 1) boat.tone(x, y, HULL, clamp(0.46 - ((y - top) / Math.max(1, low - top)) * 0.42 + k * 0.14), 0.4);
      boat.put(x, top, HULL[5]);
    }
    const THATCH = ramp('#4a2f1d', '#6a4628', '#8e6434', '#b78845', '#dcb062');
    for (let x = 18; x <= 42; x += 1) {
      const n = (x - 30) / 12;
      const roof = Math.round(19 - Math.sqrt(1 - n * n) * 9);
      for (let y = roof; y < 21; y += 1) boat.tone(x, y, THATCH, clamp(0.72 - ((y - roof) / 9) * 0.52 + n * 0.2 + (x % 3 === 0 ? -0.12 : 0)), 0.4);
      boat.put(x, roof, THATCH[4]);
    }
    boat.rect(19, 19, 23, 2, THATCH[0]);
    // The boatman at the stern, in a conical hat.
    const MAN = rgba('#1c1013');
    const MANLIT = rgba('#c47c3e');
    boat.rect(50, 9, 3, 10, MAN);
    boat.rect(52, 9, 1, 10, MANLIT);
    boat.rect(50, 7, 3, 2, MAN);
    for (let i = 0; i < 4; i += 1) {
      boat.rect(51 - i - 1, 3 + i, 3 + i * 2, 1, rgba(i === 3 ? '#9c6a38' : '#dcb062'));
      boat.put(51 + i + 1, 3 + i, rgba('#ffe7a0'));
    }
    const boatFlip = new Art(62, 30);
    for (let y = 0; y < 30; y += 1) {
      for (let x = 0; x < 62; x += 1) {
        const v = boat.get(x, 29 - y);
        if (!v || bayer(x, y) > 1.02 - y * 0.024) continue;
        const [r, g, b] = channels(v);
        boatFlip.put(x, y, opaque(r * 0.58 + 26, g * 0.5 + 20, b * 0.5 + 26));
      }
    }
    const heron = (wings) => {
      const art = new Art(18, 13);
      const white = rgba('#fff4dd');
      const shade = rgba('#d0a48c');
      const dark = rgba('#3f2a2f');
      art.rect(5, 6, 7, 2, white);
      art.rect(5, 8, 6, 1, shade);
      art.line(12, 6, 15, 4, white);
      art.line(15, 4, 17, 5, rgba('#e6a23c'));
      art.line(0, 7, 5, 7, dark);
      if (wings === 0) {
        art.line(9, 5, 5, 0, white);
        art.line(8, 5, 4, 1, shade);
        art.put(5, 0, dark);
      } else if (wings === 1) {
        art.line(9, 5, 2, 4, white);
        art.line(8, 6, 3, 5, shade);
        art.put(2, 4, dark);
      } else {
        art.line(9, 8, 4, 12, white);
        art.line(8, 8, 3, 11, shade);
        art.put(4, 12, dark);
      }
      return art.canvas();
    };

    /* ── the near bank, in the corners ────────────────────────────── */
    const front = new Art();
    const EARTH = ramp('#170c0f', '#241316', '#35201c', '#4c2f22', '#6a4229', '#8e5a32');
    const edgeNoise = noise1(2711, 128);
    const frontTop = (x) => {
      const left = x < 190 ? 234 + (x / 190) ** 1.5 * 44 : 999;
      const right = x > 372 ? 278 - ((x - 372) / 108) ** 1.3 * 32 : 999;
      return Math.min(left, right) + (fbm1(edgeNoise, x / 9, 3) - 0.5) * 7;
    };
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(frontTop(x));
      for (let y = top; y < H; y += 1) {
        const depth = y - top;
        front.tone(x, y, EARTH, clamp(0.56 - depth / 42 + (fbm2(grainFine, x / 4, y / 3, 3) - 0.5) * 0.6 + (depth < 2 ? 0.22 : 0)), 0.7);
      }
    }
    // Fallen leaves on it, and stones.
    for (let i = 0; i < 150; i += 1) {
      const x = Math.floor(rand() * W);
      const top = frontTop(x);
      if (top > H - 2) continue;
      const y = top + rand() * (H - top);
      const tones = map(Math.floor(rand() * 4));
      const size = rand() < 0.3 ? LEAF.small.wide : LEAF.tiny.wide;
      if (rand() < 0.74) stamp(front, size, x, y, tones);
    }
    for (const [x, y, rx, ry] of [[44, 250, 14, 8], [86, 262, 12, 7], [14, 262, 10, 7], [448, 262, 13, 7]]) {
      for (let py = -ry; py <= ry; py += 1) {
        for (let px = -rx; px <= rx; px += 1) {
          if ((px / rx) ** 2 + (py / ry) ** 2 > 1) continue;
          front.tone(x + px, y + py, ROCK, clamp(0.34 + (px / rx) * 0.26 - (py / ry) * 0.3 + (fbm2(grainFine, (x + px) / 3, (y + py) / 3, 2) - 0.5) * 0.4), 0.6);
        }
      }
    }

    // Tall grasses at both corners, three positions of the same clump, moving together.
    const reeds = (seed, n, tall) => {
      const r = seeded(seed);
      const blades = [];
      for (let i = 0; i < n; i += 1) blades.push({ x: 6 + r() * 34, h: tall * (0.5 + r() * 0.5), lean: (r() - 0.5) * 12, plume: r() < 0.55, shade: r() });
      return [-1, 0, 1].map((bend) => {
        const art = new Art(50, tall + 6);
        const dark = rgba('#20130f');
        const lit = rgba('#8d5a2e');
        const gold = rgba('#f5c673');
        const paler = rgba('#caa066');
        for (const b of blades) {
          for (let j = 0; j < b.h; j += 1) {
            const k = j / b.h;
            const x = b.x + (b.lean + bend * 3.2) * k * k;
            const y = tall + 5 - j;
            art.put(x, y, b.shade > 0.5 ? dark : lit);
            if (k > 0.8 && b.plume) {
              art.put(x + (j % 2 ? 1 : -1), y, j % 3 ? gold : paler);
              if (j % 2) art.put(x + (j % 4 ? 2 : -2), y + 1, paler);
            }
          }
        }
        return art.canvas();
      });
    };

    /* ── a bough of real leaves, nearest of all ───────────────────── */
    const bough = new Art(250, 66);
    const boughBark = rgba('#1e0f12');
    const boughBranches = [[0, 4, 246, 28], [40, 8, 150, 42], [96, 13, 206, 8], [150, 20, 226, 44], [14, 6, 66, 46]];
    for (const [x0, y0, x1, y1] of boughBranches) {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
      for (let i = 0; i <= n; i += 1) {
        const k = i / n;
        bough.put(mix(x0, x1, k), mix(y0, y1, k) + Math.sin(k * 7 + x0) * 1.6, boughBark);
      }
    }
    for (let i = 0; i < 300; i += 1) {
      const [x0, y0, x1, y1] = boughBranches[Math.floor(rand() * boughBranches.length)];
      const k = rand() ** 0.7;
      const x = mix(x0, x1, k) + (rand() - 0.5) * 18;
      const y = mix(y0, y1, k) + (rand() - 0.5) * 15;
      stamp(bough, rand() < 0.45 ? LEAF.big.wide : LEAF.small.wide, x, y, map(Math.floor(rand() * 4)));
    }

    return {
      back: back.canvas(), mid: mid.canvas(), near: near.canvas(), water: water.canvas(), front: front.canvas(), bough: bough.canvas(),
      waterTop, shore, WATER_PAD, marks, glitter, falling, floating, motes, sprites, boat: boat.canvas(), boatFlip: boatFlip.canvas(),
      herons: [heron(0), heron(1), heron(2), heron(1)], cloudSheet,
      mistFar: mistSheet(2712, 34, 0.72, ['#f3c79a', '#f8d7ac', '#fde6c2']),
      mistWater: mistSheet(2713, 26, 0.5, ['#efc095', '#f7d3a8', '#fee7c4']),
      shaftsA: shaftSheet(2714, 5), shaftsB: shaftSheet(2715, 7),
      sunBloom: glowOf(92, 92, '#ffcf80', 0.5, 2.2),
      reedsA: reeds(2716, 22, 58), reedsB: reeds(2717, 16, 44),
    };
  },

  draw(ctx, t, s) {
    // The water first, row by row: each slides on its own wave, more of it the nearer it is.
    const span = H - s.waterTop;
    for (let y = s.waterTop; y < H; y += 1) {
      const k = (y - s.waterTop) / span;
      const dx = Math.round((0.6 + k * 2.6) * (Math.sin(y * 0.62 + t * 1.9) * 0.6 + Math.sin(y * 0.21 - t * 1.13) * 0.5));
      const sy = clamp(y + Math.round(Math.sin(y * 0.93 - t * 1.37) * (0.4 + k * 1.5)), s.waterTop, H - 1);
      ctx.drawImage(s.water, s.WATER_PAD - dx, sy, W, 1, 0, y, W, 1);
    }

    // Ripples, each coming and going at its own pace.
    for (const m of s.marks) {
      const v = wave(t, m.period, m.phase);
      if (v < 0.18) continue;
      ctx.fillStyle = m.tone;
      ctx.fillRect(Math.round(m.x + wave(t, m.period * 2.3, m.phase) * m.drift), m.y, Math.max(1, Math.round(m.len * v)), 1);
    }
    for (const g of s.glitter) {
      const v = wave(t, g.period, g.phase);
      if (v < 0) continue;
      ctx.fillStyle = g.hot ? '#fffbe0' : '#ffdf95';
      const len = Math.max(1, Math.round(g.len * v));
      ctx.fillRect(Math.round(g.x - len / 2), g.y, len, 1);
    }

    // A falling leaf is only ever at one place, so we can always say where it was when it landed.
    const fallX = (f, at) => {
      const span2 = W + 40;
      return (((f.x - at * f.drift + Math.sin((at / f.period + f.phase) * TAU) * f.sway) % span2) + span2) % span2 - 20;
    };
    for (const f of s.falling) {
      const cycle = f.range / f.v;
      const since = (t + f.start) % cycle;
      if (since > 1.8) continue;
      const lx = Math.round(fallX(f, t - since));
      if (lx < 0 || lx >= W || f.land <= s.shore[lx] + 2) continue;
      const a = since / 1.8;
      const rx = 1 + a * (3 + f.z * 9);
      const ry = Math.max(1, rx * 0.26);
      ctx.fillStyle = `rgba(255,232,180,${(0.52 * (1 - a)).toFixed(2)})`;
      const steps = Math.ceil(rx * 1.6) + 4;
      for (let i = 0; i < steps; i += 1) {
        const ang = (i / steps) * TAU;
        ctx.fillRect(Math.round(lx + Math.cos(ang) * rx), Math.round(f.land + Math.sin(ang) * ry), 1, 1);
      }
    }

    // Leaves on the water, with a little dark under each.
    for (const l of s.floating) {
      const spanF = W + 30;
      const x = Math.round(((l.x + t * l.v) % spanF) - 15);
      const y = Math.round(l.y + wave(t, l.period, l.phase) * (0.4 + l.k));
      const img = s.sprites[l.size][l.tone][l.frame];
      ctx.fillStyle = 'rgba(20,20,30,0.34)';
      ctx.fillRect(x, y + img.height - 1, img.width, 1);
      ctx.drawImage(img, x, y);
    }

    // The boat, far enough off to go at its own slow rate, with its image under it and a thin wake.
    const boatSpan = W + 140;
    const bx = Math.round(((t * 3.1 + 150) % boatSpan) - 70);
    const by = 188 + Math.round(wave(t, 5.4) * 0.8);
    ctx.drawImage(s.boatFlip, bx + Math.round(wave(t, 2.1)), by + 29);
    ctx.fillStyle = 'rgba(255,236,190,0.55)';
    for (let i = 1; i < 6; i += 1) {
      if (((t * 0.8 + i * 0.37) % 1) < 0.25) continue;
      const len = 6 + i * 3;
      ctx.fillRect(bx - i * 5 - len + 6, by + 29 + (i % 2), len, 1);
    }
    ctx.drawImage(s.boat, bx, by);
    // The pole, pushed and drawn back.
    const push = wave(t, 8.2);
    ctx.fillStyle = '#1c1013';
    for (let i = 0; i < 25; i += 1) {
      const k = i / 24;
      ctx.fillRect(Math.round(bx + 49 + (6 + push * 3) * k - (1 - k) * 2), Math.round(by + 6 + 27 * k), 1, 1);
    }

    ctx.drawImage(s.back, 0, 0);
    slide(ctx, s.cloudSheet, along(t, 1, 960), 4);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9 + wave(t, 13) * 0.1;
    ctx.drawImage(s.sunBloom, SUN.x - 92, SUN.y - 92);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    slide(ctx, s.mistFar, along(t, 2, 960), 136);
    ctx.drawImage(s.mid, 0, 0);

    // A pair of herons now and again, one a little behind the other.
    const flight = (t % 96) / 34;
    if (flight < 1) {
      const fx = Math.round(flight * (W + 60)) - 30;
      for (const [dx, dy, off] of [[0, 0, 0], [-19, 7, 2]]) {
        const fy = 56 + dy + Math.round(wave(t, 11) * 3 + (1 - flight) * 16);
        const f = (Math.floor(t * 5) + off) % 4;
        ctx.drawImage(s.herons[f], fx + dx, fy);
      }
    }

    // The sun's shafts: two sets, breathing out of step, so the light seems to move through the leaves.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 + wave(t, 17) * 0.34;
    ctx.drawImage(s.shaftsA, 0, 0);
    ctx.globalAlpha = 0.5 + wave(t, 23, 0.4) * 0.34;
    ctx.drawImage(s.shaftsB, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(s.near, 0, 0);
    slide(ctx, s.mistWater, along(t, 3.2, 960), 164);

    // Specks of gold going through the light.
    ctx.fillStyle = '#ffe9a8';
    for (const m of s.motes) {
      if (wave(t, m.blink, m.phase) < -0.2) continue;
      const y = ((m.y - t * m.v) % 130 + 130) % 130 + 50;
      ctx.fillRect(Math.round(m.x + wave(t, m.period, m.phase) * m.sway), Math.round(y), 1, 1);
    }

    // Leaves on the way down. Each stops where its own journey ends, and starts again above the frame.
    for (const f of s.falling) {
      const cycle = f.range / f.v;
      const y = ((t + f.start) % cycle) * f.v - 12;
      if (y > f.land - 1) continue;
      const v = Math.abs(wave(t, f.spin, f.phase));
      const name = v > 0.62 ? 'wide' : v > 0.26 ? 'mid' : 'thin';
      ctx.drawImage(s.sprites[f.size][f.tone][name], Math.round(fallX(f, t)), Math.round(y));
    }

    ctx.drawImage(s.front, 0, 0);
    const bend = (phase, period) => {
      const v = wave(t, period, phase);
      return v < -0.34 ? 0 : v > 0.34 ? 2 : 1;
    };
    ctx.drawImage(s.reedsA[bend(0, 3.7)], 4, 270 - 66);
    ctx.drawImage(s.reedsB[bend(0.3, 4.3)], 66, 270 - 42);
    ctx.drawImage(s.reedsB[bend(0.6, 3.1)], 430, 270 - 50);

    // The bough overhead, and its sway, nearest of all.
    ctx.drawImage(s.bough, Math.round(wave(t, 7.3)) - 6, Math.round(wave(t, 5.1)) - 4);
  },
};

export default mapleRiver;
