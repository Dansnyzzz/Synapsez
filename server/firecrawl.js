/**
 * Firecrawl (owner, 2026-11-11: "switch Bright Data to Firecrawl, and use it to the full"),
 * on its Free plan: 1,000 credits a month for the whole deployment, no card, and a 402 at
 * zero — never a bill (docs.firecrawl.dev/billing, read 2026-11-11). What it is used for:
 *
 *   - **search** — one more engine in web_search's chain, after Exa (search.js): 2 credits
 *     for up to ten results.
 *   - **scrape** — a page that turns this server away, or draws itself with script, read
 *     through Firecrawl's browser when Exa could not (web_fetch). 1 credit a page; a PDF's
 *     pages are capped, since each one costs a credit more. (SJC's gold board was read this
 *     way in 1.24.0; measured 2026-11-12, it turns Firecrawl away too — finance/http.js.)
 *   - **map / crawl** — a site's pages listed (1 credit), or a few of them read at once
 *     (1 credit a page, ten at most): `site_pages`.
 *   - **the Developer Index** — issues, pull requests, READMEs and documentation, for
 *     code_context when Exa found nothing: 2 credits for ten.
 *   - **the Research and Government Indexes** — 43 million paper abstracts, and US law:
 *     free, a thousand calls a day: `research_index`.
 *
 * Not used, and why (2026-11-11): Interact sessions (2–7 credits a browser minute — the
 * cloud computer has a browser); Agent (5 free runs a day, then hundreds of credits a run);
 * Monitor (a credit a page a check — Automations do this); Parse (the server reads documents
 * itself); webhooks (a serverless function polls instead); OAuth and the hosted MCP server
 * (a person's own Firecrawl account — a connector for later).
 *
 * The month's credits are split as the owner chose for the provider this replaced (search
 * 60%, pages 35%, the rest 5%), each share and the whole counted in freeTier.js before a
 * call and given back when Firecrawl charged nothing. Firecrawl's own count of what is left
 * (`/v2/team/credit-usage`) is asked every ten minutes and believed when it is lower: its
 * month need not start on the 1st, as the count here does.
 *
 * Several keys (spec A, owner 2026-11-12): up to ten, the environment's first and the rest
 * added in Settings (server/keyPool.js). Each call asks the pool for the key with the most
 * of its month left; one Firecrawl refuses, says is spent or asks to wait hands over to the
 * next. Each key has its own month (its plan's credits, as Firecrawl says them), its own
 * count of what is left and its own wait; the shares are of every key's credits together.
 */
import { take, refund, spend } from './freeTier.js';
import { classify, keysFor, liveUsage, poolHas, warmPools } from './keyPool.js';
import { throughPool } from './keyCall.js';
import { log } from './util/trace.js';

export const FIRECRAWL_API = 'https://api.firecrawl.dev';

/**
 * Whether this deployment has Firecrawl at all: a key in the pool not refused — the
 * environment's at once, the stored ones once this instance has read them (`warmPools`).
 */
export const firecrawlReady = () => poolHas('firecrawl');

/**
 * A Firecrawl refusal, with what the caller needs to decide: its status, and how long to
 * leave it — and what keyPool.js reads of it: Firecrawl's code and body. `local`: said by this
 * server about a key before asking Firecrawl (a wait it was told, a count too short).
 */
export class FirecrawlError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0, code = null, body = null, local = false } = {}) {
    super(message);
    this.name = 'FirecrawlError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
    this.body = body;
    this.local = local;
  }
}

/** Standing aside — not a failure: no credits left for this, or Firecrawl asked to be left alone. */
const standAside = (why) => Object.assign(new Error(`firecrawl: ${why}`), { skip: true });

/*
 * Per instance and per key id: until when Firecrawl asked that key to be left alone (a 429's
 * Retry-After, on any call — a crawl's progress too, which the pool does not see), and when
 * it was last asked what is left of that key's month — the figure itself is the pool's
 * (keyPool.js `liveUsage`), lowered by every call counted here. Losing either on a cold
 * start costs one call.
 */
const asideUntil = /** @type {Map<string, number>} */ (new Map());
const remaining = /** @type {Map<string, number>} */ (new Map());
const REMAINING_MS = 10 * 60_000;
/** Kept back from Firecrawl's own count, so two instances spending at once never meet zero. */
const MARGIN = 5;

/** Testing seam: forget what this instance knows. */
export function resetFirecrawlState() {
  asideUntil.clear();
  remaining.clear();
}

/** The key's words taken out of what Firecrawl said, should it repeat them. */
const withoutKey = (text, key) => (key && key.length >= 4 ? String(text).split(key).join(`…${key.slice(-4)}`) : String(text));

/**
 * One request to Firecrawl's API with one key, its refusals turned into a `FirecrawlError`.
 * @param {string} path
 * @param {{ key: string, keyId: string, method?: string, body?: any, query?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal }} options
 */
async function call(path, { key, keyId, method = 'POST', body, query, timeoutMs = 60_000, signal }) {
  const url = new URL(path, FIRECRAWL_API);
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(one));
  }
  const limit = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error page, said below */
  }
  if (res.ok && json?.success !== false) return json ?? {};
  const said = withoutKey(String(json?.error || json?.message || text || res.statusText).replace(/\s+/g, ' ').slice(0, 200), key);
  const retryAfterMs = Math.max(0, Number(res.headers.get('retry-after')) || 0) * 1000;
  // A 402, out of credits, is believed for the rest of the key's period on the way back (keyCall.js).
  if (res.status === 429) asideUntil.set(keyId, Date.now() + Math.min(Math.max(retryAfterMs, 30_000), 10 * 60_000));
  throw new FirecrawlError(`Firecrawl answered HTTP ${res.status}: ${said}`, { status: res.status, retryAfterMs, code: json?.code ?? null, body: json });
}

/**
 * What Firecrawl says is left of one key's month — asked again when ten minutes have passed
 * since (`fresh`: now), and lowered meanwhile by what is counted here (keyPool.js). `left`
 * null when it cannot say, or said it of a period that has ended: then the count in
 * freeTier.js alone decides.
 *
 * @param {import('./keyPool.js').PoolKey} key
 * @param {{ fresh?: boolean }} [options]
 */
async function figureOf(key, { fresh = false } = {}) {
  const due = fresh || Date.now() - (remaining.get(key.id) || 0) >= REMAINING_MS;
  if (due) remaining.set(key.id, Date.now());
  // Never throws: a failure is said in the log there, and what was known is kept.
  const live = due ? await liveUsage('firecrawl', key, { fresh: true }) : key.live;
  const current = live && live.used != null && live.limit != null && !(live.resets && Date.parse(live.resets) <= Date.now());
  return {
    left: current ? Math.max(0, Number(live.limit) - Number(live.used)) : null,
    plan: current ? Number(live.limit) : null,
    periodEnd: current ? live.resets || null : null,
  };
}

/** The keys Firecrawl's figures are read for: every one not refused. */
const figuredKeys = async () => (await keysFor('firecrawl')).filter((key) => key.key && key.state !== 'invalid');

/**
 * What Firecrawl says is left, over every key, each asked at most every ten minutes per
 * instance. Null when it cannot say for any — then the count in freeTier.js alone decides.
 */
export async function remainingCredits({ fresh = false } = {}) {
  await warmPools();
  if (!firecrawlReady()) return null;
  const said = (await Promise.all((await figuredKeys()).map((key) => figureOf(key, { fresh })))).filter((f) => f.left !== null);
  return said.length ? said.reduce((sum, f) => sum + Number(f.left), 0) : null;
}

/**
 * Firecrawl's own figures, for the administrators' view (freeTier.js): summed over the keys
 * it said them for — what is left, the plans' credits, the soonest a period ends, how many keys.
 *
 * @returns {Promise<{ remaining: number|null, plan: number|null, periodEnd: string|null, keys: number } | null>}
 */
export async function firecrawlAccount() {
  await warmPools();
  if (!firecrawlReady()) return null;
  const said = (await Promise.all((await figuredKeys()).map((key) => figureOf(key)))).filter((f) => f.left !== null);
  if (!said.length) return { remaining: null, plan: null, periodEnd: null, keys: 0 };
  const ends = said.map((f) => f.periodEnd).filter(Boolean).sort();
  return {
    remaining: said.reduce((sum, f) => sum + Number(f.left), 0),
    plan: said.reduce((sum, f) => sum + Number(f.plan), 0),
    periodEnd: ends[0] || null,
    keys: said.length,
  };
}

/**
 * Hold `n` credits of one share and of the month of the key that will make the call. Null
 * when either has no room — the share is every key's together, so no other key would do.
 * A key Firecrawl asked to wait, or whose own count is short of this, is refused here as it
 * would be there (`local`), so the next key is tried. `settle(used)` afterwards gives back
 * what the call did not use, or counts what it used past the hold; settling twice does nothing.
 *
 * @param {string} share
 * @param {number} n
 * @param {{ id: string, paid: boolean }} meta the key, from the pool
 */
async function hold(share, n, meta) {
  const now = Date.now();
  const until = asideUntil.get(meta.id) || 0;
  if (until > now) throw new FirecrawlError('Firecrawl asked this key to wait a while', { status: 429, retryAfterMs: until - now, local: true });
  const key = (await keysFor('firecrawl')).find((one) => one.id === meta.id);
  const { left } = key ? await figureOf(key) : { left: null };
  if (left !== null && left < n + MARGIN) {
    // Set aside until Firecrawl is asked again, as a wait is: its own count says this key is all but spent.
    throw new FirecrawlError(`Firecrawl says this key has ${left} credits left`, { status: 429, retryAfterMs: REMAINING_MS, local: true });
  }
  const counted = { keyId: meta.id, paid: meta.paid };
  if (!(await take(share, n, undefined, counted))) return null;
  if (!(await take('firecrawl', n, undefined, counted))) {
    await refund(share, n, undefined, counted);
    return null;
  }
  let settled = false;
  return {
    /** @param {number} used */
    async settle(used) {
      if (settled) return;
      settled = true;
      const spent = Math.max(0, Math.ceil(Number(used) || 0));
      if (spent < n) {
        await refund(share, n - spent, undefined, counted);
        await refund('firecrawl', n - spent, undefined, counted);
      } else if (spent > n) {
        await spend(share, spent - n, undefined, counted);
        await spend('firecrawl', spent - n, undefined, counted);
      }
    },
  };
}

/** @typedef {{ settle: (used: number) => Promise<void> }} Held what `hold` gives back, for a call to settle */

/**
 * One call that spends credits, through Firecrawl's keys (keyPool.js): the key with the most
 * of its month left, its credits held first (`hold`), the next key when one is refused, spent
 * or asked to wait. `work(key, meta, held)` makes the call with that key and settles. Null when
 * no key has room or the share is used — the caller stands aside; the last refusal, thrown,
 * when every key was refused.
 *
 * @template T
 * @param {string} share
 * @param {number} n
 * @param {(key: string, meta: { id: string, paid: boolean }, held: Held) => Promise<T>} work
 * @param {{ paid?: boolean }} [options]
 * @returns {Promise<T|null>}
 */
async function withCredits(share, n, work, { paid = false } = {}) {
  await warmPools();
  if (!firecrawlReady()) return null;
  try {
    return await throughPool(
      'firecrawl',
      n,
      async (key, meta) => {
        const held = await hold(share, n, meta);
        if (!held) throw standAside('no room in this share');
        return work(key, meta, held);
      },
      { paid },
    );
  } catch (err) {
    if (err?.skip) return null;
    throw err;
  }
}

/** Firecrawl charged nothing for a refusal it answered; a call that timed out may have been charged. */
const chargedNothing = (err) => err instanceof FirecrawlError && err.status > 0 && err.status !== 408;

/* ── search ─────────────────────────────────────────────────────────── */

/** Firecrawl's `tbs` for the same spans every engine is held to (search.js). */
const TBS = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

/**
 * One search: up to ten results for 2 credits. The kinds of page search.js knows map to
 * Firecrawl's own where it has one — news is its news source; research papers and PDFs its
 * categories; GitHub its domain (its `github` category is gone, a 400 since 2026-11-03).
 *
 * `paid`: charged, so the owner's paid key may answer once every free key is full (keyPool.js),
 * as for every call here — false until spec B charges people.
 *
 * @param {string} query
 * @param {{ count?: number, recency?: string|null, sites?: string[], category?: string|null, country?: string|null, timeoutMs?: number, signal?: AbortSignal, paid?: boolean }} [options]
 */
export async function firecrawlSearch(query, { count = 10, recency = null, sites = [], category = null, country = null, timeoutMs = 30_000, signal, paid = false } = {}) {
  const news = category === 'news';
  const domains = sites.length ? sites : category === 'github' ? ['github.com'] : [];
  const categories = category === 'research paper' ? ['research'] : category === 'pdf' ? ['pdf'] : [];
  const json = await withCredits(
    'firecrawl_search',
    2,
    async (key, { id }, held) => {
      let answer;
      try {
        answer = await call('/v2/search', {
          key,
          keyId: id,
          body: {
            query: String(query).slice(0, 500),
            limit: Math.min(Math.max(Number(count) || 10, 1), 10),
            sources: [{ type: news ? 'news' : 'web' }],
            ...(categories.length && !news ? { categories } : {}),
            ...(domains.length ? { includeDomains: domains } : {}),
            ...(TBS[recency] ? { tbs: TBS[recency] } : {}),
            ...(/^[A-Z]{2}$/.test(String(country)) ? { country } : {}),
            timeout: Math.max(5_000, timeoutMs - 2_000),
          },
          timeoutMs,
          signal,
        });
      } catch (err) {
        await held.settle(chargedNothing(err) ? 0 : 2);
        throw err;
      }
      await held.settle(Number.isFinite(Number(answer.creditsUsed)) ? Number(answer.creditsUsed) : 2);
      return answer;
    },
    { paid },
  );
  if (!json) throw standAside('the free allowance for searches is used for now');
  const rows = (news ? json.data?.news : json.data?.web) || [];
  return rows
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.title || r.url),
      url: String(r.url),
      snippet: String(r.description || r.snippet || ''),
      published: r.date || null,
    }));
}

/* ── scrape ─────────────────────────────────────────────────────────── */

/** A PDF read through Firecrawl stops here: each page past the first is a credit more. */
const PDF_PAGES = 5;

/**
 * One page through Firecrawl's browser, as markdown. Null when there is no room for it this
 * month — the caller says what went wrong.
 * Firecrawl charges a credit when it returns a document, whatever the page's own status;
 * nothing when it returns none.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, signal?: AbortSignal, paid?: boolean }} [options]
 * @returns {Promise<{ text: string, status: number|null, title: string|null, url: string, pages: number|null } | null>}
 */
export async function firecrawlScrape(url, { timeoutMs = 45_000, signal, paid = false } = {}) {
  const json = await withCredits(
    'firecrawl_scrape',
    1,
    async (key, { id }, held) => {
      let answer;
      try {
        answer = await call('/v2/scrape', {
          key,
          keyId: id,
          body: {
            url,
            formats: ['markdown'],
            onlyMainContent: true,
            proxy: 'auto',
            blockAds: true,
            removeBase64Images: true,
            parsers: [{ type: 'pdf', mode: 'fast', maxPages: PDF_PAGES }],
            timeout: Math.max(5_000, timeoutMs - 3_000),
          },
          timeoutMs,
          signal,
        });
      } catch (err) {
        await held.settle(chargedNothing(err) ? 0 : 1);
        throw err;
      }
      const meta = answer.data?.metadata || {};
      const pages = Number(meta.numPages) || null;
      const used = Number(meta.creditsUsed);
      await held.settle(Number.isFinite(used) ? used : 1 + (pages ? Math.min(pages, PDF_PAGES) : 0));
      return answer;
    },
    { paid },
  );
  if (!json) return null;
  const data = json.data || {};
  const meta = data.metadata || {};
  const pages = Number(meta.numPages) || null;
  return {
    text: String(data.markdown || ''),
    status: Number(meta.statusCode) || null,
    title: meta.title ? String(meta.title) : null,
    url: String(meta.url || meta.sourceURL || url),
    pages: Number(meta.totalPages) || pages,
  };
}

/* ── a site's pages ─────────────────────────────────────────────────── */

/**
 * A site's addresses, ranked by `search` when given: 1 credit.
 * @param {string} url
 * @param {{ search?: string, limit?: number, signal?: AbortSignal, paid?: boolean }} [options]
 */
export async function firecrawlMap(url, { search = '', limit = 100, signal, paid = false } = {}) {
  const json = await withCredits(
    'firecrawl_more',
    1,
    async (key, { id }, held) => {
      let answer;
      try {
        answer = await call('/v2/map', {
          key,
          keyId: id,
          body: { url, ...(search ? { search: String(search).slice(0, 200) } : {}), limit: Math.min(Math.max(Number(limit) || 100, 1), 500), sitemap: 'include', includeSubdomains: false },
          timeoutMs: 45_000,
          signal,
        });
      } catch (err) {
        await held.settle(chargedNothing(err) ? 0 : 1);
        throw err;
      }
      await held.settle(1);
      return answer;
    },
    { paid },
  );
  if (!json) throw standAside('the free allowance for site maps and crawls is used for now');
  return (json.links || []).map((l) => (typeof l === 'string' ? { url: l } : { url: String(l.url || ''), title: l.title || null, description: l.description || null })).filter((l) => l.url);
}

/** At most this many pages of one site are read at once. */
export const CRAWL_PAGES = 10;

/**
 * A few pages of one site, read as markdown: started, then asked after every few seconds
 * until done or until `deadline` (the run's own) is near — then stopped, so nothing more is
 * spent, and what was read so far is returned. A credit a page.
 *
 * @param {string} url
 * @param {{ limit?: number, includePaths?: string[], deadline?: number, signal?: AbortSignal, paid?: boolean }} [options]
 */
export async function firecrawlCrawl(url, { limit = 5, includePaths = [], deadline = Infinity, signal, paid = false } = {}) {
  const pages = Math.min(Math.max(Number(limit) || 5, 1), CRAWL_PAGES);
  // The crawl is the key's that started it: its progress is asked, and it is stopped, with the same key.
  const done = await withCredits(
    'firecrawl_more',
    pages,
    async (key, { id: keyId }, held) => {
      let started;
      try {
        started = await call('/v2/crawl', {
          key,
          keyId,
          body: {
            url,
            limit: pages,
            maxDiscoveryDepth: 2,
            sitemap: 'include',
            ...(includePaths.length ? { includePaths: includePaths.slice(0, 10).map((p) => String(p).slice(0, 200)) } : {}),
            // No PDF parsing: a crawl that met a long PDF would spend a credit a page of it.
            scrapeOptions: { formats: ['markdown'], onlyMainContent: true, blockAds: true, removeBase64Images: true, parsers: [] },
          },
          timeoutMs: 30_000,
          signal,
        });
      } catch (err) {
        const charged = !chargedNothing(err);
        await held.settle(charged ? pages : 0);
        // A start that timed out may have begun a crawl: not started again with the next key, a second crawl paid twice.
        if (charged && classify('firecrawl', err) === 'transient') throw new FirecrawlError(String(err?.message || err));
        throw err;
      }
      const id = String(started.id || '');
      const stopAt = Math.min(deadline - 25_000, Date.now() + 120_000);
      let status = null;
      let finished = false;
      while (id) {
        if (signal?.aborted) break;
        try {
          status = await call(`/v2/crawl/${encodeURIComponent(id)}`, { key, keyId, method: 'GET', timeoutMs: 15_000, signal });
        } catch (err) {
          if (signal?.aborted) break;
          log.warn('firecrawl: crawl status unreadable', { error: String(err?.message || err).slice(0, 160) });
        }
        finished = ['completed', 'failed', 'cancelled'].includes(String(status?.status));
        if (finished || Date.now() + 4_000 > stopAt) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      // Out of time: stopped, so the pages it has not reached are never charged.
      if (id && !finished) await call(`/v2/crawl/${encodeURIComponent(id)}`, { key, keyId, method: 'DELETE', timeoutMs: 10_000 }).catch(() => {});
      const used = Number(status?.creditsUsed);
      await held.settle(Number.isFinite(used) ? used : pages);
      return { status, finished };
    },
    { paid },
  );
  if (!done) throw standAside('the free allowance for site maps and crawls is used for now');
  const { status, finished } = done;
  const read = (status?.data || [])
    .map((p) => ({ url: String(p?.metadata?.sourceURL || p?.metadata?.url || ''), title: p?.metadata?.title || null, status: Number(p?.metadata?.statusCode) || null, text: String(p?.markdown || '') }))
    .filter((p) => p.url);
  return { pages: read, finished, status: String(status?.status || 'unknown') };
}

/* ── the indexes ────────────────────────────────────────────────────── */

/**
 * Code and its discussion — issues, merged pull requests, READMEs and documentation sites:
 * 2 credits for up to ten. Empty when there is no room for it.
 * @param {string} query
 * @param {{ k?: number, signal?: AbortSignal, paid?: boolean }} [options]
 */
export async function developerSearch(query, { k = 5, signal, paid = false } = {}) {
  const json = await withCredits(
    'firecrawl_more',
    2,
    async (key, { id }, held) => {
      let answer;
      try {
        answer = await call('/v2/search/developer', { key, keyId: id, method: 'GET', query: { query: String(query).slice(0, 300), k: Math.min(Math.max(Number(k) || 5, 1), 10), passages: 2 }, timeoutMs: 20_000, signal });
      } catch (err) {
        await held.settle(chargedNothing(err) ? 0 : 2);
        throw err;
      }
      await held.settle(2);
      return answer;
    },
    { paid },
  );
  if (!json) return [];
  return (json.results || [])
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.title || r.url),
      url: String(r.url),
      kind: String(r.id || '').split(':')[0] || null,
      text: (r.passages || []).map((p) => String(p?.text || '')).filter(Boolean).join('\n…\n'),
    }));
}

/**
 * The free indexes: a call counted against the day of the key that makes it (`firecrawl_index`,
 * a thousand a day per key), never against credits — through the pool like every call here.
 * Never charged, so never on the paid key for being charged.
 * @param {string} path @param {Record<string, any>} query @param {{ signal?: AbortSignal }} [options]
 */
async function free(path, query, { signal } = {}) {
  await warmPools();
  if (!firecrawlReady()) throw standAside('not set up on this deployment');
  try {
    return await throughPool('firecrawl_index', 1, async (key, meta) => {
      const until = asideUntil.get(meta.id) || 0;
      if (until > Date.now()) throw new FirecrawlError('Firecrawl asked this key to wait a while', { status: 429, retryAfterMs: until - Date.now(), local: true });
      if (!(await take('firecrawl_index', 1, undefined, { keyId: meta.id, paid: meta.paid }))) throw standAside("today's free index searches are used");
      return call(path, { key, keyId: meta.id, method: 'GET', query, timeoutMs: 20_000, signal });
    });
  } catch (err) {
    // Every key's day used, or each asked to wait: said as before.
    if (err?.skip && !/^firecrawl: /.test(String(err.message))) throw standAside("today's free index searches are used, or Firecrawl asked to be left alone for a while");
    throw err;
  }
}

const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : undefined);

/**
 * Papers whose abstracts match: id, title, abstract, authors, dates.
 * @param {string} query
 * @param {{ k?: number, from?: string, to?: string, sort?: string, signal?: AbortSignal }} [options]
 */
export async function researchPapers(query, { k = 10, from, to, sort, signal } = {}) {
  const json = await free('/v2/search/research/papers', { query: String(query).slice(0, 300), k: Math.min(Math.max(Number(k) || 10, 1), 25), from: day(from), to: day(to), sort: sort === 'date_desc' ? 'date_desc' : undefined }, { signal });
  return json.results || [];
}

/**
 * One paper's metadata — and, with a question, the passages of it that answer.
 * @param {string} id
 * @param {{ query?: string, k?: number, signal?: AbortSignal }} [options]
 */
export async function readPaper(id, { query = '', k = 4, signal } = {}) {
  const ask = String(query || '').trim().slice(0, 300);
  const json = await free(`/v2/search/research/papers/${encodeURIComponent(String(id))}`, ask ? { query: ask, k: Math.min(Math.max(Number(k) || 4, 1), 10) } : {}, { signal });
  return { paper: json.paper || null, passages: json.passages || [] };
}

/**
 * Papers like this one, citing it, or cited by it.
 * @param {string} id
 * @param {{ intent?: string, mode?: string, k?: number, signal?: AbortSignal }} [options]
 */
export async function relatedPapers(id, { intent, mode = 'similar', k = 10, signal } = {}) {
  const json = await free(
    `/v2/search/research/papers/${encodeURIComponent(String(id))}/similar`,
    { intent: String(intent || 'related work').slice(0, 300), mode: ['similar', 'citers', 'references'].includes(mode) ? mode : 'similar', k: Math.min(Math.max(Number(k) || 10, 1), 25) },
    { signal },
  );
  return json.results || [];
}

/**
 * US federal and state law: statutes, regulations, codes, court opinions.
 * @param {string} query
 * @param {{ k?: number, jurisdiction?: string, signal?: AbortSignal }} [options]
 */
export async function lawSearch(query, { k = 10, jurisdiction, signal } = {}) {
  const where = /^us(-[a-z]{2})?$/.test(String(jurisdiction || '')) ? String(jurisdiction) : undefined;
  const json = await free('/v2/search/gov', { query: String(query).slice(0, 300), k: Math.min(Math.max(Number(k) || 10, 1), 25), jurisdiction: where }, { signal });
  return json.data?.web || [];
}
