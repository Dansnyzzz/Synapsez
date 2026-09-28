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

const DEFAULT_ORDER = ['exa', 'google', 'duckduckgo', 'tavily', 'brave'];

const TIMEOUT_MS = 30_000;

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
  return new Error(`${label} returned HTTP ${res.status}${detail ? `: ${trim(detail, 200)}` : ''}`);
}

/**
 * Exa: neural search, and the reason it is first.
 *
 * `highlights` is the point — it returns the sentences that actually answer the
 * query rather than the opening paragraph of the page, which is both a better
 * answer and fewer tokens. `type: auto` lets Exa decide between its neural and
 * keyword paths per query, which is the documented default and right for a
 * general-purpose tool.
 */
async function searchExa(query, count) {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: count,
      contents: { highlights: true },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await refusal('Exa', res);

  const json = await res.json();
  return (json.results || []).map((result) => ({
    title: result.title || result.url,
    url: result.url,
    // Highlights are an array of passages; the first two are plenty and the
    // rest is usually the same idea again.
    snippet: trim((result.highlights || []).slice(0, 2).join(' … ') || result.text || ''),
    published: result.publishedDate || null,
  }));
}

async function searchTavily(query, count) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: count, include_answer: false }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await refusal('Tavily', res);

  const json = await res.json();
  return (json.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: trim(result.content),
    published: result.published_date || null,
  }));
}

async function searchBrave(query, count) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw await refusal('Brave Search', res);

  const json = await res.json();
  return (json.web?.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: trim(result.description),
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
async function searchDuckDuckGo(query, count) {
  return pacedDuckDuckGo(async () => {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: new URLSearchParams({ q: query }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
      results.push({ title: stripTags(match[2]), url: href, snippet: snippets[results.length] || '', published: null });
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

/** @param {{ userId?: string|null }} [who] */
async function searchGoogle(query, count, who = {}) {
  const userId = who.userId;
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
        contents: [{ role: 'user', parts: [{ text: `Search Google for: ${query}\nList what the top results say, briefly.` }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    snippet: said[i].join(' ').slice(0, 400),
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

/**
 * Search, and say who answered.
 *
 * @returns `{ engine, results, attempts }` — `attempts` records what was tried
 *   and why it did not answer, which is the difference between "there is
 *   nothing about this on the web" and "the search key expired last Tuesday".
 */
export async function search(query, { count = 8, userId = null } = {}) {
  const wanted = Math.min(Math.max(Number(count) || 8, 1), 20);
  const chain = searchChain();

  if (!chain.length) {
    throw Object.assign(
      new Error(
        'No search engine is configured. Set EXA_API_KEY or TAVILY_API_KEY, or leave DuckDuckGo enabled — it needs no key.',
      ),
      { code: 'no_search_engine' },
    );
  }

  const attempts = [];
  for (const name of chain) {
    const engine = ENGINES[name];
    try {
      const results = await engine.run(query, wanted, { userId });
      if (results.length) {
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
        log.info('search', { engine: engine.label, userId: userId || 'unattributed', results: results.length });
        return { engine: engine.label, results, attempts };
      }
      attempts.push({ engine: engine.label, error: 'no results' });
    } catch (err) {
      // An engine with nothing to run on stands aside without being reported as failing.
      if (err.skip) continue;
      attempts.push({ engine: engine.label, error: err.message });
    }
  }

  return { engine: null, results: [], attempts };
}

/** The search result as the model reads it. */
export function formatResults(query, { engine, results, attempts }) {
  if (!results.length) {
    const tried = attempts.map((a) => `${a.engine} (${a.error})`).join(', ');
    return `No results for "${query}". Tried: ${tried || 'nothing'}.`;
  }

  const lines = results.map((result, i) => {
    const parts = [`${i + 1}. ${result.title}`, `   ${result.url}`];
    if (result.snippet) parts.push(`   ${result.snippet}`);
    if (result.published) parts.push(`   published ${String(result.published).slice(0, 10)}`);
    return parts.join('\n');
  });

  // Named, because which engine answered changes how much weight a result
  // deserves — and because a silent failover looks like a quality regression.
  const failed = attempts.length ? ` after ${attempts.map((a) => a.engine).join(', ')} failed` : '';
  // Titles and snippets are written by whoever owns the page, so they are data
  // like any other fetched text — and a search result is a cheap thing for an
  // attacker to get in front of a model. See server/tools/untrusted.js.
  return `${results.length} results from ${engine}${failed}.\n\n${untrusted(`${engine} search results`, lines.join('\n\n'))}`;
}
