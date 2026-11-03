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

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll quality-gate checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
