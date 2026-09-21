# Core request flow — one agent turn

Traced by reading, not inferred. `[seq]` sequential · `[par]` parallel ·
`[llm]` a model call · `[to]` has a timeout · `[!to]` no timeout · `[val]` validates input.

```
Browser: POST /api/chats/:id/messages          public/js/api.js → server/app.js
  │
  ├─[seq] express.json({limit:'48mb'})                      app.js:180
  ├─[seq] CSP + HSTS + nosniff + frame-deny headers         app.js:194-230
  ├─[seq] x-request-id → AsyncLocalStorage (trace id)       app.js:252-258  [val]
  ├─[seq] await initStore()   ← every request, cold-start   app.js:261-264
  ├─[seq] requireAuth (session cookie)                      app.js:632
  └─[seq] runAgent()                                        server/agent.js
        │
        ├─[seq] checkQuota  — monthly tokens, shared key only    usage.js:29
        ├─[seq] resolve model / pickAutoModel                    autoPick.js
        ├─[seq] buildSystemPrompt  ≈1.8k–3.6k tok                agent.js:32-330
        ├─[seq] availableTools  → 48 of 93 ≈ 6.9k tok            tools/definitions.js
        │
        └── LOOP  step = 0 … prefs.maxSteps (default 60)         agent.js:775
              │
              ├─[seq] absorbNewMessages()  ← user can steer mid-run   agent.js:741
              ├─[seq] shouldCompact? → compact()               [llm] compact.js
              ├─[llm] streamCompletion(provider)               providers/index.js
              │        └── SSE → browser, token by token
              ├─[seq] needsApproval(toolCalls, policy)          agent.js:388
              │        └── if pending → emit approval_required, RETURN
              └─[par] runToolCalls  — mapWithLimit, cap 4       util/parallel.js:23
                    │
                    ├── cloud tool   → in-process              tools/cloud.js
                    ├── MCP tool     → mcp/registry.js         [to]
                    └── local tool   → job queue, scoped by userId   execute.js:44
                          │            enqueueJob → worker polls → completeJob
                          │            timeout 180s default    [to]
                          └── worker/ on the user's own machine
                    │
                    └── every external result wrapped:
                        <untrusted source="…">…</untrusted>    tools/untrusted.js
```

## Where the flow is weak

| Point | Issue | ID |
|---|---|---|
| ~~`connectors.js` verify path~~ | ~~3 fetches with no timeout~~ — **closed.** Re-scanned 2026-09-09: 30 `fetch(` sites across `server/ api/ worker/`, **0** without an abort signal | AUTO-002 (FIXED `2fc370d`) |
| Loop entry | ~10.5k tokens of tools+prompt on **every** turn — 6.9k catalogue after deferral + 3.6k prompt. Corrected 2026-09-09; the earlier 16.9k figure sized the whole `TOOLS` array rather than what a turn sends | PERF-002 (DOWNGRADED) |
| `checkQuota` | returns allowed with no ceiling when `DEFAULT_MONTHLY_TOKEN_LIMIT` is unset | PERF-001 |
| Loop | step budget (60) is a *count*, not a token or cost budget — 60 steps of a large model has no spend ceiling | PERF-001 |
| `initStore()` per request | necessary on serverless cold starts, but it is on the hot path of every call | — noted, not a defect |

## What is genuinely well built here

Recorded because an audit that only lists faults misrepresents the system.

- **Prompt injection** — every external result passes through `untrusted()`, which defangs the
  closing tag so content cannot escape its own envelope, and a standing rule in the system prompt
  explains what the envelope means (`tools/untrusted.js`, `agent.js` `UNTRUSTED_RULE`).
- **Tenancy** — the worker job queue is scoped by `userId` on both enqueue and claim, so a job
  cannot run on another account's machine (`execute.js:38-44`).
- **Credential leakage** — `redactSecrets` is applied on all three channels a key can escape
  through: turn errors, stored step errors, and tool results (`app.js:118`, `execute.js:33`).
- **Login cost** — scrypt at N=2^15 is capped at 4 concurrent hashes with a queue, and a dummy
  hash equalises timing for unknown accounts (`crypto.js:29-45`, `:79-85`).
- **Rate limiting** — counters live in the database, not a Map, so they survive serverless
  instance-hopping; `trust proxy` is 1 hop, not `true` (`ratelimit.js`, `app.js:176`).
