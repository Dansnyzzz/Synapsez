/**
 * Every spreadsheet a person might send, read into one shape.
 *
 * The in-house reader (`xlsx.js`) goes first for an Open XML workbook — no
 * dependency, no thread. Anything it cannot read, and any workbook it gives up
 * on, goes to SheetJS (`sheetjs.js`) on a worker with a deadline and a heap cap,
 * so an old `.xls`, an `.xlsb`, an `.ods` or a workbook written by an unusual
 * tool is read rather than reported to the model as "nothing could be read" —
 * which is what a student's accounting workbook came back as (owner,
 * 2026-10-06).
 */
import { Worker } from 'node:worker_threads';
import { readSheetsWithSheetJS } from './sheetjs.js';

/** How long the fallback reader may take, and how much heap it may hold. */
const SHEET_MS = 30_000;
const SHEET_HEAP_MB = 512;

/** A worker that could not load its own code is the deployment, not the file. */
const WORKER_LOAD = /ERR_MODULE_NOT_FOUND|ERR_WORKER_PATH|ERR_WORKER_INIT_FAILED|Cannot find module/;

/**
 * Read a spreadsheet with the fallback reader, off this thread.
 *
 * Where no worker can start — or its code is missing from the bundle — it reads
 * on this thread instead, with no deadline or heap of its own: a hostile file
 * can then cost what it would have cost here before any of this existed. Upload
 * size limits bound it; the worker is what makes it safe.
 *
 * @param {Buffer} buffer
 * @param {{ timeoutMs?: number, workerUrl?: URL }} [options] `workerUrl` is for
 *   tests, which stand in a worker whose code cannot be loaded.
 */
export async function readSheetsElsewhere(buffer, { timeoutMs = SHEET_MS, workerUrl = new URL('./sheet.worker.mjs', import.meta.url) } = {}) {
  let worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: { bytes: Uint8Array.from(buffer) },
      resourceLimits: { maxOldGenerationSizeMb: SHEET_HEAP_MB },
    });
  } catch {
    return readSheetsWithSheetJS(buffer);
  }
  const failed = (message, code = 'unreadable') => Object.assign(new Error(message), { code });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, failed(`That spreadsheet took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s to read, so reading it was stopped.`)),
      timeoutMs,
    );
    worker.once('message', (out) => {
      if (out?.ok) finish(resolve, out.result);
      else finish(reject, failed(out?.message || 'That spreadsheet could not be read.', out?.code || 'unreadable'));
    });
    worker.once('error', (err) => {
      if (!settled && WORKER_LOAD.test(`${err?.code} ${err?.message}`)) {
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        readSheetsWithSheetJS(buffer).then(resolve, reject);
        return;
      }
      finish(reject, failed(`That spreadsheet could not be read: ${err?.message || err}`));
    });
    worker.once('exit', (code) => finish(reject, failed(`That spreadsheet could not be read: its reader stopped (${code}).`)));
  });
}
