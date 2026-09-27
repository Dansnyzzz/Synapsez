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

section('deleting');
{
  const gone = await alice.call('DELETE', `/api/workflows/${workflowId}`);
  check('a workflow can be deleted', gone.status === 200, `${gone.status}`);

  const after = await alice.call('GET', `/api/workflows/${workflowId}`);
  check('and is then a 404', after.status === 404, `${after.status}`);
}

removeTemp(process.env.DATA_DIR);
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll workflow checks passed.\x1b[0m\n',
);
server.close();
process.exit(failures ? 1 : 0);
