import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split schema.sql into individual statements.
 *
 * Comments are stripped first: a naive split on ';' breaks the moment a comment
 * contains one, which is exactly the kind of failure that only shows up on a
 * fresh database. Quote state is tracked so a ';' or '--' inside a string
 * literal is left alone.
 *
 * It understands single-quoted strings with `''` escapes, `--` line comments,
 * nested `/* … *\/` block comments, and dollar-quoting — both `$$ … $$` and the
 * tagged `$body$ … $body$`, matched exactly as Postgres matches them.
 *
 * Dollar-quoting is the one that matters, and it used to be missing. It is how
 * every conditional backfill is written —
 *
 *     DO $$ BEGIN IF NOT EXISTS (…) THEN UPDATE …; END IF; END $$;
 *
 * — and without it the semicolons inside the block split it into fragments that
 * each fail as a syntax error in SQL that is perfectly good. Every statement in
 * schema.sql today is still a plain CREATE or ALTER, so nothing has depended on
 * it yet; it is handled now so that the next non-trivial migration is a
 * migration rather than an afternoon.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (inString) {
      current += char;
      // '' is an escaped quote inside a Postgres string literal.
      if (char === "'") inString = sql[i + 1] === "'" ? (current += sql[++i], true) : false;
      continue;
    }

    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }

    /**
     * Dollar-quoting: `$$ … $$` and the tagged `$body$ … $body$`.
     *
     * This is the form every non-trivial migration reaches for, because it is
     * the only way to write a conditional backfill:
     *
     *     DO $$ BEGIN IF NOT EXISTS (…) THEN UPDATE …; END IF; END $$;
     *
     * Without this the semicolons *inside* the block split it into fragments,
     * each of which fails as a syntax error in SQL that is perfectly good. The
     * header comment used to warn about this and leave it unhandled, on the
     * grounds that schema.sql had no such block yet — which made the failure
     * something the next person to write one would discover the hard way.
     *
     * The tag is copied verbatim and matched exactly, which is what Postgres
     * does: `$a$ … $a$` and `$$ … $$` do not terminate each other.
     */
    const dollar = char === '$' ? /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i)) : null;
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      // Unterminated: take the rest verbatim rather than silently splitting it.
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop - 1;
      continue;
    }

    // A line comment runs to the newline.
    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }

    // A block comment. Postgres nests these; so does this.
    if (char === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') (depth += 1, i += 2);
        else if (sql[i] === '*' && sql[i + 1] === '/') (depth -= 1, i += 2);
        else i += 1;
      }
      i -= 1;
      current += ' ';
      continue;
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  statements.push(current);
  return statements.map((s) => s.trim()).filter(Boolean);
}

/**
 * Neon/Postgres store. Uses the HTTP driver, which is what you want on Vercel:
 * no connection pool to leak across serverless invocations.
 *
 * **A trap worth knowing before you touch a `bigint` column here.** The two
 * drivers this file runs on disagree about `int8`. PGlite parses it to a JS
 * **number** (falling back to BigInt only outside the safe range); Neon inherits
 * `pg-types`, whose int8 parser is `String`. So `input_tokens`, `output_tokens`,
 * `messages.seq`, `doc_chunks.mtime`, `shared_models.context` and every
 * `COUNT(*)::bigint` come back as numbers on a laptop and as strings on Vercel.
 *
 * Every read of those today goes through `Number(...)` — deliberately, and it is
 * why this has never bitten. But nothing *enforces* it: the next person to write
 * `row.input_tokens + row.output_tokens` gets 30 locally and "1020" in
 * production, and every test passes, because the suites run on PGlite.
 *
 * There is no honest test for this from here: asserting the coercion on PGlite
 * proves nothing about the driver that behaves differently. So it is written
 * down instead. The rule is simply: coerce at the boundary, always, and keep
 * comparisons on these columns in SQL rather than in JS.
 *
 * Every user-owned query takes `userId` and filters on it. That parameter is
 * the tenancy boundary — it always comes from the verified session, never from
 * anything the client sent.
 */
/**
 * Bumped whenever schema.sql changes. A database already stamped with this
 * value skips the DDL entirely.
 *
 * The statements are all idempotent, so running them was never *wrong* — but
 * on a serverless deployment every cold start paid for thirty HTTP round-trips
 * to discover there was nothing to do. One cheap SELECT answers the same
 * question.
 *
 * **Adding anything to schema.sql without bumping this does nothing at all on
 * a database that already exists**, and nothing catches it: every test starts
 * from an empty folder, where the DDL runs regardless of the stamp. It is
 * only the machine that has been running the app for a while — which is
 * everybody's, eventually — that gets a missing column and a query that
 * fails. `test/schema.test.mjs` exists to make that impossible to miss again.
 *
 *   7  projects, project_files, chats.project_id
 *   8  doc_chunks — the indexed-document store behind search_docs
 *   9  projects.pinned, projects.archived_at
 *  10  attachment_versions — the history behind the version switcher
 *  11  shared_models.max_output — the real output cap, so a request stops
 *      asking every model for 32000 tokens it may not produce
 *  12  mcp_servers — the Model Context Protocol servers an account plugs in,
 *      which is what makes the tool list open rather than fixed
 *  13  devices.browser_mode — added when the browser was choosable per
 *      computer. The choice was removed again and nothing reads the column
 *      now; it is left in place because dropping a column is a migration
 *      that risks data for no gain
 *  14  workflows and workflow_runs — a job with several steps that keeps its
 *      position, so an invocation cut off at the 300s ceiling is resumed
 *      rather than started again from the top
 *  15  usage_events.cache_read_tokens and .role, so cached prompt tokens are
 *      priced at the rate they were billed at and spend that never went
 *      through the agent loop stops being invisible; and
 *      doc_chunks_search_idx, which is the shape the vector search actually
 *      asks for
 *  16  indexes for the queries that were reading whole tables — the four-second
 *      job poll, the four unindexed foreign keys a user deletion cascades
 *      through, the three sweep pruners, both shelf orderings, the pairing code
 *      lookup; plus scheduled_tasks.run_state/lease_until/started_at so a task
 *      cut off mid-run stops for a person instead of repeating every hour, and
 *      chats.run_lock_seq so a resuming run evicts the previous holder of the
 *      lease rather than joining it
 *  17  the four predicates 16 missed — usage_events.created_at and
 *      attachments.created_at, which the sweep pruners filter on alone while
 *      every index over them leads with user_id; shared_models.provider; and
 *      tool_jobs.device_id — plus the unique pairing code that 16 wrote down
 *      as needed and deferred, partial over unclaimed rows and backfilled
 *      first, so an installer can no longer be told the wrong account
 *  18  chats.next_seq, a per-conversation counter that appendMessage bumps, so
 *      two appends at once cannot both number themselves MAX(seq)+1; backfilled
 *      from the messages already there before its default is set. Deliberately
 *      not a unique (chat_id, seq) — that needs existing collisions renumbered,
 *      and renumbering would move the seq a summary's `covers` points at
 *  19  project_files.kind, .attachment_id and .thumb — a source keeps the file
 *      it came from, so the shelf can show it, open it and give it back,
 *      rather than keeping only the text that was read out of it
 *  20  scheduled_tasks.project_id and .policy, and a nullable next_run_at — a
 *      task can belong to a project, can say what it may do unwatched, and can
 *      be manual-only rather than scheduled so far ahead it never fires
 *  21  chats.archived_at, .unread and .chat_group — a conversation filed under
 *      a project can be put away without being destroyed, flagged as not
 *      finished with, and gathered under a name somebody invented
 */
export const SCHEMA_VERSION = 21;

/**
 * How long a run lease may go untouched before another run may take it.
 *
 * Exported because two places have to agree on it and did not: this is what
 * `claimChatRun` treats as dead, while the message-edit route used its own
 * 120s — so between 75s and 120s a conversation could be claimed by a new run
 * and still refuse edits, for no reason anybody could see. One number now.
 */
export const RUN_LEASE_STALE_MS = 75_000;

/**
 * How many earlier drafts of a generated document are kept.
 *
 * Each one is a full copy of the file's bytes, and nothing pruned them, so this
 * was the fastest-growing table in the database. Twenty covers what the history
 * is actually for — going back past a change you regret — without keeping every
 * draft of a document rewritten fifty times.
 */
const KEEP_VERSIONS = 20;

/**
 * The largest a single stored file may be.
 *
 * Defined here because this is the one place every write passes through.
 * `saveGenerated` checked it and the two *rewrite* paths did not — a document
 * the assistant regenerated could grow without any limit at all, and each
 * oversized copy was then filed as a version as well. `attachments.js` imports
 * this rather than keeping a second number.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * U+0000, which Postgres will not store.
 *
 * A raw NUL byte in a text parameter fails with "invalid byte sequence", and a
 * NUL inside JSON — which `JSON.stringify` writes as the escape `\u0000` — fails
 * jsonb with "unsupported Unicode escape sequence". It arrives from outside: a web
 * page, a PDF, a command's output. It carries no meaning in anything stored here,
 * and a whole workflow step was lost to one, so it is removed on the way in.
 */
// The character itself is the point of this pattern.
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/g;
const withoutNul = (value) => (typeof value === 'string' && value.includes('\u0000') ? value.replace(NUL, '') : value);

/**
 * JSON for a jsonb column. NUL is removed from every string before encoding,
 * not from the encoded text afterwards: text somebody wrote containing a literal
 * backslash-u-0000 is encoded with an escaped backslash and must survive intact.
 */
const toJson = (value) => JSON.stringify(value, (key, item) => withoutNul(item));

export function createPgStore(connectionString) {
  // Accepts a driver object instead of a URL so the tenancy-isolation tests can
  // run the real SQL against an in-process Postgres.
  const sql =
    typeof connectionString === 'object' && connectionString?.query
      ? connectionString
      : neon(connectionString);

  /**
   * Whether this database has pgvector — probed once, then remembered.
   *
   * Neon ships it; the in-process Postgres a laptop runs does not. Rather than
   * branching on which store we think we are, the question is asked of the
   * database itself, so a deployment that later gains the extension picks it up
   * on its next cold start and one that never has it is never asked twice.
   *
   * `null` means "not asked yet" and is distinct from `false`.
   */
  let vectorReady = null;


  let schemaReady = null;
  async function ready() {
    if (!schemaReady) {
      schemaReady = (async () => {
        try {
          const rows = await sql.query('SELECT value FROM settings WHERE key = $1', ['schema_version']);
          // `>=`, not `===`. An instance running older code must not decide that
          // a *newer* database needs its own older schema replayed over the top
          // — see the monotonic stamp below for the other half of this.
          if (Number(rows[0]?.value) >= SCHEMA_VERSION) return;
        } catch {
          // No `settings` table yet: this is a fresh database, so fall through
          // and build it.
        }

        const ddl = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
        const statements = splitStatements(ddl);

        /**
         * One request, atomically, where the driver can do it.
         *
         * Replaying 80-odd DDL statements one at a time is 80 round trips, and
         * after a version bump *every* cold-starting instance does it at the
         * same moment. Concurrent `CREATE TABLE IF NOT EXISTS` on the same
         * object is a known Postgres race — `IF NOT EXISTS` is a check, not a
         * lock — and it surfaces as `duplicate key value violates unique
         * constraint "pg_type_typname_nsp_index"`. In a transaction the loser
         * rolls back cleanly instead of half-applying.
         *
         * The driver-object path — PGlite on a laptop, and the tests — has no
         * `transaction`, and used to run the statements bare. A failure half
         * way (a disk filling, the process killed during a version bump) left
         * the first half applied and the rest not: a schema matching no version
         * of the code. The one connection that driver wraps takes an explicit
         * BEGIN/COMMIT, and Postgres DDL is transactional, so it gets the same
         * all-or-nothing the Neon path has. Nothing in schema.sql refuses to run
         * in a transaction — the Neon path already proves that on every deploy.
         */
        if (typeof sql.transaction === 'function') {
          await sql.transaction(statements.map((stmt) => sql.query(stmt)));
        } else {
          await sql.query('BEGIN');
          try {
            for (const stmt of statements) await sql.query(stmt);
            await sql.query('COMMIT');
          } catch (err) {
            await sql.query('ROLLBACK').catch(() => {});
            throw err;
          }
        }

        /**
         * The stamp only ever goes up.
         *
         * Written last, so a failed replay leaves the database unstamped and the
         * next boot starts over — that part was already right. What was missing
         * is the guard against going *backwards*: during a rollback or a staged
         * rollout, an instance on older code read stamp 15, saw `15 !== 14`,
         * replayed its own older schema and stamped the database down to 14.
         * The next new-code cold start then saw `14 !== 15` and replayed
         * everything again — a full DDL replay on nearly every cold start, which
         * is exactly when the concurrency race above is most likely to fire.
         */
        await sql.query(
          // `value` is JSONB, so both sides are extracted with `#>>` and cast.
          // The parameter needs its own `::jsonb` — it arrives as text.
          `INSERT INTO settings (key, value) VALUES ('schema_version', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            WHERE (settings.value #>> '{}')::int < (EXCLUDED.value #>> '{}')::int`,
          [toJson(SCHEMA_VERSION)],
        );
      })();
    }
    /**
     * A failed replay must not poison the instance.
     *
     * `schemaReady` was memoised including its rejection, and `q()` awaits it on
     * every query — so one transient failure meant that warm instance returned
     * the same error for the rest of its life rather than ever retrying.
     */
    return schemaReady.catch((err) => {
      schemaReady = null;
      throw err;
    });
  }

  const q = async (text, params = []) => {
    await ready();
    // Every query passes here, so no text column can be handed a NUL byte.
    return sql.query(text, params.map(withoutNul));
  };

  return {
    kind: 'postgres',
    multiUser: true,

    async init() {
      await ready();
    },

    /**
     * Two narrow read-only questions, for diagnosing a database that disagrees
     * with the code.
     *
     * There is deliberately no general "run this SQL" method on this store —
     * every query is a named function with the account scoping written into it,
     * which is most of what makes the tenancy boundary hold. These two are the
     * exception and are shaped so they cannot become that door: one returns a
     * number, the other a boolean, and neither takes anything that reaches a
     * value clause.
     *
     * They exist because the failure they diagnose is genuinely hard to see from
     * outside. `schema.sql` runs only when the stamp differs, so a column the
     * code writes to can simply be absent — and `summary()` runs three queries
     * in a `Promise.all`, so the same stale database blames a different column
     * on each request. Two facts settle it: what the stamp says, and what the
     * columns actually are.
     */
    async schemaStamp() {
      try {
        const rows = await sql.query('SELECT value FROM settings WHERE key = $1', ['schema_version']);
        const value = Number(rows[0]?.value);
        return Number.isFinite(value) ? value : null;
      } catch {
        // No settings table at all: a database that has never been initialised.
        return null;
      }
    },

    async columnExists(table, column) {
      const rows = await sql.query(
        'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
        [String(table), String(column)],
      );
      return rows.length > 0;
    },

    // ── users ───────────────────────────────────────────────────────
    async countUsers() {
      const rows = await q('SELECT COUNT(*)::int AS n FROM users');
      return rows[0]?.n ?? 0;
    },
    async createUser(user) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, user.email, user.name ?? null, user.passwordHash, user.role],
      );
      return this.getUserById(user.id);
    },
    async getUserByEmail(email) {
      const rows = await q('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
      return rows[0] ?? null;
    },
    async getUserById(id) {
      const rows = await q('SELECT * FROM users WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
    async listUsers() {
      return q(
        `SELECT u.id, u.email, u.name, u.role, u.created_at, u.last_seen_at,
                u.email_verified_at, u.suspended_at, u.monthly_token_limit,
                (u.worker_token IS NOT NULL) AS has_worker,
                (SELECT COUNT(*)::int FROM chats c WHERE c.user_id = u.id) AS chat_count,
                COALESCE((SELECT SUM(e.input_tokens + e.output_tokens) FROM usage_events e
                           WHERE e.user_id = u.id
                             AND e.created_at >= date_trunc('month', NOW())), 0)::bigint AS tokens_this_month
           FROM users u ORDER BY u.created_at ASC`,
      );
    },
    async touchUser(id) {
      await q('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [id]);
    },
    async setUserRole(id, role) {
      if (role !== 'admin' && role !== 'user') throw new Error(`Unknown role "${role}".`);
      await q('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
    },
    /**
     * Change the password, and make that mean what people assume it means.
     *
     * Bumping `session_epoch` invalidates every cookie already issued for this
     * account, because the epoch is signed into the cookie and compared on every
     * request. Without it a stolen session survived the one action taken to stop
     * it — for thirty days.
     */
    async setUserPassword(id, passwordHash) {
      await q(
        'UPDATE users SET password_hash = $2, session_epoch = session_epoch + 1 WHERE id = $1',
        [id, passwordHash],
      );
      // Also a session-independent way to lock out anyone holding an old reset link.
      await q("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'reset'", [id]);
    },
    async updateUser(id, patch) {
      const columns = { name: 'name', role: 'role', monthlyTokenLimit: 'monthly_token_limit' };
      const fields = [];
      const values = [];
      for (const [key, column] of Object.entries(columns)) {
        if (!(key in patch)) continue;
        values.push(patch[key]);
        fields.push(`${column} = $${values.length}`);
      }
      if ('suspended' in patch) {
        fields.push(`suspended_at = ${patch.suspended ? 'NOW()' : 'NULL'}`);
      }
      if (!fields.length) return this.getUserById(id);
      values.push(id);
      await q(`UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
      return this.getUserById(id);
    },
    async markEmailVerified(id) {
      await q('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [id]);
    },

    // ── two-factor ──────────────────────────────────────────────────
    /** Stage a secret before it is confirmed; `enabled` stays null until then. */
    async setTotpSecret(id, encryptedSecret) {
      await q(
        'UPDATE users SET totp_secret = $2, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = $1',
        [id, encryptedSecret],
      );
    },
    async enableTotp(id, codeHashes) {
      await q(
        'UPDATE users SET totp_enabled_at = NOW(), recovery_codes = $2 WHERE id = $1',
        [id, toJson(codeHashes)],
      );
    },
    async disableTotp(id) {
      await q(
        `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL,
                          recovery_codes = NULL, totp_last_step = NULL
          WHERE id = $1`,
        [id],
      );
    },
    /**
     * Spend one 30-second TOTP step, and refuse to spend it twice.
     *
     * The comparison runs in SQL for the same reason the recovery codes do: two
     * simultaneous attempts with the same code must not both succeed. `>` rather
     * than `<>` also rejects an older step, so a replay cannot walk backwards.
     */
    async consumeTotpStep(id, step) {
      const rows = await q(
        `UPDATE users SET totp_last_step = $2
          WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
      RETURNING id`,
        [id, String(step)],
      );
      return rows.length > 0;
    },
    /**
     * Spend one recovery code. The filter runs in SQL so two simultaneous
     * attempts cannot both succeed with the same code.
     */
    async consumeRecoveryCode(id, codeHash) {
      const rows = await q(
        `UPDATE users
            SET recovery_codes = COALESCE(
                  (SELECT jsonb_agg(c) FROM jsonb_array_elements(recovery_codes) AS c
                    WHERE c <> to_jsonb($2::text)),
                  '[]'::jsonb)
          WHERE id = $1 AND recovery_codes @> to_jsonb(ARRAY[$2::text])
      RETURNING id`,
        [id, codeHash],
      );
      return rows.length > 0;
    },
    async deleteUser(id) {
      await q('DELETE FROM users WHERE id = $1', [id]);
    },

    // ── one-time links ──────────────────────────────────────────────
    async createAuthToken({ tokenHash, codeHash, userId, kind, expiresAt }) {
      // Only one live link per purpose: issuing a new one retires the old.
      await q('DELETE FROM auth_tokens WHERE user_id = $1 AND kind = $2', [userId, kind]);
      await q(
        `INSERT INTO auth_tokens (token_hash, code_hash, user_id, kind, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenHash, codeHash ?? null, userId, kind, expiresAt],
      );
    },
    /**
     * Claim by typed code. Scoped to one account, so a six-digit code only has
     * to be unguessable for that account within its short lifetime.
     */
    async consumeAuthCode(userId, codeHash, kind) {
      const rows = await q(
        `UPDATE auth_tokens SET used_at = NOW()
          WHERE user_id = $1 AND code_hash = $2 AND kind = $3
            AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
        [userId, codeHash, kind],
      );
      return rows[0]?.user_id ?? null;
    },
    /**
     * Claim a link atomically. The UPDATE ... RETURNING only matches an unused,
     * unexpired row, so a replayed link finds nothing rather than racing.
     */
    async consumeAuthToken(tokenHash, kind) {
      const rows = await q(
        `UPDATE auth_tokens SET used_at = NOW()
          WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING user_id`,
        [tokenHash, kind],
      );
      return rows[0]?.user_id ?? null;
    },

    // ── usage ───────────────────────────────────────────────────────
    async recordUsage(userId, event) {
      await q(
        `INSERT INTO usage_events
           (id, user_id, chat_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.id,
          userId,
          event.chatId ?? null,
          event.model,
          event.inputTokens || 0,
          event.outputTokens || 0,
          event.costUsd || 0,
          event.cacheReadTokens || 0,
          event.role || 'turn',
        ],
      );
    },
    /** Totals since the start of the current calendar month, UTC. */
    async usageThisMonth(userId) {
      const rows = await q(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read,
                COUNT(*)::int AS calls
           FROM usage_events
          WHERE user_id = $1 AND created_at >= date_trunc('month', NOW())`,
        [userId],
      );
      const r = rows[0] || {};
      return {
        tokens: Number(r.tokens || 0),
        cost: Number(r.cost || 0),
        cacheRead: Number(r.cache_read || 0),
        calls: Number(r.calls || 0),
      };
    },
    /**
     * What each part of the system spent, so the invisible halves stop being
     * invisible. A compaction, a research debate and a page extraction all cost
     * real tokens and none of them appeared anywhere before.
     */
    async usageByRole(userId, days = 30) {
      return q(
        `SELECT role,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(cost_usd)              AS cost,
                COUNT(*)::int              AS calls
           FROM usage_events
          WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY role ORDER BY SUM(input_tokens + output_tokens) DESC`,
        [userId, String(days)],
      );
    },
    async usageByModel(userId, days = 30) {
      return q(
        `SELECT model,
                SUM(input_tokens)::bigint       AS input_tokens,
                SUM(output_tokens)::bigint      AS output_tokens,
                SUM(cache_read_tokens)::bigint  AS cache_read_tokens,
                SUM(cost_usd)                   AS cost,
                COUNT(*)::int                   AS calls
           FROM usage_events
          WHERE user_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
          GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC`,
        [userId, String(days)],
      );
    },

    // ── per-user settings ───────────────────────────────────────────
    async getUserSetting(userId, key) {
      const rows = await q('SELECT value FROM user_settings WHERE user_id = $1 AND key = $2', [userId, key]);
      return rows[0]?.value ?? null;
    },
    async setUserSetting(userId, key, value) {
      await q(
        `INSERT INTO user_settings (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [userId, key, toJson(value)],
      );
      return value;
    },
    /**
     * Merge top-level entries into a setting, without reading it first.
     *
     * `setUserSetting` is an unconditional whole-value overwrite, so anything
     * built as read-modify-write on top of it loses concurrent changes. The
     * agent runs up to four tool calls at once, so two `memory_append` calls in
     * a single step both read the same notes object and the second write erased
     * the first — while *both* reported success, so the model told the user two
     * notes had been saved when one had silently vanished.
     *
     * `||` is jsonb concatenation: a top-level merge, right-hand side wins.
     * Two calls touching different keys now compose instead of racing.
     */
    async mergeUserSetting(userId, key, patch) {
      const rows = await q(
        `INSERT INTO user_settings (user_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key)
         DO UPDATE SET value = COALESCE(user_settings.value, '{}'::jsonb) || EXCLUDED.value
      RETURNING value`,
        [userId, key, toJson(patch)],
      );
      return rows[0]?.value ?? patch;
    },
    /**
     * Merge into a setting one level down, without reading it first.
     *
     * `mergeUserSetting` composes at the top level, which is enough when two
     * writers touch different keys. Artifact storage is shaped
     * `{ artifactId: { name: value } }`, so a top-level merge would still let
     * two writes to the *same* artifact overwrite one another — the second
     * replaces the whole bucket, including the key the first had just added.
     *
     * `jsonb_set` with the bucket concatenated onto itself narrows the race to
     * the same artifact *and* the same key, where last-write-wins is the only
     * meaningful answer anyway.
     */
    async mergeUserSettingIn(userId, key, entry, patch) {
      const rows = await q(
        `INSERT INTO user_settings (user_id, key, value)
              VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb))
         ON CONFLICT (user_id, key) DO UPDATE SET value = jsonb_set(
                COALESCE(user_settings.value, '{}'::jsonb),
                ARRAY[$3::text],
                COALESCE(user_settings.value -> $3::text, '{}'::jsonb) || $4::jsonb,
                true)
      RETURNING value`,
        [userId, key, String(entry), toJson(patch ?? {})],
      );
      return rows[0]?.value ?? null;
    },
    /**
     * Remove one top-level entry from a setting, leaving the rest alone.
     *
     * The counterpart to `mergeUserSetting`, and needed for the same reason: a
     * delete written as read-modify-write would undo whatever else had been
     * saved in between.
     */
    async removeUserSettingKey(userId, key, entry) {
      const rows = await q(
        `UPDATE user_settings SET value = value - $3
          WHERE user_id = $1 AND key = $2
      RETURNING value`,
        [userId, key, String(entry)],
      );
      return rows[0]?.value ?? null;
    },

    // ── deployment-wide settings ────────────────────────────────────
    async getSetting(key) {
      const rows = await q('SELECT value FROM settings WHERE key = $1', [key]);
      return rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await q(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, toJson(value)],
      );
      return value;
    },

    // ── chats ───────────────────────────────────────────────────────
    /**
     * The conversations worth listing — the ones something was said in.
     *
     * A conversation nobody has spoken in is not history, it is a blank page
     * somebody opened and walked away from. They used to accumulate in the
     * sidebar as a column of identical "New chat" rows. The client no longer
     * creates one until the first message, and this covers the ones already
     * stored, plus the case where a send fails after the row exists.
     */
    async listChats(userId) {
      return q(
        /**
         * One pass over the messages index per chat, not two.
         *
         * This ran a correlated COUNT *and* a correlated EXISTS for every row,
         * so the commonest query in the application — the sidebar, on every
         * load — did up to four hundred index scans to return two hundred rows,
         * and half of them only to answer a question the count had already
         * answered.
         *
         * LATERAL runs the count once per chat and the outer WHERE reads its
         * result, which is the same filter for one scan instead of two. Both
         * are supported by messages_chat_seq_idx either way.
         */
        /*
         * `running` — something is working in this conversation right now: a
         * turn holding the chat's run lease, a workflow run, or a scheduled
         * task. The sidebar marks it and keeps refreshing while any is. A
         * conversation that work has just opened is listed before its first
         * message lands, so it appears the moment the run starts.
         */
        `WITH live AS (
                SELECT chat_id FROM workflow_runs WHERE user_id = $1 AND status = 'running' AND chat_id IS NOT NULL
                UNION
                SELECT last_chat FROM scheduled_tasks WHERE user_id = $1 AND run_state = 'running' AND last_chat IS NOT NULL
         )
         SELECT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at, m.message_count,
                c.project_id, c.unread, c.chat_group,
                (l.chat_id IS NOT NULL
                  OR (c.run_lock_at IS NOT NULL AND c.run_lock_at > NOW() - make_interval(secs => $2))) AS running
           FROM chats c
           JOIN LATERAL (
                SELECT COUNT(*)::int AS message_count FROM messages m WHERE m.chat_id = c.id
           ) m ON TRUE
           LEFT JOIN live l ON l.chat_id = c.id
          -- Archived conversations are not gone, they are put away. The one
          -- place they still appear is the Projects shelf's archived filter.
          WHERE c.user_id = $1 AND c.archived_at IS NULL
            AND (m.message_count > 0 OR l.chat_id IS NOT NULL)
          ORDER BY c.pinned DESC, c.updated_at DESC
          LIMIT 200`,
        [userId, RUN_LEASE_STALE_MS / 1000],
      );
    },
    async createChat(userId, chat) {
      await q('INSERT INTO chats (id, user_id, title, model, project_id) VALUES ($1, $2, $3, $4, $5)', [
        chat.id,
        userId,
        chat.title,
        chat.model,
        // A conversation started inside a project belongs to it for good: the
        // instructions and sources it was answered under are part of what the
        // transcript means.
        chat.projectId ?? null,
      ]);
      return this.getChat(userId, chat.id);
    },
    /**
     * Find conversations by title or by anything said in them.
     *
     * Message bodies are JSONB, so the text is matched against the whole
     * serialised value rather than a column — crude, but it means a search hits
     * what somebody typed, what the assistant replied, and what a tool returned,
     * without a second index to keep in step. Scoped by `user_id` in the same
     * query as everything else: a search must never reach across accounts.
     */
    async searchChats(userId, query, limit = 40) {
      /**
       * The user's own wildcards are searched for, not obeyed.
       *
       * `%` and `_` are LIKE metacharacters, so typing a single `%` matched
       * *every* message this account has ever written — the most expensive
       * query in the file, run from a search box, on one keystroke. `\` has to
       * go first or it would escape the escapes.
       *
       * The `ESCAPE` clause is named explicitly in the SQL below because the default
       * is not guaranteed across configurations.
       */
      const escaped = String(query).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const like = `%${escaped}%`;
      return q(
        `SELECT c.id, c.title, c.updated_at, c.pinned,
                (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count,
                (SELECT LEFT(m.content::text, 300)
                   FROM messages m
                  WHERE m.chat_id = c.id AND m.content::text ILIKE $2 ESCAPE '\\'
                  ORDER BY m.seq LIMIT 1) AS snippet
           FROM chats c
          WHERE c.user_id = $1
            AND (c.title ILIKE $2 ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM messages m
                             WHERE m.chat_id = c.id AND m.content::text ILIKE $2 ESCAPE '\\'))
          ORDER BY c.updated_at DESC
          LIMIT $3`,
        [userId, like, limit],
      );
    },

    async getChat(userId, id) {
      const rows = await q('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
      return rows[0] ?? null;
    },
    /**
     * Change one conversation.
     *
     * The allow-list is the security boundary, not a formality: the patch comes
     * straight from a request body, and anything not named here — `user_id`
     * first among them — must never reach the UPDATE.
     *
     * `archived` is a boolean on the way in and a timestamp in the table, so it
     * gets its own translation rather than a column the caller can set to any
     * value it likes.
     */
    async updateChat(userId, id, patch) {
      const fields = [];
      const values = [];
      const COLUMNS = { title: 'title', model: 'model', pinned: 'pinned', projectId: 'project_id', unread: 'unread', group: 'chat_group' };
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'archived') {
          values.push(v ? new Date().toISOString() : null);
          fields.push(`archived_at = $${values.length}`);
          continue;
        }
        const column = COLUMNS[k];
        if (!column) continue;
        values.push(v);
        fields.push(`${column} = $${values.length}`);
      }
      if (fields.length) {
        values.push(id, userId);
        /**
         * `updated_at` is deliberately left alone.
         *
         * The sidebar orders by it, so bumping it on every change would send a
         * conversation to the top of the list because somebody archived it or
         * marked it unread — which is the opposite of what those two mean. Only
         * a rename says the conversation itself moved on, and even that is
         * arguable; it is kept for a title because that is the behaviour people
         * already have.
         */
        const touch = 'title' in patch ? ', updated_at = NOW()' : '';
        await q(
          `UPDATE chats SET ${fields.join(', ')}${touch}
            WHERE id = $${values.length - 1} AND user_id = $${values.length}`,
          values,
        );
      }
      return this.getChat(userId, id);
    },

    /** The names a person has invented, for the "Move to group" menu. */
    async listChatGroups(userId) {
      const rows = await q(
        `SELECT DISTINCT chat_group FROM chats
          WHERE user_id = $1 AND chat_group IS NOT NULL AND chat_group <> ''
          ORDER BY chat_group`,
        [userId],
      );
      return rows.map((row) => row.chat_group);
    },
    async touchChat(userId, id) {
      await q('UPDATE chats SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    /**
     * Claim the right to run the agent loop on this conversation.
     *
     * The whole claim is one conditional UPDATE, so it is atomic between two
     * browser tabs and between two serverless instances alike — exactly the two
     * ways a transcript used to get shredded by interleaved turns.
     *
     * The lock is a lease, not a latch: a run cut off mid-flight (which is the
     * normal way a serverless invocation ends) leaves a stale row behind, and
     * refusing forever because of that would be worse than the race. `staleMs`
     * is how long a silent holder keeps it — comfortably longer than the 15s
     * heartbeat that renews it, and short enough that an abandoned tab frees the
     * conversation in about a minute.
     *
     * Re-entrant by design: the same `runId` may reclaim its own lease, which is
     * how a browser resuming a run the host cut short continues rather than
     * being locked out by the mechanism meant to protect it.
     */
    /**
     * `<=`, not `<`, and the difference is a flaky test.
     *
     * `NOW()` is the transaction start time, so two adjacent statements on a fast
     * machine can carry the identical timestamp. With `staleMs = 0` — which means
     * "no grace at all, take the lease" — a strict `<` then read a lease claimed
     * microseconds ago as still live and refused, intermittently, depending only
     * on how quickly the two statements ran. At 75 seconds the boundary is
     * meaningless either way; at zero it is the whole behaviour.
     */
    /**
     * Take the run lease, and say *which* holding of it this is.
     *
     * The re-entrant clause (`run_lock_by = $3`) is what makes resuming work:
     * the browser reconnects with the same `runId` and must be allowed back in.
     * On its own, though, it also let the reconnection quietly *join* the run it
     * meant to replace. Both invocations then held a lease that named them, so
     * `touchChatRun` answered "still yours" to **both**, and the heartbeat that
     * exists to stop an abandoned invocation could never fire. Two loops
     * appended to one transcript: two tool messages for one assistant turn,
     * which every provider rejects on the next request.
     *
     * `run_lock_seq` settles it. Every claim bumps it, so a later claim silently
     * demotes the earlier holder — same run id or not — and the older
     * invocation discovers on its next heartbeat that it is no longer the one,
     * and stops. The reconnection replaces rather than duplicates.
     *
     * @returns the sequence number of this holding, or 0 if the lease was not
     *   granted. Always ≥ 1 on success, so it stays usable as a boolean.
     */
    async claimChatRun(userId, chatId, runId, staleMs = RUN_LEASE_STALE_MS) {
      const rows = await q(
        `UPDATE chats
            SET run_lock_at = NOW(), run_lock_by = $3, run_lock_seq = run_lock_seq + 1
          WHERE id = $1 AND user_id = $2
            AND (run_lock_at IS NULL
                 OR run_lock_at <= NOW() - ($4 || ' milliseconds')::interval
                 OR run_lock_by = $3)
      RETURNING run_lock_seq`,
        [chatId, userId, runId, String(staleMs)],
      );
      return rows.length ? Number(rows[0].run_lock_seq) : 0;
    },
    /**
     * Keep a long run's lease alive while it is genuinely still working.
     *
     * @returns whether the lease is still ours. That answer is what makes
     *   stopping reliable. A browser pressing stop aborts its fetch, and the
     *   server usually notices because the socket closes — but "usually" is not
     *   good enough for a loop that spends the user's money: behind a proxy that
     *   buffers, or on a serverless host that holds the connection open, the
     *   close can arrive late or not at all, and the model keeps answering into
     *   a page nobody is reading.
     *
     *   So `stopChatRun` takes the lease away, and this reports the theft. The
     *   run finds out on its next heartbeat and stops for a fact rather than by
     *   inference.
     */
    /**
     * @param seq  which holding of the lease is asking. Omit only from a caller
     *   that genuinely has no sequence to offer; matching on the run id alone is
     *   what let a reconnection and the invocation it replaced both be told they
     *   still held the lease. See `claimChatRun`.
     */
    async touchChatRun(userId, chatId, runId, seq = null) {
      const rows = await q(
        `UPDATE chats SET run_lock_at = NOW()
          WHERE id = $1 AND user_id = $2 AND run_lock_by = $3
            AND ($4::bigint IS NULL OR run_lock_seq = $4::bigint)
      RETURNING id`,
        [chatId, userId, runId, seq == null ? null : String(seq)],
      );
      return rows.length > 0;
    },

    /**
     * The owner asks for whatever is running here to stop.
     *
     * Unlike `releaseChatRun` this does not name a holder, and that is the
     * point: the person pressing stop is not the process holding the lease, and
     * on a serverless deployment may not even be talking to the same instance.
     * Clearing the lock is the message.
     */
    async stopChatRun(userId, chatId) {
      const rows = await q(
        `UPDATE chats SET run_lock_at = NULL, run_lock_by = NULL
          WHERE id = $1 AND user_id = $2 AND run_lock_by IS NOT NULL
      RETURNING id`,
        [chatId, userId],
      );
      return rows.length > 0;
    },
    /**
     * Only the holder may release, so a late finisher cannot free someone else's
     * lock — and with `seq`, not even an earlier holding of the *same* run id.
     *
     * That last part matters on the resume path: the superseded invocation runs
     * this in its `finally`, and without the sequence it would release the lease
     * out from under the reconnection that had just taken it over.
     */
    async releaseChatRun(userId, chatId, runId, seq = null) {
      await q(
        `UPDATE chats SET run_lock_at = NULL, run_lock_by = NULL
          WHERE id = $1 AND user_id = $2 AND run_lock_by = $3
            AND ($4::bigint IS NULL OR run_lock_seq = $4::bigint)`,
        [chatId, userId, runId, seq == null ? null : String(seq)],
      );
    },
    async deleteChat(userId, id) {
      // The files go with it. `attachments.chat_id` carries no foreign key — it
      // is set after the fact, when a message is sent — so nothing would cascade,
      // and deleting a conversation would leave its photographs and documents in
      // the database with nothing pointing at them. "Delete this conversation"
      // has to mean what it says.
      await q('DELETE FROM attachments WHERE user_id = $1 AND chat_id = $2', [userId, id]);
      await q('DELETE FROM chats WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    // ── messages ────────────────────────────────────────────────────
    // Joined against chats so a guessed chat id from another account reads back
    // as an empty conversation rather than someone else's.
    async listMessages(userId, chatId) {
      const rows = await q(
        `SELECT m.id, m.role, m.content, m.seq, m.created_at
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.chat_id = $1 AND c.user_id = $2
          ORDER BY m.seq ASC`,
        [chatId, userId],
      );
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        ...r.content,
        seq: Number(r.seq),
        createdAt: r.created_at,
      }));
    },
    /**
     * Only what has arrived since `afterSeq`.
     *
     * The agent loop asks, once per step, whether the user has said anything
     * new while it was working. It used to answer that by re-reading the
     * *entire* transcript — every JSONB message body, including the tool
     * results and the base64 that never shrinks — and then discarding all but
     * the new rows. At `maxSteps` of 30 that is the whole conversation pulled
     * over the wire thirty times in a single turn, and compaction does not help
     * because it trims in memory, after the read.
     *
     * `messages_chat_seq_idx (chat_id, seq)` covers this exactly, so it costs
     * an index seek and returns nothing at all in the common case.
     */
    async messagesSince(userId, chatId, afterSeq) {
      const rows = await q(
        `SELECT m.id, m.role, m.content, m.seq, m.created_at
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.chat_id = $1 AND c.user_id = $2 AND m.seq > $3
          ORDER BY m.seq ASC`,
        [chatId, userId, Number(afterSeq) || 0],
      );
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        ...r.content,
        seq: Number(r.seq),
        createdAt: r.created_at,
      }));
    },
    async appendMessage(userId, chatId, message) {
      const { id, role, ...rest } = message;
      /**
       * The number comes from bumping the conversation's counter, not from
       * reading the highest one (ARCH-007).
       *
       * This computed `MAX(seq) + 1` inside the insert. Two appends to one
       * conversation at once both read the same maximum and both wrote it, and
       * nothing refused the second, so two turns shared a position the whole
       * transcript is ordered by. An UPDATE is different in exactly the way that
       * matters: when it has to wait for another writer's row lock, Postgres
       * re-reads the row before applying it, so the second append sees the first
       * one's increment. A subquery is not re-read that way.
       *
       * `GREATEST` with the old reading covers two edges, and both are rollout
       * edges rather than steady state. A conversation created in the moment
       * between adding the column and setting its default has a NULL counter,
       * and `GREATEST` ignores NULL. And an instance still running the old code
       * during a deploy inserts without bumping the counter; taking the larger of
       * the two keeps the new code from handing out a number the old code has
       * already used.
       *
       * The ownership test moved into the UPDATE's WHERE, so an append for a
       * conversation that is not this account's bumps nothing and inserts
       * nothing — the same refusal the EXISTS gave before.
       */
      const rows = await q(
        `WITH bump AS (
           UPDATE chats
              SET next_seq = GREATEST(
                    next_seq,
                    (SELECT COALESCE(MAX(seq) + 1, 0) FROM messages WHERE chat_id = $2)
                  ) + 1
            WHERE id = $2 AND user_id = $5
        RETURNING next_seq - 1 AS seq
         )
         INSERT INTO messages (id, chat_id, seq, role, content)
         SELECT $1, $2, bump.seq, $3, $4 FROM bump
      RETURNING id, seq`,
        [id, chatId, role, toJson(rest), userId],
      );
      if (!rows.length) throw new Error('Chat not found.');
      await this.touchChat(userId, chatId);
      /**
       * The `seq` comes back on the message.
       *
       * `messagesSince` needs a high-water mark, and the caller holds these
       * objects in memory rather than re-reading them — so a turn appended
       * during a run carried no position and could not advance the mark. It
       * still worked (the id set filtered the duplicates) but it re-fetched
       * every row this loop had just written, on every step.
       */
      return { ...message, seq: Number(rows[0].seq) };
    },

    /**
     * Change what somebody said, and drop everything that followed it.
     *
     * Editing a message is really asking the conversation to take a different
     * turn from that point, so the answers that came after it cannot stay: they
     * are replies to a question that no longer exists, and leaving them would
     * produce a transcript nobody ever had. The conversation is then re-run
     * from the edited message, which is what makes it feel like changing your
     * mind rather than tampering with the record.
     *
     * Only user turns. An assistant message is a record of what a model
     * actually said, and editing that is forging evidence.
     */
    /**
     * Record that these tool calls have begun executing, on the assistant turn
     * that asked for them.
     *
     * A run can be killed between a tool finishing and its result being stored —
     * the function timeout on a deployment, a reconnection taking the lease — and
     * the resume path then finds an assistant turn with calls and no results. It
     * used to run them all again. For a read that is harmless; for `send_email`
     * it is a second email. This marker is what lets the resume tell "never
     * started" from "started, outcome unknown" (AUTO-007).
     *
     * Appended in SQL rather than read-modify-written in JS, because the two
     * writers that race here are exactly the superseded run and the one that
     * replaced it. Duplicates in the array are harmless; the reader takes a Set.
     * Scoped through the owning chat like every other message write.
     */
    async markToolCallsStarted(userId, chatId, messageId, callIds) {
      if (!Array.isArray(callIds) || !callIds.length) return;
      await q(
        `UPDATE messages m
            SET content = jsonb_set(
                  m.content,
                  '{startedCalls}',
                  COALESCE(m.content->'startedCalls', '[]'::jsonb) || $4::jsonb,
                  true)
           FROM chats c
          WHERE m.id = $3 AND m.chat_id = $2 AND c.id = m.chat_id AND c.user_id = $1`,
        [userId, chatId, messageId, toJson(callIds.map(String))],
      );
    },

    async editUserMessage(userId, chatId, messageId, text) {
      const rows = await q(
        `SELECT m.seq, m.content, m.role
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.id = $1 AND m.chat_id = $2 AND c.user_id = $3`,
        [messageId, chatId, userId],
      );
      const found = rows[0];
      if (!found) return null;
      if (found.role !== 'user') {
        throw Object.assign(new Error('Only your own messages can be edited.'), { status: 400 });
      }

      // The attachments travel with the message: editing the words does not
      // detach the photograph they were about.
      const content = { ...found.content, text };
      /**
       * The ownership test travels with the write, not just ahead of it.
       *
       * The SELECT above already proves this message belongs to this account,
       * so nothing here was reachable across a tenancy boundary. But an UPDATE
       * keyed on `id` alone and a DELETE keyed on `chat_id` alone are only safe
       * because of a check several lines earlier, in a different statement —
       * and the DELETE removes every later message in the conversation, which
       * is the most destructive statement in this file.
       *
       * `messages` has no user_id of its own (see schema.sql), so the join to
       * `chats` is how tenancy is expressed everywhere else in this module.
       * Doing it here too makes each statement independently correct rather
       * than correct-in-context.
       */
      await q(
        `UPDATE messages SET content = $1
          WHERE id = $2 AND chat_id = $3
            AND EXISTS (SELECT 1 FROM chats c WHERE c.id = $3 AND c.user_id = $4)`,
        [toJson(content), messageId, chatId, userId],
      );
      await q(
        `DELETE FROM messages
          WHERE chat_id = $1 AND seq > $2
            AND EXISTS (SELECT 1 FROM chats c WHERE c.id = $1 AND c.user_id = $3)`,
        [chatId, found.seq, userId],
      );
      await this.touchChat(userId, chatId);

      return { id: messageId, role: 'user', ...content, seq: Number(found.seq) };
    },

    // ── attachments ─────────────────────────────────────────────────
    async createAttachment(userId, file) {
      const rows = await q(
        `INSERT INTO attachments (id, user_id, name, mime, kind, bytes, data, origin, source, chat_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, mime, kind, bytes, origin, created_at`,
        [
          file.id,
          userId,
          file.name,
          file.mime,
          file.kind,
          file.bytes,
          file.data,
          file.origin || 'upload',
          file.source ?? null,
          file.chatId ?? null,
        ],
      );
      return rows[0];
    },
    /** Metadata only — the bytes are the expensive part and rarely the point. */
    async listAttachments(userId, ids) {
      if (!ids?.length) return [];
      return q(
        `SELECT id, name, mime, kind, bytes, origin FROM attachments
          WHERE user_id = $1 AND id = ANY($2::text[])`,
        [userId, ids],
      );
    },
    async getAttachment(userId, id) {
      const rows = await q(
        `SELECT id, name, mime, kind, bytes, data, origin, source, chat_id, created_at
           FROM attachments WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      return rows[0] ?? null;
    },
    /**
     * Several at once, for the transcript loader.
     *
     * It asked for them one at a time, inside the agent's per-step loop, so a
     * ten-step turn carrying eight files spent eighty *sequential* round trips
     * on rows it could have had in ten. Against Neon over HTTP that is seconds
     * of latency per turn spent entirely on waiting.
     *
     * Scoped by `user_id` like the singular form, so a guessed id from another
     * account simply is not in the result.
     */
    /**
     * The files themselves, bytes included, a couple at a time.
     *
     * This is the right shape — it replaced a genuine N+1 — and it needed a
     * ceiling. Uploads are capped at 5MB with six per message, so one call could
     * legitimately ask for ~40MB of base64 in a single result set: the query in
     * this file most likely to hit the Neon HTTP endpoint's response limit or a
     * serverless function's memory.
     *
     * Two ids per statement keeps any one response to about 13MB while still
     * being a handful of round trips rather than one per file. `ANY($2::text[])`
     * rather than an expanded `IN (...)`, so the query string is the same
     * whatever the batch holds and Postgres can reuse the plan.
     */
    async getAttachments(userId, ids) {
      if (!ids?.length) return [];
      const BATCH = 2;
      const out = [];
      for (let i = 0; i < ids.length; i += BATCH) {
        const rows = await q(
          `SELECT id, name, mime, kind, bytes, data, origin, source, chat_id, created_at
             FROM attachments WHERE user_id = $1 AND id = ANY($2::text[])`,
          [userId, ids.slice(i, i + BATCH)],
        );
        out.push(...rows);
      }
      return out;
    },
    /**
     * Everything the assistant made in one conversation, newest first.
     *
     * Without the bytes: this answers "what did we produce here", which is a
     * list of names and sizes, not megabytes of base64.
     */
    async listGeneratedFiles(userId, chatId) {
      return q(
        `SELECT id, name, mime, kind, bytes, origin, created_at FROM attachments
          WHERE user_id = $1 AND chat_id = $2 AND origin = 'generated'
       ORDER BY created_at DESC`,
        [userId, chatId],
      );
    },
    /**
     * Everything the assistant has made on this account.
     *
     * Across conversations rather than within one: the artifacts shelf is a
     * place to find the thing you made on Tuesday, and remembering which
     * conversation that was is the problem it exists to remove.
     */
    async listAllGeneratedFiles(userId, limit = 200) {
      return q(
        // The opening of the source, so the shelf can show a window onto each
        // artifact rather than a row of identical file icons. Clipped in SQL
        // because the alternative is moving every document to the browser to
        // throw away all but the first few lines of each.
        `SELECT a.id, a.name, a.mime, a.kind, a.bytes, a.origin, a.chat_id, a.created_at,
                c.title AS chat_title, left(a.source, 400) AS peek
           FROM attachments a
      LEFT JOIN chats c ON c.id = a.chat_id
          WHERE a.user_id = $1 AND a.origin = 'generated'
       ORDER BY a.created_at DESC
          LIMIT $2`,
        [userId, Math.min(Math.max(Number(limit) || 200, 1), 500)],
      );
    },
    /** Throw one away. Only ever something the assistant made. */
    async deleteGeneratedFile(userId, id) {
      const rows = await q(
        `DELETE FROM attachments WHERE id = $1 AND user_id = $2 AND origin = 'generated' RETURNING id`,
        [id, userId],
      );
      return rows.length > 0;
    },
    /** Replace a generated file's bytes in place, keeping its id and its link. */
    /**
     * Rewrite a file the assistant made, keeping its id — and keeping what it
     * used to be.
     *
     * The outgoing copy is filed as a version before the new one lands, so the
     * two writes are ordered: history first, then the file. If the second fails
     * the worst case is a version identical to the current file, which is
     * harmless; the other order can lose a document.
     */
    async replaceAttachment(userId, id, { data, bytes, source, name, mime }) {
      const current = (await q('SELECT * FROM attachments WHERE id = $1 AND user_id = $2', [id, userId]))[0];
      if (!current || current.origin !== 'generated') return null;

      // Enforced here because all four rewrite paths reach this and only the
      // upload path checked. See MAX_ATTACHMENT_BYTES.
      if (Number(bytes) > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `That document came to ${Math.round(Number(bytes) / 1024 / 1024)}MB, over the ` +
            `${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit for a single file.`,
        );
      }

      // Scoped by account as well as attachment. The table carries user_id and
      // every other query here uses it; leaving it off made this the one read
      // whose correctness rested on the check twelve lines above rather than on
      // the statement itself.
      const seen = await q(
        'SELECT COALESCE(MAX(revision), 0)::int AS n FROM attachment_versions WHERE attachment_id = $1 AND user_id = $2',
        [id, userId],
      );
      // The first rewrite files two rows: what was there originally becomes
      // revision 1. Without that the history would start at the second draft
      // and "go back to the first one" would be impossible.
      await q(
        `INSERT INTO attachment_versions (id, attachment_id, user_id, revision, name, mime, kind, bytes, data, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          `${id}-v${seen[0].n + 1}`,
          id,
          userId,
          seen[0].n + 1,
          current.name,
          current.mime,
          current.kind,
          current.bytes,
          current.data,
          current.source ?? null,
          current.created_at,
        ],
      );

      const rows = await q(
        `UPDATE attachments
            SET data = $3, bytes = $4, source = $5,
                name = COALESCE($6, name), mime = COALESCE($7, mime), created_at = NOW()
          WHERE id = $1 AND user_id = $2 AND origin = 'generated'
      RETURNING id, name, mime, kind, bytes, origin, created_at`,
        [id, userId, data, bytes, source ?? null, name ?? null, mime ?? null],
      );

      /**
       * Keep the last twenty drafts, not all of them.
       *
       * Every rewrite copies the *entire* outgoing file — base64 and all — into
       * a new row, and nothing was ever removing them: `attachment_versions` is
       * the fastest-growing table in the database by bytes and appears in no
       * pruner. A document rewritten fifty times was fifty full copies kept for
       * ever, for a history nobody scrolls past the first few entries of.
       *
       * Twenty is generous for "go back to the one before the change I regret",
       * which is what the feature is for.
       */
      await q(
        `DELETE FROM attachment_versions
          WHERE attachment_id = $1 AND user_id = $2 AND revision <= $3`,
        [id, userId, seen[0].n + 1 - KEEP_VERSIONS],
      );

      return rows[0] ?? null;
    },

    /** Every earlier copy, newest first. Metadata only — the bytes are big. */
    async listAttachmentVersions(userId, attachmentId) {
      return q(
        `SELECT id, revision, name, mime, kind, bytes, created_at
           FROM attachment_versions
          WHERE user_id = $1 AND attachment_id = $2
          ORDER BY revision DESC`,
        [userId, attachmentId],
      );
    },

    /** One earlier copy, with its bytes — for showing it, or putting it back. */
    async getAttachmentVersion(userId, attachmentId, revision) {
      const rows = await q(
        `SELECT * FROM attachment_versions
          WHERE user_id = $1 AND attachment_id = $2 AND revision = $3`,
        [userId, attachmentId, Number(revision)],
      );
      return rows[0] ?? null;
    },
    /** Bind loose uploads to the conversation they were sent in. */
    async attachToChat(userId, chatId, ids) {
      if (!ids?.length) return;
      await q('UPDATE attachments SET chat_id = $3 WHERE user_id = $1 AND id = ANY($2::text[])', [
        userId,
        ids,
        chatId,
      ]);
    },
    /**
     * Sweep uploads that were never sent.
     *
     * Somebody attaches three photos, changes their mind and closes the tab. The
     * rows are already written, and nothing else would ever look at them again.
     */
    async pruneOrphanAttachments(olderThanHours = 24) {
      await q(
        `DELETE FROM attachments
          WHERE chat_id IS NULL AND origin = 'upload'
            AND created_at < NOW() - ($1 || ' hours')::interval`,
        [String(olderThanHours)],
      );
    },

    // ── worker relay ────────────────────────────────────────────────
    async enqueueJob(userId, job) {
      await q(
        `INSERT INTO tool_jobs (id, user_id, chat_id, tool, input, device_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          job.id,
          userId,
          job.chatId ?? null,
          job.tool,
          toJson(job.input ?? {}),
          job.deviceId ?? null,
        ],
      );
      return job;
    },
    /**
     * Hand a worker one job.
     *
     * Scoped by `userId`, which is the tenancy boundary, and then by device: a
     * job addressed to the laptop must not be answered by the desktop just
     * because the desktop polled first. A job with no device named is for
     * whoever is available, which is what a single-machine account always sees.
     */
    async claimJob(userId, deviceId = null) {
      const rows = await q(
        `UPDATE tool_jobs SET status = 'running', claimed_at = NOW()
          WHERE id = (
            SELECT id FROM tool_jobs
             WHERE status = 'pending' AND user_id = $1
               AND (device_id IS NULL OR device_id = $2)
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
      RETURNING id, chat_id, tool, input`,
        [userId, deviceId],
      );
      const r = rows[0];
      return r ? { id: r.id, chatId: r.chat_id, tool: r.tool, input: r.input } : null;
    },
    /**
     * When this account last had work for a computer.
     *
     * Read once per poll to decide how long to hold the request open. On a
     * machine you own, holding a connection for 25 seconds costs nothing. On a
     * serverless deployment it is 25 seconds of billed execution, repeated
     * around the clock by a worker that is doing nothing — which is how a free
     * tier gets spent on an idle laptop. Recent work means somebody is waiting
     * and latency matters; no recent work means nobody is.
     *
     * Deliberately not filtered by device: what is being asked is whether the
     * *account* is active, and a second computer's job is just as good a sign
     * that the person is at their desk.
     */
    async recentJobAt(userId) {
      const rows = await q(
        `SELECT created_at FROM tool_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      return rows[0]?.created_at ? new Date(rows[0].created_at) : null;
    },
    /**
     * @param onlyIfOpen  do not overwrite a job that has already finished.
     *   The server's own timeout path uses this: the worker may have completed
     *   the command and be mid-round-trip with the answer, and stamping "Timed
     *   out." over a real result loses work that actually succeeded — and tells
     *   the model to run it again.
     */
    async completeJob(userId, id, { status, result, onlyIfOpen = false }) {
      await q(
        `UPDATE tool_jobs SET status = $3, result = $4, done_at = NOW()
          WHERE id = $1 AND user_id = $2
            AND ($5::boolean IS NOT TRUE OR status IN ('pending', 'running'))`,
        [id, userId, status, toJson(result ?? null), onlyIfOpen],
      );
    },
    /**
     * Fail everything queued for a machine that has just been unplugged.
     *
     * Without this those rows stay pending for a worker that will never poll
     * again, and the agent waits out the full timeout on every one of them
     * before reporting a failure it could have known about immediately.
     */
    async cancelJobsForDevice(userId, deviceId) {
      await q(
        `UPDATE tool_jobs SET status = 'error', done_at = NOW(),
                              result = '{"error":"That computer was unpaired."}'::jsonb
          WHERE user_id = $1 AND device_id = $2 AND status IN ('pending', 'running')`,
        [userId, deviceId],
      );
    },
    /**
     * Forget finished jobs.
     *
     * Nothing ever deleted these. Every tool call writes a row carrying its
     * arguments and its entire output as JSONB — a `grep` across a repository,
     * a directory listing, sixty kilobytes of build log — and they stayed
     * forever. On a machine used daily that is the fastest-growing table in the
     * database, holding data whose only reader finished with it seconds later.
     *
     * The transcript is the record; this is a queue.
     */
    async pruneFinishedJobs(olderThanHours = 24) {
      await q(
        `DELETE FROM tool_jobs
          WHERE status IN ('done', 'error')
            AND done_at IS NOT NULL
            AND done_at < NOW() - ($1 || ' hours')::interval`,
        [String(olderThanHours)],
      );
    },
    /**
     * Finished workflow runs, past the point anyone looks at them.
     *
     * Each run keeps a summary of what every step said, so a weekly workflow with
     * six steps writes a few kilobytes a week for ever. The comment above `sweep`
     * describes exactly this failure — a table that grows because the tidying was
     * written and never called — so this is wired into it rather than left as a
     * method nobody reaches.
     *
     * Only *finished* runs, and only past the window. A run still going, or one
     * waiting for a person, is the state the feature exists to preserve.
     */
    async pruneWorkflowRuns(keepDays = 60) {
      await q(
        `DELETE FROM workflow_runs
          WHERE status IN ('done', 'failed', 'cancelled')
            AND finished_at IS NOT NULL
            AND finished_at < NOW() - ($1 || ' days')::interval`,
        [String(keepDays)],
      );
    },
    /**
     * Deep-research transcripts, same reasoning.
     *
     * A run stores the whole proposer/critic/arbiter debate and its source
     * ledger. That is there to be audited, which is worth keeping for a while and
     * not for ever; nothing was deleting them at all.
     */
    async pruneResearchRuns(keepDays = 90) {
      await q(
        `DELETE FROM research_runs
          WHERE completed_at IS NOT NULL
            AND completed_at < NOW() - ($1 || ' days')::interval`,
        [String(keepDays)],
      );
    },
    /**
     * Usage rows do not need to be kept for ever.
     *
     * One row per model call *per role* — the turn, each sub-agent, compaction,
     * every research persona, every page extraction — so a single twenty-step
     * agentic turn writes twenty-odd. Heavy daily use is on the order of a
     * thousand rows a day per account, and nothing was ever removing them.
     *
     * The size is the smaller half. `checkQuota` runs `usageThisMonth` on
     * **every turn**, which sums a full calendar month of that account's rows
     * before the model is even called — so the cost of starting a turn grew with
     * how much the account had already used it.
     *
     * A generous window: 400 days keeps a full year-on-year comparison, and the
     * monthly quota only ever reads the current month.
     */
    async pruneUsageEvents(keepDays = 400) {
      await q(
        `DELETE FROM usage_events WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(keepDays)],
      );
    },
    async getJob(userId, id) {
      const rows = await q('SELECT id, status, result FROM tool_jobs WHERE id = $1 AND user_id = $2', [
        id,
        userId,
      ]);
      return rows[0] ?? null;
    },

    // ── worker presence ─────────────────────────────────────────────
    /**
     * A heartbeat may refresh a worker. It may not take one over.
     *
     * This used to set `user_id = EXCLUDED.user_id` on conflict, so whoever
     * beat last owned the row. `app.js` identifies a paired machine by its
     * device row and ignores the id it reports — but it falls back to the
     * client's `workerId` for a legacy worker paired before devices existed, and
     * on that path an account could name somebody else's worker id and take the
     * row. The victim's `activeWorker` then finds nothing, so their local tools
     * stop being offered with no error anywhere.
     *
     * Re-owning was never the intent — it reads as a convenience for a machine
     * that changed hands. A machine that changes hands should be paired again,
     * which is the path that proves who it belongs to.
     */
    async heartbeat(userId, workerId, info) {
      await q(
        `INSERT INTO workers (id, user_id, last_seen, info) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (id) DO UPDATE SET last_seen = NOW(), info = EXCLUDED.info
         WHERE workers.user_id = $2`,
        [workerId, userId, toJson(info ?? {})],
      );
    },
    async activeWorker(userId, withinMs = 45_000) {
      const rows = await q(
        `SELECT id, info, last_seen FROM workers
          WHERE user_id = $1 AND last_seen > NOW() - ($2 || ' milliseconds')::interval
          ORDER BY last_seen DESC LIMIT 1`,
        [userId, String(withinMs)],
      );
      return rows[0] ?? null;
    },
    /**
     * Every computer of this account's that is currently answering.
     *
     * The name of a paired device comes from `devices`; a worker paired before
     * devices existed has no row there and is listed under its own id, which is
     * what it has always been called.
     */
    async activeWorkers(userId, withinMs = 45_000) {
      return q(
        `SELECT w.id, w.info, w.last_seen, d.name
           FROM workers w
           LEFT JOIN devices d ON d.id = w.id AND d.revoked_at IS NULL
          WHERE w.user_id = $1 AND w.last_seen > NOW() - ($2 || ' milliseconds')::interval
          ORDER BY w.last_seen DESC`,
        [userId, String(withinMs)],
      );
    },

    // ── projects ────────────────────────────────────────────────────

    /**
     * The shelf, with the two counts that make a project card worth reading:
     * how many sources are on it and how many conversations came out of it.
     *
     * Archived projects are a separate shelf, never mixed in — `archived: true`
     * asks for that one instead. Pinned projects float to the top of whichever
     * shelf you are looking at.
     */
    async listProjects(userId, { archived = false } = {}) {
      return q(
        `SELECT p.id, p.name, p.instructions, p.grounded, p.pinned, p.archived_at,
                p.created_at, p.updated_at,
                (SELECT COUNT(*)::int FROM project_files f WHERE f.project_id = p.id) AS file_count,
                (SELECT COUNT(*)::int FROM chats c WHERE c.project_id = p.id) AS chat_count
           FROM projects p
          WHERE p.user_id = $1
            AND p.archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
          ORDER BY p.pinned DESC, p.updated_at DESC
          LIMIT 200`,
        [userId],
      );
    },
    async getProject(userId, id) {
      const rows = await q('SELECT * FROM projects WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async createProject(userId, { id, name, instructions = '', grounded = true }) {
      const rows = await q(
        `INSERT INTO projects (id, user_id, name, instructions, grounded)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, userId, name, instructions, grounded],
      );
      return rows[0];
    },
    /**
     * Every field is optional; a `null` argument means "leave it". `archived`
     * is a boolean on the way in but a timestamp in the table, so it gets a
     * CASE rather than a COALESCE — un-archiving has to be able to write NULL,
     * which COALESCE would read as "no change".
     */
    async updateProject(userId, id, patch) {
      const rows = await q(
        `UPDATE projects SET
           name         = COALESCE($3, name),
           instructions = COALESCE($4, instructions),
           grounded     = COALESCE($5, grounded),
           pinned       = COALESCE($6, pinned),
           archived_at  = CASE WHEN $7::boolean IS NULL THEN archived_at
                               WHEN $7::boolean THEN COALESCE(archived_at, NOW())
                               ELSE NULL END,
           updated_at   = NOW()
         WHERE user_id = $1 AND id = $2 RETURNING *`,
        [
          userId,
          id,
          patch.name ?? null,
          patch.instructions ?? null,
          patch.grounded ?? null,
          patch.pinned ?? null,
          patch.archived ?? null,
        ],
      );
      return rows[0] ?? null;
    },
    async deleteProject(userId, id) {
      await q('DELETE FROM projects WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    /** Metadata only. The text is the big column and is rarely what a list wants. */
    async listProjectFiles(userId, projectId) {
      return q(
        `SELECT id, name, mime, kind, bytes, pages, chars, attachment_id, thumb, created_at
           FROM project_files WHERE user_id = $1 AND project_id = $2
          ORDER BY created_at`,
        [userId, projectId],
      );
    },
    /** With the text, for the turn that is about to be grounded in it. */
    /**
     * Every source's full text, bounded.
     *
     * Called on every turn of a project conversation, and each file's `text` is
     * capped at 400,000 characters — but nothing caps the number of *files*, and
     * `selectSources` ranks and trims only after the whole shelf is in memory.
     * Twenty sources is 8MB read and re-ranked per turn, and it grows with the
     * project rather than with the question.
     *
     * A hundred is far beyond any shelf that could be usefully ranked against
     * one question, and oldest-first so the bound is stable: the same hundred
     * files answer every turn, rather than the set shifting as files are added
     * and an answer quietly changing because a source fell off the end.
     */
    async readProjectFiles(userId, projectId, limit = 100) {
      return q(
        `SELECT id, name, mime, kind, pages, chars, text, attachment_id
           FROM project_files WHERE user_id = $1 AND project_id = $2
          ORDER BY created_at
          LIMIT $3`,
        [userId, projectId, Math.max(1, Math.min(Number(limit) || 100, 500))],
      );
    },
    async addProjectFile(userId, projectId, file) {
      const rows = await q(
        `INSERT INTO project_files (id, project_id, user_id, name, mime, kind, bytes, pages, text, chars, attachment_id, thumb)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, name, mime, kind, bytes, pages, chars, attachment_id, thumb, created_at`,
        [
          file.id,
          projectId,
          userId,
          file.name,
          file.mime,
          file.kind ?? null,
          file.bytes,
          file.pages ?? null,
          file.text,
          file.text.length,
          file.attachmentId ?? null,
          file.thumb ?? null,
        ],
      );
      // `AND user_id` because this one had no ownership test at all — not in the
      // statement and not above it. The INSERT before it carries user_id, so a
      // caller reaching addProjectFile with someone else's projectId would file
      // the row under its own account and then touch a project it does not own.
      await q('UPDATE projects SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [projectId, userId]);
      return rows[0];
    },
    /**
     * Remove a source, and the original it kept.
     *
     * The attachment goes too. It was stored for this source and nothing else
     * points at it, so leaving it behind is a file nobody can reach, counting
     * against the account's storage forever — which on a free tier is the kind
     * of leak that is invisible until the database is full.
     */
    async deleteProjectFile(userId, id) {
      const rows = await q(
        'DELETE FROM project_files WHERE user_id = $1 AND id = $2 RETURNING attachment_id',
        [userId, id],
      );
      const attachmentId = rows[0]?.attachment_id;
      if (attachmentId) await q('DELETE FROM attachments WHERE user_id = $1 AND id = $2', [userId, attachmentId]);
    },

    /** The conversations belonging to one project, newest first. */
    async listProjectChats(userId, projectId) {
      return q(
        `SELECT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at,
                (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS message_count
           FROM chats c
          WHERE c.user_id = $1 AND c.project_id = $2
            AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id)
          ORDER BY c.updated_at DESC
          LIMIT 200`,
        [userId, projectId],
      );
    },

    // ── skills ──────────────────────────────────────────────────────
    async listSkills(userId, onlyEnabled = false) {
      return q(
        `SELECT * FROM skills WHERE user_id = $1 ${onlyEnabled ? 'AND enabled' : ''}
          ORDER BY lower(name)`,
        [userId],
      );
    },
    async getSkill(userId, id) {
      const rows = await q('SELECT * FROM skills WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    /** Upsert by name, so teaching the same thing twice refines it rather than duplicating it. */
    async saveSkill(userId, { id, name, description, instructions }) {
      const rows = await q(
        `INSERT INTO skills (id, user_id, name, description, instructions)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET
           description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           updated_at = NOW()
      RETURNING *`,
        [id, userId, name, description, instructions],
      );
      return rows[0];
    },
    async setSkillEnabled(userId, id, enabled) {
      const rows = await q(
        'UPDATE skills SET enabled = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2 RETURNING *',
        [userId, id, enabled],
      );
      return rows[0] ?? null;
    },
    async noteSkillUsed(userId, name) {
      await q(
        'UPDATE skills SET used_count = used_count + 1 WHERE user_id = $1 AND lower(name) = lower($2)',
        [userId, name],
      );
    },
    async deleteSkill(userId, id) {
      await q('DELETE FROM skills WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    // ── indexed documents ───────────────────────────────────────────
    //
    // Every one of these filters on user_id. Documents are the most personal
    // thing in the database — somebody's contracts, their notes, their medical
    // letters — so this is the boundary that matters most, not the least.

    /** What is already indexed under a source, so a re-index can skip it. */
    async docStamps(userId, source) {
      return q(
        'SELECT path, MAX(mtime) AS mtime, MAX(model) AS model FROM doc_chunks WHERE user_id = $1 AND source = $2 GROUP BY path',
        [userId, source],
      );
    },

    /**
     * Replace one file's chunks wholesale.
     *
     * Delete-then-insert rather than upsert by ordinal: an edited file usually
     * has a *different number* of chunks, and upserting would leave the tail of
     * the previous version behind as text that is no longer in any document.
     */
    /**
     * Swap one file's chunks for its new ones, all or nothing.
     *
     * This was a `DELETE` followed by one `INSERT` per chunk in a loop — up to
     * 129 sequential statements per file, and, far worse, **no transaction**.
     * A failure anywhere after the delete left the file's previous index
     * destroyed and the replacement half written: the user's document silently
     * stopped being searchable, with nothing surfaced to say so. `search_docs`
     * exists precisely to stop the assistant claiming it does not know
     * something that is on their disk, so a half-built index is the one failure
     * this table must not have.
     *
     * The rewrite does both halves at once. `unnest` turns the whole batch into
     * a single INSERT, and where the driver has `transaction` the delete and
     * the insert commit together or not at all.
     */
    /**
     * Every file in one batch, in two statements rather than two per file.
     *
     * `replaceDocChunks` is properly bulk for one path — one `unnest` insert for
     * however many chunks it has. The caller then ran it in a loop, once per
     * file, on a driver whose defining property is one round trip per statement:
     * indexing a source tree of forty files paid forty sequential round trips
     * with all the data already in hand.
     *
     * The DELETE takes the whole set of paths at once and the INSERT takes every
     * row, so the cost stops scaling with the number of files. Where the driver
     * has `transaction` the pair commits together, which also makes the batch
     * atomic across files rather than merely within each one — a partial index
     * refresh is a worse thing to leave behind than a failed one.
     */
    async replaceDocChunksMany(userId, groups) {
      const entries = [...groups].filter(([, rows]) => Array.isArray(rows));
      if (!entries.length) return;

      const paths = entries.map(([p]) => p);
      const rows = entries.flatMap(([p, list]) => list.map((r) => ({ ...r, path: p })));

      const del = ['DELETE FROM doc_chunks WHERE user_id = $1 AND path = ANY($2::text[])', [userId, paths]];
      if (!rows.length) {
        await q(...del);
        return;
      }

      const ins = [
        `INSERT INTO doc_chunks (id, user_id, source, path, ordinal, heading, text, embedding, dims, model, mtime)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[],
           $7::text[], $8::text[], $9::int[], $10::text[], $11::bigint[]
         )`,
        [
          rows.map((r) => r.id),
          rows.map(() => userId),
          rows.map((r) => r.source),
          rows.map((r) => r.path),
          rows.map((r) => r.ordinal),
          rows.map((r) => r.heading ?? null),
          rows.map((r) => r.text),
          rows.map((r) => r.embedding),
          rows.map((r) => r.dims),
          rows.map((r) => r.model),
          rows.map((r) => r.mtime ?? null),
        ],
      ];

      if (typeof sql.transaction === 'function') {
        await ready();
        await sql.transaction([sql.query(del[0], del[1]), sql.query(ins[0], ins[1])]);
        return;
      }
      // PGlite: no batch API, so two statements rather than one transaction —
      // the same limitation `replaceDocChunks` documents, and the same one
      // PERF-011 records as a local-development hazard.
      await q(...del);
      await q(...ins);
    },

    async replaceDocChunks(userId, path, rows) {
      const del = ['DELETE FROM doc_chunks WHERE user_id = $1 AND path = $2', [userId, path]];

      if (!rows.length) {
        await q(...del);
        return;
      }

      const columns = [
        rows.map((r) => r.id),
        rows.map(() => userId),
        rows.map((r) => r.source),
        rows.map(() => path),
        rows.map((r) => r.ordinal),
        rows.map((r) => r.heading ?? null),
        rows.map((r) => r.text),
        rows.map((r) => r.embedding),
        rows.map((r) => r.dims),
        rows.map((r) => r.model),
        rows.map((r) => r.mtime ?? null),
      ];
      const ins = [
        `INSERT INTO doc_chunks (id, user_id, source, path, ordinal, heading, text, embedding, dims, model, mtime)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[],
           $7::text[], $8::text[], $9::int[], $10::text[], $11::bigint[]
         )`,
        columns,
      ];

      if (typeof sql.transaction === 'function') {
        await ready();
        await sql.transaction([sql.query(del[0], del[1]), sql.query(ins[0], ins[1])]);
        return;
      }
      // The driver-object path (the isolation tests, PGlite) has no batch API.
      // Still one statement per side rather than one per chunk.
      await q(...del);
      await q(...ins);
    },

    /**
     * Just enough to rank by: id, vector, and where it came from.
     *
     * The text is deliberately left behind — it is by far the largest column, and
     * pulling every chunk's prose across the wire to score it and throw all but
     * eight away is the difference between a search that feels instant and one
     * that does not.
     */
    /**
     * One page of an account's vectors, walked by id.
     *
     * This used to be `SELECT … WHERE user_id AND model` with no bound at all,
     * and the caller held every row it returned. The arithmetic is unforgiving:
     * a 1536-dimension vector is 6,144 bytes, which is 8,192 characters of
     * base64, so ten thousand chunks is ~82MB pulled over the wire and held in
     * memory *per search*, and fifty thousand is over 400MB — past what a
     * 1024MB serverless function survives, and the file's own comment named
     * fifty thousand as the working ceiling.
     *
     * Paging by id lets the caller keep a bounded top-K and throw the rest away
     * as it goes, so peak memory is the size of K rather than the size of the
     * corpus. It is still a full scan — that is what an exact nearest-neighbour
     * search is — but a full scan that streams is a different proposition from
     * one that accumulates.
     */
    /**
     * @param source  narrow the scan to folders whose name contains this.
     *   Applied here rather than to the results, because filtering afterwards
     *   filters a shortlist that was already chosen from the whole corpus — see
     *   the note in `rag.js`.
     */
    async docVectorPage(userId, model, { after = null, limit = 2000, source = null } = {}) {
      return q(
        `SELECT id, path, source, embedding FROM doc_chunks
          WHERE user_id = $1 AND model = $2 AND ($3::text IS NULL OR id > $3)
            AND ($5::text IS NULL OR source ILIKE '%' || $5 || '%')
          ORDER BY id
          LIMIT $4`,
        [userId, model, after, Math.max(1, Math.min(Number(limit) || 2000, 10_000)), source],
      );
    },

    /**
     * Nearest neighbours computed by the database, where the database can.
     *
     * Only meaningful with pgvector installed and the companion column
     * populated; `vectorSearchReady()` is what decides whether this is called at
     * all. Returns null rather than throwing when the extension is absent, so
     * the caller falls back to the streaming scan above instead of failing.
     */
    async docVectorNearest(userId, model, queryVector, limit = 40) {
      try {
        const literal = `[${Array.from(queryVector).join(',')}]`;
        return await q(
          `SELECT id, path, 1 - (embedding_vec <=> $3::vector) AS score
             FROM doc_chunks
            WHERE user_id = $1 AND model = $2 AND embedding_vec IS NOT NULL
            ORDER BY embedding_vec <=> $3::vector
            LIMIT $4`,
          [userId, model, literal, Math.max(1, Math.min(Number(limit) || 40, 500))],
        );
      } catch {
        // No extension, no column, or a dimension mismatch. All three mean the
        // same thing to the caller: do it the other way.
        return null;
      }
    },

    /**
     * Whether this database can answer a nearest-neighbour query itself.
     *
     * Probed rather than assumed, and cached for the life of the process: Neon
     * ships pgvector and the in-process Postgres a laptop runs does not, and the
     * same code has to be correct on both.
     */
    /**
     * The extension **and** the column it would query.
     *
     * This asked only whether pgvector was installed. `docVectorNearest`
     * queries `doc_chunks.embedding_vec`, and that column exists nowhere in this
     * repository — not in schema.sql, not in any migration, and nothing writes
     * it. So on a database where somebody had run `CREATE EXTENSION vector` by
     * hand, the probe answered yes and every search then paid one
     * guaranteed-to-fail round trip before falling back, with the failure
     * swallowed so it showed up only as latency nobody could explain.
     *
     * Asking for the column as well makes the probe mean what its name says.
     * The streaming fallback is correct and bounded, so answering `false` here
     * costs nothing but the round trip it saves.
     */
    async vectorSearchReady() {
      if (vectorReady !== null) return vectorReady;
      try {
        const ext = await q("SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'");
        if (!ext.length) {
          vectorReady = false;
          return vectorReady;
        }
        const column = await q(
          `SELECT 1 AS ok FROM information_schema.columns
            WHERE table_name = 'doc_chunks' AND column_name = 'embedding_vec'`,
        );
        vectorReady = column.length > 0;
      } catch {
        vectorReady = false;
      }
      return vectorReady;
    },

    async docChunks(userId, ids) {
      if (!ids.length) return [];
      const params = ids.map((_, i) => `$${i + 2}`).join(', ');
      return q(`SELECT * FROM doc_chunks WHERE user_id = $1 AND id IN (${params})`, [userId, ...ids]);
    },

    async docSources(userId) {
      return q(
        `SELECT source, COUNT(*)::int AS chunks, COUNT(DISTINCT path)::int AS files,
                MAX(model) AS model, MAX(created_at) AS indexed_at
           FROM doc_chunks WHERE user_id = $1 GROUP BY source ORDER BY MAX(created_at) DESC`,
        [userId],
      );
    },

    async deleteDocs(userId, source) {
      const rows = await q(
        'DELETE FROM doc_chunks WHERE user_id = $1 AND ($2::text IS NULL OR source = $2) RETURNING id',
        [userId, source ?? null],
      );
      return rows.length;
    },

    // ── scheduled tasks ─────────────────────────────────────────────
    async listTasks(userId) {
      return q('SELECT * FROM scheduled_tasks WHERE user_id = $1 ORDER BY next_run_at', [userId]);
    },
    async createTask(userId, task) {
      const rows = await q(
        `INSERT INTO scheduled_tasks (id, user_id, title, prompt, model, cron, next_run_at, tz, project_id, policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          task.id,
          userId,
          task.title,
          task.prompt,
          task.model ?? null,
          task.cron ?? null,
          // Null for a manual task: the due query compares against it, and
          // NULL matches neither side, so it is simply never due.
          task.nextRunAt ?? null,
          task.tz ?? null,
          task.projectId ?? null,
          task.policy ?? null,
        ],
      );
      return rows[0];
    },

    /** One task, by id, for the page that shows it on its own. */
    async getTask(userId, id) {
      const rows = await q('SELECT * FROM scheduled_tasks WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },

    /** The tasks filed under one project, for its own Scheduled list. */
    async listProjectTasks(userId, projectId) {
      return q(
        `SELECT * FROM scheduled_tasks
          WHERE user_id = $1 AND project_id = $2
          ORDER BY created_at DESC`,
        [userId, projectId],
      );
    },
    async setTaskEnabled(userId, id, enabled) {
      const rows = await q(
        'UPDATE scheduled_tasks SET enabled = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
        [userId, id, enabled],
      );
      return rows[0] ?? null;
    },
    async deleteTask(userId, id) {
      await q('DELETE FROM scheduled_tasks WHERE user_id = $1 AND id = $2', [userId, id]);
    },
    /**
     * Claim one due task atomically.
     *
     * The update *is* the claim: pushing `next_run_at` forward in the same
     * statement that selects it means two schedulers — or two serverless
     * invocations — cannot both pick up the same task and run it twice.
     */
    /**
     * Claim one due task, and record that it has *started*.
     *
     * The hour pushed onto `next_run_at` was the only thing standing between a
     * killed invocation and an infinite loop: nothing wrote an outcome until the
     * whole agent turn had finished, so a run cut off at the function ceiling
     * left no trace at all and the task came due again an hour later with the
     * same prompt. "Every Friday, email the summary" became an email every hour,
     * for ever, with `last_status` never showing anything wrong.
     *
     * `run_state = 'running'` plus a lease is the marker that was missing. A
     * task found still running with an expired lease is not re-run — see
     * `reapStalledTasks` — because nobody can say whether the email went out,
     * and repeating an unattended side effect is worse than stopping to ask.
     * `workflow_runs` has always worked this way; tasks simply never did.
     */
    async claimDueTask(now = new Date().toISOString(), userId = null, leaseMs = 600_000) {
      const rows = await q(
        `UPDATE scheduled_tasks
            SET next_run_at = next_run_at + INTERVAL '1 hour',
                last_run_at = NOW(),
                run_state   = 'running',
                started_at  = NOW(),
                lease_until = NOW() + ($3 || ' milliseconds')::interval
          WHERE id = (SELECT id FROM scheduled_tasks
                       WHERE enabled AND next_run_at <= $1
                         AND ($2::text IS NULL OR user_id = $2)
                         AND (run_state IS DISTINCT FROM 'running'
                              OR lease_until IS NULL
                              OR lease_until <= NOW())
                       ORDER BY next_run_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
      RETURNING *`,
        [now, userId, String(leaseMs)],
      );
      return rows[0] ?? null;
    },
    /**
     * Tasks whose invocation died holding the lease.
     *
     * Marked for a person rather than retried, and disabled so the hourly
     * re-claim stops: the whole point is that an unattended side effect which
     * may or may not have happened is not something to repeat on a guess.
     *
     * @returns the tasks that were stopped, so the caller can say so.
     */
    /**
     * @param userId scope it to one account, or omit for every account.
     *
     * The scoped form exists because this used to run only inside `sweep()`,
     * and on a deployment `sweep()` runs only from the cron — which on Vercel's
     * free tier is once a day. A task killed mid-run at nine in the morning sat
     * marked `running` until the next afternoon, holding its lease, so it was
     * neither retried nor reported. Opening the app already nudges that
     * account's queue along; this lets the reap ride with it, and stays scoped
     * because that route is explicit that a user request must never sweep
     * everybody's queue.
     */
    async reapStalledTasks(userId = null) {
      const rows = await q(
        `UPDATE scheduled_tasks
            SET run_state = 'needs_attention',
                enabled = FALSE,
                last_status = 'stopped mid-run — it may or may not have finished, so it was not repeated'
          WHERE run_state = 'running' AND lease_until IS NOT NULL AND lease_until <= NOW()
            AND ($1::text IS NULL OR user_id = $1)
      RETURNING id, user_id, title`,
        [userId],
      );
      return rows;
    },
    /** Record the outcome and set the real next run, or retire a one-shot. */
    /**
     * The conversation a task run is writing into, recorded as it starts rather
     * than only when it ends — so the sidebar can show that run while it runs,
     * and "open the result" reaches it before it has finished.
     */
    async markTaskChat(id, chatId) {
      await q('UPDATE scheduled_tasks SET last_chat = $2 WHERE id = $1', [id, chatId]);
    },

    async finishTask(id, { status, chatId, nextRunAt }) {
      // The lease is given up here and nowhere else. A task left marked
      // `running` is precisely the signal `reapStalledTasks` reads, so clearing
      // it is what distinguishes "finished" from "died holding it".
      if (nextRunAt) {
        await q(
          `UPDATE scheduled_tasks
              SET last_status = $2, last_chat = $3, next_run_at = $4,
                  run_state = NULL, lease_until = NULL
            WHERE id = $1`,
          [id, status, chatId ?? null, nextRunAt],
        );
      } else {
        await q(
          `UPDATE scheduled_tasks
              SET last_status = $2, last_chat = $3, enabled = FALSE,
                  run_state = NULL, lease_until = NULL
            WHERE id = $1`,
          [id, status, chatId ?? null],
        );
      }
    },

    // ── workflows ───────────────────────────────────────────────────
    async listWorkflows(userId) {
      return q('SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    },
    /**
     * Every workflow with the state of its most recent run, in one query.
     *
     * The shelf's whole purpose is showing which step stopped, so it needs the
     * last run of each — and fetching them one at a time is the N+1 CLAUDE.md §7
     * names outright. `DISTINCT ON` is the Postgres way to say "the newest row
     * per group" without a correlated subquery per workflow.
     */
    async listWorkflowsWithLastRun(userId) {
      return q(
        `SELECT w.*,
                r.id          AS run_id,
                r.status      AS run_status,
                r.steps       AS run_steps,
                r.chat_id     AS run_chat_id,
                r.cursor      AS run_cursor,
                r.started_at  AS run_started_at,
                r.finished_at AS run_finished_at
           FROM workflows w
           LEFT JOIN (
             SELECT DISTINCT ON (workflow_id) *
               FROM workflow_runs
              WHERE user_id = $1
              ORDER BY workflow_id, started_at DESC
           ) r ON r.workflow_id = w.id
          WHERE w.user_id = $1
          ORDER BY w.created_at DESC`,
        [userId],
      );
    },
    async getWorkflow(userId, id) {
      const rows = await q('SELECT * FROM workflows WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async createWorkflow(userId, wf) {
      const rows = await q(
        `INSERT INTO workflows (id, user_id, title, steps, model, cron, tz, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          wf.id,
          userId,
          wf.title,
          toJson(wf.steps),
          wf.model ?? null,
          wf.cron ?? null,
          wf.tz ?? null,
          wf.nextRunAt ?? null,
        ],
      );
      return rows[0];
    },
    /**
     * Only the fields named are touched. A workflow is edited in the middle of
     * its own life — turning one off must not silently rewrite its steps.
     */
    async updateWorkflow(userId, id, patch) {
      const sets = [];
      const args = [userId, id];
      const put = (column, value) => {
        args.push(value);
        sets.push(`${column} = $${args.length}`);
      };

      if (patch.title !== undefined) put('title', patch.title);
      if (patch.steps !== undefined) put('steps', toJson(patch.steps));
      if (patch.model !== undefined) put('model', patch.model);
      if (patch.cron !== undefined) put('cron', patch.cron);
      if (patch.tz !== undefined) put('tz', patch.tz);
      if (patch.nextRunAt !== undefined) put('next_run_at', patch.nextRunAt);
      if (patch.enabled !== undefined) put('enabled', patch.enabled);
      if (!sets.length) {
        // Nothing asked for. Return the row unchanged rather than building an
        // `UPDATE ... SET` with no assignments, which is a syntax error.
        const [current] = await q('SELECT * FROM workflows WHERE user_id = $1 AND id = $2', [userId, id]);
        return current ?? null;
      }

      const rows = await q(
        `UPDATE workflows SET ${sets.join(', ')} WHERE user_id = $1 AND id = $2 RETURNING *`,
        args,
      );
      return rows[0] ?? null;
    },
    async deleteWorkflow(userId, id) {
      await q('DELETE FROM workflows WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    /**
     * Claim one workflow that is due, the way `claimDueTask` does.
     *
     * Pushing `next_run_at` an hour forward in the statement that selects it is
     * the lease: a second invocation arriving in the same second finds nothing
     * due. The caller then sets the real next run from the cron.
     */
    async claimDueWorkflow(now = new Date().toISOString(), userId = null) {
      const rows = await q(
        `UPDATE workflows SET next_run_at = next_run_at + INTERVAL '1 hour'
          WHERE id = (SELECT id FROM workflows
                       WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1
                         AND ($2::text IS NULL OR user_id = $2)
                       ORDER BY next_run_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
      RETURNING *`,
        [now, userId],
      );
      return rows[0] ?? null;
    },

    // ── workflow runs ───────────────────────────────────────────────
    async createWorkflowRun(userId, run) {
      const rows = await q(
        `INSERT INTO workflow_runs (id, workflow_id, user_id, chat_id, status, steps, cursor, lease_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          run.id,
          run.workflowId,
          userId,
          run.chatId ?? null,
          run.status ?? 'running',
          toJson(run.steps),
          run.cursor ?? 0,
          run.leaseUntil ?? null,
        ],
      );
      return rows[0];
    },
    async listWorkflowRuns(userId, workflowId, limit = 10) {
      return q(
        `SELECT * FROM workflow_runs WHERE user_id = $1 AND workflow_id = $2
          ORDER BY started_at DESC LIMIT $3`,
        [userId, workflowId, limit],
      );
    },
    async getWorkflowRun(userId, id) {
      const rows = await q('SELECT * FROM workflow_runs WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    /**
     * Take the lease on one run that is due to be worked on.
     *
     * The same trick as `claimDueTask`: the update *is* the claim. A run whose
     * lease has not expired is invisible here, so a second invocation cannot
     * start executing steps the first one is part-way through.
     *
     * `SKIP LOCKED` handles two processes racing; `lease_until` handles one
     * process dying. Both happen on a serverless host, for different reasons.
     */
    async claimWorkflowRun({ now = new Date().toISOString(), leaseUntil, userId = null, id = null } = {}) {
      const rows = await q(
        `UPDATE workflow_runs SET lease_until = $2
          WHERE id = (SELECT id FROM workflow_runs
                       WHERE status = 'running'
                         AND (lease_until IS NULL OR lease_until <= $1)
                         AND ($3::text IS NULL OR user_id = $3)
                         AND ($4::text IS NULL OR id = $4)
                       ORDER BY started_at LIMIT 1
                       FOR UPDATE SKIP LOCKED)
      RETURNING *`,
        [now, leaseUntil, userId, id],
      );
      return rows[0] ?? null;
    },
    /**
     * Is a run of this workflow already going?
     *
     * Pressing "Run now" twice must not start the job twice. The lease stops two
     * processes working the *same* run; it says nothing about a second run of the
     * same definition, and each one costs a full set of model calls.
     */
    async openWorkflowRun(userId, workflowId) {
      const rows = await q(
        `SELECT * FROM workflow_runs
          WHERE user_id = $1 AND workflow_id = $2 AND status = 'running'
          ORDER BY started_at LIMIT 1`,
        [userId, workflowId],
      );
      return rows[0] ?? null;
    },
    /** Write back position and per-step state, keeping the lease as given. */
    async saveWorkflowRun(id, { status, steps, cursor, chatId, leaseUntil, finished }) {
      const rows = await q(
        `UPDATE workflow_runs
            SET status      = COALESCE($2, status),
                steps       = COALESCE($3::jsonb, steps),
                cursor      = COALESCE($4, cursor),
                chat_id     = COALESCE($5, chat_id),
                lease_until = $6,
                finished_at = CASE WHEN $7 THEN NOW() ELSE finished_at END
          WHERE id = $1 RETURNING *`,
        [
          id,
          status ?? null,
          steps ? toJson(steps) : null,
          cursor ?? null,
          chatId ?? null,
          leaseUntil ?? null,
          Boolean(finished),
        ],
      );
      return rows[0] ?? null;
    },

    // ── connectors ──────────────────────────────────────────────────
    async listConnectors(userId) {
      // Never the token itself — the browser has no use for it and every
      // reason not to have it.
      return q('SELECT service, account, created_at FROM connectors WHERE user_id = $1 ORDER BY service', [
        userId,
      ]);
    },
    async getConnector(userId, service) {
      const rows = await q('SELECT * FROM connectors WHERE user_id = $1 AND service = $2', [userId, service]);
      return rows[0] ?? null;
    },
    async saveConnector(userId, service, token, account) {
      await q(
        `INSERT INTO connectors (user_id, service, token, account) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, service) DO UPDATE SET token = EXCLUDED.token, account = EXCLUDED.account`,
        [userId, service, token, account ?? null],
      );
    },
    async deleteConnector(userId, service) {
      await q('DELETE FROM connectors WHERE user_id = $1 AND service = $2', [userId, service]);
    },

    // ── shared model library ────────────────────────────────────────
    /**
     * Upsert a batch from the daily refresh. `added_by` and `created_at` are
     * preserved so "who first added this" and the original discovery date
     * survive every refresh.
     */
    /**
     * The whole catalogue in a handful of statements, not one per model.
     *
     * This was a loop issuing one INSERT per model. The daily OpenRouter
     * refresh carries the entire library — several hundred to well over a
     * thousand rows — and on Neon each one is its own HTTP round trip inside a
     * cron route that shares the 300-second function ceiling. At 40ms a trip
     * that is 40 seconds of pure latency; at 150ms it does not finish at all,
     * and the library silently stops being refreshed.
     *
     * Batched with `unnest` at 200 rows a statement: a thousand round trips
     * becomes five. Chunked rather than sent whole so a very large catalogue
     * cannot approach the parameter or payload limits.
     */
    async upsertModels(models) {
      const BATCH = 200;
      for (let i = 0; i < models.length; i += BATCH) {
        const slice = models.slice(i, i + BATCH);
        await q(
          `INSERT INTO shared_models
             (id, provider, model, family, label, description, context,
              price_in, price_out, is_free, released_at, added_by, vision,
              max_output, refreshed_at)
           SELECT *, NOW() FROM unnest(
             $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
             $7::bigint[], $8::double precision[], $9::double precision[],
             $10::boolean[], $11::timestamptz[], $12::text[], $13::boolean[], $14::int[]
           )
           ON CONFLICT (id) DO UPDATE SET
             provider    = EXCLUDED.provider,
             model       = EXCLUDED.model,
             family      = EXCLUDED.family,
             label       = EXCLUDED.label,
             description = EXCLUDED.description,
             context     = EXCLUDED.context,
             price_in    = EXCLUDED.price_in,
             price_out   = EXCLUDED.price_out,
             is_free     = EXCLUDED.is_free,
             released_at = EXCLUDED.released_at,
             vision      = EXCLUDED.vision,
             max_output  = EXCLUDED.max_output,
             refreshed_at = NOW()`,
          [
            slice.map((m) => m.id),
            slice.map((m) => m.provider),
            slice.map((m) => m.model),
            slice.map((m) => m.family),
            slice.map((m) => m.label),
            slice.map((m) => m.description ?? null),
            slice.map((m) => m.context ?? null),
            slice.map((m) => m.priceIn ?? null),
            slice.map((m) => m.priceOut ?? null),
            slice.map((m) => !!m.isFree),
            slice.map((m) => m.releasedAt ?? null),
            slice.map((m) => m.addedBy ?? null),
            slice.map((m) => !!m.vision),
            slice.map((m) => m.maxOutput ?? null),
          ],
        );
      }
      return models.length;
    },

    /**
     * Search and filter the library. Sorting defaults to newest-first by the
     * vendor's release date, which is what people actually want when scanning
     * for something new to try.
     */
    async listSharedModels({ query, family, tier, sort = 'new', limit = 300, provider } = {}) {
      const where = [];
      const values = [];

      // Filtered at the database, not on the client, so the row limit cannot
      // hide a whole provider: with two aggregators the newest models are mostly
      // one of them, and the other never reached a client-side filter.
      if (provider && provider !== 'all') {
        values.push(provider);
        where.push(`provider = $${values.length}`);
      }
      if (query) {
        values.push(`%${String(query).toLowerCase()}%`);
        where.push(`(LOWER(id) LIKE $${values.length} OR LOWER(label) LIKE $${values.length}
                     OR LOWER(COALESCE(description, '')) LIKE $${values.length})`);
      }
      if (family && family !== 'all') {
        values.push(family);
        where.push(`family = $${values.length}`);
      }
      if (tier === 'free') where.push('is_free = TRUE');
      else if (tier === 'paid') where.push('is_free = FALSE');

      const order =
        {
          new: 'released_at DESC NULLS LAST, created_at DESC',
          old: 'released_at ASC NULLS LAST, created_at ASC',
          name: 'label ASC',
          cheap: 'is_free DESC, price_in ASC NULLS LAST',
          context: 'context DESC NULLS LAST',
        }[sort] || 'released_at DESC NULLS LAST';

      values.push(Math.min(Number(limit) || 300, 1000));
      return q(
        `SELECT * FROM shared_models
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY ${order}
          LIMIT $${values.length}`,
        values,
      );
    },

    // ── MCP servers ─────────────────────────────────────────────────
    //
    // Every one of these is scoped by user_id, and that is the whole security
    // story: a stdio server is a program that runs on the machine, so one account
    // being able to read or write another's row would be one account choosing what
    // another account executes.
    async listMcpServers(userId) {
      return q('SELECT * FROM mcp_servers WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    },
    async getMcpServer(userId, id) {
      const rows = await q('SELECT * FROM mcp_servers WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },
    async saveResearchRun(userId, run) {
      const rows = await q(
        `INSERT INTO research_runs
           (id, user_id, chat_id, question, status, transcript, sources, report, tokens_in, tokens_out, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, transcript = EXCLUDED.transcript, sources = EXCLUDED.sources,
           report = EXCLUDED.report, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out,
           completed_at = NOW()
         WHERE research_runs.user_id = $2
         RETURNING *`,
        [
          run.id,
          userId,
          run.chatId ?? null,
          run.question,
          run.status,
          toJson(run.transcript ?? []),
          toJson(run.sources ?? []),
          run.report ?? null,
          run.tokensIn ?? 0,
          run.tokensOut ?? 0,
        ],
      );
      // The `WHERE` above means a run id owned by another account matches
      // nothing and returns nothing, rather than being overwritten. Said out
      // loud, because a bare `rows[0]` going undefined is the kind of silence
      // that gets read as "the write worked" three call sites later.
      if (!rows[0]) throw new Error('That research run belongs to another account.');
      return rows[0];
    },
    async getResearchRun(userId, id) {
      const rows = await q('SELECT * FROM research_runs WHERE user_id = $1 AND id = $2', [userId, id]);
      return rows[0] ?? null;
    },

    /**
     * The `WHERE` on the conflict is the ownership check, and it has to be here.
     *
     * `id` is client-supplied — `routes/mcp.js` takes `req.body?.id` and only
     * falls back to a fresh uuid — and the conflict target is the global primary
     * key. Without the predicate, posting somebody else's server id rewrote
     * their `name`, `config` and `enabled`, from any signed-in account. An MCP
     * config is a program that runs on that account's machine or a URL its agent
     * will trust, so this is not a settings scribble.
     *
     * A conflicting row owned by somebody else now matches nothing, so the
     * statement updates nothing and inserts nothing — and `getMcpServer` scopes
     * by `userId`, so it answers null. Turned into a refusal rather than left as
     * a null: the route would have done `saved.id` on it and returned a 500,
     * which reads as a bug in the app rather than as the boundary holding.
     */
    async saveMcpServer(userId, server) {
      await q(
        `INSERT INTO mcp_servers (id, user_id, name, config, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, config = EXCLUDED.config, enabled = EXCLUDED.enabled
         WHERE mcp_servers.user_id = $2`,
        [server.id, userId, server.name, toJson(server.config ?? {}), server.enabled !== false],
      );
      const saved = await this.getMcpServer(userId, server.id);
      if (!saved) throw new Error('That server id belongs to another account.');
      return saved;
    },
    async setMcpServerEnabled(userId, id, enabled) {
      await q('UPDATE mcp_servers SET enabled = $3 WHERE user_id = $1 AND id = $2', [userId, id, !!enabled]);
      return this.getMcpServer(userId, id);
    },
    async deleteMcpServer(userId, id) {
      await q('DELETE FROM mcp_servers WHERE user_id = $1 AND id = $2', [userId, id]);
    },

    async getSharedModel(id) {
      const rows = await q('SELECT * FROM shared_models WHERE id = $1', [id]);
      return rows[0] ?? null;
    },


    /** Drives the "is the library stale?" check and the freshness label. */
    async modelLibraryStatus() {
      const rows = await q(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_free)::int AS free,
                MAX(refreshed_at) AS refreshed_at
           FROM shared_models`,
      );
      const r = rows[0] || {};
      return {
        total: Number(r.total || 0),
        free: Number(r.free || 0),
        refreshedAt: r.refreshed_at ?? null,
      };
    },

    /** Families present in the library, for the filter chips. */
    async modelFamilies() {
      return q(
        `SELECT family, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE is_free)::int AS free
           FROM shared_models GROUP BY family ORDER BY COUNT(*) DESC`,
      );
    },

    // ── the live screen ─────────────────────────────────────────────
    // Deliberately leaves watched_at alone — a new frame must not clear the
    // record of someone watching, or the stream throttles itself to a stop.
    async putScreen(userId, { frame, meta }) {
      await q(
        `INSERT INTO screens (user_id, frame, meta, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE SET frame = EXCLUDED.frame, meta = EXCLUDED.meta, updated_at = NOW()`,
        [userId, frame, toJson(meta ?? {})],
      );
    },
    async getScreen(userId) {
      const rows = await q('SELECT frame, meta, updated_at FROM screens WHERE user_id = $1', [userId]);
      return rows[0] ?? null;
    },
    /** Records that a browser is actually looking, so the worker can idle down. */
    async markWatching(userId) {
      await q(
        `INSERT INTO screens (user_id, watched_at, updated_at) VALUES ($1, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET watched_at = NOW()`,
        [userId],
      );
    },
    async isWatched(userId, withinMs = 12_000) {
      const rows = await q(
        `SELECT watched_at > NOW() - ($2 || ' milliseconds')::interval AS watching
           FROM screens WHERE user_id = $1`,
        [userId, String(withinMs)],
      );
      return rows[0]?.watching === true;
    },
    /**
     * Drop the stored frame.
     *
     * A frame is a photograph of somebody's actual desktop, and the row was only
     * ever overwritten — so the last thing the assistant saw sat in the database
     * indefinitely after the sandbox closed and after they signed out. Signing
     * out, closing the sandbox and deleting the account all clear it now.
     */
    async clearScreen(userId) {
      await q('UPDATE screens SET frame = NULL, meta = $2 WHERE user_id = $1', [userId, '{}']);
    },

    // ── throttling ──────────────────────────────────────────────────
    /**
     * Count one attempt against a bucket and say whether it is over the line.
     *
     * A single upsert does the whole job: an expired window is reset in the same
     * statement that increments it, so there is no read-then-write race between
     * two simultaneous guesses at the same password.
     */
    async hitRateLimit(bucket, limit, windowMs) {
      const rows = await q(
        `INSERT INTO rate_limits (bucket, count, expires_at)
         VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval)
         ON CONFLICT (bucket) DO UPDATE SET
           count = CASE WHEN rate_limits.expires_at < NOW() THEN 1 ELSE rate_limits.count + 1 END,
           expires_at = CASE WHEN rate_limits.expires_at < NOW()
                             THEN NOW() + ($2 || ' milliseconds')::interval
                             ELSE rate_limits.expires_at END
      RETURNING count, expires_at`,
        [bucket, String(windowMs)],
      );
      const row = rows[0] || {};
      const count = Number(row.count || 0);
      return {
        allowed: count <= limit,
        count,
        retryAfterMs: Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
      };
    },
    /** Forget a bucket — called on success, so one good login clears the tally. */
    async clearRateLimit(bucket) {
      await q('DELETE FROM rate_limits WHERE bucket = $1', [bucket]);
    },
    /** Housekeeping, so the table cannot grow without bound. */
    async pruneRateLimits() {
      await q('DELETE FROM rate_limits WHERE expires_at < NOW() - INTERVAL \'1 day\'');
    },

    // ── worker tokens ───────────────────────────────────────────────
    //
    // The `users.worker_token` column is the old one-token-per-account scheme.
    // It is still honoured so a worker paired before the upgrade keeps working,
    // but nothing writes to it any more — new machines get a row in `devices`.
    async setWorkerToken(userId, tokenHash) {
      await q('UPDATE users SET worker_token = $2 WHERE id = $1', [userId, tokenHash]);
    },
    /**
     * Resolve a worker token to its owner, and say which machine it was.
     *
     * Checks `devices` first and falls back to the legacy column, so both
     * generations of token authenticate through one path.
     */
    async getUserByWorkerToken(tokenHash) {
      const rows = await q(
        `SELECT u.id, u.email, d.id AS device_id, d.name AS device_name
           FROM devices d JOIN users u ON u.id = d.user_id
          WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
        [tokenHash],
      );
      if (rows[0]) return rows[0];

      const legacy = await q('SELECT id, email FROM users WHERE worker_token = $1', [tokenHash]);
      return legacy[0] ? { ...legacy[0], device_id: null, device_name: null } : null;
    },

    // ── devices ─────────────────────────────────────────────────────
    async createDevice(userId, { id, tokenHash, name, info }) {
      const rows = await q(
        `INSERT INTO devices (id, user_id, token_hash, name, info)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, name, created_at`,
        [id, userId, tokenHash, name, toJson(info ?? {})],
      );
      return rows[0];
    },
    /** Never the token hash: the browser has no use for it. */
    async listDevices(userId) {
      return q(
        `SELECT d.id, d.name, d.info, d.workspace, d.created_at, d.last_seen, d.revoked_at,
                (d.last_seen > NOW() - INTERVAL '45 seconds') AS online
           FROM devices d
          WHERE d.user_id = $1 AND d.revoked_at IS NULL
          ORDER BY d.last_seen DESC NULLS LAST, d.created_at DESC`,
        [userId],
      );
    },
    async getDevice(userId, deviceId) {
      const rows = await q(
        'SELECT id, name, info, workspace FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
        [deviceId, userId],
      );
      return rows[0] ?? null;
    },
    /**
     * Ask a computer to work somewhere else.
     *
     * Stored rather than sent, because the machine may be asleep: it is the
     * desired root, and the worker adopts it the next time it checks in. Null
     * hands it back whatever it was started with.
     */
    async setDeviceWorkspace(userId, deviceId, workspace) {
      const rows = await q(
        `UPDATE devices SET workspace = $3
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id, name, workspace`,
        [deviceId, userId, workspace ?? null],
      );
      return rows[0] ?? null;
    },
    async touchDevice(userId, deviceId, info) {
      if (!deviceId) return;
      await q(
        'UPDATE devices SET last_seen = NOW(), info = $3 WHERE id = $1 AND user_id = $2',
        [deviceId, userId, toJson(info ?? {})],
      );
    },
    /** Revoking is scoped by user, so nobody can unplug somebody else's machine. */
    async revokeDevice(userId, deviceId) {
      const rows = await q(
        `UPDATE devices SET revoked_at = NOW()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id, name`,
        [deviceId, userId],
      );
      return rows[0] ?? null;
    },

    // ── pairing a computer ──────────────────────────────────────────
    async createPairing({ id, codeHash, deviceName, info, expiresAt }) {
      await q(
        `INSERT INTO pairings (id, code_hash, device_name, info, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, codeHash, deviceName, toJson(info ?? {}), expiresAt],
      );
      return { id };
    },
    /**
     * Attach a waiting computer to an account.
     *
     * One statement, so two people typing the same code at the same moment
     * cannot both claim it — `claimed_at IS NULL` is part of the match.
     */
    async claimPairing(userId, codeHash, secret) {
      const rows = await q(
        `UPDATE pairings SET user_id = $1, claimed_at = NOW(), secret = $3
          WHERE code_hash = $2 AND claimed_at IS NULL AND expires_at > NOW()
      RETURNING id, device_name, info`,
        [userId, codeHash, secret],
      );
      return rows[0] ?? null;
    },
    async getPairing(id) {
      const rows = await q(
        'SELECT id, user_id, device_name, secret, claimed_at, expires_at FROM pairings WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },
    /** The token is collected exactly once; the row goes with it. */
    async consumePairing(id) {
      const rows = await q(
        `DELETE FROM pairings WHERE id = $1 AND claimed_at IS NOT NULL
      RETURNING user_id, secret, device_name`,
        [id],
      );
      return rows[0] ?? null;
    },
    /**
     * An enrolment: the same rendezvous, running the other way.
     *
     * A pairing code is minted by a computer and typed by a person. An enrolment
     * token is minted by a signed-in person and carried to a computer, so the
     * account is known from the start — that is the whole difference, and it is
     * why `user_id` is set here rather than at claim time.
     */
    async createEnrolment({ id, codeHash, userId, expiresAt }) {
      await q(
        `INSERT INTO pairings (id, code_hash, user_id, device_name, info, expires_at)
         VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
        [id, codeHash, userId, '(enrolling)', expiresAt],
      );
      return { id };
    },
    /**
     * Look up an enrolment without spending it.
     *
     * The installer has to say *whose* account is about to be given the run of
     * this computer before anybody agrees to it, and asking that question must
     * not be the thing that consumes the token — otherwise answering "no" would
     * still have used it up.
     */
    async peekEnrolment(codeHash) {
      const rows = await q(
        /**
         * Newest first, and only one.
         *
         * This took `rows[0]` of an unordered result. Postgres is free to
         * return matching rows in any order, so with two live rows sharing a
         * code the installer could name either account — and the account name
         * is what the person is being asked to confirm.
         *
         * Version 17 adds a partial unique index that stops two such rows
         * existing. This ordering is the other half: it is what makes the
         * answer deterministic on a database that has not migrated yet, and on
         * claimed rows, which the index deliberately does not cover.
         */
        `SELECT p.id, p.user_id, u.email
           FROM pairings p JOIN users u ON u.id = p.user_id
          WHERE p.code_hash = $1 AND p.expires_at > NOW()
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT 1`,
        [codeHash],
      );
      return rows[0] ?? null;
    },
    /**
     * Spend it. One statement, so two machines racing on the same token cannot
     * both win — the row is gone with the first.
     */
    async consumeEnrolment(codeHash) {
      const rows = await q(
        /**
         * Exactly the row `peekEnrolment` showed, and only that row.
         *
         * This deleted *every* live row matching the code and returned an
         * arbitrary one. With two such rows that is two failures at once: the
         * other pairing is destroyed, and the account enrolled may not be the
         * account the person just confirmed — peek and consume were each free
         * to pick a different row.
         *
         * The same ORDER BY as peek, so the two agree by construction. Still
         * one statement, so two machines racing on the same code cannot both
         * win: the row is gone with the first.
         */
        `DELETE FROM pairings
          WHERE id = (
                SELECT id FROM pairings
                 WHERE code_hash = $1 AND expires_at > NOW()
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1)
      RETURNING id, user_id`,
        [codeHash],
      );
      return rows[0] ?? null;
    },
    async prunePairings() {
      await q("DELETE FROM pairings WHERE expires_at < NOW() - INTERVAL '1 hour'");
    },
  };
}
