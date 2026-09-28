/**
 * Word documents, in both directions.
 *
 * Reading one means walking `word/document.xml` and turning WordprocessingML
 * back into the block model in `blocks.js` — headings, paragraphs, lists,
 * tables, and the bold/italic/link runs inside them. That model is what the
 * preview draws and what the model is shown, so a document reads the same way
 * to a person and to an assistant.
 *
 * Writing one goes the other way, from the same blocks. The package it builds is
 * deliberately small: a document part, a stylesheet, a numbering definition and
 * the two property parts Word expects. No theme, no settings, no fonts table —
 * every one of those is optional, and each one is another file that can be
 * subtly wrong in a way that makes Word offer to "repair" the document, which is
 * the single worst thing a generated file can do.
 *
 * Pictures are read out with their bytes and become blocks of their own, so a
 * report full of figures previews as a report full of figures rather than as
 * the word "[image]" thirty times. They are not *written* — a document this
 * project generates is text, tables and structure.
 *
 * What is not attempted, and is said plainly rather than half-done: headers and
 * footers, footnotes, comments, tracked changes, columns, charts as anything
 * but their rendered picture, and anything positioned by hand.
 */
import { openZip, writeZip } from './zip.js';
import {
  XML_DECLARATION,
  attr,
  descendants,
  element,
  elements,
  escapeXml,
  localName,
  parseXml,
  relationshipId,
  textOf,
} from './xml.js';
import {
  MIME,
  NS,
  REL,
  appPropsXml,
  contentTypesXml,
  corePropsXml,
  mainPart,
  readRelationships,
  relsPathFor,
  resolveTarget,
  rootRelsXml,
} from './opc.js';
import { blocksToText, normaliseBlocks } from './blocks.js';

/* ══ reading ═══════════════════════════════════════════════════════════ */

/** styleId → lowercased human name, so "Heading 1" is findable under any id. */
function readStyleNames(zip) {
  const names = new Map();
  if (!zip.has('word/styles.xml')) return names;
  const root = parseXml(zip.text('word/styles.xml'));
  for (const style of descendants(root, 'style')) {
    const id = attr(style, 'styleId');
    const name = attr(element(style, 'name'), 'val');
    if (id && name) names.set(id, String(name).toLowerCase());
  }
  return names;
}

/**
 * numId → whether that list is numbered rather than bulleted.
 *
 * Two hops: a paragraph names a `numId`, which points at an abstract definition,
 * which holds the format of each level. Worth following properly — "1. 2. 3."
 * and "• • •" are different documents, and guessing gets it wrong exactly on the
 * documents where it matters.
 */
function readNumbering(zip) {
  const ordered = new Map();
  if (!zip.has('word/numbering.xml')) return ordered;

  const root = parseXml(zip.text('word/numbering.xml'));
  const formats = new Map();
  for (const abstract of descendants(root, 'abstractNum')) {
    const id = attr(abstract, 'abstractNumId');
    const levels = new Map();
    for (const lvl of elements(abstract, 'lvl')) {
      const level = Number(attr(lvl, 'ilvl') || 0);
      levels.set(level, String(attr(element(lvl, 'numFmt'), 'val') || 'bullet'));
    }
    if (id) formats.set(id, levels);
  }
  for (const num of descendants(root, 'num')) {
    const numId = attr(num, 'numId');
    const abstractId = attr(element(num, 'abstractNumId'), 'val');
    const levels = formats.get(abstractId);
    if (numId && levels) ordered.set(numId, levels);
  }
  return ordered;
}

/** The runs of one paragraph, flattened, with formatting and links kept. */
function readRuns(node, rels) {
  const runs = [];

  const push = (text, format, link) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (
      last &&
      last.bold === format.bold &&
      last.italic === format.italic &&
      last.underline === format.underline &&
      last.code === format.code &&
      last.strike === format.strike &&
      last.link === link
    ) {
      last.text += text;
      return;
    }
    runs.push({ text, ...format, link });
  };

  const walkRun = (run, link) => {
    const rPr = element(run, 'rPr');
    const on = (name) => {
      const found = element(rPr, name);
      if (!found) return false;
      const value = attr(found, 'val');
      return value !== '0' && value !== 'false' && value !== 'none';
    };
    const fonts = element(rPr, 'rFonts');
    const ascii = String(attr(fonts, 'ascii') || '').toLowerCase();
    const format = {
      bold: on('b'),
      italic: on('i'),
      underline: on('u'),
      strike: on('strike'),
      // Word has no "inline code": what everybody uses is a monospaced font.
      code: /consol|courier|mono/.test(ascii),
    };

    for (const child of run.children) {
      if (typeof child === 'string') continue;
      const name = localName(child.name);
      // `delText` is text somebody deleted with track-changes on. It is still in
      // the file; it is not in the document.
      if (name === 't') push(textOf(child), format, link);
      else if (name === 'tab') push('\t', format, link);
      else if (name === 'br' || name === 'cr') push('\n', format, link);
      else if (name === 'noBreakHyphen') push('-', format, link);
      // Pictures are not text. They come out as their own blocks, with their
      // bytes — a literal "[image]" in the middle of a sentence used to be the
      // whole of what a figure amounted to.
      else if (name === 'object') push('[embedded object]', format, link);
    }
  };

  const walk = (parent, link) => {
    for (const child of elements(parent)) {
      const name = localName(child.name);
      if (name === 'r') walkRun(child, link);
      else if (name === 'hyperlink') {
        const id = relationshipId(child);
        const target = id ? rels.get(id)?.target : attr(child, 'anchor') ? `#${attr(child, 'anchor')}` : null;
        walk(child, target || link);
      } else if (name === 'ins' || name === 'smartTag' || name === 'sdt' || name === 'sdtContent' || name === 'bookmarkStart') {
        // Wrappers that carry runs: an accepted insertion, a content control, a
        // smart tag. Their children are ordinary text and must not be skipped.
        walk(child, link);
      } else if (name === 'fldSimple') {
        walk(child, link);
      }
    }
  };

  walk(node, null);
  return runs;
}

/**
 * A page break, wherever it is written.
 *
 * `<w:br w:type="page"/>` is the ordinary one. `<w:lastRenderedPageBreak/>` is
 * not a break at all — it is Word recording where the page happened to end when
 * it last repaginated — so it is deliberately not counted, or every reflowed
 * document would come back full of breaks nobody inserted.
 */
const hasPageBreak = (node) =>
  [...descendants(node, 'br')].some((br) => String(attr(br, 'type') || '') === 'page');

/**
 * A horizontal rule: an empty paragraph whose only content is a border.
 *
 * Word writes a rule as a bottom border, and so does this project's writer. A
 * top border is the same thing seen from the paragraph below, which is what
 * Word produces when somebody types `---` and lets AutoFormat convert it.
 */
function hasRule(node) {
  const borders = element(element(node, 'pPr'), 'pBdr');
  if (!borders) return false;
  return ['bottom', 'top'].some((side) => {
    const edge = element(borders, side);
    const kind = edge && String(attr(edge, 'val') || '');
    return !!kind && kind !== 'none' && kind !== 'nil';
  });
}

/**
 * The pictures in a paragraph, in the order they appear.
 *
 * Two markups, both still in use. `w:drawing` is the modern one and points at
 * its part through `a:blip r:embed`; `w:pict` is the Word 97 shape syntax, still
 * emitted by anything that round-trips through an older version, and points
 * through `v:imagedata r:id`. A reader that knows only the first shows a blank
 * where half the world's figures are.
 *
 * `r:link` — a picture referenced from a URL rather than stored in the file — is
 * deliberately not followed. The bytes are not in the document, and fetching
 * from a stranger's document is a request this application does not make.
 */
function imagesIn(node, context) {
  const found = [];

  for (const drawing of descendants(node, 'drawing')) {
    for (const blip of descendants(drawing, 'blip')) {
      // `r:embed`, not `embed` — and not `attr(blip, 'id')`, which would find a
      // shape's own id. The prefix is what distinguishes a relationship.
      const at = keepMedia(blip.attrs['r:embed'] ?? attr(blip, 'embed'), context);
      if (at !== null) found.push({ index: at, alt: altTextOf(drawing) });
    }
  }
  for (const pict of descendants(node, 'pict')) {
    for (const data of descendants(pict, 'imagedata')) {
      const at = keepMedia(relationshipId(data), context);
      if (at !== null) found.push({ index: at, alt: attr(data, 'title') || '' });
    }
  }
  return found;
}

/** The description Word stores for a picture, which is also its accessible name. */
function altTextOf(drawing) {
  for (const properties of descendants(drawing, 'docPr')) {
    const description = attr(properties, 'descr') || attr(properties, 'name');
    if (description) return String(description);
  }
  return '';
}

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/emf',
  wmf: 'image/wmf',
};

/**
 * Pull one picture out of the package, once.
 *
 * The same image used twenty times — a logo in a header, a repeated icon — is
 * one relationship target and must be one copy, or a document grows twentyfold
 * on the way to the browser. Returns its position in `media`, or null when the
 * part is missing or is not a picture at all.
 */
function keepMedia(id, { rels, zip, media, base }) {
  if (!id) return null;
  const rel = rels.get(String(id));
  // `External` means the bytes are not in the file — the picture lives at a URL
  // somebody else controls. Not followed: a document should not make this
  // application fetch from a stranger.
  if (!rel || rel.mode === 'External') return null;

  const part = resolveTarget(base, rel.target);
  const at = media.findIndex((item) => item.part === part);
  if (at >= 0) return at;
  if (!zip.has(part)) return null;

  const contentType = IMAGE_TYPES[part.split('.').pop().toLowerCase()];
  // Not a picture — an embedded object, a font, a spreadsheet inside a document.
  // Skipped rather than served to a browser as an image.
  if (!contentType) return null;

  media.push({ part, contentType, data: zip.read(part) });
  return media.length - 1;
}

/** How this paragraph is meant to look: a heading, a quote, a list item, prose. */
function paragraphStyle(node, styleNames) {
  const pPr = element(node, 'pPr');
  const styleId = String(attr(element(pPr, 'pStyle'), 'val') || '');
  const name = styleNames.get(styleId) || styleId.toLowerCase();

  const outline = Number(attr(element(pPr, 'outlineLvl'), 'val'));
  const heading = /^heading\s*([1-9])$/.exec(name) || /^heading([1-9])$/.exec(name);

  let level = 0;
  if (heading) level = Number(heading[1]);
  else if (name === 'title') level = 1;
  else if (name === 'subtitle') level = 2;
  else if (Number.isFinite(outline) && outline >= 0 && outline <= 8) level = outline + 1;

  const numPr = element(pPr, 'numPr');
  return {
    level: Math.min(level, 6),
    quote: /quote/.test(name),
    /**
     * Word's own name for this style is "HTML Preformatted" — with a space —
     * and the pattern demanded `html` be glued to `preformatted`, so it matched
     * nothing that Word or this writer has ever produced. Every code block in
     * every .docx came back as ordinary prose: the text was all there, in the
     * wrong shape, which is the kind of wrong nobody notices until they read
     * the preview next to the document.
     */
    code: /^(html\s*)?(code|preformatted|plain text)/.test(name),
    numId: numPr ? String(attr(element(numPr, 'numId'), 'val') || '') : null,
    indent: numPr ? Number(attr(element(numPr, 'ilvl'), 'val') || 0) : 0,
  };
}

function readTable(node, rels) {
  const rows = [];
  for (const tr of elements(node, 'tr')) {
    const cells = [];
    for (const tc of elements(tr, 'tc')) {
      // A cell holds paragraphs, and a cell with several of them is one cell
      // with line breaks in it — not several cells.
      const lines = elements(tc, 'p').map((p) => readRuns(p, rels));
      const runs = [];
      lines.forEach((line, i) => {
        if (i) runs.push({ text: '\n' });
        runs.push(...line);
      });
      cells.push({ runs });
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;

  // A first row marked as a repeating header row is the document saying so.
  const first = elements(node, 'tr')[0];
  return { type: 'table', header: !!element(element(first, 'trPr'), 'tblHeader'), rows };
}

/**
 * Read a .docx into blocks.
 *
 * @param buffer the file
 * @returns `{ blocks, text, meta }`
 */
export function readDocx(buffer) {
  const zip = openZip(buffer);
  const documentPath = mainPart(zip, 'word/document.xml');
  if (!zip.has(documentPath)) {
    throw Object.assign(new Error('That .docx has no document part — it may be corrupt.'), { code: 'not_docx' });
  }

  const rels = readRelationships(zip, relsPathFor(documentPath));
  const styleNames = readStyleNames(zip);
  const numbering = readNumbering(zip);

  const root = parseXml(zip.text(documentPath));
  const body = element(root, 'body');
  if (!body) throw Object.assign(new Error('That .docx has no body.'), { code: 'not_docx' });

  const blocks = [];
  /** Every distinct picture in the document, in first-seen order. */
  const media = [];
  const context = { rels, zip, media, base: documentPath };
  let openList = null;

  const closeList = () => {
    if (openList) blocks.push(openList);
    openList = null;
  };

  for (const child of elements(body)) {
    const name = localName(child.name);

    if (name === 'p') {
      const style = paragraphStyle(child, styleNames);
      const runs = readRuns(child, rels);

      // Pictures come out as their own blocks, ahead of the paragraph's words.
      // A figure and its caption are almost always written as a picture
      // paragraph followed by a text one, so this keeps them in that order.
      for (const picture of imagesIn(child, context)) {
        blocks.push({ type: 'image', index: picture.index, alt: picture.alt });
      }

      if (style.numId) {
        const levels = numbering.get(style.numId);
        const format = levels?.get(style.indent) || levels?.get(0) || 'bullet';
        const ordered = format !== 'bullet' && format !== 'none';
        if (!openList || openList.ordered !== ordered) {
          closeList();
          openList = { type: 'list', ordered, items: [] };
        }
        openList.items.push({ level: style.indent, runs });
        continue;
      }
      closeList();

      /**
       * An empty paragraph is usually spacing — but not always.
       *
       * Word has no horizontal-rule element and no standalone page break: both
       * are paragraphs with nothing in them, carrying a border or a break run.
       * Discarding every empty paragraph first therefore threw away every rule
       * and every page break in the document, including the ones this project's
       * own writer had just put there. They have to be recognised *before* the
       * paragraph is dismissed as layout.
       */
      const empty = !runs.some((run) => run.text.trim());
      if (empty) {
        if (hasPageBreak(child)) blocks.push({ type: 'pagebreak' });
        else if (hasRule(child)) blocks.push({ type: 'divider' });
        continue;
      }

      // A break inside a paragraph that also has words: the text stays where it
      // is and the page break is recorded before it.
      if (hasPageBreak(child)) blocks.push({ type: 'pagebreak' });

      if (style.level) blocks.push({ type: 'heading', level: style.level, runs });
      else if (style.quote) blocks.push({ type: 'quote', runs });
      else if (style.code) blocks.push({ type: 'code', text: runs.map((r) => r.text).join('') });
      else blocks.push({ type: 'paragraph', runs });
      continue;
    }

    if (name === 'tbl') {
      closeList();
      const table = readTable(child, rels);
      if (table) blocks.push(table);
    }
  }
  closeList();

  const text = blocksToText(blocks);
  return {
    blocks,
    text,
    // The bytes, so the caller can serve them. The part name goes too — the
    // same picture referenced twice is one entry, and that is how it is known.
    media,
    meta: {
      paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
      headings: blocks.filter((b) => b.type === 'heading').length,
      tables: blocks.filter((b) => b.type === 'table').length,
      images: blocks.filter((b) => b.type === 'image').length,
      words: text.split(/\s+/).filter(Boolean).length,
    },
  };
}

/* ══ writing ═══════════════════════════════════════════════════════════ */

/** Twips — twentieths of a point — which is the unit WordprocessingML counts in. */
const A4 = { width: 11906, height: 16838, margin: 1134 };

const WORDPROCESSING = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

const CONTENT_TYPES = contentTypesXml([
  ['/word/document.xml', `${WORDPROCESSING}.document.main+xml`],
  ['/word/styles.xml', `${WORDPROCESSING}.styles+xml`],
  ['/word/numbering.xml', `${WORDPROCESSING}.numbering+xml`],
]);

/**
 * The stylesheet.
 *
 * Written out rather than left to Word's defaults because the defaults are not
 * the same everywhere — a document with no `docDefaults` picks up whatever the
 * installation's Normal template says, which is how the same file comes out
 * 11pt Calibri on one machine and 12pt Times on another.
 *
 * Colours and sizes here are the ones a business document actually wants: a
 * text size that prints, headings that step down, and a quote that reads as one
 * without a coloured bar nobody asked for.
 */
function stylesXml() {
  const heading = (id, size, colour, spaceBefore) =>
    `<w:style w:type="paragraph" w:styleId="Heading${id}"><w:name w:val="heading ${id}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${spaceBefore}" w:after="120"/>` +
    `<w:outlineLvl w:val="${id - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:color w:val="${colour}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

  return (
    `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
    heading(1, 36, '1A1A1A', 240) +
    heading(2, 30, '1A1A1A', 240) +
    heading(3, 26, '2A2A2A', 200) +
    heading(4, 24, '2A2A2A', 200) +
    heading(5, 22, '3A3A3A', 160) +
    heading(6, 22, '3A3A3A', 160) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>' +
    // `pPr` is a sequence too: the border comes before the spacing, which comes
    // before the indent. Written in any other order, this is a repair prompt.
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C6D0D8"/></w:pBdr>' +
    '<w:spacing w:before="120" w:after="120"/><w:ind w:left="567"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="404A54"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F6F8"/>' +
    '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="227" w:right="227"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/>' +
    '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F5"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

/** Bullets on numId 1, decimals on numId 2, five levels each. */
function numberingXml() {
  const bulletLevel = (i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="${['•', 'o', '▪', '•', 'o'][i]}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${360 * (i + 1) + 360}" w:hanging="360"/></w:pPr>` +
    '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>';

  const numberLevel = (i) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter'][i]}"/>` +
    `<w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${360 * (i + 1) + 360}" w:hanging="360"/></w:pPr></w:lvl>`;

  const levels = [0, 1, 2, 3, 4];
  return (
    `${XML_DECLARATION}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels.map(bulletLevel).join('') +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels.map(numberLevel).join('') +
    '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  );
}

/**
 * One run of text, with its formatting and its line breaks.
 *
 * The order of the properties is not a style choice. WordprocessingML defines
 * `rPr` as a *sequence*, so `w:u` before `w:strike` is not merely unusual — it
 * is a schema violation, and what Word does with one is offer to repair the
 * file. Likewise there is exactly one `rStyle`: a run that is both a link and
 * code cannot have two, so the link wins and the monospace comes from the font.
 */
function runXml(run, { insideLink = false } = {}) {
  const properties = [];
  if (insideLink) properties.push('<w:rStyle w:val="Hyperlink"/>');
  else if (run.code) properties.push('<w:rStyle w:val="CodeChar"/>');
  // Named on the run as well as in the style, so the font survives a document
  // whose styles were stripped — and so reading it back can tell it was code.
  if (run.code) properties.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (run.bold) properties.push('<w:b/>');
  if (run.italic) properties.push('<w:i/>');
  if (run.strike) properties.push('<w:strike/>');
  if (run.underline) properties.push('<w:u w:val="single"/>');

  const rPr = properties.length ? `<w:rPr>${properties.join('')}</w:rPr>` : '';

  // A newline inside a run is a soft break, not a new paragraph — that is what
  // Shift+Enter does in Word, and it is what a `\n` in the source meant.
  const pieces = String(run.text ?? '').split('\n');
  const body = pieces
    .map((piece, i) => {
      const br = i ? '<w:br/>' : '';
      return piece ? `${br}<w:t xml:space="preserve">${escapeXml(piece)}</w:t>` : br;
    })
    .join('');

  return body ? `<w:r>${rPr}${body}</w:r>` : '';
}

/**
 * Runs, with hyperlinks lifted out into `w:hyperlink` elements.
 *
 * Each distinct target needs a relationship, so the ids are handed out by the
 * caller's `links` map — a document that mentions the same URL twice gets one
 * relationship, which is what Word itself writes.
 */
function runsXml(runs, links) {
  let out = '';
  for (const run of runs || []) {
    if (!run || run.text == null || run.text === '') continue;
    if (!run.link) {
      out += runXml(run);
      continue;
    }
    let id = links.get(run.link);
    if (!id) {
      id = `rId${links.size + 10}`;
      links.set(run.link, id);
    }
    out += `<w:hyperlink r:id="${id}">${runXml(run, { insideLink: true })}</w:hyperlink>`;
  }
  return out;
}

const paragraphXml = (properties, body) =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${body}</w:p>`;

function tableXml(block, links) {
  const columns = Math.max(...block.rows.map((row) => row.length), 1);
  // A table sized in fifths of a percent, which is how WordprocessingML spells
  // "full width" — 5000 is 100%.
  const width = Math.floor(5000 / columns);

  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D6DCE3"/>`;
  const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`;

  const rows = block.rows
    .map((row, rowIndex) => {
      const header = rowIndex === 0 && block.header !== false;
      const cells = [];
      for (let i = 0; i < columns; i += 1) {
        const cell = row[i] || { runs: [] };
        const runs = header
          ? (cell.runs || []).map((run) => ({ ...run, bold: true }))
          : cell.runs || [];
        const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F4F7"/>' : '';
        cells.push(
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="pct"/>${shading}` +
            '<w:vAlign w:val="center"/></w:tcPr>' +
            paragraphXml('<w:spacing w:after="40"/>', runsXml(runs, links)) +
            '</w:tc>',
        );
      }
      const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
    })
    .join('');

  return (
    '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    `${borders}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor((A4.width - A4.margin * 2) / columns)}"/>`).join('')}</w:tblGrid>` +
    `${rows}</w:tbl>`
  );
}

function blockXml(block, links) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(block.level) || 1, 1), 6);
      return paragraphXml(`<w:pStyle w:val="Heading${level}"/>`, runsXml(block.runs, links));
    }
    case 'title':
      return paragraphXml('<w:pStyle w:val="Title"/>', runsXml(block.runs, links));
    case 'quote':
      return paragraphXml('<w:pStyle w:val="Quote"/>', runsXml(block.runs, links));
    case 'code':
      // One paragraph per line, so a long listing breaks across pages the way
      // every other paragraph does instead of running off the bottom.
      return String(block.text || '')
        .split('\n')
        .map((line) =>
          paragraphXml('<w:pStyle w:val="Code"/>', runXml({ text: line || ' ', code: false })),
        )
        .join('');
    case 'list':
      return (block.items || [])
        .map((item) => {
          const level = Math.min(Math.max(Number(item.level) || 0, 0), 4);
          return paragraphXml(
            '<w:pStyle w:val="ListParagraph"/>' +
              `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`,
            runsXml(item.runs, links),
          );
        })
        .join('');
    case 'table':
      // Word requires a paragraph after a table; two tables in a row with
      // nothing between them merge into one.
      return `${tableXml(block, links)}${paragraphXml('<w:spacing w:after="0"/>', '')}`;
    case 'divider':
      return paragraphXml(
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D6DCE3"/></w:pBdr>',
        '',
      );
    case 'pagebreak':
      return paragraphXml('', '<w:r><w:br w:type="page"/></w:r>');
    default:
      return paragraphXml('', runsXml(block.runs, links));
  }
}

/**
 * Build a .docx.
 *
 * @param blocks   the block model — see `blocks.js`
 * @param title    document title, also written into the file's properties
 * @param author   who it says wrote it
 * @returns a Buffer holding the whole package
 */
export function writeDocx({ blocks, title = 'Document', author = 'Synapsez', created = new Date() } = {}) {
  const model = normaliseBlocks(blocks);
  const links = new Map();
  const body = model.map((block) => blockXml(block, links)).join('');

  const sectPr =
    '<w:sectPr>' +
    `<w:pgSz w:w="${A4.width}" w:h="${A4.height}"/>` +
    `<w:pgMar w:top="${A4.margin}" w:right="${A4.margin}" w:bottom="${A4.margin}" w:left="${A4.margin}" ` +
    'w:header="708" w:footer="708" w:gutter="0"/>' +
    '</w:sectPr>';

  const document =
    `${XML_DECLARATION}<w:document ` +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${sectPr}</w:body></w:document>`;

  const relationships =
    `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
    `<Relationship Id="rId1" Type="${REL.styles}" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${REL.numbering}" Target="numbering.xml"/>` +
    [...links.entries()]
      .map(
        ([target, id]) =>
          `<Relationship Id="${id}" Type="${REL.hyperlink}" Target="${escapeXml(target)}" TargetMode="External"/>`,
      )
      .join('') +
    '</Relationships>';

  const text = blocksToText(model);
  const words = text.split(/\s+/).filter(Boolean).length;

  return writeZip(
    [
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: rootRelsXml('word/document.xml') },
      { name: 'word/document.xml', data: document },
      { name: 'word/_rels/document.xml.rels', data: relationships },
      { name: 'word/styles.xml', data: stylesXml() },
      { name: 'word/numbering.xml', data: numberingXml() },
      { name: 'docProps/core.xml', data: corePropsXml({ title, author, created }) },
      {
        name: 'docProps/app.xml',
        data: appPropsXml({ counts: { Words: words, Paragraphs: model.length } }),
      },
    ],
    { modified: new Date(created) },
  );
}

export const DOCX_MIME = MIME.docx;
