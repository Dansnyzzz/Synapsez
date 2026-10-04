import { normalisePlan, PLAN_MIN_STEPS } from './tools/cloud.js';

/**
 * Keeping the plan true while the work goes on.
 *
 * `update_plan` draws the checklist the user watches, and the model is the
 * only thing that moves it. Models forget: a run reads twenty slides, writes
 * the quiz, gives a careful final answer — and the panel still says 0/7 with
 * the first step spinning. Asking nicely in the tool description was not
 * enough, so two checks are made in code:
 *
 *   **A reminder while working.** Every `PROGRESS_EVERY` tool calls without a
 *   plan update, the newest tool result carries one line saying where the plan
 *   stands. Attached to the result rather than sent as a message, and computed
 *   from the transcript alone, so the same message always carries the same note
 *   and the cached prefix of the next request is undisturbed.
 *
 *   **A gate before finishing.** A turn that wrote a plan and is about to end
 *   with steps not done is sent back once, to mark what it finished — before
 *   the `done` event, so the panel is right when the turn ends. Once per turn,
 *   so a step the model genuinely left undone cannot trap it in a loop.
 */

/** Tool calls without a plan update before the model is reminded. */
export const PROGRESS_EVERY = 5;

const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The transcript with a reminder on each tool result that ends a long stretch
 * without a plan update. Pure: nothing stored, nothing else changed.
 */
export function withProgressNotes(messages) {
  let plan = null;
  let since = 0;
  let noted = 0;
  return messages.map((m) => {
    if (m.role === 'user') {
      since = 0;
      noted = 0;
      return m;
    }
    if (m.role === 'assistant') {
      for (const call of m.toolCalls || []) {
        if (call.name === 'update_plan') {
          const steps = normalisePlan(call.input?.steps);
          if (steps.length >= PLAN_MIN_STEPS) plan = steps;
          since = 0;
          noted = 0;
        } else {
          since += 1;
        }
      }
      return m;
    }
    if (m.role !== 'tool' || !plan || !m.results?.length) return m;
    const open = plan.filter((s) => s.status !== 'done');
    if (!open.length || since < PROGRESS_EVERY || since - noted < PROGRESS_EVERY) return m;
    noted = since;
    const current = plan.find((s) => s.status === 'in_progress');
    const note =
      `\n\n[Progress check, from the app — not the user: ${since} tool calls since the plan was last updated. ` +
      `It shows ${current ? `"${clip(current.title)}" in progress` : 'no step in progress'}, ${plan.length - open.length} of ${plan.length} done. ` +
      'If a step is finished, call update_plan now — mark it done and set the next in_progress. ' +
      'If the work changed, add, reorder or drop steps. If that plan is not about this work, ignore this.]';
    const results = m.results.slice();
    const last = results[results.length - 1];
    results[results.length - 1] = { ...last, content: `${last.content ?? ''}${note}` };
    return { ...m, results };
  });
}

/**
 * The steps not done in a plan written during this turn, or null.
 *
 * Only a plan from this turn: an old plan from yesterday's job must not stop
 * an unrelated question from being answered.
 */
export function unfinishedThisTurn(messages) {
  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  for (let i = messages.length - 1; i > lastUser; i -= 1) {
    const calls = messages[i].role === 'assistant' ? messages[i].toolCalls || [] : [];
    const call = [...calls].reverse().find((c) => c.name === 'update_plan');
    if (!call) continue;
    const steps = normalisePlan(call.input?.steps);
    if (steps.length < PLAN_MIN_STEPS) return null;
    const open = steps.filter((s) => s.status !== 'done');
    return open.length ? { open, total: steps.length } : null;
  }
  return null;
}

/** What the model is told when it tries to finish with the plan behind. */
export function progressGateNote({ open, total }) {
  return (
    `(Progress gate, from the app — not the user. You were about to finish, but your plan still shows ${open.length} of ${total} steps not done: ` +
    `${open.map((s) => `"${clip(s.title, 60)}"`).join(', ')}. ` +
    'Call update_plan once now with every step\'s real status: done for each step you completed, pending only for what you truly did not do. ' +
    'Do not repeat your answer. After the update, add one short sentence only if something is left undone — what, and why.)'
  );
}
