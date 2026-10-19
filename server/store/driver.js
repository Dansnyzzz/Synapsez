import { log } from '../util/trace.js';

/**
 * Which way this app talks to its database (2026-10-19).
 *
 * Neon is reached over its own HTTP driver, which needs no connection at all —
 * right for a serverless function. Any other Postgres, Supabase first among
 * them, is reached through a regular connection pool. The free Neon project ran
 * out of compute hours (HTTP 402) because an idle worker kept it awake; Supabase's
 * free compute has no hour quota, so the app moved there, and both stay possible.
 *
 * Every driver here answers `query(text, params)` with the rows, and `transaction(
 * [query, …])` all-or-nothing — the shape `createPgStore` has always used.
 *
 * @typedef {{ query: (text: string, params?: any[]) => any, transaction?: (queries: any[]) => Promise<any[]>, end?: () => any }} Driver
 */

/** Whether a connection string names a Neon database. */
export function isNeonUrl(url) {
  try {
    return /(^|\.)neon\.tech$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/**
 * The pool's settings, from the connection string and the environment.
 *
 * **TLS is always on** off this machine, and verified when the database's own
 * certificate authority is given: Supabase signs its certificates with a CA of
 * its own (Database settings → SSL Configuration → Download certificate), which
 * goes in `DATABASE_CA_CERT`. Without it the connection is encrypted but the
 * server is not proven to be Supabase — said once in the log, not hidden.
 *
 * `sslmode` is taken out of the string and decided here: node-postgres lets the
 * string override an explicit `ssl`, and reads `require` as full verification,
 * which a Supabase certificate fails without its CA.
 *
 * **One connection per instance**, as Supabase asks of serverless functions:
 * its transaction pooler (port 6543) multiplexes them, and each function
 * instance holding a handful would spend the pooler's limit on idle sockets.
 *
 * @param {string} url
 * @param {Record<string, string|undefined>} [env]
 */
export function poolOptions(url, env = process.env) {
  const parsed = new URL(String(url));
  const mode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) parsed.searchParams.delete(key);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  const ca = String(env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim();
  /** @type {false | { ca?: string, rejectUnauthorized: boolean }} */
  const ssl =
    mode === 'disable' || (local && !mode)
      ? false
      : ca
        ? { ca, rejectUnauthorized: true }
        : { rejectUnauthorized: false };
  return {
    connectionString: parsed.toString(),
    ssl,
    max: Math.max(1, Number(env.DATABASE_POOL_MAX) || 1),
    // Short, so a function instance that goes quiet lets its connection go
    // rather than leaving a socket the pooler will cut under it.
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10_000,
  };
}

/**
 * A node-postgres pool, in the shape the store speaks.
 *
 * `query` is lazy — it starts when awaited — because `transaction([query(a),
 * query(b)])` is handed the queries *before* they run, exactly as Neon's driver
 * is; an eager one would have run both outside the transaction it was meant
 * for. A transaction takes one connection for itself: through a pool,
 * `BEGIN` and `COMMIT` sent separately could land on two different ones.
 *
 * @param {{ query: Function, connect: Function, end?: Function }} pool
 */
export function pgDriver(pool) {
  const query = (text, params = []) => {
    /** @type {Promise<any[]>|null} */
    let started = null;
    const start = () => (started ??= pool.query(text, params).then((result) => result.rows));
    return {
      text,
      params,
      then: (ok, fail) => start().then(ok, fail),
      catch: (fail) => start().catch(fail),
      finally: (done) => start().finally(done),
    };
  };

  async function transaction(queries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = [];
      for (const each of queries) out.push((await client.query(each.text, each.params)).rows);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { query, transaction, end: () => pool.end?.() };
}

let warnedUnverified = false;

/**
 * The driver for this connection string.
 *
 * `DATABASE_DRIVER=neon|pg` settles it by hand; otherwise a Neon host takes
 * Neon's driver and anything else a pool.
 *
 * @param {string} url
 * @param {{ env?: Record<string, string|undefined> }} [options]
 * @returns {Promise<Driver>}
 */
export async function openDatabase(url, { env = process.env } = {}) {
  const forced = String(env.DATABASE_DRIVER || '').toLowerCase();
  if (forced === 'neon' || (forced !== 'pg' && isNeonUrl(url))) {
    const { neon } = await import('@neondatabase/serverless');
    return neon(url);
  }

  const { default: pg } = await import('pg');
  const options = poolOptions(url, env);
  const pool = new pg.Pool(options);
  // An idle connection the pooler closes must not take the process with it:
  // node-postgres emits this on the pool, and unheard it is an uncaught error.
  pool.on('error', (err) => log.warn('database connection dropped', { error: String(err?.message || err).slice(0, 200) }));
  if (env.VERCEL) {
    // Keeps a function instance alive just long enough to close idle
    // connections before it is frozen, instead of leaving them to go stale.
    const { attachDatabasePool } = await import('@vercel/functions');
    attachDatabasePool(pool);
  }
  if (options.ssl && !options.ssl.rejectUnauthorized && !warnedUnverified) {
    warnedUnverified = true;
    log.warn('database TLS is encrypted but not verified — set DATABASE_CA_CERT to the provider\'s CA certificate');
  }
  return pgDriver(pool);
}
