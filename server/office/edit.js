import { openZip, writeZip } from './zip.js';
import { decodeXml, parseXml, element, elements, attr, relationshipId } from './xml.js';
import { readRelationships, resolveTarget } from './opc.js';

/**
 * Changing an Office file somebody sent, in place (owner, 2026-11-05).
 *
 * The report: asked to fill in a column of their workbook, a model made a separate
 * Word file instead, because it had no way to touch the workbook at all. A library
 * that opens a workbook and saves it again is no answer either: it writes back what
 * it understood, which loses comments, hidden sheets, drawings and whatever else it
 * has no model of. So this edits the XML itself, the way a careful person with a zip
 * tool would. Only the cells or words named change; every other part of the file is
 * the same bytes, and the last thing done here is to read the result back and check
 * that that is so. A result that fails the check is an error, and nothing is saved.
 *
 * Works on strings rather than a parsed tree on purpose: a tree written back is a
 * rewrite of everything in it, which is what this exists to avoid. The tree parser
 * reads, and only reads.
 */

const MAX_CELL_EDITS = 2000;
const MAX_TEXT_EDITS = 500;
const MAX_CELL_CHARS = 32_000;
const REF = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

const escapeXml = (text) =>
  String(text)
    // What XML 1.0 cannot hold at all, and half of a character: either makes a file Excel refuses.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const escapeAttr = (text) => escapeXml(text).replace(/"/g, '&quot;');
const regexSafe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const columnNumber = (letters) => [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
const columnLetters = (number) => {
  let n = number;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};
const refOf = (text) => {
  const m = REF.exec(String(text || '').trim().toUpperCase().replace(/\$/g, ''));
  return m ? { col: columnNumber(m[1]), row: Number(m[2]), text: `${m[1]}${m[2]}` } : null;
};
const attrIn = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : undefined;
};
const setAttr = (attrs, name, value) => {
  const pattern = new RegExp(`\\s*\\b${name}="[^"]*"`);
  const without = attrs.replace(pattern, '');
  return value === undefined ? without : `${without} ${name}="${escapeAttr(value)}"`;
};

/** What the workbook's parts are, and which part each sheet is in. */
function readBook(zip) {
  const workbookPart = zip.names.find((name) => /^xl\/workbook\.xml$/i.test(name));
  if (!workbookPart) throw new Error('That workbook has no workbook part, so it may be corrupt.');
  const root = parseXml(zip.text(workbookPart));
  const relsPart = workbookPart.replace(/workbook\.xml$/i, '_rels/workbook.xml.rels');
  const rels = readRelationships(zip, relsPart);
  const sheets = [];
  for (const entry of elements(element(root, 'sheets'), 'sheet')) {
    const rel = rels.get(String(relationshipId(entry)));
    const part = rel ? resolveTarget(workbookPart, rel.target) : null;
    if (part && zip.has(part)) sheets.push({ name: String(attr(entry, 'name') || ''), part, state: String(attr(entry, 'state') || 'visible') });
  }
  return { workbookPart, relsPart, sheets };
}

function findSheet(sheets, wanted) {
  const said = String(wanted ?? '').trim();
  const asNumber = /^\d+$/.test(said) ? Number(said) : 0;
  const found =
    sheets.find((s) => s.name === said) ||
    sheets.find((s) => s.name.toLowerCase() === said.toLowerCase()) ||
    (asNumber >= 1 && asNumber <= sheets.length ? sheets[asNumber - 1] : null);
  if (!found) throw new Error(`There is no sheet called "${said}". The sheets are: ${sheets.map((s) => `"${s.name}"`).join(', ')}.`);
  return found;
}

/** The prefix a part's elements are written with: nearly always none. */
const prefixOf = (xml, local) => {
  const m = new RegExp(`<(\\w+:)?${local}[\\s>]`).exec(xml);
  return m?.[1] || '';
};

/** One row's pieces: its opening attributes and each cell, as written. */
function parseRows(sheetXml, p) {
  const open = sheetXml.search(new RegExp(`<${p}sheetData[\\s>/]`));
  if (open < 0) throw new Error('That worksheet has no sheetData, so it may be corrupt.');
  const closeTag = `</${p}sheetData>`;
  const close = sheetXml.indexOf(closeTag, open);
  const headEnd = sheetXml.indexOf('>', open) + 1;
  if (close < 0) {
    // <sheetData/>: an empty sheet.
    return { before: sheetXml.slice(0, open), after: sheetXml.slice(headEnd), head: `<${p}sheetData>`, tail: closeTag, rows: [] };
  }
  const rows = [];
  const body = sheetXml.slice(headEnd, close);
  const rowPattern = new RegExp(`<${p}row\\b([^>]*?)(/>|>([\\s\\S]*?)</${p}row>)`, 'g');
  let at = 0;
  for (const m of body.matchAll(rowPattern)) {
    at = Number(attrIn(m[1], 'r')) || at + 1;
    rows.push({ r: at, attrs: m[1], inner: m[3] ?? null, whole: m[0], changed: false });
  }
  return { before: sheetXml.slice(0, open), after: sheetXml.slice(close + closeTag.length), head: sheetXml.slice(open, headEnd), tail: closeTag, rows };
}

function parseCells(row, p) {
  const cells = [];
  if (!row.inner) return cells;
  const cellPattern = new RegExp(`<${p}c\\b([^>]*?)(/>|>([\\s\\S]*?)</${p}c>)`, 'g');
  let col = 0;
  for (const m of row.inner.matchAll(cellPattern)) {
    const ref = refOf(attrIn(m[1], 'r'));
    col = ref ? ref.col : col + 1;
    cells.push({ col, attrs: m[1], inner: m[3] ?? '', whole: m[0] });
  }
  return cells;
}

/** The text of one row's cell map, for the check at the end: ref → exactly what is written. */
function cellMap(sheetXml, p) {
  const map = new Map();
  for (const row of parseRows(sheetXml, p).rows) {
    for (const cell of parseCells(row, p)) map.set(`${columnLetters(cell.col)}${row.r}`, cell.whole);
  }
  return map;
}

/** A cell's new XML. Its style stays unless `style` says otherwise. */
function cellXml(p, ref, style, edit) {
  const s = style != null && style !== '' ? ` s="${style}"` : '';
  const at = `r="${ref}"${s}`;
  if (edit.formula != null) {
    const body = String(edit.formula).replace(/^=/, '');
    // Opened in Excel these reach out to an address: a change to a file is not the place to add that.
    // IMAGE and the IMPORT family too (2026-11-11): each fetches an address the moment the file opens.
    if (/\b(?:WEBSERVICE|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE|RTD|CALL|REGISTER\.ID)\s*\(/i.test(body)) throw new Error('A formula that reaches out to the internet or another program cannot be added here.');
    return `<${p}c ${at}><${p}f>${escapeXml(body)}</${p}f></${p}c>`;
  }
  const value = edit.value;
  if (value === null || value === undefined || value === '') return `<${p}c ${at}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<${p}c ${at}><${p}v>${value}</${p}v></${p}c>`;
  if (typeof value === 'boolean') return `<${p}c ${at} t="b"><${p}v>${value ? 1 : 0}</${p}v></${p}c>`;
  return `<${p}c ${at} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escapeXml(String(value))}</${p}t></${p}is></${p}c>`;
}

/** A column's width in characters, from what the sheet says. */
function columnWidths(sheetXml) {
  const widths = [];
  for (const m of sheetXml.matchAll(/<(?:\w+:)?col\b([^>]*?)\/?>/g)) {
    const lo = Number(attrIn(m[1], 'min')) || 0;
    const hi = Math.min(Number(attrIn(m[1], 'max')) || lo, lo + 200);
    const width = Number(attrIn(m[1], 'width')) || 0;
    if (lo && width) for (let c = lo; c <= hi; c += 1) widths[c] = width;
  }
  const format = /<(?:\w+:)?sheetFormatPr\b([^>]*?)\/?>/.exec(sheetXml)?.[1] || '';
  return { widths, standard: Number(attrIn(format, 'defaultColWidth')) || (Number(attrIn(format, 'baseColWidth')) || 8) + 1, rowHeight: Number(attrIn(format, 'defaultRowHeight')) || 15 };
}

/** How many lines some text takes in a column this many characters wide. */
const linesFor = (text, width) =>
  String(text)
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, width * 1.1))), 0);

/**
 * The styles part, for a cell whose words have to wrap: a copy of its style that
 * wraps. Appended, so every style already in use keeps its number.
 */
class Styles {
  constructor(xml) {
    this.xml = xml;
    this.added = new Map();
    const m = xml ? /<((?:\w+:)?)cellXfs\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml) : null;
    this.block = m;
    this.prefix = m?.[1] || '';
    this.xfs = m ? [...m[3].matchAll(/<(?:\w+:)?xf\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?xf>)/g)].map((x) => x[0]) : [];
    this.changed = false;
  }

  wraps(index) {
    return /\bwrapText="(?:1|true)"/.test(this.xfs[Number(index) || 0] || '');
  }

  /** The number of a style like this one that wraps, adding it if there is none yet. */
  wrapped(index) {
    const key = Number(index) || 0;
    if (!this.block || !this.xfs.length) return index;
    if (this.wraps(key)) return key;
    if (this.added.has(key)) return this.added.get(key);
    const p = this.prefix;
    const base = this.xfs[key] || this.xfs[0];
    let copy;
    if (/<(?:\w+:)?alignment\b/.test(base)) {
      copy = base.replace(/<((?:\w+:)?alignment)\b([^>]*?)\/>/, (_, tag, attrs) => `<${tag}${setAttr(attrs, 'wrapText', '1')}${/\bvertical=/.test(attrs) ? '' : ' vertical="top"'}/>`);
    } else if (base.endsWith('/>')) {
      copy = `${base.slice(0, -2)}><${p}alignment wrapText="1" vertical="top"/></${p}xf>`;
    } else {
      copy = base.replace(/>/, `><${p}alignment wrapText="1" vertical="top"/>`);
    }
    copy = copy.replace(/^(<(?:\w+:)?xf\b[^>]*?)(\/?>)/, (_, head, end) => `${setAttr(head, 'applyAlignment', '1')}${end}`);
    this.xfs.push(copy);
    this.added.set(key, this.xfs.length - 1);
    this.changed = true;
    return this.xfs.length - 1;
  }

  toXml() {
    if (!this.changed) return this.xml;
    const { block } = this;
    const attrs = setAttr(block[2], 'count', String(this.xfs.length));
    return `${this.xml.slice(0, block.index)}<${block[1]}cellXfs${attrs}>${this.xfs.join('')}</${block[1]}cellXfs>${this.xml.slice(block.index + block[0].length)}`;
  }
}

/** Every merge on a sheet, for a cell that is not the one a merge shows. */
function mergesOf(sheetXml) {
  const merges = [];
  for (const m of sheetXml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*?\bref="([^"]+)"/g)) {
    const [a, b] = m[1].split(':');
    const from = refOf(a);
    const to = refOf(b || a);
    if (from && to) merges.push({ from, to, ref: m[1] });
  }
  return merges;
}

/**
 * Change cells of a worksheet, leaving everything else as it is.
 *
 * @param {Buffer} buffer
 * @param {{ sheet?: string|number, cell: string, value?: any, formula?: string, style_from?: string, row_height?: number }[]} edits
 * @returns {{ buffer: Buffer, changed: { sheet: string, cells: string[] }[], parts: string[], notes: string[], sheetNumbers: number[] }}
 */
export function editWorkbook(buffer, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('Say which cells to change, in `cells`.');
  if (edits.length > MAX_CELL_EDITS) throw new Error(`Change at most ${MAX_CELL_EDITS} cells in one call.`);
  const zip = openZip(buffer);
  const book = readBook(zip);
  if (!book.sheets.length) throw new Error('No sheet in that workbook could be found.');
  const stylesPart = zip.names.find((name) => /^xl\/styles\.xml$/i.test(name));
  const styles = new Styles(stylesPart ? zip.text(stylesPart) : '');

  /** @type {Map<string, { sheet: any, edits: any[] }>} */
  const bySheet = new Map();
  for (const [i, edit] of edits.entries()) {
    if (edit?.sheet == null && book.sheets.length > 1) throw new Error(`Cell ${i + 1} (${edit?.cell}) does not say which sheet. The sheets are: ${book.sheets.map((s) => `"${s.name}"`).join(', ')}.`);
    const sheet = edit?.sheet == null ? book.sheets[0] : findSheet(book.sheets, edit.sheet);
    const ref = refOf(edit?.cell);
    if (!ref) throw new Error(`"${edit?.cell}" is not a cell address like K18.`);
    if (typeof edit.value === 'string' && edit.value.length > MAX_CELL_CHARS) throw new Error(`${ref.text} would hold ${edit.value.length} characters; a cell holds ${MAX_CELL_CHARS}.`);
    if (!bySheet.has(sheet.part)) bySheet.set(sheet.part, { sheet, edits: [] });
    bySheet.get(sheet.part).edits.push({ ...edit, ref });
  }

  const replaced = new Map();
  const notes = [];
  let removedFormula = false;
  let anyFormula = false;
  const changed = [];
  for (const { sheet, edits: list } of bySheet.values()) {
    const original = zip.text(sheet.part);
    const p = prefixOf(original, 'worksheet');
    const parsed = parseRows(original, p);
    const size = columnWidths(original);
    const merges = mergesOf(original);
    const rowsByNumber = new Map(parsed.rows.map((row) => [row.r, row]));
    const touched = new Map();
    const cellsOf = (row) => {
      if (!touched.has(row.r)) touched.set(row.r, parseCells(row, p));
      return touched.get(row.r);
    };

    for (const edit of list) {
      const { ref } = edit;
      const covering = merges.find((m) => ref.row >= m.from.row && ref.row <= m.to.row && ref.col >= m.from.col && ref.col <= m.to.col);
      if (covering && (covering.from.row !== ref.row || covering.from.col !== ref.col)) {
        throw new Error(`${ref.text} on "${sheet.name}" is inside the merged cells ${covering.ref}; only ${covering.from.text} shows anything there. Change that one.`);
      }
      let row = rowsByNumber.get(ref.row);
      if (!row) {
        row = { r: ref.row, attrs: ` r="${ref.row}"`, inner: '', whole: '', changed: true, fresh: true };
        rowsByNumber.set(ref.row, row);
        parsed.rows.push(row);
      }
      const cells = cellsOf(row);
      const existing = cells.find((c) => c.col === ref.col);
      if (existing && /<(?:\w+:)?f\b[^>]*\bt="(?:shared|array)"[^>]*\bref="/.test(existing.inner)) {
        throw new Error(`${ref.text} on "${sheet.name}" starts a formula other cells share, so it cannot be changed on its own. Do this one with sandbox_run and openpyxl.`);
      }
      if (existing && /<(?:\w+:)?f[\s>/]/.test(existing.inner)) removedFormula = true;
      if (edit.formula != null) anyFormula = true;

      let style = existing ? attrIn(existing.attrs, 's') : attrIn(row.attrs, 's') ?? undefined;
      if (edit.style_from) {
        const from = refOf(edit.style_from);
        if (!from) throw new Error(`"${edit.style_from}" is not a cell address like K17.`);
        const fromRow = rowsByNumber.get(from.row);
        const fromCell = fromRow ? cellsOf(fromRow).find((c) => c.col === from.col) : null;
        if (fromCell) style = attrIn(fromCell.attrs, 's');
      }

      // Words longer than the cell: wrap them, and make the row tall enough to show them.
      const text = typeof edit.value === 'string' ? edit.value : '';
      if (text) {
        const span = covering ? Array.from({ length: covering.to.col - covering.from.col + 1 }, (_, i) => covering.from.col + i) : [ref.col];
        const width = span.reduce((sum, c) => sum + (size.widths[c] || size.standard), 0);
        const lines = linesFor(text, width);
        if (lines > 1) {
          const wrapped = styles.wrapped(style ?? 0);
          if (String(wrapped) !== String(style ?? 0)) style = wrapped;
          const need = Math.ceil(lines * size.rowHeight + 2);
          const have = Number(attrIn(row.attrs, 'ht')) || size.rowHeight;
          // Past Excel's own ceiling a row cannot go; the words are still in the cell.
          if (need > have) {
            row.attrs = setAttr(setAttr(row.attrs, 'ht', String(Math.min(need, 409))), 'customHeight', '1');
            if (need > 409) notes.push(`${ref.text} on "${sheet.name}" holds more than the tallest row Excel allows can show; the words are all in the cell.`);
          }
        }
      }
      if (Number(edit.row_height) > 0) row.attrs = setAttr(setAttr(row.attrs, 'ht', String(Math.min(Number(edit.row_height), 409))), 'customHeight', '1');

      const fresh = cellXml(p, ref.text, style, edit);
      // Its style stays readable: a later change in this call may copy the look from here.
      const piece = { col: ref.col, attrs: style == null ? '' : ` s="${style}"`, inner: '', whole: fresh };
      if (existing) cells[cells.indexOf(existing)] = piece;
      else cells.splice(cells.filter((c) => c.col < ref.col).length, 0, piece);
      row.changed = true;
    }

    // Written back: untouched rows exactly as they were read.
    parsed.rows.sort((a, b) => a.r - b.r);
    const rowXml = parsed.rows
      .map((row) => {
        if (!row.changed) return row.whole;
        const cells = touched.get(row.r) || [];
        const lastCol = cells.length ? cells[cells.length - 1].col : 0;
        const attrs = attrIn(row.attrs, 'spans') && lastCol > Number(String(attrIn(row.attrs, 'spans')).split(':')[1]) ? setAttr(row.attrs, 'spans', `${String(attrIn(row.attrs, 'spans')).split(':')[0]}:${lastCol}`) : row.attrs;
        return `<${p}row${attrs}>${cells.map((c) => c.whole).join('')}</${p}row>`;
      })
      .join('');
    let next = `${parsed.before}${parsed.head}${rowXml}${parsed.tail}${parsed.after}`;

    // The used range grows with what was added: some readers stop at what it says.
    next = next.replace(new RegExp(`(<${p}dimension\\b[^>]*?\\bref=")([^"]+)(")`), (whole, a, range, c) => {
      const [from, to] = range.split(':');
      const lo = refOf(from);
      const hi = refOf(to || from);
      if (!lo || !hi) return whole;
      const maxCol = Math.max(hi.col, ...list.map((e) => e.ref.col));
      const maxRow = Math.max(hi.row, ...list.map((e) => e.ref.row));
      return `${a}${lo.text}:${columnLetters(maxCol)}${maxRow}${c}`;
    });

    // The check that is this file's reason to exist.
    const allowed = new Set(list.map((e) => e.ref.text));
    const before = cellMap(original, p);
    const after = cellMap(next, p);
    for (const [ref, written] of after) {
      if (!allowed.has(ref) && before.get(ref) !== written) throw new Error(`Changing "${sheet.name}" would also have changed ${ref}, so nothing was saved.`);
    }
    for (const ref of before.keys()) {
      if (!allowed.has(ref) && !after.has(ref)) throw new Error(`Changing "${sheet.name}" would have lost ${ref}, so nothing was saved.`);
    }
    replaced.set(sheet.part, next);
    changed.push({ sheet: sheet.name, cells: [...allowed] });
  }

  if (styles.changed) replaced.set(stylesPart, styles.toXml());

  /*
   * Excel works formulas out again on opening, since what they read may have
   * changed. A cell that stopped being a formula must also leave Excel's list of
   * them, or Excel says the file is damaged; the list is optional and Excel makes a
   * new one, so it goes.
   */
  const removed = new Set();
  const anyFormulaInBook = anyFormula || book.sheets.some((s) => /<(?:\w+:)?f[\s>/]/.test(replaced.get(s.part) ?? zip.text(s.part)));
  if (anyFormulaInBook) {
    const xml = zip.text(book.workbookPart);
    let next;
    if (/<(?:\w+:)?calcPr\b/.test(xml)) {
      next = xml.replace(/<((?:\w+:)?calcPr)\b([^>]*?)(\/?)>/, (_, tag, attrs, end) => `<${tag}${setAttr(attrs, 'fullCalcOnLoad', '1')}${end}>`);
    } else {
      const p = prefixOf(xml, 'workbook');
      const after = /<\/(?:\w+:)?definedNames>/.exec(xml) || /<\/(?:\w+:)?externalReferences>/.exec(xml) || /<\/(?:\w+:)?sheets>/.exec(xml);
      if (!after) throw new Error('That workbook has no list of sheets, so it may be corrupt.');
      const at = after.index + after[0].length;
      next = `${xml.slice(0, at)}<${p}calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
    }
    replaced.set(book.workbookPart, next);
    notes.push('Formulas that read these cells work themselves out again when the file is opened in Excel; until then a viewer shows their last saved results.');
  }
  if (removedFormula) {
    const chain = zip.names.find((name) => /^xl\/calcChain\.xml$/i.test(name));
    if (chain) {
      removed.add(chain);
      if (zip.has(book.relsPart)) replaced.set(book.relsPart, zip.text(book.relsPart).replace(/<(?:\w+:)?Relationship\b[^>]*calcChain[^>]*\/>/, ''));
      const types = zip.names.find((name) => name === '[Content_Types].xml');
      if (types) replaced.set(types, zip.text(types).replace(/<(?:\w+:)?Override\b[^>]*calcChain[^>]*\/>/, ''));
    }
  }

  const out = rebuild(zip, replaced, removed);
  // Counted among the sheets that are drawn: a hidden one has no picture to look at.
  const numbers = book.sheets.filter((s) => s.state === 'visible').map((s, i) => (bySheet.has(s.part) ? i + 1 : 0)).filter(Boolean);
  return { buffer: out, changed, parts: [...replaced.keys()], notes, sheetNumbers: numbers };
}

const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
/** A character from the private range, which no document holds. */
const REPLACING = '\uE000';

/** The file again: the same parts in the same order, with only the named ones different. */
function rebuild(zip, replaced, removed = new Set()) {
  const parts = [];
  let total = 0;
  for (const name of zip.names) {
    if (removed.has(name)) continue;
    const data = replaced.has(name) ? Buffer.from(replaced.get(name), 'utf8') : zip.read(name);
    // A part's own ceiling is no ceiling on eighty of them, all held here at once.
    total += data.length;
    if (total > MAX_UNPACKED_BYTES) throw new Error('That file unpacks to more than can be changed here.');
    parts.push({ name, data });
  }
  const out = writeZip(parts);
  // Read back: everything not named here has to be the bytes it was.
  const again = openZip(out);
  for (const name of zip.names) {
    if (removed.has(name) || replaced.has(name)) continue;
    if (!again.has(name) || !again.read(name).equals(zip.read(name))) throw new Error(`Rebuilding the file would have changed ${name}, so nothing was saved.`);
  }
  return out;
}

/**
 * Words in a paragraph can be cut across any number of runs, each with its own
 * formatting. The replacement goes in the run the match starts in, keeping that
 * run's look, and the rest of the match comes out of the runs it reaches.
 */
function replaceInParagraph(paragraph, pieces, find, replace, textTag) {
  const text = pieces.map((piece) => piece.text).join('');
  const at = text.indexOf(find);
  if (at < 0) return null;
  const end = at + find.length;
  let cursor = 0;
  let placed = false;
  let out = '';
  let last = 0;
  for (const piece of pieces) {
    const from = cursor;
    const to = cursor + piece.text.length;
    cursor = to;
    out += paragraph.slice(last, piece.start);
    last = piece.end;
    if (to <= at || from >= end) {
      out += paragraph.slice(piece.start, piece.end);
      continue;
    }
    const keepBefore = piece.text.slice(0, Math.max(0, at - from));
    const keepAfter = piece.text.slice(Math.max(0, end - from));
    const inner = `${keepBefore}${placed ? '' : replace}${keepAfter}`;
    placed = true;
    out += `<${textTag} xml:space="preserve">${escapeXml(inner)}</${textTag}>`;
  }
  out += paragraph.slice(last);
  return out;
}

function textPieces(paragraph, textTag) {
  const pieces = [];
  const pattern = new RegExp(`<${regexSafe(textTag)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${regexSafe(textTag)}>)`, 'g');
  for (const m of paragraph.matchAll(pattern)) {
    pieces.push({ start: m.index, end: m.index + m[0].length, text: decodeXml(m[1] ?? '') });
  }
  return pieces;
}

/**
 * Change words in a Word document or a deck, wherever they fall across its runs,
 * keeping the look they had. As with a source edit, a `find` must be there exactly
 * once unless `all` says otherwise, so a change cannot land somewhere nobody meant.
 *
 * @param {Buffer} buffer
 * @param {'docx'|'pptx'} format
 * @param {{ find: string, replace?: string, all?: boolean, slide?: number, add_after?: string }[]} edits
 * @returns {{ buffer: Buffer, changed: number, parts: string[], notes: string[] }}
 */
export function editDocument(buffer, format, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('Say what to change, in `edits`.');
  if (edits.length > MAX_TEXT_EDITS) throw new Error(`Make at most ${MAX_TEXT_EDITS} changes in one call.`);
  const zip = openZip(buffer);
  const word = format === 'docx';
  const partPattern = word ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i : /^ppt\/slides\/slide\d+\.xml$/i;
  const parts = zip.names.filter((name) => partPattern.test(name)).sort((a, b) => {
    const number = (s) => Number(/(\d+)\.xml$/.exec(s)?.[1] || 0);
    return number(a) - number(b);
  });
  if (!parts.length) throw new Error(`That file has no ${word ? 'document' : 'slide'} part, so it may be corrupt.`);
  const paragraphTag = word ? 'w:p' : 'a:p';
  const textTag = word ? 'w:t' : 'a:t';
  const paragraphPattern = new RegExp(`<${paragraphTag}(?:\\s[^>]*)?>[\\s\\S]*?</${paragraphTag}>`, 'g');
  const current = new Map(parts.map((name) => [name, zip.text(name)]));
  let changed = 0;

  edits.forEach((edit, i) => {
    const find = String(edit?.find ?? '');
    if (!find) throw new Error(`Change ${i + 1} has nothing to find.`);
    const scope = edit?.slide != null && !word ? parts.filter((name) => new RegExp(`slide${Number(edit.slide)}\\.xml$`, 'i').test(name)) : parts;
    if (!scope.length) throw new Error(`There is no slide ${edit.slide}.`);
    const replace = edit?.replace == null ? '' : String(edit.replace);
    let hits = 0;
    const pending = new Map();
    for (const name of scope) {
      const xml = pending.get(name) ?? current.get(name);
      const next = xml.replace(paragraphPattern, (paragraph) => {
        let text = paragraph;
        // A replacement holding what it replaces would be found again for ever, so it is
        // held as a mark until every match in the paragraph has gone.
        const circular = !!edit?.all && replace.includes(find);
        const writing = circular ? REPLACING : replace;
        for (;;) {
          const pieces = textPieces(text, textTag);
          const joined = pieces.map((piece) => piece.text).join('');
          if (!joined.includes(find)) return circular ? text.split(REPLACING).join(escapeXml(replace)) : text;
          hits += 1;
          if (hits > 1 && !edit?.all) return text;
          if (edit?.add_after != null) {
            // A new paragraph after this one, looking like it.
            const look = /<(?:w:pPr|a:pPr)\b[\s\S]*?<\/(?:w:pPr|a:pPr)>|<(?:w:pPr|a:pPr)\b[^>]*\/>/.exec(text)?.[0] || '';
            const runLook = /<(?:w:rPr|a:rPr)\b[\s\S]*?<\/(?:w:rPr|a:rPr)>|<(?:w:rPr|a:rPr)\b[^>]*\/>/.exec(text)?.[0] || '';
            const run = word ? 'w:r' : 'a:r';
            return `${text}<${paragraphTag}>${look}<${run}>${runLook}<${textTag} xml:space="preserve">${escapeXml(String(edit.add_after))}</${textTag}></${run}></${paragraphTag}>`;
          }
          const swapped = replaceInParagraph(text, pieces, find, writing, textTag);
          text = swapped ?? text;
          if (!edit?.all) return text;
        }
      });
      pending.set(name, next);
    }
    if (!hits) throw new Error(`Change ${i + 1} did not match: "${find.slice(0, 80)}" is not in the file. Read it with read_generated_file and copy the words exactly.`);
    if (hits > 1 && !edit?.all) throw new Error(`Change ${i + 1} matches ${hits} places: "${find.slice(0, 80)}". Include more of the words around it, or say \`all\`.`);
    for (const [name, xml] of pending) current.set(name, xml);
    changed += hits;
  });

  const replaced = new Map([...current].filter(([name, xml]) => xml !== zip.text(name)));
  return { buffer: rebuild(zip, replaced), changed, parts: [...replaced.keys()], notes: [] };
}

/**
 * What a workbook holds, by address: what `update_file` needs to know to change it.
 * Every sheet is listed, hidden ones too; a person may mean one of those, and nothing
 * else in this app ever shows them.
 *
 * @param {Buffer} buffer
 * @param {{ sheet?: string|number, range?: string, find?: string, maxChars?: number }} [ask]
 * @returns {string}
 */
export function readWorkbookCells(buffer, { sheet, range, find, maxChars = 30_000 } = {}) {
  const zip = openZip(buffer);
  const book = readBook(zip);
  const stringsPart = zip.names.find((name) => /^xl\/sharedStrings\.xml$/i.test(name));
  const strings = stringsPart
    ? [...zip.text(stringsPart).matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) =>
        [...String(m[1] ?? '').matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((t) => decodeXml(t[1] ?? '')).join(''),
      )
    : [];
  const read = (cell) => {
    const type = attrIn(cell.attrs, 't');
    const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cell.inner)?.[1];
    const formula = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/.exec(cell.inner)?.[1];
    let value = '';
    if (type === 's') value = strings[Number(v)] ?? '';
    else if (type === 'inlineStr') value = [...cell.inner.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((t) => decodeXml(t[1] ?? '')).join('');
    else if (v !== undefined) value = decodeXml(v);
    return { value, formula: formula === undefined ? null : decodeXml(formula), shared: /<(?:\w+:)?f\b[^>]*\bt="shared"/.test(cell.inner) };
  };
  const commentsOf = (part) => {
    const relsPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
    if (!zip.has(relsPath)) return new Map();
    const target = /Target="([^"]*comments[^"]*)"/i.exec(zip.text(relsPath))?.[1];
    if (!target) return new Map();
    const path = resolveTarget(part, target);
    if (!zip.has(path)) return new Map();
    const out = new Map();
    for (const m of zip.text(path).matchAll(/<(?:\w+:)?comment\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?comment>/g)) {
      const said = [...m[2].matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((t) => decodeXml(t[1] ?? '')).join('');
      out.set(String(attrIn(m[1], 'ref')), said.trim());
    }
    return out;
  };
  const dimension = (xml) => /<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/.exec(xml)?.[1] || '';

  if (find != null && String(find).trim()) {
    const wanted = String(find).trim().toLowerCase();
    const hits = [];
    for (const s of book.sheets) {
      const xml = zip.text(s.part);
      const p = prefixOf(xml, 'worksheet');
      const comments = commentsOf(s.part);
      for (const row of parseRows(xml, p).rows) {
        for (const cell of parseCells(row, p)) {
          const { value, formula } = read(cell);
          const ref = `${columnLetters(cell.col)}${row.r}`;
          const note = comments.get(ref);
          if (`${value}\n${formula ?? ''}\n${note ?? ''}`.toLowerCase().includes(wanted)) {
            hits.push(`"${s.name}"!${ref}: ${String(value).slice(0, 160)}${formula ? ` (=${formula.slice(0, 80)})` : ''}${note ? ` [comment: ${note.slice(0, 160)}]` : ''}`);
          }
        }
      }
      for (const [ref, note] of comments) if (note.toLowerCase().includes(wanted) && !hits.some((h) => h.startsWith(`"${s.name}"!${ref}:`))) hits.push(`"${s.name}"!${ref}: [comment: ${note.slice(0, 160)}]`);
    }
    if (!hits.length) return `Nothing in any sheet, hidden ones included, says "${find}".`;
    return `${hits.length} place${hits.length === 1 ? '' : 's'} say "${find}":\n${hits.slice(0, 200).join('\n')}${hits.length > 200 ? '\n… and more; say more exactly what to find.' : ''}`;
  }

  if (sheet == null) {
    const lines = book.sheets.map((s, i) => {
      const xml = zip.text(s.part);
      const comments = commentsOf(s.part).size;
      return `${i + 1}. "${s.name}"${s.state === 'visible' ? '' : ` (${s.state})`}${dimension(xml) ? ` ${dimension(xml)}` : ''}${comments ? `, ${comments} comment${comments === 1 ? '' : 's'}` : ''}`;
    });
    return `${book.sheets.length} sheet${book.sheets.length === 1 ? '' : 's'}:\n${lines.join('\n')}\nAsk for a sheet, with a range if it is long, to read its cells by address. \`find\` looks through all of them.`;
  }

  const target = findSheet(book.sheets, sheet);
  const xml = zip.text(target.part);
  const p = prefixOf(xml, 'worksheet');
  const comments = commentsOf(target.part);
  let box = null;
  if (range) {
    const [a, b] = String(range).split(':');
    const from = refOf(a);
    const to = refOf(b || a);
    if (!from || !to) throw new Error(`"${range}" is not a range like A1:K40.`);
    box = { c0: Math.min(from.col, to.col), c1: Math.max(from.col, to.col), r0: Math.min(from.row, to.row), r1: Math.max(from.row, to.row) };
  }
  const lines = [];
  let used = 0;
  let stoppedAt = '';
  for (const row of parseRows(xml, p).rows) {
    if (box && (row.r < box.r0 || row.r > box.r1)) continue;
    for (const cell of parseCells(row, p)) {
      if (box && (cell.col < box.c0 || cell.col > box.c1)) continue;
      const { value, formula, shared } = read(cell);
      const ref = `${columnLetters(cell.col)}${row.r}`;
      const note = comments.get(ref);
      if (value === '' && !formula && !shared && !note) continue;
      const line = `${ref}: ${value}${formula ? `  (=${formula})` : shared ? '  (shared formula)' : ''}${note ? `  [comment: ${note}]` : ''}`;
      used += line.length + 1;
      if (used > maxChars) {
        stoppedAt = ref;
        break;
      }
      lines.push(line);
    }
    if (stoppedAt) break;
  }
  const merged = mergesOf(xml)
    .filter((m) => !box || (m.from.row <= box.r1 && m.to.row >= box.r0 && m.from.col <= box.c1 && m.to.col >= box.c0))
    .map((m) => m.ref);
  return (
    `"${target.name}"${target.state === 'visible' ? '' : ` (${target.state})`}${dimension(xml) ? ` ${dimension(xml)}` : ''}${range ? `, ${String(range).toUpperCase()}` : ''}:\n` +
    `${lines.join('\n') || '(nothing there)'}` +
    (merged.length ? `\nMerged: ${merged.slice(0, 80).join(', ')}` : '') +
    (stoppedAt ? `\n… it goes on from ${stoppedAt}; ask for the range from there.` : '')
  );
}

/** What job.worker.mjs can be asked to do, by name. @param {string} job @param {Buffer} bytes @param {any[]} args */
export function runJob(job, bytes, args) {
  if (job === 'editWorkbook') return editWorkbook(bytes, args[0]);
  if (job === 'editDocument') return editDocument(bytes, args[0], args[1]);
  if (job === 'readWorkbookCells') return readWorkbookCells(bytes, args[0]);
  if (job === 'readDocumentWords') return readDocumentWords(bytes, args[0], args[1]);
  throw new Error(`No such job: ${job}`);
}

/**
 * The words of a Word document or deck, as they stand, for finding what to change:
 * numbered, and with no attempt at Markdown, because `find` has to match the words.
 *
 * @param {Buffer} buffer
 * @param {'docx'|'pptx'} format
 * @param {{ slide?: number, maxChars?: number }} [ask]
 */
export function readDocumentWords(buffer, format, { slide, maxChars = 30_000 } = {}) {
  const zip = openZip(buffer);
  const word = format === 'docx';
  const parts = zip.names
    .filter((name) => (word ? /^word\/document\.xml$/i : /^ppt\/slides\/slide\d+\.xml$/i).test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] || 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] || 0));
  const paragraphTag = word ? 'w:p' : 'a:p';
  const textTag = word ? 'w:t' : 'a:t';
  const out = [];
  let used = 0;
  for (const name of parts) {
    const number = Number(/(\d+)\.xml$/.exec(name)?.[1] || 0);
    if (!word && slide != null && number !== Number(slide)) continue;
    if (!word) out.push(`--- slide ${number} ---`);
    for (const m of zip.text(name).matchAll(new RegExp(`<${paragraphTag}(?:\\s[^>]*)?>[\\s\\S]*?</${paragraphTag}>`, 'g'))) {
      const line = textPieces(m[0], textTag).map((piece) => piece.text).join('');
      if (!line.trim()) continue;
      used += line.length + 1;
      if (used > maxChars) return `${out.join('\n')}\n… it goes on past what fits here.`;
      out.push(line);
    }
  }
  return out.join('\n') || '(no words in it)';
}
