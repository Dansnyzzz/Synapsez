/**
 * Which database driver, and moving from one database to another (2026-10-19).
 *
 * The free Neon project ran out of compute hours and the app moved to Supabase,
 * which is reached through a node-postgres pool rather than Neon's HTTP driver.
 * What this pins: the driver is chosen by host; TLS is always on and verified
 * when given the CA; a pooled transaction is all-or-nothing on one connection;
 * and `db:copy` carries every table across, JSON intact.
 *
 * There is no Supabase here — the pool is a stand-in and the databases are
 * in-process. What talking to a real pooler adds is checked live, not here.
 *
 *   node test/database.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'database-test-key';
process.env.SESSION_SECRET ||= 'database-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { isNeonUrl, poolOptions, pgDriver, openDatabase } = await import('../server/store/driver.js');

section('the driver is chosen by where the database is');
{
  check('a Neon host is Neon', isNeonUrl('postgresql://u:p@ep-cool-name-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'));
  check('a Supabase pooler is not', !isNeonUrl('postgresql://postgres.abc:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'));
  check('nor is a host that merely mentions neon', !isNeonUrl('postgresql://u:p@neon.tech.evil.example/db'));
  const neon = await openDatabase('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb', { env: {} });
  check('  Neon gets its own driver', typeof neon === 'function' && typeof neon.query === 'function');
  const pooled = await openDatabase('postgresql://postgres.abc:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', { env: {} });
  check('  anything else a pool, in the store\'s shape', typeof pooled.query === 'function' && typeof pooled.transaction === 'function');
  await pooled.end();
  const forced = await openDatabase('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb', { env: { DATABASE_DRIVER: 'pg' } });
  check('  and DATABASE_DRIVER settles it by hand', typeof forced.transaction === 'function' && typeof forced !== 'function');
  await forced.end();

  const { createPgStore } = await import('../server/store/pg.js');
  let asked = '';
  const fn = Object.assign(() => {}, { query: async (text) => ((asked = text), []) });
  createPgStore(fn).schemaStamp();
  check('the store takes a driver that is a function, as Neon\'s is', /FROM settings/.test(asked), asked);
}

section('TLS is always on, and verified when the CA is given');
{
  const url = 'postgresql://postgres.abc:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require';
  const plain = poolOptions(url, {});
  check('encrypted without the CA, but not claimed verified', plain.ssl && plain.ssl.rejectUnauthorized === false, JSON.stringify(plain.ssl));
  check('  sslmode is taken out of the string so it cannot overrule that', !/sslmode/.test(plain.connectionString), plain.connectionString);
  check('  one connection per instance, as Supabase asks of serverless', plain.max === 1);
  const pem = '-----BEGIN CERTIFICATE-----\\nMIIBfake\\n-----END CERTIFICATE-----';
  const verified = poolOptions(url, { DATABASE_CA_CERT: pem });
  check('with the CA, the server is verified', verified.ssl.rejectUnauthorized === true && verified.ssl.ca.includes('\nMIIBfake\n'), JSON.stringify(verified.ssl).slice(0, 80));
  check('a database on this machine is plain', poolOptions('postgresql://u:p@localhost:5432/db', {}).ssl === false);
  check('sslmode=disable is honoured', poolOptions('postgresql://u:p@db.example.com/db?sslmode=disable', {}).ssl === false);
}

section('a pooled query waits to be awaited, and a transaction is one connection');
{
  const log = [];
  const client = {
    async query(text, params) {
      log.push(`client:${text}${params?.length ? ` ${JSON.stringify(params)}` : ''}`);
      if (/boom/.test(text)) throw new Error('boom');
      return { rows: [{ text }] };
    },
    release() {
      log.push('release');
    },
  };
  const pool = {
    async query(text) {
      log.push(`pool:${text}`);
      return { rows: [{ ok: 1 }] };
    },
    async connect() {
      log.push('connect');
      return client;
    },
  };
  const db = pgDriver(pool);
  const a = db.query('SELECT 1');
  check('nothing runs until it is awaited', log.length === 0, log.join(' | '));
  const rows = await a;
  check('  then it runs, answering with the rows', rows[0]?.ok === 1 && log[0] === 'pool:SELECT 1', log.join(' | '));
  log.length = 0;
  await db.transaction([db.query('DELETE FROM t WHERE x = $1', [1]), db.query('INSERT INTO t VALUES ($1)', [2])]);
  check(
    'a transaction runs its queries on one connection, between BEGIN and COMMIT, and lets it go',
    log.join(' | ') === 'connect | client:BEGIN | client:DELETE FROM t WHERE x = $1 [1] | client:INSERT INTO t VALUES ($1) [2] | client:COMMIT | release',
    log.join(' | '),
  );
  log.length = 0;
  let failed = '';
  try {
    await db.transaction([db.query('INSERT 1'), db.query('boom'), db.query('INSERT 3')]);
  } catch (err) {
    failed = err.message;
  }
  check(
    'a failure rolls it all back and still lets the connection go',
    failed === 'boom' && log.join(' | ') === 'connect | client:BEGIN | client:INSERT 1 | client:boom | client:ROLLBACK | release',
    log.join(' | '),
  );
}

section('db:copy carries every table across, in an order the foreign keys allow');
{
  const { foreignKeyOrder, copyDatabase } = await import('../scripts/copy-database.js');
  const { order, cycle } = foreignKeyOrder(['messages', 'chats', 'users', 'a', 'b'], [
    { child: 'messages', parent: 'chats' },
    { child: 'chats', parent: 'users' },
    { child: 'a', parent: 'b' },
    { child: 'b', parent: 'a' },
  ]);
  check('parents before children', order.indexOf('users') < order.indexOf('chats') && order.indexOf('chats') < order.indexOf('messages'), order.join(','));
  check('  and a pair that refer to each other is named, not lost', cycle.join(',') === 'a,b' && order.includes('a'), cycle.join(','));

  const { PGlite } = await import('@electric-sql/pglite');
  const driverOf = (db) => ({ query: async (text, params = []) => (await db.query(text, params)).rows });
  const source = new PGlite();
  const target = new PGlite();
  const { createPgStore } = await import('../server/store/pg.js');
  const old = createPgStore(driverOf(source));
  await old.init();
  const user = await old.createUser({ id: 'u-copy', email: 'copy@example.com', name: 'Copy', passwordHash: 'x', role: 'user' });
  await old.createChat(user.id, { id: 'c-copy', title: 'Kept across', model: 'auto' });
  await old.appendMessage(user.id, 'c-copy', {
    id: 'm-copy',
    role: 'assistant',
    text: 'Đây là câu trả lời.',
    toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'figs/Figure_4.png' } }],
  });
  await old.createAttachment(user.id, { id: 'a-copy', name: 'Figure_4.png', mime: 'image/png', kind: 'image', bytes: 3, data: 'AAAA', origin: 'step', chatId: 'c-copy', thumb: null });

  const said = [];
  const copied = await copyDatabase(driverOf(source), driverOf(target), { say: (line) => said.push(line) });
  const moved = createPgStore(driverOf(target));
  const chat = await moved.getChat(user.id, 'c-copy');
  const messages = await moved.listMessages(user.id, 'c-copy');
  const file = await moved.getAttachment(user.id, 'a-copy');
  check('the account, its conversation and its file are all there', chat?.title === 'Kept across' && !!file && (await moved.getUserByEmail('copy@example.com'))?.id === user.id);
  check('  JSON arrives as JSON — a list of tool calls stays a list', Array.isArray(messages[0]?.toolCalls) && messages[0].toolCalls[0]?.input?.path === 'figs/Figure_4.png', JSON.stringify(messages[0]?.toolCalls));
  check('  and text in any language arrives whole', messages[0]?.text === 'Đây là câu trả lời.');
  check('it says how many rows each table took', copied.users === 1 && copied.messages === 1 && said.some((l) => /users: 1/.test(l)), JSON.stringify(copied));
  const again = await copyDatabase(driverOf(source), driverOf(target), { say: () => {} });
  const count = (await target.query('SELECT count(*)::int AS n FROM messages')).rows[0].n;
  check('running it again changes nothing — what is there is left as it is, and it says so', count === 1 && again.messages === 0, `${count} ${again.messages}`);
  await source.close();
  await target.close();
}

/**
 * Somebody signed up on the new database before the old one could be copied —
 * the same email, a new account (owner, 2026-10-20). The old account's rows go
 * to the account already there, and what was made since stays.
 */
section('db:copy merges an old account into the one with the same email');
{
  const { copyDatabase } = await import('../scripts/copy-database.js');
  const { PGlite } = await import('@electric-sql/pglite');
  const { createPgStore } = await import('../server/store/pg.js');
  const driverOf = (db) => ({ query: async (text, params = []) => (await db.query(text, params)).rows });
  const source = new PGlite();
  const target = new PGlite();
  const old = createPgStore(driverOf(source));
  const now = createPgStore(driverOf(target));
  await old.init();
  await now.init();
  await old.createUser({ id: 'u-neon', email: 'owner@example.com', name: 'Owner', passwordHash: 'x', role: 'admin' });
  await old.createChat('u-neon', { id: 'c-from-neon', title: 'Before the move', model: 'auto' });
  await old.appendMessage('u-neon', 'c-from-neon', { id: 'm-neon', role: 'user', text: 'Ghi chú cũ' });
  await old.setUserSetting('u-neon', 'prefs', { language: 'vi', defaultModel: 'old-model' });
  await old.setUserSetting('u-neon', 'memory_note', { text: 'kept from before' });
  // Credentials sealed to the old id (crypto.js v2): bound to it, they must be re-bound to the id they join.
  const { encryptSecret, decryptSecret } = await import('../server/crypto.js');
  await old.saveConnector('u-neon', 'github', encryptSecret('ghp_from_neon', ['connector', 'u-neon', 'github']), 'octo');
  await old.setUserSetting('u-neon', 'providerKeys', { openrouter: [{ cipher: encryptSecret('sk-or-v1-from-neon', ['provider-key', 'u-neon', 'openrouter']), hint: '…eon' }] });
  // And one from before 1.26.0, unbound (v1): it must arrive sealed in v2, or ENCRYPTION_REFUSE_V1 refuses it later.
  const nodeCrypto = await import('node:crypto');
  const v1Key = nodeCrypto.createHash('sha256').update(`ai-remote:keys:${process.env.ENCRYPTION_KEY}`).digest();
  const v1Iv = nodeCrypto.randomBytes(12);
  const v1C = nodeCrypto.createCipheriv('aes-256-gcm', v1Key, v1Iv);
  const v1Body = Buffer.concat([v1C.update('ntn_from_before', 'utf8'), v1C.final()]);
  await old.saveConnector('u-neon', 'notion', `v1.${v1Iv.toString('base64url')}.${v1C.getAuthTag().toString('base64url')}.${v1Body.toString('base64url')}`, 'n');
  await now.createUser({ id: 'u-supabase', email: 'owner@example.com', name: 'Owner', passwordHash: 'y', role: 'admin', username: 'owner.one' });
  await now.createChat('u-supabase', { id: 'c-since', title: 'Made since', model: 'auto' });
  await now.setUserSetting('u-supabase', 'prefs', { language: 'vi', defaultModel: 'new-model' });

  // --check first, as the owner would the morning Neon's quota resets: read both, write nothing.
  const { checkCopy, whyUnreachable } = await import('../scripts/copy-database.js');
  const looked = await checkCopy(driverOf(source), driverOf(target));
  check('--check says what the old database holds and which accounts merge', looked.accounts === 1 && looked.merging === 1 && looked.tables.chats === 1 && looked.tables.messages === 1, JSON.stringify({ ...looked, tables: undefined }));
  check('  naming each email both databases have', JSON.stringify(looked.collisions) === '["owner@example.com"]', JSON.stringify(looked.collisions));
  check('  and writes nothing', (await now.getChat('u-supabase', 'c-from-neon')) == null);
  check("  a Neon project out of compute is said as that, with what to do", /quota resets/.test(whyUnreachable(new Error('HTTP status 402: Your project has exceeded the compute time quota'))) && whyUnreachable(new Error('ECONNREFUSED')) === 'ECONNREFUSED');

  /*
   * SEC-057: sign-up does not prove an email, so whoever registered the
   * owner's address on the new database first would have received every old
   * conversation, note, key and Google grant. No account merges unless the
   * owner names it.
   */
  const refused = await copyDatabase(driverOf(source), driverOf(target), { say: () => {} }).then(() => '', (e) => e.message);
  check('an email on both sides that the owner did not name stops the copy (SEC-057)', /owner@example\.com/.test(refused) && /--merge/.test(refused), refused);
  check('  before a single row is copied', (await now.getChat('u-supabase', 'c-from-neon')) == null && (await now.getUserSetting('u-supabase', 'memory_note')) == null);
  const elsewhere = await copyDatabase(driverOf(source), driverOf(target), { say: () => {}, merge: ['someone.else@example.com'] }).then(() => '', (e) => e.message);
  check('  naming a different email does not let it through', /owner@example\.com/.test(elsewhere));

  const said = [];
  await copyDatabase(driverOf(source), driverOf(target), { say: (line) => said.push(line), merge: [' Owner@Example.com '] });
  const users = (await target.query("SELECT id, username FROM users WHERE email = 'owner@example.com'")).rows;
  check('one account, the one already there', users.length === 1 && users[0].id === 'u-supabase' && users[0].username === 'owner.one', JSON.stringify(users));
  const before = await now.getChat('u-supabase', 'c-from-neon');
  const messages = await now.listMessages('u-supabase', 'c-from-neon');
  check('  the old conversations are in it', before?.title === 'Before the move' && messages[0]?.text === 'Ghi chú cũ', JSON.stringify(before));
  check('  beside what was made since', (await now.getChat('u-supabase', 'c-since'))?.title === 'Made since');
  check('  a setting chosen since wins over the old one', (await now.getUserSetting('u-supabase', 'prefs'))?.defaultModel === 'new-model');
  check('  and one only the old account had comes across', (await now.getUserSetting('u-supabase', 'memory_note'))?.text === 'kept from before');
  check('it says which account it merged', said.some((l) => /owner@example\.com/.test(l) && /merged/i.test(l)), said.join(' | '));
  check('  and counts only what went in — the setting the target kept is not counted', said.some((l) => /user_settings: 2$/.test(l)), said.filter((l) => /user_settings/.test(l)).join(''));
  const token = (await target.query("SELECT token FROM connectors WHERE user_id = 'u-supabase' AND service = 'github'")).rows[0]?.token;
  const keys = (await now.getUserSetting('u-supabase', 'providerKeys'))?.openrouter;
  check("a merged account's stored credentials open under the account they joined", decryptSecret(token, ['connector', 'u-supabase', 'github']) === 'ghp_from_neon' && decryptSecret(keys?.[0]?.cipher, ['provider-key', 'u-supabase', 'openrouter']) === 'sk-or-v1-from-neon', JSON.stringify({ token: !!token, keys: keys?.length }));
  check('  and no longer under the old id', decryptSecret(token, ['connector', 'u-neon', 'github']) === '');
  check('  said, with nothing left that would not open', said.some((l) => /3 stored credential\(s\) sealed again as they were copied/.test(l)) && !said.some((l) => /could not be opened|copied as they were \(/.test(l)), said.filter((l) => /credential/.test(l)).join(' | '));
  const notion = (await target.query("SELECT token FROM connectors WHERE user_id = 'u-supabase' AND service = 'notion'")).rows[0]?.token;
  check('a credential from before 1.26.0 arrives sealed in v2, bound to the account it joined', String(notion).startsWith('v2.') && decryptSecret(notion, ['connector', 'u-supabase', 'notion']) === 'ntn_from_before', String(notion).slice(0, 3));

  // Security review, 2026-11-12: without the key that sealed them, a merge's credentials would
  // be carried across unopenable — and a second run skips rows already there. So it stops first.
  const source2 = new PGlite();
  const target2 = new PGlite();
  const old2 = createPgStore(driverOf(source2));
  const now2 = createPgStore(driverOf(target2));
  await old2.init();
  await now2.init();
  await old2.createUser({ id: 'u-old-2', email: 'two@example.com', name: 'Two', passwordHash: 'x', role: 'user' });
  await old2.createChat('u-old-2', { id: 'c-old-2', title: 'Kept back', model: 'auto' });
  const keyHere = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'the-deployments-own-key-not-in-this-environment';
  await old2.saveConnector('u-old-2', 'github', encryptSecret('ghp_unreachable', ['connector', 'u-old-2', 'github']), 'o');
  process.env.ENCRYPTION_KEY = keyHere;
  await now2.createUser({ id: 'u-new-2', email: 'two@example.com', name: 'Two', passwordHash: 'y', role: 'user' });
  const stopped = await copyDatabase(driverOf(source2), driverOf(target2), { say: () => {}, merge: ['two@example.com'] }).then(() => '', (e) => e.message);
  check('a merge whose credentials cannot be opened here stops before the first row, saying which key it needs', /cannot be opened here/.test(stopped) && /ENCRYPTION_KEY/.test(stopped) && /Nothing was copied/.test(stopped), stopped);
  check('  and indeed nothing was copied', (await now2.getChat('u-new-2', 'c-old-2')) == null);
  await source2.close();
  await target2.close();
  await source.close();
  await target.close();
}

console.log(failures === 0 ? '\n\x1b[32mAll database checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
