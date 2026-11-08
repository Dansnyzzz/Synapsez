import { api } from './api.js';
import { t, localeTag } from './i18n.js';
import { latestOnly } from './latest.js';
import { escapeHtml } from './markdown.js';
import { SCENES, mountScene, playInFrame, sceneStill } from './scenes.js';
import { themeFacts, factsHtml, gotLine } from './reward-facts.js';

/** A page of the collection: three rows of four on a wide screen (owner, 2026-11-08). */
const PER_PAGE = 12;
/** How the collection can be put in order; the first is how it comes. */
const SORTS = ['got-new', 'got-old', 'out-new', 'out-old', 'kind'];
/** The kinds in the order the owner listed them: the default, events, the boards' prizes, achievements. */
const KIND_ORDER = { none: 0, exclusive_event: 1, top_quarter: 2, top_year: 2, achievement: 3 };
const SORT_KEY = 'synapsez.themes.sort';

/**
 * The themes in the chosen order. A date nobody has (a theme not held, or always out)
 * goes last, whichever way the dates run, so what has one is what is being ordered.
 *
 * @param {any[]} list @param {string} by
 */
export function sortThemes(list, by) {
  const time = (iso) => (iso ? new Date(iso).getTime() : null);
  const on = (key, newest) => (a, b) => {
    const x = time(a[key]);
    const y = time(b[key]);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return newest ? y - x : x - y;
  };
  const out = [...list];
  if (by === 'got-old') out.sort(on('grantedAt', false));
  else if (by === 'out-new') out.sort(on('released', true));
  else if (by === 'out-old') out.sort(on('released', false));
  else if (by === 'kind') out.sort((a, b) => (KIND_ORDER[a.badge?.kind] ?? 9) - (KIND_ORDER[b.badge?.kind] ?? 9) || on('released', false)(a, b));
  else out.sort(on('grantedAt', true));
  return out;
}

/**
 * Themes (owner, 2026-11-04): the scene behind the app, the page that chooses it,
 * and the part of Administration that says what each one is called and who holds it.
 *
 * Held themes are chosen with a press, which shows at once; the last press of a run
 * of them is what is saved (owner, 2026-11-06), and nothing the server says about an
 * older one can paint over it. A locked one can be looked at, dimmed, moving,
 * padlocked, and says what earns it, but never applies. The theme in use keeps still
 * on its tile; every other tile plays while the pointer is on it.
 *
 * A theme only ever changes what is behind the app. Light or dark is the person's own
 * setting, whichever is up.
 *
 * A tile is a picture made ahead of time, so a page of twenty costs nothing to open.
 * The stored id is painted before the server answers, so a reload never flashes the
 * default look; the server has the last word, in case a theme was taken back since.
 *
 * @typedef {{ kind: string, quarter: number|null, year: number|null }} Badge
 * @typedef {{ from: string, to: string, tokens: number, places: number, left: number, used: number, state: 'soon' | 'running' | 'over' }} EventStanding
 * @typedef {{ id: string, badge: Badge, owned: boolean, grantedAt: string|null, grant: Badge|null, needs: { tokens?: number, spend?: number, event?: EventStanding }|null }} Theme
 */

const STORE_KEY = 'synapsez:scene';

export const LOCK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Zm3 4a2 2 0 0 1 1 3.7V20h-2v-2.3A2 2 0 0 1 12 14Z"/></svg>';

/** A badge in words. An "any" badge reads as the kind of prize; a dated one names when. */
export function badgeText(badge) {
  if (!badge) return t('theme.badge.none');
  switch (badge.kind) {
    case 'exclusive_event': return t('theme.badge.event');
    case 'achievement': return t('theme.badge.achievement');
    case 'top_quarter': return badge.quarter && badge.year ? t('theme.badge.topQuarterOf', { quarter: badge.quarter, year: badge.year }) : t('theme.badge.topQuarter');
    case 'top_year': return badge.year ? t('theme.badge.topYearOf', { year: badge.year }) : t('theme.badge.topYear');
    default: return t('theme.badge.none');
  }
}

const number = (n) => Number(n || 0).toLocaleString(localeTag());
const dollars = (n) => `$${Number(n || 0).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;

/** How a theme is held, or how it could be. */
export function themeStanding(theme, progress = null) {
  if (theme.id === 'default') return t('theme.standing.default');
  if (theme.owned) {
    if (!theme.grantedAt) return '';
    const when = new Date(theme.grantedAt).toLocaleDateString(localeTag());
    return theme.grant && theme.grant.kind !== theme.badge.kind ? t('theme.standing.since', { when, why: badgeText(theme.grant) }) : t('theme.standing.sinceOnly', { when });
  }
  const ask = theme.needs;
  if (ask?.tokens) return `${t('theme.standing.needsTokens', { n: number(ask.tokens) })}${progress ? ` ${t('theme.standing.soFarTokens', { n: number(progress.tokens) })}` : ''}`;
  if (ask?.deposit) return `${t('theme.standing.needsSpend', { n: dollars(ask.deposit) })}${progress ? ` ${t('theme.standing.soFarSpend', { n: dollars(progress.deposited) })}` : ''}`;
  if (ask?.event) {
    const event = ask.event;
    if (event.state === 'over') return t('theme.standing.eventOver');
    const asks = t('theme.standing.eventAsks', { from: new Date(event.from).toLocaleDateString(localeTag()), to: new Date(new Date(event.to).getTime() - 1).toLocaleDateString(localeTag()), n: number(event.tokens), places: number(event.places) });
    return event.state === 'running' ? `${asks} ${t('theme.standing.eventNow', { used: number(event.used), left: number(event.left) })}` : asks;
  }
  const { kind, quarter, year } = theme.badge;
  if (kind === 'top_quarter') return quarter && year ? t('theme.standing.topQuarterOf', { quarter, year }) : t('theme.standing.topQuarter');
  if (kind === 'top_year') return year ? t('theme.standing.topYearOf', { year }) : t('theme.standing.topYear');
  if (kind === 'exclusive_event') return t('theme.standing.event');
  return t('theme.standing.locked');
}

/**
 * @param {{ page: HTMLElement, admin: HTMLElement, toast: (text: string, kind?: string) => void,
 *   mascot: () => string, setMascot: (value: string) => void, mascotStates: string[] }} deps
 */
export function createThemes({ page, admin, toast, mascot, setMascot, mascotStates }) {
  /** @type {Theme[]} */
  let themes = [];
  /** @type {{ tokens: number, spend: number } | null} */
  let progress = null;
  let selected = readStored();
  /** What the server last agreed to, to go back to if a save is refused. */
  let confirmed = selected;
  /** What the right-hand panel is showing: a press, or the theme in use. */
  let chosen = selected;
  /** What is moving on a tile under the pointer, and what takes it away. */
  let playing = null;
  let preview = null;
  let layer = null;
  /** The scene behind the app, and the one coming up to replace it. */
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
      if (id === 'default') localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, id);
      // Written by an older version of this page, when a scene decided light or dark.
      localStorage.removeItem('synapsez:scene-mode');
    } catch {
      /* private browsing refuses storage; the choice still holds this session */
    }
  }

  /**
   * Put a scene behind the app, or take it away. The new one comes up over the old
   * when its first frame is ready, so nothing flashes; a press on another before then
   * means this one is never painted at all.
   */
  function apply(id) {
    const root = document.documentElement;
    backdrop?.handle.destroy();
    backdrop = null;
    if (!SCENES[id]) {
      delete root.dataset.scene;
      layer?.remove();
      layer = null;
      return;
    }
    root.dataset.scene = id;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'scene-layer';
      layer.setAttribute('aria-hidden', 'true');
      document.body.prepend(layer);
    }
    // What is still fading in from a press a moment ago has already been destroyed; only what is showing stays under it.
    for (const old of [...layer.children]) if (!old.classList.contains('is-in')) old.remove();
    const canvas = document.createElement('canvas');
    layer.append(canvas);
    const handle = mountScene(canvas, id, {
      animate: true,
      onReady() {
        canvas.classList.add('is-in');
        for (const old of [...layer.children]) if (old !== canvas) old.remove();
      },
    });
    backdrop = { handle, id };
  }

  /*
   * The last press wins. Each press shows at once; this saves only what is still
   * wanted, one at a time, so answers cannot cross and land on an older choice.
   */
  const saver = latestOnly((id) => api.selectTheme(id), {
    landed(_answer, id) {
      confirmed = id;
    },
    failed(err) {
      selected = confirmed;
      chosen = confirmed;
      store(confirmed);
      apply(confirmed);
      markChoice();
      paintPreview(themes.find((theme) => theme.id === chosen));
      toast(err.message, 'error');
    },
  });

  /** Ask the server what this account holds, and follow it, unless a choice is on its way there. */
  async function sync() {
    try {
      const asked = saver.asked();
      const answer = await api.themes();
      themes = answer.themes;
      progress = answer.progress || null;
      if (saver.sure(asked) && answer.selected !== selected) {
        selected = answer.selected;
        confirmed = selected;
        chosen = selected;
        store(selected);
        apply(selected);
      } else if (saver.sure(asked)) confirmed = answer.selected;
      if (drawn) draw();
    } catch {
      /* the look stays as it was: a page behind a failed request should not lose its colours */
    }
  }

  function tileHtml(theme) {
    const isDefault = theme.id === 'default';
    const name = t(`theme.${theme.id}.name`);
    return `<button class="themes__tile${theme.owned ? '' : ' is-locked'}${theme.id === selected ? ' is-current' : ''}${theme.id === chosen ? ' is-chosen' : ''}" type="button" data-theme-id="${escapeHtml(theme.id)}" aria-pressed="${theme.id === selected}" aria-label="${escapeHtml(theme.owned ? name : t('theme.lockedName', { name }))}">
      <span class="themes__frame">${isDefault ? '<span class="themes__plain" aria-hidden="true"></span>' : `<img class="themes__still" src="${sceneStill(theme.id)}" alt="" loading="lazy" decoding="async" />`}${theme.owned ? '' : `<span class="themes__lock">${LOCK}</span>`}</span>
      <span class="themes__name">${escapeHtml(name)}</span>
    </button>`;
  }

  function paintPreview(theme) {
    const host = page.querySelector('.themes__detail');
    if (!host || !theme) return;
    preview?.();
    preview = null;
    const isDefault = theme.id === 'default';
    // The owner's shape: the scene, what it asks and how many have it, then when it was got.
    const got = !isDefault && theme.owned ? gotLine(theme.grantedAt, 'theme') : '';
    const said = isDefault ? themeStanding(theme, progress) : got;
    host.innerHTML = `<div class="themes__stage${theme.owned ? '' : ' is-locked'}">${isDefault ? '<span class="themes__plain" aria-hidden="true"></span>' : `<img class="themes__still" src="${sceneStill(theme.id)}" alt="" decoding="async" />`}${theme.owned ? '' : `<span class="themes__lock themes__lock--big">${LOCK}</span>`}</div>
      <h4 class="themes__title">${escapeHtml(t(`theme.${theme.id}.name`))}</h4>
      <p class="themes__badge" data-kind="${escapeHtml(theme.badge.kind)}">${escapeHtml(badgeText(theme.badge))}</p>
      <p class="themes__desc">${escapeHtml(t(`theme.${theme.id}.desc`))}</p>
      ${factsHtml(themeFacts(theme, progress))}
      ${said ? `<p class="themes__standing">${escapeHtml(said)}</p>` : ''}`;
    const stage = host.querySelector('.themes__stage');
    if (!isDefault && stage) preview = playInFrame(/** @type {HTMLElement} */ (stage), theme.id);
  }

  function stopTile() {
    playing?.stop();
    playing = null;
  }

  let sortBy = (() => {
    try {
      const kept = localStorage.getItem(SORT_KEY);
      return SORTS.includes(kept) ? kept : SORTS[0];
    } catch {
      return SORTS[0];
    }
  })();
  let pageAt = 0;

  function draw() {
    drawn = true;
    stopTile();
    const grid = page.querySelector('.themes__grid');
    if (!grid) return;
    const ordered = sortThemes(themes, sortBy);
    const pages = Math.max(1, Math.ceil(ordered.length / PER_PAGE));
    pageAt = Math.min(Math.max(0, pageAt), pages - 1);
    grid.innerHTML = ordered.slice(pageAt * PER_PAGE, (pageAt + 1) * PER_PAGE).map(tileHtml).join('');
    // The first page has only the arrow on the right, the last only the one on the left.
    const prev = /** @type {HTMLButtonElement|null} */ (page.querySelector('[data-turn="-1"]'));
    const next = /** @type {HTMLButtonElement|null} */ (page.querySelector('[data-turn="1"]'));
    if (prev) prev.hidden = pageAt === 0;
    if (next) next.hidden = pageAt >= pages - 1;
    const count = page.querySelector('.themes__pages');
    if (count) count.textContent = pages > 1 ? t('theme.page.of', { at: pageAt + 1, of: pages }) : '';
    const sort = /** @type {HTMLSelectElement|null} */ (page.closest('.panel')?.querySelector('[data-theme-sort]'));
    if (sort && sort.value !== sortBy) sort.value = sortBy;
    paintPreview(themes.find((theme) => theme.id === chosen) || ordered[pageAt * PER_PAGE]);
  }

  /** @param {number} step */
  function turn(step) {
    pageAt += step;
    draw();
    // The press took the arrow away on an end page: focus the first tile, not nothing.
    const arrow = /** @type {HTMLElement|null} */ (page.querySelector(`[data-turn="${step}"]`));
    if (arrow?.hidden) /** @type {HTMLElement|null} */ (page.querySelector('.themes__tile'))?.focus();
  }

  function markChoice() {
    for (const tile of /** @type {NodeListOf<HTMLElement>} */ (page.querySelectorAll('.themes__tile'))) {
      const id = tile.dataset.themeId;
      tile.classList.toggle('is-current', id === selected);
      tile.classList.toggle('is-chosen', id === chosen);
      tile.setAttribute('aria-pressed', String(id === selected));
    }
  }

  /** Wear a theme this account holds, from here or from anywhere else that offers it. */
  function wear(id) {
    if (id === selected) return;
    selected = id;
    if (playing?.id === id) stopTile();
    store(id);
    apply(id);
    markChoice();
    void saver.push(id);
  }

  /** The theme a press landed on: looked at either way, worn if it is held. */
  function choose(id) {
    const theme = themes.find((row) => row.id === id);
    if (!theme) return;
    chosen = id;
    markChoice();
    paintPreview(theme);
    if (theme.owned) wear(id);
  }

  function markMascots() {
    const current = mascot();
    for (const pet of /** @type {NodeListOf<HTMLElement>} */ (page.querySelectorAll('[data-mascot]'))) {
      const on = pet.dataset.mascot === current;
      pet.classList.toggle('is-chosen', on);
      pet.setAttribute('aria-checked', String(on));
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
    const arrow = (dir) =>
      `<button type="button" class="themes__turn" data-turn="${dir}" aria-label="${escapeHtml(t(dir < 0 ? 'theme.page.prev' : 'theme.page.next'))}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir < 0 ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'}"/></svg></button>`;
    page.innerHTML = `<div class="themes">
        <div class="themes__left">
          <div class="themes__pager">
            ${arrow(-1)}
            <div class="themes__grid" role="group" aria-label="${escapeHtml(t('settings.tab.theme'))}"></div>
            ${arrow(1)}
          </div>
          <p class="themes__pages" aria-live="polite"></p>
          <h4 class="themes__sub">${escapeHtml(t('mascot.title'))}</h4>
          <p class="themes__hint">${escapeHtml(t('mascot.hint'))}</p>
          <div class="themes__mascots" role="radiogroup" aria-label="${escapeHtml(t('mascot.title'))}"></div>
        </div>
        <aside class="themes__detail" aria-live="polite"></aside>
      </div>`;
    const play = (event, go) => {
      const tile = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest?.('.themes__tile'));
      if (!tile || tile.contains(/** @type {Node} */ (event.relatedTarget))) return;
      const id = tile.dataset.themeId;
      if (!go) {
        if (playing?.id === id) stopTile();
        return;
      }
      // The theme in use stays still on its tile: it is already moving behind everything.
      if (id === selected || id === 'default' || playing?.id === id) return;
      stopTile();
      const frame = /** @type {HTMLElement} */ (tile.querySelector('.themes__frame'));
      playing = { id, stop: playInFrame(frame, id) };
    };
    page.addEventListener('mouseover', (event) => play(event, true));
    page.addEventListener('mouseout', (event) => play(event, false));
    page.addEventListener('focusin', (event) => play(event, true));
    page.addEventListener('focusout', (event) => play(event, false));
    // The order sits beside the page's title, as the owner drew it.
    const heading = page.closest('.panel')?.querySelector('.settings__title');
    if (heading && !heading.parentElement?.classList.contains('themes__titlebar')) {
      const bar = document.createElement('div');
      bar.className = 'themes__titlebar';
      heading.replaceWith(bar);
      const label = document.createElement('label');
      label.className = 'themes__sort';
      label.innerHTML = `<span class="sr-only">${escapeHtml(t('theme.sort.label'))}</span><select data-theme-sort>${SORTS.map((key) => `<option value="${key}"${key === sortBy ? ' selected' : ''}>${escapeHtml(t(`theme.sort.${key}`))}</option>`).join('')}</select>`;
      bar.append(heading, label);
      label.querySelector('select')?.addEventListener('change', (event) => {
        const value = /** @type {HTMLSelectElement} */ (event.target).value;
        if (!SORTS.includes(value)) return;
        sortBy = value;
        pageAt = 0;
        try {
          localStorage.setItem(SORT_KEY, value);
        } catch {
          /* a remembered order is a convenience */
        }
        draw();
      });
    }
    page.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      const turner = /** @type {HTMLElement|null} */ (target.closest('[data-turn]'));
      if (turner) {
        turn(Number(turner.dataset.turn));
        return;
      }
      const tile = /** @type {HTMLElement|null} */ (target.closest('.themes__tile'));
      if (tile) {
        choose(tile.dataset.themeId);
        return;
      }
      const pet = /** @type {HTMLElement|null} */ (target.closest('[data-mascot]'));
      if (pet) {
        setMascot(pet.dataset.mascot);
        markMascots();
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
      markMascots();
      next.focus();
    });
  }

  /** Which visit to the page this is: an answer to an earlier one has nothing to draw on. */
  let visit = 0;

  /** Settings → Theme, as it is opened. */
  async function load() {
    const here = (visit += 1);
    ensureSkeleton();
    paintMascots();
    const grid = page.querySelector('.themes__grid');
    if (!themes.length && grid) grid.innerHTML = `<p class="hint">${escapeHtml(t('theme.loading'))}</p>`;
    // The page as last known, at once; what the server says follows.
    if (themes.length) draw();
    try {
      const asked = saver.asked();
      const answer = await api.themes();
      themes = answer.themes;
      progress = answer.progress || null;
      if (saver.sure(asked)) {
        if (answer.selected !== selected) {
          selected = answer.selected;
          store(selected);
          apply(selected);
          chosen = selected;
        }
        confirmed = answer.selected;
      }
      // Left while it was on its way: drawing now would start a scene nothing would stop.
      if (here === visit) draw();
    } catch (err) {
      if (grid && !themes.length) grid.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  /** Leaving the page: nothing on it should keep drawing. */
  function leave() {
    visit += 1;
    preview?.();
    preview = null;
    stopTile();
    drawn = false;
  }

  const KINDS = ['none', 'exclusive_event', 'achievement', 'top_quarter', 'top_year'];

  function adminRow(row, people, years) {
    const { id, badge } = row;
    const dated = badge.kind === 'top_quarter' || badge.kind === 'top_year';
    const quarterOptions = ['', '1', '2', '3', '4'];
    return `<details class="adminthemes__row" data-theme-row="${escapeHtml(id)}">
      <summary><strong>${escapeHtml(t(`theme.${id}.name`))}</strong><span class="muted">${escapeHtml(badgeText(badge))}${row.holders == null ? '' : ` · ${escapeHtml(t('theme.admin.holders', { n: row.holders }))}`}</span></summary>
      <div class="adminthemes__body">
        <div class="adminthemes__badge">
          <label><span>${escapeHtml(t('theme.admin.badge'))}</span><select class="sselect" data-badge-kind${id === 'default' ? ' disabled' : ''}>${KINDS.map((kind) => `<option value="${kind}"${kind === badge.kind ? ' selected' : ''}>${escapeHtml(t(`theme.admin.kind.${kind}`))}</option>`).join('')}</select></label>
          <label data-dated="quarter"${badge.kind === 'top_quarter' ? '' : ' hidden'}><span>${escapeHtml(t('theme.admin.quarter'))}</span><select class="sselect" data-badge-quarter>${quarterOptions.map((q) => `<option value="${q}"${String(badge.quarter ?? '') === q ? ' selected' : ''}>${escapeHtml(q ? `Q${q}` : t('theme.admin.any'))}</option>`).join('')}</select></label>
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
      ? holders.map((h) => `<li><span>${escapeHtml(h.name || `${t('ranking.member')} ${h.id.slice(0, 6)}`)}</span><span class="muted">${escapeHtml(new Date(h.grantedAt).toLocaleDateString(localeTag()))}</span><button class="btn btn--ghost btn--small" type="button" data-take="${escapeHtml(h.id)}">${escapeHtml(t('theme.admin.take'))}</button></li>`).join('')
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
    const quarterBox = /** @type {HTMLElement} */ (row.querySelector('[data-dated="quarter"]'));
    const yearBox = /** @type {HTMLElement} */ (row.querySelector('[data-dated="year"]'));
    quarterBox.hidden = kind !== 'top_quarter';
    yearBox.hidden = kind !== 'top_quarter' && kind !== 'top_year';
    try {
      const quarter = /** @type {HTMLSelectElement} */ (row.querySelector('[data-badge-quarter]')).value;
      const year = /** @type {HTMLSelectElement} */ (row.querySelector('[data-badge-year]')).value;
      const { badge } = await api.setThemeBadge(row.dataset.themeRow, { kind, quarter: kind === 'top_quarter' ? quarter : null, year: kind === 'top_quarter' || kind === 'top_year' ? year : null });
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
      if (selected !== 'default' && !layer) apply(selected);
      // Asked once the page has settled, so `/theme` opens at once the first time too.
      const warm = () => api.themes().then((answer) => {
        if (themes.length) return;
        themes = answer.themes;
        progress = answer.progress || null;
      }).catch(() => {});
      if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4000 });
      else setTimeout(warm, 1500);
    },
    /** Signed out: nothing of a theme shows on the sign-in page, and nothing is drawn under it. */
    sleep() {
      backdrop?.handle.destroy();
      backdrop = null;
      layer?.remove();
      layer = null;
      delete document.documentElement.dataset.scene;
    },
    sync,
    load,
    leave,
    loadAdmin,
    wear,
    /** The list as last known, to show before asking again; null before the first answer. */
    known: () => (themes.length ? { themes, selected, progress } : null),
    /** What the `/theme` box offers: the list as the server last said, asked again. */
    async list() {
      const asked = saver.asked();
      const answer = await api.themes();
      themes = answer.themes;
      progress = answer.progress || null;
      if (saver.sure(asked) && answer.selected !== selected) {
        selected = answer.selected;
        confirmed = selected;
        chosen = selected;
        store(selected);
        apply(selected);
      }
      return { themes, selected, progress };
    },
    selected: () => selected,
    /** Signing out: the next person at this browser starts from the plain look. */
    reset() {
      selected = 'default';
      confirmed = 'default';
      chosen = 'default';
      themes = [];
      store('default');
      apply('default');
    },
  };
}
