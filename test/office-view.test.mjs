/**
 * What the viewer is given (owner, 2026-11-05): a workbook as cells and looks, charts
 * by their title and sheet, a slide or chart as a picture, a Word code block as one
 * block, and LibreOffice asked for at most once per file.
 *
 *   node test/office-view.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { workbookFixture } from './lib/workbook-fixture.mjs';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-the-view-suite';
const { officeView } = await import('../server/office/look.js');
const file = workbookFixture();

section('a workbook, cell by cell');
{
  const model = await officeView('workbook', file, { sheet: 1 });
  const { sheet } = model;
  const at = (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    return sheet.cells.find((c) => c[0] === Number(m[2]) - 1 && c[1] === m[1].charCodeAt(0) - 65);
  };
  const look = (ref) => sheet.styles[at(ref)[3]];
  check('its sheets, without the hidden one, and how many are hidden', model.sheets.map((s) => s.name).join() === 'Báo cáo,Sheet thứ hai' && model.hiddenSheets === 1, JSON.stringify(model.sheets));
  check('each chart by its own title, and the sheet it is on', model.charts.map((c) => `${c.title}@${c.sheetName}`).join() === 'Doanh thu theo nhóm@Báo cáo,Biểu đồ sheet hai@Sheet thứ hai', JSON.stringify(model.charts));
  check('a number as Excel shows it', at('B2')[2] === '1,234,567', at('B2')[2]);
  check('  with the number behind it', at('B2')[4].v === 1234567);
  check('a formula beside its result', at('C2')[4].f === 'B2*2' && at('C2')[2] === '2,469,134');
  check('a shared formula, moved to where it is read from', at('A6')[4].f === 'B2+1' && at('A7')[4].f === 'B3+1' && at('A8')[4].f === 'B4+1', `${at('A7')[4].f} ${at('A8')[4].f}`);
  check('words in runs, each with its own look', at('A2')[4].runs?.length === 2 && at('A2')[4].runs[1].b === 1 && at('A2')[4].runs[1].c === 'FF0000', JSON.stringify(at('A2')[4].runs));
  check('a fill, a font, a colour, a border', look('A1').g === 'DDA0DD' && look('A1').b === 1 && look('A1').c === '0000FF' && look('A1').bb?.[2] === 'FF0000', JSON.stringify(look('A1')));
  check('a font name a file wrote to be something else is only a name', !/[;:(]/.test(look('A1').f), look('A1').f);
  check('alignment', look('A4').h === 'center' && look('A4').v === 'center');
  check('wrapping', look('A5').w === 1);
  check('merges', sheet.merges.some((m) => m.join() === '3,0,3,3'), JSON.stringify(sheet.merges));
  check('what is frozen', sheet.frozenRows === 1 && sheet.frozenCols === 1);
  check('a cell a merge covers is not drawn as well', !sheet.cells.some((c) => c[0] === 3 && c[1] === 1));
  check('widths and heights in order', sheet.colX[1] > sheet.colX[0] && Math.abs(sheet.rowY[5] - sheet.rowY[4] - 60) < 0.01, `${sheet.rowY[4]} ${sheet.rowY[5]}`);
  check('a number too wide for its column reads as Excel reads it', /^#+$|E\+/.test(at('F6')[2]), at('F6')[2]);
  check('what stands over the cells, with where', sheet.drawings.length === 1 && sheet.drawings[0].kind === 'chart' && sheet.drawings[0].w > 50, JSON.stringify(sheet.drawings));
  const second = await officeView('workbook', file, { sheet: 2 });
  check('the second sheet is the next one shown, not the hidden one', second.sheet.name === 'Sheet thứ hai', second.sheet.name);
  const past = await officeView('workbook', file, { sheet: 99 });
  check('a sheet that is not there is the last one, not a failure', past.sheet.name === 'Sheet thứ hai');
  const later = await officeView('workbook', file, { sheet: 1, from: 5 });
  check('rows from where it asks', later.sheet.from === 5 && later.sheet.cells.every((c) => c[0] >= 5) && later.sheet.cells.length > 0);
}

section('a long sheet comes a window at a time');
{
  const { writeZip } = await import('../server/office/zip.js');
  const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rows = Array.from({ length: 1500 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const long = writeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: '_rels/.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Dài" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>` },
  ]);
  const first = await officeView('workbook', long, { sheet: 1 });
  check('the first window', first.sheet.from === 0 && first.sheet.to === 499 && first.sheet.lastRow === 1499, `${first.sheet.to} ${first.sheet.lastRow}`);
  check('  knowing how far it goes, for the scroll bar', first.sheet.rowY.length === 1501);
  const next = await officeView('workbook', long, { sheet: 1, from: 500 });
  check('the next one follows on', next.sheet.from === 500 && next.sheet.cells[0][0] === 500);
}

section('drawn on their own');
{
  const chart = await officeView('drawing', file, { sheet: 1, index: 0 });
  check('a chart, as a picture of its own', chart?.mime === 'image/png' && chart.width > 100 && Buffer.from(chart.data, 'base64').length > 1000, JSON.stringify({ w: chart?.width, h: chart?.height }));
  const none = await officeView('drawing', file, { sheet: 1, index: 9 });
  check('one that is not there says so', none?.missing === true);
  const noSheet = await officeView('drawing', file, { sheet: 9, index: 0 });
  check('nor on a sheet that is not', noSheet?.missing === true);

  const { createDocument } = await import('../server/office/index.js');
  const deck = createDocument({ format: 'pptx', name: 'd', content: '# Tiêu đề\nPhụ đề\n\n## Trang hai\n- Một\n' }).buffer;
  const slide = await officeView('page', deck, { name: 'd.pptx', page: 2, edge: 800 });
  check('a slide as a picture, with nothing round it', slide?.mime === 'image/jpeg' && slide.width === 800 && slide.total === 2, JSON.stringify({ w: slide?.width, total: slide?.total }));
  const gone = await officeView('page', deck, { name: 'd.pptx', page: 9, edge: 800 });
  check('a slide that is not there says so', gone?.missing === true);
  const refused = await officeView('page', file, { name: 'x.xlsx', page: 1 }).then(() => false, (err) => err?.code === 'office_unreadable');
  check('a workbook is not asked for by the page', refused);
}

section('a code block in Word is one block (owner, 2026-11-05, screenshots 3 and 4)');
{
  const { createDocument, readOffice } = await import('../server/office/index.js');
  const diagram = 'Khách\n  │\n  ▼\n┌───┐\n\n│ Web │\n└───┘';
  const made = createDocument({ format: 'docx', name: 'k', content: `# Kiến trúc\n\nTrước.\n\n\`\`\`\n${diagram}\n\`\`\`\n\nSau.\n\n\`\`\`\nkhối hai\n\`\`\`\n` }).buffer;
  const read = readOffice('docx', made);
  const blocks = read.blocks.filter((b) => b.type === 'code');
  check('every line of it, in one block', blocks[0]?.text.split('\n').length === diagram.split('\n').length, JSON.stringify(blocks[0]?.text));
  check('  its blank line kept', /┌───┐\n\s*\n│ Web │/.test(blocks[0]?.text || ''), JSON.stringify(blocks[0]?.text));
  check('two blocks with words between stay two', blocks.length === 2 && blocks[1].text === 'khối hai', String(blocks.length));
  const html = read.preview.html;
  check('  so the preview draws one box', (html.match(/<pre/g) || []).length === 2, html.slice(0, 200));
}

section('LibreOffice, asked for once per file');
{
  const { initStore } = await import('../server/store/index.js');
  const memory = await PGlite.create();
  const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
  await store.createUser({ id: 'u-view', email: 'view@example.com', passwordHash: 'x', name: 'V', role: 'user' });
  const { renderWithOffice } = await import('../server/officeRender.js');
  const { saveUpload } = await import('../server/attachments.js');
  const upload = await saveUpload('u-view', { name: 'deck.pptx', mime: '', data: Buffer.from('pretend').toString('base64') });
  const row = await store.getAttachment('u-view', upload.id);
  let made = 0;
  let deleted = 0;
  const calls = [];
  const fake = (pdf = 'PDF') => async () => {
    made += 1;
    return {
      writeFiles: async (files) => calls.push(files[0].path),
      runCommand: async (c) => {
        calls.push(c.args.at(-1));
        return { exitCode: 0, stdout: async () => '', stderr: async () => '' };
      },
      readFileToBuffer: async () => (pdf ? Buffer.from(pdf) : null),
      delete: async () => {
        deleted += 1;
      },
    };
  };
  const first = await renderWithOffice('u-view', row, { machineFor: fake() });
  check('a machine makes it, once, and is gone after', made === 1 && deleted === 1 && first.id, JSON.stringify(first));
  check('  from a fixed name, whatever the file was called', calls[0] === '/tmp/in/document.pptx', calls[0]);
  const again = await renderWithOffice('u-view', row, { machineFor: fake() });
  check('asked again it costs nothing', made === 1 && again.id === first.id, `${made}`);
  const changed = await renderWithOffice('u-view', { ...row, data: Buffer.from('changed').toString('base64') }, { machineFor: fake() });
  check('the file changing means a new one', made === 2 && changed.id !== first.id);
  const rows = await store.listAllGeneratedFiles('u-view', 50);
  check('it stays out of the Files shelf', !rows.some((f) => f.id === first.id), JSON.stringify(rows.map((f) => f.name)));
  const failed = await renderWithOffice('u-view', { ...row, data: Buffer.from('other').toString('base64') }, { machineFor: fake(null) }).then(() => false, (err) => /could not draw/.test(err.message));
  check('it failing says the ordinary preview still works', failed);
  check('  and the machine still goes', deleted === 3 + 0 || deleted === 3, String(deleted));
  const other = await store.findRenderedFile('someone-else', row.id, 'x');
  check('nobody else can find it', other === null);
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll office view checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
