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
    box: document.querySelector('[data-key-box]')?.tagName,
  }));
  check('it offers the three providers', seen.cards.slice().sort().join() === 'google,openrouter,orcarouter', seen.cards.join());
  check('starting from the one the best free model runs on', seen.cards[0] === 'openrouter' && seen.on === 'openrouter', JSON.stringify(seen));
  check('five steps from its page to the key pasted back', seen.steps === 5, String(seen.steps));
  check('a real link, opening in a new tab', /^https:\/\/openrouter\.ai\/settings\/keys/.test(seen.link) && seen.newTab === '_blank', seen.link);
  check('no clip of somebody typing a key', !seen.video);
  check('a drawing of what to look for, and one box to paste into', seen.drawing && seen.box === 'TEXTAREA');
  await shot('guide-keys');
  await page.click('.onbk__card[data-key-provider="google"]');
  await page.waitForTimeout(100);
  check('another provider has its own steps', await page.evaluate(() => /aistudio\.google\.com\/apikey/.test(document.querySelector('[data-key-get]').href) && /Create API key/.test(document.querySelector('.onbk__steps').textContent)));
  await page.click('.onbk__card[data-key-provider="openrouter"]');
  await page.fill('[data-key-box]', 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111\nsk-orca-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222');
  await page.click('[data-key-add]');
  await page.waitForFunction(() => document.querySelector('.onb__state')?.classList.contains('is-done'), null, { timeout: 8000 });
  await page.waitForTimeout(200);
  const held = await store.getUserSetting('u-usage', 'providerKeys').catch(() => null);
  const status = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).providers);
  check('two keys pasted at once are both taken, each where it belongs', (status.openrouter?.keys || []).length === 1 && (status.orcarouter?.keys || []).length === 1, JSON.stringify({ held: !!held, or: status.openrouter?.keys?.length, orca: status.orcarouter?.keys?.length }));
  check('and it says so on the card', await page.evaluate(() => /1 key/i.test(document.querySelector('.onbk__card[data-key-provider="openrouter"]').textContent)));
  await shot('guide-keys-done');
}

section('the guide: the models suggested, and nothing else to choose between');
{
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
