/**
 * Reads or changes an Office file off the request's thread, for the reason
 * look.worker.mjs does: these files can come from strangers, and the work takes as
 * long as the file says. See job.js.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runJob } from './edit.js';

const out = await Promise.resolve()
  .then(() => runJob(workerData.job, Buffer.from(workerData.bytes), workerData.args || []))
  .then(
    (result) => ({ ok: true, result }),
    (err) => ({ ok: false, message: String(err?.message || err), code: err?.code || 'office_unreadable' }),
  );
parentPort?.postMessage(out);
