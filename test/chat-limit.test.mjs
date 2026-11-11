/**
 * What a person deletes, the database deletes — one to one — and an account keeps its
 * twenty newest conversations, administrators every one (owner, 2026-11-11).
 *
 *   node test/chat-limit.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'chat-limit-test-encryption-key';
process.env.SESSION_SECRET ||= 'chat-limit-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-chat-limit-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
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
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
const store = await initStore({ driver: sql });
store.query = (text, params) => sql.query(text, params);
const { CHAT_LIMIT, keepNewest, sweepChatLimit, unlimited } = await import('../server/chatLimit.js');

const id = () => crypto.randomUUID();
const person = (role = 'user') => store.createUser({ id: id(), role, name: role, email: `${id()}@limit.test`, passwordHash: 'x' });
const count = async (table, where, params) => Number((await store.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n);
const file = (userId, over = {}) =>
  store.createAttachment(userId, { id: id(), name: 'a.png', mime: 'image/png', kind: 'image', bytes: 3, data: 'AAAA', ...over });
/** Conversations made oldest first, each a minute after the last. */
async function chats(userId, n, extra = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const chatId = id();
    await store.createChat(userId, { id: chatId, title: `c${i}`, model: null, ...extra });
    await store.query(`UPDATE chats SET updated_at = NOW() - ($1 || ' minutes')::interval WHERE id = $2`, [String(n - i), chatId]);
    ids.push(chatId);
  }
  return ids;
}

section('deleting a conversation deletes everything that was its own');
{
  const user = await person();
  const [chatId, other] = await chats(user.id, 2);
  const photo = await file(user.id, { chatId });
  await file(user.id, { origin: 'rendered', derivedFrom: photo.id, chatId: null, source: 'stamp' });
  await file(user.id, { chatId: other });
  await store.saveResearchRun(user.id, { id: id(), chatId, question: 'q', status: 'done', transcript: [], sources: [], report: 'r' });
  await store.enqueueJob(user.id, { id: id(), chatId, tool: 'read_file', input: { path: 'secret.txt' } });
  await store.createFeedback(user.id, { id: id(), topic: 'other', kind: 'bug', body: 'it broke', affect: 'me', chatId, chatTitle: 'c0', transcript: [{ role: 'user', text: 'x' }] });
  await store.deleteChat(user.id, chatId);
  check('the conversation is gone', !(await store.getChat(user.id, chatId)));
  check('  its files', (await count('attachments', 'chat_id = $1', [chatId])) === 0);
  check('  and their renderings, at once rather than at the next sweep', (await count('attachments', 'derived_from = $1', [photo.id])) === 0);
  check('  its deep research', (await count('research_runs', 'chat_id = $1', [chatId])) === 0);
  check('  the worker jobs it sent, with their arguments', (await count('tool_jobs', 'chat_id = $1', [chatId])) === 0);
  const fb = (await store.query('SELECT transcript, chat_title, body FROM feedback WHERE chat_id = $1', [chatId]))[0];
  check('  the copy of it sent with feedback — the feedback itself stays', fb && fb.transcript === null && fb.chat_title === null && fb.body === 'it broke', JSON.stringify(fb));
  check('another conversation of the same account keeps its file', (await count('attachments', 'chat_id = $1', [other])) === 1);
}

section('a made file thrown away takes its renderings');
{
  const user = await person();
  const [chatId] = await chats(user.id, 1);
  const made = await file(user.id, { chatId, origin: 'generated', name: 'r.docx', kind: 'office', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  await file(user.id, { origin: 'rendered', derivedFrom: made.id, source: 'stamp' });
  check('deleted', await store.deleteGeneratedFile(user.id, made.id));
  check('  and its drawing with it', (await count('attachments', 'derived_from = $1', [made.id])) === 0);
}

section(`an account keeps its ${CHAT_LIMIT} newest conversations`);
{
  const user = await person();
  const ids = await chats(user.id, CHAT_LIMIT + 5);
  const [oldest, second, third, fourth, fifth, sixth] = ids;
  await store.updateChat(user.id, oldest, { pinned: true });
  await store.claimChatRun(user.id, second, 'run-1');
  const keptFile = await file(user.id, { chatId: oldest });
  const goneFile = await file(user.id, { chatId: third });
  const removed = await keepNewest(user, store);
  const left = new Set((await store.query('SELECT id FROM chats WHERE user_id = $1', [user.id])).map((r) => r.id));
  // The pinned one counts toward the twenty, so the newest nineteen stay beside it.
  check('the oldest past the limit are deleted', removed === 4 && [third, fourth, fifth, sixth].every((c) => !left.has(c)), `removed ${removed}`);
  check('  a pinned one stays, however old', left.has(oldest));
  check('  and one at work right now', left.has(second));
  check('  the newest nineteen stay beside the pinned one — twenty — and the one at work besides', ids.slice(6).every((c) => left.has(c)) && left.size === CHAT_LIMIT + 1, String(left.size));
  check('  what went took its files; what stayed kept them', (await count('attachments', 'id = $1', [goneFile.id])) === 0 && (await count('attachments', 'id = $1', [keptFile.id])) === 1);
  check('nothing more to delete when it is already at the limit', (await keepNewest(user.id, store)) === 0);
  const [fresh] = await chats(user.id, 1);
  await store.touchChat(user.id, fresh);
  check('a new conversation pushes the oldest unpinned one out, by last use', (await keepNewest(user, store)) === 1 && !!(await store.getChat(user.id, fresh)));
}

section('with twenty pinned, the conversation just begun is never the one deleted');
{
  const user = await person();
  const pinned = await chats(user.id, CHAT_LIMIT + 1);
  for (const c of pinned) await store.updateChat(user.id, c, { pinned: true });
  const [first] = await chats(user.id, 1);
  await store.touchChat(user.id, first);
  check('the new one stays, and every pinned one', (await keepNewest(user, store)) === 0 && !!(await store.getChat(user.id, first)));
  check('  an account whose extra conversations are all pinned is not listed for the sweep', !(await store.accountsOverChats(CHAT_LIMIT)).includes(user.id));
  const [next] = await chats(user.id, 1);
  await store.touchChat(user.id, next);
  check('the next one replaces it', (await keepNewest(user, store)) === 1 && !(await store.getChat(user.id, first)) && !!(await store.getChat(user.id, next)));
}

section('what the limit does not count');
{
  const user = await person();
  await chats(user.id, CHAT_LIMIT);
  const hidden = await chats(user.id, 3, { incognito: true });
  // One room per bot (chats_bot_room_idx), so three bots.
  const botChats = await chats(user.id, 3);
  for (const c of botChats) {
    const bot = await store.createBot(user.id, { id: id(), name: `Scout ${c.slice(0, 4)}` });
    await store.query('UPDATE chats SET bot_id = $1 WHERE id = $2', [bot.id, c]);
  }
  check('incognito and a bot\'s conversations are not counted, nor deleted', (await keepNewest(user, store)) === 0 && (await count('chats', 'id = ANY($1::text[])', [[...hidden, ...botChats]])) === 6);
}

section('administrators keep every conversation');
{
  const admin = await person('admin');
  await chats(admin.id, CHAT_LIMIT + 4);
  check('an admin is unlimited', unlimited(admin) && !unlimited({ role: 'user' }));
  check('  and nothing of theirs is deleted', (await keepNewest(admin, store)) === 0 && (await count('chats', 'user_id = $1', [admin.id])) === CHAT_LIMIT + 4);
  check('  nor is the account listed for the sweep', !(await store.accountsOverChats(CHAT_LIMIT)).includes(admin.id));
}

section('the sweep brings an account that held more before the rule down to the limit');
{
  const user = await person();
  await chats(user.id, CHAT_LIMIT + 7);
  check('it is listed', (await store.accountsOverChats(CHAT_LIMIT)).includes(user.id));
  await sweepChatLimit(store);
  check('  and brought to twenty', (await count('chats', 'user_id = $1 AND bot_id IS NULL', [user.id])) === CHAT_LIMIT);
  check('  and no longer listed', !(await store.accountsOverChats(CHAT_LIMIT)).includes(user.id));
}

section('deleting a bot or a group deletes its conversations\' files too');
{
  const user = await person();
  const bot = await store.createBot(user.id, { id: id(), name: 'Writer' });
  const [chatId] = await chats(user.id, 1);
  await store.query('UPDATE chats SET bot_id = $1 WHERE id = $2', [bot.id, chatId]);
  const shot = await file(user.id, { chatId });
  check('the bot is deleted', await store.deleteBot(user.id, bot.id));
  check('  with its conversation and that conversation\'s file', !(await store.getChat(user.id, chatId)) && (await count('attachments', 'id = $1', [shot.id])) === 0);

  const member = await store.createBot(user.id, { id: id(), name: 'Member' });
  const group = await store.createBotGroup(user.id, { id: id(), name: 'Desk', members: [member.id] });
  const [roomId] = await chats(user.id, 1);
  await store.query('UPDATE chats SET bot_group_id = $1 WHERE id = $2', [group.id, roomId]);
  const posted = await file(user.id, { chatId: roomId });
  await store.enqueueJob(user.id, { id: id(), chatId: roomId, tool: 'read_file', input: {} });
  check('the group is deleted', await store.deleteBotGroup(user.id, group.id));
  check('  with its room, the room\'s files and its jobs', !(await store.getChat(user.id, roomId)) && (await count('attachments', 'id = $1', [posted.id])) === 0 && (await count('tool_jobs', 'chat_id = $1', [roomId])) === 0);
}

section('rows left from before, swept');
{
  const user = await person();
  await store.enqueueJob(user.id, { id: id(), chatId: 'long-gone', tool: 'read_file', input: {} });
  await store.saveResearchRun(user.id, { id: id(), chatId: 'long-gone', question: 'q', status: 'done', transcript: [], sources: [], report: 'r' });
  await store.pruneOrphanChatRows();
  check('a job and a research run whose conversation no longer exists are deleted', (await count('tool_jobs', 'chat_id = $1', ['long-gone'])) === 0 && (await count('research_runs', 'chat_id = $1', ['long-gone'])) === 0);
}

section('a forgotten bot memory is deleted for good past its Undo');
{
  const user = await person();
  const other = await person();
  const bot = await store.createBot(user.id, { id: id(), name: 'Keeper' });
  const theirs = await store.createBot(other.id, { id: id(), name: 'Theirs' });
  const a = await store.addBotMemory(user.id, { id: id(), botId: bot.id, text: 'likes tea' });
  const b = await store.addBotMemory(user.id, { id: id(), botId: bot.id, text: 'lives in Hue' });
  const c = await store.addBotMemory(other.id, { id: id(), botId: theirs.id, text: 'not mine' });
  await store.softDeleteBotMemory(user.id, a.id, { botId: bot.id });
  await store.softDeleteBotMemory(other.id, c.id, { botId: theirs.id });
  await store.query("UPDATE bot_memory SET deleted_at = NOW() - interval '11 minutes' WHERE id = ANY($1::text[])", [[a.id, c.id]]);
  await store.softDeleteBotMemory(user.id, b.id, { botId: bot.id });
  check('the next forget deletes this account\'s older forgotten entries', (await count('bot_memory', 'id = $1', [a.id])) === 0);
  check('  not one still inside its Undo', (await count('bot_memory', 'id = $1', [b.id])) === 1);
  check('  nor another account\'s', (await count('bot_memory', 'id = $1', [c.id])) === 1);
  await store.pruneForgottenMemory();
  check('the sweep takes every account\'s', (await count('bot_memory', 'id = $1', [c.id])) === 0);
}

section('starting a conversation says how many old ones went');
{
  delete process.env.VERCEL;
  const { createApp } = await import('../server/app.js');
  const server = createApp().listen(5241);
  await new Promise((r) => server.once('listening', r));
  const jar = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:5241${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  try {
    const member = jar();
    await member('POST', '/api/register', { name: 'Member', email: 'member@limit.test', password: 'a-long-enough-password' });
    const memberId = (await member('GET', '/api/bootstrap')).body.user.id;
    await chats(memberId, CHAT_LIMIT);
    const made = await member('POST', '/api/chats', {});
    check('the twenty-first conversation is made, and the page told one old one went', made.status === 201 && made.body?.chat?.id && made.body.removed === 1, JSON.stringify(made.body));
    check('  the account holds twenty', (await count('chats', 'user_id = $1', [memberId])) === CHAT_LIMIT);
    const hidden = await member('POST', '/api/chats', { incognito: true });
    check('  an incognito one deletes nothing', hidden.status === 201 && hidden.body.removed === 0 && (await count('chats', 'user_id = $1 AND NOT incognito', [memberId])) === CHAT_LIMIT);

    const boss = jar();
    await boss('POST', '/api/register', { name: 'Boss', email: 'boss@limit.test', password: 'a-long-enough-password' });
    const bossId = (await boss('GET', '/api/bootstrap')).body.user.id;
    await store.query("UPDATE users SET role = 'admin' WHERE id = $1", [bossId]);
    await chats(bossId, CHAT_LIMIT + 2);
    const theirs = await boss('POST', '/api/chats', {});
    check('an administrator\'s twenty-third deletes nothing', theirs.status === 201 && theirs.body.removed === 0 && (await count('chats', 'user_id = $1', [bossId])) === CHAT_LIMIT + 3, JSON.stringify(theirs.body));
  } finally {
    server.close();
  }
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
