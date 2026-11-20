/**
 * The address-safety check (server/domainCheck.js; owner, 2026-11-09), against a stand-in
 * for the resolvers, the site and the preload list: every verdict, and that nothing but
 * the deployment's own address is ever asked about.
 *
 *   node test/domain-check.test.mjs
 */
const { checkDomain } = await import('../server/domainCheck.js');

let failures = 0;
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);

/**
 * A world: which names are signed, which have DS, CAA and TXT records, what the site sends.
 *
 * @param {{ signed?: boolean, ds?: string[], caa?: Record<string, string[]>, txt?: Record<string, string[]>, hsts?: string, preloaded?: string[], down?: boolean }} world
 */
const stand = (world) => {
  const asked = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    asked.push(u.host + u.pathname + (u.searchParams.get('name') ? `?${u.searchParams.get('name')}:${u.searchParams.get('type')}` : u.searchParams.get('domain') ? `?${u.searchParams.get('domain')}` : ''));
    if (world.down) throw new Error('offline');
    if (u.host === 'cloudflare-dns.com' || u.host === 'dns.google') {
      const name = u.searchParams.get('name');
      const type = u.searchParams.get('type');
      if (type === 'A') return json({ Status: 0, AD: !!world.signed, Answer: [{ name, type: 1, data: '203.0.113.7' }] });
      if (type === 'DS') return json({ Status: 0, AD: true, Answer: (world.ds || []).includes(name) ? [{ name, type: 43, data: '1 13 2 ABCD' }] : [] });
      if (type === 'CAA') return json({ Status: 0, Answer: (world.caa?.[name] || []).map((data) => ({ name, type: 257, data })) });
      if (type === 'TXT') return json({ Status: 0, Answer: (world.txt?.[name] || []).map((data) => ({ name, type: 16, data: `"${data}"` })) });
      return json({ Status: 0 });
    }
    if (u.host === 'hstspreload.org') return json({ status: (world.preloaded || []).includes(u.searchParams.get('domain')) ? 'preloaded' : 'unknown' });
    // The site itself.
    void init;
    return { ok: true, status: 200, headers: new Headers(world.hsts ? { 'strict-transport-security': world.hsts } : {}), json: async () => ({}) };
  };
  return { fetchImpl, asked };
};
const verdicts = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c.verdict]));

section('a platform address that is not signed (an address under vercel.app)');
{
  const world = stand({
    signed: false,
    ds: [],
    caa: { 'vercel.app': ['0 issue "letsencrypt.org"', '0 issue "pki.goog"'] },
    txt: { 'gmail.com': ['v=spf1 redirect=_spf.google.com'], '_dmarc.gmail.com': ['v=DMARC1; p=none; sp=quarantine'], '_mta-sts.gmail.com': ['v=STSv1; id=20190429T010101'] },
    hsts: 'max-age=63072000; includeSubDomains; preload',
    preloaded: ['app'],
  });
  const result = await checkDomain({ url: 'https://ephapse.vercel.app', mailFrom: 'someone@gmail.com', fetchImpl: world.fetchImpl, now: new Date('2026-11-09T10:00:00Z') });
  const v = verdicts(result);
  const dnssec = result.checks.find((c) => c.id === 'dnssec');
  check('DNSSEC is missing, and the unsigned zone is named as the platform\'s', v.dnssec === 'fail' && dnssec.facts.unsignedZone === 'vercel.app' && dnssec.facts.platform === true, JSON.stringify(dnssec));
  check('HTTPS and two years of HSTS with subdomains are good', v.https === 'ok' && v.hsts === 'ok');
  check('preloaded by its top-level domain', v.preload === 'ok' && result.checks.find((c) => c.id === 'preload').facts.by === 'app');
  check('CAA found on the parent, with its issuers', v.caa === 'ok' && JSON.stringify(result.checks.find((c) => c.id === 'caa').facts.issuers) === '["letsencrypt.org","pki.goog"]');
  check('gmail.com: SPF, but DMARC only p=none, so could be better', v.mail === 'warn' && result.checks.find((c) => c.id === 'mail').facts.dmarc === 'none');
  check('nothing but this address, its parents and the sender\'s domain was asked about', world.asked.every((a) => /ephapse\.vercel\.app|vercel\.app|\?app$|gmail\.com|^ephapse\.vercel\.app\/$/.test(a)), world.asked.filter((a) => !/vercel\.app|app$|gmail\.com/.test(a)).join(', '));
}

section('a domain of its own, done right');
{
  const world = stand({
    signed: true,
    ds: ['example.com'],
    caa: { 'example.com': ['0 issue "letsencrypt.org"'] },
    txt: { 'example.com': ['v=spf1 include:_spf.google.com -all'], '_dmarc.example.com': ['v=DMARC1; p=reject; rua=mailto:d@example.com'], '_mta-sts.example.com': ['v=STSv1; id=1'] },
    hsts: 'max-age=63072000; includeSubDomains; preload',
    preloaded: ['example.com'],
  });
  const result = await checkDomain({ url: 'https://example.com', mailFrom: 'hello@example.com', fetchImpl: world.fetchImpl });
  check('every check good', Object.values(verdicts(result)).every((x) => x === 'ok'), JSON.stringify(verdicts(result)));
}

section('what falls short is said, not hidden');
{
  const short = stand({ signed: false, ds: ['example.org'], hsts: 'max-age=86400', txt: {} });
  const result = await checkDomain({ url: 'https://shop.example.org', mailFrom: 'a@example.org', fetchImpl: short.fetchImpl });
  const v = verdicts(result);
  check('a short HSTS without subdomains could be better', v.hsts === 'warn');
  check('no CAA anywhere up the tree: could be better', v.caa === 'warn');
  check('no SPF or DMARC: missing', v.mail === 'fail');
  check('not on the preload list: could be better', v.preload === 'warn');
  const plain = await checkDomain({ url: 'http://localhost:5173', fetchImpl: short.fetchImpl });
  check('an address that is not HTTPS fails at once', verdicts(plain).https === 'fail');
  const none = await checkDomain({ url: '', fetchImpl: short.fetchImpl });
  check('no address set says so', none.host === null && none.checks[0].id === 'address');
  const offline = stand({ down: true });
  const unknown = await checkDomain({ url: 'https://example.net', mailFrom: 'a@example.net', fetchImpl: offline.fetchImpl });
  check('nothing reachable: unknown, never a pass and never a throw', unknown.checks.every((c) => c.verdict === 'unknown' || c.verdict === 'fail') && !unknown.checks.some((c) => c.verdict === 'ok'), JSON.stringify(verdicts(unknown)));
}

/*
 * `npm run domain:check` reads the sender the way the app does (1.33.3 review): the same settings
 * in the same order, and a setting that is unusable is named as such, never printed. A site
 * address that does not parse ends the check before any lookup, so nothing here leaves the machine.
 */
section('npm run domain:check names the sender the app sends from, and what it skipped');
{
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/domain-check.mjs', import.meta.url));
  const MAIL = ['EMAIL_FROM', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY', 'PUBLIC_URL', 'VERCEL', 'LOG_FORMAT'];
  const run = (env, ...args) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !MAIL.includes(k)));
    const out = spawnSync(process.execPath, [script, 'not-a-site-address', ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000 });
    return `${out.stdout}\n${out.stderr}`;
  };
  const broken = run({ EMAIL_FROM: 'Ephapse <support@ephapse.net', GMAIL_USER: 'Ephapse <mailbox@ephapse.net>', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
  check('an unusable EMAIL_FROM is named as unusable, and the app\'s next sender is the one checked', /EMAIL_FROM is set but is not one usable address/.test(broken) && /sender\s+mailbox@ephapse\.net \(from GMAIL_USER\)/.test(broken), broken.trim().slice(0, 400));
  check('  its value is never printed', !broken.includes('support@ephapse.net') && !broken.includes('Ephapse <support'), broken.trim().slice(0, 400));
  const noPassword = run({ GMAIL_USER: 'mailbox@ephapse.net', RESEND_API_KEY: 're_test_not_a_key' });
  check('GMAIL_USER without its App Password is not the sender, as in the app', /sender\s+onboarding@resend\.dev \(from Resend's test sender/.test(noPassword) && !noPassword.includes('mailbox@ephapse.net'), noPassword.trim().slice(0, 300));
  const smtp = run({ SMTP_HOST: 'smtp.example.org', SMTP_USER: 'Acme <hello@acme.example>', SMTP_PASS: 'x', GMAIL_USER: 'mailbox@ephapse.net', GMAIL_APP_PASSWORD: 'x' });
  check('SMTP_USER, with SMTP_HOST, comes before GMAIL_USER, as in the app', /sender\s+hello@acme\.example \(from SMTP_USER\)/.test(smtp), smtp.trim().slice(0, 300));
  const none = run({ EMAIL_FROM: 'support@ephapse.net' });
  check('with no mail provider set up, it says there is no sender to check', /no mail provider is set up/.test(none), none.trim().slice(0, 300));
  const typedBad = run({}, 'Ephapse <x');
  check('a sender given on the command line that is unusable is said to be unusable', /the one given is not one usable address/.test(typedBad), typedBad.trim().slice(0, 300));
}

console.log(failures === 0 ? '\n\x1b[32mThe address check says what is true.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
