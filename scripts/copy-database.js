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
 * account's rows rather than gaining a twin — see `merged` below.
 *
 * Needs both databases reachable: a Neon project whose compute hours have run
 * out answers 402 until its next billing period, or until it is upgraded.
 */
import { pathToFileURL } from 'node:url';
import { createPgStore } from '../server/store/pg.js';

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
 * @param {{ say?: (line: string) => void }} [options]
 * @returns {Promise<Record<string, number>>} rows copied per table
 */
export async function copyDatabase(from, to, { say = console.log } = {}) {
  await createPgStore(to).init();

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
   */
  const onTarget = new Map(
    (await to.query('SELECT id, email FROM users')).map((r) => [String(r.email).toLowerCase(), r.id]),
  );
  /** @type {Map<string, string>} old account id → the account it merges into */
  const merged = new Map();
  for (const r of await from.query('SELECT id, email FROM users')) {
    const there = onTarget.get(String(r.email).toLowerCase());
    if (there && there !== r.id) {
      merged.set(r.id, there);
      say(`  ${r.email}: merged into the account that already has this email`);
    }
  }
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
        batch.push(row);
        bytes += size;
      }
      await flush();
      if (rows.length < pageRows) break;
    }
    copied[table] = done;
    say(`  ${table}: ${done}`);
  }
  return copied;
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
    console.error('Usage: npm run db:copy -- --from "<old database URL>" --to "<new database URL>"');
    process.exit(2);
  }
  if (fromUrl === toUrl) {
    console.error('The two addresses are the same database.');
    process.exit(2);
  }
  const { openDatabase } = await import('../server/store/driver.js');
  const from = await openDatabase(fromUrl);
  const to = await openDatabase(toUrl);
  console.log(`\n  Copying ${new URL(fromUrl).host} → ${new URL(toUrl).host}\n`);
  try {
    const copied = await copyDatabase(from, to);
    const total = Object.values(copied).reduce((a, b) => a + b, 0);
    console.log(`\n  Done: ${total} rows in ${Object.keys(copied).length} tables.\n`);
  } catch (err) {
    console.error(`\n  Stopped: ${err?.message || err}\n  Nothing in the source was changed; run it again once the cause is fixed.\n`);
    process.exitCode = 1;
  } finally {
    await from.end?.();
    await to.end?.();
  }
}
