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
import { WEEK, LIMITS } from './schedule-grammar.js';
import { latestWins } from './serial.js';

/** How long the Repeat menu must sit on a choice before it is saved (UX-005). */
const FREQUENCY_SETTLE_MS = 700;

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
  /** A conversation was restored or deleted from the Archive; the sidebar redraws. */
  onChatsChanged = () => {},
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
    // A shelf that makes nothing — the Archive — has no New button at all.
    newButton.hidden = !view.newLabel;

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
    body.innerHTML = (view.cloud ? cloudNoticeHtml() : '') + view.render(view.sort ? view.sort(shown, order) : shown);
    view.wire?.(items);
  }

  /** The last answer from /api/heartbeat, for the shelves whose work runs on a clock. */
  let heartbeat = null;

  /**
   * Whether this work will run with the web closed, said where it is set up.
   *
   * A deployment only works when something calls it. Without an outside pinger
   * a job set for 08:00 ran when somebody next opened the app — or once a day
   * at Vercel's own cron — and nothing on screen said so.
   */
  function cloudNoticeHtml() {
    // Said only when something needs doing: all being well is not news.
    if (!heartbeat || !heartbeat.serverless || state.localOnly || heartbeat.healthy) return '';
    const steps = [
      t('pages.cloud.step1'),
      t('pages.cloud.step2', { url: heartbeat.endpoint }),
      t('pages.cloud.step3'),
      t('pages.cloud.step4'),
    ];
    return `<div class="notice notice--warn">
      <span class="notice__say"><strong>${escapeHtml(t('pages.cloud.offTitle'))}</strong>
        ${escapeHtml(heartbeat.lastAt ? t('pages.cloud.offLast', { when: ago(heartbeat.lastAt) }) : t('pages.cloud.offNever'))}</span>
      <ol class="notice__steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
    </div>`;
  }

  async function load() {
    const view = views[showing];
    body.innerHTML = `<div class="viewer__loading"><span class="spinner"></span> ${escapeHtml(t('common.loading'))}</div>`;
    try {
      const [loaded, beat] = await Promise.all([view.load(), view.cloud ? api.heartbeat().catch(() => null) : null]);
      items = loaded;
      if (view.cloud) heartbeat = beat;
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
    // Runs on a clock: the shelf says whether that clock is ticking in the cloud.
    cloud: true,
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
              ${escapeHtml(repeatsAs(task))}
              ${
                !task.enabled
                  ? `· ${escapeHtml(t('pages.tasks.paused'))}`
                  : task.next_run_at
                    ? `· ${escapeHtml(t('pages.tasks.next').replace('{when}', ago(task.next_run_at)))}`
                    : ''
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
          // Edited in the panel beside the list, where every field is changed in
          // place — the same editor a card in a conversation opens.
          if (task) showScheduleInPane('task', task.id, { after: load });
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

  /* ── archive ──────────────────────────────────────────────────── */

  /**
   * Everything put away with Archive, and the way back.
   *
   * "Archived. It is out of the list, not deleted" was a promise with nowhere
   * to keep it: archived conversations were listed nowhere, so the only route
   * back was a link nobody had. This shelf lists them — conversations first,
   * archived projects behind the filter — with Restore beside each, and opening
   * one reads it without restoring it.
   */
  views.archive = {
    get title() {
      return t('pages.archive.title');
    },
    // No "New": nothing is made here, only put back.
    newLabel: '',
    get lede() {
      return escapeHtml(t('pages.archive.lede'));
    },
    get orderLabel() {
      return t('pages.filterBy');
    },
    get orders() {
      return [
        { id: 'chat', label: t('pages.archive.chats'), pill: t('pages.archive.chats') },
        { id: 'project', label: t('pages.archive.projects'), pill: t('pages.archive.projects') },
      ];
    },
    load: async () => {
      const { chats = [], projects = [] } = await api.archived();
      return [
        ...chats.map((chat) => ({ ...chat, kind: 'chat' })),
        ...projects.map((project) => ({ ...project, kind: 'project', title: project.name })),
      ];
    },
    matches: (item, q) => `${item.title || ''} ${item.project_name || ''}`.toLowerCase().includes(q),
    // Newest put away first, whichever kind is showing.
    sort: (list, by) =>
      list
        .filter((item) => item.kind === by)
        .sort((a, b) => new Date(b.archived_at || 0).getTime() - new Date(a.archived_at || 0).getTime()),
    render: (list) => {
      if (!list.length) {
        return blank(
          archiveMark,
          query ? t('pages.archive.noneMatch') : order === 'project' ? t('pages.projects.archivedNone') : t('pages.archive.none'),
          query ? '' : t('pages.archive.noneHint'),
        );
      }
      return list
        .map((item) => {
          const facts = [
            t('pages.archive.when', { when: ago(item.archived_at) }),
            item.kind === 'chat' && item.project_name ? `📁 ${item.project_name}` : '',
            item.kind === 'chat' ? counted(item.message_count || 0, 'count.messages') : counted(item.chat_count || 0, 'count.conversations'),
          ].filter(Boolean);
          const id = escapeHtml(item.id);
          return `
        <div class="task archived" data-archived="${id}" data-kind="${item.kind}" data-open-archived="${id}">
          <div class="task__main" role="button" tabindex="0" aria-label="${escapeHtml(t('pages.archive.open', { name: item.title || t('chat.untitled') }))}">
            <span class="task__dot"></span>
            <div class="task__body">
              <span class="task__name">${escapeHtml(item.title || t('chat.untitled'))}</span>
              <div class="task__when">${facts.map(escapeHtml).join(' · ')}</div>
            </div>
          </div>
          <button class="task__act" type="button" data-restore="${id}">${escapeHtml(t('pages.archive.restore'))}</button>
          ${
            item.kind === 'chat'
              ? `<button class="task__act" type="button" data-drop-archived="${id}">${escapeHtml(t('pages.archive.delete'))}</button>`
              : ''
          }
        </div>`;
        })
        .join('');
    },
    wire: () => {
      const byId = new Map(items.map((item) => [item.id, item]));
      // The whole card opens it — read where it is; opening is not restoring.
      // Its own buttons do their own thing and are not a press on the card.
      for (const card of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-open-archived]'))) {
        const open = () => {
          const item = byId.get(card.dataset.openArchived);
          if (!item) return;
          onLeave();
          if (item.kind === 'project') openProject(item.id);
          else openChat(item.id);
        };
        card.addEventListener('click', (event) => {
          if (/** @type {HTMLElement} */ (event.target).closest('button')) return;
          open();
        });
        /*
         * The keyboard's way in is the dot-and-title area, a button of its own
         * beside Restore and Delete rather than around them (ACC-010). A
         * `role="button"` wrapping other buttons makes them presentational, so
         * screen readers flattened or hid the two actions on every row.
         */
        /** @type {HTMLElement|null} */ (card.querySelector('.task__main'))?.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        });
      }
      for (const button of /** @type {NodeListOf<HTMLButtonElement>} */ (body.querySelectorAll('[data-restore]'))) {
        button.addEventListener('click', async () => {
          const item = byId.get(button.dataset.restore);
          if (!item) return;
          button.disabled = true;
          try {
            if (item.kind === 'project') await api.updateProject(item.id, { archived: false });
            else await api.updateChat(item.id, { archived: false });
            toast(t('pages.archive.restored', { name: item.title || t('chat.untitled') }), 'ok');
            onChatsChanged();
            await load();
          } catch (err) {
            button.disabled = false;
            toast(err.message, 'error');
          }
        });
      }
      for (const button of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('[data-drop-archived]'))) {
        armed(button, t('pages.archive.deleteConfirm'), async () => {
          await api.deleteChat(button.dataset.dropArchived);
          onChatsChanged();
          await load();
        });
      }
    },
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
    openForm: (preset) => wfForm.open(preset),
    openPane: (id) => showScheduleInPane('workflow', id, { after: load }),
    // Only while the shelf is on screen: Run now may have moved to the conversation.
    reload: () => (showing === 'workflows' ? load() : null),
    onRunStarted,
  });
  views.workflows.cloud = true;

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

  /**
   * The form that writes a new task. Changing one is the side panel's job —
   * `showScheduleInPane` — where every field is edited in place.
   */
  function openTaskForm(idea = null, { project = null, after = null } = {}) {
    const sheet = $('task-form');
    formProject = project;
    formDone = after;

    $('task-form-title').textContent = t('taskForm.title');
    $('task-form-name').value = idea?.name || '';
    $('task-form-prompt').value = idea?.prompt || '';
    // An idea from the list comes with a time, which means it means to repeat;
    // a task somebody is writing themselves starts manual, because that is the
    // one choice that cannot surprise them at three in the morning.
    sel('task-form-repeat').value = idea?.cron ? 'daily' : 'manual';
    sel('task-form-policy').value = 'ask';
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
      await api.createTask({ ...fields, projectId: formProject?.id || undefined });
      $('task-form').close();
      toast(t('pages.tasks.scheduled'), 'ok');
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
  const archiveMark =
    '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="6" y="8" width="28" height="8" rx="2"/><path d="M8.5 16v14a3 3 0 0 0 3 3h17a3 3 0 0 0 3-3V16"/><path d="M16.5 22.5h7" stroke-linecap="round"/></svg>';
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

    button('edit')?.addEventListener('click', () => showScheduleInPane('task', task.id, { after: redraw }));

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

  /** When a row runs next, in its own zone, or that it only runs when pressed. */
  const nextText = (row) =>
    row.next_run_at
      ? new Date(row.next_run_at).toLocaleString(undefined, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          ...(row.tz ? { timeZone: row.tz } : {}),
        })
      : t('pane.noNext');

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
    const FREQS = ['manual', 'once', 'minutes', 'hourly', 'hours', 'daily', 'weekdays', 'weekly', 'days', 'monthly'];
    // No schedule words and a next run is a one-off; neither is manual.
    const freq = row.cron ? parts.frequency : row.next_run_at ? 'once' : 'manual';
    const manual = freq === 'manual';
    const zone = zoneList(row.tz)[0];
    const inZone = (date, opts) => {
      try {
        return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: zone }).format(date);
      } catch {
        return new Intl.DateTimeFormat('en-CA', opts).format(date);
      }
    };
    const today = inZone(new Date(), {});
    const onceAt = freq === 'once' ? new Date(row.next_run_at) : new Date(Date.now() + 86_400_000);
    const onceDate = inZone(onceAt, {});
    if (freq === 'once') parts.time = inZone(onceAt, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    /*
     * One state, said once, beside the buttons that change it. It used to be a
     * label ("Activity") and a badge ("On") that read as two things; and a manual
     * task said "On" while never running by itself, which is what it is for.
     */
    const stateLabel = !row.enabled ? t('pages.tasks.paused') : manual ? t('pane.stateManual') : t('pages.tasks.active');
    const stateClass = !row.enabled ? ' is-off' : manual ? ' is-manual' : '';
    const next = nextText(row);
    const num = (name, value, { min, max }, label, unit, when) => `
          <label class="spane__row" data-when="${when}">
            <span>${escapeHtml(label)}</span>
            <span class="spane__num"><input type="number" data-s="${name}" min="${min}" max="${max}" step="1" inputmode="numeric"
                   value="${escapeHtml(String(value))}">${unit ? `<span>${escapeHtml(unit)}</span>` : ''}</span>
          </label>`;
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const stepText = (s) => (typeof s === 'string' ? s : s?.instruction ?? s?.prompt ?? '');

    return `
      <div class="spane">
        <div class="spane__top">
          <span class="spane__state${stateClass}">${escapeHtml(stateLabel)}</span>
          <div class="spane__acts">
            ${
              manual
                ? ''
                : `<button class="icon-btn" data-s="toggle" type="button"
                    title="${escapeHtml(row.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}"
                    aria-label="${escapeHtml(row.enabled ? t('pages.tasks.pause') : t('pages.tasks.resume'))}">${
                      row.enabled ? '⏸' : '▶'
                    }</button>`
            }
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
            : // The steps are changed here, one per line, like a task's instructions —
              // not in a sheet over the page.
              `<textarea class="spane__prompt" data-s="steps" rows="8"
                         aria-label="${escapeHtml(t('wf.stepsLabel'))}">${escapeHtml(steps.map(stepText).join('\n'))}</textarea>
               <p class="hint">${escapeHtml(t('pane.stepsHint'))}</p>`
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
        <div class="spane__group" data-s-group="when">
          <label class="spane__row">
            <span>${escapeHtml(t('pane.repeat'))}</span>
            <select data-s="frequency">
              ${FREQS.map((f) => option(f, t(`freq.${f}`), freq === f)).join('')}
            </select>
          </label>
          <label class="spane__row" data-when="once">
            <span>${escapeHtml(t('pane.date'))}</span>
            <input type="date" data-s="date" value="${escapeHtml(onceDate)}">
          </label>
          <label class="spane__row" data-when="once">
            <span>${escapeHtml(t('pane.time'))}</span>
            <input type="time" data-s="onceTime" value="${escapeHtml(parts.time)}">
          </label>
          ${num('everyMinutes', freq === 'minutes' ? parts.every : 30, LIMITS.minutes, t('pane.every'), t('pane.unitMinutes'), 'minutes')}
          ${num('everyHours', freq === 'hours' ? parts.every : 2, LIMITS.hours, t('pane.every'), t('pane.unitHours'), 'hours')}
          ${num('everyDays', freq === 'days' ? parts.every : 2, LIMITS.days, t('pane.every'), t('pane.unitDays'), 'days')}
          ${num('minute', parts.minute, { min: 0, max: 59 }, t('pane.minute'), '', 'hourly hours')}
          <div class="spane__row spane__row--stack" data-when="weekly">
            <span>${escapeHtml(t('pane.weekdays'))}</span>
            <div class="spane__chips" role="group" aria-label="${escapeHtml(t('pane.weekdays'))}">
              ${WEEK.map(
                (d) => `<button type="button" class="spane__chip" data-day="${d}" aria-pressed="${parts.days.includes(d)}"
                          title="${escapeHtml(t(`day.${d}`))}">${escapeHtml(t(`day.short.${d}`))}</button>`,
              ).join('')}
            </div>
          </div>
          <div class="spane__row spane__row--stack" data-when="monthly">
            <span>${escapeHtml(t('pane.monthDays'))}</span>
            <div class="spane__chips spane__chips--month" role="group" aria-label="${escapeHtml(t('pane.monthDays'))}">
              ${/** @type {Array<number|'last'>} */ ([...Array.from({ length: 31 }, (_, i) => i + 1), 'last'])
                .map(
                  (d) => `<button type="button" class="spane__chip${d === 'last' ? ' spane__chip--wide' : ''}" data-mday="${d}"
                            aria-pressed="${parts.monthDays.includes(d)}">${escapeHtml(d === 'last' ? t('freq.lastDay') : String(d))}</button>`,
                )
                .join('')}
            </div>
          </div>
          <label class="spane__row" data-when="days">
            <span>${escapeHtml(t('pane.startOn'))}</span>
            <input type="date" data-s="start" value="${escapeHtml(parts.start || today)}">
          </label>
          <div class="spane__row spane__row--stack" data-when="daily weekdays weekly monthly days">
            <span>${escapeHtml(t(freq === 'days' ? 'pane.time' : 'pane.times'))}</span>
            <div class="spane__times">
              ${parts.times
                .map(
                  (hhmm) => `<span class="spane__timeitem"><input type="time" data-t value="${escapeHtml(hhmm)}" aria-label="${escapeHtml(t('pane.time'))}">
                    <button type="button" class="spane__x" data-drop-time aria-label="${escapeHtml(t('pane.removeTime'))}"${parts.times.length < 2 ? ' hidden' : ''}>✕</button></span>`,
                )
                .join('')}
              <button type="button" class="spane__add" data-add-time${freq === 'days' ? ' hidden' : ''}>${escapeHtml(t('pane.addTime'))}</button>
            </div>
          </div>
          <label class="spane__row" data-when="once minutes hourly hours daily weekdays weekly days monthly">
            <span>${escapeHtml(t('sched.timezone'))}</span>
            <select data-s="tz">
              ${zoneList(row.tz).map((z) => option(z, z, z === (row.tz || zoneList(null)[0]))).join('')}
            </select>
          </label>
          <p class="hint spane__hint" data-when="minutes hours">${escapeHtml(t('pane.intervalHint'))}</p>
        </div>

        <div class="spane__group" data-when="minutes hourly hours daily weekdays weekly days monthly">
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

  /** What opened the panel wants redrawn after a change there, if anything. */
  let paneAfter = null;

  /**
   * A Repeat choice still sitting out its pause (UX-005), saved now — before the
   * panel it was made in is redrawn or closed (UX-010). The save reads the
   * panel's own fields, so once they are gone a choice made a moment before
   * moving on was lost without a word.
   */
  let settlePending = null;

  /**
   * Saves sent from the panel and not answered yet (UX-013). A save already on
   * its way when the panel moves on is waited for as well as one still in its
   * pause: the pause ends by sending, so the save was only out of sight.
   *
   * @type {Set<Promise<unknown>>}
   */
  const landing = new Set();
  /**
   * @template T
   * @param {Promise<T>} request
   * @returns {Promise<T>}
   */
  function sent(request) {
    landing.add(request);
    const done = () => landing.delete(request);
    request.then(done, done);
    return request;
  }

  function flushSettling() {
    const save = settlePending;
    settlePending = null;
    // A failure says itself: in the panel's status while it is on screen, in a
    // toast once it is not (see `save`). Nothing here throws on to the caller.
    const started = save ? Promise.resolve(save()).catch(() => false) : null;
    return Promise.all([started, ...[...landing].map((request) => request.catch(() => false))]);
  }

  /** Counted on every open and close, so that only the latest one draws (UX-013). */
  let paneTurn = 0;

  async function showScheduleInPane(kind, id, { after = null } = {}) {
    const turn = ++paneTurn;
    // Waited for (UX-012): opening the same schedule again within the pause
    // fetched it before the save had landed, drew the old Repeat, and the next
    // edit there wrote that old value back over the choice just saved.
    await flushSettling();
    const { row, project } = await fetchSchedule(kind, id);
    // Another schedule opened, or the panel closed, while this one waited:
    // that is where the person went, and this is not drawn over it.
    if (turn !== paneTurn) return;
    paneAfter = after;
    const pane = $('taskpane');
    $('taskpane-title').textContent = row.title;
    // No pencil in the header: every field below is edited in place, and a
    // workflow's steps have their own button inside.
    //
    // Drawn into an element of its own each time, not straight into the shared
    // panel body (UX-011). A save still in flight when the panel moves on reads
    // its fields from here — detached, but with the values this schedule had —
    // instead of from whatever the body holds by then, which is how one
    // schedule's settings could be saved into another.
    const view = document.createElement('div');
    view.innerHTML = scheduleEditorHtml(kind, row, project);
    $('taskpane-body').replaceChildren(view);
    wireScheduleEditor(view, kind, row, project);
    refreshCards(kind, row);
    pane.hidden = false;
    onPaneOpen();
  }

  function wireScheduleEditor(root, kind, row, project) {
    const q = (name) => /** @type {HTMLInputElement} */ (root.querySelector(`[data-s="${name}"]`));
    const status = q('status');
    const update = (patch) => sent(kind === 'workflow' ? api.updateWorkflow(row.id, patch) : api.updateTask(row.id, patch));

    /** Show only the rows the chosen frequency uses. */
    const layout = () => {
      const f = q('frequency').value;
      for (const node of root.querySelectorAll('[data-when]')) {
        /** @type {HTMLElement} */ (node).hidden = !String(/** @type {HTMLElement} */ (node).dataset.when).split(' ').includes(f);
      }
      /** @type {HTMLElement} */ (root.querySelector('[data-s-show="ends"]')).hidden = q('ends').value !== 'date';
    };
    layout();

    const save = async (patch) => {
      status.textContent = t('pane.saving');
      status.classList.remove('is-error', 'is-ok');
      try {
        const result = await update(patch);
        const fresh = result.task || result.workflow;
        Object.assign(row, fresh);
        // The panel's own words only while it is still the one on screen
        // (UX-011): after a close or a switch, writing the title would put this
        // schedule's name over another's. The cards and the lists hear of the
        // change either way — they used to be skipped, so a closed panel left
        // the conversation's card saying the old schedule.
        if (root.isConnected) $('taskpane-title').textContent = row.title;
        q('next').textContent = nextText(row);
        status.textContent = t('pane.saved');
        status.classList.add('is-ok');
        refreshCards(kind, row);
        onTasksChanged();
        paneAfter?.();
        return true;
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('is-error');
        // A save that fails after its panel has gone — closed, or another
        // schedule opened — has no status line anyone can see (UX-012).
        if (!root.isConnected) toast(err.message, 'error');
        return false;
      }
    };

    /** The schedule as the controls now describe it, in the pieces `scheduleFrom` takes. */
    const spec = () => {
      const f = q('frequency').value;
      const times = [...root.querySelectorAll('[data-t]')].map((i) => /** @type {HTMLInputElement} */ (i).value).filter(Boolean);
      const pressed = (attr) => [...root.querySelectorAll(`[${attr}][aria-pressed="true"]`)].map((b) => b.getAttribute(attr));
      if (f === 'once') return { frequency: f, date: q('date').value, time: q('onceTime').value };
      if (f === 'minutes') return { frequency: f, every: Number(q('everyMinutes').value) };
      if (f === 'hourly') return { frequency: f, minute: Number(q('minute').value) };
      if (f === 'hours') return { frequency: f, every: Number(q('everyHours').value), minute: Number(q('minute').value) };
      if (f === 'days') return { frequency: f, every: Number(q('everyDays').value), time: times[0], start: q('start').value };
      if (f === 'weekly') return { frequency: f, days: pressed('data-day'), times };
      if (f === 'monthly') return { frequency: f, monthDays: pressed('data-mday').map((d) => (d === 'last' ? d : Number(d))), times };
      return { frequency: f, times };
    };
    // One save in flight, the controls read again when it lands (CODE-036).
    const saveSchedule = latestWins(() => save({ schedule: spec(), tz: q('tz').value }));

    // A new frequency brings different controls, so the panel is drawn again
    // once the row has its new schedule — or stays as it was if that was refused.
    //
    // Saved once the choice settles, not on every `change` (UX-005): arrow keys
    // on a closed select fire one per option in Chrome on Windows and Firefox,
    // so passing "every 30 minutes" on the way to "daily" saved a schedule that
    // runs — and spends — every half hour, and the redraw that followed dropped
    // keyboard focus to the page. Focus is put back on the select afterwards.
    let settling = null;
    q('frequency').addEventListener('change', () => {
      // "Weekly" chosen over weekdays or every day would carry all five or
      // seven days with it, save as that again, and the menu would jump back.
      // It starts from one day instead.
      const days = [...root.querySelectorAll('[data-day]')];
      const on = days.filter((b) => b.getAttribute('aria-pressed') === 'true');
      if (q('frequency').value === 'weekly' && (on.length === 5 || on.length === 7)) {
        days.forEach((b, i) => b.setAttribute('aria-pressed', String(i === 0)));
      }
      layout();
      clearTimeout(settling);
      const menu = q('frequency');
      settlePending = () => {
        clearTimeout(settling);
        return saveSchedule();
      };
      settling = setTimeout(async () => {
        settlePending = null;
        const hadFocus = document.activeElement === menu;
        if (await saveSchedule()) {
          // Somebody who moved on within the pause stays where they went: the
          // change they made here is saved, but this schedule is not reopened
          // over whatever the panel shows now (UX-010). Any redraw of the panel
          // detaches this menu.
          if (!menu.isConnected) return;
          await showScheduleInPane(kind, row.id, { after: paneAfter });
          if (hadFocus) /** @type {HTMLElement|null} */ (document.querySelector('[data-s="frequency"]'))?.focus();
        }
      }, FREQUENCY_SETTLE_MS);
    });
    for (const name of ['everyMinutes', 'everyHours', 'everyDays', 'minute', 'date', 'onceTime', 'start', 'tz']) {
      q(name)?.addEventListener('change', saveSchedule);
    }

    // Times: change one, add one, take one away. At least one always stays.
    const times = /** @type {HTMLElement} */ (root.querySelector('.spane__times'));
    const tidyTimes = () => {
      const rows = times.querySelectorAll('.spane__timeitem');
      for (const x of times.querySelectorAll('[data-drop-time]')) /** @type {HTMLElement} */ (x).hidden = rows.length < 2;
    };
    times.addEventListener('change', (event) => {
      if (/** @type {HTMLElement} */ (event.target).matches('[data-t]')) saveSchedule();
    });
    times.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.matches('[data-drop-time]')) {
        target.closest('.spane__timeitem')?.remove();
        tidyTimes();
        saveSchedule();
      } else if (target.matches('[data-add-time]')) {
        const last = /** @type {HTMLInputElement | null} */ ([...times.querySelectorAll('[data-t]')].pop() || null);
        const item = /** @type {HTMLElement} */ (times.querySelector('.spane__timeitem').cloneNode(true));
        const input = /** @type {HTMLInputElement} */ (item.querySelector('[data-t]'));
        // An hour after the last one, so a new time is never a duplicate of it.
        const [h, m] = String(last?.value || '08:00').split(':').map(Number);
        input.value = `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        target.before(item);
        tidyTimes();
        input.focus();
        saveSchedule();
      }
    });

    // Days of the week and of the month: pressed or not, never none.
    for (const attr of ['data-day', 'data-mday']) {
      for (const chip of root.querySelectorAll(`[${attr}]`)) {
        chip.addEventListener('click', () => {
          const on = chip.getAttribute('aria-pressed') === 'true';
          if (on && root.querySelectorAll(`[${attr}][aria-pressed="true"]`).length === 1) return;
          chip.setAttribute('aria-pressed', String(!on));
          saveSchedule();
        });
      }
    }

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
    q('steps')?.addEventListener('change', () => {
      const lines = q('steps')
        .value.split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) {
        status.textContent = t('wf.needStep');
        status.classList.add('is-error');
        return;
      }
      save({ steps: lines });
    });

    // A manual task has no pause: it never runs by itself to begin with.
    q('toggle')?.addEventListener('click', async () => {
      try {
        if (kind === 'workflow') await api.updateWorkflow(row.id, { enabled: !row.enabled });
        else await api.setTaskEnabled(row.id, !row.enabled);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      onTasksChanged();
      paneAfter?.();
      // Not reopened over whatever the panel shows by now, or once it is closed
      // (UX-012, the same rule as the Repeat timer).
      if (root.isConnected) await showScheduleInPane(kind, row.id, { after: paneAfter });
    });

    armed(q('drop'), t('pages.tasks.removeConfirm'), async () => {
      if (kind === 'workflow') await api.deleteWorkflow(row.id);
      else await api.deleteTask(row.id);
      onTasksChanged();
      const after = paneAfter;
      closeTaskPane();
      after?.();
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

  /** A task in the rail — kept by name for the callers that only have tasks. */
  const showTaskInPane = (id) => showScheduleInPane('task', id);

  function closeTaskPane() {
    flushSettling();
    paneTurn++;
    $('taskpane').hidden = true;
    $('taskpane-body').replaceChildren();
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
  };
}
