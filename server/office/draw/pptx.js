/**
 * Slides, drawn.
 *
 * Almost everything on a slide is inherited. A title placeholder with no position
 * and no font takes both from its layout, which takes them from its master, which
 * takes colours from a theme through a colour map that a dark layout can flip. So
 * most of this file is the walk up that chain, and the rest is setting the words.
 *
 * Speaker notes are not drawn; a slide as it looks does not show them.
 */
import { attr, element, elements, localName, parseXml, relationshipId } from '../xml.js';
import { isRel, mainPart, readRelationships, relsPathFor, resolveTarget } from '../opc.js';
import { LIMITS, Surface, emu, refused } from './common.js';
import { colorIn, cssIn, drawNode, drawSmartArt, fillIn, labelledBox, paintFor, paintPath, readTheme, readXfrm, strokeFrom, textInsets, themeFont } from './dml.js';
import { paintLine, setLines } from './text.js';
import { symbolChar } from './fonts.js';
import { drawChart } from './chart.js';

const isTrue = (value) => value === '1' || value === 'true';
const hundredths = (value) => Number(value) / 100;

/** Read a part and its relationships, once per look. */
function partReader(zip) {
  const cache = new Map();
  return (part) => {
    if (cache.has(part)) return cache.get(part);
    const loaded = zip.has(part) ? { part, root: parseXml(zip.text(part)), rels: readRelationships(zip, relsPathFor(part)) } : null;
    cache.set(part, loaded);
    return loaded;
  };
}

/** The part a relationship of this kind points at. */
function relatedPart(loaded, kind) {
  for (const [, rel] of loaded?.rels || []) {
    if (isRel(rel.type, kind)) return resolveTarget(loaded.part, rel.target);
  }
  return null;
}

/** `bg1="lt1"`: the colour map, as an object. */
function colorMap(node) {
  if (!node) return null;
  return { ...node.attrs };
}

/* ── placeholders ───────────────────────────────────────────────────── */

const phOf = (shape) => element(element(elements(shape).find((c) => /^nv/.test(localName(c.name))), 'nvPr'), 'ph');

/** A slide placeholder finds its layout's by index, then by type. */
function findPlaceholder(tree, ph, { matchIdx }) {
  if (!tree || !ph) return null;
  const type = String(attr(ph, 'type') || '');
  const idx = attr(ph, 'idx');
  let byType = null;
  for (const shape of elements(tree, 'sp')) {
    const other = phOf(shape);
    if (!other) continue;
    if (matchIdx && idx !== undefined && attr(other, 'idx') === idx) return shape;
    const otherType = String(attr(other, 'type') || '');
    const same = otherType === type
      || (type === 'ctrTitle' && otherType === 'title')
      || (type === 'title' && otherType === 'ctrTitle')
      || (type === 'subTitle' && otherType === 'body')
      || (!type && otherType === 'body');
    if (same && !byType) byType = shape;
  }
  return byType;
}

/** Which of the master's three text styles a placeholder draws on. */
function styleKind(ph) {
  if (!ph) return 'otherStyle';
  const type = String(attr(ph, 'type') || 'body');
  if (type === 'title' || type === 'ctrTitle') return 'titleStyle';
  if (type === 'dt' || type === 'ftr' || type === 'sldNum') return 'otherStyle';
  return 'bodyStyle';
}

/* ── paragraphs and runs ────────────────────────────────────────────── */

/** The first answer up the inheritance chain: list styles from the nearest out. */
function levelNodes(chain, level) {
  const name = `lvl${Math.min(level, 8) + 1}pPr`;
  return chain.map((list) => element(list, name)).filter(Boolean);
}

function firstAttr(nodes, name) {
  for (const node of nodes) {
    const value = attr(node, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstChild(nodes, name) {
  for (const node of nodes) {
    const found = element(node, name);
    if (found) return found;
  }
  return null;
}

/** Line or paragraph spacing: a percentage of the line, or points. */
function spacingOf(node) {
  if (!node) return null;
  const pct = element(node, 'spcPct');
  if (pct) return { pct: (Number(attr(pct, 'val')) || 0) / 100000 };
  const pts = element(node, 'spcPts');
  if (pts) return { pts: (Number(attr(pts, 'val')) || 0) / 100 };
  return null;
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function roman(n) {
  let out = '';
  let rest = n;
  for (const [value, text] of ROMAN) while (rest >= value) { out += text; rest -= /** @type {number} */ (value); }
  return out;
}
const alpha = (n) => {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const r = (rest - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return out;
};

/** "arabicPeriod" and friends: one number, as PowerPoint writes it. */
function numberLabel(kind, n) {
  const k = String(kind || 'arabicPeriod');
  const body = /^roman/.test(k) ? roman(n) : /^alpha/.test(k) ? alpha(n) : String(n);
  const cased = /UC/.test(k) ? body.toUpperCase() : body;
  if (/ParenBoth/.test(k)) return `(${cased})`;
  if (/ParenR/.test(k)) return `${cased})`;
  if (/Plain/.test(k)) return cased;
  return `${cased}.`;
}

/**
 * A slide's words: one text body, every property found.
 *
 * `scale` is autofit: `fontScale` from the file, or the shrink worked out when the
 * file only says it should fit and the words do not.
 */
function layoutBody(txBody, width, chain, env, { fontColor = null, fontScale = 1, spaceCut = 0, wrap = true, kind = 'otherStyle', fontFace = null } = {}) {
  const out = [];
  const numbering = [];
  let y = 0;
  let firstDrawn = true;
  for (const p of elements(txBody, 'p')) {
    const pPr = element(p, 'pPr');
    const level = Number(attr(pPr, 'lvl')) || 0;
    const levels = levelNodes(chain, level);
    const paragraphs = [pPr, ...levels];
    const defaults = levels.map((node) => element(node, 'defRPr')).filter(Boolean);

    const runStyle = (rPr) => {
      const nodes = [rPr, ...defaults].filter(Boolean);
      const size = firstAttr(nodes, 'sz');
      const fontNode = firstChild(nodes, 'latin');
      const face = attr(fontNode, 'typeface');
      const bold = firstAttr(nodes, 'b');
      const italic = firstAttr(nodes, 'i');
      let color = null;
      for (const node of nodes) {
        const fill = fillIn(node, env);
        if (fill?.type === 'solid') { color = fill.color; break; }
        if (fill?.type === 'grad') { color = fill.stops[0][1]; break; }
        if (node === rPr && fontColor) { color = fontColor; break; }
      }
      const u = firstAttr(nodes, 'u');
      const strike = firstAttr(nodes, 'strike');
      const cap = firstAttr(nodes, 'cap');
      const baseline = Number(firstAttr(nodes, 'baseline')) || 0;
      const spacing = Number(firstAttr(nodes, 'spc')) || 0;
      const link = rPr && element(rPr, 'hlinkClick');
      const name = themeFont(face || fontFace || (kind === 'titleStyle' ? '+mj-lt' : '+mn-lt'), env.theme);
      const shown = (size !== undefined ? hundredths(size) : 18) * fontScale;
      return {
        pick: env.fonts.pick(name, isTrue(bold), isTrue(italic)),
        size: shown,
        color: color || (link ? `#${env.theme.colors.hlink}` : fontColor) || cssFor('tx1', env),
        underline: (u && u !== 'none') || !!link,
        strike: !!strike && strike !== 'noStrike',
        doubleStrike: strike === 'dblStrike',
        highlight: rPr ? cssIn(element(rPr, 'highlight'), env) : null,
        shift: baseline / 100000,
        spacing: spacing ? spacing / 100 : 0,
        caps: cap === 'all',
        smallCaps: cap === 'small',
      };
    };

    const inlines = [];
    let firstStyle = null;
    for (const child of elements(p)) {
      const name = localName(child.name);
      if (name === 'r' || name === 'fld') {
        const style = runStyle(element(child, 'rPr'));
        const type = attr(child, 'type');
        const raw = childText(child);
        const text = name === 'fld' && String(type || '').startsWith('slidenum') ? String(env.slideNumber ?? raw) : raw;
        firstStyle ??= style;
        inlines.push({ type: 'text', text: text.replace(/\t/g, ' '), style });
      } else if (name === 'br') {
        inlines.push({ type: 'br', style: runStyle(element(child, 'rPr')) });
      }
    }
    const endStyle = runStyle(element(p, 'endParaRPr'));
    const anchorStyle = firstStyle || endStyle;

    const marL = emu(firstAttr(paragraphs, 'marL'));
    const indent = emu(firstAttr(paragraphs, 'indent'));
    const align = String(firstAttr(paragraphs, 'algn') || 'l');
    const lineSpacing = spacingOf(firstChild(paragraphs, 'lnSpc')) || { pct: 1 };
    const before = spacingOf(firstChild(paragraphs, 'spcBef')) || { pts: 0 };
    const after = spacingOf(firstChild(paragraphs, 'spcAft')) || { pts: 0 };

    // A paragraph with no words shows no bullet, however it is styled.
    const none = element(pPr, 'buNone');
    const bulletChar = firstChild(paragraphs, 'buChar');
    const bulletNum = firstChild(paragraphs, 'buAutoNum');
    const stated = none ? null : paragraphs.map((node) => (element(node, 'buNone') ? 'none' : element(node, 'buChar') ? 'char' : element(node, 'buAutoNum') ? 'num' : null)).find(Boolean);
    let bulletText = null;
    if (stated === 'char' && bulletChar) bulletText = String(attr(bulletChar, 'char') || '•');
    if (stated === 'num' && bulletNum) {
      const startAt = Number(attr(bulletNum, 'startAt')) || 1;
      numbering[level] = (numbering[level] ?? startAt - 1) + 1;
      numbering.length = level + 1;
      bulletText = numberLabel(attr(bulletNum, 'type'), numbering[level]);
    } else numbering.length = level;
    if (!inlines.length) bulletText = null;

    let bullet = null;
    if (bulletText) {
      const buFont = attr(firstChild(paragraphs, 'buFont'), 'typeface');
      const symbol = buFont ? symbolChar(buFont, bulletText) : null;
      const pct = attr(firstChild(paragraphs, 'buSzPct'), 'val');
      const pts = attr(firstChild(paragraphs, 'buSzPts'), 'val');
      const size = pts !== undefined ? hundredths(pts) * fontScale : (anchorStyle.size * (pct !== undefined ? Number(pct) / 100000 : 1));
      const buClr = firstChild(paragraphs, 'buClr');
      const font = symbol ? 'Arial' : themeFont(buFont || anchorStyle.pick.name, env.theme);
      bullet = {
        text: symbol || bulletText,
        style: { pick: env.fonts.pick(font, anchorStyle.pick.bold && stated === 'num', false), size, color: (buClr && cssIn(buClr, env)) || anchorStyle.color },
      };
    }

    const bulletW = bullet ? env.fonts.pieces(bullet.text, bullet.style.pick).reduce((sum, part) => sum + env.measure.width(part.pick, bullet.style.size, part.text), 0) : 0;
    const firstX = bullet ? Math.max(marL, marL + indent + bulletW) : marL + indent;
    const heightFor = (line) => {
      const natural = line.asc + line.desc + line.gap;
      const box = line.boxH || 0;
      const base = lineSpacing.pct !== undefined ? natural * Math.max(0.1, lineSpacing.pct - spaceCut) : lineSpacing.pts * fontScale;
      line.height = Math.max(base, box);
      // PowerPoint takes tighter spacing off the top of a line, and adds looser there too.
      line.baseline = line.height - line.desc;
    };
    const lines = setLines(inlines, {
      width,
      first: firstX,
      rest: marL,
      align,
      wrap,
      empty: endStyle,
      metrics: heightFor,
      defaultTab: emu(firstAttr(paragraphs, 'defTabSz')) || 72,
      fonts: env.fonts,
      measure: env.measure,
      budget: env.budget,
    });
    const space = (value, size) => (value.pct !== undefined ? value.pct * size * 1.2 : value.pts * fontScale);
    // The first paragraph's space before is not taken at the top of a box.
    const spaceBefore = firstDrawn ? 0 : space(before, anchorStyle.size);
    const spaceAfter = space(after, anchorStyle.size);
    y += spaceBefore;
    out.push({ lines, y, bullet, bulletX: marL + indent });
    for (const line of lines) y += line.height;
    y += spaceAfter;
    firstDrawn = false;
  }
  return { paragraphs: out, height: y };
}

const childText = (node) => {
  const t = element(node, 't');
  return t ? t.children.filter((c) => typeof c === 'string').join('') : '';
};

function cssFor(slot, env) {
  const value = colorIn({ name: 'wrap', attrs: {}, children: [{ name: 'schemeClr', attrs: { val: slot }, children: [] }] }, env);
  return value ? `#${value.hex}` : '#000000';
}

/** Paint set paragraphs, top left at (x, y). */
function paintBody(surface, body, x, y, env) {
  for (const paragraph of body.paragraphs) {
    let top = y + paragraph.y;
    paragraph.lines.forEach((line, i) => {
      if (i === 0 && paragraph.bullet) {
        surface.text(paragraph.bullet.text, x + paragraph.bulletX, top + line.baseline, paragraph.bullet.style);
      }
      paintLine(surface, line, x, top);
      top += line.height;
    });
    env.budget?.check();
  }
}

/* ── a shape's text ─────────────────────────────────────────────────── */

const DEFAULT_INSET = { l: 7.2, t: 3.6, r: 7.2, b: 3.6 };

/** Whatever `bodyPr` says first, up the chain. */
function bodyProps(own, chain) {
  const nodes = [own, ...chain].filter(Boolean);
  const inset = (name, fallback) => {
    const value = firstAttr(nodes, name);
    return value !== undefined ? emu(value) : fallback;
  };
  const fit = (() => {
    for (const node of nodes) {
      const norm = element(node, 'normAutofit');
      if (norm) return { kind: 'norm', fontScale: (Number(attr(norm, 'fontScale')) || 100000) / 100000, spaceCut: (Number(attr(norm, 'lnSpcReduction')) || 0) / 100000 };
      if (element(node, 'noAutofit')) return { kind: 'none' };
      if (element(node, 'spAutoFit')) return { kind: 'shape' };
    }
    return { kind: 'none' };
  })();
  return {
    l: inset('lIns', DEFAULT_INSET.l),
    t: inset('tIns', DEFAULT_INSET.t),
    r: inset('rIns', DEFAULT_INSET.r),
    b: inset('bIns', DEFAULT_INSET.b),
    anchor: String(firstAttr(nodes, 'anchor') || 't'),
    centered: isTrue(firstAttr(nodes, 'anchorCtr')),
    wrap: firstAttr(nodes, 'wrap') !== 'none',
    vert: String(firstAttr(nodes, 'vert') || 'horz'),
    rot: Number(firstAttr(nodes, 'rot')) || 0,
    fit,
  };
}

/** The words of a shape, inside its box. */
export function drawShapeText(surface, node, box, { styled, name, av, inherited }, env) {
  const txBody = element(node, 'txBody') || element(element(node, 'txbx'), 'txBody');
  if (!txBody) return;
  if (!elements(txBody, 'p').some((p) => elements(p, 'r').length || elements(p, 'fld').length || elements(p, 'br').length)) return;

  const placeholder = inherited?.ph;
  const kind = inherited?.kind || 'otherStyle';
  const props = bodyProps(element(txBody, 'bodyPr'), inherited?.bodyPrs || []);
  const [il, it, ir, ib] = textInsets(name, box.w, box.h, av);
  const vertical = props.vert === 'vert' || props.vert === 'vert270' || props.vert === 'eaVert' || props.vert === 'wordArtVert';
  const innerW = (vertical ? box.h : box.w) - il - ir - props.l - props.r;
  const innerH = (vertical ? box.w : box.h) - it - ib - props.t - props.b;
  const chain = [element(txBody, 'lstStyle'), ...(inherited?.lists || []), ...(env.textStyles?.[kind] ? [env.textStyles[kind]] : []), env.defaultTextStyle].filter(Boolean);
  const fontColor = styled?.fontColor || null;
  const fontFace = styled?.fontIdx === 'major' ? '+mj-lt' : null;

  const set = (fontScale, spaceCut) => layoutBody(txBody, Math.max(1, innerW), chain, env, { fontColor, fontScale, spaceCut, wrap: props.wrap, kind, fontFace });
  let body = set(props.fit.kind === 'norm' ? props.fit.fontScale : 1, props.fit.kind === 'norm' ? props.fit.spaceCut : 0);
  // Told to fit with no scale saved: work it out, as PowerPoint would on opening it to edit.
  if (props.fit.kind === 'norm' && props.fit.fontScale === 1 && body.height > innerH && innerH > 0) {
    for (const scale of [0.9, 0.8, 0.7, 0.62, 0.55, 0.48, 0.4, 0.32, 0.25]) {
      env.budget?.check();
      body = set(scale, scale < 0.8 ? 0.1 : 0);
      if (body.height <= innerH) break;
    }
  }

  const quiet = placeholder && /^(dt|ftr|sldNum)$/.test(String(attr(placeholder, 'type') || ''));
  const shapeName = String(attr(element(elements(node).find((c) => /^nv/.test(localName(c.name))), 'cNvPr'), 'name') || '');
  const chrome = quiet || /^(Footer|Slide Number)/.test(shapeName);
  if (chrome) surface.quiet += 1;

  const free = innerH - body.height;
  const down = props.anchor === 'ctr' ? free / 2 : props.anchor === 'b' ? free : 0;
  const turned = vertical || props.rot;
  if (turned) {
    surface.save();
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const angle = (props.vert === 'vert270' ? -Math.PI / 2 : vertical ? Math.PI / 2 : 0) + ((props.rot / 60000) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    surface.transform(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy);
    const x = cx - (vertical ? box.h : box.w) / 2 + il + props.l;
    const y = cy - (vertical ? box.w : box.h) / 2 + it + props.t + down;
    paintBody(surface, body, x, y, env);
    surface.restore();
  } else {
    let x = box.x + il + props.l;
    if (props.centered) {
      const wide = Math.max(0, ...body.paragraphs.flatMap((p) => p.lines.map((l) => l.width)));
      x += Math.max(0, (innerW - wide) / 2);
    }
    if (!props.wrap) {
      // A box that does not wrap grows from its anchor, so its words stay inside it when it is centred.
      const wide = Math.max(0, ...body.paragraphs.flatMap((p) => p.lines.map((l) => l.width)));
      const aligned = String(attr(element(elements(txBody, 'p')[0], 'pPr'), 'algn') || 'l');
      if (aligned === 'ctr') x = box.x + (box.w - wide) / 2;
      if (aligned === 'r') x = box.x + box.w - props.r - wide;
    }
    paintBody(surface, body, x, box.y + it + props.t + down, env);
  }
  if (chrome) surface.quiet -= 1;
}

/* ── tables ─────────────────────────────────────────────────────────── */

/** The named table styles the deck defines. PowerPoint's default is inlined when used. */
function tableStyle(env, id) {
  const part = env.tableStyles;
  if (!part || !id) return null;
  for (const style of elements(part, 'tblStyle')) if (attr(style, 'styleId') === id) return style;
  return null;
}

/** The parts of a table style that apply to a cell, from least to most specific. */
function cellStyleParts(style, tblPr, r, c, rows, cols) {
  if (!style) return [];
  const on = (name) => isTrue(attr(tblPr, name));
  const out = [];
  const add = (name) => { const part = element(style, name); if (part) out.push(part); };
  add('wholeTbl');
  const dataRow = r - (on('firstRow') ? 1 : 0);
  if (on('bandRow') && !(on('firstRow') && r === 0) && !(on('lastRow') && r === rows - 1)) add(dataRow % 2 === 0 ? 'band1H' : 'band2H');
  if (on('bandCol')) add((c - (on('firstCol') ? 1 : 0)) % 2 === 0 ? 'band1V' : 'band2V');
  if (on('firstCol') && c === 0) add('firstCol');
  if (on('lastCol') && c === cols - 1) add('lastCol');
  if (on('lastRow') && r === rows - 1) add('lastRow');
  if (on('firstRow') && r === 0) add('firstRow');
  return out;
}

const BORDER_OF = { lnL: 'left', lnR: 'right', lnT: 'top', lnB: 'bottom' };

/** A cell's border on one side: its own, else what the table style says for that position. */
function cellBorder(tcPr, side, parts, env, inner) {
  const own = element(tcPr, side);
  if (own) return strokeFrom(own, env);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const borders = element(element(parts[i], 'tcStyle'), 'tcBdr');
    const edge = element(borders, inner || BORDER_OF[side]) || (inner ? element(borders, BORDER_OF[side]) : null);
    if (!edge) continue;
    const ln = element(edge, 'ln');
    if (ln) return strokeFrom(ln, env);
    const ref = element(edge, 'lnRef');
    if (ref) {
      const idx = Number(attr(ref, 'idx')) || 0;
      const node = env.theme?.lines?.[idx - 1];
      if (node) return strokeFrom(node, { ...env, phClr: colorIn(ref, env) });
    }
  }
  return null;
}

function drawTable(surface, tbl, box, env) {
  const tblPr = element(tbl, 'tblPr');
  const style = tableStyle(env, textOfNode(element(tblPr, 'tableStyleId')));
  const widths = elements(element(tbl, 'tblGrid'), 'gridCol').map((col) => emu(attr(col, 'w')));
  const rowNodes = elements(tbl, 'tr');
  const cols = widths.length;
  const rows = rowNodes.length;
  if (!cols || !rows) return;

  const grid = rowNodes.map((tr, r) => elements(tr, 'tc').map((tc, c) => {
    const tcPr = element(tc, 'tcPr');
    const parts = cellStyleParts(style, tblPr, r, c, rows, cols);
    const span = Number(attr(tc, 'gridSpan')) || 1;
    const rowSpan = Number(attr(tc, 'rowSpan')) || 1;
    return {
      tc, tcPr, parts, span, rowSpan,
      hidden: isTrue(attr(tc, 'hMerge')) || isTrue(attr(tc, 'vMerge')),
      margins: {
        l: attr(tcPr, 'marL') !== undefined ? emu(attr(tcPr, 'marL')) : 7.2,
        r: attr(tcPr, 'marR') !== undefined ? emu(attr(tcPr, 'marR')) : 7.2,
        t: attr(tcPr, 'marT') !== undefined ? emu(attr(tcPr, 'marT')) : 3.6,
        b: attr(tcPr, 'marB') !== undefined ? emu(attr(tcPr, 'marB')) : 3.6,
      },
      anchor: String(attr(tcPr, 'anchor') || 't'),
    };
  }));

  // Words first: a row is as tall as the tallest cell in it, whatever the file stored.
  const heights = rowNodes.map((tr) => emu(attr(tr, 'h')));
  const widthOf = (c, span) => widths.slice(c, c + span).reduce((a, b) => a + b, 0);
  grid.forEach((cells, r) => {
    cells.forEach((cell, c) => {
      env.budget?.check();
      if (cell.hidden) return;
      const textStyles = cell.parts.map((part) => element(part, 'tcTxStyle')).filter(Boolean);
      const last = textStyles[textStyles.length - 1];
      const color = textStyles.reduceRight((found, node) => found || cssIn(node, env), null);
      const bolded = textStyles.some((node) => attr(node, 'b') === 'on');
      const chain = [env.defaultTextStyle].filter(Boolean);
      const body = layoutBody(element(cell.tc, 'txBody'), Math.max(1, widthOf(c, cell.span) - cell.margins.l - cell.margins.r), chain, env, {
        fontColor: color || (last ? null : null) || cssFor('tx1', env),
        kind: 'otherStyle',
      });
      if (bolded) reBold(body, env);
      cell.body = body;
      if (cell.rowSpan === 1) heights[r] = Math.max(heights[r], body.height + cell.margins.t + cell.margins.b);
    });
  });

  let y = box.y;
  const tops = heights.map((h) => {
    const at = y;
    y += h;
    return at;
  });
  const lines = [];
  grid.forEach((cells, r) => {
    let x = box.x;
    cells.forEach((cell, c) => {
      const w = widthOf(c, cell.span);
      const h = heights.slice(r, r + cell.rowSpan).reduce((a, b) => a + b, 0);
      if (!cell.hidden) {
        surface.tableCells += 1;
        const own = fillIn(cell.tcPr, env);
        let fill = own;
        if (!fill) {
          for (let i = cell.parts.length - 1; i >= 0 && !fill; i -= 1) {
            const inner = element(element(element(cell.parts[i], 'tcStyle'), 'fill'), 'solidFill')
              ? fillIn(element(element(cell.parts[i], 'tcStyle'), 'fill'), env)
              : undefined;
            fill = inner;
          }
        }
        if (fill) {
          const paint = fill.type === 'blip' ? null : paintFor(fill, x, tops[r], w, h);
          if (paint) surface.rect(x, tops[r], w, h, paint);
        }
        const free = h - cell.body.height - cell.margins.t - cell.margins.b;
        const down = cell.anchor === 'ctr' ? free / 2 : cell.anchor === 'b' ? free : 0;
        lines.push({ cell, x, y: tops[r], w, h, r, c, down });
      }
      x += w;
    });
  });
  for (const placed of lines) {
    paintBody(surface, placed.cell.body, placed.x + placed.cell.margins.l, placed.y + placed.cell.margins.t + placed.down, env);
  }
  for (const { cell, x, y: top, w, h, r, c } of lines) {
    const paint = (side, x1, y1, x2, y2, inner) => {
      const stroke = cellBorder(cell.tcPr, side, cell.parts, env, inner);
      if (stroke) surface.line(x1, y1, x2, y2, stroke.color, stroke.width, stroke.dash);
    };
    paint('lnT', x, top, x + w, top, r > 0 ? 'insideH' : null);
    paint('lnB', x, top + h, x + w, top + h, r + cell.rowSpan < rows ? 'insideH' : null);
    paint('lnL', x, top, x, top + h, c > 0 ? 'insideV' : null);
    paint('lnR', x + w, top, x + w, top + h, c + cell.span < cols ? 'insideV' : null);
  }
}

const textOfNode = (node) => (node ? node.children.filter((c) => typeof c === 'string').join('').trim() : '');

/** A table style's bold, on words already set. Widths move little and rows do not. */
function reBold(body, env) {
  for (const paragraph of body.paragraphs) {
    for (const line of paragraph.lines) {
      for (const item of line.items) {
        if (item.k !== 't') continue;
        const style = item.style;
        const bold = env.fonts.pick(style.pick.name, true, style.pick.italic);
        item.style = { ...style, pick: bold };
        item.pieces = item.pieces.map((piece) => ({ ...piece, pick: env.fonts.pick(piece.pick.name, true, piece.pick.italic) }));
      }
    }
  }
}

/* ── a slide ────────────────────────────────────────────────────────── */

/** A table, chart or diagram: whatever a graphic frame holds. */
function drawFrame(surface, node, box, env) {
  const data = element(element(node, 'graphic'), 'graphicData');
  const uri = String(attr(data, 'uri') || '');
  if (/\/table$/.test(uri)) {
    const tbl = element(data, 'tbl');
    if (tbl) drawTable(surface, tbl, box, env);
    return;
  }
  if (/\/chart$/.test(uri)) {
    const chart = element(data, 'chart');
    const rel = env.rels.get(String(relationshipId(chart)));
    if (rel && drawChart(surface, resolveTarget(env.part, rel.target), box, env)) {
      env.noteAt?.('has a chart; it was drawn from its saved numbers by a simplified drawing, so its styling may differ');
    } else {
      labelledBox(surface, box.x, box.y, box.w, box.h, 'Chart', env);
      env.noteAt?.('has a chart that could not be drawn; it appears as a labelled box');
    }
    return;
  }
  if (/\/diagram$/.test(uri)) {
    if (!drawSmartArt(surface, data, box, env)) {
      labelledBox(surface, box.x, box.y, box.w, box.h, 'SmartArt diagram', env);
      env.noteAt?.('has a SmartArt diagram with no saved drawing; it appears as a labelled box');
    }
    return;
  }
  // An embedded object keeps a picture of itself.
  const pic = [...elements(data)].flatMap((child) => elements(child, 'pic'))[0];
  if (pic) {
    drawNode(surface, pic, { ...env, fallbackXfrm: { x: box.x, y: box.y, w: box.w, h: box.h } });
    return;
  }
  labelledBox(surface, box.x, box.y, box.w, box.h, 'Embedded object', env);
  env.noteAt?.('has an embedded object that is not drawn; it appears as a labelled box');
}

/** The background a part states, or null to keep looking up the chain. */
function backgroundOf(root, env) {
  const bg = element(element(root, 'cSld'), 'bg');
  if (!bg) return null;
  const props = element(bg, 'bgPr');
  if (props) return fillIn(props, env) || null;
  const ref = element(bg, 'bgRef');
  if (ref) {
    const idx = Number(attr(ref, 'idx')) || 0;
    const ph = colorIn(ref, env);
    const list = idx >= 1001 ? env.theme.bgFills : env.theme.fills;
    const node = list?.[(idx >= 1001 ? idx - 1001 : idx - 1)];
    if (node) {
      const fill = fillIn({ name: 'wrap', attrs: {}, children: [node] }, { ...env, phClr: ph });
      if (fill) return fill;
    }
    return ph ? { type: 'solid', color: `#${ph.hex}` } : null;
  }
  return null;
}

/**
 * Every slide of a deck, laid out.
 *
 * @param {any} zip
 * @param {any} tools  fonts, measure, budget, note
 * @param {{ pages?: number[]|null }} [options]  only these slides, when asked for by number
 */
export function layoutPptx(zip, tools, { pages = null } = {}) {
  const read = partReader(zip);
  const main = mainPart(zip, 'ppt/presentation.xml');
  const presentation = read(main);
  if (!presentation) throw refused('That .pptx has no presentation part, so it may be corrupt.');

  const size = element(presentation.root, 'sldSz');
  const width = Math.min(Math.max(emu(attr(size, 'cx')) || 720, 36), 4032);
  const height = Math.min(Math.max(emu(attr(size, 'cy')) || 540, 36), 4032);
  const defaultTextStyle = element(presentation.root, 'defaultTextStyle');
  const tablePart = relatedPart(presentation, 'tableStyles');
  const tableStyles = tablePart && zip.has(tablePart) ? parseXml(zip.text(tablePart)) : null;

  const list = element(presentation.root, 'sldIdLst');
  const entries = list ? elements(list, 'sldId') : [];
  const paths = [];
  for (const entry of entries) {
    const rel = presentation.rels.get(String(relationshipId(entry)));
    const path = rel ? resolveTarget(main, rel.target) : null;
    if (path && zip.has(path)) paths.push({ path, hidden: false });
  }
  const total = paths.length;
  const limit = Math.min(total, LIMITS.slides);
  const wanted = Array.isArray(pages) && pages.length ? new Set(pages) : null;

  const out = [];
  for (let index = 0; index < limit; index += 1) {
    tools.budget.check();
    const number = index + 1;
    if (wanted && !wanted.has(number)) continue;
    const slide = read(paths[index].path);
    if (!slide) continue;
    const layout = read(relatedPart(slide, 'slideLayout'));
    const master = read(relatedPart(layout, 'slideMaster'));
    const theme = readTheme(zip, relatedPart(master, 'theme'));
    const masterMap = colorMap(element(master?.root, 'clrMap'));
    const override = (loaded) => colorMap(element(element(loaded?.root, 'clrMapOvr'), 'overrideClrMapping'));

    const base = {
      zip,
      theme,
      fonts: tools.fonts,
      measure: tools.measure,
      budget: tools.budget,
      note: tools.note,
      noteAt: (text) => tools.note(`Slide ${number} ${text}.`),
      slideNumber: number,
      defaultTextStyle,
      tableStyles,
      textStyles: Object.fromEntries(['titleStyle', 'bodyStyle', 'otherStyle'].map((name) => [name, element(element(master?.root, 'txStyles'), name)])),
      drawFrame,
      drawText: null,
    };
    const envFor = (loaded, map) => ({
      ...base,
      part: loaded.part,
      rels: loaded.rels,
      clrMap: map || masterMap,
    });
    const slideEnv = envFor(slide, override(slide) || override(layout));
    const layoutEnv = envFor(layout || slide, override(layout));
    const masterEnv = envFor(master || slide, masterMap);

    const layoutTree = element(element(layout?.root, 'cSld'), 'spTree');
    const masterTree = element(element(master?.root, 'cSld'), 'spTree');

    /** A placeholder's layout and master, the rest of what it inherits. */
    const inherit = (node) => {
      const ph = phOf(node);
      if (!ph) return { kind: 'otherStyle' };
      const inLayout = findPlaceholder(layoutTree, ph, { matchIdx: true });
      const inMaster = findPlaceholder(masterTree, inLayout ? phOf(inLayout) : ph, { matchIdx: false });
      const chainNodes = [inLayout, inMaster].filter(Boolean);
      const spPrs = chainNodes.map((shape) => element(shape, 'spPr'));
      const bodies = chainNodes.map((shape) => element(shape, 'txBody'));
      return {
        ph,
        kind: styleKind(ph),
        xfrm: spPrs.map(readXfrm).find(Boolean) || null,
        spPrs,
        bodyPrs: bodies.map((body) => element(body, 'bodyPr')).filter(Boolean),
        lists: bodies.map((body) => element(body, 'lstStyle')).filter(Boolean),
      };
    };

    const surface = new Surface(width, height);
    surface.number = number;
    const hidden = attr(slide.root, 'show') === '0';
    if (hidden) tools.note(`Slide ${number} is hidden in the presentation.`);

    const fill = backgroundOf(slide.root, slideEnv) || backgroundOf(layout?.root, layoutEnv) || backgroundOf(master?.root, masterEnv) || { type: 'solid', color: '#FFFFFF' };
    const page = [['M', 0, 0], ['L', width, 0], ['L', width, height], ['L', 0, height], ['Z']];
    if (fill.type === 'solid') surface.background = fill.color;
    paintPath(surface, page, { fill: /** @type {any} */ (fill), x: 0, y: 0, w: width, h: height }, slideEnv);

    const showMaster = (loaded) => attr(loaded?.root, 'showMasterSp') !== '0' && attr(loaded?.root, 'showMasterSp') !== 'false';
    const drawTree = (tree, env, skipPlaceholders) => {
      const textEnv = { ...env };
      textEnv.drawText = (s, node, box, info) => drawShapeText(s, node, box, info, textEnv);
      textEnv.inherit = skipPlaceholders ? null : inherit;
      for (const node of elements(tree)) {
        const name = localName(node.name);
        if (!['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame', 'AlternateContent'].includes(name)) continue;
        // A layout's and a master's placeholders are prompts, not content.
        if (skipPlaceholders && name === 'sp' && phOf(node)) continue;
        drawNode(surface, node, textEnv);
      }
    };
    if (showMaster(slide)) {
      if (showMaster(layout) && masterTree) drawTree(masterTree, masterEnv, true);
      if (layoutTree) drawTree(layoutTree, layoutEnv, true);
    }
    drawTree(element(element(slide.root, 'cSld'), 'spTree'), slideEnv, false);
    if (surface.overflowed) tools.note(`Slide ${number} has more shapes than are drawn here, so some are missing.`);
    out.push(surface);
  }
  if (total > limit) tools.note(`This deck has ${total} slides; only the first ${limit} were considered.`);
  return { unit: 'slide', total, pages: out, kerning: 'normal' };
}
