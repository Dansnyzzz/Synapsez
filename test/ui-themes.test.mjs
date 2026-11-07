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
/**
 * What a scene looks like on screen, to compare between two moments. A picture of the
 * page: a canvas handed to the scene worker cannot be read back from here.
 */
const canvasPrint = async (selector, p = page) => {
  const node = await p.$(selector);
  if (!node) return null;
  return (await node.screenshot()).toString('base64');
};
/** The fade-in of a scene's first frame, waited out. */
const SCENE_IN_MS = 700;

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
    await page.waitForTimeout(SCENE_IN_MS);
    const applied = await page.evaluate(() => document.documentElement.dataset.scene);
    check(`${id} applies at once`, applied === id, String(applied));
    const settingsContrast = await contrastAt('#panel-theme .settings__title');
    check(`  words in Settings can be read over it`, settingsContrast === null || settingsContrast >= 4.5, settingsContrast?.toFixed(2));
    await shot(`settings-${id}`);
    await page.evaluate(() => document.getElementById('settings').close());
    await page.waitForTimeout(250);
    await page.waitForSelector('#scene-layer canvas.is-in');
    const firstFrame = await canvasPrint('#scene-layer canvas.is-in');
    await page.waitForTimeout(450);
    const laterFrame = await canvasPrint('#scene-layer canvas.is-in');
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
  // White or black is the person's setting, whichever picture is up (owner, 2026-11-06).
  const panes = async () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme || null, column: getComputedStyle(document.documentElement).getPropertyValue('--scene-column').trim() }));
  await page.evaluate(() => document.querySelector('[data-theme-choice="dark"]').click());
  await page.click('.themes__tile[data-theme-id="lagoon"]');
  const darkOverLight = await panes();
  check('a scene painted light leaves a dark setting dark', darkOverLight.theme === 'dark' && darkOverLight.column.startsWith('rgba(11'), JSON.stringify(darkOverLight));
  await page.evaluate(() => document.querySelector('[data-theme-choice="light"]').click());
  await page.click('.themes__tile[data-theme-id="deep-sea"]');
  await page.waitForTimeout(100);
  const lightOverDark = await panes();
  check('a scene painted dark leaves a light setting light', lightOverDark.theme === 'light' && lightOverDark.column.startsWith('rgba(250'), JSON.stringify(lightOverDark));
  await page.evaluate(() => document.querySelector('[data-theme-choice="dark"]').click());
  await page.click('.themes__tile[data-theme-id="lagoon"]');

  // The last press is the one that counts, however the answers come back.
  await page.waitForTimeout(400);
  const puts = [];
  await page.route('**/api/themes/selected', async (route) => {
    const id = JSON.parse(route.request().postData()).id;
    puts.push(id);
    // The first save is the slowest, as it was when two crossed on the way.
    if (puts.length === 1) await new Promise((resolve) => setTimeout(resolve, 900));
    await route.continue();
  });
  const pressed = ['moon-night', 'firefly-grove', 'aurora-peak', 'deep-sea', 'cloud-drift'];
  const started = Date.now();
  for (const id of pressed) await page.click(`.themes__tile[data-theme-id="${id}"]`);
  const shownAt = Date.now() - started;
  const onScreen = await page.evaluate(() => ({ scene: document.documentElement.dataset.scene, current: document.querySelector('.themes__tile.is-current')?.dataset.themeId }));
  check('five quick presses show the last at once', onScreen.scene === 'cloud-drift' && onScreen.current === 'cloud-drift', JSON.stringify({ ...onScreen, shownAt }));
  await page.waitForFunction(() => document.querySelector('#scene-layer canvas.is-in'));
  await page.waitForTimeout(1800);
  check('only what was still wanted is sent', puts.length <= 2 && puts.at(-1) === 'cloud-drift', puts.join());
  const held = await page.evaluate(() => ({ scene: document.documentElement.dataset.scene, canvases: document.querySelectorAll('#scene-layer canvas').length }));
  check('it does not jump back to an earlier one', held.scene === 'cloud-drift', JSON.stringify(held));
  check('and only one scene is left behind the app', held.canvases === 1, JSON.stringify(held));
  await page.unroute('**/api/themes/selected');
  check('the server has the last one too', (await store.getUserSetting(owner.id, 'prefs')).sceneTheme === 'cloud-drift');
  await page.click('.themes__tile[data-theme-id="lagoon"]');
  await page.waitForTimeout(400);
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
  const hover = '.themes__tile[data-theme-id="deep-sea"] .themes__frame';
  check('a tile is a picture made ahead of time', await member.evaluate(() => {
    const all = [...document.querySelectorAll('.themes__tile:not([data-theme-id="default"]) img.themes__still')];
    return all.length > 0 && all.every((img) => /\/assets\/scenes\/.+\.webp$/.test(img.getAttribute('src')));
  }));
  check('and a page of them moves nothing', await member.evaluate(() => !document.querySelector('.themes__tile canvas')));
  await member.hover('.themes__tile[data-theme-id="deep-sea"]');
  await member.waitForSelector('.themes__tile[data-theme-id="deep-sea"] .scene-live.is-in');
  const moving = await canvasPrint(hover, member);
  await member.waitForTimeout(450);
  check('a tile under the pointer plays', moving !== (await canvasPrint(hover, member)));
  await shot('page-hover', member);
  await member.mouse.move(5, 5);
  await member.waitForTimeout(200);
  check('and goes back to its picture when the pointer leaves', !(await member.$('.themes__tile canvas')));
  await member.hover('.themes__tile[data-theme-id="moon-night"]');
  await member.waitForTimeout(450);
  check('the theme in use stays still on its tile', !(await member.$('.themes__tile[data-theme-id="moon-night"] canvas')));

  // Keyboard, too.
  await member.focus('.themes__tile[data-theme-id="lagoon"]');
  await member.waitForSelector('.themes__tile[data-theme-id="lagoon"] .scene-live');
  check('a tile reached by keyboard plays as well', true);
  await member.evaluate(() => document.activeElement.blur());
  await member.mouse.move(5, 5);

  // A locked theme is looked at, and never worn.
  await member.click('.themes__tile[data-theme-id="rose-street"]');
  await member.waitForTimeout(450);
  await shot('page-locked', member);
  const locked = await member.evaluate(() => ({
    scene: document.documentElement.dataset.scene,
    lock: !!document.querySelector('.themes__stage .themes__lock svg'),
    dim: getComputedStyle(document.querySelector('.themes__stage img')).opacity,
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
  const stage = '.themes__stage';
  await member.waitForSelector('.themes__stage .scene-live.is-in');
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
  check('on its top edge', first && first.above < 2 && first.above > -30, JSON.stringify(first));
  check('large enough to read as a whale, as the owner asked', first && first.height >= 120, JSON.stringify(first));
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
  await still.waitForSelector('#scene-layer canvas.is-in');
  await still.waitForTimeout(400);
  await still.evaluate(() => document.getElementById('settings').close());
  await still.waitForTimeout(200);
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
    await new Promise((resolve) => mountScene(canvas, 'lagoon', { animate: true, onReady: resolve }).constructor);
    const before = await sceneStats();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 200));
    const frames = (await sceneStats()).frames;
    await new Promise((r) => setTimeout(r, 400));
    const after = (await sceneStats()).frames;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
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
  const places = await member.evaluate(() => [...document.querySelectorAll('.ranking__board')][0].querySelectorAll('.is-place-1, .is-place-2, .is-place-3').length);
  check('the first three of a board wear their own colours', places === 3, String(places));
  const colours = await member.evaluate(() => [1, 2, 3].map((n) => getComputedStyle(document.querySelector(`.ranking__row.is-place-${n}`)).backgroundColor));
  check('  each a different one', new Set(colours).size === 3, colours.join(' / '));
  check('the words the owner took out are gone', !/not ranked|receive that period|never shows? an email/i.test(seen.text), seen.text.slice(0, 200));
  // A press shows at once, whatever the save is doing.
  const saves = [];
  await member.route('**/api/titles/equipped', async (route) => {
    saves.push(JSON.parse(route.request().postData()).id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await member.click('[data-title="newcomer"]');
  check('a title can be worn, and shows at once', await member.evaluate(() => document.querySelector('[data-title="newcomer"]').classList.contains('is-on')));
  check('its creature is in the panel beside the list', await member.evaluate(() => !!document.querySelector('.ranking__detail .ranking__stage canvas') && !!document.querySelector('.ranking__detail .themes__title').textContent.trim()));
  await member.waitForSelector('.ranking__stage canvas.is-in');
  const creature = await canvasPrint('.ranking__stage', member);
  await member.waitForTimeout(450);
  check('and it moves', creature !== (await canvasPrint('.ranking__stage', member)));
  await shot('title-newcomer', member);
  // One not held is looked at, dimmed, and not worn.
  check('a title not yet earned is dimmed', await member.evaluate(() => getComputedStyle(document.querySelector('[data-title="tokens-1b"]')).opacity < 1));
  const sent = saves.length;
  await member.click('[data-title="tokens-1b"]');
  const lookedAt = await member.evaluate(() => ({
    worn: document.querySelector('[data-title="newcomer"]').classList.contains('is-on'),
    locked: !!document.querySelector('.ranking__stage.is-locked'),
    says: document.querySelector('.ranking__detail .themes__standing')?.textContent || '',
    creature: !!document.querySelector('.ranking__detail canvas'),
  }));
  check('it can be looked at, and what is worn stays on', lookedAt.worn && lookedAt.locked && lookedAt.creature, JSON.stringify(lookedAt));
  check('it says what earns it, and how far along I am', /1,000,000,000|1\.000\.000\.000/.test(lookedAt.says) && /used/i.test(lookedAt.says), lookedAt.says);
  check('and nothing is saved', saves.length === sent);
  await shot('title-locked', member);
  await member.click('[data-title="spend-1000"]');
  await member.waitForTimeout(600);
  await shot('title-gold', member);
  await member.click('[data-title="newcomer"]');
  await member.waitForTimeout(700);
  await member.unroute('**/api/titles/equipped');
  await member.click('[data-scope="year"]');
  await member.waitForTimeout(100);
  await member.click('[data-scope="quarter"]');
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
  await page.selectOption('[data-theme-row="lagoon"] [data-badge-kind]', 'top_quarter');
  await page.waitForTimeout(500);
  check('choosing a badge saves it', (await store.listThemeBadges()).length === before.length + 1);
  check('the quarter and year appear for a dated badge', await page.evaluate(() => !document.querySelector('[data-theme-row="lagoon"] [data-dated="quarter"]').hidden));
  await page.selectOption('[data-theme-row="lagoon"] [data-badge-kind]', 'achievement');
  await page.waitForTimeout(400);
  check('and go away for one that is not', await page.evaluate(() => document.querySelector('[data-theme-row="lagoon"] [data-dated="quarter"]').hidden));
  await page.evaluate(() => document.getElementById('settings').close());
}

section('the effort dial: the last press is the one that counts');
{
  const sent = [];
  await member.route('**/api/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData());
      if ('effort' in body) sent.push(body.effort);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await route.continue();
  });
  await member.click('#policy-chip');
  await member.waitForSelector('.effort-dot');
  const dots = await member.$$('.effort-dot');
  for (const dot of [dots[1], dots[3], dots[0], dots[4]]) await dot.click();
  const lit = await member.evaluate(() => [...document.querySelectorAll('.effort-dot')].findIndex((dot) => dot.classList.contains('is-on')));
  check('four quick presses light the last at once', lit === 4, String(lit));
  await member.waitForTimeout(1300);
  check('and only what was still wanted is saved', sent.length <= 2 && sent.at(-1) === 'max' && (await store.getUserSetting(memberRow.id, 'prefs')).effort === 'max', sent.join());
  const after = await member.evaluate(() => [...document.querySelectorAll('.effort-dot')].findIndex((dot) => dot.classList.contains('is-on')));
  check('it does not walk back through the others', after === 4, String(after));
  await member.unroute('**/api/prefs');
  await member.keyboard.press('Escape');
}

section('/theme in the box');
{
  await member.waitForTimeout(200);
  const box = '#input';
  await member.fill(box, '/theme');
  await member.waitForSelector('#theme-picker:not([hidden]) .tpick__tile');
  await shot('picker', member);
  const seen = await member.evaluate(() => ({
    chip: document.querySelector('.tpick__chip').textContent,
    keys: document.querySelector('.tpick__keys').textContent,
    tiles: document.querySelectorAll('.tpick__tile').length,
    lit: document.querySelector('.tpick__tile[aria-selected="true"]')?.dataset.id,
    current: document.querySelector('.tpick__tile.is-current')?.dataset.id,
  }));
  check('it opens as the word is typed, and says what the keys do', seen.chip === '/theme' && /esc/i.test(seen.keys), JSON.stringify(seen));
  check('with every theme in the row', seen.tiles === THEMES.length, String(seen.tiles));
  check('starting from the one in use', seen.lit === seen.current, JSON.stringify(seen));
  check('and only one row of pictures, nothing moving', await member.evaluate(() => !document.querySelector('.tpick__tile canvas')));
  const other = await member.evaluate(() => document.querySelector('.tpick__tile:not(.is-current):not(.is-locked)').dataset.id);
  await member.hover(`.tpick__tile[data-id="${other}"]`);
  await member.waitForSelector(`.tpick__tile[data-id="${other}"] .scene-live`);
  check('a tile under the pointer plays', true);
  const current = seen.current;
  await member.hover(`.tpick__tile[data-id="${current}"]`);
  await member.waitForTimeout(250);
  check('the one in use does not', !(await member.$('.tpick__tile canvas')));
  const locked = await member.$('.tpick__tile.is-locked');
  await locked.click();
  await member.waitForTimeout(150);
  check('a locked one is not worn by a press', await member.evaluate((id) => document.documentElement.dataset.scene === id || !document.documentElement.dataset.scene, current));
  await member.focus(box);
  await member.keyboard.press('Escape');
  await member.waitForTimeout(100);
  check('Escape closes it and clears the word', await member.evaluate(() => document.getElementById('theme-picker').hidden && document.getElementById('input').value === ''));
  await member.fill(box, '/them');
  await member.waitForSelector('#theme-picker:not([hidden]) .tpick__tile');
  await member.fill(box, '/theme and more');
  await member.waitForTimeout(100);
  check('a message that only starts that way is a message', await member.evaluate(() => document.getElementById('theme-picker').hidden));
  await member.fill(box, '/theme');
  await member.waitForSelector('#theme-picker:not([hidden]) .tpick__tile');
  const before = await member.evaluate(() => document.documentElement.dataset.scene || 'default');
  const chats = await store.listChats(memberRow.id);
  const walk = await member.evaluate(() => {
    const all = [...document.querySelectorAll('.tpick__tile')];
    const from = all.findIndex((tile) => tile.getAttribute('aria-selected') === 'true');
    const to = all.findIndex((tile, i) => i !== from && !tile.classList.contains('is-locked'));
    return { steps: to - from, id: all[to].dataset.id };
  });
  for (let i = 0; i < Math.abs(walk.steps); i += 1) await member.keyboard.press(walk.steps > 0 ? 'ArrowRight' : 'ArrowLeft');
  await member.keyboard.press('Enter');
  await member.waitForTimeout(300);
  const applied = await member.evaluate(() => ({ scene: document.documentElement.dataset.scene || 'default', open: !document.getElementById('theme-picker').hidden, value: document.getElementById('input').value }));
  check('the arrows and Enter wear it', applied.scene === walk.id && applied.scene !== before, JSON.stringify(applied));
  check('Enter closes the row and clears the word', !applied.open && applied.value === '', JSON.stringify(applied));
  check('and nothing was sent as a message', (await store.listChats(memberRow.id)).length === chats.length);
}

section('signed out, the sign-in page covers everything');
{
  const out = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const gate = await out.newPage();
  await gate.addInitScript(() => localStorage.setItem('synapsez:scene', 'aurora-peak'));
  await gate.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await gate.waitForSelector('#gate:not([hidden])');
  await gate.waitForTimeout(500);
  const covered = await gate.evaluate(() => {
    const r = document.getElementById('gate').getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight, layer: !!document.getElementById('scene-layer'), scene: document.documentElement.dataset.scene || null };
  });
  check('it fills the window', covered.top === 0 && covered.left === 0 && covered.right === covered.width && covered.bottom === covered.height, JSON.stringify(covered));
  check('with no scene drawn under it', !covered.layer && covered.scene === null, JSON.stringify(covered));
  await shot('gate', gate);
  await out.close();
}

section('nothing went wrong in the page');
check('no errors in the owner’s page', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));
check('no errors in the member’s page', memberErrors.length === 0, memberErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
realLog(failures === 0 ? '\n\x1b[32mThemes, boards and the whale hold, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
