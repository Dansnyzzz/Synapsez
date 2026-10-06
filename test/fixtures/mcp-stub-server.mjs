/**
 * A minimal MCP server, for testing the client against.
 *
 * Real enough to catch the mistakes that matter: it refuses `tools/list` before
 * `initialize` (which is how a client that skips the handshake silently sees no
 * tools), it paginates, and it can be told to answer slowly or to fail — because
 * the interesting behaviour of a client is what it does when a server misbehaves.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout, as stdio servers do.
 *
 *   MCP_STUB_MODE=slow      never answers tools/list, to exercise the timeout
 *   MCP_STUB_MODE=nogreet   fails initialize, to exercise the handshake failure
 *   MCP_STUB_MODE=noisy     prints a banner to stdout first, as many servers do
 *   MCP_STUB_MODE=strictinit refuses a second initialize, as real servers do —
 *                           the cloud bridge has to answer that one itself
 */
const MODE = process.env.MCP_STUB_MODE || 'normal';

// Servers print startup banners to stdout more often than they should, and a
// client that treats a non-JSON line as a protocol error dies on them.
if (MODE === 'noisy') process.stdout.write('Starting stub server v1...\n');
if (MODE === 'stderr') process.stderr.write('stub: could not find configuration\n');

let initialised = false;

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo a message back.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  { name: 'structured', description: 'Answer with structuredContent instead of text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'picture', description: 'Answer with an image part.', inputSchema: { type: 'object', properties: {} } },
  { name: 'explode', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    if (MODE === 'nogreet') return fail(id, -32603, 'This server refuses to initialise.');
    if (MODE === 'strictinit' && initialised) return fail(id, -32600, 'Already initialised.');
    initialised = true;
    return ok(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'stub', version: '0.0.1' },
      instructions: 'A stub, for tests.',
    });
  }

  // Notifications carry no id and expect no answer.
  if (method === 'notifications/initialized') return undefined;

  // The rule a real server enforces and a careless client trips over.
  if (!initialised) return fail(id, -32002, 'Not initialised. Send initialize first.');

  if (method === 'tools/list') {
    if (MODE === 'slow') return undefined; // never answers, on purpose
    // Paginated, so a client that stops at the first page is caught.
    const cursor = params?.cursor;
    if (!cursor) return ok(id, { tools: TOOLS.slice(0, 2), nextCursor: 'page2' });
    return ok(id, { tools: TOOLS.slice(2) });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'echo') return ok(id, { content: [{ type: 'text', text: `echo: ${args.message}` }] });
    if (name === 'add') return ok(id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
    if (name === 'structured') return ok(id, { structuredContent: { rows: [1, 2, 3], note: 'no content list' } });
    if (name === 'picture') {
      return ok(id, { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    }
    if (name === 'explode') {
      // A tool that failed, reported the way MCP says to: a result with isError,
      // not a JSON-RPC error. A client that conflates them loses the message.
      return ok(id, { content: [{ type: 'text', text: 'it exploded' }], isError: true });
    }
    return fail(id, -32602, `Unknown tool "${name}"`);
  }

  return fail(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf('\n');
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* a malformed line is not worth dying over */
      }
    }
    cut = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
