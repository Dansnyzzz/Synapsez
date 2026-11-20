import { log } from '../util/trace.js';
import { redactSecrets } from '../redact.js';

// A service behind a tool failing, said to the model in words it can act on (owner, 2026-11-19).
//
// The model passes on what it reads. Handed "Firecrawl answered HTTP 402: insufficient credits",
// it told the person which service Ephapse uses and how it is billed. So the service's own words
// (its name, its status, its body) go to the server log and nowhere else, and the model gets a
// sentence that says what happened in general terms and what to do next — including when the
// thing to do is not to try again (fix round 1: a refused argument, a spent day, a person's key).
//
// `what` is what could not be done, as a verb phrase: "make the picture", "search research papers
// and law". It names the ability, never the service. `instead` is another way to get it done, as
// an instruction: "use web_fetch on the pages instead". `args` names the arguments to check when
// the request itself was refused. `ownKey`, for a call on the person's own key, names where that
// key lives (Settings → Providers → …): they added it, so they can fix it.

/** Whether an error came from a service behind a tool, rather than being one of this app's own sentences. */
export function fromAService(err) {
  if (!err || typeof err !== 'object') return false;
  return (
    Number.isInteger(err.status) ||
    Number.isInteger(err.statusCode) ||
    Number.isInteger(err.code) ||
    Number.isInteger(err.response?.status) ||
    /^(?:ApiError|FirecrawlError|FetchError|TimeoutError|AbortError)$/.test(String(err.name || ''))
  );
}

const statusOf = (err) => Number(err?.status || err?.statusCode || err?.response?.status || (Number.isInteger(err?.code) ? err.code : 0)) || 0;

/** What kind of failure it was, read from its status and words. A spent day is checked before busy: both are 429s. */
function kindOf(err) {
  const status = statusOf(err);
  const said = String(err?.message || err || '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(said)) return 'slow';
  if (status === 402 || /per.?day|daily|limit:? ?0\b|credits?|payment|billing|insufficient/i.test(said)) return 'spent';
  if (status === 429 || /rate.?limit|too many requests|resource.?exhausted/i.test(said)) return 'busy';
  if (status === 401 || status === 403 || /api.?key|key not valid|permission|disabled|not been used|unauthori[sz]ed/i.test(said)) return 'key';
  if (status >= 400 && status < 500) return 'refused';
  return 'down';
}

/**
 * The model's sentence for a service's failure, as an Error to throw; the original goes to the log.
 *
 * @param {any} err
 * @param {{ what: string, instead?: string, args?: string, ownKey?: string, tool?: string }} said
 */
export function plainFailure(err, { what, instead = '', args = 'what was asked for', ownKey = '', tool = 'tool' }) {
  log.warn(`${tool}: a service behind it failed`, {
    status: statusOf(err) || null,
    error: redactSecrets(String(err?.message || err || '')).text.slice(0, 300),
  });
  const or = instead ? `, or ${instead}` : '';
  const kind = kindOf(err);
  if (kind === 'slow') return new Error(`Could not ${what}: it did not answer in time. Try once more${or}.`);
  if (kind === 'busy') return new Error(`Could not ${what} right now: too many requests at once. Try again in a minute${or}.`);
  if (kind === 'spent') return new Error(`Could not ${what}: the allowance for this period is used, so do not try again now${or}. Tell the user it can be done later.`);
  if (kind === 'key' && ownKey) return new Error(`Could not ${what}: the key in ${ownKey} was refused. Ask the user to check it there.`);
  if (kind === 'refused') return new Error(`Could not ${what}: the request was refused as asked. Check ${args} before trying again${or}.`);
  return new Error(`Could not ${what} just now. Try again in a moment${or}; if it fails again, tell the user it is unavailable right now.`);
}

/**
 * A model called inside a tool failing — extract's reader, a sub-agent, deep research's debate, a
 * picture's reader — said in one plain sentence with what the person can do. The provider's own
 * sentence names the deployment's key, its monthly limit or the router it went through; it goes
 * to the log. What a person's own failed turn shows them is not this: that is readableFailure.
 *
 * @param {any} err @returns {Error}
 */
export function modelFailure(err) {
  const said = String(err?.message || err || '');
  log.warn('a model called inside a tool failed', { error: redactSecrets(said).text.slice(0, 300) });
  if (/monthly limit|over this account/i.test(said)) {
    return new Error('The free allowance for this month is used. The user can add their own key in Settings → Providers.');
  }
  if (/free models only/i.test(said)) return new Error("This model needs the user's own key: Settings → Providers.");
  if (/^No API key for /i.test(said)) return new Error('This model needs an API key the account does not have. The user can add one in Settings → Providers.');
  if (/data from your Google account/i.test(said)) {
    return new Error("This conversation holds data from the user's Google account, which this model may not be sent. Tell the user to pick another model.");
  }
  if (err?.code === 'rate_limited' || statusOf(err) === 429 || /rate.?limit|too many requests/i.test(said)) {
    return new Error('The model is busy right now. Try again in a few minutes.');
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(said)) {
    return new Error('The model did not answer in time. Try once more, or with a smaller request.');
  }
  if (/refused|invalid|unauthori[sz]ed|forbidden/i.test(said) || [401, 403].includes(statusOf(err))) {
    return new Error("The model's key was refused. The user can check their keys in Settings → Providers.");
  }
  return new Error('The model did not answer just now. Try again in a moment.');
}
