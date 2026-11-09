import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { playInFrame, sceneStill } from './scenes.js';
import { LOCK, themeStanding } from './themes-panel.js';

/**
 * `/theme` in the box (owner, 2026-11-06): the themes in a row above the composer,
 * without going through Settings.
 *
 * It opens on the first letters of the word, and only while the box holds nothing
 * else: a message that happens to start with a slash is still a message. The arrows
 * walk the row, Enter wears the one lit and closes, Escape closes, and a press wears
 * one and stays open so another can be tried. A tile plays under the pointer or the
 * arrows, as on the Settings page; the one in use keeps still, being already behind
 * everything. One not yet held can be looked at the same way, and says what earns it.
 *
 * It shows at once, from the list as last known (owner, 2026-11-08: typing the word
 * waited on the server); what the server says follows, and changes the row only where
 * it differs.
 *
 * @param {{ input: HTMLTextAreaElement, host: HTMLElement, themes: { list: () => Promise<any>, known: () => any, wear: (id: string) => void, selected: () => string },
 *   toast: (text: string, kind?: string) => void, clear: () => void }} deps
 */
export function createThemePicker({ input, host, themes, toast, clear }) {
  /** Anything from the slash to the whole word, and nothing more. */
  const ASKING = /^\/(?:t(?:h(?:e(?:m(?:e)?)?)?)?)?\s*$/i;

  let open = false;
  /** @type {any[]} */
  let list = [];
  let progress = null;
  let lit = 0;
  /** What is moving, and what takes it away. */
  let playing = null;
  /** A second opening while the first was still asking must not draw twice. */
  let asking = 0;

  const tiles = () => /** @type {HTMLElement[]} */ ([...host.querySelectorAll('.tpick__tile')]);

  function stopPlaying() {
    playing?.stop();
    playing = null;
  }

  function playOn(tile) {
    const id = tile?.dataset.id;
    if (playing?.id === id) return;
    stopPlaying();
    if (!id || id === themes.selected() || id === 'default') return;
    playing = { id, stop: playInFrame(/** @type {HTMLElement} */ (tile.querySelector('.tpick__frame')), id) };
  }

  function light(index, { play = true } = {}) {
    const all = tiles();
    if (!all.length) return;
    lit = (index + all.length) % all.length;
    all.forEach((tile, i) => tile.setAttribute('aria-selected', String(i === lit)));
    const tile = all[lit];
    tile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    input.setAttribute('aria-activedescendant', tile.id);
    if (play) playOn(tile);
  }

  function tileHtml(theme) {
    const isDefault = theme.id === 'default';
    const current = theme.id === themes.selected();
    const name = t(`theme.${theme.id}.name`);
    return `<button type="button" class="tpick__tile${theme.owned ? '' : ' is-locked'}${current ? ' is-current' : ''}" id="tpick-${escapeHtml(theme.id)}" role="option" aria-selected="false" data-id="${escapeHtml(theme.id)}" tabindex="-1" aria-label="${escapeHtml(theme.owned ? name : t('theme.lockedName', { name }))}">
      <span class="tpick__frame">${isDefault ? '<span class="themes__plain" aria-hidden="true"></span>' : `<img class="themes__still" src="${sceneStill(theme.id)}" alt="" loading="lazy" decoding="async" />`}${theme.owned ? '' : `<span class="themes__lock">${LOCK}</span>`}</span>
      <span class="tpick__name">${escapeHtml(name)}</span>
    </button>`;
  }

  /** @param {string|null} [keep] the tile to keep lit, by id */
  function paint(keep = null) {
    host.innerHTML = `<div class="tpick__head"><span class="tpick__chip">/theme</span><span class="tpick__title">${escapeHtml(t('theme.picker.title'))}</span><span class="tpick__keys">${escapeHtml(t('theme.picker.keys'))}</span></div>
      <div class="tpick__row" role="listbox" aria-label="${escapeHtml(t('theme.picker.title'))}">${list.map(tileHtml).join('')}</div>`;
    const here = list.findIndex((theme) => theme.id === (keep ?? themes.selected()));
    light(here < 0 ? 0 : here, { play: false });
  }

  /** What the row shows, to tell whether a fresh answer changes anything. */
  const shape = (rows) => rows.map((row) => `${row.id}:${row.owned ? 1 : 0}`).join(',');

  function markCurrent() {
    for (const tile of tiles()) tile.classList.toggle('is-current', tile.dataset.id === themes.selected());
  }

  async function show() {
    if (open) return;
    open = true;
    host.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', host.id);
    asking += 1;
    const mine = asking;
    const known = themes.known();
    if (known?.themes?.length) {
      list = known.themes;
      progress = known.progress;
      paint();
    } else {
      host.innerHTML = `<div class="tpick__head"><span class="tpick__chip">/theme</span><span class="tpick__title">${escapeHtml(t('theme.loading'))}</span></div>`;
    }
    try {
      const answer = await themes.list();
      if (mine !== asking || !open) return;
      const changed = shape(answer.themes) !== shape(list);
      list = answer.themes;
      progress = answer.progress;
      if (changed) paint(tiles()[lit]?.dataset.id || null);
    } catch (err) {
      if (mine !== asking) return;
      // Shown from what was known, the row stays: only an empty one is worth closing.
      if (!list.length) {
        toast(err.message, 'error');
        hide();
      }
    }
  }

  function hide() {
    if (!open) return;
    open = false;
    asking += 1;
    stopPlaying();
    host.hidden = true;
    host.innerHTML = '';
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'false');
  }

  /** @param {string} id @returns {boolean} whether it was worn */
  function wear(id) {
    const theme = list.find((row) => row.id === id);
    if (!theme) return false;
    if (!theme.owned) {
      toast(themeStanding(theme, progress) || t('theme.standing.locked'));
      return false;
    }
    stopPlaying();
    themes.wear(id);
    markCurrent();
    return true;
  }

  input.addEventListener('input', () => {
    if (ASKING.test(input.value)) void show();
    else hide();
  });

  // Ahead of the box's own handling, or Enter would send the word as a message.
  input.addEventListener(
    'keydown',
    (event) => {
      if (!open) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        event.stopImmediatePropagation();
        light(lit + step);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = tiles()[lit]?.dataset.id;
        if (id && wear(id)) {
          hide();
          clear();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        hide();
        clear();
      }
    },
    true,
  );

  host.addEventListener('click', (event) => {
    const tile = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.tpick__tile'));
    if (!tile) return;
    light(tiles().indexOf(tile), { play: false });
    wear(tile.dataset.id);
    // The press took focus off the box, where the arrows and Escape are heard.
    input.focus();
  });
  host.addEventListener('mouseover', (event) => {
    const tile = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.tpick__tile'));
    if (tile) playOn(tile);
  });
  host.addEventListener('mouseleave', stopPlaying);

  document.addEventListener('pointerdown', (event) => {
    if (!open) return;
    const target = /** @type {Node} */ (event.target);
    if (!host.contains(target) && target !== input) hide();
  });

  return { hide, isOpen: () => open };
}
