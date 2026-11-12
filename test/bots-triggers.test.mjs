/**
 * Work that starts outside the app (owner, 2026-11-11, spec
 * docs/superpowers/specs/2026-11-10-bots-triggers-design.md): a bot's task started by a
 * signed request, waits a bot parks until its next run, Telegram to Chief, and the outbox
 * that sends a reply once.
 *
 * Against an in-process Postgres, with stand-ins for the agent loop and for Telegram
 * (a fetch that records every address it is asked for).
 *
 *   node test/bots-triggers.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'bots-triggers-test-encryption-key';
process.env.SESSION_SECRET ||= 'bots-triggers-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-bots-triggers-test-${process.pid}`);
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
const { encryptSecret } = await import('../server/crypto.js');

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const id = () => crypto.randomUUID();
const user = await store.createUser({ id: id(), role: 'user', name: 'Trig', email: 'trig@bots.test', passwordHash: 'x' });
const other = await store.createUser({ id: id(), role: 'user', name: 'Other', email: 'other-trig@bots.test', passwordHash: 'x' });
const uid = user.id;
const chief = await store.createBot(uid, { id: id(), name: 'Chief', role: 'Chief of Staff', avatar: 'cosmic-whale', isMain: true });
const scout = await store.createBot(uid, { id: id(), name: 'Scout', role: 'Researcher', avatar: 'owl' });

/* ── Task 1: the store ─────────────────────────────────────────── */

section('schema 47: routes, receipts, waits, Telegram, the outbox');
{
  const task = await store.createTask(uid, { id: id(), title: 'On push', prompt: 'Look at what was pushed', botId: scout.id, trigger: 'hook' });
  check('a task can be started by a request', task?.trigger === 'hook' && task.next_run_at === null);
  const route = await store.createHookRoute(uid, { id: 'route-store-test-1', taskId: task.id, secretEnc: 'sealed' });
  check('  its route is made', route?.task_id === task.id);
  check('  not for another account\'s task', (await store.createHookRoute(other.id, { id: 'route-store-test-2', taskId: task.id, secretEnc: 'x' })) === null);
  const looked = await store.getHookRoute('route-store-test-1');
  check('  looked up by its id, with what its task needs', looked?.task_enabled === true && looked.bot_id === scout.id && looked.trigger === 'hook');
  check('a receipt is written once', (await store.addHookReceipt({ key: 'k1', userId: uid, routeId: route.id, source: 'hook', deliveryId: 'd1', status: 'accepted' })) === true && (await store.addHookReceipt({ key: 'k1', userId: uid, routeId: route.id, source: 'hook', deliveryId: 'd1', status: 'accepted' })) === false);
  check('  and listed for its route, not another account', (await store.listHookReceipts(uid, route.id)).length === 1 && (await store.listHookReceipts(other.id, route.id)).length === 0);
  await store.deleteTask(uid, task.id);
  check('a task deleted takes its route with it', (await store.getHookRoute('route-store-test-1')) === null);
}

/* ── Task 2: webhooks ──────────────────────────────────────────── */

const hooks = await import('../server/hooks.js');
const scheduler = await import('../server/scheduler.js');
const hookTask = await store.createTask(uid, { id: id(), title: 'Build watcher', prompt: 'Say whether the build passed.', botId: scout.id, trigger: 'hook' });
let secret = hooks.newHookSecret();
const routeId = hooks.newRouteId();
const route = await store.createHookRoute(uid, { id: routeId, taskId: hookTask.id, secretEnc: hooks.sealHookSecret(secret, { userId: uid, routeId }) });
const started = [];
const start = (job) => started.push(job);
const deliver = (body, { delivery = id(), ts = Math.floor(Date.now() / 1000), sign = secret, sig = null } = {}) => {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const timestamp = String(ts);
  const signature = sig ?? hooks.signHook(sign, { timestamp, delivery, body: raw });
  return hooks.acceptHook({ routeId: route.id, raw, headers: { 'x-synapsez-timestamp': timestamp, 'x-synapsez-delivery': delivery, 'x-synapsez-signature': signature }, start });
};

section('a request is checked on its bytes before it is read');
{
  const bad = await deliver('{not json at all', { sig: 'sha256=' + '0'.repeat(64) });
  check('a wrong signature is refused before the body is parsed (401, not 400)', bad.status === 401 && /signature/i.test(bad.body.error), JSON.stringify(bad));
  const stale = await deliver({ type: 'build.done' }, { ts: Math.floor(Date.now() / 1000) - 600 });
  check('  a timestamp ten minutes old is refused', stale.status === 401 && /timestamp/i.test(stale.body.error));
  const otherKey = await deliver({ type: 'build.done' }, { sign: 'whsec_not-the-one' });
  check('  a body signed with another secret is refused', otherKey.status === 401);
  const notJson = await deliver('{not json');
  check('signed but not JSON: 400', notJson.status === 400);
  const noType = await deliver({ data: {} });
  check('  no type: 400', noType.status === 400);
  const big = await deliver({ type: 'x', data: 'y'.repeat(70_000) });
  check('  more than 64 KB: 413', big.status === 413);
  check('nothing ran for any of them', started.length === 0);
  check('an unknown route is 404', (await hooks.acceptHook({ routeId: 'no-such-route-here', raw: Buffer.from('{}'), headers: {}, start })).status === 404);
}

section('a delivery runs once; filters; 202 and the run behind it');
{
  const delivery = 'gh-delivery-1';
  const first = await deliver({ type: 'build.done', data: { status: 'passed', repo: { name: 'site' } } }, { delivery });
  check('accepted at once with 202', first.status === 202 && first.body.accepted === true && started.length === 1, JSON.stringify(first));
  const again = await deliver({ type: 'build.done', data: { status: 'passed' } }, { delivery });
  check('  the same delivery again is a duplicate, and runs nothing', again.status === 200 && again.body.duplicate === true && started.length === 1);
  await store.setHookFilters(uid, hookTask.id, hooks.cleanFilters({ type: 'build.done', match: [{ pointer: '/repo/name', value: 'site' }] }));
  const wrongType = await deliver({ type: 'build.started', data: { repo: { name: 'site' } } });
  const wrongRepo = await deliver({ type: 'build.done', data: { repo: { name: 'docs' } } });
  const right = await deliver({ type: 'build.done', data: { repo: { name: 'site' } } });
  check('a filtered-out type is ignored, with why', wrongType.status === 200 && /type/.test(wrongType.body.ignored || ''), JSON.stringify(wrongType));
  check('  a JSON-Pointer mismatch too', /\/repo\/name/.test(wrongRepo.body.ignored || ''), JSON.stringify(wrongRepo));
  check('  the match runs', right.status === 202 && started.length === 2);
  let refused = '';
  try {
    hooks.cleanFilters({ match: Array.from({ length: 6 }, (_, i) => ({ pointer: `/a${i}`, value: 1 })) });
  } catch (err) {
    refused = err.message;
  }
  check('at most five filters', /at most 5/.test(refused));
  await store.setHookFilters(uid, hookTask.id, {});

  // The run behind the 202: the task's turn, its payload as data, a 'webhook' turn.
  let seen = null;
  scheduler.__agent.use(async ({ chatId, emit, runControl }) => {
    const history = await store.listMessages(uid, chatId);
    seen = { last: history.at(-1), runControl };
    await store.appendMessage(uid, chatId, { id: id(), role: 'assistant', text: 'The build passed.' });
    emit('done', { stopReason: 'end_turn' });
  });
  await hooks.runHookJob(started[0]);
  scheduler.__agent.use(null);
  check('the run starts as a webhook\'s, not the person\'s', seen?.last?.origin === 'webhook', JSON.stringify(seen?.last?.origin));
  check('  the task\'s prompt, then the payload inside the untrusted envelope', /^Say whether the build passed\./.test(seen?.last?.text || '') && /<untrusted source="a request to this task from outside the app \(event &quot;build\.done&quot;\)"|<untrusted source="a request to this task from outside the app/.test(seen?.last?.text || '') && /"status": "passed"/.test(seen?.last?.text || ''), (seen?.last?.text || '').slice(0, 240));
  check('  and may say it has nothing new or failed', seen?.runControl === true);
  const receipts = await store.listHookReceipts(uid, route.id);
  check('the receipt says it ran; ignored ones say why; no body is kept', receipts.some((r) => r.delivery_id === 'gh-delivery-1' && r.status === 'ran') && receipts.some((r) => r.status === 'ignored' && /repo/.test(r.reason || '')) && !JSON.stringify(receipts).includes('passed'), JSON.stringify(receipts.map((r) => [r.status, r.reason])));

  const { runBotTool } = await import('../server/bots/tools.js');
  const ownChat = await store.botChat(uid, { botId: chief.id, title: 'Chief' });
  const team = await runBotTool({ userId: uid, chatId: ownChat.id, name: 'create_bot', input: { name: 'Mole', role: 'x', instructions: 'x' }, turnOrigin: 'webhook' });
  check('a turn a webhook started cannot reshape the team', team.isError && /request from outside the app/.test(team.content), team.content);
}

section('rotate: the old secret stops at once; a test is sent from the server');
{
  const old = secret;
  secret = hooks.newHookSecret();
  await store.rotateHookRoute(uid, hookTask.id, hooks.sealHookSecret(secret, { userId: uid, routeId: route.id }));
  const withOld = await deliver({ type: 'build.done' }, { sign: old });
  const withNew = await deliver({ type: 'build.done' });
  check('the old secret is refused after Rotate', withOld.status === 401);
  check('  the new one works', withNew.status === 202);
  const test = await hooks.sendTestHook({ userId: uid, taskId: hookTask.id, start });
  check('Gửi thử: a signed test event through the same door', test.status === 202 && started.at(-1).event.type === 'test');
  check('  not for another account\'s task', (await hooks.sendTestHook({ userId: other.id, taskId: hookTask.id, start })).status === 404);
}

section('rate limits per route');
{
  const busy = await store.createTask(uid, { id: id(), title: 'Busy', prompt: 'x', botId: scout.id, trigger: 'hook' });
  const s2 = hooks.newHookSecret();
  const r2Id = hooks.newRouteId();
  const r2 = await store.createHookRoute(uid, { id: r2Id, taskId: busy.id, secretEnc: hooks.sealHookSecret(s2, { userId: uid, routeId: r2Id }) });
  let last = null;
  for (let i = 0; i <= hooks.HOOK_PER_MINUTE; i += 1) {
    const raw = Buffer.from(JSON.stringify({ type: 'tick' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const delivery = `tick-${i}`;
    last = await hooks.acceptHook({ routeId: r2.id, raw, headers: { 'x-synapsez-timestamp': timestamp, 'x-synapsez-delivery': delivery, 'x-synapsez-signature': hooks.signHook(s2, { timestamp, delivery, body: raw }) }, start: () => {} });
  }
  check(`the ${hooks.HOOK_PER_MINUTE + 1}th request in a minute is refused`, last?.status === 429, JSON.stringify(last));
}

/* ── Task 3: waits ─────────────────────────────────────────────── */

section('waits: parked, capped, offered to the next run, closed');
{
  const { runBotTool } = await import('../server/bots/tools.js');
  const own = await store.botChat(uid, { botId: scout.id, title: 'Scout' });
  await store.appendMessage(uid, own.id, { id: 'ask-1', role: 'user', text: 'Tell me when the price of gold drops below 2000.' });
  const parked = await runBotTool({ userId: uid, chatId: own.id, name: 'wait_for', input: { note: 'Check the gold price; settled when below 2000.' }, turnOrigin: 'person' });
  const waits = await store.listBotWaits(uid, scout.id);
  check('wait_for parks the request with its note', !parked.isError && waits.length === 1 && waits[0].request.startsWith('Tell me when the price of gold') && waits[0].message_id === 'ask-1', parked.content);
  const group = await store.createBotGroup(uid, { id: id(), name: 'Desk', adminBotId: scout.id, members: [scout.id] });
  const inGroup = await store.botChat(uid, { botId: scout.id, groupId: group.id, title: 'Scout · Desk' });
  check('  not in a group', (await runBotTool({ userId: uid, chatId: inGroup.id, name: 'wait_for', input: { note: 'x' } })).isError);
  for (let i = 0; i < 19; i += 1) await store.addBotWait(uid, { id: id(), botId: scout.id, request: `r${i}`, note: `n${i}` });
  const over = await runBotTool({ userId: uid, chatId: own.id, name: 'wait_for', input: { note: 'one too many' } });
  check('  at most 20 open', over.isError && /20 open waits/.test(over.content), over.content);
  const note = await scheduler.waitsNote(uid, scout.id);
  check('the next run is told each open wait, its request and note', note.includes(waits[0].id) && /gold price/.test(note) && /close_wait/.test(note));
  check('  another bot\'s run is not', (await scheduler.waitsNote(uid, chief.id)) === '');
  const closed = await runBotTool({ userId: uid, chatId: own.id, name: 'close_wait', input: { id: waits[0].id, outcome: 'Gold fell to 1980.' } });
  check('close_wait closes it, with what came of it', !closed.isError && !(await store.listBotWaits(uid, scout.id)).some((w) => w.id === waits[0].id));
  const chiefChat = await store.botChat(uid, { botId: chief.id, title: 'Chief' });
  check('  a bot cannot close another bot\'s wait', (await runBotTool({ userId: uid, chatId: chiefChat.id, name: 'close_wait', input: { id: (await store.listBotWaits(uid, scout.id))[0].id, outcome: 'x' } })).isError);
  const anyWait = (await store.listBotWaits(uid, scout.id))[0];
  check('the person closes one by its chip; another account cannot', (await store.closeBotWait(other.id, anyWait.id)) === null && !!(await store.closeBotWait(uid, anyWait.id, { botId: scout.id, outcome: 'closed by the user' })));
}

/* ── Task 4: the outbox and Telegram ───────────────────────────── */

const outbox = await import('../server/outbox.js');
const tg = await import('../server/telegramInbound.js');
await store.saveConnector(uid, 'telegram', encryptSecret('123456:TEST-TOKEN', ['connector', uid, 'telegram']), '@synapsez_test_bot');
/** Telegram, faked: every address asked, and what it answers. */
function fakeTelegram(answer = () => ({ ok: true, result: { message_id: 77 } })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    calls.push({ url: String(url), method: String(url).split('/').pop(), body });
    const a = answer(String(url).split('/').pop(), body, calls.length);
    return { status: a.status || 200, json: async () => a };
  };
  return { calls, fetchImpl };
}

section('the outbox sends once, retries what failed, drops what cannot go');
{
  const fake = fakeTelegram();
  const one = await outbox.sendTelegramNow({ userId: uid, chatId: 42, text: 'Hello', key: 'turn-1', fetchImpl: fake.fetchImpl });
  check('sent, and its message id kept', one.sent && one.rows[0].provider_id === '77' && fake.calls.length === 1);
  const twice = await outbox.sendTelegramNow({ userId: uid, chatId: 42, text: 'Hello', key: 'turn-1', fetchImpl: fake.fetchImpl });
  check('  the same key again sends nothing', twice.sent && fake.calls.length === 1);
  check('only api.telegram.org was asked', fake.calls.every((c) => c.url.startsWith('https://api.telegram.org/bot')));

  let fail = true;
  const flaky = fakeTelegram(() => (fail ? { ok: false, status: 502, description: 'Bad Gateway' } : { ok: true, result: { message_id: 88 } }));
  const later = await outbox.sendTelegramNow({ userId: uid, chatId: 42, text: 'Retry me', key: 'turn-2', fetchImpl: flaky.fetchImpl });
  check('a failure that may pass is kept for later', !later.sent && later.later && later.rows[0].attempts === 1);
  await store.query("UPDATE outbox SET due_at = NOW() - INTERVAL '1 second' WHERE id = $1", [later.rows[0].id]);
  fail = false;
  await outbox.flushOutbox({ userId: uid, fetchImpl: flaky.fetchImpl });
  await outbox.flushOutbox({ userId: uid, fetchImpl: flaky.fetchImpl });
  const row = await store.getOutbox(later.rows[0].id);
  check('  and sent exactly once on the retry', row.status === 'sent' && flaky.calls.filter((c) => c.body.text === 'Retry me').length === 2 && row.provider_id === '88', `${flaky.calls.length} calls`);
  check('  backing off: 30 s, then twice as long, up to an hour', outbox.backoffMs(1) === 30_000 && outbox.backoffMs(2) === 60_000 && outbox.backoffMs(20) === 3_600_000);

  const gone = fakeTelegram(() => ({ ok: false, status: 403, description: 'Forbidden: bot was blocked by the user' }));
  const dropped = await outbox.sendTelegramNow({ userId: uid, chatId: 43, text: 'Nobody', key: 'turn-3', fetchImpl: gone.fetchImpl });
  check('a chat that is gone drops it, with the reason', dropped.dropped && /blocked/.test(dropped.dropped) && dropped.rows[0].status === 'dropped');
  const long = outbox.splitText(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
  check('a long text goes in parts that fit', long.length === 2 && long.every((p) => p.length <= outbox.TELEGRAM_TEXT));
}

section('Telegram to Chief: turned on, linked, gated, answered once');
{
  const fake = fakeTelegram((method) => (method === 'getMe' ? { ok: true, result: { username: 'synapsez_test_bot' } } : { ok: true, result: method === 'sendMessage' ? { message_id: 501 } : true }));
  let refused = '';
  try {
    await tg.enableTelegram(uid, { base: 'http://localhost:3000', fetchImpl: fake.fetchImpl });
  } catch (err) {
    refused = err.message;
  }
  check('only an https address can be given to Telegram', /https/.test(refused));
  const row = await tg.enableTelegram(uid, { base: 'https://app.example', fetchImpl: fake.fetchImpl });
  const setHook = fake.calls.find((c) => c.method === 'setWebhook');
  const pathSecret = setHook.body.url.split('/').pop();
  const headerSecret = setHook.body.secret_token;
  check('turning it on points the webhook at this account\'s own address, with a header secret', /^https:\/\/app\.example\/api\/hooks\/telegram\/[\w-]{20,}$/.test(setHook.body.url) && headerSecret.length >= 32 && row.enabled);
  check('  only hashes are kept', row.path_hash !== pathSecret && row.token_hash !== headerSecret && !JSON.stringify(row).includes(headerSecret));
  check('  and Settings sees a code, never a secret', /^\d{6}$/.test(tg.telegramView(row).startCode || '') && !JSON.stringify(tg.telegramView(row)).includes(headerSecret));

  const turns = [];
  const startTurn = (job) => turns.push(job);
  let updateId = 1000;
  const send = (message, { header = headerSecret, secretPath = pathSecret, update = (updateId += 1) } = {}) =>
    tg.acceptTelegram({ secret: secretPath, raw: Buffer.from(JSON.stringify({ update_id: update, message })), headers: { 'x-telegram-bot-api-secret-token': header }, start: startTurn, fetchImpl: fake.fetchImpl });
  const dm = (text, from = 111) => ({ message_id: updateId, from: { id: from }, chat: { id: from, type: 'private' }, text });

  check('a wrong header secret is refused', (await send(dm('hi'), { header: 'nope' })).status === 401);
  check('  a wrong address is not there', (await send(dm('hi'), { secretPath: 'x'.repeat(32) })).status === 404);
  const stranger = await send(dm('hello Chief', 999));
  check('a sender nobody allowed is ignored (200, so Telegram does not retry)', stranger.status === 200 && turns.length === 0);
  const wrongCode = await send(dm('/start 000000'));
  check('  a wrong code links nobody', wrongCode.status === 200 && (await store.getTelegramInbound(uid)).allowed_ids.length === 0);
  await send(dm(`/start ${row.start_code}`));
  check('"/start <code>" links the person\'s own id, and says so', (await store.getTelegramInbound(uid)).allowed_ids[0] === '111' && fake.calls.some((c) => c.method === 'sendMessage' && /Linked/.test(c.body.text)));
  const groupNoMention = await send({ message_id: 5, from: { id: 111 }, chat: { id: -100, type: 'group' }, text: 'just chatting' });
  check('a group message that does not mention the bot is ignored', groupNoMention.status === 200 && turns.length === 0);
  await send({ message_id: 6, from: { id: 111 }, chat: { id: -100, type: 'group' }, text: '@synapsez_test_bot what is on today?' });
  check('  one that mentions it is taken', turns.length === 1 && /what is on today/.test(turns[0].text));
  const repeat = updateId;
  await send(dm('Plan my day'), { update: repeat });
  check('the same update again is taken once', turns.length === 1);
  await send(dm('Plan my day'));
  check('  a new one is taken', turns.length === 2);
  check('the person may allow at most five more ids', await tg.setTelegramOthers(uid, ['222', '333']).then((r) => r.allowed_ids.join() === '111,222,333') && (await tg.setTelegramOthers(uid, ['1001', '1002', '1003', '1004', '1005', '1006']).catch((e) => e.message)).includes('At most 5'));

  // The turn: in Chief's chat, a 'webhook' one; the answer back once, as a reply.
  const reactions = [];
  const live = fakeTelegram((method, body) => {
    if (method === 'setMessageReaction') reactions.push(body.reaction[0].emoji);
    return { ok: true, result: method === 'sendMessage' ? { message_id: 900 } : true };
  });
  let origin = '';
  const fakeAgent = async ({ chatId, turnOrigin, unattended }) => {
    origin = `${turnOrigin}:${unattended}`;
    await store.appendMessage(uid, chatId, { id: id(), role: 'assistant', text: 'Here is your day: write, then walk.' });
  };
  const job = { ...turns[1], runAgent: fakeAgent, fetchImpl: live.fetchImpl };
  const ran = await tg.runTelegramTurn(job);
  const chiefChat = await store.botChat(uid, { botId: chief.id, title: 'Chief' });
  const lines = await store.listMessages(uid, chiefChat.id);
  check('the message is a turn in Chief\'s chat, started by a webhook, unattended', lines.some((m) => m.role === 'user' && m.text === 'Plan my day' && m.origin === 'webhook' && m.via === 'telegram') && origin === 'webhook:true', origin);
  const replies = live.calls.filter((c) => c.method === 'sendMessage');
  check('  the answer goes back once, as a reply to the message', ran.status === 'ran' && replies.length === 1 && replies[0].body.text === 'Here is your day: write, then walk.' && replies[0].body.reply_parameters?.message_id === turns[1].message.message_id);
  check('  👀 while it works, ✅ at the end', reactions.join() === '👀,✅', reactions.join());
  await tg.runTelegramTurn(job);
  check('run again (a retry), the reply is not sent twice', live.calls.filter((c) => c.method === 'sendMessage' && c.body.text === 'Here is your day: write, then walk.').length === 1);
  check('only api.telegram.org was asked', [...fake.calls, ...live.calls].every((c) => c.url.startsWith('https://api.telegram.org/')));

  // Stop by text: what Chief is doing on this instance ends.
  const { holdRun } = await import('../server/liveRuns.js');
  const controller = new AbortController();
  const letGo = holdRun(uid, chiefChat.id, controller);
  const stop = await send(dm('stop'));
  check('"stop" from the same sender stops what Chief is doing', stop.status === 200 && controller.signal.aborted && turns.length === 2);
  letGo();

  const off = await tg.disableTelegram(uid, { fetchImpl: fake.fetchImpl });
  check('turning it off deletes the webhook, and what still arrives is refused', !off.enabled && fake.calls.some((c) => c.method === 'deleteWebhook') && (await send(dm('hi'))).status === 404);
}

section('the bins: receipts after a week, closed waits after a month, the sent outbox after a week');
{
  await store.query("UPDATE hook_receipts SET at = NOW() - INTERVAL '8 days'");
  await store.query("UPDATE bot_waits SET closed_at = NOW() - INTERVAL '31 days' WHERE closed_at IS NOT NULL");
  await store.query("UPDATE outbox SET created_at = NOW() - INTERVAL '8 days' WHERE status <> 'pending'");
  await store.pruneTriggers();
  const left = await store.query('SELECT (SELECT COUNT(*) FROM hook_receipts)::int AS r, (SELECT COUNT(*) FROM bot_waits WHERE closed_at IS NOT NULL)::int AS w, (SELECT COUNT(*) FROM outbox WHERE status <> \'pending\')::int AS o');
  check('all three swept', left[0].r === 0 && left[0].w === 0 && left[0].o === 0, JSON.stringify(left[0]));
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
