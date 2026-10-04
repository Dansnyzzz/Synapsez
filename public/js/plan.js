import { escapeHtml } from './markdown.js';
import { t } from './i18n.js';

/**
 * The plan — `update_plan`'s checklist — as the interface draws it.
 *
 * One module for the three places it appears: the progress rail beside the
 * conversation, the checklist inside the message, and the card in the
 * transcript that says what the update changed ("Added task …").
 */

const STATUSES = ['pending', 'in_progress', 'done'];

/**
 * The same rules as `normalisePlan` on the server (server/tools/cloud.js).
 *
 * The live `plan` event is already normalised there, but a conversation opened
 * again is rebuilt from the call's raw arguments — and a model that marked four
 * steps `in_progress` at once then drew four highlighted rows after every
 * refresh, while the live view had shown one. Reading both through the same
 * rules is what makes a refresh show what was shown before it.
 *
 * @param {any} steps
 * @returns {{ title: string, status: string, detail: string }[]}
 */
export function normalisePlan(steps) {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      title: s.title.trim(),
      status: STATUSES.includes(s.status) ? s.status : 'pending',
      detail: typeof s.detail === 'string' ? s.detail.trim().slice(0, 600) : '',
    }));
  let running = false;
  for (const step of list) {
    if (step.status !== 'in_progress') continue;
    if (running) step.status = 'pending';
    running = true;
  }
  return list;
}

/**
 * The mark beside a step: a tick in a ring when done, a turning ring while it
 * is being worked on, and a dashed ring for what is still to come.
 *
 * Drawn, not typed: the glyphs ✓ ▸ ○ sat at different sizes and baselines in
 * every font, and the blue triangle read as "play" rather than "working".
 */
export function planMark(status) {
  if (status === 'done') {
    return (
      '<svg class="pmark pmark--done" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="6.5" fill="currentColor" opacity="0.16"/>' +
      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
      '<path d="M5.2 8.2 7.1 10l3.7-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }
  if (status === 'in_progress') {
    return (
      '<svg class="pmark pmark--active" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.22"/>' +
      '<path class="pmark__arc" d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    );
  }
  return (
    '<svg class="pmark pmark--pending" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.6 2.4"/></svg>'
  );
}

/**
 * One step as a list item.
 *
 * @param {{ title: string, status: string, detail?: string }} step
 * @param {{ withDetail?: boolean }} [options]  show the step's detail under its title
 */
export function planItemHtml(step, { withDetail = false } = {}) {
  const cls = step.status === 'done' ? 'is-done' : step.status === 'in_progress' ? 'is-active' : 'is-pending';
  const detail = withDetail && step.detail ? `<span class="pstep__detail">${escapeHtml(step.detail)}</span>` : '';
  return (
    `<li class="pstep ${cls}"${step.status === 'in_progress' ? ' aria-current="step"' : ''}` +
    `${step.detail ? ` title="${escapeHtml(step.detail)}"` : ''}>` +
    `${planMark(step.status)}<span class="pstep__text"><span class="pstep__title">${escapeHtml(step.title)}</span>${detail}</span></li>`
  );
}

const key = (s) => s.title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What an update changed, against the plan before it.
 *
 * Steps are matched by title — the tool resends the whole list every time, so
 * a title is the only identity a step has. The headline follows what matters
 * most to somebody watching: something new was taken on, something was
 * finished, something was started, the order changed.
 *
 * @returns {{ headline: string, arg: string, steps: { title: string, status: string, detail: string }[] }}
 */
export function planChange(before, after) {
  const prev = normalisePlan(before);
  const next = normalisePlan(after);
  if (!prev.length) {
    return { headline: t('plan.created'), arg: t('plan.stepCount', { n: next.length }), steps: next };
  }
  const had = new Map(prev.map((s) => [key(s), s]));
  const has = new Set(next.map(key));
  const added = next.filter((s) => !had.has(key(s)));
  const removed = prev.filter((s) => !has.has(key(s)));
  const completed = next.filter((s) => s.status === 'done' && had.get(key(s))?.status !== 'done' && had.has(key(s)));
  const started = next.filter((s) => s.status === 'in_progress' && had.get(key(s))?.status !== 'in_progress' && had.has(key(s)));

  if (added.length === 1) return { headline: t('plan.added'), arg: added[0].title, steps: added };
  if (added.length > 1) return { headline: t('plan.addedMany', { n: added.length }), arg: added.map((s) => s.title).join(' · '), steps: added };
  if (removed.length) {
    return {
      headline: removed.length === 1 ? t('plan.removed') : t('plan.removedMany', { n: removed.length }),
      arg: removed.map((s) => s.title).join(' · '),
      steps: removed.map((s) => ({ ...s, status: 'pending' })),
    };
  }
  if (completed.length) {
    return {
      headline: t('plan.completed'),
      arg: completed.map((s) => s.title).join(' · '),
      steps: [...completed, ...started],
    };
  }
  if (started.length) return { headline: t('plan.started'), arg: started[0].title, steps: started };
  const order = (list) => list.map(key).join('\n');
  if (order(prev.filter((s) => has.has(key(s)))) !== order(next.filter((s) => had.has(key(s))))) {
    return { headline: t('plan.reordered'), arg: t('plan.stepCount', { n: next.length }), steps: next };
  }
  return { headline: t('plan.updated'), arg: t('plan.stepCount', { n: next.length }), steps: next };
}
