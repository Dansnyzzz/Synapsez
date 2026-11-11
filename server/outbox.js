import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { decryptSecret } from './crypto.js';
import { log } from './util/trace.js';

/*
 * What goes out of the app to a chat, written down before it is sent (spec C.3, after
 * dsh-superagent's outbox with receipts, MIT).
 *
 * Each message is a row first, its id made of what it is — the chat, the turn, the
 * part — so the same part of the same answer is queued once however often the work
 * behind it runs. It is sent after the row is written; a provider message id stored on
 * it means it went, so it is never sent twice. A chat that is gone (Telegram's 403
 * "bot was blocked", 400 "chat not found") drops it with the reason; anything else
 * tries again later — 30 s, then twice as long each time up to an hour, eight times —
 * from the next request or the heartbeat.
 *
 * One gap is left on purpose: a send that succeeded and was not recorded (the function
 * died between the two) is sent again on the retry. Telegram has no idempotency key to
 * close it; the window is one database write.
 */

/** Tries before a message is given up. */
export const OUTBOX_TRIES = 8;
/** A Telegram message's most characters, under its 4096 limit. */
export const TELEGRAM_TEXT = 4000;

const hash = (...parts) => crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex');

/** Wait before try `n` (the first retry is n = 1). */
export const backoffMs = (n) => Math.min(30_000 * 2 ** Math.max(0, n - 1), 3_600_000);

/**
 * Text cut into parts a chat takes, at a paragraph, then a line, then a space.
 *
 * @param {string} text @param {number} [max]
 */
export function splitText(text, max = TELEGRAM_TEXT) {
  const parts = [];
  let rest = String(text ?? '').trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // The last break of each kind in the second half of the window; else a hard cut.
    const at = (sep) => {
      const i = window.lastIndexOf(sep);
      return i > max * 0.5 ? i : -1;
    };
    const cut = [at('\n\n'), at('\n'), at(' ')].find((i) => i > 0) ?? max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Queue a Telegram message, in as many parts as it needs. `key` names what it answers
 * (a turn, a tool call): the same key queues nothing new.
 *
 * @param {{ userId: string, chatId: string | number, text: string, key: string, replyTo?: number | null }} message
 * @returns {Promise<any[]>} the rows
 */
export async function enqueueTelegram({ userId, chatId, text, key, replyTo = null }) {
  const store = getStore();
  const rows = [];
  const parts = splitText(text);
  for (const [i, part] of parts.entries()) {
    rows.push(
      await store.enqueueOutbox({
        id: hash('telegram', userId, chatId, key, i),
        userId,
        channel: { kind: 'telegram', chatId: String(chatId), replyTo: i === 0 && replyTo ? Number(replyTo) : null },
        text: part,
      }),
    );
  }
  return rows;
}

/** A send that will never work: the chat is gone, or the request itself is wrong. */
class Permanent extends Error {}

/** Telegram, with the account's own connected bot. */
async function telegramToken(userId) {
  const row = await getStore().getConnector(userId, 'telegram');
  if (!row) throw new Permanent('Telegram is not connected any more.');
  return decryptSecret(row.token);
}

/**
 * Call the Telegram Bot API for an account. Only api.telegram.org is ever asked.
 *
 * @param {string} userId @param {string} method @param {Record<string, unknown>} body @param {typeof fetch} [fetchImpl]
 */
export async function telegramCall(userId, method, body, fetchImpl = globalThis.fetch) {
  const token = await telegramToken(userId);
  const res = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const answer = await res.json().catch(() => ({}));
  return { status: res.status, ok: !!answer.ok, result: answer.result, description: String(answer.description || ''), retryAfter: Number(answer.parameters?.retry_after) || 0 };
}

/** Send one row; its provider message id, or a throw (Permanent when retrying is pointless). */
async function sendRow(row, fetchImpl) {
  const channel = row.channel || {};
  if (channel.kind !== 'telegram') throw new Permanent(`No way to send to "${channel.kind}".`);
  const answer = await telegramCall(row.user_id, 'sendMessage', {
    chat_id: channel.chatId,
    text: row.text,
    disable_web_page_preview: true,
    ...(channel.replyTo ? { reply_parameters: { message_id: channel.replyTo, allow_sending_without_reply: true } } : {}),
  }, fetchImpl);
  if (answer.ok) return String(answer.result?.message_id ?? '');
  const why = answer.description || `HTTP ${answer.status}`;
  if (answer.status === 403 || /chat not found|bot was blocked|user is deactivated|bot was kicked/i.test(why)) throw new Permanent(`The chat is gone: ${why}`);
  if (answer.status === 400 || answer.status === 401 || answer.status === 404) throw new Permanent(`Telegram refused it: ${why}`);
  throw Object.assign(new Error(`Telegram did not take it: ${why}`), { retryAfter: answer.retryAfter });
}

/**
 * Send what is due: this account's, these rows, or everybody's (the heartbeat).
 *
 * @param {{ userId?: string | null, ids?: string[] | null, limit?: number, fetchImpl?: typeof fetch, now?: () => number }} [options]
 * @returns {Promise<{ sent: string[], dropped: string[], later: string[] }>}
 */
export async function flushOutbox({ userId = null, ids = null, limit = 20, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const store = getStore();
  const out = { sent: [], dropped: [], later: [] };
  const rows = await store.claimOutbox({ userId, ids, limit });
  for (const row of rows) {
    try {
      const providerId = await sendRow(row, fetchImpl);
      await store.markOutboxSent(row.id, providerId);
      out.sent.push(row.id);
    } catch (err) {
      const attempts = Number(row.attempts || 0) + 1;
      if (err instanceof Permanent || attempts >= OUTBOX_TRIES) {
        const reason = err instanceof Permanent ? err.message : `Gave up after ${attempts} tries: ${err.message}`;
        await store.markOutboxDropped(row.id, reason);
        out.dropped.push(row.id);
      } else {
        const wait = Math.max(backoffMs(attempts), (Number(err.retryAfter) || 0) * 1000);
        await store.retryOutbox(row.id, { attempts, dueAt: now() + wait, reason: err.message });
        out.later.push(row.id);
      }
      if (!(err instanceof Permanent)) log.warn('an outbox message was not sent', { id: row.id, err: err?.message });
    }
  }
  return out;
}

/**
 * Queue and send at once — what a turn's reply and the telegram_send tool do. Says how
 * it went: sent, queued for a retry, or dropped and why.
 *
 * @param {{ userId: string, chatId: string | number, text: string, key: string, replyTo?: number | null, fetchImpl?: typeof fetch }} message
 */
export async function sendTelegramNow({ userId, chatId, text, key, replyTo = null, fetchImpl = globalThis.fetch }) {
  const rows = await enqueueTelegram({ userId, chatId, text, key, replyTo });
  const pending = rows.filter((r) => r?.status === 'pending').map((r) => r.id);
  if (pending.length) await flushOutbox({ ids: pending, limit: pending.length, fetchImpl });
  const store = getStore();
  const after = await Promise.all(rows.map((r) => store.getOutbox(r.id)));
  return {
    sent: after.every((r) => r?.status === 'sent'),
    dropped: after.find((r) => r?.status === 'dropped')?.reason || null,
    later: after.some((r) => r?.status === 'pending'),
    rows: after,
  };
}
