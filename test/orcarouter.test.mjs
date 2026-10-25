/**
 * OrcaRouter, added as a second OpenAI-compatible aggregator beside OpenRouter.
 *
 * The whole of it is that OrcaRouter speaks the same wire format on a different
 * host, so the work is one `case` in the dispatcher and one shape adapter in the
 * catalogue ingest. What is worth pinning is exactly the places its `/models`
 * shape differs from OpenRouter's — the max-output field sits at the top level
 * rather than under `top_provider` — and that a free model is still read as free
 * and an image model as seeing.
 *
 *   node test/orcarouter.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'orca-test-encryption-key';
process.env.SESSION_SECRET ||= 'orca-test-session-secret';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { __testing } = await import('../server/models.js');
const { normalise } = __testing;

const { PROVIDERS } = await import('../server/providers/catalog.js');
const { baseUrlFor } = await import('../server/settings.js');

section('an OrcaRouter model is read into the shared shape');
{
  // A free, image-capable entry in OrcaRouter's actual /models shape.
  const entry = {
    id: 'deepseek/deepseek-v4-flash-free',
    object: 'model',
    created: 1_700_000_000,
    name: 'DeepSeek V4 Flash (free)',
    context_length: 128_000,
    // Top level, not under top_provider — this is the shape difference.
    max_completion_tokens: 16_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' },
  };
  const m = normalise(entry, 'orcarouter');

  check('the id is prefixed with the provider', m.id === 'orcarouter/deepseek/deepseek-v4-flash-free', m.id);
  check('the provider is recorded', m.provider === 'orcarouter', m.provider);
  check('a zero price reads as free', m.isFree === true, `in=${m.priceIn} out=${m.priceOut}`);
  check('an image model is seen as one', m.vision === true);
  check('the top-level max output is picked up', m.maxOutput === 16_000, String(m.maxOutput));
  check('the context survives', m.context === 128_000, String(m.context));
}

section('OrcaRouter marks a free model with a request price, not per-token');
{
  // The shape its live /models actually uses for free models: {request:"0"} and
  // no prompt/completion. Read wrongly this looked paid, so every free model
  // vanished from the Free tab — which is what this pins against.
  const m = normalise(
    {
      id: 'deepseek/deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash (Free)',
      pricing: { request: '0.000000' },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
    'orcarouter',
  );
  check('a request-priced-zero model is free', m.isFree === true, `in=${m.priceIn} out=${m.priceOut}`);
  check('and its price reads as zero, not null', m.priceIn === 0 && m.priceOut === 0, `${m.priceIn}/${m.priceOut}`);

  // A per-token priced model is still paid — the request-free rule must not
  // sweep those in.
  const paid = normalise({ id: 'x/y', pricing: { prompt: '0.000001', completion: '0.000002' } }, 'orcarouter');
  check('a per-token price is still paid', paid.isFree === false, `${paid.priceIn}/${paid.priceOut}`);
}

section('a paid text-only entry is read correctly too');
{
  const entry = {
    id: 'anthropic/claude-opus-4.8',
    context_length: 1_000_000,
    max_completion_tokens: 128_000,
    architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
    pricing: { prompt: '0.0000050000', completion: '0.0000250000' },
  };
  const m = normalise(entry, 'orcarouter');
  check('a real price is not free', m.isFree === false, `in=${m.priceIn} out=${m.priceOut}`);
  check('the per-million price is derived', m.priceIn === 5 && m.priceOut === 25, `in=${m.priceIn} out=${m.priceOut}`);
}

section('the OpenRouter shape still normalises, unchanged');
{
  // top_provider.max_completion_tokens — the shape the parametrised maxOutputOf
  // must keep reading, or adding OrcaRouter would quietly break OpenRouter.
  const entry = {
    id: 'meta-llama/llama-3.3-70b-instruct',
    context_length: 131_072,
    top_provider: { max_completion_tokens: 8192 },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' },
  };
  const m = normalise(entry, 'openrouter');
  check('its id prefixes with openrouter', m.id === 'openrouter/meta-llama/llama-3.3-70b-instruct', m.id);
  check('its nested max output is still read', m.maxOutput === 8192, String(m.maxOutput));
  check('a text-only model does not claim vision', m.vision === false);
}

section('the provider is wired into the app');
{
  check('OrcaRouter is a known provider', !!PROVIDERS.orcarouter, JSON.stringify(PROVIDERS.orcarouter));
  check('with the sk-orca key hint', /orca/i.test(PROVIDERS.orcarouter?.keyHint || ''), PROVIDERS.orcarouter?.keyHint);

  // baseUrlFor only answers for providers whose base is env-overridable; the
  // OrcaRouter base is fixed in the dispatcher like OpenRouter's, so this just
  // checks the settings layer accepts the provider name at all.
  check('baseUrlFor tolerates the provider name', baseUrlFor('orcarouter') === undefined || typeof baseUrlFor('orcarouter') === 'string');
}

/**
 * A router that sends no call ids (code review, 2026-10-25): the fallback was
 * `call_<name>`, so two parallel reads in one step shared an id, and the page
 * drew one row and dropped the second result.
 */
section('calls that arrive without ids get ids of their own');
{
  const { createServer } = await import('node:http');
  const { streamOpenAICompatible } = await import('../server/providers/openaiCompatible.js');
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        chunk({ role: 'assistant', tool_calls: [{ index: 0, type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://a.example"}' } }] }) +
          chunk({ tool_calls: [{ index: 1, type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://b.example"}' } }] }) +
          chunk({}, 'tool_calls') +
          'data: [DONE]\n\n',
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const tools = [{ name: 'web_fetch', description: 'fetch', parameters: { type: 'object', properties: { url: { type: 'string' } } } }];
  const ask = async () => {
    let calls = [];
    for await (const event of streamOpenAICompatible({ apiKey: 'k', baseURL: `http://127.0.0.1:${port}/v1`, model: 'm', entry: { id: 'm' }, system: '', messages: [{ role: 'user', text: 'read both' }], tools })) {
      if (event.type === 'done') calls = event.toolCalls || [];
    }
    return calls;
  };
  try {
    const first = await ask();
    const second = await ask();
    const ids = [...first, ...second].map((c) => c.id);
    check('two calls to one tool in one step get two ids', first.length === 2 && first[0].id !== first[1].id, ids.join(', '));
    check('  and the next step does not reuse them', second.length === 2 && new Set(ids).size === 4, ids.join(', '));
  } finally {
    server.close();
  }
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll OrcaRouter checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
