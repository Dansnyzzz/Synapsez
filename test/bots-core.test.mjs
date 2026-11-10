/**
 * The Bot page's core (owner, 2026-11-10, spec docs/superpowers/specs/2026-11-10-bots-core-design.md):
 * rounds that run in segments and finish what was asked, files that reach the group,
 * a reset that frees the space, memory with pins, search and undo.
 *
 * Drives the store and `runGroupRound` directly against an in-process Postgres, with
 * a stand-in for the agent loop, so a cut-off, a kill and a chained segment can be
 * staged exactly. The app's routes are exercised in test/bots.test.mjs.
 *
 *   node test/bots-core.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'bots-core-test-encryption-key';
process.env.SESSION_SECRET ||= 'bots-core-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-bots-core-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
// Its own in-memory database, with a handle for the few rows a check has to age.
const db = await PGlite.create();
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
const store = await initStore({ driver: sql });
store.query = (text, params) => sql.query(text, params);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const id = () => crypto.randomUUID();
const user = await store.createUser({ id: id(), role: 'user', name: 'Core', email: 'core@bots.test', passwordHash: 'x' });
const other = await store.createUser({ id: id(), role: 'user', name: 'Other', email: 'other@bots.test', passwordHash: 'x' });
const uid = user.id;

const chief = await store.createBot(uid, { id: id(), name: 'Chief', role: 'Chief of Staff', avatar: 'cosmic-whale', isMain: true });
const writer = await store.createBot(uid, { id: id(), name: 'Writer', role: 'Editor', avatar: 'minnow' });
const group = await store.createBotGroup(uid, { id: id(), name: 'Desk', adminBotId: chief.id, members: [chief.id, writer.id] });

/* ── Task 1: the store ─────────────────────────────────────────── */

section('a group keeps its pending round, its notice and its model');
{
  const pending = { messageId: 'm1', queue: [{ botId: writer.id, by: chief.id, report: null }], handoffs: 1, segments: 1, model: 'openai/plain', reason: 'time', working: [], lastSeq: 3, at: new Date().toISOString() };
  await store.setGroupPending(uid, group.id, pending);
  const read = await store.getBotGroup(uid, group.id);
  check('pending is read back as written', read.pending?.queue?.[0]?.botId === writer.id && read.pending.reason === 'time', JSON.stringify(read.pending));
  await store.setGroupPending(other.id, group.id, null);
  check('  another account cannot clear it', (await store.getBotGroup(uid, group.id)).pending?.reason === 'time');
  await store.setGroupModel(uid, group.id, 'openai/other');
  check('the model the chip had is kept on the group', (await store.getBotGroup(uid, group.id)).model === 'openai/other');
  const noticed = await store.updateBotGroup(uid, group.id, { notice: 'Posts go out on Fridays.' });
  check('the group notice is kept', noticed.notice === 'Posts go out on Fridays.');
  await store.setGroupPending(uid, group.id, null);
  check('and pending clears', (await store.getBotGroup(uid, group.id)).pending === null);
}

section('the heartbeat finds rounds that were cut off');
{
  const log = await store.botChat(uid, { groupId: group.id, title: group.name });
  await store.setGroupPending(uid, group.id, { queue: [{ botId: writer.id }], handoffs: 0, segments: 1, reason: 'time', at: new Date().toISOString() });
  let found = await store.listStaleGroupRounds({ staleMs: 75_000, limit: 5 });
  check('a round saved for time, with nobody holding it, is found', found.some((r) => r.group_id === group.id && r.chat_id === log.id && r.user_id === uid), JSON.stringify(found));
  const runId = id();
  await store.claimChatRun(uid, log.id, runId);
  found = await store.listStaleGroupRounds({ staleMs: 75_000, limit: 5 });
  check('  not while a live segment holds its lease', !found.some((r) => r.group_id === group.id));
  await store.releaseChatRun(uid, log.id, runId);
  await store.setGroupPending(uid, group.id, { queue: [{ botId: writer.id }], handoffs: 0, segments: 8, reason: 'time', at: new Date().toISOString() });
  found = await store.listStaleGroupRounds({ staleMs: 75_000, limit: 5 });
  check('  not once it has had its eight segments', !found.some((r) => r.group_id === group.id));
  await store.setGroupPending(uid, group.id, { queue: [{ botId: writer.id }], handoffs: 0, segments: 1, reason: 'ceiling', at: new Date().toISOString() });
  found = await store.listStaleGroupRounds({ staleMs: 75_000, limit: 5 });
  check('  not when it waits for the person (the ceiling)', !found.some((r) => r.group_id === group.id));
  await store.setGroupPending(uid, group.id, { queue: [{ botId: writer.id }], handoffs: 0, segments: 1, reason: 'running', at: new Date().toISOString() });
  found = await store.listStaleGroupRounds({ staleMs: 75_000, limit: 5 });
  check('a segment killed mid-run (still "running", lease gone) is found', found.some((r) => r.group_id === group.id));
  await store.setGroupPending(uid, group.id, null);
}

section('reset deletes a conversation and keeps the memory');
{
  const own = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  await store.appendMessage(uid, own.id, { id: id(), role: 'user', text: 'hello' });
  await store.addBotMemory(uid, { id: id(), botId: writer.id, text: 'Likes tea', source: 'user' });
  await store.resetConversation(uid, { botId: writer.id });
  const fresh = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  check("a bot's chat starts empty", fresh.id !== own.id && (await store.listMessages(uid, fresh.id)).length === 0);
  check('  its memory stays', (await store.listBotMemory(uid, { botId: writer.id })).some((m) => m.text === 'Likes tea'));

  const log = await store.botChat(uid, { groupId: group.id, title: group.name });
  const member = await store.botChat(uid, { botId: writer.id, groupId: group.id, title: 'Writer · Desk' });
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'a line' });
  await store.appendMessage(uid, member.id, { id: id(), role: 'user', text: '[Group chat "Desk"]' });
  await store.markGroupSeen(uid, group.id, writer.id, 5);
  await store.addBotMemory(uid, { id: id(), groupId: group.id, text: 'Fridays', source: 'user' });
  await store.setGroupPending(uid, group.id, { queue: [], reason: 'ceiling' });
  await store.resetConversation(other.id, { groupId: group.id });
  check('another account cannot reset it', (await store.listMessages(uid, log.id)).length === 1);
  await store.resetConversation(uid, { groupId: group.id });
  const after = await store.getBotGroup(uid, group.id);
  const newLog = await store.botChat(uid, { groupId: group.id, title: group.name });
  check("a group's log starts empty", (await store.listMessages(uid, newLog.id)).length === 0);
  check("  and every member's conversation for it is gone", (await store.getChat(uid, member.id)) == null);
  check('  where each had read to starts again', Number(after.seen?.[writer.id]) === -1, JSON.stringify(after.seen));
  check('  nothing is left pending', after.pending === null);
  check('  the group memory stays', (await store.listBotMemory(uid, { groupId: group.id })).some((m) => m.text === 'Fridays'));
}

section('memory: pins, search without accents, undo, a turn taken back');
{
  const pinned = await store.addBotMemory(uid, { id: id(), botId: chief.id, text: 'Khách hàng ở Đà Nẵng', textFolded: 'khach hang o da nang', source: 'user', pinned: true });
  check('an entry can be pinned', pinned.pinned === true);
  const found = await store.searchBotMemory(uid, { botId: chief.id }, ['da', 'nang']);
  check('search with no marks finds the marked text', found.some((r) => r.id === pinned.id), JSON.stringify(found.map((r) => r.text)));
  check('  but not another account\'s', (await store.searchBotMemory(other.id, { botId: chief.id }, ['nang'])).length === 0);
  const edited = await store.updateBotMemory(uid, pinned.id, { botId: chief.id }, { text: 'Khách hàng ở Huế', textFolded: 'khach hang o hue' });
  check('an entry can be edited in place', edited?.text === 'Khách hàng ở Huế' && edited.id === pinned.id);
  await store.softDeleteBotMemory(uid, pinned.id, { botId: chief.id });
  check('a forgotten entry is gone from the list', !(await store.listBotMemory(uid, { botId: chief.id })).some((r) => r.id === pinned.id));
  await store.restoreBotMemory(uid, [pinned.id]);
  check('  and comes back with undo', (await store.listBotMemory(uid, { botId: chief.id })).some((r) => r.id === pinned.id));
  const turn = id();
  await store.addBotMemory(uid, { id: id(), botId: chief.id, text: 'Saved in a turn that failed', source: 'bot', turnId: turn });
  await store.dropTurnMemory(uid, turn);
  check('what a stopped turn saved is taken back', !(await store.listBotMemory(uid, { botId: chief.id })).some((r) => r.text === 'Saved in a turn that failed'));
  const old = await store.addBotMemory(uid, { id: id(), botId: chief.id, text: 'Forgotten long ago', source: 'bot' });
  await store.softDeleteBotMemory(uid, old.id, { botId: chief.id });
  const recent = await store.addBotMemory(uid, { id: id(), botId: chief.id, text: 'Forgotten today', source: 'bot' });
  await store.softDeleteBotMemory(uid, recent.id, { botId: chief.id });
  await store.query("UPDATE bot_memory SET deleted_at = NOW() - interval '31 days' WHERE id = $1", [old.id]);
  await store.pruneForgottenMemory(30);
  check('the sweep lets go of what was forgotten a month ago', (await store.restoreBotMemory(uid, [old.id])) === 0);
  check('  and keeps what Undo can still bring back', (await store.restoreBotMemory(uid, [recent.id])) === 1);
  const { sweep } = await import('../server/scheduler.js');
  const before = await store.addBotMemory(uid, { id: id(), botId: chief.id, text: 'Swept by the scheduler', source: 'bot' });
  await store.softDeleteBotMemory(uid, before.id, { botId: chief.id });
  await store.query("UPDATE bot_memory SET deleted_at = NOW() - interval '40 days' WHERE id = $1", [before.id]);
  await sweep();
  check('  the scheduler sweep runs it', (await store.restoreBotMemory(uid, [before.id])) === 0);
}

section('a bot keeps its last instructions, and how often its memory is reviewed');
{
  const changed = await store.updateBot(uid, writer.id, { instructions: 'New', instructionsPrev: 'Old', instructionsChangedBy: chief.id, reviewEvery: 40, turnsSinceReview: 3 });
  check('the columns are written through the allow-list', changed.instructions_prev === 'Old' && changed.instructions_changed_by === chief.id && changed.review_every === 40 && changed.turns_since_review === 3, JSON.stringify(changed));
  const sneaky = await store.updateBot(uid, writer.id, { is_main: true, user_id: other.id });
  check('  and nothing else gets through', sneaky.is_main === false && sneaky.user_id === uid);
}

section('a conversation keeps the memory it began with');
{
  const own = await store.botChat(uid, { botId: chief.id, title: 'Chief' });
  await store.setMemorySnapshot(uid, own.id, '## Your memory, Chief\n- one');
  const read = await store.getChat(uid, own.id);
  check('the snapshot is stored on the conversation', read.memory_snapshot === '## Your memory, Chief\n- one' && !!read.memory_snapshot_at);
  await store.setMemorySnapshot(other.id, own.id, 'x');
  check('  and only its own account writes it', (await store.getChat(uid, own.id)).memory_snapshot === '## Your memory, Chief\n- one');
}

console.log(failures === 0 ? '\n\x1b[32mAll bot core checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
