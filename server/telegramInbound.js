import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { getStore, isServerless } from './store/index.js';
import { getPrefs } from './settings.js';
import { log } from './util/trace.js';
import { abortHere, holdRun } from './liveRuns.js';
import { telegramCall, sendTelegramNow } from './outbox.js';
import { ensureChief } from './bots/team.js';

/*
 * Telegram to Chief (spec C.3, after OpenBot's Telegram channel and dsh-superagent's
 * gate, MIT).
 *
 * Turned on in Settings → Connectors with the bot token the account already connected,
 * it points the bot's webhook at a URL of this account's own (a random secret in the
 * path) and gives Telegram a second secret for its header. Both are kept as hashes. An
 * update is checked against them before it is read; keyed by its update id, so
 * Telegram's retries do nothing; answered 200 at once; and worked on behind the answer.
 *
 * The gate: only the Telegram ids the person allowed — their own, linked by sending
 * the bot "/start <code>" shown in Settings, and up to five more — and only a direct
 * message, an @mention of the bot or a reply to it. Anything else is dropped with a
 * receipt and nothing more. What passes becomes a turn in Chief's chat that a 'webhook'
 * started: Chief cannot reshape the team from Telegram. 👀 while it works, the answer as
 * a reply through the outbox, ✅ or ❌ at the end; "stop" from the same sender stops it.
 * Files sent on Telegram are not fetched in this version.
 */

/** Telegram ids the person may add beside their own. */
export const TELEGRAM_EXTRA_IDS = 5;
/** An account's updates a minute, at most. */
export const TELEGRAM_PER_MINUTE = 60;

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const sameHash = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const STOP_WORDS = /^\s*(stop|dừng|dừng lại|thôi)\s*[.!]*\s*$/i;

/** What Settings shows: never a secret. */
export function telegramView(row) {
  const ids = Array.isArray(row?.allowed_ids) ? row.allowed_ids.map(String) : [];
  return { enabled: !!row?.enabled, botUsername: row?.bot_username || null, startCode: row?.enabled ? row?.start_code || null : null, owner: ids[0] || null, others: ids.slice(1) };
}

/**
 * Turn it on: a fresh URL secret and header secret, Telegram's webhook pointed at them,
 * and a code for "/start" (kept across turning it off and on).
 *
 * @param {string} userId @param {{ base: string, fetchImpl?: typeof fetch }} options  `base`: the app's public https origin
 */
export async function enableTelegram(userId, { base, fetchImpl = globalThis.fetch }) {
  const store = getStore();
  if (!/^https:\/\/[^/]+$/.test(String(base || ''))) throw Object.assign(new Error('Telegram can only reach an https address; set PUBLIC_URL on the deployment.'), { status: 400 });
  const pathSecret = crypto.randomBytes(24).toString('base64url');
  const headerSecret = crypto.randomBytes(32).toString('base64url');
  const me = await telegramCall(userId, 'getMe', {}, fetchImpl);
  if (!me.ok) throw Object.assign(new Error(`Telegram did not answer for the connected bot: ${me.description || `HTTP ${me.status}`}`), { status: 502 });
  const set = await telegramCall(userId, 'setWebhook', { url: `${base}/api/hooks/telegram/${pathSecret}`, secret_token: headerSecret, allowed_updates: ['message'], drop_pending_updates: true }, fetchImpl);
  if (!set.ok) throw Object.assign(new Error(`Telegram refused the webhook: ${set.description || `HTTP ${set.status}`}`), { status: 502 });
  const now = await store.getTelegramInbound(userId);
  return store.saveTelegramInbound(userId, {
    path_hash: sha(pathSecret),
    token_hash: sha(headerSecret),
    bot_username: me.result?.username || null,
    start_code: now?.start_code || String(crypto.randomInt(100000, 1000000)),
    enabled: true,
  });
}

/** Turn it off: Telegram stops sending, and anything that still arrives is refused. */
export async function disableTelegram(userId, { fetchImpl = globalThis.fetch } = {}) {
  const store = getStore();
  await telegramCall(userId, 'deleteWebhook', { drop_pending_updates: true }, fetchImpl).catch(() => null);
  return store.saveTelegramInbound(userId, { enabled: false });
}

/** The ids besides the person's own, checked: numbers, at most five. */
export async function setTelegramOthers(userId, ids) {
  const store = getStore();
  const row = await store.getTelegramInbound(userId);
  if (!row) throw Object.assign(new Error('Turn on Telegram to Chief first.'), { status: 409 });
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))];
  if (list.some((x) => !/^\d{3,15}$/.test(x))) throw Object.assign(new Error('A Telegram id is a number.'), { status: 400 });
  if (list.length > TELEGRAM_EXTRA_IDS) throw Object.assign(new Error(`At most ${TELEGRAM_EXTRA_IDS} more people can message Chief.`), { status: 400 });
  const own = Array.isArray(row.allowed_ids) && row.allowed_ids[0] ? [String(row.allowed_ids[0])] : [];
  return store.saveTelegramInbound(userId, { allowed_ids: [...own, ...list.filter((x) => !own.includes(x))] });
}

/** Whether a message is meant for the bot: a direct message, an @mention of it, or a reply to it. */
export function addressed(message, botUsername) {
  if (message?.chat?.type === 'private') return true;
  const name = String(botUsername || '').toLowerCase();
  if (!name) return false;
  if (String(message?.reply_to_message?.from?.username || '').toLowerCase() === name) return true;
  return new RegExp(`(^|\\s)@${name.replace(/[^\w]/g, '')}\\b`, 'i').test(String(message?.text || ''));
}

/**
 * One update from Telegram, from its raw bytes to its answer (always quick; Telegram
 * sends again whatever is not answered 200).
 *
 * @param {{ secret: string, raw: Buffer, headers: Record<string, any>, req?: any, start?: (job: any) => void, fetchImpl?: typeof fetch }} request
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function acceptTelegram({ secret, raw, headers, start = startTelegramTurn, fetchImpl = globalThis.fetch }) {
  const store = getStore();
  const row = /^[\w-]{20,80}$/.test(String(secret)) ? await store.findTelegramInbound(sha(secret)) : null;
  if (!row || !row.enabled) return { status: 404, body: { ok: false } };
  if (!sameHash(sha(headers?.['x-telegram-bot-api-secret-token'] ?? ''), row.token_hash)) return { status: 401, body: { ok: false } };
  const hit = await store.hitRateLimit?.(`telegram:${row.user_id}`, TELEGRAM_PER_MINUTE, 60_000).catch(() => null);
  if (hit && !hit.allowed) return { status: 429, body: { ok: false } };
  let update;
  try {
    update = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? ''));
  } catch {
    return { status: 200, body: { ok: true } };
  }
  const updateId = Number(update?.update_id);
  if (!Number.isFinite(updateId)) return { status: 200, body: { ok: true } };
  const key = sha(`tg\u0000${row.user_id}\u0000${updateId}`);
  const first = await store.addHookReceipt({ key, userId: row.user_id, source: 'telegram', deliveryId: String(updateId), status: 'accepted' });
  if (!first) return { status: 200, body: { ok: true, duplicate: true } };
  const ignore = async (reason) => {
    await store.setHookReceipt(key, { status: 'ignored', reason });
    return { status: 200, body: { ok: true } };
  };
  const message = update.message;
  const text = String(message?.text || '').trim();
  if (!message || !text) return ignore('not a text message');
  const from = String(message.from?.id ?? '');
  const allowed = (Array.isArray(row.allowed_ids) ? row.allowed_ids : []).map(String);

  // Linking the person's own Telegram id: "/start <code>" in a direct message.
  const linking = /^\/start(?:@\w+)?\s+(\d{6})\s*$/.exec(text);
  if (linking && message.chat?.type === 'private') {
    if (!row.start_code || !sameHash(linking[1], row.start_code)) return ignore('wrong code');
    await store.saveTelegramInbound(row.user_id, { allowed_ids: [from, ...allowed.filter((x) => x !== from)] });
    await store.setHookReceipt(key, { status: 'linked', reason: null });
    await sendTelegramNow({ userId: row.user_id, chatId: message.chat.id, text: 'Linked: messages from you here now reach Chief.', key: `link:${key}`, replyTo: message.message_id, fetchImpl }).catch(() => null);
    return { status: 200, body: { ok: true } };
  }
  if (!from || !allowed.includes(from)) return ignore('sender not allowed');
  if (!addressed(message, row.bot_username)) return ignore('not addressed to the bot');

  if (STOP_WORDS.test(text.replace(new RegExp(`@${String(row.bot_username || '').replace(/[^\w]/g, '')}`, 'ig'), ''))) {
    await stopChief(row.user_id);
    await store.setHookReceipt(key, { status: 'stopped', reason: null });
    await react(row.user_id, message, '👌', fetchImpl);
    return { status: 200, body: { ok: true } };
  }
  start({ userId: row.user_id, message, text, key, botUsername: row.bot_username });
  return { status: 200, body: { ok: true } };
}

/** A reaction on the person's message (👀, ✅, ❌): best effort, never a failure. */
async function react(userId, message, emoji, fetchImpl = globalThis.fetch) {
  await telegramCall(userId, 'setMessageReaction', { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: 'emoji', emoji }] }, fetchImpl).catch(() => null);
}

/** Stop what Chief is doing for this account: here at once, and on another instance through the lease. */
async function stopChief(userId) {
  const store = getStore();
  const prefs = await getPrefs(userId).catch(() => ({}));
  const chief = await ensureChief(userId, prefs);
  const chat = await store.botChat(userId, { botId: chief.id, title: chief.name });
  if (!chat) return;
  await store.stopChatRun(userId, chat.id).catch(() => false);
  abortHere(userId, chat.id);
}

/**
 * The work behind the answer: the message becomes a turn in Chief's chat, and the reply
 * goes back through the outbox.
 *
 * @param {{ userId: string, message: any, text: string, key: string, botUsername?: string | null, runAgent?: any, fetchImpl?: typeof fetch }} job
 */
export async function runTelegramTurn({ userId, message, text, key, botUsername = null, runAgent = null, fetchImpl = globalThis.fetch }) {
  const store = getStore();
  const user = await store.getUserById(userId);
  if (!user) return { status: 'gone' };
  const prefs = await getPrefs(userId).catch(() => ({}));
  const chief = await ensureChief(userId, prefs);
  const chat = await store.botChat(userId, { botId: chief.id, title: chief.name });
  const runId = crypto.randomUUID();
  const seq = await store.claimChatRun(userId, chat.id, runId);
  if (!seq) {
    await sendTelegramNow({ userId, chatId: message.chat.id, text: 'Chief is answering something else. Send it again in a moment.', key: `busy:${key}`, replyTo: message.message_id, fetchImpl }).catch(() => null);
    await store.setHookReceipt(key, { status: 'busy', reason: 'Chief was answering something else' });
    return { status: 'busy' };
  }
  await react(userId, message, '👀', fetchImpl);
  const controller = new AbortController();
  const letGo = holdRun(userId, chat.id, controller);
  let failed = '';
  let said = '';
  try {
    const words = botUsername ? text.replace(new RegExp(`@${botUsername.replace(/[^\w]/g, '')}\\b`, 'ig'), '').trim() : text;
    const asked = await store.appendMessage(userId, chat.id, { id: crypto.randomUUID(), role: 'user', text: words.slice(0, 8000), origin: 'webhook', via: 'telegram' });
    const loop = runAgent || (await import('./agent.js')).runAgent;
    await loop({
      userId,
      user,
      chatId: chat.id,
      modelId: undefined,
      decision: undefined,
      decisionFor: undefined,
      answers: undefined,
      deviceHint: undefined,
      // Nobody can press a card or say yes on Telegram: a step that needs one stops.
      unattended: true,
      turnOrigin: 'webhook',
      signal: controller.signal,
      emit: (event, data) => {
        if (event === 'error') failed = String(data?.message || 'failed');
      },
    });
    const after = await store.messagesSince(userId, chat.id, Number(asked.seq));
    said = [...after].reverse().find((m) => m.role === 'assistant' && String(m.text || '').trim())?.text || '';
  } catch (err) {
    failed = String(err?.message || err);
  } finally {
    letGo();
    await store.releaseChatRun(userId, chat.id, runId, seq).catch(() => {});
  }
  const stopped = controller.signal.aborted;
  const reply = said.trim() || (stopped ? 'Stopped.' : failed ? `I could not answer: ${failed.slice(0, 300)}` : 'I have nothing to say to that.');
  const sent = await sendTelegramNow({ userId, chatId: message.chat.id, text: reply, key: `reply:${key}`, replyTo: message.message_id, fetchImpl }).catch((err) => ({ sent: false, dropped: String(err?.message || err), later: false }));
  await react(userId, message, said.trim() && !failed ? '✅' : '❌', fetchImpl);
  await store.setHookReceipt(key, { status: said.trim() && !failed ? 'ran' : stopped ? 'stopped' : 'failed', reason: failed ? failed.slice(0, 200) : sent.dropped || null });
  return { status: 'ran', sent };
}

/** Start the turn after the answer: held open by `waitUntil` on Vercel. */
export function startTelegramTurn(job) {
  const work = runTelegramTurn(job).catch((err) => log.error('a Telegram turn failed', err));
  if (isServerless()) waitUntil(work);
}
