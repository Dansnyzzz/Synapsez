/**
 * Spreadsheets, in both directions.
 *
 * Reading one is mostly indirection: a cell holds a number, and what that number
 * *means* lives in three other parts. `42` with the wrong format is a date in
 * 2014; a piece of text is usually an index into a shared table rather than the
 * text itself. Following all of it is the difference between a spreadsheet a
 * model can answer questions about and a wall of integers.
 *
 * Writing one produces a file that is actually usable as a spreadsheet: real
 * numbers in real numeric cells, so a column can be summed; a frozen, filtered
 * header row; column widths that fit what is in them. A table pasted in as text
 * looks the same on screen and is useless the moment anybody clicks AutoSum.
 *
 * Not attempted: formulas (values are read, formulas are noted and not
 * evaluated), charts, pivot tables, conditional formatting, and merged-cell
 * layout beyond recording that a merge exists.
 */
import { openZip, writeZip } from './zip.js';
import {
  XML_DECLARATION,
  attr,
  descendants,
  element,
  elements,
  escapeXml,
  parseXml,
  relationshipId,
  textOf,
} from './xml.js';
import {
  MIME,
  NS,
  REL,
  appPropsXml,
  contentTypesXml,
  corePropsXml,
  mainPart,
  readRelationships,
  relsPathFor,
  resolveTarget,
  rootRelsXml,
} from './opc.js';

/** How much of a large workbook the model is shown. Same budget as a PDF. */
const MAX_TEXT_CHARS = 120_000;

/** What the preview will draw. Beyond this a spreadsheet is a database. */
const MAX_PREVIEW_ROWS = 2000;
const MAX_PREVIEW_COLUMNS = 64;

/* ── column letters ─────────────────────────────────────────────────── */

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(index) {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** "BC12" → 54. Returns -1 for a reference it cannot read. */
export function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(String(ref || ''));
  if (!letters) return -1;
  let index = 0;
  for (const char of letters[1].toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/* ══ reading ═══════════════════════════════════════════════════════════ */

/** The shared string table: text stored once and referenced by index. */
function readSharedStrings(zip, path) {
  const strings = [];
  if (!path || !zip.has(path)) return strings;
  const root = parseXml(zip.text(path));
  for (const si of elements(root, 'si')) {
    // A string with mixed formatting is a series of runs; the text is their
    // concatenation, and `rPh` (phonetic guides on Japanese text) is not part
    // of it.
    let text = '';
    for (const child of elements(si)) {
      const name = child.name.replace(/^.*:/, '');
      if (name === 't') text += textOf(child);
      else if (name === 'r') text += textOf(element(child, 't') || {});
    }
    strings.push(text);
  }
  return strings;
}

/**
 * Which number formats mean "this is a date".
 *
 * The built-in ids are fixed by the specification. A custom format has to be
 * read: if its pattern contains date or time placeholders outside quoted
 * literals, the number in the cell is a date rather than a quantity.
 */
const BUILT_IN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function looksLikeDateFormat(code) {
  const withoutLiterals = String(code || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[ymdhs]/i.test(withoutLiterals);
}

/** Cell style index → whether that style formats its number as a date. */
function readDateStyles(zip) {
  const dates = [];
  if (!zip.has('xl/styles.xml')) return dates;

  const root = parseXml(zip.text('xl/styles.xml'));
  const custom = new Map();
  for (const format of descendants(root, 'numFmt')) {
    custom.set(Number(attr(format, 'numFmtId')), String(attr(format, 'formatCode') || ''));
  }

  const cellXfs = element(root, 'cellXfs');
  for (const xf of elements(cellXfs, 'xf')) {
    const id = Number(attr(xf, 'numFmtId') || 0);
    dates.push(BUILT_IN_DATE_FORMATS.has(id) || looksLikeDateFormat(custom.get(id)));
  }
  return dates;
}

/**
 * A spreadsheet serial number as a date.
 *
 * Day 1 is 1 January 1900, and the epoch is 30 December 1899 rather than the
 * 31st because Excel deliberately reproduces a Lotus 1-2-3 bug: it believes 1900
 * was a leap year. Every spreadsheet in the world agrees with it, so the offset
 * is correct rather than clever. Workbooks saved by very old Mac versions count
 * from 1904 instead and say so in the workbook part.
 */
function serialToDate(serial, epoch1904) {
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  return new Date(base + ms);
}

/** A date as text: the day alone when there is no time in it. */
function formatDate(date) {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/**
 * A number as text, without the noise floating point leaves behind.
 *
 * 0.1 + 0.2 stored and read back is 0.30000000000000004, and a spreadsheet that
 * shows that instead of 0.3 has answered a different question than the one asked.
 */
function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toPrecision(15));
  return String(rounded);
}

function readSheet(zip, path, { strings, dateStyles, epoch1904 }) {
  const root = parseXml(zip.text(path));
  const data = element(root, 'sheetData');

  const rows = [];
  let widest = 0;
  let truncated = false;

  for (const row of elements(data, 'row')) {
    // A row carries its own number: blank rows are simply absent from the file,
    // and a reader that appends would slide everything below them upwards.
    const rowNumber = Number(attr(row, 'r') || rows.length + 1);
    if (rowNumber > MAX_PREVIEW_ROWS) {
      truncated = true;
      break;
    }
    while (rows.length < rowNumber - 1) rows.push([]);

    const cells = [];
    for (const cell of elements(row, 'c')) {
      const ref = attr(cell, 'r');
      const at = ref ? columnIndex(ref) : cells.length;
      if (at < 0 || at >= MAX_PREVIEW_COLUMNS) {
        truncated = truncated || at >= MAX_PREVIEW_COLUMNS;
        continue;
      }
      while (cells.length < at) cells.push(null);

      const type = attr(cell, 't') || 'n';
      const style = Number(attr(cell, 's') || -1);
      const formula = element(cell, 'f');
      const raw = element(cell, 'v');
      let text = '';
      let kind = 'n';

      if (type === 's') {
        kind = 's';
        text = strings[Number(textOf(raw || {}))] ?? '';
      } else if (type === 'inlineStr') {
        kind = 's';
        text = textOf(element(cell, 'is') || {});
      } else if (type === 'str') {
        kind = 's';
        text = textOf(raw || {});
      } else if (type === 'b') {
        kind = 'b';
        text = textOf(raw || {}) === '1' ? 'TRUE' : 'FALSE';
      } else if (type === 'e') {
        kind = 'e';
        text = textOf(raw || {});
      } else if (type === 'd') {
        // ISO 8601 in the cell itself, which the newer schema allows.
        kind = 'd';
        text = textOf(raw || {}).replace('T', ' ').replace(/\.\d+Z?$/, '');
      } else {
        const value = Number(textOf(raw || {}));
        if (!textOf(raw || {})) {
          text = '';
        } else if (dateStyles[style] && Number.isFinite(value)) {
          kind = 'd';
          text = formatDate(serialToDate(value, epoch1904));
        } else {
          text = formatNumber(value);
        }
      }

      cells[at] = text === '' && !formula ? null : { t: kind, v: text, ...(formula ? { f: textOf(formula) } : {}) };
    }

    // Trailing empties carry no information and make every row a different length.
    while (cells.length && cells[cells.length - 1] === null) cells.pop();
    widest = Math.max(widest, cells.length);
    rows.push(cells);
  }

  while (rows.length && !rows[rows.length - 1].length) rows.pop();

  const merges = [...descendants(root, 'mergeCell')].map((merge) => attr(merge, 'ref')).filter(Boolean);
  return { rows, columns: widest, truncated, merges };
}

/**
 * Read an .xlsx.
 *
 * @returns `{ sheets, text, meta }` — sheets carry display-ready cells, `text`
 *   is every sheet as a Markdown table, which is the shape a model reads best.
 */
export function readXlsx(buffer) {
  const zip = openZip(buffer);
  const workbookPath = mainPart(zip, 'xl/workbook.xml');
  if (!zip.has(workbookPath)) {
    throw Object.assign(new Error('That .xlsx has no workbook part — it may be corrupt.'), { code: 'not_xlsx' });
  }

  const root = parseXml(zip.text(workbookPath));
  const rels = readRelationships(zip, relsPathFor(workbookPath));
  const epoch1904 = String(attr(element(root, 'workbookPr'), 'date1904') || '') === 'true';

  let sharedPath = null;
  for (const [, rel] of rels) {
    if (rel.type === REL.sharedStrings) sharedPath = resolveTarget(workbookPath, rel.target);
  }

  const strings = readSharedStrings(zip, sharedPath);
  const dateStyles = readDateStyles(zip);

  const sheets = [];
  for (const sheet of descendants(element(root, 'sheets') || root, 'sheet')) {
    const id = relationshipId(sheet);
    const rel = id ? rels.get(id) : null;
    const path = rel ? resolveTarget(workbookPath, rel.target) : null;
    if (!path || !zip.has(path)) continue;

    // A hidden sheet is hidden for a reason, and reading it back out into a
    // preview undoes somebody's decision.
    const visible = String(attr(sheet, 'state') || 'visible') === 'visible';
    if (!visible) continue;

    const read = readSheet(zip, path, { strings, dateStyles, epoch1904 });
    sheets.push({ name: String(attr(sheet, 'name') || `Sheet${sheets.length + 1}`), ...read });
  }

  return { sheets, text: sheetsToText(sheets), meta: { sheets: sheets.length } };
}

/**
 * Sheets as Markdown tables.
 *
 * Every row is included until the budget runs out, and the cut is announced —
 * a model that silently receives the first 40 rows of a 4000-row sheet will
 * happily total them and call it the answer.
 */
export function sheetsToText(sheets) {
  const out = [];
  let used = 0;

  for (const sheet of sheets) {
    out.push(`## ${sheet.name}`);
    if (!sheet.rows.length) {
      out.push('(empty)', '');
      continue;
    }

    const width = Math.max(sheet.columns, 1);
    let wrote = 0;
    for (const row of sheet.rows) {
      const cells = Array.from({ length: width }, (_, i) => (row[i]?.v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
      const line = `| ${cells.join(' | ')} |`;
      if (used + line.length > MAX_TEXT_CHARS) {
        out.push(`[${sheet.rows.length - wrote} more rows not shown — the workbook is too large to include whole]`);
        break;
      }
      out.push(line);
      used += line.length;
      wrote += 1;
      // The header rule, after the first row, so the table reads as a table.
      if (wrote === 1) out.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
    }
    if (sheet.truncated) out.push(`[this sheet is larger than ${MAX_PREVIEW_ROWS} rows and was cut]`);
    out.push('');
  }

  return out.join('\n').trim();
}

/* ══ writing ═══════════════════════════════════════════════════════════ */

const SPREADSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

/**
 * Whether a piece of text is a number that should be stored as one.
 *
 * Deliberately strict. "0123" is a part number, "1.500.000" is a thousands
 * separator this cannot safely guess at, and a phone number is not a quantity —
 * turning any of them into a float loses information that cannot be recovered.
 * What is converted is what is unambiguously a number in the plain form.
 */
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function cellFor(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'n', value: String(value) };
  if (typeof value === 'boolean') return { type: 'b', value: value ? '1' : '0' };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // Stored as a serial with a date format, which is what makes it sortable
    // and subtractable rather than a label that happens to look like a date.
    const serial = value.getTime() / 86400000 + 25569;
    return { type: 'n', value: String(Number(serial.toFixed(10))), style: 2 };
  }

  const text = String(value);
  if (NUMERIC.test(text.trim())) return { type: 'n', value: text.trim() };
  return { type: 's', value: text };
}

/** How wide a column has to be to show what is in it, in Excel's character units. */
function columnWidths(rows, columns) {
  const widths = [];
  for (let column = 0; column < columns; column += 1) {
    let widest = 8;
    for (const row of rows) {
      const value = row[column];
      const length = value == null ? 0 : String(value instanceof Date ? '2024-01-01' : value).length;
      if (length > widest) widest = length;
    }
    // A little padding, and a ceiling — one 900-character cell must not produce
    // a column nobody can scroll past.
    widths.push(Math.min(widest + 2, 60));
  }
  return widths;
}

function sheetXml(sheet, sharedIndex) {
  const rows = sheet.rows || [];
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const header = sheet.header !== false && rows.length > 1;

  const body = rows
    .map((row, rowIndex) => {
      const cells = [];
      for (let column = 0; column < row.length; column += 1) {
        const cell = cellFor(row[column]);
        if (!cell) continue;
        const ref = `${columnName(column)}${rowIndex + 1}`;
        const style = header && rowIndex === 0 ? 1 : cell.style || 0;
        const attrs = `r="${ref}" s="${style}"`;

        if (cell.type === 's') {
          let index = sharedIndex.get(cell.value);
          if (index === undefined) {
            index = sharedIndex.size;
            sharedIndex.set(cell.value, index);
          }
          cells.push(`<c ${attrs} t="s"><v>${index}</v></c>`);
        } else if (cell.type === 'b') {
          cells.push(`<c ${attrs} t="b"><v>${cell.value}</v></c>`);
        } else {
          cells.push(`<c ${attrs}><v>${cell.value}</v></c>`);
        }
      }
      return `<row r="${rowIndex + 1}">${cells.join('')}</row>`;
    })
    .join('');

  const widths = columnWidths(rows, columns);
  const cols = widths
    .map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  const dimension = `<dimension ref="A1:${columnName(Math.max(columns - 1, 0))}${Math.max(rows.length, 1)}"/>`;

  // A frozen header stays put while you scroll, and the filter is what people
  // actually reach for the moment a table has more than a screenful of rows.
  const pane = header
    ? '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>'
    : '<sheetView workbookViewId="0"/>';
  const filter =
    header && rows.length > 1
      ? `<autoFilter ref="A1:${columnName(Math.max(columns - 1, 0))}${rows.length}"/>`
      : '';

  return (
    `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="${NS.officeRels}">` +
    `${dimension}<sheetViews>${pane}</sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `${cols ? `<cols>${cols}</cols>` : ''}` +
    `<sheetData>${body}</sheetData>${filter}</worksheet>`
  );
}

/**
 * The stylesheet: three cell formats, and every one of them is used.
 *
 *   0  ordinary
 *   1  the header row — bold on a tint, with a rule under it
 *   2  a date
 *
 * Excel requires the `cellStyleXfs` and `cellXfs` tables to exist even when
 * nothing is styled, and it requires index 0 of each to be the default. A
 * stylesheet that skips them is the classic "unreadable content" dialog.
 */
function stylesXml() {
  return (
    `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF1A1A1A"/><name val="Calibri"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3F7"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFB9C4CE"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/**
 * A sheet name Excel will accept.
 *
 * Excel refuses `: \ / ? * [ ]`, refuses more than 31 characters, and refuses
 * two sheets with the same name — and it refuses them by declaring the whole
 * file unreadable rather than by renaming anything.
 */
function sheetName(name, taken) {
  let clean = String(name || 'Sheet')
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31);
  if (!clean) clean = 'Sheet';

  let candidate = clean;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = clean.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Build an .xlsx.
 *
 * @param sheets `[{ name, rows: [[value]], header }]` — values may be strings,
 *   numbers, booleans, Dates or null
 * @returns a Buffer holding the whole package
 */
export function writeXlsx({ sheets, title = 'Workbook', author = 'Synapsez', created = new Date() } = {}) {
  const input = (Array.isArray(sheets) ? sheets : []).filter((sheet) => sheet && Array.isArray(sheet.rows));
  const list = input.length ? input : [{ name: 'Sheet1', rows: [[]] }];

  const taken = new Set();
  const shared = new Map();
  const parts = [];
  const named = list.map((sheet, i) => ({ ...sheet, name: sheetName(sheet.name || `Sheet${i + 1}`, taken) }));

  named.forEach((sheet, i) => {
    parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet, shared) });
  });

  const sharedStrings =
    `${XML_DECLARATION}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `count="${shared.size}" uniqueCount="${shared.size}">` +
    [...shared.keys()].map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('') +
    '</sst>';

  const workbook =
    `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="${NS.officeRels}">` +
    '<workbookPr/><bookViews><workbookView/></bookViews><sheets>' +
    named
      .map(
        (sheet, i) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const workbookRels =
    `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
    named
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL.worksheet}" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('') +
    `<Relationship Id="rId${named.length + 1}" Type="${REL.styles}" Target="styles.xml"/>` +
    `<Relationship Id="rId${named.length + 2}" Type="${REL.sharedStrings}" Target="sharedStrings.xml"/>` +
    '</Relationships>';

  const contentTypes = contentTypesXml([
    ['/xl/workbook.xml', `${SPREADSHEET}.sheet.main+xml`],
    ...named.map((_, i) => [`/xl/worksheets/sheet${i + 1}.xml`, `${SPREADSHEET}.worksheet+xml`]),
    ['/xl/styles.xml', `${SPREADSHEET}.styles+xml`],
    ['/xl/sharedStrings.xml', `${SPREADSHEET}.sharedStrings+xml`],
  ]);

  return writeZip(
    [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRelsXml('xl/workbook.xml') },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
      ...parts,
      { name: 'xl/styles.xml', data: stylesXml() },
      { name: 'xl/sharedStrings.xml', data: sharedStrings },
      { name: 'docProps/core.xml', data: corePropsXml({ title, author, created }) },
      { name: 'docProps/app.xml', data: appPropsXml({}) },
    ],
    { modified: new Date(created) },
  );
}

export const XLSX_MIME = MIME.xlsx;
