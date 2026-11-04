/**
 * Photos and files attached to the message being written.
 *
 * Lifted out of `app.js` whole. It owns three things that belong together and
 * nothing else in the app needs to see: the staging list, the uploads that fill
 * it, and the two facts about the chosen model — can it read a picture, is it
 * free — that decide whether a warning appears above the composer.
 *
 * It is a factory rather than a module of loose functions because the staging
 * list is mutable state with a lifetime, and handing it out through a closure is
 * the difference between one owner and every caller reaching in.
 */

import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { announce, toast } from './render.js';
import { t, currentLanguage } from './i18n.js';
import { humanSize } from './format.js';
import { MODEL_READS_CHARS, isLongPaste, pastedExcerpt, pastedFacts, pastedName, showPasted, tidyPaste } from './pasted.js';
import { preparedWithThumb, shrinkable, MAX_SHRINKABLE_BYTES } from './shrink.js';
import { thumbnailFor } from './thumbnail.js';
import { openSketch } from './sketch.js';
import { newestOnly } from './serial.js';

const $ = (id) => document.getElementById(id);

const isImage = (type) => /^image\//i.test(type || '');

/**
 * @param {object} deps
 * @param {any} deps.state                    the app's shared state object
 * @param {() => void} deps.refreshSendState  re-enable or grey out the send button
 * @param {() => void} deps.renderTopbar      the free badge lives up there
 * @param {{ refresh: () => void }} deps.onboarding
 * @param {(model: string) => void} deps.openModelBrowser
 */
export function createAttachments({ state, refreshSendState, renderTopbar, onboarding, openModelBrowser }) {
  /**
   * What is attached to the message being written.
   *
   * Uploaded as soon as they are picked, so pressing send is instant and a slow
   * upload happens while you are still typing the question. Each entry keeps a
   * local object URL for its thumbnail — the browser already has the file, and
   * fetching the same megabytes back from the server to draw a 44px square would
   * be absurd.
   */
  const staged = [];

  /**
   * Whether the chosen model can be shown a picture.
   *
   * Asked of the server because only it knows the catalogue, and cached because
   * the answer changes only when the model does. `true` until told otherwise: the
   * warning must never be the thing that appears wrongly.
   */
  let modelSeesImages = true;

  /**
   * Whether the chosen model is a free one.
   *
   * Answered by the same request as the vision question, because both are facts
   * about the model that only the server knows and asking twice would be two round
   * trips for one answer.
   */
  let modelIsFree = false;

  /**
   * What was done to a file on the way out, in one line.
   *
   * Shown because it changes what the assistant is looking at: a PDF sent as
   * text has no layout and no pictures, and somebody asking "what does the
   * chart on page 4 show" deserves to know that before they ask.
   */
  function describeShrink(note) {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (note.kind === 'pdf-text') {
      return t('upload.sentAsText').replace('{pages}', String(note.pages)).replace('{size}', mb(note.from));
    }
    if (note.kind === 'office') {
      return t('upload.withoutPictures').replace('{from}', mb(note.from)).replace('{to}', mb(note.to));
    }
    return t('upload.resized').replace('{from}', mb(note.from)).replace('{to}', mb(note.to));
  }

  /** The type a file is, as its extension says it: "DOCX", "PDF". */
  const typeOf = (name) => (String(name).includes('.') ? String(name).split('.').pop().slice(0, 5).toUpperCase() : 'FILE');

  /**
   * What is waiting to go, as tiles above the composer.
   *
   * A picture is the picture — its name and size told nobody anything the
   * picture did not — and pressing it opens it to draw or write on. A PDF shows
   * its first page. Anything else is its name and its type. The state that
   * matters is still said: uploading as a spinner, a failure in words, and what
   * was changed on the way out (a PDF sent as its text) in the tile's title.
   *
   * One tray for both places a message is written — the conversation's
   * composer and a project's box — so files picked on a project's page go
   * with the conversation started from it (see `startChat` in app.js). It is
   * drawn where it is being looked at, and the other copy is emptied: two
   * sets of the same buttons, one of them out of sight, is one too many.
   */
  function renderStaged() {
    const onProject = $('project-page')?.hidden === false;
    const composer = $('attachments');
    const project = $('project-page-attachments');
    if (composer) renderTray(composer, onProject ? [] : staged);
    if (project) renderTray(project, onProject ? staged : []);
  }

  function renderTray(host, files) {
    host.hidden = files.length === 0;
    const movable = files.length > 1;
    armReorder(host);

    host.innerHTML = files
      .map((file, i) => {
        const type = typeOf(file.name);
        const state = `${file.failed ? ' is-failed' : ''}${!file.id && !file.failed ? ' is-uploading' : ''}`;
        const say = file.failed || file.note || file.name;
        const keys = movable ? ' aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"' : '';
        const pasted = file.pastedText != null;
        const face = pasted
          ? pastedFace(file, i, keys)
          : file.isImage
            ? `<button class="stage__open" data-open="${i}" type="button" aria-label="${escapeHtml(t('attachment.edit', { name: file.name }))}"${keys}>
                 <img class="stage__img" src="${file.preview}" alt="" draggable="false">
               </button>`
            : file.thumb
              ? `<img class="stage__img" src="${file.thumb}" alt="" draggable="false">`
              : `<span class="stage__icon" aria-hidden="true">${escapeHtml(type.slice(0, 4))}</span>
                 <span class="stage__name">${escapeHtml(file.name)}</span>
                 <span class="stage__type">${escapeHtml(type)}</span>`;
        return `
      <div class="stage ${pasted ? 'stage--pasted' : file.isImage || file.thumb ? 'stage--media' : 'stage--file'}${state}${movable ? ' stage--movable' : ''}" data-index="${i}" title="${escapeHtml(movable ? `${say} — ${t('attachment.moveHint')}` : say)}">
        ${face}
        ${file.failed ? `<span class="stage__err">${escapeHtml(file.failed)}</span>` : ''}
        ${!file.id && !file.failed ? `<span class="stage__spin" aria-label="${escapeHtml(t('attachment.uploading'))}"></span>` : ''}
        <button class="stage__remove" data-drop="${i}" type="button" aria-label="${escapeHtml(
          t('attachment.remove', { name: file.name }),
        )}"${keys}>✕</button>
      </div>`;
      })
      .join('');

    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-drop]'))) {
      btn.addEventListener('click', () => {
        const [gone] = staged.splice(Number(btn.dataset.drop), 1);
        if (gone?.preview) URL.revokeObjectURL(gone.preview);
        forgetPaste(gone);
        renderStaged();
        refreshSendState();
        renderVisionWarning();
      });
    }
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-open]'))) {
      btn.addEventListener('click', () => editPicture(staged[Number(btn.dataset.open)]));
    }
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-view]'))) {
      btn.addEventListener('click', () => showPasted(staged[Number(btn.dataset.view)].pastedText));
    }
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-unpaste]'))) {
      btn.addEventListener('click', () => backIntoTheBox(Number(btn.dataset.unpaste)));
    }
  }

  /** A long paste's tile: the opening of the words, what it is, and a pencil. */
  function pastedFace(file, i, keys) {
    const { size, lines } = pastedFacts(file.pastedText);
    return `<button class="stage__open stage__paste" data-view="${i}" type="button" aria-label="${escapeHtml(t('pasted.viewFacts', { size, lines }))}"${keys}>
        <span class="stage__excerpt">${escapeHtml(pastedExcerpt(file.pastedText))}</span>
        <span class="stage__badge">${escapeHtml(t('pasted.badge'))}</span>
      </button>
      <button class="stage__pencil" data-unpaste="${i}" type="button" title="${escapeHtml(t('pasted.edit'))}" aria-label="${escapeHtml(t('pasted.edit'))}">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z"/></svg>
      </button>`;
  }

  /**
   * A paste thrown away: its stored copy goes too.
   *
   * Somebody's words they decided not to send should not sit on the server until
   * a clean-up comes round, which is what a removed file does. One still on its
   * way up is deleted when it lands — see `upload`.
   */
  function forgetPaste(entry) {
    if (entry?.pastedText == null) return;
    entry.discarded = true;
    if (entry.id) api.deleteUpload(entry.id).catch(() => {});
  }

  /**
   * The pencil: the whole paste goes into the box being written in, to edit there.
   *
   * After whatever is already typed, with the caret at the start of what came
   * back — the opening is the part somebody has just been looking at on the card.
   * An `input` event rather than a call, so each box's own sizing and Send button
   * answer as they do to typing.
   */
  function backIntoTheBox(index) {
    const [entry] = staged.splice(index, 1);
    if (!entry) return;
    forgetPaste(entry);
    const box = /** @type {HTMLTextAreaElement} */ ($('project-page')?.hidden === false ? $('project-page-ask') : $('input'));
    const before = box.value;
    box.value = before ? `${before}\n${entry.pastedText}` : entry.pastedText;
    renderStaged();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus({ preventScroll: true });
    const at = before ? before.length + 1 : 0;
    box.setSelectionRange(at, at);
    if (!before) box.scrollTop = 0;
  }

  /**
   * A tile moved to another place in the tray (owner, 2026-11-02). The order
   * here is the order the message carries them in — the strip under it, and
   * the order the model is shown them, so "the second picture" means this one.
   */
  function move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= staged.length || to >= staged.length) return false;
    const [entry] = staged.splice(from, 1);
    staged.splice(to, 0, entry);
    renderStaged();
    return true;
  }

  /**
   * Dragging a tile into another place, with the pointer or a finger — or
   * Alt+← / Alt+→ on a focused tile. Pointer events rather than the browser's
   * drag-and-drop, which touch screens do not have and which the window
   * already listens to for files dropped from outside.
   *
   * The tile follows the pointer; the one it would take the place of shows a
   * bar on the side it would land; letting go moves it. A press that never
   * moved is still a press, and opens the picture.
   */
  const armedTrays = new WeakSet();
  let swallowClickUntil = 0;
  function armReorder(host) {
    if (armedTrays.has(host)) return;
    armedTrays.add(host);
    host.addEventListener(
      'click',
      (event) => {
        if (Date.now() < swallowClickUntil) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
    host.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const tile = /** @type {HTMLElement | null} */ (target.closest('.stage--movable'));
      if (!tile || target.closest('.stage__remove, .stage__pencil') || event.button > 0) return;
      const from = Number(tile.dataset.index);
      const tiles = /** @type {HTMLElement[]} */ ([...host.querySelectorAll('.stage')]);
      const centres = tiles.map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const start = { x: event.clientX, y: event.clientY };
      let dragging = false;
      let to = from;
      const mark = () => {
        tiles.forEach((node, i) => {
          node.classList.toggle('is-target-before', dragging && i === to && to < from);
          node.classList.toggle('is-target-after', dragging && i === to && to > from);
        });
      };
      const onMove = (/** @type {PointerEvent} */ e) => {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!dragging) {
          if (Math.hypot(dx, dy) < 6) return;
          dragging = true;
          tile.setPointerCapture?.(e.pointerId);
          tile.classList.add('is-dragging');
          host.classList.add('is-sorting');
        }
        e.preventDefault();
        tile.style.transform = `translate(${dx}px, ${dy}px)`;
        // The slot whose middle is nearest the pointer.
        let best = from;
        let bestDistance = Infinity;
        centres.forEach((c, i) => {
          const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
          if (d < bestDistance) {
            bestDistance = d;
            best = i;
          }
        });
        to = best;
        mark();
      };
      /*
       * Heard on the window, not the tile (UI-004): an upload finishing mid-drag
       * redraws the tray, the tile goes, and with its listeners went the only
       * pointerup that would end the drag — the tray stayed "sorting" and the
       * next press dragged a ghost. A drag whose tile was redrawn away is dropped.
       */
      const finish = (/** @type {PointerEvent} */ e) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (!dragging) return;
        swallowClickUntil = Date.now() + 400;
        tile.classList.remove('is-dragging');
        tile.style.transform = '';
        host.classList.remove('is-sorting');
        const moved = e.type === 'pointerup' && tile.isConnected && move(from, to);
        if (!moved) {
          dragging = false;
          mark();
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    });
    host.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const tile = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.stage--movable'));
      if (!tile) return;
      event.preventDefault();
      const from = Number(tile.dataset.index);
      const to = from + (event.key === 'ArrowLeft' ? -1 : 1);
      const which = /** @type {HTMLElement} */ (event.target).classList.contains('stage__remove') ? '.stage__remove' : '.stage__open';
      if (!move(from, to)) return;
      /** @type {HTMLElement | null} */ (host.querySelector(`.stage[data-index="${to}"] ${which}`))?.focus();
      announce(t('attachment.movedTo', { n: to + 1, total: staged.length }));
    });
  }

  /**
   * Open a staged picture to draw or write on, and send the result instead.
   *
   * The edited picture replaces the original in the tray and is uploaded as a
   * new attachment; the original upload is simply never sent.
   */
  async function editPicture(entry) {
    if (!entry?.preview) return;
    const blob = await openSketch(entry.preview);
    if (!blob || !staged.includes(entry)) return;
    const name = entry.name.replace(/\.[^.]+$/, '') + '.png';
    URL.revokeObjectURL(entry.preview);
    entry.preview = URL.createObjectURL(blob);
    entry.id = null;
    entry.failed = null;
    entry.note = null;
    await upload(entry, new File([blob], name, { type: 'image/png' }));
  }

  /**
   * Per staged entry, which of its uploads is the newest. A picture edited while
   * its original is still on the way is two uploads, and whichever finished
   * last used to set the id: the tray showed the edit while the message could
   * carry the original (CODE-037). Only the newest may land now.
   */
  const uploads = new WeakMap();

  /** Upload one staged file, shrinking it first where that is honest. */
  async function upload(entry, file) {
    if (!uploads.has(entry)) uploads.set(entry, newestOnly());
    const current = uploads.get(entry)();
    renderStaged();
    refreshSendState();
    try {
      /**
       * Shrunk first, where shrinking is honest.
       *
       * A photo off a phone is eight megapixels that no model reads at that
       * resolution, and an oversized PDF can be sent as the text inside it —
       * which is what most of the library would have been given anyway. What
       * this replaces is a request the host refused at the edge, with a
       * plain-text error that never mentioned the file. See shrink.js.
       */
      // The small picture is drawn alongside the upload and kept with the file,
      // so the sent message shows the same tile without fetching the whole file.
      const [ready, drawn] = await preparedWithThumb(file, entry.isImage || entry.isPdf ? thumbnailFor : null);
      if (!current()) return;
      if (drawn.thumb && entry.isPdf && staged.includes(entry)) {
        entry.thumb = drawn.thumb;
        renderStaged();
      }
      const { attachment } = await api.uploadAttachment({ ...ready, thumb: drawn.thumb || undefined });
      if (entry.discarded) {
        api.deleteUpload(attachment.id).catch(() => {});
        return;
      }
      if (!current()) return;
      entry.id = attachment.id;
      entry.name = ready.name;
      // Said out loud rather than done quietly: what was sent is not quite
      // what was picked, and a person answering questions about a document
      // needs to know it went as text.
      if (ready.note) entry.note = describeShrink(ready.note);
    } catch (err) {
      if (!current()) return;
      entry.failed = err.message;
    }
    renderStaged();
    refreshSendState();
  }

  async function stageFiles(files) {
    const limits = state.boot?.attachments || { maxBytes: 5 * 1024 * 1024, maxPerMessage: 6 };

    for (const file of files) {
      if (staged.length >= limits.maxPerMessage) {
        toast(t('attachment.tooMany', { count: limits.maxPerMessage }), 'error');
        break;
      }
      // Refused here as well as on the server, so a 5MB mistake is not found out
      // at the end of a 5MB upload — but only for what cannot be made smaller.
      // A photo is re-encoded, a PDF is sent as its text and an Office file
      // without its pictures (see shrink.js), so a 7MB PDF of lecture slides
      // fits; refusing it on its raw size here meant that path was never
      // reached. Those get a much higher ceiling, which
      // is about what the browser can read without struggling, not about the upload.
      const ceiling = shrinkable(file) ? MAX_SHRINKABLE_BYTES : limits.maxBytes;
      if (file.size > ceiling) {
        toast(
          t('attachment.tooBig', { name: file.name, size: humanSize(file.size), limit: humanSize(ceiling) }),
          'error',
        );
        continue;
      }

      const entry = {
        name: file.name,
        size: file.size,
        mime: file.type || '',
        id: null,
        isImage: isImage(file.type),
        isPdf: /pdf/i.test(file.type) || /\.pdf$/i.test(file.name),
        preview: isImage(file.type) ? URL.createObjectURL(file) : null,
        // A PDF's first page, once `upload` has drawn it. Its own field:
        // `preview` means "a picture of the file itself".
        thumb: null,
      };
      staged.push(entry);
      renderVisionWarning();
      await upload(entry, file);
    }
  }

  /**
   * A paste stays. It is somebody's words, like what they have typed — and those
   * stay in the box when the conversation changes, so a card must not be the one
   * thing that vanishes, with no way back but the clipboard. ✕ is how one goes.
   */
  function clearStaged() {
    const words = staged.filter((file) => file.pastedText != null);
    for (const file of staged) if (file.preview) URL.revokeObjectURL(file.preview);
    staged.length = 0;
    staged.push(...words);
    renderStaged();
    renderVisionWarning();
  }

  async function refreshModelFacts() {
    if (!state.model) return;
    // `auto` is OpenRouter's free router, which is free and routes a turn
    // carrying an image to a model that reads images — so the free badge is on
    // and the vision warning stays off.
    if (state.model === 'auto') {
      modelIsFree = true;
      modelSeesImages = true;
      // The router picks per request, so whether this turn reasons is unknown.
      state.modelReasons = null;
      renderVisionWarning();
      renderTopbar();
      return;
    }
    try {
      const { model } = await api.resolveModel(state.model);
      modelSeesImages = model.vision !== false;
      modelIsFree = !!model.isFree;
      // true / false / null (unknown) — the effort dial says so when it is false.
      state.modelReasons = model.reasoning ?? null;
    } catch {
      // `true` until told otherwise: the vision warning must never be the thing
      // that appears wrongly. A missing free badge is the harmless direction.
      modelSeesImages = true;
      modelIsFree = false;
      state.modelReasons = null;
    }
    renderVisionWarning();
    renderTopbar();
    onboarding.refresh();
  }

  /**
   * Say it before the send, not after the failure.
   *
   * Attaching a screenshot to a text-only model does not produce a worse answer —
   * the provider rejects the entire request, and on OpenRouter that arrives as a
   * bare "not found" with nothing to connect it to the image. Which is exactly how
   * it was reported: pasted a screenshot, got "not found".
   */
  function renderVisionWarning() {
    const images = staged.filter((f) => f.isImage).length;
    const show = images > 0 && !modelSeesImages;

    $('vision-warning').hidden = !show;
    if (!show) return;

    const name = String(state.model || '').split('/').pop();
    $('vision-warning-text').textContent = t(images === 1 ? 'vision.blind.one' : 'vision.blind.many', { model: name });
  }

  $('vision-switch').addEventListener('click', () => openModelBrowser(state.model));

  // The + opens the composer's menu now (plus-menu.js); its first row is this picker.

  $('file-input').addEventListener('change', async (event) => {
    const picker = /** @type {HTMLInputElement} */ (event.target);
    const files = [...picker.files];
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, which looks exactly like the button being broken.
    picker.value = '';
    await stageFiles(files);
  });

  /**
   * A long paste becomes a card (pasted.js). Whatever cannot be one — the message
   * already holds as many as it may, or it is over the size of a file — is left
   * to the browser, so it lands in the box: never a refusal that loses the words.
   */
  function stagePaste(/** @type {ClipboardEvent} */ event) {
    const text = tidyPaste(event.clipboardData?.getData('text/plain'));
    if (!isLongPaste(text)) return;
    const limits = state.boot?.attachments || { maxBytes: 5 * 1024 * 1024, maxPerMessage: 6 };
    const file = new File([text], pastedName(staged.map((f) => f.name)), { type: 'text/plain' });
    if (staged.length >= limits.maxPerMessage || file.size > limits.maxBytes) return;
    event.preventDefault();
    if (text.length > MODEL_READS_CHARS) toast(t('pasted.tooLong', { n: MODEL_READS_CHARS.toLocaleString(currentLanguage()) }));
    const entry = { name: file.name, size: file.size, mime: file.type, id: null, isImage: false, isPdf: false, preview: null, thumb: null, pastedText: text };
    staged.push(entry);
    void upload(entry, file);
  }

  // Pasting a screenshot is how most images actually arrive, and both boxes share the tray.
  for (const box of [$('input'), $('project-page-ask')]) {
    box?.addEventListener('paste', async (/** @type {ClipboardEvent} */ event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return stagePaste(event);
      event.preventDefault();
      await stageFiles(files);
    });
  }

  // And dragging one onto the window is the other way.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (/** @type {DragEvent} */ event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      if (type === 'dragover') {
        $('app').classList.add('is-dropping');
        return;
      }
      $('app').classList.remove('is-dropping');
      stageFiles([...event.dataTransfer.files]);
    });
  }
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) $('app').classList.remove('is-dropping');
  });

  /**
   * A file that is already this account's attachment — one picked from Google
   * Drive in the + menu, which the server fetched and saved — put in the tray
   * as though it had been uploaded from here. Over the per-message limit, it is
   * refused in the same words a picked file is.
   */
  function stageAttachment(attachment) {
    const limits = state.boot?.attachments || { maxPerMessage: 6 };
    if (staged.length >= limits.maxPerMessage) {
      toast(t('attachment.tooMany', { count: limits.maxPerMessage }), 'error');
      return;
    }
    const mime = attachment.mime || '';
    staged.push({
      name: attachment.name,
      size: Number(attachment.size) || 0,
      mime,
      id: attachment.id,
      isImage: isImage(mime),
      isPdf: /pdf/i.test(mime) || /\.pdf$/i.test(attachment.name || ''),
      // The bytes are on the server, not in this browser: a picture is drawn
      // from there, anything else is its name and type.
      preview: isImage(mime) ? `/api/attachments/${encodeURIComponent(attachment.id)}` : null,
      thumb: null,
    });
    renderStaged();
    refreshSendState();
    renderVisionWarning();
  }

  return {
    /** The staging list itself, mutated in place by whoever holds it. */
    staged,
    renderStaged,
    stageFiles,
    stageAttachment,
    clearStaged,
    refreshModelFacts,
    renderVisionWarning,
    isFree: () => modelIsFree,
    seesImages: () => modelSeesImages,
  };
}
