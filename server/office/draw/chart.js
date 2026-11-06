/**
 * Charts, from the numbers they saved.
 *
 * A chart part keeps a cached copy of its data so it can be shown without the
 * workbook behind it, and that is enough to draw one a model can read: bars, lines,
 * areas, pies and scatter, with its title, axes, legend and labels. It is not
 * Office's rendering and does not try to be pixel for pixel, so the caller adds a
 * note saying so. What matters here is that the numbers and the shape of the data
 * are really there, instead of a grey box.
 *
 * Anything else (a radar, a stock chart, a 2016 waterfall) returns false, and the
 * caller draws a labelled box and says so.
 */
import { attr, element, elements, localName, parseXml, textOf } from '../xml.js';
import { colorIn, cssIn, fillIn, paintFor, strokeFrom } from './dml.js';
import { clamp, css } from './common.js';

const POINTS = 2000;

/** A series' cached strings or numbers, by position. */
function cached(ref) {
  const cache = element(ref, 'strCache') || element(ref, 'numCache') || element(ref, 'strLit') || element(ref, 'numLit');
  if (!cache) return [];
  const count = Math.min(Number(attr(element(cache, 'ptCount'), 'val')) || 0, POINTS);
  const out = Array.from({ length: count }, () => null);
  for (const pt of elements(cache, 'pt')) {
    const at = Number(attr(pt, 'idx'));
    if (at >= 0 && at < POINTS) out[at] = textOf(element(pt, 'v'));
  }
  return out;
}

const dataOf = (parent) => {
  if (!parent) return [];
  for (const child of elements(parent)) {
    const values = cached(child);
    if (values.length) return values;
  }
  return [];
};

function readSeries(node, index, env) {
  const values = dataOf(element(node, 'val')).map((v) => (v == null || v === '' ? null : Number(v)));
  const fill = fillIn(element(node, 'spPr'), env);
  const accent = { hex: env.theme?.colors?.[`accent${(index % 6) + 1}`] || '4472C4' };
  const color = fill?.type === 'solid' ? fill.color : fill?.type === 'grad' ? fill.stops[0][1] : `#${accent.hex}`;
  const ln = element(element(node, 'spPr'), 'ln');
  const stroke = ln ? strokeFrom(ln, env, { color, width: 2.25, dash: null, cap: 'round', join: 'round', head: null, tail: null }) : null;
  const points = new Map();
  for (const dPt of elements(node, 'dPt')) {
    const dFill = fillIn(element(dPt, 'spPr'), env);
    if (dFill?.type === 'solid') points.set(Number(attr(element(dPt, 'idx'), 'val')), dFill.color);
  }
  return {
    name: dataOf(element(node, 'tx')).join(' '),
    categories: dataOf(element(node, 'cat')),
    xValues: dataOf(element(node, 'xVal')).map(Number),
    values: values.length ? values : dataOf(element(node, 'yVal')).map(Number),
    color,
    stroke,
    points,
    labels: element(node, 'dLbls'),
  };
}

const CHART_TYPES = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart'];

/** A round axis: nice steps that cover the data, zero included when bars need it. */
function niceAxis(low, high, ticks = 5) {
  const lo = Math.min(low, 0);
  const hi = high <= lo ? lo + 1 : high;
  const raw = (hi - lo) / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

function formatNumber(value, code) {
  const format = String(code || '');
  if (/%/.test(format)) return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  const decimals = Math.abs(value) >= 100 || Number.isInteger(value) ? 0 : 2;
  return value.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

/**
 * @param {import('./common.js').Surface} surface
 * @param {string} part  the chart's part in the package
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @param {any} env
 * @returns {boolean} whether a chart was drawn
 */
export function drawChart(surface, part, box, env) {
  if (!part || !env.zip.has(part) || box.w < 8 || box.h < 8) return false;
  const root = parseXml(env.zip.text(part));
  const chart = element(root, 'chart');
  const plot = element(chart, 'plotArea');
  if (!plot) return false;
  const groups = elements(plot).filter((node) => CHART_TYPES.includes(localName(node.name)));
  if (!groups.length) return false;

  const ground = element(root, 'spPr');
  const groundFill = ground ? fillIn(ground, env) : (env.chartGround ? { type: 'solid', color: env.chartGround } : null);
  if (groundFill) {
    const paint = paintFor(groundFill, box.x, box.y, box.w, box.h);
    if (paint) surface.rect(box.x, box.y, box.w, box.h, paint);
  }
  if (ground && element(ground, 'ln')) {
    const stroke = strokeFrom(element(ground, 'ln'), env);
    if (stroke) surface.path([['M', box.x, box.y], ['L', box.x + box.w, box.y], ['L', box.x + box.w, box.y + box.h], ['L', box.x, box.y + box.h], ['Z']], { stroke: stroke.color, width: stroke.width });
  }

  const txPr = element(root, 'txPr');
  const fromFile = Number(attr(element(element(element(txPr, 'p'), 'pPr'), 'defRPr'), 'sz')) / 100;
  const base = clamp(fromFile || Math.min(box.h / 22, 12), 6, 18);
  const pick = env.fonts.pick(env.theme?.minor || 'Calibri');
  const bold = env.fonts.pick(env.theme?.minor || 'Calibri', true);
  const ink = cssIn(element(element(element(element(txPr, 'p'), 'pPr'), 'defRPr'), 'solidFill'), env) || '#404040';
  const widthOf = (text, size, face = pick) => env.fonts.pieces(text, face).reduce((sum, p) => sum + env.measure.width(p.pick, size, p.text), 0);
  const put = (text, x, y, size, { align = 'left', face = pick, color = ink } = {}) => {
    const w = widthOf(text, size, face);
    let at = x - (align === 'center' ? w / 2 : align === 'right' ? w : 0);
    for (const piece of env.fonts.pieces(text, face)) {
      surface.text(piece.text, at, y, { pick: piece.pick, size, color });
      at += env.measure.width(piece.pick, size, piece.text);
    }
  };

  let top = box.y + base * 0.5;
  const titleNode = element(chart, 'title');
  const all = groups.flatMap((group) => elements(group, 'ser'));
  const series = all.map((node, i) => readSeries(node, i, env));
  let title = '';
  if (titleNode) {
    title = [...elements(element(element(titleNode, 'tx'), 'rich'), 'p')].map((p) => elements(p, 'r').map((r) => textOf(element(r, 't'))).join('')).join(' ').trim();
    if (!title) title = dataOf(element(titleNode, 'tx')).join(' ');
  }
  if (!title && !titleNode && series.length === 1 && attr(element(chart, 'autoTitleDeleted'), 'val') !== '1') title = series[0].name;
  if (title) {
    const size = base * 1.4;
    put(title, box.x + box.w / 2, top + size, size, { align: 'center', face: bold });
    top += size * 1.6;
  }

  const kind = localName(groups[0].name);
  const round = kind.startsWith('pie') || kind.startsWith('doughnut');
  const legendNode = element(chart, 'legend');
  const legendPos = String(attr(element(legendNode, 'legendPos'), 'val') || 'r');
  const cats = series.find((s) => s.categories.length)?.categories || [];
  const legendEntries = round
    ? cats.map((name, i) => ({ name: String(name ?? ''), color: series[0]?.points.get(i) || `#${env.theme?.colors?.[`accent${(i % 6) + 1}`] || '4472C4'}` }))
    : series.map((s, i) => ({ name: s.name || `Series${i + 1}`, color: s.color }));

  let left = box.x + base * 0.5;
  let right = box.x + box.w - base * 0.5;
  let bottom = box.y + box.h - base * 0.5;
  if (legendNode && legendEntries.length) {
    const rowH = base * 1.5;
    if (legendPos === 'r' || legendPos === 'l') {
      const wide = Math.max(...legendEntries.map((e) => widthOf(e.name, base))) + base * 1.6;
      const room = Math.min(wide, box.w * 0.34);
      const x = legendPos === 'r' ? right - room : left;
      let y = top + Math.max(0, (bottom - top - legendEntries.length * rowH) / 2);
      for (const entry of legendEntries.slice(0, 24)) {
        surface.rect(x, y + base * 0.2, base * 0.8, base * 0.8, entry.color);
        put(entry.name, x + base * 1.1, y + base, base);
        y += rowH;
      }
      if (legendPos === 'r') right -= room + base;
      else left += room + base;
    } else {
      const total = legendEntries.reduce((sum, e) => sum + widthOf(e.name, base) + base * 2.2, 0);
      const y = legendPos === 't' ? top : bottom - rowH;
      let x = box.x + Math.max(base, (box.w - total) / 2);
      for (const entry of legendEntries.slice(0, 24)) {
        surface.rect(x, y + base * 0.25, base * 0.8, base * 0.8, entry.color);
        put(entry.name, x + base * 1.1, y + base, base);
        x += widthOf(entry.name, base) + base * 2.2;
      }
      if (legendPos === 't') top += rowH;
      else bottom -= rowH;
    }
  }

  if (round) return drawRound(surface, kind, groups[0], series[0], { left, right, top, bottom }, { put, base, env });
  return drawAxes(surface, kind, groups, plot, series, cats, { left, right, top, bottom }, { put, widthOf, base, ink, env });
}

/** Pies and doughnuts, largest detail first: each slice's share is what the model is after. */
function drawRound(surface, kind, group, series, area, { put, base, env }) {
  if (!series?.values?.length) return false;
  const total = series.values.reduce((sum, v) => sum + Math.abs(v || 0), 0) || 1;
  const cx = (area.left + area.right) / 2;
  const cy = (area.top + area.bottom) / 2;
  const radius = Math.max(4, Math.min(area.right - area.left, area.bottom - area.top) / 2 - base);
  const hole = kind.startsWith('doughnut') ? clamp((Number(attr(element(group, 'holeSize'), 'val')) || 50) / 100, 0.1, 0.9) : 0;
  const first = ((Number(attr(element(group, 'firstSliceAng'), 'val')) || 0) - 90) * (Math.PI / 180);
  let angle = first;
  series.values.forEach((value, i) => {
    env.budget?.check();
    const sweep = (Math.abs(value || 0) / total) * Math.PI * 2;
    const color = series.points.get(i) || `#${env.theme?.colors?.[`accent${(i % 6) + 1}`] || '4472C4'}`;
    const path = hole
      ? [['E', cx, cy, radius, radius, angle, angle + sweep], ['E', cx, cy, radius * hole, radius * hole, angle + sweep, angle, true], ['Z']]
      : [['M', cx, cy], ['E', cx, cy, radius, radius, angle, angle + sweep], ['Z']];
    surface.path(path, { fill: color, stroke: '#FFFFFF', width: 0.75 });
    if (sweep > 0.18) {
      const mid = angle + sweep / 2;
      const at = hole ? radius * (1 + hole) / 2 : radius * 0.62;
      put(`${Math.round((Math.abs(value || 0) / total) * 100)}%`, cx + Math.cos(mid) * at, cy + Math.sin(mid) * at + base * 0.35, base, { align: 'center', color: '#FFFFFF' });
    }
    angle += sweep;
  });
  return true;
}

function drawAxes(surface, kind, groups, plot, series, cats, area, { put, widthOf, base, ink, env }) {
  const scatter = kind === 'scatterChart';
  const horizontal = attr(element(groups[0], 'barDir'), 'val') === 'bar';
  const grouping = String(attr(element(groups[0], 'grouping'), 'val') || 'clustered');
  const stacked = /stacked/i.test(grouping);
  const percent = /percent/i.test(grouping);
  const count = Math.max(...series.map((s) => s.values.length), 1);

  /** Totals per category, for stacks. */
  const stackTop = [];
  for (let i = 0; i < count; i += 1) {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = s.values[i] || 0;
      if (v >= 0) up += v;
      else down += v;
    }
    stackTop.push([up, down]);
  }
  const values = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!values.length) return false;
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (stacked) {
    low = Math.min(...stackTop.map((t) => t[1]));
    high = Math.max(...stackTop.map((t) => t[0]));
  }
  if (percent) {
    low = 0;
    high = 1;
  }
  const valAx = element(plot, 'valAx');
  const scaling = element(valAx, 'scaling');
  const statedMin = attr(element(scaling, 'min'), 'val');
  const statedMax = attr(element(scaling, 'max'), 'val');
  const axis = niceAxis(low, high);
  if (statedMin !== undefined) axis.min = Number(statedMin);
  if (statedMax !== undefined) axis.max = Number(statedMax);
  const code = attr(element(valAx, 'numFmt'), 'formatCode') || (percent ? '0%' : '');
  const span = axis.max - axis.min || 1;
  const ticks = [];
  for (let v = axis.min; v <= axis.max + axis.step / 2 && ticks.length < 24; v += axis.step) ticks.push(v);
  const hideValues = attr(element(valAx, 'delete'), 'val') === '1';
  const labelW = hideValues ? 0 : Math.max(...ticks.map((t) => widthOf(formatNumber(t, code), base))) + base * 0.5;

  const catLabels = Array.from({ length: count }, (_, i) => String(cats[i] ?? (scatter ? '' : i + 1)));
  const catW = Math.max(...catLabels.map((c) => widthOf(c, base)), 1);
  const left = area.left + (horizontal ? Math.min(catW + base * 0.5, (area.right - area.left) * 0.35) : labelW);
  const right = area.right - base * 0.4;
  const top = area.top + base * 0.4;
  const bottom = area.bottom - base * 1.4;
  const w = Math.max(4, right - left);
  const h = Math.max(4, bottom - top);
  const gridColor = '#D9D9D9';
  const showGrid = !!element(valAx, 'majorGridlines');

  const valueAt = (v) => (horizontal ? left + ((v - axis.min) / span) * w : bottom - ((v - axis.min) / span) * h);
  for (const t of ticks) {
    const at = valueAt(t);
    if (showGrid) {
      if (horizontal) surface.line(at, top, at, bottom, gridColor, 0.5);
      else surface.line(left, at, right, at, gridColor, 0.5);
    }
    if (hideValues) continue;
    if (horizontal) put(formatNumber(t, code), at, bottom + base * 1.15, base, { align: 'center' });
    else put(formatNumber(t, code), left - base * 0.35, at + base * 0.35, base, { align: 'right' });
  }
  const zero = valueAt(clamp(0, axis.min, axis.max));

  const slot = (horizontal ? h : w) / count;
  const labelEvery = horizontal ? 1 : Math.max(1, Math.ceil((catW + base) / Math.max(1, slot)));
  catLabels.forEach((label, i) => {
    if (i % labelEvery || !label) return;
    if (horizontal) put(label, left - base * 0.4, top + slot * (i + 0.5) + base * 0.35, base, { align: 'right' });
    else if (!scatter) put(label, left + slot * (i + 0.5), bottom + base * 1.15, base, { align: 'center' });
  });

  const isBar = kind.startsWith('bar');
  const isArea = kind.startsWith('area');
  if (isBar) {
    const gap = Number(attr(element(groups[0], 'gapWidth'), 'val') ?? 150) / 100;
    const bars = stacked ? 1 : series.length;
    const thick = slot / (bars + (Number.isFinite(gap) ? gap : 1.5));
    const offset = new Array(count).fill(0);
    const offsetDown = new Array(count).fill(0);
    series.forEach((s, si) => {
      s.values.forEach((raw, i) => {
        env.budget?.check();
        if (!Number.isFinite(raw)) return;
        let value = raw;
        if (percent) value = raw / (stackTop[i][0] - stackTop[i][1] || 1);
        const color = s.points.get(i) || s.color;
        let from = 0;
        if (stacked) {
          from = value >= 0 ? offset[i] : offsetDown[i];
          if (value >= 0) offset[i] += value;
          else offsetDown[i] += value;
        }
        const a = valueAt(clamp(from, axis.min, axis.max));
        const b = valueAt(clamp(from + value, axis.min, axis.max));
        const along = (horizontal ? top : left) + slot * i + (slot - thick * bars) / 2 + (stacked ? 0 : si * thick);
        if (horizontal) surface.rect(Math.min(a, b), along, Math.abs(b - a), thick, color);
        else surface.rect(along, Math.min(a, b), thick, Math.abs(b - a), color);
        if (labelsOn(s, groups[0])) {
          const text = formatNumber(raw, code);
          if (horizontal) put(text, Math.max(a, b) + base * 0.25, along + thick / 2 + base * 0.35, base * 0.9);
          else put(text, along + thick / 2, Math.min(a, b) - base * 0.3, base * 0.9, { align: 'center' });
        }
      });
    });
  } else {
    series.forEach((s) => {
      const xSpan = scatter ? Math.max(...s.xValues) - Math.min(...s.xValues) || 1 : 1;
      const xLow = scatter ? Math.min(...s.xValues) : 0;
      const pointAt = (i) => (scatter ? left + (((s.xValues[i] ?? 0) - xLow) / xSpan) * w : left + slot * (i + 0.5));
      const path = [];
      s.values.forEach((value, i) => {
        if (!Number.isFinite(value)) return;
        path.push([path.length ? 'L' : 'M', pointAt(i), valueAt(value)]);
      });
      if (!path.length) return;
      if (isArea) {
        const last = path[path.length - 1];
        surface.path([...path, ['L', last[1], zero], ['L', path[0][1], zero], ['Z']], { fill: css(String(s.color).replace('#', '').slice(0, 6), 0.75) });
      } else if (!scatter || s.stroke) {
        surface.path(path, { stroke: s.stroke?.color || s.color, width: s.stroke?.width || 2.25, join: 'round', cap: 'round' });
      }
      const marker = element(element(element(element(groups[0], 'ser'), 'marker'), 'symbol'), 'val');
      if (scatter || marker || s.values.length < 40) {
        for (const c of path) surface.path([['E', c[1], c[2], Math.max(1.5, base * 0.22), Math.max(1.5, base * 0.22), 0, Math.PI * 2], ['Z']], { fill: s.color });
      }
      if (labelsOn(s, groups[0])) {
        s.values.forEach((value, i) => {
          if (Number.isFinite(value)) put(formatNumber(value, code), pointAt(i), valueAt(value) - base * 0.5, base * 0.9, { align: 'center' });
        });
      }
    });
  }
  surface.line(horizontal ? zero : left, horizontal ? top : zero, horizontal ? zero : right, horizontal ? bottom : zero, ink === '#404040' ? '#A6A6A6' : ink, 0.75);
  return true;
}

const labelsOn = (series, group) => {
  const labels = series.labels || element(group, 'dLbls');
  return attr(element(labels, 'showVal'), 'val') === '1';
};

export { colorIn };
