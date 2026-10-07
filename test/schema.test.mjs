/**
 * Upgrading a database that already exists.
 *
 * This suite exists because of a bug that no other suite could have caught.
 * `schema.sql` is only applied when the stored `schema_version` differs from
 * the one in the code — so adding a table or a column without bumping that
 * number does exactly nothing on a database that has been in use, while every
 * test carries on passing, because every test starts from an empty folder where
 * the DDL runs regardless.
 *
 * The result was a working app on a fresh clone and `column "project_id" of
 * relation "chats" does not exist` on the machine that had been running it for
 * a week. So: create a database, put it back to an older version with the new
 * things removed, open it again, and check the upgrade happens.
 *
 *   node test/schema.test.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

const DATA_DIR = path.join(os.tmpdir(), `ai-remote-schema-test-${process.pid}`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { createPgStore } = await import('../server/store/pg.js');

const db = await PGlite.create(path.join(DATA_DIR, 'pgdata'));
const driver = {
  async query(text, params = []) {
    return (await db.query(text, params)).rows;
  },
};

const columnExists = async (table, column) =>
  (
    await driver.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, column],
    )
  ).length > 0;

const tableExists = async (table) =>
  (await driver.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table])).length > 0;

section('a fresh database gets everything');
{
  await createPgStore(driver).init();
  check('the projects table is there', await tableExists('projects'));
  check('and its files', await tableExists('project_files'));
  check('and chats know their project', await columnExists('chats', 'project_id'));
  check('and the document index', await tableExists('doc_chunks'));

  check('and the MCP server table', await tableExists('mcp_servers'));
  check('and workflows', await tableExists('workflows'));
  check('and the runs that keep their position', await tableExists('workflow_runs'));
  check('which is the whole point of them', await columnExists('workflow_runs', 'cursor'));
  // The real output cap, so a request stops asking every model for 32000 tokens
  // it may not be able to produce.
  check('and shared models record their output cap', await columnExists('shared_models', 'max_output'));

  const stamped = await driver.query("SELECT value FROM settings WHERE key = 'schema_version'");
  check('and the version is stamped', Number(stamped[0]?.value) > 0, `${stamped[0]?.value}`);
}

section('the newest tables reach a database that predates them');
{
  /**
   * The failure this file exists for, exercised on the two most recent additions.
   *
   * `mcp_servers` and `shared_models.max_output` are the things added last, so
   * they are the ones most likely to have been added to schema.sql without the
   * version being bumped — in which case every machine that has been running the
   * app for a while gets a missing table and a query that fails, while every test
   * passes because tests start from an empty folder.
   */
  await driver.query('DROP TABLE IF EXISTS workflow_runs');
  await driver.query('DROP TABLE IF EXISTS workflows');
  await driver.query('DROP TABLE IF EXISTS mcp_servers');
  await driver.query('ALTER TABLE shared_models DROP COLUMN IF EXISTS max_output');
  await driver.query("UPDATE settings SET value = '1' WHERE key = 'schema_version'");

  check('they really are gone first', !(await tableExists('mcp_servers')), 'otherwise this proves nothing');
  check('the workflow tables too', !(await tableExists('workflows')), 'otherwise this proves nothing');

  await createPgStore(driver).init();
  check('opening it creates mcp_servers', await tableExists('mcp_servers'));
  check('and adds max_output back', await columnExists('shared_models', 'max_output'));
  // The newest addition, and therefore the one most likely to have been written
  // into schema.sql with the version left alone.
  check('and the workflow tables arrive', await tableExists('workflows') && await tableExists('workflow_runs'));

  // Per account, or one person could choose what another person's turn executes.
  check('MCP servers belong to an account', await columnExists('mcp_servers', 'user_id'));
}

section('a database from an earlier release is brought up to date');
{
  // Wind it back: an older stamp, and the newest things gone. This is the state
  // of a machine that was running the app before those were written.
  await driver.query('ALTER TABLE chats DROP COLUMN IF EXISTS project_id');
  // A release from before projects existed has nothing pointing at them, which
  // is also what lets the table go: the reference from `scheduled_tasks`
  // (schema 20) would otherwise refuse the drop below.
  await driver.query('ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS project_id');
  await driver.query('DROP TABLE IF EXISTS project_files');
  await driver.query('DROP TABLE IF EXISTS projects');
  await driver.query('DROP TABLE IF EXISTS doc_chunks');
  await driver.query("UPDATE settings SET value = '1' WHERE key = 'schema_version'");

  check('the column really is gone first', !(await columnExists('chats', 'project_id')), 'otherwise this proves nothing');

  // A second store, because the first memoised the fact that it had run.
  await createPgStore(driver).init();

  check('opening it adds the missing tables', await tableExists('projects'));
  check('and the missing column', await columnExists('chats', 'project_id'));
  check('and the document index', await tableExists('doc_chunks'));
}

section('the columns the usage ledger writes to actually arrive');
{
  /*
   * The exact failure, reproduced. `recordUsage` writes nine columns, and two of
   * them were added to schema.sql at a version that was never bumped — so a
   * database in use skipped the ALTER and every call came back
   * `column "cache_read_tokens" does not exist`. On a shared-key deployment that
   * is not a cosmetic error: usage is what the monthly limit is enforced against,
   * so the write failing means the quota stops counting.
   *
   * Checked by writing a real row rather than by looking the columns up, because
   * the INSERT is what actually broke and a column list can be right while the
   * statement is still wrong.
   */
  await driver.query('ALTER TABLE usage_events DROP COLUMN IF EXISTS cache_read_tokens');
  await driver.query('ALTER TABLE usage_events DROP COLUMN IF EXISTS role');
  await driver.query('DROP INDEX IF EXISTS doc_chunks_search_idx');
  await driver.query("UPDATE settings SET value = '14' WHERE key = 'schema_version'");

  check(
    'they really are gone first',
    !(await columnExists('usage_events', 'cache_read_tokens')),
    'otherwise this proves nothing',
  );

  const store = createPgStore(driver);
  await store.init();

  check('the cached-token column arrives', await columnExists('usage_events', 'cache_read_tokens'));
  check('and the role column', await columnExists('usage_events', 'role'));

  await driver.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ('u-ledger', 'l@x.test', 'x', 'user')
     ON CONFLICT (id) DO NOTHING`,
  );
  let wrote = null;
  try {
    await store.recordUsage('u-ledger', {
      id: 'usage-after-upgrade',
      chatId: null,
      model: 'test/model',
      role: 'compaction',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 90,
      costUsd: 0.001,
    });
    wrote = 'ok';
  } catch (err) {
    wrote = String(err?.message || err);
  }
  check('and a real usage row can be written', wrote === 'ok', wrote);

  const back = await driver.query("SELECT role, cache_read_tokens FROM usage_events WHERE id = 'usage-after-upgrade'");
  check('with both new fields intact', back[0]?.role === 'compaction' && Number(back[0]?.cache_read_tokens) === 90, JSON.stringify(back[0]));
}

/*
 * The guard the section below could not be.
 *
 * "The stamp is what decides" states the risk exactly, and it still could not
 * catch the bug it describes — because it has no way of knowing what schema.sql
 * has newly *gained*. Three statements were added for cached-token accounting
 * and the version was left at 14, so every database already in use skipped them
 * and `recordUsage` wrote to columns that did not exist. Every suite passed:
 * they all start from an empty folder, where the DDL runs whatever the stamp
 * says.
 *
 * So the invariant is asserted directly rather than by example. If schema.sql
 * changes, its fingerprint changes, and this fails until the version is bumped
 * and the pair below is updated. That is a deliberate two-line chore on every
 * schema change, and it is a great deal cheaper than the alternative — which is
 * an app that works on a fresh clone and is broken on every machine that has
 * been running it.
 */
section('schema.sql and SCHEMA_VERSION move together');
{
  const { SCHEMA_VERSION } = await import('../server/store/pg.js');

  // Line endings are normalised because this repo is edited on Windows and read
  // by CI on Linux, and a hash that differs by platform is a hash nobody trusts.
  const source = fs
    .readFileSync(path.join(import.meta.dirname, '..', 'server', 'store', 'schema.sql'), 'utf8')
    .replace(/\r\n/g, '\n');
  const fingerprint = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16);

  /** Update BOTH of these, together, whenever schema.sql changes. */
  // 21: chats.archived_at/.unread/.chat_group — a conversation filed under a
  // project can be put away, flagged as unfinished, or gathered under a name.
  // The failure message suggests the next number up because it assumes the
  // version was not bumped; it was, in the same change as the schema, so 21 is
  // the version that owns this file.
  // 28: chats.incognito and audit_events.
  const STAMPED = { version: 30, fingerprint: '87c3bac337e4d906' };

  check(
    'the recorded version matches the code',
    SCHEMA_VERSION === STAMPED.version,
    `code says ${SCHEMA_VERSION}, this test expects ${STAMPED.version}`,
  );
  check(
    'schema.sql has not changed without the version being bumped',
    fingerprint === STAMPED.fingerprint,
    fingerprint === STAMPED.fingerprint
      ? fingerprint
      : `schema.sql is now ${fingerprint}. Bump SCHEMA_VERSION in server/store/pg.js and set ` +
        `STAMPED here to { version: ${SCHEMA_VERSION + 1}, fingerprint: '${fingerprint}' }. ` +
        'Without the bump, every database already in use skips your change.',
  );
}

section('a step screenshot leaves the Files shelf (schema 30)');
{
  const store = createPgStore(driver);
  await store.init();
  await store.createUser({ id: 'u-step', email: 'step@example.com', name: 'Step', passwordHash: 'x', role: 'user' });
  const add = (id, extra) => store.createAttachment('u-step', { id, mime: 'image/jpeg', kind: 'image', bytes: 3, data: 'AAA', ...extra });
  // What `keepStepShot` wrote before 30, and four things that only look like it.
  await add('shot-old', { name: 'step-1791129697458.jpg', origin: 'generated' });
  await add('made-in-chat', { name: 'step-1791129697459.jpg', origin: 'generated', chatId: 'c-made' });
  await add('made-from-source', { name: 'step-1791129697460.jpg', origin: 'generated', source: 'drawn' });
  await add('uploaded', { name: 'step-1791129697461.jpg' });
  await add('picture', { name: 'chart.png', mime: 'image/png', origin: 'generated' });
  // As a database that had not reached 30 yet.
  await driver.query(`UPDATE settings SET value = '29'::jsonb WHERE key = 'schema_version'`);
  await createPgStore(driver).init();
  const origins = Object.fromEntries(
    (await driver.query(`SELECT id, origin FROM attachments WHERE user_id = 'u-step'`)).map((r) => [r.id, r.origin]),
  );
  check('a step screenshot stored as made is moved to an origin of its own', origins['shot-old'] === 'step', JSON.stringify(origins));
  check(
    '  and nothing that only looks like one is',
    origins['made-in-chat'] === 'generated' && origins['made-from-source'] === 'generated' && origins.uploaded === 'upload' && origins.picture === 'generated',
    JSON.stringify(origins),
  );
  const shelf = (await store.listAllGeneratedFiles('u-step')).map((f) => f.id);
  check('  so the Files shelf lists what was made, not the screenshot', !shelf.includes('shot-old') && shelf.includes('picture'), shelf.join(','));

  // Nothing else would ever delete one with no conversation: the daily sweep
  // takes it after a month, and leaves a newer one and everything else.
  await add('shot-recent', { name: 'step-1791129697470.jpg', origin: 'step' });
  await driver.query(`UPDATE attachments SET created_at = NOW() - INTERVAL '40 days' WHERE id IN ('shot-old', 'picture')`);
  await store.pruneOrphanAttachments();
  const left = (await driver.query(`SELECT id FROM attachments WHERE user_id = 'u-step'`)).map((r) => r.id);
  check('an orphaned step screenshot older than a month is swept', !left.includes('shot-old'), left.join(','));
  check('  a newer one and a file somebody made are not', left.includes('shot-recent') && left.includes('picture'), left.join(','));
}

section('and the stamp is what decides');
{
  // The failure this all guards against, stated directly: with the stamp left
  // at the current version, nothing runs. That is the behaviour — and the
  // reason the number has to be bumped by hand whenever schema.sql changes.
  await driver.query('ALTER TABLE chats DROP COLUMN IF EXISTS project_id');
  await createPgStore(driver).init();
  check(
    'an up-to-date stamp skips the DDL entirely',
    !(await columnExists('chats', 'project_id')),
    'so adding to schema.sql without bumping SCHEMA_VERSION does nothing on an existing database',
  );
}

await db.close();

/*
 * A replay that fails half way leaves nothing behind.
 *
 * The driver-object path (PGlite, and every test) ran schema.sql statement by
 * statement with no transaction, so a failure part way through left a schema
 * matching no version of the code. Driven here by a driver that fails on one
 * statement well into the file.
 */
section('a failed schema replay is all or nothing');
{
  const scratch = await PGlite.create();
  let seen = 0;
  const failing = {
    async query(text, params = []) {
      if (/^(CREATE|ALTER)/i.test(text.trimStart())) {
        seen += 1;
        if (seen === 30) throw new Error('simulated failure part way through the schema');
      }
      return (await scratch.query(text, params)).rows;
    },
  };
  let threw = false;
  try {
    await createPgStore(failing).init();
  } catch {
    threw = true;
  }
  const users = (await scratch.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`)).rows.length > 0;
  check('the replay reports the failure', threw);
  check('  and the statements before it were rolled back', !users, users ? 'users table exists after a failed replay' : '');
  await scratch.close();
}

/**
 * One process at a time.
 *
 * PGlite has no cross-process locking. Two processes on one folder both write,
 * and the write-ahead log ends up with a checkpoint neither can read — a
 * database that will not start and that PGlite ships no tool to repair. This
 * suite exists because that happened: a script opened the live data directory
 * while the app was running, and the conversations in it were gone.
 */
section('two processes cannot open the same database');
{
  const { spawn } = await import('node:child_process');
  const { createPgliteStore } = await import('../server/store/pglite.js');

  const dir = `${DATA_DIR}-lock`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // A real process that is really alive, because the check is `kill(pid, 0)`
  // and a made-up number would prove nothing.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.writeFileSync(`${dir}/owner.pid`, `${holder.pid}\n${new Date().toISOString()}\n`);

  let refused = null;
  await createPgliteStore(dir).catch((err) => (refused = err));
  check('a second process is turned away', refused?.code === 'database_in_use', refused?.message?.slice(0, 70));
  check('before it has written anything', !fs.existsSync(`${dir}/pgdata`), 'the claim is made before Postgres starts');
  check('and it names the process holding it', String(refused?.message).includes(String(holder.pid)));

  holder.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The lock is a claim, not a gravestone: once the holder is gone it means
  // nothing, or every crash would need a manual cleanup.
  const store = await createPgliteStore(dir);
  check('a lock from a process that died is ignored', !!store, 'otherwise every crash needs a human');
  check('and the new owner takes it', fs.readFileSync(`${dir}/owner.pid`, 'utf8').startsWith(String(process.pid)));

  await store.close();
  check('closing releases it', !fs.existsSync(`${dir}/owner.pid`));

  // After a PGlite close, so through the retrying helper: see test/lib/tmp.mjs.
  removeTemp(dir);
}

// ── what version 17 added ─────────────────────────────────────────────
{
  const db = await PGlite.create();
  const driver = { async query(text, params) { return (await db.query(text, params)).rows; } };
  const store = createPgStore(driver);
  await store.init();

  const names = (await driver.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
  )).map((r) => r.indexname);

  // Four predicates that were scanning whole tables. The two `created_at` ones
  // matter most: the sweep pruners filter on that column alone, from the cron
  // route, inside the 300s ceiling, on tables that only grow — and every index
  // that covered them led with user_id, which a query cannot skip past.
  for (const idx of [
    'usage_events_created_idx',
    'attachments_created_idx',
    'shared_models_provider_idx',
    'tool_jobs_device_idx',
    'pairings_code_unclaimed_idx',
  ]) {
    check(`index exists: ${idx}`, names.includes(idx));
  }

  // The uniqueness has to actually bite, or it is decoration. Two live
  // unclaimed rows sharing a code is what let the installer name the wrong
  // account, and that is the one thing a confirmation prompt must get right.
  const add = (id, hash, claimedAt) =>
    driver.query(
      `INSERT INTO pairings (id, code_hash, device_name, expires_at, claimed_at)
            VALUES ($1, $2, 'pc', NOW() + INTERVAL '10 min', $3)`,
      [id, hash, claimedAt],
    );

  await add('pair-1', 'HASH-A', null);
  let refused = false;
  try { await add('pair-2', 'HASH-A', null); } catch (err) { refused = /unique/i.test(err.message); }
  check('a second unclaimed pairing cannot reuse a live code', refused);

  // Partial on purpose: a claimed code is spent, and a full unique index would
  // also collide with expired rows the pruner has not swept yet.
  let claimedAllowed = true;
  try { await add('pair-3', 'HASH-A', new Date().toISOString()); } catch { claimedAllowed = false; }
  check('but a claimed one may, because the index is partial', claimedAllowed);

  await db.close();
}

// ── the statement splitter ────────────────────────────────────────────
{
  const { splitStatements } = await import('../server/store/pg.js');

  // Dollar-quoting is the one that matters. It is how every conditional
  // backfill is written, and without it the semicolons *inside* the block split
  // it into fragments that each fail as a syntax error in perfectly good SQL.
  // The splitter's own header used to warn about this and leave it unhandled,
  // which made it something the next person to write a migration would discover
  // the hard way.
  const cases = [
    ['two plain statements', 'CREATE TABLE a (id int); CREATE TABLE b (id int);', 2],
    ['a trailing semicolon is optional', 'SELECT 1', 1],
    ['a line comment cannot split', 'SELECT 1; -- a; b; c\nSELECT 2;', 2],
    ['a semicolon inside a string cannot split', "INSERT INTO t VALUES ('a;b');", 1],
    ['nor one after an escaped quote', "INSERT INTO t VALUES ('it''s; fine');", 1],
    ['a DO block stays whole', 'DO $$ BEGIN IF TRUE THEN UPDATE t SET x=1; END IF; END $$;', 1],
    ['a tagged block stays whole', 'DO $body$ BEGIN a; b; END $body$; SELECT 1;', 2],
    ['a different tag does not terminate it', 'DO $a$ SELECT $$x;y$$; $a$;', 1],
    ['a block comment cannot split', 'SELECT 1; /* a; b; c */ SELECT 2;', 2],
    ['nor a nested one', 'SELECT 1; /* a /* b; */ c; */ SELECT 2;', 2],
  ];
  for (const [what, sql, want] of cases) {
    const got = splitStatements(sql);
    check(what, got.length === want, `want ${want}, got ${got.length}: ${JSON.stringify(got).slice(0, 90)}`);
  }

  // The real file must still come apart the way it always did.
  const schemaPath = new URL('../server/store/schema.sql', import.meta.url);
  const real = splitStatements(fs.readFileSync(schemaPath, 'utf8'));
  check('schema.sql parses into statements', real.length > 50, String(real.length));
  check(
    'and every one of them starts with a keyword',
    real.every((s) => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|DO|COMMENT|SET|GRANT|WITH|SELECT)/i.test(s)),
    real.find((s) => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|DO|COMMENT|SET|GRANT|WITH|SELECT)/i.test(s))?.slice(0, 60),
  );
  check('with no comment marker left in any of them', !real.some((s) => s.includes('--') || s.includes('/*')));
}

removeTemp(DATA_DIR);
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll schema checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
