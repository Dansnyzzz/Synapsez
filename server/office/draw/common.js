/**
 * What all three formats draw onto.
 *
 * A page is laid out once into a list of drawing operations (`Surface`) and that
 * list can then be replayed at any size: small, to measure how much of the page is
 * ink; large, for the picture the model gets. Laying out is the expensive and the
 * risky part, and it happens without touching a canvas.
 *
 * Coordinates are points everywhere, whatever the file counts in. Each format
 * converts as it reads, so nothing downstream has to know an EMU from a twip.
 */
import { MAX_PIXELS, pictureSize, sniffPicture } from '../../util/picture.js';

/* ── limits: what a stranger's file may cost ────────────────────────── */

export const LIMITS = {
  /** The most pages, slides and worksheets laid out. Past this it is a note. */
  pages: 300,
  slides: 300,
  worksheets: 40,
  rows: 20_000,
  columns: 256,
  cells: 400_000,
  /** Operations on one page: past this it stops drawing more, and says so. */
  ops: 250_000,
  /** How deep shapes may nest, and tables inside tables. */
  nesting: 12,
  /** One XML part, and all parts of a look together, once inflated. */
  xmlBytes: 64 * 1024 * 1024,
  totalBytes: 400 * 1024 * 1024,
  /** One picture's stored bytes; every picture decoded in one look, in pixels. */
  imageBytes: 32 * 1024 * 1024,
  decodedPixels: 160_000_000,
};

/** @param {string} message */
export const refused = (message) => Object.assign(new Error(message), { code: 'office_unreadable' });

/**
 * Time and bytes one look may spend.
 *
 * On a worker the deadline is enforced from outside, and this only makes the
 * refusal tidier. Where no worker could load it is the only thing standing between
 * a crafted file and every other request on the thread, so it is checked in every
 * loop that a file can make long.
 */
export class Budget {
  /** @param {number} timeoutMs */
  constructor(timeoutMs) {
    this.deadline = Date.now() + (Number(timeoutMs) || 45_000);
    this.spent = 0;
    this.ticks = 0;
  }

  /** Cheap enough for an inner loop: the clock is read one call in 256. */
  check() {
    this.ticks += 1;
    if ((this.ticks & 255) === 0 && Date.now() > this.deadline) {
      throw refused('That file took too long to draw, so drawing it was stopped.');
    }
  }

  /** @param {number} bytes */
  spend(bytes) {
    this.spent += bytes;
    if (this.spent > LIMITS.totalBytes) throw refused('That file unpacks to far more than a document should, so it was not drawn.');
  }
}

/**
 * A package whose reads are counted, so a file with a thousand 60MB parts ends its
 * own look. Each part already has a ceiling (zip.js); this is the ceiling on them all.
 *
 * @param {any} zip  from `openZip`
 * @param {Budget} budget
 */
export function countedZip(zip, budget) {
  return {
    names: zip.names,
    has: (name) => zip.has(name),
    read(name, limit = LIMITS.xmlBytes) {
      const data = zip.read(name, limit);
      budget.spend(data.length);
      return data;
    },
    text(name, limit = LIMITS.xmlBytes) {
      const text = zip.text(name, limit);
      budget.spend(text.length);
      return text;
    },
  };
}

/* ── units ──────────────────────────────────────────────────────────── */

/** English Metric Units, DrawingML's: 12700 to the point. */
export const emu = (value) => (Number(value) || 0) / 12700;
/** Twentieths of a point, WordprocessingML's. */
export const twip = (value) => (Number(value) || 0) / 20;

/** @param {number} value @param {number} low @param {number} high */
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* ── colour, as canvas strings ──────────────────────────────────────── */

/** @param {string} hex six digits, no hash @param {number} [alpha] 0–1 */
export function css(hex, alpha = 1) {
  const clean = String(hex || '000000').replace(/^#/, '').padStart(6, '0').slice(-6);
  if (alpha >= 1) return `#${clean}`;
  const n = parseInt(clean, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, alpha).toFixed(3)})`;
}

/** Perceived lightness of a six-digit colour, 0–1: which words read on it. */
export function lightness(hex) {
  const n = parseInt(String(hex || '000000').replace(/^#/, '').slice(-6), 16) || 0;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/* ── a page, as a list of operations ────────────────────────────────── */

/**
 * @typedef {{ kind: 'linear', x0: number, y0: number, x1: number, y1: number, stops: [number, string][] }
 *   | { kind: 'radial', cx: number, cy: number, r: number, stops: [number, string][] }
 *   | string} Paint
 *
 * @typedef {any[]} PathCommand  ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Q',x1,y1,x,y]
 *   ['E',cx,cy,rx,ry,start,end,ccw] ['Z']
 */

export class Surface {
  /** @param {number} width @param {number} height  in points */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ops = [];
    /** While above zero, drawing does not count as the page's own text: a header, a footer. */
    this.quiet = 0;
    this.chars = 0;
    /** @type {Map<number, number>} characters drawn at each size */
    this.sizes = new Map();
    /** @type {Set<string>} */
    this.pictures = new Set();
    this.tableCells = 0;
    this.overflowed = false;
    this.background = '#FFFFFF';
    /** Which page, slide or worksheet this is; for a worksheet, its name and which piece. */
    this.number = 0;
    this.part = 0;
    this.label = '';
  }

  add(op) {
    if (this.ops.length >= LIMITS.ops) {
      this.overflowed = true;
      return;
    }
    this.ops.push(op);
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {Paint} paint */
  rect(x, y, w, h, paint) {
    if (paint && w > 0 && h > 0) this.add({ k: 'r', x, y, w, h, paint });
  }

  /** A straight rule. */
  line(x1, y1, x2, y2, color, width = 0.75, dash = null) {
    if (color && width > 0) this.add({ k: 'l', x1, y1, x2, y2, color, width, dash });
  }

  /**
   * @param {string} s
   * @param {number} x
   * @param {number} y  the baseline
   * @param {{ pick: import('./fonts.js').Pick, size: number, color: string, spacing?: number }} style  `size` is the size the page says, before the stand-in's scale
   */
  text(s, x, y, { pick, size, color, spacing = 0 }) {
    const drawn = size * pick.scale;
    this.add({ k: 't', s, x, y, f: `${pick.prefix}${drawn.toFixed(2)}px "${pick.alias}"`, color, ls: spacing });
    if (!this.quiet) {
      const count = s.trim().length;
      this.chars += count;
      const key = Math.round(size * 2) / 2;
      this.sizes.set(key, (this.sizes.get(key) || 0) + count);
    }
  }

  /** @param {PathCommand[]} path @param {{ fill?: Paint, stroke?: string, width?: number, dash?: number[]|null, cap?: string, join?: string, rule?: string, shadow?: any }} style */
  path(path, style) {
    this.add({ k: 'p', path, ...style });
  }

  /**
   * @param {string} part  the picture's name in the package
   * @param {{ x: number, y: number, w: number, h: number, crop?: number[]|null, alpha?: number }} place
   *   `crop` as fractions of the picture cut from left, top, right, bottom
   */
  picture(part, place) {
    this.pictures.add(part);
    this.add({ k: 'i', part, ...place });
  }

  save() { this.add({ k: 'S' }); }
  restore() { this.add({ k: 'R' }); }
  /** A transform, as the canvas takes it. */
  transform(a, b, c, d, e, f) { this.add({ k: 'T', a, b, c, d, e, f }); }
  clipRect(x, y, w, h) { this.add({ k: 'C', x, y, w, h }); }
  clipPath(path) { this.add({ k: 'P', path }); }

  /** The smallest size a real share of the text is set in: not one footnote, not a caption. */
  bodyPt() {
    if (!this.chars) return 0;
    const need = Math.max(24, this.chars * 0.12);
    const sizes = [...this.sizes.keys()].sort((a, b) => a - b);
    let held = 0;
    for (const size of sizes) {
      held += this.sizes.get(size);
      if (held >= need) return size;
    }
    return sizes[sizes.length - 1];
  }
}

/** A paint as the canvas wants it. Gradients are made here, with the scale already on the canvas. */
function paintOf(ctx, paint) {
  if (typeof paint === 'string') return paint;
  const gradient =
    paint.kind === 'linear'
      ? ctx.createLinearGradient(paint.x0, paint.y0, paint.x1, paint.y1)
      : ctx.createRadialGradient(paint.cx, paint.cy, 0, paint.cx, paint.cy, Math.max(0.01, paint.r));
  for (const [position, color] of paint.stops) gradient.addColorStop(clamp(position, 0, 1), color);
  return gradient;
}

function tracePath(ctx, path) {
  ctx.beginPath();
  for (const c of path) {
    switch (c[0]) {
      case 'M': ctx.moveTo(c[1], c[2]); break;
      case 'L': ctx.lineTo(c[1], c[2]); break;
      case 'C': ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); break;
      case 'Q': ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
      case 'E': ctx.ellipse(c[1], c[2], Math.max(0, c[3]), Math.max(0, c[4]), 0, c[5], c[6], !!c[7]); break;
      case 'Z': ctx.closePath(); break;
      default: break;
    }
  }
}

/**
 * Draw a page's operations onto a canvas already scaled to points.
 *
 * A measuring pass has no `pictures`: decoding every photo in a long report to work
 * out how full its pages are would be most of the cost, and a grey box measures the
 * same. The picture's name still goes into the page's signature, so two pages that
 * differ only in their photo are not taken for duplicates.
 *
 * @param {any} ctx
 * @param {any[]} ops
 * @param {{ pictures?: Map<string, any>|null, scale?: number, kerning?: string }} [options]
 */
export function replay(ctx, ops, { pictures = null, scale = 1, kerning = 'none' } = {}) {
  let font = null;
  let fill = null;
  ctx.textBaseline = 'alphabetic';
  ctx.fontKerning = kerning;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (const op of ops) {
    switch (op.k) {
      case 'r':
        fill = null;
        ctx.fillStyle = paintOf(ctx, op.paint);
        ctx.fillRect(op.x, op.y, op.w, op.h);
        break;
      case 't':
        if (font !== op.f) {
          ctx.font = op.f;
          font = op.f;
        }
        if (fill !== op.color) {
          ctx.fillStyle = op.color;
          fill = op.color;
        }
        if (op.ls) ctx.letterSpacing = `${op.ls}px`;
        ctx.fillText(op.s, op.x, op.y);
        if (op.ls) ctx.letterSpacing = '0px';
        break;
      case 'l':
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.setLineDash(op.dash || []);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(op.x1, op.y1);
        ctx.lineTo(op.x2, op.y2);
        ctx.stroke();
        break;
      case 'p':
        tracePath(ctx, op.path);
        if (op.shadow) {
          ctx.shadowColor = op.shadow.color;
          ctx.shadowBlur = op.shadow.blur * scale;
          ctx.shadowOffsetX = op.shadow.dx * scale;
          ctx.shadowOffsetY = op.shadow.dy * scale;
        }
        if (op.fill) {
          fill = null;
          ctx.fillStyle = paintOf(ctx, op.fill);
          ctx.fill(op.rule || 'nonzero');
        }
        if (op.shadow) {
          ctx.shadowColor = 'rgba(0,0,0,0)';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
        }
        if (op.stroke && op.width > 0) {
          ctx.strokeStyle = op.stroke;
          ctx.lineWidth = op.width;
          ctx.setLineDash(op.dash || []);
          ctx.lineCap = op.cap || 'butt';
          ctx.lineJoin = op.join || 'miter';
          ctx.stroke();
        }
        break;
      case 'i': {
        const image = pictures?.get(op.part);
        fill = null;
        if (!image) {
          ctx.fillStyle = '#C4C9CF';
          ctx.fillRect(op.x, op.y, op.w, op.h);
          break;
        }
        const previous = ctx.globalAlpha;
        if (op.alpha != null) ctx.globalAlpha = op.alpha;
        const [l, t, r, b] = op.crop || [0, 0, 0, 0];
        const sw = Math.max(1, image.width * (1 - l - r));
        const sh = Math.max(1, image.height * (1 - t - b));
        ctx.drawImage(image, image.width * l, image.height * t, sw, sh, op.x, op.y, op.w, op.h);
        ctx.globalAlpha = previous;
        break;
      }
      case 'S':
        ctx.save();
        break;
      case 'R':
        ctx.restore();
        font = null;
        fill = null;
        break;
      case 'T':
        ctx.transform(op.a, op.b, op.c, op.d, op.e, op.f);
        break;
      case 'C':
        ctx.beginPath();
        ctx.rect(op.x, op.y, op.w, op.h);
        ctx.clip();
        break;
      case 'P':
        tracePath(ctx, op.path);
        ctx.clip();
        break;
      default:
        break;
    }
  }
}

/* ── widths ─────────────────────────────────────────────────────────── */

/**
 * Text widths, at a size where hinting cannot round them, cached per word.
 *
 * The widths are a line-breaking fact, not a drawing one: asked at the page's own
 * size, a font hinted to whole pixels gives a different answer at each size, and a
 * line would break differently on the small measuring pass than on the picture.
 */
export class Measurer {
  /** @param {any} canvasApi @param {string} [kerning] Word and Excel set no kerning; PowerPoint does */
  constructor(canvasApi, kerning = 'none') {
    this.ctx = canvasApi.createCanvas(4, 4).getContext('2d');
    this.ctx.fontKerning = kerning;
    this.kerning = kerning;
    this.cache = new Map();
    this.font = null;
  }

  /**
   * The width of a word at size 1, before the stand-in's scale.
   *
   * @param {import('./fonts.js').Pick} pick
   * @param {string} text
   */
  unit(pick, text) {
    const css100 = `${pick.prefix}100px "${pick.alias}"`;
    const key = `${css100}|${text}`;
    let width = this.cache.get(key);
    if (width === undefined) {
      if (this.font !== css100) {
        this.ctx.font = css100;
        this.font = css100;
      }
      width = this.ctx.measureText(text).width / 100;
      this.cache.set(key, width);
    }
    return width;
  }

  /** @param {import('./fonts.js').Pick} pick @param {number} size @param {string} text */
  width(pick, size, text) {
    return this.unit(pick, text) * size * pick.scale;
  }
}

/* ── pictures ───────────────────────────────────────────────────────── */

/** What the canvas can decode. An EMF or a TIFF is not one of these, and is said to be a box instead. */
export const DRAWABLE_PICTURE = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** The pictures of one look: read and decoded only when a page that shows them is drawn. */
export class PicturePool {
  /** @param {any} canvasApi @param {any} zip @param {(text: string) => void} note */
  constructor(canvasApi, zip, note) {
    this.api = canvasApi;
    this.zip = zip;
    this.note = note;
    /** @type {Map<string, any>} */
    this.images = new Map();
    this.failed = new Set();
    this.pixels = 0;
  }

  /**
   * Have these ready for drawing. The size is read from the header first and a
   * picture that claims too much is never decoded: a few hundred bytes of PNG can
   * claim 60000×60000, and that memory is outside the worker's heap.
   *
   * @param {Iterable<string>} parts
   */
  async ensure(parts) {
    for (const part of parts) {
      if (this.images.has(part) || this.failed.has(part)) continue;
      try {
        const bytes = this.zip.read(part, LIMITS.imageBytes);
        const size = sniffPicture(bytes) ? pictureSize(bytes) : null;
        const pixels = size ? size.width * size.height : 0;
        if (!pixels || pixels > MAX_PIXELS || this.pixels + pixels > LIMITS.decodedPixels) {
          this.failed.add(part);
          this.note(pixels > MAX_PIXELS || this.pixels + pixels > LIMITS.decodedPixels
            ? 'A picture in the file was too large to open safely and appears as a grey box.'
            : 'A picture in the file could not be read and appears as a grey box.');
          continue;
        }
        const image = await this.api.loadImage(bytes);
        this.pixels += pixels;
        this.images.set(part, image);
      } catch (err) {
        if (err?.code === 'office_unreadable') throw err;
        this.failed.add(part);
        this.note('A picture in the file could not be read and appears as a grey box.');
      }
    }
    return this.images;
  }
}
