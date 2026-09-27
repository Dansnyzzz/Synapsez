/**
 * The layout of a sent email.
 *
 * What a person receives is the product's face in someone else's inbox, so the
 * checks here are the ones that would embarrass it: markup injected through a
 * message, a remote image or font that triggers "images are hidden" and spam
 * scoring, a heading that lower-cased a proper noun, and a plain-text part
 * full of Markdown punctuation.
 *
 *   node test/mail-template.test.mjs
 */
import {
  composeMessage,
  renderEmailBody,
  plainTextFrom,
  layoutEmail,
  resetMessage,
  detectKind,
  detectLanguage,
  KINDS,
  KIND_NAMES,
} from '../server/mailTemplate.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const markdown = [
  'CHỨNG KHOÁN VIỆT NAM',
  'VN-Index giảm **6,98 điểm** — xem https://nhandan.vn/tin-a/ và [PHS](https://phs.vn).',
  '',
  'Nguồn: https://vietnamfinance.vn',
  '',
  '## Chứng khoán Mỹ',
  '- S&P 500 giảm 0,48%',
  '- Nasdaq giảm `0,56%`',
  '',
  '| Chỉ số | Thay đổi |',
  '|---|---|',
  '| VN-Index | -6,98 |',
  '',
  '> Tổng kết tuần.',
].join('\n');

section('a message is laid out, not dumped');
{
  const body = renderEmailBody(markdown);
  check('a line in capitals is a section heading', /letter-spacing:0\.05em[^>]*>CHỨNG KHOÁN VIỆT NAM<\/td>/.test(body), body.slice(0, 300));
  check('and keeps its capitals, so proper nouns stay right', !body.includes('việt nam'));
  check('## is a section heading', />Chứng khoán Mỹ<\/td>/.test(body));
  check('bold is bold', /<strong[^>]*>6,98 điểm<\/strong>/.test(body));
  check('a bare link reads as its site', /<a href="https:\/\/nhandan\.vn\/tin-a\/"[^>]*>nhandan\.vn\/tin-a<\/a>/.test(body), body.match(/<a[^>]*nhandan[^<]*<\/a>/)?.[0]);
  check('a Markdown link keeps its label', /<a href="https:\/\/phs\.vn"[^>]*>PHS<\/a>/.test(body));
  check('a sources line is set small and quiet', /font-size:12\.5px[^>]*>Nguồn:/.test(body));
  check('bullets are a list', (body.match(/<li /g) || []).length === 2 && body.includes('S&amp;P 500'));
  check('inline code is code', /<code[^>]*>0,56%<\/code>/.test(body));
  check('a table is a table', body.includes('>VN-Index</td>') && body.includes('>Thay đổi</td>'));
  check('a quote is a callout', /border-left:3px solid[^>]*>Tổng kết tuần\.<\/div>/.test(body));
}

section('nothing in a message can become markup or a script');
{
  const body = renderEmailBody('Hi <img src=x onerror=alert(1)> **<script>x</script>** [click](javascript:alert(1)) `<b>`');
  check('tags are escaped', !/<img|<script|<b>/.test(body), body);
  check('a javascript: link is not a link', !/href="javascript/i.test(body));
  const quoted = renderEmailBody('[a](https://x.example/"onmouseover="alert(1))');
  check('a quote cannot break out of an href', !/"onmouseover=/.test(quoted), quoted);
  const title = layoutEmail({ brand: 'Synapse', title: '<b>Subject</b>', contentHtml: '' });
  check('the subject is escaped as the title', title.includes('&lt;b&gt;Subject&lt;/b&gt;') && !title.includes('<b>Subject'));
}

section('the email loads nothing from anywhere');
{
  const { html } = composeMessage({ brand: 'Synapse', subject: 'S', markdown, sender: { name: 'Lan', email: 'lan@example.com' }, language: 'vi' });
  const sources = [...html.matchAll(/\ssrc="([^"]*)"/gi)].map((m) => m[1]);
  check('the only image is the embedded logo', sources.length > 0 && sources.every((src) => src === 'cid:brand-logo@mail'), sources.join(' '));
  check('no stylesheets, fonts or scripts', !/<link|<script|@import|url\(/i.test(html));
  const plain = layoutEmail({ brand: 'Synapse', title: 'T', contentHtml: '', logo: false });
  check('without the logo file the mark is a letter, not a broken image', !/<img/i.test(plain) && />S<\/td>/.test(plain));
  check('600px wide at most', html.includes('max-width:600px'));
  check('with a hidden preview line that skips the heading', /display:none;max-height:0[^>]*>VN-Index giảm 6,98 điểm/.test(html), html.match(/mso-hide:all">[^<]*/)?.[0]);
}

section('the footer and date speak the message language');
{
  const now = new Date('2026-09-15T05:00:00Z');
  const vi = composeMessage({ brand: 'Synapse', subject: 'Bản tin sáng', markdown: 'x', sender: { name: 'Lan', email: 'lan@example.com' }, language: 'vi', now });
  check('Vietnamese footer', vi.html.includes('Người gửi <strong') && vi.html.includes('Trả lời email này'));
  check('the sender is named but their address is never shown', !vi.html.includes('lan@example.com') && !vi.text.includes('lan@example.com') && !vi.html.includes('mailto:'));
  check('Vietnamese date', /15 tháng 9, 2026/i.test(vi.html), vi.html.match(/THỨ|Thứ[^<]*/)?.[0]);
  const en = composeMessage({ brand: 'Elite Business', subject: 'S', markdown: 'x', sender: { name: 'Lan' }, language: 'en', now });
  check('English footer', en.html.includes('Sent by <strong') && en.text.includes('Sent by Lan · Elite Business.'), en.text);
  const nobody = composeMessage({ brand: 'Elite Business', subject: 'S', markdown: 'x', sender: null, language: 'en' });
  check('no sender, no sender line — only the reply hint', !nobody.html.includes('Sent by') && nobody.html.includes('Reply to this email'));
  check('the brand is the business, with no product tagline under it', !/workspace|Không gian làm việc/i.test(nobody.html) && nobody.html.includes('Elite Business'));
}

section('every kind of email is dressed for what it is');
{
  const now = new Date('2026-09-15T05:00:00Z');
  const compose = (kind) => composeMessage({ brand: 'Synapse', subject: 'Subject', markdown: 'Hello there, this is the message body.', kind, now });
  for (const name of KIND_NAMES.filter((n) => n !== 'security')) {
    const kind = KINDS[name];
    const { html, kind: used } = compose(name);
    const galaxy = /#c026d3|#d946ef/.test(html);
    const ok =
      used === name &&
      galaxy &&
      (kind.shape === 'card'
        ? html.includes('class="sx-hero') && html.includes('linear-gradient(135deg,#0f0c29') && html.includes(`>${kind.label.en}</span>`)
        : !html.includes('class="sx-hero') && html.includes('linear-gradient(90deg'));
    check(`${name}: ${kind.shape === 'card' ? 'a galaxy header, labelled' : 'a quiet letter with a galaxy line'}`, ok, used);
  }
  check('an unknown kind is inferred instead', compose('nonsense').kind === 'letter');
  check('only dated kinds show the date', /15 September 2026/.test(compose('report').html) && !/2026/.test(compose('invoice').html.replace(/<title>[^<]*<\/title>/, '')));
}

section('the kind is inferred from what was asked for');
{
  const cases = [
    ['Hoá đơn tháng 9', 'Kính gửi anh', 'invoice'],
    ['Bản tin tài chính sáng', 'CHỨNG KHOÁN VIỆT NAM\nĐã thanh toán cổ tức', 'newsletter'],
    ['Thư mời dự tiệc tất niên', 'Thời gian: 18:00', 'invitation'],
    ['Cảm ơn anh', 'Em cảm ơn anh đã hỗ trợ', 'thank_you'],
    ['Báo giá dịch vụ SEO', 'Kính gửi quý khách', 'quotation'],
    ['Biên bản họp 15/9', '- [ ] Việc', 'meeting'],
    ['[Khẩn] Sự cố máy chủ', 'Máy chủ gián đoạn', 'alert'],
    ['Xác nhận đặt lịch', 'Thời gian: 9:00', 'confirmation'],
    ['Nhắc hạn chót nộp báo cáo', 'Hạn chót: 20/9', 'reminder'],
    ['Chào mừng bạn', 'Bắt đầu thôi', 'welcome'],
    ['Invoice #1042', 'Amount due: $120', 'invoice'],
    ['You are invited: product launch', 'Date: Friday', 'invitation'],
  ];
  for (const [subject, body, want] of cases) {
    const got = detectKind(subject, body);
    check(`"${subject}" → ${want}`, got === want, got);
  }
  check('a word inside a longer word does not count ("prevent" is not an event)', detectKind('Quick note', 'Please prevent this in 5 minutes.') === 'letter');
  check('one passing mention in the body does not decide', detectKind('Hi', 'I will send the report later.') === 'letter');
  check('a structured message with no signal is a newsletter', detectKind('Weekly update', '## A\n- x\n- y\n- z') === 'newsletter');
  check('the system security kind is never inferred', detectKind('Reset your password', 'verification code') !== 'security');
}

section('the shapes documents are made of');
{
  const theme = KINDS.invoice;
  const facts = renderEmailBody('Số hoá đơn: INV-1\n**Hạn thanh toán:** 30/09\nTổng tiền: 20.500.000đ', theme);
  check('Label: value lines become a details card', facts.includes('class="sx-facts"') && />Hạn thanh toán<\/td>/.test(facts) && />30\/09<\/td>/.test(facts), facts.slice(0, 200));
  check('a sentence with a colon is not a fact', !renderEmailBody('Lưu ý quan trọng cho mọi người trong nhóm: hãy đọc kỹ.\nCảm ơn.', theme).includes('sx-facts'));
  const one = renderEmailBody('Thời gian: 9:00', theme);
  check('a single fact stays a sentence', !one.includes('sx-facts'));

  const table = renderEmailBody('| Hạng mục | Tiền |\n|---|---|\n| A | 1 |\n| Tổng cộng | 1 |', theme);
  check('the total row is highlighted', /class="sx-total"[^>]*border-top:2px solid #3730a3[^>]*>Tổng cộng/.test(table), table.slice(-300));

  const checklist = renderEmailBody('- [x] Gửi báo cáo\n- [ ] Chốt kịch bản', theme);
  check('a checklist shows done and open items', checklist.includes('☑') && checklist.includes('☐') && checklist.includes('text-decoration:line-through'));
  check('and is not also a bullet list', !checklist.includes('<ul'));

  const btn = renderEmailBody('[Thanh toán ngay](https://pay.example.com/x?a=1&b=2)', theme);
  check('a lone link is a galaxy button', /linear-gradient\(135deg,#4f46e5[^>]*><a class="sx-btn" href="https:\/\/pay\.example\.com\/x\?a=1&amp;b=2"/.test(btn), btn);

  const moves = renderEmailBody('| Kênh | Thay đổi |\n|---|---|\n| FB | +12% |\n| GG | -4% |', theme);
  check('rises and falls are coloured', /class="sx-up"[^>]*color:#0e8f63[^>]*>\+12%/.test(moves) && /class="[^"]*sx-down[^"]*"[^>]*color:#d23f3f[^>]*>-4%/.test(moves));
}

section('language and repetition');
{
  check('Vietnamese is recognised from the body', detectLanguage('Chào anh, em gửi tài liệu') === 'vi');
  check('an English body is English whatever the account says', detectLanguage('Hello Minh, please find the file attached.', 'vi') === 'en');
  check('a body too short to tell uses the account language', detectLanguage('OK', 'vi') === 'vi');
  const repeated = composeMessage({ brand: 'Synapse', subject: 'Bản tin tài chính sáng', markdown: '# Bản tin tài chính sáng\nNội dung chính của bản tin hôm nay.' });
  check('a first line that repeats the subject is dropped', (repeated.html.match(/Bản tin tài chính sáng/g) || []).length === 2, String((repeated.html.match(/Bản tin tài chính sáng/g) || []).length));
  const zone = composeMessage({ brand: 'Synapse', subject: 'Báo cáo', markdown: 'x', kind: 'report', language: 'vi', timeZone: 'Asia/Ho_Chi_Minh', now: new Date('2026-09-14T20:00:00Z') });
  check("a dated card reads the date in the account's zone", /15 THÁNG 9|15 tháng 9/i.test(zone.html), zone.html.match(/sx-date[^>]*>[^<]*/)?.[0]);
  const html = composeMessage({ brand: 'Synapse', subject: 'S', markdown: 'x', kind: 'report' }).html;
  check('dark mode and phone spacing are declared', html.includes('prefers-color-scheme:dark') && html.includes('max-width:520px') && html.includes('content="light dark"'));
}

section('the galaxy look survives a client that drops gradients');
{
  const html = composeMessage({ brand: 'Synapse', subject: 'Hoá đơn', markdown: '[Thanh toán](https://pay.example.com)\n\n## Mục', kind: 'invoice' }).html;
  const gradients = [...html.matchAll(/background-image:linear-gradient/g)].length;
  const withSolid = [...html.matchAll(/background-color:#[0-9a-f]{6};background-image:linear-gradient/g)].length;
  check('every gradient has a solid colour before it', gradients > 0 && gradients === withSolid, `${withSolid}/${gradients}`);
  check('the header text is white on a dark solid fallback', /background-color:#2e1065;background-image:linear-gradient\(135deg/.test(html) && /class="sx-h1"[^>]*color:#ffffff/.test(html));
  check('no green is left from the old look', !/#0e8f63[^;]*;[^"]*sx-btn|background:#0e8f63/.test(html));
}

section('the logo emails embed is the web logo, sized for mail');
{
  const fs = await import('node:fs');
  const file = new URL('../server/assets/email-logo.png', import.meta.url);
  const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  const isPng = bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47;
  check('server/assets/email-logo.png is a PNG — run scripts/email-logo.js if not', isPng);
  check('96px square, sharp at 48px on a 2x screen', isPng && bytes.readUInt32BE(16) === 96 && bytes.readUInt32BE(20) === 96);
  check('and small enough not to weigh the message down', bytes.length > 0 && bytes.length < 24_000, `${bytes.length} bytes`);
}

section('the plain-text part reads as plain text');
{
  const text = plainTextFrom('## Heading\n**bold** and `code` and [PHS](https://phs.vn)\n\n\n\nend');
  check('headings become capitals', text.startsWith('HEADING'), text);
  check('marks are removed', !/\*\*|`|\[|\]\(/.test(text), text);
  check('links are spelled out', text.includes('PHS (https://phs.vn)'));
  check('runs of blank lines collapse', !text.includes('\n\n\n'));
}

section('the reset email shares the layout');
{
  const html = resetMessage({ brand: 'Synapse', code: '482913', link: 'https://app.example/r?t=a&b=c' });
  check('the code is shown large', /font-size:34px[^>]*>482913</.test(html));
  check('the link is escaped into the button', html.includes('href="https://app.example/r?t=a&amp;b=c"'));
  check('and nothing is loaded but the embedded logo', !/<link|<script/i.test(html) && [...html.matchAll(/\ssrc="([^"]*)"/g)].every((m) => m[1] === 'cid:brand-logo@mail'));
}

section('a sources line cites the article, not the front page');
{
  /*
   * The whole purpose of citing a source is being able to go and read the thing
   * a claim came from. A link that lands on a newspaper's front page has cited
   * nothing — so the outlet name is the *label* and the article is the href.
   */
  const md = [
    'VN-Index giam 6,98 diem.',
    '',
    'Nguồn: https://nhandan.vn/kinh-te/vn-index-giam-abc-123.html https://dnse.com.vn/tin-tuc/phien-xyz',
    '',
    'Doc them tai https://phs.vn/bao-cao/quy-3.html trong bai.',
  ].join('\n');

  const html = String(composeMessage({ subject: 'Test', markdown: md, language: 'vi' }).html);
  const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({ href: m[1], label: m[2] }));

  const sources = links.filter((l) => /nhandan|dnse/.test(l.href));
  check('each source is labelled with its outlet alone', sources.map((l) => l.label).join(',') === 'nhandan.vn,dnse.com.vn', sources.map((l) => l.label).join(','));
  check('and points at the article itself', sources.every((l) => l.href.split('/').length > 3), sources.map((l) => l.href).join(' '));

  // Outside a sources line the path stays: a link in the middle of a sentence
  // is usually the point of the sentence, and two articles from one site would
  // otherwise look like the same link.
  const inBody = links.find((l) => /phs\.vn/.test(l.href));
  check('a link in prose keeps its path', inBody?.label === 'phs.vn/bao-cao/quy-3.html', inBody?.label);
}

section('a briefing section is one card, sources included');
{
  const html = renderEmailBody(
    [
      '## Chứng khoán Việt Nam',
      'VN-Index: Phiên 14/9 giảm 6,98 điểm xuống 1.788,23 điểm, thanh khoản cao cho thấy áp lực cung vẫn còn.',
      'Khối ngoại: Mua ròng 812 tỷ',
      'Nguồn: https://nhandan.vn/a.html, https://dnse.com.vn/b.html',
    ].join('\n'),
    KINDS.newsletter,
  );
  const card = html.slice(html.indexOf('sx-facts'), html.indexOf('</table>', html.indexOf('sx-facts')));
  check('the Sources line is the card\'s last row, not a line under it', /Nguồn/.test(card) && /nhandan\.vn/.test(card), card.slice(-200));
  check('a sentence-long value is not set in bold', /font-weight:400[^>]*>Phiên 14\/9/.test(card));
  check('a short figure still is', /font-weight:600[^>]*>Mua ròng 812 tỷ/.test(card));
}

section('the header stays readable in Gmail\'s dark mode');
{
  const html = layoutEmail({ brand: 'Synapse', title: 'Bản tin tài chính sáng', contentHtml: '<p>x</p>', kind: 'newsletter', logo: false });
  check('the title is wrapped to survive colour inversion', /<h1[^>]*><span class="gx-s"><span class="gx-d">Bản tin tài chính sáng/.test(html));
  check('the rules for it are scoped to Gmail', /u \+ \.body \.gx-d\{background:#000;mix-blend-mode:difference\}/.test(html));
  check('and the body carries the class that scoping needs', /<body class="sx-page body"/.test(html));
}

console.log(failures === 0 ? '\n\x1b[32mAll mail template checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
