/**
 * Workflows: work with several steps that must survive being cut off.
 *
 * The failure this suite exists to prevent is the expensive one. A scheduled
 * task that dies half way is re-run from the beginning next time, and if one of
 * its steps sent an email, it sends it again. A workflow keeps its position
 * instead — and, crucially, **refuses to repeat a step it cannot prove
 * finished**. Both of those are logic with no model in it, so both are testable
 * here.
 *
 * What is *not* covered, and is said plainly rather than implied: executing a
 * step against a live model. `runAgent` resolves its provider internally and
 * takes no injection, so the happy path of a step that calls a model and
 * succeeds needs a real key and is not exercised here. The failure path is —
 * with no key configured, a step fails, and this asserts that the run then stops
 * rather than marching on to step two.
 *
 *   node test/workflow.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'workflow-test-encryption-key';
process.env.SESSION_SECRET ||= 'workflow-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-workflow-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { normaliseSteps, advanceRun, startRun, runWorkflowNow } = await import('../server/workflows.js');

const PORT = 5214;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an HTML error page is a fine thing to assert on as text */
      }
      return { status: res.status, body: json, text };
    },
  };
}

const alice = jar();
await alice.call('POST', '/api/register', {
  name: 'Alice',
  email: 'alice@workflow.test',
  password: 'a-long-enough-password',
});

const bob = jar();
await bob.call('POST', '/api/register', {
  name: 'Bob',
  email: 'bob@workflow.test',
  password: 'a-long-enough-password',
});

/* ── the definition ────────────────────────────────────────────── */

section('a workflow is an ordered list of instructions');
{
  let refused = '';
  try {
    normaliseSteps([]);
  } catch (err) {
    refused = err.message;
  }
  check('an empty workflow is refused', /at least one step/.test(refused), refused);

  try {
    refused = '';
    normaliseSteps(['do a thing', '   ']);
  } catch (err) {
    refused = err.message;
  }
  check('and so is a blank step', /Step 2 has no instruction/.test(refused), refused);

  try {
    refused = '';
    normaliseSteps(Array.from({ length: 21 }, (_, i) => `step ${i}`));
  } catch (err) {
    refused = err.message;
  }
  check('twenty-one steps is too many', /capped at 20/.test(refused), refused);

  const ok = normaliseSteps(['pull the numbers', { instruction: 'chart them' }]);
  check('strings and objects both work', ok.length === 2 && ok[1].instruction === 'chart them');
  check('and every step gets an id', ok.every((s) => !!s.id), JSON.stringify(ok));
}

let workflowId;
section('creating one over HTTP');
{
  const bad = await alice.call('POST', '/api/workflows', { title: 'Nothing', steps: [] });
  check('no steps is a 400 with a sentence', bad.status === 400 && /at least one step/.test(bad.body?.error || ''), `${bad.status}`);

  const made = await alice.call('POST', '/api/workflows', {
    title: 'Monday sales pack',
    steps: ['Pull last week’s numbers', 'Chart them', 'Email the chart to the team'],
    when: 'mon 09:00',
    tz: 'Asia/Ho_Chi_Minh',
  });
  workflowId = made.body?.workflow?.id;
  check('creating one works', made.status === 201 && !!workflowId, `${made.status}`);
  check('the steps are stored in order', made.body?.workflow?.steps?.[2]?.instruction === 'Email the chart to the team');
  check('the schedule is parsed', made.body?.workflow?.cron === 'mon 09:00', made.body?.workflow?.cron);
  check('in the zone it was written in', made.body?.workflow?.tz === 'Asia/Ho_Chi_Minh');

  const byHand = await alice.call('POST', '/api/workflows', {
    title: 'On demand',
    steps: ['Do the thing'],
  });
  check('a workflow with no schedule is allowed', byHand.status === 201, `${byHand.status}`);
  check('and simply has no next run', byHand.body?.workflow?.next_run_at === null);

  const listed = await alice.call('GET', '/api/workflows');
  check('both appear on the list', listed.body?.workflows?.length === 2);
  check('with no run yet', listed.body?.workflows?.[0]?.lastRun === null);
}

section('changing one');
{
  const paused = await alice.call('PATCH', `/api/workflows/${workflowId}`, { enabled: false });
  check('pausing works', paused.body?.workflow?.enabled === false);
  check('and does not touch the steps', paused.body?.workflow?.steps?.length === 3, 'a patch must not rewrite what it was not asked to');

  const restepped = await alice.call('PATCH', `/api/workflows/${workflowId}`, {
    steps: ['Pull the numbers', 'Send them'],
    enabled: true,
  });
  check('steps can be replaced', restepped.body?.workflow?.steps?.length === 2);

  const bad = await alice.call('PATCH', `/api/workflows/${workflowId}`, { steps: [] });
  check('but not with nothing', bad.status === 400, `${bad.status}`);

  const unscheduled = await alice.call('PATCH', `/api/workflows/${workflowId}`, { when: '' });
  check('clearing the schedule leaves the workflow', unscheduled.body?.workflow?.cron === null);
}

/* ── one account cannot reach another's ─────────────────────────── */

section('tenancy');
{
  const seen = await bob.call('GET', `/api/workflows/${workflowId}`);
  check("another account gets 404, not 403", seen.status === 404, `${seen.status}`);

  const patched = await bob.call('PATCH', `/api/workflows/${workflowId}`, { enabled: false });
  check('and cannot change it', patched.status === 404, `${patched.status}`);

  const ran = await bob.call('POST', `/api/workflows/${workflowId}/run`);
  check('nor run it', ran.status === 404, `${ran.status}`);

  await bob.call('DELETE', `/api/workflows/${workflowId}`);
  const stillThere = await alice.call('GET', `/api/workflows/${workflowId}`);
  check('a delete from the wrong account deletes nothing', stillThere.status === 200, `${stillThere.status}`);

  const bobsList = await bob.call('GET', '/api/workflows');
  check("and the list is only one's own", bobsList.body?.workflows?.length === 0);

  const anonymous = await fetch(`${base}/api/workflows`);
  check('signed out reaches nothing', anonymous.status === 401, `${anonymous.status}`);
}

/* ── the part that matters: being interrupted ───────────────────── */

const aliceUser = (await store.listUsers?.())?.find?.((u) => u.email === 'alice@workflow.test');
const aliceId = aliceUser?.id || (await store.getUserByEmail('alice@workflow.test')).id;

section('a step left mid-flight is never repeated');
{
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-orphan',
    title: 'Interrupted',
    steps: normaliseSteps(['send the invoice', 'file a copy']),
    nextRunAt: null,
  });

  // Exactly the state a killed invocation leaves behind: step one claimed and
  // started, nothing written after it.
  const run = await store.createWorkflowRun(aliceId, {
    id: 'run-orphan',
    workflowId: workflow.id,
    chatId: null,
    status: 'running',
    steps: [
      { id: 's1', status: 'running', started_at: new Date().toISOString(), finished_at: null, summary: '', error: '' },
      { id: 's2', status: 'pending', started_at: null, finished_at: null, summary: '', error: '' },
    ],
    cursor: 0,
  });

  const after = await advanceRun(run, { deadline: Date.now() + 60_000 });

  check('the run stops for a person', after.status === 'needs_attention', after.status);
  check('the interrupted step is marked unknown', after.steps[0].status === 'unknown', after.steps[0].status);
  check('and says why in a sentence', /no way to tell whether/.test(after.steps[0].error || ''), after.steps[0].error);
  check('the step after it never ran', after.steps[1].status === 'pending', after.steps[1].status);
  check('the lease is released', after.lease_until === null);
  check('and the run is finished, not left open', !!after.finished_at);
}


section('a step cut off while only reading carries on by itself');
{
  /*
   * The report: a deep_research step ran past the 300s ceiling, came back as
   * "interrupted — not repeated", and the workflow sat waiting for a person.
   * Reading has nothing to repeat by accident, so such a step resumes.
   */
  const { interruptedChanges, MAX_RESUMES } = await import('../server/workflows.js');
  const steps = ['research the market', 'email the summary'];
  const workflow = await store.createWorkflow(aliceId, { id: 'wf-resume', title: 'Resume', steps: normaliseSteps(steps), nextRunAt: null });
  const chat = await store.createChat(aliceId, { id: 'c-resume', title: 'Resume' });
  await store.appendMessage(aliceId, chat.id, { id: 'u-r1', role: 'user', text: steps[0] });
  await store.appendMessage(aliceId, chat.id, {
    id: 'a-r1',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'dr1', name: 'deep_research', input: { question: 'what moved the market' } }],
  });

  check('a read cut off before its result is not an unclear change', (await interruptedChanges(aliceId, chat.id, steps[0])).length === 0);

  const run = await store.createWorkflowRun(aliceId, {
    id: 'run-resume',
    workflowId: workflow.id,
    chatId: chat.id,
    status: 'running',
    steps: [
      { id: 's1', status: 'running', started_at: new Date().toISOString(), finished_at: null, summary: '', error: '' },
      { id: 's2', status: 'pending', started_at: null, finished_at: null, summary: '', error: '' },
    ],
    cursor: 0,
  });
  const after = await advanceRun(run, { deadline: Date.now() + 60_000 });
  // No key in the test environment, so the resumed step fails on that — what
  // matters is that it was picked up again rather than parked as unknown.
  check('the step is picked up again, not parked as unknown', after.steps[0].status !== 'unknown', `${after.steps[0].status}: ${after.steps[0].error}`);
  check('  counting the attempt', after.steps[0].attempts === 1, String(after.steps[0].attempts));
  const transcript = await store.listMessages(aliceId, chat.id);
  check('  without giving its instruction a second time', transcript.filter((m) => m.role === 'user' && m.text === steps[0]).length === 1);

  await store.appendMessage(aliceId, chat.id, {
    id: 'a-r2',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'em1', name: 'send_email', input: { subject: 'x', body: 'y' } }],
  });
  check('a change cut off before its result is named', (await interruptedChanges(aliceId, chat.id, steps[0])).join() === 'send_email');
  const held = await advanceRun(
    await store.createWorkflowRun(aliceId, {
      id: 'run-resume-2',
      workflowId: workflow.id,
      chatId: chat.id,
      status: 'running',
      steps: [{ id: 's1', status: 'running', started_at: new Date().toISOString() }, { id: 's2', status: 'pending' }],
      cursor: 0,
    }),
    { deadline: Date.now() + 60_000 },
  );
  check('  and that step waits for a person', held.status === 'needs_attention' && held.steps[0].status === 'unknown', held.status);
  check('  saying which call it was', /send_email/.test(held.steps[0].error || ''), held.steps[0].error);

  const tired = await advanceRun(
    await store.createWorkflowRun(aliceId, {
      id: 'run-resume-3',
      workflowId: workflow.id,
      chatId: 'c-resume-none',
      status: 'running',
      steps: [{ id: 's1', status: 'running', attempts: MAX_RESUMES }, { id: 's2', status: 'pending' }],
      cursor: 0,
    }),
    { deadline: Date.now() + 60_000 },
  );
  check(`after ${MAX_RESUMES} resumes it stops for a person`, tired.status === 'needs_attention', tired.status);
}

section('a run stops at its time budget rather than half way through a step');
{
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-budget',
    title: 'Long one',
    steps: normaliseSteps(['step one', 'step two']),
    nextRunAt: null,
  });
  const run = await store.createWorkflowRun(aliceId, {
    id: 'run-budget',
    workflowId: workflow.id,
    chatId: null,
    status: 'running',
    steps: [
      { id: 's1', status: 'pending', started_at: null, finished_at: null, summary: '', error: '' },
      { id: 's2', status: 'pending', started_at: null, finished_at: null, summary: '', error: '' },
    ],
    cursor: 0,
  });

  // A deadline already in the past: no step may be started at all.
  const after = await advanceRun(run, { deadline: Date.now() - 1 });

  check('nothing was started', after.steps.every((s) => s.status === 'pending'), JSON.stringify(after.steps.map((s) => s.status)));
  check('the run stays open for the next nudge', after.status === 'running', after.status);
  check('the cursor is preserved', after.cursor === 0, `${after.cursor}`);
  check('the lease is released so another invocation may take it', after.lease_until === null);
  check('and it is not marked finished', !after.finished_at);
}

section('the lease is what stops two invocations running the same steps');
{
  const soon = new Date(Date.now() + 60_000).toISOString();
  const first = await store.claimWorkflowRun({ now: new Date().toISOString(), leaseUntil: soon, userId: aliceId });
  check('one invocation claims the open run', first?.id === 'run-budget', first?.id);

  const second = await store.claimWorkflowRun({ now: new Date().toISOString(), leaseUntil: soon, userId: aliceId });
  check('a second one finds nothing to take', second === null, second?.id);

  const later = new Date(Date.now() + 120_000).toISOString();
  const afterExpiry = await store.claimWorkflowRun({ now: later, leaseUntil: soon, userId: aliceId });
  check('but once the lease expires it may be picked up', afterExpiry?.id === 'run-budget', afterExpiry?.id);
}

section('a definition that has gone away cancels its run');
{
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-gone',
    title: 'Doomed',
    steps: normaliseSteps(['do something']),
    nextRunAt: null,
  });
  const run = await store.createWorkflowRun(aliceId, {
    id: 'run-gone',
    workflowId: workflow.id,
    chatId: null,
    status: 'running',
    steps: [{ id: 's1', status: 'pending', started_at: null, finished_at: null, summary: '', error: '' }],
    cursor: 0,
  });
  await store.deleteWorkflow(aliceId, workflow.id);

  const after = await store.getWorkflowRun(aliceId, run.id);
  check('deleting the workflow takes its runs with it', after === null, 'ON DELETE CASCADE');
}

section('a failing step stops the run instead of marching on');
{
  // No provider key is configured in this suite, so the first step cannot reach
  // a model. What is asserted is not the error text but the shape of the
  // response to it: step one fails, step two is never attempted.
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-fail',
    title: 'No key here',
    steps: normaliseSteps(['ask the model something', 'then do something else']),
    nextRunAt: null,
  });

  const run = await startRun(aliceId, workflow);
  check('starting a run creates its conversation first', !!run.chat_id, 'durable before anything executes');

  const after = await advanceRun(run, { deadline: Date.now() + 60_000 });
  check('the run is marked failed', after.status === 'failed', after.status);
  check('step one records what went wrong', !!after.steps[0].error, after.steps[0].error?.slice(0, 60));
  check('step two was never attempted', after.steps[1].status === 'pending', after.steps[1].status);
  check('and the lease is released', after.lease_until === null);
}

section('a run uses the model the account is on now, not the one it was made on');
{
  // The owner's workflow failed every morning with "404 No endpoints found for
  // stealth/space-bunny-alpha": the model it was made on was pinned to it and
  // kept being called after it was withdrawn. Pinned to OpenRouter here, with
  // the account on an Anthropic model — and no key for either in this suite, so
  // the step's error names whichever provider it actually tried.
  const { setPrefs } = await import('../server/settings.js');
  await setPrefs(aliceId, { defaultModel: 'anthropic/claude-opus-5' });
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-follows-account',
    title: 'Made on a stealth preview',
    steps: normaliseSteps(['ask the model something']),
    model: 'openrouter/stealth/space-bunny-alpha',
    nextRunAt: null,
  });
  const run = await startRun(aliceId, workflow);
  const after = await advanceRun(run, { deadline: Date.now() + 60_000 });
  const said = String(after.steps[0].error || '');
  check('the step is run on the account\'s model', /Anthropic/i.test(said) && !/OpenRouter/i.test(said), said.slice(0, 120));

  // And a workflow made now is not pinned to anything at all.
  const made = await alice.call('POST', '/api/workflows', { title: 'Fresh', steps: ['do a thing'] });
  check('a new workflow is not pinned to a model', made.status === 201 && made.body?.workflow?.model == null, JSON.stringify(made.body?.workflow?.model));
}

/* ── the mistakes found by auditing the first version ───────────── */

section('a second press does not start a second run');
{
  const wf = await store.createWorkflow(aliceId, {
    id: 'wf-twice',
    title: 'Only once',
    steps: normaliseSteps(['ask the model something']),
    nextRunAt: null,
  });

  // Left open, exactly as a run part-way through its steps would be.
  await store.createWorkflowRun(aliceId, {
    id: 'run-open',
    workflowId: wf.id,
    chatId: null,
    status: 'running',
    steps: [{ id: 's1', status: 'pending' }],
    cursor: 0,
  });

  let refused = null;
  try {
    await runWorkflowNow(aliceId, wf.id);
  } catch (err) {
    refused = err;
  }
  check('starting it again is refused', /already running/.test(refused?.message || ''), refused?.message);
  check('  as a 409, so the client can say something true', refused?.status === 409, `${refused?.status}`);
  check(
    '  and no second run was created',
    (await store.listWorkflowRuns(aliceId, wf.id, 10)).length === 1,
    'a second press must not buy a second set of model calls',
  );
}

section('running by hand claims its own run, not the oldest one');
{
  /*
   * The first version claimed "the next open run", which is ordered oldest
   * first — so pressing Run now took somebody else's queued run, discovered it
   * was the wrong one, and walked away having just leased it for ten minutes.
   */
  const older = await store.createWorkflow(aliceId, {
    id: 'wf-older',
    title: 'Queued yesterday',
    steps: normaliseSteps(['step']),
    nextRunAt: null,
  });
  await store.createWorkflowRun(aliceId, {
    id: 'run-older',
    workflowId: older.id,
    chatId: null,
    status: 'running',
    steps: [{ id: 's1', status: 'pending' }],
    cursor: 0,
  });

  const mine = await store.createWorkflow(aliceId, {
    id: 'wf-mine',
    title: 'Pressed just now',
    steps: normaliseSteps(['step']),
    nextRunAt: null,
  });

  await runWorkflowNow(aliceId, mine.id).catch(() => null);

  const [minesRun] = await store.listWorkflowRuns(aliceId, mine.id, 1);
  check('the run that was pressed is the one that moved', minesRun?.status !== 'running', minesRun?.status);

  const untouched = await store.getWorkflowRun(aliceId, 'run-older');
  check('the older run was not claimed', untouched.status === 'running', untouched.status);
  check(
    '  and is not left leased by a process that walked away',
    untouched.lease_until === null,
    `${untouched.lease_until}`,
  );
}

section('the shelf gets every last run in one query');
{
  const rows = await store.listWorkflowsWithLastRun(aliceId);
  check('every workflow comes back', rows.length >= 3, `${rows.length}`);

  const withRun = rows.find((r) => r.id === 'wf-mine');
  check('one that has run carries its run', !!withRun?.run_id, withRun?.run_id);
  check('  with the per-step state, which is the point', Array.isArray(withRun?.run_steps), typeof withRun?.run_steps);

  const neverRun = rows.find((r) => r.id === 'wf-twice');
  check('one that has an open run carries that', !!neverRun?.run_id);

  // The join must not multiply rows: one line per workflow, however many runs
  // it has had.
  await store.createWorkflowRun(aliceId, {
    id: 'run-second',
    workflowId: 'wf-mine',
    chatId: null,
    status: 'done',
    steps: [{ id: 's1', status: 'done' }],
    cursor: 1,
  });
  const again = await store.listWorkflowsWithLastRun(aliceId);
  check(
    'a second run does not duplicate the workflow',
    again.filter((r) => r.id === 'wf-mine').length === 1,
    `${again.filter((r) => r.id === 'wf-mine').length} rows`,
  );
}

section('finished runs are eventually swept, unfinished ones never');
{
  for (const [id, status] of [
    ['sweep-done', 'done'],
    ['sweep-failed', 'failed'],
    ['sweep-attention', 'needs_attention'],
    ['sweep-running', 'running'],
  ]) {
    await store.createWorkflowRun(aliceId, {
      id,
      workflowId: 'wf-mine',
      chatId: null,
      status,
      steps: [{ id: 's1', status: 'done' }],
      cursor: 1,
    });
    // Only a finished run gets a finished_at, which is exactly what the pruner
    // keys on — so stamping it here is also the assertion that it does.
    if (status !== 'running') {
      await store.saveWorkflowRun(id, { status, leaseUntil: null, finished: true });
    }
  }

  // A window of zero days: anything already finished is older than it.
  await store.pruneWorkflowRuns(0);

  check('an old finished run is gone', (await store.getWorkflowRun(aliceId, 'sweep-done')) === null);
  check('so is an old failed one', (await store.getWorkflowRun(aliceId, 'sweep-failed')) === null);
  // These two are the state the feature exists to preserve. Sweeping them away
  // would delete the evidence that something needs a person.
  check(
    'one waiting for a person is kept',
    (await store.getWorkflowRun(aliceId, 'sweep-attention')) !== null,
    'that is the record saying a step was interrupted',
  );
  check('and one still going is kept', (await store.getWorkflowRun(aliceId, 'sweep-running')) !== null);
}

/* ── asking twice ──────────────────────────────────────────────── */

/**
 * Standing work asked for a second time.
 *
 * This is an ordinary mistake rather than a rare one: you set something up
 * three weeks ago, you have forgotten, and you ask again. Creating a second
 * copy is the worst of the available answers — the job runs twice, cancelling
 * one leaves the other going, and nothing on screen says there are two. So the
 * tools refuse, hand the model what is already there, and tell it to put the
 * choice in front of the user as buttons.
 */
section('work that already exists is not quietly duplicated');
{
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const scheduleTask = CLOUD_IMPLEMENTATIONS.schedule_task;
  const workflowWrite = CLOUD_IMPLEMENTATIONS.workflow_write;
  const ctx = { userId: aliceId };

  // Both tools now return `{ content, schedule }`: the sentence the model reads
  // and the card the transcript draws. `said` is the sentence.
  const said = (result) => String(result?.content ?? result);

  const firstResult = await scheduleTask(
    { title: 'Monday news summary', prompt: 'Summarise the news', when: 'mon 08:00' },
    ctx,
  );
  const first = said(firstResult);
  check('the first one is created', /Scheduled/.test(first), first.slice(0, 60));

  /**
   * And it comes with a card, not only a sentence.
   *
   * The sentence scrolled away and led nowhere; the card says how often, in
   * which zone, when next — and carries the id its pill opens.
   */
  const card = firstResult.schedule;
  check('a created task carries a card for the transcript', card?.kind === 'task' && !!card?.id, JSON.stringify(card));
  check('with the schedule it runs on', card?.cron === 'mon 08:00', card?.cron);
  check('when it next fires', Number.isFinite(new Date(card?.nextRunAt).getTime()), card?.nextRunAt);
  check('and not marked as a duplicate', card?.existing === false);
  check('the model is told the card is there, so it does not recite it', /can see a card/.test(first), first);

  // The same job, described at a different length — which is how somebody
  // actually asks for it the second time, and what a title match on equality
  // would sail straight past.
  const againResult = await scheduleTask(
    { title: 'Monday news summary for my field', prompt: 'Summarise the news', when: 'mon 09:00' },
    ctx,
  );
  const again = said(againResult);
  // "Show the old one": the card drawn above the question is the existing task,
  // marked as such, so the person can see what they are being asked about.
  check('the duplicate shows the existing one as a card', againResult.schedule?.id === card?.id, JSON.stringify(againResult.schedule));
  check('marked as already there rather than just made', againResult.schedule?.existing === true);
  check('asking again creates nothing', /already exists, so nothing was created/.test(again), again.slice(0, 80));
  check('and shows the user what is already there', /Monday news summary/.test(again));
  check('with the schedule it runs on', /repeats mon 08:00/.test(again), again);
  check('and asks rather than deciding', /call ask_options/.test(again));
  check('offering to keep it', /keep it as it is/.test(again));
  check('to change it', /change this one/.test(again));
  check('to have both', /create a second scheduled task as well/.test(again));
  check('or to drop it', /cancel/.test(again));

  const tasksNow = await store.listTasks(aliceId);
  check('nothing was written', tasksNow.filter((t) => /Monday news/.test(t.title)).length === 1, `${tasksNow.length}`);

  // Something genuinely different is not a duplicate, and must not be treated
  // as one — a guard that fires on unrelated work is worse than none.
  const different = said(
    await scheduleTask({ title: 'Invoice chase', prompt: 'Chase unpaid invoices', when: 'fri 17:00' }, ctx),
  );
  check('unrelated work is created as normal', /Scheduled/.test(different), different.slice(0, 60));

  // And the user is allowed to want two. `confirmed` is the model reporting
  // that it asked and was told to go ahead.
  const both = said(
    await scheduleTask(
      { title: 'Monday news summary', prompt: 'Summarise the news', when: 'mon 17:00', confirmed: true },
      ctx,
    ),
  );
  check('a second one is created once the user has chosen it', /Scheduled/.test(both), both.slice(0, 60));
  check(
    'and there are now two',
    (await store.listTasks(aliceId)).filter((t) => /Monday news summary$/.test(t.title)).length === 2,
  );

  // The same guard on the other tool.
  await workflowWrite({ action: 'create', title: 'Quarterly board pack', steps: ['Pull the numbers'] }, ctx);
  const wfAgainResult = await workflowWrite(
    { action: 'create', title: 'Quarterly board pack', steps: ['Pull the numbers', 'Chart them'] },
    ctx,
  );
  const wfAgain = said(wfAgainResult);
  check('a repeated workflow is refused too', /already exists, so nothing was created/.test(wfAgain), wfAgain.slice(0, 80));
  check('naming the one that is there', /Quarterly board pack/.test(wfAgain));
  // A stored step is `{ instruction }`; listing it by `prompt` printed
  // "[object Object]" for every step the existing workflow had.
  check('listing its steps as words', /1\. Pull the numbers/.test(wfAgain) && !/object Object/.test(wfAgain), wfAgain);
  check('and pointing at update rather than a second create', /action: "update"/.test(wfAgain));
  check('with the existing workflow as the card', wfAgainResult.schedule?.kind === 'workflow' && wfAgainResult.schedule?.existing === true);
  check('saying how many steps it has', wfAgainResult.schedule?.steps === 1, `${wfAgainResult.schedule?.steps}`);

  // Updating an existing workflow is not a create and must never be blocked by
  // this: the guard sits after the delete and update branches for that reason.
  const existing = (await store.listWorkflows(aliceId)).find((w) => w.title === 'Quarterly board pack');
  const updatedResult = await workflowWrite({ action: 'update', id: existing.id, title: 'Quarterly board pack' }, ctx);
  const updated = said(updatedResult);
  check('updating one is untouched by the guard', /^Updated/.test(updated), updated.slice(0, 60));
  check('and the update redraws its card', updatedResult.schedule?.id === existing.id && updatedResult.schedule?.existing === false);
}

section('a run whose conversation was deleted still runs');
{
  // The run's conversation is created empty and hidden from the sidebar; one
  // deleted before the next nudge failed step one with "Chat not found".
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-lost-chat',
    title: 'Lost its conversation',
    steps: normaliseSteps(['ask the model something']),
    nextRunAt: null,
  });
  const run = await startRun(aliceId, workflow);
  await store.deleteChat(aliceId, run.chat_id);

  const after = await advanceRun(run, { deadline: Date.now() + 60_000 });
  check('the conversation is made again', !!(await store.getChat(aliceId, run.chat_id)));
  check('and the step does not fail for want of it', !/chat not found/i.test(after.steps[0].error || ''), after.steps[0].error?.slice(0, 60));
}

section('a workflow runs in one conversation, run after run');
{
  const workflow = await store.createWorkflow(aliceId, {
    id: 'wf-one-chat',
    title: 'Every morning',
    steps: normaliseSteps(['ask the model something']),
    nextRunAt: null,
  });
  const first = await startRun(aliceId, workflow);
  await advanceRun(first, { deadline: Date.now() + 60_000 });
  const second = await startRun(aliceId, workflow);
  check('the second run writes into the first run\'s conversation', second.chat_id === first.chat_id, `${first.chat_id} / ${second.chat_id}`);

  await store.deleteChat(aliceId, first.chat_id);
  await advanceRun(second, { deadline: Date.now() + 60_000 });
  const third = await startRun(aliceId, workflow);
  check('and one whose conversation is gone gets a fresh one', !!(await store.getChat(aliceId, third.chat_id)));
}

section('a scheduled task runs in one conversation, run after run');
{
  const made = await alice.call('POST', '/api/tasks', { title: 'Hourly', prompt: 'Say hi.', when: '09:00' });
  const id = made.body?.task?.id;
  await alice.call('POST', `/api/tasks/${id}/run`);
  const firstChat = (await store.getTask(aliceId, id))?.last_chat;
  await alice.call('POST', `/api/tasks/${id}/run`);
  const secondChat = (await store.getTask(aliceId, id))?.last_chat;
  check('both runs used the same conversation', !!firstChat && firstChat === secondChat, `${firstChat} / ${secondChat}`);
  const users = (await store.listMessages(aliceId, firstChat)).filter((m) => m.role === 'user');
  check('with each run\'s request in it, in order', users.length === 2, `${users.length}`);
}

section('a turn paused on a question shows it again when reopened');
{
  const chat = await store.createChat(aliceId, { id: 'c-paused-q', title: 'Paused' });
  await store.appendMessage(aliceId, chat.id, { id: 'pq-u', role: 'user', text: 'Set it up.' });
  await store.appendMessage(aliceId, chat.id, {
    id: 'pq-a',
    role: 'assistant',
    text: '',
    toolCalls: [{ id: 'pq-call', name: 'ask_options', input: { questions: [{ question: 'How often?', options: ['Daily', 'Weekly'] }] } }],
  });
  const opened = await alice.call('GET', `/api/chats/${chat.id}`);
  const q = opened.body?.pendingQuestion;
  check('the question comes back with the conversation', q?.toolCallId === 'pq-call' && q.questions?.[0]?.question === 'How often?', JSON.stringify(q)?.slice(0, 160));
  check('  and no approval bar competes with it', !opened.body?.pendingApproval);
}

section('a schedule can be anything a person means, and runs when it says');
{
  const { parseSchedule, scheduleFrom, nextRunOf } = await import('../server/scheduler.js');
  const tz = 'Asia/Ho_Chi_Minh';
  const from = new Date('2026-09-28T03:47:30Z'); // Monday 10:47:30 in Hanoi
  const hanoi = (iso) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  const at = (when) => {
    const r = parseSchedule(when, { from, tz });
    return { cron: r.cron, next: hanoi(r.nextRunAt) };
  };
  const cases = [
    ['every 10 minutes', 'every 10m', 'Mon 28, 10:50'],
    ['mỗi 10 phút', 'every 10m', 'Mon 28, 10:50'],
    ['every 6 hours at :15', 'every 6h :15', 'Mon 28, 12:15'],
    ['every 23 hours', 'every 23h @2026-09-28T04:47:00.000Z', 'Mon 28, 11:47'],
    ['every 3 days 08:00', 'every 3d 08:00 @2026-09-29', 'Tue 29, 08:00'],
    ['mon,wed,fri 08:00,18:00', 'days mon,wed,fri 08:00,18:00', 'Mon 28, 18:00'],
    ['daily 07:00,12:30,21:00', 'days all 07:00,12:30,21:00', 'Mon 28, 12:30'],
    ['weekends 10:00', 'days sat,sun 10:00', 'Sat 03, 10:00'],
    ['monthly last 09:00', 'monthly last 09:00', 'Wed 30, 09:00'],
    ['monthly 31 08:00', 'monthly 31 08:00', 'Sat 31, 08:00'],
    ['fri 17:00', 'fri 17:00', 'Fri 02, 17:00'],
    ['hourly :00', 'hourly :00', 'Mon 28, 11:00'],
  ];
  for (const [when, cron, next] of cases) {
    const got = at(when);
    check(`"${when}" → ${cron}, first at ${next}`, got.cron === cron && got.next === next, JSON.stringify(got));
  }
  const oneOff = parseSchedule('2026-10-01 09:00', { from, tz });
  check('a date and a time is one run, not a repeat', oneOff.cron === null && hanoi(oneOff.nextRunAt) === 'Thu 01, 09:00');
  let refused = '';
  try {
    parseSchedule('every 2m', { from, tz });
  } catch (err) {
    refused = err.message;
  }
  check('less than five minutes is refused, with the reason', /5 to 1440/.test(refused), refused);

  // After each run, the next — the chain is what an unattended task lives by.
  const chain = (cron, n = 4) => {
    const out = [];
    let t = from;
    for (let i = 0; i < n; i += 1) {
      const next = nextRunOf({ cron, tz }, t);
      out.push(hanoi(next));
      t = new Date(next);
    }
    return out.join(' | ');
  };
  check('every 10 minutes stays on the clock', chain('every 10m') === 'Mon 28, 10:50 | Mon 28, 11:00 | Mon 28, 11:10 | Mon 28, 11:20', chain('every 10m'));
  check('every 23 hours counts from its start, without drifting',
    chain('every 23h @2026-09-28T04:00:00.000Z') === 'Mon 28, 11:00 | Tue 29, 10:00 | Wed 30, 09:00 | Thu 01, 08:00', chain('every 23h @2026-09-28T04:00:00.000Z'));
  check('every third day keeps its rhythm', chain('every 3d 07:00 @2026-09-29') === 'Tue 29, 07:00 | Fri 02, 07:00 | Mon 05, 07:00 | Thu 08, 07:00', chain('every 3d 07:00 @2026-09-29'));

  // The panel's pieces write the same words.
  check('the panel: every 45 minutes is on the clock', scheduleFrom({ frequency: 'minutes', every: 45 }, { from, tz }).cron === 'every 45m');
  check('the panel: Tue and Thu, twice a day', scheduleFrom({ frequency: 'weekly', days: ['thu', 'tue'], times: ['17:00', '09:00'] }, { from, tz }).cron === 'days tue,thu 09:00,17:00');
  check('the panel: the 15th and the last day', scheduleFrom({ frequency: 'monthly', monthDays: ['last', 15], times: ['08:00'] }, { from, tz }).cron === 'monthly 15,last 08:00');
  const once = scheduleFrom({ frequency: 'once', date: '2026-09-29', time: '09:00' }, { from, tz });
  check('the panel: once, on a date', once.cron === null && hanoi(once.nextRunAt) === 'Tue 29, 09:00');
}

section('an hourly repeat keeps the account\'s minute in a half-hour zone');
{
  const { parseSchedule } = await import('../server/scheduler.js');
  const from = new Date('2026-09-28T03:45:00Z');
  for (const tz of ['Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Ho_Chi_Minh']) {
    const at = new Date(parseSchedule('hourly :10', { from, tz }).nextRunAt);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, minute: '2-digit' }).format(at);
    check(`${tz}: at :10 on its own clock, within the hour`, Number(local) === 10 && at > from && at - from <= 3_600_000, `${at.toISOString()} → :${local}`);
  }
}

section('Run now takes the lease, and a manual task stays on');
{
  const made = await alice.call('POST', '/api/tasks', { title: 'By hand', prompt: 'Say hi.', frequency: 'manual' });
  const id = made.body?.task?.id;
  const before = await store.getTask(aliceId, id);
  check('a manual task has no next run', before && !before.cron && !before.next_run_at, JSON.stringify({ cron: before?.cron, next: before?.next_run_at }));

  // A run already holds it — the cron, another tab, a double press.
  const held = await store.claimTask(aliceId, id);
  check('the first claim takes it', !!held);
  check('  and a second is refused while it is held', (await store.claimTask(aliceId, id)) === null);
  const busy = await alice.call('POST', `/api/tasks/${id}/run`);
  check('Run now on a running task is a 409, not a second run', busy.status === 409, `${busy.status}`);
  await store.finishTask(id, { status: 'ok', chatId: null, nextRunAt: null, retire: false });

  const ran = await alice.call('POST', `/api/tasks/${id}/run`);
  check('once free it runs', ran.status === 200, `${ran.status}`);
  const after = await store.getTask(aliceId, id);
  check('and a manual task is still enabled afterwards', after?.enabled === true, `enabled=${after?.enabled}`);
  check('  and not left holding the lease', after?.run_state == null, String(after?.run_state));
}

section('the same email is not sent twice');
{
  const email = await import('../server/email.js');
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  process.env.GMAIL_USER = 'deployment.mailbox@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  const sent = [];
  email.__testing.useTransport({ async sendMail(m) { sent.push(m); return { messageId: 'x' }; } });

  const chat = await store.createChat(aliceId, { id: 'c-mail-once', title: 'Mail once', model: null });
  const context = { user: { id: aliceId, email: 'alice@workflow.test', name: 'Alice' }, userId: aliceId, chatId: chat.id };
  const input = { to: 'boss@example.com', subject: 'Bản tin sáng', body: 'Tin hôm nay.' };

  // What the agent loop stores around a send: the call, then its result.
  const first = await CLOUD_IMPLEMENTATIONS.send_email(input, context);
  await store.appendMessage(aliceId, chat.id, { id: 'a1', role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'send_email', input }] });
  await store.appendMessage(aliceId, chat.id, { id: 't1', role: 'tool', results: [{ toolCallId: 'call-1', content: first }] });

  let refused = '';
  try {
    await CLOUD_IMPLEMENTATIONS.send_email(input, context);
  } catch (err) {
    refused = err.message;
  }
  check('the second identical send is refused', sent.length === 1 && /NOT sent again/.test(refused), refused.slice(0, 80));
  await CLOUD_IMPLEMENTATIONS.send_email({ ...input, subject: 'Something else' }, context);
  check('a different email still goes', sent.length === 2);
  await CLOUD_IMPLEMENTATIONS.send_email({ ...input, resend: true }, context);
  check('and a copy the user asked for goes with resend', sent.length === 3);

  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
}

section('a conversation says when a scheduled run is working in it');
{
  const chat = await store.createChat(aliceId, { id: 'c-bg', title: 'Background', model: null });
  const wf = await store.createWorkflow(aliceId, { id: 'wf-bg', title: 'bg', steps: normaliseSteps(['x']), nextRunAt: null });
  const run = await store.createWorkflowRun(aliceId, {
    id: 'run-bg',
    workflowId: wf.id,
    chatId: chat.id,
    status: 'running',
    steps: [{ id: 's1', status: 'running' }],
    cursor: 0,
  });
  const shown = await alice.call('GET', `/api/chats/${chat.id}`);
  check('a conversation a workflow is running in says so', shown.body?.background === true, JSON.stringify(shown.body?.background));
  check('and a conversation nothing is running in does not', (await alice.call('GET', '/api/chats/c-mail-once')).body?.background === false);

  await store.saveWorkflowRun(run.id, { status: 'done', finished: true });
  check('nor does it once the run is over', (await alice.call('GET', `/api/chats/${chat.id}`)).body?.background === false);
}

section('an outside pinger gets its answer at once');
{
  // Vercel's own cron fires once a day on the free plan; a free pinger calls
  // this every few minutes and gives up after ~30s, so it must not be kept waiting.
  process.env.CRON_SECRET = 'workflow-test-cron-secret';
  const started = Date.now();
  const res = await fetch(`${base}/api/cron/run-tasks?background=1`, { headers: { Authorization: 'Bearer workflow-test-cron-secret' } });
  check('it is accepted', res.status === 202, `${res.status}`);
  check('without waiting for the work', Date.now() - started < 5_000, `${Date.now() - started}ms`);
  const denied = await fetch(`${base}/api/cron/run-tasks?background=1`, { headers: { Authorization: 'Bearer wrong' } });
  check('and still refuses a caller without the secret', denied.status === 401, `${denied.status}`);
  delete process.env.CRON_SECRET;

  // The shelves say whether work runs with the web closed: when the cloud was
  // last woken, and where an outside pinger should call.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const beat = await alice.call('GET', '/api/heartbeat');
  check('the heartbeat is recorded', beat.status === 200 && !!beat.body?.lastAt && Date.now() - new Date(beat.body.lastAt).getTime() < 60_000, JSON.stringify(beat.body));
  check('  with the address a pinger should call', /\/api\/cron\/run-tasks\?background=1$/.test(beat.body?.endpoint || ''), beat.body?.endpoint);
  check('  and it needs a session to read', (await fetch(`${base}/api/heartbeat`)).status === 401);
}

section('a message begun from a shelf remembers which');
{
  const chat = await store.createChat(aliceId, { id: 'c-intent', title: 'Intent', model: null });
  const kept = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'mỗi sáng lấy tin', intent: 'workflow' });
  check('a workflow request is marked so', kept.body?.message?.intent === 'workflow', JSON.stringify(kept.body?.message));
  const odd = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'x', intent: 'delete_everything' });
  check('and anything else is dropped, not stored', odd.status === 201 && !('intent' in (odd.body?.message || {})));
}

section('a scheduled task can be edited');
{
  const made = await alice.call('POST', '/api/tasks', { title: 'Morning', prompt: 'Say hello.', when: '09:00', tz: 'Asia/Ho_Chi_Minh' });
  const id = made.body?.task?.id;
  check('made one to edit', made.status === 201 && !!id, `${made.status}`);

  const renamed = await alice.call('PATCH', `/api/tasks/${id}`, { title: 'Morning brief', prompt: 'Say good morning.', policy: 'guarded' });
  const task = renamed.body?.task;
  check('its name, instructions and permissions change', task?.title === 'Morning brief' && task?.prompt === 'Say good morning.' && task?.policy === 'guarded');
  check('and its schedule is left alone when no frequency is sent', task?.cron === '09:00', task?.cron);
  check('it stays enabled', task?.enabled === true);

  const hourly = await alice.call('PATCH', `/api/tasks/${id}`, { frequency: 'hourly', tz: 'Asia/Ho_Chi_Minh' });
  check('a new frequency re-times it', /^hourly :\d\d$/.test(hourly.body?.task?.cron || ''), hourly.body?.task?.cron);

  const empty = await alice.call('PATCH', `/api/tasks/${id}`, { prompt: '   ' });
  check('an empty instruction is refused', empty.status === 400, `${empty.status}`);

  const paused = await alice.call('PATCH', `/api/tasks/${id}`, { enabled: false });
  check('pause still works through the same route', paused.body?.task?.enabled === false);

  const wrong = await alice.call('PATCH', '/api/tasks/nope', { title: 'x' });
  check('an unknown task is a 404', wrong.status === 404, `${wrong.status}`);
}

section('deleting');
{
  const gone = await alice.call('DELETE', `/api/workflows/${workflowId}`);
  check('a workflow can be deleted', gone.status === 200, `${gone.status}`);

  const after = await alice.call('GET', `/api/workflows/${workflowId}`);
  check('and is then a 404', after.status === 404, `${after.status}`);
}


section('a run parked by an interruption it did not need is put back to work');
{
  /*
   * The report: the morning report's deep-research step said "interrupted — not
   * repeated" and the run sat waiting for a person. It was parked by code that
   * stopped every cut-off step; reading has nothing to repeat by accident, so
   * the run is reopened and carries on in the cloud.
   */
  const { recoverParkedRuns } = await import('../server/workflows.js');
  const steps = ['gather the news', 'deep research it', 'email the report'];
  const wf = await store.createWorkflow(aliceId, { id: 'wf-parked', title: 'Morning', steps: normaliseSteps(steps), nextRunAt: null });
  const chat = await store.createChat(aliceId, { id: 'c-parked', title: 'Morning' });
  await store.appendMessage(aliceId, chat.id, { id: 'u-p2', role: 'user', text: steps[1] });
  await store.appendMessage(aliceId, chat.id, { id: 'a-p2', role: 'assistant', text: '', toolCalls: [{ id: 'dr-p', name: 'deep_research', input: { question: 'q' } }] });
  const parked = await store.createWorkflowRun(aliceId, {
    id: 'run-parked', workflowId: wf.id, chatId: chat.id, status: 'running', cursor: 1,
    steps: [
      { id: 's1', status: 'done' },
      { id: 's2', status: 'unknown', error: 'This step was interrupted while running.' },
      { id: 's3', status: 'pending' },
    ],
  });
  await store.saveWorkflowRun(parked.id, { status: 'needs_attention', leaseUntil: null, finished: true });

  const reopened = await recoverParkedRuns();
  check('the parked run is reopened', reopened.includes('run-parked'), JSON.stringify(reopened));
  const back = await store.getWorkflowRun(aliceId, 'run-parked');
  check('  as running, unclaimed, not finished', back.status === 'running' && !back.finished_at && !back.lease_until, `${back.status} ${back.finished_at}`);
  check('  with its step ready to carry on', back.steps[1].status === 'running' && !back.steps[1].error);
  check('the next nudge would pick it up', (await store.claimWorkflowRun({ id: 'run-parked', leaseUntil: new Date(Date.now() + 60_000).toISOString() }))?.id === 'run-parked');

  // One that sent an email half-way stays with a person.
  const chat2 = await store.createChat(aliceId, { id: 'c-parked-2', title: 'Morning' });
  await store.appendMessage(aliceId, chat2.id, { id: 'u-p3', role: 'user', text: steps[2] });
  await store.appendMessage(aliceId, chat2.id, { id: 'a-p3', role: 'assistant', text: '', toolCalls: [{ id: 'em-p', name: 'send_email', input: { subject: 's', body: 'b' } }] });
  const wf2 = await store.createWorkflow(aliceId, { id: 'wf-parked-2', title: 'Mail', steps: normaliseSteps(steps), nextRunAt: null });
  const mail = await store.createWorkflowRun(aliceId, {
    id: 'run-parked-mail', workflowId: wf2.id, chatId: chat2.id, status: 'running', cursor: 2,
    steps: [{ id: 's1', status: 'done' }, { id: 's2', status: 'done' }, { id: 's3', status: 'unknown' }],
  });
  await store.saveWorkflowRun(mail.id, { status: 'needs_attention', leaseUntil: null, finished: true });
  check('a step cut off mid-email is not reopened', !(await recoverParkedRuns()).includes('run-parked-mail'));
}

section('a conversation turn cut off by the time limit is finished in the cloud');
{
  const { resumeCutOffTurns } = await import('../server/resume.js');
  const chat = await store.createChat(aliceId, { id: 'c-cutoff', title: 'Long research' });
  await store.appendMessage(aliceId, chat.id, { id: 'u-cut', role: 'user', text: 'research this deeply' });
  // Exactly what a killed invocation leaves: the lease names a run nobody renews.
  check('the dead run held the lease', (await store.claimChatRun(aliceId, chat.id, 'dead-run')) > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const seen = [];
  const out = await resumeCutOffTurns({
    staleMs: 1,
    run: async ({ chatId, userId }) => {
      seen.push({ chatId, userId, lease: (await store.getChat(userId, chatId)).run_lock_by });
    },
  });
  check('the cut-off turn is picked up', seen.length === 1 && seen[0].chatId === 'c-cutoff', JSON.stringify(out));
  check('  under a lease of its own, so a browser coming back joins rather than races', !!seen[0]?.lease && seen[0].lease !== 'dead-run');
  check('  and the lease is let go afterwards', (await store.getChat(aliceId, chat.id)).run_lock_by === null);

  // A stopped run cleared its lease, so there is nothing to pick up.
  await store.claimChatRun(aliceId, chat.id, 'stopped-run');
  await store.stopChatRun(aliceId, chat.id);
  const none = await resumeCutOffTurns({ staleMs: 1, run: async () => seen.push('ran') });
  check('a run somebody stopped is left stopped', none.length === 0 && seen.length === 1);
}


section('a new day starts the workflow over, whatever became of yesterday');
{
  /*
   * The report: a run stopped one day, and the workflow did not run the next.
   * A due workflow starts a fresh run on its own schedule; yesterday's
   * unfinished run is closed so it cannot write into the conversation beside
   * today's, and a deleted conversation is simply made again.
   */
  const { startRun } = await import('../server/workflows.js');
  const wf = await store.createWorkflow(aliceId, { id: 'wf-daily', title: 'Daily', steps: normaliseSteps(['a', 'b']), nextRunAt: null });
  const first = await startRun(aliceId, wf);
  await store.saveWorkflowRun(first.id, { status: 'needs_attention', leaseUntil: null, finished: true });

  const second = await startRun(aliceId, wf);
  check('the next day gets a run of its own, from the first step', second.id !== first.id && second.status === 'running' && Number(second.cursor) === 0);
  check('  in the same conversation', second.chat_id === first.chat_id);
  check("  and yesterday's stopped run is closed, not left to resume beside it", (await store.getWorkflowRun(aliceId, first.id)).status === 'cancelled');

  await store.deleteChat(aliceId, second.chat_id);
  const third = await startRun(aliceId, wf);
  check('a deleted conversation is replaced by a new one, not a stopped workflow', !!third.chat_id && third.chat_id !== second.chat_id && !!(await store.getChat(aliceId, third.chat_id)));
}

removeTemp(process.env.DATA_DIR);
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll workflow checks passed.\x1b[0m\n',
);
server.close();
process.exit(failures ? 1 : 0);
