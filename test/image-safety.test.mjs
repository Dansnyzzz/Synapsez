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

  // Fix round 1 (review, 2026-11-18): plain synonyms and word forms that walked past the first list.
  const wider = [
    'an unclothed woman', 'nakedness', 'a nudist beach', 'nudism', 'a sexualized cartoon', 'sexualised', 'a pornstar', 'pornhub style',
    'an XXX poster', 'an x-rated scene', 'she undresses slowly', 'a woman wearing nothing', 'wearing nothing but a smile',
    'a man with no clothes', 'people without clothes', 'a model without clothing', 'a woman with no clothing', 'wearing no clothing',
    'cô gái không mặc quần áo', 'người không mặc gì', 'ảnh nóng của cô ấy', 'ảnh nóng', 'khong mac quan ao', 'nguoi khong mac gi',
  ];
  const missedWider = wider.filter((p) => !sexualImageRequest(p));
  check('refused: the wider list, plain synonyms and word forms', missedWider.length === 0, missedWider.join(' | '));

  // Word boundaries: a place name or an instrument is not a request for sex.
  const fine = [
    'Essex', 'a farmhouse in Sussex at dawn', 'a brass sextant on a desk', 'Middlesex county map', 'unisex t-shirt mock-up',
    'a lighthouse at dusk', 'a nudibranch on a coral reef', 'a diagram with explicitly labelled arrows',
    // Vietnamese words that only look like one without their accents: written with them, they pass.
    'logo cho khoa thận của bệnh viện', 'coi đó là một con mèo', 'một cái loa thế này', 'coi quần áo trong tủ', 'còi đỏ trên sân bóng',
    'tình yêu thương gia đình', 'giáo dục mầm non', 'ảnh 2018 ở Hà Nội', '', null, undefined,
    // The wider list's neighbours.
    'a lighthouse at sunset', 'a woman wearing a red coat', 'clothes on a rack', 'nothing on the table', 'a man wearing a hat',
    'ảnh nông thôn Việt Nam', 'tin nóng trong ngày', 'không mặc áo mưa', 'không mặc cả',
    // "ảnh nóng" counts only with its accents: typed without them it is also "anh nông dân" (final review).
    've anh nong dan tren dong lua', 'anh nong',
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
  return new Response(JSON.stringify(googleAnswers), { status: 400, headers: { 'content-type': 'application/json' } });
};
// What the stand-in Google answers: by default an ordinary 400, not a safety block.
const ORDINARY_400 = { error: { code: 400, message: 'stub: no network in this test', status: 'INVALID_ARGUMENT' } };
let googleAnswers = ORDINARY_400;

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
  check("the tool's description says it must not make sexual, nude or intimate images, so the model refuses without calling it", /It must not make sexual, nude or intimate images of anyone; refuse such requests without calling it./.test(description), description.slice(-200));
  // Only words go to Google: no photo can be taken in, changed or "undressed" (fix round 1).
  check('  and only the description goes to Google as input, as text', asked.every((r) => r.input === 'a lighthouse' && !('image' in r) && !('images' in r)), JSON.stringify(asked[0]?.input));
}

section("Google's own safety block gets the same Usage Policy answer, never the SDK's words (fix round 1)");
{
  const { requestImages } = await import('../server/tools/cloud.js');
  // The shape @google/genai 2.20.0 throws for a 400 (read off the real client): status, the body
  // Google sent under .error.error ({ code, message }, the SDK's ErrorT), and "400 <message>".
  const sdkError = (body) =>
    Object.assign(new Error(`400 ${body.error.message}`), { name: 'BadRequestError', status: 400, statusCode: 400, error: { httpMeta: {}, error: body.error }, body: JSON.stringify(body) });
  const said = async (client) => requestImages(client, { model: 'gemini-3.1-flash-image', prompt: 'a portrait', count: 2 }).then(() => '(no error)', (err) => String(err?.message || err));
  const throwing = (body) => ({ interactions: { create: async () => { throw sdkError(body); } } });
  const blocks = [
    { error: { code: 'safety', message: 'Request blocked due to safety violations (harmful content). Please modify your input and retry.' } },
    { error: { code: 'prohibited_content', message: 'Input blocked: prohibited content.' } },
    { error: { code: 'jailbreak', message: 'Input blocked: jailbreak.' } },
    { error: { code: 'blocklist', message: 'Input blocked: blocklist.' } },
    { error: { message: 'Input blocked: no code given.' } },
  ];
  for (const body of blocks) {
    const text = await said(throwing(body));
    check(`a 400 "${body.error.code || body.error.message}" becomes the Usage Policy refusal, with "do not try again"`, /does not make sexual, nude or intimate images/.test(text) && /Usage Policy/.test(text) && /do not try again with other words/.test(text) && !/Request blocked|Input blocked|400/.test(text), text.slice(0, 160));
  }
  // The same code in a finished interaction's errors list (Google's page: background interactions).
  const failedInteraction = { interactions: { create: async () => ({ status: 'failed', errors: [{ code: 'safety', message: 'Request blocked due to safety violations.' }] }) } };
  const fromList = await said(failedInteraction);
  check('  and so does one that comes back failed with a safety code in its errors', /does not make sexual, nude or intimate images/.test(fromList) && !/Request blocked/.test(fromList), fromList.slice(0, 160));
  // The controls: any other failure keeps its own words.
  const other = await said(throwing({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } }));
  check('  while any other 400 keeps its own words', /API key not valid/.test(other) && !/does not make sexual/.test(other), other.slice(0, 160));

  // End to end, through the real SDK: Google answers its documented safety 400.
  googleAnswers = blocks[0];
  sent.length = 0;
  const viaTool = await executeTool({ user, name: 'generate_image', input: { prompt: 'a lighthouse at sunset' }, chatId: null });
  googleAnswers = ORDINARY_400;
  check('  through the tool and the real client, the model hears the Usage Policy refusal', sent.length >= 1 && viaTool.isError === true && /does not make sexual, nude or intimate images/.test(viaTool.content) && !/Request blocked/.test(viaTool.content), `${sent.length} sent; ${String(viaTool.content).slice(0, 160)}`);
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\n\x1b[32mAll image-safety checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
