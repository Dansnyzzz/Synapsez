/**
 * Firecrawl (owner, 2026-11-11: "switch Bright Data to Firecrawl, and use it to the full"),
 * on its Free plan: 1,000 credits a month for the whole deployment, no card, and a 402 at
 * zero — never a bill (docs.firecrawl.dev/billing, read 2026-11-11). What it is used for:
 *
 *   - **search** — one more engine in web_search's chain, after Exa (search.js): 2 credits
 *     for up to ten results.
 *   - **scrape** — a page that turns this server away, or draws itself with script, read
 *     through Firecrawl's browser when Exa could not (web_fetch); and SJC's gold board,
 *     which refuses every datacenter (finance/http.js). 1 credit a page; a PDF's pages are
 *     capped, since each one costs a credit more.
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
 */
import { take, refund, spend, exhaust } from './freeTier.js';
import { log } from './util/trace.js';

export const FIRECRAWL_API = 'https://api.firecrawl.dev';

export const firecrawlKey = () => String(process.env.FIRECRAWL_API_KEY || '').trim();
/** Whether this deployment has Firecrawl at all. */
export const firecrawlReady = () => firecrawlKey().length > 0;

/** A Firecrawl refusal, with what the caller needs to decide: its status, and how long to leave it. */
export class FirecrawlError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'FirecrawlError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Standing aside — not a failure: no credits left for this, or Firecrawl asked to be left alone. */
const standAside = (why) => Object.assign(new Error(`firecrawl: ${why}`), { skip: true });

/*
 * Per instance: until when Firecrawl asked to be left alone (a 429's Retry-After), and what
 * it last said was left of the month. Losing either on a cold start costs one call.
 */
let asideUntil = 0;
let remaining = { left: null, plan: null, periodEnd: null, at: 0 };
const REMAINING_MS = 10 * 60_000;
/** Kept back from Firecrawl's own count, so two instances spending at once never meet zero. */
const MARGIN = 5;

/** Testing seam: forget what this instance knows. */
export function resetFirecrawlState() {
  asideUntil = 0;
  remaining = { left: null, plan: null, periodEnd: null, at: 0 };
}

/**
 * One request to Firecrawl's API, its refusals turned into a `FirecrawlError`.
 * @param {string} path
 * @param {{ method?: string, body?: any, query?: Record<string, any>, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
async function call(path, { method = 'POST', body, query, timeoutMs = 60_000, signal } = {}) {
  const url = new URL(path, FIRECRAWL_API);
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(one));
  }
  const limit = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${firecrawlKey()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
  const said = String(json?.error || json?.message || text || res.statusText).replace(/\s+/g, ' ').slice(0, 200);
  const retryAfterMs = Math.max(0, Number(res.headers.get('retry-after')) || 0) * 1000;
  // Out of credits: believed for the rest of the period, as Exa's 402 is (search.js).
  if (res.status === 402) await exhaust('firecrawl');
  if (res.status === 429) asideUntil = Date.now() + Math.min(Math.max(retryAfterMs, 30_000), 10 * 60_000);
  throw new FirecrawlError(`Firecrawl answered HTTP ${res.status}: ${said}`, { status: res.status, retryAfterMs });
}

/**
 * What Firecrawl says is left of the month, asked at most every ten minutes per instance.
 * Null when it cannot say — then the count in freeTier.js alone decides.
 */
export async function remainingCredits({ fresh = false } = {}) {
  if (!firecrawlReady()) return null;
  if (!fresh && remaining.at && Date.now() - remaining.at < REMAINING_MS) return remaining.left;
  try {
    const json = await call('/v2/team/credit-usage', { method: 'GET', timeoutMs: 8_000 });
    const left = Number(json?.data?.remainingCredits);
    remaining = {
      left: Number.isFinite(left) ? left : null,
      plan: Number.isFinite(Number(json?.data?.planCredits)) ? Number(json.data.planCredits) : null,
      periodEnd: json?.data?.billingPeriodEnd || null,
      at: Date.now(),
    };
  } catch (err) {
    remaining = { ...remaining, at: Date.now() };
    log.warn('firecrawl: credit usage unreadable', { error: String(err?.message || err).slice(0, 160) });
  }
  return remaining.left;
}

/** Firecrawl's own figures, for the administrators' view (freeTier.js). */
export async function firecrawlAccount() {
  if (!firecrawlReady()) return null;
  await remainingCredits();
  return { remaining: remaining.left, plan: remaining.plan, periodEnd: remaining.periodEnd };
}

/**
 * Hold `n` credits of one share and of the whole month, before a call. Null when either
 * has no room, Firecrawl's own count says there is not enough, or it asked to be left alone.
 * `settle(used)` afterwards gives back what the call did not use, or counts what it used past
 * the hold; settling twice does nothing.
 */
async function hold(share, n) {
  if (!firecrawlReady()) return null;
  if (asideUntil > Date.now()) return null;
  const left = await remainingCredits();
  if (left !== null && left < n + MARGIN) return null;
  if (!(await take(share, n))) return null;
  if (!(await take('firecrawl', n))) {
    await refund(share, n);
    return null;
  }
  let settled = false;
  return {
    async settle(used) {
      if (settled) return;
      settled = true;
      const spent = Math.max(0, Math.ceil(Number(used) || 0));
      if (spent < n) {
        await refund(share, n - spent);
        await refund('firecrawl', n - spent);
      } else if (spent > n) {
        await spend(share, spent - n);
        await spend('firecrawl', spent - n);
      }
      if (remaining.left !== null) remaining.left = Math.max(0, remaining.left - spent);
    },
  };
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
 * @param {string} query
 * @param {{ count?: number, recency?: string|null, sites?: string[], category?: string|null, country?: string|null, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function firecrawlSearch(query, { count = 10, recency = null, sites = [], category = null, country = null, timeoutMs = 30_000, signal } = {}) {
  const held = await hold('firecrawl_search', 2);
  if (!held) throw standAside('the free allowance for searches is used for now');
  const news = category === 'news';
  const domains = sites.length ? sites : category === 'github' ? ['github.com'] : [];
  const categories = category === 'research paper' ? ['research'] : category === 'pdf' ? ['pdf'] : [];
  let json;
  try {
    json = await call('/v2/search', {
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
  await held.settle(Number.isFinite(Number(json.creditsUsed)) ? Number(json.creditsUsed) : 2);
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
 * One page through Firecrawl's browser, as markdown (or as it came, for an API that answers
 * JSON). Null when there is no room for it this month — the caller says what went wrong.
 * Firecrawl charges a credit when it returns a document, whatever the page's own status;
 * nothing when it returns none.
 *
 * @param {string} url
 * @param {{ raw?: boolean, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ text: string, status: number|null, title: string|null, url: string, pages: number|null } | null>}
 */
export async function firecrawlScrape(url, { raw = false, timeoutMs = 45_000, signal } = {}) {
  const held = await hold('firecrawl_scrape', 1);
  if (!held) return null;
  let json;
  try {
    json = await call('/v2/scrape', {
      body: {
        url,
        formats: [raw ? 'rawHtml' : 'markdown'],
        onlyMainContent: !raw,
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
  const data = json.data || {};
  const meta = data.metadata || {};
  const pages = Number(meta.numPages) || null;
  const used = Number(meta.creditsUsed);
  await held.settle(Number.isFinite(used) ? used : 1 + (pages ? Math.min(pages, PDF_PAGES) : 0));
  return {
    text: String((raw ? data.rawHtml : data.markdown) || ''),
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
 * @param {{ search?: string, limit?: number, signal?: AbortSignal }} [options]
 */
export async function firecrawlMap(url, { search = '', limit = 100, signal } = {}) {
  const held = await hold('firecrawl_more', 1);
  if (!held) throw standAside('the free allowance for site maps and crawls is used for now');
  let json;
  try {
    json = await call('/v2/map', {
      body: { url, ...(search ? { search: String(search).slice(0, 200) } : {}), limit: Math.min(Math.max(Number(limit) || 100, 1), 500), sitemap: 'include', includeSubdomains: false },
      timeoutMs: 45_000,
      signal,
    });
  } catch (err) {
    await held.settle(chargedNothing(err) ? 0 : 1);
    throw err;
  }
  await held.settle(1);
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
 * @param {{ limit?: number, includePaths?: string[], deadline?: number, signal?: AbortSignal }} [options]
 */
export async function firecrawlCrawl(url, { limit = 5, includePaths = [], deadline = Infinity, signal } = {}) {
  const pages = Math.min(Math.max(Number(limit) || 5, 1), CRAWL_PAGES);
  const held = await hold('firecrawl_more', pages);
  if (!held) throw standAside('the free allowance for site maps and crawls is used for now');
  let started;
  try {
    started = await call('/v2/crawl', {
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
    await held.settle(chargedNothing(err) ? 0 : pages);
    throw err;
  }
  const id = String(started.id || '');
  const stopAt = Math.min(deadline - 25_000, Date.now() + 120_000);
  let status = null;
  let finished = false;
  while (id) {
    if (signal?.aborted) break;
    try {
      status = await call(`/v2/crawl/${encodeURIComponent(id)}`, { method: 'GET', timeoutMs: 15_000, signal });
    } catch (err) {
      if (signal?.aborted) break;
      log.warn('firecrawl: crawl status unreadable', { error: String(err?.message || err).slice(0, 160) });
    }
    finished = ['completed', 'failed', 'cancelled'].includes(String(status?.status));
    if (finished || Date.now() + 4_000 > stopAt) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  // Out of time: stopped, so the pages it has not reached are never charged.
  if (id && !finished) await call(`/v2/crawl/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {});
  const used = Number(status?.creditsUsed);
  await held.settle(Number.isFinite(used) ? used : pages);
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
 * @param {{ k?: number, signal?: AbortSignal }} [options]
 */
export async function developerSearch(query, { k = 5, signal } = {}) {
  const held = await hold('firecrawl_more', 2);
  if (!held) return [];
  let json;
  try {
    json = await call('/v2/search/developer', { method: 'GET', query: { query: String(query).slice(0, 300), k: Math.min(Math.max(Number(k) || 5, 1), 10), passages: 2 }, timeoutMs: 20_000, signal });
  } catch (err) {
    await held.settle(chargedNothing(err) ? 0 : 2);
    throw err;
  }
  await held.settle(2);
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
 * The free indexes: a call counted against the day (`firecrawl_index`), never against credits.
 * @param {string} path @param {Record<string, any>} query @param {{ signal?: AbortSignal }} [options]
 */
async function free(path, query, { signal } = {}) {
  if (!firecrawlReady()) throw standAside('not set up on this deployment');
  if (asideUntil > Date.now()) throw standAside('asked to be left alone for a while');
  if (!(await take('firecrawl_index', 1))) throw standAside("today's free index searches are used");
  return call(path, { method: 'GET', query, timeoutMs: 20_000, signal });
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
