import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { runAgent } from './agent.js';
import { log } from './util/trace.js';

/**
 * Finishing a conversation's turn that the server was cut off in the middle of.
 *
 * On a deployment a turn lives inside one function invocation, capped at 300
 * seconds. The loop already survives the browser leaving — every step is in
 * the database — but not the invocation ending: a turn that ran a long deep
 * research and then hit the ceiling stopped mid-step, with the tool's result
 * never recorded, and stayed that way until somebody opened the conversation
 * again. With the web closed, that was never.
 *
 * The cloud heartbeat (the cron endpoint) calls this. It finds turns whose
 * lease is still held but no longer renewed — the mark of an invocation that
 * was killed, as distinct from one that finished (lease released) or was
 * stopped (lease cleared) — takes the lease, and runs the turn on. The agent
 * loop resumes exactly where it stopped: finished calls keep their results,
 * reads are read again, and a call that changes something is never run twice.
 *
 * Three attempts per cut-off holding, then the lease is let go: a step that
 * cannot fit in the time a function has should not be retried forever.
 */

export const MAX_RESUMES = 3;
/** Do not start a turn with less than this left of the invocation. */
const MIN_TIME_MS = 120_000;

const attemptsKey = (chatId) => `resume:${chatId}`;

/**
 * @param {{ budgetMs?: number, limit?: number, run?: typeof runAgent, staleMs?: number }} [options]
 *   `run` is injectable so the suite can drive this without a model.
 */
export async function resumeCutOffTurns({ budgetMs = 240_000, limit = 2, run = runAgent, staleMs = undefined } = {}) {
  const store = getStore();
  const deadline = Date.now() + budgetMs;
  const resumed = [];

  const rows = await store.listCutOffRuns({ limit, ...(staleMs != null ? { staleMs } : {}) }).catch(() => []);
  for (const row of rows) {
    if (deadline - Date.now() < MIN_TIME_MS) break;

    // Counted per cut-off holding, so a fresh cut-off of the same conversation
    // a day later starts again from zero.
    const seen = (await store.getSetting(attemptsKey(row.id)).catch(() => null)) || {};
    const attempts = seen.holder === row.run_lock_by ? Number(seen.attempts) || 0 : 0;
    if (attempts >= MAX_RESUMES) {
      await store.stopChatRun(row.user_id, row.id).catch(() => {});
      resumed.push({ chatId: row.id, status: 'gave_up' });
      continue;
    }

    const runId = crypto.randomUUID();
    const seq = await store.claimChatRun(row.user_id, row.id, runId, staleMs);
    if (!seq) continue; // somebody else — a browser coming back — got there first
    await store.setSetting(attemptsKey(row.id), { holder: runId, attempts: attempts + 1 }).catch(() => {});

    const user = await store.getUserById(row.user_id);
    if (!user) {
      await store.releaseChatRun(row.user_id, row.id, runId, seq).catch(() => {});
      continue;
    }

    // The same renewal the browser-driven run does, so a browser opening the
    // conversation meanwhile sees it running and joins rather than racing it.
    const controller = new AbortController();
    const beat = setInterval(() => {
      store
        .touchChatRun(row.user_id, row.id, runId, seq)
        .then((held) => {
          if (held === false) controller.abort('superseded');
        })
        .catch(() => {});
    }, 15_000);
    beat.unref?.();

    let outcome = 'done';
    try {
      await run({
        userId: user.id,
        user,
        chatId: row.id,
        // Nothing a person said on the way in: the turn carries on as it was,
        // on the account's model — one model per account (see runAgent), and a
        // model that has gone meanwhile is moved off like anywhere else.
        modelId: null,
        decision: null,
        decisionFor: null,
        answers: null,
        deviceHint: null,
        signal: controller.signal,
        emit(event, data) {
          if (event === 'approval_required' || event === 'question_required') outcome = 'waiting_for_person';
          else if (event === 'error') outcome = `error: ${String(data?.message || '').slice(0, 160)}`;
        },
      });
    } catch (err) {
      outcome = `error: ${String(err?.message || err).slice(0, 160)}`;
      log.error('resuming a cut-off turn failed', err, { chatId: row.id });
    } finally {
      clearInterval(beat);
      await store.releaseChatRun(row.user_id, row.id, runId, seq).catch(() => {});
    }
    resumed.push({ chatId: row.id, status: outcome, attempt: attempts + 1 });
  }
  return resumed;
}
