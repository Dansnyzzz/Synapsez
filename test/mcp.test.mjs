/**
 * The MCP client, against a server that really speaks the protocol.
 *
 *   node test/mcp.test.mjs
 *
 * MCP is what makes this app's tool list open rather than fixed, so the client
 * has to be right about the awkward parts rather than the happy path. Every check
 * here covers something that silently produces "no tools available":
 *
 *   - `tools/list` before `initialize` is refused by real servers
 *   - the tool list is paginated, and page two is where half of it lives
 *   - servers print banners to stdout, which is not a protocol error
 *   - a failed tool is a result with `isError`, not a JSON-RPC error
 *   - a server that cannot start has to say *why*, or the interface shows nothing
 *
 * And the one that is not about the protocol at all: a tool from outside this
 * repository must always stop for approval.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { removeTemp } from './lib/tmp.mjs';

// The cloud sections at the end keep a bridge connection and a shared row in a
// real store, in a throwaway directory.
process.env.ENCRYPTION_KEY ||= 'mcp-test-encryption-key';
process.env.SESSION_SECRET ||= 'mcp-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-mcp-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// stdio spawns a process the user named, so it is off unless switched on. The
// suite drives a trusted stub over stdio, which is exactly the case the switch
// exists for: a self-hosted owner who has opted in.
process.env.ALLOW_MCP_STDIO = '1';

const { connectMcp, __testing } = await import('../server/mcp/client.js');
const { flatten } = __testing;
const { slugify, splitMcpName, offerable } = (await import('../server/mcp/registry.js')).__testing;
const { assessRisk, riskReason, availableTools } = await import('../server/tools/definitions.js');

const STUB = path.join(import.meta.dirname, 'fixtures', 'mcp-stub-server.mjs');
const stub = (mode) => ({
  transport: 'stdio',
  command: process.execPath,
  args: [STUB],
  env: mode ? { MCP_STUB_MODE: mode } : {},
});

section('the handshake, and what it unlocks');
{
  const mcp = await connectMcp(stub());
  check('it connects', !!mcp);
  check('and reports who answered', mcp.server?.name === 'stub', JSON.stringify(mcp.server));
  check('with a protocol version', !!mcp.protocolVersion, mcp.protocolVersion);

  // Page two is where three of the five live. A client that stops at the first
  // page reports a server as smaller than it is, and nothing looks broken.
  check('every page of the tool list is read', mcp.tools.length === 5, `${mcp.tools.length} tools`);
  check(
    'including the ones past the first page',
    mcp.tools.some((t) => t.name === 'explode'),
    mcp.tools.map((t) => t.name).join(', '),
  );
  mcp.close();
}

section('calling a tool');
{
  const mcp = await connectMcp(stub());

  const echo = await mcp.call('echo', { message: 'xin chào' });
  check('arguments arrive', echo.text === 'echo: xin chào', echo.text);
  check('and it is not marked as an error', echo.isError === false);

  const sum = await mcp.call('add', { a: 2, b: 40 });
  check('numbers survive the trip', sum.text === '42', sum.text);

  /**
   * A tool that failed is a *result*, not a transport error.
   *
   * Conflating the two is the classic mistake: the message the server took the
   * trouble to write gets replaced by a generic failure, and the model retries
   * the same call because it never learned what went wrong.
   */
  const boom = await mcp.call('explode', {});
  check('a failing tool is flagged', boom.isError === true);
  check('and its message survives', /exploded/.test(boom.text), boom.text);

  // Some servers answer with structuredContent and no content list at all.
  const structured = await mcp.call('structured', {});
  check('structuredContent is not dropped', /rows/.test(structured.text), structured.text.slice(0, 60));

  // An image cannot go into a tool result here. Naming it beats dropping it —
  // a silently missing attachment is worse than a sentence saying one arrived.
  const picture = await mcp.call('picture', {});
  check('an image is named rather than lost', /image\/png/.test(picture.text), picture.text);

  let refused = '';
  try {
    await mcp.call('nope', {});
  } catch (err) {
    refused = err.message;
  }
  check('an unknown tool fails loudly', /Unknown tool/.test(refused), refused);
  mcp.close();
}

section('servers that misbehave');
{
  // A banner on stdout is not a protocol error, and treating it as one would rule
  // out a good number of real servers.
  const noisy = await connectMcp(stub('noisy'));
  check('a startup banner on stdout is ignored', noisy.tools.length === 5, `${noisy.tools.length} tools`);
  noisy.close();

  let greetError = '';
  try {
    await connectMcp(stub('nogreet'));
  } catch (err) {
    greetError = err.message;
  }
  check('a refused handshake surfaces the reason', /refuses to initialise/.test(greetError), greetError);

  // The reason a server did not start is the only thing anybody can act on, so a
  // process that dies has to carry its stderr out with it.
  let deadError = '';
  try {
    await connectMcp({ transport: 'stdio', command: process.execPath, args: ['-e', 'process.stderr.write("boom: missing config\\n");process.exit(2)'] });
  } catch (err) {
    deadError = err.message;
  }
  check('a process that exits reports its exit code', /code 2/.test(deadError), deadError.slice(0, 90));
  check('and what it said on stderr', /missing config/.test(deadError));

  let missingError = '';
  try {
    await connectMcp({ transport: 'stdio', command: 'definitely-not-a-real-program-xyz', args: [] });
  } catch (err) {
    missingError = err.message;
  }
  check('a command that does not exist fails clearly', missingError.length > 0, missingError.slice(0, 90));
}

section('names');
{
  // Providers reject tool names outside [A-Za-z0-9_-], so a server called
  // "My Figma!" has to become something a model can actually be offered.
  check('a name is made safe for a tool id', slugify('My Figma!') === 'my_figma', slugify('My Figma!'));
  check('and never comes back empty', slugify('!!!') === 'server', slugify('!!!'));

  /*
   * A server names its own tools. One bad name or schema used to go straight
   * into the provider request, and a provider refuses the whole request for it —
   * so one careless tool broke every turn on the account.
   */
  const { usable, skipped } = offerable('figma', [
    { name: 'get_file', inputSchema: { type: 'object', properties: {} } },
    { name: 'search.files', inputSchema: { type: 'object' } },
    { name: 'x'.repeat(60), inputSchema: { type: 'object' } },
    { name: 'get_file', inputSchema: { type: 'object' } },
    { name: 'list', inputSchema: { type: 'array' } },
    { name: 'bare' },
    { name: '' },
    null,
  ]);
  check(
    'only tools a provider accepts are offered',
    usable.map((t) => t.name).join(',') === 'get_file,bare',
    usable.map((t) => t.name).join(','),
  );
  check('and every other one is named with a reason', skipped.length === 6 && skipped.every((s) => s.reason), JSON.stringify(skipped));
  check('  a dotted name is refused', skipped.some((s) => s.name === 'search.files'));
  check('  an over-long name is refused', skipped.some((s) => s.name === 'x'.repeat(60)));
  check('  a repeated name is refused', skipped.some((s) => s.reason === 'name repeated'));
  check('  a non-object schema is refused', skipped.some((s) => s.name === 'list' && /schema/.test(s.reason)));
  check('a prefixed name splits back apart', JSON.stringify(splitMcpName('mcp__figma__get_file')) === '{"server":"figma","tool":"get_file"}');
  // Tool names containing __ must not be truncated at the first one.
  check(
    'a tool whose own name has __ in it survives',
    splitMcpName('mcp__db__run__query')?.tool === 'run__query',
    JSON.stringify(splitMcpName('mcp__db__run__query')),
  );
  check('nonsense is refused', splitMcpName('mcp__nope') === null);
}

section('a tool from outside this app always asks');
{
  check('it is graded sensitive', assessRisk('mcp__figma__delete_everything', {}) === 'sensitive');
  const reason = riskReason('mcp__figma__delete_everything', {});
  check('and the prompt says where it came from', /figma/.test(reason) && /outside/.test(reason), reason);

  // Under the read-only policies it must not be offered at all: it is not
  // readOnly, and nothing here can prove otherwise.
  const extra = [{ name: 'mcp__x__do', scope: 'mcp', readOnly: false, description: 'd', parameters: { type: 'object', properties: {} } }];
  const offered = (policy) => availableTools({ workerOnline: true, desktopOnline: false, policy, extra }).map((t) => t.name);
  check('offered under guarded', offered('guarded').includes('mcp__x__do'));
  check('withheld under read-only', !offered('readonly').includes('mcp__x__do'));
  check('and withheld in plan mode', !offered('plan').includes('mcp__x__do'));
}

section('stdio runs a real command, so it is off unless switched on');
{
  // The one that ends the project if it is wrong: a stdio server spawns a
  // process, which inherits the server's environment — every stored account's
  // keys are decryptable by whatever that process wants to read. So the reach
  // is denied by default, and a self-hosting owner opts in knowingly.
  const saved = process.env.ALLOW_MCP_STDIO;
  delete process.env.ALLOW_MCP_STDIO;
  let refused = '';
  try {
    await connectMcp(stub());
  } catch (err) {
    refused = err.message;
  }
  check('a stdio server is refused when nobody opted in', /ALLOW_MCP_STDIO/.test(refused), refused);
  process.env.ALLOW_MCP_STDIO = saved;

  // Shared infrastructure never runs an arbitrary command beside the server,
  // opt-in or not: on a multi-tenant deployment one account's command would
  // read every account's secrets. There it goes to the account's own cloud
  // computer instead — which, with no account named here, is refused too.
  const savedVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  let onServerless = '';
  try {
    await connectMcp(stub());
  } catch (err) {
    onServerless = err.message;
  }
  check('and never started beside the server on serverless, even with the switch on', /cloud computer/.test(onServerless), onServerless);
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
}

section('an http server may not be pointed at a private address');
{
  // The model, or a user, supplies this URL. Without a check the server fetches
  // whatever it names — including cloud metadata at 169.254.169.254, which on a
  // hosted deployment hands out credentials.
  let metadata = '';
  try {
    await connectMcp({ transport: 'http', url: 'http://169.254.169.254/latest/meta-data/' });
  } catch (err) {
    metadata = err.message;
  }
  check('cloud metadata is refused', /private address|public internet/i.test(metadata), metadata);

  let loopback = '';
  try {
    await connectMcp({ transport: 'http', url: 'http://127.0.0.1:1/' });
  } catch (err) {
    loopback = err.message;
  }
  check('and so is loopback', /private|public internet/i.test(loopback), loopback);
}

section('the http transport, against a server that answers');
{
  /**
   * This path had no coverage at all, which is why it is here.
   *
   * Every http check before this one asserts a *refusal* — a private address is
   * turned away — and none of them ever received a response. So `readSse`, the
   * JSON branch, and the session-id handshake were three pieces of live
   * integration code that no test had ever executed. That mattered the moment
   * the transport had to move off the global `fetch`: `fetch` cannot be pinned
   * to an address that was checked, which is the whole DNS-rebinding gap, and
   * rewriting a stream loop with nothing behind it is not a fix, it is a
   * different risk.
   *
   * The stub is loopback, so `ALLOW_PRIVATE_FETCH` has to be on for the duration
   * — which does mean the *pinning* is not what is exercised here; the protocol
   * plumbing over the real socket is. The refusals above are what cover the
   * address check, and they still pass with the switch off.
   */
  const http = await import('node:http');
  const saved = process.env.ALLOW_PRIVATE_FETCH;
  process.env.ALLOW_PRIVATE_FETCH = '1';

  let sawSession = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const msg = JSON.parse(raw || '{}');
      sawSession = req.headers['mcp-session-id'] ?? sawSession;

      if (msg.method === 'initialize') {
        // A stateful server issues an id here and expects it back on every
        // later call. Answered as plain JSON, the other of the two shapes.
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-42' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub-http', version: '1' } } }));
        return;
      }
      if (msg.method === 'tools/list') {
        // The SSE shape: the reply arrives as an event among possibly several,
        // and the reader has to find the one matching this id.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":"other","result":{}}\n\n');
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'Answer pong.', inputSchema: { type: 'object', properties: {} } }] } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(202).end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const live = await connectMcp({ transport: 'http', url: `http://127.0.0.1:${port}/mcp` });
    check('an http server connects and lists its tools', live.tools?.length === 1, JSON.stringify(live.tools?.map((t) => t.name)));
    check('  the tool survives the SSE frame it arrived in', live.tools?.[0]?.name === 'ping');
    check('  a frame for a different id is not mistaken for the answer', live.tools?.[0]?.description === 'Answer pong.');
    check('  and the session id is carried back on the next call', sawSession === 'sess-42', String(sawSession));
  } catch (err) {
    check('an http server connects and lists its tools', false, err.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (saved === undefined) delete process.env.ALLOW_PRIVATE_FETCH;
    else process.env.ALLOW_PRIVATE_FETCH = saved;
  }
}

section('flattening a result');
{
  check('plain text passes through', flatten({ content: [{ type: 'text', text: 'hello' }] }) === 'hello');
  check('several parts are joined', flatten({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb');
  check('an embedded resource shows its text', /inside/.test(flatten({ content: [{ type: 'resource', resource: { text: 'inside' } }] })));
  check('a link is named', /uri:x/.test(flatten({ content: [{ type: 'resource_link', uri: 'uri:x' }] })));
  // Nothing at all still has to read as nothing, not as a crash.
  check('an empty result says so', flatten({ content: [] }) === '(the server returned nothing)');
  check('and a missing content list does not throw', typeof flatten(undefined) === 'string');
}

section('a server plugged in reaches the assistant');
{
  /**
   * The whole point, end to end.
   *
   * Everything above proves the client speaks the protocol. This proves the part
   * that actually matters: a row in the database becomes a tool the model is
   * offered, under a name it can call, executed through the normal path — and
   * scoped to the account that added it.
   */
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const dir = path.join(os.tmpdir(), `ai-remote-mcp-test-${process.pid}`);
  fsp.rmSync(dir, { recursive: true, force: true });

  process.env.ENCRYPTION_KEY ||= 'mcp-test-encryption-key';
  process.env.DATA_DIR = dir;

  const { initStore, getStore } = await import('../server/store/index.js');
  await initStore();
  const store = getStore();

  const mine = await store.createUser({ id: 'user-a', email: 'a@example.com', passwordHash: 'x', role: 'admin' });
  const theirs = await store.createUser({ id: 'user-b', email: 'b@example.com', passwordHash: 'x', role: 'user' });

  const { sealConfig, mcpTools, forgetMcp } = await import('../server/mcp/registry.js');
  await store.saveMcpServer(mine.id, {
    id: 'srv-1',
    name: 'Stub Server',
    config: sealConfig({ transport: 'stdio', command: process.execPath, args: [STUB] }),
    enabled: true,
  });

  const offered = await mcpTools(mine.id);
  check('the server is reached', offered.servers[0] && !offered.servers[0].error, JSON.stringify(offered.servers[0]));
  check('its tools are advertised', offered.tools.length === 5, `${offered.tools.length} tools`);
  // Prefixed, so a server called `filesystem` cannot shadow this app's own
  // `read_file` — a silent substitution would be very hard to notice.
  check(
    'under a prefixed name',
    offered.tools.some((t) => t.name === 'mcp__stub_server__echo'),
    offered.tools.map((t) => t.name).join(', '),
  );
  check('and the name says which server', offered.tools.every((t) => t.description.startsWith('[Stub Server]')));

  /*
   * Two rows, one slug. The store is unique on lower(name) only, so "Stub
   * Server" and "stub-server" can both exist — a row from before the route's
   * check. Both used to connect, the second replaced the first connection
   * without closing it, and every tool name went out twice, which a provider
   * refuses outright.
   */
  await store.saveMcpServer(mine.id, {
    id: 'srv-twin',
    name: 'stub-server',
    config: sealConfig({ transport: 'stdio', command: process.execPath, args: [STUB] }),
    enabled: true,
  });
  forgetMcp(mine.id);
  const twins = await mcpTools(mine.id);
  const twinNames = twins.tools.map((t) => t.name);
  check('two servers with one slug never offer a tool name twice', new Set(twinNames).size === twinNames.length, `${twinNames.length} names`);
  check('  the first keeps its tools', twinNames.length === 5, `${twinNames.length}`);
  const twin = twins.servers.find((s) => s.name === 'stub-server');
  check('  the later one is reported, and says why', /collide/.test(twin?.error || ''), JSON.stringify(twin));
  await store.deleteMcpServer(mine.id, 'srv-twin');
  forgetMcp(mine.id);

  // Through the executor the agent loop actually uses, not a direct call.
  const { executeTool } = await import('../server/tools/execute.js');
  const ran = await executeTool({
    user: mine,
    name: 'mcp__stub_server__echo',
    input: { message: 'through the executor' },
    chatId: null,
  });
  check('it runs through the normal tool path', ran.content.includes('echo: through the executor'), ran.content);
  check('and is not reported as an error', !ran.isError);

  /*
   * What a server hands back is wrapped before the model reads it.
   *
   * The tool is already graded `sensitive`, so a person sees the *call* — but
   * they do not see the reply, and the reply is the half that can carry an
   * instruction. This is code from outside the repository writing straight into
   * the model's context, which is the definition of untrusted content.
   */
  check('and what the server said is marked as untrusted content', /^<untrusted source="the stub_server server">/.test(ran.content), ran.content.split('\n')[0]);
  check('  closed properly', ran.content.trim().endsWith('</untrusted>'));

  const failed = await executeTool({ user: mine, name: 'mcp__stub_server__explode', input: {}, chatId: null });
  check('a failing MCP tool comes back as an error', failed.isError === true, failed.content);

  /**
   * The tenancy boundary, which for MCP is not merely about privacy.
   *
   * A stdio server is a program that runs on the machine. One account being able
   * to see another's row would be one account choosing what another account
   * executes, so this is checked rather than assumed.
   */
  const others = await mcpTools(theirs.id);
  check('another account sees none of it', others.tools.length === 0 && others.servers.length === 0);
  const denied = await executeTool({ user: theirs, name: 'mcp__stub_server__echo', input: { message: 'hi' }, chatId: null });
  check('and cannot call it either', denied.isError === true, denied.content.slice(0, 80));

  // Disabling has to take the tools away, or the switch is decoration.
  await store.setMcpServerEnabled(mine.id, 'srv-1', false);
  forgetMcp(mine.id);
  const off = await mcpTools(mine.id);
  check('disabling a server withdraws its tools', off.tools.length === 0, `${off.tools.length} tools`);

  forgetMcp(mine.id);
  forgetMcp(theirs.id);
  // The store stays open for the cloud sections below; it is closed, and its
  // directory removed, at the very end of the suite.
}

/* ── the browser derives the same slug the server does ─────────── */
{
  // app.js has its own copy of `slugify`, because it has to work out which
  // status belongs to which server before the tools have names. The comment
  // there says "the same slug the server derives tool names from" — and nothing
  // held the two together. If either drifts, every MCP server in Settings
  // silently shows no status: no error, no empty state, just a row that never
  // says how many tools it has.
  //
  // Compared by behaviour rather than by text, so reformatting either side is
  // allowed and changing what either computes is not.
  const { slugify } = await import('../server/mcp/registry.js');
  const client = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  // `\r?\n`, because this file is checked out with CRLF on Windows and the first
  // version of this pattern matched only LF. That made the guard fail for a
  // reason having nothing to do with what it guards — the worst kind of false
  // alarm, since the honest reading of it is "somebody deleted the function".
  const body = /const slugForMcp = ([\s\S]*?);\r?\n/.exec(client)?.[1];
  // Detail only when it is missing: this harness prints the detail either way,
  // and "slugForMcp not found" beside a tick is the kind of line people learn
  // to skim past.
  check('the browser still has its own slug', !!body, body ? '' : 'slugForMcp not found in app.js');

  if (body) {
    // Reading one arrow function out of a sibling file is the point of the
    // check: app.js is a browser module with no export for this, so there is no
    // import path to it and comparing the text would forbid reformatting.
    const theirs = eval(body);
    const names = [
      'Figma', 'My Figma!', 'postgres', 'PostgreSQL 16', '  spaced  out  ',
      '!!!', '', 'a'.repeat(60), 'Ăn-Uống', 'server_1', '__leading', 'trailing__',
    ];
    const differ = names.filter((n) => theirs(n) !== slugify(n));
    check(
      'and it agrees with the server on every shape',
      differ.length === 0,
      differ.map((n) => `${JSON.stringify(n)}: ${theirs(n)} vs ${slugify(n)}`).join('; '),
    );
  }
}

/* ── stdio servers on the cloud computer ────────────────────────────
 *
 * The bridge that runs on an account's Vercel Sandbox (server/mcp/bridge.mjs)
 * is plain Node, so it is started here as a local process and driven exactly as
 * the server drives it over https. Nothing below reaches a sandbox or the
 * network.
 */
const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
const bridgePort = await freePort();
const bridgeKey = 'bridge-test-key-'.padEnd(32, 'k');
const bridge = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server', 'mcp', 'bridge.mjs')], {
  env: { ...process.env, SYNZ_MCP_KEY: bridgeKey, PORT: String(bridgePort) },
  stdio: ['ignore', 'ignore', 'ignore'],
});
// Whatever happens below, the bridge does not outlive the suite.
process.on('exit', () => bridge.kill());
const conn = { url: `http://127.0.0.1:${bridgePort}`, key: bridgeKey };
const cloud = await import('../server/mcp/cloud.js');
for (let i = 0; i < 60 && (await cloud.bridgeCall(conn, '/health', undefined, 1000)).status !== 200; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
let stubTools = [];

section('a stdio server on the cloud computer, behind the bridge');
{
  check('the bridge answers its key', (await cloud.bridgeCall(conn, '/health', undefined, 2000)).status === 200);
  check('  and nobody else', (await cloud.bridgeCall({ ...conn, key: 'not-the-key'.padEnd(32, 'x') }, '/health', undefined, 2000)).status === 401);

  const viaBridge = (mode) => ({ transport: 'stdio', command: process.execPath, args: [STUB], env: mode ? { MCP_STUB_MODE: mode } : {}, place: 'cloud', bridge: conn });
  const first = await connectMcp(viaBridge('strictinit'));
  stubTools = first.tools;
  check('a stdio server is reached through it', first.tools.length === 5, `${first.tools.length} tools`);
  const echoed = await first.call('echo', { message: 'qua cầu' });
  check('  and its tools run', echoed.text === 'echo: qua cầu', echoed.text);
  first.close();

  // Every serverless turn connects afresh and says `initialize` again; the
  // program, still running, refuses a second one (as real servers do).
  const again = await connectMcp(viaBridge('strictinit'));
  check('a later connection is greeted from the first handshake', again.tools.length === 5 && again.server?.name === 'stub', JSON.stringify(again.server));
  const health = await cloud.bridgeCall(conn, '/health', undefined, 2000);
  check('  on the same program, kept warm between turns', health.body?.programs === 1, JSON.stringify(health.body));
  // Two server instances talking to one program at once both count ids from one.
  const other = await connectMcp(viaBridge('strictinit'));
  const [a, b] = await Promise.all([again.call('echo', { message: 'một' }), other.call('echo', { message: 'hai' })]);
  check('two callers at once each get their own answer', a.text === 'echo: một' && b.text === 'echo: hai', `${a.text} / ${b.text}`);
  again.close();
  other.close();

  let died = '';
  try {
    await connectMcp({ transport: 'stdio', command: process.execPath, args: ['-e', 'process.stderr.write("boom: no config here\\n");process.exit(3)'], place: 'cloud', bridge: conn });
  } catch (err) {
    died = err.message;
  }
  check('a program that will not start says why, from the cloud computer', /boom: no config here/.test(died) && /code 3/.test(died), died);
  check('  and the bridge carries on for the others', (await cloud.bridgeCall(conn, '/health', undefined, 2000)).status === 200);

  check('on Vercel a stdio server runs on the cloud computer', cloud.stdioPlace({ VERCEL: '1' }) === 'cloud');
  check('  even with ALLOW_MCP_STDIO set — never beside the server there', cloud.stdioPlace({ VERCEL: '1', ALLOW_MCP_STDIO: '1' }) === 'cloud');
  check('on a trusted single-owner machine, beside the server', cloud.stdioPlace({ ALLOW_MCP_STDIO: '1' }) === 'local');
  check('elsewhere on the cloud computer when one is configured', cloud.stdioPlace({ VERCEL_TOKEN: 't', VERCEL_TEAM_ID: 'x', VERCEL_PROJECT_ID: 'p' }) === 'cloud');
  check('and nowhere when neither is', cloud.stdioPlace({}) === null && cloud.stdioPlace({ VERCEL: '1', SANDBOX_DISABLED: '1' }) === null);
  const gitnexus = { command: 'npx', args: ['-y', 'gitnexus@latest', 'mcp'] };
  check('a command is the same server for every account, whatever its token', cloud.mcpSignature({ ...gitnexus, env: { TOKEN: 'secret' } }) === cloud.mcpSignature(gitnexus));
  check('  and another argument is another server', cloud.mcpSignature(gitnexus) !== cloud.mcpSignature({ command: 'npx', args: ['-y', 'repomix@latest', '--mcp'] }));
  const { sharedTarget } = await import('../server/mcp/registry.js');
  check('what is kept for everybody names the program, never its arguments', sharedTarget({ command: 'npx', args: ['-y', '@upstash/context7-mcp', '--api-key', 'ctx7-SECRET'] }) === 'npx');

  // A program the bridge starts for a request that is not the greeting — the
  // bridge restarted, or stopped it after a quiet spell, while the server still
  // holds its greeted connection — is greeted by the bridge first.
  const cold = await cloud.bridgeCall(conn, '/rpc', {
    id: 'cold-start',
    spec: { command: process.execPath, args: [STUB], env: { MCP_STUB_MODE: 'strictinit' } },
    message: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { message: 'không chào trước' } } },
    timeoutMs: 20_000,
  }, 30_000);
  check('a program started for a tool call is greeted by the bridge first', cold.status === 200 && /không chào trước/.test(JSON.stringify(cold.body?.message?.result)), JSON.stringify(cold.body).slice(0, 200));
  check('  and the caller gets its own id back', cold.body?.message?.id === 7, String(cold.body?.message?.id));

  // The machine is the account's own, with root: what answers on its port can
  // be the account's listener, not the bridge. A redirect from it is not followed.
  const hits = { target: 0 };
  const target = http.createServer((req, res) => {
    hits.target += 1;
    res.end('{}');
  });
  const big = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`{"x":"${'a'.repeat(9 * 1024 * 1024)}"}`);
  });
  const targetPort = await freePort();
  const bigPort = await freePort();
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r));
  await new Promise((r) => big.listen(bigPort, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/internal` });
    res.end();
  });
  const redirectPort = await freePort();
  await new Promise((r) => redirector.listen(redirectPort, '127.0.0.1', r));
  try {
    const bounced = await cloud.bridgeCall({ url: `http://127.0.0.1:${redirectPort}`, key: bridgeKey }, '/rpc', { id: 'x', message: {} }, 5000);
    check('a redirect from the machine is not followed', bounced.redirected === true && hits.target === 0, JSON.stringify({ ...bounced, hits: hits.target }));
    const huge = await cloud.bridgeCall({ url: `http://127.0.0.1:${bigPort}`, key: bridgeKey }, '/health', undefined, 10_000);
    check('  and a reply past its ceiling is not read', huge.status === 413 && huge.body === null, String(huge.status));
  } finally {
    target.close();
    big.close();
    redirector.close();
  }
}

section('a server added once is ready for the next account, offered without starting anything');
{
  // As a deployment with the cloud computer and no local stdio.
  const before = { ...process.env };
  delete process.env.ALLOW_MCP_STDIO;
  Object.assign(process.env, { VERCEL_TOKEN: 'test-token', VERCEL_TEAM_ID: 'team_test', VERCEL_PROJECT_ID: 'prj_test' });
  const { initStore } = await import('../server/store/index.js');
  const store = await initStore();
  const { hashPassword, encryptSecret } = await import('../server/crypto.js');
  const registry = await import('../server/mcp/registry.js');
  const { createApp } = await import('../server/app.js');
  const config = { transport: 'stdio', command: process.execPath, args: [STUB] };
  try {
    // As if another account had added it first: checked on a scratch machine and kept.
    await store.saveSharedMcp({
      signature: cloud.mcpSignature(config),
      transport: 'stdio',
      target: 'stub',
      server: { name: 'stub', version: '0.0.1' },
      tools: registry.keptTools(stubTools),
    });

    const user = await store.createUser({ id: 'u-mcp-cloud', email: 'cloud@mcp.test', name: 'Cloud', passwordHash: await hashPassword('a-sufficiently-long-password'), role: 'user' });
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (...args) => {
      requests += 1;
      return realFetch(...args);
    };
    let probe;
    let offered;
    try {
      probe = await registry.probeMcpServer(config, { userId: user.id });
      await store.saveMcpServer(user.id, { id: 'mcp-cloud-row', name: 'stub', config: registry.sealConfig({ ...config, tools: probe.keep }), enabled: true });
      offered = await registry.mcpTools(user.id);
    } finally {
      globalThis.fetch = realFetch;
    }
    check('a server another account added is connected at once', probe.shared === true && probe.tools.length === 5, JSON.stringify({ shared: probe.shared, n: probe.tools.length }));
    check('a turn offers its tools from the kept list', offered.tools.filter((tool) => tool.name.startsWith('mcp__stub__')).length === 5, offered.tools.map((tool) => tool.name).join(', '));
    check('  saying it runs on the cloud computer', offered.servers.find((s) => s.id === 'stub')?.runsOn === 'cloud', JSON.stringify(offered.servers));
    check('  and neither started a machine nor asked one anything', requests === 0, `${requests} requests`);

    // The first call is what starts it — here the account's bridge is the local one above.
    await store.setUserSetting(user.id, cloud.__testing.SETTING, { url: conn.url, key: encryptSecret(conn.key), build: cloud.__testing.bridgeSource().build });
    const result = await registry.callMcpTool(user.id, 'mcp__stub__echo', { message: 'lần đầu' }, 30_000);
    check('the first call starts it on the account\'s own computer, and it answers', result.text === 'echo: lần đầu', result.text);

    // That first call can take minutes while `npx` installs. Keeping the list it
    // brings back must not bring back a server removed meanwhile, nor switch one
    // back on that was switched off.
    const whileConnecting = async (rowId, name, meanwhile) => {
      await store.saveMcpServer(user.id, { id: rowId, name, config: registry.sealConfig({ ...config, tools: probe.keep.slice(0, 1) }), enabled: true });
      registry.forgetMcp(user.id);
      const plainFetch = globalThis.fetch;
      let pending = true;
      globalThis.fetch = async (url, init) => {
        // Once, during the greeting: before the list is kept, not after it.
        if (pending && String(url).includes('/rpc')) {
          pending = false;
          await meanwhile();
        }
        return plainFetch(url, init);
      };
      try {
        await registry.callMcpTool(user.id, `mcp__${registry.slugify(name)}__echo`, { message: 'x' }, 30_000).catch(() => null);
      } finally {
        globalThis.fetch = plainFetch;
      }
      return store.getMcpServer(user.id, rowId);
    };
    const removed = await whileConnecting('mcp-cloud-removed', 'stubremoved', () => store.deleteMcpServer(user.id, 'mcp-cloud-removed'));
    check('a server removed while its first call connected stays removed', removed === null, JSON.stringify(removed?.config?.tools?.length));
    const switchedOff = await whileConnecting('mcp-cloud-off', 'stuboff', () => store.setMcpServerEnabled(user.id, 'mcp-cloud-off', false));
    check('  one switched off meanwhile stays off', switchedOff?.enabled === false, String(switchedOff?.enabled));
    check('  and still has its new list kept', switchedOff?.config?.tools?.length === 5, String(switchedOff?.config?.tools?.length));
    await store.deleteMcpServer(user.id, 'mcp-cloud-off');
    registry.forgetMcp(user.id);

    // Over HTTP: any account may add one here, because it runs on its own machine.
    const port = await freePort();
    const app = createApp().listen(port);
    await new Promise((r) => app.once('listening', r));
    try {
      const base = `http://127.0.0.1:${port}`;
      const session = async (email) => {
        const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-enough-password', name: email }) });
        return (res.headers.get('set-cookie') || '').split(';')[0];
      };
      await session('owner@mcp.test');
      const member = await session('member@mcp.test');
      const add = (cookie, name) =>
        fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name, transport: 'stdio', command: process.execPath, args: [STUB] }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const added = await add(member, 'stub');
      check('an ordinary account can add a stdio server that runs on its own cloud computer', added.status === 201 && added.body?.found?.shared === true && added.body?.server?.runsOn === 'cloud', JSON.stringify(added.body).slice(0, 200));
      check('  and the browser is not sent the whole tool list', added.body?.found?.keep === undefined);

      // The old rule still holds where the program would run beside the server.
      process.env.ALLOW_MCP_STDIO = '1';
      for (const k of ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID']) delete process.env[k];
      const local = await add(member, 'stub2');
      check('but not one that would run beside the server, with everybody\'s keys', local.status === 403, `${local.status}`);

      // Its row says where it runs, so switching ALLOW_MCP_STDIO on does not move
      // the ordinary account's server to beside the server.
      const memberRow = await store.getUserByEmail('member@mcp.test');
      registry.forgetMcp(memberRow.id);
      const stillThere = await registry.mcpTools(memberRow.id);
      check('a server added to run on the cloud computer stays there when stdio is allowed beside the server', stillThere.servers.find((s) => s.id === 'stub')?.runsOn === 'cloud', JSON.stringify(stillThere.servers));

      // A tool call whose reply may have been lost after it arrived is not sent
      // again: a tool that sends or deletes something must not run twice.
      let rpcs = 0;
      const lossy = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{"ok":true}');
        }
        rpcs += 1;
        res.writeHead(502);
        return res.end();
      });
      const lossyPort = await freePort();
      await new Promise((r) => lossy.listen(lossyPort, '127.0.0.1', r));
      try {
        const lossyKey = 'lossy-bridge-key'.padEnd(32, 'k');
        await store.setUserSetting(memberRow.id, cloud.__testing.SETTING, { url: `http://127.0.0.1:${lossyPort}`, key: encryptSecret(lossyKey), build: cloud.__testing.bridgeSource().build });
        const transport = cloud.cloudTransport({ command: process.execPath, args: [STUB] }, { userId: memberRow.id });
        let lost = '';
        await transport.request('tools/call', { name: 'echo', arguments: { message: 'once' } }, 5000).catch((err) => (lost = err.message));
        check('a tool call that may have arrived is not sent twice', rpcs === 1 && /could not be reached/.test(lost), `${rpcs} sent: ${lost}`);
        check('  and the connection is dropped, so the next turn starts afresh', !!transport.closed, String(transport.closed));
      } finally {
        lossy.close();
      }

      // An answer past the ceiling did arrive: it says so, is not sent again,
      // and the connection is kept.
      let sentHuge = 0;
      const huge = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/health') return res.end('{"ok":true}');
        sentHuge += 1;
        return res.end(`{"message":{"jsonrpc":"2.0","id":1,"result":{"x":"${'a'.repeat(9 * 1024 * 1024)}"}}}`);
      });
      const hugePort = await freePort();
      await new Promise((r) => huge.listen(hugePort, '127.0.0.1', r));
      try {
        const hugeKey = 'huge-bridge-key'.padEnd(32, 'k');
        await store.setUserSetting(memberRow.id, cloud.__testing.SETTING, { url: `http://127.0.0.1:${hugePort}`, key: encryptSecret(hugeKey), build: cloud.__testing.bridgeSource().build });
        const transport = cloud.cloudTransport({ command: process.execPath, args: [STUB] }, { userId: memberRow.id });
        let told = '';
        await transport.request('tools/call', { name: 'echo', arguments: { message: 'big' } }, 10_000).catch((err) => (told = err.message));
        check('an answer past the ceiling says so', /more than 8 MB/.test(told) && sentHuge === 1, `${sentHuge} sent: ${told}`);
        check('  and keeps the connection', !transport.closed, String(transport.closed));
      } finally {
        huge.close();
      }
    } finally {
      app.close();
    }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
}

bridge.kill();
{
  const { getStore } = await import('../server/store/index.js');
  await getStore().close?.();
  /**
   * Tidying up must not be able to fail the suite.
   *
   * On Windows a file cannot be unlinked while a handle is still open on it, and
   * PGlite's WASM layer releases its handles a moment after `close()` resolves.
   * `rmSync` in that window throws ENOTEMPTY, the suite exits non-zero, and the
   * gate reports a failure in which every single check passed — which trains
   * people to re-run a red gate rather than read it, and that is the habit the
   * ledger exists to prevent.
   *
   * A few retries cover the gap. If the directory genuinely will not go, it is
   * a temp directory named after this process id: the operating system clears
   * it eventually, and nothing about it is worth a false red.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll MCP checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
