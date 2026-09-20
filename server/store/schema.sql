-- AI Remote schema. Safe to run repeatedly.
--
-- Everything a person owns is scoped by user_id, including the worker that runs
-- shell commands on their machine. That scoping is the security boundary: one
-- account must never be able to reach another account's computer.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  -- sha256 of the user's worker token; the token itself is shown once and never stored.
  worker_token  TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- Added after the initial release; ALTER keeps existing deployments working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_token_limit BIGINT;

-- Two-factor. The shared secret is encrypted with ENCRYPTION_KEY, never stored
-- in the clear; recovery codes are kept only as digests and burned on use.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes  JSONB;

-- The last 30-second step a TOTP code was accepted for. A code read over
-- somebody's shoulder is valid for ninety seconds without this; with it, a code
-- works exactly once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step  BIGINT;

-- Bumped whenever the password changes. Sessions are stateless signed cookies,
-- so there is no server-side list to clear — instead the epoch is baked into the
-- cookie and checked on every request, which makes "change your password" do
-- what everyone assumes it does: sign the other sessions out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch   INTEGER NOT NULL DEFAULT 1;

-- Single-use, expiring links for email confirmation and password resets.
-- Only the digest is stored, so a database dump cannot be replayed as a login.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- 'verify' | 'reset'
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, kind);

-- The same row also carries a short numeric code, so a confirmation can be
-- typed in instead of requiring a link click — far easier on a phone.
ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS code_hash TEXT;

-- One row per model call, for the usage page and the monthly quota check.
CREATE TABLE IF NOT EXISTS usage_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id       TEXT,
  model         TEXT NOT NULL,
  input_tokens  BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_events_user_time_idx ON usage_events (user_id, created_at DESC);

-- Tokens served from the provider's prompt cache, which are billed at about a
-- tenth of the input rate. They were being folded into input_tokens and then
-- priced at the full rate, so a well-cached agentic conversation reported a
-- cost several times what it actually was. Kept as a column of its own rather
-- than netted off, because the ratio against input_tokens *is* the cache hit
-- rate, and there was previously nowhere to read that at all.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT NOT NULL DEFAULT 0;

-- Which part of the system spent this: the conversation turn itself, a
-- sub-agent fan-out, a compaction, a research role, a page extraction. Without
-- it, spend that never went through the agent loop was invisible on the usage
-- page and, worse, uncounted against a shared key's monthly limit.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'turn';

-- Per-user preferences and encrypted provider keys.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   JSONB NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  model      TEXT,
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chats_user_idx ON chats (user_id, updated_at DESC);

-- Held while an agent loop is running against this conversation. Two tabs — or a
-- reconnect racing the run it is replacing — would otherwise both drive the same
-- transcript and interleave their turns into nonsense. The claim is a conditional
-- UPDATE, so it is atomic across serverless instances as well as tabs.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS run_lock_at TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS run_lock_by TEXT;

-- Kept only so existing databases still satisfy the NOT NULL default; nothing
-- reads it any more. There was once a tool-free "chat" mode, for models that
-- could not call tools — but the library refuses to import one of those now, so
-- the setting could only ever remove abilities for no reason.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'agent';

-- A project: standing instructions, a shelf of sources, and the conversations
-- that inherit both.
--
-- The sources are kept as extracted text rather than as bytes. Everything that
-- happens to them afterwards is textual — searching for the passage that
-- answers a question, counting what fits in a window, quoting a line back with
-- its filename — and a PDF re-parsed on every turn to produce the same
-- characters is work nobody asked for. The original bytes are not kept at all:
-- this is a knowledge base, not a file store, and holding a second copy of
-- somebody's documents is a promise about deletion we would rather not make.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  -- Answer from the sources alone, and say so when they do not cover it.
  grounded     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS projects_user_idx ON projects (user_id, updated_at DESC);

-- Kept at the top of the shelf, whatever the dates say. A project you are in
-- every day and one you finished in March are not the same thing, and sorting
-- by when they last changed puts them in the same list in the same order.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- Finished, but not thrown away.
--
-- Deleting a project takes its sources and unhooks its conversations, which is
-- the right thing to offer and the wrong thing to reach for when a piece of
-- work is simply over. Archived projects leave the shelf and keep everything.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS projects_shelf_idx ON projects (user_id, archived_at, pinned, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_files (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,            -- of the original upload
  pages      INTEGER,                     -- PDFs only
  text       TEXT NOT NULL,
  chars      INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_files_project_idx ON project_files (project_id, created_at);

-- Which project a conversation belongs to, if any. Null is the ordinary chat
-- that belongs to nothing, which is most of them.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chats_project_idx ON chats (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  role       TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_chat_seq_idx ON messages (chat_id, seq);

-- Photos and files sent with a message.
--
-- In a table of their own rather than inside `messages.content`, and the reason
-- is the shape of the reads: a conversation is loaded whole on every open, and
-- searching scans every message body as text. A few screenshots inlined there
-- would make both of those move megabytes of base64 to answer questions that
-- never needed it. The message keeps a list of ids; the bytes are fetched only
-- by whoever actually wants them — the browser for a thumbnail, the provider
-- layer when it builds a request.
CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id    TEXT,                        -- set when the message is sent
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- image | text | document
  bytes      INTEGER NOT NULL,
  data       TEXT NOT NULL,               -- base64
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachments_user_idx ON attachments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachments_chat_idx ON attachments (chat_id);

-- Where a file came from: 'upload' is something a person sent, 'generated' is
-- something the assistant made.
--
-- One table for both, rather than a second one that would need its own
-- ownership check, its own download route and its own sweep. A document the
-- assistant wrote is a file in the conversation exactly as a photograph is: you
-- can open it, download it, and ask about it again three turns later.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'upload';

-- What a generated file was written from — the Markdown, not the .docx.
--
-- Kept because "change the last row of the table" has to start from the words.
-- Re-reading a .docx back into a document model and editing that would work for
-- the third paragraph and lose the intent everywhere else; the source is what
-- was meant, and regenerating from it is exact.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS attachments_origin_idx ON attachments (chat_id, origin);

-- Bridge between the agent loop and the worker on a user's own PC.
CREATE TABLE IF NOT EXISTS tool_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id    TEXT,
  tool       TEXT NOT NULL,
  input      JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  done_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tool_jobs_queue_idx ON tool_jobs (user_id, status, created_at);

-- Which of the account's computers this job is for. Once somebody can pair a
-- laptop *and* a desktop, "run this command on my machine" stops being a
-- complete instruction — and a queue two workers both poll would hand the job
-- to whichever asked first, which is a coin toss, not a choice. Null means any.
ALTER TABLE tool_jobs ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE TABLE IF NOT EXISTS workers (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  info      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS workers_user_idx ON workers (user_id, last_seen DESC);

-- Which computer a worker token belongs to.
--
-- There used to be one token per account, in a column on `users`, and pairing a
-- second machine silently cut off the first — so "sign in anywhere and your
-- computer is there" was only ever true for one computer. A person has a laptop
-- and a desktop; a team member has a work machine and a home one. Each gets its
-- own row, its own token, and can be revoked on its own without disturbing the
-- others.
CREATE TABLE IF NOT EXISTS devices (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256 of the device token; the token is shown once and never stored.
  token_hash TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,             -- "Phu's laptop", from the machine's hostname
  info       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen  TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id, revoked_at);

-- Where this computer resolves relative paths, chosen from the app.
--
-- It used to be an environment variable read once at startup, which meant
-- "work on my other project instead" was: stop the worker, edit a file on that
-- machine, start it again. Fine when the machine is the one you are sitting at,
-- absurd when the whole point is driving it from a phone. Null means whatever
-- the machine itself was started with.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS workspace TEXT;

-- Added when the browser was choosable per computer. That setting was removed
-- again — the answer is always a clean sandbox — so nothing reads this now. It
-- stays because dropping a column is a migration that risks data for no gain,
-- and because a future setting would want exactly this shape.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS browser_mode TEXT;

-- A computer waiting to be adopted.
--
-- The worker asks for a code, prints it, and polls. Somebody signed in types
-- that code into the app, which is what attaches the machine to their account —
-- so an unauthenticated request can never reach anybody's data, it can only ask
-- to be claimed. The minted token is held here encrypted for the few seconds
-- between the claim and the worker's next poll, then the row is deleted.
CREATE TABLE IF NOT EXISTS pairings (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,   -- null until claimed
  device_name TEXT NOT NULL,
  info        JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret      TEXT,                       -- AES-GCM device token, until collected
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  claimed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pairings_expiry_idx ON pairings (expires_at);

-- The latest frame from each account's browser sandbox — one row per user,
-- overwritten in place. Only the newest frame matters, so there is no history
-- to grow unbounded.
-- `watched_at` is its own column rather than a field inside `meta`: meta is
-- replaced wholesale by every incoming frame, so a watch marker living there
-- would be wiped by the very frames it is meant to keep flowing.
CREATE TABLE IF NOT EXISTS screens (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frame      TEXT,                              -- base64 JPEG
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  watched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE screens ADD COLUMN IF NOT EXISTS watched_at TIMESTAMPTZ;

-- Deployment-wide values that belong to nobody in particular.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- A procedure somebody taught the assistant: "how we do a quotation", "how to
-- file an invoice". The instructions are injected when the skill is relevant,
-- so a repeated job is described once rather than re-explained every time.
CREATE TABLE IF NOT EXISTS skills (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,          -- what it is for; how the model decides to use it
  instructions TEXT NOT NULL,          -- the actual steps
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  used_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_user_name_idx ON skills (user_id, lower(name));

-- Work to start later, or on a repeating schedule. `next_run_at` is what the
-- scheduler polls; `cron` being null means it runs once and is done.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  model       TEXT,
  cron        TEXT,                     -- 'HH:MM' daily, or 'DOW HH:MM' weekly
  next_run_at TIMESTAMPTZ NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  last_chat   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scheduled_due_idx ON scheduled_tasks (enabled, next_run_at);

-- The IANA zone the schedule was written in. Without it "17:00" meant 17:00
-- wherever the server happened to be — UTC on a deployment — so somebody in
-- Vietnam asking for five in the afternoon got midnight. The clock a person
-- means is their own clock.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS tz TEXT;

-- Credentials for third-party services, encrypted with the same key as the
-- provider API keys. One row per service per account.
CREATE TABLE IF NOT EXISTS connectors (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service    TEXT NOT NULL,
  token      TEXT NOT NULL,             -- AES-GCM, never returned to the browser
  account    TEXT,                      -- whose account it is, for display
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, service)
);

-- MCP servers an account has plugged in.
--
-- This is what turns a fixed tool list into an open one: a server here can add a
-- hundred tools without a line being added to this repository.
--
-- `config` holds the transport and how to reach it. Secrets inside it — bearer
-- headers, environment variables holding tokens — are encrypted into
-- `headersCipher` / `envCipher` with the same key as the provider keys, so the raw
-- JSON is safe to read back into the settings page. See server/mcp/registry.js.
--
-- Per account, never global: a stdio server is a program that runs on the machine,
-- and one account must not be able to make another account's turn execute it.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,             -- what the user calls it; slugified into tool names
  config     JSONB NOT NULL,            -- { transport, command, args, url, headersCipher, envCipher }
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_user_name_idx ON mcp_servers (user_id, lower(name));

-- The shared model library. Refreshed from OpenRouter once a day, plus whatever
-- anyone adds by pasting a model id. Shared on purpose: one person finding a
-- good free model makes it selectable for everyone, with no link to paste.
CREATE TABLE IF NOT EXISTS shared_models (
  id             TEXT PRIMARY KEY,               -- 'openrouter/vendor/model:free'
  provider       TEXT NOT NULL,                  -- which adapter runs it
  model          TEXT NOT NULL,                  -- the id the provider expects
  family         TEXT NOT NULL,                  -- anthropic | openai | google | meta | …
  label          TEXT NOT NULL,
  description    TEXT,
  context        BIGINT,
  price_in       DOUBLE PRECISION,               -- USD per 1M tokens
  price_out      DOUBLE PRECISION,
  is_free        BOOLEAN NOT NULL DEFAULT FALSE,
  released_at    TIMESTAMPTZ,                    -- vendor release date, for "newest first"
  added_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS shared_models_sort_idx   ON shared_models (released_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS shared_models_family_idx ON shared_models (family, is_free);

-- Whether the model can be shown a picture.
--
-- Roughly half of them cannot, and sending an image to one that cannot is not a
-- degraded answer — the provider rejects the whole request, which surfaced as a
-- bare "not found" with no hint that the attachment was the problem. Recorded so
-- the picker can say, the composer can warn, and the request can leave the image
-- out and explain itself instead of failing.
ALTER TABLE shared_models ADD COLUMN IF NOT EXISTS vision BOOLEAN NOT NULL DEFAULT FALSE;

-- The most output tokens this model will actually produce.
--
-- Every request used to ask for 32000 regardless, because that was the one
-- number the adapters knew. Forty-five of the models in the catalogue cap lower
-- than that — `ai21/jamba-large-1.7` at 4096, `amazon/nova-lite-v1` at 5120,
-- the Qwen 3 family at 8192, DeepSeek at 16000 — so the request was asking for
-- something the provider had already said it would not do. Recorded here because
-- OpenRouter publishes it (`top_provider.max_completion_tokens`) and guessing
-- from the context length gets it wrong in both directions: a 1M-context model
-- does not have a 1M output budget, and a 16k one does not have 32k.
--
-- Null means the provider did not say. `resolveModel` derives a conservative
-- figure from the context length in that case rather than reaching for 32000.
ALTER TABLE shared_models ADD COLUMN IF NOT EXISTS max_output INTEGER;

-- Counters behind the login and password-reset throttles.
--
-- In a table rather than in memory on purpose: on a serverless deployment each
-- request may land on a fresh instance, so an in-process counter would reset
-- itself between attempts and throttle nothing at all. One upsert per attempt is
-- a small price for a limit that actually holds.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,          -- 'login:1.2.3.4' — action plus identity
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry_idx ON rate_limits (expires_at);

-- Indexed documents: the assistant's long-term memory of the user's own files.
--
-- The embedding is a base64 float32 array in a TEXT column rather than a
-- `vector` — deliberately. pgvector exists on Neon and does not exist in PGlite,
-- and this project's whole database story is that a laptop and a deployment run
-- identical SQL. Similarity is computed in JavaScript over vectors that were
-- normalised on the way in, which turns cosine into a dot product; for the tens
-- of thousands of chunks one person's documents amount to, that is a few tens of
-- milliseconds and no extension to install. Reach for pgvector when somebody has
-- a million chunks, not before.
CREATE TABLE IF NOT EXISTS doc_chunks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,            -- the folder that was indexed, as the user named it
  path       TEXT NOT NULL,            -- the file this came out of
  ordinal    INTEGER NOT NULL,         -- which chunk of that file
  heading    TEXT,                     -- nearest heading above it, when there was one
  text       TEXT NOT NULL,
  embedding  TEXT NOT NULL,            -- base64 of a normalised Float32Array
  dims       INTEGER NOT NULL,
  model      TEXT NOT NULL,            -- vectors from different models are not comparable
  mtime      BIGINT,                   -- lets a re-index skip files nobody touched
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doc_chunks_user_idx ON doc_chunks (user_id, source);

-- The shape the search actually asks for.
--
-- `docVectors` filters on (user_id, model) — vectors from two embedding models
-- are not comparable, so the model is always in the predicate — while the only
-- index was on (user_id, source). Every search therefore scanned the account's
-- whole row set and discarded the rows belonging to another model afterwards.
-- Ordered by id so the paged scan below walks a stable, index-ordered cursor
-- rather than re-sorting a heap on every page.
CREATE INDEX IF NOT EXISTS doc_chunks_search_idx ON doc_chunks (user_id, model, id);
CREATE UNIQUE INDEX IF NOT EXISTS doc_chunks_place_idx ON doc_chunks (user_id, path, ordinal);

-- Earlier versions of a file the assistant wrote.
--
-- `update_file` rewrites in place and keeps the id, which is right: a quotation
-- with one number changed is the same quotation, and a second nearly-identical
-- file is how the wrong one gets sent. But rewriting in place also threw the
-- previous copy away, so "put that number back" meant asking for the whole
-- document again and hoping.
--
-- Every rewrite now files the outgoing copy here first. Only generated files
-- have them — an upload never changes — and only the bytes plus the Markdown
-- they were built from, because that pair is what it takes to both show a
-- version and restore it.
CREATE TABLE IF NOT EXISTS attachment_versions (
  id            TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,        -- 1 is the first thing that was written
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  kind          TEXT NOT NULL,           -- same vocabulary as attachments.kind
  bytes         INTEGER NOT NULL,
  data          TEXT NOT NULL,           -- base64
  source        TEXT,                    -- the Markdown it was built from
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attachment_versions_idx
  ON attachment_versions (attachment_id, revision DESC);

-- One deep-research run: the debate transcript and the source ledger, kept out
-- of the conversation so a long transcript does not ride in every later turn's
-- context, and kept at all so a conclusion's provenance can be audited later.
CREATE TABLE IF NOT EXISTS research_runs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL,           -- complete | budget | failed | aborted
  transcript   JSONB NOT NULL,          -- the rounds, personas, objections
  sources      JSONB NOT NULL,          -- the ledger: id, url, rank, title
  report       TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_runs_user_idx ON research_runs (user_id, created_at DESC);

-- A job with several steps that depend on each other, run unattended.
--
-- A scheduled_task is one prompt and one agent turn, which already chains work
-- within that turn. What it cannot do is survive being cut off: `maxDuration` on
-- the deployment is 300s, four LLM steps can exceed that, and the invocation
-- dies with the email possibly sent and possibly not. The next firing then does
-- the whole thing again.
--
-- So a workflow keeps its position. `steps` here is the definition; the state of
-- one execution lives in workflow_runs, which is resumable.
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  steps       JSONB NOT NULL,           -- [{ id, instruction }] in order
  model       TEXT,
  cron        TEXT,                     -- 'HH:MM' daily, or 'DOW HH:MM' weekly
  tz          TEXT,                     -- the IANA zone the schedule was written in
  next_run_at TIMESTAMPTZ,              -- NULL for a workflow only ever run by hand
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workflows_user_idx ON workflows (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflows_due_idx  ON workflows (enabled, next_run_at);

-- One execution of a workflow, in a conversation of its own.
--
-- `cursor` is the next step to run, so an invocation that stops at its time
-- budget is resumed rather than restarted. `lease_until` is what stops two
-- invocations running the same steps at once: a claim pushes it forward, and a
-- process that dies simply lets it expire.
--
-- A step found still 'running' when the lease is reclaimed becomes 'unknown' and
-- the run stops as 'needs_attention'. It is never retried: nobody can say
-- whether the email went out, and repeating a side effect unattended is worse
-- than stopping to ask.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     TEXT,
  status      TEXT NOT NULL,            -- running | done | failed | needs_attention | cancelled
  steps       JSONB NOT NULL,           -- [{ id, status, started_at, finished_at, summary, error }]
  cursor      INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_runs_wf_idx   ON workflow_runs (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_user_idx ON workflow_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_open_idx ON workflow_runs (status, lease_until);

-- ── Schema 16 ────────────────────────────────────────────────────────────────
--
-- Indexes for queries that were reading whole tables, and a lease for scheduled
-- tasks. Every statement here is additive; nothing is dropped or rewritten.

-- The most frequently executed query in the app. A paired computer polls
-- `recentJobAt` roughly every four seconds, forever — about 21,600 times a day
-- per device — and the only index available was `(user_id, status, created_at)`.
-- With `status` unconstrained, its residual order is wrong for `ORDER BY
-- created_at DESC`, so each poll read every one of that account's job rows and
-- sorted them to return one.
CREATE INDEX IF NOT EXISTS tool_jobs_user_time_idx ON tool_jobs (user_id, created_at DESC);

-- Postgres does not index the referencing side of a foreign key, so each of
-- these fired a sequential scan when an account was deleted — all of them inside
-- the single `DELETE FROM users` statement, holding locks throughout.
-- `scheduled_tasks` is the worse case: it had no index at all, so `listTasks`
-- was a cross-tenant sequential scan on an ordinary page load.
CREATE INDEX IF NOT EXISTS scheduled_tasks_user_idx     ON scheduled_tasks (user_id, next_run_at);
CREATE INDEX IF NOT EXISTS project_files_user_idx       ON project_files (user_id);
CREATE INDEX IF NOT EXISTS attachment_versions_user_idx ON attachment_versions (user_id);
CREATE INDEX IF NOT EXISTS pairings_user_idx            ON pairings (user_id);

-- Three of the six sweep pruners scanned their table whole, and the sweep runs
-- from the cron route *before* the agent turns, inside the same 300s budget it
-- then hands the remainder of to workflows.
CREATE INDEX IF NOT EXISTS tool_jobs_done_idx     ON tool_jobs (done_at) WHERE status IN ('done', 'error');
CREATE INDEX IF NOT EXISTS research_runs_done_idx ON research_runs (completed_at);
CREATE INDEX IF NOT EXISTS workflow_runs_done_idx ON workflow_runs (finished_at);

-- Both shelves order by `pinned DESC, updated_at DESC` and neither index led
-- with `pinned`, so both sorted their result set on every load.
CREATE INDEX IF NOT EXISTS chats_shelf_idx ON chats (user_id, pinned DESC, updated_at DESC);

-- Looked up by hash on every pairing claim and every enrolment, and indexed only
-- by expiry. Not unique: two live rows could share a code and `peekEnrolment`
-- returns `rows[0]` of an unordered result, so the installer could name the
-- wrong account. Uniqueness needs a backfill first and is not attempted here.
CREATE INDEX IF NOT EXISTS pairings_code_idx ON pairings (code_hash);

-- A scheduled task that was cut off mid-run used to re-run in an hour, and again
-- the hour after, forever: the claim pushed `next_run_at` forward but nothing
-- recorded that the run had *started*, so an invocation killed at the function
-- ceiling left no trace. A task found still 'running' when its lease has expired
-- is now marked for a person to look at rather than repeated — the same rule
-- `workflow_runs` already applies, and for the same reason: nobody can say
-- whether the email went out.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS run_state   TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS started_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS scheduled_tasks_lease_idx ON scheduled_tasks (run_state, lease_until);

-- A reconnect used to *join* the run it was resuming rather than replace it,
-- because the lease was re-entrant on the run id alone and the heartbeat then
-- reported success to both invocations at once. The sequence makes a claim
-- monotonic: the newer holder evicts the older, which then fails its heartbeat
-- and stops, instead of two loops appending to one transcript.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS run_lock_seq BIGINT NOT NULL DEFAULT 0;

-- ── 17 ────────────────────────────────────────────────────────────────
-- Four predicates that had no index, and the one uniqueness rule this file
-- already described as needed and left undone.

-- `pruneOrphanAttachments` and the usage pruner both filter on `created_at`
-- alone, and the only indexes covering those columns lead with `user_id`. A
-- leading column cannot be skipped, so both swept the whole table — from the
-- cron route, inside the 300s function ceiling, on tables that only grow.
CREATE INDEX IF NOT EXISTS usage_events_created_idx ON usage_events (created_at);
CREATE INDEX IF NOT EXISTS attachments_created_idx  ON attachments (created_at);

-- The model library can be filtered by provider. That filter was added
-- deliberately — filtering in the browser had been hiding whole providers — and
-- was never given an index to run on.
CREATE INDEX IF NOT EXISTS shared_models_provider_idx ON shared_models (provider);

-- `cancelJobsForDevice` runs when a computer is unpaired, and `claimJob` uses
-- device_id as a residual filter. Nothing indexed it.
CREATE INDEX IF NOT EXISTS tool_jobs_device_idx ON tool_jobs (device_id);

-- The uniqueness `pairings_code_idx` says is needed and does not attempt.
-- Two live rows could share a code, and `peekEnrolment` returned the first row
-- of an unordered result — so the installer could name the wrong account, which
-- is the one thing a confirmation prompt must never get wrong.
--
-- Partial, over unclaimed rows only. A claimed pairing's code is spent, and a
-- full unique index would also collide with expired rows `prunePairings` has
-- not swept yet, rejecting a legitimate new pairing an hour later.
--
-- The backfill has to come first, or this cannot be created on a database that
-- already holds a duplicate. The newest unclaimed row for a code is the one
-- somebody is looking at right now, so the older ones go.
DELETE FROM pairings a
 USING pairings b
 WHERE a.claimed_at IS NULL
   AND b.claimed_at IS NULL
   AND a.code_hash = b.code_hash
   AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS pairings_code_unclaimed_idx
    ON pairings (code_hash) WHERE claimed_at IS NULL;

-- ── 18: a per-conversation sequence counter ─────────────────────────────────
-- `appendMessage` used to number a message `MAX(seq) + 1`, read in the same
-- statement that inserts. Two appends to one conversation at once read the same
-- maximum and both write it — and `messages (chat_id, seq)` is not unique, so
-- nothing refused the second. The transcript is ordered by `seq`, so a
-- collision is two turns with no defined order between them (ARCH-007).
--
-- The fix is a counter the append *updates*, because Postgres re-reads a row it
-- had to wait for a lock on before applying an UPDATE, where it does not re-run
-- a subquery. Concurrent appends therefore take distinct numbers.
--
-- What this deliberately does NOT do is make (chat_id, seq) unique. Doing that
-- means first renumbering any conversation that already holds a collision, and
-- renumbering rewrites history: a summary records `covers`, the seq of the last
-- message it stands for, and shifting the numbers under it would send the model
-- the wrong tail — which is the exact failure ACC-007 fixed. New collisions stop
-- here; old ones, if a database has any, are left as they were written.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS next_seq BIGINT;

-- Backfill only what has not been backfilled, so replaying this file over a
-- migrated database changes nothing.
UPDATE chats c
   SET next_seq = COALESCE((SELECT MAX(m.seq) + 1 FROM messages m WHERE m.chat_id = c.id), 0)
 WHERE c.next_seq IS NULL;

-- The default comes after the backfill, not in the ADD COLUMN. A default there
-- would fill every existing row with 0 at once, the backfill above would find
-- nothing NULL, and every old conversation would start issuing seq 0 again.
ALTER TABLE chats ALTER COLUMN next_seq SET DEFAULT 0;

-- ── 19: a project source keeps its original, and something to show ──────────
-- `project_files` stored the extracted *text* and nothing else, which is all a
-- grounded answer needs and not enough for anything a person does with a shelf.
-- There was no way to show what a source looks like, no way to open one, and no
-- way to get back the file that was uploaded — the bytes were read once and
-- dropped.
--
-- `attachment_id` points at the original, stored in the table that already
-- holds uploaded bytes and already has a route that serves them under a
-- `default-src 'none'` policy. Reusing it rather than adding a second blob
-- column means one place where uploads are stored, swept and served, and no
-- second opinion about which content types are safe to hand back.
--
-- `thumb` is a small picture of the source — an image scaled down, or a PDF's
-- first page — rendered once by the browser that uploaded it. Inline rather
-- than a second attachment row because it is a few kilobytes that the shelf
-- listing always wants; a join per card to fetch one would be the slower half
-- of drawing the page.
--
-- `kind` is what the UI draws. Derivable from `mime`, and stored anyway: the
-- classification lives in one function on the server and a copy of it in the
-- browser would be a second opinion about what a file is.
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS kind          TEXT;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS thumb         TEXT;

-- Sources added before this have no original and no picture, and that is what
-- they will stay: the bytes are gone. Giving them a kind at least lets the
-- shelf draw them as something rather than as nothing.
UPDATE project_files
   SET kind = CASE
                WHEN mime LIKE 'image/%'                          THEN 'image'
                WHEN mime = 'application/pdf'                     THEN 'document'
                WHEN mime LIKE '%wordprocessingml%'
                  OR mime LIKE '%spreadsheetml%'
                  OR mime LIKE '%presentationml%'                 THEN 'office'
                ELSE 'text'
              END
 WHERE kind IS NULL;

-- ── 20: a scheduled task belongs somewhere, and need not repeat ─────────────
-- Three gaps, all of which show up the moment tasks are made from a project
-- rather than from the global list.
--
-- `project_id` — a task made inside a project runs inside it: same standing
-- instructions, same shelf of sources. Without this a "summarise this week's
-- filings" task made in a project answered from nothing at all, which is the
-- worst kind of wrong because it looks like it worked. ON DELETE SET NULL, so
-- deleting a project leaves its tasks running as ordinary ones rather than
-- silently taking them with it.
--
-- `policy` — what a run is allowed to do without being asked. A task runs at
-- 3am with nobody watching, so "pause and ask" and "never pause" are genuinely
-- different settings and the choice has to be the person's. Null means the
-- account's own default, which is what every task made before this used.
--
-- `next_run_at` becomes nullable, which is what makes "manual only" a real
-- option rather than a repeat scheduled so far ahead it never fires. The due
-- query is `enabled AND next_run_at <= now()`, and NULL satisfies neither
-- comparison, so a manual task is simply never due — it runs when the Run now
-- button is pressed and at no other time.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS policy     TEXT;
ALTER TABLE scheduled_tasks ALTER COLUMN next_run_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS scheduled_project_idx ON scheduled_tasks (project_id, created_at);

-- ── 21: a conversation can be filed, archived, or marked unread ─────────────
-- The sidebar lists a project's conversations under the project rather than
-- mixed into one flat list, and the menus on those rows offer what you would
-- expect to be able to do with a filed thing. Three of those had nowhere to be
-- recorded.
--
-- `archived_at` — out of the list without being destroyed. The distinction
-- matters precisely because Delete is next to it in the same menu: archiving is
-- what somebody reaches for when they are not sure, and a feature that silently
-- means "delete" is the worst possible answer to that.
--
-- `unread` — "mark as unread" is a note to yourself that a conversation is not
-- finished with. Nothing sets it automatically; it is a flag a person raises
-- and lowers by opening the conversation, which is why it is a boolean rather
-- than a read timestamp compared against the last message.
--
-- `chat_group` — a name, not a table. A group is a label a person invents in
-- the "Move to group" menu, and the set of groups is the distinct set of names
-- in use. The consequence is deliberate: a group whose last conversation leaves
-- it stops existing, which is what somebody means by moving the last one out.
-- A table would buy empty groups and a lifecycle to manage them, for a feature
-- whose entire job is putting a few rows under a heading.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS unread      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS chat_group  TEXT;

-- The sidebar reads "not archived, newest first" on every load, and the project
-- sections read the same thing per project.
CREATE INDEX IF NOT EXISTS chats_live_idx ON chats (user_id, archived_at, pinned, updated_at DESC);
