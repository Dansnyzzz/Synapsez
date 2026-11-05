/**
 * Setting words into lines: the one thing all three formats share.
 *
 * In goes a paragraph's content, as runs with styles, tabs, breaks and boxes (an
 * inline picture is a box). Out come lines with every word's position, which the
 * format places and paints. Heights are left to the format through `metrics`,
 * because Word, PowerPoint and Excel each mean something different by a line.
 *
 * The breaking follows what Office does and a browser does not: a run boundary is
 * not a break opportunity, so "Hel" + bold "lo" stays one word; a space at the end
 * of a line hangs past the margin and takes no room; a word too long for a line
 * breaks at the character rather than running off the page.
 */

/**
 * @typedef {{
 *   pick: import('./fonts.js').Pick, size: number, color: string,
 *   underline?: boolean|string, strike?: boolean, doubleStrike?: boolean, highlight?: string|null,
 *   shift?: number, spacing?: number, caps?: boolean, smallCaps?: boolean, foot?: any,
 * }} TextStyle
 *   `size` in points as the file says it. `shift` raises the baseline, in ems, for a superscript.
 *
 * @typedef {{ type: 'text', text: string, style: TextStyle }
 *   | { type: 'tab', style?: TextStyle, stop?: { pos: number, kind: string, leader?: string } }
 *   | { type: 'br', style?: TextStyle }
 *   | { type: 'box', width: number, height: number, descent?: number, paint: (surface: any, x: number, top: number) => void, style?: TextStyle }} Inline
 *
 * @typedef {{ k: 't', x: number, w: number, text: string, style: TextStyle, pieces: { text: string, pick: any, w: number }[], space?: boolean }
 *   | { k: 'b', x: number, w: number, h: number, paint: Function, descent: number }
 *   | { k: 'lead', x: number, w: number, char: string, style: TextStyle }} Placed
 *
 * @typedef {{ items: Placed[], width: number, asc: number, desc: number, gap: number, boxH: number, height: number, baseline: number, left: number, spaces: number }} Line
 */

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯\u{20000}-\u{2FFFF}]/u;
/** A word may break after one of these, as Word breaks it. */
const BREAK_AFTER = /[-‐‒–—]/;

/** Text ready to set: composed, so a file written on a Mac draws its accents; controls gone. */
export function cleanText(text) {
  return String(text ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u00AD\u200B-\u200F\u2060\uFEFF]/g, '');
}

/** Words and spaces, each with whether a line may break after it. */
function tokens(text) {
  const out = [];
  let word = '';
  const push = (breakAfter) => {
    if (word) out.push({ text: word, space: false, breakAfter });
    word = '';
  };
  for (const ch of text) {
    if (ch === ' ' || ch === '　') {
      push(false);
      const last = out[out.length - 1];
      if (last?.space) last.text += ch;
      else out.push({ text: ch, space: true, breakAfter: true });
    } else if (CJK.test(ch)) {
      push(true);
      out.push({ text: ch, space: false, breakAfter: true });
    } else {
      word += ch;
      if (BREAK_AFTER.test(ch)) push(true);
    }
  }
  push(false);
  return out;
}

/** The text and size a style really draws, once capitals are applied. */
function shaped(text, style) {
  if (style.caps) return { text: text.toUpperCase(), size: style.size };
  if (style.smallCaps) return { text: text.toUpperCase(), size: style.size * 0.8 };
  return { text, size: style.size };
}

/** The size text is actually drawn at, on a raised or lowered baseline. */
const drawnSize = (style, size) => (style.shift ? size * 0.65 : size);

/**
 * Set a paragraph into lines.
 *
 * @param {Inline[]} inlines
 * @param {{
 *   width: number, first?: number, rest?: number, align?: string, wrap?: boolean,
 *   tabs?: { pos: number, kind: string, leader?: string }[], defaultTab?: number,
 *   empty?: TextStyle, metrics?: (line: Line) => void,
 *   exclude?: (y: number) => { left?: number, right?: number, skip?: number } | null, startY?: number, lastAlign?: string,
 *   fonts: import('./fonts.js').Fonts, measure: import('./common.js').Measurer, budget?: import('./common.js').Budget,
 * }} options
 *   `width` is the measure the paragraph has; `first` and `rest` are where its lines
 *   start inside that. `metrics` sets `height` and `baseline` on each finished line.
 * @returns {Line[]}
 */
export function setLines(inlines, options) {
  const { width, first = 0, rest = 0, align = 'left', wrap = true, tabs = [], defaultTab = 36, empty, metrics, exclude, fonts, measure, budget } = options;
  let y = options.startY || 0;
  /** @type {Line[]} */
  const lines = [];
  /** @type {Line} */
  let line;
  let x = 0;
  let band = { left: 0, right: 0 };
  /** A centre or right tab being filled: what follows it shifts back when it ends. */
  let openTab = null;

  const open = (start) => {
    band = { left: 0, right: 0 };
    const hit = exclude?.(y);
    if (hit?.skip) y = hit.skip;
    if (hit) band = { left: hit.left || 0, right: hit.right || 0 };
    line = { items: [], width: 0, asc: 0, desc: 0, gap: 0, boxH: 0, height: 0, baseline: 0, left: start + band.left, spaces: 0 };
    x = start + band.left;
  };

  const roomRight = () => width - band.right;

  const note = (style, size) => {
    const { pick } = style;
    line.asc = Math.max(line.asc, pick.asc * size);
    line.desc = Math.max(line.desc, pick.desc * size);
    line.gap = Math.max(line.gap, pick.gap * size);
  };

  const closeTab = () => {
    if (!openTab) return;
    const { stop, from, startX } = openTab;
    const used = x - startX;
    const shift = stop.kind === 'center' ? stop.pos - used / 2 - startX : stop.pos - used - startX;
    const by = Math.max(0, shift);
    for (let i = from; i < line.items.length; i += 1) line.items[i].x += by;
    if (stop.leader && by > 0) line.items.splice(from, 0, { k: 'lead', x: startX, w: by, char: stop.leader, style: openTab.style });
    x += by;
    openTab = null;
  };

  const close = (hard) => {
    closeTab();
    // Spaces at the end of a line hang: they are not part of its width.
    while (line.items.length && /** @type {any} */ (line.items[line.items.length - 1]).space) line.items.pop();
    const last = line.items[line.items.length - 1];
    line.width = last ? last.x + last.w : line.left;
    line.spaces = line.items.filter((item) => /** @type {any} */ (item).space).length;
    if (!line.asc && !line.desc) {
      const style = empty || /** @type {any} */ (inlines.find((inline) => inline.style))?.style;
      if (style) note(style, style.size);
    }
    alignLine(line, hard ? options.lastAlign || (align === 'both' ? 'left' : align) : align, roomRight());
    if (metrics) metrics(line);
    else {
      line.height = line.asc + line.desc + line.gap;
      line.baseline = line.asc + line.gap;
    }
    y += line.height;
    lines.push(line);
  };

  const placeWord = (word) => {
    const { pieces, w, style } = word;
    line.items.push({ k: 't', x, w, text: word.text, style, pieces, space: false });
    note(style, shaped('', style).size);
    x += w;
  };

  const placeSpace = (space) => {
    line.items.push({ k: 't', x, w: space.w, text: space.text, style: space.style, pieces: [], space: true });
    note(space.style, shaped('', space.style).size);
    x += space.w;
  };

  /** A word wider than a whole line goes character by character. */
  const breakWord = (word) => {
    const { style } = word;
    const { size } = shaped('', style);
    let piece = '';
    for (const ch of word.text) {
      const trial = piece + ch;
      const w = measureWord(trial, style, size);
      if (piece && x + w > roomRight() + 0.01) {
        placeWord(buildWord(piece, style));
        close(false);
        open(rest);
        piece = ch;
      } else piece = trial;
    }
    if (piece) placeWord(buildWord(piece, style));
  };

  const measureWord = (text, style, size) => {
    const spacing = style.spacing || 0;
    let w = spacing * [...text].length;
    for (const part of fonts.pieces(text, style.pick)) w += measure.width(part.pick, drawnSize(style, size), part.text);
    return w;
  };

  const buildWord = (text, style) => {
    const { size } = shaped('', style);
    const shown = drawnSize(style, size);
    const spacing = style.spacing || 0;
    const parts = fonts.pieces(text, style.pick).map((part) => ({
      text: part.text,
      pick: part.pick,
      w: measure.width(part.pick, shown, part.text) + spacing * [...part.text].length,
    }));
    return { text, style, pieces: parts, w: parts.reduce((sum, part) => sum + part.w, 0) };
  };

  /** Words not yet placed: they stay together until a break opportunity. */
  let cluster = [];
  let clusterW = 0;
  /** Spaces waiting to see whether the next word fits on this line. */
  let pendingSpaces = [];

  const flush = () => {
    if (!cluster.length) return;
    const spaceW = pendingSpaces.reduce((sum, space) => sum + space.w, 0);
    if (wrap && !openTab && line.items.length && x + spaceW + clusterW > roomRight() + 0.01) {
      close(false);
      open(rest);
      pendingSpaces = [];
    }
    for (const space of pendingSpaces) placeSpace(space);
    pendingSpaces = [];
    for (const word of cluster) {
      if (word.box) {
        line.items.push({ k: 'b', x, w: word.w, h: word.h, paint: word.paint, descent: word.descent || 0 });
        line.boxH = Math.max(line.boxH, word.h - (word.descent || 0));
        line.desc = Math.max(line.desc, word.descent || 0);
        x += word.w;
      } else if (wrap && word.w > roomRight() - line.left + 0.01 && word.text.length > 1) breakWord(word);
      else placeWord(word);
    }
    cluster = [];
    clusterW = 0;
  };

  open(first);
  for (const inline of inlines) {
    budget?.check();
    if (inline.type === 'text') {
      const text = cleanText(inline.text);
      if (!text) continue;
      const { size } = shaped('', inline.style);
      for (const token of tokens(shaped(text, inline.style).text)) {
        if (token.space) {
          flush();
          pendingSpaces.push({ text: token.text, w: measureWord(token.text, inline.style, size), style: inline.style });
          continue;
        }
        const word = buildWord(token.text, inline.style);
        cluster.push(word);
        clusterW += word.w;
        if (token.breakAfter) flush();
      }
    } else if (inline.type === 'tab') {
      flush();
      for (const space of pendingSpaces) placeSpace(space);
      pendingSpaces = [];
      closeTab();
      if (inline.style) note(inline.style, inline.style.size);
      const stop = inline.stop || tabs.find((tab) => tab.pos > x + 0.01) || { pos: (Math.floor((x + 0.01) / defaultTab) + 1) * defaultTab, kind: 'left' };
      if (stop.kind === 'center' || stop.kind === 'right' || stop.kind === 'end' || stop.kind === 'decimal') {
        openTab = { stop, from: line.items.length, startX: x, style: inline.style };
      } else {
        const to = Math.max(x, stop.pos);
        if (stop.leader && to > x && inline.style) line.items.push({ k: 'lead', x, w: to - x, char: stop.leader, style: inline.style });
        x = to;
      }
    } else if (inline.type === 'br') {
      flush();
      for (const space of pendingSpaces) placeSpace(space);
      pendingSpaces = [];
      if (inline.style) note(inline.style, inline.style.size);
      close(true);
      open(rest);
    } else if (inline.type === 'box') {
      cluster.push({ box: true, w: inline.width, h: inline.height, descent: inline.descent, paint: inline.paint });
      clusterW += inline.width;
      flush();
    }
  }
  flush();
  for (const space of pendingSpaces) placeSpace(space);
  close(true);
  return lines;
}

/** Move a finished line's words to where its alignment wants them. */
function alignLine(line, align, room) {
  const free = room - line.width;
  if (free <= 0.01) return;
  let by = 0;
  if (align === 'center' || align === 'ctr') by = free / 2;
  else if (align === 'right' || align === 'end' || align === 'r') by = free;
  if (by) {
    for (const item of line.items) item.x += by;
    line.width += by;
    return;
  }
  if ((align === 'both' || align === 'just' || align === 'justify' || align === 'distribute' || align === 'dist') && line.spaces) {
    const each = free / line.spaces;
    let extra = 0;
    for (const item of line.items) {
      item.x += extra;
      if (/** @type {any} */ (item).space) {
        extra += each;
        item.w += each;
      }
    }
    line.width += free;
  }
}

/**
 * Paint a line: backgrounds under it, then words, then rules.
 *
 * @param {import('./common.js').Surface} surface
 * @param {Line} line
 * @param {number} ox  the paragraph's left
 * @param {number} top  the top of the line
 */
export function paintLine(surface, line, ox, top) {
  const base = top + line.baseline;
  for (const item of line.items) {
    if (item.k !== 't') continue;
    const style = item.style;
    if (style.highlight) {
      const size = style.size;
      const pick = style.pick;
      surface.rect(ox + item.x, base - pick.asc * size, item.w, (pick.asc + pick.desc) * size, style.highlight);
    }
  }
  for (const item of line.items) {
    if (item.k === 'b') {
      item.paint(surface, ox + item.x, base - item.h + item.descent);
      continue;
    }
    if (item.k === 'lead') {
      paintLeader(surface, item, ox, base);
      continue;
    }
    const style = item.style;
    const size = shaped('', style).size;
    const shown = drawnSize(style, size);
    const raised = base - (style.shift || 0) * size;
    if (!item.space) {
      let px = ox + item.x;
      for (const piece of item.pieces) {
        surface.text(piece.text, px, raised, { pick: piece.pick, size: shown, color: style.color, spacing: style.spacing || 0 });
        px += piece.w;
      }
    }
    const thick = Math.max(0.5, size * 0.055);
    if (style.underline) {
      const uy = raised + size * 0.13;
      surface.rect(ox + item.x, uy, item.w, thick, style.color);
      if (style.underline === 'double') surface.rect(ox + item.x, uy + thick * 2, item.w, thick, style.color);
    }
    if (style.strike) surface.rect(ox + item.x, raised - size * 0.27, item.w, thick, style.color);
    if (style.doubleStrike) {
      surface.rect(ox + item.x, raised - size * 0.33, item.w, thick, style.color);
      surface.rect(ox + item.x, raised - size * 0.21, item.w, thick, style.color);
    }
  }
}

/** A tab's dots, each on the same grid, the way a table of contents lines them up. */
function paintLeader(surface, item, ox, base) {
  const glyph = item.char === 'hyphen' ? '-' : item.char === 'underscore' ? '_' : item.char === 'middleDot' ? '·' : '.';
  const size = item.style.size;
  const step = Math.max(2, size * 0.28);
  const from = Math.ceil((ox + item.x) / step) * step;
  for (let x = from; x + step <= ox + item.x + item.w - step / 2; x += step) {
    surface.text(glyph, x, base, { pick: item.style.pick, size, color: item.style.color });
  }
}
