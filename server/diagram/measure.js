/*
 * How big text is drawn, for the diagram layout, and for widgetCheck, which will import this
 * rather than keep its own copy. Kept apart from the layout so the checker can measure a
 * hand-drawn SVG without loading the whole engine, and so there is one estimate: a box the
 * layout sized is one the check passes.
 *
 * No renderer on the server, so this estimates: 0.55 em a letter, 0.6 em bold, 1 em a CJK
 * character. Text is counted in composed form, so a Vietnamese letter typed as a base and
 * its marks is one letter. Pure.
 */

import { DRAWING_FIT } from '../../public/js/drawing-fit.js';

// The characters counted a full em wide (the set widgetCheck has always used).
export const HAN = /[㐀-䶿一-鿿豈-﫿]/;

export const TEXT = Object.freeze({
  titleSize: 14,
  lineSize: 12.5,
  labelSize: 11.5,
  groupTitleSize: 12.5,
  lineHeight: 1.35,
  padding: 12,
  pillExtra: 8,
  titleGap: 4,
  minWidth: 120,
  maxWidth: 260,
  labelPadding: 4,
  labelMaxWidth: 160,
  groupTitleMaxWidth: 160,
  iconSize: 16,
  iconGap: 6,
});

export const lineHeight = (size) => size * TEXT.lineHeight;

// Where a drawing is read (review, 2026-11-18: the owner's standard is text a person can read
// in the conversation): the page's own rule, from the module it sizes drawings with
// (public/js/drawing-fit.js) — a 760 px column, a narrow drawing grown up to twice its size,
// a height cap of 72 % of an 800 px window that a server-laid-out diagram's titles never fall
// under 11 px for. "auto" scores both directions by it (layout.js chooseDirection); within 5 %
// the shape closer to 16:10 decides. Wider than 1,200, a drawing is drawn 1,200 wide.
export const FIT = Object.freeze({
  column: DRAWING_FIT.column,
  widen: DRAWING_FIT.widen,
  window: DRAWING_FIT.window,
  readablePx: DRAWING_FIT.readablePx,
  near: 0.05,
  aspect: 16 / 10,
  maxWidth: 1200,
});
// The scale at which a title reads at 11 px: what a diagram's widget tells the page.
export const READABLE_SCALE = DRAWING_FIT.readablePx / TEXT.titleSize;

/** How wide a line of text is drawn at `size` px. */
export function textWidth(text, size, bold = false) {
  let wide = 0;
  let narrow = 0;
  for (const ch of String(text ?? '').normalize('NFC')) {
    if (HAN.test(ch)) wide += 1;
    else narrow += 1;
  }
  return (wide + narrow * (bold ? 0.6 : 0.55)) * size;
}

/** Lines of at most maxWidth, broken between words, or between letters for a word that alone is wider. */
export function wrapText(text, maxWidth, size, bold = false) {
  const fits = (s) => textWidth(s, size, bold) <= maxWidth + 1e-9;
  const lines = [];
  let line = '';
  for (const word of String(text ?? '').normalize('NFC').split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (fits(word)) continue;
    // A long name, or CJK text with no spaces in it.
    let piece = '';
    for (const ch of word) {
      if (piece && !fits(piece + ch)) {
        lines.push(piece);
        piece = '';
      }
      piece += ch;
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A box's size from its text: the title (14 px bold) and lines (12.5 px) wrapped inside the
 * 260 px maximum, padded by 12 (a pill 8 more at its rounded ends), never under 120 wide. The
 * height is the padding, the title lines and, when there are lines, a 4 px gap and the lines,
 * each line 1.35 em, rounded up to a whole pixel. An icon sits centred above the title, 16 px
 * and a 6 px gap. `textW` × `textH` is the text block itself, icon included: a box the layout
 * grows for its arrows keeps this block, centred.
 */
export function measureNode(node) {
  const padX = TEXT.padding + (node.kind === 'pill' ? TEXT.pillExtra : 0);
  const room = TEXT.maxWidth - 2 * padX;
  const titleLines = wrapText(node.title, room, TEXT.titleSize, true);
  const lines = (node.lines || []).flatMap((line) => wrapText(line, room, TEXT.lineSize));
  const widest = Math.max(0, ...titleLines.map((l) => textWidth(l, TEXT.titleSize, true)), ...lines.map((l) => textWidth(l, TEXT.lineSize)));
  const w = Math.min(TEXT.maxWidth, Math.max(TEXT.minWidth, Math.ceil(widest + 2 * padX)));
  const iconH = node.icon ? TEXT.iconSize + TEXT.iconGap : 0;
  const textH = iconH + titleLines.length * lineHeight(TEXT.titleSize) + (lines.length ? TEXT.titleGap + lines.length * lineHeight(TEXT.lineSize) : 0);
  return { w, h: Math.ceil(2 * TEXT.padding + textH), titleLines, lines, textW: w - 2 * padX, textH };
}

/** An edge label's lines (11.5 px, wrapped at 160) and its backing, 4 px around the text. */
export function measureLabel(label) {
  const lines = wrapText(label, TEXT.labelMaxWidth, TEXT.labelSize);
  const w = Math.ceil(Math.max(0, ...lines.map((l) => textWidth(l, TEXT.labelSize))) + 2 * TEXT.labelPadding);
  const h = Math.ceil(lines.length * lineHeight(TEXT.labelSize) + 2 * TEXT.labelPadding);
  return { lines, w, h };
}
