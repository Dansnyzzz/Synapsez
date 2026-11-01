/**
 * Searching the web, with somewhere to fall back to.
 *
 * One engine is a single point of failure for the one tool an assistant reaches
 * for most: a key that runs out, a rate limit, a provider having a bad
 * afternoon, and every answer that depends on current information becomes "I
 * could not search". So this is a chain rather than a call. Each engine is tried
 * in turn until one of them answers with results, and the answer says which one
 * did — because "who told you that" is a fair question and the model should be
 * able to pass the answer on.
 *
 * The default order is Exa, then Google, then DuckDuckGo, then Tavily, then Brave:
 *
 *   **Exa** is neural search built for exactly this — it returns the passage
 *   that answers the question rather than a page that mentions the words.
 *   **Google** is real Google results through Gemini's search grounding, on
 *   a Gemini key; with none it stands aside silently (see `searchGoogle`).
 *   **DuckDuckGo** needs no key and costs nothing, so it sits ahead of the paid
 *   fallbacks: an outage on the good engine should not start spending credits.
 *   **Tavily** and **Brave** are the paid safety nets, in that order.
 *
 * `SEARCH_ORDER` overrides it — `SEARCH_ORDER=tavily,exa` is a complete answer
 * to "I would rather spend Tavily credits than anything else".
 */

import { untrusted } from './tools/untrusted.js';
import { log } from './util/trace.js';
import { googleDataInScope } from './googleData.js';

const DEFAULT_ORDER = ['exa', 'google', 'duckduckgo', 'tavily', 'brave'];

/**
 * How far one search goes at each reasoning level (owner, 2026-11-02) — one
 * table every engine reads, so Exa, Google, DuckDuckGo, Tavily and Brave move
 * together rather than each having its own idea of "careful".
 *
 *   count      results asked for
 *   read       top pages web_search opens and reads into its answer
 *   snippet    characters kept from each result; Exa's highlights are asked
 *              for at this length, focused on the query
 *   exa        Exa's search type: fast, auto, deep (expands the query itself,
 *              4–12s) or deep-reasoning (12–50s) — the last two also return
 *              Exa's own grounded summary of what it found
 *   tavily     Tavily's depth: basic, or advanced (the best passages of each page)
 *   fuse       a second engine searched alongside the first, the two merged
 *   code       sources code_context gathers
 *   timeoutMs  how long one engine may take
 */
export const SEARCH_LEVELS = Object.freeze({
  low: { count: 5, read: 0, snippet: 300, exa: 'fast', tavily: 'basic', fuse: false, code: 3, timeoutMs: 15_000 },
  medium: { count: 8, read: 0, snippet: 450, exa: 'auto', tavily: 'basic', fuse: false, code: 4, timeoutMs: 30_000 },
  high: { count: 8, read: 2, snippet: 600, exa: 'auto', tavily: 'advanced', fuse: false, code: 5, timeoutMs: 30_000 },
  xhigh: { count: 10, read: 3, snippet: 800, exa: 'deep', tavily: 'advanced', fuse: true, code: 6, timeoutMs: 45_000 },
  max: { count: 12, read: 4, snippet: 1000, exa: 'deep-reasoning', tavily: 'advanced', fuse: true, code: 8, timeoutMs: 60_000 },
});

/**
 * The plan for one search: the person's reasoning level, unless the call says
 * otherwise — `quick` for a check inside a careful job (links only, the fast
 * path, one engine), `thorough` for a careful look on a fast setting. An
 * unknown level is the settings default, high.
 */
export function searchPlan(effort, depth) {
  const level = SEARCH_LEVELS[effort] || SEARCH_LEVELS.high;
  if (depth === 'quick') return { ...level, read: 0, exa: 'fast', tavily: 'basic', fuse: false, timeoutMs: Math.min(level.timeoutMs, 15_000) };
  if (depth === 'thorough') {
    return { ...level, count: Math.max(level.count, 10), read: Math.max(level.read, 3), exa: level.exa === 'fast' ? 'auto' : level.exa, tavily: 'advanced' };
  }
  return level;
}

/** How far back `recency` reaches, in days — the same span for every engine. */
const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 366 };

/**
 * The sites a search is held to, as bare host names: no scheme, no path,
 * nothing that is not a name, five at most. Each engine says it its own way
 * (Exa and Tavily take a list; Brave, DuckDuckGo and Google read `site:`).
 */
export function cleanSites(sites) {
  const given = Array.isArray(sites) ? sites : String(sites || '').split(/[\s,]+/);
  const names = given
    .map((s) => String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^site:/, '').split(/[/?#]/)[0].replace(/^www\./, ''))
    .filter((s) => /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(s));
  return [...new Set(names)].slice(0, 5);
}

/** A query held to some sites, for the engines that read `site:` in the query itself. */
const withSites = (query, sites) => (sites.length ? `${query} ${sites.map((s) => `site:${s}`).join(' OR ')}` : query);

/* ── DuckDuckGo, and being a good citizen about it ──────────────────── */

/**
 * How long to leave between two DuckDuckGo requests.
 *
 * There is no key and no quota, which is precisely why it needs pacing: the
 * limit is enforced by blocking the address for a while, and an assistant
 * running three searches in parallel is exactly the shape of traffic that
 * triggers it. Four seconds costs a moment on the rare occasion two searches
 * land together, and buys back an engine that would otherwise be unavailable
 * for the rest of the session.
 */
const DDG_MIN_INTERVAL_MS = Math.max(0, Number(process.env.DDG_MIN_INTERVAL_MS) || 4000);

let ddgTurn = Promise.resolve();
let ddgLast = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run something with DuckDuckGo's pacing applied.
 *
 * A promise chain rather than a timestamp check, so simultaneous callers queue
 * behind each other instead of all seeing "the last request was ages ago" at
 * the same moment and firing together — which is the case the pacing exists for.
 */
function pacedDuckDuckGo(run) {
  const mine = ddgTurn.then(async () => {
    const wait = ddgLast + DDG_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    ddgLast = Date.now();
    return run();
  });
  // The queue must not break when one request fails.
  ddgTurn = mine.then(
    () => {},
    () => {},
  );
  return mine;
}

/* ── the engines ────────────────────────────────────────────────────── */

const trim = (text, limit = 400) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};

/**
 * Why a search provider refused, in its own words.
 *
 * "HTTP 422" is not a reason anybody can act on; "the provided subscription
 * token is invalid" is — it names the key to replace. These APIs all put the
 * real reason in the body and throw it away is exactly what a status-code-only
 * error message does.
 */
async function refusal(label, res) {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.detail || json?.error?.message || json?.error || json?.message || body.slice(0, 200);
  } catch {
    /* not JSON, or already consumed — the status still says something */
  }
  return Object.assign(new Error(`${label} returned HTTP ${res.status}${detail ? `: ${trim(detail, 200)}` : ''}`), { status: res.status });
}

/**
 * Exa: neural search, and the reason it is first.
 *
 * `highlights` is the point — the passages that answer the query rather than
 * the opening paragraph of the page — asked for as Exa's own tools ask: focused
 * on the query, at the length the level keeps. The type follows the level
 * (`SEARCH_LEVELS`): `fast` on Low, `auto` (Exa picks neural or keyword per
 * query) in the middle, `deep` and `deep-reasoning` above — those expand the
 * query into several searches themselves and say what they found, which comes
 * back as `answer`. A deep search that fails for any reason but the key is
 * asked again the ordinary way, so a slow or unavailable deep path never
 * costs the answer.
 *
 * @param {{ count: number, plan: any, recency: string|null, sites: string[] }} ask
 */
async function searchExa(query, ask) {
  const body = {
    query,
    type: ask.plan.exa,
    numResults: ask.count,
    contents: { highlights: { query, maxCharacters: ask.plan.snippet } },
    ...(ask.sites.length ? { includeDomains: ask.sites } : {}),
    ...(ask.recency ? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[ask.recency] * 86_400_000).toISOString() } : {}),
  };
  const call = async (sent, timeoutMs) => {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(sent),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw await refusal('Exa', res);
    return res.json();
  };
  let json;
  try {
    json = await call(body, ask.plan.timeoutMs);
  } catch (err) {
    if (!String(body.type).startsWith('deep') || [401, 402, 403].includes(err.status)) throw err;
    // Kept short: the deep attempt has already spent its time, and a turn has five minutes in all.
    json = await call({ ...body, type: 'auto' }, 20_000);
  }

  const results = (json.results || []).map((result) => ({
    title: result.title || result.url,
    url: result.url,
    snippet: trim((result.highlights || []).join(' … ') || result.text || '', ask.plan.snippet),
    published: result.publishedDate || null,
  }));
  const said = typeof json.output?.content === 'string' ? json.output.content.trim() : '';
  return { results, answer: said || null };
}

/** Tavily: `advanced` from High up — the best passages of each page, at two credits a search. */
async function searchTavily(query, ask) {
  const advanced = ask.plan.tavily === 'advanced';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      max_results: ask.count,
      search_depth: ask.plan.tavily,
      ...(advanced ? { chunks_per_source: 3 } : {}),
      ...(ask.recency ? { time_range: ask.recency } : {}),
      ...(ask.sites.length ? { include_domains: ask.sites } : {}),
      include_answer: false,
    }),
    signal: AbortSignal.timeout(ask.plan.timeoutMs),
  });
  if (!res.ok) throw await refusal('Tavily', res);

  const json = await res.json();
  return (json.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: trim(result.content, ask.plan.snippet),
    published: result.published_date || null,
  }));
}

/** Brave's freshness codes for the same spans. */
const BRAVE_FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

async function searchBrave(query, ask) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', withSites(query, ask.sites));
  url.searchParams.set('count', String(Math.min(ask.count, 20)));
  if (ask.recency) url.searchParams.set('freshness', BRAVE_FRESHNESS[ask.recency]);

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(ask.plan.timeoutMs),
  });
  if (!res.ok) throw await refusal('Brave Search', res);

  const json = await res.json();
  return (json.web?.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: trim(result.description, ask.plan.snippet),
    published: result.age || null,
  }));
}

/** Crude but dependency-free HTML → text, for the one engine that returns a page. */
function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * DuckDuckGo's HTML endpoint. No key, no quota, and no promises.
 *
 * Scraping is brittle by nature, so every failure mode here is a normal
 * outcome that hands over to the next engine: a block page, a challenge, a
 * layout change that stops the pattern matching. The one thing it must not do
 * is look like success with nothing in it.
 */
async function searchDuckDuckGo(query, ask) {
  const count = ask.count;
  // `df` is DuckDuckGo's own date filter: d, w, m or y.
  const form = { q: withSites(query, ask.sites), ...(ask.recency ? { df: ask.recency[0] } : {}) };
  return pacedDuckDuckGo(async () => {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(ask.plan.timeoutMs),
    });
    if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);

    const html = await res.text();
    // The block page is a 200 with an apology on it, which is the failure that
    // would otherwise be reported as "no results for this query".
    if (/anomaly|unusual traffic|blocked/i.test(html) && !/result__a/.test(html)) {
      throw new Error('DuckDuckGo served a rate-limit page rather than results.');
    }

    const results = [];
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippet = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    // Bounded by the same `count` the link loop below uses. It was unbounded,
    // and ran to exhaustion over the whole response to collect snippets that
    // were then mostly discarded — the loop below stops at `count`, so every
    // one past that was parsed and thrown away. The page is a remote document,
    // so its length is not this code's to assume.
    const snippets = [];
    let found;
    while ((found = snippet.exec(html)) && snippets.length < count) {
      snippets.push(stripTags(found[1]));
    }

    let match;
    while ((match = link.exec(html)) && results.length < count) {
      let href = match[1];
      // Outbound links are wrapped in a redirect carrying the real URL.
      const wrapped = /[?&]uddg=([^&]+)/.exec(href);
      if (wrapped) href = decodeURIComponent(wrapped[1]);
      if (href.startsWith('//')) href = `https:${href}`;
      results.push({ title: stripTags(match[2]), url: href, snippet: trim(snippets[results.length] || '', ask.plan.snippet), published: null });
    }

    if (!results.length) throw new Error('Nothing could be parsed out of the DuckDuckGo page.');
    return results;
  });
}

/* ── Google, through Gemini ─────────────────────────────────────────── */

/**
 * Google Search, via Gemini's "grounding with Google Search".
 *
 * Google's own search API for developers (Custom Search JSON) no longer takes
 * new customers, so the way to real Google results is to ask Gemini with the
 * search tool switched on and read back the pages it grounded on. It runs on a
 * Gemini key — the deployment's `GEMINI_API_KEY`, or the account's own Google
 * key from Settings → Providers — and simply stands aside when there is none.
 *
 * The links Gemini returns are Google redirect addresses; each is followed once
 * to the real page, because "vertexaisearch.cloud.google.com/grounding-api-
 * redirect/…" tells the reader nothing about where a claim came from.
 */
const GROUNDING_MODEL = process.env.GOOGLE_SEARCH_MODEL || 'gemini-2.5-flash';

/** @param {{ count: number, plan: any, recency: string|null, sites: string[], userId?: string|null }} ask */
async function searchGoogle(query, ask) {
  // A query written in a conversation holding Google data is not sent through a
  // Gemini key, which may train on it (googleData.js); the next engine searches.
  if (googleDataInScope()) throw Object.assign(new Error('not with Google data'), { skip: true });
  const { count, userId } = ask;
  let key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  if (!key && userId) {
    const { getApiKey } = await import('./settings.js');
    key = (await getApiKey(userId, 'google').catch(() => null)) || '';
  }
  if (!key) throw Object.assign(new Error('no Gemini key'), { skip: true });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GROUNDING_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  `Search Google for: ${withSites(query, ask.sites)}\n` +
                  (ask.recency ? `Only pages published in the past ${ask.recency}.\n` : '') +
                  `List what the top ${count} results say, briefly.`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(ask.plan.timeoutMs),
    },
  );
  if (!res.ok) throw new Error(`Google (Gemini grounding) returned HTTP ${res.status}`);
  const body = await res.json();
  const meta = body?.candidates?.[0]?.groundingMetadata || {};
  const chunks = meta.groundingChunks || [];
  if (!chunks.length) return [];

  // What each source was cited for: the sentences of the answer that point at it.
  const said = chunks.map(() => []);
  for (const support of meta.groundingSupports || []) {
    for (const i of support.groundingChunkIndices || []) said[i]?.push(support.segment?.text || '');
  }

  const resolve = async (uri) => {
    // Only Google's own redirector is asked where it points. Anything else is
    // returned as given rather than fetched from the server unchecked.
    let host = '';
    try {
      host = new URL(uri).hostname;
    } catch {
      return uri;
    }
    if (host !== 'vertexaisearch.cloud.google.com') return uri;
    try {
      const hop = await fetch(uri, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      return hop.headers.get('location') || uri;
    } catch {
      return uri;
    }
  };
  const picked = chunks.slice(0, count);
  const urls = await Promise.all(picked.map((c) => resolve(c.web?.uri || '')));
  return picked.map((c, i) => ({
    title: c.web?.title || urls[i],
    url: urls[i],
    snippet: trim(said[i].join(' '), ask.plan.snippet),
    published: null,
  }));
}

/* ── the chain ──────────────────────────────────────────────────────── */

const ENGINES = {
  exa: { label: 'Exa', run: searchExa, key: 'EXA_API_KEY' },
  tavily: { label: 'Tavily', run: searchTavily, key: 'TAVILY_API_KEY' },
  brave: { label: 'Brave', run: searchBrave, key: 'BRAVE_API_KEY' },
  // No key, so it is always available — which is what makes it a good middle
  // of the chain rather than a last resort.
  duckduckgo: { label: 'DuckDuckGo', run: searchDuckDuckGo, key: null },
  // Keyed per account as well as per deployment, so it decides for itself.
  google: { label: 'Google', run: searchGoogle, key: null },
};

/** The engines to try, in order, skipping the ones with no key. */
export function searchChain() {
  const wanted = String(process.env.SEARCH_ORDER || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const order = wanted.length ? wanted : DEFAULT_ORDER;
  return order
    .filter((name) => ENGINES[name])
    .filter((name) => !ENGINES[name].key || process.env[ENGINES[name].key]);
}

/** One address however it was written — scheme, www., a trailing slash and tracking tags aside. */
function sameUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/.test(key)) u.searchParams.delete(key);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/**
 * Two engines' results as one list (reciprocal rank fusion): a page high on
 * both lists comes first, and a page only one of them found still takes its
 * place by rank. Each result says which engines found it — two engines that
 * agree is worth knowing — and keeps the fuller of the snippets.
 */
export function fuseResults(answered, count) {
  if (answered.length === 1) return answered[0].results.slice(0, count);
  const byUrl = new Map();
  for (const { label, results } of answered) {
    results.forEach((result, rank) => {
      const key = sameUrl(result.url);
      const seen = byUrl.get(key);
      const score = 1 / (60 + rank);
      if (!seen) {
        byUrl.set(key, { ...result, engines: [label], score });
        return;
      }
      seen.score += score;
      if (!seen.engines.includes(label)) seen.engines.push(label);
      if (String(result.snippet || '').length > String(seen.snippet || '').length) seen.snippet = result.snippet;
      seen.published ||= result.published;
    });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ score: _score, ...result }) => result);
}

/**
 * Search, and say who answered.
 *
 * The level's plan (`searchPlan`) says how far: how many results, how long a
 * passage from each, how hard Exa and Tavily look — and, from Extra high up,
 * a second engine searched alongside the first and merged with it. `recency`
 * (day, week, month, year) and `sites` hold every engine to the same span and
 * the same sites, each in its own words.
 *
 * @param {string} query
 * @param {{ count?: number, userId?: string|null, plan?: any, recency?: string|null, sites?: string[]|string }} [options]
 * @returns `{ engine, engines, results, attempts, answer }` — `attempts` records
 *   what was tried and why it did not answer, which is the difference between
 *   "there is nothing about this on the web" and "the search key expired last
 *   Tuesday"; `answer` is Exa's own summary when a deep search gave one.
 */
export async function search(query, { count, userId = null, plan = SEARCH_LEVELS.medium, recency = null, sites = [] } = {}) {
  const wanted = Math.min(Math.max(Number(count) || plan.count || 8, 1), 20);
  const chain = searchChain();

  if (!chain.length) {
    throw Object.assign(
      new Error(
        'No search engine is configured. Set EXA_API_KEY or TAVILY_API_KEY, or leave DuckDuckGo enabled — it needs no key.',
      ),
      { code: 'no_search_engine' },
    );
  }

  const ask = {
    count: wanted,
    plan,
    recency: Object.hasOwn(RECENCY_DAYS, String(recency)) ? String(recency) : null,
    sites: cleanSites(sites),
    userId,
  };

  /*
   * Down the chain, in one lane — or two side by side when the plan fuses.
   * Each lane takes the next engine not yet tried and stops at the first that
   * answers; one that fails or finds nothing hands the lane to the next. So
   * one lane is exactly the chain as it always was, and with two a paid
   * fallback is asked only once the engines ahead of it in the chain did not
   * answer.
   */
  const attempts = [];
  const answered = [];
  let next = 0;
  const lane = async () => {
    while (next < chain.length) {
      const at = next;
      next += 1;
      const engine = ENGINES[chain[at]];
      try {
        const out = await engine.run(query, ask);
        const results = Array.isArray(out) ? out : out.results;
        if (results.length) {
          answered.push({ at, label: engine.label, results, answer: Array.isArray(out) ? null : out.answer });
          return;
        }
        attempts.push({ at, engine: engine.label, error: 'no results' });
      } catch (err) {
        // An engine with nothing to run on stands aside without being reported as failing.
        if (err.skip) continue;
        attempts.push({ at, engine: engine.label, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: plan.fuse ? 2 : 1 }, lane));
  // In chain order, whichever finished first.
  answered.sort((a, b) => a.at - b.at);
  attempts.sort((a, b) => a.at - b.at);
  const tried = attempts.map(({ engine, error }) => ({ engine, error }));

  if (!answered.length) return { engine: null, engines: [], results: [], attempts: tried, answer: null };
  const engines = answered.map((a) => a.label);
  const results = fuseResults(answered, wanted);
  /**
   * Say who spent it.
   *
   * These keys are deployment-wide — one Exa or Tavily key serves every
   * account — so unlike a model call there is no per-account quota this
   * lands against and nothing anywhere recorded who searched. A single
   * `deep_research` run makes up to six of these, so "the search bill
   * went up" had no way of being traced to anybody.
   *
   * Attribution rather than enforcement: the operator can now see it in
   * the log. Per-account search keys would be the fuller answer and are a
   * product decision, not an audit fix — see .env.example, which now says
   * plainly that these are shared.
   */
  log.info('search', { engine: engines.join('+'), userId: userId || 'unattributed', results: results.length, exa: plan.exa });
  return {
    engine: engines.join(' + '),
    engines,
    results,
    attempts: tried,
    answer: answered.find((a) => a.answer)?.answer || null,
  };
}

/** How much of Exa's own summary is passed on — the sources below it are the evidence. */
const ANSWER_CHARS = 1500;

/** The search result as the model reads it. */
export function formatResults(query, { engine, engines = [], results, attempts, answer = null }) {
  if (!results.length) {
    const tried = attempts.map((a) => `${a.engine} (${a.error})`).join(', ');
    return `No results for "${query}". Tried: ${tried || 'nothing'}.`;
  }

  const lines = results.map((result, i) => {
    const parts = [`${i + 1}. ${result.title}`, `   ${result.url}`];
    if (result.snippet) parts.push(`   ${result.snippet}`);
    if (result.published) parts.push(`   published ${String(result.published).slice(0, 10)}`);
    if (result.engines?.length > 1) parts.push(`   found by ${result.engines.join(' and ')}`);
    return parts.join('\n');
  });
  // Exa's deep search says what it found. Written by a model from the pages
  // above, so it goes in the same envelope, after them, and is named for what it is.
  const summary = answer
    ? `\n\nExa's own summary of what it found — check it against the sources above:\n${answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)}…` : answer}`
    : '';

  // Named, because which engine answered changes how much weight a result
  // deserves — and because a silent failover looks like a quality regression.
  const merged = engines.length > 1 ? ', merged — a page more than one engine found ranks higher' : '';
  const failed = attempts.length ? ` after ${attempts.map((a) => a.engine).join(', ')} failed` : '';
  // Titles and snippets are written by whoever owns the page, so they are data
  // like any other fetched text — and a search result is a cheap thing for an
  // attacker to get in front of a model. See server/tools/untrusted.js.
  return `${results.length} results from ${engine}${merged}${failed}.\n\n${untrusted(`${engine} search results`, lines.join('\n\n') + summary)}`;
}

/**
 * A page read through Exa (`/contents`, what Exa's web_fetch_exa calls): for a
 * site that turned this server away — a 403 to anything that is not a browser,
 * a rate limit, a page that is only script. Exa reads it from its own copy, or
 * fresh when it has none. Null with no key, or when Exa could not read it either.
 *
 * @param {string} url
 * @param {{ maxChars?: number, timeoutMs?: number }} [options]
 * @returns {Promise<{ title: string, text: string } | null>}
 */
export async function readThroughExa(url, { maxChars = 20_000, timeoutMs = 30_000 } = {}) {
  if (!process.env.EXA_API_KEY) return null;
  try {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [url], text: { maxCharacters: maxChars }, livecrawl: 'fallback' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const hit = ((await res.json()).results || [])[0];
    return hit?.text ? { title: String(hit.title || ''), text: String(hit.text) } : null;
  } catch {
    return null;
  }
}
