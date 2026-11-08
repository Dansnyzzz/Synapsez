/**
 * The title creatures on the writing box (owner, 2026-11-08): drawn the same way every
 * time, never off their 64-pixel square, never in a colour nobody chose, every title
 * resolving to a creature or to the whale, and a finished turn's moment playing whole
 * loops so it hands back to idle on the resting pose.
 *
 *   node test/mascots.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'mascots-test-key';
process.env.SESSION_SECRET ||= 'mascots-test-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-mascots-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const dir = path.join(import.meta.dirname, '..', 'public', 'js', 'mascots');
const engine = await import('../public/js/mascots/engine.js');
const registry = await import('../public/js/mascots/index.js');
const { en } = await import('../public/js/locales/en.js');
const { vi } = await import('../public/js/locales/vi.js');
const { TITLES, awardId, SCOPES } = await import('../server/themes.js');

const creatures = await Promise.all(registry.DRAWN_IDS.map(async (id) => (await import(`../public/js/mascots/${id}.js`)).default));

section('the clock');
{
  check('one frame time for every state', engine.FRAME_MS === 80, String(engine.FRAME_MS));
  const want = { idle: 48, thinking: 48, typing: 48, conducting: 48, notification: 32, error: 48, happy: 52, sleeping: 64 };
  check('the eight states and their lengths', JSON.stringify(engine.FRAMES) === JSON.stringify(want), JSON.stringify(engine.FRAMES));
  check('the same eight the whale has', JSON.stringify(engine.STATES) === JSON.stringify((await import('../public/js/mascot.js')).MASCOT_STATES));
  check('a held frame for each state, inside it', engine.STATES.every((s) => Number.isInteger(engine.STILL_FRAMES[s]) && engine.STILL_FRAMES[s] >= 0 && engine.STILL_FRAMES[s] < engine.FRAMES[s]));
}

section('a moment plays whole loops');
{
  for (const state of ['happy', 'error']) {
    const hold = engine.holdMs(state);
    check(`${state} is held for exactly two loops`, hold === 2 * engine.FRAMES[state] * engine.FRAME_MS, String(hold));
    check(`  its last frame is the loop's last`, engine.frameAt(state, hold - 1) === engine.FRAMES[state] - 1);
    check(`  and after it, the resting first frame, not a third loop`, engine.frameAt(state, hold) === 0 && engine.frameAt(state, hold * 3) === 0);
  }
  check('a state that is not a moment loops for ever', engine.holdMs('idle') === Infinity && engine.frameAt('idle', engine.FRAMES.idle * engine.FRAME_MS) === 0 && engine.frameAt('thinking', 50 * engine.FRAME_MS) === 2);
}

section('every creature, every state, every frame');
for (const creature of creatures) {
  const allowed = new Set([...Object.values(creature.palette), ...Object.values(engine.ACCENTS)]);
  const outside = [];
  const strange = new Set();
  const unsteady = [];
  const notWhole = [];
  let frames = 0;
  for (const state of engine.STATES) {
    for (let f = 0; f < engine.FRAMES[state]; f += 1) {
      frames += 1;
      const a = engine.framePixels(creature, state, f);
      const b = engine.framePixels(creature, state, f);
      if (a.clipped) outside.push(`${state}:${f}`);
      if (a.print() !== b.print()) unsteady.push(`${state}:${f}`);
      for (const colour of a.colours()) if (!allowed.has(colour)) strange.add(colour);
      // What reaches the canvas: whole pixels, inside the square, in the creature's colours.
      const calls = [];
      const ctx = { fillStyle: '', clearRect: (...r) => calls.push(['clear', ...r]), fillRect: (...r) => calls.push([ctx.fillStyle, ...r]) };
      engine.drawFrame(ctx, creature, state, f);
      if (calls[0]?.[0] !== 'clear') notWhole.push(`${state}:${f} not cleared first`);
      for (const [colour, x, y, w, h] of calls.slice(1)) {
        if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || x + w > 64 || y + h > 64) notWhole.push(`${state}:${f} ${x},${y},${w},${h}`);
        if (!allowed.has(colour)) strange.add(colour);
      }
    }
  }
  section(`  ${creature.id}`);
  check(`all ${frames} frames stay inside 64 by 64`, outside.length === 0, outside.slice(0, 8).join(' '));
  check('the same frame is the same picture', unsteady.length === 0, unsteady.slice(0, 8).join(' '));
  check('every colour is its own or one every prop shares', strange.size === 0, [...strange].join(' '));
  check('a canvas gets whole pixels only', notWhole.length === 0, notWhole.slice(0, 4).join(' | '));
  check('its shadow is its outline, faint', creature.palette.shadow === `${creature.palette.outline}38`, creature.palette.shadow);
  const rest = engine.framePixels(creature, 'idle', 0).print();
  check('a moment starts on the resting pose, so the change back to idle is not seen', engine.framePixels(creature, 'happy', 0).print() === rest && engine.framePixels(creature, 'error', 0).print() === rest);
  const idle = new Set(Array.from({ length: engine.FRAMES.idle }, (_, f) => engine.framePixels(creature, 'idle', f).print()));
  check('idle moves', idle.size >= 4, String(idle.size));
  // Any 450 ms of idle shows a change: what the browser test watches for.
  const steady = [];
  for (let f = 0; f < engine.FRAMES.idle; f += 1) {
    const span = new Set(Array.from({ length: 6 }, (_, k) => engine.framePixels(creature, 'idle', (f + k) % engine.FRAMES.idle).print()));
    if (span.size < 2) steady.push(f);
  }
  check('  never still for six frames running', steady.length === 0, steady.join(' '));
  const same = engine.STATES.filter((s) => s !== 'idle' && engine.framePixels(creature, s, engine.STILL_FRAMES[s]).print() === rest);
  check('each state held still says something idle does not', same.length === 0, same.join(' '));
  check('it says which pet it is, in both languages', !!en[`ranking.pet.${creature.pet}.name`] && !!vi[`ranking.pet.${creature.pet}.name`], creature.pet);
  const small = new engine.Pixels();
  creature.mini(small, 30, 40, 0);
  creature.mini(small, 30, 40, 7);
  let box = null;
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) if (small.at(x, y)) box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y) } : { x0: x, x1: x, y0: y, y1: y };
  check('its mini stands on its spot, small', !!box && box.y1 <= 40 && box.x1 - box.x0 <= 15 && box.y1 - box.y0 <= 11, JSON.stringify(box));
}

section('drawn from nothing but its inputs');
{
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'stage.js' && f !== 'index.js');
  const loose = files.filter((f) => /Math\.random|Date\.now|new Date|performance\.now|\bdocument\b|\bwindow\b/.test(fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  check('no chance, no clock and no page in the engine, the props or a creature', loose.length === 0, loose.join(', '));
  check('every creature file is in the registry', files.filter((f) => !['engine.js', 'props.js', 'pixels.js'].includes(f)).every((f) => registry.DRAWN_IDS.includes(f.replace(/\.js$/, ''))), files.join(', '));
}

section('every title the server can give has a creature, or the whale');
{
  const ids = [...TITLES.map((t) => t.id), 'rank-1', 'rank-2', 'rank-3'];
  for (const board of ['tokens', 'spend']) {
    for (const scope of SCOPES) for (const rank of [1, 2, 3]) ids.push(awardId(board, scope, scope === 'year' ? '2026' : '2026-Q4', rank));
  }
  const lost = ids.filter((id) => !registry.creatureFor(id));
  check('each one names an animal', lost.length === 0, lost.join(', '));
  check('a place wears its place, whatever the board or the period', registry.creatureFor(awardId('spend', 'year', '2027', 1)) === 'koi-dragon' && registry.creatureFor('rank-3') === 'bronze-dolphin' && registry.creatureFor(awardId('tokens', 'quarter', '2026-Q4', 2)) === 'silver-marlin');
  check('no title, or one it does not know, is the whale', registry.creatureFor(null) === null && registry.creatureFor('') === null && registry.creatureFor('top:tokens:week:2026:1') === null && registry.creatureFor('rank-4') === null);
  const loaded = await Promise.all(ids.map((id) => registry.loadCreature(id)));
  const drawn = ids.filter((id, i) => loaded[i]);
  check('the drawn ones load, and the rest stand in as the whale', drawn.every((id, i) => registry.isDrawn(registry.creatureFor(id))) && ids.every((id, i) => !!loaded[i] === registry.isDrawn(registry.creatureFor(id))));
  check('newcomer, ten million tokens and a thousand spent are drawn', (await registry.loadCreature('newcomer'))?.id === 'minnow' && (await registry.loadCreature('tokens-10m'))?.id === 'electric-ray' && (await registry.loadCreature('spend-1000'))?.id === 'gold-whale');
  check('one not drawn yet is the whale', (await registry.loadCreature('tokens-1m')) === null && (await registry.loadCreature(null)) === null);
}

console.log(failures === 0 ? '\n\x1b[32mThe title creatures hold.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
