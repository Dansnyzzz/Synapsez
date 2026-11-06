import crypto from 'node:crypto';
import { PROVIDERS } from './providers/catalog.js';
import { keyEntries, setKeyMeta, addApiKey } from './settings.js';
import { connect } from './connectors.js';

/**
 * A key or a token pasted somewhere in Settings, taken where it belongs
 * (owner, 2026-11-02).
 *
 * Every issuer gives its secrets a shape of its own — OpenRouter's begin
 * `sk-or-v1-`, Google's `AIza`, a GitHub token `ghp_` or `github_pat_` — so a
 * secret pasted in the wrong box can be recognised and saved in the right one,
 * with a word to say so, rather than failing on the first message. Then it is
 * checked with the issuer before it is kept: a key the provider refuses is
 * said to be refused now, not mid-conversation. And for OpenRouter, the one
 * rule that makes a second key worth having: one account, one key. Two keys of
 * the same account share its limits — the free models' daily allowance is the
 * account's — so a second one is no fallback at all.
 *
 * What the check learns is kept beside the key, never the key itself: a hash
 * of the account it belongs to, and whether that account has ever paid for
 * credit (OpenRouter's `is_free_tier`), which decides the model suggested.
 */

/**
 * Provider keys, by the shape each issuer gives them. The first that fits wins.
 * @type {Array<[string, RegExp]>}
 */
const PROVIDER_SHAPES = [
  ['openrouter', /^sk-or-(v\d+-)?\S{6,}$/],
  ['orcarouter', /^sk-orca-\S{6,}$/],
  ['anthropic', /^sk-ant-\S{8,}$/],
  ['google', /^AIza[0-9A-Za-z_-]{30,}$/],
  ['openai', /^sk-(proj|svcacct|admin)-\S{8,}$/],
  ['openai', /^sk-[A-Za-z0-9]{16,}T3BlbkFJ[A-Za-z0-9]{16,}$/],
];

/**
 * Connector tokens, the same way.
 * @type {Array<[string, RegExp]>}
 */
const SERVICE_SHAPES = [
  ['github', /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/],
  ['notion', /^(ntn_|secret_)[A-Za-z0-9]{20,}$/],
  ['slack', /^xox[abpe]-[A-Za-z0-9-]{10,}$/],
  ['telegram', /^\d{5,12}:[A-Za-z0-9_-]{30,}$/],
  ['supadata', /^sd_[A-Za-z0-9]{10,}$/],
  ['meta_page', /^EAA[A-Za-z0-9]{20,}$/],
];

/**
 * Providers whose keys always have their shape: a secret without it, pasted
 * there, is refused rather than saved to fail later. OpenAI is left out — an
 * OpenAI-compatible server behind OPENAI_BASE_URL takes any key. OrcaRouter's
 * docs: "Every key starts with `sk-orca-`".
 */
const STRICT = new Set(['openrouter', 'google', 'anthropic', 'orcarouter']);

/** What a pasted secret looks like it is, or null when it fits no shape known here. */
export function recognise(secret) {
  const value = String(secret || '').trim();
  for (const [id, shape] of PROVIDER_SHAPES) if (shape.test(value)) return { kind: 'provider', id };
  for (const [id, shape] of SERVICE_SHAPES) if (shape.test(value)) return { kind: 'service', id };
  return null;
}

/** Off in the test suites, which save made-up keys: KEY_CHECKS=off. */
const checksOn = () => !/^(0|false|no|off)$/i.test(String(process.env.KEY_CHECKS || '').trim());

/** An account's id, kept only as a hash: enough to tell two keys of one account, nothing more. */
const accountHash = (id) => crypto.createHash('sha256').update(String(id)).digest('base64url').slice(0, 22);

/**
 * What OrcaRouter's billing summary says about a key: the credit it can draw on,
 * as a number, or null if it did not say. Live, 2026-11-04: `hard_limit_usd` is
 * the balance left — it is not what was ever paid, which no endpoint reports.
 *
 * @param {any} body  `GET /v1/dashboard/billing/subscription`
 */
export const orcaBalance = (body) => (typeof body?.hard_limit_usd === 'number' && Number.isFinite(body.hard_limit_usd) ? body.hard_limit_usd : null);

/**
 * The workspace's wallet, and what this key may spend of it, as a number or null.
 * Live, 2026-11-07: `GET /v1/tools/balance` answered a wallet of 20 and 5.83
 * spendable, where the billing summary above says 6, a key's own ceiling. The wallet
 * is what proves a top-up; reading the ceiling as the balance left an owner with $20
 * told nobody could say how much had been paid.
 *
 * @param {any} body  `GET /v1/tools/balance`
 */
export const orcaWallet = (body) => {
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return { wallet: number(body?.data?.wallet_usd), spendable: number(body?.data?.spendable_usd) };
};

/**
 * What a balance proves. Any credit can pay for a paid model. Whether the
 * workspace has reached the free tier's upper rung is lifetime spend, unreadable,
 * except that a balance past the rung cannot have been paid for with less. No
 * credit at all reads as not paid: it could be spent, and either way a paid model
 * has nothing to draw on.
 *
 * @param {number | null} balance
 * @param {number} rung  the spend that unlocks the upper rung (`free_tier.tiers`)
 * @returns {{ paid: boolean | null, freeTier: 'high' | null }}
 */
export function orcaStanding(balance, rung = 20) {
  if (balance == null) return { paid: null, freeTier: null };
  return { paid: balance > 0, freeTier: balance >= rung ? 'high' : null };
}

/**
 * Ask the provider about a key. `ok` is true (it answers), false (it refuses
 * the key) or null (it could not be asked — a key is never refused for an
 * outage). `paid` is true when the account has paid for credit, false when it
 * never has, null when the provider does not say.
 *
 * @returns {Promise<{ ok: boolean | null, account?: string | null, paid?: boolean | null, freeTier?: 'high' | null }>}
 */
export async function inspectKey(provider, key, { fetchImpl = fetch } = {}) {
  if (!checksOn()) return { ok: null };
  const get = (url, headers) => fetchImpl(url, { headers, signal: AbortSignal.timeout(8_000) });
  try {
    if (provider === 'openrouter') {
      const res = await get('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` });
      if (res.status === 401 || res.status === 403) return { ok: false };
      if (!res.ok) return { ok: null };
      const data = (await res.json())?.data || {};
      // An organisation's keys share its credit and its limits; a person's, theirs.
      const owner = data.organization_id || data.creator_user_id || null;
      return { ok: true, account: owner ? accountHash(owner) : null, paid: typeof data.is_free_tier === 'boolean' ? !data.is_free_tier : null };
    }
    if (provider === 'orcarouter') {
      // The wallet where it can be read: a key's own ceiling proves nothing about what was paid.
      const wallet = await get('https://api.orcarouter.ai/v1/tools/balance', { Authorization: `Bearer ${key}` }).catch(() => null);
      if (wallet?.ok) {
        const { wallet: held } = orcaWallet(await wallet.clone().json().catch(() => null));
        if (held !== null) return { ok: true, ...orcaStanding(held) };
      }
      const res = await get('https://api.orcarouter.ai/v1/dashboard/billing/subscription', { Authorization: `Bearer ${key}` });
      if (res.status === 401 || res.status === 403) return { ok: false };
      if (!res.ok) return { ok: null };
      return { ok: true, ...orcaStanding(orcaBalance(await res.json())) };
    }
    if (provider === 'google') {
      const res = await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key });
      if ([400, 401, 403].includes(res.status)) return { ok: false };
      // Every Gemini key has the free tier; whether billing is on is not something a key can be asked.
      return res.ok ? { ok: true, paid: null } : { ok: null };
    }
    if (provider === 'anthropic') {
      const res = await get('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      if (res.status === 401 || res.status === 403) return { ok: false };
      // There are no free models on Anthropic's own API: a working key is a paying one.
      return res.ok ? { ok: true, paid: true } : { ok: null };
    }
    if (provider === 'openai' && !process.env.OPENAI_BASE_URL) {
      const res = await get('https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` });
      if (res.status === 401 || res.status === 403) return { ok: false };
      return res.ok ? { ok: true, paid: true } : { ok: null };
    }
  } catch {
    return { ok: null };
  }
  return { ok: null };
}

const fail = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Take a key pasted in a provider's box: recognise it, check it, keep it.
 *
 * @returns {Promise<{ kind: 'provider' | 'service', id: string, moved: boolean, from: string, account?: string | null, paid?: boolean | null }>}
 */
export async function intakeKey(userId, asked, value, { fetchImpl = fetch } = {}) {
  const secret = String(value || '').trim();
  if (!secret) throw fail('Paste a key.');
  if (!Object.hasOwn(PROVIDERS, asked)) throw fail(`No provider called "${asked}".`);
  const seen = recognise(secret);

  // A connector's token, pasted among the providers: connected where it belongs.
  if (seen?.kind === 'service') {
    const { account } = await connect(userId, seen.id, secret);
    return { kind: 'service', id: seen.id, moved: true, from: asked, account };
  }

  const provider = seen?.kind === 'provider' ? seen.id : asked;
  if (!seen && STRICT.has(asked)) {
    const label = PROVIDERS[asked].label;
    const begin = PROVIDERS[asked].keyHint.replace('…', '');
    throw fail(/^[AEIOU]/i.test(label) ? `That does not look like an ${label} key — those begin ${begin}.` : `That does not look like a ${label} key — those begin ${begin}.`);
  }

  const check = await inspectKey(provider, secret, { fetchImpl });
  if (check.ok === false) {
    throw fail(`${PROVIDERS[provider].label} refused that key. Check that it was copied whole and has not been revoked.`);
  }

  return oneAtATime(userId, async () => {
    const held = await keyEntries(userId, provider);
    if (held.some((entry) => entry.key === secret)) throw fail('That key is already on this provider.');

    // One OpenRouter account, one key — the keys kept before this rule are asked once, and remembered.
    if (provider === 'openrouter' && check.account) {
      for (const entry of held) {
        let account = entry.account;
        if (!account && entry.key) {
          const info = await inspectKey('openrouter', entry.key, { fetchImpl });
          account = info.account || null;
          if (account) await setKeyMeta(userId, 'openrouter', entry.key, { account, paid: info.paid ?? null, checkedAt: new Date().toISOString() });
        }
        if (account && account === check.account) {
          throw fail(
            `That key belongs to the same OpenRouter account as key ${entry.index + 1}. One account, one key: two keys of one account share its limits, so the second is no fallback. Add a key from another OpenRouter account.`,
          );
        }
      }
    }

    const meta = { account: check.account ?? null, paid: check.paid ?? null, freeTier: check.freeTier ?? null, checkedAt: check.ok ? new Date().toISOString() : null };
    // Added to the list as it is now, read again inside addApiKey — not set over
    // a list read before the checks above, which could be seconds old (HAR-008).
    await addApiKey(userId, provider, secret, meta);
    return { kind: 'provider', id: provider, moved: provider !== asked, from: asked, account: null, paid: check.paid ?? null };
  });
}

/**
 * One key intake at a time for an account, on this instance (HAR-008). Two
 * pasted at once both read an empty list, and the second replaced the first.
 * Per account, not per provider (HAR-014): every provider's keys are one
 * stored setting, read and written whole, so an OpenRouter key and a Google
 * key pasted together raced the same way. Two serverless instances can still
 * interleave; that needs a database-side update, and is rarer by far.
 */
const intakes = new Map();
function oneAtATime(slot, work) {
  const run = (intakes.get(slot) || Promise.resolve()).then(work, work);
  const settled = run.catch(() => {});
  intakes.set(slot, settled);
  settled.then(() => intakes.get(slot) === settled && intakes.delete(slot));
  return run;
}

/**
 * Take a token pasted in a connector's box. Another connector's token is
 * connected where it belongs; a provider's key is kept among the providers.
 *
 * @returns {Promise<{ kind: 'provider' | 'service', id: string, moved: boolean, from: string, account?: string | null }>}
 */
export async function intakeToken(userId, asked, value, { fetchImpl = fetch } = {}) {
  const secret = String(value || '').trim();
  const seen = recognise(secret);
  if (seen?.kind === 'provider') {
    const saved = await intakeKey(userId, seen.id, secret, { fetchImpl });
    return { ...saved, moved: true, from: asked };
  }
  const service = seen?.kind === 'service' ? seen.id : asked;
  const { account } = await connect(userId, service, secret);
  return { kind: 'service', id: service, moved: service !== asked, from: asked, account };
}
