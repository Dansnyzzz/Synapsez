/**
 * Where a message goes, and where it does not (AUDIT_RULES P8, HAR-003).
 *
 * A turn carrying made-up personal data — a name, a phone number, a citizen ID,
 * an email — is driven end to end against a provider that answers without a
 * network. What is pinned:
 *
 *   - the provider is the only thing that receives it: no other request, TCP/TLS
 *     connection or `dns.lookup` leaves the process during the turn (`offline`);
 *   - nothing the process prints, and nothing in the account's security record,
 *     carries it;
 *   - a strict account's request reaches the wire with OpenRouter's no-storage
 *     routing, and a standard account's does not;
 *   - one account's turn is never answered from another account's results.
 *
 *   - with masking off (the default) the provider gets the message as written;
 *     with `maskPersonal` on (PRV-003) it gets placeholders, and the reply and
 *     the tool arguments come back with the real values — through the gateway
 *     itself, `streamCompletion`, the one door to every provider.
 *
 *   node test/egress.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import https from 'node:https';
import { removeTemp } from './lib/tmp.mjs';

/**
 * Everything that tries to leave the process while `fn` runs, refused and named.
 *
 * Not only `fetch` (HAR-006): `safeFetch` — web tools, icons, pictures — goes
 * through `node:http`/`https` after a `node:dns` lookup. Every TCP or TLS
 * connection, whichever library opens it, goes through `net.Socket#connect`, so
 * that is where the door is watched, along with `dns.lookup` — the lookup net,
 * http, https and safeFetch use. Not watched: `dns.resolve*` and UDP sockets,
 * which nothing on a turn's path calls.
 */
async function offline(fn) {
  const outbound = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;
  const realLookupP = dnsPromises.lookup;
  globalThis.fetch = async (input) => {
    outbound.push(`fetch ${String(input?.url || input)}`);
    throw new Error('network is off in this test');
  };
  net.Socket.prototype.connect = function connect(...args) {
    const to = args[0] && typeof args[0] === 'object' ? `${args[0].host || args[0].path || ''}:${args[0].port || ''}` : String(args[0]);
    outbound.push(`socket ${to}`);
    process.nextTick(() => this.destroy(new Error('network is off in this test')));
    return this;
  };
  dns.lookup = (host, ...rest) => {
    outbound.push(`dns ${host}`);
    const cb = rest.find((x) => typeof x === 'function');
    process.nextTick(() => cb?.(new Error('network is off in this test')));
  };
  dnsPromises.lookup = async (host) => {
    outbound.push(`dns ${host}`);
    throw new Error('network is off in this test');
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    dns.lookup = realLookup;
    dnsPromises.lookup = realLookupP;
  }
  return outbound;
}

process.env.ENCRYPTION_KEY ||= 'egress-test-encryption-key';
process.env.SESSION_SECRET ||= 'egress-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-egress-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { runAgent } = await import('../server/agent.js');
const { setPrefs } = await import('../server/settings.js');
const { streamCompletion } = await import('../server/providers/index.js');

const PII = {
  name: 'Nguyễn Văn Testa',
  phone: '0912 345 678',
  cccd: '001099012345',
  email: 'testa.pii@example.com',
};
const message = `Tôi là ${PII.name}, SĐT ${PII.phone}, CCCD ${PII.cccd}, email ${PII.email}. Viết giúp tôi một lời chào.`;
const leaks = (text) => Object.values(PII).filter((v) => String(text).includes(v));

const makeUser = (id) => store.createUser({ id, email: `${id}@example.com`, name: id, passwordHash: 'x', role: 'user' });

section('the watch on the network sees more than fetch (HAR-006)');
{
  const seen = await offline(async () => {
    await new Promise((resolve) => {
      const req = https.get('https://egress-probe.example/', () => resolve());
      req.on('error', () => resolve());
    });
    await dnsPromises.lookup('egress-probe-2.example').catch(() => {});
  });
  check('a request through node:https is caught, not only fetch', seen.some((s) => /^(dns|socket) egress-probe\.example/.test(s)), seen.join(', '));
  check('  and so is a name lookup on its own', seen.includes('dns egress-probe-2.example'), seen.join(', '));
}

section('a turn with personal data reaches the provider and nothing else');
{
  const user = await makeUser('u-egress');
  await store.createChat(user.id, { id: 'c-egress', title: 'egress', model: 'anthropic/claude-opus-5' });
  await store.appendMessage(user.id, 'c-egress', { id: 'm-egress-1', role: 'user', text: message });

  // Everything the process prints.
  const printed = [];
  const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(real)) console[level] = (...args) => printed.push(args.map(String).join(' '));

  const received = [];
  const stream = async function* provider(opts) {
    received.push(JSON.stringify(opts.messages));
    yield { type: 'text', delta: 'Xin chào!' };
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 50, output: 5 } };
  };
  // Every request, TCP/TLS connection or dns.lookup that tries to leave the process during the turn.
  let outbound = [];
  try {
    outbound = await offline(() => runAgent({ userId: user.id, user, chatId: 'c-egress', emit: () => {}, stream }));
  } finally {
    Object.assign(console, real);
  }

  check('with masking off — the default — the provider receives the message as written', received.length === 1 && leaks(received[0]).length === 4, leaks(received[0] || '').join(', '));
  check('no other request, TCP/TLS connection or dns.lookup leaves the process during the turn', outbound.length === 0, outbound.join(', '));
  check('nothing the process printed carries the personal data', printed.every((line) => !leaks(line).length), printed.find((line) => leaks(line).length)?.slice(0, 120));
  const record = JSON.stringify(await store.listAudit(user.id, 200));
  check('nothing in the security record carries it', !leaks(record).length);
}

section('with masking on, the provider never sees the personal data, and the person sees it all (PRV-003)');
{
  const masked = await makeUser('u-masked');
  await setPrefs(masked.id, { maskPersonal: true });
  const { setApiKey } = await import('../server/settings.js');
  await setApiKey(masked.id, 'anthropic', 'sk-ant-egress-suite-placeholder');
  const sent = [];
  // The provider answers with the placeholders it was given — one split across
  // two deltas — and asks to email the person by placeholder.
  const streamOne = async function* dispatch(_entry, common) {
    sent.push({ system: common.system, messages: JSON.stringify(common.messages) });
    yield { type: 'text', delta: 'Chào <PERSON_1>, số <PHO' };
    yield { type: 'text', delta: 'NE_1> và <EMAIL_1>.' };
    yield {
      type: 'done',
      stopReason: 'tool_use',
      toolCalls: [{ id: 't1', name: 'send_email', input: { to: '<EMAIL_1>', body: 'CCCD <ID_1> của <PERSON_1>' } }],
      usage: { input: 50, output: 9 },
    };
  };
  const printed = [];
  const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(real)) console[level] = (...args) => printed.push(args.map(String).join(' '));
  const events = [];
  try {
    for await (const ev of streamCompletion({
      userId: masked.id,
      entry: { provider: 'anthropic', model: 'claude-opus-5', context: 200_000, maxOutput: 8192 },
      system: `Ghi chú: email của người dùng là ${PII.email}`,
      messages: [{ id: 'x', role: 'user', text: message }],
      tools: [],
      streamOne,
    })) {
      events.push(ev);
    }
  } finally {
    Object.assign(console, real);
  }
  const outgoing = `${sent[0]?.system}\n${sent[0]?.messages}`;
  check('the provider receives none of the personal data', sent.length === 1 && leaks(outgoing).length === 0, leaks(outgoing).join(', '));
  check(
    '  only placeholders, the same one for the same value in the system prompt and the message',
    /<PERSON_1>/.test(sent[0]?.messages) && /<PHONE_1>/.test(sent[0]?.messages) && /<ID_1>/.test(sent[0]?.messages) && /email <EMAIL_1>/.test(sent[0]?.messages) && /^Ghi chú: email của người dùng là <EMAIL_1>/.test(sent[0]?.system || '') && !/<EMAIL_2>/.test(outgoing),
    outgoing.slice(0, 300),
  );
  check('  and is told what they are', /placeholders/.test(sent[0]?.system || ''));
  const shown = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  check('the reply reaches the person with the real values, even one split across deltas', shown === `Chào ${PII.name}, số ${PII.phone} và ${PII.email}.`, shown);
  const call = events.find((e) => e.type === 'done')?.toolCalls?.[0];
  check('  and a tool runs on the real values', call?.input?.to === PII.email && call?.input?.body === `CCCD ${PII.cccd} của ${PII.name}`, JSON.stringify(call?.input));
  check('  while nothing printed — the span line included — carries any of it', printed.every((line) => !leaks(line).length), printed.find((line) => leaks(line).length)?.slice(0, 120));

  // What it finds, and what it leaves.
  const { createShield } = await import('../server/deidentify.js');
  const shield = createShield();
  const probe = shield.maskText(
    'STK: 0123 456 789 01, CMND số 123456789, thẻ 4111 1111 1111 1111, +84 987 654 321, họ và tên: Trần Thị Bình. ' +
      'Năm 2026 giá 1.000.000 đồng, mã đơn 4111111111111112, điện thoại bàn 1900 1234.',
  );
  check('a labelled account, a labelled ID, a card, an international number and a labelled name are masked', /STK: <ACCOUNT_1>/.test(probe) && /CMND số <ID_1>/.test(probe) && /thẻ <CARD_1>/.test(probe) && /<PHONE_1>/.test(probe) && /họ và tên: <PERSON_1>/.test(probe), probe);
  check('  and a year, a price, a number that fails the card check and a hotline are not', /Năm 2026 giá 1\.000\.000 đồng, mã đơn 4111111111111112, điện thoại bàn 1900 1234/.test(probe), probe);
}

section('strict privacy reaches the wire, standard does not');
{
  process.env.OPENROUTER_API_KEY ||= 'sk-or-v1-egress-test-shared-key';
  const strict = await makeUser('u-egress-strict');
  const standard = await makeUser('u-egress-standard');
  await setPrefs(strict.id, { providerPrivacy: 'strict' });
  const sent = [];
  const streamOne = async function* dispatch(entry, common) {
    sent.push({ provider: entry.provider, privacy: common.privacy, key: common.apiKey });
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 1, output: 1 } };
  };
  const entry = { id: 'openrouter/test/model', provider: 'openrouter', model: 'test/model', context: 100_000, maxOutput: 1000 };
  const run = async (userId, e = entry) => {
    for await (const ev of streamCompletion({ userId, entry: e, system: 's', messages: [{ id: 'x', role: 'user', text: message }], tools: [], streamOne })) void ev;
  };
  await run(strict.id);
  await run(standard.id);
  check('a strict account is sent with OpenRouter\'s no-storage routing', sent[0]?.provider === 'openrouter' && sent[0]?.privacy === 'strict', JSON.stringify({ ...sent[0], key: undefined }));
  check('a standard account is not', sent[1]?.privacy === 'standard');

  // And on the wire itself: the body the real OpenRouter adapter sends, caught
  // at fetch and refused before it leaves.
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const body = init.body ?? (input instanceof Request ? await input.clone().text() : null);
    bodies.push(JSON.parse(String(body || '{}')));
    return new Response(JSON.stringify({ error: { message: 'network is off in this test' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const userId of [strict.id, standard.id]) {
      try {
        for await (const ev of streamCompletion({ userId, entry, system: 's', messages: [{ id: 'x', role: 'user', text: message }], tools: [] })) void ev;
      } catch {
        /* refused above, as intended */
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  const [strictBody, standardBody] = bodies;
  check('the strict request\'s body asks OpenRouter to keep nothing', strictBody?.provider?.data_collection === 'deny' && strictBody?.provider?.zdr === true, JSON.stringify(strictBody?.provider));
  check('  and the standard one carries no such routing', bodies.length === 2 && !standardBody?.provider?.zdr, JSON.stringify(standardBody?.provider));
}

section('one account is never answered from another account\'s results');
{
  const a = await makeUser('u-egress-a');
  const b = await makeUser('u-egress-b');
  // A skill of the same name on each account, so a cache keyed by the call alone would mix them.
  const write = (userId, text) =>
    store.saveSkill(userId, { id: `s-${userId}`, name: 'routine', description: 'd', instructions: text });
  await write(a.id, 'A-ONLY: reconcile the ledger on Fridays.');
  await write(b.id, 'B-ONLY: water the plants on Mondays.');
  const results = {};
  for (const user of [a, b]) {
    await store.createChat(user.id, { id: `c-${user.id}`, title: 't' });
    await store.appendMessage(user.id, `c-${user.id}`, { id: `m-${user.id}`, role: 'user', text: 'read my routine' });
    let step = 0;
    const stream = async function* provider(opts) {
      step += 1;
      const last = opts.messages.at(-1);
      if (last?.role === 'tool') results[user.id] = last.results.map((r) => r.content).join('\n');
      if (step === 1) {
        yield { type: 'done', stopReason: 'tool_use', toolCalls: [{ id: `t-${user.id}`, name: 'skill_read', input: { name: 'routine' } }], usage: { input: 5, output: 5 } };
      } else {
        yield { type: 'text', delta: 'ok' };
        yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 5, output: 5 } };
      }
    };
    await runAgent({ userId: user.id, user, chatId: `c-${user.id}`, emit: () => {}, stream });
  }
  check('each account read its own', /A-ONLY/.test(results[a.id] || '') && /B-ONLY/.test(results[b.id] || ''), `${String(results[a.id]).slice(0, 60)} / ${String(results[b.id]).slice(0, 60)}`);
  check('  and neither saw the other\'s', !/B-ONLY/.test(results[a.id] || '') && !/A-ONLY/.test(results[b.id] || ''));
}

removeTemp(process.env.DATA_DIR);
console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : '\n\x1b[32mAll egress checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
