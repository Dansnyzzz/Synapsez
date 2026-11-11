/**
 * A Word, Excel or PowerPoint file as it looks, for a model that can see.
 *
 * The readers next door hand a model the words. They say nothing about a cover,
 * a banded table, a picture that fell off the page or a slide whose title is
 * white on white, and the owner wants those seen too: "nguyên bản, high quality".
 * A deployment has no LibreOffice, no Chrome and no system fonts, so the files
 * are drawn here, in plain JavaScript, on `@napi-rs/canvas` (draw/).
 *
 * This file holds the three things the rest of the app touches:
 *
 *   `lookableFormat`  whether a file can be drawn at all
 *   `sheetPlan`       which pages share a picture: pure, so it is tested without drawing
 *   `lookAtFile`      the drawing itself, on a worker with a deadline and a heap of its own
 *
 * Pages share pictures because the owner asked for it ("merge pages where it loses
 * nothing, to waste as little as possible") and because a picture costs the model
 * the same whatever is on it. What limits the merging is whether a page can still
 * be read: the app keeps each picture through `viewCopy` (util/picture.js), which
 * caps it at 1600 px, and that stored copy is what the model sees. So the plan
 * reasons in that size, and in how many pixels the page's body text comes to.
 *
 * Nothing heavy is imported at the top: this module is on the path of every cold
 * start, and most never look at anything.
 */
import { Worker } from 'node:worker_threads';
import { looksLikeZip, openZip } from './zip.js';

/* ── which format ───────────────────────────────────────────────────── */

const BY_EXTENSION = new Map([
  ['docx', 'docx'], ['docm', 'docx'], ['dotx', 'docx'], ['dotm', 'docx'],
  ['xlsx', 'xlsx'], ['xlsm', 'xlsx'], ['xltx', 'xlsx'], ['xltm', 'xlsx'],
  ['pptx', 'pptx'], ['pptm', 'pptx'], ['ppsx', 'pptx'], ['ppsm', 'pptx'], ['potx', 'pptx'], ['potm', 'pptx'],
]);

/**
 * The content types of each format's main part, macro-enabled and template variants too.
 * @type {[RegExp, string][]}
 */
const MAIN_PART = [
  [/wordprocessingml\.(document|template)\.main|ms-word\.(document|template)\./i, 'docx'],
  [/spreadsheetml\.(sheet|template)\.main|ms-excel\.(sheet|template)\.macro/i, 'xlsx'],
  [/presentationml\.(presentation|slideshow|template)\.main|ms-powerpoint\.(presentation|slideshow|template)\.macro/i, 'pptx'],
];

/** The content types part is a short list; anything larger is not one worth reading. */
const CONTENT_TYPES_BYTES = 1024 * 1024;

/**
 * Which of the three a file is, or null.
 *
 * By extension when the name has one of ours. Otherwise, when the bytes are given,
 * by the package's own `[Content_Types].xml`: a file that arrived with no useful
 * name still says what it is. Never throws: a file that cannot be sniffed is simply
 * not one that can be drawn.
 *
 * @param {string} name
 * @param {Buffer|Uint8Array} [bytes]
 * @returns {'docx'|'xlsx'|'pptx'|null}
 */
export function lookableFormat(name, bytes) {
  const extension = String(name || '').split('.').pop().toLowerCase();
  const known = BY_EXTENSION.get(extension);
  if (known) return /** @type {'docx'|'xlsx'|'pptx'} */ (known);
  if (!bytes?.length) return null;
  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!looksLikeZip(buffer)) return null;
    const types = openZip(buffer).text('[Content_Types].xml', CONTENT_TYPES_BYTES);
    for (const [pattern, format] of MAIN_PART) if (pattern.test(types)) return /** @type {'docx'|'xlsx'|'pptx'} */ (format);
  } catch {
    /* not a package, or one that will not open: not lookable */
  }
  return null;
}

/* ── which pages share a picture ────────────────────────────────────── */

/** The long side of a picture: what `viewCopy` keeps, and so what the model sees. */
export const SHEET_EDGE = 1600;
const STRIP = 34;
const GAP = 12;
const CAPTION = 20;

/**
 * Pixels the body text must come to, in the picture the model gets. Below about
 * nine, small print turns into guesses; a page with neighbours is held to more,
 * because it gets less of the model's attention and a table inside it less still.
 */
const LEGIBLE = { six: 11, grid: 9.5, pair: 11.5, three: 10, alone: 0 };

/** How large a drawing may be blown up, in pixels per point: past this, a small page only gets blurrier. */
const MAX_SCALE = { page: 2.6, slide: 2.2, sheet: 1.6 };
/** A worksheet at its natural size on screen: 96 dpi. It is stacked with others only at this. */
const SCREEN_SCALE = 96 / 72;

/**
 * @typedef {{
 *   n: number, unit?: 'page'|'slide'|'sheet', part?: number,
 *   width: number, height: number,
 *   ink?: number, bodyPt?: number, chars?: number, tableCells?: number, hasPicture?: boolean,
 *   blank?: boolean, duplicateOf?: number|null,
 * }} PlanItem
 *   `width` and `height` in points. `bodyPt` is the smallest size a real share of its text
 *   is set in, `ink` the part of it (0–1) that is not ground, `part` which piece of a
 *   worksheet this is when one had to be split.
 *
 * @typedef {{ item: number, n: number, part: number, x: number, y: number, width: number, height: number, scale: number }} PlanCell
 * @typedef {{ pages: number[], cols: number, rows: number, width: number, height: number, cells: PlanCell[] }} PlannedSheet
 */

/** The biggest a page can be drawn in `cols` by `rows`, in pixels per point. */
function gridScale(item, cols, rows, limit) {
  const captions = cols * rows > 1 ? CAPTION : 0;
  const cellW = (SHEET_EDGE - GAP * (cols + 1)) / cols;
  const cellH = (SHEET_EDGE - STRIP - GAP * (rows + 1) - captions * rows) / rows;
  return Math.min(limit, cellW / item.width, cellH / item.height);
}

/** The arrangements `count` pages can have: the plan keeps whichever draws them largest. */
const ARRANGEMENTS = {
  1: [[1, 1]],
  2: [[2, 1], [1, 2]],
  3: [[3, 1], [1, 3], [2, 2]],
  4: [[2, 2]],
  5: [[2, 3]],
  6: [[2, 3]],
};

/** @param {PlanItem[]} group @param {'page'|'slide'|'sheet'} unit */
function bestGrid(group, unit) {
  const limit = MAX_SCALE[unit];
  let best = null;
  for (const [cols, rows] of ARRANGEMENTS[group.length] || []) {
    const scale = Math.min(...group.map((item) => gridScale(item, cols, rows, limit)));
    if (!best || scale > best.scale) best = { cols, rows, scale };
  }
  return best;
}

/** Text so small, or a table so detailed, that a slide wants fewer neighbours. */
function slideFits(group, scale) {
  const count = group.length;
  return group.every((item) => {
    const body = (item.bodyPt || 99) * scale;
    const cells = item.tableCells || 0;
    if (count > 4) return body >= LEGIBLE.six && cells <= 24;
    if (count > 2) return body >= LEGIBLE.grid && cells <= 60;
    if (count === 2) return body >= LEGIBLE.pair && cells <= 120;
    return true;
  });
}

/** Whether a document page holds so little that a third of the picture is plenty. */
const sparsePage = (item) => (item.chars || 0) < 600 && !(item.tableCells || 0) && (item.ink ?? 0) < 0.12;

/** A dense page with small text or a detailed table goes alone; the normal case is a pair. */
function pageFits(group, scale) {
  const count = group.length;
  return group.every((item) => {
    const body = (item.bodyPt || 99) * scale;
    const cells = item.tableCells || 0;
    if (count === 1) return true;
    if (count === 3) return sparsePage(item) && (body >= LEGIBLE.three || (item.chars || 0) < 150);
    return body >= LEGIBLE.pair && cells <= 80;
  });
}

/** Lay one group out, as the rectangles the drawing fills. */
function placeGrid(group, unit, indexes) {
  const grid = bestGrid(group, unit);
  const { cols, rows, scale } = grid;
  const many = group.length > 1;
  const cellW = Math.max(...group.map((item) => item.width * scale));
  const cellH = Math.max(...group.map((item) => item.height * scale));
  const cells = group.map((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const width = Math.round(item.width * scale);
    const height = Math.round(item.height * scale);
    return {
      item: indexes[i],
      n: item.n,
      part: item.part || 0,
      // Centred in its cell, so a shorter page beside a taller one still reads as a pair.
      x: Math.round(GAP + col * (cellW + GAP) + (cellW - width) / 2),
      y: Math.round(STRIP + GAP + row * (cellH + GAP + (many ? CAPTION : 0)) + (many ? CAPTION : 0) + (cellH - height) / 2),
      width,
      height,
      scale,
    };
  });
  return finishSheet(cells, cols, rows);
}

/** Pieces of worksheets, one under the other at their natural size. */
function placeStack(group, indexes) {
  const scale = SCREEN_SCALE;
  let y = STRIP + GAP;
  const many = group.length > 1;
  const cells = group.map((item, i) => {
    const width = Math.round(item.width * scale);
    const height = Math.round(item.height * scale);
    y += many ? CAPTION : 0;
    const cell = { item: indexes[i], n: item.n, part: item.part || 0, x: GAP, y, width, height, scale };
    y += height + GAP;
    return cell;
  });
  return finishSheet(cells, 1, group.length);
}

/** @returns {PlannedSheet} */
function finishSheet(cells, cols, rows) {
  const width = Math.min(SHEET_EDGE, Math.max(...cells.map((c) => c.x + c.width)) + GAP);
  const height = Math.min(SHEET_EDGE, Math.max(...cells.map((c) => c.y + c.height)) + GAP);
  return { pages: [...new Set(cells.map((c) => c.n))], cols, rows, width, height, cells };
}

/** Whether pieces of worksheets can share a picture at the size they have on screen. */
function stackFits(group) {
  const room = SHEET_EDGE - STRIP - GAP - (group.length > 1 ? CAPTION * group.length : 0) - GAP * group.length;
  const tall = group.reduce((sum, item) => sum + item.height * SCREEN_SCALE, 0);
  const wide = Math.max(...group.map((item) => item.width * SCREEN_SCALE));
  return tall <= room && wide <= SHEET_EDGE - GAP * 2;
}

/** Walk the pages in order, taking as many at a time as stay legible. */
function groupPages(list, unit, indexes) {
  const sheets = [];
  const largest = unit === 'slide' ? 6 : unit === 'page' ? 3 : 8;
  for (let i = 0; i < list.length; ) {
    let taken = 0;
    for (let count = Math.min(largest, list.length - i); count >= 1; count -= 1) {
      const group = list.slice(i, i + count);
      const at = indexes.slice(i, i + count);
      if (unit === 'sheet') {
        if (count > 1 && !stackFits(group)) continue;
        sheets.push(count > 1 ? placeStack(group, at) : placeGrid(group, unit, at));
        taken = count;
        break;
      }
      const grid = bestGrid(group, unit);
      if (!grid) continue;
      const fits = unit === 'slide' ? slideFits(group, grid.scale) : pageFits(group, grid.scale);
      if (!fits && count > 1) continue;
      sheets.push(placeGrid(group, unit, at));
      taken = count;
      break;
    }
    i += taken || 1;
  }
  return sheets;
}

/** `count` positions spread evenly over `total`, the first and the last among them. */
function evenly(total, count) {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count <= 1) return [0];
  const picked = new Set();
  for (let i = 0; i < count; i += 1) picked.add(Math.round((i * (total - 1)) / (count - 1)));
  return [...picked];
}

/**
 * Which pages go on which picture.
 *
 * Blank pages and exact duplicates are dropped first: a picture of nothing costs
 * as much as a picture of something. Then pages are taken in order, as many at a
 * time as stay legible. If that is more pictures than `maxSheets`, an overview: the
 * most pages that fit, evenly spread, the first and last among them.
 *
 * `asked` is the model naming pages. It wants those, as large as they need, so each
 * has a picture to itself, and blanks and duplicates are shown after all, because
 * it asked. Asking for more than `maxSheets` goes back to sharing, in the order
 * asked, and what still does not fit is left for another call.
 *
 * Pieces of one worksheet are `n` with a `part`. Every worksheet gets its first
 * piece before any gets a second, or one long sheet would hide the rest of the book.
 *
 * @param {PlanItem[]} items
 * @param {{ maxSheets?: number, asked?: boolean }} [options]
 * @returns {{ sheets: PlannedSheet[], shown: number[], skipped: number[], blank: number[],
 *   duplicates: { n: number, of: number }[], partial: { n: number, shown: number, of: number }[] }}
 */
export function sheetPlan(items, { maxSheets = 6, asked = false } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxSheets) || 1));
  const all = Array.isArray(items) ? items : [];
  const unit = all[0]?.unit || 'page';
  const blank = [];
  const duplicates = [];
  /** @type {number[]} */
  const kept = [];
  all.forEach((item, index) => {
    if (!asked && item.blank) blank.push(item.n);
    else if (!asked && item.duplicateOf != null) duplicates.push({ n: item.n, of: item.duplicateOf });
    else kept.push(index);
  });
  // A file with nothing on it still shows its first page: "this is empty" is what a model checking it needs to see.
  if (!kept.length && all.length) {
    kept.push(0);
    blank.shift();
  }

  const build = (indexes) => {
    const list = indexes.map((index) => all[index]);
    if (asked && unit !== 'sheet' && list.length <= limit) {
      return list.map((item, i) => placeGrid([item], unit, [indexes[i]]));
    }
    return groupPages(list, unit, indexes);
  };

  const numbers = (indexes) => [...new Set(indexes.map((index) => all[index].n))];
  let chosen = kept;
  let sheets = build(kept);

  if (sheets.length > limit && unit === 'sheet') {
    // First pieces first, spread over the book if even those will not fit; then
    // further pieces in turn, for as long as there is room.
    const firsts = kept.filter((index) => !all[index].part);
    let base = firsts;
    for (let count = Math.min(firsts.length, limit * 8); count >= 1; count -= 1) {
      base = evenly(firsts.length, count).map((i) => firsts[i]);
      if (build(base).length <= limit) break;
    }
    const taken = new Set(base);
    const shownSheets = new Set(base.map((index) => all[index].n));
    const rest = kept.filter((index) => !taken.has(index) && shownSheets.has(all[index].n));
    for (const index of rest) {
      const trial = [...taken, index].sort((a, b) => a - b);
      if (build(trial).length > limit) break;
      taken.add(index);
    }
    chosen = [...taken].sort((a, b) => a - b);
    sheets = build(chosen);
  } else if (sheets.length > limit && asked) {
    // Asked for by number: the order asked is the priority, not a spread.
    let count = kept.length;
    while (count > 1 && build(kept.slice(0, count)).length > limit) count -= 1;
    chosen = kept.slice(0, count);
    sheets = build(chosen);
  } else if (sheets.length > limit) {
    for (let count = Math.min(kept.length - 1, limit * 6); count >= 1; count -= 1) {
      chosen = evenly(kept.length, count).map((i) => kept[i]);
      sheets = build(chosen);
      if (sheets.length <= limit) break;
    }
  }

  const shown = numbers(chosen);
  const showing = new Set(shown);
  const skipped = numbers(kept).filter((n) => !showing.has(n));
  /** A worksheet that had to be cut short: drawn, but not all of it. */
  const partial = [];
  for (const n of shown) {
    const pieces = all.filter((item) => item.n === n);
    if (pieces.length < 2) continue;
    const drawn = chosen.filter((index) => all[index].n === n).length;
    if (drawn < pieces.length) partial.push({ n, shown: drawn, of: pieces.length });
  }
  return { sheets, shown, skipped, blank, duplicates, partial };
}

/* ── drawing, on whatever thread calls it ───────────────────────────── */

/**
 * Why the drawing library would not load on this server, once it has failed (owner,
 * 2026-11-11: "This server could not draw …" said nothing about why, and the swallowed
 * error left nothing in the logs either). Empty while it loads.
 */
let canvasProblem = '';
export const drawingProblem = () => canvasProblem;

/** The drawing library, or null — and when it is null, said once, in the log and in `drawingProblem`. */
async function loadCanvas() {
  try {
    return await import('@napi-rs/canvas');
  } catch (err) {
    if (!canvasProblem) console.error('[office] the drawing library did not load:', err?.code || '', String(err?.message || err).slice(0, 300));
    canvasProblem = `the drawing library did not load on this server (${String(err?.code || err?.message || err).slice(0, 80)})`;
    return null;
  }
}

/**
 * The whole look, on this thread: the worker's, or this one's where no worker can
 * load. Modules are imported by a literal path so the deployment tracer bundles them.
 *
 * @param {Buffer} bytes
 * @param {{ name?: string, pages?: number[]|null, maxSheets?: number, timeoutMs?: number }} [options]
 * @returns {Promise<any>} null when the canvas cannot load on this platform
 */
export async function lookAtFileHere(bytes, options = {}) {
  const canvasApi = await loadCanvas();
  if (!canvasApi) return null;
  const { drawLook } = await import('./draw/index.js');
  return drawLook(bytes, options, canvasApi, { lookableFormat, sheetPlan, strip: STRIP, caption: CAPTION });
}

/**
 * What a viewer asks for, on whatever thread calls it: see `officeView`.
 *
 * @param {'page'|'workbook'|'drawing'} job
 * @param {Buffer} bytes
 * @param {any} options
 * @returns {Promise<any>} null when the canvas cannot load on this platform
 */
export async function officeViewHere(job, bytes, options = {}) {
  const canvasApi = await loadCanvas();
  if (!canvasApi) return null;
  const { drawPage, drawWorkbookModel, drawDrawing } = await import('./draw/index.js');
  if (job === 'page') return drawPage(bytes, options, canvasApi, { lookableFormat });
  if (job === 'workbook') return drawWorkbookModel(bytes, options, canvasApi);
  return drawDrawing(bytes, options, canvasApi);
}

/* ── on a worker ────────────────────────────────────────────────────── */

const LOOK_MS = 45_000;
const LOOK_HEAP_MB = 512;

/** A worker that could not load its own code is the deployment, not the file. */
const WORKER_LOAD = /ERR_MODULE_NOT_FOUND|ERR_WORKER_PATH|ERR_WORKER_INIT_FAILED|Cannot find module/;

const unreadable = (message) => Object.assign(new Error(message), { code: 'office_unreadable' });

/**
 * A file, as pictures.
 *
 * The parsing and the drawing run on a worker for the reason `renderPdfPages` does:
 * these files can come from strangers, and a crafted one could otherwise hold the
 * thread every other request runs on. On the worker it can be stopped after
 * `timeoutMs`, and its heap is its own. Only where a worker cannot load at all does
 * it run here. A deadline is not retried here: it is the file.
 *
 * @param {Buffer|string} file  a Buffer, or the base64 an attachment is stored as
 * @param {{ name?: string, pages?: number[]|null, maxSheets?: number, timeoutMs?: number, workerUrl?: URL }} [options]
 *   `workerUrl` is for tests, which stand in a worker whose code cannot be loaded.
 *   `pages` are 1-based pages, slides or worksheets to show at full size.
 * @returns {Promise<{ format: 'docx'|'xlsx'|'pptx', unit: 'page'|'slide'|'sheet', total: number,
 *   shown: number[], skipped: number[], notes: string[],
 *   sheets: { mime: 'image/jpeg', data: string, width: number, height: number, label: string, pages: number[] }[] } | null>}
 *   null when the canvas cannot load on this platform: a real answer, meaning "cannot look".
 * @throws {Error} with `code: 'office_unreadable'` for a corrupt or hostile file
 */
export async function lookAtFile(file, { name = '', pages = null, maxSheets = 6, timeoutMs = LOOK_MS, workerUrl = new URL('./look.worker.mjs', import.meta.url) } = {}) {
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(String(file || ''), 'base64');
  const options = { name, pages, maxSheets, timeoutMs };
  const here = () => lookAtFileHere(bytes, options);
  const drawn = await onWorker(workerUrl, { bytes: Uint8Array.from(bytes), options }, {
    timeoutMs,
    here,
    late: `That file took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s to draw, so drawing it was stopped.`,
  });
  // Null from the worker can mean the canvas would not load there; ask here.
  return drawn ?? here();
}

/**
 * One page or slide as a picture, a worksheet's cells, or one chart or picture off a
 * sheet, for the viewer. On a worker for the reason a look is.
 *
 * @param {'page'|'workbook'|'drawing'} job
 * @param {Buffer} bytes
 * @param {any} [options]
 */
export async function officeView(job, bytes, options = {}) {
  const timeoutMs = LOOK_MS;
  const here = () => officeViewHere(job, bytes, { ...options, timeoutMs });
  const out = await onWorker(new URL('./look.worker.mjs', import.meta.url), { job, bytes: Uint8Array.from(bytes), options: { ...options, timeoutMs } }, {
    timeoutMs,
    here,
    late: `That file took longer than ${Math.round(timeoutMs / 1000)}s to read, so it was stopped.`,
  });
  return out ?? here();
}

/**
 * @param {URL} workerUrl
 * @param {any} workerData
 * @param {{ timeoutMs: number, here: () => Promise<any>, late: string }} job
 */
export function onWorker(workerUrl, workerData, { timeoutMs, here, late }) {
  let worker;
  try {
    worker = new Worker(workerUrl, { workerData, resourceLimits: { maxOldGenerationSizeMb: LOOK_HEAP_MB } });
  } catch {
    return here();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, unreadable(late)), timeoutMs);
    worker.once('message', (out) => {
      if (out?.ok) finish(resolve, out.result ?? null);
      else finish(reject, Object.assign(new Error(out?.message || 'That file could not be drawn.'), { code: out?.code || 'office_unreadable' }));
    });
    worker.once('error', (err) => {
      /*
       * A worker that could not load its own code is this deployment, not the
       * file: done on this thread, rather than failing every look. Running out of
       * its heap is the file, and is not retried here.
       */
      if (!settled && WORKER_LOAD.test(`${err?.code} ${err?.message}`)) {
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        here().then(resolve, reject);
        return;
      }
      finish(reject, unreadable(`That file could not be drawn: ${err?.message || err}`));
    });
    worker.once('exit', (code) => finish(reject, unreadable(`That file could not be drawn: its reader stopped (${code}).`)));
  });
}
