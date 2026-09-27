/**
 * Copy and download, for a picture in the transcript.
 *
 * A chart, a diagram or a generated image is something people want to take
 * away — into a slide, a message, a report. The two buttons sit in the
 * picture's top-right corner and appear while it is pointed at (or focused from
 * the keyboard), the way every image viewer does it, so the picture is not
 * permanently covered by controls.
 *
 * An SVG is copied and downloaded as a PNG: that is what pastes into a chat, a
 * document or a slide. It is drawn at twice its size so it stays sharp, onto
 * the surface colour it was designed for — the chart's text is light, and a
 * transparent PNG pasted onto a white page would lose it.
 */
import { t } from './i18n.js';

const ICON_COPY =
  '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5H5.5A1.5 1.5 0 0 0 4 6v7.5" /></svg>';
const ICON_DONE =
  '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
  '<path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg>';
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<path d="M10 3.5v9M6 9l4 4 4-4M4 15.5h12" /></svg>';

/** The page's own background, so an exported picture keeps the ground it was drawn on. */
function surfaceColour() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev').trim();
  return value || '#12161c';
}

/**
 * An `<svg>` element as a PNG blob.
 *
 * Serialised from a clone given explicit pixel dimensions — a chart is drawn
 * `width="100%"`, which means nothing outside the page it sits in.
 */
export async function svgToPng(svg, { scale = 2, background = surfaceColour() } = {}) {
  const box = svg.viewBox?.baseVal;
  const rect = svg.getBoundingClientRect();
  const width = Math.round(box?.width || rect.width || 720);
  const height = Math.round(box?.height || rect.height || 360);

  const clone = /** @type {SVGSVGElement} */ (svg.cloneNode(true));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  // The live guide line and dimming are for reading on screen, not for keeping.
  clone.querySelectorAll('.chart__guide').forEach((n) => n.remove());
  clone.classList.remove('is-reading');

  const source = new globalThis.XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no image'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file-system-safe name from a caption. */
export function fileNameFrom(title, extension) {
  const base = String(title || 'image')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'image'}.${extension}`;
}

function iconButton(label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-tools__btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  return button;
}

/**
 * The corner toolbar.
 *
 * @param {{ blob: () => Promise<Blob>, name: string }} source  how to get the
 *   picture's bytes, asked only when a button is pressed, and what to call it.
 */
export function mediaTools({ blob, name }) {
  const bar = document.createElement('div');
  bar.className = 'media-tools';

  const copy = iconButton(t('media.copy'), ICON_COPY);
  copy.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      // The promise, not the blob: Safari only allows a clipboard write that
      // begins inside the click, and drawing the PNG takes a moment.
      const pending = blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]);
      copy.innerHTML = ICON_DONE;
      copy.title = t('media.copied');
      setTimeout(() => {
        copy.innerHTML = ICON_COPY;
        copy.title = t('media.copy');
      }, 1400);
    } catch {
      copy.title = t('media.copyFailed');
    }
  });

  const download = iconButton(t('media.download'), ICON_DOWNLOAD);
  download.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      const url = URL.createObjectURL(await blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      download.title = t('media.downloadFailed');
    }
  });

  bar.append(copy, download);
  return bar;
}

/** An image already on the server, as a PNG blob (clipboards take PNG, not JPEG). */
export async function imageUrlToPng(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'),
  );
}
