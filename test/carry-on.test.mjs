/**
 * A turn carried on past one function's time (server/turnContinue.js, owner 2026-11-12: "tự
 * động tiếp tục full hết", free and paid models alike) — by the browser when it is there, by
 * the server asking itself when it is not, and never by both.
 *
 *   node test/carry-on.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'carry-on-test-encryption-key-long-enough-0001';
process.env.SESSION_SECRET ||= 'carry-on-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-carry-on-test-${process.pid}`);
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

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
const { continueTurn } = await import('../server/turnContinue.js');

const user = await store.createUser({ id: 'u-carry', role: 'user', name: 'C', email: 'c@carry.test', passwordHash: 'x' });
const chat = await store.createChat(user.id, { id: 'c-carry', title: 'long one' });
const runId = crypto.randomUUID();

/** A turn's part that stopped for time and let the lease go: its sequence. */
const partEnded = async (id = runId) => {
  const seq = await store.claimChatRun(user.id, chat.id, id);
  await store.releaseChatRun(user.id, chat.id, id, seq);
  return seq;
};
const stub = (continuing) => {
  const seen = [];
  const run = async (opts) => {
    seen.push(opts);
    opts.emit('done', continuing ? { stopReason: 'time_limit', stop: { kind: 'time_limit', continuing: true } } : { stopReason: 'end_turn' });
  };
  return { run, seen };
};

section('nobody came back: the server carries the turn on itself');
{
  const afterSeq = await partEnded();
  const chained = [];
  const { run, seen } = stub(true);
  const out = await continueTurn({ userId: user.id, chatId: chat.id, runId, afterSeq, run, chain: (t) => chained.push(t), graceMs: 0 });
  check('it runs the turn on, as the same run, able to carry on again', out.status === 'ran' && seen.length === 1 && seen[0].canContinue === true && seen[0].chatId === chat.id && seen[0].modelId === null, JSON.stringify(out));
  check('  and asks for the next part, after its own holding of the lease', chained.length === 1 && chained[0].afterSeq > afterSeq && chained[0].runId === runId, JSON.stringify(chained));
  const holder = await store.chatRunHolder(user.id, chat.id);
  check('  letting the lease go when it is done', !holder?.run_lock_by || holder.run_lock_at == null, JSON.stringify(holder));
}

section('the browser came back first: the server stands down');
{
  const afterSeq = await partEnded();
  // The browser asks again with the same run id a moment later — a newer holding.
  await partEnded();
  const { run, seen } = stub(true);
  const chained = [];
  const out = await continueTurn({ userId: user.id, chatId: chat.id, runId, afterSeq, run, chain: (t) => chained.push(t), graceMs: 0 });
  check('a newer holding of the lease means somebody carried it on: nothing runs twice', out.status === 'taken' && seen.length === 0 && chained.length === 0, JSON.stringify(out));
}

section('stopped, or held by another run: it does not start');
{
  const seq = await store.claimChatRun(user.id, chat.id, runId);
  await store.stopChatRun(user.id, chat.id);
  const { run, seen } = stub(true);
  const stopped = await continueTurn({ userId: user.id, chatId: chat.id, runId, afterSeq: seq, run, chain: () => {}, graceMs: 0 });
  check('a stop pressed on the turn is kept', stopped.status === 'stopped' && seen.length === 0, JSON.stringify(stopped));
  await store.clearRunStop(user.id, chat.id);

  const other = crypto.randomUUID();
  const held = await store.claimChatRun(user.id, chat.id, other);
  const busy = await continueTurn({ userId: user.id, chatId: chat.id, runId, afterSeq: held, run, chain: () => {}, graceMs: 0 });
  check('  a conversation another run is holding is left to it', busy.status === 'busy' && seen.length === 0, JSON.stringify(busy));
  await store.releaseChatRun(user.id, chat.id, other, held);
}

section('a part that finishes does not ask for another');
{
  const afterSeq = await partEnded();
  const { run } = stub(false);
  const chained = [];
  const out = await continueTurn({ userId: user.id, chatId: chat.id, runId, afterSeq, run, chain: (t) => chained.push(t), graceMs: 0 });
  check('finished: no next part', out.status === 'ran' && out.stopReason === 'end_turn' && chained.length === 0, JSON.stringify(out));
}

await db.close();
removeTemp(process.env.DATA_DIR);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
