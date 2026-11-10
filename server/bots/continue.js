import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getStore, isServerless } from '../store/index.js';
import { runAgent as realRunAgent } from '../agent.js';
import { log } from '../util/trace.js';
import { holdRun, watchLease } from '../liveRuns.js';
import { runGroupRound, ROUND_BUDGET_MS } from './rounds.js';

/**
 * A group's round carried on in another invocation (owner, 2026-11-10).
 *
 * A round is a series of segments (server/bots/rounds.js). A segment that runs short
 * of time asks for the next one; that request arrives here as a new function
 * invocation with a full 300 seconds, takes the group's run lease, and runs from what
 * the group has pending. A segment that was killed outright — no time to ask — is
 * found by the heartbeat (`resumeGroupRounds`): its lease stopped being renewed while
 * `pending` still says it was running.
 *
 * The next segment is asked for only after this one has let the lease go, so the new
 * invocation never finds the group held by the one that asked for it.
 */

/** A heartbeat does not start a segment with less than this of its time left. */
const MIN_SEGMENT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** This deployment's own address, for asking itself for the next segment. */
function selfUrl() {
  const stated = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (stated) return stated;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
}

/**
 * Ask for the next segment. On a deployment, a request to this deployment's own
 * internal route, held open past the answer by `waitUntil`; with no secret or no
 * address it is left to the heartbeat. On a server of its own, it simply runs next.
 */
export function chainNext(userId, groupId) {
  if (isServerless()) {
    const secret = process.env.CRON_SECRET;
    const base = selfUrl();
    if (!secret || !base) return;
    waitUntil(
      fetch(`${base}/api/internal/bot-rounds/continue`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ userId, groupId }),
      })
        .then((res) => {
          if (!res.ok) log.error('the next group segment was refused', null, { status: res.status, groupId });
        })
        .catch((err) => log.error('could not ask for the next group segment', err, { groupId })),
    );
    return;
  }
  const timer = setTimeout(() => {
    continueGroup({ userId, groupId }).catch((err) => log.error('a group segment failed', err, { groupId }));
  }, 0);
  timer.unref?.();
}

/**
 * Run the next segment of a group's round, holding its run lease.
 *
 * @param {{
 *   userId: string, groupId: string, budgetMs?: number, runAgent?: typeof realRunAgent,
 *   chain?: (userId: string, groupId: string) => any, staleMs?: number, claimWaitMs?: number,
 *   floorMs?: number, emit?: (event: string, data: any) => void, fresh?: boolean,
 * }} options  `fresh`: the person pressed Continue; `claimWaitMs`: how long to wait for a
 *   lease the segment before this one is still letting go of
 * @returns {Promise<{ status: 'ran' | 'busy' | 'nothing', stopReason?: string, pending?: boolean }>}
 */
export async function continueGroup({ userId, groupId, budgetMs = ROUND_BUDGET_MS, runAgent = realRunAgent, chain = chainNext, staleMs = undefined, claimWaitMs = 8_000, floorMs = undefined, emit = () => {}, fresh = false }) {
  const store = getStore();
  const [user, group] = await Promise.all([store.getUserById(userId), store.getBotGroup(userId, groupId)]);
  if (!user || !group?.pending) return { status: 'nothing' };
  const chat = await store.botChat(userId, { groupId, title: group.name });
  const runId = crypto.randomUUID();
  let seq = null;
  const until = Date.now() + claimWaitMs;
  for (;;) {
    seq = await store.claimChatRun(userId, chat.id, runId, ...(staleMs != null ? [staleMs] : []));
    if (seq || Date.now() >= until) break;
    await sleep(Math.min(400, Math.max(10, until - Date.now())));
  }
  if (!seq) return { status: 'busy' };

  const controller = new AbortController();
  const letGo = holdRun(userId, chat.id, controller);
  const lease = watchLease({ store, userId, chatId: chat.id, runId, seq, controller });
  let wantNext = false;
  let result;
  try {
    result = await runGroupRound({
      user,
      groupId,
      emit,
      signal: controller.signal,
      deadlineAt: Date.now() + budgetMs,
      runAgent,
      resume: true,
      fresh,
      chain: () => {
        wantNext = true;
      },
      ...(floorMs != null ? { floorMs } : {}),
    });
  } finally {
    lease.stop();
    letGo();
    await store.releaseChatRun(userId, chat.id, runId, seq).catch(() => {});
    await store.clearRunStop(userId, chat.id).catch(() => {});
  }
  if (wantNext) {
    try {
      await chain(userId, groupId);
    } catch (err) {
      log.error('could not ask for the next group segment', err, { groupId });
    }
  }
  return { status: 'ran', ...result };
}

/**
 * The heartbeat's part: rounds a killed invocation left, or whose request for the
 * next segment never arrived, carried on while the heartbeat has time.
 *
 * @param {{ budgetMs?: number, runAgent?: typeof realRunAgent, chain?: any, staleMs?: number, limit?: number }} [options]
 */
export async function resumeGroupRounds({ budgetMs = 240_000, runAgent = realRunAgent, chain = chainNext, staleMs = undefined, limit = 2 } = {}) {
  const store = getStore();
  const started = Date.now();
  const out = [];
  const rows = await store.listStaleGroupRounds({ limit, ...(staleMs != null ? { staleMs } : {}) }).catch(() => []);
  for (const row of rows) {
    const left = budgetMs - (Date.now() - started);
    if (left < MIN_SEGMENT_MS) break;
    const res = await continueGroup({ userId: row.user_id, groupId: row.group_id, budgetMs: Math.min(left - 10_000, ROUND_BUDGET_MS), runAgent, chain, staleMs, claimWaitMs: 0 }).catch((err) => {
      log.error('the heartbeat could not carry on a group round', err, { groupId: row.group_id });
      return { status: 'failed' };
    });
    out.push({ groupId: row.group_id, status: res.status });
  }
  return out;
}
