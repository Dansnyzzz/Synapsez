import { t, currentLanguage } from './i18n.js';
import { api } from './api.js';
import { toast, describeStep } from './render.js';
import { closeMenu } from './menu.js';
import { PLUGINS } from './plugins.js';

/**
 * The + beside the message box, the way Claude's works (owner, 2026-10-14).
 *
 * One menu for both places a message is written — a conversation's composer
 * and a project's — so the two can never offer different things:
 *
 *   Add files or photos
 *   Skills ›       built-in and your own; picking one rides on the message
 *   Connectors ›   add, manage, switch each one on or off, Google Drive,
 *                  and whether tools are loaded up front
 *   Plugins ›      families of built-in tools, each one switchable
 *
 * A cascade of panels rather than one long list: hovering a row with › opens
 * the next panel beside it, as in Claude, and so does a click or a tap (hover
 * does not exist on a phone) and → on the keyboard. Too narrow for panels side
 * by side, each one replaces the last with a ‹ Back row instead.
 *
 * Every name drawn here — a skill, a connector, an MCP server, a Drive file —
 * is somebody's own text, so labels are text nodes, never markup.
 *
 * @typedef {{
 *   id?: string, label?: string, detail?: string, title?: string, icon?: string, tag?: string,
 *   checked?: boolean, warn?: string, note?: string, radio?: boolean, external?: boolean,
 *   run?: () => any, select?: () => Promise<any>,
 *   sub?: (row: HTMLElement) => Item[] | Promise<Item[]>,
 *   toggle?: { on: boolean, set: (on: boolean) => Promise<any> },
 *   render?: (panel: Panel, focus: boolean) => HTMLElement,
 * } | null} Item
 * @typedef {{ node: HTMLElement, level: number, parent: HTMLElement|null }} Panel
 * @typedef {{
 *   pickFiles: () => void,
 *   pickSkill: (name: string) => void,
 *   picked: () => string[],
 *   attach: (attachment: any) => void,
 *   prefs: () => Record<string, any>,
 *   savePrefs: (patch: Record<string, any>) => Promise<any>,
 *   openSettings: (tab: string, focusId?: string) => void,
 * }} Deps
 */

const svg = (paths, size = 17) =>
  `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICON = {
  files: svg('<path d="m15.6 9.2-5.9 5.9a3.6 3.6 0 0 1-5.1-5.1l6.4-6.4a2.4 2.4 0 0 1 3.4 3.4l-6.4 6.4a1.2 1.2 0 0 1-1.7-1.7l5.9-5.9"/>'),
  skills: svg('<path d="M6 3h8a2 2 0 0 1 2 2v1H8"/><path d="M8 6v9a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1h2"/><path d="M8 17h7a2 2 0 0 0 2-2V6"/><path d="M10.5 9.5h4M10.5 12.5h4"/>'),
  connectors: svg('<rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="11" width="6" height="6" rx="1.2"/><path d="M14 3v6M11 6h6"/><rect x="3" y="11" width="6" height="6" rx="1.2"/>'),
  plugins: svg('<path d="M7 3v3M13 3v3"/><path d="M5 6h10v3a5 5 0 0 1-10 0Z"/><path d="M10 14v3"/>'),
  plugin: svg('<path d="M7.5 3h5v3.2a1.6 1.6 0 1 0 3.2 0V3H17v14H3V3h1.3v3.2a1.6 1.6 0 1 0 3.2 0Z"/>'),
  add: svg('<path d="M10 4v12M4 10h12"/>'),
  manage: svg('<rect x="3" y="6" width="14" height="10" rx="1.6"/><path d="M7.5 6V4.6A1.1 1.1 0 0 1 8.6 3.5h2.8a1.1 1.1 0 0 1 1.1 1.1V6M3 10.5h14"/>'),
  browse: svg('<path d="M4 16V7l3-3 3 3v9M10 16V9l3-3 3 3v7M3 16h14"/>'),
  dots: svg('<circle cx="5" cy="10" r=".9"/><circle cx="10" cy="10" r=".9"/><circle cx="15" cy="10" r=".9"/>'),
  drive: svg('<path d="M7.2 3.5h5.6l4.2 7.3-2.8 4.9H5.8L3 10.8Z"/><path d="m7.2 3.5 4.2 7.3H17M12.8 3.5 5.8 15.7M3 10.8h8.4"/>'),
  tools: svg('<circle cx="9" cy="9" r="5.2"/><path d="m13 13 3.5 3.5"/>'),
  file: svg('<path d="M11.5 3H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 17h8a1.5 1.5 0 0 0 1.5-1.5V7Z"/><path d="M11.5 3v4h4"/>'),
  back: svg('<path d="m12 5-5 5 5 5"/>', 15),
  external: svg('<path d="M11.5 3.5H16.5V8.5M16.5 3.5 9.5 10.5"/><path d="M14.5 11.5v3.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5h3.5"/>', 15),
};

/** The plugin names, by key literal so the dictionary check sees every one. */
const PLUGIN_LABEL = {
  office: 'plugin.office',
  visuals: 'plugin.visuals',
  cloud_computer: 'plugin.cloud_computer',
  cloud_browser: 'plugin.cloud_browser',
  research: 'plugin.research',
  places: 'plugin.places',
  data: 'plugin.data',
  automation: 'plugin.automation',
};

/**
 * What is open: the button it hangs from, and its panels, outermost first. One
 * at a time across every menu drawn this way — the + and the account menu.
 *
 * @type {{ anchor: HTMLElement, label: string, className: string, panels: Panel[], hover: any, connections: Promise<any> | null } | null}
 */
let open = null;

/** Too narrow for panels side by side: each one replaces the last. */
const narrow = () => window.innerWidth < 640;

const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

/** Shut every panel. Safe to call when none is open. */
export function closePlus() {
  if (!open) return;
  const was = open;
  open = null;
  clearTimeout(was.hover);
  for (const panel of was.panels) panel.node.remove();
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', replace);
  window.removeEventListener('scroll', onScroll, true);
  was.anchor.setAttribute('aria-expanded', 'false');
  // Back where it started, unless focus has deliberately gone somewhere else.
  if (!document.activeElement || document.activeElement === document.body) was.anchor.focus({ preventScroll: true });
}

/**
 * Open the menu from `anchor`, or close it when it is already open from there
 * — a second press on the + means "put it away".
 *
 * @param {HTMLElement} anchor
 * @param {Deps} deps
 */
export function openPlusMenu(anchor, deps) {
  const connections = loadConnections();
  const root = openCascade(anchor, rootItems(deps), t('plus.open'), { connections });
  if (!root) return;

  // Said on the Connectors row as soon as it is known, the way Claude puts ⚠ 1 there.
  const mine = open;
  connections.then((data) => {
    if (open !== mine) return;
    const broken = brokenServers(data).length;
    const row = root.node.querySelector('[data-row="connectors"] .plusmenu__tag');
    if (row && broken) {
      row.textContent = `⚠ ${broken}`;
      row.classList.add('is-warn');
    }
  });
}

/**
 * A menu of these panels from any button — the + beside the message box, the
 * account at the foot of the sidebar (owner, 2026-10-26) — or nothing, closing
 * it, when it is already open from there.
 *
 * @param {HTMLElement} anchor
 * @param {Item[]} items  the first panel's rows
 * @param {string} label  what a screen reader calls the first panel
 * @param {{ connections?: Promise<any> | null, className?: string }} [options]
 *   the + menu's connections, read once per opening; a class on every panel
 * @returns {Panel | null}
 */
export function openCascade(anchor, items, label, { connections = null, className = '' } = {}) {
  const again = open?.anchor === anchor;
  closePlus();
  if (again) return null;
  closeMenu();

  open = { anchor, label, className, panels: [], hover: null, connections };
  anchor.setAttribute('aria-expanded', 'true');
  const root = showPanel(items, 0, null, true);

  // Registered on a later frame: the click that opened the menu is still travelling.
  const mine = open;
  requestAnimationFrame(() => {
    if (open !== mine) return;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', replace);
    window.addEventListener('scroll', onScroll, true);
  });
  return root;
}

/* ── what is in it ──────────────────────────────────────────────── */

/** @param {Deps} deps @returns {Item[]} */
function rootItems(deps) {
  return [
    { label: t('plus.files'), icon: ICON.files, run: () => deps.pickFiles() },
    null,
    { label: t('plus.skills'), icon: ICON.skills, sub: () => skillItems(deps) },
    { id: 'connectors', label: t('plus.connectors'), icon: ICON.connectors, tag: '', sub: () => connectorItems(deps) },
    { label: t('plus.plugins'), icon: ICON.plugins, sub: () => pluginItems(deps) },
  ];
}

/** Built-in skills first, then the account's own that are switched on. */
async function skillItems(deps) {
  const { skills = [], builtin = [] } = await api.skills();
  const picked = new Set(deps.picked());
  const list = [...builtin, ...skills.filter((s) => s.enabled)];
  return [
    ...list.map((s) => ({
      label: s.name,
      title: s.description,
      icon: ICON.skills,
      checked: picked.has(s.name),
      run: () => deps.pickSkill(s.name),
    })),
    null,
    { label: t('plus.manageSkills'), icon: ICON.manage, run: () => deps.openSettings('skills') },
    { label: t('plus.newSkill'), icon: ICON.add, run: () => deps.openSettings('skills', 'skill-name') },
  ];
}

/** Every connection this account has, read once per opening. */
async function loadConnections() {
  const [linked, servers] = await Promise.allSettled([api.connectors(), api.mcpServers()]);
  return {
    connectors: linked.status === 'fulfilled' ? linked.value.connectors || [] : [],
    servers: servers.status === 'fulfilled' ? servers.value.servers || [] : [],
    status: servers.status === 'fulfilled' ? servers.value.status || [] : [],
  };
}

/** The MCP server's slug, as its tools are prefixed — what the status list is keyed by. */
const slugOf = (server) => String(server.prefix || '').replace(/^mcp__/, '').replace(/__$/, '');

/** Switched-on servers that could not be reached, with why. */
function brokenServers(data) {
  const live = new Map(data.status.map((s) => [s.id, s]));
  return data.servers.filter((s) => s.enabled !== false && live.get(slugOf(s))?.error).map((s) => ({ server: s, error: live.get(slugOf(s)).error }));
}

/** A list in the account's prefs, with one id added or taken out, saved. */
async function saveListed(deps, key, id, on) {
  const now = new Set(deps.prefs()[key] || []);
  if (on) now.delete(id);
  else now.add(id);
  await deps.savePrefs({ [key]: [...now] });
}

/** @param {Deps} deps */
async function connectorItems(deps) {
  const data = await open?.connections;
  if (!data) return [];
  const off = new Set(deps.prefs().connectorsOff || []);
  const broken = new Map(brokenServers(data).map((b) => [b.server.id, b.error]));
  const linked = data.connectors.filter((c) => c.connected);

  /** @type {Item[]} */
  const items = [
    {
      label: t('plus.addConnector'),
      icon: ICON.add,
      sub: () => [
        { label: t('plus.browseConnectors'), icon: ICON.browse, run: () => deps.openSettings('mcp', 'mcp-catalogue') },
        { label: t('plus.customConnector'), icon: ICON.dots, run: () => deps.openSettings('mcp', 'mcp-name') },
      ],
    },
    { label: t('plus.manageConnectors'), icon: ICON.manage, run: () => deps.openSettings('connectors') },
    null,
  ];

  // Paused rather than removed: the token stays, so switching back on is one press.
  for (const c of linked) {
    items.push({
      label: c.label,
      detail: c.account || '',
      icon: monogram(c.label),
      toggle: { on: !off.has(c.id), set: (on) => saveListed(deps, 'connectorsOff', c.id, on) },
    });
  }
  for (const server of data.servers) {
    const error = broken.get(server.id);
    items.push(
      error
        ? { label: server.name, icon: monogram(server.name), warn: error, run: () => deps.openSettings('mcp') }
        : {
            label: server.name,
            icon: monogram(server.name),
            toggle: {
              on: server.enabled !== false,
              set: async (on) => {
                await api.setMcpEnabled(server.id, on);
                // The list is read once per opening; coming back to this panel must show what was just set.
                server.enabled = on;
              },
            },
          },
    );
  }
  if (!linked.length && !data.servers.length) items.push({ note: t('plus.noConnectors') });
  items.push(null);

  const google = linked.find((c) => c.id === 'google');
  if (google && !off.has('google') && google.products?.some((p) => p.id === 'drive' && p.granted)) {
    items.push({ label: t('plus.drive'), icon: ICON.drive, sub: () => [{ render: (panel, focus) => driveSearch(panel, deps, focus) }] });
  }
  items.push({ label: t('plus.toolAccess'), icon: ICON.tools, sub: () => toolAccessItems(deps) });
  return items;
}

/** @param {Deps} deps @returns {Item[]} */
function toolAccessItems(deps) {
  const all = deps.prefs().toolLoading === 'all';
  return [
    { radio: true, checked: !all, label: t('plus.toolsOnDemand'), detail: t('plus.toolsOnDemandHint'), select: () => deps.savePrefs({ toolLoading: 'auto' }) },
    { radio: true, checked: all, label: t('plus.toolsLoaded'), detail: t('plus.toolsLoadedHint'), select: () => deps.savePrefs({ toolLoading: 'all' }) },
  ];
}

/** Each plugin, with what is inside it one step further — and its switch at the top. */
function pluginItems(deps) {
  const off = new Set(deps.prefs().pluginsOff || []);
  return PLUGINS.map((plugin) => ({
    label: t(PLUGIN_LABEL[plugin.id] || plugin.id),
    icon: ICON.plugin,
    tag: off.has(plugin.id) ? t('plus.pluginOff') : '',
    sub: (row) => [
      {
        label: t('plus.pluginUse'),
        toggle: {
          on: !new Set(deps.prefs().pluginsOff || []).has(plugin.id),
          set: async (on) => {
            await saveListed(deps, 'pluginsOff', plugin.id, on);
            const tag = row.querySelector('.plusmenu__tag');
            if (tag) tag.textContent = on ? '' : t('plus.pluginOff');
          },
        },
      },
      null,
      ...plugin.tools.map((name) => ({ note: describeStep(name, {}).verb })),
    ],
  }));
}

/**
 * Google Drive, searched as you type: the newest files first, then whatever
 * matches. Picking one attaches it to the message being written — the server
 * fetches it (a Doc as .docx) and it arrives like any uploaded file.
 */
function driveSearch(panel, deps, focus) {
  const box = el('div', 'plusmenu__drive');
  const input = /** @type {HTMLInputElement} */ (el('input', 'plusmenu__search'));
  input.type = 'search';
  input.placeholder = t('plus.driveSearch');
  input.setAttribute('aria-label', t('plus.driveSearch'));
  const list = el('div', 'plusmenu__drivelist');
  box.append(input, list);

  let asked = 0;
  let wait = null;
  const load = async (query) => {
    const mine = ++asked;
    list.replaceChildren(loadingRow());
    try {
      const { files } = await api.driveFiles(query);
      if (mine !== asked) return;
      list.replaceChildren(
        ...(files.length
          ? files.map((file) => {
              const when = file.modified
                ? // In the interface's language: 10/1/2026 is January to some and October to others.
                  new Date(file.modified).toLocaleDateString(currentLanguage(), { day: 'numeric', month: 'short', year: 'numeric' })
                : '';
              const row = itemButton({
                label: file.name,
                icon: ICON.file,
                // Someone else's file says whose: one shared with you can be named to look like yours.
                detail: [when, file.sharedBy ? t('plus.sharedBy', { name: file.sharedBy }) : ''].filter(Boolean).join(' · '),
              });
              row.addEventListener('click', async (event) => {
                event.stopPropagation();
                if (row.getAttribute('aria-busy') === 'true') return;
                row.setAttribute('aria-busy', 'true');
                try {
                  const { attachment } = await api.attachDriveFile(file.id);
                  deps.attach(attachment);
                  closePlus();
                } catch (err) {
                  row.removeAttribute('aria-busy');
                  toast(err.message, 'error');
                }
              });
              return row;
            })
          : [noteRow(t('plus.driveEmpty'))]),
      );
    } catch (err) {
      if (mine === asked) list.replaceChildren(noteRow(err.message));
    }
    if (open) place(panel);
  };
  input.addEventListener('input', () => {
    clearTimeout(wait);
    wait = setTimeout(() => load(input.value.trim()), 300);
  });
  load('');
  if (focus) requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return box;
}

/** A coloured initial for a connection that has no logo of its own here. */
function monogram(name) {
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="plusmenu__mono" aria-hidden="true">${letter.replace(/[<>&"']/g, '')}</span>`;
}

/* ── drawing ────────────────────────────────────────────────────── */

const loadingRow = () => {
  const row = el('div', 'plusmenu__note');
  row.append(el('span', 'spinner'), document.createTextNode(` ${t('common.loading')}`));
  return row;
};

const noteRow = (text) => {
  const row = el('div', 'plusmenu__note');
  row.textContent = text;
  return row;
};

/** One row, as a button. Its words are text; only the icons are markup, and they are ours. */
function itemButton(item) {
  const row = /** @type {HTMLButtonElement} */ (el('button', 'plusmenu__item'));
  row.type = 'button';
  row.dataset.item = '';
  row.setAttribute('role', item.toggle ? 'menuitemcheckbox' : item.radio ? 'menuitemradio' : 'menuitem');
  if (item.title) row.title = item.title;

  const icon = el('span', 'plusmenu__icon');
  icon.setAttribute('aria-hidden', 'true');
  if (item.icon) icon.innerHTML = item.icon;
  const text = el('span', 'plusmenu__text');
  const label = el('span', 'plusmenu__label');
  label.textContent = item.label || '';
  text.append(label);
  if (item.detail) {
    const detail = el('span', 'plusmenu__detail');
    detail.textContent = item.detail;
    text.append(detail);
  }
  row.append(icon, text);

  if (item.tag !== undefined) {
    const tag = el('span', 'plusmenu__tag');
    tag.textContent = item.tag;
    row.append(tag);
  }
  if (item.warn) {
    row.classList.add('is-warn');
    row.title = item.warn;
    const warn = el('span', 'plusmenu__warn');
    warn.setAttribute('aria-hidden', 'true');
    warn.textContent = '⚠';
    row.append(warn);
    row.setAttribute('aria-label', `${item.label} — ${item.warn}`);
  }
  if (item.toggle) {
    row.setAttribute('aria-checked', String(item.toggle.on));
    row.append(el('span', 'plusmenu__switch'));
  }
  if (item.radio || item.checked) {
    if (item.radio) row.setAttribute('aria-checked', String(!!item.checked));
    const tick = el('span', 'plusmenu__tick');
    tick.setAttribute('aria-hidden', 'true');
    tick.textContent = item.checked ? '✓' : '';
    row.append(tick);
  }
  if (item.sub) {
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-expanded', 'false');
    const more = el('span', 'plusmenu__more');
    more.setAttribute('aria-hidden', 'true');
    more.textContent = '›';
    row.append(more);
  }
  // A page that opens in a new tab says so, as Claude's ↗ does.
  if (item.external) {
    const out = el('span', 'plusmenu__ext');
    out.setAttribute('aria-hidden', 'true');
    out.innerHTML = ICON.external;
    row.append(out);
  }
  return row;
}

/**
 * A panel at `level`, replacing whatever was at that level and beyond.
 *
 * @param {Item[] | Promise<Item[]>} items
 * @param {number} level
 * @param {HTMLElement|null} parent  the row that opened it
 * @param {boolean} focus  move focus into it — not when it was opened by hovering
 */
function showPanel(items, level, parent, focus) {
  while (open.panels.length > level) open.panels.pop().node.remove();
  const node = el('div', 'plusmenu');
  if (open.className) node.classList.add(open.className);
  node.setAttribute('role', 'menu');
  node.dataset.level = String(level);
  if (parent) node.setAttribute('aria-label', parent.querySelector('.plusmenu__label')?.textContent || '');
  else node.setAttribute('aria-label', open.label);
  document.body.append(node);
  /** @type {Panel} */
  const panel = { node, level, parent };
  open.panels.push(panel);
  // Arriving in a panel cancels a close that a row crossed on the way had asked for.
  node.addEventListener('pointerenter', () => clearTimeout(open?.hover));

  if (narrow() && level > 0) {
    const back = itemButton({ label: parent?.querySelector('.plusmenu__label')?.textContent || '', icon: ICON.back });
    back.classList.add('plusmenu__back');
    back.addEventListener('click', (event) => {
      event.stopPropagation();
      closeFrom(level, true);
    });
    node.append(back, el('hr'));
  }

  const fill = (list) => {
    if (!open || !open.panels.includes(panel)) return;
    node.querySelector(':scope > .plusmenu__note.is-loading')?.remove();
    for (const item of list) node.append(drawItem(item, panel, focus));
    place(panel);
    if (focus) firstItem(panel)?.focus({ preventScroll: true });
  };

  if (items && typeof (/** @type {any} */ (items).then) === 'function') {
    const waiting = loadingRow();
    waiting.classList.add('is-loading');
    node.append(waiting);
    place(panel);
    /** @type {Promise<Item[]>} */ (items).then(fill, (err) => {
      if (!open || !open.panels.includes(panel)) return;
      waiting.replaceWith(noteRow(err?.message || String(err)));
      place(panel);
    });
  } else {
    fill(/** @type {Item[]} */ (items));
  }

  // Side by side no longer fits: the panel underneath steps out of the way.
  if (narrow()) open.panels.forEach((p, i) => (p.node.hidden = i < open.panels.length - 1));
  return panel;
}

/** Close the panels from `level` on; with `refocus`, focus goes back to the row that opened them. */
function closeFrom(level, refocus = false) {
  if (!open || level <= 0) return;
  const parent = open.panels[level]?.parent;
  while (open.panels.length > level) open.panels.pop().node.remove();
  for (const p of open.panels) p.node.hidden = false;
  parent?.setAttribute('aria-expanded', 'false');
  if (refocus) parent?.focus({ preventScroll: true });
}

const firstItem = (panel) => /** @type {HTMLElement|null} */ (panel.node.querySelector('[data-item]:not(.plusmenu__back), .plusmenu__search'));

/** @param {Item} item @param {Panel} panel */
function drawItem(item, panel, focus) {
  if (item === null) return el('hr');
  if (item.note !== undefined) return noteRow(item.note);
  if (item.render) return item.render(panel, focus);

  const row = itemButton(item);
  if (item.id) row.dataset.row = item.id;

  const openSub = (byHand) => {
    if (!open) return;
    const level = panel.level + 1;
    if (open.panels[level]?.parent === row) {
      if (byHand) firstItem(open.panels[level])?.focus({ preventScroll: true });
      return;
    }
    for (const sibling of panel.node.querySelectorAll('[aria-expanded="true"]')) sibling.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-expanded', 'true');
    showPanel(item.sub(row), level, row, byHand);
  };
  row.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (item.sub) return openSub(true);
    if (item.toggle) {
      const on = row.getAttribute('aria-checked') !== 'true';
      row.setAttribute('aria-checked', String(on));
      try {
        await item.toggle.set(on);
      } catch (err) {
        row.setAttribute('aria-checked', String(!on));
        toast(err.message, 'error');
      }
      return;
    }
    if (item.radio) {
      if (row.getAttribute('aria-checked') === 'true') return;
      const siblings = [...panel.node.querySelectorAll('[role="menuitemradio"]')];
      const was = siblings.find((s) => s.getAttribute('aria-checked') === 'true');
      const mark = (target) => {
        for (const s of siblings) {
          s.setAttribute('aria-checked', String(s === target));
          const tick = s.querySelector('.plusmenu__tick');
          if (tick) tick.textContent = s === target ? '✓' : '';
        }
      };
      mark(row);
      try {
        await item.select();
      } catch (err) {
        mark(was || null);
        toast(err.message, 'error');
      }
      return;
    }
    closePlus();
    item.run?.();
  });

  // Hovering opens a row's next panel, and moving on to another row closes it —
  // after a moment, so a pointer crossing a row on its way somewhere does neither.
  row.addEventListener('pointerenter', (event) => {
    if (!open || event.pointerType === 'touch') return;
    clearTimeout(open.hover);
    open.hover = setTimeout(() => {
      // Too narrow for panels side by side, a panel replaces the one it came
      // from — so it opens on a press, never because a pointer passed over it.
      if (!open || !open.panels.includes(panel) || narrow()) return;
      if (item.sub) openSub(false);
      else closeFrom(panel.level + 1);
    }, 140);
  });
  return row;
}

/**
 * Where a panel goes: the first beside the +, below it when there is room and
 * above it when not; each next one beside the row that opened it, on the side
 * that has room. Never off the screen; a long list scrolls inside its panel.
 */
function place(panel) {
  if (!open) return;
  const pad = 8;
  const box = panel.node.getBoundingClientRect();
  let left;
  let top;
  if (panel.level === 0 || narrow()) {
    const at = open.anchor.getBoundingClientRect();
    left = at.left;
    const below = at.bottom + 6;
    top = below + box.height <= window.innerHeight - pad ? below : at.top - box.height - 6;
  } else {
    const holder = open.panels[panel.level - 1].node.getBoundingClientRect();
    const row = /** @type {HTMLElement} */ (panel.parent).getBoundingClientRect();
    left = holder.right + 4;
    if (left + box.width > window.innerWidth - pad) left = holder.left - box.width - 4;
    top = row.top - 7;
    if (top + box.height > window.innerHeight - pad) top = window.innerHeight - pad - box.height;
  }
  left = Math.min(Math.max(pad, left), window.innerWidth - box.width - pad);
  top = Math.max(pad, top);
  panel.node.style.left = `${Math.round(left)}px`;
  panel.node.style.top = `${Math.round(top)}px`;
}

/* ── keyboard, and leaving ──────────────────────────────────────── */

function onPointerDown(event) {
  if (!open) return;
  const target = /** @type {Node} */ (event.target);
  if (open.panels.some((p) => p.node.contains(target))) return;
  // The + itself toggles on its own click.
  if (open.anchor.contains(target)) return;
  closePlus();
}

/**
 * Something behind the menu scrolled: the panels follow the + rather than
 * closing. The transcript scrolls by itself while an answer streams in, and a
 * menu that shut on every scroll could not be opened while the assistant was
 * working (found by the interface suite, 2026-10-14). A long list scrolling
 * inside its own panel moves nothing.
 */
let replacing = false;
function onScroll(event) {
  if (!open) return;
  if (open.panels.some((p) => p.node.contains(/** @type {Node} */ (event.target)))) return;
  replace();
}

/**
 * Put every panel back against the +, once a frame at most. Also on a resize —
 * which on a phone is the keyboard opening for the Drive search box, and a
 * menu that closed then could never be typed into.
 */
function replace() {
  if (!open || replacing) return;
  replacing = true;
  requestAnimationFrame(() => {
    replacing = false;
    if (!open) return;
    // An anchor scrolled out of sight has nothing left to hang from.
    const at = open.anchor.getBoundingClientRect();
    if (at.bottom < 0 || at.top > window.innerHeight) return closePlus();
    for (const panel of open.panels) place(panel);
  });
}

/**
 * ↑ ↓ Home End move within a panel, → or Enter opens the next, ← or Escape
 * goes back one, and Escape on the first closes the menu. Tab leaves it.
 */
function onKey(event) {
  if (!open) return;
  const active = /** @type {HTMLElement} */ (document.activeElement);
  const panel = [...open.panels].reverse().find((p) => p.node.contains(active)) || open.panels[open.panels.length - 1];
  const typing = active?.tagName === 'INPUT';

  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (panel.level > 0) closeFrom(panel.level, true);
    else closePlus();
    return;
  }
  if (event.key === 'Tab') {
    closePlus();
    return;
  }
  if (typing && !['ArrowDown', 'ArrowUp'].includes(event.key)) return;

  const rows = /** @type {HTMLElement[]} */ ([...panel.node.querySelectorAll('[data-item], .plusmenu__search')]);
  const at = rows.indexOf(active);
  let next = null;
  if (event.key === 'ArrowDown') next = rows[(at + 1 + rows.length) % rows.length];
  else if (event.key === 'ArrowUp') next = rows[(at - 1 + rows.length) % rows.length];
  else if (event.key === 'Home') next = rows[0];
  else if (event.key === 'End') next = rows[rows.length - 1];
  else if (event.key === 'ArrowRight' && active?.getAttribute('aria-haspopup') === 'menu') {
    event.preventDefault();
    active.click();
    return;
  } else if (event.key === 'ArrowLeft' && panel.level > 0) {
    event.preventDefault();
    closeFrom(panel.level, true);
    return;
  }
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus({ preventScroll: true });
}
