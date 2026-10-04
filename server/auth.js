import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
  sha256,
  randomToken,
  numericCode,
  totpSecret,
  totpUri,
  verifyTotp,
  matchingTotpStep,
  recoveryCodes,
  encryptSecret,
  decryptSecret,
} from './crypto.js';
import { sendEmail, resetEmail, publicUrl } from './email.js';

const COOKIE = 'ai_remote_session';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Everyone signs in with their own email and password, and that is the whole of
 * it: no invite code, no confirmation step, no shared secret to remember. An
 * emailed code appears in exactly one place — resetting a forgotten password.
 *
 * Sessions are stateless HMAC-signed cookies: on Vercel each request may hit a
 * different instance, so there is nowhere to keep session state.
 */
function sessionSecret() {
  const secret = process.env.SESSION_SECRET || process.env.ACCESS_TOKEN;
  if (!secret) throw new Error('Set SESSION_SECRET — refusing to issue sessions without one.');
  return crypto.createHash('sha256').update(`ai-remote:session:${secret}`).digest();
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  let expected;
  try {
    expected = Buffer.from(crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url'));
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Issue a session cookie.
 *
 * `epoch` is the account's `session_epoch` at the moment of signing in. Changing
 * a password bumps that number, and every cookie carrying the old one stops
 * verifying — which is what makes "change your password" do the thing everybody
 * assumes it does. Without it a stolen session outlived the single action taken
 * to stop it, for the full thirty days.
 *
 * `remember` is what the sign-in checkbox controls. Unticked, the cookie gets
 * no Max-Age and so dies with the browser — which is the honest reading of
 * "don't remember me" on a machine that is not yours. The signed expiry stays
 * thirty days either way; the browser is the one being asked to forget.
 */
function issue(req, res, user, remember = true) {
  const cookie = sign({
    uid: user.id,
    epoch: Number(user.session_epoch) || 1,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SEC,
    rem: remember ? 1 : 0,
  });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    [
      `${COOKIE}=${cookie}`,
      'Path=/',
      ...(remember ? [`Max-Age=${MAX_AGE_SEC}`] : []),
      'HttpOnly',
      'SameSite=Lax',
      ...(secure ? ['Secure'] : []),
    ].join('; '),
  );
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/**
 * Re-issue this browser's cookie at the current epoch.
 *
 * Used right after a password change: the whole point is to sign the *other*
 * sessions out, and throwing the person who just did it back to the sign-in
 * screen would be a strange reward for good security hygiene.
 */
export async function refreshSession(req, res, userId) {
  const user = await getStore().getUserById(userId);
  // Carry the old cookie's "remember me" answer over: a password change should
  // not quietly promote a browser-session cookie into a thirty-day one.
  const previous = verify(parseCookies(req.headers.cookie)[COOKIE]);
  if (user) issue(req, res, user, previous?.rem !== 0);
}

/** Length-independent comparison so a wrong guess leaks nothing via timing. */
function secretEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Issue a one-time credential and email it. The message carries both a short
 * code to type and a link to click; either works, and using one burns the other.
 * Only digests are stored, so a database dump cannot be replayed as a login.
 *
 * Password reset is the only thing that uses this now — there is no signup
 * confirmation step to get through.
 */
async function issueLink({ user, req }) {
  const token = randomToken(32);
  const code = numericCode(6);

  await getStore().createAuthToken({
    tokenHash: sha256(token),
    codeHash: sha256(code),
    userId: user.id,
    kind: 'reset',
    expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
  });

  const link = `${publicUrl(req)}/?reset=${encodeURIComponent(token)}`;
  return sendEmail({ to: user.email, ...resetEmail(link, code) });
}

/**
 * Always resolves the same way whether or not the address exists — otherwise
 * this endpoint becomes a way to enumerate who has an account here.
 */
export async function requestPasswordReset(email, req) {
  const user = await getStore().getUserByEmail(String(email || '').trim().toLowerCase());
  if (user) await issueLink({ user, req });
  return { ok: true };
}

export async function resetPassword({ token, code, email, password }) {
  if (String(password || '').length < 10) throw new Error('Use a password of at least 10 characters.');
  const store = getStore();

  let userId = null;
  if (token) {
    userId = await store.consumeAuthToken(sha256(token), 'reset');
  } else if (code && email) {
    const user = await store.getUserByEmail(String(email).trim().toLowerCase());
    if (user) {
      userId = await store.consumeAuthCode(user.id, sha256(String(code).replace(/\D/g, '')), 'reset');
    }
  }
  if (!userId) throw new Error('That reset code or link is invalid, already used, or expired.');

  await store.setUserPassword(userId, await hashPassword(password));
  // Someone who can read the inbox has also proven the address.
  await store.markEmailVerified(userId);
  return store.getUserById(userId);
}

export async function changePassword(user, { current, next }) {
  if (!(await verifyPassword(current, user.password_hash))) {
    throw new Error('Your current password is not correct.');
  }
  const chosen = String(next || '');
  if (chosen.length < 10) throw new Error('Use a password of at least 10 characters.');
  if (chosen === String(current)) throw new Error('That is the password you already have.');

  // This bumps `session_epoch`, so every other device is signed out. The caller
  // re-issues this browser's cookie so the person doing the right thing is not
  // the one who gets locked out for it.
  await getStore().setUserPassword(user.id, await hashPassword(chosen));
}

/**
 * Whether a new account may be created at all.
 *
 * Open by default: signing up is an email and a password, nothing else. Set
 * `ALLOW_SIGNUP=false` on a public deployment once your own accounts exist and
 * the door closes behind you — the first account can always be created, or the
 * deployment would have no administrator.
 */
export function signupOpen() {
  return !/^(0|false|no)$/i.test(process.env.ALLOW_SIGNUP ?? 'true');
}

export async function registerUser({ email, password, name }, req, res) {
  const store = getStore();

  const normalised = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalised)) throw new Error('That does not look like an email address.');
  if (String(password || '').length < 10) throw new Error('Use a password of at least 10 characters.');

  const isFirstUser = (await store.countUsers()) === 0;
  if (!isFirstUser && !signupOpen()) {
    throw Object.assign(new Error('Registration is closed on this deployment.'), { status: 403 });
  }
  if (await store.getUserByEmail(normalised)) throw new Error('That email is already registered.');

  const user = await store.createUser({
    id: crypto.randomUUID(),
    email: normalised,
    name: String(name || '').trim() || normalised.split('@')[0],
    passwordHash: await hashPassword(password),
    role: isFirstUser ? 'admin' : 'user',
  });

  // No confirmation step. The address is checked for shape here and for
  // deliverability wherever accounts are handed out; sending a code and then
  // holding the account hostage until someone finds it only ever punished the
  // people who did nothing wrong. The column stays so a password reset can
  // still record that an inbox was proven.
  await store.markEmailVerified(user.id);

  const fresh = await store.getUserById(user.id);
  issue(req, res, fresh);
  return fresh;
}

export async function loginUser({ email, password, code, remember }, req, res) {
  const store = getStore();

  const user = await store.getUserByEmail(String(email || '').trim().toLowerCase());
  // Hash even when the account is missing, so timing does not reveal which
  // emails exist.
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
  if (!user || !ok) return null;

  if (user.suspended_at) {
    throw Object.assign(new Error('This account has been suspended.'), { status: 403 });
  }

  // Second factor, if this account turned it on. No session is issued until it
  // checks out, so a stolen password alone gets nowhere.
  if (user.totp_enabled_at) {
    if (!code) {
      throw Object.assign(new Error('Enter the code from your authenticator app.'), {
        status: 401,
        code: 'totp_required',
      });
    }
    if (!(await verifySecondFactor(user, code))) {
      throw Object.assign(new Error('That code is not right. Try the next one.'), {
        status: 401,
        code: 'totp_required',
      });
    }
  }

  // An unconfirmed account may sign in — it just cannot do anything yet. That
  // is friendlier than a dead end: the app shows the code box straight away.
  await store.touchUser(user.id);
  // Anything but an explicit "no" keeps the old thirty-day behaviour, so API
  // callers and older clients that never send the flag are unaffected.
  issue(req, res, user, remember !== false);
  return user;
}

// ── two-factor ────────────────────────────────────────────────────────

/**
 * Accepts either a live authenticator code or one unused recovery code.
 *
 * A TOTP code is valid for a ±1 step window, so without a record of which step
 * was spent, a code glimpsed over somebody's shoulder — or sitting in a log —
 * works for a minute and a half. Burning the step makes each code single-use,
 * which is what people already assume it is.
 */
async function verifySecondFactor(user, code) {
  const clean = String(code || '').trim().toUpperCase();

  if (/^\d{6}$/.test(clean)) {
    const step = matchingTotpStep(decryptSecret(user.totp_secret), clean);
    if (step == null) return false;
    return getStore().consumeTotpStep(user.id, step);
  }
  // Recovery codes look like ABCDE-12345 and are spent on use.
  if (/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(clean)) {
    return getStore().consumeRecoveryCode(user.id, sha256(clean));
  }
  return false;
}

/**
 * Start enrolment: mint a secret and hand back the QR. Nothing is switched on
 * until the user proves they can read a code from it, so a half-finished setup
 * cannot lock anyone out.
 */
export async function beginTotpSetup(user) {
  const secret = totpSecret();
  await getStore().setTotpSecret(user.id, encryptSecret(secret));

  const uri = totpUri({ secret, email: user.email });
  const { toString: renderQr } = await import('qrcode');
  const qr = await renderQr(uri, { type: 'svg', margin: 1, color: { dark: '#e8eef4', light: '#0000' } });

  return { secret, uri, qr };
}

/** Finish enrolment. Returns the recovery codes — shown once, stored hashed. */
export async function confirmTotpSetup(user, code) {
  if (!user.totp_secret) throw new Error('Start the setup again — no pending secret was found.');
  if (!verifyTotp(decryptSecret(user.totp_secret), code)) {
    throw new Error('That code is not right. Check your authenticator app and try again.');
  }

  const codes = recoveryCodes();
  await getStore().enableTotp(user.id, codes.map((c) => sha256(c)));
  return codes;
}

/** Turning it off requires the password *and* a live code. */
export async function disableTotp(user, { password, code }) {
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new Error('Your password is not correct.');
  }
  if (!user.totp_enabled_at) return;
  if (!(await verifySecondFactor(user, code))) {
    throw new Error('That code is not right.');
  }
  await getStore().disableTotp(user.id);
}

/**
 * Prove it is really the owner, for something that cannot be undone — deleting
 * the account. The same two things a sign-in asks for: the password, and the
 * live code when two-factor is on. A session alone is not enough, because a
 * session is exactly what a borrowed laptop or a stolen cookie has.
 */
export async function confirmIdentity(user, { password, code }) {
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new Error('Your password is not correct.');
  }
  if (user.totp_enabled_at && !(await verifySecondFactor(user, code))) {
    throw new Error('Enter the current code from your authenticator app.');
  }
}

/** Resolve the session cookie to a live user, or null. */
export async function currentUser(req) {
  const payload = verify(parseCookies(req.headers.cookie)[COOKIE]);
  if (!payload?.uid) return null;

  const user = await getStore().getUserById(payload.uid);
  if (!user) return null;

  // A cookie minted before the last password change is no longer a session.
  // Cookies issued before this field existed carry no epoch; treat those as 1,
  // which is what every existing row defaults to, so nobody is signed out by the
  // upgrade itself.
  const epoch = Number(user.session_epoch) || 1;
  if ((Number(payload.epoch) || 1) !== epoch) return null;

  return user;
}

export async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (user.suspended_at) {
      clearSession(res);
      return res.status(403).json({ error: 'This account has been suspended.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

/**
 * Worker authentication.
 *
 * The bearer token identifies **which account's computer** is calling, so jobs
 * can only ever be handed to their own owner — and now also **which** computer,
 * because an account can have several. `req.workerDevice` is null for a worker
 * paired before devices existed, which still authenticates through the legacy
 * column and behaves exactly as it always did.
 */
export async function requireWorker(req, res, next) {
  try {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!given) return res.status(401).json({ error: 'unauthorized' });

    const owner = await getStore().getUserByWorkerToken(sha256(given));
    if (!owner) return res.status(401).json({ error: 'unauthorized' });

    req.workerUser = { id: owner.id, email: owner.email };
    req.workerDevice = owner.device_id ? { id: owner.device_id, name: owner.device_name } : null;
    next();
  } catch (err) {
    next(err);
  }
}


/**
 * The cron endpoint is called by Vercel, not by a browser. It authenticates
 * with a bearer secret so a public URL cannot be used to hammer OpenRouter.
 */
export function requireCron(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secretEquals(given, expected)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
