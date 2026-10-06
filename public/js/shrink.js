/**
 * Making a file small enough to send, in the browser, before it is sent.
 *
 * There are two ceilings and only one of them is ours. The app's own limit is
 * what a row in the database may hold; the one people actually hit first is the
 * host's, which refuses a request body over about 4.5MB at the edge — before a
 * line of our code runs, with a plain-text `Request Entity Too Large` that says
 * nothing about the file. Base64 inflates bytes by a third on the way out, so
 * the real ceiling on a file was never the number the app printed.
 *
 * So the browser shrinks what it can before the request is made:
 *
 *   **Images** are re-encoded at a sane size. A photo off a phone is eight
 *   megapixels of JPEG that no model reads at that resolution anyway — a
 *   1600px long edge is more than any vision model uses, and it routinely turns
 *   6MB into 300KB with nothing lost that was being looked at.
 *
 *   **PDFs** cannot be recompressed, but they can be *read*. pdfjs is already
 *   here for thumbnails, so an oversized PDF becomes the text inside it, sent
 *   as a text file under the same name. That is what every model on the OpenAI
 *   wire format would have received anyway (see `server/pdf.js`), so for most
 *   of the library nothing at all is lost; what goes is the layout, and the
 *   person is told so rather than left to wonder.
 *
 *   **Word, Excel and PowerPoint** files are sent without the pictures inside
 *   them, which are nearly always what makes them big. The words, tables,
 *   slides and sheets are what the server reads (server/office/), and they go
 *   across byte for byte. The person is told the pictures were left out.
 *
 *   **Everything else** — a video, an archive — is already compressed and
 *   cannot be made smaller honestly. It is refused with the one sentence that
 *   helps: how big it is, what fits, and that the app did try.
 *
 * Nothing here is allowed to fail an upload that would otherwise have worked. A
 * file already under the limit is passed through untouched, and every step that
 * could throw falls back to the original bytes.
 */
import { t } from './i18n.js';
import { textOfPdf } from './thumbnail.js';

/**
 * What a request body may carry, as bytes of *file*.
 *
 * The host refuses a body over ~4.5MB. Base64 is 4 bytes out per 3 in, and the
 * JSON envelope around it costs a little more, so the file itself has to come
 * in under about three megabytes for the request to survive the edge. Deliberately
 * under: a limit that is occasionally wrong is worse than one that is lower.
 */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** The long edge no vision model reads past, and the quality to write at. */
const IMAGE_EDGE = 1600;
const IMAGE_QUALITY = 0.82;

const isImage = (type, name) => /^image\//.test(type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
const isPdf = (type, name) => type === 'application/pdf' || /\.pdf$/i.test(name);

/**
 * The largest photo or PDF worth trying to shrink.
 *
 * Neither is uploaded at this size — `prepareUpload` sends a re-encoded image or
 * the PDF's text — so this is a bound on what the browser is asked to decode, not
 * on the request. A 60MB scanned textbook still reads in pdfjs; past that a phone
 * tab is likely to run out of memory before it finishes.
 */
export const MAX_SHRINKABLE_BYTES = 60 * 1024 * 1024;

const isOffice = (name) => /\.(docx|xlsx|pptx)$/i.test(name);

/** Whether `prepareUpload` can make this file smaller, rather than only refuse it. */
export const shrinkable = (file) => {
  const name = String(file?.name || '');
  const type = String(file?.type || '').toLowerCase();
  return isImage(type, name) || isPdf(type, name) || isOffice(name);
};

/**
 * Parts of an Office file that are pictures, embedded files and fonts — what
 * makes a 7MB .docx 7MB. The words, the tables, the slides and the sheets are
 * XML a few hundred kilobytes long, and they are all the server reads anyway
 * (server/office/ skips a picture whose part is missing).
 */
const HEAVY_PART = /(^|\/)(media|embeddings|fonts)\/|^docProps\/thumbnail\./i;

/**
 * The same Office file without its pictures.
 *
 * A .docx, .xlsx or .pptx is a zip. Every part that is kept is copied across
 * exactly as it was compressed — no inflating, no re-deflating, no checksum to
 * recompute — and only the table of contents is written anew. Returns null for
 * anything this does not understand (zip64, a damaged file), and the caller
 * refuses the file as before rather than sending something broken.
 */
export function slimOfficeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record, searched for from the end: it is
  // followed by a comment of up to 64KB.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  // 0xFFFF / 0xFFFFFFFF mean the real numbers are in a zip64 record.
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset >= bytes.length) return null;

  const decoder = new TextDecoder();
  const locals = [];
  const centrals = [];
  let dropped = 0;
  let offset = 0;
  let at = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (HEAVY_PART.test(name)) {
      dropped += 1;
      at += recordLength;
      continue;
    }

    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const localAt = view.getUint32(at + 42, true);
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== 0x04034b50) return null;
    const localHeaderLength = 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const dataEnd = localAt + localHeaderLength + compressedSize;
    if (dataEnd > bytes.length) return null;

    // The local header, with the sizes written in: a part streamed with a data
    // descriptor (flag bit 3) has zeros here and its sizes after the data,
    // which is dropped — so the header must carry them itself.
    const local = bytes.slice(localAt, localAt + localHeaderLength);
    const localView = new DataView(local.buffer);
    localView.setUint16(6, flags & ~0x08, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, size, true);
    locals.push(local, bytes.subarray(localAt + localHeaderLength, dataEnd));

    const central = bytes.slice(at, at + recordLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint16(8, flags & ~0x08, true);
    centralView.setUint32(42, offset, true);
    centrals.push(central);

    offset += localHeaderLength + compressedSize;
    at += recordLength;
  }

  if (!dropped) return null;
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, centrals.length, true);
  endView.setUint16(10, centrals.length, true);
  endView.setUint32(12, cdSize, true);
  endView.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let write = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, write);
    write += part.length;
  }
  return { bytes: out, dropped };
}

/** An oversized Office file, sent without its pictures. */
async function slimOffice(file) {
  const slim = slimOfficeBytes(await file.arrayBuffer());
  if (!slim) return null;
  const data = payloadOf(await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(new Blob([slim.bytes], { type: file.type || 'application/octet-stream' }));
  }));
  if (!data) return null;
  return {
    name: file.name,
    mime: file.type,
    data,
    note: { kind: 'office', from: file.size, to: bytesOf(data), dropped: slim.dropped },
  };
}

/** A `data:` URL's payload, as the base64 the API wants. */
const payloadOf = (url) => String(url || '').split(',')[1] || '';

/** Bytes a base64 string decodes to, without decoding it. */
const bytesOf = (base64) => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => resolve(payloadOf(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Re-encode an image at a size worth sending. */
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not a readable image'));
      img.src = url;
    });

    const scale = Math.min(1, IMAGE_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG has no alpha, so a transparent PNG would come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const data = payloadOf(canvas.toDataURL('image/jpeg', IMAGE_QUALITY));
    if (!data) return null;
    return {
      name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
      mime: 'image/jpeg',
      data,
      // Only worth saying when it actually shrank; a small photo passes through
      // this and comes out roughly the same size, which is not news.
      note: { kind: 'image', from: file.size, to: bytesOf(data), width, height },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Read a PDF's text, so an oversized one can be sent as what it says. */
async function pdfToText(file) {
  // Through `thumbnail.js`, which already loads pdfjs for the shelf's first-page
  // pictures — one copy of a 1.7MB parser, loaded only by someone who needs it.
  const read = await textOfPdf(file);
  if (!read?.text?.trim()) return null;

  const data = payloadOf(await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(new Blob([read.text], { type: 'text/plain' }));
  }));
  if (!data) return null;

  return {
    // `slides.pdf.txt`, not `slides.txt`: what is stored and downloaded is text,
    // so it must end in .txt, but the name still says which document it was —
    // to the person, to the assistant citing it, and to the chip showing "PDF".
    name: `${file.name}.txt`,
    mime: 'text/plain',
    data,
    note: { kind: 'pdf-text', from: file.size, to: bytesOf(data), pages: read.pages },
  };
}

/**
 * Get this file ready to send.
 *
 * @returns `{ name, mime, data, note }` where `note` describes what was done,
 *   or `null` when nothing was. Throws only when the file genuinely cannot be
 *   sent, with a sentence that says what to do about it.
 */
export async function prepareUpload(file) {
  const name = String(file?.name || 'file');
  const type = String(file?.type || '').toLowerCase();

  // Small enough already. Nothing is re-encoded for the sake of it: a 200KB PNG
  // put through a JPEG round trip comes out worse and no smaller.
  if (file.size <= MAX_UPLOAD_BYTES) {
    return { name, mime: type, data: await readAsBase64(file), note: null };
  }

  if (isImage(type, name)) {
    const shrunk = await shrinkImage(file).catch(() => null);
    if (shrunk && bytesOf(shrunk.data) <= MAX_UPLOAD_BYTES) return shrunk;
    // A photograph that is still too big after all that is a very large photo.
    throw new Error(tooBig(name, file.size, 'image'));
  }

  if (isPdf(type, name)) {
    const text = await pdfToText(file).catch(() => null);
    if (text && bytesOf(text.data) <= MAX_UPLOAD_BYTES) return text;
    throw new Error(tooBig(name, file.size, text ? 'pdf-long' : 'pdf'));
  }

  if (isOffice(name)) {
    const slim = await slimOffice(file).catch(() => null);
    if (slim && bytesOf(slim.data) <= MAX_UPLOAD_BYTES) return slim;
    throw new Error(tooBig(name, file.size, slim ? 'office-long' : 'other'));
  }

  throw new Error(tooBig(name, file.size, 'other'));
}

/** What `prepareUpload` made, as a file again: something to draw a thumbnail from. */
export function fileOf(ready) {
  const bytes = Uint8Array.from(atob(ready.data), (c) => c.charCodeAt(0));
  return new File([bytes], ready.name, { type: ready.mime });
}

/**
 * The file made ready to send, and its thumbnail — one decode at a time for a
 * file that has to be shrunk (PERF-021).
 *
 * Both used to start at once. For a 60MB PDF that is two copies of its bytes
 * and two pdfjs documents in memory together; for a large photo, two decodes
 * of every pixel. A phone tab runs out of memory on exactly the files this
 * path exists for. So a file over the send limit is prepared first and drawn
 * after, and a photo is drawn from the 1600px copy just made rather than by
 * decoding the original again. A small file still does both at once.
 *
 * @param {File} file
 * @param {((file: File) => Promise<any>) | null} thumbnail  null for a file with nothing to draw
 */
export async function preparedWithThumb(file, thumbnail) {
  const none = { thumb: null };
  if (!thumbnail) return [await prepareUpload(file), none];
  if (file.size <= MAX_UPLOAD_BYTES) {
    return Promise.all([prepareUpload(file), thumbnail(file).catch(() => none)]);
  }
  const ready = await prepareUpload(file);
  const source = ready.note?.kind === 'image' ? fileOf(ready) : file;
  return [ready, await thumbnail(source).catch(() => none)];
}

/** Why this one could not be sent, and what would work. */
function tooBig(name, size, why) {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return t(`upload.tooBig.${why}`)
    .replace('{name}', name)
    .replace('{size}', mb(size))
    .replace('{limit}', mb(MAX_UPLOAD_BYTES));
}
