/**
 * The move off the v1 envelope, done by the deployment itself (server/secretsCutover.js,
 * owner 2026-11-12: "bạn làm full giúp tôi"): sealed again in the sweep, counted, and v1
 * refused once two counts an hour apart are clean — kept in the database, so every instance
 * follows without an environment variable changing.
 *
 *   node test/secrets-cutover.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY = 'cutover-test-encryption-key-long-enough-0001';
process.env.SESSION_SECRET ||= 'cutover-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-cutover-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.ENCRYPTION_KEY_PREVIOUS;
delete process.env.ENCRYPTION_REFUSE_V1;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const query = async (text, params = []) => (await db.query(text, params)).rows;
const store = await initStore({ driver: { query } });
const cutover = await import('../server/secretsCutover.js');
const { openSecret, decryptSecret, secretVersion, setSecretPolicy } = await import('../server/crypto.js');

const v1 = (plain, secret = process.env.ENCRYPTION_KEY) => {
  const key = crypto.createHash('sha256').update(`ai-remote:keys:${secret}`).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
};

const user = await store.createUser({ id: 'u-cut', role: 'user', name: 'C', email: 'c@cutover.test', passwordHash: 'x' });
await store.saveConnector(user.id, 'github', v1('ghp_before_v2'), 'octo');
await store.setUserSetting(user.id, 'providerKeys', { openrouter: [{ cipher: v1('sk-or-v1-before'), hint: '…ore' }] });
const token = async () => (await query("SELECT token FROM connectors WHERE user_id = $1 AND service = 'github'", [user.id]))[0].token;

const t0 = Date.parse('2026-11-12T10:00:00Z');

section('the first count seals everything again, and is clean — v1 still opens');
{
  const first = await cutover.cutoverStep({ now: t0 });
  check('sealed again and counted clean, not yet cut over', first.status === 'safe' && first.summary.unopenable === 0 && first.summary.resealed === 0, JSON.stringify(first));
  check('  every value is v2 now, and still opens as its owner', secretVersion(await token()).version === 'v2' && decryptSecret(await token(), ['connector', user.id, 'github']) === 'ghp_before_v2');
  check('  a v1 value still opens until the cutover', openSecret(v1('still-fine')).state === 'ok');
  check('a second count within the hour waits', (await cutover.cutoverStep({ now: t0 + 30 * 60_000 })).status === 'wait');
}

section('an hour on, a second clean count refuses v1, for every instance');
{
  const second = await cutover.cutoverStep({ now: t0 + 61 * 60_000 });
  check('cut over', second.status === 'cut-over', JSON.stringify(second));
  check('  v1 is refused from now on', openSecret(v1('from-an-old-backup')).state === 'refused-v1');
  check('  while v2 opens as before', decryptSecret(await token(), ['connector', user.id, 'github']) === 'ghp_before_v2');
  // Another instance, or a cold start: it reads the word from the database.
  setSecretPolicy({ refuseV1: false });
  await cutover.loadSecretPolicy();
  check('  an instance that starts later reads it from the database', openSecret(v1('x')).state === 'refused-v1');
  const status = await cutover.cutoverStatus();
  check('Settings → Admin is told where it stands, in counts only', status.refuseV1.on === true && status.refuseV1.by === 'cutover' && status.lastCount.safeCounts === 2 && !JSON.stringify(status).includes('ghp_'), JSON.stringify(status));
  check('  and a step after that does nothing', (await cutover.cutoverStep({ now: t0 + 3 * 3600_000 })).status === 'done');
}

section("the owner's word: v1 let in again stays so until they refuse it");
{
  await cutover.setRefuseV1(false);
  check('v1 opens again', openSecret(v1('back-again')).state === 'ok');
  check('  and the automatic move holds off', (await cutover.cutoverStep({ now: t0 + 5 * 3600_000 })).status === 'held');
  await cutover.setRefuseV1(true);
  check('refused again by the owner', openSecret(v1('gone')).state === 'refused-v1' && (await cutover.cutoverStatus()).refuseV1.by === 'owner');
}

section('a value that will not open keeps the cutover from happening');
{
  // A fresh deployment state: the policy and the count cleared.
  await store.setSetting('secrets:refuseV1', {});
  await store.setSetting('secrets:cutover', {});
  setSecretPolicy({ refuseV1: false });
  await store.saveConnector(user.id, 'notion', v1('ntn_lost', 'a-key-nobody-has-any-more'), 'n');
  const a = await cutover.cutoverStep({ now: t0 + 10 * 3600_000 });
  const b = await cutover.cutoverStep({ now: t0 + 12 * 3600_000 });
  check('counted as one that will not open, and never cut over', a.status === 'not-yet' && b.status === 'not-yet' && b.summary.unopenable === 1 && openSecret(v1('ok')).state === 'ok', JSON.stringify(b));
}

setSecretPolicy({ refuseV1: false });
await db.close();
removeTemp(process.env.DATA_DIR);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
