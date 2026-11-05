/**
 * A Word document, paginated and drawn.
 *
 * Word's own layout is not available here, so this sets the pages the way Word does
 * as far as a page can show it: styles inherited through `basedOn`, spacing added
 * rather than collapsed, widows kept, a heading kept with what follows, rows split
 * across pages with their header rows repeated, headers and footers laid out once
 * the page count is known, pictures in the text and floating over it.
 *
 * What it leaves out is said in the notes rather than guessed at. The model that
 * reads the result has to be able to tell a fault in the file from a limit in here.
 */
import { attr, element, elements, localName, parseXml, relationshipId, textOf } from '../xml.js';
import { isRel, mainPart, readRelationships, relsPathFor, resolveTarget } from '../opc.js';
import { LIMITS, Surface, clamp, emu, lightness, refused, twip } from './common.js';
import { drawNode, drawSmartArt, labelledBox, readTheme, readXfrm } from './dml.js';
import { drawChart } from './chart.js';
import { symbolChar } from './fonts.js';
import { paintLine, setLines } from './text.js';

/* ── small readers ──────────────────────────────────────────────────── */

/** A switch element: there and not switched off. Undefined when it is not there, so a style's value stands. */
function on(node) {
  if (!node) return undefined;
  const value = attr(node, 'val');
  return value === undefined || !(value === '0' || value === 'false' || value === 'off' || value === 'none');
}

/** Later objects win, key by key: how each level of a style overrides the last. */
const merged = (...levels) => Object.assign({}, ...levels.filter(Boolean));

const HIGHLIGHT = {
  black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000', yellow: 'FFFF00', white: 'FFFFFF',
  darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000', darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0',
};

const SLOT = { dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink' };

function toHsl(hex) {
  const n = parseInt(hex, 16) || 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

/** @param {number[]} hsl */
function fromHsl([h, s, l]) {
  if (!s) {
    const v = Math.round(l * 255);
    return [v, v, v].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const part = (t0) => {
    const t = (t0 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [part(h + 1 / 3), part(h), part(h - 1 / 3)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ── the document: everything shared by all of its pages ────────────── */

class Doc {
  constructor(zip, tools) {
    this.zip = zip;
    this.tools = tools;
    this.main = mainPart(zip, 'word/document.xml');
    if (!zip.has(this.main)) throw refused('That .docx has no document part, so it may be corrupt.');
    this.root = parseXml(zip.text(this.main));
    this.rels = readRelationships(zip, relsPathFor(this.main));
    const related = (kind) => {
      for (const [, rel] of this.rels) if (isRel(rel.type, kind) && rel.mode !== 'External') return resolveTarget(this.main, rel.target);
      return null;
    };
    this.related = related;
    this.theme = readTheme(zip, related('theme'));
    this.readSettings(related('settings'));
    this.readStyles(related('styles'));
    this.readNumbering(related('numbering'));
    /** Running list counters, by abstract list and level. */
    this.counters = new Map();
    this.usedNums = new Set();
    /** Footnotes by id, and the number each has been given. */
    this.footnotes = this.readNotes(related('footnotes'), 'footnote');
    this.footNumbers = new Map();
    /** A complex field being read, which can span paragraphs. */
    this.fields = [];
    this.field = { page: 1, pages: 1, display: '1' };
    /** What each page draws last, and what the loop asked to be said once. */
    this.warned = new Set();
    this.depth = 0;
  }

  say(text) {
    if (this.warned.has(text)) return;
    this.warned.add(text);
    this.tools.note(text);
  }

  readSettings(part) {
    this.defaultTab = 36;
    this.evenOdd = false;
    this.background = false;
    this.compat = 12;
    this.map = { background1: 'lt1', text1: 'dk1', background2: 'lt2', text2: 'dk2' };
    if (!part || !this.zip.has(part)) return;
    const root = parseXml(this.zip.text(part));
    const tab = attr(element(root, 'defaultTabStop'), 'val');
    if (tab) this.defaultTab = Math.max(1, twip(tab));
    this.evenOdd = on(element(root, 'evenAndOddHeaders')) === true;
    this.background = on(element(root, 'displayBackgroundShape')) === true;
    for (const setting of elements(element(root, 'compat'), 'compatSetting')) {
      if (attr(setting, 'name') === 'compatibilityMode') this.compat = Number(attr(setting, 'val')) || 12;
    }
    const scheme = element(root, 'clrSchemeMapping');
    if (scheme) {
      const slot = (name, fallback) => SLOT[String(attr(scheme, name) || '')] || fallback;
      this.map = { background1: slot('bg1', 'lt1'), text1: slot('t1', 'dk1'), background2: slot('bg2', 'lt2'), text2: slot('t2', 'dk2') };
    }
  }

  readStyles(part) {
    this.styles = new Map();
    this.defaultParagraph = null;
    this.defaultTable = null;
    this.baseR = {};
    this.baseP = {};
    this.styleCache = new Map();
    if (!part || !this.zip.has(part)) return;
    const root = parseXml(this.zip.text(part));
    const defaults = element(root, 'docDefaults');
    this.baseR = this.readR(element(element(defaults, 'rPrDefault'), 'rPr'));
    this.baseP = this.readP(element(element(defaults, 'pPrDefault'), 'pPr'));
    for (const style of elements(root, 'style')) {
      const id = String(attr(style, 'styleId') || '');
      if (!id) continue;
      this.styles.set(id, style);
      if (attr(style, 'default') === '1' || attr(style, 'default') === 'true') {
        if (attr(style, 'type') === 'paragraph') this.defaultParagraph = id;
        if (attr(style, 'type') === 'table') this.defaultTable = id;
      }
    }
  }

  /** A style with everything it is based on: `{ r, p, tbl, tc, cond }`. A loop in `basedOn` ends at the depth limit. */
  style(id) {
    if (!id) return { r: {}, p: {}, tbl: {}, tc: {}, cond: {}, chain: [] };
    const cached = this.styleCache.get(id);
    if (cached) return cached;
    const chain = [];
    let at = this.styles.get(id);
    for (let guard = 0; at && guard < 24; guard += 1) {
      chain.unshift(at);
      at = this.styles.get(String(attr(element(at, 'basedOn'), 'val') || ''));
    }
    const out = { r: {}, p: {}, tbl: {}, tc: {}, cond: {}, chain };
    for (const node of chain) {
      out.r = merged(out.r, this.readR(element(node, 'rPr')));
      out.p = merged(out.p, this.readP(element(node, 'pPr')));
      out.tbl = merged(out.tbl, this.readTbl(element(node, 'tblPr')));
      out.tc = merged(out.tc, this.readTc(element(node, 'tcPr')));
      for (const cond of elements(node, 'tblStylePr')) {
        const type = String(attr(cond, 'type') || '');
        const before = out.cond[type] || {};
        out.cond[type] = {
          r: merged(before.r, this.readR(element(cond, 'rPr'))),
          p: merged(before.p, this.readP(element(cond, 'pPr'))),
          tc: merged(before.tc, this.readTc(element(cond, 'tcPr'))),
        };
      }
    }
    this.styleCache.set(id, out);
    return out;
  }

  /** A colour attribute set: a theme slot where one is named, else the literal value. */
  color(node, valName = 'color', themeName = 'themeColor', tintName = 'themeTint', shadeName = 'themeShade') {
    const value = String(attr(node, valName) ?? '');
    const theme = attr(node, themeName);
    if (theme) {
      const name = String(theme);
      const slot = this.map[name] || SLOT[name] || name;
      const hex = this.theme.colors[slot];
      if (hex) {
        const tint = attr(node, tintName);
        const shade = attr(node, shadeName);
        if (!tint && !shade) return hex;
        const hsl = toHsl(hex);
        if (shade) hsl[2] *= (parseInt(String(shade), 16) || 255) / 255;
        if (tint) {
          const t = (parseInt(String(tint), 16) || 255) / 255;
          hsl[2] = hsl[2] * t + (1 - t);
        }
        return fromHsl(hsl);
      }
    }
    if (!value || value === 'auto') return null;
    return /^[0-9a-fA-F]{6}$/.test(value) ? value : null;
  }

  /** What a `w:shd` paints, or null: a pattern reads as a mix of its two colours. */
  shading(node) {
    if (!node) return undefined;
    const val = String(attr(node, 'val') || 'clear');
    if (val === 'nil') return null;
    const fill = this.color(node, 'fill', 'themeFill', 'themeFillTint', 'themeFillShade');
    const color = this.color(node);
    if (val === 'solid') return color || '000000';
    const pct = /^pct(\d+)$/.exec(val);
    if (pct && color) {
      const share = Number(pct[1]) / 100;
      const a = parseInt(color, 16);
      const b = parseInt(fill || 'FFFFFF', 16);
      const mix = (shift) => Math.round(((a >> shift) & 255) * share + ((b >> shift) & 255) * (1 - share));
      return [16, 8, 0].map((s) => mix(s).toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return fill || null;
  }

  /** A border as it paints, or null for none. */
  border(node) {
    const val = String(attr(node, 'val') || 'none');
    if (val === 'nil' || val === 'none') return null;
    const size = Math.max(1 / 8, (Number(attr(node, 'sz')) || 4) / 8);
    const dash = /dotted/i.test(val) ? [size, size * 1.5] : /dash/i.test(val) ? [size * 4, size * 2.5] : null;
    return {
      width: val === 'thick' ? Math.max(size, 1.5) : size,
      color: this.color(node) || '000000',
      dash,
      double: /double|triple/i.test(val),
      space: Number(attr(node, 'space')) || 0,
    };
  }

  /** Run properties as a partial object: only what this level states. */
  readR(rPr) {
    const out = {};
    if (!rPr) return out;
    for (const child of elements(rPr)) {
      const name = localName(child.name);
      switch (name) {
        case 'rStyle': out.rStyle = String(attr(child, 'val') || ''); break;
        case 'rFonts': out.font = merged(out.font, {
          ...(attr(child, 'ascii') ? { name: String(attr(child, 'ascii')) } : attr(child, 'hAnsi') ? { name: String(attr(child, 'hAnsi')) } : {}),
          ...(attr(child, 'asciiTheme') ? { theme: String(attr(child, 'asciiTheme')) } : attr(child, 'hAnsiTheme') ? { theme: String(attr(child, 'hAnsiTheme')) } : {}),
        }); break;
        case 'b': out.bold = on(child); break;
        case 'i': out.italic = on(child); break;
        case 'caps': out.caps = on(child); break;
        case 'smallCaps': out.smallCaps = on(child); break;
        case 'strike': out.strike = on(child); break;
        case 'dstrike': out.dstrike = on(child); break;
        case 'vanish': case 'webHidden': out.hidden = on(child); break;
        case 'color': out.color = attr(child, 'val') === 'auto' && !attr(child, 'themeColor') ? 'auto' : this.color(child, 'val') || 'auto'; break;
        case 'sz': out.size = (Number(attr(child, 'val')) || 20) / 2; break;
        case 'highlight': out.highlight = HIGHLIGHT[String(attr(child, 'val') || '')] || null; break;
        case 'shd': out.shd = this.shading(child); break;
        case 'u': { const v = String(attr(child, 'val') || 'single'); out.underline = v === 'none' ? false : v === 'double' ? 'double' : true; break; }
        case 'vertAlign': { const v = attr(child, 'val'); out.vert = v === 'superscript' ? 0.33 : v === 'subscript' ? -0.1 : 0; break; }
        case 'spacing': out.spacing = twip(attr(child, 'val')); break;
        default: break;
      }
    }
    return out;
  }

  /** Paragraph properties as a partial object. */
  readP(pPr) {
    const out = {};
    if (!pPr) return out;
    for (const child of elements(pPr)) {
      const name = localName(child.name);
      switch (name) {
        case 'pStyle': out.pStyle = String(attr(child, 'val') || ''); break;
        case 'jc': out.align = String(attr(child, 'val') || 'left'); break;
        case 'keepNext': out.keepNext = on(child); break;
        case 'keepLines': out.keepLines = on(child); break;
        case 'pageBreakBefore': out.pageBreak = on(child); break;
        case 'widowControl': out.widow = on(child); break;
        case 'contextualSpacing': out.contextual = on(child); break;
        case 'shd': out.shd = this.shading(child); break;
        case 'numPr': {
          const numId = attr(element(child, 'numId'), 'val');
          if (numId !== undefined) out.numId = String(numId);
          const ilvl = attr(element(child, 'ilvl'), 'val');
          if (ilvl !== undefined) out.ilvl = Number(ilvl) || 0;
          break;
        }
        case 'ind': {
          const read = (a, b) => attr(child, a) ?? attr(child, b);
          const left = read('left', 'start');
          const right = read('right', 'end');
          if (left !== undefined) out.left = twip(left);
          if (right !== undefined) out.right = twip(right);
          if (attr(child, 'hanging') !== undefined) out.firstLine = -twip(attr(child, 'hanging'));
          else if (attr(child, 'firstLine') !== undefined) out.firstLine = twip(attr(child, 'firstLine'));
          break;
        }
        case 'spacing': {
          if (attr(child, 'before') !== undefined) out.before = twip(attr(child, 'before'));
          if (attr(child, 'after') !== undefined) out.after = twip(attr(child, 'after'));
          const truthy = (name) => attr(child, name) === '1' || attr(child, name) === 'true';
          if (truthy('beforeAutospacing')) out.before = 14;
          if (truthy('afterAutospacing')) out.after = 14;
          if (attr(child, 'line') !== undefined) {
            out.line = Number(attr(child, 'line')) || 240;
            out.lineRule = String(attr(child, 'lineRule') || 'auto');
          }
          break;
        }
        case 'tabs': {
          out.tabs = merged(out.tabs);
          for (const tab of elements(child, 'tab')) {
            const pos = twip(attr(tab, 'pos'));
            out.tabs[pos] = { pos, kind: String(attr(tab, 'val') || 'left'), leader: attr(tab, 'leader') && attr(tab, 'leader') !== 'none' ? String(attr(tab, 'leader')) : undefined };
          }
          break;
        }
        case 'pBdr': {
          const box = {};
          for (const side of ['top', 'left', 'bottom', 'right']) {
            const edge = this.border(element(child, side));
            if (edge) box[side] = edge;
          }
          out.box = box;
          break;
        }
        default: break;
      }
    }
    return out;
  }

  readTbl(tblPr) {
    const out = {};
    if (!tblPr) return out;
    const borders = element(tblPr, 'tblBorders');
    if (borders) out.borders = this.edges(borders);
    const margin = element(tblPr, 'tblCellMar');
    if (margin) out.margin = this.margins(margin);
    const ind = element(tblPr, 'tblInd');
    if (ind && attr(ind, 'type') !== 'auto') out.indent = twip(attr(ind, 'w'));
    const jc = attr(element(tblPr, 'jc'), 'val');
    if (jc) out.align = String(jc);
    const width = element(tblPr, 'tblW');
    if (width) out.width = { kind: String(attr(width, 'type') || 'auto'), value: Number(attr(width, 'w')) || 0 };
    if (attr(element(tblPr, 'tblLayout'), 'type')) out.layout = String(attr(element(tblPr, 'tblLayout'), 'type'));
    const look = element(tblPr, 'tblLook');
    if (look) out.look = look;
    const rowBand = attr(element(tblPr, 'tblStyleRowBandSize'), 'val');
    if (rowBand) out.rowBand = Number(rowBand) || 1;
    const colBand = attr(element(tblPr, 'tblStyleColBandSize'), 'val');
    if (colBand) out.colBand = Number(colBand) || 1;
    return out;
  }

  readTc(tcPr) {
    const out = {};
    if (!tcPr) return out;
    const shd = element(tcPr, 'shd');
    if (shd) out.shd = this.shading(shd);
    const borders = element(tcPr, 'tcBorders');
    if (borders) out.borders = this.edges(borders);
    const margin = element(tcPr, 'tcMar');
    if (margin) out.margin = this.margins(margin);
    if (attr(element(tcPr, 'vAlign'), 'val')) out.vAlign = String(attr(element(tcPr, 'vAlign'), 'val'));
    if (attr(element(tcPr, 'textDirection'), 'val')) out.direction = String(attr(element(tcPr, 'textDirection'), 'val'));
    return out;
  }

  /** Borders by edge. An edge marked `nil` is kept as null: it cancels the one a style gave. */
  edges(node) {
    const out = {};
    const aliases = { start: 'left', end: 'right' };
    for (const child of elements(node)) {
      const name = localName(child.name);
      const side = aliases[name] || name;
      if (['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].includes(side)) out[side] = this.border(child);
    }
    return out;
  }

  margins(node) {
    const out = {};
    const aliases = { start: 'left', end: 'right' };
    for (const child of elements(node)) {
      const name = localName(child.name);
      const side = aliases[name] || name;
      if (['top', 'left', 'bottom', 'right'].includes(side)) out[side] = twip(attr(child, 'w'));
    }
    return out;
  }

  readNumbering(part) {
    this.abstracts = new Map();
    this.nums = new Map();
    if (!part || !this.zip.has(part)) return;
    const root = parseXml(this.zip.text(part));
    for (const node of elements(root, 'abstractNum')) {
      const levels = new Map();
      for (const lvl of elements(node, 'lvl')) levels.set(Number(attr(lvl, 'ilvl')) || 0, this.readLevel(lvl));
      this.abstracts.set(String(attr(node, 'abstractNumId')), levels);
    }
    for (const node of elements(root, 'num')) {
      const overrides = new Map();
      for (const over of elements(node, 'lvlOverride')) {
        const lvl = element(over, 'lvl');
        const start = attr(element(over, 'startOverride'), 'val');
        overrides.set(Number(attr(over, 'ilvl')) || 0, { level: lvl ? this.readLevel(lvl) : null, start: start === undefined ? null : Number(start) });
      }
      this.nums.set(String(attr(node, 'numId')), { abstract: String(attr(element(node, 'abstractNumId'), 'val')), overrides });
    }
  }

  readLevel(lvl) {
    return {
      start: Number(attr(element(lvl, 'start'), 'val') ?? 1),
      format: String(attr(element(lvl, 'numFmt'), 'val') || 'decimal'),
      text: String(attr(element(lvl, 'lvlText'), 'val') ?? ''),
      suffix: String(attr(element(lvl, 'suff'), 'val') || 'tab'),
      p: this.readP(element(lvl, 'pPr')),
      r: this.readR(element(lvl, 'rPr')),
    };
  }

  readNotes(part, tag) {
    const notes = new Map();
    if (!part || !this.zip.has(part)) return notes;
    const root = parseXml(this.zip.text(part));
    const rels = readRelationships(this.zip, relsPathFor(part));
    for (const note of elements(root, tag)) {
      const type = attr(note, 'type');
      if (type && type !== 'normal') continue;
      notes.set(String(attr(note, 'id')), { blocks: elements(note), part, rels });
    }
    return notes;
  }

  /** The level and how a list number comes out, advancing the count. */
  listLabel(numId, ilvl) {
    const num = this.nums.get(String(numId));
    if (!num) return null;
    const levels = this.abstracts.get(num.abstract);
    if (!levels) return null;
    const override = num.overrides.get(ilvl);
    const level = override?.level || levels.get(ilvl);
    if (!level) return null;
    let counts = this.counters.get(num.abstract);
    if (!counts) {
      counts = [];
      this.counters.set(num.abstract, counts);
    }
    const key = `${numId}:${ilvl}`;
    if (override?.start != null && !this.usedNums.has(key)) counts[ilvl] = undefined;
    this.usedNums.add(key);
    counts[ilvl] = counts[ilvl] === undefined ? (override?.start ?? level.start) : counts[ilvl] + 1;
    for (let deeper = ilvl + 1; deeper < counts.length; deeper += 1) counts[deeper] = undefined;
    const text = level.text.replace(/%([1-9])/g, (_, digit) => {
      const at = Number(digit) - 1;
      const other = at === ilvl ? level : num.overrides.get(at)?.level || levels.get(at);
      if (!other) return '';
      const count = counts[at] ?? other.start;
      return formatNumber(count, level.format === 'bullet' ? 'decimal' : other.format);
    });
    return { level, text };
  }
}

/** @type {[number, string][]} */
const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

function roman(value) {
  let n = Math.min(3999, Math.max(1, value));
  let out = '';
  for (const [size, letters] of ROMAN) {
    while (n >= size) {
      out += letters;
      n -= size;
    }
  }
  return out;
}

function letters(value) {
  const n = Math.max(1, value);
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

/** A count in a list's own format. A format not known here reads as a plain number. */
export function formatNumber(value, format) {
  switch (format) {
    case 'lowerRoman': return roman(value).toLowerCase();
    case 'upperRoman': return roman(value);
    case 'lowerLetter': return letters(value);
    case 'upperLetter': return letters(value).toUpperCase();
    case 'decimalZero': return value < 10 ? `0${value}` : String(value);
    case 'ordinal': return `${value}.`;
    case 'none': return '';
    default: return String(value);
  }
}

/* ── runs into words ────────────────────────────────────────────────── */

/** A run's properties as the text setter wants them. */
function textStyle(doc, r, ctx) {
  const fontName = r.font?.theme
    ? /^major/i.test(r.font.theme) ? doc.theme.major : doc.theme.minor
    : r.font?.name || 'Times New Roman';
  const size = r.size || 10;
  const pick = doc.tools.fonts.pick(fontName, !!r.bold, !!r.italic);
  const color = r.color && r.color !== 'auto' ? `#${r.color}` : ctx.autoColor || '#000000';
  return {
    pick,
    size,
    color,
    underline: r.underline || false,
    strike: !!r.strike,
    doubleStrike: !!r.dstrike,
    highlight: r.highlight ? `#${r.highlight}` : r.shd ? `#${r.shd}` : null,
    shift: r.vert || 0,
    spacing: r.spacing || 0,
    caps: !!r.caps,
    smallCaps: !!r.smallCaps,
    fontName,
  };
}

/** A symbol font holds no letters here: each character becomes the Unicode shape nearest it. */
function symbolText(fontName, text) {
  if (!/symbol|wingdings|webdings/i.test(String(fontName || ''))) return text;
  return [...text].map((ch) => symbolChar(fontName, ch) || ch).join('');
}

/** What a field shows when the page knows better than the file's saved result. */
function liveField(instr, doc) {
  const name = String(instr || '').trim().split(/\s+/)[0]?.toUpperCase();
  if (name === 'PAGE') return doc.field.display;
  if (name === 'NUMPAGES' || name === 'SECTIONPAGES') return String(doc.field.pages);
  return null;
}

/**
 * The words, tabs and pictures of a paragraph's content, in order.
 *
 * @param {any} parent  a paragraph, or something inside one that holds runs
 * @param {any} ctx
 * @param {any} baseR  what its runs inherit
 * @param {any[]} out
 */
function collectInlines(parent, ctx, baseR, out) {
  const { doc } = ctx;
  for (const node of elements(parent)) {
    doc.tools.budget.check();
    const name = localName(node.name);
    if (name === 'r') collectRun(node, ctx, baseR, out);
    else if (name === 'hyperlink' || name === 'ins' || name === 'smartTag' || name === 'customXml' || name === 'moveTo' || name === 'dir' || name === 'bdo') collectInlines(node, ctx, baseR, out);
    else if (name === 'sdt') collectInlines(element(node, 'sdtContent') || node, ctx, baseR, out);
    else if (name === 'fldSimple') {
      const live = liveField(attr(node, 'instr'), doc);
      if (live !== null) out.push({ type: 'text', text: live, style: textStyle(doc, baseR, ctx) });
      else collectInlines(node, ctx, baseR, out);
    } else if (name === 'AlternateContent') {
      const choice = element(node, 'Choice');
      collectInlines(choice && elements(choice).length ? choice : element(node, 'Fallback'), ctx, baseR, out);
    }
  }
}

function collectRun(run, ctx, baseR, out) {
  const { doc } = ctx;
  const direct = doc.readR(element(run, 'rPr'));
  const charStyle = direct.rStyle ? doc.style(direct.rStyle).r : null;
  const r = merged(baseR, charStyle, direct);
  if (r.hidden) return;
  const style = textStyle(doc, r, ctx);
  const open = doc.fields[doc.fields.length - 1];

  for (const child of elements(run)) {
    const name = localName(child.name);
    if (name === 'fldChar') {
      const type = attr(child, 'fldCharType');
      if (type === 'begin') doc.fields.push({ instr: '', shown: false, live: null });
      else if (type === 'separate' && doc.fields.length) {
        const field = doc.fields[doc.fields.length - 1];
        field.shown = true;
        field.live = liveField(field.instr, doc);
        if (field.live !== null) out.push({ type: 'text', text: field.live, style });
      } else if (type === 'end' && doc.fields.length) {
        const field = doc.fields.pop();
        if (!field.shown) {
          const live = liveField(field.instr, doc);
          if (live !== null) out.push({ type: 'text', text: live, style });
        }
      }
      continue;
    }
    const field = doc.fields[doc.fields.length - 1] || open;
    if (name === 'instrText') {
      if (field && !field.shown) field.instr += textOf(child);
      continue;
    }
    // Between `begin` and `separate` is the field's code; a live one replaces its saved result.
    if (field && (!field.shown || field.live !== null)) continue;
    switch (name) {
      case 't': {
        const text = symbolText(style.fontName, textOf(child));
        if (text) out.push({ type: 'text', text, style });
        break;
      }
      case 'noBreakHyphen': out.push({ type: 'text', text: '-', style }); break;
      case 'tab': out.push({ type: 'tab', style }); break;
      case 'ptab': {
        const kind = attr(child, 'alignment') === 'right' ? 'right' : attr(child, 'alignment') === 'center' ? 'center' : 'left';
        const pos = kind === 'right' ? ctx.width : kind === 'center' ? ctx.width / 2 : 0;
        out.push({ type: 'tab', style, stop: { pos, kind } });
        break;
      }
      case 'cr': out.push({ type: 'br', style }); break;
      case 'br': {
        const type = attr(child, 'type');
        if (type === 'page' || type === 'column') out.push({ type: 'hard', kind: type, style });
        else out.push({ type: 'br', style });
        break;
      }
      case 'sym': {
        const font = String(attr(child, 'font') || '');
        const code = parseInt(String(attr(child, 'char') || '0'), 16) || 0;
        const shown = symbolChar(font, String.fromCodePoint(code)) || String.fromCodePoint(code);
        out.push({ type: 'text', text: shown, style: { ...style, pick: doc.tools.fonts.pick('Arial', style.pick.bold, style.pick.italic) } });
        break;
      }
      case 'footnoteReference': {
        const id = String(attr(child, 'id'));
        if (!doc.footNumbers.has(id)) doc.footNumbers.set(id, doc.footNumbers.size + 1);
        out.push({ type: 'text', text: String(doc.footNumbers.get(id)), style: { ...style, shift: style.shift || 0.33, foot: id } });
        break;
      }
      case 'footnoteRef': out.push({ type: 'text', text: String(ctx.footNumber ?? ''), style: { ...style, shift: style.shift || 0.33 } }); break;
      case 'endnoteReference':
        doc.say('The document has endnotes; their marks are shown but their text is not drawn here.');
        out.push({ type: 'text', text: '*', style: { ...style, shift: 0.33 } });
        break;
      case 'drawing': collectDrawing(child, ctx, out); break;
      case 'pict': case 'object': collectVml(child, ctx, out); break;
      case 'AlternateContent': {
        const choice = element(child, 'Choice');
        const inner = choice && elements(choice).length ? choice : element(child, 'Fallback');
        collectRun({ ...run, children: [element(run, 'rPr'), ...elements(inner)].filter(Boolean) }, ctx, baseR, out);
        break;
      }
      default: break;
    }
  }
}

/* ── drawings ───────────────────────────────────────────────────────── */

/** What dml.js needs to know about the part a drawing is in. */
function drawEnv(ctx) {
  const { doc } = ctx;
  return {
    zip: doc.zip,
    theme: doc.theme,
    clrMap: { tx1: doc.map.text1, bg1: doc.map.background1, tx2: doc.map.text2, bg2: doc.map.background2 },
    part: ctx.part,
    rels: ctx.rels,
    fonts: doc.tools.fonts,
    measure: doc.tools.measure,
    budget: doc.tools.budget,
    note: doc.tools.note,
    noteAt: (text) => doc.say(`The document ${text}.`),
    drawFrame: (surface, node, box, env) => paintGraphic(surface, node, box, env, ctx),
    drawText: (surface, node, box) => shapeText(surface, node, box, ctx),
  };
}

/** The words in a Word shape: a small flow of paragraphs inside the box. */
function shapeText(surface, node, box, ctx) {
  const content = element(element(node, 'txbx'), 'txbxContent');
  if (!content) return;
  const body = element(node, 'bodyPr');
  const inset = (name, fallback) => (attr(body, name) === undefined ? fallback : emu(attr(body, name)));
  const l = inset('lIns', 7.2);
  const t = inset('tIns', 3.6);
  const r = inset('rIns', 7.2);
  const b = inset('bIns', 3.6);
  const width = Math.max(4, box.w - l - r);
  const items = flow(elements(content), width, { ...ctx, width, autoColor: null, inShape: true });
  const height = items.reduce((sum, item) => sum + (item.h || 0), 0);
  const anchor = attr(body, 'anchor');
  const room = box.h - t - b;
  const top = box.y + t + (anchor === 'ctr' ? Math.max(0, (room - height) / 2) : anchor === 'b' ? Math.max(0, room - height) : 0);
  let y = top;
  for (const item of items) {
    item.paint?.(surface, box.x + l, y, ctx.geo || {});
    y += item.h || 0;
  }
}

/** A chart, a diagram or a shape from `a:graphicData`, in the box it was given. */
function paintGraphic(surface, holder, box, env, ctx) {
  const { doc } = ctx;
  const data = element(element(holder, 'graphic'), 'graphicData');
  if (!data) return;
  const uri = String(attr(data, 'uri') || '');
  if (/\/chart$/.test(uri)) {
    const rel = env.rels?.get(String(relationshipId(element(data, 'chart'))));
    if (rel && drawChart(surface, resolveTarget(env.part, rel.target), box, env)) {
      doc.say('The document has a chart, drawn from its saved numbers by a simplified drawing, so its styling may differ.');
    } else {
      labelledBox(surface, box.x, box.y, box.w, box.h, 'Chart', env);
      doc.say('The document has a chart that could not be drawn; it appears as a labelled box.');
    }
    return;
  }
  if (/\/diagram$/.test(uri)) {
    if (!drawSmartArt(surface, data, box, env)) {
      labelledBox(surface, box.x, box.y, box.w, box.h, 'SmartArt diagram', env);
      doc.say('The document has a SmartArt diagram with no saved drawing; it appears as a labelled box.');
    }
    return;
  }
  const child = elements(data)[0];
  if (!child) return;
  const xfrm = readXfrm(element(child, 'spPr')) || readXfrm(element(child, 'grpSpPr'));
  // A drawing in Word is placed by its anchor: the offset inside it means little, and is often zero.
  const map = xfrm && xfrm.w > 0 && xfrm.h > 0
    ? { sx: box.w / xfrm.w, sy: box.h / xfrm.h, dx: box.x - xfrm.x * (box.w / xfrm.w), dy: box.y - xfrm.y * (box.h / xfrm.h) }
    : { sx: 1, sy: 1, dx: box.x, dy: box.y };
  drawNode(surface, child, xfrm ? env : { ...env, fallbackXfrm: { x: 0, y: 0, w: box.w, h: box.h } }, map);
}

/** An inline picture goes in the line; an anchored one is kept for the paragraph to place. */
function collectDrawing(drawing, ctx, out) {
  const inline = element(drawing, 'inline');
  if (inline) {
    const extent = element(inline, 'extent');
    const width = emu(attr(extent, 'cx'));
    const height = emu(attr(extent, 'cy'));
    const env = drawEnv(ctx);
    // Wider than the column it is in, Word still draws it; here it stays on the page's picture either way.
    out.push({
      type: 'box',
      width,
      height,
      paint: (surface, x, top) => paintGraphic(surface, inline, { x, y: top, w: width, h: height, rot: 0 }, env, ctx),
    });
    return;
  }
  const anchor = element(drawing, 'anchor');
  if (anchor) out.push({ type: 'anchor', anchor });
}

/** The old drawing format: a picture can be drawn from it, and little else. */
function collectVml(node, ctx, out) {
  const { doc } = ctx;
  const image = findDeep(node, 'imagedata');
  const shape = findDeep(node, 'shape');
  const textpath = findDeep(node, 'textpath');
  if (textpath && attr(textpath, 'string')) {
    doc.say(`The document has a WordArt or watermark reading "${String(attr(textpath, 'string')).slice(0, 60)}", which is not drawn here.`);
    return;
  }
  const rel = image ? ctx.rels?.get(String(relationshipId(image) || attr(image, 'id') || '')) : null;
  if (!rel || rel.mode === 'External') {
    doc.say('The document has an older kind of drawing (VML) that is not drawn here.');
    return;
  }
  const path = resolveTarget(ctx.part, rel.target);
  const style = String(attr(shape, 'style') || '');
  const size = (name) => {
    const match = new RegExp(`${name}:\\s*([\\d.]+)(pt|in|px)?`).exec(style);
    if (!match) return 0;
    const value = Number(match[1]);
    return match[2] === 'in' ? value * 72 : match[2] === 'px' ? value * 0.75 : value;
  };
  const width = size('width') || 144;
  const height = size('height') || 108;
  out.push({ type: 'box', width, height, paint: (surface, x, top) => surface.picture(path, { x, y: top, w: width, h: height }) });
}

function findDeep(node, name) {
  for (const child of elements(node)) {
    if (localName(child.name) === name) return child;
    const found = findDeep(child, name);
    if (found) return found;
  }
  return null;
}

/**
 * Where a floating drawing goes on the page, in points.
 *
 * @param {any} anchor
 * @param {{ x: number, y: number, w: number, h: number }} frame  the column and the line it is anchored to
 * @param {any} geo
 */
function placeAnchor(anchor, frame, geo) {
  const extent = element(anchor, 'extent');
  const w = emu(attr(extent, 'cx'));
  const h = emu(attr(extent, 'cy'));
  const axis = (node, size, spaces) => {
    const from = String(attr(node, 'relativeFrom') || '');
    const [start, length] = spaces[from] || spaces.default;
    const offset = textOf(element(node, 'posOffset') || { children: [] }).trim();
    if (offset !== '') return start + emu(offset);
    const align = textOf(element(node, 'align') || { children: [] }).trim();
    if (align === 'center') return start + (length - size) / 2;
    if (align === 'right' || align === 'bottom' || align === 'outside') return start + length - size;
    return start;
  };
  const x = axis(element(anchor, 'positionH'), w, {
    page: [0, geo.w], margin: [geo.left, geo.w - geo.left - geo.right], leftMargin: [0, geo.left], rightMargin: [geo.w - geo.right, geo.right],
    insideMargin: [0, geo.left], outsideMargin: [geo.w - geo.right, geo.right], column: [frame.x, frame.w], character: [frame.x, frame.w], default: [frame.x, frame.w],
  });
  const y = axis(element(anchor, 'positionV'), h, {
    page: [0, geo.h], margin: [geo.top, geo.h - geo.top - geo.bottom], topMargin: [0, geo.top], bottomMargin: [geo.h - geo.bottom, geo.bottom],
    insideMargin: [0, geo.top], outsideMargin: [geo.h - geo.bottom, geo.bottom], paragraph: [frame.y, frame.h], line: [frame.y, frame.h], default: [frame.y, frame.h],
  });
  return { x, y, w, h };
}

/** Whether words go around this drawing, and how far off it they keep. */
function wrapOf(anchor) {
  if (attr(anchor, 'behindDoc') === '1') return { kind: 'none', behind: true };
  const dist = (name) => emu(attr(anchor, name));
  for (const child of elements(anchor)) {
    const name = localName(child.name);
    if (name === 'wrapNone') return { kind: 'none', behind: false };
    if (name === 'wrapTopAndBottom') return { kind: 'block', t: dist('distT'), b: dist('distB') };
    if (name === 'wrapSquare' || name === 'wrapTight' || name === 'wrapThrough') return { kind: 'side', l: dist('distL'), r: dist('distR'), t: dist('distT'), b: dist('distB') };
  }
  return { kind: 'none', behind: false };
}

/* ── paragraphs into lines ──────────────────────────────────────────── */

/** The properties a paragraph ends up with, whatever they came through. */
function paragraphProps(p, ctx) {
  const { doc } = ctx;
  const direct = doc.readP(element(p, 'pPr'));
  const styleId = direct.pStyle || doc.defaultParagraph;
  const style = doc.style(styleId);
  const numId = direct.numId ?? style.p.numId;
  const ilvl = direct.ilvl ?? style.p.ilvl ?? 0;
  const num = numId && numId !== '0' ? doc.nums.get(String(numId)) : null;
  const listLevel = num ? num.overrides.get(ilvl)?.level || doc.abstracts.get(num.abstract)?.get(ilvl) : null;
  // A table style's paragraph properties lie under the paragraph style's.
  const props = merged(doc.baseP, ctx.tableP, style.p, listLevel?.p, direct);
  const markR = doc.readR(element(element(p, 'pPr'), 'rPr'));
  const baseR = merged(doc.baseR, ctx.tableR, style.r);
  return { props, baseR, markR, styleId, numId: num ? numId : null, ilvl };
}

/** The line height Word gives these words, and where in it the baseline sits. */
function lineMetrics(props) {
  const rule = props.lineRule || 'auto';
  const value = props.line || 240;
  return (line) => {
    const asc = Math.max(line.asc, line.boxH || 0);
    const natural = asc + line.desc + line.gap;
    if (rule === 'exact' || rule === 'exactly') line.height = value / 20;
    else if (rule === 'atLeast') line.height = Math.max(natural, value / 20);
    else line.height = natural * (value / 240);
    // Extra room goes above the words, and a line set too tight loses its top rather than its bottom.
    line.baseline = Math.max(0, line.height - line.desc);
  };
}

/**
 * A paragraph as items for the page: spacing, and one item per line.
 *
 * `hard` items break the page where a `w:br` said so. Floating drawings hang off the
 * first line they come in, and side-wrapped ones narrow the lines beside them, which
 * is why a top-level paragraph is set only once its position on the page is known.
 *
 * @param {any} p
 * @param {any} ctx
 * @param {{ prev?: any, next?: any, floats?: any[], at?: number }} around
 */
function paragraphItems(p, ctx, around = {}) {
  const { doc } = ctx;
  const { props, baseR, markR, styleId, numId, ilvl } = paragraphProps(p, ctx);
  const markStyle = textStyle(doc, merged(baseR, markR), ctx);
  const width = ctx.width;
  const left = props.left || 0;
  const right = props.right || 0;
  const firstLine = props.firstLine || 0;

  /** @type {any[]} */
  const inlines = [];
  const label = numId ? doc.listLabel(numId, ilvl) : null;
  if (label) {
    const r = merged(baseR, markR, label.level.r);
    const style = textStyle(doc, r, ctx);
    const symbol = /symbol|wingdings|webdings/i.test(String(style.fontName || ''));
    const text = symbolText(style.fontName, label.text);
    if (text) inlines.push({ type: 'text', text, style: symbol ? { ...style, pick: doc.tools.fonts.pick('Arial', false, false), caps: false, smallCaps: false } : style });
    if (label.level.suffix === 'tab') inlines.push({ type: 'tab', style, ...(firstLine < 0 ? { stop: { pos: left, kind: 'left' } } : {}) });
    else if (label.level.suffix === 'space') inlines.push({ type: 'text', text: ' ', style });
  }
  collectInlines(p, { ...ctx, width: width - right }, merged(baseR, null), inlines);

  // Hard breaks divide the paragraph; a break that ends it leaves nothing on the next page.
  /** @type {any[][]} */
  const chunks = [[]];
  /** @type {string[]} */
  const breaks = [];
  /** @type {any[]} */
  const anchors = [];
  for (const inline of inlines) {
    if (inline.type === 'hard') {
      breaks.push(inline.kind);
      chunks.push([]);
    } else if (inline.type === 'anchor') anchors.push(inline.anchor);
    else chunks[chunks.length - 1].push(inline);
  }

  const context = (other) => {
    if (!other || localName(other.name) !== 'p') return null;
    const direct = doc.readP(element(other, 'pPr'));
    return direct.pStyle || doc.defaultParagraph;
  };
  const before = props.contextual && context(around.prev) === styleId ? 0 : props.before || 0;
  const after = props.contextual && context(around.next) === styleId ? 0 : props.after || 0;
  const tabs = Object.values(props.tabs || {}).filter((tab) => tab.kind !== 'clear').sort((a, b) => a.pos - b.pos);
  if (firstLine < 0 && !tabs.some((tab) => Math.abs(tab.pos - left) < 0.5)) {
    tabs.push({ pos: left, kind: 'left' });
    tabs.sort((a, b) => a.pos - b.pos);
  }

  // Floats beside the text: `exclude` asks at a height on the page which side is taken.
  const floats = around.floats || [];
  const baseY = (around.at ?? 0) + before;
  const frameX = ctx.frameX ?? 0;
  // A line clears a drawing only if all of it does, so its height counts as well as its top.
  const lineGuess = (markStyle.size || 11) * 1.22 * ((props.lineRule || 'auto') === 'auto' ? (props.line || 240) / 240 : 1);
  const exclude = floats.length
    ? (y) => {
        const hits = floats.filter((f) => !f.block && baseY + y + lineGuess > f.y0 && baseY + y < f.y1);
        if (!hits.length) return null;
        const out = { left: 0, right: 0 };
        for (const f of hits) {
          const from = f.x0 - frameX;
          const to = f.x1 - frameX;
          if (from - left < width - right - to) out.left = Math.max(out.left, to - left);
          else out.right = Math.max(out.right, width - from);
        }
        return out;
      }
    : undefined;

  const box = props.box || null;
  const sameBox = (other) => {
    if (!box || !other || localName(other.name) !== 'p') return false;
    const them = doc.readP(element(other, 'pPr'));
    const theirs = merged(doc.baseP, doc.style(them.pStyle || doc.defaultParagraph).p, them);
    return JSON.stringify(theirs.box || null) === JSON.stringify(box) && (theirs.left || 0) === left && (theirs.right || 0) === right;
  };
  const closedTop = box?.top && !sameBox(around.prev);
  const closedBottom = box?.bottom && !sameBox(around.next);
  const topPad = closedTop ? box.top.space + box.top.width : 0;
  const bottomPad = closedBottom ? box.bottom.space + box.bottom.width : 0;

  /** @type {any[]} */
  const items = [];
  const para = { keepNext: !!props.keepNext, keepLines: !!props.keepLines, widow: props.widow !== false, lines: 0, placed: 0, breakAfter: null };

  chunks.forEach((chunk, index) => {
    if (index > 0) items.push({ kind: 'break', type: breaks[index - 1], hard: true });
    // Nothing after a final break, unless the paragraph is empty besides it.
    if (index > 0 && index === chunks.length - 1 && !chunk.length) return;
    const lines = setLines(chunk, {
      width: width - right,
      first: left + (index === 0 ? firstLine : 0),
      rest: left,
      align: props.align || 'left',
      tabs,
      defaultTab: doc.defaultTab,
      empty: markStyle,
      metrics: lineMetrics(props),
      exclude,
      startY: 0,
      fonts: doc.tools.fonts,
      measure: doc.tools.measure,
      budget: doc.tools.budget,
    });
    lines.forEach((line, i) => {
      const isFirst = index === 0 && i === 0;
      const isLast = index === chunks.length - 1 && i === lines.length - 1;
      const foots = /** @type {any[]} */ (line.items).filter((item) => item.k === 't' && item.style.foot).map((item) => item.style.foot);
      items.push({
        kind: 'line',
        para,
        h: line.height + (isFirst ? topPad : 0) + (isLast ? bottomPad : 0),
        foots,
        anchors: isFirst ? anchors : null,
        paint(surface, x, y) {
          const top = y + (isFirst ? topPad : 0);
          const fill = props.shd;
          const boxLeft = x + left - (box?.left ? box.left.space + box.left.width : 0);
          const boxRight = x + width - right + (box?.right ? box.right.space + box.right.width : 0);
          if (fill) surface.rect(boxLeft, y, boxRight - boxLeft, this.h, `#${fill}`);
          if (box) {
            if (isFirst && closedTop) drawRule(surface, boxLeft, y + box.top.width / 2, boxRight, y + box.top.width / 2, box.top);
            if (isLast && closedBottom) drawRule(surface, boxLeft, y + this.h - box.bottom.width / 2, boxRight, y + this.h - box.bottom.width / 2, box.bottom);
            if (box.left) drawRule(surface, boxLeft, y, boxLeft, y + this.h, box.left);
            if (box.right) drawRule(surface, boxRight, y, boxRight, y + this.h, box.right);
          }
          paintLine(surface, line, x, top);
        },
      });
    });
    para.lines += lines.length;
  });
  if (before) items.unshift({ kind: 'space', h: before });
  if (after) items.push({ kind: 'space', h: after });
  return items;
}

/** A rule, single or double, along a border's own colour and pattern. */
function drawRule(surface, x1, y1, x2, y2, edge) {
  if (!edge) return;
  if (!edge.double) {
    surface.line(x1, y1, x2, y2, `#${edge.color}`, edge.width, edge.dash);
    return;
  }
  const gap = Math.max(edge.width, 0.75);
  const horizontal = Math.abs(y1 - y2) < 0.01;
  surface.line(x1, y1 - (horizontal ? gap : 0), x2, y2 - (horizontal ? gap : 0), `#${edge.color}`, edge.width, edge.dash);
  surface.line(x1 - (horizontal ? 0 : gap), y1 + (horizontal ? gap : 0), x2 - (horizontal ? 0 : gap), y2 + (horizontal ? gap : 0), `#${edge.color}`, edge.width, edge.dash);
}

/* ── tables ─────────────────────────────────────────────────────────── */

const flag = (look, name, bit) => {
  if (!look) return false;
  const value = attr(look, name);
  if (value !== undefined) return value === '1' || value === 'true';
  const hex = parseInt(String(attr(look, 'val') || '0'), 16) || 0;
  return (hex & bit) !== 0;
};

/** The conditional parts of a table style that apply to this cell, weakest first. */
function conditionsOf(look, style, row, col, rows, cols, table) {
  const firstRow = flag(look, 'firstRow', 0x20);
  const lastRow = flag(look, 'lastRow', 0x40);
  const firstColumn = flag(look, 'firstColumn', 0x80);
  const lastColumn = flag(look, 'lastColumn', 0x100);
  const noH = flag(look, 'noHBand', 0x200);
  const noV = flag(look, 'noVBand', 0x400);
  const out = [];
  const add = (type) => {
    if (style.cond[type]) out.push(style.cond[type]);
  };
  add('wholeTable');
  if (!noV) {
    const at = col - (firstColumn ? 1 : 0);
    if (at >= 0) add(Math.floor(at / (table.colBand || 1)) % 2 === 0 ? 'band1Vert' : 'band2Vert');
  }
  if (!noH) {
    const at = row - (firstRow ? 1 : 0);
    if (at >= 0) add(Math.floor(at / (table.rowBand || 1)) % 2 === 0 ? 'band1Horz' : 'band2Horz');
  }
  const isFirst = firstRow && row === 0;
  const isLast = lastRow && row === rows - 1;
  if (firstColumn && col === 0) add('firstCol');
  if (lastColumn && col === cols - 1) add('lastCol');
  if (isFirst) add('firstRow');
  if (isLast) add('lastRow');
  if (isFirst && firstColumn && col === 0) add('nwCell');
  if (isFirst && lastColumn && col === cols - 1) add('neCell');
  if (isLast && firstColumn && col === 0) add('swCell');
  if (isLast && lastColumn && col === cols - 1) add('seCell');
  return out;
}

/** The grid's widths in points, adjusted to what the table was told to be. */
function gridWidths(tbl, table, available, rows, compat) {
  let grid = elements(element(tbl, 'tblGrid'), 'gridCol').slice(0, LIMITS.columns).map((col) => twip(attr(col, 'w')));
  if (!grid.some((w) => w > 0)) {
    // A generator that wrote no widths in the grid often wrote them on the cells.
    const first = rows[0] ? elements(rows[0], 'tc') : [];
    grid = first.slice(0, LIMITS.columns).flatMap((tc) => {
      const props = element(tc, 'tcPr');
      const span = clamp(Number(attr(element(props, 'gridSpan'), 'val')) || 1, 1, LIMITS.columns);
      const width = attr(element(props, 'tcW'), 'type') === 'pct' ? 0 : twip(attr(element(props, 'tcW'), 'w'));
      return Array.from({ length: span }, () => width / span);
    });
  }
  grid = grid.slice(0, LIMITS.columns);
  const count = Math.max(grid.length, 1);
  if (!grid.some((w) => w > 0)) grid = Array.from({ length: count }, () => available / count);
  const zeroFilled = grid.reduce((sum, w) => sum + w, 0) / Math.max(1, grid.filter((w) => w > 0).length);
  grid = grid.map((w) => (w > 0 ? w : zeroFilled));
  const total = grid.reduce((sum, w) => sum + w, 0);
  let want = total;
  // Before Word 2013 a full-width table also took in its cell margins.
  if (table.width?.kind === 'pct') want = ((available + (compat < 15 ? (table.margin.left || 0) + (table.margin.right || 0) : 0)) * table.width.value) / 5000;
  else if (table.width?.kind === 'dxa' && table.width.value > 0) want = twip(table.width.value);
  // An auto-fitted table never runs off the page in Word; a fixed one may, and that is worth seeing.
  if (table.layout !== 'fixed' && want > available) want = available;
  if (table.width?.kind === 'auto' && total > available && table.layout !== 'fixed') want = available;
  const scale = total > 0 ? want / total : 1;
  return grid.map((w) => w * scale);
}

/**
 * A table as rows, each an item that can be painted, and split if it has to be.
 *
 * Merged cells are held to the row they begin in; a merge that a page break cuts
 * keeps its shading and side rules on both pages and its words on the first.
 */
function tableItems(tbl, ctx) {
  const { doc } = ctx;
  if ((ctx.depth || 0) > LIMITS.nesting) {
    doc.say('The document nests tables too deeply for all of them to be drawn.');
    return [];
  }
  const tblPr = element(tbl, 'tblPr');
  const direct = doc.readTbl(tblPr);
  const styleId = String(attr(element(tblPr, 'tblStyle'), 'val') || doc.defaultTable || '');
  const style = doc.style(styleId);
  const table = merged({ margin: { left: 5.4, right: 5.4, top: 0, bottom: 0 } }, style.tbl, direct);
  table.margin = merged({ left: 5.4, right: 5.4, top: 0, bottom: 0 }, style.tbl.margin, direct.margin);
  table.borders = merged(style.tbl.borders, direct.borders);

  const rowNodes = rowsOf(tbl);
  const widths = gridWidths(tbl, table, ctx.width, rowNodes, doc.compat);
  const totalW = widths.reduce((sum, w) => sum + w, 0);
  const offsets = [0];
  for (const w of widths) offsets.push(offsets[offsets.length - 1] + w);
  // Before Word 2013 a table hung out by its style's cell margin, so its words lined up with the page's.
  const outdent = doc.compat < 15 && table.align !== 'center' && table.align !== 'right' ? style.tbl.margin?.left ?? 0 : 0;
  const tableX = table.align === 'center' ? Math.max(0, (ctx.width - totalW) / 2) : table.align === 'right' || table.align === 'end' ? ctx.width - totalW : (table.indent || 0) - outdent;

  const look = direct.look || style.tbl.look;
  const rowCount = rowNodes.length;
  const cols = widths.length;
  /** Merged cells still open, by column they began at. */
  const open = new Map();
  const shared = { headers: [] };
  /** @type {any[]} */
  const rows = [];

  rowNodes.forEach((rowNode, rowIndex) => {
    doc.tools.budget.check();
    const trPr = element(rowNode, 'trPr');
    let col = Number(attr(element(trPr, 'gridBefore'), 'val')) || 0;
    const heightNode = element(trPr, 'trHeight');
    const minH = heightNode ? twip(attr(heightNode, 'val')) : 0;
    const exact = attr(heightNode, 'hRule') === 'exact';
    const cells = [];
    for (const tc of elementsOfRow(rowNode)) {
      const tcPr = element(tc, 'tcPr');
      const span = clamp(Number(attr(element(tcPr, 'gridSpan'), 'val')) || 1, 1, LIMITS.columns);
      const vMerge = element(tcPr, 'vMerge');
      const mergeState = vMerge ? (attr(vMerge, 'val') === 'restart' ? 'restart' : 'continue') : null;
      const conds = conditionsOf(look, style, rowIndex, col, rowCount, cols, table);
      const own = doc.readTc(tcPr);
      const tc0 = merged(style.tc, ...conds.map((c) => c.tc), own);
      const margin = merged(table.margin, ...conds.map((c) => c.tc?.margin), own.margin);
      const shade = tc0.shd || null;
      const x0 = offsets[Math.min(col, cols)] ?? 0;
      const x1 = offsets[Math.min(col + span, cols)] ?? x0;
      const w = Math.max(1, x1 - x0);
      const edges = merged(
        edgesFor(table.borders, rowIndex, col, span, rowCount, cols),
        ...[style.tc, ...conds.map((c) => c.tc)].map((level) => edgesFor(level?.borders, rowIndex, col, span, rowCount, cols)),
        own.borders,
      );
      const cell = { col, span, x: x0, w, margin, shade, edges, vAlign: tc0.vAlign || 'top', state: mergeState, items: [], height: 0, rowsDown: 1 };
      if (mergeState === 'continue') {
        const head = open.get(col);
        if (head) {
          head.rowsDown += 1;
          cell.head = head;
          cell.shade = head.shade;
          cell.edges = merged(head.edges, own.borders && { bottom: own.borders.bottom });
        }
      } else {
        const tableR = merged(style.r, ...conds.map((c) => c.r));
        const tableP = merged(style.p, ...conds.map((c) => c.p));
        const innerW = Math.max(4, w - (margin.left || 0) - (margin.right || 0));
        const autoColor = shade && lightness(shade) < 0.45 ? '#FFFFFF' : ctx.autoColor;
        cell.items = flow(elements(tc).filter((n) => localName(n.name) !== 'tcPr'), innerW, { ...ctx, width: innerW, tableR, tableP, autoColor, depth: (ctx.depth || 0) + 1, inCell: true });
        cell.height = cell.items.reduce((sum, item) => sum + (item.h || 0), 0);
        if (mergeState === 'restart') open.set(col, cell);
        else open.delete(col);
      }
      cells.push(cell);
      col += span;
    }
    let height = minH;
    for (const cell of cells) {
      if (cell.state) continue;
      height = Math.max(height, cell.height + (cell.margin.top || 0) + (cell.margin.bottom || 0));
    }
    if (exact) height = minH;
    if (!cells.length) height = Math.max(height, 1);
    rows.push({ cells, height, minH, exact, cantSplit: on(element(trPr, 'cantSplit')) === true, header: on(element(trPr, 'tblHeader')) === true });
  });

  // A merged cell's words have to fit in its rows: the last of them grows if they do not.
  rows.forEach((row, rowIndex) => {
    for (const cell of row.cells) {
      if (cell.state !== 'restart') continue;
      const down = Math.min(cell.rowsDown, rows.length - rowIndex);
      const have = rows.slice(rowIndex, rowIndex + down).reduce((sum, r) => sum + r.height, 0);
      const need = cell.height + (cell.margin.top || 0) + (cell.margin.bottom || 0);
      if (need > have) rows[rowIndex + down - 1].height += need - have;
    }
  });

  /** @type {any[]} */
  const items = [];
  rows.forEach((row, rowIndex) => {
    const item = makeRow(row, rowIndex, rows, tableX, shared);
    if (row.header && (rowIndex === 0 || rows[rowIndex - 1].header)) shared.headers.push(item);
    items.push(item);
  });
  return items;
}

function rowsOf(tbl) {
  const rows = [];
  for (const node of elements(tbl)) {
    const name = localName(node.name);
    if (name === 'tr') rows.push(node);
    else if (name === 'sdt') rows.push(...rowsOf(element(node, 'sdtContent') || node));
    else if (name === 'customXml' || name === 'ins') rows.push(...rowsOf(node));
  }
  return rows;
}

function elementsOfRow(row) {
  const cells = [];
  for (const node of elements(row)) {
    const name = localName(node.name);
    if (name === 'tc') cells.push(node);
    else if (name === 'sdt') cells.push(...elementsOfRow(element(node, 'sdtContent') || node));
    else if (name === 'customXml') cells.push(...elementsOfRow(node));
  }
  return cells;
}

/** Which of a level's borders fall on this cell's four sides. */
function edgesFor(borders, row, col, span, rows, cols) {
  if (!borders) return null;
  const out = {};
  const pick = (side, outer, inner, isOuter) => {
    const key = isOuter ? outer : inner;
    if (key in borders) out[side] = borders[key];
  };
  pick('top', 'top', 'insideH', row === 0);
  pick('bottom', 'bottom', 'insideH', row === rows - 1);
  pick('left', 'left', 'insideV', col === 0);
  pick('right', 'right', 'insideV', col + span >= cols);
  return out;
}

/** One row as a page item. `split` hands back what fits and what is left, when a page break cuts it. */
function makeRow(row, rowIndex, rows, tableX, shared, parts = null, start = true) {
  const contents = parts || row.cells.map((cell) => cell.items);
  const height = parts ? Math.max(row.minHeightLeft || 0, ...row.cells.map((cell, i) => contents[i].reduce((sum, item) => sum + (item.h || 0), 0) + (cell.margin.top || 0) + (cell.margin.bottom || 0))) : row.height;
  return {
    kind: 'row',
    h: height,
    cantSplit: row.cantSplit || row.exact,
    header: row.header,
    table: shared,
    paint(surface, x, y, geo) {
      surface.tableCells += row.cells.length;
      const clipped = row.exact;
      for (const cell of row.cells) {
        const cx = x + tableX + cell.x;
        if (cell.shade) surface.rect(cx, y, cell.w, height, `#${cell.shade}`);
      }
      row.cells.forEach((cell, index) => {
        const cx = x + tableX + cell.x;
        const items = contents[index];
        if (items.length) {
          const inner = items.reduce((sum, item) => sum + (item.h || 0), 0);
          let mergedH = height;
          if (cell.state === 'restart') mergedH = rows.slice(rowIndex, rowIndex + cell.rowsDown).reduce((sum, r) => sum + r.height, 0);
          const room = mergedH - (cell.margin.top || 0) - (cell.margin.bottom || 0);
          const slack = !parts && room > inner ? room - inner : 0;
          const offset = cell.vAlign === 'center' ? slack / 2 : cell.vAlign === 'bottom' ? slack : 0;
          let cy = y + (cell.margin.top || 0) + offset;
          if (clipped) {
            surface.save();
            surface.clipRect(cx, y, cell.w, height);
          }
          for (const item of items) {
            item.paint?.(surface, cx + (cell.margin.left || 0), cy, geo);
            cy += item.h || 0;
          }
          if (clipped) surface.restore();
        }
      });
      for (const cell of row.cells) {
        const cx = x + tableX + cell.x;
        const { edges } = cell;
        // Inside a merge only the outer rules are drawn.
        if (edges.top && (cell.state !== 'continue' || !start)) drawRule(surface, cx, y, cx + cell.w, y, edges.top);
        const closes = cell.state === 'restart' ? cell.rowsDown <= 1 : cell.state === 'continue' ? !rows[rowIndex + 1]?.cells.some((c) => c.col === cell.col && c.state === 'continue') : true;
        if (edges.bottom && closes) drawRule(surface, cx, y + height, cx + cell.w, y + height, edges.bottom);
        if (edges.left) drawRule(surface, cx, y, cx, y + height, edges.left);
        if (edges.right) drawRule(surface, cx + cell.w, y, cx + cell.w, y + height, edges.right);
      }
    },
    /** @param {number} room  how much height this page has left */
    split(room) {
      if (row.cantSplit || row.exact) return null;
      const first = [];
      const rest = [];
      let moved = false;
      row.cells.forEach((cell, index) => {
        const items = contents[index];
        let used = (cell.margin.top || 0) + (cell.margin.bottom || 0);
        let i = 0;
        while (i < items.length && used + (items[i].h || 0) <= room) {
          used += items[i].h || 0;
          i += 1;
        }
        first.push(items.slice(0, i));
        rest.push(items.slice(i));
        if (i > 0) moved = true;
      });
      if (!moved || rest.every((list) => !list.length)) return null;
      const copy = { ...row, minHeightLeft: 0 };
      return [makeRow(copy, rowIndex, rows, tableX, shared, first, start), makeRow(copy, rowIndex, rows, tableX, shared, rest, false)];
    },
  };
}

/* ── blocks ─────────────────────────────────────────────────────────── */

/** Unwrap what only groups blocks: a content control, tracked insertion, custom XML. */
function blocksOf(nodes) {
  const out = [];
  for (const node of nodes) {
    const name = localName(node.name);
    if (name === 'p' || name === 'tbl') out.push(node);
    else if (name === 'sdt') out.push(...blocksOf(elements(element(node, 'sdtContent'))));
    else if (name === 'customXml' || name === 'ins' || name === 'moveTo') out.push(...blocksOf(elements(node)));
    else if (name === 'AlternateContent') out.push(...blocksOf(elements(element(node, 'Choice') || element(node, 'Fallback'))));
  }
  return out;
}

/**
 * Blocks as items, in a place with no page of its own: a cell, a text box, a header.
 * A float in here cannot push words around, so it paints with its line.
 */
function flow(nodes, width, ctx) {
  const blocks = blocksOf(nodes);
  /** @type {any[]} */
  const items = [];
  blocks.forEach((node, i) => {
    if (localName(node.name) === 'tbl') items.push(...tableItems(node, { ...ctx, width }));
    else items.push(...paragraphItems(node, { ...ctx, width }, { prev: blocks[i - 1], next: blocks[i + 1] }));
  });
  for (const item of items) {
    if (!item.anchors?.length) continue;
    const paint = item.paint;
    const anchors = item.anchors;
    item.paint = function paintWithFloats(surface, x, y, geo) {
      for (const anchor of anchors) paintAnchor(surface, anchor, x, y, width, this.h, geo, ctx);
      paint.call(item, surface, x, y, geo);
    };
  }
  return items.filter((item) => item.kind !== 'break');
}

/** Draw a floating drawing, under the page's words if it asked to be behind them. */
function paintAnchor(surface, anchor, x, y, width, lineH, geo, ctx) {
  if (!geo?.w) return;
  const box = placeAnchor(anchor, { x, y, w: width, h: lineH }, geo);
  const wrap = wrapOf(anchor);
  const mark = surface.ops.length;
  paintGraphic(surface, anchor, { ...box, rot: 0 }, drawEnv({ ...ctx, geo }), { ...ctx, geo });
  if (wrap.behind && geo.under) geo.under.push(...surface.ops.splice(mark));
}

/* ── sections and pages ─────────────────────────────────────────────── */

function readSection(sectPr, previous) {
  const size = element(sectPr, 'pgSz');
  const margin = element(sectPr, 'pgMar');
  const w = clamp(twip(attr(size, 'w')) || 612, 72, 4032);
  const h = clamp(twip(attr(size, 'h')) || 792, 72, 4032);
  const get = (name, fallback) => (attr(margin, name) === undefined ? fallback : twip(attr(margin, name)));
  const top = get('top', 72);
  const bottom = get('bottom', 72);
  const left = clamp(get('left', 72), 0, w / 2);
  const right = clamp(get('right', 72), 0, w / 2);
  const headers = { ...(previous?.headers || {}) };
  const footers = { ...(previous?.footers || {}) };
  for (const ref of elements(sectPr, 'headerReference')) headers[String(attr(ref, 'type') || 'default')] = relationshipId(ref);
  for (const ref of elements(sectPr, 'footerReference')) footers[String(attr(ref, 'type') || 'default')] = relationshipId(ref);
  const textW = Math.max(24, w - left - right);
  const colsNode = element(sectPr, 'cols');
  const count = clamp(Number(attr(colsNode, 'num')) || 1, 1, 12);
  const space = attr(colsNode, 'space') === undefined ? 36 : twip(attr(colsNode, 'space'));
  const listed = elements(colsNode, 'col');
  /** @type {{ x: number, w: number }[]} */
  const columns = [];
  if (listed.length && attr(colsNode, 'equalWidth') !== '1') {
    let x = 0;
    for (const col of listed) {
      const colW = twip(attr(col, 'w')) || textW / listed.length;
      columns.push({ x, w: colW });
      x += colW + twip(attr(col, 'space'));
    }
  } else {
    const colW = Math.max(12, (textW - space * (count - 1)) / count);
    for (let i = 0; i < count; i += 1) columns.push({ x: i * (colW + space), w: colW });
  }
  const start = attr(element(sectPr, 'pgNumType'), 'start');
  const fmt = attr(element(sectPr, 'pgNumType'), 'fmt');
  return {
    w, h, top, bottom, left, right,
    headerDist: get('header', 36),
    footerDist: get('footer', 36),
    gutter: get('gutter', 0),
    columns,
    type: String(attr(element(sectPr, 'type'), 'val') || 'nextPage'),
    headers,
    footers,
    titlePg: on(element(sectPr, 'titlePg')) === true,
    pageStart: start === undefined ? null : Number(start),
    pageFormat: fmt ? String(fmt) : previous?.pageFormat || 'decimal',
    pageBorders: element(sectPr, 'pgBorders'),
  };
}

/** The blocks of each section, in order, each with its properties. */
function sectionsOf(body) {
  const out = [];
  let blocks = [];
  for (const node of blocksOf(elements(body))) {
    blocks.push(node);
    if (localName(node.name) !== 'p') continue;
    const inner = element(element(node, 'pPr'), 'sectPr');
    if (inner) {
      out.push({ blocks, sectPr: inner });
      blocks = [];
    }
  }
  out.push({ blocks, sectPr: element(body, 'sectPr') });
  return out;
}

/** Roughly how tall a block will be, for keeping a heading with what follows. */
function estimate(node, doc, width) {
  if (localName(node.name) === 'tbl') return 28;
  const direct = doc.readP(element(node, 'pPr'));
  const style = doc.style(direct.pStyle || doc.defaultParagraph);
  const props = merged(doc.baseP, style.p, direct);
  const r = merged(doc.baseR, style.r);
  const size = r.size || 10;
  const chars = textOf(node).length;
  const perLine = Math.max(8, width / (size * 0.5));
  const lines = Math.min(2, Math.max(1, Math.ceil(chars / perLine)));
  return (props.before || 0) + lines * size * 1.2 * ((props.line || 240) / 240);
}

/**
 * Every page of a document, laid out.
 *
 * @param {any} zip
 * @param {any} tools  fonts, measure, budget, note
 */
export function layoutDocx(zip, tools) {
  const doc = new Doc(zip, tools);
  const body = element(doc.root, 'body');
  if (!body) throw refused('That .docx has no body, so it may be corrupt.');

  const baseCtx = { doc, part: doc.main, rels: doc.rels, width: 0, depth: 0, autoColor: null, tableR: null, tableP: null };
  /** @type {any[]} */
  const pages = [];
  let page = null;
  let previous = null;
  let stopped = false;
  const background = doc.background ? doc.color(element(doc.root, 'background'), 'color', 'themeColor', 'themeTint', 'themeShade') : null;

  /** A header or footer part, as blocks in that part's own context. */
  const partBlocks = (relId) => {
    if (!relId) return null;
    const rel = doc.rels.get(String(relId));
    if (!rel) return null;
    const part = resolveTarget(doc.main, rel.target);
    if (!zip.has(part)) return null;
    return { part, rels: readRelationships(zip, relsPathFor(part)), blocks: elements(parseXml(zip.text(part))) };
  };

  /** Which header or footer this page shows. A first page with none of its own shows nothing. */
  const pickPart = (sect, kind, number, firstOfSection) => {
    const refs = kind === 'header' ? sect.headers : sect.footers;
    if (sect.titlePg && firstOfSection) return refs.first ?? null;
    if (doc.evenOdd && number % 2 === 0) return refs.even ?? null;
    return refs.default ?? null;
  };

  const measured = new Map();
  /** How tall a header or footer is, before the pages are numbered. */
  const heightOf = (sect, relId) => {
    if (!relId) return 0;
    const key = `${relId}|${sect.w - sect.left - sect.right}`;
    if (measured.has(key)) return measured.get(key);
    measured.set(key, 0);
    const held = partBlocks(relId);
    let height = 0;
    if (held) {
      // Measuring must not count lists or fields twice.
      const counters = doc.counters;
      doc.counters = new Map();
      const width = Math.max(24, sect.w - sect.left - sect.right);
      const items = flow(held.blocks, width, { ...baseCtx, part: held.part, rels: held.rels, width });
      height = items.reduce((sum, item) => sum + (item.h || 0), 0);
      doc.counters = counters;
    }
    measured.set(key, height);
    return height;
  };

  const newPage = (sect, { soft = false, firstOfSection = false } = {}) => {
    if (pages.length >= LIMITS.pages) {
      if (!stopped) tools.note(`The document runs past ${LIMITS.pages} pages; only the first ${LIMITS.pages} were laid out.`);
      stopped = true;
      return false;
    }
    const number = pages.length + 1;
    const surface = new Surface(sect.w, sect.h);
    surface.number = number;
    const headerId = pickPart(sect, 'header', number, firstOfSection);
    const footerId = pickPart(sect, 'footer', number, firstOfSection);
    const headerH = heightOf(sect, headerId);
    const footerH = heightOf(sect, footerId);
    const top = sect.top < 0 ? -sect.top : Math.max(sect.top, sect.headerDist + headerH);
    const bottom = sect.h - (sect.bottom < 0 ? -sect.bottom : Math.max(sect.bottom, sect.footerDist + footerH));
    const left = sect.left + sect.gutter;
    page = {
      surface, sect, number, headerId, footerId, firstOfSection,
      top, y: top, limit: Math.max(top + 12, bottom), bottom: Math.max(top + 12, bottom), col: 0, left,
      columnTop: top, soft, foots: [], footH: 0, floats: [], under: [], empty: true,
      geo: { w: sect.w, h: sect.h, left, right: sect.right, top, bottom: sect.h - bottom, under: [] },
    };
    page.under = page.geo.under;
    pages.push(page);
    return true;
  };

  const frameX = () => page.left + page.sect.columns[page.col].x;
  const frameW = () => page.sect.columns[page.col].w;

  /** The next column, or the next page. */
  const advance = (soft) => {
    if (page.col + 1 < page.sect.columns.length) {
      page.col += 1;
      page.y = page.columnTop;
      page.floats = [];
      return true;
    }
    return newPage(page.sect, { soft });
  };

  /** A footnote as items, once, at the width of this column. */
  const noteItems = (id) => {
    const note = doc.footnotes.get(String(id));
    if (!note) return [];
    const width = frameW();
    return flow(note.blocks, width, { ...baseCtx, part: note.part, rels: note.rels, width, footNumber: doc.footNumbers.get(String(id)) });
  };

  const placeItem = (item) => {
    tools.budget.check();
    if (stopped) return;
    if (item.kind === 'break') {
      if (item.type === 'column') advance(false);
      else newPage(page.sect);
      return;
    }
    if (item.kind === 'space') {
      // A paragraph's space before does not carry to the top of a page, except a section's first.
      if (page.empty && !page.firstOfSection && page.y === page.columnTop) return;
      if (page.y + item.h > page.limit) {
        advance(true);
        return;
      }
      page.y += item.h;
      page.spaced = true;
      return;
    }
    if (item.kind === 'line') {
      const { para } = item;
      if (para.placed === 0 && para.lines > 0) settleParagraph(para, item);
      if (para.breakAfter !== null && para.placed === para.breakAfter) {
        para.breakAfter = null;
        advance(true);
      }
      para.placed += 1;
    }
    let need = item.h;
    const notes = [];
    if (item.foots?.length) {
      for (const id of item.foots) notes.push(...noteItems(id));
      const noteH = notes.reduce((sum, n) => sum + (n.h || 0), 0) + (page.footH ? 0 : 10);
      need += noteH;
    }
    if (page.y + need > page.limit - page.footH && !page.empty) {
      if (item.kind === 'row') {
        const pieces = item.split?.(page.limit - page.footH - page.y);
        if (pieces) {
          placeItem(pieces[0]);
          advance(true);
          placeRepeats(pieces[1]);
          placeItem(pieces[1]);
          return;
        }
      }
      advance(true);
      if (item.kind === 'row') placeRepeats(item);
    }
    if (stopped) return;
    if (notes.length) {
      page.foots.push(...notes);
      page.footH += notes.reduce((sum, n) => sum + (n.h || 0), 0) + (page.foots.length === notes.length ? 10 : 0);
    }
    item.paint?.(page.surface, frameX(), page.y, page.geo);
    page.y += item.h;
    page.empty = false;
  };

  /** A new page of a table starts with its header rows. */
  const placeRepeats = (item) => {
    if (item.kind !== 'row' || item.header) return;
    for (const header of item.table?.headers || []) {
      if (stopped) return;
      header.paint(page.surface, frameX(), page.y, page.geo);
      page.y += header.h;
    }
  };

  /** Decide where a paragraph breaks, before its first line goes down. */
  const settleParagraph = (para, firstItem) => {
    const items = firstItem.siblings;
    if (!items) return;
    const room = page.limit - page.footH - page.y;
    let used = 0;
    let fits = 0;
    for (const line of items) {
      if (used + line.h > room) break;
      used += line.h;
      fits += 1;
    }
    if (fits >= items.length) return;
    if (page.empty) {
      if (fits > 0) para.breakAfter = fits;
      return;
    }
    if (para.keepLines || fits === 0) {
      advance(true);
      return;
    }
    if (para.widow) {
      if (fits === 1) {
        advance(true);
        return;
      }
      if (items.length - fits === 1) {
        fits -= 1;
        if (fits < 2) {
          advance(true);
          return;
        }
      }
    }
    para.breakAfter = fits;
  };

  /** Float a paragraph's drawings: painted now, and remembered if words have to go around them. */
  const placeFloats = (anchors, ctx) => {
    for (const anchor of anchors) {
      const wrap = wrapOf(anchor);
      const box = placeAnchor(anchor, { x: frameX(), y: page.y, w: frameW(), h: 14 }, page.geo);
      const mark = page.surface.ops.length;
      paintGraphic(page.surface, anchor, { ...box, rot: 0 }, drawEnv({ ...ctx, geo: page.geo }), { ...ctx, geo: page.geo });
      if (wrap.behind) page.under.push(...page.surface.ops.splice(mark));
      if (wrap.kind === 'side') page.floats.push({ x0: box.x - wrap.l, x1: box.x + box.w + wrap.r, y0: box.y - wrap.t, y1: box.y + box.h + wrap.b });
      if (wrap.kind === 'block') page.floats.push({ x0: 0, x1: page.geo.w, y0: box.y - wrap.t, y1: box.y + box.h + wrap.b, block: true });
    }
  };

  /** A paragraph's anchored drawings, found before it is set so the words can make room. */
  const anchorsIn = (p) => {
    const out = [];
    const walk = (node, depth) => {
      if (depth > 8) return;
      for (const child of elements(node)) {
        const name = localName(child.name);
        if (name === 'anchor') out.push(child);
        else if (name === 'r' || name === 'hyperlink' || name === 'drawing' || name === 'ins' || name === 'AlternateContent' || name === 'Choice' || name === 'sdt' || name === 'sdtContent' || name === 'smartTag') walk(child, depth + 1);
      }
    };
    walk(p, 0);
    return out;
  };

  const sections = sectionsOf(body);
  sections.forEach((section, sectionIndex) => {
    const sect = readSection(section.sectPr, previous);
    previous = sect;
    if (!page) newPage(sect, { firstOfSection: true });
    else if (sect.type === 'continuous' && page.sect.w === sect.w && page.sect.h === sect.h) {
      page.sect = sect;
      page.col = 0;
      page.columnTop = page.y;
    } else if (sect.type === 'nextColumn' && page.col + 1 < page.sect.columns.length) {
      advance(false);
    } else {
      if (!newPage(sect, { firstOfSection: true })) return;
      // An odd or even section start can leave a blank page behind, as it does in print.
      if ((sect.type === 'oddPage' && page.number % 2 === 0) || (sect.type === 'evenPage' && page.number % 2 === 1)) newPage(sect, { firstOfSection: true });
    }
    // Continuous columns are balanced by Word: fill each to its share of the height.
    if (sect.type === 'continuous' && sect.columns.length > 1 && sections[sectionIndex + 1]) {
      doc.say('Columns that Word balances were filled top to bottom here, so where they break may differ.');
    }

    const { blocks } = section;
    for (let i = 0; i < blocks.length && !stopped; i += 1) {
      tools.budget.check();
      const node = blocks[i];
      const ctx = { ...baseCtx, width: frameW(), frameX: frameX() };
      if (localName(node.name) === 'tbl') {
        for (const item of tableItems(node, ctx)) placeItem(item);
        continue;
      }
      const pPr = element(node, 'pPr');
      const own = doc.readP(pPr);
      const style = doc.style(own.pStyle || doc.defaultParagraph);
      if ((own.pageBreak ?? style.p.pageBreak) === true && !page.empty) {
        newPage(page.sect);
        if (stopped) break;
      }
      const anchors = anchorsIn(node);
      if (anchors.length) placeFloats(anchors, ctx);
      const items = paragraphItems(node, { ...ctx, width: frameW(), frameX: frameX() }, { prev: blocks[i - 1], next: blocks[i + 1], floats: page.floats, at: page.y });
      const lines = items.filter((item) => item.kind === 'line');
      if (lines[0]) lines[0].siblings = lines;
      // Block-wrapped drawings stand in the way like a paragraph of their own.
      for (const float of page.floats) {
        if (float.block && float.y0 <= page.y + 2 && float.y1 > page.y) page.y = float.y1;
      }
      // Kept with what follows: the whole chain has to fit, or it starts a new page together.
      if (lines[0]?.para.keepNext && !page.empty) {
        let need = items.reduce((sum, item) => sum + (item.h || 0), 0);
        for (let j = i + 1; j < blocks.length && j <= i + 6; j += 1) {
          const other = blocks[j];
          need += estimate(other, doc, frameW());
          const otherP = localName(other.name) === 'p' ? doc.readP(element(other, 'pPr')) : null;
          const keeps = otherP ? (otherP.keepNext ?? doc.style(otherP.pStyle || doc.defaultParagraph).p.keepNext) : false;
          if (!keeps) break;
        }
        if (page.y + need > page.limit - page.footH && need < page.limit - page.columnTop) advance(true);
      }
      for (const item of items) placeItem(item);
    }
  });

  /* Now the count is known: headers, footers and footnotes, and the page's own ground. */
  const total = pages.length;
  let display = 0;
  let lastSect = null;
  for (const held of pages) {
    tools.budget.check();
    const { surface, sect } = held;
    if (sect !== lastSect) {
      if (sect.pageStart != null) display = sect.pageStart - 1;
      lastSect = sect;
    }
    display += 1;
    doc.field = { page: held.number, pages: total, display: formatNumber(display, sect.pageFormat) };
    const body0 = surface.ops;
    surface.ops = [];
    surface.quiet += 1;
    if (background) {
      surface.background = `#${background}`;
      surface.rect(0, 0, sect.w, sect.h, `#${background}`);
    }
    const width = Math.max(24, sect.w - sect.left - sect.right);
    const drawPart = (relId, place) => {
      const part = partBlocks(relId);
      if (!part) return;
      const ctx = { ...baseCtx, part: part.part, rels: part.rels, width, geo: held.geo };
      const items = flow(part.blocks, width, ctx);
      const height = items.reduce((sum, item) => sum + (item.h || 0), 0);
      let y = place(height);
      for (const item of items) {
        item.paint?.(surface, held.left, y, held.geo);
        y += item.h || 0;
      }
    };
    drawPart(held.headerId, () => sect.headerDist);
    drawPart(held.footerId, (height) => sect.h - sect.footerDist - height);
    paintPageBorders(surface, sect, doc);
    surface.quiet -= 1;
    const pageGround = surface.ops;
    surface.ops = [...pageGround, ...held.under, ...body0];

    if (held.foots.length) {
      surface.quiet += 1;
      let y = held.limit - held.footH + 6;
      surface.line(held.left, y - 3, held.left + 144, y - 3, '#000000', 0.5);
      for (const item of held.foots) {
        item.paint?.(surface, held.left, y, held.geo);
        y += item.h || 0;
      }
      surface.quiet -= 1;
    }
    if (surface.overflowed) tools.note(`Page ${held.number} has more on it than is drawn here, so some of it is missing.`);
  }

  return { unit: 'page', total, pages: pages.map((held) => held.surface), kerning: 'none' };
}

/** A border around the page, if the section has one. */
function paintPageBorders(surface, sect, doc) {
  const node = sect.pageBorders;
  if (!node) return;
  const fromText = attr(node, 'offsetFrom') === 'text';
  const edge = (side) => doc.border(element(node, side));
  const top = edge('top');
  const left = edge('left');
  const bottom = edge('bottom');
  const right = edge('right');
  const inset = (side, e) => {
    if (!e) return 0;
    if (fromText) return side - e.space;
    return e.space;
  };
  const x0 = inset(sect.left, left);
  const y0 = inset(sect.top, top);
  const x1 = sect.w - inset(sect.right, right);
  const y1 = sect.h - inset(sect.bottom, bottom);
  if (top) drawRule(surface, x0, y0, x1, y0, top);
  if (bottom) drawRule(surface, x0, y1, x1, y1, bottom);
  if (left) drawRule(surface, x0, y0, x0, y1, left);
  if (right) drawRule(surface, x1, y0, x1, y1, right);
}
