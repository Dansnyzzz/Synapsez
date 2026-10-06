import { streamCompletion } from './providers/index.js';
import { resolveModel, priceTurn } from './providers/catalog.js';
import { getApiKeys, providerPrivacyFor } from './settings.js';
import { getStore } from './store/index.js';
import { record as recordUsage } from './usage.js';
import { renderPdfPages } from './pdf.js';
import { ocrImage } from './ocr.js';
import { log } from './util/trace.js';

/**
 * Eyes for a model that has none.
 *
 * About half the model library reads text only, and most of the free models
 * people start on are in that half. A screenshot, a photo of a receipt, a
 * scanned PDF, the page a browser step just looked at — to one of those models
 * each is simply absent, and the best it could do was apologise and suggest
 * switching. This lends it a vision model for the moment it needs one: the
 * picture goes to a model that can see, what that model reads comes back as
 * words, and the conversation carries on on the model the person chose.
 *
 * **Which model looks, in order, all free and none needing a new key:**
 *
 *  1. The free vision models in the library — OpenRouter's and OrcaRouter's —
 *     ranked by family (below), each tried until one answers, through the key
 *     the account already holds for Auto. The library is refreshed daily, so
 *     this follows whatever is free this week rather than a list in the code.
 *  2. Gemini, only when the account happens to hold a Google key already. It
 *     reads a PDF as a PDF.
 *  3. Tesseract OCR (ocr.js), right here, with no key at all: the words only,
 *     but it always answers — including the day every free allowance is spent.
 *
 * A scanned PDF goes to Gemini whole; to anything else it is drawn page by page
 * (`renderPdfPages`) and sent as pictures.
 */

/**
 * The free vision families, best first, by how well they read small print and
 * dense screenshots. A family not named here still qualifies, after these.
 */
const PREFERENCE = [
  /gemini/i,
  // Checked against OpenRouter's free list on 2026-09-28: Qwen 3.8, Gemma 4,
  // Inkling, Nemotron Omni and dots were the free models that read images.
  /qwen[\w.-]*(vl|omni)|qwen3\.[5-9]/i,
  /gemma-4-31b|gemma-4/i,
  /dots[\w.-]*(ocr|note)/i,
  /inkling(?!-small)/i,
  /nemotron[\w.-]*(omni|vl)/i,
  /llama-4-maverick|mistral-(small|medium)|kimi[\w.-]*(vl|k2\.5)|glm-4\.\dv|internvl/i,
  /inkling-small|gemma-3|llama-4-scout/i,
];

/**
 * Never asked to look: a safety classifier is not a describer, and a router or
 * an unannounced "stealth" model is no promise of which model answers.
 */
const NOT_A_READER = /content-safety|guard|^openrouter\/(free|auto)$|^stealth\//i;

const rank = (id) => {
  const at = PREFERENCE.findIndex((re) => re.test(id));
  return at === -1 ? PREFERENCE.length : at;
};

/** How many library models to try before giving up on a picture. */
const MAX_TRIES = 4;

/** The free vision rows, read once every ten minutes rather than per picture. */
let freeRows = { at: 0, rows: [] };
async function freeVisionRows() {
  if (Date.now() - freeRows.at < 10 * 60 * 1000) return freeRows.rows;
  const rows = await getStore()
    .listSharedModels({ tier: 'free', limit: 600 })
    .catch(() => []);
  freeRows = { at: Date.now(), rows: rows.filter((r) => r.vision && !NOT_A_READER.test(String(r.model || ''))) };
  return freeRows.rows;
}

/**
 * Whether a picture may be lent to a model on `provider`, given the account's
 * provider-privacy choice (PRV-005).
 *
 * Strict is a promise that what the person sends goes only where nothing is kept
 * or trained on. `streamCompletion` keeps it for OpenRouter by asking for ZDR
 * endpoints, and nowhere else — OrcaRouter has no such switch, and a Google key
 * on the free tier is one whose content Google may use and have people read.
 * Lending eyes is the one path that sends a photo to a model the person did not
 * pick, so under strict it stays on OpenRouter or on the local OCR.
 */
export function lendableUnder(privacy, provider) {
  return privacy !== 'strict' || provider === 'openrouter';
}

/**
 * The models that could look at this for this account, best first — each one
 * only if the account can actually reach its provider.
 */
export async function visionEngines(userId) {
  // Unknown is strict, the same rule providerPrivacyFor follows (PRV-002).
  const privacy = await providerPrivacyFor(userId).catch(() => 'strict');
  const engines = [];
  const reach = new Map();
  const canReach = async (provider) => {
    if (!reach.has(provider)) reach.set(provider, (await getApiKeys(userId, provider).catch(() => [])).length > 0);
    return reach.get(provider);
  };

  // The free library models first, through the OpenRouter key the account
  // already holds for Auto — no second key to go and get.
  const rows = (await freeVisionRows())
    .slice()
    .sort((a, b) => rank(a.model) - rank(b.model) || (Number(b.context) || 0) - (Number(a.context) || 0));
  for (const row of rows) {
    if (engines.length >= MAX_TRIES) break;
    if (!lendableUnder(privacy, row.provider)) continue;
    if (!(await canReach(row.provider))) continue;
    try {
      engines.push(resolveModel(row.id, row));
    } catch {
      /* a row that no longer resolves is simply skipped */
    }
  }
  // Gemini only where a key happens to exist already; nobody is asked for one.
  if (lendableUnder(privacy, 'google') && (await canReach('google'))) engines.push(resolveModel('google/gemini-flash-latest'));
  return engines;
}

const SYSTEM =
  'You are the eyes of an assistant that cannot see. You are shown an image, a screenshot, or pages of a document, ' +
  'and your words are all it will ever know about them — so be complete and exact, never vague.\n' +
  '- Transcribe ALL visible text verbatim, in its original language and reading order: headings, labels, buttons, ' +
  'numbers, prices, dates, small print, handwriting (mark unclear words with [?]).\n' +
  '- Tables become Markdown tables. Charts: type, axes, every labelled value, and the trend.\n' +
  '- Screenshots of an app or web page: which app/site, the layout region by region, what is selected, open or in error.\n' +
  '- Photos: what and who is shown, setting, colours, notable details, and anything the viewer would be asked about.\n' +
  '- Math or code: write it exactly (LaTeX for formulas).\n' +
  'Describe only what is there; do not guess beyond it. If a question is given, first answer it directly, then give the full reading.';

/**
 * Look at pictures, or at a PDF, and say what is there.
 *
 * @param {{ userId: string, chatId?: string|null, images?: {mime: string, data: string, name?: string}[],
 *   pdf?: {data: string, name?: string, pages?: number[]}|null, question?: string, signal?: AbortSignal,
 *   stream?: Function, ocr?: (image: string) => Promise<{ text: string, confidence: number }> }} input
 * @returns {Promise<{ text: string, model: string }>}
 */
export async function see({ userId, chatId = null, images = [], pdf = null, question = '', signal, stream = streamCompletion, ocr = ocrImage }) {
  const engines = await visionEngines(userId).catch(() => []);

  /** Pages drawn once, shared by OCR and every engine that needs pictures. */
  let drawn = null;
  const failures = [];
  if (pdf) drawn = await renderPdfPages(pdf.data, { pages: pdf.pages || null, max: 8 }).catch(() => null);

  /**
   * OCR first, always — it needs nothing and takes well under a second once
   * warm. What it reads goes two places: to the vision model as a transcript to
   * check its reading against (vision models misread digits and drop a line of
   * small print; Tesseract does neither, but loses diacritics and understands
   * nothing), and, if no vision model answers, to the model on its own.
   */
  const pictures = [...images, ...(drawn?.pages || []).map((p) => ({ mime: p.mime, data: p.data, name: `page ${p.page}` }))];
  const ocrRead = [];
  let ocrError = null;
  for (const picture of pictures) {
    if (signal?.aborted) throw new Error('stopped');
    try {
      const { text, confidence } = await ocr(picture.data);
      if (text) ocrRead.push({ name: picture.name || 'image', text, confidence });
    } catch (err) {
      ocrError = String(err?.message || err).slice(0, 160);
      break;
    }
  }
  const ocrText = ocrRead.map((r) => (ocrRead.length > 1 ? `--- ${r.name} ---\n${r.text}` : r.text)).join('\n\n');
  const lowConfidence = ocrRead.some((r) => r.confidence < 70);

  for (const entry of engines) {
    const parts = [];
    if (pdf) {
      if (entry.provider === 'google') {
        parts.push({ type: 'document', name: pdf.name || 'document.pdf', mime: 'application/pdf', data: pdf.data });
      } else {
        if (!drawn?.pages?.length) {
          failures.push(`${entry.label}: the pages could not be drawn on this server`);
          continue;
        }
        for (const p of drawn.pages) parts.push({ type: 'image', name: `page ${p.page}`, mime: p.mime, data: p.data });
      }
    }
    for (const img of images) parts.push({ type: 'image', name: img.name || 'image', mime: img.mime, data: img.data });

    const pageNote = pdf && drawn?.pages?.length && entry.provider !== 'google'
      ? ` (pages ${drawn.pages.map((p) => p.page).join(', ')} of ${drawn.total})`
      : '';
    const prompt =
      (question ? `Question about it: ${question}\n\n` : '') +
      `Read ${pdf ? `this document${pageNote}` : images.length > 1 ? 'these images' : 'this image'} completely, as instructed.` +
      (ocrText
        ? '\n\nAn OCR engine already read the text in it, below. Its characters and digits are usually exact, but ' +
          'it drops accents and understands nothing: use it to get every number and word right, correct it where ' +
          'your own reading of the picture disagrees, and never copy an error you can see is one.\n' +
          `<ocr>\n${ocrText.slice(0, 12_000)}\n</ocr>`
        : '');

    try {
      let text = '';
      let usage = null;
      for await (const ev of stream({
        userId,
        entry,
        system: SYSTEM,
        messages: [{ id: `vision-${Date.now()}`, role: 'user', text: prompt, parts }],
        // Reading, not reasoning: the thinking budget goes on the picture's
        // words, not on deliberating about them.
        effort: 'low',
        signal,
      })) {
        if (ev.type === 'text') text += ev.delta ?? '';
        else if (ev.type === 'done') usage = ev.usage || null;
      }
      if (!text.trim()) throw new Error('it answered with nothing');
      if (usage && userId) {
        await recordUsage(userId, { chatId, model: entry.id, usage, costUsd: priceTurn(entry, usage)?.usd || 0, role: 'vision' }).catch(() => {});
      }
      return { text: text.trim(), model: entry.label || entry.id };
    } catch (err) {
      if (signal?.aborted) throw err;
      failures.push(`${entry.label || entry.id}: ${String(err?.message || err).slice(0, 160)}`);
      log.warn('vision engine failed', { model: entry.id, error: String(err?.message || err).slice(0, 200) });
    }
  }

  /**
   * No vision model answered: the OCR reading on its own. Words only, and said
   * so, so the model does not describe a picture it was only given the text of
   * — and a low-confidence reading says that too, so a doubtful figure is
   * checked rather than repeated.
   */
  if (ocrText) {
    return {
      text:
        'Text found in it by OCR (words only — layout, pictures and charts were not described' +
        `${failures.length ? '; no vision model could be reached' : ''}` +
        `${lowConfidence ? '; parts were hard to read, so treat unusual words and figures with care' : ''}):\n\n${ocrText}`,
      model: 'Tesseract OCR',
    };
  }
  failures.push(ocrError ? `OCR: ${ocrError}` : 'OCR: no text in it');
  throw new Error(`None of the models that can see could read it — ${failures.join('; ')}`);
}

/**
 * The words in a scan's pages, by OCR, for a model that is shown the pages
 * themselves: its exact figures beside its own look at them. Empty when there
 * is no text to find.
 *
 * @param {{ mime: string, data: string, page: number }[]} pages
 * @param {{ ocr?: (image: string) => Promise<{ text: string, confidence: number }>, signal?: AbortSignal }} [options]
 */
export async function ocrPages(pages, { ocr = ocrImage, signal } = {}) {
  const read = [];
  for (const page of pages || []) {
    if (signal?.aborted) break;
    const { text } = await ocr(page.data).catch(() => ({ text: '' }));
    if (text) read.push(`--- page ${page.page} ---\n${text}`);
  }
  return read.join('\n\n');
}

/**
 * Get the turn's files ready for a model that cannot take them as they are.
 *
 * Runs once per turn over the files about to be sent, before the transcript is
 * built, and leaves its answers on the rows for `toParts` to use:
 *
 * - an image, for a model that cannot see → `vision_text`, what a vision model
 *   read in it — stored on the file, so it is read once, not every turn;
 * - a scanned PDF (no text layer), for a model that cannot take a PDF:
 *     - if the model can see, `pageImages` — the pages drawn, to look at itself;
 *     - if it cannot, `vision_text` from a model that can.
 *
 * A failure is kept on the row (`visionFailed`), so the model is told why it
 * cannot see the file rather than being told nothing.
 *
 * @param {{ userId: string, chatId?: string|null, loaded: Map<string, any>, vision: boolean,
 *   documents: boolean, signal?: AbortSignal, onLooking?: (row: any) => void }} input
 */
export async function lendEyes({ userId, chatId = null, loaded, vision, documents, signal, onLooking = () => {} }) {
  if (vision && documents) return;
  for (const row of loaded.values()) {
    const blindImage = row.kind === 'image' && !vision;
    const scan = row.kind === 'document' && !documents && !row.text?.text;
    if (!blindImage && !scan) continue;

    if (scan && vision) {
      if (row.pageImages === undefined) {
        row.pageImages = (await renderPdfPages(row.data, { max: 8 }).catch(() => null))?.pages || null;
      }
      if (row.pageImages?.length) {
        // And the words on them, by OCR, once — kept on the file like any other
        // reading. The model looks at the pages; the transcript keeps it exact.
        if (!row.vision_text) {
          onLooking(row);
          const words = await ocrPages(row.pageImages, { signal }).catch(() => '');
          if (words) {
            row.vision_text = `[read by Tesseract OCR — words only, check against the pages]\n${words}`;
            await getStore().setAttachmentVisionText(userId, row.id, row.vision_text).catch(() => {});
          }
        }
        continue;
      }
      // Could not draw the pages here; fall through and let a model read it.
    }
    if (row.vision_text || row.visionFailed) continue;

    onLooking(row);
    try {
      const { text, model } = await see({
        userId,
        chatId,
        images: blindImage ? [{ mime: row.mime, data: row.data, name: row.name }] : [],
        pdf: blindImage ? null : { data: row.data, name: row.name },
        signal,
      });
      row.vision_text = `[read by ${model}]\n${text}`;
      await getStore().setAttachmentVisionText(userId, row.id, row.vision_text).catch(() => {});
    } catch (err) {
      if (signal?.aborted) throw err;
      row.visionFailed = String(err?.message || err);
    }
  }
}

export const __testing = { rank, PREFERENCE, NOT_A_READER, resetCache: () => (freeRows = { at: 0, rows: [] }) };
