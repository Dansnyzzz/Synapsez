import os from 'node:os';
import path from 'node:path';

/**
 * Reading the text in a picture with no model, no key and no account.
 *
 * The last rung of `see` (vision.js). The free vision models understand a
 * picture — layout, charts, handwriting — but every one of them needs a key to
 * reach, and a free key's daily allowance runs out. Tesseract needs nothing: it
 * runs here, as WebAssembly, and its Vietnamese model was trained with the
 * diacritics, which is what most people using this app write in.
 *
 * What it gives up is understanding. It returns the words and nothing about
 * what they are part of, so the reading is labelled as OCR for the model that
 * receives it — "the text in the image is…", never "the image shows…".
 *
 * One worker per process, started on first use and kept: loading the engine
 * and the language data is most of the cost, and a serverless instance that is
 * warm enough to be asked twice should not pay it twice. The language files
 * are fetched once from the CDN tesseract.js is built against and cached in the
 * temp directory, the one place a serverless function may write.
 */

const LANGS = ['vie', 'eng'];

/** @type {Promise<any> | null} */
let starting = null;

async function worker() {
  if (!starting) {
    starting = (async () => {
      const { createWorker } = await import('tesseract.js');
      // OEM 1 is the LSTM engine, the accurate one; the legacy engine is not
      // loaded at all, which is also what keeps the download small.
      return createWorker(LANGS, 1, {
        cachePath: path.join(os.tmpdir(), 'synapse-tessdata'),
        logger: () => {},
        errorHandler: () => {},
      });
    })().catch((err) => {
      starting = null;
      throw err;
    });
  }
  return starting;
}

/**
 * The text in one image.
 *
 * @param {string|Buffer} image  base64 or bytes of a PNG, JPEG, WebP or GIF
 * @returns {Promise<{ text: string, confidence: number }>} confidence is 0–100
 */
export async function ocrImage(image) {
  const bytes = Buffer.isBuffer(image) ? image : Buffer.from(String(image || ''), 'base64');
  const w = await worker();
  const { data } = await w.recognize(bytes);
  return { text: String(data?.text || '').replace(/\n{3,}/g, '\n\n').trim(), confidence: Number(data?.confidence) || 0 };
}

/** For the tests and for shutting a long-running process down cleanly. */
export async function stopOcr() {
  if (!starting) return;
  const w = await starting.catch(() => null);
  starting = null;
  await w?.terminate?.().catch(() => {});
}
