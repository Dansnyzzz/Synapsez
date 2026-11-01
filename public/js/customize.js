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
 * item: they read as radio items, the chosen one ticked.
 *
 * @param {HTMLElement} button
 * @param {{ label: string, run: () => any, danger?: boolean, confirm?: string, checked?: boolean }[]} items
 */
export function openMenu(button, items) {
  const dialog = button.closest('dialog') || document.body;
  dialog.querySelector('.cmenu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'cmenu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('popover', 'auto');
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `cmenu__item${item.danger ? ' is-danger' : ''}${item.checked != null ? ' cmenu__item--check' : ''}`;
    row.setAttribute('role', item.checked != null ? 'menuitemradio' : 'menuitem');
    if (item.checked != null) row.setAttribute('aria-checked', String(!!item.checked));
    row.textContent = item.label;
    let armedOnce = false;
    row.addEventListener('click', async () => {
      // Something that cannot be undone asks twice, as every delete here does.
      if (item.confirm && !armedOnce) {
        armedOnce = true;
        row.textContent = item.confirm;
        return;
      }
      menu.hidePopover?.();
      menu.remove();
      try {
        await item.run();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    menu.append(row);
  }
  dialog.append(menu);
  button.setAttribute('aria-expanded', 'true');
  menu.addEventListener('toggle', (event) => {
    if (/** @type {any} */ (event).newState === 'closed') {
      button.setAttribute('aria-expanded', 'false');
      menu.remove();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const rows = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('.cmenu__item')]);
    const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
    }
  });
  menu.showPopover?.();
  const at = button.getBoundingClientRect();
  menu.style.top = `${Math.min(at.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, at.right - menu.offsetWidth)}px`;
  /** @type {HTMLElement | null} */ (menu.querySelector('.cmenu__item'))?.focus();
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

  for (const panel of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#panel-skills, #panel-connectors, #panel-plugins'))) {
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

  async function loadSkills() {
    const { skills = [], builtin = [] } = await api.skills();
    const own = skills.map((s) =>
      listRow({
        key: s.id,
        icon: ICON.skill,
        name: s.name,
        tag: s.enabled ? '' : t('settings.off'),
        by: t('settings.byYou'),
        desc: s.description,
        meta: s.used_count ? t('skills.used', { n: s.used_count }) : day(s.updated_at || s.created_at),
        search: `${s.name} ${s.description}`,
      }),
    );
    const theirs = builtin.map((s) =>
      listRow({ key: s.id, icon: ICON.skill, name: s.name, by: t('settings.fromSynapsez'), desc: s.description, search: `${s.name} ${s.description}` }),
    );
    const list = document.getElementById('skill-list');
    list.innerHTML =
      (theirs.length ? group(t('settings.fromSynapsez'), theirs.length) + theirs.join('') : '') +
      group(t('settings.madeByYou'), own.length) +
      (own.join('') || empty(t('skills.empty')));
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('[data-more]'))) {
      btn.addEventListener('click', () => {
        const mine = skills.find((s) => s.id === btn.dataset.more);
        const built = builtin.find((s) => s.id === btn.dataset.more);
        const name = (mine || built)?.name;
        const items = [{ label: t('settings.useInMessage'), run: () => useSkill(name) }];
        if (mine) {
          items.push({
            label: mine.enabled ? t('settings.turnOff') : t('settings.turnOn'),
            run: async () => {
              await api.setSkillEnabled(mine.id, !mine.enabled);
              loadSkills();
            },
          });
          items.push({
            label: t('action.delete'),
            danger: true,
            confirm: t('action.reallyRemove'),
            run: async () => {
              await api.deleteSkill(mine.id);
              loadSkills();
            },
          });
        }
        openMenu(btn, items);
      });
    }

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

  /** The form for a new skill, opened from + Add, from Discover, or from the + menu's "Create a skill". */
  function showSkillForm(open = true) {
    const form = document.getElementById('skill-form');
    form.hidden = !open;
    document.getElementById('skill-add-open').setAttribute('aria-expanded', String(open));
    if (open) /** @type {HTMLElement} */ (document.getElementById('skill-name')).focus();
  }
  document.getElementById('skill-add-open').addEventListener('click', () => showSkillForm(Boolean(document.getElementById('skill-form').hidden)));

  document.getElementById('skill-save').addEventListener('click', async () => {
    const status = document.getElementById('skill-status');
    const field = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
    try {
      const { skill } = await api.saveSkill({ name: field('skill-name').value, description: field('skill-description').value, instructions: field('skill-instructions').value });
      status.textContent = t('skills.savedNamed', { name: skill.name });
      for (const id of ['skill-name', 'skill-description', 'skill-instructions']) field(id).value = '';
      loadSkills();
    } catch (err) {
      status.textContent = err.message;
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
