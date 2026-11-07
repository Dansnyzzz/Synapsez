import { W, H, TAU, clamp, mix, wave, along, seeded, rgba, ramp, bayer, Art, puffs, cumulus, sprite, slide } from './art.js';

/** Pink dusk on a city corner: a low sun, wires, shops closing, a signal that keeps blinking. */
const roseStreet = {
  build() {
    const rand = seeded(8801);
    const SKY = ramp('#b65f72', '#c56b78', '#d27881', '#de868a', '#e79695', '#efa7a1', '#f4b8ae');
    const sky = new Art();
    sky.shade(SKY, (x, y) => clamp(0.08 + (y / 180) * 0.8 + 0.3 * Math.exp(-((Math.hypot(x - 300, y - 76) / 90) ** 2))), 0.95);
    sky.disc(300, 76, 30, rgba('#f7cdbb'));
    for (let y = 46; y < 106; y += 1) for (let x = 268; x < 332; x += 1) if (Math.hypot(x - 300, y - 76) <= 30 && (x + y) % 2 === 0 && y > 88) sky.put(x, y, rgba('#f4c1af'));

    const CLOUD = ramp('#d68488', '#e59c9a', '#f1b5ad', '#f9cfc2');
    const clouds = new Art(960, 90);
    for (let i = 0; i < 9; i += 1) {
      const cx = (i + rand()) * (960 / 9);
      const base = 44 + rand() * 40;
      puffs(clouds, cumulus(rand, cx, base, 46 + rand() * 62, 10 + rand() * 12), CLOUD, { base, wrap: true, spread: 0.45, height: 0.82, flat: 3, lift: 0.1 });
    }

    const land = new Art();
    const VIOLET = ['#8d5570', '#7a4a66', '#68405c', '#573751'];
    // Far blocks in four depths, each a step darker and nearer.
    VIOLET.forEach((hex, depth) => {
      let x = -8 + depth * 11;
      const c = rgba(hex);
      const lit = rgba(['#c9808a', '#b97684', '#a66b7c', '#945f72'][depth]);
      while (x < W) {
        const w = 18 + Math.floor(rand() * 26);
        const top = 118 + depth * 13 - Math.floor(rand() * (38 - depth * 7));
        land.rect(x, top, w, H, c);
        land.rect(x + w - 2, top, 2, H, lit);
        if (rand() > 0.55) land.rect(x + 4 + Math.floor(rand() * (w - 8)), top - 7, 1, 7, c);
        if (depth >= 1) {
          for (let wy = top + 5; wy < 210; wy += 7) for (let wx = x + 3; wx < x + w - 4; wx += 5) if (rand() < 0.3) land.put(wx, wy, rgba('#d99a8e'));
        }
        x += w + (rand() > 0.8 ? 6 : 0);
      }
    });

    // The corner building, its dither the only texture on the page.
    const BRICK = ramp('#3a2a44', '#463250', '#553b5c', '#664668');
    land.shade(BRICK, (x, y) => (x > 170 + (y - 60) * 0.06 ? -1 : clamp(0.6 - (x / 170) * 0.5 + ((y % 6 === 0 ? -0.2 : 0) + ((x + Math.floor(y / 6) * 5) % 11 === 0 ? -0.18 : 0)))), 0.7, [0, 56, 186, 226]);
    for (let i = 0; i < 186; i += 1) land.rect(i, 52, 1, 4, rgba(i % 8 < 1 ? '#2b2036' : '#231a2e'));
    land.rect(0, 50, 186, 2, rgba('#7b5877'));
    // Floors of windows, remembered so they can come on.
    const windows = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const x = 14 + col * 32;
        const y = 66 + row * 38;
        land.rect(x - 1, y - 1, 20, 27, rgba('#2a1f35'));
        land.rect(x, y, 18, 25, rgba('#4b3d5d'));
        land.rect(x + 8, y, 1, 25, rgba('#2a1f35'));
        land.rect(x, y + 12, 18, 1, rgba('#2a1f35'));
        land.rect(x - 2, y + 26, 22, 2, rgba('#6a4e6c'));
        windows.push({ x, y, period: 11 + rand() * 31, phase: rand() });
      }
    }
    // A shop on the ground floor, with its striped awning.
    land.rect(4, 190, 170, 36, rgba('#2b2036'));
    land.rect(10, 196, 66, 30, rgba('#6c5a78'));
    land.rect(84, 196, 26, 30, rgba('#3c2d48'));
    land.rect(118, 196, 50, 30, rgba('#6c5a78'));
    for (let i = 0; i < 172; i += 1) {
      const stripe = Math.floor(i / 8) % 2 ? '#f2d4c6' : '#b5475f';
      for (let k = 0; k < 8; k += 1) land.put(4 + i + k * 0.4, 180 + k, rgba(stripe));
    }

    // Road, pavement and the crossing's bars.
    land.rect(0, 226, W, 5, rgba('#8b6f86'));
    land.rect(0, 226, W, 1, rgba('#b18fa1'));
    const ROAD = ramp('#3b2c42', '#463550', '#52405c');
    land.shade(ROAD, (x, y) => clamp(0.6 - (y - 231) / 60 + (bayer(x, y) - 0.5) * 0.2), 0.8, [0, 231, W, H]);
    for (let i = 0; i < 9; i += 1) {
      const y = 238 + i * 3;
      for (let bar = 0; bar < 8; bar += 1) {
        const x0 = 196 + bar * 34 - i * 2.6;
        land.rect(x0, y, 22 + i * 0.6, 2, rgba('#d9bcc0'));
      }
    }

    // A pole and its wires, drawn last so they cross everything.
    const POLE = rgba('#221a2c');
    land.rect(330, 42, 4, 188, POLE);
    land.rect(331, 42, 1, 188, rgba('#4c3a50'));
    land.rect(312, 58, 40, 3, POLE);
    land.rect(318, 80, 28, 2, POLE);
    land.rect(332, 96, 28, 2, POLE);
    land.rect(356, 98, 12, 3, rgba('#1b1422'));
    for (const [y0, y1, sag] of [[58, 74, 14], [58, 66, 11], [80, 90, 16]]) {
      for (let x = 0; x < 330; x += 1) land.put(x, Math.round(mix(y0 + 8, y0, x / 330) + Math.sin((x / 330) * Math.PI) * sag), POLE);
      for (let x = 334; x < W; x += 1) land.put(x, Math.round(mix(y1, y0, (x - 334) / (W - 334)) + Math.sin(((x - 334) / (W - 334)) * Math.PI) * sag * 0.6), POLE);
    }
    // A signal box on a thin post, right of the road.
    land.rect(420, 150, 3, 80, POLE);
    land.rect(413, 126, 17, 30, rgba('#241b2e'));
    land.rect(414, 127, 15, 1, rgba('#4b3a4e'));
    land.disc(421, 134, 5, rgba('#47233a'));
    land.disc(421, 148, 5, rgba('#233a34'));
    // A cherry tree in the corner, the one thing still in colour.
    const TREE = ramp('#a34c6c', '#c0677f', '#d98593', '#ecabad', '#f7cec7');
    land.rect(383, 180, 4, 48, rgba('#2b2036'));
    const crown = [];
    for (let i = 0; i < 190; i += 1) {
      const a = rand() * TAU;
      const k = Math.sqrt(rand());
      crown.push({ x: 385 + Math.cos(a) * k * 32, y: 164 + Math.sin(a) * k * 24, r: 2 + rand() * 3, z: rand() * 2 });
    }
    puffs(land, crown, TREE, { spread: 0.9, height: 0.7, lift: 0.04 });

    const car = sprite([
      '       cccccccccc       ',
      '     ccwwwcwwwwwwcc     ',
      '   ccccwwwcwwwwwwccc    ',
      ' ccccccccccccccccccccc  ',
      'rcccccccccccccccccccccy ',
      'ccdddddcccccccccdddddccc',
      '  dkkkd         dkkkd   ',
    ], { c: '#231a2c', w: '#5a4a68', d: '#120c18', k: '#3a2d44', r: '#ff4d58', y: '#ffe9a8' });
    const drift = [];
    for (let i = 0; i < 26; i += 1) drift.push({ x: rand() * W, y: rand() * H, v: 6 + rand() * 12, sway: 3 + rand() * 6, phase: rand() });
    return { sky: sky.canvas(), clouds: clouds.canvas(), land: land.canvas(), windows, car, drift };
  },
  draw(ctx, t, s) {
    ctx.drawImage(s.sky, 0, 0);
    slide(ctx, s.clouds, along(t, 1.1, 960), 8);
    ctx.drawImage(s.land, 0, 0);
    for (const w of s.windows) {
      // Whole minutes between changes: somebody comes home, somebody goes to bed.
      if (wave(t, w.period, w.phase) < 0.1) continue;
      ctx.fillStyle = '#f5cf8e';
      ctx.fillRect(w.x, w.y, 8, 12);
      ctx.fillRect(w.x + 9, w.y, 9, 12);
      ctx.fillRect(w.x, w.y + 13, 8, 12);
      ctx.fillRect(w.x + 9, w.y + 13, 9, 12);
    }
    // The shop's light is an old tube: steady, and every so often it catches.
    const flicker = (t % 13) < 0.5 && Math.floor(t * 14) % 3 === 0;
    ctx.fillStyle = flicker ? '#a98f92' : '#ffd9a5';
    ctx.fillRect(10, 196, 66, 30);
    ctx.fillRect(118, 196, 50, 30);
    ctx.fillStyle = flicker ? '#8c7176' : '#ffc27f';
    ctx.fillRect(14, 214, 58, 12);
    ctx.fillRect(122, 214, 42, 12);
    ctx.fillStyle = '#2b2036';
    for (const x of [28, 44, 60, 132, 148]) ctx.fillRect(x, 196, 1, 30);
    ctx.fillStyle = flicker ? 'rgba(255,214,160,0.03)' : 'rgba(255,214,160,0.13)';
    ctx.fillRect(4, 226, 176, 10);
    // The street lamp, and the circle of light it keeps.
    ctx.fillStyle = 'rgba(255,230,180,0.14)';
    ctx.fillRect(350, 101, 24, 12);
    ctx.fillStyle = '#fff1c9';
    ctx.fillRect(358, 101, 8, 2);
    // The signal takes turns: green that blinks, then red, and round again.
    const phase = t % 12;
    const green = phase < 6 || (phase < 8 && Math.floor(t * 2) % 2 === 0);
    ctx.fillStyle = green ? '#6ff5b4' : '#ff5a5f';
    const signal = green ? 148 : 134;
    for (const [dy, half] of [[-3, 2], [-2, 3], [-1, 4], [0, 4], [1, 4], [2, 3], [3, 2]]) ctx.fillRect(421 - half, signal + dy, half * 2, 1);
    ctx.fillStyle = green ? 'rgba(111,245,180,0.14)' : 'rgba(255,90,95,0.14)';
    ctx.fillRect(411, signal - 10, 20, 20);

    // A car, about twice a minute.
    const span = W + 60;
    const pass = (t % 34) / 7;
    if (pass < 1) ctx.drawImage(s.car, Math.round(span - pass * (span + 30)) - 30, 234);
    // A few petals from the tree, going the way of the wind.
    ctx.fillStyle = '#f7c4c2';
    for (const p of s.drift) {
      const y = (p.y + t * p.v) % H;
      const x = ((p.x - t * 9 + Math.sin(t / 4 + p.phase * 9) * p.sway) % W + W) % W;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    // Birds cross the sun now and then.
    const birds = (t % 47) / 15;
    if (birds < 1) {
      ctx.fillStyle = '#4c3550';
      const flap = Math.floor(t * 3) % 2;
      for (const [dx, dy] of [[0, 0], [11, 3], [20, -2], [30, 4]]) {
        const x = Math.round(birds * (W + 60)) - 30 + dx;
        const y = 70 + dy + Math.round(wave(t, 6) * 3);
        ctx.fillRect(x - 2, y - flap, 2, 1);
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(x + 1, y - flap, 2, 1);
      }
    }
  },
};

export default roseStreet;
