import { log } from '../util/trace.js';
import { redactSecrets } from '../redact.js';

// A service behind a tool failing, said to the model in words it can act on (owner, 2026-11-19).
//
// The model passes on what it reads. Handed "Firecrawl answered HTTP 402: insufficient credits",
// it told the person which service Ephapse uses and how it is billed. So the service's own words
// (its name, its status, its body) go to the server log and nowhere else, and the model gets a
// sentence that says what happened in general terms and what to do next.
//
// `what` names the ability, not the service: "Searching research papers", "Making the picture".
// `instead` is the other way to get it done, said as an instruction: "use web_fetch on the pages".

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

/** What kind of failure it was, read from its status and words. */
function kindOf(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || (Number.isInteger(err?.code) ? err.code : 0)) || 0;
  const said = String(err?.message || err || '');
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|aborted/i.test(said)) return 'slow';
  if (status === 429 || /rate.?limit|too many requests|resource.?exhausted/i.test(said)) return 'busy';
  if (status === 402 || /credits?|quota|payment|billing|insufficient/i.test(said)) return 'spent';
  return 'down';
}

/**
 * The model's sentence for a service's failure, as an Error to throw; the original goes to the log.
 *
 * @param {any} err @param {{ what: string, instead?: string, tool?: string }} said
 */
export function plainFailure(err, { what, instead = '', tool = 'tool' }) {
  log.warn(`${tool}: a service behind it failed`, {
    status: err?.status || err?.statusCode || err?.response?.status || null,
    error: redactSecrets(String(err?.message || err || '')).text.slice(0, 300),
  });
  const or = instead ? `, or ${instead}` : '';
  const kind = kindOf(err);
  if (kind === 'slow') return new Error(`${what} did not answer in time. Try once more${or}.`);
  if (kind === 'busy') return new Error(`${what} is busy right now. Try again in a minute${or}.`);
  if (kind === 'spent') return new Error(`${what} has used its allowance for this period. Try again later${or}.`);
  return new Error(`${what} did not work just now. Try again in a moment${or}; if it fails again, tell the user it is unavailable right now.`);
}
