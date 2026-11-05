/**
 * A file as it looks (owner, 2026-11-04): Word, Excel and PowerPoint drawn as
 * pictures for a model that can see, so it can check layout, colours and pictures,
 * not just the words. Facts are measured off the pixels, so a page that "drew" but
 * came out white, or text that ran off its page, fails here rather than in a reply.
 *
 *   node test/office-look.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'office-look-test-key';
process.env.SESSION_SECRET ||= 'office-look-test-secret';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const { createDocument } = await import('../server/office/index.js');
const { lookAtFile, lookableFormat, sheetPlan, SHEET_EDGE } = await import('../server/office/look.js');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');
const { wordFixture, FIXTURE } = await import('./lib/word-fixture.mjs');

/** A picture's pixels, to measure rather than to trust. */
async function pixels(sheet) {
  const image = await loadImage(Buffer.from(sheet.data, 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
}

/** How much of the picture is close to this colour, 0 to 1. */
function shareOf({ data }, [r, g, b], tolerance = 24) {
  let hits = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) <= tolerance) hits += 1;
  }
  return hits / (data.length / 16);
}

const LOOK_READ = (tools, name) => tools.read_file({ path: name });
const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const looksAt = (format, content, name = `x.${format}`, options = {}) => lookAtFile(createDocument({ format, name, content, ...(options.theme ? { theme: options.theme } : {}) }).buffer, { name, ...options });

section('which files can be drawn');
{
  check('by extension', lookableFormat('a.docx') === 'docx' && lookableFormat('A.XLSX') === 'xlsx' && lookableFormat('b.pptm') === 'pptx');
  check('not anything else', lookableFormat('a.pdf') === null && lookableFormat('a.md') === null);
  const deck = createDocument({ format: 'pptx', name: 'x', content: '# Hi' }).buffer;
  check('a file with no useful name says what it is by its parts', lookableFormat('download', deck) === 'pptx');
  check('garbage is simply not lookable', lookableFormat('download', Buffer.from('not a zip')) === null);
}

section('which pages share a picture');
{
  const page = (n, extra = {}) => ({ n, unit: 'page', width: 595, height: 842, chars: 2500, bodyPt: 11, ink: 0.2, ...extra });
  const pair = sheetPlan([page(1), page(2)]);
  check('two ordinary pages share a picture', pair.sheets.length === 1 && pair.sheets[0].cells.length === 2);
  const dense = sheetPlan([page(1, { bodyPt: 7 }), page(2)]);
  check('a page of small print goes alone', dense.sheets.length === 2, JSON.stringify(dense.sheets.map((s) => s.pages)));
  const tables = sheetPlan([page(1, { tableCells: 200 }), page(2)]);
  check('so does a detailed table', tables.sheets.length === 2);
  const sparse = sheetPlan([page(1, { chars: 40, ink: 0.01 }), page(2, { chars: 90, ink: 0.02 }), page(3, { chars: 100, ink: 0.02 })]);
  check('three near-empty pages may share', sparse.sheets.length === 1 && sparse.sheets[0].cells.length === 3);
  const blank = sheetPlan([page(1), page(2, { blank: true, chars: 0 }), page(3, { duplicateOf: 1 })]);
  check('a blank page and a duplicate are not sent', blank.blank.join() === '2' && blank.duplicates[0]?.of === 1 && blank.shown.join() === '1');
  const asked = sheetPlan([page(4), page(5)], { asked: true });
  check('pages asked for by number get a picture each', asked.sheets.length === 2);
  const blankAsked = sheetPlan([page(2, { blank: true })], { asked: true });
  check('and a blank one is shown if it was asked for', blankAsked.shown.join() === '2');
  const long = sheetPlan(Array.from({ length: 40 }, (_, i) => page(i + 1)), { maxSheets: 3 });
  check('a long file gets an overview within the limit', long.sheets.length <= 3);
  check('with the first and last pages among it', long.shown.includes(1) && long.shown.includes(40), long.shown.join());
  check('and says which were left out', long.skipped.length === 40 - long.shown.length);
  const slides = sheetPlan(Array.from({ length: 6 }, (_, i) => ({ n: i + 1, unit: 'slide', width: 960, height: 540, chars: 120, bodyPt: 20, ink: 0.3 })));
  check('six ordinary slides share a picture', slides.sheets.length === 1);
  const denseSlides = sheetPlan(Array.from({ length: 6 }, (_, i) => ({ n: i + 1, unit: 'slide', width: 960, height: 540, chars: 900, bodyPt: 9, ink: 0.3 })));
  check('slides of small print do not', denseSlides.sheets.length > 1, String(denseSlides.sheets.length));
  for (const plan of [pair, long, slides]) {
    for (const sheet of plan.sheets) check('every picture stays within what is kept', sheet.width <= SHEET_EDGE && sheet.height <= SHEET_EDGE, `${sheet.width}x${sheet.height}`);
  }
}

const REPORT = `# Báo cáo quý IV

Tóm tắt điều hành: ệ ữ ổ ậ đ.

## Số liệu

| Nhà cung cấp | Token | Chi phí |
|---|---|---|
| OpenRouter | 120 | 1,250.50 |
| OrcaRouter | 87 | 640.00 |

${'Một đoạn văn dài để kiểm tra việc ngắt trang và căn lề của văn bản trong tài liệu. '.repeat(120)}

## Kết luận

Hết.
`;

section('a Word file');
{
  const look = await looksAt('docx', REPORT, 'report.docx', { theme: 'ocean' });
  check('it drew', !!look && look.unit === 'page' && look.sheets.length > 0, JSON.stringify(look && look.notes));
  check('real pagination: a long report is more than one page', look.total >= 2, String(look.total));
  check('each sheet says what is on it', /Pages? .* of /.test(look.sheets[0].label), look.sheets[0].label);
  const all = await Promise.all(look.sheets.map(pixels));
  const inked = all.map((p) => 1 - shareOf(p, [255, 255, 255], 30));
  check('with something on it', inked.every((share) => share > 0.02), inked.map((n) => n.toFixed(3)).join());
  check('and within size', look.sheets.every((s) => s.width <= SHEET_EDGE && s.height <= SHEET_EDGE));
  check('and small enough to keep', look.sheets.every((s) => s.data.length * 0.75 < 2.56 * 1024 * 1024));

  const onlySecond = await looksAt('docx', REPORT, 'report.docx', { pages: [2] });
  check('a page asked for comes alone', onlySecond.shown.join() === '2' && onlySecond.sheets.length === 1);
  const wrong = await looksAt('docx', REPORT, 'report.docx', { pages: [99] });
  check('asking for a page that is not there says so, and still shows the file', wrong.notes.some((n) => /no page 99/.test(n)) && wrong.sheets.length > 0, wrong.notes.join(' '));

  const colours = await pixels((await looksAt('docx', '# Tiêu đề\n\nVăn bản.\n\n| A | B |\n|---|---|\n| 1 | 2 |', 'c.docx', { theme: 'ocean' })).sheets[0]);
  check('the words are dark ink on a light page, not nothing', shareOf(colours, [255, 255, 255], 30) > 0.3);
}

section('a file Word wrote, not this app (checked against real Word, 2026-11-05)');
{
  const bytes = wordFixture();
  const look = await lookAtFile(bytes, { name: 'word.docx' });
  check('two pages, as Word makes it', look.total === 2, String(look.total));
  const seen = await pixels(look.sheets[0]);
  for (const [name, hex] of [['the table style’s header row', FIXTURE.tableHead], ['its banded rows', FIXTURE.band], ['the floating box', FIXTURE.box], ['the square-wrapped shape', FIXTURE.square]]) {
    check(`${name} is drawn, from the style and not the cell`, shareOf(seen, hexRgb(hex), 30) > 0.002, shareOf(seen, hexRgb(hex), 30).toFixed(4));
  }

  // The words themselves, as laid out, to say exactly where they went.
  const { openZip } = await import('../server/office/zip.js');
  const { Budget, Measurer } = await import('../server/office/draw/common.js');
  const { Fonts } = await import('../server/office/draw/fonts.js');
  const { layoutDocx } = await import('../server/office/draw/docx.js');
  const canvasApi = await import('@napi-rs/canvas');
  const tools = { fonts: new Fonts(canvasApi), measure: new Measurer(canvasApi), budget: new Budget(30000), note: () => {}, canvasApi };
  const { pages } = layoutDocx(openZip(bytes), tools);
  const words = (surface) => surface.ops.filter((op) => op.k === 't');
  check('a run’s own colour and size are kept', words(pages[0]).some((op) => op.s === 'Red' && op.color.toUpperCase() === `#${FIXTURE.red}` && /bold/.test(op.f)));
  const text = (surface) => words(surface).map((op) => op.s).join(' ');
  check('list numbers count, restart and nest', /1\. Numbered one 2\. Numbered two a\) Lettered 3\. Numbered three/.test(text(pages[0])), text(pages[0]).slice(200, 400));
  check('a bullet from a symbol font is a bullet, not a stray letter', /• First bullet/.test(text(pages[0])));
  check('PAGE and NUMPAGES are worked out, not the saved 9', /Page 1 of 2/.test(text(pages[0])) && /Page 2 of 2/.test(text(pages[1])));
  check('a header is on every page', /A header written by hand/.test(text(pages[1])));
  const headingOp = words(pages[0]).find((op) => op.s === 'document');
  check('a style’s size reaches the heading, through basedOn', Number(/([\d.]+)px/.exec(headingOp?.f || '')?.[1]) > 18, headingOp?.f);
  check('and its theme colour, tinted as Word tints it', /^#(0f|10)4[5-9]/i.test(headingOp?.color || ''), headingOp?.color);
  const [boxX0, boxX1, boxY0, boxY1] = [72, 192, 470, 590];
  const beside = words(pages[0]).filter((op) => op.y > boxY0 && op.y < boxY1 + 14);
  check('words go around a square-wrapped shape', beside.length > 5 && beside.every((op) => op.x >= boxX1 || op.y < boxY0), JSON.stringify(beside.filter((op) => op.x < boxX1 && op.y >= boxY0).slice(0, 3).map((op) => [op.s, Math.round(op.x), Math.round(op.y)])));
  check('and no word sits on top of it', !words(pages[0]).some((op) => op.x >= boxX0 && op.x < boxX1 && op.y - 9 < boxY1 && op.y > boxY0));
  const headingY = words(pages[0]).find((op) => op.s === 'document')?.y;
  check('space before the first paragraph on a turned page is dropped', words(pages[1]).find((op) => op.s === 'The')?.y < 100, String(words(pages[1]).find((op) => op.s === 'The')?.y));
  check('and kept at the top of the document', headingY > 72 + 18, String(headingY));
}

section('a merged cell does not swallow its row');
{
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['a'], [], ['Merged title'], ['b']]);
  ws['!merges'] = [{ s: { r: 2, c: 0 }, e: { r: 2, c: 3 } }];
  XLSX.utils.book_append_sheet(book, ws, 'One');
  const { openZip } = await import('../server/office/zip.js');
  const { Budget, Measurer } = await import('../server/office/draw/common.js');
  const { Fonts } = await import('../server/office/draw/fonts.js');
  const { layoutXlsx } = await import('../server/office/draw/xlsx.js');
  const canvasApi = await import('@napi-rs/canvas');
  const tools = { fonts: new Fonts(canvasApi), measure: new Measurer(canvasApi), budget: new Budget(30000), note: () => {}, canvasApi };
  const { pages } = await layoutXlsx(openZip(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })), tools);
  const said = pages[0].ops.filter((op) => op.k === 't').map((op) => op.s).join(' ');
  check('its words are drawn', /Merged title/.test(said), said);
  const numbers = pages[0].ops.filter((op) => op.k === 't' && /^\d$/.test(op.s)).map((op) => [op.s, op.y]);
  const y = (n) => numbers.find(([s]) => s === String(n))?.[1];
  check('and its row keeps a height', y(3) !== undefined && y(4) - y(3) > 8, JSON.stringify(numbers));
}

section('Vietnamese draws as letters, not boxes');
{
  const { Fonts } = await import('../server/office/draw/fonts.js');
  const canvasApi = await import('@napi-rs/canvas');
  const fonts = new Fonts(canvasApi);
  check('the fonts load from the repository', fonts.usable());
  for (const name of ['Calibri', 'Arial', 'Times New Roman', 'Courier New', 'Segoe UI']) {
    const pick = fonts.pick(name);
    const pieces = fonts.pieces('Việt ệ ữ ổ ậ đ ơ ư', pick);
    check(`${name}: every letter has a face`, pieces.length > 0);
  }
  check('nothing was missing', fonts.missing.size === 0, [...fonts.missing].join(' '));
}

section('a PowerPoint file');
{
  const deck = `# Chiến lược\nKế hoạch\n\n## Tổng quan\n- Một\n- Hai\n\n## Số liệu\n- **45%** tăng trưởng\n- **3.2M** người dùng\n- **98%** hài lòng\n\n# Phần hai\n\n## So sánh\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Hết\nCảm ơn.\n`;
  const look = await looksAt('pptx', deck, 'deck.pptx');
  check('it drew', !!look && look.unit === 'slide' && look.total === 6, look && String(look.total));
  check('slides with big words share one picture', look.sheets.length === 1, String(look.sheets.length));
  const seen = await pixels(look.sheets[0]);
  // The cover is a dark full-bleed colour: a text-only reading would never know.
  check('the design is there, not just the words', shareOf(seen, [255, 255, 255], 30) < 0.85 && 1 - shareOf(seen, [255, 255, 255], 30) > 0.1);
  const one = await looksAt('pptx', deck, 'deck.pptx', { pages: [1] });
  const cover = await pixels(one.sheets[0]);
  check('a slide asked for by number comes alone, at its own size', one.sheets.length === 1 && one.sheets[0].width > 1200, `${one.sheets[0].width}`);
  check('and the cover really is dark', shareOf(cover, [255, 255, 255], 60) < 0.2);
}

section('an Excel file');
{
  const sheet = `# Doanh thu\n\n| Tháng | Doanh thu | Ghi chú |\n|---|---|---|\n| 2026-01-15 | 1.560.000.000 | Ổn |\n| 2026-02-15 | 2.100.000.000 | Tốt |\n\n# Chi phí\n\n| Khoản | Tiền |\n|---|---|\n| Máy chủ | 1200 |\n`;
  const look = await looksAt('xlsx', sheet, 'book.xlsx');
  check('it drew', !!look && look.unit === 'sheet' && look.total === 2);
  check('small worksheets share a picture', look.sheets.length === 1, String(look.sheets.length));
  const seen = await pixels(look.sheets[0]);
  check('with colour: the header band and the data bars', 1 - shareOf(seen, [255, 255, 255], 40) > 0.15);
  const secondOnly = await looksAt('xlsx', sheet, 'book.xlsx', { pages: [2] });
  check('a worksheet asked for comes alone, named', /Chi phí/.test(secondOnly.sheets[0].label), secondOnly.sheets[0].label);

  const rows = Array.from({ length: 900 }, (_, i) => `| ${i + 1} | Dòng thứ ${i + 1} | ${i * 3} |`).join('\n');
  const long = await looksAt('xlsx', `# Dài\n\n| STT | Tên | Số |\n|---|---|---|\n${rows}\n`, 'long.xlsx', { maxSheets: 2 });
  check('a long worksheet is cut into pieces, within the limit', long.sheets.length === 2, String(long.sheets.length));
  check('and says the rest is not shown', long.notes.some((n) => /rest of its rows/.test(n)), long.notes.join(' '));

  const { columnLetters } = await import('../server/office/draw/xlsx.js');
  check('column letters run past Z', columnLetters(0) === 'A' && columnLetters(25) === 'Z' && columnLetters(26) === 'AA' && columnLetters(701) === 'ZZ');
}

section('a stranger’s file ends its own look, nothing more');
{
  await lookAtFile(Buffer.from('this is not a zip at all'), { name: 'x.docx' }).then(
    () => check('garbage is refused', false),
    (err) => check('garbage is refused', err?.code === 'office_unreadable', err?.message),
  );
  await lookAtFile(createDocument({ format: 'md', name: 'x', content: '# Hi' }).buffer, { name: 'x.docx' }).then(
    () => check('a file that is not what it says is refused', false),
    (err) => check('a file that is not what it says is refused', err?.code === 'office_unreadable', err?.message),
  );
  const started = Date.now();
  const slow = await lookAtFile(createDocument({ format: 'docx', name: 'x', content: REPORT.repeat(40) }).buffer, { name: 'x.docx', timeoutMs: 1 }).catch((err) => err);
  check('a deadline is kept', slow?.code === 'office_unreadable' && Date.now() - started < 5000, slow?.message);
}

section('read_file on the person’s own computer');
{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'office-look-'));
  const { setWorkspace } = await import('../worker/paths.js');
  setWorkspace(workspace);
  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');
  fs.writeFileSync(path.join(workspace, 'deck.pptx'), createDocument({ format: 'pptx', name: 'deck', content: '# Xin chào\n\n## Một\n- Hai\n' }).buffer);
  const read = await LOOK_READ(LOCAL_IMPLEMENTATIONS, 'deck.pptx');
  check('its words come back as words', /Xin chào/.test(read.text || ''), String(read.text).slice(0, 120));
  check('and how it looks as pictures, each named', read.sheets?.length >= 1 && /\.jpg$/.test(read.sheets[0].name) && !!read.sheets[0].data);
  fs.writeFileSync(path.join(workspace, 'broken.docx'), 'this is not a zip');
  const broken = await LOOK_READ(LOCAL_IMPLEMENTATIONS, 'broken.docx').catch((err) => ({ error: String(err?.message || err) }));
  check('a file that is not what it says fails with a sentence', typeof broken.error === 'string' && broken.error.length > 0, JSON.stringify(broken).slice(0, 160));
  fs.rmSync(workspace, { recursive: true, force: true });
}

section('a hostile file ends its own look, and quickly');
{
  const { writeZip } = await import('../server/office/zip.js');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const pack = (body) => writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document ${W}><w:body>${body}</w:body></w:document>` },
  ]);
  const timed = async (label, bytes, name) => {
    const started = Date.now();
    const out = await lookAtFile(bytes, { name, timeoutMs: 20000 }).catch((err) => err);
    const took = Date.now() - started;
    check(label, took < 15000 && (out?.sheets?.length > 0 || out?.code === 'office_unreadable'), `${took} ms, ${out?.code || `${out?.sheets?.length} sheets`}`);
  };
  const empty = await lookAtFile(pack('<w:p/>'), { name: 'empty.docx', timeoutMs: 20000 });
  check('a document with nothing on it still shows its one page', empty?.sheets?.length === 1, JSON.stringify({ sheets: empty?.sheets?.length, notes: empty?.notes }));
  await timed('a table cell claiming a billion columns', pack('<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="1000000000"/></w:tcPr><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'), 'span.docx');
  await timed('a million close tags that match nothing', pack(`${'<w:p>'.repeat(2000)}${'</w:b>'.repeat(1_000_000)}`), 'closes.docx');

  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['a']]);
  ws['!merges'] = Array.from({ length: 200_000 }, (_, i) => ({ s: { r: i, c: 0 }, e: { r: i, c: 40 } }));
  XLSX.utils.book_append_sheet(book, ws, 'One');
  await timed('a sheet of two hundred thousand merges', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'merges.xlsx');
}

section('where no worker can load, it still answers on this thread');
{
  const bogus = new URL('./no-such-worker.mjs', import.meta.url);
  const look = await lookAtFile(createDocument({ format: 'pptx', name: 'x', content: '# Hi' }).buffer, { name: 'x.pptx', workerUrl: bogus });
  check('it drew anyway', !!look && look.sheets.length === 1);
}

const out = path.join(os.tmpdir(), `office-look-${process.pid}`);
fs.rmSync(out, { recursive: true, force: true });

console.log(failures === 0 ? '\n\x1b[32mFiles are drawn as they look.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
