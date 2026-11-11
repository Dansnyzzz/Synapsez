import { getStore } from './store/index.js';
import { CATALOG } from './providers/catalog.js';
import { ROUTERS, routesOf } from './modelRoutes.js';

/** Auto's id (autoPick.js), said here too: settings.js reads this module, and autoPick reads settings. */
const AUTO_ID = 'auto';

/**
 * The models this deployment recommends (owner, 2026-11-02, and 2026-11-04): two
 * free, the first tried first, and one paid, chosen by an administrator in
 * Settings → People, for everyone — so a person who has no idea which model is
 * best simply takes the one suggested.
 *
 * Which is suggested depends on the keys the person has given: a key whose account
 * has paid for credit (asked when the key was saved — keyIntake.js), or a key of a
 * provider that has no free models at all (Anthropic, OpenAI), gets the paid one;
 * anyone else the first free one their keys can run, then the second. Auto,
 * OpenRouter's free router, counts as a free model, and is the free one until an
 * administrator picks another. A suggestion the person's keys cannot run is not made.
 *
 * Two free ones, because the best free model is not free for everybody:
 * DeepSeek V4.1 Flash on OrcaRouter costs nothing, and refuses a workspace that
 * has not paid enough (see `routeWorks`).
 *
 * One model, two routers. The same model is often offered by both OpenRouter and
 * OrcaRouter, so the suggestion goes through whichever the person holds a key for.
 * Holding both, a free model goes through OrcaRouter and a paid one through
 * OpenRouter (owner, 2026-11-04). See `pickRoute`.
 */

const SETTING = 'recommended_models';
export const DEFAULT_RECOMMENDED = Object.freeze({ free: AUTO_ID, freeSecond: null, paid: null });

/** Which router a model reached through both is suggested on. The owner's rule. */
const ROUTER_PREFERENCE = {
  free: ['orcarouter', 'openrouter'],
  paid: ['openrouter', 'orcarouter'],
};

/** The administrator's choices, or the defaults. */
export async function getRecommended() {
  const stored = await getStore().getSetting(SETTING).catch(() => null);
  const named = (value, fallback) => (typeof value === 'string' && value ? value : fallback);
  return {
    free: named(stored?.free, DEFAULT_RECOMMENDED.free),
    freeSecond: named(stored?.freeSecond, DEFAULT_RECOMMENDED.freeSecond),
    paid: named(stored?.paid, DEFAULT_RECOMMENDED.paid),
    // When the choice last changed: what everyone is told about once (suggestionNotice.js).
    version: named(stored?.version, null),
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
 * Set the three, checked: a free one must be free and the paid one must not be —
 * a "free" suggestion that bills somebody is the one mistake this must never make.
 * The second free one and the paid one may be cleared.
 */
export async function setRecommended({ free, freeSecond, paid }) {
  const freeId = String(free || '').trim() || AUTO_ID;
  const secondId = String(freeSecond || '').trim() || null;
  const paidId = String(paid || '').trim() || null;
  const f = await freeness(freeId);
  if (!f.known) throw Object.assign(new Error('That free model is not in the library.'), { status: 400 });
  if (!f.free) throw Object.assign(new Error('The free suggestion has to be a free model.'), { status: 400 });
  if (secondId) {
    const s = await freeness(secondId);
    if (!s.known) throw Object.assign(new Error('That free model is not in the library.'), { status: 400 });
    if (!s.free) throw Object.assign(new Error('The free suggestion has to be a free model.'), { status: 400 });
  }
  if (paidId) {
    const p = await freeness(paidId);
    if (!p.known) throw Object.assign(new Error('That paid model is not in the library.'), { status: 400 });
    if (p.free) throw Object.assign(new Error('The paid suggestion has to be a paid model — the free one is chosen beside it.'), { status: 400 });
  }
  // The same model twice is one suggestion: a second choice that adds nothing is none.
  const value = { free: freeId, freeSecond: secondId === freeId ? null : secondId, paid: paidId };
  // A new version only when the choice changed: saving the same three again tells nobody anything.
  const before = await getStore().getSetting(SETTING).catch(() => null);
  const same = !!before && before.free === value.free && (before.freeSecond || null) === value.freeSecond && (before.paid || null) === value.paid;
  const version = same && before.version ? before.version : new Date().toISOString();
  await getStore().setSetting(SETTING, { ...value, version });
  return { ...value, version };
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
 * Whether a free model through this router would answer this account.
 *
 * OrcaRouter's free ids refuse a workspace that has not paid enough: the free tier
 * caps how long one request may be, and every request here carries the tools, and
 * may ask for a linked GitHub account too (docs: routing/free-models). So they are
 * not suggested on a key OrcaRouter has refused on those grounds, or one with no
 * credit at all. A key about which nothing is known yet is given the benefit of the
 * doubt: a refusal is remembered on the first turn, and the suggestion moves on.
 */
function routeWorks(router, kind, status) {
  if (kind !== 'free' || router !== 'orcarouter') return true;
  const held = status.orcarouter;
  // A deployment-wide key is the deployment's to have funded.
  if (!held?.own) return !!held?.configured;
  return (held.keys || []).some((k) => k.freeTier !== 'low' && (k.freeTier === 'high' || k.paid !== false));
}

/**
 * The router to reach a suggestion through, for this account.
 *
 * Its own keys first, because a shared key is the deployment's money and limits:
 * with one router's key, that router; with both, the owner's preference. With none
 * of its own, a deployment-wide key. Only a route that is really in the library
 * counts: "both offer it" is a question about spelling until somebody has looked.
 *
 * @param {string} id  the model as chosen, on either router
 * @param {'free' | 'paid'} kind
 * @param {Record<string, any>} status  providerStatus(userId)
 * @param {Set<string>} paying  what `paidProviders` said, for a paid model
 * @param {{ showing?: boolean }} [options]  for the picker's mark: only which router
 *   this account would reach it through, not whether it is the one to take
 * @returns {Promise<string | null>} the id to suggest, or null when this account cannot run it
 */
export async function pickRoute(id, kind, status, paying, { showing = false } = {}) {
  const routes = routesOf(id);
  const allowed = (router) => (showing ? !!status[router]?.configured : (kind === 'paid' ? paying.has(router) : !!status[router]?.configured) && routeWorks(router, kind, status));
  // A first-party model, or Auto: there is one way to it.
  if (!Object.keys(routes).length) {
    if (kind === 'paid') return paying.has(String(id).split('/')[0]) ? id : null;
    return runnable(id, status) ? id : null;
  }
  const order = ROUTER_PREFERENCE[kind].filter((router) => ROUTERS.includes(router));
  const ownFirst = [...order.filter((router) => status[router]?.own), ...order.filter((router) => !status[router]?.own)];
  for (const router of ownFirst) {
    if (!routes[router] || !allowed(router)) continue;
    if (routes[router] === id) return id;
    // A model's name on the other router, only if that router really lists it.
    const about = await freeness(routes[router]);
    if (about.known && about.free === (kind === 'free')) return routes[router];
  }
  return null;
}

/**
 * The model to suggest to this account, or null.
 *
 * @param {Record<string, any>} status  providerStatus(userId)
 * @returns {Promise<{ id: string, kind: 'free' | 'paid', label: string, funded: boolean } | null>}
 */
export async function suggestionFor(status, recommended = null) {
  const rec = { freeSecond: null, ...(recommended || (await getRecommended())) };
  const paying = paidProviders(status);
  const funded = paying.size > 0;
  // The paid one only through a provider this account pays through: an Anthropic
  // key that pays says nothing about an OpenRouter key that never has.
  /** @type {{ id: string, kind: 'free' | 'paid' }[]} */
  const tries = [];
  if (rec.paid) tries.push({ id: rec.paid, kind: 'paid' });
  if (rec.free) tries.push({ id: rec.free, kind: 'free' });
  if (rec.freeSecond) tries.push({ id: rec.freeSecond, kind: 'free' });
  for (const choice of tries) {
    const id = await pickRoute(choice.id, choice.kind, status, paying);
    if (!id) continue;
    const about = await freeness(id);
    // Chosen as free when an administrator chose it; the library may know better now.
    if (about.known && about.free === (choice.kind === 'free')) return { id, kind: choice.kind, label: about.label, funded };
  }
  return null;
}

/**
 * The free model to fall back on when `currentId` has run out or stopped answering:
 * the first of the administrators' two this account's keys can run and that is not
 * the one that just failed (owner, 2026-11-06). Null when neither qualifies, and then
 * it is Auto's turn. Only ever a free one: a free model running out must not start
 * billing anybody.
 *
 * @param {Record<string, any>} status  providerStatus(userId)
 * @param {string} currentId
 * @returns {Promise<string | null>}
 */
export async function freeFallbackFor(status, currentId, recommended = null) {
  const rec = { freeSecond: null, ...(recommended || (await getRecommended())) };
  for (const id of [rec.free, rec.freeSecond]) {
    if (!id) continue;
    const route = await pickRoute(id, 'free', status, new Set());
    if (!route || route === currentId) continue;
    // Free when an administrator chose it, and prices change: looked at again here.
    const about = await freeness(route);
    if (about.known && about.free) return route;
  }
  return null;
}

/**
 * The three, with their names — for the picker's marks. Given an account's keys,
 * each is named through the router that account would reach it by, so what the
 * picker marks is what pressing it would run.
 *
 * @param {Record<string, any> | null} [status]  providerStatus(userId)
 */
export async function recommendedWithLabels(status = null) {
  const rec = await getRecommended();
  const named = async (id, kind) => {
    if (!id) return null;
    const routed = status ? (await pickRoute(id, kind, status, new Set(), { showing: true })) || id : id;
    const about = await freeness(routed);
    return about.known ? { id: routed, label: about.label } : null;
  };
  const [free, freeSecond, paid] = await Promise.all([named(rec.free, 'free'), named(rec.freeSecond, 'free'), named(rec.paid, 'paid')]);
  return { free, freeSecond, paid };
}
