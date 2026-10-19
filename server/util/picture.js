import { mayBeTransparent } from '../imageGround.js';

/**
 * A picture a step read, made into something to look at (owner, 2026-10-19).
 *
 * Shared by the worker and the server. The worker shrinks a picture before it
 * posts it, because a request over 4.5MB never reaches a serverless function
 * and a 6MB figure is ordinary; the server keeps the copy and a thumbnail for
 * the strip a folded run shows. Best-effort on both sides: `@napi-rs/canvas` is
 * a native module, and where it will not load the picture goes as it was.
 */

/** The long edge a picture is kept at — sharp in a lightbox, small in the database. */
export const VIEW_EDGE = 1600;
/** The long edge of its thumbnail — the strip, a row, the hover preview. */
export const THUMB_EDGE = 420;
/** A picture this small, in a format every browser draws, is kept byte for byte. */
const KEEP_BYTES = 1024 * 1024;
const SHOWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The extensions `read_file` treats as pictures before it looks at the bytes. */
export const PICTURE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp)$/i;

/** @type {any} */
let canvasApi;
async function canvas() {
  if (canvasApi === undefined) {
    try {
      canvasApi = await import('@napi-rs/canvas');
    } catch {
      canvasApi = null;
    }
  }
  return canvasApi;
}

/**
 * What kind of picture these bytes are, from their first bytes — never from a
 * name, which is only a claim.
 *
 * @param {Buffer} bytes
 * @returns {string|null}
 */
export function sniffPicture(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * Past this many pixels a picture is not decoded at all: a few hundred bytes
 * of PNG can claim 60000×60000, and decoding that is gigabytes of memory —
 * on the person's computer, on the server, then in the browser that shows it.
 * 40 million is a 600dpi figure; nothing anybody reads is larger.
 */
export const MAX_PIXELS = 40_000_000;

/**
 * How big a picture says it is, from its header alone — before anything
 * decodes it. Null when the header is not one this knows.
 *
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function pictureSize(bytes) {
  const mime = sniffPicture(bytes);
  try {
    if (mime === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mime === 'image/gif' && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mime === 'image/bmp' && bytes.length >= 26) return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    if (mime === 'image/webp' && bytes.length >= 30) {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
    if (mime === 'image/jpeg') {
      // The frame header (SOFn) carries the size; walk the segments to it.
      for (let at = 2; at + 9 < bytes.length; ) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          at += 2;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
        at += 2 + bytes.readUInt16BE(at + 2);
      }
    }
  } catch {
    /* a header cut short: unknown */
  }
  return null;
}

/**
 * A copy to look at, and a thumbnail.
 *
 * A picture already small and in a format every browser draws is kept as it
 * is; anything else is drawn again at 1600px — PNG when it may be see-through,
 * JPEG on white otherwise, since JPEG turns transparency black.
 *
 * @param {Buffer} bytes
 * @returns {Promise<{ data: Buffer, mime: string, width: number, height: number, thumb: string|null } | null>}
 *   null when the bytes are not a picture at all.
 * @throws when the picture claims more than MAX_PIXELS — it is never decoded.
 */
export async function viewCopy(bytes) {
  const mime = sniffPicture(bytes);
  if (!mime) return null;
  const claimed = pictureSize(bytes);
  if (claimed && claimed.width * claimed.height > MAX_PIXELS) {
    throw new Error(`It is ${claimed.width}×${claimed.height} — too many pixels to open safely. Make a smaller copy and read that.`);
  }
  const asItIs = { data: bytes, mime, width: 0, height: 0, thumb: null };
  const api = await canvas();
  if (!api) return asItIs;
  let picture;
  try {
    picture = await api.loadImage(bytes);
  } catch {
    return asItIs;
  }
  const { width, height } = picture;
  if (!width || !height) return asItIs;
  /** @param {number} edge @param {'png'|'jpeg'} as @param {number} quality */
  const draw = async (edge, as, quality) => {
    const k = Math.min(1, edge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const surface = api.createCanvas(w, h);
    const paint = surface.getContext('2d');
    if (as === 'jpeg') {
      paint.fillStyle = '#ffffff';
      paint.fillRect(0, 0, w, h);
    }
    paint.drawImage(picture, 0, 0, w, h);
    return as === 'png' ? surface.encode('png') : surface.encode('jpeg', quality);
  };
  /**
   * Whether anything in it is really see-through. The header only says it
   * could be — a chart saved by matplotlib is RGBA and fully opaque — so the
   * pixels of a small drawing of it decide.
   */
  const seeThrough = () => {
    if (!mayBeTransparent(bytes)) return false;
    const k = Math.min(1, THUMB_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const surface = api.createCanvas(w, h);
    const paint = surface.getContext('2d');
    paint.drawImage(picture, 0, 0, w, h);
    const pixels = paint.getImageData(0, 0, w, h).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 250) return true;
    return false;
  };
  try {
    const keep = SHOWABLE.has(mime) && Math.max(width, height) <= VIEW_EDGE && bytes.length <= KEEP_BYTES;
    const as = !keep && seeThrough() ? 'png' : 'jpeg';
    const data = keep ? bytes : await draw(VIEW_EDGE, as, 85);
    const thumb = await draw(THUMB_EDGE, 'jpeg', 72);
    return {
      data,
      mime: keep ? mime : `image/${as}`,
      width,
      height,
      thumb: `data:image/jpeg;base64,${thumb.toString('base64')}`,
    };
  } catch {
    return { ...asItIs, width, height };
  }
}
