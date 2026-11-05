/**
 * DrawingML: the shapes, fills and colours PowerPoint, Word and Excel share.
 *
 * A theme colour with `lumMod`, a gradient, a rounded rectangle and a group of
 * either mean the same in all three, so they are read once here. What differs is
 * who supplies the text and where a shape inherits from, which the caller passes in
 * on `env`:
 *
 *   env.theme, env.clrMap   colours
 *   env.part, env.rels      where this drawing lives, so a picture can be found
 *   env.inherit(node)       a placeholder's layout and master, for PowerPoint
 *   env.drawText(...)       the words in a shape, each format its own way
 *   env.drawFrame(...)      a table or a chart, which only the caller knows about
 */
import { attr, element, elements, localName, parseXml, relationshipId } from '../xml.js';
import { readRelationships, relsPathFor, resolveTarget } from '../opc.js';
import { DRAWABLE_PICTURE, clamp, css, emu, LIMITS } from './common.js';

const ANGLE = 60000;
const toRad = (value) => ((Number(value) || 0) / ANGLE) * (Math.PI / 180);

/* ── the theme ──────────────────────────────────────────────────────── */

/** What a part with no theme of its own falls back on: Office's defaults. */
const OFFICE_COLORS = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
  accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};

/**
 * @param {any} zip
 * @param {string|null} part  e.g. 'ppt/theme/theme1.xml'
 */
export function readTheme(zip, part) {
  const theme = { colors: { ...OFFICE_COLORS }, major: 'Calibri Light', minor: 'Calibri', fills: [], lines: [], effects: [], bgFills: [] };
  if (!part || !zip.has(part)) return theme;
  const root = parseXml(zip.text(part));
  const elements_ = element(root, 'themeElements');
  const scheme = element(elements_, 'clrScheme');
  for (const slot of elements(scheme)) {
    const name = localName(slot.name);
    const value = elements(slot)[0];
    if (!value) continue;
    const kind = localName(value.name);
    if (kind === 'srgbClr') theme.colors[name] = String(attr(value, 'val') || '000000');
    else if (kind === 'sysClr') theme.colors[name] = String(attr(value, 'lastClr') || (attr(value, 'val') === 'window' ? 'FFFFFF' : '000000'));
  }
  const fonts = element(elements_, 'fontScheme');
  const major = attr(element(element(fonts, 'majorFont'), 'latin'), 'typeface');
  const minor = attr(element(element(fonts, 'minorFont'), 'latin'), 'typeface');
  if (major) theme.major = String(major);
  if (minor) theme.minor = String(minor);
  const format = element(elements_, 'fmtScheme');
  theme.fills = elements(element(format, 'fillStyleLst'));
  theme.lines = elements(element(format, 'lnStyleLst'));
  theme.effects = elements(element(format, 'effectStyleLst'));
  theme.bgFills = elements(element(format, 'bgFillStyleLst'));
  return theme;
}

/** A typeface as the file spells it: `+mj-lt` means the theme's heading font. */
export function themeFont(name, theme) {
  const value = String(name || '');
  if (/^\+mj/i.test(value)) return theme.major;
  if (/^\+mn/i.test(value)) return theme.minor;
  return value;
}

/* ── colours ────────────────────────────────────────────────────────── */

const PRESET_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', lime: '00FF00', blue: '0000FF', yellow: 'FFFF00', cyan: '00FFFF', magenta: 'FF00FF',
  gray: '808080', grey: '808080', silver: 'C0C0C0', maroon: '800000', navy: '000080', olive: '808000', orange: 'FFA500', pink: 'FFC0CB', purple: '800080',
  teal: '008080', brown: 'A52A2A', gold: 'FFD700', lightGray: 'D3D3D3', darkGray: 'A9A9A9', dkGray: 'A9A9A9', ltGray: 'D3D3D3', darkBlue: '00008B', lightBlue: 'ADD8E6',
};

const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'hslClr', 'scrgbClr']);

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(-6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => rgb.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * clamp(v, 0, 1) ** (1 / 2.4) - 0.055);

/** @param {number[]} rgb */
function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h / 6, s, l];
}

/** @param {number[]} hsl */
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** A theme slot through the part's colour map: `tx1` usually means `dk1`, but a dark layout flips it. */
function schemeSlot(value, env) {
  const name = String(value || '');
  if (name === 'phClr') return env.phClr || null;
  const mapped = env.clrMap?.[name] || { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }[name] || name;
  const hex = env.theme?.colors?.[mapped];
  return hex ? { hex, alpha: 1 } : null;
}

/**
 * The colour a colour element means, every modifier applied in order.
 *
 * @param {any} node  an `a:srgbClr`, `a:schemeClr` and so on
 * @param {any} env
 * @returns {{ hex: string, alpha: number }|null}
 */
function colorValue(node, env) {
  const kind = localName(node.name);
  let base;
  if (kind === 'srgbClr') base = { hex: String(attr(node, 'val') || '000000'), alpha: 1 };
  else if (kind === 'schemeClr') base = schemeSlot(attr(node, 'val'), env);
  else if (kind === 'sysClr') base = { hex: String(attr(node, 'lastClr') || (attr(node, 'val') === 'window' ? 'FFFFFF' : '000000')), alpha: 1 };
  else if (kind === 'prstClr') base = { hex: PRESET_COLORS[String(attr(node, 'val'))] || '000000', alpha: 1 };
  else if (kind === 'hslClr') {
    const rgb = hslToRgb([(Number(attr(node, 'hue')) || 0) / 21600000, (Number(attr(node, 'sat')) || 0) / 100000, (Number(attr(node, 'lum')) || 0) / 100000]);
    base = { hex: toHex(rgb), alpha: 1 };
  } else if (kind === 'scrgbClr') {
    base = { hex: toHex(['r', 'g', 'b'].map((c) => fromLinear((Number(attr(node, c)) || 0) / 100000))), alpha: 1 };
  }
  if (!base) return null;
  /** @type {any} */
  let rgb = hexToRgb(base.hex);
  let { alpha } = base;
  for (const mod of elements(node)) {
    const name = localName(mod.name);
    const value = (Number(attr(mod, 'val')) || 0) / 100000;
    switch (name) {
      case 'alpha': alpha = value; break;
      case 'alphaMod': alpha *= value; break;
      case 'alphaOff': alpha += value; break;
      case 'lumMod': { const h = rgbToHsl(rgb); h[2] = clamp(h[2] * value, 0, 1); rgb = hslToRgb(h); break; }
      case 'lumOff': { const h = rgbToHsl(rgb); h[2] = clamp(h[2] + value, 0, 1); rgb = hslToRgb(h); break; }
      case 'satMod': { const h = rgbToHsl(rgb); h[1] = clamp(h[1] * value, 0, 1); rgb = hslToRgb(h); break; }
      case 'satOff': { const h = rgbToHsl(rgb); h[1] = clamp(h[1] + value, 0, 1); rgb = hslToRgb(h); break; }
      case 'hueMod': { const h = rgbToHsl(rgb); h[0] = (h[0] * value) % 1; rgb = hslToRgb(h); break; }
      case 'hueOff': { const h = rgbToHsl(rgb); h[0] = (h[0] + ((Number(attr(mod, 'val')) || 0) / 21600000) + 1) % 1; rgb = hslToRgb(h); break; }
      // Both of these work in linear light, which is what makes PowerPoint's
      // "shade" darker than the same percentage of lumMod.
      case 'shade': rgb = rgb.map((c) => fromLinear(toLinear(c) * value)); break;
      case 'tint': rgb = rgb.map((c) => fromLinear(toLinear(c) * value + (1 - value))); break;
      case 'comp': { const h = rgbToHsl(rgb); h[0] = (h[0] + 0.5) % 1; rgb = hslToRgb(h); break; }
      case 'inv': rgb = rgb.map((c) => 255 - c); break;
      case 'gray': { const g = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; rgb = [g, g, g]; break; }
      default: break;
    }
  }
  return { hex: toHex(rgb), alpha: clamp(alpha, 0, 1) };
}

/** The colour inside an element such as `a:solidFill` or `a:gs`. */
export function colorIn(parent, env) {
  for (const child of elements(parent)) {
    if (COLOR_TAGS.has(localName(child.name))) return colorValue(child, env);
  }
  return null;
}

/** Same, as a canvas string. */
export function cssIn(parent, env) {
  const value = colorIn(parent, env);
  return value ? css(value.hex, value.alpha) : null;
}

/* ── fills ──────────────────────────────────────────────────────────── */

/**
 * @typedef {{ type: 'solid', color: string }
 *   | { type: 'grad', stops: [number, string][], angle: number, path: string|null, center: number[] }
 *   | { type: 'blip', part: string|null, reason: string|null, crop: number[]|null, alpha: number, inset: number[]|null, tile: boolean }
 *   | { type: 'none' }} Fill
 */

/** How a pattern looks from a distance: its share of foreground. */
const PATTERN_SHARE = { pct5: 0.05, pct10: 0.1, pct20: 0.2, pct25: 0.25, pct30: 0.3, pct40: 0.4, pct50: 0.5, pct60: 0.6, pct70: 0.7, pct75: 0.75, pct80: 0.8, pct90: 0.9 };

function mixHex(a, b, share) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return toHex(A.map((c, i) => c * share + B[i] * (1 - share)));
}

/**
 * The fill written directly in an element, or undefined when it says nothing:
 * a shape with no fill element inherits one, and `a:noFill` says none.
 *
 * @param {any} parent
 * @param {any} env
 * @returns {Fill|undefined}
 */
export function fillIn(parent, env) {
  for (const child of elements(parent)) {
    const name = localName(child.name);
    if (name === 'noFill') return { type: 'none' };
    if (name === 'solidFill') {
      const color = cssIn(child, env);
      return color ? { type: 'solid', color } : { type: 'none' };
    }
    if (name === 'gradFill') return /** @type {any} */ (gradient(child, env));
    if (name === 'pattFill') {
      const fg = colorIn(element(child, 'fgClr'), env) || { hex: '000000', alpha: 1 };
      const bg = colorIn(element(child, 'bgClr'), env) || { hex: 'FFFFFF', alpha: 1 };
      return { type: 'solid', color: css(mixHex(fg.hex, bg.hex, PATTERN_SHARE[String(attr(child, 'prst'))] ?? 0.5)) };
    }
    if (name === 'blipFill') return /** @type {any} */ (blip(child, env));
    if (name === 'grpFill') return env.groupFill || { type: 'none' };
  }
  return undefined;
}

function gradient(node, env) {
  const stops = elements(element(node, 'gsLst'), 'gs')
    .map((gs) => /** @type {[number, string]} */ ([(Number(attr(gs, 'pos')) || 0) / 100000, cssIn(gs, env) || '#000000']))
    .sort((a, b) => a[0] - b[0]);
  const path = element(node, 'path');
  const rect = element(path, 'fillToRect');
  const pct = (name, fallback) => (rect ? (Number(attr(rect, name)) || 0) / 100000 : fallback);
  return {
    type: 'grad',
    stops: stops.length ? stops : [[0, '#FFFFFF'], [1, '#FFFFFF']],
    angle: toRad(attr(element(node, 'lin'), 'ang')),
    path: path ? String(attr(path, 'path') || 'circle') : null,
    center: [pct('l', 0.5), pct('t', 0.5), 1 - pct('r', 0.5), 1 - pct('b', 0.5)],
  };
}

/** A picture fill: which part, how cropped. Never a URL: an external picture is a note. */
function blip(node, env) {
  const inner = element(node, 'blip');
  const embed = inner?.attrs?.['r:embed'] ?? attr(inner, 'embed');
  const link = inner?.attrs?.['r:link'] ?? attr(inner, 'link');
  const rel = env.rels?.get(String(embed || link || ''));
  let part = null;
  let reason = null;
  if (!rel || rel.mode === 'External') {
    if (rel || link) {
      reason = 'external';
      env.note?.('A picture in this file lives at an outside address, which is never fetched; it appears as a labelled box.');
    } else reason = 'missing';
  } else {
    const target = resolveTarget(env.part, rel.target);
    if (!env.zip.has(target)) reason = 'missing';
    else if (DRAWABLE_PICTURE.test(target)) part = target;
    else reason = target.split('.').pop().toUpperCase();
  }
  const crop = element(node, 'srcRect');
  const edge = (name) => (crop ? (Number(attr(crop, name)) || 0) / 100000 : 0);
  const stretch = element(element(node, 'stretch'), 'fillRect');
  const fix = element(inner, 'alphaModFix');
  return {
    type: 'blip',
    part,
    reason,
    crop: crop ? [edge('l'), edge('t'), edge('r'), edge('b')] : null,
    alpha: fix ? (Number(attr(fix, 'amt')) || 100000) / 100000 : 1,
    inset: stretch ? ['l', 't', 'r', 'b'].map((name) => (Number(attr(stretch, name)) || 0) / 100000) : null,
    tile: !!element(node, 'tile'),
  };
}

/** A fill as what the canvas paints a shape with, over the shape's own box. */
export function paintFor(fill, x, y, w, h) {
  if (!fill || fill.type === 'none' || fill.type === 'blip') return null;
  if (fill.type === 'solid') return fill.color;
  if (fill.path) {
    const [l, t, r, b] = fill.center;
    const cx = x + w * (l + (1 - r - l) / 2);
    const cy = y + h * (t + (1 - b - t) / 2);
    const far = Math.max(Math.hypot(cx - x, cy - y), Math.hypot(x + w - cx, y + h - cy), Math.hypot(x + w - cx, cy - y), Math.hypot(cx - x, y + h - cy));
    return { kind: 'radial', cx, cy, r: far, stops: fill.stops };
  }
  // The same arithmetic as CSS: the gradient line is long enough to reach both corners.
  const dx = Math.cos(fill.angle);
  const dy = Math.sin(fill.angle);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return { kind: 'linear', x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half, stops: fill.stops };
}

/* ── lines ──────────────────────────────────────────────────────────── */

const DASHES = {
  dash: [4, 3], sysDash: [3, 1], lgDash: [8, 3], dot: [1, 3], sysDot: [1, 1],
  dashDot: [4, 3, 1, 3], sysDashDot: [3, 1, 1, 1], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3], sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

/**
 * @typedef {{ color: string, width: number, dash: number[]|null, cap: string, join: string, head: string|null, tail: string|null }} Stroke
 */

/**
 * The outline an `a:ln` describes. Undefined when it says nothing about colour, so a
 * `w` on its own keeps the colour a style gave.
 *
 * @param {any} ln
 * @param {any} env
 * @param {Stroke|null} [base]
 * @returns {Stroke|null}
 */
export function strokeFrom(ln, env, base = null) {
  if (!ln) return base;
  const fill = fillIn(ln, env);
  if (fill?.type === 'none') return null;
  const color = fill?.type === 'solid' ? fill.color : fill?.type === 'grad' ? fill.stops[0][1] : base?.color;
  if (!color) return null;
  const given = attr(ln, 'w');
  const width = given !== undefined ? emu(given) : base?.width ?? 0.75;
  const preset = attr(element(ln, 'prstDash'), 'val');
  const dash = preset !== undefined ? (DASHES[String(preset)] || null) : base?.dash || null;
  const cap = attr(ln, 'cap');
  const head = attr(element(ln, 'headEnd'), 'type');
  const tail = attr(element(ln, 'tailEnd'), 'type');
  return {
    color,
    width,
    dash: dash ? dash.map((d) => d * Math.max(width, 0.5)) : null,
    cap: cap === 'rnd' ? 'round' : cap === 'sq' ? 'square' : base?.cap || 'butt',
    join: element(ln, 'bevel') ? 'bevel' : element(ln, 'miter') ? 'miter' : base?.join || 'round',
    head: head && head !== 'none' ? String(head) : base?.head || null,
    tail: tail && tail !== 'none' ? String(tail) : base?.tail || null,
  };
}

/* ── geometry ───────────────────────────────────────────────────────── */

const K = 0.5522847;

/** A rounded corner path: `corners` is the radius of top-left, top-right, bottom-right, bottom-left. */
function roundedPath(w, h, [a, b, c, d]) {
  const p = [['M', a, 0], ['L', w - b, 0]];
  if (b) p.push(['C', w - b + b * K, 0, w, b - b * K, w, b]);
  p.push(['L', w, h - c]);
  if (c) p.push(['C', w, h - c + c * K, w - c + c * K, h, w - c, h]);
  p.push(['L', d, h]);
  if (d) p.push(['C', d - d * K, h, 0, h - d + d * K, 0, h - d]);
  p.push(['L', 0, a]);
  if (a) p.push(['C', 0, a - a * K, a - a * K, 0, a, 0]);
  p.push(['Z']);
  return p;
}

const poly = (points) => [['M', points[0][0], points[0][1]], ...points.slice(1).map(([x, y]) => ['L', x, y]), ['Z']];

function regular(w, h, sides) {
  const points = [];
  for (let i = 0; i < sides; i += 1) {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    points.push([w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)]);
  }
  return poly(points);
}

function star(w, h, points, inner) {
  const out = [];
  for (let i = 0; i < points * 2; i += 1) {
    const t = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? inner : 1;
    out.push([w / 2 + (w / 2) * r * Math.cos(t), h / 2 + (h / 2) * r * Math.sin(t)]);
  }
  return poly(out);
}

/** An arrow pointing right, in a box `len` by `span`, mapped by `at` for the other three directions. */
function arrow(len, span, shaft, head, at) {
  const y1 = span / 2 - shaft / 2;
  const y2 = span / 2 + shaft / 2;
  const x = len - head;
  return poly([[0, y1], [x, y1], [x, 0], [len, span / 2], [x, span], [x, y2], [0, y2]].map(([a, b]) => at(a, b)));
}

/**
 * A preset shape's outline, in its own box. Each is the spec's formula, as far as a
 * model looking at a picture can tell: shapes named here are recognisably what they
 * are, and anything else is a rectangle with a note, rather than nothing at all.
 *
 * @param {string} name
 * @param {number} w
 * @param {number} h
 * @param {Record<string, number>} av  the shape's adjustments
 * @returns {{ path: any[], rule?: string, open?: boolean, known: boolean }}
 */
export function presetPath(name, w, h, av = {}) {
  const ss = Math.min(w, h);
  const a = (key, fallback) => (av[key] ?? fallback);
  const pct = (key, fallback) => (a(key, fallback) / 100000) * ss;
  const known = (path, extra = {}) => ({ path, known: true, ...extra });
  switch (name) {
    case 'rect':
    case 'flowChartProcess':
    case 'flowChartInternalStorage':
    case 'textBox':
      return known(poly([[0, 0], [w, 0], [w, h], [0, h]]));
    case 'roundRect':
    case 'flowChartAlternateProcess': {
      const r = Math.min(pct('adj', 16667), ss / 2);
      return known(roundedPath(w, h, [r, r, r, r]));
    }
    case 'round1Rect': { const r = pct('adj', 16667); return known(roundedPath(w, h, [0, r, 0, 0])); }
    case 'round2SameRect': { const r = pct('adj1', 16667); const s = pct('adj2', 0); return known(roundedPath(w, h, [r, r, s, s])); }
    case 'round2DiagRect': { const r = pct('adj1', 16667); const s = pct('adj2', 0); return known(roundedPath(w, h, [r, s, r, s])); }
    case 'plaque': { const r = pct('adj', 16667); return known(roundedPath(w, h, [r, r, r, r])); }
    case 'snip1Rect': { const c = pct('adj', 16667); return known(poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]])); }
    case 'snip2SameRect': { const c = pct('adj1', 16667); const d = pct('adj2', 0); return known(poly([[c, 0], [w - c, 0], [w, c], [w, h - d], [w - d, h], [d, h], [0, h - d], [0, c]])); }
    case 'snip2DiagRect': { const c = pct('adj1', 0); const d = pct('adj2', 16667); return known(poly([[c, 0], [w - d, 0], [w, d], [w, h - c], [w - c, h], [d, h], [0, h - d], [0, c]])); }
    case 'snipRoundRect': { const r = pct('adj1', 16667); const c = pct('adj2', 16667); return known(poly([[r, 0], [w - c, 0], [w, c], [w, h], [0, h], [0, r]])); }
    case 'ellipse':
    case 'flowChartConnector':
      return known([['E', w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2], ['Z']]);
    case 'line':
    case 'straightConnector1':
      return known([['M', 0, 0], ['L', w, h]], { open: true });
    case 'bentConnector2':
      return known([['M', 0, 0], ['L', w, 0], ['L', w, h]], { open: true });
    case 'bentConnector3': { const x = (a('adj1', 50000) / 100000) * w; return known([['M', 0, 0], ['L', x, 0], ['L', x, h], ['L', w, h]], { open: true }); }
    case 'curvedConnector2':
      return known([['M', 0, 0], ['C', w / 2, 0, w, h / 2, w, h]], { open: true });
    case 'curvedConnector3': { const x = (a('adj1', 50000) / 100000) * w; return known([['M', 0, 0], ['C', x / 2, 0, x, h / 4, x, h / 2], ['C', x, (3 * h) / 4, (x + w) / 2, h, w, h]], { open: true }); }
    case 'triangle':
    case 'flowChartExtract': { const x = (a('adj', 50000) / 100000) * w; return known(poly([[0, h], [x, 0], [w, h]])); }
    case 'flowChartMerge': return known(poly([[0, 0], [w, 0], [w / 2, h]]));
    case 'rtTriangle': return known(poly([[0, h], [0, 0], [w, h]]));
    case 'diamond':
    case 'flowChartDecision': return known(poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]));
    case 'parallelogram':
    case 'flowChartInputOutput': { const x = pct('adj', name === 'parallelogram' ? 25000 : 20000); return known(poly([[0, h], [x, 0], [w, 0], [w - x, h]])); }
    case 'trapezoid': { const x = pct('adj', 25000); return known(poly([[0, h], [x, 0], [w - x, 0], [w, h]])); }
    case 'flowChartManualOperation': return known(poly([[0, 0], [w, 0], [w * 0.8, h], [w * 0.2, h]]));
    case 'pentagon': return known(poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]]));
    case 'hexagon':
    case 'flowChartPreparation': { const x = pct('adj', 25000); return known(poly([[0, h / 2], [x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h]])); }
    case 'octagon': { const x = pct('adj', 29289); return known(poly([[0, x], [x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x]])); }
    case 'heptagon': return known(regular(w, h, 7));
    case 'decagon': return known(regular(w, h, 10));
    case 'dodecagon': return known(regular(w, h, 12));
    case 'homePlate':
    case 'flowChartOffpageConnector': {
      if (name !== 'homePlate') return known(poly([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]));
      const x = w - pct('adj', 50000);
      return known(poly([[0, 0], [x, 0], [w, h / 2], [x, h], [0, h]]));
    }
    case 'chevron': { const c = pct('adj', 50000); return known(poly([[0, 0], [w - c, 0], [w, h / 2], [w - c, h], [0, h], [c, h / 2]])); }
    case 'rightArrow': return known(arrow(w, h, (a('adj1', 50000) / 100000) * h, pct('adj2', 50000), (x, y) => [x, y]));
    case 'leftArrow': return known(arrow(w, h, (a('adj1', 50000) / 100000) * h, pct('adj2', 50000), (x, y) => [w - x, y]));
    case 'downArrow': return known(arrow(h, w, (a('adj1', 50000) / 100000) * w, pct('adj2', 50000), (x, y) => [y, x]));
    case 'upArrow': return known(arrow(h, w, (a('adj1', 50000) / 100000) * w, pct('adj2', 50000), (x, y) => [y, h - x]));
    case 'leftRightArrow': {
      const dy = ((a('adj1', 50000) / 100000) * h) / 2;
      const x = pct('adj2', 50000);
      return known(poly([[0, h / 2], [x, 0], [x, h / 2 - dy], [w - x, h / 2 - dy], [w - x, 0], [w, h / 2], [w - x, h], [w - x, h / 2 + dy], [x, h / 2 + dy], [x, h]]));
    }
    case 'upDownArrow': {
      const dx = ((a('adj1', 50000) / 100000) * w) / 2;
      const y = pct('adj2', 50000);
      return known(poly([[w / 2, 0], [w, y], [w / 2 + dx, y], [w / 2 + dx, h - y], [w, h - y], [w / 2, h], [0, h - y], [w / 2 - dx, h - y], [w / 2 - dx, y], [0, y]]));
    }
    case 'notchedRightArrow': {
      const dy = ((a('adj1', 50000) / 100000) * h) / 2;
      const x = w - pct('adj2', 50000);
      return known(poly([[0, h / 2 - dy], [x, h / 2 - dy], [x, 0], [w, h / 2], [x, h], [x, h / 2 + dy], [0, h / 2 + dy], [dy, h / 2]]));
    }
    case 'plus':
    case 'flowChartSummingJunction': { const x = pct('adj', 25000); return known(poly([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]])); }
    case 'star4': return known(star(w, h, 4, a('adj', 12500) / 50000));
    case 'star5': return known(star(w, h, 5, a('adj', 19098) / 50000));
    case 'star6': return known(star(w, h, 6, a('adj', 28868) / 50000));
    case 'star7': return known(star(w, h, 7, a('adj', 34601) / 50000));
    case 'star8': return known(star(w, h, 8, a('adj', 37500) / 50000));
    case 'star10': return known(star(w, h, 10, a('adj', 42533) / 50000));
    case 'star12': return known(star(w, h, 12, a('adj', 37500) / 50000));
    case 'star16': return known(star(w, h, 16, a('adj', 37500) / 50000));
    case 'star24': return known(star(w, h, 24, a('adj', 37500) / 50000));
    case 'donut': {
      const t = pct('adj', 25000);
      return known([['E', w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2], ['Z'], ['E', w / 2, h / 2, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t), 0, Math.PI * 2], ['Z']], { rule: 'evenodd' });
    }
    case 'frame': {
      const t = pct('adj1', 12500);
      return known([['M', 0, 0], ['L', w, 0], ['L', w, h], ['L', 0, h], ['Z'], ['M', t, t], ['L', w - t, t], ['L', w - t, h - t], ['L', t, h - t], ['Z']], { rule: 'evenodd' });
    }
    case 'halfFrame': { const t = pct('adj1', 33333); const u = pct('adj2', 33333); return known(poly([[0, 0], [w, 0], [w - t, u], [u, u], [u, h - t], [0, h]])); }
    case 'corner': { const t = pct('adj1', 50000); const u = pct('adj2', 50000); return known(poly([[0, 0], [u, 0], [u, h - t], [w, h - t], [w, h], [0, h]])); }
    case 'pie': {
      const start = toRad(a('adj1', 0));
      const end = toRad(a('adj2', 16200000));
      return known([['M', w / 2, h / 2], ['E', w / 2, h / 2, w / 2, h / 2, start, end <= start ? end + Math.PI * 2 : end], ['Z']]);
    }
    case 'chord': {
      const start = toRad(a('adj1', 2700000));
      const end = toRad(a('adj2', 16200000));
      return known([['E', w / 2, h / 2, w / 2, h / 2, start, end <= start ? end + Math.PI * 2 : end], ['Z']]);
    }
    case 'arc': {
      const start = toRad(a('adj1', 16200000));
      const end = toRad(a('adj2', 0));
      return known([['E', w / 2, h / 2, w / 2, h / 2, start, end <= start ? end + Math.PI * 2 : end]], { open: true });
    }
    case 'blockArc': {
      const start = toRad(a('adj1', 10800000));
      const end = toRad(a('adj2', 0));
      const t = pct('adj3', 25000);
      const to = end <= start ? end + Math.PI * 2 : end;
      return known([['E', w / 2, h / 2, w / 2, h / 2, start, to], ['E', w / 2, h / 2, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t), to, start, true], ['Z']]);
    }
    case 'teardrop':
      return known([['M', 0, h / 2], ['C', 0, h / 2 - (h / 2) * K, w / 2 - (w / 2) * K, 0, w / 2, 0], ['L', w, 0], ['L', w, h / 2], ['C', w, h / 2 + (h / 2) * K, w / 2 + (w / 2) * K, h, w / 2, h], ['C', w / 2 - (w / 2) * K, h, 0, h / 2 + (h / 2) * K, 0, h / 2], ['Z']]);
    case 'wedgeRectCallout':
    case 'wedgeRoundRectCallout':
    case 'wedgeEllipseCallout': {
      const tx = w / 2 + (a('adj1', -20833) / 100000) * w;
      const ty = h / 2 + (a('adj2', 62500) / 100000) * h;
      const body = name === 'wedgeEllipseCallout'
        ? [['E', w / 2, h / 2, w / 2, h / 2, 0, Math.PI * 2], ['Z']]
        : name === 'wedgeRoundRectCallout'
          ? roundedPath(w, h, [ss / 6, ss / 6, ss / 6, ss / 6])
          : poly([[0, 0], [w, 0], [w, h], [0, h]]);
      const side = Math.abs(ty - h / 2) / h > Math.abs(tx - w / 2) / w;
      const tail = side
        ? poly([[w * 0.35, h / 2], [w * 0.55, h / 2], [tx, ty]])
        : poly([[w / 2, h * 0.35], [w / 2, h * 0.65], [tx, ty]]);
      return known([...body, ...tail]);
    }
    case 'cloud':
    case 'cloudCallout':
      return known([
        ['E', w * 0.5, h * 0.3, w * 0.28, h * 0.3, 0, Math.PI * 2], ['Z'], ['E', w * 0.25, h * 0.5, w * 0.25, h * 0.3, 0, Math.PI * 2], ['Z'],
        ['E', w * 0.75, h * 0.5, w * 0.25, h * 0.3, 0, Math.PI * 2], ['Z'], ['E', w * 0.5, h * 0.72, w * 0.32, h * 0.28, 0, Math.PI * 2], ['Z'],
      ]);
    case 'heart':
      return known([['M', w / 2, h * 0.25], ['C', w * 0.5, 0, w * 0.05, -h * 0.05, 0, h * 0.3], ['C', -w * 0.03, h * 0.6, w * 0.35, h * 0.8, w / 2, h], ['C', w * 0.65, h * 0.8, w * 1.03, h * 0.6, w, h * 0.3], ['C', w * 0.95, -h * 0.05, w * 0.5, 0, w / 2, h * 0.25], ['Z']]);
    case 'lightningBolt':
      return known(poly([[w * 0.39, 0], [w * 0.62, h * 0.27], [w * 0.52, h * 0.31], [w * 0.8, h * 0.56], [w * 0.68, h * 0.62], [w, h], [w * 0.43, h * 0.7], [w * 0.54, h * 0.64], [w * 0.14, h * 0.42], [w * 0.28, h * 0.34], [0, h * 0.18]]));
    case 'sun': return known([...star(w, h, 8, 0.72)]);
    case 'moon': return known([['M', w, 0], ['C', w * 0.35, 0, 0, h * 0.22, 0, h / 2], ['C', 0, h * 0.78, w * 0.35, h, w, h], ['C', w * 0.55, h * 0.78, w * 0.5, h * 0.62, w * 0.5, h / 2], ['C', w * 0.5, h * 0.38, w * 0.55, h * 0.22, w, 0], ['Z']]);
    case 'can':
    case 'flowChartMagneticDisk': {
      const r = pct('adj', 25000) / 2;
      return known([['M', 0, r], ['C', 0, -r / 3, w, -r / 3, w, r], ['L', w, h - r], ['C', w, h + r / 3, 0, h + r / 3, 0, h - r], ['Z'], ['M', 0, r], ['C', 0, 2.33 * r, w, 2.33 * r, w, r]]);
    }
    case 'cube': { const d = pct('adj', 25000); return known(poly([[0, d], [d, 0], [w, 0], [w, h - d], [w - d, h], [0, h]])); }
    case 'bevel': return known(poly([[0, 0], [w, 0], [w, h], [0, h]]));
    case 'foldedCorner': { const c = pct('adj', 16667); return known(poly([[0, 0], [w, 0], [w, h - c], [w - c, h], [0, h]])); }
    case 'flowChartTerminator': { const r = Math.min(w, h) / 2; return known(roundedPath(w, h, [r, r, r, r])); }
    case 'flowChartDocument':
      return known([['M', 0, 0], ['L', w, 0], ['L', w, h * 0.83], ['C', w * 0.7, h * 0.7, w * 0.4, h * 1.08, 0, h * 0.9], ['Z']]);
    case 'flowChartPredefinedProcess':
      return known([...poly([[0, 0], [w, 0], [w, h], [0, h]]), ['M', w / 8, 0], ['L', w / 8, h], ['M', w - w / 8, 0], ['L', w - w / 8, h]]);
    case 'bracketPair':
    case 'leftBracket':
    case 'rightBracket': {
      const r = pct('adj', 8333);
      const left = [['M', r, 0], ['Q', 0, 0, 0, r], ['L', 0, h - r], ['Q', 0, h, r, h]];
      const right = [['M', w - r, 0], ['Q', w, 0, w, r], ['L', w, h - r], ['Q', w, h, w - r, h]];
      return known(name === 'leftBracket' ? left : name === 'rightBracket' ? right : [...left, ...right], { open: true });
    }
    case 'leftBrace':
    case 'rightBrace':
    case 'bracePair': {
      const left = [['M', w * 0.5, 0], ['Q', 0, 0, w * 0.25, h * 0.25], ['Q', w * 0.25, h * 0.5, 0, h * 0.5], ['Q', w * 0.25, h * 0.5, w * 0.25, h * 0.75], ['Q', 0, h, w * 0.5, h]];
      const right = [['M', w * 0.5, 0], ['Q', w, 0, w * 0.75, h * 0.25], ['Q', w * 0.75, h * 0.5, w, h * 0.5], ['Q', w * 0.75, h * 0.5, w * 0.75, h * 0.75], ['Q', w, h, w * 0.5, h]];
      return known(name === 'leftBrace' ? left : name === 'rightBrace' ? right : [...left, ...right], { open: true });
    }
    default:
      return { path: poly([[0, 0], [w, 0], [w, h], [0, h]]), known: false };
  }
}

/**
 * Where a shape's words go: a box inside its outline, as the spec gives for each.
 *
 * @returns {[number, number, number, number]} left, top, right, bottom insets in its own box
 */
export function textInsets(name, w, h, av = {}) {
  const ss = Math.min(w, h);
  switch (name) {
    case 'ellipse':
    case 'flowChartConnector':
    case 'wedgeEllipseCallout':
      return [w * 0.1464, h * 0.1464, w * 0.1464, h * 0.1464];
    case 'roundRect':
    case 'wedgeRoundRectCallout': {
      const r = ((av.adj ?? 16667) / 100000) * ss;
      return [r * 0.29, r * 0.29, r * 0.29, r * 0.29];
    }
    case 'diamond':
    case 'flowChartDecision':
      return [w / 4, h / 4, w / 4, h / 4];
    case 'triangle':
      return [w / 4, h / 2, w / 4, 0];
    case 'chevron':
    case 'homePlate':
      return [name === 'chevron' ? Math.min(w / 2, ((av.adj ?? 50000) / 100000) * ss) : 0, 0, Math.min(w / 2, (((av.adj ?? 50000) / 100000) * ss) / 2), 0];
    case 'hexagon':
      return [ss * 0.15, ss * 0.1, ss * 0.15, ss * 0.1];
    default:
      return [0, 0, 0, 0];
  }
}

/** A custom outline: the points are in the path's own units, scaled to the shape's box. */
function customPath(geometry, w, h, budget) {
  const out = [];
  const list = elements(element(geometry, 'pathLst'), 'path');
  for (const path of list) {
    const pw = Number(attr(path, 'w')) || 0;
    const ph = Number(attr(path, 'h')) || 0;
    const sx = pw ? w / pw : 1 / 12700;
    const sy = ph ? h / ph : 1 / 12700;
    let last = [0, 0];
    const pt = (node) => [(Number(attr(node, 'x')) || 0) * sx, (Number(attr(node, 'y')) || 0) * sy];
    for (const step of elements(path)) {
      budget?.check();
      const name = localName(step.name);
      const pts = elements(step, 'pt').map(pt);
      if (name === 'moveTo' && pts[0]) { out.push(['M', ...pts[0]]); [last] = pts; }
      else if (name === 'lnTo' && pts[0]) { out.push(['L', ...pts[0]]); [last] = pts; }
      else if (name === 'cubicBezTo' && pts.length === 3) { out.push(['C', ...pts[0], ...pts[1], ...pts[2]]); last = pts[2]; }
      else if (name === 'quadBezTo' && pts.length === 2) { out.push(['Q', ...pts[0], ...pts[1]]); last = pts[1]; }
      else if (name === 'close') out.push(['Z']);
      else if (name === 'arcTo') {
        const rx = (Number(attr(step, 'wR')) || 0) * sx;
        const ry = (Number(attr(step, 'hR')) || 0) * sy;
        const start = toRad(attr(step, 'stAng'));
        const sweep = toRad(attr(step, 'swAng'));
        const cx = last[0] - rx * Math.cos(start);
        const cy = last[1] - ry * Math.sin(start);
        out.push(['E', cx, cy, rx, ry, start, start + sweep, sweep < 0]);
        last = [cx + rx * Math.cos(start + sweep), cy + ry * Math.sin(start + sweep)];
      }
    }
  }
  return out;
}

/** Move a path into place. */
function offset(path, dx, dy) {
  return path.map((c) => {
    switch (c[0]) {
      case 'M':
      case 'L': return [c[0], c[1] + dx, c[2] + dy];
      case 'C': return ['C', c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy];
      case 'Q': return ['Q', c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy];
      case 'E': return ['E', c[1] + dx, c[2] + dy, c[3], c[4], c[5], c[6], c[7]];
      default: return c;
    }
  });
}

/** The adjustments on a preset: `<a:gd name="adj" fmla="val 16667"/>`. */
function adjustments(geometry) {
  const out = {};
  for (const gd of elements(element(geometry, 'avLst'), 'gd')) {
    const match = /^val\s+(-?\d+)/.exec(String(attr(gd, 'fmla') || ''));
    if (match) out[String(attr(gd, 'name'))] = Number(match[1]);
  }
  return out;
}

/** An arrow head at the end of a line: a small filled shape pointing along it. */
function arrowHead(surface, kind, x, y, angle, stroke) {
  const size = Math.max(stroke.width * 3.5, 3.5);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (a, b) => [x + a * cos - b * sin, y + a * sin + b * cos];
  if (kind === 'oval') {
    surface.path([['E', x, y, size / 2, size / 2, 0, Math.PI * 2], ['Z']], { fill: stroke.color });
    return;
  }
  const points = kind === 'diamond'
    ? [at(0, -size / 2), at(size / 2, 0), at(0, size / 2), at(-size / 2, 0)]
    : [at(0, 0), at(-size, -size / 2), at(-size, size / 2)];
  surface.path(poly(points), { fill: stroke.color });
}

/** The two ends of an open path and the way it travels at each. */
function endsOf(path) {
  const points = [];
  for (const c of path) {
    if (c[0] === 'M' || c[0] === 'L') points.push([c[1], c[2]]);
    else if (c[0] === 'C') points.push([c[1], c[2]], [c[3], c[4]], [c[5], c[6]]);
    else if (c[0] === 'Q') points.push([c[1], c[2]], [c[3], c[4]]);
  }
  if (points.length < 2) return null;
  const [p0, p1] = points;
  const pz = points[points.length - 1];
  const py = points[points.length - 2];
  return { start: p0, startAngle: Math.atan2(p0[1] - p1[1], p0[0] - p1[0]), end: pz, endAngle: Math.atan2(pz[1] - py[1], pz[0] - py[0]) };
}

/* ── painting a shape ───────────────────────────────────────────────── */

/** A box where a thing cannot be drawn: the model sees where it was and what it was. */
export function labelledBox(surface, x, y, w, h, label, env) {
  surface.rect(x, y, w, h, '#EEF0F3');
  surface.path(poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), { stroke: '#9AA3AD', width: 0.75, dash: [3, 2] });
  const size = clamp(Math.min(w, h) * 0.12, 7, 13);
  const pick = env.fonts.pick('Arial');
  const text = String(label || '');
  const width = env.measure.width(pick, size, text);
  surface.quiet += 1;
  surface.text(text, x + Math.max(2, (w - width) / 2), y + h / 2 + size * 0.35, { pick, size, color: '#4B5563' });
  surface.quiet -= 1;
}

/**
 * Fill and outline a path that is already in place.
 *
 * @param {import('./common.js').Surface} surface
 * @param {any[]} path
 * @param {{ fill?: Fill, stroke?: Stroke|null, x: number, y: number, w: number, h: number, shadow?: any, rule?: string, open?: boolean }} look
 * @param {any} env
 */
export function paintPath(surface, path, { fill, stroke, x, y, w, h, shadow = null, rule, open = false }, env) {
  if (fill?.type === 'blip') {
    if (fill.part) {
      surface.save();
      surface.clipPath(path);
      const [il, it, ir, ib] = fill.inset || [0, 0, 0, 0];
      surface.picture(fill.part, { x: x + w * il, y: y + h * it, w: w * (1 - il - ir), h: h * (1 - it - ib), crop: fill.crop, alpha: fill.alpha });
      surface.restore();
    } else {
      labelledBox(surface, x, y, w, h, fill.reason === 'external' ? 'Picture at an outside address' : `${fill.reason || 'Unknown'} picture`, env);
      if (fill.reason !== 'external') env.noteAt?.(`has a picture in a format that cannot be drawn here (${fill.reason || 'unknown'}); it appears as a labelled box`);
    }
  } else if (fill && !open) {
    const paint = paintFor(fill, x, y, w, h);
    if (paint) surface.path(path, { fill: paint, rule, shadow });
  }
  if (stroke) {
    surface.path(path, { stroke: stroke.color, width: stroke.width, dash: stroke.dash, cap: stroke.cap, join: stroke.join });
    if (stroke.head || stroke.tail) {
      const ends = endsOf(path);
      if (ends) {
        if (stroke.head) arrowHead(surface, stroke.head, ends.start[0], ends.start[1], ends.startAngle, stroke);
        if (stroke.tail) arrowHead(surface, stroke.tail, ends.end[0], ends.end[1], ends.endAngle, stroke);
      }
    }
  }
}

/** An `a:xfrm`, in points. */
export function readXfrm(parent) {
  const xfrm = element(parent, 'xfrm');
  if (!xfrm) return null;
  const off = element(xfrm, 'off');
  const ext = element(xfrm, 'ext');
  if (!off && !ext) return null;
  return {
    x: emu(attr(off, 'x')),
    y: emu(attr(off, 'y')),
    w: emu(attr(ext, 'cx')),
    h: emu(attr(ext, 'cy')),
    rot: toRad(attr(xfrm, 'rot')),
    flipH: isTrue(attr(xfrm, 'flipH')),
    flipV: isTrue(attr(xfrm, 'flipV')),
    chOff: element(xfrm, 'chOff'),
    chExt: element(xfrm, 'chExt'),
  };
}

const isTrue = (value) => value === '1' || value === 'true';

/** Turn the surface about the middle of a box. */
function rotateAbout(surface, rot, cx, cy) {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  surface.transform(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy);
}

/** The first fill any of these elements states, or undefined. */
function firstFill(elementsToSearch, env) {
  for (const parent of elementsToSearch) {
    if (!parent) continue;
    const fill = fillIn(parent, env);
    if (fill) return fill;
  }
  return undefined;
}

/** A style reference into the theme: fill number 2, tinted by this colour. */
function fromStyle(style, env) {
  if (!style) return {};
  const out = {};
  const fillRef = element(style, 'fillRef');
  const fillIdx = Number(attr(fillRef, 'idx')) || 0;
  if (fillIdx > 0) {
    const list = fillIdx >= 1001 ? env.theme?.bgFills : env.theme?.fills;
    const node = list?.[(fillIdx >= 1001 ? fillIdx - 1001 : fillIdx - 1)];
    const ph = colorIn(fillRef, env);
    if (node) {
      const wrap = { name: 'wrap', attrs: {}, children: [node] };
      out.fill = fillIn(wrap, { ...env, phClr: ph || env.phClr });
    }
  }
  const lnRef = element(style, 'lnRef');
  const lnIdx = Number(attr(lnRef, 'idx')) || 0;
  if (lnIdx > 0) {
    const node = env.theme?.lines?.[lnIdx - 1];
    const ph = colorIn(lnRef, env);
    if (node) out.stroke = strokeFrom(node, { ...env, phClr: ph || env.phClr });
    else if (ph) out.stroke = { color: css(ph.hex, ph.alpha), width: 0.75, dash: null, cap: 'butt', join: 'round', head: null, tail: null };
  }
  const effectIdx = Number(attr(element(style, 'effectRef'), 'idx')) || 0;
  if (effectIdx > 0) {
    const node = env.theme?.effects?.[effectIdx - 1];
    const ph = colorIn(element(style, 'effectRef'), env);
    if (node) out.shadow = shadowFrom(element(node, 'effectLst'), { ...env, phClr: ph || env.phClr });
  }
  const fontRef = element(style, 'fontRef');
  if (fontRef) {
    out.fontColor = cssIn(fontRef, env);
    out.fontIdx = attr(fontRef, 'idx');
  }
  return out;
}

/** An outer shadow, if a shape has one. Glow and reflection are decoration a model does not miss. */
function shadowFrom(effects, env) {
  const shadow = element(effects, 'outerShdw');
  if (!shadow) return null;
  const color = cssIn(shadow, env) || 'rgba(0,0,0,0.4)';
  const dist = emu(attr(shadow, 'dist'));
  const dir = toRad(attr(shadow, 'dir'));
  return { color, blur: emu(attr(shadow, 'blurRad')), dx: dist * Math.cos(dir), dy: dist * Math.sin(dir) };
}

/** How child coordinates map to this surface, once. */
const identityMap = { sx: 1, sy: 1, dx: 0, dy: 0 };

/**
 * Draw one element of a shape tree.
 *
 * @param {import('./common.js').Surface} surface
 * @param {any} node
 * @param {any} env
 * @param {{ sx: number, sy: number, dx: number, dy: number }} [map]
 * @param {number} [depth]
 */
export function drawNode(surface, node, env, map = identityMap, depth = 0) {
  env.budget?.check();
  if (depth > LIMITS.nesting) return;
  const name = localName(node.name);
  if (name === 'AlternateContent') {
    const choice = element(node, 'Choice');
    const inner = choice && elements(choice).length ? elements(choice) : elements(element(node, 'Fallback'));
    for (const child of inner) drawNode(surface, child, env, map, depth + 1);
  } else if (name === 'sp' || name === 'wsp' || name === 'cxnSp') drawShape(surface, node, env, map);
  else if (name === 'pic') drawPicture(surface, node, env, map);
  else if (name === 'grpSp' || name === 'wgp' || name === 'grpSpPr-holder') drawGroup(surface, node, env, map, depth);
  else if (name === 'graphicFrame') env.drawFrame?.(surface, node, boxOf(readXfrm(node) || readXfrm(element(node, 'grpSpPr')) || {}, map), env);
}

const boxOf = (xfrm, map) => ({
  x: (xfrm.x || 0) * map.sx + map.dx,
  y: (xfrm.y || 0) * map.sy + map.dy,
  w: (xfrm.w || 0) * map.sx,
  h: (xfrm.h || 0) * map.sy,
  rot: xfrm.rot || 0,
  flipH: !!xfrm.flipH,
  flipV: !!xfrm.flipV,
});

function drawGroup(surface, node, env, map, depth) {
  const props = element(node, 'grpSpPr');
  const xfrm = readXfrm(props);
  const groupFill = fillIn(props, env);
  const inner = groupFill ? { ...env, groupFill } : env;
  if (!xfrm) {
    for (const child of elements(node)) drawNode(surface, child, inner, map, depth + 1);
    return;
  }
  const box = boxOf(xfrm, map);
  const chX = emu(attr(xfrm.chOff, 'x'));
  const chY = emu(attr(xfrm.chOff, 'y'));
  const chW = emu(attr(xfrm.chExt, 'cx')) || xfrm.w || 1;
  const chH = emu(attr(xfrm.chExt, 'cy')) || xfrm.h || 1;
  const sx = box.w / chW;
  const sy = box.h / chH;
  const child = { sx, sy, dx: box.x - chX * sx, dy: box.y - chY * sy };
  const turned = box.rot || box.flipH || box.flipV;
  if (turned) {
    surface.save();
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (box.rot) rotateAbout(surface, box.rot, cx, cy);
    if (box.flipH) surface.transform(-1, 0, 0, 1, 2 * cx, 0);
    if (box.flipV) surface.transform(1, 0, 0, -1, 0, 2 * cy);
  }
  for (const item of elements(node)) {
    const kind = localName(item.name);
    if (kind === 'grpSpPr' || kind === 'nvGrpSpPr' || kind === 'cNvGrpSpPr' || kind === 'cNvPr') continue;
    drawNode(surface, item, inner, child, depth + 1);
  }
  if (turned) surface.restore();
}

/** The outline a shape's properties ask for, in place. */
function outlineFor(spPrs, box, env) {
  let geometry = null;
  let custom = null;
  for (const spPr of spPrs) {
    if (!spPr) continue;
    geometry = element(spPr, 'prstGeom');
    custom = element(spPr, 'custGeom');
    if (geometry || custom) break;
  }
  if (custom) {
    const path = customPath(custom, box.w, box.h, env.budget);
    if (path.length) return { path: offset(path, box.x, box.y), name: 'custom', av: {}, known: true };
  }
  const name = String(attr(geometry, 'prst') || 'rect');
  const av = adjustments(geometry);
  const preset = presetPath(name, box.w, box.h, av);
  if (!preset.known) env.note?.(`A shape of a kind not drawn here (${name}) appears as a rectangle.`);
  return { path: offset(preset.path, box.x, box.y), name, av, known: preset.known, rule: preset.rule, open: preset.open };
}

function drawShape(surface, node, env, map) {
  const own = element(node, 'spPr');
  const inherited = env.inherit?.(node) || {};
  const spPrs = [own, ...(inherited.spPrs || [])];
  const xfrm = readXfrm(own) || inherited.xfrm || env.fallbackXfrm;
  if (!xfrm) return;
  const box = boxOf(xfrm, map);
  const style = element(node, 'style');
  const styled = fromStyle(style, env);
  const fill = firstFill(spPrs, env) ?? styled.fill;
  let stroke = styled.stroke ?? null;
  for (let i = spPrs.length - 1; i >= 0; i -= 1) {
    const ln = element(spPrs[i], 'ln');
    if (ln) stroke = strokeFrom(ln, env, stroke);
  }
  const effects = spPrs.map((spPr) => element(spPr, 'effectLst')).find(Boolean);
  const shadow = effects ? shadowFrom(effects, env) : styled.shadow || null;
  const outline = outlineFor(spPrs, box, env);

  const turned = box.rot || box.flipH || box.flipV;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (turned) {
    surface.save();
    if (box.rot) rotateAbout(surface, box.rot, cx, cy);
  }
  if (box.flipH || box.flipV) {
    surface.save();
    if (box.flipH) surface.transform(-1, 0, 0, 1, 2 * cx, 0);
    if (box.flipV) surface.transform(1, 0, 0, -1, 0, 2 * cy);
  }
  paintPath(surface, outline.path, { fill, stroke, x: box.x, y: box.y, w: box.w, h: box.h, shadow, rule: outline.rule, open: outline.open }, env);
  if (box.flipH || box.flipV) surface.restore();
  env.drawText?.(surface, node, box, { styled, name: outline.name, av: outline.av, inherited });
  if (turned) surface.restore();
}

function drawPicture(surface, node, env, map) {
  const spPr = element(node, 'spPr');
  const inherited = env.inherit?.(node) || {};
  const xfrm = readXfrm(spPr) || inherited.xfrm || env.fallbackXfrm;
  if (!xfrm) return;
  const box = boxOf(xfrm, map);
  const fill = blip(element(node, 'blipFill') || node, env);
  const outline = outlineFor([spPr], box, env);
  const stroke = element(spPr, 'ln') ? strokeFrom(element(spPr, 'ln'), env) : null;
  const effects = element(spPr, 'effectLst');
  const shadow = effects ? shadowFrom(effects, env) : null;
  const turned = box.rot || box.flipH || box.flipV;
  if (turned) {
    surface.save();
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (box.rot) rotateAbout(surface, box.rot, cx, cy);
    if (box.flipH) surface.transform(-1, 0, 0, 1, 2 * cx, 0);
    if (box.flipV) surface.transform(1, 0, 0, -1, 0, 2 * cy);
  }
  if (shadow && fill.part) surface.path(outline.path, { fill: '#FFFFFF', shadow });
  paintPath(surface, outline.path, { fill: /** @type {any} */ (fill), stroke, x: box.x, y: box.y, w: box.w, h: box.h }, env);
  if (turned) surface.restore();
}

/**
 * SmartArt: PowerPoint and Word store what they last drew beside the diagram's data,
 * as ordinary shapes, so it is drawn from there instead of being laid out again.
 *
 * @returns {boolean} whether there was a drawing to draw
 */
export function drawSmartArt(surface, frameNode, box, env) {
  const ids = [...elementsDeep(frameNode, 'relIds')][0];
  const dm = ids && relationshipOf(ids, 'dm');
  const dmRel = dm ? env.rels?.get(dm) : null;
  if (!dmRel) return false;
  const dmPart = resolveTarget(env.part, dmRel.target);
  if (!env.zip.has(dmPart)) return false;
  const data = parseXml(env.zip.text(dmPart));
  const ext = [...elementsDeep(data, 'dataModelExt')][0];
  const rel = env.rels?.get(String(attr(ext, 'relId') || ''));
  if (!rel) return false;
  const part = resolveTarget(env.part, rel.target);
  if (!env.zip.has(part)) return false;
  const tree = element(parseXml(env.zip.text(part)), 'spTree');
  if (!tree) return false;
  const inner = { ...env, part, rels: readRelationships(env.zip, relsPathFor(part)), inherit: null, fallbackXfrm: null };
  const map = { sx: 1, sy: 1, dx: box.x, dy: box.y };
  for (const child of elements(tree)) drawNode(surface, child, inner, map, 1);
  return true;
}

/** Descendants by local name, without importing the generator twice. */
function* elementsDeep(node, name) {
  for (const child of elements(node)) {
    if (localName(child.name) === name) yield child;
    yield* elementsDeep(child, name);
  }
}

function relationshipOf(node, name) {
  return node.attrs[`r:${name}`] ?? attr(node, name) ?? relationshipId(node);
}
