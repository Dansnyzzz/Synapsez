/**
 * What a scheduled task or a workflow is doing, said once.
 *
 * The Automations page draws a pill from this on every row, sorts by it, and the rail
 * counts what needs the person from it. The server's summary for that count
 * (`GET /api/automations/summary`) imports this same file, so the badge and the rows
 * cannot disagree about what "needs you" means. Pure: no DOM, no strings a
 * person reads — the words are the page's, in the person's language.
 *
 * Two parts to a state, because a row can say both: how its last run went
 * (`run`) and what its schedule is doing (`plan`). A workflow that failed this
 * morning and runs again tomorrow is "Failed" and "Next: tomorrow".
 */

/** What a task's last status says once the person stopped it (scheduler.js `stopTask`). */
export const TASK_STOPPED = 'stopped by you';

/**
 * How long past its time a run may be before it counts as overdue. The local
 * scheduler looks once a minute and a deployment's pinger every few, so a run
 * due thirty seconds ago is not late yet — it is about to start.
 */
export const OVERDUE_GRACE_MS = 2 * 60_000;

/**
 * @typedef {'running' | 'needs' | 'failed' | 'stopped' | null} RunState
 * @typedef {'overdue' | 'paused' | 'manual' | 'next'} PlanState
 * @typedef {{ run: RunState, plan: PlanState, step: number, steps: number, next: string | null, attention: boolean, rank: number }} AutoState
 */

const time = (value) => {
  const at = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(at) ? at : null;
};

/** The schedule half, the same for both kinds. */
function planOf(row, run, now) {
  if (!row.enabled) return 'paused';
  const next = time(row.next_run_at);
  if (!row.cron && next == null) return 'manual';
  if (next != null && next < now - OVERDUE_GRACE_MS && run !== 'running') return 'overdue';
  return 'next';
}

/**
 * Whether a person is wanted, and where the row sorts.
 *
 * A failure on something the person has since paused has been seen — counting
 * it for ever would make the badge a nag nobody can clear. A run waiting for
 * them counts paused or not: the stalled-task reaper pauses a task as it stops it.
 */
function finish(run, plan, extra) {
  const attention = run === 'needs' || (run === 'failed' && plan !== 'paused') || plan === 'overdue';
  const rank =
    run === 'needs' ? 0
    : attention && run === 'failed' ? 1
    : plan === 'overdue' ? 2
    : run === 'running' ? 3
    : plan === 'next' ? 4
    : plan === 'manual' ? 5
    : 6;
  return { run, plan, attention, rank, step: 0, steps: 0, ...extra };
}

/**
 * @param {{ enabled?: boolean, cron?: string | null, next_run_at?: string | null, run_state?: string | null, last_status?: string | null }} task
 * @returns {AutoState}
 */
export function taskState(task, now = Date.now()) {
  const said = String(task.last_status || '');
  /** @type {RunState} */
  const run =
    task.run_state === 'running' ? 'running'
    : task.run_state === 'needs_attention' || /^stopped: waiting for an approval/.test(said) ? 'needs'
    : said === TASK_STOPPED ? 'stopped'
    : /^(error:|stopped)/.test(said) ? 'failed'
    : null;
  return finish(run, planOf(task, run, now), { next: task.next_run_at || null });
}

/**
 * @param {{ enabled?: boolean, cron?: string | null, next_run_at?: string | null, steps?: unknown[],
 *   lastRun?: { status?: string, cursor?: number, steps?: Array<{ status?: string }> } | null }} workflow
 * @returns {AutoState}
 */
export function workflowState(workflow, now = Date.now()) {
  const last = workflow.lastRun || null;
  /** @type {RunState} */
  const run =
    last?.status === 'running' ? 'running'
    : last?.status === 'needs_attention' ? 'needs'
    : last?.status === 'failed' ? 'failed'
    : last?.status === 'cancelled' ? 'stopped'
    : null;
  const steps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
  // The step it is on: the one marked running, or the next one it will start.
  const marked = Array.isArray(last?.steps) ? last.steps.findIndex((s) => s?.status === 'running') : -1;
  const at = marked >= 0 ? marked : Number(last?.cursor) || 0;
  const step = run === 'running' && steps ? Math.min(at + 1, steps) : 0;
  return finish(run, planOf(workflow, run, now), { next: workflow.next_run_at || null, step, steps });
}

/**
 * Needs you first, then failures, overdue, running, then by when each runs
 * next; manual and paused last. Ties go by name, so the order is stable.
 *
 * @template T
 * @param {T[]} list
 * @param {(row: T) => AutoState} stateOf
 * @param {(row: T) => string} nameOf
 */
export function sortByState(list, stateOf, nameOf) {
  const keyed = list.map((row) => ({ row, state: stateOf(row) }));
  keyed.sort(
    (a, b) =>
      a.state.rank - b.state.rank ||
      (time(a.state.next) ?? Infinity) - (time(b.state.next) ?? Infinity) ||
      String(nameOf(a.row)).localeCompare(String(nameOf(b.row))),
  );
  return keyed.map((k) => k.row);
}

/**
 * The counts the rail badge and the tab labels show.
 *
 * @template T
 * @param {T[]} list
 * @param {(row: T) => AutoState} stateOf
 */
export function tally(list, stateOf) {
  let attention = 0;
  let running = 0;
  for (const row of list) {
    const state = stateOf(row);
    if (state.attention) attention += 1;
    if (state.run === 'running') running += 1;
  }
  return { count: list.length, attention, running };
}
