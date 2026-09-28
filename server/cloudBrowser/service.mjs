/**
 * The browser on the account's cloud computer.
 *
 * This file is not run by the server. It is copied onto the account's Vercel
 * Sandbox (see server/cloudBrowser/index.js) and started there with `node`,
 * next to `playwright-core` and `@sparticuz/chromium` — a Chromium build made
 * for Amazon Linux, the sandbox's own OS, that needs no system libraries.
 *
 * It listens on one port that Vercel exposes as an https address, and answers
 * three things, each only with the right key:
 *
 *   POST /act     the assistant's actions (open, click, type…), key: SYNZ_KEY
 *   POST /input   a person driving the live screen, key: SYNZ_KEY
 *   GET  /stream  the live screen as MJPEG, key: SYNZ_VIEW_KEY (view only)
 *   GET  /meta    title, address and tabs, for the panel header, view key
 *   GET  /health  alive?, key: SYNZ_KEY
 *
 * The server talks to this directly over https rather than through Vercel's
 * command API, which is limited per team per minute — a thousand people each
 * clicking through a page would spend it for everyone.
 *
 * The profile lives on the sandbox's disk, which is snapshotted between
 * sessions — so a site signed into stays signed in, the way a browser does.
 * With nobody watching and nothing asked for fifteen minutes it exits, so an
 * abandoned browser does not burn the account's share of CPU.
 */
/* global document, getComputedStyle, innerHeight -- inside page.evaluate, which runs in the page */
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { chromium } from 'playwright-core';

const KEY = process.env.SYNZ_KEY || '';
const VIEW_KEY = process.env.SYNZ_VIEW_KEY || '';
const PORT = Number(process.env.PORT) || 3000;
const PROFILE = process.env.SYNZ_PROFILE || path.resolve('profile');
const WIDTH = 1280;
const HEIGHT = 800;
const IDLE_MS = 15 * 60 * 1000;

if (KEY.length < 32 || VIEW_KEY.length < 32) {
  console.error('SYNZ_KEY and SYNZ_VIEW_KEY must be set.');
  process.exit(1);
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

let context = null;
let page = null;
let lastUse = Date.now();
const viewers = new Set();
let screencast = null;
let latestFrame = null;

/* ── the browser ─────────────────────────────────────────────────── */

async function ensureBrowser() {
  if (context) return;
  let executablePath = process.env.CHROME_PATH || '';
  let args = [];
  if (!executablePath) {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    executablePath = await sparticuz.executablePath();
    args = sparticuz.args;
  }
  context = await chromium.launchPersistentContext(PROFILE, {
    executablePath,
    args,
    headless: true,
    viewport: { width: WIDTH, height: HEIGHT },
    locale: process.env.SYNZ_LOCALE || 'vi-VN',
    acceptDownloads: true,
  });
  context.on('page', (p) => {
    page = p;
    restartScreencast();
  });
  context.on('close', () => {
    context = null;
    page = null;
  });
  page = context.pages()[0] || (await context.newPage());
}

/** A few hundred ms for the page to settle, bounded — some pages never go idle. */
async function settle() {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(350);
}

/**
 * What the page says and what can be pressed on it, numbered — the numbers are
 * stamped on the elements themselves, so `click { ref: 7 }` finds exactly the
 * element the assistant was shown.
 */
async function describe() {
  const state = await page
    .evaluate(() => {
      for (const node of document.querySelectorAll('[data-synz-ref]')) node.removeAttribute('data-synz-ref');
      const lines = [];
      let n = 0;
      const selector =
        'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
        '[role=checkbox],[role=radio],[role=menuitem],[role=option],[contenteditable=true],[onclick]';
      for (const el of document.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
        if (box.bottom < -innerHeight || box.top > innerHeight * 3) continue;
        n += 1;
        el.setAttribute('data-synz-ref', String(n));
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const label = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.value ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('alt') ||
          el.getAttribute('name') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        const where = box.top > innerHeight ? ' (below — scroll)' : box.bottom < 0 ? ' (above)' : '';
        const filled = (tag === 'input' || tag === 'textarea') && el.value && type !== 'password' ? ` = "${String(el.value).slice(0, 40)}"` : '';
        lines.push(`[${n}] ${tag}${type ? `:${type}` : ''} "${label}"${filled}${where}`);
        if (n >= 160) break;
      }
      const text = (document.body?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 6000);
      return { elements: lines, text };
    })
    .catch(() => ({ elements: [], text: '' }));
  return state;
}

/** A small picture of the screen for the step's thumbnail — half size, low quality. */
async function thumbnail() {
  try {
    const cdp = await context.newCDPSession(page);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 50,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 0.5 },
    });
    await cdp.detach().catch(() => {});
    return shot.data;
  } catch {
    return null;
  }
}

async function tabs() {
  const list = context.pages();
  return Promise.all(
    list.map(async (p, i) => ({ index: i + 1, title: await p.title().catch(() => ''), url: p.url(), active: p === page })),
  );
}

async function report(extra = {}) {
  const [state, shot, tabList] = await Promise.all([describe(), thumbnail(), tabs()]);
  return { ok: true, url: page.url(), title: await page.title().catch(() => ''), tabs: tabList, ...state, shot, ...extra };
}

const locatorFor = async ({ ref, text }) => {
  if (ref != null && ref !== '') {
    const target = page.locator(`[data-synz-ref="${Number(ref)}"]`).first();
    if (!(await target.count())) throw new Error(`There is no element [${ref}] on the page now — look again for fresh numbers.`);
    return target;
  }
  if (text) return page.getByText(String(text), { exact: false }).first();
  return null;
};

function normaliseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Give a url to open.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!/^https?:/i.test(raw)) throw new Error('Only http and https addresses are opened.');
    return raw;
  }
  return `https://${raw}`;
}

/** One action by the assistant. */
async function act(input) {
  await ensureBrowser();
  const a = String(input.action || 'look');
  switch (a) {
    case 'open':
      await page.goto(normaliseUrl(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      break;
    case 'new_tab':
      page = await context.newPage();
      if (input.url) await page.goto(normaliseUrl(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      break;
    case 'look':
      break;
    case 'click': {
      if (input.x != null && input.y != null) {
        await page.mouse.click(Number(input.x) * WIDTH, Number(input.y) * HEIGHT);
        break;
      }
      const target = await locatorFor(input);
      if (!target) throw new Error('Say what to click: a ref number from the last look, or its text.');
      await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await target.click({ timeout: 10_000 });
      break;
    }
    case 'type': {
      const value = String(input.value ?? '');
      const target = await locatorFor(input);
      if (target) await target.fill(value, { timeout: 10_000 });
      else await page.keyboard.type(value, { delay: 15 });
      if (input.submit) await page.keyboard.press('Enter');
      break;
    }
    case 'select': {
      const target = await locatorFor(input);
      if (!target) throw new Error('Say which list: a ref number from the last look.');
      await target.selectOption(String(input.value ?? ''), { timeout: 10_000 });
      break;
    }
    case 'press':
      await page.keyboard.press(String(input.key || 'Enter'));
      break;
    case 'scroll': {
      const amount = Math.min(5000, Math.max(100, Number(input.amount) || 700));
      await page.mouse.wheel(0, input.direction === 'up' ? -amount : amount);
      break;
    }
    case 'back':
      await page.goBack({ timeout: 20_000 }).catch(() => {});
      break;
    case 'forward':
      await page.goForward({ timeout: 20_000 }).catch(() => {});
      break;
    case 'reload':
      await page.reload({ timeout: 30_000 });
      break;
    case 'wait':
      if (input.text) await page.getByText(String(input.text)).first().waitFor({ timeout: 15_000 });
      else await page.waitForTimeout(Math.min(10_000, Math.max(200, Number(input.ms) || 1500)));
      break;
    case 'tabs':
      break;
    case 'switch_tab': {
      const list = context.pages();
      const next = list[Number(input.index) - 1];
      if (!next) throw new Error(`There is no tab ${input.index}; there are ${list.length}.`);
      page = next;
      await page.bringToFront();
      restartScreencast();
      break;
    }
    case 'close_tab': {
      const list = context.pages();
      if (list.length > 1) {
        await page.close();
        page = context.pages()[context.pages().length - 1];
        restartScreencast();
      }
      break;
    }
    case 'pdf': {
      const bytes = await page.pdf({ format: 'A4', printBackground: true });
      return report({ pdf: Buffer.from(bytes).toString('base64') });
    }
    default:
      throw new Error(`Unknown action "${a}".`);
  }
  await settle();
  return report();
}

/** One gesture by a person driving the live screen. Coordinates are fractions. */
async function drive(event) {
  await ensureBrowser();
  const x = Number(event.x) * WIDTH;
  const y = Number(event.y) * HEIGHT;
  switch (event.type) {
    case 'click':
      await page.mouse.click(x, y);
      break;
    case 'drag':
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(Number(event.toX) * WIDTH, Number(event.toY) * HEIGHT, { steps: 12 });
      await page.mouse.up();
      break;
    case 'scroll':
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, Number(event.deltaY) || 0);
      break;
    case 'text':
      await page.keyboard.type(String(event.text || ''));
      break;
    case 'key':
      await page.keyboard.press(String(event.key || 'Enter'));
      break;
    case 'back':
      await page.goBack().catch(() => {});
      break;
    case 'forward':
      await page.goForward().catch(() => {});
      break;
    case 'reload':
      await page.reload().catch(() => {});
      break;
    case 'tab': {
      const next = context.pages()[Number(event.key) - 1];
      if (next) {
        page = next;
        await page.bringToFront();
        restartScreencast();
      }
      break;
    }
    default:
      break;
  }
}

/* ── the live screen ─────────────────────────────────────────────── */

function broadcast(frame) {
  latestFrame = frame;
  const head = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  for (const res of viewers) {
    res.write(head);
    res.write(frame);
    res.write('\r\n');
  }
}

/** Frames only while somebody is watching, and only when the page changes. */
async function startScreencast() {
  if (screencast || !viewers.size || !page) return;
  try {
    const cdp = await context.newCDPSession(page);
    screencast = cdp;
    cdp.on('Page.screencastFrame', async (event) => {
      broadcast(Buffer.from(event.data, 'base64'));
      await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  } catch {
    screencast = null;
  }
}

async function stopScreencast() {
  const cdp = screencast;
  screencast = null;
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

function restartScreencast() {
  stopScreencast().then(startScreencast);
}

/* ── http ────────────────────────────────────────────────────────── */

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Too large.');
  }
  return body ? JSON.parse(body) : {};
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const key = req.headers['x-synz-key'] || '';
  const viewKey = url.searchParams.get('k') || '';
  try {
    if (url.pathname === '/health') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      return send(res, 200, { ok: true, browser: !!context, viewers: viewers.size });
    }
    if (url.pathname === '/act' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      lastUse = Date.now();
      try {
        return send(res, 200, await act(await readJson(req)));
      } catch (err) {
        const extra = page ? await report().catch(() => ({})) : {};
        return send(res, 200, { ...extra, ok: false, error: String(err?.message || err).split('\n')[0].slice(0, 400) });
      }
    }
    if (url.pathname === '/input' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      lastUse = Date.now();
      await drive(await readJson(req));
      await page.waitForTimeout(150);
      return send(res, 200, { ok: true, title: await page.title().catch(() => ''), url: page.url(), tabs: await tabs() });
    }
    if (url.pathname === '/close' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      send(res, 200, { ok: true });
      for (const viewer of viewers) viewer.end();
      await context?.close().catch(() => {});
      process.exit(0);
    }
    if (url.pathname === '/meta') {
      if (!same(viewKey, VIEW_KEY) && !same(key, KEY)) return send(res, 401, { error: 'no' });
      if (!context || !page) return send(res, 200, { open: false });
      return send(res, 200, { open: true, title: await page.title().catch(() => ''), url: page.url(), tabs: await tabs() });
    }
    if (url.pathname === '/stream') {
      if (!same(viewKey, VIEW_KEY)) return send(res, 401, { error: 'no' });
      await ensureBrowser();
      lastUse = Date.now();
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      viewers.add(res);
      req.on('close', () => {
        viewers.delete(res);
        if (!viewers.size) stopScreencast();
      });
      if (latestFrame) broadcast(latestFrame);
      else {
        const first = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null);
        if (first) broadcast(first);
      }
      startScreencast();
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err).slice(0, 300) });
  }
});

server.listen(PORT, () => console.log(`browser service on ${PORT}`));

// Nobody watching and nothing asked for a while: let the machine rest.
setInterval(async () => {
  if (viewers.size || Date.now() - lastUse < IDLE_MS) return;
  await context?.close().catch(() => {});
  process.exit(0);
}, 60_000).unref();
