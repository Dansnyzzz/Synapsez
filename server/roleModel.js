import { resolve as resolveModelId } from './models.js';
import { resolveForUser } from './autoPick.js';
import { getStore } from './store/index.js';
import { log } from './util/trace.js';
import { mayReceiveGoogleData, googleDataInScope } from './googleData.js';

/**
 * Not every model call in a turn deserves the turn's model.
 *
 * A conversation set to Opus is set to Opus because the *answering* is worth it.
 * Then the same model gets used to fold the older turns into a summary, to pull
 * three prices off a web page, and to turn one question into four search
 * queries — none of which is reasoning, and all of which were being billed at
 * the flagship rate. On a long conversation the compaction call is routinely the
 * largest single prompt the account sends, and it is a writing job.
 *
 * So the roles that copy, reformat and summarise get a cheap model, and the
 * roles that decide keep the expensive one. The split is deliberately
 * conservative: anything that reasons about the user's actual question stays
 * where it was, because a cheap model that summarises badly loses the decisions
 * a conversation rests on, and that is not a saving.
 */

/**
 * Which roles may be moved, and what they are.
 *
 *   compaction  Rewriting a transcript as prose. The largest prompt in the app,
 *               and the one furthest from reasoning.
 *   extract     Copying stated facts off a page. The prompt already forbids
 *               inference in as many words.
 *   plan        One question into a handful of search queries. Rewriting.
 *
 * Everything absent from this list — the turn itself, sub-agents, and every
 * role of the research debate — keeps the conversation's model, because each of
 * them is answering rather than transcribing.
 */
const CHEAP_ROLES = new Set(['compaction', 'web_extract', 'research.plan']);

/**
 * The cheap tier, in order of preference.
 *
 * Named rather than derived, because "cheapest" is the wrong sort by itself: the
 * cheapest model an account can reach is often a free one under a hard rate
 * limit, and having compaction fail on a limit is worse than having it cost a
 * fraction of a cent. These are the small, fast, reliable models of each
 * provider — chosen to be good enough at rewriting, which is all they are asked
 * to do.
 */
const CHEAP_BY_PROVIDER = {
  anthropic: 'anthropic/claude-haiku-4-5',
  openai: 'openai/gpt-5-mini',
  google: 'google/gemini-flash-latest',
};

/**
 * Worth knowing before wondering why this seems to do nothing.
 *
 * Routing only fires when the swap is *provably* cheaper, and the catalogue only
 * carries verified prices for the Anthropic entries — the OpenAI and Google ones
 * are `price: null`, which is the catalogue being honest about not knowing
 * rather than an oversight. So today this moves Anthropic conversations and
 * leaves the others exactly where they were.
 *
 * That is the right failure. "Probably cheaper" is not a thing to decide on
 * somebody else's bill, and a curated list that quietly routed a
 * `gemini-flash-lite` conversation *up* to `gemini-flash` would cost money while
 * claiming to save it. Filling in a verified price for an entry turns this on
 * for that provider, and nothing else has to change.
 */

/**
 * Pick the model for one role.
 *
 * Three rules, in order:
 *
 *   1. A role that is not on the cheap list keeps `entry` exactly. No lookup, no
 *      surprise, no way for this function to change how an answer is produced.
 *   2. An explicit `prefs.cheapModel` wins, because somebody who set it meant it.
 *   3. Otherwise the small model of the *same provider* — staying on one
 *      provider keeps the failure modes and the billing in one place, and needs
 *      no key lookup, because a turn already running there proves the key.
 *
 * Falls back to `entry` at every step. A role that cannot be moved cheaply runs
 * where it was rather than failing, which is the only acceptable behaviour for
 * something that sits in the middle of a turn.
 *
 * A conversation holding Google data (`options.googleData`, or the scope a tool
 * runs in) keeps a cheap model on another provider only where that data may go.
 *
 * @param entry the conversation's resolved model — the thing being saved from.
 * @param {{ googleData?: boolean }} [options]
 */
export async function modelForRole(userId, role, entry, prefs = null, options = {}) {
  if (!CHEAP_ROLES.has(role) || !entry) return entry;
  const googleData = !!options.googleData || googleDataInScope();

  try {
    const settings = prefs || (await getStore().getUserSetting(userId, 'prefs')) || {};

    if (settings.cheapModel) {
      const chosen = await resolveForUser(userId, settings.cheapModel);
      if (chosen && (!googleData || mayReceiveGoogleData(chosen.provider))) return note(role, entry, chosen, 'set in preferences');
    }

    /**
     * The small model of the same provider.
     *
     * No key lookup, and that is not an oversight: the turn is *already running*
     * on this provider, so the account demonstrably has a key for it. Asking the
     * store again would be a query per compaction to confirm something the call
     * stack already proves.
     *
     * Only ever a saving if it is genuinely cheaper — a catalogue edit that made
     * the "cheap" model dearer than the conversation's must not quietly cost
     * somebody money, and an unpriced entry is an unknown rather than a bargain.
     */
    const sameProvider = CHEAP_BY_PROVIDER[entry.provider];
    if (sameProvider) {
      const chosen = await resolveModelId(sameProvider);
      if (chosen && cheaperThan(chosen, entry)) return note(role, entry, chosen, 'small model, same provider');
    }
  } catch (err) {
    // Routing is an optimisation. It must never be the reason a turn fails.
    log.error('role routing failed, using the conversation model', err, { role });
  }

  return entry;
}

/** Compare on input price, which is what these roles overwhelmingly spend. */
function cheaperThan(candidate, current) {
  const a = candidate?.price?.in;
  const b = current?.price?.in;
  // An unpriced model is an unknown, and an unknown is not a saving worth
  // taking on somebody else's behalf.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a < b;
}

function note(role, from, to, why) {
  if (from.id !== to.id) log.info('role routed to a cheaper model', { role, from: from.id, to: to.id, why });
  return to;
}

export const __testing = { CHEAP_ROLES, CHEAP_BY_PROVIDER, cheaperThan };
