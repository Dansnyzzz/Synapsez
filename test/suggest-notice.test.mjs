/**
 * Suggested models changed: everyone hears once (owner, 2026-11-10, spec A §E).
 *
 * When an administrator changes the suggested models, every account is told once —
 * at its next visit, or within the 20-second poll if it is on the page — and either
 * answer, or closing it, is the end of it until the next change. Nothing is shown for
 * a change made before the account existed, nor to the administrator who made it.
 *
 *   node test/suggest-notice.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'suggest-notice-test-encryption-key';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-suggest-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
const store = await initStore({ driver: sql });

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { setRecommended, getRecommended } = await import('../server/recommend.js');
const { suggestionNotice, markSuggestionSeen, recommendedVersion } = await import('../server/suggestionNotice.js');

const id = () => crypto.randomUUID();
const before = await store.createUser({ id: id(), role: 'user', name: 'Early', email: 'early@suggest.test', passwordHash: 'x' });
await sql.query("UPDATE users SET created_at = NOW() - interval '30 days' WHERE id = $1", [before.id]);

section('a change gets a version; saving the same choice again does not');
{
  check('no version before anybody chose', (await getRecommended()).version == null);
  const first = await setRecommended({ free: 'auto' });
  check('the first choice is stamped', typeof first.version === 'string' && !Number.isNaN(Date.parse(first.version)), JSON.stringify(first));
  await new Promise((r) => setTimeout(r, 20));
  const again = await setRecommended({ free: 'auto' });
  check('  the same choice again keeps its stamp', again.version === first.version, `${first.version} / ${again.version}`);
  check('the version is cheap to read for the 20-second poll', (await recommendedVersion()) === first.version);
}

section('everyone hears once');
{
  const user = await store.getUserById(before.id);
  const notice = await suggestionNotice(user, { recommended: { free: { id: 'auto', label: 'Auto' }, freeSecond: null, paid: null } });
  check('an account made before the change is told', !!notice && notice.version === (await recommendedVersion()) && notice.free?.label === 'Auto', JSON.stringify(notice));
  await markSuggestionSeen(user.id, notice.version);
  check('  once: after its answer, not again', (await suggestionNotice(user, { recommended: {} })) === null);
  const rec = await store.getSetting('recommended_models');
  await store.setSetting('recommended_models', { ...rec, version: new Date(Date.now() + 1000).toISOString() });
  check('a later change is told again', !!(await suggestionNotice(user, { recommended: {} })));
  const late = await store.createUser({ id: id(), role: 'user', name: 'Late', email: 'late@suggest.test', passwordHash: 'x' });
  await sql.query("UPDATE users SET created_at = NOW() + interval '1 day' WHERE id = $1", [late.id]);
  check('an account made after the change is not told about it', (await suggestionNotice(await store.getUserById(late.id), { recommended: {} })) === null);
  check('a version that is not a time is refused when marked seen', (await markSuggestionSeen(user.id, 'not a time').then(() => 'kept', () => 'refused')) === 'refused');
}

console.log(failures === 0 ? '\n\x1b[32mAll suggestion notice checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
