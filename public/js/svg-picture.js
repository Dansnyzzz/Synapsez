/**
 * A drawing a model wrote, made into something an <img> will draw — and into a PNG.
 *
 * An <img> draws an SVG only when it is strict XML in the SVG namespace, and what a model
 * writes often is not: no `xmlns`, an HTML entity such as `&nbsp;`, a bare `&`, a tag
 * left open. So the markup is read the way a browser reads a page, put right, and
 * written out again as XML, rather than handed to the <img> as it came.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK = { width: 800, height: 600 };

/**
 * The drawing as a well-formed element, or null when the text holds none.
 *
 * Strict first, because that keeps a good file exactly as written; the lenient reading is
 * only for what the strict one rejects, which includes a root with no namespace. That one
 * is read as a page, where the browser puts every `<svg>` in the SVG namespace itself, and
 * the serializer then writes the `xmlns` (and `xmlns:xlink` where a link is used) that an
 * <img> needs.
 *
 * @param {string} markup
 * @returns {Element | null}
 */
function parse(markup) {
  const text = String(markup || '');
  if (!text.trim()) return null;
  const strict = new globalThis.DOMParser().parseFromString(text, 'image/svg+xml');
  if (!strict.querySelector('parsererror') && strict.documentElement?.namespaceURI === SVG_NS && strict.documentElement.localName === 'svg') return strict.documentElement;
  return new globalThis.DOMParser().parseFromString(text, 'text/html').querySelector('svg');
}

/**
 * Nothing in it that runs or fetches.
 *
 * An <img> would run and fetch nothing of this anyway; the point is that the PNG made from
 * the same markup, and anything that later reuses it, match what is shown.
 *
 * @param {Element} root
 */
function clean(root) {
  for (const bad of root.querySelectorAll('script, foreignObject')) bad.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (attr.localName.toLowerCase() === 'href' && !/^\s*(#|data:image\/)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

/**
 * A length that is a plain number of pixels, or 0 when it is missing or relative.
 *
 * @param {string | null} value
 */
function pixels(value) {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:px)?\s*$/i.exec(String(value || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Give it a size, because an <img> with a `viewBox` and no size has a natural size of 0.
 *
 * @param {Element} root
 * @returns {{ width: number, height: number }}
 */
function size(root) {
  const box = String(root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const view = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null;
  let width = pixels(root.getAttribute('width'));
  let height = pixels(root.getAttribute('height'));
  if (!width && !height) ({ width, height } = view || FALLBACK);
  else if (!width) width = view ? (height * view.width) / view.height : FALLBACK.width;
  else if (!height) height = view ? (width * view.height) / view.width : FALLBACK.height;
  root.setAttribute('width', String(Math.round(width * 100) / 100));
  root.setAttribute('height', String(Math.round(height * 100) / 100));
  return { width, height };
}

/**
 * The drawing, ready to load into an <img>.
 *
 * Callers revoke the URL after the image loads or fails. It is never put anywhere a person
 * can open it in a tab: a blob: URL is of this origin, and the markup is a stranger's.
 *
 * @param {string} markup
 * @returns {Promise<{ url: string, width: number, height: number } | null>}
 */
export async function svgPicture(markup) {
  let root;
  try {
    root = parse(markup);
  } catch {
    return null;
  }
  if (!root) return null;
  clean(root);
  const { width, height } = size(root);
  const xml = new globalThis.XMLSerializer().serializeToString(root);
  return { url: URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' })), width, height };
}

/**
 * The drawing as a PNG on a solid ground, for the clipboard.
 *
 * A transparent PNG pasted into a dark editor loses its black lines, and most of what is
 * pasted into goes on white.
 *
 * @param {string} markup
 * @param {{ width?: number, background?: string }} [options]
 * @returns {Promise<Blob>}
 */
export async function svgToPng(markup, { width = 2400, background = '#ffffff' } = {}) {
  const picture = await svgPicture(markup);
  if (!picture) throw new Error('not a drawing');
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('unreadable'));
      img.src = picture.url;
    });
    // No larger than a phone's browser will draw: Safari refuses a canvas past about
    // 16.7 million pixels (as in render.js `drawDiagram`).
    const fit = Math.min(1, Math.sqrt(16_000_000 / (width * ((width * picture.height) / picture.width))));
    const w = Math.max(1, Math.round(width * fit));
    const h = Math.max(1, Math.round((width * fit * picture.height) / picture.width));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(picture.url);
  }
}
