/**
 * A transparent picture, put on a ground a model can see it against.
 *
 * A diagram exported from a drawing tool is dark lines on nothing. Shown in
 * the app it now sits on white (owner, 2026-10-06), but the model is sent the
 * file itself, and how a provider fills "nothing" is its own business — a
 * vision model that composites onto black sees black lines on black, and reads
 * an empty picture. So before a picture with real transparency goes to a model
 * it is flattened onto a ground: white, the way it was drawn to be seen —
 * unless what is drawn is mostly light (a white logo, white text), which white
 * would erase, and then a dark one.
 *
 * Cheap where it does not apply: a PNG or WebP says in its first bytes whether
 * it can carry transparency at all, and only those are decoded; one decoded
 * and found fully opaque — most screenshots are RGBA with nothing see-through —
 * goes as it was. Never in the way: a picture too large to decode safely, a
 * format this does not read, or any failure, and the original is sent.
 */

/** Past this many pixels a picture is sent as it is — decoding it would be the problem. */
const MAX_PIXELS = 16_000_000;
/** The long edge a flattened picture is sent at: enough for any model to read, within every provider's size limit. */
const MAX_EDGE = 2000;
/** How many pictures were decoded — for the suite, which checks a huge one never is. */
let decodes = 0;
/** Above this mean lightness of the drawn pixels, a white ground would hide them. */
const LIGHT_DRAWING = 0.75;
const WHITE = '#ffffff';
const DARK = '#1f2328';

const CACHE_SIZE = 64;
const cache = new Map();

let canvasApi = null;
async function canvas() {
  if (!canvasApi) canvasApi = await import('@napi-rs/canvas');
  return canvasApi;
}

/**
 * Whether these bytes can hold transparency, and how big the picture claims to be.
 * Read from the header alone: a PNG's colour type or a tRNS chunk, a WebP's
 * alpha flag. Anything else — JPEG has no alpha — is null.
 *
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function mayBeTransparent(bytes) {
  if (bytes.length > 33 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const colorType = bytes[25];
    let alpha = colorType === 4 || colorType === 6;
    // A palette or truecolour image can still mark colours transparent, in a
    // tRNS chunk before the image data.
    for (let at = 33; !alpha && at + 8 <= bytes.length; ) {
      const length = bytes.readUInt32BE(at);
      const type = bytes.toString('latin1', at + 4, at + 8);
      if (type === 'tRNS') alpha = true;
      if (type === 'IDAT' || type === 'IEND') break;
      at += 12 + length;
    }
    return alpha ? { width, height } : null;
  }
  if (bytes.length > 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X' && bytes[20] & 0x10) {
      const width = 1 + bytes.readUIntLE(24, 3);
      const height = 1 + bytes.readUIntLE(27, 3);
      return { width, height };
    }
  }
  return null;
}

/**
 * The picture to send a model: flattened onto a ground when it has real
 * transparency, otherwise exactly as given.
 *
 * @param {{ id?: string, mime: string, data: string }} image  base64 `data`
 * @returns {Promise<{ mime: string, data: string }>}
 */
export async function groundedImage(image) {
  const key = image.id ? `${image.id}:${image.data.length}` : null;
  const original = { mime: image.mime, data: image.data };
  // Only a flattened picture is kept; one that went as it was is remembered as
  // that, not as a second copy of its bytes.
  if (key && cache.has(key)) return cache.get(key) || original;
  let out = original;
  try {
    const bytes = Buffer.from(image.data, 'base64');
    const size = mayBeTransparent(bytes);
    if (size && size.width * size.height <= MAX_PIXELS) {
      const { createCanvas, loadImage } = await canvas();
      decodes += 1;
      const picture = await loadImage(bytes);
      const surface = createCanvas(picture.width, picture.height);
      const ctx = surface.getContext('2d');
      ctx.drawImage(picture, 0, 0);
      const pixels = ctx.getImageData(0, 0, picture.width, picture.height).data;
      let seeThrough = false;
      let light = 0;
      let drawn = 0;
      // Every fourth pixel is plenty to tell a light drawing from a dark one.
      for (let i = 0; i < pixels.length; i += 16) {
        const a = pixels[i + 3];
        if (a < 250) seeThrough = true;
        if (a > 32) {
          light += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
          drawn += 1;
        }
      }
      if (seeThrough) {
        const ground = drawn && light / drawn > LIGHT_DRAWING ? DARK : WHITE;
        const k = Math.min(1, MAX_EDGE / Math.max(picture.width, picture.height));
        const w = Math.max(1, Math.round(picture.width * k));
        const h = Math.max(1, Math.round(picture.height * k));
        const flat = createCanvas(w, h);
        const paint = flat.getContext('2d');
        paint.fillStyle = ground;
        paint.fillRect(0, 0, w, h);
        paint.drawImage(picture, 0, 0, w, h);
        out = { mime: 'image/png', data: (await flat.encode('png')).toString('base64') };
      }
    }
  } catch {
    // The original, as it always was.
  }
  if (key) {
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, out === original ? null : out);
  }
  return out;
}

export const __testing = { decodes: () => decodes, MAX_PIXELS };
