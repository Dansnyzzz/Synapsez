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

  // A partial answer that still lists something is the harder case.
  await store.upsertModels(Array.from({ length: 60 }, (_, i) => model({ id: `openrouter/lab/m${i}`, family: 'lab' })));
  const partial = await store.pruneMissingModels('openrouter', ['openrouter/lab/m0']);
  check('an answer missing most of the library prunes nothing', partial === 0, `${partial}`);
  check('  and the library is intact', (await store.listSharedModels({ limit: 500 })).filter((m) => m.id.startsWith('openrouter/lab/m')).length === 60);
}

section('a model leaves the library on the day its provider ends it');
{
  const { __testing, resolve, refreshIfStale } = await import('../server/models.js');
  const { expiryOf, hasExpired, normalise } = __testing;

  // OpenRouter's "Going away September 25, 2026", as the API publishes it.
  check('a bare day is read as the start of that day, UTC', expiryOf({ expiration_date: '2026-09-25' }) === '2026-09-25T00:00:00.000Z');
  check('no date is no end', expiryOf({}) === null && expiryOf({ expiration_date: '' }) === null);
  check('nonsense is not a date', expiryOf({ expiration_date: 'soon' }) === null);
  const n = normalise({ id: 'nex-agi/nex-n2.5-mini:free', pricing: { prompt: '0', completion: '0' }, expiration_date: '2026-09-25' });
  check('the end date travels with the model', n.expiresAt === '2026-09-25T00:00:00.000Z', n.expiresAt);
  check('  and is past on the 26th', hasExpired(n, Date.parse('2026-09-26T01:00:00Z')));
  check('  and not on the 24th', !hasExpired(n, Date.parse('2026-09-24T23:00:00Z')));

  const past = new Date(Date.now() - 3600_000).toISOString();
  const soon = new Date(Date.now() + 7 * 86400_000).toISOString();
  await store.upsertModels([
    { ...model({ id: 'openrouter/nex-agi/ended:free', family: 'nex-agi' }), expiresAt: past },
    { ...model({ id: 'openrouter/lab/ending-soon:free', family: 'lab' }), expiresAt: soon },
    { ...model({ id: 'openrouter/lab/paid-ended', family: 'lab' }), priceIn: 1, priceOut: 2, isFree: false, expiresAt: past },
  ]);
  const listed = (await store.listSharedModels({ tier: 'free', limit: 500 })).map((m) => m.id);
  check('an ended free model is gone from the Free list at once', !listed.includes('openrouter/nex-agi/ended:free'));
  check('one with a week left is still there', listed.includes('openrouter/lab/ending-soon:free'));
  const soonRow = (await store.listSharedModels({ limit: 500 })).find((m) => m.id === 'openrouter/lab/ending-soon:free');
  check('  carrying its date for the picker', !!soonRow?.expires_at);

  // Somebody whose default was the ended free model is moved to the free
  // router and told — never to the paid version of the same model.
  const moved = await resolve('openrouter/nex-agi/ended:free');
  check('an ended free model resolves to the free router', moved.id === AUTO_ROUTER.id, moved.id);
  check('  saying which model it replaced', !!moved.retiredFrom, String(moved.retiredFrom));
  check('  and it is free', moved.price?.in === 0 && moved.price?.out === 0);
  const vanished = await resolve('openrouter/some/withdrawn:free');
  check('a free id the library no longer has also goes to the free router', vanished.id === AUTO_ROUTER.id, vanished.id);
  // Owner's call, 2026-10-06: a model that has gone moves to Auto whatever it
  // cost — refusing in words left every scheduled task on it failing for ever.
  // Auto is free, so this can only ever lower a bill, never start one.
  const paid = await resolve('openrouter/lab/paid-ended');
  check('an ended paid model also resolves to the free router', paid.id === AUTO_ROUTER.id && !!paid.retiredFrom, `${paid.id} ${paid.retiredFrom}`);
  check('  which is free', paid.price?.in === 0 && paid.price?.out === 0);
  // A stealth preview has no `:free` in its id and was not caught: its row is
  // pruned when OpenRouter stops listing it, and the next call is a 404.
  const stealth = await resolve('openrouter/stealth/space-bunny-alpha');
  check('a withdrawn model without :free in its id goes to the free router too', stealth.id === AUTO_ROUTER.id && stealth.retiredFrom === 'stealth/space-bunny-alpha', `${stealth.id} ${stealth.retiredFrom}`);
  // An empty half of the library proves nothing — a first deploy, a refresh that
  // never landed. OrcaRouter's half is emptied here to be that.
  await store.pruneMissingModels('orcarouter', ['orcarouter/nothing-listed']);
  check('  (OrcaRouter\'s half of the library is empty for the next checks)', (await store.listSharedModels({ provider: 'orcarouter', limit: 5 })).length === 0);
  const unknown = await resolve('orcarouter/some/model');
  check('an id from a provider the library knows nothing about is left alone', unknown.id !== AUTO_ROUTER.id && !unknown.retiredFrom, unknown.id);

  section('the account is moved off a model that has gone, and told once');
  {
    const { goneModel, isModelGoneError, settleAccountModel } = await import('../server/modelRetirement.js');
    const { getPrefs, setPrefs } = await import('../server/settings.js');
    check('an ended model is gone', (await goneModel('openrouter/nex-agi/ended:free'))?.label === 'openrouter/nex-agi/ended:free');
    check('a pruned one is gone', (await goneModel('openrouter/stealth/space-bunny-alpha'))?.label === 'space-bunny-alpha');
    check('one with a week left is not', (await goneModel('openrouter/lab/ending-soon:free')) === null);
    check('a built-in is never gone here — it has a successor', (await goneModel('anthropic/claude-opus-5')) === null);
    check('Auto is never gone', (await goneModel('auto')) === null);
    check('nor is a model from an empty half of the library', (await goneModel('orcarouter/some/model')) === null);

    check('"No endpoints found for <model>" means the model has gone', isModelGoneError(new Error('404 No endpoints found for stealth/space-bunny-alpha.')));
    check('  and so does a provider\'s retirement notice', isModelGoneError('This model has been deprecated. Thank you for participating in the testing period.'));
    check('  but the strict privacy setting refusing every endpoint does not', !isModelGoneError('No endpoints found matching your data policy (Free model publication)'));
    check('  nor does an ordinary failure', !isModelGoneError(new Error('429 Too Many Requests')) && !isModelGoneError(new Error('500 Internal Server Error')));
  // It moves an account for good, so the words alone are not enough.
  check('  nor a 400 that says "deprecated" about a parameter', !isModelGoneError(Object.assign(new Error('400 The `functions` parameter is deprecated; use `tools`.'), { status: 400 })));
  check('  nor those words about something that is not the model', !isModelGoneError('The image URL does not exist.'));
  check('  while a 404 carrying the notice is the model gone', isModelGoneError(Object.assign(new Error('This model has been retired.'), { status: 404 })));

    // With no OpenRouter key, Auto cannot run: the account is left as it is,
    // and the turn says the model has gone and to pick another.
    const { setApiKey: setKey } = await import('../server/settings.js');
    await setKey(uid, 'openrouter', '');
    const savedShared = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await setPrefs(uid, { defaultModel: 'openrouter/stealth/space-bunny-alpha', modelNotice: null });
    const unmoved = await settleAccountModel(uid, await getPrefs(uid));
    check('without an OpenRouter key the account is not moved to an Auto it cannot run', unmoved.defaultModel === 'openrouter/stealth/space-bunny-alpha' && !unmoved.modelNotice, unmoved.defaultModel);
    if (savedShared !== undefined) process.env.OPENROUTER_API_KEY = savedShared;
    await setKey(uid, 'openrouter', 'sk-or-v1-autopick-placeholder');

    await setPrefs(uid, { defaultModel: 'openrouter/stealth/space-bunny-alpha' });
    const settled = await settleAccountModel(uid, await getPrefs(uid));
    check('an account on a gone model is moved to Auto', settled.defaultModel === 'auto', settled.defaultModel);
    check('  and left a notice naming what it was on', settled.modelNotice?.from === 'space-bunny-alpha' && !!settled.modelNotice?.at, JSON.stringify(settled.modelNotice));
    const stored = await getPrefs(uid);
    check('  stored, so the next visit and the next scheduled run see it', stored.defaultModel === 'auto' && stored.modelNotice?.from === 'space-bunny-alpha');
    await setPrefs(uid, { defaultModel: 'openrouter/lab/ending-soon:free', modelNotice: null });
    const kept = await settleAccountModel(uid, await getPrefs(uid));
    check('an account on a live model is left exactly where it is', kept.defaultModel === 'openrouter/lab/ending-soon:free' && !kept.modelNotice);
  }

  // Fresh as of six this morning, the asking person's time.
  const status = await store.modelLibraryStatus();
  const refreshed = new Date(status.refreshedAt);
  let refreshedAgain = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    refreshedAgain = true;
    throw new Error('offline in the suite');
  };
  try {
    // An hour after the last refresh, and still before six there: fresh.
    const tz = 'Asia/Ho_Chi_Minh';
    const { lastLocalHour } = await import('../server/util/zone.js');
    check(
      'six this morning in Hanoi, seen from noon there, is 23:00 UTC the day before',
      lastLocalHour(6, tz, new Date('2026-09-27T05:00:00Z')).toISOString() === '2026-09-26T23:00:00.000Z',
    );
    check(
      '  and seen from five in the morning, it is the previous day’s six',
      lastLocalHour(6, tz, new Date('2026-09-26T22:00:00Z')).toISOString() === '2026-09-25T23:00:00.000Z',
    );
    check('an unknown zone reads as UTC rather than failing', lastLocalHour(6, 'Not/AZone', new Date('2026-03-01T05:00:00Z')).toISOString() === '2026-02-28T06:00:00.000Z');
    const six = lastLocalHour(6, tz, new Date(refreshed.getTime() + 60_000));
    const beforeNextSix = new Date(six.getTime() + 86400_000 - 60_000);
    await refreshIfStale({ tz, now: refreshed.getTime() < six.getTime() ? six : beforeNextSix });
    const firstTry = refreshedAgain;
    refreshedAgain = false;
    await refreshIfStale({ tz, now: new Date(Math.max(six.getTime(), refreshed.getTime()) + 86400_000 + 60_000) });
    check('a library refreshed before six this morning is refreshed again', refreshedAgain);
    check('  one refreshed since is left alone', refreshed.getTime() >= six.getTime() ? !firstTry : true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

section('news comes in the tier the person uses');
{
  const { pendingAnnouncement } = await import('../server/modelNews.js');
  const reader = 'u-news';
  await store.createUser({
    id: reader,
    email: 'news@example.com',
    name: 'News',
    passwordHash: await hashPassword('a-sufficiently-long-password'),
    role: 'user',
  });
  const recent = new Date(Date.now() - 2 * 86400_000).toISOString();
  await store.upsertModels([
    { ...model({ id: 'openrouter/small-lab/fresh:free', family: 'small-lab' }), releasedAt: recent },
    { ...model({ id: 'openrouter/openai/fresh-paid', family: 'openai' }), priceIn: 2, priceOut: 8, isFree: false, releasedAt: recent },
    { ...model({ id: 'openrouter/qwen/fresh-but-ending:free', family: 'qwen' }), releasedAt: recent, expiresAt: new Date(Date.now() + 86400_000).toISOString() },
  ]);
  const forFree = await pendingAnnouncement(reader, { tier: 'free' });
  check('somebody on a free model hears of a new free one, whoever made it', forFree?.id === 'openrouter/small-lab/fresh:free', forFree?.id);
  const forPaid = await pendingAnnouncement(reader, { tier: 'paid' });
  check('somebody paying hears of the paid release', forPaid?.id === 'openrouter/openai/fresh-paid', forPaid?.id);
  check('  priced as charged, with the service share on top', forPaid?.price?.in === 2.2 && forPaid?.price?.out === 8.8, JSON.stringify(forPaid?.price));
  // The ending one is newest by release in the list but is never recommended.
  check('a model already going away is never the news', forFree?.id !== 'openrouter/qwen/fresh-but-ending:free');
  // Somebody free is never shown the paid release, and the other way round.
  check('the tiers never cross', forFree && !forFree.price?.in && forPaid && !forPaid.isFree);
  check('a model somebody is on is not news to them', (await pendingAnnouncement(reader, { tier: 'free', current: 'openrouter/small-lab/fresh:free' })) === null);
}

section('every price shown carries the service share');
{
  const { withMarkup, markedPrice, PRICE_MARKUP } = await import('../server/pricing.js');
  check('ten percent by default', PRICE_MARKUP === 0.1);
  check('on input and output alike', JSON.stringify(markedPrice({ in: 1.25, out: 4.25 })) === JSON.stringify({ in: 1.375, out: 4.675 }));
  check('free stays free', withMarkup(0) === 0);
  check('unknown stays unknown', withMarkup(null) === null);
  check('no floating-point dust', withMarkup(0.045) === 0.0495, String(withMarkup(0.045)));
  const { browse } = await import('../server/models.js');
  const shown = await browse({ limit: 500 });
  const paid = shown.models.find((m) => m.id === 'openrouter/openai/fresh-paid');
  check('the picker shows the charged rate', paid?.price?.in === 2.2, JSON.stringify(paid?.price));
  check('  built-in models too', shown.builtin.every((m) => !m.price || m.price.in >= 0));
}

await store.close?.();
removeTemp(process.env.DATA_DIR);

console.log(
  failures === 0
    ? '\n\x1b[32mAll auto-pick checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
