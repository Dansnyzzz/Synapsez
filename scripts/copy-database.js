#!/usr/bin/env node
/**
 * Copy everything from one Postgres to another — Neon to Supabase (2026-10-19).
 *
 *   npm run db:copy -- --from "<the old DATABASE_URL>" --to "<the new one>"
 *
 * The target is given this app's schema first — the same set-up every boot
 * runs — and then every table is copied in foreign-key order, a page at a time.
 * A row the target already has is left as it is, so running it twice is safe
 * and a copy cut short can simply be run again. Nothing in the source changes.
 * An account the target already has under the same email takes the old
 * account's rows rather than gaining a twin — but only for an email the owner
 * names with `--merge a@x,b@y` (SEC-057); see `merged` below. A merged account's
 * stored credentials are sealed to its id (crypto.js v2), so they are opened and sealed
 * again under the id they join — which needs the deployment's ENCRYPTION_KEY in the
 * environment; without it they are copied as they are, and said.
 *
 * Needs both databases reachable: a Neon project whose compute hours have run
 * out answers 402 until its next billing period, or until it is upgraded.
 *
 * Run it twice when the target deployment is live. Rows whose parents arrive
 * later in the order — a deep-research run before its conversation, a file
 * before its project's — can be tidied away by that deployment's hourly sweep
 * as orphans in between (pruneResearchRuns, pruneUnreachableFiles); the second
 * run copies them again, and nothing else twice.
 */
import { pathToFileURL } from 'node:url';
import { createPgStore } from '../server/store/pg.js';
import { credentialOwner, rebindRow } from '../server/secretsReseal.js';

/** A name as SQL reads it, quoted, so a table or column is never taken for a keyword. */
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** About this much of a table is fetched at a time — under any driver's response limit. */
const PAGE_BYTES = 6 * 1024 * 1024;
/** And sent back in statements of about this much. */
const INSERT_BYTES = 2 * 1024 * 1024;
/** Postgres takes at most 65,535 parameters in one statement. */
const MAX_PARAMS = 30_000;

/**
 * Tables in an order where every row's parent is copied before it.
 *
 * @param {string[]} tables
 * @param {{ child: string, parent: string }[]} links
 * @returns {{ order: string[], cycle: string[] }}
 */
export function foreignKeyOrder(tables, links) {
  const waiting = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of links) {
    if (child !== parent && waiting.has(child) && waiting.has(parent)) waiting.get(child).add(parent);
  }
  const order = [];
  for (;;) {
    const ready = [...waiting].filter(([, parents]) => parents.size === 0).map(([t]) => t).sort();
    if (!ready.length) break;
    for (const t of ready) {
      order.push(t);
      waiting.delete(t);
      for (const parents of waiting.values()) parents.delete(t);
    }
  }
  const cycle = [...waiting.keys()].sort();
  return { order: [...order, ...cycle], cycle };
}

/** An email as both databases are compared by it. */
const emailKey = (email) => String(email ?? '').trim().toLowerCase();

/** Why the copy stopped at accounts nobody vouched for, and the command that goes on. */
function mergeRefusal(emails) {
  const list = [...new Set(emails)].sort();
  return (
    `${list.length} account(s) in the old database already exist on the new one under the same email: ${list.join(', ')}. ` +
    'Signing up does not prove an email, so an account there may belong to someone else. ' +
    'Check each one is the same person (sign in to it, or look at when it was made), then run again with ' +
    `--merge ${list.join(',')} — nothing has been copied yet.`
  );
}

/** A value as a parameter: JSON columns go as JSON text, since an array would otherwise be sent as a Postgres array. */
const asParam = (value, type) => (value != null && (type === 'json' || type === 'jsonb') ? JSON.stringify(value) : value);

const sizeOf = (row) => {
  let n = 0;
  for (const v of Object.values(row)) n += v == null ? 1 : typeof v === 'string' ? v.length : Buffer.isBuffer(v) ? v.length : JSON.stringify(v)?.length || 8;
  return n;
};

/**
 * @param {{ query: Function }} from  a driver: `query(text, params)` → rows
 * @param {{ query: Function }} to
 * @param {{ say?: (line: string) => void, merge?: Iterable<string> }} [options]
 *   `merge`: the emails whose old account may join the target's account of the same email
 * @returns {Promise<Record<string, number>>} rows copied per table
 */
export async function copyDatabase(from, to, { say = console.log, merge = [] } = {}) {
  await createPgStore(to).init();
  const vouched = new Set([...merge].map(emailKey));

  const tablesOf = async (db) =>
    (
      await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).map((r) => r.table_name);
  const columnsOf = async (db) => {
    const rows = await db.query(
      `SELECT table_name, column_name, data_type, is_generated FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map();
    for (const r of rows) {
      if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Map());
      if (r.is_generated !== 'ALWAYS') byTable.get(r.table_name).set(r.column_name, r.data_type);
    }
    return byTable;
  };

  const sourceTables = await tablesOf(from);
  const targetTables = new Set(await tablesOf(to));
  const links = await from.query(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  const strip = (name) => String(name).replace(/^public\./, '').replace(/^"|"$/g, '');
  const { order, cycle } = foreignKeyOrder(
    sourceTables,
    links.map((l) => ({ child: strip(l.child), parent: strip(l.parent) })),
  );
  if (cycle.length) say(`  Tables that refer to each other, copied last: ${cycle.join(', ')}`);

  const sourceColumns = await columnsOf(from);
  const targetColumns = await columnsOf(to);
  /** @type {Record<string, number>} */
  const copied = {};

  /*
   * An account already on the target under the same email — somebody signed up
   * on the new database before the old one could be copied (owner, 2026-10-20).
   * The old account is not added beside it; its rows go to the one there, and
   * where both have the same row (a setting under the same name) the target's
   * stays, as everything else already there does.
   *
   * Only for an email the owner named (SEC-057). Signing up does not prove an
   * address, so "the account with this email" on the new database may be
   * whoever registered it first — and a merge would hand them every old
   * conversation, note, key and Google grant. Any other email on both sides
   * stops the copy before a row is written.
   */
  const onTarget = new Map((await to.query('SELECT id, email FROM users')).map((r) => [emailKey(r.email), r.id]));
  /** @type {Map<string, string>} old account id → the account it merges into */
  const merged = new Map();
  const unvouched = [];
  for (const r of await from.query('SELECT id, email FROM users')) {
    const there = onTarget.get(emailKey(r.email));
    if (!there || there === r.id) continue;
    if (!vouched.has(emailKey(r.email))) {
      unvouched.push(emailKey(r.email));
      continue;
    }
    merged.set(r.id, there);
    say(`  ${r.email}: merged into the account that already has this email`);
  }
  if (unvouched.length) throw new Error(mergeRefusal(unvouched));
  /** Columns that hold an account's id: every foreign key to `users`, and any `user_id`. */
  const accountColumns = new Map();
  const holds = (table, column) => {
    if (!accountColumns.has(table)) accountColumns.set(table, new Set());
    accountColumns.get(table).add(column);
  };
  if (merged.size) {
    for (const r of await from.query(
      `SELECT cl.relname AS table_name, att.attname AS column_name
         FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid
         JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass`,
    )) {
      holds(r.table_name, r.column_name);
    }
    for (const [table, cols] of sourceColumns) if (cols.has('user_id')) holds(table, 'user_id');
  }
  /** Credentials of merged accounts: re-bound to the id they join, or left as they were. */
  const rebinding = { rebound: 0, unopenable: 0 };
  /** A row as it goes to the target, its sealed credentials bound to the account it now belongs to. */
  const rebound = (table, row) => {
    const owner = merged.size ? credentialOwner(table, row) : null;
    if (!owner || !merged.has(owner)) return row;
    const moved = rebindRow(table, row, merged.get(owner));
    rebinding.rebound += moved.rebound;
    rebinding.unopenable += moved.unopenable;
    return moved.row;
  };
  /** A value as it goes to the target, an old account's id turned into the one it merged into. */
  const carried = (table, column, value) =>
    merged.size && accountColumns.get(table)?.has(column) && merged.has(value) ? merged.get(value) : value;

  for (const table of order) {
    if (!targetTables.has(table)) {
      say(`  ${table}: skipped — this version of the app has no such table`);
      continue;
    }
    const target = targetColumns.get(table) || new Map();
    const columns = [...(sourceColumns.get(table) || new Map()).keys()].filter((c) => target.has(c));
    if (!columns.length) continue;

    // How many rows make a page, from the table's own size.
    const [stats] = await from.query(
      `SELECT (SELECT count(*) FROM ${ident(table)})::bigint AS n, pg_total_relation_size($1::regclass)::bigint AS bytes`,
      [`public.${ident(table)}`],
    );
    const rowsInTable = Number(stats?.n || 0);
    const average = rowsInTable ? Number(stats.bytes) / rowsInTable : 1;
    const pageRows = Math.max(1, Math.min(500, Math.floor(PAGE_BYTES / Math.max(1, average))));

    const list = columns.map(ident).join(', ');
    let done = 0;
    for (let offset = 0; offset < rowsInTable || offset === 0; offset += pageRows) {
      const rows = await from.query(`SELECT ${list} FROM ${ident(table)} ORDER BY ctid LIMIT $1 OFFSET $2`, [pageRows, offset]);
      if (!rows.length) break;
      // Sent back in statements of a sensible size: many small rows together,
      // a five-megabyte file on its own.
      let batch = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        const params = [];
        const tuples = batch.map((row) => {
          const holes = columns.map((c) => {
            params.push(asParam(carried(table, c, row[c]), target.get(c)));
            return `$${params.length}`;
          });
          return `(${holes.join(', ')})`;
        });
        // Counted by what went in, not by what was sent: a row the target
        // already had is skipped, and saying it was copied would be a claim.
        const inserted = await to.query(
          `INSERT INTO ${ident(table)} (${list}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
          params,
        );
        done += inserted.length;
        batch = [];
        bytes = 0;
      };
      for (const row of rows) {
        // The old account itself is not copied: the one it merged into stands for it.
        if (table === 'users' && merged.has(row.id)) continue;
        const size = sizeOf(row);
        if (batch.length && (bytes + size > INSERT_BYTES || (batch.length + 1) * columns.length > MAX_PARAMS)) await flush();
        batch.push(rebound(table, row));
        bytes += size;
      }
      await flush();
      if (rows.length < pageRows) break;
    }
    copied[table] = done;
    say(`  ${table}: ${done}`);
  }
  if (rebinding.rebound) say(`  ${rebinding.rebound} stored credential(s) of merged accounts sealed again to the account they joined`);
  if (rebinding.unopenable) {
    say(
      `  ${rebinding.unopenable} stored credential(s) of merged accounts could not be opened here, so were copied as they were and will not open: ` +
        'the person enters them again. (A copy run with the deployment\'s ENCRYPTION_KEY in the environment re-binds them; a second run does not, since it skips rows the target has.)',
    );
  }
  return copied;
}

/**
 * `--check`: read both, change neither — whether the old database answers at
 * all, what it holds, and how many of its accounts the new one already has
 * (those merge by email rather than arriving twice). The step to run first,
 * the morning Neon's quota resets (owner, 2026-11-01).
 *
 * @returns {Promise<{ tables: Record<string, number>, accounts: number, merging: number, collisions: string[] }>}
 */
export async function checkCopy(from, to) {
  const tables = (
    await from.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)
  ).map((r) => r.table_name);
  const counts = {};
  for (const table of tables) counts[table] = (await from.query(`SELECT COUNT(*)::int AS n FROM ${ident(table)}`))[0]?.n ?? 0;
  const emails = async (db) => new Set((await db.query('SELECT email FROM users').catch(() => [])).map((r) => emailKey(r.email)));
  const [old, now] = await Promise.all([emails(from), emails(to)]);
  const collisions = [...old].filter((e) => now.has(e)).sort();
  return { tables: counts, accounts: old.size, merging: collisions.length, collisions };
}

/** Why a database would not answer, in words that say what to do — Neon's quota above all. */
export function whyUnreachable(err) {
  const text = String(err?.message || err || '');
  if (/\b402\b|quota|compute time|exceeded the/i.test(text)) {
    return "The old database refuses: Neon's free compute for this period is used up. It answers again when the quota resets (Neon's console shows the date under Billing) or once the project is upgraded.";
  }
  return text;
}

/** `--from x --to y`, or `--from=x`. */
function argument(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fromUrl = argument('from') || process.env.COPY_FROM_URL;
  const toUrl = argument('to') || process.env.COPY_TO_URL;
  if (!fromUrl || !toUrl) {
    console.error('Usage: npm run db:copy -- --from "<old database URL>" --to "<new database URL>" [--check] [--merge a@x,b@y]');
    process.exit(2);
  }
  if (fromUrl === toUrl) {
    console.error('The two addresses are the same database.');
    process.exit(2);
  }
  const { openDatabase } = await import('../server/store/driver.js');
  const from = await openDatabase(fromUrl);
  const to = await openDatabase(toUrl);
  if (process.argv.includes('--check')) {
    console.log(`\n  Checking ${new URL(fromUrl).host} → ${new URL(toUrl).host} (nothing is written)\n`);
    try {
      const { tables, accounts, collisions } = await checkCopy(from, to);
      for (const [table, n] of Object.entries(tables)) console.log(`  ${table}: ${n}`);
      console.log(`\n  ${accounts} account(s) in the old database; ${collisions.length} already on the new one, by email.`);
      if (collisions.length) {
        console.log(`  Those merge only if you name them: ${collisions.join(', ')}`);
        console.log('  Sign-up does not prove an email — check each is the same person first.');
        console.log(`  Then run without --check, adding --merge ${collisions.join(',')}\n`);
      } else console.log('  Run the same command without --check to copy.\n');
    } catch (err) {
      console.error(`\n  Could not read it: ${whyUnreachable(err)}\n`);
      process.exitCode = 1;
    } finally {
      await from.end?.();
      await to.end?.();
    }
    process.exit();
  }
  console.log(`\n  Copying ${new URL(fromUrl).host} → ${new URL(toUrl).host}\n`);
  try {
    const merge = String(argument('merge') || '').split(',').map(emailKey).filter(Boolean);
    const copied = await copyDatabase(from, to, { merge });
    const total = Object.values(copied).reduce((a, b) => a + b, 0);
    console.log(`\n  Done: ${total} rows in ${Object.keys(copied).length} tables.\n`);
  } catch (err) {
    console.error(`\n  Stopped: ${whyUnreachable(err)}\n  Nothing in the source was changed; run it again once the cause is fixed.\n`);
    process.exitCode = 1;
  } finally {
    await from.end?.();
    await to.end?.();
  }
}
