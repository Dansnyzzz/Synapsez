import { askModel, extractJson } from './llm.js';

/**
 * The debate: a proposer drafts an answer from the evidence, a critic tries to
 * knock it down, the proposer revises, and an arbiter settles it.
 *
 * The personas are deliberately opposed — one synthesises, one hunts for holes —
 * because a single model asked to check its own work tends to agree with itself.
 * Different system prompts reduce that; they do not abolish it, which is why the
 * door to a different provider for the critic is left open (it is just another
 * `entry`, passed the same way). The proposer is shown the findings ONLY, never
 * the conversation, so it has nothing to lean on but the evidence — the point of
 * the whole exercise.
 */

const PROPOSER = [
  'You are the Proposer. Draft a direct answer to the question using ONLY the',
  'findings given — nothing from memory. Cite every factual claim with the source',
  'marker(s) it rests on, like [S1] or [S1][S3]. If the findings do not support a',
  'claim, do not make it. Keep it tight: the conclusions, each with its markers.',
].join('\n');

const PROPOSER_REVISE = [
  'You are the Proposer, revising your draft to answer the Critic. Keep what the',
  'evidence supports, drop or qualify what the Critic showed was weak, and keep',
  'every claim cited with its [S#] markers. Findings only — nothing from memory.',
].join('\n');

const CRITIC = [
  'You are the Critic, a sceptic paid to find fault. Go through the draft claim by',
  'claim and list what is unsupported by the cited source, overstated, or missing',
  'important context. Do not rewrite it — just object.',
  '',
  'Reply with JSON only: {"objections": ["...", "..."]}. An empty list means the',
  'draft is sound as it stands.',
].join('\n');

const ARBITER = [
  'You are the Arbiter. Settle the answer from the proposer\'s draft and the',
  'critic\'s objections. Keep each claim\'s [S#] markers. Where the sources',
  'genuinely disagree, present both sides and set "conflicting": true for that',
  'claim rather than forcing a false certainty.',
  '',
  'Reply with JSON only: {"claims": [{"text": "... [S#]", "conflicting": false}]}',
].join('\n');

/**
 * How much evidence the model is shown.
 *
 * This block is rebuilt and resent on **every** call of the debate — proposer,
 * critic, revise, arbiter, six in a default run — so its size is multiplied by
 * six in the bill. It had no cap at all: six queries returning eight results
 * each is 48 findings, and once pages are read as well it would be far more.
 */
const EVIDENCE_CHARS = 24_000;
const FINDING_CHARS = 300;

/**
 * The findings and ledger, as the model reads them.
 *
 * A source that was opened contributes what the page said; one that was not
 * contributes the search engine's blurb, marked as such, so the model can tell
 * the difference between evidence and advertising. A source that failed to load
 * says so rather than silently looking like one that had nothing to offer.
 */
function evidenceBlock(question, findings, ledger) {
  const sources = [...ledger.entries()].map(([id, s]) => {
    const head = `${id}: ${s.title || s.url} (${s.rank})`;
    if (s.body) return `${head} — read from the page:\n${s.body}`;
    if (s.readError) return `${head} — could not be read (${s.readError}); search summary only: ${s.snippet || ''}`;
    return `${head} — search summary only: ${s.snippet || ''}`;
  });

  const notes = findings.map((f) => `- [${f.id || '—'}] ${String(f.snippet || '').slice(0, FINDING_CHARS)}`);

  let block = `Question: ${question}\n\nSources:\n${sources.join('\n\n')}\n\nFindings:\n${notes.join('\n')}`;
  if (block.length > EVIDENCE_CHARS) {
    // Trimmed at the end, where the weakest sources and the tail of the findings
    // are, and said out loud — a model shown a hard cut with no marker reads
    // straight across it and treats the fragment as the whole record.
    block = `${block.slice(0, EVIDENCE_CHARS)}\n\n[evidence truncated to fit the budget]`;
  }
  return block;
}

/** Claims out of the arbiter's JSON; a prose reply becomes one claim, not nothing. */
function parseClaims(text) {
  const json = extractJson(text);
  const claims = json?.claims;
  if (Array.isArray(claims) && claims.length) {
    return claims
      .map((c) => ({ text: String(c?.text || '').trim(), conflicting: !!c?.conflicting }))
      .filter((c) => c.text);
  }
  const trimmed = String(text || '').trim();
  return trimmed ? [{ text: trimmed, conflicting: false }] : [];
}

/**
 * @returns { claims: [{text, conflicting}], transcript: [{role, text}] }
 */
export async function runDebate({
  question, findings, ledger, userId, entry, stream, budget, rounds = 2, signal, chatId = null,
}) {
  const transcript = [];
  const evidence = evidenceBlock(question, findings, ledger);
  // Tokens or the clock, whichever runs out first — see deadline in index.js.
  const overBudget = () => !!budget && ((!!budget.cap && budget.spent >= budget.cap) || (!!budget.deadline && Date.now() >= budget.deadline));

  let draft = await askModel({
    userId, entry, system: PROPOSER, prompt: evidence, stream, budget, signal,
    chatId, role: 'research.propose',
  });
  transcript.push({ role: 'proposer', text: draft });

  for (let round = 0; round < rounds && !overBudget(); round += 1) {
    const critique = await askModel({
      userId, entry, system: CRITIC, prompt: `${evidence}\n\nDraft:\n${draft}`, stream, budget, signal,
      chatId, role: 'research.critique',
    });
    transcript.push({ role: 'critic', text: critique });

    const objections = extractJson(critique)?.objections;
    // A satisfied critic (an empty, parseable objection list) ends it early —
    // no point paying for a revision nobody asked for.
    if (Array.isArray(objections) && objections.length === 0) break;
    if (overBudget()) break;

    draft = await askModel({
      userId, entry, system: PROPOSER_REVISE, prompt: `${evidence}\n\nYour draft:\n${draft}\n\nCritic:\n${critique}`, stream, budget, signal,
      chatId, role: 'research.revise',
    });
    transcript.push({ role: 'proposer', text: draft });
  }

  const verdict = await askModel({
    userId, entry, system: ARBITER, prompt: `${evidence}\n\nDraft:\n${draft}`, stream, budget, signal,
    chatId, role: 'research.arbitrate',
  });
  transcript.push({ role: 'arbiter', text: verdict });

  return { claims: parseClaims(verdict), transcript };
}
