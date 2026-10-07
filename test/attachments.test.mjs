/**
 * Photos and files sent with a message.
 *
 * The failure this suite exists to prevent is the quiet one: a file that
 * uploads, appears in the bubble, and is never actually looked at. So it checks
 * the whole path — what is accepted, where the bytes live, who may fetch them,
 * and what each provider adapter finally builds out of them.
 *
 *   node test/attachments.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'attach-test-encryption-key';
process.env.SESSION_SECRET ||= 'attach-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-attach-test-${process.pid}`);
// The tray "Show in folder" writes into. Left to itself this is the real one on
// whatever machine runs the suite, and the reveal section below used to write
// into it and then delete it — carrying off whatever the person had opened from
// a conversation and left there. Kept outside DATA_DIR, and deliberately not
// removed at the end: this test launches a real file manager at it, and pulling
// the folder out from under a window that is opening produces an OS error
// dialog on somebody's screen.
process.env.FILES_DIR = path.join(os.tmpdir(), `ai-remote-attach-tray-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const PORT = 5204;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 80) };
      }
      return { status: res.status, json, headers: res.headers, text };
    },
  };
}

const alice = jar();
const bob = jar();
const anon = jar();

await alice.call('POST', '/api/register', {
  email: 'alice@example.com',
  password: 'a-long-enough-password',
  name: 'Alice',
});
await bob.call('POST', '/api/register', {
  email: 'bob@example.com',
  password: 'bobs-long-enough-password',
  name: 'Bob',
});

// A one-pixel PNG, so the bytes are real rather than a string pretending.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// ── what is accepted ────────────────────────────────────────────────
section('classification');
{
  const { classify } = await import('../server/attachments.js');

  check('a png is an image', classify('shot.png', 'image/png') === 'image');
  check('a jpeg is an image', classify('photo.jpg', 'image/jpeg') === 'image');
  check('a pdf is a document', classify('bill.pdf', 'application/pdf') === 'document');
  check('markdown is text', classify('notes.md', 'text/markdown') === 'text');
  check('source is text', classify('app.js', 'text/javascript') === 'text');
  check('json is text', classify('data.json', 'application/json') === 'text');

  // Browsers routinely hand over octet-stream for anything unusual, so the
  // extension has to be allowed to answer.
  check('an unlabelled .ts falls back to its name', classify('main.ts', 'application/octet-stream') === 'text');
  check('an unlabelled .pdf does too', classify('bill.pdf', '') === 'document');

  // Refused by name rather than accepted and ignored, which is the failure that
  // wastes somebody's afternoon.
  check('an executable is refused', classify('setup.exe', 'application/octet-stream') === null);
  check('a zip is refused', classify('bundle.zip', 'application/zip') === null);
  check('a video is refused', classify('clip.mp4', 'video/mp4') === null);
}

section('uploading');
let imageId;
let textId;
{
  const shot = await alice.call('POST', '/api/attachments', {
    name: 'screenshot.png',
    mime: 'image/png',
    data: PNG,
  });
  check('an image uploads', shot.status === 201, JSON.stringify(shot.json).slice(0, 90));
  check('and is classified', shot.json?.attachment?.kind === 'image', shot.json?.attachment?.kind);
  check('with its real size', shot.json?.attachment?.bytes > 0, String(shot.json?.attachment?.bytes));
  check(
    'and the bytes are not echoed back',
    !('data' in (shot.json?.attachment || {})),
    Object.keys(shot.json?.attachment || {}).join(', '),
  );
  imageId = shot.json.attachment.id;

  const notes = await alice.call('POST', '/api/attachments', {
    name: 'notes.md',
    mime: 'text/markdown',
    data: b64('# Shipping\n\nContainer GCXU6471654.'),
  });
  check('a text file uploads', notes.status === 201);
  check('as text', notes.json?.attachment?.kind === 'text', notes.json?.attachment?.kind);
  textId = notes.json.attachment.id;

  const exe = await alice.call('POST', '/api/attachments', {
    name: 'setup.exe',
    mime: 'application/octet-stream',
    data: b64('MZ'),
  });
  check('an unreadable kind is refused', exe.status === 400, `got ${exe.status}`);
  check('with a reason naming the file', /setup\.exe/.test(exe.json?.error || ''), exe.json?.error);

  const huge = await alice.call('POST', '/api/attachments', {
    name: 'big.png',
    mime: 'image/png',
    data: 'A'.repeat(8 * 1024 * 1024),
  });
  check('an oversized file is refused', huge.status === 400, `got ${huge.status}`);
  check('and says the limit', /limit is/.test(huge.json?.error || ''), huge.json?.error);

  const empty = await alice.call('POST', '/api/attachments', { name: 'nothing.txt', mime: 'text/plain', data: '' });
  check('an empty file is refused', empty.status === 400, `got ${empty.status}`);

  check('uploading needs a session', (await anon.call('POST', '/api/attachments', { name: 'x.png', mime: 'image/png', data: PNG })).status === 401);
}

// ── an artifact's own storage, and the picture proxies (CODE-041) ────
section('an artifact\'s storage is its owner\'s, and bounded');
{
  const base = `/api/attachments/${imageId}/storage`;
  const put = await alice.call('PUT', base, { key: 'score', value: { best: 42, names: ['An', 'Bình'] } });
  check('the owner can save a value', put.status === 200 && put.json?.keys === 1, JSON.stringify(put.json));
  const one = await alice.call('GET', `${base}?key=score`);
  check('  and read it back with its shape', one.status === 200 && one.json?.value?.best === 42 && one.json?.value?.names?.[1] === 'Bình', JSON.stringify(one.json));
  const all = await alice.call('GET', base);
  check('  and list the bucket', all.status === 200 && all.json?.values?.score?.best === 42);
  for (const [method, body] of [['GET', undefined], ['PUT', { key: 'x', value: 1 }], ['DELETE', undefined]]) {
    const theirs = await bob.call(method, base, body);
    check(`another account gets 404 on ${method}`, theirs.status === 404, `got ${theirs.status}`);
  }
  check('nobody signed out reaches it', (await anon.call('GET', base)).status === 401);
  const big = await alice.call('PUT', base, { key: 'big', value: 'x'.repeat(70 * 1024) });
  check('one value over 64 KB is refused, saying the limit', big.status === 400 && /limit/.test(big.json?.error || ''), big.json?.error);
  check('an empty key is refused', (await alice.call('PUT', base, { key: '', value: 1 })).status === 400);
  for (let i = 1; i < 100; i += 1) await alice.call('PUT', base, { key: `k${i}`, value: i });
  const over = await alice.call('PUT', base, { key: 'one-too-many', value: 1 });
  check('the hundred-and-first key is refused', over.status === 400 && /100 stored keys/.test(over.json?.error || ''), over.json?.error);
  check('  while an existing key can still change', (await alice.call('PUT', base, { key: 'k5', value: 'five' })).status === 200);
  const dropOne = await alice.call('DELETE', `${base}?key=score`);
  check('a key can be removed', dropOne.status === 200 && dropOne.json?.keys === 99, JSON.stringify(dropOne.json));
  const dropAll = await alice.call('DELETE', base);
  check('  and the whole bucket cleared', dropAll.status === 200 && dropAll.json?.keys === 0 && Object.keys((await alice.call('GET', base)).json?.values || {}).length === 0);
}

section('the picture proxies refuse what they must not fetch, before fetching');
{
  const unsigned = await alice.call('GET', `/api/image?u=${encodeURIComponent('https://evil.example/?d=notes')}`);
  check('an address off the list and unsigned is not fetched', unsigned.status === 404);
  const forged = await alice.call('GET', `/api/image?u=${encodeURIComponent('https://evil.example/a.png')}&s=AAAAAAAAAAAAAAAAAAAAAA`);
  check('  nor with a made-up signature', forged.status === 404);
  check('a map tile outside the world is refused', (await alice.call('GET', '/api/map/3/9/0')).status === 404);
  check('  and so is a zoom past the last level', (await alice.call('GET', '/api/map/25/0/0')).status === 404);
  check('an icon for an IP address is refused', (await alice.call('GET', '/api/favicon/169.254.169.254')).status === 400);
  check('the proxies need a session', (await anon.call('GET', '/api/map/1/0/0')).status === 401);
  const drive = await alice.call('POST', `/api/attachments/${imageId}/drive`);
  check('saving to Drive without Drive connected says so', drive.status === 400 && /Drive/.test(drive.json?.error || ''), drive.json?.error);
  check('  and another account cannot even ask', (await bob.call('POST', `/api/attachments/${imageId}/drive`)).status === 404);
}

// ── whose file is it ────────────────────────────────────────────────
section('an attachment belongs to one account');
{
  const mine = await alice.call('GET', `/api/attachments/${imageId}`);
  check('the owner can fetch it', mine.status === 200, `got ${mine.status}`);
  check('with its real content type', mine.headers.get('content-type')?.includes('image/png'), mine.headers.get('content-type'));
  check('and cached hard, since it never changes', /immutable/.test(mine.headers.get('cache-control') || ''), mine.headers.get('cache-control'));

  const theirs = await bob.call('GET', `/api/attachments/${imageId}`);
  check("another account cannot", theirs.status === 404, `got ${theirs.status}`);
  check('anonymously either', (await anon.call('GET', `/api/attachments/${imageId}`)).status === 401);

  // The id comes from the browser, so attaching one is a claim to be checked.
  const chat = (await bob.call('POST', '/api/chats', {})).json.chat;
  const stolen = await bob.call('POST', `/api/chats/${chat.id}/messages`, {
    text: 'look at this',
    attachments: [imageId],
  });
  check("nor attach it to their own message", stolen.status === 400, `got ${stolen.status}`);
}

// ── the small picture a message draws ───────────────────────────────
section('a sent file keeps a small picture, for its tile');
{
  const withThumb = await alice.call('POST', '/api/attachments', {
    name: 'photo.png',
    mime: 'image/png',
    data: PNG,
    thumb: `data:image/png;base64,${PNG}`,
  });
  const id = withThumb.json?.attachment?.id;
  const thumb = await alice.call('GET', `/api/attachments/${id}/thumb`);
  check('the picture the browser drew is served back', thumb.status === 200 && /image\/png/.test(thumb.headers.get('content-type') || ''), `${thumb.status} ${thumb.headers.get('content-type')}`);
  check('  as the image bytes, not the data URL', thumb.text.startsWith('�PNG') || thumb.text.includes('PNG'), thumb.text.slice(0, 8));
  check('  cached hard, since it never changes', /immutable/.test(thumb.headers.get('cache-control') || ''));
  check("  and never to another account", (await bob.call('GET', `/api/attachments/${id}/thumb`)).status === 404);

  // It comes from the client, so anything that is not a small picture is dropped.
  const script = await alice.call('POST', '/api/attachments', {
    name: 'a.png',
    mime: 'image/png',
    data: PNG,
    thumb: 'data:text/html;base64,PHNjcmlwdD4=',
  });
  check('a thumbnail that is not a picture is not kept', (await alice.call('GET', `/api/attachments/${script.json.attachment.id}/thumb`)).status === 404);
  check('a file sent without one answers 404, and the tile falls back', (await alice.call('GET', `/api/attachments/${imageId}/thumb`)).status === 404);
  check('  and the upload response carries no picture either', !('thumb' in (withThumb.json?.attachment || {})), Object.keys(withThumb.json?.attachment || {}).join(','));
}

// ── sending ─────────────────────────────────────────────────────────
section('sending a message with files');
let chatId;
{
  chatId = (await alice.call('POST', '/api/chats', {})).json.chat.id;

  const sent = await alice.call('POST', `/api/chats/${chatId}/messages`, {
    text: 'what container number is this?',
    attachments: [imageId, textId],
  });
  check('the message is accepted', sent.status === 201, JSON.stringify(sent.json).slice(0, 90));
  check('and carries both files', sent.json?.message?.attachments?.length === 2, `${sent.json?.message?.attachments?.length}`);
  check(
    'as metadata, not megabytes',
    !JSON.stringify(sent.json).includes(PNG.slice(0, 40)),
    'the browser already has the file it just picked',
  );

  const loaded = await alice.call('GET', `/api/chats/${chatId}`);
  const message = loaded.json.messages[0];
  check('reloading the chat brings them back', message.attachments?.length === 2, `${message.attachments?.length}`);
  check('with names', message.attachments?.[0]?.name === 'screenshot.png', message.attachments?.[0]?.name);
  check(
    'and still no bytes in the transcript',
    !JSON.stringify(loaded.json).includes(PNG.slice(0, 40)),
    'a conversation is re-read constantly; base64 has no business in it',
  );

  // A photo on its own is a complete thought — "what is this?" is implied.
  const captionless = await alice.call('POST', `/api/chats/${chatId}/messages`, {
    text: '',
    attachments: [imageId],
  });
  check('a file with no words is allowed', captionless.status === 201, `got ${captionless.status}`);

  const nothing = await alice.call('POST', `/api/chats/${chatId}/messages`, { text: '  ' });
  check('but an empty message still is not', nothing.status === 400, `got ${nothing.status}`);

  const invented = await alice.call('POST', `/api/chats/${chatId}/messages`, {
    text: 'x',
    attachments: ['not-a-real-id'],
  });
  check('an invented id is refused', invented.status === 400, `got ${invented.status}`);

  const toomany = await alice.call('POST', `/api/chats/${chatId}/messages`, {
    text: 'x',
    attachments: Array.from({ length: 9 }, (_, i) => `id-${i}`),
  });
  check('and too many at once', toomany.status === 400, `got ${toomany.status}`);
  check('with the limit named', /limit/.test(toomany.json?.error || ''), toomany.json?.error);
}

// ── what actually reaches the model ─────────────────────────────────
section('what each provider is handed');
{
  const { loadForTranscript, toParts } = await import('../server/attachments.js');
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;

  const messages = await store.listMessages(aliceId, chatId);
  const loaded = await loadForTranscript(aliceId, messages);
  check('the bytes are fetched for the transcript', loaded.size >= 2, `${loaded.size} loaded`);

  const first = messages[0];
  const parts = toParts(first, loaded);
  check('an image becomes an image part', parts.some((p) => p.type === 'image'), JSON.stringify(parts.map((p) => p.type)));
  check(
    'a text file is inlined as text, so it works on every model',
    parts.some((p) => p.type === 'text' && /GCXU6471654/.test(p.text)),
    JSON.stringify(parts.map((p) => p.type)),
  );

  // Read once per turn: a cache handed in is filled once and then answers
  // every later step without the database.
  const turn = new Map();
  await loadForTranscript(aliceId, messages, { cache: turn });
  const fetched = turn.size;
  const realGet = store.getAttachments;
  let asked = 0;
  store.getAttachments = async (...args) => {
    asked += 1;
    return realGet.apply(store, args);
  };
  const again = await loadForTranscript(aliceId, messages, { cache: turn });
  store.getAttachments = realGet;
  check('a second step reads nothing from the database', asked === 0 && again.size === fetched && fetched > 0, `${asked} reads, ${again.size}/${fetched}`);

  // The same file twice is one file: in full once, named the second time.
  const twice = [first, { ...first, id: 'again' }];
  const seen = new Set();
  const once = toParts(twice[0], loaded, { seen });
  const second = toParts(twice[1], loaded, { seen });
  check('a file sent twice goes in full once', once.some((p) => p.type === 'image') && !second.some((p) => p.type === 'image'), JSON.stringify(second.map((p) => p.type)));
  check('  and is named the second time', second.every((p) => p.type === 'text' && /same file/.test(p.text)), JSON.stringify(second));

  // An Office document is bounded like a PDF's text, and says so when cut.
  const huge = 'x'.repeat(300_000);
  const office = toParts(
    { attachments: [{ id: 'o1', name: 'big.xlsx', kind: 'office' }] },
    new Map([['o1', { id: 'o1', name: 'big.xlsx', kind: 'office', text: { text: huge, format: 'xlsx' } }]]),
  )[0];
  check('a huge workbook is cut to the same bound as a PDF', office.text.length < 125_000, String(office.text.length));
  check('  and the model is told it was cut', /only the first 120,000 of 300,000 characters/.test(office.text), office.text.slice(0, 200));

  // The guard that folds a conversation now sees documents, not only pictures.
  const { measure } = await import('../server/compact.js');
  const withPdf = measure([{ role: 'user', text: 'read this', attachments: [{ kind: 'document', bytes: 400_000 }] }], { context: 200_000 });
  check('a PDF counts toward how full the window is', withPdf.used >= 20_000, JSON.stringify(withPdf).slice(0, 120));

  const withParts = [{ ...first, parts }];

  // Anthropic: images and PDFs both go native.
  const { __testing: anthropic } = await import('../server/providers/anthropic.js');
  const claude = anthropic.toMessages(withParts);
  check(
    'Claude gets a base64 image block',
    claude[0].content.some((b) => b.type === 'image' && b.source?.data),
    JSON.stringify(claude[0].content.map((b) => b.type)),
  );
  check(
    'and the question after the files',
    claude[0].content[claude[0].content.length - 1].type === 'text',
    JSON.stringify(claude[0].content.map((b) => b.type)),
  );

  // OpenAI wire format: images as data URIs.
  const { __testing: openai } = await import('../server/providers/openaiCompatible.js');
  const gpt = openai.toMessages(withParts, null);
  check(
    'the OpenAI shape gets an image_url part',
    gpt[0].content.some((p) => p.type === 'image_url' && /^data:image\/png;base64,/.test(p.image_url.url)),
    JSON.stringify(gpt[0].content.map((p) => p.type)),
  );

  // Gemini: inlineData for both.
  const { __testing: google } = await import('../server/providers/google.js');
  const gemini = google.toContents(withParts);
  check(
    'Gemini gets inlineData',
    gemini[0].parts.some((p) => p.inlineData?.mimeType === 'image/png'),
    JSON.stringify(gemini[0].parts.map((p) => Object.keys(p)[0])),
  );

  // A message with no files must come out exactly as it always did — the plain
  // string form, which many models reject the array version of.
  const plain = openai.toMessages([{ role: 'user', text: 'hello' }], null);
  check('a plain message stays a plain string', typeof plain[0].content === 'string', typeof plain[0].content);

  /**
   * Gemini's thought signature, handed back with the call it belongs to.
   *
   * From Gemini 3 on, a function call comes with an opaque token standing for
   * the reasoning behind it, and the next turn has to return it. Dropping it
   * does not fail the request — it degrades tool use and says so on every turn:
   * *"Function call is missing a thought_signature in functionCall parts."*
   */
  const replayed = google.toContents([
    {
      role: 'assistant',
      text: 'looking it up',
      toolCalls: [
        { id: 'a', name: 'web_search', input: { query: 'gold' }, signature: 'SIG-ABC' },
        { id: 'b', name: 'browser_open', input: { url: 'x' } },
      ],
    },
  ]);
  const calls = replayed[0].parts.filter((p) => p.functionCall);
  check('a call with a signature carries it back', calls[0].thoughtSignature === 'SIG-ABC', JSON.stringify(calls[0]));
  check('and one without does not invent one', !('thoughtSignature' in calls[1]), JSON.stringify(calls[1]));
}

/**
 * A valid one-page PDF, built by hand.
 *
 * A real fixture would be a binary blob in the repository that nobody can read
 * a diff of; this is a few lines of the format itself, and it exercises the
 * same parser. Vietnamese in a subset font — the case that started this — was
 * checked against a Chromium-printed document, which needs a browser and so
 * does not belong in the suite that has to stay fast.
 */
function tinyPdf(line = 'Hello from a test PDF') {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // the content stream, built below
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 14 Tf 20 120 Td (${line.replace(/([()\\])/g, '\\$1')}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

section('reading a PDF for a model that cannot be handed one');
{
  const { extractPdfText } = await import('../server/pdf.js');

  const read = await extractPdfText(tinyPdf('Câu 1: what is in this document'));
  check('the words come out', /what is in this document/.test(read?.text || ''), read?.text);
  check('with the page it came from', /page 1/.test(read?.text || ''));
  check('and how many pages there were', read?.pages === 1, `${read?.pages}`);

  // A scan is pictures of pages. There is nothing to extract, and saying so is
  // the answer — not trying harder.
  check('a document with no text reads as nothing at all', (await extractPdfText(tinyPdf(''))) === null);

  let failed = null;
  await extractPdfText(Buffer.from('not a pdf').toString('base64')).catch((err) => (failed = err));
  check('and a corrupt file fails as itself', failed?.code === 'pdf_unreadable', failed?.message);

  // PERF-022: the read runs on a worker with a deadline, so a file that takes
  // too long is stopped instead of holding the server's thread. A deadline of
  // one millisecond stands in for a hostile file here.
  let late = null;
  await extractPdfText(tinyPdf('slow enough'), { timeoutMs: 1 }).catch((err) => (late = err));
  check('a PDF that takes longer than its deadline is stopped', late?.code === 'pdf_unreadable' && /took longer/.test(late?.message || ''), late?.message);
  const again = await extractPdfText(tinyPdf('and the next one still reads'));
  check('  and the next PDF reads as usual', /next one still reads/.test(again?.text || ''), again?.text);
  const { readPdfText } = await import('../server/pdf.js');
  check('the same read is there on this thread, where no worker can start', /in thread/.test((await readPdfText(tinyPdf('in thread')))?.text || ''));
  // A deployment that left the worker's file behind is not the PDF's fault: it
  // reads on this thread as before, rather than failing every PDF.
  let fallback = null;
  const missing = new URL('../server/no-such-pdf.worker.mjs', import.meta.url);
  const fromThread = await extractPdfText(tinyPdf('read without its worker'), { workerUrl: missing }).catch((err) => (fallback = err));
  check('a worker whose code is missing reads on this thread instead', /read without its worker/.test(fromThread?.text || ''), fallback?.message || fromThread?.text);
}

section('a PDF on a model that cannot read one');
{
  const { toParts } = await import('../server/attachments.js');
  const { __testing: openai } = await import('../server/providers/openaiCompatible.js');

  const message = { attachments: [{ id: 'a1' }] };
  const loaded = new Map([
    ['a1', {
      id: 'a1',
      name: 'de-thi.pdf',
      mime: 'application/pdf',
      kind: 'document',
      data: tinyPdf(),
      text: { text: '--- page 1 ---\nQuestion one', pages: 3, truncated: false },
    }],
  ]);

  // This is the fix: the document is read as text rather than refused. An
  // assistant that answers "I cannot read PDFs, paste it in" is a dead end for
  // the person who just attached one.
  const parts = toParts(message, loaded, { documents: false });
  const inlined = JSON.stringify(parts);
  check('the text of the document is sent', /Question one/.test(inlined), inlined.slice(0, 120));
  check('named, so the model can refer to it', /de-thi\.pdf/.test(inlined));
  check('and honest about what was lost', /layout and any images are not included/.test(inlined));
  check('with no PDF part left for a wire format that has none', !parts.some((p) => p.type === 'document'));

  const gpt = openai.toMessages([{ role: 'user', text: 'summarise this', parts }], null);
  check('which reaches the model as ordinary text', /Question one/.test(JSON.stringify(gpt[0].content)));

  // A scan has no text to send, and that is a different sentence.
  const scanned = toParts(message, new Map([['a1', { ...loaded.get('a1'), text: null }]]), { documents: false });
  check('a scan says so instead', /no text in it to read/.test(JSON.stringify(scanned)), JSON.stringify(scanned).slice(0, 100));

  // Anthropic and Google still get the file itself: they read the layout and
  // the pictures, which extracted text cannot carry.
  const withPdf = [
    { role: 'user', text: 'summarise this', parts: toParts(message, loaded, { documents: true }) },
  ];
  check('but a provider that takes files still gets one', withPdf[0].parts.some((p) => p.type === 'document'));

  const { __testing: google } = await import('../server/providers/google.js');
  const gemini = google.toContents(withPdf);
  check(
    'while Gemini gets the PDF itself',
    gemini[0].parts.some((p) => p.inlineData?.mimeType === 'application/pdf'),
  );

  const { __testing: anthropic } = await import('../server/providers/anthropic.js');
  const claude = anthropic.toMessages(withPdf);
  check(
    'and Claude gets a document block',
    claude[0].content.some((b) => b.type === 'document' && b.source?.media_type === 'application/pdf'),
  );
}

// ── the bug this whole section exists for ───────────────────────────
//
// About half the catalogue cannot be shown a picture. Sending one anyway does
// not produce a worse answer: the provider rejects the entire request. On
// OpenRouter that comes back as a bare 404, which reached the user as "not
// found" with nothing at all to connect it to the screenshot they had pasted.
section('a model that cannot see images');
{
  const { toParts } = await import('../server/attachments.js');
  const loaded = new Map([
    ['img', { name: 'shot.png', mime: 'image/png', kind: 'image', data: PNG }],
    ['doc', { name: 'notes.md', mime: 'text/markdown', kind: 'text', data: b64('# hello') }],
  ]);
  const message = {
    attachments: [
      { id: 'img', name: 'shot.png', kind: 'image' },
      { id: 'doc', name: 'notes.md', kind: 'text' },
    ],
  };

  const seeing = toParts(message, loaded, { vision: true });
  check('a model that can see gets the image', seeing.some((p) => p.type === 'image'));

  const blind = toParts(message, loaded, { vision: false });
  check('one that cannot gets no image part', !blind.some((p) => p.type === 'image'));
  check(
    'it is told an image was attached',
    blind.some((p) => p.type === 'text' && /shot\.png/.test(p.text)),
    JSON.stringify(blind.map((p) => p.type)),
  );
  check(
    'and that it cannot read images',
    blind.some((p) => /cannot read images/.test(p.text || '')),
  );
  check(
    'and what to do about it',
    blind.some((p) => /sees images/.test(p.text || '')),
    'the picker marks the ones that can',
  );
  check(
    'text files still go through — they work on any model',
    blind.some((p) => p.type === 'text' && /hello/.test(p.text)),
  );
  check('vision defaults to allowed, so a stale caller cannot silently blind a model', toParts(message, loaded).some((p) => p.type === 'image'));
}

section('the catalogue records what can see');
{
  const { resolveModel } = await import('../server/providers/catalog.js');

  // Every first-party model reads images and has for years.
  check('a built-in Claude sees images', resolveModel('anthropic/claude-opus-5').vision === true);
  check('so does GPT', resolveModel('openai/gpt-5').vision === true);
  check('and Gemini', resolveModel('google/gemini-2.5-pro').vision === true);

  // From the library, it is whatever OpenRouter published.
  const blind = resolveModel('openrouter/x/y', {
    id: 'openrouter/x/y',
    provider: 'openrouter',
    model: 'x/y',
    label: 'Text only',
    vision: false,
  });
  check('a text-only library model does not', blind.vision === false);

  const seeing = resolveModel('openrouter/x/z', {
    id: 'openrouter/x/z',
    provider: 'openrouter',
    model: 'x/z',
    label: 'Vision',
    vision: true,
  });
  check('and one that does, does', seeing.vision === true);

  // Unknown is assumed capable: refusing to send an image to a model that can
  // take one is the worse mistake, and the other direction now explains itself.
  check('a hand-typed id is assumed capable', resolveModel('openai/some-new-thing').vision === true);
}

section('the interface can ask before somebody attaches anything');
{
  await store.upsertModels([
    {
      id: 'openrouter/test/blind-model',
      provider: 'openrouter',
      model: 'test/blind-model',
      family: 'test',
      label: 'Blind Model',
      context: 1000,
      priceIn: 0,
      priceOut: 0,
      isFree: true,
      vision: false,
      releasedAt: new Date().toISOString(),
    },
  ]);

  const asked = await alice.call('GET', '/api/models/resolve?id=openrouter/test/blind-model');
  check('the capability is answerable by id', asked.status === 200, JSON.stringify(asked.json));
  check('and says it cannot see', asked.json?.model?.vision === false, String(asked.json?.model?.vision));

  const builtin = await alice.call('GET', '/api/models/resolve?id=anthropic/claude-opus-5');
  check('a built-in says it can', builtin.json?.model?.vision === true);

  const nonsense = await alice.call('GET', '/api/models/resolve?id=nope/nope/nope');
  check('an unknown id is a 404, not a crash', nonsense.status === 404, `got ${nonsense.status}`);
  check('and it needs a session', (await anon.call('GET', '/api/models/resolve?id=x')).status === 401);
}

section('a transparent picture reaches the model on a ground it can see');
{
  const { loadForTranscript, toParts } = await import('../server/attachments.js');
  const { mayBeTransparent } = await import('../server/imageGround.js');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  const drawing = (stroke, opaque = false) => {
    const c = createCanvas(80, 60);
    const ctx = c.getContext('2d');
    if (opaque) {
      ctx.fillStyle = '#336699';
      ctx.fillRect(0, 0, 80, 60);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 6;
    ctx.strokeRect(20, 15, 40, 30);
    return c.toBuffer('image/png');
  };
  const add = async (id, bytes) => {
    await store.createAttachment(aliceId, { id, name: `${id}.png`, mime: 'image/png', kind: 'image', bytes: bytes.length, data: bytes.toString('base64') });
    return { id, name: `${id}.png`, kind: 'image', mime: 'image/png' };
  };
  const dark = await add('ground-dark-lines', drawing('#111111'));
  const light = await add('ground-light-lines', drawing('#ffffff'));
  const solidBytes = drawing('#ffffff', true);
  const solid = await add('ground-opaque', solidBytes);
  const message = { attachments: [dark, light, solid] };
  const loaded = await loadForTranscript(aliceId, [message]);
  const parts = toParts(message, loaded);
  const corner = async (part) => {
    const picture = await loadImage(Buffer.from(part.data, 'base64'));
    const c = createCanvas(picture.width, picture.height);
    c.getContext('2d').drawImage(picture, 0, 0);
    return [...c.getContext('2d').getImageData(2, 2, 1, 1).data].join(',');
  };
  const darkCorner = await corner(parts[0]);
  const lightCorner = await corner(parts[1]);
  check('dark lines on nothing reach the model on white', darkCorner === '255,255,255,255', darkCorner);
  check('  white lines on nothing on a dark ground, which white would erase', lightCorner === '31,35,40,255', lightCorner);
  check('  and a picture with nothing see-through goes exactly as it was', parts[2].data === solidBytes.toString('base64'));
  // A header claiming a picture too large to decode safely is sent untouched —
  // and is never decoded at all, which is the point (counted, not inferred).
  const huge = Buffer.from(drawing('#111111'));
  huge.writeUInt32BE(60_000, 16);
  huge.writeUInt32BE(60_000, 20);
  const { groundedImage, __testing: groundTest } = await import('../server/imageGround.js');
  const decodedBefore = groundTest.decodes();
  const untouched = await groundedImage({ mime: 'image/png', data: huge.toString('base64') });
  check('  a picture whose header claims billions of pixels is never decoded', !!mayBeTransparent(huge) && groundTest.decodes() === decodedBefore, `${groundTest.decodes() - decodedBefore} decodes`);
  check('    and goes as it was', untouched.data === huge.toString('base64'));
  // A large transparent one goes at most 2000 pixels on its long edge.
  const big = createCanvas(3200, 1600);
  big.getContext('2d').fillRect(100, 100, 50, 50);
  const shrunk = await groundedImage({ mime: 'image/png', data: big.toBuffer('image/png').toString('base64') });
  const shrunkSize = await loadImage(Buffer.from(shrunk.data, 'base64'));
  check('  a large transparent picture is flattened at no more than 2000 pixels across', shrunkSize.width === 2000 && shrunkSize.height === 1000, `${shrunkSize.width}×${shrunkSize.height}`);
}

section('a step screenshot is kept for the assistant, not shelved as a file');
{
  const { keepStepShot } = await import('../server/attachments.js');
  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  const kept = await keepStepShot(aliceId, { data: Buffer.from('a small step picture').toString('base64'), mime: 'image/jpeg' });
  const row = kept ? await store.getAttachment(aliceId, kept.id) : null;
  check('a step screenshot is stored as a step', row?.origin === 'step' && row?.kind === 'image', row?.origin);
  const shelf = await alice.call('GET', '/api/files');
  check('  and the Files shelf does not list it', shelf.status === 200 && !(shelf.json?.files || []).some((f) => f.id === kept?.id), `${shelf.status}`);
  const shown = await alice.call('GET', `/api/attachments/${kept?.id}`);
  check('  while the conversation can still show it', shown.status === 200, `${shown.status}`);

  // It belongs to its conversation, and goes when that does.
  await store.createChat(aliceId, { id: 'c-steps', title: 'browsing' });
  const ofChat = await keepStepShot(aliceId, { data: Buffer.from('another step').toString('base64'), mime: 'image/jpeg' }, { chatId: 'c-steps' });
  check('a step screenshot is kept with its conversation', (await store.getAttachment(aliceId, ofChat?.id))?.chat_id === 'c-steps');
  await store.deleteChat(aliceId, 'c-steps');
  check('  and deleting the conversation deletes it', !(await store.getAttachment(aliceId, ofChat.id)));
  // One with no conversation is left by the daily sweep until it is a month old (see schema.test).
  const old = await keepStepShot(aliceId, { data: Buffer.from('an old step').toString('base64'), mime: 'image/jpeg' });
  await store.pruneOrphanAttachments();
  check('  an orphan from today survives the daily sweep', !!(await store.getAttachment(aliceId, old.id)));
}

/* ── versions, and the two Open buttons ────────────────────────── */

section('a file the assistant rewrites keeps what it was');
{
  const { createDocument } = await import('../server/office/index.js');
  const first = createDocument({ format: 'md', name: 'bao-gia.md', content: '# Báo giá\n\nTổng: 1.000.000 đ' });

  const aliceId = (await store.getUserByEmail('alice@example.com')).id;
  const made = await store.createAttachment(aliceId, {
    id: 'ver-test-1',
    name: first.name,
    mime: first.mime,
    kind: 'text',
    bytes: first.buffer.length,
    data: first.buffer.toString('base64'),
    origin: 'generated',
    source: '# Báo giá\n\nTổng: 1.000.000 đ',
  });

  const only = await alice.call('GET', `/api/attachments/${made.id}/versions`);
  check('a file nobody has rewritten has one version', only.json?.versions?.length === 1, `${only.json?.versions?.length}`);
  check('and it is the live one', only.json?.versions?.[0]?.live === true);

  // Two rewrites, which is what a switcher needs to be worth drawing.
  await alice.call('PATCH', `/api/attachments/${made.id}`, { content: '# Báo giá\n\nTổng: 2.000.000 đ' });
  await alice.call('PATCH', `/api/attachments/${made.id}`, { content: '# Báo giá\n\nTổng: 3.000.000 đ' });

  const history = await alice.call('GET', `/api/attachments/${made.id}/versions`);
  check('two rewrites leave three versions', history.json?.versions?.length === 3, `${history.json?.versions?.length}`);
  check('numbered so the live one is the highest', history.json?.current === 3, `${history.json?.current}`);
  check('and only one is marked live', history.json.versions.filter((v) => v.live).length === 1);

  const original = await alice.call('GET', `/api/attachments/${made.id}/versions/1`);
  check('the first draft is still readable', /1\.000\.000/.test(original.json?.file?.source || ''), original.json?.file?.source);
  check('and knows which revision it is', original.json?.file?.revision === 1);

  const live = await alice.call('GET', `/api/attachments/${made.id}/preview`);
  check('while the file itself is the newest', /3\.000\.000/.test(live.json?.file?.source || ''), live.json?.file?.source);

  // Going back must not be destructive: restoring is itself a rewrite, so the
  // copy it replaces is filed too.
  const restored = await alice.call('POST', `/api/attachments/${made.id}/versions/1/restore`);
  check('an old draft can be put back', restored.status === 200, `${restored.status}`);
  const after = await alice.call('GET', `/api/attachments/${made.id}/preview`);
  check('and becomes the file', /1\.000\.000/.test(after.json?.file?.source || ''), after.json?.file?.source);
  const kept = await alice.call('GET', `/api/attachments/${made.id}/versions`);
  check('with the one it replaced kept', kept.json?.versions?.length === 4, `${kept.json?.versions?.length}`);

  const notMine = await bob.call('GET', `/api/attachments/${made.id}/versions`);
  check('another account sees none of it', notMine.status === 404, `${notMine.status}`);

  const nonsense = await alice.call('GET', `/api/attachments/${made.id}/versions/99`);
  check('and a version that never existed is refused', nonsense.status === 404, `${nonsense.status}`);
}

section('opening a file on the machine');
{
  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');
  const reveal = LOCAL_IMPLEMENTATIONS.fs_reveal;
  const describe = LOCAL_IMPLEMENTATIONS.fs_describe;

  /**
   * The rule worth a test: a model can be talked into writing a program, and
   * "Open" is one click with nothing behind it. Handing that to the shell is
   * the one thing this must never do.
   */
  for (const name of ['setup.exe', 'run.bat', 'go.ps1', 'thing.sh', 'x.vbs', 'evil.lnk', 'tool.js']) {
    let refused = false;
    try {
      await reveal({ name, data: Buffer.from('x').toString('base64'), how: 'open' });
    } catch (err) {
      refused = /programs|runs them/.test(err.message);
    }
    check(`${name} is never handed to the operating system`, refused);
  }

  const doc = JSON.parse(await describe({ name: 'bao-cao.docx' }));
  check('a document is launchable', doc.launchable === true);
  check('and the folder it would land in is named', !!doc.folder, doc.folder);

  // The guard that matters more than any assertion below it. This section runs
  // the real implementation, writing real bytes and launching a real file
  // manager, so the one thing it must never be pointed at is the tray belonging
  // to whoever is running the suite.
  check(
    'and it is the disposable tray, not the one on this machine',
    doc.folder === process.env.FILES_DIR,
    doc.folder,
  );

  const program = JSON.parse(await describe({ name: 'installer.exe' }));
  check('a program is not', program.launchable === false);
  check('and no application is claimed for it', program.app === null);

  // Revealing runs nothing, so it stays allowed for everything.
  const shown = JSON.parse(await reveal({ name: 'notes.txt', data: Buffer.from('xin chào').toString('base64'), how: 'folder' }));
  check('showing a file in a folder writes it out', fs.existsSync(shown.path), shown.path);
  check('with its bytes intact', fs.readFileSync(shown.path, 'utf8') === 'xin chào');
  // A tray of its own: not the workspace, and not where the app keeps its own
  // state either. This used to assert the folder was named "AI Remote", which
  // read as the same claim but was really only checking a string — and it went
  // on passing while the suite wrote into, and deleted, the real one.
  check('in a tray of its own', shown.folder === process.env.FILES_DIR, shown.folder);
  check(
    'kept apart from where the app stores its state',
    !shown.folder.startsWith(process.env.DATA_DIR),
    `${shown.folder} vs ${process.env.DATA_DIR}`,
  );

  // A name that would escape the folder, or make an invisible NTFS stream.
  const nasty = JSON.parse(
    await reveal({ name: '../../escaped:stream.txt', data: Buffer.from('x').toString('base64'), how: 'folder' }),
  );
  check('a path in the name cannot climb out', path.dirname(nasty.path) === nasty.folder, nasty.path);
  check('and a colon cannot open a data stream', !path.basename(nasty.path).includes(':'), path.basename(nasty.path));

  // The files go; the folder stays. `reveal` has just launched a file manager
  // at this directory, detached, and it opens on its own schedule — removing
  // the directory races that window and greets somebody with "Location is not
  // available". An empty folder left in the temp directory is the cheaper of
  // the two, and the OS sweeps it up.
  for (const leftover of fs.readdirSync(shown.folder)) {
    fs.rmSync(path.join(shown.folder, leftover), { recursive: true, force: true });
  }
}

section('old attachments fall out of the budget');
{
  const { toParts } = await import('../server/attachments.js');
  // Nothing loaded: the file is too far back to send in full.
  const stale = toParts(
    { attachments: [{ id: 'gone', name: 'old.png', kind: 'image' }] },
    new Map(),
  );
  check('it becomes a line of prose, not silence', stale[0]?.type === 'text', JSON.stringify(stale));
  check('naming the file', /old\.png/.test(stale[0]?.text || ''), stale[0]?.text);
  check('and saying why', /no longer included/.test(stale[0]?.text || ''), stale[0]?.text);
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n[32mAll attachment checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
