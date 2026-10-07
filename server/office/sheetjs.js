/**
 * The second reader for spreadsheets: SheetJS.
 *
 * `xlsx.js` reads the Open XML workbooks people mostly send, with no dependency
 * at all. It cannot read the others — an Excel 97–2003 `.xls` (a compound-file
 * binary, still what many accounting and school systems export), an Excel
 * binary `.xlsb`, an OpenDocument `.ods`, an "Excel" file that is really an HTML
 * table or SpreadsheetML 2003 XML — and a workbook it gives up on would
 * otherwise reach the model as "nothing could be read". SheetJS reads all of
 * them, so it is the fallback rather than the first choice: the in-house reader
 * stays the fast, dependency-free path for the common case.
 *
 * Loaded on demand, and run on a worker thread by `sheets.js` — a parser this
 * size over somebody's file gets a deadline and a heap of its own, the same as
 * a PDF (PERF-022). What comes back is the shape `xlsx.js` produces, so the
 * preview, the model's Markdown and the copy button cannot tell the readers
 * apart.
 */
import { MAX_PREVIEW_COLUMNS, MAX_PREVIEW_ROWS, columnName } from './xlsx.js';

let loaded = null;

/** SheetJS, with the code pages an old `.xls` in Vietnamese (1258) or Chinese needs. */
async function sheetjs() {
  if (!loaded) {
    loaded = (async () => {
      const XLSX = await import('xlsx');
      const cptable = await import('xlsx/dist/cpexcel.full.mjs');
      XLSX.set_cptable(cptable);
      return XLSX;
    })();
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}

/** A cell as the text a person sees in it, and the kind `xlsx.js` would give it. */
function cellOf(cell) {
  if (!cell || cell.t === 'z') return null;
  const formula = cell.f ? String(cell.f) : '';
  let text = cell.w != null ? String(cell.w) : cell.v == null ? '' : String(cell.v);
  let kind = 'n';
  if (cell.t === 's') kind = 's';
  else if (cell.t === 'b') {
    kind = 'b';
    text = cell.v ? 'TRUE' : 'FALSE';
  } else if (cell.t === 'e') kind = 'e';
  else if (cell.t === 'd') kind = 'd';
  if (text === '' && !formula) return null;
  return { t: kind, v: text, ...(formula ? { f: formula } : {}) };
}

/**
 * Read any spreadsheet SheetJS knows into `xlsx.js`'s sheets.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ sheets: Array<{ name: string, rows: any[][], columns: number, truncated: boolean, merges: string[] }> }>}
 */
export async function readSheetsWithSheetJS(buffer) {
  const XLSX = await sheetjs();
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      dense: true,
      cellFormula: true,
      cellText: true,
      cellDates: false,
      // Stops reading where the preview stops drawing — a 200,000-row export
      // is not parsed in full to show 2,000 rows of it.
      sheetRows: MAX_PREVIEW_ROWS + 1,
    });
  } catch (err) {
    const message = String(err?.message || err);
    if (/password|encrypt/i.test(message)) {
      throw Object.assign(new Error('That workbook is password-protected, so it cannot be read.'), { code: 'encrypted' });
    }
    throw Object.assign(new Error(`That spreadsheet could not be read: ${message}`), { code: 'unreadable' });
  }

  const sheets = [];
  workbook.SheetNames.forEach((name, index) => {
    // A hidden sheet is hidden for a reason — the same rule as `xlsx.js`.
    if (workbook.Workbook?.Sheets?.[index]?.Hidden) return;
    const sheet = workbook.Sheets[name];
    if (!sheet) return;
    const data = sheet['!data'] || [];
    const full = sheet['!fullref'] ? XLSX.utils.decode_range(sheet['!fullref']) : null;
    let truncated = (!!full && full.e.r + 1 > MAX_PREVIEW_ROWS) || data.length > MAX_PREVIEW_ROWS;

    const rows = [];
    let widest = 0;
    for (let r = 0; r < Math.min(data.length, MAX_PREVIEW_ROWS); r += 1) {
      const source = data[r] || [];
      const cells = [];
      for (let c = 0; c < source.length; c += 1) {
        if (c >= MAX_PREVIEW_COLUMNS) {
          if (source.slice(c).some((cell) => cellOf(cell))) truncated = true;
          break;
        }
        cells.push(cellOf(source[c]));
      }
      while (cells.length && cells[cells.length - 1] === null) cells.pop();
      widest = Math.max(widest, cells.length);
      rows.push(cells);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();

    const merges = (sheet['!merges'] || []).map((range) => `${columnName(range.s.c)}${range.s.r + 1}:${columnName(range.e.c)}${range.e.r + 1}`);
    sheets.push({ name: String(name || `Sheet${sheets.length + 1}`), rows, columns: widest, truncated, merges });
  });

  return { sheets };
}
