/**
 * An Excel workbook, drawn as it looks on screen.
 *
 * A worksheet is a grid, not pages, so each is drawn from the top left with its row
 * numbers and column letters, which is what lets a model say "C7" and be right. One
 * too large for a picture is cut into pieces that repeat those headers and any frozen
 * rows. What Excel works out when it opens a file (an Excel table's banding, data
 * bars, colour scales, a row grown to fit its wrapped words, `####`) is worked out
 * here too, because those are exactly what a person sees and a text reading misses.
 */
import { attr, element, elements, localName, parseXml, relationshipId, textOf } from '../xml.js';
import { isRel, mainPart, readRelationships, relsPathFor, resolveTarget } from '../opc.js';
import { LIMITS, Surface, css, emu, lightness, refused } from './common.js';
import { drawNode, labelledBox, readTheme, readXfrm } from './dml.js';
import { drawChart } from './chart.js';
import { drawShapeText } from './pptx.js';
import { paintLine, setLines } from './text.js';

/** How much of a sheet one picture holds, in points: a little over a screenful. */
const PIECE_W = 1150;
const PIECE_H = 1100;
/** Past this a sheet is a database, and the rest is said rather than drawn. */
const MAX_PIECES = 24;

const HEAD_H = 15;
const GRID = '#D9DCE1';
const HEAD_FILL = '#F1F3F5';
const HEAD_LINE = '#C5CAD1';
const HEAD_INK = '#59616B';
/** Excel's padding inside a cell, and one level of indent. */
const PAD = 1.5;
const INDENT = 6.75;

const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];
const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** `tint` as Excel applies it: towards white or black, in lightness. */
function tinted(hex, tint) {
  if (!tint) return hex;
  const n = parseInt(hex, 16) || 0;
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = d === 0 ? 0 : max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const next = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const q = next < 0.5 ? next * (1 + s) : next + s - next * s;
  const p = 2 * next - q;
  const part = (t0) => {
    const t = (t0 + 6) % 6;
    if (t < 1) return p + (q - p) * t;
    if (t < 3) return q;
    if (t < 4) return p + (q - p) * (4 - t);
    return p;
  };
  [r, g, b] = [part(h + 2), part(h), part(h - 2)];
  return [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `A12` as zero-based numbers. */
function parseRef(ref) {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(String(ref || ''));
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return { col: col - 1, row: Number(match[2]) - 1 };
}

function parseRange(text) {
  const [a, b] = String(text || '').split(':');
  const from = parseRef(a);
  if (!from) return null;
  const to = b ? parseRef(b) : from;
  if (!to) return null;
  return { r0: Math.min(from.row, to.row), r1: Math.max(from.row, to.row), c0: Math.min(from.col, to.col), c1: Math.max(from.col, to.col) };
}

export function columnLetters(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const BORDER_WIDTH = { hair: 0.5, thin: 0.75, medium: 1.5, thick: 2.25, double: 2.25, dotted: 0.75, dashed: 0.75, dashDot: 0.75, dashDotDot: 0.75, mediumDashed: 1.5, mediumDashDot: 1.5, mediumDashDotDot: 1.5, slantDashDot: 1.5 };

/* ── the workbook: styles and shared words ──────────────────────────── */

class Book {
  constructor(zip, tools, ssf) {
    this.zip = zip;
    this.tools = tools;
    this.ssf = ssf;
    this.main = mainPart(zip, 'xl/workbook.xml');
    if (!zip.has(this.main)) throw refused('That .xlsx has no workbook part, so it may be corrupt.');
    this.root = parseXml(zip.text(this.main));
    this.rels = readRelationships(zip, relsPathFor(this.main));
    const related = (kind) => {
      for (const [, rel] of this.rels) if (isRel(rel.type, kind)) return resolveTarget(this.main, rel.target);
      return null;
    };
    this.theme = readTheme(zip, related('theme'));
    this.date1904 = ['1', 'true'].includes(String(attr(element(this.root, 'workbookPr'), 'date1904')));
    this.readStyles(related('styles'));
    this.readStrings(related('sharedStrings'));
  }

  color(node) {
    if (!node) return null;
    const rgb = attr(node, 'rgb');
    const tint = Number(attr(node, 'tint')) || 0;
    if (rgb) return tinted(String(rgb).slice(-6), tint);
    const theme = attr(node, 'theme');
    if (theme !== undefined) {
      const hex = this.theme.colors[THEME_SLOTS[Number(theme)]];
      return hex ? tinted(hex, tint) : null;
    }
    const indexed = attr(node, 'indexed');
    if (indexed !== undefined) {
      const i = Number(indexed);
      // 64 and 65 are "the window's text" and "the window's background".
      return i === 64 ? '000000' : i === 65 ? 'FFFFFF' : INDEXED[i] || null;
    }
    return attr(node, 'auto') ? '000000' : null;
  }

  readFont(node) {
    const on = (name) => {
      const child = element(node, name);
      if (!child) return false;
      const value = attr(child, 'val');
      return value === undefined || !(value === '0' || value === 'false');
    };
    const underline = element(node, 'u');
    return {
      name: String(attr(element(node, 'name'), 'val') || attr(element(node, 'rFont'), 'val') || this.theme.minor),
      size: Number(attr(element(node, 'sz'), 'val')) || 11,
      bold: on('b'),
      italic: on('i'),
      strike: on('strike'),
      underline: underline ? (attr(underline, 'val') === 'double' ? 'double' : true) : false,
      color: this.color(element(node, 'color')),
      vert: attr(element(node, 'vertAlign'), 'val') === 'superscript' ? 0.33 : attr(element(node, 'vertAlign'), 'val') === 'subscript' ? -0.1 : 0,
    };
  }

  readFill(node) {
    const pattern = element(node, 'patternFill');
    if (pattern) {
      const type = String(attr(pattern, 'patternType') || 'none');
      if (type === 'none') return null;
      const fg = this.color(element(pattern, 'fgColor'));
      const bg = this.color(element(pattern, 'bgColor'));
      if (type === 'solid') return fg || bg;
      // A pattern, from a distance, is a mix of its two colours.
      const share = { gray125: 0.125, gray0625: 0.0625, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75 }[type] ?? 0.4;
      const a = parseInt(fg || '000000', 16);
      const b = parseInt(bg || 'FFFFFF', 16);
      return [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * share + ((b >> s) & 255) * (1 - share)).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    const gradient = element(node, 'gradientFill');
    if (gradient) {
      const stops = elements(gradient, 'stop').map((stop) => [Number(attr(stop, 'position')) || 0, this.color(element(stop, 'color')) || 'FFFFFF']);
      if (stops.length) return { stops, degree: Number(attr(gradient, 'degree')) || 0 };
    }
    return null;
  }

  readBorder(node) {
    const out = {};
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const edge = element(node, side) || element(node, side === 'left' ? 'start' : side === 'right' ? 'end' : side);
      const style = attr(edge, 'style');
      if (style && style !== 'none') out[side] = { style: String(style), color: this.color(element(edge, 'color')) || '000000' };
    }
    return out;
  }

  readStyles(part) {
    this.fonts = [{ name: this.theme.minor, size: 11, bold: false, italic: false, strike: false, underline: false, color: null, vert: 0 }];
    this.fills = [null];
    this.borders = [{}];
    this.xfs = [{ numFmt: 0, font: 0, fill: 0, border: 0, align: {} }];
    this.numFmts = new Map();
    this.dxfs = [];
    if (!part || !this.zip.has(part)) return;
    const root = parseXml(this.zip.text(part));
    for (const node of elements(element(root, 'numFmts'), 'numFmt')) this.numFmts.set(Number(attr(node, 'numFmtId')), String(attr(node, 'formatCode') || ''));
    const fonts = elements(element(root, 'fonts'), 'font').map((node) => this.readFont(node));
    if (fonts.length) this.fonts = fonts;
    const fills = elements(element(root, 'fills'), 'fill').map((node) => this.readFill(node));
    if (fills.length) this.fills = fills;
    const borders = elements(element(root, 'borders'), 'border').map((node) => this.readBorder(node));
    if (borders.length) this.borders = borders;
    const xfs = elements(element(root, 'cellXfs'), 'xf').map((node) => {
      const a = element(node, 'alignment');
      return {
        numFmt: Number(attr(node, 'numFmtId')) || 0,
        font: Number(attr(node, 'fontId')) || 0,
        fill: Number(attr(node, 'fillId')) || 0,
        border: Number(attr(node, 'borderId')) || 0,
        align: a
          ? {
              h: attr(a, 'horizontal') ? String(attr(a, 'horizontal')) : null,
              v: attr(a, 'vertical') ? String(attr(a, 'vertical')) : null,
              wrap: ['1', 'true'].includes(String(attr(a, 'wrapText'))),
              shrink: ['1', 'true'].includes(String(attr(a, 'shrinkToFit'))),
              indent: Number(attr(a, 'indent')) || 0,
              rotation: Number(attr(a, 'textRotation')) || 0,
            }
          : {},
      };
    });
    if (xfs.length) this.xfs = xfs;
    this.dxfs = elements(element(root, 'dxfs'), 'dxf').map((node) => {
      const font = element(node, 'font');
      const fill = element(node, 'fill');
      const pattern = element(fill, 'patternFill');
      return {
        fontColor: font ? this.color(element(font, 'color')) : null,
        bold: font ? !!element(font, 'b') : false,
        // A conditional format's solid fill keeps its colour in bgColor, unlike a cell's.
        fill: pattern ? this.color(element(pattern, 'bgColor')) || this.color(element(pattern, 'fgColor')) : null,
      };
    });
  }

  readStrings(part) {
    this.strings = [];
    if (!part || !this.zip.has(part)) return;
    const root = parseXml(this.zip.text(part));
    for (const si of elements(root, 'si')) this.strings.push(this.readRich(si));
  }

  /** Words with their runs, or plain words where nothing in them is styled. */
  readRich(si) {
    const runs = elements(si, 'r');
    if (!runs.length) return { text: textOf(element(si, 't') || { children: [] }) };
    const parts = runs.map((run) => ({
      text: textOf(element(run, 't') || { children: [] }),
      font: element(run, 'rPr') ? this.readFont(element(run, 'rPr')) : null,
    }));
    return { text: parts.map((p) => p.text).join(''), runs: parts };
  }

  /**
   * How wide a digit is in the book's own font, in pixels: what a column's width is
   * counted in. Seven for Calibri 11, which is why it looks like a constant, and eight
   * for Aptos Narrow 12, Office's default now. Counted as seven there, every column came
   * out too narrow and a number that fits in Excel read ####.
   */
  digitWidth() {
    if (!this.digit) {
      const font = this.fonts[0];
      const pick = this.tools.fonts.pick(font.name, false, false);
      this.digit = Math.max(5, Math.round(this.tools.measure.unit(pick, '0') * pick.scale * font.size * (96 / 72))) || 7;
    }
    return this.digit;
  }

  /** A number in its format, as words. A format the library cannot read shows the plain number. */
  format(value, numFmt) {
    const code = this.numFmts.get(numFmt) ?? numFmt;
    if (!this.ssf) return String(value);
    try {
      return this.ssf.format(code, value, { date1904: this.date1904 });
    } catch {
      return String(value);
    }
  }
}

/* ── one worksheet ──────────────────────────────────────────────────── */

const FORMAT_COLORS = { red: 'FF0000', blue: '0000FF', green: '00B050', yellow: 'FFFF00', magenta: 'FF00FF', cyan: '00FFFF', white: 'FFFFFF', black: '000000' };

/** The colour a number format asks for, `[Red]` on a negative section being the usual one. */
function formatColor(book, numFmt, value) {
  const code = book.numFmts.get(numFmt);
  if (!code || !code.includes('[')) return null;
  const sections = code.split(';');
  const section = value > 0 ? sections[0] : value < 0 ? sections[sections.length > 1 ? 1 : 0] : sections[sections.length > 2 ? 2 : 0];
  const match = /\[(red|blue|green|yellow|magenta|cyan|white|black)\]/i.exec(section || '');
  return match ? FORMAT_COLORS[match[1].toLowerCase()] : null;
}

/** Column widths in points, from the character counts a file stores them in. */
const widthToPoints = (chars, digit = 7) => Math.trunc(((256 * chars + Math.trunc(128 / digit)) / 256) * digit) * 0.75;

class Sheet {
  constructor(book, part, name, number) {
    this.book = book;
    this.part = part;
    this.name = name;
    this.number = number;
    const root = parseXml(book.zip.text(part));
    this.root = root;
    this.rels = readRelationships(book.zip, relsPathFor(part));
    const format = element(root, 'sheetFormatPr');
    this.defaultRow = Number(attr(format, 'defaultRowHeight')) || 15;
    this.fixedDefault = ['1', 'true'].includes(String(attr(format, 'customHeight')));
    const baseCols = Number(attr(format, 'baseColWidth')) || 8;
    const digit = book.digitWidth();
    this.defaultCol = attr(format, 'defaultColWidth') !== undefined
      ? widthToPoints(Number(attr(format, 'defaultColWidth')), digit)
      : Math.ceil((baseCols * digit + 5) / 8) * 8 * 0.75;
    const view = element(element(root, 'sheetViews'), 'sheetView');
    this.showGrid = !['0', 'false'].includes(String(attr(view, 'showGridLines')));
    this.showHeaders = !['0', 'false'].includes(String(attr(view, 'showRowColHeaders')));
    const pane = element(view, 'pane');
    const frozen = ['frozen', 'frozenSplit'].includes(String(attr(pane, 'state')));
    this.frozenRows = frozen ? Number(attr(pane, 'ySplit')) || 0 : 0;
    this.frozenCols = frozen ? Number(attr(pane, 'xSplit')) || 0 : 0;

    /** @type {Map<number, { hidden: boolean, width: number|null, style: number|null }>} */
    this.colInfo = new Map();
    for (const col of elements(element(root, 'cols'), 'col')) {
      const lo = Number(attr(col, 'min')) || 1;
      const hi = Math.min(Number(attr(col, 'max')) || lo, lo + LIMITS.columns);
      for (let c = lo - 1; c < hi && c < LIMITS.columns; c += 1) {
        this.colInfo.set(c, {
          hidden: ['1', 'true'].includes(String(attr(col, 'hidden'))),
          width: attr(col, 'width') !== undefined ? widthToPoints(Number(attr(col, 'width')), digit) : null,
          style: attr(col, 'style') !== undefined ? Number(attr(col, 'style')) : null,
        });
      }
    }
    this.readCells();
    this.readMerges();
    this.readTables();
    this.readConditional();
    this.readDrawing();
    this.measure();
  }

  readCells() {
    const { book } = this;
    /** @type {Map<number, Map<number, any>>} */
    this.rows = new Map();
    /** @type {Map<number, { ht: number|null, hidden: boolean, style: number|null }>} */
    this.rowInfo = new Map();
    this.maxRow = -1;
    this.maxCol = -1;
    let count = 0;
    let unsaved = false;
    this.cut = 0;
    /** The first cell of each shared formula: the rest say only which one they share. */
    this.sharedFormulas = new Map();
    let at = -1;
    for (const rowNode of elements(element(this.root, 'sheetData'), 'row')) {
      book.tools.budget.check();
      at = attr(rowNode, 'r') !== undefined ? Number(attr(rowNode, 'r')) - 1 : at + 1;
      if (at >= LIMITS.rows || count >= LIMITS.cells) {
        this.cut = at + 1;
        break;
      }
      const custom = ['1', 'true'].includes(String(attr(rowNode, 'customFormat')));
      this.rowInfo.set(at, {
        ht: attr(rowNode, 'ht') !== undefined ? Number(attr(rowNode, 'ht')) : null,
        hidden: ['1', 'true'].includes(String(attr(rowNode, 'hidden'))),
        style: custom ? Number(attr(rowNode, 's')) || 0 : null,
      });
      const cells = new Map();
      let col = -1;
      for (const c of elements(rowNode, 'c')) {
        count += 1;
        const ref = parseRef(attr(c, 'r'));
        col = ref ? ref.col : col + 1;
        if (col >= LIMITS.columns) continue;
        const cell = this.readCell(c, col);
        const formula = element(c, 'f');
        if (formula) {
          const said = textOf(formula);
          const si = attr(formula, 'si');
          if (attr(formula, 't') === 'shared' && si !== undefined) {
            if (said) this.sharedFormulas.set(String(si), { text: said, row: at, col });
            cell.formula = said || null;
            cell.sharedAs = String(si);
          } else cell.formula = said;
        }
        if (cell.unsaved) unsaved = true;
        cells.set(col, cell);
        const xf = book.xfs[cell.s] || book.xfs[0];
        const inked = cell.text !== '' || book.fills[xf.fill] || Object.keys(book.borders[xf.border] || {}).length;
        if (inked) {
          if (col > this.maxCol) this.maxCol = col;
          if (at > this.maxRow) this.maxRow = at;
        }
      }
      if (cells.size) this.rows.set(at, cells);
    }
    if (unsaved) book.tools.note(`Sheet "${this.name}" has formulas with no saved result, which appear blank here; Excel works them out on opening.`);
  }

  readCell(c, col) {
    const { book } = this;
    const type = String(attr(c, 't') || 'n');
    const s = Number(attr(c, 's')) || 0;
    const v = element(c, 'v');
    const raw = v ? textOf(v) : '';
    const cell = { col, s, kind: 'blank', text: '', value: null, runs: null, unsaved: false };
    if (type === 's') {
      const shared = book.strings[Number(raw)];
      if (shared) {
        cell.kind = 'text';
        cell.text = shared.text;
        cell.runs = shared.runs || null;
      }
      return cell;
    }
    if (type === 'inlineStr') {
      const rich = book.readRich(element(c, 'is') || { children: [] });
      cell.kind = 'text';
      cell.text = rich.text;
      cell.runs = rich.runs || null;
      return cell;
    }
    if (!v) {
      if (element(c, 'f')) cell.unsaved = true;
      return cell;
    }
    if (type === 'str') {
      cell.kind = 'text';
      cell.text = raw;
      return cell;
    }
    if (type === 'b') {
      cell.kind = 'bool';
      cell.text = raw === '1' ? 'TRUE' : 'FALSE';
      return cell;
    }
    if (type === 'e') {
      cell.kind = 'error';
      cell.text = raw;
      return cell;
    }
    const value = type === 'd' ? (Date.parse(raw) - Date.UTC(1899, 11, 30)) / 86_400_000 : Number(raw);
    if (!Number.isFinite(value)) {
      cell.kind = 'text';
      cell.text = raw;
      return cell;
    }
    cell.kind = 'number';
    cell.value = value;
    const xf = book.xfs[s] || book.xfs[0];
    cell.text = book.format(value, xf.numFmt);
    cell.color = formatColor(book, xf.numFmt, value);
    return cell;
  }

  readMerges() {
    /** Top-left cell of each merge, and every other cell's way back to it. */
    this.merges = new Map();
    this.covered = new Map();
    /** What all of a sheet's merges may cover: a sheet this merged is not a sheet, it is an attack. */
    let coveredLeft = LIMITS.cells;
    for (const node of elements(element(this.root, 'mergeCells'), 'mergeCell')) {
      this.book.tools.budget.check();
      const range = parseRange(attr(node, 'ref'));
      if (!range) continue;
      this.merges.set(`${range.r0},${range.c0}`, range);
      if (range.r1 > this.maxRow) this.maxRow = Math.min(range.r1, LIMITS.rows - 1);
      if (range.c1 > this.maxCol) this.maxCol = Math.min(range.c1, LIMITS.columns - 1);
      // A merge covering a whole column is a stranger's mistake and must not fill memory.
      const size = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
      if (size > 20_000 || size > coveredLeft) continue;
      coveredLeft -= size;
      for (let r = range.r0; r <= range.r1; r += 1) {
        for (let c = range.c0; c <= range.c1; c += 1) if (r !== range.r0 || c !== range.c0) this.covered.set(`${r},${c}`, range);
      }
    }
  }

  /**
   * An Excel table keeps its look in the table part, not in its cells, so a text
   * reading and a naive drawing both miss its banding. The look is close, not exact:
   * the built-in styles are a large family, and each is drawn from its accent colour.
   */
  readTables() {
    const { book } = this;
    /** @type {Map<string, { fill?: string, bold?: boolean, ink?: string, rule?: string }>} */
    this.tableCells = new Map();
    for (const node of elements(element(this.root, 'tableParts'), 'tablePart')) {
      const rel = this.rels.get(String(relationshipId(node)));
      if (!rel) continue;
      const path = resolveTarget(this.part, rel.target);
      if (!book.zip.has(path)) continue;
      const table = parseXml(book.zip.text(path));
      const range = parseRange(attr(table, 'ref'));
      if (!range) continue;
      const info = element(table, 'tableStyleInfo');
      const match = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(String(attr(info, 'name') || ''));
      if (!match) continue;
      const n = Number(match[2]);
      const slot = (n - 1) % 7;
      const accent = slot === 0 ? book.theme.colors.dk1 : book.theme.colors[`accent${slot}`] || book.theme.colors.dk1;
      const stripes = attr(info, 'showRowStripes') !== '0';
      const headerRows = attr(table, 'headerRowCount') === '0' ? 0 : 1;
      const totals = Number(attr(table, 'totalsRowCount')) || 0;
      book.tools.note('Excel table styles are drawn close to their colours, not exactly.');
      for (let r = range.r0; r <= range.r1; r += 1) {
        for (let c = range.c0; c <= range.c1; c += 1) {
          const key = `${r},${c}`;
          if (r < range.r0 + headerRows) {
            if (match[1] === 'Light') this.tableCells.set(key, { bold: true, rule: accent });
            else this.tableCells.set(key, { fill: accent, bold: true, ink: lightness(accent) < 0.6 ? 'FFFFFF' : '000000' });
          } else if (r > range.r1 - totals) {
            this.tableCells.set(key, { bold: true, rule: accent });
          } else if (stripes && (r - range.r0 - headerRows) % 2 === 0) {
            this.tableCells.set(key, { fill: tinted(accent, slot === 0 ? 0.85 : 0.8) });
          }
        }
      }
    }
  }

  readConditional() {
    const { book } = this;
    /** @type {Map<string, { fill?: string, ink?: string, bold?: boolean, bar?: { ratio: number, color: string } }>} */
    this.cond = new Map();
    const valuesIn = (ranges) => {
      const out = [];
      for (const range of ranges) {
        for (let r = range.r0; r <= Math.min(range.r1, this.maxRow); r += 1) {
          book.tools.budget.check();
          const cells = this.rows.get(r);
          if (!cells) continue;
          for (const [c, cell] of cells) {
            if (c >= range.c0 && c <= range.c1) out.push({ r, c, cell });
          }
        }
      }
      return out;
    };
    let unsupported = false;
    for (const block of elements(this.root, 'conditionalFormatting')) {
      book.tools.budget.check();
      const ranges = String(attr(block, 'sqref') || '').split(/\s+/).map(parseRange).filter(Boolean);
      const rules = elements(block, 'cfRule').sort((a, b) => (Number(attr(b, 'priority')) || 0) - (Number(attr(a, 'priority')) || 0));
      for (const rule of rules) {
        const type = String(attr(rule, 'type') || '');
        const held = valuesIn(ranges);
        const numbers = held.filter((h) => h.cell.value !== null).map((h) => h.cell.value);
        // Not Math.min(...numbers): a sheet's worth of arguments overflows the stack.
        const low = numbers.length ? numbers.reduce((a, b) => (b < a ? b : a)) : 0;
        const high = numbers.length ? numbers.reduce((a, b) => (b > a ? b : a)) : 0;
        const cfvo = (node, fallback) => {
          const kind = attr(node, 'type');
          const v = Number(attr(node, 'val'));
          if (kind === 'num') return v;
          if (kind === 'percent') return low + ((high - low) * v) / 100;
          if (kind === 'percentile') {
            const sorted = [...numbers].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.floor((v / 100) * sorted.length))] ?? fallback;
          }
          if (kind === 'min') return low;
          if (kind === 'max') return high;
          return fallback;
        };
        if (type === 'dataBar') {
          const data = element(rule, 'dataBar');
          const points = elements(data, 'cfvo');
          const low = cfvo(points[0], 0);
          const high = cfvo(points[1], 1);
          const color = book.color(element(data, 'color')) || '638EC6';
          for (const { r, c, cell } of held) {
            if (cell.value === null) continue;
            const ratio = high > low ? Math.max(0, Math.min(1, (cell.value - low) / (high - low))) : 1;
            this.setCond(r, c, { bar: { ratio: Math.max(0.1, ratio) * 0.9 + (ratio ? 0.1 : 0), color } });
          }
        } else if (type === 'colorScale') {
          const scale = element(rule, 'colorScale');
          const points = elements(scale, 'cfvo').map((node, i, all) => cfvo(node, i / Math.max(1, all.length - 1)));
          const colors = elements(scale, 'color').map((node) => book.color(node) || 'FFFFFF');
          for (const { r, c, cell } of held) {
            if (cell.value === null) continue;
            this.setCond(r, c, { fill: blendScale(cell.value, points, colors) });
          }
        } else {
          const dxf = book.dxfs[Number(attr(rule, 'dxfId'))];
          const test = ruleTest(rule, type, numbers);
          if (!test) {
            unsupported = true;
            continue;
          }
          if (!dxf) continue;
          for (const { r, c, cell } of held) {
            if (test(cell)) this.setCond(r, c, { ...(dxf.fill ? { fill: dxf.fill } : {}), ...(dxf.fontColor ? { ink: dxf.fontColor } : {}), ...(dxf.bold ? { bold: true } : {}) });
          }
        }
      }
    }
    if (unsupported) book.tools.note(`Sheet "${this.name}" has conditional formats worked out by a formula, which are not drawn here.`);
  }

  setCond(r, c, change) {
    const key = `${r},${c}`;
    this.cond.set(key, { ...(this.cond.get(key) || {}), ...change });
  }

  readDrawing() {
    const { book } = this;
    /** @type {any[]} */
    this.drawings = [];
    const node = element(this.root, 'drawing');
    if (!node) return;
    const rel = this.rels.get(String(relationshipId(node)));
    if (!rel) return;
    const part = resolveTarget(this.part, rel.target);
    if (!book.zip.has(part)) return;
    const root = parseXml(book.zip.text(part));
    const rels = readRelationships(book.zip, relsPathFor(part));
    for (const anchor of elements(root)) {
      const kind = localName(anchor.name);
      if (!['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(kind)) continue;
      const from = element(anchor, 'from');
      const to = element(anchor, 'to');
      const pos = element(anchor, 'pos');
      const ext = element(anchor, 'ext');
      const inner = elements(anchor).find((child) => ['pic', 'sp', 'grpSp', 'graphicFrame', 'cxnSp', 'AlternateContent'].includes(localName(child.name)));
      if (!inner) continue;
      const fromCell = from ? { col: Number(textOf(element(from, 'col'))) || 0, row: Number(textOf(element(from, 'row'))) || 0 } : null;
      const toCell = to ? { col: Number(textOf(element(to, 'col'))) || 0, row: Number(textOf(element(to, 'row'))) || 0 } : null;
      this.drawings.push({
        inner, part, rels, kind, from, to, pos, ext, fromCell, toCell,
      });
      const edge = toCell || fromCell;
      if (edge) {
        this.maxRow = Math.max(this.maxRow, Math.min(edge.row, LIMITS.rows - 1));
        this.maxCol = Math.max(this.maxCol, Math.min(edge.col, LIMITS.columns - 1));
      }
    }
  }

  /** Where every row and column falls, once what grows to fit has grown. */
  measure() {
    const { book } = this;
    const fonts = book.tools.fonts;
    const lastCol = Math.max(0, this.maxCol);
    this.colX = [0];
    for (let c = 0; c <= lastCol; c += 1) {
      const info = this.colInfo.get(c);
      const width = info?.hidden ? 0 : info?.width ?? this.defaultCol;
      this.colX.push(this.colX[c] + width);
    }
    const lastRow = Math.max(0, this.maxRow);
    this.rowY = [0];
    for (let r = 0; r <= lastRow; r += 1) {
      book.tools.budget.check();
      const info = this.rowInfo.get(r);
      let height = info?.hidden ? 0 : info?.ht ?? this.defaultRow;
      // No height saved: Excel fits a row holding anything to its words when it opens the
      // file, up or down, whatever the sheet's default says (measured against Excel).
      if (!info?.hidden && info?.ht == null) {
        const cells = this.rows.get(r);
        const filled = cells && [...cells.values()].some((cell) => cell.text);
        if (filled) {
          height = 0;
          for (const [c, cell] of cells) {
            if (!cell.text || this.merges.has(`${r},${c}`) || this.covered.has(`${r},${c}`)) continue;
            const xf = book.xfs[cell.s] || book.xfs[0];
            const font = book.fonts[xf.font] || book.fonts[0];
            const pick = fonts.pick(font.name, font.bold, font.italic);
            let need = (pick.asc + pick.desc + pick.gap) * font.size + 1.5;
            if (xf.align.wrap && !xf.align.rotation) {
              const lines = this.setCell(cell, xf, font, this.colX[c + 1] - this.colX[c]);
              need = lines.reduce((sum, line) => sum + line.height, 0) + 1.5;
            }
            if (need > height) height = need;
          }
          // Only a merge in the row, which never sets its height: the sheet's default stands.
          if (!height) height = this.defaultRow;
        }
      }
      this.rowY.push(this.rowY[r] + height);
    }
  }

  /** A cell's words, as lines. */
  setCell(cell, xf, font, width, override = {}) {
    const { fonts, measure, budget } = this.book.tools;
    const makeStyle = (f) => ({
      pick: fonts.pick(f.name, f.bold || override.bold, f.italic),
      size: f.size,
      color: override.ink ? `#${override.ink}` : cell.color ? `#${cell.color}` : f.color ? `#${f.color}` : '#000000',
      underline: f.underline,
      strike: f.strike,
      shift: f.vert,
    });
    const base = makeStyle(font);
    const wrap = !!xf.align.wrap;
    const indent = (xf.align.indent || 0) * INDENT;
    const room = Math.max(1, width - PAD * 2 - indent);
    const inlines = [];
    const add = (text, style) => {
      const pieces = String(text).split(/\r?\n/);
      pieces.forEach((piece, i) => {
        if (i > 0) inlines.push({ type: wrap ? 'br' : 'text', ...(wrap ? { style } : { text: ' ', style }) });
        if (piece) inlines.push({ type: 'text', text: piece, style });
      });
    };
    if (cell.runs) for (const run of cell.runs) add(run.text, run.font ? makeStyle({ ...font, ...run.font }) : base);
    else add(cell.text, base);
    return setLines(inlines, {
      width: wrap ? room : 1e6,
      wrap,
      align: 'left',
      empty: base,
      fonts,
      measure,
      budget,
    });
  }
}

/** A value's place on a colour scale. */
function blendScale(value, points, colors) {
  if (colors.length < 2) return colors[0] || null;
  let i = 0;
  while (i < points.length - 2 && value > points[i + 1]) i += 1;
  const span = points[i + 1] - points[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (value - points[i]) / span)) : 1;
  const a = parseInt(colors[i], 16);
  const b = parseInt(colors[i + 1], 16);
  return [16, 8, 0].map((s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The conditional rules that need no formula engine, as a test of one cell. Null for the rest. */
function ruleTest(rule, type, numbers) {
  const formulas = elements(rule, 'formula').map((node) => textOf(node).trim());
  const text = String(attr(rule, 'text') ?? '').toLowerCase();
  if (type === 'cellIs') {
    const a = Number(formulas[0]);
    const b = Number(formulas[1]);
    if (!Number.isFinite(a)) {
      const quoted = /^"(.*)"$/.exec(formulas[0] || '');
      if (!quoted) return null;
      const operator = attr(rule, 'operator');
      return (cell) => (operator === 'notEqual' ? cell.text !== quoted[1] : operator === 'equal' ? cell.text === quoted[1] : false);
    }
    const tests = {
      greaterThan: (v) => v > a, greaterThanOrEqual: (v) => v >= a, lessThan: (v) => v < a, lessThanOrEqual: (v) => v <= a,
      equal: (v) => v === a, notEqual: (v) => v !== a, between: (v) => v >= Math.min(a, b) && v <= Math.max(a, b), notBetween: (v) => v < Math.min(a, b) || v > Math.max(a, b),
    };
    const test = tests[String(attr(rule, 'operator'))];
    return test ? (cell) => cell.value !== null && test(cell.value) : null;
  }
  if (type === 'containsText') return (cell) => cell.text.toLowerCase().includes(text);
  if (type === 'notContainsText') return (cell) => !cell.text.toLowerCase().includes(text);
  if (type === 'beginsWith') return (cell) => cell.text.toLowerCase().startsWith(text);
  if (type === 'endsWith') return (cell) => cell.text.toLowerCase().endsWith(text);
  if (type === 'containsBlanks') return (cell) => !cell.text.trim();
  if (type === 'notContainsBlanks') return (cell) => !!cell.text.trim();
  if (type === 'containsErrors') return (cell) => cell.kind === 'error';
  if (type === 'top10') {
    const rank = Number(attr(rule, 'rank')) || 10;
    const bottom = attr(rule, 'bottom') === '1';
    const percent = attr(rule, 'percent') === '1';
    const sorted = [...numbers].sort((x, y) => (bottom ? x - y : y - x));
    const keep = percent ? Math.max(1, Math.floor((sorted.length * rank) / 100)) : rank;
    const edge = sorted[Math.min(sorted.length - 1, keep - 1)];
    return (cell) => cell.value !== null && (bottom ? cell.value <= edge : cell.value >= edge);
  }
  if (type === 'aboveAverage') {
    const mean = numbers.reduce((s, v) => s + v, 0) / Math.max(1, numbers.length);
    const below = attr(rule, 'aboveAverage') === '0';
    return (cell) => cell.value !== null && (below ? cell.value < mean : cell.value > mean);
  }
  return null;
}

/* ── painting ───────────────────────────────────────────────────────── */

function cellRule(surface, x1, y1, x2, y2, edge) {
  if (!edge) return;
  const width = BORDER_WIDTH[edge.style] || 0.75;
  const dash = /dot|hair/i.test(edge.style) ? [width, width * 1.5] : /dash/i.test(edge.style) ? [width * 3, width * 2] : null;
  const color = `#${edge.color}`;
  if (edge.style === 'double') {
    const horizontal = Math.abs(y1 - y2) < 0.01;
    surface.line(x1, y1 - (horizontal ? 1 : 0), x2, y2 - (horizontal ? 1 : 0), color, 0.5);
    surface.line(x1 + (horizontal ? 0 : 1), y1 + (horizontal ? 1 : 0), x2 + (horizontal ? 0 : 1), y2 + (horizontal ? 1 : 0), color, 0.5);
    return;
  }
  surface.line(x1, y1, x2, y2, color, width, dash);
}

/** A cell's fill, flat or as the gradient Excel keeps for a few of its styles. */
function fillPaint(fill, x, y, w, h) {
  if (!fill) return null;
  if (typeof fill === 'string') return `#${fill}`;
  const turn = ((fill.degree || 0) * Math.PI) / 180;
  const x1 = x + Math.cos(turn) * w;
  const y1 = y + Math.sin(turn) * h;
  return { kind: 'linear', x0: x, y0: y, x1, y1, stops: fill.stops.map(([at, color]) => [at, css(color)]) };
}

/** Draw rows and columns of the sheet in its own coordinates. */
function paintRange(surface, sheet, range) {
  const { book, colX, rowY } = sheet;
  const { budget } = book.tools;
  const { r0, r1, c0, c1 } = range;
  const x0 = colX[c0];
  const x1 = colX[c1 + 1];
  const y0 = rowY[r0];
  const y1 = rowY[r1 + 1];

  surface.rect(x0, y0, x1 - x0, y1 - y0, '#FFFFFF');
  if (sheet.showGrid) {
    for (let c = c0; c <= c1 + 1; c += 1) if (c === c0 || colX[c] !== colX[c - 1]) surface.line(colX[c], y0, colX[c], y1, GRID, 0.5);
    for (let r = r0; r <= r1 + 1; r += 1) if (r === r0 || rowY[r] !== rowY[r - 1]) surface.line(x0, rowY[r], x1, rowY[r], GRID, 0.5);
  }

  const styleAt = (r, c, cell) => {
    if (cell) return cell.s;
    const rowStyle = sheet.rowInfo.get(r)?.style;
    if (rowStyle != null) return rowStyle;
    return sheet.colInfo.get(c)?.style ?? 0;
  };

  /** What a merge's own cell says, for every cell it covers. */
  const texts = [];
  for (let r = r0; r <= r1; r += 1) {
    const rowH = rowY[r + 1] - rowY[r];
    if (rowH <= 0) continue;
    const cells = sheet.rows.get(r);
    for (let c = c0; c <= c1; c += 1) {
      budget.check();
      const colW = colX[c + 1] - colX[c];
      if (colW <= 0) continue;
      const key = `${r},${c}`;
      const merge = sheet.merges.get(key);
      const cover = sheet.covered.get(key);
      if (cover) {
        // A merge that a piece's edge cut still has to show its colour here.
        if (!(cover.r0 >= r0 && cover.c0 >= c0)) {
          const head = sheet.rows.get(cover.r0)?.get(cover.c0);
          const xf = book.xfs[styleAt(cover.r0, cover.c0, head)] || book.xfs[0];
          const paint = fillPaint(book.fills[xf.fill], colX[c], rowY[r], colW, rowH);
          surface.rect(colX[c], rowY[r], colW, rowH, paint || '#FFFFFF');
        }
        continue;
      }
      const cell = cells?.get(c) || null;
      const xf = book.xfs[styleAt(r, c, cell)] || book.xfs[0];
      const table = sheet.tableCells.get(key);
      const cond = sheet.cond.get(key);
      const x = colX[c];
      const y = rowY[r];
      const w = merge ? colX[Math.min(merge.c1, sheet.maxCol) + 1] - x : colW;
      const h = merge ? rowY[Math.min(merge.r1, sheet.maxRow) + 1] - y : rowH;
      const fill = cond?.fill || book.fills[xf.fill] || table?.fill || (merge ? 'FFFFFF' : null);
      const paint = fillPaint(fill, x, y, w, h);
      if (paint) surface.rect(x, y, w, h, paint);
      if (cond?.bar) {
        const bar = cond.bar;
        surface.rect(x + 1, y + 1, Math.max(0, (w - 2) * bar.ratio), Math.max(0, h - 2), {
          kind: 'linear', x0: x, y0: y, x1: x + w * bar.ratio, y1: y, stops: [[0, css(bar.color)], [1, css(bar.color, 0.25)]],
        });
      }
      if (cell?.text) {
        const font = book.fonts[xf.font] || book.fonts[0];
        texts.push({ r, c, cell, xf, font, x, y, w, h, table, cond, fill });
      }
    }
  }

  // Rules go over every fill, and each cell draws its own; a merge only its outside.
  for (let r = r0; r <= r1; r += 1) {
    if (rowY[r + 1] - rowY[r] <= 0) continue;
    const cells = sheet.rows.get(r);
    for (let c = c0; c <= c1; c += 1) {
      if (colX[c + 1] - colX[c] <= 0) continue;
      const key = `${r},${c}`;
      const cell = cells?.get(c) || null;
      const style = styleAt(r, c, cell);
      const borders = book.borders[(book.xfs[style] || book.xfs[0]).border] || {};
      const table = sheet.tableCells.get(key);
      const region = sheet.merges.get(key) || sheet.covered.get(key) || null;
      const x = colX[c];
      const y = rowY[r];
      const right = colX[c + 1];
      const bottom = rowY[r + 1];
      if (borders.top && (!region || r === region.r0)) cellRule(surface, x, y, right, y, borders.top);
      if (borders.bottom && (!region || r === region.r1)) cellRule(surface, x, bottom, right, bottom, borders.bottom);
      if (borders.left && (!region || c === region.c0)) cellRule(surface, x, y, x, bottom, borders.left);
      if (borders.right && (!region || c === region.c1)) cellRule(surface, right, y, right, bottom, borders.right);
      if (table?.rule && !borders.bottom) cellRule(surface, x, bottom, right, bottom, { style: 'thin', color: table.rule });
    }
  }

  for (const item of texts) paintCellText(surface, sheet, item, range);
  surface.tableCells += texts.length;
}

function paintCellText(surface, sheet, item, range) {
  const { book, colX } = sheet;
  const { r, c, cell, xf, font, x, y, w, h, table, cond } = item;
  const override = { ink: cond?.ink || table?.ink || null, bold: !!(cond?.bold || table?.bold) };
  const align = xf.align;
  const kind = cell.kind;
  const rotation = align.rotation || 0;
  if (rotation) {
    paintRotated(surface, sheet, item, override);
    return;
  }
  let lines = sheet.setCell(cell, xf, font, w, override);
  const fullWidth = (list) => Math.max(...list.map((line) => line.width), 0);
  let textW = fullWidth(lines);
  const indent = (align.indent || 0) * INDENT;
  const room = w - PAD * 2 - indent;
  let scale = 1;
  // A number that does not fit is never spilled or cut in Excel: it shrinks its
  // digits if it can, and otherwise reads ####, which is exactly what a person sees.
  if (kind === 'number' && textW > room + 0.5) {
    const general = (book.numFmts.get(xf.numFmt) ?? xf.numFmt) === 0;
    let fitted = false;
    if (align.shrink) {
      scale = Math.max(0.3, room / textW);
      fitted = true;
    } else if (general) {
      for (let digits = 10; digits >= 1 && !fitted; digits -= 1) {
        const shorter = Number(cell.value.toPrecision(digits));
        const trial = { ...cell, text: String(shorter), runs: null };
        const trialLines = sheet.setCell(trial, xf, font, w, override);
        if (fullWidth(trialLines) <= room + 0.5) {
          lines = trialLines;
          textW = fullWidth(lines);
          fitted = true;
        }
      }
    }
    if (!fitted) {
      const unit = sheet.setCell({ ...cell, text: '#', runs: null }, xf, font, w, override);
      const each = Math.max(1, fullWidth(unit));
      const hashes = { ...cell, text: '#'.repeat(Math.max(1, Math.floor(room / each))), runs: null };
      lines = sheet.setCell(hashes, xf, font, w, override);
      textW = fullWidth(lines);
    }
  } else if (align.shrink && textW > room && room > 0) {
    scale = Math.max(0.3, room / textW);
  }

  const horizontal = align.h || (kind === 'number' ? 'right' : kind === 'bool' || kind === 'error' ? 'center' : 'left');
  const height = lines.reduce((sum, line) => sum + line.height, 0) * scale;
  const vertical = align.v || 'bottom';
  let top = vertical === 'top' ? y + 0.5 : vertical === 'center' || vertical === 'justify' || vertical === 'distributed' ? y + (h - height) / 2 : y + h - height - 0.5;
  if (top < y && vertical !== 'top') top = vertical === 'center' ? top : y + h - height - 0.5;

  // Where the words may run: their own cell, and empty neighbours if they are plain text.
  let spanLeft = x;
  let spanRight = x + w;
  const words = kind === 'text' && !align.wrap && !sheet.merges.has(`${r},${c}`);
  if (words && textW * scale > room) {
    const empty = (col) => !sheet.rows.get(r)?.get(col)?.text && !sheet.covered.has(`${r},${col}`) && !sheet.merges.has(`${r},${col}`);
    const wantsRight = horizontal !== 'right';
    const wantsLeft = horizontal === 'right' || horizontal === 'center';
    let col = c + 1;
    while (wantsRight && col <= range.c1 && empty(col) && spanRight - x < textW + PAD * 2 + indent) {
      if (!sheet.rows.get(r)?.get(col) && sheet.showGrid) surface.rect(colX[col] - 0.25, y + 0.25, colX[col + 1] - colX[col], h - 0.5, '#FFFFFF');
      spanRight = colX[col + 1];
      col += 1;
    }
    col = c - 1;
    while (wantsLeft && col >= range.c0 && empty(col) && x + w - spanLeft < textW + PAD * 2) {
      if (!sheet.rows.get(r)?.get(col) && sheet.showGrid) surface.rect(colX[col] + 0.25, y + 0.25, colX[col + 1] - colX[col], h - 0.5, '#FFFFFF');
      spanLeft = colX[col];
      col -= 1;
    }
  }

  const needsClip = textW * scale > spanRight - spanLeft - PAD || height > h + 0.5;
  if (needsClip || scale !== 1) surface.save();
  if (needsClip) surface.clipRect(spanLeft, y, spanRight - spanLeft, h);
  if (scale !== 1) {
    surface.transform(scale, 0, 0, scale, x * (1 - scale), top * (1 - scale));
  }
  let at = top;
  for (const line of lines) {
    const shown = line.width * scale;
    const ox = horizontal === 'right' ? x + w - PAD - indent - shown
      : horizontal === 'center' || horizontal === 'centerContinuous' ? x + (w - shown) / 2
      : x + PAD + indent;
    paintLine(surface, line, ox, at);
    at += line.height;
  }
  if (needsClip || scale !== 1) surface.restore();
}

/** Words turned in their cell: a single line about its middle. */
function paintRotated(surface, sheet, item, override) {
  const { cell, xf, font, x, y, w, h } = item;
  const rotation = xf.align.rotation;
  if (rotation === 255) {
    // Stacked letters, one to a line.
    const stacked = { ...cell, text: [...cell.text].join('\n'), runs: null };
    const lines = sheet.setCell(stacked, { ...xf, align: { ...xf.align, wrap: true } }, font, w, override);
    let at = y + 0.5;
    for (const line of lines) {
      paintLine(surface, line, x + (w - line.width) / 2, at);
      at += line.height;
    }
    return;
  }
  const degrees = rotation > 90 ? -(rotation - 90) : rotation;
  const turn = (-degrees * Math.PI) / 180;
  const [line] = sheet.setCell(cell, { ...xf, align: { ...xf.align, wrap: false } }, font, w, override);
  if (!line) return;
  const cx = x + w / 2;
  const cy = y + h / 2;
  surface.save();
  surface.clipRect(x, y, w, h);
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  surface.transform(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy);
  paintLine(surface, line, cx - line.width / 2, cy - line.height / 2);
  surface.restore();
}

/** Where a drawing falls on its sheet, in points. */
function drawingBox(sheet, drawing) {
  const { colX, rowY } = sheet;
  const at = (cell, node) => {
    const col = Math.min(cell.col, sheet.maxCol + 1);
    const row = Math.min(cell.row, sheet.maxRow + 1);
    return {
      x: (colX[col] ?? colX[colX.length - 1]) + emu(textOf(element(node, 'colOff'))),
      y: (rowY[row] ?? rowY[rowY.length - 1]) + emu(textOf(element(node, 'rowOff'))),
    };
  };
  if (drawing.kind === 'twoCellAnchor') {
    const a = at(drawing.fromCell, drawing.from);
    const b = at(drawing.toCell, drawing.to);
    return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y), rot: 0 };
  }
  const a = drawing.kind === 'oneCellAnchor' ? at(drawing.fromCell, drawing.from) : { x: emu(attr(drawing.pos, 'x')), y: emu(attr(drawing.pos, 'y')) };
  return { x: a.x, y: a.y, w: emu(attr(drawing.ext, 'cx')), h: emu(attr(drawing.ext, 'cy')), rot: 0 };
}

/** Pictures, charts and shapes over the cells, each placed by the cells it is anchored to. */
function paintDrawings(surface, sheet, range, only = null) {
  const { book, colX, rowY } = sheet;
  const tools = book.tools;
  const x0 = colX[range.c0];
  const x1 = colX[range.c1 + 1];
  const y0 = rowY[range.r0];
  const y1 = rowY[range.r1 + 1];
  for (const drawing of only ? [only] : sheet.drawings) {
    tools.budget.check();
    const box = drawingBox(sheet, drawing);
    if (!only && (box.x > x1 || box.x + box.w < x0 || box.y > y1 || box.y + box.h < y0)) continue;
    const env = {
      zip: book.zip,
      theme: book.theme,
      clrMap: null,
      part: drawing.part,
      rels: drawing.rels,
      fonts: tools.fonts,
      measure: tools.measure,
      budget: tools.budget,
      note: tools.note,
      noteAt: (text) => tools.note(`Sheet "${sheet.name}" ${text}.`),
    };
    env.drawText = (s, node, shapeBox, info) => drawShapeText(s, node, shapeBox, info, env);
    env.drawFrame = (s, node, frameBox) => paintFrame(s, node, frameBox, env);
    const inner = drawing.inner;
    if (localName(inner.name) === 'graphicFrame') {
      paintFrame(surface, inner, box, env);
      continue;
    }
    const xfrm = readXfrm(element(inner, 'spPr')) || readXfrm(element(inner, 'grpSpPr'));
    // A two-cell anchor's cells are the truth; what the shape saved of itself can be stale.
    const map = xfrm && xfrm.w > 0 && xfrm.h > 0
      ? { sx: box.w / xfrm.w, sy: box.h / xfrm.h, dx: box.x - xfrm.x * (box.w / xfrm.w), dy: box.y - xfrm.y * (box.h / xfrm.h) }
      : { sx: 1, sy: 1, dx: box.x, dy: box.y };
    drawNode(surface, inner, xfrm ? env : { ...env, fallbackXfrm: { x: 0, y: 0, w: box.w, h: box.h } }, map);
  }
}

function paintFrame(surface, node, box, env) {
  const data = element(element(node, 'graphic'), 'graphicData');
  const chart = element(data, 'chart');
  const rel = chart ? env.rels?.get(String(relationshipId(chart))) : null;
  if (rel && drawChart(surface, resolveTarget(env.part, rel.target), box, env)) {
    env.noteAt('has a chart, drawn from its saved numbers by a simplified drawing, so its styling may differ');
    return;
  }
  labelledBox(surface, box.x, box.y, box.w, box.h, chart ? 'Chart' : 'Object', env);
  env.noteAt(`has ${chart ? 'a chart' : 'an object'} that could not be drawn; it appears as a labelled box`);
}

/** Cut the used range into pieces no picture has to shrink for. */
function cutPieces(sheet) {
  const { colX, rowY, frozenRows } = sheet;
  const lastRow = Math.max(0, sheet.maxRow);
  const lastCol = Math.max(0, sheet.maxCol);
  const frozen = Math.min(frozenRows, lastRow + 1);
  const frozenH = frozen ? rowY[frozen] : 0;

  const colChunks = [];
  for (let c = 0; c <= lastCol; ) {
    let end = c;
    while (end < lastCol && colX[end + 2] - colX[c] <= PIECE_W) end += 1;
    colChunks.push([c, end]);
    c = end + 1;
  }
  const rowChunks = [];
  let r = frozen;
  if (r > lastRow) rowChunks.push([0, lastRow]);
  while (r <= lastRow) {
    let end = r;
    const room = Math.max(100, PIECE_H - frozenH);
    while (end < lastRow && rowY[end + 2] - rowY[r] <= room) end += 1;
    rowChunks.push([r, end]);
    r = end + 1;
  }
  const pieces = [];
  for (const [c0, c1] of colChunks) for (const [r0, r1] of rowChunks) pieces.push({ r0, r1, c0, c1 });
  return { pieces, frozen };
}

/**
 * Every worksheet, laid out as one or more pieces.
 *
 * @param {any} zip
 * @param {any} tools  fonts, measure, budget, note
 * @param {{ pages?: number[]|null }} [options]  only these worksheets, when asked for by number
 */
export async function layoutXlsx(zip, tools, { pages = null } = {}) {
  let ssf = null;
  try {
    const XLSX = await import('xlsx');
    ssf = XLSX.SSF || XLSX.default?.SSF || null;
  } catch {
    tools.note('Number formats could not be applied here, so numbers appear unformatted.');
  }
  const book = new Book(zip, tools, ssf);
  const entries = elements(element(book.root, 'sheets'), 'sheet');
  const visible = [];
  let hidden = 0;
  for (const entry of entries) {
    const rel = book.rels.get(String(relationshipId(entry)));
    const part = rel ? resolveTarget(book.main, rel.target) : null;
    if (!part || !zip.has(part)) continue;
    if (attr(entry, 'state') && attr(entry, 'state') !== 'visible') {
      hidden += 1;
      continue;
    }
    visible.push({ name: String(attr(entry, 'name') || ''), part });
  }
  if (hidden) tools.note(`${hidden} hidden worksheet${hidden === 1 ? ' is' : 's are'} not shown.`);
  const total = visible.length;
  const limit = Math.min(total, LIMITS.worksheets);
  if (total > limit) tools.note(`This workbook has ${total} worksheets; only the first ${limit} were considered.`);
  const wanted = Array.isArray(pages) && pages.length ? new Set(pages) : null;

  /** @type {any[]} */
  const out = [];
  for (let index = 0; index < limit; index += 1) {
    tools.budget.check();
    const number = index + 1;
    if (wanted && !wanted.has(number)) continue;
    const sheet = new Sheet(book, visible[index].part, visible[index].name, number);
    if (sheet.cut) tools.note(`Sheet "${sheet.name}" is very long; rows past ${sheet.cut} were not read to draw it.`);
    if (sheet.maxRow < 0 && !sheet.drawings.length) {
      const empty = new Surface(240, 60);
      empty.number = number;
      empty.label = sheet.name;
      out.push(empty);
      continue;
    }
    const { pieces, frozen } = cutPieces(sheet);
    const digits = String(Math.max(1, sheet.maxRow + 1)).length;
    const gutter = 9 + digits * 5.5;
    const shown = pieces.slice(0, MAX_PIECES);
    if (pieces.length > MAX_PIECES) {
      const end = shown[shown.length - 1];
      tools.note(`Sheet "${sheet.name}" is too large to draw whole; it stops at ${columnLetters(end.c1)}${end.r1 + 1}.`);
    }
    shown.forEach((piece, part) => {
      tools.budget.check();
      const frozenH = frozen && piece.r0 >= frozen ? sheet.rowY[frozen] : 0;
      const width = gutter + sheet.colX[piece.c1 + 1] - sheet.colX[piece.c0];
      const height = HEAD_H + frozenH + sheet.rowY[piece.r1 + 1] - sheet.rowY[piece.r0];
      const surface = new Surface(Math.max(40, width), Math.max(30, height));
      surface.number = number;
      surface.part = part;
      surface.label = sheet.name;

      const bodyTop = HEAD_H + frozenH;
      surface.save();
      surface.clipRect(gutter, bodyTop, width - gutter, height - bodyTop);
      surface.transform(1, 0, 0, 1, gutter - sheet.colX[piece.c0], bodyTop - sheet.rowY[piece.r0]);
      paintRange(surface, sheet, piece);
      paintDrawings(surface, sheet, piece);
      surface.restore();

      if (frozenH) {
        const band = { r0: 0, r1: frozen - 1, c0: piece.c0, c1: piece.c1 };
        surface.save();
        surface.clipRect(gutter, HEAD_H, width - gutter, frozenH);
        surface.transform(1, 0, 0, 1, gutter - sheet.colX[piece.c0], HEAD_H);
        paintRange(surface, sheet, band);
        surface.restore();
        surface.line(gutter, bodyTop, width, bodyTop, '#6B7280', 0.75);
      }
      paintHeadings(surface, sheet, piece, { gutter, frozen, frozenH, width, height });
      if (surface.overflowed) tools.note(`Sheet "${sheet.name}" has more on it than is drawn here, so some of it is missing.`);
      out.push(surface);
    });
  }
  return { unit: 'sheet', total, pages: out, kerning: 'none' };
}

/* ── the workbook for a viewer: cells rather than a picture of them ─── */

/** How many rows go in one answer, and how many cells at most, so an answer stays small. */
const MODEL_ROWS = 500;
const MODEL_CELLS = 30_000;

/** Which sheets the file has, in order. */
function listSheets(book, zip) {
  const out = [];
  for (const entry of elements(element(book.root, 'sheets'), 'sheet')) {
    const rel = book.rels.get(String(relationshipId(entry)));
    const part = rel ? resolveTarget(book.main, rel.target) : null;
    if (!part || !zip.has(part)) continue;
    out.push({ name: String(attr(entry, 'name') || ''), part, hidden: !!attr(entry, 'state') && attr(entry, 'state') !== 'visible' });
  }
  return out;
}

/** A formula shared from another cell, as it reads from this one. */
function shiftFormula(text, rows, cols) {
  return String(text).replace(/(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\d(A-Za-z_])/g, (whole, colLock, letters, rowLock, row) => {
    const column = [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1 + (colLock ? 0 : cols);
    const line = Number(row) + (rowLock ? 0 : rows);
    return column < 0 || line < 1 ? whole : `${colLock}${columnLetters(column)}${rowLock}${line}`;
  });
}

/** Words a font name can be, and a colour: all a cell's look is, handed to a browser. */
const safeFont = (name) => String(name || '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60);
const safeHex = (value) => (/^[0-9A-Fa-f]{6}$/.test(String(value || '')) ? String(value).toUpperCase() : null);

/** What a chart says it is called, without drawing it. */
function chartTitle(zip, part) {
  try {
    const root = parseXml(zip.text(part));
    const chart = element(root, 'chart');
    const title = element(chart, 'title');
    if (!title) return '';
    const rich = element(element(title, 'tx'), 'rich');
    if (rich) return elements(rich, 'p').map((p) => elements(p, 'r').map((r) => textOf(element(r, 't'))).join('')).join(' ').trim();
    return textOf(element(element(element(title, 'tx'), 'strRef'), 'strCache')).trim();
  } catch {
    return '';
  }
}

/**
 * A worksheet as a viewer draws it, the way Claude's does (owner, 2026-11-05): every
 * cell with its words as Excel shows them, its look, its formula; the sizes of the
 * rows and columns; what is merged and frozen; what stands over the cells. Rows come
 * a window at a time, since a sheet can be far larger than an answer can be.
 *
 * @param {any} zip
 * @param {any} tools
 * @param {{ sheet?: number, from?: number }} [ask]  a sheet's number among those shown, from 1; a row, from 0
 */
export async function workbookModel(zip, tools, { sheet: number = 1, from = 0 } = {}) {
  let ssf = null;
  try {
    const XLSX = await import('xlsx');
    ssf = XLSX.SSF || XLSX.default?.SSF || null;
  } catch {
    tools.note('Number formats could not be applied here, so numbers appear unformatted.');
  }
  const book = new Book(zip, tools, ssf);
  const all = listSheets(book, zip);
  const visible = all.filter((s) => !s.hidden);
  if (!visible.length) throw refused('That workbook has no sheet to show.');
  const index = Math.min(Math.max(1, Math.floor(Number(number) || 1)), visible.length) - 1;
  const sheet = new Sheet(book, visible[index].part, visible[index].name, index + 1);

  const charts = [];
  for (const [i, entry] of visible.entries()) {
    const rels = readRelationships(zip, relsPathFor(entry.part));
    const drawingRel = [...rels.values()].find((rel) => isRel(rel.type, 'drawing'));
    if (!drawingRel) continue;
    const part = resolveTarget(entry.part, drawingRel.target);
    if (!zip.has(part)) continue;
    const root = parseXml(zip.text(part));
    const inner = readRelationships(zip, relsPathFor(part));
    let at = -1;
    for (const anchor of elements(root)) {
      if (!['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(localName(anchor.name))) continue;
      const kept = elements(anchor).some((child) => ['pic', 'sp', 'grpSp', 'graphicFrame', 'cxnSp', 'AlternateContent'].includes(localName(child.name)));
      if (!kept) continue;
      at += 1;
      const frame = elements(anchor).find((child) => localName(child.name) === 'graphicFrame');
      const chart = frame ? element(element(element(frame, 'graphic'), 'graphicData'), 'chart') : null;
      const rel = chart ? inner.get(String(relationshipId(chart))) : null;
      if (rel) charts.push({ sheet: i + 1, sheetName: entry.name, drawing: at, title: chartTitle(zip, resolveTarget(part, rel.target)) });
    }
  }

  // Each look once, however many cells share it: most of a sheet is a few.
  const styles = [];
  const styleIds = new Map();
  const styleId = (look) => {
    const key = JSON.stringify(look);
    if (!styleIds.has(key)) {
      styleIds.set(key, styles.length);
      styles.push(look);
    }
    return styleIds.get(key);
  };
  const edge = (side) => (side ? [BORDER_WIDTH[side.style] ?? 0.75, side.style, safeHex(side.color) || '000000'] : undefined);
  const look = (xf, font, fill, borders, table, cond, cell) => {
    const paint = cond?.fill || book.fills[xf.fill] || table?.fill || null;
    const a = xf.align || {};
    return {
      f: safeFont(font.name),
      s: font.size,
      ...(font.bold || cond?.bold || table?.bold ? { b: 1 } : {}),
      ...(font.italic ? { i: 1 } : {}),
      ...(font.underline ? { u: 1 } : {}),
      ...(font.strike ? { x: 1 } : {}),
      ...(safeHex(cond?.ink || table?.ink || cell?.color || font.color) ? { c: safeHex(cond?.ink || table?.ink || cell?.color || font.color) } : {}),
      ...(typeof paint === 'string' && safeHex(paint) ? { g: safeHex(paint) } : {}),
      ...(paint && typeof paint === 'object' ? { g: safeHex(paint.stops?.[0]?.[1]) || undefined, g2: safeHex(paint.stops?.at(-1)?.[1]) || undefined, gd: Number(paint.degree) || 0 } : {}),
      ...(a.h ? { h: String(a.h) } : {}),
      ...(a.v ? { v: String(a.v) } : {}),
      ...(a.wrap ? { w: 1 } : {}),
      ...(a.indent ? { n: a.indent } : {}),
      ...(a.rotation ? { r: a.rotation } : {}),
      ...(borders.top ? { bt: edge(borders.top) } : {}),
      ...(borders.bottom ? { bb: edge(borders.bottom) } : {}),
      ...(borders.left ? { bl: edge(borders.left) } : {}),
      ...(borders.right ? { br: edge(borders.right) } : {}),
    };
  };
  const inked = (s) => s !== 0 && (book.fills[(book.xfs[s] || book.xfs[0]).fill] || Object.keys(book.borders[(book.xfs[s] || book.xfs[0]).border] || {}).length);
  const lookOfStyle = (s) => {
    const xf = book.xfs[s] || book.xfs[0];
    return styleId(look(xf, book.fonts[xf.font] || book.fonts[0], null, book.borders[xf.border] || {}, null, null, null));
  };

  const start = Math.max(0, Math.floor(Number(from) || 0));
  const end = Math.min(sheet.maxRow, start + MODEL_ROWS - 1);
  const cells = [];
  let reached = end;
  for (let r = start; r <= end; r += 1) {
    tools.budget.check();
    const row = sheet.rows.get(r);
    if (!row) continue;
    if (cells.length >= MODEL_CELLS) {
      reached = r - 1;
      break;
    }
    for (const [c, cell] of row) {
      if (sheet.covered.has(`${r},${c}`)) continue;
      const key = `${r},${c}`;
      const xf = book.xfs[cell.s] || book.xfs[0];
      const font = book.fonts[xf.font] || book.fonts[0];
      const table = sheet.tableCells.get(key);
      const cond = sheet.cond.get(key);
      const borders = book.borders[xf.border] || {};
      const painted = cond?.fill || book.fills[xf.fill] || table?.fill || cond?.bar || Object.keys(borders).length || table?.rule;
      if (!cell.text && !painted && !cell.formula) continue;
      const merge = sheet.merges.get(key);
      const width = merge ? sheet.colX[Math.min(merge.c1, sheet.maxCol) + 1] - sheet.colX[c] : sheet.colX[c + 1] - sheet.colX[c];
      let text = cell.text;
      // A number too wide for its cell reads as Excel reads it: fewer digits if it may, else ####.
      if (cell.kind === 'number' && !xf.align?.rotation && text) {
        const override = { ink: null, bold: !!(cond?.bold || table?.bold) };
        const widest = (list) => Math.max(...list.map((line) => line.width), 0);
        const room = width - PAD * 2 - (xf.align?.indent || 0) * INDENT;
        if (widest(sheet.setCell(cell, xf, font, width, override)) > room + 0.5 && !xf.align?.shrink) {
          const general = (book.numFmts.get(xf.numFmt) ?? xf.numFmt) === 0;
          let fitted = null;
          if (general) {
            for (let digits = 10; digits >= 1 && fitted === null; digits -= 1) {
              const shorter = String(Number(cell.value.toPrecision(digits)));
              if (widest(sheet.setCell({ ...cell, text: shorter, runs: null }, xf, font, width, override)) <= room + 0.5) fitted = shorter;
            }
          }
          if (fitted === null) {
            const each = Math.max(1, widest(sheet.setCell({ ...cell, text: '#', runs: null }, xf, font, width, override)));
            fitted = '#'.repeat(Math.max(1, Math.floor(room / each)));
          }
          text = fitted;
        }
      }
      let formula = cell.formula || null;
      if (!formula && cell.sharedAs != null) {
        const head = sheet.sharedFormulas.get(cell.sharedAs);
        if (head) formula = shiftFormula(head.text, r - head.row, c - head.col);
      }
      const shown = [r, c, text, styleId(look(xf, font, null, borders, table, cond, cell))];
      const extra = {};
      if (formula) extra.f = formula;
      if (cell.kind) extra.k = cell.kind === 'number' ? 'n' : cell.kind === 'text' ? 't' : cell.kind === 'bool' ? 'b' : cell.kind === 'error' ? 'e' : '';
      if (cell.kind === 'number') extra.v = cell.value;
      if (cond?.bar) extra.bar = [Number(cond.bar.ratio) || 0, safeHex(cond.bar.color) || '638EC6'];
      if (table?.rule) extra.rule = safeHex(table.rule);
      if (cell.runs) {
        extra.runs = cell.runs.map((run) => ({
          t: run.text,
          ...(run.font?.bold ? { b: 1 } : {}),
          ...(run.font?.italic ? { i: 1 } : {}),
          ...(run.font?.underline ? { u: 1 } : {}),
          ...(run.font?.strike ? { x: 1 } : {}),
          ...(safeHex(run.font?.color) ? { c: safeHex(run.font.color) } : {}),
          ...(run.font?.size ? { s: run.font.size } : {}),
        }));
      }
      shown.push(extra);
      cells.push(shown);
    }
  }

  const merges = [];
  for (const m of sheet.merges.values()) {
    if (m.r1 < start || m.r0 > reached) continue;
    merges.push([m.r0, m.c0, Math.min(m.r1, sheet.maxRow), Math.min(m.c1, sheet.maxCol)]);
  }
  const rowStyles = {};
  for (const [r, info] of sheet.rowInfo) if (r >= start && r <= reached && info.style != null && inked(info.style)) rowStyles[r] = lookOfStyle(info.style);
  const colStyles = {};
  for (const [c, info] of sheet.colInfo) if (c <= sheet.maxCol && info.style != null && inked(info.style)) colStyles[c] = lookOfStyle(info.style);
  const drawings = sheet.drawings.map((drawing, i) => {
    const box = drawingBox(sheet, drawing);
    const frame = localName(drawing.inner.name) === 'graphicFrame';
    return { i, x: box.x, y: box.y, w: box.w, h: box.h, kind: frame ? 'chart' : localName(drawing.inner.name) === 'pic' ? 'picture' : 'shape' };
  });
  return {
    sheets: visible.map((s, i) => ({ n: i + 1, name: s.name })),
    hiddenSheets: all.length - visible.length,
    charts,
    sheet: {
      number: index + 1,
      name: sheet.name,
      colX: sheet.colX.map((x) => Math.round(x * 100) / 100),
      rowY: sheet.rowY.map((y) => Math.round(y * 100) / 100),
      frozenRows: sheet.frozenRows,
      frozenCols: sheet.frozenCols,
      showGrid: sheet.showGrid,
      showHeaders: sheet.showHeaders,
      from: start,
      to: reached,
      lastRow: sheet.maxRow,
      cut: sheet.cut || 0,
      styles,
      cells,
      merges,
      rowStyles,
      colStyles,
      drawings,
    },
  };
}

/**
 * One thing that stands over a sheet's cells, drawn on its own: a chart, a picture, a
 * shape. So each goes where it belongs over the grid, and a chart can have a tab.
 *
 * @param {any} zip
 * @param {any} tools
 * @param {{ sheet?: number, index?: number }} ask
 * @returns {Promise<{ surface: any, label: string } | null>}
 */
export async function drawingSurface(zip, tools, { sheet: number = 1, index = 0 } = {}) {
  const book = new Book(zip, tools, null);
  const visible = listSheets(book, zip).filter((s) => !s.hidden);
  const entry = visible[Math.floor(Number(number) || 1) - 1];
  if (!entry) return null;
  const sheet = new Sheet(book, entry.part, entry.name, Number(number) || 1);
  const drawing = sheet.drawings[Math.floor(Number(index) || 0)];
  if (!drawing) return null;
  const box = drawingBox(sheet, drawing);
  const surface = new Surface(Math.max(4, box.w), Math.max(4, box.h));
  surface.save();
  surface.transform(1, 0, 0, 1, -box.x, -box.y);
  paintDrawings(surface, sheet, { r0: 0, r1: sheet.maxRow, c0: 0, c1: sheet.maxCol }, drawing);
  surface.restore();
  return { surface, label: entry.name };
}

/** The letters along the top and the numbers down the side, which are not the sheet's own words. */
function paintHeadings(surface, sheet, piece, { gutter, frozen, frozenH, width, height }) {
  const { book, colX, rowY } = sheet;
  const face = book.tools.fonts.pick('Arial', false, false);
  const size = 8.5;
  surface.quiet += 1;
  surface.rect(0, 0, width, HEAD_H, HEAD_FILL);
  surface.rect(0, 0, gutter, height, HEAD_FILL);
  surface.line(0, HEAD_H, width, HEAD_H, HEAD_LINE, 0.75);
  surface.line(gutter, 0, gutter, height, HEAD_LINE, 0.75);
  const measure = (text) => book.tools.measure.width(face, size, text);
  for (let c = piece.c0; c <= piece.c1; c += 1) {
    const w = colX[c + 1] - colX[c];
    if (w <= 0) continue;
    const x = gutter + colX[c] - colX[piece.c0];
    const letters = columnLetters(c);
    if (w > 10) surface.text(letters, x + (w - measure(letters)) / 2, HEAD_H - 4, { pick: face, size, color: HEAD_INK });
    surface.line(x + w, 0, x + w, HEAD_H, HEAD_LINE, 0.5);
  }
  const rowLabel = (r, y) => {
    const h = rowY[r + 1] - rowY[r];
    if (h <= 0) return;
    const label = String(r + 1);
    if (h > 8) surface.text(label, gutter - 3 - measure(label), y + Math.min(h, 15) / 2 + 3, { pick: face, size, color: HEAD_INK });
    surface.line(0, y + h, gutter, y + h, HEAD_LINE, 0.5);
  };
  if (frozenH) for (let r = 0; r < frozen; r += 1) rowLabel(r, HEAD_H + rowY[r]);
  const top = HEAD_H + frozenH;
  for (let r = piece.r0; r <= piece.r1; r += 1) rowLabel(r, top + rowY[r] - rowY[piece.r0]);
  surface.quiet -= 1;
}
