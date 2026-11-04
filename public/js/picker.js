import { t } from './i18n.js';

/**
 * A choice, drawn by this app rather than by the browser (owner, 2026-11-04,
 * after Claude's Settings).
 *
 * A browser draws an open `<select>` itself, and nothing in a stylesheet reaches
 * it: on Windows the list came down flush against the right edge, right-aligned,
 * in the system's own blue, with no room to say what a choice does. This puts a
 * button and a list of our own in front of it: each choice with a line saying what
 * it means, the chosen one ticked, under the button and clear of the window's edge.
 *
 * The `<select>` stays, underneath. It keeps the value, the `change` event and the
 * form it is in, so everything that reads one or sets one goes on working unchanged
 * and nothing has to be told; this only watches it, and draws what it says. Any
 * select that appears later is taken up by `watchSelects`, wherever it came from.
 *
 * A line under a choice comes from `data-desc-key` on its `<option>`, a string in
 * the locales, so it is in the language the page is in.
 */

/** More than this, or `data-search="always"` on the select, and the list opens with a box to search it. */
const SEARCH_ABOVE = 10;

const CHECK =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 10.5 3.6 3.6 7.4-8.2"/></svg>';

let nextId = 0;
/** The list open now, if any: one at a time. @type {{ close: (focus?: boolean) => void, button: HTMLElement } | null} */
let openList = null;

/** Close whatever list is open. */
export const closePicker = () => openList?.close();

/** What a person would call this select, for a screen reader on the button. */
function nameFor(select, button) {
  const label = select.labels?.[0];
  if (label) {
    label.id ||= `picker-label-${(nextId += 1)}`;
    button.setAttribute('aria-labelledby', label.id);
    return;
  }
  const said = select.getAttribute('aria-label') || select.title;
  if (said) button.setAttribute('aria-label', said);
}

/** @param {HTMLOptionElement} option */
const describe = (option) => {
  const key = option.dataset.descKey;
  if (!key) return option.dataset.desc || '';
  const said = t(key);
  return said === key ? '' : said;
};

/** Take one select up. Safe to call twice; a multiple choice is left to the browser. */
export function enhanceSelect(select) {
  if (select.dataset.picker || select.multiple) return;
  select.dataset.picker = '1';

  const wrap = document.createElement('span');
  wrap.className = 'picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${select.className} picker__btn`.trim();
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  if (select.title) button.title = select.title;
  nameFor(select, button);
  select.before(wrap);
  wrap.append(button, select);
  select.tabIndex = -1;
  select.classList.add('picker__native');
  select.setAttribute('aria-hidden', 'true');

  const paint = () => {
    const chosen = select.selectedOptions?.[0];
    button.textContent = chosen ? chosen.textContent.trim() : '';
    button.disabled = select.disabled;
    wrap.hidden = select.hidden;
    wrap.classList.toggle('is-disabled', select.disabled);
  };
  paint();

  // Whatever sets it: a person, a saved preference coming back, a language change.
  select.addEventListener('change', paint);
  new MutationObserver(paint).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'data-i18n'] });
  for (const property of ['value', 'selectedIndex']) {
    const native = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, property);
    Object.defineProperty(select, property, {
      configurable: true,
      get() {
        return native.get.call(this);
      },
      set(next) {
        native.set.call(this, next);
        paint();
      },
    });
  }
  // A label pressed, or anything else that focuses the select, means the button.
  select.addEventListener('focus', () => button.focus());

  const pick = (option) => {
    if (option.disabled) return;
    const changed = select.value !== option.value;
    select.value = option.value;
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  function open(startTyping = '') {
    if (button.disabled) return;
    openList?.close();
    const host = button.closest('dialog') || document.body;
    const menu = document.createElement('div');
    menu.className = 'picker__menu';
    menu.setAttribute('popover', 'auto');
    menu.setAttribute('role', 'listbox');
    const labelled = button.getAttribute('aria-labelledby');
    if (labelled) menu.setAttribute('aria-labelledby', labelled);
    else if (button.getAttribute('aria-label')) menu.setAttribute('aria-label', button.getAttribute('aria-label'));

    /** @type {{ row: HTMLElement, option: HTMLOptionElement, text: string, heading: HTMLElement | null }[]} */
    const rows = [];
    let heading = null;
    let group = null;
    const list = document.createElement('div');
    list.className = 'picker__list';
    for (const option of select.options) {
      if (option.parentElement !== group) {
        group = option.parentElement;
        heading = null;
        const groupName = group?.nodeName === 'OPTGROUP' ? /** @type {HTMLOptGroupElement} */ (group).label : '';
        if (groupName) {
          heading = Object.assign(document.createElement('p'), { className: 'picker__group', textContent: groupName });
          list.append(heading);
        }
      }
      const row = document.createElement('div');
      row.className = 'picker__opt';
      row.setAttribute('role', 'option');
      row.tabIndex = -1;
      const chosen = option.selected;
      row.setAttribute('aria-selected', String(chosen));
      if (chosen) row.classList.add('is-selected');
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      const words = document.createElement('span');
      words.className = 'picker__words';
      words.append(Object.assign(document.createElement('span'), { className: 'picker__name', textContent: option.textContent.trim() }));
      const said = describe(option);
      if (said) words.append(Object.assign(document.createElement('span'), { className: 'picker__desc', textContent: said }));
      row.append(words);
      if (chosen) row.insertAdjacentHTML('beforeend', `<span class="picker__tick">${CHECK}</span>`);
      row.addEventListener('click', () => {
        pick(option);
        close(true);
      });
      list.append(row);
      rows.push({ row, option, text: `${option.textContent} ${said} ${heading?.textContent || ''}`.toLowerCase(), heading });
    }

    let find = null;
    if (rows.length > SEARCH_ABOVE || select.dataset.search === 'always') {
      find = document.createElement('input');
      find.type = 'search';
      find.className = 'picker__find';
      find.placeholder = t('picker.search');
      find.setAttribute('aria-label', t('picker.search'));
      find.value = startTyping;
      menu.append(find);
    }
    const empty = Object.assign(document.createElement('p'), { className: 'picker__empty', textContent: t('picker.none'), hidden: true });
    list.append(empty);
    menu.append(list);

    const shown = () => rows.filter((r) => !r.row.hidden && !r.option.disabled);
    const filter = () => {
      const q = (find?.value || '').trim().toLowerCase();
      const seen = new Set();
      for (const r of rows) {
        r.row.hidden = !!q && !r.text.includes(q);
        if (!r.row.hidden && r.heading) seen.add(r.heading);
      }
      for (const r of rows) if (r.heading) r.heading.hidden = !seen.has(r.heading);
      empty.hidden = rows.some((r) => !r.row.hidden);
    };

    host.append(menu);

    function place() {
      const at = button.getBoundingClientRect();
      const edge = 8;
      const roomBelow = window.innerHeight - at.bottom - edge - 6;
      const roomAbove = at.top - edge - 6;
      menu.style.minWidth = `${Math.round(Math.min(at.width, window.innerWidth - edge * 2))}px`;
      menu.style.maxWidth = `${Math.min(460, window.innerWidth - edge * 2)}px`;
      menu.style.maxHeight = `${Math.round(Math.max(120, Math.min(440, Math.max(roomBelow, roomAbove))))}px`;
      const box = menu.getBoundingClientRect();
      // Its right edge under the button's, and never past either edge of the window.
      menu.style.left = `${Math.round(Math.max(edge, Math.min(at.right - box.width, window.innerWidth - box.width - edge)))}px`;
      const below = box.height <= roomBelow || roomBelow >= roomAbove;
      menu.style.top = `${Math.round(below ? at.bottom + 6 : Math.max(edge, at.top - box.height - 6))}px`;
    }

    // The page moved under it: it goes with its button, until the button has gone.
    // A resize is the same: on a phone, the keyboard opening for the search box is one.
    const follow = () => {
      const at = button.getBoundingClientRect();
      if (!button.isConnected || at.bottom < 0 || at.top > window.innerHeight) close();
      else place();
    };
    const onResize = () => follow();
    const onOutsideScroll = (event) => {
      if (!menu.contains(/** @type {Node} */ (event.target))) follow();
    };

    let closed = false;
    function close(focus = false) {
      if (closed) return;
      closed = true;
      if (openList?.close === close) openList = null;
      window.removeEventListener('scroll', onOutsideScroll, true);
      window.removeEventListener('resize', onResize);
      button.setAttribute('aria-expanded', 'false');
      try {
        menu.hidePopover?.();
      } catch {
        /* already hidden */
      }
      menu.remove();
      if (focus) button.focus();
    }

    menu.addEventListener('toggle', (event) => {
      // Dismissed by the browser: a click elsewhere, or Escape.
      if (/** @type {any} */ (event).newState === 'closed') close(!!menu.contains(document.activeElement) || document.activeElement === document.body);
    });
    menu.addEventListener('keydown', (event) => {
      const list = shown();
      const at = list.findIndex((r) => r.row === document.activeElement);
      const go = (i) => {
        event.preventDefault();
        list[i]?.row.focus();
      };
      if (event.key === 'ArrowDown') go(at < 0 ? 0 : Math.min(list.length - 1, at + 1));
      else if (event.key === 'ArrowUp') {
        if (at <= 0 && find) {
          event.preventDefault();
          find.focus();
        } else go(Math.max(0, at - 1));
      } else if (event.key === 'Home' && event.target !== find) go(0);
      else if (event.key === 'End' && event.target !== find) go(list.length - 1);
      else if (event.key === 'Enter' || (event.key === ' ' && event.target !== find)) {
        event.preventDefault();
        const target = at >= 0 ? list[at] : list[0];
        if (target) {
          pick(target.option);
          close(true);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'Tab') {
        close(true);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.target !== find) {
        // Typing goes to the search box, or to the next choice that starts with it.
        if (find) {
          find.focus();
        } else {
          const typed = event.key.toLowerCase();
          const next = list.find((r, i) => i > at && r.text.startsWith(typed)) || list.find((r) => r.text.startsWith(typed));
          if (next) go(list.indexOf(next));
        }
      }
    });
    find?.addEventListener('input', filter);

    openList = { close, button };
    button.setAttribute('aria-expanded', 'true');
    filter();
    try {
      menu.showPopover?.();
    } catch {
      /* no popover in this browser: it is still in the page, placed below */
    }
    place();
    window.addEventListener('scroll', onOutsideScroll, true);
    window.addEventListener('resize', onResize);

    const selected = rows.find((r) => r.row.classList.contains('is-selected'));
    if (find) find.focus();
    else (selected || shown()[0])?.row.focus();
    selected?.row.scrollIntoView({ block: 'nearest' });
  }

  button.addEventListener('click', () => {
    if (button.getAttribute('aria-expanded') === 'true') openList?.close(true);
    else open();
  });
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
    }
  });
}

/**
 * Take up every select under `root`, now and from here on.
 *
 * @param {ParentNode & Node} [root]
 */
export function watchSelects(root = document.body) {
  for (const select of root.querySelectorAll('select')) enhanceSelect(/** @type {HTMLSelectElement} */ (select));
  new MutationObserver((changes) => {
    // A list outlives nothing: the choice it was opened for has gone from the page.
    if (openList && !openList.button.isConnected) openList.close();
    for (const change of changes) {
      for (const node of change.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = /** @type {Element} */ (node);
        if (el.matches('select')) enhanceSelect(/** @type {HTMLSelectElement} */ (el));
        else for (const select of el.querySelectorAll('select')) enhanceSelect(/** @type {HTMLSelectElement} */ (select));
      }
    }
  }).observe(root, { childList: true, subtree: true });
}
