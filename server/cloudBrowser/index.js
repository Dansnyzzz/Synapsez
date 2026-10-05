import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '../store/index.js';
import { saveGenerated } from '../attachments.js';
import { browserAddress, chargeCloud, machineForUser } from '../sandbox.js';

/**
 * A real browser on the account's cloud computer, which the assistant drives
 * and the person watches — and can take over — live.
 *
 * `browser_*` drives the person's own browser through their paired PC; this is
 * for everybody else, and for work that should not happen on their machine. It
 * runs in the same Vercel Sandbox as `sandbox_run` (one per account, disk kept
 * between sessions), so a site signed into once stays signed in.
 *
 * **Built for many people at once.** The expensive, rate-limited thing is
 * Vercel's control API — a thousand requests a minute for the whole team — so
 * it is used only to start a machine. Every action after that goes straight to
 * the service on the machine over https (service.mjs), with a per-start key,
 * and the live screen streams from the machine to the person's browser without
 * passing through this server at all. What this server keeps is one small row
 * per account: where the browser is and its keys.
 *
 * **Frugal with the shared allotment.** Frames are sent only while somebody is
 * watching and only when the page changes; the browser exits after fifteen idle
 * minutes and the machine pauses after that; every action counts against the
 * account's and the app's daily budget (see `chargeCloud`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTING = 'cloudBrowser';
const DIR = '.synz-browser';
const DEPS = ['playwright-core@1.63.0', '@sparticuz/chromium@153.0.0'];
const FIRST_START_MS = 180_000;
const START_MS = 40_000;
const ACT_MS = 75_000;
const PEEK_MS = 3_000;
const EXTEND_EVERY_MS = 5 * 60_000;
const EXTEND_BY_MS = 15 * 60_000;

export const ACTIONS = [
  'open', 'look', 'click', 'type', 'press', 'scroll', 'select', 'wait',
  'back', 'forward', 'reload', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'pdf', 'close',
];

let serviceCache = null;
/** The service's source and a fingerprint of it with its dependencies — a new build reinstalls. */
function service() {
  if (!serviceCache) {
    const source = fs.readFileSync(path.join(here, 'service.mjs'));
    const build = crypto.createHash('sha256').update(source).update(DEPS.join(' ')).digest('hex').slice(0, 16);
    serviceCache = { source, build };
  }
  return serviceCache;
}

/**
 * The script that brings the browser up: dependencies once per build (they
 * stay on the kept disk), fonts for accented and non-Latin pages as a
 * best effort, and then the service itself as the command's own process.
 */
export function startScript(build) {
  return [
    'set -e',
    `mkdir -p ${DIR} && cd ${DIR}`,
    'printf %s "$SYNZ_SERVICE" | base64 -d > service.mjs',
    `if [ "$(cat build 2>/dev/null)" != "${build}" ]; then`,
    '  printf \'{"private":true}\' > package.json',
    `  npm install --no-save --no-audit --no-fund --loglevel=error ${DEPS.join(' ')} > setup.log 2>&1`,
    // Fonts for accented and non-Latin pages, with whichever package manager
    // the image has. Best effort: a page in a fallback font is still a page.
    '  (for pm in dnf microdnf yum; do if command -v $pm >/dev/null 2>&1 || sudo -n sh -c "command -v $pm" >/dev/null 2>&1; then',
    '     sudo -n $pm install -y dejavu-sans-fonts google-noto-sans-fonts google-noto-serif-fonts >> setup.log 2>&1 && break; fi; done) || true',
    `  echo "${build}" > build`,
    'fi',
    /*
     * The old service is stopped by the pid it wrote, never by name. This was
     * `pkill -f 'node service.mjs'` — and the shell running this very script
     * has those words on its own command line, so pkill killed the script
     * before it reached `exec`: no service, an empty service.log, and "did not
     * come up in time" on every first start.
     */
    'if [ -f service.pid ]; then kill "$(cat service.pid)" 2>/dev/null || true; sleep 0.3; fi',
    'echo $$ > service.pid',
    'echo "starting $(date -u +%FT%TZ) node $(node -v)" > service.log',
    'exec node service.mjs >> service.log 2>&1',
  ].join('\n');
}

const key = () => crypto.randomBytes(24).toString('base64url');

async function readConnection(userId) {
  const value = await getStore().getUserSetting(userId, SETTING);
  return value && typeof value === 'object' && value.url && value.key ? value : null;
}

async function saveConnection(userId, value) {
  await getStore().setUserSetting(userId, SETTING, value);
}

/**
 * One request to the service; `null` when it is not there to answer.
 *
 * @param {{ url: string, key: string }} conn
 * @param {string} route
 * @param {any} body  undefined for a GET
 * @param {{ timeout?: number, signal?: AbortSignal }} [options]
 */
async function call(conn, route, body, { timeout = ACT_MS, signal } = {}) {
  const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : [])];
  try {
    const res = await fetch(`${conn.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-synz-key': conn.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * Start (or restart) the browser on the account's machine and wait until it
 * answers. New keys every start, so an old stream address stops working.
 *
 * @param {string} userId
 * @param {{ signal?: AbortSignal }} [options]
 */
async function start(userId, { signal } = {}) {
  const machine = await machineForUser(userId, { signal });
  const url = (await browserAddress(machine, { signal })).replace(/\/$/, '');
  const { source, build } = service();
  const conn = { url, key: key(), viewKey: key(), build, extendedAt: Date.now() };

  await machine.runCommand({
    cmd: 'bash',
    args: ['-lc', startScript(build)],
    env: {
      SYNZ_SERVICE: source.toString('base64'),
      SYNZ_KEY: conn.key,
      SYNZ_VIEW_KEY: conn.viewKey,
      PORT: '3000',
      SYNZ_PROFILE: 'profile',
      /*
       * Tells @sparticuz/chromium it is on an AL2023-compatible host, so it
       * unpacks the shared libraries Chromium needs (libnss3 and the rest) and
       * points LD_LIBRARY_PATH at them. It looks for VERCEL or a Lambda
       * runtime variable; the sandbox has neither, and without them Chromium
       * cannot load on a minimal image.
       */
      VERCEL: '1',
      AWS_LAMBDA_JS_RUNTIME: 'nodejs22.x',
    },
    detached: true,
    signal,
  });

  const firstTime = (await readConnection(userId))?.build !== build;
  const deadline = Date.now() + (firstTime ? FIRST_START_MS : START_MS);
  while (Date.now() < deadline) {
    if (await call(conn, '/health', undefined, { timeout: PEEK_MS, signal })) {
      await saveConnection(userId, conn);
      return conn;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  let log = '';
  try {
    const tail = await machine.readFileToBuffer({ path: `${DIR}/setup.log` }, { signal });
    const serviceLog = await machine.readFileToBuffer({ path: `${DIR}/service.log` }, { signal });
    log = `${tail?.toString('utf8') || ''}\n${serviceLog?.toString('utf8') || ''}`.trim().slice(-1200);
  } catch {
    /* the log is a help, not a requirement */
  }
  throw new Error(`The cloud browser did not come up in time.${log ? `\nIts log ends:\n${log}` : ''}`);
}

/**
 * Keep the machine awake while it is being used. Its session has a fixed
 * length; without this a long task would lose the machine mid-page. Once
 * every few minutes, not per action — each is a control-API request.
 *
 * @param {string} userId
 * @param {{ extendedAt?: number }} conn
 * @param {{ signal?: AbortSignal }} [options]
 */
async function keepAwake(userId, conn, { signal } = {}) {
  if (Date.now() - (conn.extendedAt || 0) < EXTEND_EVERY_MS) return;
  conn.extendedAt = Date.now();
  await saveConnection(userId, conn).catch(() => {});
  try {
    const machine = await machineForUser(userId, { signal });
    await machine.extendTimeout(EXTEND_BY_MS, { signal });
  } catch {
    /* at the plan's longest session already — the next action restarts it */
  }
}

/** The service's answer, as the model reads it. */
export function describePage(page) {
  const lines = [`Page: ${page.title || '(untitled)'}`, page.url || ''];
  const tabs = Array.isArray(page.tabs) ? page.tabs : [];
  if (tabs.length > 1) {
    lines.push('', 'Tabs:', ...tabs.map((tab) => `${tab.active ? '→' : ' '} ${tab.index}. ${tab.title || tab.url}`));
  }
  const elements = Array.isArray(page.elements) ? page.elements : [];
  lines.push('', elements.length ? 'Things to click or fill — use the number as `ref`:' : 'Nothing to click or fill is visible.');
  lines.push(...elements);
  if (page.text) lines.push('', 'Text on the page:', page.text);
  return lines.join('\n');
}

/**
 * The `cloud_browser` tool.
 *
 * @param {Record<string, any>} input
 * @param {{ userId: string, chatId?: string | null, signal?: AbortSignal }} context
 */
export async function cloudBrowser(input, { userId, chatId, signal }) {
  const action = String(input?.action || 'look');
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". One of: ${ACTIONS.join(', ')}.`);

  if (action === 'close') {
    await closeCloudBrowser(userId);
    return { content: 'Closed the cloud browser. Its sign-ins are kept for next time.' };
  }

  await chargeCloud(userId);
  const body = { ...input, action };
  let conn = await readConnection(userId);
  let page = conn && conn.build === service().build ? await call(conn, '/act', body, { signal }) : null;
  if (!page) {
    conn = await start(userId, { signal });
    page = await call(conn, '/act', body, { signal });
    if (!page) throw new Error('The cloud browser started but did not answer. Try once more.');
  } else {
    await keepAwake(userId, conn, { signal });
  }

  if (!page.ok) {
    throw new Error(`${page.error || 'That did not work.'}\nThe page is now: ${page.title || ''} ${page.url || ''}. Look again before the next step.`);
  }

  let file = null;
  if (page.pdf) {
    const name = `${(page.title || 'page').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'page'}.pdf`;
    const saved = await saveGenerated(userId, { name, mime: 'application/pdf', kind: 'pdf', data: page.pdf, source: null, chatId });
    file = { id: saved.id, name: saved.name, mime: saved.mime, kind: saved.kind, bytes: saved.bytes };
  }

  const note = file ? `\n\nSaved the page as ${file.name} in the conversation (file ${file.id}).` : '';
  return {
    content: describePage(page) + note,
    ...(page.shot ? { shot: { data: page.shot, mime: 'image/jpeg' } } : {}),
    ...(file ? { file } : {}),
  };
}

/**
 * What the screen panel shows: where to stream from, and what is open. Never
 * starts anything — a person opening the panel should not cost a machine.
 *
 * @param {string} userId
 */
export async function cloudBrowserState(userId) {
  const conn = await readConnection(userId);
  if (!conn) return { open: false };
  const meta = await call(conn, '/meta', undefined, { timeout: PEEK_MS });
  if (!meta?.open) return { open: false };
  return { open: true, stream: `${conn.url}/stream?k=${encodeURIComponent(conn.viewKey)}`, title: meta.title, url: meta.url, tabs: meta.tabs || [] };
}

const INPUT_TYPES = new Set(['click', 'drag', 'scroll', 'text', 'key', 'back', 'forward', 'reload', 'tab']);
const KEYS = new Set(['Enter', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);
const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/**
 * A gesture from a person driving the panel, checked before it goes on: only
 * the shapes the panel sends, coordinates inside the frame, short text.
 *
 * @param {Record<string, any>} event
 */
export function cleanInput(event) {
  const type = String(event?.type || '');
  if (!INPUT_TYPES.has(type)) return null;
  const clean = { type, x: fraction(event.x), y: fraction(event.y) };
  if (type === 'drag') Object.assign(clean, { toX: fraction(event.toX), toY: fraction(event.toY) });
  if (type === 'scroll') clean.deltaY = Math.max(-3000, Math.min(3000, Number(event.deltaY) || 0));
  if (type === 'text') clean.text = String(event.text || '').slice(0, 200);
  if (type === 'key') {
    if (!KEYS.has(String(event.key))) return null;
    clean.key = String(event.key);
  }
  if (type === 'tab') clean.key = String(Math.max(1, Math.min(50, Number(event.key) || 1)));
  return clean;
}

/**
 * @param {string} userId
 * @param {Record<string, any>} event
 */
export async function cloudBrowserInput(userId, event) {
  const clean = cleanInput(event);
  if (!clean) throw new Error('That is not something the screen can do.');
  const conn = await readConnection(userId);
  const answer = conn ? await call(conn, '/input', clean, { timeout: 20_000 }) : null;
  if (!answer) throw new Error('The cloud browser is resting. Ask the assistant to open a page and it will start again.');
  await keepAwake(userId, conn);
  return answer;
}

/** @param {string} userId */
export async function closeCloudBrowser(userId) {
  const conn = await readConnection(userId);
  if (conn) await call(conn, '/close', {}, { timeout: PEEK_MS });
  await getStore().setUserSetting(userId, SETTING, null);
}

export const __testing = { service, readConnection, saveConnection, SETTING, DIR };
