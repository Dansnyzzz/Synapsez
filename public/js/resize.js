/**
 * Dragging the two side panels wider or narrower.
 *
 * Both are grid columns whose width is a CSS variable, so resizing one is a
 * single custom property — which is why this is forty lines rather than a
 * layout engine, and why the collapse animations keep working untouched.
 *
 * What it adds beyond "it moves":
 *
 *   **Double-click resets.** A panel you can drag is a panel you can drag
 *   somewhere useless, and hunting for the original width by eye is a worse
 *   problem than the one dragging solved. Each handle resets its own panel.
 *
 *   **The width is remembered.** Somebody who widened the sidebar to read long
 *   conversation titles meant it, and having to do it again every morning is
 *   the app forgetting something it was told.
 *
 *   **A keyboard can do it too.** Arrow keys move the handle, because a
 *   separator that only answers to a mouse is one more thing that works for
 *   most people.
 *
 * The grid transition is suspended while a drag is in progress: a 240ms ease on
 * every pointer move is a panel that lags behind the cursor and feels broken.
 */

/** Where each panel starts, and how far it may be taken. */
const PANELS = {
  sidebar: { variable: '--sidebar-w', min: 180, max: 520, fallback: 288, side: 'right' },
  detail: { variable: '--detail-w', min: 240, max: 640, fallback: 340, side: 'left' },
};

const KEY = 'ai-remote:panel-widths';

/** What was saved last time, if anything and if storage will answer. */
function remembered() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    // Private windows and blocked site data both throw here. A default width
    // is a fine answer; an exception on boot is not.
    return {};
  }
}

function remember(widths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    /* nothing to do, and nothing worth saying */
  }
}

const clamp = (value, { min, max }) => Math.max(min, Math.min(max, Math.round(value)));

/**
 * Make one panel resizable by the handle inside it.
 *
 * @param name   which panel — the key into `PANELS`
 * @param handle the element to drag, already in the DOM
 */
export function makeResizable(name, handle) {
  const spec = PANELS[name];
  if (!spec || !handle) return;

  const app = /** @type {HTMLElement} */ (document.querySelector('.app'));
  if (!app) return;

  const widths = remembered();
  const apply = (px) => {
    app.style.setProperty(spec.variable, `${px}px`);
    widths[name] = px;
    handle.setAttribute('aria-valuenow', String(px));
  };

  if (Number.isFinite(widths[name])) apply(clamp(widths[name], spec));

  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(spec.min));
  handle.setAttribute('aria-valuemax', String(spec.max));
  handle.tabIndex = 0;

  /** The width the panel is showing right now, whatever set it. */
  const current = () => {
    const read = parseFloat(getComputedStyle(app).getPropertyValue(spec.variable));
    return Number.isFinite(read) ? read : spec.fallback;
  };

  handle.addEventListener('pointerdown', (event) => {
    // Only the primary button, and never a double-click's second press — that
    // one means reset, and starting a drag on it fights the reset.
    if (event.button !== 0 || event.detail > 1) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = current();
    handle.setPointerCapture(event.pointerId);
    app.classList.add('is-resizing');

    const onMove = (move) => {
      // The sidebar's handle is on its right edge and the detail rail's is on
      // its left, so the same gesture means opposite things to the two.
      const delta = spec.side === 'right' ? move.clientX - startX : startX - move.clientX;
      apply(clamp(startWidth + delta, spec));
    };

    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      app.classList.remove('is-resizing');
      remember(widths);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  handle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    apply(spec.fallback);
    remember(widths);
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const towards = event.key === 'ArrowRight' ? 1 : -1;
      apply(clamp(current() + towards * step * (spec.side === 'right' ? 1 : -1), spec));
      remember(widths);
      return;
    }
    // The keyboard equivalent of the double-click, on the key that already
    // means "put it back" everywhere else.
    if (event.key === 'Home') {
      event.preventDefault();
      apply(spec.fallback);
      remember(widths);
    }
  });
}
