# The database: Supabase (or any Postgres)

A deployment needs a hosted Postgres in `DATABASE_URL`. A local run needs nothing — it keeps
everything in an in-process Postgres under `data/`.

## Why Supabase rather than Neon

Both have a free plan, and the difference that matters here is how they count compute:

| | Free compute | Free database |
|---|---|---|
| **Supabase** | Always on, shared CPU — **no hour quota**. A project with no activity for 7 days is paused. | 500 MB, 5 GB egress |
| Neon | **100 CU-hours a month**, suspended after 5 idle minutes. When the hours run out, compute stops until the next billing period — every request answers HTTP 402. | 1 GB, 5 GB egress |

A paired computer asks the server for work all day, so the database is never idle for five minutes.
On Neon that spent the month's hours by about the 17th. Since 2026-10-19 an idle worker asks far less
often (below), but a database with no hour quota is the safer fit for an app whose whole point is a
machine standing by. Neon still works: a `*.neon.tech` address is reached through Neon's own driver,
anything else through a connection pool. Free plans change — check the current terms.

## Setting up Supabase

1. **Create a project** at [supabase.com](https://supabase.com) → *New project*. Put it in the region
   your Vercel functions run in (Vercel → your project → *Settings → Functions → Function Region*;
   the default is Washington, D.C., which is Supabase's *East US (North Virginia)*). Save the database
   password it asks for.
2. **Copy the connection string.** In the project, press **Connect** → **Transaction pooler**. It looks
   like this — put your password in place of `[YOUR-PASSWORD]`:

   ```text
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

   Use the **transaction** pooler (port **6543**): it is the one meant for serverless functions, and it
   works over IPv4. The direct connection is IPv6 only.
3. **Optional, recommended: let the app verify it is really Supabase.** *Project Settings → Database
   → SSL Configuration → Download certificate*. Open the file and paste all of it, `-----BEGIN
   CERTIFICATE-----` to `-----END CERTIFICATE-----`, into a Vercel variable `DATABASE_CA_CERT`. Without
   it the connection is still encrypted, but the server's identity is not checked, and the log says so.
4. **Point Vercel at it.** If the project has the Neon integration, disconnect it first (*Storage* →
   the Neon database → *Disconnect*), because it owns `DATABASE_URL`. Then *Settings → Environment
   Variables* → `DATABASE_URL` = the string from step 2. **Redeploy.**
5. Open the app. The first request creates the tables; sign up, and the first account is the
   administrator.
6. **The Data API.** Supabase serves every table in `public` over its REST API to anyone holding the
   project's public *anon* key. The app never uses that API — it talks to Postgres directly — and since
   1.27.0 (schema 49) it switches row-level security on for every table, with no policy, so those
   roles reach no row. To close the door entirely: *Project Settings → Data API* → turn it off, or
   remove `public` from *Exposed schemas*. Check *Advisors → Security Advisor* shows no "RLS disabled"
   warnings after the first deploy of 1.27.0.

## Bringing the old data across

```bash
npm run db:copy -- --from "<the old Neon DATABASE_URL>" --to "<the Supabase DATABASE_URL>"
```

Run it on your own computer, from this folder. It gives the new database this app's tables, then
copies every table in an order the foreign keys allow, and prints how many rows each took. Nothing
in the old database changes, and a row the new one already has is left alone — so a copy cut short
can simply be run again.

**Check first.** The same command with `--check` reads both and writes nothing: whether Neon answers
yet, how many rows each table holds, and which of its accounts' emails the new database already has.
Run it the morning Neon's quota resets; if it still answers 402, it says so.

```bash
npm run db:copy -- --from "<the old Neon DATABASE_URL>" --to "<the Supabase DATABASE_URL>" --check
```

The addresses can also come from the environment — `COPY_FROM_URL` and `COPY_TO_URL` — so they need
not be typed where a shell keeps its history.

- **Neon has to be reachable.** A project whose compute hours ran out answers 402 until its next
  billing period (shown under *Billing*), or until it is upgraded — a month of Neon's paid plan is
  enough to make the copy, then downgrade.
- **Signed up on the new database already?** An account there with the same email can take the old
  account's conversations, files, settings and paired computers — but only if you name it. Signing
  up does not prove an email, so the account under your address on the new database could be
  someone else's; merged, it would receive everything the old one held. The copy stops before
  writing a row and lists each such email. Check each is the same person, then add
  `--merge a@example.com,b@example.com`. Where both have the same thing — the same setting — the new
  database's stays. The copy says which accounts it merged.
- **Run it with the deployment's `ENCRYPTION_KEY`** (and `ENCRYPTION_KEY_PREVIOUS`, if set) in the
  environment. Saved keys and tokens are sealed to their account (since 1.26.0): the copy opens each
  and seals it again, in the current envelope, for the account it lands in — a merged account's to
  the one it joins, and anything saved before 1.26.0 (Neon's included) moved out of the old, unbound
  envelope. If a merged account holds credentials it cannot open, it stops before writing a row.
  Without the key, anything from before 1.26.0 is copied as it was, and it says so.
- **The order, when `ENCRYPTION_REFUSE_V1` is in the plan:** copy first, then `npm run secrets:reseal`
  on the new database, and set `ENCRYPTION_REFUSE_V1=true` only when the reseal says it is safe.

## Keeping an eye on the free limits

- **500 MB.** Chats are small; files are not. Pictures, PDFs and documents are stored in the database
  itself, and those are what fill it. `DATABASE_URL=… npm run storage` shows what is using the space.
- **Paused after 7 days without activity.** Any use of the app counts. A paused project is restored
  from the Supabase dashboard.

## How often a paired computer asks

On a deployment the worker's polling follows whether anybody is there:

| State | When | The worker asks |
|---|---|---|
| Busy | something ran in the last 2 minutes | holds one request open for 25 s at a time |
| Somebody here | the app is open in a visible tab, or something ran in the last 10 minutes | every 5 s |
| Away | neither, for 10 minutes | every 30 s; its full heartbeat every 5 minutes |

The first command after a long absence can wait up to 30 seconds for the machine — but opening the
app marks you present, so by the time a message is typed it is usually back to asking every 5 s.
A local server is unaffected.

## Settings

| Variable | What it does |
|---|---|
| `DATABASE_URL` | The database. Required on a deployment. |
| `DATABASE_CA_CERT` | The database's CA certificate (PEM), so the server is verified as well as encrypted. |
| `DATABASE_DRIVER` | `pg` or `neon`, to override the choice made from the address. |
| `DATABASE_POOL_MAX` | Connections per function instance. Default 1, as Supabase recommends for serverless. |
| `WORKER_IDLE_SLEEP_MS` | How long an idle worker waits between asks while somebody is here. Default 5000 on a deployment. |
| `WORKER_AWAY_SLEEP_MS` | The same while nobody is. Default 30000 on a deployment; `0` turns the away state off. |
