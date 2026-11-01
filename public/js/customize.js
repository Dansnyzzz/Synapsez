import { api } from './api.js';
import { t, currentLanguage } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { PLUGINS } from './plugins.js';

/**
 * Settings → Customize: Skills, Connectors and Plugins, after Claude's (owner,
 * 2026-10-31). Each has "Yours" — what this account has, as a list with a ⋯ menu
 * per row — and "Discover" — what else Synapsez offers, as cards with a +. Only
 * what the app really has: the built-in skills, the services it can connect,
 * the families of built-in tools. No catalogue, and no install counts.
 *
 * Every name drawn here may be somebody's own text, so all of it is escaped.
 *
 * @typedef {{
 *   armed: (button: HTMLElement, warning: string, run: () => Promise<void>) => void,
 *   prefs: () => Record<string, any>,
 *   savePrefs: (patch: Record<string, any>) => Promise<any>,
 *   pickSkill: (name: string) => void,
 *   closeSettings: () => void,
 *   googleCard: (connector: any) => string,
 *   onPlugins?: () => void,
 *   selectTab: (tab: string) => void,
 *   editSkill: (skill: any) => void,
 *   createWithClaude: () => void,
 * }} Deps
 */

const svg = (paths, size = 18) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  skill: svg('<path d="M6 3h8a2 2 0 0 1 2 2v1H8"/><path d="M8 6v9a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1h2"/><path d="M8 17h7a2 2 0 0 0 2-2V6"/><path d="M10.5 9.5h4M10.5 12.5h4"/>'),
  plugin: svg('<path d="M7.5 3h5v3.2a1.6 1.6 0 1 0 3.2 0V3H17v14H3V3h1.3v3.2a1.6 1.6 0 1 0 3.2 0Z"/>'),
  more: svg('<circle cx="5" cy="10" r=".9"/><circle cx="10" cy="10" r=".9"/><circle cx="15" cy="10" r=".9"/>'),
  add: svg('<path d="M10 4v12M4 10h12"/>', 17),
  check: svg('<path d="m4.5 10.5 3.5 3.5 7.5-8"/>', 17),
  upload: svg('<path d="M10 13V4M6.5 7.5 10 4l3.5 3.5M4 16h12"/>', 17),
  pencil: svg('<path d="M13.5 2.9a1.9 1.9 0 0 1 2.7 2.7L7.8 14 4 15l1-3.8Z"/>', 17),
  chat: svg('<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 16 14h-6l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5Z"/>', 17),
};

/** The plugin names and what each holds, by key literal so the dictionary check sees every one. */
const PLUGIN_TEXT = {
  office: ['plugin.office', 'settings.plugin.office'],
  visuals: ['plugin.visuals', 'settings.plugin.visuals'],
  cloud_computer: ['plugin.cloud_computer', 'settings.plugin.cloud_computer'],
  cloud_browser: ['plugin.cloud_browser', 'settings.plugin.cloud_browser'],
  research: ['plugin.research', 'settings.plugin.research'],
  places: ['plugin.places', 'settings.plugin.places'],
  data: ['plugin.data', 'settings.plugin.data'],
  automation: ['plugin.automation', 'settings.plugin.automation'],
};

const monogram = (name) => `<span class="crow__mono" aria-hidden="true">${escapeHtml(String(name || '?').trim().charAt(0).toUpperCase() || '?')}</span>`;
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-US', { day: 'numeric', month: 'short' });
};

/**
 * A ⋯ menu that sits above the settings sheet: a popover, so it is drawn in the
 * top layer rather than clipped by the scrolling panel, and dismissed by a
 * click elsewhere or Escape the way every menu is.
 *
 * A choice of one (Private or Public in Your data) passes `checked` on each
 * item: they read as radio items, the chosen one ticked. Claude's Skills menus
 * (owner, 2026-11-01) add the rest: a `heading` row ("Filter by"), an `icon`
 * before a label, and `sub` — a second menu opened beside its row by pointing,
 * pressing or →, nested inside the first so a click in it never closes both.
 *
 * @typedef {{ label?: string, heading?: string, run?: () => any, danger?: boolean, confirm?: string, checked?: boolean, icon?: string, sub?: () => MenuItem[] }} MenuItem
 * @param {HTMLElement} button
 * @param {MenuItem[]} items
 * @param {{ beside?: HTMLElement, root?: HTMLElement }} [options]  for a sub-menu: the row it opens from, and the menu it is in
 */
export function openMenu(button, items, { beside = null, root = null } = {}) {
  const host = root || button.closest('dialog') || document.body;
  if (root) root.querySelectorAll(':scope > .cmenu').forEach((m) => m.remove());
  else host.querySelectorAll(':scope > .cmenu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = `cmenu${root ? ' cmenu--sub' : ''}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('popover', 'auto');
  const close = () => {
    /** @type {HTMLElement} */
    let top = menu;
    while (top.parentElement?.classList.contains('cmenu')) top = top.parentElement;
    top.hidePopover?.();
    top.remove();
  };
  for (const item of items) {
    if (item.heading) {
      menu.append(Object.assign(document.createElement('p'), { className: 'cmenu__heading', textContent: item.heading }));
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `cmenu__item${item.danger ? ' is-danger' : ''}${item.checked != null ? ' cmenu__item--check' : ''}${item.sub ? ' cmenu__item--sub' : ''}`;
    row.setAttribute('role', item.checked != null ? 'menuitemradio' : 'menuitem');
    if (item.checked != null) row.setAttribute('aria-checked', String(!!item.checked));
    if (item.sub) row.setAttribute('aria-haspopup', 'menu');
    if (item.icon) row.insertAdjacentHTML('beforeend', `<span class="cmenu__icon">${item.icon}</span>`);
    const label = document.createElement('span');
    label.className = 'cmenu__label';
    label.textContent = item.label || '';
    row.append(label);
    if (item.sub) {
      const openSub = (focus) => {
        if (/** @type {HTMLElement | null} */ (menu.querySelector(':scope > .cmenu'))?.dataset.from === item.label) return;
        const sub = openMenu(row, item.sub(), { beside: row, root: menu });
        sub.dataset.from = item.label || '';
        if (focus) /** @type {HTMLElement | null} */ (sub.querySelector('.cmenu__item'))?.focus();
      };
      row.addEventListener('pointerenter', () => openSub(false));
      row.addEventListener('click', () => openSub(true));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          openSub(true);
        }
      });
    } else {
      // Pointing at a plain row closes a sub-menu another row opened.
      row.addEventListener('pointerenter', () => menu.querySelectorAll(':scope > .cmenu').forEach((m) => m.remove()));
      let armedOnce = false;
      row.addEventListener('click', async () => {
        // Something that cannot be undone asks twice, as every delete here does.
        if (item.confirm && !armedOnce) {
          armedOnce = true;
          label.textContent = item.confirm;
          return;
        }
        close();
        try {
          await item.run?.();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
    menu.append(row);
  }
  host.append(menu);
  button.setAttribute('aria-expanded', 'true');
  menu.addEventListener('toggle', (event) => {
    if (/** @type {any} */ (event).newState === 'closed') {
      button.setAttribute('aria-expanded', 'false');
      menu.remove();
    }
  });
  menu.addEventListener('keydown', (event) => {
    event.stopPropagation();
    const rows = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll(':scope > .cmenu__item')]);
    const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === 'ArrowLeft' && root) {
      event.preventDefault();
      menu.remove();
      button.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      /** @type {HTMLElement | null} */ (beside ? button.closest('.cmenu') : button)?.focus?.();
    }
  });
  menu.showPopover?.();
  const at = button.getBoundingClientRect();
  if (beside) {
    // Beside its row, on whichever side has room.
    const right = at.right + 6;
    menu.style.left = `${right + menu.offsetWidth <= window.innerWidth - 8 ? right : Math.max(8, at.left - menu.offsetWidth - 6)}px`;
    menu.style.top = `${Math.max(8, Math.min(at.top - 6, window.innerHeight - menu.offsetHeight - 8))}px`;
  } else {
    menu.style.top = `${Math.min(at.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, at.right - menu.offsetWidth)}px`;
    /** @type {HTMLElement | null} */ (menu.querySelector('.cmenu__item'))?.focus();
  }
  return menu;
}

/** One row of a "Yours" list. */
const listRow = ({ key, icon, name, tag = '', by, desc, meta = '', more = true, search }) =>
  `<div class="crow cust-item" data-search="${escapeHtml(search.toLowerCase())}">
    <span class="crow__icon">${icon}</span>
    <div class="crow__text">
      <p class="crow__name">${escapeHtml(name)}${tag ? ` <span class="crow__tag">${escapeHtml(tag)}</span>` : ''}</p>
      <p class="crow__desc">${escapeHtml(by)}${desc ? ` · ${escapeHtml(desc)}` : ''}</p>
    </div>
    <span class="crow__meta">${escapeHtml(meta)}</span>
    ${more ? `<button class="icon-btn crow__more" type="button" data-more="${escapeHtml(key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('settings.moreFor', { name }))}">${ICON.more}</button>` : '<span class="crow__more"></span>'}
  </div>`;

/** One card of a "Discover" grid. */
const card = ({ key, icon, name, desc, by, search, detail = '' }) =>
  `<div class="ccard cust-item" data-search="${escapeHtml(search.toLowerCase())}">
    <span class="ccard__icon">${icon}</span>
    <div class="ccard__text">
      <p class="ccard__name">${escapeHtml(name)}</p>
      <p class="ccard__desc">${escapeHtml(desc)}</p>
      <p class="ccard__by">${escapeHtml(by)}</p>
    </div>
    <button class="ccard__add" type="button" data-add="${escapeHtml(key)}" aria-label="${escapeHtml(t('settings.addThing', { name }))}" title="${escapeHtml(t('settings.addThing', { name }))}">${ICON.add}</button>
    ${detail ? `<div class="ccard__detail" data-detail="${escapeHtml(key)}" hidden>${detail}</div>` : ''}
  </div>`;

const group = (label, n) => `<p class="cust__group">${escapeHtml(label)} <span class="cust__count">${n}</span></p>`;
/** The element under `root` whose `data-<name>` is exactly `value` — an id somebody typed is never put in a selector. */
const byData = (root, name, value) => /** @type {HTMLElement | undefined} */ ([...root.querySelectorAll(`[data-${name}]`)].find((el) => /** @type {HTMLElement} */ (el).getAttribute(`data-${name}`) === value));
const empty = (text) => `<p class="cust__empty">${escapeHtml(text)}</p>`;

/** @param {Deps} deps */
export function createCustomize(deps) {
  /* ── the two views and the search, the same in all three panels ──── */

  for (const panel of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#panel-skills, #panel-connectors, #panel-plugins, #panel-extensions'))) {
    const show = (view) => {
      for (const b of panel.querySelectorAll('[data-cust-view]')) b.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (b).dataset.custView === view));
      for (const pane of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-cust-pane]'))) pane.hidden = pane.dataset.custPane !== view;
    };
    panel.addEventListener('click', (event) => {
      const el = /** @type {HTMLElement} */ (event.target).closest('[data-cust-view], [data-cust-goto]');
      if (el) show(/** @type {HTMLElement} */ (el).dataset.custView || /** @type {HTMLElement} */ (el).dataset.custGoto);
    });
    const search = /** @type {HTMLInputElement | null} */ (panel.querySelector('[data-cust-search]'));
    search?.addEventListener('input', () => filter(panel, search.value));
  }

  function filter(panel, query) {
    const q = query.trim().toLowerCase();
    for (const item of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('.cust-item'))) item.hidden = !!q && !item.dataset.search?.includes(q);
  }
  const refilter = (id) => {
    const panel = document.getElementById(id);
    const search = /** @type {HTMLInputElement | null} */ (panel?.querySelector('[data-cust-search]'));
    if (panel && search?.value) filter(panel, search.value);
  };

  /* ── Skills ──────────────────────────────────────────────────────── */

  const useSkill = (name) => {
    deps.closeSettings();
    deps.pickSkill(name);
  };

  /**
   * How "Yours" is narrowed and ordered, as Claude's Skills are (owner,
   * 2026-11-01): by the plugin a skill comes with, by who made it, and by when it
   * was last changed, its name, or its plugin's. Remembered in this browser —
   * a view, not a setting.
   */
  const VIEW_KEY = 'synapsez.skillsView';
  let view = { plugin: 'all', by: 'all', sort: 'edited' };
  try {
    view = { ...view, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') };
  } catch {
    /* a private window keeps the defaults */
  }
  const keepView = () => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* the view holds for this visit */
    }
  };
  let skillData = { skills: [], builtin: [] };
  const pluginName = (id) => (id && PLUGIN_TEXT[id] ? t(PLUGIN_TEXT[id][0]) : '');

  async function loadSkills() {
    skillData = await api.skills();
    drawSkills();
    drawDiscover();
  }

  function drawSkills() {
    const { skills = [], builtin = [] } = skillData;
    const theirs = builtin.map((s) => ({ ...s, mine: false }));
    const mine = skills.map((s) => ({ ...s, mine: true, plugin: null }));
    const keep = (s) => (view.by === 'all' || (view.by === 'you') === s.mine) && (view.plugin === 'all' || s.plugin === view.plugin);
    const order = (a, b) => {
      if (view.sort === 'name') return a.name.localeCompare(b.name);
      if (view.sort === 'plugin') return pluginName(a.plugin).localeCompare(pluginName(b.plugin)) || a.name.localeCompare(b.name);
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    };
    const row = (s) =>
      listRow({
        key: s.id,
        icon: ICON.skill,
        name: s.name,
        tag: s.mine ? (s.enabled ? '' : t('settings.off')) : pluginName(s.plugin),
        by: s.mine ? t('settings.byYou') : t('settings.fromSynapsez'),
        desc: s.description,
        meta: s.mine ? day(s.updated_at || s.created_at) : '',
        search: `${s.name} ${s.description} ${pluginName(s.plugin)}`,
      });
    const shownTheirs = theirs.filter(keep).sort(order);
    const shownMine = mine.filter(keep).sort(order);
    const list = document.getElementById('skill-list');
    list.innerHTML =
      (shownTheirs.length ? group(t('settings.fromSynapsez'), shownTheirs.length) + shownTheirs.map(row).join('') : '') +
      (view.by !== 'synapsez' && view.plugin === 'all' ? group(t('settings.madeByYou'), shownMine.length) + (shownMine.map(row).join('') || empty(t(mine.length ? 'skills.noneMatch' : 'skills.empty'))) : '');
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-more]'))) {
      btn.addEventListener('click', () => {
        const own = skills.find((s) => s.id === btn.dataset.more);
        const built = builtin.find((s) => s.id === btn.dataset.more);
        const name = (own || built)?.name;
        const items = [{ label: t('settings.useInMessage'), run: () => useSkill(name) }];
        if (own) {
          items.push({ label: t('skills.edit'), run: () => deps.editSkill(own) });
          items.push({
            label: own.enabled ? t('settings.turnOff') : t('settings.turnOn'),
            run: async () => {
              await api.setSkillEnabled(own.id, !own.enabled);
              loadSkills();
            },
          });
          items.push({
            label: t('action.delete'),
            danger: true,
            confirm: t('action.reallyRemove'),
            run: async () => {
              await api.deleteSkill(own.id);
              loadSkills();
            },
          });
        }
        openMenu(btn, items);
      });
    }
    refilter('panel-skills');
  }

  function drawDiscover() {
    const { builtin = [] } = skillData;
    const discover = document.getElementById('skill-discover');
    discover.innerHTML = `<div class="cgrid">${
      builtin.map((s) => card({ key: s.id, icon: ICON.skill, name: s.name, desc: s.description, by: t('settings.fromSynapsez'), search: `${s.name} ${s.description}` })).join('') +
      card({ key: '__new', icon: ICON.add, name: t('plus.newSkill'), desc: t('settings.newSkillHint'), by: t('settings.byYou'), search: t('plus.newSkill') })
    }</div>`;
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (discover.querySelectorAll('[data-add]'))) {
      btn.addEventListener('click', () => {
        if (btn.dataset.add === '__new') return showSkillForm();
        const s = builtin.find((x) => x.id === btn.dataset.add);
        if (s) useSkill(s.name);
      });
    }
    refilter('panel-skills');
  }

  /** Filter by → Plugin › and Created by ›, each a choice of one, the current one ticked. */
  document.getElementById('skills-filter').addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.currentTarget);
    const plugins = [...new Set(skillData.builtin.map((s) => s.plugin).filter(Boolean))];
    const choose = (key, value) => () => {
      view = { ...view, [key]: value };
      keepView();
      drawSkills();
    };
    openMenu(button, [
      { heading: t('skills.filterBy') },
      {
        label: t('skills.plugin'),
        sub: () => [
          { label: t('skills.all'), checked: view.plugin === 'all', run: choose('plugin', 'all') },
          ...plugins.map((id) => ({ label: pluginName(id), checked: view.plugin === id, run: choose('plugin', id) })),
        ],
      },
      {
        label: t('skills.createdBy'),
        sub: () => [
          { label: t('skills.all'), checked: view.by === 'all', run: choose('by', 'all') },
          { label: t('skills.byYou'), checked: view.by === 'you', run: choose('by', 'you') },
          { label: 'Synapsez', checked: view.by === 'synapsez', run: choose('by', 'synapsez') },
        ],
      },
    ]);
  });

  /** Sort by: when it was last changed, its name, or its plugin's. */
  document.getElementById('skills-sort').addEventListener('click', (event) => {
    const sortBy = (sort) => () => {
      view = { ...view, sort };
      keepView();
      drawSkills();
    };
    openMenu(/** @type {HTMLElement} */ (event.currentTarget), [
      { heading: t('skills.sortBy') },
      { label: t('skills.lastEdited'), checked: view.sort === 'edited', run: sortBy('edited') },
      { label: t('skills.name'), checked: view.sort === 'name', run: sortBy('name') },
      { label: t('skills.pluginName'), checked: view.sort === 'plugin', run: sortBy('plugin') },
    ]);
  });

  /** + Add: upload one, write one, or make one with the assistant. */
  document.getElementById('skill-add-open').addEventListener('click', (event) => {
    openMenu(/** @type {HTMLElement} */ (event.currentTarget), [
      { label: t('skills.uploadSkill'), icon: ICON.upload, run: () => showUpload() },
      { label: t('skills.createSkill'), icon: ICON.pencil, run: () => showSkillForm() },
      { label: t('skills.createWithClaude'), icon: ICON.chat, run: () => deps.createWithClaude() },
    ]);
  });

  /** The Create a skill editor, from + Add, from Discover, or from the + menu's "Create a skill". */
  function showSkillForm() {
    deps.editSkill(null);
  }

  /* ── Upload a skill ─────────────────────────────────────────────── */

  /** The files chosen, with what the scan said of each, until they are uploaded or let go. */
  let chosen = [];

  function showUpload() {
    chosen = [];
    drawChosen();
    deps.selectTab('skillupload');
  }

  /** A file as base64, for the upload's JSON body. */
  const asBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  async function choose(files) {
    const picked = [...files].slice(0, 10);
    if (!picked.length) return;
    const state = document.getElementById('skill-scan-state');
    state.textContent = t('skills.scanning');
    try {
      const uploads = await Promise.all(picked.map(async (file) => ({ name: file.name, data: await asBase64(file) })));
      const { results } = await api.uploadSkills(uploads, { save: false });
      chosen = uploads.map((upload, i) => ({ upload, result: results[i] }));
    } catch (err) {
      chosen = [];
      toast(err.message, 'error');
    }
    drawChosen();
  }

  /** What each chosen file holds and what the scan found; Upload only when one of them can go. */
  function drawChosen() {
    const host = document.getElementById('skill-picked');
    host.replaceChildren();
    const ready = chosen.filter(({ result }) => !result.error && !result.findings.some((f) => f.level === 'block'));
    for (const { result } of chosen) {
      const item = document.createElement('div');
      item.className = `skpick__item${result.error || result.findings.some((f) => f.level === 'block') ? ' is-refused' : ''}`;
      const head = document.createElement('p');
      head.className = 'skpick__name';
      head.textContent = result.name ? `${result.name} · ${result.file}` : result.file;
      item.append(head);
      if (result.description) item.append(Object.assign(document.createElement('p'), { className: 'skpick__desc', textContent: result.description }));
      if (result.files?.length) item.append(Object.assign(document.createElement('p'), { className: 'skpick__desc', textContent: t('skills.withFiles', { files: result.files.join(', ') }) }));
      const notes = result.error ? [{ level: 'block', text: result.error }] : result.findings;
      for (const finding of notes) {
        item.append(Object.assign(document.createElement('p'), { className: `skpick__finding is-${finding.level}`, textContent: finding.text }));
      }
      host.append(item);
    }
    const state = document.getElementById('skill-scan-state');
    const problems = chosen.reduce((n, { result }) => n + (result.error ? 1 : result.findings.filter((f) => f.level !== 'note').length), 0);
    state.textContent = chosen.length ? (problems ? t('skills.scanFound', { n: problems }) : t('skills.scanClean')) : t('skills.scanWhen');
    state.classList.toggle('is-warn', problems > 0);
    /** @type {HTMLButtonElement} */ (document.getElementById('skill-upload')).disabled = !ready.length;
    document.getElementById('skill-upload-status').textContent = chosen.length
      ? ready.length
        ? t('skills.readyToUpload', { n: ready.length })
        : t('skills.nothingToUpload')
      : t('skills.chooseFirst');
  }

  const drop = document.getElementById('skill-drop');
  const input = /** @type {HTMLInputElement} */ (document.getElementById('skill-files'));
  input.addEventListener('change', () => {
    choose(input.files || []);
    input.value = '';
  });
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
  }
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    choose(event.dataTransfer?.files || []);
  });
  document.getElementById('skill-upload-cancel').addEventListener('click', () => {
    chosen = [];
    drawChosen();
    deps.selectTab('skills');
  });
  document.getElementById('skill-upload').addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ (document.getElementById('skill-upload'));
    button.disabled = true;
    try {
      const { results } = await api.uploadSkills(chosen.map(({ upload }) => upload), { save: true });
      const saved = results.filter((r) => r.saved).map((r) => r.saved);
      if (saved.length) toast(t('skills.uploaded', { names: saved.join(', ') }), 'ok');
      const left = results.filter((r) => !r.saved);
      if (left.length) {
        chosen = chosen.filter((_, i) => !results[i].saved).map((c, i) => ({ ...c, result: left[i] }));
        drawChosen();
      } else {
        chosen = [];
        drawChosen();
        deps.selectTab('skills');
      }
      await loadSkills();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
    }
  });

  /* ── Connectors ──────────────────────────────────────────────────── */

  /** The form a connector is connected — or changed — with: a token, or Google's sign-in. */
  const connectForm = (c) =>
    c.oauth
      ? deps.googleCard(c)
      : `<p class="crow__desc">${escapeHtml(c.help || '')}</p>
        <div class="settings__actions">
          <input class="sinput" type="password" data-token="${escapeHtml(c.id)}" placeholder="${escapeHtml(c.placeholder || '')}" aria-label="${escapeHtml(t('settings.tokenFor', { name: c.label }))}" autocomplete="off" />
          <button class="btn btn--primary btn--small" type="button" data-connect="${escapeHtml(c.id)}">${escapeHtml(c.connected ? t('connectors.replace') : t('mcp.add'))}</button>
        </div>`;

  async function loadConnectors() {
    const { connectors = [] } = await api.connectors();
    const yours = connectors.filter((c) => c.connected);
    const others = connectors.filter((c) => !c.connected);
    const list = document.getElementById('connector-list');
    list.innerHTML = yours.length
      ? `<div class="ctable" role="table" aria-label="${escapeHtml(t('settings.tab.connectors'))}">
          <div class="ctable__head" role="row"><span role="columnheader">${escapeHtml(t('settings.connector'))}</span><span role="columnheader">${escapeHtml(t('settings.type'))}</span><span role="columnheader">${escapeHtml(t('settings.status'))}</span><span></span></div>
          ${yours
            .map(
              (c) => `<div class="ctable__row cust-item" role="row" data-search="${escapeHtml(`${c.label} ${c.account || ''}`.toLowerCase())}">
                <span role="cell" class="ctable__name">${monogram(c.label)}<span><strong>${escapeHtml(c.label)}</strong>${c.account ? `<span class="crow__desc">${escapeHtml(c.account)}</span>` : ''}</span></span>
                <span role="cell" class="crow__desc">${escapeHtml(t(c.oauth ? 'settings.typeSignIn' : 'settings.typeToken'))}</span>
                <span role="cell" class="ctable__ok" title="${escapeHtml(t('connectors.connected'))}">${ICON.check}<span class="sr-only">${escapeHtml(t('connectors.connected'))}</span></span>
                <button class="icon-btn crow__more" type="button" data-more="${escapeHtml(c.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('settings.moreFor', { name: c.label }))}">${ICON.more}</button>
                <div class="ctable__detail" data-detail="${escapeHtml(c.id)}" hidden>${connectForm(c)}</div>
              </div>`,
            )
            .join('')}
        </div>`
      : empty(t('settings.noConnectors'));
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-more]'))) {
      btn.addEventListener('click', () => {
        const c = yours.find((x) => x.id === btn.dataset.more);
        openMenu(btn, [
          {
            label: t(c.oauth ? 'google.update' : 'connectors.replace'),
            run: () => {
              const detail = byData(list, 'detail', c.id);
              if (detail) detail.hidden = !detail.hidden;
            },
          },
          {
            label: t('connectors.disconnect'),
            danger: true,
            confirm: t('connectors.reallyDisconnect'),
            run: async () => {
              await api.disconnect(c.id);
              loadConnectors();
            },
          },
        ]);
      });
    }

    const discover = document.getElementById('connector-discover');
    discover.innerHTML = others.length
      ? `<div class="cgrid">${others.map((c) => card({ key: c.id, icon: monogram(c.label), name: c.label, desc: c.help || '', by: t(c.oauth ? 'settings.typeSignIn' : 'settings.typeToken'), search: `${c.label} ${c.help || ''}`, detail: connectForm(c) })).join('')}</div>`
      : empty(t('settings.allConnected'));
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (discover.querySelectorAll('[data-add]'))) {
      btn.addEventListener('click', () => {
        const detail = byData(discover, 'detail', btn.dataset.add);
        if (!detail) return;
        detail.hidden = !detail.hidden;
        btn.setAttribute('aria-expanded', String(!detail.hidden));
        /** @type {HTMLElement | null} */ (detail.querySelector('input'))?.focus();
      });
    }
    wireConnect(document.getElementById('panel-connectors'));
    refilter('panel-connectors');
  }

  /**
   * One connector's form, open and ready — for Connect pressed on a card the
   * assistant showed (owner, 2026-11-01). Not connected: Discover, its form
   * open, the token box (or Google's first choice) focused. Connected already:
   * Yours, where it is listed.
   */
  async function showConnector(id) {
    await loadConnectors();
    const panel = /** @type {HTMLElement} */ (document.getElementById('panel-connectors'));
    const search = /** @type {HTMLInputElement | null} */ (panel.querySelector('[data-cust-search]'));
    if (search?.value) {
      search.value = '';
      filter(panel, '');
    }
    const discover = /** @type {HTMLElement} */ (document.getElementById('connector-discover'));
    const add = byData(discover, 'add', id);
    if (!add) return;
    /** @type {HTMLElement} */ (panel.querySelector('[data-cust-view="discover"]')).click();
    const detail = byData(discover, 'detail', id);
    if (detail?.hidden) add.click();
    detail?.scrollIntoView({ block: 'nearest' });
    /** @type {HTMLElement | null} */ (detail?.querySelector('input, button'))?.focus();
  }

  /** The buttons inside the forms: connect with a token, or go to Google. */
  function wireConnect(panel) {
    for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (panel.querySelectorAll('[data-connect]'))) {
      btn.addEventListener('click', async () => {
        const service = btn.dataset.connect;
        const field = /** @type {HTMLInputElement} */ (byData(btn.closest('[data-detail]'), 'token', service));
        btn.disabled = true;
        try {
          const { account } = await api.connect(service, field.value);
          toast(t('connectors.connectedAs', { account }));
          loadConnectors();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    }
    // Google is a sign-in, not a paste: the browser goes to Google and comes back.
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-google-connect]'))) {
      btn.addEventListener('click', () => {
        const products = [...btn.closest('[data-detail]').querySelectorAll('[data-google-product]:checked')].map((box) => /** @type {HTMLInputElement} */ (box).value);
        if (!products.length) return toast(t('google.pickOne'), 'error');
        location.href = `/api/connectors/google/start?products=${encodeURIComponent(products.join(','))}`;
      });
    }
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll('[data-disconnect]'))) {
      deps.armed(btn, t('connectors.reallyDisconnect'), async () => {
        await api.disconnect(btn.dataset.disconnect);
        loadConnectors();
      });
    }
  }

  /* ── Plugins ─────────────────────────────────────────────────────── */

  const offSet = () => new Set(deps.prefs().pluginsOff || []);

  /** Switch one family on or off — from here, from System's two switches, or from the + menu. */
  async function setPlugin(id, on) {
    const off = offSet();
    if (on) off.delete(id);
    else off.add(id);
    await deps.savePrefs({ pluginsOff: [...off] });
    paintPlugins();
    deps.onPlugins?.();
  }

  function paintPlugins() {
    const off = offSet();
    const text = (p) => ({ name: t(PLUGIN_TEXT[p.id]?.[0] || p.id), desc: t(PLUGIN_TEXT[p.id]?.[1] || p.id) });
    const on = PLUGINS.filter((p) => !off.has(p.id));
    const resting = PLUGINS.filter((p) => off.has(p.id));
    const list = document.getElementById('plugin-list');
    list.innerHTML =
      group(t('settings.fromSynapsez'), on.length) +
      (on.map((p) => listRow({ key: p.id, icon: ICON.plugin, name: text(p).name, by: t('settings.builtIn'), desc: text(p).desc, meta: t('settings.toolsN', { n: String(p.tools.length) }), search: `${text(p).name} ${text(p).desc}` })).join('') ||
        empty(t('settings.allPluginsOff')));
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-more]'))) {
      btn.addEventListener('click', () => openMenu(btn, [{ label: t('settings.turnOff'), run: () => setPlugin(btn.dataset.more, false) }]));
    }
    const discover = document.getElementById('plugin-discover');
    discover.innerHTML = resting.length
      ? `<div class="cgrid">${resting.map((p) => card({ key: p.id, icon: ICON.plugin, name: text(p).name, desc: text(p).desc, by: t('settings.builtIn'), search: `${text(p).name} ${text(p).desc}` })).join('')}</div>`
      : empty(t('settings.allPluginsOn'));
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (discover.querySelectorAll('[data-add]'))) {
      btn.addEventListener('click', () => setPlugin(btn.dataset.add, true).catch((err) => toast(err.message, 'error')));
    }
    refilter('panel-plugins');
  }

  return { loadSkills, loadConnectors, showConnector, paintPlugins, setPlugin, showSkillForm };
}
