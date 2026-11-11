/**
 * Strip credentials out of text before it is stored.
 *
 * Memory is written by a model, from a conversation that may well have had an
 * API key or a password in it. A note is durable and reaches into every future
 * conversation, so a secret that lands there is a secret that keeps escaping.
 *
 * This is a filter, not a guarantee. It catches the shapes credentials usually
 * come in — long random-looking tokens, `KEY=value` assignments, the well-known
 * provider prefixes — and it will miss ones that look like ordinary words.
 * Treat it as a safety net under a rule you still have to follow, which is not
 * to paste secrets into a chat in the first place.
 */

const REDACTED = '[redacted]';

/**
 * Vendor-specific prefixes. These are worth matching exactly because they are
 * unambiguous: nothing else looks like `sk-ant-` followed by forty characters.
 */
const KNOWN_KEYS = [
  /**
   * Every `sk-` key, whatever vendor segments the provider puts in front of the
   * random part — `sk-ant-api03-…`, `sk-or-v1-…`, `sk-orca-…`, `sk-proj-…`, and
   * OpenAI's bare `sk-…`.
   *
   * This replaces four hand-written prefixes, and the reason is a hole they
   * left. OrcaRouter was added as a provider without being added here, so its
   * keys were redacted by nothing: the old catch-all `sk-[A-Za-z0-9]{32,}`
   * cannot cross the hyphen in `sk-orca-`, and stops after four characters.
   * A key that leaks is not a place to keep a list somebody has to remember to
   * update — see the suite, which now asserts this against every provider in
   * the catalogue rather than against a sample somebody typed.
   *
   * What keeps it off ordinary prose is that the tail must be **unbroken**: a
   * key ends in a long run with no hyphens in it, while English written with
   * hyphens does not. `sk-onboarding-checklist-for-new-people` never assembles
   * 24 characters without hitting a hyphen, so it survives untouched.
   *
   * The cost of that choice is honest and small: a 24-character unhyphenated
   * word after `sk-` would be redacted. Erring that way is the right direction
   * here, and the suite pins the prose that must not be touched.
   */
  /\bsk-(?:[A-Za-z0-9]{1,12}-){0,3}[A-Za-z0-9_]{24,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g, // Google
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bntn_[A-Za-z0-9]{30,}/g, // Notion
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * `SOMETHING_SECRET = value` in any of the shapes people write it — env files,
 * JSON, YAML, a shell export. The name is what marks it, so the value can be
 * anything at all.
 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|APIKEY|ACCESS_KEY|PRIVATE)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi;

/** A password in a URL: https://user:hunter2@example.com */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+):([^\s/@]+)@/gi;

/** `Authorization: Bearer …` in a pasted request. */
const BEARER = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi;

/**
 * Remove anything that looks like a credential.
 *
 * @returns {{ text: string, found: string[] }} the cleaned text, and the kinds
 *   of thing removed — so the caller can say what happened rather than silently
 *   editing what someone asked to save.
 */
export function redactSecrets(input) {
  // An invisible character inside a token hides it from every pattern below (2026-11-11,
  // `sk-abc\u200Bdefg…`): dropped where it sits between two of a token's characters. An
  // emoji's joiner sits between emoji, and stays.
  let text = String(input ?? '').replace(/(?<=[A-Za-z0-9_-])(?:[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]|\u034F)+(?=[A-Za-z0-9_-])/g, '');
  const found = [];
  const note = (what) => {
    if (!found.includes(what)) found.push(what);
  };

  for (const pattern of KNOWN_KEYS) {
    text = text.replace(pattern, () => {
      note('an API key');
      return REDACTED;
    });
  }

  text = text.replace(SECRET_ASSIGNMENT, (whole, name) => {
    note(`the value of ${name}`);
    return `${name}=${REDACTED}`;
  });

  text = text.replace(URL_CREDENTIALS, (whole, prefix) => {
    note('a password in a URL');
    return `${prefix}:${REDACTED}@`;
  });

  text = text.replace(BEARER, (whole, prefix) => {
    note('an authorization header');
    return `${prefix}${REDACTED}`;
  });

  return { text, found };
}

/** True when the text still contains something that looks like a credential. */
export const looksSecret = (input) => redactSecrets(input).found.length > 0;
