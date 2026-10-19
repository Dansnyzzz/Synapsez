---
description: Check this project is genuinely ready to deploy to Vercel on the free tier.
allowed-tools: Bash, PowerShell, Read, Grep, Glob, WebFetch
---

Verify deployment readiness for **Vercel Hobby + a free Postgres**. Report facts,
not reassurance.

## 1. The automated part

```
npm run test:deploy
```

That suite already pins most of what follows. Read its output rather than
re-deriving it.

## 2. `vercel.json` — the schema is strict

The reasoning behind every line is in `docs/vercel-config.md`. Re-read it before
changing anything there. The traps, in order of how badly they bite:

- **Unknown keys fail the build.** A `functions` entry declares
  `additionalProperties: false`. Only these are legal: `runtime`, `memory`,
  `maxDuration`, `supportsCancellation`, `maxConcurrency`, `includeFiles`,
  `excludeFiles`, `regions`, `functionFailoverRegions`, `experimentalTriggers`.
  A `comment` key explaining the config is a rejected deployment.
- **`memory` cannot be set here at all.** It produces a build-time warning, and
  Hobby is fixed at 2 GB / 1 vCPU regardless.
- **Cron frequency is enforced at deploy time.** Hobby allows 100 jobs but each
  may run at most once a day. `*/15 * * * *` does not degrade — it fails the
  deployment. Both current crons are daily, and **both run on the free plan**.
- **`includeFiles: "server/**"` is load-bearing.** `server/store/schema.sql` is
  read with `fs.readFileSync`, and the bundler traces imports, not file reads.
  Without it the first request 500s with ENOENT and the database is never built.
- `maxDuration: 300` is Hobby's ceiling and its default.

## 3. Environment variables

Every required variable must exist in the Vercel dashboard, because a hosted
filesystem is read-only and `server/secrets.js` cannot generate them there.

Cross-check `.env.example` against what `assertSecrets()` demands:

- `SESSION_SECRET` — signs session cookies
- `ENCRYPTION_KEY` — encrypts stored provider keys. **Separate from the above on
  purpose**: rotating the session secret must not destroy every stored API key.
- `DATABASE_URL` — required on Vercel. `server/store/index.js` throws a clear
  error without it rather than silently falling back to PGlite, whose disk does
  not survive an invocation.
- `CRON_SECRET` — without it both cron endpoints are open URLs, and
  `/api/cron/run-tasks` does real work.

## 4. Database

Confirm a hosted Postgres is attached: Supabase's Transaction pooler string
(port 6543) in `DATABASE_URL`, ideally with `DATABASE_CA_CERT` — see
docs/database.md. Then sanity-check the free tier against expected usage:
connection ceiling, storage cap, and whether it counts compute hours — a paired
worker keeps a database from ever idling, which is how a free Neon project ran
out mid-month (HTTP 402, 2026-10-19).

## 5. Report

State clearly: what passed, what you could not check without deploying, and any
variable the user still has to set by hand. Do not deploy — that is the user's
call. Do not claim it will work; say which checks passed.
