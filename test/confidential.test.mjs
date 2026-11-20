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
//   6. a result's own words say what to do, never how the machinery works;
//   7. every sentence written in server/**, read statically, outside an explicit allow-list
//      where each entry says why (fix round 1: a guard for the class, not its instances).
//
//   node test/confidential.test.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
// platforms, hosting, storage and database, mail, maps, routing, the OCR engine.
//   - lower case bounded by no letter or digit on either side, so `firecrawl_scrape`, `exa_search`
//     and `get_code_context_exa` are caught and "example" is not;
//   - capitalised and mixed forms bounded only after, so camelCase `searchExa` is caught;
//   - upper case bounded by no capital or digit, so `EXA_API_KEY` is caught.
// Brands that are also English words (resend, brave, neon, bing) are matched only as the brand —
// capitalised and not used as a verb, upper case, or the service's own address — so "resend the
// list" and "a brave guess" are plain English, and "Resend returned 422" is not.
const BRANDS = ['exa', 'firecrawl', 'tavily', 'duckduckgo', 'jina', 'serper', 'searxng', 'e2b', 'vercel', 'supabase', 'pglite', 'postgres', 'postgresql', 'cloudflare', 'smtp', 'overpass', 'nominatim', 'osm', 'openstreetmap', 'osrm', 'openrouter', 'orcarouter', 'openverse', 'tesseract'];
const MIXED = ['DuckDuckGo', 'SearXNG', 'PGlite', 'PostgreSQL', 'OpenStreetMap', 'OpenRouter', 'OrcaRouter'];
const ENGLISH_BRANDS = [
  '(?<![A-Za-z0-9])Resend(?![a-z0-9])(?! (?:the|it|them|a|an|this|that|these|those|every|all|your|my|again)\\b)', 'resend\\.(?:com|dev)',
  '(?<![A-Za-z0-9])Brave(?![a-z0-9])', 'brave\\.com',
  '(?<![A-Za-z0-9])Neon(?![a-z0-9])', 'neon\\.tech',
  '(?<![A-Za-z0-9])Bing(?![a-z0-9])', 'bing\\.com',
  'Cloudflare R2', '(?<![A-Za-z0-9])R2 (?:bucket|storage)',
];
const VENDORS = new RegExp(
  [
    ...BRANDS.map((b) => `(?<![a-z0-9])${b}(?![a-z0-9])`),
    ...BRANDS.map((b) => `${b[0].toUpperCase()}${b.slice(1)}(?![a-z0-9])`),
    ...[...BRANDS, 'resend', 'brave', 'neon'].map((b) => `(?<![A-Z0-9])${b.toUpperCase()}(?![A-Z0-9])`),
    ...MIXED.map((m) => `${m}(?![a-z0-9])`),
    ...ENGLISH_BRANDS,
  ].join('|'),
  'g',
);
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
  // With nothing activated: the deferred index load_tools carries, one line per tool or family.
  const first = availableTools({ workerOnline: true, desktopOnline: true, policy: 'guarded', connected: ['google', 'github', 'notion', 'slack', 'telegram', 'meta', 'supadata', 'firecrawl'], providers: ['openai', 'google'], context: 200_000, activated: new Set() });
  for (const tool of first) walk({ description: tool.description, parameters: tool.parameters }, `first:${tool.name}`);
  check('the scan reads the whole catalogue, and the deferred index', TOOLS.length > 100 && described.length > 400 && first.some((t) => t.name === 'load_tools'), `${TOOLS.length} tools, ${described.length} descriptions`);
  const named = described.flatMap(([path, text]) => hits(text, VENDORS).map((h) => `${path}: ${h}`));
  check('no description names a service behind a tool', named.length === 0, named.slice(0, 4).join(' | '));
  const limits = described.flatMap(([path, text]) => hits(text, /\b(?:allowance|credits?|quotas?|free month|43 million)\b/gi).map((h) => `${path}: ${h}`));
  check('  nor its allowance, credits or the size of a provider\'s index', limits.length === 0, limits.slice(0, 4).join(' | '));
  // Tool names and parameter keys, at any depth, and the values a parameter may take: a model reads
  // them all. A name that kept a vendor word would be listed here for the owner's decision, not renamed.
  const ids = [];
  const keysOf = (node, at) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (at.endsWith('.properties')) ids.push(`${at}.${key}`);
      if (key === 'enum' && Array.isArray(value)) value.forEach((v) => ids.push(`${at}.enum:${v}`));
      keysOf(value, `${at}.${key}`);
    }
  };
  for (const tool of [...TOOLS, ...first, ...botTools({ is_main: true }, { inGroup: true, openWaits: 1 })]) {
    ids.push(tool.name);
    keysOf(tool.parameters, tool.name);
  }
  const vendorIds = ids.filter((id) => hits(id.split('.').pop(), VENDORS).length);
  check('no tool name, parameter key or parameter value names a service', vendorIds.length === 0, vendorIds.slice(0, 6).join(' | '));
}

/* ── scan 2 and 5: the system prompt ───────────────────────────────────── */
// A broken stdio server's line carries the real sentence connectMcp gives, both ways it can fail here.
const { connectMcp } = await import('../server/mcp/client.js');
const stdioError = async (vercel) => {
  if (vercel) process.env.VERCEL = '1';
  try {
    await connectMcp({ transport: 'stdio', place: 'local', command: 'node', args: ['server.js'] });
    return 'it started';
  } catch (err) {
    return String(err?.message || err);
  } finally {
    delete process.env.VERCEL;
  }
};
const BROKEN = [{ id: 'figma', tools: 3 }, { id: 'local-files', error: await stdioError(false) }, { id: 'local-db', error: await stdioError(true) }];
const everyPart = (overrides) => buildSystemPrompt({
  workerOnline: true,
  worker: { info: { platform: 'linux', workspace: '/home/u/work', shell: 'bash', desktop: true, fullDisk: false } },
  policy: 'guarded',
  extra: 'Answer briefly.',
  skills: '- docx: Writing a Word document',
  connectors: 'Gmail, Google Drive',
  project: '## Project\nExam rules.',
  mcpServers: BROKEN,
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
check("the broken servers' lines are the real sentences", BROKEN.slice(1).every((s) => /stdio MCP servers/.test(s.error)), BROKEN.map((s) => s.error).join(' | '));
for (const [language, prompt] of Object.entries(prompts)) {
  const named = hits(prompt, VENDORS);
  check(`${language}: names no service behind a tool`, named.length === 0, named.slice(0, 3).join(' | '));
  const settings = hits(prompt, SETTING);
  check(`${language}:   nor a deployment setting`, settings.length === 0, settings.slice(0, 3).join(' | '));
}

section('5. the confidentiality section is in the prompt, in both');
for (const [language, prompt] of Object.entries(prompts)) {
  const part = /## What is behind your tools\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] || '';
  check(`${language}: it is there`, part.length > 0, prompt.length ? '' : 'no prompt');
  check(`${language}:   no details of the services behind the tools, so none is guessed or named`, /do not have details of the services[^.]*behind your tools/i.test(part) && /never guess or name/i.test(part), part.slice(0, 120));
  check(`${language}:   tool names, parameters, result formats and how a tool works inside stay unsaid`, /tool names/i.test(part) && /parameters/i.test(part) && /result formats/i.test(part) && /how a tool works inside/i.test(part), part.slice(0, 200));
  // M1: internal limits and what the services cost, not "limits, prices" — the person's own caps and plan prices are theirs to ask about.
  check(`${language}:   internal limits, what the services behind the tools cost and keys too, and how Ephapse is built`, /internal limits/i.test(part) && /what the services behind (?:the|your) tools cost/i.test(part) && !/limits, prices/i.test(part) && /keys/i.test(part) && /how Ephapse is built/i.test(part), part.slice(0, 260));
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
    ['anything else from the platform', named('SandboxError', 'template office-machine is not built in this e2b.dev team')],
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

/* ── fix round 1: the paths the first suite skipped ──────────────────────── */

// A provider's own refusal, as streamCompletion words it: the deployment's key, its monthly limit.
const PROVIDER_REFUSAL = "OpenRouter: every key was refused (the deployment key is over this account's monthly limit).";
const refuses = async function* () {
  yield* [];
  throw Object.assign(new Error(PROVIDER_REFUSAL), { status: 429 });
};
// Internals a model must not be handed, beyond the vendor names: the deployment's key, its
// quotas, a relay, a socket's or an HTTP status code, a source failing over to another.
const INTERNALS = /deployment key|monthly limit|key pool|every key|quota|relay|Singapore|HTTP \d{3}|switched (?:off|on)|answered by|trả lời bằng|không trả lời|left alone|shared allowance/i;
// In their own case: a socket's code (ECONNREFUSED, ETIMEDOUT…), and one source failing over to
// another ("VNDIRECT failed: …") — not a tool's own "convert_units failed:" or a sub-agent's "Failed:".
const SOCKET = /(?<![A-Za-z0-9])E(?:CONN[A-Z]*|TIMEDOUT|NOTFOUND|AI_[A-Z]+|HOSTUNREACH|NETUNREACH|PIPE|ADDR[A-Z]*)(?![A-Za-z0-9])|(?<![A-Za-z0-9_])[A-Z][A-Za-z]+ failed: /;
const scanInternals = (label, text) => {
  const said = String(text);
  check(`${label}:   and none of its internals`, !INTERNALS.test(said) && !SOCKET.test(said), (said.match(INTERNALS) || said.match(SOCKET))?.[0] || '');
};

section('4. market_data: a source failing, and every source failing');
{
  const financeCache = await import('../server/finance/cache.js');
  const financeHttp = await import('../server/finance/http.js');
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'finance', name), 'utf8'));
  const freshFinance = async () => {
    financeHttp.__resetHttp();
    financeCache.__resetCache();
    await db.query('DELETE FROM finance_cache').catch(() => {});
  };
  const refusedSocket = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await freshFinance();
  await stubWeb({
    stock_prices: () => json({ error: 'down' }, 503),
    '/stocks/FPT/data_day': () => json(fixture('kbs-day.json')),
    'getByGroup?group=HOSE': () => json([{ symbol: 'FPT' }]),
    getByGroup: () => json([]),
  });
  const fell = await run('market_data', { kind: 'quote', market: 'vn', symbols: ['FPT'] });
  check('the second source answered', !fell.isError && /FPT/.test(fell.content) && /KBS/.test(fell.content), fell.content.slice(0, 200));
  scanResult('a quote after one source failed', fell, [], { mechanism: false });
  scanInternals('a quote after one source failed', fell.content);
  check('  the source it came from is still cited', /(?:nguồn|source) KBS/.test(fell.content), fell.content.slice(0, 160));

  await freshFinance();
  process.env.FIN_SOURCE_KBS = 'off';
  await stubWeb({ stock_prices: refusedSocket, yahoo: refusedSocket, getByGroup: () => json([]) });
  const down = await run('market_data', { kind: 'quote', market: 'vn', symbols: ['FPT'] });
  delete process.env.FIN_SOURCE_KBS;
  scanResult('a quote no source could give', down, [], { mechanism: false });
  scanInternals('a quote no source could give', down.content);
  check('  it says what to do', /thử lại|try again/i.test(down.content), down.content.slice(0, 200));
  check('  and names no setting', !hits(down.content, SETTING).length, down.content.slice(0, 200));

  await freshFinance();
  await stubWeb({ frankfurter: refusedSocket, 'ecb.europa.eu': refusedSocket, 'er-api': refusedSocket, yahoo: refusedSocket });
  const money = await run('convert_units', { value: 10, from: 'USD', to: 'EUR' });
  scanResult('a currency with no rate', money, [], { mechanism: false });
  scanInternals('a currency with no rate', money.content);
}

section('4. a picture read for a model that cannot see: look_at, read_file, attachments');
{
  const { see, lendEyes } = await import('../server/vision.js');
  const { readPicture } = await import('../server/tools/execute.js');
  const { saveGenerated, toParts } = await import('../server/attachments.js');
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const saved = await saveGenerated(USER, { name: 'Figure_4.png', mime: 'image/png', data: PNG, chatId: null });
  // Models the person did not pick, borrowed to read for one that cannot see.
  const BORROWED = [
    { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)', provider: 'openrouter', vision: true },
    { id: 'gemini-flash-latest', label: 'Gemini Flash', provider: 'google', vision: true },
  ];
  const BORROWED_NAMES = /Gemma|Gemini|Tesseract|OCR engine/;
  const PICTURE = 'A bar chart of sales by month.';
  const reads = async function* () {
    yield { type: 'text', delta: PICTURE };
    yield { type: 'done', usage: null };
  };
  const noWords = async () => ({ text: '', confidence: 0 });
  const someWords = async () => ({ text: 'SALES 2026', confidence: 90 });
  const eyes = (stream, ocr = noWords) => (args) => see({ ...args, engines: BORROWED, stream, ocr });
  const told = (r) => `${r?.content ?? ''}\n${r?.note ?? ''}`;

  const looked = await CLOUD_IMPLEMENTATIONS.look_at({ file_id: saved.id }, { userId: USER, chatId: null, see: eyes(reads) });
  const lookedText = typeof looked === 'string' ? looked : told(looked);
  check('look_at: read', lookedText.includes(PICTURE), lookedText.slice(0, 160));
  scanResult('look_at, read by a borrowed model', lookedText, [PICTURE], { mechanism: false });
  check('  the borrowed model is not named', !BORROWED_NAMES.test(lookedText), lookedText.match(BORROWED_NAMES)?.[0] || '');

  const lookFailed = await CLOUD_IMPLEMENTATIONS.look_at({ file_id: saved.id }, { userId: USER, chatId: null, see: eyes(refuses) }).then((r) => told(r), (err) => String(err?.message || err));
  scanResult('look_at, nothing could read it', lookFailed, [], { mechanism: false });
  scanInternals('look_at, nothing could read it', lookFailed);
  check('  the borrowed models are not named', !BORROWED_NAMES.test(lookFailed), lookFailed.match(BORROWED_NAMES)?.[0] || '');

  const shown = { isError: false, content: 'Read Figure_4.png (1 KB).', shot: { id: saved.id } };
  const readOk = await readPicture(shown, { userId: USER, chatId: null }, eyes(reads));
  scanResult('read_file on a picture, read', told(readOk), [PICTURE], { mechanism: false });
  check('  its note names no model', !BORROWED_NAMES.test(told(readOk)) && /look_at/.test(told(readOk)), told(readOk).slice(-200));
  const readWords = await readPicture(shown, { userId: USER, chatId: null }, eyes(refuses, someWords));
  scanResult('read_file on a picture, only its words read', told(readWords), ['SALES 2026'], { mechanism: false });
  check('  naming no engine', !BORROWED_NAMES.test(told(readWords)), told(readWords).slice(0, 200));
  const readNone = await readPicture(shown, { userId: USER, chatId: null }, eyes(refuses));
  scanResult('read_file on a picture, nothing could read it', told(readNone), [], { mechanism: false });
  scanInternals('read_file on a picture, nothing could read it', told(readNone));

  const row = (id) => ({ id, kind: 'image', mime: 'image/png', name: 'Receipt.png', data: PNG });
  const message = { attachments: [{ id: 'a1', name: 'Receipt.png', kind: 'image' }] };
  const readRows = new Map([['a1', row('a1')]]);
  await lendEyes({ userId: USER, loaded: readRows, vision: false, documents: true, look: eyes(reads) });
  const readParts = JSON.stringify(toParts(message, readRows, { vision: false }));
  check('an attachment read for the model', readParts.includes(PICTURE), readParts.slice(0, 200));
  scanResult('an attachment read by a borrowed model', readParts, [PICTURE], { mechanism: false });
  check('  naming no model', !BORROWED_NAMES.test(readParts) && !/vision model/.test(readParts), readParts.slice(0, 300));
  const failedRows = new Map([['a1', row('a1')]]);
  await lendEyes({ userId: USER, loaded: failedRows, vision: false, documents: true, look: eyes(refuses) });
  const failedParts = JSON.stringify(toParts(message, failedRows, { vision: false }));
  scanResult('an attachment nothing could read', failedParts, [], { mechanism: false });
  scanInternals('an attachment nothing could read', failedParts);
  check('  naming no model', !BORROWED_NAMES.test(failedParts), failedParts.slice(0, 300));
}

section('4. a model called inside a tool failing: extract, run_parallel, deep research');
{
  const { extractFromPage } = await import('../server/tools/extract.js');
  const extracted = await extractFromPage({ url: 'https://shop.example/pricing', what: 'the plans', userId: USER, entry: { id: 'openrouter/some-model', provider: 'openrouter', label: 'Some model' }, stream: refuses, fetchPage: async () => 'Plans: Free, Pro.' }).then((r) => r, (err) => String(err?.message || err));
  scanResult('extract, its reader refused', extracted, [], { mechanism: false });
  scanInternals('extract, its reader refused', extracted);
  check('  and it says what the user can do', /Settings → Providers/.test(extracted), extracted);

  const { runParallel } = await import('../server/subagents.js');
  const fanned = await runParallel({ user, chatId: null, tasks: ['Find the price of gold'], stream: refuses }).then((r) => String(r), (err) => String(err?.message || err));
  scanResult('run_parallel, a sub-agent refused', fanned, ['Find the price of gold'], { mechanism: false });
  scanInternals('run_parallel, a sub-agent refused', fanned);

  const { runDeepResearch } = await import('../server/research/index.js');
  const planner = async function* ({ system }) {
    if (!/planner/i.test(system)) {
      yield* [];
      throw Object.assign(new Error(PROVIDER_REFUSAL), { status: 429 });
    }
    yield { type: 'text', delta: '{"queries":["agent search services"]}' };
    yield { type: 'done', usage: { input: 10, output: 5 } };
  };
  await stubWeb({ 'api.exa.ai/search': exaAnswers, 'api.firecrawl.dev/v2/search': firecrawlAnswers });
  const stopped = await runDeepResearch({ question: 'Which agent search services exist?', userId: USER, user, chatId: null, deps: { stream: planner, entry: { provider: 'x' }, readPage: async () => PAGE_WORDS } });
  const kept = await store.getResearchRun(USER, stopped.runId);
  const transcript = JSON.stringify(kept?.transcript || []);
  scanResult('deep research, its debate refused', `${stopped.content}\n${transcript}`, SEARCH_THIRD_PARTY, { mechanism: false });
  scanInternals('deep research, its debate refused', `${stopped.content}\n${transcript}`);
}

section('4. what the cloud computer tells the model about itself, and the tools it loads');
{
  const sandbox = await import('../server/sandbox.js');
  for (const [label, machine] of [['its own computer', { provider: 'e2b', memMb: 2048, cpu: 2 }], ['a temporary one', { standIn: true, memMb: 2048, cpu: 2 }]]) {
    scanResult(`the note on ${label}`, sandbox.machineNote('/home/user', machine));
  }
  const offered = availableTools({ workerOnline: true, desktopOnline: true, policy: 'guarded', connected: ['google', 'github', 'notion', 'slack', 'telegram', 'meta', 'supadata', 'firecrawl'], providers: ['openai', 'google'], context: 200_000, activated: new Set() });
  const loadable = TOOLS.map((t) => t.name).filter((n) => !offered.some((t) => t.name === n));
  const loaded = await run('load_tools', { names: loadable.slice(0, 40) });
  scanResult('load_tools, every deferred tool asked for', loaded);
}

section('4. failures the model must act on, said so (I3, M6)');
{
  const asked = (status, body) => () => json({ error: { code: status, message: body, status: 'X' } }, status);
  for (const [label, status, body, want] of [
    ['the Google key in Settings refused', 400, 'API key not valid. Please pass a valid API key.', /Settings → Providers → Google Gemini/],
    ['the Google API switched off for that key', 403, 'Generative Language API has not been used in project 1 before or it is disabled.', /Settings → Providers → Google Gemini/],
    ['a request refused as asked', 400, 'User location is not supported for the API use.', /refused as asked/],
  ]) {
    await stubWeb({ 'generativelanguage.googleapis.com': asked(status, body) });
    const out = await run('generate_image', { prompt: 'a cat on a roof' });
    check(`generate_image, ${label}: said so`, out.isError && want.test(out.content), out.content);
    scanResult(`generate_image, ${label}`, out);
    check('  without the service\'s own words', !/not valid|has not been used|location is not supported|Quota exceeded|googleapis/i.test(out.content), out.content);
  }
  // A day's quota is a 429, which the image SDK retries on its own before it gives up — so its
  // reading is checked where it is made, and the tool's answer only for what it must never say.
  const { plainFailure } = await import('../server/tools/plainFailure.js');
  const DAY = "Quota exceeded for quota metric 'generate_content_free_tier_requests' and limit 'GenerateContent request limit per day'. limit: 0";
  const spentDay = plainFailure(Object.assign(new Error(DAY), { name: 'ApiError', status: 429 }), { what: 'make the picture', tool: 'test' }).message;
  check("a day's quota used reads as used, with no retry offered — not as busy", /allowance for this period is used/.test(spentDay) && !/too many requests|try again in a minute|try once more/i.test(spentDay), spentDay);
  const busyMinute = plainFailure(Object.assign(new Error('Resource has been exhausted (e.g. check quota).'), { name: 'ApiError', status: 429 }), { what: 'make the picture', tool: 'test' }).message;
  check('  while a 429 that says nothing of a day is busy', /too many requests at once/.test(busyMinute), busyMinute);
  await stubWeb({ 'generativelanguage.googleapis.com': asked(429, DAY) });
  const quota = await run('generate_image', { prompt: 'a cat on a roof' });
  scanResult("generate_image, a day's quota used", quota);
  check('  without the service\'s own words', !/Quota exceeded|googleapis|generate_content/i.test(quota.content), quota.content);

  await stubWeb({ 'api.firecrawl.dev/v2/crawl': () => json({ success: false, error: 'Bad Request: includePaths[0] is not a valid regular expression' }, 400) });
  const badPaths = await run('site_pages', { op: 'crawl', url: `${base}/`, include_paths: ['blog/[('] });
  check('site_pages with a pattern refused: says to check the arguments, not to retry', /refused as asked/.test(badPaths.content) && /include_paths/.test(badPaths.content) && !/try again in a moment/i.test(badPaths.content), badPaths.content);
  scanResult('site_pages with a pattern refused', badPaths);

  await stubWeb({});
  await (await import('../server/freeTier.js')).exhaust('firecrawl_index');
  const today = await run('research_index', { op: 'papers', query: 'retrieval' });
  check("research_index with today's index searches used: says so, and to try later", /today/i.test(today.content) && /later|tomorrow/i.test(today.content), today.content);
  scanResult("research_index with today's index searches used", today);

  // M2: what the transcript shows the person is the reason, not an instruction to the model.
  await stubWeb({ 'api.exa.ai/search': () => json({ error: 'slow down' }, 429), 'api.firecrawl.dev/v2/search': () => json({ success: false, error: 'slow down' }, 429), 'duckduckgo.com': () => new Response('<html>unusual traffic — blocked</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  const busy = await run('web_search', { query: 'gold price', depth: 'quick' });
  const { searchFailure } = await import('../public/js/rail.js');
  const tooltip = String(searchFailure(busy.content));
  check('the reason the transcript shows is the reason alone', /busy/.test(tooltip) && !/try again|say you could not/i.test(tooltip), tooltip);
}

/* ── scan 7: every sentence written in server/**, statically ──────────────── */
section('7. every sentence written in server/**, outside the explicit allow-lists');
{
  const espree = await import('espree');
  // Whole files that are not text a model reads, each with why.
  const FILES = {
    'server/i18n/vi.js': 'translations of English sentences; each English sentence is scanned where it is written',
    'server/securityHeaders.js': 'HTTP security headers (the hosts a page may load from), not text any model reads',
    'server/store/': 'the database layer: SQL, and setup messages printed to the operator\'s terminal',
    'server/keyIntake.js': 'Settings → Providers: what the person adding their own key is told about it',
    'server/keyPool.js': "the administrators' key-pool page: its services' labels",
    'server/models.js': 'Settings → Models: the person adding a model by its id, on the provider they chose',
    'server/autoPick.js': "the person's own Auto choice, which runs on their OpenRouter key: said to the person, never to a model",
    'server/mcp/catalogue.js': 'MCP servers a person may add for their own systems (a Postgres server for their database): named by design',
  };
  // Single sentences, by file and a piece of the text, each with why.
  const LINES = [
    ['server/search.js', 'Brave Search', "an engine's refusal: its words reach only the log; formatResults reads them through failedBecause"],
    ['server/search.js', 'DuckDuckGo', "an engine's failure: its words reach only the log; formatResults reads them through failedBecause"],
    ['server/firecrawl.js', 'Firecrawl', "the service's own failure: reaches a model only through plainFailure or firecrawlAside, which drop it"],
    ['server/email.js', 'Resend', "the mail service's own failure: send_email says it plainly (cloud.js), the log keeps it"],
    ['server/app.js', 'E2B account', "the administrators' cloud computer check (Settings → System)"],
    ['server/routes/mcp.js', 'Vercel Sandbox', 'Settings → Connectors: said to the person adding a stdio server, not to a model'],
    ['server/rag.js', 'OpenRouter keys cannot do this', "names the person's own provider keys and where to add one (Settings → Providers)"],
    ['server/providers/index.js', 'Pick a model on OpenRouter', "said to the person about their own model choice; inside a tool, modelFailure says it plainly"],
    ['server/vision.js', 'Tesseract OCR', "the reader's name for the log and its tests; no note to a model says it any more (fix round 1)"],
  ];
  const sentence = (text) => /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(text);
  const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
  const root = path.join(import.meta.dirname, '..');
  const found = [];
  let read = 0;
  for (const file of filesUnder(path.join(root, 'server'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (Object.keys(FILES).some((allowed) => rel === allowed || (allowed.endsWith('/') && rel.startsWith(allowed)))) continue;
    let ast;
    try {
      ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', loc: true });
    } catch {
      continue;
    }
    read += 1;
    // Comments are not in the tree; an argument to log.* or console.* is the log's.
    const walk = (node, logged) => {
      if (!node || typeof node.type !== 'string') return;
      const toLog = logged || (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && /^(?:log|console)$/.test(node.callee.object?.name || ''));
      if (!toLog) {
        const text = node.type === 'Literal' && typeof node.value === 'string' ? node.value : node.type === 'TemplateLiteral' ? node.quasis.map((q) => q.value.cooked).join('{}') : null;
        if (text && sentence(text)) {
          for (const m of text.matchAll(VENDORS)) {
            if (!LINES.some(([f, piece]) => f === rel && text.includes(piece))) found.push(`${rel}:${node.loc.start.line} "${m[0]}" in ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
          }
        }
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach((child) => walk(child, toLog));
        else if (value && typeof value.type === 'string') walk(value, toLog);
      }
    };
    walk(ast, false);
  }
  check('the scan reads the server', read > 150, `${read} files`);
  check('no sentence written in server/** names a service, outside the allow-lists', found.length === 0, found.slice(0, 6).join(' | '));
}

site.close();
globalThis.fetch = realFetch;
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
