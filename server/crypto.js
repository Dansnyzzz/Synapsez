import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { log } from './util/trace.js';
import { SECRET_KINDS } from './secretContexts.js';

const scrypt = promisify(crypto.scrypt);

/**
 * Password hashing. scrypt is memory-hard, ships with Node, and needs no
 * dependency — the right trade-off for an app that stores a handful of accounts.
 * Format: scrypt$N$salt$hash, so the cost can be raised later without breaking
 * existing hashes.
 */
const SCRYPT_COST = 2 ** 15;

// Node's default scrypt maxmem (32 MB) is below what N=2^15 needs, so it must be
// raised on every call — hashing and verifying alike.
const scryptOptions = (N) => ({ N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

/**
 * Only so many password hashes at once.
 *
 * Memory-hardness is the point of scrypt and also its sharp edge: N=2^15 costs
 * about 32MB per call, so a hundred simultaneous sign-in attempts would ask for
 * three gigabytes — on a function with one. That is a denial of service that
 * needs no password and no account, just the login form.
 *
 * A small queue turns "the server falls over" into "the fourth person waits",
 * which is the right trade. The rate limiter in front of this is the other half.
 */
const MAX_CONCURRENT_HASHES = 4;
let running = 0;
const waiting = [];

async function withHashSlot(work) {
  if (running >= MAX_CONCURRENT_HASHES) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await withHashSlot(() =>
    scrypt(String(password), salt, 32, scryptOptions(SCRYPT_COST)),
  );
  return `scrypt$${SCRYPT_COST}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, cost, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;

    // A hand-edited or corrupted row must not be able to ask for an arbitrary
    // amount of work — the cost parameter is data, and data is not trusted.
    const n = Number(cost);
    if (!Number.isInteger(n) || n < 2 ** 12 || n > 2 ** 20) return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    if (!salt.length || !expected.length) return false;

    const key = await withHashSlot(() =>
      scrypt(String(password), salt, expected.length, scryptOptions(n)),
    );
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * A syntactically valid hash that no password matches.
 *
 * Sign-in verifies against this when the account does not exist, so a missing
 * email costs exactly as much time as a wrong password and the endpoint cannot
 * be used to discover who has an account. It has to carry the *real* cost
 * parameter to do that — a cheap placeholder would be rejected early and answer
 * in a millisecond, which is the tell it exists to hide.
 */
export const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_COST}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

/** Opaque tokens are only ever stored as a digest, never in the clear. */
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/**
 * A short numeric code to type by hand. Six digits is weak on its own, which is
 * why it is single-use, short-lived, and scoped to one account — the same
 * trade-off every "enter the code we emailed you" flow makes, and far kinder on
 * a phone than switching to the mail app to click a link.
 */
export function numericCode(digits = 6) {
  const max = 10 ** digits;
  // Rejection sampling, so every code is equally likely.
  const ceiling = Math.floor(0xffffffff / max) * max;
  let value;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= ceiling);
  return String(value % max).padStart(digits, '0');
}

// ── TOTP (RFC 6238) ───────────────────────────────────────────────────
//
// Authenticator apps are all built on HMAC-SHA1 over a 30-second counter, so
// this needs no dependency — Node's crypto has everything. The only fiddly part
// is base32, which is what the apps expect a secret to be written in.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(text).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes is the RFC-recommended secret length and what every app expects. */
export const totpSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBase32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export const totpCode = (secret, at = Date.now()) => hotp(secret, Math.floor(at / 30_000));

/**
 * Which 30-second step this code belongs to, or null if it belongs to none.
 *
 * One step either side is allowed so a phone whose clock is a few seconds out
 * still works. Returning the step rather than a boolean is what lets the caller
 * record it as spent — a code that stays valid for its whole ninety-second
 * window is a code that can be replayed.
 *
 * Comparison is constant-time, and every candidate step is checked even after a
 * match so the time taken does not reveal which one it was.
 */
export function matchingTotpStep(secret, code, at = Date.now()) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6 || !secret) return null;

  const counter = Math.floor(at / 30_000);
  const actual = Buffer.from(given);
  let found = null;

  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(secret, counter + drift));
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
      if (found === null) found = counter + drift;
    }
  }
  return found;
}

/** True when the code is currently valid. Says nothing about replay — see above. */
export function verifyTotp(secret, code, at = Date.now()) {
  return matchingTotpStep(secret, code, at) !== null;
}

/** The URI authenticator apps read from a QR code. */
export function totpUri({ secret, email, issuer = 'Synapsez' }) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params}`;
}

/** One-time codes for when the phone is lost. Shown once, stored hashed. */
export function recoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

/*
 * ── Secrets at rest: the v2 envelope (owner, 2026-11-12) ───────────────────
 *
 * Every credential this app keeps for somebody — provider keys, OAuth and connector
 * tokens, the TOTP seed, MCP headers and environments, hook secrets, the cloud
 * computer's service keys — is sealed with AES-256-GCM. What v2 adds to v1, and why:
 *
 *   - **Bound to whose and what it is.** The sealing names its purpose and owner as
 *     additional authenticated data (`context`, e.g. ['provider-key', userId, 'openrouter']),
 *     length-prefixed so no two contexts can be spliced into the same bytes. A ciphertext
 *     copied into another account's row — by anyone who can write to the database — no
 *     longer opens there. v1 had no context: a sealed token was anyone's.
 *   - **Keys that can change.** Each sealing carries the id of the key that sealed it.
 *     ENCRYPTION_KEY is the key; ENCRYPTION_KEY_PREVIOUS (comma-separated) holds the ones
 *     before it, still able to open what they sealed. Rotating is: set the new key, move
 *     the old one to PREVIOUS, run `npm run secrets:reseal -- --apply`, then drop PREVIOUS.
 *     v1 had one key, and changing it silently made every stored credential unreadable.
 *   - **Failures said apart.** `openSecret` answers ok, empty, undecryptable (wrong key or
 *     tampered), unknown-key (sealed by a key this server no longer has) or refused-v1; and an
 *     undecryptable value is logged once, by kind, with nothing of the value in it. v1 said
 *     "" for all of them, so a lost key looked like "no key configured".
 *   - **HKDF** derives the AES key from the secret (v1 hashed it once, which is sound for a
 *     long random secret, and stays for opening v1).
 *
 * v1 still opens, so nothing stored before this breaks; everything written from now on is
 * v2, and `npm run secrets:reseal` re-seals the rest. ENCRYPTION_REFUSE_V1=true then refuses
 * v1 outright, so once the cutover is done the envelope is never chosen by whoever can
 * write the stored value (a v1 value written there would otherwise open, unbound).
 */

/** The secrets this server can seal and open with, newest first. */
function secretsInUse() {
  const current = process.env.ENCRYPTION_KEY || process.env.ACCESS_TOKEN;
  if (!current) {
    // Reaching here means the startup check was bypassed — say what to do, not
    // just what is wrong.
    throw new Error(
      'The server has no ENCRYPTION_KEY, so API keys cannot be stored safely. ' +
        'Add ENCRYPTION_KEY to the environment and restart (running locally, ' +
        'stopping and starting again generates one for you).',
    );
  }
  const previous = String(process.env.ENCRYPTION_KEY_PREVIOUS || '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
  return [current, ...previous];
}

/** Keys derived once per set of secrets: v2 by HKDF, v1 as v1 derived them, and each v2 key's id. */
let ring = { from: '', keys: [] };
function keyring() {
  const secrets = secretsInUse();
  const from = secrets.join('\u0000');
  if (ring.from === from) return ring.keys;
  const keys = secrets.map((secret, index) => {
    const v2 = Buffer.from(crypto.hkdfSync('sha256', secret, 'ai-remote:keys:v2', 'aes-256-gcm', 32));
    return {
      id: crypto.createHash('sha256').update(v2).digest('hex').slice(0, 12),
      v2,
      v1: crypto.createHash('sha256').update(`ai-remote:keys:${secret}`).digest(),
      current: index === 0,
    };
  });
  ring = { from, keys };
  // Said once per set of keys: a short secret is a weak AES key, whatever the derivation.
  if (String(secrets[0]).length < 32) log.warn('ENCRYPTION_KEY is shorter than 32 characters — a longer random value is safer; rotate with ENCRYPTION_KEY_PREVIOUS and npm run secrets:reseal');
  return keys;
}

/** The id of the key that seals now — for the reseal script and the administrators' view. */
export const currentKeyId = () => keyring()[0].id;

/**
 * A context as authenticated bytes: every part length-prefixed, so ['a|b', 'c'] and
 * ['a', 'b|c'] can never be the same bytes — no owner can be spliced into another's.
 *
 * @param {Array<string|number|null|undefined>} context
 */
export function contextBytes(context = []) {
  const parts = ['ai-remote', 'secret', 'v2', ...(Array.isArray(context) ? context : [context])];
  return Buffer.from(parts.map((part) => {
    const text = String(part ?? '');
    return `${Buffer.byteLength(text)}:${text}`;
  }).join('|'), 'utf8');
}

/**
 * Seal a credential, bound to what it is and whose (see above).
 *
 * @param {string} plaintext
 * @param {Array<string|number|null|undefined>} [context] e.g. ['provider-key', userId, provider]
 */
export function encryptSecret(plaintext, context = []) {
  // A binding with a part left empty — an owner forgotten, or no context at all — would open
  // for anything sealed the same way without one (security review, 2026-11-12): refused when
  // sealing, not found later. A known kind, then its owner; only a device pairing, which lives
  // minutes and has no account yet, is a kind alone (secretContexts.js).
  const parts = Array.isArray(context) ? context : [context];
  const kindOnly = parts.length === 1 && parts[0] === 'device-pairing';
  if (!SECRET_KINDS.includes(String(parts[0])) || (!kindOnly && (parts.length < 2 || parts.slice(1).some((part) => part == null || String(part) === '')))) {
    throw new Error('A stored credential needs to know whose it is and what it is for — part of that was missing, so it was not saved.');
  }
  const key = keyring()[0];
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.v2, iv);
  cipher.setAAD(contextBytes(context));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v2.${key.id}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

/**
 * Which envelope a stored value is in, and which key sealed it (v2 only).
 *
 * @returns {{ version: 'v1'|'v2'|null, keyId: string|null }}
 */
export function secretVersion(payload) {
  const parts = String(payload ?? '').split('.');
  if (parts[0] === 'v2' && parts.length === 5) return { version: 'v2', keyId: parts[1] };
  if (parts[0] === 'v1' && parts.length === 4) return { version: 'v1', keyId: null };
  return { version: null, keyId: null };
}

/** v1 refused outright, once every stored value has been re-sealed (ENCRYPTION_REFUSE_V1). */
const refusingV1 = () => /^(1|true|yes|on)$/i.test(String(process.env.ENCRYPTION_REFUSE_V1 || '').trim());

/**
 * One AES-256-GCM open, with the nonce and tag at the lengths sealing writes and nothing
 * shorter: Node accepts a GCM tag cut to 4 bytes unless told its length, and a short tag
 * is a forgery an attacker who can write the database may simply guess — then a value
 * moved into another context opens (security review, 2026-11-12, measured on Node 22.16).
 */
function openGcm(key, ivB64, tagB64, bodyB64, aad) {
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('not a sealed value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Kinds already said in the log, so a broken key is one line, not one per request. */
const reported = new Set();
function reportOnce(state, version, context) {
  const kind = `${state}|${version}|${String((Array.isArray(context) ? context : [context])[0] ?? '')}`;
  if (reported.has(kind)) return;
  reported.add(kind);
  // Only what it is and why — never the value, never the owner.
  log.warn('secrets: a stored credential could not be opened — if ENCRYPTION_KEY changed, put the old one in ENCRYPTION_KEY_PREVIOUS', {
    kind: String((Array.isArray(context) ? context : [context])[0] || 'credential'),
    state,
    version: String(version),
  });
}

/**
 * Open a sealed credential, saying how it went.
 *
 * @param {string} payload
 * @param {Array<string|number|null|undefined>} [context] the same context it was sealed with
 * @returns {{ value: string, state: 'ok'|'empty'|'undecryptable'|'unknown-key'|'refused-v1'|'no-key', version: 'v1'|'v2'|null, current: boolean }}
 */
export function openSecret(payload, context = []) {
  const text = String(payload ?? '');
  if (!text) return { value: '', state: 'empty', version: null, current: false };
  const parts = text.split('.');
  let keys;
  try {
    keys = keyring();
  } catch {
    // No ENCRYPTION_KEY here at all — a script run without the deployment's environment.
    // Said as its own state, never thrown at a caller that only wanted "" (as v1 gave).
    return { value: '', state: 'no-key', version: secretVersion(text).version, current: false };
  }
  if (parts[0] === 'v2' && parts.length === 5) {
    const key = keys.find((k) => k.id === parts[1]);
    if (!key) {
      reportOnce('unknown-key', 'v2', context);
      return { value: '', state: 'unknown-key', version: 'v2', current: false };
    }
    try {
      return { value: openGcm(key.v2, parts[2], parts[3], parts[4], contextBytes(context)), state: 'ok', version: 'v2', current: key.current };
    } catch {
      reportOnce('undecryptable', 'v2', context);
      return { value: '', state: 'undecryptable', version: 'v2', current: false };
    }
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    if (refusingV1()) {
      reportOnce('refused-v1', 'v1', context);
      return { value: '', state: 'refused-v1', version: 'v1', current: false };
    }
    for (const key of keys) {
      try {
        return { value: openGcm(key.v1, parts[1], parts[2], parts[3], null), state: 'ok', version: 'v1', current: false };
      } catch {
        /* the next key, then none */
      }
    }
    reportOnce('undecryptable', 'v1', context);
    return { value: '', state: 'undecryptable', version: 'v1', current: false };
  }
  reportOnce('undecryptable', 'unknown', context);
  return { value: '', state: 'undecryptable', version: null, current: false };
}

/**
 * The credential itself, or "" when it cannot be opened — the shape every caller had
 * before v2, so a credential that will not open still reads as "not configured" rather
 * than failing the request. `openSecret` for callers that must tell the two apart.
 *
 * @param {string} payload
 * @param {Array<string|number|null|undefined>} [context]
 */
export function decryptSecret(payload, context = []) {
  return openSecret(payload, context).value;
}

/** Whether a stored value should be sealed again: v1, or v2 under a key that no longer seals. */
export function needsReseal(payload) {
  const { version, keyId } = secretVersion(payload);
  if (version === 'v1') return true;
  return version === 'v2' && keyId !== currentKeyId();
}
