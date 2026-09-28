import crypto from 'node:crypto';
import { promisify } from 'node:util';

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

/**
 * Provider API keys are other people's credentials. They are encrypted at rest
 * so a database dump alone does not hand them over.
 */
function encryptionKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.ACCESS_TOKEN;
  if (!secret) {
    // Reaching here means the startup check was bypassed — say what to do, not
    // just what is wrong.
    throw new Error(
      'The server has no ENCRYPTION_KEY, so API keys cannot be stored safely. ' +
        'Add ENCRYPTION_KEY to the environment and restart (running locally, ' +
        'stopping and starting again generates one for you).',
    );
  }
  return crypto.createHash('sha256').update(`ai-remote:keys:${secret}`).digest();
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function decryptSecret(payload) {
  try {
    const [version, ivB64, tagB64, bodyB64] = String(payload).split('.');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong ENCRYPTION_KEY or tampered ciphertext. Treat as "no key configured"
    // rather than crashing the request.
    return '';
  }
}
