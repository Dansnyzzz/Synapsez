/**
 * Documents, from the outside.
 *
 * Two jobs, and the rest of the app only ever needs these two:
 *
 *   `readDocument`   bytes in, `{ text, preview }` out — the text for the model,
 *                    the preview for the viewer. One entry point, so nothing
 *                    upstream has to know that a .docx is a ZIP full of XML and
 *                    a .pdf is not.
 *
 *   `createDocument` a format, a name and some Markdown, and out comes a real
 *                    file. Markdown is the authoring language for every format
 *                    on purpose: it is what a language model writes best, a
 *                    person can read the source, and one converter feeds Word,
 *                    PowerPoint, Excel and the web.
 *
 * PDFs are read here and deliberately not written. Writing one that gets
 * Vietnamese right means embedding a Unicode font, and there is no font to embed
 * that would survive being deployed — so instead of a document with □□□ where
 * the diacritics were, the viewer prints to PDF through the browser, which has
 * the fonts and gets it right. Said plainly rather than half-done.
 */
import { blockToPlainText, blocksToHtml, blocksToText, normaliseBlocks, runsToText } from './blocks.js';
import { markdownTitle, markdownToBlocks } from './markdown.js';
import { DOCX_MIME, readDocx, writeDocx } from './docx.js';
import { XLSX_MIME, readXlsx, sheetsToText, writeXlsx } from './xlsx.js';
import { PPTX_MIME, readPptx, writePptx } from './pptx.js';
import { readSheetsElsewhere } from './sheets.js';
import { looksLikeZip } from './zip.js';

export { blocksToHtml, blocksToText, normaliseBlocks } from './blocks.js';
export { markdownToBlocks, markdownTitle } from './markdown.js';

/* ── which format is this ───────────────────────────────────────────── */

const BY_MIME = new Map([
  [DOCX_MIME, 'docx'],
  [XLSX_MIME, 'xlsx'],
  [PPTX_MIME, 'pptx'],
  // The macro-enabled variants are the same package with a different content
  // type. The macros are not run, obviously; the words are still words.
  ['application/vnd.ms-word.document.macroenabled.12', 'docx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', 'pptx'],
  // Templates are the same package again.
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.template', 'xlsx'],
  ['application/vnd.ms-excel.template.macroenabled.12', 'xlsx'],
  // The spreadsheets the in-house reader does not read, and SheetJS does (sheets.js).
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.ms-excel.sheet.binary.macroenabled.12', 'xlsb'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
]);

const BY_EXTENSION = new Map([
  ['docx', 'docx'],
  ['docm', 'docx'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['xltx', 'xlsx'],
  ['xltm', 'xlsx'],
  ['xls', 'xls'],
  ['xlt', 'xls'],
  ['xlsb', 'xlsb'],
  ['ods', 'ods'],
  ['pptx', 'pptx'],
  ['pptm', 'pptx'],
]);

/** Every format read as a spreadsheet — through `readOfficeAsync`, which can fall back to SheetJS. */
export const SPREADSHEET_FORMATS = new Set(['xlsx', 'xls', 'xlsb', 'ods']);

export const extensionOf = (name) => String(name || '').split('.').pop().toLowerCase();

/**
 * Which Office format a file is, or null.
 *
 * The extension is trusted over the declared type, because browsers hand over
 * `application/octet-stream` for these constantly — and when they do declare
 * something it is occasionally the .doc type for a .docx.
 */
export function officeFormat(name, mime) {
  const extension = extensionOf(name);
  if (BY_EXTENSION.has(extension)) return BY_EXTENSION.get(extension);
  // Windows labels a .csv `application/vnd.ms-excel` whenever Excel is
  // installed. A .csv is text, inlined as written — not an old workbook.
  if (/^(csv|tsv|txt)$/.test(extension)) return null;
  return BY_MIME.get(String(mime || '').toLowerCase()) || null;
}

/**
 * The old binary formats, which are a different thing entirely.
 *
 * A .doc is not a ZIP of XML — it is a 1997 compound-file binary, and nothing
 * here can read it. Worth recognising by name so the refusal can say what to do
 * about it instead of "unsupported file". An old .xls is the exception: SheetJS
 * reads it (sheets.js), so it is accepted like any other workbook.
 */
export const isLegacyOffice = (name, mime) =>
  /\.(doc|ppt)$/i.test(String(name || '')) || /^application\/(msword|vnd\.ms-powerpoint)$/i.test(String(mime || ''));

/**
 * Source files the assistant can write.
 *
 * Kept apart from the document formats because nothing is converted: the text
 * is the file. What the extension buys is the viewer knowing how to show it,
 * the editor knowing what it is, and — for `html` — something to run.
 */
export const CODE_FORMATS = [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'cs',
  'c', 'h', 'cpp', 'php', 'sh', 'ps1', 'sql', 'css', 'scss', 'yaml', 'yml',
  'toml', 'ini', 'xml', 'svg', 'diff', 'patch', 'env', 'gitignore', 'dockerfile',
];

export const CREATABLE = ['docx', 'xlsx', 'pptx', 'md', 'txt', 'csv', 'html', 'json', ...CODE_FORMATS];

/** Which of these can be opened as a running page rather than as source. */
export const RUNNABLE = new Set(['html']);

/**
 * Whether this is markup already, rather than prose about to become markup.
 *
 * A document, a fragment, or anything with a tag that only exists to be
 * rendered or run. Deliberately not "contains a `<`": a Markdown report about
 * comparison operators is full of those and is not a web page.
 */
export const looksLikeHtml = (source) => {
  const text = String(source || '').trim();
  if (/^<!doctype\s+html/i.test(text) || /^<html[\s>]/i.test(text)) return true;
  return /<(html|head|body|script|style|div|section|main|header|footer|nav|canvas|svg|form|button|input|select|textarea|table|ul|ol|h[1-6]|p)\b[^>]*>/i.test(
    text,
  );
};

const MIME_KNOWN = {
  docx: DOCX_MIME,
  xlsx: XLSX_MIME,
  pptx: PPTX_MIME,
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
  svg: 'text/plain; charset=utf-8',
};

/**
 * The type a generated file is stored under.
 *
 * Every source format not named above is `text/plain`, deliberately. An `.svg`
 * is markup a browser will execute, and a `.js` served as JavaScript is a script
 * on this origin — the extension is what carries the meaning here, and the
 * stored type only has to be honest and inert. What gets *run* goes through one
 * route that says so; see `/api/attachments/:id/run`.
 */
export const MIME_FOR = { ...MIME_KNOWN };
for (const format of CODE_FORMATS) MIME_FOR[format] ||= 'text/plain; charset=utf-8';

/* ── reading ────────────────────────────────────────────────────────── */

/**
 * Read an Office document.
 *
 * @param format 'docx' | 'xlsx' | 'pptx'
 * @param buffer the file
 * @param mediaSrc  where picture number *n* of this document can be fetched
 *   from. Omit it and the pictures degrade to their captions, which is the
 *   right answer for a caller that has nowhere to serve bytes from — the model
 *   layer, for instance, which wants the words.
 * @returns `{ format, text, preview, meta, media }` — `preview` is the
 *   structured payload the viewer draws, and its shape depends on the format;
 *   `media` is the pictures, for a caller that offered to serve them.
 */
export function readOffice(format, buffer, { mediaSrc } = {}) {
  if (!looksLikeZip(buffer)) {
    throw Object.assign(
      new Error('That file is not a real Office document — it does not even start like one.'),
      { code: 'not_office' },
    );
  }

  if (format === 'docx') {
    const { blocks, text, meta, media } = readDocx(buffer);
    return {
      format,
      text,
      meta,
      // The pictures travel beside the preview rather than inside it: whoever
      // is serving the document decides how they are fetched, and base64 in the
      // middle of the HTML would multiply a photo-heavy report by four.
      media,
      preview: { kind: 'document', html: blocksToHtml(blocks, { mediaSrc }), meta },
      blocks,
    };
  }
  if (format === 'xlsx') {
    const { sheets, text, meta } = readXlsx(buffer);
    return { format, text, meta, preview: { kind: 'sheets', sheets, meta } };
  }
  if (format === 'pptx') {
    const { slides, text, meta } = readPptx(buffer);
    return { format, text, meta, preview: { kind: 'slides', slides, meta } };
  }
  throw new Error(`${format} is not a format this can read.`);
}

/**
 * Read any Office file, spreadsheets in every format included.
 *
 * Word and PowerPoint go straight to `readOffice`. A spreadsheet tries the
 * in-house Open XML reader first and, when it cannot — an old `.xls`, an
 * `.xlsb`, an `.ods`, a workbook it found no sheet in or could not open —
 * SheetJS on a worker (sheets.js). The model then gets the sheets instead of
 * "nothing could be read out of it".
 *
 * @param {string} format  from `officeFormat`
 * @param {Buffer} buffer
 * @param {{ mediaSrc?: (index: number) => string }} [options]
 */
export async function readOfficeAsync(format, buffer, options = {}) {
  if (!SPREADSHEET_FORMATS.has(format)) return readOffice(format, buffer, options);

  let first = null;
  if (format === 'xlsx' && looksLikeZip(buffer)) {
    try {
      const read = readOffice('xlsx', buffer, options);
      if (read.meta?.sheets) return read;
      first = Object.assign(new Error('No sheet in it could be found.'), { code: 'no_sheets' });
    } catch (err) {
      first = err;
    }
  }

  try {
    const { sheets } = await readSheetsElsewhere(buffer);
    if (!sheets.length) throw Object.assign(new Error('That workbook has no sheet with anything in it.'), { code: 'no_sheets' });
    const meta = { sheets: sheets.length };
    return { format, text: sheetsToText(sheets), meta, preview: { kind: 'sheets', sheets, meta } };
  } catch (err) {
    // The more telling of the two: a password is the answer whichever reader
    // found it; otherwise the in-house reader's reason, which names the part.
    if (err?.code === 'encrypted' || first?.code === 'encrypted') {
      throw Object.assign(new Error('That workbook is password-protected, so it cannot be read.'), { code: 'encrypted' });
    }
    throw first || err;
  }
}

/* ── writing ────────────────────────────────────────────────────────── */


/** A filename that is safe on every platform and still recognisable. */
export function safeFilename(name, format) {
  const raw = String(name || '').trim().replace(/[\\/]/g, ' ');
  const base = raw
    // Reserved on Windows, plus the control range, which no filename needs.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001F]/g, '')
    // A run of dots is a traversal attempt or an accident; either way it is not
    // part of a name. Single dots are left alone — "Report v1.2" is one.
    .replace(/\.{2,}/g, ' ')
    // A leading dot hides the file on Unix.
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const stem = (base.toLowerCase().endsWith(`.${format}`) ? base.slice(0, -(format.length + 1)) : base) || 'document';
  return `${stem.slice(0, 120)}.${format}`;
}

/**
 * Markdown → sheets.
 *
 * A heading starts a sheet, a table fills it, and anything else becomes a row of
 * its own — which is what somebody who wrote a bulleted list and asked for a
 * spreadsheet meant. A document with no headings is one sheet.
 */
function blocksToSheets(blocks, fallbackName = 'Sheet1') {
  const sheets = [];
  let current = null;

  const open = (name) => {
    current = { name, rows: [], header: false };
    sheets.push(current);
    return current;
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      open(blocksToText([block]).replace(/^#+\s*/, ''));
      continue;
    }
    if (!current) open(fallbackName);

    if (block.type === 'table') {
      // A sheet that starts with a table gets that table's header row.
      if (!current.rows.length) current.header = block.header !== false;
      for (const row of block.rows) current.rows.push(row.map((cell) => runsToText(cell.runs)));
      continue;
    }
    if (block.type === 'list') {
      for (const item of block.items) current.rows.push([runsToText(item.runs)]);
      continue;
    }
    const text = blockToPlainText(block);
    if (text) current.rows.push([text]);
  }

  return sheets.length ? sheets : [{ name: fallbackName, rows: [] }];
}

/**
 * Markdown → slides.
 *
 * Every heading is a slide; what follows it is the bullets. A level-1 heading
 * with nothing under it is a section divider, which is exactly how people write
 * a deck in Markdown without being told to.
 */
function blocksToSlides(blocks, title) {
  const slides = [];
  let current = null;

  for (const block of blocks) {
    if (block.type === 'heading') {
      current = { title: runsToText(block.runs), bullets: [], notes: '' };
      slides.push(current);
      continue;
    }
    if (!current) {
      current = { title: title || '', bullets: [], notes: '' };
      slides.push(current);
    }

    if (block.type === 'list') {
      for (const item of block.items) current.bullets.push({ level: item.level, text: runsToText(item.runs) });
      continue;
    }
    if (block.type === 'quote') {
      // A blockquote under a heading is the speaker's note for that slide —
      // the one convention worth having, because otherwise notes are unreachable
      // from Markdown at all.
      const note = runsToText(block.runs);
      current.notes = current.notes ? `${current.notes}\n${note}` : note;
      continue;
    }
    if (block.type === 'divider' || block.type === 'pagebreak') continue;

    // A table on a slide becomes one bullet per row: PowerPoint tables are not
    // written here, and a Markdown table pasted onto a slide as text is worse
    // than the rows themselves.
    if (block.type === 'table') {
      for (const row of block.rows) {
        current.bullets.push({ level: 0, text: row.map((cell) => runsToText(cell.runs)).join('  |  ') });
      }
      continue;
    }

    const text = blockToPlainText(block);
    if (text) current.bullets.push({ level: 0, text });
  }

  return slides.length ? slides : [{ title: title || 'Untitled', bullets: [] }];
}

/** Rows → CSV, quoted the way every spreadsheet expects to read it back. */
function toCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value == null ? '' : String(value);
          return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\r\n');
}

/**
 * A standalone HTML page.
 *
 * Styled in the file rather than by a stylesheet next to it, because this is
 * something people send to other people — it has to look right in an email
 * client, on a phone, and when printed to PDF, with nothing else alongside it.
 */
export function renderHtmlDocument(blocks, title) {
  const body = blocksToHtml(blocks);
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    color: #1a2027; background: #fff;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2rem 0 .6rem; }
  h1 { font-size: 2rem; margin-top: 0; }
  h2 { font-size: 1.45rem; }
  h3 { font-size: 1.2rem; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 1rem; }
  ul, ol { padding-left: 1.4rem; }
  li { margin: .25rem 0; }
  blockquote { margin-left: 0; padding: .1rem 0 .1rem 1rem; border-left: 3px solid #cbd5df; color: #48555f; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .92em;
         background: #f1f3f5; padding: .1em .35em; border-radius: 4px; }
  pre { background: #f6f8fa; padding: 1rem; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  th, td { border: 1px solid #d8dfe6; padding: .5rem .65rem; text-align: left; vertical-align: top; }
  th { background: #f1f4f7; }
  hr { border: 0; border-top: 1px solid #d8dfe6; margin: 2rem 0; }
  a { color: #0b62c4; }
  .pagebreak { break-after: page; }
  @media print { body { max-width: none; padding: 0; } }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #10151a; }
    blockquote { border-color: #2b3640; color: #a9b6c2; }
    code, pre, th { background: #1a2229; }
    th, td { border-color: #29333c; }
    a { color: #6cb6ff; }
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const escapeHtmlText = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Build a file.
 *
 * @param format   one of `CREATABLE`
 * @param name     what to call it; the extension is corrected to match
 * @param content  Markdown, or — for `xlsx`/`csv` — Markdown tables, CSV, or a
 *                 JSON object of `{ sheets: [{ name, rows }] }`
 * @param title    document title, for the file's own properties
 * @returns `{ name, mime, format, buffer, text, source }` where `source` is the
 *   content it was built from, kept so a later edit starts from the words rather
 *   than from a parsed approximation of them
 */
/**
 * @param {{
 *   format?: string, name?: string, content?: string, title?: string,
 *   author?: string, created?: Date,
 * }} [args]
 *
 * Written out because only the two with defaults were being inferred: with the
 * rest unmarked, every caller read as passing properties the type did not have.
 */
export function createDocument({ format, name, content, title, author = 'Synapsez', created = new Date() } = {}) {
  const kind = String(format || '').toLowerCase();
  if (!CREATABLE.includes(kind)) {
    throw Object.assign(
      new Error(
        `"${format}" is not a format that can be created. Use one of: ${CREATABLE.join(', ')}. ` +
          'For a PDF, make a .docx or .html and use Print → Save as PDF in the file viewer.',
      ),
      { code: 'bad_format' },
    );
  }

  const source = String(content ?? '');
  const heading = title || markdownTitle(source) || null;
  const filename = safeFilename(name || heading || 'document', kind);
  const documentTitle = heading || filename.replace(/\.[^.]+$/, '');

  const build = () => {
    // Source is source: nothing is converted, and the extension is what tells
    // the viewer how to show it and whether it can be run.
    if (kind === 'md' || kind === 'txt' || CODE_FORMATS.includes(kind)) {
      return { buffer: Buffer.from(source, 'utf8'), text: source };
    }
    if (kind === 'json') {
      // Reformatted rather than passed through, which also validates it: a file
      // named .json that does not parse is worse than an error.
      let parsed;
      try {
        parsed = JSON.parse(source);
      } catch (err) {
        throw Object.assign(new Error(`That is not valid JSON: ${err.message}`), { code: 'bad_json' });
      }
      const pretty = `${JSON.stringify(parsed, null, 2)}\n`;
      return { buffer: Buffer.from(pretty, 'utf8'), text: pretty };
    }

    const blocks = normaliseBlocks(markdownToBlocks(source));

    /**
     * A page, either written or described.
     *
     * Two completely different requests share this format. "Write the report as
     * a web page" is Markdown, and wants the styled shell around it. "Build me
     * a calculator" is a page — real markup, real script — and running *that*
     * through a Markdown renderer escapes the whole thing into a paragraph,
     * which is precisely what it used to do: an artifact that displayed its own
     * source instead of doing anything.
     *
     * Markup that is already markup is left exactly as written.
     */
    if (kind === 'html') {
      if (looksLikeHtml(source)) return { buffer: Buffer.from(source, 'utf8'), text: source };
      const html = renderHtmlDocument(blocks, documentTitle);
      return { buffer: Buffer.from(html, 'utf8'), text: blocksToText(blocks) };
    }
    if (kind === 'docx') {
      return { buffer: writeDocx({ blocks, title: documentTitle, author, created }), text: blocksToText(blocks) };
    }
    if (kind === 'pptx') {
      const slides = blocksToSlides(blocks, documentTitle);
      return {
        buffer: writePptx({ slides, title: documentTitle, author, created }),
        text: blocksToText(blocks),
      };
    }

    // xlsx and csv share their input: tables, however they were written.
    const sheets = parseSheetSource(source, blocks, documentTitle);
    if (kind === 'csv') {
      // A CSV is one table, so the widest sheet is the one that was meant —
      // the prose above a table becomes a one-column sheet, and writing that
      // out instead of the data is the wrong file entirely.
      const widest = [...sheets].sort(
        (a, b) =>
          Math.max(...b.rows.map((row) => row.length), 0) - Math.max(...a.rows.map((row) => row.length), 0) ||
          b.rows.length - a.rows.length,
      )[0];
      const csv = toCsv(widest?.rows || []);
      // A byte-order mark, because Excel opens a UTF-8 CSV without one as
      // Latin-1 — which is exactly how Vietnamese turns into mojibake.
      return { buffer: Buffer.from(`\uFEFF${csv}`, 'utf8'), text: csv };
    }
    return {
      buffer: writeXlsx({ sheets, title: documentTitle, author, created }),
      text: sheets.map((sheet) => `## ${sheet.name}\n${toCsv(sheet.rows)}`).join('\n\n'),
    };
  };

  const { buffer, text } = build();
  return { name: filename, mime: MIME_FOR[kind], format: kind, buffer, text, source };
}

/**
 * Sheets, from whichever way the content was written.
 *
 * A model asked for a spreadsheet may reasonably produce JSON, a CSV block, or
 * Markdown tables. All three are what was meant, so all three work rather than
 * two of them being a mistake nobody explained.
 */
function parseSheetSource(source, blocks, fallbackName) {
  const trimmed = source.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const sheets = Array.isArray(parsed) ? [{ name: fallbackName, rows: parsed }] : parsed.sheets;
      if (Array.isArray(sheets) && sheets.every((sheet) => Array.isArray(sheet?.rows))) {
        return sheets.map((sheet, i) => ({
          name: String(sheet.name || `Sheet${i + 1}`),
          header: sheet.header !== false,
          rows: sheet.rows.map((row) => (Array.isArray(row) ? row : [row])),
        }));
      }
    } catch {
      // Not JSON after all — fall through and read it as Markdown, which is
      // what a document starting with a brace usually is.
    }
  }

  // Raw CSV: no Markdown structure at all, but every line has commas.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  const looksCsv =
    lines.length > 1 && !trimmed.includes('|') && !/^#/m.test(trimmed) && lines.every((line) => line.includes(','));
  if (looksCsv) {
    return [{ name: fallbackName.slice(0, 31), header: true, rows: lines.map(parseCsvLine) }];
  }

  return blocksToSheets(blocks, fallbackName);
}

/** One CSV line → cells, honouring quotes and doubled quotes inside them. */
export function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}
