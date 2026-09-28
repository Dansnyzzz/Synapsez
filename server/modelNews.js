import { getStore } from './store/index.js';
import { familyOf } from './models.js';
import { FAMILY_LABELS } from '../public/js/search.js';
import { markedPrice } from './pricing.js';

/**
 * "There is a new model" — the newest model in the tier somebody uses, once.
 *
 * The rule is the model list's own, so the two cannot disagree: the model at
 * the top of the list sorted Newest, in the person's tier, is the one announced.
 * If yesterday's announcement is still the top of the list today, there is
 * nothing new and nothing is shown. The notice used to apply rules the list did
 * not — a quiet period, "only models imported after this account first looked",
 * a list of notable labs — so a model could sit at the top of the list on its
 * release day with no notice, and a model the person was already using could be
 * announced to them days later.
 *
 *   **In the tier they use.** Somebody on a free model hears about the newest
 *   free model and never about a paid one, and the other way round.
 *
 *   **Not one they already have.** Their current default, or one they have used
 *   in the last month, is not news to them.
 *
 *   **Recent, and staying.** Released within the last month — the top of an
 *   old catalogue is not a release — and without an end date: telling somebody
 *   to switch to a model that is going away is telling them to switch twice.
 *
 * State is per account, so one person's answer does not silence it for anyone
 * else.
 */

const NEWS_KEY = 'modelNews';

const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remember at most this many decisions.
 *
 * The list only ever grows, and it lives in a JSON column that is read on every
 * page load. A few hundred is years of releases; beyond that the oldest are
 * dropped, and the worst case is being told once more about a model somebody
 * declined long enough ago to have forgotten.
 */
const MAX_REMEMBERED = 300;

async function newsState(userId) {
  const stored = await getStore().getUserSetting(userId, NEWS_KEY);
  return stored && typeof stored === 'object' && stored.seen ? stored : { seen: {} };
}

/**
 * The newest model in this person's tier, if it is news to them; otherwise null.
 *
 * Only ever the newest. An older model is never offered because the newest was
 * already answered — that is what made the notice drift away from the list —
 * so once the top of the list has been shown, taken, declined or used, nothing
 * is shown until something newer takes its place.
 *
 * @param {string} userId
 * @param {{ tier?: 'free'|'paid', current?: string|null }} [options]
 *   `current` is the account's default model, which is never news to it.
 */
export async function pendingAnnouncement(userId, { tier = 'free', current = null } = {}) {
  const store = getStore();
  const wanted = tier === 'paid' ? 'paid' : 'free';

  // The list's own order and tier. A few rows, only to step past models that are
  // already going away — a withdrawal date is not a release.
  const rows = await store.listSharedModels({ sort: 'new', limit: 10, tier: wanted });
  const now = Date.now();
  const newest = rows.find((r) => !!r.is_free === (wanted === 'free') && !r.expires_at);
  if (!newest?.released_at || now - new Date(newest.released_at).getTime() > RECENT_MS) return null;

  const state = await newsState(userId);
  if (state.seen[newest.id] || state.announced === newest.id) return null;

  // Already theirs: the default they are on, or one they have used this month.
  const used = current === newest.id || (await store.usageByModel(userId, 30)).some((u) => u.model === newest.id);
  if (used) {
    state.announced = newest.id;
    await store.setUserSetting(userId, NEWS_KEY, state);
    return null;
  }
  return describe(newest);
}

/**
 * Record that an announcement reached somebody's screen.
 *
 * Separate from reading it, so a request whose answer nobody saw cannot use the
 * announcement up. After this, the same model is not shown again — whether or
 * not they answered it.
 */
export async function markAnnouncementShown(userId, modelId) {
  const id = String(modelId || '');
  if (!id) return;
  const store = getStore();
  const state = await newsState(userId);
  state.announced = id;
  await store.setUserSetting(userId, NEWS_KEY, state);
}

/** Everything the modal needs to let somebody decide without leaving it. */
function describe(row) {
  const family = row.family || familyOf(row.model || row.id);
  const priceIn = row.price_in == null ? null : Number(row.price_in);
  const priceOut = row.price_out == null ? null : Number(row.price_out);

  return {
    id: row.id,
    label: row.label || row.model,
    model: row.model,
    family,
    vendor: FAMILY_LABELS[family] || family,
    description: row.description || null,
    context: row.context ? Number(row.context) : null,
    isFree: !!row.is_free,
    // As charged — the provider's rate plus this service's share.
    price: priceIn == null ? null : markedPrice({ in: priceIn, out: priceOut }),
    releasedAt: row.released_at,
    addedAt: row.created_at,
  };
}

/**
 * Record what somebody decided.
 *
 * `apply` also makes it their default, which is the entire point of the button —
 * being told about a model and then having to go and find it in a picker is the
 * kind of half-finished feature that gets ignored.
 */
export async function decideAnnouncement(userId, modelId, action) {
  const store = getStore();
  const id = String(modelId || '');
  if (!id) throw new Error('Which model?');
  if (action !== 'apply' && action !== 'decline') {
    throw new Error(`"${action}" is not a decision. It is "apply" or "decline".`);
  }

  // Only a model actually in the library, so a crafted id cannot become somebody's
  // default and fail on every turn afterwards.
  const row = await store.getSharedModel(id);
  if (!row) throw new Error('That model is not in the library.');

  const state = await newsState(userId);
  state.seen[id] = { action, at: new Date().toISOString() };

  const ids = Object.keys(state.seen);
  if (ids.length > MAX_REMEMBERED) {
    const oldest = ids
      .sort((a, b) => String(state.seen[a].at).localeCompare(String(state.seen[b].at)))
      .slice(0, ids.length - MAX_REMEMBERED);
    for (const key of oldest) delete state.seen[key];
  }

  await store.setUserSetting(userId, NEWS_KEY, state);
  return { ok: true, applied: action === 'apply', model: describe(row) };
}
