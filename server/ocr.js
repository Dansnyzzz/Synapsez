import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Reading the text in a picture with no model, no key and no account.
 *
 * Tesseract, as WebAssembly (tesseract.js 7), with the Vietnamese and English
 * LSTM models shipped in server/assets/tessdata — so nothing is downloaded, not
 * even on a cold start, and a CDN that does not answer cannot stop it. The
 * Vietnamese model was trained with the diacritics, which is what most people
 * using this app write in.
 *
 * It reads words, and is used two ways (see vision.js): as the exact
 * transcription a vision model is handed to check its own reading against —
 * vision models misread digits, and Tesseract does not invent them — and as the
 * whole answer when no vision model can be reached.
 *
 * One worker per process, started on first use and kept: loading the engine is
 * most of the cost, and a warm instance should not pay it twice.
 */

const LANGS = ['vie', 'eng'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, 'assets', 'tessdata');

/**
 * Small text is what Tesseract gets wrong: it reads best at roughly 30px per
 * line, and a screenshot's 11px menu is a third of that. Pictures narrower than
 * this are scaled up (at most 3×) before reading.
 */
const TARGET_WIDTH = 1800;
const MAX_SCALE = 3;
/** Past this a picture is read as it is; scaling a poster up helps nothing. */
const MAX_PIXELS = 24_000_000;

/** @type {Promise<any> | null} */
let starting = null;

async function worker() {
  if (!starting) {
    starting = (async () => {
      const { createWorker } = await import('tesseract.js');
      const local = fs.existsSync(path.join(BUNDLED, 'vie.traineddata.gz'));
      // OEM 1 is the LSTM engine, the accurate one; the legacy engine is not
      // loaded at all.
      return createWorker(LANGS, 1, {
        // The shipped models; the CDN only if they are somehow missing.
        ...(local ? { langPath: BUNDLED, cacheMethod: 'none' } : { cachePath: path.join(os.tmpdir(), 'synapse-tessdata') }),
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
 * The picture as Tesseract reads it best: on white, and big enough.
 *
 * A PNG with a transparent background decodes as black behind black text,
 * which reads as nothing at all — so every picture is flattened onto white.
 * Returns the original bytes when the canvas is not available.
 */
export async function prepareForOcr(bytes) {
  let canvasApi;
  try {
    canvasApi = await import('@napi-rs/canvas');
  } catch {
    return { bytes, scale: 1 };
  }
  const image = await canvasApi.loadImage(bytes);
  const scale =
    image.width * image.height > MAX_PIXELS ? 1 : Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / Math.max(1, image.width)));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = canvasApi.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);
  return { bytes: Buffer.from(await canvas.encode('png')), scale };
}

/**
 * The text in one image.
 *
 * @param {string|Buffer} image  base64 or bytes of a PNG, JPEG, WebP or GIF
 * @returns {Promise<{ text: string, confidence: number }>} confidence is 0–100
 */
export async function ocrImage(image) {
  const raw = Buffer.isBuffer(image) ? image : Buffer.from(String(image || ''), 'base64');
  const prepared = await prepareForOcr(raw).catch(() => ({ bytes: raw, scale: 1 }));
  const w = await worker();
  const { data } = await w.recognize(prepared.bytes);
  return {
    text: String(data?.text || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    confidence: Math.round(Number(data?.confidence) || 0),
  };
}

/** For the tests and for shutting a long-running process down cleanly. */
export async function stopOcr() {
  if (!starting) return;
  const w = await starting.catch(() => null);
  starting = null;
  await w?.terminate?.().catch(() => {});
}

export const __testing = { BUNDLED, LANGS, TARGET_WIDTH };
