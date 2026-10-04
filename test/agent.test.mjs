/**
 * Agent-loop suite — the parts with no network and no browser.
 *
 * Separate from the tenancy suite because the shape of the work is different:
 * this drives the loop with a stubbed provider, rather than running SQL and
 * trying to cross a boundary. Both are fast, so `npm test` runs both.
 *
 * The reason this file exists at all is `run_parallel`. It shipped calling an
 * async generator with `await`, which hands back the generator untouched: no
 * request was ever sent, every sub-agent answered "(no answer)" in zero seconds,
 * and nothing noticed, because nothing tested it.
 *
 *   node test/agent.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'agent-test-encryption-key';
process.env.SESSION_SECRET ||= 'agent-test-session-secret';
// A real store, in a throwaway directory — cheaper and more honest than a hook
// in production code for swapping the store out.
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-agent-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const { hashPassword } = await import('../server/crypto.js');
const { runParallel } = await import('../server/subagents.js');
const { normaliseOrder, needsApproval, runAgent } = await import('../server/agent.js');
const { setPrefs } = await import('../server/settings.js');

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const user = await store.createUser({
  id: 'u-sub',
  email: 'sub@example.com',
  name: 'Sub',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

/**
 * A provider that answers without a network.
 *
 * It can only be reached by iterating it, which is the whole assertion: the old
 * code awaited the generator and therefore never entered this function at all.
 */
function scriptedProvider(turns) {
  const queue = [...turns];
  const seen = { calls: 0, userIds: [], tools: null, system: null };

  const stream = async function* fake(opts) {
    seen.calls += 1;
    seen.userIds.push(opts.userId);
    seen.tools = opts.tools;
    seen.system = opts.system;
    const turn = queue.shift() || { text: '' };
    if (turn.throws) throw new Error(turn.throws);
    if (turn.text) yield { type: 'text', delta: turn.text };
    yield {
      type: 'done',
      stopReason: 'end_turn',
      toolCalls: turn.toolCalls || [],
      usage: { input: 100, output: 40 },
    };
  };
  return { stream, seen };
}

// ── sub-agents actually run ──────────────────────────────────────────
section('sub-agents (run_parallel)');
{
  const { stream, seen } = scriptedProvider([
    { text: 'Answer about the first thing.' },
    { text: 'Answer about the second thing.' },
  ]);

  const output = await runParallel({
    user,
    chatId: null,
    tasks: ['What is in file A?', 'What is in file B?'],
    stream,
  });

  check('the provider was actually driven', seen.calls === 2, `${seen.calls} calls`);
  // This account has linked nothing, so a connector tool could only fail.
  const offeredNames = (seen.tools || []).map((t) => t.name);
  check(
    'a sub-agent is not offered a connector the account has not linked',
    offeredNames.length > 0 && !offeredNames.includes('github') && !offeredNames.includes('notion_search'),
    offeredNames.filter((n) => n === 'github' || n === 'notion_search').join(',') || `${offeredNames.length} tools`,
  );
  check('answers come back, not "(no answer)"', !output.includes('(no answer)'), output.slice(0, 80));
  check('the first answer is present', output.includes('Answer about the first thing.'));
  check('the second answer is present', output.includes('Answer about the second thing.'));
  check(
    'both tasks are labelled',
    output.includes('1. What is in file A?') && output.includes('2. What is in file B?'),
  );
  check('tokens are counted, not zero', /\b280 tokens\b/.test(output), output.split('\n')[0]);

  // The other half of the same bug: the key lookup is scoped by account, and the
  // caller was passing the whole user object where the id belonged.
  check(
    'the account id reaches the provider',
    seen.userIds.every((id) => id === 'u-sub'),
    JSON.stringify(seen.userIds),
  );
}

section('sub-agent spend is recorded');
{
  const usage = await store.usageThisMonth(user.id);
  check('usage was written', usage.tokens === 280, `${usage.tokens} tokens`);
  // The default model is anthropic/claude-opus-5 at $5/$25 per 1M, so 200 in and
  // 80 out is real money — it used to be booked at exactly zero.
  check('and priced rather than booked at zero', usage.cost > 0, `$${usage.cost}`);
}

section('sub-agent limits');
{
  const { stream } = scriptedProvider([]);
  let refused = '';
  try {
    await runParallel({ user, chatId: null, tasks: Array.from({ length: 9 }, (_, i) => `task ${i}`), stream });
  } catch (err) {
    refused = err.message;
  }
  check('more than six tasks is refused', /6 at once is the limit/.test(refused), refused);

  let empty = '';
  try {
    await runParallel({ user, chatId: null, tasks: [], stream });
  } catch (err) {
    empty = err.message;
  }
  check('no tasks at all is refused', /at least one task/.test(empty), empty);
}

section('a failing sub-agent is reported as failed');
{
  const { stream } = scriptedProvider([{ throws: 'the provider fell over' }]);
  const output = await runParallel({ user, chatId: null, tasks: ['anything'], stream });

  check('the failure is surfaced', /Failed: the provider fell over/.test(output), output.slice(0, 90));
  check(
    'and the summary says so rather than implying success',
    /1 of them failed/.test(output),
    output.split('\n')[0],
  );
}

section('sub-agents may only use read-only tools');
{
  // The tool list handed to a sub-agent is already read-only, so a mutating call
  // means the model invented a name. It must be refused rather than executed.
  const { stream } = scriptedProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'y' } }] },
    { text: 'I could not do that, but here is what I found.' },
  ]);

  const output = await runParallel({ user, chatId: null, tasks: ['try to write a file'], stream });
  check(
    'a mutating tool call is not executed',
    output.includes('I could not do that'),
    output.slice(-120),
  );
}

section('a sub-agent cannot start sub-agents');
{
  /*
   * `run_parallel` and `deep_research` are `readOnly`, so `assessRisk` grades
   * them `safe`, and "safe" was the only runtime question a sub-agent's tool
   * call had to answer. `noSubagent` kept them out of the list a sub-agent is
   * *offered* — and nothing checked what it *ran*. A sub-agent that named
   * `run_parallel` anyway started six more, each able to do the same, on the
   * account's own key and with no depth limit (SEC-026).
   *
   * The second provider turn sees the first turn's tool result, so that is where
   * the refusal is read from.
   */
  const seenMessages = [];
  let calls = 0;
  const stream = async function* nesting(opts) {
    calls += 1;
    seenMessages.push(opts.messages);
    if (calls === 1) {
      yield {
        type: 'done',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'n1', name: 'run_parallel', input: { tasks: ['a', 'b', 'c', 'd', 'e', 'f'] } },
          { id: 'n2', name: 'deep_research', input: { question: 'anything' } },
        ],
        usage: { input: 10, output: 5 },
      };
      return;
    }
    yield { type: 'text', delta: 'Reported instead.' };
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 10, output: 5 } };
  };

  const out = await runParallel({ user, chatId: null, tasks: ['fan out further'], stream });
  const toolTurn = (seenMessages[1] || []).find((m) => m.role === 'tool');
  const byName = Object.fromEntries((toolTurn?.results || []).map((r) => [r.name, r]));

  check('run_parallel from inside a sub-agent is refused', byName.run_parallel?.isError === true && /not offered to this sub-agent/.test(byName.run_parallel?.content || ''), byName.run_parallel?.content);
  check('  and so is deep_research', byName.deep_research?.isError === true && /not offered/.test(byName.deep_research?.content || ''), byName.deep_research?.content);
  check('  so the provider was called for this sub-agent only, not for six more', calls === 2, `${calls} calls`);
  check('  and the sub-agent still finishes with its own report', out.includes('Reported instead.'));
}

section('a sub-agent in a project can read the project sources');
{
  /*
   * The report: "Sub-agent (run_parallel) KHÔNG truy cập được nguồn dự án —
   * phải tự gọi search_docs." Sub-agents ran with chatId null, so search_docs
   * could not find the project, and nothing about the shelf was in the task.
   */
  const { addSource } = await import('../server/projects.js');
  const project = await store.createProject(user.id, { id: 'p-sub', name: 'Đầu tư tài chính', instructions: 'Trả lời bằng tiếng Việt.' });
  const text = 'Chapter 1 The Investment Environment. Real assets versus financial assets: the material wealth of a society is determined by its real assets.';
  await addSource(user.id, project.id, { name: 'bkm-ch1.txt', mime: 'text/plain', data: Buffer.from(text).toString('base64') });
  await store.createChat(user.id, { id: 'c-sub-proj', title: 'p', model: 'anthropic/claude-opus-5', projectId: project.id });

  const firsts = [];
  const results = [];
  let calls = 0;
  const stream = async function* projectAware(opts) {
    calls += 1;
    if (calls === 1) {
      firsts.push(opts.messages[0].text);
      yield { type: 'done', stopReason: 'tool_use', toolCalls: [{ id: 's1', name: 'search_docs', input: { query: 'material wealth real assets' } }], usage: { input: 10, output: 5 } };
      return;
    }
    results.push((opts.messages.find((m) => m.role === 'tool')?.results || [])[0]);
    yield { type: 'text', delta: 'Real assets.' };
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 10, output: 5 } };
  };

  await runParallel({ user, chatId: 'c-sub-proj', tasks: ['What determines the material wealth of a society?'], stream });
  check('the sub-agent is told which project it is in', /Đầu tư tài chính/.test(firsts[0] || ''), (firsts[0] || '').slice(0, 120));
  check('  with its instructions and source names', /Trả lời bằng tiếng Việt/.test(firsts[0] || '') && /bkm-ch1\.txt/.test(firsts[0] || ''));
  check('  and the matching passage handed over up front', /material wealth of a society is determined by its real assets/.test(firsts[0] || ''));
  check('  inside the untrusted envelope', /<untrusted/.test(firsts[0] || ''));
  check(
    'its own search_docs reads the project shelf',
    results[0] && !results[0].isError && /real assets/.test(results[0].content || ''),
    String(results[0]?.content || '').slice(0, 120),
  );

  const outside = [];
  const plain = async function* noProject(opts) {
    outside.push(opts.messages[0].text);
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 1, output: 1 } };
  };
  await runParallel({ user, chatId: null, tasks: ['just the task'], stream: plain });
  check('outside a project the task is sent as it was', outside[0] === 'just the task', outside[0]);
}

// ── the transcript reordering the main loop depends on ───────────────
section('normaliseOrder edge cases');
{
  const messy = normaliseOrder([
    { id: '1', role: 'user' },
    { id: '2', role: 'assistant', toolCalls: [{ id: 'a' }] },
    { id: '3', role: 'user', text: 'wait' },
    { id: '4', role: 'tool', results: [] },
    { id: '5', role: 'assistant', toolCalls: [{ id: 'b' }] },
    { id: '6', role: 'tool', results: [] },
  ]);
  check(
    'each tool message still follows its own call',
    messy.map((m) => m.role).join(',') === 'user,assistant,tool,user,assistant,tool',
    messy.map((m) => m.role).join(','),
  );
  check('nothing is dropped', messy.length === 6);

  // A call the conversation moved on from — an approval nobody gave, then a new
  // message — gets a "not run" result, because every strict provider rejects a
  // call with no result after it. The later message is kept.
  const truncated = normaliseOrder([
    { id: '1', role: 'assistant', toolCalls: [{ id: 'a', name: 'send_email' }] },
    { id: '2', role: 'user', text: 'still here?' },
  ]);
  check(
    'an abandoned call is answered as not run, and the later message kept',
    truncated.map((m) => m.id).join(',') === '1,1:not-run,2',
    truncated.map((m) => m.id).join(','),
  );
  check('  the answer names the call and does not claim it ran', truncated[1].results[0].toolCallId === 'a' && /Not run/.test(truncated[1].results[0].content));

  // The case that broke scheduled tasks: two paused runs, one conversation. The
  // second call must not be paired with a result that belongs to the first.
  const twoRuns = normaliseOrder([
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant', toolCalls: [{ id: 'x' }] },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant', toolCalls: [{ id: 'y' }] },
    { id: 't2', role: 'tool', results: [{ toolCallId: 'y' }] },
  ]);
  check('each call keeps its own result', twoRuns.map((m) => m.id).join(',') === 'u1,a1,a1:not-run,u2,a2,t2', twoRuns.map((m) => m.id).join(','));

  // A call at the very end is the resume path's, not this function's.
  const pending = normaliseOrder([{ id: '1', role: 'user' }, { id: '2', role: 'assistant', toolCalls: [{ id: 'a' }] }]);
  check('a pending call at the end is left for the resume path', pending.length === 2);
  check('an empty transcript is fine', normaliseOrder([]).length === 0);
}

// ── keeping a long conversation inside the window ───────────────────
section('look_at with nothing named looks at what was just attached');
{
  // The report: "what is this picture?" with a screenshot attached; the model
  // called look_at with only a question and got a red card.
  const { executeTool } = await import('../server/tools/execute.js');
  const chat = await store.createChat(user.id, { id: 'c-look', title: 'look', model: 'anthropic/claude-opus-5' });
  await store.appendMessage(user.id, chat.id, {
    id: 'u-look',
    role: 'user',
    text: 'cái này là ảnh gì',
    attachments: [{ id: 'att-look', name: 'shot.png', kind: 'image', mime: 'image/png' }],
  });
  const out = await executeTool({ user, name: 'look_at', input: { question: 'Mô tả ảnh này' }, chatId: chat.id });
  check('it is not an error', !out.isError, out.content.slice(0, 120));
  check('a model that can see is told the picture is already in front of it — no second model paid for', /already in front of you/.test(out.content), out.content.slice(0, 120));
  const none = await executeTool({ user, name: 'look_at', input: { question: 'x' }, chatId: null });
  check('with nothing attached anywhere it still says what to give', none.isError && /file_id/.test(none.content));
}

section('measuring how full the window is');
{
  const { measure } = await import('../server/compact.js');
  const entry = { context: 100_000 };

  const empty = measure([], entry, { maxOutput: 10_000 });
  check('an empty conversation uses nothing', empty.used === 0 && empty.ratio === 0);
  check('and the budget leaves room for the reply', empty.budget === 90_000, String(empty.budget));

  // The report: a model listed at 1M with an output cap of 1M showed "of 500K",
  // because half the window was kept back for one reply.
  const million = measure([], { context: 1_000_000, maxOutput: 1_000_000 });
  check('a 1M window keeps back one reply\'s room, not half of itself', million.budget === 1_000_000 - 64_000, String(million.budget));
  check('  and reports the whole window', million.context === 1_000_000);

  // The honest number comes from the provider: every assistant turn records the
  // prompt size it was actually billed for.
  const counted = measure(
    [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi', usage: { input: 45_000, output: 100 } },
    ],
    entry,
    { maxOutput: 10_000 },
  );
  check('a real usage figure is used verbatim', counted.used === 45_000, String(counted.used));
  check('and is marked exact', counted.exact === true);
  check('half the budget reads as half', Math.abs(counted.ratio - 0.5) < 0.01, String(counted.ratio));

  // Anything after the last counted turn is estimated, because nobody has
  // counted it yet.
  const withTail = measure(
    [
      { role: 'assistant', text: 'hi', usage: { input: 45_000 } },
      { role: 'user', text: 'x'.repeat(4000) },
    ],
    entry,
    { maxOutput: 10_000 },
  );
  check('the tail is estimated on top', withTail.used > 45_000, String(withTail.used));
  check('and it says the number is not exact', withTail.exact === false);

  // A model that never said how big its window is still gets a gauge.
  const unknown = measure([{ role: 'assistant', usage: { input: 1000 } }], {}, { maxOutput: 1000 });
  check('an unknown window falls back rather than dividing by nothing', unknown.context > 0, String(unknown.context));

  // Images are not characters, and pretending a screenshot is free would make
  // the gauge lie exactly when it matters.
  const withImage = measure(
    [{ role: 'user', text: 'look', attachments: [{ kind: 'image' }] }],
    entry,
    { maxOutput: 10_000 },
  );
  check('an image costs something', withImage.used > 500, String(withImage.used));
}

section('deciding when to fold');
{
  const { shouldCompact } = await import('../server/compact.js');
  const entry = { context: 100_000 };
  const filler = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));

  const roomy = [...filler, { role: 'assistant', usage: { input: 20_000 } }];
  check('a conversation with room is left alone', shouldCompact(roomy, entry, { maxOutput: 10_000 }) === false);

  const full = [...filler, { role: 'assistant', usage: { input: 85_000 } }];
  check('a nearly full one is folded', shouldCompact(full, entry, { maxOutput: 10_000 }) === true);

  // Nothing to gain from summarising a conversation that is almost all tail.
  const shortButFull = [{ role: 'assistant', usage: { input: 89_000 } }];
  check(
    'a short conversation is never folded, however full',
    shouldCompact(shortButFull, entry, { maxOutput: 10_000 }) === false,
    'there would be nothing left to keep',
  );

  /*
   * After a fold, the last billed figure describes a transcript that no longer
   * exists. Read as current, it kept the ring full until the next reply and
   * folded again every turn — 27 messages, then 7, then 3.
   */
  const { measure } = await import('../server/compact.js');
  const seqd = full.map((m, i) => ({ ...m, seq: i + 1 }));
  const afterFold = [...seqd, { role: 'summary', text: 'short summary', replaced: 5, covers: 5, seq: seqd.length + 1 }];
  const before = measure(seqd, entry, { maxOutput: 10_000 }).ratio;
  const after = measure(afterFold, entry, { maxOutput: 10_000 }).ratio;
  check('the ring drops the moment a fold lands', after < 0.1 && before > 0.8, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  check('and it is not folded again straight away', shouldCompact(afterFold, entry, { maxOutput: 10_000 }) === false);
}

section('the fold never splits a tool call from its result');
{
  const { tailStart } = await import('../server/compact.js');

  // Every provider rejects a `tool` message whose call it cannot see, so a
  // boundary in the wrong place turns a working conversation into a 400.
  const messages = [
    { role: 'user', text: 'a' },
    { role: 'assistant', toolCalls: [{ id: '1' }] },
    { role: 'tool', results: [] },
    { role: 'assistant', toolCalls: [{ id: '2' }] },
    { role: 'tool', results: [] },
    { role: 'assistant', text: 'done' },
  ];

  for (let keep = 1; keep <= messages.length; keep += 1) {
    const start = tailStart(messages, keep);
    if (messages[start]?.role === 'tool') {
      check(`keep=${keep} never starts the tail on a tool result`, false, `start=${start}`);
    }
  }
  check('no keep length produces an orphaned tool result', true, 'checked every boundary');

  check('the boundary walks back past a tool message', tailStart(messages, 2) === 3, String(tailStart(messages, 2)));
  check('and keeps the whole thing when asked for more than there is', tailStart(messages, 99) === 0);
}

section('what the model is sent after a fold');
{
  const { activeTranscript } = await import('../server/compact.js');

  const plain = [
    { id: '1', role: 'user', text: 'a' },
    { id: '2', role: 'assistant', text: 'b' },
  ];
  check('with no summary, everything is sent', activeTranscript(plain).length === 2);

  const folded = [
    { id: '1', role: 'user', text: 'old thing' },
    { id: '2', role: 'assistant', text: 'old reply' },
    { id: '3', role: 'summary', text: 'They asked about X. The file is src/app.js.' },
    { id: '4', role: 'user', text: 'carry on' },
  ];
  const sent = activeTranscript(folded);
  check('after a fold, the old turns are not sent', sent.length === 2, `${sent.length} messages`);
  check('the summary comes first', sent[0].role === 'user' && /src\/app\.js/.test(sent[0].text));
  check('framed so the model knows what it is', /folded up to save room/.test(sent[0].text));
  check('and what followed is sent verbatim', sent[1].text === 'carry on');

  // Compacting again must summarise the previous summary too, or the cost grows
  // with every fold instead of staying flat.
  const twice = [
    ...folded,
    { id: '5', role: 'summary', text: 'Second summary covering everything above.' },
    { id: '6', role: 'user', text: 'and now this' },
  ];
  const again = activeTranscript(twice);
  check('a second fold supersedes the first', again.length === 2, `${again.length} messages`);
  check('using the newer summary', /Second summary/.test(again[0].text));

  /**
   * The shape the loop actually produces — which is not the shape above.
   *
   * Every case before this one hands `activeTranscript` a summary sitting in the
   * middle of the array, and against that input the function is correct. The
   * agent loop never builds that. `compact()` summarises `live.slice(0, tailStart)`
   * — deliberately leaving the last eight turns out — and then **appends** the
   * summary, both to the store (`MAX(seq)+1`) and to the in-memory array. So the
   * summary is the last element, `slice(last + 1)` is empty, and the model was
   * sent the summary and nothing else: not the kept turns, and not the question
   * the user had just asked.
   *
   * The function was tested, correctly, against an input the system does not
   * generate. That is the whole reason this survived.
   *
   * `covers` is what fixes it: the `seq` of the newest message the summary
   * stands for. The tail is then everything newer than that, wherever the
   * summary happens to sit.
   */
  const appended = [
    { id: 'm1', seq: 1, role: 'user', text: 'old question' },
    { id: 'm2', seq: 2, role: 'assistant', text: 'old answer' },
    { id: 'm3', seq: 3, role: 'user', text: 'kept turn' },
    { id: 'm4', seq: 4, role: 'assistant', text: 'kept reply' },
    { id: 'm5', seq: 5, role: 'user', text: 'THE QUESTION JUST ASKED' },
    { id: 's1', seq: 6, role: 'summary', covers: 2, text: 'Summary of the first two turns.' },
  ];
  const live = activeTranscript(appended);
  check(
    'a summary appended last still sends the turns it does not cover',
    live.length === 4,
    `${live.length} messages`,
  );
  check(
    'including the question the user just asked',
    live.some((m) => m.text === 'THE QUESTION JUST ASKED'),
  );
  check('the summary still leads', /Summary of the first two turns/.test(live[0].text));
  check(
    'and the turns it does cover are gone',
    !live.some((m) => m.text === 'old question' || m.text === 'old answer'),
  );

  // Chaining has to keep working: the newer summary supersedes the older one,
  // and the older one is older than `covers`, so it drops out by the same rule.
  const chained = [
    ...appended,
    { id: 'm6', seq: 7, role: 'assistant', text: 'reply to it' },
    { id: 's2', seq: 8, role: 'summary', covers: 6, text: 'Second summary.' },
    { id: 'm7', seq: 9, role: 'user', text: 'newest' },
  ];
  const rolled = activeTranscript(chained);
  check('a chained fold keeps only what the newest summary leaves', rolled.length === 3, `${rolled.length}`);
  check('and it is the newest summary that leads', /Second summary/.test(rolled[0].text));
  check('the first summary is not sent twice', !rolled.some((m) => /first two turns/.test(m.text)));
}

section('folding a conversation');
{
  const { compact, activeTranscript } = await import('../server/compact.js');
  const chat = await store.createChat(user.id, { id: 'c-compact', title: 'Long one', model: 'm' });

  const messages = [];
  for (let i = 0; i < 14; i += 1) {
    // `seq` because that is what `listMessages` returns and what the loop holds.
    // Without it this array is not the shape production hands to `compact()`,
    // and a test built on a shape the system does not produce is how the fold
    // bug above went unseen through four audit rounds.
    messages.push({ id: `m${i}`, seq: i, role: i % 2 ? 'assistant' : 'user', text: `turn number ${i}` });
  }

  const { stream, seen } = scriptedProvider([{ text: 'They worked through fourteen turns about X.' }]);
  const summary = await compact({
    userId: user.id,
    chatId: chat.id,
    entry: { id: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'x', context: 100_000 },
    prefs: { effort: 'high' },
    messages,
    stream,
  });

  check('a summary is produced', !!summary, JSON.stringify(summary).slice(0, 80));
  check('by actually calling the model', seen.calls === 1, `${seen.calls} calls`);
  check('it is a message of its own', summary.role === 'summary');
  check('carrying the text', /fourteen turns/.test(summary.text));
  check('and saying how much it stands in for', summary.replaced === 6, String(summary.replaced));
  check('and where it stops, by seq', summary.covers === 5, String(summary.covers));

  /**
   * The end-to-end check, driven the way `agent.js` drives it.
   *
   * The unit tests above prove `activeTranscript` handles an appended summary.
   * This proves the two halves agree: the real `compact()` output, pushed onto
   * the real array exactly as the loop pushes it, still sends the turns the
   * summary deliberately did not cover — and above all the newest one, which is
   * the question the user is waiting on an answer to.
   */
  messages.push(summary);
  const sentToModel = activeTranscript(messages);
  check(
    'after a real fold the model still gets the turns it kept',
    sentToModel.length === 9,
    `${sentToModel.length} messages`,
  );
  check(
    'and the newest turn is among them',
    sentToModel.some((m) => m.text === 'turn number 13'),
  );
  check('with the summary leading', /fourteen turns/.test(sentToModel[0].text));

  const saved = await store.listMessages(user.id, chat.id);
  check('it is written into the conversation', saved.some((m) => m.role === 'summary'));
  check(
    'and the boundary survives the round trip through the store',
    saved.find((m) => m.role === 'summary')?.covers === 5,
  );
  check(
    'the summariser gets no tools — it is a writing job',
    seen.tools?.length === 0,
    JSON.stringify(seen.tools),
  );

  // Nothing to fold is not a failure.
  const { stream: s2 } = scriptedProvider([{ text: 'nope' }]);
  const nothing = await compact({
    userId: user.id,
    chatId: chat.id,
    entry: { context: 100_000 },
    prefs: {},
    messages: [{ id: 'x', role: 'user', text: 'only one' }],
    stream: s2,
  });
  check('a short conversation folds to nothing, quietly', nothing === null);
}

section('approval gating by policy');
{
  const calls = [
    { id: '1', name: 'read_file', input: { path: 'a.txt' } },
    { id: '2', name: 'write_file', input: { path: 'a.txt' } },
    { id: '3', name: 'run_command', input: { command: 'rm -rf build' } },
  ];
  const ids = (policy) => needsApproval(calls, policy).map((c) => c.id).join(',');

  check('auto gates nothing', ids('auto') === '');
  check('readonly gates nothing (those tools were never offered)', ids('readonly') === '');
  check('guarded gates only the destructive one', ids('guarded') === '3', ids('guarded'));
  check('ask gates everything that changes anything', ids('ask') === '2,3', ids('ask'));
  check('plan gates nothing either — it is readonly with a brief', ids('plan') === '');

  /**
   * An approval has to be an answer to the batch it was shown for.
   *
   * `decision` used to be a bare word, applied to whatever was outstanding when
   * the resume arrived. Almost always the same batch — and the app mirrors
   * across tabs, so a turn started in a second tab leaves a *different* batch
   * waiting, and a click on the first tab's prompt approved calls nobody had
   * been shown. The prompt lists every call and its arguments so the decision is
   * informed; letting it land on another set makes that display decorative.
   */
  const { answersTheseCalls } = await import('../server/agent.js');

  check('the ids it was shown answer it', answersTheseCalls(calls, ['1', '2', '3']));
  check('  in any order, because a set is not a list', answersTheseCalls(calls, ['3', '1', '2']));
  check('  a different batch does not', !answersTheseCalls(calls, ['1', '2', '9']));
  check('  nor a subset of it', !answersTheseCalls(calls, ['1', '2']));
  check('  nor a superset', !answersTheseCalls(calls, ['1', '2', '3', '4']));
  check('  and an answer naming nothing does not answer anything', !answersTheseCalls(calls, undefined));
  check('  including an empty list against pending calls', !answersTheseCalls(calls, []));
  // Ids arrive as JSON and a provider may number them; comparing as strings is
  // what stops 1 and '1' being two different calls.
  check('numeric ids still match their string form', answersTheseCalls([{ id: 1 }, { id: 2 }], ['1', '2']));
}

section('planning mode is offered the reading tools and nothing else');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const forPolicy = (policy) =>
    availableTools({ workerOnline: true, desktopOnline: false, policy }).map((t) => t.name);

  const plan = forPolicy('plan');
  check('nothing that writes is even advertised', !plan.some((n) => /write|edit|delete|move/.test(n)), plan.join(' '));
  check('it can still read files', plan.includes('read_file'));
  // The one tool the mode exists to produce output with. It is read-only, so it
  // survives the filter — but only by accident unless something checks.
  check('and still keep a plan in front of the user', plan.includes('update_plan'));
  check('same set as read-only', plan.join() === forPolicy('readonly').join());
  check('while guarded keeps the full set', forPolicy('guarded').length > plan.length);
}

// ── asking a model for more output than it has ──────────────────────
//
// Every adapter defaulted to 32000 and nothing ever passed anything else, so a
// request to `ai21/jamba-large-1.7` (4096) asked for eight times its published
// limit, and a request to `openai/gpt-4` asked for four times its entire
// 8191-token window. Forty-five of the models in the catalogue cap below 32000.
section('output budget follows the model');
{
  const { __testing } = await import('../server/providers/index.js');
  const { resolveModel } = await import('../server/providers/catalog.js');
  const { outputBudget } = __testing;

  const shared = (row) =>
    resolveModel('openrouter/x/y', { id: 'openrouter/x/y', provider: 'openrouter', model: 'x/y', ...row });

  check(
    'a published cap is respected rather than overshot',
    outputBudget(shared({ context: 256_000, max_output: 4096 })) === 4096,
    String(outputBudget(shared({ context: 256_000, max_output: 4096 }))),
  );
  check(
    'a model that publishes more than 32000 gets it',
    outputBudget(shared({ context: 1_000_000, max_output: 65_536 })) === 65_536,
  );

  // No published cap: derived from the window, because the two numbers are
  // unrelated and a constant gets it wrong in both directions.
  const gpt4 = shared({ context: 8191, max_output: null });
  check('an unpublished cap is derived from the window', gpt4.maxOutput === 4095, String(gpt4.maxOutput));
  check(
    'and never exceeds the window it shares with the prompt',
    outputBudget(gpt4) <= 8191 - 1024,
    String(outputBudget(gpt4)),
  );

  /*
   * An entry that states neither figure is the one case that used to get the
   * flat 32000 back, unclamped — the exact hard-coded number `new-provider.md`
   * forbids, and for the reason it gives: `openai/gpt-4` has an 8,191-token
   * *total* window, so asking for 32000 asks for four times everything it has.
   *
   * First-party entries carry both fields and never took this path. Sparse
   * metadata is what arrives from the aggregators, which are the two providers
   * this app is built around — so the branch with no information is the one
   * most likely to be taken.
   */
  /*
   * Through `resolveModel`, not only with a raw object. The first version of
   * this fix was tested on hand-built entries, and both real paths still handed
   * back 32000: `derivedMaxOutput` and the hand-typed branch each materialised
   * "unknown" as a stated 32000 before `outputBudget` saw the entry (PERF-013).
   */
  const sparse = resolveModel('openrouter/some/model', { id: 'openrouter/some/model', provider: 'openrouter', model: 'some/model', context: null, max_output: null });
  check('an aggregator row with no window or cap resolves to no stated cap', sparse.maxOutput === null, String(sparse.maxOutput));
  check('  and gets the cautious budget, not 32000', outputBudget(sparse) === 4096, String(outputBudget(sparse)));
  const handTyped = resolveModel('openai/some-model-nobody-listed');
  check('a hand-typed model id gets the cautious budget too', outputBudget(handTyped) === 4096, String(outputBudget(handTyped)));

  /*
   * A retiring built-in keeps working until its shutdown date, then resolves to
   * its replacement. o4-mini shuts down on 2026-10-23 (OpenAI's deprecations
   * page); switching before then would move somebody off the cheaper model they
   * chose for no reason, and not switching after it is an error on every turn.
   */
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-22T12:00:00Z');
    const before = resolveModel('openai/o4-mini');
    check('before its shutdown date a retiring model still resolves to itself', before.model === 'o4-mini' && !before.retiredFrom);
    Date.now = () => Date.parse('2026-10-23T00:00:01Z');
    const after = resolveModel('openai/o4-mini');
    check('  and from the date it resolves to the replacement', after.model === 'gpt-5.6-terra', after.model);
    check('  saying which model it replaced, so the loop can announce it', after.retiredFrom === 'openai/o4-mini');
    check('  with the replacement\'s own verified limits', after.context === 1_050_000 && after.maxOutput === 128_000);
  } finally {
    Date.now = realNow;
  }

  // The reply shares the window with the prompt actually being sent. A cap
  // published at 90% of the window, on an 80,000-token conversation, is what
  // came back from the provider as a 400.
  {
    const nearlyWhole = { context: 262_144, maxOutput: 235_929 };
    const budget = outputBudget(nearlyWhole, 80_000);
    check('the reply is fitted beside the prompt', budget + 80_000 <= 262_144, String(budget));
    check('  and still gets everything left', budget === 262_144 - 80_000 - 1024, String(budget));
    check('  a small prompt leaves the published cap alone', outputBudget(nearlyWhole, 1000) === 235_929);
    const { estimatePromptTokens } = __testing;
    const picture = 'A'.repeat(900_000);
    const est = estimatePromptTokens({ system: 'x'.repeat(3000), messages: [{ content: [{ data: picture }] }] });
    check('  a pasted picture is not counted by its base64', est < 3000, String(est));
  }

  const unknown = outputBudget({ id: 'openrouter/mystery/model', provider: 'openrouter' });
  check('an entry that states nothing gets a cautious cap', unknown === 4096, String(unknown));
  check('  not the flat 32000 that fits in no small window', unknown !== 32_000);
  check(
    '  while a stated cap with no window is still honoured',
    outputBudget({ maxOutput: 16_000 }) === 16_000,
    String(outputBudget({ maxOutput: 16_000 })),
  );

  /*
   * Built-ins carry their own figure and must be untouched by any of this.
   *
   * The number moved once already — Opus was being cut to a flat 32000, so long
   * documents were truncated — and it has moved again for the same reason. The
   * catalogue said 64000 where the model allows 128000, and `outputBudget`
   * faithfully clamped a long report to half of what could have been written.
   * The condition attached to asking for an output that large is streaming, and
   * the adapter streams.
   */
  check(
    'Claude Opus is offered the full 128000 the model allows',
    outputBudget(resolveModel('anthropic/claude-opus-5')) === 128_000,
    String(outputBudget(resolveModel('anthropic/claude-opus-5'))),
  );
  check(
    'and so is Sonnet 5',
    outputBudget(resolveModel('anthropic/claude-sonnet-5')) === 128_000,
    String(outputBudget(resolveModel('anthropic/claude-sonnet-5'))),
  );
  /*
   * This asserted 32000 and now asserts 4096 — a deliberate reversal, so here
   * is why rather than a quiet edit.
   *
   * 32000 is the one number `.claude/commands/new-provider.md` forbids by name,
   * and for the reason it gives: `openai/gpt-4` has an 8,191-token *total*
   * window, so asking it for 32000 asks for four times everything it has. The
   * clamp a few lines up exists to prevent exactly that and was skipped on this
   * branch, which is the branch taken when nothing is known about the model.
   *
   * Both directions cost something, and they do not cost the same. Too small
   * truncates a reply that could have been longer — visible, and the user can
   * ask for more. Too large is a request the provider rejects outright, and the
   * turn produces nothing at all. 4096 is the smallest ceiling in common use
   * and fits inside every window this app has met.
   */
  check('a model that states nothing gets the cautious cap, not the flat one', outputBudget({}) === 4_096, String(outputBudget({})));
}

// ── the compaction budget on a small window ─────────────────────────
//
// `measure` reserved a flat 32000 for the reply, so any model whose whole window
// was smaller got `max(1, 8191 - 32000)` — a budget of one token. Every
// conversation then read as 100% full from its first message, and auto-compaction
// (on by default) summarised the whole transcript on every single turn: an extra
// model call each time, spending tokens to save them.
section('a small window does not compact on every turn');
{
  const { measure, shouldCompact } = await import('../server/compact.js');
  const { resolveModel } = await import('../server/providers/catalog.js');
  const small = (context) =>
    resolveModel('openrouter/x/y', {
      id: 'openrouter/x/y', provider: 'openrouter', model: 'x/y', context, max_output: null,
    });

  for (const context of [4095, 8191, 16_385, 32_768]) {
    const opening = measure([{ role: 'user', text: 'hello' }], small(context));
    check(
      `a ${context}-token window leaves room to work in`,
      opening.budget > 1 && opening.ratio < 0.1,
      `budget ${opening.budget}, ratio ${opening.ratio}`,
    );
  }

  const filler = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));
  check('a fresh conversation on a small model is not folded', shouldCompact([...filler], small(8191)) === false);
  // And it still folds when it genuinely is full, or the mechanism is simply off.
  check(
    'but a genuinely full one still is',
    shouldCompact([...filler, { role: 'assistant', usage: { input: 4000 } }], small(8191)) === true,
  );
}

// ── what the catalogue costs to advertise ───────────────────────────
section('the tool catalogue is cut to fit a small window');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const base = { workerOnline: true, desktopOnline: true, policy: 'guarded' };
  const cost = (tools) =>
    JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;

  // The windows here are chosen against the *share* the catalogue takes, which
  // is what decides the cut now — an absolute 32k used to mean "trim only", and
  // with a catalogue this size 32k is genuinely crowded, so it drops as well.
  // test/toolbudget.test.mjs pins the share rule itself.
  const roomy = availableTools({ ...base, context: 1_000_000 });
  const tight = availableTools({ ...base, context: 60_000 });
  const tiny = availableTools({ ...base, context: 8191 });

  check('a crowded window gets shorter descriptions', cost(tight) < cost(roomy), `${cost(tight)} vs ${cost(roomy)}`);
  check('a tiny one drops the secondary tools too', tiny.length < tight.length, `${tiny.length} vs ${tight.length}`);
  /*
   * `create_file` used to be on this list and is deliberately no longer: writing
   * a document is a real job and a rare one, so it is deferred and loaded on
   * request. The tools here are the ones a turn needs *immediately* — an extra
   * round trip before reading a file would be absurd. test/toolbudget.test.mjs
   * pins which side of that line every tool falls on.
   */
  check(
    'but never the core loop',
    ['read_file', 'write_file', 'run_command', 'web_search', 'update_plan'].every((n) =>
      tiny.some((t) => t.name === n),
    ),
    tiny.map((t) => t.name).join(' '),
  );
  check(
    'and a deferred tool is offered rather than lost',
    tiny.some((t) => t.name === 'load_tools'),
    'the model can still ask for anything held back',
  );
  check('an unknown window is not treated as no room', cost(availableTools({ ...base })) === cost(roomy));

  // A connector tool whose service is not linked can only fail, and its schema
  // was paid for on every request by every account regardless.
  const none = availableTools({ ...base, connected: [] }).map((t) => t.name);
  check('an unlinked connector is not advertised', !none.includes('slack_post') && !none.includes('github'));
  const slack = availableTools({ ...base, connected: ['slack'] }).map((t) => t.name);
  check('a linked one is', slack.includes('slack_post') && !slack.includes('notion_search'));
  check(
    'omitting the list keeps them all, rather than guessing at none',
    availableTools({ ...base }).some((t) => t.name === 'github'),
  );
}

// ── the transcript is cached, not just the system prompt ────────────
section('Anthropic caches the part of the conversation that repeats');
{
  const { __testing } = await import('../server/providers/anthropic.js');
  const { toMessages, withCachePoint } = __testing;

  // The array a replayed assistant turn comes from is the one held in the
  // database. Writing a wire detail into it would persist it, and then send it
  // again next turn in the wrong place.
  const stored = [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }];
  const wire = withCachePoint(
    toMessages([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'a', raw: { anthropic: stored } },
      { role: 'tool', results: [{ toolCallId: 't1', name: 'read_file', content: 'body' }] },
      { role: 'user', text: 'newest' },
    ]),
  );
  const cached = (m) => (m.content || []).some((b) => b.cache_control);

  check('the reusable prefix carries a breakpoint', cached(wire[wire.length - 2]));
  check('the newest turn does not — it would never be read back', !cached(wire[wire.length - 1]));
  check('the stored transcript is left alone', !JSON.stringify(stored).includes('cache_control'));
  check(
    'a one-message conversation is a no-op, not a crash',
    withCachePoint(toMessages([{ role: 'user', text: 'hi' }])).length === 1,
  );
  check('and an empty one too', withCachePoint([]).length === 0);
}

// ── the counterparts that were missing ──────────────────────────────
//
// Each of these let the model do half a job and then stop: write a note it could
// never remove, schedule work it could never see or cancel, drive a browser with
// no Back button, set every field on a form except a dropdown.
section('every tool has its counterpart');
{
  const { TOOLS } = await import('../server/tools/definitions.js');
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');

  const declared = new Set(TOOLS.map((t) => t.name));
  const implemented = new Set([...Object.keys(CLOUD_IMPLEMENTATIONS), ...Object.keys(LOCAL_IMPLEMENTATIONS)]);

  for (const name of [
    'memory_delete', 'list_tasks', 'cancel_task',
    'browser_back', 'browser_forward', 'browser_select', 'browser_hover',
    'multi_edit',
  ]) {
    check(`${name} is declared and implemented`, declared.has(name) && implemented.has(name));
  }

  // The whole reason a tool can be advertised and then fail with "no
  // implementation" is that these two lists are maintained by hand.
  const orphanDeclared = [...declared].filter((n) => !implemented.has(n));
  const orphanImplemented = [...implemented].filter((n) => !declared.has(n));
  check('no tool is advertised without an implementation', orphanDeclared.length === 0, orphanDeclared.join(' '));
  check('and none is implemented without being declared', orphanImplemented.length === 0, orphanImplemented.join(' '));
}

// ── the plan panel ──────────────────────────────────────────────────
/**
 * The plan is the one piece of the interface the model draws directly, so what
 * it sends is normalised rather than trusted — and the *decision* to draw one at
 * all is half the feature. A checklist above a two-line answer is not a smaller
 * version of a good plan, it is noise the user has to read first.
 */
const { normalisePlan, PLAN_MIN_STEPS, CLOUD_IMPLEMENTATIONS } = await import(
  '../server/tools/cloud.js'
);
const planTitles = (steps) => steps.map((s) => `${s.title}:${s.status}`).join(' ');

section('the plan is normalised before anybody sees it');
{
  const clean = normalisePlan([
    { title: 'Read the corpus', status: 'done' },
    { title: 'Recompute co-occurrence', status: 'in_progress' },
    { title: 'Rebuild Figure 27', status: 'pending' },
  ]);
  check(
    'a well-formed plan passes through unchanged',
    planTitles(clean) ===
      'Read the corpus:done Recompute co-occurrence:in_progress Rebuild Figure 27:pending',
    planTitles(clean),
  );

  // Models mark three things started at once, and then the panel cannot answer
  // the only question it exists to answer: where are you now.
  const many = normalisePlan([
    { title: 'One', status: 'in_progress' },
    { title: 'Two', status: 'in_progress' },
    { title: 'Three', status: 'in_progress' },
  ]);
  check(
    'only the first in_progress survives',
    many.filter((s) => s.status === 'in_progress').length === 1,
    planTitles(many),
  );
  check('and the rest go back to pending, not away', many.length === 3, planTitles(many));

  const junk = normalisePlan([
    { title: '  Padded  ', status: 'nonsense' },
    { title: '', status: 'done' },
    null,
    { status: 'done' },
    { title: 'Kept', status: 'done' },
  ]);
  check('an unknown status falls back to pending', junk[0]?.status === 'pending', planTitles(junk));
  check('titles are trimmed', junk[0]?.title === 'Padded');
  check('untitled and malformed steps are dropped', junk.length === 2, planTitles(junk));
  check('a non-array is not a crash', normalisePlan(undefined).length === 0);
}

section('a job too short to plan draws nothing');
{
  check('the floor is at least two steps', PLAN_MIN_STEPS >= 2, String(PLAN_MIN_STEPS));

  // The agent loop's own condition, so this fails if the two ever drift apart.
  const drawn = (steps) => normalisePlan(steps).length >= PLAN_MIN_STEPS;
  check('one step is not a plan', !drawn([{ title: 'Do the thing', status: 'in_progress' }]));
  check('nor is an empty list', !drawn([]));
  check(
    'two steps are',
    drawn([
      { title: 'Read', status: 'done' },
      { title: 'Write', status: 'in_progress' },
    ]),
  );

  const short = await CLOUD_IMPLEMENTATIONS.update_plan({
    steps: [{ title: 'Answer the question', status: 'in_progress' }],
  });
  // Silently answering "Plan updated" would teach the model to keep sending a
  // plan nobody is drawing, and to describe a checklist the user cannot see.
  check('the model is told no plan was shown', /no plan was shown/i.test(short), short);
  check('and told to just answer instead', /answer directly/i.test(short), short);

  const real = await CLOUD_IMPLEMENTATIONS.update_plan({
    steps: [
      { title: 'Read the corpus', status: 'done' },
      { title: 'Rebuild Figure 27', status: 'in_progress' },
      { title: 'Verify the document', status: 'pending' },
    ],
  });
  check('a real plan reports its progress', /1\/3 done/.test(real), real);
  check('and names the step it is on', /Rebuild Figure 27/.test(real), real);
}

section('the model is told both when to plan and when not to');
{
  // Read as source rather than through the builder, which is not exported. The
  // point is that neither half of the rule can be deleted without a test going
  // red — the previous version said when to plan and never when to stop, which
  // is what made it plan for everything, or for nothing.
  const agentSrc = fs.readFileSync(new URL('../server/agent.js', import.meta.url), 'utf8');
  check('the prompt says when to plan', /\*\*Plan when/.test(agentSrc));
  check('and, just as explicitly, when not to', /\*\*Do not plan when/.test(agentSrc));
  check('with a countable threshold rather than an adjective', /three or more steps/.test(agentSrc));
  check('it asks for one in_progress at a time', /one step `in_progress`/.test(agentSrc));
  check('and for the plan to be revised when reality differs', /resend the list/i.test(agentSrc));

  // On a model under 40k only the first sentence of a description survives, so
  // the threshold has to sit inside it rather than trailing after.
  const toolSrc = fs.readFileSync(
    new URL('../server/tools/definitions.js', import.meta.url),
    'utf8',
  );
  const desc = toolSrc.match(/'Show the user a live checklist[^']*'/)?.[0] || '';
  const firstSentence = desc.match(/^'.*?\./)?.[0] || '';
  check('the tool description carries the threshold too', /three or more steps/.test(desc));
  check(
    'and carries it in the first sentence, the one that survives trimming',
    /three or more/.test(firstSentence),
    firstSentence,
  );
}

// ── a provider that has not answered says so ────────────────────────
section('waiting is told apart from thinking');
{
  const { __testing: agentTesting } = await import('../server/agent.js');

  /*
   * "Thinking…" was shown from the moment the request left, and stayed there
   * whether the model was producing reasoning tokens or had not been given a
   * slot. Those look identical and need different reactions: one is working,
   * the other is a queue you may not want to wait in. A free model on a busy
   * aggregator sits unanswered for a minute often enough that the silence reads
   * as a broken app.
   */
  check('there is a threshold before anything is said', agentTesting.WAIT_NOTICE_MS > 0);
  check(
    '  long enough that a fast reply is never narrated',
    agentTesting.WAIT_NOTICE_MS >= 4000,
    `${agentTesting.WAIT_NOTICE_MS}ms`,
  );
  check(
    '  and short enough to arrive before somebody reloads the page',
    agentTesting.WAIT_NOTICE_MS <= 10_000,
    `${agentTesting.WAIT_NOTICE_MS}ms`,
  );

  /*
   * The rule that decides when to stop counting. Anything from the provider
   * counts as having started — a reasoning token, a tool call, even a notice
   * that a key was refused. What is being timed is the silence before the
   * provider's first word, not the silence before it says something the
   * interface happens to draw.
   */
  const startsIt = (type) => agentTesting.countsAsStarted({ type });
  for (const type of ['text', 'thinking', 'tool_call_start', 'notice', 'retry', 'done']) {
    check(`a ${type} event ends the wait`, startsIt(type), type);
  }
}

// ── tool calls do not all start at once ─────────────────────────────
section('parallel tool calls have a ceiling');
{
  const { __testing: agentTesting } = await import('../server/agent.js');
  const { mapWithLimit, MAX_PARALLEL_TOOLS } = agentTesting;

  /*
   * There was no ceiling: every call the model made in one turn started at the
   * same instant. Three `web_fetch`es is fine; fifteen `run_command`s is fifteen
   * shells starting together on somebody's laptop, and nothing else in the chain
   * pushes back.
   */
  let inFlight = 0;
  let peak = 0;
  const order = await mapWithLimit([...Array(12).keys()], MAX_PARALLEL_TOOLS, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return n * 2;
  });

  check('never more than the limit are in flight', peak <= MAX_PARALLEL_TOOLS, `peak ${peak}`);
  check('and it does use the parallelism it is allowed', peak > 1, `peak ${peak}`);

  /*
   * Order is not cosmetic here. A tool result has to line up with the call it
   * answers, and every provider rejects a batch where they do not — so a
   * limiter that returned results in completion order would break every
   * parallel tool call in the app.
   */
  check(
    'results come back in the order they were requested',
    order.join(',') === [...Array(12).keys()].map((n) => n * 2).join(','),
    order.join(','),
  );

  check('an empty list is not a deadlock', (await mapWithLimit([], 4, async () => 1)).length === 0);
}

section('the app\'s own prompt has a version');
{
  /*
   * Nothing identified which version of the system prompt a turn ran under, so
   * a prompt edit could never be put beside the behaviour or cost that followed
   * (GAP-003). The eval stamps the value; these check the value is worth stamping.
   */
  const { promptVersion, buildSystemPrompt } = await import('../server/agent.js');
  const v = promptVersion();
  check('the version is a short fingerprint', /^[0-9a-f]{12}$/.test(v), v);
  check('  and the same on every call', promptVersion() === v);

  // The raw prompt carries today's date. If the fingerprint included it, the
  // version would change every midnight and a stamp would mean nothing.
  const raw = buildSystemPrompt({ workerOnline: false, policy: 'guarded' });
  check('  the prompt itself does carry a date', /Current date: \d{4}-\d{2}-\d{2}/.test(raw));
  const shifted = raw.replace(/^Current date: .*$/m, 'Current date: 1999-01-01.');
  const strip = (s) => s.replace(/^Current date: .*$/m, '');
  check('  and removing it is what makes two days\' prompts identical', strip(raw) === strip(shifted));

  // The date is the account's, not the server's: 23:30 UTC is already tomorrow in Vietnam.
  const vn = buildSystemPrompt({ workerOnline: false, policy: 'guarded', timezone: 'Asia/Ho_Chi_Minh' });
  const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
  check('  the date is read in the account\'s zone, and says which', vn.includes(`Current date: ${expected} (Asia/Ho_Chi_Minh)`));
  check('  and points at world_facts for anything more exact', /call world_facts/.test(vn));
}

section('a request begun from a shelf is filed on that shelf');
{
  const { __testing } = await import('../server/agent.js');
  const [wf, sched, plain] = __testing.withIntentNotes([
    { role: 'user', text: 'mỗi sáng lấy tin và gửi email', intent: 'workflow' },
    { role: 'user', text: 'nhắc tôi uống nước', intent: 'schedule' },
    { role: 'user', text: 'xin chào' },
  ]);
  check('from Workflows, it is told to use workflow_write', /workflow_write/.test(wf.text) && /not schedule_task/.test(wf.text));
  check('from Scheduled, schedule_task', /schedule_task/.test(sched.text) && /not a workflow/.test(sched.text));
  check('the request itself is kept as written', wf.text.startsWith('mỗi sáng lấy tin và gửi email'));
  check('an ordinary message is untouched', plain.text === 'xin chào');
  check('the setup is two steps: preferences, then a preview to confirm', /Step 1/.test(sched.text) && /preview/.test(sched.text) && /Confirm/.test(sched.text));
  const [typed] = __testing.withIntentNotes([{ role: 'user', text: 'bạn giúp tôi tạo gửi mail nói về các vấn đề AI mới nhất' }]);
  check('an email typed in an ordinary chat gets the same two steps', /two steps/.test(typed.text) && /send_email/.test(typed.text));
  // Continue after a cut-off: the transcript ends on the assistant's own half
  // reply, and the model is told what happened and what is wanted.
  const cut = __testing.withContinuation([
    { role: 'user', text: 'gửi bản tin' },
    { role: 'assistant', text: 'Giờ tôi thu thập tin từ 4 chủ đề song song:' },
  ]);
  check('a turn picked up after a cut-off tells the model to carry on', cut.length === 3 && /Carry on with the same task/.test(cut[2].text));
  check('  without repeating what already went out', /do not repeat anything that sent/.test(cut[2].text));
  check('an ordinary turn gets no such note', __testing.withContinuation([{ role: 'user', text: 'hi' }]).length === 1);
  const [reading] = __testing.withIntentNotes([{ role: 'user', text: 'check my inbox' }]);
  check('reading an inbox does not', reading.text === 'check my inbox');
}

section('read-only and plan mode hold even for a tool nobody offered');
{
  /*
   * `needsApproval` returns nothing under readonly and plan, on the grounds that
   * "the tools were never offered". A model can name one anyway — hallucinated,
   * or told to by a page — and nothing checked before `executeTool`. So the two
   * policies meant as "change nothing" ran a recursive delete with no prompt,
   * while the looser `guarded` policy stopped to ask about the same call.
   */
  const { policyRefusal, needsApproval } = await import('../server/agent.js');
  const { availableTools } = await import('../server/tools/definitions.js');
  const del = { id: 'd1', name: 'delete_file', input: { path: 'important', recursive: true } };

  for (const policy of ['readonly', 'plan']) {
    const offered = availableTools({ workerOnline: true, desktopOnline: true, context: 200_000, policy }).map((t) => t.name);
    check(`${policy}: the tool is not offered`, !offered.includes('delete_file'));
    check(`  and approval would not have stopped it`, needsApproval([del], policy).length === 0);
    const refused = policyRefusal(del, policy);
    check(`  but it is refused at execution`, refused?.isError === true, refused?.content?.slice(0, 60));
    check(`  and the model is told why`, new RegExp(policy === 'plan' ? 'plan' : 'read-only').test(refused?.content || ''));
  }

  // What makes the refusal safe to add: nothing these modes legitimately offer is
  // refused by it. If a future tool is offered under plan mode without being
  // read-only, this is the check that says plan mode just broke.
  for (const policy of ['readonly', 'plan']) {
    const offered = availableTools({ workerOnline: true, desktopOnline: true, context: 200_000, policy });
    const wouldRefuse = offered.filter((t) => policyRefusal({ id: 't', name: t.name, input: {} }, policy)).map((t) => t.name);
    check(`${policy}: no tool it offers is refused by it`, wouldRefuse.length === 0, wouldRefuse.join(', '));
  }

  const read = { id: 'r1', name: 'read_file', input: { path: 'notes.md' } };
  check('a read-only tool still runs in read-only mode', policyRefusal(read, 'readonly') === null);
  check('and nothing is refused this way under guarded — approval decides there', policyRefusal(del, 'guarded') === null);
  check('  where the same delete does ask first', needsApproval([del], 'guarded').length === 1);
}

/*
 * Unprompted messages to other people have a ceiling per turn.
 *
 * Under `auto` nothing asks before `send_email`, so a page carrying an
 * instruction, or a model stuck retrying, could send the same email dozens of
 * times in a turn — each one unrecallable.
 */
section('outbound messages under auto');
{
  const { outboundRefusal, OUTBOUND, OUTBOUND_PER_TURN, needsApproval } = await import('../server/agent.js');
  const { assessRisk } = await import('../server/tools/definitions.js');
  const mail = (i) => ({ id: `m${i}`, name: 'send_email', input: { to: 'a@example.com' } });

  const sent = { count: 0 };
  const outcomes = Array.from({ length: OUTBOUND_PER_TURN + 2 }, (_, i) => outboundRefusal(mail(i), 'auto', sent));
  check(`the first ${OUTBOUND_PER_TURN} go out`, outcomes.slice(0, OUTBOUND_PER_TURN).every((r) => r === null));
  check('  the next ones are refused', outcomes.slice(OUTBOUND_PER_TURN).every((r) => r?.isError === true));
  check('  and the model is told to stop and report', /tell the user exactly what was sent/.test(outcomes.at(-1)?.content || ''), outcomes.at(-1)?.content);
  check('reading is never counted', outboundRefusal({ id: 'r', name: 'read_file', input: {} }, 'auto', { count: 99 }) === null);
  check('a fresh turn starts from zero', outboundRefusal(mail(0), 'auto', { count: 0 }) === null);

  // The ceiling is only safe to leave off other policies because every one of
  // these asks first there. If one stops being sensitive, that stops being true.
  const unasked = [...OUTBOUND].filter((name) => assessRisk(name, {}) !== 'sensitive' || needsApproval([{ id: 'x', name, input: {} }], 'guarded').length !== 1);
  check('every outbound tool asks first under guarded', unasked.length === 0, unasked.join(', '));
  check('  so the ceiling does not apply there', outboundRefusal(mail(0), 'guarded', { count: 99 }) === null);

  // The loop has two places that run tool calls; both must carry the counter.
  const source = fs.readFileSync(new URL('../server/agent.js', import.meta.url), 'utf8');
  const sites = source.split('await runToolCalls({').slice(1).map((rest) => rest.slice(0, rest.indexOf('})')));
  check('both places the loop runs tools pass the per-turn counter', sites.length === 2 && sites.every((site) => site.includes('policy, sent')), `${sites.length} sites`);
}

section('pictures come from a model that still exists, and are booked');
{
  /*
   * `generate_image` called Imagen 4, whose endpoints Google shut down on
   * 2026-08-17 (GAP-008), and never recorded what it spent (CODE-024). The
   * replacement is the Interactions API, one image per request. A stand-in
   * client pins what is sent and what is read back — the real client needs a key
   * and costs money per call, and no live call is made here.
   */
  const { requestImages } = await import('../server/tools/cloud.js');
  const sent = [];
  const client = {
    interactions: {
      create: async (req) => {
        sent.push(req);
        return {
          output_image: { data: 'aGVsbG8=', mime_type: 'image/png' },
          usage: { total_input_tokens: 12, total_output_tokens: 1290 },
        };
      },
    },
  };
  const got = await requestImages(client, { model: 'gemini-3.1-flash-image', prompt: 'a lighthouse', count: 3, aspectRatio: '16:9' });
  check('one request per picture', sent.length === 3, String(sent.length));
  check('  to the replacement model, not the retired one', sent.every((r) => r.model === 'gemini-3.1-flash-image'));
  check('  asking for an image in the requested shape', sent.every((r) => r.response_format?.type === 'image' && r.response_format?.aspect_ratio === '16:9'));
  check('three pictures come back', got.images.length === 3 && got.images[0].mime === 'image/png');
  check('and the provider\'s own token counts are summed for booking', got.usage.input === 36 && got.usage.output === 3870, JSON.stringify(got.usage));

  const declining = { interactions: { create: async () => ({ output_text: 'I can\'t make that.', usage: { total_input_tokens: 9, total_output_tokens: 4 } }) } };
  const refused = await requestImages(declining, { model: 'm', prompt: 'x', count: 1 });
  check('a refusal is reported as a refusal, with its reason', refused.images.length === 0 && /can't make that/.test(refused.refusal || ''));
  check('  and still booked — a declined request is still paid for', refused.usage.input === 9);

  const broken = { interactions: { create: async () => { throw new Error('404 model not found'); } } };
  let thrown = '';
  try {
    await requestImages(broken, { model: 'imagen-4.0-generate-001', prompt: 'x', count: 2 });
  } catch (err) {
    thrown = err.message;
  }
  check('every request failing is an error, not an empty success', /404/.test(thrown), thrown);
}

section('two memory notes written in one step both survive');
{
  /*
   * `memory_write` read the whole memory object, changed one key and wrote the
   * whole object back. The agent runs up to four tool calls at once, so a write
   * beside an append both read the same object and the second erased the first
   * — both reporting success (CODE-023). Its neighbours were moved to a merge
   * for exactly this; it was not.
   *
   * This reproduces even on PGlite, where statements run one at a time, because
   * the read and the write are two awaited statements and `Promise.all` lets both
   * reads finish before either write.
   */
  const { executeTool } = await import('../server/tools/execute.js');
  await Promise.all([
    executeTool({ user, name: 'memory_write', input: { key: 'lease', content: 'deposit is two months' }, chatId: null }),
    executeTool({ user, name: 'memory_append', input: { key: 'preferences', content: 'replies in Vietnamese' }, chatId: null }),
    executeTool({ user, name: 'memory_write', input: { key: 'car', content: 'service due in March' }, chatId: null }),
  ]);
  const memory = (await store.getUserSetting(user.id, 'memory')) || {};
  check('a note written beside two others survives', memory.lease?.content === 'deposit is two months', JSON.stringify(Object.keys(memory)));
  check('  and so does the appended one', /Vietnamese/.test(memory.preferences?.content || ''));
  check('  and the third', memory.car?.content === 'service due in March');

  const poisoned = await executeTool({ user, name: 'memory_write', input: { key: '__proto__', content: 'x' }, chatId: null });
  check('a note named __proto__ is refused rather than silently lost', poisoned.isError === true && /cannot be used as a note name/.test(poisoned.content), poisoned.content);
}

section('setting up work that runs unwatched asks first');
{
  /*
   * `schedule_task` and `workflow_write` store a prompt the scheduler later runs
   * with nobody at the approval bar; `skill_write` puts text into the trusted
   * part of every future system prompt. All three were graded `ordinary`, so
   * under the default policy a single injected instruction could set up
   * recurring work, or a prompt injection that outlives the session, without
   * anyone being asked (SEC-027).
   */
  const { needsApproval: approvalFor } = await import('../server/agent.js');
  for (const name of ['schedule_task', 'workflow_write', 'skill_write']) {
    check(`${name} asks under the default policy`, approvalFor([{ id: 'x', name, input: {} }], 'guarded').length === 1);
  }
  check('while cancelling a task — which only stops work — does not', approvalFor([{ id: 'x', name: 'cancel_task', input: {} }], 'guarded').length === 0);
}

section('a resume does not repeat what may already have happened');
{
  /*
   * A resume finds an assistant turn with calls and no results. That has two
   * causes — stopped before the calls began, or killed while they ran — and the
   * resume used to treat both as the first, running everything again. A
   * function timeout lands precisely in the second window, which is as long as
   * the tools take. `send_email` run twice is two emails.
   */
  const { resumableCalls } = await import('../server/agent.js');

  const calls = [
    { id: 'c1', name: 'send_email', input: { to: 'a@example.com' } },
    { id: 'c2', name: 'web_search', input: { query: 'x' } },
    { id: 'c3', name: 'write_file', input: { path: 'a.txt', content: 'x' } },
    { id: 'c4', name: 'mcp__server__do_thing', input: {} },
  ];

  const fresh = resumableCalls(calls, []);
  check('calls that never started all run', fresh.run.length === 4 && fresh.skipped.length === 0);

  const interrupted = resumableCalls(calls, ['c1', 'c2', 'c3', 'c4']);
  const ranNames = interrupted.run.map((c) => c.name);
  check('a started email is not sent again', !ranNames.includes('send_email'), ranNames.join(','));
  check('  nor a started file write', !ranNames.includes('write_file'));
  check('  nor a started MCP tool — outside the catalogue counts as able to change something', !ranNames.includes('mcp__server__do_thing'));
  check('  while a started read runs again, because reading twice costs nothing', ranNames.includes('web_search'));

  const said = interrupted.skipped.find((r) => r.name === 'send_email');
  check('the skipped call gets a result the model can act on', said?.isError === true && /may have completed/i.test(said?.content || ''));
  check('  and it is told to check rather than retry', /check whether it took effect/i.test(said?.content || ''));

  const partly = resumableCalls(calls, ['c1']);
  check('only the calls that started are held back', partly.skipped.length === 1 && partly.run.length === 3);
}

section('the modules in an import cycle can each be loaded first');
{
  /**
   * There are three cycles through the agent loop, and they work — for a reason
   * nobody is currently checking.
   *
   *   execute -> cloud -> subagents -> execute
   *   agent   -> execute -> cloud -> scheduler -> agent
   *   agent   -> execute -> cloud -> workflows -> agent
   *
   * ESM handles a cycle as long as every reference resolves when it is *called*
   * rather than when the module is evaluated. None of these six files calls an
   * imported function at module top level today, which is why nothing has
   * broken. Add one `const X = importedFn()` up there and it is `undefined` on
   * one entry path and defined on another, depending which module the process
   * happened to reach first.
   *
   * Not hypothetical here: this same audit found import-time evaluation twice —
   * `render.js` freezing its file nouns, `workflows.js` freezing two label maps
   * — both written by people who did not expect it either.
   *
   * So each member is loaded first, in its own process. A top-level evaluation
   * that only works from one direction fails here, and names the file.
   */
  const members = [
    'server/agent.js',
    'server/tools/execute.js',
    'server/tools/cloud.js',
    'server/subagents.js',
    'server/scheduler.js',
    'server/workflows.js',
  ];

  const { spawnSync } = await import('node:child_process');
  for (const entry of members) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./${entry}');`], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    check(
      `${entry} loads as the first module in the graph`,
      run.status === 0,
      String(run.stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 160),
    );
  }
}

// ── the step ceiling actually reaches the browser ────────────────────
//
// Both budget exits in the step loop build a `stop` descriptor with
// `budgetStop` (server/providers/stop.js) and put it on the `done` event —
// but until now nothing drove the *real* loop to either ceiling and looked at
// what came out the other end. `runAgent` never took an injectable provider
// the way `compact()` and `runParallel` already do, so it could not be driven
// without a live key; the seam is added in server/agent.js alongside this
// test so the wiring itself — not just the descriptor — is what is checked.
section('the same read twice in a turn runs once');
{
  /*
   * The report: two identical deep research calls side by side, and the docx
   * skill read twice in a row. An identical stable read is answered from the
   * first; deep research is capped per turn.
   */
  const { repeatedRead, MAX_RESEARCH_PER_TURN } = await import('../server/agent.js');
  const dupUser = await store.createUser({ id: 'u-dup', email: 'dup@example.com', name: 'Dup', passwordHash: await hashPassword('a-sufficiently-long-password'), role: 'admin' });
  await store.createChat(dupUser.id, { id: 'c-dup', title: 'dup' });
  await store.appendMessage(dupUser.id, 'c-dup', { id: 'u-dup-1', role: 'user', text: 'read your notes' });
  let calls = 0;
  const seenResults = [];
  const stream = async function* scripted(opts) {
    calls += 1;
    const last = opts.messages.at(-1);
    if (last?.role === 'tool') seenResults.push(...last.results);
    if (calls === 1) {
      yield { type: 'done', stopReason: 'tool_use', toolCalls: [
        { id: 'm1', name: 'memory_read', input: { key: 'prefs' } },
        { id: 'm2', name: 'memory_read', input: { key: 'prefs' } },
      ], usage: { input: 5, output: 5 } };
    } else if (calls === 2) {
      yield { type: 'done', stopReason: 'tool_use', toolCalls: [{ id: 'm3', name: 'memory_read', input: { key: 'prefs' } }], usage: { input: 5, output: 5 } };
    } else {
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 5, output: 5 } };
    }
  };
  await runAgent({ userId: dupUser.id, user: dupUser, chatId: 'c-dup', emit: () => {}, stream });
  const repeated = seenResults.filter((r) => /already ran in this turn/.test(r.content || ''));
  check('a duplicate in the same batch and one in the next step are both answered from the first', repeated.length === 2, `${repeated.length} of ${seenResults.length}`);

  const memo = new Map();
  const counts = {};
  let refused = null;
  for (let i = 0; i <= MAX_RESEARCH_PER_TURN; i += 1) {
    const seen = repeatedRead({ name: 'deep_research', input: { question: `q${i}` } }, memo, counts);
    if (seen?.key) memo.set(seen.key, Promise.resolve({ content: 'r', isError: false }));
    if (seen?.refused) refused = seen.refused;
  }
  check(`deep research past ${MAX_RESEARCH_PER_TURN} in a turn is refused`, /already run/.test(refused || ''), refused);
  check('volatile reads are never answered from memory', repeatedRead({ name: 'world_facts', input: { kind: 'time' } }, new Map(), {}) === null);
}

section('the progress gate: a turn cannot finish with its plan left behind');
{
  /*
   * The report: the model read every chapter, wrote the quiz, answered — and
   * the panel still said 0/7 with the first step running. Finishing with steps
   * not done now sends the model back once to mark them.
   */
  const gateUser = await store.createUser({
    id: 'u-gate',
    email: 'gate@example.com',
    name: 'Gate',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'admin',
  });
  const plan = (statuses) => ({
    steps: ['Read chapter 1', 'Read chapter 2', 'Write the quiz'].map((title, i) => ({ title, status: statuses[i] })),
  });

  const drive = async (chatId, script) => {
    await store.createChat(gateUser.id, { id: chatId, title: 'quiz' });
    await store.appendMessage(gateUser.id, chatId, { id: `${chatId}-u`, role: 'user', text: 'Make me a quiz.' });
    const seen = [];
    let calls = 0;
    const stream = async function* scripted(opts) {
      seen.push(opts.messages);
      const turn = script[calls] || { text: 'Done.' };
      calls += 1;
      if (turn.text) yield { type: 'text', delta: turn.text };
      yield { type: 'done', stopReason: turn.calls ? 'tool_use' : 'end_turn', toolCalls: turn.calls || [], usage: { input: 10, output: 5 } };
    };
    const events = [];
    await runAgent({ userId: gateUser.id, user: gateUser, chatId, emit: (type, payload) => events.push({ type, payload }), stream });
    return { seen, events, calls: () => calls };
  };

  const fixed = await drive('c-gate-1', [
    { calls: [{ id: 'p1', name: 'update_plan', input: plan(['in_progress', 'pending', 'pending']) }] },
    { text: 'Here is your quiz.' },
    { calls: [{ id: 'p2', name: 'update_plan', input: plan(['done', 'done', 'done']) }] },
    { text: '' },
  ]);
  const gateMessage = fixed.seen[2]?.at(-1);
  check('finishing with steps not done sends the model back', fixed.calls() === 4, `${fixed.calls()} calls`);
  check('  with a note naming the steps left', gateMessage?.role === 'user' && /Progress gate/.test(gateMessage.text) && /Read chapter 2/.test(gateMessage.text), gateMessage?.text?.slice(0, 120));
  check('  said in the status line', fixed.events.some((e) => e.type === 'status' && e.payload?.phase === 'progress_check'));
  const plans = fixed.events.filter((e) => e.type === 'plan');
  check('  so the last plan the panel sees is all done', plans.at(-1)?.payload.steps.every((s) => s.status === 'done'), JSON.stringify(plans.at(-1)?.payload.steps));
  check('  and the turn ends once, after the update', fixed.events.filter((e) => e.type === 'done').length === 1);
  const stored = await store.listMessages(gateUser.id, 'c-gate-1');
  check('the gate note is never stored', !stored.some((m) => /Progress gate/.test(m.text || '')));

  const stubborn = await drive('c-gate-2', [
    { calls: [{ id: 'q1', name: 'update_plan', input: plan(['in_progress', 'pending', 'pending']) }] },
    { text: 'Here is your quiz.' },
    { text: 'Chapter 2 was not in the files, so it stays pending.' },
  ]);
  check('the gate fires once per turn, so a step left undone cannot loop', stubborn.calls() === 3, `${stubborn.calls()} calls`);

  const finished = await drive('c-gate-3', [
    { calls: [{ id: 'r1', name: 'update_plan', input: plan(['done', 'done', 'done']) }] },
    { text: 'Here is your quiz.' },
  ]);
  check('a plan already done ends the turn at once', finished.calls() === 2, `${finished.calls()} calls`);
}

section('a long stretch without a plan update carries a reminder');
{
  const { withProgressNotes, PROGRESS_EVERY } = await import('../server/progress.js');
  const transcript = [
    { id: 'u', role: 'user', text: 'go' },
    { id: 'a0', role: 'assistant', toolCalls: [{ id: 'p', name: 'update_plan', input: { steps: [{ title: 'One', status: 'in_progress' }, { title: 'Two', status: 'pending' }] } }] },
    { id: 't0', role: 'tool', results: [{ toolCallId: 'p', name: 'update_plan', content: 'ok' }] },
  ];
  for (let i = 1; i <= PROGRESS_EVERY * 2; i += 1) {
    transcript.push({ id: `a${i}`, role: 'assistant', toolCalls: [{ id: `c${i}`, name: 'web_fetch', input: {} }] });
    transcript.push({ id: `t${i}`, role: 'tool', results: [{ toolCallId: `c${i}`, name: 'web_fetch', content: `page ${i}` }] });
  }
  const noted = withProgressNotes(transcript);
  const flagged = noted.filter((m) => m.role === 'tool' && /Progress check/.test(m.results.at(-1).content)).map((m) => m.id);
  check(`a reminder every ${PROGRESS_EVERY} calls without an update`, flagged.join() === `t${PROGRESS_EVERY},t${PROGRESS_EVERY * 2}`, flagged.join());
  check('  naming the step in progress', /"One" in progress/.test(noted.find((m) => m.id === `t${PROGRESS_EVERY}`).results[0].content));
  check('  the same note on the same message every time, so caching holds', JSON.stringify(withProgressNotes(transcript)) === JSON.stringify(noted));
  check('  and the stored transcript is untouched', !/Progress check/.test(JSON.stringify(transcript)));
  const allDone = transcript.map((m) => (m.id === 'a0' ? { ...m, toolCalls: [{ ...m.toolCalls[0], input: { steps: [{ title: 'One', status: 'done' }, { title: 'Two', status: 'done' }] } }] } : m));
  check('no reminder once every step is done', !/Progress check/.test(JSON.stringify(withProgressNotes(allDone))));
}

section('the step ceiling reaches the browser, not just the descriptor');
{
  const stepUser = await store.createUser({
    id: 'u-steps',
    email: 'steps@example.com',
    name: 'Steps',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'admin',
  });

  await setPrefs(stepUser.id, { maxSteps: 3 });
  const chat = await store.createChat(stepUser.id, { id: 'c-steps', title: 'Loops forever' });
  await store.appendMessage(stepUser.id, chat.id, {
    id: 'm-steps-1',
    role: 'user',
    text: 'Keep going until you are told to stop.',
  });

  // Never answers with prose or stops on its own — always another safe,
  // no-op tool call — so nothing but the step ceiling can end this turn.
  let calls = 0;
  const neverStops = async function* fake() {
    calls += 1;
    yield {
      type: 'done',
      stopReason: 'tool_use',
      toolCalls: [{
        id: `t${calls}`,
        name: 'update_plan',
        input: { steps: [{ title: 'a', status: 'pending' }, { title: 'b', status: 'pending' }] },
      }],
      usage: { input: 10, output: 5 },
    };
  };

  const events = [];
  await runAgent({
    userId: stepUser.id,
    user: stepUser,
    chatId: chat.id,
    emit: (type, payload) => events.push({ type, payload }),
    stream: neverStops,
  });

  check('the provider was actually driven to the ceiling', calls === 3, `${calls} calls`);
  const doneEvents = events.filter((e) => e.type === 'done');
  check('exactly one done event closes the turn', doneEvents.length === 1, `${doneEvents.length}`);
  const { stopReason, stop } = doneEvents[0]?.payload || {};
  check('done carries stopReason max_steps', stopReason === 'max_steps', String(stopReason));
  check('  and a stop descriptor of the same kind', stop?.kind === 'max_steps', JSON.stringify(stop));
  check('  marked resumable, so the browser can offer Continue', stop?.resumable === true, JSON.stringify(stop));
  check('  naming the configured ceiling', /3 steps/.test(stop?.message || ''), stop?.message);
}

// ── the token-budget exit, the same wiring ────────────────────────────
section('the turn-token ceiling reaches the browser too');
{
  const tokenUser = await store.createUser({
    id: 'u-tokens',
    email: 'tokens@example.com',
    name: 'Tokens',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'admin',
  });

  const chat = await store.createChat(tokenUser.id, { id: 'c-tokens', title: 'Burns tokens' });
  await store.appendMessage(tokenUser.id, chat.id, { id: 'm-tokens-1', role: 'user', text: 'Go on.' });

  // MAX_TURN_TOKENS overrides turnTokenLimit's usual "only over the shared
  // key" rule — see server/usage.js — which is what makes this branch
  // reachable in a test with no shared key configured at all.
  const priorLimit = process.env.MAX_TURN_TOKENS;
  process.env.MAX_TURN_TOKENS = '50';
  try {
    let calls = 0;
    // One reply of 55 tokens (comfortably over the 50-token cap) with a tool
    // call attached, so the loop is not done on its own terms — it is the
    // pre-flight check at the top of the *next* step that has to catch it.
    const oneReplyThenOver = async function* fake() {
      calls += 1;
      yield { type: 'text', delta: 'Partial answer.' };
      yield {
        type: 'done',
        stopReason: 'tool_use',
        toolCalls: [{
          id: 't1',
          name: 'update_plan',
          input: { steps: [{ title: 'a', status: 'pending' }, { title: 'b', status: 'pending' }] },
        }],
        usage: { input: 30, output: 25 },
      };
    };

    const events = [];
    await runAgent({
      userId: tokenUser.id,
      user: tokenUser,
      chatId: chat.id,
      emit: (type, payload) => events.push({ type, payload }),
      stream: oneReplyThenOver,
    });

    check(
      'the provider answered once, then the cap stopped a second request',
      calls === 1,
      `${calls} calls`,
    );
    const doneEvents = events.filter((e) => e.type === 'done');
    const { stopReason, stop } = doneEvents[0]?.payload || {};
    check('done carries stopReason token_limit', stopReason === 'token_limit', String(stopReason));
    check('  and a stop descriptor of the same kind', stop?.kind === 'token_limit', JSON.stringify(stop));
    check('  marked resumable', stop?.resumable === true, JSON.stringify(stop));
  } finally {
    if (priorLimit === undefined) delete process.env.MAX_TURN_TOKENS;
    else process.env.MAX_TURN_TOKENS = priorLimit;
  }
}

/* ── asking the person, with buttons ──────────────────────────────
 *
 * The assistant could always ask something in prose and end the turn, so in
 * practice it did the other thing and guessed. `ask_options` is the question
 * with buttons on it; these cover the two parts that can be wrong quietly —
 * what counts as a well-formed question, and what the model is told was said.
 * ───────────────────────────────────────────────────────────────── */

const { normaliseQuestions, answerText, answerSummary, askLayout } = await import('../server/tools/askOptions.js');
const { toolsToPreload } = await import('../server/agent.js');

section('what counts as a question worth drawing');
{
  const one = normaliseQuestions({
    questions: [{ question: 'Ưu tiên lĩnh vực nào?', options: ['Tài chính', 'AI', 'Tài chính'] }],
  });
  check('it comes back as one question', one.length === 1);
  // Two buttons with the same words are a choice nobody can make, and the
  // answer would not say which was pressed.
  check('a repeated option is dropped', one[0].options.length === 2, JSON.stringify(one[0].options));
  check('Vietnamese survives intact', one[0].question === 'Ưu tiên lĩnh vực nào?', one[0].question);
  check('choosing one is the default', one[0].multiple === false);
  check('and the free-text box is on by default', one[0].other === true);

  // A model with one question to ask writes one question, not a list of one.
  const flat = normaliseQuestions({ question: 'Dài bao nhiêu?', options: ['5 phút', '20 phút'] });
  check('a single question passed flat still works', flat.length === 1 && flat[0].options.length === 2);

  // Options can arrive as objects; refusing that would fail on output that was
  // perfectly clear about what it meant.
  const rich = normaliseQuestions({
    question: 'Kiểu nào?',
    options: [{ label: 'Ngắn', description: 'một đoạn' }, { label: 'Dài' }],
  });
  check('an option written as an object is understood', rich[0].options[0].description === 'một đoạn');

  const many = normaliseQuestions({
    questions: Array.from({ length: 9 }, (_, i) => ({ question: `Q${i}`, options: ['a', 'b'] })),
  });
  // Six, not five: a setup form (frequency, address, language, length, topic…)
  // is one card, and five left no room for the address.
  check('past six questions the rest are cut', many.length === 6, `${many.length}`);

  // A form: choices and a typed field, answered together.
  const form = normaliseQuestions({
    style: 'form',
    questions: [
      { question: 'Tần suất?', options: ['Hằng ngày', 'Hằng tuần'] },
      { question: 'Email nhận', kind: 'email', placeholder: 'you@example.com', hint: 'Có thể để trống' },
    ],
  });
  check('a typed field needs no options', form.length === 2 && form[1].kind === 'email' && form[1].options.length === 0);
  check('and keeps its placeholder and hint', form[1].otherLabel === 'you@example.com' && form[1].hint === 'Có thể để trống');
  const layout = askLayout({ style: 'form', submit_label: 'Tiếp tục thiết lập' }, form);
  check('it is drawn as a form with its own button', layout.form && layout.submitLabel === 'Tiếp tục thiết lập');
  check('a typed field alone makes a form too', askLayout({}, form).form === true);
  // Step two: what will be set up, shown before it exists.
  const confirm = askLayout(
    { preview: { title: 'AI Intelligence Daily', badge: 'Chưa kích hoạt', rows: ['Hằng ngày 7:00', 'Tiếng Việt'], points: ['Mô hình AI mới'] } },
    form,
  );
  check('a preview is carried to the card', confirm.preview?.title === 'AI Intelligence Daily' && confirm.preview.rows.length === 2);
  check('and makes it a form', confirm.form === true);
  check('a preview with no title is dropped', !askLayout({ preview: { rows: ['x'] } }, form).preview);
  const given = [{ picks: ['Hằng ngày'], other: '' }, { picks: [], other: 'an@example.com' }];
  check('the model reads the typed value', /"an@example\.com"/.test(answerText(form, given)));
  check(
    'and the person sees their answers as they would say them',
    answerSummary(form, given) === 'Tần suất: Hằng ngày\nEmail nhận: an@example.com',
    JSON.stringify(answerSummary(form, given)),
  );
  check(
    'an address that is not one is flagged to the model',
    /does not look like an email/.test(answerText(form, [given[0], { picks: [], other: 'not-an-address' }])),
  );

  // A turn that is plainly setting something up is handed the tool up front,
  // rather than left to discover it is behind load_tools.
  check('a message from the Scheduled shelf gets schedule_task', toolsToPreload({ intent: 'schedule', text: 'x' }).includes('schedule_task'));
  check('one from the Workflows shelf gets workflow_write', toolsToPreload({ intent: 'workflow', text: 'x' }).includes('workflow_write'));
  check('"mỗi sáng gửi tôi bản tin" gets it too', toolsToPreload({ text: 'mỗi sáng gửi tôi bản tin AI qua mail' }).includes('schedule_task'));
  check('  and the email tool', toolsToPreload({ text: 'mỗi sáng gửi tôi bản tin AI qua mail' }).includes('send_email'));
  check('an ordinary question gets nothing extra', toolsToPreload({ text: 'giải thích định lý Pythagoras' }).length === 0);

  const wide = normaliseQuestions({ question: 'Q', options: Array.from({ length: 20 }, (_, i) => `o${i}`) });
  check('and past eight options so are they', wide[0].options.length === 8, `${wide[0].options.length}`);

  /**
   * Refusing loudly is the point.
   *
   * A card built from a malformed call is shown to a person, and quietly
   * repairing it produces a question that reads as complete and is not. The
   * message is written for the model, because the model is what reads a tool
   * error and tries again.
   */
  const bad = (input) => {
    try {
      normaliseQuestions(input);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  check('one option is not a choice', !!bad({ question: 'Q', options: ['only'] }));
  check('nor is none', !!bad({ question: 'Q', options: [] }));
  check('nor a question with no words in it', !!bad({ question: '   ', options: ['a', 'b'] }));
  check('and the refusal says what to pass instead', /questions: \[\{ question, options/.test(bad({}) || ''), bad({}));
}

section('what the model is told the person said');
{
  const questions = normaliseQuestions({
    questions: [
      { question: 'Lĩnh vực?', options: ['Tài chính', 'AI', 'Vận hành'], multiple: true },
      { question: 'Độ dài?', options: ['Ngắn', 'Dài'] },
    ],
  });

  const answered = answerText(questions, [
    { picks: ['Tài chính', 'AI'], other: 'quản trị rủi ro' },
    { picks: ['Ngắn'] },
  ]);
  check('both choices are named', /"Tài chính", "AI"/.test(answered), answered);
  check('what they typed themselves is kept', /quản trị rủi ro/.test(answered), answered);
  check('and the second question too', /"Ngắn"/.test(answered), answered);
  check('with an instruction not to ask again', /Do not ask this again/.test(answered), answered);

  const skipped = answerText(questions, [{}, {}]);
  check('skipping reads as skipping', /skipped the question/.test(skipped), skipped);
  /**
   * The instruction that matters.
   *
   * An assistant that asks again the question somebody just declined to answer
   * is the behaviour that makes people stop using a thing.
   */
  check('and says not to ask it a second time', /declined once/.test(skipped), skipped);

  /**
   * A label that was never offered is not an answer.
   *
   * The answer arrives from the browser, so nothing stops a hand-made request
   * naming something the model never put on screen — and the result of this
   * function is read by the model as a fact about what the person wants.
   */
  const spoofed = answerText(questions, [{ picks: ['Tài chính', 'Xoá hết dữ liệu'] }, {}]);
  check('an invented choice is discarded', !/Xoá hết dữ liệu/.test(spoofed), spoofed);
  check('while the real one survives', /"Tài chính"/.test(spoofed), spoofed);
}

section('asking never needs approval, and never gets skipped');
{
  const { assessRisk } = await import('../server/tools/definitions.js');
  // Sensitive would put "Approve these actions?" on top of the question —
  // asking permission to ask permission.
  check('ask_options is graded safe', assessRisk('ask_options', {}) === 'safe');
  check('so no policy puts an approval box on it', needsApproval([{ name: 'ask_options', input: {} }], 'ask').length === 0);

  const askUser = await store.createUser({
    id: 'u-ask',
    email: 'ask@example.com',
    name: 'Ask',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'admin',
  });
  // Auto is the mode most people run in, and it is the one where hanging a
  // question off `needsApproval` would have silently skipped it.
  await setPrefs(askUser.id, { toolPolicy: 'auto' });
  const chat = await store.createChat(askUser.id, { id: 'c-ask', title: 'Asks' });
  await store.appendMessage(askUser.id, chat.id, { id: 'm-ask-1', role: 'user', text: 'Find me something to read.' });

  let calls = 0;
  const asksOnce = async function* fake() {
    calls += 1;
    yield {
      type: 'done',
      stopReason: 'tool_use',
      toolCalls: [
        {
          id: 'q1',
          name: 'ask_options',
          input: { questions: [{ question: 'Lĩnh vực nào?', options: ['Tài chính', 'AI'] }] },
        },
      ],
      usage: { input: 10, output: 5 },
    };
  };

  const events = [];
  await runAgent({
    userId: askUser.id,
    user: askUser,
    chatId: chat.id,
    emit: (type, payload) => events.push({ type, payload }),
    stream: asksOnce,
  });

  const asked = events.find((e) => e.type === 'question_required');
  check('the turn stops and asks, under auto', !!asked, events.map((e) => e.type).join(','));
  check('naming the call it is waiting on', asked?.payload?.toolCallId === 'q1', String(asked?.payload?.toolCallId));
  check(
    'and carrying the question to draw',
    asked?.payload?.questions?.[0]?.question === 'Lĩnh vực nào?',
    JSON.stringify(asked?.payload?.questions),
  );
  // It stopped rather than running the tool with no answer.
  check('the provider was called once and then left alone', calls === 1, `${calls}`);
  check('and no tool was run', !events.some((e) => e.type === 'tool_result'), events.map((e) => e.type).join(','));

  /**
   * Answering resumes the same turn.
   *
   * The assistant turn was stored before the pause, so this is the ordinary
   * resume path with the answer attached — no second copy of the question, and
   * the model reads the result as though the tool had simply taken a while.
   */
  const after = [];
  let secondCall = 0;
  const thenReplies = async function* fake() {
    secondCall += 1;
    yield { type: 'text', delta: 'Rõ rồi.' };
    yield { type: 'done', stopReason: 'end_turn', usage: { input: 10, output: 5 } };
  };
  await runAgent({
    userId: askUser.id,
    user: askUser,
    chatId: chat.id,
    answers: { toolCallId: 'q1', given: [{ picks: ['Tài chính'], other: '' }] },
    emit: (type, payload) => after.push({ type, payload }),
    stream: thenReplies,
  });

  const result = after.find((e) => e.type === 'tool_result');
  check('answering runs the tool at last', !!result, after.map((e) => e.type).join(','));
  check('and the model is told what was chosen', /"Tài chính"/.test(result?.payload?.content || ''), result?.payload?.content);
  check('the turn then carries on', secondCall === 1 && after.some((e) => e.type === 'done'), `${secondCall}`);
  check('and does not ask the same thing twice', !after.some((e) => e.type === 'question_required'));
}

section('a question and an approval in one batch do not loop');
{
  const both = await store.createUser({ id: 'u-both', email: 'both@example.com', name: 'Both', passwordHash: 'x', role: 'user' });
  await setPrefs(both.id, { toolPolicy: 'guarded' });
  const chat = await store.createChat(both.id, { id: 'c-both', title: 'Both' });
  await store.appendMessage(both.id, chat.id, { id: 'm-both', role: 'user', text: 'Email my boss.' });
  const batch = [
    { id: 'q-both', name: 'ask_options', input: { questions: [{ question: 'Tone?', options: ['Formal', 'Warm'] }] } },
    { id: 'e-both', name: 'send_email', input: { to: 'boss@example.com', subject: 'Hi', body: 'Hello' } },
  ];
  let first = true;
  const model = async function* fake() {
    if (first) {
      first = false;
      yield { type: 'done', stopReason: 'tool_use', toolCalls: batch, usage: { input: 10, output: 5 } };
    } else yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 10, output: 5 } };
  };
  const run = async (extra) => {
    const events = [];
    await runAgent({ userId: both.id, user: both, chatId: chat.id, emit: (type, payload) => events.push({ type, payload }), stream: model, ...extra });
    return events;
  };
  const answers = { toolCallId: 'q-both', given: [{ picks: ['Warm'], other: '' }] };
  const asked = await run({});
  check('it asks first', asked.some((e) => e.type === 'question_required'));
  const answered = await run({ answers });
  check('the answer leads to the approval', answered.some((e) => e.type === 'approval_required'), answered.map((e) => e.type).join(','));
  // What the browser now sends: the decision and the answer it already gave.
  const allowed = await run({ decision: 'allow', decisionFor: batch.map((c) => c.id), answers });
  check('allowing does not ask the question again', !allowed.some((e) => e.type === 'question_required'), allowed.map((e) => e.type).join(','));
  const told = allowed.find((e) => e.type === 'tool_result' && e.payload?.toolCallId === 'q-both');
  check('  and the model reads the answer', /"Warm"/.test(told?.payload?.content || ''), told?.payload?.content);
}

section('a run nobody is watching is not told to ask');
{
  // A task prompt reads like a setup request — "every morning", "email me" —
  // and used to get the setup note, ask_options, and schedule_task preloaded.
  const taskUser = await store.createUser({ id: 'u-task', email: 'task@example.com', name: 'Task', passwordHash: 'x', role: 'user' });
  const chat = await store.createChat(taskUser.id, { id: 'c-task-run', title: 'Morning news' });
  await store.appendMessage(taskUser.id, chat.id, { id: 'm-task-1', role: 'user', text: 'Gửi tin AI mới nhất vào email tôi mỗi sáng.' });
  let offered = [];
  let sentText = '';
  const once = async function* fake(opts) {
    offered = (opts.tools || []).map((t) => t.name);
    sentText = opts.messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n');
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 10, output: 5 } };
  };
  await runAgent({ userId: taskUser.id, user: taskUser, chatId: chat.id, unattended: true, emit: () => {}, stream: once });
  // (Preloading is not observable here: with no known window nothing is
  // deferred, so every tool is offered anyway.)
  check('ask_options is not offered', offered.length > 0 && !offered.includes('ask_options'), offered.join(','));
  check('  and the prompt carries no setup note', !/ask_options/.test(sentText), sentText.slice(-160));
}

// Last, after every section that uses the database: it was removed midway, and
// the sections after it ran against pages PGlite happened to still hold.
removeTemp(process.env.DATA_DIR);


console.log(
  failures === 0
    ? '\n[32mAll agent checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
