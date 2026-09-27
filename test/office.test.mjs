/**
 * Documents: reading them, writing them, and the road between the two.
 *
 * The failure this suite exists to prevent is a file that looks fine from here
 * and will not open on somebody's machine — so almost everything below is a
 * round trip. A document is written, read back by the same code that reads a
 * stranger's upload, and checked word by word: if the writer emits something
 * malformed, the reader finds nothing, and the test says so.
 *
 * That is not the same as opening it in Word, which no test can do. What it does
 * cover is the whole path this application controls: the ZIP, the XML, the
 * relationships between parts, the text, and every route and tool on top.
 *
 *   node test/office.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'office-test-encryption-key';
process.env.SESSION_SECRET ||= 'office-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-office-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const PORT = 5209;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
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

const { openZip, writeZip, crc32, looksLikeZip } = await import('../server/office/zip.js');
const { parseXml, element, elements, descendants, attr, textOf, escapeXml, relationshipId, decodeXml } =
  await import('../server/office/xml.js');
const { markdownToBlocks, parseInline, markdownTitle } = await import('../server/office/markdown.js');
const { blocksToText, blocksToHtml, normaliseBlocks } = await import('../server/office/blocks.js');
const { writeDocx, readDocx } = await import('../server/office/docx.js');
const { writeXlsx, readXlsx, columnName, columnIndex } = await import('../server/office/xlsx.js');
const { writePptx, readPptx } = await import('../server/office/pptx.js');
const office = await import('../server/office/index.js');

// ── the envelope ────────────────────────────────────────────────────
section('ZIP, which is what an Office document actually is');
{
  const parts = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    // Long and repetitive, so it compresses; the short one above will not.
    { name: 'word/document.xml', data: 'x'.repeat(5000) },
    { name: 'docProps/core.xml', data: 'Tiếng Việt có dấu' },
  ];
  const archive = writeZip(parts);

  check('what comes out looks like a ZIP', looksLikeZip(archive));
  const zip = openZip(archive);
  check('every part is listed', zip.names.length === 3, zip.names.join(', '));
  check('the content types come first', zip.names[0] === '[Content_Types].xml', zip.names[0]);
  check('a compressed part reads back exactly', zip.text('word/document.xml') === 'x'.repeat(5000));
  check('and so does a stored one', zip.text('docProps/core.xml') === 'Tiếng Việt có dấu');
  check(
    'compression actually happened',
    archive.length < 5000,
    `${archive.length} bytes for 5KB of repeated text`,
  );
  check('asking for a part that is not there fails by name', (() => {
    try {
      zip.read('word/nope.xml');
      return false;
    } catch (err) {
      return /nope\.xml/.test(err.message);
    }
  })());

  check('CRC-32 matches the known value for "123456789"', crc32(Buffer.from('123456789')) === 0xcbf43926);

  let error = null;
  try {
    openZip(Buffer.from('this is not a zip file at all'));
  } catch (err) {
    error = err;
  }
  check('something that is not a ZIP is refused as itself', error?.code === 'not_zip', error?.message);

  // Truncation has to be caught: half a document is not a shorter document.
  let truncated = null;
  try {
    openZip(archive.subarray(0, archive.length - 40));
  } catch (err) {
    truncated = err;
  }
  check('a truncated archive is refused', !!truncated, truncated?.message);
}

// ── the XML ─────────────────────────────────────────────────────────
section('the XML reader');
{
  const doc = parseXml(
    '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<w:document xmlns:w="urn:w"><!-- a comment --><w:body>' +
      '<w:p w:rsid="00A"><w:r><w:t xml:space="preserve"> Xin chào </w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>&amp;lt; &lt; &#65; &#x42; &xxe;</w:t></w:r><w:br/></w:p>' +
      '<w:tbl><w:tr><w:tc><![CDATA[raw <not> markup]]></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>',
  );

  check('the root is found', doc?.name === 'w:document', doc?.name);
  const body = element(doc, 'body');
  check('an element is found by its local name', !!body);
  check('children are counted correctly', elements(body, 'p').length === 2, String(elements(body, 'p').length));
  check('an attribute is found by local name', attr(elements(body, 'p')[0], 'rsid') === '00A');

  const texts = [...descendants(body, 't')].map(textOf);
  check('preserved whitespace survives', texts[0] === ' Xin chào ', JSON.stringify(texts[0]));
  check('entities are decoded', texts[1].startsWith('&lt; < A B'), texts[1]);
  check(
    'a declared external entity is NOT resolved',
    texts[1].includes('&xxe;'),
    'no file on this machine is reachable through a document',
  );
  check('CDATA is kept raw', textOf(element(element(element(body, 'tbl'), 'tr'), 'tc')) === 'raw <not> markup');
  check('a comment leaves nothing behind', !textOf(body).includes('a comment'));

  const sldId = parseXml('<p:sldId id="256" r:id="rId2"/>');
  check('a relationship id is not confused with an element id', relationshipId(sldId) === 'rId2', relationshipId(sldId));

  check('escaping covers all five', escapeXml(`<a & "b" 'c'>`) === '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  check('a control character is dropped rather than written', escapeXml('a\u000bb') === 'ab');
  check('a lone surrogate reference is left alone', decodeXml('&#xD800;') === '&#xD800;');
}

// ── Markdown ────────────────────────────────────────────────────────
section('Markdown, which is how every document is written');
{
  const runs = parseInline('a **bold** and *italic* and `code *not italic*` and [link](https://x.test) and \\*literal\\*');
  const find = (text) => runs.find((run) => run.text === text);
  check('bold is bold', find('bold')?.bold === true);
  check('italic is italic', find('italic')?.italic === true);
  check('code is code', find('code *not italic*')?.code === true);
  check('and asterisks inside code are not emphasis', !find('code *not italic*')?.italic);
  check('a link keeps its target', find('link')?.link === 'https://x.test');
  check('a backslash escapes an asterisk', runs.some((run) => run.text.includes('*literal*')));
  check('snake_case is not italics', parseInline('a snake_case_name here').length === 1);

  const blocks = markdownToBlocks(
    [
      '# Tiêu đề',
      '',
      'Một đoạn văn.',
      '',
      '## Danh sách',
      '- một',
      '- hai',
      '  - hai rưỡi',
      '',
      '1. bước một',
      '2. bước hai',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '> trích dẫn',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '---',
    ].join('\n'),
  );

  const kinds = blocks.map((block) => block.type);
  check('every kind of block is recognised', kinds.join(',') === 'heading,paragraph,heading,list,list,table,quote,code,divider', kinds.join(','));
  check('a nested bullet keeps its depth', blocks[3].items[2].level === 1, String(blocks[3].items[2].level));
  check('a numbered list is ordered', blocks[4].ordered === true);
  check('a bulleted list is not', blocks[3].ordered === false);
  check('a table has a header row', blocks[5].header === true && blocks[5].rows.length === 2);
  check('a fence keeps its language', blocks[7].language === 'js', blocks[7].language);
  check('and its contents verbatim', blocks[7].text === 'const x = 1;', blocks[7].text);
  check('the title comes off the first heading', markdownTitle('# Tiêu đề\n\nmore') === 'Tiêu đề');

  // The middle of the system: text out, HTML out, both from the same blocks.
  const html = blocksToHtml(blocks);
  check('HTML nests a sublist inside its item', /<li>hai<ul><li>hai rưỡi<\/li><\/ul><\/li>/.test(html), html.slice(0, 200));
  check('HTML escapes what it renders', !blocksToHtml([{ type: 'paragraph', text: '<script>x</script>' }]).includes('<script>'));
  check('a javascript: link is not made into one', !blocksToHtml([{ type: 'paragraph', runs: [{ text: 'x', link: 'javascript:alert(1)' }] }]).includes('href'));
  check('text output writes a Markdown table back out', /\|\s*A\s*\|\s*B\s*\|/.test(blocksToText(blocks)));
  check('a malformed block does not crash the normaliser', normaliseBlocks([null, 'plain', { type: 'nonsense' }]).length === 1);
}

// ── Word ────────────────────────────────────────────────────────────
section('Word: written, then read back by the same code that reads an upload');
{
  const source = [
    '# Hợp đồng số 12/2026',
    '',
    'Bên A **đồng ý** thanh toán *trong vòng* 30 ngày. Xem [phụ lục](https://example.com/pl).',
    '',
    '## Điều khoản',
    '- Giao hàng tại kho Bình Dương',
    '- Bảo hành 12 tháng',
    '  - Không gồm hao mòn',
    '',
    '1. Ký hợp đồng',
    '2. Tạm ứng 30%',
    '',
    '| Hạng mục | Số lượng |',
    '| --- | --- |',
    '| Ống thép | 120 |',
    '',
    '> Ghi chú cuối trang.',
  ].join('\n');

  const buffer = writeDocx({ blocks: markdownToBlocks(source), title: 'Hợp đồng' });
  const back = readDocx(buffer);
  const text = back.text;

  check('the heading survives as a heading', /^# Hợp đồng số 12\/2026/m.test(text), text.slice(0, 40));
  check('Vietnamese diacritics survive the round trip', text.includes('Bình Dương'));
  check('bold is still bold', back.blocks[1].runs.some((run) => run.text === 'đồng ý' && run.bold));
  check('italic is still italic', back.blocks[1].runs.some((run) => run.text === 'trong vòng' && run.italic));
  check(
    'a hyperlink keeps its target through the relationship table',
    back.blocks[1].runs.some((run) => run.link === 'https://example.com/pl'),
    JSON.stringify(back.blocks[1].runs.map((run) => run.link).filter(Boolean)),
  );

  const lists = back.blocks.filter((block) => block.type === 'list');
  check('both lists come back', lists.length === 2, String(lists.length));
  check('the bulleted one is bulleted', lists[0].ordered === false);
  check('the numbered one is numbered', lists[1].ordered === true, 'read from numbering.xml, not guessed');
  check('a nested item keeps its level', lists[0].items[2].level === 1, String(lists[0].items[2].level));

  const table = back.blocks.find((block) => block.type === 'table');
  check('the table comes back with its rows', table?.rows.length === 2, String(table?.rows.length));
  check('and its header row is marked', table?.header === true);
  check('a quote is still a quote', back.blocks.some((block) => block.type === 'quote'));
  check('the word count is counted', back.meta.words > 20, String(back.meta.words));

  // The package itself has to be shaped the way Word expects, or none of the
  // above matters on somebody else's machine.
  const zip = openZip(buffer);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'docProps/core.xml', 'docProps/app.xml']) {
    check(`the package has ${part}`, zip.has(part));
  }
  check('every part is well-formed XML', zip.names.every((name) => !!parseXml(zip.text(name))));
  check(
    'the content types name every part that needs one',
    ['/word/document.xml', '/word/styles.xml', '/word/numbering.xml'].every((part) =>
      zip.text('[Content_Types].xml').includes(`PartName="${part}"`),
    ),
  );
  check(
    'the body ends with a section, which is what gives it a page size',
    /<w:sectPr>[\s\S]*<\/w:sectPr><\/w:body>/.test(zip.text('word/document.xml')),
  );

  /**
   * The schema is a *sequence*, and Word enforces it by offering to repair the
   * file rather than by rendering it differently — so the order of run and
   * paragraph properties is a correctness property, not a style one.
   */
  const awkward = openZip(
    writeDocx({
      blocks: [
        {
          type: 'paragraph',
          runs: [
            { text: 'both', strike: true, underline: true, bold: true, italic: true },
            { text: 'link and code', link: 'https://x.test', code: true },
          ],
        },
      ],
    }),
  ).text('word/document.xml');

  check('run properties are written in schema order', /<w:b\/><w:i\/><w:strike\/><w:u /.test(awkward), awkward.match(/<w:rPr>.*?<\/w:rPr>/)?.[0]);
  check(
    'a run that is both a link and code has only one rStyle',
    (awkward.match(/<w:rPr><w:rStyle[^>]*\/><w:rStyle/g) || []).length === 0,
    'two would be invalid; the link wins and the font carries the code',
  );
  const styles = openZip(writeDocx({ blocks: [{ type: 'quote', runs: [{ text: 'x' }] }] })).text('word/styles.xml');
  check(
    'and so are the paragraph properties of the stylesheet',
    /<w:pPr><w:pBdr>[\s\S]*?<\/w:pBdr><w:spacing[^>]*\/><w:ind /.test(styles),
    'pBdr, then spacing, then ind',
  );
}

// ── Excel ───────────────────────────────────────────────────────────
section('Excel: values that are still values');
{
  check('column letters count past Z', columnName(0) === 'A' && columnName(26) === 'AA' && columnName(701) === 'ZZ');
  check('and read back', columnIndex('A1') === 0 && columnIndex('AA10') === 26 && columnIndex('ZZ1') === 701);

  const when = new Date(Date.UTC(2026, 7, 15));
  const buffer = writeXlsx({
    sheets: [
      {
        name: 'Báo giá',
        rows: [
          ['Mặt hàng', 'Số lượng', 'Đơn giá', 'Ngày giao', 'Còn hàng'],
          ['Ống thép Ø60', 120, 1500000, when, true],
          ['Mã 0123', '0123', 90000.5, null, false],
        ],
      },
      { name: 'Ghi chú', rows: [['Một dòng']] },
      // Illegal characters and an over-long name: Excel refuses the whole file
      // rather than fixing either, so they are fixed here.
      { name: 'A/B*C?D[E]F:G that is far too long to be a sheet name', rows: [['x']] },
    ],
  });

  const back = readXlsx(buffer);
  check('every sheet comes back', back.sheets.length === 3, String(back.sheets.length));
  check('in order, by name', back.sheets[0].name === 'Báo giá' && back.sheets[1].name === 'Ghi chú');
  check('an illegal sheet name is cleaned', !/[\\/?*[\]:]/.test(back.sheets[2].name), back.sheets[2].name);
  check('and truncated to what Excel accepts', back.sheets[2].name.length <= 31, `${back.sheets[2].name.length} chars`);

  const rows = back.sheets[0].rows;
  check('text is text', rows[0][0].t === 's' && rows[0][0].v === 'Mặt hàng');
  check('a number is a number, not a label', rows[1][1].t === 'n' && rows[1][1].v === '120');
  check('a decimal keeps its fraction', rows[2][2].v === '90000.5', rows[2][2].v);
  check('a date is a date', rows[1][3].t === 'd' && rows[1][3].v === '2026-08-15', rows[1][3].v);
  check('a boolean is a boolean', rows[1][4].t === 'b' && rows[1][4].v === 'TRUE');
  check('and FALSE is not dropped as empty', rows[2][4].t === 'b' && rows[2][4].v === 'FALSE');
  check(
    'a leading-zero code stays text',
    rows[2][1].t === 's' && rows[2][1].v === '0123',
    'a part number is not a quantity',
  );
  check('the text form is a Markdown table', back.text.includes('| Ống thép Ø60 | 120 |'), back.text.split('\n')[2]);

  const zip = openZip(buffer);
  check('the workbook has a styles part', zip.has('xl/styles.xml'));
  check('and a shared string table', zip.has('xl/sharedStrings.xml'));
  check('every part is well-formed XML', zip.names.every((name) => !!parseXml(zip.text(name))));
  check(
    'the header row is frozen so it stays visible',
    zip.text('xl/worksheets/sheet1.xml').includes('state="frozen"'),
  );
  check('and filterable', zip.text('xl/worksheets/sheet1.xml').includes('<autoFilter'));
}

// ── PowerPoint ──────────────────────────────────────────────────────
section('PowerPoint: the fussiest package of the three');
{
  const buffer = writePptx({
    title: 'Kế hoạch Q4',
    slides: [
      { title: 'Kế hoạch Q4 năm 2026' },
      {
        title: 'Mục tiêu',
        bullets: [
          { level: 0, text: 'Tăng doanh thu 20%' },
          { level: 1, text: 'Mở rộng miền Trung' },
        ],
        notes: 'Nhấn mạnh con số 20%.\nDòng thứ hai.',
      },
      { title: 'Rủi ro', bullets: ['Tỷ giá', 'Nguồn cung'] },
    ],
  });

  const back = readPptx(buffer);
  check('every slide comes back', back.slides.length === 3, String(back.slides.length));
  check('in the deck order, not the file order', back.slides.map((s) => s.title).join('|') === 'Kế hoạch Q4 năm 2026|Mục tiêu|Rủi ro');
  check('bullets survive', back.slides[1].bullets.length === 2);
  check('with their indent level', back.slides[1].bullets[1].level === 1, String(back.slides[1].bullets[1].level));
  check('speaker notes survive', back.slides[1].notes.includes('Nhấn mạnh con số 20%'));
  check('and their second line', back.slides[1].notes.includes('Dòng thứ hai'));
  check('a title-only slide has no stray bullets', back.slides[0].bullets.length === 0);
  check('the text form reads as an outline', /## Slide 2: Mục tiêu/.test(back.text));

  const zip = openZip(buffer);
  for (const part of [
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml',
    'ppt/slides/_rels/slide1.xml.rels',
    'ppt/notesMasters/notesMaster1.xml',
  ]) {
    check(`the package has ${part}`, zip.has(part));
  }
  check('every part is well-formed XML', zip.names.every((name) => !!parseXml(zip.text(name))));

  // PowerPoint refuses a deck whose parts are not all declared, and refuses one
  // whose theme is incomplete. Both are silent until somebody double-clicks.
  const types = zip.text('[Content_Types].xml');
  check(
    'every slide is declared in the content types',
    [1, 2, 3].every((n) => types.includes(`/ppt/slides/slide${n}.xml`)),
  );
  check('the notes master is declared too', types.includes('/ppt/notesMasters/notesMaster1.xml'));
  const theme = zip.text('ppt/theme/theme1.xml');
  check('the theme has all twelve scheme colours', (theme.match(/<a:(dk|lt|accent|hlink|folHlink)/g) || []).length >= 12);
  check('and three of each format style', (theme.match(/<a:effectStyle>/g) || []).length === 3);

  // A deck with no notes must not carry the notes machinery at all.
  const plain = openZip(writePptx({ slides: [{ title: 'One', bullets: ['a'] }] }));
  check('a deck without notes has no notes master', !plain.has('ppt/notesMasters/notesMaster1.xml'));
  check('and no second theme either', !plain.has('ppt/theme/theme2.xml'));

  /**
   * The three defects that made PowerPoint — and only PowerPoint — refuse every
   * deck this wrote. Each was invisible to Word, Excel, this project's own
   * reader, and every other tool tried; each was found by opening the file with
   * PowerPoint itself through COM automation and bisecting against a real deck.
   *
   * They are pinned here because all three are the kind of thing a tidy-up
   * would happily undo.
   */
  check(
    'the notes master has a theme of its own',
    /theme2\.xml/.test(zip.text('ppt/notesMasters/_rels/notesMaster1.xml.rels')),
    'a theme part belongs to exactly one master; sharing theme1 refuses to open',
  );
  check('which is a real part, declared', zip.has('ppt/theme/theme2.xml') && types.includes('/ppt/theme/theme2.xml'));

  for (const part of ['ppt/presProps.xml', 'ppt/viewProps.xml', 'ppt/tableStyles.xml']) {
    check(`the package carries ${part.split('/').pop()}`, zip.has(part), 'PowerPoint requires it even though it holds nothing');
    check('  and declares its content type', types.includes(`/${part}`));
  }

  const appProps = zip.text('docProps/app.xml');
  check(
    'the properties are in schema order',
    appProps.indexOf('<Slides>') < appProps.indexOf('<ScaleCrop>') &&
      appProps.indexOf('<ScaleCrop>') < appProps.indexOf('<Application>') &&
      appProps.indexOf('<Application>') < appProps.indexOf('<DocSecurity>'),
    'CT_Properties is a sequence, and PowerPoint enforces it',
  );
  const coreProps = zip.text('docProps/core.xml');
  check(
    'and so are the core ones',
    coreProps.indexOf('dcterms:created') < coreProps.indexOf('dc:creator') &&
      coreProps.indexOf('dc:creator') < coreProps.indexOf('cp:lastModifiedBy') &&
      coreProps.indexOf('cp:lastModifiedBy') < coreProps.indexOf('dcterms:modified') &&
      coreProps.indexOf('dcterms:modified') < coreProps.indexOf('dc:title'),
    'created, creator, lastModifiedBy, modified, title',
  );

  check(
    'a slide placeholder matches one the layout actually has',
    /<p:ph idx="1"\/>/.test(zip.text('ppt/slides/slide2.xml')) &&
      /<p:ph idx="1"\/>/.test(zip.text('ppt/slideLayouts/slideLayout1.xml')),
    'a placeholder that resolves to nothing is a repair prompt',
  );
  check(
    'and the master has the placeholders the layout inherits from',
    /<p:ph type="title"\/>/.test(zip.text('ppt/slideMasters/slideMaster1.xml')),
  );
}

// ── the front door ──────────────────────────────────────────────────
section('creating a file in each format');
{
  const markdown = '# Báo cáo\n\nMột đoạn.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';

  for (const format of office.CREATABLE) {
    const content = format === 'json' ? '{"a":1}' : markdown;
    const file = office.createDocument({ format, name: 'Báo cáo tháng 8', content });
    check(
      `${format} comes out named and non-empty`,
      file.name === `Báo cáo tháng 8.${format}` && file.buffer.length > 0,
      `${file.name}, ${file.buffer.length} bytes`,
    );
    check(`${format} keeps the source it was built from`, file.source === content);
  }

  const csv = office.createDocument({ format: 'csv', name: 'x', content: markdown });
  check('a CSV takes the table rather than the prose above it', csv.buffer.toString('utf8').includes('A,B'), csv.buffer.toString('utf8').slice(0, 40));
  check('and starts with a BOM so Excel reads UTF-8', csv.buffer.toString('utf8').charCodeAt(0) === 0xfeff);

  const json = office.createDocument({ format: 'json', name: 'data', content: '{"b":2,"a":[1,2]}' });
  check('JSON is reformatted, which also validates it', json.buffer.toString('utf8').includes('\n  "b": 2'));

  let badJson = null;
  try {
    office.createDocument({ format: 'json', name: 'x', content: 'not json at all' });
  } catch (err) {
    badJson = err;
  }
  check('invalid JSON is refused rather than written', badJson?.code === 'bad_json', badJson?.message);

  let badFormat = null;
  try {
    office.createDocument({ format: 'pdf', name: 'x', content: 'hi' });
  } catch (err) {
    badFormat = err;
  }
  check('PDF is refused', badFormat?.code === 'bad_format');
  check('and says what to do instead', /Print → Save as PDF/.test(badFormat?.message || ''), badFormat?.message);

  check(
    'a path masquerading as a filename is flattened',
    office.safeFilename('../../etc/passwd', 'docx') === 'etc passwd.docx',
    office.safeFilename('../../etc/passwd', 'docx'),
  );
  check('a version number keeps its dot', office.safeFilename('Report v1.2', 'docx') === 'Report v1.2.docx');
  check('a name that already has the extension does not get it twice', office.safeFilename('report.docx', 'docx') === 'report.docx');
  check('a name of nothing still becomes a file', office.safeFilename('   ', 'md') === 'document.md');

  // The spreadsheet path accepts whatever shape the model wrote it in.
  const fromJson = office.createDocument({
    format: 'xlsx',
    name: 'j',
    content: '{"sheets":[{"name":"S","rows":[["a","b"],[1,2]]}]}',
  });
  check('a workbook can be written from JSON', readXlsx(fromJson.buffer).sheets[0].name === 'S');
  const fromCsv = office.createDocument({ format: 'xlsx', name: 'c', content: 'a,b\n1,2\n3,4' });
  check('and from raw CSV', readXlsx(fromCsv.buffer).sheets[0].rows.length === 3, String(readXlsx(fromCsv.buffer).sheets[0].rows.length));
}

section('what an upload is allowed to be');
{
  const { classify } = await import('../server/attachments.js');
  check('a .docx is an office document', classify('a.docx', '') === 'office');
  check('so is a .xlsx by mime alone', classify('unnamed', office.MIME_FOR.xlsx) === 'office');
  check('and a .pptx', classify('deck.pptx', 'application/octet-stream') === 'office');
  check('a macro-enabled one too', classify('a.docm', '') === 'office');
  check('a .pdf is still a document', classify('a.pdf', 'application/pdf') === 'document');
  check('a .doc is refused — it is a different format entirely', classify('old.doc', 'application/msword') === null);
  check('and recognised as legacy, so the message can say so', office.isLegacyOffice('old.doc', ''));
}

// ── over HTTP ───────────────────────────────────────────────────────
section('uploading a Word document and reading it back');
let docxId;
{
  const buffer = writeDocx({
    blocks: markdownToBlocks('# Đề thi thử\n\nCâu 1: nêu định nghĩa.\n\n| Câu | Điểm |\n| --- | --- |\n| 1 | 2 |'),
    title: 'Đề thi',
  });

  const upload = await alice.call('POST', '/api/attachments', {
    name: 'de-thi.docx',
    mime: office.MIME_FOR.docx,
    data: buffer.toString('base64'),
  });
  check('it uploads', upload.status === 201, JSON.stringify(upload.json).slice(0, 90));
  check('as an office document', upload.json?.attachment?.kind === 'office', upload.json?.attachment?.kind);
  docxId = upload.json.attachment.id;

  const preview = await alice.call('GET', `/api/attachments/${docxId}/preview`);
  check('the preview is a document', preview.json?.preview?.kind === 'document', preview.json?.preview?.kind);
  check('with real HTML in it', /<h1>Đề thi thử<\/h1>/.test(preview.json?.preview?.html || ''), (preview.json?.preview?.html || '').slice(0, 60));
  check('and the table', /<table>/.test(preview.json?.preview?.html || ''));
  check('named and sized', preview.json?.file?.name === 'de-thi.docx' && preview.json?.file?.bytes > 0);
  check('an upload has no source to edit', preview.json?.file?.source === null);

  const theirs = await bob.call('GET', `/api/attachments/${docxId}/preview`);
  check('another account cannot preview it', theirs.status === 404, `got ${theirs.status}`);

  const bytes = await alice.call('GET', `/api/attachments/${docxId}`);
  check('the bytes are served', bytes.status === 200);
  check(
    'as a download rather than something to render',
    /^attachment;/.test(bytes.headers.get('content-disposition') || ''),
    bytes.headers.get('content-disposition'),
  );
  check(
    'with the real name in the UTF-8 parameter',
    /filename\*=UTF-8''de-thi\.docx/.test(bytes.headers.get('content-disposition') || ''),
    bytes.headers.get('content-disposition'),
  );
  check('and may be framed by this app only', /frame-ancestors 'self'/.test(bytes.headers.get('content-security-policy') || ''), bytes.headers.get('content-security-policy'));
}

section('an uploaded page cannot run as a page');
{
  const evil = await alice.call('POST', '/api/attachments', {
    name: 'evil.html',
    mime: 'text/html',
    data: Buffer.from('<script>alert(document.cookie)</script>', 'utf8').toString('base64'),
  });
  check('it uploads as text', evil.json?.attachment?.kind === 'text');

  const served = await alice.call('GET', `/api/attachments/${evil.json.attachment.id}`);
  check(
    'but is never served as text/html',
    !/text\/html/.test(served.headers.get('content-type') || ''),
    served.headers.get('content-type'),
  );
  check(
    'and is forced to download',
    /^attachment;/.test(served.headers.get('content-disposition') || ''),
    'otherwise it is stored cross-site scripting on this origin',
  );

  const preview = await alice.call('GET', `/api/attachments/${evil.json.attachment.id}/preview`);
  check('the preview hands over the source, not a rendering', preview.json?.preview?.kind === 'text');
  check('with the script still visibly a string', preview.json?.preview?.text?.includes('<script>'));
}

// ── the tools ───────────────────────────────────────────────────────
section('the assistant making a document');
let chatId;
let madeId;
{
  const { executeTool } = await import('../server/tools/execute.js');
  const aliceUser = await store.getUserByEmail('alice@example.com');
  chatId = (await alice.call('POST', '/api/chats', {})).json.chat.id;

  const created = await executeTool({
    user: aliceUser,
    chatId,
    name: 'create_file',
    input: {
      name: 'Báo giá tháng 8',
      format: 'docx',
      content: '# Báo giá\n\nTổng cộng **12.500.000 đ**.\n\n| Mục | Giá |\n| --- | --- |\n| Ống | 1.500.000 |',
    },
  });
  check('the tool succeeds', created.isError === false, created.content?.slice(0, 80));
  check('and hands back a file for the interface', !!created.file?.id, JSON.stringify(created.file));
  check('named with the right extension', created.file?.name === 'Báo giá tháng 8.docx', created.file?.name);
  check('the model is told the id, so it can revise it', created.content.includes(created.file.id));
  check('and told not to paste the document into its reply', /do not paste/i.test(created.content));

  /**
   * The envelope now goes on at `executeTool`'s single exit, so this is the
   * cheapest real proof that the exit is selective rather than blanket: a
   * document this application just wrote is the app's own words, and wrapping it
   * would both cost tokens and teach the model to discount its own output.
   *
   * The positive half — a local tool's output arriving wrapped — is asserted on
   * the declaration in `isolation.test.mjs` rather than end to end, because
   * driving an in-process local tool starts the real worker runtime (a browser,
   * the workspace, the screen) and this suite will not do that.
   */
  check(
    'the app\'s own output is not put in an untrusted envelope',
    !created.content.includes('<untrusted'),
    created.content.slice(0, 60),
  );
  madeId = created.file.id;

  const preview = await alice.call('GET', `/api/attachments/${madeId}/preview`);
  check('it previews like any other document', preview.json?.preview?.kind === 'document');
  check('it is marked as the assistant\'s work', preview.json?.file?.origin === 'generated', preview.json?.file?.origin);
  check('and keeps the Markdown it was written from', preview.json?.file?.source?.startsWith('# Báo giá'), preview.json?.file?.source?.slice(0, 20));

  const listed = await alice.call('GET', `/api/chats/${chatId}/files`);
  check('the conversation knows what was made in it', listed.json?.files?.length === 1, String(listed.json?.files?.length));

  // Rewriting: the same file, not a second one.
  const updated = await executeTool({
    user: aliceUser,
    chatId,
    name: 'update_file',
    input: { file_id: madeId, content: '# Báo giá (đã sửa)\n\nTổng cộng **11.900.000 đ**.' },
  });
  check('an update succeeds', updated.isError === false, updated.content?.slice(0, 80));
  check('keeping the same id', updated.file?.id === madeId);

  const after = await alice.call('GET', `/api/attachments/${madeId}/preview`);
  check('the new words are in it', /đã sửa/.test(after.json?.preview?.html || ''), (after.json?.preview?.html || '').slice(0, 60));
  check('the old ones are gone', !/12\.500\.000/.test(after.json?.preview?.html || ''));

  const stillOne = await alice.call('GET', `/api/chats/${chatId}/files`);
  check('and there is still exactly one file', stillOne.json?.files?.length === 1, String(stillOne.json?.files?.length));

  // A file that can be rewritten must not be cached for a year, or the download
  // link keeps handing over the version before the correction.
  const bytes = await alice.call('GET', `/api/attachments/${madeId}?download=1`);
  check(
    'a rewritable file is never cached as immutable',
    !/immutable/.test(bytes.headers.get('cache-control') || ''),
    bytes.headers.get('cache-control'),
  );
  const upload = await alice.call('GET', `/api/attachments/${docxId}`);
  check('while an upload still is', /immutable/.test(upload.headers.get('cache-control') || ''), upload.headers.get('cache-control'));

  const readBack = await executeTool({
    user: aliceUser,
    chatId,
    name: 'read_generated_file',
    input: { file_id: madeId },
  });
  check('the source can be read back for the next edit', readBack.content.includes('# Báo giá (đã sửa)'));

  // A long file in parts: each call small enough to arrive whole.
  const appended = await executeTool({
    user: aliceUser,
    chatId,
    name: 'update_file',
    input: { file_id: madeId, content: '\n\n## Phụ lục\n\nPhần thêm.', append: true },
  });
  check('a part is added to the end', appended.isError === false && /Added to/.test(appended.content), appended.content?.slice(0, 80));
  const whole = await executeTool({ user: aliceUser, chatId, name: 'read_generated_file', input: { file_id: madeId } });
  check(
    '  keeping what was there before it',
    whole.content.includes('# Báo giá (đã sửa)') && whole.content.includes('## Phụ lục'),
    whole.content.slice(0, 120),
  );

  const listing = await executeTool({ user: aliceUser, chatId, name: 'read_generated_file', input: {} });
  check('and they can be listed', listing.content.includes('Báo giá tháng 8.docx'));

  // An upload is not the assistant's to rewrite.
  const notMine = await executeTool({
    user: aliceUser,
    chatId,
    name: 'update_file',
    input: { file_id: docxId, content: '# nope' },
  });
  check('an uploaded file cannot be rewritten by the tool', notMine.isError === true, notMine.content);
  check('and it says why', /uploaded by the user/.test(notMine.content), notMine.content);

  // Another account's id is simply not there.
  const bobUser = await store.getUserByEmail('bob@example.com');
  const stolen = await executeTool({ user: bobUser, chatId, name: 'update_file', input: { file_id: madeId, content: 'x' } });
  check('and another account cannot touch it at all', stolen.isError === true, stolen.content);
}

/**
 * An artifact: a page the assistant wrote, that runs.
 *
 * The security property is the whole feature, so it is what most of this
 * checks. The page is served under `sandbox` with no `allow-same-origin`, which
 * puts it in an opaque origin — it cannot read this session's cookie, cannot
 * call this API as the user, and cannot reach anything over the network at all.
 */
section('artifacts, and running one');
let artifactId;
{
  const { executeTool } = await import('../server/tools/execute.js');
  const aliceUser = await store.getUserByEmail('alice@example.com');
  const artifactChat = (await alice.call('POST', '/api/chats', {})).json.chat.id;

  const page = [
    '<!doctype html><html><body>',
    '<h1 id="title">Máy tính đơn giản</h1>',
    `<script>document.getElementById("title").textContent = "Đã chạy";</${'script'}>`,
    '</body></html>',
  ].join('\n');

  const made = await executeTool({
    user: aliceUser,
    chatId: artifactChat,
    name: 'create_file',
    input: { name: 'may-tinh', format: 'html', content: page },
  });
  check('a page can be created', made.isError === false, made.content?.slice(0, 60));
  artifactId = made.file.id;

  const run = await alice.call('GET', `/api/attachments/${artifactId}/run`);
  check('and run', run.status === 200, `got ${run.status}`);
  check('as real HTML', /text\/html/.test(run.headers.get('content-type') || ''), run.headers.get('content-type'));
  /**
   * The author's markup, untouched.
   *
   * This asserted byte equality with what was written, which was the strongest
   * available proxy for the thing it actually cares about — that a page is not run
   * through a Markdown renderer and escaped into a paragraph, which is an artifact
   * displaying its own source.
   *
   * The route now prepends a `window.storage` shim, because a sandboxed artifact has
   * an opaque origin where `localStorage` throws on first access and takes the page
   * down with it. So byte equality is deliberately no longer true. The intent is
   * unchanged and is checked directly instead: the page appears verbatim, as one
   * contiguous run, with nothing of the author's rewritten.
   */
  /**
   * Everything the author wrote, in one unbroken run.
   *
   * The shim goes in immediately after the doctype — it has to run *before* the
   * page's own script, because that script may reach for `window.storage` or
   * `localStorage` on its first line. So the served bytes are the doctype, then the
   * shim, then the author's markup untouched, and the check is on that last part.
   */
  const authored = page.trim().replace(/^<!doctype html>/i, '');
  check(
    "the author's markup is served verbatim, in one piece",
    run.text.includes(authored),
    'a page run through a Markdown renderer is escaped into a paragraph, which is an artifact that displays its own source',
  );
  check('script and all', /<script>/.test(run.text) && !/&lt;script/.test(run.text));
  check('and the accents survive', /Máy tính đơn giản/.test(run.text));
  // The reason the bytes are not identical any more, asserted so this is never
  // mistaken for the check having gone slack.
  check(
    'the storage shim runs first',
    run.text.indexOf('__artifactStorage') < run.text.indexOf(authored),
    'the page may call window.storage on its first line',
  );
  check('which is what stops localStorage throwing the page down', /localStorage/.test(run.text));

  // The other half of the same format: prose that wants to become a page.
  const prose = await executeTool({
    user: aliceUser,
    chatId: artifactChat,
    name: 'create_file',
    input: { name: 'bao-cao-web', format: 'html', content: '# Báo cáo\n\nMột **đoạn** với 3 < 5.' },
  });
  const rendered = await alice.call('GET', `/api/attachments/${prose.file.id}/run`);
  check('Markdown still becomes a styled page', /<h1>Báo cáo<\/h1>/.test(rendered.text), rendered.text.slice(0, 60));
  check('with its angle brackets escaped, because there it is prose', /3 &lt; 5/.test(rendered.text));

  const policy = run.headers.get('content-security-policy') || '';
  check('sandboxed', /sandbox/.test(policy), policy);
  check(
    'and never with allow-same-origin, which is the whole point',
    !/allow-same-origin/.test(policy),
    'without it the page runs in an opaque origin and cannot reach this session',
  );
  check('scripts are allowed — it is meant to run', /script-src[^;]*unsafe-inline/.test(policy));
  check('but it cannot call anything', /connect-src 'none'/.test(policy), policy);
  check('and only this app may frame it', /frame-ancestors 'self'/.test(policy));

  // An upload is somebody else's HTML and is never executed.
  const uploaded = await alice.call('POST', '/api/attachments', {
    name: 'theirs.html',
    mime: 'text/html',
    data: Buffer.from('<script>alert(1)</script>', 'utf8').toString('base64'),
  });
  const refused = await alice.call('GET', `/api/attachments/${uploaded.json.attachment.id}/run`);
  check('an uploaded page cannot be run', refused.status === 400, `got ${refused.status}`);
  check('and says why', /assistant wrote/.test(refused.json?.error || ''), refused.json?.error);

  const notCode = await alice.call('GET', `/api/attachments/${docxId}/run`);
  check('nor can a Word document', notCode.status === 400, `got ${notCode.status}`);

  // Editing by hand, which is the same operation `update_file` performs.
  const edited = await alice.call('PATCH', `/api/attachments/${artifactId}`, {
    content: page.replace('Máy tính đơn giản', 'Máy tính đã sửa'),
  });
  check('an artifact can be edited by hand', edited.status === 200, JSON.stringify(edited.json).slice(0, 80));
  const after = await alice.call('GET', `/api/attachments/${artifactId}/run`);
  check('and the change is what runs', /Máy tính đã sửa/.test(after.text));

  const notMine = await alice.call('PATCH', `/api/attachments/${uploaded.json.attachment.id}`, { content: 'x' });
  check('an upload cannot be edited', notMine.status === 400, `got ${notMine.status}`);

  // Source formats, stored as themselves.
  const script = await executeTool({
    user: aliceUser,
    chatId: artifactChat,
    name: 'create_file',
    input: { name: 'tinh-tien', format: 'py', content: 'def tong(a, b):\n    return a + b\n' },
  });
  check('code files can be made too', script.isError === false && script.file.name === 'tinh-tien.py', script.file?.name);
  const source = await alice.call('GET', `/api/attachments/${script.file.id}/preview`);
  check('and are shown as source', source.json?.preview?.kind === 'text', source.json?.preview?.kind);
  check('with the code intact', /def tong/.test(source.json?.preview?.text || ''));
  check(
    'stored inert, never as a script this origin would run',
    !/javascript|python/i.test(script.file.mime),
    script.file.mime,
  );

  const shelf = await alice.call('GET', '/api/files');
  check('the shelf lists them across conversations', shelf.json?.files?.length >= 2, String(shelf.json?.files?.length));
  check('naming the conversation each came from', 'chat_title' in (shelf.json?.files?.[0] || {}));

  const bobs = await bob.call('GET', '/api/files');
  check('and only your own', (bobs.json?.files || []).length === 0, String(bobs.json?.files?.length));

  const stolenDelete = await bob.call('DELETE', `/api/attachments/${artifactId}`);
  check('another account cannot delete one', stolenDelete.status === 404, `got ${stolenDelete.status}`);

  const dropped = await alice.call('DELETE', `/api/attachments/${script.file.id}`);
  check('the owner can', dropped.status === 200, `got ${dropped.status}`);
  check('and it is gone', (await alice.call('GET', `/api/attachments/${script.file.id}`)).status === 404);
}

section('deleting a conversation takes its files with it');
{
  const doomed = (await alice.call('POST', '/api/chats', {})).json.chat.id;
  const { executeTool } = await import('../server/tools/execute.js');
  const aliceUser = await store.getUserByEmail('alice@example.com');

  const made = await executeTool({
    user: aliceUser,
    chatId: doomed,
    name: 'create_file',
    input: { name: 'tam thoi', format: 'md', content: '# tạm thời' },
  });
  check('a file is made in it', !!made.file?.id);

  await alice.call('DELETE', `/api/chats/${doomed}`);
  const after = await alice.call('GET', `/api/attachments/${made.file.id}`);
  check('and is gone with the conversation', after.status === 404, `got ${after.status}`);
  check(
    'the one in the other conversation is untouched',
    (await alice.call('GET', `/api/attachments/${madeId}`)).status === 200,
  );
}

section('what the model is shown of a document');
{
  const { loadForTranscript, toParts } = await import('../server/attachments.js');
  const aliceUser = await store.getUserByEmail('alice@example.com');

  const sent = await alice.call('POST', `/api/chats/${chatId}/messages`, {
    text: 'tóm tắt giúp tôi',
    attachments: [docxId],
  });
  check('the document can be sent with a message', sent.status === 201, JSON.stringify(sent.json).slice(0, 80));

  const messages = await store.listMessages(aliceUser.id, chatId);
  const withFile = messages.find((message) => message.attachments?.length);
  const loaded = await loadForTranscript(aliceUser.id, [withFile]);

  // No provider takes a .docx as a file, so the text is the only way in — and it
  // is read whether or not the caller asked for extraction.
  const parts = toParts(withFile, loaded, { documents: true, vision: true });
  check('it becomes text, never a file part', parts.every((part) => part.type === 'text'), JSON.stringify(parts.map((p) => p.type)));
  check('the words of the document are in it', /Câu 1: nêu định nghĩa/.test(parts[0].text), parts[0].text.slice(0, 80));
  check('the table comes through as a table', /\| Câu \| Điểm \|/.test(parts[0].text));
  check('and it says what was lost', /formatting, images and charts are not included/.test(parts[0].text));
  check('naming the kind of document it was', /Word document/.test(parts[0].text), parts[0].text.slice(0, 60));
}

section('a project can be built on Office documents');
{
  const project = (await alice.call('POST', '/api/projects', { name: 'Hồ sơ thầu' })).json.project;
  const buffer = writeXlsx({
    sheets: [{ name: 'Giá', rows: [['Hạng mục', 'Giá'], ['Cáp điện', 250000]] }],
  });

  const added = await alice.call('POST', `/api/projects/${project.id}/files`, {
    name: 'bang-gia.xlsx',
    mime: office.MIME_FOR.xlsx,
    data: buffer.toString('base64'),
  });
  check('a spreadsheet can go on the shelf', added.status === 201, JSON.stringify(added.json).slice(0, 90));

  const files = (await alice.call('GET', `/api/projects/${project.id}`)).json.files;
  check('and it is stored as text that can be quoted', files[0].chars > 0, `${files[0].chars} chars`);

  const { selectSources } = await import('../server/projects.js');
  const rows = await store.readProjectFiles((await store.getUserByEmail('alice@example.com')).id, project.id);
  const picked = selectSources(rows, 'giá cáp điện');
  check('and it is findable by what is in it', /250000/.test(picked.sources[0].text), picked.sources[0].text.slice(0, 60));

  const image = await alice.call('POST', `/api/projects/${project.id}/files`, {
    name: 'a.png',
    mime: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  });
  /*
   * A picture is a source too now, and a different kind of one: it carries no
   * text, so it never competes for the passage budget the quotable sources
   * share, and it rides on the question as a real picture instead. A model
   * that cannot see is told there was one rather than left to answer as though
   * the shelf were empty.
   */
  check('a picture is taken as well', image.status === 201, `${image.status} ${image.json?.error || ''}`);
  check('with no text to rank', image.json?.file?.chars === 0, `${image.json?.file?.chars}`);

  // And it stays out of the ranking. `projectPrompt` hands `selectSources` only
  // the sources that have text; a row with none would score nothing against
  // every question and still take a place in the shortlist.
  const withImage = await store.readProjectFiles((await store.getUserByEmail('alice@example.com')).id, project.id);
  const quotable = withImage.filter((f) => f.kind !== 'image');
  check('the shelf now holds both kinds', withImage.length === quotable.length + 1, `${withImage.length}`);
  check(
    'and only the quotable one is ranked',
    selectSources(quotable, 'giá cáp điện').sources.every((src) => src.kind !== 'image'),
  );
}

section('a document that cannot be read says so');
{
  // A .docx that is really a ZIP of nothing in particular: the extension says
  // one thing and the bytes say another, which is what a renamed file looks like.
  const notReally = writeZip([{ name: 'hello.txt', data: 'not a document' }]);
  const upload = await alice.call('POST', '/api/attachments', {
    name: 'broken.docx',
    mime: office.MIME_FOR.docx,
    data: notReally.toString('base64'),
  });
  check('it still uploads — the bytes are the user\'s', upload.status === 201);

  const preview = await alice.call('GET', `/api/attachments/${upload.json.attachment.id}/preview`);
  check('the preview says it is unreadable rather than failing', preview.status === 200 && preview.json?.preview?.kind === 'unreadable', JSON.stringify(preview.json?.preview).slice(0, 90));
  check('with something a person can act on', /corrupt|document part/i.test(preview.json?.preview?.message || ''), preview.json?.preview?.message);

  const { loadForTranscript, toParts } = await import('../server/attachments.js');
  const aliceUser = await store.getUserByEmail('alice@example.com');
  const message = { attachments: [{ id: upload.json.attachment.id, name: 'broken.docx', kind: 'office' }] };
  const loaded = await loadForTranscript(aliceUser.id, [message]);
  const parts = toParts(message, loaded);
  check('and the model is told plainly, not handed nothing', /nothing could be read out of it/.test(parts[0].text), parts[0].text.slice(0, 80));
}

section('a hostile document cannot become markup');
{
  /**
   * viewer.js puts `preview.html` into the page with innerHTML, same-origin and
   * unsandboxed — the only preview branch that does not escape on the way in.
   * Its comment says the document "may have arrived from a stranger", and the
   * file asserts that everything reaching it was escaped by the server.
   *
   * That assertion was true and nothing checked it. An invariant one side
   * relies on and neither side tests is one a refactor breaks silently, so it
   * is pinned here — on the server, where the escaping actually happens.
   */
  const hostile = blocksToHtml(
    [
      { type: 'paragraph', runs: [{ text: '<script>alert(1)</script>' }] },
      { type: 'heading', level: 2, runs: [{ text: '<img src=x onerror=alert(1)>' }] },
      { type: 'quote', runs: [{ text: '" onmouseover="alert(1)' }] },
      { type: 'code', text: '</code><script>alert(1)</script>' },
      { type: 'paragraph', runs: [{ text: 'link', link: 'javascript:alert(1)' }] },
      { type: 'paragraph', runs: [{ text: 'ok', link: 'https://example.com/"><script>x</script>' }] },
      { type: 'table', header: true, rows: [[{ runs: [{ text: '<b>x</b>' }] }], [{ runs: [{ text: '</td><script>y</script>' }] }]] },
      { type: 'image', alt: '" onerror="alert(1)', index: 0 },
    ],
    { mediaSrc: () => 'https://example.com/pic.png' },
  );

  // Only real tags are examined. Escaped text legitimately contains the string
  // `onerror=`; what matters is that it is inside `&lt;…&gt;` and can never be
  // parsed as an attribute. A regex over the whole string cannot tell those
  // apart and would fail on correct output.
  const tags = hostile.match(/<[a-z][^>]*>/gi) || [];

  check('no script tag survives', !/<script/i.test(hostile), hostile.slice(0, 120));
  // Quoted values are emptied before looking for a handler. `onerror=` inside
  // an alt="" is text — the quotes around it are &quot; entities, so it cannot
  // close the attribute — and a check that cannot tell that apart fails on
  // output that is completely correct.
  const bare = (tag) => tag.replace(/"[^"]*"/g, '""');
  check(
    'no rendered tag carries an event handler',
    !tags.some((tag) => /\son\w+\s*=/i.test(bare(tag))),
    tags.find((tag) => /\son\w+\s*=/i.test(bare(tag))),
  );
  check('a javascript: link is not rendered as a link', !/href="javascript:/i.test(hostile), hostile.slice(0, 160));
  check(
    'no tag was broken open by a quote in the data',
    tags.every((tag) => (tag.match(/"/g) || []).length % 2 === 0),
    tags.find((tag) => (tag.match(/"/g) || []).length % 2 !== 0),
  );
  // The markup it *is* allowed to produce must still be there, or the check
  // above would pass on an empty string.
  check('and the document still renders', /<h2>/.test(hostile) && /<table>/.test(hostile) && /<figure/.test(hostile));
}

server.close();
await new Promise((r) => server.once('close', r));
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n[32mAll document checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
