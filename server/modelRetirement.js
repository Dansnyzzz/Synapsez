import { getStore } from './store/index.js';
import { CATALOG } from './providers/catalog.js';
import { setPrefs } from './settings.js';
import { hasExpired } from './models.js';
import { AUTO_ID, isAuto, pickAutoModel } from './autoPick.js';

/**
 * A model the account chose, gone from the provider — and what happens then.
 *
 * The library already drops a model on its end date (`expires_at`) and forgets
 * one its source stops listing (`pruneMissingModels`), so it vanishes from the
 * picker on time. What it did not do was move anybody off it. The account's
 * choice is stored on the account, so the chip at the top of the conversation
 * kept naming a model that no longer existed, every turn failed with the
 * provider's 404, and so did every scheduled task and workflow that ran on it —
 * "No endpoints found for stealth/space-bunny-alpha" in red on the Workflows
 * page, with nothing to say why or what to do.
 *
 * Now the first thing that reads the choice after the model has gone — opening
 * the app, sending a message, a scheduled run — moves the account to Auto, the
 * free router, and leaves a notice the interface shows once. And a provider that
 * says "this model is gone" in the middle of a turn gets the same answer there
 * and then, with the step tried again on Auto rather than failed.
 *
 * Auto rather than a "similar" model: it is free, it is always there with an
 * OpenRouter key, and nothing has to guess what somebody would have wanted. It
 * never moves anybody *to* a paid model.
 */

/** The providers whose models live in the shared library, refreshed daily. */
const LIBRARY_PROVIDERS = new Set(['openrouter', 'orcarouter']);

/** `openrouter/vendor/name:free` → `name:free`, the way the chip shows it. */
const shortName = (id) => String(id || '').split('/').pop() || String(id || '');

/**
 * Whether a model id is no longer served, as far as the library can tell.
 *
 * A built-in is never "gone" here: the provider catalogue maps a shut-down
 * built-in to its successor (RETIREMENTS in providers/catalog.js). A library
 * model is gone when its row is past its end date, or when its row has been
 * removed while the same provider still has rows — a source that stopped
 * listing it. An empty library for that provider (a first deploy, a refresh
 * that never landed) says nothing either way, so nothing is moved on it.
 *
 * @param {string} id
 * @returns {Promise<{ label: string } | null>}
 */
export async function goneModel(id) {
  if (!id || isAuto(id) || CATALOG.some((m) => m.id === id)) return null;
  const store = getStore();
  const row = await store.getSharedModel(id);
  if (row) return hasExpired(row) ? { label: row.label || shortName(id) } : null;
  const provider = String(id).split('/')[0];
  if (!LIBRARY_PROVIDERS.has(provider)) return null;
  const known = await store.listSharedModels({ provider, limit: 1 }).catch(() => []);
  return known.length ? { label: shortName(id) } : null;
}

/**
 * A provider's way of saying "this model is not there any more".
 *
 * Deliberately wider than a status code. A provider that has retired a model
 * answers 404 with prose — a thank-you for taking part in a preview, a pointer
 * at the successor — and none of it parses as an error; `deprecat`, `retired`
 * and `testing period` are the words those notices actually use. OpenRouter
 * says "No endpoints found for <model>" once nothing serves it — but "No
 * endpoints found matching your data policy" is the strict privacy setting doing
 * its job, not a model going away, and is excluded.
 */
export const MODEL_GONE =
  /no longer available|is not found|not found for api version|does not exist|no longer supported|has been (?:retired|deprecated|shut down)|deprecat\w*|testing period|no endpoints found for /i;
const DATA_POLICY = /matching your data policy|no endpoints? (?:found )?(?:that )?(?:match|meet)\w* (?:your )?(?:data|privacy|zdr)/i;
/**
 * A key that cannot reach a model is not a model that has gone. OpenAI says
 * "The model `x` does not exist or you do not have access to it" for both, and
 * moving that account to Auto would send its conversation to a provider it never
 * chose, on the deployment's key.
 */
const NO_ACCESS = /do not have access|don't have access|not have access to|permission|not allowed to access|unauthori[sz]ed/i;

/**
 * Whether a provider's failure says the model itself has gone.
 *
 * This moves an account to Auto for good, so the words are not enough on their
 * own: "deprecated" or "does not exist" also turn up in a 400 about a parameter,
 * a tool or an image. A failure that carries a status is a model gone only as
 * 404 or 410; one without needs to be about the model or its endpoints.
 *
 * @param {unknown} error
 */
export function isModelGoneError(error) {
  const failure = /** @type {any} */ (error);
  const message = String(failure?.message || error || '');
  if (!MODEL_GONE.test(message) || DATA_POLICY.test(message) || NO_ACCESS.test(message)) return false;
  const status = Number(failure?.status) || Number(/^(\d{3})\b/.exec(message)?.[1]) || 0;
  if (status) return status === 404 || status === 410;
  return /\bmodel\b|no endpoints found for /i.test(message);
}

/** Models from the shared library, the ones that are withdrawn: OpenRouter's and OrcaRouter's. */
export const isLibraryModel = (entry) => LIBRARY_PROVIDERS.has(String(entry?.provider || String(entry?.id || '').split('/')[0]));

/**
 * Move the account to Auto and leave the notice the interface shows once.
 *
 * @param {string} userId
 * @param {string} from  the gone model's name, as the person knew it
 * @returns {Promise<object>} the stored preferences
 */
export async function moveAccountToAuto(userId, from) {
  return setPrefs(userId, {
    defaultModel: AUTO_ID,
    modelNotice: { from: String(from || '').slice(0, 120), at: new Date().toISOString() },
  });
}

/**
 * The account's preferences, with a gone model already replaced by Auto.
 *
 * Called wherever the account's choice is about to be used or shown. Never
 * throws: a database hiccup here must not stop the app opening or a turn
 * starting — the choice is simply left as it was, and the turn's own fallback
 * (`resolve`, and the retry in the agent loop) still catches a gone model.
 *
 * @template {{ defaultModel?: string }} P
 * @param {string} userId
 * @param {P} prefs
 * @returns {Promise<P & { modelNotice?: { from: string, at: string } }>}
 */
export async function settleAccountModel(userId, prefs) {
  try {
    const gone = await goneModel(prefs?.defaultModel);
    if (!gone) return prefs;
    // Only where Auto can run: it needs an OpenRouter key. Without one the
    // account is left as it is, and the turn says the model has gone and to pick
    // another (`readableFailure`) — better than a notice saying it carries on on
    // Auto, followed by "Auto needs an OpenRouter key" on every message.
    if (!(await pickAutoModel(userId))) return prefs;
    return { ...prefs, ...(await moveAccountToAuto(userId, gone.label)) };
  } catch {
    return prefs;
  }
}
