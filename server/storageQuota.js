import { getStore } from './store/index.js';
import { billedPlanOf } from './billing/meter.js';

/**
 * Half a gigabyte of files for an account with no plan, while files live in the database
 * (owner, 2026-11-13).
 *
 * A file is kept as base64 in Postgres (`attachments.data`, `attachment_versions.data`), so a
 * gigabyte of them costs about 4,265đ a month of database disk and nothing limited an account.
 * Until files move to object storage a person who is not an administrator keeps at most this
 * much; the day they do, the number is a plan's, not this one.
 *
 * What is counted is the file's own bytes (the `bytes` column), every kept copy of it
 * included, and what is refused is only a new file or a new copy. A picture drawn from a file
 * already kept is counted and never refused, and nothing already stored is ever deleted: an
 * account that is over keeps all it has and simply cannot add until it is under.
 */

const num = (value, fallback) => {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** What an account with no plan may keep, in bytes. */
export const freeStorageBytes = (env = process.env) => num(env.FREE_STORAGE_BYTES, 500_000_000);

/** A size as a person reads it: decimal, to match what the limit is said in ("0.5 GB"). */
export function sizeText(bytes) {
  const n = Number(bytes) || 0;
  const trim = (value) => String(Math.round(value * 10) / 10);
  // From half a gigabyte up, so the limit itself reads "0.5 GB" as the owner wrote it.
  if (n >= 5e8) return `${trim(n / 1e9)} GB`;
  if (n >= 1e6) return `${trim(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** A refusal: a route answers it 422 with `code`, a tool's result carries its message. */
export class StorageFull extends Error {
  /**
   * @param {string} message
   * @param {number} usedBytes
   * @param {number} limitBytes
   */
  constructor(message, usedBytes, limitBytes) {
    super(message);
    this.name = 'StorageFull';
    this.status = 422;
    this.code = 'storage_full';
    this.usedBytes = usedBytes;
    this.limitBytes = limitBytes;
  }
}

/** Built as `…Error(`…`)` so scripts/server-messages.js finds the sentence for its Vietnamese. */
const storageFullError = (message, usedBytes, limitBytes) => new StorageFull(message, usedBytes, limitBytes);

/** Whether this account has no limit: an administrator, as with the chat limit. */
const unlimited = (user) => user?.role === 'admin';

/**
 * What an account uses and may use. `limitBytes` is null for one with no limit. An account billing meters
 * (billing/meter.js) and that holds a paid plan has its plan's gigabytes instead of either: past them it is
 * charged by the day (chargeStorageDay), never refused (owner, 2026-11-13).
 *
 * @param {{ id?: string, role?: string } | null | undefined} user
 * @returns {Promise<{ usedBytes: number, limitBytes: number | null }>}
 */
export async function storageOf(user) {
  const usedBytes = user?.id ? await getStore().bytesOfUser(user.id) : 0;
  const billed = await billedPlanOf(user);
  if (billed) return { usedBytes, limitBytes: Math.round(billed.storageGb * 1e9) };
  return { usedBytes, limitBytes: unlimited(user) ? null : freeStorageBytes() };
}

/**
 * Throws StorageFull when adding `bytes` would take a limited account past its room.
 * Exactly reaching the limit is allowed.
 *
 * @param {{ id?: string, role?: string } | null | undefined} user
 * @param {number} bytes
 */
export async function assertRoom(user, bytes) {
  if (unlimited(user)) return;
  // A plan's gigabytes are a rate, not a wall: what is over them is charged by the day.
  if (await billedPlanOf(user)) return;
  const { usedBytes, limitBytes } = await storageOf(user);
  if (limitBytes == null || usedBytes + (Number(bytes) || 0) <= limitBytes) return;
  throw storageFullError(
    `Your files are full: ${sizeText(usedBytes)} of ${sizeText(limitBytes)} used. Delete files you no longer need in Settings → Privacy → Your data, then try again.`,
    usedBytes,
    limitBytes,
  );
}

/** The same, for a caller that has only the account's id. */
export async function assertRoomFor(userId, bytes) {
  await assertRoom(await getStore().getUserById(userId), bytes);
}
