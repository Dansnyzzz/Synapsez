/**
 * A GIF from frames of RGBA, for a theme's preview in an email (owner, 2026-11-08: a
 * picture that moves for ever at the top of the announcement). Email clients play a
 * GIF and nothing newer, so this is the format whatever its age.
 *
 * One palette for the whole loop, chosen by median cut over every frame, so a colour
 * does not flicker between frames; each pixel takes its nearest colour, no dithering,
 * which suits pixel art and keeps the file small. Loops for ever.
 *
 * Build-time only: nothing on the server imports it.
 */

/**
 * @param {Uint8ClampedArray[]} frames  RGBA, width × height each
 * @param {number} size
 * @returns {Uint8Array} 256 RGB triplets
 */
function paletteOf(frames, size) {
  // A sample of every frame, so a burst in one frame still gets its colours.
  const samples = [];
  const step = Math.max(1, Math.floor((frames.length * size) / 120_000));
  for (const frame of frames) {
    for (let i = 0; i < size; i += step) samples.push((frame[i * 4] << 16) | (frame[i * 4 + 1] << 8) | frame[i * 4 + 2]);
  }
  const boxes = [samples];
  while (boxes.length < 256) {
    // Split the box with the widest spread of any channel.
    let best = -1;
    let widest = -1;
    let channel = 0;
    boxes.forEach((box, b) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c += 1) {
        const shift = 16 - c * 8;
        let lo = 255;
        let hi = 0;
        for (const v of box) {
          const x = (v >> shift) & 255;
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        if (hi - lo > widest) {
          widest = hi - lo;
          best = b;
          channel = shift;
        }
      }
    });
    if (best < 0 || widest <= 0) break;
    const box = boxes[best].sort((a, b) => ((a >> channel) & 255) - ((b >> channel) & 255));
    boxes.splice(best, 1, box.slice(0, box.length >> 1), box.slice(box.length >> 1));
  }
  const out = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const v of box) {
      r += (v >> 16) & 255;
      g += (v >> 8) & 255;
      b += v & 255;
    }
    const n = Math.max(1, box.length);
    out[i * 3] = Math.round(r / n);
    out[i * 3 + 1] = Math.round(g / n);
    out[i * 3 + 2] = Math.round(b / n);
  });
  return out;
}

/** Each pixel's palette index, a colour looked up once. */
function indexed(frame, size, palette) {
  const cache = new Map();
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const key = (frame[i * 4] << 16) | (frame[i * 4 + 1] << 8) | frame[i * 4 + 2];
    let index = cache.get(key);
    if (index === undefined) {
      let best = Infinity;
      const r = frame[i * 4];
      const g = frame[i * 4 + 1];
      const b = frame[i * 4 + 2];
      for (let p = 0; p < 256; p += 1) {
        const dr = r - palette[p * 3];
        const dg = g - palette[p * 3 + 1];
        const db = b - palette[p * 3 + 2];
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < best) {
          best = d;
          index = p;
        }
      }
      cache.set(key, index);
    }
    out[i] = index;
  }
  return out;
}

/** GIF's LZW, 8-bit codes, written in sub-blocks of 255. */
function lzw(indices) {
  const bytes = [];
  let bits = 0;
  let acc = 0;
  const clear = 256;
  const end = 257;
  let width = 9;
  let dict = new Map();
  let next = 258;
  const put = (code) => {
    acc |= code << bits;
    bits += width;
    while (bits >= 8) {
      bytes.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  put(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next += 1;
      if (next > 1 << width && width < 12) width += 1;
    } else {
      put(clear);
      dict = new Map();
      next = 258;
      width = 9;
    }
    prefix = k;
  }
  put(prefix);
  put(end);
  if (bits > 0) bytes.push(acc & 255);
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
  return out;
}

/**
 * @param {{ width: number, height: number, frames: Uint8ClampedArray[], delayMs: number }} input
 * @returns {Uint8Array}
 */
export function encodeGif({ width, height, frames, delayMs }) {
  const size = width * height;
  const palette = paletteOf(frames, size);
  const out = [];
  const word = (n) => out.push(n & 255, (n >> 8) & 255);
  out.push(...Buffer.from('GIF89a'));
  word(width);
  word(height);
  out.push(0xf7, 0, 0); // a global table of 256 colours
  out.push(...palette);
  // Loop for ever.
  out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0);
  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const frame of frames) {
    out.push(0x21, 0xf9, 0x04, 0x04, delay & 255, (delay >> 8) & 255, 0, 0);
    out.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    out.push(0);
    out.push(8, ...lzw(indexed(frame, size, palette)));
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
