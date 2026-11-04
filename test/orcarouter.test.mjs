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

/**
 * The owner's screenshots (2026-11-04): DeepSeek V4.1 Flash (Free) drawn at 128K
 * with no eyes and a 4,096-token reply, on a model OrcaRouter's own page gives
 * 1M, 384K output and vision. Live, `/v1/models` lists a `-free` id with nothing
 * but its price; the facts are in `/api/pricing` and on the model it shadows.
 */
section('a -free id takes its facts from the catalogue and the model it shadows');
{
  const { enrichOrcaCatalogue, isChatModel } = __testing;
  const paid = {
    id: 'deepseek/deepseek-v4.1-flash',
    created: 1_626_777_600,
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    context_length: 1_048_576,
    max_completion_tokens: 384_000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0.00000015', completion: '0.0000006' },
    supported_endpoint_types: ['openai'],
    supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
  };
  // As /v1/models lists it: an id, a placeholder date and a price.
  const sparse = { id: 'deepseek/deepseek-v4.1-flash-free', created: 1_626_777_600, supported_endpoint_types: ['openai'], pricing: { prompt: '0.0000000000', completion: '0.0000000000' } };
  const details = [
    {
      model_name: 'deepseek/deepseek-v4.1-flash-free',
      display_name: 'DeepSeek: DeepSeek V4.1 Flash (Free)',
      context_length: 1_048_576,
      max_completion_tokens: 384_000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      free_base_model: 'deepseek/deepseek-v4.1-flash',
      supported_endpoint_types: ['openai'],
      is_free_tier: true,
    },
    { model_name: 'deepseek/deepseek-v4.1-flash', created: 1_792_220_400 },
  ];

  const [read] = enrichOrcaCatalogue([sparse, paid], { details }).map((e) => normalise(e, 'orcarouter'));
  check('its window is the 1M OrcaRouter states', read.context === 1_048_576, String(read.context));
  check('its output limit is the 384K it states, not the cautious 4,096', read.maxOutput === 384_000, String(read.maxOutput));
  check('it reads pictures', read.vision === true);
  check('it reasons, so the effort dial reaches it', read.reasoning === true);
  check('it keeps its own name', read.label === 'DeepSeek: DeepSeek V4.1 Flash (Free)', read.label);
  check('and is still free: the paid model lends facts, never its price', read.isFree === true && read.priceIn === 0 && read.priceOut === 0, `${read.priceIn}/${read.priceOut}`);

  // /api/pricing did not answer: the model it shadows has the same weights.
  const [alone] = enrichOrcaCatalogue([sparse, paid], {}).map((e) => normalise(e, 'orcarouter'));
  check('without the catalogue, the paid twin still says what it is', alone.context === 1_048_576 && alone.maxOutput === 384_000 && alone.vision === true && alone.isFree === true, JSON.stringify([alone.context, alone.maxOutput, alone.vision, alone.isFree]));

  // Named by the free package rather than by the -free suffix.
  const renamed = enrichOrcaCatalogue(
    [{ id: 'lab/promo', pricing: { request: '0.000000' } }, { ...paid, id: 'lab/full' }],
    { freePackage: { models: [{ free_alias: 'lab/promo', base_model: 'lab/full' }] } },
  )[0];
  check('the free package can name the twin', renamed.context_length === 1_048_576, String(renamed.context_length));

  const paidRead = normalise(enrichOrcaCatalogue([paid], { details })[0], 'orcarouter');
  check('a release date comes from the catalogue, not the 2021 placeholder /v1/models repeats', paidRead.releasedAt?.startsWith('2026-'), paidRead.releasedAt);
  const noDate = normalise(enrichOrcaCatalogue([{ ...paid, id: 'lab/x' }], {})[0], 'orcarouter');
  check('and with no real date there is none, rather than a false one', noDate.releasedAt === null, String(noDate.releasedAt));

  // A model OpenRouter also carries fills what OrcaRouter leaves blank.
  const gap = enrichOrcaCatalogue([{ id: 'google/gemini-4-argon', pricing: { prompt: '0.000002', completion: '0.00001' } }], {
    siblings: [{ id: 'google/gemini-4-argon', context_length: 1_048_576, top_provider: { max_completion_tokens: 65_536 }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], pricing: { prompt: '1', completion: '1' } }],
  })[0];
  const gapRead = normalise(gap, 'orcarouter');
  check('facts about a model may come from the other router', gapRead.context === 1_048_576 && gapRead.maxOutput === 65_536 && gapRead.vision === true, JSON.stringify([gapRead.context, gapRead.maxOutput, gapRead.vision]));
  check('  but its price stays OrcaRouter\'s own', gapRead.priceIn === 2, String(gapRead.priceIn));

  const router = normalise(enrichOrcaCatalogue([{ id: 'orcarouter/free', created: 0, supported_endpoint_types: ['openai'] }], {})[0], 'orcarouter');
  check('orcarouter/free is free, as its documentation promises', router.isFree === true && router.priceIn === 0, JSON.stringify([router.isFree, router.priceIn]));

  // What should never be offered as a chat model, though its row says little.
  check('a video model is not a chat model', !isChatModel({ id: 'kling/kling-v3', supported_endpoint_types: ['openai-video'] }));
  check('nor an embedding model', !isChatModel({ id: 'x/embed', supported_endpoint_types: ['embeddings'] }));
  check('nor an entry that names no way to talk to it', !isChatModel({ id: 'codex-auto-review', supported_endpoint_types: [] }));
  check('a chat model is one', isChatModel({ id: 'a/b', supported_endpoint_types: ['anthropic', 'openai'] }));
  check('and OpenRouter, which does not say, is not judged by it', isChatModel({ id: 'a/b' }));
  const hy3 = enrichOrcaCatalogue([{ id: 'tencent/hy3-free', supported_endpoint_types: [], pricing: { request: '0.000000' } }], { details: [{ model_name: 'tencent/hy3-free', supported_endpoint_types: ['openai'] }] })[0];
  check('an empty list on /v1/models is filled from the catalogue before it is judged', isChatModel(hy3));
}

/**
 * OrcaRouter states what a call cost only when asked, on `usage.cost_usd`
 * (docs: operations/per-request-cost). The code said it reported `usage.cost`.
 */
section('what OrcaRouter charged is read from where it says it');
{
  const { __testing: wire } = await import('../server/providers/openaiCompatible.js');
  check('cost_usd is the billed cost', wire.readUsage({ prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.00846 }).costUsd === 0.00846);
  check('OpenRouter\'s cost still reads', wire.readUsage({ prompt_tokens: 10, completion_tokens: 5, cost: 0.002 }).costUsd === 0.002);
  const { orcaHeaders } = await import('../server/providers/index.js');
  check('and it is asked for on every request', orcaHeaders()['X-OrcaRouter-Include-Cost'] === 'true', JSON.stringify(orcaHeaders()));
}

/**
 * The four free-tier rejections (docs: routing/free-models, operations/errors).
 * Branch on `metadata.reason`: the message is localised and carries no numbers.
 */
section('each free-tier rejection is read for what it is');
{
  const { classify } = await import('../server/providers/index.js');
  const refusal = (status, reason, extra = {}) => Object.assign(new Error('Free model capacity is limited right now.'), { status, code: 'free_rate_limited', error: { code: 'free_rate_limited', metadata: { reason, ...extra } } });

  const windowFull = Object.assign(refusal(429, 'err_free_rate', { retry_after_seconds: 37 }), { headers: { 'retry-after': '37' } });
  check('a full window is a wait of exactly what it says', classify(windowFull).kind === 'RATE_LIMITED' && classify(windowFull).retryAfterMs === 37_000, JSON.stringify(classify(windowFull)));
  const inBody = refusal(429, 'err_free_rate', { retry_after_seconds: 12 });
  check('  even when only the body says it', classify(inBody).retryAfterMs === 12_000, JSON.stringify(classify(inBody)));
  check('no wait stated is the free channel saturated: the provider, not the key', classify(refusal(429, 'err_free_rate')).kind === 'UPSTREAM');
  check('the prompt cap is not retried, and says why', classify(refusal(400, 'err_free_prompt_cap')).kind === 'FREE_PROMPT_CAP');
  check('a workspace not yet allowed is not a rate limit', classify(refusal(429, 'err_free_access_denied')).kind === 'FREE_DENIED');
  const exhausted = Object.assign(new Error('no free model'), { status: 402, code: 'free_quota_exhausted', error: { code: 'free_quota_exhausted' } });
  check('orcarouter/free finding nothing does not condemn the key', classify(exhausted).kind === 'UPSTREAM');
  const broke = Object.assign(new Error('out of credits'), { status: 402, code: 'insufficient_user_quota', error: { code: 'insufficient_user_quota' } });
  check('a workspace out of credit still does', classify(broke).kind === 'KEY_DEAD');
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
