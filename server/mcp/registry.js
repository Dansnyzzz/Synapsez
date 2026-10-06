import { getStore } from '../store/index.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { connectMcp } from './client.js';
import { stdioPlace, mcpSignature, checkOnScratch } from './cloud.js';
import { chargeCloudCheck } from '../sandbox.js';
import { log } from '../util/trace.js';

/**
 * The MCP servers an account has plugged in.
 *
 * Tool names are prefixed `mcp__<server>__<tool>` — the same shape Claude Code
 * uses, and prefixed for two reasons that both matter. It keeps a server called
 * `filesystem` from shadowing this app's own `read_file`, which would be a silent
 * and very confusing substitution. And it makes the origin of a tool visible in
 * the approval prompt, so somebody being asked to allow something can see it came
 * from outside.
 *
 * **Connections are cached per account and reused.** A stdio server is a child
 * process; starting one per tool call would mean a process launch and a handshake
 * before every call, and for `npx`-based servers that is seconds each time.
 *
 * **Nothing here is driven by the model.** The command to run is typed by the
 * user. A model that could add an MCP server could run any program on the machine
 * with no approval prompt in the way, which is not a tool call — it is a shell.
 */

/** userId → Map(serverId → { connection, tools, error, at }) */
const live = new Map();

/** How long a failed connection is remembered before trying again. */
const RETRY_AFTER_MS = 60_000;

const PREFIX = 'mcp__';
export const isMcpTool = (name) => String(name || '').startsWith(PREFIX);

/** `mcp__figma__get_file` → `{ server: 'figma', tool: 'get_file' }` */
export function splitMcpName(name) {
  const rest = String(name).slice(PREFIX.length);
  const cut = rest.indexOf('__');
  if (cut < 1) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/**
 * A server id safe to put in a tool name.
 *
 * Tool names are matched exactly by every provider and several of them reject
 * anything outside `[a-zA-Z0-9_-]`, so a server called "My Figma!" has to become
 * something a model can actually be offered.
 */
export const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'server';

/**
 * The longest tool name every provider accepts.
 *
 * Anthropic allows `^[a-zA-Z0-9_-]{1,128}$`; OpenAI-style function names stop
 * at 64. The request goes to whichever provider the account picked, so the
 * stricter rule is the one that holds.
 */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Which of a server's tools can be offered to a model, and why the rest cannot.
 *
 * The server chooses these names and schemas, not this app. One tool named
 * `search.files`, one name past the length limit, or an `inputSchema` that is
 * not an object schema makes the provider refuse the **whole** request — so a
 * single careless tool on one server used to break every turn on the account.
 * Such a tool is left out and named in the server's status instead. A repeated
 * name is left out too, for the same reason.
 *
 * @param {string} id  the server's slug
 * @param {Array<{ name?: unknown, inputSchema?: unknown }>} list
 */
export function offerable(id, list) {
  const usable = [];
  const skipped = [];
  const seen = new Set();
  for (const tool of Array.isArray(list) ? list : []) {
    const raw = typeof tool?.name === 'string' ? tool.name : '';
    const schema = tool?.inputSchema;
    let reason = null;
    if (!raw || !TOOL_NAME.test(`${PREFIX}${id}__${raw}`)) reason = 'name has characters or a length providers refuse';
    else if (seen.has(raw)) reason = 'name repeated';
    else if (
      schema != null &&
      (typeof schema !== 'object' || Array.isArray(schema) || ('type' in schema && schema.type !== 'object'))
    )
      reason = 'input schema is not an object schema';
    if (reason) skipped.push({ name: raw.slice(0, 80), reason });
    else {
      seen.add(raw);
      usable.push(tool);
    }
  }
  return { usable, skipped };
}

/**
 * A stored config, with its secrets brought back.
 *
 * Both catches used to swallow the failure and carry on with `{}`. That is the
 * worst available answer: rotate ENCRYPTION_KEY, or restore a database next to a
 * different .env, and the server would connect anyway — with no Authorization
 * header, or with a child process missing the API key it needs. What comes back
 * is then a 401 from somewhere else, or a server that starts and does nothing,
 * and the actual cause is two layers away with nothing pointing at it.
 *
 * A credential that cannot be read is a broken server, and the caller already
 * knows how to display one: `listMcpServers` catches per row and shows the
 * message beside the server's name, and the agent's system prompt names broken
 * servers so the model says "your Figma server is misconfigured" rather than
 * "I cannot do that".
 */
function stored(row) {
  const config = { ...(row.config || {}) };

  const decrypt = (cipher, what) => {
    let plain;
    try {
      plain = decryptSecret(cipher);
    } catch (err) {
      throw new Error(
        `Its stored ${what} could not be decrypted (${err?.message || 'unknown error'}). ` +
          'That usually means ENCRYPTION_KEY has changed since the server was added — remove it and add it again.',
      );
    }
    try {
      return JSON.parse(plain || '{}');
    } catch {
      throw new Error(`Its stored ${what} could not be read back — remove the server and add it again.`);
    }
  };

  // Headers may carry a bearer token, so they are encrypted at rest like every
  // other credential in this app and decrypted only here.
  if (config.headersCipher) {
    config.headers = decrypt(config.headersCipher, 'headers');
    delete config.headersCipher;
  }
  if (config.envCipher) {
    config.env = decrypt(config.envCipher, 'environment');
    delete config.envCipher;
  }
  return config;
}

/**
 * A stdio server that runs on the account's cloud computer here (cloud.js).
 * Its tools are offered from the list kept when it was added, and the machine
 * starts only when one of them is called.
 */
const runsInCloud = (row) =>
  row?.config?.transport !== 'http' && (row?.config?.place === 'cloud' || (!row?.config?.place && stdioPlace() === 'cloud'));

/**
 * How long a server checked for everybody is trusted before it is checked again
 * — `@latest` moves. Fourteen days; a test sets it to 0 to stand in an old list.
 */
let sharedForMs = 14 * 24 * 60 * 60 * 1000;

/**
 * What `mcp_shared.target` holds for a person reading the table: the program's
 * name only — never its arguments, which is where a key often goes
 * (`--api-key …`, `--header "Authorization: Bearer …"`).
 *
 * @param {{ command?: string }} config
 */
export const sharedTarget = (config) => String(config?.command || '').trim().split(/[\\/]/).pop() || 'program';

/** A server's tools as kept on its row and in `mcp_shared`: the parts a model is offered. */
export function keptTools(tools) {
  return (Array.isArray(tools) ? tools : []).slice(0, 500).map((tool) => ({
    name: tool?.name,
    ...(tool?.title ? { title: tool.title } : {}),
    description: tool?.description || '',
    inputSchema: tool?.inputSchema || { type: 'object', properties: {} },
  }));
}

/** One of a server's tools, as the model is offered it. */
function advertised(id, row, tool) {
  return {
    name: `${PREFIX}${id}${'__'}${tool.name}`,
    scope: 'mcp',
    // Everything from outside is treated as changing something. See
    // `assessRisk`: an unrecognised tool is already graded sensitive, and
    // that is the behaviour wanted here rather than an exception to it.
    readOnly: false,
    description: `[${row.name}] ${tool.description || tool.title || 'No description given by the server.'}`.slice(0, 1024),
    parameters: tool.inputSchema || { type: 'object', properties: {} },
  };
}

/** Encrypt the parts of a config that are secrets, for storage. */
export function sealConfig(config = {}) {
  const out = { ...config };
  if (out.headers && Object.keys(out.headers).length) {
    out.headersCipher = encryptSecret(JSON.stringify(out.headers));
  }
  delete out.headers;
  if (out.env && Object.keys(out.env).length) {
    out.envCipher = encryptSecret(JSON.stringify(out.env));
  }
  delete out.env;
  return out;
}

/**
 * Connect to every enabled server for this account, and list their tools.
 *
 * A server that will not start is **not** an error for the turn. It is recorded,
 * reported in the interface, and skipped — one broken server must not take the
 * assistant's own tools away with it. The failure is remembered for a minute so a
 * server that is down does not cost a handshake timeout on every single message.
 */
export async function mcpTools(userId) {
  const store = getStore();
  let rows;
  try {
    rows = await store.listMcpServers(userId);
  } catch (err) {
    /**
     * Carry on without MCP, but say so unless it is the expected case.
     *
     * The reasoning for swallowing this is sound — the table may not exist yet
     * on a database mid-migration, and no MCP is a workable state where a
     * crashed turn is not. The problem was that it swallowed *everything* the
     * same way. A connection pool exhausted, a timeout, a permissions error:
     * all of them silently removed every MCP tool from the turn, and the model
     * then told the user it could not do things it could do perfectly well.
     * Nothing anywhere named a cause.
     *
     * A missing table stays silent because it is expected and self-resolving.
     * Anything else is logged, so "my Figma tools vanished" has somewhere to be
     * looked up.
     */
    const missingTable = /relation .* does not exist|no such table|undefined_table/i.test(err?.message || '');
    if (!missingTable) log.warn('mcp: could not list servers; continuing without MCP tools', { err: err?.message });
    return { tools: [], servers: [] };
  }

  const enabled = rows.filter((row) => row.enabled !== false);
  if (!enabled.length) return { tools: [], servers: [] };

  // Re-inserted on every use so the Map's insertion order is the LRU order.
  if (live.has(userId)) {
    const existing = live.get(userId);
    live.delete(userId);
    live.set(userId, existing);
  } else {
    live.set(userId, new Map());
  }
  evictIfCrowded(userId);
  const mine = live.get(userId);

  const tools = [];
  const servers = [];

  /**
   * Two servers whose names reduce to the same slug cannot both be offered.
   *
   * The store keeps names unique only case-insensitively, so "My Figma" and
   * "my-figma" are two rows and one slug. The add route refuses that now, but
   * rows saved before it did still exist. Both used to connect at once: the
   * second `mine.set` replaced the first connection without closing it (a child
   * process or socket nobody could reach again), and both advertised identical
   * tool names, which providers reject as a malformed request — every turn on
   * the account failed. The first row keeps the slug; the later one is reported
   * broken with a message saying why.
   */
  const claimed = new Map();
  const unique = [];
  for (const row of enabled) {
    const id = slugify(row.name);
    if (claimed.has(id)) {
      servers.push({
        id,
        name: row.name,
        error: `Its tool names would collide with the server "${claimed.get(id)}". Rename one of them.`,
        tools: 0,
      });
      continue;
    }
    claimed.set(id, row.name);
    unique.push(row);
  }

  await Promise.all(
    unique.map(async (row) => {
      const id = slugify(row.name);
      const held = mine.get(id);

      // Drop a connection whose transport has died, so the next turn reconnects
      // rather than reporting tools that can no longer be called.
      if (held?.connection?.transport?.closed) mine.delete(id);
      const current = mine.get(id);

      if (current?.error && Date.now() - current.at < RETRY_AFTER_MS) {
        servers.push({ id, name: row.name, error: current.error, tools: 0 });
        return;
      }

      if (current?.connection) {
        tools.push(...current.tools);
        servers.push({ id, name: row.name, tools: current.tools.length, skipped: current.skipped, server: current.connection.server, ...(runsInCloud(row) ? { runsOn: 'cloud' } : {}) });
        return;
      }

      /*
       * On the cloud computer, nothing is started to answer "what can you do":
       * the list kept when the server was added is offered, and the machine
       * starts when a tool is actually called (`callMcpTool`). Starting it on
       * every message would spend the shared allowance on turns that never use
       * the server, and keep somebody waiting for a machine they did not need.
       */
      if (runsInCloud(row) && Array.isArray(row.config?.tools)) {
        const { usable, skipped } = offerable(id, row.config.tools);
        const offered = usable.map((tool) => advertised(id, row, tool));
        tools.push(...offered);
        servers.push({ id, name: row.name, tools: offered.length, skipped, runsOn: 'cloud' });
        return;
      }

      try {
        const connection = await connectMcp({ ...stored(row), userId });
        const { usable, skipped } = offerable(id, connection.tools);
        const offered = usable.map((tool) => advertised(id, row, tool));
        if (skipped.length) log.warn('mcp: tools not offered', { server: id, skipped });

        mine.set(id, { connection, tools: offered, skipped, error: null, at: Date.now() });
        tools.push(...offered);
        servers.push({ id, name: row.name, tools: offered.length, skipped, server: connection.server });
      } catch (err) {
        mine.set(id, { connection: null, tools: [], error: err.message, at: Date.now() });
        servers.push({ id, name: row.name, error: err.message, tools: 0 });
      }
    }),
  );

  return { tools, servers };
}

/** Run one MCP tool by its prefixed name. */
export async function callMcpTool(userId, name, input, timeoutMs) {
  const split = splitMcpName(name);
  if (!split) throw new Error(`"${name}" is not a valid MCP tool name.`);

  // Connect if this is the first call of the process — the agent loop lists tools
  // before calling them, so normally the connection is already here. A server on
  // the cloud computer is the exception: its tools were offered from the kept
  // list, and this call is what starts it.
  if (!live.get(userId)?.get(split.server)?.connection) {
    const row = (await getStore().listMcpServers(userId)).find((r) => r.enabled !== false && slugify(r.name) === split.server);
    if (row && runsInCloud(row)) await connectInCloud(userId, row);
    else await mcpTools(userId);
  }

  const held = live.get(userId)?.get(split.server);
  if (!held?.connection) {
    throw new Error(
      held?.error
        ? `The "${split.server}" MCP server is not reachable: ${held.error}`
        : `There is no MCP server called "${split.server}" on this account.`,
    );
  }

  return held.connection.call(split.tool, input, timeoutMs);
}

/**
 * Start one cloud server for its first call, and keep its list current.
 *
 * What it lists now replaces what was kept on its row, so a server updated
 * upstream (`@latest`) is offered with its new tools from the next turn.
 *
 * @param {string} userId
 * @param {any} row
 */
async function connectInCloud(userId, row) {
  const id = slugify(row.name);
  if (!live.has(userId)) live.set(userId, new Map());
  evictIfCrowded(userId);
  const mine = live.get(userId);
  try {
    const connection = await connectMcp({ ...stored(row), userId, place: 'cloud' });
    const { usable, skipped } = offerable(id, connection.tools);
    mine.set(id, { connection, tools: usable.map((tool) => advertised(id, row, tool)), skipped, error: null, at: Date.now() });
    const now = keptTools(connection.tools);
    if (JSON.stringify(now) !== JSON.stringify(row.config?.tools || [])) {
      // Only the list: the row may have been removed, switched off or edited
      // while this connected (see setMcpServerTools).
      await getStore()
        .setMcpServerTools(userId, row.id, now, { from: row.config })
        .catch((err) => log.warn('mcp: could not keep the new tool list', { server: id, err: err?.message }));
    }
  } catch (err) {
    mine.set(id, { connection: null, tools: [], error: err.message, at: Date.now() });
  }
}

/**
 * Try a configuration without saving it.
 *
 * What the interface needs before storing anything: does it start, and what does
 * it offer. Saving a server that cannot start would put a permanent error in
 * somebody's settings for them to work out later.
 *
 * `keep` is the full list to store on the row, for a server that will be
 * offered from it (one on the cloud computer); `shared` says it was already
 * known and nothing had to start.
 *
 * @param {any} config
 * @param {{ userId?: string }} [options]
 */
export async function probeMcpServer(config, { userId } = {}) {
  if (config.transport !== 'http' && stdioPlace() === 'cloud') return probeInCloud(config, userId);
  const connection = await connectMcp(config);
  try {
    return {
      server: connection.server,
      protocolVersion: connection.protocolVersion,
      tools: connection.tools.map((tool) => ({ name: tool.name, description: tool.description || '' })),
    };
  } finally {
    connection.close();
  }
}

/**
 * A stdio server on the cloud computer, checked once for everybody.
 *
 * Already in `mcp_shared`: nothing starts, the list is taken from there, and the
 * account has the server at once. Not yet: it is started on a scratch machine
 * with no environment (cloud.js says why not the account's own), and what it
 * lists is kept for the next account. A server that will not start without its
 * token — a GitHub server with no `GITHUB_PERSONAL_ACCESS_TOKEN` — is checked
 * on the account's own machine, with the token, and that list is not shared.
 *
 * @param {any} config
 * @param {string} [userId]
 */
async function probeInCloud(config, userId) {
  const store = getStore();
  const signature = mcpSignature(config);
  const known = await store.getSharedMcp(signature).catch(() => null);
  const listed = known && Array.isArray(known.tools) && known.tools.length;
  const recent = listed && Date.now() - new Date(known.checked_at).getTime() < sharedForMs;
  if (recent) {
    await store.noteSharedMcpUse(signature).catch(() => {});
    return describeProbe(known.server, known.tools, { shared: true });
  }
  // A machine of its own that installs a package: far more than one action.
  if (userId) {
    try {
      await chargeCloudCheck(userId);
    } catch (err) {
      // Today's checks are spent: a list checked before is still the best there is.
      if (listed) return describeProbe(known.server, known.tools, { shared: true });
      throw err;
    }
  }
  try {
    const found = await checkOnScratch(config, connectMcp);
    await store
      .saveSharedMcp({ signature, transport: 'stdio', target: sharedTarget(config), server: found.server, tools: keptTools(found.tools) })
      .catch((err) => log.warn('mcp: could not share a checked server', { err: err?.message }));
    return describeProbe(found.server, found.tools, { shared: false });
  } catch (err) {
    // Checked before and failing now: the older list is still the best there is.
    if (listed) return describeProbe(known.server, known.tools, { shared: true });
    if (!userId || !config.env || !Object.keys(config.env).length) throw err;
    const connection = await connectMcp({ ...config, userId, place: 'cloud' });
    try {
      return describeProbe(connection.server, connection.tools, { shared: false });
    } finally {
      connection.close();
    }
  }
}

function describeProbe(server, tools, { shared }) {
  return {
    server: server || {},
    protocolVersion: null,
    tools: (tools || []).map((tool) => ({ name: tool.name, description: tool.description || '' })),
    keep: keptTools(tools),
    shared,
  };
}

/**
 * Which servers are reachable right now, for the settings page.
 *
 * The same work as `mcpTools` and deliberately the same call, so the page shows
 * the state the next turn will actually get rather than a second opinion. Asked
 * for on each visit rather than stored, because "it worked when I added it" is
 * exactly the fact that goes stale.
 */
export async function mcpStatus(userId) {
  const { servers } = await mcpTools(userId);
  return { servers };
}

/**
 * How many accounts may hold live MCP connections at once.
 *
 * `live` is a process-global Map keyed by user, and nothing ever removed an
 * entry except an explicit `forgetMcp`. On a long-lived local server that grows
 * with every account that has ever used an MCP server and never shrinks —
 * holding child processes and sockets for people who signed out days ago. An
 * error entry is worse: it is remembered, retried after a minute, and then kept
 * for ever whether or not anyone asks again.
 *
 * Least-recently-used, evicted properly rather than dropped: the entry's
 * connections are closed on the way out, or eviction would leak the very
 * processes it is meant to reclaim.
 */
const MAX_LIVE_ACCOUNTS = 24;

function evictIfCrowded(keep) {
  while (live.size > MAX_LIVE_ACCOUNTS) {
    const oldest = live.keys().next().value;
    if (oldest === undefined || oldest === keep) return;
    forgetMcp(oldest);
  }
}

/** Drop cached connections for an account, so the next turn reconnects. */
export function forgetMcp(userId) {
  const mine = live.get(userId);
  if (!mine) return;
  for (const [, held] of mine) held.connection?.close?.();
  live.delete(userId);
}

/** Close everything. Called when the process is going down. */
export function closeAllMcp() {
  for (const [userId] of live) forgetMcp(userId);
}

export const __testing = {
  live,
  slugify,
  splitMcpName,
  offerable,
  /** @param {number} ms */
  setSharedFor(ms) {
    sharedForMs = ms;
  },
};
