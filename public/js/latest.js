/**
 * The last press wins (owner, 2026-11-06).
 *
 * Saving a choice takes a moment, and people do not wait for it: three presses on a
 * theme, a title or the effort dial used to send three saves, each drawn when it
 * came back, so the screen walked through all three and could land on any of them
 * if the answers crossed on the way. Here the screen is the caller's to change at
 * once, on the press, and what is sent is only what is still wanted: one save at a
 * time, the newest value next, everything in between never sent.
 *
 * An answer is only reported when it is about the newest choice, so nothing old can
 * paint over it. A failure the same: a press since then is already a new decision.
 *
 * @template T, A
 * @param {(value: T) => Promise<A>} save
 * `landed` hears every save that was stored, newest or not: if the next one fails, the
 * screen goes back to the last that landed, not to where it was before either.
 *
 * @param {{ landed?: (answer: A, value: T) => void, saved?: (answer: A, value: T) => void, failed?: (err: any, value: T) => void }} [hooks]
 */
export function latestOnly(save, { landed, saved, failed } = {}) {
  /** @type {{ value: T } | null} */
  let waiting = null;
  let flying = false;
  let presses = 0;

  async function pump() {
    if (flying) return;
    flying = true;
    try {
      while (waiting) {
        const { value } = waiting;
        waiting = null;
        try {
          const answer = await save(value);
          landed?.(answer, value);
          if (!waiting) saved?.(answer, value);
        } catch (err) {
          if (!waiting) failed?.(err, value);
        }
      }
    } finally {
      flying = false;
    }
  }

  return {
    /** The person has chosen this. @param {T} value */
    push(value) {
      presses += 1;
      waiting = { value };
      return pump();
    },
    /** Whether a choice has yet to be stored. */
    busy: () => flying || !!waiting,
    /** Taken before asking the server anything, for `sure`. */
    asked: () => presses,
    /**
     * Whether what the server said can be believed: nothing waiting to be stored, and no
     * press since the question was asked, whose answer may have been read before it landed.
     * @param {number} asked
     */
    sure: (asked) => asked === presses && !flying && !waiting,
  };
}
