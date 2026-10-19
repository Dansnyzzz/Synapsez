/**
 * How often a worker reports in (owner, 2026-10-19).
 *
 * The heartbeat says what this machine is and is how a setting made in the app
 * reaches it, and it used to go every fifteen seconds for as long as the worker
 * ran — a laptop nobody was using kept a free database awake around the clock.
 * While the server says this machine is away (nobody has the app open, nothing
 * has run for ten minutes), its job poll keeps it marked online, so the full
 * report only needs to go every five minutes. The moment the server stops
 * saying so, the fifteen-second rhythm is back.
 */

export const HEARTBEAT_MS = 15_000;
export const AWAY_HEARTBEAT_MS = 5 * 60_000;

/**
 * Whether the heartbeat should go on this tick.
 *
 * @param {boolean} away  what the last job poll said
 * @param {number} lastBeat  when the last heartbeat went, in ms
 * @param {number} [now]
 */
export function heartbeatDue(away, lastBeat, now = Date.now()) {
  return !away || now - lastBeat >= AWAY_HEARTBEAT_MS;
}
