import { log } from './util/trace.js';

/**
 * Stopping a run, and knowing it has stopped (owner, 2026-11-06: somebody paying
 * by the token must not pay for a word after the button).
 *
 * Who is told, fastest first:
 *
 *   - **This instance.** `/stop` aborts the run where it stands, closing the
 *     provider's socket before it answers.
 *   - **Another instance.** A serverless deployment may answer `/stop` somewhere
 *     else, so `/stop` also takes the lease away in the database, and the run reads
 *     its lease every `STOP_WATCH_MS`. It was every fifteen seconds, at the price of
 *     up to fifteen seconds of a reply nobody would read.
 *
 * And the other half: until the stopped run has written what it had, the next
 * request has to wait for it. A question sent straight after a stop landed in the
 * transcript ahead of the reply it came after, and a new model was asked without
 * seeing what the old one had written. `chats.run_stop_at` says a stop is being
 * finished with; `settledAfterStop` waits it out, for a short while at most, because
 * an invocation that died never clears it.
 */

/** How often a run reads its lease: the longest a stop on another instance goes unheard. */
export const STOP_WATCH_MS = 2_000;
/** How often the lease is renewed, and the stream told it is still open. */
export const LEASE_RENEW_MS = 15_000;
/** The longest anybody waits for a stopped run to finish writing. */
export const STOP_SETTLE_MS = 6_000;
const SETTLE_POLL_MS = 100;

/** @type {Map<string, Set<AbortController>>} the runs on this instance, by account and conversation */
const here = new Map();
const keyOf = (userId, chatId) => `${userId}\u0000${chatId}`;

/**
 * Note a run on this instance. Call what it returns when the run ends.
 *
 * @param {string} userId @param {string} chatId @param {AbortController} controller
 */
export function holdRun(userId, chatId, controller) {
  const key = keyOf(userId, chatId);
  const set = here.get(key) || new Set();
  set.add(controller);
  here.set(key, set);
  return () => {
    set.delete(controller);
    if (!set.size) here.delete(key);
  };
}

/**
 * Stop whatever this instance is running in a conversation. The caller has checked
 * whose it is: the key has the account in it, so nobody reaches another's run.
 *
 * @returns {number} how many were stopped
 */
export function abortHere(userId, chatId) {
  const set = here.get(keyOf(userId, chatId));
  if (!set) return 0;
  for (const controller of set) if (!controller.signal.aborted) controller.abort('stopped');
  return set.size;
}

/**
 * Keep a run's lease, and stop the run the moment it is no longer its own.
 *
 * Losing it means one of two things. Somebody pressed stop, which clears the holder,
 * and what was already written is worth keeping. Or a reconnection took it over,
 * which leaves a holder, and that invocation is already writing this same reply, so
 * this one's half must not land beside it (CODE-016, AUTO-008). A database that
 * could not be asked says nothing either way, and the run carries on.
 *
 * @param {{ store: any, userId: string, chatId: string, runId: string, seq: number, controller: AbortController, watchMs?: number, renewMs?: number, onRenew?: () => void }} options
 * @returns {{ check: () => Promise<void>, stop: () => void }}
 */
export function watchLease({ store, userId, chatId, runId, seq, controller, watchMs = STOP_WATCH_MS, renewMs = LEASE_RENEW_MS, onRenew = null }) {
  const check = async () => {
    if (controller.signal.aborted) return;
    let holder;
    try {
      holder = await store.chatRunHolder(userId, chatId);
    } catch (err) {
      log.error('could not read a run lease', err, { chatId });
      return;
    }
    if (controller.signal.aborted) return;
    // The conversation has gone: nothing to write the rest to.
    if (!holder) return controller.abort('stopped');
    if (holder.run_lock_by === runId && Number(holder.run_lock_seq) === seq) return;
    controller.abort(holder.run_lock_by ? 'superseded' : 'stopped');
  };
  const watching = setInterval(() => void check(), watchMs);
  const renewing = setInterval(() => {
    onRenew?.();
    store.touchChatRun(userId, chatId, runId, seq).catch(() => {});
  }, renewMs);
  watching.unref?.();
  renewing.unref?.();
  return {
    check,
    stop() {
      clearInterval(watching);
      clearInterval(renewing);
    },
  };
}

/**
 * Wait until a stopped run has written what it had, so what comes next lands after it.
 *
 * @param {any} store @param {string} userId @param {string} chatId
 * @param {{ timeoutMs?: number }} [options]
 */
export async function settledAfterStop(store, userId, chatId, { timeoutMs = STOP_SETTLE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holder = await store.chatRunHolder(userId, chatId).catch(() => null);
    if (!holder?.run_stop_at || Date.now() - new Date(holder.run_stop_at).getTime() >= timeoutMs) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}
