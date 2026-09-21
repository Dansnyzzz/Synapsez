/**
 * Why a reply stopped, in one vocabulary the whole app can read.
 *
 * Every adapter already had the answer and every adapter threw it away. The
 * `done` event carried `stopReason` as whatever string the provider happened to
 * use — `max_tokens`, `length`, `MAX_TOKENS`, `refusal`, `content_filter`,
 * `SAFETY` — and nothing downstream looked at it. The agent loop read it only
 * to pass it on, and the browser's `done` handler ignored it outright.
 *
 * That is not a cosmetic gap. Three of those outcomes produce a reply that is
 * *indistinguishable from a finished one*:
 *
 *   **Truncated.** The model hit its output cap mid-sentence. The stream ends,
 *   the spinner stops, and the last paragraph simply has no end. Somebody reads
 *   it as the answer.
 *
 *   **Refused.** Anthropic's safety classifiers return HTTP 200 with
 *   `stop_reason: "refusal"` and *no content at all*. The turn "succeeds" and
 *   the user gets an empty message with no explanation of any kind.
 *
 *   **Filtered.** OpenAI's `content_filter` and Gemini's `SAFETY` /
 *   `PROHIBITED_CONTENT` / `RECITATION` do the same thing in their own words.
 *
 * So the raw string is normalised here, once, and travels beside it. The raw
 * value is kept as well — it is what a provider's support desk will ask for,
 * and inventing a vocabulary is no reason to destroy theirs.
 *
 * `kind` is the stable half; only `end_turn` and `tool_use` mean "this reply is
 * whole". Everything else is something to say out loud.
 */

/**
 * The vocabulary.
 *
 *   end_turn      finished on its own terms — the reply is complete
 *   tool_use      stopped to call tools; the loop continues
 *   truncated     hit the output cap. The reply is cut off, not finished.
 *   refused       a safety classifier declined. Usually no content at all.
 *   filtered      the provider's content filter blocked the output
 *   recitation    Gemini stopped because the output reproduced training data
 *   stop_sequence hit a configured stop string
 *   unknown       the provider said something we do not have a word for
 */
export const STOP_KINDS = [
  'end_turn',
  'tool_use',
  'truncated',
  'refused',
  'filtered',
  'recitation',
  'stop_sequence',
  'max_steps',
  'token_limit',
  'unknown',
];

/** The kinds that mean the reply in front of the user is whole. */
const COMPLETE = new Set(['end_turn', 'tool_use', 'stop_sequence']);

/** Whether this outcome left the user with a finished answer. */
export const isComplete = (kind) => COMPLETE.has(kind);

/**
 * The kinds that stopped for want of budget rather than because anything went
 * wrong — so the same turn, unchanged, carries on if it is asked to.
 *
 * This is the distinction the interface needs to decide whether offering a
 * Continue button is honest. A reply blocked by a content filter must not get
 * one: pressing it would produce the same refusal.
 */
const RESUMABLE = new Set(['max_steps', 'token_limit']);

/** Whether a turn that stopped this way can simply be told to carry on. */
export const isResumable = (kind) => RESUMABLE.has(kind);

/**
 * The `stop` descriptor for a turn that ran out of a budget.
 *
 * Shaped exactly like `normaliseStop`'s result so the browser has one thing to
 * read, with `resumable` added. These do not come from a provider — they are
 * this server's own limits — so `raw` is the kind itself.
 */
export function budgetStop(kind, message) {
  return { kind, raw: kind, message, detail: null, resumable: isResumable(kind) };
}

/**
 * Provider wording → our vocabulary.
 *
 * Matched case-insensitively on the exact string, because these are enum values
 * rather than prose: Gemini shouts (`MAX_TOKENS`), OpenAI and Anthropic do not,
 * and OpenRouter passes through whatever the model behind it said. Anything
 * unrecognised becomes `unknown` rather than being quietly read as success —
 * a stop reason nobody has a word for is exactly the case worth surfacing.
 */
const KNOWN = new Map(
  Object.entries({
    // Anthropic
    end_turn: 'end_turn',
    tool_use: 'tool_use',
    max_tokens: 'truncated',
    stop_sequence: 'stop_sequence',
    refusal: 'refused',
    pause_turn: 'end_turn',
    model_context_window_exceeded: 'truncated',

    // OpenAI and every Chat-Completions-shaped API behind it
    stop: 'end_turn',
    length: 'truncated',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
    content_filter: 'filtered',

    // Google
    STOP: 'end_turn',
    MAX_TOKENS: 'truncated',
    SAFETY: 'filtered',
    RECITATION: 'recitation',
    PROHIBITED_CONTENT: 'filtered',
    SPII: 'filtered',
    BLOCKLIST: 'filtered',
    IMAGE_SAFETY: 'filtered',
    LANGUAGE: 'filtered',
    MALFORMED_FUNCTION_CALL: 'unknown',
    OTHER: 'unknown',
    FINISH_REASON_UNSPECIFIED: 'unknown',
  }).map(([raw, kind]) => [raw.toLowerCase(), kind]),
);

/**
 * What to tell the person waiting.
 *
 * Written as a sentence they can act on rather than a status code. `detail` is
 * whatever the provider added — Anthropic attaches a refusal category and an
 * explanation on `stop_details` — and is appended when there is one, because a
 * refusal that says which category it was is a great deal more useful than one
 * that does not.
 */
const SENTENCE = {
  truncated:
    'The reply hit this model’s maximum output length and stopped mid-answer. ' +
    'Ask it to continue, or pick a model with a larger output limit.',
  refused:
    'The provider’s safety system declined this request, so the model produced nothing. ' +
    'Rephrasing, or a different model, is the way on.',
  filtered:
    'The provider’s content filter blocked this reply. What you can see is only the part that got through.',
  recitation:
    'The model stopped because its answer was reproducing source material too closely. ' +
    'Ask for it in your own terms and it will usually go through.',
  unknown: 'The provider ended this reply for a reason it did not explain.',
};

/**
 * Normalise one provider's stop reason.
 *
 * @param raw     whatever the provider called it, or null when it said nothing
 * @param detail  extra wording from the provider (Anthropic's `stop_details`)
 * @returns {{kind: string, raw: string|null, message: string|null, detail: string|null}}
 *   `message` is null exactly when the reply is complete — so a caller can use
 *   its presence as "is there anything to say here?" without a second check.
 *   `detail` is the provider's own words, kept apart from `message` because the
 *   browser translates from `kind` and would otherwise discard them; it is null
 *   whenever the provider added nothing.
 */
export function normaliseStop(raw, detail = null) {
  // Said nothing at all. Treated as a clean finish rather than as a mystery:
  // several OpenAI-compatible servers omit `finish_reason` on the final chunk,
  // and narrating that to everybody using one of them would be noise.
  // `detail` is carried on every branch, including the ones that never have
  // one. A field that is sometimes absent and sometimes null is two shapes for
  // the consumer to handle, and the browser reads this straight off the wire.
  if (raw == null || raw === '') return { kind: 'end_turn', raw: null, message: null, detail: null };

  const kind = KNOWN.get(String(raw).toLowerCase()) || 'unknown';
  if (isComplete(kind)) return { kind, raw: String(raw), message: null, detail: null };

  const extra = String(detail || '').trim();
  const base = SENTENCE[kind] || SENTENCE.unknown;
  return {
    kind,
    raw: String(raw),
    message: extra ? `${base} The provider said: ${extra}` : base,
    /**
     * The provider's own words, kept as their own field.
     *
     * Folding this into `message` alone loses it. The browser translates from
     * `kind` and uses `message` only as a fallback for a kind it has no string
     * for — so on a refusal, where `stop.refused` exists in both locales, the
     * translation always won and the category and explanation were discarded.
     * That is the single most actionable part of a refusal and the only part
     * not already implied by `kind`, so it travels separately and the
     * interface appends it to whichever sentence it ends up showing.
     */
    detail: extra || null,
  };
}

/**
 * Anthropic's `stop_details`, as a sentence fragment.
 *
 * Populated only on a refusal — every other stop reason leaves it null — so
 * this is a guard as much as a formatter. The category is an open set, so it is
 * passed through rather than mapped.
 */
export function refusalDetail(stopDetails) {
  if (!stopDetails || stopDetails.type !== 'refusal') return null;
  const category = stopDetails.category ? `category “${stopDetails.category}”` : null;
  const explanation = String(stopDetails.explanation || '').trim() || null;
  return [category, explanation].filter(Boolean).join(' — ') || null;
}
