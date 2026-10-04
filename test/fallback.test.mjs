/**
 * Key-fallback suite — the decisions, with no network in sight.
 *
 * `classify` and the cooldown registry are the whole of the judgement: which
 * failures are worth another key, which are worth waiting for, and which are
 * worth reporting immediately. They are pure enough to test directly, which is
 * the point of having pulled them out of the streaming loop.
 *
 * The reason this file exists: a key that died mid-answer ended the turn, and
 * the only way on was for somebody to type "continue" — which worked purely
 * because it started a fresh request where the failure landed before the first
 * token. Nothing tested the middle of an answer, so nothing noticed.
 *
 *   node test/fallback.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'fallback-test-encryption-key';
process.env.SESSION_SECRET ||= 'fallback-test-session-secret';
// A real store, in a throwaway directory — the rotation reads the account's
// keys, and stubbing that out would be stubbing out half of what is on trial.
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-fallback-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

const { __testing } = await import('../server/providers/index.js');
const { classify, waitFrom, headerOf } = __testing;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/** An SDK error, near enough: the shape both SDKs actually throw. */
const err = (status, message = '', headers = null) =>
  Object.assign(new Error(message), { status, headers });

section('a failure is graded by what it says about the key');
{
  check('429 is a wait, not a dead key', classify(err(429, 'Rate limit exceeded')).kind === 'RATE_LIMITED');
  check('401 is a dead key', classify(err(401, 'Invalid API key')).kind === 'KEY_DEAD');
  check('402 is a dead key', classify(err(402, 'Insufficient credits')).kind === 'KEY_DEAD');
  check('403 is a dead key', classify(err(403, 'Forbidden')).kind === 'KEY_DEAD');
  check('503 is the provider, not the key', classify(err(503, 'Service unavailable')).kind === 'UPSTREAM');
  check('a socket hang up is upstream', classify(err(0, 'socket hang up')).kind === 'UPSTREAM');
  // An error sent inside a stream the provider had already started: no status,
  // and the next attempt usually works.
  check('an error injected mid-stream is upstream', classify(err(undefined, 'JSON error injected into SSE stream')).kind === 'UPSTREAM');
  // The report: free models on OpenRouter answer "Provider returned an empty
  // response" now and then; graded FATAL it ended the turn every time.
  check('an empty response from the provider is retried, not fatal', classify(err(undefined, 'Provider returned an empty response')).kind === 'UPSTREAM');
  check('an overloaded provider is upstream', classify(err(undefined, 'Provider returned error: overloaded')).kind === 'UPSTREAM');
  check('400 is fatal on every key', classify(err(400, 'messages: invalid role')).kind === 'FATAL');
  check('an unknown model is fatal', classify(err(404, 'model not found')).kind === 'FATAL');

  // The old code read 429 and 402 as the same thing. They are not: one wants a
  // few seconds, the other wants a different key, and treating a rate limit as
  // a dead key is what sent a single-key account straight to a hard failure.
  check(
    'a rate limit and an empty wallet are graded differently',
    classify(err(429)).kind !== classify(err(402)).kind,
  );

  // "quota" appears in plenty of 429 messages, so status has to win over the
  // wording, or every rate limit is misread as a spent key.
  check(
    'wording does not override the status',
    classify(err(429, 'You have exceeded your quota')).kind === 'RATE_LIMITED',
  );

  // Some providers say it in prose and attach no status at all.
  check(
    'an invalid key by message alone',
    classify(new Error('Incorrect API key provided')).kind === 'KEY_DEAD',
  );
  // A bare "quota" is a limit until proven otherwise: resting a key for a
  // minute is recoverable, condemning it for the life of the process is not.
  check(
    'a bare quota message rests the key rather than condemning it',
    classify(new Error('Your quota has been exceeded')).kind === 'RATE_LIMITED',
  );
}

section('a provider that goes silent is given up on, and retried');
{
  const { stallGuard } = __testing;
  // Accepts the request, says one word, then nothing — no error, no close.
  async function* silentAfterOne() {
    yield { type: 'text', delta: 'Giờ tôi thu thập' };
    await new Promise(() => {});
  }
  const got = [];
  let failure = null;
  try {
    for await (const ev of stallGuard(silentAfterOne(), { first: 200, between: 60 })) got.push(ev);
  } catch (err) {
    failure = err;
  }
  check('what arrived before the silence is kept', got.length === 1);
  check('the silence ends the attempt instead of hanging the turn', /stalled/.test(failure?.message || ''), failure?.message);
  check('and it is graded as the provider stumbling, so it is retried', classify(failure).kind === 'UPSTREAM');

  async function* steady() {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'text', delta: String(i) };
    }
  }
  const all = [];
  for await (const ev of stallGuard(steady(), { first: 200, between: 60 })) all.push(ev);
  check('a provider that keeps talking is left alone', all.length === 3);
}

section('how long to wait comes from the provider, not from a guess');
{
  check('Retry-After in seconds', waitFrom(err(429, '', { 'retry-after': '20' })) === 20_000);
  check('Retry-After is case-insensitive', waitFrom(err(429, '', { 'Retry-After': '5' })) === 5_000);

  const now = Date.UTC(2026, 7, 30, 12, 0, 0);
  check(
    'Retry-After as an HTTP date',
    waitFrom(err(429, '', { 'retry-after': new Date(now + 30_000).toUTCString() }), now) === 30_000,
  );

  // OpenRouter sends epoch milliseconds; others send epoch seconds, and some
  // send a plain duration. Magnitude tells them apart, because the header name
  // does not.
  check(
    'X-RateLimit-Reset as epoch milliseconds',
    waitFrom(err(429, '', { 'x-ratelimit-reset': String(now + 45_000) }), now) === 45_000,
  );
  check(
    'X-RateLimit-Reset as epoch seconds',
    waitFrom(err(429, '', { 'x-ratelimit-reset': String((now + 60_000) / 1000) }), now) === 60_000,
  );
  check(
    'X-RateLimit-Reset as a plain duration',
    waitFrom(err(429, '', { 'x-ratelimit-reset': '15' }), now) === 15_000,
  );

  check('nothing said means nothing known', waitFrom(err(429)) === null);

  // A daily cap resets hours away. Reporting it honestly is the job; holding
  // the request open until midnight is not.
  const tomorrow = waitFrom(err(429, '', { 'x-ratelimit-reset': String(now + 8 * 3600_000) }), now);
  check('a daily cap is reported in full, not clamped', tomorrow === 8 * 3600_000, String(tomorrow));
}

section('a Headers object reads the same as a plain object');
{
  const bag = new Headers({ 'retry-after': '7' });
  check('Headers instance', headerOf(err(429, '', bag), 'retry-after') === '7');
  check('plain object', headerOf(err(429, '', { 'retry-after': '7' }), 'retry-after') === '7');
  check('absent header', headerOf(err(429, '', {}), 'retry-after') === null);
}

section('a key known to be resting is not probed again');
{
  const settings = await import('../server/settings.js');
  const { markKeyLimited, markKeyDead, keyRestingUntil, clearKeyRest } = settings;
  const { isResting } = settings.__testing;

  const uid = 'u-rest';
  clearKeyRest(uid, 'openrouter');

  check('nothing is resting to begin with', keyRestingUntil(uid, 'openrouter') === null);

  const until = Date.now() + 30_000;
  markKeyLimited(uid, 'openrouter', 0, until);
  check('a limited key is resting', isResting(uid, 'openrouter', 0) === true);
  check('its neighbour is not', isResting(uid, 'openrouter', 1) === false);
  check('the soonest reset is reported', keyRestingUntil(uid, 'openrouter') === until);

  // The whole point: the second key rests longer, but the caller is told about
  // the one that frees up first, because that is when work can resume.
  markKeyLimited(uid, 'openrouter', 1, until + 60_000);
  check('the soonest of several is reported', keyRestingUntil(uid, 'openrouter') === until);

  // A cooldown in the past is over. Nothing sweeps it; it simply stops counting.
  markKeyLimited(uid, 'openrouter', 2, Date.now() - 1000);
  check('an elapsed cooldown has lifted', isResting(uid, 'openrouter', 2) === false);

  // A dead key never comes back on its own — no reset time can be right for
  // "this key is invalid", so it rests until the process restarts or the key
  // is edited.
  markKeyDead(uid, 'openrouter', 3);
  check('a dead key stays down', isResting(uid, 'openrouter', 3) === true);
  check('a dead key sets no reset time', keyRestingUntil(uid, 'openrouter') === until);

  // One account resting a key must not rest anybody else's.
  markKeyLimited('u-other', 'openrouter', 0, until);
  clearKeyRest(uid, 'openrouter');
  check('editing the keys clears the slate', isResting(uid, 'openrouter', 0) === false);
  check('and leaves other accounts alone', isResting('u-other', 'openrouter', 0) === true);
  clearKeyRest('u-other', 'openrouter');
}

section('the rotation reacts to what actually came out');
{
  const { initStore } = await import('../server/store/index.js');
  const store = await initStore();
  const { hashPassword } = await import('../server/crypto.js');
  const { streamCompletion } = await import('../server/providers/index.js');
  const { setApiKey, addApiKey, clearKeyRest } = await import('../server/settings.js');

  const uid = 'u-rot';
  await store.createUser({
    id: uid,
    email: 'rot@example.com',
    name: 'Rot',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'admin',
  });

  const entry = { provider: 'openrouter', model: 'x/y:free', context: 128_000, maxOutput: 4096 };

  /**
   * Drive the loop with scripted outcomes, one per key it reaches for.
   *
   * `streamOne` and `sleep` are injected the way `runOne` in subagents.js
   * already takes its `stream` — the point is to watch the decisions without a
   * network, and without real seconds passing.
   */
  const drive = async (script, keys = ['key-one', 'key-two'], signal = undefined, model = entry) => {
    await setApiKey(uid, 'openrouter', keys[0]);
    for (const spare of keys.slice(1)) await addApiKey(uid, 'openrouter', spare);
    clearKeyRest(uid, 'openrouter');

    const seen = [];
    const events = [];
    const waits = [];
    const budgets = [];
    const streamOne = async function* (_entry, common) {
      const step = script[seen.length] || { throw: err(500, 'ran off the end of the script') };
      seen.push(common.apiKey);
      budgets.push(common.maxTokens);
      for (const event of step.emit || []) yield event;
      if (step.throw) throw step.throw;
    };
    let error = null;
    try {
      for await (const event of streamCompletion({
        userId: uid,
        entry: model,
        messages: [],
        signal,
        streamOne,
        sleep: async (ms) => waits.push(ms),
      })) {
        events.push(event);
      }
    } catch (thrown) {
      error = thrown;
    }
    return { seen, events, waits, budgets, error };
  };

  // Nothing was shown, so nothing is lost: the second key picks the turn up and
  // the reader never learns there was a first.
  {
    const run = await drive([
      { throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'hello' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a limit before any output rotates', run.seen.length === 2, run.seen.join(','));
    check('and the answer arrives', run.events.some((e) => e.type === 'text' && e.delta === 'hello'));
    check('with no retry event, because nothing was discarded', !run.events.some((e) => e.type === 'retry'));
    check('and no error', run.error === null, String(run.error?.message || ''));
  }

  // Thinking is not the answer. Replaying it costs nothing a reader can see,
  // so it must not pin the turn to a key that has already failed — which is
  // exactly what the old `streamed` flag did.
  {
    const run = await drive([
      { emit: [{ type: 'thinking', delta: 'hmm' }], throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('thinking alone does not pin the turn to a dead key', run.seen.length === 2);
    check('no prose was discarded, so no retry event', !run.events.some((e) => e.type === 'retry'));
  }

  // The case that used to end the turn and make somebody type "continue".
  // Prose was on screen, so the restart has to say so.
  {
    const run = await drive([
      { emit: [{ type: 'text', delta: 'half a sen' }], throw: err(429, 'Rate limit') },
      { emit: [{ type: 'text', delta: 'a whole answer' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a limit mid-answer still rotates', run.seen.length === 2);
    check('and announces the discard', run.events.some((e) => e.type === 'retry'));
    check(
      'the retry is announced before the replacement text',
      run.events.findIndex((e) => e.type === 'retry') <
        run.events.findLastIndex((e) => e.type === 'text'),
    );
  }

  // A broken request is broken on every key. Walking the rest turns one clear
  // error into several slow ones.
  {
    const run = await drive([{ throw: err(400, 'messages: invalid role') }]);
    check('a fatal error burns exactly one key', run.seen.length === 1, run.seen.join(','));
    check('and is reported', run.error !== null);
  }

  // The provider stumbled rather than the key being wrong, so it is the same
  // key that wants trying — and it waits before doing so.
  {
    const run = await drive([
      { throw: err(503, 'Service unavailable') },
      { emit: [{ type: 'text', delta: 'recovered' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('a provider stumble retries the same key', run.seen[0] === run.seen[1], run.seen.join(','));
    check('after pausing first', run.waits.length >= 1, String(run.waits[0]));
    check('and finishes', run.error === null, String(run.error?.message || ''));
  }

  // A provider that is genuinely down is down for every key on the account —
  // they all reach the same servers. Walking the rest is the "five slow errors"
  // case, so patience runs out on the first key rather than on the last.
  {
    const run = await drive([
      { throw: err(503, 'Service unavailable') },
      { throw: err(503, 'Service unavailable') },
      { throw: err(503, 'Service unavailable') },
      { emit: [{ type: 'text', delta: 'never reached' }, { type: 'done', stopReason: 'end_turn' }] },
    ]);
    check('an outage gives up rather than spending the other keys', run.seen.length === 3, run.seen.join(','));
    check('all three tries were the same key', new Set(run.seen).size === 1, run.seen.join(','));
    check('and it is reported', run.error !== null, String(run.error?.message || ''));
  }

  // One key, momentarily limited, is the ordinary free-tier situation. Waiting
  // is the whole answer, and used to be the one thing the code could not do.
  {
    const run = await drive(
      [
        { throw: err(429, 'Rate limit', { 'retry-after': '3' }) },
        { emit: [{ type: 'text', delta: 'worth the wait' }, { type: 'done', stopReason: 'end_turn' }] },
      ],
      ['only-key'],
    );
    check('a single key waits rather than failing', run.error === null, String(run.error?.message || ''));
    check('and answers on the second attempt', run.seen.length === 2, run.seen.join(','));
    // A range, not a tolerance. The wait is `resetTime - now`, so it is always
    // a little under the three seconds asked for, by however long the machine
    // took to get here — which under a full suite run is not a fixed amount.
    // What matters is where the number came from: the provider's three seconds,
    // rather than the sixty-second default for a limit that named no time, or a
    // sub-second upstream backoff. Those are far enough apart to tell without
    // pretending the scheduler is predictable.
    check(
      'having waited the time the provider asked for',
      run.waits.some((ms) => ms > 2000 && ms <= 3000),
      run.waits.join(','),
    );
  }

  // Pressing stop ends the turn. A failure that arrives once the signal is set
  // is not a failure to recover from, whatever its wording happens to look
  // like — carrying on would be ignoring the person who asked to stop.
  {
    const controller = new AbortController();
    controller.abort();
    const run = await drive(
      [
        { throw: err(503, 'network timed out') },
        { emit: [{ type: 'text', delta: 'should never run' }, { type: 'done', stopReason: 'end_turn' }] },
      ],
      ['only-key'],
      controller.signal,
    );
    check('an abort is not retried', run.seen.length === 1, run.seen.join(','));
    check('and nothing was waited for', run.waits.length === 0, run.waits.join(','));
    check('and it is passed straight back up', run.error !== null);
  }

  // A daily cap resets hours away. Holding the request open until then is not
  // an option, so the honest thing is to say when it lifts.
  {
    const reset = Date.now() + 6 * 3600_000;
    const run = await drive(
      [{ throw: err(429, 'Rate limit', { 'x-ratelimit-reset': String(reset) }) }],
      ['only-key'],
    );
    check('a cap hours away is not waited out', run.error !== null);
    check(
      'and the message says when it lifts',
      /rate limited until/i.test(run.error?.message || ''),
      run.error?.message,
    );
  }

  /**
   * The screenshot: a free model publishing a 235,929-token output cap on a
   * 262,144 window, asked for all of it on top of an 80,000-token conversation.
   * The provider measured the overflow and refused; the same key is asked again
   * for what fits, and nobody sees anything but the reply.
   */
  {
    const big = { provider: 'openrouter', model: 'nex/n2.5-mini:free', context: 262_144, maxOutput: 235_929 };
    const refusal = err(
      400,
      "400 This endpoint's maximum context length is 262144 tokens. However, you requested about 316800 tokens " +
        '(71928 of text input, 1445 of image input, 7498 of tool input, 235929 in the output).',
    );
    const run = await drive(
      [{ throw: refusal }, { emit: [{ type: 'text', delta: 'fits now' }, { type: 'done', stopReason: 'stop' }] }],
      ['only-key'],
      undefined,
      big,
    );
    check('a context-length refusal is asked again, not reported', run.error === null, String(run.error?.message || ''));
    check('on the same key', run.seen.length === 2 && run.seen[0] === run.seen[1], run.seen.join(','));
    check(
      'asking for only what fits beside the measured input',
      run.budgets[1] === 262_144 - (316_800 - 235_929) - 512,
      run.budgets.join(','),
    );
  }

  // Asked again once. A second refusal is reported, not looped on.
  {
    const big = { provider: 'openrouter', model: 'nex/n2.5-mini:free', context: 262_144, maxOutput: 235_929 };
    const refusal = () =>
      err(
        400,
        'maximum context length is 262144 tokens. However, you requested about 300000 tokens ' +
          '(100000 of text input, 200000 in the output).',
      );
    const run = await drive([{ throw: refusal() }, { throw: refusal() }], ['only-key'], undefined, big);
    check('a second refusal ends the turn', run.error !== null && run.seen.length === 2, run.seen.join(','));
  }

  // A conversation that alone overfills the window has nothing to shrink.
  {
    const small = { provider: 'openrouter', model: 'tiny:free', context: 8192, maxOutput: 4096 };
    const run = await drive(
      [
        {
          throw: err(
            400,
            'maximum context length is 8192 tokens. However, you requested about 12000 tokens ' +
              '(9000 of text input, 3000 in the output).',
          ),
        },
      ],
      ['only-key'],
      undefined,
      small,
    );
    check('an input larger than the window says so', /no longer fits/.test(run.error?.message || ''), run.error?.message);
  }
}

section('a restart clears the text the reader had already seen');
{
  const { __testing: agentTesting } = await import('../server/agent.js');
  const { applyStreamEvent } = agentTesting;

  const assistant = { id: 'a1', role: 'assistant', text: '', toolCalls: [] };
  const sent = [];
  const emit = (event, data) => sent.push([event, data]);

  applyStreamEvent({ type: 'text', delta: 'half a sen' }, assistant, emit);
  check('text accumulates', assistant.text === 'half a sen');

  applyStreamEvent({ type: 'retry', reason: 'key 1 stopped' }, assistant, emit);
  check('a retry empties the draft', assistant.text === '', JSON.stringify(assistant.text));
  check('and tells the browser', sent.some(([event]) => event === 'retry'));

  applyStreamEvent({ type: 'text', delta: 'a whole answer' }, assistant, emit);
  // The point of emptying it: this is what gets persisted, and a draft that
  // kept its discarded half would be stored and then shown as one reply.
  check('the replacement stands alone', assistant.text === 'a whole answer', assistant.text);

  /*
   * The reasoning too. Only the text used to be cleared, so the abandoned
   * attempt's thinking stayed and the next attempt's was appended onto it —
   * stored as one trace that contradicts itself partway through (CODE-018).
   */
  const reasoning = { id: 'a2', role: 'assistant', text: 'half', thinking: 'first attempt reasons one way', toolCalls: [] };
  applyStreamEvent({ type: 'retry', reason: 'key 1 stopped' }, reasoning, () => {});
  check('a retry discards the abandoned reasoning as well', reasoning.thinking === '', JSON.stringify(reasoning.thinking));
}

removeTemp(process.env.DATA_DIR);

// ── not every call in a turn deserves the turn's model ──────────────
section('the roles that transcribe get a cheaper model');
{
  const { modelForRole, __testing: roleTesting } = await import('../server/roleModel.js');
  const { resolveModel } = await import('../server/providers/catalog.js');

  const opus = resolveModel('anthropic/claude-opus-5');
  const haiku = resolveModel('anthropic/claude-haiku-4-5');

  /*
   * A conversation set to Opus is set to Opus because the *answering* is worth
   * it. Folding the older turns into a summary is a writing job — routinely the
   * largest single prompt the account sends — and was being billed at the
   * flagship rate for no benefit anybody could name.
   */
  const forCompaction = await modelForRole('u-nobody', 'compaction', opus, {});
  check('compaction moves off the flagship', forCompaction.id === haiku.id, forCompaction.id);
  check(
    '  and it is genuinely cheaper',
    forCompaction.price.in < opus.price.in,
    `${forCompaction.price.in} < ${opus.price.in}`,
  );

  const forExtract = await modelForRole('u-nobody', 'web_extract', opus, {});
  check('so does reading facts off a page', forExtract.id === haiku.id, forExtract.id);

  /*
   * And the ones that decide do not. This is the half that keeps the feature
   * honest: a cheap model that summarises badly loses the decisions a
   * conversation rests on, so the line is drawn at transcribing versus
   * reasoning rather than wherever the saving is largest.
   */
  for (const role of ['turn', 'subagent', 'research.propose', 'research.arbitrate']) {
    const kept = await modelForRole('u-nobody', role, opus, {});
    check(`${role} keeps the conversation's model`, kept.id === opus.id, kept.id);
  }

  /*
   * Never up. A curated list that routed a small model to a larger one would
   * cost money while claiming to save it, so the swap has to be *provably*
   * cheaper — which also means a provider whose catalogue entries carry no
   * verified price is left alone rather than guessed at.
   */
  const alreadyCheap = await modelForRole('u-nobody', 'compaction', haiku, {});
  check('a conversation already on the small model stays there', alreadyCheap.id === haiku.id);

  const { cheaperThan } = roleTesting;
  check('an unpriced candidate is not a saving', !cheaperThan({ price: null }, opus));
  check('nor is an unpriced current model', !cheaperThan(haiku, { price: null }));
  check('and equal price is not cheaper', !cheaperThan(haiku, haiku));

  /*
   * Routing is an optimisation and sits in the middle of a turn, so it must
   * never be the reason one fails. A provider with no cheap entry, and a broken
   * entry, both fall back to what the conversation was already using.
   */
  const unknownProvider = { id: 'x/y', provider: 'nowhere', price: { in: 99, out: 99 } };
  const fallenBack = await modelForRole('u-nobody', 'compaction', unknownProvider, {});
  check('an unknown provider falls back rather than failing', fallenBack.id === 'x/y');
  check('and a missing entry is survivable', (await modelForRole('u-nobody', 'compaction', null, {})) === null);
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll fallback checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
