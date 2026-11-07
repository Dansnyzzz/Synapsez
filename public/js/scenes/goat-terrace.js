import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, newCanvas, noise1, noise2, fbm1, fbm2, ridged, puffs, cumulus, slide } from './art.js';

/**
 * The year of the goat, in the rice terraces of the north-west mountains at harvest.
 * A clear morning: the sun is up behind us to the left, cloud still lying in the valley,
 * and every terrace has a bright lip on the side towards the light. Goats have the
 * rock at the top of the hill all to themselves.
 */

const FINE = 3;
/** The outcrop's skyline, which is also the ground the goats walk on. */
const ROCK_LINE = [[345, 182], [360, 154], [372, 148], [384, 130], [398, 122], [426, 94], [436, 80], [448, 76], [462, 82], [474, 92], [486, 90], [502, 100]];
const rockTop = (x) => {
  if (x <= ROCK_LINE[0][0]) return ROCK_LINE[0][1];
  for (let i = 0; i + 1 < ROCK_LINE.length; i += 1) {
    const [a, b] = [ROCK_LINE[i], ROCK_LINE[i + 1]];
    if (x <= b[0]) return mix(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
  }
  return ROCK_LINE[ROCK_LINE.length - 1][1];
};
/** Where the climbing goat goes, up the rock and back. */
const CLIMB_FROM = 400;
const CLIMB_TO = 426;
const CLIMB_SECONDS = 34;
const CLIMB_STEPS = 6;
const HOUSE = { x: 118, base: 140 };

const see = (hex, alpha) => ((rgba(hex) & 0xffffff) | (alpha << 24)) >>> 0;
const hash = (i, seed) => {
  const v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
const rgbOf = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** The same colours with the air between here and them: `k` of the way to the haze. */
const hazed = (hexes, k, air = '#cfe0e4') => {
  const [ar, ag, ab] = rgbOf(air);
  return ramp(...hexes.map((hex) => {
    const [r, g, b] = rgbOf(hex);
    return toHex([mix(r, ar, k), mix(g, ag, k), mix(b, ab, k)]);
  }));
};

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

function limb(art, x0, y0, x1, y1, r0, r1, c) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i += 1) {
    const k = i / n;
    art.disc(mix(x0, x1, k), mix(y0, y1, k), mix(r0, r1, k), c);
  }
}

/* ── terraces ─────────────────────────────────────────────────────── */

const GOLD = ['#8c7d22', '#a68e26', '#c0a12b', '#d8b534', '#e9c744', '#f4d85a', '#fbe67c', '#fff3a8'];
const GREEN = ['#4d7a2d', '#5f8d31', '#75a038', '#8db040', '#a6c14e', '#bfd062', '#d6dd80', '#e8e8a4'];
const STRAW = ['#86703c', '#9c8648', '#b09a58', '#c3ae6a', '#d3c07c', '#e0cf8f', '#ecdda6', '#f5e8bc'];
const BANK = ['#27241a', '#3a3320', '#4e4526', '#62592b', '#767031', '#8d8a3e'];

/**
 * A hillside cut into terraces. Contours are lines of equal `tau`: they follow the
 * hill's own outline near the top and spread as they come towards us, and a low
 * swell in the ground bends them and shades them, so that the curves and the light
 * come from one and the same shape.
 */
function paintTerraces(art, lit, o) {
  const { top, x0, x1, yEnd, k, c, swell, swellSize, seed, haze, lift = 0, bowl = () => 0 } = o;
  const gold = hazed(GOLD, haze);
  const green = hazed(GREEN, haze);
  const straw = hazed(STRAW, haze);
  const bank = hazed(BANK, haze);
  const litGold = rgba(toHex(rgbOf('#fff6b4').map((v, i) => mix(v, rgbOf('#cfe0e4')[i], haze))));
  const litGreen = rgba(toHex(rgbOf('#e6ee98').map((v, i) => mix(v, rgbOf('#cfe0e4')[i], haze))));
  const lip = rgba(toHex(rgbOf('#fff8c8').map((v, i) => mix(v, rgbOf('#cfe0e4')[i], haze))));
  const line = noise1(seed + 900, 128);
  // One reading of the swell per pixel, kept, since the shading wants its neighbours too.
  const swellAt = new Float32Array(W * H).fill(-1);
  const ground = (x, y) => {
    const qx = clamp(x, 0, W - 1);
    const idx = y * W + qx;
    if (swellAt[idx] < 0) swellAt[idx] = fbm2(swell, qx / swellSize, y / (swellSize * 0.52), 2);
    return swellAt[idx];
  };
  for (let x = x0; x < x1; x += 1) {
    const t0 = top(x);
    for (let y = Math.max(0, Math.ceil(t0)); y < yEnd; y += 1) {
      const dy = y - t0;
      const lump = ground(x, y);
      const tau = c * Math.log(1 + dy / k) + (lump - 0.5) * 3.6 + bowl(x);
      const i = Math.floor(tau);
      const f = tau - i;
      const px = (k + dy) / c;
      const riser = clamp(px * 0.2, 0.7, 4.6) / px;
      const face = ground(x + 5, y) - ground(x - 5, y);
      const shade = lift + face * 2.6 + (1 - x / W) * 0.05;
      const idx = y * W + x;
      if (f > 1 - riser) {
        lit.px[idx] = 0;
        const r = (f - (1 - riser)) / riser;
        art.tone(x, y, bank, clamp(0.6 - r * 0.56 + shade * 0.5 + (fbm2(swell, x / 2.5, y / 2.5, 2) - 0.5) * 0.5), 0.6);
        continue;
      }
      if (f > 1 - riser - 1 / px && px > 2.4) {
        lit.px[idx] = 0;
        art.px[idx] = lip;
        continue;
      }
      const kind = hash(i, seed);
      const patch = fbm1(line, x / 34 + i * 3.7, 3);
      const isStraw = kind > 0.87;
      const isGreen = !isStraw && (kind > 0.62 ? patch > 0.46 : patch > 0.68);
      const colours = isStraw ? straw : isGreen ? green : gold;
      let v = 0.56 + shade + (hash(i, seed + 3) - 0.5) * 0.2 + (patch - 0.5) * 0.3;
      // Rows of rice run along the contour; nearer, we can make out the clumps themselves.
      const row = Math.floor(f * px);
      if (px > 4.5 && row % 2 === 1) v -= 0.07;
      if (px > 7.5 && (x + row * 3 + i) % 3 === 0) v += 0.1;
      if (f * px < 1) v -= 0.16;
      art.tone(x, y, colours, clamp(v), 0.5);
      lit.px[idx] = isStraw ? 0 : isGreen ? litGreen : litGold;
    }
  }
}

/** A band of forest along a ridge, one crown at a time. */
function paintForest(art, rand, top, x0, x1, step, rMin, rMax, colours, grain) {
  for (let x = x0; x < x1; x += step * (0.6 + rand() * 0.8)) {
    const r = rMin + rand() * (rMax - rMin);
    const y = top(x) + rand() * r * 0.8;
    const list = [];
    const count = Math.round(r * r * 0.5) + 6;
    for (let i = 0; i < count; i += 1) {
      const a = rand() * TAU;
      const d = Math.sqrt(rand());
      list.push({ x: x + Math.cos(a) * d * r, y: y + Math.sin(a) * d * r * 0.8, r: 0.9 + rand() * 1.8, z: rand() * 2 });
    }
    puffs(art, list, colours, { light: [-0.6, -0.7, 0.35], height: 0.62, spread: 0.7, grain });
  }
}

/* ── goats ────────────────────────────────────────────────────────── */

const COAT_PART = 0xff000001;
const FAR_PART = 0xff000002;
const HORN_PART = 0xff000003;
const HOOF_PART = 0xff000004;
const EYE_PART = 0xff000005;
const PALE_PART = 0xff000006;

/**
 * A goat in profile, drawn fine. `u` runs forward along it and `v` up from the ground;
 * `tilt` is the slope it stands on. What makes it a goat: a straight boxy back,
 * horns that sweep back, a beard, thin legs and a short tail that stands up.
 */
function paintGoat(fine, ox, oy, s, o) {
  const { dir = -1, tilt = 0, poll = [12, 21.5], snout = -0.62, legs = [0, 0, 0, 0], lift = [0, 0, 0, 0], lying = false, tailUp = 1, ear = 0, chew = 0 } = o;
  const [cs, sn] = [Math.cos(tilt), Math.sin(tilt)];
  const P = (u, v) => {
    const a = u * cs - v * sn;
    const b = u * sn + v * cs;
    return [(ox + dir * a * s) * FINE, (oy - b * s) * FINE];
  };
  const R = (r) => Math.max(r * s * FINE, 0.9);
  const seg = (a, b, r0, r1, c) => {
    const [x0, y0] = P(a[0], a[1]);
    const [x1, y1] = P(b[0], b[1]);
    limb(fine, x0, y0, x1, y1, R(r0), R(r1), c);
  };
  const drop = lying ? 6.2 : 0;
  // Legs: knee a little forward, hoof at the end. Far side first.
  const leg = (u, swing, up, c) => {
    if (lying) return;
    const hoof = [u + swing, up];
    const knee = [u + swing * 0.5 + (u > 0 ? 0.8 : -0.5), 4.6 + up * 0.7];
    seg([u, 10], knee, 1.2, 0.72, c);
    seg(knee, hoof, 0.68, 0.56, c);
    seg([hoof[0], hoof[1] + 0.4], [hoof[0] + 0.5, hoof[1] + 0.4], 0.75, 0.75, HOOF_PART);
  };
  leg(3.8, legs[1], lift[1], FAR_PART);
  leg(-8, legs[3], lift[3], FAR_PART);
  // The short tail, standing up.
  seg([-11.2, 14.5 - drop], [-13.2, 15 + tailUp * 3 - drop], 1, 0.5, COAT_PART);
  // The body: straight back, deep chest, rump a touch higher than the withers.
  const body = [[8.4, 15.2], [1, 14.9], [-5, 15.1], [-9.6, 15.8], [-12, 13.6], [-11.7, 9.8], [-6, 8.4], [2.5, 7.8], [8, 8], [10.4, 11.5]].map(([u, v]) => P(u, v - drop));
  fine.poly(body, COAT_PART);
  // The pale belly, on those that have one.
  fine.poly([[-9.5, 10.4], [-6, 8.6], [2.5, 8], [7.4, 8.4], [5, 10.2], [-4, 10.3]].map(([u, v]) => P(u, v - drop)), PALE_PART);
  // Neck to the poll, then a long narrow head with a square muzzle.
  const [px, pv] = [poll[0], poll[1] - drop];
  seg([7.4, 12.6 - drop], [px - 0.6, pv - 1.4], 3.1, 1.95, COAT_PART);
  const hu = [Math.cos(snout), Math.sin(snout)];
  const hv = [-hu[1], hu[0]];
  const on = (a, b) => [px + hu[0] * a + hv[0] * b, pv + hu[1] * a + hv[1] * b];
  seg(on(-0.2, 0), on(4.2, 0), 1.95, 1.3, COAT_PART);
  seg(on(4.2, 0), on(6.6, -0.2 - chew * 0.3), 1.25, 1.05, COAT_PART);
  // The beard.
  seg(on(4.4, -1.1), on(3.9, -4.4), 0.72, 0.32, COAT_PART);
  // An ear out behind the horn.
  seg(on(-0.3, 0.2), on(-3.4, -0.6 - ear), 0.72, 0.5, COAT_PART);
  // Horns: rising from the poll and sweeping back over the neck.
  let prev = on(0.3, 1.2);
  for (let i = 1; i <= 8; i += 1) {
    const k = i / 8;
    const pt = [px + 0.4 - k * 8.6, pv + 1.4 + Math.sin(k * 2.5) * 5.4 - k * k * 1.4];
    seg(prev, pt, mix(0.95, 0.38, (i - 1) / 8), mix(0.95, 0.38, k), HORN_PART);
    prev = pt;
  }
  const [ex, ey] = P(...on(1.4, 0.45));
  fine.disc(ex, ey, Math.max(0.8, 0.55 * s * FINE), EYE_PART);
  // Near legs last.
  leg(6, legs[0], lift[0], COAT_PART);
  leg(-10, legs[2], lift[2], COAT_PART);
  if (lying) {
    seg([5.5, 1.4], [10.5, 0.9], 1.2, 0.95, COAT_PART);
    seg([-7, 1.4], [-2, 0.9], 1.5, 1, COAT_PART);
  }
}

/** A drawing of a goat, coloured: lit from the upper left, shade below. */
function goatSprite(s, pose, coat) {
  const w = Math.ceil(44 * s);
  const h = Math.ceil(36 * s);
  const ox = Math.floor(w / 2);
  const oy = h - 3;
  const fine = new Art(w * FINE, h * FINE);
  paintGoat(fine, ox, oy, s, pose);
  const code = new Uint32Array(w * h);
  const parts = new Map();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let count = 0;
      parts.clear();
      for (let j = 0; j < FINE; j += 1) {
        for (let i = 0; i < FINE; i += 1) {
          const v = fine.px[(y * FINE + j) * fine.w + x * FINE + i];
          if (!v) continue;
          count += 1;
          parts.set(v, (parts.get(v) || 0) + 1);
        }
      }
      if (count < 3) continue;
      let best = 0;
      let most = 0;
      for (const [v, n] of parts) {
        const weight = v === EYE_PART ? n + 9 : v === HORN_PART ? n + 2 : n;
        if (weight > most) {
          most = weight;
          best = v;
        }
      }
      code[y * w + x] = best;
    }
  }
  const art = new Art(w, h);
  const has = (x, y) => x >= 0 && y >= 0 && x < w && y < h && code[y * w + x] !== 0;
  let top = h;
  let bottom = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!code[y * w + x]) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = code[y * w + x];
      if (!c) continue;
      let colour;
      if (c === EYE_PART) colour = coat.eye;
      else if (c === HORN_PART) colour = !has(x - 1, y - 1) && !has(x, y - 1) ? coat.hornLit : coat.horn;
      else if (c === HOOF_PART) colour = coat.hoof;
      else if (c === FAR_PART) colour = !has(x - 1, y) ? coat.mid : coat.dark;
      else if (c === PALE_PART) colour = !has(x, y + 1) ? coat.belly2 : coat.belly;
      else if (!has(x - 1, y) || !has(x, y - 1)) colour = coat.light;
      else if (!has(x, y + 1) || !has(x + 1, y)) colour = coat.dark;
      else colour = (y - top) / Math.max(1, bottom - top) > 0.56 ? coat.shade : coat.mid;
      art.put(x, y, rgba(colour));
    }
  }
  return { image: art.canvas(), ox, oy };
}

/* ── the scene ────────────────────────────────────────────────────── */

const goatTerrace = {
  build() {
    const rand = seeded(2027);
    const grainNoise = noise2(2728, 64);
    const leafy = (x, y) => (fbm2(grainNoise, x / 2.6, y / 2.6, 2) - 0.5) * 0.42;

    /* ── sky and cloud ────────────────────────────────────────────── */
    const SKY = ramp('#7fb4d6', '#8fbedb', '#a0c8df', '#b2d2e2', '#c5dbe2', '#d7e3df', '#e8e8d6', '#f4eacb', '#fcecc0', '#fff1c8');
    const sky = new Art();
    sky.shade(SKY, (x, y) => clamp(0.02 + (y / 150) * 0.7 + 0.3 * Math.exp(-((Math.hypot((x - 96) / 1.5, y - 44) / 106) ** 2)) + (fbm2(grainNoise, x / 26, y / 12, 3) - 0.5) * 0.05), 0.95);
    const CLOUD = ramp('#b9cddb', '#cfdde4', '#e2e9ea', '#f1f3ee', '#fbfaf2', '#ffffff');
    const high = new Art(960, 96);
    for (const [cx, base, w, h] of [[80, 66, 170, 46], [300, 44, 110, 26], [470, 76, 210, 54], [690, 54, 130, 30], [860, 72, 180, 44]]) {
      puffs(high, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.55, height: 0.68, light: [-0.6, -0.72, 0.3], lift: 0.16, flat: 7 });
    }

    /* ── the mountains, four layers, each fading into its own mist ── */
    const back = new Art();
    const mountain = (seed, base, height, cell, hexes, depth, bumps) => {
      const colours = ramp(...hexes);
      const line = noise1(seed, 128);
      const topOf = (x) => {
        let v = base - ridged(line, x / cell, 4) * height;
        for (const [bx, wide, tall] of bumps) v -= tall * Math.exp(-(((x - bx) / wide) ** 2));
        return v;
      };
      for (let x = 0; x < W; x += 1) {
        const y0 = Math.round(topOf(x));
        const slope = topOf(x + 3) - topOf(x - 3);
        for (let y = Math.max(0, y0); y < 216; y += 1) {
          const d = y - y0;
          // Faces turned to the left catch the morning; the ribs of the range run down and out.
          const rib = d < depth ? fbm2(grainNoise, (x + d * 0.8) / 21, d / 16, 2) - 0.5 : 0;
          const v = (d / depth) ** 1.3 - slope * 0.06 + rib * (0.44 * (1 - clamp(d / depth)) + 0.04);
          back.tone(x, y, colours, clamp(v), 0.7);
        }
      }
    };
    mountain(2729, 94, 62, 74, ['#88a6c4', '#98b3cd', '#a9c0d5', '#bbccdb', '#ccd8e0', '#dde3e4', '#ece9e0'], 74, [[120, 66, 18], [430, 70, 10]]);
    mountain(2730, 118, 52, 56, ['#6d8fac', '#7f9eb7', '#93aec3', '#a9becf', '#c0cfd9', '#d6dde0', '#e9e8e0'], 68, [[300, 70, 10], [456, 60, 30]]);
    mountain(2731, 142, 44, 42, ['#4f7d8f', '#62909d', '#78a1ab', '#90b3ba', '#abc6c9', '#c7d9d8', '#e2e8e0'], 56, [[60, 60, 12], [410, 80, 26]]);
    mountain(2732, 160, 26, 28, ['#3a6c66', '#4d8077', '#649488', '#80a99b', '#a0c0b0', '#c2d6c6', '#e0e8d9'], 40, [[250, 60, 8]]);

    /* ── a far hill in the gap, and the two great slopes ──────────── */
    const rear = new Art();
    const riceFar = new Art();
    const swellA = noise2(2733, 64);
    const swellB = noise2(2734, 64);
    const swellC = noise2(2735, 64);
    // Far terraces, right down the valley, more air than land.
    const farTop = (x) => 152 + 24 * ((x - 245) / 120) ** 2 + Math.sin(x / 19) * 1.5;
    paintTerraces(rear, riceFar, { top: farTop, x0: 120, x1: 380, yEnd: 212, k: 26, c: 8, swell: swellA, swellSize: 30, seed: 11, haze: 0.5, lift: 0.04 });

    // The left slope: down from the edge of the picture into the valley.
    const leftTop = (x) => 118 + 72 * clamp(x / 262) ** 1.55 + Math.sin(x / 27 + 1) * 2.6 + Math.sin(x / 11) * 0.9;
    // The right slope: up to the rock.
    const rightTop = (x) => 192 - 92 * clamp((x - 218) / 262) ** 0.8 + Math.sin(x / 23) * 2.4 + Math.sin(x / 10 + 2) * 0.8;
    paintTerraces(rear, riceFar, { top: (x) => rightTop(x) + 8, x0: 212, x1: W, yEnd: 240, k: 22, c: 9.5, swell: swellB, swellSize: 42, seed: 23, haze: 0.2, lift: 0, bowl: (x) => 1.1 * Math.sin(x / 36 + 1) });
    paintTerraces(rear, riceFar, { top: (x) => leftTop(x) + 8, x0: 0, x1: 268, yEnd: 240, k: 22, c: 9.5, swell: swellA, swellSize: 42, seed: 37, haze: 0.16, lift: 0.03, bowl: (x) => 1.1 * Math.sin(x / 33 + 3) });
    const rearTerraces = rear.px.slice();
    const WOOD_FAR = hazed(['#23473a', '#2d5844', '#3a6c50', '#4b805c', '#619669', '#7fae78'], 0.2);
    const WOOD_NEAR = hazed(['#1f4235', '#28523f', '#33654a', '#437b56', '#598f62', '#78a871'], 0.1);
    paintForest(rear, rand, (x) => rightTop(x) - 1, 228, W, 6, 3.4, 6.4, WOOD_FAR, leafy);
    paintForest(rear, rand, (x) => leftTop(x) - 1, 0, 262, 6, 3.4, 6.4, WOOD_NEAR, leafy);

    /* ── the rock ─────────────────────────────────────────────────── */
    const ROCK = ramp('#3a3a42', '#4f4d51', '#6a645f', '#857c70', '#a29682', '#c0b398', '#dcd0b2', '#efe6cc');
    const seamed = noise2(2736, 64);
    const seamLine = noise1(2738, 128);
    for (let x = 340; x < W; x += 1) {
      const y0 = Math.round(rockTop(x) + (fbm1(seamLine, x / 5, 2) - 0.5) * 2.4);
      for (let y = y0; y < 214; y += 1) {
        const d = y - y0;
        // Blocks: quantised noise makes flat faces with hard edges; strata cut across them.
        const block = Math.round(fbm2(seamed, x / 13, y / 8, 3) * 6) / 6;
        const seam = Math.sin((y + Math.sin(x / 17) * 3) * 0.55) > 0.86 ? -0.2 : 0;
        const crack = fbm2(seamed, x / 3.2 + 9, y / 7, 2);
        const faceLeft = (rockTop(x - 3) - rockTop(x + 3)) * 0.05;
        const v = 0.72 - clamp(d / 110) * 0.32 + (block - 0.5) * 0.8 + seam + faceLeft - (x - 340) / 900 - (Math.abs(crack - 0.5) < 0.012 ? 0.34 : 0) + (d < 2 ? 0.2 : 0);
        rear.tone(x, y, ROCK, clamp(v), 0.55);
      }
    }
    // Grass and little plants in the ledges, and a bent pine holding on to the rock.
    const TUFT = [rgba('#4f7a36'), rgba('#6e9843'), rgba('#94b458'), rgba('#c0cf72')];
    for (let i = 0; i < 80; i += 1) {
      const x = 348 + rand() * 132;
      const y = rockTop(x) + (rand() < 0.5 ? 0 : rand() * 46);
      const tall = 1 + Math.floor(rand() * 3.4);
      for (let j = 0; j < tall; j += 1) rear.put(x + (j > 1 ? (i % 2 ? 1 : -1) : 0), y - j, TUFT[Math.min(3, j + (rand() < 0.4 ? 1 : 0))]);
      if (rand() < 0.5) rear.put(x + 1, y, TUFT[0]);
    }
    const PINE_BARK = rgba('#3b2c26');
    const PINE = hazed(['#16352d', '#1f4538', '#2a5842', '#386c4c', '#4c8259', '#689a68'], 0);
    limb(rear, 376, 148, 366, 128, 2, 1.1, PINE_BARK);
    limb(rear, 366, 128, 351, 116, 1.2, 0.6, PINE_BARK);
    limb(rear, 367, 130, 379, 118, 0.9, 0.5, PINE_BARK);
    for (const [cx, cy, rx, ry] of [[349, 112, 13, 4], [361, 120, 10, 3.4], [379, 113, 10, 3.4], [339, 118, 7, 2.6], [366, 110, 7, 2.6]]) {
      const list = [];
      for (let i = 0; i < rx * 3; i += 1) {
        const a = rand() * TAU;
        const d = Math.sqrt(rand());
        list.push({ x: cx + Math.cos(a) * d * rx, y: cy + Math.sin(a) * d * ry, r: 0.9 + rand() * 1.1, z: rand() });
      }
      puffs(rear, list, PINE, { light: [-0.6, -0.7, 0.35], height: 0.7, spread: 0.6, grain: leafy });
    }

    /* ── the stilt house, on its shelf on the left slope ──────────── */
    const hx = HOUSE.x;
    const hb = HOUSE.base;
    const POST = rgba('#3f2c20');
    const POST_LIT = rgba('#7c5a38');
    // The shelf it stands on: beaten earth, a bit of a yard.
    const YARD = hazed(['#6d5433', '#826740', '#987b4e', '#ad905e', '#c2a673'], 0.08);
    for (let y = hb - 6; y <= hb + 7; y += 1) {
      const half = 44 * Math.sqrt(Math.max(0, 1 - ((y - (hb + 1)) / 7.5) ** 2));
      for (let x = hx - half; x <= hx + half; x += 1) rear.tone(x, y, YARD, clamp(0.55 + (fbm2(grainNoise, x / 4, y / 3, 2) - 0.5) * 0.7 - (y - hb) * 0.03), 0.6);
    }
    for (let x = hx - 44; x <= hx + 44; x += 1) {
      const low = Math.round(hb + 1 + 7.5 * Math.sqrt(Math.max(0, 1 - ((x - hx) / 44) ** 2)));
      rear.put(x, low, rgba(x % 4 === 0 ? '#3f3424' : '#7d6a4a'));
      rear.put(x, low + 1, rgba(x % 5 === 0 ? '#54462f' : '#3f3424'));
    }
    // A banana clump behind the house, big soft leaves.
    const BANANA = [rgba('#2e6236'), rgba('#3f7f42'), rgba('#5c9c4d'), rgba('#83b75e')];
    for (const [bx, by, spread] of [[86, hb - 2, 1], [150, hb - 2, 0.86]]) {
      limb(rear, bx, by, bx + 1, by - 18 * spread, 1.4, 1, BANANA[0]);
      for (let l = 0; l < 7; l += 1) {
        const a = -Math.PI * (0.06 + (l / 6) * 0.88);
        const len = (15 + (l % 2) * 4) * spread;
        for (let i = 0; i < len; i += 1) {
          const k = i / len;
          const x = bx + 1 + Math.cos(a) * len * k;
          const y = by - 18 * spread + Math.sin(a) * len * k * 0.8 + k * k * len * 0.46;
          const half = Math.sin(k * Math.PI) * 2.4 * spread;
          for (let j = -half; j <= half; j += 1) rear.put(x, y + j, BANANA[j < -half * 0.3 ? 3 : j < half * 0.2 ? 2 : l % 2]);
        }
      }
    }
    // Posts, floor, walls of plaited bamboo.
    for (let i = 0; i < 6; i += 1) {
      const x = hx - 20 + i * 8;
      rear.rect(x, hb - 18, 2, 18, POST);
      rear.rect(x, hb - 18, 1, 18, POST_LIT);
    }
    for (const [x0, x1] of [[hx - 20, hx - 12], [hx + 12, hx + 20]]) rear.line(x0, hb - 8, x1, hb - 15, POST);
    rear.rect(hx - 24, hb - 20, 48, 2, rgba('#6e4d30'));
    rear.rect(hx - 24, hb - 20, 48, 1, rgba('#b58a55'));
    rear.rect(hx - 24, hb - 18, 48, 1, rgba('#2c1e16'));
    const MAT = ramp('#7a5a35', '#93703f', '#ad884c', '#c5a05c', '#dbb873');
    for (let y = hb - 34; y < hb - 20; y += 1) {
      for (let x = hx - 22; x < hx + 22; x += 1) {
        const weave = (x + (y % 2) * 2) % 4 < 2 ? 0.1 : -0.1;
        rear.tone(x, y, MAT, clamp(0.68 - ((x - hx + 22) / 44) * 0.36 + weave - (y < hb - 31 ? 0.3 : 0)), 0.4);
      }
    }
    // Two windows, shutters open, and a door at the head of the steps.
    for (const wx of [hx - 14, hx + 8]) {
      rear.rect(wx, hb - 30, 7, 6, rgba('#2d1f18'));
      rear.rect(wx + 1, hb - 29, 5, 4, rgba('#5c3c22'));
      rear.rect(wx - 2, hb - 31, 2, 8, rgba('#6e4d30'));
      rear.rect(wx + 7, hb - 31, 2, 8, rgba('#6e4d30'));
    }
    rear.rect(hx - 3, hb - 32, 7, 12, rgba('#2d1f18'));
    rear.rect(hx - 2, hb - 31, 5, 11, rgba('#472d1b'));
    for (let i = 0; i < 6; i += 1) {
      rear.rect(hx + 26 - i * 1, hb - 3 - i * 3, 9, 1, rgba('#a97d4c'));
      rear.rect(hx + 26 - i * 1, hb - 2 - i * 3, 9, 1, rgba('#4a3524'));
    }
    rear.line(hx + 25, hb, hx + 18, hb - 19, POST);
    rear.line(hx + 35, hb, hx + 29, hb - 19, POST);
    // The great hipped roof of palm thatch, light on its left, layers of it.
    const THATCH = ramp('#3c2e20', '#5a452c', '#7a5f38', '#9c7c45', '#bc9a56', '#d9b86c', '#efd388');
    const roofTop = hb - 60;
    const roofLow = hb - 33;
    for (let y = roofTop; y <= roofLow; y += 1) {
      const k = (y - roofTop) / (roofLow - roofTop);
      const half = mix(11, 30, k ** 0.9);
      for (let x = Math.round(hx - half); x <= hx + half; x += 1) {
        const n = (x - hx) / half;
        const course = (y - roofTop) % 4;
        const straw = hash(x * 3 + Math.floor((y - roofTop) / 4) * 17, 5);
        const v = 0.66 - n * 0.32 + (course === 3 ? -0.26 : 0) + (course === 0 ? 0.08 : 0) + (straw - 0.5) * 0.24 - k * 0.1;
        rear.tone(x, y, THATCH, clamp(v), 0.45);
      }
      rear.put(hx - half - 1, y, THATCH[6]);
    }
    rear.rect(hx - 31, roofLow + 1, 62, 1, THATCH[0]);
    rear.rect(hx - 12, roofTop - 1, 24, 2, THATCH[2]);
    rear.rect(hx - 12, roofTop - 1, 24, 1, THATCH[6]);
    // Sheaves in the yard, and a hayrick with its pole.
    for (const [x, y] of [[hx - 36, hb + 2], [hx - 28, hb + 4], [hx + 42, hb + 3]]) {
      for (let j = 0; j < 7; j += 1) {
        const half = j < 2 ? 1 : 2.4 - (j - 2) * 0.24;
        for (let i = -half; i <= half; i += 1) rear.put(x + i, y - j, rgba(i < 0 ? '#f0d683' : '#c9a955'));
      }
      rear.put(x, y - 7, rgba('#8c7c3a'));
    }

    for (let i = 0; i < rear.px.length; i += 1) if (rear.px[i] !== rearTerraces[i]) riceFar.px[i] = 0;

    /* ── the valley's cloud, in three sheets ──────────────────────── */
    const cloudSheet = (count, height, sizeW, sizeH, fade, lift) => {
      const art = new Art(960, height);
      const base = height - 2;
      for (let i = 0; i < count; i += 1) {
        const cx = ((i + rand() * 0.6) / count) * 960;
        const w = sizeW * (0.6 + rand() * 0.8);
        const hh = sizeH * (0.6 + rand() * 0.6);
        puffs(art, cumulus(rand, cx, base - rand() * (height * 0.3), w, hh), CLOUD, { wrap: true, spread: 0.8, height: 0.74, light: [-0.6, -0.72, 0.3], lift, flat: 0 });
      }
      // The underside melts away: there is no line where cloud stops, only less of it.
      for (let y = 0; y < height; y += 1) {
        const k = y / height;
        for (let x = 0; x < 960; x += 1) {
          const p = art.px[y * 960 + x];
          if (!p) continue;
          const a = clamp((1 - k) / fade);
          const level = Math.floor(a * 7 + bayer(x, y));
          if (level <= 0) art.px[y * 960 + x] = 0;
          else art.px[y * 960 + x] = (p & 0xffffff | (Math.round((level / 7) * 255) << 24)) >>> 0;
        }
      }
      return art.canvas();
    };
    const valleyBack = cloudSheet(6, 48, 210, 24, 0.62, 0.06);
    const valleyFront = cloudSheet(5, 46, 240, 20, 0.86, 0.08);
    const veil = cloudSheet(5, 22, 220, 9, 1, 0.3);

    /* ── the near hill, large enough to see the rice ──────────────── */
    const front = new Art();
    const riceNear = new Art();
    const frontTop = (x) => 192 + 15 * ((x - 214) / 240) ** 2 + Math.sin(x / 31) * 3 + Math.sin(x / 13 + 1) * 1.1;
    paintTerraces(front, riceNear, { top: frontTop, x0: 0, x1: W, yEnd: H, k: 15, c: 6.3, swell: swellC, swellSize: 52, seed: 51, haze: 0, lift: 0.03, bowl: (x) => 2 * Math.sin(x / 62 + 0.5) + 0.8 * Math.sin(x / 27 + 2) });
    const frontTerraces = front.px.slice();
    // A fringe of low bushes along its crest.
    paintForest(front, rand, (x) => frontTop(x) - 0.5, 0, W, 17, 1.8, 3.4, hazed(['#27503a', '#346445', '#467a50', '#5e915c', '#7da86c', '#9cbf7c'], 0), leafy);
    // Stooks standing in the cut fields.
    for (const [x, y] of [[62, 228], [78, 231], [352, 226], [370, 229], [384, 225], [236, 216], [248, 218]]) {
      for (let j = 0; j < 9; j += 1) {
        const half = j < 3 ? 1.2 : 3.2 - (j - 3) * 0.42;
        for (let i = -half; i <= half; i += 1) front.put(x + i, y - j, rgba(i < -half * 0.2 ? '#f6e08d' : i < half * 0.5 ? '#d3b45c' : '#a1893f'));
      }
      front.rect(x - 3, y - 2, 7, 1, rgba('#8c7632'));
      front.rect(x - 4, y + 1, 9, 1, rgba('#6d6230'));
    }

    for (let i = 0; i < front.px.length; i += 1) if (front.px[i] !== frontTerraces[i]) riceNear.px[i] = 0;

    /* ── wind: broad gusts, thrown across the rice ────────────────── */
    const gustNoise = noise2(2737, 64);
    const gustSheet = (offset, threshold, opacity) => {
      const art = new Art(960, H);
      for (let y = 90; y < H; y += 1) {
        for (let x = 0; x < 960; x += 1) {
          const a = clamp((fbm2(gustNoise, (x + y * 1.5 + offset * 15) / 15, y / 7.5, 2) - threshold) * 6.5) * opacity;
          const level = Math.floor(a * 8 + bayer(x, y));
          if (level > 0) art.px[y * 960 + x] = see('#ffffff', Math.round((level / 8) * 255));
        }
      }
      return art.canvas();
    };
    const scratch = newCanvas(W, H);
    const scratchCtx = scratch.getContext('2d');
    scratchCtx.imageSmoothingEnabled = false;

    /* ── goats ────────────────────────────────────────────────────── */
    const WHITE = { light: '#fffdf2', mid: '#f4eedd', shade: '#ddd3bd', dark: '#a8997f', belly: '#efe7d4', belly2: '#b8aa90', horn: '#6c5a45', hornLit: '#b49d78', hoof: '#2a2422', eye: '#14100e' };
    const BROWN = { light: '#c98d55', mid: '#9a6237', shade: '#7f4e2c', dark: '#553420', belly: '#d9b98c', belly2: '#9a7a55', horn: '#3e3128', hornLit: '#8a7458', hoof: '#1b1614', eye: '#0d0a08' };
    const SLATE = { light: '#8e8a8c', mid: '#5c585c', shade: '#46434a', dark: '#2c2a30', belly: '#b5aa96', belly2: '#79705f', horn: '#2c2622', hornLit: '#7c705c', hoof: '#16130f', eye: '#ffe08a' };
    // The one who looks out over the valley, head high, three small changes of mind.
    const lookout = [
      goatSprite(1.12, { poll: [12, 22.5], snout: -0.42 }, WHITE),
      goatSprite(1.12, { poll: [12.4, 23.2], snout: -0.3 }, WHITE),
      goatSprite(1.12, { poll: [12, 22.5], snout: -0.42, ear: 1.6, tailUp: 1.5 }, WHITE),
    ];
    // Climbing, in a walk: diagonal pairs of legs; going up facing right, coming down facing left.
    const walkFrames = (dir, tilt) => {
      const frames = [];
      for (let f = 0; f < CLIMB_STEPS; f += 1) {
        const ph = (f / CLIMB_STEPS) * TAU;
        const a = Math.sin(ph) * 3.2;
        const b = Math.sin(ph + Math.PI / 2) * 3.2;
        const up = (v) => Math.max(0, Math.cos(v)) * 2;
        frames.push(goatSprite(1, {
          dir, tilt,
          poll: [12.4, dir > 0 ? 20 : 19.2], snout: -0.7,
          legs: [a, -a, -b, b],
          lift: [up(ph), up(ph + Math.PI), up(ph + Math.PI * 1.5), up(ph + Math.PI / 2)],
        }, BROWN));
      }
      return frames;
    };
    const climbing = { up: walkFrames(1, 0.66), down: walkFrames(-1, -0.66), restUp: goatSprite(1, { dir: 1, tilt: 0.66, poll: [12.6, 21], snout: -0.5 }, BROWN), restDown: goatSprite(1, { dir: -1, tilt: -0.66, poll: [12.6, 21.6], snout: -0.5 }, BROWN) };
    // One lying down at the back, chewing; a kid who cannot keep still.
    const lying = [
      goatSprite(0.98, { lying: true, poll: [12, 21], snout: -0.46 }, SLATE),
      goatSprite(0.98, { lying: true, poll: [12, 21], snout: -0.46, chew: 1 }, SLATE),
      goatSprite(0.98, { lying: true, poll: [12, 21], snout: -0.3, ear: 1.5 }, SLATE),
    ];
    const kid = {
      stand: goatSprite(0.62, { poll: [12.4, 22], snout: -0.5, tailUp: 1.4 }, WHITE),
      crouch: goatSprite(0.62, { poll: [12, 20.5], snout: -0.7, legs: [1.8, 1.2, -1.8, -1.2], tailUp: 1.4 }, WHITE),
      leap: goatSprite(0.62, { poll: [12.6, 22.8], snout: -0.3, legs: [3, 2.2, -3, -2.2], lift: [2.6, 2, 2.6, 2], tailUp: 1.8 }, WHITE),
    };

    /* ── people ───────────────────────────────────────────────────── */
    const figure = (bend) => {
      const art = new Art(13, 16);
      const hat = rgba('#f4e4b0');
      const hatDark = rgba('#b89b5c');
      const shirt = rgba('#2c3f62');
      const shirtLit = rgba('#4f6a94');
      const skin = rgba('#b5774c');
      const pants = rgba('#1e2438');
      art.rect(5, 10, 1, 5, pants);
      art.rect(7, 10, 1, 5, pants);
      if (bend) {
        art.rect(3, 6, 6, 3, shirt);
        art.rect(3, 6, 4, 1, shirtLit);
        art.rect(4, 9, 4, 1, shirt);
        art.line(3, 8, 1, 11, skin);
        art.put(0, 12, rgba('#d8d8d0'));
        art.put(1, 12, rgba('#7c5a38'));
        for (let i = 0; i < 4; i += 1) art.rect(2 - i, 3 + i, 1 + i * 2, 1, i === 3 ? hatDark : hat);
      } else {
        art.rect(4, 5, 5, 5, shirt);
        art.rect(4, 5, 2, 5, shirtLit);
        art.line(4, 6, 2, 9, skin);
        art.put(2, 10, rgba('#ecd27c'));
        art.put(1, 10, rgba('#ecd27c'));
        art.put(1, 9, rgba('#ecd27c'));
        for (let i = 0; i < 4; i += 1) art.rect(6 - i, 1 + i, 1 + i * 2, 1, i === 3 ? hatDark : hat);
      }
      return art.canvas();
    };
    const people = [figure(true), figure(false)];
    const workers = [
      { x: 148, y: 243, phase: 0.1, period: 3.3 },
      { x: 162, y: 246, phase: 0.55, period: 2.9 },
      { x: 306, y: 232, phase: 0.3, period: 3.7 },
      { x: 94, y: 255, phase: 0.75, period: 3.1 },
    ];

    /* ── rice in front of us: one ear at a time ───────────────────── */
    const earFrames = (tall, colours) => [-1, 0, 1].map((bend) => {
      const art = new Art(tall + 8, tall + 2);
      const mid = 4;
      const stem = colours[0];
      const stem2 = colours[3];
      let x = mid;
      for (let j = 0; j < tall; j += 1) {
        const k = j / tall;
        x = mid + bend * 1.8 * k * k;
        art.put(x, tall - j, k > 0.5 ? stem2 : stem);
      }
      // The head droops over, full of grain.
      const head = Math.round(tall * 0.56);
      for (let i = 0; i < head; i += 1) {
        const k = i / head;
        const hx2 = x + 1 + bend * 0.8 + k * (tall * 0.34);
        const hy = 1 + Math.round(k * k * head * 0.82);
        art.put(hx2, hy, colours[i % 2 ? 1 : 2]);
        art.put(hx2, hy + 1, colours[1]);
        art.put(hx2 - 1, hy + 1, colours[i % 3 ? 1 : 2]);
        if (i % 2 === 0) art.put(hx2, hy + 2, colours[3]);
      }
      return art.canvas();
    });
    const EARS = [rgba('#a59a32'), rgba('#e4bf3a'), rgba('#fff3a8'), rgba('#c4a830')];
    const EARS_DARK = [rgba('#7a7c2c'), rgba('#cca52e'), rgba('#f2d152'), rgba('#a18a2a')];
    const earKinds = [earFrames(10, EARS), earFrames(14, EARS), earFrames(9, EARS_DARK), earFrames(17, EARS_DARK)];
    const ears = [];
    for (let x = -4; x < W + 4; x += 1.5 + rand() * 2.2) {
      const edge = Math.min(1, Math.abs(x - 240) / 240);
      const kind = rand() < 0.3 + edge * 0.4 ? 3 : Math.floor(rand() * 3);
      ears.push({ x: Math.round(x), kind, y: 272 - Math.round(rand() * 6) + (edge < 0.5 ? 4 : 0), phase: rand() * 1.4 });
    }
    ears.sort((p, q) => p.y - q.y);

    /* ── birds, smoke ─────────────────────────────────────────────── */
    const egret = (wings) => {
      const art = new Art(13, 9);
      const white = rgba('#ffffff');
      const pale = rgba('#c8d0d0');
      art.rect(4, 4, 5, 1, white);
      art.line(8, 4, 11, 3, white);
      art.put(12, 3, rgba('#e8b23c'));
      art.line(0, 4, 3, 4, pale);
      if (wings === 0) art.line(7, 3, 4, 0, white);
      else if (wings === 1) art.line(7, 3, 2, 2, white);
      else art.line(7, 5, 4, 8, pale);
      return art.canvas();
    };
    const motes = [];
    for (let i = 0; i < 30; i += 1) motes.push({ x: rand() * W, y: 60 + rand() * 160, v: 6 + rand() * 10, sway: 2 + rand() * 6, period: 3 + rand() * 6, phase: rand(), blink: 2 + rand() * 3 });

    return {
      sky: sky.canvas(), high: high.canvas(), back: back.canvas(), rear: rear.canvas(), front: front.canvas(),
      riceFar: riceFar.canvas(), riceNear: riceNear.canvas(), gustA: gustSheet(0, 0.52, 0.62), gustB: gustSheet(21, 0.55, 0.5),
      scratch, scratchCtx,
      valleyBack, valleyFront, veil,
      mistFar: glowOf(240, 22, '#f8f4e6', 0.72, 1.1), sunGlow: glowOf(150, 120, '#fff0c0', 0.3, 2),
      lookout, climbing, lying, kid, people, workers, earKinds, ears, motes,
      egrets: [egret(0), egret(1), egret(2), egret(1)],
      smoke: [glowOf(2, 2, '#e8ecee', 0.95, 0.8), glowOf(3, 3, '#e8ecee', 0.9, 0.8), glowOf(5, 4, '#e8ecee', 0.85, 0.8), glowOf(7, 6, '#e8ecee', 0.8, 0.8)],
    };
  },

  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(s.sunGlow, 96 - 150, 44 - 120);
    ctx.globalCompositeOperation = 'source-over';
    slide(ctx, s.high, along(t, 0.8, 960), 2);
    ctx.drawImage(s.back, 0, 0);
    ctx.drawImage(s.mistFar, 240 - 240, 132 - 22);
    ctx.drawImage(s.mistFar, 240 - 240, 156 - 22);

    ctx.drawImage(s.rear, 0, 0);

    // A gust goes over the far rice: light only where there is rice to catch it.
    const wind = (lit, sheets, top) => {
      const c = s.scratchCtx;
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, top, W, H - top);
      for (const [sheet, speed] of sheets) {
        const w = 960;
        const x = -(((t * speed) % w + w) % w);
        c.drawImage(sheet, x, 0);
        if (x + w < W) c.drawImage(sheet, x + w, 0);
      }
      c.globalCompositeOperation = 'source-in';
      c.drawImage(lit, 0, 0);
      c.globalCompositeOperation = 'source-over';
      ctx.drawImage(s.scratch, 0, top, W, H - top, 0, top, W, H - top);
    };
    wind(s.riceFar, [[s.gustA, 11]], 90);

    // Smoke from the kitchen fire, going straight up and then the way of the air.
    for (let i = 0; i < 22; i += 1) {
      const k = (t / 13 + i / 22) % 1;
      const seed = i * 2.399;
      const x = 124 + k * k * 44 + Math.sin(k * 8 + seed) * (1 + k * 5);
      const y = 80 - k * 74;
      const puff = s.smoke[Math.min(3, Math.floor(k * 4.4))];
      ctx.globalAlpha = (1 - k) * 0.85 * Math.min(1, k * 12);
      ctx.drawImage(puff, Math.round(x - puff.width / 2), Math.round(y - puff.height / 2));
    }
    ctx.globalAlpha = 1;

    // The goats on the rock.
    const stamp = (sprite, x, y) => ctx.drawImage(sprite.image, Math.round(x) - sprite.ox, Math.round(y) - sprite.oy);
    // At the back, lying down, chewing.
    const chewing = (t % 11) < 6 ? Math.floor(t * 2.5) % 2 : (t % 11) < 6.8 ? 2 : 0;
    stamp(s.lying[chewing], 466, rockTop(466) + 1);
    // The one looking out: long stillness, a small lift of the head, an ear.
    const look = t % 19;
    stamp(s.lookout[look < 5 ? 0 : look < 8.5 ? 1 : look < 9.1 ? 2 : look < 16 ? 0 : 1], 442, rockTop(442) + 1);

    // The climber: up, a look round at the top, back down, a look round at the bottom.
    const c = t % CLIMB_SECONDS;
    const upFor = 12;
    const restFor = 5;
    let at;
    let climb;
    if (c < upFor) {
      at = c / upFor;
      climb = 'up';
    } else if (c < upFor + restFor) {
      at = 1;
      climb = 'restUp';
    } else if (c < upFor * 2 + restFor) {
      at = 1 - (c - upFor - restFor) / upFor;
      climb = 'down';
    } else {
      at = 0;
      climb = 'restDown';
    }
    const cx = mix(CLIMB_FROM, CLIMB_TO, at);
    const cy = rockTop(cx) + 3;
    if (climb === 'up' || climb === 'down') {
      const frame = Math.floor((t * CLIMB_STEPS) / 1.1) % CLIMB_STEPS;
      stamp(s.climbing[climb][frame], cx, cy);
    } else stamp(s.climbing[climb], cx, cy);

    // A kid, all legs: three hops, then it stops to look at nothing.
    const kidT = t % 14;
    const hops = Math.min(1, kidT / 4.2);
    const kx = mix(450, 458, Math.abs(((t / 28) % 1) * 2 - 1));
    const hopK = (kidT % 1.4) / 1.4;
    const inAir = kidT < 4.2 && hopK > 0.25;
    const kidLift = inAir ? Math.sin(((hopK - 0.25) / 0.75) * Math.PI) * 6 : 0;
    const kidPose = hops < 1 ? (inAir ? s.kid.leap : s.kid.crouch) : s.kid.stand;
    stamp(kidPose, kx, rockTop(kx) + 1 - kidLift);

    // Two egrets, low over the valley.
    const eCycle = (t % 73) / 30;
    if (eCycle < 1) {
      const ex = W + 20 - eCycle * (W + 60);
      for (const [dx, dy, off] of [[0, 0, 0], [17, 5, 1]]) {
        const ey = 154 + dy + wave(t, 13) * 5;
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(s.egrets[(Math.floor(t * 3.4) + off) % 4], -Math.round(ex + dx) - 13, Math.round(ey));
        ctx.restore();
      }
    }

    // Cloud lying in the valley: the back sheet in front of the slopes' feet, slowly.
    slide(ctx, s.valleyBack, along(t, 2.2, 960), 150);

    ctx.drawImage(s.front, 0, 0);
    wind(s.riceNear, [[s.gustA, 19], [s.gustB, 28]], 170);

    // People cutting rice, each at their own pace.
    for (const w of s.workers) {
      const v = wave(t, w.period, w.phase);
      ctx.drawImage(s.people[v > 0.72 ? 1 : 0], w.x, w.y - 15 + (v > 0.72 ? 0 : 1));
    }

    slide(ctx, s.valleyFront, along(t, 3.4, 960), 150);
    ctx.globalAlpha = 0.42;
    slide(ctx, s.veil, along(t, 5.2, 960), 182);
    ctx.globalAlpha = 1;

    // Specks going by on the air.
    ctx.fillStyle = '#fffbe0';
    for (const m of s.motes) {
      if (wave(t, m.blink, m.phase) < -0.1) continue;
      const span = W + 10;
      const x = ((m.x - t * m.v) % span + span) % span - 5;
      ctx.fillRect(Math.round(x), Math.round(m.y + wave(t, m.period, m.phase) * m.sway), 1, 1);
    }

    // The ears of rice in front of us, and wind going through them as a travelling wave.
    for (const e of s.ears) {
      const v = Math.sin(e.x * 0.052 - t * 2.1) * 0.72 + Math.sin(e.x * 0.021 - t * 0.9 + e.phase) * 0.46;
      const frames = s.earKinds[e.kind];
      const f = frames[v < -0.34 ? 0 : v > 0.34 ? 2 : 1];
      ctx.drawImage(f, e.x - 4, e.y - f.height);
    }
  },
};

export default goatTerrace;
