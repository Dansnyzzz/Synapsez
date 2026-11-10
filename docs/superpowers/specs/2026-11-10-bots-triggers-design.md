# Bot page — triggers from outside (spec C) · 2026-11-10

Wave 3. Work that starts outside the app and runs on a serverless deployment
without anything staying alive between runs. Ideas from OpenBot (webhooks, waits;
behaviour only) and dsh-superagent (sources → triggers → gate, outbox with
receipts, content-derived ids; MIT). Depends on spec A (origins, `pending`,
self-chained continuation) and B (task runs, Needs you).

## C.1 Webhooks that start a bot's task

- A scheduled task's trigger can be **Khi có yêu cầu đến** (when a request arrives). Creating one makes a route id and a secret; the secret is shown once (copy), stored hashed; Rotate invalidates at once.
- `POST /api/hooks/:routeId`, body `{ type, occurredAt?, data? }` ≤ 64 KB. Headers `X-Synapsez-Timestamp` (±5 min), `X-Synapsez-Delivery` (id), `X-Synapsez-Signature` = HMAC-SHA256(secret, `timestamp.delivery.body`), checked in constant time **before** the body is parsed.
- Filters (optional): exact `type`, and JSON-Pointer equality on `data` (≤ 5).
- Receipts for 7 days (`hook_receipts`: route, delivery id, status, reason, at — never the body): a repeated delivery id answers 200 "duplicate" and runs nothing; the task's page lists recent deliveries and why one was ignored.
- Answers **202** at once, then runs the bot's turn under `waitUntil` with `origin: 'webhook'`: the payload is given as untrusted external data (the same envelope as web pages), cannot change tools or approvals, and team-changing tools are refused (A.1).
- Rate limits: per route 30/min and 500/day, per IP 60/min. "Gửi thử" sends a signed test event from the server.
- Only the person creates, edits or rotates a hook (not a bot).

## C.2 Waits: park a request until the next run

- `wait_for(note ≤ 500)` (any bot, in its own chat): "tell me when the build ends", "check the price again tomorrow". Stored in `bot_waits` (bot, the request's message id and text, note, created, closed) — at most 20 open per bot.
- The bot's next scheduled run, or a webhook for that bot, gets a block listing its open waits (request + note) and closes what it settles with `close_wait(id, outcome)`.
- Chips above the bot's composer show open waits with ✕ (the person closes one); they are also in Needs you (B.2) when older than a day.
- Nothing runs between runs: a wait is a row, not a process.

## C.3 Telegram to Chief

- Settings → Connectors → Telegram (the bot token the account already connected) gains **Cho phép nhắn Chief từ Telegram**. Turning it on calls `setWebhook(url = /api/hooks/telegram/:secret, secret_token)`; off deletes the webhook.
- The route checks `X-Telegram-Bot-Api-Secret-Token`, stores the update as a trigger keyed `sha256('tg', update_id)` (`ON CONFLICT DO NOTHING`, so Telegram's retries are harmless), answers 200 at once, and works under `waitUntil`.
- **Gate**: only allowed Telegram user ids (the account's own, set by sending `/start <code>` shown in Settings; up to 5 more the person adds), and only a DM, an @mention of the Telegram bot, or a reply to it. Everything else is ignored and not stored beyond the receipt.
- The message becomes a turn in Chief's chat (`origin: 'webhook'`, so Chief cannot reshape the team from Telegram — it says to do that in the app). While it works, the Telegram message gets 👀; the answer goes back as a reply; ✅ or ❌ at the end. "stop" from the same sender stops it.
- Replies go through **an outbox** (`outbox`: id = key(chat, turn, part), channel, text, status pending/sent/dropped, provider message id, reason): sent after commit, retried with backoff by the heartbeat, never sent twice (a stored provider message id means sent), dropped with a reason when the chat is gone (Telegram 403 "bot was blocked", 400 "chat not found"). The existing `telegram_send` tool sends through the same outbox.
- Text from Telegram is untrusted; files from Telegram are not fetched in this version.

## Data (schema 47)

`scheduled_tasks.trigger text default 'schedule'`, `hook_routes(id, user_id, task_id,
secret_hash, filters jsonb, created_at, rotated_at)`, `hook_receipts(route_id,
delivery_id, status, reason, at, primary key(route_id, delivery_id))`,
`bot_waits(id, user_id, bot_id, message_id, request, note, created_at, closed_at,
outcome)`, `telegram_inbound(user_id, secret_hash, allowed_ids jsonb, enabled)`,
`outbox(id, user_id, channel jsonb, text, status, provider_id, attempts, due_at,
reason, created_at)`. All swept: receipts 7 days, closed waits 30 days, sent outbox 7 days.

## Testing

webhooks: bad signature / stale timestamp refused before parsing; duplicate
delivery runs once; filters; 202 then run; team tools refused; rate limits; rotate.
waits: create, cap 20, offered to the next run, closed; chips. Telegram: secret
check, duplicate update once, gate (non-allowed sender ignored, group message
without mention ignored), turn in Chief's chat with webhook origin, reply via
outbox exactly once across a retry, gone chat dropped with reason, stop by text.
egress test: api.telegram.org only for Telegram.
