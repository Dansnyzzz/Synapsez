/**
 * The finance sources, asked from a server address (rule 3, owner 2026-11-10).
 *
 * The research probes (docs/research/2026-11-10-finance-sources.md) ran from the
 * owner's machine, which Cloudflare served from Hong Kong and Tokyo — so none of
 * them says what a Vercel function in iad1 (Washington DC, a US datacenter
 * address) will be answered. This starts one Vercel Sandbox, which runs in iad1
 * unless told otherwise, writes a small Node script into it, and has that script
 * GET each URL of research §3.9 once: status, time, size and the first 120
 * characters of each answer, as one JSON line per URL. Then the sandbox is
 * stopped, whatever happened.
 *
 *   npm run finance:probe                  iad1, the region the app runs in
 *   npm run finance:probe -- --region sin1 Singapore, the check §3.9 suggests when iad1 is refused
 *
 * GET only, nothing posted. Every request says who it is
 * (`Synapsez/<version> (+https://github.com/; market data on request)`) with no
 * Referer or Origin — except Yahoo, asked with the `Mozilla/5.0` the app has
 * always sent it (the one exception the plan keeps), and SEC, asked with
 * SEC_USER_AGENT when it is set and skipped when it is not: SEC wants a real
 * contact, and this file does not invent one. Binance, on §3.9's list, is left
 * out: it is never to be wired, so its answer would decide nothing.
 *
 * Credentials come from the environment only (VERCEL_TOKEN, VERCEL_TEAM_ID,
 * VERCEL_PROJECT_ID, or a Vercel OIDC token). This script never reads a .env
 * file. With none, it says so and exits 2 — it does not make results up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));
const HONEST_UA = `Synapsez/${version} (+https://github.com/; market data on request)`;

const regionArg = process.argv.indexOf('--region');
const region = regionArg > 0 ? String(process.argv[regionArg + 1] || '') : '';

const env = process.env;
const haveToken = !!(env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID);
if (!haveToken && !env.VERCEL_OIDC_TOKEN && !env.VERCEL) {
  console.log(
    '\n  No Vercel Sandbox credentials in the environment (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID, or VERCEL_OIDC_TOKEN).\n' +
      '  The probe cannot start here, and no result has been made up. Run it where those are set.\n',
  );
  process.exit(2);
}

/** Research §3.9, Binance left out (see above). `ua` names which User-Agent the URL is asked with. */
const URLS = [
  { url: 'https://api-finfo.vndirect.com.vn/v4/stock_prices?sort=date&q=code:FPT&size=1&page=1', ua: 'honest' },
  { url: 'https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=FPT&from=1794000000&to=1794300000', ua: 'honest' },
  { url: 'https://kbbuddywts.kbsec.com.vn/iis-server/investment/stocks/FPT/data_day?sdate=03-11-2026&edate=10-11-2026', ua: 'honest' },
  { url: 'https://iq.vietcap.com.vn/api/iq-insight-service/v1/company/FPT/financial-statement?section=INCOME_STATEMENT', ua: 'honest' },
  { url: 'https://trading.vietcap.com.vn/api/price/symbols/getByGroup?group=VN30', ua: 'honest' },
  { url: 'https://www.vietcombank.com.vn/api/exchangerates?date=2026-11-10', ua: 'honest' },
  { url: 'https://sjc.com.vn/GoldPrice/Services/PriceService.ashx', ua: 'honest' },
  { url: 'https://api.fmarket.vn/res/products/23', ua: 'honest' },
  { url: 'https://query1.finance.yahoo.com/v8/finance/chart/FPT.VN?range=5d&interval=1d', ua: 'yahoo' },
  { url: 'https://fc.yahoo.com/', ua: 'yahoo', crumb: true },
  { url: 'https://data.sec.gov/submissions/CIK0000320193.json', ua: 'sec' },
  { url: 'https://www.sec.gov/files/company_tickers.json', ua: 'sec' },
  { url: 'https://api.coingecko.com/api/v3/ping', ua: 'honest' },
  { url: 'https://api.frankfurter.dev/v2/rate/USD/VND', ua: 'honest' },
  { url: 'https://api.worldbank.org/v2/country/VN/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrv=1', ua: 'honest' },
  { url: 'https://pxweb.nso.gov.vn/api/v1/vi/', ua: 'honest' },
];

/**
 * What runs inside the sandbox. Plain Node 22, no packages. The Yahoo crumb is a
 * session token, so only its length is printed, never the value or the cookie.
 */
const INSIDE = `
const URLS = ${JSON.stringify(URLS)};
const UA = { honest: ${JSON.stringify(HONEST_UA)}, yahoo: 'Mozilla/5.0', sec: process.env.SEC_USER_AGENT || '' };
async function get(url, ua, extra = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json, text/plain, */*', ...extra }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    return { res, row: { url, status: res.status, ms: Date.now() - started, bytes: Buffer.byteLength(text), first120: text.slice(0, 120).replace(/\\s+/g, ' ') }, text };
  } catch (err) {
    return { res: null, row: { url, status: 0, ms: Date.now() - started, bytes: 0, first120: String(err && (err.cause && err.cause.code || err.name) || err).slice(0, 120) }, text: '' };
  }
}
for (const item of URLS) {
  if (item.ua === 'sec' && !UA.sec) { console.log(JSON.stringify({ url: item.url, status: 'skipped', ms: 0, bytes: 0, first120: 'SEC_USER_AGENT is not set' })); continue; }
  const { res, row } = await get(item.url, UA[item.ua]);
  console.log(JSON.stringify(row));
  if (item.crumb) {
    const cookies = res && typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') : '';
    const crumb = await get('https://query2.finance.yahoo.com/v1/test/getcrumb', UA.yahoo, cookies ? { Cookie: cookies } : {});
    const looks = /^[A-Za-z0-9./_-]{6,20}$/.test(crumb.text.trim());
    console.log(JSON.stringify({ ...crumb.row, first120: looks ? 'a crumb of ' + crumb.text.trim().length + ' characters (value not printed); cookie set: ' + !!cookies : crumb.row.first120 }));
  }
  await new Promise((r) => setTimeout(r, 1100));
}
`;

const { Sandbox } = await import('@vercel/sandbox');
const credentials = haveToken ? { token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID } : {};
let box = null;
let failed = false;
try {
  box = await Sandbox.create({
    ...credentials,
    ...(region ? { region } : {}),
    runtime: 'node22',
    timeout: 5 * 60 * 1000,
    resources: { vcpus: 2 },
    networkPolicy: 'allow-all',
    persistent: false,
    tags: { app: 'synapsez', role: 'finance-probe' },
  });
  await box.writeFiles([{ path: 'finance-probe.mjs', content: Buffer.from(INSIDE) }]);
  const done = await box.runCommand({ cmd: 'node', args: ['finance-probe.mjs'], env: env.SEC_USER_AGENT ? { SEC_USER_AGENT: env.SEC_USER_AGENT } : {}, timeoutMs: 4 * 60 * 1000 });
  const [out, err] = await Promise.all([done.stdout(), done.stderr()]);
  const rows = out
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
  console.log(`\n  Asked from a Vercel Sandbox${region ? ` in ${region}` : ' (default region, iad1)'}, ${new Date().toISOString()}\n`);
  console.log('| URL | status | ms | bytes | first 120 characters |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.url} | ${r.status} | ${r.ms} | ${r.bytes} | ${String(r.first120).replace(/\|/g, '\\|')} |`);
  if (err.trim()) console.log(`\n  stderr:\n${err.slice(0, 2000)}`);
  if (done.exitCode !== 0) failed = true;
} catch (err) {
  failed = true;
  console.log(`\n  The sandbox could not run the probe: ${String(err?.message || err).slice(0, 300)}\n`);
} finally {
  await box?.stop?.().catch(() => {});
}
process.exit(failed ? 1 : 0);
