import { t } from './i18n.js';
// A cycle (media.js → render.js → this file), safe because both are called at
// click time, long after every module has loaded.
import { imageUrlToPng } from './media.js';
import { toast } from './render.js';

/**
 * The pictures a run looked at: a preview under the pointer, and a lightbox to
 * page through them (owner, 2026-10-19, after Claude's).
 *
 * Every picture in a reply opens here — a chart a run made, a diagram, what a
 * step read — full screen, to zoom into, copy or download without leaving it
 * (owner, 2026-10-25: the chart used to open in the side panel).
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
 * A picture that is not a stored file — a diagram — brings its own `src`, the
 * ground it was drawn on (`ground`), and how to make its PNG (`png`). One that
 * is a stored file is downloaded as that file, by `id`.
 *
 * @typedef {{ id: string, name?: string, path?: string, label?: string, thumb?: boolean,
 *   src?: string, ground?: string, png?: () => Promise<Blob> }} Picture
 */

/** @type {WeakMap<Element, () => Picture[]>} */
const SOURCES = new WeakMap();
let installed = false;

export const pictureUrl = (id) => `/api/attachments/${encodeURIComponent(id)}`;
export const thumbUrl = (id) => `${pictureUrl(id)}/thumb`;
/** @param {Picture} picture */
const srcOf = (picture) => picture.src || pictureUrl(picture.id);

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

const ICON_COPY =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5"/></svg>';
const ICON_DONE =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<path d="M10 3.5v9M6 9l4 4 4-4M4 15.5h12"/></svg>';

/** How far a picture may be zoomed: fitting the screen, up to eight times that. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
/** One press of a zoom button or key. */
const STEP = 1.5;

/**
 * @type {null | {
 *   root: HTMLElement, stage: HTMLElement, frame: HTMLElement, img: HTMLImageElement, label: HTMLElement,
 *   nav: HTMLElement, count: HTMLElement, prev: HTMLButtonElement, next: HTMLButtonElement, close: HTMLButtonElement,
 *   zoomOut: HTMLButtonElement, zoomIn: HTMLButtonElement, zoomSaid: HTMLButtonElement,
 *   copy: HTMLButtonElement, save: HTMLAnchorElement,
 *   items: Picture[], index: number, returnTo: HTMLElement|null,
 *   zoom: { scale: number, x: number, y: number } }}
 */
let box = null;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function build() {
  const root = document.createElement('div');
  root.className = 'gallery';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t('gallery.dialog'));
  root.innerHTML = `
    <button type="button" class="gallery__close"><span aria-hidden="true">✕</span></button>
    <div class="gallery__stage"><figure class="gallery__frame"><img class="gallery__img" alt="" draggable="false"></figure></div>
    <div class="gallery__bar">
      <span class="gallery__label"></span>
      <div class="gallery__nav">
        <button type="button" class="gallery__prev"><span aria-hidden="true">‹</span></button>
        <span class="gallery__count" aria-live="polite"></span>
        <button type="button" class="gallery__next"><span aria-hidden="true">›</span></button>
      </div>
      <div class="gallery__tools">
        <button type="button" class="gallery__tool gallery__zoomout"><span aria-hidden="true">−</span></button>
        <button type="button" class="gallery__tool gallery__zoom">100%</button>
        <button type="button" class="gallery__tool gallery__zoomin"><span aria-hidden="true">+</span></button>
        <span class="gallery__sep" aria-hidden="true"></span>
        <button type="button" class="gallery__tool gallery__copy">${ICON_COPY}</button>
        <a class="gallery__tool gallery__download">${ICON_DOWNLOAD}</a>
      </div>
    </div>`;
  const q = (selector) => /** @type {any} */ (root.querySelector(selector));
  const parts = {
    root,
    stage: q('.gallery__stage'),
    frame: q('.gallery__frame'),
    img: q('.gallery__img'),
    label: q('.gallery__label'),
    nav: q('.gallery__nav'),
    count: q('.gallery__count'),
    prev: q('.gallery__prev'),
    next: q('.gallery__next'),
    close: q('.gallery__close'),
    zoomOut: q('.gallery__zoomout'),
    zoomIn: q('.gallery__zoomin'),
    zoomSaid: q('.gallery__zoom'),
    copy: q('.gallery__copy'),
    save: q('.gallery__download'),
  };
  const name = (node, key) => {
    node.setAttribute('aria-label', t(key));
    node.title = t(key);
  };
  name(parts.close, 'gallery.close');
  name(parts.prev, 'gallery.prev');
  name(parts.next, 'gallery.next');
  name(parts.zoomOut, 'gallery.zoomOut');
  name(parts.zoomIn, 'gallery.zoomIn');
  name(parts.zoomSaid, 'gallery.zoomFit');
  name(parts.copy, 'media.copy');
  name(parts.save, 'media.download');
  parts.close.addEventListener('click', closeGallery);
  parts.prev.addEventListener('click', () => show((box?.index ?? 0) - 1, -1));
  parts.next.addEventListener('click', () => show((box?.index ?? 0) + 1, 1));
  parts.zoomIn.addEventListener('click', () => box && zoomTo(box.zoom.scale * STEP));
  parts.zoomOut.addEventListener('click', () => box && zoomTo(box.zoom.scale / STEP));
  parts.zoomSaid.addEventListener('click', () => zoomTo(1));
  parts.copy.addEventListener('click', copyPicture);
  parts.save.addEventListener('click', savePicture);

  /*
   * The dark around the picture closes it: a press that began on the dark and
   * ended there. Judged by where the press *began* — the stage captures the
   * pointer, so a click on the picture itself arrives at the stage, and judging
   * by where it landed closed the lightbox on every click on the picture (code
   * review, 2026-10-25). Not the end of a drag or a pinch either.
   */
  let dragged = false;
  /** Where the latest press began, for the click after it — which clears it. */
  let pressedOn = null;
  /** The same, kept past its click: a double click arrives after two of them. */
  let lastPress = null;
  const onDark = (node) => node === root || !!node?.classList?.contains('gallery__stage');
  root.addEventListener('pointerdown', (event) => {
    pressedOn = event.target;
    lastPress = event.target;
  }, true);
  root.addEventListener('click', (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    // A click with no press before it (the keyboard, a script) is judged by where it is.
    const began = pressedOn ?? event.target;
    pressedOn = null;
    if (onDark(began) && onDark(event.target)) closeGallery();
  });
  root.addEventListener('keydown', onKey);

  /*
   * The pointer: a wheel zooms where it points; a double click zooms in there
   * and back out; dragging a zoomed picture moves it; two fingers pinch; and a
   * swipe across a picture at its fitted size pages, as before.
   */
  const stage = parts.stage;
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!box) return;
      event.preventDefault();
      zoomTo(box.zoom.scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );
  // On the stage, which the captured pointer's double click arrives at; it
  // counts when the press was on the picture.
  stage.addEventListener('dblclick', (event) => {
    if (!box || !(lastPress === parts.img || parts.img.contains(lastPress))) return;
    zoomTo(box.zoom.scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
  });
  /** @type {Map<number, { x: number, y: number }>} */
  const pointers = new Map();
  let start = null;
  /** Two fingers were down during this gesture: it is a pinch, never a swipe. */
  let pinched = false;
  stage.addEventListener('pointerdown', (event) => {
    if (!box || (event.target instanceof Element && event.target.closest('button, a'))) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* an untrusted event in the suite has nothing to capture */
    }
    const [a, b] = [...pointers.values()];
    if (b) pinched = true;
    start = {
      x: event.clientX,
      y: event.clientY,
      tx: box.zoom.x,
      ty: box.zoom.y,
      scale: box.zoom.scale,
      spread: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
    };
    dragged = false;
  });
  stage.addEventListener('pointermove', (event) => {
    if (!box || !start || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [a, b] = [...pointers.values()];
    if (b && start.spread) {
      dragged = true;
      zoomTo(start.scale * (Math.hypot(a.x - b.x, a.y - b.y) / start.spread), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (box.zoom.scale > 1) {
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
      box.zoom.x = start.tx + dx;
      box.zoom.y = start.ty + dy;
      keepInView();
      applyZoom();
    }
  });
  const lift = (event) => {
    if (!box || !pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    const was = start;
    if (pointers.size) {
      // One finger of a pinch lifted: the one still down carries on from where
      // *it* is — anchoring on the lifted one jumped the picture (code review).
      const [still] = [...pointers.values()];
      start = { x: still.x, y: still.y, tx: box.zoom.x, ty: box.zoom.y, scale: box.zoom.scale, spread: 0 };
      return;
    }
    start = null;
    const wasPinch = pinched;
    pinched = false;
    if (!was || wasPinch || was.spread || box.zoom.scale > 1 || event.type === 'pointercancel') return;
    const dx = event.clientX - was.x;
    if (Math.abs(dx) > 50) {
      dragged = true;
      show(box.index + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  return parts;
}

/**
 * Zoom to `scale`, keeping the point under (`cx`, `cy`) where it is — the middle
 * of the picture when no point is given.
 */
function zoomTo(scale, cx = null, cy = null) {
  if (!box) return;
  const z = box.zoom;
  const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  const r = box.frame.getBoundingClientRect();
  const px = cx == null ? 0 : cx - (r.left + r.width / 2);
  const py = cy == null ? 0 : cy - (r.top + r.height / 2);
  const k = next / z.scale;
  z.x = px - (px - z.x) * k;
  z.y = py - (py - z.y) * k;
  z.scale = next;
  keepInView();
  applyZoom();
}

/** A zoomed picture can be moved to its edges, not off the screen. */
function keepInView() {
  if (!box) return;
  const z = box.zoom;
  if (z.scale <= 1) {
    z.x = 0;
    z.y = 0;
    return;
  }
  const maxX = (box.img.offsetWidth * (z.scale - 1)) / 2;
  const maxY = (box.img.offsetHeight * (z.scale - 1)) / 2;
  z.x = clamp(z.x, -maxX, maxX);
  z.y = clamp(z.y, -maxY, maxY);
}

function applyZoom() {
  if (!box) return;
  const { scale, x, y } = box.zoom;
  box.img.style.transform = scale === 1 ? '' : `translate(${Math.round(x)}px, ${Math.round(y)}px) scale(${Math.round(scale * 1000) / 1000})`;
  box.root.classList.toggle('is-zoomed', scale > 1);
  box.zoomSaid.textContent = `${Math.round(scale * 100)}%`;
  box.zoomOut.disabled = scale <= MIN_ZOOM;
  box.zoomIn.disabled = scale >= MAX_ZOOM;
  // A button that has just switched itself off cannot keep the focus, which
  // fell to the page — and the keys, heard on the dialog, stopped working
  // (code review, 2026-10-25). The zoom's own button takes it.
  const focused = /** @type {any} */ (document.activeElement);
  if ((focused === box.zoomOut || focused === box.zoomIn) && focused.disabled) box.zoomSaid.focus();
}

/** The picture on the clipboard, as a PNG — the one kind every app pastes. */
async function copyPicture() {
  const picture = box?.items[box.index];
  if (!picture) return;
  const button = box.copy;
  try {
    // The promise, not the blob: Safari allows a clipboard write only if it
    // begins inside the click, and drawing the PNG takes a moment.
    const pending = picture.png ? picture.png() : imageUrlToPng(srcOf(picture));
    await navigator.clipboard.write([new globalThis.ClipboardItem({ 'image/png': pending })]);
    button.innerHTML = ICON_DONE;
    setTimeout(() => {
      button.innerHTML = ICON_COPY;
    }, 1400);
  } catch {
    toast(t('media.copyFailed'), 'error');
  }
}

/**
 * Download: a stored file is its own link (`href` and `download`, set in
 * `show`); a picture drawn here — a diagram — is made into a PNG first.
 */
async function savePicture(event) {
  const picture = box?.items[box.index];
  if (!picture?.png) return;
  event.preventDefault();
  try {
    const url = URL.createObjectURL(await picture.png());
    const a = document.createElement('a');
    a.href = url;
    a.download = picture.name || 'image.png';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    toast(t('media.downloadFailed'), 'error');
  }
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
  else if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomTo(box.zoom.scale * STEP);
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault();
    zoomTo(box.zoom.scale / STEP);
  } else if (event.key === '0') {
    event.preventDefault();
    zoomTo(1);
  } else if (event.key === 'Tab') {
    // Focus stays in the dialog, going round every control that works.
    const stops = [box.close, box.prev, box.next, box.zoomOut, box.zoomSaid, box.zoomIn, box.copy, box.save].filter(
      (b) => !(/** @type {any} */ (b).disabled) && !b.closest('[hidden]'),
    );
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
  box.zoom = { scale: 1, x: 0, y: 0 };
  applyZoom();
  box.img.src = srcOf(picture);
  box.img.alt = picture.name || picture.label || '';
  // A diagram is shown on the ground it was drawn for; a photo on white.
  box.img.style.background = picture.ground || '';
  box.label.textContent = picture.label || '';
  // One picture has nothing to page to: no "1 of 1" between two dead arrows.
  box.nav.hidden = box.items.length < 2;
  box.count.textContent = t('gallery.count', { n: next + 1, total: box.items.length });
  box.prev.disabled = next === 0;
  box.next.disabled = next === box.items.length - 1;
  const name = picture.name || picture.label || 'image';
  box.save.setAttribute('download', picture.png && !/\.png$/i.test(name) ? `${name}.png` : name);
  box.save.setAttribute('href', picture.png ? '#' : picture.src && !picture.id ? picture.src : `${pictureUrl(picture.id)}?download=1`);
  box.frame.classList.remove('is-from-left', 'is-from-right');
  if (direction && !still()) {
    void box.frame.offsetWidth; // restart the animation
    box.frame.classList.add(direction > 0 ? 'is-from-right' : 'is-from-left');
  }
  // A disabled button cannot hold focus; hand it to the one that still works.
  if (/** @type {any} */ (document.activeElement)?.disabled) (box.next.disabled ? box.prev : box.next).focus();
  // The neighbours, so paging does not wait on the network.
  for (const at of [next - 1, next + 1]) {
    if (box.items[at]) new Image().src = srcOf(box.items[at]);
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
  if (!box) box = { ...build(), items, index: -1, returnTo, zoom: { scale: 1, x: 0, y: 0 } };
  box.items = items;
  box.returnTo = returnTo;
  box.index = -1;
  document.body.append(box.root);
  document.documentElement.classList.add('gallery-open');
  show(index, 0);
  (box.items.length > 1 && !box.next.disabled ? box.next : box.close).focus();
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
