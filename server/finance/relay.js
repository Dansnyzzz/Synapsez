import crypto from 'node:crypto';

/*
 * Vietcap from Singapore (owner, 2026-11-11: "I want it").
 *
 * The probe of 2026-11-11 found Vietcap answering a bare 400 to US addresses and 200 from
 * Singapore and Vietnam (docs/research/2026-11-10-finance-probe-iad1.md). The app's
 * functions run in iad1; one small function runs in sin1 (`api/finance-sin1.js`,
 * vercel.json) and asks Vietcap for them. It is not a proxy anybody can use:
 *
 *   - only the deployment's own functions call it, with the secret they already share
 *     for their internal calls (CRON_SECRET), compared in constant time;
 *   - only GET, only https, only Vietcap's two API addresses, no redirects followed;
 *   - an answer of at most 4 MB, within 15 seconds, passed back with its status.
 *
 * What the relay itself refuses carries `x-finance-relay: refused`, so the finance
 * layer does not mistake it for Vietcap refusing (which stands Vietcap aside).
 */

/** Where it is on the deployment. */
export const RELAY_PATH = '/api/finance-sin1';

/** The only addresses it asks. */
const ALLOWED = Object.freeze([
  { host: 'iq.vietcap.com.vn', prefix: '/api/iq-insight-service/' },
  { host: 'trading.vietcap.com.vn', prefix: '/api/' },
]);

/** The largest answer passed back. */
export const RELAY_MAX_BYTES = 4 * 1024 * 1024;

/** Regions Vietcap answers from (Singapore measured; its Asian neighbours assumed alike). */
export const ASIA_REGION = /^(sin|hkg|hnd|kix|icn|bom)\d/i;

/** Whether the relay may ask this address. */
export function relayAllowed(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  return ALLOWED.some((a) => parsed.hostname === a.host && parsed.pathname.startsWith(a.prefix) && !parsed.pathname.includes('..'));
}

const sameSecret = (said, secret) => {
  const a = Buffer.from(String(said));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const refused = (status, error) => ({ status, headers: { 'content-type': 'application/json', 'x-finance-relay': 'refused' }, body: Buffer.from(JSON.stringify({ error })) });

/**
 * One request to the relay, answered.
 *
 * @param {{ method: string, url: unknown, authorization: unknown, ua?: unknown, secret?: string, fetchImpl?: typeof fetch }} request
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 */
export async function relayAnswer({ method, url, authorization, ua = '', secret = process.env.CRON_SECRET || '', fetchImpl = globalThis.fetch }) {
  if (method !== 'GET') return refused(405, 'GET only.');
  if (!secret || !sameSecret(authorization || '', secret)) return refused(401, 'Not for you.');
  if (!relayAllowed(url)) return refused(403, 'That address is not one this relay asks.');
  let res;
  try {
    res = await fetchImpl(String(url), {
      headers: { Accept: 'application/json', 'User-Agent': String(ua || 'Synapsez (market data on request)').slice(0, 200) },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return refused(502, `Vietcap could not be reached from here (${err?.name || 'network error'}).`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > RELAY_MAX_BYTES) return refused(502, 'Vietcap answered with more than 4 MB.');
  return { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'x-finance-relay': 'passed' }, body };
}

/**
 * Where a source's request goes from this server: through the Singapore relay for
 * Vietcap when this function runs on Vercel outside Asia and the deployment knows its
 * own address and secret; straight to the source otherwise (null).
 *
 * @param {string} source
 * @returns {{ endpoint: string, secret: string, bypass: string } | null}
 */
export function relayFor(source) {
  if (source !== 'vietcap' || !process.env.VERCEL || ASIA_REGION.test(String(process.env.VERCEL_REGION || ''))) return null;
  const secret = String(process.env.CRON_SECRET || '');
  const base = String(process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')).trim().replace(/\/+$/, '');
  if (!secret || !/^https:\/\//.test(base)) return null;
  // A preview behind Vercel's own protection lets the deployment's functions through with this.
  return { endpoint: `${base}${RELAY_PATH}`, secret, bypass: String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '') };
}
