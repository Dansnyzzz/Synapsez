/**
 * Settings → People, as the owner of the quick-fixes round (2026-11-16) asked for it, in a real browser:
 *
 *   - the notes under the headings are gone, in both languages
 *   - the ten busiest accounts this month, then See all: a full-screen dialog, 20 a page
 *   - the Administrators card still lists every administrator, not just those on the first page
 *   - the recommended models save the moment a choice is made, and say so
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-admin-users-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-admin-users-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-admin-users-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /email \(no provider|^ {2}(to|subject):|confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const { initStore, getStore } = await import('../server/store/index.js');
await initStore();
const { createApp } = await import('../server/app.js');
const PORT = 5248;
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
page.setDefaultTimeout(8000);
page.on('pageerror', (err) => realLog(`  \x1b[31m[page error]\x1b[0m ${err.message}`));
/** Every request for accounts, so the page can be held to asking only for what it draws. */
const userCalls = [];
page.on('request', (r) => {
  const url = new URL(r.url());
  if (url.pathname === '/api/admin/users' && r.method() === 'GET') userCalls.push(url.search);
});
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate-username');
await page.fill('#gate-username', 'users.owner');
await page.fill('#gate-email', 'owner@test.local');
await page.fill('#gate-password', 'a-long-enough-password');
await page.check('#gate-consent');
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.waitForTimeout(800);

const store = getStore();
const owner = await store.getUserByEmail('owner@test.local');
const setLanguage = async (language) => store.setUserSetting(owner.id, 'prefs', { ...(await store.getUserSetting(owner.id, 'prefs')), language, onboarded: true });
await setLanguage('en');

/* Twenty-four members, the busiest first by number; one administrator with nothing spent, so on page 2 of everything. */
const member = (i) => `Member ${String(i).padStart(2, '0')}`;
for (let i = 1; i <= 24; i += 1) {
  const u = await store.createUser({ id: `u-member-${i}`, email: `member${String(i).padStart(2, '0')}@test.local`, name: member(i), passwordHash: 'x', role: 'user' });
  await store.recordUsage(u.id, { id: `ev-${i}`, model: 'm', inputTokens: (25 - i) * 1000, outputTokens: 0 });
}
await store.createUser({ id: 'u-helper-admin', email: 'helper@test.local', name: 'Zed Helper', passwordHash: 'x', role: 'admin' });
await store.upsertModels([
  { id: 'orcarouter/deepseek/deepseek-v4.1-flash-free', provider: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash-free', family: 'deepseek', label: 'DeepSeek V4.1 Flash (Free)', context: 1048576, maxOutput: 384000, priceIn: 0, priceOut: 0, isFree: true, releasedAt: new Date().toISOString(), vision: true },
  { id: 'openrouter/acme/big', provider: 'openrouter', model: 'acme/big', family: 'acme', label: 'Acme Big', context: 200000, maxOutput: 8000, priceIn: 1, priceOut: 2, isFree: false, releasedAt: new Date().toISOString(), vision: false },
  { id: 'openrouter/nvidia/nemotron:free', provider: 'openrouter', model: 'nvidia/nemotron:free', family: 'nvidia', label: 'Nemotron (free)', context: 128000, maxOutput: 8000, priceIn: 0, priceOut: 0, isFree: true, releasedAt: new Date().toISOString(), vision: false },
]);

const reload = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
};
const openPeople = async () => {
  await page.click('#account-button');
  await page.waitForTimeout(150);
  await page.click('.plusmenu--account [data-row="settings"]');
  await page.waitForSelector('#settings[open]');
  await page.click('#tab-admin');
  await page.waitForSelector('#user-list .rows__item');
  await page.waitForTimeout(300);
};

await reload();
await openPeople();

section('the notes under the headings are gone');
{
  const text = () => page.evaluate(() => document.getElementById('panel-admin').textContent.replace(/\s+/g, ' '));
  const gone = (said, words) => words.every((w) => !said.includes(w));
  const en = await text();
  check('English: no sign-up note, no suggestion note, no allowance note', gone(en, ['Anyone can sign up', 'Suggested to everyone', 'One allowance per service', 'Kept inside the free tiers']), en.slice(0, 200));
  const { en: enWords } = await import('../public/js/locales/en.js');
  const { vi: viWords } = await import('../public/js/locales/vi.js');
  const dead = ['admin.lede', 'recommend.lede', 'freetier.lede', 'freetier.enforced', 'freetier.enforcedFallback'];
  check('  and the words are gone from both locale files', dead.every((k) => !(k in enWords) && !(k in viWords)), dead.filter((k) => k in enWords || k in viWords).join());
  await setLanguage('vi');
  await reload();
  await openPeople();
  const vi = await text();
  check('Vietnamese: the same notes are gone', gone(vi, ['Ai cũng có thể đăng ký', 'Gợi ý cho mọi người', 'Mỗi dịch vụ có một hạn mức', 'Giữ trong hạn mức miễn phí']), vi.slice(0, 200));
  await setLanguage('en');
  await reload();
  await openPeople();
}

section('the ten busiest, then See all');
{
  const names = await page.evaluate(() => [...document.querySelectorAll('#user-list .rows__item .grow')].map((r) => r.textContent.trim().split('·')[0].trim()));
  check('exactly ten rows, busiest first', names.length === 10 && names.every((n, i) => n === member(i + 1)), names.join(' | '));
  const seeAll = page.locator('#users-see-all');
  check('a See all button says how many there are in all', (await seeAll.count()) === 1 && /See all 26/.test(await seeAll.innerText()), await seeAll.innerText().catch(() => ''));
  const admins = await page.evaluate(() => document.getElementById('admin-admins').textContent);
  check('the Administrators card still lists every administrator, though one is past the first ten', /helper@test\.local/.test(admins) && /owner@test\.local/.test(admins), admins.slice(0, 160));

  await seeAll.click();
  await page.waitForSelector('#users-all[open] .rows__item');
  await page.waitForTimeout(200);
  const box = await page.evaluate(() => {
    const d = document.getElementById('users-all');
    const r = d.getBoundingClientRect();
    return { rows: d.querySelectorAll('.rows__item').length, line: d.querySelector('[data-users-page]')?.textContent.trim(), w: r.width, h: r.height, inDialog: d.contains(document.activeElement) };
  });
  check('it opens with 20 rows on "Page 1 of 2"', box.rows === 20 && box.line === 'Page 1 of 2', JSON.stringify(box));
  check('  full screen: it fills the window', box.w >= 1200 && box.h >= 800, `${box.w}x${box.h}`);
  check('  and focus is inside it', box.inDialog);
  check('  the page line is a polite live region', await page.evaluate(() => { const l = document.querySelector('#users-all [data-users-page]'); return l.getAttribute('role') === 'status' && l.getAttribute('aria-live') === 'polite'; }));

  const line = await page.evaluateHandle(() => document.querySelector('#users-all [data-users-page]'));
  await page.click('#users-all [data-users-next]');
  await page.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('#users-all [data-users-page]').textContent));
  const second = await page.evaluate(() => ({ rows: document.querySelectorAll('#users-all .rows__item').length, same: true }));
  check('→ shows the rest: 6 rows on page 2', second.rows === 6, JSON.stringify(second));
  check('  the page line was updated in place, not recreated', await page.evaluate((el) => el.isConnected && el === document.querySelector('#users-all [data-users-page]'), line));
  await page.click('#users-all [data-users-prev]');
  await page.waitForFunction(() => /Page 1 of 2/.test(document.querySelector('#users-all [data-users-page]').textContent));
  check('← comes back', await page.evaluate(() => document.querySelectorAll('#users-all .rows__item').length === 20));

  await page.focus('#users-all [data-users-next]');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /Page 2 of 2/.test(document.querySelector('#users-all [data-users-page]').textContent));
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => /Page 1 of 2/.test(document.querySelector('#users-all [data-users-page]').textContent));
  check('the arrow keys turn pages when focus is on a button', true);

  // Inside a text field the arrows belong to the field: open a limit box and move the caret.
  const firstLimit = page.locator('#users-all [data-limit-user]').first();
  await firstLimit.click();
  const field = page.locator('#users-all input[type="number"]');
  await field.fill('5000');
  // On page 1 only a right arrow could move the page, so it is the one that can fail.
  await page.keyboard.press('ArrowRight');
  check('  but not in a text field', await page.evaluate(() => /Page 1 of 2/.test(document.querySelector('#users-all [data-users-page]').textContent)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('  (Esc leaves the limit field and keeps the dialog)', await page.evaluate(() => document.getElementById('users-all').open));

  // A row button inside the dialog: Suspend once, no second press.
  const target = 'member03@test.local';
  const row = page.locator('#users-all .rows__item', { hasText: target });
  await row.locator('[data-suspend-user]').click();
  await page.waitForFunction((email) => [...document.querySelectorAll('#users-all .rows__item')].some((r) => r.textContent.includes(email) && /Unsuspend/.test(r.textContent)), target);
  const after = await store.getUserByEmail(target);
  check('Suspend works inside the dialog with one press', !!after.suspended_at);
  check('  and the ten behind it show it too', await page.evaluate((email) => [...document.querySelectorAll('#user-list .rows__item')].some((r) => r.textContent.includes(email) && /Unsuspend/.test(r.textContent)), target));
  await row.locator('[data-suspend-user]').click();
  await page.waitForTimeout(400);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc closes it', await page.evaluate(() => !document.getElementById('users-all').open));
  check('  and focus returns to See all', await page.evaluate(() => document.activeElement?.id === 'users-see-all'), await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
}

section('a phone');
{
  await page.setViewportSize({ width: 360, height: 740 });
  await page.waitForTimeout(200);
  await page.click('#users-see-all');
  await page.waitForSelector('#users-all[open] .rows__item');
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const d = document.getElementById('users-all');
    const scrollers = [d, ...d.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1);
    return { sideways: scrollers.map((n) => `${n.tagName}.${n.className}:${n.scrollWidth}>${n.clientWidth}`).slice(0, 4), docWide: document.documentElement.scrollWidth > window.innerWidth };
  });
  check('the dialog does not scroll sideways at 360 px', m.sideways.length === 0 && !m.docWide, JSON.stringify(m));
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(200);
}

section('the recommended models save themselves');
{
  const saves = [];
  page.on('request', (r) => {
    if (r.method() === 'PUT' && /\/api\/admin\/recommended$/.test(new URL(r.url()).pathname)) saves.push(r.postData());
  });
  check('there is no Save button', (await page.locator('#rec-save').count()) === 0 && (await page.locator('#admin-recommended button', { hasText: /^Save$/ }).count()) === 0);
  await page.waitForSelector('#rec-free-second');
  await page.selectOption('#rec-free', 'orcarouter/deepseek/deepseek-v4.1-flash-free');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('rec-free-status')?.textContent || ''));
  check('choosing one sends one save', saves.length === 1, String(saves.length));
  check('  and says Saved beside it, in a polite live region', await page.evaluate(() => { const s = document.getElementById('rec-free-status'); return s.getAttribute('aria-live') === 'polite' && /Saved/.test(s.textContent); }));
  const { getRecommended } = await import('../server/recommend.js');
  check('  the choice is stored', (await getRecommended()).free === 'orcarouter/deepseek/deepseek-v4.1-flash-free');
  await page.selectOption('#rec-free-second', 'openrouter/nvidia/nemotron:free');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('rec-free-second-status')?.textContent || ''));
  const stored = await getRecommended();
  check('the second choice saves too, keeping the first', saves.length === 2 && stored.freeSecond === 'openrouter/nvidia/nemotron:free' && stored.free === 'orcarouter/deepseek/deepseek-v4.1-flash-free', JSON.stringify(stored));
  await page.waitForFunction(() => !document.getElementById('rec-free-status').textContent.trim(), null, { timeout: 8000 });
  check('"Saved" clears itself after a few seconds', true);

  // A refusal puts the old value back and says why, under the select.
  await page.route('**/api/admin/recommended', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Not that one.' }) }) : route.continue()));
  const before = await page.evaluate(() => document.getElementById('rec-free').value);
  await page.selectOption('#rec-free', 'openrouter/nvidia/nemotron:free');
  await page.waitForFunction(() => /Not that one\./.test(document.getElementById('rec-free-error')?.textContent || ''));
  const back = await page.evaluate(() => ({ value: document.getElementById('rec-free').value, enabled: !document.getElementById('rec-free').disabled, err: document.getElementById('rec-free-error').textContent }));
  check('a refused save puts the old value back and shows the error', back.value === before && back.enabled && /Not that one\./.test(back.err), JSON.stringify(back));
  await page.unroute('**/api/admin/recommended');
}

section('a paid model, the queue, and focus');
{
  const { getRecommended } = await import('../server/recommend.js');
  await page.selectOption('#rec-paid', 'openrouter/acme/big');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('rec-paid-status')?.textContent || ''));
  check('the paid choice saves too', (await getRecommended()).paid === 'openrouter/acme/big', JSON.stringify(await getRecommended()));

  // Hold the first save, fail it, and change the same select again meanwhile: the screen must end where the server does.
  let release;
  const held = new Promise((r) => (release = r));
  let puts = 0;
  await page.route('**/api/admin/recommended', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts += 1;
    if (puts === 1) {
      await held;
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Not that one.' }) });
    }
    return route.continue();
  });
  const change = (value) =>
    page.evaluate((v) => {
      const box = document.getElementById('rec-free');
      box.value = v;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  await change('openrouter/nvidia/nemotron:free');
  await page.waitForFunction(() => document.getElementById('rec-free').disabled);
  await change('auto');
  release();
  await page.waitForFunction(() => /Saved/.test(document.getElementById('rec-free-status')?.textContent || ''));
  await page.waitForTimeout(300);
  const end = await page.evaluate(() => ({ value: document.getElementById('rec-free').value, shown: document.querySelector('#admin-recommended .picker:has(#rec-free) .picker__btn').textContent.trim() }));
  const stored = await getRecommended();
  check('a change made while a save is out is sent after it, and is not undone by the first one failing', end.value === 'auto' && stored.free === 'auto' && puts === 2, JSON.stringify({ end, free: stored.free, puts }));
  check('  and the button shows what the select holds', /auto/i.test(end.shown), end.shown);
  await page.unroute('**/api/admin/recommended');

  // Keyboard: the picker's button is disabled while its save is out, which would drop focus to the page.
  await page.focus('#admin-recommended .picker:has(#rec-free) .picker__btn');
  await change('openrouter/nvidia/nemotron:free');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('rec-free-status')?.textContent || ''));
  await page.waitForTimeout(100);
  check("focus is back on the select's button once the save is over", await page.evaluate(() => document.activeElement?.classList.contains('picker__btn') && document.activeElement.nextElementSibling?.id === 'rec-free'), await page.evaluate(() => document.activeElement?.tagName + '.' + document.activeElement?.className));
}

section('the Administrators card: one search, one draw, no stale grants');
{
  const helperRow = '[data-admin="u-helper-admin"]';
  await page.click(helperRow + ' summary');
  await page.uncheck(helperRow + ' [data-power="themes"]');
  await page.waitForTimeout(300);
  await page.uncheck(helperRow + ' [data-power="feedback"]');
  await page.waitForTimeout(400);
  const saved = JSON.parse(JSON.stringify((await store.getUserByEmail('helper@test.local')).admin_permissions));
  const boxes = await page.evaluate((sel) => ({ themes: document.querySelector(sel + ' [data-power="themes"]').checked, feedback: document.querySelector(sel + ' [data-power="feedback"]').checked }), helperRow);
  check('two powers unticked one after the other are both gone, on screen and stored', !boxes.themes && !boxes.feedback && Array.isArray(saved) && !saved.includes('themes') && !saved.includes('feedback') && saved.length === 5, JSON.stringify({ boxes, saved }));

  await page.waitForSelector('#admin-add-search');
  check('the search has a label', (await page.locator('label[for="admin-add-search"]').count()) === 1);
  const optionCount = () => page.evaluate(() => document.querySelectorAll('#admin-add-person option').length);
  check('it starts with twenty people to choose from, not everyone', (await optionCount()) === 21, String(await optionCount()));
  const before = userCalls.length;
  await page.locator('#admin-add-search').pressSequentially('member 07', { delay: 30 });
  await page.waitForFunction(() => document.querySelectorAll('#admin-add-person option').length === 2);
  check('typing narrows the list, asking the server once or twice, not once a letter', userCalls.length - before <= 2 && userCalls.slice(before).every((q) => /q=/.test(q)), JSON.stringify(userCalls.slice(before)));

  // A slow answer for an older search must not paint over the newer one.
  await page.route('**/api/admin/users?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'member 1') await new Promise((r) => setTimeout(r, 900));
    return route.continue();
  });
  await page.fill('#admin-add-search', 'member 1');
  await page.waitForTimeout(400);
  await page.fill('#admin-add-search', 'member 05');
  await page.waitForTimeout(1500);
  const names = await page.evaluate(() => [...document.querySelectorAll('#admin-add-person option')].map((o) => o.textContent));
  check('a slow answer for an older search is dropped', names.length === 2 && /member05@test\.local/.test(names[1]), names.join(' | '));
  await page.unroute('**/api/admin/users?*');

  await page.selectOption('#admin-add-person', 'u-member-5');
  await page.check('.admins__add [data-power="feedback"]');
  await page.click('#admin-add-go');
  await page.waitForFunction(() => document.querySelector('[data-admin="u-member-5"]'));
  check('the person chosen from the search becomes an administrator', (await store.getUserByEmail('member05@test.local')).role === 'admin');

  check('no request for every account was made: each asked for a page, a role or a search', userCalls.length > 3 && userCalls.every((q) => /[?&](page|role|q)=/.test(q)), JSON.stringify(userCalls));
}

section('the limit field does not remove a limit by being left');
{
  await page.evaluate(async (id) => fetch('/api/admin/users/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monthlyTokenLimit: 7777 }) }), 'u-member-2');
  await reload();
  await openPeople();
  const row = page.locator('#user-list .rows__item', { hasText: 'member02@test.local' });
  await row.locator('[data-limit-user]').click();
  const shown = await page.locator('#user-list input[type="number"]').inputValue();
  check('the field opens with the limit already set', shown === '7777', shown);
  await page.locator('#user-list input[type="number"]').blur();
  await page.waitForTimeout(500);
  check('  and leaving it as it was keeps the limit', Number((await store.getUserByEmail('member02@test.local')).monthly_token_limit) === 7777);
  await row.locator('[data-limit-user]').click();
  await page.fill('#user-list input[type="number"]', '');
  await page.locator('#user-list input[type="number"]').blur();
  await page.waitForTimeout(500);
  check('  and leaving it empty does not clear it either', Number((await store.getUserByEmail('member02@test.local')).monthly_token_limit) === 7777);
  await row.locator('[data-limit-user]').click();
  await page.fill('#user-list input[type="number"]', '9000');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  check('  but a new number is saved', Number((await store.getUserByEmail('member02@test.local')).monthly_token_limit) === 9000);
}

await browser.close();
server.close();
realLog(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : '\n\x1b[32mAll checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
