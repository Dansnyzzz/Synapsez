import { W, H, TAU, clamp, mix, smooth, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm2, slide } from './art.js';

/* Where things stand, in canvas rows and columns. Everything below hangs off these. */
const FOOT = 192; // the walls meet the pavement
const KERB = 203; // the top of the kerb
const ROAD = 207; // the road's first row
const ROWS = H - ROAD;
const GLASS_A = { x0: 36, x1: 180, y0: 112, y1: 176 };
const GLASS_B = { x0: 218, x1: 338, y0: 112, y1: 176 };
const DOOR = { x0: 188, x1: 210, y0: 126, y1: 170 };
const NEON = { x: 368, y: 76 };
const LAMP = { x: 432, y: 60 };
const VENDING = { x0: 394, x1: 412, y0: 156, y1: 192 };
/** The way everything falls: a little to the left, on a wind from the right. */
const SLANT = -0.13;

const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const pack = (r, g, b) => (0xff000000 | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;

/** Light laid on what is already painted, in dithered steps so it stays pixels. */
function addGlow(art, cx, cy, rx, ry, hex, strength, steps = 7) {
  const [cr, cg, cb] = rgbOf(hex);
  const x0 = Math.max(0, Math.floor(cx - rx * 2));
  const x1 = Math.min(art.w, Math.ceil(cx + rx * 2));
  const y0 = Math.max(0, Math.floor(cy - ry * 2));
  const y1 = Math.min(art.h, Math.ceil(cy + ry * 2));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * art.w + x;
      const p = art.px[i];
      if (!(p >>> 24)) continue;
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const k = Math.floor(strength * Math.exp(-d) * steps + bayer(x, y)) / steps;
      if (k <= 0) continue;
      art.px[i] = pack(Math.min(255, (p & 255) + cr * k), Math.min(255, ((p >> 8) & 255) + cg * k), Math.min(255, ((p >> 16) & 255) + cb * k));
    }
  }
}

/** A round glow as a sprite to be added on top, its alpha in dithered steps. */
function glowSprite(rx, ry, hex, peak, steps = 8, power = 1) {
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

/** A stroke some pixels thick. */
function thick(art, x0, y0, x1, y1, r, c) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= steps; i += 1) {
    const k = i / steps;
    if (r <= 0.6) art.put(Math.round(mix(x0, x1, k)), Math.round(mix(y0, y1, k)), c);
    else art.disc(mix(x0, x1, k), mix(y0, y1, k), r, c);
  }
}

/* ── the sky and what is far off ────────────────────────────────── */

function paintSky() {
  const SKY = ramp('#070814', '#0a0c1c', '#0e1026', '#131530', '#191a3a', '#211f44', '#2b244d', '#382a55', '#4a3159', '#5e395a');
  const n = noise2(5502, 64);
  const sky = new Art();
  sky.shade(SKY, (x, y) => {
    const low = (y / 165) ** 1.5;
    const city = 0.3 * Math.exp(-(((x - 300) / 190) ** 2));
    return clamp(0.04 + low * 0.62 + city * low + (fbm2(n, x / 40, y / 22, 3) - 0.5) * 0.26);
  }, 0.95);
  return sky;
}

/** Low rain cloud, joined at the seam, lit a little from under by the town. */
function paintClouds() {
  const CLOUD = ramp('#0f1128', '#151632', '#1d1c3e', '#272249', '#342853', '#44305b');
  const n = noise2(5503, 32);
  const art = new Art(960, 96);
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < 960; x += 1) {
      const d = fbm2(n, x / 30, y / 18, 4);
      const edge = d - 0.47 + (y / 96) * 0.08 - (y > 70 ? (y - 70) * 0.012 : 0);
      if (edge < 0) continue;
      art.tone(x, y, CLOUD, clamp(edge * 2.2 + (y / 96) * 0.55), 0.9);
    }
  }
  return art;
}

/** Everything behind the café: towers in the rain, and the tall dark building. */
function paintBack(rand) {
  const art = new Art();
  const towers = (colours, list, lights) => {
    for (const [x, w, top, cap] of list) {
      for (let y = top; y < FOOT; y += 1) {
        for (let i = x; i < x + w; i += 1) {
          const side = i > x + w - 3 ? 0.14 : 0;
          art.tone(i, y, colours, clamp(0.1 + ((y - top) / 120) * 0.8 - side), 0.8);
        }
      }
      if (cap === 'mast') art.rect(x + (w >> 1), top - 9, 1, 9, colours[1]);
      if (cap === 'step') art.rect(x + 4, top - 5, w - 8, 5, colours[0]);
      for (let wy = top + 4; wy < 150; wy += 5) {
        for (let wx = x + 2; wx < x + w - 2; wx += 4) {
          if (rand() < lights) art.put(wx, wy, rgba(rand() < 0.7 ? '#b98a5e' : '#7fa0b8'));
        }
      }
    }
  };
  towers(ramp('#17183e', '#1c1b45', '#23204c', '#2c2552', '#362a57'), [[-4, 26, 15], [20, 24, 4, 'mast'], [42, 30, 14, 'step'], [70, 22, 9], [90, 34, 17, 'step'], [124, 26, 7, 'mast'], [150, 40, 15], [190, 28, 5], [216, 40, 13, 'step'], [254, 22, 20], [440, 24, 30, 'mast'], [462, 30, 46]], 0.16);
  towers(ramp('#101130', '#14143a', '#1a1841', '#211c47', '#2a204c'), [[4, 18, 17], [54, 20, 19, 'mast'], [108, 18, 21], [172, 20, 20], [232, 18, 22, 'mast'], [452, 22, 64, 'step']], 0.2);

  // The tall dark building, lifted out of the street's glow.
  const TALL = ramp('#090a17', '#0d0e1f', '#121228', '#171631', '#1e1a39', '#271f41', '#322448');
  const x0 = 262;
  const x1 = 452;
  const top = 24;
  const grain = noise2(5504, 64);
  art.shade(TALL, (x, y) => {
    const glow = ((y - top) / (FOOT - top)) ** 2;
    const wet = (fbm2(grain, x / 5, y / 30, 2) - 0.5) * 0.22;
    return clamp(0.1 + glow * 0.56 + wet + (x > 438 ? -0.1 : 0) + (x < 266 ? 0.05 : 0));
  }, 0.8, [x0, top, x1, FOOT]);
  // A band every few floors and a stepped parapet, so it has a top.
  art.rect(x0 - 2, top - 3, x1 - x0 + 4, 3, rgba('#171731'));
  art.rect(x0 - 2, top - 3, x1 - x0 + 4, 1, rgba('#2c2c54'));
  art.rect(x0 + 40, top - 7, 66, 4, rgba('#10102a'));
  art.rect(x0 + 40, top - 7, 66, 1, rgba('#262649'));
  for (let i = x0; i < x1; i += 4) art.rect(i, top, 2, 2, rgba('#0a0a1a'));

  const GLASS = rgba('#0b1024');
  const SHEEN = rgba('#1a2547');
  const SILL = rgba('#2a2747');
  const windows = [];
  for (let row = 0; row < 8; row += 1) {
    const y = top + 8 + row * 17;
    art.rect(x0, y - 4, x1 - x0, 1, rgba('#0a0a1a'));
    for (let col = 0; col < 12; col += 1) {
      const x = x0 + 6 + col * 15 + (col > 5 ? 2 : 0);
      if (x + 9 > x1) continue;
      art.rect(x - 1, y - 1, 11, 13, rgba('#0a0a18'));
      art.rect(x, y, 9, 11, GLASS);
      art.put(x + 1, y + 1, SHEEN);
      art.rect(x + 1, y + 2, 1, 3, SHEEN);
      art.rect(x, y + 5, 9, 1, rgba('#070a18'));
      art.rect(x + 4, y, 1, 11, rgba('#070a18'));
      art.rect(x - 1, y + 11, 11, 1, SILL);
      windows.push({ x, y, col, row });
    }
  }
  // Those lit for good, and those that come and go on periods of their own.
  const warm = ['#e8b064', '#f0c67e', '#d99a58', '#e6bb88'];
  const glowing = [];
  for (const w of windows) {
    const r = rand();
    if (w.x > 408 && w.y < 100) continue;
    if (r < 0.14) {
      const tone = warm[Math.floor(rand() * warm.length)];
      art.rect(w.x, w.y, 9, 11, rgba(tone));
      art.rect(w.x, w.y, 9, 3, rgba('#8d6240'));
      art.rect(w.x + 4, w.y, 1, 11, rgba('#5f4133'));
      art.rect(w.x, w.y + 5, 9, 1, rgba('#5f4133'));
      if (rand() < 0.5) art.rect(w.x + 5, w.y + 7, 3, 4, rgba('#6a4834'));
      glowing.push(w);
    } else if (r < 0.26) {
      w.period = 37 + rand() * 90;
      w.phase = rand();
      w.tone = rand() < 0.75 ? warm[Math.floor(rand() * warm.length)] : '#a8c4d8';
      w.dynamic = true;
    }
  }
  for (const w of glowing) addGlow(art, w.x + 4, w.y + 6, 9, 9, '#3a2410', 0.5, 4);

  // A fire escape down the right of the front, picked out by the street below.
  const IRON = rgba('#25233f');
  const IRON_LIT = rgba('#4a3d5c');
  for (let f = 0; f < 6; f += 1) {
    const y = top + 52 + f * 17;
    art.rect(414, y + 8, 24, 1, IRON_LIT);
    art.rect(414, y + 9, 24, 1, IRON);
    art.rect(414, y + 3, 1, 5, IRON);
    art.rect(437, y + 3, 1, 5, IRON);
    art.rect(414, y + 3, 24, 1, IRON);
    for (let i = 418; i < 437; i += 3) art.rect(i, y + 4, 1, 4, IRON);
    art.line(f % 2 ? 416 : 435, y + 8, f % 2 ? 435 : 416, y + 25, IRON_LIT);
  }

  // The roof: a water tank on legs, an aerial with a slow red light.
  const TANK = ramp('#0d0e20', '#141429', '#1c1a34', '#262040');
  art.shade(TANK, (x) => clamp(0.8 - (x - 372) / 26), 0.7, [372, 6, 398, 17]);
  art.poly([[370, 7], [385, 1], [400, 7]], rgba('#10112a'));
  for (let x = 372; x < 398; x += 5) art.rect(x, 7, 1, 10, rgba('#0b0c1c'));
  for (const x of [374, 384, 395]) art.rect(x, 17, 2, 6, rgba('#0b0c1c'));
  art.line(374, 22, 395, 18, rgba('#141429'));
  art.rect(296, 4, 1, 16, rgba('#1a1a3a'));
  art.rect(293, 9, 7, 1, rgba('#1a1a3a'));
  art.rect(294, 13, 5, 1, rgba('#1a1a3a'));
  return { art, windows: windows.filter((w) => w.dynamic) };
}

/* ── the café, seen through wet air ──────────────────────────────── */

/**
 * A person at a round table, side on, elbow down and a book held up to the light.
 * Pose 0 reads, 1 turns a page, 2 drinks, 3 looks up. "hair" is a knot or a short crop.
 */
function reader(m, ox, oy, pose, dir = 1, hair = 'knot') {
  const c = 255;
  const X = (dx) => ox + dir * dx;
  const P = (list) => list.map(([dx, dy]) => [X(dx), oy + dy]);
  // A bentwood chair: a hoop behind the back, a seat, two legs.
  thick(m, X(-8), oy + 5, X(-12), oy - 8, 0.5, 200);
  thick(m, X(-12), oy - 8, X(-9), oy - 14, 0.5, 200);
  thick(m, X(-10), oy + 5, X(5), oy + 5, 0.9, 210);
  thick(m, X(-8), oy + 6, X(-11), oy + 18, 0.5, 200);
  thick(m, X(3), oy + 6, X(6), oy + 18, 0.5, 200);
  // The back and shoulders, rounded and leaning in.
  m.poly(P([[-5, 5], [6, 5], [7, -5], [9, -13], [8, -18], [3, -22], [-3, -21], [-6, -15], [-6, -5]]), c);
  const tip = pose === 2 ? -1.5 : pose === 3 ? -1 : 1;
  const rise = pose === 3 ? -1 : 0;
  const hx = X(5 + tip);
  const hy = oy - 28 + rise;
  thick(m, X(3), oy - 21, hx - dir, hy + 3, 2.4, c); // the neck
  m.ellipse(hx, hy, 4.8, 5.6, c);
  m.put(hx + dir * 5, hy + 1, c); // the nose
  m.put(hx + dir * 4, hy + 4, c); // the chin
  if (hair === 'knot') {
    m.disc(hx - dir * 2, hy - 2, 5, c);
    m.disc(hx - dir * 6, hy - 5, 2.8, c);
  } else {
    m.disc(hx - dir * 1, hy - 3, 4.8, c);
    m.rect(Math.min(hx - dir * 5, hx - dir * 3), hy - 2, 3, 4, c);
  }
  // The table, on one leg, with the cup and saucer on it unless she has the cup.
  m.rect(Math.min(X(8), X(46)), oy, 39, 2, c);
  m.rect(Math.min(X(26), X(28)), oy + 2, 3, 18, c);
  if (pose !== 2) {
    m.rect(Math.min(X(35), X(40)), oy - 6, 6, 6, c);
    m.line(X(41), oy - 5, X(42), oy - 2, c);
    m.rect(Math.min(X(33), X(43)), oy - 1, 11, 1, c);
  }
  if (pose === 2) {
    // The arm up to the mouth, the book left open on the table.
    thick(m, X(5), oy - 17, X(13), oy - 8, 1.6, c);
    thick(m, X(13), oy - 8, hx + dir * 8, hy + 6, 1.2, c);
    m.rect(Math.min(hx + dir * 6, hx + dir * 11), hy + 1, 6, 5, c);
    thick(m, X(15), oy - 1, X(23), oy - 3, 0.5, c);
    thick(m, X(23), oy - 3, X(31), oy - 1, 0.5, c);
  } else {
    // Elbow on the table, forearm up, an open book in the hand.
    thick(m, X(5), oy - 17, X(13), oy - 3, 1.7, c);
    thick(m, X(13), oy - 3, X(20), oy - 11, 1.2, c);
    // The book, open towards her: the pages paler, the boards dark, the spine away from her.
    m.poly(P([[28, -13], [18, -22], [19, -7]]), 130);
    thick(m, X(28), oy - 13, X(18), oy - 22, 0.8, c);
    thick(m, X(28), oy - 13, X(19), oy - 7, 0.8, c);
    if (pose === 1) thick(m, X(27), oy - 13, X(24), oy - 25, 0.5, 220); // a page, going over
  }
}

/** Bottles on a shelf, some taller, faint behind the steam. */
function shelf(m, x0, x1, y, rand) {
  m.rect(x0, y, x1 - x0, 2, 200);
  for (let x = x0 + 2; x < x1 - 2; x += 4 + Math.floor(rand() * 3)) {
    const tall = 5 + Math.floor(rand() * 6);
    const c = 90 + Math.floor(rand() * 70);
    m.rect(x, y - tall, 3, tall, c);
    m.rect(x + 1, y - tall - 2, 1, 2, c);
  }
}

/** A lamp on a cord: the shade is dark, the light under it is not. */
function pendant(m, x, y) {
  m.rect(x, 110, 1, y - 110, 190);
  m.poly([[x - 2, y], [x + 3, y], [x + 7, y + 6], [x - 6, y + 6]], 235);
}

/** Warm glass. The figures sit behind steam that gets thicker low down, with one patch wiped clear. */
function paintGlass(art, g, o, box = null) {
  const WARM = ramp('#2b1416', '#451e17', '#63301a', '#87451d', '#ad5e22', '#d07e2a', '#eba138', '#fac354', '#ffdc7e', '#ffeead', '#fff8d8');
  const w = g.x1 - g.x0;
  const h = g.y1 - g.y0;
  const m = new Art(w, h);
  o.figures(m, -g.x0, -g.y0);
  const soft = new Float32Array(w * h);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (m.px[y * w + x] & 255) / 255);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      soft[y * w + x] = at(x, y) * 0.5 + (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.125;
    }
  }
  const [bx0, by0, bx1, by1] = box || [g.x0, g.y0, g.x1, g.y1];
  for (let y = by0; y < by1; y += 1) {
    for (let x = bx0; x < bx1; x += 1) {
      const lx = x - g.x0;
      const ly = y - g.y0;
      const room = o.room(x, y);
      const lit = room * (1 - soft[ly * w + lx] * 0.86);
      const mist = fbm2(o.fog, x / 22, y / 11, 3);
      const edge = Math.min(lx, w - 1 - lx) < 7 ? (7 - Math.min(lx, w - 1 - lx)) * 0.03 : 0;
      let fog = clamp(0.08 + (mist - 0.5) * 1.15 + 0.7 * (ly / h) ** 2.4 + edge);
      for (const c of o.clear) fog *= 0.16 + 0.84 * smooth(clamp((Math.hypot((x - c[0]) / c[2], (y - c[1]) / c[3]) - 0.74) / 0.42));
      for (const run of o.runs) if (x === run[0] && y > run[1] && y < run[2]) fog *= 0.55;
      art.tone(x, y, WARM, clamp(mix(lit, 0.74 + (mist - 0.5) * 0.16, fog)), 0.66);
    }
  }
}

/** The left-hand room: a lamp over the reader's table, one over the shelves, a dim far corner. */
function roomA(x, y) {
  const wall = 0.34 - (y - 112) * 0.0012 + (x % 30 === 0 ? -0.03 : 0);
  const a = 0.54 * Math.exp(-(((x - 116) / 34) ** 2 + ((y - 138) / 30) ** 2));
  const b = 0.5 * Math.exp(-(((x - 54) / 22) ** 2 + ((y - 134) / 22) ** 2));
  const core = 0.6 * Math.exp(-(((x - 116) / 6) ** 2 + ((y - 134.5) / 2.2) ** 2)) + 0.6 * Math.exp(-(((x - 54) / 6) ** 2 + ((y - 132.5) / 2.2) ** 2));
  const c = 0.28 * Math.exp(-(((x - 166) / 16) ** 2 + ((y - 134) / 26) ** 2));
  return clamp(wall + a + b + c + core);
}

const CLEAR_A = [[108, 151, 40, 27]];

function paintFront(rand) {
  const art = new Art();
  const brickTone = seeded(5505);
  const table = Float32Array.from({ length: 256 }, () => brickTone());
  const LIT = [GLASS_A, GLASS_B, DOOR];
  const spill = (x, y, r2 = 520) => {
    let sum = 0;
    for (const g of LIT) {
      const dx = x < g.x0 ? g.x0 - x : x > g.x1 ? x - g.x1 : 0;
      const dy = y < 125 ? 125 - y : y > g.y1 ? y - g.y1 : 0;
      sum += Math.exp(-(dx * dx + dy * dy) / r2);
    }
    return clamp(sum);
  };

  // The roof in slate, dormers set in it, two chimneys.
  const SLATE = ramp('#0a0c1c', '#0f1226', '#151932', '#1d223e', '#28304e', '#3a4564');
  for (const [x, w, top, bottom] of [[106, 20, 8, 32], [298, 16, 12, 32]]) {
    art.shade(ramp('#120f1e', '#1d1526', '#2a1b2c', '#3b2332', '#4f2e37'), (px, py) => clamp(0.62 - (px - x) / (w * 1.5) + (py % 4 === 3 ? -0.2 : 0) + ((px + (Math.floor(py / 4) % 2) * 3) % 6 === 5 ? -0.14 : 0)), 0.6, [x, top, x + w, bottom]);
    art.rect(x - 2, top - 2, w + 4, 3, rgba('#332733'));
    art.rect(x - 2, top - 2, w + 4, 1, rgba('#4d3f52'));
    for (let i = x + 2; i < x + w - 3; i += 6) {
      art.rect(i, top - 7, 3, 5, rgba('#231a28'));
      art.rect(i, top - 7, 1, 5, rgba('#3b2d40'));
    }
  }
  const slateGrain = noise2(5506, 64);
  art.poly([[24, 52], [34, 28], [328, 28], [338, 52]], (x, y) => {
    const row = Math.floor((y - 28) / 3);
    const joint = (y - 28) % 3 === 2 ? -0.18 : (x + row * 4) % 8 === 7 ? -0.14 : 0;
    const wet = fbm2(slateGrain, x / 2.5, y / 20, 2) - 0.5;
    art.tone(x, y, SLATE, clamp(0.26 + ((y - 28) / 24) * 0.2 + joint + wet * 0.5), 0.6);
  });
  art.rect(34, 27, 294, 1, rgba('#39415f'));
  [64, 164, 266].forEach((x, i) => {
    const lit = i !== 1;
    art.poly([[x - 16, 32], [x, 19], [x + 16, 32]], rgba('#1b2038'));
    thick(art, x - 16, 32, x, 19, 0.5, rgba('#4a5478'));
    thick(art, x, 19, x + 16, 32, 0.5, rgba('#2c3350'));
    art.rect(x - 12, 32, 24, 18, rgba('#15182c'));
    art.rect(x - 9, 33, 18, 15, rgba(lit ? '#f0b65c' : '#121a33'));
    if (lit) {
      art.rect(x - 9, 33, 18, 3, rgba('#ffd98a'));
      art.rect(x - 9, 33, 4, 15, rgba('#c4823f'));
      art.rect(x + 5, 33, 4, 15, rgba('#c4823f'));
    } else {
      art.rect(x - 8, 34, 2, 5, rgba('#26335a'));
    }
    art.rect(x - 1, 33, 2, 15, rgba('#201623'));
    art.rect(x - 9, 40, 18, 1, rgba('#201623'));
    art.rect(x - 12, 48, 24, 2, rgba('#39415f'));
  });

  // A stone cornice with a row of little brackets under it.
  const STONE = ramp('#14142a', '#1e1c34', '#2b2640', '#3d3550', '#574a64', '#7b6a7a');
  art.rect(20, 52, 322, 6, STONE[2]);
  art.rect(20, 52, 322, 1, STONE[5]);
  art.rect(20, 53, 322, 1, STONE[3]);
  art.rect(20, 57, 322, 1, STONE[0]);
  for (let x = 24; x < 340; x += 6) {
    art.rect(x, 58, 3, 3, STONE[1]);
    art.rect(x, 58, 1, 3, STONE[2]);
  }

  // Brick, course by course, the wet running down it and the café's light rising up it.
  const BRICK = ramp('#0b0c1a', '#101022', '#17152b', '#211933', '#2e1e37', '#402338', '#572a37', '#723335', '#934232', '#b85733');
  const streak = noise2(5507, 64);
  for (let y = 58; y < 98; y += 1) {
    const row = Math.floor(y / 4);
    for (let x = 20; x < 342; x += 1) {
      const sx = x + (row % 2) * 5;
      const joint = y % 4 === 3 || sx % 10 === 9;
      const stone = table[(row * 37 + Math.floor(sx / 10) * 13) & 255];
      const wet = fbm2(streak, x / 6, y / 26, 2) - 0.5;
      const lift = ((y - 58) / 40) ** 2 * 0.3;
      art.tone(x, y, BRICK, clamp(0.2 + lift + (stone - 0.5) * 0.16 + wet * 0.32 - (joint ? 0.13 : 0)), 0.65);
    }
  }
  art.rect(20, 58, 2, 40, rgba('#0e0e1c'));
  art.rect(340, 58, 2, 40, rgba('#201528'));

  // Five windows upstairs, each with a stone head and a box of something growing.
  const LEAF = ramp('#0a1a18', '#112620', '#1c3628', '#2c4a2f');
  const upstairs = [];
  [46, 106, 166, 226, 286].forEach((x, i) => {
    const kind = ['warm', 'dark', 'dim', 'blue', 'dark'][i];
    const y = 64;
    art.rect(x - 2, y - 3, 34, 3, STONE[3]);
    art.rect(x - 2, y - 3, 34, 1, STONE[4]);
    art.rect(x - 1, y, 32, 26, rgba('#0c0c1a'));
    art.rect(x, y + 1, 30, 24, rgba({ warm: '#efb663', dark: '#0e1530', dim: '#8f5a39', blue: '#1b2748' }[kind]));
    if (kind === 'warm') {
      art.shade(ramp('#c98644', '#e3a553', '#f4c26c', '#ffdc92'), (px, py) => clamp(0.95 - Math.hypot(px - x - 15, py - y - 9) / 20), 0.8, [x, y + 1, x + 30, y + 25]);
      // Curtains, drawn back.
      for (let k = 0; k < 8; k += 1) {
        art.rect(x, y + 1 + k * 3, 7 - (k > 4 ? k - 4 : 0), 3, rgba('#a4613a'));
        art.rect(x + 23 + (k > 4 ? k - 4 : 0), y + 1 + k * 3, 7 - (k > 4 ? k - 4 : 0), 3, rgba('#a4613a'));
      }
      art.rect(x + 12, y + 15, 7, 10, rgba('#6e4630'));
      art.disc(x + 15, y + 12, 5, rgba('#5f4030'));
    }
    if (kind === 'dim') {
      art.rect(x, y + 1, 30, 11, rgba('#6f4530'));
      art.rect(x + 2, y + 12, 26, 13, rgba('#a56b42'));
    }
    if (kind === 'dark') {
      art.rect(x + 3, y + 3, 2, 8, rgba('#233056'));
      art.put(x + 6, y + 3, rgba('#233056'));
    }
    art.rect(x + 14, y + 1, 2, 24, rgba('#0c0c1a'));
    art.rect(x, y + 12, 30, 1, rgba('#0c0c1a'));
    art.rect(x - 3, y + 26, 36, 2, STONE[4]);
    art.rect(x - 3, y + 28, 36, 3, rgba('#1a1420'));
    for (let k = 0; k < 18; k += 1) {
      const px = x - 2 + Math.floor(rand() * 34);
      const py = y + 24 - Math.floor(rand() * 3);
      art.disc(px, py, 1.3 + rand() * 1.4, LEAF[Math.floor(rand() * 4)]);
      if (rand() < 0.3) art.put(px, py - 1, rgba(rand() < 0.5 ? '#c86b77' : '#d8a35a'));
    }
    upstairs.push({ x, y, kind });
  });

  // The ground floor: painted wood, a fascia with a gold line, and the glass.
  const WOOD = ramp('#081214', '#0b181a', '#102120', '#172a25', '#213228', '#303829', '#463e2b', '#624a2e', '#855c33');
  art.shade(WOOD, (x, y) => clamp(0.1 + spill(x, y) * 0.74), 0.7, [18, 98, 344, FOOT]);
  art.shade(WOOD, (x, y) => clamp(0.16 + ((y - 98) / 10) * 0.08 + (x % 40 === 0 ? -0.1 : 0)), 0.7, [18, 98, 344, 108]);
  art.rect(18, 98, 326, 1, rgba('#415048'));
  art.rect(22, 100, 318, 1, rgba('#a68640'));
  art.rect(22, 105, 318, 1, rgba('#7c6233'));
  art.rect(22, 100, 1, 6, rgba('#a68640'));
  art.rect(339, 100, 1, 6, rgba('#a68640'));
  // Small brass lamps over the fascia, each with a pool of light under it.
  for (const x of [84, 186, 288]) {
    art.rect(x, 94, 1, 3, rgba('#4b3a2a'));
    art.rect(x - 2, 96, 5, 1, rgba('#7c6233'));
    art.rect(x - 1, 97, 3, 1, rgba('#ffe7a4'));
    addGlow(art, x, 100, 11, 5, '#6d4a1c', 0.9, 5);
  }
  // A plain row of diamonds where a name would be.
  for (let x = 150; x <= 222; x += 12) {
    art.rect(x, 102, 2, 2, rgba('#c8a24c'));
    art.put(x, 102, rgba('#f0d27a'));
  }

  const fog = noise2(5508, 64);
  const figuresA = (pose) => (m, ox, oy) => {
    pendant(m, 116 + ox, 128 + oy);
    pendant(m, 54 + ox, 126 + oy);
    const local = seeded(5511);
    shelf(m, 38 + ox, 72 + ox, 148 + oy, local);
    shelf(m, 38 + ox, 72 + ox, 162 + oy, local);
    m.rect(150 + ox, 150 + oy, 22, 26, 130); // a dresser against the far wall
    m.rect(148 + ox, 148 + oy, 26, 2, 170);
    m.rect(156 + ox, 136 + oy, 10, 12, 90); // a picture over it
    reader(m, 92 + ox, 168 + oy, pose);
  };
  paintGlass(art, GLASS_A, { room: roomA, fog, figures: figuresA(0), clear: CLEAR_A, runs: [[47, 132, 170], [66, 120, 174], [148, 128, 170], [168, 136, 176], [156, 118, 168]] });

  const roomB = (x, y) => {
    const wall = 0.32 - (y - 112) * 0.001;
    const a = 0.5 * Math.exp(-(((x - 244) / 24) ** 2 + ((y - 136) / 22) ** 2));
    const b = 0.56 * Math.exp(-(((x - 292) / 26) ** 2 + ((y - 138) / 24) ** 2));
    const core = 0.6 * Math.exp(-(((x - 244) / 6) ** 2 + ((y - 133.5) / 2.2) ** 2)) + 0.6 * Math.exp(-(((x - 292) / 6) ** 2 + ((y - 133.5) / 2.2) ** 2));
    return clamp(wall + a + b + core);
  };
  const figuresB = (m, ox, oy) => {
    pendant(m, 244 + ox, 127 + oy);
    pendant(m, 292 + ox, 127 + oy);
    // The counter across the back, a machine on it, cups on a rack.
    m.rect(222 + ox, 158 + oy, 66, 20, 120);
    m.rect(220 + ox, 156 + oy, 70, 2, 170);
    m.rect(258 + ox, 141 + oy, 18, 15, 150);
    m.rect(256 + ox, 139 + oy, 22, 2, 190);
    m.rect(262 + ox, 151 + oy, 2, 3, 190);
    m.rect(270 + ox, 151 + oy, 2, 3, 190);
    m.rect(224 + ox, 138 + oy, 26, 1, 130);
    for (let x = 226; x < 250; x += 5) m.rect(x + ox, 139 + oy, 3, 3, 100);
    reader(m, 324 + ox, 168 + oy, 0, -1, 'short');
  };
  paintGlass(art, GLASS_B, { room: roomB, fog, figures: figuresB, clear: [[302, 151, 34, 27]], runs: [[232, 124, 172], [250, 134, 170], [278, 118, 176]] });

  const roomDoor = (x, y) => clamp(0.4 + 0.5 * Math.exp(-(((x - 199) / 16) ** 2 + ((y - 146) / 20) ** 2)));

  // Frames and glazing bars: dark on the street side, warm where the light catches the edge.
  const FRAME = rgba('#160f18');
  const EDGE = rgba('#5e3a22');
  const frame = (g, bars) => {
    art.rect(g.x0 - 2, g.y0, 2, g.y1 - g.y0 + 2, FRAME);
    art.rect(g.x1, g.y0, 2, g.y1 - g.y0 + 2, FRAME);
    art.rect(g.x0 - 2, g.y1, g.x1 - g.x0 + 4, 2, FRAME);
    art.rect(g.x0, g.y1 - 1, g.x1 - g.x0, 1, EDGE);
    for (const x of bars) {
      art.rect(x, g.y0, 2, g.y1 - g.y0, FRAME);
      art.rect(x + 2, g.y0, 1, g.y1 - g.y0, EDGE);
    }
    art.rect(g.x0, 129, g.x1 - g.x0, 1, FRAME);
    art.rect(g.x0, 130, g.x1 - g.x0, 1, EDGE);
  };
  frame(GLASS_A, [74, 142]);
  frame(GLASS_B, [256, 300]);
  // The door: a dark frame, panel under the glass, a brass handle, a lit step.
  art.rect(184, 108, 30, FOOT - 108, rgba('#0d1a1b'));
  art.rect(186, 112, 26, FOOT - 112, rgba('#132320'));
  art.shade(WOOD, (x, y) => clamp(0.12 + spill(x, y) * 0.4), 0.7, [186, 170, 212, FOOT]);
  paintGlass(art, DOOR, { room: roomDoor, fog, figures: () => {}, clear: [], runs: [[194, 134, 168], [204, 140, 168]] });
  art.rect(186, 170, 26, 2, FRAME);
  art.rect(186, 124, 26, 2, FRAME);
  art.rect(186, 124, 2, 48, FRAME);
  art.rect(210, 124, 2, 48, FRAME);
  art.rect(190, 175, 18, 13, rgba('#0f1d1c'));
  art.rect(190, 175, 18, 1, rgba('#2d3c2c'));
  art.rect(207, 150, 1, 9, rgba('#e2bb64'));
  art.rect(206, 150, 2, 1, rgba('#fff0a8'));
  art.rect(184, 190, 30, 2, rgba('#3d2a22'));

  // Panels under the glass, each with a gold bead around it.
  for (const [x0, x1] of [[34, 182], [216, 340]]) {
    for (let x = x0 + 2; x < x1 - 10; x += 37) {
      const w = Math.min(34, x1 - x - 3);
      art.rect(x, 180, w, 9, rgba('#0d1a1b'));
      art.rect(x, 180, w, 1, rgba('#27372d'));
      art.rect(x + 1, 181, w - 2, 7, rgba('#132320'));
      art.rect(x + 2, 182, w - 4, 1, rgba('#3b4a31'));
    }
  }

  // The sills: a dark ledge, herbs in small pots.
  const pot = (x, tall) => {
    art.rect(x - 3, 171, 7, 5, rgba('#2c1510'));
    art.rect(x - 4, 170, 9, 1, rgba('#3f1f14'));
    art.put(x + 3, 172, rgba('#6e3a1e'));
    for (let k = 0; k < 7; k += 1) {
      const lean = (rand() - 0.5) * 7;
      const top = 169 - tall * (0.5 + rand() * 0.5);
      art.line(x, 170, Math.round(x + lean), Math.round(top), rgba('#10150f'));
      art.disc(x + lean, top, 1 + rand() * 0.8, rgba('#141a12'));
    }
  };
  for (const [x, tall] of [[42, 7], [58, 10], [68, 6], [150, 9], [164, 7], [288, 8], [314, 6], [332, 9]]) pot(x, tall);
  for (const [x0, x1] of [[36, 180], [218, 338]]) {
    art.rect(x0 - 2, 176, x1 - x0 + 4, 4, rgba('#1a1218'));
    art.rect(x0 - 2, 176, x1 - x0 + 4, 1, rgba('#7a5230'));
  }

  // The awning: stripes that close up towards the wall, wet on top, lit from under at the fringe.
  const RED = ramp('#2a0e20', '#3f1226', '#5e1a2c', '#842431', '#a93337', '#cd4c3c', '#e96f47');
  const CREAM = ramp('#2d2534', '#453743', '#675449', '#8e7656', '#b79a68', '#d9bd85', '#f0d8a4');
  const STRIPES = 26;
  const wetTop = noise2(5509, 64);
  for (let y = 108; y <= 120; y += 1) {
    const k = (y - 108) / 12;
    const a = mix(30, 24, k);
    const b = mix(332, 338, k);
    for (let x = Math.round(a); x < Math.round(b); x += 1) {
      const s = Math.floor(((x - a) / (b - a)) * STRIPES);
      const run = fbm2(wetTop, x / 2.4, y / 16, 2) - 0.5;
      art.tone(x, y, s % 2 ? CREAM : RED, clamp(0.18 + k * 0.3 + run * 0.5), 0.75);
    }
  }
  art.rect(30, 107, 302, 1, rgba('#151320'));
  const fringeTop = 121;
  const drips = [];
  for (let s = 0; s < STRIPES; s += 1) {
    const a = 24 + (s * (338 - 24)) / STRIPES;
    const b = 24 + ((s + 1) * (338 - 24)) / STRIPES;
    const colours = s % 2 ? CREAM : RED;
    for (let x = Math.round(a); x < Math.round(b); x += 1) {
      const k = (x + 0.5 - a) / (b - a);
      const drop = Math.sqrt(Math.max(0, 1 - (k * 2 - 1) ** 2)) * 4;
      const end = fringeTop + 3 + drop;
      for (let y = fringeTop; y < end; y += 1) {
        const glow = 0.3 + ((y - fringeTop) / 7) * 0.22 + spill(x, y + 8) * 0.42;
        art.tone(x, y, colours, clamp(glow - (y > end - 2 ? 0.1 : 0)), 0.5);
      }
    }
    drips.push({ x: Math.round((a + b) / 2), y: fringeTop + 7 });
  }
  // A line of piping where the fringe meets the slope.
  for (let x = 24; x < 338; x += 1) art.put(x, 120, rgba((x + 3) % 7 < 4 ? '#6a5a5e' : '#e8d0a0'));

  // Bay trees on the step, a board on the pavement, a table left out in the rain.
  const topiary = (x) => {
    art.rect(x - 4, 186, 9, 7, rgba('#2a1818'));
    art.rect(x - 5, 186, 11, 1, rgba('#5e3a26'));
    art.rect(x, 170, 1, 16, rgba('#21130f'));
    const list = [];
    for (let i = 0; i < 30; i += 1) {
      const a = rand() * TAU;
      const r = Math.sqrt(rand()) * 7;
      list.push([x + Math.cos(a) * r, 160 + Math.sin(a) * r, 1.5 + rand() * 1.8]);
    }
    for (const [px, py, r] of list) art.disc(px, py, r, rgba('#0c1c18'));
    for (const [px, py, r] of list) {
      if (rand() < 0.5) {
        const inner = px > x ? '#2d4326' : '#16302a';
        art.disc(px + (px > x ? 0.5 : -0.5), py - 0.5, r * 0.5, rgba(inner));
      }
      if (rand() < 0.22) art.put(px + (px < x ? -1 : 1), py, rgba('#8c7a32'));
    }
  };
  topiary(174);
  topiary(224);
  // A folded board, with nothing on it but a chalk flourish.
  art.poly([[308, 196], [312, 172], [328, 172], [332, 196]], rgba('#20171b'));
  art.poly([[310, 195], [313, 174], [327, 174], [330, 195]], rgba('#10161c'));
  art.line(316, 180, 324, 179, rgba('#a9a59a'));
  art.line(315, 184, 325, 184, rgba('#7e7c76'));
  for (let i = 0; i <= 8; i += 1) art.put(316 + i, 189 - Math.round(Math.sin((i / 8) * Math.PI) * 2), rgba('#8e8b84'));
  // Two chairs tipped against a small round table.
  art.rect(138, 186, 22, 2, rgba('#1a1c24'));
  art.rect(138, 186, 22, 1, rgba('#7a5a30'));
  art.rect(148, 188, 2, 9, rgba('#14151c'));
  art.rect(144, 196, 10, 1, rgba('#14151c'));
  for (const [x, dir] of [[132, 1], [166, -1]]) {
    art.line(x, 197, x + dir * 2, 184, rgba('#14151c'));
    art.line(x + dir * 6, 197, x + dir * 5, 190, rgba('#14151c'));
    art.rect(Math.min(x, x + dir * 6), 190, 7, 1, rgba('#2a2228'));
    art.line(x + dir * 2, 184, x + dir * 2, 179, rgba('#1a1c24'));
  }

  // A plain low building to the right: a shutter, a bracket, a machine that hums.
  const CONCRETE = ramp('#0d0e1c', '#121325', '#18182e', '#1f1d36', '#29223e', '#332746');
  const conc = noise2(5510, 64);
  art.shade(CONCRETE, (x, y) => clamp(0.15 + (y - 146) / 90 + (fbm2(conc, x / 6, y / 12, 2) - 0.5) * 0.3), 0.75, [342, 146, W, FOOT]);
  art.rect(342, 144, W - 342, 2, rgba('#1a1a30'));
  art.rect(342, 144, W - 342, 1, rgba('#363450'));
  art.shade(ramp('#101224', '#171a2e', '#1f2338', '#2a2f44', '#3a3f52'), (x, y) => clamp(0.15 + (y % 3 === 0 ? 0.32 : 0) + (y - 156) / 110), 0.45, [350, 156, 386, FOOT]);
  art.rect(349, 154, 38, 2, rgba('#2c2a3e'));
  art.rect(349, 156, 1, FOOT - 156, rgba('#0a0b18'));
  art.rect(386, 156, 1, FOOT - 156, rgba('#0a0b18'));
  art.rect(365, 188, 6, 2, rgba('#4a4656'));
  // The machine: lit rows behind glass, and a coin slot.
  art.rect(VENDING.x0 - 1, VENDING.y0 - 1, VENDING.x1 - VENDING.x0 + 2, VENDING.y1 - VENDING.y0 + 1, rgba('#11142a'));
  art.shade(ramp('#7ad5cf', '#a5ece0', '#d3f8ee', '#f2fff9'), (x, y) => clamp(1 - (y - VENDING.y0) / 34), 0.6, [VENDING.x0 + 1, VENDING.y0 + 1, VENDING.x1 - 5, 178]);
  for (let row = 0; row < 4; row += 1) {
    art.rect(VENDING.x0 + 1, 161 + row * 5, VENDING.x1 - VENDING.x0 - 6, 1, rgba('#2b6c78'));
    for (let i = 0; i < 5; i += 1) art.rect(VENDING.x0 + 2 + i * 2 + (row % 2), 158 + row * 5, 1, 3, rgba(['#d0445e', '#3b78b8', '#e39a3a', '#3a9a70', '#7a4ab8'][(i + row) % 5]));
  }
  art.rect(VENDING.x1 - 4, VENDING.y0 + 2, 3, 22, rgba('#1f2740'));
  for (let y = VENDING.y0 + 4; y < 176; y += 4) art.put(VENDING.x1 - 3, y, rgba('#8cf0d0'));
  art.rect(VENDING.x0 + 2, 181, 12, 7, rgba('#080a16'));
  art.rect(VENDING.x0 + 2, 181, 12, 1, rgba('#3d5f70'));

  // A door further along, its frame just catching the lamp.
  art.rect(446, 152, 22, FOOT - 152, rgba('#10111f'));
  art.rect(448, 154, 18, FOOT - 154, rgba('#191a2c'));
  art.rect(448, 154, 18, 1, rgba('#36385a'));
  art.rect(450, 158, 14, 13, rgba('#2b2e4b'));
  art.rect(451, 159, 3, 5, rgba('#4e557a'));
  art.rect(464, 174, 1, 4, rgba('#6a6a7c'));

  // The sign's bracket, its plate, and the tubes with no current in them.
  art.rect(342, 54, 8, 2, rgba('#2c2a3e'));
  art.rect(342, 54, 8, 1, rgba('#50506c'));
  art.line(342, 66, 350, 56, rgba('#25233a'));
  for (const hang of [354, 382]) art.rect(hang, 56, 1, 5, rgba('#2c2a3e'));
  art.rect(NEON.x - 18, NEON.y - 15, 36, 36, rgba('#141428'));
  art.rect(NEON.x - 18, NEON.y - 15, 36, 1, rgba('#3b3a58'));
  art.rect(NEON.x - 18, NEON.y - 15, 1, 36, rgba('#28274a'));
  art.rect(NEON.x - 18, NEON.y + 20, 36, 1, rgba('#0a0a1a'));
  art.rect(NEON.x + 17, NEON.y - 15, 1, 36, rgba('#0a0a1a'));

  // Pavement: flags in wet stone, warm under the glass.
  const PAVE = ramp('#0d0f1e', '#141628', '#1c1c30', '#272237', '#37293b', '#4f333d', '#6e423e', '#92553f', '#b9703f', '#df964b', '#f4bd64');
  const smear = noise1(5512, 256);
  const pools = [[58, 199, 17, 2.2], [120, 197, 12, 1.6], [256, 200, 20, 2.2], [326, 198, 13, 1.7], [392, 199, 16, 2]];
  for (let y = FOOT; y < KERB; y += 1) {
    const d = (y - FOOT) / (KERB - FOOT);
    const row = Math.floor((y - FOOT) / 4);
    for (let x = 0; x < W; x += 1) {
      const under = spill(x, 178, 360);
      const col = smear(x * 0.55) - 0.5;
      const pool = pools.some((p) => ((x - p[0]) / p[2]) ** 2 + ((y - p[1]) / p[3]) ** 2 < 1);
      const joint = !pool && ((y - FOOT) % 4 === 3 || (x + row * 9) % 22 === 21) ? -0.09 : 0;
      const lampPool = 0.46 * Math.exp(-(((x - LAMP.x) / 34) ** 2 + ((y - 200) / 9) ** 2));
      const machine = 0.2 * Math.exp(-(((x - 403) / 13) ** 2));
      const shine = under * (0.44 - d * 0.13 + col * 0.34) + (pool ? under * 0.1 + 0.035 : 0);
      art.tone(x, y, PAVE, clamp(0.13 + joint + shine + lampPool + machine), 0.7);
    }
  }
  // The kerb: a lit top, a dark face.
  for (let x = 0; x < W; x += 1) {
    const warm = spill(x, 180, 300);
    const lamp = 0.3 * Math.exp(-(((x - LAMP.x) / 40) ** 2));
    for (let y = KERB; y < KERB + 2; y += 1) art.tone(x, y, PAVE, clamp(0.22 + warm * 0.46 + lamp + (x % 30 === 0 ? -0.1 : 0)), 0.6);
    for (let y = KERB + 2; y < ROAD; y += 1) art.tone(x, y, PAVE, clamp(0.04 + warm * 0.08 + (x % 30 === 0 ? -0.04 : 0)), 0.6);
  }

  // A bicycle against the lamp, wet at every edge.
  const BIKE = rgba('#2a2b3e');
  const RIM = rgba('#7c7e9a');
  for (const cx of [448, 468]) {
    for (let a = 0; a < 32; a += 1) art.put(Math.round(cx + Math.cos((a / 32) * TAU) * 7), Math.round(193 + Math.sin((a / 32) * TAU) * 7), a % 8 < 3 ? RIM : BIKE);
    art.put(cx, 193, RIM);
  }
  art.line(448, 193, 455, 182, BIKE);
  art.line(455, 182, 464, 182, RIM);
  art.line(464, 182, 468, 193, BIKE);
  art.line(455, 182, 458, 193, BIKE);
  art.line(458, 193, 464, 182, BIKE);
  art.line(448, 193, 458, 193, BIKE);
  art.rect(451, 179, 7, 2, rgba('#1f1a20'));
  art.rect(463, 178, 1, 4, BIKE);
  art.rect(462, 177, 5, 1, RIM);

  return { art, drips, upstairs, spill };
}

/** The lamp stands apart so a person can pass behind it. */
function paintLamp() {
  const art = new Art();
  const { x } = LAMP;
  const POLE = ramp('#0c0d1a', '#16162a', '#25243e', '#3e3a58');
  for (let y = 70; y < KERB; y += 1) {
    const widen = y > 192 ? 2 : y > 180 ? 1 : 0;
    for (let i = -1 - widen; i <= 1 + widen; i += 1) art.put(x + i, y, POLE[i < -widen ? 3 : i > widen - 1 ? 0 : 1]);
  }
  for (const y of [86, 88, 178, 180, 190]) art.rect(x - 2, y, 5, 1, POLE[2]);
  art.rect(x - 6, 78, 13, 1, POLE[1]); // a ladder rest
  art.put(x - 6, 77, POLE[2]);
  art.put(x + 6, 77, POLE[2]);
  // A six-sided lantern: cap, three bright panes, a collar.
  art.poly([[x - 9, 52], [x, 44], [x + 9, 52]], POLE[1]);
  thick(art, x - 9, 52, x, 44, 0.5, POLE[3]);
  art.rect(x - 1, 39, 3, 5, POLE[1]);
  art.put(x, 38, POLE[3]);
  art.poly([[x - 9, 53], [x + 10, 53], [x + 6, 72], [x - 5, 72]], rgba('#ffe9a8'));
  art.poly([[x - 4, 54], [x + 5, 54], [x + 3, 71], [x - 2, 71]], rgba('#fffbe2'));
  art.line(x - 9, 53, x - 5, 72, POLE[0]);
  art.line(x + 9, 53, x + 6, 72, POLE[0]);
  art.line(x - 3, 53, x - 2, 72, POLE[1]);
  art.line(x + 4, 53, x + 3, 72, POLE[1]);
  art.rect(x - 10, 52, 21, 2, POLE[1]);
  art.rect(x - 6, 72, 13, 2, POLE[1]);
  art.rect(x - 3, 74, 7, 2, POLE[0]);
  return art;
}

/* ── the road, which holds everything ───────────────────────────── */

/**
 * The wet road as a few versions of itself, from dull to bright. A frame chooses
 * between them pixel by pixel through two sliding combs of streaks, which is what
 * makes a reflection shimmer without being painted again.
 */
function paintRoad(mirror) {
  const LEVELS = 3;
  const levels = new Uint32Array(W * ROWS * LEVELS);
  const grit = noise2(5520, 64);
  const damp = noise2(5521, 64);
  const off = noise1(5522, 256);
  const off2 = noise1(5523, 256);
  const puddles = [[120, 244, 58, 8], [292, 254, 46, 7], [60, 222, 32, 4], [360, 228, 26, 4], [440, 258, 34, 6], [210, 232, 26, 3]];
  for (let row = 0; row < ROWS; row += 1) {
    const y = ROAD + row;
    const k = row / ROWS;
    for (let x = 0; x < W; x += 1) {
      // Where this pixel is in the mirror: stretched more the nearer the eye.
      const pool = puddles.reduce((best, p) => Math.max(best, 1 - ((x - p[0]) / p[2]) ** 2 - ((y - p[1]) / p[3]) ** 2), -1);
      const still = smooth(clamp(pool * 3));
      const jag = (off(x * 0.9) - 0.5) * (6 + row * 0.9) * (1 - still * 0.85);
      const stretch = 1 + 1.5 * k;
      const my = FOOT - (ROAD + row - FOOT) * stretch + jag;
      const reach = (1 + row / 9) * (1 - still * 0.7);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = -2; j <= 2; j += 1) {
        const sy = clamp(Math.round(my + j * reach), 0, H - 1);
        const sx = clamp(x + (j % 2 ? Math.round(off2(x + j * 7) * 2 - 1) : 0), 0, W - 1);
        const p = mirror[sy * W + sx];
        r += p & 255;
        g += (p >> 8) & 255;
        b += (p >> 16) & 255;
      }
      r /= 5;
      g /= 5;
      b /= 5;
      // Asphalt under it: dark, gritty, bluer the further off.
      const stone = fbm2(grit, x / 2.2, y / 1.4, 2);
      let br = 11 + stone * 12;
      let bg = 12 + stone * 12;
      let bb = 22 + stone * 16;
      // How much of the mirror this patch holds: wet and dull in turn, and most at a low angle.
      const wet = fbm2(damp, x / 26, y / 6, 3);
      let fresnel = mix(0.9, 0.5, k) * mix(0.55, 1.15, smooth(clamp((wet - 0.36) * 3.2)));
      fresnel = mix(fresnel, 1.16, still);
      if (still > 0) {
        const rim = still < 0.4 ? 0.8 : 1;
        br *= rim;
        bg *= rim;
        bb *= rim;
      }
      for (let level = 0; level < LEVELS; level += 1) {
        const gain = [0.55, 0.92, 1.42][level] * fresnel;
        const d = bayer(x, y);
        const step = 13;
        const R = Math.min(255, Math.floor((br + r * gain) / step + d) * step);
        const G = Math.min(255, Math.floor((bg + g * gain) / step + d) * step);
        const B = Math.min(255, Math.floor((bb + b * gain) / step + d) * step);
        levels[level * W * ROWS + row * W + x] = pack(R, G, B);
      }
    }
  }
  // Two combs of streaks: thin across, long down the road.
  const comb = (seed, cut) => {
    const n = noise2(seed, 64);
    const out = new Uint8Array(256 * 64);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 256; x += 1) out[y * 256 + x] = n((x / 256) * 64 * 2.2, (y / 64) * 4) > cut ? 1 : 0;
    }
    return out;
  };
  return { levels, combA: comb(5524, 0.48), combB: comb(5525, 0.52) };
}

/** Road paint, worn and laid over the reflections so that it holds still: a line and a crossing. */
function paintMarks() {
  const art = new Art(W, ROWS);
  const worn = noise2(5526, 64);
  const lay = (x, y, hex, alpha) => {
    const k = fbm2(worn, x / 6, y / 2.5, 2);
    if (k < 0.34) return;
    const [r, g, b] = rgbOf(hex);
    art.put(x, y - ROAD, (((alpha * (0.6 + k * 0.7) * 255) & 255) << 24 | (b << 16) | (g << 8) | r) >>> 0);
  };
  for (let y = ROAD; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (y >= 239 && y < 241 && (x + 10) % 54 < 30) lay(x, y, '#c8ccd8', 0.26);
      if (y >= 212 && y < 213) lay(x, y, '#c8a050', 0.22);
    }
  }
  for (const [by, bh] of [[214, 2], [218, 2], [223, 3], [229, 3], [236, 4], [245, 5], [256, 6]]) {
    for (let y = by; y < by + bh; y += 1) {
      const x0 = Math.round(382 + (y - 214) * 0.28);
      const x1 = Math.round(454 + (y - 214) * 0.66);
      for (let x = x0; x < Math.min(W, x1); x += 1) lay(x, y, '#d4d8e4', 0.3);
    }
  }
  return art;
}

/** Streaks of a light that comes and goes, for adding over the road when it is lit. */
function streaks(cx, half, hex, reach, peak, seed, wide = W) {
  const art = new Art(wide, ROWS);
  const [r, g, b] = rgbOf(hex);
  const off = noise1(seed, 256);
  for (let x = Math.max(0, cx - half); x < Math.min(wide, cx + half); x += 1) {
    const span = 1 - Math.abs(x - cx) / half;
    if (off(x * 1.9 + 90) < 0.34) continue;
    const end = reach * (0.45 + off(x * 0.7) * 0.8) * (0.4 + span * 0.8);
    const start = 4 + off(x * 1.7 + 40) * 10;
    for (let row = Math.floor(start); row < Math.min(ROWS, end); row += 1) {
      const fade = (1 - row / end) * span;
      const k = Math.floor(peak * Math.sqrt(fade) * 5 + bayer(x, row)) / 5;
      if (k > 0) art.px[row * wide + x] = ((Math.min(1, k) * 255) << 24 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return art.canvas();
}

/* ── the sign ───────────────────────────────────────────────────── */

/** A tube of light: its colour, a white core, a dim ghost of it for when it is off. */
function tube(points, hex, core) {
  const art = new Art(48, 48);
  const c = rgba(hex);
  const w = rgba(core);
  for (const [x, y] of points) {
    art.put(x + 24 - 1, y + 24, c);
    art.put(x + 24 + 1, y + 24, c);
    art.put(x + 24, y + 24 - 1, c);
    art.put(x + 24, y + 24 + 1, c);
  }
  for (const [x, y] of points) art.put(x + 24, y + 24, w);
  return art.canvas();
}

function neonParts() {
  const ring = [];
  for (let a = 0; a < 90; a += 1) {
    const angle = (a / 90) * TAU * 0.86 + 0.9;
    ring.push([Math.round(Math.cos(angle) * 12), Math.round(Math.sin(angle) * 12)]);
  }
  const swell = [];
  for (let x = -8; x <= 8; x += 1) swell.push([x, Math.round(Math.sin((x / 8) * Math.PI) * 4)]);
  const spark = [[9, -11], [10, -12], [11, -11], [10, -10]];
  return { ring: tube(ring, '#ff4f9e', '#ffe0f0'), wave: tube(swell, '#35e8e0', '#e4fffb'), spark: tube(spark, '#ffc24a', '#fff6c8'), pink: glowSprite(20, 20, '#ff2f8e', 0.34, 14), teal: glowSprite(13, 12, '#14c8c8', 0.26, 12) };
}

/* ── things that come past ──────────────────────────────────────── */

/** A dark saloon facing left, shining where the street catches it. */
function paintCar(body, glass, roofLight) {
  const art = new Art(96, 32);
  const BODY = ramp(...body);
  art.poly([[3, 16], [10, 12], [20, 11], [86, 11], [93, 15], [94, 25], [3, 25]], (x, y) => art.tone(x, y, BODY, clamp(0.62 - (y - 11) / 18 + (x < 10 ? 0.1 : 0)), 0.7));
  art.poly([[24, 12], [34, 2], [62, 2], [76, 12]], (x, y) => art.tone(x, y, BODY, clamp(0.3 - (y - 2) / 40), 0.6));
  art.rect(36, 2, 25, 1, BODY[BODY.length - 1]);
  art.poly([[27, 12], [35, 4], [47, 4], [47, 12]], (x, y) => art.tone(x, y, ramp(...glass), clamp((x - 27) / 22 - (y - 4) / 30), 0.8));
  art.poly([[50, 12], [50, 4], [61, 4], [71, 12]], (x, y) => art.tone(x, y, ramp(...glass), clamp((x - 50) / 26 - (y - 4) / 30), 0.8));
  art.rect(4, 12 + 3, 88, 1, BODY[BODY.length - 1]);
  art.line(48, 12, 48, 24, BODY[0]);
  art.line(76, 12, 76, 24, BODY[0]);
  art.rect(50, 18, 4, 1, BODY[BODY.length - 1]);
  art.rect(3, 23, 91, 2, BODY[0]);
  for (const cx of [20, 74]) {
    art.disc(cx, 25, 5.6, rgba('#06060c'));
    art.disc(cx, 25, 2.4, rgba('#3a3a4c'));
    art.put(cx, 25, rgba('#8a8a9c'));
  }
  art.rect(3, 17, 3, 3, rgba('#fffbe0'));
  art.rect(90, 17, 4, 3, rgba('#ff3a44'));
  if (roofLight) {
    art.rect(44, 0, 10, 2, rgba('#ffc95e'));
    art.rect(44, 0, 10, 1, rgba('#fff0b4'));
  }
  return art;
}

const flipped = (art) => {
  const out = new Art(art.w, art.h);
  for (let y = 0; y < art.h; y += 1) for (let x = 0; x < art.w; x += 1) out.px[y * art.w + (art.w - 1 - x)] = art.px[y * art.w + x];
  return out;
};

/** A headlight's beam, widening to the left from its right edge. */
function paintBeam() {
  const w = 190;
  const h = 70;
  const art = new Art(w, h);
  const [r, g, b] = rgbOf('#fff0c0');
  for (let x = 0; x < w; x += 1) {
    const d = (w - x) / w;
    const half = 2 + d * 30;
    for (let y = 0; y < h; y += 1) {
      const dy = (y - 22) / half;
      if (Math.abs(dy) > 1) continue;
      const k = Math.floor((1 - d) ** 1.3 * (1 - dy * dy) * 6 * 0.8 + bayer(x, y)) / 6;
      if (k > 0) art.px[y * w + x] = ((Math.min(1, k) * 255) << 24 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return art;
}

/** Someone under an umbrella, in four steps. */
function walkerFrames() {
  const frames = [];
  for (let step = 0; step < 4; step += 1) {
    const art = new Art(26, 40);
    const coat = rgba('#0f0e1a');
    const lit = rgba('#3d2a2e');
    const swing = [3, 1, -3, -1][step];
    // Legs.
    art.line(12, 28, 12 + swing, 38, coat);
    art.line(13, 28, 13 + swing, 38, coat);
    art.line(14, 28, 14 - swing, 38, coat);
    art.line(15, 28, 15 - swing, 38, coat);
    // A long coat.
    art.poly([[9, 14], [18, 14], [19, 30], [8, 30]], coat);
    art.rect(8, 15, 1, 15, lit);
    art.disc(13.5, 11, 3.2, coat);
    art.put(10, 11, lit);
    // An arm up to the handle.
    art.line(17, 16, 15, 11, coat);
    art.rect(14, 6, 1, 8, rgba('#22222e'));
    // The canopy, and its ribs.
    for (let dy = 0; dy < 7; dy += 1) {
      const half = Math.sqrt(1 - ((6 - dy) / 7) ** 2) * 12;
      for (let dx = -Math.round(half); dx <= Math.round(half); dx += 1) {
        const ribs = Math.abs(dx) % 6 === 0;
        art.put(14 + dx, dy, rgba(ribs ? '#14283a' : dx < -4 ? '#2b4a60' : '#1b3347'));
      }
    }
    art.rect(14, 0, 1, 1, rgba('#3a6078'));
    frames.push(art.canvas());
  }
  return frames;
}

/* ── the scene ──────────────────────────────────────────────────── */

const rainyCafe = {
  build() {
    const rand = seeded(5500);
    const sky = paintSky();
    const clouds = paintClouds();
    const { art: back, windows: towerWindows } = paintBack(rand);
    const { art: front, drips, upstairs, spill } = paintFront(rand);
    const lamp = paintLamp();

    // Warmth lying on the wet air and on what is near: a little on everything, none of it blurred.
    addGlow(front, 108, 150, 110, 50, '#2c180a', 0.8, 10);
    addGlow(front, 278, 150, 90, 50, '#2c180a', 0.8, 10);
    addGlow(back, 240, 200, 240, 80, '#20142a', 0.9, 10);
    addGlow(front, VENDING.x0 + 8, 176, 24, 22, '#0c3c40', 0.8, 12);
    addGlow(front, NEON.x, NEON.y + 44, 30, 20, '#260a20', 0.8, 10);
    addGlow(front, NEON.x - 30, NEON.y, 12, 34, '#3a0e30', 0.8, 10);
    addGlow(back, NEON.x, NEON.y, 40, 44, '#1e0820', 0.8, 12);
    addGlow(back, LAMP.x, LAMP.y, 50, 50, '#0e1a22', 0.8, 12);

    // The picture the road reflects, with the lamp's halo and the sign's plate in it.
    const mirror = new Art();
    mirror.px.set(sky.px);
    for (const layer of [back, front]) {
      for (let i = 0; i < layer.px.length; i += 1) if (layer.px[i] >>> 24) mirror.px[i] = layer.px[i];
    }
    const road = paintRoad(mirror.px);
    const frame = new ImageData(W, ROWS);

    // The reader's other moments, as patches over the glass: same steam, different pose.
    const fog = noise2(5508, 64);
    const poses = [1, 2, 3].map((pose) => {
      const art = new Art();
      const figures = (m, ox, oy) => {
        pendant(m, 116 + ox, 128 + oy);
        reader(m, 92 + ox, 168 + oy, pose);
      };
      paintGlass(art, GLASS_A, { room: roomA, fog, figures, clear: CLEAR_A, runs: [] }, [77, 131, 142, 171]);
      const patch = new Art(65, 40);
      for (let y = 0; y < 40; y += 1) for (let x = 0; x < 65; x += 1) patch.px[y * 65 + x] = art.px[(131 + y) * W + 77 + x];
      return patch.canvas();
    });

    // The one behind the counter, soft behind the steam.
    const barista = new Art(22, 24);
    const ink = rgba('#54260f');
    barista.ellipse(11, 5, 4, 4.6, ink);
    barista.rect(9, 9, 4, 3, ink);
    barista.poly([[3, 24], [3, 15], [6, 11], [16, 11], [19, 15], [19, 24]], ink);
    barista.rect(1, 15, 2, 8, ink);
    barista.rect(19, 15, 2, 8, ink);

    // Lights that are always in the air.
    const halo = glowSprite(44, 44, '#7fb4bc', 0.2, 18, 0.8);
    const haloCore = glowSprite(15, 15, '#ffeec0', 0.5, 14);
    const cone = new Art(W, H);
    const [cr, cg, cb] = rgbOf('#d8e8d8');
    for (let y = 72; y < ROAD; y += 1) {
      const half = 6 + (y - 72) * 0.36;
      for (let x = Math.round(LAMP.x - half); x <= LAMP.x + half; x += 1) {
        const k = Math.floor((1 - Math.abs(x - LAMP.x) / half) ** 0.6 * (1 - (y - 72) / 150) * 0.2 * 6 + bayer(x, y)) / 6;
        if (k > 0) cone.put(x, y, ((k * 255) << 24 | (cb << 16) | (cg << 8) | cr) >>> 0);
      }
    }
    const beacon = glowSprite(4, 4, '#ff3040', 0.75, 5);

    // What the rain picks up where it falls: a map of the air's own colour.
    const cols = W >> 2;
    const rows = (H >> 2) + 1;
    const tint = new Array(cols * rows);
    const seen = new Map();
    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        const x = cx * 4 + 2;
        const y = cy * 4 + 2;
        const warm = spill(x, y, 900) * (y > 90 ? 1 : 0.35);
        const lampLight = Math.exp(-(((x - LAMP.x) / 44) ** 2 + ((y - 64) / 44) ** 2)) + 0.6 * Math.exp(-(((x - LAMP.x) / (10 + (y - 72) * 0.3)) ** 2)) * (y > 72 && y < ROAD ? 1 : 0);
        const pink = Math.exp(-(((x - NEON.x) / 30) ** 2 + ((y - NEON.y) / 34) ** 2));
        const teal = Math.exp(-(((x - 403) / 22) ** 2 + ((y - 176) / 24) ** 2));
        const r = Math.round(clamp(96 + warm * 158 + lampLight * 130 + pink * 150 - teal * 10, 0, 255) / 12) * 12;
        const g = Math.round(clamp(118 + warm * 70 + lampLight * 110 - pink * 26 + teal * 90, 0, 255) / 12) * 12;
        const b = Math.round(clamp(160 - warm * 62 + lampLight * 40 + pink * 20 + teal * 40, 0, 255) / 12) * 12;
        const key = (r << 16) | (g << 8) | b;
        if (!seen.has(key)) seen.set(key, `rgb(${r},${g},${b})`);
        tint[cy * cols + cx] = seen.get(key);
      }
    }

    const fall = (count, speed, length, spreadSpeed = 0.2) => Array.from({ length: count }, () => ({ x: rand() * W, y: rand() * 400, v: speed * (1 - spreadSpeed + rand() * spreadSpeed * 2), l: length + Math.floor(rand() * (length * 0.5)) }));

    const carA = paintCar(['#0a0b16', '#14162a', '#222642', '#3a4264', '#7886a4'], ['#16202e', '#3a4a4c', '#a07440', '#f0c068'], false);
    const carB = flipped(paintCar(['#1c1208', '#3a2610', '#7a5018', '#c48a24', '#f4c94e'], ['#121a26', '#2a3c44', '#6c7a58', '#d8cc80'], true));
    const beam = paintBeam();

    return {
      sky: sky.canvas(),
      clouds: clouds.canvas(),
      back: back.canvas(),
      front: front.canvas(),
      lamp: lamp.canvas(),
      road,
      marks: paintMarks().canvas(),
      frame,
      out: new Uint32Array(frame.data.buffer),
      towerWindows,
      upstairs,
      drips: drips.map((d) => ({ ...d, period: 1.6 + rand() * 3.8, phase: rand() })),
      poses,
      barista: barista.canvas(),
      halo,
      haloCore,
      cone: cone.canvas(),
      beacon,
      neon: neonParts(),
      neonRoadPink: streaks(NEON.x - 4, 24, '#ff3a94', 58, 0.72, 5530),
      neonRoadTeal: streaks(NEON.x + 4, 12, '#20dcd8', 50, 0.56, 5531),
      lampRoad: streaks(LAMP.x, 13, '#ffeab8', 66, 0.78, 5532),
      lampRoadWide: streaks(LAMP.x, 30, '#8fb8c0', 48, 0.26, 5533),
      tint,
      tintCols: cols,
      farRain: fall(120, 190, 3),
      midRain: fall(120, 300, 7),
      nearRain: fall(34, 470, 15),
      splashes: Array.from({ length: 80 }, () => ({ x: rand() * W, y: rand() * ROWS, period: 0.7 + rand() * 1.1, phase: rand(), fresh: rand() })),
      ledges: Array.from({ length: 34 }, () => ({ x: 26 + rand() * 312, y: rand() < 0.5 ? 52 : 28, period: 0.6 + rand() * 1.6, phase: rand() })),
      carA: carA.canvas(),
      carB: carB.canvas(),
      carWhite: streaks(9, 9, '#fff0c4', 40, 0.86, 5534, 18),
      carRed: streaks(6, 6, '#ff3040', 26, 0.74, 5535, 12),
      sweep: glowSprite(46, 15, '#ffe2a8', 0.5, 14),
      beamL: beam.canvas(),
      beamR: flipped(beam).canvas(),
      walker: walkerFrames(),
      smoke: Array.from({ length: 10 }, () => ({ phase: rand(), wide: 2 + rand() * 3, drift: 8 + rand() * 12 })),
      runs: Array.from({ length: 12 }, () => {
        const g = rand() < 0.55 ? GLASS_A : GLASS_B;
        return { x: g.x0 + 3 + Math.floor(rand() * (g.x1 - g.x0 - 6)), period: 9 + rand() * 16, phase: rand(), from: 132 + Math.floor(rand() * 18), to: 160 + Math.floor(rand() * 14) };
      }),
    };
  },

  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.clouds, along(t, 1.3, 960), 0);
    ctx.drawImage(s.back, 0, 0);

    // Somebody comes home, somebody goes to bed.
    for (const w of s.towerWindows) {
      if (wave(t, w.period, w.phase) < 0.1) continue;
      ctx.fillStyle = w.tone;
      ctx.fillRect(w.x, w.y, 4, 5);
      ctx.fillRect(w.x + 5, w.y, 4, 5);
      ctx.fillRect(w.x, w.y + 6, 4, 5);
      ctx.fillRect(w.x + 5, w.y + 6, 4, 5);
    }
    // The aerial's light, slow and red.
    const blink = (t % 2.8) < 0.5;
    ctx.fillStyle = blink ? '#ff4a50' : '#5a1820';
    ctx.fillRect(296, 3, 1, 1);
    if (blink) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(s.beacon, 296 - 8, 3 - 8);
      ctx.globalCompositeOperation = 'source-over';
    }

    // Far rain falls behind the café.
    rainfall(ctx, s, s.farRain, t, 0.3);
    chimneySmoke(ctx, s, t);
    ctx.drawImage(s.front, 0, 0);

    // The television upstairs, and the café's light, which is never quite steady.
    const tv = s.upstairs.find((w) => w.kind === 'blue');
    const flick = (Math.imul(Math.floor(t * 3) + 1, 2654435761) >>> 24) / 255;
    ctx.fillStyle = flick > 0.66 ? '#6f92d8' : flick > 0.33 ? '#4f6fb8' : '#3d5698';
    ctx.fillRect(tv.x + 2, tv.y + 3, 12, 9);
    ctx.fillRect(tv.x + 16, tv.y + 3, 12, 9);
    ctx.fillStyle = flick > 0.66 ? '#4a64a0' : '#334a88';
    ctx.fillRect(tv.x + 2, tv.y + 13, 12, 11);
    ctx.fillRect(tv.x + 16, tv.y + 13, 12, 11);

    // Reading: a page goes over, she looks up, she drinks.
    const beat = t % 53;
    const pose = beat > 20 && beat < 21.3 ? 0 : beat > 11 && beat < 15 ? 2 : beat > 40 && beat < 45 ? 1 : -1;
    if (pose >= 0) ctx.drawImage(s.poses[pose], 77, 131);
    // Steam off her cup, unless it is at her lips.
    if (pose !== 1) {
      ctx.fillStyle = 'rgba(255,240,200,0.5)';
      for (let i = 0; i < 5; i += 1) {
        const k = ((t / 2.6 + i / 5) % 1);
        ctx.fillRect(Math.round(129 + Math.sin(k * 7 + i) * (1 + k * 2)), Math.round(160 - k * 15), 1, 2);
      }
    }
    // The one behind the counter goes from the machine to the rack, and rests at each.
    const shift = wave(t, 23) * 1.6;
    const at = clamp(shift * 0.5 + 0.5);
    ctx.globalAlpha = 0.56;
    ctx.drawImage(s.barista, Math.round(mix(226, 268, smooth(at))), 133);
    ctx.globalAlpha = 1;
    // The machine sighs every so often.
    const sigh = (t % 19) / 3;
    if (sigh < 1) {
      ctx.fillStyle = 'rgba(255,246,214,0.4)';
      for (let i = 0; i < 6; i += 1) ctx.fillRect(Math.round(266 + Math.sin(i * 2 + t) * (2 + sigh * 3)), Math.round(138 - sigh * 10 - i * 2), 2, 1);
    }
    // A cat on the sill, its back to the room, its tail keeping time.
    drawCat(ctx, t);

    // Drops find their way down the steam.
    for (const r of s.runs) {
      const k = (t / r.period + r.phase) % 1;
      if (k > 0.5) continue;
      const stops = smooth(clamp(k * 2)) * 0.6 + k * 0.8;
      const y = Math.round(mix(r.from, r.to, stops));
      ctx.fillStyle = 'rgba(150,84,30,0.14)';
      ctx.fillRect(r.x, r.from, 1, y - r.from);
      ctx.fillStyle = '#fff6d0';
      ctx.fillRect(r.x, y, 1, 2);
      ctx.fillStyle = 'rgba(70,30,20,0.6)';
      ctx.fillRect(r.x, y + 2, 1, 1);
    }

    // The sign: steady, then one tube catches now and again.
    const stutter = (t % 17) < 0.8 && Math.floor(t * 14) % 3 !== 0;
    const brown = (t % 61) < 0.35;
    const pinkOn = brown ? 0.25 : 0.94 + wave(t, 0.5) * 0.06;
    const tealOn = stutter ? 0.2 : 0.96;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = pinkOn;
    ctx.drawImage(s.neon.pink, NEON.x - 40, NEON.y - 40);
    ctx.globalAlpha = tealOn;
    ctx.drawImage(s.neon.teal, NEON.x - 26, NEON.y - 24);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = pinkOn;
    ctx.drawImage(s.neon.ring, NEON.x - 24, NEON.y - 24);
    ctx.drawImage(s.neon.spark, NEON.x - 24, NEON.y - 24);
    ctx.globalAlpha = tealOn;
    ctx.drawImage(s.neon.wave, NEON.x - 24, NEON.y - 24);
    ctx.globalAlpha = 1;

    // Water working its way along the fringe, then letting go.
    for (const d of s.drips) {
      const k = (t / d.period + d.phase) % 1;
      if (k < 0.55) {
        if (k > 0.3) {
          ctx.fillStyle = '#bcd0e0';
          ctx.fillRect(d.x, d.y, 1, 1);
        }
      } else {
        const fall2 = (k - 0.55) / 0.45;
        const y = d.y + fall2 * fall2 * (FOOT + 8 - d.y);
        ctx.fillStyle = y > 125 && y < 176 ? '#fff0c0' : '#a9c0d8';
        ctx.fillRect(d.x, Math.round(y), 1, 2);
        if (fall2 > 0.93) {
          ctx.fillStyle = '#cbd8e8';
          ctx.fillRect(d.x - 1, FOOT + 7, 3, 1);
        }
      }
    }

    // Somebody under an umbrella, along the pavement, about once a minute and a bit.
    const stroll = ((t + 3) % 79) / 26;
    if (stroll < 1) {
      const x = Math.round(-30 + stroll * (W + 40));
      const frame = s.walker[Math.floor(t * 5) % 4];
      ctx.globalAlpha = 0.3;
      ctx.save();
      ctx.translate(x, 201);
      ctx.scale(1, -0.28);
      ctx.drawImage(frame, 0, -40);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.drawImage(frame, x, 162);
    }

    // The lamp, and what it does to the air.
    ctx.drawImage(s.lamp, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9 + wave(t, 3.7) * 0.1;
    ctx.drawImage(s.halo, LAMP.x - 88, LAMP.y - 88);
    ctx.drawImage(s.haloCore, LAMP.x - 30, LAMP.y - 30);
    ctx.globalAlpha = 1;
    ctx.drawImage(s.cone, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // The road: each pixel picks its brightness through two combs that slide against each other.
    drawRoad(ctx, t, s);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = pinkOn;
    ctx.drawImage(s.neonRoadPink, 0, ROAD);
    ctx.globalAlpha = tealOn;
    ctx.drawImage(s.neonRoadTeal, 0, ROAD);
    ctx.globalAlpha = 0.86 + wave(t, 1.9) * 0.14;
    ctx.drawImage(s.lampRoad, 0, ROAD);
    ctx.globalAlpha = 1;
    ctx.drawImage(s.lampRoadWide, 0, ROAD);
    ctx.drawImage(s.marks, 0, ROAD);
    ctx.globalCompositeOperation = 'source-over';

    drawSplashes(ctx, t, s);
    // Cars, one way and the other, not often.
    drawCar(ctx, t, s, s.carB, s.beamR, 1, 71, 8.5, 211, 9);
    drawCar(ctx, t, s, s.carA, s.beamL, -1, 43, 6, 224, 31);

    rainfall(ctx, s, s.midRain, t, 0.42);
    rainfall(ctx, s, s.nearRain, t, 0.5);
    ctx.globalAlpha = 1;
  },
};

/** Rain at one depth: each drop falls for ever, somewhere else each time round. */
function rainfall(ctx, s, drops, t, alpha) {
  ctx.globalAlpha = alpha;
  const span = H + 40;
  for (const d of drops) {
    const fallen = d.y + t * d.v;
    const cycle = Math.floor(fallen / span);
    const y = fallen - cycle * span - 20;
    const x = (((d.x + cycle * 139.7 + y * SLANT) % W) + W) % W;
    const iy = Math.round(y);
    if (iy < 0 || iy >= H) continue;
    ctx.fillStyle = s.tint[(iy >> 2) * s.tintCols + (Math.floor(x) >> 2)];
    const half = d.l >> 1;
    ctx.fillRect(Math.round(x), iy, 1, half);
    ctx.fillRect(Math.round(x + half * SLANT), iy + half, 1, d.l - half);
  }
  ctx.globalAlpha = 1;
}

function chimneySmoke(ctx, s, t) {
  ctx.fillStyle = 'rgba(120,110,140,0.12)';
  for (const p of s.smoke) {
    const k = (t / 11 + p.phase) % 1;
    const y = Math.round(7 - k * 20);
    const x = Math.round(114 - k * p.drift);
    const size = Math.round(2 + k * p.wide * 2);
    ctx.fillRect(x, y, size, size);
  }
}

function drawCat(ctx, t) {
  const x = 234;
  const y = 165;
  ctx.fillStyle = '#1a0e12';
  ctx.fillRect(x + 1, y + 3, 7, 8);
  ctx.fillRect(x, y + 6, 9, 5);
  ctx.fillRect(x + 2, y - 2, 5, 5);
  ctx.fillRect(x + 2, y - 3, 1, 1);
  ctx.fillRect(x + 6, y - 3, 1, 1);
  // The tail, sweeping along the sill.
  const flick = wave(t, 4.3) * 2.4;
  for (let i = 0; i < 8; i += 1) ctx.fillRect(x + 8 + i, y + 10 - Math.round(((i / 8) ** 2) * (2 + flick)), 1, 1);
}

function drawRoad(ctx, t, s) {
  const { levels, combA, combB } = s.road;
  const { out, frame } = s;
  const offA = along(t, 13, 64);
  const offB = along(t, 21, 64);
  const size = W * ROWS;
  const swayStep = Math.floor(t * 5);
  for (let row = 0; row < ROWS; row += 1) {
    const base = row * W;
    const a = ((row + offA) & 63) << 8;
    const b = ((row + 64 - offB) & 63) << 8;
    // The whole row trembles a little, more the nearer it is.
    const dice = Math.imul(row * 31 + swayStep * 13, 2654435761) >>> 28;
    const shift = row > 4 && dice < 6 ? (dice & 1) * 2 - 1 : 0;
    for (let x = 0; x < W; x += 1) {
      const level = combA[a | (x & 255)] + combB[b | ((x + 91) & 255)];
      let sx = x + shift;
      if (sx < 0) sx = 0;
      else if (sx >= W) sx = W - 1;
      out[base + x] = levels[level * size + base + sx];
    }
  }
  ctx.putImageData(frame, 0, ROAD);
}

/** The crown of a drop on the road, or a ring where it lands in a puddle. */
function drawSplashes(ctx, t, s) {
  for (const p of s.splashes) {
    const phase = t / p.period + p.phase;
    const cycle = Math.floor(phase);
    const k = phase - cycle;
    if (k > 0.26) continue;
    const x = (((p.x + cycle * 113.3) % W) + W) % W;
    const y = ROAD + 2 + ((p.y + cycle * 41.7) % (ROWS - 3));
    const size = 1 + ((y - ROAD) / ROWS) * 1.6;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (k < 0.08) {
      ctx.fillStyle = 'rgba(220,232,255,0.8)';
      ctx.fillRect(ix, iy - 1, 1, 2);
    } else if (k < 0.17) {
      ctx.fillStyle = 'rgba(210,226,255,0.6)';
      const r = Math.round(1 + size);
      ctx.fillRect(ix - r, iy, 1, 1);
      ctx.fillRect(ix + r, iy, 1, 1);
      ctx.fillRect(ix - 1, iy - 2, 1, 1);
      ctx.fillRect(ix + 1, iy - 2, 1, 1);
    } else {
      ctx.fillStyle = 'rgba(190,210,245,0.36)';
      const r = Math.round(1 + size * 2);
      ctx.fillRect(ix - r, iy, r - 1, 1);
      ctx.fillRect(ix + 2, iy, r - 1, 1);
      ctx.fillRect(ix - 1, iy - 1, 3, 1);
      ctx.fillRect(ix - 1, iy + 1, 3, 1);
    }
  }
  // On the ledges too, where the rain lands first.
  ctx.fillStyle = 'rgba(190,206,240,0.7)';
  for (const p of s.ledges) {
    const k = (t / p.period + p.phase) % 1;
    if (k < 0.1) ctx.fillRect(Math.round(p.x), p.y - 1, 1, 1);
    else if (k < 0.2) {
      ctx.fillRect(Math.round(p.x) - 1, p.y - 2, 1, 1);
      ctx.fillRect(Math.round(p.x) + 1, p.y - 2, 1, 1);
    }
  }
}

/**
 * A car passing, with what it does to the road and the rain. `dir` is which way it
 * travels; between passes it is off the edge, so its period can be anything.
 */
function drawCar(ctx, t, s, sprite, beam, dir, period, seconds, y, phase) {
  const pass = ((t + phase) % period) / seconds;
  if (pass > 1) return;
  const span = W + 380;
  const carX = dir < 0 ? Math.round(W + 190 - pass * span) : Math.round(-286 + pass * span);
  const lampX = dir < 0 ? carX + 3 : carX + 93;
  const beamX = dir < 0 ? lampX - 190 : lampX;
  // Light on the road ahead, and a soft patch on the shopfronts as it sweeps.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.6;
  ctx.drawImage(beam, beamX, y + 18 - 22);
  ctx.globalAlpha = 0.34;
  ctx.drawImage(s.sweep, beamX + (dir < 0 ? -20 : 60), 158);
  // Long streaks under the lamps, down the wet road, that thin out and stop.
  ctx.globalAlpha = 0.9;
  ctx.drawImage(s.carWhite, lampX - 9, y + 26);
  ctx.drawImage(s.carRed, (dir < 0 ? carX + 92 : carX + 3) - 6, y + 26);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // A dark patch under it, then the car, then its own dim reflection.
  ctx.fillStyle = 'rgba(4,5,12,0.62)';
  ctx.fillRect(carX + 4, y + 26, 88, 8);
  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.translate(carX, y + 31 + 26);
  ctx.scale(1, -1);
  ctx.drawImage(sprite, 0, 0, 96, 26, 0, 0, 96, 26);
  ctx.restore();
  ctx.drawImage(sprite, carX, y);
  // Rain lit up in the beam.
  ctx.fillStyle = '#fff4d0';
  ctx.globalAlpha = 0.75;
  const tick = Math.floor(t * 14);
  for (let i = 0; i < 26; i += 1) {
    const h = (Math.imul(i * 7 + tick * 13 + 1, 2654435761) >>> 0) / 4294967296;
    const v = (Math.imul(i * 11 + tick * 5 + 3, 1540483477) >>> 0) / 4294967296;
    const dx = 8 + h * 170;
    const half = 2 + (dx / 190) * 28;
    ctx.fillRect(Math.round(lampX + dir * dx), Math.round(y + 18 + (v - 0.5) * half * 2), 1, 4);
  }
  ctx.globalAlpha = 1;
}

export default rainyCafe;
