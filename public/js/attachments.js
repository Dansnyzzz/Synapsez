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
import { toast } from './render.js';
import { t } from './i18n.js';
import { humanSize } from './format.js';
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
   */
  function renderStaged() {
    const host = $('attachments');
    host.hidden = staged.length === 0;

    host.innerHTML = staged
      .map((file, i) => {
        const type = typeOf(file.name);
        const state = `${file.failed ? ' is-failed' : ''}${!file.id && !file.failed ? ' is-uploading' : ''}`;
        const say = file.failed || file.note || file.name;
        const face = file.isImage
          ? `<button class="stage__open" data-open="${i}" type="button" aria-label="${escapeHtml(t('attachment.edit', { name: file.name }))}">
               <img class="stage__img" src="${file.preview}" alt="">
             </button>`
          : file.thumb
            ? `<img class="stage__img" src="${file.thumb}" alt="">`
            : `<span class="stage__icon" aria-hidden="true">${escapeHtml(type.slice(0, 4))}</span>
               <span class="stage__name">${escapeHtml(file.name)}</span>
               <span class="stage__type">${escapeHtml(type)}</span>`;
        return `
      <div class="stage ${file.isImage || file.thumb ? 'stage--media' : 'stage--file'}${state}" title="${escapeHtml(say)}">
        ${face}
        ${file.failed ? `<span class="stage__err">${escapeHtml(file.failed)}</span>` : ''}
        ${!file.id && !file.failed ? `<span class="stage__spin" aria-label="${escapeHtml(t('attachment.uploading'))}"></span>` : ''}
        <button class="stage__remove" data-drop="${i}" type="button" aria-label="${escapeHtml(
          t('attachment.remove', { name: file.name }),
        )}">✕</button>
      </div>`;
      })
      .join('');

    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-drop]'))) {
      btn.addEventListener('click', () => {
        const [gone] = staged.splice(Number(btn.dataset.drop), 1);
        if (gone?.preview) URL.revokeObjectURL(gone.preview);
        renderStaged();
        refreshSendState();
        renderVisionWarning();
      });
    }
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-open]'))) {
      btn.addEventListener('click', () => editPicture(staged[Number(btn.dataset.open)]));
    }
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

  function clearStaged() {
    for (const file of staged) if (file.preview) URL.revokeObjectURL(file.preview);
    staged.length = 0;
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

  $('attach').addEventListener('click', () => $('file-input').click());

  $('file-input').addEventListener('change', async (event) => {
    const picker = /** @type {HTMLInputElement} */ (event.target);
    const files = [...picker.files];
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, which looks exactly like the button being broken.
    picker.value = '';
    await stageFiles(files);
  });

  // Pasting a screenshot is how most images actually arrive.
  $('input').addEventListener('paste', async (/** @type {ClipboardEvent} */ event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    await stageFiles(files);
  });

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

  return {
    /** The staging list itself, mutated in place by whoever holds it. */
    staged,
    renderStaged,
    stageFiles,
    clearStaged,
    refreshModelFacts,
    renderVisionWarning,
    isFree: () => modelIsFree,
    seesImages: () => modelSeesImages,
  };
}
