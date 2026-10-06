/**
 * A chart from the `chart` tool, drawn into the page and made interactive.
 *
 * The server draws the picture — to scale, in the house palette — and marks
 * each bar, point and slice with the label (`data-i`) and series (`data-s`) it
 * belongs to, plus an invisible column over each label. This file adds what a
 * picture cannot do: hover or arrow-key to a label and read every series' value
 * there, with a guide line through it; click a legend entry to set a series
 * aside.
 *
 * In the page rather than a sandboxed frame, unlike `show_widget`, because the
 * markup is not the model's: it comes out of `renderChart`, which escapes every
 * label. It is still parsed as SVG and stripped to the handful of elements and
 * attributes a chart uses before it is inserted — a stored result is data, and
 * data is not trusted to be what it was when it was written.
 */
import { t } from './i18n.js';
import { mediaTools, svgToPng, fileNameFrom } from './media.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENTS = new Set(['svg', 'g', 'rect', 'line', 'polyline', 'circle', 'path', 'text']);
const ATTRIBUTES = new Set([
  'class', 'viewBox', 'width', 'height', 'role', 'aria-label', 'transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap',
  'font-size', 'font-weight', 'text-anchor', 'data-i', 'data-s',
]);

/** The SVG, parsed and reduced to what a chart is made of. Null if it is not one. */
function cleanSvg(markup) {
  const doc = new globalThis.DOMParser().parseFromString(String(markup || ''), 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'svg' || doc.querySelector('parsererror')) return null;
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ELEMENTS.has(child.nodeName)) {
        child.remove();
        continue;
      }
      for (const { name } of [...child.attributes]) if (!ATTRIBUTES.has(name)) child.removeAttribute(name);
      walk(child);
    }
  };
  for (const { name } of [...root.attributes]) {
    if (!ATTRIBUTES.has(name) && name !== 'xmlns') root.removeAttribute(name);
  }
  walk(root);
  return document.importNode(root, true);
}

/** Mirrors `formatValue` in server/tools/chart.js, so the tooltip and the labels agree. */
export function formatValue(value, format = 'number') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (format === 'percent') return `${Math.round(n * 10) / 10}%`;
  const grouped = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
  return format === 'currency' ? `$${grouped}` : grouped;
}

/** Same fixed order as the server's palette. */
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

/**
 * The point a key moves the reading to, among points `0..last`.
 *
 * Undefined for a key that does not move it; null when it has nowhere to go.
 * Home searches forward from the first point and End back from the last, past
 * any point in a series set aside. The direction used to be guessed from
 * `next < active`, so Home from a later point searched backwards from 0 and
 * End from an earlier one forwards past the end — and when the first or last
 * point was hidden, neither did anything (CODE-038).
 *
 * @param {string} key
 * @param {number} active  the point being read, or -1 for none yet
 * @param {number} last
 * @param {(i: number) => boolean} [hidden]
 */
export function keyStep(key, active, last, hidden = () => false) {
  const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 1, End: -1 }[key];
  if (dir === undefined) return undefined;
  // With nothing read yet, an arrow starts at the first point.
  const [start, step] = key === 'Home' ? [0, 1] : key === 'End' ? [last, -1] : active < 0 ? [0, 1] : [active + dir, dir];
  let next = Math.max(0, Math.min(last, start));
  while (next >= 0 && next <= last && hidden(next)) next += step;
  return next < 0 || next > last ? null : next;
}

/**
 * @param {{ title?: string, markup: string, spec: { type: string, format?: string,
 *   labels: string[], series: { name: string, values: number[] }[],
 *   groups?: string[], group?: number[] } }} widget  `groups`/`group`: scatter only
 * @returns {HTMLElement | null} null when the markup is not a chart, so the
 *   caller can fall back to the plain frame.
 */
export function chartFigure(widget) {
  const svg = cleanSvg(widget?.markup);
  if (!svg) return null;
  // A chart drawn before charts carried their numbers is still drawn here, in
  // the page — just without the hover, which needs the numbers.
  const given = widget?.spec;
  // Every series with its numbers, or none of the hover: a stored chart with a
  // series missing `values` threw inside the pointer handlers on every move.
  const readable =
    !!given &&
    Array.isArray(given.labels) &&
    Array.isArray(given.series) &&
    given.series.length > 0 &&
    given.series.every((s) => Array.isArray(s?.values));
  const spec = readable ? given : { type: '', labels: [], series: [] };

  const figure = document.createElement('figure');
  figure.className = 'widget chart';

  const caption = document.createElement('figcaption');
  caption.className = 'widget__caption';
  caption.textContent = widget.title || t('chat.diagram');

  const stage = document.createElement('div');
  stage.className = 'chart__stage';
  // Focusable, so the arrow keys can walk the labels: the values in the tooltip
  // are not otherwise reachable without a mouse.
  stage.tabIndex = 0;
  stage.setAttribute('role', 'group');
  stage.setAttribute('aria-label', `${widget.title || t('chat.diagram')} — ${t('chart.keys')}`);

  const tip = document.createElement('div');
  tip.className = 'chart__tip';
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  tip.setAttribute('aria-live', 'polite');

  // A guide line through the column being read, drawn inside the SVG's own
  // coordinates so it lines up at any width.
  const guide = document.createElementNS(SVG_NS, 'line');
  guide.setAttribute('class', 'chart__guide');
  guide.style.display = 'none';
  svg.insertBefore(guide, svg.firstChild?.nextSibling || null);

  stage.append(svg, tip);
  figure.append(
    caption,
    stage,
    mediaTools({ name: fileNameFrom(widget.title, 'png'), blob: () => svgToPng(svg) }),
  );
  if (!readable) {
    stage.removeAttribute('tabindex');
    stage.setAttribute('aria-label', widget.title || t('chat.diagram'));
    return figure;
  }
  figure.append(dataTable(widget.title, spec));

  const off = new Set();
  const hits = [...svg.querySelectorAll('.hit')];
  const isPie = spec.type === 'pie';
  // A scatter point reads as its x and y; the real series it belongs to is
  // `group[i]`, which is what its colour and the legend refer to.
  const isScatter = spec.type === 'scatter' && Array.isArray(spec.group) && Array.isArray(spec.groups);
  const legendCount = isScatter ? spec.groups.length : spec.series.length;
  let active = -1;

  const clear = () => {
    active = -1;
    tip.hidden = true;
    guide.style.display = 'none';
    svg.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
    svg.classList.remove('is-reading');
  };

  const show = (i, anchor) => {
    if (i < 0 || i >= spec.labels.length) return clear();
    active = i;
    svg.classList.add('is-reading');
    svg.querySelectorAll('.is-active').forEach((n) => n.classList.remove('is-active'));
    svg.querySelectorAll(`[data-i="${i}"]:not(.hit--col):not(.hit--row)`).forEach((n) => n.classList.add('is-active'));

    // The tooltip, built from nodes rather than markup: labels are the model's words.
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'chart__tip-head';
    head.textContent = String(spec.labels[i]);
    tip.append(head);
    /** @type {{ name: string, value: number, colour: string, share?: boolean, j?: number }[]} */
    const rows = isPie
      ? [{ name: String(spec.labels[i]), value: spec.series[0]?.values[i], colour: PALETTE[i % PALETTE.length], share: true }]
      : isScatter
        ? spec.series.map((s) => ({ name: s.name, value: s.values[i], colour: PALETTE[(spec.group[i] || 0) % PALETTE.length] }))
        : spec.series
          .map((s, j) => ({ name: s.name, value: s.values[i], colour: PALETTE[j % PALETTE.length], j }))
          .filter((row) => !off.has(row.j));
    const total = isPie ? spec.series[0].values.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'chart__tip-row';
      const swatch = document.createElement('span');
      swatch.className = 'chart__swatch';
      swatch.style.background = row.colour;
      const name = document.createElement('span');
      name.className = 'chart__tip-name';
      name.textContent = isPie ? t('chart.share') : row.name;
      const value = document.createElement('span');
      value.className = 'chart__tip-value';
      value.textContent =
        formatValue(row.value, spec.format) +
        (row.share && total ? ` · ${((Number(row.value) / total) * 100).toFixed(1)}%` : '');
      line.append(swatch, name, value);
      tip.append(line);
    }
    if (spec.type === 'stacked' && rows.length > 1) {
      const sum = rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
      const line = document.createElement('div');
      line.className = 'chart__tip-row chart__tip-total';
      line.append(Object.assign(document.createElement('span'), { className: 'chart__swatch' }));
      line.append(Object.assign(document.createElement('span'), { className: 'chart__tip-name', textContent: t('chart.total') }));
      line.append(Object.assign(document.createElement('span'), { className: 'chart__tip-value', textContent: formatValue(sum, spec.format) }));
      tip.append(line);
    }
    tip.hidden = false;

    const column = hits.find((h) => h.getAttribute('data-i') === String(i));
    if (column && column.classList.contains('hit--col')) {
      const x = Number(column.getAttribute('x')) + Number(column.getAttribute('width')) / 2;
      const y = Number(column.getAttribute('y'));
      guide.setAttribute('x1', String(x));
      guide.setAttribute('x2', String(x));
      guide.setAttribute('y1', String(y));
      guide.setAttribute('y2', String(y + Number(column.getAttribute('height'))));
      guide.style.display = '';
    } else {
      guide.style.display = 'none';
    }
    place(anchor || column);
  };

  /** Beside what is being read, kept inside the stage. */
  const place = (anchor) => {
    const box = stage.getBoundingClientRect();
    const target = anchor?.getBoundingClientRect?.();
    if (!target || !box.width) return;
    const tipBox = tip.getBoundingClientRect();
    let left = target.left - box.left + target.width / 2 + 12;
    if (left + tipBox.width > box.width - 4) left = target.left - box.left + target.width / 2 - tipBox.width - 12;
    const top = Math.max(4, Math.min(target.top - box.top + 8, box.height - tipBox.height - 4));
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${top}px`;
  };

  for (const node of hits) {
    const i = Number(node.getAttribute('data-i'));
    node.addEventListener('pointerenter', () => show(i, node));
    node.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
      if (event.pointerType === 'mouse' && active === i) return;
      show(i, node);
    });
  }
  stage.addEventListener('pointerleave', clear);
  stage.addEventListener('blur', clear);
  stage.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    // Keys skip the points of a series set aside, the same as the eye does.
    const hidden = isScatter && off.size ? (/** @type {number} */ i) => off.has(spec.group[i]) : undefined;
    const i = keyStep(event.key, active, spec.labels.length - 1, hidden);
    if (i === undefined) {
      if (event.key === 'Escape') clear();
      return;
    }
    event.preventDefault();
    if (i === null) return;
    show(i, hits.find((h) => h.getAttribute('data-i') === String(i)));
  });

  // The legend sets a series aside, the way every charting tool does. The
  // scale does not change — that would be redrawing the chart, and the point is
  // to compare what is left against the same axis.
  if (!isPie && legendCount > 1) {
    for (const item of svg.querySelectorAll('.legend-item')) {
      const j = Number(item.getAttribute('data-s'));
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-pressed', 'true');
      const toggle = () => {
        if (off.has(j)) off.delete(j);
        else if (off.size < legendCount - 1) off.add(j);
        else return;
        const hidden = off.has(j);
        item.classList.toggle('is-off', hidden);
        item.setAttribute('aria-pressed', String(!hidden));
        svg.querySelectorAll(`[data-s="${j}"]:not(.legend-item)`).forEach((n) => n.classList.toggle('is-off', hidden));
        // A hidden point's target goes too, so it cannot be hovered invisibly.
        if (isScatter) {
          svg.querySelectorAll('.hit--pt').forEach((n) => {
            const g = spec.group[Number(n.getAttribute('data-i'))];
            n.classList.toggle('is-off', off.has(g));
          });
        }
        if (active >= 0) show(active, hits.find((h) => h.getAttribute('data-i') === String(active)));
      };
      item.addEventListener('click', toggle);
      item.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }
      });
    }
  }

  return figure;
}

/** The numbers as a table, for a screen reader — the picture says nothing to one. */
function dataTable(title, spec) {
  const table = document.createElement('table');
  table.className = 'sr-only';
  const caption = document.createElement('caption');
  caption.textContent = title || '';
  const head = document.createElement('tr');
  head.append(document.createElement('th'));
  for (const s of spec.series) head.append(Object.assign(document.createElement('th'), { textContent: s.name }));
  table.append(caption, head);
  spec.labels.forEach((label, i) => {
    const row = document.createElement('tr');
    row.append(Object.assign(document.createElement('th'), { textContent: String(label) }));
    for (const s of spec.series) {
      row.append(Object.assign(document.createElement('td'), { textContent: formatValue(s.values[i], spec.format) }));
    }
    table.append(row);
  });
  return table;
}
