import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
// `repeatsAs` is imported rather than copied: one description of what a cron
// string means, shared with the page that also shows one.
import { editProjectDetails, projectMenuItems, repeatsAs } from './project-page.js';
import { workflowsView, workflowForm } from './workflows.js';
import { toast, scheduleCard } from './render.js';
import { humanSize, counted, cronParts } from './format.js';

/**
 * The shelves: Projects, Artifacts, Scheduled.
 *
 * Pages rather than dialogs, and one shell for all three. A shelf is somewhere
 * you *go* — you look through what is there and pick one — and a sheet floating
 * over the transcript is the wrong shape for that: small, temporary, and
 * implying you were in the middle of something you will be returning to.
 *
 * The header is identical on each: a title, a way to search, a way to order,
 * and the one button that makes a new thing. Written once, because three copies
 * of the same header drift apart one small fix at a time.
 *
 * Everything here is built from strings this file escapes. The names come from
 * the person using it and the artifacts come from a model, so neither is markup.
 */

const $ = (id) => document.getElementById(id);

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
  // Past a month the date is more use than the distance to it. `undefined` as
  // the locale means the browser's, which is the right answer for a date.
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};


/**
 * A count and its noun, as a whole phrase.
 *
 * This was `${n} ${n === 1 ? one : one + 's'}` — an English pluralisation rule
 * baked into the formatter, which is why it could not simply be wrapped in
 * `t()`. Vietnamese does not inflect the noun at all, so the translation has to
 * own the entire phrase; the caller names which pair of keys it wants.
 */

/** Two presses to delete, and the second one deliberate. */
function armed(button, warning, run) {
  let ready = false;
  const original = button.textContent;
  const reset = () => {
    ready = false;
    button.textContent = original;
    button.classList.remove('is-armed');
  };
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!ready) {
      ready = true;
      button.textContent = warning;
      button.classList.add('is-armed');
      setTimeout(reset, 5000);
      return;
    }
    reset();
    try {
      await run();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/**
 * @param openProject  hand a project id to the existing project sheet
 * @param openViewer   hand a file id to the artifact viewer
 * @param openChat     open a conversation, which closes the shelf
 * @param onLeave      restore the conversation view
 * @param onDescribe   start a blank conversation with a sentence begun, for "describe it to the assistant"
 */
export function createPages({
  openProject,
  openViewer,
  openChat,
  onLeave,
  onDescribe = /** @type {(starter?: string, mode?: string) => void} */ (() => onLeave()),
  onNewProject,
  onRunStarted = () => {},
  /** The sidebar keeps its own list of scheduled tasks; tell it when one changes. */
  onTasksChanged = () => {},
  /** The rail beside the conversation is taken by a task, and given back. */
  onPaneOpen = () => {},
  onPaneClose = () => {},
  /** Open the page shell — the moves the app makes before showing any shelf. */
  onShowPage = () => {},
}) {
  const page = $('page');
  const title = $('page-title');
  const lede = $('page-lede');
  const body = $('page-body');
  const search = $('page-search');
  const sortPill = $('page-sort');
  const newButton = $('page-new');
  const sortMenu = $('page-sort-menu');
  const newMenu = $('page-new-menu');

  /** Which shelf is showing, or null when the conversation is. */
  let showing = null;
  /** What has been typed into the search box, per shelf. */
  let query = '';
  /** How the current shelf is ordered or filtered. */
  let order = 'updated';

  const views = {};

  /* ── the shell ────────────────────────────────────────────────── */

  function closeMenus() {
    sortMenu.hidden = true;
    newMenu.hidden = true;
  }

  function menu(host, items) {
    host.innerHTML = items
      .map(
        (item, i) =>
          `<button type="button" data-pick="${i}" class="${item.active ? 'is-active' : ''}">${
            item.icon ? `<span class="menu__icon">${item.icon}</span>` : ''
          }${escapeHtml(item.label)}</button>`,
      )
      .join('');
    for (const button of host.querySelectorAll('[data-pick]')) {
      button.addEventListener('click', () => {
        closeMenus();
        items[Number(button.dataset.pick)].run();
      });
    }
    host.hidden = false;
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.page__tools')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });

  /**
   * The magnifier becomes the field.
   *
   * Both on screen at once was the bug: a round icon button with nothing left
   * to do, and a box beside it that looked like a second, different search.
   * Pressing the icon swaps one for the other; clearing or pressing Escape
   * swaps back and puts the shelf as it was.
   */
  const searchBox = $('page-search-box');

  function openSearch(on) {
    searchBox.hidden = !on;
    $('page-search-open').hidden = on;
    if (on) {
      search.focus();
      return;
    }
    search.value = '';
    if (query) {
      query = '';
      draw();
    }
  }

  $('page-search-open').addEventListener('click', () => openSearch(true));
  $('page-search-clear').addEventListener('click', () => openSearch(false));

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      openSearch(false);
    }
  });

  sortPill.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = sortMenu.hidden;
    closeMenus();
    if (!open) return;
    menu(
      sortMenu,
      views[showing].orders.map((option) => ({
        label: option.label,
        active: option.id === order,
        run: () => {
          // Some orderings are a different *set*, not a different arrangement
          // of the same one — those have to go back to the server.
          const was = order;
          order = option.id;
          renderTools();
          if (option.reload || views[showing].orders.find((o) => o.id === was)?.reload) load();
          else draw();
        },
      })),
    );
  });

  newButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const view = views[showing];
    if (!view.newMenu) return view.onNew();

    const open = newMenu.hidden;
    closeMenus();
    if (open) menu(newMenu, view.newMenu());
  });

  function renderTools() {
    const view = views[showing];
    title.textContent = view.title;
    newButton.textContent = view.newLabel;
    newButton.classList.toggle('page__new--menu', !!view.newMenu);

    lede.hidden = !view.lede;
    if (view.lede) lede.innerHTML = view.lede;

    sortPill.hidden = !view.orders?.length;
    if (view.orders?.length) {
      const current = view.orders.find((o) => o.id === order) || view.orders[0];
      // "Sort by Archived" is not a sentence. An option that changes *which*
      // things are listed rather than their order says so on its own.
      sortPill.innerHTML = current.pill
        ? `<strong>${escapeHtml(current.pill)}</strong>`
        : `${escapeHtml(view.orderLabel)} <strong>${escapeHtml(current.label)}</strong>`;
    }
  }

  /** Everything the current shelf holds, filtered by the search box. */
  let items = [];

  async function draw() {
    const view = views[showing];
    const shown = query ? items.filter((item) => view.matches(item, query)) : items;
    body.innerHTML = view.render(view.sort ? view.sort(shown, order) : shown);
    view.wire?.(items);
  }

  async function load() {
    const view = views[showing];
    body.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('common.loading'))}</div>`;
    try {
      items = await view.load();
      await draw();
    } catch (err) {
      body.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── projects ─────────────────────────────────────────────────── */

  views.projects = {
    // Getters throughout this file, deliberately. These objects are built once
    // when `createPages` runs, so a bare `t()` would freeze the language that
    // was current at boot and never follow a switch — and a shelf is exactly
    // the sort of screen somebody changes language while looking at.
    get title() {
      return t('pages.projects.title');
    },
    get newLabel() {
      return t('pages.projects.new');
    },
    get orderLabel() {
      return t('pages.sortBy');
    },
    get orders() {
      return [
        { id: 'updated', label: t('pages.order.updated') },
        { id: 'created', label: t('pages.order.created') },
        { id: 'name', label: t('pages.order.name') },
      // Archived projects are a separate shelf, fetched separately — they are
      // never mixed into the list above, which is the entire point of archiving
      // one. Hence a reload rather than a client-side re-sort.
        {
          id: 'archived',
          label: t('pages.order.archived'),
          pill: t('pages.order.archived'),
          reload: true,
        },
      ];
    },
    load: async () => (await api.projects({ archived: order === 'archived' })).projects,
    matches: (project, q) =>
      `${project.name} ${project.instructions || ''}`.toLowerCase().includes(q),
    sort: (list, by) =>
      [...list].sort(
        (a, b) =>
          // Pinned first on every ordering, including by name: a pin is a
          // statement about the shelf, not about one way of reading it.
          Number(!!b.pinned) - Number(!!a.pinned) ||
          (by === 'name'
            ? a.name.localeCompare(b.name)
            : new Date(by === 'created' ? b.created_at : b.updated_at) -
              new Date(by === 'created' ? a.created_at : a.updated_at)),
      ),
    render: (list) => {
      if (!list.length) {
        if (order === 'archived') {
          return blank(
            folderMark,
            query ? t('pages.projects.archivedNoneMatch') : t('pages.projects.archivedNone'),
            '',
          );
        }
        return blank(
          folderMark,
          query ? t('pages.projects.noneMatch') : t('pages.projects.none'),
          query ? '' : t('pages.projects.noneHint'),
        );
      }
      return `<div class="cards cards--wide">${list
        .map(
          (project) => `
        <div class="card" data-project="${escapeHtml(project.id)}" role="button" tabindex="0">
          ${project.pinned ? `<span class="card__pin" aria-label="${escapeHtml(t('pages.pinned'))}">📌</span>` : ''}
          <button class="card__more" type="button" aria-haspopup="menu"
                  data-more="${escapeHtml(project.id)}"
                  aria-label="${escapeHtml(t('pages.optionsFor').replace('{name}', project.name))}">⋮</button>
          <span class="card__name">${escapeHtml(project.name)}</span>
          ${project.instructions ? `<span class="card__note">${escapeHtml(project.instructions)}</span>` : ''}
          <span class="card__facts">
            <span>${escapeHtml(counted(project.file_count, 'count.sources'))}</span>
            <span>·</span>
            <span>${escapeHtml(counted(project.chat_count, 'count.conversations'))}</span>
          </span>
          <span class="card__when">${escapeHtml(ago(project.updated_at))}</span>
        </div>`,
        )
        .join('')}</div>`;
    },
    wire: () => {
      const byId = new Map(items.map((project) => [project.id, project]));

      for (const card of body.querySelectorAll('[data-project]')) {
        const go = () => openProject(card.dataset.project);
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-more]')) return;
          go();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            go();
          }
        });
      }

      for (const button of body.querySelectorAll('[data-more]')) {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const project = byId.get(button.dataset.more);
          if (!project) return;
          openMenu(
            button,
            projectMenuItems(project, {
              after: load,
              onGone: load,
              onEdit: async (which) => {
                if (await editProjectDetails(which)) load();
              },
            }),
          );
        });
      }
    },
    onNew: () => onNewProject(),
  };

  /* ── artifacts ────────────────────────────────────────────────── */

  const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|cs|c|h|cpp|php|sh|ps1|sql|css|scss|ya?ml|toml|ini|xml|json)$/i;
  const kindOf = (file) => {
    const name = String(file.name || '');
    if (/\.html?$/i.test(name)) return 'page';
    if (CODE.test(name)) return 'code';
    if (/\.(docx|md|txt|pdf)$/i.test(name)) return 'document';
    if (/\.(xlsx|csv)$/i.test(name)) return 'sheet';
    if (/\.pptx$/i.test(name)) return 'deck';
    return 'other';
  };

  views.artifacts = {
    get title() {
      return t('pages.artifacts.title');
    },
    get newLabel() {
      return t('pages.artifacts.new');
    },
    get orderLabel() {
      return t('pages.filterBy');
    },
    get orders() {
      return [
        { id: 'all', label: t('pages.kind.all') },
        { id: 'page', label: t('pages.kind.page') },
        { id: 'code', label: t('pages.kind.code') },
        { id: 'document', label: t('pages.kind.document') },
        { id: 'sheet', label: t('pages.kind.sheet') },
        { id: 'deck', label: t('pages.kind.deck') },
      ];
    },
    load: async () => (await api.files()).files,
    matches: (file, q) => `${file.name} ${file.chat_title || ''}`.toLowerCase().includes(q),
    sort: (list, by) => (by === 'all' ? list : list.filter((file) => kindOf(file) === by)),
    render: (list) => {
      if (!list.length) {
        return blank(
          artifactMark,
          query || order !== 'all' ? t('pages.artifacts.noneMatch') : t('pages.artifacts.none'),
          query || order !== 'all'
            ? ''
            : t('pages.artifacts.empty'),
        );
      }
      return `<div class="cards">${list
        .map((file) => {
          const kind = kindOf(file);
          const peek = file.peek || '';
          return `
        <div class="card card--artifact" data-file="${escapeHtml(file.id)}">
          <div class="card__peek ${kind === 'code' || kind === 'page' ? 'card__peek--code' : ''} ${
            peek ? '' : 'card__peek--empty'
          }">${peek ? escapeHtml(peek) : artifactMark}</div>
          <div class="card__foot">
            <span class="card__name">${escapeHtml(file.name)}</span>
            <span class="card__when">${escapeHtml(t('pages.edited', { when: ago(file.created_at) }))}${
              file.chat_title ? ` · ${escapeHtml(file.chat_title)}` : ''
            } · ${escapeHtml(humanSize(file.bytes || 0))}</span>
          </div>
        </div>`;
        })
        .join('')}</div>`;
    },
    wire: () => {
      for (const card of body.querySelectorAll('[data-file]')) {
        card.addEventListener('click', () => openViewer(card.dataset.file));
      }
    },
    onNew: () => {
      onDescribe(t('pages.artifacts.starter'));
      toast(t('pages.artifacts.newHint'));
    },
  };

  /* ── scheduled ────────────────────────────────────────────────── */

  /**
   * Things worth scheduling *in this application*.
   *
   * Not a copy of somebody else's list: every one of these is a prompt the
   * tools here can actually carry out. Offering a calendar briefing to an app
   * with no calendar would look right in a screenshot and do nothing on a
   * Tuesday morning.
   */
  const IDEAS = [
    {
      get name() { return t('pages.idea.briefing.name'); },
      get what() { return t('pages.idea.briefing.what'); },
      get when() { return t('pages.idea.briefing.when'); },
      cron: '08:00',
      get prompt() { return t('pages.idea.briefing.prompt'); },
      mark: '☀',
    },
    {
      get name() { return t('pages.idea.watch.name'); },
      get what() { return t('pages.idea.watch.what'); },
      get when() { return t('pages.idea.watch.when'); },
      cron: '09:00',
      get prompt() { return t('pages.idea.watch.prompt'); },
      mark: '◎',
    },
    {
      get name() { return t('pages.idea.report.name'); },
      get what() { return t('pages.idea.report.what'); },
      get when() { return t('pages.idea.report.when'); },
      cron: 'fri 16:00',
      get prompt() { return t('pages.idea.report.prompt'); },
      mark: '▤',
    },
    {
      get name() { return t('pages.idea.tests.name'); },
      get what() { return t('pages.idea.tests.what'); },
      get when() { return t('pages.idea.tests.when'); },
      cron: '09:00',
      get prompt() { return t('pages.idea.tests.prompt'); },
      mark: '⟨⟩',
    },
  ];

  /** Suggestions as buttons, each `data-idea` its index. Shared with the workflows shelf. */
  function ideasHtml(ideas) {
    return `<div class="ideas">${ideas
      .map(
        (idea, i) => `
        <button class="idea" type="button" data-idea="${i}">
          <span class="idea__mark">${idea.mark}</span>
          <span>
            <span class="idea__name">${escapeHtml(idea.name)}</span>
            <span class="idea__what">${escapeHtml(idea.what)}</span>
            <span class="idea__when">🕘 ${escapeHtml(idea.when)}</span>
          </span>
        </button>`,
      )
      .join('')}</div>`;
  }

  /** The same, under a "Suggested" heading, for below a list that has things in it. */
  const suggestedHtml = (ideas) =>
    `<div class="suggested__label">${escapeHtml(t('pages.suggested'))}</div>${ideasHtml(ideas)}`;

  views.scheduled = {
    get title() {
      return t('pages.tasks.title');
    },
    get newLabel() {
      return t('pages.tasks.new');
    },
    get orderLabel() {
      return t('pages.sortBy');
    },
    lede:
      t('pages.tasks.lede'),
    orders: [
      { id: 'next', get label() { return t('pages.order.next'); } },
      { id: 'name', get label() { return t('pages.order.name'); } },
    ],
    load: async () => (await api.tasks()).tasks,
    matches: (task, q) => `${task.title} ${task.prompt || ''}`.toLowerCase().includes(q),
    sort: (list, by) =>
      [...list].sort((a, b) =>
        by === 'name' ? a.title.localeCompare(b.title) : new Date(a.next_run_at) - new Date(b.next_run_at),
      ),
    newMenu: () => [
      {
        label: t('pages.tasks.describe'),
        icon: '💬',
        run: () => {
          onDescribe(t('pages.tasks.starter'), 'schedule');
          toast(t('pages.tasks.describeHint'));
        },
      },
      { label: t('pages.tasks.manual'), icon: '⚙', run: () => openTaskForm() },
    ],
    render: (list) => {
      const local = state.localOnly
        ? `<div class="notice">
             <span class="notice__say">${escapeHtml(t('pages.tasks.localOnly'))}</span>
           </div>`
        : '';

      if (!list.length) {
        return local + blank(clockMark, t('pages.tasks.none'), '') + '<div class="blank__rule"></div>' + ideasHtml(IDEAS);
      }

      return (
        local +
        list
          .map(
            (task) => `
        <div class="task${task.enabled ? '' : ' task--off'}">
          <span class="task__dot"></span>
          <div class="task__body">
            <div class="task__name">${escapeHtml(task.title)}</div>
            <div class="task__what">${escapeHtml(task.prompt || '')}</div>
            <div class="task__when">
              ${escapeHtml(task.cron ? t('pages.tasks.every').replace('{cron}', task.cron) : t('pages.tasks.once'))}
              · ${
                task.enabled
                  ? escapeHtml(t('pages.tasks.next').replace('{when}', ago(task.next_run_at)))
                  : escapeHtml(t('pages.tasks.paused'))
              }
              ${
                task.last_status
                  ? `· ${escapeHtml(
                      t('pages.tasks.last').replace('{status}', String(task.last_status).slice(0, 40)),
                    )}`
                  : ''
              }
            </div>
          </div>
          ${
            task.last_chat
              ? `<button class="task__act" data-open="${escapeHtml(task.last_chat)}">${escapeHtml(
                  t('pages.tasks.openResult'),
                )}</button>`
              : ''
          }
          <button class="task__act" data-toggle="${escapeHtml(task.id)}" data-on="${!!task.enabled}">${escapeHtml(
            task.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'),
          )}</button>
          <button class="task__act" data-drop="${escapeHtml(task.id)}">${escapeHtml(t('pages.tasks.remove'))}</button>
          <button class="icon-btn task__edit" data-edit="${escapeHtml(task.id)}" type="button"
                  title="${escapeHtml(t('pages.tasks.edit'))}" aria-label="${escapeHtml(t('pages.tasks.edit'))}">✎</button>
        </div>`,
          )
          .join('') +
        // Still offered once there are tasks: having set up one is no reason
        // to stop suggesting the next.
        suggestedHtml(IDEAS)
      );
    },
    wire: (list = []) => {
      for (const button of body.querySelectorAll('[data-idea]')) {
        button.addEventListener('click', () => openTaskForm(IDEAS[Number(button.dataset.idea)]));
      }
      for (const button of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-edit]'))) {
        button.addEventListener('click', () => {
          const task = list.find((x) => x.id === button.dataset.edit);
          if (task) openTaskForm(null, { task });
        });
      }
      for (const button of body.querySelectorAll('[data-open]')) {
        button.addEventListener('click', () => {
          onLeave();
          openChat(button.dataset.open);
        });
      }
      for (const button of body.querySelectorAll('[data-toggle]')) {
        button.addEventListener('click', async () => {
          await api.setTaskEnabled(button.dataset.toggle, button.dataset.on !== 'true');
          load();
        });
      }
      for (const button of body.querySelectorAll('[data-drop]')) {
        armed(button, t('pages.tasks.removeConfirm'), async () => {
          await api.deleteTask(button.dataset.drop);
          load();
        });
      }
    },
    onNew: () => openTaskForm(),
  };

  /* ── workflows ────────────────────────────────────────────────── */

  // The fourth shelf, and the only one whose contents live in their own file:
  // it reuses this shell but is otherwise self-contained, so `pages.js` does not
  // grow another two hundred lines every time a shelf is added.
  const wfForm = workflowForm({
    toast,
    reload: () => (showing === 'workflows' ? load() : null),
  });

  views.workflows = workflowsView({
    blank: (mark, say, note) => blank(mark, say, note),
    ideasHtml,
    suggestedHtml,
    body,
    toast,
    openChat,
    onLeave,
    onDescribe,
    openForm: (id, preset) => wfForm.open(id, preset),
    // Only while the shelf is on screen: Run now may have moved to the conversation.
    reload: () => (showing === 'workflows' ? load() : null),
    onRunStarted,
  });

  /* ── the create-a-task form ───────────────────────────────────── */

  /**
   * The project a task being written belongs to, or null.
   *
   * Held here rather than passed through the save handler because the handler
   * is wired once, at module load, and the form can be opened from two places.
   */
  /** A `<select>`, typed, so reading `.value` is not a new line of type debt. */
  const sel = (id) => /** @type {HTMLSelectElement} */ ($(id));

  let formProject = null;
  /** What to do once a task is saved — the list that is looking at it reloads. */
  let formDone = null;
  /** The task being changed, or null when the form is writing a new one. */
  let formEditing = null;
  /** The frequency the form opened on, so an untouched one is not re-timed. */
  let formFrequency = null;

  /** Which menu entry a stored schedule came from; see `fromFrequency` on the server. */
  const frequencyOf = (cron) => {
    if (!cron) return 'manual';
    if (cron.startsWith('hourly')) return 'hourly';
    if (cron.startsWith('weekdays')) return 'weekdays';
    if (cron.startsWith('monthly')) return 'monthly';
    return /^[a-z]{3}\s/.test(cron) ? 'weekly' : 'daily';
  };

  function openTaskForm(idea = null, { project = null, after = null, task = null } = {}) {
    const sheet = $('task-form');
    formProject = project;
    formDone = after;
    formEditing = task;

    $('task-form-title').textContent = t(task ? 'taskForm.editTitle' : 'taskForm.title');
    $('task-form-name').value = task?.title || idea?.name || '';
    $('task-form-prompt').value = task?.prompt || idea?.prompt || '';
    // An idea from the list comes with a time, which means it means to repeat;
    // a task somebody is writing themselves starts manual, because that is the
    // one choice that cannot surprise them at three in the morning.
    sel('task-form-repeat').value = task ? frequencyOf(task.cron) : idea?.cron ? 'daily' : 'manual';
    formFrequency = sel('task-form-repeat').value;
    sel('task-form-policy').value = task?.policy || 'ask';
    sayFrequency();
    sayPolicy();

    const where = $('task-form-project');
    where.hidden = !project;
    if (project) where.textContent = t('taskForm.inProject').replace('{name}', project.name);

    $('task-form-error').textContent = '';
    sheet.showModal();
    $('task-form-name').focus();
  }

  /**
   * Say what the choice actually means, under the menu.
   *
   * Six words in a dropdown are not self-explanatory — "Hourly" at 09:30 means
   * half past every hour, not on the hour — and a person setting something to
   * run unwatched deserves to know which before they close the dialog.
   */
  function sayFrequency() {
    $('task-form-freq-say').textContent = t(`freq.${sel('task-form-repeat').value}Say`);
  }

  function sayPolicy() {
    const which = { ask: 'Ask', guarded: 'Guarded', auto: 'Skip' }[sel('task-form-policy').value] || 'Ask';
    $('task-form-policy-say').textContent = t(`taskForm.policy${which}Say`);
  }

  $('task-form-repeat').addEventListener('change', sayFrequency);
  $('task-form-policy').addEventListener('change', sayPolicy);

  $('task-form-save').addEventListener('click', async () => {
    const button = $('task-form-save');
    const error = $('task-form-error');
    button.disabled = true;
    try {
      const fields = {
        title: $('task-form-name').value.trim(),
        prompt: $('task-form-prompt').value.trim(),
        frequency: sel('task-form-repeat').value,
        policy: sel('task-form-policy').value,
      };
      if (formEditing) {
        // Choosing a frequency takes today's time of day, so an unchanged one is
        // left out rather than moving the task to whenever it was saved.
        if (fields.frequency === formFrequency) delete fields.frequency;
        await api.updateTask(formEditing.id, fields);
      } else {
        await api.createTask({ ...fields, projectId: formProject?.id || undefined });
      }
      $('task-form').close();
      toast(t(formEditing ? 'pages.tasks.saved' : 'pages.tasks.scheduled'), 'ok');
      // Whoever opened the form says what to refresh. The global list reloads
      // itself; a project page reloads its own Scheduled section.
      if (formDone) await formDone();
      else if (showing === 'scheduled') load();
      onTasksChanged();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  /* ── shared furniture ─────────────────────────────────────────── */

  const blank = (mark, say, note) => `
    <div class="blank">
      <div class="blank__ring">${mark}</div>
      <div class="blank__say">${escapeHtml(say)}</div>
      ${note ? `<p class="hint" style="max-width:46ch">${escapeHtml(note)}</p>` : ''}
    </div>`;

  const clockMark =
    '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="20" cy="22" r="13"/><path d="M20 15v7l4.5 2.8M15 4.5 11 7.5M25 4.5l4 3"/></svg>';
  const folderMark =
    '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 11a3 3 0 0 1 3-3h6.5l3 3.6H32a3 3 0 0 1 3 3V29a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/></svg>';
  const artifactMark =
    '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M23 5H11a3 3 0 0 0-3 3v24a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V14Z"/><path d="M23 5v9h9"/><path d="m16 21-3 3 3 3M24 21l3 3-3 3" stroke-linecap="round"/></svg>';

  /* ── one task, on its own ─────────────────────────────────────── */

  /**
   * One task's facts and buttons, as markup.
   *
   * Drawn in two places: the task's own page, reached from the sidebar, and
   * the rail beside a conversation, reached from the card that set it up. One
   * builder so the two cannot drift. Everything is found inside `root`
   * afterwards rather than by id, because both can be in the document at once.
   */
  function taskDetailHtml(task, project, { withEdit }) {
    return `
      <div class="taskpage">
        <div class="taskpage__head">
          <span class="taskpage__state${task.enabled ? '' : ' is-off'}">${escapeHtml(
            task.enabled ? t('pages.tasks.active') : t('pages.tasks.paused'),
          )}</span>
          <div class="taskpage__acts">
            ${
              withEdit
                ? `<button class="icon-btn" data-task="edit" type="button"
                           title="${escapeHtml(t('pages.tasks.edit'))}"
                           aria-label="${escapeHtml(t('pages.tasks.edit'))}">✎</button>`
                : ''
            }
            <button class="icon-btn" data-task="toggle" type="button"
                    title="${escapeHtml(task.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}"
                    aria-label="${escapeHtml(task.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}">${
                      task.enabled ? '⏸' : '▶'
                    }</button>
            <button class="icon-btn" data-task="drop" type="button"
                    title="${escapeHtml(t('pages.tasks.remove'))}"
                    aria-label="${escapeHtml(t('pages.tasks.remove'))}">🗑</button>
            <button class="btn btn--primary" data-task="run" type="button">${escapeHtml(t('pages.tasks.runNow'))}</button>
          </div>
        </div>

        <dl class="taskpage__facts">
          <dt>${escapeHtml(t('taskForm.prompt'))}</dt>
          <dd class="taskpage__prompt">${escapeHtml(task.prompt || '')}</dd>

          ${
            project
              ? `<dt>${escapeHtml(t('proj.one'))}</dt>
                 <dd><button class="taskpage__project" type="button" data-task="project">${escapeHtml(
                   project.name,
                 )}</button></dd>`
              : ''
          }

          <dt>${escapeHtml(t('pages.tasks.repeats'))}</dt>
          <dd><strong>${escapeHtml(repeatsAs(task))}</strong></dd>

          <dt>${escapeHtml(t('taskForm.permissions'))}</dt>
          <dd>${escapeHtml(policyAs(task.policy))}</dd>

          ${
            task.last_status
              ? `<dt>${escapeHtml(t('pages.tasks.lastRun'))}</dt>
                 <dd>${escapeHtml(String(task.last_status).slice(0, 200))}${
                   task.last_chat
                     ? ` — <button class="taskpage__project" type="button" data-task="chat">${escapeHtml(
                         t('pages.tasks.openResult'),
                       )}</button>`
                     : ''
                 }</dd>`
              : ''
          }
        </dl>
      </div>`;
  }

  /**
   * Draw one task into `root` and wire its buttons.
   *
   * @param redraw  fetch and draw again, after something on it changed
   * @param gone    what to show once the task has been deleted
   */
  function drawTask(root, task, project, { withEdit, redraw, gone }) {
    root.innerHTML = taskDetailHtml(task, project, { withEdit });
    const button = (name) => /** @type {HTMLButtonElement | null} */ (root.querySelector(`[data-task="${name}"]`));

    button('run')?.addEventListener('click', async () => {
      const run = button('run');
      run.disabled = true;
      run.textContent = t('pages.tasks.running');
      /**
       * Into the conversation while it runs, not after.
       *
       * The request is held open for the whole run, so waiting for it meant
       * minutes of a disabled button and then only the finished answer. The
       * run names its conversation as soon as it starts; once it has, go and
       * watch it the way a chat is watched (see `followBackground`). The
       * request carries on regardless — nothing here aborts it.
       */
      let watching = false;
      const peek = setTimeout(async () => {
        const chatId = (await api.task(task.id).catch(() => null))?.task?.last_chat;
        if (!chatId) return;
        watching = true;
        onLeave();
        openChat(chatId);
      }, 1500);
      try {
        const result = await api.runTask(task.id);
        clearTimeout(peek);
        toast(t('pages.tasks.ranNow'), 'ok');
        // Straight into the conversation it wrote: that is the output, and
        // making somebody go looking for it is the whole failure of a run
        // nobody watched. Not again if they are already there — or have
        // moved on from it.
        if (result?.chatId && !watching) {
          onLeave();
          openChat(result.chatId);
          return;
        }
        if (watching) return;
        await redraw();
      } catch (err) {
        clearTimeout(peek);
        toast(err.message, 'error');
        run.disabled = false;
        run.textContent = t('pages.tasks.runNow');
      }
    });

    button('edit')?.addEventListener('click', () => openTaskForm(null, { task, after: redraw }));

    button('toggle')?.addEventListener('click', async () => {
      await api.setTaskEnabled(task.id, !task.enabled);
      onTasksChanged();
      await redraw();
    });

    armed(button('drop'), t('pages.tasks.removeConfirm'), async () => {
      await api.deleteTask(task.id);
      onTasksChanged();
      await gone();
    });

    button('project')?.addEventListener('click', () => {
      onLeave();
      openProject(project.id);
    });
    button('chat')?.addEventListener('click', () => {
      onLeave();
      openChat(task.last_chat);
    });
  }

  /**
   * A scheduled task is a thing that will happen, so it gets a page.
   *
   * The list can only say how often it repeats; this is where the instructions
   * it will follow, the project it answers from, and the button that runs it
   * right now all live. The last of those is the only way a manual task ever
   * runs at all, and the fastest way to find out whether a scheduled one does
   * what you meant without waiting until morning.
   */
  async function showTask(id) {
    const { task, project } = await api.task(id);

    showing = 'scheduled';
    query = '';
    search.value = '';
    searchBox.hidden = true;
    closeMenus();

    page.hidden = false;
    $('thread').hidden = true;
    $('dock').hidden = true;
    page.scrollTop = 0;

    // The shelf's own furniture does not apply to one item: there is nothing
    // to sort, nothing to search, and "New" here would make a second task.
    title.textContent = task.title;
    lede.hidden = true;
    sortPill.hidden = true;
    newButton.hidden = true;
    $('page-search-open').hidden = true;

    drawTask(body, task, project, {
      withEdit: true,
      redraw: () => showTask(id),
      gone: () => showShelf('scheduled'),
    });
  }

  /* ── one task or workflow, in the rail beside the conversation ── */

  /** Every quarter hour of a day, as the time menu lists them. */
  const QUARTERS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);
  /** "09:05" → "9:05", the way a clock face is read. */
  const clockText = (hhmm) => hhmm.replace(/^0(\d)/, '$1');

  /** Zones the browser knows, with the ones already in play first. */
  function zoneList(current) {
    let all = [];
    try {
      all = /** @type {any} */ (Intl).supportedValuesOf?.('timeZone') || [];
    } catch {
      all = [];
    }
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return [...new Set([current, here, ...all].filter(Boolean))];
  }

  const option = (value, label, selected) =>
    `<option value="${escapeHtml(String(value))}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  /**
   * The editor the card's pill opens: everything about when it runs, changed in
   * place and saved as it is changed.
   *
   * The pencil-and-sheet form stays for the whole thing — this is for the
   * adjustment somebody makes while reading the conversation that set it up:
   * seven instead of whenever it was created, weekdays instead of every day,
   * stop at the end of the month. Each control saves on its own, so there is
   * no Save button to forget and nothing lost by closing the rail.
   */
  function scheduleEditorHtml(kind, row, project) {
    const parts = cronParts(row.cron);
    const isTask = kind === 'task';
    const times = QUARTERS.includes(parts.time) ? QUARTERS : [...QUARTERS, parts.time].sort();
    const next = row.next_run_at
      ? new Date(row.next_run_at).toLocaleString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          ...(row.tz ? { timeZone: row.tz } : {}),
        })
      : t('pane.noNext');
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const stepText = (s) => (typeof s === 'string' ? s : s?.instruction ?? s?.prompt ?? '');

    return `
      <div class="spane">
        <div class="spane__top">
          <span class="spane__kicker">${escapeHtml(t('pane.activity'))}</span>
          <span class="taskpage__state${row.enabled ? '' : ' is-off'}">${escapeHtml(
            row.enabled ? t('pages.tasks.active') : t('pages.tasks.paused'),
          )}</span>
          <div class="spane__acts">
            <button class="icon-btn" data-s="toggle" type="button"
                    title="${escapeHtml(row.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}"
                    aria-label="${escapeHtml(row.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}">${
                      row.enabled ? '⏸' : '▶'
                    }</button>
            <button class="icon-btn" data-s="drop" type="button"
                    title="${escapeHtml(t('pages.tasks.remove'))}"
                    aria-label="${escapeHtml(t('pages.tasks.remove'))}">🗑</button>
            <button class="btn btn--primary" data-s="run" type="button">${escapeHtml(t('pages.tasks.runNow'))}</button>
          </div>
        </div>

        <input class="spane__title" data-s="title" type="text" maxlength="200"
               aria-label="${escapeHtml(t('sched.name'))}" value="${escapeHtml(row.title || '')}">

        ${
          isTask
            ? `<textarea class="spane__prompt" data-s="prompt" rows="5"
                         aria-label="${escapeHtml(t('taskForm.prompt'))}">${escapeHtml(row.prompt || '')}</textarea>`
            : `<div class="spane__steps">
                 <ol>${steps.map((s) => `<li>${escapeHtml(stepText(s))}</li>`).join('')}</ol>
                 <button class="btn btn--ghost" data-s="steps" type="button">${escapeHtml(t('pane.editSteps'))}</button>
               </div>`
        }

        <div class="spane__label">${escapeHtml(t('pane.details'))}</div>
        <div class="spane__group">
          <div class="spane__row">
            <span>${escapeHtml(t('pane.runsOn'))}</span>
            <span class="spane__value">${state.localOnly ? '🖥' : '☁'} ${escapeHtml(t(state.localOnly ? 'pane.thisComputer' : 'pane.cloud'))}</span>
          </div>
          ${
            isTask
              ? `<label class="spane__row">
                   <span>${escapeHtml(t('taskForm.permissions'))}</span>
                   <select data-s="policy">
                     ${option('ask', t('taskForm.policyAsk'), (row.policy || 'ask') === 'ask')}
                     ${option('guarded', t('taskForm.policyGuarded'), row.policy === 'guarded')}
                     ${option('auto', t('taskForm.policySkip'), row.policy === 'auto')}
                   </select>
                 </label>`
              : ''
          }
          ${
            project
              ? `<div class="spane__row"><span>${escapeHtml(t('proj.one'))}</span>
                   <button class="taskpage__project" type="button" data-s="project">${escapeHtml(project.name)}</button></div>`
              : ''
          }
        </div>

        <div class="spane__label">${escapeHtml(t('pane.frequency'))}</div>
        <div class="spane__group">
          <label class="spane__row">
            <span>${escapeHtml(t('pane.repeat'))}</span>
            <select data-s="frequency">
              ${['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly']
                .map((f) => option(f, t(`freq.${f}`), parts.frequency === f))
                .join('')}
            </select>
          </label>
          <label class="spane__row" data-when="hourly">
            <span>${escapeHtml(t('pane.minute'))}</span>
            <select data-s="minute">
              ${Array.from({ length: 12 }, (_, i) => i * 5)
                .concat(parts.minute % 5 ? [parts.minute] : [])
                .sort((a, b) => a - b)
                .map((m) => option(m, `:${String(m).padStart(2, '0')}`, parts.minute === m))
                .join('')}
            </select>
          </label>
          <label class="spane__row" data-when="weekly">
            <span>${escapeHtml(t('pane.weekday'))}</span>
            <select data-s="weekday">
              ${days.map((d) => option(d, t(`day.${d}`), parts.weekday === d)).join('')}
            </select>
          </label>
          <label class="spane__row" data-when="monthly">
            <span>${escapeHtml(t('pane.dayOfMonth'))}</span>
            <select data-s="day">
              ${Array.from({ length: 31 }, (_, i) => i + 1)
                .map((d) => option(d, String(d), parts.day === d))
                .join('')}
            </select>
          </label>
          <label class="spane__row" data-when="daily weekdays weekly monthly">
            <span>${escapeHtml(t('pane.time'))}</span>
            <select data-s="time">
              ${times.map((hhmm) => option(hhmm, clockText(hhmm), parts.time === hhmm)).join('')}
            </select>
          </label>
          <label class="spane__row" data-when="hourly daily weekdays weekly monthly">
            <span>${escapeHtml(t('sched.timezone'))}</span>
            <select data-s="tz">
              ${zoneList(row.tz).map((z) => option(z, z, z === (row.tz || zoneList(null)[0]))).join('')}
            </select>
          </label>
        </div>

        <div class="spane__group" data-when="hourly daily weekdays weekly monthly">
          <label class="spane__row">
            <span>${escapeHtml(t('pane.ends'))}</span>
            <select data-s="ends">
              ${option('never', t('pane.never'), !row.ends_on)}
              ${option('date', t('pane.onDate'), !!row.ends_on)}
            </select>
          </label>
          <label class="spane__row" data-s-show="ends">
            <span>${escapeHtml(t('pane.endDate'))}</span>
            <input type="date" data-s="endsOn" value="${escapeHtml(row.ends_on || '')}">
          </label>
        </div>

        <div class="spane__meta">
          <div><span>${escapeHtml(t('pane.nextRun'))}</span> <strong data-s="next">${escapeHtml(next)}</strong></div>
          ${
            (isTask ? row.last_status : null)
              ? `<div><span>${escapeHtml(t('pages.tasks.lastRun'))}</span> ${escapeHtml(String(row.last_status).slice(0, 200))}</div>`
              : ''
          }
          ${
            row.last_chat || row.lastChat
              ? `<button class="taskpage__project" type="button" data-s="chat">${escapeHtml(t('pages.tasks.openResult'))}</button>`
              : ''
          }
          <div class="spane__status" data-s="status" role="status" aria-live="polite"></div>
        </div>
      </div>`;
  }

  async function fetchSchedule(kind, id) {
    if (kind === 'workflow') {
      const { workflow, runs } = await api.workflow(id);
      return { row: { ...workflow, lastChat: runs?.[0]?.chat_id || null }, project: null };
    }
    const { task, project } = await api.task(id);
    return { row: task, project };
  }

  /**
   * The card in the transcript as the row now is. The card is what somebody
   * reads first; after changing the time beside it, it must not go on saying
   * the old one.
   */
  function refreshCards(kind, row) {
    const cards = [...document.querySelectorAll('.schedcard')].filter(
      (node) => /** @type {HTMLElement} */ (node).dataset.scheduleKind === kind && /** @type {HTMLElement} */ (node).dataset.scheduleId === row.id,
    );
    for (const card of cards) {
      card.replaceWith(
        scheduleCard({
          kind,
          id: row.id,
          title: row.title,
          cron: row.cron || null,
          nextRunAt: row.next_run_at || null,
          tz: row.tz || null,
          enabled: row.enabled !== false,
          steps: Array.isArray(row.steps) ? row.steps.length : undefined,
          endsOn: row.ends_on || null,
          prompt: kind === 'task' ? String(row.prompt || '').slice(0, 600) : undefined,
          stepList:
            kind === 'workflow' && Array.isArray(row.steps)
              ? row.steps.slice(0, 8).map((s) => String(typeof s === 'string' ? s : s?.instruction ?? s?.prompt ?? '').slice(0, 160))
              : undefined,
          existing: card.classList.contains('schedcard--existing'),
        }),
      );
    }
  }

  async function showScheduleInPane(kind, id) {
    const { row, project } = await fetchSchedule(kind, id);
    const pane = $('taskpane');
    const root = $('taskpane-body');
    $('taskpane-title').textContent = row.title;
    // The pencil opens the whole form — the steps of a workflow, or a task's
    // every field at once — the same one the shelves use.
    $('taskpane-edit').onclick = () =>
      kind === 'workflow'
        ? editWorkflowFromPane(id)
        : openTaskForm(null, { task: row, after: () => showScheduleInPane(kind, id) });
    root.innerHTML = scheduleEditorHtml(kind, row, project);
    wireScheduleEditor(root, kind, row, project);
    refreshCards(kind, row);
    pane.hidden = false;
    onPaneOpen();
  }

  function wireScheduleEditor(root, kind, row, project) {
    const q = (name) => /** @type {HTMLInputElement} */ (root.querySelector(`[data-s="${name}"]`));
    const status = q('status');
    const update = (patch) => (kind === 'workflow' ? api.updateWorkflow(row.id, patch) : api.updateTask(row.id, patch));

    /** Show only the rows the chosen frequency uses. */
    const layout = () => {
      const f = q('frequency').value;
      for (const node of root.querySelectorAll('[data-when]')) {
        /** @type {HTMLElement} */ (node).hidden = !String(/** @type {HTMLElement} */ (node).dataset.when).split(' ').includes(f);
      }
      /** @type {HTMLElement} */ (root.querySelector('[data-s-show="ends"]')).hidden = q('ends').value !== 'date' || f === 'manual';
    };
    layout();

    const save = async (patch) => {
      status.textContent = t('pane.saving');
      status.classList.remove('is-error', 'is-ok');
      try {
        const result = await update(patch);
        const fresh = result.task || result.workflow;
        Object.assign(row, fresh);
        $('taskpane-title').textContent = row.title;
        q('next').textContent = row.next_run_at
          ? new Date(row.next_run_at).toLocaleString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              ...(row.tz ? { timeZone: row.tz } : {}),
            })
          : t('pane.noNext');
        status.textContent = t('pane.saved');
        status.classList.add('is-ok');
        refreshCards(kind, row);
        onTasksChanged();
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
      }
    };

    const saveSchedule = () =>
      save({
        schedule: {
          frequency: q('frequency').value,
          time: q('time').value,
          minute: Number(q('minute').value),
          weekday: q('weekday').value,
          day: Number(q('day').value),
        },
        tz: q('tz').value,
      });

    q('frequency').addEventListener('change', () => {
      layout();
      saveSchedule();
    });
    for (const name of ['time', 'minute', 'weekday', 'day', 'tz']) q(name).addEventListener('change', saveSchedule);

    q('ends').addEventListener('change', () => {
      layout();
      if (q('ends').value === 'never') save({ endsOn: null });
      else q('endsOn').focus();
    });
    q('endsOn').addEventListener('change', () => {
      if (q('endsOn').value) save({ endsOn: q('endsOn').value });
    });

    q('title').addEventListener('change', () => {
      const title = q('title').value.trim();
      if (title && title !== row.title) save({ title });
    });
    q('prompt')?.addEventListener('change', () => {
      const prompt = q('prompt').value.trim();
      if (prompt && prompt !== row.prompt) save({ prompt });
    });
    q('policy')?.addEventListener('change', () => save({ policy: q('policy').value }));
    q('steps')?.addEventListener('click', () => editWorkflowFromPane(row.id));

    q('toggle').addEventListener('click', async () => {
      if (kind === 'workflow') await api.updateWorkflow(row.id, { enabled: !row.enabled });
      else await api.setTaskEnabled(row.id, !row.enabled);
      onTasksChanged();
      await showScheduleInPane(kind, row.id);
    });

    armed(q('drop'), t('pages.tasks.removeConfirm'), async () => {
      if (kind === 'workflow') await api.deleteWorkflow(row.id);
      else await api.deleteTask(row.id);
      onTasksChanged();
      closeTaskPane();
    });

    q('project')?.addEventListener('click', () => {
      onLeave();
      openProject(project.id);
    });
    q('chat')?.addEventListener('click', () => {
      onLeave();
      openChat(row.last_chat || row.lastChat);
    });

    q('run').addEventListener('click', async () => {
      const run = q('run');
      run.disabled = true;
      run.textContent = t('pages.tasks.running');
      // Into the conversation as soon as the run names one, the way the
      // shelves do it: the request is held open for the whole run.
      let watching = false;
      const peek = setTimeout(async () => {
        const fresh = await fetchSchedule(kind, row.id).catch(() => null);
        const chatId = fresh?.row.last_chat || fresh?.row.lastChat;
        if (!chatId) return;
        watching = true;
        onLeave();
        openChat(chatId);
      }, 1500);
      try {
        const result = kind === 'workflow' ? await api.runWorkflow(row.id) : await api.runTask(row.id);
        clearTimeout(peek);
        toast(t('pages.tasks.ranNow'), 'ok');
        const chatId = result?.chatId || result?.run?.chat_id;
        if (chatId && !watching) {
          onLeave();
          openChat(chatId);
        }
      } catch (err) {
        clearTimeout(peek);
        toast(err.message, 'error');
      } finally {
        run.disabled = false;
        run.textContent = t('pages.tasks.runNow');
      }
    });
  }

  /** The workflow form, over its shelf — the rail cannot hold a step editor. */
  function editWorkflowFromPane(id) {
    closeTaskPane();
    onShowPage();
    showShelf('workflows');
    return wfForm.open(id);
  }

  /** A task in the rail — kept by name for the callers that only have tasks. */
  const showTaskInPane = (id) => showScheduleInPane('task', id);

  function closeTaskPane() {
    $('taskpane').hidden = true;
    $('taskpane-body').innerHTML = '';
    onPaneClose();
  }

  $('taskpane-close').addEventListener('click', closeTaskPane);

  /** What a task's permission setting means, in the words the form used. */
  function policyAs(policy) {
    if (policy === 'auto') return t('taskForm.policySkip');
    if (policy === 'guarded') return t('taskForm.policyGuarded');
    if (policy === 'ask') return t('taskForm.policyAsk');
    return t('taskForm.policyDefault');
  }

  /* ── the way in ───────────────────────────────────────────────── */

  const state = { localOnly: false };

  /**
   * A named function rather than only a method, because the detail page above
   * has to come back here after deleting the task it was showing.
   */
  async function showShelf(which) {
    if (!views[which]) return;
    // A shelf may have left something running — a poll, a timer. Switching
    // between shelves has to end it, or it outlives the page it belongs to.
    if (showing && showing !== which) views[showing]?.onHide?.();
    showing = which;
    query = '';
    order = views[which].orders?.[0]?.id || 'all';
    search.value = '';
    searchBox.hidden = true;
    $('page-search-open').hidden = false;
    search.placeholder = t('pages.searchNamed', { name: views[which].title.toLowerCase() });
    closeMenus();

    page.hidden = false;
    $('thread').hidden = true;
    $('dock').hidden = true;
    page.scrollTop = 0;

    // Restored, because `showTask` hides them for a page that has one item.
    newButton.hidden = false;
    $('page-search-open').hidden = false;
    renderTools();
    await load();
  }

  return {
    /** Called once at boot so the notice can say where tasks actually run. */
    configure({ localMachine }) {
      state.localOnly = !!localMachine;
    },

    show: showShelf,

    /** Back to the conversation. */
    hide() {
      if (showing) views[showing]?.onHide?.();
      showing = null;
      page.hidden = true;
      $('thread').hidden = false;
      $('dock').hidden = false;
      closeMenus();
    },

    showing: () => showing,
    /** Reload the shelf on screen, if it is one of these. */
    refresh: () => (showing ? load() : null),

    /**
     * Write a scheduled task from somewhere else — a project page, today.
     *
     * Exposed rather than copied, because the form is the decision: what a
     * frequency means, which permissions a run may have, what each one does at
     * 3am. A second copy of that on the project page would drift from this one,
     * and the half that drifts is the half nobody is looking at.
     */
    newTask: (options) => openTaskForm(null, options),

    /** One scheduled task, on its own page. */
    showTask,

    /** One scheduled task, in the rail beside the conversation. */
    showTaskInPane,
    /** A task or a workflow in the rail, as the editor its card's pill opens. */
    showScheduleInPane,
    closeTaskPane,
    /** Whether the rail is showing a task — the file viewer asks before taking it. */
    taskPaneOpen: () => !$('taskpane').hidden,

    /**
     * One workflow, opened to change — from a schedule card in a transcript.
     *
     * The shelf first, so closing the form leaves somebody among their
     * workflows rather than back in a conversation with a sheet gone from it.
     */
    async editWorkflow(id) {
      showShelf('workflows');
      await wfForm.open(id);
    },
  };
}
