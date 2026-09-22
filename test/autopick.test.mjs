/**
 * Auto model — OpenRouter's free router.
 *
 * Auto no longer ranks our library; it expands to `openrouter/free`, which
 * OpenRouter routes per request to a free model that supports what the request
 * needs. What the tests pin: the expansion is exactly that router, it is free
 * and never blocks an image, a concrete id is untouched, and Auto is refused
 * (not quietly swapped for something paid) when no OpenRouter key is usable —
 * dropped only when EVERY key is resting.
 *
 *   node test/autopick.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'autopick-test-encryption-key';
process.env.SESSION_SECRET ||= 'autopick-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-autopick-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
removeTemp(process.env.DATA_DIR);

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { initStore } = await import('../server/store/index.js');
const store = await initStore();
const { hashPassword } = await import('../server/crypto.js');
const { pickAutoModel, resolveForUser, AUTO_ROUTER, isAuto } = await import('../server/autoPick.js');
const { setApiKey, addApiKey, markKeyLimited, clearKeyRest } = await import('../server/settings.js');

const uid = 'u-auto';
await store.createUser({
  id: uid,
  email: 'auto@example.com',
  name: 'Auto',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

/** Seed one shared-library row, filling the shape `normalise` produces. */
const model = (over) => ({
  id: over.id,
  provider: over.provider || 'openrouter',
  model: over.id.split('/').slice(1).join('/'),
  family: over.family,
  label: over.id,
  description: null,
  context: 64_000,
  maxOutput: 8192,
  priceIn: 0,
  priceOut: 0,
  isFree: true,
  vision: false,
  releasedAt: '2026-01-01T00:00:00.000Z',
});

await store.upsertModels([
  model({ id: 'openrouter/deepseek/deepseek-r1:free', family: 'deepseek' }),
  model({ id: 'orcarouter/deepseek/x:free', family: 'deepseek', provider: 'orcarouter' }),
]);

// The deployment's shared key would make every account reachable; this suite
// is about the account's own keys.
delete process.env.OPENROUTER_API_KEY;

section("auto expands to OpenRouter's free router");
{
  await setApiKey(uid, 'openrouter', 'k1');
  clearKeyRest(uid, 'openrouter');
  const m = await pickAutoModel(uid);
  check('the id is openrouter/free on the openrouter provider', m?.provider === 'openrouter' && m?.model === 'openrouter/free', m?.id);
  check('it is free', m?.isFree === true && m?.price?.in === 0 && m?.price?.out === 0);
  check('it never blocks an image — the router picks a model that reads it', m?.vision === true);
  check('only the special id is auto', isAuto('auto') && !isAuto('openrouter/openrouter/free'));
  check('the returned entry is a copy, not the frozen constant', m !== AUTO_ROUTER);
}

section('auto is dropped only when every OpenRouter key is resting');
{
  await setApiKey(uid, 'openrouter', 'k1');
  await addApiKey(uid, 'openrouter', 'k2');
  clearKeyRest(uid, 'openrouter');
  markKeyLimited(uid, 'openrouter', 0, Date.now() + 60_000);
  check('one resting key of two keeps auto available', (await pickAutoModel(uid))?.model === 'openrouter/free');
  markKeyLimited(uid, 'openrouter', 1, Date.now() + 60_000);
  check('both keys resting leaves auto unavailable', (await pickAutoModel(uid)) === null);
  clearKeyRest(uid, 'openrouter');
}

section('an OrcaRouter key alone does not run auto');
{
  await setApiKey(uid, 'openrouter', '');
  await setApiKey(uid, 'orcarouter', 'sk-orca-k');
  check('no OpenRouter key yields null', (await pickAutoModel(uid)) === null);
}

section('resolveForUser expands auto, and passes a real id straight through');
{
  await setApiKey(uid, 'openrouter', 'k1');
  clearKeyRest(uid, 'openrouter');
  const real = await resolveForUser(uid, 'anthropic/claude-opus-5');
  check('a concrete id resolves to that model', real?.id === 'anthropic/claude-opus-5', real?.id);
  const picked = await resolveForUser(uid, 'auto');
  check('auto resolves to the free router', picked?.model === 'openrouter/free', picked?.id);

  await setApiKey(uid, 'openrouter', '');
  let threw = '';
  try {
    await resolveForUser(uid, 'auto');
  } catch (err) {
    threw = err.message;
  }
  check('auto with no OpenRouter key throws a clear error', /OpenRouter key/i.test(threw), threw);
}

section('the library filters by provider, so a row limit cannot hide one');
{
  // The bug this pins: with hundreds of models and a default limit, the newest
  // (mostly one aggregator) fill the page and the other aggregator's models
  // never reach the client. A provider filter at the database keeps each one
  // reachable on its own tab.
  const orca = await store.listSharedModels({ provider: 'orcarouter', limit: 500 });
  check('only orcarouter rows come back', orca.length >= 1 && orca.every((m) => m.provider === 'orcarouter'), `${orca.length}`);
  const or = await store.listSharedModels({ provider: 'openrouter', limit: 500 });
  check('and openrouter is a separate set', or.length >= 1 && or.every((m) => m.provider === 'openrouter'), `${or.length}`);
  const all = await store.listSharedModels({ limit: 500 });
  check('no provider filter still returns both', all.some((m) => m.provider === 'orcarouter') && all.some((m) => m.provider === 'openrouter'));
}

/* ── models that stopped existing ──────────────────────────────── */

/**
 * The library only ever grew, and that was the bug behind the worst failure
 * this app has: an account whose default model had been withdrawn could not
 * send a message at all. Every request came back as the provider's own 404 —
 * in one case a cheerful note thanking the user for taking part in a preview —
 * shown in red, in English, on every attempt, with nothing saying that the
 * model was the problem or that the picker was the fix.
 *
 * A refresh now forgets what its source has stopped listing. The guard that
 * matters is the second half: a source that is *down* lists nothing, and
 * reading that as "everything was withdrawn" would empty the library on an
 * outage, which is worse than the problem being solved.
 */
section('a refresh forgets the models its source no longer lists');
{
  await store.upsertModels([
    model({ id: 'openrouter/lab/gone-tomorrow', family: 'lab' }),
    model({ id: 'openrouter/lab/still-here', family: 'lab' }),
    model({ id: 'orcarouter/lab/untouched', family: 'lab', provider: 'orcarouter' }),
  ]);

  const dropped = await store.pruneMissingModels('openrouter', [
    'openrouter/lab/still-here',
    'openrouter/deepseek/deepseek-r1:free',
  ]);
  check('the withdrawn one is removed', dropped >= 1, `${dropped}`);

  const ids = (await store.listSharedModels({ limit: 500 })).map((m) => m.id);
  check('and is out of the picker', !ids.includes('openrouter/lab/gone-tomorrow'), ids.join(', '));
  check('the one still listed stays', ids.includes('openrouter/lab/still-here'));
  // Scoped to the provider that answered: OrcaRouter being slow or down must
  // not cost OpenRouter's half of the library, or the other way round.
  check('another aggregator is untouched', ids.includes('orcarouter/lab/untouched'));

  const nothing = await store.pruneMissingModels('openrouter', []);
  check('an empty list prunes nothing at all', nothing === 0, `${nothing}`);
  check(
    'so a source that is down cannot empty the library',
    (await store.listSharedModels({ limit: 500 })).some((m) => m.id === 'openrouter/lab/still-here'),
  );
}

await store.close?.();
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n\x1b[32mAll auto-pick checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
