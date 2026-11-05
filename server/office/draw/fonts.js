/**
 * The fonts a file is drawn with: only ever ones this repository ships.
 *
 * A deployment has no system fonts, and a canvas asked for "Calibri" there draws
 * nothing useful, so nothing here asks for a font by the name a file gives. Every
 * face is registered under an alias of ours, which also keeps this PC honest: the
 * real Calibri installed here can never answer for it, and what is drawn on a
 * laptop is what is drawn in production.
 *
 * The stand-ins were chosen by measurement (2026-11-04, against the real fonts on
 * a Windows machine with Office). Three have the same advance widths as the font
 * they stand in for, so a line breaks where Word breaks it:
 *
 *   Carlito  for Calibri (1.000)      Tinos    for Times New Roman (1.000)
 *   Cousine  for Courier New (1.000)  Liberation Sans for Arial (1.000)
 *
 * Everything else is scaled to the width it measured, so a page holds about the
 * same words per line, and the notes say so.
 *
 * Liberation Sans is the one pdfjs ships, and vercel.json already bundles it. It is
 * a subset with none of Vietnamese's stacked vowels (ệ ữ ổ ậ, 93 letters in all), so
 * Arimo, the same design with them, stands beside it. Carlito, Tinos, Cousine and
 * Arimo are unmodified OFL fonts in server/assets/fonts with their licences; each
 * family is only read from disk when a file actually uses it.
 *
 * A glyph that is not in the chosen face draws as an empty box: Skia does not fall
 * back across registered families by itself. So coverage is read from each font's
 * own cmap table, and a word goes to the first face that holds all of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));

/** Where pdfjs keeps its standard fonts. The same lookup as `standardFonts()` in pdf.js. */
function pdfjsFonts() {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');
  } catch {
    return null;
  }
}

/**
 * @type {Record<string, { alias: string, label: string, dir: 'assets'|'pdfjs',
 *   regular: string, bold?: string, italic?: string, boldItalic?: string, fallback: string[] }>}
 */
const FACES = {
  carlito: {
    alias: 'Look Carlito', label: 'Carlito', dir: 'assets',
    regular: 'Carlito-Regular.ttf', bold: 'Carlito-Bold.ttf', italic: 'Carlito-Italic.ttf', boldItalic: 'Carlito-BoldItalic.ttf',
    fallback: ['liberation', 'arimo'],
  },
  liberation: {
    alias: 'Look Liberation', label: 'Liberation Sans', dir: 'pdfjs',
    regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italic: 'LiberationSans-Italic.ttf', boldItalic: 'LiberationSans-BoldItalic.ttf',
    fallback: ['arimo', 'carlito'],
  },
  tinos: {
    alias: 'Look Tinos', label: 'Tinos', dir: 'assets',
    regular: 'Tinos-Regular.ttf', bold: 'Tinos-Bold.ttf', italic: 'Tinos-Italic.ttf', boldItalic: 'Tinos-BoldItalic.ttf',
    fallback: ['arimo', 'carlito'],
  },
  cousine: {
    alias: 'Look Cousine', label: 'Cousine', dir: 'assets',
    regular: 'Cousine-Regular.ttf', bold: 'Cousine-Bold.ttf',
    fallback: ['arimo', 'liberation', 'carlito'],
  },
  // Its weight axis is not reachable through the canvas, so bold here is synthetic
  // and keeps regular widths. It only ever draws the words Liberation Sans cannot.
  arimo: {
    alias: 'Look Arimo', label: 'Arimo', dir: 'assets',
    regular: 'Arimo-VariableWeight.ttf',
    fallback: ['liberation', 'carlito'],
  },
};

/**
 * What a font name means here: `[face, width scale, ascent, descent, line gap]`.
 *
 * Scale is the real font's width over the stand-in's, measured on one sample. The
 * vertical numbers are the real font's own, because pagination depends on them and
 * the stand-in's are not what Word used. Fonts not on the measuring machine are
 * marked `~` in spirit: their numbers come from their published metrics.
 *
 * @type {Record<string, [string, number, number, number, number]>}
 */
const KNOWN = {
  calibri: ['carlito', 1, 0.952, 0.269, 0],
  'calibri light': ['carlito', 1, 0.952, 0.269, 0],
  arial: ['liberation', 1, 0.905, 0.212, 0.033],
  helvetica: ['liberation', 1, 0.905, 0.212, 0.033],
  'helvetica neue': ['liberation', 1, 0.905, 0.212, 0.033],
  'arial narrow': ['liberation', 0.82, 0.905, 0.212, 0.033],
  'arial black': ['liberation', 1.15, 1.1, 0.31, 0],
  'times new roman': ['tinos', 1, 0.891, 0.216, 0.042],
  times: ['tinos', 1, 0.891, 0.216, 0.042],
  'courier new': ['cousine', 1, 0.833, 0.3, 0],
  courier: ['cousine', 1, 0.833, 0.3, 0],
  cambria: ['tinos', 1.047, 0.95, 0.222, 0],
  'cambria math': ['tinos', 1.047, 0.95, 0.222, 0],
  'segoe ui': ['carlito', 1.088, 1.079, 0.251, 0],
  'segoe ui light': ['carlito', 1.06, 1.079, 0.251, 0],
  'segoe ui semibold': ['carlito', 1.1, 1.079, 0.251, 0],
  tahoma: ['liberation', 1.007, 1, 0.207, 0],
  verdana: ['liberation', 1.147, 1.005, 0.21, 0],
  'microsoft sans serif': ['liberation', 1, 0.922, 0.212, 0],
  'trebuchet ms': ['liberation', 1.012, 0.939, 0.222, 0],
  'century gothic': ['liberation', 1.087, 0.971, 0.22, 0],
  georgia: ['tinos', 1.094, 0.917, 0.219, 0],
  consolas: ['cousine', 0.916, 0.92, 0.251, 0],
  'lucida console': ['cousine', 1.004, 0.789, 0.211, 0],
  garamond: ['tinos', 0.974, 0.862, 0.263, 0],
  'book antiqua': ['tinos', 1.099, 0.96, 0.282, 0],
  'palatino linotype': ['tinos', 1.095, 1.05, 0.299, 0],
  constantia: ['tinos', 1.066, 0.952, 0.269, 0],
  century: ['tinos', 1.148, 0.984, 0.215, 0],
  rockwell: ['tinos', 1.136, 0.91, 0.21, 0],
  'bookman old style': ['tinos', 1.216, 0.97, 0.28, 0],
  candara: ['carlito', 1.033, 0.952, 0.269, 0],
  corbel: ['carlito', 1.01, 0.952, 0.269, 0],
  'gill sans mt': ['carlito', 1.022, 0.918, 0.23, 0],
  'tw cen mt': ['carlito', 1.005, 0.85, 0.24, 0],
  bahnschrift: ['carlito', 1.084, 0.994, 0.206, 0],
  'franklin gothic book': ['liberation', 0.956, 0.917, 0.217, 0],
  'franklin gothic medium': ['liberation', 0.971, 0.917, 0.217, 0],
  'lucida sans': ['liberation', 1.111, 0.966, 0.214, 0],
  impact: ['liberation', 0.892, 1.009, 0.21, 0],
  'comic sans ms': ['liberation', 1.04, 1.102, 0.291, 0],
  aptos: ['carlito', 1.07, 0.939, 0.282, 0],
  'aptos display': ['carlito', 1.05, 0.939, 0.282, 0],
  'aptos narrow': ['carlito', 0.96, 0.939, 0.282, 0],
  roboto: ['liberation', 0.98, 0.927, 0.244, 0],
  'open sans': ['liberation', 1.03, 1.069, 0.293, 0],
  'noto sans': ['liberation', 1.03, 1.069, 0.293, 0],
  lato: ['carlito', 1.03, 0.987, 0.213, 0],
  'source sans pro': ['carlito', 1, 0.984, 0.273, 0],
  montserrat: ['liberation', 1.12, 0.968, 0.251, 0],
  inter: ['liberation', 1.02, 0.969, 0.242, 0],
  'noto serif': ['tinos', 1.1, 1.069, 0.293, 0],
  'yu gothic': ['carlito', 1.143, 0.88, 0.12, 0.3],
  'ms gothic': ['carlito', 1.181, 0.859, 0.141, 0],
  simsun: ['carlito', 1.2, 0.859, 0.141, 0.16],
  'microsoft yahei': ['carlito', 1.186, 1.06, 0.26, 0],
  'malgun gothic': ['carlito', 1.149, 1.088, 0.243, 0],
};

/** These four share advance widths with the font they stand in for, so nothing moves. */
const SAME_WIDTHS = new Set(['calibri', 'arial', 'helvetica', 'times new roman', 'times', 'courier new', 'courier']);

/**
 * A font nobody listed: its name usually says what kind it is. Arial's widths are
 * the safer guess for an unknown sans, since most are at least that wide.
 */
function guess(lower) {
  if (/mono|code|courier|console|typewriter/.test(lower)) return /** @type {[string, number, number, number, number]} */ (['cousine', 1, 0.833, 0.3, 0]);
  if (/sans/.test(lower)) return /** @type {[string, number, number, number, number]} */ (['liberation', 1, 0.905, 0.212, 0.033]);
  if (/serif|roman|times|garamond|minion|book|baskerville|didot|bodoni|caslon|palatino/.test(lower)) return /** @type {[string, number, number, number, number]} */ (['tinos', 1, 0.891, 0.216, 0.042]);
  return /** @type {[string, number, number, number, number]} */ (['liberation', 1, 0.905, 0.212, 0.033]);
}

/**
 * Bullets written in a symbol font: the file holds a private code and the font
 * draws a picture for it. None of those fonts exists here, so each picture people
 * actually use as a bullet is named by the Unicode shape closest to it.
 */
const WINGDINGS = new Map([
  [0x6c, '●'], [0x6d, '○'], [0x6e, '■'], [0x6f, '□'], [0x70, '□'], [0x71, '□'], [0x72, '□'], [0x73, '♦'], [0x74, '♦'], [0x75, '♦'], [0x76, '♦'],
  [0x77, '♦'], [0x9e, '·'], [0x9f, '•'], [0xa0, '▪'], [0xa1, '○'], [0xa7, '▪'], [0xa8, '□'], [0xab, '★'], [0xd8, '►'], [0xd9, '►'], [0xe0, '→'],
  [0xe8, '→'], [0xf0, '→'], [0xfb, '×'], [0xfc, '√'], [0xfd, '×'], [0xfe, '√'],
]);
const SYMBOL = new Map([[0xb7, '•'], [0xa7, '♣'], [0xa9, '♥'], [0xaa, '♠'], [0xa8, '♦'], [0xae, '→'], [0xd6, '√'], [0xb0, '°'], [0xb4, '×']]);

/** A character from a symbol font, as something a text font can draw. */
export function symbolChar(fontName, text) {
  const lower = String(fontName || '').toLowerCase();
  const code = String(text || '').codePointAt(0) ?? 0;
  const low = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  if (/wingdings|webdings/.test(lower)) return WINGDINGS.get(low) || '•';
  if (/symbol/.test(lower)) return SYMBOL.get(low) || (low >= 0x20 && low < 0x7f ? String.fromCharCode(low) : '•');
  return null;
}

/* ── the cmap, so coverage is known rather than hoped for ───────────── */

/**
 * Which characters a TrueType font holds, from its `cmap` table: formats 4 and 12,
 * which is what every font here has. Immutable facts about files in this
 * repository, so caching them for the life of the process holds nobody's data.
 *
 * @param {Buffer} b
 * @returns {Set<number>}
 */
export function readCmap(b) {
  const out = new Set();
  const tables = b.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < tables; i += 1) {
    const at = 12 + i * 16;
    if (b.toString('latin1', at, at + 4) === 'cmap') cmap = b.readUInt32BE(at + 8);
  }
  if (cmap < 0) return out;
  const count = b.readUInt16BE(cmap + 2);
  for (let i = 0; i < count; i += 1) {
    const sub = cmap + b.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = b.readUInt16BE(sub);
    if (format === 4) {
      const segments = b.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s += 1) {
        const end = b.readUInt16BE(ends + s * 2);
        const start = b.readUInt16BE(starts + s * 2);
        const delta = b.readUInt16BE(deltas + s * 2);
        const range = b.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          const glyph = range === 0 ? (c + delta) & 0xffff : b.readUInt16BE(ranges + s * 2 + range + (c - start) * 2);
          if (glyph) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = b.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g += 1) {
        const start = b.readUInt32BE(sub + 16 + g * 12);
        const end = b.readUInt32BE(sub + 20 + g * 12);
        for (let c = start; c <= end && c - start < 70000; c += 1) out.add(c);
      }
    }
  }
  return out;
}

/** Each face's cmap, once per process. */
const coverage = new Map();

/** @param {string} key one of FACES */
function fileOf(key, file) {
  const dir = FACES[key].dir === 'assets' ? ASSETS : pdfjsFonts();
  return dir ? path.join(dir, file) : null;
}

/** @param {any} canvasApi @param {string} key */
function register(canvasApi, key) {
  const face = FACES[key];
  if (coverage.has(key)) {
    // The registry is per process but a worker can come first; `has` covers both.
    if (canvasApi.GlobalFonts.has(face.alias)) return true;
  }
  let cover = coverage.get(key);
  for (const file of [face.regular, face.bold, face.italic, face.boldItalic]) {
    if (!file) continue;
    const where = fileOf(key, file);
    if (!where) return false;
    let bytes;
    try {
      bytes = fs.readFileSync(where);
    } catch {
      return false;
    }
    if (!canvasApi.GlobalFonts.has(face.alias) || file !== face.regular) canvasApi.GlobalFonts.register(bytes, face.alias);
    if (!cover) {
      cover = readCmap(bytes);
      coverage.set(key, cover);
    }
  }
  return !!cover;
}

/**
 * One font as this look draws it.
 *
 * @typedef {{ name: string, face: string, alias: string, scale: number, asc: number, desc: number, gap: number,
 *   bold: boolean, italic: boolean, prefix: string, cover: Set<number> }} Pick
 */

const isAscii = (text) => {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7e) return false;
  return true;
};

/**
 * The fonts of one look. Holds which substitutions happened and which characters
 * could not be drawn, so it belongs to one call and is never shared.
 */
export class Fonts {
  /** @param {any} canvasApi */
  constructor(canvasApi) {
    this.api = canvasApi;
    /** @type {Map<string, Pick>} */
    this.picks = new Map();
    this.ready = new Set();
    /** Requested font name → the face drawn instead, for the notes. */
    this.replaced = new Map();
    this.missing = new Set();
    this.legacy = new Set();
  }

  /** @param {string} key */
  load(key) {
    if (this.ready.has(key)) return true;
    const ok = register(this.api, key);
    if (ok) this.ready.add(key);
    return ok;
  }

  /** Whether drawing can happen at all: the two faces everything falls back on. */
  usable() {
    return this.load('carlito') && this.load('liberation');
  }

  /**
   * @param {string} [name]  what the file asked for
   * @param {boolean} [bold]
   * @param {boolean} [italic]
   * @returns {Pick}
   */
  pick(name, bold = false, italic = false) {
    const asked = String(name || 'Calibri').trim();
    const key = `${asked}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    const cached = this.picks.get(key);
    if (cached) return cached;
    const lower = asked.toLowerCase();
    const known = KNOWN[lower] || guess(lower);
    if (!SAME_WIDTHS.has(lower)) {
      if (/^(\.vn|vni[- ]|abc)/.test(lower)) this.legacy.add(asked);
      this.replaced.set(asked, FACES[known[0]].label);
    }
    return this.make(key, asked, known, bold, italic);
  }

  /** @returns {Pick} */
  make(key, asked, [face, scale, asc, desc, gap], bold, italic) {
    const ok = this.load(face);
    const usable = ok ? face : 'carlito';
    if (!ok) this.load('carlito');
    const made = {
      name: asked,
      face: usable,
      alias: FACES[usable].alias,
      scale,
      asc,
      desc,
      gap,
      bold,
      italic,
      prefix: `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}`,
      cover: coverage.get(usable) || new Set(),
    };
    this.picks.set(key, made);
    return made;
  }

  /** The same font on a different face, for a word the first one cannot draw. */
  sibling(pick, face) {
    const key = `${pick.name}|${pick.bold ? 1 : 0}|${pick.italic ? 1 : 0}|${face}`;
    const cached = this.picks.get(key);
    if (cached) return cached;
    this.load(face);
    const made = {
      ...pick,
      face,
      alias: FACES[face].alias,
      cover: coverage.get(face) || new Set(),
    };
    this.picks.set(key, made);
    return made;
  }

  /**
   * A word split into what each face can draw: normally one piece. The whole word
   * goes to one face where one holds it, so a Vietnamese word in Arial is all Arimo
   * rather than a mix of two designs letter by letter.
   *
   * @param {string} text
   * @param {Pick} pick
   * @returns {{ text: string, pick: Pick }[]}
   */
  pieces(text, pick) {
    if (isAscii(text)) return [{ text, pick }];
    const covers = (candidate) => {
      for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code > 0x20 && !candidate.cover.has(code)) return false;
      }
      return true;
    };
    if (covers(pick)) return [{ text, pick }];
    const chain = FACES[pick.face].fallback;
    for (const face of chain) {
      const candidate = this.sibling(pick, face);
      if (covers(candidate)) return [{ text, pick: candidate }];
    }
    /** Nothing holds it all, so letter by letter; what nothing holds is noted, and draws as a box. */
    const out = [];
    for (const ch of text) {
      const code = ch.codePointAt(0);
      let chosen = pick;
      if (code > 0x20 && !pick.cover.has(code)) {
        const found = chain.map((face) => this.sibling(pick, face)).find((c) => c.cover.has(code));
        if (found) chosen = found;
        else this.missing.add(ch);
      }
      const last = out[out.length - 1];
      if (last && last.pick === chosen) last.text += ch;
      else out.push({ text: ch, pick: chosen });
    }
    return out;
  }

  /** Honest sentences about what was not drawn with the file's own fonts. */
  notes() {
    const out = [];
    const replaced = [...this.replaced.entries()].filter(([name]) => !this.legacy.has(name));
    for (const [name, label] of replaced.slice(0, 5)) {
      out.push(`${name} is not available here and was drawn with ${label}, so line breaks may differ from the original.`);
    }
    if (replaced.length > 5) out.push(`${replaced.length - 5} more fonts were also replaced with the nearest available one.`);
    if (this.legacy.size) {
      out.push(`${[...this.legacy].slice(0, 3).join(', ')} is an old Vietnamese font encoding, so letters in it may look wrong here even though they are right in the original.`);
    }
    if (this.missing.size) {
      const sample = [...this.missing].slice(0, 6).join(' ');
      out.push(`${this.missing.size} different characters (such as ${sample}) have no font here and appear as empty boxes; the file's text still has them.`);
    }
    return out;
  }
}

/** What the font size is multiplied by on the page, and how tall a line of it is, in ems. */
export const lineOf = (pick) => pick.asc + pick.desc + pick.gap;
