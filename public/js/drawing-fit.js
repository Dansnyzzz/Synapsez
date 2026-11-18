/*
 * How tall a drawing may stand in the conversation. Shared by the page (render.js fitDrawing)
 * and the server's diagram layout (server/diagram/layout.js chooseDirection), so the direction
 * the server picks is judged by the size the page will really show.
 *
 * Every drawing is capped at 72 % of the window's height and scaled down to fit, so a tall one
 * never pushes the conversation off the screen. A diagram the server laid out carries its own
 * `readableScale` on the widget — set by the server, never read from the markup, which a model
 * writes — and for it the cap never goes so low that its titles fall under 11 px: past that it
 * stands taller and the conversation scrolls past it (fix round 3: the owner's diagram showed
 * its titles at 6.2 px). The floor is never more than the drawing's own height at the width it
 * is shown, so whatever the value, a picture is at most its natural size.
 *
 * Width is the same rule across (fix round 4): a server-laid-out diagram too wide for the column
 * at 11 px titles is shown at the 11 px scale, and its frame scrolls sideways (readableWidth).
 * A hand-drawn widget keeps shrinking to the column.
 */

export const DRAWING_FIT = Object.freeze({
  // The width a drawing is shown in (fix round 4, measured from the page): a reply's `.msg` is
  // 780 wide less 2 × 22 padding, the `.widget`'s 1 px border each side, and the frame body's
  // 12 px padding each side (render.js widgetFrame) — 710. A test derives it from app.css and
  // render.js, so a CSS change cannot drift from it. And how far a narrow drawing may grow.
  column: 710,
  widen: 2,
  // The cap: this share of the window's height, at least 240; 800 when the window is unknown.
  heightShare: 0.72,
  minHeight: 240,
  window: 800,
  // The smallest title a server-laid-out diagram is shown with.
  readablePx: 11,
});

// A readable scale the page acts on: a number in (0, 1], as the server sends; nothing else.
export const isReadableScale = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1;

/**
 * The max-height, in px, for a drawing shown `shownWidth` wide.
 *
 * @param {{ windowHeight?: number, viewWidth?: number, viewHeight?: number, shownWidth?: number, readableScale?: number }} view
 *   the window's height; the drawing's viewBox; the width it is shown at; and, for a diagram the
 *   server laid out, the scale at which its titles read at 11 px
 */
export function drawingHeightCap({ windowHeight, viewWidth, viewHeight, shownWidth, readableScale } = {}) {
  const base = Math.max(DRAWING_FIT.minHeight, (windowHeight || DRAWING_FIT.window) * DRAWING_FIT.heightShare);
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!isReadableScale(readableScale) || !ok(viewWidth) || !ok(viewHeight) || !ok(shownWidth)) return base;
  return Math.max(base, viewHeight * Math.min(shownWidth / viewWidth, readableScale));
}

/**
 * The width, in px, a server-laid-out diagram must be shown at so its titles read at 11 px, when
 * that is wider than the width it now has; 0 when it already reads, or for anything else.
 *
 * @param {{ viewWidth?: number, shownWidth?: number, readableScale?: number }} view
 */
export function readableWidth({ viewWidth, shownWidth, readableScale } = {}) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!isReadableScale(readableScale) || !ok(viewWidth) || !ok(shownWidth)) return 0;
  const need = Math.ceil(viewWidth * readableScale);
  return shownWidth + 0.5 < need ? need : 0;
}
