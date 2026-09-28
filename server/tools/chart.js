/**
 * Charts drawn from data, in code.
 *
 * `show_widget` lets the model draw its own SVG, which is right for a diagram
 * nobody can anticipate — and wrong for a chart. A chart drawn by hand is only
 * as good as the model that turn: a free model produces crooked bars, axes that
 * do not line up and labels that overlap, and none of it is anybody's fault
 * because drawing to scale is not what a language model is for. Given the
 * numbers and the question, this draws the same chart every time, whichever
 * model asked.
 *
 * The palette, the mark sizes and the anatomy follow the house data-visualisation
 * rules rather than taste: hues assigned in fixed order and never cycled, a
 * legend whenever there is more than one series, values direct-labelled, grid and
 * axes recessive, and text in text colours rather than the series colour so
 * identity never rests on colour alone.
 */

/**
 * Categorical hues in fixed order, for a dark surface.
 *
 * Taken from the validated reference palette and re-checked with its validator
 * against the dark surface: all six pass the lightness band, chroma floor,
 * adjacent-pair CVD separation, normal-vision floor and 3:1 contrast. The worst
 * adjacent CVD pair sits at ΔE 8.4, which is legal only alongside a secondary
 * encoding — hence the direct value labels and the gaps between marks below.
 */
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

/** Ink, never a series colour. */
const TEXT = '#c3c2b7';
const TEXT_STRONG = '#ffffff';
const GRID = '#3a3a38';

const TYPES = ['bar', 'hbar', 'line', 'pie', 'stacked', 'scatter'];

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A number as the question asked for it. */
export function formatValue(value, format = 'number') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (format === 'percent') return `${Math.round(n * 10) / 10}%`;
  const grouped = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100);
  return format === 'currency' ? `$${grouped}` : grouped;
}

/** Nice round steps for an axis, so the grid lands on readable numbers. */
function axisTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  /*
   * Up to the first round number at or above the largest value — never short
   * of it. This stopped at the last step *below* the maximum, so a 1,750 bar on
   * a 500-step axis was scaled against 1,500 and drawn past the top of the
   * plot, through the title, with its own value label hidden behind it.
   */
  const ticks = [0];
  while (ticks[ticks.length - 1] < max - step * 0.001) {
    ticks.push(Math.round((ticks[ticks.length - 1] + step) * 1000) / 1000);
  }
  return ticks;
}

function validate({ type, data }) {
  if (!TYPES.includes(type)) {
    throw new Error(`"${type}" is not a chart this draws. Use one of: ${TYPES.join(', ')}.`);
  }
  if (type === 'scatter') return validateScatter(data);
  const labels = data?.labels;
  const series = data?.series;
  if (!Array.isArray(labels) || !labels.length) throw new Error('Give `data.labels` — one label per point.');
  if (!Array.isArray(series) || !series.length) {
    throw new Error('Give `data.series` — at least one { name, values }.');
  }
  for (const s of series) {
    if (!Array.isArray(s?.values) || s.values.length !== labels.length) {
      throw new Error(
        `Series "${s?.name ?? '?'}" has ${s?.values?.length ?? 0} values but there are ${labels.length} labels. They must match.`,
      );
    }
  }
}

/** The legend, present whenever more than one series shares the plot. */
function legend(series, x, y) {
  if (series.length < 2) return '';
  let out = `<g class="legend" transform="translate(${x},${y})">`;
  let cursor = 0;
  series.forEach((s, i) => {
    out +=
      `<g class="legend-item" data-s="${i}" transform="translate(${cursor},0)">` +
      `<rect width="9" height="9" rx="2" y="-8" fill="${PALETTE[i % PALETTE.length]}"/>` +
      `<text x="14" y="0" font-size="11" fill="${TEXT}">${esc(s.name)}</text></g>`;
    cursor += 22 + String(s.name ?? '').length * 6.2;
  });
  return `${out}</g>`;
}

/**
 * An invisible target over one label's column (or row), which the browser uses
 * to show that label's values on hover. Transparent rather than absent, so it
 * catches the pointer; drawn last, so it sits above the marks it describes.
 */
const hit = (i, x, y, w, h, shape = 'col') =>
  `<rect class="hit hit--${shape}" data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
  `width="${Math.max(1, w).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="transparent"/>`;

const frame = (w, h, title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(title)}">` +
  `<text x="0" y="14" font-size="13" font-weight="600" fill="${TEXT_STRONG}">${esc(title)}</text>` +
  `${body}</svg>`;

/* ── vertical bars, grouped ─────────────────────────────────────────── */
function barChart({ title, data, format }) {
  const W = 720;
  const H = 360;
  const top = 46;
  const left = 52;
  const bottom = H - 46;
  const plotW = W - left - 16;
  const plotH = bottom - top;

  const max = Math.max(...data.series.flatMap((s) => s.values.map(Number)), 0) || 1;
  const ticks = axisTicks(max);
  const scale = (v) => (Number(v) / (ticks[ticks.length - 1] || max)) * plotH;

  let body = legend(data.series, left, 32);

  // Grid and axis figures, recessive: they orient, they do not compete.
  for (const t of ticks) {
    const y = bottom - scale(t);
    body += `<line x1="${left}" y1="${y}" x2="${W - 16}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    body += `<text x="${left - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="${TEXT}">${esc(formatValue(t, format))}</text>`;
  }

  const groupW = plotW / data.labels.length;
  const gap = 2; // the surface gap that keeps adjacent fills apart
  const barW = Math.max(6, (groupW * 0.68) / data.series.length - gap);

  data.labels.forEach((label, i) => {
    const groupX = left + groupW * i + groupW * 0.16;
    data.series.forEach((s, j) => {
      const v = Number(s.values[i]) || 0;
      const h = Math.max(0, scale(v));
      const x = groupX + j * (barW + gap);
      const y = bottom - h;
      body +=
        `<rect class="bar" data-i="${i}" data-s="${j}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" ` +
        `rx="4" fill="${PALETTE[j % PALETTE.length]}"/>`;
      body += `<text data-s="${j}" x="${(x + barW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="10" text-anchor="middle" fill="${TEXT_STRONG}">${esc(formatValue(v, format))}</text>`;
    });
    body += `<text x="${(left + groupW * i + groupW / 2).toFixed(1)}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(label)}</text>`;
    body += hit(i, left + groupW * i, top, groupW, plotH);
  });

  return frame(W, H, title, body);
}

/* ── horizontal bars, for long labels ───────────────────────────────── */
function hbarChart({ title, data, format }) {
  const rows = data.labels.length * data.series.length;
  const rowH = 24;
  const W = 720;
  const top = 46;
  const H = top + rows * rowH + 30;
  const left = Math.min(220, Math.max(...data.labels.map((l) => String(l).length)) * 7 + 16);
  const plotW = W - left - 70;

  const max = Math.max(...data.series.flatMap((s) => s.values.map(Number)), 0) || 1;
  let body = legend(data.series, left, 32);

  let row = 0;
  data.labels.forEach((label, i) => {
    data.series.forEach((s, j) => {
      const v = Number(s.values[i]) || 0;
      const w = Math.max(0, (v / max) * plotW);
      const y = top + row * rowH;
      body += `<rect class="bar" data-i="${i}" data-s="${j}" x="${left}" y="${y}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="4" fill="${PALETTE[j % PALETTE.length]}"/>`;
      body += `<text data-s="${j}" x="${(left + w + 8).toFixed(1)}" y="${y + rowH - 13}" font-size="10" fill="${TEXT_STRONG}">${esc(formatValue(v, format))}</text>`;
      if (j === 0) {
        body += `<text x="${left - 8}" y="${y + rowH - 13}" font-size="11" text-anchor="end" fill="${TEXT}">${esc(label)}</text>`;
      }
      row += 1;
    });
    const first = top + (row - data.series.length) * rowH;
    body += hit(i, 0, first - 2, W, data.series.length * rowH, 'row');
  });

  return frame(W, H, title, body);
}

/* ── lines, for change over time ────────────────────────────────────── */
function lineChart({ title, data, format }) {
  const W = 720;
  const H = 360;
  const top = 46;
  const left = 52;
  const bottom = H - 46;
  const plotW = W - left - 16;
  const plotH = bottom - top;

  const max = Math.max(...data.series.flatMap((s) => s.values.map(Number)), 0) || 1;
  const ticks = axisTicks(max);
  const topTick = ticks[ticks.length - 1] || max;
  const x = (i) => left + (data.labels.length === 1 ? plotW / 2 : (plotW * i) / (data.labels.length - 1));
  const y = (v) => bottom - (Number(v) / topTick) * plotH;

  let body = legend(data.series, left, 32);
  for (const t of ticks) {
    body += `<line x1="${left}" y1="${y(t)}" x2="${W - 16}" y2="${y(t)}" stroke="${GRID}" stroke-width="1"/>`;
    body += `<text x="${left - 8}" y="${y(t) + 4}" font-size="10" text-anchor="end" fill="${TEXT}">${esc(formatValue(t, format))}</text>`;
  }

  data.series.forEach((s, j) => {
    const colour = PALETTE[j % PALETTE.length];
    const points = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    body += `<polyline data-s="${j}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${points}"/>`;
    // Markers carry a surface ring so overlapping series stay separable.
    s.values.forEach((v, i) => {
      body += `<circle class="dot" data-i="${i}" data-s="${j}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${colour}" stroke="#1a1a19" stroke-width="2"/>`;
    });
    // Direct-label the end of each line rather than every point.
    const lastI = s.values.length - 1;
    body += `<text data-s="${j}" x="${(x(lastI) - 4).toFixed(1)}" y="${(y(s.values[lastI]) - 10).toFixed(1)}" font-size="10" text-anchor="end" fill="${TEXT_STRONG}">${esc(formatValue(s.values[lastI], format))}</text>`;
  });

  // A column per point, so hovering anywhere above a label reads that label —
  // aiming at a 4px dot is not a thing to ask of anybody.
  const step = data.labels.length > 1 ? plotW / (data.labels.length - 1) : plotW;
  data.labels.forEach((label, i) => {
    body += `<text x="${x(i).toFixed(1)}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(label)}</text>`;
    body += hit(i, x(i) - step / 2, top, step, plotH);
  });

  return frame(W, H, title, body);
}

/* ── donut, for shares of a whole ───────────────────────────────────── */
function pieChart({ title, data, format }) {
  const W = 720;
  const H = 340;
  const cx = 190;
  const cy = 180;
  const rOuter = 110;
  const rInner = 66;
  const values = data.series[0].values.map((v) => Math.max(0, Number(v) || 0));
  const total = values.reduce((a, b) => a + b, 0) || 1;

  let body = '';
  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    body +=
      `<path d="M ${p(rOuter, angle)} A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, end)} ` +
      `L ${p(rInner, end)} A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, angle)} Z" ` +
      `fill="${PALETTE[i % PALETTE.length]}" stroke="#1a1a19" stroke-width="2" class="slice hit" data-i="${i}"/>`;
    angle = end;
  });

  // The total in the middle: a donut's hole is the one place a headline fits.
  body += `<text x="${cx}" y="${cy - 2}" font-size="22" font-weight="600" text-anchor="middle" fill="${TEXT_STRONG}">${esc(formatValue(total, format))}</text>`;
  body += `<text x="${cx}" y="${cy + 18}" font-size="11" text-anchor="middle" fill="${TEXT}">Tổng</text>`;

  // A keyed list beside it, so identity never rests on colour alone.
  data.labels.forEach((label, i) => {
    const y = 60 + i * 24;
    const share = ((values[i] / total) * 100).toFixed(1);
    body += `<rect x="360" y="${y - 9}" width="10" height="10" rx="2" fill="${PALETTE[i % PALETTE.length]}"/>`;
    body += `<text x="378" y="${y}" font-size="12" fill="${TEXT}">${esc(label)}</text>`;
    body += `<text x="700" y="${y}" font-size="12" text-anchor="end" fill="${TEXT_STRONG}">${esc(formatValue(values[i], format))} · ${share}%</text>`;
  });

  return frame(W, H, title, body);
}

/* ── stacked bars, for parts of a total ─────────────────────────────── */
function stackedChart({ title, data, format }) {
  const W = 720;
  const H = 360;
  const top = 46;
  const left = 52;
  const bottom = H - 46;
  const plotW = W - left - 16;
  const plotH = bottom - top;

  const totals = data.labels.map((_, i) => data.series.reduce((sum, s) => sum + (Number(s.values[i]) || 0), 0));
  const max = Math.max(...totals, 0) || 1;
  const ticks = axisTicks(max);
  const topTick = ticks[ticks.length - 1] || max;

  let body = legend(data.series, left, 32);
  for (const t of ticks) {
    const y = bottom - (t / topTick) * plotH;
    body += `<line x1="${left}" y1="${y}" x2="${W - 16}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    body += `<text x="${left - 8}" y="${y + 4}" font-size="10" text-anchor="end" fill="${TEXT}">${esc(formatValue(t, format))}</text>`;
  }

  const groupW = plotW / data.labels.length;
  const barW = Math.min(56, groupW * 0.6);
  data.labels.forEach((label, i) => {
    const x = left + groupW * i + (groupW - barW) / 2;
    let cursor = bottom;
    data.series.forEach((s, j) => {
      const v = Number(s.values[i]) || 0;
      const h = (v / topTick) * plotH;
      if (h <= 0) return;
      // 2px gap between segments, so stacked fills stay separable.
      cursor -= h;
      body += `<rect class="bar" data-i="${i}" data-s="${j}" x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h - 2).toFixed(1)}" rx="3" fill="${PALETTE[j % PALETTE.length]}"/>`;
    });
    body += `<text x="${(x + barW / 2).toFixed(1)}" y="${(cursor - 6).toFixed(1)}" font-size="10" text-anchor="middle" fill="${TEXT_STRONG}">${esc(formatValue(totals[i], format))}</text>`;
    body += `<text x="${(x + barW / 2).toFixed(1)}" y="${bottom + 16}" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(label)}</text>`;
    body += hit(i, left + groupW * i, top, groupW, plotH);
  });

  return frame(W, H, title, body);
}

/* ── scatter, for how two measures relate ───────────────────────────── */

/** One point as [x, y] or { x, y, label } — the two shapes a model reaches for. */
function pointOf(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]), label: p[2] == null ? '' : String(p[2]) };
  return { x: Number(p?.x), y: Number(p?.y), label: p?.label == null ? '' : String(p.label) };
}

const MAX_POINTS = 2000;

function validateScatter(data) {
  const series = data?.series;
  if (!Array.isArray(series) || !series.length) {
    throw new Error('Give `data.series` — at least one { name, points: [[x, y], …] }.');
  }
  let total = 0;
  for (const s of series) {
    if (!Array.isArray(s?.points) || !s.points.length) {
      throw new Error(`Series "${s?.name ?? '?'}" needs \`points\`: a list of [x, y] pairs.`);
    }
    for (const p of s.points) {
      const { x, y } = pointOf(p);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Series "${s?.name ?? '?'}" has a point that is not two numbers: ${JSON.stringify(p)}.`);
      }
    }
    total += s.points.length;
  }
  if (total > MAX_POINTS) throw new Error(`That is ${total} points; a scatter chart draws up to ${MAX_POINTS}.`);
}

/**
 * Round steps covering [min, max], negative values included — a scatter axis
 * cannot assume zero is the floor the way a bar axis does.
 */
function rangeTicks(min, max, count = 5) {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function scatterChart({ title, data, format, xLabel = '', yLabel = '' }) {
  const W = 720;
  const H = 380;
  const top = 46;
  const left = 60;
  const bottom = H - 52;
  const plotW = W - left - 20;
  const plotH = bottom - top;

  const all = data.series.flatMap((s) => s.points.map(pointOf));
  const xt = rangeTicks(Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x)));
  const yt = rangeTicks(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)));
  const [x0, x1] = [xt[0], xt[xt.length - 1]];
  const [y0, y1] = [yt[0], yt[yt.length - 1]];
  const sx = (v) => left + ((v - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (v) => bottom - ((v - y0) / (y1 - y0 || 1)) * plotH;

  let body = legend(data.series, left, 32);
  for (const t of yt) {
    body += `<line x1="${left}" y1="${sy(t).toFixed(1)}" x2="${W - 20}" y2="${sy(t).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    body += `<text x="${left - 8}" y="${(sy(t) + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="${TEXT}">${esc(formatValue(t, format))}</text>`;
  }
  for (const t of xt) {
    body += `<line x1="${sx(t).toFixed(1)}" y1="${top}" x2="${sx(t).toFixed(1)}" y2="${bottom}" stroke="${GRID}" stroke-width="1"/>`;
    body += `<text x="${sx(t).toFixed(1)}" y="${bottom + 16}" font-size="10" text-anchor="middle" fill="${TEXT}">${esc(formatValue(t))}</text>`;
  }
  if (xLabel) body += `<text x="${left + plotW / 2}" y="${H - 10}" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(xLabel)}</text>`;
  if (yLabel) {
    body += `<text x="0" y="0" transform="translate(14,${top + plotH / 2}) rotate(-90)" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(yLabel)}</text>`;
  }

  // Marks, then the targets above them: a larger invisible circle per point,
  // because a 4px dot is not something to ask anybody to aim at.
  let i = 0;
  let hits = '';
  data.series.forEach((s, j) => {
    const colour = PALETTE[j % PALETTE.length];
    for (const raw of s.points) {
      const p = pointOf(raw);
      const cx = sx(p.x).toFixed(1);
      const cy = sy(p.y).toFixed(1);
      body += `<circle class="dot" data-i="${i}" data-s="${j}" cx="${cx}" cy="${cy}" r="4.5" fill="${colour}" stroke="#1a1a19" stroke-width="1.5"/>`;
      hits += `<circle class="hit hit--pt" data-i="${i}" cx="${cx}" cy="${cy}" r="10" fill="transparent"/>`;
      i += 1;
    }
  });

  return frame(W, H, title, body + hits);
}

/**
 * What the browser reads a scatter chart's hover from, in the same
 * labels/series shape as every other chart: one label per point, and the
 * x and y values as the two "series". `groups` and `group` say which real
 * series each point belongs to, for the legend and the swatch colour.
 */
export function scatterSpec({ data, format, xLabel, yLabel }) {
  const labels = [];
  const xs = [];
  const ys = [];
  const group = [];
  data.series.forEach((s, j) => {
    s.points.map(pointOf).forEach((p, k) => {
      labels.push(p.label || (data.series.length > 1 ? `${s.name} #${k + 1}` : `#${k + 1}`));
      xs.push(p.x);
      ys.push(p.y);
      group.push(j);
    });
  });
  return {
    type: 'scatter',
    format: format || 'number',
    labels,
    series: [
      { name: xLabel || 'x', values: xs },
      { name: yLabel || 'y', values: ys },
    ],
    groups: data.series.map((s) => String(s.name ?? '')),
    group,
  };
}

const BUILDERS = { bar: barChart, hbar: hbarChart, line: lineChart, pie: pieChart, stacked: stackedChart, scatter: scatterChart };

/**
 * @param type   bar | hbar | line | pie | stacked | scatter
 * @param data   { labels: string[], series: [{ name, values: number[] }] };
 *               for scatter, series of { name, points } where each point is [x, y]
 * @param format number | percent | currency
 * @returns a complete `<svg>` string
 */
export function renderChart({ type, title, data, format = 'number', xLabel = '', yLabel = '' }) {
  validate({ type, data });
  return BUILDERS[type]({ title: title || '', data, format, xLabel, yLabel });
}

/** Exposed for the suite that pins the arithmetic and the palette. */
export const __testing = { formatValue, PALETTE, axisTicks, rangeTicks };
