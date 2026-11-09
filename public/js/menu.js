import { escapeHtml } from './markdown.js';

/**
 * The small menu a ⋮ button opens.
 *
 * One at a time, positioned against whatever was pressed, and closed by the
 * next click anywhere else or by Escape. It lives directly under `<body>` and
 * is `position: fixed`, because the thing it hangs off is usually inside a
 * scrolling panel with `overflow: hidden` — a menu absolutely positioned in
 * there gets clipped by its own card, which is exactly the sort of bug that
 * only appears on the last row.
 *
 * Items are `{ label, icon, danger, run }`. A `null` item draws a divider,
 * which is how "Delete" gets separated from the things that are not permanent.
 * An item with `confirm` (the words it then shows) needs a second press within
 * `CONFIRM_MS`: the first only arms it, and the menu stays open for the second.
 */

/** How long an armed item waits for its second press. */
export const CONFIRM_MS = 3000;

let host = null;
let closer = null;

/**
 * Where focus came from, so it can be put back.
 *
 * The menu focused its first item on open and then removed itself on close
 * without returning focus anywhere. Focus fell to <body>, so a keyboard user
 * who opened a menu and pressed Escape restarted from the top of the page — and
 * on a conversation list that is a long way from where they were.
 */
let returnFocusTo = null;

/** Shut whatever is open. Safe to call when nothing is. */
export function closeMenu() {
  if (!host) return;
  host.remove();
  host = null;
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
  const was = closer;
  closer = null;

  // Back where it started, and only if focus is still somewhere in the menu:
  // a click elsewhere has already moved it deliberately.
  const back = returnFocusTo;
  returnFocusTo = null;
  back?.setAttribute?.('aria-expanded', 'false');
  if (back?.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus();

  was?.();
}

function onDocClick(event) {
  if (!host?.contains(event.target)) closeMenu();
}

function onKey(event) {
  if (event.key === 'Escape') {
    // Stopped here so Escape closes the menu without also closing the dialog or
    // the page behind it — one press, one thing.
    event.stopPropagation();
    closeMenu();
    return;
  }

  /**
   * Up, Down, Home and End move between items.
   *
   * `role="menu"` promises this and nothing implemented it, so the only way
   * through was Tab — which walks out of the menu and on into the page behind
   * it, because the items are appended to <body> at the end of the document.
   * A menu you can open by keyboard and not read by keyboard is worse than a
   * plain list.
   */
  if (!host) return;
  const items = [...host.querySelectorAll('[data-pick]')];
  if (!items.length) return;

  const at = items.indexOf(document.activeElement);
  const next =
    event.key === 'ArrowDown' ? items[(at + 1 + items.length) % items.length]
    : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length]
    : event.key === 'Home' ? items[0]
    : event.key === 'End' ? items[items.length - 1]
    : null;
  if (!next) return;

  event.preventDefault();
  event.stopPropagation();
  next.focus();
}

/**
 * @param anchor   the element the menu should appear beneath
 * @param items    `{ label, icon, danger, run }` entries, `null` for a divider
 * @param onClose  called whenever the menu goes away, however it went
 */
export function openMenu(anchor, items, onClose = null) {
  const reopening = host?.dataset.owner === anchorKey(anchor);
  closeMenu();
  // A second press on the same button means "put it away", not "open it again".
  if (reopening) return;

  host = document.createElement('div');
  host.className = 'cardmenu';
  host.dataset.owner = anchorKey(anchor);
  host.setAttribute('role', 'menu');
  host.innerHTML = items
    .map((item, i) =>
      item === null
        ? '<hr />'
        : `<button type="button" role="menuitem" data-pick="${i}" data-label="${escapeHtml(item.label)}"${
            item.danger ? ' class="is-danger"' : ''
          }>${
            item.icon ? `<span class="menu__icon" aria-hidden="true">${item.icon}</span>` : ''
          }<span data-say>${escapeHtml(item.label)}</span></button>`,
    )
    .join('');

  for (const button of /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('[data-pick]'))) {
    let armedUntil = 0;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const item = items[Number(button.dataset.pick)];
      if (item.confirm && Date.now() > armedUntil) {
        // Armed, and said on the item itself, which keeps focus.
        armedUntil = Date.now() + CONFIRM_MS;
        const say = /** @type {HTMLElement} */ (button.querySelector('[data-say]'));
        say.textContent = item.confirm;
        button.classList.add('is-armed');
        setTimeout(() => {
          if (!button.isConnected) return;
          say.textContent = item.label;
          button.classList.remove('is-armed');
        }, CONFIRM_MS);
        return;
      }
      closeMenu();
      item.run();
    });
  }

  document.body.appendChild(host);
  closer = onClose;
  returnFocusTo = anchor;
  // aria-haspopup on the anchor promises a state; without this it never had one.
  anchor.setAttribute('aria-expanded', 'true');
  place(anchor);

  // Registered in the capture phase and on a later frame: the click that opened
  // the menu is still travelling, and would otherwise close it immediately.
  requestAnimationFrame(() => {
    if (!host) return;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  });

  host.querySelector('[data-pick]')?.focus();
}

/** Enough to tell one anchor from another between two clicks. */
function anchorKey(anchor) {
  return anchor.dataset.menuKey || (anchor.dataset.menuKey = `m${Math.random().toString(36).slice(2)}`);
}

/** Below the button and right-aligned to it, unless that would leave the window. */
function place(anchor) {
  const at = anchor.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  const pad = 8;

  let left = at.right - box.width;
  left = Math.min(Math.max(pad, left), window.innerWidth - box.width - pad);

  let top = at.bottom + 6;
  if (top + box.height > window.innerHeight - pad) top = Math.max(pad, at.top - box.height - 6);

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;
}
