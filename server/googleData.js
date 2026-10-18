import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What is read from a person's Google account goes only to models that will not
 * keep it to train on.
 *
 * Google's API Services User Data Policy — the "Limited Use" requirements a
 * Gmail or Drive grant comes with — lets this app hand that data to another
 * service only to do what the person asked, and never so that it trains a
 * general model. The privacy notice (public/privacy.html) promises exactly
 * that, and this file is what keeps the promise:
 *
 *   - A conversation *carries Google data* once it holds a result from one of
 *     the Google tools, or a file picked from Drive in the + menu. It stays so:
 *     a fold (compact.js) puts what was read into its summary.
 *   - Such a conversation is sent only to providers whose API terms keep it out
 *     of training — Anthropic, OpenAI, and OpenRouter asked per request for
 *     zero-retention endpoints only (`privacy: 'strict'`, which never loosens
 *     what the account set). A Gemini key on the free tier may be used and read
 *     by Google, and OrcaRouter has no per-request switch, so both are refused.
 *
 * Enforced in `streamCompletion`, the one door to every provider, so a turn, a
 * fold, a sub-agent, a picture read for a blind model and a research role all
 * meet the same rule. The turn passes `googleData` itself; work its tools start
 * (a sub-agent, deep research, `web_extract`) inherits it through the scope.
 */

/** The tools that return what is in somebody's Google account — every `needs: 'google_*'` in definitions.js. */
export const GOOGLE_DATA_TOOLS = new Set([
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_sheets',
  'google_forms',
  'google_tasks',
  'google_contacts',
]);

/** `attachments.origin` of a file attached from the person's Drive. */
export const DRIVE_ORIGIN = 'google_drive';

/** Providers whose API terms do not train on what they are sent. OpenRouter only as strict. */
const MAY_RECEIVE = new Set(['anthropic', 'openai', 'openrouter']);

export const mayReceiveGoogleData = (provider) => MAY_RECEIVE.has(String(provider || ''));

/**
 * Whether these messages hold anything read from Google.
 *
 * A result, not a call: a call that was refused, or failed, brought nothing
 * back. A write that worked counts too — it is cheaper to be strict about a
 * "Sent." than to sort which results quote the person's data and which do not.
 */
export function carriesGoogleData(messages) {
  for (const m of messages || []) {
    if (m?.results?.some((r) => GOOGLE_DATA_TOOLS.has(r?.name) && !r.isError)) return true;
    if (m?.attachments?.some((a) => a?.origin === DRIVE_ORIGIN)) return true;
  }
  return false;
}

const scope = new AsyncLocalStorage();

/** Run `fn` with Google data in scope, when `on`; once on, nothing inside turns it off. */
export const withGoogleData = (on, fn) => (on ? scope.run(true, fn) : fn());

/** Whether the work running now started from a conversation that carries Google data. */
export const googleDataInScope = () => scope.getStore() === true;
