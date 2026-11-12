import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
// `redact.js` imports nothing, so this cannot become one of the cycles in
// ARCH-008. Checked rather than assumed, because this file is imported by
// almost everything.
import { redactSecrets } from '../redact.js';

/**
 * One id that follows a request all the way through.
 *
 * An agent turn here is not one thing that happens. It is an SSE connection, a
 * loop that runs up to `maxSteps` times, a provider call per step that may
 * silently move to a second key, a fan of tool calls, some of which cross to a
 * different process on the user's own machine and come back through a database
 * queue. When somebody reports "it hung for two minutes and then said something
 * odd", the evidence for that is spread across all of those and there was
 * nothing to join it on: twenty-four unstructured `console.log`s and no shared
 * identifier anywhere in the server, the worker, or the browser.
 *
 * `AsyncLocalStorage` is what makes this cost nothing at the call sites. The id
 * is put in scope once, in one middleware, and every function underneath it —
 * however deep, across every `await` — can read it without being passed it. No
 * signature in the agent loop changes, which matters: threading a parameter
 * through forty functions is how this kind of thing gets started and then
 * abandoned half done.
 *
 * The browser sends `x-request-id` when it has one and reads it back off the
 * response, so a report from a user can carry the id of the exact turn.
 */
const store = new AsyncLocalStorage();

/** A short id — long enough not to collide in a day's logs, short enough to read aloud. */
export const newTraceId = () => crypto.randomBytes(6).toString('hex');

/**
 * Run `fn` with these fields in scope. Nested calls inherit and may add: a
 * sub-agent adds its own `subagent` field without losing the request it belongs
 * to.
 */
export function withTrace(fields, fn) {
  const parent = store.getStore() || {};
  return store.run({ ...parent, ...fields }, fn);
}

/** Whatever is in scope, or an empty object outside a request. */
export const currentTrace = () => store.getStore() || {};

/** Add fields to the current scope, if there is one. Safe to call anywhere. */
export function annotate(fields) {
  const current = store.getStore();
  if (current) Object.assign(current, fields);
}

/**
 * Structured where something reads it, readable where a person does.
 *
 * `LOG_FORMAT=json` (the default on a deployment, where the platform collects
 * lines and wants to index them) emits one JSON object per line. Anywhere else
 * it prints something a human can scan, because the main consumer of a local
 * run is somebody watching a terminal, and JSON is worse than useless there.
 */
const asJson = process.env.LOG_FORMAT
  ? process.env.LOG_FORMAT === 'json'
  : !!process.env.VERCEL;

const LEVEL_COLOUR = { debug: '\x1b[2m', info: '', warn: '\x1b[33m', error: '\x1b[31m' };

/**
 * Redact every string that goes into a line, at every level.
 *
 * `log.error` was given this first, because that is where a provider quoting a
 * malformed key back was observed. But the fields of an `info` or a `warn` are
 * the same channel — a store failure's message carries a connection string, a
 * connector's error carries a token — and nothing stopped one going out raw.
 * Doing it here rather than per level means a new call site inherits it instead
 * of having to remember, which is the shape of every other leak found in this
 * codebase.
 *
 * Strings only. Numbers and booleans cannot carry a key, and walking nested
 * objects on every log line would cost more than it protects.
 */
function cleanFields(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  let touched = false;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      const clean = redactSecrets(value).text;
      if (clean !== value) touched = true;
      out[key] = clean;
    } else {
      out[key] = value;
    }
  }
  return touched ? out : fields;
}

function emit(level, message, fields = {}) {
  const trace = currentTrace();
  // Cleaned once, up here, because there are two output formats below and
  // cleaning inside one of them is how half a fix ships.
  const safe = cleanFields(fields);
  // State a turn keeps in its scope for its own use (agent.js `turnSpend`) is not a log field.
  const { turnSpend: _turnSpend, ...traced } = trace;
  const record = { level, msg: message, ...traced, ...safe };

  if (asJson) {
    // `time` last in the object but first in the reader's mind; platforms sort
    // on their own ingest timestamp anyway, so this is for reading a raw dump.
    console[level === 'debug' ? 'log' : level](JSON.stringify({ time: new Date().toISOString(), ...record }));
    return;
  }

  const parts = Object.entries({ ...traced, ...safe })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const colour = LEVEL_COLOUR[level] ?? '';
  const reset = colour ? '\x1b[0m' : '';
  console[level === 'debug' ? 'log' : level](
    `${colour}[${level}]${reset} ${message}${parts.length ? `  \x1b[2m${parts.join(' ')}\x1b[0m` : ''}`,
  );
}

export const log = {
  debug: (message, fields) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', message, fields);
  },
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  /**
   * An error, with the error itself unpacked rather than stringified into the
   * message — so the name, the status and the first line of the stack are all
   * separately searchable instead of buried in prose.
   */
  error: (message, error, fields = {}) => {
    // `status` is not on `Error`, but every SDK in this app hangs one there and
    // it is the most useful field in the record. Read it off the value rather
    // than off the type, which is also what makes this honest: the property may
    // genuinely be absent.
    const extra = /** @type {{ status?: unknown, statusCode?: unknown }} */ (error || {});
    /**
     * Redacted, for the same reason `readableFailure` redacts.
     *
     * The response path was given this treatment and the log path was not. The
     * premise is observed rather than theoretical — `tools/execute.js` records
     * that a provider client handed a malformed key quotes the value back in its
     * error message, which is why the browser-facing path was fixed. The same
     * string went into `log.error` untouched from ten call sites, several of
     * which unpack a provider or SDK error directly.
     *
     * `LOG_FORMAT=json` is the default on a deployment, so that line lands in
     * the platform's log, under the platform's retention, readable by everyone
     * with log access — including operators who have no business holding that
     * tenant's key. CLAUDE.md §6 says not to log sensitive data; this is the
     * one place that could, and did.
     */
    const clean = (text) => redactSecrets(String(text)).text;
    const detail =
      error instanceof Error
        ? { err: error.name, errMsg: clean(error.message), status: extra.status ?? extra.statusCode }
        : error != null
          ? { errMsg: clean(error) }
          : {};
    emit('error', message, { ...detail, ...fields });
  },
};

/** How long something took, in whole milliseconds — for a `ms` field. */
export const since = (start) => Math.round(Number(process.hrtime.bigint() - start) / 1e6);
export const mark = () => process.hrtime.bigint();

export const __testing = { emit, asJson };
