/*
 * What a reader would see wrong in an SVG diagram, before it is shown (owner, 2026-11-11,
 * screenshots of a relationship diagram: a title in dark grey on the dark theme, a
 * legend whose lines ran out of their box and off the drawing, labels on top of each
 * other, a Chinese word inside Vietnamese text) — and its lines and arrows (owner,
 * 2026-11-17: a pipeline whose arrows pointed at nothing and cut through text).
 *
 * No renderer on the server, so this reads the markup and estimates: a line of text is
 * measured as the diagram layout measures it (server/diagram/measure.js: 0.55 of its font
 * size a letter, 0.6 bold, 1 for a CJK character) — close enough to catch a line twice as
 * wide as its box, which is what goes wrong. Positions inside a transformed group, or in
 * <defs>, a <marker> and the like, are not trusted, so those texts are only checked for
 * colour, size and language, and those shapes and lines not at all. Rules in a <style>
 * block for an element or a class, and what a group passes down to what it holds, are read
 * for font size, fill, stroke, weight, anchor, baseline and markers; nothing else of CSS is.
 *
 * One reading serves both checks: the boxes and text boxes the text checks judge are the
 * ones the line check (checkLines) measures the arrows against.
 *
 * The answer is a list of problems, worded for the model to fix, and the canvas the
 * drawing was made for — light (dark text) or dark (light text) — so the page can give it
 * that background.
 */

import { HAN, textWidth } from './diagram/measure.js';

const LATIN = /[A-Za-zÀ-ỹ]{2,}/;
const MAX_ISSUES = 8;

// The line check's figures (spec §Layer 2): an arrow's end touches what it is within 14 px of;
// a text within 18 px of a segment's middle is that segment's own label; two boxes overlap when
// they share more than 6 px each way and neither holds the other; a small triangle is an arrow's
// head when the line's end is within 6 px of it.
export const LINE_CHECK = Object.freeze({ reach: 14, ownLabel: 18, overlap: 6, head: 6 });

// The most one reading takes in, so no markup makes a check slow (a widget is at most 96 KB,
// but this reads whatever it is given): past these the rest of a drawing is not read. `work` is
// how many stretch-and-box or stretch-and-text pairs the crossing checks may look at.
const READ = Object.freeze({ tags: 3000, texts: 2000, points: 1000, segments: 2000, textChars: 8000, spans: 200, depth: 64, work: 2_000_000 });

// A number as drawn. Past a million it is no drawing a person sees, and is read as none.
const num = (v) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) && Math.abs(n) <= 1e6 ? n : null;
};

/** Attributes of one tag, with its `style` declarations over them. */
function attrs(tag) {
  const out = Object.create(null);
  // A name is read from its start only, so a long run of letters is read once, not once a letter.
  for (const m of tag.matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  for (const part of String(out.style || '').split(';')) {
    const [k, ...v] = part.split(':');
    if (k && v.length) out[k.trim().toLowerCase()] = v.join(':').trim();
  }
  return out;
}

/**
 * Simple CSS rules from <style> blocks: `.name{…}`, `text{…}` and `text.name{…}`, also when
 * scoped under the drawing's own id (`#d1 .name{…}`), which is how a drawing keeps its rules
 * to itself.
 */
function cssRules(svg, rootId = '') {
  const rules = Object.create(null);
  const scope = rootId ? new RegExp(`^#${rootId.replace(/[^\w-]/g, '')}\\s+`) : null;
  const open = /<style\b[^<>]*>/gi;
  const close = /<\/style\s*>/gi;
  for (let n = 0; n < 64; n += 1) {
    const start = open.exec(svg);
    if (!start) break;
    close.lastIndex = open.lastIndex;
    const end = close.exec(svg);
    if (!end) break;
    open.lastIndex = close.lastIndex;
    const body = svg.slice(start.index + start[0].length, end.index).replace(/<!\[CDATA\[|\]\]>/g, '');
    // A rule starts where the block does or after a brace, so a long run with no brace is read once.
    for (const rule of body.matchAll(/(?:^|(?<=[{}]))([^{}]+)\{([^}]*)\}/g)) {
      const decl = Object.create(null);
      for (const part of rule[2].split(';')) {
        const [k, ...v] = part.split(':');
        if (k && v.length) decl[k.trim().toLowerCase()] = v.join(':').trim();
      }
      for (const raw of rule[1].split(',')) {
        const sel = (scope ? raw.trim().replace(scope, '') : raw.trim()).replace(/\s+/g, ' ');
        rules[sel] = Object.assign(Object.create(null), rules[sel], decl);
      }
    }
  }
  return rules;
}

const decode = (s) => String(s).replace(/<[^<>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** A colour as [r, g, b], from #rgb, #rrggbb, rgb() or a few names; null for none, gradients, currentColor. */
export function colour(value) {
  const v = String(value || '').trim().toLowerCase();
  const names = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128], navy: [0, 0, 128], blue: [0, 0, 255], green: [0, 128, 0] };
  if (Object.hasOwn(names, v)) return names[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

const luminance = ([r, g, b]) => {
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
/** WCAG contrast of two colours. */
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const quote = (s) => `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;

// ── reading the markup ──────────────────────────────────────────────────────────────────────

// Not drawn where they stand: what is inside is used elsewhere, or not at all.
const UNPLACED = new Set(['defs', 'marker', 'symbol', 'pattern', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'filter', 'title', 'desc', 'metadata', 'foreignobject']);
const GROUPS = new Set(['g', 'a', 'switch', 'svg']);
// What a group passes down to what it holds.
const INHERITED = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'marker', 'marker-start', 'marker-end'];
// A text box's top and bottom from its y, in its size, by its baseline: the alphabetic one by
// default, so y is where the letters sit; `middle` puts y at the middle of the line.
const BASELINES = { middle: [0.525, 0.525], central: [0.525, 0.525], mathematical: [0.525, 0.525], hanging: [0, 1.05], 'text-before-edge': [0, 1.05], 'text-top': [0, 1.05], 'text-after-edge': [1.05, 0], 'text-bottom': [1.05, 0], ideographic: [1.05, 0] };
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*?)(\/?)>/g;
const NUMBERS = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

const pick = (style) => {
  const out = Object.create(null);
  for (const k of INHERITED) if (style[k] !== undefined) out[k] = style[k];
  return out;
};
// A transform, as an attribute or in its style, as the matrix [a, b, c, d, e, f] it multiplies
// by (SVG's matrix(): x' = a·x + c·y + e, y' = b·x + d·y + f), its functions taken in order;
// null when it holds anything this does not read. Where it is axis-aligned — translate, scale,
// matrix(a,0,0,d,e,f) — a box stays a box and is followed (fix rounds 1 and 2: a model's
// translate wrapper, a node drawn at its own origin, the server's scaled icons); a rotate or a
// skew leaves where a box lands unknown, though one point, a text's anchor, can still be found.
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const PLAIN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const LENGTH = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?$/i;
const ANGLE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:deg)?$/i;
const times = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const mapPoint = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const aligned = (m) => Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[0]) > 1e-9 && Math.abs(m[3]) > 1e-9;
// An element's own matrix. A `transform-origin` or `transform-box` moves where a scale or a turn
// pivots, which this does not read: with either, only a plain translate is followed, and anything
// else leaves the position unknown, as before fix round 2 (re-review, fix round 3).
function ownMatrix(a) {
  const m = matrixOf(a.transform);
  const pivoted = a['transform-origin'] !== undefined || a['transform-box'] !== undefined;
  return m && pivoted && !(Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[3] - 1) < 1e-12 && Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12) ? null : m;
}
function matrixOf(transform) {
  const v = typeof transform === 'string' ? transform.trim() : '';
  if (!v || v.toLowerCase() === 'none') return IDENTITY;
  // No transform a drawing needs is this long; reading one that is would only cost time.
  if (v.length > 256) return null;
  let m = IDENTITY;
  let rest = v;
  for (const fn of v.matchAll(/([a-zA-Z]+)\s*\(([^()]*)\)/g)) {
    const args = fn[2].trim().split(/[\s,]+/).filter(Boolean);
    const n = args.map((a) => parseFloat(a));
    const name = fn[1].toLowerCase();
    const rad = (k) => (n[k] * Math.PI) / 180;
    let step = null;
    if (name === 'translate' && args.length >= 1 && args.length <= 2 && args.every((a) => LENGTH.test(a))) step = [1, 0, 0, 1, n[0], n[1] ?? 0];
    else if (name === 'scale' && args.length >= 1 && args.length <= 2 && args.every((a) => PLAIN.test(a))) step = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else if (name === 'matrix' && args.length === 6 && args.every((a) => PLAIN.test(a))) step = n;
    else if (name === 'rotate' && (args.length === 1 || args.length === 3) && ANGLE.test(args[0]) && args.slice(1).every((a) => LENGTH.test(a))) {
      const [cos, sin] = [Math.cos(rad(0)), Math.sin(rad(0))];
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
      step = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
    } else if ((name === 'skewx' || name === 'skewy') && args.length === 1 && ANGLE.test(args[0])) {
      step = name === 'skewx' ? [1, 0, Math.tan(rad(0)), 1, 0, 0] : [1, Math.tan(rad(0)), 0, 1, 0, 0];
    }
    if (!step || !step.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e6)) return null;
    m = times(m, step);
    rest = rest.replace(fn[0], '');
  }
  // Anything left over is a function this does not read, or not a transform at all.
  return /^[\s,]*$/.test(rest) && m.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e9) ? m : null;
}
const opaque = (v) => v === undefined || (num(v) ?? 1) > 0.95;
// A fill or a stroke: whether it paints, and its colour when it is a plain one.
function paint(value, byDefault) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return { on: byDefault, rgb: byDefault ? [0, 0, 0] : null };
  if (v === 'none' || v === 'transparent' || /^rgba\([^)]*,\s*0?\.?0*\s*\)$/.test(v)) return { on: false, rgb: null };
  return { on: true, rgb: colour(v) };
}

// Pairs of numbers from a `points` list, as far as they read, and whether it was cut short:
// then its last point read is not where it ends.
function pointList(value) {
  const nums = String(value ?? '').match(NUMBERS) || [];
  const pts = [];
  for (let i = 0; i + 1 < nums.length && pts.length < READ.points; i += 2) {
    const x = num(nums[i]);
    const y = num(nums[i + 1]);
    if (x === null || y === null) break;
    pts.push([x, y]);
  }
  return { pts, cut: nums.length > 2 * READ.points + 1 };
}

/*
 * A path's `d`, read into its pieces: each runs from a moveto, with every step to a point
 * marked straight or not, the control points that set its direction at each end, and a box
 * round all of it. A curve counts only at its ends (spec §Layer 2); a command this does not
 * know, or a number it cannot read, ends the read, as it ends the drawing in a browser.
 */
function readPath(d) {
  const s = String(d ?? '');
  const pieces = [];
  let i = 0;
  let cmd = '';
  let cur = [0, 0];
  let start = [0, 0];
  let piece = null;
  let budget = READ.points;
  const skip = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === ',' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i += 1;
  };
  const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  const number = () => {
    skip();
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (!m) return null;
    i = NUMBER.lastIndex;
    return num(m[0]);
  };
  const flag = () => {
    skip();
    if (s[i] === '0' || s[i] === '1') return Number(s[i++]);
    return null;
  };
  const grow = (p) => {
    piece.box[0] = Math.min(piece.box[0], p[0]);
    piece.box[1] = Math.min(piece.box[1], p[1]);
    piece.box[2] = Math.max(piece.box[2], p[0]);
    piece.box[3] = Math.max(piece.box[3], p[1]);
  };
  const begin = (p) => {
    if (piece && piece.pts.length) pieces.push(piece);
    piece = { pts: [p], straight: [], near: [], far: [], closed: false, box: [p[0], p[1], p[0], p[1]] };
    start = p;
    cur = p;
    budget -= 1;
  };
  // A step to `p`: straight, or a curve leaving its start toward `c1` and arriving from `c2`.
  // `near` and `far` keep the points that set which way each end of the line points.
  const step = (p, straight, c1 = null, c2 = null) => {
    if (!piece) begin(cur);
    piece.pts.push(p);
    piece.straight.push(straight);
    piece.near.push(straight || !c1 ? p : c1);
    piece.far.push(straight || !c2 ? cur : c2);
    grow(p);
    if (c1) grow(c1);
    if (c2) grow(c2);
    cur = p;
    budget -= 1;
  };
  read: while (i < s.length && budget > 0) {
    skip();
    if (i >= s.length) break;
    if (/[MmLlHhVvZzCcSsQqTtAa]/.test(s[i])) cmd = s[i++];
    else if (!cmd || cmd === 'Z' || cmd === 'z') break;
    const rel = cmd >= 'a';
    const to = (x, y) => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const want = (n) => {
      const out = [];
      for (let k = 0; k < n; k += 1) {
        const v = number();
        if (v === null) return null;
        out.push(v);
      }
      return out;
    };
    switch (cmd.toUpperCase()) {
      case 'Z':
        if (piece && piece.pts.length) {
          if (cur[0] !== start[0] || cur[1] !== start[1]) step(start, true);
          piece.closed = true;
          pieces.push(piece);
          piece = null;
        }
        cur = start;
        continue;
      case 'M': {
        const v = want(2);
        if (!v) break read;
        begin(to(v[0], v[1]));
        cmd = rel ? 'l' : 'L';
        continue;
      }
      case 'L': {
        const v = want(2);
        if (!v) break read;
        step(to(v[0], v[1]), true);
        continue;
      }
      case 'H': {
        const v = want(1);
        if (!v) break read;
        step([rel ? cur[0] + v[0] : v[0], cur[1]], true);
        continue;
      }
      case 'V': {
        const v = want(1);
        if (!v) break read;
        step([cur[0], rel ? cur[1] + v[0] : v[0]], true);
        continue;
      }
      case 'C': {
        const v = want(6);
        if (!v) break read;
        step(to(v[4], v[5]), false, to(v[0], v[1]), to(v[2], v[3]));
        continue;
      }
      case 'S':
      case 'Q': {
        const v = want(4);
        if (!v) break read;
        const c = to(v[0], v[1]);
        step(to(v[2], v[3]), false, c, c);
        continue;
      }
      case 'T': {
        const v = want(2);
        if (!v) break read;
        step(to(v[0], v[1]), false);
        continue;
      }
      case 'A': {
        // Its flags are single digits, which may run together with what follows ("0 01 10 10").
        const r = want(3);
        const large = r ? flag() : null;
        const sweep = large === null ? null : flag();
        const v = sweep === null ? null : want(2);
        if (!v) break read;
        const p = to(v[0], v[1]);
        // An arc stays within its radii of its chord's middle: that much is in its box.
        const mid = [(cur[0] + p[0]) / 2, (cur[1] + p[1]) / 2];
        const half = Math.hypot(p[0] - cur[0], p[1] - cur[1]) / 2;
        const rx = Math.max(Math.abs(r[0]), half);
        const ry = Math.max(Math.abs(r[1]), half);
        step(p, false);
        grow([mid[0] - rx, mid[1] - ry]);
        grow([mid[0] + rx, mid[1] + ry]);
        continue;
      }
      default:
        break read;
    }
  }
  if (piece && piece.pts.length) pieces.push(piece);
  skip();
  return { pieces, cut: budget <= 0 && i < s.length };
}

// A unit vector, or none for a zero one.
const unit = (x, y) => {
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : [0, 0];
};

/*
 * One reading of the markup, for both checks: the view, the style rules, every rect (as the
 * text checks have always read them), every text line with its box, and — for the line check —
 * every shape and line drawn in place, in the order they are painted.
 */
function readDrawing(svg) {
  const markup = withoutComments(typeof svg === 'string' ? svg : '');
  const rootTag = /<svg\b[^<>]*>/i.exec(markup);
  const root = attrs(rootTag ? rootTag[0] : '');
  const rules = cssRules(markup, root.id || '');
  const vb = String(root.viewbox || '').split(/[\s,]+/).map(Number);
  const view = vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : num(root.width) && num(root.height) ? { x: 0, y: 0, w: num(root.width), h: num(root.height) } : null;
  // An element's style: what its group passes down, the rules for its kind and its classes, then its own.
  const styleOf = (name, a, inherited) => {
    const out = Object.assign(Object.create(null), inherited, rules[name]);
    for (const c of String(a.class || '').split(/\s+/)) if (c) Object.assign(out, rules[`.${c}`], rules[`${name}.${c}`]);
    return Object.assign(out, a);
  };

  const rects = [];
  const texts = [];
  const shapes = [];
  const lines = [];
  // Each open group: whether what it holds is not drawn there at all (`hidden`: <defs>, a
  // <marker>…), and the matrix it is drawn through (`m`), null where that cannot be read.
  const stack = [{ name: '', hidden: false, m: IDENTITY, inherit: Object.create(null) }];
  // Texts turned or slanted (an axis label): where each stands, and how far it may reach.
  const tilted = [];
  let deeper = 0;
  let order = 0;
  let segments = 0;
  let seenRoot = false;
  // Whether the read stopped at a limit: then what an arrow points at may be past it, unread.
  let cut = false;
  // Whether something is drawn where this cannot tell — rotated, skewed, a <use>, an <image>: an
  // arrow may point at it, so no arrow is said to point at nothing (fix round 1).
  let unknown = false;
  // Where the next `</text>` and the next `<text` are, kept as the read moves on, so finding a
  // text's end never reads the rest of the markup again.
  let textEnd = -1;
  let nextText = -1;
  const findTextOpen = (from) => {
    let at = from;
    for (;;) {
      const k = markup.indexOf('<text', at);
      if (k < 0) return markup.length;
      const after = markup[k + 5];
      if (after === undefined || after === '>' || after === '/' || /\s/.test(after)) return k;
      at = k + 5;
    }
  };

  const addShape = (kind, box, geo, style, moved) => {
    const fill = paint(style.fill, true);
    const stroke = paint(style.stroke, false);
    if ((num(style.opacity) ?? 1) <= 0) fill.on = stroke.on = false;
    if ((num(style['fill-opacity']) ?? 1) <= 0) fill.on = false;
    if ((num(style['stroke-opacity']) ?? 1) <= 0 || num(style['stroke-width']) === 0) stroke.on = false;
    shapes.push({ kind, x0: box[0], y0: box[1], x1: box[2], y1: box[3], ...geo, fill, stroke, solid: fill.on && opaque(style.opacity) && opaque(style['fill-opacity']), filter: !!style.filter && style.filter !== 'none', order, moved });
  };
  const addLine = (pieces, style, moved, cut) => {
    const open = pieces.filter((p) => !p.closed && p.pts.length > 1);
    if (!open.length || segments >= READ.segments) return;
    const segs = [];
    for (const p of open) {
      for (let k = 1; k < p.pts.length && segments < READ.segments; k += 1) {
        if (!p.straight[k - 1]) continue;
        segs.push([p.pts[k - 1], p.pts[k]]);
        segments += 1;
      }
    }
    const first = open[0];
    const last = open[open.length - 1];
    const a = first.pts[0];
    const b = last.pts[last.pts.length - 1];
    // Which way each end points: away from the line, from the point (or control point) before it,
    // or from the next point along when a control point sits on the end itself.
    const same = (p, q) => p[0] === q[0] && p[1] === q[1];
    const near = same(first.near[0], a) ? first.pts[1] : first.near[0];
    const far = same(last.far[last.far.length - 1], b) ? last.pts[last.pts.length - 2] : last.far[last.far.length - 1];
    const marked = (v) => typeof v === 'string' && /url\(/i.test(v);
    let length = 0;
    for (const p of open) for (let k = 1; k < p.pts.length; k += 1) length += Math.hypot(p.pts[k][0] - p.pts[k - 1][0], p.pts[k][1] - p.pts[k - 1][1]);
    lines.push({
      order,
      moved,
      cut: !!cut,
      segs,
      length,
      ends: [
        { p: a, at: a, dir: unit(a[0] - near[0], a[1] - near[1]), head: marked(style['marker-start'] ?? style.marker) },
        { p: b, at: b, dir: unit(b[0] - far[0], b[1] - far[1]), head: marked(style['marker-end'] ?? style.marker) },
      ],
    });
  };

  for (const m of markup.matchAll(TAG)) {
    if ((order += 1) > READ.tags) {
      cut = true;
      break;
    }
    const [whole, closing, rawName, , selfClose] = m;
    const name = rawName.toLowerCase().replace(/^.*:/, '');
    const container = GROUPS.has(name) || UNPLACED.has(name);
    if (closing) {
      if (!container) continue;
      if (deeper) {
        deeper -= 1;
        continue;
      }
      for (let k = stack.length - 1; k > 0 && k >= stack.length - 8; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const top = stack[stack.length - 1];
    const shown = !top.hidden && !deeper;
    if (container) {
      const a = attrs(whole);
      const nested = name === 'svg' && seenRoot;
      if (name === 'svg') seenRoot = true;
      // What a <foreignObject> holds is drawn, but not as anything this reads.
      if (name === 'foreignobject' && shown) unknown = true;
      if (selfClose) continue;
      if (stack.length >= READ.depth || deeper > 0) {
        deeper += 1;
        cut = true;
        continue;
      }
      const own = ownMatrix(a);
      const hidden = top.hidden || UNPLACED.has(name) || String(a.display || '').trim() === 'none';
      stack.push({ name, hidden, m: !nested && top.m && own ? times(top.m, own) : null, inherit: pick(styleOf(name, a, top.inherit)) });
      continue;
    }
    if (name === 'use' || name === 'image') {
      if (shown) unknown = true;
      continue;
    }
    if (!['rect', 'text', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'path'].includes(name)) continue;
    const own = attrs(whole);
    const ownM = ownMatrix(own);
    // The matrix it is drawn through; followed when it keeps boxes boxes. A text must also read
    // the right way round, or it is taken as turned.
    const M = !deeper && top.m && ownM ? times(top.m, ownM) : null;
    const straight = !!M && aligned(M) && (name !== 'text' || (M[0] > 0 && M[3] > 0));
    const moved = top.hidden || deeper > 0 || !straight;
    // A turned text is set aside on its own (below); anything else drawn where this cannot follow
    // leaves no end judged.
    if (moved && shown && !(name === 'text' && M)) unknown = true;
    const T = straight ? M : IDENTITY;
    const place = (p) => mapPoint(T, p);
    // A box through the matrix: its corners carried over, still a box since the matrix is aligned.
    const boxOf = (x0, y0, x1, y1) => {
      const [p, q] = [place([x0, y0]), place([x1, y1])];
      return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
    };
    const [sx, sy] = [Math.abs(T[0]), Math.abs(T[3])];
    const s = styleOf(name, own, top.inherit);

    if (name === 'rect') {
      // As the text checks have always read a rect: its own fill, or one its classes or group give it.
      const w = num(s.width);
      const h = num(s.height);
      if (w > 0 && h > 0) {
        const lx = num(s.x) ?? 0;
        const ly = num(s.y) ?? 0;
        const b = boxOf(lx, ly, lx + w, ly + h);
        rects.push({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1], fill: colour(s.fill), moved });
        // Its corners' radius, as a browser reads rx and ry: one stands for both, at most half a side.
        const rx = num(s.rx) ?? num(s.ry) ?? 0;
        const ry = num(s.ry) ?? num(s.rx) ?? 0;
        const round = Math.max(0, Math.min(rx, w / 2, ry, h / 2)) * Math.min(sx, sy);
        addShape('rect', b, { round }, s, moved);
      }
      continue;
    }
    if (name === 'circle' || name === 'ellipse') {
      const [cx, cy] = place([num(s.cx) ?? 0, num(s.cy) ?? 0]);
      const r1 = name === 'circle' ? num(s.r) : num(s.rx) ?? num(s.ry);
      const r2 = name === 'circle' ? num(s.r) : num(s.ry) ?? num(s.rx);
      const [rx, ry] = [r1 * sx, r2 * sy];
      if (rx > 0 && ry > 0) addShape(Math.abs(rx - ry) < 1e-9 ? 'circle' : 'ellipse', [cx - rx, cy - ry, cx + rx, cy + ry], { cx, cy, rx, ry }, s, moved);
      continue;
    }
    if (name === 'polygon' || name === 'polyline' || name === 'line' || name === 'path') {
      let pieces;
      let partial = false;
      if (name === 'line') {
        const a = [num(s.x1) ?? 0, num(s.y1) ?? 0];
        const b = [num(s.x2) ?? 0, num(s.y2) ?? 0];
        pieces = [{ pts: [a, b], straight: [true], near: [b], far: [a], closed: false }];
      } else if (name === 'path') {
        ({ pieces, cut: partial } = readPath(s.d));
      } else {
        const listed = pointList(s.points);
        const pts = listed.pts;
        partial = listed.cut;
        if (name === 'polygon' && pts.length > 2) {
          const [f, l] = [pts[0], pts[pts.length - 1]];
          if (f[0] === l[0] && f[1] === l[1]) pts.pop();
        }
        pieces = pts.length > 1 ? [{ pts, straight: pts.slice(1).map(() => true), near: pts.slice(1), far: pts.slice(0, -1), closed: name === 'polygon' }] : [];
      }
      if (T !== IDENTITY) pieces = pieces.map((p) => ({ ...p, pts: p.pts.map(place), near: p.near.map(place), far: p.far.map(place), ...(p.box ? { box: boxOf(...p.box) } : {}) }));
      // A closed piece is a shape — a polygon by its corners where every side is straight, else
      // its box; an open one is a line.
      for (const p of pieces) {
        if (!p.closed) continue;
        let pts = p.pts;
        if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const box = p.box || [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        if (box[2] - box[0] > 0 && box[3] - box[1] > 0) addShape('poly', box, { pts: p.straight.every(Boolean) && pts.length > 2 ? pts : null }, s, moved);
      }
      addLine(pieces, s, moved, partial);
      continue;
    }

    // A text: each <tspan> with its own x or dy is a line; otherwise the whole is one.
    if (texts.length >= READ.texts) {
      cut = true;
      continue;
    }
    const from = m.index + whole.length;
    let inner = '';
    if (!selfClose) {
      if (textEnd < from) {
        textEnd = markup.indexOf('</text>', from);
        if (textEnd < 0) textEnd = markup.length;
      }
      if (nextText < from) nextText = findTextOpen(from);
      // A text never closed is read as none, as it always was.
      if (textEnd < markup.length) inner = markup.slice(from, Math.min(textEnd, nextText, from + READ.textChars));
    }
    const size = num(s['font-size']) ?? 16;
    const bold = /bold|[6-9]00/.test(String(s['font-weight'] || ''));
    const anchor = String(s['text-anchor'] || 'start');
    const fill = colour(s.fill);
    const baseline = String(s['dominant-baseline'] || s['alignment-baseline'] || '').trim().toLowerCase();
    const spans = [];
    for (let pos = 0; spans.length < READ.spans; ) {
      const open = inner.indexOf('<tspan', pos);
      if (open < 0) break;
      const head = inner.indexOf('>', open);
      const close = head < 0 ? -1 : inner.indexOf('</tspan>', head);
      if (close < 0) break;
      spans.push([inner.slice(open, head + 1), inner.slice(head + 1, close)]);
      pos = close + 8;
    }
    // A line's y: its own, or the line before's moved by its dy (in em or units).
    const shift = (raw) => (/em$/.test(String(raw || '').trim()) ? (num(raw) ?? 0) * size : num(raw) ?? 0);
    let runY = (num(s.y) ?? 0) + shift(own.dy);
    const read = spans.length && spans.some(([tag]) => /\s(x|dy)\s*=/.test(tag))
      ? spans.map(([tag, body]) => {
          const sa = attrs(tag);
          runY = num(sa.y) ?? runY + shift(sa.dy);
          return { text: decode(body), x: num(sa.x) ?? num(s.x) ?? 0, y: runY };
        })
      : [{ text: decode(inner), x: num(s.x) ?? 0, y: runY }];
    const [up, down] = BASELINES[baseline] || [0.8, 0.25];
    for (const line of read) {
      if (!line.text) continue;
      // Measured where it is written, then carried through the matrix: its size by the scale down,
      // its width by the scale across.
      const [x, y] = place([line.x, line.y]);
      const sized = size * sy;
      const w = textWidth(line.text, size, bold) * sx;
      const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      texts.push({ text: line.text, x, y, size: sized, bold, anchor, fill, moved, order, box: { x0, x1: x0 + w, y0: y - sized * up, y1: y + sized * down, w } });
      // Turned or slanted, it is no target; an arrow end near where it stands is spared instead:
      // its anchor, as far as the larger of its width and height reach, and 14 px more.
      if (moved && shown && M) {
        const k = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
        const [ax, ay] = mapPoint(M, [line.x, line.y]);
        tilted.push({ x: ax, y: ay, reach: Math.max(textWidth(line.text, size, bold), size * 1.05) * k + LINE_CHECK.reach });
      }
    }
  }

  // The canvas it was drawn for: a background covering the drawing, else what its text is.
  const backdrop = view ? rects.find((r) => !r.moved && r.fill && r.w * r.h >= view.w * view.h * 0.85) : null;
  const inks = texts.map((t) => t.fill).filter(Boolean);
  const darkInk = inks.filter((c) => luminance(c) < 0.4).length;
  const canvas = /** @type {'light' | 'dark' | null} */ (backdrop ? (luminance(backdrop.fill) > 0.4 ? 'light' : 'dark') : inks.length ? (darkInk >= inks.length / 2 ? 'light' : 'dark') : null);
  const canvasColour = backdrop?.fill || (canvas === 'dark' ? [15, 23, 32] : [255, 255, 255]);
  return { view, rects, texts, shapes, lines, backdrop, canvas, canvasColour, cut, unknown, tilted };
}

// The markup with its comments taken out, read once from start to end.
function withoutComments(s) {
  if (!s.includes('<!--')) return s;
  let out = '';
  let at = 0;
  for (;;) {
    const open = s.indexOf('<!--', at);
    if (open < 0) break;
    out += s.slice(at, open);
    const close = s.indexOf('-->', open + 4);
    at = close < 0 ? s.length : close + 3;
  }
  return out + s.slice(at);
}

// ── geometry ────────────────────────────────────────────────────────────────────────────────

const toSegment = (p, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
// From a point to a box, 0 inside it.
const toBox = (p, b) => {
  const dx = Math.max(b.x0 - p[0], 0, p[0] - b.x1);
  const dy = Math.max(b.y0 - p[1], 0, p[1] - b.y1);
  return Math.sqrt(dx * dx + dy * dy);
};
// From a point to a box's outline, from inside or out.
const toBoxEdge = (p, b) => (p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1 ? Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]) : toBox(p, b));
const inBox = (p, b) => p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;
const shrink = (b, dx, dy = dx) => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 - dx, y1: b.y1 - dy });
const meets = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
// Whether `inner` lies within `outer`, `pad` in from its sides (a negative pad allows that much out).
const within = (inner, outer, pad) => inner.x0 >= outer.x0 + pad && inner.y0 >= outer.y0 + pad && inner.x1 <= outer.x1 - pad && inner.y1 <= outer.y1 - pad;
const segBox = (a, b) => ({ x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });

// The part of the segment a→b inside box `box`, as [from, to] along it (Liang–Barsky), or null.
function clip(a, b, box) {
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return null;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] - box.x0], [dx, box.x1 - a[0]], [-dy, a[1] - box.y0], [dy, box.y1 - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}
const lengthIn = (a, b, box) => {
  const part = clip(a, b, box);
  return part ? (part[1] - part[0]) * Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
};

// How far a point lies outside a rect with rounded corners — negative inside (the rounded box's
// signed distance). The server's pills are rects with a radius of half their short side, and
// their arrows end on the curve (fix round 5): measured by its box, such an end looked inside.
function fromRect(p, s) {
  const hw = (s.x1 - s.x0) / 2;
  const hh = (s.y1 - s.y0) / 2;
  const r = s.round || 0;
  const qx = Math.abs(p[0] - (s.x0 + hw)) - (hw - r);
  const qy = Math.abs(p[1] - (s.y0 + hh)) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// How long a stretch of a→b lies `inset` inside a rect: exactly for square corners; through
// rounded ones, by 32 points along the part inside its box.
function lengthInRect(a, b, s, inset) {
  const part = clip(a, b, shrink(s, inset));
  if (!part) return 0;
  const len = (part[1] - part[0]) * Math.hypot(b[0] - a[0], b[1] - a[1]);
  if ((s.round || 0) <= inset) return len;
  let inside = 0;
  for (let k = 0; k < 32; k += 1) {
    const t = part[0] + ((part[1] - part[0]) * (k + 0.5)) / 32;
    if (fromRect([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], s) < -inset) inside += 1;
  }
  return (len * inside) / 32;
}

// How long a stretch of a→b lies inside an ellipse (a circle when rx = ry), by scaling it round.
function lengthInEllipse(a, b, cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return 0;
  const fx = (a[0] - cx) / rx;
  const fy = (a[1] - cy) / ry;
  const dx = (b[0] - a[0]) / rx;
  const dy = (b[1] - a[1]) / ry;
  const A = dx * dx + dy * dy;
  if (!A) return 0;
  const B = 2 * (fx * dx + fy * dy);
  const disc = B * B - 4 * A * (fx * fx + fy * fy - 1);
  if (disc <= 0) return 0;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - root) / (2 * A));
  const t1 = Math.min(1, (-B + root) / (2 * A));
  return t1 > t0 ? (t1 - t0) * Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
}

const inPolygon = (p, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const toOutline = (p, pts) => {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) best = Math.min(best, toSegment(p, pts[j], pts[i]));
  return best;
};
// How long a stretch of a→b lies inside a polygon, `inset` in from its sides: cut where it
// crosses a side, and each stretch whose middle is inside counted, less the inset at each end.
function lengthInPolygon(a, b, pts, inset) {
  const cuts = [0, 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const ex = pts[i][0] - pts[j][0];
    const ey = pts[i][1] - pts[j][1];
    const den = dx * ey - dy * ex;
    if (!den) continue;
    const t = ((pts[j][0] - a[0]) * ey - (pts[j][1] - a[1]) * ex) / den;
    const u = ((pts[j][0] - a[0]) * dy - (pts[j][1] - a[1]) * dx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  }
  cuts.sort((x, y) => x - y);
  const len = Math.hypot(dx, dy);
  let total = 0;
  for (let k = 1; k < cuts.length; k += 1) {
    const mid = (cuts[k - 1] + cuts[k]) / 2;
    const p = [a[0] + dx * mid, a[1] + dy * mid];
    if (inPolygon(p, pts) && toOutline(p, pts) > inset) total += Math.max(0, (cuts[k] - cuts[k - 1]) * len - 2 * inset);
  }
  return total;
}

// A shape's outline, inside, and the stretch of a segment through it, `inset` in from its sides.
// A closed polygon or path is taken by its box (spec §Layer 3) as well as by its own sides.
function edgeOf(s, p) {
  if (s.kind === 'circle') return Math.abs(Math.hypot(p[0] - s.cx, p[1] - s.cy) - s.rx);
  if (s.kind === 'ellipse') {
    const k = Math.hypot((p[0] - s.cx) / s.rx, (p[1] - s.cy) / s.ry);
    return k ? Math.hypot(p[0] - (s.cx + (p[0] - s.cx) / k), p[1] - (s.cy + (p[1] - s.cy) / k)) : Math.min(s.rx, s.ry);
  }
  if (s.kind === 'rect') return Math.abs(fromRect(p, s));
  return s.pts ? Math.min(toBoxEdge(p, s), toOutline(p, s.pts)) : toBoxEdge(p, s);
}
function holds(s, p) {
  if (s.kind === 'circle' || s.kind === 'ellipse') return Math.hypot((p[0] - s.cx) / s.rx, (p[1] - s.cy) / s.ry) <= 1;
  if (s.kind === 'rect') return fromRect(p, s) <= 0;
  return s.pts ? inPolygon(p, s.pts) : inBox(p, s);
}
function lengthThrough(s, a, b, inset) {
  if (s.kind === 'circle' || s.kind === 'ellipse') return lengthInEllipse(a, b, s.cx, s.cy, s.rx - inset, s.ry - inset);
  if (s.kind === 'rect') return lengthInRect(a, b, s, inset);
  return s.pts ? lengthInPolygon(a, b, s.pts, inset) : lengthIn(a, b, shrink(s, inset));
}
// Whether a text lies before a line's end, or beside it, rather than back along the line: an
// arrow points at what is ahead of it, and the label it carries is behind its head (found by
// cutting a server diagram's arrow short: it stopped just past its own label, and counted as
// pointing at it).
const ahead = (end, b) => {
  const vx = Math.max(b.x0, Math.min(end.p[0], b.x1)) - end.p[0];
  const vy = Math.max(b.y0, Math.min(end.p[1], b.y1)) - end.p[1];
  const len = Math.hypot(vx, vy);
  return len <= 4 || (vx * end.dir[0] + vy * end.dir[1]) / len > -0.3;
};
// The point of a triangle at a line's end: the corner furthest along the way the line goes.
const tipOf = (pts, end) => pts.reduce((best, v) => ((v[0] - end.at[0]) * end.dir[0] + (v[1] - end.at[1]) * end.dir[1] > (best[0] - end.at[0]) * end.dir[0] + (best[1] - end.at[1]) * end.dir[1] ? v : best), pts[0]);
const area = (s) => (s.x1 - s.x0) * (s.y1 - s.y0);
const at = (p) => `(${Math.round(p[0])}, ${Math.round(p[1])})`;

// ── the line check ──────────────────────────────────────────────────────────────────────────

// Each finding by kind, in the order the model is told them: arrows to nothing first, as the
// owner's were, then arrows through things, then labels and boxes.
const KINDS = ['end', 'box', 'text', 'label', 'overlap'];

function lineIssues(d) {
  const R = LINE_CHECK;
  const found = Object.fromEntries(KINDS.map((k) => [k, []]));
  const add = (kind, s) => found[kind].length < MAX_ISSUES && !found[kind].includes(s) && found[kind].push(s);
  // Whether a kind can still reach the eight told: not when it has eight, nor when the kinds told
  // before it already fill the list. Its search stops then, which bounds a drawing of many faults.
  const done = (kind) => {
    let before = 0;
    for (const k of KINDS) {
      if (k === kind) return found[k].length >= MAX_ISSUES || before >= MAX_ISSUES;
      before += found[k].length;
    }
    return true;
  };
  const view = d.view;
  const canvasSized = (s) => !!view && area(s) >= view.w * view.h * 0.85;
  const placed = d.texts.filter((t) => !t.moved);
  const drawn = d.shapes.filter((s) => !s.moved && !canvasSized(s));
  const lines = d.lines.filter((l) => !l.moved);
  // What is behind a shape: the smallest filled one painted before it that holds it, else the canvas.
  const behind = (s) => {
    let host = null;
    for (const o of drawn) if (o !== s && o.order < s.order && o.fill.on && within(s, o, 0) && (!host || area(o) < area(host))) host = o;
    return host ? host.fill.rgb : d.canvasColour;
  };
  // A shape no one sees — no outline, and a fill the colour of what is behind it — is a label's
  // backing or a spacer, not a box: nothing can point at it or run through it.
  for (const s of drawn) {
    const under = !s.stroke.on && !s.filter && s.fill.on && s.fill.rgb ? behind(s) : null;
    s.seen = s.stroke.on || s.filter || (s.fill.on && !(under && contrast(s.fill.rgb, under) < 1.1));
  }

  // Arrowheads drawn as small triangles, by the line end they sit on.
  const triangles = drawn.filter((s) => s.kind === 'poly' && s.pts?.length === 3 && s.seen && Math.max(s.x1 - s.x0, s.y1 - s.y0) <= 24);
  for (const line of lines) {
    for (const end of line.ends) {
      for (const tri of triangles) {
        if (toBox(end.at, tri) > R.head) continue;
        if (!holds(tri, end.at) && toOutline(end.at, tri.pts) > R.head) continue;
        tri.head = true;
        end.head = true;
        end.p = tipOf(tri.pts, end);
      }
    }
  }
  const arrows = lines.filter((l) => l.ends.some((e) => e.head));
  if (!arrows.length && !drawn.length) return [];

  const targets = drawn.filter((s) => s.seen && !s.head);
  const centre = (b) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  // Each text's holder — the smallest shape round its middle — names that shape after it.
  for (const s of targets) s.texts = [];
  for (const t of placed) {
    const c = centre(t.box);
    let host = null;
    for (const s of targets) if (inBox(c, s) && holds(s, c) && (!host || area(s) < area(host))) host = s;
    if (host) host.texts.push(t);
  }
  for (const s of targets) s.title = s.texts.reduce((top, t) => (!top || t.box.y0 < top.box.y0 - 0.5 || (Math.abs(t.box.y0 - top.box.y0) <= 0.5 && t.box.x0 < top.box.x0) ? t : top), null)?.text || '';
  // A group or a lane holds boxes of its own, each with its text and clear of its border: an arrow
  // may cross it on the way to somewhere else (swimlanes; a server diagram's groups).
  const worded = targets.filter((s) => s.texts.length);
  for (const s of targets) s.container = worded.some((o) => o !== s && within(o, s, 4));
  const boxes = targets.filter((s) => !s.container && s.x1 - s.x0 >= 12 && s.y1 - s.y0 >= 12);
  for (const s of boxes) s.isBox = true;
  // What a shape is called: its kind, then its title, or where it stands — a rect by its corner,
  // anything else by its middle, as the model wrote them (fix round 1: "the box at" for a circle).
  const diamond = (s) => s.pts?.length === 4 && s.pts.every(([x, y]) => {
    const [mx, my] = centre(s);
    return (Math.abs(x - mx) <= 2 && (Math.abs(y - s.y0) <= 2 || Math.abs(y - s.y1) <= 2)) || (Math.abs(y - my) <= 2 && (Math.abs(x - s.x0) <= 2 || Math.abs(x - s.x1) <= 2));
  });
  const kindOf = (s) => (s.kind === 'rect' ? 'box' : s.kind === 'circle' || s.kind === 'ellipse' ? s.kind : s.pts?.length === 3 ? 'triangle' : diamond(s) ? 'diamond' : 'shape');
  const called = (s) => `the ${kindOf(s)} ${s.title ? quote(s.title) : `at ${at(s.kind === 'rect' ? [s.x0, s.y0] : centre(s))}`}`;
  // A text's inside, less a margin for the estimate: 1.5 px each way, and a tenth of its width across.
  for (const t of placed) t.core = shrink(t.box, Math.max(1.5, t.box.w / 10), 1.5);

  // What a line's end touches, looked up once: the nearest outline within reach, every shape it
  // is on or in, and a text within reach; and, asked only when needed, another line's end or a
  // line with no head (a lifeline, a bus).
  const plain = lines.filter((l) => !l.ends.some((e) => e.head));
  const close = (p, b, pad) => p[0] >= b.x0 - pad && p[0] <= b.x1 + pad && p[1] >= b.y0 - pad && p[1] <= b.y1 + pad;
  const look = (end) => {
    if (end.look) return end.look;
    const p = end.p;
    let edge = null;
    const on = [];
    for (const s of targets) {
      if (!close(p, s, R.reach)) continue;
      const gap = edgeOf(s, p);
      if (gap <= R.reach || holds(s, p)) on.push(s);
      if (gap <= R.reach && (!edge || gap < edge.gap)) edge = { s, gap };
    }
    const text = placed.find((t) => close(p, t.box, R.reach) && toBox(p, t.box) <= R.reach && ahead(end, t.box)) || null;
    end.look = { edge, on, text };
    return end.look;
  };
  const lineNear = (p, self) =>
    lines.some((l) => l !== self && l.ends.some((e) => Math.abs(e.p[0] - p[0]) <= R.reach && Math.abs(e.p[1] - p[1]) <= R.reach && Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) <= R.reach)) ||
    plain.some((l) => l !== self && l.segs.some(([a, b]) => toSegment(p, a, b) <= R.reach));
  const nameAt = (end) => {
    const { edge, text } = look(end);
    if (edge) return edge.s.title ? quote(edge.s.title) : called(edge.s);
    return text ? quote(text.text) : at(end.p);
  };
  // A label on a backing painted after the line is not run through: the line goes under it. The
  // latest such backing over each text is found once, not again for every stretch of every arrow
  // (fix round 1: 800 texts under 1,940 stretches and 800 backings took 5.6 s).
  const backings = drawn.filter((s) => s.kind === 'rect' && s.solid);
  for (const t of placed) {
    t.cover = -1;
    for (const r of backings) if (r.order > t.cover && within(t.core, r, -1)) t.cover = r.order;
  }

  // What a free head stops short of: the nearest shape or text it would meet going on the way it
  // points, within three reaches (42 px), and not one it is already inside (a group, a lane).
  const shortOf = (end) => {
    if (!end.dir[0] && !end.dir[1]) return null;
    const far = [end.p[0] + end.dir[0] * 3 * R.reach, end.p[1] + end.dir[1] * 3 * R.reach];
    const span = segBox(end.p, far);
    let best = null;
    const take = (gap, name) => {
      if (!best || gap < best.gap) best = { gap, name };
    };
    for (const s of targets) if (meets(span, s) && !holds(s, end.p) && lengthThrough(s, end.p, far, 0) > 0) take(toBox(end.p, s), s.title ? quote(s.title) : called(s));
    for (const t of placed) if (meets(span, t.box) && !inBox(end.p, t.box) && lengthIn(end.p, far, t.box) > 0) take(toBox(end.p, t.box), quote(t.text));
    return best?.name || null;
  };

  // No end is judged where a position is not known: the read stopped at a limit, something is
  // drawn rotated, skewed or by <use>, or the crossing checks ran out of their work (below).
  let blind = d.cut || d.unknown;
  let work = 0;
  arrows: for (const line of arrows) {
    if (done('end') && done('box') && done('text') && done('label')) break;
    const [first, last] = line.ends;
    const [from, to] = !last.head && first.head ? [last, first] : [first, last];
    const name = `the arrow from ${nameAt(from)} to ${nameAt(to)}`;
    const onText = new Set();
    const struck = new Set();
    const touches = (e) => {
      const seen = look(e);
      return !!seen.edge || seen.on.length > 0 || !!seen.text || lineNear(e.p, line);
    };
    // Whether an end is on a shape or at a text: only then is the other end's freedom a fault,
    // since an axis or a timeline's spine is an arrow meant to end in open space (fix round 1).
    const anchored = (e) => {
      const seen = look(e);
      return !!seen.edge || seen.on.length > 0 || !!seen.text;
    };
    for (const end of blind || line.cut ? [] : line.ends) {
      // Near a turned text (an axis label), which may be what it points at (fix round 2).
      if (d.tilted.some((t) => Math.abs(end.p[0] - t.x) <= t.reach && Math.abs(end.p[1] - t.y) <= t.reach)) continue;
      const { edge, on, text } = look(end);
      const other = end === first ? last : first;
      if (end.head) {
        const over = placed.find((t) => inBox(end.p, t.core));
        const host = edge ? null : on.filter((s) => s.isBox).sort((p, q) => area(p) - area(q))[0];
        if (over) {
          onText.add(over.order);
          add('end', `an arrow ends on top of ${quote(over.text)} at ${at(end.p)}: stop it at the edge of what it points to, clear of the text.`);
        } else if (host) {
          add('end', `an arrow ends at ${at(end.p)}, inside ${called(host)} rather than on its edge, so its head is hidden or drawn over it: end it on the edge.`);
        } else if (!edge && !text && !lineNear(end.p, line)) {
          if (anchored(other)) add('end', `an arrow at ${at(end.p)}, from ${nameAt(other)}, points at nothing: end it on the edge of the box it belongs to.`);
          else {
            // Both ends free: an axis or a spine, unless it stops short of something straight ahead
            // of it — an arrow floating between two boxes (re-review, fix round 3).
            const short = shortOf(end);
            if (short) add('end', `an arrow at ${at(end.p)}, stopping short of ${short}, points at nothing: end it on the edge of the box it belongs to.`);
          }
        }
      } else if (anchored(other) && !(line.length < 48 && other.head) && !touches(end)) {
        // A short arrow beside its words is a legend's key or a trend mark: its tail is free.
        add('end', `an arrow starting at ${at(end.p)} comes from nothing: start it on the edge of the box it leaves.`);
      }
    }

    // What it may enter: whatever it starts or ends on, or holds an end.
    const ends = new Set([...look(first).on, ...look(last).on]);
    for (const [a, b] of line.segs) {
      // A hard limit on the stretches × boxes and texts looked at, so no drawing makes this slow;
      // past it nothing more is judged, and no end is blamed for what was not looked at.
      work += boxes.length + placed.length;
      if (work > READ.work) {
        blind = true;
        break arrows;
      }
      const span = segBox(a, b);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const own = (t) => toBox(mid, t.box) <= R.ownLabel;
      for (const s of done('box') ? [] : boxes) {
        if (ends.has(s) || !meets(span, s)) continue;
        // A dot the line runs through the middle of marks a point on it (a timeline's), not a box.
        if (s.kind === 'circle' && s.rx <= 12 && toSegment([s.cx, s.cy], a, b) <= Math.max(1.5, s.rx / 4)) continue;
        if (lengthThrough(s, a, b, 3) < 2) continue;
        // A small plate holding only this stretch's own label is the label's, not a box.
        const words = s.texts.length ? s.texts.reduce((u, t) => ({ x0: Math.min(u.x0, t.box.x0), y0: Math.min(u.y0, t.box.y0), x1: Math.max(u.x1, t.box.x1), y1: Math.max(u.y1, t.box.y1) }), s.texts[0].box) : null;
        if (words && s.texts.every(own) && s.x1 - s.x0 <= words.x1 - words.x0 + 20 && s.y1 - s.y0 <= words.y1 - words.y0 + 20) continue;
        add('box', `${name} runs through ${called(s)}: route it around, or end it on the edge if that is where it goes.`);
      }
      for (const t of done('text') && done('label') ? [] : placed) {
        // A text of several lines is told once, by the first line the arrow meets; one the arrow
        // passes under a backing is set aside for good.
        if (onText.has(t.order) || struck.has(t.order) || !meets(span, t.box)) continue;
        if (t.cover > line.order) {
          struck.add(t.order);
          continue;
        }
        if (lengthIn(a, b, t.core) < 2) continue;
        struck.add(t.order);
        if (own(t)) add('label', `the label ${quote(t.text)} sits on its own arrow, so the line strikes through it: move it about 6 px beside the line, or draw a backing the colour of what is behind it after the line.`);
        else add('text', `${name} runs through ${quote(t.text)}: route it around the text, or move the text beside the arrow.`);
      }
    }
  }

  // Boxes on top of one another, other than one wholly inside the other.
  const plates = targets.filter((s) => s.kind === 'rect');
  for (let i = 0; i < plates.length && !done('overlap'); i += 1) {
    for (let j = i + 1; j < plates.length; j += 1) {
      const p = plates[i];
      const q = plates[j];
      const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (w > R.overlap && h > R.overlap && !within(p, q, -2) && !within(q, p, -2)) {
        add('overlap', `${called(p)} and ${called(q)} overlap by about ${Math.round(w)}×${Math.round(h)}: move one so they stand apart, or put one wholly inside the other.`);
      }
    }
  }
  return KINDS.flatMap((k) => found[k]).slice(0, MAX_ISSUES);
}

/**
 * What is wrong with a drawing's lines and arrows (spec §Layer 2): an arrow that points at
 * nothing or ends inside a box, one that runs through a box or a text, a label struck through by
 * its own line, and boxes on top of each other. Lines inside a transformed group are skipped.
 * Never throws, whatever it is given.
 *
 * @param {string} markup
 * @returns {string[]} the problems, worded for the model, at most eight
 */
export function checkLines(markup) {
  return lineIssues(readDrawing(markup));
}

// ── the whole check ─────────────────────────────────────────────────────────────────────────

/**
 * @param {string} svg
 * @returns {{ issues: string[], canvas: 'light' | 'dark' | null }}
 */
export function checkDiagram(svg) {
  const d = readDrawing(svg);
  const { view, rects, texts, backdrop, canvas, canvasColour } = d;

  const issues = [];
  const add = (s) => issues.length < MAX_ISSUES && !issues.includes(s) && issues.push(s);
  const placed = texts.filter((t) => !t.moved).map((t) => ({ t, b: t.box }));

  for (const { t, b } of placed) {
    if (view && (b.x0 < view.x - 2 || b.x1 > view.x + view.w + 2)) add(`${quote(t.text)} runs off the side of the drawing (about ${Math.round(b.w)} wide at x=${Math.round(t.x)}): shorten it, or break it into lines with <tspan x=… dy="1.2em">.`);
    // The smallest rect round it (the first of equals), found in one pass rather than by sorting them.
    let holder;
    for (const r of rects) {
      if (!r.moved && r !== backdrop && t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h + t.size * 0.3 && (!holder || r.w * r.h < holder.w * holder.h)) holder = r;
    }
    if (holder && b.w > holder.w - 6) add(`${quote(t.text)} is wider than its box (about ${Math.round(b.w)} against ${Math.round(holder.w)}): shorten it, make the box wider, or break it into <tspan> lines.`);
    // Readable against what is behind it.
    const behind = holder?.fill || canvasColour;
    if (t.fill && contrast(t.fill, behind) < 3) add(`${quote(t.text)} is hard to read: its colour is too close to what is behind it (contrast ${contrast(t.fill, behind).toFixed(1)}:1, at least 4.5 is wanted).`);
  }
  for (let i = 0; i < placed.length && issues.length < MAX_ISSUES; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const p = placed[i].b;
      const q = placed[j].b;
      const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (w > 0 && h > 0 && w * h > 0.3 * Math.min((p.x1 - p.x0) * (p.y1 - p.y0), (q.x1 - q.x0) * (q.y1 - q.y0))) {
        add(`${quote(placed[i].t.text)} and ${quote(placed[j].t.text)} are drawn on top of each other: move one (labels on arrows go beside the arrow, not over a box).`);
      }
    }
  }
  for (const t of texts) {
    if (t.size < 9) add(`${quote(t.text)} is ${t.size}px, too small to read; 11px is the least.`);
    if (t.moved && t.fill && contrast(t.fill, canvasColour) < 3) add(`${quote(t.text)} is hard to read against the background.`);
  }
  const lettered = texts.some((t) => LATIN.test(t.text));
  for (const t of texts) if (HAN.test(t.text) && lettered) add(`${quote(t.text)} has Chinese characters in it, in a drawing that is not in Chinese: write it in the user's language.`);

  // The lines and arrows, from the same reading. Each kind keeps some room: past eight text
  // problems, half the list is still the arrows', which is what went wrong for the owner.
  const lineFound = lineIssues(d);
  const room = Math.max(MAX_ISSUES - lineFound.length, MAX_ISSUES / 2);
  const all = [...issues.slice(0, room)];
  for (const s of lineFound) if (all.length < MAX_ISSUES && !all.includes(s)) all.push(s);
  return { issues: all, canvas };
}
