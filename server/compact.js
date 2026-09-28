import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { streamCompletion } from './providers/index.js';
import { priceTurn } from './providers/catalog.js';
import { record as recordUsage } from './usage.js';
import { modelForRole } from './roleModel.js';

/**
 * Keeping a long conversation inside the model's window.
 *
 * Every turn re-sends the whole transcript, so a conversation that goes well is
 * a conversation that eventually stops working: the prompt outgrows the context
 * window and the provider refuses it. The usual answers are both bad — silently
 * dropping the oldest turns loses the decisions the work rests on, and refusing
 * to continue makes the person start again somewhere else.
 *
 * So the old part is *summarised* rather than discarded, and the summary is
 * written into the conversation as a message of its own. Two consequences worth
 * knowing:
 *
 *   **The transcript the model sees and the one you read are different.** The
 *   page still shows everything that was said; only what is sent is trimmed.
 *   Scrolling back to something from an hour ago must keep working.
 *
 *   **It chains.** Compacting again summarises the previous summary along with
 *   everything since, so the cost stays flat however long the conversation runs.
 */

/**
 * How full the window may get before the older turns are folded up.
 *
 * Not 100%, and not close to it: the reply needs room too, and the summary call
 * itself has to fit. Leaving it until the window is genuinely full means the
 * compaction request is the one that fails.
 */
const COMPACT_AT = 0.82;

/** Turns kept word for word. Recent context is where the work actually is. */
const KEEP_RECENT = 8;

/** Assumed window for a model that never said how big its own is. */
const ASSUMED_CONTEXT = 128_000;

/**
 * Roughly how many tokens a message is worth.
 *
 * Four characters per token is the usual English approximation and is wrong for
 * code and wrong for Vietnamese — but it is only ever used for the *tail*, the
 * handful of messages added since the provider last told us a real number, so
 * the error stays small and always shrinks at the next turn.
 */
function estimateTokens(message) {
  let chars = (message.text || '').length + (message.thinking || '').length;
  for (const call of message.toolCalls || []) {
    chars += call.name.length + JSON.stringify(call.input ?? {}).length;
  }
  for (const result of message.results || []) {
    chars += String(result.content ?? '').length;
  }
  // An image is not characters at all. A rough per-image constant beats
  // pretending a 2MB screenshot costs nothing — and the same for documents,
  // which used to count as nothing, so a 40-page PDF sent with the first
  // question was invisible to the guard that folds a conversation before it
  // overflows. Bounded by what attachments.js actually sends of each.
  let files = 0;
  for (const a of message.attachments || []) {
    const bytes = Number(a.bytes) || 0;
    if (a.kind === 'image') files += 1200;
    else if (a.kind === 'text' || a.kind === 'office') files += Math.ceil(Math.min(bytes, 120_000) / 4);
    // A PDF is sent as pages or as their text; either way about a token for
    // every twenty-odd bytes of an ordinary text PDF, and never more than its
    // 120,000 characters of text would be.
    else if (a.kind === 'document') files += Math.ceil(Math.min(bytes / 20, 30_000));
  }
  return Math.ceil(chars / 4) + files;
}

/**
 * How much of the window this conversation is using.
 *
 * The honest number comes from the provider: every assistant turn records the
 * prompt size it was actually billed for. Everything after the last of those is
 * estimated, because nobody has counted it yet.
 */
export function measure(messages, entry, { maxOutput } = {}) {
  const context = Number(entry?.context) || ASSUMED_CONTEXT;

  // The last turn the provider gave us a real figure for.
  let lastCounted = -1;
  let counted = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const usage = messages[i].usage;
    if (usage?.input) {
      counted = usage.input;
      lastCounted = i;
      break;
    }
  }

  let used = counted;
  for (let i = lastCounted + 1; i < messages.length; i += 1) used += estimateTokens(messages[i]);

  /**
   * After a fold, the provider's last figure describes a transcript that no
   * longer exists.
   *
   * It was billed on everything before the summary, so reading it as current
   * kept the ring full after a compaction — until the next reply brought a new
   * figure — and kept `shouldCompact` true, so the next turn folded again,
   * a handful of turns at a time (27, then 7, then 3). What is sent now is
   * the summary and the tail, so that is what is measured.
   */
  let lastSummary = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'summary') {
      lastSummary = i;
      break;
    }
  }
  const folded = lastSummary > lastCounted;
  if (folded) used = activeTranscript(messages).reduce((sum, m) => sum + estimateTokens(m), 0);

  /**
   * What is left once the reply has its room.
   *
   * The room reserved is the model's own output limit, and it has to be capped at
   * half the window. This was a flat 32000 that no caller ever overrode, so any
   * model with a window smaller than that — `openai/gpt-4` at 8191,
   * `gpt-3.5-turbo` at 16385, `qwen-2.5-7b` at 32768 — got
   * `max(1, 8191 - 32000)` = a budget of **one token**. Every conversation then
   * measured as 100% full from its first message, and with auto-compaction on
   * (the default) that meant summarising the whole transcript on every single
   * turn: an extra model call each time, spending tokens to save tokens, on the
   * cheap models people pick precisely to avoid spending them.
   */
  const reserve = Math.min(
    Number(maxOutput) || Number(entry?.maxOutput) || 32_000,
    Math.floor(context / 2),
  );
  const budget = Math.max(1024, context - reserve);
  return {
    used,
    context,
    budget,
    ratio: Math.min(1, used / budget),
    // `counted` is exact; anything past it is arithmetic on character counts.
    exact: !folded && lastCounted === messages.length - 1,
  };
}

/** Whether the next turn should fold the older part up first. */
export function shouldCompact(messages, entry, options = {}) {
  const { ratio } = measure(messages, entry, options);
  // Nothing to gain from summarising a conversation that is mostly tail.
  // Counted on what is sent, not on everything ever said: a transcript already
  // folded is short, and folding it again would summarise three turns.
  return ratio >= COMPACT_AT && activeTranscript(messages).length > KEEP_RECENT + 2;
}

/**
 * Where the kept tail begins.
 *
 * Never between an assistant turn and the results of the tools it called: every
 * provider rejects a `tool` message whose call it cannot see, so a boundary in
 * the wrong place turns a working conversation into a 400. Walks backwards past
 * any leading tool message until the split is somewhere legal.
 */
export function tailStart(messages, keep = KEEP_RECENT) {
  let start = Math.max(0, messages.length - keep);
  while (start > 0 && messages[start].role === 'tool') start -= 1;
  return start;
}

/** The messages the model is actually sent: the latest summary, then the tail. */
export function activeTranscript(messages) {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'summary') {
      last = i;
      break;
    }
  }
  if (last < 0) return messages;

  const summary = messages[last];

  /**
   * The tail is chosen by what the summary *covers*, not by where it sits.
   *
   * It used to be `messages.slice(last + 1)`, which is right only if the summary
   * was inserted ahead of the turns it does not stand for. Nothing inserts it
   * there. `compact()` writes it with `appendMessage` — `MAX(seq) + 1` — and the
   * loop pushes it onto the end of the array, so it is the *last* element and
   * that slice is empty. The model was handed the summary alone: not the eight
   * turns `KEEP_RECENT` exists to preserve, and not the question the user had
   * just asked, which had been appended moments earlier.
   *
   * It recovered on the following turn, because a new user message then landed
   * after the summary — which is why this survived being looked at. What did not
   * recover was the kept turns: excluded from the summary by design, excluded
   * from the tail by position, and never sent again on any later turn either.
   *
   * `covers` is the `seq` of the newest message the summary stands for, so the
   * tail is everything newer than that, wherever the summary happens to lie.
   * Summaries written before this field existed do not have it; those fall back
   * to the old slice, which is what they were stored expecting and which is
   * harmless now — the turn they damaged is long past.
   */
  const covers = Number(summary.covers);
  const tail = Number.isFinite(covers)
    ? messages.filter((m, i) => i !== last && Number.isFinite(Number(m.seq)) && Number(m.seq) > covers)
    : messages.slice(last + 1);

  return [
    // Handed over as something the user said, because that is the only role
    // every provider accepts unconditionally at the start of a transcript.
    {
      id: summary.id,
      // Carried so a second fold can tell this apart from the turns after it.
      // Without it the re-roled summary has no position, and `covers` on the
      // next summary cannot be computed from the transcript it summarised.
      seq: summary.seq,
      role: 'user',
      text:
        'Summary of the earlier part of this conversation, which has been folded up to save room:\n\n' +
        `${summary.text}\n\n` +
        'Continue from here. Ask if you need something from before that the summary does not cover.',
    },
    ...tail,
  ];
}

const SYSTEM = [
  'You are compacting a working conversation so it can continue in a smaller context window.',
  '',
  'Write a summary the assistant can pick up from cold. It is not a description of the',
  'conversation — it is the conversation\'s state, handed over.',
  '',
  'Keep, in this order:',
  '  1. What the user is trying to achieve, in their words where possible.',
  '  2. Decisions made and why, including ones that were reversed.',
  '  3. Facts that were established: file paths, names, ids, numbers, versions, URLs.',
  '  4. Code and commands that matter — verbatim, not described.',
  '  5. What has been done so far, and what is still open.',
  '  6. Anything the user asked for that has not been delivered yet.',
  '',
  'Drop: pleasantries, retries that led nowhere, tool output that has been superseded,',
  'and your own commentary about the summarising.',
  '',
  'Be specific over brief. A summary that loses a file path costs far more than the',
  'tokens it saved. No preamble — start with the summary itself.',
].join('\n');

/**
 * Fold the older part of a conversation into a summary message.
 *
 * @returns the summary message that was appended, or null when there was
 *   nothing worth folding.
 */
/**
 * @param {{
 *   userId: string, chatId: string, entry: any, prefs: any, messages: any[],
 *   signal?: AbortSignal,
 *   stream?: (opts: any) => AsyncGenerator<any, void, unknown>,
 *   onProgress?: (p: { folding: number }) => void,
 * }} args
 *
 *  is optional and was not marked so: the agent loop passes one because
 * a turn can be stopped, and the chat route does not because a compaction the
 * user asked for by pressing a button has nothing to cancel it.
 */
export async function compact({ userId, chatId, entry, prefs, messages, signal, stream = streamCompletion, onProgress }) {
  const store = getStore();
  const live = activeTranscript(messages);
  const start = tailStart(live);
  if (start < 1) return null;

  const older = live.slice(0, start);
  /**
   * How many turns are about to be folded, said before the work begins.
   *
   * The only number about a compaction that is known and true. What follows is
   * a single request to a model, so there is no second, third or ninetieth
   * step to count off — a percentage here would be an animation wearing the
   * costume of a measurement. The interface shows this count and an
   * indeterminate bar, which is exactly as much as is actually known.
   */
  onProgress?.({ folding: older.length });
  const transcript = older
    .map((m) => {
      if (m.role === 'user') return `USER: ${m.text || '(files only)'}`;
      if (m.role === 'tool') {
        return (m.results || [])
          .map((r) => `TOOL ${r.name} ${r.isError ? '(failed)' : ''}: ${String(r.content ?? '').slice(0, 2000)}`)
          .join('\n');
      }
      const calls = (m.toolCalls || [])
        .map((c) => `CALLED ${c.name}(${JSON.stringify(c.input ?? {}).slice(0, 400)})`)
        .join('\n');
      return [m.text ? `ASSISTANT: ${m.text}` : '', calls].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');

  if (!transcript.trim()) return null;

  /**
   * Folding a transcript into prose is a writing job, not a reasoning one — and
   * it is routinely the largest single prompt the account sends. It runs on the
   * cheap tier where the account has one, and on the conversation's own model
   * where it does not. See server/roleModel.js.
   */
  const writer = await modelForRole(userId, 'compaction', entry, prefs);

  let summary = '';
  let spent = null;
  for await (const ev of stream({
    userId,
    entry: writer,
    system: SYSTEM,
    messages: [{ id: 'compact', role: 'user', text: transcript }],
    // No tools: this is a writing job, and a summariser that starts running
    // commands is a summariser that has misunderstood the assignment.
    tools: [],
    effort: prefs?.effort === 'low' ? 'low' : 'medium',
    // Cancellable. Somebody pressing stop means the whole turn, and a
    // compaction is the one call in it that can run for a while on a long
    // transcript — carrying on with it after the stop spends money on a
    // summary that nobody is waiting for.
    signal,
  })) {
    if (ev.type === 'text') summary += ev.delta;
    else if (ev.type === 'done' && ev.usage) spent = ev.usage;
  }

  /**
   * Book it. Folding a conversation up is a full model call over the whole
   * transcript — routinely the largest single prompt the account sends — and it
   * was recorded nowhere. On a deployment sharing one key that made the monthly
   * limit enforceable only against the visible half of the spend.
   */
  if (spent) {
    await recordUsage(userId, {
      chatId,
      model: writer.id,
      usage: spent,
      costUsd: priceTurn(writer, spent)?.usd || 0,
      role: 'compaction',
    }).catch(() => {});
  }

  summary = summary.trim();
  if (!summary) return null;

  const message = {
    id: crypto.randomUUID(),
    role: 'summary',
    text: summary,
    // What it stands in for, so the interface can say so honestly.
    replaced: older.length,
    /**
     * The newest message this summary speaks for, by `seq`.
     *
     * `replaced` is a count, and a count cannot survive being appended: the
     * summary lands at the end of the transcript, so "the first N" is no longer
     * a position anybody can act on. `activeTranscript` needs a boundary rather
     * than a quantity — everything newer than this is the tail, and the tail is
     * the eight turns `KEEP_RECENT` kept plus whatever the user has said since.
     */
    covers: Number(older[older.length - 1]?.seq),
  };
  await store.appendMessage(userId, chatId, message);
  return message;
}

export const LIMITS = { compactAt: COMPACT_AT, keepRecent: KEEP_RECENT };
