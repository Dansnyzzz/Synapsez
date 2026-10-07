/**
 * Draws a scanned PDF's pages off the request's thread (PERF-023).
 *
 * pdfjs draws on whatever thread calls it, and a crafted scan can hold that
 * thread for as long as it likes; on the server that thread is every other
 * request too. Here it is a worker `renderPdfPages` (pdf.js) can stop after a
 * deadline, with a heap of its own. A null result — the native canvas would not
 * load in a worker — sends the caller back to drawing on its own thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { drawPdfPagesHere } from './pdf.js';

const out = await drawPdfPagesHere(Buffer.from(workerData.bytes), workerData.options || {}).then(
  (result) => ({ ok: true, result }),
  (err) => ({ ok: false, message: String(err?.message || err), code: err?.code || null }),
);
parentPort?.postMessage(out);
