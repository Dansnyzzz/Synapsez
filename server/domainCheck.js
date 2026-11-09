/**
 * Whether people who open this site can be sure it is the real one (owner, 2026-11-09:
 * "protect against DNS spoofing and phishing, so visitors always land on the authentic
 * website"), measured live rather than claimed.
 *
 * What keeps a visitor on the real site is a chain, and each link is checked here:
 *
 *  - **DNSSEC**: the address's DNS answers are signed, so a resolver can tell a forged
 *    one. Asked of two public validating resolvers (Cloudflare and Google), over HTTPS;
 *    their AD flag says they checked the signatures up to the root. A zone that is not
 *    signed is named, with what to do — on `*.vercel.app` that is Vercel's, not ours.
 *  - **HTTPS and HSTS**: even with a forged DNS answer, a browser that insists on HTTPS
 *    needs a certificate for this name, which the forger cannot get. HSTS makes it
 *    insist; the preload list makes it insist on the very first visit too.
 *  - **CAA**: which certificate authorities may issue for the name at all.
 *  - **Mail**: the address this site sends from, with SPF, DKIM's partner DMARC and
 *    MTA-STS, so nobody can send email that passes for it — the usual phishing route.
 *
 * Every lookup is a fixed public endpoint asked about this deployment's own address
 * (`PUBLIC_URL`), never anything a visitor typed.
 */

const RESOLVERS = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/resolve' },
];
const TIMEOUT_MS = 6_000;
const YEAR_S = 365 * 24 * 3600;

/**
 * @typedef {'ok' | 'warn' | 'fail' | 'unknown'} Verdict
 * @typedef {{ id: string, verdict: Verdict, facts: Record<string, any> }} Check
 */

/**
 * One DNS question over HTTPS, with DNSSEC asked for.
 *
 * @param {string} name @param {string} type @param {{ fetchImpl?: typeof fetch, resolver?: typeof RESOLVERS[number] }} [options]
 */
async function ask(name, type, { fetchImpl = fetch, resolver = RESOLVERS[0] } = {}) {
  const url = `${resolver.url}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}&do=1`;
  const res = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${resolver.name} answered ${res.status}`);
  const body = await res.json();
  return { status: Number(body.Status), validated: body.AD === true, answers: Array.isArray(body.Answer) ? body.Answer : [] };
}

/** The name and each parent up to (not including) the top-level domain. @param {string} host */
const upward = (host) => {
  const labels = host.split('.');
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));
};

/** TXT data without its quoting. @param {any} answer */
const text = (answer) => String(answer?.data ?? '').replace(/^"|"$/g, '').replace(/"\s*"/g, '');

/** @param {string} host @param {{ fetchImpl?: typeof fetch }} options @returns {Promise<Check>} */
async function dnssec(host, { fetchImpl }) {
  const answers = await Promise.all(RESOLVERS.map((resolver) => ask(host, 'A', { fetchImpl, resolver }).catch(() => null)));
  const asked = answers.filter(Boolean);
  if (!asked.length) return { id: 'dnssec', verdict: 'unknown', facts: { reason: 'resolvers unreachable' } };
  const validated = asked.every((a) => a.validated);
  if (validated) return { id: 'dnssec', verdict: 'ok', facts: { validatedBy: RESOLVERS.filter((_, i) => answers[i]).map((r) => r.name) } };
  // Which zone breaks the chain: the nearest one up the tree without a DS record at its parent.
  let unsigned = null;
  for (const zone of upward(host)) {
    const ds = await ask(zone, 'DS', { fetchImpl }).catch(() => null);
    if (ds && !ds.answers.some((a) => Number(a.type) === 43)) unsigned = zone;
    else if (ds) break;
  }
  return { id: 'dnssec', verdict: 'fail', facts: { unsignedZone: unsigned, platform: /\.vercel\.app$/.test(host) } };
}

/** @param {string} host @param {{ fetchImpl?: typeof fetch }} options @returns {Promise<Check>} */
async function caa(host, { fetchImpl }) {
  for (const name of upward(host)) {
    const found = await ask(name, 'CAA', { fetchImpl }).catch(() => null);
    if (!found) return { id: 'caa', verdict: 'unknown', facts: {} };
    const records = found.answers.filter((a) => Number(a.type) === 257).map((a) => String(a.data));
    if (records.length) {
      const issuers = records.map((r) => /issue(?:wild)?\s+"([^"]*)"/.exec(r)?.[1]).filter(Boolean);
      return { id: 'caa', verdict: 'ok', facts: { at: name, issuers: [...new Set(issuers)] } };
    }
  }
  return { id: 'caa', verdict: 'warn', facts: { at: null, issuers: [] } };
}

/** @param {string} origin @param {{ fetchImpl?: typeof fetch }} options @returns {Promise<Check[]>} */
async function transport(origin, { fetchImpl }) {
  if (!origin.startsWith('https://')) return [{ id: 'https', verdict: 'fail', facts: { origin } }, { id: 'hsts', verdict: 'fail', facts: {} }];
  let res;
  try {
    res = await fetchImpl(`${origin}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return [{ id: 'https', verdict: 'fail', facts: { error: String(err?.message || err).slice(0, 120) } }, { id: 'hsts', verdict: 'unknown', facts: {} }];
  }
  const header = res.headers.get('strict-transport-security') || '';
  const maxAge = Number(/max-age=(\d+)/i.exec(header)?.[1] || 0);
  const sub = /includesubdomains/i.test(header);
  const preload = /\bpreload\b/i.test(header);
  const verdict = maxAge >= YEAR_S && sub ? 'ok' : header ? 'warn' : 'fail';
  return [
    { id: 'https', verdict: 'ok', facts: { status: res.status } },
    { id: 'hsts', verdict, facts: { maxAge, includeSubDomains: sub, preload } },
  ];
}

/** Whether browsers insist on HTTPS before the first visit: the name or a parent on the preload list. */
async function preloaded(host, { fetchImpl }) {
  const labels = host.split('.');
  const names = [...upward(host), labels[labels.length - 1]];
  for (const name of names) {
    try {
      const res = await fetchImpl(`https://hstspreload.org/api/v2/status?domain=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = await res.json();
      if (body?.status === 'preloaded') return { id: 'preload', verdict: /** @type {Verdict} */ ('ok'), facts: { by: name } };
      if (body?.status === 'pending' && name === host) return { id: 'preload', verdict: /** @type {Verdict} */ ('warn'), facts: { pending: name } };
    } catch {
      return { id: 'preload', verdict: /** @type {Verdict} */ ('unknown'), facts: {} };
    }
  }
  return { id: 'preload', verdict: /** @type {Verdict} */ ('warn'), facts: { by: null } };
}

/** The sender's domain: SPF, DMARC and MTA-STS. @param {string} domain */
async function mail(domain, { fetchImpl }) {
  if (!domain) return { id: 'mail', verdict: /** @type {Verdict} */ ('unknown'), facts: { domain: null } };
  const [root, dmarc, mtaSts] = await Promise.all([
    ask(domain, 'TXT', { fetchImpl }).catch(() => null),
    ask(`_dmarc.${domain}`, 'TXT', { fetchImpl }).catch(() => null),
    ask(`_mta-sts.${domain}`, 'TXT', { fetchImpl }).catch(() => null),
  ]);
  if (!root && !dmarc) return { id: 'mail', verdict: /** @type {Verdict} */ ('unknown'), facts: { domain } };
  const spf = (root?.answers || []).map(text).find((t) => /^v=spf1\b/i.test(t)) || null;
  const policyRecord = (dmarc?.answers || []).map(text).find((t) => /^v=DMARC1\b/i.test(t)) || null;
  const policy = policyRecord ? (/(?:^|;)\s*p=(\w+)/i.exec(policyRecord)?.[1] || '').toLowerCase() : null;
  const sts = (mtaSts?.answers || []).map(text).some((t) => /^v=STSv1\b/i.test(t));
  const verdict = spf && (policy === 'reject' || policy === 'quarantine') ? 'ok' : spf || policy ? 'warn' : 'fail';
  return { id: 'mail', verdict: /** @type {Verdict} */ (verdict), facts: { domain, spf: !!spf, dmarc: policy, mtaSts: sts } };
}

/**
 * Every check, at once. Never throws: a lookup that fails is `unknown`, said as such.
 *
 * @param {{ url?: string, mailFrom?: string, fetchImpl?: typeof fetch, now?: Date }} [options]
 */
export async function checkDomain({ url = process.env.PUBLIC_URL || '', mailFrom = '', fetchImpl = fetch, now = new Date() } = {}) {
  let origin;
  let host;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    host = parsed.hostname.toLowerCase();
  } catch {
    return { host: null, checkedAt: now.toISOString(), checks: [{ id: 'address', verdict: 'fail', facts: { reason: 'PUBLIC_URL is not set' } }] };
  }
  const mailDomain = String(mailFrom).split('@')[1]?.toLowerCase().trim() || '';
  const options = { fetchImpl };
  const settled = await Promise.all([
    dnssec(host, options).catch(() => ({ id: 'dnssec', verdict: 'unknown', facts: {} })),
    transport(origin, options).catch(() => [{ id: 'https', verdict: 'unknown', facts: {} }]),
    preloaded(host, options).catch(() => ({ id: 'preload', verdict: 'unknown', facts: {} })),
    caa(host, options).catch(() => ({ id: 'caa', verdict: 'unknown', facts: {} })),
    mail(mailDomain, options).catch(() => ({ id: 'mail', verdict: 'unknown', facts: {} })),
  ]);
  return { host, checkedAt: now.toISOString(), checks: /** @type {Check[]} */ (settled.flat()) };
}
