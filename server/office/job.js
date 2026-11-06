import { onWorker } from './look.js';
import { runJob } from './edit.js';

const JOB_MS = 25_000;

/**
 * Read or change an Office file on a worker that can be stopped.
 *
 * @param {'editWorkbook'|'editDocument'|'readWorkbookCells'|'readDocumentWords'} job
 * @param {Buffer} bytes
 * @param {any[]} [args]
 * @param {{ timeoutMs?: number, workerUrl?: URL }} [options]
 * @returns {Promise<any>} what the job returns; a `buffer` in it comes back as a Buffer
 */
export async function officeJob(job, bytes, args = [], { timeoutMs = JOB_MS, workerUrl = new URL('./job.worker.mjs', import.meta.url) } = {}) {
  const out = await onWorker(workerUrl, { job, bytes: Uint8Array.from(bytes), args }, {
    timeoutMs,
    here: async () => runJob(job, bytes, args),
    late: `That file took longer than ${Math.round(timeoutMs / 1000)}s to read, so it was stopped.`,
  });
  return out?.buffer ? { ...out, buffer: Buffer.from(out.buffer) } : out;
}
