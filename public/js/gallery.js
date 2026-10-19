import { t } from './i18n.js';

/**
 * The pictures a run looked at: a preview under the pointer, and a lightbox to
 * page through them (owner, 2026-10-19, after Claude's).
 *
 * A card's pictures are looked up when a thumbnail is used, through the card's
 * node, rather than copied into data attributes: a run that read thirty-seven
 * figures would otherwise carry its whole list on each of its thumbnails, and
 * the list grows while the run works.
 *
 * Nothing here touches `document` until a card registers — `render.js` is also
 * imported by the Node suites, which have no DOM.
 */

/**
 * `thumb: false` for a picture kept with no small copy — a browser step's
 * screenshot, small already — so its strip does not ask for one first.
 *
 * @typedef {{ id: string, name?: string, path?: string, label?: string, thumb?: boolean }} Picture
 */

/** @type {WeakMap<Element, () => Picture[]>} */
const SOURCES = new WeakMap();
let installed = false;

export const pictureUrl = (id) => `/api/attachments/${encodeURIComponent(id)}`;
export const thumbUrl = (id) => `${pictureUrl(id)}/thumb`;

/**
 * Say where a card's pictures are. Thumbnails anywhere inside `card` page
 * through this list.
 *
 * @param {Element} card
 * @param {() => Picture[]} list
 */
export function registerPictures(card, list) {
  SOURCES.set(card, list);
  install();
}

/**
 * The pictures of the card a thumbnail belongs to, and which one it is.
 *
 * Found by the picture's id when it is used, never by a position written down
 * when the thumbnail was drawn: two pictures read side by side can answer in
 * either order, and a place taken at arrival is the wrong place once the other
 * one lands before it.
 */
function locate(thumb) {
  for (let node = thumb.parentElement; node; node = node.parentElement) {
    const list = SOURCES.get(node);
    if (list) {
      const items = list();
      return { items, index: Math.max(0, items.findIndex((picture) => picture.id === thumb.dataset.pic)) };
    }
  }
  return null;
}

/**
 * One picture's thumbnail, as a button.
 *
 * The stored thumbnail first. A picture kept without one — a browser step's
 * screenshot — falls back to itself, and one that is gone hides its button
 * rather than drawing a broken image in the strip.
 *
 * @param {Picture} picture
 * @param {string} [className]
 */
export function pictureThumb(picture, className = 'pic-thumb') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.pic = picture.id;
  button.setAttribute('aria-label', t('gallery.open', { name: picture.name || picture.label || '' }));
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (!img.dataset.full) {
      img.dataset.full = '1';
      img.src = pictureUrl(picture.id);
    } else {
      button.hidden = true;
    }
  });
  if (picture.thumb === false) img.dataset.full = '1';
  img.src = picture.thumb === false ? pictureUrl(picture.id) : thumbUrl(picture.id);
  button.append(img);
  return button;
}

/* ── the lightbox ───────────────────────────────────────────────────── */

/**
 * @type {null | {
 *   root: HTMLElement, frame: HTMLElement, img: HTMLImageElement, label: HTMLElement, count: HTMLElement,
 *   prev: HTMLButtonElement, next: HTMLButtonElement, close: HTMLButtonElement,
 *   items: Picture[], index: number, returnTo: HTMLElement|null }}
 */
let box = null;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function build() {
  const root = document.createElement('div');
  root.className = 'gallery';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('gallery.dialog'));
  root.innerHTML = `
    <button type="button" class="gallery__close"><span aria-hidden="true">✕</span></button>
    <div class="gallery__stage"><figure class="gallery__frame"><img class="gallery__img" alt=""></figure></div>
    <div class="gallery__bar">
      <span class="gallery__label"></span>
      <div class="gallery__nav">
        <button type="button" class="gallery__prev"><span aria-hidden="true">‹</span></button>
        <span class="gallery__count" aria-live="polite"></span>
        <button type="button" class="gallery__next"><span aria-hidden="true">›</span></button>
      </div>
      <span></span>
    </div>`;
  const q = (selector) => /** @type {any} */ (root.querySelector(selector));
  const parts = {
    root,
    frame: q('.gallery__frame'),
    img: q('.gallery__img'),
    label: q('.gallery__label'),
    count: q('.gallery__count'),
    prev: q('.gallery__prev'),
    next: q('.gallery__next'),
    close: q('.gallery__close'),
  };
  parts.close.setAttribute('aria-label', t('gallery.close'));
  parts.prev.setAttribute('aria-label', t('gallery.prev'));
  parts.next.setAttribute('aria-label', t('gallery.next'));
  parts.close.addEventListener('click', closeGallery);
  parts.prev.addEventListener('click', () => show((box?.index ?? 0) - 1, -1));
  parts.next.addEventListener('click', () => show((box?.index ?? 0) + 1, 1));
  // The dark around the picture closes it; the picture itself does not.
  root.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === root || target.classList.contains('gallery__stage')) closeGallery();
  });
  root.addEventListener('keydown', onKey);
  // A swipe pages on a phone.
  const stage = q('.gallery__stage');
  let startX = null;
  stage.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
  });
  stage.addEventListener('pointerup', (event) => {
    if (startX == null || !box) return;
    const dx = event.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) show(box.index + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  return parts;
}

/** @param {KeyboardEvent} event */
function onKey(event) {
  if (!box) return;
  const go = (index, direction) => {
    event.preventDefault();
    show(index, direction);
  };
  if (event.key === 'Escape') {
    event.preventDefault();
    closeGallery();
  } else if (event.key === 'ArrowRight') go(box.index + 1, 1);
  else if (event.key === 'ArrowLeft') go(box.index - 1, -1);
  else if (event.key === 'Home') go(0, -1);
  else if (event.key === 'End') go(box.items.length - 1, 1);
  else if (event.key === 'Tab') {
    // Focus stays in the dialog: close, previous, next, and round again.
    const stops = [box.close, box.prev, box.next].filter((b) => !b.disabled);
    const at = stops.indexOf(/** @type {any} */ (document.activeElement));
    event.preventDefault();
    stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
  }
}

/**
 * Show picture `index`, sliding in from the side it came from.
 *
 * @param {number} index
 * @param {number} [direction]  1 from the right, -1 from the left, 0 still
 */
function show(index, direction = 0) {
  if (!box) return;
  const next = Math.max(0, Math.min(box.items.length - 1, index));
  if (next === box.index) return;
  box.index = next;
  const picture = box.items[next];
  box.img.src = pictureUrl(picture.id);
  box.img.alt = picture.name || picture.label || '';
  box.label.textContent = picture.label || '';
  box.count.textContent = t('gallery.count', { n: next + 1, total: box.items.length });
  box.prev.disabled = next === 0;
  box.next.disabled = next === box.items.length - 1;
  box.frame.classList.remove('is-from-left', 'is-from-right');
  if (direction && !still()) {
    void box.frame.offsetWidth; // restart the animation
    box.frame.classList.add(direction > 0 ? 'is-from-right' : 'is-from-left');
  }
  // A disabled button cannot hold focus; hand it to the one that still works.
  if (/** @type {any} */ (document.activeElement)?.disabled) (box.next.disabled ? box.prev : box.next).focus();
  // The neighbours, so paging does not wait on the network.
  for (const at of [next - 1, next + 1]) {
    if (box.items[at]) new Image().src = pictureUrl(box.items[at].id);
  }
}

/**
 * @param {Picture[]} items
 * @param {number} [index]
 * @param {HTMLElement|null} [returnTo]  focused again when the lightbox closes
 */
export function openGallery(items, index = 0, returnTo = null) {
  if (!items?.length) return;
  hidePreview();
  if (!box) box = { ...build(), items, index: -1, returnTo };
  box.items = items;
  box.returnTo = returnTo;
  box.index = -1;
  document.body.append(box.root);
  document.documentElement.classList.add('gallery-open');
  show(index, 0);
  (box.next.disabled ? box.close : box.next).focus();
}

export function closeGallery() {
  if (!box?.root.isConnected) return;
  box.root.remove();
  document.documentElement.classList.remove('gallery-open');
  box.returnTo?.focus?.();
}

/** For the interface suite. */
export const __testing = { isOpen: () => !!box?.root.isConnected };

/* ── the preview under the pointer ──────────────────────────────────── */

/** @type {HTMLElement|null} */
let tip = null;
let tipTimer = 0;

/** @param {HTMLElement} thumb */
function showPreview(thumb) {
  const found = locate(thumb);
  if (!found || !thumb.isConnected) return;
  const picture = found.items[found.index];
  if (!picture) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'pic-preview';
    tip.setAttribute('aria-hidden', 'true');
    tip.innerHTML =
      '<img class="pic-preview__img" alt=""><div class="pic-preview__foot"><span class="pic-preview__label"></span><span class="pic-preview__count"></span></div>';
  }
  /** @type {HTMLImageElement} */ (tip.querySelector('.pic-preview__img')).src = pictureUrl(picture.id);
  tip.querySelector('.pic-preview__label').textContent = picture.label || '';
  tip.querySelector('.pic-preview__count').textContent = t('gallery.count', { n: found.index + 1, total: found.items.length });
  document.body.append(tip);
  // Above the thumbnail, or below it when there is no room; inside the window.
  const rect = thumb.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const above = rect.top - height - 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${above >= 8 ? above : Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 8))}px`;
}

export function hidePreview() {
  clearTimeout(tipTimer);
  tip?.remove();
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (event) => {
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('[data-pic]');
    if (!thumb) return;
    const found = locate(thumb);
    if (!found) return;
    // A thumbnail in a card's header is not a click on the header: the card
    // stays as it was and the lightbox opens.
    event.preventDefault();
    openGallery(found.items, found.index, /** @type {HTMLElement} */ (thumb));
  });
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse' || !matchMedia('(hover: hover)').matches) return;
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('.pic-thumb[data-pic]');
    if (!thumb) return;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => showPreview(/** @type {HTMLElement} */ (thumb)), 300);
  });
  document.addEventListener('pointerout', (event) => {
    const thumb = /** @type {HTMLElement} */ (event.target).closest?.('.pic-thumb[data-pic]');
    if (!thumb || thumb.contains(/** @type {Node} */ (event.relatedTarget))) return;
    hidePreview();
  });
  document.addEventListener('scroll', hidePreview, { capture: true, passive: true });
  document.addEventListener('pointerdown', hidePreview, { capture: true });
}
