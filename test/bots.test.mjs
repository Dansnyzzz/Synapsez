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

function script(model, messages) {
  const system = textOf(messages.find((m) => m.role === 'system'));
  const last = messages.at(-1);
  const lastUser = textOf([...messages].reverse().find((m) => m.role === 'user'));
  const afterTool = last?.role === 'tool';
  const tool = (name, args) => ({ tool: { name, args } });
  switch (model) {
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
    const record = { model, system: textOf(messages.find((m) => m.role === 'system')), lastUser: textOf([...messages].reverse().find((m) => m.role === 'user')), tools: (body.tools || []).map((t) => t.function?.name), closedAt: 0, finished: false };
    asked.push(record);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const end = (finish) => {
      record.finished = true;
      send({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (model === 'slow') {
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
  check('role, creature and model change', renamed.body.bot.role === 'Notetaker' && renamed.body.bot.avatar === 'jellyfish' && renamed.body.bot.model === 'openai/writer', renamed.text);
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

section('a bot\'s own chat runs on its model, with its instructions and memory');
{
  await alice.call('PATCH', `/api/bots/${chief.id}`, { model: 'openai/chief', instructions: 'Always sign off with -C.' });
  await alice.call('POST', `/api/bots/${chief.id}/memory`, { text: 'The user is called Alice' });
  const open = await alice.call('GET', `/api/bots/${chief.id}/chat`);
  const chatId = open.body.chatId;
  check('its chat exists, empty', !!chatId && open.body.messages.length === 0);
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hello' });
  const run = await alice.stream(`/api/chats/${chatId}/run`, { model: 'openai/plain' });
  const req = asked.at(-1);
  check('it ran on the bot\'s model, not the chip\'s', req.model === 'chief', req.model);
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
  await alice.call('PATCH', `/api/bots/${writer.id}`, { model: 'openai/writer' });
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
  const req = asked.filter((a) => a.model === 'writer').at(-2);
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
  const writerReq = asked.filter((a) => a.model === 'writer').at(-1);
  check('Writer was told who called it, with what was said', /Chief handed this to you with @Writer/.test(writerReq.lastUser) && /User: Can we get a first post\?/.test(writerReq.lastUser), writerReq.lastUser.slice(0, 200));
  check('  and its group prompt names the group and its admin', /speaking in the group chat "Blog"/.test(writerReq.system) && /Chief \(admin\)/.test(writerReq.system));
  check('  never its private chat with the person', !/remember tea|make a bot/.test(writerReq.lastUser));
  const own = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body.messages;
  check('the group\'s work does not land in Writer\'s own chat', !own.some((m) => /Draft ready/.test(m.text || '')));
  const log = await alice.call('GET', `/api/bot-groups/${blog.id}/chat`);
  check('the group\'s log keeps the four lines', log.body.messages.length === 4, String(log.body.messages.length));
  const second = await alice.stream(`/api/bot-groups/${blog.id}/run`, { text: '@Writer one more line please' });
  const p2 = second.events.filter((e) => e.event === 'post').map((e) => e.data.message);
  check('an @ from the person calls that bot straight, and only it', p2.length === 2 && p2[1].bot === writer.id, p2.map((m) => m.text).join(' | '));
  const writerSaw = asked.filter((a) => a.model === 'writer').at(-1).lastUser;
  check('  it sees only what is new since it last looked', !/Can we get a first post/.test(writerSaw) && /one more line please/.test(writerSaw), writerSaw.slice(0, 200));
  const refused = await alice.call('POST', `/api/chats/${log.body.chatId}/messages`, { text: 'sneak in' });
  check('the log is not written to by the ordinary chat routes', refused.status === 409);
}

section('group memory is the group\'s');
{
  await alice.call('POST', `/api/bot-groups/${blog.id}/memory`, { text: 'Posts go out on Fridays' });
  await alice.stream(`/api/bot-groups/${blog.id}/run`, { text: '@Writer note it' });
  const inGroup = asked.filter((a) => a.model === 'writer').at(-1);
  check('a member reads it in the group', /Group memory of "Blog"/.test(inGroup.system) && /Fridays/.test(inGroup.system));
  const chatId = (await alice.call('GET', `/api/bots/${writer.id}/chat`)).body.chatId;
  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'hi' });
  await alice.stream(`/api/chats/${chatId}/run`, {});
  const alone = asked.filter((a) => a.model === 'writer').at(-1);
  check('  and not in its own chat', !/Fridays/.test(alone.system) && /green tea/.test(alone.system));
}

section('a hand-off ceiling holds a loop between two bots');
{
  const ping = await alice.call('POST', '/api/bots', { name: 'Ping', role: 'a', model: 'openai/ping' });
  const pong = await alice.call('POST', '/api/bots', { name: 'Pong', role: 'b', model: 'openai/pong' });
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
  const q = await alice.call('POST', '/api/bots', { name: 'Quiet', role: 'q', model: 'openai/quiet' });
  const g = await alice.call('POST', '/api/bot-groups', { name: 'Hush', members: [q.body.bot.id] });
  const round = await alice.stream(`/api/bot-groups/${g.body.group.id}/run`, { text: 'anyone?' });
  check('nothing is posted for a pass', round.events.filter((e) => e.event === 'post').length === 1);
}

section('Stop ends every member\'s turn in a round');
{
  const s1 = await alice.call('POST', '/api/bots', { name: 'Slow One', role: 's', model: 'openai/slow' });
  const s2 = await alice.call('POST', '/api/bots', { name: 'Slow Two', role: 's', model: 'openai/slow' });
  const g = await alice.call('POST', '/api/bot-groups', { name: 'Slowpokes', members: [s1.body.bot.id, s2.body.bot.id] });
  const pending = alice.stream(`/api/bot-groups/${g.body.group.id}/run`, { text: '@Slow One and @Slow Two, both of you' });
  const start = Date.now();
  while (asked.filter((a) => a.model === 'slow').length < 2 && Date.now() - start < 10_000) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  const pressed = Date.now();
  const stop = await alice.call('POST', `/api/bot-groups/${g.body.group.id}/stop`);
  const round = await pending;
  const slow = asked.filter((a) => a.model === 'slow');
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

await new Promise((r) => server.close(r));
provider.closeAllConnections?.();
provider.close();
console.log(failures === 0 ? '\n\x1b[32mAll bot checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
