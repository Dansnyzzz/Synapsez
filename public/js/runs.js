/**
 * The conversations this tab is answering, and where each of them draws.
 *
 * One run at a time used to be an assumption baked into a handful of fields on
 * the app's `state`, and leaving a conversation *aborted* it. That was the right
 * fix for a real bug — the stream handlers appended to `#messages` by name, so
 * the departing run's prose, its tool cards and its compaction dividers were
 * grafted into whichever conversation was now on screen — and it was the wrong
 * shape for the app. Aborting closes the socket; the server sees `res.on('close')`
 * and ends the run. So glancing at another conversation killed the work, and what
 * came back on return was a transcript frozen mid-thought with no sign of whether
 * anything was still happening, followed minutes later by the whole finished
 * answer appearing at once.
 *
 * The fix is ownership rather than arbitration. A run owns a `stage` — its own
 * element — and every handler draws into that. Going elsewhere detaches the
 * stage and touches nothing else: the fetch stays open, the lease stays held,
 * the model keeps working, and coming back re-attaches it mid-sentence. Two
 * conversations can work at once because neither can reach the other's nodes.
 *
 * Within one conversation there is still exactly one run. That is not a policy
 * this file could enforce anyway — the server's lease decides it, and a second
 * attempt is refused with a 409 — so `start` simply reports that one is already
 * going and the caller queues the message instead.
 */

/**
 * @param currentChatId  a function returning the conversation on screen. A
 *   function rather than a value because the answer changes constantly and a run
 *   outlives any particular reading of it.
 */
export function createRuns({ currentChatId, newStage = () => document.createElement('div') }) {
  /** @type {Map<string, any>} */
  const byChat = new Map();

  /** Whether this run's conversation is the one being looked at right now. */
  const onScreen = (run) => !!run && run.chatId === currentChatId();

  /** The run for the conversation on screen, if it has one. */
  const here = () => {
    const id = currentChatId();
    return (id && byChat.get(id)) || null;
  };

  /**
   * Begin a run for a conversation, or report that one is already going.
   *
   * @returns the new run, or null when this conversation is already answering —
   *   which is the caller's signal to queue rather than to start a second loop.
   */
  function start(chatId, fields = {}) {
    if (!chatId || byChat.has(chatId)) return null;
    const stage = newStage();
    stage.className = 'runstage';
    const run = {
      chatId,
      stage,
      /** The assistant block currently being streamed into. */
      turn: null,
      /**
       * True once the current block has been persisted. Tool cards still belong
       * to it — they are the calls it made — but the next prose starts fresh.
       */
      sealed: false,
      toolHandles: new Map(),
      /** Typed while this turn was running, waiting for it. */
      queue: [],
      /** The status line, so returning to the conversation restores it. */
      status: null,
      /**
       * The last "why this reply stopped" notice drawn, so one outcome is not
       * announced twice. Per run, not per conversation: the *next* turn being
       * truncated as well is news, not a repeat.
       */
      lastStopNote: null,
      ...fields,
    };
    byChat.set(chatId, run);
    return run;
  }

  return {
    onScreen,
    here,
    start,
    get: (chatId) => byChat.get(chatId) || null,
    has: (chatId) => byChat.has(chatId),
    /** How many conversations are answering. Two at once is the point of this. */
    get size() {
      return byChat.size;
    },
    /**
     * The run is over. Its stage stays where it is on purpose: those nodes are
     * the answer the person is reading, and the next `openChat` rebuilds the
     * transcript from the database and replaces them. Removing them here would
     * blank the reply at the instant it arrived.
     */
    finish(chatId) {
      byChat.delete(chatId);
    },
    /** Take the run off the page without touching the run itself. */
    hide(run) {
      if (run) run.stage.remove();
    },
    /** Put a run's nodes into `host`, if that run is the one on screen. */
    show(run, host) {
      if (!onScreen(run) || !host) return false;
      host.append(run.stage);
      return true;
    },
  };
}
