/**
 * What the owner's screenshots of 2026-11-04 were about, in a real browser, where
 * a width is measured and a colour is computed rather than assumed:
 *
 *   - Usage: the Overview adds up, a provider's page has the keys, and neither warns
 *     about a key nobody is spending
 *   - a choice in Settings is drawn by the app, under its button
 *   - words can be read on both themes, code blocks first
 *   - a chart stays inside its picture, with the real font
 *   - a tool row names the file, and a search says what it found
 *   - reasoning stays reasoning
 *   - the owner adds an administrator, who sees what they were given
 *
 *   npm run test:ui
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-round-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-round-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-round-test');
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
const { renderChart } = await import('../server/tools/chart.js');
const PORT = 5196;
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
page.on('pageerror', (err) => {
  pageErrors.push(err.message);
  realLog(`  \x1b[31m[page error]\x1b[0m ${err.message}\n${String(err.stack || '').split('\n').slice(1, 4).join('\n')}`);
});
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));

const closeDialogs = () => page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

const signUp = async (p, username, email) => {
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#gate-username');
  await p.fill('#gate-username', username);
  await p.fill('#gate-email', email);
  await p.fill('#gate-password', 'a-long-enough-password');
  await p.check('#gate-consent');
  await p.click('#gate-submit');
  await p.waitForSelector('#model-chip');
  await p.waitForTimeout(1000);
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
};
await signUp(page, 'round.owner', 'round@test.local');

const store = getStore();
const me = await store.getUserByEmail('round@test.local');
await store.setUserSetting(me.id, 'prefs', { ...(await store.getUserSetting(me.id, 'prefs')), language: 'en', onboarded: true });

const reload = async (p = page) => {
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#model-chip');
  await p.waitForTimeout(800);
  await p.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));
};
const openSettings = async (tab, p = page) => {
  await p.click('#account-button');
  await p.waitForTimeout(150);
  await p.click('.plusmenu--account [data-row="settings"]');
  await p.waitForSelector('#settings[open]');
  await p.click(`#tab-${tab}`);
  await p.waitForTimeout(350);
};
const setTheme = (theme) => page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);

await reload();

/* ── Usage ───────────────────────────────────────────────────────── */
section('Usage: the Overview adds up, and warns only about what is being spent');
{
  // The owner's screenshot: key 1 at 51 of 50, key 2 at 2 of 50 and in use.
  const report = (a = 51, b = 2, inUse = 1) => ({
    generatedAt: new Date().toISOString(),
    hours: [],
    month: { tokens: 10, calls: 3, cost: 0 },
    monthByProvider: {},
    sharedLimit: null,
    live: {
      openrouter: [
        { index: 0, ok: true, freeToday: { used: a, limit: 50, remaining: Math.max(0, 50 - a) }, spend: { today: 0, week: 0, month: 0 }, limit: { amount: 50, remaining: 50, reset: null }, budget: null, neverPaid: true },
        { index: 1, ok: true, freeToday: { used: b, limit: 50, remaining: Math.max(0, 50 - b) }, spend: { today: 0, week: 0, month: 0 }, limit: { amount: 50, remaining: 50, reset: null }, budget: null, neverPaid: true },
      ],
      orcarouter: [{ index: 0, ok: true, balance: 6 }],
    },
    free: { orcarouter: { used: 120, limit: 800, tier: 'high', tiers: [{ minPaidUsd: 0, rpm: 10, rpd: 50 }, { minPaidUsd: 20, rpm: 20, rpd: 800 }], models: [] } },
    inUse: { openrouter: inUse },
    sharedKey: {},
  });
  let answer = report();
  await page.route('**/api/usage/report*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }));
  await store.setUserSetting(me.id, 'providerKeys', {});
  const { addApiKey } = await import('../server/settings.js');
  await addApiKey(me.id, 'openrouter', 'sk-or-v1-round-key-one-000000004c3e');
  await addApiKey(me.id, 'openrouter', 'sk-or-v1-round-key-two-00000000cd27');
  await addApiKey(me.id, 'orcarouter', 'sk-orca-round-key-000000000001');
  await reload();
  await openSettings('usage');
  const read = () =>
    page.evaluate(() => ({
      head: document.querySelector('#usage-panel .usage__head')?.textContent.trim() || '',
      headTone: document.querySelector('#usage-panel .usage__head')?.className || '',
      bars: [...document.querySelectorAll('#usage-panel .usage__limits .usage__limit')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      money: document.querySelector('#usage-panel')?.textContent.replace(/\s+/g, ' ') || '',
      banner: !document.getElementById('usage-alert').hidden,
      said: document.getElementById('usage-alert')?.textContent.replace(/\s+/g, ' ').trim() || '',
      tabs: [...document.querySelectorAll('#usage-panel [data-scope]')].map((t) => t.textContent.trim()),
    }));
  await page.waitForTimeout(400);
  const overview = await read();
  check('the Overview has a tab per provider', overview.tabs.join() === 'Overview,OpenRouter,OrcaRouter', overview.tabs.join());
  check('its lines are totals, with no key named', overview.bars.length >= 2 && overview.bars.every((b) => !/Key \d/.test(b)), overview.bars.join(' | '));
  check('  52 of 100 across the two keys', overview.bars.some((b) => /OpenRouter/.test(b) && /52 of 100/.test(b)), overview.bars.join(' | '));
  check('  OrcaRouter by itself, and it says who counted', overview.bars.some((b) => /OrcaRouter/.test(b) && /120 of 800/.test(b) && /counted by Synapsez/.test(b)), overview.bars.join(' | '));
  check('no warning at the top: the screenshot said "used all your free requests"', !/is-(out|close)/.test(overview.headTone) && !/used all/.test(overview.head), overview.head);
  check('  and none above the composer', overview.banner === false, overview.said);
  check('the money is one line for the provider too', /OrcaRouter.*Balance OrcaRouter reports: \$6\.00/.test(overview.money) && !/Key 1.*Spent/.test(overview.money));

  await page.click('#usage-panel [data-scope="openrouter"]');
  await page.waitForTimeout(150);
  const openrouter = await read();
  check("the provider's page has each key, with its last characters", openrouter.bars.filter((b) => /Key 1 \(…4c3e\)/.test(b)).length >= 1 && openrouter.bars.filter((b) => /Key 2 \(…cd27\)/.test(b)).length >= 1, openrouter.bars.join(' | '));
  check('  key 1 is out, and its bar shows it', await page.evaluate(() => !!document.querySelector('#usage-panel .usage__bar.is-out')));
  check('  and still no warning: key 2 is the one being spent', !/is-(out|close)/.test(openrouter.headTone) && !/used all/.test(openrouter.head), openrouter.head);

  // Key 2 in use and nearly gone: the page warns, the Overview's total does not.
  answer = report(0, 45);
  await page.click('#usage-panel [data-refresh]');
  await page.waitForTimeout(400);
  const nearKey = await read();
  check("the key in use at 90% warns on the provider's page", /is-close/.test(nearKey.headTone) && /Key 2/.test(nearKey.head), nearKey.head);
  check('  naming that key', /…cd27/.test(nearKey.head), nearKey.head);
  check('  while the total, at 45%, raises nothing above the composer', nearKey.banner === false, nearKey.said);

  // The total past 80%: both say so, in the same figures.
  answer = report(50, 35, 1);
  await page.click('#usage-panel [data-refresh]');
  await page.waitForTimeout(400);
  await page.click('#usage-panel [data-scope="all"]');
  await page.waitForTimeout(150);
  const nearTotal = await read();
  check('the total at 85% warns on the Overview', /is-close/.test(nearTotal.headTone) && /85%/.test(nearTotal.head), nearTotal.head);
  check('  and above the composer, in the same figure', nearTotal.banner === true && /85%/.test(nearTotal.said), nearTotal.said);
  check('  with no key named in either', !/Key \d/.test(nearTotal.head) && !/Key \d/.test(nearTotal.said), `${nearTotal.head} / ${nearTotal.said}`);

  answer = report(50, 50, null);
  await page.click('#usage-panel [data-refresh]');
  await page.waitForTimeout(400);
  const out = await read();
  check('every key out says so', /is-out/.test(out.headTone) && /used all/.test(out.head), out.head);
  check('  and the composer agrees', out.banner === true && /used all/.test(out.said), out.said);

  // OrcaRouter's page: its credit, its note, and no invented ceiling.
  answer = { ...report(), free: { orcarouter: { used: 30, limit: null, tier: null, tiers: [{ minPaidUsd: 0, rpm: 10, rpd: 50 }, { minPaidUsd: 20, rpm: 20, rpd: 800 }], models: [] } } };
  await page.click('#usage-panel [data-refresh]');
  await page.waitForTimeout(400);
  await page.click('#usage-panel [data-scope="orcarouter"]');
  await page.waitForTimeout(150);
  const orca = await read();
  check('OrcaRouter with no ceiling known draws no bar, and says both', orca.bars.length === 0 && /30 free model requests today/.test(orca.money) && /50 a day/.test(orca.money) && /800 a day from 20 USD/.test(orca.money), orca.money.slice(0, 200));
  check('  says the count is ours and the limit per workspace', /Synapsez’s own/.test(orca.money) && /per workspace/.test(orca.money));
  check('  with its balance', /Balance OrcaRouter reports: \$6\.00/.test(orca.money));
  await page.unroute('**/api/usage/report*');
  await closeDialogs();
}

/* ── A choice ────────────────────────────────────────────────────── */
section('a choice in Settings is drawn by the app, under its button');
{
  await openSettings('capabilities');
  const box = () => page.locator('.picker:has(#auto-preview) .picker__btn');
  check('the select is still there, and the button says what it holds', await page.evaluate(() => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview'));
    return !!select && select.selectedOptions[0].textContent.trim() === select.closest('.picker').querySelector('.picker__btn').textContent.trim();
  }));
  check('  which is named for a screen reader by its label', await page.evaluate(() => {
    const button = document.querySelector('.picker:has(#auto-preview) .picker__btn');
    return document.getElementById(button.getAttribute('aria-labelledby'))?.getAttribute('for') === 'auto-preview' && button.getAttribute('role') === 'combobox';
  }));
  const before = await page.evaluate(() => /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview')).value);
  await box().click();
  await page.waitForSelector('.picker__menu');
  const menu = await page.evaluate(() => {
    const list = document.querySelector('.picker__menu');
    const button = document.querySelector('.picker:has(#auto-preview) .picker__btn').getBoundingClientRect();
    const rect = list.getBoundingClientRect();
    const first = list.querySelector('.picker__name');
    return {
      rightGap: Math.round(button.right - rect.right),
      below: Math.round(rect.top - button.bottom),
      windowGap: Math.round(window.innerWidth - rect.right),
      textAlign: getComputedStyle(first).textAlign,
      left: getComputedStyle(list).position,
      options: [...list.querySelectorAll('[role="option"]')].map((o) => ({ name: o.querySelector('.picker__name').textContent, desc: o.querySelector('.picker__desc')?.textContent || '', on: o.getAttribute('aria-selected') === 'true', tick: !!o.querySelector('.picker__tick') })),
      inDialog: !!list.closest('dialog'),
      focused: document.activeElement?.getAttribute('role'),
      background: getComputedStyle(list).backgroundColor,
    };
  });
  check('it opens under its button, its right edge lined up with it', menu.below >= 0 && menu.below < 16 && Math.abs(menu.rightGap) <= 2, JSON.stringify(menu));
  check('  clear of the window, not flush against it', menu.windowGap >= 8, String(menu.windowGap));
  check('  read from the left, as words are', /left|start/.test(menu.textAlign), menu.textAlign);
  check('  each choice says what it does', menu.options.length === 2 && menu.options.every((o) => o.desc.length > 10), JSON.stringify(menu.options));
  check('  the one chosen is ticked, and only that one', menu.options.filter((o) => o.tick).length === 1 && menu.options.find((o) => o.tick).on);
  check('  inside the dialog, so a modal does not make it dead', menu.inDialog);
  check('  and the keyboard is on it', menu.focused === 'option');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  check('Escape closes the list and not the Settings behind it', !(await page.$('.picker__menu')) && (await page.evaluate(() => document.getElementById('settings').open)));
  check('  back on the button', await page.evaluate(() => document.activeElement?.classList.contains('picker__btn')));

  const saves = [];
  const onRequest = (r) => {
    if (r.method() !== 'GET' && /\/api\/prefs/.test(r.url())) saves.push(r.postData() || '');
  };
  page.on('request', onRequest);
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.picker__menu');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  const other = before === 'on' ? 'off' : 'on';
  await page.locator(`.picker__menu [role="option"]:nth-child(${other === 'on' ? 1 : 2})`).click();
  await page.waitForTimeout(350);
  page.off('request', onRequest);
  check('pressing a choice sets the select, and closes', (await page.evaluate(() => /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview')).value)) === other && !(await page.$('.picker__menu')));
  check('  the button says so', await page.evaluate(() => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview'));
    return select.closest('.picker').querySelector('.picker__btn').textContent.trim() === select.selectedOptions[0].textContent.trim();
  }));
  check('  and the page saved it as it always did, by the change event', saves.some((b) => /autoPreview/.test(b)), saves.join(' | '));
  await page.evaluate((value) => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview'));
    select.value = value;
  }, before);
  check('a value set by code shows on the button too', await page.evaluate(() => {
    const select = /** @type {HTMLSelectElement} */ (document.getElementById('auto-preview'));
    return select.closest('.picker').querySelector('.picker__btn').textContent.trim() === select.selectedOptions[0].textContent.trim();
  }));

  // Every choice in Settings is one of these now.
  const native = await page.evaluate(() => [...document.querySelectorAll('#settings select')].filter((s) => !/** @type {HTMLElement} */ (s).dataset.picker).map((s) => s.id));
  check('no select in Settings is left to the browser', native.length === 0, native.join());

  // At the bottom of a window, it opens upward rather than off the screen.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.evaluate(() => document.getElementById('tool-loading').closest('.srow').scrollIntoView({ block: 'end' }));
  await page.waitForTimeout(120);
  await page.locator('.picker:has(#auto-compact) .picker__btn').scrollIntoViewIfNeeded();
  await page.locator('.picker:has(#auto-compact) .picker__btn').click();
  await page.waitForSelector('.picker__menu');
  const low = await page.evaluate(() => {
    const rect = document.querySelector('.picker__menu').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: innerHeight };
  });
  check('it never leaves the window', low.top >= 0 && low.bottom <= low.height, JSON.stringify(low));
  await page.keyboard.press('Escape');

  // On a phone, wide enough to read and inside the screen.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(150);
  await page.locator('.picker:has(#auto-compact) .picker__btn').scrollIntoViewIfNeeded();
  await page.locator('.picker:has(#auto-compact) .picker__btn').click();
  await page.waitForSelector('.picker__menu');
  const phone = await page.evaluate(() => {
    const rect = document.querySelector('.picker__menu').getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  check('on a phone it stays inside the screen', phone.left >= 0 && phone.right <= phone.width, JSON.stringify(phone));
  // The keyboard opening is a resize, on a phone. The list stays, and moves.
  await page.setViewportSize({ width: 390, height: 500 });
  await page.waitForTimeout(150);
  check('a resize keeps the list open, as a phone keyboard opening is one', !!(await page.$('.picker__menu')));
  const moved = await page.evaluate(() => {
    const rect = document.querySelector('.picker__menu')?.getBoundingClientRect();
    return rect && rect.bottom <= innerHeight && rect.top >= 0;
  });
  check('  inside what is left of the screen', moved);
  await page.evaluate(() => document.querySelector('.picker:has(#auto-compact)').remove());
  await page.waitForTimeout(120);
  check('a list whose choice has gone from the page goes too', !(await page.$('.picker__menu')));
  await page.setViewportSize({ width: 1280, height: 860 });
  await closeDialogs();
  await reload();
}

/* ── A chat, seeded ──────────────────────────────────────────────── */
const fileId = '7e25a809-8b9c-4c63-bf09-ad48855768f0';
const at = new Date().toISOString();
const seedChat = async () => {
  await store.createChat(me.id, { id: 'c-round', title: 'A round of things', model: 'auto' });
  const say = (message) => store.appendMessage(me.id, 'c-round', { createdAt: at, ...message });
  await say({ id: 'r-u', role: 'user', text: 'Make me things' });
  // A report made, then rewritten by id.
  await say({ id: 'r-a1', role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'create_file', input: { name: 'Toi uu hoa mo hinh', format: 'docx', content: '# x' } }] });
  await say({ id: 'r-t1', role: 'tool', results: [{ toolCallId: 't1', name: 'create_file', content: 'Created', file: { id: fileId, name: 'Toi uu hoa mo hinh.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'office', bytes: 1000 } }] });
  await say({ id: 'r-a2', role: 'assistant', text: '', toolCalls: [{ id: 't2', name: 'update_file', input: { file_id: fileId, append: true, content: 'more' } }] });
  await say({ id: 'r-t2', role: 'tool', results: [{ toolCallId: 't2', name: 'update_file', content: 'Updated', file: { id: fileId, name: 'Toi uu hoa mo hinh.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'office', bytes: 2000 } }] });
  // A file this page has never heard of: the result names it; before that, nothing does.
  await say({ id: 'r-a3', role: 'assistant', text: '', toolCalls: [{ id: 't3', name: 'read_generated_file', input: { file_id: 'aaaaaaaa-1111-2222-3333-444444444444' } }] });
  await say({ id: 'r-t3', role: 'tool', results: [{ toolCallId: 't3', name: 'read_generated_file', content: 'source' }] });
  // A search that found nothing, and the page read straight after it: screenshot 12.
  await say({ id: 'r-a4', role: 'assistant', text: '', toolCalls: [{ id: 't4', name: 'web_search', input: { query: 'SePay pricing plans' } }] });
  await say({ id: 'r-t4', role: 'tool', results: [{ toolCallId: 't4', name: 'web_search', content: 'No results for "SePay pricing plans". Tried: Exa (no results).' }] });
  await say({ id: 'r-a5', role: 'assistant', text: '', toolCalls: [{ id: 't5', name: 'web_fetch', input: { url: 'https://sepay.vn/bang-gia.html' } }] });
  await say({ id: 'r-t5', role: 'tool', results: [{ toolCallId: 't5', name: 'web_fetch', content: '<untrusted source="sepay">\nBảng giá SePay\n</untrusted>' }] });
  // No engine could look at all.
  await say({ id: 'r-a6', role: 'assistant', text: 'Between the searches.' });
  await say({ id: 'r-a7', role: 'assistant', text: '', toolCalls: [{ id: 't6', name: 'web_search', input: { query: 'Engines all down' } }] });
  await say({ id: 'r-t6', role: 'tool', results: [{ toolCallId: 't6', name: 'web_search', content: 'No results for "Engines all down". Tried: DuckDuckGo (DuckDuckGo served a rate-limit page rather than results.).' }] });
  await say({ id: 'r-a8', role: 'assistant', text: 'And the web really having nothing.' });
  await say({ id: 'r-a9', role: 'assistant', text: '', toolCalls: [{ id: 't7', name: 'web_search', input: { query: 'Nothing at all' } }] });
  await say({ id: 'r-t7', role: 'tool', results: [{ toolCallId: 't7', name: 'web_search', content: 'No results for "Nothing at all". Tried: Exa (no results), DuckDuckGo (no results).' }] });
  // Screenshot 9: reasoning, stored with no answer.
  await say({ id: 'r-a10', role: 'assistant', text: '', thinking: 'Let me verify these with calculate. Then answer structure: which' });
  // A code block, and everything else a reply draws.
  const chart = renderChart({ type: 'line', title: 'Revenue by plan', format: 'currency', data: { labels: ['$200', '$1,000', '$100,000'], series: [{ name: 'A. 5.5% flat (OpenRouter Standard)', values: [11, 55, 2600] }, { name: 'B. Hybrid: $99 + 3%', values: [100, 110, 198] }, { name: 'C. Flat subscription (OrcaRouter $499)', values: [499, 499, 499] }, { name: 'D. Hybrid proposed: $99 + 1.1%', values: [1, 10, 99] }] } });
  await say({ id: 'r-a11', role: 'assistant', text: '', toolCalls: [{ id: 't8', name: 'chart', input: { title: 'Revenue by plan', type: 'line' } }] });
  await say({ id: 'r-t8', role: 'tool', results: [{ toolCallId: 't8', name: 'chart', content: 'Drew it', widget: { kind: 'chart', title: 'Revenue by plan', markup: chart, spec: { type: 'line', format: 'currency', labels: ['$200', '$1,000', '$100,000'], series: [{ name: 'A', values: [11, 55, 2600] }, { name: 'B', values: [100, 110, 198] }, { name: 'C', values: [499, 499, 499] }, { name: 'D', values: [1, 10, 99] }] } } }] });
  await say({ id: 'r-a12', role: 'assistant', text: 'Here is **code**:\n\n```html\n<img src="https://raw.example/pet.gif" alt="pet" />\nconst answer = 42;\n```\n\nAnd `inline code`, a [link](https://example.com), and:\n\n| Plan | Fee |\n|---|---|\n| Free | 0 |\n\n> A quotation\n' });
};
await seedChat();
await reload();
await page.click('.chat-row[data-chat="c-round"] .chat-item');
await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'A round of things');
await page.waitForTimeout(500);

section('a tool row names the file, never its id');
{
  const rows = await page.evaluate(() => [...document.querySelectorAll('#messages .tool > summary, #messages .step__label')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  const rewrite = rows.find((r) => /Rewrote|Viết lại/i.test(r) && /Toi uu hoa mo hinh\.docx/.test(r));
  check('the rewrite says the name of the file', !!rewrite, rows.join(' | '));
  const text = await page.evaluate(() => document.getElementById('messages').textContent);
  check('no id anywhere a person reads, even on a file the page has not met', !rows.some((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r)), rows.filter((r) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(r)).join(' | '));
  check('  which reads as "a file"', rows.some((r) => /a file|một tệp|tệp/i.test(r)), rows.join(' | '));
  check('(the transcript drew)', text.length > 0);
}

section('sums are one card, a call not run is no row, a rewritten file is one card');
{
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await store.createChat(me.id, { id: 'c-steps', title: 'One step at a time', model: 'auto' });
  const say = (message) => store.appendMessage(me.id, 'c-steps', { createdAt: at, ...message });
  await say({ id: 's-u', role: 'user', text: 'Work it out and write it up' });
  // Sums over two steps, side by side and as a list, with one that fails.
  await say({ id: 's-a1', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'calculate', input: { expression: '57*25744' } }, { id: 'c2', name: 'calculate', input: { expression: '1467408/12' } }] });
  await say({ id: 's-t1', role: 'tool', results: [{ toolCallId: 'c1', name: 'calculate', content: '57*25744 = 1467408' }, { toolCallId: 'c2', name: 'calculate', content: '1467408/12 = 122284' }] });
  await say({ id: 's-a2', role: 'assistant', text: '', toolCalls: [{ id: 'c3', name: 'calculate', input: { expression: '[1+1, 2+2]' } }, { id: 'c4', name: 'calculate', input: { expression: '1/0' } }] });
  await say({ id: 's-t2', role: 'tool', results: [{ toolCallId: 'c3', name: 'calculate', content: '1+1 = 2\n2+2 = 4' }, { toolCallId: 'c4', name: 'calculate', content: 'That divides by zero, which has no answer.', isError: true }] });
  // The report: a write that failed, and the read beside it that never ran.
  await say({ id: 's-a3', role: 'assistant', text: '', toolCalls: [{ id: 'f1', name: 'update_file', input: { file_id: fileId, edits: [{ find: 'x', replace: 'y' }] } }, { id: 'f2', name: 'read_generated_file', input: { file_id: fileId } }] });
  await say({ id: 's-t3', role: 'tool', results: [{ toolCallId: 'f1', name: 'update_file', content: 'Edit 1 did not match.', isError: true }, { toolCallId: 'f2', name: 'read_generated_file', content: 'Not run: update_file failed.', isError: true, skipped: true }] });
  // Written twice, in two steps, the second shown to the model.
  await say({ id: 's-a4', role: 'assistant', text: '', toolCalls: [{ id: 'f3', name: 'update_file', input: { file_id: fileId, content: 'a' } }] });
  await say({ id: 's-t4', role: 'tool', results: [{ toolCallId: 'f3', name: 'update_file', content: 'Rewrote', file: { id: fileId, name: 'Toi uu hoa mo hinh.docx', mime, kind: 'office', bytes: 2000 } }] });
  await say({ id: 's-a5', role: 'assistant', text: '', toolCalls: [{ id: 'f4', name: 'update_file', input: { file_id: fileId, content: 'b' } }] });
  await say({ id: 's-t5', role: 'tool', results: [{ toolCallId: 'f4', name: 'update_file', content: 'Rewrote\n\n[a.docx has 1 page. Check all of it. Do not mention this check unless it changed something.]', looked: true, pictures: [{ id: fileId, name: 'a.docx (Page 1).jpg', label: 'Page 1' }], file: { id: fileId, name: 'Toi uu hoa mo hinh.docx', mime, kind: 'office', bytes: 3000 } }] });
  await say({ id: 's-a6', role: 'assistant', text: 'Done.' });
  await reload();
  await page.click('.chat-row[data-chat="c-steps"] .chat-item');
  await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'One step at a time');
  await page.waitForTimeout(400);
  const seen = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#messages details.steps[data-family="calc"]')];
    const rows = [...document.querySelectorAll('#messages .step--calc')];
    return {
      cards: cards.length,
      open: cards[0]?.open,
      summary: cards[0]?.querySelector('summary')?.textContent.replace(/\s+/g, ' ').trim() || '',
      rows: rows.map((r) => [r.querySelector('.calc__expr')?.textContent || '', r.querySelector('.calc__value')?.textContent || ''].join('=')),
      error: !!document.querySelector('#messages .step--calc.step--error .calc__why'),
      headlines: [...document.querySelectorAll('#messages .tool > summary')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      fileCards: document.querySelectorAll('#messages .filecard').length,
      looked: document.querySelectorAll('#messages .tool__looked').length,
      thumbs: document.querySelectorAll('#messages .tool .steps__thumbs .pic-thumb').length,
      output: [...document.querySelectorAll('#messages .tool pre')].map((n) => n.textContent).join(' '),
    };
  });
  check('sums over two steps are one card', seen.cards === 1, JSON.stringify(seen.summary));
  check('folded: nothing to scroll past', seen.open === false);
  check('each figure is a row with its working and its answer, a list too', seen.rows.join('|') === '57*25744=1467408|1467408/12=122284|1+1=2|2+2=4|1/0=', seen.rows.join('|'));
  check('the card counts them', /4/.test(seen.summary), seen.summary);
  check('a sum that failed says why, in the same card', seen.error);
  check('the failed write has its row', seen.headlines.filter((h) => /Rewrote|Viết lại|Toi uu/i.test(h)).length === 3, seen.headlines.join(' | '));
  check('the read that never ran has none', !seen.headlines.some((h) => /read back|Đọc lại/i.test(h)), seen.headlines.join(' | '));
  check('a file rewritten in the next step is one card', seen.fileCards === 1, String(seen.fileCards));
  check('the row says the file was checked, and shows what was looked at', seen.looked === 1 && seen.thumbs === 1, JSON.stringify([seen.looked, seen.thumbs]));
  check('the note to the model is not printed', !/Do not mention this check/.test(seen.output));
  await reload();
  await page.click('.chat-row[data-chat="c-round"] .chat-item');
  await page.waitForFunction(() => document.getElementById('chat-title').textContent === 'A round of things');
  await page.waitForTimeout(500);
}

section('a search says what it found');
{
  const lines = await page.evaluate(() => [...document.querySelectorAll('#messages .web')].map((w) => ({ query: w.querySelector('.web__query')?.textContent || '', count: w.querySelector('.web__count')?.textContent || '', title: w.querySelector('.web__count')?.getAttribute('title') || '', rows: w.querySelectorAll('.webrow').length })));
  const sepay = lines.find((l) => /SePay/.test(l.query));
  check('a page read after an empty search is counted, not "0 results"', sepay?.rows === 1 && /^1 /.test(sepay.count), JSON.stringify(sepay));
  const down = lines.find((l) => /Engines all down/.test(l.query));
  check('no engine able to look says that', /did not respond/.test(down?.count || ''), JSON.stringify(down));
  check('  with why, on hover', /rate-limit page/.test(down?.title || ''), down?.title);
  const nothing = lines.find((l) => /Nothing at all/.test(l.query));
  check('and the web having nothing is still zero', /^0 /.test(nothing?.count || ''), JSON.stringify(nothing));
}

section('reasoning stays reasoning');
{
  const seen = await page.evaluate(() => {
    const prose = [...document.querySelectorAll('#messages .prose')].map((n) => n.textContent);
    const thoughts = [...document.querySelectorAll('#messages .think')].map((n) => n.textContent);
    return { answer: prose.some((t) => /Let me verify/.test(t)), thought: thoughts.some((t) => /Let me verify/.test(t)) };
  });
  check('a trace cut off with no answer is not drawn as an answer', !seen.answer, JSON.stringify(seen));
  check('  it is in the reasoning card', seen.thought, JSON.stringify(seen));
}

section('a chart stays inside its picture, with the real font');
{
  const measure = (selector) =>
    page.evaluate((sel) => {
      const svg = document.querySelector(sel);
      if (!svg) return { error: 'no chart' };
      const box = svg.viewBox.baseVal;
      const out = [];
      for (const text of svg.querySelectorAll('text')) {
        const b = text.getBBox();
        const m = text.getCTM();
        const s = svg.getCTM();
        // In the drawing's own units, through any transform on the way (the legend's).
        const toLocal = s.inverse().multiply(m);
        const left = toLocal.a * b.x + toLocal.c * b.y + toLocal.e;
        const top = toLocal.b * b.x + toLocal.d * b.y + toLocal.f;
        const right = toLocal.a * (b.x + b.width) + toLocal.c * (b.y + b.height) + toLocal.e;
        const bottom = toLocal.b * (b.x + b.width) + toLocal.d * (b.y + b.height) + toLocal.f;
        if (Math.min(left, right) < box.x - 0.5 || Math.max(left, right) > box.x + box.width + 0.5 || Math.min(top, bottom) < box.y - 0.5 || Math.max(top, bottom) > box.y + box.height + 0.5) out.push(`${text.textContent}: ${left.toFixed(0)}..${right.toFixed(0)} of ${box.width}`);
      }
      return { texts: svg.querySelectorAll('text').length, out, legend: [...svg.querySelectorAll('.legend-item text')].map((t) => t.textContent), width: svg.getBoundingClientRect().width };
    }, selector);
  const seen = await measure('#messages .chart__stage svg');
  check("the owner's chart: nothing past any edge", seen.texts > 5 && seen.out?.length === 0, JSON.stringify(seen.out));
  check('  all four legend entries, whole', seen.legend?.length === 4 && seen.legend.every((name) => !name.endsWith('…')), JSON.stringify(seen.legend));
  const fits = await page.evaluate(() => {
    const stage = document.querySelector('#messages .chart__stage');
    const svg = stage.querySelector('svg').getBoundingClientRect();
    const frame = stage.getBoundingClientRect();
    return svg.left >= frame.left - 1 && svg.right <= frame.right + 1 && stage.scrollWidth <= stage.clientWidth + 1;
  });
  check('  and the picture inside its frame', fits);

  // Every form, at a width a phone has, on the real font.
  const long = 'Doanh thu ròng của nền tảng trên mỗi khách hàng mỗi tháng theo từng mô hình kinh doanh khác nhau';
  const names = ['A. 5,5% thuần (OpenRouter Standard)', 'B. Hybrid đúng: $99 + 3%', 'C. Thuê bao thuần (OrcaRouter $499)', 'D. Hybrid đề xuất: $99 + 1,1%', 'E. Một mô hình nữa với cái tên rất dài để xem nó có xuống dòng không', 'F. Thêm một cái'];
  const data = { labels: ['$200', '$1.000', '$5.000', '$20.000', '$100.000'], series: names.map((name, i) => ({ name, values: [1200 * (i + 1), 42000, 5, 777777, 2600 / (i + 1)] })) };
  for (const type of ['bar', 'hbar', 'line', 'stacked', 'pie']) {
    const markup = renderChart({ type, title: long, data, format: 'currency' });
    await page.evaluate((html) => {
      document.getElementById('round-probe')?.remove();
      const host = document.createElement('div');
      host.id = 'round-probe';
      host.style.cssText = 'position:fixed;left:0;top:0;width:340px;z-index:9999;background:#000';
      host.innerHTML = html;
      document.body.append(host);
    }, markup);
    const each = await measure('#round-probe svg');
    check(`  ${type}: nothing past any edge`, each.out?.length === 0, JSON.stringify(each.out?.slice(0, 3)));
  }
  await page.evaluate(() => document.getElementById('round-probe')?.remove());
}

/* ── Contrast ────────────────────────────────────────────────────── */
/**
 * Every piece of words on screen, against what it actually sits on: the owner's
 * screenshot was a code block whose text had vanished on the light theme, and
 * asked for anything else like it to be found.
 */
const lowContrast = (selector, least) =>
  page.evaluate(([sel, floor]) => {
    const parse = (value) => {
      const m = String(value).match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b, a = '1'] = m[1].split(/[,\s/]+/).filter(Boolean);
        return [Number(r), Number(g), Number(b), Number(a)];
      }
      // color(srgb r g b / a), which a color-mix computes to.
      const c = String(value).match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
      if (c) return [Number(c[1]) * 255, Number(c[2]) * 255, Number(c[3]) * 255, c[4] === undefined ? 1 : Number(c[4])];
      return null;
    };
    const over = (top, under) => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const ground = (node) => {
      const layers = [];
      for (let el = node; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        // A picture behind the words: there is no one colour to measure against.
        if (style.backgroundImage !== 'none' && !/url\("data:image\/svg/.test(style.backgroundImage)) return null;
        const colour = parse(style.backgroundColor);
        if (colour && colour[3] > 0) {
          layers.push(colour);
          if (colour[3] >= 1) break;
        }
      }
      let out = parse(getComputedStyle(document.documentElement).backgroundColor);
      if (!out || out[3] < 1) out = document.documentElement.dataset.theme === 'light' ? [247, 249, 251, 1] : [10, 12, 16, 1];
      for (const layer of layers.reverse()) out = over(layer, out);
      return out;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const found = [];
    for (const host of document.querySelectorAll(sel)) {
      const walker = document.createTreeWalker(host, window.NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const el = node.parentElement;
        if (!el || el.closest('svg, script, style, [hidden], .sr-only') || !el.getClientRects().length) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        let faded = 1;
        for (let up = el; up; up = up.parentElement) faded *= Number(getComputedStyle(up).opacity);
        const under = ground(el);
        const ink = parse(style.color);
        if (!under || !ink) continue;
        const seen = over([ink[0], ink[1], ink[2], ink[3] * faded], under);
        const r = ratio(seen, under);
        if (r < floor) found.push(`${r.toFixed(2)} "${node.textContent.trim().slice(0, 24)}" .${String(el.className).split(' ')[0] || el.tagName.toLowerCase()}`);
      }
    }
    return [...new Set(found)];
  }, [selector, least]);

section('words can be read on both themes');
for (const theme of ['light', 'dark']) {
  await setTheme(theme);
  await page.waitForTimeout(120);
  const code = await page.evaluate(() => {
    const block = document.querySelector('#messages .codeblock');
    const inner = block.querySelector('code');
    return { background: getComputedStyle(block).backgroundColor, ink: getComputedStyle(inner).color };
  });
  const coded = await lowContrast('#messages .codeblock', 4.5);
  check(`${theme}: a code block's words have 4.5:1 or better`, coded.length === 0, `${JSON.stringify(code)} ${coded.join(' | ')}`);
  const transcript = await lowContrast('#messages', 3);
  check(`${theme}: everything in a transcript has 3:1 or better`, transcript.length === 0, transcript.slice(0, 8).join(' | '));
  await page.screenshot({ path: path.join(os.tmpdir(), `round-chat-${theme}.png`) });
}
await setTheme('light');
for (const tab of ['capabilities', 'providers', 'privacy', 'usage', 'admin']) {
  await openSettings(tab);
  const found = await lowContrast('#settings', 3);
  check(`light: Settings → ${tab} can be read`, found.length === 0, found.slice(0, 8).join(' | '));
  if (tab === 'capabilities') {
    await page.locator('.picker:has(#tool-loading) .picker__btn').click();
    await page.waitForSelector('.picker__menu');
    const list = await lowContrast('.picker__menu', 4);
    check('light: an open list can be read', list.length === 0, list.join(' | '));
    await page.keyboard.press('Escape');
  }
  await closeDialogs();
}
await setTheme('dark');
await page.evaluate(() => { delete document.documentElement.dataset.theme; });

/* ── Administrators ──────────────────────────────────────────────── */
section('the owner adds an administrator, who sees what they were given');
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const other = await context.newPage();
  await other.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
  // Not the first account, so the gate opens on signing in: made the way a form would.
  const made = await other.request.post(`http://127.0.0.1:${PORT}/api/register`, { data: { email: 'new.admin@test.local', password: 'a-long-enough-password', username: 'new.admin', name: 'New Admin' } });
  check('(a second account signs up)', made.ok(), String(made.status()));
  await other.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await other.waitForSelector('#model-chip');
  const them = await store.getUserByEmail('new.admin@test.local');
  await store.setUserSetting(them.id, 'prefs', { ...(await store.getUserSetting(them.id, 'prefs')), language: 'en', onboarded: true });
  await store.createUser({ id: 'u-round-3', email: 'third@test.local', name: 'Third Person', passwordHash: 'x', role: 'user' });
  await reload(other);

  const adminTabs = () => other.evaluate(() => ({ people: !document.getElementById('tab-admin').hidden, feedback: !document.getElementById('tab-feedback').hidden }));
  await other.evaluate(() => document.getElementById('settings').showModal());
  check('before: an ordinary account has no Administration', Object.values(await adminTabs()).every((v) => !v) || (await other.evaluate(() => [...document.querySelectorAll('#settings [data-group="admin"]')].every((n) => n.hidden))));
  await other.evaluate(() => document.getElementById('settings').close());

  await reload();
  await openSettings('admin');
  await page.waitForSelector('#admin-add-person');
  const form = await page.evaluate(() => ({
    section: !document.querySelector('#panel-admin [data-needs="owner"]').hidden,
    owner: document.querySelector('#admin-admins .admins__tag')?.textContent,
    powers: document.querySelectorAll('.admins__add [data-power]').length,
    checked: document.querySelectorAll('.admins__add [data-power]:checked').length,
    disabled: document.getElementById('admin-add-go').disabled,
  }));
  check('the owner has the section, and is marked as the owner', form.section && form.owner === 'Owner', JSON.stringify(form));
  check('  nothing is given by default, and it cannot be sent empty', form.powers === 7 && form.checked === 0 && form.disabled, JSON.stringify(form));

  // Scrolled to, or typed for: one list does both.
  await page.locator('.picker:has(#admin-add-person) .picker__btn').click();
  await page.waitForSelector('.picker__menu .picker__find');
  const before = await page.evaluate(() => [...document.querySelectorAll('.picker__menu [role="option"]')].filter((o) => !o.hidden).map((o) => o.textContent.trim()));
  check('the list can be scrolled through, and holds the people', before.some((p) => /new\.admin@test\.local/.test(p)) && before.some((p) => /third@test\.local/.test(p)), before.join(' | '));
  check('  not the owner, who is already one', !before.some((p) => /round@test\.local/.test(p)));
  await page.keyboard.type('new.admin');
  await page.waitForTimeout(80);
  const typed = await page.evaluate(() => [...document.querySelectorAll('.picker__menu [role="option"]')].filter((o) => !o.hidden).map((o) => o.textContent.trim()));
  check('  and typed for', typed.length === 1 && /new\.admin@test\.local/.test(typed[0]), typed.join(' | '));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  check('choosing a person is not yet enough', await page.evaluate(() => document.getElementById('admin-add-go').disabled));
  await page.check('.admins__add [data-power="feedback"]');
  await page.waitForTimeout(80);
  check('with something they may do, it can be sent', !(await page.evaluate(() => document.getElementById('admin-add-go').disabled)));
  await page.click('#admin-add-go');
  await page.waitForTimeout(500);
  const after = await store.getUserByEmail('new.admin@test.local');
  check('they are an administrator, with that and nothing else', after.role === 'admin' && JSON.stringify(after.admin_permissions) === '["feedback"]' && after.is_owner === false, JSON.stringify([after.role, after.admin_permissions]));
  check('  and listed for the owner', await page.evaluate((id) => !!document.querySelector(`[data-admin="${id}"]`), after.id));

  await reload(other);
  await other.click('#account-button');
  await other.waitForTimeout(150);
  await other.click('.plusmenu--account [data-row="settings"]');
  await other.waitForSelector('#settings[open]');
  await other.waitForTimeout(200);
  const seenThere = await other.evaluate(() => ({
    people: !document.getElementById('tab-admin').hidden,
    feedback: !document.getElementById('tab-feedback').hidden,
  }));
  check('they see Feedback, and not People', seenThere.feedback && !seenThere.people, JSON.stringify(seenThere));
  await other.click('#tab-feedback');
  await other.waitForTimeout(300);
  check('  and it opens', await other.evaluate(() => !document.getElementById('panel-feedback').hidden && /No feedback|feedback/i.test(document.getElementById('admin-feedback').textContent)));

  // A second power: People, with only what they hold.
  await page.check(`[data-admin="${after.id}"] [data-power="users"]`, { force: true }).catch(async () => {
    await page.click(`[data-admin="${after.id}"] summary`);
    await page.check(`[data-admin="${after.id}"] [data-power="users"]`);
  });
  await page.waitForTimeout(400);
  check('a box changed is saved at once', JSON.stringify((await store.getUserByEmail('new.admin@test.local')).admin_permissions) === '["users","feedback"]', JSON.stringify((await store.getUserByEmail('new.admin@test.local')).admin_permissions));
  await reload(other);
  await other.click('#account-button');
  await other.waitForTimeout(150);
  await other.click('.plusmenu--account [data-row="settings"]');
  await other.waitForSelector('#settings[open]');
  await other.click('#tab-admin');
  await other.waitForTimeout(500);
  const panel = await other.evaluate(() => {
    const visible = (sel) => !document.querySelector(sel).closest('[hidden]');
    const rows = [...document.querySelectorAll('#user-list .rows__item')].map((r) => ({ text: r.textContent, limit: !!r.querySelector('[data-limit-user]'), remove: !!r.querySelector('[data-del-user]') }));
    return {
      owner: visible('#admin-admins'),
      models: visible('#admin-recommended'),
      free: visible('#admin-free-tier'),
      activity: visible('#admin-activity'),
      users: visible('#user-list'),
      ownerRow: rows.find((r) => /round@test\.local/.test(r.text)),
      thirdRow: rows.find((r) => /third@test\.local/.test(r.text)),
    };
  });
  check('People shows the list, and none of what they were not given', panel.users && !panel.owner && !panel.models && !panel.free && !panel.activity, JSON.stringify(panel));
  check('  no button on the owner', panel.ownerRow && !panel.ownerRow.limit && !panel.ownerRow.remove, JSON.stringify(panel.ownerRow));
  check('  a limit on an ordinary account, and no delete they do not hold', panel.thirdRow?.limit && !panel.thirdRow?.remove, JSON.stringify(panel.thirdRow));
  await context.close();

  check('the owner sees a way to hand the deployment over', await page.locator(`[data-admin="${after.id}"] [data-admin-owner]`).count() === 1);
  await page.locator(`[data-admin="${after.id}"] [data-admin-remove]`).click();
  await page.waitForTimeout(80);
  await page.locator(`[data-admin="${after.id}"] [data-admin-remove]`).click();
  await page.waitForTimeout(500);
  check('the owner can take it away again', (await store.getUserByEmail('new.admin@test.local')).role === 'user');
  await closeDialogs();
}

section('model suggestions: two free, one paid, each saying which router');
{
  await store.upsertModels([
    { id: 'orcarouter/deepseek/deepseek-v4.1-flash-free', provider: 'orcarouter', model: 'deepseek/deepseek-v4.1-flash-free', family: 'deepseek', label: 'DeepSeek V4.1 Flash (Free)', context: 1048576, maxOutput: 384000, priceIn: 0, priceOut: 0, isFree: true, releasedAt: at, vision: true },
    { id: 'openrouter/nvidia/nemotron:free', provider: 'openrouter', model: 'nvidia/nemotron:free', family: 'nvidia', label: 'Nemotron (free)', context: 128000, maxOutput: 8000, priceIn: 0, priceOut: 0, isFree: true, releasedAt: at, vision: false },
  ]);
  await openSettings('admin');
  await page.waitForSelector('#rec-free-second');
  const seen = await page.evaluate(() => ({
    second: [...document.querySelectorAll('#rec-free-second option')].map((o) => o.textContent),
    label: document.querySelector('label[for="rec-free-second"]').textContent,
  }));
  check('there is a second free choice', /top 2/.test(seen.label), seen.label);
  check('  each model says which router it is through', seen.second.some((o) => /· OrcaRouter$/.test(o)) && seen.second.some((o) => /· OpenRouter$/.test(o)), seen.second.join(' | '));
  await page.selectOption('#rec-free', 'orcarouter/deepseek/deepseek-v4.1-flash-free');
  await page.selectOption('#rec-free-second', 'openrouter/nvidia/nemotron:free');
  await page.click('#rec-save');
  await page.waitForTimeout(400);
  const { getRecommended } = await import('../server/recommend.js');
  const saved = await getRecommended();
  check('both are saved', saved.free === 'orcarouter/deepseek/deepseek-v4.1-flash-free' && saved.freeSecond === 'openrouter/nvidia/nemotron:free', JSON.stringify(saved));
  await closeDialogs();
}

check('no script error on any of it', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();
realLog(failures === 0 ? '\n\x1b[32mAll round checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
