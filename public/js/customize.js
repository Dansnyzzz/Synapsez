import { api } from './api.js';
import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';
import { mountTelegramInbound } from './telegram-inbound.js';
import { PLUGINS } from './plugins.js';
import { CONNECTORS, CONNECTOR_BY_ID, CATEGORIES, relatedTo } from './connector-catalog.js';

/**
 * Settings → Customize: Skills, Connectors and Plugins, after Claude's (owner,
 * 2026-10-31). Each has "Yours" — what this account has, as a list with a ⋯ menu
 * per row — and "Discover" — what else Synapsez offers, as cards with a +. Only
 * what the app really has: the services it can connect, the families of
 * built-in tools. No catalogue, and no install counts.
 *
 * Skills' Discover is what people on this site share (owner, 2026-11-09):
 * newest made first, each by its author's public name, added by reference so an
 * author's edit reaches everyone who added it. Synapsez's own skills are not
 * listed in either view unless a filter asks for them — they still do their
 * work, and the + menu still offers them. While the page is open it asks again
 * every little while and when it is looked at, so what others share or change
 * arrives without a reload.
 *
 * Every name drawn here may be somebody's own text, so all of it is escaped.
 *
 * @typedef {{
 *   armed: (button: HTMLElement, warning: string, run: () => Promise<void>) => void,
 *   prefs: () => Record<string, any>,
 *   savePrefs: (patch: Record<string, any>) => Promise<any>,
 *   pickSkill: (name: string) => void,
 *   closeSettings: () => void,
 *   addMcpServer: () => void,
 *   keySaved: () => Promise<void>,
 *   onPlugins?: () => void,
 *   selectTab: (tab: string) => void,
 *   editSkill: (skill: any) => void,
 *   viewSkill: (skill: any, view: { author: string | null, onAdd?: () => Promise<void> }) => void,
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

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' });
};

/** Each open menu's opener — for a sub-menu, the button that opened the menu it is in. */
const OPENERS = new WeakMap();

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
  OPENERS.set(menu, root ? OPENERS.get(root) : button);
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
        // Focus goes back to what opened the menu (UI-011), before the choice
        // runs, so a dialog the choice opens can take it from there.
        OPENERS.get(menu)?.focus?.();
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
    } else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && root) {
      // A sub-menu steps back to its row. Escape used to close everything and
      // focus the menu it had just removed, leaving focus nowhere (UI-011).
      event.preventDefault();
      menu.remove();
      button.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      button.focus();
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

/** One row of a "Yours" list. `warn` is a sentence that says something went — shown in full, not cut. */
const listRow = ({ key, icon, name, tag = '', by, desc, warn = '', meta = '', more = true, search }) =>
  `<div class="crow cust-item" data-search="${escapeHtml(search.toLowerCase())}">
    <span class="crow__icon">${icon}</span>
    <div class="crow__text">
      <p class="crow__name">${escapeHtml(name)}${tag ? ` <span class="crow__tag">${escapeHtml(tag)}</span>` : ''}</p>
      ${warn ? `<p class="crow__desc crow__desc--wrap crow__warn">${escapeHtml(warn)}</p>` : `<p class="crow__desc">${escapeHtml(by)}${desc ? ` · ${escapeHtml(desc)}` : ''}</p>`}
    </div>
    <span class="crow__meta">${escapeHtml(meta)}</span>
    ${more ? `<button class="icon-btn crow__more" type="button" data-more="${escapeHtml(key)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('settings.moreFor', { name }))}">${ICON.more}</button>` : '<span class="crow__more"></span>'}
  </div>`;

/** One card of a "Discover" grid. */
const card = ({ key, icon, name, desc, by, search }) =>
  `<div class="ccard cust-item" data-search="${escapeHtml(search.toLowerCase())}">
    <span class="ccard__icon">${icon}</span>
    <div class="ccard__text">
      <p class="ccard__name">${escapeHtml(name)}</p>
      <p class="ccard__desc">${escapeHtml(desc)}</p>
      <p class="ccard__by">${escapeHtml(by)}</p>
    </div>
    <button class="ccard__add" type="button" data-add="${escapeHtml(key)}" aria-label="${escapeHtml(t('settings.addThing', { name }))}" title="${escapeHtml(t('settings.addThing', { name }))}">${ICON.add}</button>
  </div>`;

const group = (label, n) => `<p class="cust__group">${escapeHtml(label)} <span class="cust__count">${n}</span></p>`;
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
  /** What Yours shows: the account's own, the shared ones it added, and the built-ins a filter can bring back. */
  let skillData = { skills: [], added: [], builtin: [], shareByDefault: false };
  /** What Discover shows: every shared skill on the site, newest made first. */
  let sharedData = { skills: [], moderator: false };
  /** The two answers as last drawn, so a poll that brings nothing new draws nothing. */
  let drawnSkills = '';
  const pluginName = (id) => (id && PLUGIN_TEXT[id] ? t(PLUGIN_TEXT[id][0]) : '');
  const authorOf = (author) => (author ? t('skills.byName', { name: author }) : t('skills.byMember'));
  /** Why an added skill no longer works, said where it was. */
  const GONE = { unshared: 'skills.goneUnshared', hidden: 'skills.goneHidden', deleted: 'skills.goneDeleted' };

  async function loadSkills() {
    const [mine, shared] = await Promise.all([api.skills(), api.sharedSkills().catch(() => sharedData)]);
    show(mine, shared);
  }

  function show(mine, shared) {
    skillData = { added: [], builtin: [], ...mine };
    sharedData = shared;
    drawnSkills = JSON.stringify([mine, shared]);
    drawSkills();
    drawDiscover();
  }

  /**
   * Keeping up while the page is open (owner, 2026-11-09): what somebody shares,
   * edits or takes back here reaches this page without a reload — asked again
   * every twenty seconds while Skills is on screen, and the moment the page is
   * looked at again. Drawn only when something changed, never under an open
   * menu, and with focus put back on the control that had it.
   */
  const SKILLS_EVERY_MS = 20_000;
  let polling = false;
  const skillsOnScreen = () => document.visibilityState === 'visible' && !!document.getElementById('panel-skills')?.offsetParent;
  async function refreshSkills() {
    if (polling || !skillsOnScreen()) return;
    polling = true;
    try {
      const [mine, shared] = await Promise.all([api.skills(), api.sharedSkills()]);
      if (JSON.stringify([mine, shared]) === drawnSkills) return;
      // A ⋯ menu open over the page would be left pointing at rows that are gone.
      if (document.querySelector('#settings .cmenu')) return;
      const focused = /** @type {HTMLElement | null} */ (document.activeElement);
      const host = focused?.closest?.('#skill-list, #skill-discover');
      const holder = /** @type {HTMLElement | null} */ (host ? focused?.closest('[data-more], [data-add], [data-mod], [data-view]') : null);
      const mark = holder ? ['more', 'add', 'mod', 'view'].find((k) => holder.dataset[k] != null) : null;
      const value = mark ? String(holder?.dataset[mark]) : '';
      show(mine, shared);
      if (host && mark) refocus(host, mark, value);
    } catch {
      /* the next turn asks again */
    } finally {
      polling = false;
    }
  }
  setInterval(refreshSkills, SKILLS_EVERY_MS);
  document.addEventListener('visibilitychange', refreshSkills);
  window.addEventListener('focus', refreshSkills);

  /** Focus back on the control redrawn in place of the one that had it — a card's name, for a card. */
  function refocus(host, mark, value) {
    const again = /** @type {HTMLElement[]} */ ([...host.querySelectorAll(`[data-${mark}]`)]).find((el) => el.dataset[mark] === value);
    /** @type {HTMLElement | null} */ (mark === 'view' ? again?.querySelector('.cname') : again)?.focus();
  }

  /** Read somebody's shared skill whole, with Add when it can be added. */
  async function viewShared(id) {
    const { skill } = await api.sharedSkill(id);
    deps.viewSkill(skill, {
      author: skill.author,
      onAdd: skill.mine || skill.added ? undefined : () => addShared(skill.id, skill.name),
    });
  }

  async function addShared(id, name) {
    const { added } = await api.addSharedSkill(id);
    toast(t('skills.addedNamed', { name: added?.knownAs || name }), 'ok');
    await loadSkills();
  }

  /**
   * Yours: what this account made, and what it added from Discover. Synapsez's
   * own are not listed unless the filter asks for them (Created by → Synapsez, or
   * a plugin) — they are always at work, and the + menu offers them.
   */
  function drawSkills() {
    const { skills = [], builtin = [], added = [] } = skillData;
    const theirs = view.by === 'synapsez' || view.plugin !== 'all' ? builtin.map((s) => ({ ...s, kind: 'synapsez' })) : [];
    const mine = skills.map((s) => ({ ...s, kind: 'you', plugin: null }));
    const others = added.map((s) => ({ ...s, kind: 'others', plugin: null, updated_at: s.updatedAt || s.addedAt }));
    const keep = (s) => (view.by === 'all' || view.by === s.kind) && (view.plugin === 'all' || s.plugin === view.plugin);
    const order = (a, b) => {
      if (view.sort === 'name') return a.name.localeCompare(b.name);
      if (view.sort === 'plugin') return pluginName(a.plugin).localeCompare(pluginName(b.plugin)) || a.name.localeCompare(b.name);
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    };
    const ownTag = (s) => [s.enabled ? '' : t('settings.off'), s.hidden_at && s.shared_at ? t('skills.tagHidden') : s.shared_at ? t('skills.tagShared') : ''].filter(Boolean).join(' · ');
    const row = (s) =>
      listRow({
        key: s.id,
        icon: ICON.skill,
        name: s.kind === 'others' ? s.knownAs || s.name : s.name,
        tag: s.kind === 'you' ? ownTag(s) : s.kind === 'others' ? t('skills.tagAdded') : pluginName(s.plugin),
        by: s.kind === 'you' ? t('settings.byYou') : s.kind === 'others' ? authorOf(s.author) : t('settings.fromSynapsez'),
        desc: s.description || '',
        warn: s.kind === 'others' && s.status !== 'ok' ? t(GONE[s.status] || 'skills.goneUnshared') : '',
        meta: s.kind === 'synapsez' ? '' : day(s.updated_at || s.created_at),
        search: `${s.name} ${s.description || ''} ${pluginName(s.plugin)} ${s.author || ''}`,
      });
    const shownTheirs = theirs.filter(keep).sort(order);
    const shownMine = mine.filter(keep).sort(order);
    const shownOthers = others.filter(keep).sort(order);
    const list = document.getElementById('skill-list');
    const ownPart = view.plugin === 'all' && (view.by === 'all' || view.by === 'you');
    const addedPart = view.plugin === 'all' && (view.by === 'others' || (view.by === 'all' && others.length > 0));
    list.innerHTML =
      (shownTheirs.length ? group(t('settings.fromSynapsez'), shownTheirs.length) + shownTheirs.map(row).join('') : '') +
      (ownPart ? group(t('settings.madeByYou'), shownMine.length) + (shownMine.map(row).join('') || empty(t(mine.length ? 'skills.noneMatch' : 'skills.empty'))) : '') +
      (addedPart ? group(t('skills.addedFromDiscover'), shownOthers.length) + (shownOthers.map(row).join('') || empty(t(others.length ? 'skills.noneMatch' : 'skills.noneAdded'))) : '');
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-more]'))) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.more;
        const own = skills.find((s) => s.id === id);
        const took = added.find((s) => s.id === id);
        const built = builtin.find((s) => s.id === id);
        /** @type {MenuItem[]} */
        const items = [];
        if (own) {
          items.push({ label: t('settings.useInMessage'), run: () => useSkill(own.name) });
          items.push({ label: t('skills.edit'), run: () => deps.editSkill(own) });
          // Sharing says what it means before it happens; stopping says who loses it.
          items.push(
            own.shared_at
              ? { label: t('skills.stopSharing'), confirm: t('skills.stopSharingConfirm'), run: () => setShared(own, false) }
              : { label: t('skills.shareToDiscover'), confirm: t('skills.shareConfirm'), run: () => setShared(own, true) },
          );
          items.push({
            label: own.enabled ? t('settings.turnOff') : t('settings.turnOn'),
            run: async () => {
              await api.setSkillEnabled(own.id, !own.enabled);
              await loadSkills();
            },
          });
          items.push({
            label: t('action.delete'),
            danger: true,
            confirm: t(own.shared_at ? 'skills.reallyDeleteShared' : 'action.reallyRemove'),
            run: async () => {
              await api.deleteSkill(own.id);
              await loadSkills();
            },
          });
        } else if (took) {
          if (took.status === 'ok') {
            items.push({ label: t('settings.useInMessage'), run: () => useSkill(took.knownAs || took.name) });
            items.push({ label: t('skills.view'), run: () => viewShared(took.id) });
          }
          items.push({
            label: t('skills.removeAdded'),
            danger: took.status === 'ok',
            run: async () => {
              await api.removeAddedSkill(took.id);
              toast(t('skills.removedNamed', { name: took.name }), 'ok');
              await loadSkills();
            },
          });
        } else if (built) {
          items.push({ label: t('settings.useInMessage'), run: () => useSkill(built.name) });
        }
        openMenu(btn, items);
      });
    }
    refilter('panel-skills');
  }

  /** Share one of the account's own, or stop — a refusal from the safety scan said with what it found. */
  async function setShared(own, shared) {
    try {
      await api.setSkillShared(own.id, shared);
      toast(t(shared ? 'skills.sharedNamed' : 'skills.unsharedNamed', { name: own.name }), 'ok');
    } catch (err) {
      const found = Array.isArray(err.findings) ? err.findings.map((f) => f.text).join(' ') : '';
      toast(found ? `${err.message} ${found}` : err.message, 'error', { ms: 12000 });
    }
    await loadSkills();
  }

  /** One shared skill's card: open it to read, + to add, ✓ once added; a moderator can take it off or put it back. */
  function sharedCard(s, moderator) {
    const action = s.mine
      ? `<span class="ccard__add is-added" role="img" aria-label="${escapeHtml(t('skills.yoursNamed', { name: s.name }))}" title="${escapeHtml(t('skills.yours'))}">${ICON.check}</span>`
      : s.added
        ? `<span class="ccard__add is-added" role="img" aria-label="${escapeHtml(t('skills.addedNamedState', { name: s.name }))}" title="${escapeHtml(t('skills.added'))}">${ICON.check}</span>`
        : `<button class="ccard__add" type="button" data-add="${escapeHtml(s.id)}" aria-label="${escapeHtml(t('settings.addThing', { name: s.name }))}" title="${escapeHtml(t('settings.addThing', { name: s.name }))}">${ICON.add}</button>`;
    const by = s.mine ? t('settings.byYou') : authorOf(s.author);
    const hiddenTag = moderator && (s.hidden || s.authorSuspended) ? ` <span class="crow__tag">${escapeHtml(t(s.hidden ? 'skills.tagHidden' : 'skills.tagSuspended'))}</span>` : '';
    const mod = moderator && !s.authorSuspended ? `<button class="ccard__mod" type="button" data-mod="${escapeHtml(s.id)}">${escapeHtml(t(s.hidden ? 'skills.showOnDiscover' : 'skills.hideFromDiscover'))}</button>` : '';
    return `<div class="ccard ccard--open cust-item" data-view="${escapeHtml(s.id)}" data-search="${escapeHtml(`${s.name} ${s.description} ${s.author || ''}`.toLowerCase())}">
      <span class="ccard__icon">${ICON.skill}</span>
      <div class="ccard__text">
        <p class="ccard__name"><button class="cname" type="button">${escapeHtml(s.name)}</button>${hiddenTag}</p>
        <p class="ccard__desc">${escapeHtml(s.description)}</p>
        <p class="ccard__by">${escapeHtml(by)} · ${escapeHtml(day(s.createdAt))}</p>
        ${mod}
      </div>
      ${action}
    </div>`;
  }

  /**
   * Discover: the skills people on this site share, newest made first (owner,
   * 2026-11-09), then a card to make one. Synapsez's own are not here.
   */
  function drawDiscover() {
    const { skills: shared = [], moderator = false } = sharedData;
    const discover = document.getElementById('skill-discover');
    discover.innerHTML =
      (shared.length ? '' : empty(t('skills.discoverEmpty'))) +
      `<div class="cgrid">${shared.map((s) => sharedCard(s, moderator)).join('')}${card({ key: '__new', icon: ICON.add, name: t('plus.newSkill'), desc: t('settings.newSkillHint'), by: t('settings.byYou'), search: t('plus.newSkill') })}</div>`;
    refilter('panel-skills');
  }

  /** Every press in Discover: add, moderate, make one, or open a card to read it — one listener, whatever was drawn. */
  document.getElementById('skill-discover').addEventListener('click', async (event) => {
    const el = /** @type {HTMLElement} */ (event.target);
    try {
      const add = /** @type {HTMLElement | null} */ (el.closest('[data-add]'));
      if (add) {
        if (add.dataset.add === '__new') return showSkillForm();
        const id = String(add.dataset.add);
        /** @type {HTMLButtonElement} */ (add).disabled = true;
        await addShared(id, sharedData.skills.find((s) => s.id === id)?.name || '');
        // The + is now a ✓ that cannot hold focus: the card's name takes it. (Not
        // `event.currentTarget`, which is null once the handler has awaited.)
        return refocus(/** @type {HTMLElement} */ (document.getElementById('skill-discover')), 'view', id);
      }
      const mod = /** @type {HTMLElement | null} */ (el.closest('[data-mod]'));
      if (mod) {
        const s = sharedData.skills.find((x) => x.id === mod.dataset.mod);
        if (!s) return;
        await api.hideSharedSkill(s.id, !s.hidden);
        toast(t(s.hidden ? 'skills.shownAgain' : 'skills.hiddenDone', { name: s.name }), 'ok');
        return await loadSkills();
      }
      // The whole card opens it under a pointer; from the keyboard, the name — a real button.
      const open = /** @type {HTMLElement | null} */ (el.closest('[data-view]'));
      if (open && (!el.closest('a, button, input') || el.closest('.cname'))) await viewShared(String(open.dataset.view));
    } catch (err) {
      toast(err.message, 'error');
      await loadSkills().catch(() => {});
    }
  });

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
        // All is yours and what you added; Synapsez brings its own back into the list.
        sub: () => [
          { label: t('skills.all'), checked: view.by === 'all', run: choose('by', 'all') },
          { label: t('skills.byYou'), checked: view.by === 'you', run: choose('by', 'you') },
          { label: t('skills.byOthers'), checked: view.by === 'others', run: choose('by', 'others') },
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

  /**
   * Settings → Connectors, as Claude's (owner, 2026-11-01): Yours as a table —
   * each connector, its type, where it stands — and Discover as cards, every
   * Google product its own. Pressing one opens its page: what it does, its
   * tools and which of them ask first, who makes it, and what is related.
   * Where each stands is the server's (`/api/connectors/catalog`); what each
   * is, the catalogue's (connector-catalog.js).
   */
  let catalog = { policy: 'guarded', entries: [] };
  let kind = 'all';
  const stateOf = (id) => catalog.entries.find((e) => e.id === id) || null;
  const listed = () => CONNECTORS.filter((c) => stateOf(c.id));
  const tagline = (c) => t(`conn.${c.key}.tagline`);
  const inKind = (c) => kind === 'all' || c.category === kind;
  const BADGE = svg('<path d="M10 2.5 12 4h2.5l.7 2.4L17 8l-.8 2.4.8 2.4-1.8 1.6-.7 2.4H12L10 18l-2-1.2H5.5l-.7-2.4L3 12.8l.8-2.4L3 8l1.8-1.6.7-2.4H8Z"/><path d="m7.2 10.2 1.9 1.9 3.8-4"/>', 15);
  const RELOAD = svg('<path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5V6h-2.5"/>', 17);
  const LINK_OUT = svg('<path d="M8 5h7v7M15 5l-9 9"/>', 13);
  const INFO = svg('<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.5h.01"/>', 18);

  /** A connector's logo on its tile, through this app's favicon route; its first letter when there is none. */
  const logo = (c, size) => {
    // A Google product wears its own mark; the rest, their site's icon.
    const src = c.product ? `/api/connectors/icon/${encodeURIComponent(c.product)}` : `/api/favicon/${encodeURIComponent(c.site)}`;
    return `<span class="clogo clogo--${size}"><img src="${src}" alt="" loading="lazy" decoding="async" data-mono="${escapeHtml(c.name.charAt(0))}" /></span>`;
  };
  function settleLogos(root) {
    for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (root.querySelectorAll('.clogo img[data-mono]'))) {
      img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'crow__mono', textContent: img.dataset.mono })), { once: true });
    }
  }

  async function loadConnectors() {
    catalog = await api.connectorCatalog();
    drawYours();
    drawConnectorDiscover();
  }

  /** Yours: what this account has — and, once Google is connected, its other products one press away. */
  function drawYours() {
    const googleIn = catalog.entries.some((e) => e.id.startsWith('google:') && e.connected);
    const rows = listed().filter((c) => {
      const s = stateOf(c.id);
      return inKind(c) && (s.connected || s.paused || (googleIn && c.signIn === 'google' && s.configured));
    });
    rows.sort((a, b) => Number(!!stateOf(b.id).connected) - Number(!!stateOf(a.id).connected));
    const list = document.getElementById('connector-list');
    if (!rows.length) {
      list.innerHTML = `<div class="settings__empty"><p>${escapeHtml(t('conn.none'))}</p><button class="btn btn--small" type="button" data-cust-goto="discover">${escapeHtml(t('conn.browse'))}</button></div>`;
      return;
    }
    const status = (c) => {
      const s = stateOf(c.id);
      if (s.paused) return `<span class="ctable__paused">${escapeHtml(t('conn.paused'))}</span><button class="btn btn--small" type="button" data-turn-on="${escapeHtml(c.id)}">${escapeHtml(t('conn.turnOn'))}</button>`;
      if (s.connected) return `<span class="ctable__ok" title="${escapeHtml(t('conn.connected'))}">${ICON.check}<span class="sr-only">${escapeHtml(t('conn.connected'))}</span></span>`;
      return `<button class="btn btn--small" type="button" data-connect-now="${escapeHtml(c.id)}">${escapeHtml(t('conn.connect'))}</button>`;
    };
    list.innerHTML = `<div class="ctable ctable--conn" role="table" aria-label="${escapeHtml(t('settings.tab.connectors'))}">
      <div class="ctable__head" role="row"><span role="columnheader">${escapeHtml(t('conn.colConnector'))}</span><span role="columnheader">${escapeHtml(t('conn.colType'))}</span><span role="columnheader">${escapeHtml(t('conn.colStatus'))}</span></div>
      ${rows
        .map(
          (c) => `<div class="ctable__row ctable__row--open cust-item" role="row" data-open-connector="${escapeHtml(c.id)}" data-search="${escapeHtml(`${c.name} ${c.by} ${tagline(c)}`.toLowerCase())}">
            <span role="cell" class="ctable__name">${logo(c, 'sm')}<button class="cname" type="button">${escapeHtml(c.name)}</button></span>
            <span role="cell" class="crow__desc">${escapeHtml(t('conn.typeWeb'))}</span>
            <span role="cell" class="ctable__status">${status(c)}</span>
          </div>`,
        )
        .join('')}
    </div>`;
    settleLogos(list);
    refilter('panel-connectors');
  }

  /** One connector's card — in Discover and under Related — with + to connect, ✓ when it is, ↻ when paused. */
  function connectorCard(c) {
    const s = stateOf(c.id) || {};
    const button = s.paused
      ? `<button class="ccard__add" type="button" data-turn-on="${escapeHtml(c.id)}" title="${escapeHtml(t('conn.turnOn'))}" aria-label="${escapeHtml(t('conn.turnOnName', { name: c.name }))}">${RELOAD}</button>`
      : s.connected
        ? `<span class="ccard__add is-added" role="img" aria-label="${escapeHtml(t('conn.connectedName', { name: c.name }))}" title="${escapeHtml(t('conn.connected'))}">${ICON.check}</span>`
        : `<button class="ccard__add" type="button" data-connect-now="${escapeHtml(c.id)}" title="${escapeHtml(t('conn.connectName', { name: c.name }))}" aria-label="${escapeHtml(t('conn.connectName', { name: c.name }))}">${ICON.add}</button>`;
    return `<div class="ccard ccard--ext ccard--open cust-item" data-open-connector="${escapeHtml(c.id)}" data-search="${escapeHtml(`${c.name} ${c.by} ${tagline(c)}`.toLowerCase())}">
      <span class="ccard__icon ccard__icon--logo">${logo(c, 'md')}</span>
      <div class="ccard__text">
        <p class="ccard__name"><button class="cname" type="button">${escapeHtml(c.name)}</button> <span class="ccard__badge" title="${escapeHtml(t('ext.publishedBy', { by: c.by }))}">${BADGE}</span></p>
        <p class="ccard__desc">${escapeHtml(tagline(c))}</p>
        <p class="ccard__by">${escapeHtml(t('ext.by', { by: c.by }))}</p>
      </div>
      ${button}
    </div>`;
  }

  /** Discover: Google Workspace, then the rest — each counted, nothing ranked by figures there are none of. */
  function drawConnectorDiscover() {
    const shown = listed().filter(inKind);
    const google = shown.filter((c) => c.signIn === 'google');
    const rest = shown.filter((c) => c.signIn !== 'google');
    const part = (title, items) =>
      items.length
        ? `<div class="cust__grouprow"><p class="cust__group">${escapeHtml(title)} <span class="cust__count">${items.length}</span></p></div><div class="cgrid cgrid--ext">${items.map(connectorCard).join('')}</div>`
        : '';
    const discover = document.getElementById('connector-discover');
    discover.innerHTML = part(t('conn.google'), google) + part(t('conn.more'), rest) || empty(t('conn.noneOfKind'));
    if (google.length) discover.querySelector('.cust__grouprow')?.setAttribute('id', 'conn-google');
    settleLogos(discover);
    refilter('panel-connectors');
  }

  /** Connect: Google's sign-in for that one product, or the page with its token box open. */
  function connectNow(id) {
    const c = CONNECTOR_BY_ID.get(id);
    const s = stateOf(id);
    if (!c || !s) return;
    if (c.signIn === 'google') {
      if (!s.configured) return toast(s.help || t('conn.notSetUp'), 'error');
      location.href = `/api/connectors/google/start?products=${encodeURIComponent(c.product || '')}`;
      return;
    }
    showConnectorPage(id, { form: true });
  }

  /** A connector paused in the + menu, on again — a Google product turns all of Google back on, as pausing it did. */
  async function turnOn(id) {
    const key = id.startsWith('google:') ? 'google' : id;
    await deps.savePrefs({ connectorsOff: (deps.prefs().connectorsOff || []).filter((x) => x !== key) });
    toast(t('consug.on', { name: CONNECTOR_BY_ID.get(id)?.name || id }), 'ok');
    await loadConnectors();
    if (document.getElementById('panel-connector').classList.contains('is-active')) showConnectorPage(id);
  }

  async function disconnectOne(id) {
    const c = CONNECTOR_BY_ID.get(id);
    if (c?.signIn === 'google') await api.disconnectGoogleProduct(c.product);
    else await api.disconnect(id);
    toast(t('conn.disconnected', { name: c?.name || id }), 'ok');
    await loadConnectors();
    showConnectorPage(id);
  }

  /** The page of one connector — Claude's: the hero, what it does, its tools, who makes it, and related ones. */
  let pageId = '';
  async function showConnectorPage(id, { form = false } = {}) {
    const c = CONNECTOR_BY_ID.get(id);
    if (!c) return;
    if (!catalog.entries.length) catalog = await api.connectorCatalog();
    const s = stateOf(id) || { tools: [] };
    pageId = id;
    deps.selectTab('connector');
    const host = /** @type {HTMLElement} */ (document.getElementById('connector-page'));
    const action = s.paused
      ? `<span class="cpage__state">${escapeHtml(t('conn.paused'))}</span><button class="btn btn--light" type="button" data-turn-on="${escapeHtml(id)}">${escapeHtml(t('conn.turnOn'))}</button>`
      : s.connected
        ? `<span class="cpage__state">${ICON.check}${escapeHtml(t('conn.connected'))}</span><button class="icon-btn cpage__more" type="button" id="connector-more" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(t('settings.moreFor', { name: c.name }))}">${ICON.more}</button>`
        : s.configured
          ? `<button class="btn btn--light cpage__connect" type="button" data-connect-now="${escapeHtml(id)}">${escapeHtml(t('conn.connect'))}</button>`
          : `<button class="btn" type="button" disabled>${escapeHtml(t('conn.notSetUp'))}</button>`;
    const tokenForm =
      c.signIn === 'token' && !s.connected
        ? `<div class="cpage__form" id="connector-form" ${form ? '' : 'hidden'}>
            <p class="crow__desc">${escapeHtml(s.help || '')}</p>
            <div class="settings__actions">
              <input class="sinput" type="password" id="connector-token" placeholder="${escapeHtml(s.placeholder || '')}" aria-label="${escapeHtml(t('settings.tokenFor', { name: c.name }))}" autocomplete="off" />
              <button class="btn btn--primary btn--small" type="button" id="connector-save">${escapeHtml(t('conn.connect'))}</button>
            </div>
          </div>`
        : '';
    const help = !s.configured && s.help ? `<p class="cpage__note">${escapeHtml(s.help)}</p>` : '';
    host.innerHTML = `
      <button class="data__back" type="button" data-goto="connectors">${svg('<path d="M16 10H4M9 5l-5 5 5 5"/>', 16)}<span>${escapeHtml(t('settings.tab.connectors'))}</span></button>
      <div class="cpage__hero">
        <span class="ccard__icon ccard__icon--logo cpage__logo">${logo(c, 'lg')}</span>
        <div class="cpage__title">
          <h3>${escapeHtml(c.name)} <span class="ccard__badge" title="${escapeHtml(t('ext.publishedBy', { by: c.by }))}">${BADGE}</span></h3>
          <p>${escapeHtml(tagline(c))}</p>
        </div>
        <div class="cpage__actions">${action}</div>
      </div>
      ${tokenForm}${help}
      ${c.key === 'telegram' && s.connected ? '<section class="cpage__tg tgin" id="tg-inbound" aria-live="polite"></section>' : ''}
      <p class="cpage__about">${escapeHtml(t(`conn.${c.key}.about`))}</p>
      <div class="cpage__toolsrow">
        <h4>${escapeHtml(t('conn.tools'))}</h4>
        <button class="btn btn--small" type="button" id="connector-perms" aria-haspopup="dialog" aria-expanded="false">${escapeHtml(t('conn.permissions'))}</button>
      </div>
      <div class="cpage__chips">${(s.tools || []).map((tool) => `<span class="cpage__chip${tool.asks ? ' is-asks' : ''}">${escapeHtml(tool.name)}</span>`).join('')}</div>
      <div class="cpage__trust">${INFO}<p>${escapeHtml(t('conn.trust'))}</p></div>
      <dl class="cpage__meta">
        <div><dt>${escapeHtml(t('conn.madeBy'))}</dt><dd><a href="${escapeHtml(c.byUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.by)} ${LINK_OUT}</a></dd></div>
        <div><dt>${escapeHtml(t('conn.url'))}</dt><dd class="cpage__mono">${escapeHtml(c.api)}</dd></div>
        <div><dt>${escapeHtml(t('conn.category'))}</dt><dd><span class="cpage__cat">${escapeHtml(t(`conn.cat.${c.category}`))}</span></dd></div>
        <div><dt>${escapeHtml(t('conn.signIn'))}</dt><dd>${escapeHtml(t(c.signIn === 'google' ? 'conn.signInGoogle' : 'conn.signInToken'))}</dd></div>
        ${s.connected && s.account ? `<div><dt>${escapeHtml(t('conn.account'))}</dt><dd>${escapeHtml(s.account)}</dd></div>` : ''}
        <div><dt>${escapeHtml(t('conn.moreInfo'))}</dt><dd class="cpage__links"><a href="${escapeHtml(c.docs)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('conn.docs'))} ${LINK_OUT}</a><a href="${escapeHtml(c.privacy)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('conn.privacy'))} ${LINK_OUT}</a></dd></div>
      </dl>
      <h4 class="cpage__related">${escapeHtml(t('conn.related'))}</h4>
      <div class="cgrid cgrid--ext">${relatedTo(c, listed()).map(connectorCard).join('')}</div>
      <p class="cpage__foot">${escapeHtml(t('conn.foot'))}</p>`;
    settleLogos(host);
    // Telegram to Chief, on the Telegram connector's own page (spec C.3).
    const tgHost = /** @type {HTMLElement | null} */ (host.querySelector('#tg-inbound'));
    if (tgHost) void mountTelegramInbound(tgHost, { toast });
    document.getElementById('connector-more')?.addEventListener('click', (event) =>
      openMenu(/** @type {HTMLElement} */ (event.currentTarget), [
        { label: t('conn.disconnect'), danger: true, confirm: t('connectors.reallyDisconnect'), run: () => disconnectOne(id) },
      ]),
    );
    document.getElementById('connector-perms').addEventListener('click', (event) => showPermissions(/** @type {HTMLElement} */ (event.currentTarget), s.tools || []));
    document.getElementById('connector-save')?.addEventListener('click', async (event) => {
      const button = /** @type {HTMLButtonElement} */ (event.currentTarget);
      const field = /** @type {HTMLInputElement} */ (document.getElementById('connector-token'));
      button.disabled = true;
      try {
        const { account, saved } = await api.connect(id, field.value);
        // Recognised by its shape (server keyIntake.js): another connector's
        // token went to that connector, a provider's key to Providers — said so.
        if (saved?.kind === 'provider') {
          const names = { openrouter: 'OpenRouter', google: 'Google Gemini', orcarouter: 'OrcaRouter', anthropic: 'Anthropic', openai: 'OpenAI' };
          toast(t('conn.wasProviderKey', { provider: names[saved.id] || saved.id }), 'ok', { ms: 9000 });
          await deps.keySaved();
          field.value = '';
          button.disabled = false;
          return;
        }
        const landed = saved?.kind === 'service' ? saved.id : id;
        if (landed !== id) toast(t('conn.movedTo', { from: c.name, to: CONNECTOR_BY_ID.get(landed)?.name || landed, account: account || '' }), 'ok', { ms: 9000 });
        else toast(t('connectors.connectedAs', { account }), 'ok');
        await loadConnectors();
        showConnectorPage(landed);
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
    });
    if (form) /** @type {HTMLElement | null} */ (document.getElementById('connector-token'))?.focus();
    document.querySelector('#settings .settings__body')?.scrollTo({ top: 0 });
  }

  /** Your tool permissions: each tool, and whether it runs at once or asks first — as a turn would treat it. */
  function showPermissions(button, tools) {
    const dialog = button.closest('dialog') || document.body;
    dialog.querySelectorAll(':scope > .cperm').forEach((m) => m.remove());
    const box = document.createElement('div');
    box.className = 'cmenu cperm';
    box.setAttribute('popover', 'auto');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('conn.permissions'));
    box.append(Object.assign(document.createElement('p'), { className: 'cmenu__heading', textContent: t('conn.permsHead') }));
    for (const tool of tools) {
      const row = document.createElement('p');
      row.className = 'cperm__row';
      row.append(Object.assign(document.createElement('span'), { className: 'cperm__name', textContent: tool.name }), Object.assign(document.createElement('span'), { className: `cperm__rule${tool.asks ? ' is-asks' : ''}`, textContent: t(tool.asks ? 'conn.asks' : 'conn.runs') }));
      box.append(row);
    }
    dialog.append(box);
    button.setAttribute('aria-expanded', 'true');
    box.addEventListener('toggle', (event) => {
      if (/** @type {any} */ (event).newState === 'closed') {
        button.setAttribute('aria-expanded', 'false');
        // Focus was in the box (UI-012); it goes back to the button, not the page.
        const hadFocus = box.contains(document.activeElement);
        box.remove();
        if (hadFocus) button.focus();
      }
    });
    box.showPopover?.();
    const at = button.getBoundingClientRect();
    box.style.top = `${Math.min(at.bottom + 6, window.innerHeight - box.offsetHeight - 8)}px`;
    box.style.left = `${Math.max(8, at.right - box.offsetWidth)}px`;
    // A dialog that opens takes focus, so its rules are read and Escape closes it.
    box.tabIndex = -1;
    box.focus();
  }

  /** Every press in the two panels: open a page, connect, turn on — one listener, whatever was drawn. */
  for (const id of ['panel-connectors', 'panel-connector']) {
    const panel = /** @type {HTMLElement} */ (document.getElementById(id));
    panel.addEventListener('click', (event) => {
      const el = /** @type {HTMLElement} */ (event.target);
      const connect = /** @type {HTMLElement | null} */ (el.closest('[data-connect-now]'));
      if (connect) return connectNow(/** @type {string} */ (connect.dataset.connectNow));
      const on = /** @type {HTMLElement | null} */ (el.closest('[data-turn-on]'));
      if (on) return turnOn(/** @type {string} */ (on.dataset.turnOn)).catch((err) => toast(err.message, 'error'));
      const open = /** @type {HTMLElement | null} */ (el.closest('[data-open-connector]'));
      // The whole row or card opens the page under a pointer; from the keyboard
      // it is the name, a real button (UI-012) — the row and card themselves are
      // no longer focusable, since a focusable box holding buttons is read as one
      // control with the others lost inside it.
      if (open && (!el.closest('a, button, input') || el.closest('.cname'))) showConnectorPage(/** @type {string} */ (open.dataset.openConnector));
    });
  }

  document.getElementById('connector-copy').addEventListener('click', async () => {
    const link = `${location.origin}/#connector=${encodeURIComponent(pageId)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast(t('conn.linkCopied'), 'ok');
    } catch {
      toast(`${t('data.linkIs')} ${link}`, 'ok', { ms: 12000 });
    }
  });

  /** Filter by: the kind of connector — files, mail, messaging — both panes at once. */
  document.getElementById('connectors-filter').addEventListener('click', (event) => {
    const choose = (value) => () => {
      kind = value;
      drawYours();
      drawConnectorDiscover();
    };
    const kinds = [...new Set(listed().map((c) => c.category))];
    openMenu(/** @type {HTMLElement} */ (event.currentTarget), [
      { heading: t('skills.filterBy') },
      { label: t('skills.all'), checked: kind === 'all', run: choose('all') },
      ...CATEGORIES.filter((k) => kinds.includes(k)).map((k) => ({ label: t(`conn.cat.${k}`), checked: kind === k, run: choose(k) })),
    ]);
  });

  /** + Add: browse what there is, or add an MCP server by hand. */
  document.getElementById('connectors-add').addEventListener('click', (event) => {
    openMenu(/** @type {HTMLElement} */ (event.currentTarget), [
      { label: t('conn.browse'), run: () => /** @type {HTMLElement} */ (document.querySelector('#panel-connectors [data-cust-view="discover"]')).click() },
      { label: t('conn.addMcp'), run: () => deps.addMcpServer() },
    ]);
  });

  /**
   * One connector, open and ready — for Connect pressed on a card the assistant
   * showed (owner, 2026-11-01). A service: its page, its token box open when it
   * is not connected. Google: Discover, at Google Workspace.
   */
  async function showConnector(id) {
    await loadConnectors();
    if (id !== 'google') return showConnectorPage(id, { form: !stateOf(id)?.connected });
    /** @type {HTMLElement} */ (document.querySelector('#panel-connectors [data-cust-view="discover"]')).click();
    document.getElementById('conn-google')?.scrollIntoView({ block: 'start' });
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

  return { loadSkills, loadConnectors, showConnector, showConnectorPage, paintPlugins, setPlugin, showSkillForm, shareByDefault: () => skillData.shareByDefault === true };
}
