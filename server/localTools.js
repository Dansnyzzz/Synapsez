import os from 'node:os';
import path from 'node:path';
import { getStore, isServerless } from './store/index.js';
import { publish } from './screenHub.js';
import { isOwner } from './adminRoles.js';

/**
 * When the server process is running on someone's own machine, it can execute
 * the local tools itself — no second process, no queue round-trip.
 *
 * Two conditions, and both matter. **Not serverless**, because on Vercel there
 * is no durable filesystem or shell worth reaching. And **the owner only**, because
 * otherwise any account on a locally-run instance would get a shell on the
 * owner's computer for free — and that includes somebody made an administrator to
 * read the feedback (server/adminRoles.js).
 *
 * Note this is about where the *server* runs, not where the database lives: a
 * local server backed by hosted Neon still has a real machine under it.
 *
 * Set WORKER_MODE=remote to force the queue path even locally, which is how you
 * test the relay end to end.
 */
export function usesInProcessTools(user) {
  if (process.env.WORKER_MODE === 'remote') return false;
  if (isServerless()) return false;
  return isOwner(user);
}

let runtime = null;
/** In-flight load, so two concurrent first calls do not both build it. */
let runtimePending = null;
/**
 * The one account these local tools belong to.
 *
 * There is one browser, one workspace and one screen in this process — the
 * runtime is a singleton and cannot be otherwise, because it *is* the machine.
 * The sinks below, though, were rebound on every call with a closure over
 * whichever user asked last. On a locally-run server with more than one admin
 * (the only accounts that reach these tools at all) that meant admin A could
 * start a browser session, admin B take a turn, and A's next captured frame be
 * published to B's screen hub and drawn in B's panel — a photograph of somebody
 * else's desktop. Indexed document chunks went the same way, deciding which
 * account's `doc_chunks` rows they became.
 *
 * Rebinding cannot be made safe, because the thing behind the sink is shared:
 * two admins driving one browser is a race whatever the frames are addressed
 * to. So the machine belongs to whoever claimed it, and a second admin is told
 * plainly rather than quietly shown the first one's screen.
 */
let owner = null;

async function loadRuntime() {
  if (runtime) return runtime;
  // Two concurrent first calls both saw `runtime === null` and both ran the
  // imports and `setWorkspace`. Harmless in practice and trivially avoidable.
  if (runtimePending) return runtimePending;

  runtimePending = (async () => {
    const [{ setWorkspace }, tools, screen, indexer] = await Promise.all([
      import('../worker/paths.js'),
      import('../worker/tools.js'),
      import('../worker/screen.js'),
      import('../worker/indexer.js'),
    ]);
    setWorkspace(process.env.WORKSPACE || path.join(os.homedir(), 'AI-Remote-Workspace'));
    runtime = { implementations: tools.LOCAL_IMPLEMENTATIONS, info: tools.workerInfo(), screen, indexer };
    return runtime;
  })();

  try {
    return await runtimePending;
  } finally {
    runtimePending = null;
  }
}

export async function inProcessImplementations(user) {
  const { screen, implementations, indexer } = await loadRuntime();

  if (owner && owner !== user.id) {
    throw new Error(
      'The local tools on this machine are already in use by another account on this server. ' +
        'Only one account can drive one computer at a time — pair a worker to use your own machine instead.',
    );
  }

  if (owner !== user.id) {
    owner = user.id;

    // Bound once, to the owner, rather than re-bound to whoever asked last.
    // Running in the server process there is no HTTP hop for frames — hand them
    // straight to the hub, and answer the same "is anyone looking?" question the
    // worker gets over the wire.
    screen.setFrameSink(async ({ frame, ...meta }) => publish(owner, frame, meta));

    // Same for chunked documents: the embedding key is in this very process, so
    // the batch goes straight to the ingester rather than out and back over HTTP.
    indexer.setIndexSink((payload) => handleIndexPayload(owner, payload));
  }

  return implementations;
}

/** Exposed so a test can hand the machine to a different account. */
export const __testing = {
  releaseLocalTools() {
    owner = null;
  },
};

/**
 * One batch from the indexer, whichever way it arrived.
 *
 * Shared by the in-process path above and the worker's HTTP endpoint, so a
 * folder indexed from a paired laptop and one indexed on the machine running the
 * server go through exactly the same code.
 *
 * `prune` (2026-11-12) comes once, after a walk that saw the whole folder, with every
 * path still in it; an older server reads it as an empty batch and does nothing.
 */
export async function handleIndexPayload(userId, payload) {
  const { ingestBatch, knownStamps, pruneSource } = await import('./rag.js');
  if (payload?.op === 'stamps') return knownStamps(userId, payload.source);
  if (payload?.op === 'prune') return pruneSource(userId, payload);
  return ingestBatch(userId, payload || {});
}

/**
 * Whether *this account* can run local tools right now. The agent uses it to
 * decide whether to advertise the filesystem and shell tools at all — and the
 * per-account scoping is what stops one account reaching another's computer.
 */
export async function workerStatus(user, prefs = null, deviceHint = null) {
  if (usesInProcessTools(user)) {
    const { info } = await loadRuntime();
    return { online: true, local: true, info, machines: [], activeId: null };
  }

  const machines = await getStore().activeWorkers(user.id);

  if (machines.length) {
    /**
     * Which one the assistant acts on, in order:
     *
     *   1. **A machine you picked.** An explicit choice that software quietly
     *      overrides is a worse bug than picking the wrong machine, so this wins
     *      until it is cleared — including over the computer you are sitting at,
     *      because "always use the one at home" is a real thing to want.
     *
     *   2. **The computer the browser is running on.** Asked of `127.0.0.1` by
     *      the page and passed along with the message. It is the answer people
     *      mean when they say "open that file": the machine in front of them.
     *
     *   3. **Whichever answered most recently** — the old behaviour, and for the
     *      overwhelmingly common case of one computer it is simply "the computer".
     *
     * The hint comes from a browser, so it is checked against this account's own
     * machines rather than trusted. An id somebody types by hand can name only a
     * computer they already own.
     */
    const chosen =
      machines.find((m) => m.id === prefs?.activeDevice) ||
      machines.find((m) => m.id === deviceHint) ||
      machines[0];

    return {
      online: true,
      local: false,
      info: chosen.info,
      lastSeen: chosen.last_seen,
      activeId: chosen.id,
      activeName: chosen.name || chosen.info?.hostname || 'This computer',
      // Listed so the interface can offer a choice, and so somebody can see at a
      // glance that they left a machine running at the office.
      machines: machines.map((m) => ({
        id: m.id,
        name: m.name || m.info?.hostname || m.id,
        platform: m.info?.platform ?? null,
        workspace: m.info?.workspace ?? null,
        desktop: !!m.info?.desktop,
        lastSeen: m.last_seen,
      })),
    };
  }

  // Say *why* there is nothing, rather than telling everyone to go and run a
  // worker. On a server someone is running on their own desk, the tools attach
  // to the administrator's account and only theirs — so a second account here
  // is not misconfigured, it simply is not the owner of this computer.
  const ownersMachine = !isServerless() && process.env.WORKER_MODE !== 'remote' && !isOwner(user);
  return {
    online: false,
    local: false,
    machines: [],
    activeId: null,
    reason: ownersMachine ? 'not-the-owner' : 'no-worker',
  };
}
