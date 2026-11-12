/**
 * Every stored credential re-sealed in the v2 envelope, and again after a key rotation
 * (server/secretsReseal.js, owner 2026-11-12) — with the app still able to open each one
 * afterwards, under the context it belongs to.
 *
 *   node test/secrets-reseal.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY = 'reseal-test-encryption-key-one-long-enough';
process.env.SESSION_SECRET ||= 'reseal-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-reseal-test-${process.pid}`);
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
const { resealSecrets } = await import('../server/secretsReseal.js');
const { decryptSecret, openSecret, secretVersion, currentKeyId } = await import('../server/crypto.js');
const { cloudBrowserContext, mcpConfigContext } = await import('../server/secretContexts.js');

/** A value sealed the v1 way, as everything stored before v2 was. */
const v1 = (plain, secret = process.env.ENCRYPTION_KEY) => {
  const key = crypto.createHash('sha256').update(`ai-remote:keys:${secret}`).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
};

const user = await store.createUser({ id: 'u-reseal', role: 'user', name: 'R', email: 'r@reseal.test', passwordHash: 'x' });
await store.setTotpSecret(user.id, v1('JBSWY3DPEHPK3PXP'));
await store.saveConnector(user.id, 'github', v1('ghp_legacy'), 'octo');
await store.setUserSetting(user.id, 'providerKeys', { openrouter: [{ cipher: v1('sk-or-v1-legacy'), hint: '…acy' }], google: v1('AIza-legacy-single') });
await store.setUserSetting(user.id, 'cloudBrowser', { url: 'https://cb.example', key: v1('cb-key') });
await store.saveMcpServer(user.id, { id: 'srv-r', name: 'R', config: { transport: 'http', url: 'https://mcp.example', headersCipher: v1(JSON.stringify({ Authorization: 'Bearer t' })) }, enabled: true });
const task = await store.createTask(user.id, { id: crypto.randomUUID(), title: 'hook', prompt: 'x', trigger: 'hook' });
const route = await store.createHookRoute(user.id, { id: 'route-r', taskId: task.id, secretEnc: v1('whsec_legacy') });

const versions = async () => {
  const u = (await query('SELECT totp_secret FROM users WHERE id = $1', [user.id]))[0].totp_secret;
  const c = (await query("SELECT token FROM connectors WHERE user_id = $1 AND service = 'github'", [user.id]))[0].token;
  const keys = (await query("SELECT value FROM user_settings WHERE user_id = $1 AND key = 'providerKeys'", [user.id]))[0].value;
  const cb = (await query("SELECT value FROM user_settings WHERE user_id = $1 AND key = 'cloudBrowser'", [user.id]))[0].value;
  const m = (await query("SELECT config FROM mcp_servers WHERE id = 'srv-r'"))[0].config;
  const h = (await query('SELECT secret_enc FROM hook_routes WHERE id = $1', [route.id]))[0].secret_enc;
  return { u, c, or: keys.openrouter[0].cipher, g: keys.google, cb: cb.key, m: m.headersCipher, h };
};

section('a dry run counts, and writes nothing');
{
  const before = await versions();
  const report = await resealSecrets(query);
  const after = await versions();
  check('every kind is found, each due a reseal', report.totp?.resealed === 1 && report.connector?.resealed === 1 && report['provider-key']?.resealed === 2 && report['cloud-browser']?.resealed === 1 && report['mcp-config']?.resealed === 1 && report.hook?.resealed === 1, JSON.stringify(report));
  check('  and nothing changed', JSON.stringify(before) === JSON.stringify(after));
}

section('applied: everything in v2, under the current key, and the app still opens it');
{
  const report = await resealSecrets(query, { apply: true });
  const now = await versions();
  // `written` counts rows: one providerKeys row holds both keys.
  check('every row written, nothing that would not open', Object.values(report).every((t) => t.written > 0 && t.resealed > 0 && t.unopenable === 0 && t.changedMeanwhile === 0), JSON.stringify(report));
  check('  each now v2 under the key that seals', Object.values(now).every((value) => secretVersion(value).version === 'v2' && secretVersion(value).keyId === currentKeyId()), JSON.stringify(Object.values(now).map((v) => secretVersion(v))));
  check('  the TOTP seed opens as its owner', decryptSecret(now.u, ['totp', user.id]) === 'JBSWY3DPEHPK3PXP');
  check('  the connector token, the provider keys (list and single), the hook secret', decryptSecret(now.c, ['connector', user.id, 'github']) === 'ghp_legacy' && decryptSecret(now.or, ['provider-key', user.id, 'openrouter']) === 'sk-or-v1-legacy' && decryptSecret(now.g, ['provider-key', user.id, 'google']) === 'AIza-legacy-single' && decryptSecret(now.h, ['hook', user.id, route.id]) === 'whsec_legacy');
  check('  the cloud browser key and the MCP headers', decryptSecret(now.cb, cloudBrowserContext(user.id, 'https://cb.example')) === 'cb-key' && JSON.parse(decryptSecret(now.m, mcpConfigContext(user.id, 'headers', { transport: 'http', url: 'https://mcp.example' }))).Authorization === 'Bearer t');
  const again = await resealSecrets(query);
  check('a second run finds nothing to do', Object.values(again).every((t) => t.resealed === 0 && t.current > 0), JSON.stringify(again));
}

section('a rotation: the new key seals, the old one opens until the reseal, then can go');
{
  const was = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY_PREVIOUS = was;
  process.env.ENCRYPTION_KEY = 'reseal-test-encryption-key-two-also-long-enough';
  const due = await resealSecrets(query);
  check('everything is due under the new key', Object.values(due).every((t) => t.resealed > 0 && t.unopenable === 0), JSON.stringify(due));
  await resealSecrets(query, { apply: true });
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
  const now = await versions();
  check('  with the old key gone, everything still opens', decryptSecret(now.c, ['connector', user.id, 'github']) === 'ghp_legacy' && decryptSecret(now.or, ['provider-key', user.id, 'openrouter']) === 'sk-or-v1-legacy');
  await store.saveConnector(user.id, 'notion', v1('ntn_lost', 'a-key-nobody-has-any-more'), 'n');
  const stuck = await resealSecrets(query, { apply: true });
  check('a value no key here opens is counted, not lost or overwritten', stuck.connector?.unopenable === 1 && openSecret((await query("SELECT token FROM connectors WHERE service = 'notion'"))[0].token).state === 'undecryptable', JSON.stringify(stuck.connector));
}

section('security review, 2026-11-12: nothing counted fine that is not, and a cutover only on a true "yes"');
{
  const { cutoverReady } = await import('../server/secretsReseal.js');
  const { encryptSecret } = await import('../server/crypto.js');
  // The stuck v1 connector from above makes the verdict "no" until it is gone.
  check('with a value that will not open, the cutover is not safe', !cutoverReady(await resealSecrets(query)));
  await query("DELETE FROM connectors WHERE service = 'notion'");
  check('  with it gone, it is', cutoverReady(await resealSecrets(query)));

  // A v2 value under the current key, bound to another account: not "current" — lost.
  await store.saveConnector(user.id, 'slack', encryptSecret('xoxb-elsewhere', ['connector', 'u-someone-else', 'slack']), 's');
  const misbound = await resealSecrets(query);
  check('a current-key value bound to another owner is counted as one that will not open', misbound.connector?.unopenable === 1 && !cutoverReady(misbound), JSON.stringify(misbound.connector));
  check('  and the count says which key sealed how many', Object.values(misbound.connector?.keys || {}).reduce((a, b) => a + b, 0) === misbound.connector.current + misbound.connector.unopenable + misbound.connector.resealed && (misbound.connector.keys[currentKeyId()] || 0) > 0, JSON.stringify(misbound.connector?.keys));
  await query("DELETE FROM connectors WHERE service = 'slack'");

  // The app writes back what it read: a v1 key read before a reseal, written after, must not undo it.
  const settings = await import('../server/settings.js');
  await store.setUserSetting(user.id, 'providerKeys', { openrouter: [{ cipher: v1('sk-or-v1-raced'), hint: '…ced' }] });
  await settings.addApiKey(user.id, 'openrouter', 'sk-or-v1-second-key');
  const written = (await query("SELECT value FROM user_settings WHERE user_id = $1 AND key = 'providerKeys'", [user.id]))[0].value;
  check('a write-back seals any v1 entry it carries again, so a reseal it raced is not undone', written.openrouter.length === 2 && written.openrouter.every((e) => secretVersion(e.cipher).version === 'v2'), JSON.stringify(written.openrouter.map((e) => secretVersion(e.cipher))));
  check('  and both keys still open as before', decryptSecret(written.openrouter[0].cipher, ['provider-key', user.id, 'openrouter']) === 'sk-or-v1-raced' && decryptSecret(written.openrouter[1].cipher, ['provider-key', user.id, 'openrouter']) === 'sk-or-v1-second-key');
}

section('a deployment service key is sealed per service and row, and reseals with the rest (schema 52)');
{
  const { serviceKeyContext } = await import('../server/secretContexts.js');
  const { encryptSecret } = await import('../server/crypto.js');
  const was = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'reseal-test-encryption-key-three-for-service-keys';
  const sealed = encryptSecret('tvly-service-key', serviceKeyContext('tavily', 'sk-r'));
  await store.addServiceKey({ id: 'sk-r', service: 'tavily', sealed, fingerprint: 'fp-r', hint: '-key', label: null, ceiling: null, addedBy: null });
  process.env.ENCRYPTION_KEY_PREVIOUS = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = was;
  const due = await resealSecrets(query);
  check('a key sealed under the previous key is found under its own kind, due a reseal', due['service-key']?.resealed === 1 && due['service-key'].unopenable === 0, JSON.stringify(due['service-key']));
  const applied = await resealSecrets(query, { apply: true });
  delete process.env.ENCRYPTION_KEY_PREVIOUS;
  const stored = (await query("SELECT sealed FROM service_keys WHERE id = 'sk-r'"))[0].sealed;
  check('  written, now under the current key', applied['service-key']?.written === 1 && secretVersion(stored).keyId === currentKeyId(), JSON.stringify(applied['service-key']));
  check('  and it opens with its service and row, and with no other', decryptSecret(stored, serviceKeyContext('tavily', 'sk-r')) === 'tvly-service-key' && decryptSecret(stored, serviceKeyContext('brave', 'sk-r')) === '' && decryptSecret(stored, serviceKeyContext('tavily', 'sk-other')) === '');
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall passed\x1b[0m');
process.exit(failures ? 1 : 0);
