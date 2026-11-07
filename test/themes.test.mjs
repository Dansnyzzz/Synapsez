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
  check('a quarter runs from its first month to the next quarter', periodRange('quarter', '2027-Q1')?.from.toISOString() === '2027-01-01T00:00:00.000Z' && periodRange('quarter', '2027-Q1')?.to.toISOString() === '2027-04-01T00:00:00.000Z');
  check('the last quarter crosses into the next year', periodRange('quarter', '2027-Q4')?.to.toISOString() === '2028-01-01T00:00:00.000Z');
  check('a year crosses into the next', periodRange('year', '2026')?.to.toISOString() === '2027-01-01T00:00:00.000Z');
  check('nothing before ranking began counts, in the quarter or the year it began in', periodRange('quarter', '2026-Q4')?.from.toISOString() === '2026-11-01T00:00:00.000Z' && periodRange('year', '2026')?.from.toISOString() === '2026-11-01T00:00:00.000Z');
  check('nonsense is no period', periodRange('quarter', '2026-Q5') === null && periodRange('quarter', "x' OR 1=1") === null && periodRange('month', '2026-11') === null);
  check('nothing has closed while ranking is in its first quarter', closedPeriods(new Date('2026-12-20T00:00:00Z')).length === 0);
  const later = closedPeriods(new Date('2027-01-02T00:00:00Z')).map((p) => `${p.scope}:${p.key}`).join();
  check('a quarter closes when the next begins, and a year when the next year does', later === 'quarter:2026-Q4,year:2026', later);
  check('the picker starts at the current period', periodKeys('quarter', new Date('2027-04-02T00:00:00Z')).join() === '2027-Q2,2027-Q1,2026-Q4');
  check('and it never lists a time before ranking began', !periodKeys('quarter', new Date('2026-11-20T00:00:00Z')).includes('2026-Q3'));
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
  check('only the top kinds carry a date', cleanBadge({ kind: 'achievement', quarter: 3, year: 2026 }).year === null);
  check('a month is no longer a kind', (() => { try { cleanBadge({ kind: 'top_month', year: 2026 }); return false; } catch { return true; } })());
  check('a named quarter needs its year', (() => { try { cleanBadge({ kind: 'top_quarter', quarter: 1 }); return false; } catch (e) { return /year/.test(e.message); } })());
  check('quarter 5 is no quarter', (() => { try { cleanBadge({ kind: 'top_quarter', quarter: 5, year: 2026 }); return false; } catch { return true; } })());
  const any = cleanBadge({ kind: 'top_quarter', quarter: '', year: '' });
  check('blank means any', any.quarter === null && any.year === null);
  check('a named one is kept', cleanBadge({ kind: 'top_quarter', quarter: '1', year: '2026' }).quarter === 1);
  const badges = new Map([
    ['sakura-crossing', { kind: 'top_quarter', quarter: null, year: null }],
    ['aurora-peak', { kind: 'top_quarter', quarter: 4, year: 2026 }],
    ['rose-street', { kind: 'top_year', quarter: null, year: null }],
  ]);
  check('a theme naming the quarter takes it over', rewardThemes(badges, 'quarter', '2026-Q4').join() === 'aurora-peak');
  check('any other quarter goes to the standing prize', rewardThemes(badges, 'quarter', '2027-Q1').join() === 'sakura-crossing');
  check('a year goes to the year’s', rewardThemes(badges, 'year', '2026').join() === 'rose-street');
}

section('every quarter and year to the end of 2027 has its own theme, and every title its own');
{
  const prizes = await themes.themeBadges({ listThemeBadges: async () => [] });
  for (const key of ['2026-Q4', '2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4']) {
    const won = rewardThemes(prizes, 'quarter', key);
    check(`${key} has one theme of its own`, won.length === 1 && !['sakura-crossing'].includes(won[0]), won.join());
  }
  for (const key of ['2026', '2027']) {
    const won = rewardThemes(prizes, 'year', key);
    check(`${key} has one theme of its own`, won.length === 1 && won[0] !== 'rose-street', won.join());
  }
  check('after that the standing prizes carry on', rewardThemes(prizes, 'quarter', '2028-Q1').join() === 'sakura-crossing' && rewardThemes(prizes, 'year', '2028').join() === 'rose-street');
  const won = ['2026-Q4', '2027-Q1', '2027-Q2', '2027-Q3', '2027-Q4'].flatMap((key) => rewardThemes(prizes, 'quarter', key));
  check('no two quarters share one', new Set(won).size === won.length);
  const earned = themes.THEMES.filter((t) => t.tokens || t.spend);
  for (const title of themes.TITLES.filter((t) => t.tokens || t.spend)) {
    check(`a title earned at ${title.tokens || `$${title.spend}`} has a theme earned at the same mark`, earned.some((t) => (title.tokens && t.tokens === title.tokens) || (title.spend && t.spend === title.spend)));
  }
}

section('a title says what it is');
{
  const award = titleInfo('top:tokens:quarter:2026-Q4:1');
  check('an award is read from its id', award?.board === 'tokens' && award?.scope === 'quarter' && award?.key === '2026-Q4' && award?.rank === 1);
  check('rank 4 was never awarded', titleInfo('top:tokens:quarter:2026-Q4:4') === null);
  check('nor a month, now', titleInfo('top:tokens:month:2026-11:1') === null);
  check('nor is anything else a title', titleInfo('<img src=x>') === null && titleInfo(null) === null);
  check('a catalogue title', titleInfo('tokens-1m')?.kind === 'catalog');
}

section('the drawing and the rules name the same themes');
{
  const source = fs.readFileSync('public/js/scenes/catalog.js', 'utf8');
  const painted = themes.THEMES.filter((t) => t.id !== 'default');
  const uncatalogued = painted.filter((t) => !new RegExp(`^\\s*('${t.id}'|${t.id})[:,]`, 'm').test(source)).map((t) => t.id);
  check('every theme is in the catalogue', !uncatalogued.length, uncatalogued.join());
  const unpainted = painted.filter((t) => !fs.existsSync(`public/js/scenes/${t.id}.js`)).map((t) => t.id);
  check('and has a scene', !unpainted.length, unpainted.join());
  const noStill = painted.filter((t) => !fs.existsSync(`public/assets/scenes/${t.id}.webp`)).map((t) => t.id);
  check('and a picture for its tile (npm run scenes:stills)', !noStill.length, noStill.join());
  const big = painted.filter((t) => fs.existsSync(`public/assets/scenes/${t.id}.webp`) && fs.statSync(`public/assets/scenes/${t.id}.webp`).size > 60 * 1024).map((t) => t.id);
  check('small enough for a page of them to load quickly', !big.length, big.join());
  const sources = painted.filter((t) => fs.existsSync(`public/js/scenes/${t.id}.js`)).map((t) => [t.id, fs.readFileSync(`public/js/scenes/${t.id}.js`, 'utf8')]);
  const pagely = sources.filter(([, code]) => /\b(?:window|document)\./.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).map(([id]) => id);
  check('and it can be drawn in the worker: no page in it', !pagely.length, pagely.join());
  const pets = fs.readFileSync('public/js/ranking-panel.js', 'utf8');
  const creatures = [...new Set([...pets.matchAll(/'(pet-[a-z-]+)'/g)].map((m) => m[1]))];
  const petCode = fs.readFileSync('public/js/scenes/pets.js', 'utf8');
  check('every title has a creature, in the catalogue and drawn', creatures.length === 11 && creatures.every((id) => source.includes(`'${id}'`) && petCode.includes(`'${id}'`)), creatures.join());
  check('a different one for each', new Set(creatures).size === 11);
  const locale = fs.readFileSync('public/js/locales/vi.js', 'utf8');
  const unnamed = themes.THEMES.filter((t) => !locale.includes(t.id)).map((t) => t.id);
  check('and every theme has words', !unnamed.length, unnamed.join());
}

const store = await initStore();
// The name is not the username or the email's first half: those never reach a board.
const make = (id, role = 'user') => store.createUser({ id, email: `${id}.mail@example.com`, name: id, username: `${id}-login`, passwordHash: 'x', role });
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
const thisQuarter = themes.periodKey('quarter', NOW);
const nextQuarter = new Date(Date.UTC(NOW.getUTCFullYear(), (Math.floor(NOW.getUTCMonth() / 3) + 1) * 3, 2));

section('this quarter’s boards');
{
  const board = await ranking(alice);
  check('tokens, highest first', board.tokens.map((r) => r.name).join() === 'bob,alice,carol,dave', JSON.stringify(board.tokens));
  check('spending, highest first', board.spend.map((r) => r.name).join() === 'carol,alice,bob', JSON.stringify(board.spend));
  check('everyone up to ten is shown', board.tokens.length === 4 && board.spend.length === 3, JSON.stringify(board.tokens.map((r) => r.name)));
  check('an administrator is on neither board', !JSON.stringify(board).includes('owner'));
  check('no email is in it', !JSON.stringify(board).includes('@'));
  check('my own row is marked', board.tokens.find((r) => r.name === 'alice')?.isMe === true);
  check('my own place is said', board.me.tokens.rank === 2 && board.me.spend.rank === 2 && board.me.excluded === false);
  check('it is the current period, still open', board.key === thisQuarter && board.settled === false && !!board.closes);
  const low = await ranking(dave);
  check('someone off the top three is on the board, and learns their place', low.me.tokens.rank === 4 && low.tokens.some((r) => r.isMe && r.rank === 4));
  check('and someone with no spending has none', low.me.spend.rank === null);
  const admin = await ranking(owner);
  check('an administrator is told they are not ranked', admin.me.excluded === true && admin.me.tokens.rank === null);
  check('a period that does not exist is refused', await refused(ranking(alice, { key: '1999-Q1' }), 400));
  check('a scope that does not exist is refused', await refused(ranking(alice, { scope: 'month' }), 400));
  const year = await ranking(alice, { scope: 'year' });
  check('the year’s board counts the same usage', year.tokens[0].name === 'bob');
  await setPrefs(bob.id, { rankAnonymous: true });
  const hidden = await ranking(alice);
  check('someone who asked is shown without a name', hidden.tokens[0].name === null && hidden.tokens[0].value === 2000);
  // What a person signs in with is half of a login.
  const aliceFigure = hidden.tokens.find((r) => r.name === 'alice').value;
  await store.updateUser(alice.id, { name: 'Alice-Login' });
  check('a name that is the username is not shown', (await ranking(bob)).tokens.find((r) => r.value === aliceFigure)?.name === null);
  await store.updateUser(alice.id, { name: 'alice.mail' });
  check('nor one that is the first half of the email', (await ranking(bob)).tokens.find((r) => r.value === aliceFigure)?.name === null);
  await store.updateUser(alice.id, { name: 'alice' });
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
  check('one earned by spending says that', page.themes.find((t) => t.id === 'rainy-cafe')?.needs?.spend === 10);
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
  await setThemeBadge('lagoon', { kind: 'top_quarter', quarter: 1, year: 2026 }, owner.id);
  check('an administrator’s badge is what everyone sees', (await listThemes(alice)).themes.find((t) => t.id === 'lagoon')?.badge.quarter === 1);
  await store.setThemeBadge('lagoon', { kind: 'achievement', quarter: null, year: null }, owner.id);
}

section('titles');
{
  const page = await listTitles(alice);
  check('everyone has something to wear', page.titles.some((t) => t.id === 'newcomer' && t.owned));
  check('one earned by usage comes in', !page.titles.find((t) => t.id === 'spend-10')?.owned);
  check('a locked one says what earns it', page.titles.find((t) => t.id === 'tokens-1m')?.needs?.tokens === 1_000_000);
  check('each of the top three places can be looked at', [1, 2, 3].every((rank) => page.titles.find((t) => t.id === `rank-${rank}`)?.needs?.rank === rank));
  check('and how far along you are is said', page.progress?.tokens > 0);
  check('but a place is not a title anyone can wear', await refused(equipTitle(alice, 'rank-1'), 400));
  check('one not held cannot be worn', await refused(equipTitle(alice, 'tokens-1b'), 403));
  check('nor one that does not exist', await refused(equipTitle(alice, 'emperor'), 400));
  await equipTitle(alice, 'newcomer');
  check('it shows on the board', (await ranking(bob)).tokens.find((r) => r.name === 'alice')?.title?.id === 'newcomer');
  check('and can be taken off', (await equipTitle(alice, null)).equipped === null && (await listTitles(alice)).equipped === null);
  check('an administrator can wear any from the catalogue', (await equipTitle(owner, 'tokens-1b')).equipped === 'tokens-1b');
  await equipTitle(alice, 'newcomer');
}

section('a quarter closes');
{
  __testing.reset();
  await settleClosed({ now: nextQuarter });
  const after = (await store.listSettledPeriods()).map((p) => `${p.scope}:${p.period}`);
  check('the quarter is marked', after.includes(`quarter:${thisQuarter}`), after.join());
  const prize = rewardThemes(await themes.themeBadges(store), 'quarter', thisQuarter)[0];
  const held = async (user) => (await store.listUserThemes(user.id)).map((t) => t.theme_id);
  check('the top three of a board get the quarter’s prize', (await held(bob)).includes(prize) && (await held(alice)).includes(prize) && (await held(carol)).includes(prize), prize);
  check('fourth place does not', !(await held(dave)).includes(prize));
  check('an administrator does not', !(await held(owner)).includes(prize));
  const titles = (await store.listUserTitles(alice.id)).map((t) => t.title_id);
  check('and first place wears it', titles.includes(`top:tokens:quarter:${thisQuarter}:1`), titles.join());
  const seconds = (await store.listUserTitles(bob.id)).map((t) => t.title_id);
  check('as second place wears its own', seconds.includes(`top:tokens:quarter:${thisQuarter}:2`), seconds.join());
  const fourth = (await store.listUserTitles(dave.id)).map((t) => t.title_id);
  check('fourth place wears nothing for it', !fourth.some((id) => id.startsWith('top:')), fourth.join());
  const grant = (await listThemes(bob)).themes.find((t) => t.id === prize);
  check('it says which quarter it was for', grant?.grant?.kind === 'top_quarter' && grant?.grant?.quarter === Math.floor(NOW.getUTCMonth() / 3) + 1 && grant?.grant?.year === NOW.getUTCFullYear(), JSON.stringify(grant?.grant));
  await settlePeriod('quarter', thisQuarter);
  const kept = await store.settledBoard('quarter', thisQuarter);
  check('settling twice changes nothing, and the board keeps everyone it showed', kept.length === 7, String(kept.length));
  await spend(dave, 99_999_999, 999);
  const closed = await ranking(alice, { key: thisQuarter, now: nextQuarter });
  check('a closed board does not move, whatever comes in late', closed.settled === true && closed.tokens[0].name === 'alice' && closed.tokens.find((r) => r.name === 'dave')?.rank === 4, JSON.stringify(closed.tokens));
  await store.deleteUser(bob.id);
  const gone = await ranking(alice, { key: thisQuarter, now: nextQuarter });
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
  await settleClosed({ store: broken, now: nextQuarter });
  check('the failure is swallowed, and logged', tries === 1);
  await settleClosed({ store: broken, now: nextQuarter });
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

section('the fireworks: a week, a number of tokens, a hundred places');
{
  const { NEW_YEAR_EVENT: event } = themes;
  const during = new Date('2027-01-03T12:00:00+07:00');
  const before = new Date('2026-12-31T23:00:00+07:00');
  const after = new Date('2027-01-08T00:00:01+07:00');
  const zoe = await make('zoe');
  const stranger = await make('stranger');
  // What was used in the week, as the database would add it up; today is not in 2027.
  const week = new Map();
  const counted = new Proxy(store, {
    get(target, prop) {
      if (prop === 'usageTokensBetween') return async (id) => week.get(id) || 0;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const at = (when) => ({ now: when, store: counted });
  const row = async (user, when) => (await listThemes(user, at(when))).themes.find((t) => t.id === 'new-year-fireworks');
  const inWeek = async (user, tokens) => week.set(user.id, (week.get(user.id) || 0) + tokens);
  // The lifetime section above pruned every row; this needs one of its own.
  await spend(dave, 1234, 0);
  check('what a week adds up to is read from the usage in it', (await store.usageTokensBetween(dave.id, new Date(Date.now() - 60_000 * 60 * 24 * 365), new Date(Date.now() + 60_000))) > 0 && (await store.usageTokensBetween(dave.id, new Date('2020-01-01'), new Date('2020-02-01'))) === 0);
  check('nothing is owed before it starts', !(await row(zoe, before)).owned && (await row(zoe, before)).needs?.event?.state === 'soon');
  const asked = (await row(zoe, during)).needs?.event;
  check('it says what it asks, and how many places are left', asked?.tokens === event.tokens && asked?.left === event.places && asked?.state === 'running', JSON.stringify(asked));
  check('usage before the week does not count', asked?.used === 0);
  await inWeek(zoe, event.tokens - 1);
  check('one token short is not enough', !(await row(zoe, during)).owned && (await row(zoe, during)).needs?.event?.used === event.tokens - 1);
  await inWeek(zoe, 1);
  const won = await row(zoe, during);
  check('reaching it earns the theme', won.owned === true && won.grant?.kind === 'exclusive_event');
  check('and takes one place', (await row(stranger, during)).needs?.event?.left === event.places - 1);
  check('looking again takes no second place', (await listThemes(zoe, at(during))) && (await store.eventPlacesTaken(event.id)) === 1);
  await inWeek(stranger, event.tokens);
  check('after the week nothing more is given', !(await row(stranger, after)).owned && (await row(stranger, after)).needs?.event?.state === 'over');
  const admin = await listThemes(owner, at(during));
  check('an administrator holds it and takes no place', admin.themes.find((t) => t.id === 'new-year-fireworks')?.owned && (await store.eventPlacesTaken(event.id)) === 1);
  await takeTheme('new-year-fireworks', zoe.id);
  check('one an administrator took back is not earned again', !(await row(zoe, during)).owned);
  // The place was taken, and the grant after it was cut short.
  const cut = await make('cut');
  await counted.claimEventPlace(event.id, cut.id, event.places);
  check('a place taken is honoured whenever they next look, even after the week', (await row(cut, after)).owned === true);
  // The end of a turn looks too, so getting there with the page open counts.
  const worker = await make('worker');
  await inWeek(worker, event.tokens);
  await themes.afterTurn(worker, at(after));
  check('after the week the end of a turn gives nothing', (await store.eventPlaceOf(event.id, worker.id)) === null);
  await themes.afterTurn(worker, at(during));
  check('during it, the end of a turn is enough, with the page never looked at', (await store.eventPlaceOf(event.id, worker.id)) !== null);

  const racing = await Promise.all(Array.from({ length: 30 }, (_, i) => make(`racer${i}`)));
  const places = await Promise.all(racing.map((user) => store.claimEventPlace('race', user.id, 5)));
  check('thirty arriving at once for five places: five get one', places.filter((p) => p !== null).length === 5, JSON.stringify(places));
  check('each a different place', new Set(places.filter((p) => p !== null)).size === 5);
  check('and one person asking twice holds the one', (await store.claimEventPlace('solo', zoe.id, 5)) === (await store.claimEventPlace('solo', zoe.id, 5)));
}

section('two preferences saved at the same moment both land');
{
  const fay = await make('fay');
  await Promise.all([setPrefs(fay.id, { effort: 'low' }), setPrefs(fay.id, { mascot: 'happy' }), setPrefs(fay.id, { rankAnonymous: true })]);
  const prefs = await getPrefs(fay.id);
  check('none of them undid another', prefs.effort === 'low' && prefs.mascot === 'happy' && prefs.rankAnonymous === true, JSON.stringify([prefs.effort, prefs.mascot, prefs.rankAnonymous]));
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
