# INVENTORY — modules read directly by the lead auditor

Rows below were produced by opening the file. Modules covered by the four parallel
explorers are appended once those reports land; until then they are `[UNKNOWN] chưa đọc`.

| Module | File:line | Chức năng THỰC | Gọi ra ngoài | Timeout/retry | Validate | Test | Trạng thái |
|---|---|---|---|---|---|---|---|
| Vercel entry | `api/index.js:1-41` | Wraps `createApp()`; on missing secrets answers **every** request 503 naming the variable, rather than throwing at import | none | n/a | `assertSecrets()` | `deploy.test` | hoạt động |
| Local entry | `server/index.js:1-90` | Hand-rolled `.env` loader, generates secrets on first run, starts scheduler, reaps MCP children on SIGINT/SIGTERM | none | n/a | `assertSecrets()` | `deploy.test` | hoạt động |
| HTTP app | `server/app.js:1-2783` | ~93 routes, CSP/HSTS, trust-proxy=1, request-id in AsyncLocalStorage, 48mb JSON limit | via imports | per-call | per-route | `http.test` | hoạt động — **too large (ARCH-001)** |
| Agent loop | `server/agent.js:1-1033` | Builds prompt, resolves model, loops ≤`maxSteps`, compacts, absorbs mid-run user messages, gates approval, fans tools out ≤4 | providers | step cap 60 | policy + risk | `agent.test` | hoạt động |
| Injection guard | `server/tools/untrusted.js:1-70` | Wraps external content in `<untrusted source=…>`, defangs the closing tag with a zero-width space, plus a standing prompt rule | none | n/a | n/a | `isolation.test` | hoạt động — **genuinely good** |
| Tool executor | `server/tools/execute.js:1-249` | Routes to cloud / MCP / worker queue; rows scoped by `userId` on enqueue **and** claim; 180s timeout; redacts secrets from every error | queue, MCP | 180s | tool schema | `agent`, `toolbudget` | hoạt động |
| Tool catalogue | `server/tools/definitions.js:1-2233` | 93 definitions + `assessRisk`/`riskReason` driving approval | n/a | n/a | schema/tool | `eval/` | hoạt động — **13.3k tok/turn (PERF-002)** |
| Password hashing | `server/crypto.js:1-263` | scrypt N=2^15, max 4 concurrent with a queue, dummy hash equalises unknown-account timing, hand-rolled TOTP (RFC 6238) | none | n/a | rejects out-of-range cost from DB | `http.test` | hoạt động |
| Rate limiting | `server/ratelimit.js:1-113` | DB-backed counters (survive serverless instance-hopping), IP + identity dimensions, prefers platform headers over forgeable XFF | store | n/a | n/a | `http.test` | hoạt động |
| Redaction | `server/redact.js:1-108` | Vendor key prefixes, `NAME=value`, URL credentials, bearer headers; reports what it removed | none | n/a | n/a | `http.test` | hoạt động |
| Secrets bootstrap | `server/secrets.js:1-92` | Generates `SESSION_SECRET`/`ENCRYPTION_KEY`; **also writes `FILE_ACCESS=full` + `DESKTOP_ACCESS=true` by default** | none | n/a | n/a | `deploy.test` | hoạt động — **SEC-001** |
| Usage/quota | `server/usage.js:1-94` | Monthly token accounting by role; limit applies only to shared-key accounts | store | n/a | n/a | — | hoạt động — **no default cap (PERF-001)** |
| Connectors | `server/connectors.js:1-386` | GitHub/Notion/Slack/Telegram/Meta verify + send | 12 fetches | **3 with none** `:28,:41,:54` | token shape | — | hoạt động — **AUTO-001** |
| Store (SQL) | `server/store/pg.js` spot-checked | **0 string-interpolated SQL.** `updateUser:359-374` interpolates column names only, from a hardcoded whitelist; values always parameterised | Postgres/Neon | n/a | whitelist | `schema`, `isolation` | hoạt động — full read pending |
| Providers | `server/providers/*.js` | 5 behind one `streamCompletion`: anthropic, openai, google, openrouter, orcarouter | provider APIs | signal passed in | per-adapter | `fallback`, `orcarouter` | hoạt động |
| Parallel helper | `server/util/parallel.js:23` | `MAX_PARALLEL_TOOLS = 4`, `mapWithLimit` | none | n/a | n/a | `stop.test` | hoạt động (new, uncommitted) |
| Gate | `.claude/hooks/gate.js:1-265` | Evidence ledger; only the process that ran the suites may stamp; a commit or edit invalidates the stamp | spawns npm | 20 min | n/a | `hooks.test` | hoạt động — **scope wrong (CFG-001)** |
| Stop guard | `.claude/hooks/verify-stop.js:1-149` | Blocks a completion claim (EN + VI) when the gate does not cover the tree | none | n/a | n/a | `hooks.test` | hoạt động — inherits CFG-001 |
| Bash guard | `.claude/hooks/guard-bash.js:1-200` | Blocks commits on `main`, force-push, push to a protected branch, registry publishing | git | 10s | **literal text match** | `hooks.test` | hoạt động — **CFG-002** |

## Chưa đọc — `[UNKNOWN]`

`worker/**` (5,995 ln) · `scripts/**` (1,507 ln) · `public/**` (11,968 ln JS) ·
`server/store/pg.js` in full (2,619 ln) · `server/office/**` · `server/research/**` ·
`server/mcp/**` · `rag.js` · `search.js` · `scheduler.js` · `workflows.js` · `subagents.js` ·
`projects.js` · `attachments.js` · `compact.js` · `models.js` in full · `test/**` (16,253 ln) ·
`.claude/commands|agents|skills/**` · `docs/**`

Four explorers are reading these now. Nothing above is asserted about them.
