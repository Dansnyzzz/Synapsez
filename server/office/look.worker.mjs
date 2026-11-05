/**
 * Draws an Office file off the request's thread.
 *
 * These files can come from strangers, and the parsing and drawing take as long as
 * the file says. Here that is a worker `lookAtFile` (look.js) can stop after a
 * deadline, with a heap of its own. A null result, the native canvas not loading in
 * a worker, sends the caller back to drawing on its own thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { lookAtFileHere } from './look.js';

const out = await lookAtFileHere(Buffer.from(workerData.bytes), workerData.options || {}).then(
  (result) => ({ ok: true, result }),
  (err) => ({ ok: false, message: String(err?.message || err), code: err?.code || 'office_unreadable' }),
);
parentPort?.postMessage(out);
