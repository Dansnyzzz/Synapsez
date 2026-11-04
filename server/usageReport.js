import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getApiKeys, providerStatus, keyEntries, setKeyMeta } from './settings.js';
import { limitFor } from './usage.js';
import { withMarkup } from './pricing.js';
import { orcaBalance, orcaStanding } from './keyIntake.js';
import { ORCA_FREE_SETTING } from './models.js';

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
 *     Gemini API has no endpoint that reports what is left of a key's allowance,
 *     so for it this is all there is, and the page says so.
 *   - **Both, for OrcaRouter.** It reports a key's credit
 *     (`/v1/dashboard/billing/subscription`) and nothing about its free requests:
 *     its docs say plainly that a window's remainder cannot be read. So its free
 *     bar is Synapsez's own count, against the ceiling OrcaRouter publishes, and
 *     the page says whose number each one is.
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

/** Ask OrcaRouter what credit one key can draw on. Never throws. Shared for a few seconds, as above. */
function askOrcaRouter(key, fetchImpl) {
  const id = `orca:${crypto.createHash('sha256').update(key).digest('base64url')}`;
  const hit = liveCache.get(id);
  if (hit && hit.until > Date.now() && hit.fetchImpl === fetchImpl) return hit.answer;
  const answer = (async () => {
    try {
      const res = await fetchImpl('https://api.orcarouter.ai/v1/dashboard/billing/subscription', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected' };
      if (!res.ok) return { ok: false, reason: 'unavailable' };
      return { ok: true, balance: orcaBalance(await res.json()) };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  })();
  liveCache.set(id, { until: Date.now() + LIVE_FRESH_MS, answer, fetchImpl });
  for (const [k, v] of liveCache) if (v.until <= Date.now()) liveCache.delete(k);
  return answer;
}

/** A free id on OrcaRouter, as `usage_events.model` stores it. */
const isOrcaFree = (model) => /^orcarouter\/(?:.*-free|orcarouter\/free)$/.test(String(model));

/**
 * OrcaRouter's free requests today: what this account sent, and the ceiling.
 *
 * The ceiling depends on what the workspace has ever paid, which no endpoint
 * reports. What can be known is used, and nothing past it is guessed:
 *
 *   - **upper rung**: its credit is past the rung's spend, or more requests went
 *     through today than the lower rung allows, or either was seen before;
 *   - **lower rung**: OrcaRouter's free tier refused this workspace for it, and
 *     nothing since has shown otherwise. A free request that went through in a
 *     later hour has: a top-up, or a linked GitHub account, need nothing else said;
 *   - **not known**: `limit` stays null, the page draws no bar, and it says both
 *     ceilings. A bar against the wrong one would warn at 40 of 800.
 *
 * What is proved is kept beside the key, so tomorrow does not start from nothing,
 * and the suggestion can read it (recommend.js). Requests made elsewhere with the
 * same workspace are not counted here, and the page says so.
 */
async function orcaFreeToday(userId, rows, live, now = new Date()) {
  const store = getStore();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const pack = await store.getSetting(ORCA_FREE_SETTING).catch(() => null);
  const ladder = Array.isArray(pack?.tiers) && pack.tiers.length ? pack.tiers : [];
  const own = pack?.models && typeof pack.models === 'object' ? pack.models : {};
  const byModel = new Map();
  for (const row of rows) {
    if (new Date(row.hour).getTime() < dayStart || !isOrcaFree(row.model)) continue;
    byModel.set(String(row.model), (byModel.get(String(row.model)) || 0) + (Number(row.calls) || 0));
  }
  const ownLadder = (model) => own[String(model).replace(/^orcarouter\//, '')] || null;
  let used = 0;
  for (const [model, calls] of byModel) if (!ownLadder(model)) used += calls;

  const latest = Math.max(0, ...rows.filter((row) => isOrcaFree(row.model)).map((row) => new Date(row.hour).getTime()));
  const entries = (await keyEntries(userId, 'orcarouter')).map((entry) => ({
    ...entry,
    // Hours are what is counted, so one starting after the refusal came after it.
    lifted: entry.freeTier === 'low' && !!entry.freeTierAt && latest > new Date(entry.freeTierAt).getTime(),
  }));
  const rung = ladder.length > 1 ? ladder[ladder.length - 1].minPaidUsd : 20;
  const lowest = ladder[0]?.rpd ?? Infinity;
  const standings = live.filter((l) => l.ok).map((l) => ({ index: l.index, ...orcaStanding(l.balance, rung) }));
  const proved = entries.some((e) => e.freeTier === 'high') || standings.some((s) => s.freeTier === 'high') || used > lowest;
  const tier = proved ? 'high' : entries.length && entries.every((e) => e.freeTier === 'low' && !e.lifted) ? 'low' : null;

  // Kept when it changed, and only then: this runs after every turn.
  for (const entry of entries) {
    const standing = standings.find((s) => s.index === entry.index);
    const meta = {};
    if (proved && entry.freeTier !== 'high') meta.freeTier = 'high';
    else if (!proved && entry.lifted) meta.freeTier = null;
    if (standing?.paid != null && standing.paid !== entry.paid) meta.paid = standing.paid;
    if (Object.keys(meta).length) await setKeyMeta(userId, 'orcarouter', entry.key, meta).catch(() => {});
  }

  const rungFor = (list) => (tier === 'high' ? list[list.length - 1] : tier === 'low' ? list[0] : null);
  const models = [...byModel]
    .filter(([model]) => ownLadder(model))
    .map(([model, calls]) => ({ id: model, used: calls, limit: rungFor(ownLadder(model))?.rpd ?? null }));
  return { used, limit: ladder.length ? rungFor(ladder)?.rpd ?? null : null, tier, tiers: ladder, models };
}

/**
 * Which OpenRouter key this account's next free request goes to: the first the
 * router would try, in its own order, that has any of today's left. Null when none
 * has. The Usage page warns about this one, because the others are not what the
 * account is spending: a first key out of requests beside a second with plenty is
 * nothing to warn anybody about (owner, 2026-11-04).
 */
async function openRouterKeyInUse(userId, live) {
  const order = await getApiKeys(userId, 'openrouter', { free: true });
  for (const { index, shared } of order) {
    if (shared) continue;
    const report = live.find((l) => l.index === index);
    const free = report?.ok ? report.freeToday : null;
    if (!free || !(free.limit > 0) || free.used < free.limit) return index;
  }
  return null;
}

/**
 * @param {{ id: string, monthly_token_limit?: number | null }} user
 * @param {{ fetchImpl?: typeof fetch, part?: 'all' | 'limits' }} [options]
 *   `limits` leaves out the hour-by-hour rows: all the warning above the
 *   composer needs, asked after every turn.
 */
export async function usageReport(user, { fetchImpl = fetch, part = 'all' } = {}) {
  const store = getStore();
  const [hours, month, monthModels, openrouterKeys, status] = await Promise.all([
    part === 'limits' ? [] : store.usageByHour(user.id, HOURS_BACK),
    store.usageThisMonth(user.id),
    part === 'limits' ? [] : store.usageThisMonthByModel(user.id),
    getApiKeys(user.id, 'openrouter', { includeResting: true }),
    providerStatus(user.id),
  ]);

  const own = openrouterKeys.filter((k) => !k.shared);
  const live = await Promise.all(own.map(async (k) => ({ index: k.index, ...(await askOpenRouter(k.key, fetchImpl)) })));

  // The account's own OrcaRouter keys only, as with OpenRouter's: the deployment's figures are not this account's.
  const orcaKeys = (await getApiKeys(user.id, 'orcarouter', { includeResting: true })).filter((k) => !k.shared);
  const orcaLive = await Promise.all(orcaKeys.map(async (k) => ({ index: k.index, ...(await askOrcaRouter(k.key, fetchImpl)) })));
  const orcaFree = orcaKeys.length ? await orcaFreeToday(user.id, part === 'limits' ? await store.usageByHour(user.id, 25) : hours, orcaLive) : null;

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
    // The same month by provider (CODE-066): the page's month line was summed from
    // the hour rows, which reach back fifteen days — too low from the 16th on.
    monthByProvider: monthModels.reduce((all, row) => {
      const at = (all[providerOf(row.model)] ||= { calls: 0, cost: 0 });
      at.calls += Number(row.calls) || 0;
      at.cost = Math.round((at.cost + (withMarkup(Number(row.cost) || 0) || 0)) * 1e6) / 1e6;
      return all;
    }, /** @type {Record<string, { calls: number, cost: number }>} */ ({})),
    // The deployment's own monthly ceiling, which applies only on its shared keys.
    sharedLimit: limitFor(user),
    live: { openrouter: live, orcarouter: orcaLive },
    free: orcaFree ? { orcarouter: orcaFree } : {},
    inUse: { openrouter: own.length ? await openRouterKeyInUse(user.id, live) : null },
    // Each provider this account rides the deployment's key for — where the
    // monthly ceiling applies (checkQuota counts every call of the month, and
    // stops a turn only on a shared key).
    sharedKey: Object.fromEntries(Object.entries(status).map(([provider, s]) => [provider, !!s.shared])),
  };
}
