import { withMarkup } from './pricing.js';
import crypto from 'node:crypto';
import { getStore } from './store/index.js';

/**
 * Per-account usage accounting.
 *
 * A limit is only meaningful when the account is spending someone else's money
 * — i.e. riding the deployment-wide key. Somebody using their own API key pays
 * their own provider directly, so capping them would be pointless paternalism.
 */
export function defaultTokenLimit() {
  const raw = Number(process.env.DEFAULT_MONTHLY_TOKEN_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * The most one turn may spend before it stops and asks to be continued.
 *
 * The monthly quota bounds an account; nothing bounded a turn. `maxSteps` is a
 * count, and thirty steps of a flagship model — each re-sending the catalogue,
 * the prompt and a transcript that only grows — has no upper bound in money. A
 * tool that fails the same way thirty times pays thirty full prompts and nothing
 * notices (PERF-009). An account well inside its month could still spend without
 * limit inside one turn.
 *
 * Shaped by the same principle as the monthly limit above: a cap is for
 * someone else's money. On the deployment's shared key the default is two
 * million tokens a turn — room for a dozen near-full steps on a 200k window,
 * well past any turn that is making progress. On the account's own key there is
 * no default, because capping how somebody spends their own credit is not this
 * app's call. `MAX_TURN_TOKENS` overrides both, and `0` turns it off.
 *
 * Counted in tokens rather than dollars on purpose: every provider reports
 * tokens, while the cost estimate is missing for unpriced models, and a ceiling
 * that silently reads zero is not a ceiling.
 *
 * Reaching it is a stop, not a failure. The turn ends like the step limit does,
 * and sending a message continues with a fresh count.
 */
export const SHARED_TURN_TOKEN_LIMIT = 2_000_000;

export function turnTokenLimit({ usingSharedKey }) {
  const raw = process.env.MAX_TURN_TOKENS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 0 ? n : null;
  }
  return usingSharedKey ? SHARED_TURN_TOKEN_LIMIT : null;
}

export function limitFor(user) {
  // An explicit 0 means "unlimited" and must not fall through to the default.
  if (user?.monthly_token_limit != null) {
    const own = Number(user.monthly_token_limit);
    return own > 0 ? own : null;
  }
  return defaultTokenLimit();
}

/**
 * @returns {{allowed: boolean, reason?: string, used: number, limit: number|null}}
 */
export async function checkQuota(user, { usingSharedKey, store = getStore() }) {
  const limit = limitFor(user);
  // One lookup, whichever branch is taken. It used to be written out twice, so
  // every allowed turn asked the database the same question a second time.
  const { tokens } = await store.usageThisMonth(user.id);

  if (!limit || !usingSharedKey) {
    return { allowed: true, used: tokens, limit: usingSharedKey ? limit : null };
  }
  if (tokens >= limit) {
    return {
      allowed: false,
      used: tokens,
      limit,
      reason:
        `You have used ${tokens.toLocaleString()} of your ${limit.toLocaleString()} shared tokens this month. ` +
        'Add your own API key in Settings → Providers to keep going without a limit.',
    };
  }
  return { allowed: true, used: tokens, limit };
}

/**
 * Book what a model call cost, whoever made it.
 *
 * `role` is the field that closes a real hole. This function had exactly two
 * callers — the agent loop and the sub-agent fan-out — so compaction, every
 * role of a deep_research run, and `web_extract`'s page reader all spent tokens
 * that appeared nowhere. On a deployment sharing one key that is not merely a
 * reporting gap: `checkQuota` enforces the monthly limit against the total in
 * this table, so an account could run research all day and never approach a cap
 * it was, on paper, subject to.
 *
 * Anything that calls a model passes its own role now, and the usage page can
 * finally say where the money went.
 */
export async function record(userId, { chatId, model, usage, costUsd, role = 'turn' }) {
  if (!usage) return;
  await getStore().recordUsage(userId, {
    id: crypto.randomUUID(),
    chatId,
    model,
    role,
    inputTokens: usage.input || 0,
    outputTokens: usage.output || 0,
    // A subset of inputTokens, not an addition to it — see estimateCost. Held
    // separately because the ratio between the two is the cache hit rate, which
    // there was previously no way to read at all.
    cacheReadTokens: usage.cacheRead || 0,
    costUsd: costUsd || 0,
  });
}

export async function summary(userId) {
  const store = getStore();
  const [month, byModel, byRole] = await Promise.all([
    store.usageThisMonth(userId),
    store.usageByModel(userId, 30),
    store.usageByRole(userId, 30),
  ]);
  // Cached input as a share of all input, which is the number to watch when
  // tuning what goes in the cached prefix and what does not.
  const cacheHitRate = month.tokens > 0 ? (month.cacheRead || 0) / month.tokens : 0;
  // Stored at the provider's price; shown at what is charged (pricing.js).
  const charged = (row) => (row && row.cost != null ? { ...row, cost: withMarkup(Number(row.cost)) } : row);
  return { month: { ...charged(month), cacheHitRate }, byModel: byModel.map(charged), byRole: byRole.map(charged) };
}


