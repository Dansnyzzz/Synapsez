/**
 * Draw on a picture, or write on it, before it is sent.
 *
 * Opened from a picture waiting above the composer. Two tools — a pen and
 * text — seven colours, undo and redo, and Save, which hands back a PNG that
 * replaces the picture. Everything done is kept as a list of marks over the
 * untouched original, so undo is exact and nothing is ever painted twice. A
 * transparent picture is drawn, and saved, on white.
 *
 * The dialog is built here rather than in index.html, so its labels are the
 * script's to translate and the page carries no markup for something most
 * sessions never open.
 */

import { t } from './i18n.js';

/** Each colour with the name a screen reader says for it — not its hex code (ACC-016). */
const PALETTE = [
  ['#111111', 'sketch.black'],
  ['#f05252', 'sketch.red'],
  ['#f5c518', 'sketch.yellow'],
  ['#3fcf74', 'sketch.green'],
  ['#3fb6d8', 'sketch.blue'],
  ['#d94fe8', 'sketch.purple'],
  ['#bdbdbd', 'sketch.grey'],
];
const COLORS = PALETTE.map(([hex]) => hex);

/** The long edge the drawing is kept at: sharp enough to read, small enough to send. */
const MAX_EDGE = 2400;

let dialog = null;

/**
 * Where an arrow key moves within a radio group of `count`, from `index`: on
 * round, both directions, Home and End to the ends. Null for any other key.
 */
export function radioStep(key, index, count) {
  if (!count) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

function build() {
  const d = document.createElement('dialog');
  d.className = 'sketch';
  d.setAttribute('aria-label', t('sketch.title'));
  d.innerHTML = `
    <div class="sketch__top">
      <button class="icon-btn sketch__back" type="button" data-k="back"></button>
      <span class="sketch__spacer"></span>
      <button class="icon-btn" type="button" data-k="undo" disabled>↶</button>
      <button class="icon-btn" type="button" data-k="redo" disabled>↷</button>
      <button class="btn btn--primary sketch__save" type="button" data-k="save"></button>
    </div>
    <div class="sketch__stage"><canvas class="sketch__canvas" tabindex="0"></canvas></div>
    <div class="sketch__colors" role="radiogroup" data-group="colors">${PALETTE.map(
      ([c, name], i) => `<button class="sketch__color" type="button" role="radio" data-color="${c}" data-name="${name}"
                   style="--c:${c}" aria-checked="${i === 1}"></button>`,
    ).join('')}</div>
    <div class="sketch__tools" role="radiogroup" data-group="tools">
      <button class="sketch__tool" type="button" role="radio" data-tool="pen" aria-checked="true">
        <span class="sketch__toolmark" aria-hidden="true">✎</span><span data-l="pen"></span></button>
      <button class="sketch__tool" type="button" role="radio" data-tool="text" aria-checked="false">
        <span class="sketch__toolmark" aria-hidden="true">T</span><span data-l="text"></span></button>
    </div>`;
  document.body.append(d);
  return d;
}

/**
 * @param {string} src  the picture, as a URL the page can draw
 * @returns {Promise<Blob|null>} the edited picture, or null when nothing was saved
 */
export function openSketch(src) {
  dialog ||= build();
  const d = dialog;
  const q = (sel) => /** @type {HTMLElement} */ (d.querySelector(sel));
  const canvas = /** @type {HTMLCanvasElement} */ (q('.sketch__canvas'));
  const ctx = canvas.getContext('2d');

  // Labels read now, so a language switch since the last opening is honoured.
  q('[data-k="back"]').textContent = '←';
  q('[data-k="back"]').setAttribute('aria-label', t('sketch.back'));
  q('[data-k="undo"]').setAttribute('aria-label', t('sketch.undo'));
  q('[data-k="undo"]').title = t('sketch.undo');
  q('[data-k="redo"]').setAttribute('aria-label', t('sketch.redo'));
  q('[data-k="redo"]').title = t('sketch.redo');
  q('[data-k="save"]').textContent = t('sketch.save');
  q('[data-l="pen"]').textContent = t('sketch.pen');
  q('[data-l="text"]').textContent = t('sketch.text');
  q('[data-group="colors"]').setAttribute('aria-label', t('sketch.colors'));
  q('[data-group="tools"]').setAttribute('aria-label', t('sketch.tools'));
  for (const b of d.querySelectorAll('[data-name]')) b.setAttribute('aria-label', t(b.getAttribute('data-name')));
  q('.sketch__canvas').setAttribute('aria-label', t('sketch.canvas'));
  d.setAttribute('aria-label', t('sketch.title'));

  /** @type {Array<{type:'path', color:string, width:number, points:number[][]} | {type:'text', color:string, x:number, y:number, size:number, text:string}>} */
  const marks = [];
  const undone = [];
  let tool = 'pen';
  let color = COLORS[1];
  let drawing = null;
  let editor = null;
  const base = new Image();

  const redraw = () => {
    // White under the picture, so a transparent PNG — a diagram of dark lines on
    // nothing — is readable here and in what is saved, rather than dark on the
    // dark dialog and black on black for a model that composites onto black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
    for (const m of drawing ? [...marks, drawing] : marks) {
      if (m.type === 'path') {
        ctx.strokeStyle = m.color;
        ctx.lineWidth = m.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (m.points.length === 1) ctx.lineTo(m.points[0][0] + 0.1, m.points[0][1]);
        ctx.stroke();
      } else {
        ctx.fillStyle = m.color;
        ctx.font = `600 ${m.size}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        m.text.split('\n').forEach((line, i) => ctx.fillText(line, m.x, m.y + i * m.size * 1.2));
      }
    }
    /** @type {HTMLButtonElement} */ (q('[data-k="undo"]')).disabled = !marks.length;
    /** @type {HTMLButtonElement} */ (q('[data-k="redo"]')).disabled = !undone.length;
  };

  const add = (mark) => {
    marks.push(mark);
    undone.length = 0;
    redraw();
  };

  /** Where a pointer is on the drawing, in the drawing's own pixels. */
  const at = (event) => {
    const r = canvas.getBoundingClientRect();
    return [((event.clientX - r.left) / r.width) * canvas.width, ((event.clientY - r.top) / r.height) * canvas.height];
  };
  const scale = () => canvas.width / canvas.getBoundingClientRect().width || 1;

  /** Commit what is typed in the floating text box, if anything. */
  const commitText = () => {
    if (!editor) return;
    const { input, x, y } = editor;
    editor = null;
    const text = input.value.trim();
    input.remove();
    if (text) add({ type: 'text', color, x, y, size: Math.round(28 * scale()), text });
  };

  /**
   * Open the text box at a point on the screen — where the pointer went down,
   * or the middle of the picture when Enter is pressed on it (ACC-016: text
   * could only be placed with a pointer).
   */
  const placeText = (point) => {
    commitText();
    const [x, y] = at(point);
    const input = document.createElement('input');
    input.className = 'sketch__type';
    input.placeholder = t('sketch.typeHere');
    input.setAttribute('aria-label', t('sketch.text'));
    const stage = q('.sketch__stage');
    const s = stage.getBoundingClientRect();
    input.style.left = `${point.clientX - s.left}px`;
    input.style.top = `${point.clientY - s.top}px`;
    input.style.color = color;
    stage.append(input);
    editor = { input, x, y };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        commitText();
        canvas.focus();
      }
      if (e.key === 'Escape') {
        // Only the label being typed is dropped. Without preventDefault the
        // dialog's own cancel still fired and closed the whole sketch, every
        // mark with it (UX-006) — stopPropagation does not reach that.
        e.preventDefault();
        editor = null;
        input.remove();
        canvas.focus();
      }
    });
    setTimeout(() => input.focus(), 0);
  };

  const onDown = (event) => {
    if (event.button !== 0) return;
    if (tool === 'text') {
      placeText(event);
      event.preventDefault();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drawing = { type: 'path', color, width: Math.max(2, Math.round(5 * scale())), points: [at(event)] };
    redraw();
  };
  const onMove = (event) => {
    if (!drawing) return;
    drawing.points.push(at(event));
    redraw();
  };
  const onUp = () => {
    if (!drawing) return;
    const done = drawing;
    drawing = null;
    add(done);
  };

  const undo = () => {
    commitText();
    if (marks.length) undone.push(marks.pop());
    redraw();
  };
  const redo = () => {
    if (undone.length) marks.push(undone.pop());
    redraw();
  };

  /** Check one radio of a group; only the checked one is a Tab stop, as a radio group's is. */
  const pick = (attr, value) => {
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (d.querySelectorAll(`[${attr}]`))) {
      const on = b.getAttribute(attr) === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  pick('data-color', color);
  pick('data-tool', tool);
  canvas.classList.toggle('is-text', false);

  return new Promise((resolve) => {
    const controller = new AbortController();
    const on = (target, type, fn) => target.addEventListener(type, fn, { signal: controller.signal });

    const finish = (result) => {
      controller.abort();
      commitText();
      if (d.open) d.close();
      resolve(result);
    };

    on(canvas, 'pointerdown', onDown);
    on(canvas, 'pointermove', onMove);
    on(canvas, 'pointerup', onUp);
    on(canvas, 'pointercancel', onUp);
    on(q('[data-k="undo"]'), 'click', undo);
    on(q('[data-k="redo"]'), 'click', redo);
    on(q('[data-k="back"]'), 'click', () => finish(null));
    on(q('[data-k="save"]'), 'click', () => {
      commitText();
      canvas.toBlob((blob) => finish(blob), 'image/png');
    });
    for (const b of d.querySelectorAll('[data-color]')) {
      on(b, 'click', () => {
        color = b.getAttribute('data-color');
        pick('data-color', color);
        if (editor) editor.input.style.color = color;
      });
    }
    for (const b of d.querySelectorAll('[data-tool]')) {
      on(b, 'click', () => {
        commitText();
        tool = b.getAttribute('data-tool');
        pick('data-tool', tool);
        canvas.classList.toggle('is-text', tool === 'text');
      });
    }
    // Arrow keys move the choice within a group, as they do in any radio group.
    for (const group of d.querySelectorAll('[role="radiogroup"]')) {
      on(group, 'keydown', (/** @type {KeyboardEvent} */ e) => {
        const radios = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('[role="radio"]')]);
        const next = radioStep(e.key, radios.indexOf(/** @type {HTMLElement} */ (e.target)), radios.length);
        if (next == null) return;
        e.preventDefault();
        radios[next].click();
        radios[next].focus();
      });
    }
    // With Text chosen, Enter or Space on the picture opens the text box in its middle.
    on(canvas, 'keydown', (/** @type {KeyboardEvent} */ e) => {
      if (tool !== 'text' || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      placeText({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
    });
    on(d, 'keydown', (/** @type {KeyboardEvent} */ e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    });
    // Escape closes without saving, the same as the back arrow.
    on(d, 'cancel', (e) => {
      e.preventDefault();
      finish(null);
    });

    base.onload = () => {
      const long = Math.max(base.naturalWidth, base.naturalHeight) || 1;
      const k = Math.min(1, MAX_EDGE / long);
      canvas.width = Math.round(base.naturalWidth * k);
      canvas.height = Math.round(base.naturalHeight * k);
      redraw();
    };
    base.onerror = () => finish(null);
    base.src = src;
    d.showModal();
  });
}
