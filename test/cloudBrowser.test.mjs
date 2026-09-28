/**
 * The cloud browser: the service that runs on the account's machine, and the
 * server side that drives it.
 *
 * The machine itself (a Vercel Sandbox) cannot be started here, so the part
 * that starts it is checked only for how it fails. Everything after the start
 * is real: service.mjs runs as a child process against a Chrome on this
 * computer, with the connection row pointing at it, so the tool, the panel's
 * state and input, and closing all go through the same code as on Vercel.
 * Without a local Chrome that half is skipped, and says so.
 *
 *   node test/cloudBrowser.test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};
const throws = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return String(e?.message || e);
  }
};

const { initStore } = await import('../server/store/index.js');
const memory = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
await store.createUser({ id: 'u-cb', email: 'cb@example.com', passwordHash: 'x', name: 'C', role: 'user' });

const cb = await import('../server/cloudBrowser/index.js');
const { machineStartError, cloudBudgets, chargeCloud, BROWSER_PORT } = await import('../server/sandbox.js');
const { TOOLS_BY_NAME, returnsExternalContent, assessRisk, carriesData } = await import('../server/tools/definitions.js');

section('the tool is described the way the service behaves');
{
  const def = TOOLS_BY_NAME.cloud_browser;
  check('exists, cloud-scoped, only where a cloud machine exists', def?.scope === 'cloud' && def?.needsHost === 'sandbox');
  check('its actions are exactly the ones the server accepts', JSON.stringify(def.parameters.properties.action.enum) === JSON.stringify(cb.ACTIONS));
  const service = fs.readFileSync(new URL('../server/cloudBrowser/service.mjs', import.meta.url), 'utf8');
  const missing = cb.ACTIONS.filter((a) => a !== 'close' && !service.includes(`case '${a}':`));
  check('the service handles every action but close (its own route)', !missing.length, missing.join(', '));
  check('what it reads is treated as untrusted page text', returnsExternalContent('cloud_browser'));
  check('an address stuffed with data is caught like any fetch', carriesData('cloud_browser', { action: 'open', url: `https://x.example/?d=${'A'.repeat(400)}` }));
  check('ordinary browsing does not ask', assessRisk('cloud_browser', { action: 'open', url: 'https://example.com' }) === 'ordinary');
  check('the port the machine opens is the one the service listens on', BROWSER_PORT === 3000 && cb.startScript('b').includes('exec node service.mjs'));
}

section('the start script installs once per build and then runs the service');
{
  const script = cb.startScript('abc123');
  check('installs only when the build changed', /if \[ "\$\(cat build 2>\/dev\/null\)" != "abc123" \]/.test(script));
  check('pins both dependencies', script.includes('playwright-core@1.63.0') && script.includes('@sparticuz/chromium@153.0.0'));
  check('fonts are a best effort that cannot fail the start', /dnf install[^\n]*\|\| true/.test(script));
  check('an older service is stopped before the new one starts', script.indexOf('pkill') < script.indexOf('exec node'));
  check('no key is written into the script (they travel as env)', !/SYNZ_KEY=/.test(script));
}

section('a person\'s gestures are checked before they reach the machine');
{
  check('an unknown gesture is refused', cb.cleanInput({ type: 'eval', code: 'x' }) === null);
  check('coordinates are kept inside the frame', JSON.stringify(cb.cleanInput({ type: 'click', x: 5, y: -2 })) === JSON.stringify({ type: 'click', x: 1, y: 0 }));
  check('typed text is capped', cb.cleanInput({ type: 'text', text: 'a'.repeat(999) }).text.length === 200);
  check('only named keys, not arbitrary chords', cb.cleanInput({ type: 'key', key: 'Control+Shift+Q' }) === null && cb.cleanInput({ type: 'key', key: 'Enter' })?.key === 'Enter');
  check('scroll is bounded', cb.cleanInput({ type: 'scroll', deltaY: 1e9 }).deltaY === 3000);
}

section('the platform\'s refusals read as what they are');
{
  check('all machines busy', /in use by other people/.test(machineStartError({ message: 'Too many concurrent sandboxes' }).message));
  check('a 429 is the same', /in use by other people/.test(machineStartError({ message: 'x', response: { status: 429 } }).message));
  check('the month\'s allotment spent', /free allotment/.test(machineStartError({ message: 'Usage quota exceeded' }).message));
  check('a timeout is not mistaken for a spent allotment', !/allotment/.test(machineStartError(new Error('Request timeout exceeded')).message));
  check('anything else keeps its message and the setup hint', /could not be started: boom.*OIDC/s.test(machineStartError(new Error('boom')).message));
}

section('the daily budgets are per account and for the whole app');
{
  const before = { ...process.env };
  process.env.CLOUD_ACTIONS_PER_DAY = '2';
  process.env.CLOUD_ACTIONS_TOTAL_PER_DAY = '3';
  check('read from the environment', cloudBudgets().perAccount === 2 && cloudBudgets().total === 3);
  await chargeCloud('u-a');
  await chargeCloud('u-a');
  const mine = await throws(() => chargeCloud('u-a'));
  check('the third action of the day is refused for that account', /used its 2 cloud-computer actions/.test(mine), mine);
  const theirs = await throws(() => chargeCloud('u-b'));
  check('another account still has its own budget…', theirs === '', theirs);
  const all = await throws(() => chargeCloud('u-c'));
  check('…until the app-wide one is spent', /whole app/.test(all), all);
  process.env.CLOUD_ACTIONS_PER_DAY = before.CLOUD_ACTIONS_PER_DAY ?? '';
  process.env.CLOUD_ACTIONS_TOTAL_PER_DAY = before.CLOUD_ACTIONS_TOTAL_PER_DAY ?? '';
  if (!before.CLOUD_ACTIONS_PER_DAY) delete process.env.CLOUD_ACTIONS_PER_DAY;
  if (!before.CLOUD_ACTIONS_TOTAL_PER_DAY) delete process.env.CLOUD_ACTIONS_TOTAL_PER_DAY;
}

section('the panel never starts a machine');
{
  const state = await cb.cloudBrowserState('u-cb');
  check('no browser yet: closed, and no request to Vercel', state.open === false);
  const refused = await throws(() => cb.cloudBrowserInput('u-cb', { type: 'click', x: 0.5, y: 0.5 }));
  check('driving a resting browser says so', /resting/.test(refused), refused);
}

section('the page as the model reads it');
{
  const text = cb.describePage({
    title: 'Form',
    url: 'https://x.example/',
    tabs: [{ index: 1, title: 'A', url: 'a', active: false }, { index: 2, title: 'Form', url: 'b', active: true }],
    elements: ['[1] input:text "Name"', '[2] button "Send"'],
    text: 'Hello',
  });
  check('title, address, tabs with the active one marked, numbered refs, text', /Page: Form/.test(text) && /→ 2\. Form/.test(text) && /\[2\] button "Send"/.test(text) && /Hello/.test(text));
}

/* ── the real service against a local Chrome ─────────────────────── */

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

section('the service, driven through the tool, with a real browser');
if (!chrome) {
  console.log('  (skipped — no Chrome on this computer; set CHROME_PATH to run it)');
} else {
  // A page of our own, so nothing here reaches the internet.
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url.startsWith('/done')) return res.end(`<title>Done</title><p>Xin chào ${new URL(req.url, 'http://x').searchParams.get('name')}</p>`);
    res.end('<title>Form</title><form action="/done"><input name="name" placeholder="Your name"><button>Send</button></form><a href="/done?name=link">A link</a>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}`;

  const port = 3900 + Math.floor(Math.random() * 90);
  const key = 'k'.repeat(40);
  const viewKey = 'v'.repeat(40);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'synz-cb-'));
  const child = spawn(process.execPath, ['server/cloudBrowser/service.mjs'], {
    env: { ...process.env, SYNZ_KEY: key, SYNZ_VIEW_KEY: viewKey, PORT: String(port), CHROME_PATH: chrome, SYNZ_PROFILE: profile },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 40; i++) {
      const ok = await fetch(`${base}/health`, { headers: { 'x-synz-key': key } }).then((r) => r.ok, () => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('the service refuses a caller without the key', (await fetch(`${base}/health`)).status === 401);
    check('the stream refuses the driving key in place of the view key', (await fetch(`${base}/stream?k=${key}`)).status === 401);

    await cb.__testing.saveConnection('u-cb', { url: base, key, viewKey, build: cb.__testing.service().build, extendedAt: Date.now() });
    const ctx = { userId: 'u-cb', chatId: null };
    // Plain http is refused on the real thing's https address only by the
    // service's own rule for pages — here the page is local on purpose.
    const opened = await cb.cloudBrowser({ action: 'open', url: siteUrl }, ctx);
    check('open: the page, its refs, and a picture', /Page: Form/.test(opened.content) && /\[\d+\] input "Your name"/.test(opened.content) && !!opened.shot?.data, opened.content.slice(0, 200));
    const ref = Number(/\[(\d+)\] input "Your name"/.exec(opened.content)?.[1]);
    const typed = await cb.cloudBrowser({ action: 'type', ref, value: 'Phú', submit: true }, ctx);
    check('type + submit: accents survive the round trip', /Page: Done/.test(typed.content) && /Xin chào Phú/.test(typed.content), typed.content.slice(0, 200));
    const stale = await throws(() => cb.cloudBrowser({ action: 'click', ref: 99 }, ctx));
    check('a ref that is not on the page fails at once, and says to look again', /no element \[99\].*look again/s.test(stale), stale);
    const refused = await throws(() => cb.cloudBrowser({ action: 'open', url: 'file:///etc/passwd' }, ctx));
    check('only web addresses are opened', /Only http and https/.test(refused), refused);
    const pdfTool = await cb.cloudBrowser({ action: 'pdf' }, ctx);
    check('pdf: the page lands in the conversation as a file', pdfTool.file?.kind === 'pdf' && /Saved the page as Done\.pdf/.test(pdfTool.content));

    const state = await cb.cloudBrowserState('u-cb');
    check('the panel gets the view-only stream address, never the driving key', state.open && state.stream.includes(`k=${viewKey}`) && !JSON.stringify(state).includes(key), state.title);
    const moved = await cb.cloudBrowserInput('u-cb', { type: 'back' });
    check('a person can drive it, and hears where the page went', moved.ok && moved.title === 'Form', moved.title);

    await cb.closeCloudBrowser('u-cb');
    await new Promise((r) => setTimeout(r, 500));
    check('close stops the service and forgets the address', child.exitCode === 0 && (await cb.cloudBrowserState('u-cb')).open === false);
  } finally {
    child.kill();
    site.close();
  }
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mAll cloud browser checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
