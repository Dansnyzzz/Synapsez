import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getPrefs } from './settings.js';
import { runAgent } from './agent.js';
import { nextRunOf } from './scheduler.js';
import { redactSecrets } from './redact.js';
import { TOOLS_BY_NAME } from './tools/definitions.js';

/**
 * Work with several steps that depend on each other, run unattended.
 *
 * A scheduled task is already a full agent turn with the whole tool catalogue,
 * so it can chain work inside that turn. What it cannot do is **survive being
 * cut off**, and that is the entire reason this file exists.
 *
 * `vercel.json` sets `maxDuration: 300` — the ceiling on the free tier. Four
 * steps that each call a model and some tools go past it, and the invocation is
 * killed with the email possibly sent and possibly not. The next firing then
 * starts from the beginning and does everything a second time. The free tier's
 * cron fires once a day, so "it will sort itself out next run" is not a recovery
 * strategy either.
 *
 * So a run keeps its position. Steps execute one at a time in a conversation of
 * their own; the cursor, and the state of every step, is written to the database
 * as it goes. An invocation runs as many steps as fit in its time budget and
 * then stops on purpose, and the next nudge — the daily cron, or the browser —
 * carries on from where it stopped.
 *
 * Step N sees steps 1..N-1 because they are all in the same transcript. That is
 * the whole dependency mechanism: no variables, no passing of results, and the
 * finished job reads like an ordinary conversation because it is one.
 */

/**
 * How long to keep starting new steps in one invocation.
 *
 * Under `maxDuration: 300`, leaving 100s of headroom means the run can always
 * finish writing its own state and answer the request, rather than being killed
 * with the row still saying `running`.
 *
 * The check happens *before* a step starts, never during one — a step is an
 * agent turn and is not interruptible half way. A step that begins at 199s and
 * takes three minutes will still be cut off, which is what the `unknown` state
 * below is for.
 */
export const START_BUDGET_MS = 200_000;

/**
 * How long a claim holds. Longer than the start budget on purpose: a single
 * step may legitimately run well past the point where we stop starting new
 * ones, and a lease that expired underneath a live step would let a second
 * invocation declare it lost while it was still working.
 */
export const LEASE_MS = 10 * 60_000;

/** How many times a step cut off by the time limit is picked up again before it waits for a person. */
export const MAX_RESUMES = 3;

/**
 * The change-making calls of the current step that were cut off before their
 * result came back — the only ones nobody can say happened or not.
 *
 * Read from the step's own part of the conversation: everything after the
 * last time its instruction was given. A read-only call without a result is
 * not listed; resuming simply reads again.
 */
export async function interruptedChanges(userId, chatId, instruction) {
  const messages = await getStore().listMessages(userId, chatId);
  let from = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && String(messages[i].text || '').trim() === String(instruction || '').trim()) {
      from = i;
      break;
    }
  }
  const answered = new Set();
  for (const m of messages.slice(from + 1)) {
    if (m.role === 'tool') for (const r of m.results || []) answered.add(String(r.toolCallId));
  }
  const unclear = [];
  for (const m of messages.slice(from + 1)) {
    if (m.role !== 'assistant') continue;
    for (const call of m.toolCalls || []) {
      if (answered.has(String(call.id))) continue;
      if (TOOLS_BY_NAME[call.name]?.readOnly === true) continue;
      unclear.push(call.name);
    }
  }
  return [...new Set(unclear)];
}

const nowIso = () => new Date().toISOString();
const leaseUntil = (ms = LEASE_MS) => new Date(Date.now() + ms).toISOString();

/** The step list as stored, normalised — an id per step so state can name it. */
export function normaliseSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error('A workflow needs at least one step.');
  }
  if (steps.length > 20) {
    throw new Error('A workflow is capped at 20 steps. Split it, or make a step do more.');
  }
  return steps.map((step, i) => {
    const instruction = String(typeof step === 'string' ? step : step?.instruction || '').trim();
    if (!instruction) throw new Error(`Step ${i + 1} has no instruction.`);
    return { id: step?.id || `s${i + 1}`, instruction };
  });
}

/** The per-run state that mirrors a definition, before anything has run. */
const freshState = (steps) =>
  steps.map((s) => ({ id: s.id, status: 'pending', started_at: null, finished_at: null, summary: '', error: '' }));

/**
 * Run one step as an ordinary agent turn, and report what became of it.
 *
 * `runAgent` communicates by emitting rather than returning, so this listens for
 * the four outcomes that matter to an unattended run and translates them into a
 * step status. The distinction that earns its keep is `approval_required`:
 * nobody is here to approve, so the honest answer is that the run needs a
 * person — not that it failed, and certainly not that it finished.
 */
async function runStep({ user, chatId, modelId, instruction, resume = false }) {
  const store = getStore();

  if (!resume) {
    await store.appendMessage(user.id, chatId, {
      id: crypto.randomUUID(),
      role: 'user',
      text: instruction,
    });
  }

  /**
   * Everything captured here is written to the database and read back later —
   * by the shelf, and by `workflow_status` into the model's own context. A
   * provider that quotes a malformed key into its error message would put that
   * key in all three, so it is stripped on the way in rather than on the way
   * out of any one of them.
   */
  const clean = (text, max) => redactSecrets(String(text ?? '')).text.slice(0, max);

  let error = '';
  let summary = '';
  let stopReason = '';
  let awaitingApproval = false;

  try {
    await runAgent({
      userId: user.id,
      user,
      chatId,
      modelId,
      unattended: true,
      emit(event, data) {
        if (event === 'error') error = clean(data?.message || 'failed', 400);
        // A question stops a step exactly as an approval does: nobody is there.
        else if (event === 'approval_required' || event === 'question_required') awaitingApproval = true;
        else if (event === 'done') stopReason = String(data?.stopReason || '');
        else if (event === 'message' && data?.message?.role === 'assistant' && data.message.text) {
          summary = clean(data.message.text, 2_000);
        }
      },
    });
  } catch (err) {
    error = clean(err?.message || err, 400);
  }

  if (error) return { status: 'failed', summary, error };
  if (awaitingApproval) {
    return {
      status: 'needs_attention',
      summary,
      error:
        'A tool in this step needs approval and nobody is watching. Approve it in the ' +
        'conversation, or set the approval policy to allow it, then run the workflow again.',
    };
  }
  if (stopReason === 'max_steps') {
    return {
      status: 'failed',
      summary,
      error: 'The step ran out of agent steps before finishing. Split it into smaller steps.',
    };
  }
  return { status: 'done', summary, error: '' };
}

/**
 * Begin a run: one conversation, one row, nothing executed yet.
 *
 * Deliberately separate from executing it. Creating the run is what makes the
 * work durable, and it must happen before any step does anything, so that a
 * crash one second later still leaves a record saying what was meant to happen.
 */
export async function startRun(userId, workflow, { chatTitle } = {}) {
  const store = getStore();
  const steps = normaliseSteps(workflow.steps);
  const prefs = await getPrefs(userId);

  /**
   * One conversation per workflow, not one per run.
   *
   * A daily workflow made a new conversation every morning, so a month of it
   * was thirty near-identical entries in the sidebar. Each run now continues
   * the conversation the last one wrote into, and only a workflow that has
   * never run — or whose conversation was deleted — gets a new one.
   */
  const [previous] = await store.listWorkflowRuns(userId, workflow.id, 1);
  const reuse = previous?.chat_id && (await store.getChat(userId, previous.chat_id)) ? previous.chat_id : null;

  /*
   * A new day's run starts from the beginning whatever became of the last one.
   * An older run still open — waiting for a person, or left mid-step — is
   * closed first, so it is never picked up again to write into the same
   * conversation alongside the new run. One actively held by another
   * invocation is left to finish what it is doing.
   */
  for (const old of await store.listWorkflowRuns(userId, workflow.id, 5)) {
    const held = old.lease_until && new Date(old.lease_until).getTime() > Date.now();
    if ((old.status === 'needs_attention' || old.status === 'running') && !held) {
      await store.saveWorkflowRun(old.id, { status: 'cancelled', leaseUntil: null, finished: true }).catch(() => {});
    }
  }
  const chatId = reuse || crypto.randomUUID();

  if (!reuse) {
    await store.createChat(userId, {
      id: chatId,
      title: chatTitle || workflow.title,
      model: prefs.defaultModel,
    });
  }

  return store.createWorkflowRun(userId, {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    chatId,
    status: 'running',
    steps: freshState(steps),
    cursor: 0,
    leaseUntil: null,
  });
}

/**
 * Carry one claimed run forward as far as the time budget allows.
 *
 * The caller must already hold the lease. On return the run is either finished
 * or explicitly released, so nothing is left claimed by a process that has
 * stopped working on it.
 */
export async function advanceRun(run, { deadline = Date.now() + START_BUDGET_MS } = {}) {
  const store = getStore();
  const user = await store.getUserById(run.user_id);
  const workflow = user ? await store.getWorkflow(run.user_id, run.workflow_id) : null;

  if (!user || !workflow) {
    // The account or the definition went away between the claim and now.
    return store.saveWorkflowRun(run.id, {
      status: 'cancelled',
      leaseUntil: null,
      finished: true,
    });
  }

  const definition = normaliseSteps(workflow.steps);
  const state = Array.isArray(run.steps) ? run.steps.map((s) => ({ ...s })) : freshState(definition);

  /**
   * A step left mid-flight is never re-run.
   *
   * Reaching here with a step still marked `running` means the invocation that
   * started it did not come back. Nobody can say whether it sent the email, and
   * repeating a side effect with no one watching is worse than stopping to ask —
   * so the step is marked unknown and the run waits for a person.
   */
  const orphan = state.findIndex((s) => s.status === 'running');
  /**
   * …unless nothing it was doing can have changed anything.
   *
   * The 300s ceiling cuts long steps off as a matter of course — a deep
   * research step is three minutes of reading — and stopping every one of
   * them for a person meant no workflow with a long step ever finished on its
   * own. The agent loop resumes a turn exactly where it stopped: finished
   * calls keep their results, reads are simply read again, and a call that
   * changes something is never run a second time. So the step carries on,
   * and it is held for a person only when a change-making call was cut off
   * before its result came back — the one case where nobody can say whether
   * it happened. Three attempts, then it stops.
   */
  let resuming = false;
  if (orphan >= 0) {
    const attempts = (Number(state[orphan].attempts) || 0) + 1;
    // No transcript to read means nothing can be said about what happened.
    const readable = run.chat_id && (await store.getChat(user.id, run.chat_id));
    const unclear = readable ? await interruptedChanges(user.id, run.chat_id, definition[orphan]?.instruction) : null;
    if (!unclear || unclear.length || attempts > MAX_RESUMES) {
      state[orphan] = {
        ...state[orphan],
        status: 'unknown',
        finished_at: nowIso(),
        error: unclear?.length
          ? `This step was interrupted while ${unclear.join(', ')} was running. It is not repeated automatically, because ` +
            'there is no way to tell whether that had already happened.'
          : unclear
            ? `This step was interrupted ${MAX_RESUMES} times and was not resumed again. Split it into smaller steps.`
            : 'This step was interrupted while running. It is not repeated automatically, because ' +
              'there is no way to tell whether what it does had already happened.',
      };
      return store.saveWorkflowRun(run.id, {
        status: 'needs_attention',
        steps: state,
        leaseUntil: null,
        finished: true,
      });
    }
    state[orphan] = { ...state[orphan], status: 'pending', attempts };
    resuming = true;
  }

  let cursor = Number(run.cursor) || 0;
  /**
   * The account's model now, not the one it was on when the workflow was made —
   * the same rule as scheduled tasks (see `runTask`). `workflow.model` used to
   * win, which is how a workflow made on a stealth preview kept failing with
   * "404 No endpoints found" after the preview closed. Null lets the agent loop
   * follow the account, move it to Auto when its model has gone, and switch
   * mid-step when the provider says so.
   */
  const modelId = null;

  /**
   * The conversation a run writes into can be gone by the time a step starts.
   *
   * It is created empty, and the sidebar hides empty conversations only while
   * nothing is running in them — so a run created by the clock and advanced by
   * a later nudge can find that somebody deleted it in between. That used to
   * fail the step with "Chat not found", which reads as the workflow being
   * broken. The conversation is only where the output goes, so it is made
   * again under the same id, and what earlier steps concluded is written into
   * it so the next step still sees their results.
   */
  if (run.chat_id && !(await store.getChat(user.id, run.chat_id))) {
    const prefs = await getPrefs(user.id);
    await store.createChat(user.id, { id: run.chat_id, title: workflow.title, model: prefs.defaultModel });
    const earlier = state
      .slice(0, cursor)
      .map((s, i) => (s.summary ? `Step ${i + 1}: ${s.summary}` : ''))
      .filter(Boolean);
    if (earlier.length) {
      await store.appendMessage(user.id, run.chat_id, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Results of the earlier steps:\n\n${earlier.join('\n\n')}`,
      });
    }
  }

  while (cursor < definition.length) {
    // Checked before starting, never during: an agent turn cannot be stopped
    // half way, so the honest thing is not to begin one we cannot afford.
    if (Date.now() >= deadline) {
      return store.saveWorkflowRun(run.id, { steps: state, cursor, leaseUntil: null });
    }

    state[cursor] = { ...state[cursor], status: 'running', started_at: nowIso() };
    await store.saveWorkflowRun(run.id, { steps: state, cursor, leaseUntil: leaseUntil() });

    /**
     * Hold the lease for as long as the step actually takes.
     *
     * It was taken once, for ten minutes, and never renewed — so a step that ran
     * longer than that had its claim expire underneath it while it was still
     * working. The next nudge would then find an unclaimed run whose current step
     * says `running`, conclude the invocation that started it had died, and mark
     * the whole run `unknown` for a person to sort out. Two processes on the same
     * run, and a job stopped for no reason.
     *
     * On a deployment the 300s function ceiling hides this; a local run has no
     * ceiling at all, and a step that drives a browser through a slow site
     * genuinely passes ten minutes. Renewing on a timer costs one small update a
     * minute and removes the whole class.
     *
     * `unref` so a pending tick can never be the thing keeping the process alive.
     */
    const heartbeat = setInterval(() => {
      store.saveWorkflowRun(run.id, { leaseUntil: leaseUntil() }).catch(() => {});
    }, 60_000);
    heartbeat.unref?.();

    let outcome;
    try {
      outcome = await runStep({
        user,
        chatId: run.chat_id,
        modelId,
        instruction: definition[cursor].instruction,
        // A step cut off last time carries on in its own transcript; its
        // instruction is already there and is not sent a second time.
        resume: resuming,
      });
    } finally {
      clearInterval(heartbeat);
    }
    resuming = false;

    state[cursor] = {
      ...state[cursor],
      status: outcome.status,
      finished_at: nowIso(),
      summary: outcome.summary,
      error: outcome.error,
    };

    if (outcome.status !== 'done') {
      return store.saveWorkflowRun(run.id, {
        status: outcome.status === 'needs_attention' ? 'needs_attention' : 'failed',
        steps: state,
        cursor,
        leaseUntil: null,
        finished: true,
      });
    }

    cursor += 1;
    await store.saveWorkflowRun(run.id, { steps: state, cursor, leaseUntil: leaseUntil() });
  }

  return store.saveWorkflowRun(run.id, {
    status: 'done',
    steps: state,
    cursor,
    leaseUntil: null,
    finished: true,
  });
}

/**
 * Runs that stopped for a person when they did not need to.
 *
 * Before steps could be resumed, every step cut off by the time limit parked
 * its run as "interrupted — not repeated", reading-only steps included — the
 * morning report's deep-research step among them, which then sat waiting for
 * somebody until the next morning. A parked run whose interrupted step did
 * nothing that changes anything is put back in the queue, and the step
 * carries on where it stopped (see the orphan handling in `advanceRun`). Only
 * the newest run of its workflow, so a fresh run is never raced by an old one.
 */
export async function recoverParkedRuns({ limit = 5 } = {}) {
  const store = getStore();
  const reopened = [];
  for (const run of await store.listParkedWorkflowRuns({ limit }).catch(() => [])) {
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const at = steps.findIndex((s) => s.status === 'unknown');
    if (at < 0 || (Number(steps[at].attempts) || 0) >= MAX_RESUMES || !run.chat_id) continue;
    const [newest] = await store.listWorkflowRuns(run.user_id, run.workflow_id, 1);
    if (newest?.id !== run.id) continue;
    const workflow = await store.getWorkflow(run.user_id, run.workflow_id);
    if (!workflow || !(await store.getChat(run.user_id, run.chat_id))) continue;
    const instruction = normaliseSteps(workflow.steps)[at]?.instruction;
    if ((await interruptedChanges(run.user_id, run.chat_id, instruction)).length) continue;
    const fixed = steps.map((s, i) => (i === at ? { ...s, status: 'running', error: '', finished_at: null } : s));
    if (await store.reopenWorkflowRun(run.id, fixed)) reopened.push(run.id);
  }
  return reopened;
}

/**
 * Everything that is due, and everything already in flight.
 *
 * Two phases on purpose. Due workflows only *create* runs — cheap, and it means
 * a schedule that fires while the budget is already spent still leaves a durable
 * record that it was meant to run. Executing is the second phase, and it works
 * the same queue whether a run was made a second ago or left half-finished
 * yesterday.
 */
export async function runDueWorkflows({ limit = 3, userId = null, budgetMs = START_BUDGET_MS } = {}) {
  const store = getStore();
  const deadline = Date.now() + budgetMs;
  const started = [];
  const advanced = [];

  // Runs parked for no good reason go back in the queue first, so the loop
  // below picks them up in this same pass.
  await recoverParkedRuns().catch(() => []);

  for (let i = 0; i < limit; i += 1) {
    const workflow = await store.claimDueWorkflow(nowIso(), userId);
    if (!workflow) break;
    try {
      const run = await startRun(workflow.user_id, workflow);
      started.push({ workflowId: workflow.id, runId: run.id });
    } catch (err) {
      // A definition that cannot start (no steps, deleted account) must not stop
      // the queue for everyone else.
      started.push({ workflowId: workflow.id, error: String(err?.message || err).slice(0, 200) });
    }
    // Set the real next run now that the claim is safely taken. A one-shot
    // workflow has no cron and simply stops being due.
    // Null for a one-off, and for a repeat whose end date has passed.
    const next = nextRunOf(workflow);
    await store.updateWorkflow(workflow.user_id, workflow.id, {
      nextRunAt: next,
      ...(next ? {} : { enabled: false }),
    });
  }

  for (let i = 0; i < limit; i += 1) {
    if (Date.now() >= deadline) break;
    const run = await store.claimWorkflowRun({ now: nowIso(), leaseUntil: leaseUntil(), userId });
    if (!run) break;
    const done = await advanceRun(run, { deadline });
    advanced.push({ runId: run.id, status: done?.status, cursor: done?.cursor });
  }

  return { started, advanced };
}

/**
 * Start a workflow now, by hand, and take it as far as one invocation allows.
 *
 * Two things this has to get right, and both were got wrong first time.
 *
 * It claims **the run it just created, by id**. Claiming "the next open run"
 * takes the oldest one in the queue instead — some other workflow, quite likely
 * — and then, on finding it was not the one wanted, walks away having just put a
 * ten-minute lease on it. One press of a button would stall an unrelated job and
 * do nothing visible.
 *
 * And it refuses to start a second run of a workflow already going. The lease
 * stops two processes working the same run; nothing stopped a second *run* of
 * the same definition, so an impatient second press bought a second set of model
 * calls and a second email.
 */
export async function runWorkflowNow(userId, workflowId, { budgetMs = START_BUDGET_MS } = {}) {
  const store = getStore();
  const workflow = await store.getWorkflow(userId, workflowId);
  if (!workflow) throw new Error('No such workflow.');

  const already = await store.openWorkflowRun(userId, workflowId);
  if (already) {
    const err = new Error(
      'This workflow is already running. It carries on where it left off on its own — wait for it, ' +
        'rather than starting a second copy that would repeat every step.',
    );
    err.status = 409;
    throw err;
  }

  /**
   * Same reasoning as `runTaskNow`: a run by hand must not leave a passed
   * `next_run_at` behind for the next sweep to fire automatically. A workflow
   * sends email and posts to Slack; a surprise second run of one is worse than
   * a skipped occurrence.
   */
  const next = nextRunOf(workflow);
  if (next) await store.updateWorkflow(userId, workflow.id, { nextRunAt: next });

  const run = await startRun(userId, workflow);
  const claimed = await store.claimWorkflowRun({
    now: nowIso(),
    leaseUntil: leaseUntil(),
    userId,
    id: run.id,
  });

  // Something else claimed it in the moment between creating it and asking for
  // it. It is durable and queued, so say so rather than racing.
  if (!claimed) return run;

  return advanceRun(claimed, { deadline: Date.now() + budgetMs });
}

export const __testing = { runStep, freshState };
