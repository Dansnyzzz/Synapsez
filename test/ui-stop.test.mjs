/**
 * Pressing stop, and changing model mid-answer, in a real browser against the real
 * server and a stand-in provider that takes its time (owner, 2026-11-06).
 *
 * The owner's words: stop cuts it off right there, the conversation does not vanish,
 * and nothing goes on saying it is thinking. Changing model stops the old one and the
 * new one carries on.
 *
 *   node test/ui-stop.test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'ui-stop-test-encryption-key';
process.env.SESSION_SECRET ||= 'ui-stop-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), 'ai-remote-ui-stop-test');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

const realLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && /confirmation code|─────/.test(args[0])) return;
  realLog(...args);
};

/** A provider: `think` models only reason; `slow` ones write for ever; anything else answers and stops. */
const asked = [];
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const request = { model: String(body.model), messages: body.messages, closedAt: 0, finished: false };
    asked.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const say = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    const thinks = /think/.test(request.model);
    const slow = /slow/.test(request.model);
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (thinks) return say({ reasoning: `Thought number ${n}. ` });
      say({ content: `word${n} ` });
      if (!slow && n >= 3) {
        clearInterval(timer);
        request.finished = true;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return undefined;
    }, 60);
    res.on('close', () => {
      clearInterval(timer);
      if (!request.finished) request.closedAt = Date.now();
    });
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/crypto.js');
const { setApiKey, setPrefs } = await import('../server/settings.js');

const PORT = 5199;
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
  provider.close();
  process.exit(process.env.CI ? 1 : 0);
}

let failures = 0;
const section = (name) => realLog(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  realLog(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

const password = 'a-long-enough-password';
await store.createUser({ id: 'u-ui', email: 'ui@test.local', name: 'UI', username: 'ui.stop', passwordHash: await hashPassword(password), role: 'user' });
await setApiKey('u-ui', 'openai', 'sk-test-key');
await setPrefs('u-ui', { language: 'en', onboarded: true, toolPolicy: 'auto', qualityGate: false, defaultModel: 'openai/slow-writer' });

const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));
await page.route('**/api/models/news*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{"model":null}' }) : route.continue()));
// A model in the picker that answers through the stand-in provider. Library rows need a router's key, and this has none.
await page.route(/\/api\/models\?/, async (route) => {
  const answer = await route.fetch();
  const body = await answer.json();
  body.models = [{ id: 'openai/quick-two', provider: 'openai', label: 'Quick two', context: 128000, isFree: false, price: { in: 1, out: 1 } }, ...(body.models || [])];
  await route.fulfill({ response: answer, json: body });
});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#gate:not([hidden])');
await page.fill('#gate-email', 'ui@test.local');
await page.fill('#gate-password', password);
await page.click('#gate-submit');
await page.waitForSelector('#model-chip');
await page.waitForTimeout(600);
await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => /** @type {HTMLDialogElement} */ (d).close()));

const setModel = async (id) => {
  await setPrefs('u-ui', { defaultModel: id });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(500);
};
const send = async (text) => {
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
};
const stopVisible = () => page.evaluate(() => {
  const stop = document.getElementById('stop');
  return !!stop && !stop.hidden && stop.getClientRects().length > 0;
});

section('stopping while it writes');
{
  await setModel('openai/slow-writer');
  await page.focus('#input');
  await send('Tell me something long');
  await page.waitForFunction(() => /word3/.test(document.querySelector('#messages .msg--assistant .prose')?.textContent || ''), null, { timeout: 15000 });
  const request = asked.at(-1);
  const pressed = Date.now();
  await page.click('#stop');
  await page.waitForTimeout(150);
  const seen = await page.evaluate(() => ({
    text: document.querySelector('#messages .msg--assistant .prose')?.textContent || '',
    user: document.querySelector('#messages .msg--user')?.textContent || '',
    status: document.querySelector('#status')?.textContent?.trim() || '',
  }));
  check('what it wrote stays on the screen', /word1 word2 word3/.test(seen.text), seen.text.slice(0, 60));
  check('the question stays too', /Tell me something long/.test(seen.user), seen.user);
  check('the button goes back', !(await stopVisible()));
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector('#messages .msg--assistant .prose')?.textContent || '');
  const more = await page.evaluate(() => document.querySelector('#messages .msg--assistant .prose')?.textContent || '');
  check('no more words arrive', after === more);
  check('the provider was cut off at once', request.closedAt > 0 && request.closedAt - pressed < 800, `${request.closedAt - pressed} ms`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(500);
  await page.click('.chat-row .chat-item');
  await page.waitForFunction(() => /word1/.test(document.querySelector('#messages .msg--assistant .prose')?.textContent || ''), null, { timeout: 8000 });
  check('and it is still there after a reload', true);
}

section('stopping while it is only thinking');
{
  await setModel('openai/think-long');
  await page.click('#new-chat, [data-new-chat]');
  await page.waitForTimeout(200);
  await page.focus('#input');
  await send('Think about this');
  await page.waitForFunction(() => /Thought number 2/.test(document.querySelector('.think__text')?.textContent || ''), null, { timeout: 15000 });
  check('(thinking, and it says so)', await page.evaluate(() => !!document.querySelector('.think.is-live')));
  await page.click('#stop');
  await page.waitForTimeout(250);
  const seen = await page.evaluate(() => ({
    card: !!document.querySelector('.think'),
    live: !!document.querySelector('.think.is-live'),
    spinner: !!document.querySelector('.think__head .mark'),
    title: document.querySelector('.think__title')?.textContent || '',
    words: document.querySelector('.think__text')?.textContent || '',
    question: document.querySelector('#messages .msg--user')?.textContent || '',
    whale: document.querySelector('.composer__box .mascot')?.dataset.state || '',
  }));
  check('the thought does not vanish', seen.card && /Thought number/.test(seen.words), JSON.stringify(seen));
  check('it stops saying it is thinking', !seen.live && !seen.spinner && !/Thinking/i.test(seen.title), JSON.stringify(seen));
  check('the question stays', /Think about this/.test(seen.question));
  check('the whale goes back to resting', seen.whale === 'idle', seen.whale);
  check('the button goes back', !(await stopVisible()));
}

section('stop, change model, send');
{
  await setModel('openai/slow-writer');
  await page.click('#new-chat, [data-new-chat]');
  await page.waitForTimeout(200);
  await page.focus('#input');
  await send('First question');
  await page.waitForFunction(() => /word2/.test(document.querySelector('#messages .msg--assistant .prose')?.textContent || ''), null, { timeout: 15000 });
  const old = asked.at(-1);
  await page.click('#stop');
  await setPrefs('u-ui', { defaultModel: 'openai/quick-next' });
  await page.evaluate(() => document.getElementById('input').focus());
  // The model on the chip as this tab knows it: the next request says which.
  const chat = await page.evaluate(() => document.querySelector('.chat-row.is-active')?.dataset.chat);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#model-chip');
  await page.waitForTimeout(500);
  await page.click(`.chat-row[data-chat="${chat}"] .chat-item`);
  await page.waitForTimeout(400);
  await page.focus('#input');
  await send('Second question');
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg--user').length === 2 && !document.getElementById('stop').getClientRects().length, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const last = asked.at(-1);
  check('the old model stayed stopped', old.closedAt > 0);
  check('the new one was asked', last.model === 'quick-next', last.model);
  check('with what the old one had said in front of it', JSON.stringify(last.messages).includes('word1'));
}

section('changing model while it writes');
{
  await setModel('openai/slow-writer');
  await page.click('#new-chat, [data-new-chat]');
  await page.waitForTimeout(200);
  await page.focus('#input');
  await send('Write me an essay');
  await page.waitForFunction(() => /word3/.test(document.querySelector('#messages .msg--assistant .prose')?.textContent || ''), null, { timeout: 15000 });
  const old = asked.at(-1);
  await page.click('#model-chip');
  await page.waitForSelector('#models[open] [data-model]');
  await page.waitForSelector('#models [data-model="openai/quick-two"]');
  const choice = await page.evaluate(() => [...document.querySelectorAll('#models [data-model]')].map((card) => card.dataset.model).find((id) => id.startsWith('openai/') && !id.includes('slow')));
  check('(a model to change to)', !!choice, String(choice));
  const pressed = Date.now();
  await page.click(`#models [data-model="${choice}"]`);
  await page.waitForFunction(() => document.querySelectorAll('#messages .msg--assistant').length >= 2, null, { timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('stop').getClientRects().length, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => [...document.querySelectorAll('#messages .msg--assistant .prose')].map((node) => node.textContent));
  const last = asked.at(-1);
  check('the old model was cut off at once', old.closedAt > 0 && old.closedAt - pressed < 800, `${old.closedAt - pressed} ms`);
  check('the new one was asked, carrying on', last.model !== old.model && /changed the model/i.test(JSON.stringify(last.messages)), last.model);
  check('what the old one wrote stays, and the new reply follows it', seen.length >= 2 && /word1/.test(seen[0]) && /word1/.test(seen.at(-1)), JSON.stringify(seen));
  check('nothing is left saying it is working', !(await stopVisible()));
}

section('nothing went wrong in the page');
check('no errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 400));

await browser.close();
await new Promise((r) => server.close(r));
provider.closeAllConnections?.();
provider.close();
realLog(failures === 0 ? '\n\x1b[32mStop and change of model hold, in a real browser.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
