/**
 * The surface every title creature and every prop is drawn on (owner, 2026-11-08):
 * a 64×64 grid of whole pixels, painted into a buffer and then handed to a canvas as
 * runs of one colour. Nothing here touches the page, so the same frame can be drawn
 * in a browser or checked in Node.
 *
 * Why a buffer and not the canvas straight away: a 1-px outline all round a shape is
 * what makes this style read, and it is a question about neighbours ("is the pixel
 * beside this one inside?"), which a canvas cannot answer cheaply. It also means
 * nothing can ever be drawn between two pixels, or in a colour nobody chose.
 */

export const SIZE = 64;

/**
 * The colours every creature's props share. A creature brings its own body colours;
 * a sign, a badge or a cloud looks the same on all of them.
 */
export const ACCENTS = Object.freeze({
  yellow: '#ffd447',
  red: '#ff4d5e',
  darkRed: '#b81e36',
  pink: '#ff8fb8',
  violet: '#9d7bff',
  green: '#35d07f',
  lightCyan: '#7fdbff',
  cyan: '#34a8ff',
  orange: '#ff8a3d',
  amber: '#f2a20c',
  grey: '#a7b0cc',
  slate: '#5b6488',
  navy: '#222a4e',
  white: '#ffffff',
});

/** Room either side of the grid a mask may reach before being cut off when drawn. */
const PAD = 128;
const WIDE = 512;
const keyOf = (x, y) => (y + PAD) * WIDE + (x + PAD);

/** A set of grid pixels: a body, a fin, a cloud. Shapes are built from these, then painted. */
export class Mask {
  constructor() {
    /** @type {Set<number>} */
    this.keys = new Set();
  }

  /** @param {number} x @param {number} y */
  add(x, y) {
    this.keys.add(keyOf(x, y));
    return this;
  }

  /** @param {number} x @param {number} y */
  has(x, y) {
    return this.keys.has(keyOf(x, y));
  }

  /** @param {number} x @param {number} y */
  remove(x, y) {
    this.keys.delete(keyOf(x, y));
    return this;
  }

  /** One row, both ends included. @param {number} y @param {number} x0 @param {number} x1 */
  span(y, x0, x1) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) this.add(x, y);
    return this;
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h */
  rect(x, y, w, h) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.add(x + i, y + j);
    return this;
  }

  /**
   * Every pixel whose centre is inside a rounded box: power 2 is an ellipse, higher
   * is squarer. Measured at pixel centres, so a whole or half centre gives a shape
   * that is the same on both sides.
   *
   * @param {number} cx @param {number} cy @param {number} rx @param {number} ry @param {number} [power]
   */
  blob(cx, cy, rx, ry, power = 2) {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y += 1) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x += 1) {
        const u = Math.abs((x + 0.5 - cx) / rx);
        const v = Math.abs((y + 0.5 - cy) / ry);
        if (u ** power + v ** power <= 1) this.add(x, y);
      }
    }
    return this;
  }

  /** Rows from a picture: any character but '.' or ' ' is inside. @param {number} x @param {number} y @param {string[]} rows */
  rows(x, y, rows) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i += 1) if (row[i] !== '.' && row[i] !== ' ') this.add(x + i, y + j);
    });
    return this;
  }

  /** @param {Mask} other */
  merge(other) {
    for (const key of other.keys) this.keys.add(key);
    return this;
  }

  /** @param {Mask} other */
  cut(other) {
    for (const key of other.keys) this.keys.delete(key);
    return this;
  }

  /** What both hold, as a new mask. @param {Mask} other */
  and(other) {
    const out = new Mask();
    for (const key of this.keys) if (other.keys.has(key)) out.keys.add(key);
    return out;
  }

  /** A moved copy. @param {number} dx @param {number} dy */
  shift(dx, dy) {
    const out = new Mask();
    for (const [x, y] of this) out.add(x + dx, y + dy);
    return out;
  }

  /** A copy turned left for right about column `axis` (a pixel at axis stays). @param {number} axis */
  flip(axis) {
    const out = new Mask();
    for (const [x, y] of this) out.add(2 * axis - x, y);
    return out;
  }

  /**
   * The pixels along one side of the shape: those whose neighbour `dx, dy` away is
   * outside it. (-2, 1) is a band two wide along the lower left.
   *
   * @param {number} dx @param {number} dy
   */
  edge(dx, dy) {
    const out = new Mask();
    for (const [x, y] of this) if (!this.has(x + dx, y + dy)) out.add(x, y);
    return out;
  }

  /** The pixels just outside, side by side with one inside: the 1-px outline, stepping round curves. */
  ring() {
    const out = new Mask();
    for (const [x, y] of this) {
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) if (!this.has(nx, ny)) out.add(nx, ny);
    }
    return out;
  }

  /** The pixels just inside the edge: a highlight or a rim. */
  inner() {
    const out = new Mask();
    for (const [x, y] of this) {
      if (!this.has(x - 1, y) || !this.has(x + 1, y) || !this.has(x, y - 1) || !this.has(x, y + 1)) out.add(x, y);
    }
    return out;
  }

  /** @returns {{ x0: number, y0: number, x1: number, y1: number } | null} */
  bounds() {
    let box = null;
    for (const [x, y] of this) {
      if (!box) box = { x0: x, y0: y, x1: x, y1: y };
      else {
        box.x0 = Math.min(box.x0, x);
        box.x1 = Math.max(box.x1, x);
        box.y0 = Math.min(box.y0, y);
        box.y1 = Math.max(box.y1, y);
      }
    }
    return box;
  }

  get size() {
    return this.keys.size;
  }

  /** @returns {Generator<[number, number]>} */
  *[Symbol.iterator]() {
    // Sorted, so anything walking a mask does it in the same order every time.
    for (const key of [...this.keys].sort((a, b) => a - b)) yield [(key % WIDE) - PAD, Math.floor(key / WIDE) - PAD];
  }
}

/** One frame being drawn. */
export class Pixels {
  constructor(size = SIZE) {
    this.size = size;
    /** @type {(string|null)[]} */
    this.cells = new Array(size * size).fill(null);
    /** Pixels that fell off the grid. A test holds every frame of every creature to none. */
    this.clipped = 0;
  }

  /** @param {number} x @param {number} y */
  at(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size ? this.cells[y * this.size + x] : null;
  }

  /** @param {number} x @param {number} y @param {string|null|undefined} colour */
  px(x, y, colour) {
    if (!colour) return;
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`Not a whole pixel: ${x}, ${y}`);
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) {
      this.clipped += 1;
      return;
    }
    this.cells[y * this.size + x] = colour;
  }

  /** Only where nothing is yet: a shadow goes under what stands on it. @param {number} x @param {number} y @param {string} colour */
  under(x, y, colour) {
    if (x >= 0 && y >= 0 && x < this.size && y < this.size && this.cells[y * this.size + x]) return;
    this.px(x, y, colour);
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {string} colour */
  rect(x, y, w, h, colour) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.px(x + i, y + j, colour);
  }

  /** @param {Iterable<[number, number]>} points @param {string} colour */
  dots(points, colour) {
    for (const [x, y] of points) this.px(x, y, colour);
  }

  /** @param {Mask} mask @param {string} colour */
  fill(mask, colour) {
    for (const [x, y] of mask) this.px(x, y, colour);
  }

  /**
   * A shape with its outline: the outline first, over whatever is there, so a fin laid
   * on a body is parted from it by a line, then the inside.
   *
   * @param {Mask} mask @param {string} fill @param {string} outline
   */
  shape(mask, fill, outline) {
    this.fill(mask.ring(), outline);
    this.fill(mask, fill);
  }

  /**
   * A small picture typed out: each character picks a colour from `key`, '.' leaves the
   * pixel alone. `flip` draws it mirrored, for the same thing facing the other way.
   *
   * @param {number} x @param {number} y @param {string[]} rows @param {Record<string, string>} key @param {boolean} [flip]
   */
  sprite(x, y, rows, key, flip = false) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i += 1) {
        const colour = key[row[i]];
        if (colour) this.px(flip ? x + row.length - 1 - i : x + i, y + j, colour);
      }
    });
  }

  /** Every colour in the frame. */
  colours() {
    return new Set(this.cells.filter(Boolean));
  }

  /** The frame as text, to compare two of them. */
  print() {
    return this.cells.map((c) => c || '-').join(',');
  }

  /**
   * Onto a canvas, one rectangle per run of one colour along a row. The context is in
   * grid units: whoever owns the canvas scales it by a whole number first.
   *
   * @param {{ fillStyle: any, fillRect: (x: number, y: number, w: number, h: number) => void }} ctx
   */
  flush(ctx) {
    const { size, cells } = this;
    for (let y = 0; y < size; y += 1) {
      let x = 0;
      while (x < size) {
        const colour = cells[y * size + x];
        if (!colour) {
          x += 1;
          continue;
        }
        let end = x + 1;
        while (end < size && cells[y * size + end] === colour) end += 1;
        ctx.fillStyle = colour;
        ctx.fillRect(x, y, end - x, 1);
        x = end;
      }
    }
  }
}
