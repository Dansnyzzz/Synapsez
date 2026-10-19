import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgStore } from './pg.js';
import { openDatabase } from './driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(here, '../../data');

let store = null;
let pending = null;

/**
 * One store for the whole process, and one shape of it: Postgres.
 *
 * Hosted (`DATABASE_URL` set) uses Supabase — or any Postgres — through a
 * connection pool, or Neon over its HTTP driver (see driver.js); local uses
 * PGlite against a folder on disk. All run the same SQL, so accounts and per-account
 * scoping behave identically on a laptop and on Vercel. There is no second,
 * weaker "single user" mode to reason about — everyone signs in with their own
 * email and password.
 */
/**
 * @param driver  an object with `query(text, params)`, used instead of opening a
 *   connection. The same escape hatch `createPgStore` already has, lifted one
 *   level so a test can drive the *whole app* — routes, middleware and all —
 *   against an in-process Postgres. Nothing in the app passes it.
 */
export async function initStore({ driver } = {}) {
  if (store) return store;
  if (pending) return pending;

  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  pending = (async () => {
    if (driver) {
      store = createPgStore(driver);
    } else if (url) {
      store = createPgStore(await openDatabase(url));
    } else {
      if (process.env.VERCEL) {
        throw new Error(
          'DATABASE_URL is not set. On Vercel the filesystem is ephemeral, so a hosted database is ' +
            "required — create a Supabase project, copy its Transaction pooler string (Connect → port 6543) and set it as DATABASE_URL. See docs/database.md.",
        );
      }
      // Imported here rather than at the top of the file so a deployment never
      // pulls it in: PGlite is a 25MB devDependency that exists for local runs
      // and tests, and a statically-imported module gets traced into the
      // serverless bundle whether or not the branch that needs it is ever taken.
      const { createPgliteStore } = await import('./pglite.js');
      store = await createPgliteStore(process.env.DATA_DIR || DEFAULT_DATA_DIR);
    }
    await store.init();
    return store;
  })();

  /**
   * A failed attempt must not poison the process.
   *
   * `pending` was cached and never cleared, and every request awaits this in
   * middleware — so one transient cold-start failure (Neon waking up, a PGlite
   * data directory momentarily locked) left a rejected promise in place for the
   * life of the instance. Every later request answered 500 with the original
   * error long after the database had recovered, and only a redeploy fixed it.
   *
   * Clearing it on rejection makes the next request retry. `store` is only
   * assigned on the success path, so there is nothing half-built to undo.
   */
  pending = pending.catch((err) => {
    pending = null;
    throw err;
  });

  return pending;
}

/** For code that runs after `initStore()` has resolved — i.e. inside a request. */
export function getStore() {
  if (!store) throw new Error('The database is not ready yet — initStore() must resolve first.');
  return store;
}

export const isServerless = () => !!process.env.VERCEL;
