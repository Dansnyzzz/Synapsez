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

/* ── Task 3: Chief starts a group's work; paused members; who is at work ── */

const { runBotTool, __chain } = await import('../server/bots/tools.js');
const { continueGroup } = await import('../server/bots/continue.js');
const nameOfChat = async (chatId) => {
  const chat = await store.getChat(uid, chatId);
  const bot = chat?.bot_id ? await store.getBot(uid, chat.bot_id) : null;
  return bot?.name || '?';
};
/** The agent loop, scripted: `plan[name]` is that bot's reply, or a function of the call returning one. */
function fakeAgent(plan) {
  const calls = [];
  const run = async ({ chatId, signal, turnOrigin }) => {
    const name = await nameOfChat(chatId);
    const history = await store.listMessages(uid, chatId);
    const prompt = [...history].reverse().find((m) => m.role === 'user')?.text || '';
    const call = { name, prompt, chatId, turnOrigin };
    calls.push(call);
    let step = plan[name];
    if (typeof step === 'function') step = await step(call);
    if (signal?.aborted) return;
    await store.appendMessage(uid, chatId, { id: id(), role: 'assistant', text: String(step ?? '[PASS]') });
  };
  return { run, calls };
}

section('Chief writes to a group for the person, and the group gets to work');
{
  const chiefChat = await store.botChat(uid, { botId: chief.id, title: 'Chief' });
  const writerChat = await store.botChat(uid, { botId: writer.id, title: 'Writer' });
  const chained = [];
  __chain.next = (userId, groupId) => chained.push(groupId);

  const member = await runBotTool({ userId: uid, chatId: writerChat.id, name: 'post_to_group', input: { group: 'Desk', message: 'Draft it' }, turnOrigin: 'person' });
  check('a member cannot', member.isError && /main bot/i.test(member.content), member.content);
  for (const turnOrigin of ['handoff', 'task']) {
    const r = await runBotTool({ userId: uid, chatId: chiefChat.id, name: 'post_to_group', input: { group: 'Desk', message: 'Draft it' }, turnOrigin });
    check(`  nor Chief in a turn a ${turnOrigin} started`, r.isError && /Only the person sets a group to work/.test(r.content), r.content);
  }
  check('  nothing was queued by a refusal', !(await store.getBotGroup(uid, group.id)).pending && !chained.length);
  const missing = await runBotTool({ userId: uid, chatId: chiefChat.id, name: 'post_to_group', input: { group: 'Nowhere', message: 'x' }, turnOrigin: 'person' });
  check('a group that is not there is said', missing.isError && /no group called Nowhere/.test(missing.content));

  const ok = await runBotTool({ userId: uid, chatId: chiefChat.id, name: 'post_to_group', input: { group: 'desk', message: '@Scout find three sources on tea' }, turnOrigin: 'person' });
  check('from its own chat, for the person, it starts', !ok.isError && /Posted in Desk/.test(ok.content), ok.content);
  const pending = (await store.getBotGroup(uid, group.id)).pending;
  check('  the round is queued for the member it named, and asked for at once', pending?.reason === 'chief' && pending.queue.length === 1 && pending.queue[0].botId === scout.id && chained.join() === group.id, JSON.stringify(pending));
  check('  whom it called is there for the strip', pending.called?.[0]?.bot === scout.id && pending.called[0].how === 'called');
  const log = await store.botChat(uid, { groupId: group.id, title: 'Desk' });
  const line = (await store.listMessages(uid, log.id)).at(-1);
  check('  Chief\'s line is in the group, as Chief\'s', line.role === 'assistant' && line.bot === chief.id && line.via === 'chief' && /three sources/.test(line.text));
  const again = await runBotTool({ userId: uid, chatId: chiefChat.id, name: 'post_to_group', input: { group: 'Desk', message: 'More' }, turnOrigin: 'person' });
  check('  a second while it waits is refused', again.isError && /at work on something else/.test(again.content));
  const listed = await store.listStaleGroupRounds({ limit: 10 });
  check('  the heartbeat would start it if the request were lost', listed.some((r) => r.group_id === group.id));

  const agent = fakeAgent({ Scout: 'Three sources: A, B, C.' });
  const ran = await continueGroup({ userId: uid, groupId: group.id, runAgent: agent.run, chain: async () => {} });
  check('the round runs', ran.status === 'ran' && agent.calls.length === 1 && agent.calls[0].name === 'Scout', JSON.stringify(ran));
  check('  the member is told Chief wrote it, and its turn is not the person\'s', /Chief wrote the newest line/.test(agent.calls[0].prompt) && agent.calls[0].turnOrigin === 'handoff', agent.calls[0].turnOrigin);
  check('  and the group is free again', !(await store.getBotGroup(uid, group.id)).pending);
  const told = (await store.listMessages(uid, chiefChat.id)).at(-1);
  check('Chief\'s chat gets one line when it is done', told?.role === 'assistant' && told.text === 'Desk is done — see the group.' && told.groupDone === group.id, JSON.stringify(told));
  __chain.next = null;
}

section('a paused member sits the round out; how each went is kept');
{
  await store.updateBot(uid, scout.id, { pausedAt: new Date().toISOString() });
  const { runGroupRound } = await import('../server/bots/rounds.js');
  const agent = fakeAgent({ Writer: ({ prompt }) => (/Scout is paused by the user/.test(prompt) ? 'Done; Scout is paused, so I checked it myself.' : 'Done, @Scout check it'), Scout: 'Checked.' });
  const events = [];
  const saved = [];
  const real = store.setGroupPending.bind(store);
  store.setGroupPending = async (u, g, p) => {
    if (p) saved.push(structuredClone(p));
    return real(u, g, p);
  };
  await runGroupRound({ user, groupId: group.id, text: 'Write the intro', emit: (event, data) => events.push({ event, data }), signal: new AbortController().signal, runAgent: agent.run });
  store.setGroupPending = real;
  check('the paused bot is not run', !agent.calls.some((c) => c.name === 'Scout'), agent.calls.map((c) => c.name).join());
  const posts = events.filter((e) => e.event === 'post').map((e) => e.data.message);
  check('  the group is told it is paused', posts.some((m) => m.notice === 'paused' && m.params?.bot === scout.id));
  const states = saved.map((p) => (p.called || []).map((c) => `${(c.bot === writer.id ? 'W' : 'S')}:${c.how}`).join(','));
  check('  the bot that called it hears it is paused, and stops calling it', agent.calls.filter((c) => c.name === 'Writer').length === 2, agent.calls.map((c) => c.name).join());
  check('whom the message called and how each went, as it went', states.includes('W:called') && states.includes('W:working') && states.some((s) => s.startsWith('W:answered')) && states.some((s) => /S:paused/.test(s)), states.join(' | '));
  await store.updateBot(uid, scout.id, { pausedAt: null });
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
