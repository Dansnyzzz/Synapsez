/**
 * Re-seal every stored credential in the v2 envelope under the current key.
 *
 *   npm run secrets:reseal                              count; writes nothing
 *   npm run secrets:reseal -- --apply --key-id <id>     re-seal and write
 *
 * Reads DATABASE_URL (or POSTGRES_URL), ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS from the
 * environment — the deployment's, not a laptop's (`node --env-file=… scripts/reseal-secrets.mjs`).
 * With no DATABASE_URL it opens this machine's own local database (DATA_DIR), which the app
 * must not have open at the same time: the same lock the app takes refuses a second opener.
 *
 * `--apply` needs `--key-id`: the id of the key that seals on the deployment, as Settings →
 * Admin → Free tier shows it. Sealing with a key the deployment does not have yet would leave
 * every credential there unreadable (security review, 2026-11-12), so the two must match.
 *
 * After writing it counts again — up to three passes, for rows the app changed during the
 * run — and says whether the cutover is safe: nothing left to re-seal, nothing that will not
 * open, nothing changed meanwhile. Only on "yes" set ENCRYPTION_REFUSE_V1=true or drop an
 * older key from ENCRYPTION_KEY_PREVIOUS. Exits 1 on anything short of "yes" after --apply,
 * so a script around it stops. Prints counts and key ids only.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/store/driver.js';
import { resealSecrets, cutoverReady } from '../server/secretsReseal.js';
import { currentKeyId } from '../server/crypto.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const named = (() => {
  const at = argv.indexOf('--key-id');
  return at >= 0 ? String(argv[at + 1] || '').trim() : '';
})();

let here;
try {
  here = currentKeyId();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
if (apply && named !== here) {
  console.error(
    `\n  --apply needs --key-id ${named ? `matching this environment's key (it is ${here}, not ${named})` : '<id>'}.\n` +
      "  Use the id Settings → Admin → Free tier shows for the deployment. If they differ, this environment does not\n" +
      '  have the key the deployment seals with, and writing now would leave every credential there unreadable.\n',
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
let query;
let close = async () => {};
if (url) {
  const driver = await openDatabase(url);
  query = async (text, params = []) => driver.query(text, params);
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { createPgliteStore } = await import('../server/store/pglite.js');
  const store = await createPgliteStore(process.env.DATA_DIR || path.join(root, 'data'));
  await store.init();
  query = store.rawQuery;
  close = store.close;
}

const print = (report, { written = false } = {}) => {
  const keys = {};
  for (const [kind, t] of Object.entries(report)) {
    console.log(`  ${kind.padEnd(14)} current ${String(t.current).padStart(4)}   to reseal ${String(t.resealed).padStart(4)}   cannot open ${String(t.unopenable).padStart(4)}${written ? `   written ${t.written}, changed meanwhile ${t.changedMeanwhile}` : ''}`);
    for (const [id, n] of Object.entries(t.keys || {})) keys[id] = (keys[id] || 0) + n;
  }
  if (!Object.keys(report).length) console.log('  Nothing stored yet.');
  else console.log(`\n  Sealed by: ${Object.entries(keys).map(([id, n]) => `${id === here ? `${id} (seals now)` : id} ${n}`).join(', ')}`);
};

console.log(`\n  Key that seals here: ${here}   ${apply ? 'APPLYING' : 'dry run — nothing written (add --apply --key-id <id> to write)'}\n`);
let report = await resealSecrets(query, { apply });
print(report, { written: apply });
if (apply) {
  // Rows the app changed under the run are left alone by the compare-and-set; the next
  // pass picks them up. Three is plenty: a key added mid-run is sealed v2 by the app itself.
  for (let pass = 1; pass < 3 && Object.values(report).some((t) => t.changedMeanwhile > 0); pass += 1) {
    console.log(`\n  Pass ${pass + 1}, for rows changed during the last:`);
    report = await resealSecrets(query, { apply: true });
    print(report, { written: true });
  }
  report = await resealSecrets(query);
  console.log('\n  Counted again after writing:');
  print(report);
}

const stuck = Object.values(report).reduce((n, t) => n + t.unopenable, 0);
if (stuck) console.log(`\n  ${stuck} value(s) could not be opened with the keys in this environment: put the key that sealed them in ENCRYPTION_KEY_PREVIOUS, or the person enters them again.`);
const safe = cutoverReady(report);
console.log(`\n  Safe to set ENCRYPTION_REFUSE_V1=true and drop older keys from ENCRYPTION_KEY_PREVIOUS: ${safe ? 'yes' : 'no'}\n`);
await close();
process.exit(apply && !safe ? 1 : 0);
