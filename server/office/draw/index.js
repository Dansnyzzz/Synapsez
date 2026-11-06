/**
 * One look, from bytes to pictures.
 *
 * Lay every page out, measure each on a small canvas, ask the plan which pages share
 * a picture (`sheetPlan`, look.js), then draw only those, large. Laying out is cheap
 * enough to do for all of a long report; drawing all of it large would not be, and
 * decoding its photos even less, so a picture is only decoded when a page that shows
 * it is really going to the model.
 */
import { openZip, crc32 } from '../zip.js';
import { Budget, Measurer, PicturePool, countedZip, refused, replay } from './common.js';
import { Fonts } from './fonts.js';

/** One picture may be this large; past it, it is drawn again smaller. */
const MAX_JPEG_BYTES = 2.5 * 1024 * 1024;
const QUALITY = 82;
/** The measuring canvas: enough to tell ink from ground, small enough for three hundred pages. */
const PROBE_EDGE = 256;

const SHEET_GROUND = '#DDE1E6';
const STRIP_GROUND = '#27303B';

/** @param {string} unit @param {number} count */
const named = (unit, count) => `${unit[0].toUpperCase()}${unit.slice(1)}${count === 1 ? '' : 's'}`;

/** "1-3, 7 and 9", with runs of consecutive numbers folded. */
export function listNumbers(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Pages 1-2 of 8": what the strip says, and what the model refers to. */
function labelFor(unit, sheet, total, surfaces) {
  const pages = sheet.pages;
  if (unit === 'sheet' && sheet.cells.length === 1) {
    const surface = surfaces[sheet.cells[0].item];
    return `Sheet ${pages[0]} of ${total}: ${surface.label || ''}`.trim();
  }
  return `${named(unit, pages.length)} ${listNumbers(pages)} of ${total}`;
}

/** How full a page is, and a fingerprint of it, from a small drawing. */
function measurePage(surface, canvasApi, kerning) {
  const scale = PROBE_EDGE / Math.max(surface.width, surface.height);
  const w = Math.max(8, Math.round(surface.width * scale));
  const h = Math.max(8, Math.round(surface.height * scale));
  const canvas = canvasApi.createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.scale(w / surface.width, h / surface.height);
  replay(ctx, surface.ops, { scale, kerning });
  ctx.restore();
  const data = ctx.getImageData(0, 0, w, h).data;

  // The ground is whatever colour most of the page is: a dark slide has ink too.
  const counts = new Map();
  for (let i = 0; i < data.length; i += 16) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let ground = 0;
  let most = 0;
  for (const [key, count] of counts) {
    if (count > most) {
      most = count;
      ground = key;
    }
  }
  const gr = ((ground >> 10) & 31) << 3;
  const gg = ((ground >> 5) & 31) << 3;
  const gb = (ground & 31) << 3;
  let inked = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - gr) + Math.abs(data[i + 1] - gg) + Math.abs(data[i + 2] - gb) > 48) inked += 1;
  }
  const ink = inked / (w * h);

  // Exact duplicates only. The words and picture names go in as well as the pixels,
  // since two different photographs measure the same on this pass.
  const words = surface.ops.filter((op) => op.k === 't').map((op) => op.s).join('\u0001');
  const signature = `${crc32(Buffer.from(data.buffer, data.byteOffset, data.byteLength))}:${crc32(Buffer.from(words, 'utf8'))}:${[...surface.pictures].join('|')}`;
  return { ink, signature, hasPicture: surface.pictures.size > 0 };
}

/** Draw one planned picture and encode it, smaller if it comes out too large. */
async function drawSheet(sheet, surfaces, label, { canvasApi, pool, kerning, fonts, unit, strip, caption }) {
  const needed = new Set();
  for (const cell of sheet.cells) for (const part of surfaces[cell.item].pictures) needed.add(part);
  const pictures = await pool.ensure(needed);
  const canvas = canvasApi.createCanvas(sheet.width, sheet.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = SHEET_GROUND;
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  const stripFace = fonts.pick('Arial', true);
  ctx.fillStyle = STRIP_GROUND;
  ctx.fillRect(0, 0, sheet.width, strip);
  ctx.fillStyle = '#FFFFFF';
  ctx.textBaseline = 'middle';
  ctx.fontKerning = 'none';
  ctx.font = `bold 16px "${stripFace.alias}"`;
  // A sheet name can hold anything, so the label goes through the same coverage check as a page's words.
  let labelX = 12;
  for (const piece of fonts.pieces(label, stripFace)) {
    ctx.font = `bold 16px "${piece.pick.alias}"`;
    ctx.fillText(piece.text, labelX, strip / 2);
    labelX += ctx.measureText(piece.text).width;
  }

  const many = sheet.cells.length > 1;
  for (const cell of sheet.cells) {
    const surface = surfaces[cell.item];
    if (many) {
      const tag = unit === 'sheet' ? `Sheet ${cell.n}${surface.label ? `: ${surface.label}` : ''}` : `${named(unit, 1)} ${cell.n}`;
      ctx.fillStyle = '#374151';
      ctx.textBaseline = 'alphabetic';
      let tagX = cell.x;
      const face = fonts.pick('Arial', true);
      for (const piece of fonts.pieces(tag, face)) {
        ctx.font = `bold 13px "${piece.pick.alias}"`;
        ctx.fillText(piece.text, tagX, cell.y - 5);
        tagX += ctx.measureText(piece.text).width;
      }
      void caption;
    }
    ctx.fillStyle = '#9AA3AD';
    ctx.fillRect(cell.x - 1, cell.y - 1, cell.width + 2, cell.height + 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.width, cell.height);
    ctx.clip();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
    ctx.translate(cell.x, cell.y);
    const sx = cell.width / surface.width;
    const sy = cell.height / surface.height;
    ctx.scale(sx, sy);
    replay(ctx, surface.ops, { pictures, scale: sx, kerning });
    ctx.restore();
  }

  let jpeg = await canvas.encode('jpeg', QUALITY);
  for (const quality of [72, 62, 52]) {
    if (jpeg.length <= MAX_JPEG_BYTES) break;
    jpeg = await canvas.encode('jpeg', quality);
  }
  let { width, height } = sheet;
  if (jpeg.length > MAX_JPEG_BYTES) {
    // A picture of nothing but photographs and noise: smaller is the only way left.
    const k = Math.sqrt(MAX_JPEG_BYTES / jpeg.length) * 0.95;
    width = Math.round(width * k);
    height = Math.round(height * k);
    const smaller = canvasApi.createCanvas(width, height);
    const paint = smaller.getContext('2d');
    paint.imageSmoothingQuality = 'high';
    paint.drawImage(canvas, 0, 0, width, height);
    jpeg = await smaller.encode('jpeg', 72);
  }
  return { mime: 'image/jpeg', data: Buffer.from(jpeg).toString('base64'), width, height, label, pages: sheet.pages };
}

/** Lay the file out, whichever format it is. Modules load by literal path, for the tracer. */
async function layout(format, zip, tools, pages) {
  if (format === 'pptx') {
    const { layoutPptx } = await import('./pptx.js');
    return layoutPptx(zip, tools, { pages });
  }
  if (format === 'docx') {
    const { layoutDocx } = await import('./docx.js');
    return layoutDocx(zip, tools);
  }
  const { layoutXlsx } = await import('./xlsx.js');
  return layoutXlsx(zip, tools, { pages });
}

/** What every drawing needs, from bytes: the file opened and the tools to measure with. */
function opened(bytes, canvasApi, timeoutMs, kerning) {
  const fonts = new Fonts(canvasApi);
  if (!fonts.usable()) return null;
  const budget = new Budget(timeoutMs);
  const notes = new Set();
  const note = (text) => notes.add(text);
  let zip;
  try {
    zip = countedZip(openZip(bytes), budget);
  } catch (err) {
    if (err?.code === 'encrypted') throw refused('That file is password-protected, so it cannot be drawn.');
    throw refused(`That file could not be opened: ${err?.message || err}`);
  }
  return { zip, notes, tools: { fonts, measure: new Measurer(canvasApi, kerning), budget, note, canvasApi } };
}

/** A surface on a canvas of its own, its pictures decoded, ready to encode. */
async function paintSurface(surface, zip, tools, canvasApi, kerning, edge) {
  const scale = Math.min(edge / Math.max(surface.width, surface.height), 4);
  const canvas = canvasApi.createCanvas(Math.max(1, Math.round(surface.width * scale)), Math.max(1, Math.round(surface.height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  const pool = new PicturePool(canvasApi, zip, tools.note);
  const pictures = await pool.ensure(new Set(surface.pictures));
  replay(ctx, surface.ops, { pictures, scale, kerning });
  return canvas;
}

/**
 * One page or slide, by itself and nothing round it: what a viewer shows.
 *
 * @param {Buffer} bytes
 * @param {{ name?: string, page?: number, edge?: number, timeoutMs?: number }} options
 * @param {any} canvasApi
 * @param {{ lookableFormat: Function }} plan
 */
export async function drawPage(bytes, { name = '', page = 1, edge = 1600, timeoutMs = 45_000 } = {}, canvasApi, { lookableFormat }) {
  const format = lookableFormat(name, bytes);
  if (!format || format === 'xlsx') throw refused('That is not a Word or PowerPoint file this can draw.');
  const kerning = format === 'pptx' ? 'normal' : 'none';
  const ready = opened(bytes, canvasApi, timeoutMs, kerning);
  if (!ready) return null;
  const wanted = Math.max(1, Math.floor(Number(page) || 1));
  try {
    const doc = await layout(format, ready.zip, ready.tools, [wanted]);
    const surface = doc.pages.find((s) => s.number === wanted);
    if (!surface) return { total: doc.total, missing: true };
    const canvas = await paintSurface(surface, ready.zip, ready.tools, canvasApi, kerning, edge);
    let jpeg = await canvas.encode('jpeg', QUALITY);
    for (const quality of [72, 62]) {
      if (jpeg.length <= MAX_JPEG_BYTES) break;
      jpeg = await canvas.encode('jpeg', quality);
    }
    return { mime: 'image/jpeg', data: Buffer.from(jpeg).toString('base64'), width: canvas.width, height: canvas.height, total: doc.total, notes: [...ready.notes] };
  } catch (err) {
    if (err?.code === 'office_unreadable') throw err;
    throw refused(`That file could not be drawn: ${err?.message || err}`);
  }
}

/**
 * @param {Buffer} bytes
 * @param {{ sheet?: number, from?: number, timeoutMs?: number }} options
 * @param {any} canvasApi
 */
export async function drawWorkbookModel(bytes, { sheet = 1, from = 0, timeoutMs = 45_000 } = {}, canvasApi) {
  const ready = opened(bytes, canvasApi, timeoutMs, 'none');
  if (!ready) return null;
  try {
    const { workbookModel } = await import('./xlsx.js');
    const model = await workbookModel(ready.zip, ready.tools, { sheet, from });
    return { ...model, notes: [...ready.notes] };
  } catch (err) {
    if (err?.code === 'office_unreadable') throw err;
    throw refused(`That file could not be read: ${err?.message || err}`);
  }
}

/**
 * @param {Buffer} bytes
 * @param {{ sheet?: number, index?: number, edge?: number, timeoutMs?: number }} options
 * @param {any} canvasApi
 */
export async function drawDrawing(bytes, { sheet = 1, index = 0, edge = 1600, timeoutMs = 45_000 } = {}, canvasApi) {
  const ready = opened(bytes, canvasApi, timeoutMs, 'none');
  if (!ready) return null;
  try {
    const { drawingSurface } = await import('./xlsx.js');
    const drawn = await drawingSurface(ready.zip, ready.tools, { sheet, index });
    if (!drawn) return { missing: true };
    const canvas = await paintSurface(drawn.surface, ready.zip, ready.tools, canvasApi, 'none', edge);
    return { mime: 'image/png', data: Buffer.from(await canvas.encode('png')).toString('base64'), width: canvas.width, height: canvas.height };
  } catch (err) {
    if (err?.code === 'office_unreadable') throw err;
    throw refused(`That file could not be drawn: ${err?.message || err}`);
  }
}

/**
 * @param {Buffer} bytes
 * @param {{ name?: string, pages?: number[]|null, maxSheets?: number, timeoutMs?: number }} options
 * @param {any} canvasApi
 * @param {{ lookableFormat: Function, sheetPlan: Function, strip: number, caption: number }} plan
 */
export async function drawLook(bytes, { name = '', pages = null, maxSheets = 6, timeoutMs = 45_000 } = {}, canvasApi, { lookableFormat, sheetPlan, strip, caption }) {
  const format = lookableFormat(name, bytes);
  if (!format) throw refused('That is not a Word, Excel or PowerPoint file this can draw.');
  const fonts = new Fonts(canvasApi);
  if (!fonts.usable()) return null;

  const budget = new Budget(timeoutMs);
  const notes = new Set();
  const note = (text) => notes.add(text);
  let zip;
  try {
    zip = countedZip(openZip(bytes), budget);
  } catch (err) {
    if (err?.code === 'encrypted') throw refused('That file is password-protected, so it cannot be drawn.');
    throw refused(`That file could not be opened: ${err?.message || err}`);
  }

  try {
    const kerning = format === 'pptx' ? 'normal' : 'none';
    const measure = new Measurer(canvasApi, kerning);
    const tools = { fonts, measure, budget, note, canvasApi };
    const asked = Array.isArray(pages) ? [...new Set(pages.map(Number).filter((n) => Number.isInteger(n) && n >= 1))] : null;

    let doc = await layout(format, zip, tools, asked);
    let valid = asked?.length ? asked.filter((n) => n <= doc.total) : null;
    if (asked?.length) {
      const absent = asked.filter((n) => n > doc.total);
      if (absent.length) note(`There is no ${doc.unit} ${listNumbers(absent)}; this file has ${doc.total}.`);
    }
    if (asked?.length && !valid.length) {
      doc = await layout(format, zip, tools, null);
      valid = null;
    }
    const { unit, total, pages: laid } = doc;
    if (!laid.length) throw refused(`That file has no ${unit}s to draw.`);

    /** @type {any[]} */
    let surfaces = laid;
    if (valid?.length) {
      const order = new Map(valid.map((n, i) => [n, i]));
      surfaces = laid.filter((s) => order.has(s.number)).sort((a, b) => order.get(a.number) - order.get(b.number) || (a.part || 0) - (b.part || 0));
    }

    const seen = new Map();
    const items = surfaces.map((surface) => {
      budget.check();
      const measured = measurePage(surface, canvasApi, kerning);
      const blank = !surface.chars && !surface.pictures.size && measured.ink < 0.0008;
      let duplicateOf = null;
      if (!blank && !surface.part) {
        if (seen.has(measured.signature)) duplicateOf = seen.get(measured.signature);
        else seen.set(measured.signature, surface.number);
      }
      return {
        n: surface.number,
        unit,
        part: surface.part || 0,
        width: surface.width,
        height: surface.height,
        ink: measured.ink,
        bodyPt: surface.bodyPt(),
        chars: surface.chars,
        tableCells: surface.tableCells,
        hasPicture: measured.hasPicture,
        blank,
        duplicateOf,
      };
    });

    const plan = sheetPlan(items, { maxSheets, asked: !!valid?.length });
    const unitName = unit === 'sheet' ? 'worksheet' : unit;
    if (plan.blank.length) note(`${named(unitName, plan.blank.length)} ${listNumbers(plan.blank)} ${plan.blank.length === 1 ? 'is' : 'are'} blank and not shown.`);
    for (const { n, of } of plan.duplicates.slice(0, 12)) note(`${named(unitName, 1)} ${n} is an exact duplicate of ${unitName} ${of} and is not shown.`);
    if (plan.duplicates.length > 12) note(`${plan.duplicates.length - 12} more ${unitName}s are exact duplicates of earlier ones and are not shown.`);
    if (plan.skipped.length) {
      note(`This is ${valid?.length ? 'part of what was asked for' : 'an overview'}: ${named(unitName, plan.shown.length).toLowerCase()} ${listNumbers(plan.shown)} of ${total} ${plan.shown.length === 1 ? 'is' : 'are'} shown. Ask for ${unitName}s ${listNumbers(plan.skipped)} by number to see them.`);
    }
    for (const { n, shown: drawn, of } of plan.partial) note(`Worksheet ${n} needed ${of} pictures and only ${drawn} ${drawn === 1 ? 'was' : 'were'} sent, so the rest of its rows are not shown; its text can still be read.`);

    const pool = new PicturePool(canvasApi, zip, note);
    const context = { canvasApi, pool, kerning, fonts, unit, strip, caption };
    const sheets = [];
    for (const sheet of plan.sheets) {
      budget.check();
      sheets.push(await drawSheet(sheet, surfaces, labelFor(unit, sheet, total, surfaces), context));
    }
    for (const text of fonts.notes()) note(text);
    return { format, unit, total, shown: plan.shown, skipped: plan.skipped, sheets, notes: [...notes] };
  } catch (err) {
    if (err?.code === 'office_unreadable') throw err;
    throw refused(`That file could not be drawn: ${err?.message || err}`);
  }
}
