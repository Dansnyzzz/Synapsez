import { api } from './api.js';
import { t } from './i18n.js';

/**
 * A workbook, drawn as a workbook (owner, 2026-11-05, screenshots 1 and 2).
 *
 * It was a plain table of its words: no colours, no widths, no charts, no way to see a
 * formula. Now it reads as the file does in Excel, the way Claude's viewer does: Data
 * and Charts on top, the formula bar, the real column widths and row heights, fills,
 * fonts, borders, merged and frozen cells, pictures and charts over the cells, the
 * sheets along the bottom; and the Charts tab names each chart and the sheet it is on.
 *
 * The server reads the file (`workbookModel`, server/office/draw/xlsx.js). Everything
 * from it reaches the page as text content or one CSS property at a time, never as
 * markup, since a workbook may have come from a stranger.
 *
 * Only what is near the screen is on the page, redrawn as it scrolls, so a sheet of
 * twenty thousand rows costs what a screenful does.
 */

/** Excel's sizes are points; a screen's are pixels. */
const PX = 4 / 3;
const HEAD_W = 46;
const HEAD_H = 22;
/** Rows drawn past the edge of the screen on either side, so a small scroll draws nothing. */
const EXTRA_ROWS = 30;

const el = (tag, className) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

/** A column's letters from its number, from 0. */
export function columnName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const BORDER = { hair: 'dotted', dotted: 'dotted', dashed: 'dashed', dashDot: 'dashed', dashDotDot: 'dashed', mediumDashed: 'dashed', mediumDashDot: 'dashed', mediumDashDotDot: 'dashed', slantDashDot: 'dashed', double: 'double' };

/** The last index in a sorted list at or before this position. */
function indexAt(positions, at) {
  let lo = 0;
  let hi = positions.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (positions[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One property at a time, so nothing in a file's font name can become another property. */
function applyLook(node, look) {
  if (!look) return;
  const s = node.style;
  if (look.f) s.fontFamily = `"${look.f}", Carlito, Calibri, Arial, sans-serif`;
  if (look.s) s.fontSize = `${look.s * PX}px`;
  if (look.b) s.fontWeight = '700';
  if (look.i) s.fontStyle = 'italic';
  if (look.u || look.x) s.textDecoration = `${look.u ? 'underline ' : ''}${look.x ? 'line-through' : ''}`.trim();
  if (look.c) s.color = `#${look.c}`;
  if (look.g2) s.background = `linear-gradient(${90 + (Number(look.gd) || 0)}deg, #${look.g}, #${look.g2})`;
  else if (look.g) s.backgroundColor = `#${look.g}`;
  if (look.w) {
    s.whiteSpace = 'pre-wrap';
    s.overflowWrap = 'anywhere';
  }
  if (look.n) s.paddingLeft = `${look.n * 9 + 2}px`;
  const v = look.v === 'center' || look.v === 'distributed' || look.v === 'justify' ? 'center' : look.v === 'top' ? 'flex-start' : 'flex-end';
  s.alignItems = v;
  for (const [key, side] of [['bt', 'Top'], ['bb', 'Bottom'], ['bl', 'Left'], ['br', 'Right']]) {
    const edge = look[key];
    if (edge) s[`border${side}`] = `${Math.max(1, Math.round(edge[0] * PX))}px ${BORDER[edge[1]] || 'solid'} #${edge[2]}`;
  }
}

/**
 * Draw a workbook into `host`.
 *
 * @param {HTMLElement} host
 * @param {{ fileId: string, revision?: number|null, version?: string|number, onUnavailable?: (err?: unknown) => void }} options
 *   `onUnavailable`: this server cannot read it this way, so the caller draws what it has.
 * @returns {{ destroy: () => void }}
 */
export function mountWorkbook(host, { fileId, revision = null, version = '', onUnavailable = () => {} }) {
  const root = el('div', 'xlv');
  const head = el('div', 'xlv__modes');
  head.setAttribute('role', 'tablist');
  const dataTab = el('button', 'xlv__mode is-active');
  const chartsTab = el('button', 'xlv__mode');
  for (const button of [dataTab, chartsTab]) {
    button.type = 'button';
    button.setAttribute('role', 'tab');
  }
  dataTab.textContent = t('viewer.xl.data');
  dataTab.setAttribute('aria-selected', 'true');
  chartsTab.hidden = true;
  head.append(dataTab, chartsTab);

  const bar = el('div', 'xlv__bar');
  const refNode = el('span', 'xlv__ref');
  const fx = el('span', 'xlv__fx');
  fx.textContent = 'fx';
  const formula = el('span', 'xlv__formula');
  formula.setAttribute('aria-live', 'polite');
  bar.append(refNode, fx, formula);

  const scroller = el('div', 'xlv__scroll');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'grid');
  const sheetArea = el('div', 'xlv__sheet');
  const corner = el('div', 'xlv__corner');
  const colsWrap = el('div', 'xlv__cols');
  const rowsWrap = el('div', 'xlv__rows');
  // What Excel keeps in view while the rest scrolls under it: rows, columns, and where they meet.
  const frozenTop = el('div', 'xlv__frozen xlv__frozen--top');
  const frozenLeft = el('div', 'xlv__frozen xlv__frozen--left');
  const frozenBoth = el('div', 'xlv__frozen xlv__frozen--both');
  const body = el('div', 'xlv__body');
  const lines = el('div', 'xlv__lines');
  const cellsLayer = el('div', 'xlv__cells');
  const picturesLayer = el('div', 'xlv__pictures');
  const selection = el('div', 'xlv__selected');
  selection.hidden = true;
  body.append(lines, cellsLayer, picturesLayer, selection);
  sheetArea.append(corner, colsWrap, frozenBoth, frozenTop, frozenLeft, rowsWrap, body);
  scroller.append(sheetArea);

  const tabsNode = el('div', 'xlv__sheets');
  tabsNode.setAttribute('role', 'tablist');
  const noteNode = el('p', 'xlv__note');
  noteNode.hidden = true;
  const chartsView = el('div', 'xlv__charts');
  chartsView.hidden = true;
  root.append(head, bar, scroller, noteNode, tabsNode, chartsView);
  host.replaceChildren(root);

  let destroyed = false;
  let model = null;
  /** The sheet on screen, its rows added to as they arrive. */
  let sheet = null;
  /** @type {Map<number, any[]>} */
  let rowCells = new Map();
  /** @type {Map<string, any[]>} */
  let cellAt = new Map();
  let merges = [];
  const loaded = new Set();
  let loading = false;
  let drawnFrom = -1;
  let drawnTo = -1;
  let active = null;
  let frame = 0;
  const revisionQuery = revision != null ? `&rev=${encodeURIComponent(revision)}` : '';

  const x = (c) => sheet.colX[Math.min(c, sheet.colX.length - 1)] * PX;
  const y = (r) => sheet.rowY[Math.min(r, sheet.rowY.length - 1)] * PX;
  const lastCol = () => sheet.colX.length - 2;
  const lastRow = () => sheet.rowY.length - 2;
  const key = (r, c) => `${r},${c}`;

  function absorb(part) {
    sheet.styles = part.styles;
    for (const cell of part.cells) {
      if (!rowCells.has(cell[0])) rowCells.set(cell[0], []);
      rowCells.get(cell[0]).push(cell);
      cellAt.set(key(cell[0], cell[1]), cell);
    }
    for (const m of part.merges) if (!merges.some((o) => o[0] === m[0] && o[1] === m[1])) merges.push(m);
    Object.assign(sheet.rowStyles, part.rowStyles);
    for (let r = part.from; r <= part.to; r += 1) loaded.add(r);
    sheet.to = Math.max(sheet.to, part.to);
  }

  /** Rows below what has arrived, as they come near the screen. Styles are per answer, so each row keeps its own. */
  async function loadFrom(from) {
    if (loading || destroyed) return;
    loading = true;
    try {
      const next = await api.workbook(fileId, { sheet: sheet.number, from, rev: revision });
      if (destroyed || next.sheet.number !== sheet.number) return;
      const offset = sheet.allStyles.length;
      sheet.allStyles.push(...next.sheet.styles);
      for (const cell of next.sheet.cells) cell[3] += offset;
      for (const r of Object.keys(next.sheet.rowStyles)) next.sheet.rowStyles[r] += offset;
      absorb(next.sheet);
      drawnFrom = -1;
      paint();
    } catch {
      /* Scrolling on asks again. */
    } finally {
      loading = false;
    }
  }

  function drawHeads() {
    const totalW = x(lastCol() + 1);
    const totalH = y(lastRow() + 1);
    sheetArea.style.width = `${HEAD_W + totalW + 40}px`;
    sheetArea.style.height = `${HEAD_H + totalH + 40}px`;
    body.style.left = `${HEAD_W}px`;
    body.style.top = `${HEAD_H}px`;
    body.style.width = `${totalW}px`;
    body.style.height = `${totalH}px`;
    colsWrap.replaceChildren();
    colsWrap.style.width = `${totalW}px`;
    for (let c = 0; c <= lastCol(); c += 1) {
      const w = x(c + 1) - x(c);
      if (w <= 0) continue;
      const cell = el('div', 'xlv__col');
      cell.style.left = `${x(c)}px`;
      cell.style.width = `${w}px`;
      cell.textContent = columnName(c);
      colsWrap.append(cell);
    }
    const hideHeads = sheet.showHeaders === false;
    root.classList.toggle('xlv--no-heads', hideHeads);
    lines.replaceChildren();
    // A whole column's fill or border, for the cells that have nothing else to say.
    for (const [c, styleId] of Object.entries(sheet.colStyles || {})) {
      const band = el('div', 'xlv__band');
      band.style.left = `${x(Number(c))}px`;
      band.style.width = `${x(Number(c) + 1) - x(Number(c))}px`;
      band.style.height = `${totalH}px`;
      applyLook(band, sheet.allStyles[styleId]);
      lines.append(band);
    }
    if (sheet.showGrid !== false) {
      for (let c = 0; c <= lastCol() + 1; c += 1) {
        const line = el('i', 'xlv__vline');
        line.style.left = `${x(c)}px`;
        line.style.height = `${totalH}px`;
        lines.append(line);
      }
    }
    const frozenH = y(sheet.frozenRows || 0);
    const frozenW = x(sheet.frozenCols || 0);
    frozenTop.hidden = !frozenH;
    frozenLeft.hidden = !frozenW;
    frozenBoth.hidden = !frozenH || !frozenW;
    frozenTop.style.cssText = `margin-left:${HEAD_W}px;width:${totalW}px;height:${frozenH}px;margin-bottom:${-frozenH}px`;
    frozenLeft.style.cssText = `left:${HEAD_W}px;width:${frozenW}px;height:${totalH}px;margin-bottom:${-totalH}px;margin-left:${HEAD_W}px`;
    frozenBoth.style.cssText = `left:${HEAD_W}px;margin-left:${HEAD_W}px;width:${frozenW}px;height:${frozenH}px;margin-bottom:${-frozenH}px`;
    picturesLayer.replaceChildren();
    for (const drawing of sheet.drawings) {
      const picture = el('img', 'xlv__picture');
      picture.loading = 'lazy';
      picture.alt = '';
      picture.src = `/api/attachments/${encodeURIComponent(fileId)}/drawing/${sheet.number}/${drawing.i}?v=${encodeURIComponent(version)}${revisionQuery}`;
      picture.style.left = `${drawing.x * PX}px`;
      picture.style.top = `${drawing.y * PX}px`;
      picture.style.width = `${drawing.w * PX}px`;
      picture.style.height = `${drawing.h * PX}px`;
      picturesLayer.append(picture);
    }
  }

  function cellNode(cell) {
    const [r, c, text, styleId, extra] = cell;
    const look = sheet.allStyles[styleId];
    const merge = merges.find((m) => m[0] === r && m[1] === c);
    const left = x(c);
    const width = x((merge ? merge[3] : c) + 1) - left;
    const top = y(r);
    const height = y((merge ? merge[2] : r) + 1) - top;
    if (width <= 0 || height <= 0) return null;
    const node = el('div', 'xlv__cell');
    const s = node.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.height = `${height}px`;
    applyLook(node, look);
    const number = extra?.k === 'n';
    const across = look?.h === 'center' || look?.h === 'centerContinuous' ? 'center' : look?.h === 'right' || (!look?.h && number) ? 'flex-end' : extra?.k === 'b' || extra?.k === 'e' ? 'center' : 'flex-start';
    s.justifyContent = across;
    if (look?.w) s.textAlign = across === 'center' ? 'center' : across === 'flex-end' ? 'right' : 'left';
    // Words that do not wrap run on over empty neighbours, as they do in Excel.
    let shown = width;
    if (text && !number && !look?.w && !merge && across === 'flex-start') {
      for (let next = c + 1; next <= lastCol() && next < c + 40; next += 1) {
        const neighbour = cellAt.get(key(r, next));
        if (neighbour?.[2] || merges.some((m) => r >= m[0] && r <= m[2] && next >= m[1] && next <= m[3])) break;
        shown += x(next + 1) - x(next);
      }
    }
    s.width = `${shown}px`;
    if (shown !== width && look?.g) {
      // Its fill stays its own cell's; only the words run on.
      s.background = `linear-gradient(to right, #${look.g} ${width}px, transparent ${width}px)`;
    }
    if (look?.r) {
      const degrees = look.r === 255 ? 0 : look.r > 90 ? look.r - 90 : -look.r;
      if (look.r === 255) s.writingMode = 'vertical-rl';
      else {
        const span = el('span');
        span.style.transform = `rotate(${degrees}deg)`;
        span.style.display = 'inline-block';
        span.textContent = text;
        node.append(span);
      }
    }
    if (extra?.bar) {
      const bar2 = el('i', 'xlv__bar-fill');
      bar2.style.width = `${Math.round(extra.bar[0] * 100)}%`;
      bar2.style.background = `linear-gradient(to right, #${extra.bar[1]}, #${extra.bar[1]}40)`;
      node.append(bar2);
    }
    if (extra?.rule && !look?.bb) s.borderBottom = `1px solid #${extra.rule}`;
    if (extra?.runs?.length) {
      const span = el('span', 'xlv__text');
      for (const run of extra.runs) {
        const piece = el('span');
        piece.textContent = run.t;
        if (run.b) piece.style.fontWeight = '700';
        if (run.i) piece.style.fontStyle = 'italic';
        if (run.u || run.x) piece.style.textDecoration = `${run.u ? 'underline ' : ''}${run.x ? 'line-through' : ''}`.trim();
        if (run.c) piece.style.color = `#${run.c}`;
        if (run.s) piece.style.fontSize = `${run.s * PX}px`;
        span.append(piece);
      }
      node.append(span);
    } else if (!(look?.r && look.r !== 255) && text) {
      const span = el('span', 'xlv__text');
      span.textContent = text;
      node.append(span);
    }
    return node;
  }

  /** What stays in view: every frozen row, and the frozen columns of the rows on screen. */
  function fillFrozen(r0, r1) {
    const rows = sheet.frozenRows || 0;
    const cols = sheet.frozenCols || 0;
    const top = [];
    const left = [];
    const both = [];
    const place = (cell) => {
      const node = cellNode(cell);
      if (!node) return;
      if (cell[0] < rows && cell[1] < cols) both.push(node);
      else if (cell[0] < rows) top.push(node);
      else if (cell[1] < cols) left.push(node);
    };
    for (let r = 0; r < rows; r += 1) for (const cell of rowCells.get(r) || []) place(cell);
    if (cols) for (let r = Math.max(rows, r0); r <= r1; r += 1) for (const cell of rowCells.get(r) || []) if (cell[1] < cols) place(cell);
    frozenTop.replaceChildren(...top);
    frozenLeft.replaceChildren(...left);
    frozenBoth.replaceChildren(...both);
  }

  function fillRange(r0, r1) {
    fillFrozen(r0, r1);
    const nodes = [];
    for (let r = r0; r <= r1; r += 1) {
      const rowStyle = sheet.rowStyles[r];
      if (rowStyle != null) {
        const band = el('div', 'xlv__band');
        band.style.top = `${y(r)}px`;
        band.style.height = `${y(r + 1) - y(r)}px`;
        band.style.width = `${x(lastCol() + 1)}px`;
        applyLook(band, sheet.allStyles[rowStyle]);
        nodes.push(band);
      }
      const line = el('i', 'xlv__hline');
      if (sheet.showGrid !== false) {
        line.style.top = `${y(r + 1)}px`;
        line.style.width = `${x(lastCol() + 1)}px`;
        nodes.push(line);
      }
      for (const cell of rowCells.get(r) || []) {
        const node = cellNode(cell);
        if (node) nodes.push(node);
      }
    }
    // A merge that began above still has to be there.
    for (const m of merges) {
      if (m[0] < r0 && m[2] >= r0) {
        const cell = cellAt.get(key(m[0], m[1]));
        const node = cell && cellNode(cell);
        if (node) nodes.push(node);
      }
    }
    cellsLayer.replaceChildren(...nodes);
    const numbers = [];
    for (let r = r0; r <= r1; r += 1) {
      const h = y(r + 1) - y(r);
      if (h <= 0) continue;
      const cell = el('div', 'xlv__row');
      cell.style.top = `${y(r)}px`;
      cell.style.height = `${h}px`;
      cell.textContent = String(r + 1);
      numbers.push(cell);
    }
    rowsWrap.replaceChildren(...numbers);
    rowsWrap.style.height = `${y(lastRow() + 1)}px`;
  }

  function paint() {
    if (!sheet || destroyed) return;
    const top = Math.max(0, scroller.scrollTop - HEAD_H);
    const first = indexAt(sheet.rowY, top / PX);
    const last = indexAt(sheet.rowY, (top + scroller.clientHeight) / PX);
    if (first < drawnFrom + 5 && drawnFrom > 0 || last > drawnTo - 5 || drawnFrom < 0) {
      drawnFrom = Math.max(0, first - EXTRA_ROWS);
      drawnTo = Math.min(lastRow(), last + EXTRA_ROWS);
      fillRange(drawnFrom, drawnTo);
    }
    if (last + EXTRA_ROWS > sheet.to && sheet.to < sheet.lastRow) loadFrom(sheet.to + 1);
  }

  scroller.addEventListener('scroll', () => {
    // Nothing is under what is frozen until something has scrolled there: a chart that
    // starts in a frozen column stays whole until then.
    frozenLeft.classList.toggle('is-over', scroller.scrollLeft > 0);
    frozenTop.classList.toggle('is-over', scroller.scrollTop > 0);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  });

  function select(r, c) {
    const merge = merges.find((m) => r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3]);
    const row = merge ? merge[0] : r;
    const col = merge ? merge[1] : c;
    active = { r: row, c: col };
    const cell = cellAt.get(key(row, col));
    refNode.textContent = `${columnName(col)}${row + 1}`;
    formula.textContent = cell?.[4]?.f ? `=${cell[4].f}` : cell?.[4]?.v != null ? String(cell[4].v) : cell?.[2] || '';
    selection.hidden = false;
    selection.style.left = `${x(col)}px`;
    selection.style.top = `${y(row)}px`;
    selection.style.width = `${x((merge ? merge[3] : col) + 1) - x(col)}px`;
    selection.style.height = `${y((merge ? merge[2] : row) + 1) - y(row)}px`;
    scroller.setAttribute('aria-label', `${columnName(col)}${row + 1} ${cell?.[2] || ''}`.trim());
  }

  sheetArea.addEventListener('click', (event) => {
    const box = scroller.getBoundingClientRect();
    const across = event.clientX - box.left - HEAD_W;
    const down = event.clientY - box.top - HEAD_H;
    if (across < 0 || down < 0) return;
    // Over what is frozen, where it is on the screen is where it is on the sheet.
    const atX = across < x(sheet.frozenCols || 0) ? across : across + scroller.scrollLeft;
    const atY = down < y(sheet.frozenRows || 0) ? down : down + scroller.scrollTop;
    select(indexAt(sheet.rowY, atY / PX), indexAt(sheet.colX, atX / PX));
    scroller.focus({ preventScroll: true });
  });

  scroller.addEventListener('keydown', (event) => {
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, event.shiftKey ? -1 : 1], Enter: [1, 0] };
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && active) {
      const cell = cellAt.get(key(active.r, active.c));
      if (cell?.[2]) navigator.clipboard?.writeText(String(cell[2])).catch(() => {});
      return;
    }
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const from = active || { r: 0, c: 0 };
    const r = Math.max(0, Math.min(lastRow(), from.r + move[0]));
    const c = Math.max(0, Math.min(lastCol(), from.c + move[1]));
    select(r, c);
    const left = x(c) + HEAD_W;
    const right = x(c + 1) + HEAD_W;
    const above = y(r) + HEAD_H;
    const below = y(r + 1) + HEAD_H;
    if (left - HEAD_W < scroller.scrollLeft) scroller.scrollLeft = left - HEAD_W;
    else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
    if (above - HEAD_H < scroller.scrollTop) scroller.scrollTop = above - HEAD_H;
    else if (below > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = below - scroller.clientHeight;
  });

  function drawTabs() {
    tabsNode.replaceChildren(
      ...model.sheets.map((entry) => {
        const button = el('button', `xlv__tab${entry.n === sheet?.number ? ' is-active' : ''}`);
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(entry.n === sheet?.number));
        button.textContent = entry.name;
        button.addEventListener('click', () => openSheet(entry.n));
        return button;
      }),
    );
    tabsNode.hidden = model.sheets.length < 2 && !model.hiddenSheets;
    if (model.hiddenSheets) {
      const more = el('span', 'xlv__hidden');
      more.textContent = t('viewer.xl.hidden', { n: model.hiddenSheets });
      tabsNode.append(more);
    }
  }

  function drawCharts() {
    const charts = model.charts || [];
    chartsTab.hidden = !charts.length;
    chartsTab.replaceChildren();
    const label = el('span');
    label.textContent = t('viewer.xl.charts');
    const count = el('span', 'xlv__count');
    count.textContent = String(charts.length);
    chartsTab.append(label, count);
    chartsView.replaceChildren();
    if (!charts.length) return;
    const list = el('div', 'xlv__chart-tabs');
    list.setAttribute('role', 'tablist');
    const figure = el('figure', 'xlv__chart');
    const picture = el('img');
    const caption = el('figcaption', 'xlv__chart-title');
    figure.append(caption, picture);
    const show = (chart, button) => {
      for (const other of list.children) other.classList.toggle('is-active', other === button);
      picture.src = `/api/attachments/${encodeURIComponent(fileId)}/drawing/${chart.sheet}/${chart.drawing}?v=${encodeURIComponent(version)}${revisionQuery}`;
      const name = chart.title || t('viewer.xl.chartN', { n: charts.indexOf(chart) + 1 });
      picture.alt = name;
      caption.textContent = `${name} · ${chart.sheetName}`;
    };
    charts.forEach((chart, i) => {
      const button = el('button', 'xlv__chart-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      const name = el('span', 'xlv__chart-name');
      name.textContent = chart.title || t('viewer.xl.chartN', { n: i + 1 });
      const where = el('span', 'xlv__chart-sheet');
      where.textContent = chart.sheetName;
      button.append(name, where);
      button.addEventListener('click', () => show(chart, button));
      list.append(button);
    });
    chartsView.append(list, figure);
    show(charts[0], list.children[0]);
  }

  function setMode(charts) {
    dataTab.classList.toggle('is-active', !charts);
    dataTab.setAttribute('aria-selected', String(!charts));
    chartsTab.classList.toggle('is-active', charts);
    chartsTab.setAttribute('aria-selected', String(charts));
    bar.hidden = charts;
    scroller.hidden = charts;
    tabsNode.hidden = charts || (model.sheets.length < 2 && !model.hiddenSheets);
    chartsView.hidden = !charts;
    if (!charts) {
      drawnFrom = -1;
      paint();
    }
  }
  dataTab.addEventListener('click', () => setMode(false));
  chartsTab.addEventListener('click', () => setMode(true));

  async function openSheet(number) {
    scroller.classList.add('is-loading');
    try {
      const next = await api.workbook(fileId, { sheet: number, from: 0, rev: revision });
      if (destroyed) return;
      model = next;
      sheet = { ...next.sheet, allStyles: [...next.sheet.styles], rowStyles: { ...next.sheet.rowStyles } };
      rowCells = new Map();
      cellAt = new Map();
      merges = [];
      loaded.clear();
      drawnFrom = -1;
      drawnTo = -1;
      active = null;
      selection.hidden = true;
      refNode.textContent = '';
      formula.textContent = '';
      absorb(next.sheet);
      sheet.styles = next.sheet.styles;
      drawHeads();
      drawTabs();
      if (!chartsView.childElementCount) drawCharts();
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      noteNode.hidden = !next.sheet.cut;
      if (next.sheet.cut) noteNode.textContent = t('viewer.xl.cut', { n: next.sheet.cut });
      paint();
      select(0, 0);
    } catch (err) {
      if (!sheet) onUnavailable(err);
    } finally {
      scroller.classList.remove('is-loading');
    }
  }

  openSheet(1);

  return {
    destroy() {
      destroyed = true;
      if (frame) window.cancelAnimationFrame(frame);
      root.remove();
    },
  };
}
