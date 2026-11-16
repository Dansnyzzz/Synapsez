/**
 * The Usage page and the getting-started guide, in a real browser (owner, 2026-11-06):
 * one line for all the free requests, what each provider without a usage API can still
 * tell, the day under the pointer, and a key got and a model chosen inside the guide.
 *
 *   node test/ui-usage-guide.test.mjs
 *   USAGE_SHOTS=folder node test/ui-usage-guide.test.mjs   pictures of what it saw
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-usage-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-usage-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-usage-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

const SHOTS = process.env.USAGE_SHOTS || null;
const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setPrefs } = await import('../server/settings.js');
const PORT = 5200;
const server = createApp().listen(PORT);
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

const password = 'a-long-enough-password';
await store.createUser({ id: 'u-usage', email: 'usage@test.local', name: 'Usage', username: 'usage.person', passwordHash: await hashPassword(password), role: 'user' });
await setPrefs('u-usage', { language: 'en', onboarded: true });

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate:not([hidden])');
await page.fill('#gate-email', 'usage@test.local');
await page.fill('#gate-password', password);
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.waitForTimeout(500);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

section('the guide: a key, step by step');
{
  await page.evaluate(() => document.getElementById('open-onboarding')?.click());
  await page.waitForSelector('#onboarding[open]');
  await page.click('#onb-steps [data-step="2"]');
  await page.waitForSelector('.onbk__card');
  await page.waitForTimeout(150);
  const seen = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.onbk__card')].map((card) => card.dataset.keyProvider),
    on: document.querySelector('.onbk__card.is-on')?.dataset.keyProvider,
    steps: document.querySelectorAll('.onbk__step').length,
    link: document.querySelector('[data-key-get]')?.href,
    newTab: document.querySelector('[data-key-get]')?.target,
    video: !document.getElementById('onb-media').hidden,
    drawing: !!document.querySelector('.onbk__page'),
    clip: (() => {
      const v = document.querySelector('.onbk__video video');
      return v && { src: v.getAttribute('src'), poster: v.getAttribute('poster'), muted: v.muted, loop: v.loop, inline: v.hasAttribute('playsinline'), name: v.getAttribute('aria-label'), playing: !v.paused, caption: document.querySelector('.onbk__sample')?.textContent };
    })(),
    box: document.querySelector('[data-key-box]')?.tagName,
  }));
  check('it offers the three providers', seen.cards.slice().sort().join() === 'google,openrouter,orcarouter', seen.cards.join());
  check('starting from the one the best free model runs on', seen.cards[0] === 'openrouter' && seen.on === 'openrouter', JSON.stringify(seen));
  check('five steps from its page to the key pasted back', seen.steps === 5, String(seen.steps));
  check('a real link, opening in a new tab', /^https:\/\/openrouter\.ai\/settings\/keys/.test(seen.link) && seen.newTab === '_blank', seen.link);
  check('no clip of somebody typing a key', !seen.video);
  check('the real page as a video, not a drawing, and one box to paste into', !seen.drawing && seen.box === 'INPUT');
  check('  OpenRouter\'s video: its own file, muted, looping, inline, still frame first, named', seen.clip?.src === '/onboarding/keys/openrouter.webm' && seen.clip.poster === '/onboarding/keys/openrouter.jpg' && seen.clip.muted && seen.clip.loop && seen.clip.inline && /OpenRouter/.test(seen.clip.name || ''), JSON.stringify(seen.clip));
  check('  and says it is the real page as of November 2026', /November 2026/.test(seen.clip?.caption || ''), seen.clip?.caption);
  await shot('guide-keys');
  await page.click('.onbk__card[data-key-provider="google"]');
  await page.waitForTimeout(100);
  check('another provider has its own steps', await page.evaluate(() => /aistudio\.google\.com\/apikey/.test(document.querySelector('[data-key-get]').href) && /Create API key/.test(document.querySelector('.onbk__steps').textContent)));
  check('  Google\'s video, and the new key\'s first letters in the step', await page.evaluate(() => /keys\/google\.webm$/.test(document.querySelector('.onbk__video video').getAttribute('src')) && /AQ\./.test(document.querySelector('.onbk__steps').textContent) && !/AIza/.test(document.querySelector('.onbk__steps').textContent)));
  await page.click('.onbk__card[data-key-provider="orcarouter"]');
  await page.waitForTimeout(100);
  check('  OrcaRouter\'s video, and what to do at the free plan\'s key limit', await page.evaluate(() => /keys\/orcarouter\.webm$/.test(document.querySelector('.onbk__video video').getAttribute('src')) && /delete a key you no longer use/.test(document.querySelector('.onbk__steps').textContent)));
  // Motion is unwelcome: the still frame waits behind a play button, and the person decides.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.click('.onbk__card[data-key-provider="openrouter"]');
  await page.waitForTimeout(250);
  const still = await page.evaluate(() => ({ paused: document.querySelector('.onbk__video video').paused, label: document.querySelector('[data-key-play]').getAttribute('aria-label') }));
  check('  reduced motion: the poster, paused, with a Play button', still.paused && /Play/.test(still.label), JSON.stringify(still));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.click('.onbk__card[data-key-provider="openrouter"]');

  section('the guide: keys one at a time, checked as they are pasted');
  // The intake route answers by key, so the flow is the page's and the answers are the server's own words.
  const asks = [];
  let release;
  const heldGate = new Promise((r) => (release = r));
  const saved = { kind: 'provider', id: 'openrouter', moved: false, from: 'openrouter' };
  const answers = {
    'sk-or-v1-good-0001': { saved },
    'sk-or-v1-typed-0002-xxxxxxxxxxxxxxxxxxxx': { saved },
    'sk-or-v1-enter-0003': { saved },
    'sk-orca-moved-0004': { saved: { kind: 'provider', id: 'orcarouter', moved: true, from: 'openrouter' } },
    'sk-or-v1-refused-0005': { status: 400, error: 'OpenRouter refused that key. Check that it was copied whole and has not been revoked.' },
    'sk-or-v1-held-0007': { saved },
    'sk-or-v1-held-0011': { saved },
    'sk-or-v1-multi-0008': { saved },
    'sk-or-v1-label-0010': { saved },
    'sk-or-v1-same-0006': { status: 400, error: 'That key belongs to the same OpenRouter account as key 1. One account, one key: two keys of one account share its limits, so the second is no fallback. Add a key from another OpenRouter account.' },
  };
  await page.route('**/api/providers/intake', async (route) => {
    const sent = route.request().postDataJSON();
    asks.push(sent.apiKey);
    await new Promise((r) => setTimeout(r, 350));
    if (/held/.test(sent.apiKey)) await heldGate;
    const answer = answers[sent.apiKey] || { status: 400, error: 'Nobody knows that key.' };
    if (answer.error) return route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify({ error: answer.error }) });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ providers: { openrouter: { configured: true, own: true, keys: [{ position: 1, hint: '…0001' }] } }, saved: { ...answer.saved, account: null, paid: null }, suggestion: null }) });
  });
  const paste = (text) =>
    page.evaluate((value) => {
      const box = document.querySelector('[data-key-box]');
      box.focus();
      const data = new DataTransfer();
      data.setData('text/plain', value);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  const rows = () =>
    page.evaluate(() => ({
      boxes: document.querySelectorAll('[data-key-box]').length,
      done: [...document.querySelectorAll('[data-key-done]')].map((el) => el.value),
      add: !!document.querySelector('[data-key-add]'),
      textarea: !!document.querySelector('.onbk textarea'),
      focused: document.activeElement?.hasAttribute('data-key-box') || false,
      live: document.querySelector('[data-key-live]')?.textContent.trim(),
      liveRole: document.querySelector('[data-key-live]')?.getAttribute('aria-live'),
      text: document.querySelector('.onbk__keys')?.textContent.replace(/\s+/g, ' '),
    }));
  const first = await rows();
  check('one empty box and no Add button or multi-line field', first.boxes === 1 && !first.add && !first.textarea && first.done.length === 0, JSON.stringify(first));
  check('  the box has a label, and the one-key-per-account line is under it', await page.evaluate(() => { const box = document.querySelector('[data-key-box]'); const rule = document.querySelector('.onbk__rule'); return !!box.labels?.[0]?.textContent.trim() && !!rule && /one key per account/i.test(rule.textContent) && /limit/i.test(rule.textContent) && !!(box.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  await paste('sk-or-v1-good-0001');
  await page.waitForFunction(() => /Checking the key/.test(document.querySelector('.onbk__keys')?.textContent || ''), null, { timeout: 3000 });
  check('a pasted key is checked at once, with no press: "Checking the key…"', asks.length === 1 && asks[0] === 'sk-or-v1-good-0001', asks.join());
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 1, null, { timeout: 5000 });
  await page.waitForTimeout(250);
  const added = await rows();
  check('  good: ✓ Added, the box locks (showing only the end of the key) and a new empty box appears', /✓ Added/.test(added.text) && added.done.length === 1 && added.done[0] === '…0001' && added.boxes === 1, JSON.stringify(added));
  check('  focus is in the new box, and the result is announced politely', added.focused && added.liveRole === 'polite' && /Added/.test(added.live), JSON.stringify(added));
  await shot('guide-keys-one');
  await paste('sk-orca-moved-0004');
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 2, null, { timeout: 5000 });
  const movedTo = await rows();
  check("another provider's key: says it is theirs and was added there", /That is an OrcaRouter key — added to OrcaRouter/.test(movedTo.text) && movedTo.boxes === 1, movedTo.text);
  await paste('sk-or-v1-refused-0005');
  await page.waitForFunction(() => document.querySelector('[data-key-box]')?.getAttribute('aria-invalid') === 'true', null, { timeout: 5000 });
  await page.waitForTimeout(200);
  const refused = await rows();
  check('a refused key turns the box red with the provider\'s reason, and no new box appears', /refused that key/.test(refused.text) && refused.boxes === 1 && refused.done.length === 2 && /refused that key/.test(refused.live), JSON.stringify(refused));
  check('  the red is on the box itself, and the reason is tied to it', await page.evaluate(() => { const box = document.querySelector('[data-key-box]'); const why = document.getElementById((box.getAttribute('aria-describedby') || 'none').split(' ')[0]); return box.closest('.onbk__row').classList.contains('is-bad') && !!why && /refused/.test(why.textContent); }));
  await paste('sk-or-v1-same-0006');
  await page.waitForFunction(() => /One account, one key/.test(document.querySelector('.onbk__keys')?.textContent || ''), null, { timeout: 5000 });
  check("OpenRouter's second key from one account: refused with the one-key-per-account sentence, nothing locked", (await rows()).done.length === 2);
  // Typed, not pasted: a pause, then the check — and Enter does not wait.
  asks.length = 0;
  await page.fill('[data-key-box]', 'sk-or-v1-typed-0002-xxxxxxxxxxxxxxxxxxxx');
  await page.waitForTimeout(400);
  check('typed: nothing is asked while the person may still be typing', asks.length === 0, asks.join());
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 3, null, { timeout: 6000 });
  check('  and after a pause the key is checked and added', asks.join() === 'sk-or-v1-typed-0002-xxxxxxxxxxxxxxxxxxxx', asks.join());
  await page.fill('[data-key-box]', 'sk-or-v1-enter-0003');
  await page.press('[data-key-box]', 'Enter');
  await page.waitForTimeout(150);
  check('typed, then Enter: checked at once', asks.includes('sk-or-v1-enter-0003') && /Checking the key/.test((await rows()).text), asks.join());
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 4, null, { timeout: 6000 });
  // Typing a partial key, with pauses between: nothing is sent (each check costs one of the hourly twenty).
  asks.length = 0;
  for (const bit of ['sk-or-v1-abc', 'defg', 'hijk']) {
    await page.type('[data-key-box]', bit);
    await page.waitForTimeout(1100);
  }
  check('typing a partial key with pauses sends nothing', asks.length === 0, asks.join());
  await page.fill('[data-key-box]', '');
  // A paste with a label in front takes the part that looks like a key.
  await paste('Key: sk-or-v1-label-0010');
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 5, null, { timeout: 6000 });
  check('a paste like "Key: sk-or-..." takes the part that looks like a key', asks.join() === 'sk-or-v1-label-0010', asks.join());
  // Several keys pasted: only the first goes, the rest are not left in the box, and it says so.
  asks.length = 0;
  await paste('sk-or-v1-multi-0008 sk-or-v1-multi-0009');
  await page.waitForFunction(() => document.querySelectorAll('[data-key-done]').length === 6, null, { timeout: 6000 });
  const many = await rows();
  check('several keys pasted: only the first is sent, the second is not in the box, and the line says so', asks.join() === 'sk-or-v1-multi-0008' && /Only the first key/.test(many.text) && (await page.evaluate(() => !document.querySelector('[data-key-box]').value.includes('0009'))), JSON.stringify({ asks, text: many.text }));
  check('  and a kept key shows on the provider card count', await page.evaluate(() => /1 key/i.test(document.querySelector('.onbk__card[data-key-provider="openrouter"]').textContent)));
  check('  the announcer lives outside the redrawn step, and each box points at the one-key-per-account line', await page.evaluate(() => { const live = document.querySelector('[data-key-live]'); return !!live && !document.getElementById('onb-key-guide').contains(live) && live.getAttribute('aria-live') === 'polite' && (document.querySelector('[data-key-box]').getAttribute('aria-describedby') || '').split(' ').includes('onbk-rule'); }));
  // Typing on during a held check keeps the characters, and the stale answer is ignored.
  asks.length = 0;
  await paste('sk-or-v1-held-0007');
  await page.waitForFunction(() => document.querySelector('[data-key-box]')?.getAttribute('aria-busy') === 'true', null, { timeout: 3000 });
  await page.type('[data-key-box]', 'xy');
  release();
  await page.waitForTimeout(900);
  const typedOn = await page.evaluate(() => ({ value: document.querySelector('[data-key-box]')?.value, locked: document.querySelectorAll('[data-key-done]').length, readonly: document.querySelector('[data-key-box]')?.readOnly, live: document.querySelector('[data-key-live]')?.textContent }));
  check('typing during a check keeps the keystrokes', typedOn.value === 'sk-or-v1-held-0007xy' && !typedOn.readonly, JSON.stringify(typedOn));
  check('  and the answer for the older value is ignored: nothing locked, nothing announced', typedOn.locked === 6 && !/Added/.test(typedOn.live || ''), JSON.stringify(typedOn));
  await page.fill('[data-key-box]', '');
  // An answer that comes after another provider was chosen is not announced.
  let release2;
  const gate2 = new Promise((r) => (release2 = r));
  await page.unroute('**/api/providers/intake');
  await page.route('**/api/providers/intake', async (route) => {
    await gate2;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ providers: { openrouter: { configured: true, own: true, keys: [{ position: 1, hint: '…0001' }] } }, saved, suggestion: null }) });
  });
  await paste('sk-or-v1-late-0012');
  await page.waitForFunction(() => document.querySelector('[data-key-box]')?.getAttribute('aria-busy') === 'true', null, { timeout: 3000 });
  await page.click('.onbk__card[data-key-provider="google"]');
  release2();
  await page.waitForTimeout(500);
  const late = await page.evaluate(() => ({ live: document.querySelector('[data-key-live]')?.textContent, done: document.querySelectorAll('[data-key-done]').length, hint: document.querySelector('[data-key-box]')?.placeholder }));
  check('a check that ends after another provider was chosen is not shown or announced', late.done === 0 && !/Added/.test(late.live || ''), JSON.stringify(late));
  check("Google's box shows both key shapes in its hint", late.hint === 'AIza… or AQ.…', late.hint);
  await page.unroute('**/api/providers/intake');
  await shot('guide-keys-done');
}

section('the guide: seven steps, and the tabs scroll sideways when they do not fit');
{
  await page.evaluate(() => document.getElementById('onboarding').close());
  const rows = {};
  for (const width of [360, 768]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => document.getElementById('open-onboarding')?.click());
    await page.waitForSelector('#onboarding[open]');
    await page.click('#onb-steps [data-step="1"]');
    await page.waitForTimeout(400);
    const row = await page.evaluate(() => {
      const steps = document.getElementById('onb-steps');
      const style = getComputedStyle(steps);
      return {
        tabs: steps.querySelectorAll('[data-step]').length,
        overflow: steps.scrollWidth > steps.clientWidth + 1,
        overflowX: style.overflowX,
        track: style.scrollbarColor,
        pageSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
        dialogSideways: document.getElementById('onboarding').scrollWidth > document.getElementById('onboarding').clientWidth + 1,
        sixth: steps.querySelector('[data-step="6"] .onb__dot-label')?.textContent,
        seventh: steps.querySelector('[data-step="7"] .onb__dot-label')?.textContent,
      };
    });
    rows[width] = row;
    check(`${width}px: seven tabs, Automations & Bot sixth, First task last`, row.tabs === 7 && /Automations/.test(row.sixth) && /First task/.test(row.seventh), JSON.stringify(row));
    check(`${width}px: the row scrolls inside itself, on a transparent track`, row.overflow && /auto|scroll/.test(row.overflowX) && /(rgba\(0, 0, 0, 0\)|transparent)$/.test(row.track), JSON.stringify(row));
    check(`${width}px: the page itself never scrolls sideways`, !row.pageSideways && !row.dialogSideways, JSON.stringify(row));
    // Forward to the end and back: the current tab is whole in the row after each press.
    const whole = async () =>
      page.evaluate(() => {
        const steps = document.getElementById('onb-steps').getBoundingClientRect();
        const tab = document.querySelector('#onb-steps .is-current').getBoundingClientRect();
        return tab.left >= steps.left - 1 && tab.right <= steps.right + 1;
      });
    const lost = [];
    for (let n = 2; n <= 7; n += 1) {
      await page.click('#onb-next');
      await page.waitForTimeout(700);
      if (!(await whole())) lost.push(n);
    }
    for (let n = 6; n >= 1; n -= 1) {
      await page.click('#onb-back');
      await page.waitForTimeout(700);
      if (!(await whole())) lost.push(n);
    }
    check(`${width}px: the current tab is whole after every Next and Back`, lost.length === 0, `not whole at ${lost.join(', ')}`);
    await page.evaluate(() => document.getElementById('onboarding').close());
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // The new step says what is true of the Automations and Bot pages, and plays no provider video.
  await page.evaluate(() => document.getElementById('open-onboarding')?.click());
  await page.waitForSelector('#onboarding[open]');
  await page.click('#onb-steps [data-step="6"]');
  await page.waitForTimeout(150);
  const six = await page.evaluate(() => ({ title: document.querySelector('#onb-body .onb__title')?.textContent, items: document.querySelectorAll('#onb-body .onb__list li').length }));
  check('step 6 is Automations & Bot: six things said, under two headings', /carries on/.test(six.title) && six.items === 6, JSON.stringify(six));
  await page.click('#onb-steps [data-step="7"]');
  check('step 7 is the first task, and the last button finishes', await page.evaluate(() => document.querySelectorAll('.onb__try').length === 6 && /Done/.test(document.getElementById('onb-next').textContent)));
  await page.evaluate(() => document.getElementById('onboarding').close());
}

section('the guide: the models suggested, and nothing else to choose between');
{
  await page.evaluate(() => document.getElementById('open-onboarding')?.click());
  await page.waitForSelector('#onboarding[open]');
  await page.click('#onb-steps [data-step="3"]');
  await page.waitForSelector('.onb__model');
  const seen = await page.evaluate(() => ({
    models: [...document.querySelectorAll('.onb__model')].map((row) => row.dataset.kind),
    onOne: document.querySelectorAll('.onb__model.is-on').length,
    list: /Choose a model/.test(document.getElementById('onb-body').textContent),
    video: !document.getElementById('onb-media').hidden,
  }));
  check('the main model is there', seen.models.includes('first'), seen.models.join());
  check('no paid one for an account that has not paid', !seen.models.includes('paid'), seen.models.join());
  check('and no list of every model to work through', !seen.list && !seen.video);
  await shot('guide-models');
  await page.evaluate(() => document.getElementById('onboarding').close());
}

section('Usage: one line for all of it');
{
  const now = Date.now();
  const today = new Date(now);
  const report = {
    generatedAt: new Date(now).toISOString(),
    hours: [
      { at: new Date(now - 60e3).toISOString(), provider: 'openrouter', model: 'openrouter/a:free', calls: 6, tokens: 900, cost: 0 },
      { at: new Date(now - 90e3).toISOString(), provider: 'orcarouter', model: 'orcarouter/deepseek/deepseek-v4.1-flash-free', calls: 2, tokens: 900, cost: 0 },
      { at: new Date(now - 26 * 3600e3).toISOString(), provider: 'google', model: 'google/gemini-flash-latest', calls: 4, tokens: 500, cost: 0 },
    ],
    month: { tokens: 2300, calls: 12, cost: 0.17 },
    monthByProvider: { orcarouter: { calls: 2, cost: 0.17 } },
    sharedLimit: null,
    sharedKey: {},
    live: {
      openrouter: [{ index: 0, ok: true, freeToday: { used: 10, limit: 100 }, spend: { today: 0, week: 0, month: 0 }, limit: { amount: 100, remaining: 100, reset: null } }],
      orcarouter: [{ index: 0, ok: true, balance: 20, spendable: 5.83, spent: 0.17, metrics: { tokens: 16_100_000, spend: 0.17, requests: 390, avgLatencyMs: 3024, p99Ms: 16390, errorRate: 0.0026, models: [{ model: 'deepseek/deepseek-v4.1-flash-free', requests: 370, tokens: 16_000_000, spend: 0, p50: 1832, p95: 10437, errorRate: 0.0027 }] } }],
    },
    free: {
      orcarouter: { used: 7, limit: 800, tier: 'high', tiers: [{ minPaidUsd: 0, rpd: 50 }, { minPaidUsd: 20, rpd: 800 }], models: [] },
      google: { used: 2, limit: null, from: new Date(now - 3600e3).toISOString(), to: new Date(now + 3600e3).toISOString() },
    },
    inUse: { openrouter: 0 },
    detail: {
      google: {
        models: [{ model: 'google/gemini-flash-latest', calls: 30, input: 90000, output: 2000, cost: 0, peakRpm: 2, peakTpm: 906 }],
        daily: [{ day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2)).toISOString(), calls: 30, cost: 0 }],
        errors: [{ day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1)).toISOString(), status: 404, calls: 72 }, { day: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1)).toISOString(), status: 503, calls: 6 }],
      },
      orcarouter: { models: [], daily: [], errors: [] },
    },
  };
  await page.route('**/api/usage/report*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report) }));
  await page.click('#account-button');
  await page.waitForTimeout(200);
  await page.click('.plusmenu--account [data-row="usage"]');
  await page.waitForSelector('#usage-panel .usage__limit');
  await page.waitForTimeout(300);
  const limits = await page.evaluate(() => [...document.querySelectorAll('#usage-panel .usage__limits .usage__limit')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()));
  check('all the free requests are one line', limits.filter((line) => /free model requests/i.test(line)).length === 1 && limits.some((line) => /17 of 900/.test(line)), JSON.stringify(limits));
  check('and all the spending limits another', limits.filter((line) => /spending limit/i.test(line)).length === 1 && limits.some((line) => /\$0\.17 of \$106/.test(line)), JSON.stringify(limits));
  check('no provider or key is named on either', !limits.some((line) => /OpenRouter|OrcaRouter|Key 1/.test(line)), JSON.stringify(limits));
  check('what could not be added in says so', await page.evaluate(() => /Gemini: 2 requests today/.test(document.querySelector('#usage-panel .usage__limits').textContent)));
  await shot('usage-overview');

  // The day under the pointer.
  const dayBox = () => page.evaluate(() => ({ name: document.querySelector('.usage__dayname')?.textContent || '', lines: [...document.querySelectorAll('.usage__dayshare .usage__limit-label')].map((n) => n.textContent) }));
  const atFirst = await dayBox();
  check('it starts on today', atFirst.lines.includes('OpenRouter') && atFirst.lines.includes('OrcaRouter') && await page.evaluate(() => !!document.querySelector('.usage__day.is-today.is-at')), JSON.stringify(atFirst));
  const yesterday = new Date(now - 26 * 3600e3);
  const index = await page.evaluate((iso) => {
    const buttons = [...document.querySelectorAll('.usage__day')];
    const todayAt = buttons.findIndex((b) => b.classList.contains('is-today'));
    const back = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
    return todayAt - back;
  }, yesterday.toISOString());
  if (index >= 0) {
    await page.hover(`.usage__day[data-week-day="${index}"]`);
    await page.waitForTimeout(60);
    const hovered = await dayBox();
    check('pointing at a column shows that day', hovered.name !== atFirst.name && hovered.lines.includes('Google Gemini') || hovered.lines.length === 0, JSON.stringify(hovered));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(60);
    check('and leaving it goes back to today', (await dayBox()).name === atFirst.name);
  } else {
    check('(yesterday is in last week: nothing to point at today)', true);
  }

  await page.click('#usage-panel [data-scope="google"]');
  await page.waitForTimeout(150);
  const gemini = await page.evaluate(() => document.getElementById('usage-panel').textContent);
  check("Gemini's page has what AI Studio shows: the busiest minute against the limit", /Limits by model/.test(gemini) && /2 \/ 5/.test(gemini) && /906 \/ 250,000/.test(gemini), gemini.slice(0, 200));
  check('errors by status', /404 Model not found/.test(gemini) && /503 Overloaded/.test(gemini));
  check('and the rate of success', /28%/.test(gemini) || /succeeded/.test(gemini));
  check('and where the exact figures are', await page.evaluate(() => [...document.querySelectorAll('#usage-panel a')].some((a) => a.href === 'https://aistudio.google.com/rate-limit')));
  await shot('usage-gemini');
  await page.click('#usage-panel [data-scope="orcarouter"]');
  await page.waitForTimeout(150);
  const orca = await page.evaluate(() => document.getElementById('usage-panel').textContent);
  check("OrcaRouter's page has its wallet and its console's figures", /\$20\.00/.test(orca) && /16\.1M/.test(orca) && /390/.test(orca) && /3\.0s/.test(orca), orca.slice(0, 240));
  check('and each model', /deepseek-v4\.1-flash-free/.test(orca) && /10\.4s/.test(orca));
  await shot('usage-orca');
  await page.evaluate(() => document.getElementById('settings').close());
}

section('nothing went wrong in the page');
check('no errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
realLog(failures === 0 ? '\n\x1b[32mUsage and the guide hold, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
