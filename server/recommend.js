import { getStore } from './store/index.js';
import { CATALOG } from './providers/catalog.js';

/** Auto's id (autoPick.js), said here too: settings.js reads this module, and autoPick reads settings. */
const AUTO_ID = 'auto';

/**
 * The models this deployment recommends (owner, 2026-11-02): one free, one
 * paid, chosen by an administrator in Settings → People, for everyone — so a
 * person who has no idea which model is best simply takes the one suggested.
 *
 * Which of the two is suggested depends on the keys the person has given:
 * a key whose account has paid for credit (OpenRouter's own word, asked when
 * the key was saved — keyIntake.js), or a key of a provider that has no free
 * models at all (Anthropic, OpenAI), gets the paid one; anyone else the free
 * one. Auto, OpenRouter's free router, counts as a free model, and is the free
 * one until an administrator picks another. A suggestion the person's keys
 * cannot run is not made.
 */

const SETTING = 'recommended_models';
export const DEFAULT_RECOMMENDED = Object.freeze({ free: AUTO_ID, paid: null });

/** The administrator's two choices, or the defaults. */
export async function getRecommended() {
  const stored = await getStore().getSetting(SETTING).catch(() => null);
  return {
    free: typeof stored?.free === 'string' && stored.free ? stored.free : DEFAULT_RECOMMENDED.free,
    paid: typeof stored?.paid === 'string' && stored.paid ? stored.paid : DEFAULT_RECOMMENDED.paid,
  };
}

/** Whether a model is free: Auto, or a library model priced at nothing. Built-ins never are. */
async function freeness(id) {
  if (id === AUTO_ID) return { known: true, free: true, label: 'Auto' };
  const builtIn = CATALOG.find((m) => m.id === id);
  if (builtIn) return { known: true, free: false, label: builtIn.label };
  const row = await getStore().getSharedModel(id).catch(() => null);
  if (!row || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) return { known: false };
  return { known: true, free: !!row.is_free, label: row.label || row.model };
}

/**
 * Set the two, checked: the free one must be free and the paid one must not
 * be — a "free" suggestion that bills somebody is the one mistake this must
 * never make. The paid one may be cleared.
 */
export async function setRecommended({ free, paid }) {
  const freeId = String(free || '').trim() || AUTO_ID;
  const paidId = String(paid || '').trim() || null;
  const f = await freeness(freeId);
  if (!f.known) throw Object.assign(new Error('That free model is not in the library.'), { status: 400 });
  if (!f.free) throw Object.assign(new Error('The free suggestion has to be a free model.'), { status: 400 });
  if (paidId) {
    const p = await freeness(paidId);
    if (!p.known) throw Object.assign(new Error('That paid model is not in the library.'), { status: 400 });
    if (p.free) throw Object.assign(new Error('The paid suggestion has to be a paid model — the free one is chosen beside it.'), { status: 400 });
  }
  const value = { free: freeId, paid: paidId };
  await getStore().setSetting(SETTING, value);
  return value;
}

/** Whether this account's keys can run a model: Auto needs OpenRouter; anything else, its own provider. */
export function runnable(id, status = {}) {
  if (!id) return false;
  if (id === AUTO_ID) return !!status.openrouter?.configured;
  return !!status[String(id).split('/')[0]]?.configured;
}

/**
 * The providers this account pays through: those with a key whose account has
 * paid for credit, and those with no free models at all (an own key of
 * Anthropic's or OpenAI's is a paying one).
 */
export function paidProviders(status = {}) {
  return new Set(
    Object.entries(status)
      .filter(([provider, s]) => s?.own && ((s.keys || []).some((k) => k.paid === true) || provider === 'anthropic' || provider === 'openai'))
      .map(([provider]) => provider),
  );
}

/** Whether this account has paid for its models anywhere. */
export const hasPaidKey = (status = {}) => paidProviders(status).size > 0;

/**
 * The model to suggest to this account, or null.
 *
 * @param {Record<string, any>} status  providerStatus(userId)
 * @returns {Promise<{ id: string, kind: 'free' | 'paid', label: string, funded: boolean } | null>}
 */
export async function suggestionFor(status, recommended = null) {
  const rec = recommended || (await getRecommended());
  const paying = paidProviders(status);
  const funded = paying.size > 0;
  let pick = null;
  // The paid one only on a provider this account pays through: an Anthropic
  // key that pays says nothing about an OpenRouter key that never has.
  if (rec.paid && paying.has(String(rec.paid).split('/')[0])) pick = { id: rec.paid, kind: 'paid' };
  else if (rec.free && runnable(rec.free, status)) pick = { id: rec.free, kind: 'free' };
  if (!pick) return null;
  const about = await freeness(pick.id);
  if (!about.known) return null;
  return { ...pick, label: about.label, funded };
}

/** The two, with their names — for the picker's marks and the administrators' page. */
export async function recommendedWithLabels() {
  const rec = await getRecommended();
  const [free, paid] = await Promise.all([rec.free ? freeness(rec.free) : null, rec.paid ? freeness(rec.paid) : null]);
  return {
    free: rec.free && free?.known ? { id: rec.free, label: free.label } : null,
    paid: rec.paid && paid?.known ? { id: rec.paid, label: paid.label } : null,
  };
}
