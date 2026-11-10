/**
 * Which steps of a plan the Progress list shows (owner, 2026-11-09, after Claude's).
 *
 * A plan of seven steps listed whole pushed the step being worked on halfway down
 * the panel, under a column of finished ones nobody was reading any more. So the
 * list shows where the run is: the step it is on, the two finished just before it,
 * and what is still to come. Everything earlier folds behind one button ("3 earlier
 * steps") that shows it again. Once the last step is done, only the last two stay,
 * the final tick among them.
 *
 * No imports, so the rules are checked by themselves (test/plan-window.test.mjs) and
 * the drawing in app.js only asks this what to draw.
 */

/** Finished steps kept in view above the one being worked on. */
export const RECENT_DONE = 2;

/**
 * @param {{ status?: string }[]} steps  the plan, normalised (at most one `in_progress`)
 * @param {boolean} [expanded]  the person pressed "N earlier steps"
 * @returns {{ current: number, finished: boolean, earlier: number, start: number, total: number }}
 *   `current`: the index the run is on (-1 when there are no steps) — the step in
 *   progress, else the first not yet done, else the last;
 *   `finished`: every step is done;
 *   `earlier`: how many steps fold behind the button, 0 for no button;
 *   `start`: the first index drawn.
 */
export function planWindow(steps, expanded = false) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  if (!total) return { current: -1, finished: false, earlier: 0, start: 0, total: 0 };

  const finished = list.every((step) => step?.status === 'done');
  let current = list.findIndex((step) => step?.status === 'in_progress');
  // Between two updates nothing is in progress: the run is at the next step to do.
  if (current < 0) current = finished ? total - 1 : list.findIndex((step) => step?.status !== 'done');

  // Running, the step and the two before it; finished, the last step and the one before.
  const earlier = Math.max(0, current - (finished ? 1 : RECENT_DONE));
  return { current, finished, earlier, start: expanded ? 0 : earlier, total };
}

const titleKey = (step) =>
  String(step?.title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether `next` carries on the plan in `prev` rather than replacing it.
 *
 * The tool resends the whole list on every update, and a step's title is the only
 * identity it has (see `planChange` in plan.js). The same plan shares at least one
 * title; a new one shares none. Opened earlier steps stay open while the same plan
 * ticks over and a new plan starts folded.
 *
 * @param {{ title?: string }[]} prev
 * @param {{ title?: string }[]} next
 */
export function samePlan(prev, next) {
  const had = new Set((Array.isArray(prev) ? prev : []).map(titleKey).filter(Boolean));
  return (Array.isArray(next) ? next : []).some((step) => had.has(titleKey(step)));
}
