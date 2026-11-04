/**
 * The quality gate on a finished answer (QC-001): what it flags, what it lets
 * the model change, and what it does when the model's repair is no good.
 *
 *   node test/quality.test.mjs
 */
import { addressKey, evidenceOf, unsourcedLinks, applyEdits, unlink, checkAnswer, textsIn } from '../server/qualityGate.js';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

// A conversation: the person names one page, a search brings back two more.
const messages = [
  { role: 'user', text: 'So sánh với bài này https://vnexpress.net/kinh-te-123.html giúp tôi' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'lãi suất 2026' } }],
  },
  {
    role: 'tool',
    results: [
      {
        toolCallId: 'c1',
        name: 'web_search',
        content: '<untrusted source="web search">\n1. Lãi suất — https://www.sbv.gov.vn/lai-suat?utm_source=x\n2. Báo cáo — https://tuoitre.vn/bao-cao-456.htm\n</untrusted>',
      },
    ],
  },
];
const evidence = evidenceOf(messages);

section('what counts as the same address');
{
  check('scheme, www., a trailing slash and tracking do not make a different page',
    addressKey('https://www.sbv.gov.vn/lai-suat/?utm_source=x') === addressKey('http://sbv.gov.vn/lai-suat'));
  check('  while another path does', addressKey('https://sbv.gov.vn/lai-suat') !== addressKey('https://sbv.gov.vn/ty-gia'));
}

section('an address nothing in the conversation accounts for is flagged (QC-001)');
{
  const answer = [
    'Theo [Ngân hàng Nhà nước](https://sbv.gov.vn/lai-suat), lãi suất giữ nguyên.',
    'Bài bạn gửi (https://vnexpress.net/kinh-te-123.html) nói khác.',
    'Xem thêm [phân tích](https://made-up.example/phan-tich-2026).',
    'Trang chủ: https://tuoitre.vn',
    '```',
    'curl https://example.invalid/api',
    '```',
  ].join('\n');
  const flagged = unsourcedLinks(answer, evidence);
  check('the invented one, and only it', JSON.stringify(flagged) === '["https://made-up.example/phan-tich-2026"]', JSON.stringify(flagged));
  check('  a page the person named, a page a search found, and a site whose page was read all count as sourced', !flagged.some((u) => /sbv|vnexpress|tuoitre/.test(u)));
  check('  an address in a code block is an example, not a citation', !flagged.some((u) => /example\.invalid/.test(u)));
}

section('the repair can only touch the flagged sentences');
{
  const answer = 'Đúng: [SBV](https://sbv.gov.vn/lai-suat).\nSai: [phân tích](https://made-up.example/x).';
  const flagged = ['https://made-up.example/x'];
  const good = applyEdits(answer, '{"edits":[{"find":"[phân tích](https://made-up.example/x)","replace":"phân tích (chưa kiểm chứng)"}]}', flagged, evidence);
  check('an edit to a flagged sentence is applied', good?.applied === 1 && good.text === 'Đúng: [SBV](https://sbv.gov.vn/lai-suat).\nSai: phân tích (chưa kiểm chứng).', good?.text);
  const reach = applyEdits(answer, '{"edits":[{"find":"Đúng: [SBV](https://sbv.gov.vn/lai-suat).","replace":"Rewritten."}]}', flagged, evidence);
  check('  an edit to a sentence that was right is refused', reach?.applied === 0 && reach.text === answer, reach?.text);
  const swap = applyEdits(answer, '{"edits":[{"find":"[phân tích](https://made-up.example/x)","replace":"[phân tích](https://another-invention.example/y)"}]}', flagged, evidence);
  check('  as is one that trades it for another unsourced address', swap?.applied === 0, swap?.text);
  const cited = applyEdits(answer, '{"edits":[{"find":"[phân tích](https://made-up.example/x)","replace":"[báo cáo](https://tuoitre.vn/bao-cao-456.htm)"}]}', flagged, evidence);
  check('  while citing a source that was read is fine', cited?.applied === 1 && cited.text.includes('tuoitre.vn/bao-cao-456.htm'), cited?.text);
  const chatty = applyEdits(answer, 'Sure! Here is the fix…', flagged, evidence);
  check('  and a reply that is not JSON changes nothing', chatty === null || (chatty.applied === 0 && chatty.text === answer), JSON.stringify(chatty));
  check('the fall-back keeps the words and drops the link', unlink(answer, flagged) === 'Đúng: [SBV](https://sbv.gov.vn/lai-suat).\nSai: phân tích.', unlink(answer, flagged));
}

section('the gate end to end');
{
  const answer = 'Lãi suất giữ nguyên ([SBV](https://sbv.gov.vn/lai-suat)). Chi tiết: [đây](https://made-up.example/x).';
  let asked = 0;
  const done = await checkAnswer({
    answer,
    messages,
    language: 'vi',
    ask: async () => {
      asked += 1;
      return '{"edits":[{"find":"Chi tiết: [đây](https://made-up.example/x).","replace":"Chi tiết: xem [báo cáo](https://tuoitre.vn/bao-cao-456.htm)."}]}';
    },
  });
  check('one repair call, the flagged sentence fixed, the rest byte for byte', asked === 1 && done.changed && done.fixed === 1 && done.text.startsWith('Lãi suất giữ nguyên ([SBV](https://sbv.gov.vn/lai-suat)). Chi tiết: xem [báo cáo]'), done.text);
  check('  and it says what it did, in the account\'s language', /Kiểm tra nguồn: đã sửa 1 chỗ trích dẫn/.test(done.text), done.text.split('\n').pop());

  const stubborn = await checkAnswer({ answer, messages, language: 'en', ask: async () => 'no' });
  check('a repair that does not come still leaves no invented link', !stubborn.text.includes('made-up.example') && stubborn.removed === 1 && /Source check: removed 1 link/.test(stubborn.text), stubborn.text);

  // AUDIT_RULES v5 V8: rounds while something is still flagged, and a round that changes nothing ends it.
  const two = 'A [x](https://made-up.example/a). B [y](https://made-up.example/b).';
  const replies = [
    '{"edits":[{"find":"A [x](https://made-up.example/a).","replace":"A x (unverified)."}]}',
    '{"edits":[{"find":"B [y](https://made-up.example/b).","replace":"B y (unverified)."}]}',
  ];
  let rounds = 0;
  const both = await checkAnswer({ answer: two, messages, ask: async () => replies[rounds++] || '{}' });
  check('one flagged address left after a round gets another round, up to the limit', rounds === 2 && both.fixed === 0 && both.removed === 2 && both.text.startsWith('A x (unverified). B y (unverified).'), `${rounds} rounds · ${both.text}`);
  let idle = 0;
  const stuck = await checkAnswer({ answer: two, messages, rounds: 3, ask: async () => { idle += 1; return '{"edits":[]}'; } });
  check('  a round that changes nothing ends the rounds, and the fall-back holds', idle === 1 && stuck.removed === 2 && !/made-up/.test(stuck.text), `${idle} rounds`);

  let calls = 0;
  const clean = await checkAnswer({ answer: 'Không có liên kết nào.', messages, ask: async () => { calls += 1; return ''; } });
  check('an answer with nothing to check costs no call and is not touched', !clean.changed && calls === 0 && clean.text === 'Không có liên kết nào.');
}

section('what the model was shown counts, and emphasis is not part of an address (QC-003)');
{
  // A link from the person's own file, a memory note and a project passage: none of them is
  // in the stored messages, all of them were in what the step sent.
  const shown = {
    system: '## Memory\n- **docs**: the team wiki is https://wiki.acme-internal.example/home',
    outgoing: [
      // `data` holds what would otherwise read as a source: it is bytes, and must be skipped by its key.
      { role: 'user', text: 'Summarise the attached guide.', parts: [{ type: 'text', text: 'guide.pdf:\nSee https://docs.acme-internal.example/guide for setup.' }, { type: 'image', data: 'https://not-a-source.example/bytes' }] },
    ],
    grounded: [{ role: 'user', text: 'Project passage: pricing at https://acme-internal.example/pricing' }],
  };
  const sources = textsIn(shown);
  const answer = 'Setup: https://docs.acme-internal.example/guide. Wiki: https://wiki.acme-internal.example/home. Prices: https://acme-internal.example/pricing.';
  let asked = 0;
  const kept = await checkAnswer({ answer, messages: [], sources, ask: async () => { asked += 1; return '{}'; } });
  check('a link from an attached file, a memory note or a project passage is not taken for an invention', !kept.changed && asked === 0 && kept.text === answer, JSON.stringify(kept.flagged));
  check("  and a picture's bytes are not read as text", !sources.some((s) => s.includes('not-a-source.example')), JSON.stringify(sources));

  const searched = [{ role: 'assistant', results: [{ content: 'Result: https://example.com/docs/page' }] }];
  for (const mark of ['**', '_', '~~']) {
    const marked = `The page is ${mark}https://example.com/docs/page${mark} today.`;
    const out = await checkAnswer({ answer: marked, messages: searched, ask: async () => '{}' });
    check(`  a link a search returned, inside ${mark} emphasis, is left as it is`, !out.changed && out.text === marked, JSON.stringify(out.flagged));
  }
}

section('a PDF the model was handed as a file is read only when something is flagged (QC-005)');
{
  const answer = 'Setup is at https://docs.acme-internal.example/pdf-guide.';
  let reads = 0;
  let asked = 0;
  const fromPdf = async () => {
    reads += 1;
    return ['--- page 1 ---\nSetup: https://docs.acme-internal.example/pdf-guide'];
  };
  const kept = await checkAnswer({ answer, messages: [], moreSources: fromPdf, ask: async () => { asked += 1; return '{}'; } });
  check("a link from the person's own PDF stands, with no repair call", !kept.changed && kept.text === answer && asked === 0 && reads === 1, JSON.stringify(kept.flagged));

  reads = 0;
  await checkAnswer({ answer: 'Nothing to check here.', messages: [], moreSources: fromPdf, ask: async () => '{}' });
  check('  an answer with nothing flagged does not read the file', reads === 0);

  const invented = await checkAnswer({ answer: 'See https://made-up.example/qc5.', messages: [], moreSources: fromPdf, ask: async () => '{}' });
  check('  while an address the PDF does not hold is still removed', invented.removed === 1 && !/made-up/.test(invented.text), invented.text);

  const broken = await checkAnswer({ answer: 'See https://made-up.example/qc5.', messages: [], moreSources: async () => { throw new Error('unreadable'); }, ask: async () => '{}' });
  check('  and a PDF that cannot be read leaves the gate as it was', broken.removed === 1 && !/made-up/.test(broken.text), broken.text);
}

section('the figure check: a figure nothing read holds is corrected or marked (QC-002)');
{
  const { figureEvidenceOf, unsourcedFigures, applyFigureEdits, markFigures, checkFigures } = await import('../server/qualityGate.js');
  const read = [
    { role: 'user', text: 'Lãi suất hôm nay?' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'f1', name: 'web_search', input: { query: 'lãi suất' } }] },
    { role: 'tool', results: [{ toolCallId: 'f1', content: 'SBV giữ lãi suất 4.5% từ 2026-11-03; dư nợ 1234567 tỷ; giá 12.000đ; xe chạy 100km.' }] },
  ];
  const evidence = figureEvidenceOf(read);
  const found = (answer) => unsourcedFigures(answer, evidence);

  check('a figure a source holds passes, however it is written', found('Lãi suất 4,5% từ 03/11/2026, dư nợ 1,234,567 tỷ, giá 12.000 đồng, quãng 100 km.').length === 0, JSON.stringify(found('Lãi suất 4,5% từ 03/11/2026, dư nợ 1,234,567 tỷ, giá 12.000 đồng, quãng 100 km.')));
  check('  one no source holds is flagged', JSON.stringify(found('Lạm phát 7,2% và lãi suất 4,5%.')) === '["7,2%"]', JSON.stringify(found('Lạm phát 7,2% và lãi suất 4,5%.')));
  check('  names, versions, single digits, list numbers, footnotes, code and addresses are not figures',
    found('1. Dùng gpt-5, bản v1.25, nước H2O, 3 bước [12], `port 8080`, https://example.com/2024/99.').length === 0,
    JSON.stringify(found('1. Dùng gpt-5, bản v1.25, nước H2O, 3 bước [12], `port 8080`, https://example.com/2024/99.')));
  check('  nor is one in a fenced code block', found('```\ntotal = 98765\n```').length === 0);
  check('  and a figure already marked as unverified is not flagged again', found('Lạm phát 7,2% (chưa kiểm chứng).').length === 0 && found('Inflation 7.2% (unverified).').length === 0);

  const answer = 'Lãi suất 4,5%. Lạm phát 7,2% năm nay.';
  const fixedTo = applyFigureEdits(answer, '{"edits":[{"find":"Lạm phát 7,2% năm nay.","replace":"Lạm phát 4,5% năm nay."}]}', ['7,2%'], evidence);
  check('a correction to a figure a source holds is applied, the rest byte for byte', fixedTo?.applied === 1 && fixedTo.text === 'Lãi suất 4,5%. Lạm phát 4,5% năm nay.', fixedTo?.text);
  const another = applyFigureEdits(answer, '{"edits":[{"find":"Lạm phát 7,2% năm nay.","replace":"Lạm phát 8,1% năm nay."}]}', ['7,2%'], evidence);
  check('  trading it for another unfound figure is refused', another?.applied === 0, another?.text);
  const reach = applyFigureEdits(answer, '{"edits":[{"find":"Lãi suất 4,5%.","replace":"Lãi suất cao."}]}', ['7,2%'], evidence);
  check('  as is an edit to a sentence with no flagged figure', reach?.applied === 0);
  const linked = applyFigureEdits(answer, '{"edits":[{"find":"Lạm phát 7,2% năm nay.","replace":"Lạm phát 7,2% (https://made-up.example/cpi)."}]}', ['7,2%'], evidence);
  check('  and one that brings in an address', linked?.applied === 0);
  check('the fall-back marks the figure and changes nothing else', markFigures(answer, evidence, 'vi').text === 'Lãi suất 4,5%. Lạm phát 7,2% (chưa kiểm chứng) năm nay.', markFigures(answer, evidence, 'vi').text);

  let calls = 0;
  const clean = await checkFigures({ answer: 'Lãi suất 4,5%.', messages: read, ask: async () => { calls += 1; return '{}'; } });
  check('an answer whose figures are all found costs no call and is not touched', !clean.changed && calls === 0 && clean.text === 'Lãi suất 4,5%.');
  const repaired = await checkFigures({ answer, messages: read, language: 'en', ask: async (_s, prompt) => { calls += 1; return /7,2%/.test(prompt) && /4\.5%/.test(prompt) ? '{"edits":[{"find":"Lạm phát 7,2% năm nay.","replace":"Lạm phát 4,5% năm nay."}]}' : '{}'; } });
  check('one call, shown the flagged figure and what was read; the correction kept', calls === 1 && repaired.fixed === 1 && repaired.marked === 0 && repaired.text.startsWith('Lãi suất 4,5%. Lạm phát 4,5% năm nay.') && /Figure check: corrected 1/.test(repaired.text), repaired.text);
  const stubborn = await checkFigures({ answer, messages: read, language: 'vi', ask: async () => 'không' });
  check('  a repair that does not come still leaves the figure marked, and says so', stubborn.marked === 1 && /7,2% \(chưa kiểm chứng\)/.test(stubborn.text) && /Kiểm tra số liệu: đã đánh dấu 1 số liệu/.test(stubborn.text), stubborn.text);
  const fromPdf = await checkFigures({ answer: 'Doanh thu 7,2%.', messages: read, moreSources: async () => ['--- page 1 ---\nDoanh thu tăng 7.2%'], ask: async () => '{}' });
  check('  a figure from a PDF the model was handed as a file is found there (QC-005)', !fromPdf.changed, fromPdf.text);
}

section('a link is removed by the whole address, however it is spelled (QC-014)');
{
  // Reproduced by evaluator pass 2: matched as text, a flagged page took a longer, true one with it.
  const read = [{ role: 'tool', results: [{ content: 'read https://a.example/docs/intro and https://news.example/kinh-te-4812.html' }] }];
  const answer = 'Doc [Intro](https://a.example/docs/intro). Trang chu [Docs](https://a.example/docs).';
  const kept = await checkAnswer({ answer, messages: read, ask: async () => '{"edits":[]}' });
  check('a page that was read stays linked when a shorter address is flagged', kept.text.startsWith('Doc [Intro](https://a.example/docs/intro). Trang chu Docs.') && kept.removed === 1, kept.text);
  check('  bare, too, the full stop kept', unlink('A https://a.example/docs/intro, B https://a.example/docs.', ['https://a.example/docs']) === 'A https://a.example/docs/intro, B .', unlink('A https://a.example/docs/intro, B https://a.example/docs.', ['https://a.example/docs']));
  check('  with no slash between them', unlink('[x](https://news.example/kinh-te-4812.html)', ['https://news.example/kinh-te']) === '[x](https://news.example/kinh-te-4812.html)');

  const spelled = 'A https://fake.example/x?utm_source=a. B https://www.fake.example/x/ C [d](http://fake.example/x) E <https://fake.example/x#top>';
  const gone = await checkAnswer({ answer: spelled, messages: [], ask: async () => '{"edits":[]}' });
  check('every spelling of a flagged page loses its link, not only the first', !/fake\.example/.test(gone.text) && gone.removed === 1, gone.text);
  check('  once each in the count: one page, one link', /removed 1 link\b/.test(gone.text), gone.text);

  const coded = 'Xem https://fake.example/x\n```\ncurl https://fake.example/x\n```';
  const fenced = await checkAnswer({ answer: coded, messages: [], ask: async () => '{"edits":[]}' });
  check('a code block is left as it is, the same address and all', fenced.text.includes('curl https://fake.example/x\n') && !fenced.text.startsWith('Xem https'), fenced.text);

  check('a title, brackets in the address and a picture are all taken whole',
    unlink('[a](https://fake.example/x "T") [b](https://fake.example/y_(z)) ![c](https://fake.example/p.png)', ['https://fake.example/x', 'https://fake.example/y_(z)', 'https://fake.example/p.png']) === 'a b c',
    unlink('[a](https://fake.example/x "T") [b](https://fake.example/y_(z)) ![c](https://fake.example/p.png)', ['https://fake.example/x', 'https://fake.example/y_(z)', 'https://fake.example/p.png']));

  const evidence2 = evidenceOf(read);
  const reach = applyEdits('See [x](https://news.example/kinh-te-4812.html).', '{"edits":[{"find":"See [x](https://news.example/kinh-te-4812.html).","replace":"Rewritten."}]}', ['https://news.example/kinh-te'], evidence2);
  check('an edit cannot reach a sentence that only holds a longer address', reach?.applied === 0, reach?.text);

  const two = 'Xem [a](https://fake.example/a) va [b](https://fake.example/b).';
  const dropped = await checkAnswer({ answer: two, messages: [], ask: async () => '{"edits":[{"find":"Xem [a](https://fake.example/a) va [b](https://fake.example/b).","replace":"Xem a va b."}]}' });
  check('one edit that drops two links says two (QC-011)', dropped.removed === 2 && dropped.fixed === 0 && /removed 2 links/.test(dropped.text), dropped.text);
}

section('the last of what makes an address the same one (QC-020)');
{
  const read = (...urls) => [{ role: 'tool', results: [{ content: urls.join('\n') }] }];
  const passes = (answer, ...urls) => unsourcedLinks(answer, evidenceOf(read(...urls))).length === 0;
  // Evaluator pass 5, regressions of QC-019 on the source check that is on for everyone.
  check("English's possessive on a page that was read is that page", passes("Trang https://x.example/a's blog", 'https://x.example/a') && passes("Trang https://x.example's blog", 'https://x.example/a'));
  check("  while a word after the apostrophe is still another page", !passes("https://x.example/Moore's_fake", "https://x.example/Moore's_law"));
  check('an apostrophe before any letter is part of it, accents included', passes("[L'État](https://x.example/L'État)", 'https://x.example/L%27%C3%89tat'), JSON.stringify(unsourcedLinks("[L'État](https://x.example/L'État)", evidenceOf(read('https://x.example/L%27%C3%89tat')))));
  check("  and tells two pages apart", !passes("https://x.example/L'Épée", "https://x.example/L'État"));
  check('a route with a trailing slash is the same route', passes('https://x.example/#/report/', 'https://x.example/#/report'));
  check('  and a bare #/ is the site', passes('https://x.example/#/', 'https://x.example/a'));
  // Sweeping the class.
  // An em dash and an ellipsis stay part of an address: as stops in raw text they missed the same
  // character decoded, and a true link went. An unspaced one running on into a sentence is a stated limit.
  for (const [answer, source] of [['[trang](https://x.example/A—B)', 'https://x.example/A%E2%80%94B'], ['[trang](https://x.example/A%E2%80%94B)', 'https://x.example/A—B'], ['https://x.example/A…B', 'https://x.example/A%E2%80%A6B'], ['https://x.example/s?q=A—B', 'https://x.example/s?q=A%E2%80%94B']]) {
    check(`a title holding one is one page, however written: ${answer} and ${source}`, passes(answer, source), JSON.stringify(unsourcedLinks(answer, evidenceOf(read(source)))));
    const kept = await checkAnswer({ answer, messages: read(source), ask: async () => { throw new Error('no call'); } });
    check('  and is not touched', !kept.changed && kept.text === answer, kept.text);
  }
  // Tried once: it recursed, so `a's's` passed and a long run threw, which skipped the whole check.
  check("  the possessive is taken off once", !passes("https://x.example/a's's", 'https://x.example/a'));
  const manyS = `https://fake.example/a${"'s".repeat(100_000)}`;
  const startedS = Date.now();
  const longRun = await checkAnswer({ answer: manyS, messages: [], ask: async () => '{"edits":[]}' });
  check('  and a long run of them neither throws nor takes time', longRun.removed === 1 && Date.now() - startedS < 1500, `${Date.now() - startedS} ms`);
  check('another port is another address', !passes('https://x.example:9999/a', 'https://x.example/a'));
  check('  the usual one is not', passes('https://x.example:443/a', 'https://x.example/a'));
  check('  and a site with a port is that site', passes('https://x.example:8080', 'https://x.example:8080/a'));
  // What removal leaves.
  for (const [text, want] of [['**https://bad.example/a**', ''], ['_https://bad.example/a_', ''], ['~~https://bad.example/a~~ hết', ' hết'], ['Xem **https://bad.example/a**.', 'Xem .'], ['**xem https://bad.example/a**', '**xem **']]) {
    check(`emphasis closing over nothing goes: ${text}`, unlink(text, ['https://bad.example/a']) === want, JSON.stringify(unlink(text, ['https://bad.example/a'])));
  }
}

section('a link taken out whole, and what stays (QC-019)');
{
  const read = (...urls) => [{ role: 'tool', results: [{ content: urls.join('\n') }] }];
  // Evaluator pass 4, regressions of QC-017: the link stayed, and its head was cut out of it.
  const moore = "See [Moore's law](https://en.wikipedia.org/wiki/Moore's_law) for more.";
  const invented = await checkAnswer({ answer: moore, messages: [], ask: async () => '{"edits":[]}' });
  check('an address with an apostrophe goes whole, its words kept', invented.text.startsWith("See Moore's law for more."), invented.text);
  check('  and is found whole when it was read, written either way', unsourcedLinks(moore, evidenceOf(read("https://en.wikipedia.org/wiki/Moore's_law"))).length === 0 && unsourcedLinks(moore, evidenceOf(read('https://en.wikipedia.org/wiki/Moore%27s_law'))).length === 0);
  check('  a closing quote is still not part of one', unsourcedLinks("Xem 'https://x.example/a' nhé", evidenceOf(read('https://x.example/a'))).length === 0);
  check('a link whose target runs past where an address in text stops goes whole', unlink('[x](https://fake.example/a|b)', ['https://fake.example/a']) === 'x', unlink('[x](https://fake.example/a|b)', ['https://fake.example/a']));

  const left = (text) => unlink(text, ['https://bad.example/a']);
  check('words after a reference\'s address are words, and stay', left('[1]: https://bad.example/a - World Bank report') === '[1]:  - World Bank report' && left('[^1]: https://bad.example/a World Bank, 2023') === '[^1]:  World Bank, 2023', left('[1]: https://bad.example/a - World Bank report'));
  check('  a title goes with it, however it is quoted, a line ending included', ['[1]: https://bad.example/a "T"', "[1]: https://bad.example/a 'T'", '[1]: https://bad.example/a (T)', '[1]: https://bad.example/a "T"\r', '[1]: <https://bad.example/a>'].every((l) => left(l) === ''), JSON.stringify(left('[1]: https://bad.example/a "T"\r')));

  const span = await checkAnswer({ answer: 'Call https://bad.example/users/`id` now', messages: [], ask: async () => '{"edits":[]}' });
  check('an address touching inline code goes, and the code stays', span.text.startsWith('Call `id` now') && span.removed === 1, span.text);
  const split = await checkAnswer({ answer: 'See https://invented.example\u0000/login now', messages: read('https://true.example/a'), ask: async () => '{"edits":[]}' });
  check('an invented address with NUL in it goes whole, rather than coming back live', !split.text.includes('invented.example') && split.removed === 1, JSON.stringify(split.text));
  for (const at of ['7', '0']) {
    const nul = `a\u0000${at}\u0000 b \`c\` https://bad.example/a`;
    check(`NUL in an answer is not taken for code set aside: position ${at}`, unlink(nul, ['https://bad.example/a']) === `a${at} b \`c\` `, JSON.stringify(unlink(nul, ['https://bad.example/a'])));
  }

  // A bare site is the site; anything more is a page, and nobody read it.
  const site = evidenceOf(read('https://x.example/read-this'));
  for (const url of ['https://x.example/?p=99999', 'https://x.example/#/fake', 'https://x.example/#!/fake', 'https://x.example/other']) {
    check(`a page nobody read on a site that was read is flagged: ${url}`, unsourcedLinks(url, site).length === 1, JSON.stringify(unsourcedLinks(url, site)));
  }
  for (const url of ['https://x.example', 'https://www.x.example/', 'https://x.example/read-this#top']) {
    check(`  the bare site, or a place on a page that was read, is not: ${url}`, unsourcedLinks(url, site).length === 0, JSON.stringify(unsourcedLinks(url, site)));
  }

  let prompt = '';
  await checkAnswer({ answer: 'Xem https://fake.example/x.', messages: read('http://x.example/a%20b?q=c%20d&e=f'), ask: async (_s, p) => { prompt = p; return '{"edits":[]}'; } });
  check('the repair is shown what was read as it was written, to cite', prompt.includes('- http://x.example/a%20b?q=c%20d&e=f'), prompt.split('\n').filter((l) => l.startsWith('- ')).join(' '));

  const { markFigures, figureEvidenceOf, checkFigures } = await import('../server/qualityGate.js');
  const none = figureEvidenceOf([], ['nothing']);
  const manyFigures = '12 '.repeat(66_000);
  let started = Date.now();
  const marked = markFigures(manyFigures, none);
  check('a long line of figures is marked in no time', Date.now() - started < 1500 && marked.marked === 66_000, `${Date.now() - started} ms`);
  check('  each in its place', markFigures('a 12 b 34 c', none).text === 'a 12 (unverified) b 34 (unverified) c', markFigures('a 12 b 34 c', none).text);
  started = Date.now();
  await checkAnswer({ answer: 'Xem https://fake.example/x.', messages: [], ask: async () => '{'.repeat(100_000) });
  await checkFigures({ answer: 'Giá 500', messages: [], ask: async () => '{'.repeat(100_000) });
  check('a repair reply of braces takes no time', Date.now() - started < 1000, `${Date.now() - started} ms`);
}

section('where an address ends, and what makes it the same page (QC-017)');
{
  const read = (...urls) => [{ role: 'tool', results: [{ content: urls.join('\n') }] }];
  const passes = (answer, ...urls) => unsourcedLinks(answer, evidenceOf(read(...urls))).length === 0;

  // Inline code is an example, as a code block is.
  for (const answer of ['Chạy `curl https://api.example.com/v1/health` để kiểm tra.', 'Mở `http://localhost:3000` trong trình duyệt.', 'Xem ``https://x.example/a`` nhé.']) {
    const out = await checkAnswer({ answer, messages: [], ask: async () => { throw new Error('no call'); } });
    check(`an address in inline code is not checked, and costs no call: ${answer.slice(0, 24)}…`, !out.changed && out.text === answer, out.text);
  }
  const mixed = unlink('Dùng `curl https://fake.example/x` chứ không phải https://fake.example/x.', ['https://fake.example/x']);
  check('  the same address outside it still goes, and the code stays', mixed === 'Dùng `curl https://fake.example/x` chứ không phải .', mixed);

  // What ends an address: read as part of it, these took a true link and the words after it.
  for (const answer of ['|https://x.example/a|Bài viết|', '“https://x.example/a”.', '《https://x.example/a》', '请看https://x.example/a，然后继续阅读全文。', 'Xem https://x.example/a; rồi đọc tiếp.', 'Xem (https://x.example/a).', 'Xem **https://x.example/a**.']) {
    check(`a true link is found where it ends: ${answer}`, passes(answer, 'https://x.example/a'), JSON.stringify(unsourcedLinks(answer, evidenceOf(read('https://x.example/a')))));
  }
  check('  two addresses and a comma between them are two', passes('https://x.example/a,https://x.example/b', 'https://x.example/a', 'https://x.example/b'));
  check('  an invented one in a table loses only itself, the cell\'s words stay', unlink('|https://fake.example/a|Bài viết|', ['https://fake.example/a']) === '||Bài viết|', unlink('|https://fake.example/a|Bài viết|', ['https://fake.example/a']));

  // The same page, however it was written.
  for (const [answer, source] of [
    ['https://x.example/ti%e1%bb%87m', 'https://x.example/ti%E1%BB%87m'],
    ['https://x.example/tiệm', 'https://x.example/ti%E1%BB%87m'],
    ['https://x.example/tiệm', 'https://x.example/tiệm'],
    ['https://x.example/s?q=a%20b', 'https://x.example/s?q=a%20b&utm_source=rss'],
    ['https://x.example/s?q=a+b', 'https://x.example/s?q=a%20b'],
    ['https://x.example/s?a=1&b=2', 'https://x.example/s?a=1&amp;b=2'],
  ]) {
    check(`one page, however written: ${answer} and ${source}`, passes(answer, source), `${addressKey(answer)} / ${addressKey(source)}`);
  }
  // Two pages, however alike.
  for (const [answer, source] of [['https://x.example/Mercury_(invented)', 'https://x.example/Mercury_(planet)'], ['https://x.example/s?q=a', 'https://x.example/s?q=b'], ['https://x.example/a%2Fb', 'https://x.example/a/c']]) {
    check(`  two pages, however alike: ${answer} and ${source}`, !passes(answer, source), addressKey(answer));
  }
  check('brackets that balance stay with the address, and the one closing a link does not', unlink('[a](https://x.example/F_(p)) và https://x.example/F_(p).', ['https://x.example/F_(p)']) === 'a và .', unlink('[a](https://x.example/F_(p)) và https://x.example/F_(p).', ['https://x.example/F_(p)']));

  // What a link's removal leaves.
  const left = (text) => unlink(text, ['https://fake.example/x']);
  check("words holding brackets stay whole", left('[Báo cáo [PDF]](https://fake.example/x)') === 'Báo cáo [PDF]', left('[Báo cáo [PDF]](https://fake.example/x)'));
  check('  a title in single quotes goes with it', left("[a](https://fake.example/x 'tiêu đề')") === 'a', left("[a](https://fake.example/x 'tiêu đề')"));
  check('  a reference definition goes whole', left('[1]: https://fake.example/x "T"') === '', left('[1]: https://fake.example/x "T"'));
  check('  a picture inside a true link loses only the picture', left('[![b](https://fake.example/x)](https://x.example/a)') === '[b](https://x.example/a)', left('[![b](https://fake.example/x)](https://x.example/a)'));

  // Model output and page text, at their longest: none of this may hold the turn up.
  for (const [label, text] of [['[', '['.repeat(200_000)], ['[a', '[a'.repeat(100_000)], ['dots in a page', `https://x.example/${'.'.repeat(200_000)}a`], ['slashes', `https://x.example/${'/'.repeat(100_000)}a`], ['brackets', `https://x.example/${'('.repeat(100_000)}`]]) {
    const started = Date.now();
    unlink(text, ['https://fake.example/x']);
    unsourcedLinks(text, evidenceOf(read(text)));
    const took = Date.now() - started;
    check(`  a line of ${label} takes no time`, took < 1500, `${took} ms`);
  }
}

section('more of what the figure check reads, and where its mark goes (QC-016)');
{
  const { figureEvidenceOf, unsourcedFigures, markFigures } = await import('../server/qualityGate.js');
  const none = figureEvidenceOf([], ['nothing here']);
  const marks = (answer) => markFigures(answer, none, 'en').text;
  for (const line of ['> 12. Item', '> - 13) Item', '> ## 14. Heading', '<img src="a.png" width="640">', '<td colspan="12">x</td>']) {
    check(`numbering in a quote, and a tag's attributes, are not figures: ${line}`, marks(line) === line, marks(line));
  }
  check('a timestamp keeps together, its mark after all of it', marks('Lúc 2026-11-03T10:30:00Z đã xong.') === 'Lúc 2026-11-03T10:30:00Z (unverified) đã xong.', marks('Lúc 2026-11-03T10:30:00Z đã xong.'));
  check('  a unit with a slash too', marks('chạy 100km/h nhanh') === 'chạy 100km/h (unverified) nhanh', marks('chạy 100km/h nhanh'));
  check('  and a full stop ending the sentence is not part of the unit', marks('giá 15.000đ. Hết') === 'giá 15.000đ (unverified). Hết', marks('giá 15.000đ. Hết'));
  check('a percentage with a space before its sign is read whole', marks('Tăng 15 % và 5 % nữa') === 'Tăng 15 % (unverified) và 5 % (unverified) nữa', marks('Tăng 15 % và 5 % nữa'));
  check('  and is the same figure as one without', unsourcedFigures('Tăng 15 % nữa', figureEvidenceOf([], ['tăng 15%'])).length === 0);
  check('a colon after a word is punctuation', marks('Giá:15.000 thôi') === 'Giá:15.000 (unverified) thôi', marks('Giá:15.000 thôi'));
  check('a currency code does not hide its price', marks('Giá USD1,300 thôi') === 'Giá USD1,300 (unverified) thôi', marks('Giá USD1,300 thôi'));
  check('  while a name with digits is still a name', marks('dùng gpt-5, H2O, v1.25') === 'dùng gpt-5, H2O, v1.25', marks('dùng gpt-5, H2O, v1.25'));
  check('two figures ending at one place get one mark', marks('Tăng 30%-40% nữa') === 'Tăng 30%-40% (unverified) nữa', marks('Tăng 30%-40% nữa'));
}

section('what a check says it did is what it did (QC-011)');
{
  const answer = 'Xem [đây](https://made-up.example/x).';
  const cited = await checkAnswer({ answer, messages, ask: async () => '{"edits":[{"find":"[đây](https://made-up.example/x)","replace":"[đây](https://tuoitre.vn/bao-cao-456.htm)"}]}' });
  check('citing a source that was read is a correction', cited.fixed === 1 && cited.removed === 0 && /corrected 1 citation\b/.test(cited.text), cited.text);
  const words = await checkAnswer({ answer, messages, ask: async () => '{"edits":[{"find":"[đây](https://made-up.example/x)","replace":"đây (unverified)"}]}' });
  check('  keeping only the words is a link removed, not a citation corrected', words.fixed === 0 && words.removed === 1 && /removed 1 link\b/.test(words.text) && !/corrected/.test(words.text), words.text);

  const { checkFigures } = await import('../server/qualityGate.js');
  const read = [{ role: 'tool', results: [{ content: 'The rate is 4.5%.' }] }];
  const figures = 'Inflation is 7.2% now.';
  const onlyMarked = await checkFigures({ answer: figures, messages: read, ask: async () => '{"edits":[{"find":"Inflation is 7.2% now.","replace":"Inflation is 7.2% (unverified) now."}]}' });
  check('a figure the model only marked is marked, not corrected', onlyMarked.fixed === 0 && onlyMarked.marked === 1 && /marked 1 figure\b/.test(onlyMarked.text) && !/corrected/.test(onlyMarked.text), onlyMarked.text);
  const reworded = await checkFigures({ answer: figures, messages: read, ask: async () => '{"edits":[{"find":"Inflation is 7.2% now.","replace":"Now inflation is 7.2%."}]}' });
  check('  one it only moved about is not corrected either, and gets the mark', reworded.fixed === 0 && reworded.marked === 1 && reworded.text.startsWith('Now inflation is 7.2% (unverified).'), reworded.text);
  const corrected = await checkFigures({ answer: figures, messages: read, ask: async () => '{"edits":[{"find":"Inflation is 7.2% now.","replace":"Inflation is 4.5% now."}]}' });
  check('  one changed to a figure that was read is', corrected.fixed === 1 && corrected.marked === 0 && /corrected 1\./.test(corrected.text), corrected.text);
}

section('what the figure check reads, and where its mark goes (QC-010)');
{
  const { figureEvidenceOf, unsourcedFigures, markFigures } = await import('../server/qualityGate.js');
  const none = figureEvidenceOf([], ['nothing here']);
  const marks = (answer, language = 'en') => markFigures(answer, none, language);
  // A check's own line is about the check.
  for (const line of ['*Source check: removed 12 links not found in any source read.*', '*Kiểm tra nguồn: đã bỏ 12 liên kết không có trong nguồn nào đã đọc.*', '*Figure check: marked 15 figures not found in any source read.*', '*Kiểm tra số liệu: đã đánh dấu 15 số liệu không có trong nguồn đã đọc.*']) {
    check(`a check's own note is not read: ${line.slice(1, 24)}…`, marks(line).marked === 0 && marks(line).text === line, marks(line).text);
  }
  // Numbering orders what follows; it says nothing about the world.
  for (const line of ['## 10. Conclusion', '## 1.1 Overview', '### 2) Costs', '**12.** item', '__12.__ item', '10. item', '- 11. item', 'text[^12]', '[^12]: a note', 'see [12]', 'https://en.wikipedia.org/wiki/Foo_(2020)', '[link](https://x.example/a_(2021)_b)']) {
    check(`  nor is numbering or an address: ${line}`, marks(line).marked === 0 && marks(line).text === line, marks(line).text);
  }
  // A figure at the start of a sentence is still a figure.
  check('a figure at the start of a line is still read', marks('2024 was warm.').marked === 1 && marks('12 people came.').marked === 1, marks('12 people came.').text);
  check('  and one inside a heading, past its number', marks('## 2. Growth of 30%').text === '## 2. Growth of 30% (unverified)', marks('## 2. Growth of 30%').text);
  // The mark goes after what is written onto the figure, not between the two.
  check('the mark goes after a unit written onto the figure', marks('giá 15.000đ', 'vi').text === 'giá 15.000đ (chưa kiểm chứng)' && marks('quãng 100km nữa').text === 'quãng 100km (unverified) nữa', marks('giá 15.000đ', 'vi').text);
  check('  and inside emphasis, which still closes', marks('**30%**').text === '**30% (unverified)**', marks('**30%**').text);
  // Marked means this figure, not the sentence.
  check('a mark later in the sentence does not excuse the figures before it', JSON.stringify(unsourcedFigures('Price 500 and growth 30% (unverified).', none)) === '["500"]', JSON.stringify(unsourcedFigures('Price 500 and growth 30% (unverified).', none)));
  check('  while the mark straight after one does', unsourcedFigures('Growth **30%** (chưa kiểm chứng) and 15.000đ (unverified).', none).length === 0, JSON.stringify(unsourcedFigures('Growth **30%** (chưa kiểm chứng) and 15.000đ (unverified).', none)));
  check('  and marking twice over changes nothing', marks(marks('Growth 30% and 500 more.').text).marked === 0, marks('Growth 30% and 500 more.').text);
}

section('the same figure, and only the same figure, counts as found (QC-009)');
{
  const { figureEvidenceOf, unsourcedFigures } = await import('../server/qualityGate.js');
  const flaggedBy = (source, answer) => unsourcedFigures(answer, figureEvidenceOf([], [source])).length > 0;
  // Ten times wrong read as found, while leading zeros were stripped from every number.
  for (const [source, answer] of [['0.5%', 'lãi 0.05%'], ['4.5', 'mức 4.05'], ['2,500', 'giá 2,050,000'], ['$12.50', 'giá 12,050'], ['7.5', 'mức 7.05']]) {
    check(`a page saying ${source} does not vouch for "${answer}"`, flaggedBy(source, answer));
  }
  for (const [source, answer] of [['4.5%', '4,5%'], ['1234567', '1,234,567'], ['1.234.567', '1,234,567'], ['2026-11-03', '03/11/2026'], ['2026-11-03', 'năm 2026'], ['từ 2020–2024', 'giai đoạn 2020-2024'], ['0.05%', '0,05%'], ['08:30', '8:30']]) {
    check(`  while a page saying ${source} does for "${answer}"`, !flaggedBy(source, answer));
  }
  check('a date is its parts together: 15 April 2026 does not vouch for 15/03/2026', flaggedBy('ngày 15 tháng 4 năm 2026', 'ngày 15/03/2026'));

  // QC-015, evaluator pass 2: the digits alone, and sorted dates, passed a hundredfold error and a swapped date.
  for (const [source, answer] of [['$12.50', 'giá $1,250'], ['10,000', 'giá $100.00'], ['45.00', 'phí 4.500'], ['0.5-1.0%', 'lãi 0.05-1.0%'], ['03/11/2026', 'ngày 11/03/2026'], ['2026-11-03', 'ngày 11/03/2026'], ['1.5', 'mức 15.0']]) {
    check(`a page saying ${source} does not vouch for "${answer}" (QC-015)`, flaggedBy(source, answer));
  }
  // QC-018, evaluator pass 3: a date vouched for its month and day, and a time for a decimal.
  for (const [source, answer] of [['ngày 2026-11-03', 'tăng 11%'], ['ngày 12/05/2026', '12 tỷ'], ['10.5%', 'lúc 10:05'], ['3.11%', 'tỉ số 3/11'], ['lúc 10:05', 'tăng 10.5%']]) {
    check(`a page saying ${source} does not vouch for "${answer}" (QC-018)`, flaggedBy(source, answer));
  }
  for (const [source, answer] of [['1234.56', 'giá 1,234.56'], ['1,234.56', 'giá 1234.56'], ['1.234,5', 'giá 1234.50'], ['ngày 2026-11-03', 'năm 2026'], ['2020-2024', 'năm 2020']]) {
    check(`  while a page saying ${source} does for "${answer}" (QC-018)`, !flaggedBy(source, answer));
  }
  for (const [label, text] of [['12___', `12${'_'.repeat(100_000)}`], ['<a<a', '<a'.repeat(50_000)], ['figures', '12 '.repeat(50_000)], ['one long figure', '1,'.repeat(50_000)]]) {
    const started = Date.now();
    unsourcedFigures(text, figureEvidenceOf([], [text]));
    check(`a line of ${label} takes little time (QC-018)`, Date.now() - started < 1500, `${Date.now() - started} ms`);
  }
  for (const [source, answer] of [['4.5%', 'mức 4.50%'], ['100', 'giá 100.00'], ['15,000 - 20,000', 'giá 15,000-20,000'], ['0.5-1.0%', 'lãi 0.5-1.0%'], ['0.5-1.0%', 'từ 0.5% đến 1.0%'], ['4.500', 'giá 4500'], ['2026-11-03', '2026/11/03'], ['3/11/2026', 'ngày 03-11-2026']]) {
    check(`  while a page saying ${source} does for "${answer}"`, !flaggedBy(source, answer));
  }
}

section('only what reached the model is a source (QC-012)');
{
  const step = {
    system: 'Today is 2026-11-04.',
    grounded: [{ id: 'msg-20261104', role: 'user', text: 'How did GDP do?', createdAt: '2025-01-02T03:04:05Z', attachments: [{ id: 'att-777', name: 'report-888.pdf' }] }],
    outgoing: [
      {
        role: 'tool',
        results: [
          { toolCallId: 'call-999', name: 'web_search', content: 'GDP grew 4.5%.' },
          { toolCallId: 'call-555', name: 'show_widget', content: 'Drew "GDP" in the conversation.', widget: { title: 'GDP', markup: '<svg><text>7.2%</text><a>https://made-up.example/own-drawing</a></svg>' } },
        ],
      },
      { role: 'user', parts: [{ type: 'text', text: 'From the file: revenue 36,5' }, { type: 'image', mime: 'image/png', data: 'MTIz' }] },
    ],
  };
  const every = textsIn(step, [], 0, true).join('\n');
  check('what a provider is sent is read: the prompt, the words, results, the text of parts', ['2026-11-04', 'How did GDP do?', 'GDP grew 4.5%.', 'revenue 36,5'].every((s) => every.includes(s)), every);
  check("  a drawing's markup is not, since the model wrote it", !every.includes('7.2%'), every);
  check('  nor ids, dates of no meaning, names or bytes', !/msg-2026|2025-01-02|att-777|report-888|call-999|MTIz/.test(every), every);
  const { figureEvidenceOf, unsourcedFigures } = await import('../server/qualityGate.js');
  check('so a figure it drew does not vouch for the same figure in its answer', unsourcedFigures('GDP grew 7.2%.', figureEvidenceOf([], textsIn(step, [], 0, true))).length === 1);
  check('  and a link in a drawing is no source for the source check', !textsIn(step).join('\n').includes('made-up.example'));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll quality-gate checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
