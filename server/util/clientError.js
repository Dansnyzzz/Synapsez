import { redactSecrets } from '../redact.js';
import { log } from './trace.js';

// What the browser is told when the server itself failed. Translated in server/i18n/vi.js.
export const SERVER_TROUBLE = 'Something went wrong on the server. Try again in a moment.';

/**
 * Whether an error is the database's or its driver's own (CODE-065): a
 * Postgres error carries a severity or a five-character SQLSTATE, and a
 * connection failure names the host. Shared with `readableFailure` (CODE-077),
 * which a turn's failure reaches the browser through.
 *
 * @param {any} err
 */
export function fromTheDatabase(err) {
  const text = String(err?.message || err || '');
  return (
    typeof err?.severity === 'string' ||
    /^[0-9A-Z]{5}$/.test(String(err?.code || '')) ||
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b|connection (terminated|refused)|Connection terminated|timeout exceeded when trying to connect|relation "[^"]+" does not exist/i.test(text)
  );
}

/**
 * What a refused request says to the browser (CODE-065).
 *
 * A route's own refusal — "that name is taken", "too long" — is written for the
 * person and is theirs to read. A database or driver failure is not: its text
 * can name the server, the table, the column, or the connection string, and the
 * routes answered with it verbatim. Those are logged and said plainly instead.
 * Either way, nothing shaped like a secret leaves (redactSecrets).
 *
 * @param {any} err
 * @returns {string}
 */
export function clientError(err) {
  if (fromTheDatabase(err)) {
    log.error('request failed', err);
    return SERVER_TROUBLE;
  }
  return redactSecrets(String(err?.message || err || 'That did not work.')).text;
}
