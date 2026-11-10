import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml, wireCopyButtons } from './markdown.js';
import { mountPreview } from './viewer.js';

/**
 * The files one message brought, in a window of their own (owner, 2026-11-09,
 * after Claude's "Uploaded files", screenshots 8 and 9).
 *
 * Opened from "Used in this session" in the side panel (rail.js): that message's
 * files down the left, each with what kind it is; the chosen one on the right with
 * its name, a download, and the viewer's own drawing of it (`mountPreview` in
 * viewer.js) — a picture centred, a workbook with its formula bar and sheets, a PDF
 * in the browser's reader. Nothing here draws a file a second way.
 *
 * Keyboard: the list is a listbox, ↑ ↓ Home End move through it and the preview
 * follows; Tab stays inside the window; Esc and the ✕ close it and put focus back
 * on the row that opened it.
 */

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** One mark per kind, drawn like the rest of the app's line icons. */
const ICON = {
  image: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9.5" r="1.7"/><path d="m20.5 15.5-4.8-4.8-9.2 9.8"/>'),
  sheet: svg('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M3.5 14.5h17M9.5 4v16"/>'),
  slides: svg('<rect x="3.5" y="5" width="17" height="11.5" rx="1.8"/><path d="M12 16.5V20M8.5 20h7"/>'),
  pdf: svg('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M14 3.5v5h5"/><path d="M8.5 16.5h7"/>'),
  media: svg('<circle cx="12" cy="12" r="8.5"/><path d="m10.2 8.8 5 3.2-5 3.2Z"/>'),
  doc: svg('<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M14 3.5v5h5M8.5 12.5h7M8.5 16h7"/>'),
};

const extension = (name) => {
  const match = /\.([a-z0-9]{1,6})$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : '';
};

/**
 * The type, in capitals, as the badge beside a name says it: PNG, XLSX. From the
 * name, else from the mime type, else nothing.
 *
 * @param {{ name?: string, mime?: string }} file
 */
function fileBadge(file) {
  const ext = extension(file?.name);
  if (ext) return ext.toUpperCase();
  const sub = /^[a-z]+\/([a-z0-9.+-]+)$/i.exec(String(file?.mime || ''))?.[1] || '';
  return sub && sub.length <= 5 ? sub.toUpperCase() : '';
}

/** The name without the extension the badge already says. */
function baseName(name) {
  const text = String(name || '');
  return extension(text) && text.lastIndexOf('.') > 0 ? text.slice(0, text.lastIndexOf('.')) : text;
}

/**
 * Which mark a file gets.
 * @param {{ name?: string, mime?: string, kind?: string }} file
 * @returns {'image' | 'sheet' | 'slides' | 'pdf' | 'media' | 'doc'}
 */
function fileKind(file) {
  const ext = extension(file?.name);
  const mime = String(file?.mime || '');
  if (/^image\//i.test(mime) || /^(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/.test(ext)) return 'image';
  if (/^(xlsx|xlsm|xls|csv|tsv|ods)$/.test(ext) || /spreadsheet|ms-excel|text\/csv/i.test(mime)) return 'sheet';
  if (/^(pptx|ppt|odp|key)$/.test(ext) || /presentation|powerpoint/i.test(mime)) return 'slides';
  if (ext === 'pdf' || /pdf/i.test(mime)) return 'pdf';
  if (/^(audio|video)\//i.test(mime) || /^(mp3|wav|m4a|ogg|flac|mp4|mov|webm|mkv)$/.test(ext)) return 'media';
  return 'doc';
}

/** What can take focus inside the window, in order, for keeping Tab in it. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

export function createUploadsView() {
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const dialog = /** @type {HTMLDialogElement} */ ($('uploads'));
  const listNode = $('uploads-list');
  const nameNode = $('uploads-name');
  const typeNode = $('uploads-type');
  const download = /** @type {HTMLAnchorElement} */ ($('uploads-download'));
  const body = $('uploads-body');

  /** @type {{ id: string, name?: string, mime?: string, kind?: string }[]} */
  let files = [];
  /** The selected row, which the arrow keys move from. */
  let chosen = -1;
  /** The file drawn or being read on the right; -1 after a failure, so choosing it again retries. */
  let drawn = -1;
  /** @type {{ destroy: () => void } | null} */
  let shown = null;
  /** Only the newest choice may draw: a slow preview must not land over a later one. */
  let asked = 0;
  /** What the server said about each file, while the window is open. Going back costs nothing. */
  const read = new Map();
  /** @type {(() => HTMLElement | null) | null} */
  let giveBack = null;

  // A Markdown file's code blocks carry copy buttons; one delegated listener for all of them.
  wireCopyButtons(body);

  const options = () => /** @type {HTMLElement[]} */ ([...listNode.querySelectorAll('[role="option"]')]);

  function optionHtml(file, i) {
    return (
      `<div class="upv__item" role="option" id="upv-opt-${i}" data-index="${i}" aria-selected="false" tabindex="-1">` +
      `<span class="upv__icon" aria-hidden="true">${ICON[fileKind(file)]}</span>` +
      `<span class="upv__fname">${escapeHtml(baseName(file.name))}</span>` +
      `<span class="upv__badge">${escapeHtml(fileBadge(file))}</span>` +
      '</div>'
    );
  }

  /**
   * Show one file: mark it chosen, name it, point the download at it and draw it.
   * @param {number} index
   * @param {{ focus?: boolean }} [options]
   */
  async function choose(index, { focus = false } = {}) {
    if (index < 0 || index >= files.length) return;
    chosen = index;
    const all = options();
    all.forEach((node, i) => {
      const on = i === index;
      node.classList.toggle('is-chosen', on);
      node.setAttribute('aria-selected', String(on));
      // One stop in the Tab order for the whole list; the arrows do the rest.
      node.tabIndex = on ? 0 : -1;
    });
    if (focus) all[index]?.focus();
    all[index]?.scrollIntoView?.({ block: 'nearest' });
    if (index === drawn) return;
    drawn = index;

    const file = files[index];
    nameNode.textContent = baseName(file.name);
    nameNode.title = String(file.name || '');
    typeNode.textContent = fileBadge(file);
    download.href = `/api/attachments/${encodeURIComponent(file.id)}?download=1`;
    download.setAttribute('download', String(file.name || ''));

    shown?.destroy();
    shown = null;
    delete body.dataset.kind;
    body.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('viewer.readingDoc'))}</div>`;
    const mine = ++asked;
    try {
      let current = read.get(file.id);
      if (!current) {
        current = await api.filePreview(file.id);
        read.set(file.id, current);
      }
      if (mine !== asked || !dialog.open) return;
      body.innerHTML = '';
      body.dataset.kind = String(current.preview?.kind || '');
      shown = mountPreview(body, current);
    } catch (err) {
      if (mine !== asked || !dialog.open) return;
      drawn = -1;
      body.innerHTML = `<p class="viewer__empty">${escapeHtml(err?.message || t('viewer.couldNotOpen'))}</p>`;
    }
  }

  listNode.addEventListener('click', (event) => {
    const node = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('[role="option"]'));
    if (node) void choose(Number(node.dataset.index), { focus: true });
  });

  listNode.addEventListener('keydown', (event) => {
    const last = files.length - 1;
    const at = Math.max(0, chosen);
    const to =
      event.key === 'ArrowDown' ? Math.min(last, at + 1)
      : event.key === 'ArrowUp' ? Math.max(0, at - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (to === null) return;
    event.preventDefault();
    void choose(to, { focus: true });
  });

  // Tab and Shift+Tab go round inside the window, never out to the page behind it.
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return;
    const stops = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll(FOCUSABLE)]).filter(
      (node) => node.getClientRects().length > 0 && !node.closest('[hidden]'),
    );
    if (!stops.length) return;
    const first = stops[0];
    const end = stops[stops.length - 1];
    const here = document.activeElement;
    if (event.shiftKey && (here === first || !dialog.contains(here))) {
      event.preventDefault();
      end.focus();
    } else if (!event.shiftKey && (here === end || !dialog.contains(here))) {
      event.preventDefault();
      first.focus();
    }
  });

  $('uploads-close').addEventListener('click', () => dialog.close());
  // A press on the dimmed page around the window closes it, as Esc does.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.addEventListener('close', () => {
    asked += 1;
    shown?.destroy();
    shown = null;
    body.innerHTML = '';
    delete body.dataset.kind;
    read.clear();
    files = [];
    chosen = -1;
    drawn = -1;
    // The row that opened it — found again, since the panel may have redrawn meanwhile.
    const back = giveBack?.();
    giveBack = null;
    if (back?.isConnected) back.focus();
  });

  return {
    /**
     * @param {{ id: string, name?: string, mime?: string, kind?: string }[]} list  one message's files
     * @param {() => HTMLElement | null} [returnTo]  where focus goes back to on close
     */
    open(list, returnTo) {
      files = (Array.isArray(list) ? list : []).filter((file) => file?.id);
      if (!files.length) return;
      giveBack = returnTo || null;
      chosen = -1;
      drawn = -1;
      listNode.innerHTML = files.map(optionHtml).join('');
      if (!dialog.open) dialog.showModal();
      void choose(0, { focus: true });
    },
    close: () => {
      if (dialog.open) dialog.close();
    },
    isOpen: () => dialog.open,
  };
}
