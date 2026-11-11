import { redactSecrets } from '../redact.js';

/*
 * Two tools only a scheduled run is given (spec B.4, after OpenBot's NO_UPDATE and its
 * failed runs): `no_update` — having checked, the run has nothing worth telling, so its
 * answer folds away under the run and nobody is told; `run_failed` — it could not do its
 * job this time, and says why. The scheduler offers them (`runControl` on the turn) and
 * reads what was called from the loop's `run_outcome` event (server/scheduler.js); the
 * loop answers them itself, so they are never in the catalogue.
 */

/** Their names, for the loop to answer and the approval gate to grade. */
export const RUN_CONTROL_NAMES = new Set(['no_update', 'run_failed']);

/** The longest reason a failed run gives: shown on the Bot page and in Automations. */
export const RUN_FAILED_CHARS = 300;

export const RUN_CONTROL_TOOLS = Object.freeze([
  {
    name: 'no_update',
    scope: 'cloud',
    readOnly: true,
    description:
      'Scheduled runs only. Having checked what the task asks, there is nothing new worth telling the user this time: call this, then end with one short line saying what you checked. The run folds away and nobody is notified.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_failed',
    scope: 'cloud',
    readOnly: true,
    description: `Scheduled runs only. The task could not be done this time (a source down, a sign-in needed, no access): call this with the reason (at most ${RUN_FAILED_CHARS} characters), then end. The run is marked failed and the user sees why.`,
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: "Why, in a sentence or two, in the user's language" } },
      required: ['reason'],
    },
  },
]);

/**
 * The loop's answer to one of them, and what it tells the scheduler.
 *
 * @param {{ name: string, input?: any }} call
 * @returns {{ outcome: { kind: 'quiet' } | { kind: 'failed', reason: string }, content: string }}
 */
export function runControlResult(call) {
  if (call.name === 'no_update') {
    return { outcome: { kind: 'quiet' }, content: 'Noted: nothing new this run. It folds away and nobody is notified. End now with one short line saying what you checked.' };
  }
  const said = String(call.input?.reason ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const reason = redactSecrets(said).text.slice(0, RUN_FAILED_CHARS) || 'No reason was given.';
  return { outcome: { kind: 'failed', reason }, content: 'Noted: this run is marked failed, with your reason. End now with one short line for the user.' };
}
