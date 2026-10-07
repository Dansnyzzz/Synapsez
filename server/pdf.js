/**
 * Reading a PDF for models that cannot be handed one.
 *
 * Claude and Gemini take a PDF natively and see the layout, the tables and the
 * pictures in it. Everything on the OpenAI wire format — which is every model
 * reached through OpenRouter, and so most of the library — has no such part in
 * its protocol at all. The honest fallback used to be a note saying the file
 * could not be read, which is better than answering about a document nobody
 * looked at, but it is still a dead end for the person who attached it.
 *
 * So the text comes out here instead, and every model gets to read it. What is
 * lost is layout and anything that only exists as a picture; what is gained is
 * that "I cannot read PDFs" stops being an answer.
 *
 * pdfjs is Firefox's PDF engine. The alternative was a few hundred lines of
 * stream inflation and CMap arithmetic that would have got Vietnamese — subset
 * fonts with a ToUnicode table — subtly wrong, and text that is subtly wrong is
 * worse than text that is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/** Enough of a long document to work with, without eating the whole window. */
const MAX_CHARS = 120_000;
const MAX_PAGES = 200;
/** The most pixels one rendered page may have, whatever its shape. */
const MAX_RENDER_PIXELS = 12_000_000;
const MAX_RENDER_SIDE = 16_000;

let pdfjs = null;

/**
 * Loaded on demand, not at import.
 *
 * It is several megabytes of parser that most requests never touch, and on a
 * serverless deployment that cost lands on every cold start — including the
 * ones answering `/api/session`.
 */
async function engine() {
  if (!pdfjs) {
    /**
     * The worker is loaded here, by name, on purpose.
     *
     * pdfjs does its own parsing in a worker and falls back to a "fake worker"
     * — the same code on this thread — when there is no `Worker`, which in Node
     * is always. That fallback reaches the worker module with
     * `import(this.workerSrc)`: a *variable* specifier, which no bundler can
     * follow. Vercel's tracer therefore shipped `pdf.mjs` and not
     * `pdf.worker.mjs`, and every PDF on the deployment failed with
     *
     *   Setting up fake worker failed: "Cannot find module
     *   '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'"
     *
     * while working perfectly on a laptop, where the whole package is on disk.
     *
     * `globalThis.pdfjsWorker` is the documented way in: pdfjs checks it before
     * trying to import anything, so handing it the module we imported ourselves
     * — by a literal path the tracer can see — both bundles the file and skips
     * the dynamic import entirely. The legacy build is the one that runs
     * outside a browser.
     */
    const [core, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);
    globalThis.pdfjsWorker ??= worker;
    pdfjs = core;
  }
  return pdfjs;
}

/** Where pdfjs keeps its standard fonts, with the trailing slash it needs — or null. */
let fontsDir;
function standardFonts() {
  if (fontsDir !== undefined) return fontsDir;
  try {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');
    fontsDir = fs.existsSync(dir) ? `${dir.replace(/\\/g, '/')}/` : null;
  } catch {
    fontsDir = null;
  }
  return fontsDir;
}

/**
 * Pages of a PDF as pictures, for a model to look at.
 *
 * The text layer is what `extractPdfText` reads, and a scan has none: a photo
 * of a contract, a phone-scanned exam paper, a poster. Those are only readable
 * by looking, so they are drawn here — by the same pdfjs, onto
 * `@napi-rs/canvas`, a prebuilt native canvas that needs no system libraries —
 * and handed to a vision model as images.
 *
 * JPEG rather than PNG: a scanned page is a photograph, and the same page is a
 * third of the size, which is what a request carrying eight of them needs.
 *
 * Drawn on this thread; `renderPdfPages` below runs it on a worker.
 *
 * @param file   base64 or a Buffer, as for `extractPdfText`
 * @param pages  1-based page numbers to draw; the first few when omitted
 * @returns `{ pages: [{ page, mime, data }], total }`, or null when the canvas
 *   is not available on this platform — a real answer, meaning "cannot look".
 */
export async function drawPdfPagesHere(file, { pages = null, max = 8, width = 1400 } = {}) {
  let canvasApi;
  try {
    // A literal specifier, so the deployment tracer bundles the native module.
    canvasApi = await import('@napi-rs/canvas');
  } catch {
    return null;
  }
  const { getDocument } = await engine();
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(String(file || ''), 'base64');
  const task = getDocument({
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
    // The fourteen standard PDF fonts ship with pdfjs. Without them a page set in
    // Helvetica is drawn in a fallback face with the spacing wrong — readable,
    // but it costs a vision model accuracy on exactly the small print it is for.
    ...(standardFonts() ? { standardFontDataUrl: standardFonts() } : {}),
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw Object.assign(new Error(`That PDF could not be opened: ${err.message}`), { code: 'pdf_unreadable' });
  }
  try {
    const wanted = (Array.isArray(pages) && pages.length ? pages : Array.from({ length: doc.numPages }, (_, i) => i + 1))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= doc.numPages)
      .slice(0, max);
    const out = [];
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // Wide enough for small print to survive, capped so a poster-sized page
      // does not become a forty-megapixel request — and capped by area too
      // (PERF-019): the width cap alone let a page 100 pt wide and a million
      // tall become a 300 × 3,000,000 canvas, ~3.6 GB of pixels.
      // A side is capped as well: JPEG cannot hold one past 65,535 pixels, and the
      // encoder fails outright rather than shrinking.
      const area = Math.max(1, base.width * base.height);
      const scale = Math.min(
        3,
        width / Math.max(1, base.width),
        Math.sqrt(MAX_RENDER_PIXELS / area),
        MAX_RENDER_SIDE / Math.max(1, base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = canvasApi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: /** @type {any} */ (context), viewport, canvas: /** @type {any} */ (canvas) }).promise;
      const jpeg = await canvas.encode('jpeg', 82);
      out.push({ page: n, mime: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') });
      page.cleanup();
    }
    return { pages: out, total: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/** How long one PDF's text may take, and how much memory its read may hold (PERF-022). */
const TEXT_MS = 25_000;
const TEXT_HEAP_MB = 384;

/**
 * Pull the text out of a PDF, on a worker thread with a deadline (PERF-022).
 *
 * pdfjs parses on the thread that calls it, with no timeout and no way to stop
 * it, so a crafted file — an endless content stream, a compression bomb — could
 * hold the server's event loop, and every other request with it. The read runs
 * in pdfText.worker.mjs instead: stopped after `timeoutMs`, and with a heap of
 * its own capped at TEXT_HEAP_MB, so the worst a file can do is end its own read.
 * Where a worker cannot be started at all, it reads on this thread as before —
 * never worse than it was.
 *
 * @param file the bytes, either as the base64 an attachment is stored as or as
 *   a `Buffer` — `web_fetch` has just downloaded one and encoding 30MB to
 *   base64 only for this to decode it again is a copy nobody needs.
 * @param {{ timeoutMs?: number, workerUrl?: URL }} [options] `workerUrl` is
 *   for tests, which stand in a worker whose code cannot be loaded.
 * @returns `{ text, pages, truncated }`, or null when there is no text to be
 *   had — a scan, a poster, anything that is pictures all the way down. Null is
 *   a real answer here: it means "say you could not read it", not "try harder".
 */
export async function extractPdfText(file, { timeoutMs = TEXT_MS, workerUrl = new URL('./pdfText.worker.mjs', import.meta.url) } = {}) {
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(String(file || ''), 'base64');
  return onWorker(workerUrl, { bytes: Uint8Array.from(bytes) }, {
    timeoutMs,
    heapMb: TEXT_HEAP_MB,
    here: () => readPdfText(bytes),
    late: `That PDF took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s to read, so reading it was stopped.`,
  });
}

/** How long drawing a scan's pages may take, and how much memory it may hold (PERF-023). */
const DRAW_MS = 45_000;
const DRAW_HEAP_MB = 512;

/**
 * Pages of a PDF as pictures, on a worker thread with a deadline (PERF-023).
 *
 * The same reasoning as `extractPdfText`: pdfjs draws on the thread that calls
 * it, and a crafted scan can hold that thread. Memory was already bounded
 * (PERF-019); now time is too, and the heap is the worker's own. The native
 * canvas was never tried inside a worker on Vercel, so anything short of a
 * drawing from the worker — its code missing, the canvas not loading there —
 * draws on this thread as it always did. A deadline is not retried here: it is
 * the file.
 *
 * @param file   base64 or a Buffer
 * @param {{ pages?: number[] | null, max?: number, width?: number, timeoutMs?: number, workerUrl?: URL }} [options]
 *   `workerUrl` is for tests, which stand in a worker whose code cannot be loaded.
 */
export async function renderPdfPages(file, { pages = null, max = 8, width = 1400, timeoutMs = DRAW_MS, workerUrl = new URL('./pdfPages.worker.mjs', import.meta.url) } = {}) {
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(String(file || ''), 'base64');
  const options = { pages, max, width };
  const here = () => drawPdfPagesHere(bytes, options);
  const drawn = await onWorker(workerUrl, { bytes: Uint8Array.from(bytes), options }, {
    timeoutMs,
    heapMb: DRAW_HEAP_MB,
    here,
    late: `That PDF's pages took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s to draw, so drawing them was stopped.`,
  });
  // Null from the worker can mean the canvas would not load there; ask here.
  return drawn ?? here();
}

/** A worker that could not load its own code is the deployment, not the file. */
const WORKER_LOAD = /ERR_MODULE_NOT_FOUND|ERR_WORKER_PATH|ERR_WORKER_INIT_FAILED|Cannot find module/;

/**
 * Run a PDF job on a worker with a deadline and a heap of its own, or on this
 * thread (`here`) where no worker can start or its code cannot load.
 *
 * @param {URL} workerUrl
 * @param {any} workerData
 * @param {{ timeoutMs: number, heapMb: number, here: () => Promise<any>, late: string }} job
 */
function onWorker(workerUrl, workerData, { timeoutMs, heapMb, here, late }) {
  let worker;
  try {
    worker = new Worker(workerUrl, { workerData, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
  } catch {
    return here();
  }
  const unreadable = (message) => Object.assign(new Error(message), { code: 'pdf_unreadable' });
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
      else finish(reject, Object.assign(new Error(out?.message || 'That PDF could not be read.'), { code: out?.code || 'pdf_unreadable' }));
    });
    worker.once('error', (err) => {
      /*
       * A worker that could not load its own code is this deployment, not the
       * file: done on this thread as before, rather than failing every PDF.
       * Running out of its heap is the file, and is not retried here.
       */
      if (!settled && WORKER_LOAD.test(`${err?.code} ${err?.message}`)) {
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        here().then(resolve, reject);
        return;
      }
      finish(reject, unreadable(`That PDF could not be read: ${err?.message || err}`));
    });
    worker.once('exit', (code) => finish(reject, unreadable(`That PDF could not be read: its reader stopped (${code}).`)));
  });
}

/**
 * The read itself, on whatever thread calls it — the worker's, or this one's
 * where no worker can be started. See `extractPdfText`.
 *
 * @param {Buffer | string} file
 */
export async function readPdfText(file) {
  const { getDocument } = await engine();
  const bytes = Buffer.isBuffer(file) ? file : Buffer.from(String(file || ''), 'base64');

  const task = getDocument({
    // Copied rather than handed over: pdfjs takes ownership of the array it is
    // given, and a `Buffer` off the pool shares its memory with other Buffers.
    data: Uint8Array.from(bytes),
    // Nothing here should reach the network or the filesystem for fonts and
    // character maps: a document that renders differently because a CDN was
    // reachable is not a document you can reason about.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    // The parser is chatty about every unsupported feature it meets, and none
    // of it is actionable for the person who attached a file.
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    // An encrypted or corrupt file is not an exception worth propagating — the
    // caller's job is to tell the model the document could not be read.
    throw Object.assign(new Error(`That PDF could not be opened: ${err.message}`), { code: 'pdf_unreadable' });
  }

  try {
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const pages = [];
    let chars = 0;
    let truncated = doc.numPages > MAX_PAGES;

    for (let n = 1; n <= pageCount; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();

      // pdfjs hands back positioned runs, not lines. `hasEOL` is where the
      // engine itself thinks a line ended, which is the only line-breaking
      // information in the file that was not guessed from coordinates.
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (!item.str.endsWith(' ')) text += ' ';
      }
      page.cleanup();

      const cleaned = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!cleaned) continue;

      if (chars + cleaned.length > MAX_CHARS) {
        pages.push(`--- page ${n} ---\n${cleaned.slice(0, Math.max(0, MAX_CHARS - chars))}`);
        truncated = true;
        break;
      }
      pages.push(`--- page ${n} ---\n${cleaned}`);
      chars += cleaned.length;
    }

    if (!pages.length) return null;
    return { text: pages.join('\n\n'), pages: doc.numPages, truncated };
  } finally {
    // The loading task owns the worker; destroying the document alone leaves it
    // running, and a serverless instance will happily hold it until it is frozen.
    await task.destroy();
  }
}
