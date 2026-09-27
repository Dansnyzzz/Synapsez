import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
import { toast } from './render.js';
import { counted, repeatsAs } from './format.js';
import { prepareUpload } from './shrink.js';
import { thumbnailFor } from './thumbnail.js';

/**
 * One project, opened.
 *
 * A page rather than the old sheet, because a project is a place you work
 * *from*: conversations start here, and what the assistant reads while you are
 * here is set here. A dialog floating over somebody else's transcript said the
 * opposite — that you were passing through.
 *
 * Two columns. The left is the work: a composer, then the conversations this
 * project has already produced. The right is what the work reads from —
 * instructions, memory, and the documents on the shelf. Everything on the right
 * is labelled with what it actually is; see the memory card in particular.
 */

const $ = (id) => document.getElementById(id);

/**
 * A count and its noun, as a whole phrase — the same helper `pages.js` uses.
 *
 * The English pluralisation rule this replaced could not be translated, only
 * replaced: Vietnamese does not inflect the noun, so the translation has to own
 * the entire phrase rather than a stem the formatter adds an `s` to.
 */

/**
 * The extension, upper-cased, or a word when there is none.
 *
 * A card needs something to be at a glance, and for a produced document that is
 * its kind: DOCX, XLSX, PDF, HTML. Three letters carry it better than an icon
 * set that would need one glyph per format nobody has drawn yet.
 */
const extensionLabel = (name) => {
  const dot = String(name || '').lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return (ext || 'file').slice(0, 5).toUpperCase();
};

/** A file's size, for a card. The chars count means nothing for a picture. */
const fmtBytes = (n) => {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}kB`;
  return `${bytes}B`;
};

// `repeatsAs` moved to format.js, where the transcript's schedule card can reach
// it too. Re-exported so the modules that already import it from here still do.
export { repeatsAs };

const fmtChars = (n) => {
  const say = (key, value) => t(key).replace('{n}', String(value));
  if (n >= 1_000_000) return say('count.charsM', (n / 1_000_000).toFixed(1));
  if (n >= 1000) return say('count.charsK', Math.round(n / 1000));
  return say('count.chars', n);
};

const ago = (value) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const n = (key, count) => t(key).replace('{n}', String(count));
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return t('when.justNow');
  if (seconds < 3600) return n('when.minutes', Math.round(seconds / 60));
  if (seconds < 172800) {
    return seconds < 86400 ? n('when.hours', Math.round(seconds / 3600)) : t('when.yesterday');
  }
  if (seconds < 2592000) return n('when.days', Math.round(seconds / 86400));
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * When somebody last said something in this conversation.
 *
 * The row used to carry "10 messages", which answers a question nobody asks.
 * Scanning a project's conversations is a search through time — "the one I was
 * in on Friday", "the one from before the deadline" — and a count sorts you
 * nowhere, while the list is already ordered by exactly the thing it was not
 * showing.
 *
 * A real date rather than "3 days ago": relative time reads well for the last
 * hour and stops meaning anything past a week, which is where most of a
 * project's conversations live. The full timestamp goes in the tooltip for
 * anyone who wants the hour.
 */
const lastSpoke = (value) => {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  return new Date(then).toLocaleDateString(currentLanguage(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

/** A File as base64, without the `data:…;base64,` preamble the server does not want. */

/** Text as base64, going through UTF-8 first — `btoa` alone throws on anything accented. */
const textToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * The four things you can do to a project from a ⋮ menu.
 *
 * Shared between the shelf and this page so the two never drift: a card that
 * offers "Archive" and a header that does not would be the same object with two
 * different sets of rules.
 *
 * @param project  the row, as the API returns it
 * @param after    called once something actually changed
 * @param onGone   called when the project no longer exists (deleted)
 */
export function projectMenuItems(project, { after, onGone, onEdit }) {
  const pinned = !!project.pinned;
  const archived = !!project.archived_at;

  const patch = async (body, said) => {
    try {
      await api.updateProject(project.id, body);
      document.dispatchEvent(new globalThis.CustomEvent('projects-changed'));
      toast(said);
      await after?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return [
    {
      label: pinned ? t('proj.unpin') : t('proj.pin'),
      icon: '📌',
      run: () => patch({ pinned: !pinned }, pinned ? t('proj.unpinned') : t('proj.pinned')),
    },
    { label: t('proj.editDetails'), icon: '✎', run: () => onEdit(project) },
    {
      label: archived ? t('proj.restore') : t('proj.archive'),
      icon: '🗄',
      run: () =>
        patch(
          { archived: !archived },
          archived ? t('proj.restored') : t('proj.archived'),
        ),
    },
    null,
    {
      label: t('proj.delete'),
      icon: '🗑',
      danger: true,
      run: async () => {
        // A real confirm, not a two-press button: this one is permanent, and
        // the menu it was chosen from has already closed, so there is nothing
        // left on screen to arm.
        const sure = window.confirm(t('proj.deleteConfirm').replace('{name}', project.name));
        if (!sure) return;
        try {
          await api.deleteProject(project.id);
          document.dispatchEvent(new globalThis.CustomEvent('projects-changed'));
          toast(t('proj.deleted'), 'ok');
          await onGone?.();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
  ];
}

/**
 * The edit-details dialog, shared for the same reason the menu is.
 * Resolves to the updated project, or null if it was cancelled.
 */
export function editProjectDetails(project) {
  return new Promise((resolve) => {
    const dialog = $('project-edit');
    const name = $('project-edit-name');
    const about = $('project-edit-about');
    const error = $('project-edit-error');
    const save = $('project-edit-save');
    const cancel = $('project-edit-cancel');

    name.value = project.name || '';
    about.value = project.instructions || '';
    error.textContent = '';

    const done = (value) => {
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onCancel = () => done(null);
    const onClose = () => done(null);
    async function onSave() {
      const value = name.value.trim();
      if (!value) {
        error.textContent = t('proj.needName');
        return;
      }
      save.disabled = true;
      try {
        const { project: updated } = await api.updateProject(project.id, {
          name: value,
          instructions: about.value,
        });
        done(updated);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    }

    save.addEventListener('click', onSave);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    name.focus();
    name.select();
  });
}

/**
 * @param openChat   open one of this project's conversations
 * @param startChat  begin a new conversation in this project, carrying the first message
 * @param onBack     return to the Projects shelf
 */
export function createProjectPage({
  openChat,
  startChat,
  onBack,
  /** Show one of this project's own documents in the side panel. */
  openFile = (/** @type {{ id: string, name: string }} */ _file) => {},
  /** Open the shared task form, so the project page never grows a second copy. */
  newTask = (/** @type {{ project: { id: string, name: string }, after: () => Promise<void> }} */ _options) => {},
  /** Show one task on its own page. */
  openTask = (/** @type {string} */ _id) => {},
}) {
  const page = $('project-page');
  const nameEl = $('project-page-name');
  const crumb = $('project-page-crumb');
  const pinButton = $('project-page-pin');
  const moreButton = $('project-page-more');
  const ask = $('project-page-ask');
  const send = $('project-page-send');
  const chip = $('project-page-chip');
  const chatList = $('project-page-chats');
  const outputsHost = $('project-page-outputs');
  const memorySheet = /** @type {HTMLDialogElement} */ ($('memory-sheet'));
  const memoryBody = $('memory-sheet-body');
  const side = $('project-page-side');

  /** Everything the last load returned: `{ project, files, chats, memory }`. */
  let data = null;
  /** True while the instructions card is a textarea rather than a paragraph. */
  let editingInstructions = false;
  /**
   * Picking sources to remove.
   *
   * Off until somebody long-presses a card or ticks one, because a shelf is
   * mostly read rather than edited and a row of checkboxes over it is clutter
   * offered to everybody for the sake of the rare deletion. `selected` holds
   * ids rather than indexes: the list is reloaded after every change, and an
   * index would quietly come to mean a different file.
   */
  let selecting = false;
  const selected = new Set();

  /* ── the page ─────────────────────────────────────────────────── */

  function draw() {
    const { project, files, chats, memory, tasks = [], outputs = [] } = data;

    crumb.textContent = project.name;
    nameEl.textContent = project.name;
    document.title = `${project.name} · Synapse`;

    pinButton.classList.toggle('is-on', !!project.pinned);
    pinButton.setAttribute('aria-pressed', String(!!project.pinned));
    pinButton.setAttribute('aria-label', project.pinned ? t('proj.unpinAria') : t('proj.pinAria'));

    chip.textContent = files.length
      ? t(project.grounded ? 'proj.answersFrom' : 'proj.answersFirstFrom').replace(
          '{sources}',
          counted(files.length, 'count.sources'),
        )
      : t('proj.noSources');

    drawOutputs(outputs);
    drawChats(chats);
    drawSide(project, files, memory, tasks, outputs);
  }

  /**
   * What the project has produced, above the conversations that produced it.
   *
   * In the work column rather than the reference column, because the right-hand
   * side is what the work *reads from* — instructions, memory, the shelf of
   * sources — and a finished report is not a source, it is the point. Cards
   * rather than rows for the same reason the shelf uses cards: a column of
   * filenames tells you a project made four documents and nothing about which
   * one you want.
   */
  function drawOutputs(outputs) {
    if (!outputs.length) {
      outputsHost.innerHTML = '';
      return;
    }

    outputsHost.innerHTML =
      `<h2 class="panel-card__name" style="margin:26px 0 12px">${escapeHtml(t('proj.outputs'))}</h2>` +
      `<div class="shelf">${outputs
        .map(
          (file) => `
        <button class="outcard" type="button" data-output="${escapeHtml(file.id)}"
                title="${escapeHtml(file.chat_title || '')}">
          <span class="outcard__kind">${escapeHtml(extensionLabel(file.name))}</span>
          <span class="outcard__name">${escapeHtml(file.name)}</span>
          <span class="outcard__meta">${escapeHtml(fmtBytes(file.bytes))} · ${escapeHtml(
            lastSpoke(file.created_at),
          )}</span>
        </button>`,
        )
        .join('')}</div>`;

    for (const button of /** @type {NodeListOf<HTMLElement>} */ (
      outputsHost.querySelectorAll('[data-output]')
    )) {
      const file = outputs.find((entry) => entry.id === button.dataset.output);
      if (file) button.addEventListener('click', () => openFile({ id: file.id, name: file.name }));
    }
  }

  function drawChats(chats) {
    if (!chats.length) {
      chatList.innerHTML = `
        <div class="project__empty">
          <div class="blank__ring">${chatMark}</div>
          <div class="blank__say">${escapeHtml(t('proj.noChats'))}</div>
          <p class="hint" style="max-width:44ch">${escapeHtml(t('proj.noChatsHint'))}</p>
        </div>`;
      return;
    }

    chatList.innerHTML =
      `<h2 class="panel-card__name" style="margin:26px 0 12px">${escapeHtml(
        counted(chats.length, 'count.conversations'),
      )}</h2>` +
      chats
        .map(
          (chat) => `
        <button class="chatline" type="button" data-chat="${escapeHtml(chat.id)}"
                title="${escapeHtml(t('proj.lastSpoke', { when: new Date(chat.updated_at).toLocaleString(currentLanguage()) }))}">
          <span class="chatline__name">${escapeHtml(chat.title || t('proj.untitled'))}</span>
          <span class="chatline__when">${escapeHtml(lastSpoke(chat.updated_at))}</span>
        </button>`,
        )
        .join('');

    for (const button of chatList.querySelectorAll('[data-chat]')) {
      button.addEventListener('click', () => openChat(button.dataset.chat));
    }
  }

  /**
   * One scheduled task, in the project that owns it.
   *
   * Says whether it is on and how often it repeats, because those are the two
   * things you check when you glance at a list of things running unattended.
   * "Manual only" is a real answer here rather than a blank: it means nothing
   * happens until somebody presses Run now.
   */
  function taskRow(task) {
    return `
      <button class="ptask${task.enabled ? '' : ' ptask--off'}" type="button" data-task="${escapeHtml(task.id)}">
        <span class="ptask__mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.6 1.6"/></svg>
        </span>
        <span class="ptask__body">
          <span class="ptask__name">${escapeHtml(task.title)}</span>
          <span class="ptask__when">${escapeHtml(repeatsAs(task))}</span>
        </span>
        <span class="ptask__state">${escapeHtml(task.enabled ? t('proj.taskActive') : t('proj.taskPaused'))}</span>
      </button>`;
  }

  /**
   * Every note, in full, and the only place one can be thrown away.
   *
   * The card on the page is a glance — four lines, each clipped to ninety
   * characters. This is the rest of it, and the delete is the part that had no
   * home at all: a note is read into every future conversation, so one that has
   * gone stale is a wrong fact being repeated, and the only way to be rid of it
   * was to ask the assistant to call `memory_delete` and hope it picked the
   * right key. Nobody should have to negotiate about their own notes.
   *
   * Both scopes are listed, because both are read here. Deleting an account
   * note says plainly that it goes everywhere — it is not this project's to
   * throw away quietly.
   */
  function openMemorySheet() {
    const notes = data.memory || [];
    memoryBody.innerHTML = notes.length
      ? `<p class="hint" style="margin:0 0 14px">${t('proj.memoryLede')}</p>` +
        notes
          .map(
            (note) => `
        <div class="note">
          <div class="note__head">
            <span class="note__key">${escapeHtml(note.key)}</span>
            <span class="note__scope note__scope--${note.scope === 'project' ? 'here' : 'all'}">${escapeHtml(
              t(note.scope === 'project' ? 'proj.noteHere' : 'proj.noteEverywhere'),
            )}</span>
            <span class="note__when">${escapeHtml(ago(note.updatedAt))}</span>
            <button class="btn btn--ghost btn--small" type="button"
                    data-forget="${escapeHtml(note.key)}" data-scope="${escapeHtml(note.scope)}">${escapeHtml(
                      t('action.delete'),
                    )}</button>
          </div>
          <p class="note__body">${escapeHtml(note.content)}</p>
        </div>`,
          )
          .join('')
      : `<p class="hint">${escapeHtml(t('proj.memoryEmpty'))}</p>`;

    for (const button of /** @type {NodeListOf<HTMLElement>} */ (
      memoryBody.querySelectorAll('[data-forget]')
    )) {
      button.addEventListener('click', async () => {
        const { forget, scope } = button.dataset;
        // Two presses, the way everything destructive in this app works: the
        // first says what is about to happen, the second does it.
        if (button.dataset.armed !== 'yes') {
          button.dataset.armed = 'yes';
          button.textContent = t('action.sure');
          button.classList.add('is-armed');
          setTimeout(() => {
            if (!button.isConnected || button.dataset.armed !== 'yes') return;
            delete button.dataset.armed;
            button.textContent = t('action.delete');
            button.classList.remove('is-armed');
          }, 4000);
          return;
        }
        try {
          await api.forgetNote(data.project.id, forget, scope);
          await reload();
          openMemorySheet();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    memorySheet.showModal();
  }

  function drawSide(project, files, memory, tasks = [], outputs = []) {
    side.innerHTML = `
      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">${escapeHtml(t('proj.instructions'))}</span>
          <button class="panel-card__add" id="pp-edit-instructions" type="button"
                  aria-label="${escapeHtml(editingInstructions ? t('action.cancel') : t('proj.editInstructions'))}">${
                    editingInstructions ? '✕' : '✎'
                  }</button>
        </div>
        ${
          editingInstructions
            ? `<textarea id="pp-instructions">${escapeHtml(project.instructions || '')}</textarea>
               <div class="panel-card__foot">
                 <button class="btn btn--primary" id="pp-save-instructions" type="button">${escapeHtml(t('action.save'))}</button>
               </div>`
            : `<p class="panel-card__say">${
                project.instructions
                  ? escapeHtml(project.instructions)
                  : escapeHtml(t('project.noInstructions'))
              }</p>`
        }
      </section>

      <!-- What the assistant has learned. A note picked up inside this
           project is filed under it and read back only by its conversations;
           the account's own notes apply here too, and each row says which it
           is. Before this the card showed one flat account-wide list, which
           meant a client's house style learned in one project turned up in the
           answers of every other. -->
      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">${escapeHtml(t('proj.memory'))}</span>
          <span class="panel-card__tag" title="${escapeHtml(t('proj.memoryScope'))}">${escapeHtml(t('proj.accountWide'))}</span>
        </div>
        ${
          memory.length
            ? `<p class="panel-card__say" style="margin-bottom:8px">${t('proj.memoryLede')}</p>` +
              memory
                .map(
                  (note) => `
              <div class="source">
                <span class="source__name" title="${escapeHtml(note.content)}">${escapeHtml(
                  note.content.slice(0, 90),
                )}</span>
                <span class="note__scope note__scope--${note.scope === 'project' ? 'here' : 'all'}">${escapeHtml(
                  t(note.scope === 'project' ? 'proj.noteHere' : 'proj.noteEverywhere'),
                )}</span>
                <span class="source__size">${escapeHtml(ago(note.updatedAt))}</span>
              </div>`,
                )
                .join('')
            : `<p class="panel-card__say">${escapeHtml(t('proj.memoryEmpty'))}</p>`
        }
        <div class="panel-card__foot">
          <button class="btn btn--ghost btn--small" id="pp-view-memory" type="button">${escapeHtml(
            t('proj.viewMemory'),
          )}</button>
        </div>
      </section>

      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">${escapeHtml(t('proj.context'))}</span>
          <!-- Cards are right for twenty sources and wrong for two hundred: at
               that size the only question is "where is the one called X". -->
          <button class="panel-card__add" id="pp-find-source" type="button"
                  aria-label="${escapeHtml(t('proj.searchFiles'))}"
                  title="${escapeHtml(t('proj.searchFiles'))}">
            <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3 3"/></svg>
          </button>
          <button class="panel-card__add" id="pp-add-source" type="button"
                  aria-haspopup="menu" aria-label="${escapeHtml(t('proj.addContext'))}">+</button>
        </div>
        ${files.length ? shelfBar(files) : ''}
        ${files.length ? `<div class="shelf">${files.map(sourceCard).join('')}</div>` : ''}
        <div class="dropzone" id="pp-dropzone" tabindex="0" role="button">
          <span>${uploadMark}</span>
          <span>${escapeHtml(t('proj.dropHere'))}</span>
          <span style="font-size:11.5px">${escapeHtml(t('proj.dropKinds'))}</span>
        </div>
        <p class="panel-card__say" style="margin-top:10px">${escapeHtml(t('proj.sourcesAsText'))}</p>
      </section>

      <!-- The work this project does on its own. Filed here rather than only in
           the global list because a task made from a project runs inside it —
           same instructions, same shelf — and that is a property of the
           project, not of the scheduler. -->
      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">${escapeHtml(t('proj.scheduled'))}</span>
          <button class="panel-card__add" id="pp-add-task" type="button"
                  aria-label="${escapeHtml(t('proj.addTask'))}">+</button>
        </div>
        ${
          tasks.length
            ? tasks.map(taskRow).join('')
            : `<p class="panel-card__say">${escapeHtml(t('proj.noTasks'))}</p>`
        }
      </section>`;

    wireSide();
  }

  /**
   * The bar above the shelf, once anything is selected.
   *
   * Hidden until then. A row of checkboxes and a delete button standing over a
   * shelf nobody is editing is a hazard offered to somebody who came to read.
   */
  function shelfBar(files) {
    if (!selecting) return '';
    const all = files.length > 0 && selected.size === files.length;
    return `
      <div class="shelf__bar">
        <button class="shelf__all${selected.size ? ' is-on' : ''}" id="pp-select-all" type="button"
                role="checkbox" aria-checked="${all ? 'true' : selected.size ? 'mixed' : 'false'}"
                aria-label="${escapeHtml(t('proj.selectAll'))}">${all ? '✓' : selected.size ? '–' : ''}</button>
        <span class="shelf__count">${escapeHtml(t('proj.nSelected').replace('{n}', String(selected.size)))}</span>
        <button class="shelf__del" id="pp-delete-selected" type="button"
                ${selected.size ? '' : 'disabled'}
                aria-label="${escapeHtml(t('proj.removeSelected'))}"
                title="${escapeHtml(t('proj.removeSelected'))}">🗑</button>
        <button class="shelf__done" id="pp-end-select" type="button"
                aria-label="${escapeHtml(t('action.cancel'))}" title="${escapeHtml(t('action.cancel'))}">✕</button>
      </div>`;
  }

  /**
   * One source, as a card.
   *
   * The picture is the point. A shelf of names told you a project had four
   * PDFs and nothing about which was the rubric; a first page tells you at a
   * glance. Where there is nothing to draw — a .docx, a text file, and anything
   * added before the originals were kept — the card falls back to its name and
   * a type badge, which is what the whole shelf used to be.
   */
  function sourceCard(file) {
    const badge = (file.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const facts = [
      file.pages ? counted(file.pages, 'count.pages') : null,
      file.kind === 'image' ? fmtBytes(file.bytes) : fmtChars(file.chars),
    ]
      .filter(Boolean)
      .join(' · ');

    return `
      <div class="card${selected.has(file.id) ? ' is-picked' : ''}" data-file="${escapeHtml(file.id)}">
        <button class="card__open" type="button" data-open="${escapeHtml(file.id)}"
                aria-label="${escapeHtml(file.name)}">
          ${
            file.thumb
              ? `<span class="card__shot"><img src="${escapeHtml(file.thumb)}" alt="" loading="lazy"></span>`
              : `<span class="card__name">${escapeHtml(file.name)}</span>`
          }
          <span class="card__foot">
            <span class="card__badge">${escapeHtml(badge)}</span>
            ${facts ? `<span class="card__facts">${escapeHtml(facts)}</span>` : ''}
          </span>
        </button>
        <button class="card__tick${selected.has(file.id) ? ' is-on' : ''}" type="button"
                role="checkbox" aria-checked="${selected.has(file.id) ? 'true' : 'false'}"
                data-pick="${escapeHtml(file.id)}"
                aria-label="${escapeHtml(t('proj.selectAria').replace('{name}', file.name))}">${
                  selected.has(file.id) ? '✓' : ''
                }</button>
      </div>`;
  }

  function wireSide() {
    $('pp-edit-instructions').addEventListener('click', () => {
      editingInstructions = !editingInstructions;
      drawSide(data.project, data.files, data.memory, data.tasks || [], data.outputs || []);
      if (editingInstructions) $('pp-instructions').focus();
    });

    $('pp-view-memory')?.addEventListener('click', openMemorySheet);

    $('pp-save-instructions')?.addEventListener('click', async () => {
      const button = $('pp-save-instructions');
      button.disabled = true;
      try {
        const { project } = await api.updateProject(data.project.id, {
          instructions: $('pp-instructions').value,
        });
        data.project = project;
        editingInstructions = false;
        draw();
        toast(t('proj.instructionsSaved'), 'ok');
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
    });

    for (const button of side.querySelectorAll('[data-open]')) {
      button.addEventListener('click', () => {
        // While picking, the card is a checkbox rather than a door: opening a
        // preview under somebody mid-selection loses what they had ticked.
        const file = data.files.find((f) => f.id === button.dataset.open);
        if (!file) return;
        if (selecting) togglePick(file.id);
        else showSource(file);
      });
    }

    for (const button of side.querySelectorAll('[data-pick]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        selecting = true;
        togglePick(button.dataset.pick);
      });
    }

    $('pp-find-source')?.addEventListener('click', () => browseSources());

    $('pp-add-task')?.addEventListener('click', () =>
      newTask({ project: { id: data.project.id, name: data.project.name }, after: reload }),
    );

    for (const button of /** @type {NodeListOf<HTMLElement>} */ (side.querySelectorAll('[data-task]'))) {
      button.addEventListener('click', () => openTask(button.dataset.task));
    }

    $('pp-select-all')?.addEventListener('click', () => {
      if (selected.size === data.files.length) selected.clear();
      else for (const file of data.files) selected.add(file.id);
      drawSide(data.project, data.files, data.memory, data.tasks || [], data.outputs || []);
    });

    $('pp-end-select')?.addEventListener('click', () => {
      selecting = false;
      selected.clear();
      drawSide(data.project, data.files, data.memory, data.tasks || [], data.outputs || []);
    });

    $('pp-delete-selected')?.addEventListener('click', async () => {
      const going = [...selected];
      if (!going.length) return;
      $('pp-delete-selected').disabled = true;
      /**
       * One at a time, and a failure does not strand the rest.
       *
       * There is no bulk endpoint and there does not need to be: removing four
       * sources is four small deletes, and doing them in sequence means a
       * failure names the one file it happened to rather than abandoning the
       * whole batch in an unknown state.
       */
      const failed = [];
      for (const id of going) {
        try {
          await api.deleteProjectFile(data.project.id, id);
          selected.delete(id);
        } catch (err) {
          failed.push(err.message);
        }
      }
      if (failed.length) toast(failed[0], 'error');
      selecting = selected.size > 0;
      await reload();
    });

    /**
     * What can actually be added, and nothing else.
     *
     * Claude's menu offers GitHub and Google Drive here. Neither exists in this
     * application, and a menu entry that opens an apology is worse than no
     * entry — so the list is the two things that work.
     */
    $('pp-add-source').addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu($('pp-add-source'), [
        { label: t('proj.uploadFromDevice'), icon: '⤒', run: () => pick() },
        { label: t('proj.addTextContent'), icon: '¶', run: () => addTextSource() },
      ]);
    });

    const zone = $('pp-dropzone');
    zone.addEventListener('click', pick);
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-over');
      upload([...(event.dataTransfer?.files || [])]);
    });
  }

  function togglePick(id) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    // Ticking the last one off leaves the bar up rather than snapping out of
    // selection: somebody clearing a mistake is usually about to tick another.
    drawSide(data.project, data.files, data.memory, data.tasks || [], data.outputs || []);
  }

  /* ── looking at one source ────────────────────────────────────── */

  /**
   * A source, large.
   *
   * An image is shown as an image and a PDF as its first page with a count of
   * how many there are, because that is the difference between "which file is
   * this" and "is this the right file". The original is one press away for
   * both — it was kept precisely so that it could be.
   *
   * A source with no picture — a .docx, a text file, anything added before the
   * originals were kept — gets the same sheet without one. That is still worth
   * opening: it is where the download lives.
   */
  function showSource(file) {
    const dialog = /** @type {HTMLDialogElement} */ ($('source-view'));
    const title = $('source-view-name');
    const body = $('source-view-body');

    title.textContent = file.name;
    body.innerHTML = '';

    const canGet = !!file.attachment_id;
    const href = canGet ? `/api/attachments/${encodeURIComponent(file.attachment_id)}` : null;

    if (file.thumb) {
      const figure = document.createElement('div');
      figure.className = `sourceview__figure${file.kind === 'document' ? ' is-paper' : ''}`;
      const img = document.createElement('img');
      img.src = file.thumb;
      img.alt = file.name;
      figure.append(img);

      /**
       * The download lives on the picture, revealed by hovering it.
       *
       * On the picture rather than beside it because that is the thing being
       * offered, and hidden until wanted because the page is a preview rather
       * than a toolbar. It is a real link with `download`, so the browser saves
       * the file it was given instead of navigating away from the project.
       */
      if (href) {
        const get = document.createElement('a');
        get.className = 'sourceview__get';
        get.href = href;
        get.download = file.name;
        get.textContent = t('proj.download');
        figure.append(get);
      }
      body.append(figure);
    }

    const foot = document.createElement('p');
    foot.className = 'sourceview__facts';
    foot.textContent = [
      file.pages ? counted(file.pages, 'count.pages') : null,
      file.kind === 'image' ? fmtBytes(file.bytes) : fmtChars(file.chars),
    ]
      .filter(Boolean)
      .join(' · ');
    body.append(foot);

    // Without a thumbnail there is nothing to hover, so the download is its own
    // button rather than something nobody would find.
    if (href && !file.thumb) {
      const get = document.createElement('a');
      get.className = 'btn btn--primary sourceview__plainget';
      get.href = href;
      get.download = file.name;
      get.textContent = t('proj.download');
      body.append(get);
    }
    if (!href) {
      const note = document.createElement('p');
      note.className = 'panel-card__say';
      note.textContent = t('proj.noOriginal');
      body.append(note);
    }

    if (!dialog.open) dialog.showModal();
  }

  /* ── every source, searchable ─────────────────────────────────── */

  /**
   * The shelf as a list, with the file itself beside it.
   *
   * The cards are right up to about twenty sources and wrong after that: past
   * that point nobody is browsing, they are looking for the one called
   * something. So: a search box, a list, and a preview that fills the rest —
   * and the same download the card preview offers, because having found the
   * file you usually want it.
   */
  function browseSources() {
    const dialog = /** @type {HTMLDialogElement} */ ($('context-browse'));
    const find = /** @type {HTMLInputElement} */ ($('context-browse-find'));
    const list = $('context-browse-list');
    const view = $('context-browse-view');
    let chosen = null;

    $('context-browse-count').textContent = counted(data.files.length, 'count.items');

    const show = (file) => {
      chosen = file?.id || null;
      view.innerHTML = '';
      if (!file) {
        const say = document.createElement('p');
        say.className = 'browse__empty';
        say.textContent = t('proj.pickAFile');
        view.append(say);
        return;
      }

      const head = document.createElement('div');
      head.className = 'browse__head';
      const name = document.createElement('span');
      name.className = 'browse__name';
      name.textContent = file.name;
      head.append(name);
      if (file.attachment_id) {
        const get = document.createElement('a');
        get.className = 'btn btn--tiny';
        get.href = `/api/attachments/${encodeURIComponent(file.attachment_id)}`;
        get.download = file.name;
        get.textContent = t('proj.download');
        head.append(get);
      }
      view.append(head);

      if (file.thumb) {
        const figure = document.createElement('div');
        figure.className = `browse__figure${file.kind === 'document' ? ' is-paper' : ''}`;
        const img = document.createElement('img');
        img.src = file.thumb;
        img.alt = file.name;
        figure.append(img);
        view.append(figure);
      }

      const facts = document.createElement('p');
      facts.className = 'browse__facts';
      facts.textContent = [
        file.pages ? counted(file.pages, 'count.pages') : null,
        file.kind === 'image' ? fmtBytes(file.bytes) : fmtChars(file.chars),
      ]
        .filter(Boolean)
        .join(' · ');
      view.append(facts);
    };

    const paint = () => {
      const needle = find.value.trim().toLowerCase();
      // Plain substring matching on the name, because that is what somebody
      // typing three letters of a filename means. Nothing here searches the
      // text inside a source — `search_docs` is the tool for that.
      const shown = needle ? data.files.filter((f) => f.name.toLowerCase().includes(needle)) : data.files;
      list.innerHTML = '';
      for (const file of shown) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `browse__row${file.id === chosen ? ' is-on' : ''}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(file.id === chosen));
        row.textContent = file.name;
        row.addEventListener('click', () => {
          show(file);
          paint();
        });
        list.append(row);
      }
      if (!shown.length) {
        const none = document.createElement('p');
        none.className = 'browse__empty';
        none.textContent = t('proj.noMatch');
        list.append(none);
      }
    };

    find.value = '';
    show(null);
    paint();
    find.oninput = paint;
    if (!dialog.open) dialog.showModal();
    find.focus();
  }

  /* ── adding sources ───────────────────────────────────────────── */

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.multiple = true;
  filePicker.hidden = true;
  document.body.appendChild(filePicker);
  filePicker.addEventListener('change', () => {
    const files = [...(filePicker.files || [])];
    filePicker.value = ''; // so the same file can be chosen again after a failure
    upload(files);
  });

  const pick = () => filePicker.click();

  async function upload(files) {
    if (!files.length) return;
    const zone = $('pp-dropzone');
    let added = 0;

    for (const [i, file] of files.entries()) {
      if (zone) zone.lastElementChild.textContent = t('proj.reading', { name: file.name, n: i + 1, total: files.length });
      try {
        // Drawn here, before the upload, because pdfjs runs in a browser and
        // not on a serverless function — see public/js/thumbnail.js. Never
        // fatal: a file whose picture could not be drawn still becomes a
        // source, and its card shows a type badge instead.
        const { thumb } = await thumbnailFor(file);
        // The same preparation the composer does: a big photo is re-encoded, a
        // big PDF is sent as its text. Without it the host refuses the request
        // at the edge and the shelf reports a JSON parse error.
        const ready = await prepareUpload(file);
        await api.addProjectFile(data.project.id, { ...ready, thumb });
        added += 1;
      } catch (err) {
        // Named, one at a time. "Some files failed" tells nobody which one to
        // fix, and a scanned PDF is a different problem from one that is too big.
        toast(err.message, 'error');
      }
    }

    if (added) toast(t('proj.addedSources').replace('{sources}', counted(added, 'count.sources')));
    await reload();
  }

  function addTextSource() {
    const dialog = $('text-source');
    const name = $('text-source-name');
    const body = $('text-source-body');
    const error = $('text-source-error');
    const save = $('text-source-save');
    const cancel = $('text-source-cancel');

    name.value = '';
    body.value = '';
    error.textContent = '';

    const done = () => {
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', done);
      if (dialog.open) dialog.close();
    };
    async function onSave() {
      const text = body.value.trim();
      if (!text) {
        error.textContent = t('proj.nothingToAdd');
        return;
      }
      const label = name.value.trim() || t('proj.pastedText');
      save.disabled = true;
      try {
        await api.addProjectFile(data.project.id, {
          name: /\.\w{1,5}$/.test(label) ? label : `${label}.txt`,
          mime: 'text/plain',
          data: textToBase64(text),
        });
        done();
        toast(t('proj.added'), 'ok');
        await reload();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    }

    save.addEventListener('click', onSave);
    cancel.addEventListener('click', done);
    dialog.showModal();
    name.focus();
  }

  /* ── the header ───────────────────────────────────────────────── */

  pinButton.addEventListener('click', async () => {
    const next = !data.project.pinned;
    try {
      const { project } = await api.updateProject(data.project.id, { pinned: next });
      data.project = project;
      draw();
      // The sidebar lists pinned projects; tell it now, not on the next click.
      document.dispatchEvent(new globalThis.CustomEvent('projects-changed'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  moreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenu(
      moreButton,
      projectMenuItems(data.project, {
        after: reload,
        onGone: onBack,
        onEdit: async (project) => {
          const updated = await editProjectDetails(project);
          if (updated) await reload();
        },
      }),
    );
  });

  $('project-page-back').addEventListener('click', () => onBack());

  /* ── starting a conversation ──────────────────────────────────── */

  const sizeAsk = () => {
    ask.style.height = 'auto';
    ask.style.height = `${Math.min(ask.scrollHeight, 220)}px`;
  };

  ask.addEventListener('input', () => {
    send.disabled = !ask.value.trim();
    sizeAsk();
  });

  ask.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      go();
    }
  });

  send.addEventListener('click', go);

  function go() {
    const text = ask.value.trim();
    if (!text) return;
    // Nothing is created here: the conversation comes into existence at its
    // first message, carrying the project with it.
    startChat(
      { id: data.project.id, name: data.project.name, grounded: data.project.grounded, files: data.files.length },
      text,
    );
    ask.value = '';
    send.disabled = true;
    sizeAsk();
  }

  /* ── loading ──────────────────────────────────────────────────── */

  async function reload() {
    const fresh = await api.project(data.project.id);
    data = { ...fresh, memory: fresh.memory || [], tasks: fresh.tasks || [], outputs: fresh.outputs || [] };
    draw();
  }

  const chatMark =
    '<svg viewBox="0 0 40 40" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 12a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H16l-7 6v-6a3 3 0 0 1-3-3Z"/></svg>';
  const uploadMark =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

  return {
    /** Show the page for one project. Rejects nothing — it says so on screen. */
    async open(id) {
      page.hidden = false;
      // No conversation is "the open one" while this page has the screen.
      document.getElementById("app")?.classList.add("is-on-page");
      $('page').hidden = true;
      $('thread').hidden = true;
      $('dock').hidden = true;
      page.scrollTop = 0;
      editingInstructions = false;
      ask.value = '';
      send.disabled = true;

      side.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('common.loading'))}</div>`;
      chatList.innerHTML = '';
      try {
        const fresh = await api.project(id);
        data = { ...fresh, memory: fresh.memory || [], tasks: fresh.tasks || [], outputs: fresh.outputs || [] };
        draw();
      } catch (err) {
        crumb.textContent = '';
        nameEl.textContent = t('proj.fallbackName');
        side.innerHTML = `<p class="hint" style="padding:18px 20px">${escapeHtml(err.message)}</p>`;
      }
    },

    hide() {
      page.hidden = true;
      document.title = 'Synapse';
    },

    /** The id on screen, or null. Used to decide whether a refresh applies. */
    showing: () => (page.hidden ? null : data?.project?.id ?? null),
  };
}
