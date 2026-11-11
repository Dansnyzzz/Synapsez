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

/* ── Task 2: a round in segments ───────────────────────────────── */

const { runGroupRound, MAX_SEGMENTS } = await import('../server/bots/rounds.js');

const quiet = await store.createBot(uid, { id: id(), name: 'Quiet', role: 'Listens', avatar: 'frog' });
const room = await store.createBotGroup(uid, { id: id(), name: 'Room', adminBotId: chief.id, members: [chief.id, writer.id, quiet.id] });
const nameOfChat = async (chatId) => {
  const chat = await store.getChat(uid, chatId);
  const bot = chat?.bot_id ? await store.getBot(uid, chat.bot_id) : null;
  return bot?.name || '?';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The agent loop, scripted: `plan[name]` answers for that bot — a string is its reply,
 * a function gets `{ call, prompt, chatId, deadlineAt, modelId }` and returns a reply,
 * `{ cut: true }` (stopped mid-step at the deadline), `{ throws }` or `{ wait, then }`.
 */
function fakeAgent(plan) {
  const calls = [];
  const run = async ({ chatId, emit, signal, deadlineAt, modelId, turnOrigin }) => {
    const name = await nameOfChat(chatId);
    const history = await store.listMessages(uid, chatId);
    const prompt = [...history].reverse().find((m) => m.role === 'user')?.text || '';
    const call = { name, prompt, chatId, deadlineAt, modelId, turnOrigin, users: history.filter((m) => m.role === 'user').length };
    calls.push(call);
    let step = plan[name];
    if (typeof step === 'function') step = await step(call);
    if (step && typeof step === 'object' && step.wait) {
      await sleep(step.wait);
      step = step.then;
    }
    if (signal?.aborted) return;
    if (step && step.throws) throw new Error(step.throws);
    if (step && step.cut) {
      await store.appendMessage(uid, chatId, { id: id(), role: 'assistant', text: '', toolCalls: [{ id: id(), name: 'web_search', input: { query: 'x' } }] });
      emit('error', { message: 'The request ran out of time.' });
      return;
    }
    await store.appendMessage(uid, chatId, { id: id(), role: 'assistant', text: String(step ?? '[PASS]') });
  };
  return { run, calls };
}
const roundOf = async (options) => {
  const events = [];
  const result = await runGroupRound({ user, groupId: room.id, emit: (event, data) => events.push({ event, data }), signal: new AbortController().signal, ...options });
  const posts = events.filter((e) => e.event === 'post').map((e) => e.data.message);
  return { result, events, posts };
};
const cleanRoom = async () => {
  await store.resetConversation(uid, { groupId: room.id });
  await store.setGroupModel(uid, room.id, null);
};

section('a round never ends in silence');
{
  await cleanRoom();
  const agent = fakeAgent({
    Chief: ({ prompt }) => (/What you handed on/.test(prompt) ? 'Nobody had anything; I will take it.' : '@Writer @Quiet your views?'),
    Writer: '[PASS]',
    Quiet: { throws: 'provider down' },
  });
  const { posts } = await roundOf({ text: 'Thoughts?', runAgent: agent.run });
  const report = agent.calls.filter((c) => c.name === 'Chief')[1];
  check('the asker gets its turn back when every member passed or failed', !!report, agent.calls.map((c) => c.name).join());
  check('  told who gave no answer and who could not answer', /Writer/.test(report?.prompt || '') && /gave no answer/i.test(report?.prompt || '') && /Quiet/.test(report?.prompt || '') && /could not answer/i.test(report?.prompt || ''), (report?.prompt || '').slice(-400));
  check('  and its answer is posted', posts.some((m) => /take it/.test(m.text || '')));
  const seen = (await store.getBotGroup(uid, room.id)).seen;
  const quietSeen = Number(seen[quiet.id]);
  check('a member whose turn failed has not "read" the lines it was shown', quietSeen === -1, JSON.stringify(seen));
  check('  one that answered (even with a pass) has', Number(seen[writer.id]) > -1);
}

section('the admin passing alone is said');
{
  await cleanRoom();
  const agent = fakeAgent({ Chief: '[PASS]' });
  const { posts } = await roundOf({ text: 'Anyone?', runAgent: agent.run });
  check('a notice says nobody answered and how to call someone', posts.some((m) => m.notice === 'nobody'), posts.map((m) => m.notice || m.role).join());
}

section('out of time: the round is saved and carried on, not dropped');
{
  await cleanRoom();
  const chained = [];
  const agent = fakeAgent({ Chief: ({ prompt }) => (/What you handed on/.test(prompt) ? 'Here is the draft.' : { wait: 250, then: '@Writer draft it' }), Writer: 'Draft: tea.' });
  const first = await roundOf({ text: 'Write me a post', runAgent: agent.run, deadlineAt: Date.now() + 400, floorMs: 300, chain: (u, g) => chained.push([u, g]), model: 'openai/plain' });
  const saved = (await store.getBotGroup(uid, room.id)).pending;
  check('the segment stops for time with work left', first.result.stopReason === 'time' && first.result.pending === true, JSON.stringify(first.result));
  check('  what is left is saved, for the next segment', saved?.reason === 'time' && saved.queue?.[0]?.botId === writer.id && saved.queue[0].by === chief.id, JSON.stringify(saved));
  check('  and the next one is asked for, once', chained.length === 1 && chained[0][0] === uid && chained[0][1] === room.id, JSON.stringify(chained));
  check('  with no "out of time" notice to the person', !first.posts.some((m) => m.notice === 'time'));
  const second = await roundOf({ resume: true, runAgent: agent.run });
  check('the next segment does what was left: Writer, then Chief reading it', second.posts.map((m) => m.text).join(' | ') === 'Draft: tea. | Here is the draft.', second.posts.map((m) => m.text).join(' | '));
  check('  and the round is over', (await store.getBotGroup(uid, room.id)).pending === null && second.result.stopReason === 'end_turn');
  check('  on the model the person had', agent.calls.at(-1).modelId === 'openai/plain', agent.calls.at(-1).modelId);
}

section('a member cut off mid-step carries on, not starts again');
{
  await cleanRoom();
  let tries = 0;
  const agent = fakeAgent({
    Chief: ({ prompt }) => (/What you handed on/.test(prompt) ? 'Got it.' : '@Writer research it'),
    Writer: () => (tries++ === 0 ? { wait: 150, then: { cut: true } } : 'Found three sources.'),
  });
  await roundOf({ text: 'Research tea', runAgent: agent.run, deadlineAt: Date.now() + 200, floorMs: 100, chain: () => {} });
  const saved = (await store.getBotGroup(uid, room.id)).pending;
  check('its turn is kept as unfinished', saved?.queue?.[0]?.botId === writer.id && saved.queue[0].resume === true, JSON.stringify(saved?.queue));
  const before = agent.calls.filter((c) => c.name === 'Writer').at(-1).users;
  const next = await roundOf({ resume: true, runAgent: agent.run });
  const again = agent.calls.filter((c) => c.name === 'Writer').at(-1);
  check('the next segment runs it on without a second prompt', again.users === before, `${before} → ${again.users}`);
  check('  its answer reaches the group, and Chief reads it', next.posts.map((m) => m.text).join(' | ') === 'Found three sources. | Got it.', next.posts.map((m) => m.text).join(' | '));
}

section('a segment that was killed is picked up where it was');
{
  await cleanRoom();
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'Plan the week' });
  await store.setGroupPending(uid, room.id, { messageId: null, queue: [{ botId: writer.id, by: chief.id, report: null }], handoffs: 1, segments: 1, reason: 'running', owed: {}, working: [{ bot: writer.id, tool: 'web_search' }], lastSeq: 0, at: new Date().toISOString() });
  const agent = fakeAgent({ Writer: 'Monday: draft.', Chief: 'Week planned.' });
  const res = await roundOf({ resume: true, runAgent: agent.run });
  check('the queue it left runs, and the asker answers', res.posts.map((m) => m.text).join(' | ') === 'Monday: draft. | Week planned.', res.posts.map((m) => m.text).join(' | '));
}

section(`at most ${MAX_SEGMENTS} segments, then the person decides`);
{
  await cleanRoom();
  await store.setGroupPending(uid, room.id, { queue: [{ botId: writer.id, by: chief.id, report: null }], handoffs: 1, segments: MAX_SEGMENTS, reason: 'time', owed: {}, working: [], lastSeq: 0, at: new Date().toISOString() });
  const agent = fakeAgent({ Writer: 'x' });
  const res = await roundOf({ resume: true, runAgent: agent.run });
  const saved = (await store.getBotGroup(uid, room.id)).pending;
  check('no turn runs past the cap', agent.calls.length === 0);
  check('  a notice offers Continue', res.posts.some((m) => m.notice === 'segments'));
  check('  and the queue waits for the person', saved?.reason === 'segments' && saved.queue.length === 1);
  const pressed = await roundOf({ resume: true, fresh: true, runAgent: agent.run });
  check('Continue runs it with a fresh allowance', pressed.posts.some((m) => m.text === 'x') && agent.calls[0]?.name === 'Writer' && pressed.result.handoffs >= 1, JSON.stringify(pressed.result));
}

section('the hand-off ceiling waits for Continue');
{
  await cleanRoom();
  const agent = fakeAgent({ Chief: '@Writer go', Writer: '@Chief back to you' });
  const res = await roundOf({ text: 'loop', runAgent: agent.run });
  const saved = (await store.getBotGroup(uid, room.id)).pending;
  check('it stops at the ceiling and says so once', res.result.stopReason === 'handoff_ceiling' && res.posts.filter((m) => m.notice === 'ceiling').length === 1);
  check('  keeping what it did not start, for Continue', saved?.reason === 'ceiling' && saved.queue.length > 0, JSON.stringify(saved));
  const words = await roundOf({ text: 'tiếp tục', runAgent: agent.run });
  check('"tiếp tục" carries on that queue rather than starting over at the admin', words.posts.find((m) => m.role === 'user')?.text === 'tiếp tục' && agent.calls.slice(-1)[0].name !== undefined && words.result.handoffs > 0, JSON.stringify(words.result));
  await roundOf({ text: 'something else', runAgent: fakeAgent({ Chief: 'ok' }).run });
  check('any other message clears what was waiting', (await store.getBotGroup(uid, room.id)).pending === null);
}

section('the person writes while the group works');
{
  await cleanRoom();
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  const agent = fakeAgent({
    Chief: async ({ prompt }) => {
      if (/What you handed on/.test(prompt)) return 'Both done.';
      if (!/also/.test(prompt)) await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: '@Writer also add a title' });
      return 'Working on it.';
    },
    Writer: 'Title: Tea Time.',
  });
  const res = await roundOf({ text: 'Start the post', runAgent: agent.run });
  check('a line written mid-round is answered in the same round', res.posts.some((m) => m.text === 'Title: Tea Time.'), res.posts.map((m) => m.text).join(' | '));
  check('  by whom it calls, not counted as a hand-off', res.result.handoffs === 0, JSON.stringify(res.result));
}

section('the model the chip has now, every batch');
{
  await cleanRoom();
  const agent = fakeAgent({
    Chief: async ({ prompt }) => {
      if (/What you handed on/.test(prompt)) return 'ok';
      await store.setGroupModel(uid, room.id, 'openai/newer');
      return '@Writer go';
    },
    Writer: 'done',
  });
  await roundOf({ text: 'go', runAgent: agent.run, model: 'openai/plain' });
  check('the first batch on the chip it was sent with', agent.calls[0].modelId === 'openai/plain');
  check('  a change while it works is the model of the next batch', agent.calls[1].modelId === 'openai/newer', agent.calls.map((c) => c.modelId).join());
}

section('what a bot makes in a group is in the group');
{
  await cleanRoom();
  const agent = fakeAgent({
    Chief: '@Writer make the doc',
    Writer: async ({ chatId }) => {
      await store.createAttachment(uid, { id: id(), name: 'Plan.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', bytes: 12, data: 'eA==', origin: 'generated', chatId });
      return '';
    },
  });
  const res = await roundOf({ text: 'Make the plan document', runAgent: agent.run });
  const post = res.posts.find((m) => m.bot === writer.id);
  check('the file it made rides on its group post', post?.files?.length === 1 && post.files[0].name === 'Plan.docx', JSON.stringify(post));
  check('  even when it said nothing', !!post && String(post.text || '').length > 0);
}

section('who is working, while the round runs');
{
  await cleanRoom();
  let mid = null;
  const agent = fakeAgent({
    Chief: ({ prompt }) => (/What you handed on/.test(prompt) ? 'ok' : '@Writer go'),
    Writer: async () => {
      mid = (await store.getBotGroup(uid, room.id)).pending;
      return 'done';
    },
  });
  await roundOf({ text: 'go', runAgent: agent.run });
  check('pending says the round is running and who is at work', mid?.reason === 'running' && mid.working?.some((w) => w.bot === writer.id), JSON.stringify(mid));
  check('  and is cleared at the end', (await store.getBotGroup(uid, room.id)).pending === null);
}

section('writing between two segments joins the round, not replaces it');
{
  await cleanRoom();
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  const first = await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'Write the post' });
  await store.setGroupPending(uid, room.id, { queue: [{ botId: writer.id, by: chief.id, report: null }], handoffs: 1, segments: 1, reason: 'time', owed: {}, working: [], lastSeq: first.seq, at: new Date().toISOString() });
  const agent = fakeAgent({ Writer: 'Draft done.', Quiet: 'Hi!', Chief: 'All set.' });
  const res = await roundOf({ text: '@Quiet hi', runAgent: agent.run });
  const said = res.posts.map((m) => m.text);
  check('the work that was waiting still runs', said.includes('Draft done.') && said.includes('All set.'), said.join(' | '));
  check('  and the new line is answered in it', said.includes('Hi!'), said.join(' | '));
}

/* ── Task 7: memory that keeps up ──────────────────────────────── */

const memory = await import('../server/bots/memory.js');

section('a memory entry that is too long is split, not refused (owner, 2026-11-10)');
{
  const scope = { botId: writer.id };
  // The owner's screenshot: 327 characters, three facts in one breath.
  const long = 'Đội bot của người dùng: Writer (blog draft/edit), Coder (viết & review code) trong nhóm "Content & Code"; Finder (truy tìm tài liệu/nguồn) + Researcher (nghiên cứu sâu, tổng hợp, gắn nhãn độ chắc chắn) trong nhóm "Tài liệu & Nghiên cứu". Chief là admin cả hai nhóm. Bot "Reasearcher" viết nhầm đã được đổi tên thành Researcher.';
  const res = await memory.remember(uid, scope, long, 'bot');
  const texts = res.entries.map((e) => e.text);
  check('it is saved as several entries, each within the limit', res.saved && texts.length >= 2 && texts.every((t) => t.length <= 300), JSON.stringify(texts.map((t) => t.length)));
  check('  nothing of it lost', texts.join(' ').replace(/\s+/g, ' ').length >= long.replace(/\s+/g, ' ').length - texts.length, `${texts.join(' ').length} vs ${long.length}`);
  const decomposed = 'Người dùng thích cà phê'.normalize('NFD');
  const one = await memory.remember(uid, scope, decomposed, 'bot');
  check('text is stored composed (NFC), so a mark is never counted twice', one.entries[0].text === 'Người dùng thích cà phê'.normalize('NFC'));
  check('  and saved again in either form, it is the same entry', (await memory.remember(uid, scope, 'Người dùng thích cà phê', 'bot')).saved === false);
  const oneSentence = 'x'.repeat(320);
  let refused = '';
  try {
    await memory.remember(uid, scope, oneSentence, 'bot');
  } catch (err) {
    refused = err.message;
  }
  check('one sentence longer than the limit is still refused, saying why', /300/.test(refused), refused);
  const saved = [...res.entries, ...one.entries].map((e) => e.id);
  check('an entry keeps its text without marks for search', (await store.listBotMemory(uid, scope)).filter((e) => saved.includes(e.id)).every((e) => typeof e.text_folded === 'string' && !/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễđ]/.test(e.text_folded)));
  check('  "da nang" finds "Đà Nẵng" through it', memory.fold('Khách ở Đà Nẵng') === 'khach o da nang');
}

/* ── Task 3: carrying on in another invocation ─────────────────── */

const { continueGroup, resumeGroupRounds } = await import('../server/bots/continue.js');

section('the next segment runs in a new invocation, holding the group');
{
  await cleanRoom();
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'Plan the week' });
  await store.setGroupPending(uid, room.id, { queue: [{ botId: writer.id, by: chief.id, report: null }], handoffs: 1, segments: 1, reason: 'time', owed: {}, working: [], lastSeq: 0, at: new Date().toISOString() });
  let heldDuring = null;
  const agent = fakeAgent({
    Writer: async () => {
      heldDuring = (await store.getChat(uid, log.id)).run_lock_by;
      return 'Monday: draft.';
    },
    Chief: 'Planned.',
  });
  const done = await continueGroup({ userId: uid, groupId: room.id, runAgent: agent.run, chain: () => {} });
  check('it ran what was pending', done.status === 'ran' && agent.calls.map((c) => c.name).join() === 'Writer,Chief', JSON.stringify(done));
  check('  holding the group\'s lease while it worked', !!heldDuring);
  check('  and let it go after', !(await store.getChat(uid, log.id)).run_lock_by);
  const busy = await store.claimChatRun(uid, log.id, id());
  await store.setGroupPending(uid, room.id, { queue: [{ botId: writer.id }], handoffs: 0, segments: 1, reason: 'time', owed: {}, working: [], lastSeq: 0, at: new Date().toISOString() });
  const second = await continueGroup({ userId: uid, groupId: room.id, runAgent: agent.run, chain: () => {}, claimWaitMs: 50 });
  check('a group another segment holds is left to it', second.status === 'busy', JSON.stringify(second));
  await store.releaseChatRun(uid, log.id, (await store.getChat(uid, log.id)).run_lock_by, busy);
  await store.setGroupPending(uid, room.id, null);
  check('nothing pending: nothing runs', (await continueGroup({ userId: uid, groupId: room.id, runAgent: agent.run })).status === 'nothing');
}

section('the next segment is asked for after this one lets the group go');
{
  await cleanRoom();
  const order = [];
  const agent = fakeAgent({ Chief: ({ prompt }) => (/What you handed on/.test(prompt) ? 'ok' : { wait: 200, then: '@Writer go' }), Writer: 'done' });
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'start' });
  await store.setGroupPending(uid, room.id, { queue: [{ botId: chief.id, by: null, report: null, person: 'admin' }], handoffs: 0, segments: 1, reason: 'time', owed: {}, working: [], lastSeq: 0, at: new Date().toISOString() });
  await continueGroup({
    userId: uid,
    groupId: room.id,
    runAgent: agent.run,
    budgetMs: 300,
    floorMs: 250,
    chain: async () => order.push(['chain', (await store.getChat(uid, log.id)).run_lock_by]),
  });
  check('asked for once, with the lease already free', order.length === 1 && order[0][1] == null, JSON.stringify(order));
}

section('the heartbeat picks up a round a killed invocation left');
{
  await cleanRoom();
  const log = await store.botChat(uid, { groupId: room.id, title: room.name });
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'go on' });
  await store.setGroupPending(uid, room.id, { queue: [{ botId: writer.id, by: null, report: null, person: 'named' }], handoffs: 0, segments: 2, reason: 'running', owed: {}, working: [], lastSeq: 0, at: new Date().toISOString() });
  // A lease taken and never renewed: the mark of a killed invocation.
  await store.claimChatRun(uid, log.id, id());
  const agent = fakeAgent({ Writer: 'Back on it.' });
  const ran = await resumeGroupRounds({ budgetMs: 200_000, runAgent: agent.run, staleMs: 0, chain: () => {} });
  check('it carries on the round', ran.some((r) => r.groupId === room.id && r.status === 'ran') && agent.calls.length === 1, JSON.stringify(ran));
  check('  and the group has nothing left pending', (await store.getBotGroup(uid, room.id)).pending === null);
}

console.log(failures === 0 ? '\n\x1b[32mAll bot core checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
