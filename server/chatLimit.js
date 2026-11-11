/**
 * The twenty newest conversations an account keeps (owner, 2026-11-11: "each user holds
 * their 20 most recent conversations; past 20 the system deletes the old ones; admins have
 * no limit").
 *
 * Twenty outside projects, and twenty in each project on its own: a project is organised
 * work, and loose questions must not push it out (the owner, the same day, asked whether
 * counting projects and pins made twenty too few; ChatGPT and Claude cap no project's
 * conversations). Kept by when each was last used, so the conversation someone is
 * carrying on is never the one that goes. A pinned conversation is never deleted and
 * never counted — pins are capped at PIN_LIMIT instead, as ChatGPT caps them (at three),
 * so pinning cannot become a way round the limit. One at work stays. Incognito ones are
 * not counted: they are gone a day after their last use anyway. A bot's or a group's
 * conversations belong to the Bot page. Deleting goes through `purgeChats`, so a
 * conversation leaves nothing of its own behind.
 *
 * Applied after every path that makes a conversation, and again by the hourly sweep —
 * which is what brings an account that held more before this rule down to twenty.
 */
import { getStore } from './store/index.js';
import { log } from './util/trace.js';

export const CHAT_LIMIT = 20;
/** How many conversations an account may pin. Administrators: no limit. */
export const PIN_LIMIT = 10;

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

/**
 * Whether this account may pin one more conversation. Pins already over the limit (from
 * before it) stay; only a new pin is refused.
 *
 * @param {{ id: string, role?: string }} user
 */
export async function mayPin(user, store = getStore()) {
  if (unlimited(user)) return true;
  return (await store.countPinnedChats(user.id)) < PIN_LIMIT;
}

/** The sweep's half: every account over the limit, a batch at a time. */
export async function sweepChatLimit(store = getStore()) {
  let removed = 0;
  for (const userId of await store.accountsOverChats(CHAT_LIMIT)) removed += await keepNewest(userId, store);
  if (removed) log.info('conversation limit', { removed });
  return removed;
}
