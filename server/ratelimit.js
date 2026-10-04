import { getStore } from './store/index.js';
// Every level redacts its fields before emitting, which matters here: a store
// failure's message can carry a connection string.
import { log } from './util/trace.js';

/**
 * Throttling for the handful of endpoints somebody would sit and guess at.
 *
 * There was none, which mattered more here than it usually does. Verifying a
 * password costs ~100ms of CPU and ~32MB of memory by design — scrypt is
 * memory-hard on purpose — so an unauthenticated flood of login attempts is not
 * only a way to guess passwords, it is a way to take the server down with a
 * hundred requests. The limit is doing two jobs.
 *
 * Counters live in the database rather than in a Map, because on a serverless
 * deployment consecutive attempts land on different instances and an in-process
 * counter would helpfully reset itself between each guess.
 */

/** Per-action budgets. Tight enough to matter, loose enough to survive a bad day. */
export const LIMITS = {
  login: { limit: 10, windowMs: 15 * 60_000 },
  register: { limit: 5, windowMs: 60 * 60_000 },
  forgot: { limit: 5, windowMs: 60 * 60_000 },
  reset: { limit: 10, windowMs: 60 * 60_000 },
  totp: { limit: 10, windowMs: 15 * 60_000 },
  connect: { limit: 20, windowMs: 60 * 60_000 },
  // Pairing is unauthenticated on the worker's side, so it needs a ceiling of
  // its own: enough for a computer to poll every two seconds for ten minutes,
  // and nowhere near enough to guess an eight-character code.
  pair: { limit: 400, windowMs: 15 * 60_000 },
  // An export reads the whole account; a dozen an hour is generous for a person
  // and a ceiling for a stolen session trying to drain one.
  export: { limit: 12, windowMs: 60 * 60_000 },
  // An import arrives in batches of up to fifty conversations, so a large
  // Claude or ChatGPT archive is a few hundred requests — not unlimited.
  import: { limit: 400, windowMs: 60 * 60_000 },
  // Deleting the account checks a password: the same guessing ceiling as signing in.
  'delete-account': { limit: 10, windowMs: 15 * 60_000 },
};

/**
 * Who is asking.
 *
 * Platform headers first. `x-vercel-forwarded-for` and `x-real-ip` are written
 * by the edge itself and overwrite whatever the caller sent, so they cannot be
 * forged; `X-Forwarded-For` can be, and its leftmost entry is simply a string
 * the client chose. With `trust proxy` set to one hop `req.ip` is already the
 * right value, but preferring the headers the platform controls means this
 * holds even if that setting is later loosened.
 *
 * It is still only an approximation of a person — the point is to make grinding
 * expensive, not to identify anyone.
 */
function clientKey(req) {
  const platform = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'];
  if (typeof platform === 'string' && platform.trim()) return platform.trim().split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Count an attempt. Returns null when it is fine to proceed, or a `{status,
 * body}` to send back.
 *
 * @param extra  a second dimension — usually the email being tried — so one
 *               person hammering one account cannot lock out a whole office
 *               behind the same NAT, and vice versa.
 */
export async function consume(req, action, extra = '') {
  const rule = LIMITS[action];
  if (!rule) return null;

  const store = getStore();
  if (typeof store.hitRateLimit !== 'function') return null;

  const buckets = [`${action}:ip:${clientKey(req)}`];
  if (extra) buckets.push(`${action}:id:${String(extra).toLowerCase().slice(0, 120)}`);

  for (const bucket of buckets) {
    /**
     * A failure to count must never be a failure to serve: an unreachable
     * counter table should slow nobody down. That part is deliberate and stays.
     *
     * What did not stay is the silence. This `catch` returned `null` and said
     * nothing, so a database blip removed the only brute-force protection on
     * every unauthenticated route — sign-in, registration, password reset — and
     * left no trace that it had. The window could be minutes or hours, and
     * afterwards there was no way to tell it had happened at all, which is the
     * difference between a deliberate trade-off and an invisible one.
     */
    const outcome = await store.hitRateLimit(bucket, rule.limit, rule.windowMs).catch((err) => {
      log.warn('rate limit not counted — failing open', {
        action,
        err: err?.name,
        errMsg: err?.message,
      });
      return null;
    });
    if (outcome && !outcome.allowed) {
      const minutes = Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000));
      return {
        status: 429,
        retryAfterSec: Math.ceil(outcome.retryAfterMs / 1000),
        body: {
          error: `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          code: 'rate_limited',
        },
      };
    }
  }
  return null;
}

/** Forget the tally for this attempt — called on success. */
export async function forgive(req, action, extra = '') {
  const store = getStore();
  if (typeof store.clearRateLimit !== 'function') return;
  const buckets = [`${action}:ip:${clientKey(req)}`];
  if (extra) buckets.push(`${action}:id:${String(extra).toLowerCase().slice(0, 120)}`);
  await Promise.all(buckets.map((b) => store.clearRateLimit(b).catch(() => {})));
}

/**
 * Express middleware form.
 *
 * `identify` pulls the second dimension out of the request — the email, usually.
 * It runs before the handler, so the body is already parsed.
 */
/**
 * @param {string} action
 * @param {(req: any) => string} [identify]  the second dimension, read off the
 *   request — the email being tried, or the account id.
 */
export function limit(action, identify = (/** @type {any} */ _req) => '') {
  return async (req, res, next) => {
    try {
      const blocked = await consume(req, action, identify(req));
      if (!blocked) return next();
      res.set('Retry-After', String(blocked.retryAfterSec));
      res.status(blocked.status).json(blocked.body);
    } catch (err) {
      next(err);
    }
  };
}
