/**
 * The suggested models changed, in a real browser (owner, 2026-11-10, spec A §E): the
 * notice under the header on the next visit, and within the poll for a tab that is
 * open when the change is made; once per change; "Later" is the end of it.
 *
 *   node test/ui-suggest.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-suggest-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-suggest-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-suggest-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};
console.info = () => {};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setApiKey, setPrefs } = await import('../server/settings.js');

const PORT = 5237;
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
await store.createUser({ id: 'u-suggest', email: 'suggest@test.local', name: 'Suggest', username: 'ui.suggest', passwordHash: await hashPassword(password), role: 'user' });
await setApiKey('u-suggest', 'openai', 'sk-test-key');
await setPrefs('u-suggest', { language: 'en', onboarded: true, qualityGate: false, defaultModel: 'openai/plain' });
// An account from before any change; the suggestion as an administrator set it earlier.
await store.setSetting('recommended_models', { free: 'auto', freeSecond: null, paid: null, version: new Date(Date.now() + 60_000).toISOString() });

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate:not([hidden])');
await page.fill('#gate-email', 'suggest@test.local');
await page.fill('#gate-password', password);
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

section('the next visit after a change says so, once');
{
  await page.waitForSelector('#suggest-banner:not([hidden])', { timeout: 6000 }).catch(() => {});
  const seen = await page.evaluate(() => ({ shown: !document.getElementById('suggest-banner')?.hidden, text: document.getElementById('suggest-banner-text')?.textContent || '' }));
  check('a notice under the header names what is suggested now', seen.shown && /The suggested models have changed/.test(seen.text) && /free: Auto/.test(seen.text), JSON.stringify(seen));
  await page.click('#suggest-later');
  await page.waitForTimeout(300);
  check('  Later puts it away', await page.evaluate(() => document.getElementById('suggest-banner')?.hidden === true));
  await page.reload();
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(800);
  check('  and it is not said again on the next visit', await page.evaluate(() => document.getElementById('suggest-banner')?.hidden === true));
}

section('a change made while the page is open is said within the poll');
{
  await store.setSetting('recommended_models', { free: 'auto', freeSecond: null, paid: null, version: new Date(Date.now() + 120_000).toISOString() });
  // The poll runs every twenty seconds; the page is asked now instead of waiting for it.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const came = await page.waitForSelector('#suggest-banner:not([hidden])', { timeout: 25_000 }).then(() => true, () => false);
  check('the notice appears with no reload', came);
  await page.click('#suggest-later');
}

section('nothing went wrong in the page');
check('no errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
realLog(failures === 0 ? '\n\x1b[32mThe suggestion notice holds, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
