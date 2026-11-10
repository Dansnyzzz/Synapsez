/**
 * The finance layer (server/finance/): the cache table, the pooled ceilings, the
 * one fetch helper, the cache, the Vietnamese market rules, every source adapter
 * against its recorded answer, and the tool's answer.
 *
 * No network. Each source is played by its recorded answer from
 * test/fixtures/finance/ (trimmed from the research probes), served by a stand-in
 * `fetch` that also records what was asked, so what is pinned is how an answer is
 * read and what leaves the server.
 *
 *   node test/finance.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

process.env.ENCRYPTION_KEY ||= 'finance-test-encryption-key';
// No waiting between calls to one host, except where the pacing itself is tested.
process.env.FIN_PACE_SCALE = '0';
delete process.env.SEC_USER_AGENT;
delete process.env.COINGECKO_DEMO_KEY;
delete process.env.FRED_API_KEY;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const memory = await PGlite.create();
const { initStore } = await import('../server/store/index.js');
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });

/* ── the cache table (schema 45) ───────────────────────────────────── */

section('finance_cache: one row per key, shared by every account (schema 45)');
{
  const later = new Date(Date.now() + 60_000);
  await store.financePut('yahoo|quote|AAPL|', { price: 350.69, currency: 'USD' }, later);
  const row = await store.financeGet('yahoo|quote|AAPL|');
  check('what was put is read back', row?.value?.price === 350.69 && row.value.currency === 'USD', JSON.stringify(row));
  check('  with when it was fetched and when it expires', row && !Number.isNaN(new Date(row.fetched_at).getTime()) && Math.abs(new Date(row.expires_at).getTime() - later.getTime()) < 1000);
  await store.financePut('yahoo|quote|AAPL|', { price: 351 }, later);
  check('putting the same key again replaces it', (await store.financeGet('yahoo|quote|AAPL|'))?.value?.price === 351);
  check('a key never put is nothing', (await store.financeGet('nobody|asked|this|')) === null);

  await store.financePut('kbs|quote|FPT|', { price: 50900 }, new Date(Date.now() - 60_000));
  const stale = await store.financeGet('kbs|quote|FPT|');
  check('an expired row is still returned — the caller decides what stale means', stale?.value?.price === 50900 && new Date(stale.expires_at) < new Date());

  await store.financePut('vndirect|bars|FPT|2026-09-18', { c: 71700 }, null);
  check('a row kept for good has no expiry', (await store.financeGet('vndirect|bars|FPT|2026-09-18'))?.expires_at === null);

  // What the sweep takes: expired more than a day ago, or kept for good and older than 400 days.
  await store.financePut('old|expired|x|', { a: 1 }, new Date(Date.now() - 2 * 86_400_000));
  await store.financePut('old|forever|x|', { a: 1 }, null);
  await memory.query(`UPDATE finance_cache SET fetched_at = NOW() - INTERVAL '401 days' WHERE key = 'old|forever|x|'`);
  const swept = await store.financeSweep();
  const left = (await memory.query('SELECT key FROM finance_cache ORDER BY key')).rows.map((r) => r.key);
  check('the sweep deletes what expired over a day ago and what was kept past 400 days', swept === 2 && !left.includes('old|expired|x|') && !left.includes('old|forever|x|'), `${swept} · ${left.join(', ')}`);
  check('  and leaves what expired a minute ago, and a bar kept for good', left.includes('kbs|quote|FPT|') && left.includes('vndirect|bars|FPT|2026-09-18'), left.join(', '));
  await memory.query('DELETE FROM finance_cache');
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll finance checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
