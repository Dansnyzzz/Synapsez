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
delete process.env.SEARCH_ORDER;

const { search, formatResults, searchChain, searchPlan, SEARCH_LEVELS, cleanSites, fuseResults, readThroughExa } = await import('../server/search.js');
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
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, at: Date.now(), body: init?.body });
    for (const [fragment, respond] of Object.entries(plan)) {
      if (url.includes(fragment)) return respond();
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
}

// ── how far a search goes (owner, 2026-11-02) ───────────────────────
section('each reasoning level, every engine in step');
{
  check('Low: the fast path, short passages, one engine', searchPlan('low').exa === 'fast' && searchPlan('low').snippet <= 300 && !searchPlan('low').fuse);
  check('High: Exa decides, Tavily reads the best passages', searchPlan('high').exa === 'auto' && searchPlan('high').tavily === 'advanced');
  check('Extra high and Max: Exa searches deep, and a second engine joins', searchPlan('xhigh').exa === 'deep' && searchPlan('max').exa === 'deep-reasoning' && searchPlan('xhigh').fuse && searchPlan('max').fuse);
  check('each level asks for more than the one below', ['low', 'medium', 'high', 'xhigh', 'max'].every((l, i, all) => i === 0 || (SEARCH_LEVELS[l].count >= SEARCH_LEVELS[all[i - 1]].count && SEARCH_LEVELS[l].snippet > SEARCH_LEVELS[all[i - 1]].snippet)));
  const quick = searchPlan('max', 'quick');
  check('"quick" inside a careful job: links only, the fast path, one engine', quick.read === 0 && quick.exa === 'fast' && !quick.fuse);
  check('"thorough" on a fast setting reads pages and leaves the fast path', searchPlan('low', 'thorough').read >= 3 && searchPlan('low', 'thorough').exa === 'auto');
  check('an unknown level is the settings default, High', searchPlan(undefined) === SEARCH_LEVELS.high && searchPlan('nonsense') === SEARCH_LEVELS.high);

  process.env.SEARCH_ORDER = 'exa';
  stubFetch({ 'api.exa.ai': () => json({ results: [{ title: 'T', url: 'https://example.com/t', highlights: ['x'.repeat(900)] }] }) });
  const low = await search('giá xăng', { plan: searchPlan('low') });
  const sent = JSON.parse(calls[0].body);
  check('on Low Exa is asked for its fast type, five results, passages of 300', sent.type === 'fast' && sent.numResults === 5 && sent.contents.highlights.maxCharacters === 300, JSON.stringify(sent));
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

console.log(
  failures === 0
    ? '\n[32mAll search checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
