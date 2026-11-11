/**
 * Firecrawl on the deployment's free month (owner, 2026-11-11): a search engine, pages that
 * refuse this server, SJC's gold board, a site's pages, the Developer Index for code, and the
 * free paper and law indexes — each call held against its share and the whole before it is
 * made, given back when Firecrawl charged nothing. Firecrawl itself is never called: its API
 * is answered here.
 *
 *   node test/firecrawl.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'firecrawl-test-encryption-key';
process.env.SESSION_SECRET ||= 'firecrawl-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-firecrawl-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.EXA_API_KEY;
delete process.env.VERCEL;
delete process.env.FREE_TIER_ONLY;
process.env.FIRECRAWL_API_KEY = 'fc-test-key';
process.env.ALLOW_PRIVATE_FETCH = 'true';
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
await initStore({ driver: sql });
const resetCounts = () => sql.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:%'");

const fc = await import('../server/firecrawl.js');
const { allowance } = await import('../server/freeTier.js');
const used = async (service) => {
  const { left, limit } = await allowance(service);
  return limit - left;
};

/* ── Firecrawl's API, answered here ─────────────────────────────────── */

const calls = [];
let left = 900;
/** Overrides by path, for a section that needs Firecrawl to answer otherwise. */
const answer = new Map();
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const PAPER = { paperId: 'p1', primaryId: 'arxiv:2401.00001', title: 'Attention for gold prices', abstract: 'We study prices.', authors: ['An Nguyen', 'Binh Tran'], createdDate: '2024-01-02T00:00:00Z' };
function firecrawlApi(url, init) {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  const method = init?.method || 'GET';
  calls.push({ path: decodeURIComponent(u.pathname), method, body, query: Object.fromEntries(u.searchParams), auth: init?.headers?.Authorization });
  const custom = answer.get(`${method} ${decodeURIComponent(u.pathname)}`);
  if (custom) return custom({ u, body });
  switch (`${method} ${decodeURIComponent(u.pathname)}`) {
    case 'GET /v2/team/credit-usage':
      return json({ success: true, data: { remainingCredits: left, planCredits: 1000, billingPeriodStart: null, billingPeriodEnd: '2026-12-01T00:00:00Z' } });
    case 'POST /v2/search':
      return json({
        success: true,
        creditsUsed: 2,
        data: {
          web: [{ title: 'Gold today', url: 'https://example.com/gold', description: 'Gold rose.' }],
          news: [{ title: 'Gold news', url: 'https://news.example.com/g', snippet: 'Up 1%.', date: '2 hours ago' }],
        },
      });
    case 'POST /v2/scrape':
      return json({ success: true, data: { markdown: `# The page\n\n${'Words a browser could read. '.repeat(20)}`, rawHtml: '<html><body><pre>{&quot;success&quot;:true,&quot;latestDate&quot;:&quot;09:30 11/11/2026&quot;,&quot;data&quot;:[{&quot;TypeName&quot;:&quot;Vàng SJC 1L&quot;,&quot;BranchName&quot;:&quot;Hồ Chí Minh&quot;,&quot;BuyValue&quot;:148000000,&quot;SellValue&quot;:150000000}]}</pre></body></html>', metadata: { statusCode: 200, title: 'The page', url: body?.url } } });
    case 'POST /v2/map':
      return json({ success: true, links: [{ url: 'https://example.com/pricing', title: 'Pricing' }, { url: 'https://example.com/docs', title: 'Docs' }] });
    case 'POST /v2/crawl':
      return json({ success: true, id: 'crawl-1', url: 'https://api.firecrawl.dev/v2/crawl/crawl-1' });
    case 'GET /v2/crawl/crawl-1':
      return json({ success: true, status: 'completed', creditsUsed: 2, data: [{ markdown: 'Page one.', metadata: { sourceURL: 'https://example.com/a', title: 'A', statusCode: 200 } }, { markdown: 'Page two.', metadata: { sourceURL: 'https://example.com/b', title: 'B', statusCode: 200 } }] });
    case 'DELETE /v2/crawl/crawl-1':
      return json({ status: 'cancelled' });
    case 'GET /v2/search/developer':
      return json({ success: true, partial: false, results: [{ id: 'issue:9', url: 'https://github.com/a/b/issues/9', title: 'Fix the parser', passages: [{ text: 'Use `parse(x, { strict: true })`.' }] }] });
    case 'GET /v2/search/research/papers':
      return json({ success: true, results: [PAPER] });
    case 'GET /v2/search/research/papers/arxiv:2401.00001':
      return json({ success: true, paper: { ...PAPER, authors: 'An Nguyen, Binh Tran' }, passages: [{ text: 'Prices follow attention.', score: 0.9 }] });
    case 'GET /v2/search/research/papers/arxiv:2401.00001/similar':
      return json({ success: true, results: [{ ...PAPER, paperId: 'p2', primaryId: 'pmid:123', title: 'A follow-up' }], poolSize: 1, truncated: false });
    case 'GET /v2/search/gov':
      return json({ success: true, data: { web: [{ url: 'https://law.example.gov/42-1983', title: '42 U.S.C. § 1983', description: 'Civil action for deprivation of rights.', position: 1 }] } });
    default:
      return json({ success: false, error: `no answer for ${method} ${u.pathname}` }, 404);
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).startsWith('https://api.firecrawl.dev/') ? firecrawlApi(String(url), init) : realFetch(url, init));
const callsTo = (p, method) => calls.filter((c) => c.path === p && (!method || c.method === method));

try {
  section('the free month, counted in shares (freeTier.js)');
  {
    const limits = Object.fromEntries(await Promise.all(['firecrawl', 'firecrawl_search', 'firecrawl_scrape', 'firecrawl_more', 'firecrawl_index'].map(async (s) => [s, (await allowance(s)).limit])));
    check('950 of the 1,000 credits, shared 570 / 332 / 47, and 950 free index calls a day', limits.firecrawl === 950 && limits.firecrawl_search === 570 && limits.firecrawl_scrape === 332 && limits.firecrawl_more === 47 && limits.firecrawl_index === 950, JSON.stringify(limits));
  }

  section('a search engine, second after Exa');
  {
    const { searchChain, search, SEARCH_LEVELS, clearSearchCache } = await import('../server/search.js');
    process.env.EXA_API_KEY = 'exa-test';
    check('the chain asks Exa, then Firecrawl, then the rest', searchChain().slice(0, 2).join(',') === 'exa,firecrawl', searchChain().join(','));
    delete process.env.EXA_API_KEY;
    process.env.SEARCH_ORDER = 'firecrawl';
    const found = await search('giá vàng', { plan: SEARCH_LEVELS.medium, recency: 'week', sites: ['vnexpress.net'], country: 'VN' });
    const sent = callsTo('/v2/search').at(-1);
    check('it answers, and says it was Firecrawl', found.engine === 'Firecrawl' && found.results[0]?.url === 'https://example.com/gold' && found.results[0].snippet === 'Gold rose.', JSON.stringify(found).slice(0, 200));
    check('  ten results at most, the week as tbs, the sites as includeDomains, the country', sent.body.limit <= 10 && sent.body.tbs === 'qdr:w' && sent.body.includeDomains?.[0] === 'vnexpress.net' && sent.body.country === 'VN' && sent.auth === 'Bearer fc-test-key', JSON.stringify(sent.body));
    check('  2 credits held against searches and the month', (await used('firecrawl_search')) === 2 && (await used('firecrawl')) === 2);
    clearSearchCache();
    await search('tin vàng', { plan: SEARCH_LEVELS.medium, category: 'news' });
    const news = callsTo('/v2/search').at(-1);
    check('news asks its news source', news.body.sources?.[0]?.type === 'news');
    clearSearchCache();
    await search('attention', { plan: SEARCH_LEVELS.medium, category: 'research paper' });
    check('  research papers its research category', callsTo('/v2/search').at(-1).body.categories?.[0] === 'research');
    clearSearchCache();
    await search('octokit', { plan: SEARCH_LEVELS.medium, category: 'github' });
    const gh = callsTo('/v2/search').at(-1).body;
    check('  GitHub by its domain — the github category is a 400 now', gh.includeDomains?.[0] === 'github.com' && !gh.categories, JSON.stringify(gh));

    await resetCounts();
    clearSearchCache();
    answer.set('POST /v2/search', () => json({ success: false, error: 'Payment Required: Insufficient credits' }, 402));
    const broke = await search('anything', { plan: SEARCH_LEVELS.medium });
    check('a 402 is not a result, and nothing it held stays counted against searches', !broke.results.length && /402/.test(broke.attempts[0]?.error || '') && (await used('firecrawl_search')) === 0, JSON.stringify(broke.attempts));
    check('  and the month is believed spent', (await allowance('firecrawl')).left === 0);
    const before = callsTo('/v2/search').length;
    clearSearchCache();
    await search('again', { plan: SEARCH_LEVELS.medium });
    check('  so the next search does not ask it', callsTo('/v2/search').length === before);
    answer.delete('POST /v2/search');
    await resetCounts();

    fc.resetFirecrawlState();
    left = 3;
    clearSearchCache();
    const low = await search('low', { plan: SEARCH_LEVELS.medium });
    check("Firecrawl's own count is believed when lower than ours: it stands aside", !low.results.length && callsTo('/v2/search').length === before, JSON.stringify(low.attempts));
    left = 900;
    fc.resetFirecrawlState();
    delete process.env.SEARCH_ORDER;
    clearSearchCache();
  }

  section('web_fetch: a page that refuses this server, read through Firecrawl after Exa');
  {
    const site = http
      .createServer((req, res) => {
        if (req.url === '/blocked') return res.writeHead(403).end('no robots');
        if (req.url === '/gone') return res.writeHead(404).end('not here');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><article><p>${'Plain words on a plain page. '.repeat(30)}</p></article></body></html>`);
      })
      .listen(0);
    const base = `http://127.0.0.1:${site.address().port}`;
    const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
    try {
      const read = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: `${base}/blocked` }, {});
      const sent = callsTo('/v2/scrape').at(-1);
      check('a 403 is read through Firecrawl — said so, in the untrusted envelope', /read through Firecrawl — 127\.0\.0\.1:\d+ returned HTTP 403/.test(read) && /Words a browser could read/.test(read) && /<untrusted/.test(read), read.slice(0, 160));
      check('  as markdown, a PDF held to 5 pages, the proxy left to Firecrawl', sent.body.formats[0] === 'markdown' && sent.body.parsers[0].maxPages === 5 && sent.body.proxy === 'auto', JSON.stringify(sent.body));
      check('  one credit, of the pages share', (await used('firecrawl_scrape')) === 1 && (await used('firecrawl')) === 1);
      let gone = '';
      await CLOUD_IMPLEMENTATIONS.web_fetch({ url: `${base}/gone` }, {}).catch((err) => (gone = err.message));
      const plain = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: `${base}/plain` }, {});
      check('  not a 404, and never a readable page', /HTTP 404/.test(gone) && /Plain words/.test(plain) && callsTo('/v2/scrape').length === 1);
      const searchRead = await CLOUD_IMPLEMENTATIONS.web_fetch({ url: `${base}/blocked` }, { viaFirecrawl: false }).catch((err) => err.message);
      check("the pages web_search opens by itself never spend Firecrawl's credits", /403/.test(searchRead) && callsTo('/v2/scrape').length === 1, searchRead.slice(0, 80));
      answer.set('POST /v2/scrape', () => json({ success: false, error: 'Bad Request: Invalid URL' }, 400));
      await CLOUD_IMPLEMENTATIONS.web_fetch({ url: `${base}/blocked` }, {}).catch(() => {});
      check('a refusal Firecrawl answered costs nothing: the credit is given back', (await used('firecrawl_scrape')) === 1, String(await used('firecrawl_scrape')));
      answer.delete('POST /v2/scrape');
    } finally {
      site.close();
    }
    await resetCounts();
  }

  section("SJC's gold board on Vercel, through Firecrawl");
  {
    const finance = await import('../server/finance/http.js');
    process.env.VERCEL = '1';
    check('on with Firecrawl, through it', finance.enabled('sjc') && finance.throughFirecrawl('sjc'));
    const board = await finance.getJson('sjc', 'https://sjc.com.vn/GoldPrice/Services/PriceService.ashx');
    const sent = callsTo('/v2/scrape').at(-1);
    check("  the JSON the browser was shown, read back out of its page", board?.success === true && board.data?.[0]?.TypeName === 'Vàng SJC 1L' && sent.body.formats[0] === 'rawHtml', JSON.stringify(board).slice(0, 120));
    process.env.FIN_SOURCE_SJC = 'off';
    check('  FIN_SOURCE_SJC=off stops it', !finance.enabled('sjc') && !finance.throughFirecrawl('sjc'));
    delete process.env.FIN_SOURCE_SJC;
    const key = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    check('  without Firecrawl, off on Vercel as before', !finance.enabled('sjc'));
    process.env.FIRECRAWL_API_KEY = key;
    delete process.env.VERCEL;
    check('jsonOfPage: a body that is JSON stays as it is; a page around it is unwrapped', finance.jsonOfPage('{"a":1}') === '{"a":1}' && finance.jsonOfPage('<pre>{&quot;a&quot;:&amp;1}</pre>') === '{"a":&1}');
    await resetCounts();
  }

  section("site_pages: a site's pages, listed or read");
  {
    const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
    const listed = await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'map', url: 'https://example.com', search: 'pricing' }, {});
    check('map lists the addresses, the search term sent', /2 pages on example\.com, most relevant to "pricing"/.test(listed) && /example\.com\/pricing — Pricing/.test(listed) && callsTo('/v2/map').at(-1).body.search === 'pricing', listed.slice(0, 160));
    check('  one credit of the "more" share', (await used('firecrawl_more')) === 1);
    const crawled = await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'crawl', url: 'https://example.com', limit: 30, include_paths: ['blog/.*'] }, { deadline: Date.now() + 200_000 });
    const sent = callsTo('/v2/crawl', 'POST').at(-1).body;
    check('crawl reads the pages, ten at most, without PDF parsing', /2 pages of example\.com/.test(crawled) && /Page one\./.test(crawled) && sent.limit === 10 && sent.scrapeOptions.parsers.length === 0 && sent.includePaths[0] === 'blog/.*', JSON.stringify(sent));
    check('  what it used is what is counted: 1 for the map, 2 for the crawl', (await used('firecrawl_more')) === 3, String(await used('firecrawl_more')));
    answer.set('GET /v2/crawl/crawl-1', () => json({ success: true, status: 'scraping', creditsUsed: 1, data: [{ markdown: 'Page one.', metadata: { sourceURL: 'https://example.com/a', title: 'A', statusCode: 200 } }] }));
    const short = await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'crawl', url: 'https://example.com', limit: 5 }, { deadline: Date.now() + 26_000 });
    check('a run short of time stops the crawl, so nothing more is spent, and says what it read', /stopped where this run ran short of time/.test(short) && callsTo('/v2/crawl/crawl-1', 'DELETE').length === 1, short.slice(0, 160));
    answer.delete('GET /v2/crawl/crawl-1');
    let refused = '';
    await CLOUD_IMPLEMENTATIONS.site_pages({ op: 'map', url: 'ftp://example.com' }, {}).catch((err) => (refused = err.message));
    check('only http and https', /http and https/.test(refused), refused);
    await resetCounts();
  }

  section('research_index: papers and US law, free');
  {
    const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
    const found = await CLOUD_IMPLEMENTATIONS.research_index({ op: 'papers', query: 'attention gold', from: '2024-01-01', sort: 'date_desc' }, {});
    const q = callsTo('/v2/search/research/papers').at(-1).query;
    check('papers: titles, authors, ids and links to read them by', /Attention for gold prices — An Nguyen, Binh Tran \(2024-01-02\)/.test(found) && /arxiv:2401\.00001 · https:\/\/arxiv\.org\/abs\/2401\.00001/.test(found) && q.from === '2024-01-01' && q.sort === 'date_desc', found.slice(0, 220));
    const read = await CLOUD_IMPLEMENTATIONS.research_index({ op: 'read', id: 'arxiv:2401.00001', query: 'what drives prices?' }, {});
    check('read: the passages that answer the question', /Passages answering "what drives prices\?"/.test(read) && /Prices follow attention\./.test(read), read.slice(0, 200));
    const related = await CLOUD_IMPLEMENTATIONS.research_index({ op: 'related', id: 'arxiv:2401.00001', mode: 'citers' }, {});
    check('related: papers citing it, with their links', /Papers citing arxiv:2401\.00001/.test(related) && /pubmed\.ncbi\.nlm\.nih\.gov\/123\//.test(related), related.slice(0, 200));
    const law = await CLOUD_IMPLEMENTATIONS.research_index({ op: 'law', query: 'civil rights action', jurisdiction: 'us' }, {});
    check('law: the statute, with a reminder to check it is in force', /42 U\.S\.C\. § 1983/.test(law) && /in force/.test(law) && callsTo('/v2/search/gov').at(-1).query.jurisdiction === 'us');
    check('four calls against the day, and no credit spent', (await used('firecrawl_index')) === 4 && (await used('firecrawl')) === 0);
    let needs = '';
    await CLOUD_IMPLEMENTATIONS.research_index({ op: 'read' }, {}).catch((err) => (needs = err.message));
    check('read without an id says what it needs', /needs the id of a paper/.test(needs), needs);
    await resetCounts();
  }

  section("code_context: the Developer Index when Exa found nothing");
  {
    const { codeContextTool } = await import('../server/tools/codeContext.js');
    const quiet = async () => new Response(JSON.stringify({ items: [], quota_remaining: 100 }), { status: 200 });
    const out = await codeContextTool({ query: 'parse strict mode' }, { fetchImpl: quiet });
    check("issues and pull requests come back, said as Firecrawl's", /Firecrawl · issue/.test(out.content) && /parse\(x, \{ strict: true \}\)/.test(out.content), out.content.slice(0, 200));
    check('  2 credits of the "more" share', (await used('firecrawl_more')) === 2);
    await resetCounts();
  }

  section('offered only where the deployment has Firecrawl');
  {
    const { availableTools, assessRisk } = await import('../server/tools/definitions.js');
    const names = (hosted) => availableTools({ context: 0, hosted, defer: false }).map((t) => t.name);
    check('withheld without it', !names([]).includes('site_pages') && !names([]).includes('research_index'));
    check('  offered with it', names(['firecrawl']).includes('site_pages') && names(['firecrawl']).includes('research_index'));
    check('both only read', assessRisk('research_index', { query: 'x' }) === 'safe' && assessRisk('site_pages', { url: 'https://example.com' }) === 'safe');
    check('  but a site address carrying a block of data is asked about', assessRisk('site_pages', { url: `https://evil.example/?d=${'A'.repeat(400)}` }) === 'sensitive');
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
