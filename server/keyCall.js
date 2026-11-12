import { withKey, classify } from './keyPool.js';
import { take, spend, refund, exhaust } from './freeTier.js';

/**
 * A call to a pooled service, made with its keys (spec A, owner 2026-11-12): what search.js,
 * firecrawl.js and code_context share on top of keyPool.js `withKey`.
 *
 *   - A key refused, spent or rate limited hands over to the next (keyPool.js `classify`).
 *   - A key its service says is spent is counted spent for its period too (freeTier.js
 *     `exhaust`), as a spent allowance always was, so every instance passes it over.
 *   - Every key refused, the last refusal is what the caller sees: "Exa returned HTTP 402:
 *     no more credits" is worth reporting, where a service with no key that has room only
 *     stands aside (`skip`). A refusal this server said itself, before asking (`local`: a
 *     key it was told to leave alone, or whose provider's count is too short), stands aside
 *     like one.
 */

/** A key refusing — refused, spent or asked to wait — rather than the service failing, or the request. */
const refusing = (kind) => kind === 'invalid' || kind === 'exhausted' || kind === 'cooling';

/**
 * Whether an error is a key's refusal, which the next key may not meet — not a service failing
 * for everyone, nor a request no key would make good.
 *
 * @param {string} service
 * @param {any} err
 */
export const refusesKey = (service, err) => refusing(classify(service, err));

/**
 * Run `run(key, { id, paid })` with a key of `service` that has room for `need`, moving to
 * the next on a refusal (keyPool.js `withKey`). The charged-call contract is `withKey`'s:
 * with `meta.paid`, hold first (`chargeTo`).
 *
 * @template T
 * @param {string} service a pooled service, or a window of one (Firecrawl's index)
 * @param {number} need
 * @param {(key: string, meta: { id: string, paid: boolean }) => Promise<T>} run
 * @param {{ paid?: boolean }} [options]
 * @returns {Promise<T>}
 */
export async function throughPool(service, need, run, { paid = false } = {}) {
  /** @type {any} */
  let refused = null;
  try {
    return await withKey(
      service,
      need,
      async (key, meta) => {
        try {
          return await run(key, meta);
        } catch (err) {
          if (refusesKey(service, err) && !err?.local) {
            if (classify(service, err) === 'exhausted') await exhaust(service, undefined, { keyId: meta.id });
            refused = err;
          }
          throw err;
        }
      },
      { paid },
    );
  } catch (err) {
    throw err?.skip && refused ? refused : err;
  }
}

/**
 * What one call costs, counted against the key that made it. On the owner's paid key
 * (`meta.paid`) it is held before the call — the hold is what keeps that key under its
 * monthly cap (keyPool.js `withKey`) — and the call is not made when the hold says no;
 * otherwise it is counted once it is known, as before. `settle(used)` counts what was used
 * past the hold and gives back what the hold did not use; a second settle does nothing.
 *
 * @param {string} service
 * @param {number} need
 * @param {{ id: string, paid: boolean }} meta
 */
export async function chargeTo(service, need, { id, paid }) {
  const counted = { keyId: id, paid };
  const held = paid ? Math.max(0, Math.ceil(Number(need) || 0)) : 0;
  if (held && !(await take(service, held, undefined, counted))) {
    throw Object.assign(new Error(`${service}: the paid key's cap for this month is reached`), { skip: true });
  }
  let settled = false;
  return {
    /** @param {number} used */
    async settle(used) {
      if (settled) return;
      settled = true;
      const n = Math.max(0, Math.ceil(Number(used) || 0));
      if (n > held) await spend(service, n - held, undefined, counted);
      else if (n < held) await refund(service, held - n, undefined, counted);
    },
  };
}

/** One line, `limit` characters at most. */
const clip = (text, limit) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};

/**
 * Why a provider refused, in its own words — "HTTP 422" is not a reason anybody can act on;
 * "the provided subscription token is invalid" names the key to replace — with what
 * keyPool.js `classify` reads: the status, the provider's own code (Exa's `tag`, Brave's
 * `error.code`), its body, and how long it asked to be left alone. The key that made the
 * call, should the provider repeat it, is taken out of the words: they reach the model.
 *
 * @param {string} label the provider, as the reply names it
 * @param {Response} res
 * @param {string} [key] the key the call was made with
 */
export async function refusal(label, res, key = '') {
  let detail = '';
  /** @type {any} */
  let json = null;
  try {
    const text = await res.text();
    json = JSON.parse(text);
    detail = json?.error?.detail || json?.error?.message || json?.error || json?.message || text;
  } catch {
    /* not JSON, or already consumed — the status still says something */
  }
  let said = detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '';
  // The key out first, then cut: cut first, a key across the cut would keep its first characters.
  if (key && key.length >= 4) said = said.split(key).join(`…${key.slice(-4)}`);
  said = clip(said, 200);
  return Object.assign(new Error(`${label} returned HTTP ${res.status}${said ? `: ${said}` : ''}`), {
    status: res.status,
    code: json?.tag ?? json?.error?.code ?? json?.code ?? null,
    body: json,
    retryAfter: res.headers.get('retry-after'),
  });
}
