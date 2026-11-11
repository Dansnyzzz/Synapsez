import { getStore } from './store/index.js';
import { knownDevice } from './auth.js';
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
  /*
   * Ten wrong passwords for one account from one address, and a hundred for the account
   * from everywhere. Keyed by the account alone at ten, anyone who knew somebody's email
   * could lock them out from anywhere (owner, 2026-11-08); a spread-out guess still stops.
   */
  login: { limit: 10, windowMs: 15 * 60_000, accountLimit: 100, knownDevices: true },
  register: { limit: 5, windowMs: 60 * 60_000 },
  /*
   * A sign-up's confirmation code (owner, 2026-11-09): ten tries for one account from
   * one address, thirty for the account from everywhere, in fifteen minutes. A code is
   * six digits and lives half an hour, so a script gets about sixty of a million.
   * Sending one again: five an hour per address and account, twenty for the account.
   */
  confirm: { limit: 10, windowMs: 15 * 60_000, accountLimit: 30 },
  'confirm-send': { limit: 5, windowMs: 60 * 60_000, accountLimit: 20 },
  /*
   * Five reset emails an hour for one account from one address, and twenty for the account
   * from everywhere; keyed by the account alone at five, anybody who knew a person's email
   * could keep them from resetting their password (security review, 2026-11-09). Twenty
   * still keeps their mailbox from being flooded. A reset is the same: what is guessed is a
   * long random token, so the ceiling is for a script, not for the owner's own link.
   */
  forgot: { limit: 5, windowMs: 60 * 60_000, accountLimit: 20, knownDevices: true },
  reset: { limit: 10, windowMs: 60 * 60_000, accountLimit: 50 },
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
  // Each of these wakes a machine on the deployment's one key. A person sends a few files an hour.
  'machine-file': { limit: 120, windowMs: 60 * 60_000 },
  // Deleting the account checks a password: the same guessing ceiling as signing in.
  'delete-account': { limit: 10, windowMs: 15 * 60_000 },
  // The + menu's Drive picker: a search per pause in typing, and each pick a
  // download through this server. Plenty for a person; a ceiling for a script.
  drive: { limit: 300, windowMs: 15 * 60_000 },
  // Uploading skills: a scan on choosing the files and one more to keep them —
  // a few dozen an hour is a busy afternoon; each reads up to ten 2 MB files.
  skillUpload: { limit: 60, windowMs: 60 * 60_000 },
  // Choosing a new username: each refusal says a name is taken, so a script could list them (SEC-059).
  rename: { limit: 10, windowMs: 60 * 60_000 },
  /** A question asked aside on the Bot page: one model call each (spec B.6). */
  aside: { limit: 60, windowMs: 60 * 60_000 },
  /** A team file read or added on the Bot page (spec B.5): a look first, then the import. */
  'team-file': { limit: 40, windowMs: 60 * 60_000 },
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
  if (typeof platform === 'string' && platform.trim()) return addressGroup(platform.trim().split(',')[0].trim());
  return addressGroup(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * An address as one caller. An IPv4 address is itself, and so is one written as IPv6
 * (`::ffff:1.2.3.4`). An IPv6 address is its /64: a single home or server is given a
 * whole /64, so counted address by address one machine had more addresses than any
 * ceiling (security review, 2026-11-09).
 *
 * @param {string} raw
 */
export function addressGroup(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) || /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':') || !/^[0-9a-f:.]+$/.test(ip)) return ip || 'unknown';
  // An IPv4 tail is the last two groups, which a /64 never reaches.
  const head = ip.replace(/:\d{1,3}(?:\.\d{1,3}){3}$/, ':0:0');
  const [left, right = ''] = head.split('::');
  const a = left ? left.split(':') : [];
  const b = head.includes('::') && right ? right.split(':') : [];
  const groups = head.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  if (groups.length !== 8) return ip;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
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

  const buckets = bucketsFor(req, action, extra);

  for (const { bucket, limit: ceiling } of buckets) {
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
    const outcome = await store.hitRateLimit(bucket, ceiling, rule.windowMs).catch((err) => {
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

/**
 * Forget the tally for this attempt — called on success.
 *
 * An account-wide ceiling is not cleared: it holds what strangers tried from elsewhere,
 * and the owner signing in must not hand them a fresh hundred. This attempt alone is
 * taken back, so it counts wrong passwords only. Every attempt is still counted first,
 * in one upsert, so guesses sent at once cannot slip past a check made before counting.
 */
export async function forgive(req, action, extra = '') {
  const store = getStore();
  if (typeof store.clearRateLimit !== 'function') return;
  const rule = LIMITS[action];
  await Promise.all(
    bucketsFor(req, action, extra).map(({ bucket, accountWide }) => {
      if (!accountWide) return store.clearRateLimit(bucket).catch(() => {});
      if (typeof store.addToCounter !== 'function') return null;
      return store.addToCounter(bucket, -1, Date.now() + (rule?.windowMs || 0)).catch(() => {});
    }),
  );
}

/**
 * The caller's address, and the second dimension in one spelling (SEC-058):
 * trimmed and lower-cased, so " Dana@x " and "dana@x" are the same ceiling.
 * With an `accountLimit`, the second dimension is that address's alone, and the
 * looser ceiling is the account's from everywhere.
 *
 * @returns {{ bucket: string, limit: number, accountWide?: boolean }[]}
 */
function bucketsFor(req, action, extra) {
  const rule = LIMITS[action] || { limit: 0 };
  const address = clientKey(req);
  const buckets = [{ bucket: `${action}:ip:${address}`, limit: rule.limit }];
  const second = String(extra ?? '').trim().toLowerCase().slice(0, 120);
  if (!second) return buckets;
  if (rule.accountLimit) {
    buckets.push({ bucket: `${action}:pair:${second}|${address}`, limit: rule.limit });
    // A browser that has signed in to this account before is not stopped by what strangers
    // did elsewhere: the owner cannot be locked out from their own (auth.js `knownDevice`).
    if (!(rule.knownDevices && knownDevice(req, second))) {
      buckets.push({ bucket: `${action}:id:${second}`, limit: rule.accountLimit, accountWide: true });
    }
  } else {
    buckets.push({ bucket: `${action}:id:${second}`, limit: rule.limit });
  }
  return buckets;
}

/**
 * Express middleware form.
 *
 * `identify` pulls the second dimension out of the request — the email, usually.
 * It runs before the handler, so the body is already parsed.
 */
/**
 * @param {string} action
 * @param {(req: any) => string | Promise<string>} [identify]  the second dimension,
 *   read off the request — the email being tried, or the account id.
 */
export function limit(action, identify = (/** @type {any} */ _req) => '') {
  return async (req, res, next) => {
    try {
      const blocked = await consume(req, action, await identify(req));
      if (!blocked) return next();
      res.set('Retry-After', String(blocked.retryAfterSec));
      res.status(blocked.status).json(blocked.body);
    } catch (err) {
      next(err);
    }
  };
}
