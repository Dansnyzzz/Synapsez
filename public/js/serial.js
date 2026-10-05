/**
 * One save at a time, and the last word wins.
 *
 * A form that saves on every `change` sends a request per keystroke-ish event —
 * Chrome fires one per completed segment of a time field, so typing 17:30 over
 * 09:00 sent 01:00, 17:00, 17:03 and 17:30 — and on a serverless backend the
 * replies come back in any order, so the server could keep 17:03 while the
 * field showed 17:30 (CODE-036).
 *
 * `latestWins(run)` returns a function that runs `run` with nothing else in
 * flight. A call made while one is running does not start a second request; it
 * marks that another is wanted, and when the current one finishes `run` goes
 * once more — reading the controls as they are *then*. Every caller gets the
 * result of the run that covered its change.
 *
 * @template T
 * @param {() => Promise<T>} run  reads whatever it needs at the time it runs
 * @returns {() => Promise<T>}
 */
export function latestWins(run) {
  /** @type {Promise<T> | null} */
  let inFlight = null;
  let again = false;
  return () => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      let result;
      do {
        again = false;
        result = await run();
      } while (again);
      return result;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Only the newest of overlapping runs may act on what it got back.
 *
 * `start()` returns a check that stays true until `start()` is called again.
 * Unlike `latestWins`, nothing waits: a picture edited while its original is
 * still uploading starts its own upload at once, and the original's answer,
 * whenever it arrives, is dropped rather than put in place of the edit
 * (CODE-037).
 *
 * @returns {() => () => boolean}
 */
export function newestOnly() {
  let latest = 0;
  return () => {
    const mine = ++latest;
    return () => mine === latest;
  };
}
