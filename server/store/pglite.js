import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createPgStore } from './pg.js';

/**
 * Postgres-in-process, persisted to a folder on disk.
 *
 * This is what lets accounts work identically on a laptop and on Neon: the same
 * SQL, the same per-account scoping, the same tests. It replaces the old
 * JSON-file store, which could only ever hold one user behind a shared access
 * code — something nobody wants to remember.
 *
 * Local runs only: on Vercel the filesystem is ephemeral, so a hosted
 * DATABASE_URL is required there.
 */

/**
 * The lock Postgres leaves behind when it is not shut down politely.
 *
 * A clean stop removes `postmaster.pid`; anything else — closing the terminal,
 * a machine going to sleep, the launcher killing the tree, a crash — leaves it
 * there. On the next start Postgres finds it, assumes another server owns the
 * directory, and refuses. Inside WASM that refusal arrives as `Aborted()`
 * followed by ninety kilobytes of minified runtime, and the launcher reports
 * `server exited with code 1`, which says nothing about a file being in the
 * way of a database that is otherwise perfectly fine.
 */
const LOCK_FILE = 'postmaster.pid';

/**
 * Whether something is already listening where this app would.
 *
 * The pid inside the lock file is Postgres's own, from inside the WASM sandbox,
 * so it means nothing to the operating system and cannot be checked against the
 * process table. The port can be: this database is embedded in this app, so if
 * nothing answers on the app's port then no copy of the app is running, and a
 * lock file left over from the last one is stale by definition.
 *
 * If something *is* listening, the lock is real — a second copy of the app is
 * running against the same folder — and clearing it would let two processes
 * write to one database, which is how the data actually gets damaged.
 */
function portIsBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * One process at a time, and this is the file that enforces it.
 *
 * PGlite has no cross-process locking of its own. Two processes that open the
 * same folder both believe they own it, both write, and the result is a
 * write-ahead log with an unreadable checkpoint in it — a database that will
 * not start and cannot be repaired without tools PGlite does not ship. That is
 * not hypothetical: it happened here, to a script that opened the live data
 * directory while the app was running, and it cost somebody their conversations.
 *
 * Postgres's own `postmaster.pid` does not prevent it, because the pid in there
 * belongs to the WASM sandbox and no operating system can check it. This one
 * holds the *real* pid, which can be — so a lock from a process that has died
 * is cleared automatically, and a lock from one that is alive stops the second
 * opener before it writes a single byte.
 */
const OWNER_FILE = 'owner.pid';

/** Whether a process id belongs to something still running. */
function isAlive(pid) {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return err.code === 'EPERM';
  }
}

function claimDirectory(dataDir) {
  const lock = path.join(dataDir, OWNER_FILE);

  if (fs.existsSync(lock)) {
    const holder = Number(String(fs.readFileSync(lock, 'utf8')).split('\n')[0]);
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isAlive(holder)) {
      throw Object.assign(
        new Error(
          `Process ${holder} is already using the database at ${dataDir}. ` +
            'Two processes writing to one PGlite database corrupt it beyond repair, so this one ' +
            'is stopping before it starts. Stop the other one, or set DATA_DIR to somewhere else.',
        ),
        { code: 'database_in_use' },
      );
    }
    // The holder is gone, so its lock is not evidence of anything.
  }

  fs.writeFileSync(lock, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');

  return () => {
    try {
      const holder = Number(String(fs.readFileSync(lock, 'utf8')).split('\n')[0]);
      if (holder === process.pid) fs.rmSync(lock, { force: true });
    } catch {
      // Already gone, or unreadable. Either way there is nothing to release.
    }
  };
}

/**
 * Clear a lock left by an unclean shutdown, or explain why it will not.
 *
 * @returns whether a stale lock was removed
 */
async function clearStaleLock(pgdata, port) {
  const lock = path.join(pgdata, LOCK_FILE);
  if (!fs.existsSync(lock)) return false;

  if (await portIsBusy(port)) {
    throw Object.assign(
      new Error(
        `Another copy of Synapsez is already running on port ${port} and using ${pgdata}. ` +
          'Two processes writing to one database will damage it, so this one is stopping. ' +
          'Close the other one — or set PORT and DATA_DIR to run a second instance properly.',
      ),
      { code: 'already_running' },
    );
  }

  fs.rmSync(lock, { force: true });
  console.log(`\n  Cleared a database lock left by an unclean shutdown (${LOCK_FILE}).`);
  return true;
}

export async function createPgliteStore(dataDir) {
  /**
   * The database, loaded on demand.
   *
   * Dynamic so a serverless deployment never traces it into the bundle — it is
   * 25MB and that branch is never taken there. But dynamic also means a missing
   * install shows up here, at first request, as a bare `ERR_MODULE_NOT_FOUND`
   * naming a package the reader has no reason to have heard of. Anybody who ran
   * `npm install --omit=dev` got exactly that and nothing else.
   */
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new Error(
      'The local database is not installed. Run `npm install` in this folder — ' +
        '@electric-sql/pglite is what Synapsez stores everything in when there is no DATABASE_URL. ' +
        'If you installed with --omit=dev or --production, install again without it.',
    );
  }

  // PGlite creates its own directory but not the parents, so make the data
  // folder itself first — on a fresh clone nothing above it exists yet.
  fs.mkdirSync(dataDir, { recursive: true });
  const pgdata = path.join(dataDir, 'pgdata');
  const port = Number(process.env.PORT) || 5173;

  // Before anything is opened, let alone written.
  const release = claimDirectory(dataDir);
  await clearStaleLock(pgdata, port);

  let db;
  try {
    db = await PGlite.create(pgdata);
  } catch (err) {
    /**
     * Second chance, and only one.
     *
     * The lock check above catches the ordinary case before Postgres ever
     * starts. This catches the rest: a lock written between the check and the
     * start, or a refusal for a reason the file does not show. Retrying once
     * with the lock cleared turns a crash into a start; retrying forever would
     * turn a real problem into a loop.
     */
    if (!fs.existsSync(path.join(pgdata, LOCK_FILE))) {
      release();
      throw databaseFailure(err, pgdata);
    }
    fs.rmSync(path.join(pgdata, LOCK_FILE), { force: true });
    console.log(`\n  Cleared a database lock and retried (${LOCK_FILE}).`);
    try {
      db = await PGlite.create(pgdata);
    } catch (again) {
      release();
      throw databaseFailure(again, pgdata);
    }
  }

  // Neon's HTTP driver resolves to rows; PGlite resolves to { rows }.
  const store = createPgStore({
    async query(text, params = []) {
      const result = await db.query(text, params);
      return result.rows;
    },
  });

  /**
   * Put the lock away on the way out.
   *
   * The whole problem above exists because the previous run did not get to do
   * this. `close()` shuts Postgres down properly, which removes the file — so
   * the next start has nothing to clean up and nothing to explain.
   */
  const shutdown = async () => {
    try {
      await db.close();
    } catch {
      // A database that will not close cleanly is a database the next start
      // will unlock by hand. Nothing here is worth blocking an exit for.
    } finally {
      release();
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      shutdown().finally(() => process.exit(0));
    });
  }
  process.once('beforeExit', shutdown);

  // `local` tells the tool layer this is the owner's own machine, so the admin
  // account can use the filesystem and shell without running a separate worker.
  return { ...store, kind: 'pglite (local file)', local: true, close: shutdown };
}

/**
 * What went wrong with the database, in one line.
 *
 * PGlite's failures arrive as a WebAssembly abort with the entire minified
 * runtime attached — tens of thousands of characters of somebody else's code,
 * ending in `Aborted()`. None of it is actionable and all of it is printed.
 */
function databaseFailure(error, pgdata) {
  const raw = String(error?.message || error);
  const aborted = /Aborted\(\)|RuntimeError/.test(raw);
  return Object.assign(
    new Error(
      aborted
        ? `The local database at ${pgdata} would not start. ` +
          'That usually means it was left locked or a file in it is damaged. ' +
          'If nothing else is running, moving that folder aside starts a fresh one — ' +
          'it holds your accounts and conversations, so keep the copy.'
        : `The local database at ${pgdata} would not start: ${raw.slice(0, 300)}`,
    ),
    { code: 'database_unavailable', cause: error },
  );
}
