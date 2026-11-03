/**
 * The order a quiz card asks its questions in (UX-022, owner 2026-11-02),
 * the way Quizizz does it:
 *
 *   - twenty at a time;
 *   - once a set of twenty is answered, the wrong ones again — two more rounds
 *     at most;
 *   - any still wrong after that go with the next set's wrong ones, so they
 *     come back once more there;
 *   - at the end, what was still missed can be tried again on its own, and
 *     the whole quiz can start over at any time.
 *
 * Pure: it knows question numbers and right or wrong, nothing of the page, so
 * the suite can walk it without a browser.
 */

export const BATCH = 20;
export const REDO_ROUNDS = 2;

/**
 * @param {number[]} order  the questions to ask, by index, in order
 * @param {{ batch?: number, rounds?: number }} [options]
 */
export function createQuizPlan(order, { batch = BATCH, rounds = REDO_ROUNDS } = {}) {
  const all = [...order];
  const batches = Math.max(1, Math.ceil(all.length / batch));
  let set = 0;
  /** 0 is the first pass through a set; 1…rounds are its wrong ones again. */
  let round = 0;
  let queue = [];
  let pos = 0;
  let wrong = new Set();
  /** Still wrong after the last round of the set before, waiting for this set's wrong ones. */
  let carried = [];
  /** Right the first time it was asked, per question. */
  const firstTry = new Map();
  /** @type {number[] | null} */
  let missed = null;

  const startSet = (n) => {
    set = n;
    round = 0;
    queue = all.slice(n * batch, (n + 1) * batch);
    pos = 0;
    wrong = new Set();
  };
  startSet(0);

  return {
    /** The question being asked now, and where it stands; null once the quiz is over. */
    current() {
      if (missed) return null;
      return { index: queue[pos], set, sets: batches, round, rounds, n: pos + 1, total: queue.length };
    },

    /** The answer to the question asked now. */
    answer(right) {
      const index = queue[pos];
      if (!firstTry.has(index)) firstTry.set(index, !!right);
      if (!right) wrong.add(index);
    },

    /** On to the next question: the rest of this pass, the wrong ones again, or the next set. */
    advance() {
      if (missed) return;
      pos += 1;
      if (pos < queue.length) return;
      const pool = round === 0 ? [...new Set([...carried, ...wrong])] : [...wrong];
      if (round === 0) carried = [];
      if (pool.length && round < rounds) {
        round += 1;
        queue = pool;
        pos = 0;
        wrong = new Set();
        return;
      }
      if (set + 1 < batches) {
        carried = pool;
        startSet(set + 1);
        return;
      }
      missed = pool;
    },

    done: () => !!missed,

    /** How it went: right the first time, out of how many were asked, and what is still missed. */
    summary() {
      return {
        firstTryRight: [...firstTry.values()].filter(Boolean).length,
        asked: firstTry.size,
        missed: missed ? [...missed] : [],
      };
    },
  };
}
