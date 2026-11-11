# Bot Page Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec C — a bot's task started by a signed webhook, waits a bot parks until its next run, and Telegram messages to Chief answered through an outbox that never sends twice.

**Architecture:** Two public routes mounted before the JSON parser (`/api/hooks/telegram/:secret`, `/api/hooks/:routeId`) check their secret on the raw bytes, write a receipt keyed by the delivery (so a retry is a no-op), answer at once and run the work under `waitUntil`. Every such turn carries `origin: 'webhook'` (spec A's gate refuses team changes) and gets its payload inside the `<untrusted>` envelope. Waits are rows, read into the next run's note. Outgoing Telegram text goes through `outbox`, sent after the row is written and retried by the heartbeat.

**Tech Stack:** Node 22 ESM, Express, Postgres (pg; PGlite in tests), vanilla JS, `check()` harness, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-bots-triggers-design.md`.

## Global Constraints

- Schema **47**. One deviation from the spec, on purpose: a webhook's secret is stored **encrypted** (`encryptSecret`, as connector tokens are), not hashed — an HMAC is checked with the secret itself. Telegram's secrets are compared, not used as keys, so those are stored as SHA-256 hashes.
- Signature checked in constant time **before** the body is parsed; body ≤ 64 KB; timestamp ±5 min; a repeated delivery id runs nothing.
- Only the person (session routes) creates, rotates or filters a hook, or turns Telegram on; no bot tool does.
- Webhook and Telegram turns: `origin: 'webhook'`, `unattended: true`, payload in `untrusted(...)`; files from Telegram not fetched.
- Rate limits: per route 30/min and 500/day, per IP 60/min (hooks); Telegram per account 60/min.
- Outbox: a stored provider message id means sent; 403 "blocked" / 400 "chat not found" drop with the reason; others back off (30 s × 2ⁿ, ≤ 1 h, 8 tries).
- Sweeps: receipts 7 days, closed waits 30 days, sent or dropped outbox 7 days.
- Every new string vi + en; CLAUDE.md §5; `npm run gate` green; all browser suites.

### Task 1: Schema 47 and store
`scheduled_tasks.trigger`, `hook_routes`, `hook_receipts` (key, user, route, source, delivery, status, reason, at), `bot_waits`, `telegram_inbound`, `outbox`; store methods; sweep. Tests in `test/bots-triggers.test.mjs`.

### Task 2: Webhooks (C.1)
`server/hooks.js` (`signHook`, `verifyHook`, `acceptHook`, `matchesFilters`), the public route before `express.json`, scheduler `runHookTask` (task prompt + `untrusted('webhook <type>', payload)`), person routes: create with `trigger: 'hook'`, `GET/PATCH /tasks/:id/hook`, rotate, test.

### Task 3: Waits (C.2)
Bot tools `wait_for`, `close_wait` (close offered only with open waits); the run note lists open waits; routes to list and close; Needs you lists waits older than a day.

### Task 4: Outbox and Telegram (C.3)
`server/outbox.js` (enqueue, flush, backoff, drop), heartbeat phase; `telegram_send` through it; `server/telegramInbound.js` (enable → setWebhook, disable → deleteWebhook, `/start <code>`, allowed ids, gate, 👀/✅/❌, stop, turn in Chief's chat, reply via outbox).

### Task 5: The page
Task form trigger choice, secret shown once with Copy, deliveries, rotate, test; wait chips above a bot's box; Telegram switch, code and allowed ids in Settings → Connectors.

### Task 6: Release 1.22.0
