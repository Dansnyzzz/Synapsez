/**
 * Compaction suite: which turns are kept, and what the person sees while the
 * rest is summarised. No network and no browser.
 *
 *   node test/compact.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'compact-test-encryption-key';
process.env.SESSION_SECRET ||= 'compact-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-compact-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { tailStart, shouldCompact, compact, activeTranscript } = await import('../server/compact.js');

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const user = await store.createUser({
  id: 'u-compact',
  email: 'compact@example.com',
  name: 'Compact',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

/** A message worth exactly `tokens` by the estimate (four characters each). */
let seq = 0;
const say = (role, tokens, extra = {}) => ({ id: `m${seq}`, seq: seq++, role, text: 'x'.repeat(tokens * 4), ...extra });
const size = (messages) => messages.reduce((sum, m) => sum + Math.ceil((m.text || '').length / 4) + (m.results || []).reduce((s, r) => s + Math.ceil(String(r.content).length / 4), 0), 0);

section('the tail is chosen by size, not by count');
{
  seq = 0;
  const WINDOW = 262_000;
  const budget = Math.floor(WINDOW * 0.1);
  const chat = [say('user', 200), say('assistant', 60_000)];
  for (let i = 0; i < 5; i += 1) chat.push(say('user', 300), say('assistant', 700));
  const start = tailStart(chat, { window: WINDOW });
  check('a 60K-token old reply is folded', start >= 2, `tail starts at ${start} of ${chat.length}`);
  check('the tail is at most 10% of a 262K window', size(chat.slice(start)) <= budget, `${size(chat.slice(start))} of ${budget}`);
  check('every short recent turn is still kept', start === 2, `start ${start}`);
  check('the tail begins on a user message', chat[start].role === 'user');
}

section('the latest user message and what follows it are always kept');
{
  seq = 0;
  const chat = [say('user', 100), say('assistant', 100), say('user', 90_000), say('assistant', 5_000)];
  const start = tailStart(chat, { window: 262_000 });
  check('a latest user message over the whole budget is kept whole, with its reply', start === 2, `start ${start}`);

  seq = 0;
  const run = [say('user', 100), say('assistant', 100), say('user', 70_000), say('assistant', 2_000), say('tool', 0, { results: [{ content: 'x'.repeat(8000) }] }), say('assistant', 300)];
  const kept = tailStart(run, { window: 262_000 });
  check('the huge user message and everything after it stay', kept === 2 && size(run.slice(kept)) > 70_000, `start ${kept}`);
}

section('a tool call is never separated from its result');
{
  seq = 0;
  const chat = [
    say('user', 800),
    say('assistant', 100, { toolCalls: [{ id: 'a', name: 'read_file', input: {} }] }),
    say('tool', 0, { results: [{ content: 'x'.repeat(40_000) }] }),
    say('assistant', 900),
    say('user', 1_000),
    say('assistant', 200, { toolCalls: [{ id: 'b', name: 'read_file', input: {} }] }),
    say('tool', 0, { results: [{ content: 'x'.repeat(4_000) }] }),
    say('assistant', 300),
  ];
  let bad = '';
  for (let window = 2_000; window <= 400_000; window += 1_500) {
    const start = tailStart(chat, { window });
    if (chat[start].role !== 'user' || start > 4) bad += `${window}:${start} `;
  }
  check('no window puts the boundary on a tool result or after the newest question', bad === '', bad);
  check('the tail begins on a user message at every size', [2_000, 20_000, 80_000, 300_000].every((window) => chat[tailStart(chat, { window })].role === 'user'));
}

section('the window sets the budget, with a floor');
{
  seq = 0;
  const chat = [];
  for (let i = 0; i < 6; i += 1) chat.push(say('user', 1_000), say('assistant', 1_000));
  const small = tailStart(chat, { window: 32_000 });
  check('a 32K window keeps 4,000 tokens, not the 3,200 a tenth would give', size(chat.slice(small)) === 4_000, String(size(chat.slice(small))));
  const wide = tailStart(chat, { window: 1_000_000 });
  check('a 1M window keeps all of a small conversation', wide === 0);
}

section('deciding whether there is anything to fold');
{
  seq = 0;
  const entry = { context: 100_000 };
  const tiny = [say('user', 100), say('assistant', 100, { usage: { input: 92_000 } })];
  check('false when nothing lies before the tail, however full the gauge says it is', shouldCompact(tiny, entry, { maxOutput: 10_000 }) === false);
  seq = 0;
  const heavy = [];
  for (let i = 0; i < 8; i += 1) heavy.push(say('user', 3_000), say('assistant', 3_000));
  heavy.push({ ...say('assistant', 100), usage: { input: 90_000 } });
  check('true when older turns do not fit the tail', shouldCompact(heavy, entry, { maxOutput: 10_000 }) === true);
}

section('progress while the summary is written');
{
  await store.createChat(user.id, { id: 'c-prog', title: 'Progress', model: 'm' });
  const entry = { id: 'x/y', provider: 'anthropic', model: 'y', context: 100_000, maxOutput: 4_000 };
  const build = () => {
    seq = 0;
    const m = [];
    for (let i = 0; i < 12; i += 1) m.push(say('user', 3_000), say('assistant', 3_000));
    return m;
  };
  const burst = async function* () {
    for (let i = 0; i < 60; i += 1) yield { type: 'text', delta: 'word '.repeat(10) };
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };

  const all = [];
  await compact({ userId: user.id, chatId: 'c-prog', entry, prefs: {}, messages: build(), stream: burst, onProgress: (p) => all.push(p), progressEveryMs: 0 });
  const withNumbers = all.filter((p) => typeof p.written === 'number');
  check('events carry written and expected', withNumbers.length > 5 && withNumbers.every((p) => p.expected > 0), JSON.stringify(withNumbers.at(-1)));
  check('the count of folded turns rides along', all.every((p) => p.folding > 0));
  check('written never decreases', withNumbers.every((p, i) => i === 0 || p.written >= withNumbers[i - 1].written));
  check('expected holds still', new Set(withNumbers.map((p) => p.expected)).size === 1);
  check('expected stays inside the summary request\'s own limit', withNumbers[0].expected <= 4_000, String(withNumbers[0].expected));

  const quick = [];
  await compact({ userId: user.id, chatId: 'c-prog', entry, prefs: {}, messages: build(), stream: burst, onProgress: (p) => quick.push(p) });
  check('a burst of sixty chunks is not sixty events', quick.filter((p) => typeof p.written === 'number').length <= 3, String(quick.length));

  const slow = async function* () {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: 'text', delta: 'word '.repeat(10) };
    }
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };
  const paced = [];
  const t0 = Date.now();
  await compact({ userId: user.id, chatId: 'c-prog', entry, prefs: {}, messages: build(), stream: slow, onProgress: (p) => paced.push(p) });
  const seconds = (Date.now() - t0) / 1000;
  const numbered = paced.filter((p) => typeof p.written === 'number');
  check('over a second, at most a few events a second', numbered.length >= 2 && numbered.length <= Math.ceil(seconds * 4) + 1, `${numbered.length} in ${seconds.toFixed(1)}s`);
  check('and still never backwards', numbered.every((p, i) => i === 0 || p.written >= numbered[i - 1].written));
}

section('what the summary stands for is unchanged');
{
  seq = 0;
  const chat = [];
  for (let i = 0; i < 14; i += 1) chat.push(say(i % 2 ? 'assistant' : 'user', 1_500));
  await store.createChat(user.id, { id: 'c-covers', title: 'Covers', model: 'm' });
  const stream = async function* () {
    yield { type: 'text', delta: 'A summary.' };
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };
  const summary = await compact({ userId: user.id, chatId: 'c-covers', entry: { context: 100_000 }, prefs: {}, messages: chat, stream });
  const start = tailStart(chat, { window: 100_000 });
  check('covers is the last folded message, by seq', summary.covers === chat[start - 1].seq, `${summary.covers} vs ${chat[start - 1].seq}`);
  check('and replaced counts what was folded', summary.replaced === start);
  const sent = activeTranscript([...chat, summary]);
  check('the model gets the summary and exactly the kept tail', sent.length === 1 + (chat.length - start));
}

section('a long turn is folded inside itself, and the question survives');
{
  const entry = { context: 128_000, maxOutput: 8_000 };
  const quiet = async function* () {
    yield { type: 'text', delta: 'A summary of the work so far.' };
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };
  const step = (i) => [
    say('assistant', 100, { toolCalls: [{ id: `t${seq}`, name: 'read_file', input: {} }] }),
    say('tool', 0, { results: [{ content: 'x'.repeat(40_000) }] }),
  ];
  const full = (m) => {
    const last = m.findLast((x) => x.role === 'assistant');
    last.usage = { input: 110_000 };
  };
  const fold = async (chatId, messages) => {
    const summary = await compact({ userId: user.id, chatId, entry, prefs: {}, messages, stream: quiet });
    if (summary) messages.push(summary);
    return summary;
  };

  // Two earlier turns, then a question and twelve steps of about 10K each: what an agent run does.
  await store.createChat(user.id, { id: 'c-long', title: 'Long turn', model: 'm' });
  seq = 0;
  const m = [say('user', 3000), say('assistant', 3000), say('user', 3000), say('assistant', 3000)];
  const asked = { id: 'q', seq: seq++, role: 'user', text: 'THE QUESTION: rebuild the report from every file' };
  m.push(asked);
  for (let i = 0; i < 12; i += 1) m.push(...step(i));
  full(m);
  check('a long run over the line is folded', shouldCompact(m, entry) === true);
  const s1 = await fold('c-long', m);
  check('the first fold folds the earlier turns', s1?.replaced === 4 && Number.isFinite(s1.covers), JSON.stringify([s1?.replaced, s1?.covers]));
  check('the kept summary carries its seq, so a later fold can place it', Number.isFinite(s1?.seq), String(s1?.seq));

  for (let i = 0; i < 4; i += 1) m.push(...step(i));
  full(m);
  check('the run goes on, still over the line', shouldCompact(m, entry) === true);
  const s2 = await fold('c-long', m);
  check('the second fold lands', !!s2 && Number.isFinite(s2.covers), String(s2?.covers));
  const sent = activeTranscript(m);
  check('what is sent still holds the question, word for word', sent.some((x) => /THE QUESTION: rebuild the report from every file/.test(x.text || '')));
  check('the transcript does not start on a tool result', sent[1]?.role !== 'tool' && sent[0].role === 'user');
  check('the newest step is kept', sent.at(-1).id === m.filter((x) => x.role === 'tool').at(-1).id);
  check('a tool result is never first after the summary, and no call is cut from its result', sent.every((x, i) => x.role !== 'tool' || sent[i - 1]?.toolCalls?.length));
  check('the first summary is not sent twice', sent.filter((x) => /A summary of the work/.test(x.text || '')).length === 1);
  for (let i = 0; i < 4; i += 1) m.push(...step(i));
  full(m);
  const s3 = await fold('c-long', m);
  const again = activeTranscript(m);
  check('a third fold keeps the request once, not twice', !!s3 && (again[0].text.match(/word for word: THE QUESTION/g) || []).length === 1, String((again[0].text.match(/THE QUESTION/g) || []).length));
}

section('a long first turn can be folded');
{
  const entry = { context: 128_000, maxOutput: 8_000 };
  await store.createChat(user.id, { id: 'c-first', title: 'First turn', model: 'm' });
  seq = 0;
  const m = [{ id: 'q1', seq: seq++, role: 'user', text: 'FIRST QUESTION: audit everything' }];
  for (let i = 0; i < 12; i += 1) m.push(say('assistant', 100, { toolCalls: [{ id: `f${i}`, name: 'read_file', input: {} }] }), say('tool', 0, { results: [{ content: 'x'.repeat(40_000) }] }));
  m.push({ ...say('assistant', 100), usage: { input: 110_000 } });
  check('over the line with the question first, there is something to fold', shouldCompact(m, entry) === true);
  const stream = async function* () {
    yield { type: 'text', delta: 'Early steps summarised.' };
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };
  const summary = await compact({ userId: user.id, chatId: 'c-first', entry, prefs: {}, messages: m, stream });
  check('and it folds the early steps (a manual press works too)', !!summary && summary.replaced > 1, String(summary?.replaced));
  m.push(summary);
  const sent = activeTranscript(m);
  check('the question is kept word for word', /FIRST QUESTION: audit everything/.test(sent[0].text));
  check('the newest step is still there, after a whole step boundary', sent.at(-1).id === m.at(-2).id && sent[1].role === 'assistant');
}

section('nothing is folded when there is nothing to gain');
{
  const entry = { context: 128_000, maxOutput: 8_000 };
  seq = 0;
  const only = [{ id: 's', seq: seq++, role: 'summary', text: 'old', covers: -1 }, say('user', 200), say('assistant', 100, { usage: { input: 118_000 } })];
  check('a summary and a short turn are not folded again', shouldCompact(only, entry) === false);

  seq = 0;
  const small = { context: 8_191, maxOutput: 4_000 };
  const lopsided = [say('user', 100), say('assistant', 100), say('user', 3_900), { ...say('assistant', 50), usage: { input: 3_400 } }];
  check('a small window whose fixed part sits near the line does not fold 200 tokens ahead of a big question', shouldCompact(lopsided, small) === false);
}

section('the summary request asks for what its figure is measured against');
{
  await store.createChat(user.id, { id: 'c-cap', title: 'Cap', model: 'm' });
  seq = 0;
  const m = [];
  for (let i = 0; i < 12; i += 1) m.push(say('user', 3_000), say('assistant', 3_000));
  let asked;
  const stream = async function* (opts) {
    asked = opts.maxTokens;
    yield { type: 'text', delta: 'word '.repeat(20) };
    yield { type: 'done', usage: { input: 1, output: 1 } };
  };
  const events = [];
  await compact({ userId: user.id, chatId: 'c-cap', entry: { id: 'x/y', provider: 'anthropic', model: 'y', context: 100_000, maxOutput: 2_000 }, prefs: {}, messages: m, stream, onProgress: (p) => events.push(p) });
  const expected = events.find((p) => p.expected)?.expected;
  check('max tokens is passed to the request', Number.isFinite(asked) && asked > 0, String(asked));
  check('and expected never exceeds it', expected <= asked, `${expected} <= ${asked}`);
}

removeTemp(process.env.DATA_DIR);
console.log(failures === 0 ? '\n\x1b[32mAll compact checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
