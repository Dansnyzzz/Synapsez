/**
 * Slide decks, in both directions.
 *
 * Reading one is a walk over the shapes of each slide, pulling out the title,
 * the bullets and their indent levels, any table, and the speaker notes — which
 * live in a part of their own and are the half of a deck that says what the
 * bullets mean.
 *
 * Writing one is the fussiest job in this folder. PowerPoint is far less
 * forgiving than Word or Excel about a package that is missing something: a deck
 * with no theme, or a master with an incomplete colour map, does not degrade —
 * it refuses to open. So the package here is complete rather than minimal, every
 * shape carries its own position instead of inheriting one from a placeholder,
 * and the notes parts appear only when a slide actually has notes.
 *
 * Not attempted: images, charts, transitions, animation, and any layout beyond
 * "title and body" or "section header". A deck written here is the shape of a
 * deck somebody would go on to design, with the words already right.
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
  isRel,
  mainPart,
  readRelationships,
  relsPathFor,
  resolveTarget,
  rootRelsXml,
} from './opc.js';

/** 16:9, in English Metric Units — 914400 to the inch. */
const DECK = { width: 12192000, height: 6858000 };
const EMU = { margin: 838200, titleTop: 640080, bodyTop: 1825625 };

/* ══ reading ═══════════════════════════════════════════════════════════ */

/** One `a:p` as text, with its indent level. */
function readTextParagraph(node) {
  const properties = element(node, 'pPr');
  const level = Number(attr(properties, 'lvl') || 0);

  let text = '';
  for (const child of elements(node)) {
    const name = localName(child.name);
    if (name === 'r') text += textOf(element(child, 't') || {});
    else if (name === 'br') text += '\n';
    else if (name === 'fld') text += textOf(element(child, 't') || {});
  }
  return { level, text: text.trim() };
}

function readTextBody(shape) {
  const body = element(shape, 'txBody');
  if (!body) return [];
  return elements(body, 'p')
    .map(readTextParagraph)
    .filter((paragraph) => paragraph.text);
}

/** What kind of placeholder a shape is, when it is one. */
function placeholderType(shape) {
  const ph = element(element(element(shape, 'nvSpPr'), 'nvPr'), 'ph');
  return ph ? String(attr(ph, 'type') || 'body') : null;
}

function readSlideTable(frame) {
  const table = [...descendants(frame, 'tbl')][0];
  if (!table) return null;

  const rows = [];
  for (const tr of elements(table, 'tr')) {
    const cells = [];
    for (const tc of elements(tr, 'tc')) {
      cells.push({ runs: [{ text: readTextBody(tc).map((p) => p.text).join('\n') }] });
    }
    if (cells.length) rows.push(cells);
  }
  return rows.length ? { type: 'table', header: true, rows } : null;
}

function readSlide(zip, path) {
  const root = parseXml(zip.text(path));
  const tree = element(element(root, 'cSld'), 'spTree');

  let title = '';
  const bullets = [];
  const tables = [];

  for (const shape of elements(tree)) {
    const name = localName(shape.name);

    if (name === 'graphicFrame') {
      const table = readSlideTable(shape);
      if (table) tables.push(table);
      continue;
    }
    if (name !== 'sp') continue;

    const type = placeholderType(shape);
    const paragraphs = readTextBody(shape);
    if (!paragraphs.length) continue;

    // The first title-ish placeholder wins; a deck with two is a deck where the
    // second one is a subtitle.
    if (!title && (type === 'title' || type === 'ctrTitle')) {
      title = paragraphs.map((p) => p.text).join(' ');
      continue;
    }
    for (const paragraph of paragraphs) bullets.push(paragraph);
  }

  // Notes live in a part of their own, reached through this slide's rels.
  let notes = '';
  for (const [, rel] of readRelationships(zip, relsPathFor(path))) {
    if (!isRel(rel.type, 'notesSlide')) continue;
    const notesPath = resolveTarget(path, rel.target);
    if (!zip.has(notesPath)) continue;

    const notesRoot = parseXml(zip.text(notesPath));
    const notesTree = element(element(notesRoot, 'cSld'), 'spTree');
    for (const shape of elements(notesTree, 'sp')) {
      // The notes part also contains a copy of the slide's own text, in a
      // placeholder of type `sldImg`/`body`; only the body is the notes.
      if (placeholderType(shape) !== 'body') continue;
      notes = readTextBody(shape)
        .map((p) => p.text)
        .join('\n')
        .trim();
    }
  }

  return { title, bullets, tables, notes };
}

/**
 * Read a .pptx.
 *
 * @returns `{ slides, text, meta }`
 */
export function readPptx(buffer) {
  const zip = openZip(buffer);
  const presentationPath = mainPart(zip, 'ppt/presentation.xml');
  if (!zip.has(presentationPath)) {
    throw Object.assign(new Error('That .pptx has no presentation part — it may be corrupt.'), { code: 'not_pptx' });
  }

  const root = parseXml(zip.text(presentationPath));
  const rels = readRelationships(zip, relsPathFor(presentationPath));

  const slides = [];
  // `sldIdLst` is the running order, which is not the order the parts happen to
  // be stored in — a deck whose slides were reordered would come out shuffled.
  for (const entry of descendants(element(root, 'sldIdLst') || root, 'sldId')) {
    const rel = rels.get(relationshipId(entry));
    if (!rel) continue;
    const path = resolveTarget(presentationPath, rel.target);
    if (!zip.has(path)) continue;
    slides.push({ index: slides.length + 1, ...readSlide(zip, path) });
  }

  return { slides, text: slidesToText(slides), meta: { slides: slides.length } };
}

/** The deck as Markdown: one heading per slide, its bullets under it. */
export function slidesToText(slides) {
  const out = [];
  for (const slide of slides) {
    out.push(`## Slide ${slide.index}${slide.title ? `: ${slide.title}` : ''}`);
    for (const bullet of slide.bullets) {
      out.push(`${'  '.repeat(Math.min(bullet.level, 4))}- ${bullet.text}`);
    }
    for (const table of slide.tables || []) {
      for (const row of table.rows) out.push(`| ${row.map((cell) => cell.runs[0].text).join(' | ')} |`);
    }
    if (slide.notes) out.push('', `Notes: ${slide.notes}`);
    out.push('');
  }
  return out.join('\n').trim();
}

/* ══ writing ═══════════════════════════════════════════════════════════ */

const PRESENTATION = 'application/vnd.openxmlformats-officedocument.presentationml';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PML_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/**
 * The theme.
 *
 * PowerPoint requires one, and requires it complete: twelve colours, two font
 * slots, and exactly three entries in each of the four format lists. A theme
 * that is short of any of them is not a plainer deck — it is a file that will
 * not open, which is why this is spelled out in full rather than trimmed.
 */
function themeXml() {
  const colour = (name, value) =>
    name === 'dk1' || name === 'lt1'
      ? `<a:${name}><a:sysClr val="${value}" lastClr="${value === 'windowText' ? '000000' : 'FFFFFF'}"/></a:${name}>`
      : `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;

  const fill =
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:gradFill rotWithShape="1"><a:gsLst>' +
    '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="60000"/><a:satMod val="120000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:gs>' +
    '</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
    '<a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/></a:schemeClr></a:solidFill>';

  const line = (width) =>
    `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    '<a:prstDash val="solid"/></a:ln>';

  return (
    `${XML_DECLARATION}<a:theme xmlns:a="${DRAWING_NS}" name="Synapsez">` +
    '<a:themeElements>' +
    '<a:clrScheme name="Synapsez">' +
    colour('dk1', 'windowText') +
    colour('lt1', 'window') +
    colour('dk2', '1F2933') +
    colour('lt2', 'F4F6F8') +
    colour('accent1', '2F7F5F') +
    colour('accent2', '3C7DD9') +
    colour('accent3', 'C98A2B') +
    colour('accent4', '8A5CD1') +
    colour('accent5', '2FA3A3') +
    colour('accent6', 'C0543F') +
    colour('hlink', '0563C1') +
    colour('folHlink', '954F72') +
    '</a:clrScheme>' +
    '<a:fontScheme name="Synapsez">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Synapsez">' +
    `<a:fillStyleLst>${fill}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '</a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}</a:bgFillStyleLst>` +
    '</a:fmtScheme>' +
    '</a:themeElements>' +
    '</a:theme>'
  );
}

/** The shape tree every slide-like part starts from. */
const shapeTree = (shapes) =>
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  `${shapes}</p:spTree>`;

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const partHead = (tag) => `${XML_DECLARATION}<p:${tag} xmlns:a="${DRAWING_NS}" xmlns:r="${NS.officeRels}" xmlns:p="${PML_NS}">`;

/**
 * Where the title and the body sit, on every slide-like part.
 *
 * One set of numbers, used by the master, the layout and the slides, because a
 * placeholder whose geometry disagrees with the one it inherits from is how a
 * deck ends up with the title in two different places depending on what you
 * click.
 */
const FRAME = {
  title: { x: EMU.margin, y: EMU.titleTop, width: DECK.width - EMU.margin * 2, height: 1000000 },
  body: {
    x: EMU.margin,
    y: EMU.bodyTop,
    width: DECK.width - EMU.margin * 2,
    height: DECK.height - EMU.bodyTop - EMU.margin,
  },
};

function slideMasterXml() {
  // A master with an empty shape tree is not a plainer master — it is one whose
  // placeholders resolve to nothing, and a slide inheriting from nothing is
  // exactly what PowerPoint calls a problem with content.
  const shapes =
    placeholderShape({
      id: 2,
      name: 'Title Placeholder 1',
      ph: 'type="title"',
      ...FRAME.title,
      anchor: 'b',
      paragraphs: [],
    }) +
    placeholderShape({
      id: 3,
      name: 'Text Placeholder 2',
      ph: 'type="body" idx="1"',
      ...FRAME.body,
      anchor: 't',
      bulleted: true,
      paragraphs: [],
    });

  return (
    `${partHead('sldMaster')}<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
    `${shapeTree(shapes)}</p:cSld>${CLR_MAP}` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles>' +
    '<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
    '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr marL="285750" indent="-285750"><a:buChar char="•"/>' +
    '<a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>' +
    '<a:lvl2pPr marL="628650" indent="-285750"><a:buChar char="–"/><a:defRPr sz="1800"/></a:lvl2pPr>' +
    '<a:lvl3pPr marL="971550" indent="-285750"><a:buChar char="•"/><a:defRPr sz="1600"/></a:lvl3pPr>' +
    '<a:lvl4pPr marL="1314450" indent="-285750"><a:buChar char="–"/><a:defRPr sz="1400"/></a:lvl4pPr>' +
    '<a:lvl5pPr marL="1657350" indent="-285750"><a:buChar char="•"/><a:defRPr sz="1400"/></a:lvl5pPr>' +
    '</p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>' +
    '</p:txStyles></p:sldMaster>'
  );
}

function slideLayoutXml() {
  // Written out rather than through `partHead` because a layout carries two
  // attributes of its own on the root element.
  const shapes =
    placeholderShape({ id: 2, name: 'Title 1', ph: 'type="title"', ...FRAME.title, anchor: 'b', paragraphs: [] }) +
    placeholderShape({
      id: 3,
      name: 'Content Placeholder 2',
      ph: 'idx="1"',
      ...FRAME.body,
      anchor: 't',
      bulleted: true,
      paragraphs: [],
    });

  return (
    `${XML_DECLARATION}<p:sldLayout xmlns:a="${DRAWING_NS}" xmlns:r="${NS.officeRels}" xmlns:p="${PML_NS}" ` +
    'type="obj" preserve="1">' +
    `<p:cSld name="Title and Content">${shapeTree(shapes)}</p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sldLayout>'
  );
}

/**
 * One placeholder shape.
 *
 * `ph` is the placeholder's own attributes — `type="title"`, or `idx="1"` for
 * the content one. Those have to line up across the master, the layout and the
 * slide: a slide placeholder is matched to its layout by type and index, and one
 * that matches nothing is a shape with no inherited formatting at best and a
 * repair prompt at worst.
 *
 * Geometry is written on every shape anyway, so a deck opened somewhere that
 * resolves inheritance differently still puts the text where it belongs.
 */
function placeholderShape({
  id,
  name,
  ph,
  x,
  y,
  width,
  height,
  paragraphs,
  size = 2000,
  bold = false,
  colour = '25313B',
  anchor = 't',
  bulleted = false,
}) {
  const body = (paragraphs || [])
    .map((paragraph) => {
      const level = Math.min(Math.max(Number(paragraph.level) || 0, 0), 4);
      const marL = bulleted ? ` marL="${285750 + level * 342900}" indent="-285750"` : '';
      const bullet = bulleted ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>';
      const properties = `<a:pPr lvl="${level}"${marL}>${bullet}</a:pPr>`;
      const runSize = Math.max(size - level * 200, 1000);
      const runs = String(paragraph.text)
        .split('\n')
        .map(
          (line, i) =>
            `${i ? '<a:br/>' : ''}<a:r><a:rPr lang="en-US" sz="${runSize}"${bold ? ' b="1"' : ''} dirty="0">` +
            `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:rPr>` +
            `<a:t>${escapeXml(line)}</a:t></a:r>`,
        )
        .join('');
      return `<a:p>${properties}${runs}</a:p>`;
    })
    .join('');

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    `<p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    `${body || '<a:p/>'}</p:txBody></p:sp>`
  );
}

function slideXml(slide) {
  const shapes = [];

  const title = String(slide.title || '').trim();
  const bullets = (slide.bullets || [])
    .map((bullet) => (typeof bullet === 'string' ? { level: 0, text: bullet } : bullet))
    .filter((bullet) => String(bullet?.text || '').trim());

  // A slide with a title and nothing else is a section divider: the title sits
  // in the middle of the slide rather than at the top of an empty one. It is
  // still the `title` placeholder — a `ctrTitle` that the layout does not have
  // is a placeholder pointing at nothing.
  const divider = !!title && !bullets.length;

  if (title) {
    shapes.push(
      placeholderShape({
        id: 2,
        name: 'Title 1',
        ph: 'type="title"',
        x: FRAME.title.x,
        y: divider ? Math.round(DECK.height / 2 - 800000) : FRAME.title.y,
        width: FRAME.title.width,
        height: divider ? 1600000 : FRAME.title.height,
        paragraphs: [{ level: 0, text: title }],
        size: divider ? 4400 : 3600,
        bold: true,
        colour: '11161B',
        anchor: divider ? 'ctr' : 'b',
      }),
    );
  }

  if (bullets.length) {
    shapes.push(
      placeholderShape({
        id: 3,
        name: 'Content Placeholder 2',
        ph: 'idx="1"',
        x: FRAME.body.x,
        y: title ? FRAME.body.y : EMU.titleTop,
        width: FRAME.body.width,
        height: DECK.height - (title ? FRAME.body.y : EMU.titleTop) - EMU.margin,
        paragraphs: bullets,
        bulleted: true,
      }),
    );
  }

  return (
    `${partHead('sld')}<p:cSld>${shapeTree(shapes.join(''))}</p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/** The notes master, with the body placeholder every notes slide inherits from. */
function notesMasterXml() {
  const shape = placeholderShape({
    id: 2,
    name: 'Notes Placeholder 1',
    ph: 'type="body" idx="1"',
    x: 685800,
    y: 4400550,
    width: 5486400,
    height: 4114800,
    size: 1200,
    colour: '000000',
    paragraphs: [],
  });

  return (
    `${partHead('notesMaster')}<p:cSld>${shapeTree(shape)}</p:cSld>${CLR_MAP}` +
    '<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle></p:notesMaster>'
  );
}

function notesSlideXml(notes) {
  const shape = placeholderShape({
    id: 2,
    name: 'Notes Placeholder 1',
    ph: 'type="body" idx="1"',
    x: 685800,
    y: 4400550,
    width: 5486400,
    height: 4114800,
    paragraphs: String(notes)
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => ({ level: 0, text: line })),
    size: 1200,
    colour: '000000',
  });

  return (
    `${partHead('notes')}<p:cSld>${shapeTree(shape)}</p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

/**
 * Build a .pptx.
 *
 * @param slides `[{ title, bullets: [{ level, text }] | [string], notes }]`
 * @returns a Buffer holding the whole package
 */
export function writePptx({ slides, title = 'Presentation', author = 'Synapsez', created = new Date() } = {}) {
  const list = (Array.isArray(slides) ? slides : []).filter(Boolean);
  const deck = list.length ? list : [{ title, bullets: [] }];
  const withNotes = deck.some((slide) => String(slide.notes || '').trim());

  const parts = [];
  const slideRels = [];

  deck.forEach((slide, i) => {
    const n = i + 1;
    parts.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(slide) });

    const notes = String(slide.notes || '').trim();
    const rels = [`<Relationship Id="rId1" Type="${REL.slideLayout}" Target="../slideLayouts/slideLayout1.xml"/>`];
    if (notes) {
      parts.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesSlideXml(notes) });
      parts.push({
        name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        data:
          `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
          `<Relationship Id="rId1" Type="${REL.notesMaster}" Target="../notesMasters/notesMaster1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL.slide}" Target="../slides/slide${n}.xml"/>` +
          '</Relationships>',
      });
      rels.push(`<Relationship Id="rId2" Type="${REL.notesSlide}" Target="../notesSlides/notesSlide${n}.xml"/>`);
    }
    parts.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">${rels.join('')}</Relationships>`,
    });
    slideRels.push(n);
  });

  /**
   * The presentation's own relationships.
   *
   * Built as a list rather than by arithmetic on indexes, because the numbering
   * has to stay consistent with `sldIdLst` and `notesMasterIdLst` and an
   * off-by-one there is a deck that opens with the wrong slide order or does not
   * open at all.
   *
   * `presProps`, `viewProps` and `tableStyles` are here because a real deck has
   * them. They hold nothing this application sets — window state, table style
   * defaults — and PowerPoint refuses a package that is missing them, which is
   * exactly the failure this cost a morning to find: every other reader in the
   * world opened the file, and PowerPoint offered to repair it.
   */
  const relations = [{ type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' }];
  const slideRelId = new Map();
  for (const n of slideRels) {
    relations.push({ type: REL.slide, target: `slides/slide${n}.xml` });
    slideRelId.set(n, `rId${relations.length}`);
  }
  if (withNotes) relations.push({ type: REL.notesMaster, target: 'notesMasters/notesMaster1.xml' });
  const notesMasterRelId = withNotes ? `rId${relations.length}` : null;
  relations.push(
    { type: REL.presProps, target: 'presProps.xml' },
    { type: REL.viewProps, target: 'viewProps.xml' },
    { type: REL.theme, target: 'theme/theme1.xml' },
    { type: REL.tableStyles, target: 'tableStyles.xml' },
  );

  const presentationRels =
    `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
    relations
      .map((rel, i) => `<Relationship Id="rId${i + 1}" Type="${rel.type}" Target="${rel.target}"/>`)
      .join('') +
    '</Relationships>';

  const presentation =
    `${partHead('presentation')}<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    (notesMasterRelId ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>` : '') +
    '<p:sldIdLst>' +
    slideRels.map((n) => `<p:sldId id="${255 + n}" r:id="${slideRelId.get(n)}"/>`).join('') +
    '</p:sldIdLst>' +
    `<p:sldSz cx="${DECK.width}" cy="${DECK.height}" type="screen16x9"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>';

  const overrides = [
    ['/ppt/presentation.xml', `${PRESENTATION}.presentation.main+xml`],
    ['/ppt/slideMasters/slideMaster1.xml', `${PRESENTATION}.slideMaster+xml`],
    ['/ppt/slideLayouts/slideLayout1.xml', `${PRESENTATION}.slideLayout+xml`],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/ppt/presProps.xml', `${PRESENTATION}.presProps+xml`],
    ['/ppt/viewProps.xml', `${PRESENTATION}.viewProps+xml`],
    ['/ppt/tableStyles.xml', `${PRESENTATION}.tableStyles+xml`],
    ...slideRels.map((n) => [`/ppt/slides/slide${n}.xml`, `${PRESENTATION}.slide+xml`]),
  ];
  if (withNotes) {
    overrides.push(['/ppt/notesMasters/notesMaster1.xml', `${PRESENTATION}.notesMaster+xml`]);
    overrides.push(['/ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml']);
    for (const part of parts) {
      if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(part.name)) {
        overrides.push([`/${part.name}`, `${PRESENTATION}.notesSlide+xml`]);
      }
    }
  }

  return writeZip(
    [
      { name: '[Content_Types].xml', data: contentTypesXml(overrides) },
      { name: '_rels/.rels', data: rootRelsXml('ppt/presentation.xml') },
      { name: 'ppt/presentation.xml', data: presentation },
      { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
      { name: 'ppt/slideMasters/slideMaster1.xml', data: slideMasterXml() },
      {
        name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        data:
          `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
          `<Relationship Id="rId1" Type="${REL.slideLayout}" Target="../slideLayouts/slideLayout1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL.theme}" Target="../theme/theme1.xml"/>` +
          '</Relationships>',
      },
      { name: 'ppt/slideLayouts/slideLayout1.xml', data: slideLayoutXml() },
      {
        name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
        data:
          `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
          `<Relationship Id="rId1" Type="${REL.slideMaster}" Target="../slideMasters/slideMaster1.xml"/>` +
          '</Relationships>',
      },
      { name: 'ppt/theme/theme1.xml', data: themeXml() },
      // Three parts that hold nothing this application decides — window state,
      // print setup, table style defaults. PowerPoint expects them anyway.
      { name: 'ppt/presProps.xml', data: `${partHead('presentationPr')}</p:presentationPr>` },
      { name: 'ppt/viewProps.xml', data: `${partHead('viewPr')}</p:viewPr>` },
      {
        name: 'ppt/tableStyles.xml',
        data:
          `${XML_DECLARATION}<a:tblStyleLst xmlns:a="${DRAWING_NS}" ` +
          'def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>',
      },
      ...(withNotes
        ? [
            { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMasterXml() },
            {
              name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
              data:
                `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
                `<Relationship Id="rId1" Type="${REL.theme}" Target="../theme/theme2.xml"/>` +
                '</Relationships>',
            },
            /**
             * The notes master's own theme, identical to the slide master's.
             *
             * A theme part belongs to exactly one master. Pointing both masters
             * at `theme1.xml` looks like sensible deduplication and is the one
             * thing that made every deck with speaker notes in it refuse to
             * open — while a deck without notes opened perfectly, which is what
             * made it hard to see.
             */
            { name: 'ppt/theme/theme2.xml', data: themeXml() },
          ]
        : []),
      ...parts,
      { name: 'docProps/core.xml', data: corePropsXml({ title, author, created }) },
      {
        name: 'docProps/app.xml',
        data: appPropsXml({
          counts: {
            Slides: deck.length,
            Notes: deck.filter((slide) => String(slide.notes || '').trim()).length,
            PresentationFormat: 'Widescreen',
            Paragraphs: deck.reduce((n, slide) => n + (slide.bullets?.length || 0), 0),
          },
        }),
      },
    ],
    { modified: new Date(created) },
  );
}

export const PPTX_MIME = MIME.pptx;
