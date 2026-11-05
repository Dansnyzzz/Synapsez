/**
 * Themes, ranking and titles (owner, 2026-11-04): who holds what, who is on a board,
 * and what a board says about them. The contract is
 * docs/superpowers/specs/2026-11-04-themes-ranking-contract.md; the drawing is held to
 * the same ids here too.
 *
 *   node test/themes.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'themes-test-key';
process.env.SESSION_SECRET ||= 'themes-test-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-themes-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const refused = async (promise, status) => promise.then(() => null, (err) => err?.status === status);

const { initStore } = await import('../server/store/index.js');
const themes = await import('../server/themes.js');
const { setPrefs, getPrefs } = await import('../server/settings.js');
const { withMarkup } = await import('../server/pricing.js');
const { hashPassword } = await import('../server/crypto.js');
const { createApp } = await import('../server/app.js');
const { ranking, listThemes, selectTheme, listTitles, equipTitle, settleClosed, settlePeriod, rankBoard, periodRange, closedPeriods, periodKeys, cleanBadge, rewardThemes, titleInfo, setThemeBadge, giveTheme, takeTheme, adminThemes, __testing } = themes;

section('periods');
{
  check('a month runs from its first to the next', periodRange('month', '2026-11')?.to.toISOString() === '2026-12-01T00:00:00.000Z');
  check('a year crosses into the next', periodRange('year', '2026')?.to.toISOString() === '2027-01-01T00:00:00.000Z');
  check('nonsense is no period', periodRange('month', '2026-13') === null && periodRange('month', "x' OR 1=1") === null && periodRange('week', '2026') === null);
  check('nothing has closed while ranking is in its first month', closedPeriods(new Date('2026-11-20T00:00:00Z')).length === 0);
  check('a month closes when the next begins', closedPeriods(new Date('2026-12-01T00:00:00Z')).map((p) => p.key).join() === '2026-11');
  const later = closedPeriods(new Date('2027-01-02T00:00:00Z')).map((p) => `${p.scope}:${p.key}`).join();
  check('and a year when the next year does', later === 'month:2026-11,month:2026-12,year:2026', later);
  check('the picker starts at the current period', periodKeys('month', new Date('2027-01-02T00:00:00Z')).join() === '2027-01,2026-12,2026-11');
  check('and it never lists a time before ranking began', !periodKeys('month', new Date('2026-11-20T00:00:00Z')).includes('2026-10'));
}

section('a board');
{
  const rows = [
    { id: 'b', tokens: 100, cost: 0, first_at: '2026-11-02' },
    { id: 'a', tokens: 100, cost: 1, first_at: '2026-11-01' },
    { id: 'c', tokens: 500, cost: 0.5, first_at: '2026-11-03' },
    { id: 'z', tokens: 0, cost: 0, first_at: '2026-11-03' },
  ];
  check('highest first, a tie to whoever got there first', rankBoard(rows, 'tokens').map((r) => r.id).join() === 'c,a,b');
  check('nobody is on a board with nothing to show for it', !rankBoard(rows, 'spend').some((r) => r.id === 'z' || r.id === 'b'));
  check('spending is what was charged', rankBoard(rows, 'spend')[0].value === withMarkup(1));
}

section('a badge an administrator sets');
{
  check('kinds outside the list are refused', (() => { try { cleanBadge({ kind: 'gold' }); return false; } catch { return true; } })());
  check('only the top kinds carry a date', cleanBadge({ kind: 'achievement', month: 3, year: 2026 }).year === null);
  check('a named month needs its year', (() => { try { cleanBadge({ kind: 'top_month', month: 1 }); return false; } catch (e) { return /year/.test(e.message); } })());
  check('month 13 is no month', (() => { try { cleanBadge({ kind: 'top_month', month: 13, year: 2026 }); return false; } catch { return true; } })());
  const any = cleanBadge({ kind: 'top_month', month: '', year: '' });
  check('blank means any', any.month === null && any.year === null);
  check('a named one is kept', cleanBadge({ kind: 'top_month', month: '1', year: '2026' }).month === 1);
  const badges = new Map([
    ['sakura-crossing', { kind: 'top_month', month: null, year: null }],
    ['aurora-peak', { kind: 'top_month', month: 11, year: 2026 }],
    ['rose-street', { kind: 'top_year', month: null, year: null }],
  ]);
  check('a theme naming the month takes it over', rewardThemes(badges, 'month', '2026-11').join() === 'aurora-peak');
  check('any other month goes to the standing prize', rewardThemes(badges, 'month', '2026-12').join() === 'sakura-crossing');
  check('a year goes to the year’s', rewardThemes(badges, 'year', '2026').join() === 'rose-street');
}

section('a title says what it is');
{
  const award = titleInfo('top:tokens:month:2026-11:1');
  check('an award is read from its id', award?.board === 'tokens' && award?.scope === 'month' && award?.key === '2026-11' && award?.rank === 1);
  check('rank 4 was never awarded', titleInfo('top:tokens:month:2026-11:4') === null);
  check('nor is anything else a title', titleInfo('<img src=x>') === null && titleInfo(null) === null);
  check('a catalogue title', titleInfo('tokens-1m')?.kind === 'catalog');
}

section('the drawing and the rules name the same themes');
{
  const scenes = path.resolve('public/js/scenes.js');
  if (fs.existsSync(scenes)) {
    const source = fs.readFileSync(scenes, 'utf8');
    const missing = themes.THEMES.filter((t) => t.id !== 'default' && !new RegExp(`^\\s*('${t.id}'|${t.id})[:,]`, 'm').test(source)).map((t) => t.id);
    check('every theme has a scene', !missing.length, missing.join());
  }
  const locale = fs.readFileSync('public/js/locales/vi.js', 'utf8');
  const unnamed = themes.THEMES.filter((t) => !locale.includes(t.id)).map((t) => t.id);
  check('and every theme has words', !unnamed.length, unnamed.join());
}

const store = await initStore();
const make = (id, role = 'user') => store.createUser({ id, email: `${id}@example.com`, name: id[0].toUpperCase() + id.slice(1), username: id, passwordHash: 'x', role });
const owner = await make('owner', 'admin');
const alice = await make('alice');
const bob = await make('bob');
const carol = await make('carol');
const dave = await make('dave');
let usageId = 0;
const spend = (user, tokens, cost) => store.recordUsage(user.id, { id: `e${(usageId += 1)}`, chatId: null, model: 'm', inputTokens: tokens, outputTokens: 0, costUsd: cost, role: 'turn' });
await spend(owner, 9_999_999, 99);
await spend(alice, 1000, 1);
await spend(bob, 2000, 0.5);
await spend(carol, 500, 3);
await spend(dave, 100, 0);

const NOW = new Date();
const thisMonth = themes.periodKey('month', NOW);
const nextMonth = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 2));

section('this month’s boards');
{
  const board = await ranking(alice);
  check('tokens, highest first', board.tokens.map((r) => r.name).join() === 'bob,alice,carol', JSON.stringify(board.tokens));
  check('spending, highest first', board.spend.map((r) => r.name).join() === 'carol,alice,bob', JSON.stringify(board.spend));
  check('at most three', board.tokens.length === 3);
  check('an administrator is on neither board', !JSON.stringify(board).includes('owner'));
  check('no email is in it', !JSON.stringify(board).includes('@'));
  check('my own row is marked', board.tokens.find((r) => r.name === 'alice')?.isMe === true);
  check('my own place is said', board.me.tokens.rank === 2 && board.me.spend.rank === 2 && board.me.excluded === false);
  check('it is the current period, still open', board.key === thisMonth && board.settled === false && !!board.closes);
  const low = await ranking(dave);
  check('someone off the top three still learns their place', low.me.tokens.rank === 4 && !low.tokens.some((r) => r.isMe));
  check('and someone with no spending has none', low.me.spend.rank === null);
  const admin = await ranking(owner);
  check('an administrator is told they are not ranked', admin.me.excluded === true && admin.me.tokens.rank === null);
  check('a period that does not exist is refused', await refused(ranking(alice, { key: '1999-01' }), 400));
  check('a scope that does not exist is refused', await refused(ranking(alice, { scope: 'week' }), 400));
  const year = await ranking(alice, { scope: 'year' });
  check('the year’s board counts the same usage', year.tokens[0].name === 'bob');
  await setPrefs(bob.id, { rankAnonymous: true });
  const hidden = await ranking(alice);
  check('someone who asked is shown without a name', hidden.tokens[0].name === null && hidden.tokens[0].value === 2000);
  check('and they can still see it is them', (await ranking(bob)).tokens[0].isMe === true);
  check('their preference is reported back', (await ranking(bob)).me.anonymous === true);
  await setPrefs(bob.id, { rankAnonymous: false });
}

section('holding themes');
{
  const page = await listThemes(alice);
  const held = page.themes.filter((t) => t.owned).map((t) => t.id);
  check('everyone holds the default', held.join() === 'default', held.join());
  check('it is the one in use', page.selected === 'default');
  check('locked themes follow', page.themes[0].id === 'default' && page.themes.length === themes.THEMES.length);
  check('a locked achievement says what earns it', page.themes.find((t) => t.id === 'cloud-drift')?.needs?.tokens === 100_000);
  check('a prize has no such number', page.themes.find((t) => t.id === 'sakura-crossing')?.needs === null);
  check('the catalogue’s badges show', page.themes.find((t) => t.id === 'rose-street')?.badge.kind === 'top_year');
  check('a theme one does not hold cannot be put on', await refused(selectTheme(alice, 'lagoon'), 403));
  check('nor one that does not exist', await refused(selectTheme(alice, 'nope'), 400));
  await spend(alice, 150_000, 0);
  const earned = await listThemes(alice);
  check('usage earns it the next time one looks', earned.themes[0].id === 'cloud-drift' && earned.themes[0].owned === true, earned.themes.slice(0, 2).map((t) => t.id).join());
  check('the newest comes first, ahead of the default', earned.themes[1].id === 'default');
  check('and it says why it was given', earned.themes[0].grant?.kind === 'achievement');
  check('it can be worn', (await selectTheme(alice, 'cloud-drift')).selected === 'cloud-drift' && (await listThemes(alice)).selected === 'cloud-drift');
  await takeTheme('cloud-drift', alice.id);
  await store.grantTheme(alice.id, 'lagoon', { kind: 'exclusive_event' });
  await selectTheme(alice, 'lagoon');
  await takeTheme('lagoon', alice.id);
  const fell = await listThemes(alice);
  check('a theme taken back falls to the default', fell.selected === 'default');
  const admin = await listThemes(owner);
  check('an administrator holds them all', admin.isAdmin && admin.themes.every((t) => t.owned));
  check('and may wear any', (await selectTheme(owner, 'aurora-peak')).selected === 'aurora-peak');
  check('the default cannot be given or taken', await refused(giveTheme('default', alice.id), 400));
  check('nor can a theme go to nobody', await refused(giveTheme('lagoon', 'no-such-account'), 404));
  await giveTheme('aurora-peak', dave.id);
  const gift = (await listThemes(dave)).themes[0];
  check('a theme given by hand is held, and carries its badge', gift.id === 'aurora-peak' && gift.grant.kind === 'exclusive_event');
  check('the list says how many hold it', (await adminThemes()).themes.find((t) => t.id === 'aurora-peak')?.holders === 1);
  check('the default stays without a badge', await refused(setThemeBadge('default', { kind: 'achievement' }, owner.id), 400));
  await setThemeBadge('lagoon', { kind: 'top_month', month: 1, year: 2026 }, owner.id);
  check('an administrator’s badge is what everyone sees', (await listThemes(alice)).themes.find((t) => t.id === 'lagoon')?.badge.month === 1);
  await store.setThemeBadge('lagoon', { kind: 'achievement', month: null, year: null }, owner.id);
}

section('titles');
{
  const page = await listTitles(alice);
  check('everyone has something to wear', page.titles.some((t) => t.id === 'newcomer' && t.owned));
  check('one earned by usage comes in', !page.titles.find((t) => t.id === 'spend-10')?.owned);
  check('a locked one says what earns it', page.titles.find((t) => t.id === 'tokens-1m')?.needs?.tokens === 1_000_000);
  check('one not held cannot be worn', await refused(equipTitle(alice, 'tokens-1b'), 403));
  check('nor one that does not exist', await refused(equipTitle(alice, 'emperor'), 400));
  await equipTitle(alice, 'newcomer');
  check('it shows on the board', (await ranking(bob)).tokens.find((r) => r.name === 'alice')?.title?.id === 'newcomer');
  check('and can be taken off', (await equipTitle(alice, null)).equipped === null && (await listTitles(alice)).equipped === null);
  check('an administrator can wear any from the catalogue', (await equipTitle(owner, 'tokens-1b')).equipped === 'tokens-1b');
  await equipTitle(alice, 'newcomer');
}

section('a month closes');
{
  __testing.reset();
  await settleClosed({ now: nextMonth });
  const after = (await store.listSettledPeriods()).map((p) => `${p.scope}:${p.period}`);
  check('the month is marked', after.includes(`month:${thisMonth}`), after.join());
  const held = async (user) => (await store.listUserThemes(user.id)).map((t) => t.theme_id);
  check('the top three of a board get the month’s prize', (await held(bob)).includes('sakura-crossing') && (await held(alice)).includes('sakura-crossing') && (await held(carol)).includes('sakura-crossing'));
  check('fourth place does not', !(await held(dave)).includes('sakura-crossing'));
  check('an administrator does not', !(await held(owner)).includes('sakura-crossing'));
  const titles = (await store.listUserTitles(alice.id)).map((t) => t.title_id);
  check('and first place wears it', titles.includes(`top:tokens:month:${thisMonth}:1`), titles.join());
  const seconds = (await store.listUserTitles(bob.id)).map((t) => t.title_id);
  check('as second place wears its own', seconds.includes(`top:tokens:month:${thisMonth}:2`), seconds.join());
  const grant = (await listThemes(bob)).themes.find((t) => t.id === 'sakura-crossing');
  check('it says which month it was for', grant?.grant?.kind === 'top_month' && grant?.grant?.month === NOW.getUTCMonth() + 1 && grant?.grant?.year === NOW.getUTCFullYear(), JSON.stringify(grant?.grant));
  await settlePeriod('month', thisMonth);
  check('settling twice changes nothing', (await store.settledBoard('month', thisMonth)).length === 6);
  await spend(dave, 99_999_999, 999);
  const closed = await ranking(alice, { key: thisMonth, now: nextMonth });
  check('a closed board does not move, whatever comes in late', closed.settled === true && closed.tokens[0].name === 'alice' && !closed.tokens.some((r) => r.name === 'dave'), JSON.stringify(closed.tokens));
  await store.deleteUser(bob.id);
  const gone = await ranking(alice, { key: thisMonth, now: nextMonth });
  check('an account deleted leaves the board and takes its name', !gone.tokens.some((r) => r.name === 'bob') && !gone.spend.some((r) => r.name === 'bob'));
  check('and the others keep their rank', gone.tokens.find((r) => r.name === 'carol')?.rank === 3);
}

section('a theme an administrator took back stays taken');
{
  // The usage that earned it is still there, so the next look at the page would earn it again.
  const erin = await make('erin');
  await spend(erin, 150_000, 0);
  const holds = async () => (await listThemes(erin)).themes.find((t) => t.id === 'cloud-drift')?.owned === true;
  check('(earned by usage)', await holds());
  await takeTheme('cloud-drift', erin.id);
  check('taken back, it is gone', !(await holds()));
  check('and looking again does not earn it back', !(await holds()));
  check('the holders list agrees', !(await store.themeHolders('cloud-drift')).some((row) => row.id === erin.id));
  const counted = (await store.themeHolderCounts()).find((row) => row.theme_id === 'cloud-drift')?.holders || 0;
  check('and the count', counted === (await store.themeHolders('cloud-drift')).length, String(counted));
  await giveTheme('cloud-drift', erin.id);
  check('an administrator can give it back by hand', await holds());
}

section('one period that cannot be settled does not take the pages with it');
{
  __testing.reset();
  let tries = 0;
  const broken = new Proxy(store, {
    get(target, prop) {
      if (prop === 'listSettledPeriods') {
        return async () => {
          tries += 1;
          throw new Error('the database went away');
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await settleClosed({ store: broken, now: nextMonth });
  check('the failure is swallowed, and logged', tries === 1);
  await settleClosed({ store: broken, now: nextMonth });
  check('and the next read does not pay for it again', tries === 1, String(tries));
  __testing.reset();
}

section('a lifetime outlasts the rows it was added from');
{
  const before = await store.lifetimeUsage(dave.id);
  await store.pruneUsageEvents(-1);
  const after = await store.lifetimeUsage(dave.id);
  check('pruning does not take usage off the total', before.tokens > 0 && after.tokens === before.tokens && after.cost === before.cost, `${before.tokens} → ${after.tokens}`);
  await store.pruneUsageEvents(-1);
  check('nor does it count twice', (await store.lifetimeUsage(dave.id)).tokens === before.tokens);
}

section('over HTTP');
{
  const server = createApp().listen(5197);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:5197';
  const call = async (cookie, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const password = 'a-sufficiently-long-password';
  await store.createUser({ id: 'u-http', email: 'http@example.com', name: 'Http', passwordHash: await hashPassword(password), role: 'user' });
  await store.createUser({ id: 'u-boss', email: 'boss@example.com', name: 'Boss', passwordHash: await hashPassword(password), role: 'admin' });
  await store.setAdminPermissions('u-boss', ['feedback']);
  const me = (await call('', 'POST', '/api/login', { email: 'http@example.com', password })).cookie;
  const boss = (await call('', 'POST', '/api/login', { email: 'boss@example.com', password })).cookie;

  for (const [method, url] of [['GET', '/api/themes'], ['PUT', '/api/themes/selected'], ['GET', '/api/ranking'], ['GET', '/api/titles'], ['PUT', '/api/titles/equipped'], ['GET', '/api/admin/themes']]) {
    check(`${method} ${url} needs signing in`, (await call('', method, url)).status === 401);
  }
  check('the page reads', (await call(me, 'GET', '/api/themes')).json?.selected === 'default');
  check('a locked theme is refused', (await call(me, 'PUT', '/api/themes/selected', { id: 'lagoon' })).status === 403);
  check('an unknown one too', (await call(me, 'PUT', '/api/themes/selected', { id: 'x' })).status === 400);
  check('the default is always allowed', (await call(me, 'PUT', '/api/themes/selected', { id: 'default' })).json?.selected === 'default');
  check('a bad period says so', (await call(me, 'GET', '/api/ranking?key=nope')).status === 400);
  check('titles read', Array.isArray((await call(me, 'GET', '/api/titles')).json?.titles));
  check('a title has to be a string or null', (await call(me, 'PUT', '/api/titles/equipped', { id: 5 })).status === 400);
  check('none is allowed', (await call(me, 'PUT', '/api/titles/equipped', { id: null })).json?.equipped === null);

  await call(me, 'PUT', '/api/prefs', { sceneTheme: 'aurora-peak', equippedTitle: 'tokens-1b', mascot: 'happy', rankAnonymous: true });
  const prefs = await getPrefs('u-http');
  check('preferences cannot put on what one does not hold', prefs.sceneTheme !== 'aurora-peak' && prefs.equippedTitle !== 'tokens-1b', JSON.stringify([prefs.sceneTheme, prefs.equippedTitle]));
  check('the mascot and staying anonymous are saved', prefs.mascot === 'happy' && prefs.rankAnonymous === true);
  check('a mascot that does not exist is not', (await call(me, 'PUT', '/api/prefs', { mascot: 'dragon' })).status >= 400);

  check('someone who is not an administrator cannot see the list', (await call(me, 'GET', '/api/admin/themes')).status === 403);
  check('an administrator without the permission cannot either', (await call(boss, 'GET', '/api/admin/themes')).status === 403);
  check('nor set a badge', (await call(boss, 'PUT', '/api/admin/themes/lagoon', { kind: 'none' })).status === 403);
  check('nor give a theme', (await call(boss, 'POST', '/api/admin/themes/lagoon/holders', { userId: 'u-http' })).status === 403);
  check('nor take one', (await call(boss, 'DELETE', '/api/admin/themes/lagoon/holders/u-http')).status === 403);
  await store.setAdminPermissions('u-boss', ['themes']);
  const boss2 = (await call('', 'POST', '/api/login', { email: 'boss@example.com', password })).cookie;
  check('given the permission they can', (await call(boss2, 'GET', '/api/admin/themes')).json?.themes?.length === themes.THEMES.length);
  check('a badge is checked', (await call(boss2, 'PUT', '/api/admin/themes/lagoon', { kind: 'gold' })).status === 400);
  check('and saved', (await call(boss2, 'PUT', '/api/admin/themes/lagoon', { kind: 'exclusive_event' })).json?.badge?.kind === 'exclusive_event');
  check('a theme can be given', (await call(boss2, 'POST', '/api/admin/themes/lagoon/holders', { userId: 'u-http' })).status === 200);
  check('and it arrives', (await call(me, 'GET', '/api/themes')).json?.themes?.[0]?.id === 'lagoon');
  const holders = await call(boss2, 'GET', '/api/admin/themes/lagoon/holders');
  check('who holds it is listed, by name', holders.json?.holders?.[0]?.name === 'Http' && !JSON.stringify(holders.json).includes('@'), JSON.stringify(holders.json));
  const people = await call(boss2, 'GET', '/api/admin/themes/people');
  check('the search box gets names and no emails', people.json?.people?.some((p) => p.id === 'u-http') && !JSON.stringify(people.json).includes('@'));
  check('and no administrators: they hold them all', !people.json?.people?.some((p) => p.id === 'u-boss'));
  check('someone without the permission gets neither', (await call(me, 'GET', '/api/admin/themes/people')).status === 403 && (await call(me, 'GET', '/api/admin/themes/lagoon/holders')).status === 403);
  check('and be taken back', (await call(boss2, 'DELETE', '/api/admin/themes/lagoon/holders/u-http')).status === 200);
  await new Promise((r) => server.close(r));
}

removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mThemes, boards and titles hold.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
