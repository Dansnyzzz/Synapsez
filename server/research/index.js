import crypto from 'node:crypto';
import { getStore, isServerless } from '../store/index.js';
import { getPrefs } from '../settings.js';
import { resolveForUser } from '../autoPick.js';
import { planQuestions } from './plan.js';
import { gatherEvidence } from './gather.js';
import { runDebate } from './debate.js';
import { buildReport } from './report.js';

/**
 * The token budget for one research run.
 *
 * A safety stop, not a tight leash.
 *
 * The count, since this said "eight to twelve" and the number is fixed: a run
 * makes **at most eight** model calls — up to two planning attempts, then the
 * debate's proposer, one critic and one revision per round (rounds is 2 and no
 * caller overrides it), and the arbiter. Searching costs none of them, and page
 * reading costs a fetch rather than a call.
 *
 * This is the ceiling that keeps a runaway one — a debate that will not settle,
 * a model that will not answer in JSON — from quietly spending a fortune. When
 * it is hit the run stops and returns what it has, labelled, rather than being
 * cut off mid-sentence with no explanation.
 *
 * Checked *between* calls, not within one, so a single very long reply can
 * overshoot it. That is the honest limit of a token budget enforced from
 * outside the provider, and it is why this is a safety stop rather than a
 * spending control.
 */
const DEFAULT_CAP = 250_000;
/** Wall-clock limits for one run: well inside the 300s function on a deployment. */
const SERVERLESS_TIME_MS = 150_000;
const LOCAL_TIME_MS = 600_000;
/**
 * The share of the clock kept back for the debate: a draft, one critique and
 * revision, and the arbiter, on a free model that can take fifteen seconds a
 * call. Page reading stops starting new reads once only this much is left.
 */
const DEBATE_RESERVE_MS = 75_000;

/** The ledger as the store keeps it: an array, not a Map. */
const ledgerToArray = (ledger) =>
  [...ledger.entries()].map(([id, s]) => ({ id, url: s.url, rank: s.rank, title: s.title ?? null, published: s.published ?? null }));

/**
 * Run one deep-research pass: plan → gather → debate → grade → report, filed for
 * audit.
 *
 * Every role runs on the conversation's own model (resolved once, Auto included),
 * so the whole thing is affordable on a free model — the debate is the same model
 * wearing different hats. The budget is threaded through every call; hitting it
 * stops the run with `status: 'budget'` rather than a silent truncation. An empty
 * search is reported as such, with no source, rather than being papered over with
 * a confident-sounding answer.
 *
 * `deps` injects `search`, `stream`, `entry`, `store` and `cap` for tests; in
 * production only the defaults run.
 */
/**
 * @param {{
 *   question: string, userId?: string, user?: any, chatId?: string|null, signal?: AbortSignal,
 *   deps?: {
 *     store?: any, stream?: any, search?: any, entry?: any, cap?: number, timeMs?: number,
 *     readPage?: (url: string) => Promise<string>,
 *   },
 * }} args
 */
export async function runDeepResearch({ question, userId, user, chatId, signal, deps = {} }) {
  const store = deps.store || getStore();
  const stream = deps.stream;
  const search = deps.search;
  const cap = deps.cap || DEFAULT_CAP;

  const entry = deps.entry || (await resolveForUser(userId, (await getPrefs(userId)).defaultModel));
  /*
   * A clock as well as a token cap. On a deployment the whole turn lives in
   * one 300-second function, and a run that took 200s of it left the turn cut
   * off with no result recorded — the card said "no result" under a green
   * tick. Past the deadline the debate stops and the report is written from
   * what was gathered, marked as such.
   */
  const deadline = Date.now() + (deps.timeMs ?? (isServerless() ? SERVERLESS_TIME_MS : LOCAL_TIME_MS));
  const budget = { spent: 0, cap, tokensIn: 0, tokensOut: 0, deadline };
  const id = crypto.randomUUID();

  const overBudget = () => budget.spent >= budget.cap || Date.now() >= budget.deadline;

  const queries = await planQuestions(question, { userId, entry, stream, budget, signal, chatId });

  /**
   * The page reader is injected rather than imported.
   *
   * `web_fetch` lives in tools/cloud.js, and cloud.js is what calls this
   * function — importing it back would close a cycle. The caller passes it, and
   * a caller that does not (the suite, mostly) gets the old snippet-only
   * behaviour, which the confidence grader then correctly refuses to call HIGH.
   */
  const { ledger, findings } = await gatherEvidence(queries, {
    // Carried only so the searches can be attributed: a run makes up to six of
    // them on a deployment-wide key that no per-account quota covers.
    userId,
    question,
    // Reading stops opening new pages once only the debate's share of the
    // clock is left — the evidence is worth nothing if there is no time to
    // reason over it.
    deadline: deadline - DEBATE_RESERVE_MS,
    ...(search ? { search } : {}),
    ...(deps.readPage ? { readPage: deps.readPage } : {}),
  });

  let claims = [];
  let transcript = [];
  let cut = false;
  // Only debate if the budget has not already gone and there is something to
  // reason over; with no evidence there is nothing honest to synthesise.
  if (!overBudget()) {
    ({ claims, transcript, cut } = await runDebate({
      question, findings, ledger, userId, entry, stream, budget, signal, chatId,
    }));
  } else {
    cut = true;
  }

  const status = cut || overBudget() ? 'budget' : 'complete';
  const report = buildReport({ question, claims, ledger, status });

  await store.saveResearchRun(userId, {
    id,
    chatId: chatId ?? null,
    question,
    status,
    transcript,
    sources: ledgerToArray(ledger),
    report,
    tokensIn: budget.tokensIn,
    tokensOut: budget.tokensOut,
  });

  return { content: `${report}\n\n_Research run ${id}._`, runId: id };
}
