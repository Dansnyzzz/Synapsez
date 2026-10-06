import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '../store/index.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { readCapped } from '../util/safeFetch.js';
import { chargeCloud, machineForUser, portAddress, sandboxConfigured, scratchMachine, discardMachine, MCP_PORT } from '../sandbox.js';

/**
 * stdio MCP servers on a deployment: on the account's own cloud computer.
 *
 * "Máy chủ MCP stdio không chạy được trên bản triển khai này" was the honest
 * answer while the only place to run one was the server itself — a child of the
 * server inherits ENCRYPTION_KEY, which unlocks every account's keys, and on
 * Vercel a function cannot keep a program running between requests anyway. The
 * account's Vercel Sandbox has neither problem: it is a machine of its own with
 * none of the server's secrets, it already runs `sandbox_run` and the cloud
 * browser, and a program started there is still running on the next turn. So a
 * stdio server runs there, behind bridge.mjs, and the server reaches it over
 * https with a key only it knows.
 *
 * Three things keep this cheap on a free plan:
 *
 *   - **Nothing starts until a tool is called.** A turn offers the server's
 *     tools from the list kept when it was added; the machine starts on the
 *     first call, and pauses by itself when idle.
 *   - **A program stays warm.** The bridge keeps it between turns and stops it
 *     after twenty quiet minutes.
 *   - **A command is checked once for everybody.** The first time anyone adds
 *     `npx -y gitnexus@latest mcp`, it is started on a scratch machine that
 *     belongs to nobody, and what it lists is kept in `mcp_shared`. Every
 *     account after that adds it at once — "connected", tools listed — and only
 *     its own machine ever runs it. A scratch machine rather than the first
 *     account's own: that account has root there, and whatever it listed would
 *     be shown to everybody after it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SETTING = 'mcpBridge';
const DIR = '.synz-mcp';
const START_MS = 45_000;
const PEEK_MS = 3_000;
/**
 * How long a scratch machine may take to be created. With the bridge's start
 * (START_MS) and the first handshake (client.js CLOUD_HANDSHAKE_MS) it stays
 * inside the function's 300s (vercel.json `maxDuration`).
 */
const CHECK_MS = 90_000;
/** Quiet this long, and a tool call checks the bridge is still there before it is sent. */
const QUIET_MS = 60_000;

/**
 * Where a stdio server can run here, if anywhere.
 *
 * `local` is the old way, a child of this process — only where the owner has
 * said so (ALLOW_MCP_STDIO) on a machine that is not shared infrastructure.
 * `cloud` is the account's own Vercel Sandbox. Null: neither, and the interface
 * says what would make it possible.
 *
 * @returns {'local' | 'cloud' | null}
 */
export function stdioPlace(env = process.env) {
  if (!env.VERCEL && /^(1|true|yes)$/i.test(env.ALLOW_MCP_STDIO || '')) return 'local';
  return sandboxConfigured(env) ? 'cloud' : null;
}

/**
 * What identifies a stdio server across accounts: its command and arguments.
 * Never its environment, which can hold somebody's token.
 *
 * @param {{ command?: string, args?: string[] }} config
 */
export function mcpSignature(config) {
  const parts = ['stdio', String(config?.command || '').trim(), ...(config?.args || []).map(String)];
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

let sourceCache = null;
/** The bridge's source and a fingerprint of it — a new build restarts the bridge. */
function bridgeSource() {
  if (!sourceCache) {
    const source = fs.readFileSync(path.join(here, 'bridge.mjs'));
    sourceCache = { source, build: crypto.createHash('sha256').update(source).digest('hex').slice(0, 16) };
  }
  return sourceCache;
}

/**
 * The script that brings the bridge up. The old bridge is stopped by the pid it
 * wrote — never by name, which would match this script's own command line (see
 * the same note in cloudBrowser/index.js).
 */
export function bridgeStartScript() {
  return [
    'set -e',
    `mkdir -p ${DIR} && cd ${DIR}`,
    'printf %s "$SYNZ_BRIDGE" | base64 -d > bridge.mjs',
    'if [ -f bridge.pid ]; then kill "$(cat bridge.pid)" 2>/dev/null || true; sleep 0.3; fi',
    'echo $$ > bridge.pid',
    'echo "starting $(date -u +%FT%TZ) node $(node -v)" > bridge.log',
    'exec node bridge.mjs >> bridge.log 2>&1',
  ].join('\n');
}

const newKey = () => crypto.randomBytes(24).toString('base64url');

/** The most a bridge's reply may be. A tool's answer is cut at 60k characters (client.js `flatten`). */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/**
 * One request to a bridge. `{ status, body }`, or `{ status: 0 }` when nothing
 * answered — a stopped machine, a bridge not yet up.
 *
 * **Never follows a redirect.** The machine at the other end is the account's
 * own, with root (cloud.js says so above), so whatever answers on its port can
 * be the account's own listener rather than the bridge — and a 302 from it
 * would send this server's next request wherever it pointed, from inside the
 * deployment. A redirect is an answer from something that is not the bridge,
 * and is read as one: not reached. The reply is read up to a ceiling for the
 * same reason. (The http transport refuses redirects for the same cause; see
 * `httpTransport` in client.js.)
 *
 * @param {{ url: string, key: string }} conn
 * @param {string} route
 * @param {any} body  undefined for a GET
 * @param {number} timeoutMs
 */
export async function bridgeCall(conn, route, body, timeoutMs) {
  try {
    const res = await fetch(`${conn.url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-synz-key': conn.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) return { status: res.status, body: null, redirected: true };
    let parsed = null;
    const { buffer, truncated } = await readCapped(res, MAX_REPLY_BYTES);
    if (truncated) return { status: 413, body: null };
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      /* the platform's own error page */
    }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Start the bridge on a machine and wait until it answers.
 *
 * @param {any} machine
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function startBridge(machine, { signal } = {}) {
  const url = String(await portAddress(machine, MCP_PORT, { signal })).replace(/\/$/, '');
  const { source, build } = bridgeSource();
  const conn = { url, key: newKey(), build };
  await machine.runCommand({
    cmd: 'bash',
    args: ['-lc', bridgeStartScript()],
    env: { SYNZ_BRIDGE: source.toString('base64'), SYNZ_MCP_KEY: conn.key, PORT: String(MCP_PORT) },
    detached: true,
    signal,
  });
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    if ((await bridgeCall(conn, '/health', undefined, PEEK_MS)).status === 200) return conn;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('The MCP bridge on the cloud computer did not come up in time.');
}

async function readBridge(userId) {
  const value = await getStore().getUserSetting(userId, SETTING);
  if (!value || typeof value !== 'object' || !value.url || !value.key) return null;
  const key = decryptSecret(value.key);
  return key ? { ...value, key } : null;
}

async function saveBridge(userId, conn) {
  // The key drives programs on the account's machine, so it is sealed like a
  // provider key — a database dump alone does not hand it over.
  await getStore().setUserSetting(userId, SETTING, { ...conn, key: encryptSecret(conn.key) });
}

/** Starts in progress on this instance, by account, so parallel calls share one. */
const starting = new Map();

/**
 * The account's bridge: the one already running, or a new one on its machine.
 *
 * `stale` is a bridge that just failed to answer. The one on file is read again
 * first: another instance may have started a new bridge since, under a new key —
 * and starting yet another would stop that one, and the programs it keeps warm.
 * On this instance, two calls that both need a new bridge share one start.
 *
 * @param {string} userId
 * @param {{ stale?: { key: string } | null, signal?: AbortSignal }} [options]
 */
export async function bridgeFor(userId, { stale = null, signal } = {}) {
  const known = await readBridge(userId).catch(() => null);
  const usable = known && known.build === bridgeSource().build && (!stale || known.key !== stale.key);
  if (usable && (await bridgeCall(known, '/health', undefined, PEEK_MS)).status === 200) return known;
  if (!starting.has(userId)) {
    const start = (async () => {
      // Starting a machine is what the daily cloud budget counts.
      await chargeCloud(userId);
      const machine = await machineForUser(userId, { signal });
      const conn = await startBridge(machine, { signal });
      await saveBridge(userId, conn);
      return conn;
    })().finally(() => starting.delete(userId));
    starting.set(userId, start);
  }
  return starting.get(userId);
}

/**
 * Statuses that mean a request never reached a live bridge.
 *
 * Only some of them are certain. 401, 404, 410, 503 and a redirect come from
 * something that is not a live bridge holding our key, so nothing ran. A dropped
 * connection (0), a 502 or a 504 can come after the request had arrived — the
 * program may have run it — so they are safe to repeat only for what changes
 * nothing: the handshake, the tool list, a notification. Never `tools/call`: a
 * tool that sends or deletes something must not run twice because a reply was
 * lost on the way back.
 */
const NOT_REACHED = new Set([401, 404, 410, 503]);
const MAYBE_REACHED = new Set([0, 502, 504]);

/**
 * A transport, in the shape client.js expects, to a program behind a bridge.
 *
 * `conn` is a bridge already started (a scratch machine); without it, the
 * account's own bridge is found or started on the first request. A request that
 * did not reach a live bridge — the machine paused, the bridge restarted with a
 * new key — starts it again and is sent once more; one that may have reached it
 * is sent again only if it changes nothing (see NOT_REACHED), and one that
 * reached it and failed is the program's answer and is not repeated.
 *
 * Closing leaves the program running: the next turn finds it warm, and the
 * bridge stops it after a quiet spell.
 *
 * @param {{ command: string, args?: string[], env?: Record<string, string> }} config
 * @param {{ userId?: string, conn?: { url: string, key: string } | null }} [options]
 */
export function cloudTransport(config, { userId, conn: given = null } = {}) {
  const spec = { command: config.command, args: config.args || [], env: config.env || {} };
  const id = crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
  let conn = given;
  let closed = null;
  let localId = 0;
  /** When the bridge last answered; a tool called after QUIET_MS checks it is still there first. */
  let lastOk = Date.now();

  async function send(message, timeoutMs) {
    if (closed) throw new Error(closed);
    let stale = null;
    // A tool called after a quiet spell asks whether the bridge is still there
    // before sending it — a paused machine is found out by a health check, which
    // runs nothing, rather than by a tool call that cannot safely be repeated.
    if (conn && userId && !given && message.method === 'tools/call' && Date.now() - lastOk > QUIET_MS) {
      if ((await bridgeCall(conn, '/health', undefined, PEEK_MS)).status !== 200) {
        stale = conn;
        conn = null;
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!conn) {
        if (!userId) throw new Error('The cloud computer for this server is not running.');
        conn = await bridgeFor(userId, { stale });
      }
      const out = await bridgeCall(conn, '/rpc', { id, spec, message, timeoutMs }, timeoutMs + 10_000);
      if (out.status === 200 || out.status === 202) {
        lastOk = Date.now();
        return out.status === 200 ? out.body?.message ?? null : null;
      }
      if (out.status === 500) throw new Error(out.body?.error || 'The server on the cloud computer failed.');
      const safeAgain = out.redirected || NOT_REACHED.has(out.status) || (MAYBE_REACHED.has(out.status) && message.method !== 'tools/call');
      if (!safeAgain || given) break;
      stale = conn;
      conn = null;
    }
    // Not trusted again after this: the registry drops a closed connection and
    // the next turn connects afresh, through the handshake that can be repeated.
    closed = 'The connection to the cloud computer was lost.';
    throw new Error('The cloud computer for this server could not be reached.');
  }

  return {
    kind: 'cloud',
    get closed() {
      return closed;
    },
    async request(method, params, timeoutMs = 30_000) {
      // A tool actually running is what costs the shared allowance; listing does not.
      if (method === 'tools/call' && userId) await chargeCloud(userId);
      localId += 1;
      const reply = await send({ jsonrpc: '2.0', id: localId, method, params }, timeoutMs);
      if (!reply) throw new Error('The server accepted the request but sent no answer.');
      if (reply.error) {
        const detail = reply.error.data ? ` (${JSON.stringify(reply.error.data).slice(0, 200)})` : '';
        throw new Error(`${reply.error.message || 'Unknown error'}${detail}`);
      }
      return reply.result;
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params }, 10_000).catch(() => {});
    },
    close() {
      closed = 'The connection was closed.';
    },
  };
}

/**
 * Start a server on a scratch machine with no environment, list it, and throw
 * the machine away. What the next account to add the same command is shown.
 *
 * @param {{ command: string, args?: string[] }} config
 * @param {(config: object) => Promise<any>} connect  client.js's connectMcp
 */
export async function checkOnScratch(config, connect) {
  const machine = await scratchMachine({ signal: AbortSignal.timeout(CHECK_MS) });
  try {
    const conn = await startBridge(machine);
    const connection = await connect({ transport: 'stdio', command: config.command, args: config.args || [], place: 'cloud', bridge: conn });
    const found = { server: connection.server || {}, tools: connection.tools || [] };
    connection.close();
    return found;
  } finally {
    await discardMachine(machine);
  }
}

export const __testing = { bridgeSource, NOT_REACHED, MAYBE_REACHED, SETTING };
