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
 *   **Everything else** — a .docx, a .pptx, a video — is already compressed and
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
    name: file.name.replace(/\.pdf$/i, '') + '.txt',
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

  throw new Error(tooBig(name, file.size, 'other'));
}

/** Why this one could not be sent, and what would work. */
function tooBig(name, size, why) {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return t(`upload.tooBig.${why}`)
    .replace('{name}', name)
    .replace('{size}', mb(size))
    .replace('{limit}', mb(MAX_UPLOAD_BYTES));
}
