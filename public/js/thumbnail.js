/**
 * A small picture of a file, made once, by the browser that uploaded it.
 *
 * The shelf used to be a list of names. Nothing to look at, nothing to tell a
 * scanned exam paper from a rubric at a glance, and no way to know which of
 * four PDFs is the one you meant. A thumbnail fixes that for the two kinds
 * where there is something to see: an image, and a PDF's first page.
 *
 * Made here rather than on the server for one reason that is not a preference:
 * pdfjs renders to a canvas, and a canvas in Node is a native module, which a
 * free serverless deployment cannot have. Made *once*, at upload, rather than
 * per view: the result is a few kilobytes stored beside the source, so drawing
 * the shelf afterwards costs nothing and works with no JavaScript running at
 * all beyond an `<img>`.
 *
 * Everything here is best-effort. A thumbnail that cannot be made is not an
 * error — the file still uploads, and the card draws its type badge instead.
 * Refusing an upload because a picture of it could not be drawn would be
 * trading the thing that matters for the thing that is nice to have.
 */

/** Big enough to read a page title at, small enough to keep in the row. */
const MAX_EDGE = 420;
const QUALITY = 0.72;

/** Anything slower than this is a file we should stop waiting on. */
const TIMEOUT_MS = 20_000;

/**
 * Loaded on demand, and only by someone adding a PDF.
 *
 * 1.7MB of parser that nobody else in the app ever needs — not the person
 * reading a conversation, not the person adding a .docx. Importing it at module
 * load would put it on the critical path of opening the app at all.
 */
const BASE = '/vendor/pdfjs';

let pdfjs = null;
async function engine() {
  if (!pdfjs) {
    // Through a variable, so the type-checker does not try to resolve a URL
    // path against the filesystem — the same reason `math.js` reaches KaTeX
    // through `window` rather than importing it.
    const src = `${BASE}/pdf.min.mjs`;
    const lib = await import(src);
    // The worker is a separate file under the same origin, which `script-src
    // 'self'` allows and a CDN would not.
    lib.GlobalWorkerOptions.workerSrc = `${BASE}/pdf.worker.min.mjs`;
    pdfjs = lib;
  }
  return pdfjs;
}

/** The size to draw at: the long edge capped, the proportions kept. */
function fit(width, height) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const toJpeg = (canvas) => {
  try {
    return canvas.toDataURL('image/jpeg', QUALITY);
  } catch {
    // A tainted canvas, or a browser refusing the format. Neither is worth an
    // exception reaching an upload.
    return null;
  }
};

/** Scale an image file down to something that belongs in a database row. */
async function fromImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a readable image'));
      img.src = url;
    });
    const { width, height } = fit(img.naturalWidth || 1, img.naturalHeight || 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // A transparent PNG becomes black without this, because JPEG has no alpha.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return toJpeg(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draw page one of a PDF. */
async function fromPdf(file) {
  const { getDocument } = await engine();
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // Nothing here should reach the network for fonts or character maps: a
    // thumbnail that looks different because a CDN was reachable is worse than
    // one that is plainly missing a glyph.
    disableFontFace: false,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const { width, height } = fit(base.width, base.height);
    const viewport = page.getViewport({ scale: width / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Pages are drawn on white. A PDF has no background of its own, and without
    // this the transparent areas come out black on a dark page.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const out = toJpeg(canvas);
    page.cleanup();
    return { thumb: out, pages: doc.numPages };
  } finally {
    // The loading task owns the worker; destroying the document alone leaves it
    // running, and a person adding ten PDFs would leave ten of them behind.
    await task.destroy().catch(() => {});
  }
}

/**
 * The text inside a PDF, for a file too large to send as a file.
 *
 * The same parser the thumbnails use, so there is one copy of it and one place
 * that decides how a PDF is opened. What comes back is what every model on the
 * OpenAI wire format would have been given anyway — see `server/pdf.js` — so
 * sending this instead of the bytes loses the layout and, for most of the
 * library, nothing else.
 *
 * Null when there is no text to be had: a scan, or photographs of pages. That
 * is a real answer, and the caller says so rather than sending an empty file.
 */
export async function textOfPdf(file) {
  const { getDocument } = await engine();
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  try {
    const doc = await task.promise;
    // Bounded the same way the server's reader is: enough of a long document to
    // work with, without turning a 900-page book into a prompt nobody can pay
    // for. The page count travels so the caller can say what was read.
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PDF_PAGES); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        // `hasEOL` is where the engine itself thinks a line ended, which is the
        // only line-breaking information in the file that was not guessed from
        // coordinates. The same reading as `server/pdf.js`, deliberately: a
        // document sent from here and the same one read there must not differ.
        if (item.hasEOL) text += '\n';
        else if (!item.str.endsWith(' ')) text += ' ';
      }
      page.cleanup();
      const cleaned = text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!cleaned) continue;
      if (chars + cleaned.length > MAX_PDF_CHARS) {
        pages.push(`--- page ${n} ---\n${cleaned.slice(0, Math.max(0, MAX_PDF_CHARS - chars))}`);
        break;
      }
      pages.push(`--- page ${n} ---\n${cleaned}`);
      chars += cleaned.length;
    }
    if (!pages.length) return null;
    return { text: pages.join('\n\n'), pages: doc.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The same bounds the server's PDF reader uses, for the same reasons. */
const MAX_PDF_CHARS = 120_000;
const MAX_PDF_PAGES = 200;

/**
 * A thumbnail for this file, or null when there is nothing to draw.
 *
 * @returns `{ thumb, pages }` — `pages` only for a PDF, where the count is
 *   worth showing beside the picture and is free to read here.
 */
export async function thumbnailFor(file) {
  const name = String(file?.name || '');
  const type = String(file?.type || '').toLowerCase();
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  const isImage = /^image\//.test(type) && !/svg/.test(type);
  if (!isPdf && !isImage) return { thumb: null, pages: null };

  const work = isPdf ? fromPdf(file) : fromImage(file).then((thumb) => ({ thumb, pages: null }));
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ thumb: null, pages: null }), TIMEOUT_MS));

  try {
    return (await Promise.race([work, timeout])) || { thumb: null, pages: null };
  } catch {
    // A corrupt file, a password-protected PDF, an image the decoder refused.
    // The upload carries on without a picture.
    return { thumb: null, pages: null };
  }
}
