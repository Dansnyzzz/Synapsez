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
  check('one flagged address left after a round gets another round, up to the limit', rounds === 2 && both.fixed === 2 && both.removed === 0 && both.text.startsWith('A x (unverified). B y (unverified).'), `${rounds} rounds · ${both.text}`);
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
