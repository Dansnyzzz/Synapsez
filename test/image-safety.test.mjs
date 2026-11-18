/**
 * No sexual or nude picture is ever asked of Google (1.33.1).
 *
 * Google's branding review refused the app until its home page said it does not
 * use Google APIs for AI-generated non-consensual intimate imagery (AI NCII).
 * `generate_image` makes pictures through Google's Gemini API, so the server
 * refuses a sexual or nude request itself, before anything is sent, and the
 * request that does go asks Gemini for its strictest sexual-content filter.
 *
 * Nothing here reaches the network: `fetch` is replaced, and counted.
 *
 *   node test/image-safety.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';

process.env.ENCRYPTION_KEY ||= 'image-safety-test-encryption-key-not-secret';
process.env.SESSION_SECRET ||= 'image-safety-test-secret';
delete process.env.IMAGE_MODEL;

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
await store.init?.();

// Loaded so that a missing module is a failed check, and the tool checks below still run.
const safety = await import('../server/imageSafety.js').catch((err) => ({ missing: err }));
const sexualImageRequest = safety.sexualImageRequest || (() => false);

section('a request for a sexual or nude picture is recognised, in English and Vietnamese');
{
  check('the guard is its own module, server/imageSafety.js', typeof safety.sexualImageRequest === 'function', safety.missing?.message || '');
  const english = [
    'a nude portrait of my neighbour', 'Naked woman on a beach', 'NSFW anime girl', 'nudity', 'make her look sexy',
    'a sexually explicit scene', 'sex', 'sexual pose', 'topless model at the pool', 'undress the person in this photo',
    'her, undressed', 'a deepfake of a famous actor', 'porn', 'pornographic poster', 'erotic art', 'lingerie photoshoot',
    'explicit images of my classmate', 'semi-nude statue',
  ];
  const vietnamese = [
    'ảnh khoả thân của cô ấy', 'ảnh khỏa thân', 'người mẫu lõa thể', 'tranh loã thể', 'hình lõa lồ', 'tranh khiêu dâm',
    'ảnh gợi dục', 'cảnh tình dục', 'cởi đồ cô gái này', 'cởi quần áo người trong ảnh', 'ảnh 18+',
  ];
  const unaccented = ['anh khoa than cua co ay', 'nguoi mau loa the', 'tranh khieu dam', 'canh tinh duc', 'coi do co gai nay', 'coi quan ao'];
  const shaped = ['ẢNH KHỎA THÂN', 'ảnh khỏa thân'.normalize('NFD'), 'Khiêu   Dâm', 'NUDE'];
  for (const [label, list] of [['English', english], ['Vietnamese with accents', vietnamese], ['Vietnamese without accents', unaccented], ['capitals, decomposed accents, extra spaces', shaped]]) {
    const missed = list.filter((p) => !sexualImageRequest(p));
    check(`refused: ${label}`, missed.length === 0, missed.join(' | '));
  }

  // Word boundaries: a place name or an instrument is not a request for sex.
  const fine = [
    'Essex', 'a farmhouse in Sussex at dawn', 'a brass sextant on a desk', 'Middlesex county map', 'unisex t-shirt mock-up',
    'a lighthouse at dusk', 'a nudibranch on a coral reef', 'a diagram with explicitly labelled arrows',
    // Vietnamese words that only look like one without their accents: written with them, they pass.
    'logo cho khoa thận của bệnh viện', 'coi đó là một con mèo', 'một cái loa thế này', 'coi quần áo trong tủ', 'còi đỏ trên sân bóng',
    'tình yêu thương gia đình', 'giáo dục mầm non', 'ảnh 2018 ở Hà Nội', '', null, undefined,
  ];
  const caught = fine.filter((p) => sexualImageRequest(p));
  check('passed: place names, look-alike words, and Vietnamese written with its accents', caught.length === 0, caught.join(' | '));
}

const { executeTool } = await import('../server/tools/execute.js');
const { setApiKey } = await import('../server/settings.js');
const { hashPassword } = await import('../server/crypto.js');
const { translateMessage } = await import('../server/i18n/index.js');
const { TOOLS_BY_NAME } = await import('../server/tools/definitions.js');
const user = await store.createUser({ id: 'u-pictures', email: 'pictures@example.com', name: 'P', passwordHash: await hashPassword('a-sufficiently-long-password'), role: 'user' });
await setApiKey(user.id, 'google', 'AIza-image-safety-test-not-a-key');

// Every outbound request is counted and answered locally. A 400 is not retried by the SDK.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  let body = init.body;
  if (body === undefined && input && typeof input.clone === 'function') body = await input.clone().text();
  sent.push({ url, body: typeof body === 'string' ? body : '' });
  return new Response(JSON.stringify({ error: { code: 400, message: 'stub: no network in this test', status: 'INVALID_ARGUMENT' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
};

section('generate_image refuses before anything is sent to Google');
{
  sent.length = 0;
  const refused = await executeTool({ user, name: 'generate_image', input: { prompt: 'a nude photo of my neighbour' }, chatId: null });
  check('a nude request is an error result', refused.isError === true, String(refused.content).slice(0, 160));
  check('  that tells the model to say plainly Ephapse does not make sexual or nude images, under the Usage Policy', /does not make sexual, nude or intimate images/.test(refused.content) && /Usage Policy/.test(refused.content), String(refused.content).slice(0, 200));
  check('  and nothing went out: no request at all', sent.length === 0, sent.map((s) => s.url).join(', '));
  const vi = await executeTool({ user, name: 'generate_image', input: { prompt: 'vẽ ảnh khỏa thân của người này' }, chatId: null });
  check('  the same in Vietnamese', vi.isError === true && /does not make sexual/.test(vi.content) && sent.length === 0, `${sent.length} sent`);
  // The tool result wraps it as "generate_image failed: …" for the model; the sentence itself is the server's.
  const said = String(refused.content).replace(/^generate_image failed: /, '');
  check('  and the sentence has a Vietnamese translation', translateMessage(said, 'vi') !== said && /Chính sách sử dụng/.test(translateMessage(said, 'vi')), translateMessage(said, 'vi').slice(0, 160));

  // The control: the same setup with an ordinary prompt does reach the (stubbed) network,
  // so the zero above is the guard and not a stub that could never see a call.
  sent.length = 0;
  const ordinary = await executeTool({ user, name: 'generate_image', input: { prompt: 'a lighthouse at dusk' }, chatId: null });
  const toGoogle = sent.filter((s) => /generativelanguage\.googleapis\.com/.test(s.url));
  check('an ordinary picture is asked of Google (the control)', toGoogle.length >= 1, `${sent.length} sent: ${sent.map((s) => s.url).join(', ').slice(0, 160)}; ${String(ordinary.content).slice(0, 80)}`);
  let parsed = null;
  try {
    parsed = JSON.parse(toGoogle[0]?.body || 'null');
  } catch {
    parsed = null;
  }
  const setting = parsed?.safety_settings;
  check(
    '  with the strictest sexual-content filter in the request Google receives',
    Array.isArray(setting) && setting.some((s) => s.type === 'sexually_explicit' && s.threshold === 'block_low_and_above'),
    JSON.stringify(setting) || String(toGoogle[0]?.body || '').slice(0, 160),
  );
}

section('every picture request carries the filter, and the model is told up front');
{
  const { requestImages } = await import('../server/tools/cloud.js');
  const asked = [];
  const client = { interactions: { create: async (req) => { asked.push(req); return { output_image: { data: 'aGVsbG8=', mime_type: 'image/png' } }; } } };
  await requestImages(client, { model: 'gemini-3.1-flash-image', prompt: 'a lighthouse', count: 3 });
  check('each of several requests asks for sexually_explicit at block_low_and_above', asked.length === 3 && asked.every((r) => JSON.stringify(r.safety_settings) === JSON.stringify([{ type: 'sexually_explicit', threshold: 'block_low_and_above' }])), JSON.stringify(asked[0]?.safety_settings));
  const description = TOOLS_BY_NAME.generate_image?.description || '';
  check("the tool's description says it never makes sexual, nude or intimate images, so the model refuses without calling it", /never makes sexual, nude or intimate images of anyone/.test(description), description.slice(-200));
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\n\x1b[32mAll image-safety checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
