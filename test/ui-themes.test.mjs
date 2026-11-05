/**
 * Themes, the boards and the whale, in a real browser against the real server
 * (owner, 2026-11-04): a scene that really moves, a tile that plays under the pointer,
 * a locked theme that can only be looked at, words that stay readable over every
 * picture, and a mascot that never gets in the way.
 *
 *   node test/ui-themes.test.mjs
 *
 * Contrast is measured off rendered pixels, not worked out from tokens: what matters
 * is what is really under the words once a scene is moving behind them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-themes-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-themes-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-themes-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const SHOTS = process.env.THEME_SHOTS || null;
const { createCanvas, loadImage } = await import('@napi-rs/canvas');

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { createApp } = await import('../server/app.js');
const { THEMES } = await import('../server/themes.js');
const PORT = 5198;
const server = (await createApp()).listen(PORT);
await new Promise((r) => server.once('listening', r));

const { chromium } = await import('playwright-core');
let browser;
for (const options of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {
  try {
    browser = await chromium.launch({ ...options, headless: true });
    break;
  } catch {
    /* try the next one */
  }
}
if (!browser) {
  realLog('\n  Skipped: no Chrome, Edge or bundled Chromium to drive.\n');
  server.close();
  process.exit(process.env.CI ? 1 : 0);
}

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

let signedUp = 0;
const signUp = async (p, username, email) => {
  // Only the first account gets the sign-up form: the rest are made the way a form would.
  if (signedUp > 0) {
    const made = await p.request.post(`http://127.0.0.1:${PORT}/api/register`, { data: { email, password: 'a-long-enough-password', username, name: username } });
    if (!made.ok()) throw new Error(`could not sign up ${username}: ${made.status()}`);
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  } else {
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#gate-username');
    await p.fill('#gate-username', username);
    await p.fill('#gate-email', email);
    await p.fill('#gate-password', 'a-long-enough-password');
    await p.check('#gate-consent');
    await p.click('#gate-submit');
  }
  signedUp += 1;
  await p.waitForSelector('#model-chip');
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
};
// The first account is the owner: administrators hold everything, so a plain account comes second.
await signUp(page, 'theme.owner', 'owner@test.local');
const store = getStore();
const owner = await store.getUserByEmail('owner@test.local');
await store.setUserSetting(owner.id, 'prefs', { ...(await store.getUserSetting(owner.id, 'prefs')), language: 'en', onboarded: true });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#model-chip');
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

const reload = async (p = page) => {
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#model-chip');
  await p.waitForTimeout(700);
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
};
const openSettings = async (tab, p = page) => {
  await p.click('#account-button');
  await p.waitForTimeout(150);
  await p.click('.plusmenu--account [data-row="settings"]');
  await p.waitForSelector('#settings[open]');
  await p.click(`#tab-${tab}`);
  await p.waitForTimeout(500);
};
const shot = async (name, p = page) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
/** A scene is painted into a canvas: pixels off it, to compare between two moments. */
const canvasPrint = (selector, p = page) => p.evaluate((css) => {
  const canvas = document.querySelector(css);
  if (!canvas) return null;
  return canvas.toDataURL();
}, selector);

section('the account menu and the page');
{
  await page.click('#account-button');
  await page.waitForTimeout(150);
  check('the account menu has Theme', !!(await page.$('.plusmenu--account [data-row="theme"]')));
  check('and Ranking', !!(await page.$('.plusmenu--account [data-row="ranking"]')));
  await page.click('.plusmenu--account [data-row="theme"]');
  await page.waitForSelector('#settings[open]');
  await page.waitForFunction(() => document.querySelectorAll('.themes__tile').length > 0);
  await page.waitForTimeout(1500);
  const tiles = await page.evaluate(() => [...document.querySelectorAll('.themes__tile')].map((tile) => tile.dataset.themeId));
  check('every theme has a tile', tiles.length === THEMES.length, tiles.join());
  check('the name is under each', await page.evaluate(() => [...document.querySelectorAll('.themes__tile')].every((tile) => tile.querySelector('.themes__name').textContent.trim())));
  check('an administrator holds them all: nothing is locked', !(await page.$('.themes__tile.is-locked')));
  const detail = await page.evaluate(() => document.querySelector('.themes__detail')?.textContent || '');
  check('the panel on the right says what the chosen one means', /Default/.test(detail), detail.slice(0, 80));
  check('the light-or-dark row is no longer also called Theme', await page.evaluate(() => document.getElementById('theme-label').textContent.trim()) === 'Light or dark');
}

section('a theme is applied, and the app stays readable over it');
{
  await store.createChat(owner.id, { id: 'c-read', title: 'Something to read', model: 'auto' });
  await store.appendMessage(owner.id, 'c-read', { id: 'm-u', role: 'user', text: 'What do the figures say?' });
  await store.appendMessage(owner.id, 'c-read', { id: 'm-a', role: 'assistant', text: 'The figures say costs fell by a fifth over the quarter, mostly because of caching.\n\n- First point of the answer\n- Second point of the answer' });
  /** The contrast of a word over what is really painted behind it, from a screenshot. */
  const contrastAt = async (selector, p = page) => {
    const box = await p.evaluate((css) => {
      const node = [...document.querySelectorAll(css)].find((n) => n.getClientRects().length && n.textContent.trim());
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, color: getComputedStyle(node).color };
    }, selector);
    if (!box || box.width < 2) return null;
    const png = await p.screenshot({ clip: { x: box.x, y: box.y, width: Math.max(4, box.width), height: Math.max(4, box.height) } });
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    const [r, g, b] = box.color.match(/[\d.]+/g).map(Number);
    const lum = (a, c, d) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(a) + 0.7152 * f(c) + 0.0722 * f(d);
    };
    const ink = lum(r, g, b);
    // The ground is what is far from the ink. Its worst pixel is what the words have to beat;
    // the edge of a glyph is a blend of the two, so the few closest to the ink are left out.
    const ratios = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const distance = Math.abs(pixels[i] - r) + Math.abs(pixels[i + 1] - g) + Math.abs(pixels[i + 2] - b);
      if (distance < 240) continue;
      const ground = lum(pixels[i], pixels[i + 1], pixels[i + 2]);
      ratios.push((Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05));
    }
    ratios.sort((x, y) => x - y);
    return ratios.length ? ratios[Math.floor(ratios.length * 0.05)] : null;
  };

  for (const { id } of THEMES.filter((theme) => theme.id !== 'default')) {
    await page.click(`.themes__tile[data-theme-id="${id}"]`);
    await page.waitForTimeout(350);
    const applied = await page.evaluate(() => document.documentElement.dataset.scene);
    check(`${id} applies at once`, applied === id, String(applied));
    const settingsContrast = await contrastAt('#panel-theme .settings__title');
    check(`  words in Settings can be read over it`, settingsContrast === null || settingsContrast >= 4.5, settingsContrast?.toFixed(2));
    await shot(`settings-${id}`);
    await page.evaluate(() => document.getElementById('settings').close());
    await page.waitForTimeout(250);
    const firstFrame = await canvasPrint('#scene-layer canvas');
    await page.waitForTimeout(450);
    const laterFrame = await canvasPrint('#scene-layer canvas');
    check(`  it moves`, !!firstFrame && firstFrame !== laterFrame);
    await shot(`app-${id}`);
    const emptyContrast = await contrastAt('.empty p, .suggestion, #chat-title');
    check(`  and so can words on the opening screen`, emptyContrast === null || emptyContrast >= 4.5, emptyContrast?.toFixed(2));
    const sideContrast = await contrastAt('.rail a, .rail button, .sidebar__foot, .account__name');
    check(`  and in the sidebar`, sideContrast === null || sideContrast >= 4.5, sideContrast?.toFixed(2));
    const titleContrast = await contrastAt('#chat-title');
    check(`  and in the top bar`, titleContrast === null || titleContrast >= 4.5, titleContrast?.toFixed(2));
    await page.click('.chat-row[data-chat="c-read"] .chat-item');
    await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'Something to read');
    await page.waitForTimeout(350);
    await shot(`chat-${id}`);
    const replyContrast = await contrastAt('#messages .msg--assistant .prose p');
    check(`  and so can a reply`, replyContrast !== null && replyContrast >= 4.5, replyContrast?.toFixed(2));
    const listContrast = await contrastAt('#messages .msg--assistant .prose li');
    check(`  and a list in it`, listContrast !== null && listContrast >= 4.5, listContrast?.toFixed(2));
    await page.evaluate(() => document.querySelector('#new-chat, [data-new-chat]')?.click());
    await page.waitForTimeout(200);
    check(`  the page does not scroll sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.click('#account-button');
    await page.waitForTimeout(120);
    await page.click('.plusmenu--account [data-row="theme"]');
    await page.waitForSelector('#settings[open]');
    await page.waitForTimeout(300);
  }
}

section('the theme survives a reload, and the person keeps their light or dark');
{
  await page.click('.themes__tile[data-theme-id="lagoon"]');
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => localStorage.getItem('ai-remote:theme'));
  check('wearing a light scene writes nothing over the person’s light or dark', stored === null, String(stored));
  await reload();
  check('it is still on after a reload', await page.evaluate(() => document.documentElement.dataset.scene) === 'lagoon');
  check('and the canvas is back', !!(await page.$('#scene-layer canvas')));
  await openSettings('theme');
  await page.waitForFunction(() => document.querySelectorAll('.themes__tile').length > 0);
  await page.waitForTimeout(800);
  await page.click('.themes__tile[data-theme-id="default"]');
  await page.waitForTimeout(250);
  const off = await page.evaluate(() => ({ scene: document.documentElement.dataset.scene || null, layer: !!document.getElementById('scene-layer') }));
  check('the default takes the scene away', off.scene === null && off.layer === false, JSON.stringify(off));
  await page.evaluate(() => document.getElementById('settings').close());
}

section('a person who holds little: tiles, the lock and the order');
const plain = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const member = await plain.newPage();
const memberErrors = [];
member.on('pageerror', (err) => memberErrors.push(err.message));
await member.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
await signUp(member, 'theme.member', 'member@test.local');
const memberRow = await store.getUserByEmail('member@test.local');
await store.setUserSetting(memberRow.id, 'prefs', { ...(await store.getUserSetting(memberRow.id, 'prefs')), language: 'en', onboarded: true });
await store.grantTheme(memberRow.id, 'moon-night', { kind: 'achievement', month: null, year: null });
await reload(member);
{
  await openSettings('theme', member);
  await member.waitForFunction(() => document.querySelectorAll('.themes__tile').length > 0);
  await member.waitForTimeout(1500);
  await shot('page-held', member);
  const order = await member.evaluate(() => [...document.querySelectorAll('.themes__tile')].map((tile) => ({ id: tile.dataset.themeId, locked: tile.classList.contains('is-locked') })));
  check('held themes come first, newest first', order[0].id === 'moon-night' && order[1].id === 'default', order.slice(0, 3).map((o) => o.id).join());
  check('then the locked ones', order.slice(2).every((o) => o.locked));
  check('a locked tile carries a padlock', await member.evaluate(() => !!document.querySelector('.themes__tile.is-locked .themes__lock svg')));

  // Hover: the theme under the pointer plays; the one in use never does.
  await member.click('.themes__tile[data-theme-id="moon-night"]');
  await member.waitForTimeout(400);
  const hover = '.themes__tile[data-theme-id="deep-sea"] canvas';
  const atRest = await canvasPrint(hover, member);
  await member.waitForTimeout(300);
  check('a tile nobody is pointing at holds one still frame', atRest === (await canvasPrint(hover, member)));
  await member.hover('.themes__tile[data-theme-id="deep-sea"]');
  await member.waitForTimeout(450);
  const moving = await canvasPrint(hover, member);
  check('a tile under the pointer plays', moving !== atRest);
  await shot('page-hover', member);
  await member.mouse.move(5, 5);
  await member.waitForTimeout(200);
  check('and goes back to its still frame when the pointer leaves', (await canvasPrint(hover, member)) === atRest);
  const current = '.themes__tile[data-theme-id="moon-night"] canvas';
  const before = await canvasPrint(current, member);
  await member.hover('.themes__tile[data-theme-id="moon-night"]');
  await member.waitForTimeout(450);
  check('the theme in use stays still on its tile', before === (await canvasPrint(current, member)));

  // Keyboard, too.
  await member.focus('.themes__tile[data-theme-id="lagoon"]');
  const focusRest = await canvasPrint('.themes__tile[data-theme-id="lagoon"] canvas', member);
  await member.waitForTimeout(450);
  check('a tile reached by keyboard plays as well', focusRest !== (await canvasPrint('.themes__tile[data-theme-id="lagoon"] canvas', member)));
  await member.mouse.move(5, 5);

  // A locked theme is looked at, and never worn.
  await member.click('.themes__tile[data-theme-id="rose-street"]');
  await member.waitForTimeout(450);
  await shot('page-locked', member);
  const locked = await member.evaluate(() => ({
    scene: document.documentElement.dataset.scene,
    lock: !!document.querySelector('.themes__stage .themes__lock svg'),
    dim: getComputedStyle(document.querySelector('.themes__stage canvas')).opacity,
    badge: document.querySelector('.themes__badge').textContent,
    standing: document.querySelector('.themes__standing').textContent,
    chosen: !!document.querySelector('.themes__tile[data-theme-id="rose-street"].is-chosen'),
  }));
  check('pressing a locked theme does not put it on', locked.scene === 'moon-night', String(locked.scene));
  check('its panel carries a padlock', locked.lock);
  check('dimmed', Number(locked.dim) < 1, locked.dim);
  check('with its badge', /Top/i.test(locked.badge), locked.badge);
  check('and what earns it', /top 3/i.test(locked.standing), locked.standing);
  check('and the tile is framed as the one being looked at', locked.chosen);
  const stage = '.themes__stage canvas';
  const stageA = await canvasPrint(stage, member);
  await member.waitForTimeout(450);
  check('its preview still moves', stageA !== (await canvasPrint(stage, member)));
  const refused = await member.evaluate(async () => (await fetch('/api/themes/selected', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"id":"rose-street"}' })).status);
  check('and the server refuses it too', refused === 403, String(refused));

  // Narrow window.
  await member.setViewportSize({ width: 360, height: 740 });
  await member.waitForTimeout(250);
  check('nothing runs off a narrow screen', await member.evaluate(() => {
    const body = document.querySelector('#settings .settings__body');
    return body.scrollWidth <= body.clientWidth + 1;
  }));
  await shot('page-narrow', member);
  await member.setViewportSize({ width: 1280, height: 860 });
  await member.waitForTimeout(150);
  await member.evaluate(() => document.getElementById('settings').close());
}

section('the whale on the writing box');
{
  const mascot = () => member.evaluate(() => {
    const img = document.querySelector('.composer__box .mascot');
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const box = document.querySelector('.composer__box').getBoundingClientRect();
    return { state: img.dataset.state, pointer: getComputedStyle(img).pointerEvents, hidden: img.getAttribute('aria-hidden'), right: box.right - r.right, above: box.top - r.bottom, height: r.height, boxTop: box.top };
  });
  await member.waitForTimeout(400);
  const first = await mascot();
  check('it stands at the right of the box', first && first.right > 0 && first.right < 80, JSON.stringify(first));
  check('on its top edge', first && first.above < 2 && first.above > -20, JSON.stringify(first));
  check('it never takes a press', first?.pointer === 'none');
  check('and a screen reader does not read it', first?.hidden === 'true');
  check('it starts idle', first?.state === 'idle', first?.state);
  const boxTop = first.boxTop;
  await member.fill('#input', 'typing should not move anything');
  check('typing does not shift the box because of it', Math.abs((await mascot()).boxTop - boxTop) < 40);
  await member.fill('#input', '');

  await openSettings('theme', member);
  await member.waitForSelector('[data-mascot="sleeping"]');
  await member.click('[data-mascot="sleeping"]');
  await member.waitForTimeout(200);
  check('one state can be chosen, and it stays', (await mascot())?.state === 'sleeping');
  await member.click('[data-mascot="off"]');
  await member.waitForTimeout(200);
  check('off draws nothing', (await mascot()) === null);
  await reload(member);
  check('the choice is kept', (await mascot()) === null);
  await openSettings('theme', member);
  await member.waitForSelector('[data-mascot="auto"]');
  await member.click('[data-mascot="auto"]');
  await member.waitForTimeout(200);
  check('back on automatic', (await mascot())?.state === 'idle');
  await shot('page-mascots', member);
  await member.evaluate(() => document.getElementById('settings').close());
}

section('asking for less motion');
{
  const quiet = await browser.newContext({ viewport: { width: 1000, height: 700 }, reducedMotion: 'reduce' });
  const still = await quiet.newPage();
  await still.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
  await signUp(still, 'theme.still', 'still@test.local');
  const row = await store.getUserByEmail('still@test.local');
  await store.setUserSetting(row.id, 'prefs', { ...(await store.getUserSetting(row.id, 'prefs')), language: 'en', onboarded: true });
  await store.grantTheme(row.id, 'lagoon', { kind: 'achievement', month: null, year: null });
  await reload(still);
  await openSettings('theme', still);
  await still.waitForFunction(() => document.querySelectorAll('.themes__tile').length > 1);
  await still.waitForTimeout(1200);
  await still.click('.themes__tile[data-theme-id="lagoon"]');
  await still.waitForTimeout(300);
  await still.evaluate(() => document.getElementById('settings').close());
  const a = await canvasPrint('#scene-layer canvas', still);
  await still.waitForTimeout(450);
  check('the scene is a still picture', !!a && a === (await canvasPrint('#scene-layer canvas', still)));
  check('no whale: a GIF cannot be held on one frame', !(await still.$('.composer__box .mascot')));
  await quiet.close();
}

section('the scene stops drawing when the tab is hidden');
{
  const stats = await page.evaluate(async () => {
    const { mountScene, sceneStats } = await import('/js/scenes.js');
    const canvas = document.createElement('canvas');
    const handle = mountScene(canvas, 'lagoon', { animate: true });
    const before = sceneStats();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 200));
    const frames = sceneStats().frames;
    await new Promise((r) => setTimeout(r, 400));
    const after = sceneStats().frames;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    handle.destroy();
    return { before, frames, after };
  });
  check('it was playing', stats.before.playing >= 1);
  check('hidden, not one frame is drawn', stats.frames === stats.after, JSON.stringify(stats));
}

section('the boards');
{
  await store.createUser({ id: 'u-board-a', email: 'a@test.local', name: 'Anna', username: 'anna', passwordHash: 'x', role: 'user' });
  await store.createUser({ id: 'u-board-b', email: 'b@test.local', name: 'Binh', username: 'binh', passwordHash: 'x', role: 'user' });
  await store.recordUsage('u-board-a', { id: 'e1', chatId: null, model: 'm', inputTokens: 5000, outputTokens: 0, costUsd: 1.5, role: 'turn' });
  await store.recordUsage('u-board-b', { id: 'e2', chatId: null, model: 'm', inputTokens: 9000, outputTokens: 0, costUsd: 0.5, role: 'turn' });
  await store.recordUsage(memberRow.id, { id: 'e3', chatId: null, model: 'm', inputTokens: 100, outputTokens: 0, costUsd: 0, role: 'turn' });
  await store.recordUsage(owner.id, { id: 'e4', chatId: null, model: 'm', inputTokens: 99999, outputTokens: 0, costUsd: 99, role: 'turn' });
  await member.reload({ waitUntil: 'domcontentloaded' });
  await member.waitForSelector('#model-chip');
  await member.waitForTimeout(600);
  await openSettings('ranking', member);
  await member.waitForSelector('.ranking__row');
  await shot('ranking', member);
  const seen = await member.evaluate(() => ({
    boards: [...document.querySelectorAll('.ranking__board')].map((b) => [...b.querySelectorAll('.ranking__name')].map((n) => n.textContent.trim())),
    text: document.querySelector('.ranking').textContent,
    me: !!document.querySelector('.ranking__row.is-me'),
    place: document.querySelector('.ranking__me').textContent,
  }));
  check('tokens are in order', seen.boards[0][0].startsWith('binh') && seen.boards[0][1].startsWith('anna'), JSON.stringify(seen.boards[0]));
  check('spending is in order', seen.boards[1][0].startsWith('anna'), JSON.stringify(seen.boards[1]));
  check('administrators are not on them', !/theme\.owner/.test(seen.text));
  check('no email on the page', !/@test\.local/.test(seen.text));
  check('my own row is marked', seen.me);
  await member.click('[data-title="newcomer"]');
  await member.waitForFunction(() => document.querySelector('[data-title="newcomer"]')?.classList.contains('is-on'));
  check('a title can be worn', true);
  await member.waitForFunction(() => /Newcomer/.test(document.querySelector('.ranking__row.is-me .ranking__chip')?.textContent || ''));
  check('and shows beside my name', true);
  await member.check('[data-anon]');
  await member.waitForFunction(() => /A member/.test(document.querySelector('.ranking__row.is-me .ranking__name')?.textContent || ''));
  check('staying anonymous shows "A member"', true);
  await member.click('[data-scope="year"]');
  await member.waitForFunction(() => document.querySelector('[data-scope="year"]')?.getAttribute('aria-checked') === 'true');
  check('the year has a board too', !!(await member.$('.ranking__row')));
  await member.evaluate(() => document.getElementById('settings').close());
}

section('administering themes');
{
  await openSettings('admin');
  await page.waitForSelector('[data-theme-row="lagoon"]');
  await shot('admin');
  await page.click('[data-theme-row="lagoon"] > summary');
  await page.waitForSelector('[data-theme-row="lagoon"] [data-holders]');
  check('the row opens', await page.evaluate(() => document.querySelector('[data-theme-row="lagoon"]').open));
  const before = await store.listThemeBadges();
  await page.selectOption('[data-theme-row="lagoon"] [data-badge-kind]', 'top_month');
  await page.waitForTimeout(500);
  check('choosing a badge saves it', (await store.listThemeBadges()).length === before.length + 1);
  check('the month and year appear for a dated badge', await page.evaluate(() => !document.querySelector('[data-theme-row="lagoon"] [data-dated="month"]').hidden));
  await page.selectOption('[data-theme-row="lagoon"] [data-badge-kind]', 'achievement');
  await page.waitForTimeout(400);
  check('and go away for one that is not', await page.evaluate(() => document.querySelector('[data-theme-row="lagoon"] [data-dated="month"]').hidden));
  await page.evaluate(() => document.getElementById('settings').close());
}

section('nothing went wrong in the page');
check('no errors in the owner’s page', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
check('no errors in the member’s page', memberErrors.length === 0, memberErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
realLog(failures === 0 ? '\n\x1b[32mThemes, boards and the whale hold, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
