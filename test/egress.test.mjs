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
  const tokenOf = (messages, kind) => new RegExp(`<${kind}_[0-9a-f]{8}>`).exec(messages)?.[0] || `<${kind}_missing>`;
  const streamOne = async function* dispatch(_entry, common) {
    const seen = JSON.stringify(common.messages);
    sent.push({ system: common.system, messages: seen });
    const [person, phone, email, id] = ['PERSON', 'PHONE', 'EMAIL', 'ID'].map((k) => tokenOf(seen, k));
    yield { type: 'text', delta: `Chào ${person}, số ${phone.slice(0, 5)}` };
    yield { type: 'text', delta: `${phone.slice(5)} và ${email}.` };
    yield {
      type: 'done',
      stopReason: 'tool_use',
      toolCalls: [{ id: 't1', name: 'send_email', input: { to: email, body: `CCCD ${id} của ${person}` } }],
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
  const emailToken = /<EMAIL_[0-9a-f]{8}>/.exec(sent[0]?.messages || '')?.[0];
  check(
    '  only placeholders, the same one for the same value in the system prompt and the message',
    /<PERSON_[0-9a-f]{8}>/.test(sent[0]?.messages) && /<PHONE_[0-9a-f]{8}>/.test(sent[0]?.messages) && /<ID_[0-9a-f]{8}>/.test(sent[0]?.messages) && !!emailToken && (sent[0]?.system || '').startsWith(`Ghi chú: email của người dùng là ${emailToken}`),
    outgoing.slice(0, 300),
  );
  check('  and none of them guessable by its order', !/<(EMAIL|PHONE|ID|PERSON)_\d>/.test(outgoing.replace(/placeholders such as[^.]*\./, '')), outgoing.slice(0, 200));
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
  const H = '[0-9a-f]{8}';
  check('a labelled account, a labelled ID, a card, an international number and a labelled name are masked', new RegExp(`STK: <ACCOUNT_${H}>`).test(probe) && new RegExp(`CMND số <ID_${H}>`).test(probe) && new RegExp(`thẻ <CARD_${H}>`).test(probe) && new RegExp(`<PHONE_${H}>`).test(probe) && new RegExp(`họ và tên: <PERSON_${H}>`).test(probe), probe);
  check('  and a year, a price, a number that fails the card check and a hotline are not', /Năm 2026 giá 1\.000\.000 đồng, mã đơn 4111111111111112, điện thoại bàn 1900 1234/.test(probe), probe);
  const notPersonal = shield.maskText('tỉ lệ 0.912345678, mã giờ 1791129697458, lô 4111111111111');
  check('  nor a decimal, a millisecond timestamp, or a 13-digit number that passes Luhn', notPersonal === 'tỉ lệ 0.912345678, mã giờ 1791129697458, lô 4111111111111', notPersonal);

  // The same value is the same placeholder in every call of a conversation,
  // whatever order things arrive in (a fold, a moved passage, a changed note).
  const keyA = 'egress-suite-key-a';
  const other = 'second.person@example.com';
  const first = createShield({ key: keyA }).maskText(`${PII.email} rồi ${other}`);
  const later = createShield({ key: keyA }).maskText(`${other} rồi ${PII.email}`);
  const tokens = (s) => s.match(/<[A-Z]+_[0-9a-f]{8}>/g) || [];
  check('a placeholder stays the same across calls, in any order', tokens(first).length === 2 && tokens(first)[0] === tokens(later)[1] && tokens(first)[1] === tokens(later)[0], `${first} / ${later}`);
  check('  and another account\'s key makes others', createShield({ key: 'egress-suite-key-b' }).maskText(PII.email) !== tokens(first)[0]);

  // Long runs of blank space and letters cost linear time, not the cube of their length.
  const started = Date.now();
  shield.maskText(`${' '.repeat(50_000)}1`);
  shield.maskText(`STK${' '.repeat(50_000)}9`);
  shield.maskText('a'.repeat(60_000));
  shield.maskText('\n'.repeat(20_000) + 'họ và tên:' + ' '.repeat(20_000));
  const took = Date.now() - started;
  check('masking long runs of spaces, letters and newlines takes well under a second', took < 500, `${took} ms`);

  // A CSV handed to a tool in its `data` field is words, masked like any; a picture's bytes are not touched.
  const wire = shield.protect({
    system: 's',
    messages: [
      { id: 'u', role: 'user', text: 'x', parts: [{ type: 'image', mime: 'image/png', data: 'iVBORw0KGgo0912345678' }] },
      { id: 'a', role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'analyze_data', input: { data: `name,email\nTesta,${PII.email}` } }] },
    ],
  });
  check('a CSV in a tool\'s `data` argument is masked', !JSON.stringify(wire.messages).includes(PII.email));
  check('  while a picture\'s bytes go untouched', wire.messages[0].parts[0].data === 'iVBORw0KGgo0912345678');

  // A provider's own record of a reply: only the last one is replayed, its words
  // masked and its signed thinking untouched; older ones are rebuilt from the
  // masked text and tool calls.
  const replay = shield.protect({
    system: 's',
    messages: [
      { id: 'a1', role: 'assistant', text: 'cũ', raw: { anthropic: [{ type: 'text', text: `gửi ${PII.email}` }] } },
      { id: 'u2', role: 'user', text: 'tiếp' },
      {
        id: 'a2',
        role: 'assistant',
        text: 'mới',
        toolCalls: [{ id: 't', name: 'send_email', input: { to: PII.email } }],
        raw: { anthropic: [{ type: 'thinking', thinking: 'nghĩ', signature: 'sig' }, { type: 'tool_use', id: 't', name: 'send_email', input: { to: PII.email } }] },
      },
      { id: 'r2', role: 'tool', results: [{ toolCallId: 't', content: 'sent' }] },
    ],
  });
  check('an earlier reply\'s raw record, which may hold real values, is not replayed', replay.messages[0].raw === undefined);
  check('  the last one, its tool calls being answered, is — words masked, signed thinking as it was', replay.messages[2].raw?.anthropic?.[0]?.signature === 'sig' && !JSON.stringify(replay.messages[2].raw).includes(PII.email), JSON.stringify(replay.messages[2].raw));
  const settled = shield.protect({ system: 's', messages: [{ id: 'a3', role: 'assistant', text: 'xong', raw: { anthropic: [{ type: 'text', text: 'xong' }] } }, { id: 'u3', role: 'user', text: 'cảm ơn' }] });
  check('  and a last reply no tool result is waiting on is rebuilt instead', settled.messages[0].raw === undefined);

  // A personal detail put back into a web address asks first — a page may have
  // talked the model into writing the placeholder there.
  const { needsApproval, PERSONAL_IN_ADDRESS_REASON } = await import('../server/agent.js');
  const fetchCall = { id: 'f', name: 'web_fetch', input: { url: `https://x.example/?e=${PII.email}` }, unmasked: ['url'] };
  const mailCall = { id: 'm', name: 'web_search', input: { query: PII.email }, unmasked: ['query'] };
  check('a personal detail restored into a web address asks first', needsApproval([fetchCall], 'guarded').length === 1 && /web address/.test(PERSONAL_IN_ADDRESS_REASON));
  check('  while one restored elsewhere follows the ordinary rule', needsApproval([mailCall], 'guarded').length === 0);
}

section('with masking on, a PDF goes as its text — masked — not as the file (PRV-003)');
{
  const pdfUser = await makeUser('u-masked-pdf');
  await setPrefs(pdfUser.id, { maskPersonal: true });
  const { setApiKey } = await import('../server/settings.js');
  await setApiKey(pdfUser.id, 'anthropic', 'sk-ant-egress-suite-placeholder');
  const line = `Ho va ten: Tran Thi Binh, email ${PII.email}, CCCD ${PII.cccd}`;
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', null, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = `BT /F1 12 Tf 20 120 Td (${line}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.from(pdf, 'latin1');
  await store.createAttachment(pdfUser.id, { id: 'egress-cv', name: 'cv.pdf', mime: 'application/pdf', kind: 'document', bytes: bytes.length, data: bytes.toString('base64') });
  await store.createChat(pdfUser.id, { id: 'c-masked-pdf', title: 'cv' });
  await store.appendMessage(pdfUser.id, 'c-masked-pdf', { id: 'm-cv', role: 'user', text: 'Đọc CV này', attachments: [{ id: 'egress-cv', name: 'cv.pdf', kind: 'document', mime: 'application/pdf' }] });
  const wire = [];
  const streamOne = async function* dispatch(_entry, common) {
    wire.push(JSON.stringify(common.messages));
    yield { type: 'text', delta: 'Đã đọc.' };
    yield { type: 'done', stopReason: 'end_turn', toolCalls: [], usage: { input: 10, output: 2 } };
  };
  await setPrefs(pdfUser.id, { defaultModel: 'anthropic/claude-opus-5' });
  await runAgent({ userId: pdfUser.id, user: pdfUser, chatId: 'c-masked-pdf', emit: () => {}, stream: (opts) => streamCompletion({ ...opts, streamOne }) });
  const sentPdf = wire[0] || '';
  check('a model that reads PDFs gets the text, not the file, while masking is on', !!sentPdf && !/"type":"document"/.test(sentPdf) && /Ho va ten/.test(sentPdf), sentPdf.slice(0, 160));
  check('  and none of the personal details in it', !sentPdf.includes(PII.email) && !sentPdf.includes(PII.cccd), sentPdf.slice(0, 200));
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
