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

/** The languages read, and shipped: scripts/vendor-tessdata.js copies exactly these. */
export const LANGS = ['vie', 'eng'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.join(HERE, 'assets', 'tessdata');

/**
 * Small text is what Tesseract gets wrong: it reads best at roughly 30px per
 * line, and a screenshot's 11px menu is a third of that. Pictures narrower than
 * this are scaled up (at most 3×) before reading.
 */
const TARGET_WIDTH = 1800;
const MAX_SCALE = 3;
/**
 * The most pixels the canvas Tesseract reads may have — scaled down to this
 * when bigger, never scaled up past it. It used to be a test on the *input*
 * only: a narrow strip just under it was still scaled 3× (600×40,000 became
 * 216 MP, ~864 MB of RGBA), and anything over it was drawn at full size, however
 * large (PERF-018).
 */
const MAX_PIXELS = 24_000_000;
/**
 * Past this a picture is not read at all: decoding it costs four bytes a pixel
 * before anything can be scaled, on a function with two gigabytes. Measured from
 * the file's own header, so the refusal costs nothing.
 */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Width and height from a PNG, GIF, JPEG or WebP header, or null for anything
 * else (which is then left to the decoder). Only the header is read.
 *
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      // Start of frame — every SOF except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/**
 * How much to scale a picture before reading it: up to 3× to reach a readable
 * width, and never so far that the canvas passes MAX_PIXELS — below 1 when the
 * picture is already bigger than that.
 */
export function ocrScale(width, height) {
  const up = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / Math.max(1, width)));
  const cap = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
  return Math.min(up, cap);
}

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
  const scale = ocrScale(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
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
  // Before either decoder sees it: the canvas and, failing that, Tesseract's own.
  const size = imageSize(raw);
  if (size && size.width * size.height > MAX_INPUT_PIXELS) {
    throw new Error('That picture is too large to read for text. Crop it to the part that matters, or send a smaller copy.');
  }
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

export const __testing = { BUNDLED, LANGS, TARGET_WIDTH, MAX_PIXELS, MAX_INPUT_PIXELS };
