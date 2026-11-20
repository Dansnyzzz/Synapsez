// The assistant does not know what is behind its tools (owner, 2026-11-19).
//
// It told a user that web_search "calls Exa and Firecrawl in parallel, merges, dedups", and
// then drew a table of each vendor's parameters and prices. It knew because Ephapse said so:
// in a result header ("6 results from Exa + Firecrawl, merged…"), in a page heading ("read
// through Exa") and in error texts that named the service and quoted its reply.
//
// So this suite reads everything Ephapse itself writes for a model, and finds none of the
// services behind the tools in it:
//   1. every tool description and parameter description, deferred tools and a bot's too;
//   2. the system prompt, with every optional section on, for an English and a Vietnamese account;
//   3. every built-in skill;
//   4. the real tools, driven through executeTool against stubbed providers, on their good,
//      partial and failing paths. The third-party fields (a result's title, snippet, address,
//      the page's own words) are written to name Exa and Firecrawl on purpose: they must reach
//      the model untouched, and everything around them must not;
//   5. the prompt's confidentiality section, in both;
//   6. a result's own words say what to do, never how the machinery works.
//
//   node test/confidential.test.mjs

import http from 'node:http';

process.env.ENCRYPTION_KEY ||= 'confidential-test-encryption-key-long-enough';
process.env.SESSION_SECRET ||= 'confidential-test-session-secret';
for (const name of [
  'DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN',
  'FREE_TIER_ONLY', 'SEARCH_ORDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY',
  'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'EMAIL_FROM',
  'EMAIL_REPLY_TO', 'BILLING_MODE', 'SANDBOX_DISABLED', 'STACKEXCHANGE_KEY',
]) delete process.env[name];
process.env.DDG_MIN_INTERVAL_MS = '0';
process.env.EXA_API_KEY = 'exa-test-key';
process.env.FIRECRAWL_API_KEY = 'fc-test-key';
// The cloud computer is configured, so the prompt carries its lines and the tool can be driven.
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.ALLOW_PRIVATE_FETCH = 'true';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// The hidden list (plan, Global Constraints): search and page engines, the cloud computer's
// platforms, hosting, storage and database, mail, maps, routing. Word-bounded, any case.
const VENDORS = /\b(?:exa|firecrawl|tavily|brave(?: search)?|duckduckgo|jina|serper|searxng|bing|e2b|vercel|supabase|neon|pglite|postgres(?:ql)?|cloudflare|r2|resend|smtp|overpass|nominatim|osm|openstreetmap|osrm|openrouter|orcarouter|openverse)\b/gi;
// How the machinery works, which a result's own words never need to say (scan 6).
const MECHANISM = /\b(?:merg(?:e|ed|es|ing)|fallbacks?|fall(?:s|ing)? back|engines?|retr(?:y|ies|ied|ying)|stand-?in|grounding|key pools?|credits?|quotas?)\b/gi;
// A deployment setting by name: how Ephapse is built.
const SETTING = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g;

const hits = (text, pattern) => [...String(text).matchAll(pattern)].map((m) => `"${m[0]}" in …${String(text).slice(Math.max(0, m.index - 50), m.index + 40).replace(/\s+/g, ' ')}…`);

/** What Ephapse wrote: the content with every third-party field taken out, longest first. */
const ours = (content, thirdParty = []) =>
  [...thirdParty].filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, field) => text.split(field).join(' ⟨3p⟩ '), String(content ?? ''));

const { initStore } = await import('../server/store/index.js');
const { PGlite } = await import('@electric-sql/pglite');
const db = await PGlite.create();
await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
const store = (await import('../server/store/index.js')).getStore();
const USER = 'u-conf';
await store.createUser({ id: USER, email: 'conf@example.com', passwordHash: 'x', name: 'Lan', role: 'user' });
const user = { id: USER, email: 'conf@example.com', name: 'Lan' };

const { TOOLS, availableTools } = await import('../server/tools/definitions.js');
const { botTools } = await import('../server/bots/tools.js');
const { buildSystemPrompt } = await import('../server/agent.js');
const { BUILTIN_SKILLS } = await import('../server/skills/builtin.js');
const { executeTool } = await import('../server/tools/execute.js');
const { clearSearchCache, clearEngineTrouble, search, formatResults } = await import('../server/search.js');
const { setPrefs, setApiKey } = await import('../server/settings.js');
const pool = await import('../server/keyPool.js');
const firecrawl = await import('../server/firecrawl.js');

// Identifiers a result may name because the model acts on them: a tool, or one of its parameters.
const ACTIONABLE = new Set(TOOLS.flatMap((t) => [t.name, ...Object.keys(t.parameters?.properties || {})]));
const strayIds = (text) => [...new Set([...String(text).matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]))].filter((id) => !ACTIONABLE.has(id));

/** Every check scan 4 and scan 6 make of one model-facing result. */
function scanResult(label, result, thirdParty = [], { mechanism = true } = {}) {
  const text = typeof result === 'string' ? result : String(result?.content ?? '');
  const mine = ours(text, thirdParty);
  const named = hits(mine, VENDORS);
  check(`${label}: names no service behind the tool`, named.length === 0, named.slice(0, 3).join(' | ') || text.slice(0, 100).replace(/\s+/g, ' '));
  if (!mechanism) return;
  const how = hits(mine, MECHANISM);
  const settings = hits(mine, SETTING);
  const ids = strayIds(mine);
  check(`${label}:   and says what to do, not how it works inside`, !how.length && !settings.length && !ids.length, [...how, ...settings, ...ids].slice(0, 3).join(' | '));
}

/* ── scan 1: the catalogue ─────────────────────────────────────────────── */
section('1. every tool and parameter description, deferred tools and a bot\'s included');
{
  const described = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') described.push([path, value]);
      else walk(value, `${path}.${key}`);
    }
  };
  for (const tool of TOOLS) walk({ description: tool.description, parameters: tool.parameters }, tool.name);
  for (const tool of botTools({ is_main: true }, { inGroup: true, openWaits: 1 })) walk({ description: tool.description, parameters: tool.parameters }, `bot:${tool.name}`);
  // What availableTools hands a model, everything activated: its words may differ from the table's.
  const offered = availableTools({ workerOnline: true, desktopOnline: true, policy: 'guarded', connected: ['google', 'github', 'notion', 'slack', 'telegram', 'meta', 'supadata', 'firecrawl'], providers: ['openai', 'google'], context: 200_000, activated: new Set(TOOLS.map((t) => t.name)) });
  for (const tool of offered) walk({ description: tool.description, parameters: tool.parameters }, `offered:${tool.name}`);
  check('the scan reads the whole catalogue', TOOLS.length > 100 && described.length > 400, `${TOOLS.length} tools, ${described.length} descriptions`);
  const named = described.flatMap(([path, text]) => hits(text, VENDORS).map((h) => `${path}: ${h}`));
  check('no description names a service behind a tool', named.length === 0, named.slice(0, 4).join(' | '));
  const limits = described.flatMap(([path, text]) => hits(text, /\b(?:allowance|credits?|quotas?|free month|43 million)\b/gi).map((h) => `${path}: ${h}`));
  check('  nor its allowance, credits or the size of a provider\'s index', limits.length === 0, limits.slice(0, 4).join(' | '));
}

/* ── scan 2 and 5: the system prompt ───────────────────────────────────── */
const everyPart = (overrides) => buildSystemPrompt({
  workerOnline: true,
  worker: { info: { platform: 'linux', workspace: '/home/u/work', shell: 'bash', desktop: true, fullDisk: false } },
  policy: 'guarded',
  extra: 'Answer briefly.',
  skills: '- docx: Writing a Word document',
  connectors: 'Gmail, Google Drive',
  project: '## Project\nExam rules.',
  mcpServers: [{ id: 'figma', tools: 3 }, { id: 'broken', error: 'it did not start' }],
  memory: '## Memory\n- **tone**: plain',
  recall: true,
  connectorSearch: true,
  ...overrides,
});
const prompts = {
  en: everyPart({ timezone: 'Europe/London' }),
  vi: everyPart({ timezone: 'Asia/Ho_Chi_Minh', bot: { intro: 'Bạn là Trợ lý, trợ lý của Lan.', section: '## Vai trò\nTrợ lý chung.' } }),
  'en, nothing optional': buildSystemPrompt({ workerOnline: false, policy: 'plan' }),
};

section('2. the system prompt, every optional section on, for an English and a Vietnamese account');
for (const [language, prompt] of Object.entries(prompts)) {
  const named = hits(prompt, VENDORS);
  check(`${language}: names no service behind a tool`, named.length === 0, named.slice(0, 3).join(' | '));
}

section('5. the confidentiality section is in the prompt, in both');
for (const [language, prompt] of Object.entries(prompts)) {
  const part = /## What is behind your tools\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] || '';
  check(`${language}: it is there`, part.length > 0, prompt.length ? '' : 'no prompt');
  check(`${language}:   no details of the services behind the tools, so none is guessed or named`, /do not have details of the services[^.]*behind your tools/i.test(part) && /never guess or name/i.test(part), part.slice(0, 120));
  check(`${language}:   tool names, parameters, result formats and how a tool works inside stay unsaid`, /tool names/i.test(part) && /parameters/i.test(part) && /result formats/i.test(part) && /how a tool works inside/i.test(part), part.slice(0, 200));
  check(`${language}:   limits, prices and keys too, and how Ephapse is built`, /limits/i.test(part) && /prices/i.test(part) && /keys/i.test(part) && /how Ephapse is built/i.test(part));
  check(`${language}:   abilities are said in general words, never by tool name or mechanism`, /general words/i.test(part) && /never by tool name or mechanism/i.test(part));
  check(`${language}:   and the public pages are where to point`, /privacy policy/i.test(part) && /\/privacy\.html/.test(part) && /\/terms\.html/.test(part) && /\/about\.html/.test(part));
}

/* ── scan 3: the built-in skills ───────────────────────────────────────── */
section('3. every built-in skill');
{
  const named = BUILTIN_SKILLS.flatMap((skill) =>
    ['name', 'description', 'instructions'].flatMap((field) => {
      const value = Array.isArray(skill[field]) ? skill[field].join('\n') : String(skill[field] ?? '');
      return hits(value, VENDORS).map((h) => `${skill.id}.${field}: ${h}`);
    }));
  check('the scan reads every skill', BUILTIN_SKILLS.length >= 10, String(BUILTIN_SKILLS.length));
  check('no skill names a service behind a tool', named.length === 0, named.slice(0, 4).join(' | '));
}

/* ── scan 4 and 6: the tools themselves ────────────────────────────────── */

// The third-party fields, each naming the vendors on purpose.
const PAGE_WORDS = 'Exa and Firecrawl are both reviewed on this page, with their prices.';
const PAGE_TITLE = 'Exa vs Firecrawl review';
const REFUSED_WORDS = 'What Exa read of the page that refused a robot.';
const SCRAPED_WORDS = 'What Firecrawl read of the page drawn by script.';
const site = http
  .createServer((req, res) => {
    if (req.url === '/blocked') return res.writeHead(403).end('no robots');
    if (req.url === '/thin') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body><div id="app"></div><script>render()</script></body></html>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>${PAGE_TITLE}</title></head><body><article><p>${`${PAGE_WORDS} `.repeat(5)}</p></article></body></html>`);
  })
  .listen(0);
await new Promise((resolve) => site.once('listening', resolve));
const base = `http://127.0.0.1:${site.address().port}`;

const exaHit = { title: 'Exa search, reviewed', url: `${base}/exa-review`, snippet: 'Exa ranks pages by meaning.' };
const firecrawlHit = { title: 'Firecrawl pricing explained', url: `${base}/firecrawl-pricing`, snippet: 'Firecrawl charges credits per page.' };
const bothHit = { title: 'Exa or Firecrawl for agents', url: `${base}/both`, snippet: 'Firecrawl and Exa compared side by side.' };
const EXA_SUMMARY = 'Exa summary: Firecrawl and Exa are both search services.';
const SEARCH_THIRD_PARTY = [...[exaHit, firecrawlHit, bothHit].flatMap((h) => [h.title, h.url, h.snippet]), EXA_SUMMARY, PAGE_WORDS, PAGE_TITLE, base];

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const realFetch = globalThis.fetch;
let web = {};
const calls = [];
/** A different web each time: `plan` maps a fragment of an address to what it answers. */
// And a fresh month: a key a section's stub refused is back in use, and nothing is counted yet.
const stubWeb = async (plan) => {
  web = plan;
  calls.length = 0;
  clearSearchCache();
  clearEngineTrouble();
  firecrawl.resetFirecrawlState();
  pool.__testing.forgetAsks();
  await Promise.all(['exa', 'firecrawl'].map((service) => pool.markKey(service, 'env', 'ok')));
  await db.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:%'");
};
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  if (url.startsWith(base)) return realFetch(input, init);
  for (const [fragment, respond] of Object.entries(web)) if (url.includes(fragment)) return respond(url, init);
  if (url.includes('api.firecrawl.dev/v2/team/credit-usage')) return json({ success: true, data: { remainingCredits: 1000, planCredits: 1000, billingPeriodEnd: null } });
  if (url.includes('api.stackexchange.com')) return json({ items: [], quota_remaining: 100 });
  throw new Error(`nothing stubbed for ${url}`);
};

const exaAnswers = () => json({ results: [{ title: exaHit.title, url: exaHit.url, highlights: [exaHit.snippet] }, { title: bothHit.title, url: bothHit.url, highlights: [bothHit.snippet] }], output: { content: EXA_SUMMARY } });
const firecrawlAnswers = () => json({ success: true, creditsUsed: 2, data: { web: [{ title: firecrawlHit.title, url: firecrawlHit.url, description: firecrawlHit.snippet }, { title: bothHit.title, url: bothHit.url, description: bothHit.snippet }] } });
const run = (name, input, extra = {}) => executeTool({ user, name, input, chatId: null, ...extra });

section('4. web_search: both searches answering, merged');
{
  await setPrefs(USER, { effort: 'xhigh' });
  await stubWeb({ 'api.exa.ai/search': exaAnswers, 'api.firecrawl.dev/v2/search': firecrawlAnswers });
  const out = await run('web_search', { query: 'agent search services' });
  check('it answered, from both', !out.isError && calls.some((u) => u.includes('api.exa.ai')) && calls.some((u) => u.includes('firecrawl.dev/v2/search')), out.content.slice(0, 120));
  scanResult('both answering', out, SEARCH_THIRD_PARTY);
  check('  third-party titles, snippets and addresses that say Exa and Firecrawl reach the model as written', [exaHit, firecrawlHit, bothHit].every((h) => out.content.includes(h.title) && out.content.includes(h.url) && out.content.includes(h.snippet)), out.content.slice(0, 200));
  check('  and so do the summary and the pages read', out.content.includes(EXA_SUMMARY) && out.content.includes(PAGE_WORDS));
  check('  no engine named for the model, not even Google', !/\b(?:google|gemini)\b/i.test(ours(out.content, SEARCH_THIRD_PARTY)), ours(out.content, SEARCH_THIRD_PARTY).slice(0, 160));
  await setPrefs(USER, { effort: 'high' });
}

section('4. web_search: one failing');
{
  await stubWeb({ 'api.exa.ai/search': () => json({ error: { detail: 'Exa: insufficient credits for this key' } }, 402), 'api.firecrawl.dev/v2/search': firecrawlAnswers });
  const out = await run('web_search', { query: 'agent search services', depth: 'quick' });
  check('the second answered', !out.isError && out.content.includes(firecrawlHit.title), out.content.slice(0, 120));
  scanResult('one failing', out, SEARCH_THIRD_PARTY);
}

section('4. web_search: every search failing, and rate limited');
{
  await stubWeb({
    'api.exa.ai/search': () => json({ error: 'Exa rate limit: 5 requests per second on this key' }, 429),
    'api.firecrawl.dev/v2/search': () => json({ success: false, error: 'Firecrawl: Payment Required — insufficient credits' }, 402),
    'duckduckgo.com': () => new Response('<html>unusual traffic from your network — blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  });
  const out = await run('web_search', { query: 'agent search services', depth: 'quick' });
  check('nothing came back, and it says so', !out.isError && /^No results for "agent search services"/.test(out.content), out.content.slice(0, 160));
  scanResult('every search failing', out, SEARCH_THIRD_PARTY);
  check('  the vendors\' own words never reach the model', !/insufficient credits|rate limit:|unusual traffic|HTTP 4\d\d/i.test(out.content), out.content);
  check('  and it says what to do', /try again/i.test(out.content), out.content);
  const { searchFailure } = await import('../public/js/rail.js');
  check('  the transcript still tells it from a real zero', !!searchFailure(out.content) && searchFailure(out.content) !== 'nothing', String(searchFailure(out.content)));

  // Every search answering with nothing. (The keyless one reads an empty page as a failure, as it always has.)
  process.env.SEARCH_ORDER = 'exa,firecrawl';
  await stubWeb({ 'api.exa.ai/search': () => json({ results: [] }), 'api.firecrawl.dev/v2/search': () => json({ success: true, data: { web: [] } }) });
  const zero = await run('web_search', { query: 'nothing anywhere', depth: 'quick' });
  delete process.env.SEARCH_ORDER;
  scanResult('every search finding nothing', zero);
  check('  a real zero is still a real zero on screen', searchFailure(zero.content) === null, zero.content);
}

section('4. a search whose allowance is used');
{
  process.env.SEARCH_ORDER = 'exa,firecrawl';
  await stubWeb({});
  const found = await search('agent search services', { userId: USER, noMetered: true });
  const out = formatResults('agent search services', found);
  check('nothing was asked of anyone', calls.filter((u) => !u.startsWith(base)).every((u) => u.includes('credit-usage')) && !found.results.length && found.aside, calls.join(' '));
  scanResult('allowance used', out);
  check('  it says the allowance is used and to try later', /allowance/i.test(out) && /try again later/i.test(out), out);
  const { searchFailure } = await import('../public/js/rail.js');
  check('  and the transcript reads it as nothing having run', searchFailure(out) === 'nothing', String(searchFailure(out)));

  process.env.SEARCH_ORDER = 'tavily';
  const none = await run('web_search', { query: 'x' });
  check('no search set up at all is an error', none.isError, none.content);
  scanResult('no search set up', none);
  delete process.env.SEARCH_ORDER;
}

section('4. web_fetch: a page that refuses this server, read another way');
{
  await stubWeb({ 'api.exa.ai/contents': () => json({ results: [{ title: 'Blocked', url: `${base}/blocked`, text: `${REFUSED_WORDS} `.repeat(12) }] }) });
  const viaExa = await run('web_fetch', { url: `${base}/blocked` });
  check('the refused page was read', !viaExa.isError && viaExa.content.includes(REFUSED_WORDS) && calls.some((u) => u.includes('api.exa.ai/contents')), viaExa.content.slice(0, 160));
  scanResult('a refused page read', viaExa, [REFUSED_WORDS, base]);

  await stubWeb({
    'api.exa.ai/contents': () => json({ results: [] }),
    'api.firecrawl.dev/v2/scrape': () => json({ success: true, data: { markdown: `${SCRAPED_WORDS} `.repeat(12), metadata: { statusCode: 200, title: 'Thin', url: `${base}/thin` } } }),
  });
  const viaBrowser = await run('web_fetch', { url: `${base}/thin` });
  check('a page drawn by script was read', !viaBrowser.isError && viaBrowser.content.includes(SCRAPED_WORDS) && calls.some((u) => u.includes('firecrawl.dev/v2/scrape')), viaBrowser.content.slice(0, 160));
  scanResult('a script page read', viaBrowser, [SCRAPED_WORDS, base]);
}

section('4. code_context');
{
  await stubWeb({ 'api.exa.ai/search': () => json({ results: [{ title: 'Exa SDK example', url: 'https://github.com/exa-labs/exa-js', highlights: ['const exa = new Exa(key); // Firecrawl too'] }] }) });
  const fromExa = await run('code_context', { query: 'call a search api from node' });
  check('it found code', !fromExa.isError && /new Exa\(key\)/.test(fromExa.content), fromExa.content.slice(0, 160));
  scanResult('code from the first source', fromExa, ['Exa SDK example', 'https://github.com/exa-labs/exa-js', 'const exa = new Exa(key); // Firecrawl too', 'github.com']);

  await stubWeb({
    'api.exa.ai/search': () => json({ results: [] }),
    'api.firecrawl.dev/v2/search/developer': () => json({ success: true, results: [{ id: 'issue:9', url: 'https://github.com/firecrawl/firecrawl/issues/9', title: 'Firecrawl parser bug', passages: [{ text: 'Use `parse(x, { strict: true })` with Exa.' }] }] }),
  });
  const fromIndex = await run('code_context', { query: 'parse strict mode' });
  check('the developer index answered', !fromIndex.isError && /strict: true/.test(fromIndex.content), fromIndex.content.slice(0, 160));
  scanResult('code from the developer index', fromIndex, ['https://github.com/firecrawl/firecrawl/issues/9', 'Firecrawl parser bug', 'Use `parse(x, { strict: true })` with Exa.']);
}

section('4. research_index and site_pages');
{
  await stubWeb({ 'api.firecrawl.dev/v2/search/research/papers': () => json({ success: true, results: [{ paperId: 'p1', primaryId: 'arxiv:2401.00001', title: 'Exa-scale retrieval', abstract: 'We compare Firecrawl and Exa.', authors: ['An Nguyen'], createdDate: '2024-01-02T00:00:00Z' }] }) });
  const papers = await run('research_index', { op: 'papers', query: 'retrieval' });
  check('papers found', !papers.isError && /Exa-scale retrieval/.test(papers.content), papers.content.slice(0, 120));
  scanResult('papers', papers, ['Exa-scale retrieval', 'We compare Firecrawl and Exa.']);

  await stubWeb({ 'api.firecrawl.dev/v2/search/gov': () => json({ success: true, data: { web: [{ url: 'https://law.example.gov/1', title: 'Section 1', description: 'Text.' }] } }) });
  const law = await run('research_index', { op: 'law', query: 'civil rights', jurisdiction: 'us' });
  scanResult('law', law, ['https://law.example.gov/1', 'Section 1']);

  await stubWeb({ 'api.firecrawl.dev/v2/search/research': () => json({ success: false, error: 'Firecrawl internal error: upstream index unavailable (request id fc-123)' }, 500) });
  const broke = await run('research_index', { op: 'papers', query: 'retrieval' });
  check('a failing index is an error the model can read', broke.isError || /not available|did not work|try again/i.test(broke.content), broke.content);
  scanResult('a failing index', broke);
  check('  without the service\'s own words', !/upstream index|request id/i.test(broke.content), broke.content);

  await stubWeb({ 'api.firecrawl.dev/v2/map': () => json({ success: false, error: 'Firecrawl: Payment Required — insufficient credits' }, 402) });
  const mapped = await run('site_pages', { op: 'map', url: `${base}/` });
  scanResult('a site map refused', mapped);
  check('  without the service\'s own words', !/payment required|insufficient/i.test(mapped.content), mapped.content);

  delete process.env.FIRECRAWL_API_KEY;
  await (await import('../server/keyPool.js')).warmPools();
  const unset = await run('site_pages', { op: 'map', url: `${base}/` });
  scanResult('site pages with nothing to do it', unset);
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
  await (await import('../server/keyPool.js')).warmPools();
}

section('4. deep_research: what its own models read, and what comes back');
{
  const { runDeepResearch } = await import('../server/research/index.js');
  const seen = [];
  const byRole = async function* ({ system, messages }) {
    seen.push(`${system}\n${JSON.stringify(messages)}`);
    const reply = /planner/i.test(system)
      ? '{"queries":["agent search services"]}'
      : /Proposer/.test(system)
        ? 'They are reviewed [S1].'
        : /Critic/.test(system)
          ? '{"objections":[]}'
          : '{"claims":[{"text":"They are reviewed [S1].","conflicting":false}]}';
    yield { type: 'text', delta: reply };
    yield { type: 'done', usage: { input: 100, output: 50 } };
  };
  await stubWeb({ 'api.exa.ai/search': exaAnswers, 'api.firecrawl.dev/v2/search': firecrawlAnswers });
  const ran = await runDeepResearch({ question: 'Which agent search services exist?', userId: USER, user, chatId: null, deps: { stream: byRole, entry: { provider: 'x' }, readPage: async () => `${PAGE_WORDS} `.repeat(3) } });
  check('it ran and cited a source', /exa-review|both|firecrawl-pricing/.test(ran.content), ran.content.slice(0, 160));
  scanResult('the research report', ran.content, SEARCH_THIRD_PARTY, { mechanism: false });
  const inner = hits(ours(seen.join('\n'), SEARCH_THIRD_PARTY), VENDORS);
  check('  what its own models were given names no service either', inner.length === 0, inner.slice(0, 3).join(' | '));

  seen.length = 0;
  process.env.SEARCH_ORDER = 'tavily';
  const nothing = await runDeepResearch({ question: 'Anything?', userId: USER, user, chatId: null, deps: { stream: byRole, entry: { provider: 'x' } } });
  delete process.env.SEARCH_ORDER;
  const told = hits(seen.join('\n'), VENDORS).concat(hits(seen.join('\n'), SETTING));
  check('  with no search set up, its models are not told which keys to set', told.length === 0, told.slice(0, 3).join(' | '));
  scanResult('a research run with no search', nothing.content, [], { mechanism: false });
}

section('4. place_lookup');
{
  const { __places } = await import('../server/tools/library.js');
  __places.reset({ hedge: 50, each: 500, rest: 0, slowRest: 0 });
  const PLACE = { lat: '10.7769', lon: '106.7009', display_name: 'Chợ Bến Thành, Quận 1, Thành phố Hồ Chí Minh', name: 'Chợ Bến Thành', category: 'amenity', type: 'marketplace', address: {} };
  await stubWeb({
    'nominatim.openstreetmap.org/search': (url) => json(/amenity=|viewbox/.test(url) ? [] : [PLACE]),
    overpass: () => json({ elements: [{ type: 'node', id: 7, lat: 10.777, lon: 106.701, tags: { name: 'Quán Phở Exa', amenity: 'restaurant', cuisine: 'noodle' } }] }),
    'project-osrm.org': () => json({ routes: [{ distance: 1200, duration: 300, geometry: { coordinates: [[106.7, 10.77], [106.71, 10.78]] } }] }),
  });
  const found = await run('place_lookup', { op: 'find', place: 'Chợ Bến Thành' });
  check('a place found', !found.isError && /Chợ Bến Thành/.test(found.content), found.content.slice(0, 120));
  scanResult('a place found', found, ['Chợ Bến Thành, Quận 1, Thành phố Hồ Chí Minh', 'Chợ Bến Thành']);
  const near = await run('place_lookup', { op: 'nearby', what: 'quán ăn', near: 'Chợ Bến Thành' });
  scanResult('places nearby', near, ['Quán Phở Exa', 'Chợ Bến Thành, Quận 1, Thành phố Hồ Chí Minh', 'Chợ Bến Thành']);
  check('  a place named for Exa keeps its name', near.content.includes('Quán Phở Exa'), near.content.slice(0, 160));
  const route = await run('place_lookup', { op: 'distance', from: 'Chợ Bến Thành', to: 'Chợ Bến Thành' });
  scanResult('a route', route, ['Chợ Bến Thành, Quận 1, Thành phố Hồ Chí Minh', 'Chợ Bến Thành']);

  await stubWeb({
    'nominatim.openstreetmap.org/search': (url) => (/viewbox/.test(url) ? json([]) : json([PLACE])),
    overpass: () => json({ remark: 'busy' }, 504),
  });
  __places.reset({ hedge: 50, each: 500, rest: 0, slowRest: 0 });
  const thin = await run('place_lookup', { op: 'nearby', what: 'quán ăn', near: 'Chợ Bến Thành' });
  scanResult('places nearby, the place search not answering', thin, ['Chợ Bến Thành, Quận 1, Thành phố Hồ Chí Minh', 'Chợ Bến Thành']);

  await stubWeb({ 'nominatim.openstreetmap.org/search': () => json({ error: 'nominatim.openstreetmap.org: Too Many Requests' }, 429), overpass: () => json({}, 504) });
  __places.reset({ hedge: 50, each: 500, rest: 0, slowRest: 0 });
  const busy = await run('place_lookup', { op: 'find', place: 'Busy Tower' });
  check('a map service that refused is an error, and the place may well exist', busy.isError && !/No place called/.test(busy.content), busy.content);
  scanResult('the map service refusing', busy, ['Busy Tower']);
  __places.reset();
}

section('4. generate_image: its errors');
{
  const missing = await run('generate_image', { prompt: 'a cat on a roof' });
  check('no key is an error', missing.isError, missing.content);
  scanResult('no key for pictures', missing, [], { mechanism: false });
  check('  and it names no provider the user did not set up', !/\bopenrouter\b/i.test(missing.content), missing.content);

  await setApiKey(USER, 'google', 'AIzaConfidentialTestKey0000000000000000');
  await stubWeb({ 'generativelanguage.googleapis.com': () => json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key. [googleapis.com/generativelanguage]', status: 'INVALID_ARGUMENT' } }, 400) });
  const refused = await run('generate_image', { prompt: 'a cat on a roof' });
  check('the picture service refusing is an error', refused.isError, refused.content.slice(0, 160));
  scanResult('the picture service refusing', refused);
  check('  without the service\'s own words', !/API key not valid|INVALID_ARGUMENT|googleapis/i.test(refused.content), refused.content);
}

section('4. the cloud computer and the cloud browser, failing to start');
{
  const e2b = await import('../server/e2b.js');
  const sandbox = await import('../server/sandbox.js');
  const named = (name, message, extra = {}) => Object.assign(new Error(message), { name }, extra);
  let createError = null;
  const sdk = {
    Sandbox: {
      create: async () => {
        throw createError;
      },
      connect: async (id) => {
        throw named('SandboxNotFoundError', `404: sandbox ${id} not found`, { statusCode: 404 });
      },
      list: () => ({ hasNext: false, nextItems: async () => [] }),
      kill: async () => {},
    },
  };
  e2b.__testing.useSdk(sdk);
  const tried = [
    ['a key refused', named('AuthenticationError', 'Unauthorized, please check your E2B credentials.')],
    ['all machines busy', named('RateLimitError', 'Rate limit exceeded - concurrent sandbox quota on e2b.dev', { statusCode: 429 })],
    ['the platform down', named('ServiceBusyError', 'E2B service temporarily unavailable', { statusCode: 503 })],
    ['credit spent', named('SandboxError', '403: Your E2B team has run out of credits', { statusCode: 403 })],
    ['the library not loading', new e2b.E2BSdkError(new Error('require() of ES Module /var/task/node_modules/e2b/x.js not supported'))],
    ['anything else from the platform', named('SandboxError', 'template synapsez-computer is not built in this e2b.dev team')],
  ];
  const freeShares = await import('../server/freeShares.js');
  for (const [label, error] of tried) {
    createError = error;
    sandbox.__testing.clearE2bAside();
    // The credit case closes the month; each case starts in a fresh one.
    await db.query("DELETE FROM rate_limits WHERE bucket LIKE 'free:e2b%'");
    await db.query("DELETE FROM settings WHERE key LIKE 'free_shares:%'");
    freeShares.__testing.forget();
    const out = await run('sandbox_run', { command: 'echo hi' });
    check(`${label}: an error`, out.isError, out.content.slice(0, 120));
    scanResult(`sandbox_run, ${label}`, out);
    const browsing = await run('cloud_browser', { action: 'open', url: 'https://example.com' });
    scanResult(`cloud_browser, ${label}`, browsing);
  }
  sandbox.__testing.clearE2bAside();
  e2b.__testing.useSdk(null);
}

section('4. send_email');
{
  const email = await import('../server/email.js');
  const none = await run('send_email', { subject: 'Hi', body: 'Hello' });
  check('with no mail provider it is NOT sent, and says so', none.isError && /NOT sent/.test(none.content), none.content);
  scanResult('no mail provider', none);
  check('  naming no mail service or mailbox', !/gmail/i.test(none.content), none.content);

  process.env.GMAIL_USER = 'deployment.mailbox@gmail.com';
  process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  let refuse = 'Invalid login: 535-5.7.8 Username and Password not accepted. For more information, go to https://support.google.com/mail/?p=BadCredentials gsmtp';
  email.__testing.useTransport({
    async sendMail() {
      if (refuse) throw new Error(refuse);
      return { messageId: '<abc123@mail.gmail.com>', accepted: ['conf@example.com'], rejected: [], response: '250 2.0.0 OK  1700000000 x1-20020a.123 - gsmtp' };
    },
  });
  const refused = await run('send_email', { subject: 'Hi', body: 'Hello' });
  check('a refusal is NOT sent', refused.isError && /NOT sent/.test(refused.content), refused.content);
  scanResult('the mail service refusing', refused);
  check('  without the service\'s own words', !/535|gsmtp|google|gmail/i.test(refused.content), refused.content);
  refuse = null;
  const sent = await run('send_email', { subject: 'Báo cáo', body: 'Nội dung' });
  check('accepted', !sent.isError && /accepted an email/.test(sent.content), sent.content);
  scanResult('an email accepted', sent, ['conf@example.com']);
  check('  without the mail server\'s reply or its address', !/gsmtp|gmail|250 2\.0\.0/i.test(sent.content), sent.content);
  email.__testing.useTransport(null);
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
}

site.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
