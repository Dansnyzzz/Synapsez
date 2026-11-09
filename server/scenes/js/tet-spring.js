import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, noise1, noise2, fbm2, ridged, puffs, cumulus, sprite, slide } from './art.js';

/*
 * The first morning of the year of the Goat, on a hillside. The sun is high on the
 * left, so everything is lit from that side. Pink, red and gold on a clean pale sky.
 */

const SKY = ramp('#86c3ec', '#94cbef', '#a3d3f1', '#b3dbf3', '#c3e3f5', '#d3eaf6', '#e2f1f6', '#eff6f2', '#f9f9e8', '#fffbe0');
const GRASS = ramp('#3f8038', '#4f943c', '#62a742', '#79b949', '#92c955', '#add764', '#c9e47c');
const BLOSSOM_BACK = ramp('#8e2a62', '#a63672', '#bc4684', '#d05a96', '#e074aa');
const BLOSSOM = ramp('#bb2f74', '#d0468a', '#e2609e', '#f07cb2', '#f99ac6', '#feb9d8', '#ffdcea');
const BARK = ramp('#21131d', '#352028', '#4c2e30', '#67423a', '#87604b', '#a98166');
const RED = ramp('#7a1216', '#a31a1d', '#c92425', '#e63a30', '#fa5c46', '#ff8f70');
const TILE = ramp('#5a241d', '#7a3324', '#96442b', '#b05832', '#c9713f', '#e09358');
const LIME = ramp('#b9a57c', '#cfbc90', '#e2d2a8', '#f0e4c2', '#fbf4dc');

const mirror = (rows) => {
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => [...r.padEnd(width)].reverse().join(''));
};

/** A paper lantern at five leanings, hung from the middle of its top. */
function lanternFrames(rx, ry, tassel) {
  const frames = [];
  const GOLD = rgba('#ffd257');
  const GOLD_D = rgba('#c98f24');
  const pad = 5;
  for (let f = -2; f <= 2; f += 1) {
    const lean = f * 0.1;
    const w = rx * 2 + 1 + pad * 2;
    const art = new Art(w, ry * 2 + tassel + 6);
    const cx = (w - 1) / 2;
    const at = (x, y, c) => art.put(Math.round(cx + x + lean * y), y, c);
    const cy = ry + 2;
    at(0, 0, GOLD_D);
    for (let x = -1; x <= 1; x += 1) at(x, 1, x < 0 ? GOLD : GOLD_D);
    for (let y = cy - ry; y <= cy + ry; y += 1) {
      const half = rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / (ry + 0.3)) ** 2));
      for (let x = Math.round(-half); x <= half; x += 1) {
        const u = x / Math.max(1, half);
        const rib = Math.abs(u) > 0.2 && Math.abs((Math.abs(u) - 0.28) % 0.42) < 0.09 ? -0.26 : 0;
        const v = 0.66 - u * 0.36 - ((y - cy) / ry) * 0.22 + rib + (u < -0.25 && u > -0.7 && y < cy ? 0.26 : 0);
        const n = RED.length - 1;
        const i = Math.round(clamp(v) * n + (bayer(x + 8, y) - 0.5) * 0.6);
        at(x, y, RED[i < 0 ? 0 : i > n ? n : i]);
      }
    }
    for (let x = -2; x <= 2; x += 1) at(x, cy - ry, x < 1 ? GOLD : GOLD_D);
    for (let x = -2; x <= 2; x += 1) at(x, cy + ry, x < 1 ? GOLD : GOLD_D);
    const low = cy + ry + 1;
    at(0, low, GOLD_D);
    for (let j = 1; j <= tassel; j += 1) {
      at(-1, low + j, j % 2 ? RED[3] : GOLD);
      at(0, low + j, GOLD);
      at(1, low + j, j % 2 ? GOLD_D : RED[2]);
    }
    frames.push(art.canvas());
  }
  return { frames, cx: (rx * 2 + 1 + pad * 2 - 1) / 2 };
}

/** A small swallow-tailed banner at five leanings, plain red, gold along its top. */
function bannerFrames() {
  const frames = [];
  const GOLD = rgba('#ffd257');
  for (let f = -2; f <= 2; f += 1) {
    const art = new Art(14, 13);
    const at = (x, y, c) => art.put(Math.round(4 + x + f * 0.34 * y * 0.5 + Math.sin(y * 0.8 + f) * 0.25), y, c);
    for (let x = 0; x < 7; x += 1) at(x, 0, GOLD);
    for (let y = 1; y < 12; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        if (y > 8 && x >= 3 - (11 - y) && x <= 3 + (11 - y)) continue;
        at(x, y, x < 2 ? RED[4] : x < 5 ? RED[3] : RED[2]);
      }
    }
    frames.push(art.canvas());
  }
  return frames;
}

/* Goats: `w` lit coat, `s` and `d` its shadows, `h` horn, `e` eye, `k` hoof, `b` beard, `p` nose, `r` ribbon. */
const GOAT_COLOURS = { w: '#ffffff', s: '#e3e6ef', d: '#bcc2d6', h: '#a9825a', e: '#241a20', k: '#3d3238', b: '#efeae0', p: '#efa0a0', r: '#e0302e', g: '#ffd257' };
const GOAT_UP = [
  '           hh    ',
  '          h hh   ',
  '            wwww ',
  '           wwewwp',
  ' w         rwwww ',
  ' ww  wwwwwwrww b ',
  '  wwwwwwwwwwww   ',
  '  wwwwwwwwwwss   ',
  '  sssssssssss    ',
  '  dd s     s dd  ',
  '  d  s     s  d  ',
  '  k  k     k  k  ',
];
const GOAT_GRAZE = [
  '                 ',
  '                 ',
  '                 ',
  '                 ',
  ' w    wwwwwww    ',
  ' ww wwwwwwwwwwhh ',
  '  wwwwwwwwwwwwrh ',
  '  wwwwwwwwwwssrww',
  '  sssssssssss wew',
  '  dd s     s  wwp',
  '  d  s     s d b ',
  '  k  k     k k   ',
];
const GOAT_CHEW = [
  '                 ',
  '                 ',
  '                 ',
  '                 ',
  ' w    wwwwwww    ',
  ' ww wwwwwwwwwwhh ',
  '  wwwwwwwwwwwwrh ',
  '  wwwwwwwwwwssrw ',
  '  sssssssssss wew',
  '  dd s     s  wwp',
  '  d  s     s d wb',
  '  k  k     k k   ',
];
const BIG_UP = [
  '                hhh     ',
  '               hh  h    ',
  '               h  wwww  ',
  '              pww wwwwww',
  '              pwwwwewwww',
  '                wwwwwwwn',
  ' w              rwwwwss ',
  ' ww             rwww bb ',
  ' www wwwwwwwwwwwwwww bb ',
  '  wwwwwwwwwwwwwwwwww  b ',
  '  wwwwwwwwwwwwwwwwww    ',
  '  wwwwwwwwwwwwwwwwss    ',
  '  swwwwwwwwwwwwwwsss    ',
  '  sssssssssssssssss     ',
  '   ddss  sd   ss  dd    ',
  '   dds   sd   ss  dd    ',
  '   dd    sd   sd  dd    ',
  '   kk    kk   kk  kk    ',
];
const BIG_GRAZE = [
  '                        ',
  '                        ',
  '                        ',
  '                        ',
  '                        ',
  '                        ',
  ' w                      ',
  ' ww   wwwwwwwwwwwww     ',
  ' www wwwwwwwwwwwwwwwhh  ',
  '  wwwwwwwwwwwwwwwwwwwhh ',
  '  wwwwwwwwwwwwwwwwwwrwph',
  '  wwwwwwwwwwwwwwwwssrwww',
  '  swwwwwwwwwwwwwwsss wew',
  '  sssssssssssssssss  www',
  '   ddss  sd   ss  dd wwn',
  '   dds   sd   ss  dd bb ',
  '   dd    sd   sd  dd  b ',
  '   kk    kk   kk  kk    ',
];
const BIG_CHEW = [...BIG_GRAZE.slice(0, 14), '   ddss  sd   ss  dd wn ', '   dds   sd   ss  dd wwb', '   dd    sd   sd  dd  b ', '   kk    kk   kk  kk    '];
const BIG_LEAP = [
  ...BIG_UP.slice(0, 14),
  '  ddss        ss dd     ',
  ' dd              dd     ',
  ' kk               kk    ',
];
const KID_UP = [
  '         h    ',
  '        wwww  ',
  '       pwwewwn',
  ' w      rwwww ',
  ' wwwwwwwrww b ',
  ' wwwwwwwwww   ',
  ' wwwwwwwwss   ',
  ' ssssssssss   ',
  ' d s    s d   ',
  ' d s    s d   ',
  ' k k    k k   ',
];
const KID_LEAP = [...KID_UP.slice(0, 8), 'ds        sd  ', 'k          k  '];

/** A flower of the peach, seen open: five petals round a dark heart. */
function flower(art, x, y, big, rand) {
  const lit = rgba(rand() < 0.45 ? '#ffe2ee' : '#ffc4dc');
  const mid = rgba(rand() < 0.5 ? '#fb92bc' : '#ef6fa6');
  const heart = rgba('#9c1250');
  if (big) {
    const rows = [' LL  ', 'LLLMM', 'LLcMM', ' LMM ', ' M M '];
    rows.forEach((row, j) => {
      [...row].forEach((ch, i) => {
        if (ch === 'L') art.put(x + i - 2, y + j - 2, lit);
        else if (ch === 'M') art.put(x + i - 2, y + j - 2, mid);
        else if (ch === 'c') art.put(x + i - 2, y + j - 2, heart);
      });
    });
    art.put(x + 1, y - 1, rgba('#ffe07a'));
  } else {
    art.put(x, y - 1, lit);
    art.put(x - 1, y, lit);
    art.put(x + 1, y, mid);
    art.put(x, y + 1, mid);
    art.put(x, y, heart);
  }
}

/** The limbs of the peach tree, in the order they're painted, and the twigs blossom can go on. */
function growPeach(rand) {
  const limbs = [];
  const twigs = [];
  const grow = (sx, sy, angle, length, r, depth) => {
    let x = sx;
    let y = sy;
    let a = angle;
    const steps = Math.ceil(length);
    for (let i = 0; i < steps; i += 1) {
      a += (rand() - 0.5) * 0.3 + Math.sin(i * 0.27 + depth * 2) * 0.05;
      x += Math.cos(a);
      y += Math.sin(a);
      limbs.push({ x, y, r: r * (1 - 0.34 * (i / steps)) });
      if (depth <= 1) twigs.push({ x, y });
    }
    if (depth > 0) {
      const kids = depth > 3 ? 2 : 2 + (rand() < 0.55 ? 1 : 0);
      for (let k = 0; k < kids; k += 1) {
        const side = kids === 1 ? 0 : (k / (kids - 1)) * 2 - 1;
        grow(x, y, a + side * (0.42 + rand() * 0.3) + (rand() - 0.5) * 0.2, length * (0.6 + rand() * 0.22), r * 0.64, depth - 1);
      }
    }
  };
  // The trunk, old and twisted, by hand.
  const trunk = [[406, 240, 9.5], [401, 222, 8], [396, 206, 7], [401, 188, 6.6], [406, 176, 6.4], [400, 160, 6]];
  for (let i = 0; i + 1 < trunk.length; i += 1) {
    const [ax, ay, ar] = trunk[i];
    const [bx, by, br] = trunk[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let k = 0; k < n; k += 1) limbs.push({ x: mix(ax, bx, k / n), y: mix(ay, by, k / n), r: mix(ar, br, k / n) });
  }
  grow(400, 160, -2.72, 58, 4.8, 4);
  grow(400, 160, -2.05, 50, 4.8, 4);
  grow(401, 162, -1.56, 44, 4.2, 4);
  grow(402, 160, -1.08, 44, 4.4, 4);
  grow(404, 164, -0.62, 36, 3.8, 3);
  grow(403, 184, -2.95, 34, 3.2, 3);
  grow(405, 190, -0.28, 26, 2.8, 2);
  return { limbs, twigs };
}

/** Paint limbs lit from the upper left, with a rough grain. */
function paintLimbs(art, limbs, grain) {
  for (const l of limbs) {
    const r = Math.max(0.7, l.r);
    const top = Math.ceil(r);
    for (let dy = -top; dy <= top; dy += 1) {
      for (let dx = -top; dx <= top; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(l.x) + dx;
        const py = Math.round(l.y) + dy;
        const v = 0.52 - (dx / r) * 0.34 - (dy / r) * 0.24 + (grain(px / 2.4, py / 5.5) - 0.5) * 0.72;
        art.tone(px, py, BARK, v, 0.6);
      }
    }
  }
}

/** Blossom in clusters: separate lumps with gaps between, so the dark boughs show through. */
function clusterBalls(rand, cx, cy, spread, count, rMin, rMax) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    list.push({ x: cx + Math.cos(a) * k * spread, y: cy + Math.sin(a) * k * spread * 0.82, r: rMin + rand() * (rMax - rMin), z: rand() * 2 });
  }
  return list;
}

/** A line strung across the picture, with what hangs from it. */
function stringLine(x0, y0, x1, y1, sag, gap, lantern, rand, bannersBetween = true) {
  const items = [];
  const length = Math.abs(x1 - x0);
  const count = Math.max(1, Math.round(length / gap));
  for (let i = 0; i <= count; i += 1) {
    const k = (i + 0.5) / (count + 1);
    items.push({ k, kind: 'lantern', phase: rand(), period: 3.1 + rand() * 1.8, size: lantern });
    if (bannersBetween && i < count) {
      const j = (i + 1) / (count + 1);
      items.push({ k: j - 5.5 / length, kind: 'banner', phase: rand(), period: 2.3 + rand() * 1.2 });
      items.push({ k: j + 5.5 / length, kind: 'banner', phase: rand(), period: 2.3 + rand() * 1.2 });
    }
  }
  return { x0, y0, x1, y1, sag, items };
}

const lineAt = (ln, k, t) => mix(ln.y0, ln.y1, k) + ln.sag * 4 * k * (1 - k) + Math.sin(t / 3.7 + k * 5) * 1.1 * Math.sin(k * Math.PI);

function drawLine(ctx, ln, t, s) {
  const span = ln.x1 - ln.x0;
  ctx.fillStyle = '#6d2a2a';
  for (let i = 0; i <= Math.abs(span); i += 2) {
    const k = i / Math.abs(span);
    ctx.fillRect(Math.round(mix(ln.x0, ln.x1, k)), Math.round(lineAt(ln, k, t)), 2, 1);
  }
  for (const item of ln.items) {
    const x = Math.round(mix(ln.x0, ln.x1, item.k));
    const y = Math.round(lineAt(ln, item.k, t));
    const lean = wave(t, item.period, item.phase) * 0.72 + wave(t, 11, 0.2) * 0.4;
    const frame = clamp(Math.round(lean * 2) + 2, 0, 4);
    if (item.kind === 'banner') ctx.drawImage(s.banners[frame], x - 7, y);
    else {
      const lantern = s[item.size];
      ctx.fillStyle = '#6d2a2a';
      ctx.fillRect(x, y, 1, 2);
      ctx.drawImage(lantern.frames[frame], Math.round(x - lantern.cx), y + 1);
    }
  }
}

/** Tet: a hillside on the first morning, peach in bloom, lanterns out, and the goats who've got the year. */
const tetSpring = {
  build() {
    const rand = seeded(6201);

    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const sun = 0.5 * Math.exp(-((Math.hypot((x - 74) / 1.3, y - 22) / 96) ** 2));
      return clamp(0.02 + (y / 176) ** 1.25 * 0.82 + sun);
    }, 0.9);

    const CLOUD = ramp('#b9d6ec', '#cfe3f2', '#e2eef7', '#f1f7fa', '#fbfdfe', '#ffffff');
    const cloudsFar = new Art(960, 110);
    for (const [cx, base, w, h] of [[70, 96, 90, 22], [220, 104, 120, 26], [390, 92, 80, 18], [520, 102, 130, 28], [700, 94, 90, 20], [860, 104, 120, 24]]) {
      puffs(cloudsFar, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.5, height: 0.72, flat: 4, lift: 0.14, light: [-0.55, -0.75, 0.3] });
    }
    const cloudsNear = new Art(960, 96);
    for (const [cx, base, w, h] of [[120, 62, 170, 40], [430, 76, 210, 48], [740, 58, 190, 44]]) {
      puffs(cloudsNear, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.5, height: 0.6, flat: 6, lift: 0.2, light: [-0.55, -0.75, 0.3] });
    }

    // Mountains in three depths, the valley mist rising between them.
    const land = new Art();
    const rock = noise2(6202, 64);
    const bands = [
      { n: noise1(6203, 256), y: 146, tall: 64, scale: 66, pal: ramp('#8fb6dc', '#9fc2e2', '#b2cfe9', '#c7dcf0', '#dceaf5') },
      { n: noise1(6204, 256), y: 164, tall: 50, scale: 54, pal: ramp('#6c9cc6', '#7dabd0', '#92bbda', '#abcde4', '#c8e0ee') },
      { n: noise1(6205, 256), y: 184, tall: 34, scale: 44, pal: ramp('#5f9aa8', '#74aab2', '#8cbcbe', '#a6cdcb', '#c2ddd8') },
    ];
    bands.forEach((b, depth) => {
      const top = (x) => b.y - ridged(b.n, x / b.scale + depth * 9, 4) * b.tall;
      for (let x = 0; x < W; x += 1) {
        const a = top(x);
        const slope = top(x + 2) - top(x - 2);
        for (let y = Math.round(a); y < 214; y += 1) {
          const streak = fbm2(rock, (x + y * 0.5) / 7 + depth * 11, y / 9, 3) - 0.5;
          const mist = clamp((y - (b.y - 8)) / 30);
          land.tone(x, y, b.pal, clamp(0.38 - slope * 0.15 + streak * 0.3 + mist * 0.6), 0.75);
        }
      }
    });

    // Terraces on the valley side, some of them holding the sky.
    const contour = noise1(6206, 128);
    const FIELD = ramp('#6fa84e', '#84b957', '#9bca63', '#b4d973');
    const WATER = ramp('#a8d5dc', '#c4e4e6', '#e0f1ee');
    const ledge = rgba('#558a42');
    const terrTop = (x) => 180 + Math.sin(x / 76 + 0.6) * 8 + (contour(x / 28) - 0.5) * 9;
    for (let x = 0; x < W; x += 1) {
      const top = terrTop(x);
      for (let y = Math.round(top); y < 232; y += 1) {
        const c = (y - top * 0.5 + Math.sin(x / 41) * 5 + Math.sin(x / 17) * 1.2) / 5.4;
        const step = Math.floor(c);
        const f = c - step;
        const hash = Math.abs(Math.sin(step * 91.7 + Math.floor((x + step * 37) / 96) * 13.1)) % 1;
        if (f < 0.2) land.put(x, y, ledge);
        else if (hash < 0.3) land.tone(x, y, WATER, 0.5 + (f - 0.5) * 0.6, 0.6);
        else land.tone(x, y, FIELD, 0.28 + hash * 0.62 - (f - 0.5) * 0.2, 0.6);
      }
    }

    // The shoulder of the hill the house stands on.
    const grassGrain = noise2(6207, 64);
    const midHill = (x) => 193 + Math.sin(x / 92 + 2.2) * 5 + Math.max(0, x - 236) * 0.22;
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(midHill(x));
      for (let y = top; y < 244; y += 1) {
        land.tone(x, y, GRASS, 0.72 - (y - top) / 90 + (fbm2(grassGrain, x / 6, y / 3.5, 3) - 0.5) * 0.5 + (y === top ? 0.14 : 0), 0.85);
      }
    }

    // The house and all that's about it.
    const mid = new Art();
    // Areca palms behind, slim and pale.
    const palmG = ramp('#2f7a44', '#459350', '#65ad5a', '#8fc768');
    const palms = [[58, 196, 92], [214, 192, 104], [228, 196, 78], [36, 196, 70]];
    for (const [px, base, tall] of palms) {
      for (let j = 0; j < tall; j += 1) {
        const bend = Math.sin((j / tall) * 1.6) * 2.5;
        mid.put(px + bend, base - j, rgba('#b6a68e'));
        mid.put(px + bend + 1, base - j, rgba(j % 5 ? '#8c7c6e' : '#6f6058'));
      }
      const hx = px + Math.sin(1.6) * 2.5;
      const hy = base - tall;
      for (let f = 0; f < 11; f += 1) {
        const a = -Math.PI * ((f + 0.5) / 11) - 0.05;
        const len = 15 + rand() * 7;
        for (let k = 0; k < len; k += 1) {
          const q = k / len;
          const fx = hx + Math.cos(a) * k;
          const fy = hy + Math.sin(a) * k + q * q * 11;
          const c = palmG[Math.min(3, Math.round(2.4 - Math.cos(a) * 1.1 - q))];
          mid.put(fx, fy, c);
          if (k % 2 === 0) {
            mid.put(fx, fy + 1, palmG[Math.max(0, Math.round(1.6 - Math.cos(a) * 0.9 - q))]);
            mid.put(fx + (Math.cos(a) > 0 ? 1 : -1), fy + 2, palmG[0]);
          }
        }
      }
    }
    // A clump of bamboo at the far side.
    const BAMBOO = ramp('#2c6d3f', '#3f8848', '#5ca552', '#84c060');
    const bamboo = [];
    for (let i = 0; i < 26; i += 1) bamboo.push({ x: 14 + rand() * 40, y: 132 + rand() * 46, r: 5 + rand() * 7, z: rand() * 3 });
    for (let x = 18; x < 52; x += 5) mid.rect(x, 136, 1, 60, rgba('#2c5f3a'));
    puffs(mid, bamboo, BAMBOO, { spread: 0.9, height: 0.55, lift: 0.06, light: [-0.6, -0.7, 0.4], grain: (x, y) => (fbm2(grassGrain, x / 2.2, y / 2.6, 2) - 0.5) * 0.6 });

    // The lime-washed yard wall, tile along its top.
    const wallAt = (x0, x1, y, h) => {
      for (let yy = y; yy < y + h; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const course = yy % 3 === 0 || (xx + Math.floor(yy / 3) * 3) % 7 === 0 ? -0.1 : 0;
          mid.tone(xx, yy, LIME, 0.6 + course + (fbm2(rock, xx / 6, yy / 4, 2) - 0.5) * 0.3 - (yy - y) * 0.02, 0.6);
        }
      }
      mid.rect(x0 - 1, y - 2, x1 - x0 + 2, 2, TILE[3]);
      mid.rect(x0 - 1, y - 3, x1 - x0 + 2, 1, TILE[5]);
      for (let xx = x0; xx < x1; xx += 3) mid.put(xx, y - 1, TILE[1]);
      mid.rect(x0, y, x1 - x0, 1, LIME[0]);
    };
    wallAt(30, 58, 180, 15);
    wallAt(204, 262, 186, 13);

    // The long roof: a low trapezoid, its sides a little hollow, its corners turned up.
    const ridgeY = 124;
    const eaveY = 158;
    const roofL = (k) => mix(76, 50, k ** 1.25);
    const roofR = (k) => mix(186, 212, k ** 1.25);
    // The body under it first.
    for (let y = eaveY - 4; y < 190; y += 1) {
      for (let x = 62; x < 200; x += 1) mid.tone(x, y, LIME, 0.52 - (y < eaveY + 6 ? (eaveY + 6 - y) * 0.09 : 0) + (fbm2(rock, x / 5, y / 7, 2) - 0.5) * 0.25, 0.7);
    }
    // Three bays: the middle one open on a warm dark room, the others shuttered in old wood.
    const WOOD = ramp('#3a201c', '#552f24', '#74432e', '#94603f');
    const bay = (x0, x1) => {
      for (let y = 163; y < 187; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const lattice = (x - x0) % 4 === 0 || (y - 163) % 6 === 0;
          mid.tone(x, y, WOOD, (lattice ? 0.6 : 0.3) - (x - x0) / (x1 - x0) * 0.1, 0.5);
        }
      }
      mid.rect(x0 + Math.floor((x1 - x0) / 2), 163, 1, 24, WOOD[0]);
    };
    bay(70, 104);
    bay(158, 192);
    for (let y = 161; y < 187; y += 1) {
      for (let x = 112; x < 150; x += 1) {
        const glow = Math.exp(-(((x - 131) / 13) ** 2 + ((y - 171) / 9) ** 2));
        mid.tone(x, y, ramp('#20100f', '#3a1a16', '#6a2a1c', '#a8482a', '#e08a3c'), 0.1 + glow * 0.85, 0.7);
      }
    }
    // The altar table in the room, a vase of peach on it, nothing written.
    mid.rect(120, 177, 22, 2, rgba('#2c1410'));
    mid.rect(122, 179, 2, 8, rgba('#2c1410'));
    mid.rect(138, 179, 2, 8, rgba('#2c1410'));
    mid.rect(129, 171, 4, 6, rgba('#ffd257'));
    mid.rect(130, 170, 2, 1, rgba('#c98f24'));
    for (const [fx, fy] of [[126, 166], [129, 164], [133, 165], [136, 167], [131, 168], [127, 169], [135, 170]]) mid.put(fx, fy, rgba('#ff9fc2'));
    // Red strips each side of the door, gold-edged, plain.
    for (const sx of [107, 151]) {
      mid.rect(sx, 163, 4, 22, RED[3]);
      mid.rect(sx, 163, 1, 22, RED[4]);
      mid.rect(sx + 3, 163, 1, 22, RED[1]);
      mid.rect(sx, 163, 4, 1, rgba('#ffd257'));
      mid.rect(sx, 184, 4, 1, rgba('#ffd257'));
    }
    // The verandah floor and the steps down to the yard.
    mid.rect(58, 187, 146, 3, rgba('#c67b52'));
    mid.rect(58, 187, 146, 1, rgba('#e29c70'));
    for (let x = 58; x < 204; x += 6) mid.put(x, 188, rgba('#9c5c3e'));
    mid.rect(112, 190, 38, 2, rgba('#b98a68'));
    mid.rect(108, 192, 46, 2, rgba('#a97a5a'));
    // Wooden posts.
    for (const px of [66, 106, 154, 194]) {
      mid.rect(px, eaveY - 2, 4, 30, WOOD[1]);
      mid.rect(px, eaveY - 2, 1, 30, WOOD[3]);
      mid.rect(px + 3, eaveY - 2, 1, 30, WOOD[0]);
      mid.rect(px - 1, 185, 6, 2, rgba('#8e8a80'));
    }
    // New-year things on the verandah: rice cakes in a stack on a low table, and pots of yellow flowers.
    mid.rect(170, 182, 16, 1, WOOD[2]);
    mid.rect(171, 183, 2, 4, WOOD[0]);
    mid.rect(183, 183, 2, 4, WOOD[0]);
    for (const [cx, cy] of [[171, 177], [178, 177], [174, 172]]) {
      mid.rect(cx, cy, 6, 5, rgba('#4f8a3a'));
      mid.rect(cx, cy, 6, 1, rgba('#7cb352'));
      mid.rect(cx + 2, cy, 1, 5, rgba('#d9cfa8'));
      mid.rect(cx, cy + 2, 6, 1, rgba('#d9cfa8'));
    }
    for (const fx of [94, 158]) {
      mid.rect(fx + 1, 195, 6, 5, TILE[3]);
      mid.rect(fx + 1, 195, 2, 5, TILE[5]);
      puffs(mid, clusterBalls(rand, fx + 4, 192, 4, 9, 1.2, 2.2), ramp('#d98a12', '#f0ae1a', '#ffcf2e', '#ffe878'), { spread: 0.9, height: 0.5, lift: 0.1 });
    }

    // Roof, tile by tile.
    for (let y = ridgeY; y <= eaveY; y += 1) {
      const k = (y - ridgeY) / (eaveY - ridgeY);
      for (let x = Math.round(roofL(k)); x <= roofR(k); x += 1) {
        const centre = 131;
        const fan = centre + (x - centre) / mix(0.74, 1, k);
        const column = ((Math.round(fan) % 5) + 5) % 5;
        const barrel = [0.5, 0.82, 0.7, 0.34, 0.16][column];
        const course = (y - ridgeY) % 4 === 3 ? -0.2 : 0;
        const moss = fbm2(rock, x / 9, y / 4, 3);
        const v = 0.26 + barrel * 0.48 - k * 0.1 + course + (moss - 0.5) * 0.36;
        art_tile(mid, x, y, v, moss);
      }
    }
    // Bottom edge of the tiles, a row of little round ends, and the turned-up corners.
    for (let x = 50; x <= 212; x += 1) {
      const flick = Math.max(0, Math.abs(x - 131) - 66) ** 2 / 44;
      const y = Math.round(eaveY - flick);
      mid.rect(x, y, 1, 2, TILE[x % 5 === 0 ? 5 : 1]);
      mid.put(x, y + 2, rgba('#2a1512'));
      if (flick > 0) for (let j = 1; j <= flick + 1; j += 1) mid.put(x, y + 2 + j, 0);
    }
    for (let x = 46; x < 52; x += 1) mid.put(x, Math.round(eaveY - 14 - (51 - x) * 0.5), TILE[5]);
    for (let x = 211; x < 217; x += 1) mid.put(x, Math.round(eaveY - 14 - (x - 211) * 0.5), TILE[2]);
    // The ridge, lime-white on top of the tiles, its two ends curling up like a boat's.
    for (let x = 72; x <= 190; x += 1) {
      const curl = Math.max(0, Math.abs(x - 131) - 48) ** 2 / 22;
      const y = Math.round(ridgeY - 3 - curl);
      mid.rect(x, y, 1, 5 + curl * 0.6, TILE[1]);
      mid.rect(x, y, 1, 2, LIME[x < 131 ? 4 : 3]);
      mid.put(x, y + 2, TILE[4]);
    }
    // A plain gold sun in the middle of the ridge.
    mid.disc(131, 118, 3.4, rgba('#e8a92a'));
    mid.disc(130.5, 117.5, 2.2, rgba('#ffe07a'));
    mid.rect(130, 121, 3, 2, TILE[3]);

    // The bamboo pole set up for the new year in the yard, with room for its streamer.
    const POLE = { x: 238, base: 198, top: 66 };
    for (let y = POLE.top; y < POLE.base; y += 1) {
      const knot = (y - POLE.top) % 13 === 0;
      mid.put(POLE.x, y, rgba(knot ? '#8c8440' : '#d4cd74'));
      mid.put(POLE.x + 1, y, rgba(knot ? '#6c6a30' : '#a4a54c'));
    }
    for (let i = 0; i < 16; i += 1) {
      const a = -Math.PI * rand();
      const len = 4 + rand() * 7;
      mid.line(POLE.x, POLE.top, POLE.x + Math.cos(a) * len, POLE.top + Math.sin(a) * len + len * 0.5, rgba(i % 2 ? '#5f9e4a' : '#87bd58'));
    }

    // The near hill: the whole foreground, rising under the peach tree.
    const front = new Art();
    const nearHill = (x) => 232 + Math.sin((x - 80) / 118) * 8 - clamp((x - 210) / 190) ** 1.6 * 12;
    const tufts = noise2(6208, 64);
    for (let x = 0; x < W; x += 1) {
      const top = Math.round(nearHill(x));
      for (let y = top; y < H; y += 1) {
        const n = fbm2(tufts, x / 8, y / 3.2, 3) - 0.5;
        front.tone(x, y, GRASS, 0.78 - (y - top) / 62 + n * 0.62 + (y === top ? 0.14 : 0) + (x < 200 ? 0.04 : 0), 0.9);
      }
      if (rand() < 0.55) front.put(x, top - 1, GRASS[rand() < 0.5 ? 5 : 3]);
    }
    // A path coming down from the gate.
    const pathX = (y) => 124 + Math.sin((y - 196) / 22) * 16 + (y - 196) * 1.3;
    const DIRT = ramp('#b38a5e', '#c9a374', '#dcbb8c', '#ecd3a8');
    for (const art of [land, front]) {
      for (let y = 195; y < H; y += 1) {
        const half = 3 + (y - 195) * 0.32;
        for (let x = Math.round(pathX(y) - half); x <= pathX(y) + half; x += 1) {
          if (art === front ? art.get(x, y) === 0 : y >= 232 + 8) continue;
          art.tone(x, y, DIRT, 0.66 + (fbm2(tufts, x / 3.4, y / 2, 2) - 0.5) * 0.8 - Math.abs(x - pathX(y)) / half * 0.2, 0.8);
        }
      }
    }
    // Strokes of grass.
    for (let i = 0; i < 700; i += 1) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(nearHill(x) + 3 + rand() * rand() * (H - nearHill(x)));
      if (Math.abs(x - pathX(y)) < 3 + (y - 195) * 0.34) continue;
      const tall = 1 + Math.floor(rand() * 2.4);
      const c = GRASS[rand() < 0.4 ? 0 : rand() < 0.5 ? 5 : 6];
      front.rect(x, y - tall, 1, tall, c);
      if (rand() < 0.3) front.put(x + 1, y - tall - 1, c);
    }

    // The kumquat in its glazed pot, on the near side of the yard.
    const KUM = { x: 76, base: 254 };
    const POT = ramp('#1d3c78', '#2c5aa0', '#4a82c8', '#8bb8e6', '#d4e8f8');
    front.rect(KUM.x - 22, KUM.base - 3, 44, 5, rgba('#9c5c3e'));
    front.rect(KUM.x - 22, KUM.base - 3, 44, 1, rgba('#d08d62'));
    for (let x = KUM.x - 22; x < KUM.x + 22; x += 7) front.rect(x, KUM.base - 2, 1, 4, rgba('#7c4630'));
    for (let y = KUM.base - 25; y < KUM.base - 3; y += 1) {
      const k = (y - (KUM.base - 25)) / 22;
      const half = 12 + Math.sin(k * Math.PI) * 5 - k * 2;
      for (let x = Math.round(KUM.x - half); x <= KUM.x + half; x += 1) {
        const u = (x - KUM.x) / half;
        const flowers = Math.sin(u * 7) * Math.sin(k * 15) > 0.35 ? 0.26 : 0;
        front.tone(x, y, POT, 0.52 - u * 0.42 + flowers - k * 0.14 + (u < -0.42 && u > -0.7 && k < 0.6 ? 0.34 : 0), 0.5);
      }
    }
    front.rect(KUM.x - 14, KUM.base - 27, 28, 3, rgba('#e8c75a'));
    front.rect(KUM.x - 14, KUM.base - 27, 28, 1, rgba('#fff0a6'));
    front.rect(KUM.x - 12, KUM.base - 24, 24, 1, rgba('#14284e'));
    front.rect(KUM.x - 12, KUM.base - 28, 24, 1, rgba('#3a2a22'));
    front.rect(KUM.x - 2, KUM.base - 44, 4, 17, BARK[2]);
    front.rect(KUM.x - 2, KUM.base - 44, 1, 17, BARK[4]);
    const LEAF = ramp('#123826', '#1a4d30', '#256538', '#347e40', '#4d984a', '#74b256');
    const leaves = [];
    for (let i = 0; i < 52; i += 1) {
      const a = rand() * TAU;
      const k = Math.sqrt(rand());
      leaves.push({ x: KUM.x + Math.cos(a) * k * 31, y: KUM.base - 66 + Math.sin(a) * k * 28, r: 4 + rand() * 6, z: rand() * 3 });
    }
    puffs(front, leaves, LEAF, { spread: 0.95, height: 0.55, light: [-0.55, -0.75, 0.4], grain: (x, y) => (fbm2(tufts, x / 1.7, y / 1.7, 2) - 0.5) * 0.7 });
    const glints = [];
    const FRUIT = [rgba('#e0860f'), rgba('#fbb01c'), rgba('#ffd02e'), rgba('#fff4ae')];
    for (let i = 0; i < 150; i += 1) {
      const a = rand() * TAU;
      const k = Math.sqrt(rand()) * 1.02;
      const x = Math.round(KUM.x + Math.cos(a) * k * 34);
      const y = Math.round(KUM.base - 66 + Math.sin(a) * k * 31);
      if (!front.get(x, y)) continue;
      const big = rand() < 0.5;
      front.rect(x - 1, y - 1, big ? 3 : 2, big ? 3 : 2, FRUIT[1]);
      front.put(x + (big ? 1 : 0), y + (big ? 1 : 0), FRUIT[0]);
      if (big) {
        front.put(x, y - 1, FRUIT[2]);
        front.put(x - 1, y, FRUIT[2]);
        front.put(x, y, FRUIT[2]);
      }
      front.put(x - 1, y - 1, FRUIT[3]);
      if (rand() < 0.2) glints.push({ x: x - 1, y: y - 1, period: 3 + rand() * 6, phase: rand() });
    }
    // Red packets hung among the leaves, plain.
    for (const [ex, ey] of [[58, 186], [88, 180], [64, 208], [96, 204], [77, 196], [52, 200]]) {
      front.put(ex + 1, ey - 1, rgba('#ffd257'));
      front.rect(ex, ey, 4, 6, RED[3]);
      front.rect(ex, ey, 1, 6, RED[4]);
      front.rect(ex, ey + 2, 4, 1, rgba('#ffd257'));
    }

    // The peach tree: limbs and the dark blossom behind them, then the bright clusters in three swaying lots.
    const peach = new Art();
    const { limbs, twigs } = growPeach(rand);
    const grain = noise2(6209, 64);
    const flowerGrain = (x, y) => (fbm2(grain, x / 2.1, y / 2.1, 2) - 0.5) * 0.6;
    const chosen = twigs.filter((p) => p.y < 228 && rand() < 0.42);
    for (const p of chosen) {
      if (rand() < 0.42) puffs(peach, clusterBalls(rand, p.x + (rand() - 0.5) * 8, p.y + (rand() - 0.5) * 8, 7, 6, 1.8, 3.6), BLOSSOM_BACK, { spread: 0.9, height: 0.6, light: [-0.55, -0.75, 0.4], grain: flowerGrain });
    }
    paintLimbs(peach, limbs, grain);
    // Roots gripping the hill.
    for (const [dx, len, a] of [[-8, 16, 2.9], [8, 16, 0.28], [-3, 10, 2.5], [5, 11, 0.6]]) {
      for (let k = 0; k < len; k += 1) {
        const r = 2.6 * (1 - k / len) + 0.6;
        paintLimbs(peach, [{ x: 406 + dx + Math.cos(a) * k, y: 240 + Math.sin(a) * k * 0.5, r }], grain);
      }
    }
    const crowns = [new Art(W, 240), new Art(W, 240), new Art(W, 240)];
    chosen.forEach((p, i) => {
      if (i % 2) return;
      const lot = crowns[(i / 2) % 3];
      puffs(lot, clusterBalls(rand, p.x + (rand() - 0.5) * 5, p.y + (rand() - 0.5) * 5, 4 + rand() * 3.4, 5 + Math.floor(rand() * 3), 1.3, 2.7), BLOSSOM, { spread: 0.9, height: 0.62, lift: 0.08, light: [-0.55, -0.75, 0.4], grain: flowerGrain });
    });
    // Single open flowers, a lot of them, so that up close it is flowers and not foam.
    for (let i = 0; i < 1150; i += 1) {
      const p = twigs[Math.floor(rand() * twigs.length)];
      if (p.y > 228) continue;
      const a = rand() * TAU;
      const r = rand() * 7;
      const fx = Math.round(p.x + Math.cos(a) * r);
      const fy = Math.round(p.y + Math.sin(a) * r);
      flower(crowns[i % 3], fx, fy, rand() < 0.42, rand);
    }
    // New leaves and tight red buds at the ends.
    for (let i = 0; i < 170; i += 1) {
      const p = twigs[Math.floor(rand() * twigs.length)];
      const fx = Math.round(p.x + (rand() - 0.5) * 12);
      const fy = Math.round(p.y + (rand() - 0.5) * 12);
      if (i % 2) {
        crowns[i % 3].put(fx, fy, rgba('#8fce5e'));
        crowns[i % 3].put(fx + 1, fy - 1, rgba('#6cb04a'));
      } else crowns[i % 3].put(fx, fy, rgba('#c81e5a'));
    }

    // Fallen petals under the tree, thickest near the trunk.
    for (let i = 0; i < 640; i += 1) {
      const a = rand() * TAU;
      const r = rand() * rand();
      const x = Math.round(392 + Math.cos(a) * r * 118);
      const y = Math.round(246 + Math.sin(a) * r * 24);
      if (front.get(x, y)) front.put(x, y, rgba(rand() < 0.5 ? '#ffc4d8' : rand() < 0.5 ? '#ffa8c6' : '#ffe1eb'));
    }

    // Flowers in the grass, nodding on their own. Their stems are painted; heads go on at draw time.
    const daisies = [];
    for (let i = 0; i < 70; i += 1) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(nearHill(x) + 4 + rand() * (H - nearHill(x) - 6));
      if (Math.abs(x - pathX(y)) < 6 + (y - 195) * 0.34) continue;
      front.rect(x, y - 2, 1, 3, GRASS[1]);
      daisies.push({ x, y: y - 3, hex: i % 3 === 0 ? '#ffe14a' : i % 3 === 1 ? '#ffffff' : '#ff8fb8', period: 2.6 + rand() * 3, phase: rand() });
    }

    // A near twig of blossom from the top left, close to us.
    const twig = new Art(150, 64);
    const twigLimb = [];
    const twigGrow = (sx, sy, a0, len, r, depth) => {
      let [x, y, a] = [sx, sy, a0];
      for (let i = 0; i < len; i += 1) {
        a += (rand() - 0.5) * 0.3;
        x += Math.cos(a);
        y += Math.sin(a);
        twigLimb.push({ x, y, r: r * (1 - (0.4 * i) / len) });
      }
      if (depth > 0) {
        twigGrow(x, y, a - 0.5, len * 0.62, r * 0.66, depth - 1);
        twigGrow(x, y, a + 0.55, len * 0.7, r * 0.66, depth - 1);
      }
    };
    twigGrow(-4, 6, 0.26, 44, 2.2, 3);
    paintLimbs(twig, twigLimb, grain);
    for (let i = 0; i < twigLimb.length; i += 1) {
      const p = twigLimb[i];
      if (p.x < 20 || i % 5) continue;
      puffs(twig, clusterBalls(rand, p.x, p.y + 1, 4, 4, 1.4, 2.6), BLOSSOM, { spread: 0.9, height: 0.6, lift: 0.1, grain: flowerGrain });
    }
    for (let i = 0; i < 110; i += 1) {
      const p = twigLimb[Math.floor(rand() * twigLimb.length)];
      if (p.x < 14) continue;
      flower(twig, Math.round(p.x + (rand() - 0.5) * 10), Math.round(p.y + (rand() - 0.5) * 10), rand() < 0.6, rand);
    }

    // Cloud shadows crossing the hill, in a pattern and very slight.
    const shade = new Art(960, 90);
    const shadeNoise = noise2(6210, 64);
    const SHADE = rgba('#1f5a3a') & 0xffffff;
    for (let y = 0; y < 90; y += 1) {
      for (let x = 0; x < 960; x += 1) {
        const k = (fbm2(shadeNoise, x / 30, y / 12 + 3, 3) - 0.52) * 7;
        if (k <= 0) continue;
        const level = Math.floor(Math.min(1, k) * 3 + bayer(x, y) * 0.9) / 3;
        if (level > 0) shade.px[y * 960 + x] = ((Math.round(level * 42) << 24) | SHADE) >>> 0;
      }
    }

    const coat = GOAT_COLOURS;
    const goat = (rows) => sprite(rows, coat);
    const frames = {
      upR: goat(GOAT_UP),
      upL: goat(mirror(GOAT_UP)),
      grazeR: goat(GOAT_GRAZE),
      grazeL: goat(mirror(GOAT_GRAZE)),
      chewR: goat(GOAT_CHEW),
      chewL: goat(mirror(GOAT_CHEW)),
      bigUpR: goat(BIG_UP),
      bigUpL: goat(mirror(BIG_UP)),
      bigGrazeL: goat(mirror(BIG_GRAZE)),
      bigChewL: goat(mirror(BIG_CHEW)),
      bigLeapR: goat(BIG_LEAP),
      bigLeapL: goat(mirror(BIG_LEAP)),
      kidR: goat(KID_UP),
      kidL: goat(mirror(KID_UP)),
      kidLeapR: goat(KID_LEAP),
      kidLeapL: goat(mirror(KID_LEAP)),
    };

    const swallow = [
      sprite(['k       k', ' kk   kk ', '   kwk   ', '    k    ', '   k k   '], { k: '#22305e', w: '#f5f2ea' }),
      sprite(['         ', '         ', 'kkkkwkkkk', '    k    ', '   k k   '], { k: '#22305e', w: '#f5f2ea' }),
    ];

    const petals = [];
    for (let i = 0; i < 120; i += 1) {
      const z = rand();
      petals.push({ x: rand() * (W + 40), y: rand() * H, z, v: 6 + z * 20, drift: 7 + z * 20, sway: 3 + rand() * 11, period: 3 + rand() * 5, phase: rand(), hex: rand() < 0.45 ? '#ffc4d8' : rand() < 0.5 ? '#ff9fbf' : '#ffe6ee' });
    }

    const lines = [
      stringLine(246, 112, 376, 104, 12, 44, 'lanternS', rand),
      stringLine(16, 26, 342, 42, 26, 52, 'lanternB', rand),
      stringLine(342, 42, 476, 58, 14, 48, 'lanternB', rand),
    ];
    // Lanterns that hang straight from the boughs of the peach, and under the eaves.
    const hanging = [
      { x: 436, y: 92, size: 'lanternB', period: 4.1, phase: 0.1, drop: 9 },
      { x: 352, y: 118, size: 'lanternS', period: 3.3, phase: 0.6, drop: 7 },
      { x: 456, y: 128, size: 'lanternS', period: 3.7, phase: 0.35, drop: 10 },
    ];
    const eaves = [68, 108, 156, 196].map((x, i) => ({ x, y: 158, size: 'lanternS', period: 3.4 + i * 0.3, phase: i * 0.27, drop: 2 }));

    const goats = {
      back: [
        { x: 268, y: midHill(268), r: true, period: 6.3, phase: 0.1 },
        { x: 300, y: midHill(300) + 6, r: false, period: 7.9, phase: 0.5 },
      ],
      near: [
        { x: 288, y: nearHill(288) + 16, r: true, period: 5.7, phase: 0.2 },
        { x: 438, y: nearHill(438) + 26, r: false, period: 8.3, phase: 0.45 },
        { x: 142, y: nearHill(142) + 22, r: false, period: 6.9, phase: 0.7 },
      ],
      nearHill,
    };

    // The anchors for the top line: a tall thin bamboo on the left.
    for (let y = 18; y < 240; y += 1) {
      const knot = (y - 18) % 17 === 0;
      front.put(14, y, rgba(knot ? '#6f6a32' : '#c7bf68'));
      front.put(15, y, rgba(knot ? '#55522a' : '#99984a'));
    }

    return {
      sky: sky.canvas(),
      cloudsFar: cloudsFar.canvas(),
      cloudsNear: cloudsNear.canvas(),
      land: land.canvas(),
      shade: shade.canvas(),
      mid: mid.canvas(),
      front: front.canvas(),
      peach: peach.canvas(),
      crowns: crowns.map((c) => c.canvas()),
      twig: twig.canvas(),
      lanternB: lanternFrames(6, 7, 6),
      lanternS: lanternFrames(4, 5, 4),
      banners: bannerFrames(),
      frames,
      swallow,
      petals,
      lines,
      hanging,
      eaves,
      goats,
      daisies,
      glints,
      pole: POLE,
    };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.cloudsFar, along(t, 0.7, 960), 58);
    slide(ctx, s.cloudsNear, along(t, 1.5, 960), 4);

    // Swallows, the birds of spring, in a long loop across the sky.
    const flap = Math.floor(t * 7);
    for (let i = 0; i < 4; i += 1) {
      const k = (t / 37 + i * 0.043) % 1;
      const x = Math.round(W + 30 - k * (W + 60));
      const y = Math.round(62 + Math.sin(k * 9 + i) * 14 + i * 7);
      ctx.drawImage(s.swallow[(flap + i) % 4 === 0 ? 0 : 1], x, y);
    }
    const loop = (t / 53) % 1;
    ctx.drawImage(s.swallow[flap % 3 === 0 ? 0 : 1], Math.round(loop * (W + 60) - 30), Math.round(34 + Math.sin(loop * 14) * 18));

    ctx.drawImage(s.land, 0, 0);
    slide(ctx, s.shade, along(t, 2.4, 960), 180);

    ctx.drawImage(s.mid, 0, 0);
    // The streamer at the top of the new-year pole.
    ctx.fillStyle = '#e0302e';
    for (let i = 0; i < 22; i += 1) {
      const y = s.pole.top + 4 + Math.round(Math.sin(t * 2.4 - i * 0.5) * (i / 22) * 2.4 + i * 0.16);
      ctx.fillRect(s.pole.x + 2 + i, y, 1, 4 - Math.floor(i / 8));
    }
    ctx.fillStyle = '#ffd257';
    for (let i = 0; i < 3; i += 1) ctx.fillRect(s.pole.x - 2 - i * 2 + Math.round(wave(t, 3 + i, i * 0.3)), s.pole.top + 14 + i * 6, 2, 3);

    // The two far goats, on the shoulder of the hill.
    for (const g of s.goats.back) {
      const eat = wave(t, g.period, g.phase) > -0.2;
      const f = s.frames;
      const pic = eat ? (Math.floor(t * 3) % 2 ? f.grazeR : f.chewR) : f.upR;
      ctx.fillStyle = 'rgba(40,90,40,0.28)';
      ctx.fillRect(Math.round(g.x) + 2, Math.round(g.y) - 1, 13, 1);
      ctx.drawImage(pic, Math.round(g.x), Math.round(g.y) - pic.height);
    }
    for (const e of s.eaves) {
      const frame = clamp(Math.round(wave(t, e.period, e.phase) * 1.5) + 2, 0, 4);
      ctx.fillStyle = '#6d2a2a';
      ctx.fillRect(e.x, e.y, 1, e.drop);
      ctx.drawImage(s.lanternS.frames[frame], Math.round(e.x - s.lanternS.cx), e.y + e.drop);
    }

    drawLine(ctx, s.lines[0], t, s);

    ctx.drawImage(s.front, 0, 0);
    ctx.fillStyle = '#fffbe0';
    for (const g of s.glints) if (wave(t, g.period, g.phase) > 0.8) ctx.fillRect(g.x, g.y, 1, 1);
    for (const d of s.daisies) {
      const nod = wave(t, d.period, d.phase) > 0 ? 1 : 0;
      ctx.fillStyle = d.hex;
      ctx.fillRect(d.x - 1 + nod, d.y, 2, 1);
      ctx.fillRect(d.x + nod - (nod ? 1 : 0), d.y - 1, 1, 1);
    }

    ctx.drawImage(s.peach, 0, 0);
    ctx.drawImage(s.crowns[0], Math.round(wave(t, 5.3) * 1.1), Math.round(wave(t, 7.1, 0.2) * 0.8));
    ctx.drawImage(s.crowns[1], Math.round(wave(t, 4.1, 0.4) * 1.3), 0);
    ctx.drawImage(s.crowns[2], Math.round(wave(t, 6.7, 0.7) * 1.1), Math.round(wave(t, 3.9) * 0.7));
    for (const h of s.hanging) {
      const pic = s[h.size];
      const frame = clamp(Math.round(wave(t, h.period, h.phase) * 1.6) + 2, 0, 4);
      ctx.fillStyle = '#6d2a2a';
      ctx.fillRect(h.x, h.y, 1, h.drop);
      ctx.drawImage(pic.frames[frame], Math.round(h.x - pic.cx), h.y + h.drop);
    }

    // The goats on the near hill.
    for (const g of s.goats.near) {
      const eat = wave(t, g.period, g.phase) > -0.35;
      const f = s.frames;
      const pic = eat ? (Math.floor(t * 3 + g.phase * 5) % 2 ? f.bigGrazeL : f.bigChewL) : f.bigUpL;
      ctx.fillStyle = 'rgba(30,80,30,0.3)';
      ctx.fillRect(g.x + 2, Math.round(g.y), 20, 2);
      ctx.drawImage(pic, g.x, Math.round(g.y) + 1 - pic.height);
    }
    // One who cannot keep still: up and down the hill in hops, a kid at its heels.
    const walk = (t / 34) % 1;
    const tri = walk < 0.5 ? walk * 2 : 2 - walk * 2;
    const going = walk < 0.5;
    const gx = 332 + tri * 84;
    const ground = s.goats.nearHill(gx) + 22;
    const air = Math.abs(Math.sin(t * Math.PI * 1.35));
    const jump = Math.round(air * 10);
    const f = s.frames;
    ctx.fillStyle = 'rgba(30,80,30,0.3)';
    ctx.fillRect(Math.round(gx) + 3, Math.round(ground), 18, 2);
    const leapPic = jump > 2 ? (going ? f.bigLeapR : f.bigLeapL) : going ? f.bigUpR : f.bigUpL;
    ctx.drawImage(leapPic, Math.round(gx), Math.round(ground) - leapPic.height + 1 - jump);
    const kx = gx + (going ? -24 : 28);
    const kidGround = s.goats.nearHill(kx) + 25;
    const kidJump = Math.round(Math.abs(Math.sin(t * Math.PI * 1.35 + 0.9)) * 6);
    const kid = kidJump > 1 ? (going ? f.kidLeapR : f.kidLeapL) : going ? f.kidR : f.kidL;
    ctx.fillStyle = 'rgba(30,80,30,0.3)';
    ctx.fillRect(Math.round(kx) + 1, Math.round(kidGround), 11, 1);
    ctx.drawImage(kid, Math.round(kx), Math.round(kidGround) - kid.height + 1 - kidJump);

    drawLine(ctx, s.lines[1], t, s);
    drawLine(ctx, s.lines[2], t, s);

    // Petals on the wind, all the way across.
    const span = W + 40;
    const gust = t * 0.2 + Math.sin(t / 9) * 2;
    for (const p of s.petals) {
      const y = ((p.y + t * p.v + Math.sin(t / 3 + p.phase * 9) * 2) % (H + 8)) - 4;
      const x = (((p.x - t * p.drift - gust * p.drift + Math.sin((t / p.period + p.phase) * TAU) * p.sway) % span) + span) % span - 20;
      const flip = wave(t, p.period, p.phase) > 0;
      const big = p.z > 0.84 ? 2 : 1;
      ctx.fillStyle = p.hex;
      ctx.fillRect(Math.round(x), Math.round(y), (flip ? 2 : 1) * big, (flip ? 1 : 2) * big);
    }
    ctx.drawImage(s.twig, -2 + Math.round(wave(t, 7.7) * 1.3), -2 + Math.round(wave(t, 5.1, 0.3)));
  },
};

/** One roof tile's worth of colour, with moss in the old damp places. */
function art_tile(art, x, y, v, moss) {
  if (moss > 0.71 && (x + y) % 2 === 0) art.put(x, y, rgba(moss > 0.76 ? '#5d7a3e' : '#7c7a44'));
  else art.tone(x, y, TILE, v, 0.6);
}

export default tetSpring;
