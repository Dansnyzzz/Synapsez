import { getStore } from '../store/index.js';
import { stopTask } from '../scheduler.js';
import { stopWorkflow, withLastRun } from '../workflows.js';
import { taskState, workflowState, tally } from '../../public/js/bot-status.js';

/**
 * The Bot page's own routes: what needs the person, and Stop.
 *
 * Workflows and scheduled tasks are one page with two tabs (owner, 2026-11-08),
 * and these are the two things that page asks of both kinds at once. Session
 * auth throughout, mounted on the authenticated router; every store call is
 * scoped to `req.user.id`, and an id in the path only narrows a query that is
 * already scoped — so another account's task or workflow is a 404, never a
 * sign that it exists.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function }} ctx
 */
export function mountBotRoutes(api, { wrap }) {
  /**
   * How many of each there are, and how many need the person.
   *
   * Read by the rail's badge and the tab labels. Two indexed, account-scoped
   * queries — the same two the tabs load — counted with the rule the rows are
   * drawn with (public/js/bot-status.js), so the badge cannot say "2" over a
   * page that shows one.
   */
  api.get(
    '/bot/summary',
    wrap(async (req, res) => {
      const store = getStore();
      const [tasks, workflows] = await Promise.all([store.listTasks(req.user.id), store.listWorkflowsWithLastRun(req.user.id)]);
      const now = Date.now();
      const scheduled = tally(tasks, (task) => taskState(task, now));
      const chained = tally(workflows.map((row) => withLastRun(row)), (wf) => workflowState(wf, now));
      res.json({ workflows: chained, scheduled, attention: chained.attention + scheduled.attention });
    }),
  );

  /**
   * Stop a workflow's run in progress, and the step running in it.
   *
   * A second press, or a press when nothing is running, is harmless:
   * `stopped: false` and the workflow as it is.
   */
  api.post(
    '/workflows/:id/stop',
    wrap(async (req, res) => {
      const result = await stopWorkflow(req.user.id, req.params.id);
      if (!result) return res.status(404).json({ error: 'Workflow not found' });
      res.json(result);
    }),
  );

  /** The same for a scheduled task that is running. */
  api.post(
    '/tasks/:id/stop',
    wrap(async (req, res) => {
      const result = await stopTask(req.user.id, req.params.id);
      if (!result) return res.status(404).json({ error: 'Task not found' });
      res.json(result);
    }),
  );
}
