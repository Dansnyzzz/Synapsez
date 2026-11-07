import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, noise2, fbm2, puffs, cumulus, sprite, slide } from './art.js';

/*
 * The last day of school, or the first of summer: noon nearly, the sun high and a little
 * to the left, so tops and left sides burn and the yard under the tree lies in deep shade
 * with coins of light on it. Everything red in the picture comes from the one tree.
 */

const SKY = ramp('#1763c4', '#1a6ccd', '#1f76d6', '#2a82de', '#3a90e4', '#4e9fe9', '#68aeed', '#85bef0', '#a5cff3', '#c6e0f6');
const CROWN_DEEP = ramp('#5c1014', '#7a1618', '#94201a', '#ad2a1c', '#c2341e');
const CROWN = ramp('#8c1816', '#aa2016', '#c42a16', '#da3816', '#ec4e18', '#f76c22', '#ff9c3e');
const LEAF = ramp('#2d6b2c', '#3e8732', '#5aa23a', '#83bd47');
const BARK = ramp('#2a1d1c', '#3f2c28', '#574036', '#735746', '#937459', '#b2967a');
const WALL = ramp('#b9862e', '#d09e38', '#e3b444', '#f0c655', '#f7d76f', '#fce692');
const SHUTTER = ramp('#123f30', '#1a5a40', '#26744e', '#3b9060');
const TILE = ramp('#6a2a1c', '#8a3a24', '#a54a2c', '#be5e36', '#d47a48');
const YARD_SUN = ramp('#c9b48c', '#d8c49c', '#e4d2ac', '#efe0bf', '#f7ecd2');
const YARD_SHADE = ramp('#7a625a', '#8b7264', '#9b8270', '#aa917c', '#b8a08a');

/** A shuttered window on the yellow wall, its slats, a dark room behind the open half. */
function shuttered(art, x, y, w, h, open, rand) {
  const cast = rgba('#a9782a');
  art.rect(x - 1, y - 2, w + 2, 2, rgba('#fbeec2'));
  art.rect(x - 1, y, w + 2, 1, cast);
  art.rect(x, y, w, h, rgba('#22303a'));
  if (open) {
    art.rect(x + 1, y + 1, w - 2, h - 2, rgba('#31434c'));
    art.rect(x + Math.floor(w / 2), y, 1, h, rgba('#1a2228'));
    art.rect(x, y + Math.floor(h / 2), w, 1, rgba('#1a2228'));
    // Shutters thrown back against the wall each side.
    for (const sx of [x - 4, x + w + 1]) {
      for (let j = 0; j < h; j += 1) {
        for (let i = 0; i < 3; i += 1) art.put(sx + i, y + j, SHUTTER[j % 2 ? 1 : i === 0 ? 3 : 2]);
      }
    }
  } else {
    const half = Math.floor(w / 2);
    for (let j = 0; j < h; j += 1) {
      for (let i = 0; i < w; i += 1) {
        const leaf = i === half ? 0 : j % 2 ? 1 : i < half ? 3 : 2;
        art.put(x + i, y + j, SHUTTER[leaf]);
      }
    }
    if (rand() < 0.4) art.rect(x + half - 3, y + 1, 3, h - 2, rgba('#1a5a40'));
  }
  art.rect(x - 1, y + h, w + 2, 1, rgba('#fbeec2'));
  art.rect(x - 1, y + h + 1, w + 2, 1, cast);
}

/** The school: two floors along the back of the yard, a walkway on each, tiles above. */
function school(art, rand, grain) {
  const x0 = -6;
  const x1 = 492;
  const roofTop = 86;
  const eave = 108;
  const floor = 150;
  const ground = 198;
  // Tiled roof, its ridge running the whole length.
  for (let y = roofTop; y < eave; y += 1) {
    const k = (y - roofTop) / (eave - roofTop);
    for (let x = x0; x < x1 + k * 8; x += 1) {
      const col = ((x + Math.round(k * 3)) % 5 + 5) % 5;
      const barrel = [0.36, 0.74, 0.62, 0.3, 0.1][col];
      const lap = (y - roofTop) % 4 === 3 ? -0.18 : 0;
      art.tone(x, y, TILE, 0.62 - k * 0.22 + (barrel - 0.4) * 0.5 + lap + (fbm2(grain, x / 11, y / 4, 2) - 0.5) * 0.4, 0.55);
    }
  }
  art.rect(x0, roofTop - 2, x1 - x0 + 2, 2, TILE[4]);
  art.rect(x0, roofTop - 3, x1 - x0 + 2, 1, rgba('#f0a070'));
  for (let x = x0; x < x1 + 8; x += 5) art.rect(x, eave - 1, 2, 2, TILE[x % 2 ? 4 : 3]);
  art.rect(x0, eave + 1, x1 - x0 + 8, 2, rgba('#5e3a1e'));

  // The walls: upper and lower floor, a deep shade under each overhang.
  for (let y = eave + 3; y < ground; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const fromEave = y < floor ? y - eave - 3 : y - floor - 6;
      const shade = clamp(1 - fromEave / 10) * 0.6;
      const noise = (fbm2(grain, x / 7, y / 7, 3) - 0.5) * 0.3;
      const stain = fbm2(grain, x / 4 + 30, y / 18, 2) > 0.66 && y > floor + 30 ? -0.12 : 0;
      art.tone(x, y, WALL, 0.72 - shade + noise + stain - (x / 900), 0.65);
    }
  }
  // The walkway along the upper floor: a slab, a rail with green balusters.
  art.rect(x0, floor, x1 - x0, 3, rgba('#f6e8bd'));
  art.rect(x0, floor + 3, x1 - x0, 3, rgba('#9c7a3a'));
  art.rect(x0, floor - 14, x1 - x0, 2, rgba('#2f8058'));
  art.rect(x0, floor - 14, x1 - x0, 1, rgba('#4fa878'));
  for (let x = x0; x < x1; x += 4) {
    art.rect(x, floor - 12, 1, 12, rgba('#3b9060'));
    art.rect(x + 1, floor - 12, 1, 12, rgba('#1a5a40'));
  }
  // Columns, each throwing a little shadow to its right.
  for (let x = x0 + 18; x < x1; x += 64) {
    for (const [top, bottom] of [[eave + 3, floor], [floor + 6, ground]]) {
      art.rect(x, top, 7, bottom - top, rgba('#fbeab0'));
      art.rect(x, top, 2, bottom - top, rgba('#fff6d4'));
      art.rect(x + 5, top, 2, bottom - top, rgba('#d9b35a'));
      art.rect(x + 7, top, 3, bottom - top, rgba('#c29a3e'));
    }
  }
  // Windows and classroom doors between the columns, some shutters thrown open for the heat.
  for (let x = x0 + 34; x < x1 - 20; x += 64) {
    shuttered(art, x, eave + 13, 14, 16, rand() < 0.5, rand);
    shuttered(art, x + 26, eave + 13, 14, 16, rand() < 0.5, rand);
    shuttered(art, x, floor + 18, 14, 18, rand() < 0.4, rand);
    // A classroom door, open: dark inside, the leaf folded back and green.
    art.rect(x + 25, floor + 16, 16, ground - floor - 16, rgba('#2a343c'));
    art.rect(x + 26, floor + 18, 3, ground - floor - 18, rgba('#20282e'));
    for (let j = floor + 16; j < ground; j += 1) art.rect(x + 41, j, 4, 1, SHUTTER[(j % 3 ? 2 : 1)]);
    art.rect(x + 25, floor + 15, 21, 1, rgba('#fbeec2'));
    // The back wall's blackboard edge showing through the door.
    art.rect(x + 30, floor + 24, 9, 8, rgba('#1d4034'));
    art.rect(x + 30, floor + 24, 9, 1, rgba('#8a6a3c'));
  }
  // The drum on its stand in the walkway, the one that says when school is over.
  const dx = x0 + 150;
  const dy = ground - 26;
  art.rect(dx + 2, dy + 16, 2, 10, rgba('#4a2a1a'));
  art.rect(dx + 18, dy + 16, 2, 10, rgba('#4a2a1a'));
  art.rect(dx + 1, dy + 14, 20, 2, rgba('#5e3a1e'));
  art.ellipse(dx + 11, dy + 7, 11, 8, rgba('#9c2a22'));
  art.ellipse(dx + 9, dy + 6, 7, 5, rgba('#c23c2a'));
  art.ellipse(dx + 6, dy + 7, 3, 7, rgba('#e8d4a8'));
  art.ellipse(dx + 6, dy + 7, 2, 5, rgba('#f7ecd2'));
  for (const j of [0, 14]) art.rect(dx + 4, dy + j, 14, 1, rgba('#ffd257'));
  // Plants along the foot of the wall.
  const POT = rgba('#b0522c');
  for (let x = x0 + 26; x < x1 - 8; x += 32) {
    if (x > dx - 10 && x < dx + 24) continue;
    art.rect(x, ground - 7, 7, 7, POT);
    art.rect(x, ground - 7, 2, 7, rgba('#d67a48'));
    art.rect(x - 1, ground - 8, 9, 1, rgba('#d67a48'));
    puffs(art, [
      { x: x + 3, y: ground - 13, r: 4 + rand() * 1.4 },
      { x: x + 1, y: ground - 11, r: 3 },
      { x: x + 6, y: ground - 11, r: 3 },
    ], LEAF, { spread: 0.9, height: 0.6, lift: 0.1, grain: (a, b) => (fbm2(grain, a / 1.8, b / 1.8, 2) - 0.5) * 0.7 });
  }
  // The step down into the yard.
  art.rect(x0, ground, x1 - x0, 2, rgba('#f2e2b6'));
  art.rect(x0, ground + 2, x1 - x0, 2, rgba('#a68a56'));
}

/** Limbs of the big tree, flat and wide like an umbrella; twigs are where the flowers go. */
function growFlame(rand) {
  const limbs = [];
  const twigs = [];
  const grow = (sx, sy, a0, length, r, depth) => {
    let [x, y, a] = [sx, sy, a0];
    const steps = Math.ceil(length);
    for (let i = 0; i < steps; i += 1) {
      a += (rand() - 0.5) * 0.22;
      // Whatever the limb does, it wants to go level: that's the shape of this tree.
      a += ((Math.cos(a) > 0 ? -0.1 : -Math.PI + 0.1) - a) * 0.03;
      x += Math.cos(a);
      y += Math.sin(a);
      limbs.push({ x, y, r: r * (1 - 0.3 * (i / steps)) });
      if (depth <= 2 && r < 4.2) twigs.push({ x, y });
    }
    if (depth > 0) {
      for (let k = 0; k < 2 + (rand() < 0.5 ? 1 : 0); k += 1) {
        grow(x, y, a + (k === 0 ? -1 : k === 1 ? 1 : 0.1) * (0.32 + rand() * 0.36), length * (0.66 + rand() * 0.2), r * 0.66, depth - 1);
      }
    }
  };
  // The bole, with a flare at the root, by hand.
  const bole = [[398, 240, 13], [396, 212, 10.5], [392, 180, 10], [390, 150, 10], [388, 124, 9.5], [388, 108, 9]];
  for (let i = 0; i + 1 < bole.length; i += 1) {
    const [ax, ay, ar] = bole[i];
    const [bx, by, br] = bole[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let k = 0; k < n; k += 1) limbs.push({ x: mix(ax, bx, k / n), y: mix(ay, by, k / n), r: mix(ar, br, k / n) });
  }
  // Great limbs that go out across the whole top of the picture.
  grow(386, 110, -2.86, 96, 7, 4);
  grow(386, 118, -3.02, 66, 5.4, 3);
  grow(388, 104, -2.3, 44, 6, 4);
  grow(388, 100, -1.75, 24, 5, 3);
  grow(390, 100, -1.15, 24, 5, 3);
  grow(392, 104, -0.62, 28, 6, 3);
  grow(394, 116, -0.2, 26, 5, 3);
  grow(330, 86, -1.9, 20, 3, 3);
  grow(298, 88, -1.1, 22, 3, 3);
  grow(352, 94, -0.9, 18, 3, 2);
  return { limbs, twigs };
}

function paintLimbs(art, limbs, grain) {
  for (const l of limbs) {
    const r = Math.max(0.7, l.r);
    const top = Math.ceil(r);
    for (let dy = -top; dy <= top; dy += 1) {
      for (let dx = -top; dx <= top; dx += 1) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(l.x) + dx;
        const py = Math.round(l.y) + dy;
        art.tone(px, py, BARK, 0.48 - (dx / r) * 0.34 - (dy / r) * 0.2 + (fbm2(grain, px / 2.2, py / 5, 2) - 0.5) * 0.6, 0.6);
      }
    }
  }
}

const clusterOf = (rand, cx, cy, spread, count, rMin, rMax) => {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    list.push({ x: cx + Math.cos(a) * k * spread, y: cy + Math.sin(a) * k * spread * 0.62, r: rMin + rand() * (rMax - rMin), z: rand() * 2 });
  }
  return list;
};

/** A bicycle, the old sort, leaning: two wheels with spokes, a frame, a basket, a bell. */
function bicycle(art, x, y) {
  const frame = rgba('#1f6a7c');
  const lit = rgba('#46a4b4');
  const tyre = rgba('#1d1a1e');
  const rim = rgba('#c9c5bd');
  const wheel = (cx, cy, r) => {
    for (let a = 0; a < TAU; a += 0.05) {
      art.put(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), tyre);
      art.put(Math.round(cx + Math.cos(a) * (r - 1)), Math.round(cy + Math.sin(a) * (r - 1)), rim);
    }
    for (let a = 0; a < Math.PI; a += Math.PI / 5) {
      art.line(cx - Math.cos(a) * (r - 1), cy - Math.sin(a) * (r - 1), cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1), rgba('#8f8b86'));
    }
    art.disc(cx, cy, 1.2, rgba('#55504e'));
  };
  // The frame leans to the left, against the bole: its top is further left than its wheels.
  const front = [x + 4, y - 9];
  const rear = [x + 37, y - 9];
  wheel(front[0], front[1], 9);
  wheel(rear[0], rear[1], 9);
  const seat = [x + 26, y - 26];
  const crank = [x + 22, y - 9];
  const head = [x + 8, y - 26];
  for (const [a, b, c] of [[crank, seat, frame], [crank, head, frame], [seat, rear, frame], [crank, rear, frame], [seat, head, lit]]) {
    art.line(a[0], a[1], b[0], b[1], c);
    art.line(a[0], a[1] - 1, b[0], b[1] - 1, c);
  }
  art.line(head[0], head[1], front[0], front[1], lit);
  art.line(head[0], head[1], head[0] - 2, head[1] - 6, frame);
  art.rect(head[0] - 7, head[1] - 7, 8, 1, rgba('#d6d2c8'));
  art.rect(head[0] - 8, head[1] - 7, 2, 2, rgba('#26211f'));
  art.rect(seat[0] - 4, seat[1] - 2, 8, 2, rgba('#3a2a22'));
  art.rect(seat[0] - 4, seat[1] - 2, 3, 1, rgba('#5e4638'));
  art.disc(crank[0], crank[1], 2.4, rgba('#3a3634'));
  art.line(crank[0], crank[1], crank[0] + 3, crank[1] + 4, rgba('#26211f'));
  art.rect(crank[0] + 2, crank[1] + 4, 4, 1, rgba('#26211f'));
  // A wire basket in front, a schoolbag's strap hanging out of it.
  const bx = head[0] - 10;
  const by = head[1] - 5;
  art.rect(bx, by, 9, 7, rgba('#7a6a50'));
  for (let i = 0; i < 9; i += 2) art.rect(bx + i, by, 1, 7, rgba('#b8a884'));
  art.rect(bx, by, 9, 1, rgba('#d6c8a0'));
  art.rect(bx + 2, by - 2, 5, 2, rgba('#c23c2a'));
  art.rect(bx + 3, by + 7, 1, 4, rgba('#c23c2a'));
  // A rack over the back wheel.
  art.rect(seat[0] + 5, seat[1] + 5, 11, 1, rgba('#c9c5bd'));
}

/** An empty wooden bench, slats and iron ends. */
function bench(art, x, y) {
  const SLAT = ['#7a4a2a', '#9a6438', '#bc8650'].map(rgba);
  const IRON = rgba('#26211f');
  const w = 54;
  for (const [ly, c] of [[y - 19, 1], [y - 15, 2], [y - 11, 1]]) {
    art.rect(x, ly, w, 3, SLAT[c]);
    art.rect(x, ly + 2, w, 1, SLAT[0]);
  }
  art.rect(x - 2, y - 8, w + 4, 3, SLAT[2]);
  art.rect(x - 2, y - 6, w + 4, 2, SLAT[0]);
  for (const lx of [x + 4, x + w - 7]) {
    art.rect(lx, y - 20, 3, 20, IRON);
    art.rect(lx - 2, y - 2, 7, 2, IRON);
    art.put(lx, y - 20, rgba('#4a4340'));
  }
  // Its shadow on the shaded ground.
  for (let i = -2; i < w + 8; i += 1) art.put(x + i, y, rgba('#3a383e'));
}

/** Coins of sun on the shaded ground, in a few sizes, flattened by the angle. */
function coinSprites() {
  const coins = [];
  const LIT = rgba('#fff0c0') & 0xffffff;
  for (const [rx, ry] of [[3, 1.4], [4, 1.8], [6, 2.4], [8, 3.2], [11, 4.2], [14, 5.4], [18, 6.6]]) {
    const w = Math.ceil(rx) * 2 + 1;
    const h = Math.ceil(ry) * 2 + 1;
    const art = new Art(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const d = Math.hypot((x - (w - 1) / 2) / rx, (y - (h - 1) / 2) / ry);
        if (d >= 1) continue;
        const level = Math.floor((1 - d) ** 0.5 * 3.6 + bayer(x, y) * 0.9) / 4;
        if (level > 0) art.px[y * w + x] = ((Math.round(Math.min(1, level) * 225) << 24) | LIT) >>> 0;
      }
    }
    coins.push(art.canvas());
  }
  return coins;
}

/** Flame trees on the first day of summer: an empty schoolyard, a bench, a bicycle, the whole sky blue. */
const phoenixSummer = {
  build() {
    const rand = seeded(7301);
    const grain = noise2(7302, 64);

    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const sun = 0.42 * Math.exp(-((Math.hypot((x - 54) / 1.2, y - 14) / 74) ** 2));
      return clamp(0.02 + (y / 128) ** 1.5 * 0.62 + sun);
    }, 0.85);
    // The sun itself, too bright to have an edge.
    for (let y = 0; y < 60; y += 1) {
      for (let x = 20; x < 96; x += 1) {
        const d = Math.hypot(x - 54, y - 14);
        const k = Math.floor(clamp(1 - d / 26) ** 1.1 * 4 + bayer(x, y) * 0.9);
        if (k > 0) sky.put(x, y, rgba(['#c6e0f6', '#e0eefa', '#f4f9fd', '#ffffff', '#ffffff'][Math.min(4, k)]));
      }
    }

    // Hot white clouds, tall ones low down and small ones up high.
    const CLOUD = ramp('#6f9fdc', '#92b8e8', '#b6d0f0', '#d6e5f7', '#eef5fb', '#ffffff');
    const high = new Art(960, 90);
    for (const [cx, base, w, h] of [[40, 40, 50, 12], [210, 32, 70, 15], [352, 44, 46, 11], [520, 30, 80, 16], [690, 42, 56, 12], [850, 34, 70, 14]]) {
      puffs(high, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.5, height: 0.7, flat: 3, lift: 0.14, light: [-0.45, -0.85, 0.3] });
    }
    const tower = new Art(960, 130);
    for (const [cx, base, w, h] of [[110, 126, 170, 96], [410, 128, 150, 70], [640, 126, 190, 104], [870, 128, 130, 76]]) {
      puffs(tower, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.5, height: 0.42, flat: 12, lift: 0.1, light: [-0.45, -0.85, 0.3] });
    }

    // Behind the school: a line of treetops and another flame tree far off to the left.
    const back = new Art();
    const TOPS = ramp('#1f5a34', '#2a7038', '#3b863e', '#58a044', '#7fb84e');
    for (let i = 0; i < 44; i += 1) {
      const x = i * 11 + rand() * 8;
      puffs(back, clusterOf(rand, x, 84 + rand() * 12, 10, 10, 3.6, 7), TOPS, { spread: 0.9, height: 0.65, light: [-0.45, -0.85, 0.3], grain: (a, b) => (fbm2(grain, a / 2.2, b / 2.2, 2) - 0.5) * 0.6 });
    }
    for (const [fx, fy, sp] of [[44, 74, 26], [78, 82, 18]]) {
      for (let i = 0; i < 12; i += 1) {
        const a = rand() * TAU;
        const k = Math.sqrt(rand());
        puffs(back, clusterOf(rand, fx + Math.cos(a) * k * sp, fy + Math.sin(a) * k * sp * 0.5, 6, 6, 2.2, 3.8), CROWN, { spread: 0.85, height: 0.68, lift: 0.08, light: [-0.45, -0.85, 0.3], grain: (p, q) => (fbm2(grain, p / 1.8, q / 1.8, 2) - 0.5) * 0.5 });
      }
    }

    // The school and the yard.
    const land = new Art();
    land.px.set(back.px);
    school(land, rand, grain);

    // Yard, first all in full sun: bare swept concrete and dust.
    const yardY = 202;
    for (let y = yardY; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const crack = fbm2(grain, x / 3, y / 3, 2);
        const n = fbm2(grain, x / 14, y / 5, 3) - 0.5;
        land.tone(x, y, YARD_SUN, 0.66 - (y - yardY) / 300 + n * 0.5 + (crack > 0.72 ? -0.2 : 0), 0.7);
      }
    }
    // Chalk on the sunny side: a hopscotch somebody drew this morning.
    const CHALK = rgba('#fdfbf2');
    const box = (bx, by, w, h) => {
      for (let i = 0; i <= w; i += 1) {
        if (i % 5 !== 4) land.put(bx + i, by, CHALK);
        if (i % 5 !== 2) land.put(bx + i, by + h, CHALK);
      }
      for (let j = 0; j <= h; j += 1) {
        land.put(bx - Math.round(j * 0.3), by + j, CHALK);
        land.put(bx + w - Math.round(j * 0.3), by + j, CHALK);
      }
    };
    box(46, 236, 16, 5);
    box(62, 236, 16, 5);
    box(78, 236, 16, 5);
    box(62, 231, 16, 5);
    box(62, 241, 16, 5);
    box(94, 236, 16, 5);
    // A raised flowerbed at the far left of the yard, brick with a limewashed lip, cannas in it.
    const BRICK = ramp('#8a4428', '#a85a34', '#c07444', '#d48e5a');
    for (let x = -4; x < 62; x += 1) {
      for (let y = 214; y < 228; y += 1) {
        const mortar = (y - 214) % 4 === 3 || (x + Math.floor((y - 214) / 4) * 4) % 9 === 0;
        land.tone(x, y, BRICK, mortar ? 0.08 : 0.74 - (x + 4) / 200 - (y - 214) * 0.012, 0.5);
      }
    }
    land.rect(-4, 212, 67, 2, rgba('#fff7e2'));
    land.rect(-4, 214, 67, 1, rgba('#c9b48c'));
    land.rect(62, 212, 2, 16, rgba('#7a3e24'));
    for (let x = -4; x < 66; x += 1) land.rect(x, 228, 1, 2, YARD_SUN[0]);
    for (let i = 0; i < 8; i += 1) {
      puffs(land, clusterOf(rand, 2 + i * 8, 205 + rand() * 3, 7, 6, 2.6, 4.6), LEAF, { spread: 0.9, height: 0.62, lift: 0.08, light: [-0.45, -0.85, 0.3], grain: (p, q) => (fbm2(grain, p / 1.7, q / 1.7, 2) - 0.5) * 0.7 });
    }
    for (let i = 0; i < 22; i += 1) {
      const fx = Math.round(rand() * 62 - 2);
      const fy = Math.round(197 + rand() * 12);
      const hue = rand() < 0.5 ? ['#ffe14a', '#f0a81a'] : ['#ff5a3a', '#c8281a'];
      land.rect(fx, fy, 2, 3, rgba(hue[0]));
      land.rect(fx + 1, fy + 1, 2, 2, rgba(hue[1]));
    }

    // The tree's shade laid on the yard: a wide band, hard-edged on its sunny side.
    const edgeAt = (y) => 96 + (y - yardY) * 0.9;
    const edgeNoise = (y) => (fbm2(grain, y / 6, 3.1, 3) - 0.5) * 30;
    for (let y = yardY; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const from = edgeAt(y) + edgeNoise(y) - x;
        const n = fbm2(grain, x / 14, y / 5, 3) - 0.5;
        const scallop = Math.sin(x / 7 + y / 3) * 3;
        if (from + scallop > 0) continue;
        const crack = fbm2(grain, x / 3, y / 3, 2);
        land.tone(x, y, YARD_SHADE, 0.56 + n * 0.5 + (crack > 0.72 ? -0.18 : 0) - (y - yardY) / 220 + clamp((-from - 0) / 120) * -0.1, 0.7);
      }
    }
    // Fallen flowers: a red carpet, thickest under the crown and on the shaded side.
    const FALLEN = ['#d8341a', '#ee5018', '#c02a18', '#ff7a24', '#a31f18'].map(rgba);
    for (let i = 0; i < 1500; i += 1) {
      const x = Math.floor(rand() * W);
      const y = yardY + Math.floor(rand() * rand() * (H - yardY) + rand() * 26);
      const near = clamp((x - 70) / 150);
      if (rand() > near * 0.85 + 0.08) continue;
      land.put(x, y, FALLEN[Math.floor(rand() * FALLEN.length)]);
      if (rand() < 0.3) land.put(x + 1, y, FALLEN[Math.floor(rand() * FALLEN.length)]);
    }

    // The crown behind the limbs.
    const crownBack = new Art(W, 190);
    const { limbs, twigs } = growFlame(rand);
    const grainFine = (x, y) => (fbm2(grain, x / 2.1, y / 2.1, 2) - 0.5) * 0.62;
    const reach = twigs.filter((p) => p.x > -14 && p.x < W + 14 && p.y < 142 && rand() < 0.34);
    for (const p of reach) {
      if (rand() < 0.65) puffs(crownBack, clusterOf(rand, p.x, p.y, 9, 7, 3, 6), CROWN_DEEP, { spread: 0.9, height: 0.55, light: [-0.45, -0.85, 0.35], grain: grainFine });
    }
    // Bole and limbs, roots spreading.
    const tree = new Art();
    paintLimbs(tree, limbs, grain);
    for (const [dx, a, len] of [[-12, 2.92, 26], [12, 0.2, 28], [-6, 2.56, 18], [8, 0.56, 16]]) {
      const roots = [];
      for (let k = 0; k < len; k += 1) roots.push({ x: 398 + dx + Math.cos(a) * k, y: 238 + Math.sin(a) * k * 0.5, r: 3.4 * (1 - k / len) + 0.8 });
      paintLimbs(tree, roots, grain);
    }
    // The bottom of the bole whitewashed, as every school does; it stands in shade, so it is not white.
    const WASH = ramp('#6c6a76', '#8a8890', '#a9a7a8', '#c6c3be', '#e2dfd4');
    for (let y = 196; y < 232; y += 1) {
      for (let x = 380; x < 416; x += 1) {
        const c = tree.get(x, y);
        if (!c) continue;
        const left = (x - 397) / 14;
        const edge = y - 204 + Math.sin(x * 0.7) * 1.6 + Math.sin(x * 0.23) * 1.4;
        if (edge > 0) tree.tone(x, y, WASH, 0.56 - left * 0.46 + (fbm2(grain, x / 2.4, y / 5, 2) - 0.5) * 0.5, 0.6);
      }
    }
    // Long brown seed pods, the kind we all fenced with.
    const pods = [];
    for (let i = 0; i < 140 && pods.length < 16; i += 1) {
      const p = twigs[Math.floor(rand() * twigs.length)];
      if (p.y < 116 || p.y > 142 || p.x < 20 || p.x > 464) continue;
      pods.push({ x: Math.round(p.x), y: Math.round(p.y) + 2, len: 22 + Math.floor(rand() * 12), period: 3.6 + rand() * 3, phase: rand() });
    }
    // The crown in front, in three lots that move a little apart from each other.
    const crowns = [new Art(W, 190), new Art(W, 190), new Art(W, 190)];
    reach.forEach((p, i) => {
      const lot = crowns[i % 3];
      puffs(lot, clusterOf(rand, p.x + (rand() - 0.5) * 8, p.y + (rand() - 0.5) * 6 - 1, 6 + rand() * 4, 6 + Math.floor(rand() * 3), 2, 3.8), CROWN, { spread: 0.9, height: 0.7, lift: 0.04, light: [-0.45, -0.85, 0.35], grain: grainFine });
    });
    // Fern-green leaves showing through, and bright single flowers on the top of everything.
    for (let i = 0; i < 800; i += 1) {
      const p = twigs[Math.floor(rand() * twigs.length)];
      if (p.y > 142) continue;
      const a = rand() * TAU;
      const r = rand() * 10;
      const x = Math.round(p.x + Math.cos(a) * r);
      const y = Math.round(p.y + Math.sin(a) * r * 0.7);
      const lot = crowns[i % 3];
      if (i % 3 === 0) {
        const c = LEAF[Math.floor(rand() * 4)];
        for (let k = 0; k < 5; k += 1) lot.put(x + k, y + (k >> 1), c);
      } else {
        lot.put(x, y - 1, rgba('#ffc060'));
        lot.put(x - 1, y, rgba('#ff9a30'));
        lot.put(x + 1, y, rgba('#f2541a'));
        lot.put(x, y + 1, rgba('#d8341a'));
        lot.put(x, y, rgba(i % 7 === 0 ? '#fff4d0' : '#ffe07a'));
      }
    }

    // Bench and bicycle, in the shade.
    const props = new Art();
    bench(props, 322, 248);
    bicycle(props, 404, 246);

    // Near flowers hanging in at the very top right, close to us.
    const near = new Art(240, 52);
    for (let i = 0; i < 50; i += 1) {
      const nx = 240 - rand() * rand() * 240;
      const ny = rand() * (8 + (nx / 240) * 34);
      puffs(near, clusterOf(rand, nx, ny, 8, 7, 2.4, 4.4), CROWN, { spread: 0.9, height: 0.65, lift: 0.1, light: [-0.45, -0.85, 0.35], grain: grainFine });
    }
    for (let i = 0; i < 90; i += 1) {
      const nx = 240 - rand() * 220;
      const ny = rand() * 40;
      if (near.get(Math.round(nx), Math.round(ny))) {
        near.put(nx, ny, rgba('#ffe07a'));
        near.put(nx - 1, ny, rgba('#ffb040'));
      }
    }

    // The light that falls through: where it lands is fixed, and each coin swells and thins as leaves cross it.
    const coins = [];
    for (let i = 0; i < 420 && coins.length < 120; i += 1) {
      const x = 96 + rand() * 390;
      const y = yardY + 3 + rand() * 64;
      if (x < edgeAt(y) + 20 || fbm2(grain, x / 16, y / 7, 2) < 0.47) continue;
      coins.push({ x, y, sway: 1 + rand() * 3.2, big: rand() < 0.3 ? 5.4 : 2 + rand() * 2.4, period: 3 + rand() * 6, phase: rand(), period2: 7 + rand() * 9, phase2: rand() });
    }
    // Light on the bole too.
    const barkCoins = [];
    for (let i = 0; i < 16; i += 1) barkCoins.push({ x: 382 + rand() * 20, y: 112 + rand() * 80, period: 4 + rand() * 6, phase: rand() });

    const petals = [];
    for (let i = 0; i < 90; i += 1) {
      const z = rand();
      petals.push({ x: rand() * (W + 40), y: rand() * H, z, v: 7 + z * 19, drift: 3 + z * 11, sway: 4 + rand() * 12, period: 2.6 + rand() * 4, phase: rand(), hex: rand() < 0.4 ? '#ee5018' : rand() < 0.5 ? '#ff7a24' : rand() < 0.5 ? '#d8341a' : '#ffb040' });
    }

    const butterfly = (hex, dark) => [
      sprite(['ww ww', 'wwkww', ' wkw ', ' w w '], { w: hex, k: dark }),
      sprite(['     ', ' wkw ', ' wkw ', '     '], { w: hex, k: dark }),
    ];

    return {
      sky: sky.canvas(),
      high: high.canvas(),
      tower: tower.canvas(),
      land: land.canvas(),
      crownBack: crownBack.canvas(),
      tree: tree.canvas(),
      crowns: crowns.map((c) => c.canvas()),
      props: props.canvas(),
      near: near.canvas(),
      coinPics: coinSprites(),
      coins,
      barkCoins,
      pods,
      petals,
      yellow: butterfly('#ffd84a', '#3a2a18'),
      white: butterfly('#fdfbf2', '#4a4238'),
    };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.high, along(t, 2.1, 960), 4);
    slide(ctx, s.tower, along(t, 0.9, 960), 2);

    // The cicada, a speck that throws itself from tree to tree.
    const cross = (t % 31) / 3;
    if (cross < 1) {
      ctx.fillStyle = '#1f1a18';
      const x = Math.round(30 + cross * 300);
      const y = Math.round(92 - Math.sin(cross * Math.PI) * 30 + Math.sin(cross * 41) * 2);
      ctx.fillRect(x, y, 2, 1);
    }

    // The land, with the heat coming off it: the rows low down wander by a pixel, no two alike.
    ctx.drawImage(s.land, 0, 0, W, 170, 0, 0, W, 170);
    for (let y = 170; y < 226; y += 1) {
      const k = (y - 170) / 56;
      const shift = Math.round(Math.sin(y * 0.74 + t * 3.1) * 0.8 * k + Math.sin(y * 0.31 - t * 2.3) * 0.9 * k);
      ctx.drawImage(s.land, 0, y, W, 1, shift, y, W, 1);
      if (shift > 0) ctx.drawImage(s.land, 0, y, shift, 1, 0, y, shift, 1);
      else if (shift < 0) ctx.drawImage(s.land, W + shift, y, -shift, 1, W + shift, y, -shift, 1);
    }
    ctx.drawImage(s.land, 0, 226, W, H - 226, 0, 226, W, H - 226);

    // Coins of sun on the ground, swelling and thinning as the leaves above them move.
    const pics = s.coinPics;
    for (const c of s.coins) {
      const k = wave(t, c.period, c.phase) * 0.5 + 0.5;
      const size = Math.floor(k * c.big + (wave(t, c.period2, c.phase2) > 0.6 ? 1 : 0));
      const p = pics[Math.min(pics.length - 1, size)];
      ctx.drawImage(p, Math.round(c.x + wave(t, c.period2, c.phase2) * c.sway - p.width / 2), Math.round(c.y - p.height / 2));
    }

    ctx.drawImage(s.props, 0, 0);
    ctx.drawImage(s.crownBack, Math.round(wave(t, 11) * 0.8), 0);
    ctx.drawImage(s.tree, 0, 0);
    ctx.fillStyle = 'rgba(255,214,140,0.3)';
    for (const b of s.barkCoins) {
      const k = wave(t, b.period, b.phase);
      if (k > 0.2) ctx.fillRect(Math.round(b.x), Math.round(b.y), 1 + Math.round(k * 2), 1);
    }

    // Seed pods swing a little on their stalks.
    for (const p of s.pods) {
      const lean = wave(t, p.period, p.phase) * 1.4;
      ctx.fillStyle = '#3a2418';
      ctx.fillRect(Math.round(p.x + lean * 0.5), p.y, 2, Math.round(p.len * 0.55));
      ctx.fillRect(Math.round(p.x + lean), p.y + Math.round(p.len * 0.55), 2, Math.round(p.len * 0.45));
      ctx.fillStyle = '#6a4228';
      ctx.fillRect(Math.round(p.x + lean * 0.5), p.y + 2, 1, p.len - 4);
    }


    ctx.drawImage(s.crowns[0], Math.round(wave(t, 6.1) * 1.3), Math.round(wave(t, 8.3, 0.2) * 0.7));
    ctx.drawImage(s.crowns[1], Math.round(wave(t, 4.7, 0.5) * 1.4), 0);
    ctx.drawImage(s.crowns[2], Math.round(wave(t, 7.3, 0.7) * 1.2), Math.round(wave(t, 4.3) * 0.8));

    // Petals, deep and near, turning as they come down.
    const span = W + 40;
    for (const p of s.petals) {
      const y = ((p.y + t * p.v) % (H + 8)) - 4;
      const x = (((p.x - t * p.drift + Math.sin((t / p.period + p.phase) * TAU) * p.sway) % span) + span) % span - 20;
      const flip = wave(t, p.period * 0.5, p.phase) > 0;
      const big = p.z > 0.82 ? 2 : 1;
      ctx.fillStyle = p.hex;
      ctx.fillRect(Math.round(x), Math.round(y), (flip ? 2 : 1) * big, (flip ? 1 : 2) * big);
    }

    // Two butterflies, on long lazy circuits of the yard.
    const fly = (pics2, period, phase, cx, cy, rx, ry) => {
      const a = (t / period + phase) * TAU;
      const x = cx + Math.sin(a) * rx + Math.sin(a * 3.1) * 8;
      const y = cy + Math.sin(a * 2) * ry + Math.sin(t * 5 + phase * 9) * 1.5;
      ctx.drawImage(pics2[Math.floor(t * 8) % 2], Math.round(x), Math.round(y));
    };
    fly(s.yellow, 41, 0.1, 240, 186, 210, 26);
    fly(s.white, 29, 0.55, 110, 196, 86, 20);

    ctx.drawImage(s.near, W - 236 + Math.round(wave(t, 7.9) * 1.4), -4 + Math.round(wave(t, 5.3, 0.3) * 0.9));
  },
};

export default phoenixSummer;
