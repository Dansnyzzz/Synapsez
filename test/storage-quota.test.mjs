/**
 * Half a gigabyte of files for an account with no plan, while files live in the database
 * (owner, 2026-11-13): server/storageQuota.js, and the paths that add a file or a copy of one.
 * PGlite stands in for the database; the sizes the limit is tested at are written into the
 * `bytes` column of a row rather than made, so no half-gigabyte is ever allocated.
 *
 *   node test/storage-quota.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'storage-quota-test-encryption-key-long-enough-to-be-quiet';
process.env.SESSION_SECRET ||= 'storage-quota-test-session-secret';
for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'VERCEL', 'FREE_STORAGE_BYTES']) delete process.env[name];

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const { PGlite } = await import('@electric-sql/pglite');
const { initStore } = await import('../server/store/index.js');
const db = await PGlite.create();
const sql = { query: async (text, params = []) => (await db.query(text, params)).rows };
const store = await initStore({ driver: sql });
const quota = await import('../server/storageQuota.js');
const files = await import('../server/attachments.js');
const { forkSharedChat } = await import('../server/routes/chatShare.js');

const MB = 1_000_000;
const member = await store.createUser({ id: 'u-member', email: 'member@example.com', passwordHash: 'x', name: 'Member', role: 'user' });
const boss = await store.createUser({ id: 'u-boss', email: 'boss@example.com', passwordHash: 'x', name: 'Boss', role: 'admin' });
const other = await store.createUser({ id: 'u-other', email: 'other@example.com', passwordHash: 'x', name: 'Other', role: 'user' });

let made = 0;
/** A row that weighs `bytes` on paper: the column is what is counted, so the data stays small. */
const weigh = (userId, bytes, extra = {}) =>
  store.createAttachment(userId, { id: `w${(made += 1)}`, name: 'big.bin', mime: 'application/octet-stream', kind: 'binary', bytes, data: 'AA==', origin: 'upload', ...extra });
/** A real upload of exactly this many bytes, as the route hands one to saveUpload. */
const upload = (userId, bytes, name = 'more.bin') => files.saveUpload(userId, { name, mime: 'application/octet-stream', data: Buffer.alloc(bytes).toString('base64') });
const caught = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};
const count = async (userId) => Number((await sql.query('SELECT COUNT(*) AS n FROM attachments WHERE user_id = $1', [userId]))[0].n);

section('the limit and who it is for');
{
  check('an account with no plan keeps half a gigabyte', quota.freeStorageBytes({}) === 500_000_000);
  check('  the deployment can say otherwise', quota.freeStorageBytes({ FREE_STORAGE_BYTES: '1000' }) === 1000);
  check('  and a value that is not a number is the half gigabyte', quota.freeStorageBytes({ FREE_STORAGE_BYTES: 'lots' }) === 500_000_000);
  check('a member is limited', (await quota.storageOf(member)).limitBytes === 500_000_000);
  check('an administrator is not', (await quota.storageOf(boss)).limitBytes === null);
  check('sizes are said in decimal, so the limit reads 0.5 GB', quota.sizeText(500_000_000) === '0.5 GB' && quota.sizeText(120 * MB) === '120 MB');
}

section('adding to an account that is nearly full');
{
  await weigh(member.id, 499 * MB);
  check('what a member holds is counted', (await store.bytesOfUser(member.id)) === 499 * MB);

  const refused = await caught(upload(member.id, 2 * MB));
  check('2 MB more at 499 MB is refused', refused instanceof quota.StorageFull, String(refused?.message));
  check('  as a 422 with the code the page goes by', refused?.status === 422 && refused?.code === 'storage_full', `${refused?.status} ${refused?.code}`);
  check('  carrying both figures', refused?.usedBytes === 499 * MB && refused?.limitBytes === 500 * MB);
  check(
    '  and saying where the files are deleted',
    refused?.message === 'Your files are full: 499 MB of 0.5 GB used. Delete files you no longer need in Settings → Privacy → Your data, then try again.',
    refused?.message,
  );
  check('  nothing was stored', (await count(member.id)) === 1);

  const exact = await caught(upload(member.id, 1 * MB));
  check('1 MB more at 499 MB reaches the limit and is allowed', exact === null, String(exact?.message));
  check('  and now the account is at the limit', (await store.bytesOfUser(member.id)) === 500 * MB);
  check('  where one more byte is refused', (await caught(upload(member.id, 1))) instanceof quota.StorageFull);

  check('another account is not affected', (await caught(upload(other.id, 2 * MB))) === null);
}

section('a file the assistant writes, and a new version of one');
{
  const made1 = await caught(files.saveGenerated(member.id, { name: 'plan.md', mime: 'text/markdown', data: Buffer.from('hello').toString('base64') }));
  check('a new file the assistant writes is refused when the account is full', made1 instanceof quota.StorageFull, String(made1?.message));

  // A fresh account with a made file and room for little more.
  const writer = await store.createUser({ id: 'u-writer', email: 'writer@example.com', passwordHash: 'x', name: 'Writer', role: 'user' });
  await weigh(writer.id, 497 * MB);
  const file = await files.saveGenerated(writer.id, { name: 'draft.md', mime: 'text/markdown', data: Buffer.alloc(1 * MB, 97).toString('base64') });
  check('a file that fits is written', !!file?.id);
  // 498 MB held. A rewrite files the old copy as a version and keeps the new one, so what it adds is the new size.
  const row = await store.getAttachment(writer.id, file.id);
  const grown = await caught(files.saveChangedFile(writer.id, row, Buffer.alloc(5 * MB, 98)));
  check('a new version that would pass the limit is refused', grown instanceof quota.StorageFull, String(grown?.message));
  check('  and the file is as it was', Number((await store.getAttachment(writer.id, file.id)).bytes) === 1 * MB);

  const small = await caught(files.saveChangedFile(writer.id, row, Buffer.alloc(1 * MB, 99)));
  check('a new version that fits is kept', small === null, String(small?.message));
  check('  and the earlier copy is counted', (await store.bytesOfUser(writer.id)) === 497 * MB + 1 * MB + 1 * MB);
  check('  so a second change that no longer fits is refused', (await caught(files.saveChangedFile(writer.id, row, Buffer.alloc(3 * MB, 100)))) instanceof quota.StorageFull);
}

section('a picture of something already kept');
{
  const over = await store.createUser({ id: 'u-over', email: 'over@example.com', passwordHash: 'x', name: 'Over', role: 'user' });
  await weigh(over.id, 600 * MB);
  check('an account already over is counted as it is', (await quota.storageOf(over)).usedBytes === 600 * MB);

  const rendered = await weigh(over.id, 3 * MB, { origin: 'rendered' });
  check('a render of a kept file is stored even then', !!rendered?.id);
  check('  and counted', (await store.bytesOfUser(over.id)) === 603 * MB);

  const shot = await files.keepStepShot(over.id, { data: Buffer.from('jpeg').toString('base64'), mime: 'image/jpeg' });
  check('a step\'s thumbnail is kept even then', !!shot?.id);
  check('  and counted', (await store.bytesOfUser(over.id)) > 603 * MB);

  check('but a new upload is refused', (await caught(upload(over.id, 1))) instanceof quota.StorageFull);
  check('nothing it held was deleted', (await count(over.id)) === 3);
}

section('what is not on this disk is not counted');
{
  const far = await store.createUser({ id: 'u-far', email: 'far@example.com', passwordHash: 'x', name: 'Far', role: 'user' });
  await files.saveMachineFile(far.id, { name: 'film.mp4', mime: 'video/mp4', bytes: 900 * MB, path: '/home/user/film.mp4' });
  check('a file that stays on the cloud computer weighs nothing here', (await store.bytesOfUser(far.id)) === 0);
  check('  and does not stop a new upload', (await caught(upload(far.id, 1 * MB))) === null);
}

section('an administrator');
{
  await weigh(boss.id, 900 * MB);
  check('is never refused', (await caught(upload(boss.id, 4 * MB))) === null);
  check('  and is still counted', (await store.bytesOfUser(boss.id)) === 904 * MB);
}

section('carrying on a shared conversation copies its files');
{
  const owner = await store.createUser({ id: 'u-sharer', email: 'sharer@example.com', passwordHash: 'x', name: 'Sharer', role: 'user' });
  const reader = await store.createUser({ id: 'u-reader', email: 'reader@example.com', passwordHash: 'x', name: 'Reader', role: 'user' });
  await store.createChat(owner.id, { id: 'c-share', title: 'Plan', model: 'm' });
  await store.createAttachment(owner.id, { id: 'att-share', name: 'photo.png', mime: 'image/png', kind: 'image', bytes: 3 * MB, data: 'AA==', chatId: 'c-share' });
  await store.appendMessage(owner.id, 'c-share', { id: 'sh-1', role: 'user', text: 'hello', attachments: [{ id: 'att-share', name: 'photo.png', kind: 'image' }] });
  const token = 'tokStorageQuota00000000000000000000000000_0';
  await store.setChatShare(owner.id, 'c-share', token);

  await weigh(reader.id, 498 * MB);
  const chatsBefore = (await store.listChats(reader.id)).length;
  const refused = await forkSharedChat(reader.id, token);
  check('is refused when the copies would pass the limit', refused.status === 422 && refused.code === 'storage_full', JSON.stringify(refused).slice(0, 120));
  check('  with the sentence a person reads', /^Your files are full: 498 MB of 0\.5 GB used\./.test(refused.error || ''), refused.error);
  check('  leaving no half-made conversation or file behind', (await store.listChats(reader.id)).length === chatsBefore && (await count(reader.id)) === 1);

  const roomy = await store.createUser({ id: 'u-roomy', email: 'roomy@example.com', passwordHash: 'x', name: 'Roomy', role: 'user' });
  await weigh(roomy.id, 496 * MB);
  const taken = await forkSharedChat(roomy.id, token);
  check('goes ahead when they fit', !!taken.chatId && taken.files === 1, JSON.stringify(taken).slice(0, 120));
}

section('a text source for a project, which keeps its original');
{
  const { addSource } = await import('../server/projects.js');
  const tight = await store.createUser({ id: 'u-tight', email: 'tight@example.com', passwordHash: 'x', name: 'Tight', role: 'user' });
  await store.createProject(tight.id, { id: 'p-tight', name: 'Shelf' });
  await weigh(tight.id, 499 * MB);
  const words = Buffer.from('a few plain words for the shelf '.repeat(40)).toString('base64');
  const full = await caught(addSource(tight.id, 'p-tight', { name: 'notes.txt', mime: 'text/plain', data: Buffer.alloc(2 * MB, 97).toString('base64') }));
  check('is refused as a whole when the account is full', full instanceof quota.StorageFull && full.status === 422 && full.code === 'storage_full', String(full?.message));
  check('  with no source row and no original left behind', (await store.listProjectFiles(tight.id, 'p-tight')).length === 0 && (await count(tight.id)) === 1);
  const fits = await caught(addSource(tight.id, 'p-tight', { name: 'notes.txt', mime: 'text/plain', data: words }));
  check('  while one that fits is added with its original', fits === null && (await store.listProjectFiles(tight.id, 'p-tight')).length === 1 && (await count(tight.id)) === 2);
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
process.exit(0);
