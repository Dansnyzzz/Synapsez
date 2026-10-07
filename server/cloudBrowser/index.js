import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '../store/index.js';
import { saveGenerated } from '../attachments.js';
import { browserAddress, chargeCloud, machineForUser, shellFor } from '../sandbox.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { readCapped } from '../util/safeFetch.js';

/**
 * A real browser on the account's cloud computer, which the assistant drives
 * and the person watches — and can take over — live; and, beside it on the
 * same machine, the conversation's live Python session.
 *
 * `browser_*` drives the person's own browser through their paired PC; this is
 * for everybody else, and for work that should not happen on their machine. It
 * runs in the same Vercel Sandbox as `sandbox_run` (one per account, disk kept
 * between sessions), so a site signed into once stays signed in, and a file it
 * downloads is in the folder `sandbox_run` and the Python session work in.
 *
 * **Built for many people at once.** The expensive, rate-limited thing is
 * Vercel's control API — a thousand requests a minute for the whole team — so
 * it is used only to start a machine. Every action after that goes straight to
 * the helper service on the machine over https (service.mjs) with a key made
 * for that start, and the live screen — frames one way, a person's gestures the
 * other — runs over one socket between the machine and the person's browser
 * without passing through this server at all. What this server keeps is one
 * small row per account: where the service is and its key, sealed.
 *
 * **The key never leaves the server.** The panel is handed short-lived tokens
 * signed with it (`panelToken`): one that only shows the screen, which may sit
 * in an image address, and one that drives it, which travels only inside the
 * socket. A token cannot act as the assistant, run Python or close anything.
 *
 * **Frugal with the shared allotment.** Frames are sent only while somebody is
 * watching, only when the page changes and only as fast as they are shown; the
 * service exits after fifteen idle minutes and the machine pauses after that;
 * every action counts against the account's and the app's daily budget (see
 * `chargeCloud`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTING = 'cloudBrowser';
const DIR = '.synz-browser';
/** Where the service lives when it runs as root, out of the account's reach. */
const ROOT_DIR = '/opt/synz';
const DEPS = ['playwright-core@1.63.0', '@sparticuz/chromium@153.0.0', 'ws@8.21.1'];
const FIRST_START_MS = 180_000;
const START_MS = 40_000;
const ACT_MS = 75_000;
const PEEK_MS = 3_000;
/** The most one answer from the service may be: a page's text and a screenshot, or a cell's figures, with room to spare. */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const EXTEND_EVERY_MS = 5 * 60_000;
const EXTEND_BY_MS = 15 * 60_000;
/** How long a panel token lasts. The panel asks for fresh ones well before. */
const TOKEN_MS = 15 * 60_000;

export const ACTIONS = [
  'open', 'look', 'read', 'click', 'type', 'press', 'scroll', 'select', 'wait',
  'back', 'forward', 'reload', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'pdf', 'steps', 'close',
];

let serviceCache = null;
/** The service's and the kernel's sources and a fingerprint of them with the dependencies — a new build reinstalls. */
function service() {
  if (!serviceCache) {
    const source = fs.readFileSync(path.join(here, 'service.mjs'));
    const kernel = fs.readFileSync(path.join(here, 'kernel.py'));
    const build = crypto.createHash('sha256').update(source).update(kernel).update(DEPS.join(' ')).digest('hex').slice(0, 16);
    serviceCache = { source, kernel, build };
  }
  return serviceCache;
}

/** Install once per build: dependencies, and fonts for accented and non-Latin pages as a best effort. */
const installLines = (build) => [
  `if [ "$(cat build 2>/dev/null)" != "${build}" ]; then`,
  '  printf \'{"private":true}\' > package.json',
  `  npm install --no-save --no-audit --no-fund --loglevel=error ${DEPS.join(' ')} > setup.log 2>&1`,
  // Fonts for accented and non-Latin pages, with whichever package manager
  // the image has. Best effort: a page in a fallback font is still a page.
  '  (for pm in dnf microdnf yum; do if command -v $pm >/dev/null 2>&1 || sudo -n sh -c "command -v $pm" >/dev/null 2>&1; then',
  '     sudo -n $pm install -y dejavu-sans-fonts google-noto-sans-fonts google-noto-serif-fonts >> setup.log 2>&1 && break; fi; done) || true',
  `  echo "${build}" > build`,
  'fi',
];

/**
 * The script that brings the helper service up, as root or as the account.
 *
 * **As root** (`root: true`, run with the platform's `sudo`) the service, its
 * dependencies and the browser profile live in /opt/synz, owned by root: the
 * profile is readable by nobody else, and nothing the account's own commands
 * can write is ever run by root — so a command talked into it by a web page can
 * neither read the sign-ins nor plant code the service would run with its key.
 * The profile made before this, in the account's folder, moves there once. The
 * Python session is still the account's: the service starts it as the owner of
 * the working folder.
 *
 * **As the account** — where the platform will not run it as root — it is what
 * it always was: everything in `.synz-browser` in the working folder, the
 * profile guarded by `assessRisk` (SEC-036) rather than by the file system.
 *
 * Either way the old service is stopped by the pid it wrote, never by name —
 * this was `pkill -f 'node service.mjs'`, and the shell running this very
 * script had those words on its own command line, so pkill killed the script
 * before it reached `exec`: no service, an empty service.log, and "did not come
 * up in time" on every first start.
 *
 * @param {string} build
 * @param {{ root?: boolean }} [options]
 */
export function startScript(build, { root = false } = {}) {
  const write = [
    'printf %s "$SYNZ_SERVICE" | base64 -d > service.mjs',
    'printf %s "$SYNZ_KERNEL" | base64 -d > kernel.py',
  ];
  const run = (where) => [
    'if [ -f service.pid ]; then kill "$(cat service.pid)" 2>/dev/null || true; sleep 0.3; fi',
    'echo $$ > service.pid',
    `echo "starting $(date -u +%FT%TZ) node $(node -v) ${where}" > service.log`,
    'exec node service.mjs >> service.log 2>&1',
  ];
  if (!root) {
    return [
      'set -e',
      'export SYNZ_WORKDIR="$PWD"',
      `mkdir -p ${DIR} && cd ${DIR}`,
      ...write,
      ...installLines(build),
      'export SYNZ_PROFILE="$PWD/profile" SYNZ_KERNEL_PATH="$PWD/kernel.py"',
      ...run('as the account'),
    ].join('\n');
  }
  return [
    'set -e',
    'if [ "$(id -u)" != 0 ]; then echo "not root" >&2; exit 3; fi',
    'WORK="$PWD"',
    'export SYNZ_WORKDIR="$WORK"',
    'export SYNZ_RUN_UID="$(stat -c %u "$WORK")" SYNZ_RUN_GID="$(stat -c %g "$WORK")"',
    'export SYNZ_RUN_HOME="$(awk -F: -v u="$SYNZ_RUN_UID" \'$3==u{print $6; exit}\' /etc/passwd)"',
    'umask 022',
    `mkdir -p ${ROOT_DIR} && chown root:root ${ROOT_DIR} && chmod 755 ${ROOT_DIR} && cd ${ROOT_DIR}`,
    ...write,
    ...installLines(build),
    /*
     * The sign-ins, moved out of the account's folder once, and closed to it.
     * Only a real folder moves (a link would point root's profile anywhere);
     * it is shut to the account first, then any link inside it — planted to
     * have root's browser write somewhere it should not — is removed. Without
     * `find` to do that, the old profile is dropped and the person signs in
     * again rather than root trusting it.
     */
    `OLDPROFILE="$WORK/${DIR}/profile"`,
    'if [ ! -e profile ] && [ -d "$OLDPROFILE" ] && [ ! -L "$OLDPROFILE" ]; then',
    '  mv "$OLDPROFILE" profile.moving && chmod 700 profile.moving && chown -R root:root profile.moving',
    '  if command -v find >/dev/null 2>&1 && find profile.moving -type l -exec rm -f {} +; then mv profile.moving profile; else rm -rf profile.moving; fi',
    'fi',
    'mkdir -p profile && chmod 700 profile && chown -R root:root profile',
    `export SYNZ_PROFILE=${ROOT_DIR}/profile SYNZ_KERNEL_PATH=${ROOT_DIR}/kernel.py`,
    /*
     * A temporary folder of root's own. @sparticuz/chromium unpacks the browser
     * to `<tmp>/chromium` and runs whatever it finds there without a check —
     * in the shared /tmp, a file the account's commands left at that name would
     * be run as root, key in hand.
     */
    `mkdir -p ${ROOT_DIR}/tmp && chmod 700 ${ROOT_DIR}/tmp && export TMPDIR=${ROOT_DIR}/tmp`,
    // A service the account started before this listens on the same port. Its pid
    // file is the account's to write, so only a process the account owns is stopped.
    `OLD="$(cat "$WORK/${DIR}/service.pid" 2>/dev/null || true)"`,
    'case "$OLD" in ""|*[!0-9]*) ;; *) if [ "$(stat -c %u /proc/$OLD 2>/dev/null)" = "$SYNZ_RUN_UID" ]; then kill "$OLD" 2>/dev/null || true; sleep 0.3; fi ;; esac',
    ...run('as root'),
  ].join('\n');
}

const key = () => crypto.randomBytes(32).toString('base64url');

/**
 * A token for the person's panel: `<scope>.<expiry>.<signature>`, signed with
 * the service's key, which the panel never sees. `view` shows the screen;
 * `drive` also carries the person's gestures. Checked by `tokenScope` in
 * service.mjs — the same recipe.
 *
 * @param {string} secret  the connection's key
 * @param {'view' | 'drive'} scope
 * @param {number} [ttl]
 * @param {number} [now]
 */
export function panelToken(secret, scope, ttl = TOKEN_MS, now = Date.now()) {
  const exp = String(now + ttl);
  const sig = crypto.createHmac('sha256', secret).update(`${scope}.${exp}`).digest('base64url');
  return `${scope}.${exp}.${sig}`;
}

/**
 * Where the service is and the key that drives it — sealed the way provider
 * keys are (SEC-037).
 *
 * The key is a signed-in browser: whoever holds it can act as the person on
 * every site the cloud browser has a session for. A row that cannot be opened —
 * one written before this, or after the encryption key changed — reads as no
 * connection, and the next action starts the service with a fresh key.
 */
async function readConnection(userId) {
  const value = await getStore().getUserSetting(userId, SETTING);
  if (!value || typeof value !== 'object' || !value.url || !value.key) return null;
  const secret = decryptSecret(value.key);
  return secret ? { ...value, key: secret } : null;
}

async function saveConnection(userId, value) {
  await getStore().setUserSetting(userId, SETTING, { ...value, key: encryptSecret(value.key) });
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
    /*
     * No redirect followed, and the reply read up to a ceiling. The machine is
     * the account's own, with root: what answers on its port can be the
     * account's own listener rather than the service, and a 302 from it would
     * send this server's next request wherever it pointed, from inside the
     * deployment. A redirect is not the service, so it reads as "not there".
     */
    const res = await fetch(`${conn.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-synz-key': conn.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) return null;
    const { buffer, truncated } = await readCapped(res, MAX_REPLY_BYTES);
    if (truncated) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * One attempt at starting the service, as root or as the account, and waiting
 * until it answers. A new key every start, so an old token stops working.
 */
async function startAs(machine, userId, url, mode, { signal, firstTime }) {
  const { source, kernel, build } = service();
  const conn = { url, key: key(), build, extendedAt: Date.now(), mode, isolated: false };
  const env = {
    SYNZ_SERVICE: source.toString('base64'),
    SYNZ_KERNEL: kernel.toString('base64'),
    SYNZ_KEY: conn.key,
    PORT: '3000',
    /*
     * Tells @sparticuz/chromium it is on an AL2023-compatible host, so it
     * unpacks the shared libraries Chromium needs (libnss3 and the rest) and
     * points LD_LIBRARY_PATH at them. It looks for VERCEL or a Lambda runtime
     * variable; the sandbox has neither, and without them Chromium cannot load
     * on a minimal image.
     */
    VERCEL: '1',
    AWS_LAMBDA_JS_RUNTIME: 'nodejs22.x',
    // Trackers are unresolvable in the cloud browser unless the operator says otherwise.
    ...(process.env.CLOUD_BROWSER_BLOCK_TRACKERS === '0' ? { SYNZ_TRACKERS: '0' } : {}),
  };
  // No login profile first (HAR-001, shellFor): the service's key is in this environment.
  const command = await machine.runCommand({
    ...shellFor(startScript(build, { root: mode === 'root' }), env, { root: mode === 'root' }),
    sudo: mode === 'root',
    detached: true,
    signal,
  });
  // A start that dies says so at once, rather than after the whole wait.
  let exited = false;
  Promise.resolve(command?.wait?.({ signal }))
    .then((done) => {
      if (done) exited = true;
    })
    .catch(() => {});

  const deadline = Date.now() + (firstTime ? FIRST_START_MS : START_MS);
  while (Date.now() < deadline && !exited) {
    const health = await call(conn, '/health', undefined, { timeout: PEEK_MS, signal });
    if (health) {
      conn.isolated = !!health.isolated;
      await saveConnection(userId, conn);
      return conn;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  let log = '';
  try {
    const folder = mode === 'root' ? ROOT_DIR : DIR;
    const setup = await machine.readFileToBuffer({ path: `${folder}/setup.log` }, { signal });
    const serviceLog = await machine.readFileToBuffer({ path: `${folder}/service.log` }, { signal });
    log = `${setup?.toString('utf8') || ''}\n${serviceLog?.toString('utf8') || ''}`.trim().slice(-1200);
  } catch {
    /* the log is a help, not a requirement */
  }
  throw Object.assign(
    new Error(
      exited
        ? `The cloud computer's helper stopped as it started.${log ? `\nIts log ends:\n${log}` : ''}`
        : `The cloud browser did not come up in time.${log ? `\nIts log ends:\n${log}` : ''}`,
    ),
    { exited },
  );
}

/**
 * Start (or restart) the helper service on the account's machine.
 *
 * As root first, so the sign-ins are out of the account's commands' reach;
 * where the platform will not — the start stops at once rather than coming up —
 * as the account, the way it always ran. One that is merely slow (a first
 * install) is not tried twice: two full waits would outlast the request. An
 * account whose machine already fell back on this build goes straight there.
 *
 * @param {string} userId
 * @param {{ signal?: AbortSignal }} [options]
 */
async function start(userId, { signal } = {}) {
  const machine = await machineForUser(userId, { signal });
  const url = (await browserAddress(machine, { signal })).replace(/\/$/, '');
  const before = await readConnection(userId).catch(() => null);
  const firstTime = before?.build !== service().build;
  if (!firstTime && before?.mode === 'user') return startAs(machine, userId, url, 'user', { signal, firstTime });
  try {
    return await startAs(machine, userId, url, 'root', { signal, firstTime });
  } catch (err) {
    if (signal?.aborted || !err?.exited) throw err;
    return startAs(machine, userId, url, 'user', { signal, firstTime: true });
  }
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

/**
 * One request to the account's helper service, starting it when it is not
 * running (or is running an older build).
 *
 * @param {string} userId
 * @param {string} route
 * @param {any} body
 * @param {{ signal?: AbortSignal, timeout?: number }} [options]
 */
async function serviceCall(userId, route, body, { signal, timeout } = {}) {
  let conn = await readConnection(userId);
  let answer = conn && conn.build === service().build ? await call(conn, route, body, { signal, timeout }) : null;
  if (!answer) {
    conn = await start(userId, { signal });
    answer = await call(conn, route, body, { signal, timeout });
    if (!answer) throw new Error('The cloud computer\'s helper started but did not answer. Try once more.');
  } else {
    await keepAwake(userId, conn, { signal });
  }
  return answer;
}

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The service's answer, as the model reads it. */
export function describePage(page) {
  const lines = [`Page: ${page.title || '(untitled)'}`, page.url || ''];
  if (Array.isArray(page.did) && page.did.length) lines.push(`Did, in order: ${page.did.join(' → ')}`);
  const at = page.position;
  if (at && at.height > (at.viewHeight || 0) + 4) {
    const down = Math.round((100 * at.y) / Math.max(1, at.height - at.viewHeight));
    lines.push(`Scrolled ${at.y}px of ${at.height}px down (${Math.min(100, down)}%)${at.x ? `, ${at.x}px across of ${at.width}px` : ''}.`);
  } else if (at && at.width > (at.viewWidth || 0) + 4) {
    lines.push(`The page is ${at.width}px wide; ${at.x}px scrolled across.`);
  }
  const tabs = Array.isArray(page.tabs) ? page.tabs : [];
  if (tabs.length > 1) {
    lines.push('', 'Tabs:', ...tabs.map((tab) => `${tab.active ? '→' : ' '} ${tab.index}. ${tab.title || tab.url}`));
  }
  const files = Array.isArray(page.downloads) ? page.downloads : [];
  if (files.length) {
    lines.push(
      '',
      'Downloaded, into the cloud computer\'s working folder (sandbox_run and the Python session can open them; `download` hands one to the user):',
      ...files.map((f) => (f.error ? `  (a download failed: ${f.error})` : `  ${f.path} — ${kb(f.bytes || 0)}`)),
    );
  }
  if (!page.textOnly) {
    const elements = Array.isArray(page.elements) ? page.elements : [];
    lines.push('', elements.length ? 'Things to click or fill — use the number as `ref`:' : 'Nothing to click or fill is visible.');
    lines.push(...elements);
  }
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
  // A batch takes longer than one action: up to ten of them.
  const timeout = action === 'steps' ? ACT_MS * 2 : ACT_MS;
  const page = await serviceCall(userId, '/act', { ...input, action }, { signal, timeout });

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
 * A cell for the conversation's live Python session (`sandbox_run` with
 * `python`). One session per conversation, named by a digest of its id, so
 * two conversations of one account never share variables.
 *
 * @param {string} userId
 * @param {{ chatId?: string | null, code: string, reset?: boolean, timeoutMs?: number, signal?: AbortSignal }} request
 */
export async function runPythonCell(userId, { chatId, code, reset = false, timeoutMs = 120_000, signal }) {
  const session = crypto.createHash('sha256').update(`py:${userId}:${chatId || 'none'}`).digest('hex').slice(0, 24);
  return serviceCall(userId, '/py', { session, code, reset, timeoutMs }, { signal, timeout: timeoutMs + 20_000 });
}

/**
 * What the screen panel needs: where the screen is, and fresh tokens to watch
 * and drive it. Never starts anything — a person opening the panel should not
 * cost a machine. While somebody drives, it also keeps the machine awake: their
 * gestures go straight to it and never pass through here to do that.
 *
 * @param {string} userId
 * @param {{ driving?: boolean }} [options]
 */
export async function cloudBrowserState(userId, { driving = false } = {}) {
  const conn = await readConnection(userId);
  if (!conn || conn.build !== service().build) return { open: false };
  const meta = await call(conn, '/meta', undefined, { timeout: PEEK_MS });
  if (!meta?.open) return { open: false };
  if (driving) await keepAwake(userId, conn);
  const now = Date.now();
  return {
    open: true,
    stream: `${conn.url}/stream?t=${encodeURIComponent(panelToken(conn.key, 'view', TOKEN_MS, now))}`,
    live: {
      url: `${conn.url.replace(/^http/, 'ws')}/live`,
      token: panelToken(conn.key, 'drive', TOKEN_MS, now),
      expiresAt: now + TOKEN_MS,
    },
    isolated: !!conn.isolated,
    title: meta.title,
    url: meta.url,
    tabs: meta.tabs || [],
  };
}

const BUTTONS = new Set(['left', 'right', 'middle']);
/** A key, or one key with up to three modifiers — the same grammar as `CHORD` in service.mjs. */
const CHORD =
  /^(?:(?:Control|Shift|Alt|Meta)\+){0,3}(?:[A-Za-z0-9]|[`\-=[\]\\;',./]|F(?:[1-9]|1[0-2])|Enter|Backspace|Tab|Escape|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Insert|Space)$/;
const fraction = (value) => Math.min(1, Math.max(0, Number(value) || 0));
const bounded = (value, limit) => Math.max(-limit, Math.min(limit, Number(value) || 0));

/**
 * A gesture from a person driving the panel, checked before it goes on: only
 * the shapes the panel sends, coordinates inside the frame, short text. The
 * same rules as `cleanGesture` in service.mjs, which guards the socket.
 *
 * @param {Record<string, any>} event
 */
export function cleanInput(event) {
  const type = String(event?.type || '');
  const at = { x: fraction(event?.x), y: fraction(event?.y) };
  switch (type) {
    case 'move':
      return { type, ...at };
    case 'down':
    case 'up':
    case 'click':
      return { type, ...at, button: BUTTONS.has(event.button) ? event.button : 'left', count: Math.min(3, Math.max(1, Math.floor(Number(event.count)) || 1)) };
    case 'drag':
      return { type, ...at, toX: fraction(event.toX), toY: fraction(event.toY) };
    case 'scroll':
    case 'wheel': {
      const deltaX = bounded(event.deltaX ?? event.dx, 3000);
      const deltaY = bounded(event.deltaY ?? event.dy, 3000);
      return deltaX || deltaY ? { type: 'scroll', ...at, deltaX, deltaY } : null;
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
      return { type, index: Math.max(1, Math.min(50, Math.floor(Number(event.index ?? event.key)) || 1)) };
    default:
      return null;
  }
}

/**
 * Gestures relayed through the server — the panel's fallback when it cannot
 * open the socket to the machine. Several at once, in order.
 *
 * @param {string} userId
 * @param {Record<string, any>} body  one gesture, or `{ events: [...] }`
 */
export async function cloudBrowserInput(userId, body) {
  const events = (Array.isArray(body?.events) ? body.events : [body]).slice(0, 60).map(cleanInput).filter(Boolean);
  if (!events.length) throw new Error('That is not something the screen can do.');
  const conn = await readConnection(userId);
  const answer = conn ? await call(conn, '/input', { events }, { timeout: 20_000 }) : null;
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

export const __testing = { service, readConnection, saveConnection, call, SETTING, DIR, ROOT_DIR };
