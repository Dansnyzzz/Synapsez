import { getStore } from './store/index.js';
import { getRecommended } from './recommend.js';

/**
 * "The suggested models have changed" — said once to everyone (owner, 2026-11-10).
 *
 * An administrator's change to the suggested models (recommend.js) carries a version,
 * the moment it was made. An account is told once per change: at its next visit (the
 * boot data carries the notice), or within the twenty-second poll if it is on the page
 * then (the poll carries the version, and a version the tab has not seen asks for the
 * notice). Either answer, or closing it, marks that version seen for the account; a
 * later change is told again. Nothing is said about a change made before the account
 * existed, and the administrator who made it has seen it.
 */

const SEEN_KEY = 'seenRecommended';

/** The version of the suggestion as it stands, or null when nobody has chosen. */
export async function recommendedVersion() {
  return (await getRecommended()).version || null;
}

/**
 * The notice for this account, or null when it has nothing to hear.
 *
 * @param {{ id: string, created_at?: any }} user
 * @param {{ recommended: { free?: any, freeSecond?: any, paid?: any }, suggestion?: any }} context
 *   `recommended`: the suggestions with their labels (recommendedWithLabels); `suggestion`:
 *   the one for this account's keys, which "Use it" switches to
 */
export async function suggestionNotice(user, { recommended, suggestion = null }) {
  const version = await recommendedVersion();
  if (!version || !user?.id) return null;
  const at = Date.parse(version);
  if (user.created_at && new Date(user.created_at).getTime() > at) return null;
  const seen = await getStore().getUserSetting(user.id, SEEN_KEY).catch(() => null);
  if (seen?.version && Date.parse(seen.version) >= at) return null;
  const view = (m) => (m?.id ? { id: m.id, label: m.label || m.id } : null);
  return {
    version,
    free: view(recommended?.free),
    freeSecond: view(recommended?.freeSecond),
    paid: view(recommended?.paid),
    suggestion: suggestion ? { id: suggestion.id, label: suggestion.label, inUse: !!suggestion.inUse } : null,
  };
}

/**
 * This account has heard about the change made at `version`. A version that is not a
 * moment is refused, so nothing but a version can be stored here.
 *
 * @param {string} userId @param {unknown} version
 */
export async function markSuggestionSeen(userId, version) {
  const value = String(version ?? '');
  if (!value || Number.isNaN(Date.parse(value))) throw Object.assign(new Error('That is not a version of the suggestion.'), { status: 400 });
  await getStore().setUserSetting(userId, SEEN_KEY, { version: new Date(value).toISOString() });
}
