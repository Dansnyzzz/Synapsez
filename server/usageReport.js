import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getApiKeys, providerStatus } from './settings.js';
import { limitFor } from './usage.js';
import { withMarkup } from './pricing.js';

/**
 * Settings → Usage (owner, 2026-10-31): how much of each provider this account
 * has used, and what is left — per provider, and per key where a provider says.
 *
 * Two kinds of figure, never mixed up:
 *
 *   - **What the provider reports.** OpenRouter answers `GET /api/v1/key` for a
 *     key with its free-model requests today (used, limit, remaining — reset at
 *     midnight UTC), its spend today, this week (from Monday, UTC) and this
 *     month, its own spending limit and when that resets, and whether its
 *     account has ever bought credit. Read for each of the account's own keys,
 *     never for the deployment's shared one: that key's figures are the whole
 *     deployment's, which is not this account's to read.
 *   - **What Synapsez counted.** Every model call is booked in `usage_events`
 *     (usage.js `record`), so requests, tokens and the cost estimate are known
 *     for every provider, per hour, for as far back as the page draws. Google's
 *     Gemini API and OrcaRouter have no endpoint that reports what is left of a
 *     key's allowance, so for them this is all there is, and the page says so.
 *
 * The browser draws the week, the heatmap and the pace from the hourly rows in
 * its own time zone; the server does not guess one.
 */

/** How long a provider may take to say what is left before the page goes on without it. */
const LIVE_TIMEOUT_MS = 6_000;
/** Enough hours for this week and the same stretch of the week before. */
const HOURS_BACK = 15 * 24;

/** The provider a stored model id belongs to: the part before its first slash. */
export function providerOf(model) {
  const id = String(model || '');
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : 'other';
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * OpenRouter's answer about one key, reduced to what the page shows. Anything
 * missing stays null — shown as "not reported", never as zero.
 *
 * @param {any} data  the `data` object of `GET /api/v1/key`
 */
export function readOpenRouterKey(data) {
  const free = data?.free_model_daily_requests;
  const budget = data?.effective_budget;
  return {
    label: typeof data?.label === 'string' ? data.label.slice(0, 80) : null,
    freeToday: free && num(free.limit) != null ? { used: num(free.used) ?? 0, limit: num(free.limit), remaining: num(free.remaining) } : null,
    spend: { today: num(data?.usage_daily), week: num(data?.usage_weekly), month: num(data?.usage_monthly), total: num(data?.usage) },
    limit: num(data?.limit) != null ? { amount: num(data.limit), remaining: num(data.limit_remaining), reset: typeof data.limit_reset === 'string' ? data.limit_reset : null } : null,
    budget:
      budget && num(budget.limit_usd) != null
        ? {
            limit: num(budget.limit_usd),
            spent: num(budget.spend_usd),
            remaining: num(budget.remaining_usd),
            interval: typeof budget.reset_interval === 'string' ? budget.reset_interval : null,
            resetsAt: typeof budget.resets_at === 'string' ? budget.resets_at : null,
          }
        : null,
    // Whether its account has ever paid for credit — the line between 50 and
    // 1,000 free requests a day.
    neverPaid: typeof data?.is_free_tier === 'boolean' ? data.is_free_tier : null,
  };
}

/**
 * What OpenRouter said about each key in the last few seconds, by a hash of
 * the key. The warning above the composer asks after every turn and the Usage
 * page as it opens; one answer serves both, and two asking at once share one
 * request. Short, so a count is never more than a turn behind; per instance,
 * which on a serverless deployment only ever makes it fresher.
 */
const LIVE_FRESH_MS = 15_000;
const liveCache = new Map();

/** Ask OpenRouter about one key. Never throws: a key it cannot read says why. */
function askOpenRouter(key, fetchImpl) {
  const id = crypto.createHash('sha256').update(key).digest('base64url');
  const hit = liveCache.get(id);
  // Only an answer asked the same way: the suites ask through stubs of their own.
  if (hit && hit.until > Date.now() && hit.fetchImpl === fetchImpl) return hit.answer;
  const answer = askOpenRouterNow(key, fetchImpl);
  liveCache.set(id, { until: Date.now() + LIVE_FRESH_MS, answer, fetchImpl });
  // Never kept past its time, and never more than a handful of keys.
  for (const [k, v] of liveCache) if (v.until <= Date.now()) liveCache.delete(k);
  return answer;
}

async function askOpenRouterNow(key, fetchImpl) {
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body = await res.json();
    return { ok: true, ...readOpenRouterKey(body?.data) };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * @param {{ id: string, monthly_token_limit?: number | null }} user
 * @param {{ fetchImpl?: typeof fetch, part?: 'all' | 'limits' }} [options]
 *   `limits` leaves out the hour-by-hour rows: all the warning above the
 *   composer needs, asked after every turn.
 */
export async function usageReport(user, { fetchImpl = fetch, part = 'all' } = {}) {
  const store = getStore();
  const [hours, month, openrouterKeys, status] = await Promise.all([
    part === 'limits' ? [] : store.usageByHour(user.id, HOURS_BACK),
    store.usageThisMonth(user.id),
    getApiKeys(user.id, 'openrouter', { includeResting: true }),
    providerStatus(user.id),
  ]);

  const own = openrouterKeys.filter((k) => !k.shared);
  const live = await Promise.all(own.map(async (k) => ({ index: k.index, ...(await askOpenRouter(k.key, fetchImpl)) })));

  return {
    generatedAt: new Date().toISOString(),
    hours: hours.map((row) => ({
      at: new Date(row.hour).toISOString(),
      provider: providerOf(row.model),
      model: String(row.model),
      calls: Number(row.calls) || 0,
      tokens: Number(row.tokens) || 0,
      // Stored at the provider's price; shown at what is charged (pricing.js).
      cost: withMarkup(Number(row.cost) || 0),
    })),
    month: { tokens: month.tokens, calls: month.calls, cost: withMarkup(Number(month.cost) || 0) },
    // The deployment's own monthly ceiling, which applies only on its shared keys.
    sharedLimit: limitFor(user),
    live: { openrouter: live },
    // Each provider this account rides the deployment's key for — where the
    // monthly ceiling applies (checkQuota counts every call of the month, and
    // stops a turn only on a shared key).
    sharedKey: Object.fromEntries(Object.entries(status).map(([provider, s]) => [provider, !!s.shared])),
  };
}
