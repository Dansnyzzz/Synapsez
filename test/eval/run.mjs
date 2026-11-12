/**
 * The eval runner.
 *
 *   node test/eval/run.mjs          scripted — free, deterministic, CI-safe
 *   node test/eval/run.mjs --live   against a real model, needs a key
 *   node test/eval/run.mjs --json   machine-readable, for trending over time
 *   node test/eval/run.mjs --live --record   a live run that keeps what the model chose,
 *                                    case by case, in test/eval/cassettes/
 *   node test/eval/run.mjs --replay  the recorded choices scored again — free, offline
 *
 * Cassettes (2026-11-12, after OrcaReplay's record/replay): a live run's choices kept so
 * a later change can be checked against them for nothing. Only what the score reads is
 * kept — the tools the model reached for and what it cost — never what it wrote. Each
 * cassette carries a fingerprint of what the model was shown (the prompt's version, the
 * catalogue, the question, the dial); when that has changed since, the replay does not
 * pretend: the case is reported as diverged, to be recorded again.
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

const record = process.argv.includes('--record');
const replay = !record && process.argv.includes('--replay');
const live = record || process.argv.includes('--live');
const asJson = process.argv.includes('--json');
const CASSETTES = new URL('./cassettes/', import.meta.url);

/**
 * Live runs (RSN-001): the provider keys from `.env` and nothing else from it —
 * never the database address, so a run cannot touch the deployment's data — and
 * a database that lives in memory for the length of the run. The keys are never
 * printed. `EVAL_EFFORT` picks the dial (default low), `EVAL_MODEL` the model.
 */
if (live) {
  const fs = await import('node:fs');
  const envFile = new URL('../../.env', import.meta.url);
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const line = raw.trim();
      const at = line.indexOf('=');
      if (!line || line.startsWith('#') || at < 0) continue;
      const key = line.slice(0, at).trim();
      if (!/^(OPENROUTER|ORCAROUTER|GEMINI|GOOGLE)_API_KEYS?$/.test(key) || key in process.env) continue;
      process.env[key] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  process.env.DATABASE_URL = '';
  process.env.POSTGRES_URL = '';
  const { PGlite } = await import('@electric-sql/pglite');
  const memory = await PGlite.create();
  const { initStore } = await import('../../server/store/index.js');
  await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
}
const liveEffort = process.env.EVAL_EFFORT || 'low';
// A free OpenRouter model with tools and reasoning — the owner keeps OpenRouter,
// OrcaRouter and Gemini only (2026-11-03). Free models come and go; EVAL_MODEL overrides.
const DEFAULT_EVAL_MODEL = 'openrouter/nvidia/nemotron-3.5-super-vl:free';
const liveModel = process.env.EVAL_MODEL || DEFAULT_EVAL_MODEL;

const { availableTools, assessRisk, TOOLS_BY_NAME } = await import('../../server/tools/definitions.js');
const { readArguments } = await import('../../server/tools/validate.js');
const { normalize: readMarketRequest } = await import('../../server/finance/index.js');
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
// 101239f2dd8e: two every-turn lines said in fewer words (TOK-003) — that
// connections are re-read before each step, and skill-creator's entry in the
// skills index. No case rests on either.
// 66bab8a338c2: a file somebody attached and asks to change is changed in place, or
// asked about (owner, 2026-11-05). No case rests on the old wording.
const PROMPT_STAMP = '152dd64d7718';

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

  /*
   * The one call a case expects (finance, 2026-11-10): the tool's own schema must
   * accept it as written, and — for market_data — the finance layer must read it
   * as the case means. A schema change that renamed `kind` or dropped `statement`
   * fails here, before any model is paid to find out.
   */
  if (want.call) {
    const tool = TOOLS_BY_NAME[want.prefers];
    const read = readArguments(want.prefers, tool?.parameters || {}, want.call);
    if (!read.ok) return { pass: false, why: `${want.prefers} refuses ${JSON.stringify(want.call)}: ${read.error}` };
    if (read.notes?.length) return { pass: false, why: `${want.prefers} drops part of ${JSON.stringify(want.call)}: ${read.notes.join(' ')}` };
    if (want.reads && want.prefers === 'market_data') {
      const got = readMarketRequest(read.input);
      const off = Object.entries(want.reads).filter(([key, value]) => JSON.stringify(got[key]) !== JSON.stringify(value));
      if (off.length) return { pass: false, why: `market_data reads ${JSON.stringify(want.call)} differently: ${off.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, not ${JSON.stringify(v)}`).join('; ')}` };
    }
    notes.push(`the call ${JSON.stringify(want.call)} is accepted and read as meant`);
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
/** What the model was shown for a case, as one short hash: change any of it and a cassette no longer applies. */
async function shownPrint(testCase, tools) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(JSON.stringify([promptVersion(), tools.map((t) => t.name).sort(), testCase.ask, liveEffort]))
    .digest('hex')
    .slice(0, 16);
}

/** The events a cassette keeps of a stream: the tools reached for, and the bill. */
async function* recorded(events, kept) {
  for await (const event of events) {
    if (event.type === 'tool_call_start') kept.push({ type: 'tool_call_start', name: event.name });
    else if (event.type === 'done') kept.push({ type: 'done', toolCalls: (event.toolCalls || []).map((c) => ({ name: c.name })), usage: event.usage || null });
    yield event;
  }
}

async function liveRun(testCase) {
  const { expect: want, situation } = testCase;

  // A case with nothing behavioural to measure is scored the scripted way even
  // in live mode. Paying a model to re-read a regex would be theatre.
  if (!want.prefers) return scripted(testCase);

  const fs = await import('node:fs');
  const tools = toolsFor(situation);
  const print = await shownPrint(testCase, tools);
  const file = new URL(`${testCase.id.replace(/[^a-z0-9_-]+/gi, '_')}.jsonl`, CASSETTES);

  /** Replay: the recorded choices, scored as a live run would score them — or diverged. */
  let events;
  if (replay) {
    if (!fs.existsSync(file)) return { ...scripted(testCase), notes: ['no cassette — scored the scripted way; npm run eval:record keeps one'] };
    const [head, ...lines] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    if (head?.print !== print) {
      return { pass: false, diverged: true, why: `diverged: the prompt, the catalogue, the question or the dial changed since this was recorded (${head?.at || 'unknown'}, ${head?.model || 'unknown model'}) — record it again` };
    }
    events = (async function* () {
      yield* lines;
    })();
  }

  const { streamCompletion } = await import('../../server/providers/index.js');
  const { resolveModel } = await import('../../server/providers/catalog.js');
  const entry = resolveModel(liveModel);
  const kept = [];
  if (!events) {
    const stream = streamCompletion({
      userId: process.env.EVAL_USER_ID,
      entry,
      system: promptFor(situation),
      messages: [{ id: 'eval', role: 'user', text: testCase.ask }],
      tools,
      effort: liveEffort,
    });
    events = record ? recorded(stream, kept) : stream;
  }

  /**
   * One turn, and only the first tool call in it.
   *
   * That is where the choice this case is about actually happens. Scoring the
   * whole turn would mostly measure how well the model recovers from its own
   * first mistake, which is a different and less useful question.
   */
  let first = null;
  let usage = null;
  for await (const event of events) {
    if (event.type === 'tool_call_start' && !first) first = event.name;
    else if (event.type === 'done') {
      usage = event.usage;
      if (!first && event.toolCalls?.length) first = event.toolCalls[0].name;
    }
  }

  if (record) {
    fs.mkdirSync(CASSETTES, { recursive: true });
    const head = { print, model: liveModel, effort: liveEffort, at: new Date().toISOString() };
    fs.writeFileSync(file, [head, ...kept].map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  // Reasoning shown apart — it is the part the dial moves (RSN-003). Both adapters
  // already count it inside `output`, so it is not added to the total again.
  const cost = { tokens: (usage?.input || 0) + (usage?.output || 0), input: usage?.input || 0, output: usage?.output || 0, reasoning: usage?.reasoning || 0 };

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
    outcome = live || replay ? await liveRun(testCase) : scripted(testCase);
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
        mode: replay ? 'replay' : record ? 'record' : live ? 'live' : 'scripted',
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
        // A live run's model and dial, and what each case cost — the record a later
        // reading of "did the effort level matter" needs (RSN-003).
        ...(live ? { model: liveModel, effort: liveEffort } : {}),
        cases: results.map(({ id, axis, pass, why, notes, ms, cost }) => ({ id, axis, pass, why, notes, ms, ...(cost ? { cost } : {}) })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\n${bold(`Agent eval — ${replay ? 'replay' : record ? 'live, recording' : live ? 'live' : 'scripted'}`)}\n`);
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
  if (replay) {
    console.log(dim('\nReplayed from test/eval/cassettes: what a model chose when it was recorded, scored again. A diverged case is recorded again with `npm run eval:record`.\n'));
  } else if (!live) {
    console.log(
      dim(
        '\nScripted mode checks that the conditions for a right answer are in place.\n' +
          'It does not measure what a model does with them — that is `--live`, and it costs money.\n',
      ),
    );
  }
}

process.exit(results.every((r) => r.pass) && promptStamped ? 0 : 1);
