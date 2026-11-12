/**
 * Searching the web, and having somewhere to fall back to.
 *
 * Every engine here is stubbed. The point is not whether Exa can find things —
 * it can, and a test that depended on the live internet would fail on a train —
 * but whether the chain behaves when one of them will not answer, which is the
 * case the chain exists for and the one nobody exercises by hand.
 *
 *   node test/search.test.mjs
 */

// Read before the module is imported: the pacing interval is fixed at load.
process.env.DDG_MIN_INTERVAL_MS = '300';
process.env.EXA_API_KEY = 'exa-test-key';
process.env.TAVILY_API_KEY = 'tavily-test-key';
process.env.BRAVE_API_KEY = 'brave-test-key';
// Stored keys are sealed (the last section, spec A); the rest of the suite runs with no database.
process.env.ENCRYPTION_KEY ||= 'search-test-encryption-key-long-enough-to-be-quiet';
delete process.env.SEARCH_ORDER;
delete process.env.FREE_TIER_ONLY;

const { search, formatResults, searchChain, searchPlan, SEARCH_LEVELS, cleanSites, fuseResults, readThroughExa, clearSearchCache } = await import('../server/search.js');
const pool = await import('../server/keyPool.js');
/** A key a section had refused, put back in use, as the owner's check would — so the next section starts with every key. */
const heal = () => Promise.all(['exa', 'tavily', 'brave'].map((service) => pool.markKey(service, 'env', 'ok')));
// Google stands aside in these tests: with no Gemini key it skips itself.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
const { __testing: providers } = await import('../server/providers/index.js');

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

/**
 * Stand in for the network.
 *
 * `plan` maps a fragment of the URL to what that host should do this time, so a
 * test reads as "Exa is rate limited, DuckDuckGo is blocked, Tavily answers".
 */
const calls = [];
function stubFetch(plan) {
  calls.length = 0;
  // Each stub is a different web: nothing remembered from the one before.
  clearSearchCache();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), body: init?.body, headers: new Headers(init?.headers || {}) });
    for (const [fragment, respond] of Object.entries(plan)) {
      if (url.includes(fragment)) return respond(init);
    }
    throw new Error(`nothing stubbed for ${url}`);
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

const ddgPage = (n) =>
  Array.from({ length: n }, (_, i) => {
    const target = encodeURIComponent(`https://example.com/${i}`);
    return (
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${target}">Result ${i}</a>` +
      `<a class="result__snippet">Snippet ${i}</a>`
    );
  }).join('');

// ── the order ───────────────────────────────────────────────────────
section('which engines, in which order');
{
  check('the default chain is Exa, Google, DuckDuckGo, Tavily, Brave', searchChain().join(',') === 'exa,google,duckduckgo,tavily,brave', searchChain().join(','));

  process.env.SEARCH_ORDER = 'tavily, exa';
  check('the order can be overridden', searchChain().join(',') === 'tavily,exa', searchChain().join(','));
  delete process.env.SEARCH_ORDER;

  const key = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  check('an engine with no key is skipped', !searchChain().includes('exa'), searchChain().join(','));
  check('but the one that needs no key stays', searchChain().includes('duckduckgo'));
  process.env.EXA_API_KEY = key;
}

// ── the happy path ──────────────────────────────────────────────────
section('the first engine answers');
{
  stubFetch({
    'api.exa.ai': () =>
      json({
        results: [
          {
            title: 'Giá vàng hôm nay',
            url: 'https://example.com/gold',
            highlights: ['Vàng tăng 1%.', 'Chốt phiên ở 4,031 USD.'],
            publishedDate: '2026-08-04T00:00:00Z',
          },
        ],
      }),
  });

  const outcome = await search('giá vàng', { count: 5 });
  check('Exa answers', outcome.engine === 'Exa', outcome.engine);
  check('nothing else was called', calls.length === 1, `${calls.length} requests`);
  check('the highlights become the snippet', /Vàng tăng 1%\. … Chốt phiên/.test(outcome.results[0].snippet), outcome.results[0].snippet);
  check('the published date survives', outcome.results[0].published === '2026-08-04T00:00:00Z');

  const sent = JSON.parse(calls[0].body);
  check(
    'asked for highlights, which is the point of Exa — focused on the query, at the length the level keeps',
    sent.contents?.highlights?.query === 'giá vàng' && sent.contents.highlights.maxCharacters === SEARCH_LEVELS.medium.snippet,
    JSON.stringify(sent.contents),
  );
  check('and for the documented default search type', sent.type === 'auto', sent.type);
  check('with the count it was given', sent.numResults === 5, String(sent.numResults));
  check('and nothing it was not asked to hold to', !('includeDomains' in sent) && !('startPublishedDate' in sent), JSON.stringify(sent));

  const text = formatResults('giá vàng', outcome);
  check('the answer says who found it', /results from Exa/.test(text), text.split('\n')[0]);
}

// ── the whole point ─────────────────────────────────────────────────
section('falling through to the next engine');
{
  stubFetch({
    // Out of credit — the exact case somebody keeps a second engine for.
    'api.exa.ai': () => json({ error: { detail: 'insufficient credits' } }, 402),
    // Rate limited, which DuckDuckGo serves as a cheerful 200.
    'duckduckgo.com': () => html('<html><body>Our systems have detected unusual traffic</body></html>'),
    'api.tavily.com': () =>
      json({ results: [{ title: 'Third time lucky', url: 'https://example.com/t', content: 'Found it.' }] }),
  });

  const outcome = await search('anything');
  check('the chain reaches the engine that works', outcome.engine === 'Tavily', outcome.engine);
  check('and records what the others said', outcome.attempts.length === 2, JSON.stringify(outcome.attempts));
  check(
    'in the provider\'s own words, not just a status code',
    /insufficient credits/.test(outcome.attempts[0].error),
    outcome.attempts[0].error,
  );
  check(
    'a rate-limit page is a failure, not an empty result',
    /rate-limit page/.test(outcome.attempts[1].error),
    outcome.attempts[1].error,
  );

  const text = formatResults('anything', outcome);
  check('and the failover is said out loud', /after Exa, DuckDuckGo failed/.test(text), text.split('\n')[0]);
  // Exa's 402 set its one key aside as spent until the month ends (keyPool.js).
  await heal();
}

section('every engine refusing is an answer too');
{
  stubFetch({
    'api.exa.ai': () => json({}, 500),
    'duckduckgo.com': () => html('nothing here'),
    'api.tavily.com': () => json({}, 500),
    'api.search.brave.com': () => json({ error: { detail: 'The provided subscription token is invalid.' } }, 422),
  });

  const outcome = await search('anything');
  check('no results rather than a thrown error', outcome.results.length === 0 && outcome.engine === null);
  const text = formatResults('anything', outcome);
  check('and the reply names every engine tried', /Exa.*DuckDuckGo.*Tavily.*Brave/s.test(text), text);
  check('with the reason for each', /subscription token is invalid/.test(text), text.slice(0, 200));
  await heal();
}

// ── how far a search goes (owner, 2026-11-02) ───────────────────────
section('each reasoning level, every engine in step');
{
  check("Low: Exa's cheapest path, short passages, one engine", searchPlan('low').exa === 'lite' && searchPlan('low').snippet <= 300 && !searchPlan('low').fuse);
  check('High: Exa decides, Tavily reads the best passages', searchPlan('high').exa === 'auto' && searchPlan('high').tavily === 'advanced');
  check('Extra high and Max: Exa searches deep, and a second engine joins', searchPlan('xhigh').exa === 'deep' && searchPlan('max').exa === 'deep-reasoning' && searchPlan('xhigh').fuse && searchPlan('max').fuse);
  check('each level asks for more than the one below', ['low', 'medium', 'high', 'xhigh', 'max'].every((l, i, all) => i === 0 || (SEARCH_LEVELS[l].count >= SEARCH_LEVELS[all[i - 1]].count && SEARCH_LEVELS[l].snippet > SEARCH_LEVELS[all[i - 1]].snippet)));
  const quick = searchPlan('max', 'quick');
  check('"quick" inside a careful job: links only, the cheapest path, one engine', quick.read === 0 && quick.exa === 'lite' && !quick.fuse);
  check('"thorough" on a fast setting reads pages and leaves the fast path', searchPlan('low', 'thorough').read >= 3 && searchPlan('low', 'thorough').exa === 'auto');
  check('an unknown level is the settings default, High', searchPlan(undefined) === SEARCH_LEVELS.high && searchPlan('nonsense') === SEARCH_LEVELS.high);

  process.env.SEARCH_ORDER = 'exa';
  stubFetch({ 'api.exa.ai': () => json({ results: [{ title: 'T', url: 'https://example.com/t', highlights: ['x'.repeat(900)] }] }) });
  const low = await search('giá xăng', { plan: searchPlan('low') });
  const sent = JSON.parse(calls[0].body);
  check('on Low Exa is asked for its lite type, five results, passages of 300', sent.type === 'lite' && sent.numResults === 5 && sent.contents.highlights.maxCharacters === 300, JSON.stringify(sent));
  check('  and a passage is kept to that length', low.results[0].snippet.length <= 301, String(low.results[0].snippet.length));
  delete process.env.SEARCH_ORDER;
}

section('recency and sites, each engine in its own words');
{
  check('sites are bare names — schemes, paths, www. and site: taken off; anything else dropped', JSON.stringify(cleanSites(['https://www.VnExpress.net/thoi-su', 'site:tuoitre.vn', 'javascript:alert(1)', '../etc', 'not a site', 'a'])) === JSON.stringify(['vnexpress.net', 'tuoitre.vn']), JSON.stringify(cleanSites(['https://www.VnExpress.net/thoi-su', 'site:tuoitre.vn', 'javascript:alert(1)', '../etc', 'not a site', 'a'])));
  check('  five at most, and a comma list is read too', cleanSites('a.com, b.com c.com,d.com,e.com,f.com').length === 5);
  const asked = { recency: 'week', sites: ['vnexpress.net', 'tuoitre.vn'] };

  process.env.SEARCH_ORDER = 'exa';
  stubFetch({ 'api.exa.ai': () => json({ results: [{ title: 'T', url: 'https://vnexpress.net/a', highlights: ['a'] }] }) });
  await search('lãi suất', { ...asked, plan: searchPlan('medium') });
  const exa = JSON.parse(calls[0].body);
  const since = Date.now() - Date.parse(exa.startPublishedDate);
  check('Exa: includeDomains, and a start date a week back', JSON.stringify(exa.includeDomains) === '["vnexpress.net","tuoitre.vn"]' && since > 6.9 * 86_400_000 && since < 7.1 * 86_400_000, JSON.stringify(exa));

  process.env.SEARCH_ORDER = 'tavily';
  stubFetch({ 'api.tavily.com': () => json({ results: [{ title: 'T', url: 'https://vnexpress.net/a', content: 'a' }] }) });
  await search('lãi suất', { ...asked, plan: searchPlan('high') });
  const tavily = JSON.parse(calls[0].body);
  check('Tavily: advanced on High with three passages a page, its time_range and include_domains', tavily.search_depth === 'advanced' && tavily.chunks_per_source === 3 && tavily.time_range === 'week' && tavily.include_domains.length === 2, JSON.stringify(tavily));
  await search('lãi suất', { plan: searchPlan('low') });
  const basic = JSON.parse(calls.at(-1).body);
  check('  basic on Low, nothing it was not asked for', basic.search_depth === 'basic' && !('chunks_per_source' in basic) && !('time_range' in basic) && !('include_domains' in basic), JSON.stringify(basic));

  process.env.SEARCH_ORDER = 'brave';
  stubFetch({ 'api.search.brave.com': () => json({ web: { results: [{ title: 'T', url: 'https://vnexpress.net/a', description: 'a' }] } }) });
  await search('lãi suất', { ...asked, plan: searchPlan('medium') });
  const brave = new URL(calls[0].url);
  check('Brave: site: in the query, and its freshness code', brave.searchParams.get('q') === 'lãi suất site:vnexpress.net OR site:tuoitre.vn' && brave.searchParams.get('freshness') === 'pw', calls[0].url);

  process.env.SEARCH_ORDER = 'duckduckgo';
  stubFetch({ 'duckduckgo.com': () => html(ddgPage(2)) });
  await search('lãi suất', { ...asked, plan: searchPlan('medium') });
  const ddg = new URLSearchParams(String(calls[0].body));
  check('DuckDuckGo: site: in the query, and its own date filter', ddg.get('q') === 'lãi suất site:vnexpress.net OR site:tuoitre.vn' && ddg.get('df') === 'w', String(calls[0].body));
  await search('lãi suất', { recency: 'forever', plan: searchPlan('medium') });
  check('  a span that is not one of the four is no filter at all', !new URLSearchParams(String(calls.at(-1).body)).has('df'));
  delete process.env.SEARCH_ORDER;
}

section('Extra high and Max: two engines side by side, merged');
{
  stubFetch({
    'api.exa.ai': () =>
      json({
        results: [
          { title: 'Shared', url: 'https://www.example.com/shared/', highlights: ['Exa passage, the longer of the two.'] },
          { title: 'Exa only', url: 'https://example.com/exa', highlights: ['e'] },
        ],
        output: { content: 'Gold rose 1% this week [1].' },
      }),
    'duckduckgo.com': () =>
      html(
        `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/ddg')}">DDG only</a><a class="result__snippet">d</a>` +
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/shared?utm_source=x')}">Shared</a><a class="result__snippet">short</a>`,
      ),
  });
  const outcome = await search('gold this week', { plan: searchPlan('max') });
  const sent = JSON.parse(calls.find((c) => c.url.includes('api.exa.ai')).body);
  check('Max asks Exa for its deep-reasoning search', sent.type === 'deep-reasoning', sent.type);
  check('both engines answered, in chain order', JSON.stringify(outcome.engines) === '["Exa","DuckDuckGo"]', JSON.stringify(outcome.engines));
  check('the page both found comes first — one entry, the fuller snippet, both names', outcome.results[0].title === 'Shared' && outcome.results[0].engines.length === 2 && /longer of the two/.test(outcome.results[0].snippet) && outcome.results.length === 3, JSON.stringify(outcome.results));
  const text = formatResults('gold this week', outcome);
  check('the model is told they were merged, and which page both found', /from Exa \+ DuckDuckGo, merged/.test(text) && /found by Exa and DuckDuckGo/.test(text), text.split('\n')[0]);
  check("Exa's own summary comes after the sources, inside the envelope, named for what it is", /Exa's own summary[\s\S]*Gold rose 1%[\s\S]*<\/untrusted>/.test(text) && text.indexOf('Gold rose') > text.indexOf('Exa only'), text.slice(-300));

  const one = fuseResults([{ label: 'Exa', results: [{ url: 'https://a.com' }, { url: 'https://b.com' }] }], 1);
  check('one engine is its own list, cut to the count', one.length === 1 && one[0].url === 'https://a.com' && !('engines' in one[0]));
}

section('a deep search that fails is asked again the ordinary way');
{
  process.env.SEARCH_ORDER = 'exa';
  let n = 0;
  stubFetch({
    'api.exa.ai': () => (n++ === 0 ? json({ error: 'deep search unavailable' }, 500) : json({ results: [{ title: 'T', url: 'https://example.com/t', highlights: ['ok'] }] })),
  });
  const outcome = await search('anything', { plan: searchPlan('xhigh') });
  const types = calls.map((c) => JSON.parse(c.body).type);
  check('deep first, then auto — and the answer arrives', types.join() === 'deep,auto' && outcome.engine === 'Exa' && outcome.results.length === 1, types.join());

  stubFetch({ 'api.exa.ai': () => json({ error: 'invalid api key' }, 401) });
  const refused = await search('anything', { plan: searchPlan('xhigh') });
  check('  but a refused key is not asked twice', calls.length === 1 && /invalid api key/.test(refused.attempts[0]?.error || ''), JSON.stringify(refused.attempts));
  delete process.env.SEARCH_ORDER;
  await heal();
}

section('a page that turns the server away, read through Exa');
{
  stubFetch({ 'api.exa.ai/contents': () => json({ results: [{ title: 'Page', text: 'The whole article.' }] }) });
  const read = await readThroughExa('https://example.com/a', { maxChars: 5000 });
  const sent = JSON.parse(calls[0].body);
  check("Exa's /contents is asked for that one page, at the length wanted", JSON.stringify(sent.urls) === '["https://example.com/a"]' && sent.text.maxCharacters === 5000 && read?.text === 'The whole article.', JSON.stringify(sent));
  stubFetch({ 'api.exa.ai/contents': () => json({ results: [], statuses: [{ id: 'x', status: 'error' }] }) });
  check('  nothing read is null, for the caller to say what went wrong', (await readThroughExa('https://example.com/a')) === null);
  const key = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  stubFetch({});
  check('  and with no key, Exa is not asked at all', (await readThroughExa('https://example.com/a')) === null && calls.length === 0);
  process.env.EXA_API_KEY = key;
}

// ── being a good citizen ────────────────────────────────────────────
section('DuckDuckGo is paced');
{
  process.env.SEARCH_ORDER = 'duckduckgo';
  stubFetch({ 'duckduckgo.com': () => html(ddgPage(3)) });

  const started = Date.now();
  const [a, b, c] = await Promise.all([search('one'), search('two'), search('three')]);
  const elapsed = Date.now() - started;

  check('all three searches answer', [a, b, c].every((r) => r.results.length === 3));
  check(
    'but they went one at a time',
    elapsed >= 600,
    `${elapsed}ms for three at ${process.env.DDG_MIN_INTERVAL_MS}ms apart`,
  );
  const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
  check('with a gap between each', gaps.every((gap) => gap >= 250), gaps.join('ms, ') + 'ms');

  check('the redirect wrapper is unwrapped', a.results[0].url === 'https://example.com/0', a.results[0].url);
  check('and the snippet comes with it', a.results[0].snippet === 'Snippet 0', a.results[0].snippet);
  delete process.env.SEARCH_ORDER;
}

/**
 * The owner's screenshot 12 (2026-11-04): every search "0 results" while
 * DuckDuckGo's HTML page answered with an apology. Measured the same day: its lite
 * page answered the same machine with ten results.
 */
section('DuckDuckGo has a second page to ask');
{
  process.env.SEARCH_ORDER = 'duckduckgo';
  const litePage =
    `<a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>An advertisement</a><td class='result-snippet'>Buy now</td>` +
    `<a rel="nofollow" href="https://sepay.vn/bang-gia.html" class='result-link'>Bảng giá SePay - SePay</a><td class='result-snippet'>Bảng giá <b>SePay</b>, bắt đầu với 0 đồng.</td>` +
    `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://sepay.vn/')}" class='result-link'>SePay</a><td class='result-snippet'>API Ngân Hàng</td>`;
  stubFetch({
    'html.duckduckgo.com': () => html('<html><body>If this persists, please email us. anomaly detected</body></html>'),
    'lite.duckduckgo.com': () => html(litePage),
  });
  const found = await search('SePay bảng giá phí');
  check('the HTML page blocked, the lite page answers', found.results.length === 2 && found.engine === 'DuckDuckGo', JSON.stringify(found.results.map((r) => r.url)));
  check('  an advertisement is not a result', !found.results.some((r) => /y\.js/.test(r.url)));
  check('  its title and snippet read', found.results[0].title === 'Bảng giá SePay - SePay' && /bắt đầu với 0 đồng/.test(found.results[0].snippet), JSON.stringify(found.results[0]));
  check('  the snippet is the one beside that link', found.results[1].snippet === 'API Ngân Hàng', found.results[1].snippet);
  check('  a wrapped link is unwrapped', found.results[1].url === 'https://sepay.vn/', found.results[1].url);

  stubFetch({ 'duckduckgo.com': () => html('<html><body>Our systems have detected unusual traffic</body></html>') });
  const blocked = await search('another thing entirely');
  check('both blocked: what the first said is what is reported', /rate-limit page/.test(blocked.attempts[0]?.error || ''), JSON.stringify(blocked.attempts));
  delete process.env.SEARCH_ORDER;

  // What the transcript does with it. `searchFailure` is read from the page's own module.
  const { searchFailure, parseResults } = await import('../public/js/rail.js');
  const { formatResults } = await import('../server/search.js');
  const failed = formatResults('q', { results: [], attempts: [{ engine: 'DuckDuckGo', error: 'DuckDuckGo served a rate-limit page rather than results.' }] });
  check('a search no engine could run is told from a real zero', /rate-limit page/.test(searchFailure(failed) || ''), searchFailure(failed));
  check('  every engine finding nothing is a real zero', searchFailure(formatResults('q', { results: [], attempts: [{ engine: 'Exa', error: 'no results' }, { engine: 'DuckDuckGo', error: 'no results' }] })) === null);
  check('  one failing beside one finding nothing is not', searchFailure(formatResults('q', { results: [], attempts: [{ engine: 'Exa', error: 'HTTP 402' }, { engine: 'DuckDuckGo', error: 'no results' }] })) !== null);
  check('  no engine able to run at all is not', searchFailure(formatResults('q', { results: [], attempts: [] })) === 'nothing');
  check('  and results are not a failure', searchFailure(formatResults('q', { engine: 'Exa', results: [{ title: 'T', url: 'https://a.example/', snippet: 's' }], attempts: [] })) === null);
  check('  nor is an error some other tool wrote', searchFailure('HTTP 500') === null && parseResults('HTTP 500').length === 0);
}

section('nothing configured at all');
{
  const saved = { ...process.env };
  delete process.env.EXA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  process.env.SEARCH_ORDER = 'exa,tavily';

  let error = null;
  await search('x').catch((err) => (error = err));
  check('says so rather than failing obscurely', error?.code === 'no_search_engine', error?.message);
  check('and names what to set', /EXA_API_KEY/.test(error?.message || ''), error?.message);

  process.env.EXA_API_KEY = saved.EXA_API_KEY;
  process.env.TAVILY_API_KEY = saved.TAVILY_API_KEY;
  process.env.BRAVE_API_KEY = saved.BRAVE_API_KEY;
  delete process.env.SEARCH_ORDER;
}

// ── which model failures deserve another key ────────────────────────
//
// This used to ask `keyExhausted` one yes-or-no question. It now asks
// `classify` which *kind* of failure it was, because "would another key help?"
// turned out to be two questions wearing one coat: a rate limit wants time and
// the same key, an empty wallet wants a different key and never that one again.
// The grading itself is pinned in full by test/fallback.test.mjs; these are the
// cases this suite has always cared about.
section('when a second API key would help');
{
  const kind = (error) => providers.classify(error).kind;
  check('an unauthorised key', kind({ status: 401 }) === 'KEY_DEAD');
  check('one out of credit', kind({ status: 402 }) === 'KEY_DEAD');
  check('one being rate limited', kind({ status: 429 }) === 'RATE_LIMITED');
  check('and one the provider names in prose', kind(new Error('Your quota has been exceeded')) === 'RATE_LIMITED');
  check('and an invalid key by message alone', kind(new Error('Incorrect API key provided')) === 'KEY_DEAD');

  check('but not a model that does not exist', kind({ status: 404 }) === 'FATAL');
  check('nor a malformed request', kind({ status: 400, message: 'unsupported parameter' }) === 'FATAL');

  // Deliberately reversed. Walking every key on a 503 was right — they all fail
  // the same way — but the conclusion drawn from it was wrong: the turn was
  // abandoned when the provider had merely stumbled. It is the same key that
  // wants trying, a moment later.
  check(
    'and the provider being down is worth waiting out, not worth another key',
    kind({ status: 503 }) === 'UPSTREAM',
    'same key, after a pause — rather than five slow errors or none at all',
  );
}

section("one account is never answered from another account's search (PRV-016)");
{
  // Ten minutes of results were shared by everyone on the instance, keyed by the words alone:
  // B could tell from an instant answer that somebody had just searched them — and was served
  // what A's own key had paid for.
  stubFetch({ 'duckduckgo.com': () => html(ddgPage(3)) });
  await search('benh vien gan nha toi', { userId: 'u-a' });
  const first = calls.length;
  await search('benh vien gan nha toi', { userId: 'u-a' });
  const again = calls.length;
  await search('benh vien gan nha toi', { userId: 'u-b' });
  check('the same account asking twice is answered from the cache', first > 0 && again === first, `${first} → ${again}`);
  check('  another account asking the same is not (PRV-016)', calls.length > again, `${again} → ${calls.length}`);
}
section('an engine having a bad afternoon goes to the back of the chain');
{
  const { cooledChain, noteEngine, clearEngineTrouble } = await import('../server/search.js');
  clearEngineTrouble();
  const chain = ['exa', 'firecrawl', 'duckduckgo'];
  const t0 = Date.now();
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  noteEngine('exa', timeout, t0);
  check('one timeout is not enough', cooledChain(chain, t0).join() === chain.join());
  noteEngine('exa', Object.assign(new Error('Exa returned HTTP 503'), { status: 503 }), t0);
  check('two in a row: moved to the back, not removed', cooledChain(chain, t0 + 1000).join() === 'firecrawl,duckduckgo,exa');
  check('  for a minute and a half', cooledChain(chain, t0 + 91_000).join() === chain.join());
  noteEngine('firecrawl', Object.assign(new Error('Firecrawl answered HTTP 400'), { status: 400 }), t0);
  noteEngine('firecrawl', Object.assign(new Error('Firecrawl answered HTTP 401'), { status: 401 }), t0);
  noteEngine('duckduckgo', Object.assign(new Error('standing aside'), { skip: true }), t0);
  noteEngine('duckduckgo', Object.assign(new Error('standing aside'), { skip: true }), t0);
  check('a refusal of the request, or standing aside, is not trouble', cooledChain(chain, t0 + 91_000).join() === chain.join());
  noteEngine('exa', timeout, t0);
  noteEngine('exa', null, t0);
  noteEngine('exa', timeout, t0);
  check('an answer in between starts the count again', cooledChain(chain, t0 + 91_000).join() === chain.join());
  clearEngineTrouble();
}

/*
 * Several keys (spec A, owner 2026-11-12): every Exa, Tavily and Brave call asks the pool
 * (server/keyPool.js) for its key, so a key that is spent or refused hands over to the next.
 * The only section with a database: the stored keys are rows, sealed as the owner's page seals them.
 */
section('several keys: a spent or refused key hands over to the next (spec A)');
{
  const { PGlite } = await import('@electric-sql/pglite');
  const { initStore } = await import('../server/store/index.js');
  const db = await PGlite.create();
  const store = await initStore({ driver: { query: async (text, params = []) => (await db.query(text, params)).rows } });
  const { encryptSecret, sha256 } = await import('../server/crypto.js');
  const { serviceKeyContext } = await import('../server/secretContexts.js');
  const { periodOf } = await import('../server/freeTier.js');
  const month = periodOf('month').key;
  let added = 0;
  const addKey = async (service, key) => {
    const id = `sk${(added += 1)}`;
    await store.addServiceKey({ id, service, sealed: encryptSecret(key, serviceKeyContext(service, id)), fingerprint: sha256(`${service}:${key}`), hint: key.slice(-4), label: null, ceiling: null, addedBy: null });
    return id;
  };
  const SECOND = { exa: 'exa-second-key-2222', tavily: 'tvly-second-key-3333' };
  const ENV = { exa: process.env.EXA_API_KEY, tavily: process.env.TAVILY_API_KEY, brave: process.env.BRAVE_API_KEY };
  const every = [...Object.values(SECOND), ...Object.values(ENV)];
  /** What this section prints names a key by its last four characters, never more. */
  const hints = (keys) => keys.map((k) => `…${String(k || '').slice(-4)}`).join(' ');
  const keyless = (text) => !every.some((key) => String(text).includes(key));
  const exaId = await addKey('exa', SECOND.exa);
  const tavilyId = await addKey('tavily', SECOND.tavily);
  await pool.keysFor('exa', { fresh: true });
  const envOf = async (service) => (await pool.keysFor(service)).find((k) => k.id === 'env');

  // Exa: the environment's key says its credit is gone (Exa's 402 NO_MORE_CREDITS), the stored one answers.
  process.env.SEARCH_ORDER = 'exa';
  const exaBy = (init) =>
    new Headers(init?.headers).get('x-api-key') === SECOND.exa
      ? json({ results: [{ title: 'Second', url: 'https://example.com/second', highlights: ['from the second key'] }], costDollars: { total: 0.009 } })
      : json({ requestId: 'r1', error: 'You have run out of credits', tag: 'NO_MORE_CREDITS' }, 402);
  stubFetch({ 'api.exa.ai/search': exaBy });
  const spent = await search('two Exa keys', { plan: searchPlan('medium') });
  const asked = calls.map((c) => c.headers.get('x-api-key'));
  check('Exa: the first key answers 402, the result comes from the second', spent.engine === 'Exa' && spent.results[0]?.title === 'Second' && asked.length === 2 && asked[0] === ENV.exa && asked[1] === SECOND.exa && spent.attempts.length === 0, `${spent.engine} — ${hints(asked)}`);
  const exaEnv = await envOf('exa');
  check('  the first is set aside as spent until its month ends, and counted full', exaEnv?.state === 'exhausted' && exaEnv.retryAt === periodOf('month').ends.getTime() && (await store.readCounter(`free:exa:${month}`)) === 9_500, `${exaEnv?.state} ${await store.readCounter(`free:exa:${month}`)}`);
  check('  what the second spent (the cost Exa said) is counted on the second', (await store.readCounter(`free:exa@${exaId}:${month}`)) === 9, String(await store.readCounter(`free:exa@${exaId}:${month}`)));
  stubFetch({ 'api.exa.ai/search': exaBy });
  await search('two Exa keys, asked again', { plan: searchPlan('medium') });
  check('  the next search asks the second alone', calls.length === 1 && calls[0].headers.get('x-api-key') === SECOND.exa, hints(calls.map((c) => c.headers.get('x-api-key'))));
  stubFetch({ 'api.exa.ai/contents': (init) => (new Headers(init?.headers).get('x-api-key') === SECOND.exa ? json({ results: [{ title: 'Page', text: 'Read with the second key.' }], costDollars: { total: 0.001 } }) : json({ tag: 'NO_MORE_CREDITS' }, 402)) });
  const page = await readThroughExa('https://example.com/a');
  check("  a page read through Exa's /contents goes to the second as well", page?.text === 'Read with the second key.' && calls.length === 1 && calls[0].headers.get('x-api-key') === SECOND.exa, hints(calls.map((c) => c.headers.get('x-api-key'))));

  // Tavily: 432, its plan's limit, is the key spent; the stored key answers.
  process.env.SEARCH_ORDER = 'tavily';
  const tavilyBy = (init) =>
    new Headers(init?.headers).get('authorization') === `Bearer ${SECOND.tavily}`
      ? json({ results: [{ title: 'Tavily second', url: 'https://example.com/t2', content: 'b' }] })
      : json({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432);
  stubFetch({ 'api.tavily.com': tavilyBy });
  const tav = await search('two Tavily keys', { plan: searchPlan('medium') });
  const tavAsked = calls.map((c) => c.headers.get('authorization'));
  check('Tavily: a 432 on the first key, the second answers', tav.engine === 'Tavily' && tav.results[0]?.title === 'Tavily second' && tavAsked.length === 2 && tavAsked[1] === `Bearer ${SECOND.tavily}`, `${tav.engine} — ${tavAsked.length} asked`);
  check('  the first set aside as spent, one credit counted on the second', (await envOf('tavily'))?.state === 'exhausted' && (await store.readCounter(`free:tavily@${tavilyId}:${month}`)) === 1, (await envOf('tavily'))?.state);

  // Brave holds one key (owner, 2026-11-12): refused, it stands aside and the next engine answers.
  process.env.SEARCH_ORDER = 'brave,duckduckgo';
  const braveRefuses = () => json({ type: 'ErrorResponse', error: { status: 422, detail: `The provided API key ${ENV.brave} is invalid.`, code: 'SUBSCRIPTION_TOKEN_INVALID' } }, 422);
  stubFetch({ 'api.search.brave.com': braveRefuses, 'duckduckgo.com': () => html(ddgPage(2)) });
  const brave = await search('brave refused', { plan: searchPlan('medium') });
  check('Brave 422 SUBSCRIPTION_TOKEN_INVALID: its key set aside as refused, the next engine answers, the reason said', brave.engine === 'DuckDuckGo' && (await envOf('brave'))?.state === 'invalid' && /HTTP 422/.test(brave.attempts[0]?.error || ''), `${brave.engine} ${(await envOf('brave'))?.state}`);
  check('  a key a provider repeats back is not in the reason the model reads', keyless(brave.attempts[0]?.error) && /…/.test(brave.attempts[0]?.error || ''), keyless(brave.attempts[0]?.error) ? 'no key in it' : 'the key is in it');
  stubFetch({ 'api.search.brave.com': braveRefuses, 'duckduckgo.com': () => html(ddgPage(2)) });
  const after = await search('brave refused, asked again', { plan: searchPlan('medium') });
  check('  and it is not asked again: Brave is out of the chain until the owner checks it', !calls.some((c) => c.url.includes('search.brave.com')) && !searchChain().includes('brave') && after.engine === 'DuckDuckGo', searchChain().join(','));

  // The key taken out before the reason is cut (review, 2026-11-12): cut first, one repeated across the cut kept its start.
  await heal();
  const padded = () => json({ type: 'ErrorResponse', error: { status: 422, detail: `${'a'.repeat(190)}${ENV.brave} is not valid`, code: 'SUBSCRIPTION_TOKEN_INVALID' } }, 422);
  stubFetch({ 'api.search.brave.com': padded, 'duckduckgo.com': () => html(ddgPage(2)) });
  const cut = await search('brave refused at length', { plan: searchPlan('medium') });
  const partly = String(cut.attempts[0]?.error || '').includes(ENV.brave.slice(0, 8));
  check('  a key repeated back across the 200th character is taken out whole, none of it left', !!cut.attempts[0] && !partly, partly ? 'part of the key is in it' : `${String(cut.attempts[0]?.error || '').length} characters, none of the key`);

  // A timeout is the same for every key (owner, 2026-11-12): no second key; the chain goes on.
  // Both Exa keys with room, so a second key is there to be asked.
  await heal();
  await store.clearRateLimit(`free:exa:${month}`);
  process.env.SEARCH_ORDER = 'exa,duckduckgo';
  const timedOut = () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  stubFetch({ 'api.exa.ai/search': timedOut, 'duckduckgo.com': () => html(ddgPage(2)) });
  const slow = await search('a slow Exa', { plan: searchPlan('medium') });
  const exaAsked = calls.filter((c) => c.url.includes('api.exa.ai')).length;
  check('Exa timing out: no second key asked, the next engine answers, and no key is set aside', exaAsked === 1 && slow.engine === 'DuckDuckGo' && /timeout/.test(slow.attempts[0]?.error || '') && (await pool.keysFor('exa')).every((k) => k.state === 'ok'), `${exaAsked} Exa call(s) — ${slow.engine}`);

  // Every key's count in one read (final review, 2026-11-13): the database has one connection,
  // so a read per key, in turn, grew a search's wait with every key added.
  await heal();
  process.env.SEARCH_ORDER = 'exa';
  const { readCounter, readCounters } = store;
  let reads = 0;
  store.readCounter = (...args) => ((reads += 1), readCounter.apply(store, args));
  store.readCounters = (...args) => ((reads += 1), readCounters.apply(store, args));
  const readsFor = async (query) => {
    stubFetch({ 'api.exa.ai/search': () => json({ results: [{ title: 'R', url: 'https://example.com/r', highlights: ['h'] }], costDollars: { total: 0.009 } }) });
    reads = 0;
    const found = await search(query, { plan: searchPlan('medium'), userId: 'u-reads' });
    return { reads, engine: found.engine };
  };
  try {
    const two = await readsFor('the counts read with two Exa keys');
    for (const key of ['exa-third-key-4444', 'exa-fourth-key-5555', 'exa-fifth-key-6666']) {
      every.push(key);
      await addKey('exa', key);
    }
    const five = (await pool.keysFor('exa', { fresh: true })).length;
    const withFive = await readsFor('the counts read with five Exa keys');
    check('a search with five Exa keys reads the counts no more often than one with two: three reads, whatever the number of keys', five === 5 && two.engine === 'Exa' && withFive.engine === 'Exa' && withFive.reads === two.reads && withFive.reads <= 3, `${two.reads} reads with 2 keys, ${withFive.reads} with ${five}`);
  } finally {
    Object.assign(store, { readCounter, readCounters });
  }

  delete process.env.SEARCH_ORDER;
  await heal();
}

console.log(
  failures === 0
    ? '\n[32mAll search checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
