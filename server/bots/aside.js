import { getStore } from '../store/index.js';
import { streamCompletion } from '../providers/index.js';
import { priceTurn } from '../providers/catalog.js';
import { checkQuota, record as recordUsage } from '../usage.js';
import { resolveForUser } from '../autoPick.js';
import { getPrefs, usesSharedKey } from '../settings.js';
import { botPersona } from './prompt.js';
import { BotError } from './team.js';

/*
 * "Ask aside" (spec B.6, after DS Bot's side question): one question to a bot about
 * its conversation, answered in a card beside it and never kept — not in the
 * conversation, not in memory — so the conversation and its cached prefix are just
 * as they were. One call, no tools, on the model the chip shows; booked to the bot
 * as its own line on the Usage page (\`ask_aside\`).
 */

/** How much of the conversation the answer reads: the newest messages with words in them. */
export const ASIDE_MESSAGES = 60;
/** The longest question. */
export const ASIDE_QUESTION = 2000;
/** One message of the conversation, cut to this for the aside. */
const LINE_CHARS = 4000;

const SYSTEM_NOTE =
  'This question is asked aside, next to the conversation above: answer it briefly from the conversation and what you know. You have no tools here, and nothing of this exchange is kept or seen by anyone but the user.';

/**
 * @param {{ user: { id: string } & Record<string, any>, botId: string, question: unknown, model?: string | null,
 *   signal?: AbortSignal, stream?: typeof streamCompletion, resolve?: typeof resolveForUser }} options
 * @returns {Promise<{ answer: string, model: string }>}
 */
export async function askAside({ user, botId, question, model = null, signal = AbortSignal.timeout(90_000), stream = streamCompletion, resolve = resolveForUser }) {
  const store = getStore();
  const userId = user.id;
  const bot = await store.getBot(userId, botId);
  if (!bot) throw new BotError('No such bot.', 404, 'not_found');
  const asked = String(question ?? '').normalize('NFC').trim();
  if (!asked) throw new BotError('Ask something.', 400, 'empty');
  if (asked.length > ASIDE_QUESTION) throw new BotError(`A question aside is at most ${ASIDE_QUESTION} characters.`, 400, 'too_long');

  const chat = await store.botChat(userId, { botId: bot.id, title: bot.name });
  if (!chat) throw new BotError('No such bot.', 404, 'not_found');
  const persona = await botPersona(userId, chat);
  const prefs = await getPrefs(userId).catch(() => /** @type {any} */ ({}));
  let entry;
  try {
    entry = await resolve(userId, String(model || prefs.defaultModel || 'auto'));
  } catch {
    entry = null;
  }
  if (!entry) throw new BotError('No model can answer right now. Pick another in the top bar.', 503, 'no_model');
  // The same ceiling as any turn: an aside is not a way around it.
  const quota = await checkQuota(user, { usingSharedKey: await usesSharedKey(userId, entry.provider) });
  if (!quota.allowed) throw new BotError(quota.reason, 429, 'quota_exceeded');

  const history = (await store.listMessages(userId, chat.id))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim() && !m.quiet)
    .slice(-ASIDE_MESSAGES)
    .map((m) => ({ id: m.id, role: m.role, text: String(m.text).slice(0, LINE_CHARS) }));
  const system = [persona?.intro, persona?.section, SYSTEM_NOTE].filter(Boolean).join('\n\n');

  let said = '';
  let spent = null;
  try {
    for await (const ev of stream({ userId, entry, system, messages: [...history, { id: 'aside', role: 'user', text: asked }], tools: [], effort: 'low', maxTokens: 1200, signal })) {
      if (ev.type === 'text') said += ev.delta ?? '';
      else if (ev.type === 'done') spent = ev.usage || null;
    }
  } catch (err) {
    if (spent) await recordUsage(userId, { chatId: chat.id, model: entry.id, usage: spent, costUsd: priceTurn(entry, spent)?.usd || 0, role: 'ask_aside', origin: 'person' }).catch(() => {});
    throw new BotError(`The model did not answer: ${String(err?.message || err).slice(0, 160)}`, 502, 'model_failed');
  }
  // Booked to the bot (the conversation names it), on its own line.
  if (spent) await recordUsage(userId, { chatId: chat.id, model: entry.id, usage: spent, costUsd: priceTurn(entry, spent)?.usd || 0, role: 'ask_aside', origin: 'person' }).catch(() => {});
  const answer = said.trim();
  if (!answer) throw new BotError('The model gave no answer. Try again, or another model.', 502, 'empty_answer');
  return { answer, model: entry.id };
}
