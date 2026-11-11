/**
 * The Bot page's team features (owner, 2026-11-11, spec
 * docs/superpowers/specs/2026-11-10-bots-team-features-design.md): Chief starting a
 * group's work, what needs the person, unread marks and pins, pause, duplicate,
 * export and import, scheduled runs that keep quiet or say they failed, group tasks,
 * ask aside, and usage that compares and drills down.
 *
 * Drives the store, the scheduler, the rounds and the routes' helpers against an
 * in-process Postgres with a stand-in for the agent loop.
 *
 *   node test/bots-team.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'bots-team-test-encryption-key';
process.env.SESSION_SECRET ||= 'bots-team-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-bots-team-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
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
const user = await store.createUser({ id: id(), role: 'user', name: 'Team', email: 'team@bots.test', passwordHash: 'x' });
const other = await store.createUser({ id: id(), role: 'user', name: 'Other', email: 'other-team@bots.test', passwordHash: 'x' });
const uid = user.id;

const chief = await store.createBot(uid, { id: id(), name: 'Chief', role: 'Chief of Staff', avatar: 'cosmic-whale', isMain: true });
const writer = await store.createBot(uid, { id: id(), name: 'Writer', role: 'Editor', avatar: 'minnow' });
const scout = await store.createBot(uid, { id: id(), name: 'Scout', role: 'Researcher', avatar: 'owl' });
const group = await store.createBotGroup(uid, { id: id(), name: 'Desk', adminBotId: writer.id, members: [writer.id, scout.id] });

/* ── Task 1: the store ─────────────────────────────────────────── */

section('a conversation is read up to its end, and the list says what is new');
{
  const own = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  const preview = async () => (await store.botPreviews(uid)).find((p) => p.chat_id === own.id);
  check('a new conversation has nothing unread', (await preview())?.unread === false, JSON.stringify(await preview()));
  await store.appendMessage(uid, own.id, { id: id(), role: 'user', text: 'Draft the post' });
  check('  the person\'s own line is not news', (await preview())?.unread === false);
  await store.appendMessage(uid, own.id, { id: id(), role: 'assistant', text: 'Here is the draft.' });
  check('a bot\'s reply after it is unread', (await preview())?.unread === true);
  check('  another account cannot mark it read', (await store.markChatRead(other.id, own.id)) === false && (await preview())?.unread === true);
  check('reading it clears the mark', (await store.markChatRead(uid, own.id)) === true && (await preview())?.unread === false);
  await store.appendMessage(uid, own.id, { id: id(), role: 'user', text: 'Check the feed', origin: 'task' });
  await store.appendMessage(uid, own.id, { id: id(), role: 'assistant', text: 'Nothing new.', quiet: true });
  const quiet = await preview();
  check('a quiet run is neither news nor the preview', quiet?.unread === false && quiet?.text === 'Here is the draft.', JSON.stringify(quiet));
}

section('pins, pause and their columns');
{
  const pinned = await store.updateBot(uid, scout.id, { pinnedAt: new Date().toISOString() });
  check('a bot can be pinned', !!pinned?.pinned_at);
  const paused = await store.updateBot(uid, scout.id, { pausedAt: new Date().toISOString() });
  check('  and paused', !!paused?.paused_at);
  check('another account changes neither', (await store.updateBot(other.id, scout.id, { pausedAt: null })) === null && !!(await store.getBot(uid, scout.id)).paused_at);
  const g = await store.updateBotGroup(uid, group.id, { pinnedAt: new Date().toISOString() });
  check('a group can be pinned', !!g?.pinned_at);
  await store.updateBot(uid, scout.id, { pausedAt: null, pinnedAt: null });
  await store.updateBotGroup(uid, group.id, { pinnedAt: null });
}

section('a paused bot\'s tasks wait; a group can own a task');
{
  const past = new Date(Date.now() - 60_000).toISOString();
  const botTask = await store.createTask(uid, { id: id(), title: 'Scout feed', prompt: 'Check the feed', cron: '{"kind":"daily","time":"08:00"}', nextRunAt: past, botId: scout.id });
  await store.updateBot(uid, scout.id, { pausedAt: new Date().toISOString() });
  let claimed = await store.claimDueTask(new Date().toISOString(), uid);
  check('a paused bot\'s due task is not claimed', claimed?.id !== botTask.id, claimed?.id || 'none');
  if (claimed) await store.finishTask(claimed.id, { status: 'ok', chatId: null, nextRunAt: null });
  await store.updateBot(uid, scout.id, { pausedAt: null });
  claimed = await store.claimDueTask(new Date().toISOString(), uid);
  check('  and is once it is resumed', claimed?.id === botTask.id);
  await store.finishTask(botTask.id, { status: 'ok', chatId: null, nextRunAt: null });

  const groupTask = await store.createTask(uid, { id: id(), title: 'Desk review', prompt: 'Review the week', cron: null, nextRunAt: null, botGroupId: group.id, missed: 'skip' });
  check('a group task is made, with what to do when missed', groupTask?.bot_group_id === group.id && groupTask.missed === 'skip');
  check('  a task in another account\'s group is not', !(await store.createTask(other.id, { id: id(), title: 'x', prompt: 'x', botGroupId: group.id })));
  check('  a task made disabled stays so', (await store.createTask(uid, { id: id(), title: 'Off', prompt: 'x', botId: writer.id, enabled: false }))?.enabled === false);
  const groupTasks = await store.listTasks(uid, { groupId: group.id });
  check('the group lists its own tasks', groupTasks.length === 1 && groupTasks[0].id === groupTask.id);
  check('  the account\'s list holds neither a bot\'s nor a group\'s', !(await store.listTasks(uid)).some((t) => t.bot_id || t.bot_group_id));
  check('the team\'s tasks are listed together', (await store.listTeamTasks(uid)).length === 3);
  const changed = await store.updateTask(uid, groupTask.id, { missed: 'once' });
  check('what to do with a missed run can change', changed?.missed === 'once');
}

section('what waits for the person');
{
  const own = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  await store.appendMessage(uid, own.id, { id: id(), role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'send_email', input: { to: 'a@b.c' } }] });
  const log = await store.botChat(uid, { groupId: group.id, title: 'Desk' });
  await store.appendMessage(uid, log.id, { id: id(), role: 'assistant', bot: scout.id, text: 'Which market?', ask: true });
  let seen = await store.botAttention(uid);
  check('a bot\'s chat stopped on a step is listed', seen.waiting.some((w) => w.chat_id === own.id && w.tool_calls?.[0]?.name === 'send_email'), JSON.stringify(seen.waiting));
  check('a group question nobody answered is listed', seen.asks.some((a) => a.group_id === group.id && a.bot === scout.id && a.text === 'Which market?'));
  check('  another account sees none of it', (await store.botAttention(other.id)).waiting.length === 0 && (await store.botAttention(other.id)).asks.length === 0);
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'Review the week', origin: 'task' });
  check('  a task\'s prompt does not answer it', (await store.botAttention(uid)).asks.some((a) => a.group_id === group.id));
  await store.appendMessage(uid, log.id, { id: id(), role: 'user', text: 'Vietnam' });
  await store.appendMessage(uid, own.id, { id: id(), role: 'tool', results: [{ toolCallId: 'c1', content: 'sent' }] });
  seen = await store.botAttention(uid);
  check('the person\'s answer and the step\'s result clear both', !seen.asks.some((a) => a.group_id === group.id) && !seen.waiting.some((w) => w.chat_id === own.id));
}

section('a duplicate\'s memory is copied');
{
  await store.addBotMemory(uid, { id: id(), botId: writer.id, text: 'Posts go out on Fridays.' });
  const gone = await store.addBotMemory(uid, { id: id(), botId: writer.id, text: 'Old fact.' });
  await store.softDeleteBotMemory(uid, gone.id, { botId: writer.id });
  const copy = await store.createBot(uid, { id: id(), name: 'Writer (copy)', role: 'Editor', avatar: 'minnow', hue: 30 });
  check('the kept entries are copied, not the forgotten', (await store.copyBotMemory(uid, writer.id, copy.id)) === 1);
  check('  into another account\'s bot, none', (await store.copyBotMemory(other.id, writer.id, copy.id)) === 0);
  check('  the copy reads them', (await store.listBotMemory(uid, { botId: copy.id })).map((e) => e.text).join() === 'Posts go out on Fridays.');
  await store.deleteBot(uid, copy.id);
}

section('usage keeps reasoning and who started the turn, and drills down');
{
  const own = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  const log = await store.botChat(uid, { botId: writer.id, groupId: group.id, title: 'Desk' });
  const at = Date.now();
  await store.recordUsage(uid, { id: id(), chatId: own.id, model: 'm/one', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, reasoningTokens: 50, costUsd: 0.01, role: 'turn', origin: 'person' });
  await store.recordUsage(uid, { id: id(), chatId: log.id, model: 'm/two', inputTokens: 500, outputTokens: 100, costUsd: 0.02, role: 'turn', origin: 'task' });
  await store.recordUsage(uid, { id: id(), chatId: own.id, model: 'm/one', inputTokens: 300, outputTokens: 30, role: 'memory_review' });
  const from = new Date(at - 60_000);
  const to = new Date(at + 60_000);
  const d = await store.botUsageDetail(uid, writer.id, { from, to });
  check('tokens by kind', d.kinds.input === 1400 && d.kinds.cached === 400 && d.kinds.output === 330 && d.kinds.reasoning === 50, JSON.stringify(d.kinds));
  check('by model', d.models[0]?.model === 'm/one' && d.models.length === 2);
  check('by group it worked in', d.groups.length === 1 && d.groups[0].groupId === group.id && d.groups[0].tokens === 600);
  check('scheduled against typed', d.origins.find((o) => o.origin === 'task')?.tokens === 600 && d.origins.find((o) => o.origin === 'person')?.tokens === 1530);
  check('a memory review is its own line', d.roles.find((r) => r.role === 'memory_review')?.tokens === 330);
  check('  another account reads nothing', (await store.botUsageDetail(other.id, writer.id, { from, to })).models.length === 0);
  const total = await store.botUsageTotal(uid, { from, to });
  check('the span\'s total, for the comparison', total.tokens === 2130 && Math.abs(total.cost - 0.03) < 1e-9, JSON.stringify(total));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
