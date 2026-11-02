/**
 * The cloud computer on E2B (owner, 2026-11-02), with Vercel Sandbox standing in.
 *
 * Nothing here reaches E2B: a stand-in SDK plays the platform, so the suite
 * checks what this app asks of it — who a command runs as, what is paid for,
 * when the other platform is used instead — and leaves "does E2B do what its
 * documentation says" to `npm run e2b:probe`, which runs on the real thing.
 *
 *   node test/e2b.test.mjs
 */
import { PGlite } from '@electric-sql/pglite';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-the-e2b-suite';
for (const name of ['E2B_CREDIT_MILLS', 'E2B_CREDIT_LASTING_MILLS', 'E2B_CREDIT_EXPIRES', 'FREE_TIER_ONLY']) delete process.env[name];

const { initStore } = await import('../server/store/index.js');
const memory = await PGlite.create();
const store = await initStore({ driver: { query: async (text, params = []) => (await memory.query(text, params)).rows } });
const tiers = await import('../server/freeTier.js');

section("E2B's credit: all of it used, none of it overspent (owner, 2026-11-02)");
{
  const at = (iso) => new Date(iso);
  const cap = (usedBefore, iso) => tiers.e2bMonthCap({ usedBefore, now: at(iso), env: {} });
  check('thirteen months before it lapses, a thirteenth of the lapsing $100 (less the margin)', cap(0, '2026-11-15T00:00:00Z') === Math.floor(97_000 / 13), String(cap(0, '2026-11-15T00:00:00Z')));
  check('a quiet start passes its share on: $30 used, ten months left', cap(30_000, '2027-02-03T00:00:00Z') === 6_700, String(cap(30_000, '2027-02-03T00:00:00Z')));
  check('the last month before it lapses may use all that is left of it', cap(90_000, '2027-11-20T00:00:00Z') === 7_000, String(cap(90_000, '2027-11-20T00:00:00Z')));
  check('once the lapsing part is gone, what is left of the lasting $5', cap(97_000, '2027-05-01T00:00:00Z') === 4_850 && cap(98_000, '2027-05-01T00:00:00Z') === 3_850);
  check('after it lapses, only the lasting $5 — untouched if the $100 was never all used', cap(40_000, '2027-12-02T00:00:00Z') === 4_850 && cap(99_000, '2028-03-01T00:00:00Z') === 2_850);
  check('and nothing at all once both are spent', cap(110_000, '2028-03-01T00:00:00Z') === 0);
  check('each figure can be set', tiers.e2bMonthCap({ usedBefore: 0, now: at('2026-11-15T00:00:00Z'), env: { E2B_CREDIT_MILLS: '13000', E2B_CREDIT_EXPIRES: '2027-12-01' } }) === Math.floor(12_610 / 13));

  const now = at('2026-11-15T00:00:00Z');
  const fresh = await tiers.allowance('e2b', now);
  check("the month's allowance is that ceiling", fresh.limit === Math.floor(97_000 / 13) && fresh.left === fresh.limit, JSON.stringify(fresh));
  await tiers.spend('e2b', 25, now);
  const after = await tiers.allowance('e2b', now);
  check('  and what is spent comes off it', after.left === fresh.limit - 25, JSON.stringify(after));
  check('  counted for the month and for the whole credit', (await store.readCounter('free:e2b:2026-11')) === 25 && (await store.readCounter('free:e2b:total')) === 25);
  const next = await tiers.allowance('e2b', at('2026-12-02T00:00:00Z'));
  check("next month's ceiling is worked out from what is left", next.limit === Math.floor((97_000 - 25) / 12), JSON.stringify(next));
  await tiers.exhaust('e2b', now);
  check('E2B saying it is spent closes the month, without counting against the credit', (await tiers.allowance('e2b', now)).left === 0 && (await store.readCounter('free:e2b:total')) === 25);
  const report = await tiers.freeTierReport(now);
  const row = report.services.find((s) => s.service === 'e2b');
  check("the administrators' view has it, with this month's ceiling", row?.limit === Math.floor(97_000 / 13) && row?.per === 'month', JSON.stringify(row));
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll E2B checks passed.\x1b[0m\n');
process.exit(failures ? 1 : 0);
