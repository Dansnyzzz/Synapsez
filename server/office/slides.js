/**
 * The design of a deck: which layout each slide gets, and the shapes that draw it.
 *
 * The owner's 2026-10-25 round: decks came out as white slides with a title and
 * bullets — "just text added" — and they wanted them designed, laid out and
 * animated, with nothing left to do. Nothing here asks the model to design:
 * the layout is read off what a slide holds, the way a designer would.
 *
 *   cover      the first slide, when it is a title with a line or two under it
 *   section    a heading with nothing under it, part-way through
 *   closing    the last slide, when it says thanks, questions or contact
 *   stats      two to six points that each start with a figure — "45% …"
 *   table      a table: a real PowerPoint table, banded, its header in colour
 *   statement  one short paragraph and nothing else
 *   bullets    anything else; two columns when it runs long
 *
 * Every slide fades in (`p:transition`), and its content arrives a point at a
 * time on its own, no click needed (`p:timing`, "after previous") — so the deck
 * presents as it stands. Text is measured before it is placed: a slide that
 * would overflow is set smaller, and past the smallest readable size it
 * continues on a slide of its own.
 *
 * Every part of this is checked by opening the deck in PowerPoint itself (see
 * the suite): PowerPoint refuses a slide whose XML is out of schema order,
 * where every other reader shrugs.
 */
import { escapeXml } from './xml.js';
import { tint } from './theme.js';

/** 16:9, in English Metric Units — 914400 to the inch, 12700 to the point. */
export const W = 12192000;
export const H = 6858000;
const PT = 12700;
const M = 762000; // side margin
const TITLE = { y: 457200, h: 914400 };
const BODY_TOP = 1737360;
const BODY_BOTTOM = H - 731520; // above the footer
const FOOT_Y = H - 502920;

/** The fewest points that are still a "stats" slide, and the most. */
const STATS = { min: 2, max: 6 };
/** A figure at the start of a point: "45%", "$2.3M", "1.250.000 ₫", "120+", "3x". */
// The figure ends at a space, a separator or the bold round it — never part-way
// into a date ("15/03", "2026-03-15"), which is a point with a date, not a KPI.
const FIGURE = /^\s*(?:\*\*)?([+\-−]?(?:[$€£¥₫]\s?)?\d[\d.,]*(?:\s?(?:%|‰|[kKmMbB]\b|tr\b|triệu|tỷ|nghìn|ngàn|USD|VND|VNĐ|đ|₫|x\b|lần|năm|giờ|phút|km|kg|\+))?)(?![-/.]\d)(?=\*\*|\s|[:\-–—|]|$)(?:\*\*)?\s*(?:[:\-–—|]\s*)?(\S[\s\S]*)$/u;
const CLOSING = /cảm ơn|thank|q\s*&\s*a|hỏi\s*(?:&|và)?\s*đáp|liên hệ|contact|kết thúc|the end|questions/i;

/* ── text measurement ────────────────────────────────────────────────── */

/**
 * Roughly how many lines a paragraph takes in a box `width` EMU wide at `size`
 * hundredths of a point. Calibri averages about half an em a character, a
 * little more in capitals and Vietnamese with its stacked marks — 0.53 errs on
 * the side of a slide that fits.
 */
function linesFor(text, size, width) {
  const perLine = Math.max(8, Math.floor(width / ((size / 100) * PT * 0.53)));
  return String(text || '')
    .split('\n')
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

/** The height a list of points takes, in EMU. */
function heightFor(items, size, width, { gap = 0.55 } = {}) {
  let total = 0;
  for (const item of items) {
    const s = Math.max(1200, size - (item.level || 0) * 200);
    const indent = item.plain ? 0 : 342900 + (item.level || 0) * 342900;
    total += linesFor(item.text, s, width - indent) * (s / 100) * PT * 1.18 + (s / 100) * PT * gap;
  }
  return total;
}

/** The largest size, from `sizes`, at which the points fit the box — or null. */
function fittingSize(items, width, height, sizes) {
  for (const size of sizes) if (heightFor(items, size, width) <= height) return size;
  return null;
}

/* ── XML pieces ──────────────────────────────────────────────────────── */

const color = (hex, alpha = null) =>
  alpha == null ? `<a:srgbClr val="${hex}"/>` : `<a:srgbClr val="${hex}"><a:alpha val="${Math.round(alpha * 1000)}"/></a:srgbClr>`;
const solid = (hex, alpha = null) => `<a:solidFill>${color(hex, alpha)}</a:solidFill>`;
const gradient = (from, to, angle = 45) =>
  `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0">${color(from)}</a:gs><a:gs pos="100000">${color(to)}</a:gs></a:gsLst>` +
  `<a:lin ang="${Math.round(angle * 60000)}" scaled="0"/></a:gradFill>`;

/**
 * One run of text. `rPr` children in schema order: fill, then the typeface —
 * PowerPoint refuses the other way round.
 */
function run(text, { size, colour, bold = false, italic = false, underline = false, strike = false, face = '+mn-lt', alpha = null, lang = 'vi-VN' }) {
  const attrs = [`lang="${lang}"`, `sz="${size}"`, bold ? 'b="1"' : '', italic ? 'i="1"' : '', underline ? 'u="sng"' : '', strike ? 'strike="sngStrike"' : '', 'dirty="0"'].filter(Boolean).join(' ');
  return `<a:r><a:rPr ${attrs}>${solid(colour, alpha)}<a:latin typeface="${face}"/><a:cs typeface="${face}"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r>`;
}

/** Runs — bold, italic, code — with a soft line break for each `\n`. */
function runsXml(runs, style) {
  const out = [];
  for (const r of runs || []) {
    const pieces = String(r.text ?? '').split('\n');
    pieces.forEach((piece, i) => {
      if (i) out.push('<a:br/>');
      if (piece) {
        out.push(
          run(piece, {
            ...style,
            bold: style.bold || !!r.bold,
            italic: style.italic || !!r.italic,
            underline: !!r.underline,
            strike: !!r.strike,
            face: r.code ? 'Consolas' : style.face,
          }),
        );
      }
    });
  }
  return out.join('');
}

/**
 * One paragraph. `pPr` children in schema order: line spacing, space before,
 * then the bullet's colour, size, font and character.
 */
function para(content, { align = 'l', bullet = null, level = 0, before = 0, line = 100, marL = 0, indent = 0, endSize = 1800 } = {}) {
  const lvl = level ? ` lvl="${level}"` : '';
  const margins = marL || indent ? ` marL="${marL}" indent="${indent}"` : '';
  const spacing = `<a:lnSpc><a:spcPct val="${line * 1000}"/></a:lnSpc>${before ? `<a:spcBef><a:spcPts val="${before}"/></a:spcBef>` : ''}`;
  const bu = bullet
    ? `<a:buClr>${color(bullet.colour)}</a:buClr><a:buSzPct val="${bullet.size || 100000}"/><a:buFont typeface="Arial"/><a:buChar char="${bullet.char}"/>`
    : '<a:buNone/>';
  return `<a:p><a:pPr algn="${align}"${lvl}${margins}>${spacing}${bu}</a:pPr>${content || ''}<a:endParaRPr lang="vi-VN" sz="${endSize}" dirty="0"/></a:p>`;
}

/** A shape's text body. Insets in EMU; `anchor` t, ctr or b. */
const textBody = (paragraphs, { anchor = 't', inset = 0, wrap = true } = {}) =>
  `<p:txBody><a:bodyPr wrap="${wrap ? 'square' : 'none'}" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${anchor}" rtlCol="0"><a:normAutofit/></a:bodyPr>` +
  `<a:lstStyle/>${paragraphs || '<a:p><a:endParaRPr lang="vi-VN" dirty="0"/></a:p>'}</p:txBody>`;

/**
 * A shape that is not a placeholder: a decoration, a card, a text box. Its
 * `name` is how the reader tells decoration from content — "Decoration …",
 * "Footer" and "Slide Number" are drawn, never read back as points.
 */
function shape({ id, name, x, y, w, h, geom = 'rect', round = null, fill = null, line = null, text = null, box = false }) {
  const av = geom === 'roundRect' && round != null ? `<a:avLst><a:gd name="adj" fmla="val ${round}"/></a:avLst>` : '<a:avLst/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr${box ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${geom}">${av}</a:prstGeom>${fill || '<a:noFill/>'}${line || '<a:ln><a:noFill/></a:ln>'}</p:spPr>` +
    `${text || ''}</p:sp>`
  );
}

/**
 * A placeholder — the slide's title, or its body (`idx="1"`) — so the outline,
 * a screen reader and PowerPoint's own tools find the slide's words where they
 * expect them. Geometry and formatting are written on it anyway.
 */
function placeholder({ id, name, ph, x, y, w, h, text }) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>${text}</p:sp>`
  );
}

/* ── animation ───────────────────────────────────────────────────────── */

/**
 * Content that fades in a piece at a time, starting by itself when the slide
 * appears — PowerPoint's "Fade, After Previous". Each target is a shape, or a
 * range of a shape's paragraphs (`from`–`to`).
 *
 * The tree is PowerPoint's own shape for it, node for node: a main sequence,
 * one click group that begins with the slide, and one timed node per piece.
 *
 * A target marked `with` starts together with the one before it, rather than
 * after it ("With Previous") — a card's accent bar arrives with its card.
 *
 * @param {{ id: number, from?: number, to?: number, kind: 'text'|'shape'|'graphic'|'plain', with?: boolean }[]} targets
 */
function timingXml(targets, { step = 420 } = {}) {
  if (!targets.length) return '';
  let n = 3;
  const next = () => (n += 1);
  const target = (t) =>
    t.from != null ? `<p:spTgt spid="${t.id}"><p:txEl><p:pRg st="${t.from}" end="${t.to}"/></p:txEl></p:spTgt>` : `<p:spTgt spid="${t.id}"/>`;
  // Steps: each "after previous" target starts one, and a `with` target joins
  // the step before — nested in its group, as PowerPoint writes it.
  const steps = [];
  for (const t of targets) {
    if (t.with && steps.length) steps[steps.length - 1].push(t);
    else steps.push([t]);
  }
  const effectXml = (t) => {
    const effect = next();
    const set = next();
    const fade = next();
    return (
      `<p:par><p:cTn id="${effect}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="${t.with ? 'withEffect' : 'afterEffect'}">` +
      '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
      `<p:set><p:cBhvr><p:cTn id="${set}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>` +
      `<p:tgtEl>${target(t)}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>` +
      '<p:to><p:strVal val="visible"/></p:to></p:set>' +
      `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${fade}" dur="${step}"/><p:tgtEl>${target(t)}</p:tgtEl></p:cBhvr></p:animEffect>` +
      '</p:childTnLst></p:cTn></p:par>'
    );
  };
  const pieces = steps
    .map((group, i) => {
      const outer = next();
      return (
        `<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="${i * step}"/></p:stCondLst><p:childTnLst>` +
        `${group.map(effectXml).join('')}</p:childTnLst></p:cTn></p:par>`
      );
    })
    .join('');
  // One build entry per shape with text, however many of its paragraphs are
  // timed; a shape with no text has none, as PowerPoint writes it.
  const seen = new Set();
  const builds = targets
    .filter((t) => t.kind !== 'plain' && !seen.has(t.id) && seen.add(t.id))
    .map((t) =>
      t.kind === 'graphic'
        ? `<p:bldGraphic spid="${t.id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`
        : t.kind === 'text'
          ? `<p:bldP spid="${t.id}" grpId="0" build="p"/>`
          : `<p:bldP spid="${t.id}" grpId="0" animBg="1"/>`,
    )
    .join('');
  return (
    '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    '<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>' +
    `<p:childTnLst>${pieces}</p:childTnLst></p:cTn></p:par>` +
    '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
    `</p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst>${builds}</p:bldLst></p:timing>`
  );
}

/** How a slide arrives: a fade, a push up into a new section. */
const transitionXml = (kind) =>
  kind === 'section' || kind === 'closing' ? '<p:transition spd="slow"><p:push dir="u"/></p:transition>' : '<p:transition spd="med"><p:fade/></p:transition>';

/* ── reading a slide's content ───────────────────────────────────────── */

/** Points as `{ level, text, runs, plain }`, whatever shape they arrived in. */
export function normalisePoints(bullets) {
  return (Array.isArray(bullets) ? bullets : [])
    .map((b) => (typeof b === 'string' ? { level: 0, text: b } : b))
    .filter((b) => b && String(b.text ?? '').trim())
    .map((b) => ({
      level: Math.min(Math.max(Number(b.level) || 0, 0), 4),
      text: String(b.text),
      runs: Array.isArray(b.runs) && b.runs.length ? b.runs : [{ text: String(b.text) }],
      plain: !!b.plain,
    }));
}

/** Each point's figure and the words after it, when every point opens with one. */
function figuresOf(points) {
  if (points.length < STATS.min || points.length > STATS.max || points.some((p) => p.level > 0)) return null;
  const split = points.map((p) => FIGURE.exec(p.text));
  if (split.some((m) => !m || m[1].replace(/[^\d]/g, '').length === 0 || m[2].length > 140)) return null;
  return split.map((m) => ({ figure: m[1].trim(), label: m[2].replace(/^\*\*|\*\*$/g, '').trim() }));
}

/** Which layout a slide gets — see the top of this file. */
export function slideKind(slide, index, count) {
  const points = normalisePoints(slide.bullets);
  const table = slide.table?.rows?.length ? slide.table : null;
  const title = String(slide.title || '').trim();
  if (slide.kind) return slide.kind;
  if (index === 0 && count > 1 && title && !table && points.length <= 2 && points.every((p) => p.text.length <= 160)) return 'cover';
  if (index === count - 1 && count > 1 && CLOSING.test(title) && !table && points.length <= 4) return 'closing';
  if (title && !points.length && !table) return index === 0 ? 'cover' : 'section';
  if (table) return 'table';
  if (figuresOf(points)) return 'stats';
  if (points.length === 1 && points[0].plain && points[0].text.length <= 240) return 'statement';
  return 'bullets';
}

/* ── the slides ──────────────────────────────────────────────────────── */

/** A table's type size and row height, by how many columns it has. */
function tableMetrics(columns) {
  const size = columns <= 3 ? 1600 : columns <= 5 ? 1400 : columns <= 7 ? 1200 : 1050;
  return { size, rowH: Math.round((size / 100) * PT * 2.3) };
}

/** Room an intro above a table takes — measured, with the gap under it. */
const introHeight = (points) => (points.length ? Math.ceil(heightFor(points, 1600, W - M * 2)) + 137160 : 0);

/**
 * Split slides that would not fit — a long list, a long table — into slides
 * that do, titled "(2/3)". What is given is never dropped.
 */
export function paginate(slides) {
  const out = [];
  for (const slide of slides) {
    const table = slide.table?.rows?.length ? slide.table : null;
    const points = normalisePoints(slide.bullets);
    // A table and more than a short intro on one slide: the words first, then the table.
    if (table && (points.length > 2 || introHeight(points) > 1005840)) {
      out.push(...paginate([{ ...slide, table: null }]));
      out.push(...paginate([{ title: slide.title, table }]));
      continue;
    }
    if (table) {
      const header = table.header !== false ? table.rows.slice(0, 1) : [];
      const body = table.header !== false ? table.rows.slice(1) : table.rows;
      // As many rows as the room left holds — less on the page under an intro.
      const { rowH } = tableMetrics(Math.max(...table.rows.map((r) => r.length), 1));
      const room = BODY_BOTTOM - BODY_TOP;
      const fits = (space) => Math.max(1, Math.floor(space / rowH) - header.length);
      const first = fits(room - introHeight(points));
      const rest = fits(room);
      const pageRows = [body.slice(0, first)];
      for (let at = first; at < body.length; at += rest) pageRows.push(body.slice(at, at + rest));
      const pages = pageRows.length;
      pageRows.forEach((rows, i) => {
        out.push({
          ...slide,
          title: pages > 1 ? `${slide.title || ''} (${i + 1}/${pages})`.trim() : slide.title,
          bullets: i === 0 ? slide.bullets : [],
          table: { header: table.header !== false, rows: [...header, ...rows] },
          notes: i === 0 ? slide.notes : '',
        });
      });
      continue;
    }
    // Points: as many per slide as fit at the smallest size kept readable.
    const width = W - M * 2;
    const room = BODY_BOTTOM - BODY_TOP;
    if (!points.length || heightFor(points, 1600, width) <= room || heightFor(points, 1500, width / 2 - 228600) * 0.5 <= room) {
      out.push(slide);
      continue;
    }
    const pages = [];
    let page = [];
    for (const point of points) {
      if (page.length && heightFor([...page, point], 1600, width) > room && point.level === 0) {
        pages.push(page);
        page = [];
      }
      page.push(point);
    }
    if (page.length) pages.push(page);
    pages.forEach((list, i) =>
      out.push({ ...slide, title: `${slide.title || ''} (${i + 1}/${pages.length})`.trim(), bullets: list, notes: i === 0 ? slide.notes : '' }),
    );
  }
  return out;
}

/** The light top-right flourish every content slide carries, and its footer. */
function chrome(ctx, ids, { number, dark = false }) {
  const { palette, deckTitle } = ctx;
  const shapes = [
    shape({ id: ids(), name: 'Decoration 1', x: W - 2286000, y: -1371600, w: 3657600, h: 3657600, geom: 'ellipse', fill: solid(dark ? 'FFFFFF' : palette.soft, dark ? 6 : 70) }),
    shape({ id: ids(), name: 'Decoration 2', x: W - 1143000, y: 457200, w: 685800, h: 685800, geom: 'ellipse', fill: solid(palette.accent, dark ? 30 : 22) }),
  ];
  if (!dark && number) {
    shapes.push(
      shape({ id: ids(), name: 'Decoration 3', x: M, y: FOOT_Y - 91440, w: W - M * 2, h: 9525, fill: solid(palette.line) }),
      shape({
        id: ids(),
        name: 'Footer',
        x: M,
        y: FOOT_Y,
        w: W / 2,
        h: 274320,
        box: true,
        text: textBody(para(run(deckTitle, { size: 1000, colour: palette.muted })), { anchor: 'ctr' }),
      }),
      shape({
        id: ids(),
        name: 'Slide Number',
        x: W - M - 1828800,
        y: FOOT_Y,
        w: 1828800,
        h: 274320,
        box: true,
        text: textBody(
          `<a:p><a:pPr algn="r"><a:buNone/></a:pPr><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="vi-VN" sz="1000" b="1" dirty="0">${solid(palette.primary)}</a:rPr><a:t>${number}</a:t></a:fld>` +
            `<a:r><a:rPr lang="vi-VN" sz="1000" dirty="0">${solid(palette.muted)}</a:rPr><a:t> / ${ctx.count}</a:t></a:r></a:p>`,
          { anchor: 'ctr' },
        ),
      }),
    );
  }
  return shapes;
}

/** A content slide's title, and the short bar of accent under it. */
function heading(ctx, ids, title, { size = 3000 } = {}) {
  const { palette } = ctx;
  const lines = linesFor(title, size, W - M * 2 - 1600200);
  const fit = lines > 1 ? Math.max(2200, size - 400 * (lines - 1)) : size;
  return [
    placeholder({
      id: ids(),
      name: 'Title 1',
      ph: 'type="title"',
      x: M,
      y: TITLE.y,
      w: W - M * 2 - 1600200,
      h: TITLE.h,
      text: textBody(para(run(title, { size: fit, colour: palette.primary, bold: true, face: '+mj-lt' }), { line: 95, endSize: fit }), { anchor: 'b' }),
    }),
    shape({ id: ids(), name: 'Decoration Bar', x: M, y: TITLE.y + TITLE.h + 91440, w: 822960, h: 64008, geom: 'roundRect', round: 50000, fill: solid(palette.accent) }),
  ];
}

/** The points of a body, as paragraphs, with the accent bullet and a level's indent. */
function pointsXml(points, size, palette) {
  return points
    .map((p, i) => {
      const s = Math.max(1200, size - p.level * 200);
      const style = { size: s, colour: p.level ? palette.muted : palette.ink };
      if (p.plain) return para(runsXml(p.runs, style), { before: i ? Math.round(s * 0.45) : 0, line: 110, endSize: s });
      const marL = 342900 + p.level * 342900;
      return para(runsXml(p.runs, style), {
        level: p.level,
        marL,
        indent: -285750,
        before: i ? Math.round(s * 0.45) : 0,
        line: 108,
        bullet: { colour: p.level ? palette.secondary : palette.accent, char: p.level ? '–' : '■', size: p.level ? 100000 : 70000 },
        endSize: s,
      });
    })
    .join('');
}

/** Paragraph ranges for each top-level point with the points under it — one fade each. */
function pointRanges(points) {
  const ranges = [];
  points.forEach((p, i) => {
    if (p.level === 0 || !ranges.length) ranges.push({ from: i, to: i });
    else ranges[ranges.length - 1].to = i;
  });
  return ranges;
}

const SIZES = [2400, 2200, 2000, 1800, 1600];

function bulletsSlide(slide, ctx, ids) {
  const { palette } = ctx;
  const points = normalisePoints(slide.bullets);
  const shapes = [...chrome(ctx, ids, { number: ctx.number }), ...heading(ctx, ids, slide.title || '')];
  const width = W - M * 2;
  const room = BODY_BOTTOM - BODY_TOP;
  const one = fittingSize(points, width, room, SIZES);
  const timed = [];
  if (one != null || points.length < 7) {
    const size = one ?? 1600;
    const id = ids();
    shapes.push(placeholder({ id, name: 'Content 1', ph: 'idx="1"', x: M, y: BODY_TOP, w: width, h: room, text: textBody(pointsXml(points, size, palette)) }));
    for (const r of pointRanges(points)) timed.push({ id, ...r, kind: 'text' });
  } else {
    // Two columns, split at a top-level point near the middle.
    const col = (width - 457200) / 2;
    let cut = Math.ceil(points.length / 2);
    while (cut < points.length && points[cut].level > 0) cut += 1;
    const halves = [points.slice(0, cut), points.slice(cut)];
    const size = Math.min(...halves.map((h) => fittingSize(h, col, room, [2000, 1800, 1600, 1500, 1400]) ?? 1400));
    halves.forEach((half, i) => {
      if (!half.length) return;
      const id = ids();
      const x = M + i * (col + 457200);
      const body = textBody(pointsXml(half, size, palette));
      shapes.push(
        i === 0
          ? placeholder({ id, name: 'Content 1', ph: 'idx="1"', x, y: BODY_TOP, w: col, h: room, text: body })
          : shape({ id, name: 'Content 2', x, y: BODY_TOP, w: col, h: room, box: true, text: body }),
      );
      for (const r of pointRanges(half)) timed.push({ id, ...r, kind: 'text' });
    });
  }
  return { shapes, timed };
}

function statsSlide(slide, ctx, ids) {
  const { palette } = ctx;
  const figures = figuresOf(normalisePoints(slide.bullets));
  const shapes = [...chrome(ctx, ids, { number: ctx.number }), ...heading(ctx, ids, slide.title || '')];
  const n = figures.length;
  const perRow = n <= 4 ? n : 3;
  const rows = Math.ceil(n / perRow);
  const gap = 274320;
  const width = W - M * 2;
  const cardW = (width - gap * (perRow - 1)) / perRow;
  const room = BODY_BOTTOM - BODY_TOP - 182880;
  const cardH = Math.min(2651760, (room - gap * (rows - 1)) / rows);
  const top = BODY_TOP + 91440 + (room - (cardH * rows + gap * (rows - 1))) / 2;
  const figureSize = perRow >= 4 ? 3600 : perRow === 3 ? 4000 : 4800;
  const timed = [];
  figures.forEach((f, i) => {
    const x = M + (i % perRow) * (cardW + gap);
    const y = top + Math.floor(i / perRow) * (cardH + gap);
    const labelSize = fittingSize([{ text: f.label, level: 0, plain: true }], cardW - 548640, cardH * 0.45, [1600, 1500, 1400, 1300, 1200]) ?? 1200;
    const id = ids();
    shapes.push(
      shape({
        id,
        name: `Card ${i + 1}`,
        x,
        y,
        w: cardW,
        h: cardH,
        geom: 'roundRect',
        round: 6000,
        fill: solid(i % 2 ? tint(palette.soft, 0.35) : palette.soft),
        text: textBody(
          para(run(f.figure, { size: figureSize, colour: palette.primary, bold: true, face: '+mj-lt' }), { line: 90, endSize: figureSize }) +
            para(run(f.label, { size: labelSize, colour: palette.ink }), { before: 600, line: 110, endSize: labelSize }),
          { anchor: 'ctr', inset: 274320 },
        ),
      }),
    );
    // A short bar of accent in the card's corner, drawn over it, arriving with it.
    const bar = ids();
    shapes.push(shape({ id: bar, name: `Decoration Card ${i + 1}`, x: x + 274320, y: y + 228600, w: 457200, h: 54864, geom: 'roundRect', round: 50000, fill: solid(palette.accent) }));
    timed.push({ id, kind: 'shape' }, { id: bar, kind: 'plain', with: true });
  });
  return { shapes, timed };
}

const isNumberCell = (text) => /^\s*[+\-−]?(?:[$€£¥₫]\s?)?\d[\d.,]*\s?(?:%|‰|[kKmMbB]|tr|triệu|tỷ|đ|₫|USD|VND)?\s*$/u.test(String(text || ''));

function tableSlide(slide, ctx, ids) {
  const { palette } = ctx;
  const shapes = [...chrome(ctx, ids, { number: ctx.number }), ...heading(ctx, ids, slide.title || '')];
  const rows = slide.table.rows.map((row) => row.map((cell) => (typeof cell === 'string' ? cell : String(cell?.text ?? cell?.runs?.map((r) => r.text).join('') ?? ''))));
  const columns = Math.max(...rows.map((r) => r.length), 1);
  const header = slide.table.header !== false;
  const points = normalisePoints(slide.bullets);
  let top = BODY_TOP;
  if (points.length) {
    // The intro is as tall as its words, and the table starts under it.
    const tall = introHeight(points);
    shapes.push(shape({ id: ids(), name: 'Content 1', x: M, y: BODY_TOP, w: W - M * 2, h: tall - 137160, box: true, text: textBody(pointsXml(points, 1600, palette)) }));
    top += tall;
  }
  const { size, rowH } = tableMetrics(columns);
  const width = W - M * 2;
  // Columns sized to what they hold, each at least a fair share's half.
  const longest = Array.from({ length: columns }, (_, c) => Math.max(4, ...rows.map((r) => String(r[c] ?? '').length)));
  const sum = longest.reduce((a, b) => a + b, 0);
  const share = longest.map((l) => Math.max(width / columns / 2, (width * l) / sum));
  const scale = width / share.reduce((a, b) => a + b, 0);
  const grid = share.map((s) => Math.round(s * scale));
  const numeric = Array.from({ length: columns }, (_, c) => rows.slice(header ? 1 : 0).every((r) => !String(r[c] ?? '').trim() || isNumberCell(r[c])));
  const line = (tag, hex) => `<a:${tag} w="9525" cap="flat" cmpd="sng" algn="ctr">${solid(hex)}<a:prstDash val="solid"/></a:${tag}>`;
  const none = (tag) => `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
  const trs = rows
    .map((r, ri) => {
      const isHead = header && ri === 0;
      const fill = isHead ? palette.primary : ri % 2 === (header ? 0 : 1) ? palette.soft : 'FFFFFF';
      const cells = Array.from({ length: columns }, (_, c) => {
        const text = String(r[c] ?? '');
        // A column of figures is set right, its heading with it.
        const align = numeric[c] && c > 0 ? 'r' : 'l';
        const body = text
          ? para(run(text, { size, colour: isHead ? 'FFFFFF' : palette.ink, bold: isHead }), { align, endSize: size })
          : `<a:p><a:pPr algn="${align}"/><a:endParaRPr lang="vi-VN" sz="${size}" dirty="0"/></a:p>`;
        return (
          `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody>` +
          `<a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr">${none('lnL')}${none('lnR')}${none('lnT')}${line('lnB', isHead ? palette.primary : palette.line)}${solid(fill)}</a:tcPr></a:tc>`
        );
      }).join('');
      return `<a:tr h="${rowH}">${cells}</a:tr>`;
    })
    .join('');
  const id = ids();
  shapes.push(
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table 1"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${M}" y="${top}"/><a:ext cx="${width}" cy="${rowH * rows.length}"/></p:xfrm>` +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
      `<a:tbl><a:tblPr firstRow="${header ? 1 : 0}" bandRow="1"/><a:tblGrid>${grid.map((g) => `<a:gridCol w="${g}"/>`).join('')}</a:tblGrid>${trs}</a:tbl>` +
      '</a:graphicData></a:graphic></p:graphicFrame>',
  );
  return { shapes, timed: [{ id, kind: 'graphic' }] };
}

function statementSlide(slide, ctx, ids) {
  const { palette } = ctx;
  const point = normalisePoints(slide.bullets)[0];
  const shapes = [...chrome(ctx, ids, { number: ctx.number })];
  if (slide.title) shapes.push(...heading(ctx, ids, slide.title, { size: 2400 }));
  shapes.push(
    shape({
      id: ids(),
      name: 'Decoration Quote',
      x: M - 91440,
      y: BODY_TOP - 182880,
      w: 1371600,
      h: 1371600,
      box: true,
      text: textBody(para(run('“', { size: 16000, colour: palette.accent, bold: true, face: 'Georgia', alpha: 55 }), { endSize: 16000 })),
    }),
  );
  const width = W - M * 2 - 1371600;
  const size = fittingSize([{ text: point.text, level: 0, plain: true }], width, BODY_BOTTOM - BODY_TOP - 457200, [3200, 2800, 2600, 2400, 2200, 2000]) ?? 2000;
  const id = ids();
  shapes.push(
    shape({
      id,
      name: 'Content 1',
      x: M + 685800,
      y: BODY_TOP + 228600,
      w: width,
      h: BODY_BOTTOM - BODY_TOP - 457200,
      box: true,
      text: textBody(para(runsXml(point.runs, { size, colour: palette.ink, italic: true, face: '+mj-lt' }), { line: 115, endSize: size }), { anchor: 'ctr' }),
    }),
  );
  return { shapes, timed: [{ id, kind: 'shape' }] };
}

/** The cover and the closing slide: the palette's deep ground, the title large. */
function coverSlide(slide, ctx, ids, { closing = false } = {}) {
  const { palette } = ctx;
  const points = normalisePoints(slide.bullets);
  const align = closing ? 'ctr' : 'l';
  const width = closing ? W - M * 2 : W * 0.64;
  const x = closing ? M : M;
  const title = String(slide.title || ctx.deckTitle);
  const size = fittingSize([{ text: title, level: 0, plain: true }], width, 1828800, [5400, 4800, 4400, 4000, 3600, 3200]) ?? 3200;
  const shapes = [
    shape({ id: ids(), name: 'Decoration 1', x: W - 4572000, y: -1600200, w: 6400800, h: 6400800, geom: 'ellipse', fill: solid('FFFFFF', 6) }),
    shape({ id: ids(), name: 'Decoration 2', x: W - 2743200, y: H - 2286000, w: 3474720, h: 3474720, geom: 'ellipse', fill: solid(palette.accent, 22) }),
    shape({ id: ids(), name: 'Decoration 3', x: -1143000, y: H - 1371600, w: 2743200, h: 2743200, geom: 'ellipse', fill: solid('FFFFFF', 5) }),
    shape({ id: ids(), name: 'Decoration Bar', x: closing ? W / 2 - 548640 : M, y: closing ? 2194560 : 2011680, w: 1097280, h: 82296, geom: 'roundRect', round: 50000, fill: solid(palette.accent) }),
    placeholder({
      id: ids(),
      name: 'Title 1',
      ph: 'type="title"',
      x,
      y: closing ? 2377440 : 2194560,
      w: width,
      h: 1828800,
      text: textBody(para(run(title, { size, colour: 'FFFFFF', bold: true }), { align, line: 92, endSize: size }), { anchor: closing ? 'ctr' : 't' }),
    }),
  ];
  const timed = [];
  if (points.length) {
    const id = ids();
    shapes.push(
      shape({
        id,
        name: 'Subtitle',
        x,
        y: closing ? 4297680 : 4206240,
        w: width,
        h: 1280160,
        box: true,
        text: textBody(points.map((p, i) => para(runsXml(p.runs, { size: 2000, colour: 'FFFFFF', alpha: 85 }), { align, before: i ? 600 : 0, line: 110, endSize: 2000 })).join('')),
      }),
    );
    timed.push({ id, kind: 'shape' });
  }
  return { shapes, timed, background: gradient(palette.primary, palette.dark, closing ? 90 : 135) };
}

function sectionSlide(slide, ctx, ids) {
  const { palette } = ctx;
  const number = String(ctx.section).padStart(2, '0');
  const title = String(slide.title || '');
  const size = fittingSize([{ text: title, level: 0, plain: true }], W - M * 2, 1554480, [4400, 4000, 3600, 3200]) ?? 3200;
  const shapes = [
    ...chrome(ctx, ids, { number: null, dark: true }),
    shape({
      id: ids(),
      name: 'Decoration Number',
      x: M,
      y: 1371600,
      w: 3657600,
      h: 1463040,
      box: true,
      text: textBody(para(run(number, { size: 9600, colour: 'FFFFFF', bold: true, alpha: 40 }), { endSize: 9600 }), { anchor: 'b' }),
    }),
    placeholder({
      id: ids(),
      name: 'Title 1',
      ph: 'type="title"',
      x: M,
      y: 3017520,
      w: W - M * 2,
      h: 1554480,
      text: textBody(para(run(title, { size, colour: 'FFFFFF', bold: true }), { line: 92, endSize: size }), { anchor: 't' }),
    }),
    shape({ id: ids(), name: 'Decoration Bar', x: M, y: 2926080, w: 1371600, h: 54864, geom: 'roundRect', round: 50000, fill: solid(palette.accent) }),
  ];
  return { shapes, timed: [], background: gradient(palette.primary, palette.secondary, 120) };
}

/**
 * One slide's XML: its ground, its shapes, how it arrives, and its content's
 * fade. `ctx` carries the palette, the deck's title, the slide's number and
 * the section count so far.
 */
export function designedSlideXml(slide, kind, ctx, head) {
  let id = 1;
  const ids = () => (id += 1);
  const drawn =
    kind === 'cover'
      ? coverSlide(slide, ctx, ids)
      : kind === 'closing'
        ? coverSlide(slide, ctx, ids, { closing: true })
        : kind === 'section'
          ? sectionSlide(slide, ctx, ids)
          : kind === 'stats'
            ? statsSlide(slide, ctx, ids)
            : kind === 'table'
              ? tableSlide(slide, ctx, ids)
              : kind === 'statement'
                ? statementSlide(slide, ctx, ids)
                : bulletsSlide(slide, ctx, ids);
  const ground = drawn.background || solid('FFFFFF');
  const tree =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${drawn.shapes.join('')}</p:spTree>`;
  return (
    `${head}<p:cSld><p:bg><p:bgPr>${ground}<a:effectLst/></p:bgPr></p:bg>${tree}</p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(kind)}${timingXml(drawn.timed)}</p:sld>`
  );
}
