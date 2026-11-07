import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, Art, noise1, noise2, fbm1, fbm2, puffs, cumulus, sprite, slide } from './art.js';

/** A crown of blossom, built from clusters so its top is a scallop. */
function blossomCrown(rand, cx, base, width, height) {
  const list = [];
  const count = Math.round((width * height) / 12);
  for (let i = 0; i < count; i += 1) {
    const a = rand() * TAU;
    const k = Math.sqrt(rand());
    const x = cx + Math.cos(a) * k * width * 0.5;
    const y = base - height * 0.5 + Math.sin(a) * k * height * 0.5;
    list.push({ x, y, r: 2.4 + rand() * 3.2, z: rand() * 2 });
  }
  return list;
}

/** A warm late afternoon, cherry trees in bloom along a railway, a crossing that blinks, a cat. */
const sakuraCrossing = {
  build() {
    const rand = seeded(7701);
    const SKY = ramp('#f4b183', '#f7bd8d', '#f9c999', '#fbd4a6', '#fcdfb5', '#fde8c5', '#fef0d6', '#fff6e4');
    const sky = new Art();
    sky.shade(SKY, (x, y) => {
      const d = Math.hypot((x - 340) / 1.5, y - 138);
      return clamp(0.05 + (y / H) * 0.42 + 0.66 * Math.exp(-((d / 130) ** 2)));
    }, 0.95);
    const CLOUD = ramp('#e79a7f', '#f0ae8e', '#f6c3a2', '#fbd8bb', '#fee9d3', '#fff6ea');
    const clouds = new Art(960, 170);
    for (const [cx, base, w, h] of [[110, 120, 210, 86], [360, 142, 170, 62], [600, 108, 240, 90], [840, 136, 180, 66]]) {
      puffs(clouds, cumulus(rand, cx, base, w, h), CLOUD, { base, wrap: true, spread: 0.55, height: 0.62, light: [0.55, -0.75, 0.3], lift: 0.12, flat: 8 });
    }

    const land = new Art();
    // Far hills, in the haze.
    const hillNoise = noise1(7702, 128);
    const HAZE = ramp('#c89a9f', '#d4abab', '#dfbcb6', '#e9ccc1');
    const hills = (x) => 136 + fbm1(hillNoise, x / 66, 3) * 34;
    for (let x = 0; x < W; x += 1) for (let y = Math.round(hills(x)); y < 200; y += 1) land.tone(x, y, HAZE, clamp(0.72 - (y - hills(x)) / 60), 0.8);

    // The bank, in grass, and the trees along the top of it.
    const GRASS = ramp('#8f9c4e', '#a4ad59', '#b8bd68', '#cfcd7c', '#e3dc95');
    const bank = noise2(7703, 64);
    land.shade(GRASS, (x, y) => (y < 176 + Math.sin(x / 40) * 3 ? -1 : clamp(0.7 - (y - 176) / 60 + (fbm2(bank, x / 7, y / 5, 2) - 0.5) * 0.7)), 0.9, [0, 170, W, 216]);
    const BARK = ramp('#4a2e2f', '#65403d', '#83574c');
    const BLOSSOM = ramp('#c76a84', '#dd8399', '#ec9fae', '#f6bcc4', '#fcd6d8', '#ffeceb');
    const trees = [[22, 84], [86, 96], [150, 76], [214, 104], [282, 80], [346, 100], [414, 90], [474, 86]];
    for (const [x, tall] of trees) {
      const base = 186;
      land.line(x, base, x - 2, base - tall * 0.5, BARK[0]);
      land.rect(x - 2, base - tall * 0.55, 5, tall * 0.55, BARK[1]);
      land.rect(x - 1, base - tall * 0.55, 1, tall * 0.55, BARK[2]);
      for (const [dx, dy] of [[-14, -0.4], [12, -0.45], [-5, -0.68]]) land.line(x, base - tall * 0.34, x + dx, base + tall * dy, BARK[0]);
    }
    const petalGrain = noise2(7705, 64);
    const flowers = (x, y) => (fbm2(petalGrain, x / 3.2, y / 3.2, 2) - 0.5) * 0.55;
    for (const [x, tall] of trees) {
      const base = 182 - tall * 0.3;
      puffs(land, blossomCrown(rand, x, base, tall * 1.02, tall * 0.84), BLOSSOM, { spread: 0.9, height: 0.74, light: [0.5, -0.8, 0.4], lift: 0.06, grain: flowers });
    }

    // A dry-stone wall under the bank, course by course.
    const STONE = ramp('#a88561', '#bb9971', '#cdad84', '#dcc098', '#e9d1ab');
    for (let row = 0; row < 3; row += 1) {
      const y = 196 + row * 7;
      let x = -(row % 2) * 6;
      while (x < W) {
        const w = 10 + Math.floor(rand() * 9);
        const tone = 0.25 + rand() * 0.6;
        for (let j = 0; j < 6; j += 1) for (let i = 0; i < w - 1; i += 1) land.tone(x + i, y + j, STONE, clamp(tone + (j === 0 ? 0.2 : j === 5 ? -0.25 : 0)), 0.5);
        for (let j = 0; j < 7; j += 1) land.put(x + w - 1, y + j, rgba('#856445'));
        x += w;
      }
      for (let i = 0; i < W; i += 1) land.put(i, y + 6, rgba('#856445'));
    }
    // A plain timber fence along the top of the wall.
    const FENCE = rgba('#6e4a35');
    const FENCE_LIT = rgba('#9a6d4b');
    land.rect(0, 186, W, 2, FENCE_LIT);
    land.rect(0, 188, W, 1, FENCE);
    for (let x = 6; x < W; x += 34) {
      land.rect(x, 182, 3, 15, FENCE);
      land.rect(x, 182, 1, 15, FENCE_LIT);
    }

    // Ballast, sleepers and two rails.
    const BALLAST = ramp('#675a53', '#7c6c62', '#94826f', '#ad9a84', '#c6b39d');
    const stones = noise2(7704, 64);
    land.shade(BALLAST, (x, y) => clamp(0.58 + (fbm2(stones, x / 2.3, y / 2.3, 2) - 0.5) * 1.5 - Math.abs(y - 244) / 60), 0.9, [0, 217, W, H]);
    for (let x = -4; x < W; x += 15) {
      land.rect(x, 234, 8, 25, rgba('#4b3a33'));
      land.rect(x, 234, 8, 2, rgba('#6c5448'));
    }
    for (const y of [238, 252]) {
      land.rect(0, y, W, 1, rgba('#f7e6cf'));
      land.rect(0, y + 1, W, 2, rgba('#6a5e58'));
      land.rect(0, y + 3, W, 1, rgba('#3e3433'));
    }

    // The crossing: a mast, a crossbuck, two lamps and the arm standing up.
    const POST = 402;
    for (let y = 92; y < 226; y += 1) {
      const dark = Math.floor((y + 4) / 8) % 2 === 0;
      land.rect(POST - 2, y, 4, 1, rgba(dark ? '#2b2726' : '#f1c84a'));
      land.put(POST - 2, y, rgba(dark ? '#4b4442' : '#ffe48a'));
    }
    const buck = (x0, y0, x1, y1) => {
      for (let k = 0; k <= 1; k += 1 / 44) {
        const x = mix(x0, x1, k);
        const y = mix(y0, y1, k);
        const dark = Math.floor(k * 7) % 2 === 0;
        land.disc(x, y, 2.2, rgba(dark ? '#2b2726' : '#f4cf54'));
      }
    };
    buck(POST - 22, 72, POST + 22, 112);
    buck(POST + 22, 72, POST - 22, 112);
    land.rect(POST - 30, 126, 60, 3, rgba('#2b2726'));
    for (const lx of [POST - 25, POST + 25]) {
      land.disc(lx, 136, 11, rgba('#27211f'));
      land.disc(lx, 136, 8, rgba('#4d1a1a'));
      land.rect(lx - 12, 123, 24, 4, rgba('#17110f'));
    }
    land.rect(POST - 6, 172, 12, 18, rgba('#3a3433'));
    land.rect(POST - 5, 173, 10, 2, rgba('#5c5350'));
    const barrier = (y0) => {
      for (let i = 0; i < 74; i += 1) land.rect(POST + 6, y0 - i, 2, 1, rgba(Math.floor(i / 9) % 2 ? '#fff3df' : '#c9402f'));
    };
    barrier(182);

    // A black cat, sitting on the wall: tail, two ears, eyes that close.
    const CAT = { k: '#1d1a20', d: '#2d2931', e: '#f5d76e', p: '#f0a4a4' };
    const cat = (eyes) => sprite([
      '  k     k   ',
      ' kkk   kkk  ',
      ' kkkkkkkkk  ',
      ` k${eyes}kkk${eyes}k  `,
      ' kkkkpkkkk  ',
      '  kkkkkkk   ',
      '   kkkkk    ',
      '  kkkkkkk   ',
      '  kkkkkkkk  ',
      ' kkkkkkkkk  ',
      ' kkkkkkkkkk ',
      ' kkkkkkkkkk ',
      ' kk kkkk kk ',
    ], CAT);

    // Near blossom, hanging in from the corner, swaying as one.
    const bough = new Art(190, 86);
    const close = [];
    for (let i = 0; i < 420; i += 1) {
      const k = rand();
      close.push({ x: 186 * k + (rand() - 0.5) * 8, y: 4 + (1 - k) * 26 + rand() * (48 * (1 - k * 0.72)), r: 1.8 + rand() * 3.2, z: rand() * 2 });
    }
    puffs(bough, close, BLOSSOM, { spread: 0.9, height: 0.6, lift: 0.06, grain: flowers });
    for (let i = 0; i < 150; i += 1) bough.put(i, Math.round(3 + (150 - i) * 0.1), BARK[1]);

    const petals = [];
    for (let i = 0; i < 110; i += 1) {
      const z = rand();
      petals.push({ x: rand() * (W + 40), y: rand() * H, z, v: 7 + z * 24, drift: 8 + z * 20, sway: 4 + rand() * 12, period: 3 + rand() * 5, phase: rand(), tone: rand() < 0.5 ? '#ffd8dd' : rand() < 0.5 ? '#ffc2cc' : '#ffeef0' });
    }
    return { sky: sky.canvas(), clouds: clouds.canvas(), land: land.canvas(), bough: bough.canvas(), catOpen: cat('e'), catShut: cat('k'), petals, lampsAt: [POST - 25, POST + 25] };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.clouds, along(t, 0.9, 960), 22);
    ctx.drawImage(s.land, 0, 0);

    // The lamps take it in turn, once a second, each with a soft bloom.
    const lit = Math.floor(t) % 2;
    const lx = s.lampsAt[lit];
    ctx.fillStyle = 'rgba(255,90,60,0.1)';
    ctx.fillRect(lx - 20, 116, 40, 40);
    ctx.fillStyle = 'rgba(255,110,70,0.2)';
    ctx.fillRect(lx - 12, 124, 24, 24);
    ctx.fillStyle = '#ff4930';
    for (const [dy, half] of [[-7, 3], [-6, 5], [-5, 6], [-4, 7], [-3, 7], [-2, 8], [-1, 8], [0, 8], [1, 8], [2, 8], [3, 7], [4, 7], [5, 6], [6, 5], [7, 3]]) ctx.fillRect(lx - half, 136 + dy, half * 2, 1);
    ctx.fillStyle = '#ffb99c';
    ctx.fillRect(lx - 3, 131, 3, 2);

    // A cat, on a period of its own: mostly still, a slow blink, a tail that flicks.
    const blink = (t % 6.3) < 0.26;
    const px = 190;
    const py = 170;
    ctx.drawImage(blink ? s.catShut : s.catOpen, px, py);
    ctx.fillStyle = '#1d1a20';
    const flick = wave(t, 3.1) * 3;
    for (let i = 0; i < 9; i += 1) ctx.fillRect(Math.round(px + 12 + i * 0.55 + flick * (i / 9) ** 2), py + 11 - Math.round((i / 9) ** 2 * 7), 2, 1);

    for (const p of s.petals) {
      const y = (p.y + t * p.v) % (H + 8);
      const x = ((p.x - t * p.drift + Math.sin((t / p.period + p.phase) * TAU) * p.sway) % (W + 40) + W + 40) % (W + 40) - 20;
      const flip = wave(t, p.period, p.phase) > 0;
      ctx.fillStyle = p.tone;
      const big = p.z > 0.82 ? 2 : 1;
      ctx.fillRect(Math.round(x), Math.round(y), (flip ? 2 : 1) * big, (flip ? 1 : 2) * big);
    }
    ctx.drawImage(s.bough, Math.round(wave(t, 8) * 1.5) - 8, Math.round(wave(t, 5.3) * 1) - 4);
  },
};

export default sakuraCrossing;
