/*
 * A laid-out diagram (layout.js) drawn as one SVG (owner, 2026-11-17: "flexible adaptive
 * smartest beautiful, chuyên nghiệp, high advanced, đẹp"). The layout decided where every box
 * and arrow goes; this decides only how they look, so nothing here can move a line onto a box.
 *
 * The look, from the spec's "Adaptive and professional":
 *   - the drawing on its own canvas, so a label's backing is the colour behind it and a kept
 *     .svg reads the same opened on its own as in the conversation;
 *   - each group a container in its own accent: a tint the cards stand out from (STAND_OUT),
 *     a 1 px edge, its title in the accent's deep shade;
 *   - each box a card with an 8 px radius and a soft shadow; a pill fully rounded; a note
 *     lighter, dashed and in muted ink, with no shadow, because it is an aside;
 *   - titles 14 px semibold, lines 12.5 px muted, edge labels 11.5 px on a backing;
 *   - edges 1.5 px slate, one 7 px arrowhead for all of them, dashed 5/4 when asked.
 *
 * Every colour is a plain hex, never an opacity: the drawing check reads fills to judge
 * contrast, and a tint written as opacity would be judged as the full accent. Each text pair
 * keeps 4.5:1 in both themes (test/diagram.test.mjs computes them).
 *
 * Pure and deterministic, like the layout: the same layout always gives the same markup.
 */

import { TEXT, FIT, lineHeight } from './measure.js';
import { ICONS, ICON_GRID } from './icons.js';
import { contrast, colour } from '../widgetCheck.js';

const hex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// `share` of colour a laid over b, as one solid colour.
const mix = (a, b, share) => hex(rgbOf(a).map((c, i) => c * share + rgbOf(b)[i] * (1 - share)));

// Eight accents, as many as a diagram may have groups, so no two groups share one: the
// accent itself, and the dark (light theme) or pale (dark theme) shade its text is set in —
// 800 on light, deep enough for 4.5:1 on the stronger tints below.
const ACCENTS = {
  light: [
    ['#3B82F6', '#1E40AF'],
    ['#10B981', '#065F46'],
    ['#8B5CF6', '#5B21B6'],
    ['#F59E0B', '#92400E'],
    ['#F43F5E', '#9F1239'],
    ['#06B6D4', '#155E75'],
    ['#84CC16', '#3F6212'],
    ['#64748B', '#1E293B'],
  ],
  dark: [
    ['#60A5FA', '#93C5FD'],
    ['#34D399', '#6EE7B7'],
    ['#A78BFA', '#C4B5FD'],
    ['#F59E0B', '#FCD34D'],
    ['#FB7185', '#FDA4AF'],
    ['#22D3EE', '#67E8F9'],
    ['#A3E635', '#BEF264'],
    ['#94A3B8', '#CBD5E1'],
  ],
};

// A card must stand out from the group it sits in (review, 2026-11-18: dark cards measured
// 1.00–1.05:1 against their tints and vanished). These hold in both themes, and the tests
// compute them: a card's fill at least 1.25:1 against every tint, its edge at least 2:1.
export const STAND_OUT = Object.freeze({ fill: 1.25, edge: 2 });

const BASE = {
  light: {
    canvas: '#FFFFFF',
    ink: '#1F2937',
    muted: '#4B5563',
    line: '#64748B',
    card: '#FFFFFF',
    cardEdge: '#8696AB',
    pill: '#FFFFFF',
    pillEdge: '#8696AB',
    note: '#F8FAFC',
    noteEdge: '#8696AB',
    icon: '#475569',
    shadow: ['#0F172A', 0.06],
    // White cards can only stand out from a tint darker than white, so each accent is mixed in
    // as far as it takes to reach 1.27:1 (a pale amber needs more than a deep violet).
    tintTo: 1.27,
    tintBase: '#FFFFFF',
    groupEdge: 0.55,
  },
  // The page's own dark paper (public/js/render.js), so a dark drawing on a light page sits on
  // exactly the colour the page gives it.
  dark: {
    canvas: '#0F1720',
    ink: '#E5E7EB',
    muted: '#A3ADBB',
    line: '#8391A5',
    card: '#2C3A4E',
    cardEdge: '#536379',
    pill: '#2C3A4E',
    pillEdge: '#536379',
    note: '#131C27',
    noteEdge: '#536379',
    icon: '#A3ADBB',
    // A shadow is a darkening, and on a dark canvas 6 % of one is nothing: there it is stronger.
    shadow: ['#000000', 0.35],
    // Mixed into a neutral dark rather than the navy canvas: navy's blue cancels amber's red
    // and turned that group olive (review, 2026-11-18).
    tintShare: 0.1,
    tintBase: '#121417',
    groupEdge: 0.45,
  },
};

// The least share of an accent, in hundredths, that sets a card `ratio`:1 apart from the tint.
function tintFor(accent, base) {
  for (let share = 0.02; share < 0.6; share += 0.01) {
    const fill = mix(accent, base.tintBase, share);
    if (contrast(colour(base.card), colour(fill)) >= base.tintTo) return fill;
  }
  return mix(accent, base.tintBase, 0.6);
}

/**
 * Every colour of a theme: its base, and each group accent with the tint its container is
 * filled with and the edge drawn round it.
 */
export function palette(theme = 'light') {
  const base = BASE[theme] || BASE.light;
  const accents = (ACCENTS[theme] || ACCENTS.light).map(([accent, ink]) => ({
    accent,
    ink,
    fill: base.tintTo ? tintFor(accent, base) : mix(accent, base.tintBase, base.tintShare),
    edge: mix(accent, base.canvas, base.groupEdge),
  }));
  return { ...base, accents };
}

const DESC_MAX = 2000;

const escape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Two decimals at most: enough for a crisp line, and a smaller drawing to keep.
const n = (v) => String(Math.round(v * 100) / 100 + 0);

// Where the first line's baseline goes in a line box: half the box down, then a third of the
// size more, which centres the capitals (the drawing check reads `y` as the baseline).
const baseline = (top, size) => top + lineHeight(size) / 2 + size * 0.35;

// A short, stable name for this drawing's marker and shadow, so two drawings on one page
// cannot borrow each other's (FNV-1a of the layout).
function idOf(layout, theme) {
  let h = 0x811c9dc5;
  for (const ch of `${theme}${JSON.stringify(layout)}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * @param {ReturnType<typeof import('./layout.js').layoutDiagram>} layout
 * @param {{ theme?: string, title?: string }} [options]
 *   the theme the drawing is for, and its caption, given to a screen reader as its name
 * @returns {string} one `<svg>` element
 */
export function renderDiagram(layout, { theme = 'light', title = '' } = {}) {
  const P = palette(theme);
  const id = idOf(layout, theme);
  const W = layout.width;
  const H = layout.height;
  // Wider than the widest drawing, it scales down through the viewBox: the text stays text.
  const scale = Math.min(1, FIT.maxWidth / W);
  const accentOf = new Map(layout.groups.map((g, i) => [g.id, P.accents[i % P.accents.length]]));
  const titleOf = new Map(layout.nodes.map((nd) => [nd.id, nd.title]));
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" id="d${id}" viewBox="0 0 ${n(W)} ${n(H)}" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" style="font-family: system-ui, sans-serif" role="img"${title ? ` aria-label="${escape(title)}"` : ''}>`,
  );
  // What a screen reader says the drawing shows: each arrow in words, as it was given, then
  // any box no arrow touches. Cut at 2,000 characters, so a big drawing's description does not
  // cost more to keep than the drawing.
  const said = layout.edges.map((e) => `${titleOf.get(e.from)} → ${titleOf.get(e.to)}${e.label ? ` (${e.label})` : ''}`);
  const alone = layout.nodes.filter((nd) => !layout.edges.some((e) => e.from === nd.id || e.to === nd.id)).map((nd) => nd.title);
  // Cut by character, not by UTF-16 unit, so an emoji is never split into half a character.
  const described = [...[...said, ...alone].join('; ')];
  out.push(`<desc>${escape(described.length > DESC_MAX ? `${described.slice(0, DESC_MAX).join('')}…` : described.join(''))}</desc>`);

  const [shadowColour, shadowOpacity] = P.shadow;
  out.push(
    '<defs>',
    // The tip lands a pixel past the line's end, so the line's square end is hidden inside the
    // arrowhead and the point reaches the box's edge.
    `<marker id="a${id}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10z" fill="${P.line}"/></marker>`,
    `<filter id="s${id}" x="-10%" y="-10%" width="120%" height="140%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="${shadowColour}" flood-opacity="${shadowOpacity}"/></filter>`,
    '</defs>',
  );
  // Every rule under this drawing's own id: a kept .svg pasted inline into another page then
  // styles only itself, never that page's text (review, 2026-11-18).
  const own = `#d${id}`;
  out.push(
    '<style>' +
      `${own} text{text-anchor:middle}` +
      `${own} .t{font-size:${TEXT.titleSize}px;font-weight:600;fill:${P.ink}}` +
      `${own} .u{font-size:${TEXT.titleSize}px;font-weight:600;fill:${P.muted}}` +
      `${own} .l{font-size:${TEXT.lineSize}px;fill:${P.muted}}` +
      `${own} .c{font-size:${TEXT.labelSize}px;fill:${P.muted}}` +
      `${own} .h{font-size:${TEXT.groupTitleSize}px;font-weight:600;text-anchor:start}` +
      '</style>',
  );
  out.push(`<rect width="${n(W)}" height="${n(H)}" rx="12" fill="${P.canvas}"/>`);

  // Groups first, underneath everything they hold.
  for (const g of layout.groups) {
    const a = accentOf.get(g.id);
    out.push(`<rect x="${n(g.x)}" y="${n(g.y)}" width="${n(g.w)}" height="${n(g.h)}" rx="12" fill="${a.fill}" stroke="${a.edge}"/>`);
    if (g.titleBox) {
      g.titleLines.forEach((line, i) => {
        const y = baseline(g.titleBox.y + i * lineHeight(TEXT.groupTitleSize), TEXT.groupTitleSize);
        out.push(`<text class="h" x="${n(g.titleBox.x)}" y="${n(y)}" fill="${a.ink}">${escape(line)}</text>`);
      });
    }
  }

  // Edges under the boxes: each ends on a box's edge, so a box drawn over it hides nothing but
  // the pixel the arrowhead's tip reaches in.
  out.push(`<g fill="none" stroke="${P.line}" stroke-width="1.5" stroke-linejoin="round">`);
  for (const e of layout.edges) {
    const d = e.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('');
    out.push(`<path d="${d}"${e.style === 'dashed' ? ' stroke-dasharray="5 4"' : ''} marker-end="url(#a${id})"/>`);
  }
  out.push('</g>');

  for (const nd of layout.nodes) {
    const a = nd.group ? accentOf.get(nd.group) : null;
    const [fill, edge] = nd.kind === 'note' ? [P.note, P.noteEdge] : nd.kind === 'pill' ? [P.pill, P.pillEdge] : [P.card, P.cardEdge];
    const rx = nd.kind === 'pill' ? nd.radius : 8;
    const look = nd.kind === 'note' ? ' stroke-dasharray="4 3"' : ` filter="url(#s${id})"`;
    out.push(`<rect x="${n(nd.x)}" y="${n(nd.y)}" width="${n(nd.w)}" height="${n(nd.h)}" rx="${n(rx)}" fill="${fill}" stroke="${edge}"${look}/>`);

    const t = nd.textBox;
    const cx = t.x + t.w / 2;
    let top = t.y;
    // Own keys only: "constructor" is on every object, and would be drawn as its source text.
    if (nd.icon && Object.hasOwn(ICONS, nd.icon)) {
      const k = TEXT.iconSize / ICON_GRID;
      const colour = nd.kind === 'note' ? P.muted : a ? a.ink : P.icon;
      out.push(
        `<g transform="translate(${n(cx - TEXT.iconSize / 2)} ${n(top)}) scale(${n(k)})" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[nd.icon]}</g>`,
      );
      top += TEXT.iconSize + TEXT.iconGap;
    }
    const cls = nd.kind === 'note' ? 'u' : 't';
    for (const line of nd.titleLines) {
      out.push(`<text class="${cls}" x="${n(cx)}" y="${n(baseline(top, TEXT.titleSize))}">${escape(line)}</text>`);
      top += lineHeight(TEXT.titleSize);
    }
    if (nd.lines.length) top += TEXT.titleGap;
    for (const line of nd.lines) {
      out.push(`<text class="l" x="${n(cx)}" y="${n(baseline(top, TEXT.lineSize))}">${escape(line)}</text>`);
      top += lineHeight(TEXT.lineSize);
    }
  }

  // Labels last, over the line they name, each on a backing in the colour behind it: the fill
  // of the group that holds it, or the canvas — never a white patch on a tint (review,
  // 2026-11-18). The layout keeps every label wholly inside a group or wholly outside.
  const holds = (g, b) => b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h;
  for (const e of layout.edges) {
    if (!e.labelBox) continue;
    const b = e.labelBox;
    const host = layout.groups.find((g) => holds(g, b));
    out.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="4" fill="${host ? accentOf.get(host.id).fill : P.canvas}"/>`);
    e.labelLines.forEach((line, i) => {
      const y = baseline(b.y + TEXT.labelPadding + i * lineHeight(TEXT.labelSize), TEXT.labelSize);
      out.push(`<text class="c" x="${n(b.x + b.w / 2)}" y="${n(y)}">${escape(line)}</text>`);
    });
  }

  out.push('</svg>');
  return out.join('');
}
