/**
 * Stop means stop (owner, 2026-11-06): the model stops being asked at once, what
 * was already said stays where it stopped, the next turn starts after it, and what
 * the stopped request spent is on the books. Changing model mid-answer is the same
 * stop, followed by the new model carrying on.
 *
 * Driven from the real route, down the real adapter, against a throwaway HTTP server
 * pretending to be a provider that takes its time. A stand-in generator would prove
 * nothing about whether the provider's socket closes, which is what costs money.
 *
 *   node test/stop-now.test.mjs
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'stop-now-encryption-key';
process.env.SESSION_SECRET ||= 'stop-now-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-stop-now-${process.pid}`);
process.env.KEY_CHECKS = 'off';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await test()) return true;
    await sleep(25);
  }
  return false;
};

/**
 * A provider that thinks, then writes a word every 40 ms for as long as anyone reads.
 * `closedAt` is when its socket closed before it had finished: the moment money stops.
 */
const requests = [];
const cutOff = new Set();
const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const auth = String(req.headers.authorization || '');
    const request = { model: body.model, messages: body.messages, auth, words: 0, closedAt: 0, finished: false };
    requests.push(request);
    // A key its provider will not have.
    if (/refuse-key/.test(auth)) {
      request.finished = true;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: can only afford 1141' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Takes the request and says nothing, for as long as anyone waits.
    if (/silent/.test(String(body.model))) {
      res.write(': waiting\n\n');
      res.on('close', () => {
        if (!request.finished) request.closedAt = Date.now();
      });
      return;
    }
    // Stops at its output limit every time, on a request as large as a whole turn on the deployment's key may be.
    if (/cut-huge/.test(String(body.model))) {
      request.finished = true;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(400) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 2_100_000, completion_tokens: 1000 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // Answers at once the first time, most of what it was sent read from its cache; slowly after.
    if (/cached-then-slow/.test(String(body.model)) && !cutOff.has(body.model)) {
      cutOff.add(body.model);
      request.finished = true;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Noted.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 900 } } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // Runs into its output limit the first time, a long way in, and is slow the second.
    if (/cut-long/.test(String(body.model)) && !cutOff.has(body.model)) {
      cutOff.add(body.model);
      request.finished = true;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(4000) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 1000 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const say = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    const onlyThinks = /only-think/.test(String(body.model));
    const quick = /quick/.test(String(body.model));
    if (onlyThinks) say({ reasoning: 'Weighing the question. ' });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (onlyThinks) {
        say({ reasoning: `thought ${n}. ` });
        return;
      }
      request.words = n;
      say({ content: `word${n} ` });
      if (quick && n >= 3) {
        clearInterval(timer);
        request.finished = true;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }, 40);
    res.on('close', () => {
      clearInterval(timer);
      if (!request.finished) request.closedAt = Date.now();
    });
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { createApp } = await import('../server/app.js');
const { setApiKey, addApiKey, setPrefs } = await import('../server/settings.js');

const password = 'a-sufficiently-long-password';
await store.createUser({ id: 'u-stop', email: 'stop@example.com', name: 'Stop', passwordHash: await hashPassword(password), role: 'user' });
await setApiKey('u-stop', 'openai', 'sk-test-key');
await setPrefs('u-stop', { policy: 'auto', qualityGate: false });
await store.createUser({ id: 'u-other', email: 'other@example.com', name: 'Other', passwordHash: await hashPassword(password), role: 'user' });

const app = createApp().listen(0, '127.0.0.1');
await new Promise((r) => app.once('listening', r));
const base = `http://127.0.0.1:${app.address().port}`;
const login = async (email) => (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
const cookie = await login('stop@example.com');
const call = async (method, url, body, who = cookie) => {
  const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', Cookie: who }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

/** Start a turn, reading the stream until asked to walk away. */
function startRun(chatId, body = {}, who = cookie) {
  const abort = new AbortController();
  const events = [];
  const finished = (async () => {
    const res = await fetch(`${base}/api/chats/${chatId}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: who }, body: JSON.stringify(body), signal: abort.signal });
    if (!res.ok) {
      events.push({ refused: res.status });
      return;
    }
    let buffer = '';
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        if (name) events.push({ name, data: JSON.parse(/^data: (.+)$/m.exec(frame)?.[1] || '{}') });
      }
    }
  })().catch(() => {});
  return { abort, events, finished };
}

const newChat = async (text = 'Write me something long', who = cookie) => {
  const { chat } = (await call('POST', '/api/chats', { model: 'openai/slow' }, who)).json;
  await call('POST', `/api/chats/${chat.id}/messages`, { text }, who);
  return chat.id;
};
const words = (events) => events.filter((e) => e.name === 'text').length;
const stored = async (chatId) => store.listMessages('u-stop', chatId);

section('stopping: the provider stops being asked straight away');
{
  const chatId = await newChat();
  const run = startRun(chatId, { model: 'openai/slow-writer' });
  check('the model started writing', await until(() => words(run.events) >= 3), `${words(run.events)} words`);
  const asked = requests.at(-1);
  const pressed = Date.now();
  // The browser's own order: tell the server, drop the connection.
  const stopped = await call('POST', `/api/chats/${chatId}/stop`, {});
  run.abort.abort();
  check('the stop was heard', stopped.json?.stopped === true, JSON.stringify(stopped.json));
  check('the provider socket closed', await until(() => asked.closedAt > 0, 4000));
  check('within half a second on the same instance', asked.closedAt - pressed < 500, `${asked.closedAt - pressed} ms`);

  const said = await until(async () => (await stored(chatId)).some((m) => m.role === 'assistant' && m.stopped));
  check('what was written is kept, marked as stopped', said);
  const kept = (await stored(chatId)).find((m) => m.role === 'assistant');
  check('up to where it stopped', /word1 word2 word3/.test(kept?.text || ''), kept?.text);
  check('with no tool calls left to run', !kept?.toolCalls?.length);

  const booked = await until(async () => (await store.usageThisMonth('u-stop')).tokens > 0);
  check('and the words that were read are on the books', booked, JSON.stringify(await store.usageThisMonth('u-stop')));
}

section('stopping from another instance: the run notices by itself, without the socket closing');
{
  const chatId = await newChat();
  const run = startRun(chatId, { model: 'openai/slow-writer-2' });
  await until(() => words(run.events) >= 2);
  const asked = requests.at(-1);
  // What another serverless instance can do: take the lease away, in the database, and nothing else.
  const pressed = Date.now();
  await store.stopChatRun('u-stop', chatId);
  check('the run stops itself within about two seconds', await until(() => asked.closedAt > 0, 4000), `${asked.closedAt ? asked.closedAt - pressed : 'never'} ms`);
  check('not at the old fifteen-second heartbeat', asked.closedAt > 0 && asked.closedAt - pressed < 3000, `${asked.closedAt - pressed} ms`);
  run.abort.abort();
  await run.finished;
}

section('a thought is kept too: a turn stopped before it said anything does not vanish');
{
  const chatId = await newChat();
  const run = startRun(chatId, { model: 'openai/only-think' });
  check('it was thinking', await until(() => run.events.some((e) => e.name === 'thinking')));
  const asked = requests.at(-1);
  await call('POST', `/api/chats/${chatId}/stop`, {});
  run.abort.abort();
  await until(() => asked.closedAt > 0);
  check('the reasoning is stored', await until(async () => (await stored(chatId)).some((m) => m.role === 'assistant' && m.stopped && m.thinking)));
}

section('stop, change model, send: nothing lands out of order and the old model stays stopped');
{
  const chatId = await newChat();
  const first = startRun(chatId, { model: 'openai/slow-writer-3' });
  await until(() => words(first.events) >= 3);
  const old = requests.at(-1);
  await call('POST', `/api/chats/${chatId}/stop`, {});
  first.abort.abort();
  // The very next thing, with no pause: the stopped reply has to be in the transcript first.
  await call('POST', `/api/chats/${chatId}/messages`, { text: 'Now use this model instead' });
  const second = startRun(chatId, { model: 'openai/quick-new' });
  check('the new turn runs', await until(() => second.events.some((e) => e.name === 'done')), JSON.stringify(second.events.slice(0, 3)));
  const roles = (await stored(chatId)).map((m) => `${m.role}${m.stopped ? ':stopped' : ''}`);
  const stoppedAt = roles.indexOf('assistant:stopped');
  const askedAt = roles.lastIndexOf('user');
  check('the stopped reply comes before the new question', stoppedAt > -1 && stoppedAt < askedAt, roles.join(','));
  const seen = requests.at(-1);
  check('the request went to the new model', seen.model === 'quick-new', seen.model);
  check('and it was given what the old one said', JSON.stringify(seen.messages).includes('word1 word2'));
  check('the old model was cut off', old.closedAt > 0);
  await second.finished;
}

section('changing model mid-answer: the new model carries on from where the old one stopped');
{
  const chatId = await newChat();
  const first = startRun(chatId, { model: 'openai/slow-writer-4' });
  await until(() => words(first.events) >= 3);
  const old = requests.at(-1);
  await call('POST', `/api/chats/${chatId}/stop`, {});
  first.abort.abort();
  const second = startRun(chatId, { model: 'openai/quick-next', handoff: true });
  check('the turn carries on', await until(() => second.events.some((e) => e.name === 'done')));
  check('the old model was cut off first', old.closedAt > 0);
  const seen = requests.at(-1);
  const sent = JSON.stringify(seen.messages);
  check('the new model sees the half-written reply', sent.includes('word1 word2'));
  check('and is told to go on from there, naming no key or stall', /changed the model/i.test(sent) && /do not (?:start over|repeat)/i.test(sent), sent.slice(-400));
  const said = (await stored(chatId)).filter((m) => m.role === 'assistant');
  check('both are kept, in order', said.length === 2 && said[0].stopped === true && !said[1].stopped, JSON.stringify(said.map((m) => [m.stopped, m.text])));
  check('the note is not stored as something the person said', !(await stored(chatId)).some((m) => m.role === 'user' && /changed the model/i.test(m.text || '')));
  await second.finished;
}

section('a thought with no words is not sent to the next model as an empty reply');
{
  const chatId = await newChat();
  const first = startRun(chatId, { model: 'openai/only-think-2' });
  await until(() => first.events.some((e) => e.name === 'thinking'));
  const old = requests.at(-1);
  await call('POST', `/api/chats/${chatId}/stop`, {});
  first.abort.abort();
  await until(() => old.closedAt > 0);
  const second = startRun(chatId, { model: 'openai/quick-after-thought' });
  await until(() => second.events.some((e) => e.name === 'done'));
  const seen = requests.at(-1);
  const blank = (seen.messages || []).filter((m) => m.role === 'assistant' && !String(m.content || '').trim() && !m.tool_calls);
  check('no empty assistant turn reaches the provider', !blank.length, JSON.stringify(seen.messages?.map((m) => m.role)));
  check('and the question is still the last thing it was asked', seen.messages?.at(-1)?.role === 'user');
  await second.finished;
}

section('what a stop books: only what this request spent');
{
  const { stoppedUsage } = await import('../server/agent.js');
  const only = stoppedUsage({ text: 'abcdefgh', thinking: 'abcd', drafted: 4 }, 100);
  check('an estimate of what came back, and what it was sent', only.output === 4 && only.input === 100, JSON.stringify(only));

  // Owner, 2026-11-08: a cached conversation's stop was priced as if nothing were cached.
  const before = { input: 1000, cacheRead: 900 };
  check('what the provider had cached last time is booked as read from its cache', stoppedUsage({ text: 'x' }, 1200, before).cacheRead === 900);
  check('  never more than was read then: what came after is new to the cache', stoppedUsage({ text: 'x' }, 5000, before).cacheRead === 900);
  check('  a smaller prompt (a fold) keeps only the share', stoppedUsage({ text: 'x' }, 500, before).cacheRead === 450);
  check('  and nothing to go by is full price, as before', !('cacheRead' in stoppedUsage({ text: 'x' }, 1200, { input: 1000 })) && !('cacheRead' in stoppedUsage({ text: 'x' }, 1200, null)));
  const { estimateCost } = await import('../server/providers/catalog.js');
  const entry = { price: { in: 3, out: 15 } };
  const cached = estimateCost(entry, stoppedUsage({ text: '' }, 1200, before));
  check('  so it is priced at the cache rate', Math.abs(cached - (300 + 900 * 0.1) / 1e6 * 3) < 1e-12 && cached < estimateCost(entry, stoppedUsage({ text: '' }, 1200)), String(cached));
}

section('a stop on a cached conversation books its cache reads');
{
  await store.createUser({ id: 'u-cache', email: 'cache@example.com', name: 'Cache', passwordHash: await hashPassword(password), role: 'user' });
  await setApiKey('u-cache', 'openai', 'sk-cache-key');
  await setPrefs('u-cache', { policy: 'auto', qualityGate: false });
  const who = await login('cache@example.com');
  const chatId = await newChat('Remember this', who);
  await startRun(chatId, { model: 'openai/cached-then-slow-1' }, who).finished;
  const first = await store.usageThisMonth('u-cache');
  await call('POST', `/api/chats/${chatId}/messages`, { text: 'Now write something long' }, who);
  const run = startRun(chatId, { model: 'openai/cached-then-slow-1' }, who);
  await until(() => words(run.events) >= 3);
  await call('POST', `/api/chats/${chatId}/stop`, {}, who);
  run.abort.abort();
  await run.finished;
  const booked = await until(async () => (await store.usageThisMonth('u-cache')).calls > first.calls);
  const after = await store.usageThisMonth('u-cache');
  check('the first answer said what it read from its cache', first.cacheRead === 900, JSON.stringify(first));
  check('  and the stopped one is booked with cache reads of its own', booked && after.cacheRead > first.cacheRead && after.cacheRead - first.cacheRead <= 900, JSON.stringify(after));
}

section('a stop books what that request cost, and no more');
{
  // A key refused says something, and nothing has been answered.
  await store.createUser({ id: 'u-silent', email: 'silent@example.com', name: 'Silent', passwordHash: await hashPassword(password), role: 'user' });
  await setApiKey('u-silent', 'openai', 'sk-refuse-key-1');
  await addApiKey('u-silent', 'openai', 'sk-second-key-2');
  await setPrefs('u-silent', { policy: 'auto', qualityGate: false });
  const who = await login('silent@example.com');
  const chatId = await newChat('Are you there?', who);
  const run = startRun(chatId, { model: 'openai/silent-one' }, who);
  const refused = await until(() => run.events.some((e) => e.name === 'status' && /refused/.test(e.data?.message || '')));
  check('the first key was refused, out loud', refused, JSON.stringify(run.events.slice(0, 4)));
  await until(() => requests.at(-1)?.auth.includes('second-key'));
  await call('POST', `/api/chats/${chatId}/stop`, {}, who);
  run.abort.abort();
  await run.finished;
  await sleep(200);
  check('a stop with nothing answered books nothing', (await store.usageThisMonth('u-silent')).tokens === 0, JSON.stringify(await store.usageThisMonth('u-silent')));

  // A long reply: the first part ended and was booked; the second was stopped.
  await store.createUser({ id: 'u-long', email: 'long@example.com', name: 'Long', passwordHash: await hashPassword(password), role: 'user' });
  await setApiKey('u-long', 'openai', 'sk-long-key');
  await setPrefs('u-long', { policy: 'auto', qualityGate: false });
  const long = await login('long@example.com');
  const longChat = await newChat('Write me something very long', long);
  const longRun = startRun(longChat, { model: 'openai/cut-long-1' }, long);
  await until(() => words(longRun.events) >= 4);
  const sent = longRun.events.find((e) => e.name === 'context')?.data;
  await call('POST', `/api/chats/${longChat}/stop`, {}, long);
  longRun.abort.abort();
  await longRun.finished;
  await sleep(200);
  const { tokens } = await store.usageThisMonth('u-long');
  const firstPart = 1100;
  const asked = Number(sent?.breakdown?.used ?? sent?.used) || 0;
  check('the part that ended is not booked a second time when the next is stopped', asked > 0 && tokens >= firstPart + asked && tokens - firstPart - asked < 300, JSON.stringify({ tokens, asked }));
}

section('changing model on a reply that had already finished');
{
  const chatId = await newChat('Say something short');
  const first = startRun(chatId, { model: 'openai/quick-done' });
  await first.finished;
  const before = requests.length;
  const second = startRun(chatId, { model: 'openai/quick-next', handoff: true });
  await second.finished;
  check('the new model is not asked anything', requests.length === before, `${requests.length - before} extra`);
  check('the turn ends, with nothing added', second.events.some((e) => e.name === 'done') && (await stored(chatId)).filter((m) => m.role === 'assistant').length === 1);
}

section('a dead key of your own is no way past the deployment key\'s ceiling');
{
  // A deployment that pays for a paid model on its own key — what these ceilings exist for.
  // With FREE_TIER_ONLY on (the default) that key serves free models only (data-route.test).
  const freeOnlyWas = process.env.FREE_TIER_ONLY;
  process.env.FREE_TIER_ONLY = 'false';
  process.env.OPENAI_API_KEY = 'sk-deployment-key';
  await store.createUser({ id: 'u-over', email: 'over@example.com', name: 'Over', passwordHash: await hashPassword(password), role: 'user' });
  await store.updateUser('u-over', { monthlyTokenLimit: 10 });
  await store.recordUsage('u-over', { id: 'over-1', chatId: null, model: 'm', inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, role: 'turn' });
  await setApiKey('u-over', 'openai', 'sk-refuse-key-3');
  await setPrefs('u-over', { policy: 'auto', qualityGate: false });
  const over = await login('over@example.com');
  const chatId = await newChat('One more', over);
  const before = requests.length;
  const run = startRun(chatId, { model: 'openai/quick-over' }, over);
  await run.finished;
  const reached = requests.slice(before).map((r) => r.auth);
  check('over the ceiling, the deployment key is not used', reached.length > 0 && !reached.some((a) => a.includes('deployment')), JSON.stringify(reached.map((a) => a.slice(-12))));
  check('it says the key was refused', run.events.some((e) => e.name === 'error' && /refused/.test(e.data?.message || '')), JSON.stringify(run.events.filter((e) => e.name === 'error')));

  await store.createUser({ id: 'u-under', email: 'under@example.com', name: 'Under', passwordHash: await hashPassword(password), role: 'user' });
  await store.updateUser('u-under', { monthlyTokenLimit: 1_000_000 });
  await setApiKey('u-under', 'openai', 'sk-refuse-key-4');
  await setPrefs('u-under', { policy: 'auto', qualityGate: false });
  const under = await login('under@example.com');
  const underChat = await newChat('One more', under);
  const start = requests.length;
  const underRun = startRun(underChat, { model: 'openai/quick-under' }, under);
  await underRun.finished;
  check('under it, the deployment key still answers', requests.slice(start).some((r) => r.auth.includes('deployment')) && underRun.events.some((e) => e.name === 'done'));

  // Owner, 2026-11-08: the monthly ceiling applied from the moment the deployment's key did, the per-turn limit did not.
  delete process.env.MAX_TURN_TOKENS;
  await store.createUser({ id: 'u-huge', email: 'huge@example.com', name: 'Huge', passwordHash: await hashPassword(password), role: 'user' });
  await store.updateUser('u-huge', { monthlyTokenLimit: 100_000_000 });
  await setApiKey('u-huge', 'openai', 'sk-refuse-key-5');
  await setPrefs('u-huge', { policy: 'auto', qualityGate: false });
  const huge = await login('huge@example.com');
  const hugeFrom = requests.length;
  await startRun(await newChat('Write it all', huge), { model: 'openai/cut-huge-1' }, huge).finished;
  const onDeployment = requests.slice(hugeFrom).filter((r) => r.auth.includes('deployment'));
  check('the deployment key\'s per-turn limit holds from the moment it is used', onDeployment.length === 1, `${onDeployment.length} requests on it`);
  await store.createUser({ id: 'u-own-huge', email: 'own-huge@example.com', name: 'Own', passwordHash: await hashPassword(password), role: 'user' });
  await setApiKey('u-own-huge', 'openai', 'sk-own-huge-key');
  await setPrefs('u-own-huge', { policy: 'auto', qualityGate: false });
  const own = await login('own-huge@example.com');
  const ownFrom = requests.length;
  await startRun(await newChat('Write it all', own), { model: 'openai/cut-huge-2' }, own).finished;
  check('  and not on the account\'s own key, which has none', requests.slice(ownFrom).filter((r) => /own-huge/.test(r.auth)).length > 1);

  // What a provider says about the deployment's key is not this account's to read.
  process.env.OPENAI_API_KEY = 'sk-refuse-key-deployment';
  await store.createUser({ id: 'u-plain', email: 'plain@example.com', name: 'Plain', passwordHash: await hashPassword(password), role: 'user' });
  await setPrefs('u-plain', { policy: 'auto', qualityGate: false });
  const plain = await login('plain@example.com');
  const plainRun = startRun(await newChat('Hello', plain), { model: 'openai/quick-plain' }, plain);
  await plainRun.finished;
  const told = JSON.stringify(plainRun.events.filter((e) => e.name === 'error'));
  check('the deployment key refused: it says so, and not what the provider said about it', /refused/.test(told) && !/afford|1141/.test(told), told);
  delete process.env.OPENAI_API_KEY;
  if (freeOnlyWas === undefined) delete process.env.FREE_TIER_ONLY;
  else process.env.FREE_TIER_ONLY = freeOnlyWas;
}

section('a run that has already finished, or someone else\'s, is not stopped');
{
  const chatId = await newChat();
  const run = startRun(chatId, { model: 'openai/quick-done' });
  await until(() => run.events.some((e) => e.name === 'done'));
  await run.finished;
  const again = await call('POST', `/api/chats/${chatId}/stop`, {});
  check('stopping nothing is harmless', again.status === 200 && again.json?.stopped === false, JSON.stringify(again.json));
  const other = await login('other@example.com');
  const running = await newChat();
  const live = startRun(running, { model: 'openai/slow-writer-5' });
  await until(() => words(live.events) >= 2);
  const foreign = await call('POST', `/api/chats/${running}/stop`, {}, other);
  check('another account cannot stop it', foreign.status === 404, String(foreign.status));
  await sleep(300);
  check('and it keeps writing', !requests.at(-1).closedAt);
  await call('POST', `/api/chats/${running}/stop`, {});
  live.abort.abort();
  await live.finished;
}

await new Promise((r) => app.close(r));
provider.closeAllConnections?.();
provider.close();
removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mA stop is a stop.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
