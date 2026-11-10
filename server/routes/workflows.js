import { parseSchedule, schedulePatch, validZone, UNATTENDED_POLICIES } from '../scheduler.js';
import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { normaliseSteps, runWorkflowNow, withLastRun } from '../workflows.js';
import { languageOf, translateMessage } from '../i18n/index.js';
import { clientError } from '../util/clientError.js';

/**
 * What a workflow may do with nobody watching (schema 40). Absent leaves it as
 * it is; empty or null is the account's default; anything else must be one of
 * the words the loop knows — refused rather than quietly ignored, because a
 * permission somebody believes they set and did not is the wrong way to fail.
 *
 * @returns {string | null | undefined}
 */
function policyFrom(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!UNATTENDED_POLICIES.has(String(value))) throw new Error('Pick one of the permissions: ask, guarded or auto.');
  return String(value);
}

/**
 * The project a workflow is filed under, checked against the account: an id
 * from another account must not attach a run to a shelf it does not own.
 * Absent leaves it; empty or null takes it out of its project.
 *
 * @returns {Promise<string | null | undefined | false>} false when it is not this account's
 */
async function projectFrom(userId, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const id = String(value);
  return (await getStore().getProject(userId, id)) ? id : false;
}

/**
 * Lifted out of server/app.js — see the note on mountWorkspaceRoutes for why.
 *
 * The routes are unchanged: same handlers, same paths, same order. Only their
 * address in the tree moved.
 *
 * @param {import('express').Router} api  the authenticated router
 * @param {{ wrap: Function, body: Function }} ctx
 */
export function mountWorkflowRoutes(api, { wrap, body }) {
  /* ── workflows ──────────────────────────────────────────────────────
   *
   * Session auth throughout, scoped to `req.user.id` on every store call. An id
   * in the path is never trusted to say whose row it is — it only narrows the
   * query that is already scoped, which is what makes a missing row a 404
   * rather than a leak that it exists for somebody else.
   */

  api.get(
    '/workflows',
    wrap(async (req, res) => {
      // One query, not one per workflow. "Which step is it on" is the question
      // this page exists to answer, so the last run has to come with the list —
      // and fetching them in a loop is the N+1 CLAUDE.md §7 names by name.
      const rows = await getStore().listWorkflowsWithLastRun(req.user.id);
      // A step's stored error is the server's sentence; say it in the reader's
      // language, the same as a live one.
      const say = (error) => translateMessage(error, languageOf(req));
      res.json({ workflows: rows.map((row) => withLastRun(row, say)) });
    }),
  );

  api.get(
    '/workflows/:id',
    wrap(async (req, res) => {
      const store = getStore();
      const workflow = await store.getWorkflow(req.user.id, req.params.id);
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
      // The project by name, as a task's page has it: an id tells nobody which shelf.
      const project = workflow.project_id ? await store.getProject(req.user.id, workflow.project_id) : null;
      const say = (error) => translateMessage(error, languageOf(req));
      const runs = (await store.listWorkflowRuns(req.user.id, workflow.id, 10)).map((run) => ({
        ...run,
        steps: Array.isArray(run.steps) ? run.steps.map((s) => (s?.error ? { ...s, error: say(s.error) } : s)) : run.steps,
      }));
      res.json({ workflow, runs, project: project ? { id: project.id, name: project.name } : null });
    }),
  );

  api.post(
    '/workflows',
    wrap(async (req, res) => {
      try {
        // Validate before writing. The task route learned this the hard way: the
        // old order created the row and then returned 400, leaving something
        // empty scheduled to run forever.
        const steps = normaliseSteps(req.body?.steps);
        const tz = validZone(req.body?.tz) ? req.body.tz : null;
        const policy = policyFrom(req.body?.policy) ?? null;
        const projectId = await projectFrom(req.user.id, req.body?.projectId);
        if (projectId === false) return res.status(404).json({ error: 'No such project.' });

        // A workflow with no schedule is legitimate — it is one you run by hand.
        let cron = null;
        let nextRunAt = null;
        if (req.body?.when) {
          ({ cron, nextRunAt } = parseSchedule(req.body.when, { once: req.body?.repeat === false, tz }));
        }

        const workflow = await getStore().createWorkflow(req.user.id, {
          id: crypto.randomUUID(),
          title: String(req.body?.title || '').trim() || 'Workflow',
          steps,
          // Not pinned: each run uses the account's model at the time it runs.
          model: null,
          cron,
          tz,
          nextRunAt,
          policy,
          projectId: projectId ?? null,
        });
        res.status(201).json({ workflow });
      } catch (err) {
        res.status(400).json({ error: clientError(err) });
      }
    }),
  );

  api.patch(
    '/workflows/:id',
    wrap(async (req, res) => {
      try {
        const patch = {};
        if (req.body?.title !== undefined) patch.title = String(req.body.title).trim() || 'Workflow';
        if (req.body?.steps !== undefined) patch.steps = normaliseSteps(req.body.steps);
        if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
        // No `model`: a run uses the account's model at the time (see the create
        // route above), so a stored one would be a setting nothing reads.
        const policy = policyFrom(req.body?.policy);
        if (policy !== undefined) patch.policy = policy;
        const projectId = await projectFrom(req.user.id, req.body?.projectId);
        if (projectId === false) return res.status(404).json({ error: 'No such project.' });
        if (projectId !== undefined) patch.projectId = projectId;

        if (req.body?.when !== undefined) {
          const tz = validZone(req.body?.tz) ? req.body.tz : null;
          if (req.body.when) {
            const { cron, nextRunAt } = parseSchedule(req.body.when, {
              once: req.body?.repeat === false,
              tz,
            });
            Object.assign(patch, { cron, tz, nextRunAt });
          } else {
            // Clearing the schedule leaves the workflow, and it is run by hand.
            Object.assign(patch, { cron: null, nextRunAt: null });
          }
        }

        // The side panel: a time as well as a frequency, and an end date.
        if (req.body?.schedule !== undefined || req.body?.endsOn !== undefined) {
          const current = await getStore().getWorkflow(req.user.id, req.params.id);
          if (!current) return res.status(404).json({ error: 'Workflow not found' });
          Object.assign(patch, schedulePatch(req.body, current));
        }

        const workflow = await getStore().updateWorkflow(req.user.id, req.params.id, patch);
        if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
        res.json({ workflow });
      } catch (err) {
        res.status(400).json({ error: clientError(err) });
      }
    }),
  );

  api.delete(
    '/workflows/:id',
    wrap(async (req, res) => {
      await getStore().deleteWorkflow(req.user.id, req.params.id);
      res.json({ ok: true });
    }),
  );

  /**
   * Run one now, and carry it as far as this invocation can.
   *
   * The request is held open while steps execute, for the same reason
   * `/tasks/run-due` is: on a serverless host the instance is frozen once the
   * response is sent, and a workflow abandoned mid-step is exactly the state
   * this whole feature exists to avoid. What does not fit in the budget is left
   * durably at its cursor for the next nudge.
   */
  // Stopping a run in progress is in routes/automations.js, beside a task's: the Automations
  // page's one Stop button, kept together so the two behave alike.
  api.post(
    '/workflows/:id/run',
    wrap(async (req, res) => {
      try {
        const run = await runWorkflowNow(req.user.id, req.params.id);
        res.json({ run });
      } catch (err) {
        // 409 for "already running" — the client can say something true about
        // it, which a flat 400 would not let it do.
        res.status(err.status || (err.message === 'No such workflow.' ? 404 : 400)).json({ error: clientError(err) });
      }
    }),
  );

}
