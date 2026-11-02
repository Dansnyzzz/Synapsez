import { redactSecrets } from '../redact.js';
import { log } from './trace.js';

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
  const text = String(err?.message || err || 'That did not work.');
  const fromTheDatabase =
    typeof err?.severity === 'string' ||
    /^[0-9A-Z]{5}$/.test(String(err?.code || '')) ||
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)\b|connection (terminated|refused)|Connection terminated|timeout exceeded when trying to connect|relation "[^"]+" does not exist/i.test(text);
  if (fromTheDatabase) {
    log.error('request failed', err);
    return 'Something went wrong on the server. Try again in a moment.';
  }
  return redactSecrets(text).text;
}
