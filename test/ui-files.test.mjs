/**
 * Files in the viewer, in a real browser (owner, 2026-11-05): a workbook as a workbook,
 * a deck as it looks, a code block as one block, and a file nothing can draw.
 *
 *   npm run test:ui-files
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workbookFixture } from './lib/workbook-fixture.mjs';

process.env.ENCRYPTION_KEY ||= 'ui-files-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-files-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-files-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { createApp } = await import('../server/app.js');
const { saveUpload, saveMachineFile } = await import('../server/attachments.js');
const { createDocument } = await import('../server/office/index.js');
const { writeZip } = await import('../server/office/zip.js');
const PORT = 5197;
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

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => {
  failures += 1;
  realLog(`  \x1b[31m[page error]\x1b[0m ${err.message}`);
});
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate-username');
await page.fill('#gate-username', 'files.owner');
await page.fill('#gate-email', 'files@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
await page.check('#gate-consent');
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
const store = getStore();
const me = await store.getUserByEmail('files@test.local');
await store.setUserSetting(me.id, 'prefs', { ...(await store.getUserSetting(me.id, 'prefs')), language: 'en', onboarded: true });

const docx = createDocument({ format: 'docx', name: 'kien-truc', content: '# Kiến trúc\n\nTrước.\n\n```\nKhách\n  │\n  ▼\n┌───┐\n│Web│\n└───┘\n```\n\nSau.\n' }).buffer;
const deck = createDocument({ format: 'pptx', name: 'deck', content: '# Tiêu đề\nPhụ đề\n\n## Trang hai\n- Một\n\n> Ghi chú của người nói\n' }).buffer;
const uploads = {};
for (const [key, name, data] of [
  ['book', 'Báo cáo.xlsx', workbookFixture()],
  ['docx', 'Kiến trúc.docx', docx],
  ['deck', 'deck.pptx', deck],
  ['deck2', 'deck-two.pptx', createDocument({ format: 'pptx', name: 'deck2', content: '# Khác\nPhụ\n\n## Trang ba\n- Hai\n' }).buffer],
  ['zip', 'pack.zip', writeZip([{ name: 'a/one.txt', data: 'x' }, { name: 'two.csv', data: 'y' }])],
  ['sound', 'clip.mp3', Buffer.from('not really sound')],
]) {
  uploads[key] = await saveUpload(me.id, { name, mime: '', data: Buffer.from(data).toString('base64') });
}
uploads.big = await saveMachineFile(me.id, { name: 'huge.mp4', mime: 'video/mp4', bytes: 50 * 1024 * 1024, path: 'out/huge.mp4' });
await store.createChat(me.id, { id: 'c-files', title: 'Files', model: 'auto' });
await store.appendMessage(me.id, 'c-files', { id: 'u1', role: 'user', text: 'see', attachments: Object.values(uploads).map((r) => ({ id: r.id, name: r.name, kind: r.kind, mime: r.mime, bytes: r.bytes })) });
await store.appendMessage(me.id, 'c-files', { id: 'a1', role: 'assistant', text: 'ok' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#model-chip');
await page.waitForTimeout(800);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
await page.click('.chat-row[data-chat="c-files"] .chat-item');
await page.waitForTimeout(600);

const open = async (key) => {
  await page.evaluate(() => document.getElementById('viewer-close')?.click());
  await page.waitForTimeout(200);
  await page.locator(`#messages [data-file="${uploads[key].id}"]`).first().click();
  await page.waitForTimeout(1500);
};

section('a workbook, as a workbook');
{
  await open('book');
  await page.waitForSelector('.xlv__cell');
  const look = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.xlv__cell')];
    const find = (text) => cells.find((c) => c.textContent.trim() === text);
    const title = find('Tiêu đề');
    const merged = find('Gộp bốn cột');
    const a = title ? getComputedStyle(title) : null;
    const scroll = document.querySelector('.xlv__scroll');
    return {
      modes: [...document.querySelectorAll('.xlv__mode')].map((m) => m.textContent.replace(/\s+/g, ' ').trim()),
      tabs: [...document.querySelectorAll('.xlv__tab')].map((m) => m.textContent),
      hidden: document.querySelector('.xlv__hidden')?.textContent || '',
      columns: [...document.querySelectorAll('.xlv__col')].slice(0, 3).map((n) => n.textContent),
      rowNumbers: [...document.querySelectorAll('.xlv__row')].slice(0, 2).map((n) => n.textContent),
      ref: document.querySelector('.xlv__ref')?.textContent,
      formula: document.querySelector('.xlv__formula')?.textContent,
      fill: a?.backgroundColor,
      ink: a?.color,
      weight: a?.fontWeight,
      family: a?.fontFamily,
      bottom: a?.borderBottomColor,
      mergedWidth: merged?.getBoundingClientRect().width,
      columnWidth: title?.getBoundingClientRect().width,
      centred: merged ? getComputedStyle(merged).justifyContent : '',
      paper: getComputedStyle(scroll).backgroundColor,
      runs: [...(find('Chi phí nhiên liệu')?.querySelectorAll('span span') || [])].map((s) => getComputedStyle(s).fontWeight),
      runOn: find('Chữ dài chạy sang các ô trống bên cạnh như trong Excel')?.getBoundingClientRect().width,
      wrap: getComputedStyle(cells.find((c) => c.textContent.startsWith('Một đoạn dài')) || document.body).whiteSpace,
      pictures: [...document.querySelectorAll('.xlv__picture')].map((p) => p.getAttribute('src')),
      frozenTop: document.querySelectorAll('.xlv__frozen--top .xlv__cell').length,
      frozenLeft: document.querySelectorAll('.xlv__frozen--left .xlv__cell').length,
      oldTable: !!document.querySelector('.grid-wrap'),
      oldStrip: !document.getElementById('viewer-sheets').hidden,
    };
  });
  check('Data and Charts, the charts counted', look.modes[0] === 'Data' && /Charts\s*2/.test(look.modes[1]), look.modes.join(' | '));
  check('its sheets along the bottom, the hidden one only counted', look.tabs.join() === 'Báo cáo,Sheet thứ hai' && /1 hidden/.test(look.hidden), `${look.tabs.join()} ${look.hidden}`);
  check('letters along the top, numbers down the side', look.columns.join() === 'A,B,C' && look.rowNumbers.join() === '1,2', `${look.columns} ${look.rowNumbers}`);
  check('the first cell is selected, shown in the bar', look.ref === 'A1' && look.formula === 'Tiêu đề', `${look.ref} ${look.formula}`);
  check('its fill', look.fill === 'rgb(221, 160, 221)', look.fill);
  check('its ink', look.ink === 'rgb(0, 0, 255)', look.ink);
  check('its weight', Number(look.weight) >= 700, look.weight);
  check('its border', look.bottom === 'rgb(255, 0, 0)', look.bottom);
  check('a name a file wrote to be CSS did not become any', !/[;:()]/.test(look.family), look.family);
  check('a merge is as wide as what it covers', look.mergedWidth > look.columnWidth * 1.5, `${look.mergedWidth} vs ${look.columnWidth}`);
  check('  and centred, as it says', look.centred === 'center', look.centred);
  check('the sheet is paper, whatever the theme', look.paper === 'rgb(255, 255, 255)', look.paper);
  check('words in runs keep their own look', look.runs.length === 2 && Number(look.runs[1]) >= 700, look.runs.join());
  check('words run on over empty cells', look.runOn > look.columnWidth, `${look.runOn}`);
  check('words that wrap, wrap', look.wrap === 'pre-wrap', look.wrap);
  check('the chart stands over the cells', look.pictures.length === 1 && /\/drawing\/1\/0/.test(look.pictures[0]), look.pictures.join());
  check('what is frozen stays in view', look.frozenTop >= 1 && look.frozenLeft >= 1, `${look.frozenTop} ${look.frozenLeft}`);
  check('the old table and its strip are gone', !look.oldTable && !look.oldStrip);

  const picture = await page.evaluate(async () => {
    const img = document.querySelector('.xlv__picture');
    img.loading = 'eager';
    if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 8000); });
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  check('  and it really is one', picture.w > 100, JSON.stringify(picture));

  // Pressing a cell, and walking from it.
  const box = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('.xlv__cell')].find((c) => c.textContent.trim() === '1,234,567');
    const r = cell.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const said = () => page.evaluate(() => ({ ref: document.querySelector('.xlv__ref').textContent, formula: document.querySelector('.xlv__formula').textContent, focus: document.activeElement?.classList.contains('xlv__scroll'), label: document.querySelector('.xlv__scroll').getAttribute('aria-label') }));
  const pressed = await said();
  check('pressing a cell says its address and its number', pressed.ref === 'B2' && pressed.formula === '1234567', JSON.stringify(pressed));
  check('  and the grid takes the keyboard', pressed.focus === true);
  await page.keyboard.press('ArrowRight');
  const moved = await said();
  check('an arrow key moves, and a formula is shown as one', moved.ref === 'C2' && moved.formula === '=B2*2', JSON.stringify(moved));
  check('  a screen reader is told', /C2/.test(moved.label), moved.label);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  check('a merged cell is the cell that shows', (await said()).ref === 'A4', JSON.stringify(await said()));

  await page.locator('.xlv__tab').nth(1).click();
  await page.waitForTimeout(1200);
  const second = await page.evaluate(() => ({ text: [...document.querySelectorAll('.xlv__cell')].map((c) => c.textContent).join(), active: document.querySelector('.xlv__tab.is-active')?.textContent, ref: document.querySelector('.xlv__ref')?.textContent }));
  check('another sheet opens', /Ở sheet hai/.test(second.text) && second.active === 'Sheet thứ hai' && second.ref === 'A1', JSON.stringify(second));

  await page.locator('.xlv__mode').nth(1).click();
  await page.waitForTimeout(1000);
  const charts = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('.xlv__chart-tab')].map((c) => [c.querySelector('.xlv__chart-name').textContent, c.querySelector('.xlv__chart-sheet').textContent].join('@')),
    alt: document.querySelector('.xlv__chart img')?.alt,
    caption: document.querySelector('.xlv__chart-title')?.textContent,
    grid: !!document.querySelector('.xlv__scroll')?.offsetParent,
    fx: !!document.querySelector('.xlv__bar')?.offsetParent,
    sheets: !!document.querySelector('.xlv__sheets')?.offsetParent,
  }));
  check('each chart by its title, with the sheet it is on', charts.chips.join() === 'Doanh thu theo nhóm@Báo cáo,Biểu đồ sheet hai@Sheet thứ hai', charts.chips.join());
  check('  the picture named', charts.alt === 'Doanh thu theo nhóm', charts.alt);
  check('  and the grid, the bar and the sheets out of the way', !charts.grid && !charts.fx && !charts.sheets, JSON.stringify(charts));
  await page.locator('.xlv__chart-tab').nth(1).click();
  await page.waitForTimeout(300);
  check('the next chart shows when pressed', /drawing\/2\/0/.test(await page.evaluate(() => document.querySelector('.xlv__chart img').getAttribute('src'))));
  await page.locator('.xlv__mode').first().click();
  await page.waitForTimeout(200);
  check('and back to the data', await page.evaluate(() => !!document.querySelector('.xlv__scroll')?.offsetParent));

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(100);
  check('dark theme: still paper, and readable on it', await page.evaluate(() => {
    const scroll = getComputedStyle(document.querySelector('.xlv__scroll'));
    return scroll.backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(document.querySelector('.xlv__cell')).color !== 'rgb(255, 255, 255)';
  }));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  // A server that cannot read it that way: the table it can.
  await page.route('**/workbook?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no"}' }));
  await open('book');
  await page.waitForTimeout(800);
  const plain = await page.evaluate(() => ({ table: !!document.querySelector('.grid-wrap table'), words: document.querySelector('.grid-wrap')?.textContent || '', view: !!document.querySelector('.xlv__cell') }));
  check('where the server cannot, the plain table instead', plain.table && /Tiêu đề/.test(plain.words) && !plain.view, JSON.stringify(plain).slice(0, 160));
  await page.unroute('**/workbook?*');
}

section('a deck, as it looks');
{
  await open('deck');
  await page.waitForTimeout(1500);
  const look = await page.evaluate(async () => {
    const pictures = [...document.querySelectorAll('.slide__picture')];
    for (const p of pictures) p.loading = 'eager';
    await Promise.all(pictures.map((p) => (p.complete ? null : new Promise((r) => { p.onload = p.onerror = r; setTimeout(r, 8000); }))));
    return {
      count: pictures.length,
      sizes: pictures.map((p) => p.naturalWidth),
      alt: pictures[0]?.alt,
      ratio: pictures[0]?.style.aspectRatio,
      notes: document.querySelector('.slide__notes')?.textContent || '',
      numbers: [...document.querySelectorAll('.slide__no')].map((n) => n.textContent),
      button: document.querySelector('[data-office-render]')?.textContent,
    };
  });
  check('each slide is a picture', look.count === 2 && look.sizes.every((w) => w > 100), JSON.stringify(look.sizes));
  check('  whose words are there for a screen reader', /Tiêu đề/.test(look.alt), look.alt);
  check('  the right shape before it arrives', /\//.test(look.ratio || ''), look.ratio);
  check('  numbered, with the speaker\'s notes under it', look.numbers.join() === '1,2' && /Ghi chú/.test(look.notes), `${look.numbers} ${look.notes}`);
  check('LibreOffice is one press away', /LibreOffice/.test(look.button || ''), look.button);

  // Asked for: a stand-in for the machine, and the PDF it would give back.
  let asked = 0;
  await page.route('**/render', async (route) => {
    asked += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: uploads.deck.id, name: 'deck.pdf', bytes: 10 }) });
  });
  await page.click('[data-office-render]');
  await page.waitForSelector('[data-office-back]');
  const shown = await page.evaluate(() => ({ frame: !!document.querySelector('#viewer-body iframe.viewer__frame'), note: document.querySelector('.viewer__alt-note')?.textContent, pictures: document.querySelectorAll('.slide__picture').length }));
  check('pressed, it shows what came back, and says what it is', asked === 1 && shown.frame && /LibreOffice/.test(shown.note) && shown.pictures === 0, JSON.stringify(shown));
  await page.click('[data-office-back]');
  await page.waitForTimeout(300);
  check('and goes back', await page.evaluate(() => document.querySelectorAll('.slide__picture').length === 2));
  await page.unroute('**/render');
  await page.route('**/render', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'LibreOffice is not available right now.' }) }));
  await page.click('[data-office-render]');
  await page.waitForTimeout(500);
  check('it failing says so and leaves the preview', await page.evaluate(() => document.querySelectorAll('.slide__picture').length === 2 && !document.querySelector('[data-office-render]').disabled));
  await page.unroute('**/render');

  await page.route('**/page/*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no"}' }));
  await open('deck2');
  await page.waitForTimeout(1200);
  const words = await page.evaluate(() => ({ pictures: document.querySelectorAll('.slide__picture').length, text: document.querySelector('.slides')?.textContent || '' }));
  check('where the server cannot draw, its words instead', words.pictures === 0 && /Trang ba/.test(words.text), JSON.stringify(words).slice(0, 160));
  await page.unroute('**/page/*');
}

section('a code block in Word is one block');
{
  await open('docx');
  const look = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.doc pre')];
    return { count: blocks.length, text: blocks[0]?.textContent || '' };
  });
  check('one box, every line in it (owner, 2026-11-05, screenshots 3 and 4)', look.count === 1 && look.text.split('\n').filter((l) => l.trim()).length >= 6 && /┌───┐/.test(look.text), JSON.stringify(look));
}

section('any other file');
{
  await open('zip');
  const zip = await page.evaluate(() => document.getElementById('viewer-body').textContent);
  check('a zip lists what it holds', /a\/one\.txt/.test(zip) && /two\.csv/.test(zip), zip.slice(0, 120));
  await open('sound');
  check('sound has a player', await page.evaluate(() => !!document.querySelector('#viewer-body audio[controls]')));
  await open('big');
  const big = await page.evaluate(() => document.getElementById('viewer-body').textContent);
  check('one that stayed on the cloud computer says so', /cloud computer/.test(big), big.slice(0, 120));
  const served = await page.request.get(`http://127.0.0.1:${PORT}/api/attachments/${uploads.zip.id}`);
  check('a zip is only ever a download', /attachment/.test(served.headers()['content-disposition'] || '') && served.headers()['content-type'] === 'application/octet-stream');
  const played = await page.request.get(`http://127.0.0.1:${PORT}/api/attachments/${uploads.sound.id}`);
  check('sound can be played from here, and carries a policy that runs nothing', /inline/.test(played.headers()['content-disposition'] || '') && /default-src 'none'/.test(played.headers()['content-security-policy'] || ''), played.headers()['content-disposition']);
}

section('a reply says where it went');
{
  await store.createChat(me.id, { id: 'c-route', title: 'Route', model: 'auto' });
  await store.appendMessage(me.id, 'c-route', { id: 'ru1', role: 'user', text: 'Hi' });
  await store.appendMessage(me.id, 'c-route', {
    id: 'ra1',
    role: 'assistant',
    text: 'Answer.',
    thinking: 'Some reasoning here.',
    route: { provider: 'openrouter', model: 'Crouton Alpha', tier: 'stealth', warn: true, strict: false, masked: { EMAIL: 2, PHONE: 1 }, thinking: 'summary' },
  });
  await store.appendMessage(me.id, 'c-route', { id: 'ru2', role: 'user', text: 'Again' });
  await store.appendMessage(me.id, 'c-route', {
    id: 'ra2',
    role: 'assistant',
    text: 'Answer two.',
    thinking: 'More of it.',
    route: { provider: 'anthropic', model: 'Haiku', tier: 'no_training', warn: false, strict: false, masked: null, thinking: 'model_text' },
  });
  await page.evaluate(() => document.getElementById('viewer-close')?.click());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.click('.chat-row[data-chat="c-route"] .chat-item');
  await page.waitForTimeout(600);

  const shields = await page.$$('#messages .route-btn');
  check('every reply has its shield after a reload', shields.length === 2, String(shields.length));
  await store.createChat(me.id, { id: 'c-steps', title: 'Steps', model: 'auto' });
  const stepRoute = { provider: 'anthropic', model: 'Haiku', tier: 'no_training', warn: false, strict: false, masked: null, thinking: 'summary' };
  await store.appendMessage(me.id, 'c-steps', { id: 'su1', role: 'user', text: 'Do it' });
  await store.appendMessage(me.id, 'c-steps', { id: 'sa1', role: 'assistant', text: 'Working on it.', route: stepRoute, toolCalls: [{ id: 'sc1', name: 'calculate', input: { expression: '1+1' } }] });
  await store.appendMessage(me.id, 'c-steps', { id: 'st1', role: 'tool', results: [{ toolCallId: 'sc1', name: 'calculate', content: '2' }] });
  await store.appendMessage(me.id, 'c-steps', { id: 'sa2', role: 'assistant', text: 'Done.', route: stepRoute });
  await store.createChat(me.id, { id: 'c-tools', title: 'Tools', model: 'auto' });
  await store.appendMessage(me.id, 'c-tools', { id: 'tu1', role: 'user', text: 'Run it' });
  await store.appendMessage(me.id, 'c-tools', { id: 'ta1', role: 'assistant', text: '', route: stepRoute });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.click('.chat-row[data-chat="c-steps"] .chat-item');
  await page.waitForTimeout(500);
  check('a turn of several steps has one shield, at its end', (await page.$$('#messages .route-btn')).length === 1, String((await page.$$('#messages .route-btn')).length));
  await page.click('.chat-row[data-chat="c-tools"] .chat-item');
  await page.waitForTimeout(500);
  check('a turn with no words at the end still has one', (await page.$$('#messages .route-btn')).length === 1, String((await page.$$('#messages .route-btn')).length));
  await page.click('.chat-row[data-chat="c-route"] .chat-item');
  await page.waitForTimeout(500);
  shields.length = 0;
  shields.push(...(await page.$$('#messages .route-btn')));
  const first = await page.evaluate(() => {
    const button = document.querySelector('#messages .route-btn');
    return { warn: button.classList.contains('is-warn'), label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded') };
  });
  check('a stealth model\'s is marked', first.warn === true);
  check('it has a name a screen reader can say', /went/.test(first.label || ''), first.label);
  await shields[0].focus();
  await page.keyboard.press('Enter');
  const note = await page.evaluate(() => document.querySelector('#messages .route-note')?.innerText || '');
  check('the keyboard opens it', /Crouton Alpha/.test(note), note);
  check('it says the model and the provider', /Crouton Alpha, through OpenRouter/.test(note), note);
  check('what that means for this model', /unannounced model/i.test(note), note);
  check('and how many of what was hidden, never which', /email ×2/.test(note) && /phone number ×1/.test(note), note);
  await shields[1].click();
  const second = await page.evaluate(() => [...document.querySelectorAll('#messages .route-note')].pop()?.innerText || '');
  check('with hiding off, it says the words went as written', /Hiding is off/.test(second), second);

  const think = await page.evaluate(() => [...document.querySelectorAll('#messages .think__note')].map((n) => n.textContent));
  // A provider's summary says so; the model's own reasoning carries no line under it (owner, 2026-11-08).
  check('a provider\'s summary says whose words it is, and the model\'s own reasoning has no note', think.length === 1 && /summary the provider wrote/.test(think[0] || ''), think.join(' | '));
  const hiddenFolded = await page.evaluate(() => {
    const note = document.querySelector('#messages .think__note');
    return getComputedStyle(note).display;
  });
  check('and stays out of the way until it is opened', hiddenFolded === 'none', hiddenFolded);

  await page.evaluate(() => document.querySelector('#messages .route-note__more').click());
  await page.waitForSelector('#panel-cloak.is-active .cloak__section', { timeout: 8000 });
  const page2 = await page.evaluate(() => {
    const panel = document.getElementById('panel-cloak');
    return {
      text: panel.innerText,
      tables: panel.querySelectorAll('.cloak__table table').length,
      links: [...panel.querySelectorAll('a')].map((a) => ({ href: a.href, rel: a.rel })),
      sideways: document.querySelector('.settings__body').scrollWidth - document.querySelector('.settings__body').clientWidth,
      lit: document.querySelector('.tab.is-active')?.dataset.tab,
    };
  });
  check('the shield leads to the page that explains it', /How your data travels/.test(page2.text), page2.text.slice(0, 80));
  check('its section stays lit in the list', page2.lit === 'privacy', page2.lit);
  // The owner kept two parts (2026-11-08): the settings now, and what the mask catches, measured live.
  check('two tables: the measured figures, and what was hidden for this account', page2.tables >= 1 && page2.tables <= 2, String(page2.tables));
  check('the settings as they are now', /Personal details hidden from the provider/.test(page2.text) && /Your settings right now|settings/i.test(page2.text), page2.text.slice(0, 200));
  check('measured as the page opened, and saying when', /Measured at \d/.test(page2.text), page2.text.slice(0, 400));
  check('the figures are percentages, none of them promising everything overall', /70%/.test(page2.text) && /What it does not catch/.test(page2.text));
  check('what was hidden in this account\'s own conversations is counted, or it says why not', /In your conversations, the last 30 days/.test(page2.text));
  check('and nothing else is left on it: no meanings, no research, no providers', !/Confidential computing|Chain-of-thought monitoring|arxiv\.org/.test(page2.text));
  check('nothing makes the page scroll sideways', page2.sideways <= 1, String(page2.sideways));

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  const phone = await page.evaluate(() => {
    const body = document.querySelector('.settings__body');
    return { sideways: body.scrollWidth - body.clientWidth, table: [...document.querySelectorAll('.cloak__table')].every((t) => getComputedStyle(t).overflowX === 'auto') };
  });
  check('on a phone a table scrolls in its own box, not the page', phone.sideways <= 1 && phone.table, JSON.stringify(phone));
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.evaluate(() => document.querySelector('#panel-cloak .data__back').click());
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => ({
    privacy: document.getElementById('panel-privacy').classList.contains('is-active'),
    row: !!document.querySelector('#panel-privacy [data-goto="cloak"]'),
    monitor: document.getElementById('action-monitor')?.checked,
  }));
  check('back goes to Privacy, which leads here too', back.privacy && back.row, JSON.stringify(back));
  check('and the independent check is off until somebody turns it on', back.monitor === false);
  await page.click('label[for="action-monitor"]');
  await page.waitForTimeout(500);
  const saved = await store.getUserSetting(me.id, 'prefs');
  check('turning it on is kept', saved.actionMonitor === true, JSON.stringify(saved.actionMonitor));
  await page.evaluate(() => document.querySelector('dialog[open]')?.close());
}

/* ── Used in this session, and the uploads window ──────────────────
 *
 * Owner, 2026-11-09, screenshots 2, 8 and 9: a row per message that brought
 * files, above Outputs; pressing it opens that message's files, the list on the
 * left and the chosen one drawn on the right by the viewer's own code.
 */

/** Screenshots to compare with the owner's, when asked for: `UPLOADS_SHOTS=<dir>`. */
const uploadsShot = async (name) => {
  if (!process.env.UPLOADS_SHOTS) return;
  fs.mkdirSync(process.env.UPLOADS_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.UPLOADS_SHOTS, `${name}.png`) }).catch((err) => realLog(`  (no screenshot: ${err.message})`));
};
const until = async (test, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return true;
    await page.waitForTimeout(80);
  }
  return false;
};
const { tinyPdf } = await import('./lib/pdf.mjs');
const { saveGenerated } = await import('../server/attachments.js');
/** What the side panel's sections say, top to bottom. */
const railNow = () =>
  page.evaluate(() => ({
    sections: [...document.querySelectorAll('#rail-extra .railsec')].map((s) => /** @type {HTMLElement} */ (s).dataset.rail),
    heading: document.querySelector('#rail-extra [data-rail="uploads"] .railsec__title')?.textContent || '',
    rows: [...document.querySelectorAll('#rail-extra [data-uploads]')].map((row) => ({
      label: row.querySelector('.railrow__label')?.textContent || '',
      first: row.querySelector('.railrow__first')?.textContent || '',
      more: row.querySelector('.railrow__more')?.textContent || '',
      name: row.getAttribute('aria-label') || '',
      popup: row.getAttribute('aria-haspopup'),
    })),
  }));
/** What the uploads window shows, in one object. */
const modalNow = () =>
  page.evaluate(() => {
    const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('uploads'));
    const body = document.getElementById('uploads-body');
    const items = [...document.querySelectorAll('#uploads-list [role="option"]')];
    const link = /** @type {HTMLAnchorElement} */ (document.getElementById('uploads-download'));
    return {
      open: dialog.open,
      title: document.getElementById('uploads-title').textContent,
      items: items.map((o) => `${o.querySelector('.upv__fname')?.textContent}|${o.querySelector('.upv__badge')?.textContent}`),
      icons: items.map((o) => o.querySelector('.upv__icon svg') ? 1 : 0).join(''),
      selected: items.findIndex((o) => o.getAttribute('aria-selected') === 'true'),
      lit: items.findIndex((o) => o.classList.contains('is-chosen')),
      tabStops: items.filter((o) => o.tabIndex === 0).length,
      focus: items.indexOf(/** @type {any} */ (document.activeElement)),
      activeId: document.activeElement?.id || '',
      name: document.getElementById('uploads-name').textContent,
      type: document.getElementById('uploads-type').textContent,
      href: link.getAttribute('href') || '',
      saveAs: link.getAttribute('download') || '',
      kind: body.dataset.kind || '',
      image: !!body.querySelector('.viewer__image img'),
      frame: body.querySelector('iframe.viewer__frame')?.getAttribute('src') || '',
      cells: body.querySelectorAll('.xlv__cell').length,
      fx: body.querySelector('.xlv__fx')?.textContent || '',
      columns: [...body.querySelectorAll('.xlv__col')].slice(0, 2).map((n) => n.textContent).join(''),
      sheetTabs: [...body.querySelectorAll('.xlv__tab')].map((n) => n.textContent),
    };
  });

/** The files of the conversation below, as stored. */
const sent = {};

section('Used in this session: a row per message that brought files, above Outputs');
{
  const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 640, height: 400 } });
  for (const [key, name, data, mime] of [
    ['png', '1793889515185_image.png', shot.toString('base64'), 'image/png'],
    ['xlsx', 'KMT BC KQTH UPKH NL-2026.xlsx', Buffer.from(workbookFixture()).toString('base64'), ''],
    ['pdf', 'Hợp đồng.pdf', tinyPdf('A contract, one page'), 'application/pdf'],
    ['paste', 'pasted.txt', Buffer.from('Words somebody pasted, not a file they chose.').toString('base64'), 'text/plain'],
    ['docx', 'Kiến trúc.docx', Buffer.from(docx).toString('base64'), ''],
  ]) {
    sent[key] = await saveUpload(me.id, { name, mime, data });
  }
  const meta = (row) => ({ id: row.id, name: row.name, kind: row.kind, mime: row.mime, bytes: row.bytes });
  await store.createChat(me.id, { id: 'c-uploads', title: 'Uploads', model: 'auto' });
  await store.appendMessage(me.id, 'c-uploads', { id: 'up-u1', role: 'user', text: 'read these', attachments: [meta(sent.png), meta(sent.xlsx), meta(sent.pdf), meta(sent.paste)] });
  await store.appendMessage(me.id, 'c-uploads', { id: 'up-a1', role: 'assistant', text: 'Read.' });
  await store.appendMessage(me.id, 'c-uploads', { id: 'up-u2', role: 'user', text: 'and this', attachments: [meta(sent.docx)] });
  await store.appendMessage(me.id, 'c-uploads', { id: 'up-a2', role: 'assistant', text: 'Read too.' });
  await saveGenerated(me.id, { name: 'tom-tat.md', mime: 'text/markdown', data: Buffer.from('# Tóm tắt\n').toString('base64'), chatId: 'c-uploads' });

  await page.evaluate(() => document.getElementById('viewer-close')?.click());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.click('.chat-row[data-chat="c-uploads"] .chat-item');
  await page.waitForTimeout(600);
  if (!(await page.evaluate(() => document.getElementById('app').classList.contains('is-detail')))) await page.click('#detail-toggle');
  await until(async () => (await railNow()).rows.length === 2);
  // The panel slides open; measure it once it has stopped moving.
  let width = -1;
  await until(async () => {
    const now = await page.evaluate(() => Math.round(document.getElementById('detail').getBoundingClientRect().width));
    const settled = now > 280 && now === width;
    width = now;
    return settled;
  });

  const rail = await railNow();
  check('"Used in this session" heads it', rail.heading === 'Used in this session', rail.heading);
  check('  above Outputs', rail.sections.indexOf('uploads') === 0 && rail.sections.indexOf('outputs') === 1, rail.sections.join());
  check('one row per message that brought files', rail.rows.length === 2, String(rail.rows.length));
  check('"Uploads", the first name and "+2" — a paste is not counted', rail.rows[0].label === 'Uploads' && rail.rows[0].first === '1793889515185_image.png' && rail.rows[0].more === '+2', JSON.stringify(rail.rows[0]));
  check('a message with one file has no "+"', rail.rows[1].first === 'Kiến trúc.docx' && rail.rows[1].more === '', JSON.stringify(rail.rows[1]));
  check('a screen reader hears every name, and that it opens a window', /1793889515185_image\.png, KMT BC KQTH UPKH NL-2026\.xlsx, Hợp đồng\.pdf$/.test(rail.rows[0].name) && rail.rows[0].popup === 'dialog', rail.rows[0].name);
  const cut = await page.evaluate(() => {
    const first = /** @type {HTMLElement} */ (document.querySelector('#rail-extra [data-uploads="0"] .railrow__first'));
    const row = /** @type {HTMLElement} */ (document.querySelector('#rail-extra [data-uploads="0"]'));
    const style = getComputedStyle(first);
    return { ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap', oneLine: row.getBoundingClientRect().height < 44, inside: row.getBoundingClientRect().right <= document.getElementById('detail').getBoundingClientRect().right + 1 };
  });
  check('  on one line, the name cut to fit', cut.ellipsis && cut.oneLine && cut.inside, JSON.stringify(cut));
  await uploadsShot('1-rail');
}

section('the uploads window: the list, the chosen file drawn by the viewer');
{
  await page.click('#rail-extra [data-uploads="0"]');
  await until(async () => (await modalNow()).image);
  let m = await modalNow();
  check('it opens', m.open, JSON.stringify(m).slice(0, 200));
  check('"Uploaded files" over the list', m.title === 'Uploaded files', m.title);
  check('that message\'s files, each with its type', m.items.join() === '1793889515185_image|PNG,KMT BC KQTH UPKH NL-2026|XLSX,Hợp đồng|PDF', m.items.join());
  check('  each with its mark', m.icons === '111', m.icons);
  check('the first chosen, lit, and focused', m.selected === 0 && m.lit === 0 && m.focus === 0 && m.tabStops === 1, JSON.stringify({ s: m.selected, l: m.lit, f: m.focus, t: m.tabStops }));
  check('its name and type in the bar', m.name === '1793889515185_image' && m.type === 'PNG', `${m.name} ${m.type}`);
  check('the download is a link to that file, under its own name', m.href === `/api/attachments/${encodeURIComponent(sent.png.id)}?download=1` && m.saveAs === '1793889515185_image.png', `${m.href} ${m.saveAs}`);
  const picture = await page.evaluate(async () => {
    const img = /** @type {HTMLImageElement} */ (document.querySelector('#uploads-body .viewer__image img'));
    if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 5000); });
    const box = img.getBoundingClientRect();
    const pane = document.getElementById('uploads-body').getBoundingClientRect();
    return { w: img.naturalWidth, dx: Math.abs(box.left + box.width / 2 - (pane.left + pane.width / 2)), dy: Math.abs(box.top + box.height / 2 - (pane.top + pane.height / 2)), fits: box.width <= pane.width && box.height <= pane.height };
  });
  check('a picture, drawn and centred in its pane', m.kind === 'image' && picture.w === 640 && picture.dx < 3 && picture.dy < 3 && picture.fits, JSON.stringify(picture));
  const downloaded = await page.evaluate(async (href) => (await fetch(href)).headers.get('content-disposition') || '', m.href);
  check('  and the link gives the file back to save', /attachment/i.test(downloaded), downloaded);
  await uploadsShot('2-picture');

  await page.keyboard.press('ArrowDown');
  await until(async () => (await modalNow()).cells > 0, 15000);
  m = await modalNow();
  check('↓ moves to the workbook, and focus with it', m.selected === 1 && m.focus === 1 && m.tabStops === 1, JSON.stringify({ s: m.selected, f: m.focus }));
  check('  the download follows', m.href === `/api/attachments/${encodeURIComponent(sent.xlsx.id)}?download=1` && m.saveAs === 'KMT BC KQTH UPKH NL-2026.xlsx', `${m.href} ${m.saveAs}`);
  check('  drawn as a workbook: letters, the fx bar, its sheets along the bottom', m.kind === 'sheets' && m.columns === 'AB' && m.fx === 'fx' && m.sheetTabs.join() === 'Báo cáo,Sheet thứ hai', JSON.stringify({ k: m.kind, c: m.columns, fx: m.fx, tabs: m.sheetTabs }));
  check('  its name and type in the bar', m.name === 'KMT BC KQTH UPKH NL-2026' && m.type === 'XLSX', `${m.name} ${m.type}`);
  await uploadsShot('3-workbook');

  await page.keyboard.press('ArrowDown');
  await until(async () => !!(await modalNow()).frame);
  m = await modalNow();
  check('↓ again: the PDF, in the browser\'s reader', m.selected === 2 && m.kind === 'pdf' && m.frame.startsWith(`/api/attachments/${encodeURIComponent(sent.pdf.id)}?v=`), JSON.stringify({ s: m.selected, k: m.kind, f: m.frame }));
  await page.keyboard.press('ArrowDown');
  check('↓ at the end stays at the end', (await modalNow()).selected === 2);
  await page.keyboard.press('Home');
  await until(async () => (await modalNow()).image);
  check('Home goes to the first', (await modalNow()).selected === 0 && (await modalNow()).focus === 0);
  await page.keyboard.press('End');
  await until(async () => !!(await modalNow()).frame);
  check('End to the last', (await modalNow()).selected === 2);
  await page.keyboard.press('ArrowUp');
  await until(async () => (await modalNow()).cells > 0, 15000);
  check('↑ back one', (await modalNow()).selected === 1);
  await page.click('#uploads-list [data-index="0"]');
  await until(async () => (await modalNow()).image);
  m = await modalNow();
  check('a press chooses too', m.selected === 0 && m.kind === 'image', `${m.selected} ${m.kind}`);

  // Tab goes round inside the window and never out to the page behind it.
  await page.focus('#uploads-close');
  await page.keyboard.press('Tab');
  const afterClose = (await modalNow()).activeId;
  await page.keyboard.press('Tab');
  const wrapped = await modalNow();
  await page.keyboard.press('Shift+Tab');
  const back = (await modalNow()).activeId;
  check('Tab from ✕ reaches the file', afterClose === 'uploads-body', afterClose);
  check('  and from there back round to the list', wrapped.focus === 0, JSON.stringify({ f: wrapped.focus, id: wrapped.activeId }));
  check('  Shift+Tab goes the other way round', back === 'uploads-body', back);
  const inside = await page.evaluate(() => document.getElementById('uploads').contains(document.activeElement));
  check('  focus never left the window', inside);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const closed = await page.evaluate(() => ({ open: /** @type {HTMLDialogElement} */ (document.getElementById('uploads')).open, row: /** @type {HTMLElement} */ (document.activeElement)?.dataset?.uploads ?? null, body: document.getElementById('uploads-body').childElementCount }));
  check('Esc closes it', !closed.open);
  check('  focus is back on the row that opened it', closed.row === '0', String(closed.row));
  check('  and what it drew is taken down', closed.body === 0, String(closed.body));

  await page.click('#rail-extra [data-uploads="1"]');
  await until(async () => (await modalNow()).open && (await modalNow()).kind === 'document', 15000);
  m = await modalNow();
  check('the second row opens its own message\'s file', m.items.join() === 'Kiến trúc|DOCX' && m.kind === 'document', `${m.items} ${m.kind}`);
  await page.click('#uploads-close');
  await page.waitForTimeout(200);
  const shut = await page.evaluate(() => ({ open: /** @type {HTMLDialogElement} */ (document.getElementById('uploads')).open, row: /** @type {HTMLElement} */ (document.activeElement)?.dataset?.uploads ?? null }));
  check('✕ closes it, and focus goes back to that row', !shut.open && shut.row === '1', JSON.stringify(shut));
}

section('the uploads window on a phone, in dark, and in Vietnamese');
{
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.click('#rail-extra [data-uploads="0"]');
  await until(async () => (await modalNow()).image);
  await uploadsShot('4-picture-dark');
  await page.click('#uploads-list [data-index="1"]');
  await until(async () => (await modalNow()).cells > 0, 15000);
  await uploadsShot('5-workbook-dark');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#rail-extra [data-uploads="0"]')).click());
  await until(async () => (await modalNow()).image);
  const phone = await page.evaluate(() => {
    const dialog = document.getElementById('uploads').getBoundingClientRect();
    const side = document.querySelector('.upv__side').getBoundingClientRect();
    const main = document.querySelector('.upv__main').getBoundingClientRect();
    const close = document.getElementById('uploads-close').getBoundingClientRect();
    const img = document.querySelector('#uploads-body .viewer__image img').getBoundingClientRect();
    return {
      full: Math.round(dialog.width) === window.innerWidth && Math.round(dialog.height) === window.innerHeight,
      stacked: side.bottom <= main.top + 1,
      close: close.top >= 0 && close.right <= window.innerWidth && close.width >= 32,
      picture: img.width > 0 && img.right <= window.innerWidth,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  check('a phone: the whole screen, the list over the file', phone.full && phone.stacked, JSON.stringify(phone));
  check('  ✕ in reach, the picture inside, nothing sideways', phone.close && phone.picture && phone.sideways <= 0, JSON.stringify(phone));
  await uploadsShot('6-phone');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(300);

  await page.evaluate(() => document.getElementById('account-button')?.click());
  await page.waitForTimeout(150);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.waitForSelector('#settings[open]');
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#language input[value="vi"]')).click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await until(async () => (await railNow()).heading === 'Đã dùng trong phiên này');
  const vi = await railNow();
  check('"Đã dùng trong phiên này", "Tệp đã tải lên"', vi.heading === 'Đã dùng trong phiên này' && vi.rows[0]?.label === 'Tệp đã tải lên', JSON.stringify({ h: vi.heading, l: vi.rows[0]?.label }));
  await page.click('#rail-extra [data-uploads="0"]');
  await until(async () => (await modalNow()).image);
  check('  and the window\'s list is "Tệp đã tải lên"', (await modalNow()).title === 'Tệp đã tải lên', (await modalNow()).title);
  await uploadsShot('7-vietnamese');
  await page.keyboard.press('Escape');
  await page.click('#account-button');
  await page.waitForTimeout(150);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.waitForSelector('#settings[open]');
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#language input[value="en"]')).click());
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
}

section('a file sent from this tab is listed at once, and once');
{
  await page.setInputFiles('#file-input', { name: 'just-sent.png', mimeType: 'image/png', buffer: await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 200, height: 120 } }) });
  await until(async () => page.evaluate(() => !!document.querySelector('#attachments .stage') && !document.querySelector('#attachments .is-uploading')));
  await page.fill('#input', 'one more');
  await page.keyboard.press('Enter');
  await until(async () => (await railNow()).rows.length === 3);
  let rail = await railNow();
  check('a third row, before any reload', rail.rows.length === 3 && rail.rows[2].first === 'just-sent.png' && rail.rows[2].more === '', JSON.stringify(rail.rows[2] || null));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.click('.chat-row[data-chat="c-uploads"] .chat-item');
  await until(async () => (await railNow()).rows.length >= 3);
  rail = await railNow();
  check('  and after a reload, still once', rail.rows.length === 3 && rail.rows[2].first === 'just-sent.png', rail.rows.map((r) => r.first).join());
}

section('the composer takes any file, and says what the model will do with sound');
{
  const accept = await page.evaluate(() => document.getElementById('file-input').getAttribute('accept'));
  check('the picker refuses nothing', accept === null, String(accept));
  await page.setInputFiles('#file-input', { name: 'voice.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('sound') });
  await page.waitForTimeout(700);
  const warning = await page.evaluate(() => ({ hidden: document.getElementById('vision-warning').hidden, text: document.getElementById('vision-warning-text').textContent }));
  check('a model that cannot hear says so before the send', !warning.hidden && /cannot hear or watch voice\.mp3/.test(warning.text), JSON.stringify(warning));
  await page.setInputFiles('#file-input', { name: 'pack.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });
  await page.waitForTimeout(500);
  const tiles = await page.evaluate(() => document.querySelector('#composer, .composer')?.innerText || '');
  check('a zip goes in beside it', /pack\.zip/.test(tiles), tiles.slice(0, 120));
}

section('a file too big for this host goes straight to the machine');
{
  // The machine is played here, down to a page on another address accepting the bytes.
  let received = 0;
  await page.route('**/api/attachments/direct', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ url: 'https://49983-sbx.e2b.app/files?path=x', path: 'uploads/ab12cd34/big.zip' }) }),
  );
  await page.route('https://49983-sbx.e2b.app/**', async (route) => {
    received = Number(route.request().headers()['content-length'] || 0) || (route.request().postDataBuffer()?.length ?? 0);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
  });
  await page.route('**/api/attachments/direct/finish', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ attachment: { id: 'direct-1', name: 'big.zip', kind: 'binary', bytes: 4_000_000 } }) }),
  );
  await page.route('**/api/bootstrap*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.attachments = { ...body.attachments, direct: true, directMaxBytes: 2 * 1024 ** 3 };
    await route.fulfill({ response, json: body });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => d.close()));
  await page.setInputFiles('#file-input', { name: 'big.zip', mimeType: 'application/zip', buffer: Buffer.alloc(4_000_000, 65) });
  await page.waitForTimeout(1200);
  const tile = await page.evaluate(() => ({ text: document.getElementById('attachments')?.innerText || '', failed: !!document.querySelector('#attachments .is-failed') }));
  check('it arrives without passing through this app', received > 3_000_000, String(received));
  check('and sits in the message like any other file', /big\.zip/.test(tile.text) && !tile.failed, JSON.stringify(tile));
}

await browser.close();
server.close();
realLog(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll file viewer checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
