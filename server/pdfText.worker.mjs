/**
 * Reads a PDF's text off the request's thread (PERF-022).
 *
 * pdfjs parses on whatever thread calls it, and a hostile file — a content
 * stream that never ends, a compression bomb — can hold that thread for as long
 * as it likes. On the server that thread is every other request too. Here it is
 * a worker that `extractPdfText` (pdf.js) can stop after a deadline and that has
 * a heap of its own, so the worst a file can do is end its own read.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readPdfText } from './pdf.js';

const out = await readPdfText(Buffer.from(workerData.bytes)).then(
  (result) => ({ ok: true, result }),
  (err) => ({ ok: false, message: String(err?.message || err), code: err?.code || null }),
);
parentPort?.postMessage(out);
