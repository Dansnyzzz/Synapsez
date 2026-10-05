/**
 * Site icons, fetched by this server so the browser never tells a third party
 * which sites a conversation touched.
 *
 * What is pinned here is the gate in front of the fetch: only a bare public
 * hostname gets through, never a path, a port, a scheme or an IP literal the
 * model could aim at something private. The cache is checked without the
 * network: a known icon and a remembered miss are both answered from memory.
 *
 *   node test/favicon.test.mjs
 */
let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { cleanHost, faviconFor, siteOf, __testing } = await import('../server/favicon.js');

section('only the registrable name is ever asked for (SEC-034)');
for (const [input, want] of [
  ['vnexpress.net', 'vnexpress.net'],
  ['news.bbc.co.uk', 'bbc.co.uk'],
  ['dantri.com.vn', 'dantri.com.vn'],
  ['tuoitre.vn', 'tuoitre.vn'],
  ['docs.google.com', 'google.com'],
  ['bmFtZTogTGFuLCBwaG9uZSAwOTEy.attacker.example', 'attacker.example'],
  ['a.b.c.d.attacker.example', 'attacker.example'],
  // A country code whose "co" is open to registration is not on the list, so
  // a name bought there cannot be used to keep a data-carrying label.
  ['c2VjcmV0.co.ws', 'co.ws'],
  ['c2VjcmV0.evil.co.uk', 'evil.co.uk'],
]) {
  check(`${input} → ${want}`, siteOf(input) === want, String(siteOf(input)));
}
{
  // Answered from the registrable name's cache entry: the long label never
  // becomes a key, a lookup or a request.
  const icon = { type: 'image/png', data: Buffer.from([9]) };
  __testing.cache.set('attacker.example', icon);
  const got = await faviconFor('c2VjcmV0LW5vdGVz.attacker.example');
  check('a data-carrying subdomain is served the site icon from memory', got === icon);
  check('and nothing was cached under the long name', !__testing.cache.has('c2VjcmV0LW5vdGVz.attacker.example'));
  __testing.cache.clear();
}

section('only a bare hostname is asked for');
for (const [input, want] of [
  ['vnexpress.net', 'vnexpress.net'],
  ['VnExpress.NET', 'vnexpress.net'],
  ['news.bbc.co.uk.', 'news.bbc.co.uk'],
  ['xn--80ak6aa92e.com', 'xn--80ak6aa92e.com'],
]) {
  check(`${input} → ${want}`, cleanHost(input) === want, String(cleanHost(input)));
}
for (const bad of [
  '',
  'localhost',
  '127.0.0.1',
  '169.254.169.254',
  'example.com:8080',
  'example.com/path',
  'https://example.com',
  'user@example.com',
  '-bad.com',
  'a..com',
  '[::1]',
  'a'.repeat(64) + '.com',
]) {
  check(`refuses ${JSON.stringify(bad.slice(0, 30))}`, cleanHost(bad) === null, String(cleanHost(bad)));
}

section('the cache answers without the network');
{
  const icon = { type: 'image/png', data: Buffer.from([1, 2, 3]) };
  __testing.cache.set('cached.example', icon);
  check('a known icon comes from memory', (await faviconFor('cached.example')) === icon);

  __testing.cache.set('missing.example', { miss: Date.now() + 60_000 });
  check('a remembered miss is not asked again', (await faviconFor('missing.example')) === null);
  __testing.cache.clear();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mAll favicon checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
