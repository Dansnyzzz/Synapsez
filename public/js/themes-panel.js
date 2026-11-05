import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { SCENES, mountScene } from './scenes.js';

/**
 * Themes (owner, 2026-11-04): the scene behind the app, the page that chooses it,
 * and the part of Administration that says what each one is called and who holds it.
 *
 * Held themes are chosen with a press and saved at once. A locked one can be looked
 * at, dimmed, moving, padlocked, and says what earns it, but never applies. The theme
 * in use keeps still on its tile; every other tile plays while the pointer is on it.
 *
 * The stored id is painted before the server answers, so a reload never flashes the
 * default look; the server has the last word, in case a theme was taken back since.
 *
 * @typedef {{ kind: string, month: number|null, year: number|null }} Badge
 * @typedef {{ id: string, badge: Badge, owned: boolean, grantedAt: string|null, grant: Badge|null, needs: { tokens?: number }|null }} Theme
 */

const STORE_KEY = 'synapsez:scene';
const MODE_KEY = 'synapsez:scene-mode';

const LOCK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Zm3 4a2 2 0 0 1 1 3.7V20h-2v-2.3A2 2 0 0 1 12 14Z"/></svg>';

/** A badge in words. An "any" badge reads as the kind of prize; a dated one names when. */
export function badgeText(badge) {
  if (!badge) return t('theme.badge.none');
  switch (badge.kind) {
    case 'exclusive_event': return t('theme.badge.event');
    case 'achievement': return t('theme.badge.achievement');
    case 'top_month': return badge.month && badge.year ? t('theme.badge.topMonthOf', { month: badge.month, year: badge.year }) : t('theme.badge.topMonth');
    case 'top_year': return badge.year ? t('theme.badge.topYearOf', { year: badge.year }) : t('theme.badge.topYear');
    default: return t('theme.badge.none');
  }
}

const number = (n) => Number(n || 0).toLocaleString();

/**
 * @param {{ page: HTMLElement, admin: HTMLElement, toast: (text: string, kind?: string) => void, restoreMode: () => void,
 *   mascot: () => string, setMascot: (value: string) => void, mascotStates: string[] }} deps
 */
export function createThemes({ page, admin, toast, restoreMode, mascot, setMascot, mascotStates }) {
  /** @type {Theme[]} */
  let themes = [];
  let selected = readStored();
  /** What the right-hand panel is showing: a press, or the theme in use. */
  let chosen = selected;
  /** @type {Map<string, { play: Function, pause: Function, destroy: Function }>} */
  const tiles = new Map();
  let preview = null;
  let layer = null;
  let backdrop = null;
  let drawn = false;

  function readStored() {
    try {
      return localStorage.getItem(STORE_KEY) || 'default';
    } catch {
      return 'default';
    }
  }

  function store(id) {
    try {
      if (id === 'default') {
        localStorage.removeItem(STORE_KEY);
        localStorage.removeItem(MODE_KEY);
      } else {
        localStorage.setItem(STORE_KEY, id);
        localStorage.setItem(MODE_KEY, SCENES[id]?.mode || 'dark');
      }
    } catch {
      /* private browsing refuses storage; the choice still holds this session */
    }
  }

  /** Put a scene behind the app, or take it away. The person's own light or dark choice is never written over. */
  function apply(id) {
    const root = document.documentElement;
    const scene = SCENES[id];
    backdrop?.destroy();
    backdrop = null;
    if (!scene) {
      delete root.dataset.scene;
      layer?.remove();
      layer = null;
      restoreMode();
      return;
    }
    root.dataset.scene = id;
    root.dataset.theme = scene.mode;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'scene-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.append(document.createElement('canvas'));
      document.body.prepend(layer);
    }
    backdrop = mountScene(/** @type {HTMLCanvasElement} */ (layer.firstElementChild), id, { animate: true });
  }

  /** A press on Light or Dark while a scene is up: saved, and the scene's own look stays. */
  function reassert() {
    const scene = SCENES[selected];
    if (scene) document.documentElement.dataset.theme = scene.mode;
  }

  /** Ask the server what this account holds, and follow it. */
  async function sync() {
    try {
      const answer = await api.themes();
      themes = answer.themes;
      if (answer.selected !== selected) {
        selected = answer.selected;
        chosen = selected;
        store(selected);
        apply(selected);
      }
      if (drawn) draw();
    } catch {
      /* the look stays as it was: a page behind a failed request should not lose its colours */
    }
  }

  function tileHtml(theme) {
    const isDefault = theme.id === 'default';
    const name = t(`theme.${theme.id}.name`);
    return `<button class="themes__tile${theme.owned ? '' : ' is-locked'}${theme.id === selected ? ' is-current' : ''}${theme.id === chosen ? ' is-chosen' : ''}" type="button" data-theme-id="${escapeHtml(theme.id)}" aria-pressed="${theme.id === selected}" aria-label="${escapeHtml(theme.owned ? name : t('theme.lockedName', { name }))}">
      <span class="themes__frame">${isDefault ? '<span class="themes__plain" aria-hidden="true"></span>' : '<canvas aria-hidden="true"></canvas>'}${theme.owned ? '' : `<span class="themes__lock">${LOCK}</span>`}</span>
      <span class="themes__name">${escapeHtml(name)}</span>
    </button>`;
  }

  /** How this theme is held, or how it could be. */
  function standing(theme) {
    if (theme.id === 'default') return t('theme.standing.default');
    if (theme.owned) {
      if (!theme.grantedAt) return t('theme.standing.admin');
      const when = new Date(theme.grantedAt).toLocaleDateString();
      return theme.grant && theme.grant.kind !== theme.badge.kind ? t('theme.standing.since', { when, why: badgeText(theme.grant) }) : t('theme.standing.sinceOnly', { when });
    }
    if (theme.needs?.tokens) return t('theme.standing.needsTokens', { n: number(theme.needs.tokens) });
    if (theme.badge.kind === 'top_month') return t('theme.standing.topMonth');
    if (theme.badge.kind === 'top_year') return t('theme.standing.topYear');
    if (theme.badge.kind === 'exclusive_event') return t('theme.standing.event');
    return t('theme.standing.locked');
  }

  function paintPreview(theme) {
    const host = page.querySelector('.themes__detail');
    if (!host || !theme) return;
    preview?.destroy();
    preview = null;
    const isDefault = theme.id === 'default';
    host.innerHTML = `<div class="themes__stage${theme.owned ? '' : ' is-locked'}">${isDefault ? '<span class="themes__plain" aria-hidden="true"></span>' : '<canvas aria-hidden="true"></canvas>'}${theme.owned ? '' : `<span class="themes__lock themes__lock--big">${LOCK}</span>`}</div>
      <h4 class="themes__title">${escapeHtml(t(`theme.${theme.id}.name`))}</h4>
      <p class="themes__badge" data-kind="${escapeHtml(theme.badge.kind)}">${escapeHtml(badgeText(theme.badge))}</p>
      <p class="themes__desc">${escapeHtml(t(`theme.${theme.id}.desc`))}</p>
      <p class="themes__standing">${escapeHtml(standing(theme))}</p>`;
    const canvas = host.querySelector('canvas');
    if (canvas) preview = mountScene(canvas, theme.id, { animate: true });
  }

  function destroyTiles() {
    for (const tile of tiles.values()) tile.destroy();
    tiles.clear();
  }

  function draw() {
    drawn = true;
    destroyTiles();
    const grid = page.querySelector('.themes__grid');
    if (!grid) return;
    grid.innerHTML = themes.map(tileHtml).join('');
    // One at a time: painting a scene for the first time is a moment's work, and a list of them should not hold the page.
    const queue = themes.filter((theme) => theme.id !== 'default');
    const next = () => {
      const theme = queue.shift();
      if (!theme) return;
      const canvas = /** @type {HTMLCanvasElement|null} */ (grid.querySelector(`[data-theme-id="${window.CSS.escape(theme.id)}"] canvas`));
      if (canvas && grid.isConnected) tiles.set(theme.id, mountScene(canvas, theme.id));
      setTimeout(next, 0);
    };
    next();
    paintPreview(themes.find((theme) => theme.id === chosen) || themes[0]);
  }

  function markChoice() {
    for (const tile of /** @type {NodeListOf<HTMLElement>} */ (page.querySelectorAll('.themes__tile'))) {
      const id = tile.dataset.themeId;
      tile.classList.toggle('is-current', id === selected);
      tile.classList.toggle('is-chosen', id === chosen);
      tile.setAttribute('aria-pressed', String(id === selected));
    }
  }

  /** The theme a press landed on: looked at either way, worn if it is held. */
  async function choose(id) {
    const theme = themes.find((row) => row.id === id);
    if (!theme) return;
    chosen = id;
    paintPreview(theme);
    if (!theme.owned || id === selected) {
      markChoice();
      return;
    }
    const before = selected;
    selected = id;
    tiles.get(id)?.pause();
    store(id);
    apply(id);
    markChoice();
    try {
      await api.selectTheme(id);
    } catch (err) {
      selected = before;
      store(before);
      apply(before);
      markChoice();
      toast(err.message, 'error');
    }
  }

  function paintMascots() {
    const host = page.querySelector('.themes__mascots');
    if (!host) return;
    const current = mascot();
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    host.innerHTML = ['auto', 'off', ...mascotStates]
      .map((value) => {
        const art = value === 'auto' || value === 'off' || still ? '' : `<img src="/assets/mascot/${value}.gif" alt="" loading="lazy" decoding="async" />`;
        return `<button class="themes__pet${value === current ? ' is-chosen' : ''}" type="button" role="radio" aria-checked="${value === current}" data-mascot="${value}"><span class="themes__pet-art">${art}</span><span>${escapeHtml(t(`mascot.${value}`))}</span></button>`;
      })
      .join('');
  }

  /** The page in the Settings sheet. Its skeleton is drawn once; what is on it, each time it is opened. */
  function ensureSkeleton() {
    if (page.querySelector('.themes')) return;
    page.innerHTML = `<div class="themes">
        <div class="themes__left">
          <div class="themes__grid" role="group" aria-label="${escapeHtml(t('settings.tab.theme'))}"></div>
          <h4 class="themes__sub">${escapeHtml(t('mascot.title'))}</h4>
          <p class="themes__hint">${escapeHtml(t('mascot.hint'))}</p>
          <div class="themes__mascots" role="radiogroup" aria-label="${escapeHtml(t('mascot.title'))}"></div>
          <p class="themes__credit">${escapeHtml(t('mascot.credit'))}</p>
        </div>
        <aside class="themes__detail" aria-live="polite"></aside>
      </div>`;
    const play = (event, go) => {
      const tile = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest?.('.themes__tile'));
      if (!tile || tile.contains(/** @type {Node} */ (event.relatedTarget))) return;
      const id = tile.dataset.themeId;
      // The theme in use stays still on its tile: it is already moving behind everything.
      if (go && id === selected) return;
      const handle = tiles.get(id);
      if (go) handle?.play();
      else handle?.pause();
    };
    page.addEventListener('mouseover', (event) => play(event, true));
    page.addEventListener('mouseout', (event) => play(event, false));
    page.addEventListener('focusin', (event) => play(event, true));
    page.addEventListener('focusout', (event) => play(event, false));
    page.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const tile = /** @type {HTMLElement|null} */ (target.closest('.themes__tile'));
      if (tile) {
        choose(tile.dataset.themeId);
        return;
      }
      const pet = /** @type {HTMLElement|null} */ (target.closest('[data-mascot]'));
      if (pet) {
        setMascot(pet.dataset.mascot);
        paintMascots();
      }
    });
    page.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      const pet = /** @type {HTMLElement} */ (event.target).closest?.('[data-mascot]');
      if (!pet) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const all = /** @type {HTMLElement[]} */ ([...page.querySelectorAll('[data-mascot]')]);
      const next = all[(all.indexOf(/** @type {HTMLElement} */ (pet)) + step + all.length) % all.length];
      setMascot(next.dataset.mascot);
      paintMascots();
      /** @type {HTMLElement|null} */ (page.querySelector(`[data-mascot="${next.dataset.mascot}"]`))?.focus();
    });
  }

  /** Settings → Theme, as it is opened. */
  async function load() {
    ensureSkeleton();
    paintMascots();
    const grid = page.querySelector('.themes__grid');
    if (!themes.length && grid) grid.innerHTML = `<p class="hint">${escapeHtml(t('theme.loading'))}</p>`;
    try {
      const answer = await api.themes();
      themes = answer.themes;
      if (answer.selected !== selected) {
        selected = answer.selected;
        store(selected);
        apply(selected);
      }
      chosen = selected;
      draw();
    } catch (err) {
      if (grid) grid.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  /** Leaving the page: nothing on it should keep drawing. */
  function leave() {
    preview?.destroy();
    preview = null;
    destroyTiles();
    drawn = false;
  }

  const KINDS = ['none', 'exclusive_event', 'achievement', 'top_month', 'top_year'];

  function adminRow(row, people, years) {
    const { id, badge } = row;
    const dated = badge.kind === 'top_month' || badge.kind === 'top_year';
    const monthOptions = ['', ...Array.from({ length: 12 }, (_, i) => String(i + 1))];
    return `<details class="adminthemes__row" data-theme-row="${escapeHtml(id)}">
      <summary><strong>${escapeHtml(t(`theme.${id}.name`))}</strong><span class="muted">${escapeHtml(badgeText(badge))}${row.holders == null ? '' : ` · ${escapeHtml(t('theme.admin.holders', { n: row.holders }))}`}</span></summary>
      <div class="adminthemes__body">
        <div class="adminthemes__badge">
          <label><span>${escapeHtml(t('theme.admin.badge'))}</span><select class="sselect" data-badge-kind${id === 'default' ? ' disabled' : ''}>${KINDS.map((kind) => `<option value="${kind}"${kind === badge.kind ? ' selected' : ''}>${escapeHtml(t(`theme.admin.kind.${kind}`))}</option>`).join('')}</select></label>
          <label data-dated="month"${badge.kind === 'top_month' ? '' : ' hidden'}><span>${escapeHtml(t('theme.admin.month'))}</span><select class="sselect" data-badge-month>${monthOptions.map((m) => `<option value="${m}"${String(badge.month ?? '') === m ? ' selected' : ''}>${escapeHtml(m || t('theme.admin.any'))}</option>`).join('')}</select></label>
          <label data-dated="year"${dated ? '' : ' hidden'}><span>${escapeHtml(t('theme.admin.year'))}</span><select class="sselect" data-badge-year><option value="">${escapeHtml(t('theme.admin.any'))}</option>${years.map((y) => `<option value="${y}"${badge.year === y ? ' selected' : ''}>${y}</option>`).join('')}</select></label>
        </div>
        ${id === 'default' ? `<p class="hint">${escapeHtml(t('theme.admin.defaultNote'))}</p>` : `
        <div class="adminthemes__give">
          <label><span>${escapeHtml(t('theme.admin.give'))}</span><select class="sselect sselect--wide" data-search="always" data-give><option value="">${escapeHtml(t('theme.admin.choose'))}</option>${people.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || `${t('ranking.member')} ${p.id.slice(0, 6)}`)}</option>`).join('')}</select></label>
          <button class="btn btn--ghost btn--small" type="button" data-give-go disabled>${escapeHtml(t('theme.admin.giveButton'))}</button>
        </div>
        <ul class="adminthemes__holders" data-holders></ul>`}
      </div>
    </details>`;
  }

  /** Who holds this theme, read when its row is opened. */
  async function paintHolders(details) {
    const id = details.dataset.themeRow;
    const list = details.querySelector('[data-holders]');
    if (!list) return;
    const { holders } = await api.themeHolders(id);
    list.innerHTML = holders.length
      ? holders.map((h) => `<li><span>${escapeHtml(h.name || `${t('ranking.member')} ${h.id.slice(0, 6)}`)}</span><span class="muted">${escapeHtml(new Date(h.grantedAt).toLocaleDateString())}</span><button class="btn btn--ghost btn--small" type="button" data-take="${escapeHtml(h.id)}">${escapeHtml(t('theme.admin.take'))}</button></li>`).join('')
      : `<li class="muted">${escapeHtml(t('theme.admin.nobody'))}</li>`;
  }

  /** Settings → People → Themes: what each is called, and who holds it. */
  async function loadAdmin() {
    if (admin.hidden || admin.closest('[hidden]')) return;
    try {
      const [{ themes: rows }, { people }] = await Promise.all([api.adminThemes(), api.themePeople()]);
      const thisYear = new Date().getFullYear();
      const years = Array.from({ length: 6 }, (_, i) => thisYear - 1 + i);
      admin.querySelector('.adminthemes__list').innerHTML = rows.map((row) => adminRow(row, people, years)).join('');
    } catch (err) {
      admin.querySelector('.adminthemes__list').innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  admin.innerHTML = '<div class="adminthemes__list"></div>';
  admin.addEventListener('toggle', (event) => {
    const details = /** @type {HTMLDetailsElement} */ (event.target);
    if (details.open && details.dataset?.themeRow) paintHolders(details).catch((err) => toast(err.message, 'error'));
  }, true);
  admin.addEventListener('change', async (event) => {
    const target = /** @type {HTMLSelectElement} */ (event.target);
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-theme-row]'));
    if (!row) return;
    if ('give' in target.dataset) {
      /** @type {HTMLButtonElement} */ (row.querySelector('[data-give-go]')).disabled = !target.value;
      return;
    }
    const kind = /** @type {HTMLSelectElement} */ (row.querySelector('[data-badge-kind]')).value;
    const monthBox = /** @type {HTMLElement} */ (row.querySelector('[data-dated="month"]'));
    const yearBox = /** @type {HTMLElement} */ (row.querySelector('[data-dated="year"]'));
    monthBox.hidden = kind !== 'top_month';
    yearBox.hidden = kind !== 'top_month' && kind !== 'top_year';
    try {
      const month = /** @type {HTMLSelectElement} */ (row.querySelector('[data-badge-month]')).value;
      const year = /** @type {HTMLSelectElement} */ (row.querySelector('[data-badge-year]')).value;
      const { badge } = await api.setThemeBadge(row.dataset.themeRow, { kind, month: kind === 'top_month' ? month : null, year: kind === 'top_month' || kind === 'top_year' ? year : null });
      const label = row.querySelector('summary .muted');
      if (label) label.textContent = label.textContent.replace(/^[^·]*/, `${badgeText(badge)} `);
      toast(t('theme.admin.saved'));
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  admin.addEventListener('click', async (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = /** @type {HTMLElement|null} */ (target.closest('[data-theme-row]'));
    if (!row) return;
    try {
      if (target.closest('[data-give-go]')) {
        const person = /** @type {HTMLSelectElement} */ (row.querySelector('[data-give]'));
        await api.giveTheme(row.dataset.themeRow, person.value);
        toast(t('theme.admin.given'));
        await paintHolders(row);
      }
      const take = /** @type {HTMLElement|null} */ (target.closest('[data-take]'));
      if (take) {
        await api.takeTheme(row.dataset.themeRow, take.dataset.take);
        await paintHolders(row);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return {
    /** The look stored in this browser, painted before anything asks the server. */
    boot() {
      if (selected !== 'default') apply(selected);
    },
    sync,
    load,
    leave,
    loadAdmin,
    reassert,
    /** Signing out: the next person at this browser starts from the plain look. */
    reset() {
      selected = 'default';
      chosen = 'default';
      themes = [];
      store('default');
      apply('default');
    },
  };
}
