import { waitUntil } from '@vercel/functions';
import { getStore, isServerless } from './store/index.js';
import { runAgent as realRunAgent } from './agent.js';
import { watchLease } from './liveRuns.js';
import { log } from './util/trace.js';

/**
 * A conversation's turn carried on past one function's time (owner, 2026-11-12: "tự động
 * tiếp tục full hết", the same for free and paid models).
 *
 * On a deployment a turn lives inside one 300-second invocation. Near its end the loop stops
 * between steps (agent.js, `time_limit`) with everything saved, and says it is carrying on.
 * The browser, when it is there, asks again at once with the same run id — a fresh
 * invocation, the same lease. When nobody is watching, this asks the deployment itself for
 * the next part, the way a group round chains its segments (bots/continue.js): a request to
 * its own internal route, held open by `waitUntil`.
 *
 * The two never both run. This waits a moment first, then looks at the lease: taken again
 * since the turn that asked for it let go (a higher sequence — the browser came back), or
 * stopped, and it stands down. Otherwise it takes the lease under the same run id, so a
 * browser that opens the conversation meanwhile walks back into the run rather than
 * racing it, and runs the turn on. If that part also stops for time, it asks again.
 */

/** Long enough for a browser on screen to ask first; it asks within a second. */
export const CLIENT_GRACE_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** This deployment's own address, for asking itself for the next part. */
function selfUrl() {
  const stated = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (stated) return stated;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
}

/**
 * Ask for the next part of a turn. On a deployment, a request to its own internal route
 * (without CRON_SECRET or an address there is no way to, and the browser's Continue is the
 * way on); on a server of its own, it simply runs next.
 *
 * @param {{ userId: string, chatId: string, runId: string, afterSeq: number }} turn
 */
export function chainTurn({ userId, chatId, runId, afterSeq }) {
  if (isServerless()) {
    const secret = process.env.CRON_SECRET;
    const base = selfUrl();
    if (!secret || !base) return;
    waitUntil(
      fetch(`${base}/api/internal/turns/continue`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userId, chatId, runId, afterSeq }),
      })
        .then((res) => {
          if (!res.ok) log.error('carrying a turn on was refused', null, { status: res.status, chatId });
        })
        .catch((err) => log.error('could not ask for the next part of a turn', err, { chatId })),
    );
    return;
  }
  const timer = setTimeout(() => {
    continueTurn({ userId, chatId, runId, afterSeq }).catch((err) => log.error('carrying a turn on failed', err, { chatId }));
  }, 0);
  timer.unref?.();
}

/**
 * Run the next part of a turn, unless somebody else already is.
 *
 * @param {{
 *   userId: string, chatId: string, runId: string, afterSeq: number,
 *   run?: typeof realRunAgent, chain?: typeof chainTurn, graceMs?: number,
 * }} options  `afterSeq`: the lease sequence of the part that asked — anything higher means
 *   the conversation was taken up again since
 * @returns {Promise<{ status: 'taken' | 'stopped' | 'gone' | 'busy' | 'ran', stopReason?: string, chained?: boolean }>}
 */
export async function continueTurn({ userId, chatId, runId, afterSeq, run = realRunAgent, chain = chainTurn, graceMs = CLIENT_GRACE_MS }) {
  if (graceMs > 0) await sleep(graceMs);
  const store = getStore();
  const holder = await store.chatRunHolder(userId, chatId).catch(() => null);
  if (!holder) return { status: 'gone' };
  if (Number(holder.run_lock_seq) > Number(afterSeq)) return { status: 'taken' };
  if (holder.run_stop_at) return { status: 'stopped' };
  const user = await store.getUserById(userId);
  if (!user) return { status: 'gone' };
  const seq = await store.claimChatRun(userId, chatId, runId);
  if (!seq) return { status: 'busy' };

  // The same watch the browser-driven run keeps: a stop pressed lands within seconds, and a
  // browser that opens the conversation sees it running and joins it.
  const controller = new AbortController();
  const lease = watchLease({ store, userId, chatId, runId, seq, controller });
  let stopReason = '';
  let carryOn = false;
  try {
    await run({
      userId,
      user,
      chatId,
      // Nothing new from the person: the turn carries on as it was, on the account's model.
      modelId: null,
      decision: null,
      decisionFor: null,
      answers: null,
      deviceHint: null,
      signal: controller.signal,
      canContinue: true,
      emit(event, data) {
        if (event !== 'done') return;
        stopReason = String(data?.stopReason || '');
        carryOn = !!data?.stop?.continuing;
      },
    });
  } catch (err) {
    stopReason = 'error';
    log.error('carrying a turn on failed', err, { chatId });
  } finally {
    lease.stop();
    await store.releaseChatRun(userId, chatId, runId, seq).catch(() => {});
    await store.clearRunStop(userId, chatId).catch(() => {});
  }
  const chained = carryOn && !controller.signal.aborted;
  if (chained) chain({ userId, chatId, runId, afterSeq: seq });
  return { status: 'ran', stopReason, chained };
}
