/**
 * The helper service on the account's cloud computer: its browser, and its
 * live Python session.
 *
 * This file is not run by the server. It is copied onto the account's Vercel
 * Sandbox (see server/cloudBrowser/index.js) and started there with `node`,
 * next to `playwright-core`, `@sparticuz/chromium` — a Chromium build made for
 * Amazon Linux, the sandbox's own OS, that needs no system libraries — and `ws`.
 *
 * It listens on one port that Vercel exposes as an https address:
 *
 *   POST /act     the assistant's browser actions (open, click, type…)   SYNZ_KEY
 *   POST /input   a person's gestures, relayed by the server             SYNZ_KEY
 *   POST /py      a cell for a conversation's Python session            SYNZ_KEY
 *   GET  /health  alive?                                                SYNZ_KEY
 *   POST /close   stop everything                                       SYNZ_KEY
 *   GET  /meta    title, address and tabs                   SYNZ_KEY or a panel token
 *   GET  /stream  the screen as MJPEG — the fallback        a view token, in the URL
 *   WS   /live    the screen, and a person driving it       a panel token, sent first
 *
 * **One key, kept on the server.** `SYNZ_KEY` drives everything and never
 * leaves the server. The person's panel gets short-lived tokens signed with it
 * (`tokenScope`): a `view` token that may sit in a URL, because all it opens is
 * the picture, and a `drive` token that is only ever sent inside the socket,
 * never in an address a proxy might log. Both expire; neither can be turned
 * into the key or into the assistant's actions.
 *
 * **Straight from the machine to the person.** The live screen used to be MJPEG
 * and every gesture a round trip through a serverless function — a cold start,
 * a database read and a decryption per scroll tick — so driving the page lagged
 * by a second and the frames piled up in the pipe faster than they could be
 * shown (owner, 2026-10-07). On `/live` both travel over one socket: frames go
 * out only as fast as the person's browser says it has painted them (`WINDOW`
 * in flight), so a slow link drops frames rather than queueing them, and Chrome
 * is not asked to encode a frame nobody can take (each frame is acknowledged to
 * Chrome only when a viewer has room for the next). The frame size is the size
 * the panel is drawn at, not the page's.
 *
 * **Private by construction.** Started as root where the platform allows it,
 * the service keeps its code, its profile — the sign-ins — and its key where
 * the account's own commands cannot read them; the Python session runs as the
 * account's ordinary user, with nothing of the service's in its environment.
 * Chromium's own telemetry is switched off, and the best-known trackers are
 * unresolvable from this browser, so a page cannot report the person's visit
 * to the usual third parties. Nothing here logs a page, an address or a key.
 *
 * The profile lives on the sandbox's disk, which is snapshotted between
 * sessions — so a site signed into stays signed in. With nobody watching and
 * nothing asked for fifteen minutes it exits, so an abandoned browser does not
 * burn the account's share of CPU.
 */
/* global document, getComputedStyle, innerHeight, innerWidth */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { WebSocketServer, WebSocket } from 'ws';

const KEY = process.env.SYNZ_KEY || '';
const PORT = Number(process.env.PORT) || 3000;
const PROFILE = process.env.SYNZ_PROFILE || path.resolve('profile');
/** The account's working folder — where sandbox_run's commands run — shared with the browser's downloads. */
const WORKDIR = path.resolve(process.env.SYNZ_WORKDIR || '..');
const DOWNLOADS = path.join(WORKDIR, 'downloads');
/** The account's own user, when this runs as root: the owner of what it hands over, and who Python runs as. */
const RUN_UID = Number(process.env.SYNZ_RUN_UID) || null;
const RUN_GID = Number(process.env.SYNZ_RUN_GID) || RUN_UID;
const RUN_HOME = process.env.SYNZ_RUN_HOME || '';
const PYTHON = process.env.SYNZ_PYTHON || 'python3';
const KERNEL = path.resolve(process.env.SYNZ_KERNEL_PATH || 'kernel.py');
const LOCALE = process.env.SYNZ_LOCALE || 'vi-VN';
const blockTrackers = process.env.SYNZ_TRACKERS !== '0';
const WIDTH = 1280;
const HEIGHT = 800;
const IDLE_MS = 15 * 60 * 1000;
/** One part of a page's text, as the model reads it. */
const TEXT_PART = 8000;
const MAX_TEXT = 400_000;
/** Frames in flight to one viewer before the next waits for its acknowledgement. */
const WINDOW = 3;

if (KEY.length < 32) {
  console.error('SYNZ_KEY must be set.');
  process.exit(1);
}
// Nothing this starts — Chromium, Python, a shell line inside a cell — inherits the key.
for (const name of Object.keys(process.env)) if (name.startsWith('SYNZ_')) delete process.env[name];

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstLine = (err) => String(err?.message || err).split('\n')[0].slice(0, 400);

/**
 * Which panel token this is, or null. `<scope>.<expiry ms>.<signature>`, the
 * signature an HMAC of the first two with the key — the same recipe as
 * `panelToken` in index.js. A day is the furthest ahead one can be.
 */
function tokenScope(token) {
  const [scope, exp, sig] = String(token || '').split('.');
  if (scope !== 'view' && scope !== 'drive') return null;
  const when = Number(exp);
  if (!Number.isFinite(when) || when < Date.now() || when > Date.now() + 86_400_000) return null;
  const want = crypto.createHmac('sha256', KEY).update(`${scope}.${exp}`).digest('base64url');
  return same(sig, want) ? scope : null;
}

let context = null;
let page = null;
let lastUse = Date.now();

/* ── privacy ─────────────────────────────────────────────────────── */

/**
 * Hosts whose whole business is following people from site to site, made
 * unresolvable inside this browser. Kept to analytics, advertising and
 * session-recording hosts that no page needs in order to work: a sign-in
 * button or an embedded video is never on this list. SYNZ_TRACKERS=0 turns it off.
 */
const TRACKERS = [
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
  'googleadservices.com', 'adservice.google.com', 'app-measurement.com', 'hotjar.com', 'hotjar.io', 'clarity.ms',
  'mc.yandex.ru', 'mixpanel.com', 'fullstory.com', 'mouseflow.com', 'quantserve.com', 'scorecardresearch.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'adnxs.com', 'amazon-adsystem.com', 'moatads.com',
  'bat.bing.com', 'ads-twitter.com', 'analytics.tiktok.com', 'nr-data.net', 'pubmatic.com', 'rubiconproject.com',
];

/** Chromium's own reporting, switched off: no pings home, no crash uploads, no field trials fetched. */
const PRIVATE_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-pings',
  '--disable-breakpad',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-features=OptimizationHints,MediaRouter,DialMediaRouteProvider,Translate,AutofillServerCommunication,' +
    'InterestFeedContentSuggestions,PrivacySandboxSettings4,PrivacySandboxAdsAPIs',
  ...(blockTrackers ? [`--host-resolver-rules=${TRACKERS.flatMap((h) => [`MAP ${h} ~NOTFOUND`, `MAP *.${h} ~NOTFOUND`]).join(', ')}`] : []),
];

/**
 * Two argument lists as one. `--disable-features` is merged rather than
 * repeated: Chromium keeps only the last of a repeated switch, so a second one
 * would silently re-enable everything the first had turned off.
 */
function mergeArgs(base, extra) {
  const out = [];
  const features = new Set();
  for (const arg of [...base, ...extra]) {
    const m = /^--disable-features=(.*)$/.exec(arg);
    if (m) {
      for (const f of m[1].split(',')) if (f) features.add(f);
    } else if (!out.includes(arg)) out.push(arg);
  }
  if (features.size) out.push(`--disable-features=${[...features].join(',')}`);
  return out;
}

/** Whether this runs as root on behalf of an ordinary account — the arrangement index.js prefers. */
const asRoot = () => process.getuid?.() === 0 && RUN_UID != null && RUN_UID !== 0;

/**
 * Run a program as the account's own user, and collect what it prints.
 * Everything this service does in the account's folders while it is root goes
 * through here: root never writes where the account can plant a link.
 */
function asAccount(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { uid: RUN_UID, gid: RUN_GID, cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: RUN_HOME || '/' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `exit ${code}`))));
  });
}

/**
 * Put a file into `downloads/` under a name not yet taken, as the account —
 * `report.csv`, then `report (2).csv`. The arguments travel as arguments, never
 * as part of the script.
 */
const PLACE = [
  'set -e',
  'dir="$1"; src="$2"; name="$3"',
  'mkdir -p "$dir"',
  'case "$name" in *.*) stem="${name%.*}"; ext=".${name##*.}" ;; *) stem="$name"; ext="" ;; esac',
  'target="$dir/$name"; n=2',
  'while [ -e "$target" ] || [ -L "$target" ]; do target="$dir/$stem ($n)$ext"; n=$((n+1)); done',
  'cp -- "$src" "$target"',
  'printf %s "$target"',
].join('\n');

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
    args: mergeArgs(args, PRIVATE_ARGS),
    headless: true,
    viewport: { width: WIDTH, height: HEIGHT },
    locale: LOCALE,
    acceptDownloads: true,
  });
  context.on('page', (p) => {
    prepare(p);
    page = p;
    restartScreencast();
    pushMeta();
  });
  context.on('close', () => {
    context = null;
    page = null;
    screencast = null;
  });
  for (const p of context.pages()) prepare(p);
  page = context.pages()[0] || (await context.newPage());
}

const prepared = new WeakSet();
/** What every page needs: its downloads kept, and the panel told when it moves. */
function prepare(p) {
  if (prepared.has(p)) return;
  prepared.add(p);
  p.on('download', keepDownload);
  p.on('framenavigated', (frame) => {
    if (frame === p.mainFrame()) pushMeta();
  });
  p.on('load', pushMeta);
  p.on('close', () => {
    if (p === page) {
      const rest = context?.pages() || [];
      page = rest[rest.length - 1] || null;
      restartScreencast();
    }
    pushMeta();
  });
}

/* ── downloads, into the folder sandbox_run works in ───────────────── */

const pendingDownloads = new Set();
let downloaded = [];

const safeName = (name) =>
  String(name || 'download')
    .replace(/[/\\\0]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'download';

/**
 * Keep a download in the account's `downloads/` folder.
 *
 * As root, never written there directly: the folder is the account's, and a
 * link planted at `downloads` or at the file's name would have root write a
 * page's file wherever it pointed — over a system file, say. It lands in a
 * folder of this service's own, and the account's user copies it across.
 */
function keepDownload(download) {
  const job = (async () => {
    const name = safeName(download.suggestedFilename());
    let target;
    let bytes;
    if (asRoot()) {
      const incoming = path.resolve('incoming');
      fs.mkdirSync(incoming, { recursive: true, mode: 0o755 });
      const temp = path.join(incoming, crypto.randomUUID());
      try {
        await download.saveAs(temp);
        fs.chmodSync(temp, 0o644);
        bytes = fs.statSync(temp).size;
        target = await asAccount('bash', ['-c', PLACE, 'place', DOWNLOADS, temp, name]);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    } else {
      fs.mkdirSync(DOWNLOADS, { recursive: true });
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      target = path.join(DOWNLOADS, name);
      for (let n = 2; fs.existsSync(target); n += 1) target = path.join(DOWNLOADS, `${stem} (${n})${ext}`);
      await download.saveAs(target);
      bytes = fs.statSync(target).size;
    }
    downloaded.push({ path: path.relative(WORKDIR, target).split(path.sep).join('/'), bytes });
  })()
    .catch((err) => downloaded.push({ error: firstLine(err) }))
    .finally(() => pendingDownloads.delete(job));
  pendingDownloads.add(job);
}

/* ── what the page says ──────────────────────────────────────────── */

/** Settling time after an action: none for one that only reads. */
async function settle(action) {
  if (action === 'look' || action === 'read' || action === 'tabs') return;
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(action === 'type' || action === 'press' ? 200 : 350);
  if (pendingDownloads.size) await Promise.race([Promise.allSettled([...pendingDownloads]), sleep(15_000)]);
}

/**
 * What can be pressed on the page, numbered — the numbers are stamped on the
 * elements themselves, so `click { ref: 7 }` finds exactly the element the
 * assistant was shown — and the whole page's text, and where it is scrolled.
 */
async function describe() {
  return page
    .evaluate((maxText) => {
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
        const where =
          box.top > innerHeight ? ' (below — scroll)' : box.bottom < 0 ? ' (above)' : box.left > innerWidth ? ' (to the right — scroll)' : '';
        const filled = (tag === 'input' || tag === 'textarea') && el.value && type !== 'password' ? ` = "${String(el.value).slice(0, 40)}"` : '';
        lines.push(`[${n}] ${tag}${type ? `:${type}` : ''} "${label}"${filled}${where}`);
        if (n >= 160) break;
      }
      const text = (document.body?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, maxText);
      const root = document.scrollingElement || document.documentElement;
      return {
        elements: lines,
        text,
        position: { x: Math.round(root.scrollLeft), y: Math.round(root.scrollTop), width: root.scrollWidth, height: root.scrollHeight, viewWidth: innerWidth, viewHeight: innerHeight },
      };
    }, MAX_TEXT)
    .catch(() => ({ elements: [], text: '', position: null }));
}

/**
 * One part of the page's text, with a line saying where it is in the whole.
 *
 * The whole text used to be cut at 6,000 characters and nothing said so — and
 * because `innerText` is the whole document wherever it is scrolled, the model
 * scrolled again and again and got the same 6,000 characters back each time
 * (owner, 2026-10-07: "the content still ends at '7. Descript'"). It now says
 * how much there is, and how to read the rest.
 */
function textPart(full, part) {
  const parts = Math.max(1, Math.ceil(full.length / TEXT_PART));
  const n = clamp(Math.floor(part) || 1, 1, parts);
  const slice = full.slice((n - 1) * TEXT_PART, n * TEXT_PART);
  if (parts === 1) return slice;
  return n < parts
    ? `${slice}\n[Part ${n} of ${parts} of this page's text. The rest: read with page ${n + 1}. Scrolling does not change this text — only scroll to load more of a page that loads as you go.]`
    : `${slice}\n[Part ${n} of ${parts} — the end of this page's text.]`;
}

/**
 * A small picture of what is on screen now, for the step's thumbnail.
 *
 * Half size, low quality, and the part of the page that is actually in view.
 * The clip used to be (0, 0, viewport) — and the screenshot's clip is in page
 * coordinates, so after a scroll it photographed the top of the page, which
 * Chromium had stopped painting: a white picture with a few stray lines
 * (owner, 2026-10-07). The visual viewport's own offset is where to look.
 */
async function thumbnail() {
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const view = metrics.cssVisualViewport || metrics.visualViewport || {};
    const width = view.clientWidth || WIDTH;
    const height = view.clientHeight || HEIGHT;
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 50,
      clip: { x: view.pageX || 0, y: view.pageY || 0, width, height, scale: 0.5 },
    });
    return shot.data;
  } catch {
    return null;
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

async function tabs() {
  const list = context ? context.pages() : [];
  return Promise.all(
    list.map(async (p, i) => ({ index: i + 1, title: await p.title().catch(() => ''), url: p.url(), active: p === page })),
  );
}

/** @param {{ part?: number, textOnly?: boolean, did?: string[] }} [extra] */
async function report({ part = 1, textOnly = false, did = null } = {}) {
  const [state, shot, tabList] = await Promise.all([describe(), thumbnail(), tabs()]);
  const files = downloaded;
  downloaded = [];
  return {
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ''),
    tabs: tabList,
    elements: textOnly ? [] : state.elements,
    textOnly,
    text: textPart(state.text, part),
    position: state.position,
    shot,
    ...(files.length ? { downloads: files } : {}),
    ...(did ? { did } : {}),
  };
}

const locatorFor = async ({ ref, text, selector }) => {
  if (ref != null && ref !== '') {
    const target = page.locator(`[data-synz-ref="${Number(ref)}"]`).first();
    if (!(await target.count())) throw new Error(`There is no element [${ref}] on the page now — look again for fresh numbers.`);
    return target;
  }
  if (selector) return page.locator(String(selector)).first();
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

/** The actions that may be one of `steps`. A PDF, closing and another batch may not. */
const STEP_ACTIONS = new Set(['open', 'look', 'read', 'click', 'type', 'press', 'scroll', 'select', 'wait', 'back', 'forward', 'reload', 'tabs', 'new_tab', 'switch_tab', 'close_tab']);

/** One action, as the assistant asked for it. */
async function perform(input) {
  const a = String(input.action || 'look');
  switch (a) {
    case 'open':
      await page.goto(normaliseUrl(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      break;
    case 'new_tab':
      page = await context.newPage();
      prepare(page);
      if (input.url) await page.goto(normaliseUrl(input.url), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      break;
    case 'look':
    case 'read':
    case 'tabs':
      break;
    case 'click': {
      if (input.x != null && input.y != null) {
        await page.mouse.click(clamp(Number(input.x), 0, 1) * WIDTH, clamp(Number(input.y), 0, 1) * HEIGHT);
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
      // Over the element named, so a table that scrolls sideways inside the
      // page is the thing that moves; otherwise the middle of the screen.
      const amount = clamp(Number(input.amount) || 700, 100, 5000);
      const target = input.ref != null || input.selector ? await locatorFor(input).catch(() => null) : null;
      const box = target ? await target.boundingBox().catch(() => null) : null;
      await page.mouse.move(box ? box.x + box.width / 2 : WIDTH / 2, box ? box.y + box.height / 2 : HEIGHT / 2);
      const direction = String(input.direction || 'down');
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const dy = direction === 'up' ? -amount : direction === 'down' || !dx ? amount : 0;
      await page.mouse.wheel(dx, dy);
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
      else await page.waitForTimeout(clamp(Number(input.ms) || 1500, 200, 10_000));
      break;
    case 'switch_tab': {
      const list = context.pages();
      const next = list[Number(input.index) - 1];
      if (!next) throw new Error(`There is no tab ${input.index}; there are ${list.length}.`);
      page = next;
      await page.bringToFront();
      restartScreencast();
      pushMeta();
      break;
    }
    case 'close_tab': {
      const list = context.pages();
      if (list.length > 1) {
        await page.close();
        page = context.pages()[context.pages().length - 1];
        restartScreencast();
        pushMeta();
      }
      break;
    }
    case 'pdf':
    case 'steps':
      throw new Error(`"${a}" cannot be one of the steps.`);
    default:
      throw new Error(`Unknown action "${a}".`);
  }
}

/** A step as one short phrase, for the list of what a batch did. */
const stepLabel = (step) =>
  [step.action, step.ref != null ? `[${step.ref}]` : '', step.url || step.key || step.direction || '', step.value != null ? `"${String(step.value).slice(0, 30)}"` : '']
    .filter(Boolean)
    .join(' ');

/** One call from the assistant: an action, or a batch of them run in order. */
async function act(input) {
  await ensureBrowser();
  const a = String(input.action || 'look');
  if (a === 'pdf') {
    const bytes = await page.pdf({ format: 'A4', printBackground: true });
    return { ...(await report()), pdf: Buffer.from(bytes).toString('base64') };
  }
  if (a === 'steps') {
    const steps = (Array.isArray(input.steps) ? input.steps : []).filter((s) => s && typeof s === 'object');
    if (!steps.length) throw new Error('Give `steps`: a list of actions, e.g. [{"action":"type","ref":3,"value":"…"},{"action":"click","ref":5}].');
    if (steps.length > 10) throw new Error(`At most 10 steps in one call; that was ${steps.length}.`);
    const did = [];
    for (const [i, step] of steps.entries()) {
      const name = String(step.action || '');
      try {
        if (!STEP_ACTIONS.has(name)) throw new Error(`"${name}" cannot be one of the steps.`);
        await perform(step);
        await settle(name);
      } catch (err) {
        const done = did.length ? ` Done before it: ${did.join('; ')}.` : '';
        throw new Error(`Step ${i + 1} of ${steps.length} (${stepLabel(step)}) failed: ${firstLine(err)}${done}`);
      }
      did.push(stepLabel(step));
    }
    return report({ did });
  }
  await perform(input);
  await settle(a);
  return a === 'read' ? report({ part: Number(input.page) || 2, textOnly: true }) : report();
}

/* ── a person driving ────────────────────────────────────────────── */

const BUTTONS = new Set(['left', 'right', 'middle']);
/**
 * A key, or one key with modifiers. Chords are a person's ordinary editing —
 * select all, undo, a word left — and in a page with no browser window around
 * it there is nothing a chord can close or quit.
 */
const CHORD =
  /^(?:(?:Control|Shift|Alt|Meta)\+){0,3}(?:[A-Za-z0-9]|[`\-=[\]\\;',./]|F(?:[1-9]|1[0-2])|Enter|Backspace|Tab|Escape|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Insert|Space)$/;

/**
 * A gesture as the service will carry it out, or null. The same rules as
 * `cleanInput` in index.js — that one guards the relay, this one the socket,
 * which no server stands in front of.
 */
function cleanGesture(event) {
  const type = String(event?.type || '');
  const f = (v) => clamp(Number(v) || 0, 0, 1);
  const at = { x: f(event?.x), y: f(event?.y) };
  switch (type) {
    case 'move':
      return { type, ...at };
    case 'down':
    case 'up':
    case 'click':
      // `count` is which click of a double or triple this is: a word or a line selected by clicking.
      return { type, ...at, button: BUTTONS.has(event.button) ? event.button : 'left', count: clamp(Math.floor(Number(event.count)) || 1, 1, 3) };
    case 'drag':
      return { type, ...at, toX: f(event.toX), toY: f(event.toY) };
    case 'scroll':
    case 'wheel': {
      const dx = clamp(Number(event.deltaX ?? event.dx) || 0, -3000, 3000);
      const dy = clamp(Number(event.deltaY ?? event.dy) || 0, -3000, 3000);
      return dx || dy ? { type: 'wheel', ...at, dx, dy } : null;
    }
    case 'key':
      return CHORD.test(String(event.key || '')) ? { type, key: String(event.key) } : null;
    case 'text': {
      const text = String(event.text || '').slice(0, 5000);
      return text ? { type, text } : null;
    }
    case 'back':
    case 'forward':
    case 'reload':
      return { type };
    case 'tab':
      return { type, index: clamp(Math.floor(Number(event.index ?? event.key)) || 1, 1, 50) };
    default:
      return null;
  }
}

/** Carry out one gesture. Coordinates arrive as fractions of the frame. */
async function gesture(g) {
  await ensureBrowser();
  const x = g.x * WIDTH;
  const y = g.y * HEIGHT;
  switch (g.type) {
    case 'move':
      await page.mouse.move(x, y);
      break;
    case 'down':
      await page.mouse.move(x, y);
      await page.mouse.down({ button: g.button, clickCount: g.count });
      break;
    case 'up':
      await page.mouse.move(x, y);
      await page.mouse.up({ button: g.button, clickCount: g.count });
      break;
    case 'click':
      await page.mouse.click(x, y, { button: g.button, clickCount: g.count });
      break;
    case 'drag':
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(g.toX * WIDTH, g.toY * HEIGHT, { steps: 12 });
      await page.mouse.up();
      break;
    case 'wheel':
      await page.mouse.move(x, y);
      await page.mouse.wheel(g.dx, g.dy);
      break;
    case 'key':
      await page.keyboard.press(g.key === 'Space' ? ' ' : g.key);
      break;
    case 'text':
      // A few characters typed as keys, so a page listening for keystrokes
      // hears them; a paste inserted at once.
      if (g.text.length <= 4) await page.keyboard.type(g.text);
      else await page.keyboard.insertText(g.text);
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
      const next = context.pages()[g.index - 1];
      if (next && next !== page) {
        page = next;
        await page.bringToFront();
        restartScreencast();
        pushMeta();
      }
      break;
    }
    default:
      break;
  }
}

/* ── the live screen ─────────────────────────────────────────────── */

/** MJPEG viewers (the fallback). */
const viewers = new Set();
/** Socket viewers, once they have shown a token. */
const lives = new Set();
let screencast = null;
let screencastConfig = '';
let latestFrame = null;
let pendingAck = null;
let ackTimer = null;
let lastAckAt = 0;

const watching = () => viewers.size > 0 || lives.size > 0;

/**
 * What to ask Chrome for: the largest size anybody is looking at, sharper and
 * faster while somebody is driving than while they watch.
 */
function wanted() {
  let width = viewers.size ? WIDTH : 0;
  let height = viewers.size ? HEIGHT : 0;
  let driving = false;
  for (const c of lives) {
    width = Math.max(width, c.width);
    height = Math.max(height, c.height);
    driving ||= c.driving;
  }
  return {
    maxWidth: clamp(Math.round(width) || 640, 320, WIDTH),
    maxHeight: clamp(Math.round(height) || 400, 200, HEIGHT),
    quality: driving ? 70 : 60,
    fps: driving ? 24 : 8,
  };
}

/** Send a frame to one socket viewer if it has room; remember it if not. */
function offer(client, frame) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.inflight >= WINDOW || client.ws.bufferedAmount > 1_500_000) {
    client.behind = true;
    return;
  }
  client.inflight += 1;
  client.sent = frame;
  client.behind = false;
  client.ws.send(frame, { binary: true });
}

function writeMjpeg(res, frame) {
  // A viewer whose pipe is still full skips this frame rather than queueing it.
  if (res.writableLength > 512 * 1024) return;
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

/**
 * Tell Chrome it may send the next frame — once somebody has room for it, and
 * no sooner than the frame rate allows. Until then Chrome encodes nothing.
 */
function maybeAck() {
  if (!pendingAck || ackTimer) return;
  const room = viewers.size > 0 || [...lives].some((c) => c.inflight < WINDOW);
  if (!room) return;
  const wait = Math.max(0, 1000 / wanted().fps - (Date.now() - lastAckAt));
  ackTimer = setTimeout(() => {
    ackTimer = null;
    const due = pendingAck;
    pendingAck = null;
    if (!due) return;
    lastAckAt = Date.now();
    due.cdp.send('Page.screencastFrameAck', { sessionId: due.sessionId }).catch(() => {});
  }, wait);
}

async function startScreencast() {
  if (screencast || !watching() || !page || !context) return;
  const config = wanted();
  try {
    const cdp = await context.newCDPSession(page);
    screencast = cdp;
    screencastConfig = JSON.stringify(config);
    cdp.on('Page.screencastFrame', (event) => {
      if (screencast !== cdp) return;
      const frame = Buffer.from(event.data, 'base64');
      latestFrame = frame;
      for (const client of lives) offer(client, frame);
      for (const res of viewers) writeMjpeg(res, frame);
      pendingAck = { cdp, sessionId: event.sessionId };
      maybeAck();
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: config.quality,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      everyNthFrame: 1,
    });
  } catch {
    screencast = null;
  }
}

async function stopScreencast() {
  const cdp = screencast;
  screencast = null;
  pendingAck = null;
  clearTimeout(ackTimer);
  ackTimer = null;
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

function restartScreencast() {
  latestFrame = null;
  stopScreencast().then(startScreencast);
}

/** Restart only when what is wanted has actually changed. */
function reconfigure() {
  if (!watching()) {
    stopScreencast();
    return;
  }
  if (JSON.stringify(wanted()) !== screencastConfig) restartScreencast();
}

/** A picture to start a new viewer with, when the screencast has not sent one yet. */
async function firstFrame() {
  if (latestFrame) return latestFrame;
  return page ? page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => null) : null;
}

let metaTimer = null;
/** Title, address and tabs to every socket viewer, a moment after they change. */
function pushMeta() {
  if (metaTimer || !lives.size) return;
  metaTimer = setTimeout(async () => {
    metaTimer = null;
    if (!page || !lives.size) return;
    const text = JSON.stringify({ t: 'meta', title: await page.title().catch(() => ''), url: page.url(), tabs: await tabs() });
    for (const client of lives) if (client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
  }, 150);
}

/** Queue a gesture, folding a run of moves (or of wheel ticks) into the latest. */
function enqueue(client, g) {
  const last = client.queue[client.queue.length - 1];
  if (g.type === 'move' && last?.type === 'move') client.queue[client.queue.length - 1] = g;
  else if (g.type === 'wheel' && last?.type === 'wheel') {
    last.dx = clamp(last.dx + g.dx, -3000, 3000);
    last.dy = clamp(last.dy + g.dy, -3000, 3000);
    last.x = g.x;
    last.y = g.y;
  } else client.queue.push(g);
  if (client.queue.length > 200) client.queue.splice(0, client.queue.length - 200);
  pump(client);
}

async function pump(client) {
  if (client.busy) return;
  client.busy = true;
  try {
    while (client.queue.length) {
      const g = client.queue.shift();
      lastUse = Date.now();
      await gesture(g).catch(() => {});
    }
  } finally {
    client.busy = false;
  }
}

function applyView(client, msg) {
  if (Number.isFinite(Number(msg.width))) client.width = clamp(Number(msg.width), 160, WIDTH);
  if (Number.isFinite(Number(msg.height))) client.height = clamp(Number(msg.height), 100, HEIGHT);
  if (typeof msg.driving === 'boolean') client.driving = msg.driving && client.scope === 'drive';
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

/** More panels than this on one machine is not a person watching: a few tabs, at most. */
const MAX_LIVES = 8;

function openLive(ws) {
  if (wss.clients.size > MAX_LIVES) {
    ws.close(4429, 'too many');
    return;
  }
  const client = { ws, scope: null, inflight: 0, sent: null, behind: false, width: 640, height: 400, driving: false, queue: [], busy: false, window: { at: 0, n: 0 } };
  const unauthenticated = setTimeout(() => ws.close(4401, 'auth'), 5000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!client.scope) {
      const scope = msg?.t === 'auth' ? tokenScope(msg.token) : null;
      if (!scope) {
        ws.close(4401, 'auth');
        return;
      }
      clearTimeout(unauthenticated);
      client.scope = scope;
      applyView(client, msg);
      lives.add(client);
      lastUse = Date.now();
      ensureBrowser()
        .then(async () => {
          pushMeta();
          const frame = await firstFrame();
          if (frame) offer(client, frame);
          if (screencast) reconfigure();
          else startScreencast();
        })
        .catch((err) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'error', message: firstLine(err) })));
      return;
    }
    // A flood is not a person: at most 400 messages a second.
    const now = Date.now();
    if (now - client.window.at > 1000) client.window = { at: now, n: 0 };
    if ((client.window.n += 1) > 400) return;
    if (msg?.t === 'ack') {
      client.inflight = Math.max(0, client.inflight - 1);
      if (client.behind && latestFrame && client.sent !== latestFrame) offer(client, latestFrame);
      maybeAck();
    } else if (msg?.t === 'view') {
      applyView(client, msg);
      reconfigure();
    } else if (msg?.t === 'input' && client.scope === 'drive') {
      const g = cleanGesture(msg.e);
      if (g) enqueue(client, g);
    }
  });
  ws.on('close', () => {
    clearTimeout(unauthenticated);
    lives.delete(client);
    reconfigure();
  });
  ws.on('error', () => {});
}

/* ── the Python session ──────────────────────────────────────────── */

/**
 * One Python process per conversation, kept while the machine is awake — so a
 * table loaded in one call is still in memory for the next, the way a notebook
 * keeps its kernel. Run as the account's ordinary user, never as this service.
 */
const kernels = new Map();
const MAX_KERNELS = 4;
const KERNEL_IDLE_MS = 30 * 60 * 1000;

function kernelEnv() {
  const env = { ...process.env, MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  if (RUN_HOME) {
    env.HOME = RUN_HOME;
    env.PATH = `${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}:${RUN_HOME}/.local/bin`;
  }
  // The service's own temporary folder is root's; the account's session uses the ordinary one.
  if (asRoot()) env.TMPDIR = '/tmp';
  return env;
}

function startKernel(session) {
  const asAccount = RUN_UID != null && process.getuid?.() === 0 ? { uid: RUN_UID, gid: RUN_GID } : {};
  const child = spawn(PYTHON, ['-u', KERNEL], { cwd: WORKDIR, env: kernelEnv(), stdio: ['pipe', 'pipe', 'pipe'], ...asAccount });
  const kernel = { child, session, waiting: new Map(), buffer: '', stray: '', used: Date.now(), dead: false, chain: Promise.resolve(), seq: 0 };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    kernel.buffer += chunk;
    let nl;
    while ((nl = kernel.buffer.indexOf('\n')) >= 0) {
      const line = kernel.buffer.slice(0, nl);
      kernel.buffer = kernel.buffer.slice(nl + 1);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      kernel.waiting.get(reply.id)?.(reply);
      kernel.waiting.delete(reply.id);
    }
  });
  // The kernel writes nothing to stderr itself; anything here is Python failing to start.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    kernel.stray = (kernel.stray + chunk).slice(-4000);
  });
  const fail = (message) => {
    kernel.dead = true;
    if (kernels.get(session) === kernel) kernels.delete(session);
    for (const resolve of kernel.waiting.values()) resolve({ error: message });
    kernel.waiting.clear();
  };
  child.on('error', (err) =>
    fail(
      err?.code === 'ENOENT'
        ? 'Python is not installed on the cloud computer. Install it with sandbox_run, as_root: dnf install -y python3.'
        : `Python could not start: ${firstLine(err)}`,
    ),
  );
  child.on('exit', () => fail(`The Python session ended.${kernel.stray ? ` It said:\n${kernel.stray.slice(-1500)}` : ''}`));
  kernels.set(session, kernel);
  return kernel;
}

function stopKernel(kernel) {
  kernel.dead = true;
  kernels.delete(kernel.session);
  try {
    kernel.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Ask a kernel one thing and wait for its answer, interrupting it when it runs long. */
function ask(kernel, request, timeoutMs) {
  const id = `${Date.now()}-${(kernel.seq += 1)}`;
  return new Promise((resolve) => {
    let interrupted = false;
    const timer = setTimeout(() => {
      interrupted = true;
      try {
        kernel.child.kill('SIGINT');
      } catch {
        /* gone already */
      }
      // Still nothing: the cell is stuck in C code. Lose the session rather than the machine.
      setTimeout(() => {
        if (!kernel.waiting.has(id)) return;
        kernel.waiting.delete(id);
        stopKernel(kernel);
        resolve({ error: 'The cell ran past its time limit and would not stop, so the Python session was restarted; its variables are gone.', lost: true });
      }, 5000).unref();
    }, timeoutMs);
    kernel.waiting.set(id, (reply) => {
      clearTimeout(timer);
      resolve(interrupted && !reply.error ? { ...reply, error: 'Interrupted: the cell ran past its time limit.' } : reply);
    });
    kernel.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
  });
}

async function runPython({ session, code, reset, timeoutMs }) {
  const key = String(session || 'default').slice(0, 80);
  let kernel = kernels.get(key);
  if (kernel && reset) {
    stopKernel(kernel);
    kernel = null;
  }
  const fresh = !kernel || kernel.dead;
  if (fresh) {
    // Room for this one: the session nobody has used for longest goes first.
    if (kernels.size >= MAX_KERNELS) {
      const oldest = [...kernels.values()].sort((a, b) => a.used - b.used)[0];
      if (oldest) stopKernel(oldest);
    }
    kernel = startKernel(key);
  }
  const k = kernel;
  k.used = Date.now();
  const run = k.chain.then(() => (code ? ask(k, { code }, clamp(Number(timeoutMs) || 120_000, 1000, 600_000)) : {}));
  k.chain = run.catch(() => {});
  const reply = await run;
  k.used = Date.now();
  return { ok: true, fresh, ...reply };
}

setInterval(() => {
  for (const kernel of kernels.values()) if (Date.now() - kernel.used > KERNEL_IDLE_MS) stopKernel(kernel);
}, 60_000).unref();

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
  try {
    if (url.pathname === '/health') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      return send(res, 200, {
        ok: true,
        browser: !!context,
        viewers: viewers.size + lives.size,
        // Whether the sign-ins are out of the account's reach (index.js reports it).
        isolated: process.getuid?.() === 0 && RUN_UID != null && RUN_UID !== 0,
        trackersBlocked: blockTrackers ? TRACKERS.length : 0,
        kernels: kernels.size,
      });
    }
    if (url.pathname === '/act' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      lastUse = Date.now();
      try {
        return send(res, 200, await act(await readJson(req)));
      } catch (err) {
        const extra = page ? await report().catch(() => ({})) : {};
        return send(res, 200, { ...extra, ok: false, error: firstLine(err) });
      }
    }
    if (url.pathname === '/input' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      lastUse = Date.now();
      const body = await readJson(req);
      const events = (Array.isArray(body?.events) ? body.events : [body]).slice(0, 60);
      for (const event of events) {
        const g = cleanGesture(event);
        if (g) await gesture(g).catch(() => {});
      }
      await page.waitForTimeout(80);
      return send(res, 200, { ok: true, title: await page.title().catch(() => ''), url: page.url(), tabs: await tabs() });
    }
    if (url.pathname === '/py' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      lastUse = Date.now();
      return send(res, 200, await runPython(await readJson(req)));
    }
    if (url.pathname === '/close' && req.method === 'POST') {
      if (!same(key, KEY)) return send(res, 401, { error: 'no' });
      send(res, 200, { ok: true });
      for (const viewer of viewers) viewer.end();
      for (const client of lives) client.ws.close(1000, 'closed');
      for (const kernel of kernels.values()) stopKernel(kernel);
      await context?.close().catch(() => {});
      process.exit(0);
    }
    if (url.pathname === '/meta') {
      if (!same(key, KEY) && !tokenScope(url.searchParams.get('t'))) return send(res, 401, { error: 'no' });
      if (!context || !page) return send(res, 200, { open: false });
      return send(res, 200, { open: true, title: await page.title().catch(() => ''), url: page.url(), tabs: await tabs() });
    }
    if (url.pathname === '/stream') {
      if (!tokenScope(url.searchParams.get('t'))) return send(res, 401, { error: 'no' });
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
        reconfigure();
      });
      const first = await firstFrame();
      if (first) writeMjpeg(res, first);
      if (screencast) reconfigure();
      else startScreencast();
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err).slice(0, 300) });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/live') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, openLive);
});

server.listen(PORT, () => console.log(`helper service on ${PORT}`));

// Nobody watching and nothing asked for a while: let the machine rest.
setInterval(async () => {
  if (watching() || Date.now() - lastUse < IDLE_MS) return;
  for (const kernel of kernels.values()) stopKernel(kernel);
  await context?.close().catch(() => {});
  process.exit(0);
}, 60_000).unref();
