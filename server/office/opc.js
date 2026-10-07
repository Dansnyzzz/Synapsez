/**
 * Open Packaging Conventions — the part every Office format shares.
 *
 * A .docx, .xlsx and .pptx are three different vocabularies inside one identical
 * envelope: a ZIP with a `[Content_Types].xml` at the root, a `_rels/.rels`
 * naming the main part, and a `_rels` folder beside every part that points at
 * anything else. All three readers need the same four or five moves, and all
 * three writers need the same two property parts, so they live here once.
 *
 * The namespace strings are spelled out in full rather than derived from one
 * another. They look almost identical — `/package/2006/relationships` and
 * `/officeDocument/2006/relationships` differ by one word — and building one
 * from the other by string surgery is exactly the sort of clever that produces a
 * file Word offers to repair.
 */
import { XML_DECLARATION, elements, escapeXml, parseXml } from './xml.js';

export const NS = {
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  packageRels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  officeRels: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
};

export const REL = {
  officeDocument: `${NS.officeRels}/officeDocument`,
  styles: `${NS.officeRels}/styles`,
  numbering: `${NS.officeRels}/numbering`,
  theme: `${NS.officeRels}/theme`,
  hyperlink: `${NS.officeRels}/hyperlink`,
  worksheet: `${NS.officeRels}/worksheet`,
  sharedStrings: `${NS.officeRels}/sharedStrings`,
  slide: `${NS.officeRels}/slide`,
  slideMaster: `${NS.officeRels}/slideMaster`,
  slideLayout: `${NS.officeRels}/slideLayout`,
  notesSlide: `${NS.officeRels}/notesSlide`,
  notesMaster: `${NS.officeRels}/notesMaster`,
  presProps: `${NS.officeRels}/presProps`,
  viewProps: `${NS.officeRels}/viewProps`,
  tableStyles: `${NS.officeRels}/tableStyles`,
  extendedProperties: `${NS.officeRels}/extended-properties`,
  coreProperties: `${NS.packageRels}/metadata/core-properties`,
};

export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Relationship id → `{ target, type, mode }`, from any `_rels` part. */
export function readRelationships(zip, path) {
  const map = new Map();
  if (!zip.has(path)) return map;
  const root = parseXml(zip.text(path));
  for (const rel of elements(root, 'Relationship')) {
    if (!rel.attrs.Id) continue;
    map.set(rel.attrs.Id, {
      target: rel.attrs.Target || '',
      type: rel.attrs.Type || '',
      mode: rel.attrs.TargetMode || 'Internal',
    });
  }
  return map;
}

/** `word/document.xml` → `word/_rels/document.xml.rels`. */
export const relsPathFor = (part) => part.replace(/([^/]+)$/, '_rels/$1.rels');

/**
 * A relationship target, resolved against the part that declared it.
 *
 * Targets are relative to their own part's folder and freely use `..` — a
 * slide's rels reach up to `../slideLayouts/slideLayout1.xml`. A leading slash
 * means the package root instead.
 */
export function resolveTarget(fromPart, target) {
  const value = String(target || '');
  if (!value) return '';
  if (value.startsWith('/')) return value.slice(1);

  const segments = fromPart.split('/').slice(0, -1);
  for (const piece of value.split('/')) {
    if (piece === '.' || piece === '') continue;
    if (piece === '..') segments.pop();
    else segments.push(piece);
  }
  return segments.join('/');
}

/**
 * Which part is the document itself.
 *
 * Almost always the obvious name, but that name is a relationship target rather
 * than a rule — some converters write `document2.xml` — and a reader that
 * assumed would find no text at all in a perfectly good file.
 */
export function mainPart(zip, fallback) {
  for (const [, rel] of readRelationships(zip, '_rels/.rels')) {
    // The root relationships live in `_rels/`, but their targets are relative to
    // the package root — hence a root-level pseudo-part as the base.
    if (isRel(rel.type, 'officeDocument')) return resolveTarget('.rels', rel.target);
  }
  return fallback;
}

/**
 * Whether a relationship is of this kind, in either dialect.
 *
 * Transitional OOXML (what Office writes by default) names a relationship
 * `http://schemas.openxmlformats.org/officeDocument/2006/relationships/<kind>`;
 * Strict OOXML ("Strict Open XML Spreadsheet" in Save As) uses
 * `http://purl.oclc.org/ooxml/officeDocument/relationships/<kind>`. Comparing
 * whole strings read a Strict workbook as having no shared strings — every
 * piece of text in it blank. The last segment is the kind in both.
 *
 * @param {string} type
 * @param {string} kind  e.g. 'officeDocument', 'sharedStrings', 'notesSlide'
 */
export const isRel = (type, kind) => String(type || '').endsWith(`/${kind}`);

/* ── the parts every package we write carries ───────────────────────── */

const iso = (date) => new Date(date).toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * The two property parts are a schema *sequence*, and PowerPoint enforces it.
 *
 * This is the bug that made every generated deck open with "PowerPoint found a
 * problem with content". Word and Excel read these parts in any order and say
 * nothing; PowerPoint validates them and refuses the file — over metadata that
 * nothing in the document depends on. So the order below is not tidiness, it is
 * the difference between a deck that opens and one that does not, and it is
 * worth stating where each order comes from.
 *
 * `CT_CoreProperties` runs: category, contentStatus, created, creator,
 * description, identifier, keywords, language, lastModifiedBy, lastPrinted,
 * modified, revision, subject, title, version.
 */
export function corePropsXml({ title = '', author = 'Synapsez', created = new Date(), description = '' } = {}) {
  const stamp = iso(created);
  const parts = [
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>`,
    `<dc:creator>${escapeXml(author)}</dc:creator>`,
    // Empty elements are left out entirely rather than written blank: a document
    // with no subject has no subject, and `<dc:subject></dc:subject>` is a claim
    // that it has one which happens to be empty.
    description ? `<dc:description>${escapeXml(description)}</dc:description>` : '',
    `<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>`,
    title ? `<dc:title>${escapeXml(title)}</dc:title>` : '',
  ];

  return (
    `${XML_DECLARATION}<cp:coreProperties ` +
    `xmlns:cp="${NS.coreProperties}" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    parts.join('') +
    '</cp:coreProperties>'
  );
}

/**
 * `CT_Properties` runs: Template, Manager, Company, Pages, Words, Characters,
 * PresentationFormat, Lines, Paragraphs, Slides, Notes, TotalTime,
 * HiddenSlides, MMClips, ScaleCrop, HeadingPairs, TitlesOfParts, LinksUpToDate,
 * CharactersWithSpaces, SharedDoc, HyperlinkBase, HLinks, HyperlinksChanged,
 * DigSig, Application, AppVersion, DocSecurity.
 *
 * Note where `Application` and `DocSecurity` sit: at the *end*, which is the
 * opposite of where they read most naturally.
 *
 * @param counts the numeric fields, by name — each goes into its own slot
 *   rather than being handed in as a blob of markup, because a blob has to be
 *   inserted somewhere and there is no one place that is correct for all of them.
 */
export function appPropsXml({ application = 'Synapsez', counts = {} } = {}) {
  const slot = (name) =>
    counts[name] == null ? '' : `<${name}>${escapeXml(String(counts[name]))}</${name}>`;

  return (
    `${XML_DECLARATION}<Properties ` +
    'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    slot('Pages') +
    slot('Words') +
    slot('Characters') +
    slot('PresentationFormat') +
    slot('Paragraphs') +
    slot('Slides') +
    slot('Notes') +
    '<ScaleCrop>false</ScaleCrop>' +
    '<LinksUpToDate>false</LinksUpToDate>' +
    '<SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged>' +
    `<Application>${escapeXml(application)}</Application>` +
    '<DocSecurity>0</DocSecurity>' +
    '</Properties>'
  );
}

/** The root `_rels/.rels`, which is the same three lines in every package. */
export const rootRelsXml = (mainTarget) =>
  `${XML_DECLARATION}<Relationships xmlns="${NS.packageRels}">` +
  `<Relationship Id="rId1" Type="${REL.officeDocument}" Target="${mainTarget}"/>` +
  `<Relationship Id="rId2" Type="${REL.coreProperties}" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${REL.extendedProperties}" Target="docProps/app.xml"/>` +
  '</Relationships>';

/**
 * `[Content_Types].xml`.
 *
 * Every part in the package must be typed, by extension or by name. A missing
 * override is the most common reason a hand-built file opens as "corrupt", so
 * the callers pass their overrides in and this adds the two everybody shares.
 */
export const contentTypesXml = (overrides, defaults = []) =>
  `${XML_DECLARATION}<Types xmlns="${NS.contentTypes}">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') +
  overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';
