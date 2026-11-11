/**
 * The twenty newest conversations an account keeps (owner, 2026-11-11: "each user holds
 * their 20 most recent conversations; past 20 the system deletes the old ones; admins have
 * no limit").
 *
 * Kept by when each was last used, so the conversation someone is carrying on is never
 * the one that goes. Pinned conversations and ones at work stay and count. Incognito
 * ones are not counted: they are gone a day after their last use anyway. A bot's or a
 * group's conversations belong to the Bot page and are not counted either. Deleting goes
 * through `purgeChats`, so a conversation leaves nothing of its own behind.
 *
 * Applied after every path that makes a conversation, and again by the hourly sweep —
 * which is what brings an account that held more before this rule down to twenty.
 */
import { getStore } from './store/index.js';
import { log } from './util/trace.js';

export const CHAT_LIMIT = 20;

/** Administrators keep every conversation (the owner is one). */
export const unlimited = (user) => user?.role === 'admin';

/**
 * Bring one account down to its limit. Never throws: making a conversation must not fail
 * because an old one could not be deleted — the sweep tries again within the hour.
 *
 * @param {{ id: string, role?: string } | string} who the account, or its id
 * @returns {Promise<number>} how many conversations went
 */
export async function keepNewest(who, store = getStore()) {
  try {
    const user = typeof who === 'string' ? await store.getUserById(who) : who;
    if (!user?.id || unlimited(user)) return 0;
    return await store.pruneChatsOver(user.id, CHAT_LIMIT);
  } catch (err) {
    log.error('keeping the newest conversations failed', err);
    return 0;
  }
}

/** The sweep's half: every account over the limit, a batch at a time. */
export async function sweepChatLimit(store = getStore()) {
  let removed = 0;
  for (const userId of await store.accountsOverChats(CHAT_LIMIT)) removed += await keepNewest(userId, store);
  if (removed) log.info('conversation limit', { removed });
  return removed;
}
