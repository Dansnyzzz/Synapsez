/**
 * The server's own sentences reach a person in their language.
 *
 * Three things rot silently here, and each has a section:
 *
 *   **A new sentence with no translation.** Somebody adds `throw new Error('…')`
 *   and a Vietnamese account sees English. `scripts/server-messages.js` reads
 *   every sentence out of the source, and each must have an entry.
 *
 *   **A translation that drops a value.** `{0}` missing from the Vietnamese means
 *   the file name or the limit silently vanishes from the message.
 *
 *   **The wiring.** A dictionary nobody consults is decoration: an HTTP error and
 *   a stream event are checked end to end, and English stays untouched.
 *
 *   node test/server-i18n.test.mjs
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import express from 'express';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { serverMessages } = await import('../scripts/server-messages.js');
const { vi } = await import('../server/i18n/vi.js');
const { translateMessage, translateEvent, translateErrors, languageOf } = await import('../server/i18n/index.js');

/** Printed to a terminal at startup, never to a browser. */
const TERMINAL_ONLY = [/^Missing required environment variables:/];

section('every sentence the server writes has a Vietnamese translation');
{
  const found = serverMessages();
  check('the extractor finds sentences at all', found.length > 200, `${found.length}`);
  const missing = [
    ...new Map(
      found
        .filter((m) => !(m.text in vi) && !TERMINAL_ONLY.some((re) => re.test(m.text)))
        .map((m) => [m.text, `${m.file}:${m.line} "${m.text.slice(0, 70)}"`]),
    ).values(),
  ];
  check('none is missing from server/i18n/vi.js', missing.length === 0, missing.slice(0, 8).join(' | '));

  const empty = Object.entries(vi).filter(([, v]) => !String(v).trim());
  check('no translation is empty', empty.length === 0, empty.map(([k]) => k).join(' | '));
}

section('a translation keeps every value its English carries');
{
  const holes = (s) => new Set([...String(s).matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
  // A Vietnamese sentence may drop a hole only where English used it for an
  // inflection Vietnamese does not have — the plural "s" of "minute{1}".
  const INFLECTION_ONLY = new Set(['Too many attempts. Try again in about {0} minute{1}.']);
  const dropped = Object.entries(vi).filter(([en, text]) => {
    if (INFLECTION_ONLY.has(en)) return false;
    const want = holes(en);
    const have = holes(text);
    return [...want].some((h) => !have.has(h)) || [...have].some((h) => !want.has(h));
  });
  check('placeholders match on both sides', dropped.length === 0, dropped.map(([k]) => k).slice(0, 5).join(' | '));
}

section('the translator');
{
  check('an exact sentence', translateMessage('Wrong email or password.', 'vi') === 'Sai email hoặc mật khẩu.');
  check('a key shape named in two ways keeps its "or" in Vietnamese', /AIza hoặc AQ/.test(translateMessage('That does not look like a Google Gemini key — those begin AIza or AQ.', 'vi')), translateMessage('That does not look like a Google Gemini key — those begin AIza or AQ.', 'vi'));
  check(
    'a shape fills its values back in',
    translateMessage('No API key for Anthropic. Add one in Settings → Providers.', 'vi') ===
      'Chưa có API key cho Anthropic. Thêm key trong Cài đặt → Nhà cung cấp.',
  );
  check(
    'a value that is itself a sentence is translated inside the outer one',
    translateMessage('Downloads a file onto your computer.', 'vi') === 'Tải một tệp về máy tính của bạn.',
  );
  check(
    'text the server did not write passes through untouched',
    translateMessage('Error 529: overloaded_error', 'vi') === 'Error 529: overloaded_error',
  );
  check('English is returned as written', translateMessage('Wrong email or password.', 'en') === 'Wrong email or password.');
  check('an unknown language is treated as English', translateMessage('Wrong email or password.', 'fr') === 'Wrong email or password.');
  check('a non-string is left alone', translateMessage(undefined, 'vi') === undefined);
  {
    // A provider can hand back a whole error body. Matching it against every
    // shape must stay cheap, and a dump that long is data, not a sentence.
    const dump = ' is required and was not given'.repeat(2000);
    const started = performance.now();
    const out = translateMessage(dump, 'vi');
    const ms = performance.now() - started;
    check('a very long text is passed through, quickly', out === dump && ms < 50, `${ms.toFixed(1)}ms`);
  }

  const event = translateEvent(
    { message: 'Timed out.', code: 'x', toolCalls: [{ id: '1', reason: 'This path is outside your workspace.' }] },
    'vi',
  );
  check('a stream event has its message translated', event.message === 'Hết thời gian chờ.', event.message);
  check('and its code kept', event.code === 'x');
  check('and each approval reason translated', event.toolCalls[0].reason === 'Đường dẫn này nằm ngoài thư mục làm việc.', event.toolCalls[0].reason);
  const original = { message: 'Timed out.' };
  translateEvent(original, 'vi');
  check('without changing the object the loop still holds', original.message === 'Timed out.');

  check('the header picks the language', languageOf({ get: () => 'vi-VN' }) === 'vi');
  check('and a missing or odd header means English', languageOf({ get: () => undefined }) === 'en' && languageOf({ get: () => 'xx' }) === 'en');
}

section('an HTTP error arrives in the language the browser asked for');
{
  const app = express();
  app.use(translateErrors);
  app.get('/fail', (req, res) => res.status(404).json({ error: 'Chat not found', code: 'nope' }));
  app.get('/ok', (req, res) => res.json({ message: 'Chat not found' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  const get = (path, language) =>
    new Promise((resolve, reject) => {
      const req = http.get({ port, path, headers: language ? { 'X-Language': language } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject);
    });

  const vn = await get('/fail', 'vi');
  check('Vietnamese asked, Vietnamese error', vn.body.error === 'Không tìm thấy cuộc trò chuyện', vn.body.error);
  check('with the status and code untouched', vn.status === 404 && vn.body.code === 'nope');
  const plain = await get('/fail');
  check('no header, English error', plain.body.error === 'Chat not found', plain.body.error);
  const success = await get('/ok', 'vi');
  check("a success payload's strings are data and are not rewritten", success.body.message === 'Chat not found');

  server.close();
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll server i18n checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
