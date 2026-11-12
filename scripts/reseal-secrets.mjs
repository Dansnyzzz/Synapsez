/**
 * Re-seal every stored credential in the v2 envelope under the current key.
 *
 *   npm run secrets:reseal              count what would change; writes nothing
 *   npm run secrets:reseal -- --apply   re-seal and write
 *
 * Reads DATABASE_URL (or POSTGRES_URL), ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS from
 * the environment (`node --env-file=.env …`, or the deployment's settings). Run it after
 * the v2 envelope ships, and after each rotation; then ENCRYPTION_REFUSE_V1=true can be
 * set, and an old key removed from ENCRYPTION_KEY_PREVIOUS. Prints counts only.
 *
 * A local database (no DATABASE_URL) is the app's own PGlite folder: stop the app first,
 * and run with DATABASE_URL pointing at it, or leave it — v1 values keep opening.
 */
import { openDatabase } from '../server/store/driver.js';
import { resealSecrets } from '../server/secretsReseal.js';
import { currentKeyId } from '../server/crypto.js';

const apply = process.argv.includes('--apply');
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('\n  No DATABASE_URL. Run with the deployment\'s database address in the environment (node --env-file=.env scripts/reseal-secrets.mjs).\n');
  process.exit(1);
}

const driver = await openDatabase(url);
const query = async (text, params = []) => driver.query(text, params);
const report = await resealSecrets(query, { apply });

console.log(`\n  Key that seals now: ${currentKeyId()}   ${apply ? 'APPLIED' : 'dry run — nothing written (add --apply to write)'}\n`);
for (const [kind, t] of Object.entries(report)) {
  console.log(`  ${kind.padEnd(14)} current ${String(t.current).padStart(4)}   to reseal ${String(t.resealed).padStart(4)}   cannot open ${String(t.unopenable).padStart(4)}${apply ? `   written ${t.written}, changed meanwhile ${t.changedMeanwhile}` : ''}`);
}
if (!Object.keys(report).length) console.log('  Nothing stored yet.');
const stuck = Object.values(report).reduce((n, t) => n + t.unopenable, 0);
if (stuck) console.log(`\n  ${stuck} value(s) could not be opened with the keys in this environment: put the key that sealed them in ENCRYPTION_KEY_PREVIOUS, or the person re-enters them.`);
console.log('');
process.exit(0);
