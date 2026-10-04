import { streamCompletion } from '../providers/index.js';
import { priceTurn } from '../providers/catalog.js';
import { record as recordUsage } from '../usage.js';

/**
 * One model call for a research role, its output collected to a string and its
 * cost charged to the shared budget.
 *
 * The whole pipeline runs on the conversation's own model — the same `entry`
 * passed to every role, differing only in `system` — which is the cheap path
 * the design requires and the only affordable one when the model is a free one.
 * `stream` is injectable so the stages can be tested with scripted output; it
 * defaults to the real provider stream, which already carries key rotation and
 * fallback underneath it.
 *
 * `budget.spent` is the running token total the orchestrator checks against
 * `budget.cap`; `tokensIn`/`tokensOut` accumulate for the audit record.
 */
/**
 * @param role     which part of the pipeline this is — `research.plan`,
 *   `research.debate`, `web_extract`. It reaches the usage ledger, so the page
 *   can say where the tokens went instead of showing a hole.
 * @param effort   `high` suits the roles that reason; the ones that only
 *   reformat somebody else's JSON do not need to think about it, and paying for
 *   deep thinking on those is pure waste. Callers say which they are.
 */
export async function askModel({
  userId,
  entry,
  system,
  prompt,
  stream = streamCompletion,
  budget,
  signal,
  chatId = null,
  role = 'research',
  effort = 'high',
}) {
  const messages = [{ id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', text: prompt }];
  let text = '';
  let spent = null;

  /*
   * Bounded by the run's clock as well as by the caller's stop. The deadline
   * was checked only between calls, so one slow call from a free model started
   * at 140 seconds ran on past the 150-second budget and took the whole turn's
   * 300-second function with it — the run "stopped half way" with nothing to
   * show. Now a call that would outlive the run is cut at the deadline and the
   * debate reports from what it has.
   */
  const left = budget?.deadline ? budget.deadline - Date.now() : null;
  const clock = left != null ? AbortSignal.timeout(Math.max(1_000, left)) : null;
  const bounded = clock && signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, clock]) : clock || signal;

  for await (const ev of stream({ userId, entry, system, messages, effort, signal: bounded })) {
    if (ev.type === 'text') text += ev.delta ?? '';
    else if (ev.type === 'done' && ev.usage) {
      spent = ev.usage;
      if (budget) {
        const inTok = ev.usage.input || 0;
        const outTok = ev.usage.output || 0;
        budget.spent += inTok + outTok;
        budget.tokensIn = (budget.tokensIn || 0) + inTok;
        budget.tokensOut = (budget.tokensOut || 0) + outTok;
      }
    }
  }

  /**
   * Book it against the account.
   *
   * The run budget above is a *safety stop* for one research run — it stops a
   * debate that will not settle from spending a fortune — and it was being
   * mistaken for accounting. It is not: it lives for the length of one call and
   * is written nowhere the quota can see it. A run capped at 250,000 tokens
   * booked zero against a shared key's monthly limit, and `web_extract` passed
   * no budget at all, so its reading was counted in neither place.
   */
  if (spent && userId) {
    await recordUsage(userId, {
      chatId,
      model: entry?.id,
      usage: spent,
      costUsd: priceTurn(entry, spent)?.usd || 0,
      role,
    }).catch(() => {});
  }

  return text.trim();
}

/**
 * Pull the first JSON object out of a model reply, however it wrapped it.
 *
 * Models fence JSON, prefix it with "Sure!", or add a trailing sentence, none of
 * which `JSON.parse` tolerates. This finds the first balanced `{…}` and parses
 * that, returning null rather than throwing so a caller can retry or fall back.
 */
export function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
