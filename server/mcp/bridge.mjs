/**
 * The MCP bridge — runs on an account's cloud computer, never on the server.
 *
 * A stdio MCP server is a program somebody names: `npx -y gitnexus@latest mcp`.
 * On a deployment the server must not spawn it (every child inherits
 * ENCRYPTION_KEY, which unlocks every account's keys), so it runs here instead,
 * on the account's own Vercel Sandbox, and this script is how the server talks
 * to it: one small HTTPS endpoint that starts the program, keeps it warm, and
 * passes JSON-RPC messages to and from its stdin and stdout.
 *
 * Copied to the machine and started by server/mcp/cloud.js. No dependencies, no
 * imports from the app: the machine has Node and nothing of ours.
 *
 * **One key.** Every request carries `x-synz-key`, a random value made at each
 * start and known only to the server; the machine's address is public, so
 * without it anybody who found the address could run programs on it.
 *
 * **Handshakes are kept.** A serverless server connects afresh on every turn
 * and says `initialize` each time; an MCP server already running refuses a
 * second one. The first answer is kept and repeated, and a repeated
 * `notifications/initialized` is dropped, so a program started an hour ago is
 * as usable as one started now.
 *
 * **Ids are its own.** Two server instances can talk to the same program at
 * once, and both count their JSON-RPC ids from one. Each message is renumbered
 * on the way in and given its own id back on the way out, so one caller can
 * never receive another's answer.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const KEY = process.env.SYNZ_MCP_KEY || '';
const PORT = Number(process.env.PORT) || 3100;
/** A program nobody has used for this long is stopped; the next call starts it again. */
const IDLE_MS = 20 * 60_000;
const MAX_PROGRAMS = 8;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_WAIT_MS = 280_000;

/** id → { child, pending: Map<number, {resolve, timer, callerId}>, seq, init, stderr, closed, usedAt } */
const programs = new Map();

function authorised(req) {
  const got = Buffer.from(String(req.headers['x-synz-key'] || ''));
  const want = Buffer.from(KEY);
  return KEY.length >= 16 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Stop a program. With `only`, only if that program is still the one under
 * this id — a program that has just exited late must not take down the one
 * started in its place.
 */
function stop(id, reason, only = null) {
  const program = programs.get(id);
  if (!program || (only && program !== only)) return;
  programs.delete(id);
  program.closed = reason;
  for (const [, waiting] of program.pending) {
    clearTimeout(waiting.timer);
    waiting.resolve({ failed: reason });
  }
  program.pending.clear();
  try {
    program.child.stdin.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => program.child.kill(), 1500).unref();
}

function start(id, spec) {
  if (programs.size >= MAX_PROGRAMS) {
    // The least recently used one makes room, rather than refusing a new one.
    const oldest = [...programs.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (oldest) stop(oldest[0], 'Stopped to make room for another server.');
  }
  const command = String(spec?.command || '').trim();
  if (!command) throw new Error('No command to start.');
  const args = Array.isArray(spec?.args) ? spec.args.map(String) : [];
  const env = spec?.env && typeof spec.env === 'object' ? spec.env : {};
  const child = spawn(command, args, { env: { ...process.env, ...env, SYNZ_MCP_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const program = { child, pending: new Map(), seq: 0, init: null, initialized: false, stderr: '', closed: null, usedAt: Date.now() };
  programs.set(id, program);
  // A write to a program that has just died fails with EPIPE on this stream; the
  // `close` handler below says why, and an unheard error here would take the
  // whole bridge — every other program on it — down with it.
  child.stdin.on('error', () => {});

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a banner on stdout is not a protocol error
      }
      const waiting = message.id !== undefined ? program.pending.get(message.id) : null;
      if (!waiting) continue;
      program.pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.resolve({ message: { ...message, id: waiting.callerId } });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    program.stderr = `${program.stderr}${chunk}`.slice(-4000);
  });
  const ended = (why) => {
    const tail = program.stderr.trim().split('\n').slice(-4).join(' ');
    stop(id, `${why}${tail ? ` It said: ${tail}` : ''}`, program);
  };
  child.on('error', (err) => ended(`Could not start "${command}": ${err.message}.`));
  child.on('close', (code) => ended(`The server process exited${code == null ? '' : ` with code ${code}`}.`));
  return program;
}

/** One request to a program, renumbered with its own id; the answer, or `{ failed }`. */
function ask(program, message, timeoutMs) {
  program.seq += 1;
  const own = program.seq;
  const wait = Math.min(Math.max(Number(timeoutMs) || 30_000, 1000), MAX_WAIT_MS);
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => {
      program.pending.delete(own);
      resolve({ failed: `The server did not answer within ${Math.round(wait / 1000)}s.` });
    }, wait);
    program.pending.set(own, { resolve, timer, callerId: message.id });
  });
  program.child.stdin.write(`${JSON.stringify({ ...message, id: own })}\n`);
  return answer;
}

/**
 * Greet a program, once, and tell it the greeting is done.
 *
 * `notifications/initialized` is sent here, straight after the answer, rather
 * than when the caller's own arrives: that is a separate request, and it can
 * reach the bridge after the caller's `tools/list` — which a server not yet
 * told it is initialised may refuse. The caller's copy is then dropped.
 */
async function greet(program, message, timeoutMs) {
  // Two callers greeting a program that has just started share the one
  // greeting: a second `initialize` would be refused by the program.
  if (program.greeting) {
    await program.greeting;
    return program.init
      ? { message: { jsonrpc: '2.0', id: message.id, result: program.init } }
      : { failed: 'The server refused to start a session.' };
  }
  program.greeting = ask(program, message, timeoutMs);
  const out = await program.greeting;
  program.greeting = null;
  if (out.message?.result && !program.init) {
    program.init = out.message.result;
    program.initialized = true;
    program.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }
  return out;
}

/** What the bridge says when it has to greet a program itself. */
const BRIDGE_HELLO = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synapsez-bridge', version: '1.0.0' } };

/** One JSON-RPC message to one program; its answer, or `{ failed }`. */
async function deliver(id, spec, message, timeoutMs) {
  let program = programs.get(id);
  if (!program || program.closed) program = start(id, spec);
  program.usedAt = Date.now();

  if (message.method === 'initialize') {
    if (program.init) return { message: { jsonrpc: '2.0', id: message.id, result: program.init } };
    return greet(program, message, timeoutMs);
  }
  if (message.id === undefined) {
    // Already sent by `greet`; any other notification passes through.
    if (message.method === 'notifications/initialized') return { accepted: true };
    program.child.stdin.write(`${JSON.stringify(message)}\n`);
    return { accepted: true };
  }
  /*
   * A program started for a request that is not the greeting — it was stopped
   * after a quiet spell, or the bridge restarted, while the server still holds
   * the connection it greeted earlier. A server refuses requests before it has
   * been initialised, so the bridge greets it first.
   */
  if (!program.init) {
    const hello = await greet(program, { jsonrpc: '2.0', id: '__bridge_hello', method: 'initialize', params: BRIDGE_HELLO }, timeoutMs);
    if (hello.failed) return hello;
    if (!program.init) return { failed: 'The server refused to start a session.' };
  }
  return ask(program, message, timeoutMs);
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!authorised(req)) return reply(res, 401, { error: 'unauthorised' });
  const url = new URL(req.url || '/', 'http://bridge');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { ok: true, programs: programs.size });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const body = JSON.parse(await readBody(req));
      const id = String(body?.id || '').slice(0, 64);
      if (!id || !body?.message || typeof body.message !== 'object') return reply(res, 400, { error: 'id and message are needed' });
      const out = await deliver(id, body.spec, body.message, body.timeoutMs);
      if (out.failed) return reply(res, 500, { error: out.failed });
      return out.accepted ? reply(res, 202, { ok: true }) : reply(res, 200, { message: out.message });
    }
    if (req.method === 'POST' && url.pathname === '/close') {
      const body = JSON.parse(await readBody(req));
      stop(String(body?.id || ''), 'Closed.');
      return reply(res, 200, { ok: true });
    }
    return reply(res, 404, { error: 'not found' });
  } catch (err) {
    return reply(res, 500, { error: String(err?.message || err).slice(0, 500) });
  }
});

// Programs nobody is using are stopped; a quiet machine then pauses on its own.
setInterval(() => {
  const now = Date.now();
  for (const [id, program] of programs) if (now - program.usedAt > IDLE_MS) stop(id, 'Stopped after a quiet spell.');
}, 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mcp bridge listening on ${PORT}`);
});
