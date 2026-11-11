import { askModel, extractJson } from './llm.js';
import { modelForRole } from '../roleModel.js';

/**
 * What the planner is told. Today's date (2026-11-11, from the patterns that recur in
 * leading assistants' prompts): without it "latest", "this year" and "who holds X now"
 * were searched as of whenever the model was trained. And one query per named thing, in
 * English as well as the question's own language: most sources are in English, and a
 * name searched once in another language finds a fraction of them.
 */
export function plannerSystem(now = new Date()) {
  return [
    'You are a research planner. Break the question into 4 to 6 web-search queries',
    'that together cover it from different angles — different wordings, sub-questions,',
    'and the specific facts a good answer would need. Prefer queries that would reach',
    'primary and reputable sources over ones that would reach opinion.',
    `Today is ${now.toISOString().slice(0, 10)}: put the year in queries about anything current, and read "now", "latest" and "this year" as of today.`,
    'Give each named person, company, product or place its own query. When the question is not in English, write some queries in English and some in its language.',
    '',
    'Reply with JSON only, no prose: {"queries": ["...", "..."]}',
  ].join('\n');
}

/** The queries out of the model's JSON, or [] if there are none to find. */
export function parsePlan(text) {
  const json = extractJson(text);
  const queries = json?.queries;
  if (!Array.isArray(queries)) return [];
  return queries.map((q) => String(q || '').trim()).filter(Boolean);
}

/**
 * Decompose a question into search queries with one model call.
 *
 * Searching several angles beats searching once and concluding — it is what
 * turns "look it up" into "cross-check". On unparseable output it retries once
 * (models sometimes answer in prose the first time and JSON the second), then
 * falls back to the question itself, so the run always has something to search
 * rather than stalling on a formatting slip.
 */
export async function planQuestions(question, { userId, entry, stream, budget, signal, chatId = null }) {
  // Turning one question into search queries is rewriting, not reasoning, so it
  // runs on the cheap tier where there is one. See server/roleModel.js.
  const writer = await modelForRole(userId, 'research.plan', entry);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    /**
     * Honour the budget here too.
     *
     * Every other model call in a research run checks it; this one did not, so
     * both planning attempts always fired regardless of what was left. That
     * matters most in the case the budget exists for — a caller passing a small
     * cap deliberately, or a retry after a run that already overspent — where
     * the planner would spend first and the budget would only be noticed
     * afterwards.
     *
     * Falling back to the question itself is what this function already does
     * when the model will not answer usefully, so there is a sensible answer to
     * give rather than an error to invent.
     */
    if (budget && budget.spent >= budget.cap) break;

    // `low` effort on purpose: this turns one question into a handful of search
    // queries. It is a rewriting job, not a reasoning one, and paying for deep
    // thinking on it buys nothing measurable.
    const text = await askModel({
      userId, entry: writer, system: plannerSystem(), prompt: question, stream, budget, signal,
      chatId, role: 'research.plan', effort: 'low',
    });
    const queries = parsePlan(text);
    if (queries.length) return queries.slice(0, 6);
  }
  return [question];
}
