/**
 * Bots: the team, Chief, a bot's own chat, memory, group rounds and usage by bot
 * (owner, 2026-11-09).
 *
 * Runs the real app against an in-process Postgres and a stand-in provider whose
 * answers are scripted by model name, so a whole round — the admin handing work on
 * with @mentions, the member posting back, the admin answering what came back — runs
 * with no network and no key. What it cannot tell is how a real model behaves when
 * handed these prompts; that is said in the report, not implied here.
 *
 *   node test/bots.test.mjs
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'bots-test-encryption-key';
process.env.SESSION_SECRET ||= 'bots-test-session-secret';
process.env.KEY_CHECKS = 'off';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-bots-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

/* ── a provider that answers by model name ──────────────────────── */

/** Every request the provider got: the model, its system prompt and the last user words. */
const asked = [];
const textOf = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text || '').join('') : '');
let callN = 0;

/** Which bot is speaking, from the prompt's first line ("You are Chief, one of the user's bots"). */
const whoOf = (system) => (/You are ([\w ]+?), one of the user's bots/.exec(system)?.[1] || '').toLowerCase().replace(/ (one|two)$/, '');

function script(model, messages) {
  const system = textOf(messages.find((m) => m.role === 'system'));
  const last = messages.at(-1);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user'));
  const afterTool = last?.role === 'tool';
  const tool = (name, args) => ({ tool: { name, args } });
  // Every bot answers on the chip's model; who answers is the bot the prompt names.
  switch (whoOf(system) || model) {
    case 'chief': {
      if (afterTool) return { text: `Done: ${textOf(last).slice(0, 80)}` };
      if (/make a writer/i.test(lastUser)) return tool('create_bot', { name: 'Writer', role: 'Editor', instructions: 'Draft and edit blog posts.' });
      if (/make a group/i.test(lastUser)) return tool('create_group', { name: 'Blog', members: ['Writer'] });
      if (/\[Group chat/.test(lastUser)) {
        if (/What you handed on is back/.test(lastUser)) return { text: 'Summary: the draft is in.' };
        return { text: '@Writer please draft the first post.' };
      }
      return { text: `Hello, I am Chief. ${/Your memory/.test(system) ? 'I remember.' : ''}` };
    }
    case 'writer': {
      if (afterTool) return { text: 'Saved.' };
      if (/remember tea/i.test(lastUser)) return tool('remember', { text: 'The user likes green tea' });
      if (/make a bot/i.test(lastUser)) return tool('create_bot', { name: 'Sneaky', role: 'x', instructions: 'x' });
      if (/\[Group chat/.test(lastUser)) return { text: 'Draft ready: Ten things about tea.' };
      return { text: 'Writer here.' };
    }
    case 'ping':
      return { text: '@Pong your turn' };
    case 'pong':
      return { text: '@Ping your turn' };
    case 'quiet':
      return { text: '[PASS]' };
    default:
      return { text: 'ok' };
  }
}

const provider = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const model = String(body.model);
    const messages = body.messages || [];
    const record = { model, who: whoOf(textOf(messages.find((m) => m.role === 'system'))), system: textOf(messages.find((m) => m.role === 'system')), lastUser: textOf([...messages].reverse().find((m) => m.role === 'user')), tools: (body.tools || []).map((t) => t.function?.name), closedAt: 0, finished: false };
    asked.push(record);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const end = (finish) => {
      record.finished = true;
      send({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (record.who === 'saver' && messages.at(-1)?.role !== 'tool') {
      callN += 1;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${callN}`, type: 'function', function: { name: 'remember', arguments: JSON.stringify({ text: 'Saved in a turn that was stopped' }) } }] } }] });
      return end('tool_calls');
    }
    if (record.who === 'slow' || record.who === 'saver') {
      let n = 0;
      const timer = setInterval(() => send({ choices: [{ delta: { content: `w${(n += 1)} ` } }] }), 80);
      res.on('close', () => {
        clearInterval(timer);
        if (!record.finished) record.closedAt = Date.now();
      });
      return;
    }
    const answer = script(model, messages);
    if (answer.tool) {
      callN += 1;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${callN}`, type: 'function', function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] } }] });
      return end('tool_calls');
    }
    send({ choices: [{ delta: { content: answer.text } }] });
    end('stop');
  });
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${provider.address().port}/v1`;

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { setApiKey, setPrefs } = await import('../server/settings.js');
const { mentionedBots, mentionSpans, nameProblem, atQuery } = await import('../public/js/bot-mentions.js');
const { HANDOFF_CEILING } = await import('../server/bots/team.js');
const { assessRisk } = await import('../server/tools/definitions.js');

const PORT = 5233;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* a stream, read as text */
      }
      return { status: res.status, body: json, text };
    },
    /** A streamed run, read to the end, as its events. */
    async stream(url, body) {
      const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {}) });
      const text = await res.text();
      const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
      return { status: res.status, events };
    },
    cookie: () => cookie,
  };
}

const alice = jar();
await alice.call('POST', '/api/register', { name: 'Alice', email: 'alice@bots.test', password: 'a-long-enough-password' });
const bob = jar();
await bob.call('POST', '/api/register', { name: 'Bob', email: 'bob@bots.test', password: 'a-long-enough-password' });
const aliceId = (await store.getUserByEmail('alice@bots.test')).id;
const bobId = (await store.getUserByEmail('bob@bots.test')).id;
for (const id of [aliceId, bobId]) {
  await setApiKey(id, 'openai', 'sk-test-key');
  await setPrefs(id, { language: 'en', onboarded: true, qualityGate: false, defaultModel: 'openai/plain' });
}

/* ── the mention rule ──────────────────────────────────────────── */

section('"@Name" is read one way');
{
  const bots = [
    { id: 'w', name: 'Writer' },
    { id: 'w2', name: 'Writer Two' },
    { id: 'c', name: 'Coder' },
  ];
  check('a name calls its bot, in any case', mentionedBots('hey @writer go', bots).map((b) => b.id).join() === 'w');
  check('the longest name that fits wins', mentionedBots('@Writer Two please', bots).map((b) => b.id).join() === 'w2');
  check('an e-mail address calls nobody', mentionedBots('mail me at a@Coder.com', bots).length === 0);
  check('a longer word calls nobody', mentionedBots('@Writers unite', bots).length === 0);
  check('code is quoted, not a call', mentionedBots('run `@Coder` and ```\n@Writer\n```', bots).length === 0);
  check('each bot once, in the order first called', mentionedBots('@Coder then @Writer then @Coder', bots).map((b) => b.id).join() === 'c,w');
  check('spans mark where each call is', JSON.stringify(mentionSpans('x @Coder', bots).map((s) => [s.start, s.end])) === '[[2,8]]');
  check('names that read as the user or everyone are refused', nameProblem('all') && nameProblem('You') && nameProblem('a@b') && !nameProblem('Writer'));
  check('the picker sees an @ being typed', atQuery('hi @Wri', 7)?.query === 'Wri' && atQuery('a@b', 3) === null);
}

/* ── the team ───────────────────────────────────────────────────── */

let chief;
section('Chief is there the first time the page opens');
{
  const first = await alice.call('GET', '/api/bots');
  chief = first.body.bots.find((b) => b.main);
  check('one main bot, called Chief, Chief of Staff', first.body.bots.length === 1 && chief?.name === 'Chief' && chief.role === 'Chief of Staff', JSON.stringify(first.body.bots));
  check('  wearing one of the app\'s own creatures', first.body.creatures.includes(chief.avatar), chief.avatar);
  const again = await Promise.all([alice.call('GET', '/api/bots'), alice.call('GET', '/api/bots')]);
  check('two tabs at once still make one Chief', again.every((r) => r.body.bots.filter((b) => b.main).length === 1));
  const gone = await alice.call('DELETE', `/api/bots/${chief.id}`);
  check('Chief can be changed but not deleted', gone.status === 409, gone.text);
}

let writer;
section('the person makes and changes bots');
{
  const made = await alice.call('POST', '/api/bots', { name: 'Scribe', role: 'Notes', instructions: 'Keep notes.' });
  check('a bot is made from the form', made.status === 201 && made.body.bot.name === 'Scribe', made.text);
  const same = await alice.call('POST', '/api/bots', { name: 'scribe' });
  check('a name the team has, in any case, is refused', same.status === 409, same.text);
  const reserved = await alice.call('POST', '/api/bots', { name: 'everyone' });
  check('a name that stands for everyone is refused', reserved.status === 400, reserved.text);
  const renamed = await alice.call('PATCH', `/api/bots/${made.body.bot.id}`, { role: 'Notetaker', avatar: 'jellyfish', model: 'openai/writer' });
  // Owner, 2026-11-10: every bot answers on the model in the top bar; none has its own.
  check('role and creature change, and no model of its own is kept or shown', renamed.body.bot.role === 'Notetaker' && renamed.body.bot.avatar === 'jellyfish' && !('model' in renamed.body.bot), renamed.text);
  const badAvatar = await alice.call('PATCH', `/api/bots/${made.body.bot.id}`, { avatar: 'unicorn' });
  check('a creature that does not exist is refused', badAvatar.status === 400);
  const del = await alice.call('DELETE', `/api/bots/${made.body.bot.id}`);
  check('any other bot can be deleted', del.status === 200);
}

section('one account never reaches another\'s team');
{
  const theirs = await alice.call('POST', '/api/bots', { name: 'Private', role: 'x' });
  const id = theirs.body.bot.id;
  check('Bob does not see it', !(await bob.call('GET', '/api/bots')).body.bots.some((b) => b.id === id));
  check('  cannot change it', (await bob.call('PATCH', `/api/bots/${id}`, { role: 'stolen' })).status === 404);
  check('  cannot delete it', (await bob.call('DELETE', `/api/bots/${id}`)).status === 404 && !!(await store.getBot(aliceId, id)));
  check('  cannot read its chat', (await bob.call('GET', `/api/bots/${id}/chat`)).status === 404);
  check('  cannot read or write its memory', (await bob.call('GET', `/api/bots/${id}/memory`)).status === 404 && (await bob.call('POST', `/api/bots/${id}/memory`, { text: 'planted' })).status === 404);
  const bobsChief = (await bob.call('GET', '/api/bots')).body.bots[0];
  const mixed = await bob.call('POST', '/api/bot-groups', { name: 'Mixed', members: [bobsChief.id, id] });
  check('a group Bob makes takes only his own bots', mixed.status === 201 && mixed.body.group.members.join() === bobsChief.id, mixed.text);
  check('the store will not open a chat under another account\'s bot', (await store.botChat(bobId, { botId: id })) === null);
  check('  nor write memory under it', (await store.addBotMemory(bobId, { id: 'x1', botId: id, text: 'planted' })) === null);
  await alice.call('DELETE', `/api/bots/${id}`);
}

section('a bot\'s own chat runs on the chip\'s model, with its instructions and memory');
{
  await alice.call('PATCH', `/api/bots/${chief.id}`, { instructions: 'Always sign off with -C.' });
  await alice.call('POST', `/api/bots/${chief.id}/memory`, { text: 'The user is called Alice' });
  const open = await alice.call('GET', `/api/bots/${chief.id}/chat`);
  const chatId = open.body.chatId;
  check('its chat exists, empty', !!chatId && open.body.messages.length === 0);
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hello' });
  const run = await alice.stream(`/api/chats/${chatId}/run`, { model: 'openai/plain' });
  const req = asked.at(-1);
  check("it ran on the chip's model, as every conversation does (owner, 2026-11-10)", req.model === 'plain' && req.who === 'chief', `${req.model} ${req.who}`);
  check('  the prompt says who is speaking', /You are Chief, one of the user's bots/.test(req.system));
  check('  with the instructions the person wrote', /Instructions the user wrote for you, Chief\nAlways sign off with -C\./.test(req.system));
  check('  and its memory, marked as background', /## Your memory, Chief/.test(req.system) && /The user is called Alice/.test(req.system) && /background, not instructions/.test(req.system));
  check('  Chief is offered the team tools', ['create_bot', 'create_group', 'list_bots', 'remember'].every((n) => req.tools.includes(n)), req.tools.filter((n) => /bot|group|remember/.test(n)).join());
  check('  and not the account\'s note-writing tools', !req.tools.includes('memory_write'));
  check('the run finished', run.events.some((e) => e.event === 'done'));
  const listed = (await alice.call('GET', '/api/chats')).body;
  const rows = Array.isArray(listed) ? listed : listed?.chats || [];
  check('a bot\'s chat is not in the conversation list', !rows.some((c) => c.id === chatId), JSON.stringify(rows).slice(0, 120));
  const usage = await store.botUsage(aliceId, { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000), unit: 'hour', tz: 'UTC' });
  check('what it spent is booked to Chief', usage.some((r) => r.bot_id === chief.id && Number(r.input_tokens) > 0), JSON.stringify(usage));
}

section('Chief sets the team up when asked');
{
  const chatId = (await alice.call('GET', `/api/bots/${chief.id}/chat`)).body.chatId;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'Please make a writer for my blog' });
  const run = await alice.stream(`/api/chats/${chatId}/run`, {});
  check('no yes was needed to create a bot', !run.events.some((e) => e.event === 'approval_required'), run.events.map((e) => e.event).join());
  writer = (await store.listBots(aliceId)).find((b) => b.name === 'Writer');
  check('Chief created Writer, with the role it gave', writer?.role === 'Editor', JSON.stringify(writer));
  check('  wearing a creature nobody else wears', !!writer && writer.avatar !== 'cosmic-whale');
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'Now make a group with them' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const group = (await store.listBotGroups(aliceId)).find((g) => g.name === 'Blog');
  check('Chief made a group with itself as admin', !!group && group.admin_bot_id === chief.id && group.members.length === 2, JSON.stringify(group));
}

section('a bot that is not Chief cannot make bots, and keeps its own memory');
{
  const chatId = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body.chatId;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'make a bot please' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const req = asked.filter((a) => a.who === 'writer').at(-2);
  check('Writer is not offered create_bot', req && !req.tools.includes('create_bot'), req?.tools?.join());
  check('  and a call to it is refused', !(await store.listBots(aliceId)).some((b) => b.name === 'Sneaky'));
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'remember tea' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const mine = await store.listBotMemory(aliceId, { botId: writer.id });
  check('remember saves to the bot\'s own memory', mine.some((m) => m.text === 'The user likes green tea'), JSON.stringify(mine.map((m) => m.text)));
  check('  not to Chief\'s', !(await store.listBotMemory(aliceId, { botId: chief.id })).some((m) => /tea/.test(m.text)));
  const secret = await alice.call('POST', `/api/bots/${writer.id}/memory`, { text: 'my key is sk-abcdefghijklmnopqrstuvwxyz0123456789' });
  check('a key is never kept in memory', secret.status === 400, secret.text);
  check('bot tools are graded: reading safe, changing ordinary', assessRisk('list_bots', {}) === 'safe' && assessRisk('create_bot', {}) === 'ordinary' && assessRisk('nonexistent_tool', {}) === 'sensitive');
  const { needsApproval } = await import('../server/agent.js');
  const planting = [{ id: 'a', name: 'update_bot', input: {} }, { id: 'b', name: 'create_bot', input: {} }, { id: 'c', name: 'remember', input: {} }, { id: 'd', name: 'list_bots', input: {} }];
  check('after reading a page, writing a bot\'s instructions or memory asks first', needsApproval(planting, 'guarded', { readOutside: true }).map((c) => c.name).join() === 'update_bot,create_bot,remember');
  check('  and runs unasked when nothing was read from outside', needsApproval(planting, 'guarded', { readOutside: false }).length === 0);
}

let blog;
section('a group round: the admin hands work on, the member posts back, the admin answers');
{
  blog = (await store.listBotGroups(aliceId)).find((g) => g.name === 'Blog');
  const round = await alice.stream(`/api/bot-groups/${blog.id}/run`, { text: 'Can we get a first post?' });
  const posts = round.events.filter((e) => e.event === 'post').map((e) => e.data.message);
  const said = posts.map((m) => `${m.bot ? (m.bot === chief.id ? 'Chief' : 'Writer') : 'user'}:${m.text}`);
  check('the person\'s message is in the group', posts[0]?.role === 'user' && posts[0].text === 'Can we get a first post?');
  check('the admin answered it, handing on with @Writer', said[1] === 'Chief:@Writer please draft the first post.', said.join(' | '));
  check('Writer did the work and posted it', said[2] === 'Writer:Draft ready: Ten things about tea.', said.join(' | '));
  check('  marked as work Chief asked for', posts[2]?.by === chief.id);
  check('Chief read what came back and answered', said[3] === 'Chief:Summary: the draft is in.', said.join(' | '));
  const done = round.events.find((e) => e.event === 'done')?.data;
  check('two hand-offs counted (the call and the answer to it)', done?.handoffs === 2 && done?.turns === 3, JSON.stringify(done));
  const writerReq = asked.filter((a) => a.who === 'writer').at(-1);
  check('Writer was told who called it, with what was said', /Chief handed this to you with @Writer/.test(writerReq.lastUser) && /User: Can we get a first post\?/.test(writerReq.lastUser), writerReq.lastUser.slice(0, 200));
  check('  and its group prompt names the group and its admin', /speaking in the group chat "Blog"/.test(writerReq.system) && /Chief \(admin\)/.test(writerReq.system));
  check('  never its private chat with the person', !/remember tea|make a bot/.test(writerReq.lastUser));
  const own = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body.messages;
  check('the group\'s work does not land in Writer\'s own chat', !own.some((m) => /Draft ready/.test(m.text || '')));
  const log = await alice.call('GET', `/api/bot-groups/${blog.id}/chat`);
  // Its making first, said in its own log (owner, 2026-11-10), then the four lines of the round.
  check('the group\'s log keeps its making and the four lines', log.body.messages.length === 5 && log.body.messages[0].notice === 'made', log.body.messages.map((m) => m.notice || m.role).join());
  const second = await alice.stream(`/api/bot-groups/${blog.id}/run`, { text: '@Writer one more line please' });
  const p2 = second.events.filter((e) => e.event === 'post').map((e) => e.data.message);
  check('an @ from the person calls that bot straight, and only it', p2.length === 2 && p2[1].bot === writer.id, p2.map((m) => m.text).join(' | '));
  const writerSaw = asked.filter((a) => a.who === 'writer').at(-1).lastUser;
  check('  it sees only what is new since it last looked', !/Can we get a first post/.test(writerSaw) && /one more line please/.test(writerSaw), writerSaw.slice(0, 200));
  const refused = await alice.call('POST', `/api/chats/${log.body.chatId}/messages`, { text: 'sneak in' });
  check('the log is not written to by the ordinary chat routes', refused.status === 409);
}

section('group memory is the group\'s');
{
  await alice.call('POST', `/api/bot-groups/${blog.id}/memory`, { text: 'Posts go out on Fridays' });
  await alice.stream(`/api/bot-groups/${blog.id}/run`, { text: '@Writer note it' });
  const inGroup = asked.filter((a) => a.who === 'writer').at(-1);
  check('a member reads it in the group', /Group memory of "Blog"/.test(inGroup.system) && /Fridays/.test(inGroup.system));
  const chatId = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body.chatId;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hi' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const alone = asked.filter((a) => a.who === 'writer').at(-1);
  check('  and not in its own chat', !/Fridays/.test(alone.system) && /green tea/.test(alone.system));
}

section('a hand-off ceiling holds a loop between two bots');
{
  const ping = await alice.call('POST', '/api/bots', { name: 'Ping', role: 'a' });
  const pong = await alice.call('POST', '/api/bots', { name: 'Pong', role: 'b' });
  const g = await alice.call('POST', '/api/bot-groups', { name: 'Loop', members: [ping.body.bot.id, pong.body.bot.id], admin: ping.body.bot.id });
  const before = asked.length;
  const round = await alice.stream(`/api/bot-groups/${g.body.group.id}/run`, { text: 'start' });
  const done = round.events.find((e) => e.event === 'done')?.data;
  const notices = round.events.filter((e) => e.event === 'post' && e.data.message.notice).map((e) => e.data.message.notice);
  check(`it stops at ${HANDOFF_CEILING} hand-offs`, done?.handoffs === HANDOFF_CEILING && done?.stopReason === 'handoff_ceiling', JSON.stringify(done));
  check('  and says so in the group, once', notices.filter((n) => n === 'ceiling').length === 1, notices.join());
  check('  having asked the provider no more than that', asked.length - before === HANDOFF_CEILING + 1, String(asked.length - before));
}

section('[PASS] keeps a member quiet');
{
  const q = await alice.call('POST', '/api/bots', { name: 'Quiet', role: 'q' });
  const g = await alice.call('POST', '/api/bot-groups', { name: 'Hush', members: [q.body.bot.id] });
  const round = await alice.stream(`/api/bot-groups/${g.body.group.id}/run`, { text: 'anyone?' });
  const posts = round.events.filter((e) => e.event === 'post').map((e) => e.data.message);
  check('nothing the bot says is posted for a pass', posts.filter((m) => !m.notice).length === 1);
  // Owner, 2026-11-10: a round never ends in silence — the admin passing alone is said.
  check('  and the group is told nobody answered', posts.some((m) => m.notice === 'nobody'), posts.map((m) => m.notice || m.role).join());
}

section('Stop ends every member\'s turn in a round');
{
  const s1 = await alice.call('POST', '/api/bots', { name: 'Slow One', role: 's' });
  const s2 = await alice.call('POST', '/api/bots', { name: 'Slow Two', role: 's' });
  const g = await alice.call('POST', '/api/bot-groups', { name: 'Slowpokes', members: [s1.body.bot.id, s2.body.bot.id] });
  const pending = alice.stream(`/api/bot-groups/${g.body.group.id}/run`, { text: '@Slow One and @Slow Two, both of you' });
  const start = Date.now();
  while (asked.filter((a) => a.who === 'slow').length < 2 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const pressed = Date.now();
  const stop = await alice.call('POST', `/api/bot-groups/${g.body.group.id}/stop`);
  const round = await pending;
  const slow = asked.filter((a) => a.who === 'slow');
  // The provider hears its socket close a moment after the round has already said it stopped.
  const waitFrom = Date.now();
  while (slow.some((a) => !a.closedAt) && Date.now() - waitFrom < 3000) await new Promise((r) => setTimeout(r, 50));
  check('both members were working', slow.length === 2);
  check('the stop was taken', stop.status === 200 && stop.body.stopped === true, stop.text);
  check('both provider calls were cut off at once', slow.every((a) => a.closedAt > 0 && a.closedAt - pressed < 1500), slow.map((a) => a.closedAt - pressed).join(','));
  check('the round says it stopped', round.events.find((e) => e.event === 'done')?.data?.stopReason === 'aborted');
  const other = await bob.call('POST', `/api/bot-groups/${g.body.group.id}/stop`);
  check('another account cannot stop it, or know it exists', other.status === 404);
}

section('usage by bot');
{
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const res = await alice.call('GET', `/api/bots/usage?from=${from}&to=${to}&unit=hour&tz=Asia/Ho_Chi_Minh`);
  const bots = new Set(res.body.rows.map((r) => r.bot));
  check('rows by bot and model, in the person\'s zone', res.status === 200 && bots.has(chief.id) && bots.has(writer.id) && res.body.rows.every((r) => /^\d{4}-\d\d-\d\dT\d\d:00$/.test(r.bucket)), JSON.stringify(res.body.rows[0]));
  check('  with cache reads and calls', res.body.rows.some((r) => r.cacheRead > 0 && r.calls > 0));
  const theirs = await bob.call('GET', `/api/bots/usage?from=${from}&to=${to}&unit=day&tz=UTC`);
  check('another account sees none of it', theirs.body.rows.every((r) => r.bot !== chief.id && r.bot !== writer.id));
  check('a bad zone is refused', (await alice.call('GET', `/api/bots/usage?from=${from}&to=${to}&unit=day&tz=Mars/Olympus`)).status === 400);
  check('a range past 400 days is refused', (await alice.call('GET', `/api/bots/usage?from=2020-01-01T00:00:00Z&to=${to}&unit=day&tz=UTC`)).status === 400);
}

section('deleting a bot takes its chats and memory, and leaves its spend');
{
  const before = await store.botUsage(aliceId, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000), unit: 'day', tz: 'UTC' });
  await alice.call('DELETE', `/api/bots/${writer.id}`);
  check('its memory went with it', (await store.listBotMemory(aliceId, { botId: writer.id })).length === 0);
  const g = await store.getBotGroup(aliceId, blog.id);
  check('it left the group', !g.members.includes(writer.id));
  const after = await store.botUsage(aliceId, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000), unit: 'day', tz: 'UTC' });
  check('what it spent is still counted', after.some((r) => r.bot_id === writer.id) && before.length === after.length);
}

/*
 * Owner, 2026-11-10: Chief keeps the cosmic whale; a creature another bot already
 * wears comes in a colour of its own, so no two bots look alike; and a bot with
 * nothing saved yet is still told it may save to its memory on its own.
 */
section('no two bots look alike, and Chief keeps the cosmic whale');
{
  const { pickHue, HUES, distinctFaces } = await import('../server/bots/team.js');
  check('a creature nobody wears comes as drawn', pickHue('minnow', [{ avatar: 'koi-dragon', hue: 0 }]) === 0);
  const second = pickHue('minnow', [{ avatar: 'minnow', hue: 0 }], () => 0.5);
  check('  one already worn comes in another colour', second !== 0 && HUES.includes(second), String(second));
  const all = HUES.map((hue) => ({ avatar: 'minnow', hue }));
  check('  and a free colour is always one nobody has', pickHue('minnow', all.slice(0, 5), Math.random) >= 0 && !all.slice(0, 5).some((b) => b.hue === pickHue('minnow', all.slice(0, 5), () => 0)));
  const twin1 = await alice.call('POST', '/api/bots', { name: 'Twin One', role: 't', avatar: 'seahorse' });
  const twin2 = await alice.call('POST', '/api/bots', { name: 'Twin Two', role: 't', avatar: 'seahorse' });
  const twin3 = await alice.call('POST', '/api/bots', { name: 'Twin Three', role: 't', avatar: 'seahorse' });
  const hues = [twin1, twin2, twin3].map((r) => r.body.bot?.hue);
  check('three bots asking for the same creature wear three colours', hues.every((h) => Number.isInteger(h)) && new Set(hues).size === 3, JSON.stringify(hues));
  const whale = await alice.call('POST', '/api/bots', { name: 'Whale Fan', role: 'w', avatar: 'cosmic-whale' });
  check('  the cosmic whale too, never as Chief wears it', whale.body.bot?.avatar === 'cosmic-whale' && whale.body.bot?.hue !== 0, JSON.stringify(whale.body.bot));
  const recolour = await alice.call('PATCH', `/api/bots/${chief.id}`, { avatar: 'minnow' });
  check('Chief keeps the cosmic whale', recolour.status === 400 && (await store.getBot(aliceId, chief.id)).avatar === 'cosmic-whale', `${recolour.status}`);
  check('  and cannot be deleted', (await alice.call('DELETE', `/api/bots/${chief.id}`)).status >= 400 && !!(await store.getBot(aliceId, chief.id)));
  // The settings form sends the creature it wears with every save: that is no change of face.
  const resaved = await alice.call('PATCH', `/api/bots/${chief.id}`, { role: 'Chief of Staff', avatar: 'cosmic-whale' });
  check('  yet saving Chief with the whale it wears goes through', resaved.status === 200 && resaved.body.bot?.avatar === 'cosmic-whale', `${resaved.status} ${JSON.stringify(resaved.body).slice(0, 120)}`);
  // Made before colours: the same creature, as drawn, twice.
  await store.updateBot(aliceId, twin2.body.bot.id, { hue: 0 });
  check('two bots that came to look alike are told apart again', (await distinctFaces(aliceId)) && (await store.getBot(aliceId, twin2.body.bot.id)).hue !== 0);
  const faces = (await store.listBots(aliceId)).map((b) => `${b.avatar}:${b.hue}`);
  check('  every bot in the account looks like no other', new Set(faces).size === faces.length, faces.join(' '));
  for (const r of [twin1, twin2, twin3, whale]) await alice.call('DELETE', `/api/bots/${r.body.bot.id}`);
}

/*
 * Owner, 2026-11-10: a bot's scheduled tasks are its own — made in its chat or on
 * the Bot page, run in its chat as it, and never listed on Automations.
 */
section("a bot's scheduled tasks are its own");
{
  const keeper = await alice.call('POST', '/api/bots', { name: 'Keeper', role: 'k' });
  const id = keeper.body.bot.id;
  const made = await alice.call('POST', `/api/bots/${id}/tasks`, { title: 'Morning digest', prompt: 'Sum up the news.', when: '07:00' });
  check('a bot gets a scheduled task of its own from its details', made.status === 201 && made.body.task?.bot_id === id, made.text.slice(0, 160));
  check('  listed with the bot', (await alice.call('GET', `/api/bots/${id}/tasks`)).body.tasks.some((t) => t.id === made.body.task.id));
  check('  and not on Automations', !(await alice.call('GET', '/api/tasks')).body.tasks.some((t) => t.id === made.body.task.id) && !((await alice.call('GET', '/api/automations/summary')).body?.tasks || []).some?.((t) => t.id === made.body.task.id));
  check('  nor in another bot\'s list', !(await alice.call('GET', `/api/bots/${chief.id}/tasks`)).body.tasks.some((t) => t.id === made.body.task.id));
  check('  a time it cannot read is refused', (await alice.call('POST', `/api/bots/${id}/tasks`, { title: 'x', prompt: 'y', when: 'whenever' })).status === 400);
  // Made by the bot itself, in its own chat.
  const { executeTool } = await import('../server/tools/execute.js');
  const chatId = (await alice.call('GET', `/api/bots/${id}/chat`)).body.chatId;
  const user = await store.getUserById(aliceId);
  const told = await executeTool({ user, name: 'schedule_task', input: { title: 'Weekly review', prompt: 'Review the week.', when: 'mon 09:00' }, chatId });
  const tasks = await store.listTasks(aliceId, { botId: id });
  check('schedule_task in a bot\'s chat makes that bot\'s task', tasks.some((t) => t.title === 'Weekly review' && t.bot_id === id), told?.content?.slice?.(0, 120) || JSON.stringify(told).slice(0, 120));
  const { runTaskNow } = await import('../server/scheduler.js');
  const task = tasks.find((t) => t.title === 'Weekly review');
  const ran = await runTaskNow(task).catch((err) => ({ error: err.message }));
  check('  and it runs in the bot\'s own chat, as the bot', ran?.chatId === chatId && asked.at(-1)?.who === 'keeper', JSON.stringify(ran));
  await alice.call('DELETE', `/api/bots/${id}`);
  check('its tasks go with the bot', (await store.listTasks(aliceId, { every: true })).every((t) => t.bot_id !== id));
}

// Owner, 2026-11-10: incognito in the top bar holds with a bot too.
section('an incognito conversation with a bot keeps nothing');
{
  const own = (await alice.call('GET', `/api/bots/${chief.id}/chat`)).body.chatId;
  const secret = await alice.call('GET', `/api/bots/${chief.id}/chat?incognito=1`);
  check('incognito gives a conversation of its own, not the bot\'s chat', secret.status === 200 && secret.body.incognito === true && secret.body.chatId !== own && secret.body.messages.length === 0, secret.text.slice(0, 120));
  const again = await alice.call('GET', `/api/bots/${chief.id}/chat?incognito=1`);
  check('  a new one each time', again.body.chatId !== secret.body.chatId);
  check('  and the bot\'s own chat is still the one it was', (await alice.call('GET', `/api/bots/${chief.id}/chat`)).body.chatId === own);
  await alice.call('POST', `/api/chats/${secret.body.chatId}/messages`, { text: 'hello' });
  await alice.stream(`/api/chats/${secret.body.chatId}/run`, {});
  const req = asked.filter((a) => a.who === 'chief').at(-1);
  check('  its memory is neither read nor offered to save', /This conversation is incognito/.test(req?.system || '') && !/The user is called Alice/.test(req?.system || '') && !req?.tools.includes('remember'), (req?.tools || []).filter((n) => /remember|bot/.test(n)).join());
  check('  and it is kept out of the conversation list', !((await alice.call('GET', '/api/chats')).body?.chats || []).some((c) => c.id === secret.body.chatId));
}

section('a bot with nothing saved still knows it may save on its own');
{
  const fresh = await alice.call('POST', '/api/bots', { name: 'Newbie', role: 'n' });
  const chatId = (await alice.call('GET', `/api/bots/${fresh.body.bot.id}/chat`)).body.chatId;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hi' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const req = asked.filter((a) => a.who === 'newbie').at(-1);
  check('its prompt has its memory section, empty', /## Your memory, Newbie/.test(req?.system || '') && /\(Nothing saved yet\.\)/.test(req?.system || ''), (req?.system || '').slice(-300));
  check('  saying to save on its own, without being asked', /save with `remember` on your own, without being asked/.test(req?.system || ''));
  check('  and it is offered remember', req?.tools.includes('remember'));
  await alice.call('DELETE', `/api/bots/${fresh.body.bot.id}`);
}

/*
 * Owner, 2026-11-10: a group says in its own log everything that changes in it — made, a bot
 * added or taken out, a new name, a new admin, a member renamed or deleted — as a notice the
 * page draws in the middle, and the members read too.
 */
section('a group says in its own log what changed in it');
{
  const one = (await alice.call('POST', '/api/bots', { name: 'Ana', role: 'a' })).body.bot;
  const two = (await alice.call('POST', '/api/bots', { name: 'Ben', role: 'b' })).body.bot;
  const made = (await alice.call('POST', '/api/bot-groups', { name: 'Desk', members: [chief.id, one.id], admin: chief.id })).body.group;
  const notices = async () => (await alice.call('GET', `/api/bot-groups/${made.id}/chat`)).body.messages.filter((m) => m.notice);
  let seen = await notices();
  check('made: who is in it, said once', seen.length === 1 && seen[0].notice === 'made' && seen[0].params.members.join() === [chief.id, one.id].join() && /Group chat made with Chief, Ana; Chief is the admin\./.test(seen[0].text), JSON.stringify(seen));
  await alice.call('PATCH', `/api/bot-groups/${made.id}`, { name: 'Front Desk', members: [chief.id, two.id], admin: two.id });
  seen = (await notices()).slice(1);
  const kinds = seen.map((m) => `${m.notice}:${m.params.name}`);
  check('a new name, the bot that joined, the one that left, the new admin — a line each', kinds.join() === 'renamed:Front Desk,joined:Ben,left:Ana,admin:Ben', kinds.join());
  check('  in words the members read too', seen.map((m) => m.text).join(' | ') === 'The group is now called Front Desk. | Ben joined the group. | Ana left the group. | Ben is the admin now.', seen.map((m) => m.text).join(' | '));
  const before = (await notices()).length;
  await alice.call('PATCH', `/api/bot-groups/${made.id}`, { name: 'Front Desk', members: [chief.id, two.id], admin: two.id });
  check('  a save that changes nothing says nothing', (await notices()).length === before);
  await alice.call('PATCH', `/api/bots/${two.id}`, { name: 'Benny' });
  const last = (await notices()).at(-1);
  check('a member renamed is said in its groups', last?.notice === 'botRenamed' && last.params.from === 'Ben' && last.params.name === 'Benny', JSON.stringify(last));
  await alice.call('DELETE', `/api/bots/${two.id}`);
  const tail = (await notices()).slice(-2).map((m) => `${m.notice}:${m.params.name}`);
  check('a member deleted is said there, with who answers now when it was the admin', tail.join() === 'deleted:Benny,admin:Chief', tail.join());
  const team = (await alice.call('GET', '/api/bots')).body;
  check('  and the list shows the last thing said, never a notice', !(team.groups.find((g) => g.id === made.id)?.last), JSON.stringify(team.groups.find((g) => g.id === made.id)?.last));
  await alice.call('DELETE', `/api/bot-groups/${made.id}`);
  await alice.call('DELETE', `/api/bots/${one.id}`);
}

section('a round that waits, joins, carries on and is watched (owner, 2026-11-10)');
{
  const ping = (await store.listBots(aliceId)).find((b) => b.name === 'Ping');
  const pong = (await store.listBots(aliceId)).find((b) => b.name === 'Pong');
  const loop = (await store.listBotGroups(aliceId)).find((g) => g.name === 'Loop');
  const waiting = (await store.getBotGroup(aliceId, loop.id)).pending;
  check('the ceiling left its queue for Continue', waiting?.reason === 'ceiling' && waiting.queue.length > 0, JSON.stringify(waiting));
  const before = asked.length;
  const pressed = await alice.stream(`/api/bot-groups/${loop.id}/continue`, {});
  check('Continue carries it on, with a fresh allowance', pressed.events.find((e) => e.event === 'done')?.data?.handoffs > 0 && asked.length > before, JSON.stringify(pressed.events.find((e) => e.event === 'done')?.data));
  check("  another account cannot press it", (await bob.call('POST', `/api/bot-groups/${loop.id}/continue`, {})).status === 404);
  const log = (await alice.call('GET', `/api/bot-groups/${loop.id}/chat`)).body;
  const since = log.messages.at(-1).seq;
  const nothing = await alice.call('GET', `/api/bot-groups/${loop.id}/live?since=${since}`);
  check('live: nothing new after the last line', nothing.status === 200 && nothing.body.messages.length === 0 && nothing.body.running === false, nothing.text.slice(0, 200));

  // Another segment holds the group: what the person writes joins it.
  const runId = crypto.randomUUID();
  const seq = await store.claimChatRun(aliceId, log.chatId, runId);
  const joined = await alice.call('POST', `/api/bot-groups/${loop.id}/run`, { text: '@Pong one more', model: 'openai/plain' });
  check('writing while the group works is taken, not refused', joined.status === 200 && joined.body.joined === true && joined.body.message.text === '@Pong one more', joined.text.slice(0, 200));
  const seenLive = await alice.call('GET', `/api/bot-groups/${loop.id}/live?since=${since}`);
  check('  and shows at once to whoever watches', seenLive.body.running === true && seenLive.body.messages.some((m) => m.text === '@Pong one more'), seenLive.text.slice(0, 300));
  check('  another account cannot watch it', (await bob.call('GET', `/api/bot-groups/${loop.id}/live?since=0`)).status === 404);
  await store.releaseChatRun(aliceId, log.chatId, runId, seq);

  const changed = await alice.call('PATCH', `/api/bot-groups/${loop.id}/model`, { model: 'openai/other' });
  check('the chip changed while a group is open is the group\'s model', changed.status === 200 && (await store.getBotGroup(aliceId, loop.id)).model === 'openai/other');
  check('  a model id is checked', (await alice.call('PATCH', `/api/bot-groups/${loop.id}/model`, { model: 'not a model; drop' })).status === 400);

  await store.setGroupPending(aliceId, loop.id, { queue: [{ botId: ping.id }], handoffs: 0, segments: 1, reason: 'time', owed: {}, working: [], lastSeq: since, at: new Date().toISOString() });
  await alice.call('POST', `/api/bot-groups/${loop.id}/stop`);
  check('Stop lets go of what was waiting too', (await store.getBotGroup(aliceId, loop.id)).pending === null);
  check('  nothing waiting: Continue says so', (await alice.call('POST', `/api/bot-groups/${loop.id}/continue`, {})).status === 409);

  const internal = await fetch(`${base}/api/internal/bot-rounds/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: aliceId, groupId: loop.id }) });
  check('the internal route for the next segment needs the deployment secret', internal.status === 401 || internal.status === 503, String(internal.status));
  void pong;
}

section('a turn that is stopped takes back what it saved (owner, 2026-11-10)');
{
  const saver = (await alice.call('POST', '/api/bots', { name: 'Saver', role: 's' })).body.bot;
  const own = (await alice.call('GET', `/api/bots/${saver.id}/chat`)).body;
  await alice.call('POST', `/api/chats/${own.chatId}/messages`, { text: 'note something then keep going' });
  const running = alice.stream(`/api/chats/${own.chatId}/run`, {});
  const from = Date.now();
  while (!(await store.listBotMemory(aliceId, { botId: saver.id })).length && Date.now() - from < 8000) await new Promise((r) => setTimeout(r, 50));
  check('it saved while it worked', (await store.listBotMemory(aliceId, { botId: saver.id })).length === 1);
  await new Promise((r) => setTimeout(r, 300));
  await alice.call('POST', `/api/chats/${own.chatId}/stop`);
  await running;
  check('  and once stopped, that save is taken back', (await store.listBotMemory(aliceId, { botId: saver.id })).length === 0, JSON.stringify(await store.listBotMemory(aliceId, { botId: saver.id })));
}

section('reset empties a conversation and keeps the memory (owner, 2026-11-10)');
{
  const writer = (await alice.call('POST', '/api/bots', { name: 'Resetter', role: 'r' })).body.bot;
  const own = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body;
  await alice.call('POST', `/api/chats/${own.chatId}/messages`, { text: 'a line to reset' });
  await alice.call('POST', `/api/bots/${writer.id}/memory`, { text: 'Kept across a reset' });
  check('another account cannot reset it', (await bob.call('POST', `/api/bots/${writer.id}/reset`)).status === 404);
  const done = await alice.call('POST', `/api/bots/${writer.id}/reset`);
  const after = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body;
  check("a bot's chat is emptied", done.status === 200 && after.messages.length === 0 && after.chatId !== own.chatId, done.text);
  check('  its memory kept', (await alice.call('GET', `/api/bots/${writer.id}/memory`)).body.entries.some((e) => e.text === 'Kept across a reset'));

  const blog = (await alice.call('POST', '/api/bot-groups', { name: 'Reset Room', members: [writer.id] })).body.group;
  await alice.call('POST', `/api/bot-groups/${blog.id}/memory`, { text: 'Posts go out on Fridays' });
  const log = (await alice.call('GET', `/api/bot-groups/${blog.id}/chat`)).body;
  check('the group has lines to lose', log.messages.length > 0, String(log.messages.length));
  const runId = crypto.randomUUID();
  const seq = await store.claimChatRun(aliceId, log.chatId, runId);
  check('a group at work is not reset under its feet', (await alice.call('POST', `/api/bot-groups/${blog.id}/reset`)).status === 409);
  await store.releaseChatRun(aliceId, log.chatId, runId, seq);
  const reset = await alice.call('POST', `/api/bot-groups/${blog.id}/reset`);
  const empty = (await alice.call('GET', `/api/bot-groups/${blog.id}/chat`)).body;
  check("a group's log is emptied", reset.status === 200 && empty.messages.length === 0, reset.text);
  check('  its memory kept', (await alice.call('GET', `/api/bot-groups/${blog.id}/memory`)).body.entries.some((e) => /Fridays/.test(e.text)));
}

await new Promise((r) => server.close(r));
provider.closeAllConnections?.();
provider.close();
console.log(failures === 0 ? '\n\x1b[32mAll bot checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
