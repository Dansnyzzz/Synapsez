import { spawn } from 'node:child_process';
import path from 'node:path';
import { assertPublic, safeFetch } from '../util/safeFetch.js';
import { cloudTransport, stdioPlace } from './cloud.js';

/**
 * Whether this process may start a stdio MCP server as a child of its own.
 *
 * A stdio server spawned here inherits the server's environment — including
 * `ENCRYPTION_KEY`, the one key every stored account's provider keys are
 * encrypted under. So on this process it is "run a program on the server with
 * the keys to everything", and on a deployment several tenants share it is one
 * account reading them all.
 *
 * Denied by default for that reason, on the same opt-in principle as
 * `FILE_ACCESS=full` and `ALLOW_PRIVATE_FETCH`: the safe case is the one you get
 * without deciding. `ALLOW_MCP_STDIO` turns it on for a single-owner machine
 * that wants it, and serverless never. Everywhere else a stdio server runs on
 * the account's own cloud computer instead — see cloud.js and `stdioPlace`.
 */
export function stdioAllowed() {
  return stdioPlace() === 'local';
}

/**
 * A Model Context Protocol client, in about three hundred lines and no
 * dependencies.
 *
 * MCP is why this is worth having at all: it turns a fixed list of tools into an
 * open one. Somebody who needs Figma, Jira, Sentry, Postgres or a hundred other
 * things plugs in a server and the assistant can use it, with nothing added to
 * this repository.
 *
 * **Why not the official SDK.** `@modelcontextprotocol/sdk` pulls seventeen
 * dependencies — hono, express, jose, ajv, zod, pkce-challenge and the rest — into
 * a project that has nine on purpose, and this app uses `playwright-core` rather
 * than `playwright` and refuses web fonts for exactly the same reason. What is
 * actually needed here is one side of a JSON-RPC 2.0 conversation over two
 * transports, which is small enough to own.
 *
 * Two transports, because servers ship as one or the other:
 *
 *   **stdio** — a child process, newline-delimited JSON on its pipes. This is
 *   most of them, and it means running a program the user named.
 *
 *   **Streamable HTTP** — POST a request, read either a JSON reply or an SSE
 *   stream. Used by hosted servers.
 *
 * The protocol surface used is deliberately tiny: `initialize`, `tools/list`,
 * `tools/call`. Resources, prompts, sampling and roots are not implemented, and a
 * server offering them is used for its tools and otherwise left alone.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ai-remote', version: '1.0.0' };

const DEFAULT_TIMEOUT_MS = 30_000;
/** A server that will not greet us in this long is not going to. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** The same, on the cloud computer, where the first start installs the package. */
const CLOUD_HANDSHAKE_MS = 150_000;

/** JSON-RPC ids only have to be unique per connection. */
let nextId = 1;

class Pending {
  constructor() {
    this.map = new Map();
  }

  create(id, timeoutMs, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.map.delete(id);
        onTimeout?.();
        reject(new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref?.();
      this.map.set(id, { resolve, reject, timer });
    });
  }

  settle(message) {
    const entry = this.map.get(message.id);
    if (!entry) return;
    this.map.delete(message.id);
    clearTimeout(entry.timer);

    if (message.error) {
      const detail = message.error.data ? ` (${JSON.stringify(message.error.data).slice(0, 200)})` : '';
      entry.reject(new Error(`${message.error.message || 'Unknown error'}${detail}`));
      return;
    }
    entry.resolve(message.result);
  }

  /** Fail everything outstanding — the transport has gone. */
  abort(reason) {
    for (const [, entry] of this.map) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.map.clear();
  }
}

/* ── stdio ──────────────────────────────────────────────────────────── */

/**
 * How to actually start the process, on Windows.
 *
 * `shell: true` was the obvious answer and it is wrong. Node builds the command
 * line by joining the command and its arguments with spaces and **does not quote
 * them**, so a perfectly ordinary command — `C:\Program Files\nodejs\node.exe` —
 * arrives at cmd.exe as `C:\Program`, and the error is
 * *"'C:\Program' is not recognized"*, which points at nothing.
 *
 * But the shell cannot simply be dropped either: most MCP servers are launched
 * with `npx`, which on Windows is `npx.cmd`, and Node refuses to spawn a `.cmd`
 * without one — deliberately, since the argument-injection fix in 18.20.
 *
 * So the shell is used only where it is needed — a `.cmd`/`.bat`, or a bare name
 * that needs PATH resolution — and when it is, every token is quoted properly.
 * Anything with a real extension is spawned directly, spaces and all.
 */
function launchPlan({ command, args = [] }) {
  if (process.platform !== 'win32') return { file: command, list: args, shell: false };

  const extension = path.extname(command).toLowerCase();
  const needsShell = extension === '.cmd' || extension === '.bat' || extension === '';
  if (!needsShell) return { file: command, list: args, shell: false };

  // cmd.exe quoting: wrap anything containing a space or a quote, and double up
  // embedded quotes. With `shell: true` and no argument list, Node hands this
  // whole string to `cmd.exe /d /s /c`, which parses it the way a person would.
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return { file: [quote(command), ...args.map(quote)].join(' '), list: [], shell: true };
}

/**
 * A child process speaking newline-delimited JSON.
 *
 * `stderr` is captured rather than ignored, and that is not tidiness: when an
 * `npx` server fails it says why on stderr and says nothing at all on stdout, so
 * without this the only symptom is a handshake timeout and no reason for it.
 */
function stdioTransport({ command, args = [], env = {}, cwd }) {
  const plan = launchPlan({ command, args });
  const child = spawn(plan.file, plan.list, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: plan.shell,
  });

  const pending = new Pending();
  let buffer = '';
  let stderr = '';
  let closed = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    // Framed by newlines. A partial line stays in the buffer for the next chunk.
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          // Notifications have no id and nothing is waiting for them.
          if (message.id !== undefined) pending.settle(message);
        } catch {
          // Servers print banners to stdout more often than they should. A line
          // that is not JSON is not a protocol error worth killing them over.
        }
      }
      cut = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  const fail = (reason) => {
    closed = reason;
    pending.abort(reason);
  };

  child.on('error', (err) => fail(`Could not start "${command}": ${err.message}`));
  child.on('close', (code) => {
    fail(
      `The server process exited${code == null ? '' : ` with code ${code}`}.` +
        (stderr.trim() ? ` It said: ${stderr.trim().split('\n').slice(-4).join(' ')}` : ''),
    );
  });

  return {
    kind: 'stdio',
    get closed() {
      return closed;
    },
    async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (closed) throw new Error(closed);
      const id = nextId++;
      const waiting = pending.create(id, timeoutMs);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return waiting;
    },
    notify(method, params) {
      if (closed) return;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close() {
      closed = closed || 'The connection was closed.';
      pending.abort(closed);
      child.stdin.end();
      // A server that ignores a closed stdin gets a moment, then goes.
      setTimeout(() => child.kill(), 1500).unref?.();
    },
  };
}

/* ── streamable HTTP ────────────────────────────────────────────────── */

/**
 * POST a request, take the answer either way.
 *
 * A Streamable HTTP server may reply with `application/json` — one response, done
 * — or with `text/event-stream`, where the answer arrives as an SSE event among
 * possibly several. Both shapes have to be read, because which one you get is the
 * server's choice rather than the client's.
 */
function httpTransport({ url, headers = {} }) {
  let sessionId = null;
  let closed = null;

  async function send(payload, timeoutMs) {
    if (closed) throw new Error(closed);

    /**
     * `safeFetch`, not `fetch`, and the difference is the whole point.
     *
     * `connectMcp` calls `assertPublic` once and used to throw its answer away,
     * handing the *hostname* to `fetch` — which resolves it again, independently,
     * on every request. `assertPublic` returns the records it approved precisely
     * so a caller can pin the socket to them, and its own comment describes this
     * gap in as many words: a record with a one-second TTL answers with a public
     * address for the check and `169.254.169.254` for the connection a moment
     * later. Node's `fetch` gives no way to say which address to connect to;
     * `safeFetch` uses `http.request` with a `lookup` override for exactly that
     * reason, so it is the only way to close this here.
     *
     * The check now also runs per request rather than once per connection, which
     * is what a time-of-check gap needs — one check at connect time cannot say
     * anything about a socket opened ten minutes later.
     *
     * `redirect: 'manual'` is kept, and kept deliberately: the headers here may
     * carry a token, and this transport would rather refuse a hop than reason
     * about where it points. `safeFetch` honours the flag rather than following.
     */
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    // The session id arrives on the initialize response and has to travel with
    // every later request, or a stateful server treats each call as a stranger.
    const issued = res.headers.get('mcp-session-id');
    if (issued) sessionId = issued;

    if (res.status === 202) return null; // a notification was accepted
    if (!res.ok) {
      throw new Error(`${new URL(url).host} returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) return readSse(res, payload.id);
    const body = await res.json();
    return Array.isArray(body) ? body.find((m) => m.id === payload.id) : body;
  }

  /** Read the stream until the reply we are waiting for turns up. */
  async function readSse(res, wantedId) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('');
          if (data) {
            try {
              const message = JSON.parse(data);
              if (message.id === wantedId) return message;
            } catch {
              /* a frame that is not JSON is not our answer */
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new Error('The stream ended before the server answered.');
  }

  return {
    kind: 'http',
    get closed() {
      return closed;
    },
    async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = nextId++;
      const message = await send({ jsonrpc: '2.0', id, method, params }, timeoutMs);
      if (!message) throw new Error('The server accepted the request but sent no answer.');
      if (message.error) {
        const detail = message.error.data ? ` (${JSON.stringify(message.error.data).slice(0, 200)})` : '';
        throw new Error(`${message.error.message || 'Unknown error'}${detail}`);
      }
      return message.result;
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params }, 10_000).catch(() => {});
    },
    close() {
      closed = 'The connection was closed.';
    },
  };
}

/* ── the connection ─────────────────────────────────────────────────── */

/**
 * Connect, shake hands, and list what the server can do.
 *
 * The handshake is not optional and not merely ceremonial: a server answers
 * `tools/list` with an error until it has been initialised, and the
 * `notifications/initialized` that follows is what tells it the client is ready.
 * Skipping either is the most common reason an MCP client "cannot see any tools".
 */
export async function connectMcp(config) {
  let transport;
  if (config.transport === 'http') {
    // The URL is user- or model-supplied, so it goes through the same gate as
    // every other outbound fetch: a private address is refused before a socket
    // is opened, which is what stops a server being pointed at cloud metadata.
    await assertPublic(new URL(config.url));
    transport = httpTransport({ url: config.url, headers: config.headers });
  } else {
    // A stdio server runs where this deployment allows: as a child of this
    // process on a single-owner machine, or on the account's own cloud computer.
    const place = config.place || stdioPlace();
    if (place === 'cloud') {
      transport = cloudTransport(config, { userId: config.userId, conn: config.bridge || null });
    } else if (place === 'local') {
      transport = stdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd });
    } else {
      throw new Error(
        process.env.VERCEL
          ? 'stdio MCP servers run on each account\'s cloud computer, and this deployment has none: the Vercel Sandbox is switched off (SANDBOX_DISABLED). Use an http server, or switch the sandbox back on.'
          : 'stdio MCP servers need either the cloud computer (VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID) or ALLOW_MCP_STDIO=1 on a machine you trust. Or use an http server.',
      );
    }
  }

  try {
    const hello = await transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        // Honest about what is implemented. Claiming capabilities this client does
        // not have invites requests it cannot answer.
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      // On the cloud computer the first greeting can include `npx` fetching the
      // package, which takes a minute; a program already warm answers at once.
      transport.kind === 'cloud' ? CLOUD_HANDSHAKE_MS : HANDSHAKE_TIMEOUT_MS,
    );

    transport.notify('notifications/initialized', {});

    const tools = [];
    let cursor;
    // Paginated, and a server with more tools than one page is exactly the kind
    // worth connecting — stopping at the first page would hide most of it.
    do {
      const page = await transport.request('tools/list', cursor ? { cursor } : {});
      for (const tool of page?.tools || []) tools.push(tool);
      cursor = page?.nextCursor;
    } while (cursor && tools.length < 500);

    return {
      transport,
      server: hello?.serverInfo || {},
      protocolVersion: hello?.protocolVersion || null,
      instructions: hello?.instructions || null,
      tools,
      /** Run one tool. The result is flattened to text for the model. */
      async call(name, args, timeoutMs) {
        const result = await transport.request('tools/call', { name, arguments: args || {} }, timeoutMs);
        return { text: flatten(result), isError: !!result?.isError };
      },
      close: () => transport.close(),
    };
  } catch (err) {
    transport.close();
    throw err;
  }
}

/**
 * An MCP result, as something a model can read.
 *
 * Content is a list of typed parts. Text passes through; an image cannot be put
 * into a tool result here, so it is named rather than dropped — a silently missing
 * attachment is worse than a sentence saying one arrived.
 */
export function flatten(result) {
  const parts = result?.content;
  if (!Array.isArray(parts)) {
    // Some servers answer with `structuredContent` and no content list at all.
    if (result?.structuredContent) return JSON.stringify(result.structuredContent, null, 2).slice(0, 60_000);
    return typeof result === 'string' ? result : JSON.stringify(result ?? null);
  }

  const out = [];
  for (const part of parts) {
    if (part?.type === 'text') out.push(String(part.text ?? ''));
    else if (part?.type === 'image') out.push(`[the server returned a ${part.mimeType || 'image'}, which cannot be shown here]`);
    else if (part?.type === 'audio') out.push('[the server returned audio, which cannot be played here]');
    else if (part?.type === 'resource_link') out.push(`[resource: ${part.uri || 'unnamed'}]`);
    else if (part?.type === 'resource') {
      const embedded = part.resource || {};
      out.push(embedded.text ? String(embedded.text) : `[resource: ${embedded.uri || 'unnamed'}]`);
    } else out.push(JSON.stringify(part));
  }
  const text = out.join('\n').trim();
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n\n[truncated]` : text || '(the server returned nothing)';
}

export const __testing = { flatten, launchPlan, PROTOCOL_VERSION };
