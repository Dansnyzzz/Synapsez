import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { escapeHtml, renderMarkdown, wireCopyButtons } from './markdown.js';
import { MONO, TABLE, CELL, HEAD, writeRich } from './clipboard.js';
import { openMenu } from './menu.js';
import { toast } from './render.js';
import { humanSize } from './format.js';

/**
 * Paper, and nothing else: what a printed or saved document looks like. Kept
 * deliberately plain — black on white, the document's own structure, tables
 * that repeat their header and do not split a row.
 */
const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  html, body { background: #fff; color: #111; }
  body { margin: 0; font: 11.5pt/1.55 -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; }
  .doc, .grid-wrap, .slides { max-width: none; padding: 0; margin: 0; }
  h1 { font-size: 20pt; margin: 0 0 10pt; } h2 { font-size: 15pt; margin: 16pt 0 6pt; } h3 { font-size: 12.5pt; margin: 12pt 0 4pt; }
  h1, h2, h3 { break-after: avoid; color: #000; }
  p, li { orphans: 2; widows: 2; }
  a { color: #000; text-decoration: underline; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 10pt; }
  th, td { border: 1px solid #bbb; padding: 4pt 6pt; text-align: left; vertical-align: top; color: #111; background: none; }
  thead { display: table-header-group; } th { background: #f0f0f0; font-weight: 600; }
  tr { break-inside: avoid; }
  img { max-width: 100%; height: auto; }
  .figure { break-inside: avoid; text-align: center; }
  pre, code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; white-space: pre-wrap; word-break: break-word; }
  button, .grid__corner { display: none; }
  .slide { break-after: page; border: 1px solid #ccc; padding: 12pt; margin-bottom: 12pt; }
`;

const LINK_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.6-2.6a3.2 3.2 0 0 0-4.5-4.5l-1 1"/><path d="M11.5 8.5a3.2 3.2 0 0 0-4.5 0L4.4 11.1a3.2 3.2 0 0 0 4.5 4.5l1-1"/></svg>';
/** Google Drive's mark, in its own colours — fixed markup, never data. */
const DRIVE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#0f9d58" d="M7.7 3.5h8.6l5.2 9h-8.6z"/><path fill="#ffc107" d="M2.5 16.5 6.8 9l4.3 7.5-4.3 4z"/><path fill="#1a73e8" d="M6.8 20.5 11.1 13h10.4l-4.3 7.5z"/></svg>';


/**
 * The parent's half of the artifact storage bridge.
 *
 * An artifact runs in an opaque origin with `connect-src 'none'`, so it cannot call
 * the API — it can only ask its parent to. This listens for those requests and
 * makes the call, which is what puts the session cookie on it.
 *
 * **The frame does not get to say which artifact it is.** The id comes from the
 * `data-artifact` attribute on the frame element this window created, matched by
 * `event.source`. A page that could name its own bucket could read another
 * artifact's data, and a model writes that page.
 *
 * Registered once, at module scope, rather than per render: the frame is replaced
 * whenever the viewer redraws, and a listener per render would pile up.
 */
window.addEventListener('message', async (event) => {
  const message = event.data;
  if (!message || message.__artifactStorage !== true) return;

  // Which of our frames sent this? If none, it is not ours to answer.
  const frame = [...document.querySelectorAll('iframe[data-artifact]')].find(
    (node) => node.contentWindow === event.source,
  );
  const reply = (body) => event.source?.postMessage({ __artifactStorageReply: true, id: message.id, ...body }, '*');
  if (!frame) return reply({ error: t('viewer.noStorage') });

  const id = encodeURIComponent(frame.dataset.artifact);
  const key = message.key == null ? null : String(message.key);

  try {
    if (message.op === 'get') {
      const { value } = await api.artifactStorageGet(id, key);
      return reply({ value });
    }
    if (message.op === 'list') {
      const { values } = await api.artifactStorageGet(id, null);
      return reply({ value: values });
    }
    if (message.op === 'set') {
      await api.artifactStorageSet(id, key, message.value);
      return reply({ value: true });
    }
    if (message.op === 'delete') {
      await api.artifactStorageDelete(id, key);
      return reply({ value: true });
    }
    if (message.op === 'clear') {
      await api.artifactStorageDelete(id, null);
      return reply({ value: true });
    }
    return reply({ error: `Unknown storage operation "${message.op}".` });
  } catch (err) {
    // Reported back rather than swallowed: the page is waiting on a promise, and
    // a rejection it can catch beats a timeout ten seconds later.
    return reply({ error: err.message });
  }
});
/**
 * A file, open beside the conversation.
 *
 * It used to be a sheet over the transcript, and that was the wrong shape. A
 * document is something you read *while* you keep talking about it — quote a
 * line back, ask for one number changed, look again — and a modal made every
 * one of those start with closing it. So it lives in the right-hand rail, the
 * same rail the plan and the sandbox use, and the conversation stays where it
 * is. `⤢` gives it the whole window when the document is the only thing that
 * matters for a minute.
 *
 * A Word document, a spreadsheet and a slide deck cannot be shown by a browser,
 * so the server reads them and hands over structure, and this draws it. That is
 * the whole design: the preview is rendered from the *same reading* the model
 * was given, so what you are looking at and what the assistant answered from
 * cannot quietly disagree. A preview generated some other way would eventually
 * differ, and the difference would surface as the assistant "lying" about a
 * document sitting open on the screen.
 *
 * PDFs are the exception and go in a frame, because every browser already has a
 * far better PDF viewer than this could be. The extracted text is one tab away
 * for the case that defeats the frame: a phone that will not render one inline,
 * and a scan that has no text at all — where saying so is the answer.
 *
 * Everything here is built from strings the server escaped or that this file
 * escapes. The document being previewed may have arrived from a stranger.
 */

const $ = (id) => document.getElementById(id);


const ago = (value) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return t('time.justNow');
  if (seconds < 3600) return t('time.minShort', { n: Math.round(seconds / 60) });
  if (seconds < 86400) return t('time.hoursShort', { n: Math.round(seconds / 3600) });
  return new Date(then).toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' });
};

/** 0 → A, 26 → AA. The column headers of a spreadsheet. */
function columnLabel(index) {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** One CSV line → cells, honouring quotes. Mirrors the server's reader. */
function splitCsvLine(line) {
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
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * @param onChange called when a file is edited from in here, so whatever is
 *   listing files can refresh rather than showing yesterday's size.
 * @param onOpen   called when the panel takes the rail, so whatever else was
 *   in it can stand down.
 * @param onClose  called when it gives the rail back.
 */
export function createViewer({ onChange, onOpen, onClose } = {}) {
  const pane = $('filepane');
  const titleNode = $('viewer-title');
  const kindNode = $('viewer-kind');
  const bodyNode = $('viewer-body');
  const tabsNode = $('viewer-tabs');
  const versionsNode = $('viewer-versions');
/**
   * Whether this account let the assistant use Google Drive — asked of the
   * server at most once a minute, since connecting happens in Settings and the
   * menu is opened far more often than that.
   */
  let driveKnown = { at: 0, ok: false };
  async function driveAllowed() {
    if (Date.now() - driveKnown.at < 60_000) return driveKnown.ok;
    const ok = await api
      .connectors()
      .then(({ connectors }) => !!connectors.find((c) => c.id === 'google')?.products?.some((p) => p.id === 'drive' && p.granted))
      .catch(() => false);
    driveKnown = { at: Date.now(), ok };
    return ok;
  }

  const doNode = $('viewer-do');
  const moreNode = $('viewer-more');

  /** What is open: `{ file, preview }` from the server, plus which tab is showing. */
  let current = null;
  let tab = 'preview';
  let sheetIndex = 0;
  /** Version list for the open file, and which revision is on screen. */
  let history = null;
  let showingRevision = null;
  /** What this machine would open it with — `{ app, launchable }`, or null. */
  let opener = null;
  /** Where the panel is drawn: in the rail, or over the whole window. */
  let expanded = false;
  /** The element the panel sits in when it is not expanded. */
  const home = pane.parentElement;

  /* ── drawing ──────────────────────────────────────────────────── */

  function renderSheets(sheets) {
    if (!sheets.length) return `<p class="viewer__empty">${escapeHtml(t('viewer.noSheets'))}</p>`;
    const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)];
    const columns = Math.max(sheet.columns || 0, 1);

    const head =
      '<tr><th class="grid__corner"></th>' +
      Array.from({ length: columns }, (_, i) => `<th>${columnLabel(i)}</th>`).join('') +
      '</tr>';

    const rows = sheet.rows
      .map((row, r) => {
        const cells = Array.from({ length: columns }, (_, c) => {
          const cell = row[c];
          if (!cell) return '<td></td>';
          const numeric = cell.t === 'n' || cell.t === 'd';
          const title = cell.f ? ` title="=${escapeHtml(cell.f)}"` : '';
          return `<td class="${numeric ? 'is-number' : ''}"${title}>${escapeHtml(cell.v)}</td>`;
        }).join('');
        return `<tr><th class="grid__rownum">${r + 1}</th>${cells}</tr>`;
      })
      .join('');

    return (
      `<div class="grid-wrap"><table class="grid"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` +
      (sheet.truncated
        ? `<p class="viewer__note">${escapeHtml(t('viewer.sheetTruncated'))}</p>`
        : '')
    );
  }

  function renderSlides(slides) {
    if (!slides.length) return `<p class="viewer__empty">${escapeHtml(t('viewer.noSlides'))}</p>`;
    return `<div class="slides">${slides
      .map((slide) => {
        const bullets = (slide.bullets || [])
          .map(
            (bullet) =>
              `<li class="lvl-${Math.min(Number(bullet.level) || 0, 4)}">${escapeHtml(bullet.text)}</li>`,
          )
          .join('');
        const tables = (slide.tables || [])
          .map(
            (table) =>
              `<table class="slide__table">${table.rows
                .map(
                  (row, i) =>
                    `<tr>${row
                      .map((cell) => {
                        const tag = i === 0 ? 'th' : 'td';
                        return `<${tag}>${escapeHtml(cell.runs.map((run) => run.text).join(''))}</${tag}>`;
                      })
                      .join('')}</tr>`,
                )
                .join('')}</table>`,
          )
          .join('');

        return (
          `<article class="slide"><div class="slide__no">${slide.index}</div>` +
          (slide.title ? `<h3>${escapeHtml(slide.title)}</h3>` : '') +
          (bullets ? `<ul>${bullets}</ul>` : '') +
          tables +
          (slide.notes
            ? `<div class="slide__notes"><span>${escapeHtml(t('viewer.notes'))}</span>${escapeHtml(slide.notes).replace(/\n/g, '<br>')}</div>`
            : '') +
          '</article>'
        );
      })
      .join('')}</div>`;
  }

  function renderText(preview) {
    const format = String(preview.format || '').toLowerCase();
    if (format === 'md' || format === 'markdown') {
      return `<div class="doc prose">${renderMarkdown(preview.text)}</div>`;
    }
    if (format === 'csv' || format === 'tsv') {
      const lines = preview.text.split(/\r?\n/).filter((line) => line.length);
      const rows = lines.map((line) => (format === 'csv' ? splitCsvLine(line) : line.split('\t')));
      const width = Math.max(...rows.map((row) => row.length), 1);
      return (
        `<div class="grid-wrap"><table class="grid"><tbody>${rows
          .map(
            (row, r) =>
              `<tr><th class="grid__rownum">${r + 1}</th>` +
              Array.from({ length: width }, (_, c) => `<td>${escapeHtml(row[c] ?? '')}</td>`).join('') +
              '</tr>',
          )
          .join('')}</tbody></table></div>`
      );
    }
    // Everything else is shown as what it is. An .html file is deliberately not
    // rendered: it would be a page from a stranger running inside this session.
    return `<pre class="viewer__code">${escapeHtml(preview.text)}</pre>${
      format === 'html' ? `<p class="viewer__note">${escapeHtml(t('viewer.asSource'))}</p>` : ''
    }`;
  }

  /** A page the assistant wrote, which is the one kind of file that can be run. */
  const runnable = () =>
    current?.file?.origin === 'generated' && /\.html?$/i.test(current.file.name || '');

  /** Only the live copy is editable — an old draft is a record, not a draft. */
  const editable = () =>
    current?.file?.source != null && current.file.origin === 'generated' && showingRevision === null;

  function renderPreview() {
    const { file, preview } = current;

    /**
     * The artifact, running.
     *
     * A frame rather than anything cleverer, pointed at a route that serves it
     * under `sandbox allow-scripts` with no `allow-same-origin` — so the page
     * runs in an opaque origin with no way back to this session. The `sandbox`
     * attribute here says the same thing from this side; either one alone would
     * do, and both is what you want for the one place that executes code.
     */
    if (tab === 'run') {
      return (
        `<iframe class="viewer__frame viewer__run" title="${escapeHtml(file.name)}" ` +
        `data-artifact="${escapeHtml(file.id)}" ` +
        `sandbox="allow-scripts allow-modals" ` +
        `src="/api/attachments/${encodeURIComponent(file.id)}/run?v=${encodeURIComponent(file.version || '')}"></iframe>`
      );
    }

    /**
     * The source, editable.
     *
     * Changing one number in a quotation should not mean asking for it in prose
     * and waiting a turn. Saving rebuilds the file the same way `update_file`
     * does, so a document edited here and one edited by the assistant are the
     * same operation — including filing the outgoing copy as a version.
     */
    if (tab === 'source') {
      return (
        '<div class="editor">' +
        `<textarea class="editor__box" id="viewer-editor" spellcheck="false"${editable() ? '' : ' readonly'}>${escapeHtml(
          file.source || '',
        )}</textarea>` +
        '<div class="editor__bar">' +
        `<span class="editor__hint" id="viewer-editor-hint">${
          editable()
            ? t('viewer.markdownNote')
            : t('viewer.versionNote')
        }</span>` +
        (editable()
          ? `<button class="btn btn--primary editor__save" id="viewer-save" type="button">${escapeHtml(t('action.save'))}</button>`
          : '') +
        '</div></div>'
      );
    }
    if (tab === 'text') {
      return preview.text
        ? `<pre class="viewer__code">${escapeHtml(preview.text)}</pre>`
        : `<p class="viewer__empty">${escapeHtml(t('viewer.noText'))}</p>`;
    }

    switch (preview.kind) {
      case 'document':
        /**
         * The one branch here that does not escape, because it cannot: this is
         * already markup, converted from a .docx by server/office/blocks.js.
         *
         * That makes it the only place in this file relying on an invariant
         * held somewhere else — and the document may have arrived from a
         * stranger. The escaping over there is correct: `runsToHtml` escapes
         * every run, links are restricted to http, https, mailto and #, and
         * `img src` and `alt` are escaped too.
         *
         * It is now also *tested* over there — office.test.mjs feeds a hostile
         * document through `blocksToHtml` and asserts no script tag, no event
         * handler on any rendered tag, no javascript: href, and no tag broken
         * open by a quote in the data. Before that, this line depended on a
         * promise nothing checked, which is the kind of coupling a refactor
         * breaks silently.
         */
        return `<div class="doc">${preview.html}</div>`;
      case 'sheets':
        return renderSheets(preview.sheets || []);
      case 'slides':
        return renderSlides(preview.slides || []);
      case 'pdf':
        // `title` rather than a label: the frame is the document, and a screen
        // reader announcing "iframe" and nothing else is no use.
        return `<iframe class="viewer__frame" src="${bytesUrl()}" title="${escapeHtml(file.name)}"></iframe>`;
      case 'image':
        return `<div class="viewer__image"><img src="${bytesUrl()}" alt="${escapeHtml(file.name)}" /></div>`;
      case 'text':
        return renderText(preview);
      case 'unreadable':
        return (
          `<p class="viewer__empty">${escapeHtml(preview.message || t('viewer.unreadable'))}</p>` +
          `<p class="viewer__note">${escapeHtml(t('viewer.intact'))}</p>`
        );
      default:
        return `<p class="viewer__empty">${escapeHtml(t('viewer.noPreview'))}</p>`;
    }
  }

  /**
   * Where the bytes come from.
   *
   * An old revision has no route of its own that serves raw bytes — only the
   * live file does — so a PDF or a picture from the history frames the current
   * file and says which one it is. Showing the live bytes under an old version
   * number silently would be the worst of the three options.
   */
  const bytesUrl = () =>
    `/api/attachments/${encodeURIComponent(current.file.id)}?v=${encodeURIComponent(current.file.version || '')}`;

  function renderTabs() {
    const { file, preview } = current;
    const tabs = [];

    // A running page leads, because that is what somebody asked for when they
    // asked for a page. Its source is one press away.
    if (runnable()) tabs.push(['run', eyeMark, t('viewer.tab.preview')]);
    // A running page has no second rendering worth showing: the page is the
    // preview and the source is the Code tab.
    else tabs.push(['preview', eyeMark, labelFor(preview.kind)]);
    // A PDF that has text worth reading, for a browser that will not frame one.
    if (preview.kind === 'pdf' && preview.text) tabs.push(['text', textMark, t('viewer.tab.text')]);
    if (file.source != null && file.origin === 'generated') {
      tabs.push(['source', codeMark, runnable() ? t('viewer.tab.code') : t('viewer.tab.source')]);
    }

    tabsNode.hidden = tabs.length < 2;
    tabsNode.innerHTML = tabs
      .map(
        ([name, mark, label]) =>
          `<button class="fmode${tab === name ? ' is-active' : ''}" type="button" role="tab" ` +
          `aria-selected="${tab === name}" data-tab="${name}" title="${escapeHtml(label)}" ` +
          `aria-label="${escapeHtml(label)}">${mark}</button>`,
      )
      .join('');
  }

  const labelFor = (kind) =>
    kind === 'sheets'
      ? t('viewer.kind.sheets')
      : kind === 'slides'
        ? t('viewer.kind.slides')
        : kind === 'pdf'
          ? t('viewer.kind.pages')
          : t('viewer.kind.document');

  function renderSheetTabs() {
    const strip = $('viewer-sheets');
    const sheets = current?.preview?.kind === 'sheets' ? current.preview.sheets || [] : [];
    strip.hidden = sheets.length < 2 || tab !== 'preview';
    if (strip.hidden) return;

    strip.innerHTML = sheets
      .map(
        (sheet, i) =>
          `<button class="sheet-tab${i === sheetIndex ? ' is-active' : ''}" type="button" data-sheet="${i}">${escapeHtml(
            sheet.name,
          )}</button>`,
      )
      .join('');
  }

  /**
   * The version strip.
   *
   * Hidden until there is more than one, because a switcher reading "v1" is
   * furniture. The live copy is marked so that "current" and "the newest
   * revision" are never confused — they are the same thing, and the strip
   * should say so rather than leaving it to be worked out.
   */
  function renderVersions() {
    const versions = history?.versions || [];
    versionsNode.hidden = versions.length < 2;
    if (versionsNode.hidden) return;

    const live = history.current;
    const on = showingRevision ?? live;
    versionsNode.innerHTML =
      `<span class="filepane__vlabel">${escapeHtml(t('viewer.versions'))}</span>` +
      versions
        .map(
          (v) =>
            `<button class="vchip${v.revision === on ? ' is-active' : ''}" type="button" ` +
            `data-revision="${v.revision}" title="${escapeHtml(
              `${humanSize(v.bytes)}${v.createdAt ? ` · ${ago(v.createdAt)}` : ''}`,
            )}">v${v.revision}${v.live ? '' : ''}</button>`,
        )
        .join('') +
      (showingRevision !== null
        ? `<button class="vchip vchip--restore" id="viewer-restore" type="button">${escapeHtml(t('viewer.restore'))}</button>`
        : '');
  }

  function draw() {
    const { file, preview } = current;
    titleNode.textContent = file.name;
    kindNode.textContent = [
      (file.name.split('.').pop() || '').toUpperCase(),
      showingRevision !== null ? `v${showingRevision}` : null,
      humanSize(file.bytes),
      preview.kind === 'sheets' ? `${(preview.sheets || []).length} sheets` : null,
      preview.kind === 'slides' ? `${(preview.slides || []).length} slides` : null,
      preview.kind === 'pdf' && preview.pages ? `${preview.pages} pages` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    renderAction();
    renderTabs();
    renderVersions();
    bodyNode.innerHTML = renderPreview();
    renderSheetTabs();
    bodyNode.scrollTop = 0;
  }

  /* ── what the one button does ─────────────────────────────────── */

  /**
   * The action worth its own button, and everything else behind an arrow.
   *
   * What that is depends on the file and on whether a computer is connected.
   * A spreadsheet with Excel on the other end should say "Open in Excel"; the
   * same spreadsheet with no worker running has nothing to open it *with*, and
   * saying so would be a button that fails. Then it is Download.
   */
  function primary() {
    if (opener?.launchable && opener.app) {
      return {
        id: 'openIn',
        label: t('viewer.openIn').replace('{app}', opener.app),
        run: () => openOnMachine('open'),
      };
    }
    if (opener?.launchable) return { id: 'open', label: t('viewer.open'), run: () => openOnMachine('open') };
    if (tab === 'source' || current?.preview?.kind === 'text') {
      return { id: 'copy', label: t('viewer.copy'), run: copyRich };
    }
    return { id: 'download', label: t('viewer.download'), run: download };
  }

  function renderAction() {
    doNode.textContent = primary().label;
  }

  const download = () => {
    // A real anchor click rather than `location =`: it keeps the filename, the
    // browser's own progress row, and does not navigate the app away on a
    // failure.
    const link = document.createElement('a');
    link.href = `/api/attachments/${encodeURIComponent(current.file.id)}?download=1${
      current.file.version ? `&v=${current.file.version}` : ''
    }`;
    link.download = current.file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  /* ── copying, with the formatting ──────────────────────────────
   *
   * The clipboard holds several renderings of the same thing at once, and the
   * application you paste into picks. Word takes `text/html`; a code editor
   * takes `text/plain`. Writing only plain text — which is what this did — meant
   * a report pasted into Word arrived as one grey wall with every heading, bold
   * run and table flattened out of it.
   *
   * So both flavours go on, built from the same preview that is on screen.
   */

  /** What to put on the clipboard for whatever is open: `{ html, text }`. */
  function copyPayload() {
    const { file, preview } = current;

    // The Code tab is source. Source pasted into Word wants to stay source, so
    // its rich flavour is a monospace block rather than a rendering of it.
    if (tab === 'source' || tab === 'text') {
      const text = tab === 'source' ? file.source || '' : preview.text || '';
      return { text, html: text ? `<pre style="${MONO}">${escapeHtml(text)}</pre>` : '' };
    }

    switch (preview.kind) {
      case 'document':
        return { html: preview.html || '', text: preview.text || '' };

      case 'sheets': {
        // The sheet on screen, as a real table — so it lands in Word as a
        // table and in Excel as cells, not as one line of comma-separated text.
        const sheets = preview.sheets || [];
        const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)];
        if (!sheet) return { html: '', text: preview.text || '' };
        const width = Math.max(sheet.columns || 0, 1);
        const rows = sheet.rows.map((row) =>
          Array.from({ length: width }, (_, c) => row[c]?.v ?? ''),
        );
        return {
          html:
            `<table style="${TABLE}">` +
            rows
              .map(
                (row, r) =>
                  `<tr>${row
                    .map(
                      (cell) =>
                        `<${r === 0 ? 'th' : 'td'} style="${CELL}${r === 0 ? HEAD : ''}">${escapeHtml(
                          cell,
                        )}</${r === 0 ? 'th' : 'td'}>`,
                    )
                    .join('')}</tr>`,
              )
              .join('') +
            '</table>',
          text: rows.map((row) => row.join('\t')).join('\n'),
        };
      }

      case 'slides': {
        const slides = preview.slides || [];
        return {
          html: slides
            .map(
              (slide) =>
                (slide.title ? `<h2>${escapeHtml(slide.title)}</h2>` : '') +
                ((slide.bullets || []).length
                  ? `<ul>${slide.bullets.map((b) => `<li>${escapeHtml(b.text)}</li>`).join('')}</ul>`
                  : ''),
            )
            .join(''),
          text: preview.text || '',
        };
      }

      case 'text': {
        const format = String(preview.format || '').toLowerCase();
        const text = preview.text || '';
        // Markdown was written to be read as a document; everything else was
        // written to be read as itself.
        return format === 'md' || format === 'markdown'
          ? { html: renderMarkdown(text), text }
          : { text, html: text ? `<pre style="${MONO}">${escapeHtml(text)}</pre>` : '' };
      }

      default:
        return { html: '', text: preview.text || file.source || '' };
    }
  }

  async function copyRich() {
    // A picture has no text in it. Copying the image itself is what somebody
    // pressing Copy on a photograph meant.
    if (current.preview.kind === 'image') return copyImage();

    const { html, text } = copyPayload();
    if (!text && !html) return toast(t('viewer.nothingToCopy'), 'error');

    const wrote = await writeRich({ html, text });
    if (wrote === 'rich') toast(t('viewer.copiedRich'), 'ok');
    else if (wrote === 'plain') toast(t('viewer.copied'), 'ok');
    else toast(t('viewer.copyRefused'), 'error');
  }

  async function copyImage() {
    try {
      const blob = await (await fetch(bytesUrl())).blob();
      // Only PNG is universally accepted by `ClipboardItem`; anything else is
      // repainted through a canvas rather than refused.
      const png = blob.type === 'image/png' ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toast(t('viewer.pictureCopied'));
    } catch {
      toast(t('viewer.pictureCopyRefused'), 'error');
    }
  }

  function toPng(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('no blob'))), 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('unreadable'));
      };
      img.src = url;
    });
  }

  async function openOnMachine(how) {
    doNode.disabled = true;
    try {
      const { path, app } = await api.openFileOnMachine(current.file.id, how);
      toast(
        how === 'folder'
          ? t('viewer.showingIn', { where: path.replace(/[\\/][^\\/]+$/, '') })
          : t('viewer.openedIn', { app: app || t('viewer.defaultApp') }),
      );
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      doNode.disabled = false;
    }
  }

  /**
   * Print, which is also how somebody gets a PDF.
   *
   * The print stylesheet hides every child of `<body>` except this panel — so
   * the panel has to *be* a child of `<body>`, which is exactly what expanding
   * it does. Printing from inside the rail would otherwise put the whole app
   * on the page, or nothing at all.
   *
   * The class is what the rest of the print rules key off. It is removed on the
   * way back whether the print went ahead or was cancelled — `afterprint` fires
   * for both, and a browser that does not send it would leave the app looking
   * printed forever.
   */
  /**
   * @param {{ pdf?: boolean }} [options]  `pdf`: the person wants a file, not
   *   paper. A page cannot choose the dialog's destination for them, so it
   *   says which one to pick — and names the document, because the browser
   *   uses the page title as the PDF's file name ("Synapsez.pdf" otherwise).
   */
  function printIt({ pdf = false } = {}) {
    const name = String(current?.file?.name || '').replace(/\.[^.]+$/, '') || 'document';
    if (pdf) toast(t('viewer.savePdfHint'));
    /*
     * A clean copy of the document, printed from a frame of its own.
     *
     * Printing the live app meant every rule of the app — the theme, the
     * fixed layout, the glass, whatever sat over the page — had to be undone
     * for paper, and one that was not produced a 37-page preview with nothing
     * on it. Here the frame holds only the document, styled for paper and
     * nothing else, so there is nothing to undo. Its title is the file's
     * name, which is what the browser names the PDF.
     */
    const content = bodyNode.querySelector('.doc, .grid-wrap, .slides, .viewer__code') || bodyNode;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc =
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>` +
      `<base href="${escapeHtml(window.location.origin)}/"><style>${PRINT_CSS}</style></head>` +
      `<body>${content.outerHTML}</body></html>`;
    const done = () => setTimeout(() => frame.remove(), 1000);
    frame.addEventListener('load', async () => {
      const win = frame.contentWindow;
      if (!win) return done();
      // Pictures in the document finish loading before the page is laid out.
      const settled = (img) =>
        img.complete
          ? null
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            });
      await Promise.all([...win.document.images].map(settled));
      win.addEventListener('afterprint', done, { once: true });
      win.focus();
      win.print();
      setTimeout(done, 120_000);
    }, { once: true });
    document.body.append(frame);
  }

  /* ── events ───────────────────────────────────────────────────── */

  // Once, not per draw: this is a delegated listener on the body, and wiring it
  // again on every render would copy the same block four times.
  wireCopyButtons(bodyNode);

  doNode.addEventListener('click', () => current && primary().run());

  moreNode.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!current) return;
    const driveReady = await driveAllowed();
    if (!current) return;

    const items = [];
    /**
     * Into the person's own Google Drive — first, because it is the one place
     * here a file can go that is not this browser. Only offered once Drive has
     * been allowed; the answer opens the copy in a new tab.
     */
    if (driveReady) {
      items.push({
        label: t('viewer.saveToDrive'),
        icon: DRIVE_ICON,
        run: async () => {
          const pending = window.open('', '_blank');
          try {
            toast(t('viewer.savingToDrive'));
            const { link } = await api.saveToDrive(current.file.id);
            if (pending) pending.location.href = link;
            toast(t('viewer.savedToDrive'), 'ok');
          } catch (err) {
            pending?.close();
            toast(err.message, 'error');
          }
        },
      });
    }
    // A browser can show a PDF, a picture or a page itself: open it in a tab,
    // which is "download and open" for somebody with no computer paired.
    if (!opener && /^(image\/|application\/pdf|text\/html)/.test(current.file.mime || '')) {
      items.push({
        label: t('viewer.openInTab'),
        icon: '↗',
        run: () => window.open(`/api/attachments/${encodeURIComponent(current.file.id)}`, '_blank', 'noopener'),
      });
    }
    // Whatever the button is not already doing.
    // By id, not by label — see `primary()`.
    const first = primary().id;
    if (opener?.launchable && first !== 'open' && first !== 'openIn') {
      items.push({
        label: opener.app
          ? t('viewer.openIn').replace('{app}', opener.app)
          : t('viewer.openInDefault'),
        icon: '↗',
        run: () => openOnMachine('open'),
      });
    }
    if (opener) items.push({ label: t('viewer.showInFolder'), icon: '🗀', run: () => openOnMachine('folder') });
    if (first !== 'download') items.push({ label: t('viewer.download'), icon: '⤓', run: download });
    if (first !== 'copy') {
      items.push({
        // Named for what it carries: the formatting is the point, and 'Copy
        // text' promised the opposite of what it now does.
        label: current.preview.kind === 'image' ? t('viewer.copyPicture') : t('viewer.copyFormatted'),
        icon: '⧉',
        run: copyRich,
      });
    }
    // Nothing worth printing in a frame we do not control, or in a picture.
    // Two entries for two intentions: a PDF to keep, and paper. Both go through
    // the browser's print dialog — with "Save as PDF" already chosen for the
    // first, which is the only way a page can ask for it.
    if (current.preview.kind !== 'pdf' && current.preview.kind !== 'image') {
      items.push({ label: t('viewer.savePdf'), icon: '⤓', run: () => printIt({ pdf: true }) });
      items.push({ label: t('viewer.print'), icon: '⎙', run: () => printIt() });
    }
    /*
     * A link anyone can open, copied — the share link the file card offers,
     * one press from the viewer. This slot used to say "No computer paired",
     * left over from when files could be opened on a paired machine.
     *
     * Named for what it does (SEC-046): it makes the file public. "Copy link"
     * read like a private address for oneself, and the warning only arrived in
     * the toast after the file was already out. Offered only for what the
     * assistant made — an upload cannot be shared, and the server says so.
     */
    if (current.file?.origin === 'generated') items.push(null, {
      label: t('viewer.copyPublicLink'),
      icon: LINK_ICON,
      run: async () => {
        try {
          const { path } = await api.shareFile(current.file.id);
          const link = new URL(path, window.location.origin).href;
          await navigator.clipboard.writeText(link);
          toast(t('viewer.linkCopied'), 'ok');
        } catch (err) {
          toast(err?.message || t('clipboard.failed'), 'error');
        }
      },
    });
    openMenu(moreNode, items);
  });

  tabsNode.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button || !current) return;
    tab = button.dataset.tab;
    draw();
  });

  versionsNode.addEventListener('click', async (event) => {
    const restore = event.target.closest('#viewer-restore');
    if (restore && current) {
      restore.disabled = true;
      try {
        await api.restoreFileVersion(current.file.id, showingRevision);
        toast(t('viewer.nowCurrent', { revision: showingRevision }));
        await load(current.file.id, { keepTab: true });
        onChange?.();
      } catch (err) {
        toast(err.message, 'error');
        restore.disabled = false;
      }
      return;
    }

    const chip = event.target.closest('[data-revision]');
    if (!chip || !current) return;
    const revision = Number(chip.dataset.revision);
    showingRevision = revision === history.current ? null : revision;
    await showRevision();
  });

  async function showRevision() {
    const id = current.file.id;
    bodyNode.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('viewer.reading'))}</div>`;
    try {
      current =
        showingRevision === null ? await api.filePreview(id) : await api.fileVersion(id, showingRevision);
      if (tab === 'run' && !runnable()) tab = 'preview';
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /**
   * Saving an edit.
   *
   * Delegated from the body because the editor is rebuilt on every draw, and a
   * listener bound to a textarea that no longer exists is a Save button that
   * quietly does nothing.
   */
  bodyNode.addEventListener('click', async (event) => {
    if (!event.target.closest('#viewer-save') || !current) return;

    const box = document.getElementById('viewer-editor');
    const button = event.target.closest('#viewer-save');
    button.disabled = true;
    button.textContent = t('viewer.saving');

    try {
      const { file } = await api.updateFile(current.file.id, box.value);
      toast(`${file.name} saved.`);
      // Reopened rather than patched: the preview is a rendering of the file,
      // and the file has just changed.
      await load(current.file.id, { keepTab: true });
      onChange?.();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = t('action.save');
    }
  });

  $('viewer-sheets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sheet]');
    if (!button || !current) return;
    sheetIndex = Number(button.dataset.sheet);
    draw();
  });

  /* ── the rail, and the whole window ───────────────────────────── */

  /**
   * Full size.
   *
   * The panel is moved to `<body>` rather than merely made bigger. `.detail` is
   * a stacking context — it has a `transform` for the slide-in — and a `fixed`
   * child of one is positioned against *it*, not the viewport, so an expanded
   * panel drew underneath the sidebar. Moving the element out is the only fix
   * that does not involve unpicking the animation. It goes back on the way in.
   */
  function expand(on) {
    expanded = on;
    pane.classList.toggle('is-full', on);
    if (on) document.body.appendChild(pane);
    else home.appendChild(pane);
    $('viewer-expand').textContent = on ? '⤡' : '⤢';
    $('viewer-expand').title = on ? t('viewer.backToPanel') : t('viewer.fullSize');
  }

  $('viewer-expand').addEventListener('click', () => expand(!expanded));
  $('viewer-close').addEventListener('click', () => close());

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || pane.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    event.stopPropagation();
    if (expanded) expand(false);
    else close();
  });

  function close() {
    if (expanded) expand(false);
    pane.hidden = true;
    // The frame keeps a PDF plugin alive and a big preview keeps its DOM; both
    // go when the panel does.
    bodyNode.innerHTML = '';
    current = null;
    history = null;
    opener = null;
    showingRevision = null;
    onClose?.();
  }

  /* ── loading ──────────────────────────────────────────────────── */

  async function load(id, { keepTab = false } = {}) {
    if (!keepTab) tab = 'preview';
    sheetIndex = 0;
    showingRevision = null;

    current = await api.filePreview(id);
    if (!keepTab && runnable()) tab = 'run';
    if (tab === 'run' && !runnable()) tab = 'preview';
    draw();

    /**
     * Two follow-ups that must not hold the document up.
     *
     * The version list and "which app would open this" both need a round trip —
     * the second all the way to the worker — and neither changes what is on
     * screen. Awaiting them before the first paint would make every file open
     * at the speed of the slowest of the three.
     */
    history = null;
    opener = null;
    const openedAs = current.file.id;

    api
      .fileVersions(id)
      .then((result) => {
        if (current?.file?.id !== openedAs) return;
        history = result;
        renderVersions();
      })
      .catch(() => {});

    api
      .fileOpener(id)
      .then((result) => {
        if (current?.file?.id !== openedAs) return;
        opener = result;
        renderAction();
      })
      // No worker, or the machine is asleep. The button stays Download, which
      // is the honest answer rather than an Open that cannot work.
      .catch(() => {});
  }

  const eyeMark =
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M1.8 10S4.6 5 10 5s8.2 5 8.2 5-2.8 5-8.2 5-8.2-5-8.2-5z"/><circle cx="10" cy="10" r="2.4"/></svg>';
  const codeMark =
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6-4 4 4 4M13 6l4 4-4 4"/></svg>';
  const textMark =
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 5h12M4 9h12M4 13h8"/></svg>';

  return {
    /**
     * Open a file by id, in the rail.
     *
     * @param file `{ id, name }` — the name is only used for the loading state,
     *   because everything else comes back from the server.
     */
    async open(file) {
      const id = typeof file === 'string' ? file : file?.id;
      if (!id) return;

      titleNode.textContent = (typeof file === 'object' && file.name) || t('viewer.opening');
      kindNode.textContent = '';
      tabsNode.hidden = true;
      versionsNode.hidden = true;
      $('viewer-sheets').hidden = true;
      bodyNode.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('viewer.readingDoc'))}</div>`;
      pane.hidden = false;
      onOpen?.();

      try {
        await load(id);
      } catch (err) {
        close();
        toast(err.message || t('viewer.couldNotOpen'), 'error');
      }
    },

    /**
     * Re-read the file on screen, keeping the tab you were on.
     *
     * For when the assistant rewrites the document you are looking at. Showing
     * yesterday's rendering of a file that has just changed is the one thing
     * this panel exists to prevent, and re-opening it from scratch would throw
     * away the tab and the scroll position for no reason.
     */
    async reopen() {
      if (pane.hidden || !current) return;
      try {
        await load(current.file.id, { keepTab: true });
      } catch {
        // It was deleted, or the account no longer has it. The panel keeps what
        // it has rather than blanking; the next thing the user does will say so.
      }
    },

    close,
    /** The id on screen, or null — so a rewrite can refresh what is open. */
    showing: () => (pane.hidden ? null : current?.file?.id ?? null),
  };
}
