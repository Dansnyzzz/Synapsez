import { getStore } from './store/index.js';
import { log } from './util/trace.js';
import { setKeyMeta } from './settings.js';

/**
 * What a provider answered when it did not answer (owner, 2026-11-06).
 *
 * `usage_events` books what was spent, so a failed call left no trace, and the only
 * place to see why a turn was failing was the provider's own console. Each failure
 * is counted here by provider, model, hour and status, for the Usage page. The
 * status and nothing else: never a message, which can quote the prompt.
 */

/**
 * Note one failed call. Never in the way of the turn: nothing waits on it, and a
 * failure to write it is only logged.
 *
 * @param {string | null | undefined} userId
 * @param {{ provider?: string, id?: string } | null | undefined} entry
 * @param {any} failure
 */
export function noteOutcome(userId, entry, failure) {
  if (!userId || !entry?.provider || !entry.id) return;
  const status = Number(failure?.status) || 0;
  getStore()
    .recordOutcome(userId, { provider: entry.provider, model: entry.id, status })
    .catch((err) => log.error('provider outcome not recorded', err, { provider: entry.provider }));
}

/**
 * Google's answer to a request over a quota says which quota, in a form its docs do
 * not promise and no endpoint repeats: `QuotaFailure.violations[].quotaId` and
 * `quotaValue`, inside the error's text. It is the one way to learn this project's
 * daily ceiling without being signed in to AI Studio, so it is read where it appears
 * and otherwise nothing is assumed.
 *
 * @param {any} failure
 * @returns {{ perDay: number | null, freeTier: boolean } | null}
 */
export function readGeminiQuota(failure) {
  if (Number(failure?.status) !== 429) return null;
  const text = `${failure?.message || ''} ${JSON.stringify(failure?.error ?? failure?.details ?? '')}`.replace(/\\"/g, '"');
  let perDay = null;
  let freeTier = false;
  for (const match of text.matchAll(/"quotaId"\s*:\s*"([^"]+)"[^{}]*?(?:\{[^{}]*\}[^{}]*?)?"quotaValue"\s*:\s*"(\d+)"/g)) {
    if (/FreeTier/i.test(match[1])) freeTier = true;
    if (/PerDay/i.test(match[1])) perDay = Number(match[2]);
  }
  return perDay === null && !freeTier ? null : { perDay, freeTier };
}

/**
 * Keep what a refusal said about a Gemini key's daily ceiling, beside the key. The
 * deployment's own key is not this account's to learn about.
 *
 * @param {string} userId @param {string} key @param {any} failure
 */
export async function learnGeminiQuota(userId, key, failure) {
  const quota = readGeminiQuota(failure);
  if (!quota?.perDay || !quota.freeTier) return;
  await setKeyMeta(userId, 'google', key, { freePerDay: quota.perDay }).catch((err) => log.error('Gemini quota not kept', err));
}

/**
 * The start of the day Google counts requests in, and when the next one starts:
 * midnight Pacific time, by its docs.
 *
 * @param {Date} [now]
 * @returns {{ from: Date, to: Date }}
 */
export function pacificDay(now = new Date()) {
  const read = (date) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(date)
        .map((part) => [part.type, Number(part.value)]),
    );
    return { ...parts, offset: Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(date.getTime() / 1000) * 1000 };
  };
  const here = read(now);
  const from = new Date(Date.UTC(here.year, here.month - 1, here.day) - here.offset);
  // The next day's offset, read a day on: a day the clocks change is 23 or 25 hours long.
  const later = read(new Date(from.getTime() + 26 * 3_600_000));
  return { from, to: new Date(Date.UTC(here.year, here.month - 1, here.day + 1) - later.offset) };
}
