/**
 * Reads a spreadsheet with SheetJS off the request's thread.
 *
 * The fallback reader parses whatever it is handed — an old binary .xls, a
 * zipped .ods — and a hostile file can hold the thread that parses it or fill
 * its heap. Here that thread is a worker `readSheetsElsewhere` (sheets.js) can
 * stop after a deadline, with a heap of its own, the same as a PDF's text
 * (pdfText.worker.mjs).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readSheetsWithSheetJS } from './sheetjs.js';

const out = await readSheetsWithSheetJS(Buffer.from(workerData.bytes)).then(
  (result) => ({ ok: true, result }),
  (err) => ({ ok: false, message: String(err?.message || err), code: err?.code || null }),
);
parentPort?.postMessage(out);
