/**
 * Where a turn's words go, said per turn (owner, 2026-11-05).
 *
 * "Data cloaking" has no one meaning (docs/research/2026-11-04-data-cloaking-cot-monitorability.md).
 * The ones a person here actually meets: their details swapped for placeholders
 * (deidentify.js), endpoints asked per request to keep nothing (`privacy: 'strict'`),
 * and "cloaked" models, which a router serves under no name and whose makers keep what
 * they are sent. This file is what says which of those applied to a given reply, and
 * what stops a stealth model where a promise has been made that nothing is kept.
 *
 * Nothing here reads a message. A route is made of the model, the account's choices and
 * counts: what kinds were hidden and how many, never the values (`shield.counts`).
 */

/** The day the table below was read against the providers' own pages. Change it only by reading them again. */
export const POLICIES_CHECKED = '2026-11-06';

/**
 * What each provider says it does with what it is sent.
 *
 *   zero_retention  asked per request for endpoints that keep nothing and train on nothing
 *   no_training     not trained on; kept for a limited time to catch abuse
 *   by_endpoint     depends on who serves that model; a router chooses among them
 *   may_train       may be read by people and used to improve products
 *   unknown         nothing could be read; treated as kept and used
 *   stealth         an unannounced model; treated as kept and used
 *
 * `quote` is the provider's own sentence on the day above, so a reader can check the
 * summary against it and the next person to read the page can see what has moved.
 */
export const PROVIDER_POLICIES = Object.freeze({
  anthropic: {
    tier: 'no_training',
    source: 'https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data',
    quote: 'we automatically delete inputs and outputs on our backend within 30 days of receipt or generation',
  },
  openai: {
    tier: 'no_training',
    source: 'https://developers.openai.com/api/docs/guides/your-data',
    quote: 'data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in',
  },
  google: {
    tier: 'may_train',
    source: 'https://aistudio.google.com/docs/terms',
    quote: 'human reviewers may read, annotate, and process your API input and output.',
  },
  openrouter: {
    tier: 'by_endpoint',
    source: 'https://openrouter.ai/docs/guides/features/zdr',
    quote: 'we take a conservative stance and assume that the endpoint both retains and trains on data',
  },
  orcarouter: {
    tier: 'unknown',
    source: 'https://www.orcarouter.ai/privacy',
    quote: null,
  },
});

/** The stealth models' page, and what it did not say on the day above. */
export const STEALTH_POLICY = Object.freeze({
  tier: 'stealth',
  source: 'https://openrouter.ai/provider/stealth',
  quote: null,
});

const WARNS = new Set(['may_train', 'unknown', 'stealth']);

/** A model a router serves under no name: `stealth/…`, or OpenRouter's own `…-alpha`, `…-beta`. */
const STEALTH_ID = /(?:^|\/)stealth\/|(?:^|\/)openrouter\/[a-z0-9.-]+-(?:alpha|beta)(?::free)?$/i;

export function isStealthModel(entry) {
  return STEALTH_ID.test(String(entry?.model || '')) || STEALTH_ID.test(String(entry?.id || ''));
}

/**
 * The tier a model on this account falls in.
 *
 * Strict reaches the wire only on OpenRouter, the one provider with a per-request
 * switch. On any other provider it changes nothing, so it must not read as if it did.
 */
export function tierFor(entry, privacy = 'standard') {
  if (isStealthModel(entry)) return 'stealth';
  if (entry?.provider === 'openrouter' && privacy === 'strict') return 'zero_retention';
  return PROVIDER_POLICIES[entry?.provider]?.tier || 'unknown';
}

/** Whose words the reasoning on screen is: a summary a provider wrote, or the text a model sent. */
const SUMMARISES = /^(?:anthropic|openai|google)\//i;

export function thinkingKind(entry) {
  if (['anthropic', 'openai', 'google'].includes(entry?.provider)) return 'summary';
  return SUMMARISES.test(String(entry?.model || '')) ? 'summary' : 'model_text';
}

/**
 * One reply's route, as the browser shows it and the message keeps it.
 *
 * @param {{ entry: any, privacy?: string, masked?: Record<string, number> | null }} what
 */
export function routeFor({ entry, privacy = 'standard', masked = null }) {
  const tier = tierFor(entry, privacy);
  return {
    provider: String(entry?.provider || ''),
    model: String(entry?.label || entry?.model || ''),
    tier,
    warn: WARNS.has(tier),
    strict: privacy === 'strict',
    masked: masked ? { ...masked } : null,
    thinking: thinkingKind(entry),
  };
}

/**
 * Why a stealth model is not used here, or null when it may be.
 *
 * Strict is a promise that nothing is kept, and a conversation holding Google data runs
 * under it (`streamCompletion`). A router would refuse too, but only after a request that
 * spends the day's allowance, and with a message that does not say why.
 */
export function stealthRefusal(entry, privacy) {
  if (privacy !== 'strict' || !isStealthModel(entry)) return null;
  const label = entry?.label || entry?.model || 'This model';
  return `${label} is an unannounced preview and nothing says what it keeps, so it was not sent this. Provider privacy is Strict, or the conversation holds data from your Google account. Pick another model.`;
}

/** The table for the overview page. `tier` as above; the words are the page's. */
export function policyTable() {
  return {
    checked: POLICIES_CHECKED,
    policies: [
      ...Object.entries(PROVIDER_POLICIES).map(([provider, policy]) => ({ provider, ...policy })),
      { provider: 'stealth', ...STEALTH_POLICY },
    ],
  };
}
