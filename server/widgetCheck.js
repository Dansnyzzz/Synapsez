/*
 * What a reader would see wrong in an SVG diagram, before it is shown (owner, 2026-11-11,
 * screenshots of a relationship diagram: a title in dark grey on the dark theme, a
 * legend whose lines ran out of their box and off the drawing, labels on top of each
 * other, a Chinese word inside Vietnamese text).
 *
 * No renderer on the server, so this reads the markup and estimates: a line of text is
 * about 0.55 of its font size wide per letter (0.6 bold, 1 for a CJK character) — close
 * enough to catch a line twice as wide as its box, which is what goes wrong. Positions
 * inside a transformed group are not trusted, so those texts are only checked for colour,
 * size and language. Classes in a <style> block are read for font size, fill, weight and
 * anchor; nothing else of CSS is.
 *
 * The answer is a list of problems, worded for the model to fix, and the canvas the
 * drawing was made for — light (dark text) or dark (light text) — so the page can give it
 * that background.
 */

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const LATIN = /[A-Za-zÀ-ỹ]{2,}/;
const MAX_ISSUES = 8;

const num = (v) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** Attributes of one tag. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? '';
  for (const part of String(out.style || '').split(';')) {
    const [k, ...v] = part.split(':');
    if (k && v.length) out[k.trim().toLowerCase()] = v.join(':').trim();
  }
  return out;
}

/** Simple CSS rules from <style> blocks: `.name{…}` and `text{…}`. */
function cssRules(svg) {
  const rules = {};
  for (const block of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rule of block[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decl = {};
      for (const part of rule[2].split(';')) {
        const [k, ...v] = part.split(':');
        if (k && v.length) decl[k.trim().toLowerCase()] = v.join(':').trim();
      }
      for (const sel of rule[1].split(',')) rules[sel.trim()] = { ...(rules[sel.trim()] || {}), ...decl };
    }
  }
  return rules;
}

const decode = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** A colour as [r, g, b], from #rgb, #rrggbb, rgb() or a few names; null for none, gradients, currentColor. */
export function colour(value) {
  const v = String(value || '').trim().toLowerCase();
  const names = { white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128], navy: [0, 0, 128], blue: [0, 0, 255], green: [0, 128, 0] };
  if (names[v]) return names[v];
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

/**
 * @param {string} svg
 * @returns {{ issues: string[], canvas: 'light' | 'dark' | null }}
 */
export function checkDiagram(svg) {
  const markup = String(svg || '');
  const rules = cssRules(markup);
  const root = attrs((/<svg\b[^>]*>/i.exec(markup) || [''])[0]);
  const vb = String(root.viewbox || '').split(/[\s,]+/).map(Number);
  const view = vb.length === 4 && vb.every(Number.isFinite) ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : num(root.width) && num(root.height) ? { x: 0, y: 0, w: num(root.width), h: num(root.height) } : null;

  const styleOf = (a) => {
    const fromClass = String(a.class || '').split(/\s+/).filter(Boolean).reduce((acc, c) => ({ ...acc, ...(rules[`.${c}`] || {}), ...(rules[`text.${c}`] || {}) }), {});
    return { ...(rules.text || {}), ...fromClass, ...a };
  };

  // Rectangles drawn outside any transformed group, with their fill.
  const rects = [];
  const texts = [];
  let depth = 0;
  for (const m of markup.matchAll(/<(\/?)(g|rect|text)\b([^>]*?)(\/?)>|<\/text>/gi)) {
    const [whole, closing, tag, , selfClose] = m;
    const name = String(tag || '').toLowerCase();
    if (name === 'g') {
      if (closing) depth = Math.max(0, depth - 1);
      else if (!selfClose && /transform\s*=/.test(whole)) depth += 1;
      else if (!selfClose && depth > 0) depth += 1;
      continue;
    }
    if (name === 'rect' && !closing) {
      const a = attrs(whole);
      const r = { x: num(a.x) ?? 0, y: num(a.y) ?? 0, w: num(a.width), h: num(a.height), fill: colour(a.fill), moved: depth > 0 || /transform\s*=/.test(whole) };
      if (r.w && r.h) rects.push(r);
    }
    if (name === 'text' && !closing) {
      const end = markup.indexOf('</text>', m.index);
      const inner = end > 0 ? markup.slice(m.index + whole.length, end) : '';
      const a = styleOf(attrs(whole));
      const size = num(a['font-size']) ?? 16;
      const bold = /bold|[6-9]00/.test(String(a['font-weight'] || ''));
      const anchor = String(a['text-anchor'] || 'start');
      const fill = colour(a.fill);
      const moved = depth > 0 || /transform\s*=/.test(whole);
      // Lines: each <tspan> with its own x or dy is a line; otherwise the whole is one.
      const spans = [...inner.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi)];
      // A line's y: its own, or the line before's moved by its dy (in em or units).
      let runY = num(a.y) ?? 0;
      const lines = spans.length && spans.some((s) => /\s(x|dy)\s*=/.test(s[1]))
        ? spans.map((s) => {
            const sa = attrs(s[0]);
            const dyRaw = String(sa.dy || '');
            const dy = /em$/.test(dyRaw) ? (num(dyRaw) ?? 0) * size : num(dyRaw) ?? 0;
            runY = num(sa.y) ?? runY + dy;
            return { text: decode(s[2]), x: num(sa.x) ?? num(a.x) ?? 0, y: runY };
          })
        : [{ text: decode(inner), x: num(a.x) ?? 0, y: num(a.y) ?? 0 }];
      for (const line of lines) if (line.text) texts.push({ ...line, size, bold, anchor, fill, moved });
    }
  }

  const widthOf = (t) => [...t.text].reduce((s, ch) => s + (HAN.test(ch) ? 1 : t.bold ? 0.6 : 0.55), 0) * t.size;
  const boxOf = (t) => {
    const w = widthOf(t);
    const x0 = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
    return { x0, x1: x0 + w, y0: t.y - t.size * 0.8, y1: t.y + t.size * 0.25, w };
  };

  // The canvas it was drawn for: a background covering the drawing, else what its text is.
  const backdrop = view ? rects.find((r) => !r.moved && r.fill && r.w * r.h >= view.w * view.h * 0.85) : null;
  const inks = texts.map((t) => t.fill).filter(Boolean);
  const darkInk = inks.filter((c) => luminance(c) < 0.4).length;
  const canvas = backdrop ? (luminance(backdrop.fill) > 0.4 ? 'light' : 'dark') : inks.length ? (darkInk >= inks.length / 2 ? 'light' : 'dark') : null;
  const canvasColour = backdrop?.fill || (canvas === 'dark' ? [15, 23, 32] : [255, 255, 255]);

  const issues = [];
  const add = (s) => issues.length < MAX_ISSUES && !issues.includes(s) && issues.push(s);
  const placed = texts.filter((t) => !t.moved).map((t) => ({ t, b: boxOf(t) }));

  for (const { t, b } of placed) {
    if (view && (b.x0 < view.x - 2 || b.x1 > view.x + view.w + 2)) add(`${quote(t.text)} runs off the side of the drawing (about ${Math.round(b.w)} wide at x=${Math.round(t.x)}): shorten it, or break it into lines with <tspan x=… dy="1.2em">.`);
    const holder = rects
      .filter((r) => !r.moved && r !== backdrop && t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h + t.size * 0.3)
      .sort((p, q) => p.w * p.h - q.w * q.h)[0];
    if (holder && b.w > holder.w - 6) add(`${quote(t.text)} is wider than its box (about ${Math.round(b.w)} against ${Math.round(holder.w)}): shorten it, make the box wider, or break it into <tspan> lines.`);
    // Readable against what is behind it.
    const behind = holder?.fill || canvasColour;
    if (t.fill && contrast(t.fill, behind) < 3) add(`${quote(t.text)} is hard to read: its colour is too close to what is behind it (contrast ${contrast(t.fill, behind).toFixed(1)}:1, at least 4.5 is wanted).`);
  }
  for (let i = 0; i < placed.length; i += 1) {
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
  return { issues, canvas };
}
