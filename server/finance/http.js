import fs from 'node:fs';
import { take } from '../freeTier.js';

/**
 * The only fetch the finance layer makes (owner, 2026-11-10).
 *
 * Every source adapter in `sources/` calls through here, never `fetch` itself, so
 * the rules for asking somebody else's server for data hold in one place:
 *
 *   - **Who is asking, honestly.** `Synapsez/<version> (+https://github.com/;
 *     market data on request)` on every call. Never a browser User-Agent, never a
 *     Referer or Origin borrowed from the source's own site — a source that refuses
 *     an honest request is a "no", not a puzzle (research §2.19). Two exceptions:
 *     Yahoo keeps the `Mozilla/5.0` the app has always sent it, because that is
 *     what works today; SEC gets `SEC_USER_AGENT`, the owner's own contact, and is
 *     not asked at all without it — no contact address is ever written in code.
 *   - **Switched off by an environment variable.** `FIN_SOURCE_<NAME>=off` and the
 *     source is never called, so a broker that objects is answered without a deploy.
 *   - **Paced.** At most one call a second to each Vietnamese broker, two a second
 *     to Yahoo, five to SEC — per instance, which is what a serverless function can
 *     promise; the shared cache in front of this is what keeps the total low.
 *   - **Standing aside.** A 403 or 429 is the source saying "enough": it is left
 *     alone for 15 minutes (Yahoo), an hour (the brokers) or 10 minutes (the rest),
 *     and the chain answers from its next source meanwhile.
 *   - **Pooled ceilings.** The daily or per-minute caps in server/freeTier.js are
 *     taken before the call; one reached is a refusal, never an overrun.
 *
 * Only symbols, dates and indicator codes go out in these URLs — never a person's
 * words or account (spec §8).
 */

/** A source failed or would not be asked. `standAside` when it refused us (403/429) or still is. */
export class SourceError extends Error {
  /**
   * @param {string} source
   * @param {string} message
   * @param {{ status?: number, standAside?: boolean }} [options]
   */
  constructor(source, message, { status = 0, standAside = false } = {}) {
    super(message);
    this.name = 'SourceError';
    this.source = source;
    this.status = status;
    this.standAside = standAside;
  }
}

/** What each source is called where a person reads it — in an answer, a card, an error. */
const LABEL = {
  yahoo: 'Yahoo Finance',
  vndirect: 'VNDIRECT',
  kbs: 'KBS',
  vietcap: 'Vietcap',
  sec: 'SEC EDGAR',
  coingecko: 'CoinGecko',
  frankfurter: 'Frankfurter',
  ecb: 'ECB',
  erapi: 'ExchangeRate-API',
  vietcombank: 'Vietcombank',
  sjc: 'SJC',
  worldbank: 'World Bank',
  fred: 'FRED',
  nso: 'NSO Vietnam',
  fmarket: 'FMarket',
};

/** Every source there is. A chain entry may name a part of one ("vndirect:dchart"); the part before the colon is the source. */
export const SOURCES = Object.keys(LABEL);

const sourceOf = (name) => String(name || '').split(':')[0];
export const sourceLabel = (name) => LABEL[sourceOf(name)] || String(name);

/**
 * Sources that turn away the servers this app runs on, as measured from Vercel Sandboxes
 * on 2026-11-11 (docs/research/2026-11-10-finance-probe-iad1.md): SJC sits behind a
 * Cloudflare bot check that refuses every datacenter, in iad1 and sin1 alike, and is not
 * to be got round; Vietcap answers a bare 400 to US addresses and 200 from Singapore. On
 * such a server they are off unless `FIN_SOURCE_<NAME>=on` asks for them anyway — the
 * owner's choice, 2026-11-11. Elsewhere (a machine in Vietnam) they are on.
 */
const REFUSES_THIS_SERVER = Object.freeze({
  sjc: () => !!process.env.VERCEL,
  vietcap: () => !!process.env.VERCEL && !/^(sin|hkg|hnd|kix|icn|bom)\d/i.test(String(process.env.VERCEL_REGION || '')),
});

/** What `FIN_SOURCE_<NAME>` says: 'off', 'on', or nothing. */
function switchOf(name) {
  const said = String(process.env[`FIN_SOURCE_${name.toUpperCase()}`] || '').trim();
  if (/^(off|0|false|no|disabled)$/i.test(said)) return 'off';
  if (/^(on|1|true|yes|enabled)$/i.test(said)) return 'on';
  return '';
}

/**
 * Whether a source may be asked here: `FIN_SOURCE_<NAME>` off or on decides; without it,
 * every source is on except one that refuses this server (above).
 */
export function enabled(source) {
  const name = sourceOf(source);
  const said = switchOf(name);
  if (said) return said === 'on';
  return !REFUSES_THIS_SERVER[name]?.();
}

/** Sources whose bare 400 is a refusal of the asker, not a mistake in the request (Vietcap, outside Asia). */
const REFUSES_WITH_400 = new Set(['vietcap']);

const PACE_MS = { vndirect: 1000, kbs: 1000, vietcap: 1000, yahoo: 500, sec: 200, default: 0 };
const ASIDE_MS = { yahoo: 15 * 60_000, vndirect: 60 * 60_000, kbs: 60 * 60_000, vietcap: 60 * 60_000, default: 10 * 60_000 };
/** The pooled ceilings each source takes from before a call (server/freeTier.js). */
const TIERS = { yahoo: ['yahoo'], vndirect: ['vndirect'], kbs: ['kbs'], vietcap: ['vietcap'], sec: ['sec'], coingecko: ['coingecko_minute', 'coingecko'], fred: ['fred'] };

/*
 * Per instance, and only about the sources, never about a person: when each
 * source may next be called, and which are standing aside until when. Losing it
 * on a cold start costs at most one extra call per source.
 */
const nextSlot = new Map();
const asideUntil = new Map();

/** Tests: forget the pacing and the standing aside. */
export function __resetHttp() {
  nextSlot.clear();
  asideUntil.clear();
}

/** When a source that refused us may be asked again (ms since the epoch), or 0 when it may now. */
export function standingAside(source, now = Date.now()) {
  const until = asideUntil.get(sourceOf(source)) || 0;
  return until > now ? until : 0;
}

let version = '';
function appVersion() {
  if (!version) {
    try {
      version = String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '1');
    } catch {
      version = '1';
    }
  }
  return version;
}

/** The User-Agent a source is asked with; empty for SEC without `SEC_USER_AGENT`. */
export function userAgent(source) {
  const name = sourceOf(source);
  if (name === 'sec') return String(process.env.SEC_USER_AGENT || '').trim();
  if (name === 'yahoo') return 'Mozilla/5.0';
  return `Synapsez/${appVersion()} (+https://github.com/; market data on request)`;
}

/** Wait for this source's next free slot, and take it. Concurrent calls queue one gap apart. */
async function pace(name) {
  const raw = Number(process.env.FIN_PACE_SCALE ?? 1);
  const scale = Number.isFinite(raw) && raw >= 0 ? raw : 1;
  const gap = (PACE_MS[name] ?? PACE_MS.default) * scale;
  if (!gap) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(name) || 0);
  nextSlot.set(name, slot + gap);
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

const minutes = (ms) => Math.round(ms / 60_000);

/**
 * One call, after every rule above. Answers the Response for any status but a
 * refusal; `okOnly` (the default) makes any other non-2xx a `SourceError` too.
 *
 * @param {string} source
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal | null, accept?: string, okOnly?: boolean }} [options]
 */
export async function getResponse(source, url, { headers = {}, timeoutMs = 8000, fetchImpl, signal = null, accept = 'application/json', okOnly = true } = {}) {
  const name = sourceOf(source);
  const label = sourceLabel(name);
  if (!enabled(name)) {
    if (switchOf(name) === 'off') throw new SourceError(name, `${label} is switched off on this deployment (FIN_SOURCE_${name.toUpperCase()}=off).`);
    throw new SourceError(name, `${label} turns away servers like this one, so it is not asked here (FIN_SOURCE_${name.toUpperCase()}=on asks anyway).`);
  }
  const aside = standingAside(name);
  if (aside) throw new SourceError(name, `${label} refused a request recently, so it is left alone for about ${Math.max(1, minutes(aside - Date.now()))} more minutes.`, { standAside: true });
  const ua = userAgent(name);
  if (!ua) throw new SourceError(name, 'SEC needs SEC_USER_AGENT ("Synapsez <contact email>") set on the deployment, so SEC was not asked.');
  for (const tier of TIERS[name] || []) {
    if (!(await take(tier, 1))) throw new SourceError(name, `${label}'s shared allowance (${tier}) is used up for now, so it was not asked.`);
  }
  await pace(name);

  // The caller's headers, less anything that would say we are someone else.
  const own = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(referer|origin|user-agent)$/i.test(key)));
  const limit = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(url, {
      headers: { Accept: accept, ...own, 'User-Agent': ua },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
      redirect: 'follow',
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const timedOut = limit.aborted || err?.name === 'TimeoutError';
    throw new SourceError(name, timedOut ? `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `${label} could not be reached (${err?.cause?.code || err?.name || 'network error'}).`);
  }
  // A bare 400 with next to nothing in it, from a source known to answer refusals that way.
  const bare400 = res.status === 400 && REFUSES_WITH_400.has(name) && (await res.clone().text().catch(() => '')).trim().length <= 8;
  if (res.status === 403 || res.status === 429 || bare400) {
    const ms = ASIDE_MS[name] ?? ASIDE_MS.default;
    asideUntil.set(name, Date.now() + ms);
    throw new SourceError(name, `${label} refused the request (HTTP ${res.status}), so it is left alone for ${minutes(ms)} minutes.`, { status: res.status, standAside: true });
  }
  if (okOnly && !res.ok) throw new SourceError(name, `${label} answered HTTP ${res.status}.`, { status: res.status });
  return res;
}

/** The body as text. */
export async function getText(source, url, options = {}) {
  const res = await getResponse(source, url, { accept: 'text/plain, */*', ...options });
  return res.text();
}

/** The body as JSON; a page that is not JSON (a block page, an error page) is a `SourceError`. */
export async function getJson(source, url, options = {}) {
  const res = await getResponse(source, url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(sourceOf(source), `${sourceLabel(source)} answered something that is not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…).`, { status: res.status });
  }
}
