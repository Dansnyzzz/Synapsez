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

/** Enough of a long document to work with, without eating the whole window. */
const MAX_CHARS = 120_000;
const MAX_PAGES = 200;

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

/**
 * Pull the text out of a PDF.
 *
 * @param file the bytes, either as the base64 an attachment is stored as or as
 *   a `Buffer` — `web_fetch` has just downloaded one and encoding 30MB to
 *   base64 only for this to decode it again is a copy nobody needs.
 * @returns `{ text, pages, truncated }`, or null when there is no text to be
 *   had — a scan, a poster, anything that is pictures all the way down. Null is
 *   a real answer here: it means "say you could not read it", not "try harder".
 */
export async function extractPdfText(file) {
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
