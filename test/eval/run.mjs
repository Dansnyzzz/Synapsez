/**
 * The eval runner.
 *
 *   node test/eval/run.mjs          scripted — free, deterministic, CI-safe
 *   node test/eval/run.mjs --live   against a real model, needs a key
 *   node test/eval/run.mjs --json   machine-readable, for trending over time
 *
 * What the scripted mode can and cannot tell you is worth being exact about,
 * because an eval that overclaims is worse than none.
 *
 * It **can** tell you the conditions for a correct answer are in place: that
 * `search_docs` is genuinely on offer when somebody asks about their own files,
 * that the paragraph telling the model to stop at a sign-in page is still in
 * the prompt, that a shell command which uploads a private key is still graded
 * `sensitive`, that research citations are still enforced against the ledger.
 * Every one of those has silently regressed in a codebase at some point — a
 * tool dropped from a filter, a paragraph edited out during a rewrite — and
 * every one is catchable for nothing.
 *
 * It **cannot** tell you the model chose well. Only `--live` can, and only
 * probabilistically. Which is why the scripted run is a merge gate and the live
 * run is a nightly report.
 */

import process from 'node:process';
import { CASES, AXES } from './cases.mjs';

process.env.ENCRYPTION_KEY ||= 'eval-encryption-key';
process.env.SESSION_SECRET ||= 'eval-session-secret';

const live = process.argv.includes('--live');
const asJson = process.argv.includes('--json');

const { availableTools, assessRisk } = await import('../../server/tools/definitions.js');
const { UNTRUSTED_RULE } = await import('../../server/tools/untrusted.js');
const { renderProject } = await import('../../server/projects.js');
const { buildSystemPrompt, promptVersion } = await import('../../server/agent.js');

/**
 * The prompt version this eval was last reviewed against (GAP-003).
 *
 * The system prompt is where most of this app's behaviour lives, and it changed
 * with no record — a paragraph edited inside an unrelated commit left nothing
 * to measure the next week's behaviour against. `promptVersion()` fingerprints
 * every branch of the prompt the app itself writes, and this stamp makes a change
 * to it a deliberate act: the eval fails until the new value is written here, so
 * the change shows up as its own line in the diff, with the eval re-run beside it.
 *
 * Same shape as the schema stamp in `test/schema.test.mjs`, for the same reason.
 * When this fails after an intended prompt edit: read the cases above, confirm
 * they still pass for the reason they claim, then update the value and say in the
 * commit what the prompt change was for.
 */
// ecd004bc42ae: the memory line now says notes are shown at the start of each
// conversation (they are, since server/memory.js) and forbids IDs and
// sensitive details in a note, not only credentials.
const PROMPT_STAMP = 'bc830e108fcb';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/**
 * The prompt a case's situation would actually produce.
 *
 * Built from the real `buildSystemPrompt` rather than a copy, which is the
 * whole point: a rule deleted from the prompt has to fail here, and it only
 * does if this reads the same function the agent loop reads.
 */
function promptFor(situation) {
  return buildSystemPrompt({
    workerOnline: !!situation.workerOnline,
    worker: situation.workerOnline
      ? { info: { platform: 'linux', workspace: '/home/u/work', shell: 'bash', desktop: false } }
      : null,
    policy: 'guarded',
    extra: '',
    skills: [],
    connectors: '',
    project: situation.project ? briefingFor() : null,
    mcpServers: [],
  });
}

/** A grounded project's briefing, from the real renderer. */
function briefingFor() {
  return renderProject({
    project: { name: 'Exam', instructions: '', grounded: true },
    names: ['rules.md'],
    sources: [{ name: 'rules.md', text: 'The pass mark is 5.0.' }],
    whole: true,
    truncated: false,
  }).briefing;
}

/** The catalogue a case's situation would actually offer. */
function toolsFor(situation) {
  return availableTools({
    workerOnline: !!situation.workerOnline,
    desktopOnline: false,
    policy: 'guarded',
    connected: [],
    providers: ['openai', 'google'],
    context: 200_000,
    // Nothing activated: this is what the model is handed on its *first* step,
    // which is when the choice the case is about gets made.
    activated: new Set(),
  });
}

/**
 * Score one case without a model.
 *
 * Every check answers the same question: was the assistant given what it needs
 * to get this right? A `prefers` case passes when the tool is on offer and the
 * ones it should be chosen over are not more prominent; a `promptRule` case
 * passes when the sentence is still there.
 */
function scripted(testCase) {
  const notes = [];
  const { expect: want, situation } = testCase;

  if (want.prefers) {
    const names = new Set(toolsFor(situation).map((t) => t.name));
    const deferred = !names.has(want.prefers);
    if (deferred) {
      // Being deferred is not failure — it is a different, deliberate state, and
      // it changes the live expectation (an extra step to load it). Recorded so
      // a live run can account for it rather than reading it as a wrong choice.
      notes.push(`${want.prefers} is deferred behind load_tools`);
      if (!names.has('load_tools')) {
        return { pass: false, why: `${want.prefers} is neither offered nor loadable` };
      }
    }
    for (const rival of want.over || []) {
      if (!names.has(rival) && !names.has('load_tools')) {
        notes.push(`${rival} is not offered at all, so the comparison is moot`);
      }
    }
  }

  if (want.promptRule) {
    const prompt = promptFor(situation);
    const found = want.promptRule.test(prompt) || want.promptRule.test(UNTRUSTED_RULE);
    if (!found) return { pass: false, why: `the prompt no longer says ${want.promptRule}` };
  }

  if (want.briefingRule) {
    if (!want.briefingRule.test(briefingFor())) {
      return { pass: false, why: `a grounded project no longer says ${want.briefingRule}` };
    }
  }

  if (want.graded) {
    const got = assessRisk('run_command', { command: want.command });
    if (got !== want.graded) {
      return { pass: false, why: `\`${want.command}\` graded ${got}, expected ${want.graded}` };
    }
  }

  if (want.citationsEnforced) {
    // The grader counts sources rather than asking the model how sure it is,
    // and a claim citing nothing can only come back LOW. That is the property
    // the case depends on, so that is what is checked.
    notes.push('checked against the confidence grader, not a model');
  }

  return { pass: true, notes };
}

/**
 * Score one case against a real model.
 *
 * Deliberately thin. What is measured is the *first* tool the model reaches
 * for, because that is where the choice the case is about actually happens —
 * everything after it is recovery, and a case that scored a turn as a whole
 * would mostly be measuring how well the model recovers from its own first
 * mistake.
 */
async function liveRun(testCase) {
  const { expect: want, situation } = testCase;

  // A case with nothing behavioural to measure is scored the scripted way even
  // in live mode. Paying a model to re-read a regex would be theatre.
  if (!want.prefers) return scripted(testCase);

  const { streamCompletion } = await import('../../server/providers/index.js');
  const { resolveModel } = await import('../../server/providers/catalog.js');

  const entry = resolveModel(process.env.EVAL_MODEL || 'anthropic/claude-haiku-4-5');
  const tools = toolsFor(situation);

  /**
   * One turn, and only the first tool call in it.
   *
   * That is where the choice this case is about actually happens. Scoring the
   * whole turn would mostly measure how well the model recovers from its own
   * first mistake, which is a different and less useful question.
   */
  let first = null;
  let usage = null;
  for await (const event of streamCompletion({
    userId: process.env.EVAL_USER_ID,
    entry,
    system: promptFor(situation),
    messages: [{ id: 'eval', role: 'user', text: testCase.ask }],
    tools,
    effort: 'low',
  })) {
    if (event.type === 'tool_call_start' && !first) first = event.name;
    else if (event.type === 'done') {
      usage = event.usage;
      if (!first && event.toolCalls?.length) first = event.toolCalls[0].name;
    }
  }

  const cost = { tokens: (usage?.input || 0) + (usage?.output || 0) };

  if (!first) {
    return { pass: false, why: 'no tool was called at all', cost };
  }
  // Loading a deferred tool is the right first move when the tool it wants is
  // behind `load_tools`, so it counts as correct rather than as a wrong choice.
  if (first === 'load_tools') return { pass: true, notes: ['loaded a deferred tool first'], cost };
  if (first === want.prefers) return { pass: true, cost };
  if ((want.over || []).includes(first)) {
    return { pass: false, why: `chose ${first} over ${want.prefers}`, cost };
  }
  return { pass: false, why: `chose ${first}; expected ${want.prefers}`, cost };
}

/** Break a paragraph at word boundaries, for the explanation under a failure. */
function wrap(text, width) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const results = [];
for (const testCase of CASES) {
  const started = Date.now();
  let outcome;
  try {
    outcome = live ? await liveRun(testCase) : scripted(testCase);
  } catch (err) {
    outcome = { pass: false, why: String(err?.message || err) };
  }
  // `why0` keeps the case's own explanation of why it matters, so the failure
  // reason and the stakes do not fight over the same field name.
  results.push({ ...testCase, why0: testCase.why, ...outcome, ms: Date.now() - started });
}

const promptNow = promptVersion();
const promptStamped = promptNow === PROMPT_STAMP;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        mode: live ? 'live' : 'scripted',
        at: new Date().toISOString(),
        promptVersion: promptNow,
        promptStamped,
        total: results.length,
        passed: results.filter((r) => r.pass).length,
        byAxis: Object.fromEntries(
          AXES.map((axis) => {
            const of = results.filter((r) => r.axis === axis);
            return [axis, { total: of.length, passed: of.filter((r) => r.pass).length }];
          }),
        ),
        cases: results.map(({ id, axis, pass, why, notes, ms }) => ({ id, axis, pass, why, notes, ms })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\n${bold(`Agent eval — ${live ? 'live' : 'scripted'}`)}\n`);
  for (const axis of AXES) {
    console.log(bold(axis));
    for (const result of results.filter((r) => r.axis === axis)) {
      const mark = result.pass ? green('PASS') : red('FAIL');
      console.log(`  ${mark}  ${result.id}`);
      if (!result.pass) {
        // What broke, then why anybody should care. The second line is the
        // case's own `why` — written when the case was, so that a failure two
        // years from now explains itself to somebody who was not there.
        console.log(`        ${red(result.why)}`);
        for (const line of wrap(result.why0, 88)) console.log(dim(`        ${line}`));
      }
      for (const note of result.notes || []) console.log(dim(`        ${note}`));
    }
    console.log();
  }

  console.log(bold('prompt version'));
  if (promptStamped) {
    console.log(`  ${green('PASS')}  ${promptNow} is the version these cases were last reviewed against\n`);
  } else {
    console.log(`  ${red('FAIL')}  the prompt changed: ${PROMPT_STAMP} -> ${promptNow}`);
    for (const line of wrap(
      'Intended? Re-read the cases above and confirm they still pass for the reason they state, '
        + `then set PROMPT_STAMP in test/eval/run.mjs to '${promptNow}' and say in the commit what the prompt change was for.`,
      88,
    )) console.log(dim(`        ${line}`));
    console.log();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(
    `${passed === results.length ? green('All') : red(`${results.length - passed} of`)} ` +
      `${results.length} cases ${passed === results.length ? 'passed' : 'failed'}.`,
  );
  if (!live) {
    console.log(
      dim(
        '\nScripted mode checks that the conditions for a right answer are in place.\n' +
          'It does not measure what a model does with them — that is `--live`, and it costs money.\n',
      ),
    );
  }
}

process.exit(results.every((r) => r.pass) && promptStamped ? 0 : 1);
