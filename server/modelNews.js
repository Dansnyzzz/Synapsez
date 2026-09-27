import { getStore } from './store/index.js';
import { familyOf } from './models.js';
import { FAMILY_LABELS } from '../public/js/search.js';
import { markedPrice } from './pricing.js';

/**
 * "There is a new model" — said once, to each person, about the models that
 * actually warrant interrupting somebody.
 *
 * The library refreshes itself daily and OpenRouter publishes hundreds of
 * entries, so announcing every arrival would be a modal a day for a fine-tune of
 * something nobody has heard of. That is not a feature, it is a reason to stop
 * reading modals. Two filters do the work:
 *
 *   **Recent.** Released within the last month. An old model appearing in the
 *   catalogue for the first time is news about the catalogue, not about the
 *   model.
 *
 *   **From a lab whose releases are events.** Anthropic, OpenAI, Google, Meta,
 *   xAI, DeepSeek, Qwen, Mistral. This is a judgement call and it is meant to
 *   be: the question is not "is this model good" but "would this person want to
 *   be told", and for a flagship from one of these the answer is usually yes.
 *   Paid models only: a new *free* model is news to somebody on a free model
 *   whoever made it, because the alternative is them never hearing of it.
 *
 *   **In the tier they use.** Somebody on a free model hears about free models
 *   and not about paid ones, and the other way round. And never a model that
 *   already has an end date — telling somebody to switch to a model that is
 *   going away is telling them to switch twice.
 *
 * Seen state is per account and per model, so a shared deployment does not have
 * one person's dismissal silence it for everybody. Recorded on both answers —
 * taking it and turning it down are both decisions, and neither should be asked
 * about twice.
 */

const NEWS_KEY = 'modelNews';

/** Labs whose releases are worth a modal. */
const NOTABLE_FAMILIES = new Set([
  'anthropic',
  'openai',
  'google',
  'meta',
  'xai',
  'deepseek',
  'qwen',
  'mistral',
]);

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

/** At most one interruption a day, however busy the labs have been. */
const QUIET_PERIOD_MS = 20 * 60 * 60 * 1000;

async function newsState(userId) {
  const stored = await getStore().getUserSetting(userId, NEWS_KEY);
  return stored && typeof stored === 'object' && stored.seen ? stored : { seen: {} };
}

/**
 * The one model to tell this account about, or null.
 *
 * The hard part is what "new" means, and getting it wrong is what turns a
 * useful notice into the thing people close without reading. It cannot mean
 * "recently released": the library holds hundreds of models and a fresh account
 * would meet a queue of modals, one per reload, for every good release of the
 * past month. Nobody wants to be caught up on the news; they want to be told
 * when something happens.
 *
 * So "new" means **arrived after this account started watching**. The first look
 * establishes that line and announces nothing — there is no news on the day you
 * subscribe — and everything after it is genuinely a thing that just happened.
 *
 * One at a time, and at most one a day, so even a busy week cannot become a
 * queue.
 */
export async function pendingAnnouncement(userId, { tier = 'free' } = {}) {
  const store = getStore();
  const state = await newsState(userId);

  // First look: draw the line and say nothing. Deliberately silent — the
  // alternative is greeting a new account with a stack of month-old releases.
  if (!state.since) {
    state.since = new Date().toISOString();
    await store.setUserSetting(userId, NEWS_KEY, state);
    return null;
  }

  if (state.lastShownAt && Date.now() - new Date(state.lastShownAt).getTime() < QUIET_PERIOD_MS) {
    return null;
  }

  // Newest first, and only a page of them: the answer is at the top or it is not
  // worth showing.
  const wanted = tier === 'paid' ? 'paid' : 'free';
  const candidates = await store.listSharedModels({ sort: 'new', limit: 60, tier: wanted });
  const now = Date.now();
  const since = new Date(state.since).getTime();

  for (const row of candidates) {
    if (state.seen[row.id]) continue;
    // Discovered by the daily refresh after this account started watching.
    if (!row.created_at || new Date(row.created_at).getTime() <= since) continue;
    // And actually a release, not an old model the catalogue only just listed.
    if (!row.released_at) continue;
    if (now - new Date(row.released_at).getTime() > RECENT_MS) continue;
    if (!!row.is_free !== (wanted === 'free')) continue;
    if (row.expires_at) continue;
    if (wanted === 'paid' && !NOTABLE_FAMILIES.has(row.family || familyOf(row.model || row.id))) continue;

    /**
     * The quiet period starts when it is *shown*, not when it is fetched.
     *
     * This used to stamp `lastShownAt` here, before the response had been
     * delivered — so a prefetch, a double render, or a response the browser
     * never received burned the twenty-hour window and the account was simply
     * never told about the model. The write moved to `markAnnouncementShown`,
     * which the client calls once the dialog is actually on screen.
     */
    return describe(row);
  }
  return null;
}

/**
 * Record that an announcement really reached somebody.
 *
 * Separate from reading it, so the quiet period cannot be spent by a request
 * whose answer nobody saw. Safe to call more than once: the window is measured
 * from the last stamp, and re-stamping it a second later changes nothing.
 */
export async function markAnnouncementShown(userId) {
  const store = getStore();
  const state = await newsState(userId);
  state.lastShownAt = new Date().toISOString();
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
