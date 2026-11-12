import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getStore, isServerless } from './store/index.js';
import { sha256, randomToken, encryptSecret, decryptSecret } from './crypto.js';
import { devicePairingContext } from './secretContexts.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The computers an account can reach.
 *
 * There used to be one token per account, kept in a column on `users`, and
 * generating a token for a second machine silently invalidated the first. So
 * "sign in anywhere and your computer is there" was only ever true for one
 * computer — pair the laptop and the desktop went dark, with nothing in the
 * interface to say why. A person has both. A team member has a work machine and
 * a home one. Each gets its own row and its own token now, revocable on its own.
 *
 * Pairing is deliberately the shape a television uses, and the direction matters:
 *
 *   1. The worker starts with no token, asks for a code, prints it, and polls.
 *   2. Somebody already signed in types that code into the app.
 *   3. That claim — made by an authenticated person — is what attaches the
 *      machine to their account and mints its token.
 *   4. The worker's next poll collects the token and writes it to worker/.env.
 *
 * An unauthenticated request can therefore only ever ask to be adopted. It
 * cannot name an account, read anything, or do anything at all until a real
 * person decides it belongs to them.
 */

/** Long enough to be unguessable in ten minutes, short enough to read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 10 * 60 * 1000;

/** `ABCD-2K7M` — grouped, because people read and type it off a screen. */
export function pairingCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    if (i === 4) out += '-';
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Accept whatever somebody types: spaces, lower case, a missing dash. */
export function normaliseCode(input) {
  const clean = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (clean.length !== CODE_LENGTH) return null;
  // O/0 and I/1 are not in the alphabet, so a misread is a fixable typo rather
  // than a wrong code.
  const fixed = clean.replace(/O/g, '0').replace(/I/g, '1').replace(/0/g, 'O').replace(/1/g, 'I');
  return `${fixed.slice(0, 4)}-${fixed.slice(4)}`;
}

const MAX_NAME = 60;
const cleanName = (value, fallback) =>
  String(value || '').trim().slice(0, MAX_NAME) || fallback;

/**
 * A computer asks to be adopted. No authentication — there is nothing to
 * authenticate yet, and nothing is granted until somebody claims it.
 */
export async function startPairing({ deviceName, info }) {
  /**
   * Try again if the code is already live.
   *
   * Schema 17 makes the code unique across unclaimed pairings, which is what
   * stops the installer naming the wrong account. The cost of a uniqueness rule
   * is that an insert can now fail, and a collision — however unlikely with
   * eight characters — must not reach somebody as an error asking them to pair
   * again. It is a fresh random code; drawing another is the whole fix.
   *
   * Three attempts, then let it through: a failure that survives three
   * independent draws is not a collision, and swallowing it would hide the real
   * fault behind a misleading message.
   */
  for (let attempt = 0; ; attempt += 1) {
    const id = crypto.randomUUID();
    const code = pairingCode();
    try {
      await getStore().createPairing({
        id,
        codeHash: sha256(code),
        deviceName: cleanName(deviceName, 'A computer'),
        info: info || {},
        expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
      });
      return { id, code, expiresInSec: Math.floor(PAIRING_TTL_MS / 1000) };
    } catch (err) {
      const duplicate = err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
      if (!duplicate || attempt >= 2) throw err;
    }
  }
}

/**
 * Adopt the computer holding this code.
 *
 * Mints the device token here and stores it encrypted on the pairing row, so it
 * survives the few seconds until the worker's next poll without ever being
 * written down in the clear. Only the digest goes into `devices`.
 */
export async function claimPairing(userId, rawCode, { name } = {}) {
  const code = normaliseCode(rawCode);
  if (!code) throw new Error('That is not a pairing code. It looks like ABCD-2K7M.');

  const store = getStore();
  const token = randomToken(24);

  const pairing = await store.claimPairing(userId, sha256(code), encryptSecret(token, devicePairingContext()));
  if (!pairing) {
    throw new Error('That code is not valid, has already been used, or has expired. Ask the computer for a new one.');
  }

  const device = await store.createDevice(userId, {
    // The device id doubles as the worker id, so presence and identity are one
    // row rather than two things to keep in step.
    id: pairing.id,
    tokenHash: sha256(token),
    name: cleanName(name, pairing.device_name),
    info: pairing.info || {},
  });

  return { device, token };
}

/**
 * The worker collecting its token. Called with the pairing id it was given, and
 * answers "not yet" until somebody claims it.
 */
export async function collectPairing(id) {
  const store = getStore();
  const pairing = await store.getPairing(String(id || ''));

  if (!pairing) return { status: 'unknown' };
  if (!pairing.claimed_at) {
    if (new Date(pairing.expires_at) < new Date()) return { status: 'expired' };
    return { status: 'pending' };
  }

  // Claimed: hand the token over once and delete the row with it.
  const collected = await store.consumePairing(pairing.id);
  if (!collected) return { status: 'pending' };

  const token = decryptSecret(collected.secret, devicePairingContext());
  if (!token) return { status: 'unknown' };

  return { status: 'paired', token, deviceId: pairing.id, name: collected.device_name };
}

/**
 * Enrolment — pairing, run the other way round.
 *
 * A pairing code is minted by a computer and typed by whoever owns the account.
 * An enrolment token is minted by a signed-in person and carried *to* a
 * computer, so nobody types anything: the installer redeems it.
 *
 * **The direction is the security property, and reversing it costs something.**
 * A code cannot be phished, because it travels from the machine to its owner. A
 * token travels the other way, so it can be handed to somebody — "paste this to
 * activate your trial" — and the machine that pastes it belongs to whoever
 * minted the token. On a deployment anybody can register on, that is a malware
 * distribution channel wearing the app as a costume.
 *
 * So redeeming happens in two steps, and the first one is not optional:
 * `previewEnrolment` says which account is about to be given the files, the
 * shell and the screen of this computer, and the installer refuses to continue
 * until a human types YES. Somebody can still be talked into typing it — but
 * that is an informed decision rather than a paste that looked harmless.
 *
 * The token is a secret in a command line, and command lines end up in shell
 * history. Ten minutes and one use each; that bounds it rather than fixing it.
 */
const ENROLMENT_TTL_MS = 10 * 60 * 1000;

export async function startEnrolment(userId) {
  const id = crypto.randomUUID();
  const token = randomToken(24);

  await getStore().createEnrolment({
    id,
    codeHash: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + ENROLMENT_TTL_MS).toISOString(),
  });

  return { token, expiresInSec: Math.floor(ENROLMENT_TTL_MS / 1000) };
}

/** Whose account is this? Answered without spending the token. */
export async function previewEnrolment(rawToken) {
  const row = await getStore().peekEnrolment(sha256(String(rawToken || '')));
  if (!row) throw new Error('That setup link has expired or has already been used. Get a new one from the app.');
  return { account: row.email };
}

/** Spend it, and hand back the token this computer will authenticate with. */
export async function redeemEnrolment(rawToken, { name, info } = {}) {
  const store = getStore();
  const row = await store.consumeEnrolment(sha256(String(rawToken || '')));
  if (!row) throw new Error('That setup link has expired or has already been used. Get a new one from the app.');

  const token = randomToken(24);
  const device = await store.createDevice(row.user_id, {
    id: row.id,
    tokenHash: sha256(token),
    name: cleanName(name, 'A computer'),
    info: info || {},
  });

  return { device, token };
}

export async function listDevices(userId) {
  const rows = await getStore().listDevices(userId);
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    online: d.online === true,
    platform: d.info?.platform ?? null,
    // Two different things, and conflating them is how somebody ends up staring
    // at a path the assistant is not actually using: `workspace` is where it
    // really is, reported by the machine; `wanted` is what was asked for and may
    // not have been adopted yet — or at all, if the folder is not there.
    workspace: d.info?.workspace ?? null,
    wanted: d.workspace ?? null,
    workspaceError: d.info?.workspaceError ?? null,
    desktop: !!d.info?.desktop,
    fullDisk: !!d.info?.fullDisk,
    createdAt: d.created_at,
    lastSeen: d.last_seen,
  }));
}


/**
 * Which browser this computer drives.
 *
 * Validated here rather than at the column, so an unknown value is refused
 * while somebody is looking at the control that sent it — instead of being
 * stored, shipped to the machine, and silently ignored there.
 */

/**
 * The pairing code offered by a worker on *this* machine, if there is one.
 *
 * Only ever answered by a locally-run server, and the restriction is not
 * arbitrary: the server cannot tell which unclaimed pairing belongs to the
 * person asking — that is the entire point of a code — so the only honest way to
 * answer "what is this computer's code" is to be on the same disk as the
 * computer. On a deployment there is no such file and no such question.
 */
export function localPairingCode() {
  if (isServerless()) return null;

  const file = path.resolve(
    process.env.DATA_DIR || path.resolve(here, '../data'),
    'pending-pairing.json',
  );

  try {
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    // An expired code is worse than none: somebody would type it and be told it
    // is wrong, which reads as the pairing being broken.
    if (!pending?.code || new Date(pending.expiresAt) < new Date()) return null;
    return { code: pending.code, name: pending.name || null, expiresAt: pending.expiresAt };
  } catch {
    return null;
  }
}

const MAX_PATH = 400;

/**
 * Point a computer at a different folder.
 *
 * Validated for shape only. Whether the folder exists is a question about that
 * machine, which this server has no way to answer — so the worker checks when it
 * adopts it and reports back, and the app shows that rather than pretending to
 * know.
 */
export async function setDeviceWorkspace(userId, deviceId, rawPath) {
  const store = getStore();
  const wanted = String(rawPath ?? '').trim();

  if (wanted.length > MAX_PATH) throw new Error('That path is too long.');
  // A blank box means "go back to whatever the machine was started with", which
  // is a real thing to want and the only way back from a bad choice.
  if (wanted && !/^(?:[a-z]:[\\/]|[\\/]|~)/i.test(wanted)) {
    throw new Error('Give an absolute path, such as D:\\projects or /home/me/code.');
  }

  const device = await store.setDeviceWorkspace(userId, deviceId, wanted || null);
  if (!device) throw new Error('No such computer is paired to this account.');
  return device;
}

export async function revokeDevice(userId, deviceId) {
  const gone = await getStore().revokeDevice(userId, String(deviceId || ''));
  if (!gone) throw new Error('No such computer is paired to this account.');
  return gone;
}
