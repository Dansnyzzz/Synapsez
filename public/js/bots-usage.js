import { api } from './api.js';
import { t, localeTag } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { faceHtml, paintFaces, inkOf } from './bot-avatar.js';

/**
 * Bot settings → Usage (owner, 2026-11-09): what the bots spent, by time, by bot and
 * by model — the layout of DS Bot's usage page (NOTICE), drawn here from this app's
 * own ledger (`usage_events.bot_id`, server/routes/bots.js).
 *
 * Ranges are cut in the person's own zone: the browser works out where each range
 * starts and ends, the server buckets in the same zone, and the keys meet as
 * `YYYY-MM-DDTHH:00` local wall-clock time. Only the bots' spend is here; the whole
 * account's is Settings → Usage.
 */

/** Ranges as DS Bot offers them, and the step each is drawn in. */
export const RANGES = Object.freeze([
  { id: '24h', unit: 'hour', count: 24 },
  { id: '7d', unit: 'day', count: 7 },
  { id: '30d', unit: 'day', count: 30 },
  { id: '12w', unit: 'week', count: 12 },
  { id: '12m', unit: 'month', count: 12 },
]);

const MODEL_INKS = ['#8f86ff', '#f2a20c', '#35d07f', '#4cb8e8', '#ff8fb8', '#cfc24e', '#2fb3c4', '#ef4a36', '#cc8640', '#9fb3cc'];
const TOP = 6;

/** 69.0K, 1.2M: a token count in a few characters, in the person's language. @param {number} n */
export function compactCount(n) {
  try {
    return new Intl.NumberFormat(localeTag(), { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  } catch {
    return String(n || 0);
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** A local instant as the server's bucket key. @param {Date} d */
export const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;

/** The start of the bucket a local date falls in. */
function floor(d, unit) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  if (unit === 'hour') return x;
  x.setHours(0);
  if (unit === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  if (unit === 'month') x.setDate(1);
  return x;
}
function step(d, unit, by = 1) {
  const x = new Date(d);
  if (unit === 'hour') x.setHours(x.getHours() + by);
  else if (unit === 'day') x.setDate(x.getDate() + by);
  else if (unit === 'week') x.setDate(x.getDate() + 7 * by);
  else x.setMonth(x.getMonth() + by);
  return x;
}

/**
 * A range's buckets, oldest first, and the instants it runs between.
 *
 * @param {{ id: string, from?: string, to?: string }} choice  a preset id, or 'custom' with two `YYYY-MM-DD` days
 * @param {Date} [now]
 */
export function rangeOf(choice, now = new Date()) {
  let unit;
  let start;
  let count;
  if (choice.id === 'custom' && choice.from && choice.to) {
    const a = new Date(`${choice.from}T00:00`);
    const b = new Date(`${choice.to}T00:00`);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const days = Math.round((hi.getTime() - lo.getTime()) / 86_400_000) + 1;
    unit = days <= 2 ? 'hour' : 'day';
    start = lo;
    count = unit === 'hour' ? days * 24 : days;
  } else {
    const preset = RANGES.find((r) => r.id === choice.id) || RANGES[1];
    unit = preset.unit;
    count = preset.count;
    start = step(floor(now, unit), unit, -(count - 1));
  }
  const buckets = Array.from({ length: count }, (_, i) => step(start, unit, i));
  return { unit, buckets, from: buckets[0], to: step(buckets.at(-1), unit, 1) };
}

/** A bucket's label on the axis. */
function tick(d, unit) {
  if (unit === 'hour') return d.toLocaleTimeString(localeTag(), { hour: 'numeric' });
  if (unit === 'month') return d.toLocaleDateString(localeTag(), { month: 'short' });
  return d.toLocaleDateString(localeTag(), { month: 'numeric', day: 'numeric' });
}

/**
 * Sum the rows into what the page draws.
 *
 * @param {{ bucket: string, bot: string, model: string, input: number, output: number, cacheRead: number, calls: number }[]} rows
 * @param {Date[]} buckets @param {'bot' | 'model'} by
 */
export function summarise(rows, buckets, by) {
  const keys = buckets.map(keyOf);
  const totals = { tokens: 0, input: 0, output: 0, cacheRead: 0, calls: 0 };
  const perBot = new Map();
  const perModel = new Map();
  const cells = new Map();
  for (const r of rows) {
    const tokens = r.input + r.output;
    totals.tokens += tokens;
    totals.input += r.input;
    totals.output += r.output;
    totals.cacheRead += r.cacheRead;
    totals.calls += r.calls;
    perBot.set(r.bot, (perBot.get(r.bot) || 0) + tokens);
    perModel.set(r.model, (perModel.get(r.model) || 0) + tokens);
    const series = by === 'bot' ? r.bot : r.model;
    const cell = `${r.bucket}|${series}`;
    cells.set(cell, (cells.get(cell) || 0) + tokens);
  }
  const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const all = ranked(by === 'bot' ? perBot : perModel).map(([id]) => id);
  const series = all.slice(0, TOP);
  const rest = all.slice(TOP);
  const bars = keys.map((key) => {
    const parts = series.map((id) => cells.get(`${key}|${id}`) || 0);
    const other = rest.reduce((s, id) => s + (cells.get(`${key}|${id}`) || 0), 0);
    return { key, parts, other, total: parts.reduce((s, n) => s + n, 0) + other };
  });
  return { totals, bots: ranked(perBot), models: ranked(perModel), series, hasOther: rest.length > 0, bars };
}

/** A round top for the axis: 1, 2 or 5 times a power of ten. */
const niceMax = (n) => {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= n) || 10 * p;
};

/**
 * Draw the page into `host`.
 *
 * @param {HTMLElement} host @param {{ team: any }} deps
 */
export function mountUsage(host, { team }) {
  let choice = { id: '7d', from: '', to: '' };
  let by = /** @type {'bot' | 'model'} */ ('bot');
  let turn = 0;
  const botOf = (id) => team?.bots.find((b) => b.id === id) || null;
  const inkFor = (id, i) => (by === 'bot' ? inkOf(botOf(id)) : MODEL_INKS[i % MODEL_INKS.length]);
  const rangeName = (id) => t(`bots.u.r.${id}`);

  host.innerHTML = `<div class="usage__seg botuse__ranges" role="tablist" aria-label="${escapeHtml(t('bots.u.range'))}">
      ${[...RANGES.map((r) => r.id), 'custom'].map((id) => `<button type="button" role="tab" data-range="${id}" aria-selected="${id === choice.id}" tabindex="${id === choice.id ? 0 : -1}">${escapeHtml(rangeName(id))}</button>`).join('')}
    </div>
    <form class="botuse__custom" data-custom hidden>
      <label>${escapeHtml(t('bots.u.from'))} <input type="date" data-from required /></label>
      <label>${escapeHtml(t('bots.u.to'))} <input type="date" data-to required /></label>
      <button class="btn btn--small" type="submit">${escapeHtml(t('bots.u.apply'))}</button>
    </form>
    <div data-view><p class="hint">…</p></div>
    <p class="hint botuse__note">${escapeHtml(t('bots.u.note'))}</p>`;
  const view = /** @type {HTMLElement} */ (host.querySelector('[data-view]'));

  async function draw() {
    const me = ++turn;
    const range = rangeOf(choice);
    let rows = [];
    try {
      rows = (await api.botUsage({ from: range.from.toISOString(), to: range.to.toISOString(), unit: range.unit })).rows || [];
    } catch (err) {
      view.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
      return;
    }
    if (me !== turn) return;
    const s = summarise(rows, range.buckets, by);
    const rate = s.totals.input ? Math.round((s.totals.cacheRead / s.totals.input) * 100) : 0;
    const last = choice.id === 'custom' ? `${choice.from} – ${choice.to}` : t('bots.u.last', { range: rangeName(choice.id) });
    const max = niceMax(Math.max(...s.bars.map((b) => b.total), 0));
    const W = 640;
    const H = 200;
    const left = 44;
    const bw = (W - left) / s.bars.length;
    const strideEvery = Math.max(1, Math.ceil(s.bars.length / 8));
    const y = (v) => H - 20 - (v / max) * (H - 30);
    const bars = s.bars
      .map((bar, i) => {
        let top = H - 20;
        const x = left + i * bw + bw * 0.18;
        const w = Math.max(2, bw * 0.64);
        const rects = [...bar.parts.map((v, j) => [v, inkFor(s.series[j], j)]), [bar.other, 'var(--text-faint)']]
          .filter(([v]) => v > 0)
          .map(([v, color]) => {
            const h = Math.max(1, (v / max) * (H - 30));
            top -= h;
            return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}"></rect>`;
          })
          .join('');
        const label = i % strideEvery === 0 ? `<text x="${(x + w / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${escapeHtml(tick(range.buckets[i], range.unit))}</text>` : '';
        return `<g><title>${escapeHtml(`${tick(range.buckets[i], range.unit)}: ${compactCount(bar.total)}`)}</title>${rects}</g>${label}`;
      })
      .join('');
    const grid = [0, max / 2, max].map((v) => `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}"></line><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${escapeHtml(compactCount(v))}</text>`).join('');
    const legend = s.series
      .map((id, j) => `<li><span class="botuse__swatch" style="background:${inkFor(id, j)}"></span>${escapeHtml(by === 'bot' ? botOf(id)?.name || t('bots.deletedBot') : id)}</li>`)
      .join('');
    const share = (n) => (s.totals.tokens ? Math.round((n / s.totals.tokens) * 100) : 0);
    const botRows = s.bots
      .map(([id, n]) => {
        const b = botOf(id);
        return `<li class="botuse__row">${faceHtml(b || '', 28)}<span class="botuse__label"><span>${escapeHtml(b?.name || t('bots.deletedBot'))}</span>${b?.role ? `<span class="botuse__sub">${escapeHtml(b.role)}</span>` : ''}<span class="botuse__bar"><span style="width:${share(n)}%;background:${inkOf(b?.avatar)}"></span></span></span><span class="botuse__num">${escapeHtml(compactCount(n))}<span class="botuse__sub">${share(n)}%</span></span></li>`;
      })
      .join('');
    const modelRows = s.models
      .map(([id, n], j) => `<li class="botuse__row"><span class="botuse__mark" aria-hidden="true">${escapeHtml(String(id).split('/').pop()?.[0]?.toUpperCase() || '?')}</span><span class="botuse__label"><span>${escapeHtml(String(id).split('/').pop() || id)}</span><span class="botuse__sub">${escapeHtml(String(id).split('/')[0])}</span><span class="botuse__bar"><span style="width:${share(n)}%;background:${MODEL_INKS[j % MODEL_INKS.length]}"></span></span></span><span class="botuse__num">${escapeHtml(compactCount(n))}<span class="botuse__sub">${share(n)}%</span></span></li>`)
      .join('');
    view.innerHTML = `<div class="botuse__tiles">
        <div class="botuse__tile botuse__tile--big"><span class="botuse__k">${escapeHtml(last)}</span><span class="botuse__v">${escapeHtml(compactCount(s.totals.tokens))}<span class="botuse__unit">${escapeHtml(t('bots.u.tokens'))}</span></span></div>
        <div class="botuse__tile"><span class="botuse__k">${escapeHtml(t('bots.u.cache'))}</span><span class="botuse__v">${rate}%</span></div>
        <div class="botuse__tile"><span class="botuse__k">${escapeHtml(t('bots.u.output'))}</span><span class="botuse__v">${escapeHtml(compactCount(s.totals.output))}</span></div>
        <div class="botuse__tile"><span class="botuse__k">${escapeHtml(t('bots.u.calls'))}</span><span class="botuse__v">${escapeHtml(String(s.totals.calls))}</span></div>
      </div>
      <section class="botuse__card">
        <header class="botuse__cardhead"><h3>${escapeHtml(t('bots.u.over'))} <span class="botuse__sub">${escapeHtml(t(`bots.u.per.${range.unit}`))}</span></h3>
          <div class="usage__seg" role="tablist" aria-label="${escapeHtml(t('bots.u.over'))}">
            <button type="button" role="tab" data-by="bot" aria-selected="${by === 'bot'}" tabindex="${by === 'bot' ? 0 : -1}">${escapeHtml(t('bots.u.byBot'))}</button>
            <button type="button" role="tab" data-by="model" aria-selected="${by === 'model'}" tabindex="${by === 'model' ? 0 : -1}">${escapeHtml(t('bots.u.byModel'))}</button>
          </div></header>
        <svg class="botuse__chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(`${t('bots.u.over')}, ${t(`bots.u.per.${range.unit}`)}: ${compactCount(s.totals.tokens)} ${t('bots.u.tokens')}`)}">
          <g class="botuse__grid">${grid}</g><g class="botuse__ticks">${bars}</g></svg>
        ${legend ? `<ul class="botuse__legend">${legend}</ul>` : ''}
      </section>
      ${s.totals.tokens ? '' : `<p class="hint">${escapeHtml(t('bots.u.none'))}</p>`}
      <div class="botuse__lists">
        <section class="botuse__card"><h3>${escapeHtml(t('bots.u.bots'))} <span class="botuse__sub">${s.bots.length}</span></h3><ul class="botuse__rows">${botRows}</ul></section>
        <section class="botuse__card"><h3>${escapeHtml(t('bots.u.models'))} <span class="botuse__sub">${s.models.length}</span></h3><ul class="botuse__rows">${modelRows}</ul></section>
      </div>`;
    paintFaces(view);
  }

  host.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const range = /** @type {HTMLElement | null} */ (target.closest('[data-range]'));
    if (range) {
      for (const b of host.querySelectorAll('[data-range]')) {
        b.setAttribute('aria-selected', String(b === range));
        b.setAttribute('tabindex', b === range ? '0' : '-1');
      }
      const custom = /** @type {HTMLElement} */ (host.querySelector('[data-custom]'));
      if (range.dataset.range === 'custom') {
        custom.hidden = false;
        /** @type {HTMLInputElement} */ (custom.querySelector('[data-from]')).focus();
        return;
      }
      custom.hidden = true;
      choice = { id: String(range.dataset.range), from: '', to: '' };
      draw();
      return;
    }
    const pick = /** @type {HTMLElement | null} */ (target.closest('[data-by]'));
    if (pick) {
      by = pick.dataset.by === 'model' ? 'model' : 'bot';
      draw().then(() => /** @type {HTMLElement | null} */ (host.querySelector(`[data-by="${by}"]`))?.focus());
    }
  });
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    const from = /** @type {HTMLInputElement} */ (host.querySelector('[data-from]')).value;
    const to = /** @type {HTMLInputElement} */ (host.querySelector('[data-to]')).value;
    if (!from || !to) return;
    choice = { id: 'custom', from, to };
    draw();
  });
  draw();
}
